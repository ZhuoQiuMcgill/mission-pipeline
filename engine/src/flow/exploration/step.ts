// The exploration flow inside the flow engine (src/flow/engine.ts): the cross-flow contract with
// the decision layer (src/flow/plandoc.ts) and the Secretary (src/flow/secretary.ts).
//
//   - start: every exploration element of a PM plan that passed Calibrator ① (event
//     "pm-plan-effective" on line "plan") is defined here (4.3: defined by the PM with the user).
//   - advance: every defined exploration of the mission takes the steps it can.
//   - stops (8.2, 3.8, 3.10):
//       converged                   → "settled" (outcome conclusion / no-conclusion) for the
//                                     decision layer, which routes it by decision type
//       budget exhausted, the same  → an escalation to the Secretary (sources exploration-budget,
//       fatal class twice, no         exploration-repeated-fatal) with the options the program
//       progress                      can carry out: grant more rounds (the Secretary once, then
//                                     the user, WI-08), accept the current version with its
//                                     open findings as residual risks (a ruling pass revokes the
//                                     version's negation), send back with a new direction, re-plan
//                                     (settled as no conclusion), give up (settled likewise)
//   - direction questions (an escalated finding, 4.3 讨论 / 8.2 处置) → an escalation (source
//     exploration-direction): answer / send back (the author revises per the answer), accept the
//     risk, or ask the user; the decision becomes an exploration ruling.
//   - the Stabilizer's direction questions (4.1 §6.3, WI-33: a finding that shifts direction, a
//     drifting round) → an escalation (source exploration-direction) while the exploration awaits
//     the ruling: keep the definition (answer: the finding is set aside, the drift cleared, the
//     rounds go on), change the direction (send-back: the author works to it), or end it
//     (abandon / replan: no conclusion).
// Every decision is applied once (the ruling's id is the escalation's; markApplied).
//
// Settling is once per opening, not once per exploration (code review r1 #3 carried through): a
// rerun after an environment change (4.1.2: only on the PM's word, `mp pm reopen-exploration`; an
// environment change alone raises the notice exploration-older-environment) reopens a converged
// exploration, and from then on it is not settled; every stop after the reopening is routed exactly like a first stop (a settle, an
// escalation to the Secretary, or a step that is ready). The current settle (machine.ts `settled`)
// is the one recorded since the last reopening; every reader here and in the decision layer uses it.

import { canonicalJson, sha256 } from '../../common/hash.ts';
import type { MissionId } from '../../common/ids.ts';
import { idPart, missionClosed, safeId, type FlowCtx } from '../context.ts';
import { registerFlowStep } from '../engine.ts';
import { EXPLORATION_SETTLED, PLAN_LINE, PM_PLAN_EFFECTIVE, PmPlanDoc, explorationLine, type ExplorationSettledBody, type PmPlanEffectiveBody } from '../plandoc.ts';
import { handleFailure } from '../failures.ts';
import type { FlowEventInput, FlowTaskStatus } from '../ports.ts';
import { cancelSecretarySteps, carryGuard, carryOut, closing, commitCarrying, decisionFor, escalateToUser, escalation, isApplied, openEscalations, raiseEscalation, type Carry } from '../secretary.ts';
import type { DecisionOption } from '../../seat/cards/secretary.ts';
import { explorationDefinition, xid, type ExplorationDefinition } from './definition.ts';
import { advanceExploration, buildHandoff, defineExploration, explorationState, explorationStateAfter, recordExplorationRerun, redefineExploration, rulingEvent, type ExplorationHandoff } from './flow.ts';
import { versionEvidence } from './cards.ts';
import { allowedRounds, currentEvidence, directionPending, effectiveSeverity, pendingTasks, settleKey, settleSince, type QueuedBody, type RulingBody, type SettleRecord, type StopReason, type XState } from './machine.ts';
import { WI } from '../wi.ts';

/** The decision layer's exploration element (plandoc.ts) as this flow's definition. */
export function definitionFromPlan(mission: MissionId, plan: string, e: NonNullable<PmPlanDoc['elements'][number]['exploration']>, text: string, planDoc?: string): ExplorationDefinition {
  return explorationDefinition({
    materials: planDoc !== undefined ? [{ id: 'pm-plan', title: `The PM plan ${plan}`, doc: planDoc }] : [],
    exploration: e.id,
    mission,
    product: e.research ? 'answer' : 'design',
    research: e.research,
    question: e.research ? e.deliverable : null,
    goal: e.fuzzyGoal.quote,
    attackScope: e.attackScope,
    decision: { type: e.decision.type, text: `${e.decision.id}: ${text}`, id: e.decision.id },
    budget: { rounds: e.budget.rounds, spendMicros: e.budget.micros },
    // the addresses a reading may cite (a citation scope; mp fetches nothing)
    readingNetwork: [...(e.readingNetwork ?? [])],
    duties: `Produce and defend: ${e.deliverable}.${e.stop.trim() !== '' ? ` Extra stop condition set with the user: ${e.stop}` : ''} (PM plan ${plan}.)`,
  });
}

/** Two definitions alike apart from the plan they were read from (the PM plan material and the duties' plan id). */
function sameDefinition(a: ExplorationDefinition, b: ExplorationDefinition): boolean {
  const strip = (d: ExplorationDefinition) => ({ ...d, materials: d.materials.filter((m) => m.id !== 'pm-plan'), duties: d.duties.replace(/ \(PM plan [^)]*\.\)$/, '') });
  return canonicalJson(strip(a)) === canonicalJson(strip(b));
}

const escId = (mission: string, x: string, what: string): string => safeId(`xp.${mission}.${idPart(x)}.${what}`);

/** One pass of the exploration flow for the mission (registered with the flow engine). */
export async function explorationStep(ctx: FlowCtx): Promise<void> {
  // a closed mission's production is held (4.1 §6.7): no exploration seat is queued for it
  if (await missionClosed(ctx)) return;
  const ports = { ledger: ctx.ports.ledger, scheduler: ctx.ports.scheduler };
  const mission = ctx.mission;
  // start the explorations of the effective PM plans; a later plan's element is the one in force
  const latest = new Map<string, ExplorationDefinition>();
  for (const e of await ctx.ports.ledger.events<PmPlanEffectiveBody>({ mission, line: PLAN_LINE, event: PM_PLAN_EFFECTIVE })) {
    const doc = PmPlanDoc.parse(JSON.parse(ctx.ports.ledger.content.get(e.body.doc)));
    for (const el of doc.elements) {
      if (el.exploration === undefined || !e.body.explorations.includes(el.exploration.id)) continue;
      latest.set(el.exploration.id, definitionFromPlan(mission, e.body.plan, el.exploration, el.text, e.body.doc));
    }
  }
  for (const [id, def] of latest) {
    const known = await ctx.ports.ledger.events({ mission, line: explorationLine(id), event: 'defined' });
    if (known.length === 0) {
      await defineExploration(ports, def);
      ctx.progressed = true;
      continue;
    }
    // a later plan changed the exploration: a new definition version, unless it is settled now (a
    // plan change never reopens a settled exploration; while a rerun has reopened it, it is not settled)
    const st = await explorationState(ctx.ports, mission, id);
    const cur = st.def;
    if (cur === null || sameDefinition(cur, def)) continue;
    if (st.settled !== null) {
      await ctx.ports.ledger.notify({
        mission,
        category: 'exploration-changed-after-settling',
        wi: null,
        key: `${id}:${canonicalJson(def).length}:${sha256(canonicalJson(def)).slice(0, 12)}`,
        trigger: `a PM plan changes exploration ${id}, which has already settled`,
        defaultAction:
          'the settled result stands and is not reopened by the plan; to explore again under the changed definition, give the exploration a new id in the plan (should an environment change reopen it later, its re-check runs under the definition in force then)',
        detail: { exploration: id },
      });
      continue;
    }
    // the redefinition reopens an 8.2 stop: that stop's escalation closes in the same write (code review round 10)
    const leaving = st.stopped !== null && st.stopped.reason !== 'converged' && st.stopped.reason !== 'stopped-by-decision' ? escId(mission, id, `stop${st.stopped.n}`) : null;
    const open = leaving !== null && (await escalation(ctx, leaving)) !== null && !(await isApplied(ctx, leaving)) ? [leaving] : [];
    const close = closing(ctx, open, `exploration ${id} left stop ${st.stopped?.n ?? 0} before the decision was carried out (a PM plan changed its definition)`);
    const guard = carryGuard([close]);
    if (await redefineExploration(ports, def, { events: close.events, ...(guard !== undefined ? { guard } : {}) })) {
      ctx.progressed = true;
      await cancelSecretarySteps(ctx, open);
    }
  }
  for (const d of await ctx.ports.ledger.events({ mission, event: 'defined' })) {
    if (!d.line.startsWith('exploration:')) continue;
    const x = d.line.slice('exploration:'.length);
    if (await applyDecisions(ctx, x)) ctx.progressed = true;
    const r = await advanceExploration(ports, mission, x, 64, (q, st) => onFailedTask(ctx, x, q, st));
    if (r.steps > 0) ctx.progressed = true;
    // a convergence on evidence recorded under another environment identity: a notice; reopened only on the PM's word (4.1.2)
    if (await rerunStale(ctx, x)) ctx.progressed = true;
    if (await routeStop(ctx, x)) ctx.progressed = true;
    if (await routeQuestions(ctx, x)) ctx.progressed = true;
    await watchSettled(ctx, x);
  }
}

/** The PM's word to reopen a settled exploration after an environment change (line "exploration:<x>", key: the environment identity it was given under). */
export const EXPLORATION_REOPEN_REQUESTED = 'reopen-requested';
/** The notice that a settled exploration rests on executions from an older environment (4.1.2: not reopened automatically). */
export const EXPLORATION_OLDER_ENVIRONMENT = 'exploration-older-environment';

/**
 * Code review r1 #3 (4.1 §6.5, decision 11): a converged version whose standing rests on runs
 * recorded under another environment identity (an experiment's evidence is bound to the identity
 * of the runs it cites; readings are not). 4.1.2 (D-1): those runs still count, so the exploration
 * is not reopened by itself: the PM is told (EXPLORATION_OLDER_ENVIRONMENT) and reopens it on its
 * word (`mp pm reopen-exploration`, EXPLORATION_REOPEN_REQUESTED under the current identity). Then
 * the way back is the evidence-execution step: those executions run again with the same request,
 * then the same position judges the version again with the new records (a re-check round by the
 * attacker, then its Stabilizer).
 */
async function rerunStale(ctx: FlowCtx, x: string): Promise<boolean> {
  const s = await explorationState(ctx.ports, ctx.mission, x);
  if (s.stopped === null || s.stopped.reason !== 'converged' || s.version === null || s.defined === null) return false;
  // through the one resolver (code review r2 #5): each id as its latest record
  const required = new Set([...(s.lastAttack !== null && s.lastAttack.target === s.version.id ? (s.lastAttack.evidence ?? []) : []).map((e) => currentEvidence(s, e)), ...versionEvidence(s, ctx.ports.ledger.content)]);
  if (required.size === 0) return false;
  const current = new Map<string, string>();
  for (const c of await ctx.ports.ledger.records(['env.snapshot'])) current.set(c.record.line as string, c.record.snapshot as string);
  const own = s.defined.envLine;
  const stale = (await ctx.ports.ledger.records(['evidence']))
    .map((c) => c.record)
    .filter((r) => required.has(r.evidence) && r.envLine !== own && !s.reruns.has(r.evidence))
    .filter((r) => {
      const cur = current.get(r.envLine);
      return cur !== undefined && cur !== r.envSnapshot;
    });
  if (stale.length === 0) return false;
  const evidence = stale.map((r) => r.evidence as string).sort();
  const environment = current.get(stale[0]!.envLine)!;
  const asked = (await ctx.ports.ledger.events({ mission: ctx.mission, line: explorationLine(x), event: EXPLORATION_REOPEN_REQUESTED })).some((e) => e.key === environment);
  if (!asked) {
    // told once per exploration, environment and set of executions (the notice's identity); nothing changes
    await ctx.ports.ledger.notify({
      mission: ctx.mission,
      category: EXPLORATION_OLDER_ENVIRONMENT,
      wi: null,
      key: `${x}:${environment.slice(0, 24)}:${sha256(canonicalJson(evidence)).slice(0, 16)}`,
      trigger: `exploration ${x}${s.settled !== null ? ', settled,' : ''} rests on ${evidence.length} evidence execution(s) recorded under an older environment identity (a move or a changed tool version)`,
      defaultAction: `nothing is reopened: they still count and are shown as "older environment"; the conclusion stands. If the change matters for this question, \`mp pm reopen-exploration ${ctx.mission} ${x}\` reruns those executions under this environment and the attacker re-checks the same version`,
      detail: { exploration: x, evidence, environment, settled: s.settled?.key ?? null },
    });
    return false;
  }
  // the PM is told before the event that reopens it (a crash in between sends the same notice again: a no-op)
  await ctx.ports.ledger.notify({
    mission: ctx.mission,
    category: 'exploration-reopened',
    wi: null,
    key: `${x}:${environment.slice(0, 24)}:${sha256(canonicalJson(evidence)).slice(0, 16)}`,
    trigger: `exploration ${x}${s.settled !== null ? ', settled,' : ''} rests on ${evidence.length} evidence execution(s) recorded under another environment identity (a move or a changed tool version)`,
    defaultAction:
      'the exploration is reopened: those executions run again with the same request (ready steps in mp pm next), then the attacker re-checks the same version and its Stabilizer judges the round; until it settles again its earlier conclusion is history and the decision layer plans nothing new from it; a stop on the way goes to the Secretary like any other (WI-08, WI-33)',
    detail: { exploration: x, evidence, environment, settled: s.settled?.key ?? null },
  });
  // the conclusion the decision layer was routing is history now: its routing escalation closes in the
  // rerun's own write (a new settle is routed afresh)
  const routing = (await openEscalations(ctx, explorationLine(x))).filter((e) => e.id.startsWith('explore.')).map((e) => e.id);
  const close = closing(ctx, routing, `exploration ${x} was reopened after an environment change: the conclusion it routed is history`);
  const guard = carryGuard([close]);
  await recordExplorationRerun({ ledger: ctx.ports.ledger, scheduler: ctx.ports.scheduler }, ctx.mission, x, { evidence, environment }, { events: close.events, ...(guard !== undefined ? { guard } : {}) });
  await cancelSecretarySteps(ctx, routing);
  return true;
}

/**
 * The current settle of an exploration (machine.ts): the "settled" event recorded since it last
 * reopened, or null (never settled, or reopened since: every earlier settle is history). `since`
 * is the settle where the same conclusion (outcome and product) was first recorded: the decision
 * layer routes a conclusion once, keyed by it.
 */
export async function currentSettle(ports: Pick<FlowCtx['ports'], 'ledger'>, mission: MissionId, x: string): Promise<(SettleRecord & { readonly since: SettleRecord }) | null> {
  const s = await explorationState(ports, mission, x);
  const since = settleSince(s);
  return s.settled === null || since === null ? null : { ...s.settled, since };
}

/**
 * Whether a settled exploration still stands on proof (review r1 #2): the product version of its
 * current settle is proven at the evaluator's published revision. The decision layer plans from a
 * settled exploration only while this holds (a settle is a record; the proof is current). While a
 * rerun has reopened it nothing is current: no artifact, not proven. While the labels recompute the
 * label is "recomputing" as it is (pending, not unproven: callers wait, 4.1 §4.1).
 */
export async function settledArtifactProven(ports: Pick<FlowCtx['ports'], 'ledger' | 'evaluator'>, mission: MissionId, x: string): Promise<{ readonly artifact: string | null; readonly proven: boolean; readonly label: string | null }> {
  const s = (await explorationState(ports, mission, x)).settled;
  const artifact = s?.body.artifact ?? null;
  if (artifact === null) return { artifact, proven: false, label: null };
  const label = (await ports.evaluator.labels([artifact])).labels[artifact] ?? null;
  return { artifact, proven: label === 'proven', label };
}

/** A current settled conclusion whose product lost its proof: the PM is told once per loss (a normal branch, like 6.1's episodes). */
async function watchSettled(ctx: FlowCtx, x: string): Promise<void> {
  const s = (await explorationState(ctx.ports, ctx.mission, x)).settled;
  if (s === null || s.body.outcome !== 'conclusion' || s.body.artifact === null) return;
  const v = await settledArtifactProven(ctx.ports, ctx.mission, x);
  // proven, or pending while the labels recompute (4.1 §4.1: not a loss of proof)
  if (v.proven || v.label === 'recomputing') return;
  await ctx.ports.ledger.notify({
    mission: ctx.mission,
    category: 'exploration-conclusion-unproven',
    wi: null,
    key: `${x}:${v.artifact}:${v.label ?? 'unknown'}`,
    trigger: `the product ${v.artifact} of settled exploration ${x} is now ${v.label ?? 'unknown'} (an evidence execution or the definition it rests on changed)`,
    defaultAction:
      'nothing is reopened by this (an environment change under the experiments of a converged exploration reopens it instead: notice exploration-reopened): work planned from this conclusion rests on a product that is no longer proven, and the decision layer plans nothing new from it; to restore it, define a new exploration (or the decision layer re-plans)',
    detail: { exploration: x, artifact: v.artifact, label: v.label },
  });
}

// ---------------------------------------------------------------- failed seat tasks (WI-28, WI-08)

/**
 * A seat task of the exploration that ended without a usable hand-back goes to the Secretary like
 * any flow's (failures.ts): restart (counted in the quarantine-restart loop), grant (its
 * re-dispatches used up), or abandon. Abandoning an evidence run records it as failed and the seat
 * that asked goes on; abandoning a turn ends the exploration without a conclusion.
 */
async function onFailedTask(ctx: FlowCtx, x: string, q: QueuedBody, st: FlowTaskStatus): Promise<void> {
  const why = st.state === 'exhausted' ? 'exhausted' : st.disposition === 'full-review' ? 'full-review' : 'needs-disposition';
  const o = await handleFailure(ctx, { task: q.task, lineage: q.lineage, subject: explorationLine(x), view: { kind: 'failed', status: st, why }, canAbandon: true, canReplan: false });
  if (o.kind !== 'decided') return;
  await ctx.ports.scheduler.cancel(q.task);
  // a given-up turn ends the exploration: its stop ruling and the decision's "applied" are one write
  const rulings: RulingBody[] = q.role !== 'executor' ? [{ id: o.escalation, decision: 'stop', findings: [], text: `the ${q.role} turn was given up: ${o.decision.reason}`, extraRounds: 0, by: o.decision.by === 'user' ? 'user' : 'secretary' }] : [];
  if (!(await isApplied(ctx, o.escalation))) await commitCarrying(ctx, xid.op(ctx.mission, x, `carry:${o.escalation}`), rulings.map((r) => rulingEvent(ctx.mission, x, r)), [await carryOut(ctx, o.escalation, { option: o.decision.option, task: q.task })]);
  ctx.progressed = true;
}

// ---------------------------------------------------------------- stops

const SOURCE: Partial<Record<StopReason, 'exploration-budget' | 'exploration-repeated-fatal'>> = {
  'budget-exhausted': 'exploration-budget',
  'fatal-repeat': 'exploration-repeated-fatal',
  'no-progress': 'exploration-repeated-fatal',
};

const STOP_OPTIONS: readonly DecisionOption[] = ['grant', 'accept-risk', 'send-back', 'replan', 'abandon', 'ask-user'];

function handoffOf(ctx: FlowCtx, s: XState): ExplorationHandoff | null {
  if (s.stopped === null) return null;
  return JSON.parse(ctx.ports.ledger.content.get(s.stopped.handoff)) as ExplorationHandoff;
}

function summaryOf(ctx: FlowCtx, s: XState, h: ExplorationHandoff): string {
  if (s.def?.research === true && s.version !== null) {
    try {
      const doc = JSON.parse(ctx.ports.ledger.content.get(s.version.content)) as { answer?: string; conclusions?: Array<{ id: string; text: string; standing: string; key: boolean }> };
      const cs = (doc.conclusions ?? []).map((c) => `${c.key ? 'key ' : ''}${c.id} (${c.standing}): ${c.text}`).join('; ');
      return `Answer: ${doc.answer ?? '(none)'}${cs !== '' ? ` — ${cs}` : ''}${h.research?.noConclusion === true ? ' — the key answer does not stand: no conclusion' : ''}`;
    } catch {
      /* not a research document: fall through */
    }
  }
  const risks = h.residualRisks.length > 0 ? `; ${h.residualRisks.length} finding(s) accepted as residual risks` : '';
  return `Version ${h.version?.id ?? '(none)'} after ${h.rounds} round(s) (${h.reason})${risks}; ${h.findings.length} finding(s) in total, ${h.unresolvedBlocking.length} fatal or serious unresolved.`;
}

function unresolvedOf(h: ExplorationHandoff): string[] {
  return h.findings
    .filter((f) => f.status !== 'resolved' || f.residualRisk)
    .map((f) => `${f.residualRisk ? 'residual risk' : f.status}: (${f.severity}, ${f.class}${f.scope !== null ? `, Stabilizer: ${f.scope}` : ''}) ${f.title}${f.disposition !== null ? ` — author: ${f.disposition.action}` : ''}`);
}

/**
 * The settle of the exploration for the decision layer, for one write: once per opening (the current
 * settle, machine.ts). A stop after a reopening settles again, as the n-th settle (key "<x>#<n>"; the
 * first keeps key "<x>"). The exploration ends here (until a rerun reopens it): its other escalations
 * close in the same write (the decision layer's routing, explore.*, and the decision being carried
 * out, `carrying`, excepted). Null when a settle is current already.
 */
async function settleParts(ctx: FlowCtx, x: string, now: XState, h: ExplorationHandoff, stop: ExplorationSettledBody['stop'], outcome: ExplorationSettledBody['outcome'], carrying: string | null): Promise<{ readonly events: FlowEventInput[]; readonly close: Carry; readonly stale: string[]; readonly n: number } | null> {
  if (now.settled !== null) return null;
  const stale = (await openEscalations(ctx, explorationLine(x))).filter((e) => !e.id.startsWith('explore.') && e.id !== carrying).map((e) => e.id);
  const n = now.settles.length + 1;
  const def = now.def as ExplorationDefinition;
  const body: ExplorationSettledBody = {
    exploration: x,
    decision: { id: def.decision.id ?? x, type: def.decision.type },
    outcome,
    stop,
    artifact: h.version?.id ?? null,
    summary: summaryOf(ctx, now, h),
    unresolved: unresolvedOf(h),
  };
  return { events: [{ mission: ctx.mission, line: explorationLine(x), event: EXPLORATION_SETTLED, key: settleKey(x, n).key, body }], close: closing(ctx, stale, `exploration ${x} settled (${outcome}, ${stop}): a decision on it is not carried out`), stale, n };
}

/** Its queued seat steps once it settled (one in flight hands back as usual; nothing follows from it). */
async function cancelQueuedSeats(ctx: FlowCtx, now: XState): Promise<void> {
  for (const q of pendingTasks(now)) if ((await ctx.ports.scheduler.status(q.task))?.state === 'queued') await ctx.ports.scheduler.cancel(q.task);
}

/** Settle a stop no decision ends (converged, or the decision layer's own stop): the settle and the escalations it closes in one write. */
async function settle(ctx: FlowCtx, x: string, h: ExplorationHandoff, stop: ExplorationSettledBody['stop'], outcome: ExplorationSettledBody['outcome']): Promise<void> {
  const now = await explorationState(ctx.ports, ctx.mission, x);
  const parts = await settleParts(ctx, x, now, h, stop, outcome, null);
  if (parts === null) return;
  await commitCarrying(ctx, xid.op(ctx.mission, x, settleKey(x, parts.n).op), parts.events, [parts.close], parts.stale);
  await cancelQueuedSeats(ctx, now);
}

/**
 * Carry out a decision on the exploration (code review round 10): its rulings, the settle they lead to
 * (`end`), and the decision's "applied" with its ruling judgment (an accepted residual risk: j.sec /
 * j.user, revoking the version's negation) as ONE write, so no record ever holds the settle without its
 * ruling, nor a ruling without the decision carried out.
 */
async function carryDecision(
  ctx: FlowCtx,
  x: string,
  id: string,
  option: DecisionOption,
  rulings: readonly RulingBody[],
  end?: { readonly stop: ExplorationSettledBody['stop']; readonly outcome: ExplorationSettledBody['outcome']; readonly handoff: (now: XState) => ExplorationHandoff | null },
): Promise<void> {
  if (await isApplied(ctx, id)) return;
  const events = rulings.map((r) => rulingEvent(ctx.mission, x, r));
  const carries: Carry[] = [await carryOut(ctx, id, { option })];
  let stale: string[] = [];
  let now: XState | null = null;
  if (end !== undefined) {
    now = await explorationStateAfter(ctx.ports, ctx.mission, x, rulings);
    const h = end.handoff(now);
    const parts = h === null ? null : await settleParts(ctx, x, now, h, end.stop, end.outcome, id);
    if (parts !== null) {
      events.push(...parts.events);
      carries.push(parts.close);
      stale = parts.stale;
    }
  }
  await commitCarrying(ctx, xid.op(ctx.mission, x, `carry:${id}`), events, carries, stale);
  if (now !== null) await cancelQueuedSeats(ctx, now);
}

/**
 * The version a stop's ruling would prove, with the negation it revokes: the current version when it
 * was negated; else the last version negated. 4.1 §6.3: a round ends with the author's disposition and
 * the Stabilizer's judgment, so a budget stop can come after the author's revision, which no round is
 * left to attack: accepting the residual risks then takes the version the judgments were about.
 */
function rulingTarget(s: XState): { readonly version: XState['versions'][number]; readonly negation: string } | null {
  for (const v of [...s.versions].reverse()) {
    const neg = s.negations.get(v.id);
    if (neg !== undefined) return { version: v, negation: neg };
    if (v.id === s.version?.id && s.lastAttack?.target === v.id) return null; // the current version was attacked and not negated
  }
  return null;
}

/**
 * Route the current stop: converged → settled; the 8.2 stops → an escalation to the Secretary (one
 * per stop: its id carries the stop number); stopped by a decision → settled as no conclusion; a
 * given-up turn → the WI-28 escalation. Only a stop not yet settled is routed: the first one, or one
 * after a reopening (the fold clears the stop a rerun reopens, and the settle with it).
 */
async function routeStop(ctx: FlowCtx, x: string): Promise<boolean> {
  const s = await explorationState(ctx.ports, ctx.mission, x);
  const h = handoffOf(ctx, s);
  if (s.stopped === null || h === null) return false;
  if (s.settled !== null) return false;
  if (s.stopped.reason === 'converged') {
    await settle(ctx, x, h, 'converged', h.research?.noConclusion === true ? 'no-conclusion' : 'conclusion');
    return true;
  }
  if (s.stopped.reason === 'stopped-by-decision') {
    // the decision layer ended it (abandon, re-plan, a given-up turn): the planner hears "no conclusion"
    await settle(ctx, x, h, 'budget', 'no-conclusion');
    return true;
  }
  if (s.stopped.reason === 'seat-abandoned' && s.abandoned !== null) {
    // WI-28: the turn whose seat task was given up: the Secretary restarts it or gives the exploration up
    await raiseEscalation(ctx, {
      id: escId(ctx.mission, x, `stop${s.stopped.n}`),
      source: 'needs-disposition',
      lineage: xid.lineage(ctx.mission, x),
      subject: explorationLine(x),
      summary: `The ${s.abandoned.role} task ${s.abandoned.task} of exploration ${x} was given up (${s.abandoned.reason}); the exploration waits at that turn.`,
      reasons: [s.abandoned.reason],
      options: ['restart', 'abandon', 'ask-user'],
      facts: { exploration: x, task: s.abandoned.task, role: s.abandoned.role, handoff: s.stopped.handoff },
    });
    return false;
  }
  const source = SOURCE[s.stopped.reason];
  if (source === undefined) return false; // the decision layer's own stop
  const id = escId(ctx.mission, x, `stop${s.stopped.n}`);
  const rt = rulingTarget(s);
  await raiseEscalation(ctx, {
    id,
    source,
    lineage: xid.lineage(ctx.mission, x),
    subject: explorationLine(x),
    summary: `Exploration ${x} stopped without converging (${s.stopped.reason}, ${s.rounds} of ${h.allowedRounds} rounds): ${h.unresolvedBlocking.length} fatal or serious in-scope finding(s) unresolved.`,
    // 4.1 §6.3: the findings, the dispositions and the Stabilizer's judgments go to the Secretary
    reasons: [...unresolvedOf(h), ...h.stabilizer.map((j) => `Stabilizer, round ${j.round}: ${j.drift}; ${j.findings.map((f) => `${f.finding.slice(0, 24)} ${f.verdict} (${f.severity}): ${f.reason}`).join('; ')}`)],
    // sending back adds no rounds (review r1 #7): it is offered only while some are left
    // sending back adds no rounds (review r1 #7); accepting waits for any direction question's ruling (code review r1 #2)
    options: STOP_OPTIONS.filter((o) => (o !== 'send-back' || allowedRounds(s) - s.rounds > 0) && (o !== 'accept-risk' || !directionPending(s))),
    position: rt !== null ? { target: rt.version.id, review: 'crititor', revokes: rt.negation } : null,
    facts: { handoff: s.stopped.handoff, reason: s.stopped.reason, wi: s.stopped.wi, version: h.version?.id ?? null, unresolved: h.unresolvedBlocking, decision: h.decision, stabilizer: h.stabilizer },
  });
  return false;
}

// ---------------------------------------------------------------- direction questions

/** The escalation of an escalated finding (one per escalation: rulings on it so far make it distinct). */
function findingEscalation(mission: string, x: string, s: XState, finding: string): string {
  return escId(mission, x, `q.${finding.slice(8, 24)}.${s.rulings.filter((r) => r.findings.includes(finding)).length}`);
}

/** The escalation of a drifting round (one per drift ruled so far). */
/** The escalation of a drifting round: one per drift ruled so far (only drift rulings count: an unrelated ruling never changes it, code review r2 #1). */
function driftEscalation(mission: string, x: string, s: XState): string {
  return escId(mission, x, `drift.${s.drift?.round ?? 0}.${s.rulings.filter((r) => r.drift === true).length}`);
}

/** What the decision layer can do with a direction question the Stabilizer raised (WI-33). */
const DIRECTION_OPTIONS: readonly DecisionOption[] = ['answer', 'send-back', 'abandon', 'ask-user'];

/** The author's free-standing direction questions (not tied to a finding), per author task. */
function questionTasks(s: XState): Array<{ task: string; questions: readonly string[] }> {
  const out: Array<{ task: string; questions: readonly string[] }> = [];
  for (const c of s.consumed.values()) if (c.kind === 'author' && c.directionQuestions.length > 0) out.push({ task: c.task, questions: c.directionQuestions });
  return out;
}

async function routeQuestions(ctx: FlowCtx, x: string): Promise<boolean> {
  const s = await explorationState(ctx.ports, ctx.mission, x);
  // a settled exploration asks nothing more (its open questions were closed with the settle)
  if (s.settled !== null) return false;
  for (const q of questionTasks(s)) {
    await raiseEscalation(ctx, {
      id: escId(ctx.mission, x, `dq.${q.task.split('.').at(-2) ?? q.task}`),
      source: 'exploration-direction',
      lineage: xid.lineage(ctx.mission, x),
      subject: explorationLine(x),
      summary: `The author of exploration ${x} asks ${q.questions.length} direction question(s): ${q.questions.join(' | ')}`,
      reasons: [...q.questions],
      options: ['answer', 'ask-user'],
      facts: { exploration: x, task: q.task, questions: q.questions },
    });
  }
  // the Stabilizer's direction questions (4.1 §6.3, WI-33)
  for (const f of s.findings.values()) {
    if (f.status !== 'awaiting-ruling' || f.scope !== 'shifts-direction') continue;
    await raiseEscalation(ctx, {
      id: findingEscalation(ctx.mission, x, s, f.id),
      source: 'exploration-direction',
      lineage: xid.lineage(ctx.mission, x),
      subject: explorationLine(x),
      summary: `The Stabilizer of exploration ${x} judged a ${effectiveSeverity(f)} finding as shifting the direction: ${f.question ?? f.title}`,
      original: f.title,
      reasons: [f.question ?? f.title, ...(f.disposition !== null ? [`the author's disposition: ${f.disposition.action}: ${f.disposition.note}`] : [])],
      options: DIRECTION_OPTIONS,
      facts: { exploration: x, finding: f.id, severity: effectiveSeverity(f), class: f.class, doc: f.doc, goal: s.def?.goal ?? null, wi: WI.explorationRuling },
    });
  }
  if (s.drift !== null) {
    await raiseEscalation(ctx, {
      id: driftEscalation(ctx.mission, x, s),
      source: 'exploration-direction',
      lineage: xid.lineage(ctx.mission, x),
      subject: explorationLine(x),
      summary: `The Stabilizer of exploration ${x} judged round ${s.drift.round} drifting: ${s.drift.question ?? s.drift.reason}`,
      reasons: [s.drift.reason, ...(s.drift.question !== null ? [s.drift.question] : [])],
      options: DIRECTION_OPTIONS,
      facts: { exploration: x, round: s.drift.round, goal: s.def?.goal ?? null, version: s.version?.id ?? null, wi: WI.explorationRuling },
    });
  }
  for (const f of s.findings.values()) {
    if (f.status !== 'awaiting-ruling' || f.disposition?.action !== 'escalate' || f.scope === 'shifts-direction') continue;
    const id = findingEscalation(ctx.mission, x, s, f.id);
    await raiseEscalation(ctx, {
      id,
      source: 'exploration-direction',
      lineage: xid.lineage(ctx.mission, x),
      subject: explorationLine(x),
      summary: `The author of exploration ${x} escalated a ${f.severity} finding as a direction question: ${f.disposition.question ?? f.title}`,
      original: f.title,
      reasons: [f.disposition.note],
      options: ['answer', 'send-back', 'accept-risk', 'ask-user'],
      facts: { exploration: x, finding: f.id, severity: f.severity, class: f.class, doc: f.doc },
    });
  }
  return false;
}

// ---------------------------------------------------------------- applying decisions

/** Spend that goes with extra rounds when the exploration has its own spend budget: the same share per round. */
function extraSpend(s: XState, rounds: number): number {
  const d = s.def;
  if (d === null || d.budget.spendMicros === null) return 0;
  return Math.ceil((d.budget.spendMicros * rounds) / d.budget.rounds);
}

async function applyDecisions(ctx: FlowCtx, x: string): Promise<boolean> {
  const s = await explorationState(ctx.ports, ctx.mission, x);
  let applied = false;
  // a crash net: a stop the machine left before its decision was carried out (the redefinition that
  // reopened it closes its escalation in its own write; a write lost in between is closed here)
  for (let k = 1; k <= s.stops; k++) {
    if (s.stopped !== null && s.stopped.n === k) continue;
    const id = escId(ctx.mission, x, `stop${k}`);
    if ((await escalation(ctx, id)) === null || (await isApplied(ctx, id))) continue;
    await commitCarrying(ctx, `flow:superseded:${ctx.mission}:${id}`, [], [closing(ctx, [id], `exploration ${x} left stop ${k} before the decision was carried out (its definition changed)`)], [id]);
    applied = true;
  }
  // a given-up turn (WI-28)
  if (s.stopped !== null && s.stopped.reason === 'seat-abandoned') {
    const id = escId(ctx.mission, x, `stop${s.stopped.n}`);
    const d = (await isApplied(ctx, id)) ? null : await decisionFor(ctx, id);
    if (d !== null && d.option !== 'ask-user') {
      const by = d.by === 'user' ? 'user' : 'secretary';
      if (d.option === 'restart') await carryDecision(ctx, x, id, d.option, [{ id, decision: 'retry', findings: [], text: d.reason, extraRounds: 0, by }]);
      else await carryDecision(ctx, x, id, d.option, [{ id, decision: 'stop', findings: [], text: d.reason, extraRounds: 0, by }], { stop: 'budget', outcome: 'no-conclusion', handoff: () => handoffOf(ctx, s) });
      return true;
    }
  }
  // the stop escalation of the current stop
  if (s.stopped !== null && SOURCE[s.stopped.reason] !== undefined) {
    const stopped = s.stopped;
    const id = escId(ctx.mission, x, `stop${stopped.n}`);
    const d = (await isApplied(ctx, id)) ? null : await decisionFor(ctx, id);
    // a direction question still waiting gates the acceptance (code review r1 #2): applied once it is ruled
    const waitAccept = d !== null && (d.option === 'accept-risk' || d.option === 'accept') && directionPending(s);
    if (d !== null && !waitAccept && d.option !== 'ask-user') {
      const h = handoffOf(ctx, s) as ExplorationHandoff;
      const by = d.by === 'user' ? 'user' : 'secretary';
      const stop = stopped.reason === 'budget-exhausted' ? 'budget' : 'repeated-fatal';
      switch (d.option) {
        case 'grant': {
          // through the ledger's grant rule (6.5: the Secretary once per lineage, across all its
          // loops; then only the user), never a local count (review r1 #7)
          const extra = d.grantExtra > 0 ? d.grantExtra : 2;
          const g = await ctx.ports.scheduler.grant({ op: `grant:${id}:${by}`, lineage: xid.lineage(ctx.mission, x), loop: 'env-retry', by, extra, reason: `exploration rounds: ${d.reason}` });
          if (!g.granted) {
            // the escalation stays open for the user's own answer (review r1 #8: not marked applied)
            await escalateToUser(ctx, id, `exploration ${x}: the ledger refused the Secretary's grant (${g.why ?? 'refused'}); only the user can grant more rounds (6.5, WI-08)`, 'WI-08');
            return true;
          }
          await carryDecision(ctx, x, id, d.option, [{ id, decision: 'extend', findings: [], text: d.reason, extraRounds: extra, extraMicros: extraSpend(s, extra), by }]);
          break;
        }
        case 'accept-risk':
        case 'accept':
          // the findings become residual risks and the exploration settles on the version the stop's
          // position named; the ruling pass that revokes its negation rides in the same write
          await carryDecision(ctx, x, id, d.option, [{ id, decision: 'accept-risk', findings: [...h.unresolvedBlocking], text: d.reason, extraRounds: 0, by }], {
            stop,
            outcome: 'conclusion',
            handoff: (now) => {
              const rv = rulingTarget(s)?.version ?? null;
              const accepted = buildHandoff(now, stopped.reason, stopped.wi);
              return rv !== null ? { ...accepted, version: { id: rv.id, content: rv.content } } : accepted;
            },
          });
          break;
        case 'send-back':
        case 'rework':
          // a new direction, within the budget left: sending back never adds rounds by itself
          // (review r1 #7); when none are left the exploration stops again and only a grant helps
          await carryDecision(ctx, x, id, d.option, [
            { id: `${id}.redirect`, decision: 'redirect', findings: [...h.unresolvedBlocking], text: d.instructions !== '' ? d.instructions : d.reason, extraRounds: 0, by },
            { id, decision: 'resume', findings: [], text: 'the direction changed', extraRounds: 0, by },
          ]);
          break;
        default:
          // replan, abandon: the decision layer ends it without a conclusion
          await carryDecision(ctx, x, id, d.option, [{ id, decision: 'stop', findings: [], text: d.reason, extraRounds: 0, by }], { stop, outcome: 'no-conclusion', handoff: () => h });
          break;
      }
      applied = true;
    }
  }
  // free-standing direction questions: the answer goes to the author and the attacker
  for (const q of questionTasks(s)) {
    const id = escId(ctx.mission, x, `dq.${q.task.split('.').at(-2) ?? q.task}`);
    if (await isApplied(ctx, id)) continue;
    const d = await decisionFor(ctx, id);
    if (d === null || d.option === 'ask-user') continue;
    await carryDecision(ctx, x, id, d.option, [{ id, decision: 'answer', findings: [], answers: q.task, text: d.instructions !== '' ? d.instructions : d.reason, extraRounds: 0, by: d.by === 'user' ? 'user' : 'secretary' }]);
    applied = true;
  }
  // the Stabilizer's direction questions (4.1 §6.3, WI-33): keep the definition, change the direction, or end it
  const direction = async (id: string, findings: readonly string[], drift = false): Promise<boolean> => {
    if (await isApplied(ctx, id)) return false;
    const d = await decisionFor(ctx, id);
    if (d === null || d.option === 'ask-user') return false;
    const by = d.by === 'user' ? 'user' : 'secretary';
    const text = d.instructions !== '' ? d.instructions : d.reason;
    const which = drift ? { drift: true as const } : {};
    if (d.option === 'answer' || d.option === 'accept' || d.option === 'accept-risk') await carryDecision(ctx, x, id, d.option, [{ id, decision: 'keep-direction', findings: [...findings], text, extraRounds: 0, by, ...which }]);
    else if (d.option === 'send-back' || d.option === 'rework') await carryDecision(ctx, x, id, d.option, [{ id, decision: 'redirect', findings: [...findings], text, extraRounds: 0, by, ...which }]);
    else await carryDecision(ctx, x, id, d.option, [{ id, decision: 'stop', findings: [], text, extraRounds: 0, by }], { stop: 'budget', outcome: 'no-conclusion', handoff: (now) => buildHandoff(now, 'stopped-by-decision', null) });
    return true;
  };
  for (const f of s.findings.values()) {
    if (f.status !== 'awaiting-ruling' || f.scope !== 'shifts-direction') continue;
    if (await direction(findingEscalation(ctx.mission, x, s, f.id), [f.id])) applied = true;
  }
  if (s.drift !== null && (await direction(driftEscalation(ctx.mission, x, s), [], true))) applied = true;
  // escalated findings
  for (const f of s.findings.values()) {
    if (f.status !== 'awaiting-ruling' || f.disposition?.action !== 'escalate' || f.scope === 'shifts-direction') continue;
    const id = findingEscalation(ctx.mission, x, s, f.id);
    if (await isApplied(ctx, id)) continue;
    const d = await decisionFor(ctx, id);
    if (d === null || d.option === 'ask-user') continue;
    const by = d.by === 'user' ? 'user' : 'secretary';
    const text = d.instructions !== '' ? d.instructions : d.reason;
    await carryDecision(ctx, x, id, d.option, [{ id, decision: d.option === 'accept-risk' || d.option === 'accept' ? 'accept-risk' : 'redirect', findings: [f.id], text, extraRounds: 0, by }]);
    applied = true;
  }
  return applied;
}

/** Register the exploration and legalization steps with the flow engine (see register.ts). */
export function registerExplorationStep(): void {
  registerFlowStep('exploration', explorationStep);
}
