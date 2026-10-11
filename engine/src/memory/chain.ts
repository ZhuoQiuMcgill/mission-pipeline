// The event log's hash chain (design 4.1 §3.3 step 3; §11.8). Every event
// carries the hash of the one before it; the first carries GENESIS. It is an
// integrity check of the skeleton itself, nothing more: no keys, no
// signatures. A copy of the folder whose chain is broken stops all writes, and
// the verifier names the last valid event, from which the PM may continue
// (Memory.continueFromLastValid, under the copy/move WI).
//
// The hash covers the revision, the previous hash, the event exactly as
// stored, and whether the event is the last of its write transaction (`end`),
// as one canonical JSON array, so no field can be shifted into another. The
// transaction boundaries let a recovery keep only whole transactions (§4.1: a
// write is atomic), and a log may only end at one.
//
// Revisions are contiguous from 1: a write appends after the highest revision
// and the log's AUTOINCREMENT counter (which never goes back by itself), and a
// recovery that removes events resets the counter to where it cut. So a
// removed event shows as a gap, or as a counter ahead of the last revision,
// without hashing anything (structureProblem: the cheap gate every open makes).

import { canonicalJson, sha256 } from '../common/hash.ts';
import type { Db } from './db.ts';
import { LedgerError } from './errors.ts';

export const GENESIS = '0'.repeat(64);

export interface StoredEvent {
  readonly rev: number;
  readonly kind: string;
  readonly op: string | null;
  readonly record: string;
  readonly committedAt: number;
  readonly prev: string;
  /** The last event of its write transaction (stored as 1, else 0; the stored value is what the hash covers). */
  readonly end: boolean | number;
}

export function eventHash(e: StoredEvent): string {
  return sha256(canonicalJson(['mp-event-v1', e.rev, e.prev, e.kind, e.op, e.committedAt, typeof e.end === 'boolean' ? (e.end ? 1 : 0) : e.end, e.record]));
}

export interface ChainReport {
  readonly ok: boolean;
  /** Events checked. */
  readonly events: number;
  /** The revision of the last event whose chain is intact (0: none). */
  readonly lastValid: number;
  /** The last event of the last whole transaction up to lastValid: where a recovery can cut (0: none). */
  readonly lastWhole: number;
  /** The first revision that breaks it, or null; for events removed from the end, the first missing revision. */
  readonly brokenAt: number | null;
  readonly reason: string | null;
}

export interface LogRow {
  readonly rev: number;
  readonly kind: string;
  readonly op: string | null;
  readonly record: string;
  readonly committed_at: number;
  readonly prev: string;
  readonly hash: string;
  readonly txn_end: number;
}

export const LOG_COLUMNS = 'rev, kind, op, record, committed_at, prev, hash, txn_end';

const PAGE = 5_000;

/** The log's AUTOINCREMENT counter (0 for an empty log). */
export function logCounter(db: Db): number {
  const row = db.stmt("SELECT seq FROM sqlite_sequence WHERE name = 'log'").get() as { seq: number } | undefined;
  return Number(row?.seq ?? 0);
}

export function storedHash(r: LogRow): string {
  return eventHash({ rev: Number(r.rev), kind: r.kind, op: r.op, record: r.record, committedAt: Number(r.committed_at), prev: r.prev, end: Number(r.txn_end) });
}

/** Why a row is damaged in itself (its hash, its transaction mark, its record), without looking at its neighbours; or null. */
function selfProblem(r: LogRow): string | null {
  if (Number(r.txn_end) !== 0 && Number(r.txn_end) !== 1) return `event ${r.rev} has an invalid transaction mark (${String(r.txn_end)})`;
  if (storedHash(r) !== r.hash) return `event ${r.rev} was changed after it was recorded`;
  try {
    const rec = JSON.parse(r.record) as { kind?: unknown };
    if (rec.kind !== r.kind) return `event ${r.rev} names kind ${r.kind} but holds ${String(rec.kind)}`;
  } catch {
    return `event ${r.rev} does not hold a JSON record`;
  }
  return null;
}

/** Why one row does not continue the chain from `prev` (the hash of the event before it), or null. */
export function rowProblem(r: LogRow, prev: string, expectedRev: number): string | null {
  if (Number(r.rev) !== expectedRev) return `event ${expectedRev} is missing (the next one is ${r.rev})`;
  if (r.prev !== prev) return `event ${r.rev} does not follow the event before it (an event was removed or changed before it)`;
  return selfProblem(r);
}

/** A Db that wants to know when a read found the chain broken (the Memory records it, so every write is refused). */
interface ChainWatcher {
  chainBroken?(reason: string, rev?: number | null): void;
}

/**
 * An event read for a decision (§3.3): its own hash and mark, and the link of
 * the event after it, are checked before its record is used. A damaged event
 * is never used: CHAIN_BROKEN, and the break is recorded (every write refused).
 */
export function intactRecord<T>(db: Db, r: LogRow): T {
  let problem = selfProblem(r);
  let at = Number(r.rev);
  if (problem === null) {
    const next = db.stmt('SELECT prev FROM log WHERE rev = ?').get(Number(r.rev) + 1) as { prev: string } | undefined;
    if (next !== undefined && next.prev !== r.hash) {
      problem = `event ${Number(r.rev) + 1} does not follow event ${r.rev} (an event was changed)`;
      at = Number(r.rev) + 1;
    }
  }
  if (problem !== null) {
    (db as ChainWatcher).chainBroken?.(problem, at);
    throw new LedgerError('CHAIN_BROKEN', `the event log's hash chain is broken (${problem}); a damaged event is never used, and every write is refused until the PM follows the WI on copying and moving the folder`);
  }
  return JSON.parse(r.record) as T;
}

/**
 * Walk the chain page by page, calling `each` for every intact event in order,
 * without telling anyone what it finds. Only the memory's own controlled
 * verifications use it (a recovery, the recording of a break); every other
 * caller goes through walkChain or verifyChain, which report damage.
 */
export function inspectChain(db: Db, each?: (r: LogRow) => void): ChainReport {
  const page = db.stmt(`SELECT ${LOG_COLUMNS} FROM log WHERE rev > ? ORDER BY rev LIMIT ?`);
  let prev = GENESIS;
  let after = 0;
  let lastWhole = 0;
  let events = 0;
  for (;;) {
    const rows = page.all(after, PAGE) as unknown as LogRow[];
    if (rows.length === 0) break;
    for (const r of rows) {
      const problem = rowProblem(r, prev, after + 1);
      if (problem !== null) return { ok: false, events, lastValid: after, lastWhole, brokenAt: Math.min(Number(r.rev), after + 1), reason: problem };
      each?.(r);
      prev = r.hash;
      after = Number(r.rev);
      if (Number(r.txn_end) === 1) lastWhole = after;
      events++;
    }
  }
  const counter = logCounter(db);
  if (counter > after) return { ok: false, events, lastValid: after, lastWhole, brokenAt: after + 1, reason: `events after ${after} were removed (the log's counter is at ${counter})` };
  if (lastWhole !== after) return { ok: false, events, lastValid: after, lastWhole, brokenAt: lastWhole + 1, reason: `the log ends inside a write transaction (after event ${lastWhole}): its last events were removed` };
  return { ok: true, events, lastValid: after, lastWhole, brokenAt: null, reason: null };
}

/**
 * Walk the chain page by page, calling `each` for every intact event in order
 * (a rebuild replays them as it goes). Damage is reported to the memory (§3.3:
 * latched, marked, and the write in progress cannot commit, maintenance
 * included). Read it in one transaction when the caller needs a snapshot.
 */
export function walkChain(db: Db, each?: (r: LogRow) => void): ChainReport {
  const report = inspectChain(db, each);
  if (!report.ok) (db as ChainWatcher).chainBroken?.(report.reason ?? 'broken chain', report.brokenAt);
  return report;
}

/** Verify the whole chain; damage is reported to the memory (walkChain). */
export function verifyChain(db: Db): ChainReport {
  return walkChain(db);
}

/**
 * The cheap structural gate (no hashing): revisions contiguous from 1, the
 * counter at the last one. Catches events removed or inserted anywhere; an
 * event changed in place is caught by the full verification every rebuild,
 * truncation and move makes before it trusts the log.
 */
export function structureProblem(db: Db): string | null {
  const r = db.stmt('SELECT COUNT(*) AS n, COALESCE(MIN(rev), 0) AS lo, COALESCE(MAX(rev), 0) AS hi FROM log').get() as { n: number; lo: number; hi: number };
  const n = Number(r.n);
  const hi = Number(r.hi);
  if (n > 0 && (Number(r.lo) !== 1 || hi !== n)) return `the log's revisions are not contiguous (${n} events between ${r.lo} and ${hi}): events were removed or inserted`;
  const counter = logCounter(db);
  if (counter > hi) return `events after ${hi} were removed (the log's counter is at ${counter})`;
  return null;
}

/**
 * The check every write makes before it appends (§3.3): the last event still
 * hashes to what it recorded, ends its transaction, and nothing was removed
 * after it. Returns the last event's hash (GENESIS for an empty log) and
 * revision, or the problem.
 */
export function chainTail(db: Db): { readonly ok: true; readonly rev: number; readonly hash: string } | { readonly ok: false; readonly rev: number; readonly reason: string } {
  const r = db.stmt(`SELECT ${LOG_COLUMNS} FROM log ORDER BY rev DESC LIMIT 1`).get() as unknown as LogRow | undefined;
  const counter = logCounter(db);
  if (r === undefined) return counter === 0 ? { ok: true, rev: 0, hash: GENESIS } : { ok: false, rev: 0, reason: `the log is empty but its counter is at ${counter}` };
  const problem = selfProblem(r);
  if (problem !== null) return { ok: false, rev: Number(r.rev), reason: problem };
  if (counter > Number(r.rev)) return { ok: false, rev: Number(r.rev), reason: `events after ${r.rev} were removed (the log's counter is at ${counter})` };
  if (Number(r.txn_end) !== 1) return { ok: false, rev: Number(r.rev), reason: `the log ends inside a write transaction (event ${r.rev}): its last events were removed` };
  return { ok: true, rev: Number(r.rev), hash: r.hash };
}
