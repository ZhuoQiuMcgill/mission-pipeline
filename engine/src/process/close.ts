// Closing a mission (design 4.1 §6.7, v51 §6.6 kept): closing and delivery are separate; three
// tiers; an immutable closing snapshot; production stops, post-close work goes on.
//
//   with-risk   close now: what is unfinished or not proven goes on the snapshot's risk list
//   full        complete wrap-up: refused unless every output of the mission is proven and
//               nothing is unfinished (a proof-conditioned operation: refused while the labels
//               recompute)
//   post-audit  close now; the outputs are audited afterwards (legalization, §6.8)
//
// The close is one write (A1 closeMission): the mission.close record with its snapshot document
// (proof state of every output, unfinished work, risks) and the mission's state "closed". From
// that commit on:
//   - production steps of the mission are held: `mp pm next` lists them as held and `mp pm
//     dispatch` refuses them; the flows queue no new production work for it (engine.ts);
//   - post-close work goes on: audits (Auditor seats, and the Secretary deciding on them),
//     deliveries and their integration, fixes after an audit, re-reviews after an environment
//     change (FlowTask.afterClose);
//   - dispatches in flight are reported; the PM stops them through its harness and releases them,
//     as with stops (§6.6). Nothing watches or cancels a process. A hand-back from a production
//     dispatch claimed before the close is recorded but not accepted ("after release": the close
//     took the claim back), unless the close was given `waitRunning` ("wait for them to finish").
// Opening the mission again lets its held steps run (a production dispatch the close took back,
// or the PM released while the mission was closed, was queued again then, uncounted).
//
// Operation identity (code review r1 #9): every state change is its own operation. The caller's
// request id (the CLI's `--op`) or the maintainer's words entry names the request; without one,
// the revision of the mission's last state change does, so a new request after any change is a
// new operation, and only a retry of the same request replays its receipt.

import { canonicalJson } from '../common/hash.ts';
import type { ContentHash, MissionId } from '../common/ids.ts';
import { decisionLabels, labelBatch, labelStatus } from '../evaluator/index.ts';
import { appendRecords, closeMission, flowEvents, LedgerError, listDispatches, missionCloses, releaseDispatch, setMission, taskQueue, wordsEntry, type Db, type DispatchInfo, type MissionClose, type WriteTx } from '../memory/index.ts';
import { PLAN_LINE, PM_PLAN_EFFECTIVE, SECRETARY_LINE, explorationLine, taskLine } from '../flow/plandoc.ts';
import { fold } from '../flow/exploration/machine.ts';
import type { ProcessContext } from './context.ts';
import { ProcessError } from './errors.ts';
import { TASKS_LINE, type TaskSpecDoc } from './ports.ts';

export type CloseMode = 'with-risk' | 'full' | 'post-audit';
export const CLOSE_MODES: readonly CloseMode[] = ['with-risk', 'full', 'post-audit'];

/** The flow event (line "tasks") naming a production dispatch the close took back. */
export const CLOSE_RELEASED = 'close-released';

/** A mission's state: "open" until it is closed (a mission is created by its first records). */
export function missionState(db: Db, mission: string): 'open' | 'closed' {
  const r = db.stmt('SELECT state FROM missions WHERE mission = ?').get(mission) as { state: 'open' | 'closed' } | undefined;
  return r?.state ?? 'open';
}

/** Work that outlives the close (§6.7): marked by its flow (audit, delivery, repair, re-review), or an Auditor seat. */
export function allowedAfterClose(spec: { readonly afterClose?: string; readonly card: { readonly seat: string } }): boolean {
  return spec.afterClose !== undefined || spec.card.seat.startsWith('auditor');
}

/** Whether the mission's close holds this step: production work of a closed mission. */
export function heldByClose(db: Db, spec: TaskSpecDoc): boolean {
  return missionState(db, spec.mission) === 'closed' && !allowedAfterClose(spec);
}

/** The close a hand-back of this dispatch arrives after, when that makes it not accepted (claimed before a close without waitRunning, production work); else null. */
export function lateForClose(db: Db, info: DispatchInfo, spec: TaskSpecDoc): MissionClose | null {
  if (missionState(db, info.mission) !== 'closed' || allowedAfterClose(spec)) return null;
  const last = missionCloses(db, info.mission).at(-1);
  if (last === undefined || last.waitRunning) return null;
  return Number(info.claimedRevision) < Number(last.revision) ? last : null;
}

/** Inside a hand-back's write: the close takes the claim back (the seat ended: it handed back), the step is queued again (held while the mission is closed). */
export function takeBackForClose(tx: WriteTx, info: DispatchInfo, close: MissionClose): void {
  releaseDispatch(tx, { dispatch: info.dispatch, how: 'ended', requeue: true });
  appendRecords(tx, [{ kind: 'flow.event', mission: info.mission, line: TASKS_LINE, event: CLOSE_RELEASED, key: info.dispatch, body: tx.data.put(canonicalJson({ dispatch: info.dispatch, task: info.task, close: close.version })) as ContentHash }]);
}

/** Whether the close took this dispatch's claim back. */
export function takenBackByClose(db: Db, info: DispatchInfo): boolean {
  return flowEvents(db, { mission: info.mission, line: TASKS_LINE, event: CLOSE_RELEASED, limit: 10_000 }).some((e) => e.key === info.dispatch);
}

/** The revision of the mission's last state change (open, close), 0 when none. */
function lastStateRevision(db: Db, mission: string): number {
  const r = db.stmt("SELECT MAX(rev) AS r FROM log WHERE kind IN ('mission.state', 'mission.close') AND json_extract(record, '$.mission') = ?").get(mission) as { r: number | null } | undefined;
  return Number(r?.r ?? 0);
}

/** The operation id of a state change of a mission: the request names it, else the last state change it follows. */
function stateOp(ctx: ProcessContext, what: string, mission: string, req: { readonly request?: string | null; readonly words?: string | null }): string {
  if (req.request !== undefined && req.request !== null && req.request !== '') return `${what}:${mission}:req:${req.request}`;
  if (req.words !== undefined && req.words !== null && req.words !== '') return `${what}:${mission}:${req.words}`;
  return `${what}:${mission}:after:${ctx.memory.read((db) => lastStateRevision(db, mission))}`;
}

function body<T>(tx: WriteTx, h: string): T {
  return JSON.parse(tx.data.text(h)) as T;
}

/** The closing snapshot document (proof state, unfinished work, risks), read inside the close's write. */
function snapshotOf(tx: WriteTx, mission: MissionId, mode: CloseMode, waitRunning: boolean): { readonly doc: Record<string, unknown>; readonly notProven: readonly string[]; readonly unfinished: number; readonly recomputing: boolean } {
  const ev = (line: string, event: string) => flowEvents(tx, { mission, line, event, limit: 10_000 });
  // the outputs: the effective plans, the accepted products of the plan tasks, the settled explorations' artifacts
  const effective = ev(PLAN_LINE, 'effective').map((e) => body<{ dplan: string; tasks: readonly string[] }>(tx, e.body));
  const pmPlans = ev(PLAN_LINE, PM_PLAN_EFFECTIVE).map((e) => body<{ plan: string; explorations?: readonly string[] }>(tx, e.body));
  const tasks = [...new Set(effective.flatMap((e) => e.tasks))];
  const outputs: Array<{ object: string; kind: string; of: string }> = [];
  const unfinishedTasks: string[] = [];
  const abandoned: string[] = [];
  for (const t of tasks) {
    const line = taskLine(t);
    // given up under its current card (a re-planned card that was given up earlier runs again: execution.ts)
    const specRev = Number(ev(line, 'spec').at(-1)?.revision ?? 0);
    if (ev(line, 'abandoned').some((e) => Number(e.revision) > specRev)) {
      abandoned.push(t);
      continue;
    }
    const reworks = ev(line, 'rework').length;
    const acc = ev(line, 'accepted').find((e) => e.key === String(1 + reworks));
    if (acc === undefined) unfinishedTasks.push(t);
    else outputs.push({ object: body<{ product: string }>(tx, acc.body).product, kind: 'product', of: `task ${t}` });
  }
  const lastPlan = effective.at(-1);
  if (lastPlan !== undefined) outputs.push({ object: lastPlan.dplan, kind: 'plan', of: 'the effective detailed plan' });
  const explorations = [...new Set(pmPlans.flatMap((p) => p.explorations ?? []))];
  const unsettled: string[] = [];
  const residual: string[] = [];
  for (const x of explorations) {
    // the current settle (exploration machine): a rerun after an environment change reopens a settled exploration
    const st = fold(flowEvents(tx, { mission, line: explorationLine(x), limit: 10_000 }).map((e) => ({ event: e.event, key: e.key, body: body<unknown>(tx, e.body) })));
    if (st.settled === null) {
      unsettled.push(x);
      continue;
    }
    const b = st.settled.body;
    if (b.artifact !== null) outputs.push({ object: b.artifact, kind: 'exploration', of: `exploration ${x} (${b.outcome})` });
    for (const u of b.unresolved) residual.push(`exploration ${x}: ${u}`);
    if (b.outcome === 'no-conclusion') residual.push(`exploration ${x} ended without a conclusion (${b.stop})`);
  }
  const recomputing = labelStatus(tx).recomputing;
  const labels = outputs.length > 0 ? decisionLabels(tx, outputs.map((o) => o.object)) : {};
  const proof = outputs.map((o) => ({ ...o, label: labels[o.object] ?? null }));
  const notProven = proof.filter((p) => p.label !== 'proven').map((p) => `${p.object} (${p.of}): ${p.label ?? 'unknown'}`);
  // escalations still open (no applied mark, no user answer)
  const applied = new Set([...ev(SECRETARY_LINE, 'applied'), ...ev(SECRETARY_LINE, 'user-answer')].map((e) => e.key));
  const openEscalations = ev(SECRETARY_LINE, 'escalation')
    .filter((e) => !applied.has(e.key))
    .map((e) => body<{ id: string; subject: string; summary: string }>(tx, e.body))
    .map((e) => `${e.id} (${e.subject}): ${e.summary}`);
  const queued = taskQueue(tx, mission).map((q) => q.task);
  const running = listDispatches(tx, { mission, state: 'in-flight', limit: 10_000 }).map((d) => ({ dispatch: d.dispatch, task: d.task, seat: d.seat }));
  const risks = [
    ...notProven.map((x) => `not proven: ${x}`),
    ...unfinishedTasks.map((t) => `plan task ${t} not accepted`),
    ...abandoned.map((t) => `plan task ${t} abandoned`),
    ...unsettled.map((x) => `exploration ${x} not settled`),
    ...residual,
    ...openEscalations.map((e) => `open escalation ${e}`),
    ...running.map((r) => `dispatch ${r.dispatch} (${r.seat}, ${r.task}) in flight at the close${waitRunning ? ': its hand-back is accepted' : ': its hand-back will not be accepted'}`),
    ...(recomputing ? ['the labels were recomputing at the close: the proof states are the last stored ones'] : []),
  ];
  const doc = {
    format: 'mp41.close-snapshot.v1',
    mission,
    mode,
    waitRunning,
    proof,
    unfinished: { planTasks: unfinishedTasks, explorations: unsettled, queued, running, escalations: openEscalations },
    risks,
  };
  return { doc, notProven, unfinished: unfinishedTasks.length + unsettled.length + queued.length + running.length, recomputing };
}

export interface Closed {
  readonly mission: MissionId;
  readonly mode: CloseMode;
  readonly waitRunning: boolean;
  /** The closing snapshot's version (a new one on every close). */
  readonly version: number;
  readonly asOf: number;
  /** The snapshot document (data). */
  readonly snapshot: ContentHash;
  /** A retry of the same request: its recorded receipt, nothing written again. */
  readonly repeated: boolean;
  /** Dispatches of the mission in flight at the close: the PM stops them through its harness. */
  readonly inFlight: ReadonlyArray<{ readonly dispatch: string; readonly task: string; readonly seat: string }>;
  readonly risks: readonly string[];
  readonly message: string;
}

/**
 * `mp pm close <mission> --mode with-risk|full|post-audit [--wait-running] [--words W-n]` (§6.7):
 * `pmClose(ctx, mission, { mode, waitRunning, words, request })`. `request`: the caller's request
 * id (the CLI's `--op`; a retry of the same request replays its receipt).
 */
export function pmClose(ctx: ProcessContext, missionId: string, req: { readonly mode: CloseMode; readonly waitRunning?: boolean; readonly words?: string | null; readonly request?: string | null }): Closed {
  if (!CLOSE_MODES.includes(req.mode)) throw new LedgerError('BAD_REQUEST', 'the closing mode is with-risk, full or post-audit');
  const mission = missionId as MissionId;
  const waitRunning = req.waitRunning === true;
  // a close reads labels (§6.5): the current identity first, then one label batch
  ctx.environment();
  try {
    labelBatch(ctx.memory);
  } catch {
    /* the snapshot says so when they still recompute */
  }
  if (req.words !== undefined && req.words !== null && ctx.memory.read((db) => wordsEntry(db, req.words!)) === null) throw new LedgerError('RECORD_INVALID', `no words entry ${req.words}`);
  const known = ctx.memory.read((db) => db.stmt('SELECT 1 FROM missions WHERE mission = ?').get(mission) !== undefined || flowEvents(db, { mission, limit: 1 }).length > 0);
  if (!known) throw new LedgerError('BAD_REQUEST', `there is no mission ${mission}`);
  const op = stateOp(ctx, 'close', mission, req);
  let repeated = true;
  const out = ctx.memory.write({ op, payload: { mission, mode: req.mode, waitRunning, words: req.words ?? null, request: req.request ?? null }, command: 'close', filler: ctx.filler }, (tx) => {
    repeated = false;
    const s = snapshotOf(tx, mission, req.mode, waitRunning);
    if (req.mode === 'full') {
      if (s.recomputing) throw new LedgerError('RECOMPUTING', 'a full close needs the labels settled: they are recomputing (retry, or mp pm drain, WI-32)');
      if (s.notProven.length > 0 || s.unfinished > 0) {
        throw new ProcessError('NOT_READY', `a full close needs every output proven and nothing unfinished: ${[...s.notProven.map((x) => `not proven ${x}`), ...(s.unfinished > 0 ? [`${s.unfinished} unfinished item(s)`] : [])].join('; ')}. Close with-risk or post-audit, or finish the work`);
      }
    }
    const snapshot = tx.data.put(canonicalJson(s.doc)) as ContentHash;
    const c = closeMission(tx, { mission, mode: req.mode, waitRunning, snapshot });
    const running = (s.doc['unfinished'] as { running: Array<{ dispatch: string; task: string; seat: string }> }).running;
    return { version: c.version, asOf: c.asOf, snapshot, inFlight: running, risks: s.doc['risks'] as string[] };
  });
  const inFlight = out.inFlight;
  const message = [
    `Mission ${mission} closed (${req.mode}): closing snapshot ${out.version} as of event ${out.asOf}${repeated ? ' (already recorded: this is its receipt)' : ''}.`,
    `${out.risks.length} risk(s) on the snapshot.`,
    'Production steps of the mission are held; audits, deliveries and fixes after an audit go on.',
    ...(inFlight.length > 0
      ? [
          `${inFlight.length} dispatch${inFlight.length === 1 ? ' was' : 'es were'} in flight: ${inFlight.map((d) => `${d.dispatch} (${d.seat})`).join(', ')}. ${waitRunning ? 'Their hand-backs are accepted (wait-running).' : 'Stop them in your harness, then mp pm release <id> --ended; a hand-back that still arrives is recorded but not accepted.'}`,
        ]
      : []),
  ].join('\n');
  return { mission, mode: req.mode, waitRunning, version: out.version, asOf: out.asOf, snapshot: out.snapshot, repeated, inFlight, risks: out.risks, message };
}

/**
 * `mp pm mission <id>` (open) / closed. Opening a closed mission lets its held steps run again.
 * Closing goes through pmClose (with-risk unless a mode is given). A mission already open is not
 * written again.
 */
export function pmMission(
  ctx: ProcessContext,
  mission: string,
  state: 'open' | 'closed' = 'open',
  o: { readonly request?: string | null; readonly mode?: CloseMode; readonly waitRunning?: boolean; readonly words?: string | null } = {},
): { readonly mission: MissionId; readonly state: 'open' | 'closed'; readonly changed: boolean; readonly close?: Closed } {
  const m = mission as MissionId;
  if (state === 'closed') {
    const close = pmClose(ctx, mission, { mode: o.mode ?? 'with-risk', ...(o.waitRunning !== undefined ? { waitRunning: o.waitRunning } : {}), ...(o.words !== undefined ? { words: o.words } : {}), ...(o.request !== undefined ? { request: o.request } : {}) });
    return { mission: m, state: 'closed', changed: !close.repeated, close };
  }
  if (state !== 'open') throw new LedgerError('BAD_REQUEST', 'a mission is open or closed');
  const op = stateOp(ctx, 'mission-open', mission, o);
  let changed = false;
  ctx.memory.write({ op, payload: { mission, state, request: o.request ?? null, words: o.words ?? null }, command: 'mission', filler: ctx.filler }, (tx) => {
    const exists = tx.stmt('SELECT state FROM missions WHERE mission = ?').get(mission) as { state: string } | undefined;
    if (exists?.state === 'open') return { mission: m, state };
    // the steps the close held are in the queue (a dispatch it took back was queued again): they run again
    setMission(tx, m, 'open');
    changed = true;
    return { mission: m, state };
  });
  return { mission: m, state: 'open', changed };
}
