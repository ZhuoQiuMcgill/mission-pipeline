// The file-tool executor that runs INSIDE a seat's tool sandbox (design 7.1: "所有文件工具与
// '运行命令'都在这个沙箱里执行"). sandbox.ts starts one per call with bubblewrap; the sandbox
// holds only the read-only snapshot, the writable areas and this program's runtime, so a
// path that resolves outside the snapshot cannot reach the host's files: they do not exist
// here. The checks below are a second layer on top of that.
//
// Self-contained on purpose: only this file is mounted into the sandbox, so it imports node
// built-ins and nothing else. Protocol: one JSON envelope on stdin; one JSON reply on stdout,
// except "export", which streams frames (a JSON header line, then the file's raw bytes).

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { posix } from 'node:path';

interface WritableRoot {
  readonly path: string;
  readonly kind: 'dir' | 'file';
}

interface Envelope {
  readonly root: string;
  readonly writable: readonly WritableRoot[];
  readonly req: Request;
}

type Request =
  | { readonly op: 'read'; readonly path: string; readonly offset: number; readonly maxBytes: number }
  | { readonly op: 'list'; readonly path: string; readonly maxEntries: number }
  | {
      readonly op: 'search';
      readonly path: string;
      readonly pattern: string;
      readonly regex: boolean;
      readonly ignoreCase: boolean;
      readonly maxMatches: number;
      readonly maxLineBytes: number;
      readonly maxFileBytes: number;
      readonly maxFiles: number;
    }
  | { readonly op: 'write'; readonly path: string; readonly content: string; readonly createParents: boolean }
  | {
      readonly op: 'edit';
      readonly path: string;
      readonly oldString: string;
      readonly newString: string;
      readonly replaceAll: boolean;
      readonly maxBytes: number;
    }
  | { readonly op: 'meter'; readonly exclude: readonly string[]; readonly flag?: readonly string[] }
  | {
      readonly op: 'export';
      readonly maxBytes: number;
      readonly maxEntries: number;
      readonly exclude: readonly string[];
      readonly flag?: readonly string[];
    };

class AgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const ERRNO_CODES: Readonly<Record<string, string>> = {
  ENOENT: 'not-found',
  ENOTDIR: 'not-a-directory',
  EISDIR: 'not-a-file',
  ENOSPC: 'no-space',
  EDQUOT: 'no-space',
  EROFS: 'read-only',
  EACCES: 'permission-denied',
  EPERM: 'permission-denied',
  ELOOP: 'symlink',
  EFBIG: 'too-large',
  ENAMETOOLONG: 'invalid-argument',
};

function codeOf(e: unknown): string {
  if (e instanceof AgentError) return e.code;
  const errno = (e as NodeJS.ErrnoException | null)?.code;
  return (errno !== undefined ? ERRNO_CODES[errno] : undefined) ?? 'internal';
}

// ---------------------------------------------------------------- output

function writeAll(fd: number, data: Uint8Array): void {
  let off = 0;
  while (off < data.length) {
    try {
      off += writeSync(fd, data, off, data.length - off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
}

function reply(x: unknown): void {
  writeAll(1, Buffer.from(JSON.stringify(x), 'utf8'));
}

// ---------------------------------------------------------------- paths

let ROOT = '/';
let WRITABLE: readonly WritableRoot[] = [];

function inside(p: string, base: string): boolean {
  return base === '/' ? p.startsWith('/') : p === base || p.startsWith(`${base}/`);
}

function checkPath(p: unknown): string {
  if (typeof p !== 'string' || p.includes('\0') || !posix.isAbsolute(p) || posix.normalize(p) !== p) {
    throw new AgentError('invalid-argument', `not a normalized absolute path: ${JSON.stringify(p)}`);
  }
  if (!inside(p, ROOT)) throw new AgentError('outside-snapshot', `${p} is outside ${ROOT}`);
  return p;
}

/** Real path of an existing entry; it must stay inside the snapshot root. */
function realInside(p: string): string {
  const r = realpathSync(p);
  if (!inside(r, ROOT)) throw new AgentError('outside-snapshot', `${p} resolves to ${r}, outside ${ROOT}`);
  return r;
}

function writableDirFor(real: string): WritableRoot | undefined {
  return WRITABLE.find((w) => w.kind === 'dir' && inside(real, w.path));
}

function rel(abs: string): string {
  return abs === ROOT ? '.' : posix.relative(ROOT, abs);
}

function kindOf(s: Stats): 'file' | 'dir' | 'symlink' | 'other' {
  if (s.isSymbolicLink()) return 'symlink';
  if (s.isFile()) return 'file';
  if (s.isDirectory()) return 'dir';
  return 'other';
}

// ---------------------------------------------------------------- utf-8

const strict = new TextDecoder('utf-8', { fatal: true });

function utf8PrefixLen(buf: Uint8Array): number {
  // drop an incomplete sequence at the end (at most 3 bytes)
  let i = buf.length;
  let back = 0;
  while (i > 0 && back < 4 && ((buf[i - 1] ?? 0) & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i === 0) return buf.length;
  const lead = buf[i - 1] ?? 0;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return need > back + 1 ? i - 1 : buf.length;
}

function decodeStrict(buf: Uint8Array): string | null {
  try {
    return strict.decode(buf);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- operations

function opRead(req: Extract<Request, { op: 'read' }>): unknown {
  const real = realInside(checkPath(req.path));
  const st = statSync(real);
  if (!st.isFile()) throw new AgentError('not-a-file', `${req.path} is not a regular file`);
  const offset = Math.max(0, Math.min(req.offset, st.size));
  const want = Math.max(0, Math.min(req.maxBytes, st.size - offset));
  const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buf = Buffer.alloc(want);
  let got = 0;
  try {
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, offset + got);
      if (n === 0) break;
      got += n;
    }
  } finally {
    closeSync(fd);
  }
  let data = buf.subarray(0, got);
  const truncated = offset + got < st.size;
  if (truncated) data = data.subarray(0, utf8PrefixLen(data));
  const text = decodeStrict(data);
  return {
    path: req.path,
    size: st.size,
    offset,
    bytes: data.length,
    truncated: offset + data.length < st.size,
    encoding: text === null ? 'base64' : 'utf8',
    content: text ?? data.toString('base64'),
  };
}

function opList(req: Extract<Request, { op: 'list' }>): unknown {
  const real = realInside(checkPath(req.path));
  if (!statSync(real).isDirectory()) throw new AgentError('not-a-directory', `${req.path} is not a directory`);
  const names = readdirSync(real).sort();
  const entries = names.slice(0, req.maxEntries).map((name) => {
    const s = lstatSync(posix.join(real, name));
    const kind = kindOf(s);
    return {
      name,
      kind,
      size: kind === 'file' ? s.size : 0,
      ...(kind === 'symlink' ? { target: readlinkSync(posix.join(real, name)) } : {}),
    };
  });
  return { path: req.path, total: names.length, truncated: names.length > entries.length, entries };
}

function walk(dirReal: string, dirAbs: string, visit: (abs: string, real: string, st: Stats) => boolean | void): boolean {
  for (const name of readdirSync(dirReal).sort()) {
    const real = posix.join(dirReal, name);
    const abs = posix.join(dirAbs, name);
    const st = lstatSync(real);
    if (visit(abs, real, st) === false) return false;
    if (st.isDirectory() && !walk(real, abs, visit)) return false;
  }
  return true;
}

function opSearch(req: Extract<Request, { op: 'search' }>): unknown {
  const start = checkPath(req.path);
  const real = realInside(start);
  let re: RegExp | null = null;
  if (req.regex) {
    try {
      re = new RegExp(req.pattern, req.ignoreCase ? 'i' : '');
    } catch (e) {
      throw new AgentError('invalid-argument', `bad regular expression: ${(e as Error).message}`);
    }
  }
  const needle = req.ignoreCase ? req.pattern.toLowerCase() : req.pattern;
  const test = (line: string): boolean =>
    re !== null ? re.test(line) : (req.ignoreCase ? line.toLowerCase() : line).includes(needle);
  const matches: { path: string; line: number; text: string }[] = [];
  let filesScanned = 0;
  let skippedLarge = 0;
  let skippedBinary = 0;
  let truncated = false;
  const scan = (abs: string, file: string, size: number): boolean => {
    if (filesScanned >= req.maxFiles) {
      truncated = true;
      return false;
    }
    filesScanned++;
    if (size > req.maxFileBytes) {
      skippedLarge++;
      return true;
    }
    const data = readFileSync(file);
    if (data.subarray(0, 8000).includes(0)) {
      skippedBinary++;
      return true;
    }
    const lines = data.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!test(line)) continue;
      if (matches.length >= req.maxMatches) {
        truncated = true;
        return false;
      }
      const lb = Buffer.from(line, 'utf8');
      const text =
        lb.length <= req.maxLineBytes
          ? line
          : `${lb.subarray(0, utf8PrefixLen(lb.subarray(0, req.maxLineBytes))).toString('utf8')} [line truncated, original length ${lb.length} bytes]`;
      matches.push({ path: rel(abs), line: i + 1, text });
    }
    return true;
  };
  const st = statSync(real);
  if (st.isFile()) scan(start, real, st.size);
  else if (st.isDirectory()) {
    walk(real, start, (abs, r, s) => (s.isFile() ? scan(abs, r, s.size) : true));
  } else throw new AgentError('not-a-file', `${req.path} is neither a file nor a directory`);
  return { matches, truncated, filesScanned, skippedLarge, skippedBinary };
}

/** Real path of the directory that will hold `target`, creating missing parents inside a writable area. */
function parentForWrite(target: string, createParents: boolean): string {
  const parent = posix.dirname(target);
  let existing = parent;
  const missing: string[] = [];
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      missing.unshift(posix.basename(existing));
      existing = posix.dirname(existing);
    }
  }
  const real = realInside(existing);
  if (writableDirFor(real) === undefined) throw new AgentError('not-writable', `${parent} is not inside a writable path`);
  if (!statSync(real).isDirectory()) throw new AgentError('not-a-directory', `${existing} is not a directory`);
  if (missing.length > 0 && !createParents) throw new AgentError('not-found', `directory ${parent} does not exist`);
  let cur = real;
  for (const m of missing) {
    cur = posix.join(cur, m);
    mkdirSync(cur);
  }
  return cur;
}

/** The real path a write or edit may change: a regular file (or a new name) inside a writable area. */
function writeTarget(path: string, mustExist: boolean, createParents: boolean): { real: string; existing: Stats | null } {
  checkPath(path);
  const fileRoot = WRITABLE.find((w) => w.kind === 'file' && w.path === path);
  const real = fileRoot !== undefined ? path : posix.join(parentForWrite(path, createParents), posix.basename(path));
  let st: Stats | null = null;
  try {
    st = lstatSync(real);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (st === null && mustExist) throw new AgentError('not-found', `${path} does not exist`);
  if (st !== null && st.isSymbolicLink()) throw new AgentError('symlink', `${path} is a symbolic link`);
  if (st !== null && !st.isFile()) throw new AgentError('not-a-file', `${path} is not a regular file`);
  return { real, existing: st };
}

function writeInPlace(real: string, data: Uint8Array, mode: number): void {
  const fd = openSync(real, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
  try {
    if (!fstatSync(fd).isFile()) throw new AgentError('not-a-file', `${real} is not a regular file`);
    writeAll(fd, data);
  } finally {
    closeSync(fd);
  }
}

function opWrite(req: Extract<Request, { op: 'write' }>): unknown {
  const { real, existing } = writeTarget(req.path, false, req.createParents);
  const data = Buffer.from(req.content, 'utf8');
  writeInPlace(real, data, 0o644);
  return { path: req.path, bytes: data.length, created: existing === null };
}

function opEdit(req: Extract<Request, { op: 'edit' }>): unknown {
  if (req.oldString === '') throw new AgentError('invalid-argument', 'oldString is empty');
  if (req.oldString === req.newString) throw new AgentError('invalid-argument', 'oldString and newString are identical');
  const { real, existing } = writeTarget(req.path, true, false);
  if (existing !== null && existing.size > req.maxBytes) {
    throw new AgentError('too-large', `${req.path} is ${existing.size} bytes, over the edit limit ${req.maxBytes}`);
  }
  const text = decodeStrict(readFileSync(real));
  if (text === null) throw new AgentError('binary', `${req.path} is not valid UTF-8 text`);
  let count = 0;
  for (let i = text.indexOf(req.oldString); i !== -1; i = text.indexOf(req.oldString, i + req.oldString.length)) count++;
  if (count === 0) throw new AgentError('no-match', `oldString does not occur in ${req.path}`);
  if (count > 1 && !req.replaceAll) {
    throw new AgentError('not-unique', `oldString occurs ${count} times in ${req.path}; make it unique or set replaceAll`);
  }
  const next = req.replaceAll ? text.split(req.oldString).join(req.newString) : text.replace(req.oldString, () => req.newString);
  writeInPlace(real, Buffer.from(next, 'utf8'), 0o644);
  return { path: req.path, replacements: req.replaceAll ? count : 1 };
}

// ---------------------------------------------------------------- export (7.1 导出规则)

interface Tally {
  logicalBytes: number;
  entries: number;
  files: number;
  dirs: number;
  symlinks: number;
  excluded: number;
  /** Bytes of the tree entries (export.ts treeEntryIndexBytes: the same JSON, the same key order). */
  indexBytes: number;
  skipped: { path: string; type: string }[];
  /** Entries whose name is in the request's `flag` list (e.g. ".git", v34 7.1), first 100. */
  flagged: string[];
}

/** Like walk, but entries whose name is excluded are neither visited nor descended into. */
function walkExcluding(dirReal: string, dirAbs: string, exclude: ReadonlySet<string>, onExcluded: () => void, visit: (abs: string, real: string, st: Stats) => boolean): boolean {
  for (const name of readdirSync(dirReal).sort()) {
    if (exclude.has(name)) {
      onExcluded();
      continue;
    }
    const real = posix.join(dirReal, name);
    const abs = posix.join(dirAbs, name);
    const st = lstatSync(real);
    if (!visit(abs, real, st)) return false;
    if (st.isDirectory() && !walkExcluding(real, abs, exclude, onExcluded, visit)) return false;
  }
  return true;
}

/** Every exported entry under the writable areas, in a stable order, without following symlinks. */
function forEachExported(exclude: readonly string[], onExcluded: () => void, visit: (abs: string, real: string, st: Stats) => boolean): void {
  const ex = new Set(exclude);
  for (const w of WRITABLE) {
    if (ex.has(posix.basename(w.path))) {
      onExcluded();
      continue;
    }
    const st = lstatSync(w.path);
    if (w.kind === 'file') {
      if (!visit(w.path, w.path, st)) return;
      continue;
    }
    if (!walkExcluding(w.path, w.path, ex, onExcluded, visit)) return;
  }
}

/** The serialized size of the tree entry an exported entry becomes (export.ts TreeEntry, same key order). */
function entryIndexBytes(path: string, kind: 'file' | 'dir' | 'symlink', mode: number, size: number, target: string | null): number {
  return Buffer.byteLength(JSON.stringify({ path, kind, mode, size, hash: kind === 'file' ? '0'.repeat(64) : null, target }), 'utf8') + 1;
}

/** Logical length (st_size, so a sparse file counts in full), entry counts and tree-entry bytes. */
function opMeter(req: Extract<Request, { op: 'meter' }>): unknown {
  const t: Tally = { logicalBytes: 0, entries: 0, files: 0, dirs: 0, symlinks: 0, excluded: 0, indexBytes: 0, skipped: [], flagged: [] };
  const flag = new Set(req.flag ?? []);
  forEachExported(req.exclude ?? [], () => t.excluded++, (abs, real, st) => {
    const p = rel(abs);
    if (flag.has(posix.basename(abs)) && t.flagged.length < 100) t.flagged.push(p);
    if (st.isFile()) {
      t.files++;
      t.entries++;
      t.logicalBytes += st.size;
      t.indexBytes += entryIndexBytes(p, 'file', st.mode & 0o7777, st.size, null);
    } else if (st.isDirectory()) {
      t.dirs++;
      t.entries++;
      t.indexBytes += entryIndexBytes(p, 'dir', st.mode & 0o7777, 0, null);
    } else if (st.isSymbolicLink()) {
      const target = readlinkSync(real);
      t.symlinks++;
      t.entries++;
      t.logicalBytes += Buffer.byteLength(target);
      t.indexBytes += entryIndexBytes(p, 'symlink', 0o777, Buffer.byteLength(target), target);
    } else if (t.skipped.length < 100) t.skipped.push({ path: p, type: kindOf(st) });
    return true;
  });
  return t;
}

function frame(header: Record<string, unknown>): void {
  writeAll(1, Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'));
}

function opExport(req: Extract<Request, { op: 'export' }>): void {
  let bytes = 0;
  let entries = 0;
  let aborted = false;
  const over = (): boolean => bytes > req.maxBytes || entries > req.maxEntries;
  const flag = new Set(req.flag ?? []);
  let flagged: string | null = null;
  forEachExported(req.exclude ?? [], () => undefined, (abs, real, st) => {
    const p = rel(abs);
    if (flag.has(posix.basename(abs))) {
      flagged = p;
      return !(aborted = true);
    }
    if (st.isDirectory()) {
      entries++;
      if (over()) return !(aborted = true);
      frame({ k: 'dir', p, mode: st.mode & 0o7777 });
    } else if (st.isSymbolicLink()) {
      const target = readlinkSync(real);
      entries++;
      bytes += Buffer.byteLength(target);
      if (over()) return !(aborted = true);
      frame({ k: 'symlink', p, target });
    } else if (st.isFile()) {
      entries++;
      bytes += st.size;
      if (over()) return !(aborted = true);
      const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const size = fstatSync(fd).size;
        if (size !== st.size) throw new AgentError('internal', `${p} changed during export`);
        frame({ k: 'file', p, mode: st.mode & 0o7777, size });
        const buf = Buffer.alloc(Math.min(size, 1 << 20));
        let done = 0;
        while (done < size) {
          const n = readSync(fd, buf, 0, Math.min(buf.length, size - done), done);
          if (n === 0) throw new AgentError('internal', `${p} shrank during export`);
          writeAll(1, buf.subarray(0, n));
          done += n;
        }
      } finally {
        closeSync(fd);
      }
    } else {
      frame({ k: 'skip', p, type: kindOf(st) });
    }
    return true;
  });
  frame(aborted ? { k: 'abort', reason: flagged !== null ? `flagged ${flagged}` : 'over-cap', bytes, entries } : { k: 'end', bytes, entries });
}

// ---------------------------------------------------------------- main

function main(): void {
  let env: Envelope;
  try {
    env = JSON.parse(readFileSync(0, 'utf8')) as Envelope;
    if (typeof env.root !== 'string' || !Array.isArray(env.writable) || typeof env.req !== 'object' || env.req === null) {
      throw new Error('bad envelope');
    }
  } catch (e) {
    reply({ ok: false, error: { code: 'invalid-argument', message: `bad request: ${(e as Error).message}` } });
    return;
  }
  ROOT = env.root;
  WRITABLE = env.writable;
  try {
    const req = env.req;
    switch (req.op) {
      case 'read':
        reply({ ok: true, result: opRead(req) });
        return;
      case 'list':
        reply({ ok: true, result: opList(req) });
        return;
      case 'search':
        reply({ ok: true, result: opSearch(req) });
        return;
      case 'write':
        reply({ ok: true, result: opWrite(req) });
        return;
      case 'edit':
        reply({ ok: true, result: opEdit(req) });
        return;
      case 'meter':
        reply({ ok: true, result: opMeter(req) });
        return;
      case 'export':
        opExport(req);
        return;
      default:
        throw new AgentError('invalid-argument', `unknown op ${JSON.stringify((req as { op?: unknown }).op)}`);
    }
  } catch (e) {
    if (env.req.op === 'export') {
      frame({ k: 'error', code: codeOf(e), message: (e as Error).message });
      return;
    }
    reply({ ok: false, error: { code: codeOf(e), message: (e as Error).message } });
  }
}

main();
