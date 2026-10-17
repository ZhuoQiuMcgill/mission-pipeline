// Closing a mission (design 4.1 §6.7, v51 §6.6 kept; 4.1.2 D-9, D-11): closing and delivery are
// separate; an immutable closing snapshot; production stops, post-close work goes on.
//
// 4.1.2 (D-11): closing is the user's decision and is never refused on the state of the work. Every
// mode writes the same honest snapshot and only records its name (with-risk, full, post-audit, kept
// for compatibility): what was delivered with its labels, what is unfinished or not proven, the
// open and deferred issues, the start risks, the outputs proven in an older environment, the
// repairs made in the mission, the full-run status of the delivered tree, and whether the labels
// were still recomputing (one bounded label batch runs first; if they are not settled the close
// goes on and says so). Refusals that are not about the work stay: a bad mode, an unknown mission,
// a words entry that does not exist.
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
import { decisionLabels, decidingViews, labelBatch, labelStatus, olderEnvironmentProof } from '../evaluator/index.ts';
import { appendRecords, closeMission, currentDelivery, factById, flowEvents, LedgerError, listDispatches, missionCloses, releaseDispatch, setMission, taskQueue, wordsEntry, type Db, type DispatchInfo, type MissionClose, type WriteTx } from '../memory/index.ts';
import { deliveryDocument } from '../delivery/delivery.ts';
import { PLAN_LINE, PM_PLAN_EFFECTIVE, SECRETARY_LINE, explorationLine, taskLine } from '../flow/plandoc.ts';
import { acceptedStartOf, lineAcceptance } from '../flow/execution.ts';
import { flowCtx } from '../flow/context.ts';
import { fold } from '../flow/exploration/machine.ts';
import { repairsOf } from '../flow/repair.ts';
import type { ProcessContext } from './context.ts';
import { fullRunStatus, type FullRunStatus } from './fullRuns.ts';
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

type CheckedStarts = ReadonlyMap<string, Awaited<ReturnType<typeof acceptedStartOf>>>;

/** One repair of the mission as the closing snapshot lists it (D-10; flow/repair.ts repairsOf, the one resolver). */
export interface RepairEntry {
  readonly repair: string;
  /** The kind the PM chose. */
  readonly kind: string;
  /** The user's reason, verbatim from the words entry. */
  readonly text: string;
  readonly words: string | null;
  /** What it is about ("task <id>", "exploration <id>"), or null: the plan in effect as a whole. */
  readonly about: string | null;
  /** Where it stands: decided (amended and/or reopened), architect (its Architect step is under way), exploration (one more round), waiting. */
  readonly state?: string;
  /** The tasks it added to the plan in effect, and the tasks it reopened. */
  readonly added?: readonly string[];
  readonly reopened?: readonly string[];
}

/** The mission's repairs for the closing snapshot, read through the flow's resolver (repairsOf). */
async function closingRepairs(ctx: ProcessContext, mission: MissionId): Promise<RepairEntry[]> {
  return (await repairsOf(flowCtx(ctx.ports(), mission))).map((r) => ({ repair: r.id, kind: r.kind, text: r.text, words: r.words, about: r.about === null ? null : `${r.about.kind} ${r.about.id}`, state: r.state, added: [...r.added], reopened: [...r.reopened] }));
}

/** What the close reads before its write (git, and resolvers on the context): the delivered tree's full-run status, the repairs. */
interface CloseInputs {
  readonly words: string | null;
  /** The mission's current delivery as read before the write, with its tree and the full-run status of that tree. */
  readonly delivered: { readonly delivery: string; readonly tree: string | null; readonly fullRun: FullRunStatus | null } | null;
  readonly repairs: readonly RepairEntry[];
}

/** The closing snapshot document (4.1.2: the honest state of the work, fields added to v1; nothing in it refuses the close). */
export interface CloseSnapshot {
  readonly format: 'mp41.close-snapshot.v1';
  readonly mission: string;
  readonly mode: CloseMode;
  readonly waitRunning: boolean;
  /** The words the close cites (W-<n>), or null. */
  readonly words: string | null;
  readonly proof: ReadonlyArray<{ readonly object: string; readonly kind: string; readonly of: string; readonly label: string | null }>;
  /** The mission's current delivery: what it delivered, with the labels at delivery and now. */
  readonly delivered: {
    readonly delivery: string;
    readonly commit: string;
    readonly state: string;
    /**
     * `label`: the version's own label now; `notFullyProven`: the reasons the delivery's own proof check on the
     * delivered tree gave (a user commit inside its write scope, a prerequisite missing...), null when it passed.
     */
    readonly entries: ReadonlyArray<{ readonly object: string; readonly unit: string | null; readonly atDelivery: string; readonly label: string | null; readonly notFullyProven?: readonly string[] | null }>;
  } | null;
  readonly unfinished: { readonly planTasks: readonly string[]; readonly explorations: readonly string[]; readonly queued: readonly string[]; readonly running: ReadonlyArray<{ readonly dispatch: string; readonly task: string; readonly seat: string }>; readonly escalations: readonly string[] };
  /** Open and deferred issues on the selected versions. */
  readonly issues: readonly string[];
  readonly startRisks: readonly string[];
  /** Proven outputs whose deciding runs were recorded under an older environment identity. */
  readonly olderEnvironment: readonly string[];
  readonly repairs: readonly RepairEntry[];
  /** The full-run status against the delivered tree (null: no delivery, or the delivery changed while closing). */
  readonly fullRun: { readonly tree: string | null; readonly line: string; readonly status: FullRunStatus | null } | null;
  readonly labelsRecomputing: boolean;
  readonly risks: readonly string[];
}

/** The closing snapshot document (proof state, unfinished work, risks), read inside the close's write. */
function snapshotOf(tx: WriteTx, mission: MissionId, mode: CloseMode, waitRunning: boolean, checked: CheckedStarts, inputs: CloseInputs): CloseSnapshot {
  const ev = (line: string, event: string) => flowEvents(tx, { mission, line, event, limit: 10_000 });
  // the outputs: the effective plans, the accepted products of the plan tasks, the settled explorations' artifacts
  // (4.1.2: a repair's amendment is an "effective" event of the plan in effect listing the tasks it added,
  // plandoc.ts amendedPlan: they are read here as the plan's own)
  const effective = ev(PLAN_LINE, 'effective').map((e) => body<{ dplan: string; tasks: readonly string[] }>(tx, e.body));
  const pmPlans = ev(PLAN_LINE, PM_PLAN_EFFECTIVE).map((e) => body<{ plan: string; explorations?: readonly string[] }>(tx, e.body));
  const tasks = [...new Set(effective.flatMap((e) => e.tasks))];
  const outputs: Array<{ object: string; kind: string; of: string }> = [];
  const unfinishedTasks: string[] = [];
  const abandoned: string[] = [];
  const startRisks: string[] = [];
  for (const t of tasks) {
    const selected = lineAcceptance(flowEvents(tx, { mission, line: taskLine(t), limit: 10_000 }).map((e) => ({ revision: Number(e.revision), event: e.event, key: e.key, body: body<unknown>(tx, e.body) })));
    if (selected.abandoned) { abandoned.push(t); continue; }
    if (selected.product === null) { unfinishedTasks.push(t); continue; }
    const start = checked.get(t);
    let risk: string | null = null;
    if (start === undefined || start === null || start.product !== selected.product) risk = 'changed while closing; retry';
    else if (start.verdict === 'lacks') risk = `start lacks ${[...start.missing.map((m) => `${m.prerequisite} at ${m.path}`), ...start.rejected.map((p) => `${p} (its recorded start lacks a prerequisite)`)].join(', ')}; one carried rebuild on mp pm next`;
    else if (start.verdict === 'unreadable') risk = 'start cannot be read (legacy-prerequisites-unavailable); restore the local objects and retry';
    if (risk !== null) {
      unfinishedTasks.push(t);
      startRisks.push(`${selected.product} (task ${t}): ${risk}`);
    } else outputs.push({ object: selected.product, kind: 'product', of: `task ${t}` });
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
  // v51 §5.6: list the evaluator's stored states on the versions actually selected.
  // The deciding judgments supply deferral context; they do not recompute issue states here.
  const issueRisks: string[] = [];
  for (const output of outputs.filter((o) => o.kind === 'product')) {
    const states = tx.stmt("SELECT issue, state FROM lbl_fixes WHERE target = ? AND state <> 'fixed' ORDER BY issue").all(output.object) as Array<{ issue: string; state: string }>;
    if (states.length === 0) continue;
    const positions = decidingViews(tx, [output.object]).views.get(output.object)?.positions ?? [];
    const judgments = positions.flatMap((p) => {
      const r = p.by === null ? null : factById(tx, 'judgment', p.by)?.record;
      return r?.kind === 'judgment' ? [r] : [];
    });
    for (const state of states) {
      const deferred = judgments.flatMap((j) => j.issues).find((a) => a.issue === state.issue && a.response === 'deferred');
      let disposition = state.state;
      if (deferred !== undefined) {
        let reason: string = deferred.reason!;
        try {
          const text = tx.data.text(reason);
          try { reason = (JSON.parse(text) as { reason?: string }).reason ?? text; } catch { reason = text; }
        } catch { /* older records can retain their reason hash */ }
        disposition = `deferred to ${deferred.owner}: ${reason}`;
      }
      issueRisks.push(`issue ${state.issue} on ${output.object}: ${disposition}`);
    }
  }
  // proven outputs whose deciding runs are from an older environment identity (shown, never re-checked
  // here): the one resolver every read labels them with (renew.ts olderEnvironmentProof)
  const olderTargets = proof.some((p) => p.label === 'proven') ? olderEnvironmentProof(tx).targets : new Set<string>();
  const olderEnvironment = proof.filter((p) => p.label === 'proven' && olderTargets.has(p.object)).map((p) => p.object);
  // the mission's current delivery, read in this write; its full-run status was read before it (git)
  const cur = currentDelivery(tx, mission);
  const dd = cur === null ? null : deliveryDocument(tx.data, cur);
  const now = dd === null || dd.entries.length === 0 ? {} : decisionLabels(tx, dd.entries.map((e) => e.id));
  // what the delivery's own proof check recorded on the delivered tree stands for each output (nothing is re-run)
  const nfp = new Map((dd?.notFullyProven ?? []).map((n) => [n.id, n.reasons]));
  const delivered: CloseSnapshot['delivered'] = cur === null ? null : { delivery: cur.delivery, commit: cur.commit, state: cur.state, entries: (dd?.entries ?? []).map((e) => ({ object: e.id, unit: e.unit, atDelivery: e.label, label: now[e.id] ?? null, notFullyProven: nfp.get(e.id) ?? null })) };
  const deliveredNotProven = (delivered?.entries ?? []).filter((e) => e.notFullyProven != null).map((e) => `${e.object} (delivered in ${delivered!.delivery}): not fully proven on the delivered tree (${e.notFullyProven!.join(', ') || 'no reason recorded'})`);
  const same = cur !== null && inputs.delivered !== null && inputs.delivered.delivery === cur.delivery;
  const fullRun: CloseSnapshot['fullRun'] = cur === null ? null : same ? { tree: inputs.delivered!.tree, line: inputs.delivered!.fullRun !== null ? fullRunLine(inputs.delivered!.fullRun) : 'full-run status unknown: the delivered tree could not be read', status: inputs.delivered!.fullRun } : { tree: null, line: `full-run status not read: delivery ${cur.delivery} was recorded while closing`, status: null };
  const risks = [
    ...startRisks,
    ...notProven.map((x) => `not proven: ${x}`),
    ...deliveredNotProven.map((x) => `not proven: ${x}`),
    ...issueRisks,
    ...unfinishedTasks.map((t) => `plan task ${t} not accepted`),
    ...abandoned.map((t) => `plan task ${t} abandoned`),
    ...unsettled.map((x) => `exploration ${x} not settled`),
    ...residual,
    ...openEscalations.map((e) => `open escalation ${e}`),
    ...running.map((r) => `dispatch ${r.dispatch} (${r.seat}, ${r.task}) in flight at the close${waitRunning ? ': its hand-back is accepted' : ': its hand-back will not be accepted'}`),
    ...olderEnvironment.map((o) => `proven in an older environment: ${o}`),
    ...(recomputing ? ['labels were recomputing at close: the proof states are the last stored ones'] : []),
  ];
  return {
    format: 'mp41.close-snapshot.v1',
    mission,
    mode,
    waitRunning,
    words: inputs.words,
    proof,
    delivered,
    unfinished: { planTasks: unfinishedTasks, explorations: unsettled, queued, running, escalations: openEscalations },
    issues: issueRisks,
    startRisks,
    olderEnvironment,
    repairs: inputs.repairs,
    fullRun,
    labelsRecomputing: recomputing,
    risks,
  };
}

/** The full-run status as one line (D-7): "full suite last run <when> on this tree: passed", "... not run since ...", "never run". */
export function fullRunLine(s: FullRunStatus): string {
  if (s.last === null) return 'full suite never run';
  const when = new Date(s.last.endedAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  if (s.sameTree) return `full suite last run ${when} on this tree: ${s.last.passed ? 'passed' : `failed${s.last.failing.length > 0 ? ` (${s.last.failing.map((f) => f.id).join(', ')})` : ''}`}`;
  const marker = `the run of ${when} on ${s.last.commit.slice(0, 12)} (${s.last.passed ? 'passed' : 'failed'})`;
  if (s.changedSince === null) return `full suite not run on this tree; last: ${marker}`;
  const paths = s.changedSince.paths;
  return `full suite not run since ${marker}: ${s.changedSince.products.length} products, ${paths.length === 0 ? 'no paths' : `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` and ${paths.length - 5} more` : ''}`} changed`;
}

/** The closing snapshot as lines for people (`mp pm close`, `mp pm finish`): the honest state, never a verdict. */
export function snapshotLines(snap: CloseSnapshot): string[] {
  const list = (head: string, xs: readonly string[] | undefined, none = 'none'): string => `${head}: ${xs === undefined ? 'not recorded (a close before 4.1.2)' : xs.length === 0 ? none : xs.join('; ')}`;
  // a snapshot written before 4.1.2 lacks the newer fields: shown as not recorded, never as "none"
  const d = { ...snap, delivered: snap.delivered ?? null, fullRun: snap.fullRun ?? null, labelsRecomputing: snap.labelsRecomputing === true };
  const notProven = [
    ...d.proof.filter((p) => p.label !== 'proven').map((p) => `${p.object} (${p.of}): ${p.label ?? 'unknown'}`),
    ...(d.delivered?.entries ?? []).filter((e) => e.notFullyProven != null).map((e) => `${e.object} (delivered in ${d.delivered!.delivery}): not fully proven on the delivered tree (${e.notFullyProven!.join(', ') || 'no reason recorded'})`),
  ];
  return [
    snap.delivered === undefined
      ? 'Delivered: not recorded (a close before 4.1.2)'
      : d.delivered === null
      ? 'Delivered: nothing (no delivery in this mission)'
      : `Delivered: ${d.delivered.delivery} at ${d.delivered.commit.slice(0, 12)}${d.delivered.state !== 'recorded' ? ` (${d.delivered.state})` : ''}: ${d.delivered.entries.map((e) => `${e.object} ${e.label ?? 'unknown'}${e.label !== e.atDelivery ? ` (at delivery: ${e.atDelivery})` : ''}${e.notFullyProven != null ? ', delivered as not fully proven' : ''}`).join(', ') || 'no entries'}`,
    list('Unfinished', [...d.unfinished.planTasks.map((t) => `plan task ${t}`), ...d.unfinished.explorations.map((x) => `exploration ${x}`), ...d.unfinished.queued.map((q) => `step ${q} queued`), ...d.unfinished.running.map((r) => `${r.dispatch} in flight (${r.seat})`), ...d.unfinished.escalations.map((e) => `escalation ${e}`)]),
    list('Not proven', notProven),
    list('Open or deferred issues', d.issues),
    list('Start risks', d.startRisks),
    list('Proven in an older environment', d.olderEnvironment),
    list('Repairs', d.repairs?.map((r) => `${r.repair} (${r.kind}${r.words !== null ? `, ${r.words}` : ''}${r.about !== null ? `, about ${r.about}` : ''}): ${r.text}${r.state !== undefined ? ` [${r.state}${(r.added ?? []).length > 0 ? `; added ${r.added!.join(', ')}` : ''}${(r.reopened ?? []).length > 0 ? `; reopened ${r.reopened!.join(', ')}` : ''}]` : ''}`)),
    `Full suite: ${d.fullRun === null ? (snap.fullRun === undefined ? 'not recorded (a close before 4.1.2)' : 'no delivered tree to compare') : d.fullRun.line}`,
    ...(d.labelsRecomputing ? ['Labels were recomputing at close: the proof states above are the last stored ones.'] : []),
  ];
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
  /** The snapshot document itself (the honest state the close recorded). */
  readonly doc: CloseSnapshot;
  readonly message: string;
}

/** The mission's current delivery with its tree and the full-run status of that tree (read before the close's write: git, P1's resolver). */
function deliveredInputs(ctx: ProcessContext, mission: MissionId): CloseInputs['delivered'] {
  const cur = ctx.memory.read((db) => currentDelivery(db, mission));
  if (cur === null) return null;
  let tree = deliveryDocument(ctx.memory.data, cur)?.tree ?? null;
  if (tree === null) {
    const r = ctx.git.runSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `${cur.commit}^{tree}`], { cwd: ctx.projectDir });
    tree = r.code === 0 ? r.stdout.toString('utf8').trim() : null;
  }
  return { delivery: cur.delivery, tree, fullRun: tree === null ? null : fullRunStatus(ctx, mission, tree) };
}

/**
 * `mp pm close <mission> [--mode with-risk|full|post-audit] [--words W-n]` (§6.7; 4.1.2, D-11):
 * `pmClose(ctx, mission, { mode, waitRunning, words, request })`. `request`: the caller's request id
 * (the CLI's `--op`; a retry of the same request replays its receipt). Never refused on the state of
 * the work: every mode records the same honest snapshot and its name.
 */
export async function pmClose(ctx: ProcessContext, missionId: string, req: { readonly mode: CloseMode; readonly waitRunning?: boolean; readonly words?: string | null; readonly request?: string | null }): Promise<Closed> {
  if (!CLOSE_MODES.includes(req.mode)) throw new LedgerError('BAD_REQUEST', 'the closing mode is with-risk, full or post-audit');
  const mission = missionId as MissionId;
  const waitRunning = req.waitRunning === true;
  // a close reads labels (§6.5): the current identity first, then one bounded label batch; labels
  // still recomputing after it do not hold the close: the snapshot says so (D-11)
  ctx.environment();
  try {
    labelBatch(ctx.memory);
  } catch {
    /* the snapshot says so when they still recompute */
  }
  if (req.words !== undefined && req.words !== null && ctx.memory.read((db) => wordsEntry(db, req.words!)) === null) throw new LedgerError('RECORD_INVALID', `no words entry ${req.words}`);
  const known = ctx.memory.read((db) => db.stmt('SELECT 1 FROM missions WHERE mission = ?').get(mission) !== undefined || flowEvents(db, { mission, limit: 1 }).length > 0);
  if (!known) throw new LedgerError('BAD_REQUEST', `there is no mission ${mission}`);
  const tasks = ctx.memory.read((db) => [...new Set(flowEvents(db, { mission, line: PLAN_LINE, event: 'effective', limit: 10_000 }).flatMap((e) => (JSON.parse(ctx.memory.data.text(e.body)) as { tasks: string[] }).tasks))]);
  const fc = flowCtx(ctx.ports(), mission);
  const checked = new Map<string, Awaited<ReturnType<typeof acceptedStartOf>>>();
  for (const task of tasks) checked.set(task, await acceptedStartOf(fc, task));
  const inputs: CloseInputs = { words: req.words ?? null, delivered: deliveredInputs(ctx, mission), repairs: await closingRepairs(ctx, mission) };
  const op = stateOp(ctx, 'close', mission, req);
  let repeated = true;
  const out = ctx.memory.write({ op, payload: { mission, mode: req.mode, waitRunning, words: req.words ?? null, request: req.request ?? null }, command: 'close', filler: ctx.filler }, (tx) => {
    repeated = false;
    const doc = snapshotOf(tx, mission, req.mode, waitRunning, checked, inputs);
    const snapshot = tx.data.put(canonicalJson(doc)) as ContentHash;
    const c = closeMission(tx, { mission, mode: req.mode, waitRunning, snapshot });
    return { version: c.version, asOf: c.asOf, snapshot, inFlight: doc.unfinished.running, risks: doc.risks };
  });
  // the document as recorded (a replayed receipt reads the snapshot it names)
  const doc = JSON.parse(ctx.memory.data.text(out.snapshot)) as CloseSnapshot;
  const inFlight = out.inFlight;
  const message = [
    `Mission ${mission} closed (${req.mode})${doc.words != null ? ` on ${doc.words}` : ''}: closing snapshot ${out.version} as of event ${out.asOf}${repeated ? ' (already recorded: this is its receipt)' : ''}.`,
    ...snapshotLines(doc).map((l) => `  ${l}`),
    `${out.risks.length} risk(s) on the snapshot.`,
    'Production steps of the mission are held; audits, deliveries and fixes after an audit go on.',
    ...(inFlight.length > 0
      ? [
          `${inFlight.length} dispatch${inFlight.length === 1 ? ' was' : 'es were'} in flight: ${inFlight.map((d) => `${d.dispatch} (${d.seat})`).join(', ')}. ${waitRunning ? 'Their hand-backs are accepted (wait-running).' : 'Stop them in your harness, then mp pm release <id> --ended; a hand-back that still arrives is recorded but not accepted.'}`,
        ]
      : []),
  ].join('\n');
  return { mission, mode: req.mode, waitRunning, version: out.version, asOf: out.asOf, snapshot: out.snapshot, repeated, inFlight, risks: out.risks, doc, message };
}

type MissionStateResult = { readonly mission: MissionId; readonly state: 'open' | 'closed'; readonly changed: boolean; readonly close?: Closed };
type MissionOptions = { readonly request?: string | null; readonly mode?: CloseMode; readonly waitRunning?: boolean; readonly words?: string | null };

/**
 * `mp pm mission <id>` (open) / closed. Opening a closed mission lets its held steps run again.
 * Closing goes through pmClose (with-risk unless a mode is given). A mission already open is not
 * written again.
 */
export function pmMission(ctx: ProcessContext, mission: string, state?: 'open', o?: MissionOptions): MissionStateResult;
export function pmMission(ctx: ProcessContext, mission: string, state: 'closed', o?: MissionOptions): Promise<MissionStateResult>;
export function pmMission(ctx: ProcessContext, mission: string, state: 'open' | 'closed', o?: MissionOptions): MissionStateResult | Promise<MissionStateResult>;
export function pmMission(
  ctx: ProcessContext,
  mission: string,
  state: 'open' | 'closed' = 'open',
  o: { readonly request?: string | null; readonly mode?: CloseMode; readonly waitRunning?: boolean; readonly words?: string | null } = {},
): MissionStateResult | Promise<MissionStateResult> {
  const m = mission as MissionId;
  if (state === 'closed') {
    return pmClose(ctx, mission, { mode: o.mode ?? 'with-risk', ...(o.waitRunning !== undefined ? { waitRunning: o.waitRunning } : {}), ...(o.words !== undefined ? { words: o.words } : {}), ...(o.request !== undefined ? { request: o.request } : {}) }).then((close) => ({ mission: m, state: 'closed', changed: !close.repeated, close }));
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
