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
// Every decision is applied once (the ruling's id is the escalation's; markApplied).

import { canonicalJson, sha256 } from '../../common/hash.ts';
import type { MissionId } from '../../common/ids.ts';
import { idPart, safeId, type FlowCtx } from '../context.ts';
import { registerFlowStep } from '../engine.ts';
import { EXPLORATION_SETTLED, PLAN_LINE, PM_PLAN_EFFECTIVE, PmPlanDoc, explorationLine, type ExplorationSettledBody, type PmPlanEffectiveBody } from '../plandoc.ts';
import { handleFailure } from '../failures.ts';
import type { FlowTaskStatus } from '../ports.ts';
import { decisionFor, escalateToUser, isApplied, markApplied, raiseEscalation } from '../secretary.ts';
import type { DecisionOption } from '../../seat/cards/secretary.ts';
import { explorationDefinition, xid, type ExplorationDefinition } from './definition.ts';
import { advanceExploration, buildHandoff, defineExploration, explorationState, recordExplorationRuling, redefineExploration, type ExplorationHandoff } from './flow.ts';
import { allowedRounds, type QueuedBody, type StopReason, type XState } from './machine.ts';

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
    // a later plan changed the exploration: a new definition version, unless it already settled
    const cur = (await explorationState(ctx.ports, mission, id)).def;
    if (cur === null || sameDefinition(cur, def)) continue;
    const settled = await ctx.ports.ledger.events({ mission, line: explorationLine(id), event: EXPLORATION_SETTLED });
    if (settled.length > 0) {
      await ctx.ports.ledger.notify({
        mission,
        category: 'exploration-changed-after-settling',
        wi: null,
        key: `${id}:${canonicalJson(def).length}:${sha256(canonicalJson(def)).slice(0, 12)}`,
        trigger: `a PM plan changes exploration ${id}, which has already settled`,
        defaultAction: 'the settled result stands and is not reopened; to explore again under the changed definition, give the exploration a new id in the plan',
        detail: { exploration: id },
      });
      continue;
    }
    if (await redefineExploration(ports, def)) ctx.progressed = true;
  }
  for (const d of await ctx.ports.ledger.events({ mission, event: 'defined' })) {
    if (!d.line.startsWith('exploration:')) continue;
    const x = d.line.slice('exploration:'.length);
    if (await applyDecisions(ctx, x)) ctx.progressed = true;
    const r = await advanceExploration(ports, mission, x, 64, (q, st) => onFailedTask(ctx, x, q, st));
    if (r.steps > 0) ctx.progressed = true;
    if (await routeStop(ctx, x)) ctx.progressed = true;
    if (await routeQuestions(ctx, x)) ctx.progressed = true;
    await watchSettled(ctx, x);
  }
}

/**
 * Whether a settled exploration still stands on proof (review r1 #2): its product version is
 * proven at the evaluator's published revision. The decision layer plans from a settled
 * exploration only while this holds (the "settled" event is history; the proof is current).
 */
export async function settledArtifactProven(ports: Pick<FlowCtx['ports'], 'ledger' | 'evaluator'>, mission: MissionId, x: string): Promise<{ readonly artifact: string | null; readonly proven: boolean; readonly label: string | null }> {
  const s = (await ports.ledger.events<ExplorationSettledBody>({ mission, line: explorationLine(x), event: EXPLORATION_SETTLED }))[0];
  const artifact = s?.body.artifact ?? null;
  if (artifact === null) return { artifact, proven: false, label: null };
  const label = (await ports.evaluator.labels([artifact])).labels[artifact] ?? null;
  return { artifact, proven: label === 'proven', label };
}

/** A settled conclusion whose product lost its proof: the PM is told once per loss (a normal branch, like 6.1's episodes). */
async function watchSettled(ctx: FlowCtx, x: string): Promise<void> {
  const s = (await ctx.ports.ledger.events<ExplorationSettledBody>({ mission: ctx.mission, line: explorationLine(x), event: EXPLORATION_SETTLED }))[0];
  if (s === undefined || s.body.outcome !== 'conclusion' || s.body.artifact === null) return;
  const v = await settledArtifactProven(ctx.ports, ctx.mission, x);
  if (v.proven) return;
  await ctx.ports.ledger.notify({
    mission: ctx.mission,
    category: 'exploration-conclusion-unproven',
    wi: null,
    key: `${x}:${v.artifact}:${v.label ?? 'unknown'}`,
    trigger: `the product ${v.artifact} of settled exploration ${x} is now ${v.label ?? 'unknown'} (an evidence execution or the definition it rests on changed)`,
    defaultAction: 'nothing is reopened automatically; work planned from this conclusion rests on a product that is no longer proven; to restore it, define a new exploration (or the decision layer re-plans)',
    detail: { exploration: x, artifact: v.artifact, label: v.label },
  });
}

// ---------------------------------------------------------------- failed seat tasks (WI-15, WI-08)

/**
 * A seat task of the exploration that ended without a usable hand-back goes to the Secretary like
 * any flow's (failures.ts): restart (counted in the quarantine-restart loop), grant (environment
 * retries exhausted), or abandon. Abandoning an evidence run records it as failed and the seat
 * that asked goes on; abandoning a turn ends the exploration without a conclusion.
 */
async function onFailedTask(ctx: FlowCtx, x: string, q: QueuedBody, st: FlowTaskStatus): Promise<void> {
  const why = st.state === 'exhausted' ? 'exhausted' : st.disposition === 'full-review' ? 'full-review' : 'needs-disposition';
  const o = await handleFailure(ctx, { task: q.task, lineage: q.lineage, subject: explorationLine(x), view: { kind: 'failed', status: st, why }, canAbandon: true, canReplan: false });
  if (o.kind !== 'decided') return;
  const ports = { ledger: ctx.ports.ledger, scheduler: ctx.ports.scheduler };
  if (q.role !== 'executor') {
    await recordExplorationRuling(ports, ctx.mission, x, { id: o.escalation, decision: 'stop', findings: [], text: `the ${q.role} turn was given up: ${o.decision.reason}`, extraRounds: 0, by: o.decision.by === 'user' ? 'user' : 'secretary' });
  }
  await ctx.ports.scheduler.cancel(q.task);
  await markApplied(ctx, o.escalation, { option: o.decision.option, task: q.task });
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
  return h.findings.filter((f) => f.status !== 'resolved' || f.residualRisk).map((f) => `${f.residualRisk ? 'residual risk' : f.status}: (${f.severity}, ${f.class}) ${f.title}`);
}

async function settle(ctx: FlowCtx, x: string, s: XState, h: ExplorationHandoff, stop: ExplorationSettledBody['stop'], outcome: ExplorationSettledBody['outcome']): Promise<void> {
  // settled once (plandoc.ts: key = the exploration id)
  if ((await ctx.ports.ledger.events({ mission: ctx.mission, line: explorationLine(x), event: EXPLORATION_SETTLED })).length > 0) return;
  const def = s.def as ExplorationDefinition;
  const body: ExplorationSettledBody = {
    exploration: x,
    decision: { id: def.decision.id ?? x, type: def.decision.type },
    outcome,
    stop,
    artifact: h.version?.id ?? null,
    summary: summaryOf(ctx, s, h),
    unresolved: unresolvedOf(h),
  };
  await ctx.ports.ledger.append(xid.op(ctx.mission, x, 'settled'), { events: [{ mission: ctx.mission, line: explorationLine(x), event: EXPLORATION_SETTLED, key: x, body }] });
}

/** Route a stop once: converged → settled; the 8.2 stops → an escalation to the Secretary. */
async function routeStop(ctx: FlowCtx, x: string): Promise<boolean> {
  const s = await explorationState(ctx.ports, ctx.mission, x);
  const h = handoffOf(ctx, s);
  if (s.stopped === null || h === null) return false;
  const settled = await ctx.ports.ledger.events({ mission: ctx.mission, line: explorationLine(x), event: EXPLORATION_SETTLED });
  if (settled.length > 0) return false;
  if (s.stopped.reason === 'converged') {
    await settle(ctx, x, s, h, 'converged', h.research?.noConclusion === true ? 'no-conclusion' : 'conclusion');
    return true;
  }
  if (s.stopped.reason === 'stopped-by-decision') {
    // the decision layer ended it (abandon, re-plan, a given-up turn): the planner hears "no conclusion"
    await settle(ctx, x, s, h, 'budget', 'no-conclusion');
    return true;
  }
  if (s.stopped.reason === 'seat-abandoned' && s.abandoned !== null) {
    // WI-15: the turn whose seat task was given up: the Secretary restarts it or gives the exploration up
    await raiseEscalation(ctx, {
      id: escId(ctx.mission, x, `stop${s.stopped.n}`),
      source: 'needs-disposition',
      lineage: xid.lineage(ctx.mission, x),
      subject: explorationLine(x),
      summary: `The ${s.abandoned.role} task ${s.abandoned.task} of exploration ${x} was given up after its failure (${s.abandoned.reason}); the exploration waits at that turn.`,
      reasons: [s.abandoned.reason],
      options: ['restart', 'abandon', 'ask-user'],
      facts: { exploration: x, task: s.abandoned.task, role: s.abandoned.role, handoff: s.stopped.handoff },
    });
    return false;
  }
  const source = SOURCE[s.stopped.reason];
  if (source === undefined) return false; // the decision layer's own stop
  const id = escId(ctx.mission, x, `stop${s.stopped.n}`);
  const neg = s.version !== null ? (s.negations.get(s.version.id) ?? null) : null;
  await raiseEscalation(ctx, {
    id,
    source,
    lineage: xid.lineage(ctx.mission, x),
    subject: explorationLine(x),
    summary: `Exploration ${x} stopped without converging (${s.stopped.reason}, ${s.rounds} of ${h.allowedRounds} rounds): ${h.unresolvedBlocking.length} fatal or serious finding(s) unresolved.`,
    reasons: unresolvedOf(h),
    // sending back adds no rounds (review r1 #7): it is offered only while some are left
    options: allowedRounds(s) - s.rounds > 0 ? STOP_OPTIONS : STOP_OPTIONS.filter((o) => o !== 'send-back'),
    position: neg !== null && s.version !== null ? { target: s.version.id, review: 'crititor', revokes: neg } : null,
    facts: { handoff: s.stopped.handoff, reason: s.stopped.reason, wi: s.stopped.wi, version: h.version?.id ?? null, unresolved: h.unresolvedBlocking, decision: h.decision },
  });
  return false;
}

// ---------------------------------------------------------------- direction questions

/** The escalation of an escalated finding (one per escalation: rulings on it so far make it distinct). */
function findingEscalation(mission: string, x: string, s: XState, finding: string): string {
  return escId(mission, x, `q.${finding.slice(8, 24)}.${s.rulings.filter((r) => r.findings.includes(finding)).length}`);
}

/** The author's free-standing direction questions (not tied to a finding), per author task. */
function questionTasks(s: XState): Array<{ task: string; questions: readonly string[] }> {
  const out: Array<{ task: string; questions: readonly string[] }> = [];
  for (const c of s.consumed.values()) if (c.kind === 'author' && c.directionQuestions.length > 0) out.push({ task: c.task, questions: c.directionQuestions });
  return out;
}

async function routeQuestions(ctx: FlowCtx, x: string): Promise<boolean> {
  const s = await explorationState(ctx.ports, ctx.mission, x);
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
  for (const f of s.findings.values()) {
    if (f.status !== 'awaiting-ruling' || f.disposition?.action !== 'escalate') continue;
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
  const ports = { ledger: ctx.ports.ledger, scheduler: ctx.ports.scheduler };
  // a given-up turn (WI-15)
  if (s.stopped !== null && s.stopped.reason === 'seat-abandoned') {
    const id = escId(ctx.mission, x, `stop${s.stopped.n}`);
    const d = (await isApplied(ctx, id)) ? null : await decisionFor(ctx, id);
    if (d !== null && d.option !== 'ask-user') {
      const by = d.by === 'user' ? 'user' : 'secretary';
      if (d.option === 'restart') await recordExplorationRuling(ports, ctx.mission, x, { id, decision: 'retry', findings: [], text: d.reason, extraRounds: 0, by });
      else {
        await recordExplorationRuling(ports, ctx.mission, x, { id, decision: 'stop', findings: [], text: d.reason, extraRounds: 0, by });
        const h = handoffOf(ctx, s);
        if (h !== null) await settle(ctx, x, s, h, 'budget', 'no-conclusion');
      }
      await markApplied(ctx, id, { option: d.option });
      return true;
    }
  }
  // the stop escalation of the current stop
  if (s.stopped !== null && SOURCE[s.stopped.reason] !== undefined) {
    const id = escId(ctx.mission, x, `stop${s.stopped.n}`);
    const d = (await isApplied(ctx, id)) ? null : await decisionFor(ctx, id);
    if (d !== null) {
      const h = handoffOf(ctx, s) as ExplorationHandoff;
      const by = d.by === 'user' ? 'user' : 'secretary';
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
          await recordExplorationRuling(ports, ctx.mission, x, { id, decision: 'extend', findings: [], text: d.reason, extraRounds: extra, extraMicros: extraSpend(s, extra), by });
          break;
        }
        case 'accept-risk':
        case 'accept':
          // the ruling pass on the negated version (the Secretary's launch or the user's answer)
          // already revokes the negation; the findings become residual risks and the exploration settles
          await recordExplorationRuling(ports, ctx.mission, x, { id, decision: 'accept-risk', findings: [...h.unresolvedBlocking], text: d.reason, extraRounds: 0, by });
          {
            const now = await explorationState(ctx.ports, ctx.mission, x);
            await settle(ctx, x, now, buildHandoff(now, s.stopped.reason, s.stopped.wi), s.stopped.reason === 'budget-exhausted' ? 'budget' : 'repeated-fatal', 'conclusion');
          }
          break;
        case 'send-back':
        case 'rework':
          // a new direction, within the budget left: sending back never adds rounds by itself
          // (review r1 #7); when none are left the exploration stops again and only a grant helps
          await recordExplorationRuling(ports, ctx.mission, x, { id: `${id}.redirect`, decision: 'redirect', findings: [...h.unresolvedBlocking], text: d.instructions !== '' ? d.instructions : d.reason, extraRounds: 0, by });
          await recordExplorationRuling(ports, ctx.mission, x, { id, decision: 'resume', findings: [], text: 'the direction changed', extraRounds: 0, by });
          break;
        case 'replan':
        case 'abandon':
          await recordExplorationRuling(ports, ctx.mission, x, { id, decision: 'stop', findings: [], text: d.reason, extraRounds: 0, by });
          await settle(ctx, x, s, h, s.stopped.reason === 'budget-exhausted' ? 'budget' : 'repeated-fatal', 'no-conclusion');
          break;
        default:
          break; // ask-user: the PM asks; the user's answer arrives as a decision later
      }
      await markApplied(ctx, id, { option: d.option });
      applied = true;
    }
  }
  // free-standing direction questions: the answer goes to the author and the attacker
  for (const q of questionTasks(s)) {
    const id = escId(ctx.mission, x, `dq.${q.task.split('.').at(-2) ?? q.task}`);
    if (await isApplied(ctx, id)) continue;
    const d = await decisionFor(ctx, id);
    if (d === null || d.option === 'ask-user') continue;
    await recordExplorationRuling(ports, ctx.mission, x, { id, decision: 'answer', findings: [], text: d.instructions !== '' ? d.instructions : d.reason, extraRounds: 0, by: d.by === 'user' ? 'user' : 'secretary' });
    await markApplied(ctx, id, { option: d.option });
    applied = true;
  }
  // escalated findings
  for (const f of s.findings.values()) {
    if (f.status !== 'awaiting-ruling' || f.disposition?.action !== 'escalate') continue;
    const id = findingEscalation(ctx.mission, x, s, f.id);
    if (await isApplied(ctx, id)) continue;
    const d = await decisionFor(ctx, id);
    if (d === null || d.option === 'ask-user') continue;
    const by = d.by === 'user' ? 'user' : 'secretary';
    const text = d.instructions !== '' ? d.instructions : d.reason;
    if (d.option === 'accept-risk' || d.option === 'accept') await recordExplorationRuling(ports, ctx.mission, x, { id, decision: 'accept-risk', findings: [f.id], text, extraRounds: 0, by });
    else await recordExplorationRuling(ports, ctx.mission, x, { id, decision: 'redirect', findings: [f.id], text, extraRounds: 0, by });
    await markApplied(ctx, id, { option: d.option });
    applied = true;
  }
  return applied;
}

/** Register the exploration and legalization steps with the flow engine (see register.ts). */
export function registerExplorationStep(): void {
  registerFlowStep('exploration', explorationStep);
}
