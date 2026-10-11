// Data the program computes on (design 4.1 §3.2 item 11): lists of the proof
// model, flow-event bodies, structured hand-back results, task specs, notice
// bodies, intent details. In 4.0 these were content-store files; in 4.1 they are
// rows of the skeleton's `data` table, content-addressed by the sha256 of their
// bytes, so a record names them by hash exactly as before and none of them is
// ever read back from a Markdown file.
//
// DataStore keeps the 4.0 ContentStore API (put, get, has, putList, getList),
// so the existing call sites move over unchanged. A value is written in the
// caller's transaction: inside a write it is inserted at once; outside one it is
// staged in this process and inserted at the start of the next write, in the
// same transaction as the record that names it. A value no record names is
// harmless (content-addressed, never read by anything).
//
// Also here, moved from ledger/verify.ts: which content a record refers to, and
// the in-transaction check that all of it exists, hashes to its name, and (for
// lists) is a JSON list of strings of the declared length.

import { sha256 } from '../common/hash.ts';
import type { ContentHash } from '../common/ids.ts';
import { continuationInputsHash, type BaseRecord, type ListRef } from '../common/records.ts';
import type { Db } from './db.ts';
import { LedgerError } from './errors.ts';

export const MAX_LIST_ITEMS = 250_000;
export const MAX_LIST_BYTES = 64 * 1024 * 1024;
/** One value, in bytes. */
export const MAX_DATA_BYTES = 64 * 1024 * 1024;

export interface DataHost {
  readonly db: Db;
  /** True while this connection is inside a write transaction. */
  inWrite(): boolean;
}

function bytesOf(data: string | Uint8Array): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export class DataStore {
  private readonly host: DataHost;
  /** Values put outside a write, by hash: inserted by the next write. */
  private readonly staged = new Map<string, Buffer>();

  constructor(host: DataHost) {
    this.host = host;
  }

  put(data: string | Uint8Array): ContentHash {
    const buf = bytesOf(data);
    if (buf.length > MAX_DATA_BYTES) throw new LedgerError('TOO_LARGE', `a data value is ${buf.length} bytes; the limit is ${MAX_DATA_BYTES}`);
    const hash = sha256(buf);
    if (this.host.inWrite()) this.insert(hash, buf);
    else if (!this.staged.has(hash) && !this.stored(hash)) this.staged.set(hash, Buffer.from(buf));
    return hash;
  }

  /** put() under the 4.0 ContentStore's asynchronous name (the call sites that awaited it move over unchanged). */
  putAsync(data: string | Uint8Array): Promise<ContentHash> {
    return Promise.resolve(this.put(data));
  }

  private stored(hash: string): boolean {
    return Boolean(this.host.db.stmt('SELECT 1 FROM data WHERE hash = ?').get(hash));
  }

  private insert(hash: string, buf: Buffer): void {
    this.host.db.stmt('INSERT OR IGNORE INTO data (hash, body, bytes) VALUES (?, ?, ?)').run(hash, buf, buf.length);
  }

  has(hash: string): boolean {
    return this.staged.has(hash) || this.stored(hash);
  }

  /** The value's bytes, checked against its hash. Missing or damaged: CONTENT_MISSING. */
  get(hash: string): Buffer {
    const staged = this.staged.get(hash);
    if (staged !== undefined) return Buffer.from(staged);
    const row = this.host.db.stmt('SELECT body FROM data WHERE hash = ?').get(hash) as { body: Uint8Array } | undefined;
    if (row === undefined) throw new LedgerError('CONTENT_MISSING', `data ${hash} is not in the memory`);
    const buf = Buffer.from(row.body);
    if (sha256(buf) !== hash) throw new LedgerError('CONTENT_MISSING', `data ${hash} is damaged: its bytes do not hash to its name`);
    return buf;
  }

  text(hash: string): string {
    return this.get(hash).toString('utf8');
  }

  /** Store an id list (dependency lists, evidence lists...), as the 4.0 content store did. */
  putList(items: readonly string[]): ListRef {
    return { hash: this.put(JSON.stringify(items)), count: items.length };
  }

  getList(ref: ListRef): string[] {
    const items = parseList(this.get(ref.hash), ref.hash);
    if (items.length !== ref.count) throw new LedgerError('RECORD_INVALID', `list ${ref.hash} has ${items.length} items, not ${ref.count}`);
    return items;
  }

  /** Insert every staged value (the start of a write); returns their hashes. */
  flushStaged(): string[] {
    const out: string[] = [];
    for (const [hash, buf] of this.staged) {
      this.insert(hash, buf);
      out.push(hash);
    }
    return out;
  }

  /** After the write committed: the flushed values are stored. */
  dropStaged(hashes: readonly string[]): void {
    for (const h of hashes) this.staged.delete(h);
  }
}

function parseList(buf: Buffer, hash: string): string[] {
  if (buf.length > MAX_LIST_BYTES) throw new LedgerError('TOO_LARGE', `list ${hash} is ${buf.length} bytes; the limit is ${MAX_LIST_BYTES}`);
  let items: unknown;
  try {
    items = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new LedgerError('RECORD_INVALID', `list ${hash} is not a JSON list of strings: it does not parse`);
  }
  if (!Array.isArray(items) || !items.every((x) => typeof x === 'string')) throw new LedgerError('RECORD_INVALID', `list ${hash} is not a JSON list of strings`);
  if (items.length > MAX_LIST_ITEMS) throw new LedgerError('TOO_LARGE', `list ${hash} has more than ${MAX_LIST_ITEMS} items`);
  return items as string[];
}

// ---------------------------------------------------------------- what a record refers to (moved from ledger/verify.ts)

/** Every ListRef found at the top level of a record. */
export function listRefs(record: BaseRecord): ListRef[] {
  const out: ListRef[] = [];
  for (const v of Object.values(record)) {
    if (v && typeof v === 'object' && 'hash' in v && 'count' in v) out.push(v as ListRef);
  }
  return out;
}

/**
 * The plain data values a record refers to (other than lists). Not here:
 * `object.version.source.transform`, the hash of a transform description (an
 * identity the delivery computes, not stored data, 6.6).
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
    case 'flow.event':
      return [record.body];
    case 'alert':
      return [record.body];
    default:
      return [];
  }
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

/**
 * Inside the write: every value the record refers to exists and hashes to its
 * name; every list is a JSON list of strings with the declared count (at most
 * MAX_LIST_ITEMS, refused before it is read); regression inputs are well formed.
 * For a continuation judgment, returns the identity of its four input lists
 * (continuationInputsHash), which must equal the check recorded for it.
 */
export function requireContent(data: DataStore, record: BaseRecord): { readonly inputs: string | null } {
  const lists = new Map<string, string[]>();
  for (const ref of listRefs(record)) {
    if (!Number.isSafeInteger(ref.count) || ref.count > MAX_LIST_ITEMS) throw new LedgerError('TOO_LARGE', `list ${ref.hash} has ${ref.count} items; the limit is ${MAX_LIST_ITEMS} per list`);
    const items = data.getList(ref);
    lists.set(ref.hash, items);
    if (record.kind === 'issue.coverage' && ref === record.inputs) checkCoverageInputs(items);
  }
  for (const h of blobRefs(record)) data.get(h);
  if (record.kind !== 'judgment' || record.extends === null) return { inputs: null };
  const items = (ref: ListRef): readonly string[] => lists.get(ref.hash) ?? [];
  return { inputs: continuationInputsHash({ evidence: items(record.evidence), bases: items(record.bases), constraints: items(record.constraints), reliesOn: items(record.reliesOn) }) };
}
