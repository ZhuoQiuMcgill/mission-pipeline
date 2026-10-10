// Object-level plumbing shared by representation, refs and landing (7.1, 6.6).
// Everything here reads or writes raw objects: no command used here applies a
// content filter or an end-of-line conversion.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { GitOid } from '../common/ids.ts';
import type { GitSandbox, SafeGit } from './safeGit.ts';

export type ObjectFormat = 'sha1' | 'sha256';

/**
 * Builds a GitOid (ids.ts) from a field git's own output defines as an object id,
 * or from an id computed here; never from guessing at a string's shape (DIVRA D2
 * read a path as a blob id).
 */
export function gitOid(s: string): GitOid {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s)) throw new TypeError(`not a git object id: ${JSON.stringify(s)}`);
  return s as GitOid;
}

export interface RepoLayout {
  /** Top level of the worktree `discoverRepo` was pointed at; null in a bare repository or inside the git dir. */
  readonly worktree: string | null;
  /** This worktree's private git dir (equals commonDir for the main worktree). */
  readonly gitDir: string;
  /** The shared git dir: objects, refs, config, hooks, info. */
  readonly commonDir: string;
  readonly bare: boolean;
  readonly objectFormat: ObjectFormat;
}

export const UTF8 = new TextDecoder('utf-8', { fatal: true });

export class NonUtf8PathError extends Error {
  readonly raw: Buffer;
  constructor(raw: Buffer) {
    super(`path is not valid UTF-8: ${raw.toString('hex')}`);
    this.name = 'NonUtf8PathError';
    this.raw = raw;
  }
}

/** Git paths are bytes; the engine only handles paths that are valid UTF-8 (documented limitation). */
export function decodePath(raw: Buffer): string {
  try {
    return UTF8.decode(raw);
  } catch {
    throw new NonUtf8PathError(raw);
  }
}

export async function discoverRepo(git: SafeGit, path: string): Promise<RepoLayout> {
  const out = await git.text(
    ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--is-bare-repository', '--show-object-format'],
    { cwd: path },
  );
  const [gitDir, commonDir, bare, fmt] = out.split('\n');
  if (gitDir === undefined || commonDir === undefined || bare === undefined || fmt === undefined) {
    throw new Error(`unexpected rev-parse output: ${JSON.stringify(out)}`);
  }
  if (fmt !== 'sha1' && fmt !== 'sha256') throw new Error(`unsupported object format ${fmt}`);
  let worktree: string | null = null;
  if (bare !== 'true') {
    const r = await git.run(['rev-parse', '--path-format=absolute', '--show-toplevel'], { cwd: path });
    if (r.code === 0) worktree = realpathSync(r.stdout.toString('utf8').trim());
  }
  return {
    worktree,
    gitDir: realpathSync(gitDir),
    commonDir: realpathSync(commonDir),
    bare: bare === 'true',
    objectFormat: fmt,
  };
}

/** Arguments that point git at the repository regardless of the current directory. */
export function repoArgs(repo: RepoLayout): string[] {
  return ['--git-dir', repo.gitDir];
}

// ---------------------------------------------------------------- object ids computed here

export function gitObjectId(format: ObjectFormat, type: 'blob' | 'tree' | 'commit', content: Uint8Array): GitOid {
  const h = createHash(format);
  h.update(`${type} ${content.length}\0`);
  h.update(content);
  return h.digest('hex') as GitOid;
}

export function emptyTreeOid(format: ObjectFormat): GitOid {
  return gitObjectId(format, 'tree', new Uint8Array(0));
}

// ---------------------------------------------------------------- trees

export type FileMode = '100644' | '100755' | '120000' | '160000';
export type EntryMode = FileMode | '040000';

export interface TreeEntry {
  readonly mode: EntryMode;
  readonly type: 'blob' | 'tree' | 'commit';
  readonly oid: GitOid;
  readonly path: string;
}

function normalizeMode(m: string): EntryMode {
  switch (m) {
    case '100644':
    case '100755':
    case '120000':
    case '160000':
    case '040000':
      return m;
    case '40000':
      return '040000';
    case '100664': // old git wrote group-writable blobs; git treats them as 100644
      return '100644';
    default:
      throw new Error(`unsupported tree entry mode ${m}`);
  }
}

/** `ls-tree -z --full-tree` of a tree-ish. `recursive` lists every file; `withTrees` also lists the subtrees. */
export async function lsTree(
  git: SafeGit,
  repo: RepoLayout,
  treeish: string,
  opts: { readonly recursive: boolean; readonly withTrees?: boolean },
): Promise<TreeEntry[]> {
  const args = [...repoArgs(repo), 'ls-tree', '-z', '--full-tree'];
  if (opts.recursive) args.push('-r');
  if (opts.withTrees) args.push('-t');
  args.push(treeish);
  const r = await git.ok(args, { cwd: repo.commonDir, maxOutputBytes: 1024 * 1024 * 1024 });
  const entries: TreeEntry[] = [];
  let start = 0;
  const buf = r.stdout;
  while (start < buf.length) {
    const end = buf.indexOf(0, start);
    if (end < 0) break;
    const rec = buf.subarray(start, end);
    start = end + 1;
    const tab = rec.indexOf(9);
    const meta = rec.subarray(0, tab).toString('latin1').split(' ');
    const [mode, type, oid] = meta;
    if (mode === undefined || type === undefined || oid === undefined) throw new Error('bad ls-tree record');
    if (type !== 'blob' && type !== 'tree' && type !== 'commit') throw new Error(`bad object type ${type}`);
    entries.push({ mode: normalizeMode(mode), type, oid: gitOid(oid), path: decodePath(rec.subarray(tab + 1)) });
  }
  return entries;
}

export async function resolveCommit(git: SafeGit, repo: RepoLayout, rev: string, sandbox?: GitSandbox): Promise<GitOid | null> {
  const r = await git.run([...repoArgs(repo), 'rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], {
    cwd: repo.commonDir,
    ...(sandbox ? { sandbox } : {}),
  });
  if (r.code !== 0) return null;
  return gitOid(r.stdout.toString('utf8').trim());
}

export async function treeOfCommit(git: SafeGit, repo: RepoLayout, commit: GitOid): Promise<GitOid> {
  return gitOid(await git.text([...repoArgs(repo), 'rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`], { cwd: repo.commonDir }));
}

export type Ancestry = 'yes' | 'no' | 'unknown';

/**
 * 6.6 v49: is `ancestor` contained in `descendant`, judged on the commit objects'
 * own parent edges: no grafts (GIT_GRAFT_FILE=/dev/null, SafeGit's environment),
 * no replace objects (forced), no commit-graph cache. 'unknown' when it cannot be
 * confirmed: a shallow repository (the walk may stop at its boundary and answer
 * "no") or a missing commit (never fetched: GIT_NO_LAZY_FETCH).
 */
export async function ancestry(git: SafeGit, repo: RepoLayout, ancestor: GitOid, descendant: GitOid, sandbox?: GitSandbox): Promise<Ancestry> {
  const opts = { cwd: repo.commonDir, config: [['core.commitGraph', 'false']] as const, ...(sandbox ? { sandbox } : {}) };
  const shallow = await git.run([...repoArgs(repo), 'rev-parse', '--is-shallow-repository'], opts);
  if (shallow.code !== 0 || shallow.stdout.toString('utf8').trim() !== 'false') return 'unknown';
  const r = await git.run([...repoArgs(repo), 'merge-base', '--is-ancestor', ancestor, descendant], opts);
  return r.code === 0 ? 'yes' : r.code === 1 ? 'no' : 'unknown';
}

/** `ancestry`, for callers that cannot act on "unknown": it throws then. */
export async function isAncestor(git: SafeGit, repo: RepoLayout, ancestor: GitOid, descendant: GitOid, sandbox?: GitSandbox): Promise<boolean> {
  const a = await ancestry(git, repo, ancestor, descendant, sandbox);
  if (a === 'unknown') throw new Error(`whether ${ancestor} is an ancestor of ${descendant} cannot be confirmed (a shallow repository or a missing commit)`);
  return a === 'yes';
}

// ---------------------------------------------------------------- raw object reads

export interface ObjectInfo {
  readonly type: string;
  readonly size: number;
}

/** `cat-file --batch-check`: type and size of each object, null when missing. */
export async function batchCheck(git: SafeGit, repo: RepoLayout, oids: readonly GitOid[]): Promise<Map<GitOid, ObjectInfo | null>> {
  const result = new Map<GitOid, ObjectInfo | null>();
  const unique = [...new Set(oids)];
  if (unique.length === 0) return result;
  const r = await git.ok([...repoArgs(repo), 'cat-file', '--batch-check'], {
    cwd: repo.commonDir,
    input: unique.join('\n') + '\n',
    maxOutputBytes: unique.length * 100 + 4096,
  });
  const lines = r.stdout.toString('utf8').split('\n');
  for (let i = 0; i < unique.length; i++) {
    const oid = unique[i] as GitOid;
    const parts = (lines[i] ?? '').split(' ');
    if (parts[1] === 'missing' || parts.length < 3) result.set(oid, null);
    else result.set(oid, { type: parts[1] as string, size: Number(parts[2]) });
  }
  return result;
}

export const DEFAULT_BATCH_BYTES = 32 * 1024 * 1024;

/**
 * Reads raw object contents (`cat-file --batch`, which never applies filters or
 * conversions) in batches bounded by `maxBatchBytes`, calling `visit` once per
 * requested object id (duplicates are read once).
 */
export async function readObjects(
  git: SafeGit,
  repo: RepoLayout,
  oids: readonly GitOid[],
  visit: (oid: GitOid, type: string, content: Buffer) => void | Promise<void>,
  maxBatchBytes: number = DEFAULT_BATCH_BYTES,
): Promise<void> {
  const unique = [...new Set(oids)];
  if (unique.length === 0) return;
  const info = await batchCheck(git, repo, unique);
  const batches: GitOid[][] = [];
  let cur: GitOid[] = [];
  let curBytes = 0;
  for (const oid of unique) {
    const i = info.get(oid);
    if (i === null || i === undefined) throw new Error(`object ${oid} is missing`);
    if (cur.length > 0 && curBytes + i.size > maxBatchBytes) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(oid);
    curBytes += i.size;
  }
  if (cur.length > 0) batches.push(cur);
  for (const batch of batches) {
    let expected = 0;
    for (const oid of batch) expected += (info.get(oid) as ObjectInfo).size + 100;
    const r = await git.ok([...repoArgs(repo), 'cat-file', '--batch'], {
      cwd: repo.commonDir,
      input: batch.join('\n') + '\n',
      maxOutputBytes: expected + 4096,
    });
    const buf = r.stdout;
    let pos = 0;
    for (const oid of batch) {
      const nl = buf.indexOf(10, pos);
      if (nl < 0) throw new Error('truncated cat-file output');
      const header = buf.subarray(pos, nl).toString('latin1').split(' ');
      if (header[0] !== oid || header.length !== 3) throw new Error(`unexpected cat-file header ${header.join(' ')}`);
      const size = Number(header[2]);
      const content = buf.subarray(nl + 1, nl + 1 + size);
      if (content.length !== size) throw new Error('truncated cat-file content');
      pos = nl + 1 + size + 1;
      await visit(oid, header[1] as string, Buffer.from(content));
    }
  }
}

export async function readBlob(git: SafeGit, repo: RepoLayout, oid: GitOid): Promise<Buffer> {
  let out: Buffer | null = null;
  await readObjects(git, repo, [oid], (_o, type, content) => {
    if (type !== 'blob') throw new Error(`${oid} is a ${type}, not a blob`);
    out = content;
  });
  if (out === null) throw new Error(`blob ${oid} not read`);
  return out;
}

// ---------------------------------------------------------------- building trees in TypeScript

export interface TreeItem {
  readonly name: string;
  readonly mode: EntryMode;
  readonly oid: GitOid;
}

function sortKey(item: TreeItem): Buffer {
  // git sorts tree entries by name, comparing a subtree as if its name ended in '/'.
  return Buffer.from(item.mode === '040000' ? item.name + '/' : item.name, 'utf8');
}

export function sortTreeItems(items: readonly TreeItem[]): TreeItem[] {
  return [...items].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
}

/** The canonical content of a tree object. */
export function encodeTree(items: readonly TreeItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of sortTreeItems(items)) {
    const mode = it.mode === '040000' ? '40000' : it.mode;
    parts.push(Buffer.from(`${mode} ${it.name}\0`, 'utf8'), Buffer.from(it.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface BuiltTree {
  readonly dir: string; // '' for the root
  readonly oid: GitOid;
  readonly items: readonly TreeItem[];
  readonly size: number; // uncompressed content length
}

/**
 * Builds every tree object for a set of files (path -> mode, oid), entirely in
 * TypeScript. Returns the trees children-first, root last.
 */
export function buildTrees(
  format: ObjectFormat,
  files: ReadonlyMap<string, { readonly mode: FileMode; readonly oid: GitOid }>,
): BuiltTree[] {
  const dirs = new Map<string, Map<string, TreeItem>>([['', new Map()]]);
  const children = new Map<string, string[]>();
  const ensureDir = (d: string): Map<string, TreeItem> => {
    let m = dirs.get(d);
    if (m === undefined) {
      m = new Map();
      dirs.set(d, m);
      const parent = parentDir(d);
      ensureDir(parent);
      const list = children.get(parent);
      if (list === undefined) children.set(parent, [d]);
      else list.push(d);
    }
    return m;
  };
  for (const [path, f] of files) {
    const name = baseName(path);
    ensureDir(parentDir(path)).set(name, { name, mode: f.mode, oid: f.oid });
  }
  // Deepest directories first, so each child oid is known before its parent.
  const order = [...dirs.keys()].sort((a, b) => depth(b) - depth(a));
  const oids = new Map<string, GitOid>();
  const built: BuiltTree[] = [];
  for (const d of order) {
    const items = dirs.get(d) as Map<string, TreeItem>;
    for (const child of children.get(d) ?? []) {
      const name = baseName(child);
      const oid = oids.get(child);
      if (oid === undefined) throw new Error('tree order violated');
      if (items.has(name)) throw new Error(`path is both a file and a directory: ${child}`);
      items.set(name, { name, mode: '040000', oid });
    }
    const sorted = sortTreeItems([...items.values()]);
    const content = encodeTree(sorted);
    const oid = gitObjectId(format, 'tree', content);
    oids.set(d, oid);
    built.push({ dir: d, oid, items: sorted, size: content.length });
  }
  return built;
}

export function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function depth(d: string): number {
  return d === '' ? 0 : d.split('/').length;
}

/** Writes one tree with `mktree -z` (git validates the entries and that the objects exist). */
export async function mktree(git: SafeGit, repo: RepoLayout, items: readonly TreeItem[]): Promise<GitOid> {
  const parts: Buffer[] = [];
  for (const it of items) {
    const type = it.mode === '040000' ? 'tree' : it.mode === '160000' ? 'commit' : 'blob';
    parts.push(Buffer.from(`${it.mode} ${type} ${it.oid}\t${it.name}\0`, 'utf8'));
  }
  // Gitlinks point at commits that need not exist here.
  const missingOk = items.some((i) => i.mode === '160000') ? ['--missing'] : [];
  return gitOid(
    await git.text([...repoArgs(repo), 'mktree', '-z', ...missingOk], {
      cwd: repo.commonDir,
      input: Buffer.concat(parts),
      config: [['core.fsync', 'committed']],
    }),
  );
}

/** Writes blobs from files with `hash-object -w --no-filters` (no filter, no eol conversion). */
export async function writeBlobsFromFiles(git: SafeGit, repo: RepoLayout, files: readonly string[]): Promise<GitOid[]> {
  if (files.length === 0) return [];
  for (const f of files) if (f.includes('\n')) throw new TypeError('path for --stdin-paths contains a newline');
  const out = await git.text([...repoArgs(repo), 'hash-object', '-w', '--no-filters', '--stdin-paths'], {
    cwd: repo.commonDir,
    input: files.join('\n') + '\n',
    config: [['core.fsync', 'committed']],
    maxOutputBytes: files.length * 70 + 1024,
  });
  const oids = out.split('\n');
  if (oids.length !== files.length) throw new Error('hash-object returned a different number of ids');
  return oids.map(gitOid);
}

export interface Ident {
  readonly name: string;
  readonly email: string;
  /** git date format, e.g. "1700000000 +0000"; default: now. */
  readonly date?: string;
}

export async function commitTree(
  git: SafeGit,
  repo: RepoLayout,
  tree: GitOid,
  parents: readonly GitOid[],
  message: string,
  author: Ident,
  committer: Ident,
): Promise<GitOid> {
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
  };
  if (author.date !== undefined) env.GIT_AUTHOR_DATE = author.date;
  if (committer.date !== undefined) env.GIT_COMMITTER_DATE = committer.date;
  return gitOid(
    await git.text([...repoArgs(repo), 'commit-tree', '--no-gpg-sign', tree, ...parents.flatMap((p) => ['-p', p])], {
      cwd: repo.commonDir,
      input: message,
      env,
      config: [['core.fsync', 'committed']],
    }),
  );
}

// ---------------------------------------------------------------- index -> tree without writing anything

export interface IndexEntry {
  readonly mode: EntryMode;
  readonly oid: GitOid;
  readonly stage: number;
  readonly path: string;
  /** ls-files -t tag: 'H' cached, 'S' skip-worktree, ... */
  readonly tag: string;
}

/** Parses `ls-files -s -t -z` output. */
export function parseLsFiles(buf: Buffer): IndexEntry[] {
  const entries: IndexEntry[] = [];
  let start = 0;
  while (start < buf.length) {
    const end = buf.indexOf(0, start);
    if (end < 0) break;
    const rec = buf.subarray(start, end);
    start = end + 1;
    const tab = rec.indexOf(9);
    const [tag, mode, oid, stage] = rec.subarray(0, tab).toString('latin1').split(' ');
    if (tag === undefined || mode === undefined || oid === undefined || stage === undefined) throw new Error('bad ls-files record');
    entries.push({ tag, mode: normalizeMode(mode), oid: gitOid(oid), stage: Number(stage), path: decodePath(rec.subarray(tab + 1)) });
  }
  return entries;
}

/**
 * The tree the index corresponds to, computed in TypeScript from stage-0
 * entries: no `write-tree`, so the user's index is never rewritten (6.6 "记录落地前状态").
 * Null when the index has unmerged entries.
 */
export function indexTree(format: ObjectFormat, entries: readonly IndexEntry[]): GitOid | null {
  const files = new Map<string, { mode: FileMode; oid: GitOid }>();
  for (const e of entries) {
    if (e.stage !== 0) return null;
    if (e.mode === '040000') continue; // sparse-index directory entries are expanded by ls-files; ignore defensively
    files.set(e.path, { mode: e.mode, oid: e.oid });
  }
  const trees = buildTrees(format, files);
  return (trees[trees.length - 1] as BuiltTree).oid;
}
