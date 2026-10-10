// Read-only queries on the ledger's state tables, answered by the service over
// its IPC (6.1: callers never read the database themselves). Each one is a
// bounded, indexed read; none touches derived state.

import { revision, type ContentHash, type Generation, type LaunchId, type MissionId, type Revision, type StopId } from '../common/ids.ts';
import { ENV_RETRY_PER_CLASS, LOOP_CAPS, type BaseRecord, type Committed, type LoopKind, type MissionBlockRecord, type StartupBasis } from '../common/records.ts';
import { LedgerError } from './errors.ts';
import { stopCovers, type ScopeTag, type StopScope } from './stops.ts';
import type { Store } from './store.ts';

export type Disposition = 'accepted' | 'failed' | 'cancelled';
export type IntentState = 'authorized' | 'pending_verify' | 'done' | 'failed';

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

export function readLoopState(s: Store, lineage: string, loop: LoopKind, failureClass: string | null = null): LoopState {
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
  else if (loop === 'env-retry' && failureClass !== null && (byClass[failureClass] ?? 0) >= ENV_RETRY_PER_CLASS + extra) reason = 'class-cap';
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

// ---------------------------------------------------------------- stops (6.4)

export interface ActiveStop {
  readonly stop: StopId;
  readonly scope: StopScope;
  readonly words: string;
  readonly requestedAt: number;
  readonly committedAt: number;
  /** The stop this one narrowed (6.4 "再收窄"), released in the same transaction; null otherwise. */
  readonly narrows: StopId | null;
}

/** Every active stop, in commit order (6.4: reload all active restrictions after any restart). */
export function activeStops(s: Store): ActiveStop[] {
  const rows = s.stmt("SELECT stop, scope, words, requested_at, committed_at, narrows FROM stops WHERE state = 'active' ORDER BY committed_at, rowid").all() as Array<{
    stop: string;
    scope: string;
    words: string;
    requested_at: number;
    committed_at: number;
    narrows: string | null;
  }>;
  return rows.map((r) => ({
    stop: r.stop as StopId,
    scope: JSON.parse(r.scope) as StopScope,
    words: r.words,
    requestedAt: Number(r.requested_at),
    committedAt: Number(r.committed_at),
    narrows: (r.narrows ?? null) as StopId | null,
  }));
}

/** A committed stop with its narrowing links (6.4), or null. */
export function stopInfo(s: Store, stop: StopId): { stop: StopId; state: 'active' | 'released'; scope: StopScope; words: string; narrows: StopId | null; narrowedTo: StopId | null } | null {
  const r = s.stmt('SELECT stop, state, scope, words, narrows, narrowed_to FROM stops WHERE stop = ?').get(stop) as
    | { stop: string; state: 'active' | 'released'; scope: string; words: string; narrows: string | null; narrowed_to: string | null }
    | undefined;
  return r ? { stop: r.stop as StopId, state: r.state, scope: JSON.parse(r.scope) as StopScope, words: r.words, narrows: (r.narrows ?? null) as StopId | null, narrowedTo: (r.narrowed_to ?? null) as StopId | null } : null;
}

/** A stop's state: active, released, or not committed (null). */
export function stopState(s: Store, stop: StopId): 'active' | 'released' | null {
  const r = s.stmt('SELECT state FROM stops WHERE stop = ?').get(stop) as { state: 'active' | 'released' } | undefined;
  return r?.state ?? null;
}

// ---------------------------------------------------------------- external actions (6.1)

export interface ExecutorIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly bootId: string;
}

export interface OpenIntent {
  readonly intent: string;
  readonly state: 'authorized' | 'pending_verify';
  readonly kind: string;
  readonly domain: string;
  readonly launch: LaunchId | null;
  readonly tag: ScopeTag;
  readonly executor: ExecutorIdentity | null;
  readonly updatedAt: number;
}

/** External actions authorized and not settled (6.4: "停止前已开始，结果未定"), oldest first. */
export function openIntents(s: Store): OpenIntent[] {
  const rows = s
    .stmt("SELECT intent, state, kind, domain, launch, mission, capabilities, executor, updated_at FROM intents WHERE state IN ('authorized', 'pending_verify') ORDER BY updated_at, intent")
    .all() as Array<{ intent: string; state: 'authorized' | 'pending_verify'; kind: string; domain: string; launch: string | null; mission: string; capabilities: string; executor: string | null; updated_at: number }>;
  return rows.map((r) => ({
    intent: r.intent,
    state: r.state,
    kind: r.kind,
    domain: r.domain,
    launch: r.launch as LaunchId | null,
    tag: { mission: r.mission as MissionId, capabilities: JSON.parse(r.capabilities) as string[] },
    executor: r.executor ? (JSON.parse(r.executor) as ExecutorIdentity) : null,
    updatedAt: Number(r.updated_at),
  }));
}

// ---------------------------------------------------------------- launches (6.3, 6.4)

export interface LaunchInfo {
  readonly launch: LaunchId;
  readonly gen: Generation;
  readonly tag: ScopeTag;
  readonly createdAt: number;
  readonly disposition: Disposition | null;
  readonly cleanup: 'pending' | 'done' | null;
  readonly adoptedBy: Generation[];
}

export interface LaunchFilter {
  /** Only launches a stop of this scope covers. */
  readonly scope?: StopScope;
  /** Only launches without a final disposition, or whose cleanup is not done (6.4: "stopped" needs cleanup done). */
  readonly unfinished?: boolean;
  /** One launch. */
  readonly launch?: LaunchId;
}

/** Launches with their tag, final disposition and cleanup state, disposed ones included, in registration order. */
export function listLaunches(s: Store, filter: LaunchFilter = {}): LaunchInfo[] {
  const where: string[] = [];
  const args: string[] = [];
  if (filter.launch !== undefined) {
    where.push('l.launch = ?');
    args.push(filter.launch);
  }
  if (filter.scope?.kind === 'mission') {
    where.push('l.mission = ?');
    args.push(filter.scope.mission);
  }
  if (filter.unfinished === true) where.push("(d.launch IS NULL OR c.state IS NULL OR c.state = 'pending')");
  const sql =
    'SELECT l.launch, l.gen, l.mission, l.capabilities, l.created_at, d.disposition, c.state AS cleanup FROM launches l LEFT JOIN dispositions d ON d.launch = l.launch LEFT JOIN cleanups c ON c.launch = l.launch' +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY l.rowid';
  const rows = s.stmt(sql).all(...args) as Array<{ launch: string; gen: number; mission: string; capabilities: string; created_at: number; disposition: Disposition | null; cleanup: 'pending' | 'done' | null }>;
  const out: LaunchInfo[] = [];
  for (const r of rows) {
    const tag: ScopeTag = { mission: r.mission as MissionId, capabilities: JSON.parse(r.capabilities) as string[] };
    if (filter.scope !== undefined && !stopCovers(filter.scope, tag)) continue;
    out.push({
      launch: r.launch as LaunchId,
      gen: Number(r.gen) as Generation,
      tag,
      createdAt: Number(r.created_at),
      disposition: r.disposition ?? null,
      cleanup: r.cleanup ?? null,
      adoptedBy: (s.stmt('SELECT gen FROM adoptions WHERE launch = ? ORDER BY gen').all(r.launch) as Array<{ gen: number }>).map((a) => Number(a.gen) as Generation),
    });
  }
  return out;
}

// ---------------------------------------------------------------- missions (6.5)

/** The latest mission.block record of each mission (or of one). */
export function missionBlocks(s: Store, mission?: MissionId): Array<{ mission: MissionId; revision: Revision; record: MissionBlockRecord }> {
  const rows = (
    mission === undefined ? s.stmt('SELECT mission, rev, record FROM mission_blocks ORDER BY mission').all() : s.stmt('SELECT mission, rev, record FROM mission_blocks WHERE mission = ?').all(mission)
  ) as Array<{ mission: string; rev: number; record: string }>;
  return rows.map((r) => ({ mission: r.mission as MissionId, revision: Number(r.rev) as Revision, record: JSON.parse(r.record) as MissionBlockRecord }));
}

// ---------------------------------------------------------------- user words (10.1 item 6, WI-12)

export interface BookedUserWords {
  readonly revision: Revision;
  readonly message: string;
  readonly session: string;
  readonly at: number;
  readonly text: ContentHash;
  readonly excerpt: string;
}

/** The latest booked user messages, newest first (indexed by kind). */
export function latestUserWords(s: Store, limit = 1, session?: string): BookedUserWords[] {
  const n = Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : 1, 1000));
  const out: BookedUserWords[] = [];
  // Newest first; a session filter reads on until enough match (bounded by the page size).
  for (let before = Number.MAX_SAFE_INTEGER; out.length < n; ) {
    const rows = s.stmt("SELECT rev, record FROM log WHERE kind = 'user.words' AND rev < ? ORDER BY rev DESC LIMIT ?").all(before, 200) as Array<{ rev: number; record: string }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      const rec = JSON.parse(r.record) as { message: string; session: string; at: number; text: ContentHash; excerpt: string };
      if (session === undefined || rec.session === session) out.push({ revision: Number(r.rev) as Revision, message: rec.message, session: rec.session, at: rec.at, text: rec.text, excerpt: rec.excerpt });
      if (out.length >= n) break;
    }
    before = Number(rows[rows.length - 1]!.rev);
  }
  return out;
}

// ---------------------------------------------------------------- the task queue (4.1)

export interface QueuedTask {
  readonly task: string;
  readonly lineage: string;
  readonly mission: MissionId;
  readonly card: ContentHash;
  readonly queuedRevision: Revision;
  readonly queuedAt: number;
}

export interface TaskInfo extends QueuedTask {
  readonly state: 'queued' | 'dispatched' | 'cancelled' | 'superseded';
  readonly launch: LaunchId | null;
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
  launch: string | null;
  by_task: string | null;
  updated_at: number;
}

function taskOf(r: TaskRow): TaskInfo {
  return {
    task: r.task,
    lineage: r.lineage,
    mission: r.mission as MissionId,
    card: r.card as ContentHash,
    queuedRevision: Number(r.queued_rev) as Revision,
    queuedAt: Number(r.queued_at),
    state: r.state,
    launch: r.launch as LaunchId | null,
    by: r.by_task,
    updatedAt: Number(r.updated_at),
  };
}

/** The current queue, in the order tasks were queued (the scheduler applies its own priorities). */
export function taskQueue(s: Store, mission?: MissionId): QueuedTask[] {
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

export interface DispatchedTask extends QueuedTask {
  readonly launch: LaunchId;
  /** The launch's final disposition, or null while it has none. */
  readonly disposition: Disposition | null;
  readonly reason: string | null;
  readonly dispatchedAt: number;
}

/**
 * Tasks whose last queue entry was dispatched and that were never queued again,
 * with their launch's final disposition (by default only those that have one):
 * a restarted scheduler rebuilds its "needs disposition" and "exhausted" items
 * from these, without the PM queueing them again.
 */
export function dispatchedTasks(s: Store, filter: { mission?: MissionId; disposed?: boolean } = {}): DispatchedTask[] {
  const where = ["t.state = 'dispatched'"];
  const args: string[] = [];
  if (filter.mission !== undefined) {
    where.push('t.mission = ?');
    args.push(filter.mission);
  }
  if (filter.disposed !== false) where.push('d.launch IS NOT NULL');
  const rows = s
    .stmt(`SELECT t.*, d.disposition AS disposition, d.reason AS reason FROM tasks t LEFT JOIN dispositions d ON d.launch = t.launch WHERE ${where.join(' AND ')} ORDER BY t.updated_at, t.task`)
    .all(...args) as unknown as Array<TaskRow & { disposition: Disposition | null; reason: string | null }>;
  return rows.map((r) => {
    const t = taskOf(r);
    return { task: t.task, lineage: t.lineage, mission: t.mission, card: t.card, queuedRevision: t.queuedRevision, queuedAt: t.queuedAt, launch: t.launch!, disposition: r.disposition ?? null, reason: r.reason ?? null, dispatchedAt: t.updatedAt };
  });
}

export function taskInfo(s: Store, task: string): TaskInfo | null {
  const r = s.stmt('SELECT * FROM tasks WHERE task = ?').get(task) as unknown as TaskRow | undefined;
  return r ? taskOf(r) : null;
}

// ---------------------------------------------------------------- the startup decision (v43 6.1, WI-12)

export interface StartupDecision {
  /** set: the start after the reboot entered the recovery pause; continued: it went on. */
  readonly state: 'set' | 'continued';
  readonly basis: StartupBasis;
  /** When the decision was committed. */
  readonly at: number;
  /** When the PM confirmed resuming (WI-12), if it did. */
  readonly clearedAt: number | null;
  /** The user's WI-12 answer recorded with the confirmation, and the PM's operation id (absent before 4.0's confirmResume({ op, answer })). */
  readonly answer?: string | null;
  readonly answerOp?: string | null;
}

export function startupDecision(s: Store): StartupDecision | null {
  const d = s.getState('startup_decision');
  return d === null ? null : (JSON.parse(d) as StartupDecision);
}

// ---------------------------------------------------------------- deliveries (6.6 steps 6-8; git review r1 #11)

/**
 * One delivery of a mission. `creating`: its ref creation was authorized, the
 * record not yet made; `recorded`: step 8 is done; `withdrawn`: the user withdrew
 * it (never current again). `seq` orders a mission's deliveries by their first
 * appearance in the ledger (the first ref authorization, or the record when
 * there was none): a later one supersedes an earlier one.
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

export function deliveryInfo(s: Store, mission: MissionId, delivery: string): DeliveryInfo | null {
  const r = s.stmt('SELECT * FROM deliveries WHERE mission = ? AND delivery = ?').get(mission, delivery) as unknown as DeliveryRow | undefined;
  return r ? deliveryOf(r) : null;
}

/**
 * The mission's current delivery (6.6 授权): the latest RECORDED one in the
 * mission's order. A landing may proceed only for it, and only while its state
 * is `recorded` (a withdrawn latest delivery leaves the mission with no current
 * delivery: the earlier ones stay superseded).
 */
export function currentDelivery(s: Store, mission: MissionId): DeliveryInfo | null {
  const r = s.stmt('SELECT * FROM deliveries WHERE mission = ? AND recorded_rev IS NOT NULL ORDER BY seq DESC LIMIT 1').get(mission) as unknown as DeliveryRow | undefined;
  return r ? deliveryOf(r) : null;
}

/** A later delivery of the mission than `seq` (any state), if one exists. */
export function laterDelivery(s: Store, mission: MissionId, delivery: string, seq: number): DeliveryInfo | null {
  const r = s.stmt('SELECT * FROM deliveries WHERE mission = ? AND delivery <> ? AND seq > ? ORDER BY seq DESC LIMIT 1').get(mission, delivery, seq) as unknown as DeliveryRow | undefined;
  return r ? deliveryOf(r) : null;
}

// ---------------------------------------------------------------- flow events and indexed reads (src/flow/RECORDS-NEEDED.md)

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
  /** The body's hash in the content store. */
  readonly body: ContentHash;
}

/**
 * A mission's flow events in revision order, optionally one line and/or one
 * event type, after a revision; at most `limit` (default 1000, at most 10,000)
 * per page.
 */
export function flowEvents(s: Store, q: { mission: MissionId; line?: string; event?: string; after?: number; limit?: number }): FlowEventRow[] {
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
export function flowMissions(s: Store): MissionId[] {
  return (s.stmt('SELECT DISTINCT mission FROM flow_events ORDER BY mission').all() as Array<{ mission: string }>).map((r) => r.mission as MissionId);
}

/**
 * Committed records of the given kinds in revision order, after a revision, at
 * most `limit` (and about 8 MiB) per page: one indexed read per kind (log by kind and revision),
 * merged. With `mission`, only records that name that mission (a top-level
 * `mission`, or an operation's scope); kinds that carry no mission (judgment,
 * issue, ...) then return nothing.
 */
export function recordsByKind(s: Store, q: { kinds: readonly string[]; mission?: MissionId; after?: number; limit?: number }): Committed[] {
  if (!Array.isArray(q.kinds) || q.kinds.length === 0 || q.kinds.length > 64 || !q.kinds.every((k) => typeof k === 'string' && k.length > 0)) {
    throw new LedgerError('BAD_REQUEST', 'kinds is a list of 1 to 64 record kinds');
  }
  const after = afterRev(q.after);
  const limit = pageSize(q.limit);
  const rows: Array<{ rev: number; record: string }> = [];
  for (const kind of new Set(q.kinds)) {
    const page =
      q.mission === undefined
        ? s.stmt('SELECT rev, record FROM log WHERE kind = ? AND rev > ? ORDER BY rev LIMIT ?').all(kind, after, limit)
        : s
            .stmt('SELECT l.rev AS rev, l.record AS record FROM record_missions m JOIN log l ON l.rev = m.rev WHERE m.mission = ? AND m.kind = ? AND m.rev > ? ORDER BY m.rev LIMIT ?')
            .all(q.mission, kind, after, limit);
    rows.push(...(page as Array<{ rev: number; record: string }>));
  }
  rows.sort((a, b) => Number(a.rev) - Number(b.rev));
  // A page also stops at PAGE_MAX_BYTES of records (always at least one), so an answer stays a bounded IPC line.
  const out: Committed[] = [];
  let bytes = 0;
  for (const r of rows.slice(0, limit)) {
    bytes += r.record.length;
    if (out.length > 0 && bytes > PAGE_MAX_BYTES) break;
    out.push({ revision: revision(Number(r.rev)), record: JSON.parse(r.record) as BaseRecord });
  }
  return out;
}

/** A fact read back by its identity (object.version by object id, judgment by judgment id...): one indexed lookup. */
export function factById(s: Store, kind: string, ident: string): Committed | null {
  const row = s.stmt('SELECT f.rev AS rev, l.record AS record FROM facts f JOIN log l ON l.rev = f.rev WHERE f.kind = ? AND f.id = ?').get(kind, ident) as
    | { rev: number; record: string }
    | undefined;
  return row ? { revision: revision(Number(row.rev)), record: JSON.parse(row.record) as BaseRecord } : null;
}

// ---------------------------------------------------------------- missions, notices, PM actions, closing snapshots

export interface MissionInfo {
  readonly mission: MissionId;
  readonly state: 'open' | 'closed';
  /** Closing snapshot versions recorded (6.6 关闭). */
  readonly closes: number;
}

/** Missions by state (default: open), by id. */
export function listMissions(s: Store, state: 'open' | 'closed' | 'all' = 'open'): MissionInfo[] {
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
export function noticeDeliveries(s: Store, notices?: readonly string[]): NoticeDelivery[] {
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
  /** Canonical JSON of the arguments, in the content store. */
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

export function pmAction(s: Store, action: string): PmAction | null {
  const r = s.stmt('SELECT * FROM pm_actions WHERE action = ?').get(action) as unknown as PmActionRow | undefined;
  return r ? pmActionOf(r) : null;
}

/** PM actions, most recently changed first; `before`: a revision to page back from. */
export function pmActions(s: Store, q: { limit?: number; before?: number } = {}): PmAction[] {
  const limit = q.limit === undefined ? 50 : q.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new LedgerError('BAD_REQUEST', `limit is 1 to ${PAGE_MAX}`);
  const rows = (
    q.before === undefined ? s.stmt('SELECT * FROM pm_actions ORDER BY rev DESC LIMIT ?').all(limit) : s.stmt('SELECT * FROM pm_actions WHERE rev < ? ORDER BY rev DESC LIMIT ?').all(q.before, limit)
  ) as unknown as PmActionRow[];
  return rows.map(pmActionOf);
}

export interface MissionClose {
  readonly mission: MissionId;
  readonly version: number;
  readonly mode: 'with-risk' | 'full' | 'post-audit';
  readonly waitRunning: boolean;
  /** The evaluator's published revision the snapshot stands on. */
  readonly asOf: number;
  /** { queued: [task...], running: [{ task, launch }...] } at the close, in the content store. */
  readonly unfinished: ContentHash;
  /** The caller's snapshot document (proof states, risk list), if it sent one. */
  readonly snapshot: ContentHash | null;
  readonly revision: Revision;
  readonly at: number;
}

/** A mission's closing snapshots, oldest first. */
export function missionCloses(s: Store, mission: MissionId): MissionClose[] {
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
