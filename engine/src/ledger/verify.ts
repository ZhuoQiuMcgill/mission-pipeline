// Content verification at the ledger boundary (design 6.1 "发布前复核" item 3;
// core review r2 F7, F11, F21).
//
// A record may enter the log only if every content-store object it refers to
// exists and hashes to its name, and every list it refers to is a JSON array of
// strings with the declared count. This work grows with the content, so it never
// runs inside the service's serial queue: a request is verified first, with
// asynchronous chunked reads and a scanner that yields to the event loop, and
// only then enqueued. Stops are therefore never delayed behind a large list.
// Content is immutable, so a verified hash is cached.
//
// Lists are capped (MAX_LIST_ITEMS items, MAX_LIST_BYTES bytes); a larger list is
// refused with TOO_LARGE before it is read.

import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setImmediate as yieldNow } from 'node:timers/promises';
import type { ContentHash } from '../common/ids.ts';
import { continuationInputsHash, type BaseRecord, type ListRef } from '../common/records.ts';
import type { ContentStore } from './content.ts';
import { LedgerError } from './errors.ts';

export const MAX_LIST_ITEMS = 250_000;
export const MAX_LIST_BYTES = 64 * 1024 * 1024;

const READ_CHUNK = 1024 * 1024;
/** Bytes scanned between two yields to the event loop. */
const SCAN_SLICE = 256 * 1024;
const CACHE_LIMIT = 200_000;
const CONCURRENCY = 8;

/** What one request had verified: the ledger checks a record against it inside the queue. */
export interface Verified {
  readonly blobs: Set<string>;
  /** list hash -> item count */
  readonly lists: Map<string, number>;
  /** items of the lists the request needs to read (cleanup resources, regression inputs) */
  readonly items: Map<string, readonly string[]>;
  /** continuation judgment id -> continuationInputsHash of its four lists, computed here, outside the queue */
  readonly inputs: Map<string, string>;
}

export function emptyVerified(): Verified {
  return { blobs: new Set(), lists: new Map(), items: new Map(), inputs: new Map() };
}

/** Every ListRef found at the top level of a record. */
export function listRefs(record: BaseRecord): ListRef[] {
  const out: ListRef[] = [];
  for (const v of Object.values(record)) {
    if (v && typeof v === 'object' && 'hash' in v && 'count' in v) out.push(v as ListRef);
  }
  return out;
}

/**
 * The plain content-store objects a record refers to (other than lists). Not
 * here: `object.version.source.transform`, the hash of a transform description
 * (an identity the delivery computes, not stored content, 6.6).
 */
export function blobRefs(record: BaseRecord): ContentHash[] {
  switch (record.kind) {
    case 'object.version':
      return [record.content];
    case 'seat.result':
      return [record.result, record.export, record.transcript, record.recoveryState, record.evidenceRequest, record.toolLog].filter((h): h is ContentHash => h !== null && h !== undefined);
    case 'issue':
      return record.text === undefined ? [] : [record.text];
    case 'judgment':
      // 5.6: a deferred response carries its owner and the reason document.
      return record.issues.flatMap((i) => (i.reason === undefined ? [] : [i.reason]));
    case 'notice':
      return [record.body];
    case 'loop.grant':
      return [record.reason];
    case 'mission.block':
      return [record.report];
    case 'user.words':
      return [record.text];
    case 'task.queued':
      return [record.card];
    case 'install.state':
      return [record.detail];
    case 'flow.event':
      return [record.body];
    default:
      return [];
  }
}

/** Lists whose items the ledger itself uses inside the queue. */
function wantsItems(record: BaseRecord, ref: ListRef): boolean {
  if (record.kind === 'cleanup.state') return ref === record.resources;
  // A continuation judgment's lists are read to bind them to the evaluator's merged inputs (core review r3 #1).
  if (record.kind === 'judgment' && record.extends !== null) return ref === record.evidence || ref === record.bases || ref === record.constraints || ref === record.reliesOn;
  return false;
}

/** The regression inputs list of a registration, whose entries are checked once per hash. */
function isCoverageInputs(record: BaseRecord, ref: ListRef): boolean {
  return record.kind === 'issue.coverage' && ref === record.inputs;
}

const INPUT_ENTRY = /^(testfile|runner|fixture):(.+)=([0-9a-f]{64})$/;

/**
 * Regression registration inputs (5.6, core review r2 F21): every entry is
 * "name=sha256" with a testfile:, runner: or fixture: name; at least one test
 * file and one runner configuration are declared.
 */
export function checkCoverageInputs(items: readonly string[]): void {
  let testfiles = 0;
  let runners = 0;
  for (const it of items) {
    const m = INPUT_ENTRY.exec(it);
    if (!m) throw new LedgerError('RECORD_INVALID', `issue.coverage input ${JSON.stringify(it)} is not "testfile:|runner:|fixture:<name>=<sha256>"`);
    if (m[1] === 'testfile') testfiles++;
    if (m[1] === 'runner') runners++;
  }
  if (testfiles === 0 || runners === 0) {
    throw new LedgerError('RECORD_INVALID', 'a regression registration declares at least one testfile: and one runner: input hash (5.6); without them the issue goes to the Reviewer');
  }
}

function corrupt(hash: string, why: string): LedgerError {
  return new LedgerError('CONTENT_MISSING', `content ${hash} is unreadable or corrupt: ${why}`);
}

function notAList(hash: string, why: string): LedgerError {
  return new LedgerError('RECORD_INVALID', `list ${hash} is not a JSON list of strings: ${why}`);
}

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}

/**
 * Scan a JSON array of strings at the byte level, exactly as strict as
 * `JSON.parse` followed by "every item is a string": structure bytes are ASCII
 * and never occur inside a UTF-8 multi-byte sequence, so each item's bytes can
 * be decoded on their own. Yields to the event loop every SCAN_SLICE bytes.
 * Returns the item count, and the items when `keep` is set.
 */
export async function scanStringList(buf: Uint8Array, hash: string, maxItems: number, keep: boolean): Promise<{ count: number; items: string[] | null }> {
  const n = buf.length;
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const items: string[] | null = keep ? [] : null;
  let i = 0;
  let nextYield = SCAN_SLICE;
  const ws = (): void => {
    while (i < n && isWs(b[i]!)) i++;
  };
  ws();
  if (b[i] !== 0x5b) throw notAList(hash, 'it does not start with [');
  i++;
  ws();
  let count = 0;
  if (b[i] === 0x5d) {
    i++;
  } else {
    for (;;) {
      if (b[i] !== 0x22) throw notAList(hash, `item ${count} is not a string`);
      const start = i;
      let j = i + 1;
      let escaped = false;
      for (;;) {
        if (j >= n) throw notAList(hash, 'unterminated string');
        const c = b[j]!;
        if (c === 0x22) break;
        if (c === 0x5c) {
          escaped = true;
          j += 2;
          continue;
        }
        if (c < 0x20) throw notAList(hash, 'control character in a string');
        j++;
        if (j >= nextYield) {
          nextYield = j + SCAN_SLICE;
          await yieldNow();
        }
      }
      if (escaped) {
        let v: unknown;
        try {
          v = JSON.parse(b.toString('utf8', start, j + 1));
        } catch {
          throw notAList(hash, 'bad escape in a string');
        }
        items?.push(v as string);
      } else items?.push(b.toString('utf8', start + 1, j));
      count++;
      if (count > maxItems) throw new LedgerError('TOO_LARGE', `list ${hash} has more than ${maxItems} items`);
      i = j + 1;
      ws();
      if (b[i] === 0x2c) {
        i++;
        ws();
      } else if (b[i] === 0x5d) {
        i++;
        break;
      } else throw notAList(hash, 'expected , or ]');
      if (i >= nextYield) {
        nextYield = i + SCAN_SLICE;
        await yieldNow();
      }
    }
  }
  ws();
  if (i !== n) throw notAList(hash, 'trailing content after the list');
  return { count, items };
}

export interface VerifierOptions {
  readonly maxListItems?: number;
  readonly maxListBytes?: number;
}

export class ContentVerifier {
  private readonly content: ContentStore;
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly blobs = new Set<string>();
  private readonly lists = new Map<string, number>();
  private readonly coverageOk = new Set<string>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(content: ContentStore, opts: VerifierOptions = {}) {
    this.content = content;
    this.maxItems = opts.maxListItems ?? MAX_LIST_ITEMS;
    this.maxBytes = opts.maxListBytes ?? MAX_LIST_BYTES;
  }

  /** Drop the cache (tests; or after the content store was repaired). */
  forget(): void {
    this.blobs.clear();
    this.lists.clear();
    this.coverageOk.clear();
  }

  private remember(set: Set<string> | Map<string, number>, hash: string, count?: number): void {
    if (set.size >= CACHE_LIMIT) set.clear();
    if (set instanceof Map) set.set(hash, count!);
    else set.add(hash);
  }

  private checkSize(ref: ListRef): void {
    if (ref.count > this.maxItems) throw new LedgerError('TOO_LARGE', `list ${ref.hash} has ${ref.count} items; the limit is ${this.maxItems} per list`);
  }

  /** Read a file in chunks, hashing as it goes; returns the bytes when `keep`. */
  private async readHashed(hash: string, keep: boolean, maxBytes: number | null): Promise<Buffer | null> {
    let fh;
    try {
      fh = await open(this.content.path(hash as ContentHash), 'r');
    } catch (e) {
      throw new LedgerError('CONTENT_MISSING', `content ${hash} is not in the content store (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
    try {
      const size = (await fh.stat()).size;
      if (maxBytes !== null && size > maxBytes) throw new LedgerError('TOO_LARGE', `list ${hash} is ${size} bytes; the limit is ${maxBytes}`);
      const h = createHash('sha256');
      const out = keep ? Buffer.allocUnsafe(size) : null;
      const chunk = keep ? null : Buffer.allocUnsafe(Math.min(READ_CHUNK, Math.max(size, 1)));
      let off = 0;
      while (off < size) {
        const len = Math.min(READ_CHUNK, size - off);
        const target = out ?? chunk!;
        const at = out ? off : 0;
        const { bytesRead } = await fh.read(target, at, len, off);
        if (bytesRead === 0) break;
        h.update(target.subarray(at, at + bytesRead));
        off += bytesRead;
      }
      if (off !== size) throw corrupt(hash, 'short read');
      if (h.digest('hex') !== hash) throw corrupt(hash, 'its bytes do not hash to its name');
      return out;
    } catch (e) {
      if (e instanceof LedgerError) throw e;
      throw corrupt(hash, (e as Error).message);
    } finally {
      await fh.close();
    }
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async verifyBlob(hash: ContentHash, fresh = false): Promise<void> {
    if (!fresh && (this.blobs.has(hash) || this.lists.has(hash))) return;
    await this.once(`b:${hash}`, async () => {
      await this.readHashed(hash, false, null);
      this.remember(this.blobs, hash);
    });
  }

  /** Verify a list; returns its items when `keep` (never from the cache, the items are not cached). */
  async verifyList(ref: ListRef, keep: boolean, fresh = false): Promise<readonly string[] | null> {
    this.checkSize(ref);
    const known = fresh ? undefined : this.lists.get(ref.hash);
    if (!keep && known !== undefined) {
      if (known !== ref.count) throw new LedgerError('RECORD_INVALID', `list ${ref.hash} has ${known} items, not ${ref.count}`);
      return null;
    }
    const run = async (): Promise<{ count: number; items: string[] | null }> => {
      const buf = await this.readHashed(ref.hash, true, this.maxBytes);
      const r = await scanStringList(buf!, ref.hash, this.maxItems, keep);
      this.remember(this.lists, ref.hash, r.count);
      return r;
    };
    const r = keep || fresh ? await run() : await this.once(`l:${ref.hash}`, run);
    if (r.count !== ref.count) throw new LedgerError('RECORD_INVALID', `list ${ref.hash} has ${r.count} items, not ${ref.count}`);
    return r.items;
  }

  /**
   * Verify everything the records refer to, at most CONCURRENCY reads at a time.
   * `fresh`: read and hash every reference again, whatever the cache says (the
   * acceptance of a result checks the material as it is now: core review r3 #2).
   */
  async verifyRecords(records: readonly BaseRecord[], extraBlobs: readonly ContentHash[] = [], opts: { fresh?: boolean } = {}): Promise<Verified> {
    const fresh = opts.fresh === true;
    const v = emptyVerified();
    const jobs: Array<() => Promise<void>> = [];
    const seen = new Set<string>();
    for (const record of records) {
      for (const ref of listRefs(record)) {
        this.checkSize(ref);
        const keep = wantsItems(record, ref);
        const coverage = isCoverageInputs(record, ref);
        const key = `${keep ? 'k' : 'l'}${coverage ? 'c' : ''}:${ref.hash}:${ref.count}`;
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push(async () => {
          if (!fresh && coverage && this.coverageOk.has(ref.hash) && this.lists.get(ref.hash) === ref.count) {
            v.lists.set(ref.hash, ref.count);
            return;
          }
          const items = await this.verifyList(ref, keep || coverage, fresh);
          v.lists.set(ref.hash, ref.count);
          if (items !== null && keep) v.items.set(ref.hash, items);
          if (coverage) {
            checkCoverageInputs(items ?? []);
            this.remember(this.coverageOk, ref.hash);
          }
        });
      }
      for (const h of blobRefs(record)) {
        if (seen.has(`b:${h}`)) continue;
        seen.add(`b:${h}`);
        jobs.push(async () => {
          await this.verifyBlob(h, fresh);
          v.blobs.add(h);
        });
      }
    }
    for (const h of extraBlobs) {
      if (seen.has(`b:${h}`)) continue;
      seen.add(`b:${h}`);
      jobs.push(async () => {
        await this.verifyBlob(h, fresh);
        v.blobs.add(h);
      });
    }
    await runLimited(jobs, CONCURRENCY);
    for (const record of records) {
      if (record.kind !== 'judgment' || record.extends === null) continue;
      const items = (ref: ListRef): readonly string[] => v.items.get(ref.hash) ?? [];
      v.inputs.set(record.judgment, continuationInputsHash({ evidence: items(record.evidence), bases: items(record.bases), constraints: items(record.constraints), reliesOn: items(record.reliesOn) }));
    }
    return v;
  }

  // ---------------------------------------------------------------- inside the queue

  /**
   * Inside the queue: every reference of the record must have been verified for
   * this request (`fresh`: by this request itself, not by the cache). Nothing is
   * read here: a reference that was not verified (the request differs from what
   * was verified) is refused with STALE_REQUEST, and the caller verifies again
   * (core review r3 #10: no unbounded work in the queue).
   */
  require(record: BaseRecord, v: Verified, opts: { fresh?: boolean } = {}): void {
    const fresh = opts.fresh === true;
    for (const ref of listRefs(record)) {
      this.checkSize(ref);
      const keep = wantsItems(record, ref);
      const isCoverage = isCoverageInputs(record, ref);
      const okCount = v.lists.get(ref.hash) ?? (fresh ? undefined : this.lists.get(ref.hash));
      const okItems = !keep || v.items.has(ref.hash);
      const okCoverage = !isCoverage || this.coverageOk.has(ref.hash);
      if (okCount === undefined || !okItems || !okCoverage) throw stale(`list ${ref.hash} was not verified for this request`);
      if (okCount !== ref.count) throw new LedgerError('RECORD_INVALID', `list ${ref.hash} has ${okCount} items, not ${ref.count}`);
    }
    for (const h of blobRefs(record)) this.requireBlob(h, v, opts);
    if (record.kind === 'judgment' && record.extends !== null && !v.inputs.has(record.judgment)) throw stale(`the inputs of continuation ${record.judgment} were not read for this request`);
  }

  requireBlob(hash: ContentHash, v: Verified, opts: { fresh?: boolean } = {}): void {
    if (v.blobs.has(hash) || (opts.fresh !== true && this.blobs.has(hash))) return;
    throw stale(`content ${hash} was not verified for this request`);
  }

  /** Items of a list verified for this request. */
  itemsOf(ref: ListRef, v: Verified): readonly string[] {
    const items = v.items.get(ref.hash);
    if (items === undefined) throw stale(`list ${ref.hash} was not read for this request`);
    return items;
  }
}

function stale(why: string): LedgerError {
  return new LedgerError('STALE_REQUEST', `${why}; verify and send it again`);
}

async function runLimited(jobs: ReadonlyArray<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async (): Promise<void> => {
    while (failure === null && next < jobs.length) {
      const job = jobs[next++]!;
      try {
        await job();
      } catch (e) {
        failure ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  if (failure !== null) throw failure;
}
