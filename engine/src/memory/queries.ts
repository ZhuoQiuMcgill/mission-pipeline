// Read-only queries on the skeleton's state tables (design 4.1 §3.2, §8). Each
// one is a bounded, indexed read; none touches derived state (labels: A2's
// tables). They take any `Db`: the Memory itself for a single read, a read
// transaction for a consistent snapshot, or a write transaction for the checks
// made inside it. A query that returns an event's record checks the event
// intact first (chain.ts intactRecord): a damaged event is never used for a
// decision.
//
// Moved from ledger/queries.ts (the queries on tables 4.1 keeps as they were):
// loops, stops, mission blocks, user words, deliveries, flow events, records by
// kind, facts, missions, notices, PM actions, closing snapshots. New in 4.1: the
// task queue with dispatches, intents without launches, dispatches, leases,
// leaves, words entries, PM commands, cursors, landings.

import { revision, type ContentHash, type MissionId, type Revision, type StopId } from '../common/ids.ts';
import { ENV_RETRY_PER_CLASS, LOOP_CAPS, type BaseRecord, type Committed, type IntentDelivery, type LoopKind, type MissionBlockRecord } from '../common/records.ts';
import { intactRecord, LOG_COLUMNS, type LogRow } from './chain.ts';
import type { Db } from './db.ts';
import { LedgerError } from './errors.ts';
import type { DispatchHandbackOutcome, Filler } from './events.ts';
import type { ScopeTag, StopScope } from './stopTypes.ts';

/** The log's columns read through the alias `l` (joins). */
const LOG_COLUMNS_L = LOG_COLUMNS.split(', ').map((c) => `l.${c} AS ${c}`).join(', ');

// ---------------------------------------------------------------- loops (6.5)

export type LoopExhaustion = 'cap' | 'class-cap' | 'no-progress';

export interface LoopState {
  readonly attempts: number;
  readonly byClass: Record<string, number>;
  /** Consecutive repeats of the last failure signature (1: the last two were the same). */
  readonly repeats: number;
  /** Secretary grants on this loop. */
  readonly secretaryGrants: number;
  /** Extra attempts granted on this loop, by the Secretary and the user. */
  readonly extra: number;
  /** The loop's attempt count when its last grant was made, or null. */
  readonly attemptsAtLastGrant: number | null;
  /** The Secretary already used its one grant on this lineage, on any loop (6.5). */
  readonly secretaryGrantUsed: boolean;
  /** LOOP_CAPS[loop]: attempts allowed before grants. */
  readonly cap: number;
  /** cap + extra. */
  readonly allowed: number;
  /** Persistent: from the counters, and a no-progress exhaustion stays until a grant. */
  readonly exhausted: boolean;
  readonly reason: LoopExhaustion | null;
}

export function readLoopState(s: Db, lineage: string, loop: LoopKind, failureClass: string | null = null): LoopState {
  const row = s.stmt('SELECT attempts, by_class, repeats, secretary_grants, extra, attempts_at_grant, no_progress_at FROM loops WHERE lineage = ? AND loop = ?').get(lineage, loop) as
    | { attempts: number; by_class: string; repeats: number; secretary_grants: number; extra: number; attempts_at_grant: number | null; no_progress_at: number | null }
    | undefined;
  const used = s.stmt('SELECT COALESCE(SUM(secretary_grants), 0) AS n FROM loops WHERE lineage = ?').get(lineage) as { n: number };
  const attempts = Number(row?.attempts ?? 0);
  const extra = Number(row?.extra ?? 0);
  const byClass = row ? (JSON.parse(row.by_class) as Record<string, number>) : {};
  const cap = LOOP_CAPS[loop] ?? 0;
  const allowed = cap + extra;
  let reason: LoopExhaustion | null = null;
  if (attempts >= allowed) reason = 'cap';
  else if (loop === 'env-retry' && failureClass !== null && (Object.hasOwn(byClass, failureClass) ? Number(byClass[failureClass]) : 0) >= ENV_RETRY_PER_CLASS + extra) reason = 'class-cap';
  else if (row?.no_progress_at !== null && row?.no_progress_at !== undefined) reason = 'no-progress';
  return {
    attempts,
    byClass,
    repeats: Number(row?.repeats ?? 0),
    secretaryGrants: Number(row?.secretary_grants ?? 0),
    extra,
    attemptsAtLastGrant: row?.attempts_at_grant ?? null,
    secretaryGrantUsed: Number(used.n) >= 1,
    cap,
    allowed,
    exhausted: reason !== null,
    reason,
  };
}

// ---------------------------------------------------------------- stops (6.4; 4.1 §6.6)

export interface ActiveStop {
  readonly stop: StopId;
  readonly scope: StopScope;
  readonly words: string;
  readonly requestedAt: number;
  readonly committedAt: number;
  /** The stop this one narrowed (6.4 "再收窄"), released in the same transaction; null otherwise. */
  readonly narrows: StopId | null;
  /** 4.1 §6.6: the maintainer's words entry (W-n) the stop came from, when recorded. */
  readonly wordsEntry: string | null;
}

type StopRow = { stop: string; state: 'active' | 'released'; scope: string; words: string; requested_at: number; committed_at: number; narrows: string | null; narrowed_to: string | null; words_entry?: string | null };

/** Every active stop, in commit order (6.4: reload all active restrictions after any restart). */
export function activeStops(s: Db): ActiveStop[] {
  const rows = s.stmt("SELECT * FROM stops WHERE state = 'active' ORDER BY committed_at, rowid").all() as unknown as StopRow[];
  return rows.map((r) => ({
    stop: r.stop as StopId,
    scope: JSON.parse(r.scope) as StopScope,
    words: r.words,
    requestedAt: Number(r.requested_at),
    committedAt: Number(r.committed_at),
    narrows: (r.narrows ?? null) as StopId | null,
    wordsEntry: r.words_entry ?? null,
  }));
}

/** A committed stop with its narrowing links (6.4), or null. */
export function stopInfo(
  s: Db,
  stop: StopId,
): { stop: StopId; state: 'active' | 'released'; scope: StopScope; words: string; narrows: StopId | null; narrowedTo: StopId | null; wordsEntry: string | null } | null {
  const r = s.stmt('SELECT * FROM stops WHERE stop = ?').get(stop) as unknown as StopRow | undefined;
  return r
    ? {
        stop: r.stop as StopId,
        state: r.state,
        scope: JSON.parse(r.scope) as StopScope,
        words: r.words,
        narrows: (r.narrows ?? null) as StopId | null,
        narrowedTo: (r.narrowed_to ?? null) as StopId | null,
        wordsEntry: r.words_entry ?? null,
      }
    : null;
}

/** A stop's state: active, released, or not committed (null). */
export function stopState(s: Db, stop: StopId): 'active' | 'released' | null {
  const r = s.stmt('SELECT state FROM stops WHERE stop = ?').get(stop) as { state: 'active' | 'released' } | undefined;
  return r?.state ?? null;
}

// ---------------------------------------------------------------- missions (6.5)

/** The latest mission.block record of each mission (or of one). */
export function missionBlocks(s: Db, mission?: MissionId): Array<{ mission: MissionId; revision: Revision; record: MissionBlockRecord }> {
  const rows = (
    mission === undefined ? s.stmt('SELECT mission, rev, record FROM mission_blocks ORDER BY mission').all() : s.stmt('SELECT mission, rev, record FROM mission_blocks WHERE mission = ?').all(mission)
  ) as Array<{ mission: string; rev: number; record: string }>;
  return rows.map((r) => ({ mission: r.mission as MissionId, revision: Number(r.rev) as Revision, record: JSON.parse(r.record) as MissionBlockRecord }));
}

// ---------------------------------------------------------------- user words (10.1 item 6; 4.1 §6.1)

export interface BookedUserWords {
  readonly revision: Revision;
  readonly message: string;
  readonly session: string;
  readonly at: number;
  readonly text: ContentHash;
  readonly excerpt: string;
}

/** The latest booked user messages, newest first (indexed by kind). */
export function latestUserWords(s: Db, limit = 1, session?: string): BookedUserWords[] {
  const n = Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : 1, 1000));
  const out: BookedUserWords[] = [];
  // Newest first; a session filter reads on until enough match (bounded by the page size).
  for (let before = Number.MAX_SAFE_INTEGER; out.length < n; ) {
    const rows = s.stmt(`SELECT ${LOG_COLUMNS} FROM log WHERE kind = 'user.words' AND rev < ? ORDER BY rev DESC LIMIT ?`).all(before, 200) as unknown as LogRow[];
    if (rows.length === 0) break;
    for (const r of rows) {
      const rec = intactRecord<{ message: string; session: string; at: number; text: ContentHash; excerpt: string }>(s, r);
      if (session === undefined || rec.session === session) out.push({ revision: Number(r.rev) as Revision, message: rec.message, session: rec.session, at: rec.at, text: rec.text, excerpt: rec.excerpt });
      if (out.length >= n) break;
    }
    before = Number(rows[rows.length - 1]!.rev);
  }
  return out;
}

/** One words entry (W-n): the maintainer's message as the PM recorded it (`mp pm say`), its text in the data table, its leaf. */
export interface WordsEntry {
  readonly words: string;
  readonly message: string;
  readonly session: string;
  readonly at: number;
  readonly text: ContentHash;
  readonly leaf: string | null;
  readonly revision: Revision;
}

type WordsRow = { words: string; message: string; session: string; at: number; text: string; leaf: string | null; rev: number };

function wordsOf(r: WordsRow): WordsEntry {
  return { words: r.words, message: r.message, session: r.session, at: Number(r.at), text: r.text as ContentHash, leaf: r.leaf, revision: revision(Number(r.rev)) };
}

/** A words entry by its id (W-n). */
export function wordsEntry(s: Db, words: string): WordsEntry | null {
  const r = s.stmt('SELECT * FROM words WHERE words = ?').get(words) as unknown as WordsRow | undefined;
  return r ? wordsOf(r) : null;
}

/** The words entry of one message (the hook's or the PM's message id). */
export function wordsOfMessage(s: Db, message: string): WordsEntry | null {
  const r = s.stmt('SELECT * FROM words WHERE message = ?').get(message) as unknown as WordsRow | undefined;
  return r ? wordsOf(r) : null;
}

/** Words entries in order, after a revision, at most `limit`. */
export function wordsEntries(s: Db, q: { after?: number; limit?: number } = {}): WordsEntry[] {
  const rows = s.stmt('SELECT * FROM words WHERE rev > ? ORDER BY rev LIMIT ?').all(afterRev(q.after), pageSize(q.limit)) as unknown as WordsRow[];
  return rows.map(wordsOf);
}

// ---------------------------------------------------------------- the task queue (4.1 §5.1)

export interface QueuedTask {
  readonly task: string;
  readonly lineage: string;
  readonly mission: MissionId;
  /** The task's spec, in the data table. */
  readonly card: ContentHash;
  readonly queuedRevision: Revision;
  readonly queuedAt: number;
}

export interface TaskInfo extends QueuedTask {
  readonly state: 'queued' | 'dispatched' | 'cancelled' | 'superseded';
  /** The dispatch that claimed it, while it is dispatched. */
  readonly dispatch: string | null;
  readonly by: string | null;
  readonly updatedAt: number;
}

interface TaskRow {
  task: string;
  lineage: string;
  mission: string;
  card: string;
  state: TaskInfo['state'];
  queued_rev: number;
  queued_at: number;
  dispatch: string | null;
  by_task: string | null;
  updated_at: number;
}

function taskOf(r: TaskRow): TaskInfo {
  return {
    task: r.task,
    lineage: r.lineage,
    mission: r.mission as MissionId,
    card: r.card as ContentHash,
    queuedRevision: revision(Number(r.queued_rev)),
    queuedAt: Number(r.queued_at),
    state: r.state,
    dispatch: r.dispatch,
    by: r.by_task,
    updatedAt: Number(r.updated_at),
  };
}

/** The current queue, in the order tasks were queued (`mp pm next` applies the process's priorities). */
export function taskQueue(s: Db, mission?: MissionId): QueuedTask[] {
  const rows = (
    mission === undefined
      ? s.stmt("SELECT * FROM tasks WHERE state = 'queued' ORDER BY queued_rev").all()
      : s.stmt("SELECT * FROM tasks WHERE state = 'queued' AND mission = ? ORDER BY queued_rev").all(mission)
  ) as unknown as TaskRow[];
  return rows.map((r) => {
    const t = taskOf(r);
    return { task: t.task, lineage: t.lineage, mission: t.mission, card: t.card, queuedRevision: t.queuedRevision, queuedAt: t.queuedAt };
  });
}

export function taskInfo(s: Db, task: string): TaskInfo | null {
  const r = s.stmt('SELECT * FROM tasks WHERE task = ?').get(task) as unknown as TaskRow | undefined;
  return r ? taskOf(r) : null;
}

// ---------------------------------------------------------------- dispatches (4.1 §5)

export interface DispatchInfo {
  readonly dispatch: string;
  readonly task: string;
  readonly seat: string;
  readonly mission: MissionId;
  readonly lineage: string;
  readonly tag: ScopeTag;
  readonly state: 'in-flight' | 'handed-back' | 'released';
  readonly released: 'ended' | 'abandoned' | null;
  readonly handback: DispatchHandbackOutcome | null;
  /** The payload hash of its one hand-back. */
  readonly handbackHash: string | null;
  /** The structured hand-back result, in the data table. */
  readonly result: ContentHash | null;
  /** Who filled it, from the PM's dispatch command; and from the hand-back, when the seat named itself. Information only. */
  readonly filler: Filler | null;
  readonly handbackFiller: Filler | null;
  /** Its worktree, relative to the memory folder. */
  readonly worktree: string | null;
  readonly cardLeaf: string | null;
  readonly reportLeaf: string | null;
  readonly claimedRevision: Revision;
  readonly createdAt: number;
  readonly updatedAt: number;
}

type DispatchRow = {
  dispatch: string;
  task: string;
  seat: string;
  mission: string;
  lineage: string;
  capabilities: string;
  state: DispatchInfo['state'];
  released: 'ended' | 'abandoned' | null;
  handback: DispatchHandbackOutcome | null;
  handback_hash: string | null;
  result: string | null;
  filler_harness: string | null;
  filler_model: string | null;
  handback_harness: string | null;
  handback_model: string | null;
  worktree: string | null;
  card_leaf: string | null;
  report_leaf: string | null;
  claimed_rev: number;
  created_at: number;
  updated_at: number;
};

function dispatchOf(r: DispatchRow): DispatchInfo {
  return {
    dispatch: r.dispatch,
    task: r.task,
    seat: r.seat,
    mission: r.mission as MissionId,
    lineage: r.lineage,
    tag: { mission: r.mission as MissionId, capabilities: JSON.parse(r.capabilities) as string[] },
    state: r.state,
    released: r.released,
    handback: r.handback,
    handbackHash: r.handback_hash,
    result: r.result as ContentHash | null,
    filler: r.filler_harness === null ? null : { harness: r.filler_harness, model: r.filler_model },
    handbackFiller: r.handback_harness === null ? null : { harness: r.handback_harness, model: r.handback_model },
    worktree: r.worktree,
    cardLeaf: r.card_leaf,
    reportLeaf: r.report_leaf,
    claimedRevision: revision(Number(r.claimed_rev)),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function dispatchInfo(s: Db, dispatch: string): DispatchInfo | null {
  const r = s.stmt('SELECT * FROM dispatches WHERE dispatch = ?').get(dispatch) as unknown as DispatchRow | undefined;
  return r ? dispatchOf(r) : null;
}

/**
 * Dispatches in claim order: by state (in flight: §5.1 "dispatches still in
 * flight", with their age for §5.4), of one task, or of one mission.
 */
export function listDispatches(s: Db, q: { state?: DispatchInfo['state']; task?: string; mission?: MissionId; after?: number; limit?: number } = {}): DispatchInfo[] {
  const where = ['claimed_rev > ?'];
  const args: Array<string | number> = [afterRev(q.after)];
  if (q.state !== undefined) {
    where.push('state = ?');
    args.push(q.state);
  }
  if (q.task !== undefined) {
    where.push('task = ?');
    args.push(q.task);
  }
  if (q.mission !== undefined) {
    where.push('mission = ?');
    args.push(q.mission);
  }
  const rows = s.stmt(`SELECT * FROM dispatches WHERE ${where.join(' AND ')} ORDER BY claimed_rev LIMIT ?`).all(...args, pageSize(q.limit)) as unknown as DispatchRow[];
  return rows.map(dispatchOf);
}

/** Exclusive resources held, with the dispatch holding each (§6.2); of one dispatch when given. */
export function leases(s: Db, dispatch?: string): Array<{ resource: string; dispatch: string; acquiredAt: number }> {
  const rows = (
    dispatch === undefined ? s.stmt('SELECT resource, dispatch, acquired_at FROM leases ORDER BY resource').all() : s.stmt('SELECT resource, dispatch, acquired_at FROM leases WHERE dispatch = ? ORDER BY resource').all(dispatch)
  ) as Array<{ resource: string; dispatch: string; acquired_at: number }>;
  return rows.map((r) => ({ resource: r.resource, dispatch: r.dispatch, acquiredAt: Number(r.acquired_at) }));
}

// ---------------------------------------------------------------- external actions (landings, delivery refs: 4.1 §6.7)

export interface IntentInfo {
  readonly intent: string;
  readonly op: string;
  readonly state: 'authorized' | 'done' | 'failed';
  readonly kind: string;
  readonly domain: string;
  readonly tag: ScopeTag;
  /** The action's details, in the data table. */
  readonly details: ContentHash;
  /** For a landing or delivery-ref intent: the delivery checked at authorization; otherwise null. */
  readonly delivery: IntentDelivery | null;
  readonly updatedAt: number;
}

type IntentRow = { intent: string; op: string; state: IntentInfo['state']; kind: string; domain: string; mission: string; capabilities: string; details: string; delivery: string | null; updated_at: number };

function intentOf(r: IntentRow): IntentInfo {
  return {
    intent: r.intent,
    op: r.op,
    state: r.state,
    kind: r.kind,
    domain: r.domain,
    tag: { mission: r.mission as MissionId, capabilities: JSON.parse(r.capabilities) as string[] },
    details: r.details as ContentHash,
    delivery: r.delivery ? (JSON.parse(r.delivery) as IntentDelivery) : null,
    updatedAt: Number(r.updated_at),
  };
}

export function intentInfo(s: Db, intent: string): IntentInfo | null {
  const r = s.stmt('SELECT * FROM intents WHERE intent = ?').get(intent) as unknown as IntentRow | undefined;
  return r ? intentOf(r) : null;
}

/** External actions authorized and not settled (a landing intent left without a result: §6.7 recovery), oldest first. */
export function openIntents(s: Db): IntentInfo[] {
  const rows = s.stmt("SELECT * FROM intents WHERE state = 'authorized' ORDER BY updated_at, intent").all() as unknown as IntentRow[];
  return rows.map(intentOf);
}

export interface LandingState {
  readonly landing: string;
  readonly intent: string | null;
  readonly phase: string;
  /** The phase's facts, in the data table. */
  readonly data: ContentHash;
  readonly updatedAt: number;
}

export function landingState(s: Db, landing: string): LandingState | null {
  const r = s.stmt('SELECT landing, intent, phase, data, updated_at FROM landings WHERE landing = ?').get(landing) as
    | { landing: string; intent: string | null; phase: string; data: string; updated_at: number }
    | undefined;
  return r ? { landing: r.landing, intent: r.intent, phase: r.phase, data: r.data as ContentHash, updatedAt: Number(r.updated_at) } : null;
}

/** Landings that started and have not ended, oldest first. */
export function unfinishedLandings(s: Db): LandingState[] {
  const rows = s.stmt("SELECT landing, intent, phase, data, updated_at FROM landings WHERE phase NOT IN ('done', 'refused') ORDER BY updated_at").all() as Array<{
    landing: string;
    intent: string | null;
    phase: string;
    data: string;
    updated_at: number;
  }>;
  return rows.map((r) => ({ landing: r.landing, intent: r.intent, phase: r.phase, data: r.data as ContentHash, updatedAt: Number(r.updated_at) }));
}

// ---------------------------------------------------------------- deliveries (6.6 steps 6-8; git review r1 #11)

/**
 * One delivery of a mission. `creating`: its ref creation was authorized, the
 * record not yet made; `recorded`: step 8 is done; `withdrawn`: the user withdrew
 * it (never current again). `seq` orders a mission's deliveries by their first
 * appearance in the log (the first ref authorization, or the record when there
 * was none): a later one supersedes an earlier one.
 */
export interface DeliveryInfo {
  readonly mission: MissionId;
  readonly delivery: string;
  readonly state: 'creating' | 'recorded' | 'withdrawn';
  readonly commit: string;
  readonly base: string;
  readonly ref: string;
  readonly target: string | null;
  readonly manifest: ContentHash | null;
  readonly seq: number;
  /** The revision of its delivery.recorded, or null while it is not recorded. */
  readonly recordedRev: Revision | null;
  readonly withdrawnReason: string | null;
  /** The bound transform description (7.1), when the delivery side sent it. */
  readonly description: ContentHash | null;
}

interface DeliveryRow {
  mission: string;
  delivery: string;
  state: DeliveryInfo['state'];
  commit_id: string;
  base: string;
  ref: string;
  target: string | null;
  manifest: string | null;
  seq: number;
  recorded_rev: number | null;
  withdrawn_reason: string | null;
  description: string | null;
}

function deliveryOf(r: DeliveryRow): DeliveryInfo {
  return {
    mission: r.mission as MissionId,
    delivery: r.delivery,
    state: r.state,
    commit: r.commit_id,
    base: r.base,
    ref: r.ref,
    target: r.target,
    manifest: r.manifest as ContentHash | null,
    seq: Number(r.seq),
    recordedRev: r.recorded_rev === null ? null : revision(Number(r.recorded_rev)),
    withdrawnReason: r.withdrawn_reason,
    description: (r.description ?? null) as ContentHash | null,
  };
}

export function deliveryInfo(s: Db, mission: MissionId, delivery: string): DeliveryInfo | null {
  const r = s.stmt('SELECT * FROM deliveries WHERE mission = ? AND delivery = ?').get(mission, delivery) as unknown as DeliveryRow | undefined;
  return r ? deliveryOf(r) : null;
}

/**
 * The mission's current delivery (6.6 授权): the latest RECORDED one in the
 * mission's order. A landing may proceed only for it, and only while its state
 * is `recorded` (a withdrawn latest delivery leaves the mission with no current
 * delivery: the earlier ones stay superseded).
 */
export function currentDelivery(s: Db, mission: MissionId): DeliveryInfo | null {
  const r = s.stmt('SELECT * FROM deliveries WHERE mission = ? AND recorded_rev IS NOT NULL ORDER BY seq DESC LIMIT 1').get(mission) as unknown as DeliveryRow | undefined;
  return r ? deliveryOf(r) : null;
}

/** A later delivery of the mission than `seq` (any state), if one exists. */
export function laterDelivery(s: Db, mission: MissionId, delivery: string, seq: number): DeliveryInfo | null {
  const r = s.stmt('SELECT * FROM deliveries WHERE mission = ? AND delivery <> ? AND seq > ? ORDER BY seq DESC LIMIT 1').get(mission, delivery, seq) as unknown as DeliveryRow | undefined;
  return r ? deliveryOf(r) : null;
}

// ---------------------------------------------------------------- flow events and indexed reads (the flows' ports)

/** One page holds at most this many rows; a caller pages with `after` = the last revision it got. */
export const PAGE_DEFAULT = 1000;
export const PAGE_MAX = 10_000;
export const PAGE_MAX_BYTES = 8 * 1024 * 1024;

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return PAGE_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new LedgerError('BAD_REQUEST', `limit is 1 to ${PAGE_MAX}`);
  return limit;
}

function afterRev(after: number | undefined): number {
  if (after === undefined) return 0;
  if (!Number.isSafeInteger(after) || after < 0) throw new LedgerError('BAD_REQUEST', 'after is a revision (a non-negative integer)');
  return after;
}

export interface FlowEventRow {
  readonly revision: Revision;
  readonly mission: MissionId;
  readonly line: string;
  readonly event: string;
  readonly key: string;
  /** The body's hash in the data table. */
  readonly body: ContentHash;
}

/** Whether one flow event (its identity: mission, line, event, key) is committed. */
export function flowEventExists(s: Db, q: { readonly mission: string; readonly line: string; readonly event: string; readonly key: string }): boolean {
  return s.stmt('SELECT 1 FROM flow_events WHERE mission = ? AND line = ? AND event = ? AND key = ?').get(q.mission, q.line, q.event, q.key) !== undefined;
}

/**
 * A mission's flow events in revision order, optionally one line and/or one
 * event type, after a revision; at most `limit` (default 1000, at most 10,000)
 * per page.
 */
export function flowEvents(s: Db, q: { mission: MissionId; line?: string; event?: string; after?: number; limit?: number }): FlowEventRow[] {
  if (typeof q.mission !== 'string') throw new LedgerError('BAD_REQUEST', 'flowEvents names its mission');
  const after = afterRev(q.after);
  const limit = pageSize(q.limit);
  const where = ['mission = ?', 'revision > ?'];
  const args: Array<string | number> = [q.mission, after];
  if (q.line !== undefined) {
    where.push('line = ?');
    args.push(q.line);
  }
  if (q.event !== undefined) {
    where.push('event = ?');
    args.push(q.event);
  }
  const rows = s.stmt(`SELECT revision, mission, line, event, key, body FROM flow_events WHERE ${where.join(' AND ')} ORDER BY revision LIMIT ?`).all(...args, limit) as Array<{
    revision: number;
    mission: string;
    line: string;
    event: string;
    key: string;
    body: string;
  }>;
  return rows.map((r) => ({ revision: revision(Number(r.revision)), mission: r.mission as MissionId, line: r.line, event: r.event, key: r.key, body: r.body as ContentHash }));
}

/** Missions that have flow events. */
export function flowMissions(s: Db): MissionId[] {
  return (s.stmt('SELECT DISTINCT mission FROM flow_events ORDER BY mission').all() as Array<{ mission: string }>).map((r) => r.mission as MissionId);
}

/**
 * Committed records of the given kinds in revision order, after a revision, at
 * most `limit` (and about 8 MiB) per page: one indexed read per kind (log by kind and revision),
 * merged. With `mission`, only records that name that mission (a top-level
 * `mission`, or an operation's scope); kinds that carry no mission (judgment,
 * issue, ...) then return nothing.
 */
export function recordsByKind(s: Db, q: { kinds: readonly string[]; mission?: MissionId; after?: number; limit?: number }): Committed[] {
  if (!Array.isArray(q.kinds) || q.kinds.length === 0 || q.kinds.length > 64 || !q.kinds.every((k) => typeof k === 'string' && k.length > 0)) {
    throw new LedgerError('BAD_REQUEST', 'kinds is a list of 1 to 64 record kinds');
  }
  const after = afterRev(q.after);
  const limit = pageSize(q.limit);
  const rows: LogRow[] = [];
  for (const kind of new Set(q.kinds)) {
    const page =
      q.mission === undefined
        ? s.stmt(`SELECT ${LOG_COLUMNS} FROM log WHERE kind = ? AND rev > ? ORDER BY rev LIMIT ?`).all(kind, after, limit)
        : s
            .stmt(`SELECT ${LOG_COLUMNS_L} FROM record_missions m JOIN log l ON l.rev = m.rev WHERE m.mission = ? AND m.kind = ? AND m.rev > ? ORDER BY m.rev LIMIT ?`)
            .all(q.mission, kind, after, limit);
    rows.push(...(page as unknown as LogRow[]));
  }
  rows.sort((a, b) => Number(a.rev) - Number(b.rev));
  // A page also stops at PAGE_MAX_BYTES of records (always at least one), so an answer stays bounded.
  const out: Committed[] = [];
  let bytes = 0;
  for (const r of rows.slice(0, limit)) {
    bytes += r.record.length;
    if (out.length > 0 && bytes > PAGE_MAX_BYTES) break;
    out.push({ revision: revision(Number(r.rev)), record: intactRecord<BaseRecord>(s, r) });
  }
  return out;
}

/** A fact read back by its identity (object.version by object id, judgment by judgment id...): one indexed lookup, its event checked intact. */
export function factById(s: Db, kind: string, ident: string): Committed | null {
  const row = s.stmt(`SELECT ${LOG_COLUMNS_L} FROM facts f JOIN log l ON l.rev = f.rev WHERE f.kind = ? AND f.id = ?`).get(kind, ident) as unknown as LogRow | undefined;
  return row ? { revision: revision(Number(row.rev)), record: intactRecord<BaseRecord>(s, row) } : null;
}

// ---------------------------------------------------------------- missions, notices, PM actions, closing snapshots

export interface MissionInfo {
  readonly mission: MissionId;
  readonly state: 'open' | 'closed';
  /** Closing snapshot versions recorded (6.6 关闭). */
  readonly closes: number;
}

/** Missions by state (default: open), by id. */
export function listMissions(s: Db, state: 'open' | 'closed' | 'all' = 'open'): MissionInfo[] {
  if (!['open', 'closed', 'all'].includes(state)) throw new LedgerError('BAD_REQUEST', 'state is open, closed or all');
  const rows = s
    .stmt(
      `SELECT m.mission AS mission, m.state AS state, (SELECT COUNT(*) FROM mission_closes c WHERE c.mission = m.mission) AS closes FROM missions m ${state === 'all' ? '' : 'WHERE m.state = ?'} ORDER BY m.mission`,
    )
    .all(...(state === 'all' ? [] : [state])) as Array<{ mission: string; state: 'open' | 'closed'; closes: number }>;
  return rows.map((r) => ({ mission: r.mission as MissionId, state: r.state, closes: Number(r.closes) }));
}

export interface NoticeDelivery {
  readonly notice: string;
  readonly state: 'delivered' | 'acknowledged';
  readonly deliveredAt: number;
  readonly acknowledgedAt: number | null;
}

/** Delivery states of the given notices (absent from the answer: undelivered), or of every notice marked so far (at most 10,000, newest first). */
export function noticeDeliveries(s: Db, notices?: readonly string[]): NoticeDelivery[] {
  type Row = { notice: string; state: 'delivered' | 'acknowledged'; delivered_at: number; acknowledged_at: number | null };
  const of = (r: Row): NoticeDelivery => ({ notice: r.notice, state: r.state, deliveredAt: Number(r.delivered_at), acknowledgedAt: r.acknowledged_at === null ? null : Number(r.acknowledged_at) });
  if (notices === undefined) return (s.stmt('SELECT notice, state, delivered_at, acknowledged_at FROM notice_deliveries ORDER BY rev DESC LIMIT 10000').all() as Row[]).map(of);
  if (!Array.isArray(notices) || notices.length > PAGE_MAX || !notices.every((n) => typeof n === 'string')) throw new LedgerError('BAD_REQUEST', `notices is a list of at most ${PAGE_MAX} ids`);
  const out: NoticeDelivery[] = [];
  for (const n of new Set(notices)) {
    const r = s.stmt('SELECT notice, state, delivered_at, acknowledged_at FROM notice_deliveries WHERE notice = ?').get(n) as Row | undefined;
    if (r) out.push(of(r));
  }
  return out;
}

export interface PmAction {
  readonly action: string;
  readonly command: string;
  readonly argsHash: string;
  /** Canonical JSON of the arguments, in the data table. */
  readonly args: ContentHash;
  readonly wi: string | null;
  readonly state: 'started' | 'done' | 'failed';
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly result: ContentHash | null;
  readonly revision: Revision;
}

type PmActionRow = { action: string; command: string; args_hash: string; args: string; wi: string | null; state: PmAction['state']; started_at: number; ended_at: number | null; result: string | null; rev: number };

function pmActionOf(r: PmActionRow): PmAction {
  return {
    action: r.action,
    command: r.command,
    argsHash: r.args_hash,
    args: r.args as ContentHash,
    wi: r.wi,
    state: r.state,
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
    result: r.result as ContentHash | null,
    revision: revision(Number(r.rev)),
  };
}

export function pmAction(s: Db, action: string): PmAction | null {
  const r = s.stmt('SELECT * FROM pm_actions WHERE action = ?').get(action) as unknown as PmActionRow | undefined;
  return r ? pmActionOf(r) : null;
}

/** PM actions, most recently changed first; `before`: a revision to page back from. */
export function pmActions(s: Db, q: { limit?: number; before?: number } = {}): PmAction[] {
  const limit = q.limit === undefined ? 50 : q.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new LedgerError('BAD_REQUEST', `limit is 1 to ${PAGE_MAX}`);
  const rows = (
    q.before === undefined ? s.stmt('SELECT * FROM pm_actions ORDER BY rev DESC LIMIT ?').all(limit) : s.stmt('SELECT * FROM pm_actions WHERE rev < ? ORDER BY rev DESC LIMIT ?').all(q.before, limit)
  ) as unknown as PmActionRow[];
  return rows.map(pmActionOf);
}

/** Who issued each `mp pm` command (§3.2 item 13): its operation id, the command and the PM's filler. Newest first. */
export function pmCommands(s: Db, q: { limit?: number; before?: number } = {}): Array<{ op: string; command: string; filler: Filler | null; at: number; revision: Revision }> {
  const limit = q.limit === undefined ? 50 : q.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new LedgerError('BAD_REQUEST', `limit is 1 to ${PAGE_MAX}`);
  const rows = (
    q.before === undefined ? s.stmt('SELECT * FROM pm_commands ORDER BY rev DESC LIMIT ?').all(limit) : s.stmt('SELECT * FROM pm_commands WHERE rev < ? ORDER BY rev DESC LIMIT ?').all(q.before, limit)
  ) as Array<{ op: string; command: string; harness: string | null; model: string | null; at: number; rev: number }>;
  return rows.map((r) => ({ op: r.op, command: r.command, filler: r.harness === null ? null : { harness: r.harness, model: r.model }, at: Number(r.at), revision: revision(Number(r.rev)) }));
}

export interface MissionClose {
  readonly mission: MissionId;
  readonly version: number;
  readonly mode: 'with-risk' | 'full' | 'post-audit';
  readonly waitRunning: boolean;
  /** The log revision the snapshot stands on (4.0: the evaluator's published revision). */
  readonly asOf: number;
  /** { queued: [task...], running: [{ task, dispatch }...] } at the close, in the data table. */
  readonly unfinished: ContentHash;
  /** The caller's snapshot document (proof states, risk list), if it sent one. */
  readonly snapshot: ContentHash | null;
  readonly revision: Revision;
  readonly at: number;
}

/** A mission's closing snapshots, oldest first. */
export function missionCloses(s: Db, mission: MissionId): MissionClose[] {
  const rows = s.stmt('SELECT * FROM mission_closes WHERE mission = ? ORDER BY version').all(mission) as Array<{
    mission: string;
    version: number;
    mode: MissionClose['mode'];
    wait_running: number;
    as_of: number;
    unfinished: string;
    snapshot: string | null;
    rev: number;
    at: number;
  }>;
  return rows.map((r) => ({
    mission: r.mission as MissionId,
    version: Number(r.version),
    mode: r.mode,
    waitRunning: r.wait_running === 1,
    asOf: Number(r.as_of),
    unfinished: r.unfinished as ContentHash,
    snapshot: r.snapshot as ContentHash | null,
    revision: revision(Number(r.rev)),
    at: Number(r.at),
  }));
}

// ---------------------------------------------------------------- cursors (§3.2 item 7)

/** A cursor's revision (e.g. "since the maintainer last asked"), or null when never set. */
export function cursor(s: Db, name: string): { rev: Revision; at: number } | null {
  const r = s.stmt('SELECT rev, at FROM cursors WHERE cursor = ?').get(name) as { rev: number; at: number } | undefined;
  return r ? { rev: revision(Number(r.rev)), at: Number(r.at) } : null;
}
