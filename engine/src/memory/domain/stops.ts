// Stops (design 4.1 §6.6; 4.0 6.4): `mp pm stop "<the words>"` records a stop
// with a conservative scope, linked to the maintainer's words entry it came
// from. From that commit on, within its scope, new dispatches, hand-backs
// (recorded as "arrived after the stop, not accepted"), delivery and landing
// authorizations, and retries of open landing intents are refused. Seats
// already running are the harness's processes: the answer says how many
// dispatches were in flight in the scope, so the PM can stop them through its
// harness.
//
// A stop is written with `stop: true` on its write, so it never waits behind
// the extensions' batches (§4.1). Narrowing replaces an active stop by a
// narrower one in one transaction (6.4 "再收窄"); releasing ends it. The 4.0
// stop inboxes, staging copies and resolution markers are gone: there is no
// service to reach.

import { canonicalJson } from '../../common/hash.ts';
import type { StopId } from '../../common/ids.ts';
import type { Db } from '../db.ts';
import { LedgerError } from '../errors.ts';
import type { LogRecord } from '../events.ts';
import type { WriteTx } from '../memory.ts';
import { stopInfo } from '../queries.ts';
import { checkStopRequest, scopeWithin, stopCovers, type ScopeTag, type StopRequest, type StopScope } from '../stopTypes.ts';

const WORDS_ENTRY = /^W-[1-9][0-9]{0,9}$/;

export function activeStopScopes(db: Db): StopScope[] {
  const rows = db.stmt("SELECT scope FROM stops WHERE state = 'active'").all() as Array<{ scope: string }>;
  return rows.map((r) => JSON.parse(r.scope) as StopScope);
}

/** True when an active stop covers the tag. */
export function stoppedFor(db: Db, tag: ScopeTag): boolean {
  return activeStopScopes(db).some((scope) => stopCovers(scope, tag));
}

/** STOPPED when an active stop covers the tag (the safety floor: reported before any other refusal). */
export function assertNotStopped(db: Db, tag: ScopeTag, what: string): void {
  if (stoppedFor(db, tag)) throw new LedgerError('STOPPED', `a stop restriction covers ${what}`);
}

function parse(req: unknown, what: string): StopRequest & { wordsEntry: string | null } {
  const parsed = checkStopRequest(req);
  if (parsed === null) throw new LedgerError('BAD_REQUEST', `${what} is { stop, scope: all | mission | capability, words, at, wordsEntry? }`);
  const w = (req as { wordsEntry?: unknown }).wordsEntry;
  if (w !== undefined && w !== null && (typeof w !== 'string' || !WORDS_ENTRY.test(w))) throw new LedgerError('BAD_REQUEST', 'wordsEntry names the maintainer’s words entry (W-<n>)');
  return { ...parsed, wordsEntry: (w as string | null | undefined) ?? null };
}

/** The 4.0 stop record, with the 4.1 link to the words entry (W-n) it came from. */
type StopCommitted = Extract<LogRecord, { kind: 'stop.committed' }> & { readonly wordsEntry?: string };

function stopRecord(r: StopRequest & { wordsEntry: string | null }, narrows: StopId | null): StopCommitted {
  return { kind: 'stop.committed', stop: r.stop, scope: r.scope, words: r.words, at: r.at, ...(narrows !== null ? { narrows } : {}), ...(r.wordsEntry !== null ? { wordsEntry: r.wordsEntry } : {}) };
}

function inFlightIn(db: Db, scope: StopScope): number {
  const rows = db.stmt("SELECT mission, capabilities FROM dispatches WHERE state = 'in-flight'").all() as Array<{ mission: string; capabilities: string }>;
  return rows.filter((r) => stopCovers(scope, { mission: r.mission as ScopeTag['mission'], capabilities: JSON.parse(r.capabilities) as string[] })).length;
}

/**
 * Commit a stop. The same stop id again records nothing (`committed: false`).
 * `inFlight`: dispatches in flight in the stop's scope, which the PM stops
 * through its harness (§6.6).
 */
export function commitStop(tx: WriteTx, req: StopRequest & { readonly wordsEntry?: string | null }): { committed: boolean; inFlight: number } {
  const r = parse(req, 'a stop request');
  const committed = !tx.stmt('SELECT 1 FROM stops WHERE stop = ?').get(r.stop);
  if (committed) tx.append(stopRecord(r, null));
  return { committed, inFlight: inFlightIn(tx, r.scope) };
}

export function releaseStop(tx: WriteTx, stop: StopId): { released: boolean } {
  if (!tx.stmt("SELECT 1 FROM stops WHERE stop = ? AND state = 'active'").get(stop)) return { released: false };
  tx.append({ kind: 'stop.released', stop });
  return { released: true };
}

/**
 * 6.4 "再收窄": replace an active stop by a narrower one in ONE transaction:
 * the new stop is committed (linked to the old one) and the old one released
 * (linked to the new one), so nothing in the narrower scope is unrestricted
 * at any moment. The new scope must lie within the old one and differ from
 * it. A retry after it committed returns `narrowed: false` with the same links.
 */
export function narrowStop(tx: WriteTx, input: { old: StopId; stop: StopRequest & { readonly wordsEntry?: string | null } }): { old: StopId; stop: StopId; narrowed: boolean } {
  const r = parse(input?.stop ?? null, 'the narrower stop');
  const old = input.old;
  if (typeof old !== 'string' || old === r.stop) throw new LedgerError('BAD_REQUEST', 'narrowStop names the old stop, and a new stop id');
  const prev = stopInfo(tx, old);
  const next = stopInfo(tx, r.stop);
  if (next !== null) {
    if (next.narrows === old && prev?.narrowedTo === r.stop) return { old, stop: r.stop, narrowed: false };
    throw new LedgerError('FACT_CONFLICT', `stop ${r.stop} is already committed${next.narrows !== null ? ` (narrowing ${next.narrows})` : ''}`);
  }
  if (prev === null || prev.state !== 'active') throw new LedgerError('BAD_REQUEST', `stop ${old} is not an active stop`);
  if (!scopeWithin(r.scope, prev.scope)) throw new LedgerError('BAD_REQUEST', `the new scope ${canonicalJson(r.scope)} is not within the old scope ${canonicalJson(prev.scope)}`);
  if (canonicalJson(r.scope) === canonicalJson(prev.scope)) throw new LedgerError('BAD_REQUEST', 'the new scope is the old scope');
  tx.append(stopRecord(r, old));
  tx.append({ kind: 'stop.released', stop: old, narrowedTo: r.stop });
  return { old, stop: r.stop, narrowed: true };
}
