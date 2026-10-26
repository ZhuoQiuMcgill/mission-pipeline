// The read-depth rule (v51 §10.2, the maintainer's ruling of 2026-10-08, kept by design 4.1 §8):
//
//   "How is it going?"   one query (`mp read status`): layer 0; plus the layer-1 entries of exactly
//                        the subtasks whose state changed since the user last asked (a failure, a
//                        refutation, a cancellation or an exploration's conclusion is a change, not
//                        only a completion). Nothing changed: layer 0 only. The count of the
//                        persistently blocked subtasks is always in layer 0.
//   "Why is it not done?" (`mp read blocked`): the layer-1 entries of every blocked subtask, each with
//                        its block reason and its next step.
//   "The details of X"   (`mp read show <kind> <id>`): layer 2, only for X. Evidence: layer 3
//                        (`mp read leaf`).
//
// One resolver (resolveSubtasks) reads each subtask's current state once per query; the changed
// list, the layer-0 count and `mp read blocked` all come from that one result. It notes the head it
// started from: the cursor moves to that head, so a change that lands while the answer is built is
// shown again next time, never lost.
//
// A subtask is a requirement item, a task of a detailed plan, or an exploration; a decision-layer
// step (or plan) that is blocked gets an entry of its own. Each is found from what produced it, with
// the producers' own encoders: a plan task's line is taskLine(id) and its steps' lineage
// taskLineage(mission, id) (ids taken from the plans in effect); an exploration's line is
// explorationLine(x) and its steps are the tasks its queued events name; an escalation belongs to
// the subtask its `subject` names. Its layer-1 entry: its state label, the time of its last change
// and, when blocked, one line "blocked because … / next: …".
//
// A task's state: its line's events, its steps' dispatches, and its current product's stored
// proof label (e.g. "accepted, product basis-withdrawn"); its last change is the newest of the
// three (the label's revision included), so a refutation or a withdrawn basis is a change too.
// An exploration's state is the exploration machine's current state (explorationState): it is
// "concluded" only while it has a current settle (the one recorded since it last reopened, the
// flow's own record: one per opening); while a rerun after an environment change has reopened it,
// the machine's state comes first and the last recorded conclusion follows as history. A current
// conclusion that replaced an earlier one names it as history. A shown conclusion carries its
// product's stored proof label, whose revision counts as a change.
// The Secretary step of an escalation belongs to the subtask the escalation is about.
//
// Blocked = not progressing for a reason outside its own work:
//   - an open escalation about it (not yet carried out; `constructor-decision` excepted: that one
//     is part of the flow) while the flow that raised it still consumes it (a task in the latest
//     effective plan, the latest PM batch, any exploration): a used-up loop (WI-08), a ruling an
//     exploration awaits (WI-33), a disposition after a stop, a decision waiting on the user. Its
//     next step follows the flow's own rules: waiting on the user as `mp pm next` lists it →
//     `mp pm answer`; a decision to carry out (decisionFor) → the next `mp pm next`; its Secretary
//     in flight → wait for its hand-back; else the Secretary's step;
//   - a step held by a stop, a closed mission, the git-writes hold or a lease (what `mp pm next`
//     computes), a dispatch in flight under a stop, a hand-back that arrived after a stop, a
//     dispatch in flight longer than IN_FLIGHT_BLOCKED_MS without a hand-back (WI-28).
// One subtask with several reasons is one blocked entry. The labels recomputing is a project
// line, not a subtask.

import type { MissionId } from '../common/ids.ts';
import { labelStatus, OLDER_ENVIRONMENT, olderEnvironmentProof } from '../evaluator/index.ts';
import { flowCtx } from '../flow/context.ts';
import { bySeat, taskLineage } from '../flow/execution.ts';
import { latestEffective } from '../flow/planning.ts';
import { explorationState } from '../flow/exploration/flow.ts';
import type { SettleRecord } from '../flow/exploration/machine.ts';
import { PLAN_LINE, PM_PLAN_EFFECTIVE, REQUIREMENTS_LINE, SECRETARY_LINE, explorationLine, taskLine } from '../flow/plandoc.ts';
import { decisionFor } from '../flow/secretary.ts';
import { activeStopScopes, stopCovers, type Db } from '../memory/index.ts';
import { purposeOf, readSteps, type ProcessContext } from '../process/index.ts';
import { age, clip } from './render.ts';

/** A dispatch in flight this long without a hand-back counts as blocked (its seat may have ended: WI-28). */
export const IN_FLIGHT_BLOCKED_MS = 60 * 60_000;

export interface Layer1Entry {
  readonly kind: 'requirement' | 'task' | 'exploration' | 'plan' | 'step';
  /** The requirement line, the plan task id, the exploration id, the plan object, a seat step's id. */
  readonly id: string;
  readonly mission: string | null;
  readonly title: string;
  readonly label: string;
  /** The time and revision of its last change (null / 0: never changed). */
  readonly changedAt: number | null;
  readonly changedRev: number;
  readonly blocked: { readonly because: string; readonly next: string; readonly wi: string | null } | null;
}

/** What one query resolved: every subtask once, the blocked ones, the project-level waits, and the head it started from. */
export interface Resolved {
  readonly head: number;
  readonly entries: readonly Layer1Entry[];
  readonly blocked: readonly Layer1Entry[];
  /** The labels recomputing: every decision that needs "proven" waits (a project line, not a subtask). */
  readonly recomputing: { readonly because: string; readonly next: string; readonly wi: string | null } | null;
  /** Whether the flows still consume an escalation on this subject (layer 0's "Waiting on the user" uses it too). */
  readonly inScope: (mission: string, subject: string) => boolean;
}

type Json = Record<string, any>;

interface Flow {
  readonly mission: string;
  readonly line: string;
  readonly event: string;
  readonly key: string;
  readonly body: Json;
  readonly rev: number;
}

interface Step {
  readonly task: string;
  readonly lineage: string;
  readonly mission: string;
  readonly card: Json;
  readonly state: string;
  readonly queuedRev: number;
  readonly queuedAt: number;
}

interface Dispatch {
  readonly dispatch: string;
  readonly task: string;
  readonly seat: string;
  readonly state: string;
  readonly handback: string | null;
  readonly mission: string;
  readonly capabilities: readonly string[];
  readonly createdAt: number;
  /** The newest of its claim, hand-back and release. */
  readonly rev: number;
}

const TASK_LABEL: Readonly<Record<string, (b: Json) => string>> = {
  spec: () => 'planned',
  dispatched: (b) => `building (attempt ${String(b['k'] ?? 1)})`,
  product: (b) => `built (attempt ${String(b['k'] ?? 1)}), verifying`,
  verified: (b) => (((b['runs'] ?? []) as Json[]).every((r) => r['passed'] === true) ? 'verified, in review' : 'verification failed'),
  review: (b) => (b['verdict'] === 'pass' ? 'review passed' : b['verdict'] === 'rework' ? 'review: rework' : `review: ${String(b['verdict'] ?? '?')}`),
  rework: (b) => `rework (attempt ${String(b['k'] ?? '?')}${b['reason'] ? `, ${String(b['reason'])}` : ''})`,
  accepted: () => 'accepted',
  reaccepted: () => 'accepted again (a re-review)',
  'loop-verdict': (b) => (b['proceed'] === false ? `reworks used up (${String(b['attempts'] ?? '?')} of ${String(b['allowed'] ?? '?')}${b['reason'] === 'no-progress' ? ', the same issues twice in a row' : ''})` : `rework allowed (${String(b['attempts'] ?? '?')} of ${String(b['allowed'] ?? '?')})`),
  rereview: (b) => `accepted, in re-review ${String(b['n'] ?? '?')} (its runs recorded again)`,
  'basis-revised': () => 'accepted, a basis has a new version: re-review pending',
  rebind: (b) => bySeat(b) ? `accepted, re-bound to the plan in effect ${String(b['dplan'] ?? '')}: in review` : 'accepted; carried re-bind kept as history',
  rebound: (b) => bySeat(b) ? 'accepted, re-bound to the plan in effect (judged again)' : 'accepted; carried re-bind kept as history',
  abandoned: () => 'abandoned',
  dropped: () => 'dropped by a re-plan',
  'waiting-replan': () => 'waiting for a re-plan',
  reanswer: () => 'answered by the decision layer',
};

/** The WI an open escalation's source names (null: none beyond the Secretary's step). */
const ESCALATION_WI: Readonly<Record<string, string>> = {
  'loop-exhausted': 'WI-08',
  'exploration-budget': 'WI-08',
  'exploration-repeated-fatal': 'WI-08',
  'exploration-direction': 'WI-33',
};

/** Resolve every subtask's current state once, with the blocked ones (one entry per subtask). */
export async function resolveSubtasks(ctx: ProcessContext): Promise<Resolved> {
  const head = Number(ctx.memory.head());
  const now = ctx.now();
  const ports = ctx.ports();
  const data = ctx.memory.data;
  const parse = (h: string): Json => {
    try {
      return JSON.parse(data.text(h)) as Json;
    } catch {
      return {};
    }
  };
  const raw = ctx.memory.read((db: Db) => {
    const flows: Flow[] = (
      db.stmt('SELECT mission, line, event, key, body, revision FROM flow_events ORDER BY revision').all() as Array<{ mission: string; line: string; event: string; key: string; body: string; revision: number }>
    )
      .filter((r) => r.line === REQUIREMENTS_LINE || r.line === PLAN_LINE || r.line === SECRETARY_LINE || r.line.startsWith('task:') || r.line.startsWith('exploration:'))
      .map((r) => ({ mission: r.mission, line: r.line, event: r.event, key: r.key, body: parse(r.body), rev: Number(r.revision) }));
    const steps: Step[] = (db.stmt('SELECT task, lineage, mission, card, state, queued_rev, queued_at FROM tasks ORDER BY queued_rev').all() as Array<Json>).map((r) => ({
      task: String(r['task']),
      lineage: String(r['lineage']),
      mission: String(r['mission']),
      card: (parse(String(r['card']))['card'] ?? {}) as Json,
      state: String(r['state']),
      queuedRev: Number(r['queued_rev']),
      queuedAt: Number(r['queued_at']),
    }));
    const revs = new Map<string, number>();
    for (const r of db.stmt("SELECT rev, json_extract(record, '$.dispatch') AS d FROM log WHERE kind IN ('dispatch.claimed', 'dispatch.handback', 'dispatch.released') ORDER BY rev").all() as Array<{ rev: number; d: string }>) revs.set(r.d, Number(r.rev));
    const dispatches: Dispatch[] = (db.stmt('SELECT dispatch, task, seat, state, handback, mission, capabilities, created_at FROM dispatches ORDER BY claimed_rev').all() as Array<Json>).map((r) => ({
      dispatch: String(r['dispatch']),
      task: String(r['task']),
      seat: String(r['seat']),
      state: String(r['state']),
      handback: (r['handback'] as string | null) ?? null,
      mission: String(r['mission']),
      capabilities: JSON.parse(String(r['capabilities'] ?? '[]')) as string[],
      createdAt: Number(r['created_at']),
      rev: revs.get(String(r['dispatch'])) ?? 0,
    }));
    const labels = new Map((db.stmt('SELECT target, label, rev FROM lbl_labels').all() as Array<{ target: string; label: string; rev: number }>).map((r) => [r.target, { label: r.label, rev: Number(r.rev) }]));
    const status = labelStatus(db);
    const stops = activeStopScopes(db);
    // 4.1.2: labels resting on runs from an older environment identity read "older environment" (renew.ts: the one resolver)
    const olderTargets = olderEnvironmentProof(db).targets;
    return { flows, steps, dispatches, labels, status, stops, olderTargets };
  });
  const times = new Map<number, number | null>();
  const timeOf = (rev: number): number | null => {
    if (rev <= 0) return null;
    if (!times.has(rev)) times.set(rev, ctx.memory.read((db) => (db.stmt('SELECT committed_at FROM log WHERE rev = ?').get(rev) as { committed_at: number } | undefined)?.committed_at ?? null));
    return times.get(rev) ?? null;
  };
  const covered = (mission: string, capabilities: readonly string[]): boolean => raw.stops.some((s) => stopCovers(s, { mission: mission as MissionId, capabilities }));
  const stepsOf = new Map<string, Step[]>();
  const owner = new Map<string, string>();
  const key = (kind: Layer1Entry['kind'], mission: string | null, id: string): string => JSON.stringify([kind, mission, id]);
  const entries = new Map<string, Layer1Entry>();

  // ---- requirement items: the latest version of each line, withdrawn and contested as the engine reads them
  const items = new Map<string, { mission: string; line: string; title: string; rev: number; withdrawn: boolean; contested: boolean }>();
  for (const f of raw.flows.filter((x) => x.line === REQUIREMENTS_LINE)) {
    const line = String(f.body['line'] ?? '');
    const k = `${f.mission}\n${line}`;
    const cur = items.get(k);
    if (f.event === 'item') items.set(k, { mission: f.mission, line, title: `${String(f.body['type'] ?? '')}: ${clip(String(f.body['text'] ?? ''), 100)}`, rev: f.rev, withdrawn: cur?.withdrawn ?? false, contested: cur?.contested ?? false });
    else if (cur !== undefined && f.event === 'withdrawn') items.set(k, { ...cur, withdrawn: true, rev: f.rev });
    else if (cur !== undefined && f.event === 'contested') items.set(k, { ...cur, contested: f.body['contested'] === true, rev: f.rev });
  }
  for (const i of items.values()) {
    entries.set(key('requirement', i.mission, i.line), { kind: 'requirement', id: i.line, mission: i.mission, title: i.title, label: i.withdrawn ? 'withdrawn' : i.contested ? 'contested' : 'in force', changedAt: timeOf(i.rev), changedRev: i.rev, blocked: null });
  }

  // ---- the plan tasks and explorations, from the plans in effect (their ids, then the producers' encoders)
  const taskIds = new Map<string, Set<string>>();
  const explorationIds = new Map<string, Set<string>>();
  for (const f of raw.flows) {
    if (f.line === PLAN_LINE && f.event === 'effective') for (const t of (f.body['tasks'] ?? []) as string[]) taskIds.set(f.mission, (taskIds.get(f.mission) ?? new Set()).add(t));
    if (f.line === PLAN_LINE && f.event === PM_PLAN_EFFECTIVE) for (const x of (f.body['explorations'] ?? []) as string[]) explorationIds.set(f.mission, (explorationIds.get(f.mission) ?? new Set()).add(x));
  }
  const flowsByLine = new Map<string, Flow[]>();
  for (const f of raw.flows) flowsByLine.set(`${f.mission}\n${f.line}`, [...(flowsByLine.get(`${f.mission}\n${f.line}`) ?? []), f]);
  const dispatchesOf = (steps: readonly Step[]): Dispatch[] => raw.dispatches.filter((d) => steps.some((s) => s.task === d.task));
  const recomputingNote = raw.status.recomputing ? ' (labels recomputing)' : '';

  // the subtask an escalation's `subject` names; its Secretary step belongs to that subtask, before the
  // entries are built (a Secretary dispatch working on it is part of its state and its last change)
  const subjectOwner = (m: string, subject: string): string | null => {
    for (const id of taskIds.get(m) ?? []) if (taskLine(id) === subject) return key('task', m, id);
    for (const x of explorationIds.get(m) ?? []) if (explorationLine(x) === subject) return key('exploration', m, x);
    return null;
  };
  const escalations = raw.flows.filter((f) => f.line === SECRETARY_LINE && f.event === 'escalation');
  const secretarySteps = new Map<string, Set<string>>();
  for (const e of escalations) {
    const k = subjectOwner(e.mission, String(e.body['subject'] ?? ''));
    if (k !== null && typeof e.body['task'] === 'string') secretarySteps.set(k, (secretarySteps.get(k) ?? new Set()).add(e.body['task']));
  }

  // ---- the scope in which the flows still consume an escalation (an escalation outside it is history,
  // never a block): a task's, while the task is in the latest effective plan (latestEffective: what
  // executionStep iterates); a plan's, while it is the latest PM batch (what planningStep handles); an
  // exploration's always (explorationStep advances every defined exploration); any other as raised
  const scopeOf = new Map<string, { readonly tasks: ReadonlySet<string>; readonly batch: string | null }>();
  for (const m of new Set(raw.flows.filter((f) => f.line === PLAN_LINE || f.line === SECRETARY_LINE).map((f) => f.mission))) {
    const eff = await latestEffective(flowCtx(ports, m as MissionId));
    const batch = (await ports.ledger.events<{ readonly plan: string }>({ mission: m as MissionId, line: PLAN_LINE, event: 'pm-batch' })).at(-1)?.body.plan ?? null;
    scopeOf.set(m, { tasks: new Set(eff?.tasks ?? []), batch });
  }
  const inScope = (m: string, subject: string): boolean => {
    const sc = scopeOf.get(m) ?? { tasks: new Set<string>(), batch: null };
    if (subject.startsWith('task:')) return [...sc.tasks].some((id) => taskLine(id) === subject);
    if (subject.startsWith('plan:')) return sc.batch !== null && subject === `plan:${sc.batch}`;
    return true;
  };

  for (const [m, ids] of taskIds) {
    for (const id of ids) {
      const fs = flowsByLine.get(`${m}\n${taskLine(id)}`) ?? [];
      const lineage = taskLineage(m, id);
      const k = key('task', m, id);
      const own = secretarySteps.get(k) ?? new Set<string>();
      const steps = raw.steps.filter((s) => s.mission === m && (s.lineage === lineage || own.has(s.task)));
      stepsOf.set(k, steps);
      for (const s of steps) owner.set(s.task, k);
      const last = fs.at(-1);
      let label = last === undefined ? 'planned' : (TASK_LABEL[last.event]?.(last.body) ?? last.event);
      let rev = last?.rev ?? 0;
      // an attempt that a rework started says so (a Reviewer's rejection is a change of state)
      const attempt = Math.max(0, ...fs.map((f) => Number(f.body['k'] ?? 0)).filter((n) => Number.isFinite(n)));
      const rw = fs.filter((f) => f.event === 'rework' && Number(f.body['k']) === attempt).at(-1);
      if (last !== undefined && rw !== undefined && !['rework', 'loop-verdict', 'accepted', 'reaccepted', 'rereview', 'basis-revised', 'rebind', 'rebound', 'abandoned', 'dropped'].includes(last.event)) label = `${label}, after a rework (${String(rw.body['reason'] ?? '')})`;
      // the current product's stored proof label: a refutation or a withdrawn basis after acceptance is a change of the task
      // (the attempt's product, or the version it was re-bound to under a later plan)
      const latest = fs.filter((f) => (f.event === 'product' && typeof f.body['object'] === 'string') || (f.event === 'rebound' && bySeat(f.body) && typeof f.body['product'] === 'string')).at(-1);
      const product = (latest?.event === 'rebound' ? latest.body['product'] : latest?.body['object']) as string | undefined;
      const pl = product === undefined ? undefined : raw.labels.get(product);
      if (pl !== undefined) {
        rev = Math.max(rev, pl.rev);
        // the label of the current attempt's product (a rework's earlier product is history)
        const current = Number(latest!.body['k'] ?? attempt) === attempt;
        const settled = last !== undefined && ['accepted', 'reaccepted', 'rereview', 'basis-revised', 'rebind', 'rebound'].includes(last.event);
        const older = raw.olderTargets.has(product!) ? ` (${OLDER_ENVIRONMENT})` : '';
        if (current && (settled || pl.label === 'negated' || pl.label === 'basis-withdrawn')) label = `${label}, product ${pl.label}${older}${recomputingNote}`;
      }
      const ds = dispatchesOf(steps);
      for (const d of ds) rev = Math.max(rev, d.rev);
      // dropped from the plan in effect, before the flow records its "dropped" event
      if (!(scopeOf.get(m)?.tasks.has(id) ?? true) && last?.event !== 'dropped') label = `${label}; not in the plan in effect (a re-plan dropped it)`;
      const flying = ds.filter((d) => d.state === 'in-flight');
      if (flying.length > 0) label = `${label}; ${flying.map((d) => `${d.seat} ${d.dispatch} in flight`).join(', ')}`;
      let title = id;
      for (const s of steps) if (typeof s.card['goal'] === 'string') title = clip(String(s.card['goal']), 100);
      entries.set(k, { kind: 'task', id, mission: m, title, label, changedAt: timeOf(rev), changedRev: rev, blocked: null });
    }
  }
  for (const [m, ids] of explorationIds) {
    for (const x of ids) {
      const fs = flowsByLine.get(`${m}\n${explorationLine(x)}`) ?? [];
      // the exploration machine's current state first (the flow's own resolver); the history is only a suffix
      const s = await explorationState(ports, m as MissionId, x);
      if (s.defined === null) continue;
      const k = key('exploration', m, x);
      const own = secretarySteps.get(k) ?? new Set<string>();
      const named = new Set(fs.filter((f) => f.event === 'queued' && typeof f.body['task'] === 'string').map((f) => f.body['task'] as string));
      const steps = raw.steps.filter((t) => t.mission === m && (named.has(t.task) || own.has(t.task)));
      stepsOf.set(k, steps);
      for (const t of steps) owner.set(t.task, k);
      const reruns = [...s.reruns.values()].filter((v) => v === null).length;
      const machine =
        s.stopped !== null
          ? `stopped (${s.stopped.reason})`
          : s.drift !== null || s.turn === 'await-ruling'
            ? 'awaiting a ruling'
            : reruns > 0
              ? `round ${s.rounds}: ${reruns} evidence execution(s) running again`
              : s.awaitingEvidence !== null
                ? `round ${s.rounds}: waiting for an evidence execution`
                : `round ${s.rounds}: ${s.turn === 'none' ? 'waiting' : `the ${s.turn}'s turn`}`;
      // "concluded" only while the flow's current settle stands (one per opening, machine.ts); while a rerun
      // has reopened it, the machine's state with the last recorded conclusion as history
      const current = s.settled;
      const last = s.settles.at(-1);
      const recorded = (r: SettleRecord): string => `${r.body.outcome} (${r.body.stop})`;
      let rev = fs.at(-1)?.rev ?? 0;
      // a conclusion's product: its stored proof label (as settledArtifactProven reads it), whose revision is a change
      const productOf = (r: SettleRecord): string => {
        const artifact = r.body.outcome === 'conclusion' && typeof r.body.artifact === 'string' ? r.body.artifact : null;
        const pl = artifact === null ? undefined : raw.labels.get(artifact);
        if (pl === undefined) return '';
        rev = Math.max(rev, pl.rev);
        return `, product ${pl.label}${artifact !== null && raw.olderTargets.has(artifact) ? ` (${OLDER_ENVIRONMENT})` : ''}${recomputingNote}`;
      };
      let label: string;
      if (current !== null) {
        // a conclusion that replaced an earlier one (another product, or no conclusion now) names it as history
        const before = s.settles[current.n - 2];
        const replaced = before !== undefined && (before.body.outcome !== current.body.outcome || before.body.artifact !== current.body.artifact);
        label = `concluded: ${recorded(current)}${productOf(current)}${replaced ? `; replaces the conclusion recorded before an environment change: ${recorded(before)}${productOf(before)}` : ''}`;
      } else if (last !== undefined) {
        label = `${machine}; concluded earlier: ${recorded(last)}${s.stopped === null ? ', re-checking its evidence after an environment change' : ', before an environment change'}${productOf(last)}`;
      } else label = machine;
      const ds = dispatchesOf(steps);
      for (const d of ds) rev = Math.max(rev, d.rev);
      const flying = ds.filter((d) => d.state === 'in-flight');
      if (flying.length > 0) label = `${label}; ${flying.map((d) => `${d.seat} ${d.dispatch} in flight`).join(', ')}`;
      const def = s.def as unknown as Json | null;
      entries.set(k, { kind: 'exploration', id: x, mission: m, title: clip(String(def?.['question'] ?? def?.['deliverable'] ?? def?.['goal'] ?? x), 100), label, changedAt: timeOf(rev), changedRev: rev, blocked: null });
    }
  }

  // ---- blocked: one entry per subtask, every reason it has
  const reasons = new Map<string, Array<{ because: string; next: string; wi: string | null }>>();
  const block = (k: string, because: string, next: string, wi: string | null): void => {
    reasons.set(k, [...(reasons.get(k) ?? []), { because, next, wi }]);
  };
  /** The subtask a seat step belongs to; a decision-layer step gets an entry of its own. */
  const ofStep = (task: string, mission: string): string => {
    const k = owner.get(task);
    if (k !== undefined) return k;
    const sk = key('step', mission, task);
    if (!entries.has(sk)) {
      const s = raw.steps.find((x) => x.task === task);
      let title = task;
      try {
        if (s !== undefined) title = `${task}: ${clip(purposeOf(s.card as { seat: string }), 100)}`;
      } catch {
        title = task;
      }
      entries.set(sk, { kind: 'step', id: task, mission, title, label: s === undefined ? 'waiting' : s.state === 'queued' ? 'ready to dispatch' : s.state, changedAt: s === undefined ? null : s.queuedAt, changedRev: s?.queuedRev ?? 0, blocked: null });
    }
    return sk;
  };
  // open escalations (not carried out yet), by the subtask their subject names; the next step by the
  // flow's own rules: waiting on the user as `mp pm next` lists it (readSteps().waitingOnUser), carried
  // out only when there is a decision to carry out (decisionFor), else the Secretary's step
  const steps = readSteps(ctx);
  const waiting = new Set(steps.waitingOnUser.map((w) => `${w.mission}\n${w.escalation}`));
  const sec = (m: string, event: string, k: string): Flow | undefined => (flowsByLine.get(`${m}\n${SECRETARY_LINE}`) ?? []).find((f) => f.event === event && f.key === k);
  /** The Secretary steps of escalations the flows no longer consume: no block comes from them. */
  const orphaned = new Set<string>();
  for (const e of escalations) {
    const source = String(e.body['source'] ?? '');
    const subject = String(e.body['subject'] ?? '');
    if (!inScope(e.mission, subject)) {
      if (typeof e.body['task'] === 'string') orphaned.add(e.body['task']);
      continue;
    }
    if (source === 'constructor-decision' || sec(e.mission, 'applied', e.key) !== undefined) continue;
    let k = subjectOwner(e.mission, subject);
    if (k === null) {
      // a decision-layer escalation (subject "plan:<object>"): the plan it is about
      const plan = [...raw.flows].reverse().find((f) => f.mission === e.mission && f.line === PLAN_LINE && (f.event === 'pm-batch' || f.event === 'arch') && `plan:${String(f.body['plan'] ?? f.body['object'] ?? '')}` === subject);
      const object = plan === undefined ? null : String(plan.body['plan'] ?? plan.body['object']);
      k = key('plan', e.mission, object ?? subject);
      if (!entries.has(k)) entries.set(k, { kind: 'plan', id: object ?? subject, mission: e.mission, title: object !== null ? `the decision layer of ${object}` : subject, label: 'waiting on a decision', changedAt: timeOf(e.rev), changedRev: e.rev, blocked: null });
      if (typeof e.body['task'] === 'string') owner.set(e.body['task'], k);
    }
    const id = String(e.body['id'] ?? e.key);
    const options = ((e.body['options'] ?? []) as string[]).filter((o) => o !== 'ask-user');
    const onUser = waiting.has(`${e.mission}\n${id}`);
    const deciding = steps.inFlight.find((d) => d.step === e.body['task']);
    const next = onUser
      ? `ask the user; then mp pm answer ${e.mission} ${id} --option <${options.join('|')}> --words W-<n>`
      : (await decisionFor(flowCtx(ports, e.mission as MissionId), id)) !== null
        ? 'the decision is carried out on the next mp pm next'
        : deciding !== undefined
          ? `the Secretary is deciding (${deciding.dispatch} in flight): wait for its hand-back`
          : 'the Secretary decides: dispatch its step (mp pm next)';
    block(k, `escalation ${id} is open (${source}: ${clip(String(e.body['summary'] ?? ''), 120)})`, next, ESCALATION_WI[source] ?? (onUser ? 'WI-24' : null));
  }
  // steps held (what mp pm next computes)
  for (const h of steps.held) {
    if (orphaned.has(h.step)) continue;
    const next = h.why.startsWith('a stop')
      ? 'the stop is narrowed or released with the user (mp pm stop-narrow / mp pm stop-release)'
      : h.why.startsWith('mission')
        ? `open the mission again if the user wants its production to go on (mp pm mission open ${h.mission})`
        : h.why.startsWith('git writes')
          ? 'confirm this copy is the one in use (mp pm confirm-copy, WI-31)'
          : h.why.startsWith('exploration')
            ? 'it starts by itself once the explorations it waits for settle (their own blocks are listed here)'
            : 'it starts once the resource is free; a lease held by a released seat goes with mp pm release <id> --ended (WI-28)';
    block(ofStep(h.step, String(h.mission)), `${h.step} (${h.seat}) is held: ${h.why}`, next, h.wi);
  }
  // dispatches: in flight under a stop, in flight too long, a hand-back after a stop
  for (const d of raw.dispatches) {
    if (orphaned.has(d.task)) continue;
    if (d.state === 'in-flight') {
      if (covered(d.mission, d.capabilities)) block(ofStep(d.task, d.mission), `a stop covers ${d.dispatch} (${d.seat}) while its seat is still working`, `stop the seat in your harness, then mp pm release ${d.dispatch} --ended`, 'WI-28');
      else if (now - d.createdAt >= IN_FLIGHT_BLOCKED_MS) block(ofStep(d.task, d.mission), `dispatch ${d.dispatch} (${d.seat}) has been in flight for ${age(now - d.createdAt)} without a hand-back`, `if its seat ended: mp pm release ${d.dispatch} --ended, or --abandoned when not confirmed`, 'WI-28');
    } else if (d.handback === 'after-stop') {
      // the step's latest dispatch only: a later dispatch of the same step supersedes it
      const later = raw.dispatches.some((x) => x.task === d.task && x.rev > d.rev);
      if (!later && covered(d.mission, d.capabilities)) block(ofStep(d.task, d.mission), `the hand-back of ${d.dispatch} (${d.seat}) arrived after a stop and was not accepted`, 'the stop is narrowed or released with the user; then the Secretary disposes of it (WI-26)', 'WI-26');
    }
  }
  const all: Layer1Entry[] = [];
  for (const [k, e] of entries) {
    const rs = reasons.get(k);
    all.push(rs === undefined ? e : { ...e, blocked: { because: rs.map((r) => r.because).join('; '), next: [...new Set(rs.map((r) => r.next))].join('; '), wi: rs.find((r) => r.wi !== null)?.wi ?? null } });
  }
  const st = raw.status;
  const recomputing = st.recomputing
    ? {
        because: `the labels are recomputing (${st.toVisit} to visit, ${st.toRecompute} to recompute): acceptances, deliveries and stable dispatches wait`,
        next: st.since !== null && now - st.since > 10 * 60_000 ? 'stop dispatching new work, then mp pm drain (WI-32)' : 'they finish on the next mp pm next calls',
        wi: st.since !== null && now - st.since > 10 * 60_000 ? 'WI-32' : null,
      }
    : null;
  return { head, entries: all, blocked: all.filter((e) => e.blocked !== null), recomputing, inScope };
}

/** One layer-1 entry as a line (or two, with its block line). */
export function entryLines(e: Layer1Entry): string[] {
  const where = e.mission !== null ? `${e.mission} ` : '';
  const when = e.changedAt !== null ? new Date(e.changedAt).toISOString().slice(0, 16).replace('T', ' ') : '-';
  const head = `${where}${e.kind} ${e.id} — ${e.title} [${e.label}] (last change ${when})`;
  return e.blocked === null ? [head] : [head, `    blocked because ${e.blocked.because} / next: ${e.blocked.next}${e.blocked.wi !== null ? ` [${e.blocked.wi}]` : ''}`];
}
