// Export of writable areas (design 7.1 "导出规则", 6.5 export cap and "峰值预留"; 6.2 recovery state):
//  - metered by each file's LOGICAL length (st_size), not its allocated blocks: a sparse
//    file counts in full, because copying it out would materialize it;
//  - metered by file count (files, directories and symlinks: each is an inode and an object);
//  - over either cap, the whole export is refused ("资源超限"), nothing written;
//  - v34: an entry named .git anywhere in the writable paths refuses the whole export as a
//    seat failure ("席位失败"): a product may not embed a repository, and no commit could carry it.
//
// Two destinations:
//  - exportAreas: a new host directory with a manifest (tests, diagnostics);
//  - exportToStore: STREAMED straight into the content store (code review r1 finding 3): each
//    file goes into one temporary object file in the store, hashed on the way, and is renamed
//    to its content address when it ends. No host copy exists, and the temporary file becomes
//    the stored object itself, so the physical peak is what the budget allows and nothing more
//    (exec/resources.ts exportPhysicalBound).
//
// ExportBudget (finding 4; 7.1 "结束时：完整对话记录与日志随导出进入内容库，计入卡片的导出上限"):
// everything one launch stores counts against the card's export caps TOGETHER: the product,
// the transcript, the tool log and the result documents. A product (and a recovery state) is
// stored whole or refused; a transcript is cut at what is left and its tree document says it
// is incomplete and why.
//
// Symlinks are recorded as tree entries only, never created on the host. Names in `exclude`
// (the Claude Code credentials file in a session state) are neither counted nor exported.

import { createHash, type Hash } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fsyncDir } from '../common/fsx.ts';
import { contentHash, type ContentHash } from '../common/ids.ts';
import type { ContentStore } from '../ledger/content.ts';
import { mkdirDurable } from '../ledger/durable.ts';
import type { AgentHost, ExportFrame } from './agent.ts';
import { SandboxError } from './holder.ts';

export interface ExportCaps {
  /** Sum of the logical lengths of files and symlink targets. */
  readonly maxLogicalBytes: number;
  /** Number of exported entries: files, directories and symlinks (and stored documents). */
  readonly maxFiles: number;
}

export interface ExportMeter {
  readonly logicalBytes: number;
  readonly entries: number;
  readonly files: number;
  readonly dirs: number;
  readonly symlinks: number;
  /** Entries left out because their name is excluded. */
  readonly excluded: number;
  /** Bytes of the tree entries these entries become (exactly treeEntryIndexBytes each). */
  readonly indexBytes: number;
  /** Sockets, fifos, devices: not exportable, listed (first 100). */
  readonly skipped: readonly { readonly path: string; readonly type: string }[];
  /** Entries with a refused name (first 100). */
  readonly flagged: readonly string[];
}

export interface ExportEntry {
  readonly path: string;
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly mode: number;
  readonly size: number;
  readonly sha256: string | null;
  readonly target: string | null;
}

export interface ExportManifest {
  readonly entries: readonly ExportEntry[];
  readonly logicalBytes: number;
  readonly skipped: readonly { readonly path: string; readonly type: string }[];
}

export type ExportOutcome =
  | { readonly ok: true; readonly dest: string; readonly meter: ExportMeter; readonly manifest: ExportManifest }
  /** Over the cap: refused as a whole, nothing written (7.1). */
  | { readonly ok: false; readonly status: 'resource-exceeded'; readonly meter: ExportMeter; readonly caps: ExportCaps }
  /** A refused name in the writable paths (v34: `.git`): refused as a whole, nothing written; the seat failed. */
  | { readonly ok: false; readonly status: 'seat-failure'; readonly meter: ExportMeter; readonly refused: readonly string[] };

export interface ExportOptions {
  readonly exclude?: readonly string[];
  /** Names that refuse the whole export with "seat-failure" wherever they appear. */
  readonly refuseNames?: readonly string[];
  readonly timeoutMs?: number;
}

/** v34 7.1: a product never carries repository metadata. */
export const REFUSED_EXPORT_NAMES: readonly string[] = ['.git'];

function safeRel(p: unknown): string {
  if (typeof p !== 'string' || p === '' || p.includes('\0') || p.startsWith('/')) throw new SandboxError(`bad export path ${JSON.stringify(p)}`);
  const n = posix.normalize(p);
  if (n !== p || n === '.' || n === '..' || n.startsWith('../')) throw new SandboxError(`bad export path ${JSON.stringify(p)}`);
  return n;
}

function discard(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort: the caller's scratch directory */
  }
}

/** Meters the host's export roots without exporting anything. */
export async function meterAreas(host: AgentHost, opts: ExportOptions = {}): Promise<ExportMeter> {
  const reply = await host.callAgent(
    { op: 'meter', exclude: opts.exclude ?? [], flag: opts.refuseNames ?? [] },
    { timeoutMs: opts.timeoutMs ?? 120_000, maxResponseBytes: 1 << 20 },
  );
  if (!reply.ok) throw new SandboxError(`metering failed: ${reply.error.code}: ${reply.error.message}`);
  return reply.result as ExportMeter;
}

/** Meters, refuses over the caps, else writes everything into `dest` (a new host directory). */
export async function exportAreas(host: AgentHost, dest: string, caps: ExportCaps, opts: ExportOptions = {}): Promise<ExportOutcome> {
  const exclude = opts.exclude ?? [];
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const meter = await meterAreas(host, opts);
  if (meter.flagged.length > 0) return { ok: false, status: 'seat-failure', meter, refused: meter.flagged };
  if (meter.logicalBytes > caps.maxLogicalBytes || meter.entries > caps.maxFiles) {
    return { ok: false, status: 'resource-exceeded', meter, caps };
  }
  mkdirSync(dest, { mode: 0o700 });
  const entries: ExportEntry[] = [];
  const skipped: { path: string; type: string }[] = [];
  let fd: number | null = null;
  let hash: Hash | null = null;
  let current: { path: string; mode: number; size: number } | null = null;
  let tail: ExportFrame | null = null;
  try {
    await host.exportStream(
      { op: 'export', maxBytes: caps.maxLogicalBytes, maxEntries: caps.maxFiles, exclude, flag: opts.refuseNames ?? [] },
      {
        frame(f: ExportFrame): void {
          switch (f.k) {
            case 'dir':
              mkdirSync(join(dest, safeRel(f.p)), { recursive: true, mode: 0o700 });
              entries.push({ path: f.p, kind: 'dir', mode: f.mode, size: 0, sha256: null, target: null });
              break;
            case 'file': {
              const rel = safeRel(f.p);
              mkdirSync(join(dest, posix.dirname(rel)), { recursive: true, mode: 0o700 });
              fd = openSync(join(dest, rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
              hash = createHash('sha256');
              current = { path: rel, mode: f.mode, size: f.size };
              break;
            }
            case 'symlink':
              safeRel(f.p);
              entries.push({ path: f.p, kind: 'symlink', mode: 0o777, size: Buffer.byteLength(f.target), sha256: null, target: f.target });
              break;
            case 'skip':
              skipped.push({ path: f.p, type: f.type });
              break;
            default:
              tail = f;
          }
        },
        data(chunk: Buffer): void {
          if (fd === null || hash === null) throw new SandboxError('file data outside a file frame');
          let off = 0;
          while (off < chunk.length) off += writeSync(fd, chunk, off, chunk.length - off);
          hash.update(chunk);
        },
        fileEnd(): void {
          if (fd === null || hash === null || current === null) throw new SandboxError('file end outside a file frame');
          closeSync(fd);
          entries.push({ path: current.path, kind: 'file', mode: current.mode, size: current.size, sha256: hash.digest('hex'), target: null });
          fd = null;
          hash = null;
          current = null;
        },
      },
      timeoutMs,
    );
  } catch (e) {
    discard(dest);
    throw e;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  const end = tail as ExportFrame | null;
  if (end === null || end.k !== 'end') {
    discard(dest);
    const why = end === null ? 'no end frame' : end.k === 'error' ? `${end.code}: ${end.message}` : `${end.k} (content changed after metering)`;
    throw new SandboxError(`export did not complete: ${why}; nothing was exported`);
  }
  return { ok: true, dest, meter, manifest: { entries, logicalBytes: end.bytes, skipped } };
}

// ---------------------------------------------------------------- trees in the content store

export interface TreeEntry {
  readonly path: string;
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly mode: number;
  /** Bytes stored (a cut file: its stored prefix). */
  readonly size: number;
  readonly hash: ContentHash | null;
  readonly target: string | null;
  /** A file cut at the budget: its full logical length. */
  readonly truncatedFrom?: number;
}

/** Why a stored tree does not hold everything it should (7.1: "在记录上标'对话记录不完整'"). */
export interface TreeIncomplete {
  readonly reason: string;
  readonly omittedEntries: number;
  readonly omittedBytes: number;
}

export interface TreeDocument {
  readonly format: 'mp4.tree.v1';
  readonly entries: readonly TreeEntry[];
  readonly incomplete?: TreeIncomplete;
}

/**
 * Index allowance of one tree entry in the budget (6.5 "一条索引记录"): the budget charges
 * every entry its exact serialized length and holds (entries + documents) x this in total, so a
 * few long paths borrow from short ones; exportPhysicalBound uses the same number.
 */
export const EXPORT_INDEX_RECORD_BYTES = 512;
/**
 * Program documents a launch may store besides its exported entries, without taking from the
 * card's file cap: the result and its findings, the evidence request, the tool log, the tree
 * documents, the id lists. They are counted in the physical bound all the same.
 */
export const EXPORT_DOC_OBJECTS = 64;
/** A tree document's own frame (format, brackets) and, when cut, its incomplete marker. */
export const TREE_DOC_FRAME_BYTES = 64;
export const TREE_INCOMPLETE_BYTES = 600;
const MAX_REASON = 400;

/** Bytes one entry adds to its tree document (JSON plus a separator). The file agent meters the same way. */
export function treeEntryIndexBytes(e: TreeEntry): number {
  return Buffer.byteLength(JSON.stringify(e), 'utf8') + 1;
}

export interface BudgetCharge {
  /** Logical bytes stored (file contents, symlink targets, documents). */
  readonly bytes?: number;
  /** Exported entries: they take from the card's file cap. */
  readonly entries?: number;
  /** Program documents: objects that do not take from the card's file cap. */
  readonly docs?: number;
  /** Bytes of tree entries and id lists. */
  readonly index?: number;
}

/**
 * What one launch may still store (finding 4): logical bytes (the card's cap), exported
 * entries (the card's file cap), objects (entries plus EXPORT_DOC_OBJECTS documents), and index
 * bytes for tree documents and lists. Charges are all-or-nothing.
 */
export class ExportBudget {
  readonly caps: ExportCaps;
  readonly indexRecordBytes: number;
  private remaining: { bytes: number; entries: number; objects: number; index: number };

  constructor(caps: ExportCaps, indexRecordBytes: number = EXPORT_INDEX_RECORD_BYTES) {
    if (!Number.isSafeInteger(caps.maxLogicalBytes) || caps.maxLogicalBytes < 0 || !Number.isSafeInteger(caps.maxFiles) || caps.maxFiles < 0) {
      throw new RangeError(`bad export caps ${JSON.stringify(caps)}`);
    }
    this.caps = caps;
    this.indexRecordBytes = indexRecordBytes;
    const objects = caps.maxFiles + EXPORT_DOC_OBJECTS;
    this.remaining = { bytes: caps.maxLogicalBytes, entries: caps.maxFiles, objects, index: objects * indexRecordBytes };
  }

  get bytes(): number {
    return this.remaining.bytes;
  }

  /** Exported entries left under the card's file cap. */
  get files(): number {
    return this.remaining.entries;
  }

  get objects(): number {
    return this.remaining.objects;
  }

  get index(): number {
    return this.remaining.index;
  }

  fits(c: BudgetCharge): boolean {
    const r = this.remaining;
    const objects = (c.entries ?? 0) + (c.docs ?? 0);
    return (c.bytes ?? 0) <= r.bytes && (c.entries ?? 0) <= r.entries && objects <= r.objects && (c.index ?? 0) <= r.index;
  }

  charge(c: BudgetCharge): boolean {
    if (!this.fits(c)) return false;
    const r = this.remaining;
    this.remaining = {
      bytes: r.bytes - (c.bytes ?? 0),
      entries: r.entries - (c.entries ?? 0),
      objects: r.objects - (c.entries ?? 0) - (c.docs ?? 0),
      index: r.index - (c.index ?? 0),
    };
    return true;
  }

  /** Gives back a charge made for something that was then not stored. */
  refund(c: BudgetCharge): void {
    const r = this.remaining;
    this.remaining = {
      bytes: r.bytes + (c.bytes ?? 0),
      entries: r.entries + (c.entries ?? 0),
      objects: r.objects + (c.entries ?? 0) + (c.docs ?? 0),
      index: r.index + (c.index ?? 0),
    };
  }

  get used(): { readonly bytes: number; readonly entries: number; readonly objects: number; readonly index: number } {
    const objects = this.caps.maxFiles + EXPORT_DOC_OBJECTS;
    return {
      bytes: this.caps.maxLogicalBytes - this.remaining.bytes,
      entries: this.caps.maxFiles - this.remaining.entries,
      objects: objects - this.remaining.objects,
      index: objects * this.indexRecordBytes - this.remaining.index,
    };
  }

  describe(): string {
    return `${this.remaining.bytes} bytes, ${this.remaining.entries} entries, ${this.remaining.objects} objects, ${this.remaining.index} index bytes left`;
  }
}

/**
 * The launch's private export directory in the content store's file system (created when the
 * unit starts and bound to its identity, a cleanup resource), and the one temporary object file
 * in it that every object streams through before it is renamed to its content address.
 */
export function exportTempDir(contentRoot: string, tag: string): string {
  return join(contentRoot, `.mp-export-${tag.replace(/[^A-Za-z0-9._:@-]/g, '_')}`);
}

export function exportTempPath(contentRoot: string, tag: string): string {
  return join(exportTempDir(contentRoot, tag), 'object.tmp');
}

/** Streams one object into the content store: temporary file, hash, fsync, rename to its address. */
class ObjectWriter {
  private readonly content: ContentStore;
  private readonly temp: string;
  private fd: number | null = null;
  private hash: Hash | null = null;
  private written = 0;

  constructor(content: ContentStore, temp: string) {
    this.content = content;
    this.temp = temp;
  }

  begin(): void {
    mkdirSync(dirname(this.temp), { recursive: true, mode: 0o700 }); // normally created (and bound) at the unit's start
    if (existsSync(this.temp)) unlinkSync(this.temp); // left by an earlier, interrupted attempt of the launch
    this.fd = openSync(this.temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    this.hash = createHash('sha256');
    this.written = 0;
  }

  write(chunk: Buffer): void {
    if (this.fd === null || this.hash === null) throw new SandboxError('object data outside an object');
    let off = 0;
    while (off < chunk.length) off += writeSync(this.fd, chunk, off, chunk.length - off);
    this.hash.update(chunk);
    this.written += chunk.length;
  }

  get bytes(): number {
    return this.written;
  }

  finish(): ContentHash {
    if (this.fd === null || this.hash === null) throw new SandboxError('no object open');
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.fd = null;
    const h = contentHash(this.hash.digest('hex'));
    this.hash = null;
    const dest = this.content.path(h);
    if (existsSync(dest)) {
      unlinkSync(this.temp);
      return h;
    }
    try {
      renameSync(this.temp, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      mkdirDurable(dirname(dest)); // a fan-out directory went missing: recreate it durably (as ContentStore.put does)
      renameSync(this.temp, dest);
    }
    fsyncDir(dirname(dest));
    return h;
  }

  abort(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* closed */
      }
      this.fd = null;
    }
    try {
      unlinkSync(this.temp);
    } catch {
      /* not there */
    }
  }
}

export interface StoreTreeOptions extends ExportOptions {
  /**
   * 'whole': stored whole or refused as a whole over the budget (a product, a recovery state).
   * 'truncate': stored up to what the budget allows; the tree document says what is missing (a transcript).
   */
  readonly mode: 'whole' | 'truncate';
  /** The temporary object file (exportTempPath). */
  readonly tempPath: string;
}

export type StoreTreeOutcome =
  | { readonly ok: true; readonly tree: ContentHash; readonly entries: number; readonly logicalBytes: number; readonly incomplete: TreeIncomplete | null }
  | { readonly ok: false; readonly status: 'resource-exceeded'; readonly reason: string; readonly meter: ExportMeter | null }
  | { readonly ok: false; readonly status: 'seat-failure'; readonly refused: readonly string[]; readonly meter: ExportMeter };

/** Stores a tree document, charging its frame; the entries were charged as they were included. */
function putTree(content: ContentStore, entries: readonly TreeEntry[], incomplete: TreeIncomplete | null): ContentHash {
  const doc: TreeDocument = incomplete === null ? { format: 'mp4.tree.v1', entries } : { format: 'mp4.tree.v1', entries, incomplete };
  return content.put(JSON.stringify(doc));
}

/**
 * Streams the host's export roots into the content store as a tree document, within `budget`.
 * Whole mode meters first and refuses over the budget before anything is written. Truncate
 * mode keeps whole entries while they fit, cuts the first file that does not at the bytes
 * left, and records what it left out.
 */
export async function exportToStore(host: AgentHost, content: ContentStore, budget: ExportBudget, opts: StoreTreeOptions): Promise<StoreTreeOutcome> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const exclude = opts.exclude ?? [];
  // the tree document itself: one document and its frame (and, cut, its marker), set aside first
  const frame: BudgetCharge = { docs: 1, index: TREE_DOC_FRAME_BYTES + (opts.mode === 'truncate' ? TREE_INCOMPLETE_BYTES : 0) };
  if (!budget.charge(frame)) {
    return { ok: false, status: 'resource-exceeded', reason: `no allowance left for a tree document (${budget.describe()})`, meter: null };
  }
  let meter: ExportMeter | null = null;
  if (opts.mode === 'whole') {
    meter = await meterAreas(host, { exclude, ...(opts.refuseNames !== undefined ? { refuseNames: opts.refuseNames } : {}), timeoutMs: Math.min(timeoutMs, 120_000) });
    if (meter.flagged.length > 0) {
      budget.refund(frame);
      return { ok: false, status: 'seat-failure', refused: meter.flagged, meter };
    }
    if (!budget.charge({ bytes: meter.logicalBytes, entries: meter.entries, index: meter.indexBytes })) {
      const why = `${meter.logicalBytes} bytes, ${meter.entries} entries and ${meter.indexBytes} index bytes; ${budget.describe()}`;
      budget.refund(frame);
      return { ok: false, status: 'resource-exceeded', reason: `over the export allowance (${why})`, meter };
    }
  }
  const writer = new ObjectWriter(content, opts.tempPath);
  const entries: TreeEntry[] = [];
  const st = {
    stored: 0,
    omittedEntries: 0,
    omittedBytes: 0,
    cut: null as string | null,
    // the file being streamed: its frame, and how many of its bytes are kept (-1: none)
    cur: null as { p: string; mode: number; size: number; keep: number; seen: number } | null,
    tail: null as ExportFrame | null,
  };
  const omit = (bytes: number): void => {
    st.omittedEntries++;
    st.omittedBytes += bytes;
  };
  /** Truncate mode: charge an entry if everything before it fit and it fits too. */
  const include = (e: TreeEntry, bytes: number): boolean => {
    if (opts.mode === 'whole') return true; // charged in full from the meter
    if (st.cut !== null) return false;
    if (budget.charge({ bytes, entries: 1, index: treeEntryIndexBytes(e) })) return true;
    st.cut = `the export allowance is used up at ${e.path} (${budget.describe()})`;
    return false;
  };
  /** Truncate mode: how many bytes of a file to keep: all, a prefix (then everything after is left out), or none (-1). */
  const keepOf = (f: { p: string; mode: number; size: number }): number => {
    if (opts.mode === 'whole') return f.size;
    if (st.cut !== null) return -1;
    const whole: TreeEntry = { path: f.p, kind: 'file', mode: f.mode, size: f.size, hash: contentHash('0'.repeat(64)), target: null };
    if (budget.charge({ bytes: f.size, entries: 1, index: treeEntryIndexBytes(whole) })) return f.size;
    const keep = Math.min(f.size, budget.bytes);
    const cut: TreeEntry = { ...whole, size: keep, truncatedFrom: f.size };
    const kept = keep > 0 && budget.charge({ bytes: keep, entries: 1, index: treeEntryIndexBytes(cut) }) ? keep : -1;
    st.cut = `the export allowance is used up at ${f.p} (${f.size} bytes, ${kept < 0 ? 0 : kept} kept)`;
    return kept;
  };
  try {
    await host.exportStream(
      {
        op: 'export',
        // whole mode: never more than was metered and charged (content that grew aborts the export)
        maxBytes: opts.mode === 'whole' ? (meter as ExportMeter).logicalBytes : Number.MAX_SAFE_INTEGER,
        maxEntries: opts.mode === 'whole' ? (meter as ExportMeter).entries : Number.MAX_SAFE_INTEGER,
        exclude,
        flag: opts.refuseNames ?? [],
      },
      {
        frame(f: ExportFrame): void {
          switch (f.k) {
            case 'dir': {
              const e: TreeEntry = { path: safeRel(f.p), kind: 'dir', mode: f.mode, size: 0, hash: null, target: null };
              if (include(e, 0)) entries.push(e);
              else omit(0);
              break;
            }
            case 'symlink': {
              const e: TreeEntry = { path: safeRel(f.p), kind: 'symlink', mode: 0o777, size: Buffer.byteLength(f.target), hash: null, target: f.target };
              if (include(e, e.size)) entries.push(e);
              else omit(e.size);
              break;
            }
            case 'file': {
              const c = { p: safeRel(f.p), mode: f.mode, size: f.size, keep: 0, seen: 0 };
              c.keep = keepOf(c);
              st.cur = c;
              if (c.keep >= 0) writer.begin();
              else omit(f.size);
              break;
            }
            case 'skip':
              break;
            default:
              st.tail = f;
          }
        },
        data(chunk: Buffer): void {
          const c = st.cur;
          if (c === null) throw new SandboxError('file data outside a file frame');
          if (c.keep > c.seen) writer.write(chunk.subarray(0, Math.min(chunk.length, c.keep - c.seen)));
          c.seen += chunk.length;
          if (c.seen > c.size) throw new SandboxError(`${c.p} sent more than its ${c.size} bytes`);
        },
        fileEnd(): void {
          const c = st.cur;
          if (c === null) throw new SandboxError('file end outside a file frame');
          if (c.keep >= 0) {
            const h = writer.finish();
            st.stored += c.keep;
            if (c.keep === c.size) entries.push({ path: c.p, kind: 'file', mode: c.mode, size: c.size, hash: h, target: null });
            else {
              entries.push({ path: c.p, kind: 'file', mode: c.mode, size: c.keep, hash: h, target: null, truncatedFrom: c.size });
              st.omittedBytes += c.size - c.keep;
            }
          }
          st.cur = null;
        },
      },
      timeoutMs,
    );
  } catch (e) {
    writer.abort();
    throw e;
  }
  writer.abort(); // nothing is open now; removes a stray temporary file
  const end = st.tail;
  if (end === null || end.k !== 'end') {
    const why = end === null ? 'no end frame' : end.k === 'error' ? `${end.code}: ${end.message}` : `${end.k} (content changed after metering)`;
    throw new SandboxError(`export did not complete: ${why}; nothing was stored as a tree`);
  }
  if (opts.mode === 'whole') {
    const index = entries.reduce((n, e) => n + treeEntryIndexBytes(e), 0);
    if (index > (meter as ExportMeter).indexBytes) throw new SandboxError(`export did not complete: its entries changed after metering (${index} > ${(meter as ExportMeter).indexBytes} index bytes); nothing was stored as a tree`);
  }
  const incomplete: TreeIncomplete | null = st.cut !== null ? { reason: st.cut.slice(0, MAX_REASON), omittedEntries: st.omittedEntries, omittedBytes: st.omittedBytes } : null;
  const tree = putTree(content, entries, incomplete);
  return { ok: true, tree, entries: entries.length, logicalBytes: st.stored, incomplete };
}

/**
 * Stores one program document within the budget (a result, an evidence request, a log); null
 * when it does not fit (the caller says so: nothing is dropped silently).
 */
export function putWithin(content: ContentStore, budget: ExportBudget, data: string | Uint8Array): ContentHash | null {
  const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
  if (!budget.charge({ bytes, docs: 1 })) return null;
  return content.put(data);
}

/** A tree document that says only why its content is missing (charged as one document). */
export function putEmptyTree(content: ContentStore, budget: ExportBudget, reason: string): ContentHash | null {
  if (!budget.charge({ docs: 1, index: TREE_DOC_FRAME_BYTES + TREE_INCOMPLETE_BYTES })) return null;
  return putTree(content, [], { reason: reason.slice(0, MAX_REASON), omittedEntries: 0, omittedBytes: 0 });
}
