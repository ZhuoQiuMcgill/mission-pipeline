// The work the process hands out (design 4.1 §5, §6.2): missions, the task
// queue, dispatches and exclusive-resource leases, as functions that run inside
// the caller's write.
//
// - A task enters the queue; it is a ready step for `mp pm next`.
// - `mp pm dispatch <step>` claims it once: a dispatch with its id, its seat,
//   its stop scope, its filler (information only), its worktree (a Constructor:
//   git writes must not be held, §3.3) and its card, written as a leaf. A second
//   claim, a claim under a stop, or a claim of a task not queued is refused.
// - A dispatch hands back once (§5.3): the same content again is a no-op,
//   another is refused. A hand-back after the PM released the dispatch, or
//   inside the scope of a stop, is recorded with its content but not accepted
//   (§5.4, §6.6); the caller appends the hand-back's records only when it is.
// - The PM releases a dispatch (§5.4): `ended` (its harness confirmed the seat
//   ended: its leases are freed) or `abandoned` (not confirmed: its leases stay
//   held until a later `ended`). The step is queued again at once.
//
// This replaces the 4.0 launches, their generation fence (assertCurrent: a
// late write of an old scheduler) and their dispositions: the fence is per
// dispatch now (assertDispatchCurrent), and nothing watches a process.

import { canonicalJson, hashJson, sha256 } from '../../common/hash.ts';
import { missionIdProblem, type ContentHash, type MissionId, type Revision } from '../../common/ids.ts';
import type { BaseRecord, TaskHandover } from '../../common/records.ts';
import type { Db } from '../db.ts';
import { getKey } from '../db.ts';
import { LedgerError } from '../errors.ts';
import { checkFiller, type DispatchHandbackOutcome, type Filler } from '../events.ts';
import type { LeafRef } from '../leaves.ts';
import type { WriteTx } from '../memory.ts';
import { PATH_ID } from '../paths.ts';
import { dispatchInfo, taskInfo, type DispatchInfo } from '../queries.ts';
import type { ScopeTag } from '../stopTypes.ts';
import { checkShape } from './facts.ts';
import { assertNotStopped, stoppedFor } from './stops.ts';

const SEAT = /^[a-z][a-z0-9-]{0,63}$/;
const PRINTABLE_200 = /^[^\u0000-\u001f\u007f]{1,200}$/;
const MISSION_ANY = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

// ---------------------------------------------------------------- missions

/**
 * A mission id names a folder (missions/<mission>/): on Windows and macOS
 * letter case does not tell two apart, so an id that differs from a known
 * mission's only in case is refused wherever a mission is named first.
 */
export function assertNoMissionAlias(db: Db, mission: string): void {
  const alias = db.stmt('SELECT mission FROM missions WHERE mission = ? COLLATE NOCASE AND mission <> ? LIMIT 1').get(mission, mission) as { mission: string } | undefined;
  if (alias) throw new LedgerError('BAD_REQUEST', `mission ${mission} differs only in letter case from mission ${alias.mission}: their folders would be one on Windows and macOS`);
}

export function setMission(tx: WriteTx, mission: MissionId, state: 'open' | 'closed'): { mission: MissionId; state: 'open' | 'closed' } {
  if (state !== 'open' && state !== 'closed') throw new LedgerError('BAD_REQUEST', 'a mission is open or closed');
  // A mission is created by opening it: only ids that keep derived ids injective (review r1 #17).
  const bad = state === 'open' ? missionIdProblem(mission) : null;
  if (bad !== null) throw new LedgerError('BAD_REQUEST', bad);
  assertNoMissionAlias(tx, mission);
  tx.append({ kind: 'mission.state', mission, state });
  return { mission, state };
}

/**
 * 6.6 关闭: close a mission and freeze its closing snapshot, in one write: a
 * mission.close record (a new version on every close) with the log revision it
 * stands on (`asOf`, 4.0: the published revision), the mission's unfinished
 * work at that moment (queued tasks; dispatches in flight), and the caller's
 * snapshot document (data), if any; then the mission's state is closed.
 */
export function closeMission(
  tx: WriteTx,
  req: { mission: MissionId; mode: 'with-risk' | 'full' | 'post-audit'; waitRunning?: boolean; snapshot?: ContentHash | null },
): { version: number; asOf: number; unfinished: ContentHash; revision: Revision } {
  if (typeof req.mission !== 'string' || !MISSION_ANY.test(req.mission)) throw new LedgerError('BAD_REQUEST', 'mission is a mission id');
  if (!['with-risk', 'full', 'post-audit'].includes(req.mode)) throw new LedgerError('BAD_REQUEST', 'mode is with-risk, full or post-audit');
  if (req.waitRunning !== undefined && typeof req.waitRunning !== 'boolean') throw new LedgerError('BAD_REQUEST', 'waitRunning is a boolean');
  assertNoMissionAlias(tx, req.mission);
  const snapshot = req.snapshot ?? null;
  if (snapshot !== null) {
    if (typeof snapshot !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot)) throw new LedgerError('BAD_REQUEST', 'snapshot is a data hash or null');
    tx.data.get(snapshot);
  }
  const queued = (tx.stmt("SELECT task FROM tasks WHERE mission = ? AND state = 'queued' ORDER BY queued_rev").all(req.mission) as Array<{ task: string }>).map((r) => r.task);
  const running = (tx.stmt("SELECT task, dispatch FROM dispatches WHERE mission = ? AND state = 'in-flight' ORDER BY claimed_rev").all(req.mission) as Array<{ task: string; dispatch: string }>).map((r) => ({
    task: r.task,
    dispatch: r.dispatch,
  }));
  const unfinished = tx.data.put(canonicalJson({ mission: req.mission, queued, running }));
  const version = Number((tx.stmt('SELECT COALESCE(MAX(version), 0) AS v FROM mission_closes WHERE mission = ?').get(req.mission) as { v: number }).v) + 1;
  const asOf = Number(tx.head());
  const revision = tx.append({ kind: 'mission.close', mission: req.mission, version, mode: req.mode, waitRunning: req.waitRunning ?? false, asOf, unfinished, snapshot });
  tx.append({ kind: 'mission.state', mission: req.mission, state: 'closed' });
  return { version, asOf, unfinished, revision };
}

// ---------------------------------------------------------------- the task queue

/**
 * A task enters the queue. The same task queued again with the same card is a
 * no-op returning its revision; a different card while it is queued, or
 * another lineage at any time, is refused (FACT_CONFLICT): a replacing task
 * keeps the lineage (6.5). A task not queued (dispatched, cancelled...) is
 * queued again (a retry).
 */
export function queueTask(tx: WriteTx, req: { task: string; lineage: string; mission: MissionId; card: ContentHash; queuedBy?: TaskHandover }): { revision: Revision } {
  // who handed it over (§3.2, U-13): kept on the record, read from the log
  const rec: BaseRecord = { kind: 'task.queued', task: req.task, lineage: req.lineage, mission: req.mission, card: req.card, ...(req.queuedBy !== undefined ? { queuedBy: req.queuedBy } : {}) };
  checkShape(rec, new Set(['task.queued']), 'queueTask');
  assertNoMissionAlias(tx, req.mission);
  tx.data.get(req.card);
  const cur = taskInfo(tx, req.task);
  if (cur !== null && cur.lineage !== req.lineage) throw new LedgerError('FACT_CONFLICT', `task ${req.task} belongs to lineage ${cur.lineage}; a task keeps its lineage (6.5)`);
  if (cur?.state === 'queued') {
    if (cur.mission === req.mission && cur.card === req.card) return { revision: cur.queuedRevision };
    throw new LedgerError('FACT_CONFLICT', `task ${req.task} is queued with another card`);
  }
  if (cur?.state === 'dispatched' && cur.dispatch !== null && dispatchInfo(tx, cur.dispatch)?.state === 'in-flight') {
    throw new LedgerError('FACT_CONFLICT', `task ${req.task} is claimed by dispatch ${cur.dispatch}, still in flight; it is queued again once that dispatch hands back or is released`);
  }
  return { revision: tx.append(rec) };
}

/** A task leaves the queue without a dispatch: cancelled, or superseded by another task (which keeps the lineage, 6.5). */
export function dequeueTask(tx: WriteTx, req: { task: string; reason: 'cancelled' | 'superseded'; by?: string | null }): { revision: Revision } {
  if (req.reason !== 'cancelled' && req.reason !== 'superseded') throw new LedgerError('BAD_REQUEST', 'a task leaves the queue cancelled or superseded; a dispatch claims it with claimDispatch');
  const rec: BaseRecord = { kind: 'task.dequeued', task: req.task, reason: req.reason, launch: null, by: req.by ?? null };
  checkShape(rec, new Set(['task.dequeued']), 'dequeueTask');
  const cur = taskInfo(tx, req.task);
  if (cur === null || cur.state !== 'queued') throw new LedgerError('NOT_QUEUED', `task ${req.task} is not in the queue (${cur?.state ?? 'never queued'})`);
  return { revision: tx.append(rec) };
}

// ---------------------------------------------------------------- dispatches

/** The card's and the report's leaves (§3.1). */
export function dispatchLeaf(mission: string, dispatch: string, name: 'card' | 'report'): string {
  return `missions/${mission}/dispatches/${dispatch}/${name}.md`;
}

function checkCapabilities(x: unknown): string[] {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x) || x.length > 64 || !x.every((c) => typeof c === 'string' && PRINTABLE_200.test(c))) throw new LedgerError('BAD_REQUEST', 'capabilities is a list of at most 64 names of 1 to 200 printable characters');
  return [...new Set(x as string[])].sort();
}

/** GIT_WRITES_HELD while git writes are held after a move (§3.3 step 2). */
export function assertGitWrites(db: Db, what: string): void {
  const v = getKey(db, 'meta', 'git_hold');
  if (v === null) return;
  const h = JSON.parse(v) as { reason: string };
  throw new LedgerError('GIT_WRITES_HELD', `${what} writes to git, which is held since this folder was moved or copied: ${h.reason}. The PM confirms under the copy/move WI that this copy is the one in use`);
}

/**
 * Claim a queued step (§5.1 step 2). `worktree`: the dispatch works in its own
 * git worktree (`worktrees/<dispatch>`, a Constructor), which the git package
 * creates; `card`: the card's text, written as the leaf
 * `missions/<mission>/dispatches/<dispatch>/card.md`. The scope a stop is
 * checked against is the task's mission and the dispatch's capabilities.
 */
export function claimDispatch(
  tx: WriteTx,
  req: { dispatch: string; task: string; seat: string; capabilities?: readonly string[]; filler?: Filler | null; worktree?: boolean; card?: string | null },
): { dispatch: string; revision: Revision; card: LeafRef | null; worktree: string | null } {
  if (typeof req.dispatch !== 'string' || !PATH_ID.test(req.dispatch)) throw new LedgerError('BAD_REQUEST', 'a dispatch id is 1 to 64 letters, digits and "-", starting with a letter or digit');
  if (typeof req.seat !== 'string' || !SEAT.test(req.seat)) throw new LedgerError('BAD_REQUEST', 'a seat is 1 to 64 lowercase letters, digits and "-", starting with a letter');
  const capabilities = checkCapabilities(req.capabilities);
  const filler = checkFiller(req.filler);
  // A dispatch id names its card's folder and its worktree: letter case does not tell two apart on Windows and macOS.
  const taken = tx.stmt('SELECT dispatch FROM dispatches WHERE dispatch = ? COLLATE NOCASE LIMIT 1').get(req.dispatch) as { dispatch: string } | undefined;
  if (taken) throw new LedgerError('FACT_CONFLICT', taken.dispatch === req.dispatch ? `dispatch ${req.dispatch} exists` : `dispatch ${req.dispatch} differs only in letter case from dispatch ${taken.dispatch}: their folders would be one on Windows and macOS`);
  const task = taskInfo(tx, req.task);
  if (task === null || task.state !== 'queued') throw new LedgerError('NOT_QUEUED', `task ${req.task} is not in the queue (${task === null ? 'never queued' : task.state === 'dispatched' ? `claimed by ${task.dispatch}` : task.state}): a step is claimed once`);
  const tag: ScopeTag = { mission: task.mission, capabilities };
  assertNotStopped(tx, tag, 'this dispatch');
  if (task.mission.length > 64 || !PATH_ID.test(task.mission)) throw new LedgerError('BAD_REQUEST', `mission ${task.mission} cannot name a folder`);
  const worktree = req.worktree === true ? `worktrees/${req.dispatch}` : null;
  if (worktree !== null) assertGitWrites(tx, 'a dispatch with a worktree');
  const card = req.card === undefined || req.card === null ? null : tx.leaves.writeDocument(dispatchLeaf(task.mission, req.dispatch, 'card'), req.card);
  const revision = tx.append({
    kind: 'dispatch.claimed',
    dispatch: req.dispatch,
    task: task.task,
    seat: req.seat,
    mission: task.mission,
    lineage: task.lineage,
    capabilities,
    filler,
    worktree,
    card: card?.leaf ?? null,
  });
  return { dispatch: req.dispatch, revision, card, worktree };
}

/** The dispatch, in flight: the 4.1 fence for a late write (4.0 assertCurrent fenced an old scheduler's). */
export function assertDispatchCurrent(db: Db, dispatch: string): DispatchInfo {
  const d = dispatchInfo(db, dispatch);
  if (d === null) throw new LedgerError('UNKNOWN_DISPATCH', `no dispatch ${dispatch}`);
  if (d.state !== 'in-flight') throw new LedgerError('UNRECOGNIZED_LAUNCH', `dispatch ${dispatch} is ${d.state === 'released' ? `released (${d.released})` : 'handed back'}; it is no longer current`);
  return d;
}

/**
 * The dispatch's one hand-back (§5.3). `report`: the seat's report text,
 * filed as the leaf `missions/<mission>/dispatches/<dispatch>/report.md`;
 * `result`: the structured fields its role requires (any JSON value, stored as
 * data). The answer says how it was recorded: `accepted`, or not accepted
 * because it came `after-release` or `after-stop`; the caller appends the
 * hand-back's records only when accepted.
 */
export function recordHandback(
  tx: WriteTx,
  req: { dispatch: string; report?: string | null; result?: unknown; filler?: Filler | null },
): { outcome: DispatchHandbackOutcome; accepted: boolean; revision: Revision | null; report: string | null; result: ContentHash | null; repeated: boolean } {
  const d = dispatchInfo(tx, req.dispatch);
  if (d === null) throw new LedgerError('UNKNOWN_DISPATCH', `no dispatch ${req.dispatch}`);
  const filler = checkFiller(req.filler);
  const report = req.report ?? null;
  if (report !== null && typeof report !== 'string') throw new LedgerError('BAD_REQUEST', 'a report is text');
  const resultJson = req.result === undefined ? null : canonicalJson(req.result);
  const payloadHash = hashJson({ report: report === null ? null : sha256(report), result: resultJson === null ? null : sha256(resultJson) });
  if (d.handbackHash !== null) {
    if (d.handbackHash === payloadHash) return { outcome: d.handback!, accepted: d.handback === 'accepted', revision: null, report: d.reportLeaf, result: d.result, repeated: true };
    throw new LedgerError('FACT_CONFLICT', `dispatch ${req.dispatch} already handed back other content: one hand-back per dispatch`);
  }
  if (d.state === 'handed-back') throw new LedgerError('FACT_CONFLICT', `dispatch ${req.dispatch} already handed back`);
  const outcome: DispatchHandbackOutcome = d.state === 'released' ? 'after-release' : stoppedFor(tx, d.tag) ? 'after-stop' : 'accepted';
  const result = resultJson === null ? null : tx.data.put(resultJson);
  const leaf = report === null ? null : tx.leaves.writeDocument(dispatchLeaf(d.mission, d.dispatch, 'report'), report);
  const revision = tx.append({ kind: 'dispatch.handback', dispatch: d.dispatch, outcome, payloadHash, report: leaf?.leaf ?? null, result, filler });
  return { outcome, accepted: outcome === 'accepted', revision, report: leaf?.leaf ?? null, result, repeated: false };
}

/**
 * The PM releases a dispatch (§5.4): `ended` frees its worktree (the git
 * package removes it) and its leases; `abandoned` keeps them held until a
 * later `ended`. The first release queues the step again at once (unless
 * `requeue: false`), so it can be dispatched again in a new worktree.
 */
export function releaseDispatch(tx: WriteTx, req: { dispatch: string; how: 'ended' | 'abandoned'; requeue?: boolean }): { released: boolean; requeued: boolean } {
  if (req.how !== 'ended' && req.how !== 'abandoned') throw new LedgerError('BAD_REQUEST', 'a dispatch is released ended or abandoned');
  const d = dispatchInfo(tx, req.dispatch);
  if (d === null) throw new LedgerError('UNKNOWN_DISPATCH', `no dispatch ${req.dispatch}`);
  if (d.state === 'handed-back') return { released: false, requeued: false };
  if (d.state === 'released' && (d.released === 'ended' || req.how === 'abandoned')) return { released: false, requeued: false };
  const first = d.state === 'in-flight';
  tx.append({ kind: 'dispatch.released', dispatch: d.dispatch, how: req.how });
  let requeued = false;
  if (first && req.requeue !== false) {
    const t = taskInfo(tx, d.task);
    if (t !== null && t.state === 'dispatched' && t.dispatch === d.dispatch) {
      tx.append({ kind: 'task.queued', task: t.task, lineage: t.lineage, mission: t.mission, card: t.card });
      requeued = true;
    }
  }
  return { released: true, requeued };
}

/** Lease an exclusive resource to a dispatch in flight (§6.2). Held by another dispatch: DOMAIN_BUSY. */
export function acquireLease(tx: WriteTx, req: { resource: string; dispatch: string }): { acquired: boolean } {
  if (typeof req.resource !== 'string' || !PRINTABLE_200.test(req.resource)) throw new LedgerError('BAD_REQUEST', 'a resource is 1 to 200 printable characters');
  assertDispatchCurrent(tx, req.dispatch);
  const holder = tx.stmt('SELECT dispatch FROM leases WHERE resource = ?').get(req.resource) as { dispatch: string } | undefined;
  if (holder?.dispatch === req.dispatch) return { acquired: false };
  if (holder !== undefined) throw new LedgerError('DOMAIN_BUSY', `resource ${req.resource} is held by dispatch ${holder.dispatch}`, null);
  tx.append({ kind: 'lease.acquired', resource: req.resource, dispatch: req.dispatch });
  return { acquired: true };
}
