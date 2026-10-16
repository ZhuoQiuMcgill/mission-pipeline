import { reviewInputVersions, objectConstraints, boundObjectConstraints, changedPlanningInputs, planningContext, type PlanningInputs, withdrawnPlanReason, standardLine } from '../seat/cards/inputs.ts';
export { standardLine } from '../seat/cards/inputs.ts';
import { productionDisputed } from '../seat/cards/dynamic.ts';
// The decision layer (design 3.1–3.10): PM plan → Calibrator ① → Architect (decomposition) →
// program mechanical checks → feasibility review → Calibrator ② → the plan's tasks released;
// Secretary escalations on the way; the plan grows by rounds.
//
//   PM batch (3.3)           the PM records a batch: a new PM plan version (an object with the
//                            calibrator-1 contract, 10.1) plus the user's words and the changed
//                            items of the batch. One Calibrator ① per batch.
//   Calibrator ① (3.3)       pass → the plan takes effect (event pm-plan-effective) and the
//                            Architect starts; fail → back to the PM with the reasons and the
//                            questions, the involved items contested (uncapped: 6.5, the PM only
//                            works with the user present). A continuation review extends the
//                            previous plan version's pass (5.2 part 5); "needs full review" or a
//                            refused continuation runs a full review instead (a normal branch).
//   re-check (3.3, 5.2 p. 5) a batch whose plan document is the plan in effect, unchanged (only the
//                            requirement items or the user's words moved): no new version and no
//                            Architect; Calibrator ① judges the SAME plan version again, as a
//                            continuation of its deciding pass focused on the changed items. A pass
//                            makes the plan current on the new requirement set, and restores indirect dependents whose own inputs remain current (5.2 part 5: "M2 and the
//                            detailed plan recover"); a fail goes back to the PM like any batch.
//   Architect (3.4)          attempt k on PM plan version n; its hand-back is the detailed plan
//                            version dplan.<mission>.<n>.<k>.
//   mechanical checks (3.5)  fail → back to the Architect (mechanical-return, cap 3, no-progress);
//                            exhausted → WI-08 and the Secretary (grant once, or the user). Order
//                            changes against a user-specified order → the Secretary.
//   feasibility (3.6)        when the program's rule says so: return → the Architect revises once
//                            (feasibility-return, cap 1); still unresolved → the Secretary (accept
//                            the risk, send back with its grant, or ask the user).
//   Calibrator ② (3.7)       pass → the plan is effective: its acceptance standards become basis
//                            lines and its tasks go to execution; escalate → the Secretary
//                            (accept, send back, ask the user); never straight back to the Architect.
//   rounds (3.10)            explorations defined in the PM plan settle (event "settled" on
//                            their line): structure type → the Architect decomposes the waiting
//                            part; direction type, no conclusion, or the key conclusion not
//                            standing → the Secretary, the PM and the user. Only the current
//                            settle counts (one per opening: a rerun after an environment change
//                            reopens it); a changed conclusion after a reopening is routed again.
//   re-plan requests         from execution (a Secretary's "re-plan") → a new Architect attempt.

import type { BasisLineId, BasisVersionId, ContentHash, MissionId, ObjectVersionId } from '../common/ids.ts';
import { canonicalJson } from '../common/hash.ts';
import type { BaseRecord, JudgmentRecord, ObjectVersionRecord, UserWordsRecord } from '../common/records.ts';
import { PREVIOUS_PLAN_MATERIAL, previousPlanText, type ArchitectDecomposeCard, type ArchitectFeasibilityCard, type ArchitectFeasibilityResult } from '../seat/cards/architect.ts';
import type { Calibrator1Card, Calibrator1Result, Calibrator2Card, Calibrator2Result } from '../seat/cards/calibrator.ts';
import { calibrator1Verdict, calibrator2Verdict } from '../seat/cards/calibrator.ts';
import {
  basisIndex,
  binding,
  cardBase,
  commit,
  currentVersions,
  ev,
  eventOf,
  eventsOf,
  flowCtx,
  judgmentRecordOf,
  material,
  notify,
  objectRecord,
  idPart,
  safeId,
  shortHash,
  taskView,
  countedReturn,
  nextBasisVersion,
  tellOnce,
  missionClosed,
  type FlowCtx,
} from './context.ts';
import { handleFailure } from './failures.ts';
import { mechanicalCheck, type MechanicalResult } from './mechanical.ts';
import {
  DetailedPlanDoc,
  DetailedTask,
  PLAN_LINE,
  PM_PLAN_EFFECTIVE,
  PmPlanDoc,
  SECRETARY_LINE,
  pmPlanIdProblems,
  feasibilityRequired,
  type ExplorationSettledBody,
  type PmPlanEffectiveBody,
  type StoredDetailedPlan,
  taskLine,
} from './plandoc.ts';
import type { FlowEventInput, FlowPorts } from './ports.ts';
import { currentItems, currentConstraints, itemLine, requirementSetLine, setContested, type CurrentItem } from './requirements.ts';
import { cancelSecretarySteps, carried, carryGuard, carryOut, closeEscalations, closedEscalation, closing, commitCarrying, decisionFor, escalateToUser, escalation, isApplied, markApplied, openEscalations, raiseEscalation, type Carry, type EscalationBody } from './secretary.ts';
import { WI } from './wi.ts';
import { currentSettle, settledArtifactProven } from './exploration/step.ts';

export interface PmBatchBody {
  readonly batch: string;
  readonly n: number;
  readonly plan: string;
  readonly predecessor: string | null;
  readonly round: number;
  readonly doc: string;
  readonly userWords: readonly string[];
  /** Item lines changed in the batch, and items whose authorization or premise changed. */
  readonly changedItems: readonly string[];
  readonly dependentItems: readonly string[];
  /** The mission's default (4.1, maintainer: one default per task, exceptions by goal). */
  readonly mode: 'stable' | 'fast';
  readonly requirementSet?: string;
}

/**
 * A re-check of the PM plan in effect (3.3, 5.2 part 5): the PM submitted the plan document in
 * effect unchanged with a new batch of words or changed items. Calibrator ① judges the same plan
 * version again (task cal1.<mission>.<n>.c<m>); no new version, no Architect attempt.
 */
export interface RecheckBody {
  /** "b<n>.c<m>": what `mp pm plan submit` reports. */
  readonly batch: string;
  readonly plan: string;
  /** The plan's batch number. */
  readonly n: number;
  readonly m: number;
  readonly requirementSet?: string;
  readonly mode?: 'stable' | 'fast';
  readonly userWords: readonly string[];
  readonly changedItems: readonly string[];
  readonly dependentItems: readonly string[];
}

export const CAL1_RECHECK = 'cal1-recheck';

/** Shared by the hand-back gate, which checks supersession inside its write. */
export function supersededRecheck(task: string, batches: readonly PmBatchBody[], requests: readonly RecheckBody[]): string | null {
  const r = requests.find((r) => {
    const prefix = `cal1.${r.plan.slice('pmplan.'.length)}.c${r.m}`;
    return task === prefix || task.startsWith(`${prefix}.`);
  });
  if (r === undefined) return null;
  return batches.at(-1)?.plan !== r.plan || requests.filter((x) => x.plan === r.plan).at(-1)?.m !== r.m
    ? `re-check ${r.batch} was superseded by a newer request` : null;
}

interface Cal1Body {
  readonly task: string;
  readonly outcome: 'pass' | 'fail' | 'undecided' | 'needs-full-review';
  readonly judgment: string | null;
  readonly contested: readonly string[];
  readonly questions: readonly { element: string; question: string; why: string }[];
  readonly reasons: readonly string[];
}

/** One Architect attempt's inputs. */
interface AttemptBody {
  readonly k: number;
  readonly reason: 'initial' | 'mechanical' | 'feasibility' | 'secretary' | 'replan' | 'exploration';
  readonly previous: string | null;
  readonly mechanicalFailures: readonly string[];
  readonly feasibilityFindings: readonly string[];
  readonly instructions: readonly string[];
  readonly conclusions: readonly { exploration: string; summary: string }[];
}

interface ArchBody {
  readonly task: string;
  readonly k: number;
  readonly object: string;
}

interface FeasBody {
  readonly task: string;
  readonly dplan: string;
  readonly verdict: 'feasible' | 'return';
  readonly judgment: string;
  readonly findings: readonly string[];
  readonly risks: readonly string[];
}

interface Cal2Body {
  readonly task: string;
  readonly dplan: string;
  readonly outcome: 'pass' | 'escalate' | 'needs-full-review';
  readonly judgment: string | null;
  readonly escalation: string;
}

export interface EffectiveBody {
  readonly dplan: string;
  readonly pmPlan: string;
  readonly n: number;
  readonly round: number;
  readonly mode: 'stable' | 'fast';
  readonly tasks: readonly string[];
  readonly risks: readonly string[];
}

const DETAILED_PLAN_PATH = 'plans/detailed-plan.json';
const PM_PLAN_PATH = 'plans/pm-plan.json';

export const planLineage = (mission: string, n: number): string => safeId(`plan.${mission}.${n}`);
const pmPlanObject = (mission: string, n: number): string => safeId(`pmplan.${mission}.${n}`);
const cal1Task = (mission: string, n: number, full: boolean): string => safeId(`cal1.${mission}.${n}${full ? '.full' : ''}`);
const recheckTask = (mission: string, n: number, m: number, full: boolean): string => safeId(`cal1.${mission}.${n}.c${m}${full ? '.full' : ''}`);
const archTask = (mission: string, n: number, k: number): string => safeId(`arch.${mission}.${n}.${k}`);
const dplanObject = (mission: string, n: number, k: number): string => safeId(`dplan.${mission}.${n}.${k}`);
const feasTask = (dplan: string): string => safeId(`feas.${dplan}`);
const cal2Task = (dplan: string, full: boolean): string => safeId(`cal2.${dplan}${full ? '.full' : ''}`);

// ---------------------------------------------------------------- the PM's API (3.3)

/**
 * The PM records one alignment batch (3.3): the new PM plan version and what the batch touched.
 * Idempotent: the same plan and words again return the batch already recorded. A batch whose
 * plan document is the plan in effect, unchanged, is a re-check of that version (no new version,
 * `recheck: true`), unless it changes the mission's mode.
 */
export async function submitPmBatch(
  ports: FlowPorts,
  req: { readonly mission: MissionId; readonly plan: unknown; readonly userWords: readonly string[]; readonly changedItems?: readonly string[]; readonly dependentItems?: readonly string[]; readonly mode?: 'stable' | 'fast' },
): Promise<{ readonly batch: string; readonly plan: string; readonly recheck?: boolean }> {
  const ctx = flowCtx(ports, req.mission);
  const doc = PmPlanDoc.parse(req.plan);
  if (doc.mission !== req.mission) throw new Error(`the plan names mission ${doc.mission}, not ${req.mission}`);
  const dup = pmPlanIdProblems(doc);
  if (dup.length > 0) throw new Error(`the PM plan repeats ids: ${dup.join('; ')}`);
  const docText = canonicalJson(doc);
  const docHash = ports.ledger.content.put(docText);
  const batches = await eventsOf<PmBatchBody>(ctx, PLAN_LINE, 'pm-batch');
  const last = batches.at(-1)?.body ?? null;
  const lineOf = (item: string): string => itemLine(req.mission, item);
  const changed = (req.changedItems ?? []).map(lineOf);
  const dependent = (req.dependentItems ?? []).map(lineOf);
  const ix = await basisIndex(ctx);
  const requirementSet = ix.current.get(requirementSetLine(req.mission)) ?? `${requirementSetLine(req.mission)}.v1`;
  const mode = req.mode ?? last?.mode ?? 'stable';
  if (last !== null && last.doc === docHash) {
    // the plan document is the latest version's: a retry of the latest request about it, or (once
    // that version took effect) a re-check of it on the requirement items as they are now (5.2 part 5)
    const effective = (await eventOf(ctx, PLAN_LINE, PM_PLAN_EFFECTIVE, last.plan)) !== null;
    const rechecks = effective ? (await eventsOf<RecheckBody>(ctx, PLAN_LINE, CAL1_RECHECK)).filter((e) => e.body.plan === last.plan).map((e) => e.body) : [];
    const latestRequest: PmBatchBody | RecheckBody = rechecks.at(-1) ?? last;
    if (latestRequest.requirementSet === requirementSet && (latestRequest.mode ?? last.mode) === mode && canonicalJson(latestRequest.dependentItems) === canonicalJson(dependent) && canonicalJson(latestRequest.userWords) === canonicalJson(req.userWords) && canonicalJson(latestRequest.changedItems) === canonicalJson(changed)) {
      return { batch: latestRequest.batch, plan: last.plan, ...(latestRequest !== last ? { recheck: true } : {}) };
    }
    if (effective && (req.mode === undefined || req.mode === last.mode)) {
      const m = rechecks.length + 1;
      const body: RecheckBody = { batch: `${last.batch}.c${m}`, plan: last.plan, n: last.n, m, requirementSet, mode, userWords: [...req.userWords], changedItems: changed, dependentItems: dependent };
      await commit(ctx, `flow:cal1-recheck:${req.mission}:${last.plan}:${m}`, { events: [ev(ctx, PLAN_LINE, CAL1_RECHECK, `${last.plan}#c${m}`, body)] });
      return { batch: body.batch, plan: last.plan, recheck: true };
    }
  }
  const n = (last?.n ?? 0) + 1;
  const plan = pmPlanObject(req.mission, n);
  const authLines = doc.authorizations.map(lineOf);
  const rec: ObjectVersionRecord = {
    kind: 'object.version',
    object: plan as ObjectVersionId,
    objectKind: 'plan',
    mission: req.mission,
    module: null,
    content: docHash,
    prerequisites: ports.ledger.content.putList([]),
    scope: { paths: [PM_PLAN_PATH], taskType: 'pm-plan' },
    reviews: [{ review: 'calibrator-1', basisLines: [requirementSetLine(req.mission), ...authLines] as BasisLineId[], reliesOn: [] }],
    ...(last !== null ? { predecessor: last.plan as ObjectVersionId } : {}),
  };
  const body: PmBatchBody = { batch: `b${n}`, n, plan, predecessor: last?.plan ?? null, round: doc.round, doc: docHash, userWords: [...req.userWords], changedItems: changed, dependentItems: dependent, mode, requirementSet };
  const records: BaseRecord[] = [rec];
  // the calibrator-1 contract needs a requirement-set version, even an empty one (v31 5.2)
  const setLine = requirementSetLine(req.mission);
  if (!ix.current.has(setLine)) {
    records.unshift({ kind: 'basis.version', basisKind: 'requirement-set', line: setLine as BasisLineId, version: safeId(`${setLine}.v1`) as BasisVersionId, mission: req.mission, scope: null, snapshot: ports.ledger.content.putList([]) });
  }
  // planning handles only the latest batch from now on: the earlier batches' open escalations close in
  // the batch's own write (nothing would carry a decision on them out; code review round 10)
  const stale: string[] = [];
  for (const o of batches) for (const e of await openEscalations(ctx, `plan:${o.body.plan}`)) stale.push(e.id);
  const close = closing(ctx, stale, `PM plan ${plan} (batch b${n}) was submitted: a decision on the earlier batch is not carried out`);
  const guard = carryGuard([close]);
  await commit(ctx, `flow:pm-batch:${req.mission}:${n}`, { events: [ev(ctx, PLAN_LINE, 'pm-batch', body.batch, body), ...close.events], records, ...(guard !== undefined ? { guard } : {}) });
  await cancelSecretarySteps(ctx, stale);
  return { batch: body.batch, plan };
}

// ---------------------------------------------------------------- reading

function pmDoc(ctx: FlowCtx, b: PmBatchBody): PmPlanDoc {
  return PmPlanDoc.parse(JSON.parse(ctx.ports.ledger.content.get(b.doc)));
}

export async function detailedPlanOf(ctx: FlowCtx, dplan: string): Promise<StoredDetailedPlan | null> {
  const o = await objectRecord(ctx, dplan);
  if (o === null) return null;
  const doc = JSON.parse(ctx.ports.ledger.content.get(o.content)) as StoredDetailedPlan;
  return { ...doc, plan: DetailedPlanDoc.parse(doc.plan) };
}

function renderPmPlan(d: PmPlanDoc): string {
  return [
    `PM plan, round ${d.round}; order: ${d.order === 'user' ? 'specified by the user' : 'free'}`,
    ...d.elements.map(
      (e) =>
        `[${e.id}] (${e.kind}) ${e.text}\n  provenance: ${e.provenance.by === 'user' ? `user said (${e.provenance.words}): "${e.provenance.quote}"` : 'PM supplement'}${e.after.length > 0 ? `\n  waits for: ${e.after.join(', ')}` : ''}${e.items.length > 0 ? `\n  items: ${e.items.join(', ')}` : ''}${e.exploration ? `\n  exploration ${e.exploration.id}: ${e.exploration.deliverable}; goal "${e.exploration.fuzzyGoal.quote}"; scope ${e.exploration.attackScope.join(', ')}; serves ${e.exploration.decision.type} decision ${e.exploration.decision.id}; budget ${e.exploration.budget.rounds} rounds` : ''}`,
    ),
    d.goalsBeyond.length > 0 ? `Goals beyond this round:\n${d.goalsBeyond.map((g) => `- ${g}`).join('\n')}` : '',
    d.authorizations.length > 0 ? `Authorizations relied on: ${d.authorizations.join(', ')}` : '',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

function renderDetailedPlan(p: DetailedPlanDoc): string {
  const prov = (x: { provenance: 'architect' | { planElement: string } }): string => (x.provenance === 'architect' ? 'architect' : `from ${x.provenance.planElement}`);
  return [
    ...p.reusedInterfaces.map((i) => `reused interface ${i.name} at ${i.file}:${i.location} (${prov(i)})`),
    ...p.newInterfaces.map((i) => `new interface ${i.name}: ${i.definition}; searched: ${i.searched} (${prov(i)})`),
    ...p.modules.map((m) => `module ${m.id}: ${m.writeScope.join(', ')} (${prov(m)})`),
    ...p.tasks.map((t) => `task ${t.id} (${t.kind}${t.module ? ` of ${t.module}` : ''}): ${t.goal}; standards: ${t.standards.map((s) => `[${s.id}] ${s.text}`).join(' ')}; writes ${t.writeScope.join(', ') || 'nothing (reads and runs only)'}; depends on ${t.dependsOn.join(', ') || 'nothing'} (${prov(t)})`),
    ...p.risks.map((r) => `risk: ${r}`),
  ].join('\n');
}

/** The user's words entries (W-<n>, 4.1 §6.1), verbatim; an entry not recorded says so. */
async function userWordsText(ctx: FlowCtx, entries: readonly string[]): Promise<string> {
  const want = new Set(entries);
  const out: string[] = [];
  for (const c of await ctx.ports.ledger.records(['user.words'])) {
    // the 4.1 record carries its entry id (memory/domain/pm.ts recordWords); the message id stands in for an older one
    const r = c.record as UserWordsRecord & { readonly words?: string };
    const id = r.words ?? r.message;
    if (!want.has(id)) continue;
    let text = r.excerpt;
    try {
      text = ctx.ports.ledger.content.get(r.text);
    } catch {
      /* the excerpt stands in */
    }
    out.push(`[${id}]\n${text}`);
  }
  for (const m of entries) if (!out.some((o) => o.startsWith(`[${m}]`))) out.push(`[${m}] (not recorded)`);
  return out.join('\n\n');
}

function renderItems(items: readonly CurrentItem[]): string {
  return items.map((i) => `[${i.line}] (${i.type}, ${i.version}${i.state === 'contested' ? ', contested' : ''}) ${i.text}${i.source.kind === 'words' ? `\n  user said (${i.source.words}): "${i.source.quote}"` : `\n  rests on authorization ${i.source.line}`}`).join('\n');
}

// ---------------------------------------------------------------- the step

export async function planningStep(ctx: FlowCtx): Promise<void> {
  // a closed mission's production is held (4.1 §6.7): no decision-layer seat is queued for it
  if (await missionClosed(ctx)) return;
  const batches = await eventsOf<PmBatchBody>(ctx, PLAN_LINE, 'pm-batch');
  const latest = batches.at(-1);
  if (latest === undefined) return;
  // a newer batch supersedes an older one's Calibrator ① that has not started (a re-check's too)
  const rechecks = await eventsOf<RecheckBody>(ctx, PLAN_LINE, CAL1_RECHECK);
  for (const b of batches.slice(0, -1)) {
    const tasks = [false, true].map((full) => cal1Task(ctx.mission, b.body.n, full));
    for (const e of await eventsOf<{ m: number }>(ctx, PLAN_LINE, 'cal1-rerun')) if (e.key.startsWith(`${b.body.plan}#`)) tasks.push(safeId(`cal1.${ctx.mission}.${b.body.n}.re${e.body.m}`));
    for (const r of rechecks) if (r.body.plan === b.body.plan) tasks.push(...await recheckTasks(ctx, r.body));
    for (const e of await eventsOf<{ root: string; task: string }>(ctx, PLAN_LINE, 'review-rebuild')) if (tasks.includes(e.body.root)) tasks.push(e.body.task);
    for (const t of tasks) {
      const s = await ctx.ports.scheduler.status(t);
      if (s?.state === 'queued') await ctx.ports.scheduler.cancel(t);
    }
  }
  const b = latest.body;
  const cal1 = await calibrator1Step(ctx, b, batches.map((x) => x.body));
  if (cal1 !== 'pass') return;
  const doc = pmDoc(ctx, b);
  if ((await eventOf(ctx, PLAN_LINE, PM_PLAN_EFFECTIVE, b.plan)) === null) {
    const body: PmPlanEffectiveBody = { plan: b.plan, batch: b.batch, round: b.round, doc: b.doc, explorations: doc.elements.flatMap((e) => (e.exploration ? [e.exploration.id] : [])) };
    // the routing escalations of explorations this plan no longer has close in its own write
    const dropped = await routingLeftBehind(ctx, doc);
    const close = closing(ctx, dropped, `PM plan ${b.plan} took effect without the exploration: the work that waited for it is planned there`);
    const guard = carryGuard([close]);
    await commit(ctx, `flow:pm-effective:${ctx.mission}:${b.plan}`, { events: [ev(ctx, PLAN_LINE, PM_PLAN_EFFECTIVE, b.plan, body), ...close.events], ...(guard !== undefined ? { guard } : {}) });
    await cancelSecretarySteps(ctx, dropped);
  }
  // a crash net for both closes (the batch write, the effective write)
  await closeLeftBehind(ctx, b, doc, batches.slice(0, -1).map((x) => x.body));
  // a re-check of the plan in effect runs beside its decomposition: the plan does not change
  await recheckStep(ctx, b, batches.map((x) => x.body));
  await decompositionStep(ctx, b, doc);
}

/** A waiting task resumes under the revision that answers its own request (or a descendant). */
export async function planAnswersReplan(ctx: FlowCtx, dplan: string, escalation: string): Promise<boolean> {
  const routed = (await eventsOf<{ escalation?: string; attempt: number; dplan?: string }>(ctx, PLAN_LINE, 'replan-routed')).filter((e) => e.body.escalation === escalation || e.key === escalation).at(-1) ?? null;
  if (routed === null) return false;
  const attempts = await eventsOf<AttemptBody>(ctx, PLAN_LINE, 'attempt');
  const routeAttempt = attempts.filter((a) => a.body.k === routed.body.attempt && a.revision < routed.revision).at(-1);
  const target = routed.body.dplan ?? (routeAttempt === undefined ? null : `dplan.${routeAttempt.key.slice('pmplan.'.length).replace('#', '.')}`);
  const parents = new Map(attempts.map((a) => [`dplan.${a.key.slice('pmplan.'.length).replace('#', '.')}`, a.body.previous]));
  const seen = new Set<string>();
  for (let at: string | null = dplan; at !== null && !seen.has(at); at = parents.get(at) ?? null) {
    if (at === target) return true;
    seen.add(at);
  }
  return false;
}

/** Per ruling 3, fast production uses only elements outside the current dispute. */
export async function contestedProduction(ctx: FlowCtx, eff: EffectiveBody, plan: DetailedPlanDoc, task: DetailedTask): Promise<boolean> {
  const batch = (await eventsOf<PmBatchBody>(ctx, PLAN_LINE, 'pm-batch')).find((b) => b.body.plan === eff.pmPlan)?.body;
  if (batch === undefined) return true;
  const doc = pmDoc(ctx, batch);
  if ((await ctx.ports.evaluator.labels([eff.pmPlan])).labels[eff.pmPlan] === 'recomputing') return true;
  const view = (await ctx.ports.evaluator.deciding([eff.pmPlan])).views[eff.pmPlan];
  if (view === null || view === undefined) return true;
  // one decision with the dispatch refresh (seat/cards/refresh.ts), from the same records
  return productionDisputed(ctx.mission, await currentItems(ctx), doc, view, (await eventsOf<Cal1Body>(ctx, PLAN_LINE, 'cal1')).map((e) => e.body), plan, task);
}

// ---------------------------------------------------------------- Calibrator ① (3.3)

async function cal1Outcome(ctx: FlowCtx, task: string): Promise<Cal1Body | null> {
  return (await eventOf<Cal1Body>(ctx, PLAN_LINE, 'cal1', task))?.body ?? null;
}

/**
 * The deciding pass of a PM plan version's calibrator-1 position, from the flow's own record: the
 * latest decided Calibrator ① on it (its batch's, a rerun's, or a re-check's before re-check
 * `beforeRecheck`), when that one passed. An undecided or failing position is no pass to extend.
 */
async function cal1PassOf(ctx: FlowCtx, plan: string): Promise<string | null> {
  const view = (await ctx.ports.evaluator.deciding([plan])).views[plan];
  const position = view?.positions.find((p) => p.review === 'calibrator-1');
  return position?.state === 'pass' ? position.by : null;
}

/** A pass counts only while the actual deciding position is current and in force. */
async function cal1PassState(ctx: FlowCtx, plan: string): Promise<'pass' | 'stale' | 'negated' | 'pending'> {
  if ((await ctx.ports.evaluator.labels([plan])).labels[plan] === 'recomputing') return 'pending';
  const view = (await ctx.ports.evaluator.deciding([plan])).views[plan];
  if (view === null || view === undefined) return 'pending';
  const position = view.positions.find((p) => p.review === 'calibrator-1');
  if (position?.state !== 'pass') return 'negated';
  const deciding = view.deciding.find((j) => j.judgment === position.by);
  return view.inEffect && deciding?.current === true ? 'pass' : 'stale';
}

async function rememberReviewInputs(ctx: FlowCtx, task: string, card: { target?: string; binding?: import('../seat/cards/common.ts').CardBinding }): Promise<void> {
  const c = ctx.ports.ledger.content;
  const checks = card.binding === undefined ? [] : c.getList(card.binding.constraints as import('../common/records.ts').ListRef);
  const inputs: PlanningInputs = {
    task, ...(card.target !== undefined ? { target: card.target } : {}),
    bases: card.binding === undefined ? [] : reviewInputVersions(c.getList(card.binding.bases as import('../common/records.ts').ListRef), c.getList(card.binding.constraints as import('../common/records.ts').ListRef)),
    constraints: boundObjectConstraints(await basisIndex(ctx), checks),
    context: planningContext(await currentItems(ctx)),
  };
  const key = `${task}#${shortHash(inputs)}`;
  await commit(ctx, `flow:review-inputs:${ctx.mission}:${key}`, { events: [ev(ctx, PLAN_LINE, 'review-inputs', key, inputs)] });
}

/** Cancel obsolete queued inputs and use the original builder for the replacement, restartably. */
async function currentReviewTask(ctx: FlowCtx, root: string): Promise<string> {
  const rebuilt = (await eventsOf<{ root: string; task: string }>(ctx, PLAN_LINE, 'review-rebuild')).filter((e) => e.body.root === root);
  const task = rebuilt.at(-1)?.body.task ?? root;
  for (const e of rebuilt) {
    const previous = (e.body as { previous?: string }).previous;
    if (previous !== undefined && (await ctx.ports.scheduler.status(previous))?.state === 'queued') await ctx.ports.scheduler.cancel(previous);
  }
  const inputs = (await eventsOf<PlanningInputs>(ctx, PLAN_LINE, 'review-inputs')).filter((e) => e.body.task === task).at(-1)?.body;
  const status = await ctx.ports.scheduler.status(task);
  if (inputs === undefined && status?.state !== 'queued') return task;
  const obj = inputs?.target === undefined ? null : await objectRecord(ctx, inputs.target);
  const changed = inputs === undefined ? ['queued inputs predate the builder snapshot'] : changedPlanningInputs(inputs, await basisIndex(ctx), await currentItems(ctx), await currentConstraints(ctx), obj ?? undefined);
  const replacement = safeId(`${root}.rf${rebuilt.length + 1}`);
  const key = `${root}#${rebuilt.length + 1}`;
  if (changed.length > 0 && status?.state === 'queued') {
    // Save the replacement before cancelling: a crash retries the cancellation below.
    await commit(ctx, `flow:review-rebuild:${ctx.mission}:${key}`, { events: [ev(ctx, PLAN_LINE, 'review-rebuild', key, { root, task: replacement, previous: task, changed })] });
    await ctx.ports.scheduler.cancel(task);
    return replacement;
  }
  return task;
}

async function cancelPlanReviews(ctx: FlowCtx, b: PmBatchBody): Promise<void> {
  const roots = [cal1Task(ctx.mission, b.n, false), cal1Task(ctx.mission, b.n, true)];
  for (const e of await eventsOf<{ m: number }>(ctx, PLAN_LINE, 'cal1-rerun')) if (e.key.startsWith(`${b.plan}#`)) roots.push(safeId(`cal1.${ctx.mission}.${b.n}.re${e.body.m}`));
  for (const e of await eventsOf<RecheckBody>(ctx, PLAN_LINE, CAL1_RECHECK)) if (e.body.plan === b.plan) roots.push(...await recheckTasks(ctx, e.body));
  for (const e of await eventsOf<{ root: string; task: string }>(ctx, PLAN_LINE, 'review-rebuild')) if (roots.includes(e.body.root)) roots.push(e.body.task);
  for (const task of roots) if ((await ctx.ports.scheduler.status(task))?.state === 'queued') await ctx.ports.scheduler.cancel(task);
}

async function returnWithdrawnPlan(ctx: FlowCtx, b: PmBatchBody, recheck: RecheckBody | null = null): Promise<boolean> {
  const obj = await objectRecord(ctx, b.plan);
  const reason = obj === null ? null : withdrawnPlanReason(obj, await basisIndex(ctx));
  if (reason === null) return false;
  await cancelPlanReviews(ctx, b);
  await tellOnce(ctx, PLAN_LINE, { category: 'calibrator-1-returned', wi: null, key: `${b.plan}:withdrawn:${recheck?.batch ?? b.batch}`, trigger: reason, defaultAction: reason, detail: { plan: b.plan, reason } });
  return true;
}

async function calibrator1Step(ctx: FlowCtx, b: PmBatchBody, batches: readonly PmBatchBody[]): Promise<'pending' | 'pass' | 'returned'> {
  if (await returnWithdrawnPlan(ctx, b)) return 'returned';
  // released once: from then on the plan's proof degrades through the evaluator's labels
  if ((await eventOf(ctx, PLAN_LINE, PM_PLAN_EFFECTIVE, b.plan)) !== null) return 'pass';
  const primary = await currentReviewTask(ctx, cal1Task(ctx.mission, b.n, false));
  const full = await currentReviewTask(ctx, cal1Task(ctx.mission, b.n, true));
  const p = await cal1Outcome(ctx, primary);
  let active = primary;
  if (p?.outcome === 'needs-full-review') active = full;
  else if (p === null) {
    const v = await taskView(ctx, primary);
    if (v.kind === 'failed' && v.why === 'full-review') active = full; // the evaluator refused the continuation (5.2 part 5)
  }
  // a pass whose judgment went stale before the release is reviewed again in full (code review r1 #12)
  const reruns = (await eventsOf<{ m: number }>(ctx, PLAN_LINE, 'cal1-rerun')).filter((e) => e.key.startsWith(`${b.plan}#`));
  const forceFull = reruns.length > 0 || active === full;
  if (reruns.length > 0) active = await currentReviewTask(ctx, safeId(`cal1.${ctx.mission}.${b.n}.re${reruns.length}`));
  const done = await cal1Outcome(ctx, active);
  if (done !== null) {
    if (done.outcome === 'needs-full-review') return 'pending';
    if (done.outcome !== 'pass' && await cal1PassState(ctx, b.plan) === 'pass') {
      for (const i of await currentItems(ctx)) if (i.state === 'contested') await setContested(ctx, i.line, false, `PM plan ${b.plan}: its deciding ruling is current and in force`);
      return 'pass';
    }
    if (done.outcome === 'pass') {
      const state = await cal1PassState(ctx, b.plan);
      if (state === 'pass') {
        for (const i of await currentItems(ctx)) if (i.state === 'contested') await setContested(ctx, i.line, false, `PM plan ${b.plan} passed Calibrator ①`);
        return 'pass';
      }
      if (state === 'pending') return 'pending';
      if (state === 'negated') {
        await returnedToPm(ctx, b, { ...done, reasons: ['The pass did not revoke the deciding negation; a valid ruling or a revised plan is required.'] });
        return 'returned';
      }
      const j = done.judgment;
      const m = reruns.length + 1;
      await commit(ctx, `flow:cal1-rerun:${ctx.mission}:${b.plan}:${m}`, { events: [ev(ctx, PLAN_LINE, 'cal1-rerun', `${b.plan}#${m}`, { m, stale: j, reason: 'the judgment is not current any more (a basis changed while Calibrator ① ran)' })] });
      return 'pending';
    }
    await returnedToPm(ctx, b, done); // idempotent: contested marks and the PM's notice survive a crash (r1 #14)
    return 'returned';
  }
  await cal1TaskStep(ctx, b, active, () => submitCalibrator1(ctx, b, batches, active, forceFull), 'the plan does not take effect; record a new batch to audit it again');
  return 'pending'; // the next pass checks the pass's currency, or returns the plan to the PM
}

/**
 * One Calibrator ① task on the plan's position (a batch's, a rerun's or a re-check's): queue it,
 * wait for it, carry out a seat failure, or record its outcome on the plan line ("cal1").
 */
async function cal1TaskStep(ctx: FlowCtx, b: PmBatchBody, active: string, submit: () => Promise<void>, givenUp: string): Promise<void> {
  const view = await taskView(ctx, active);
  if (view.kind === 'absent') return submit();
  if (view.kind === 'pending' || view.kind === 'evidence') return;
  if (view.kind === 'failed') {
    const f = await handleFailure(ctx, { task: active, lineage: planLineage(ctx.mission, b.n), subject: `plan:${b.plan}`, view, canAbandon: false, canReplan: false });
    if (f.kind === 'abandoned' || f.kind === 'decided') {
      await notify(ctx, { category: 'calibrator-1-unavailable', wi: WI.attemptFailed, key: active, trigger: `the Calibrator ① task ${active} for PM plan ${b.plan} was given up`, defaultAction: givenUp, detail: { task: active } });
    }
    return;
  }
  const r = view.result as Calibrator1Result;
  const verdict = calibrator1Verdict(r);
  if (verdict === null) {
    await commit(ctx, `flow:cal1:${ctx.mission}:${active}`, { events: [ev(ctx, PLAN_LINE, 'cal1', active, { task: active, outcome: 'needs-full-review', judgment: null, contested: [], questions: [], reasons: [] } satisfies Cal1Body)] });
    return;
  }
  const judgment = `j.${active}`;
  if (!view.status.handBack?.records.some((x) => x.kind === 'judgment' && x.judgment === judgment)) {
    await internalError(ctx, active, `the accepted Calibrator ① hand-back of ${active} has no judgment ${judgment}`);
    return;
  }
  const bad = r.elements.filter((e) => e.finding === 'ask-user' || e.finding === 'contradicts-user').map((e) => e.element);
  const errorEls = r.errors.flatMap((e) => e.elements);
  const contestedEls = [...new Set([...bad, ...errorEls])];
  const outcome: Cal1Body['outcome'] = verdict === 'pass' ? 'pass' : verdict === 'fail' ? 'fail' : 'undecided';
  const reasons = [
    ...r.elements.filter((e) => e.finding === 'ask-user' || e.finding === 'contradicts-user').map((e) => `${e.element}: ${e.finding}: ${e.reason}`),
    ...r.errors.map((e) => `${e.kind} (${e.elements.join(', ')}): ${e.detail}`),
    ...r.explorations.filter((x) => x.presetAnswer || x.jumpsAhead).map((x) => `exploration ${x.exploration}: ${x.presetAnswer ? 'presets its answer' : ''}${x.presetAnswer && x.jumpsAhead ? '; ' : ''}${x.jumpsAhead ? 'the plan goes past it before it stands' : ''}: ${x.detail}`),
  ];
  const body: Cal1Body = { task: active, outcome, judgment, contested: contestedEls, questions: r.questions, reasons };
  await commit(ctx, `flow:cal1:${ctx.mission}:${active}`, { events: [ev(ctx, PLAN_LINE, 'cal1', active, body)] });
}

/**
 * A re-check of the plan in effect (3.3, 5.2 part 5): the latest one asked for its version runs
 * (an earlier one not started yet is superseded). A pass makes the plan current again on the
 * requirement set as it is now; indirect dependents recover when their own inputs remain current; a fail or an undecided
 * outcome goes back to the PM like any batch (the plan stays in effect; its proof does not come back).
 */
async function recheckTasks(ctx: FlowCtx, r: RecheckBody): Promise<string[]> {
  const tasks = [false, true].map((full) => recheckTask(ctx.mission, r.n, r.m, full));
  for (const e of await eventsOf<{ m: number }>(ctx, PLAN_LINE, 'cal1-recheck-rerun')) {
    if (e.key.startsWith(`${r.plan}#c${r.m}#`)) tasks.push(safeId(`${recheckTask(ctx.mission, r.n, r.m, false)}.re${e.body.m}`));
  }
  for (const e of await eventsOf<{ root: string; task: string }>(ctx, PLAN_LINE, 'review-rebuild')) if (tasks.includes(e.body.root)) tasks.push(e.body.task);
  return tasks;
}

async function recheckStep(ctx: FlowCtx, b: PmBatchBody, batches: readonly PmBatchBody[]): Promise<void> {
  const all = (await eventsOf<RecheckBody>(ctx, PLAN_LINE, CAL1_RECHECK)).filter((e) => e.body.plan === b.plan).map((e) => e.body);
  const r = all.at(-1);
  if (r === undefined) return;
  for (const o of all.slice(0, -1)) {
    for (const t of await recheckTasks(ctx, o)) {
      if ((await ctx.ports.scheduler.status(t))?.state === 'queued') await ctx.ports.scheduler.cancel(t);
    }
  }
  if (await returnWithdrawnPlan(ctx, b, r)) return;
  const primaryRoot = recheckTask(ctx.mission, r.n, r.m, false);
  const primary = await currentReviewTask(ctx, primaryRoot);
  const full = await currentReviewTask(ctx, recheckTask(ctx.mission, r.n, r.m, true));
  const p = await cal1Outcome(ctx, primary);
  let active = primary;
  if (p?.outcome === 'needs-full-review') active = full;
  else if (p === null) {
    const v = await taskView(ctx, primary);
    if (v.kind === 'failed' && v.why === 'full-review') active = full; // the evaluator refused the continuation (5.2 part 5)
  }
  const reruns = (await eventsOf<{ m: number }>(ctx, PLAN_LINE, 'cal1-recheck-rerun')).filter((e) => e.key.startsWith(`${b.plan}#c${r.m}#`));
  if (reruns.length > 0) active = await currentReviewTask(ctx, safeId(`${primaryRoot}.re${reruns.length}`));
  const done = await cal1Outcome(ctx, active);
  if (done !== null) {
    if (done.outcome === 'needs-full-review') return;
    if (done.outcome !== 'pass' && await cal1PassState(ctx, b.plan) === 'pass') {
      for (const i of await currentItems(ctx)) if (i.state === 'contested') await setContested(ctx, i.line, false, `PM plan ${b.plan}: its deciding ruling is current and in force`);
      return;
    }
    if (done.outcome === 'pass') {
      const state = await cal1PassState(ctx, b.plan);
      if (state === 'pass') {
        for (const i of await currentItems(ctx)) if (i.state === 'contested') await setContested(ctx, i.line, false, `PM plan ${b.plan} passed Calibrator ① again (${r.batch})`);
      } else if (state === 'stale') {
        const m = reruns.length + 1;
        await commit(ctx, `flow:cal1-recheck-rerun:${ctx.mission}:${b.plan}:${r.m}:${m}`, { events: [ev(ctx, PLAN_LINE, 'cal1-recheck-rerun', `${b.plan}#c${r.m}#${m}`, { m, stale: done.judgment })] });
      } else if (state === 'negated') {
        await returnedToPm(ctx, b, { ...done, reasons: ['The pass did not revoke the deciding negation; a valid ruling or a revised plan is required.'] }, r);
      }
      return;
    }
    await returnedToPm(ctx, b, done, r);
    return;
  }
  await cal1TaskStep(ctx, b, active, () => submitCalibrator1(ctx, b, batches, active, (active === full || reruns.length > 0), r), `the plan in effect is not checked again; record a new batch to check it`);
}

/** 3.3: back to the PM with the reasons (a normal branch: no WI); the involved items are contested until a new version passes. */
async function returnedToPm(ctx: FlowCtx, b: PmBatchBody, done: Cal1Body, recheck: RecheckBody | null = null): Promise<void> {
  const doc = pmDoc(ctx, b);
  const contestedItems = [...new Set(doc.elements.filter((e) => done.contested.includes(e.id)).flatMap((e) => e.items.map((i) => itemLine(ctx.mission, i))))];
  for (const line of contestedItems) await setContested(ctx, line, true, `Calibrator ① on PM plan ${b.plan}`);
  const batch = recheck?.batch ?? b.batch;
  await tellOnce(ctx, PLAN_LINE, {
    category: 'calibrator-1-returned',
    wi: null,
    key: done.task,
    trigger: `Calibrator ① did not pass PM plan ${b.plan} (batch ${batch}${recheck !== null ? ', a re-check of the plan in effect' : ''}): ${done.reasons.length} finding(s)${done.questions.length > 0 ? `, ${done.questions.length} question(s) for the user` : ''}`,
    defaultAction:
      recheck !== null
        ? `the plan stays in effect without its proof (what relies on it stays not fully proven); the contested elements (${done.contested.join(', ') || 'none'}) are not used downstream until a new plan version passes or the user decides`
        : `the plan does not take effect and the Architect does not start; the contested elements (${done.contested.join(', ') || 'none'}) are not used downstream until a new plan version passes or the user decides`,
    detail: { plan: b.plan, batch, judgment: done.judgment, reasons: done.reasons, questions: done.questions, contested: done.contested },
    ...(done.questions.length > 0 ? { askUser: true } : {}),
  });
}

async function submitCalibrator1(ctx: FlowCtx, b: PmBatchBody, batches: readonly PmBatchBody[], task: string, forceFull: boolean, recheck: RecheckBody | null = null): Promise<void> {
  const doc = pmDoc(ctx, b);
  const ix = await basisIndex(ctx);
  const obj = await objectRecord(ctx, b.plan);
  if (obj === null) throw new Error(`Missing plan object ${b.plan}`);
  const constraints = objectConstraints(await currentConstraints(ctx), obj);
  const items = await currentItems(ctx);
  const contractLines = [requirementSetLine(ctx.mission), ...doc.authorizations.map((a) => itemLine(ctx.mission, a))];
  // the pass a continuation extends: the previous version's, or (a re-check) the plan's own before it
  const prevBatch = recheck !== null ? b : b.predecessor === null ? null : (batches.find((x) => x.plan === b.predecessor) ?? null);
  const j0 = forceFull || prevBatch === null ? null : await cal1PassOf(ctx, prevBatch.plan);
  const j0rec: JudgmentRecord | null = j0 === null ? null : await judgmentRecordOf(ctx, j0);
  const asked = recheck ?? b;
  const touched = new Set([...asked.changedItems, ...asked.dependentItems]);
  // focus: the changed elements and those resting on changed items (5.2 part 5)
  let focus = doc.elements.map((e) => e.id);
  let changedLines: string[] = [];
  let mode: Calibrator1Card['mode'] = { kind: 'full' };
  let oldDoc: PmPlanDoc | null = null;
  let withdrawnSince: string[] = [];
  let itemDiff = '';
  if (j0rec !== null && prevBatch !== null) {
    const j0Bases = ctx.ports.ledger.content.getList(j0rec.bases);
    const j0Lines = j0Bases.map((v) => ix.lineOf.get(v)).filter((l): l is string => l !== undefined);
    changedLines = [...new Set([...j0Lines.filter((l) => !j0Bases.includes(ix.current.get(l) ?? '')), ...contractLines.filter((l) => !j0Lines.includes(l))])];
    const diff = requirementSetChanges(ctx, ix, j0Bases);
    for (const l of diff.changed) touched.add(l);
    withdrawnSince = diff.withdrawn;
    const versions = new Map((await eventsOf<import('./requirements.ts').ItemVersionBody>(ctx, 'requirements', 'item')).map((e) => [e.body.version, e.body]));
    const versionText = (line: string, version: string): string => {
      const item = versions.get(version);
      return item === undefined ? `[${line}] (${version}; item text is not recorded)` : renderItems([{ ...item, state: 'valid' }]);
    };
    itemDiff = diff.entries.map(({ line, old, current }) => `[${line}]\nOld: ${old === undefined ? '(not present)' : versionText(line, old)}\nNew: ${current === undefined ? '(withdrawn)' : versionText(line, current)}`).join('\n\n');
    if (recheck !== null) {
      // the same document: what changed is the requirement set since the pass, item by item
      const gone = new Set(withdrawnSince);
      const f = doc.elements.filter((e) => e.items.some((i) => touched.has(itemLine(ctx.mission, i)) || gone.has(itemLine(ctx.mission, i)))).map((e) => e.id);
      // no element rests on a changed item: every element is judged against it (left out? gone against?)
      const mapped = new Set(doc.elements.flatMap((e) => e.items.map((i) => itemLine(ctx.mission, i))));
      if (f.length > 0 && [...touched, ...gone].every((l) => mapped.has(l))) focus = f;
      mode = { kind: 'continuation', extends: j0rec.judgment };
    } else {
      oldDoc = pmDoc(ctx, prevBatch);
      const oldEls = new Map(oldDoc.elements.map((e) => [e.id, canonicalJson(e)]));
      const f = doc.elements.filter((e) => oldEls.get(e.id) !== canonicalJson(e) || e.items.some((i) => touched.has(itemLine(ctx.mission, i)))).map((e) => e.id);
      if (f.length > 0) {
        const mapped = new Set(doc.elements.flatMap((e) => e.items.map((i) => itemLine(ctx.mission, i))));
        if ([...touched, ...withdrawnSince].every((l) => mapped.has(l))) focus = f;
        mode = { kind: 'continuation', extends: j0rec.judgment };
      }
    }
  }
  const j0Lines = j0rec === null ? [] : ctx.ports.ledger.content.getList(j0rec.bases).map((v) => ix.lineOf.get(v)).filter((l): l is string => l !== undefined);
  const touchedItems = mode.kind === 'full' ? items : items.filter((i) => touched.has(i.line) || doc.elements.some((e) => focus.includes(e.id) && e.items.some((x) => itemLine(ctx.mission, x) === i.line)));
  const itemWords = (xs: readonly CurrentItem[]): string[] => xs.flatMap((i) => (i.source.kind === 'words' ? [i.source.words] : []));
  const words = mode.kind === 'full' ? [...new Set([...b.userWords, ...asked.userWords, ...itemWords(items)])] : recheck !== null ? [...new Set([...asked.userWords, ...itemWords(items.filter((i) => touched.has(i.line)))])] : [...b.userWords];
  const auths = items.filter((i) => i.type === 'authorization');
  const materials = [
    material(ctx, 'words', "The user's words (verbatim)", await userWordsText(ctx, words), true, 'user-words'),
    material(ctx, 'items', mode.kind === 'full' ? 'Requirement items in force' : 'Changed and dependent requirement items', `${renderItems(touchedItems) || '(none)'}${withdrawnSince.length > 0 ? `\n\nWithdrawn since the plan last passed: ${withdrawnSince.join(', ')}` : ''}`, true, 'requirements'),
    ...(itemDiff !== '' ? [material(ctx, 'item-diff', 'Requirement changes: old and new text, including withdrawals', itemDiff, true, 'requirements')] : []),
    material(ctx, 'plan', `PM plan ${b.plan} (full text${recheck !== null ? ', unchanged: the plan in effect' : ''})`, renderPmPlan(doc), true, 'plan'),
    ...(mode.kind === 'continuation' && oldDoc !== null ? [material(ctx, 'plan-old', `PM plan ${b.predecessor} (the previous version, full text)`, renderPmPlan(oldDoc), true, 'plan')] : []),
    material(ctx, 'authorizations', 'Authorizations (verbatim)', renderItems(auths) || '(none)', true, 'authorizations'),
  ];
  const duties =
    recheck !== null
      ? `Re-check the PM plan in effect (${b.plan}, unchanged) against the requirement items as they are now (batch ${recheck.batch}): judge whether each focus element still holds against the changed items and the user's words; report every item the plan now leaves out or goes against; ask what only the user can decide.`
      : "Audit the direction of this PM plan batch against the user's words; report every finding; ask what only the user can decide.";
  const card: Calibrator1Card = {
    ...cardBase(ctx, task, { duties, constraints: constraints.list }),
    seat: 'calibrator-1',
    target: b.plan,
    review: 'calibrator-1',
    mode,
    materials,
    elements: doc.elements.map((e) => ({ id: e.id, text: e.text, provenance: e.provenance.by === 'user' ? `user said: "${e.provenance.quote}"` : 'PM supplement' })),
    focus,
    explorations: doc.elements.flatMap((e) => (e.exploration ? [e.exploration.id] : [])),
    binding: binding(ctx, {
      judgment: `j.${task}`,
      bases: currentVersions(ix, [...new Set([...contractLines, ...j0Lines])]),
      constraints: constraints.checks,
      reliesOn: [],
      extends: mode.kind === 'continuation' ? mode.extends : null,
    }),
  };
  await rememberReviewInputs(ctx, task, card);
  await ctx.ports.scheduler.submit({
    task,
    lineage: planLineage(ctx.mission, b.n),
    mission: ctx.mission,
    card,
    priority: 100,
    capabilities: card.capabilities,
    mode: 'fast',
    estimateMicros: 500_000,
    binds: [b.plan],
    ...(mode.kind === 'continuation' ? { changedLines } : {}),
  });
  ctx.progressed = true;
}

/**
 * The requirement items that changed between the requirement-set version among `bases` (a
 * judgment's) and the current one: added or revised lines, and lines no longer in force.
 */
function requirementSetChanges(ctx: FlowCtx, ix: Awaited<ReturnType<typeof basisIndex>>, bases: readonly string[]): { readonly changed: string[]; readonly withdrawn: string[]; readonly entries: Array<{ line: string; old: string | undefined; current: string | undefined }> } {
  const line = requirementSetLine(ctx.mission);
  const then = bases.find((v) => ix.lineOf.get(v) === line);
  const nowV = ix.current.get(line);
  const snapshot = (v: string | undefined): Map<string, string> => {
    const rec = v === undefined ? undefined : ix.records.get(v);
    const out = new Map<string, string>();
    if (rec?.basisKind === 'requirement-set') for (const iv of ctx.ports.ledger.content.getList(rec.snapshot)) out.set(ix.lineOf.get(iv) ?? iv, iv);
    return out;
  };
  const a = snapshot(then);
  const b = snapshot(nowV);
  return { changed: [...b].filter(([l, v]) => a.get(l) !== v).map(([l]) => l).sort(), withdrawn: [...a.keys()].filter((l) => !b.has(l)).sort(), entries: [...new Set([...a.keys(), ...b.keys()])].filter((l) => a.get(l) !== b.get(l)).sort().map((line) => ({ line, old: a.get(line), current: b.get(line) })) };
}

// ---------------------------------------------------------------- decomposition and checks (3.4–3.7)

async function attempts(ctx: FlowCtx, b: PmBatchBody): Promise<AttemptBody[]> {
  return (await eventsOf<AttemptBody>(ctx, PLAN_LINE, 'attempt')).filter((e) => e.key.startsWith(`${b.plan}#`)).map((e) => e.body);
}

async function newAttempt(ctx: FlowCtx, b: PmBatchBody, a: Omit<AttemptBody, 'k'>, k: number, with_: readonly FlowEventInput[] = [], carries: readonly Carry[] = []): Promise<void> {
  if ((await eventOf(ctx, PLAN_LINE, 'attempt', `${b.plan}#${k}`)) !== null) return; // already decided: not progress
  const body: AttemptBody = { ...a, k };
  // the attempt and what decided it (a routing, a decision carried out) are one append (code review r1 #13, round 10)
  const guard = carryGuard(carries);
  await commit(ctx, `flow:attempt:${ctx.mission}:${b.plan}:${k}`, { events: [ev(ctx, PLAN_LINE, 'attempt', `${b.plan}#${k}`, body), ...with_, ...carries.flatMap((c) => c.events)], records: carries.flatMap((c) => c.records), ...(guard !== undefined ? { guard } : {}) });
  await carried(ctx, carries);
}

/** The latest effective detailed plan of the mission (any PM plan version), or null. */
export async function latestEffective(ctx: FlowCtx): Promise<EffectiveBody | null> {
  return (await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')).at(-1)?.body ?? null;
}

/**
 * An exploration's current settle as the decision layer reads it (exploration/step.ts
 * currentSettle): the body, and the settle that first recorded the same conclusion (`route`, the
 * key the conclusion is routed and accepted under: the exploration id for the first settle, so an
 * older memory reads the same; "<id>#<n>" for a changed conclusion after a reopening).
 */
interface SettledExploration {
  readonly body: ExplorationSettledBody;
  readonly route: string;
  readonly routeN: number;
}

/**
 * Explorations of the plan, and which of them stand (3.10): currently settled with a conclusion,
 * of structure type or accepted within authority, AND its artifact proven now (code review r1 #2: a
 * settle is a record; a conclusion whose product lost its proof does not stand). An exploration a
 * rerun reopened has no current settle: unsettled until it settles again (code review r1 #3).
 * `artifacts`: the products the plan rests on, for its contracts.
 */
async function explorationState(ctx: FlowCtx, doc: PmPlanDoc): Promise<{ unsettled: Set<string>; settled: Map<string, SettledExploration>; proven: Set<string>; artifacts: string[]; recomputing: boolean }> {
  const unsettled = new Set<string>();
  const settled = new Map<string, SettledExploration>();
  const proven = new Set<string>();
  const artifacts: string[] = [];
  // a conclusion whose product label is recomputing is pending, not "not proven" (4.1 §4.1): the
  // planning step takes no decision on it and writes nothing until the labels are current
  let recomputing = false;
  for (const e of doc.elements) {
    if (!e.exploration) continue;
    const id = e.exploration.id;
    const c = await currentSettle(ctx.ports, ctx.mission, id);
    const s = c === null ? null : { body: c.body, route: c.since.key, routeN: c.since.n };
    if (s !== null) settled.set(id, s);
    const artifact = s !== null && s.body.outcome === 'conclusion' ? await settledArtifactProven(ctx.ports, ctx.mission, id) : null;
    if (artifact?.label === 'recomputing') recomputing = true;
    if (artifact?.proven === true) proven.add(id);
    const stands = artifact?.proven === true && s !== null && (s.body.decision.type === 'structure' || (await explorationAccepted(ctx, id, s.routeN)));
    if (!stands) unsettled.add(id);
    else if (artifact?.artifact) artifacts.push(artifact.artifact);
  }
  return { unsettled, settled, proven, artifacts, recomputing };
}

/**
 * The escalation about an exploration's outcome (the id encoded injectively, review r2): one per
 * conclusion routed (`n`: the settle that first recorded it; the first keeps the plain id).
 */
const exploreEscalation = (mission: string, exploration: string, n = 1): string => safeId(`explore.${mission}.${idPart(exploration)}${n > 1 ? `.s${n}` : ''}`);

/**
 * The routing escalation in force for a conclusion: the plain one, or, once that one was closed
 * without being carried out (a PM plan in effect without the exploration, a rerun that reopened it),
 * the next one, ".r1", ".r2"...: the first that is not closed.
 */
async function routingEscalation(ctx: FlowCtx, exploration: string, n: number): Promise<string> {
  const base = exploreEscalation(ctx.mission, exploration, n);
  for (let i = 0; ; i++) {
    const id = i === 0 ? base : safeId(`${base}.r${i}`);
    if ((await closedEscalation(ctx, id)) === null) return id;
  }
}

async function explorationAccepted(ctx: FlowCtx, exploration: string, n = 1): Promise<boolean> {
  const d = await decisionFor(ctx, await routingEscalation(ctx, exploration, n));
  return d !== null && d.option === 'accept';
}

/**
 * A PM plan in effect leaves the earlier batches behind (planningStep handles only the latest): their
 * open "plan:" escalations, and the routing escalations of explorations it no longer has, are closed
 * as superseded and their queued Secretary steps cancelled (nothing would carry a decision on them out).
 */
/** The open routing escalations (explore.*) of explorations the plan does not have. */
async function routingLeftBehind(ctx: FlowCtx, doc: PmPlanDoc): Promise<string[]> {
  const kept = new Set(doc.elements.flatMap((e) => (e.exploration ? [e.exploration.id] : [])));
  const out: string[] = [];
  for (const e of await eventsOf<EscalationBody>(ctx, SECRETARY_LINE, 'escalation')) {
    if (!e.key.startsWith('explore.') || !e.body.subject.startsWith('exploration:') || kept.has(e.body.subject.slice('exploration:'.length))) continue;
    if (!(await isApplied(ctx, e.key))) out.push(e.key);
  }
  return out;
}

async function closeLeftBehind(ctx: FlowCtx, b: PmBatchBody, doc: PmPlanDoc, older: readonly PmBatchBody[]): Promise<void> {
  for (const o of older) {
    await closeEscalations(ctx, `flow:superseded:${ctx.mission}:plan:${o.plan}`, `plan:${o.plan}`, `PM plan ${b.plan} took effect: a decision on the earlier batch ${o.plan} is not carried out`);
  }
  const kept = new Set(doc.elements.flatMap((e) => (e.exploration ? [e.exploration.id] : [])));
  const subjects = new Set((await eventsOf<EscalationBody>(ctx, SECRETARY_LINE, 'escalation')).filter((e) => e.key.startsWith('explore.') && e.body.subject.startsWith('exploration:')).map((e) => e.body.subject));
  for (const subject of subjects) {
    const x = subject.slice('exploration:'.length);
    if (kept.has(x)) continue;
    await closeEscalations(ctx, `flow:superseded:${ctx.mission}:${subject}`, subject, `PM plan ${b.plan} took effect without exploration ${x}: the work that waited for it is planned there`, { keep: (e) => !e.id.startsWith('explore.') });
  }
}

async function decompositionStep(ctx: FlowCtx, b: PmBatchBody, doc: PmPlanDoc): Promise<void> {
  const lineage = planLineage(ctx.mission, b.n);
  const list = await attempts(ctx, b);
  if (list.length === 0) {
    const ex0 = await explorationState(ctx, doc);
    // 4.1 §4.1: while an exploration's product label recomputes, the decisions that rest on its proof
    // (what to decompose, the routing, the Architect's card, the mechanical check) wait and write
    // nothing; the Calibrator ②, feasibility and order decisions do not rest on it and go on
    if (ex0.recomputing) return;
    const decomposable = doc.elements.some((e) => e.kind !== 'exploration' && !e.after.some((x) => ex0.unsettled.has(x)));
    if (!decomposable) {
      // 3.10: nothing to plan before the nearest exploration stands; its settling starts the Architect
      await roundsStep(ctx, b, doc, null, null);
      return;
    }
    // a new PM plan version re-plans from the latest effective detailed plan, if any. The explorations
    // that stand now are planned from in this attempt (its card carries their conclusions): they are
    // routed with it, in the same append (an accepted direction conclusion's escalation carried out),
    // so no second attempt routes them again and no accepted escalation stays open
    const prev = await latestEffective(ctx);
    const routedNow: FlowEventInput[] = [];
    const carries: Carry[] = [];
    for (const [id, c] of ex0.settled) {
      if (ex0.unsettled.has(id) || (await eventOf(ctx, PLAN_LINE, 'exploration-routed', c.route)) !== null) continue;
      routedNow.push(ev(ctx, PLAN_LINE, 'exploration-routed', c.route, { exploration: id, route: 'initial', ...(c.routeN > 1 ? { settle: c.routeN } : {}) }));
      if (c.body.decision.type !== 'structure') {
        const esc = await routingEscalation(ctx, id, c.routeN);
        if ((await escalation(ctx, esc)) !== null && !(await isApplied(ctx, esc))) carries.push(await carryOut(ctx, esc, { option: 'accept' }));
      }
    }
    const instructions = prev !== null ? [`The PM plan changed to version ${b.plan}; revise the previous detailed plan to it.${await changedElements(ctx, prev.pmPlan, doc)}`] : [];
    const replans = await replanRouting(ctx, b, 1, prev?.dplan ?? null);
    await newAttempt(ctx, b, { reason: 'initial', previous: prev?.dplan ?? null, mechanicalFailures: [], feasibilityFindings: [], instructions: [...instructions, ...replans.instructions], conclusions: [] }, 1, [...routedNow, ...replans.events], carries);
    return;
  }
  const a = list.at(-1) as AttemptBody;
  const task = await currentReviewTask(ctx, archTask(ctx.mission, b.n, a.k));
  const dplan = dplanObject(ctx.mission, b.n, a.k);
  const arch = (await eventOf<ArchBody>(ctx, PLAN_LINE, 'arch', task))?.body ?? null;
  if (arch === null) {
    const view = await taskView(ctx, task);
    if (view.kind === 'absent') return submitArchitect(ctx, b, doc, a, task, dplan);
    if (view.kind === 'pending' || view.kind === 'evidence') return;
    if (view.kind === 'failed') {
      await handleFailure(ctx, { task, lineage, subject: `plan:${b.plan}`, view, canAbandon: false, canReplan: false });
      return;
    }
    if (!view.status.handBack?.records.some((r) => r.kind === 'object.version' && r.object === dplan)) return internalError(ctx, task, `the accepted Architect hand-back of ${task} has no detailed plan version ${dplan}`);
    await commit(ctx, `flow:arch:${ctx.mission}:${task}`, { events: [ev(ctx, PLAN_LINE, 'arch', task, { task, k: a.k, object: dplan } satisfies ArchBody)] });
  }
  const stored = await detailedPlanOf(ctx, dplan);
  if (stored === null) return internalError(ctx, task, `detailed plan version ${dplan} is not in the ledger`);
  const plan = stored.plan;
  const ex = await explorationState(ctx, doc);

  // 3.5 mechanical checks
  let mc = (await eventOf<MechanicalResult>(ctx, PLAN_LINE, 'mechanical-check', dplan))?.body ?? null;
  if (mc === null) {
    // it reads which explorations are unsettled: never from a label that recomputes
    if (ex.recomputing) return;
    const snap = await ctx.ports.scheduler.snapshot({ mission: ctx.mission, purpose: 'architect' });
    mc = await mechanicalCheck({ pmPlan: doc, plan, unsettled: ex.unsettled, hasSymbol: (file, symbol) => ctx.ports.scheduler.findSymbol({ snapshot: snap.path, file, symbol }) });
    await commit(ctx, `flow:mechanical:${ctx.mission}:${dplan}`, { events: [ev(ctx, PLAN_LINE, 'mechanical-check', dplan, mc)] });
    // before its reviews, the PM learns which work the plan would restart once in effect (told once, with the check)

  }
  if (mc.ok) await restartNotice(ctx, dplan, plan);
  if (!mc.ok) {
    await planReturn(ctx, b, a, dplan, 'mechanical', { mechanicalFailures: mc.failures }, `mech:${shortHash([...mc.failures].sort())}`, 'mechanical');
    return;
  }
  if (mc.orderChanges.length > 0) {
    const id = safeId(`order.${dplan}`);
    await raiseEscalation(ctx, {
      id,
      source: 'order-change',
      lineage,
      subject: `plan:${b.plan}`,
      summary: `Detailed plan ${dplan} changes the order the user specified.`,
      changed: mc.orderChanges.join('\n'),
      reasons: [...mc.orderChanges],
      options: ['accept', 'send-back', 'ask-user'],
      facts: { dplan, orderChanges: mc.orderChanges },
    });
    const d = await decisionFor(ctx, id);
    if (d === null) return;
    await markApplied(ctx, id, { option: d.option });
    if (d.option === 'send-back') {
      await planReturn(ctx, b, a, dplan, 'secretary', { instructions: [d.instructions] }, `order:${shortHash(mc.orderChanges)}`, 'order');
      return;
    }
  }

  // 3.6 feasibility
  // the plan version's own required reviews decide (fixed with the object, 10.1); the rule is 3.6's
  const fRequired = (await objectRecord(ctx, dplan))?.reviews.some((r) => r.review === 'feasibility') ?? feasibilityRequired(plan);
  const risks: string[] = [...plan.risks];
  if (fRequired) {
    const ft = await currentReviewTask(ctx, feasTask(dplan));
    let fb = (await eventOf<FeasBody>(ctx, PLAN_LINE, 'feasibility', ft))?.body ?? null;
    if (fb === null) {
      const view = await taskView(ctx, ft);
      if (view.kind === 'absent') return submitFeasibility(ctx, b, a, dplan, plan, ft);
      if (view.kind === 'pending' || view.kind === 'evidence') return;
      if (view.kind === 'failed') {
        await handleFailure(ctx, { task: ft, lineage, subject: `plan:${b.plan}`, view, canAbandon: false, canReplan: false });
        return;
      }
      const r = view.result as ArchitectFeasibilityResult;
      if (!view.status.handBack?.records.some((x) => x.kind === 'judgment' && x.judgment === `j.${ft}`)) return internalError(ctx, ft, `the accepted feasibility hand-back of ${ft} has no judgment j.${ft}`);
      fb = {
        task: ft,
        dplan,
        verdict: r.verdict,
        judgment: `j.${ft}`,
        findings: r.findings.filter((f) => f.severity === 'blocking').map((f) => `[${f.id}] ${f.category} (${f.tasks.join(', ')}): ${f.detail} — suggestion: ${f.suggestion}`),
        risks: r.findings.filter((f) => f.severity === 'risk').map((f) => `[${f.id}] ${f.category}: ${f.detail}`),
      };
      await commit(ctx, `flow:feasibility:${ctx.mission}:${ft}`, { events: [ev(ctx, PLAN_LINE, 'feasibility', ft, fb)] });
    }
    risks.push(...fb.risks);
    if (fb.verdict === 'return') {
      // one revision by the Architect (3.6: feasibility-return, cap 1)
      const r = await countedReturn(ctx, { line: PLAN_LINE, key: `feasibility:${dplan}`, lineage, loop: 'feasibility-return', signature: shortHash(fb.findings) });
      if (r.proceed) {
        await newAttempt(ctx, b, { reason: 'feasibility', previous: dplan, mechanicalFailures: [], feasibilityFindings: fb.findings, instructions: [], conclusions: [] }, a.k + 1);
        return;
      }
      // still unresolved after the revision: the Secretary (accept the risk, send back with its grant, or the user)
      const id = safeId(`feas.${dplan}`);
      await raiseEscalation(ctx, {
        id,
        source: 'feasibility-unresolved',
        lineage,
        subject: `plan:${b.plan}`,
        summary: `The feasibility review of ${dplan} still finds blocking items after the Architect's revision.`,
        reasons: [...fb.findings],
        options: ['accept-risk', 'send-back', 'ask-user'],
        position: { target: dplan, review: 'feasibility', revokes: fb.judgment },
        facts: { dplan, findings: fb.findings },
      });
      const d = await decisionFor(ctx, id);
      if (d === null) return;
      if (d.option === 'send-back') {
        if (!(await isApplied(ctx, id))) {
          const g = await ctx.ports.scheduler.grant({ op: `grant:${ctx.mission}:${id}:${d.by}`, lineage, loop: 'feasibility-return', by: d.by === 'user' ? 'user' : 'secretary', extra: 1, reason: d.reason });
          if (!g.granted) {
            await escalateToUser(ctx, id, `sending ${dplan} back needs one more feasibility return on lineage ${lineage}, and the Secretary's grant is used (${g.why ?? 'refused'}): only the user can allow it`, WI.loopExhausted);
            return;
          }
          await ctx.ports.ledger.loopAttempt({ op: `flow:feasibility-return:${ctx.mission}:${dplan}:granted`, lineage, loop: 'feasibility-return', signature: shortHash([d.instructions]) });
          await markApplied(ctx, id, { option: 'send-back' });
        }
        await newAttempt(ctx, b, { reason: 'secretary', previous: dplan, mechanicalFailures: [], feasibilityFindings: fb.findings, instructions: [d.instructions], conclusions: [] }, a.k + 1);
        return;
      }
      // accept-risk: the ruling (a pass revoking the feasibility negation) came with the decision
      await markApplied(ctx, id, { option: 'accept-risk', risks: fb.findings });
      risks.push(...fb.findings.map((f) => `accepted: ${f}`));
    }
  }

  // 3.7 Calibrator ②
  const c2 = await calibrator2Step(ctx, b, doc, a, dplan, plan);
  if (c2 !== 'pass') return;

  // effective: the standards become basis lines, the tasks go to execution
  if ((await eventOf(ctx, PLAN_LINE, 'effective', dplan)) === null) {
    const ix = await basisIndex(ctx);
    const records: BaseRecord[] = [];
    for (const t of plan.tasks) {
      for (const s of t.standards) {
        const line = standardLine(ctx.mission, t.id, s.id);
        const version = nextBasisVersion(ix, line, shortHash(s.text));
        if (version !== null) records.push({ kind: 'basis.version', basisKind: 'standard', line: line as BasisLineId, version: version as BasisVersionId, mission: ctx.mission, scope: null });
      }
    }
    const body: EffectiveBody = { dplan, pmPlan: b.plan, n: b.n, round: b.round, mode: b.mode, tasks: plan.tasks.map((t) => t.id), risks };
    await commit(ctx, `flow:effective:${ctx.mission}:${dplan}`, { events: [ev(ctx, PLAN_LINE, 'effective', dplan, body)], records });
  }

  // 3.10: settled explorations, and re-plan requests from execution
  await roundsStep(ctx, b, doc, a, dplan);
}


/** A return to the Architect counted on the mechanical-return loop; exhausted → WI-08 and the Secretary. */
async function planReturn(
  ctx: FlowCtx,
  b: PmBatchBody,
  a: AttemptBody,
  dplan: string,
  reason: AttemptBody['reason'],
  inputs: { mechanicalFailures?: readonly string[]; instructions?: readonly string[] },
  signature: string,
  why: string,
): Promise<void> {
  const lineage = planLineage(ctx.mission, b.n);
  const next: Omit<AttemptBody, 'k'> = { reason, previous: dplan, mechanicalFailures: inputs.mechanicalFailures ?? [], feasibilityFindings: [], instructions: inputs.instructions ?? [], conclusions: [] };
  const r = await countedReturn(ctx, { line: PLAN_LINE, key: `${why}:${dplan}`, lineage, loop: 'mechanical-return', signature });
  if (r.proceed) {
    await newAttempt(ctx, b, next, a.k + 1);
    return;
  }
  const v = r.status;
  const id = safeId(`exh.${dplan}`);
  await raiseEscalation(ctx, {
    id,
    source: 'loop-exhausted',
    lineage,
    subject: `plan:${b.plan}`,
    summary: `The returns of PM plan ${b.plan}'s detailed plan to the Architect are used up (${v.attempts}/${v.allowed}${v.reason === 'no-progress' ? ', the same failures twice in a row' : ''}).`,
    reasons: [...(inputs.mechanicalFailures ?? []), ...(inputs.instructions ?? [])],
    options: ['grant', 'ask-user'],
    facts: { dplan, loop: 'mechanical-return', attempts: v.attempts, allowed: v.allowed, reason: v.reason, inputs },
  });
  await notify(ctx, {
    category: 'loop-exhausted',
    wi: WI.loopExhausted,
    key: id,
    trigger: `mechanical-return on lineage ${lineage}: ${v.reason === 'no-progress' ? 'the same failure signature twice in a row (no progress)' : `${v.attempts} of ${v.allowed} returns used`}`,
    defaultAction: `only the decomposition of PM plan ${b.plan} stops at "exhausted"; the Secretary decides (one grant, or the user); the rest of the mission continues`,
    detail: { dplan, lineage, inputs },
  });
  const d = await decisionFor(ctx, id);
  if (d === null || d.option !== 'grant') return;
  if (!(await isApplied(ctx, id))) {
    const g = await ctx.ports.scheduler.grant({ op: `grant:${ctx.mission}:${id}:${d.by}`, lineage, loop: 'mechanical-return', by: d.by === 'user' ? 'user' : 'secretary', extra: Math.max(1, d.grantExtra), reason: d.reason });
    if (!g.granted) {
      await escalateToUser(ctx, id, `the Secretary's grant on lineage ${lineage} was refused (${g.why ?? 'refused'}): only the user can grant more`, WI.loopExhausted);
      return;
    }
    await ctx.ports.ledger.loopAttempt({ op: `flow:mechanical-return:${ctx.mission}:${dplan}:granted`, lineage, loop: 'mechanical-return', signature: `${signature}:granted` });
    await markApplied(ctx, id, { option: 'grant', extra: d.grantExtra });
  }
  await newAttempt(ctx, b, { ...next, instructions: [...next.instructions, ...(d.instructions !== '' ? [d.instructions] : [])] }, a.k + 1);
}

async function calibrator2Step(ctx: FlowCtx, b: PmBatchBody, doc: PmPlanDoc, a: AttemptBody, dplan: string, plan: DetailedPlanDoc): Promise<'pending' | 'pass'> {
  const lineage = planLineage(ctx.mission, b.n);
  const primary = await currentReviewTask(ctx, cal2Task(dplan, false));
  const full = await currentReviewTask(ctx, cal2Task(dplan, true));
  let p = (await eventOf<Cal2Body>(ctx, PLAN_LINE, 'cal2', primary))?.body ?? null;
  let active = primary;
  if (p?.outcome === 'needs-full-review') active = full;
  else if (p === null) {
    const v = await taskView(ctx, primary);
    if (v.kind === 'failed' && v.why === 'full-review') active = full;
  }
  p = (await eventOf<Cal2Body>(ctx, PLAN_LINE, 'cal2', active))?.body ?? null;
  if (p === null) {
    const view = await taskView(ctx, active);
    if (view.kind === 'absent') {
      await submitCalibrator2(ctx, b, doc, a, dplan, plan, active, active === full);
      return 'pending';
    }
    if (view.kind === 'pending' || view.kind === 'evidence') return 'pending';
    if (view.kind === 'failed') {
      await handleFailure(ctx, { task: active, lineage, subject: `plan:${b.plan}`, view, canAbandon: false, canReplan: false });
      return 'pending';
    }
    const r = view.result as Calibrator2Result;
    const verdict = calibrator2Verdict(r);
    if (verdict !== null && !view.status.handBack?.records.some((x) => x.kind === 'judgment' && x.judgment === `j.${active}`)) {
      await internalError(ctx, active, `the accepted Calibrator ② hand-back of ${active} has no judgment j.${active}`);
      return 'pending';
    }
    p = { task: active, dplan, outcome: r.verdict, judgment: verdict === null ? null : `j.${active}`, escalation: r.escalation };
    await commit(ctx, `flow:cal2:${ctx.mission}:${active}`, { events: [ev(ctx, PLAN_LINE, 'cal2', active, p)] });
  }
  if (p.outcome === 'needs-full-review') return 'pending';
  if (p.outcome === 'pass') return 'pass';
  // escalate → the Secretary (3.7: never straight back to the Architect)
  const id = safeId(`cal2.${dplan}`);
  await raiseEscalation(ctx, {
    id,
    source: 'calibrator-2',
    lineage,
    subject: `plan:${b.plan}`,
    summary: `Calibrator ② escalated detailed plan ${dplan}: ${p.escalation}`,
    original: renderPmPlan(doc),
    changed: renderDetailedPlan(plan),
    reasons: [p.escalation],
    options: ['accept', 'send-back', 'ask-user'],
    position: p.judgment !== null ? { target: dplan, review: 'calibrator-2', revokes: p.judgment } : null,
    facts: { dplan, pmPlan: b.plan },
  });
  const d = await decisionFor(ctx, id);
  if (d === null) return 'pending';
  await markApplied(ctx, id, { option: d.option });
  if (d.option === 'send-back') {
    await planReturn(ctx, b, a, dplan, 'secretary', { instructions: [d.instructions] }, `cal2:${shortHash(d.instructions)}`, 'calibrator-2');
    return 'pending';
  }
  return 'pass';
}

async function roundsStep(ctx: FlowCtx, b: PmBatchBody, doc: PmPlanDoc, a: AttemptBody | null, dplan: string | null): Promise<void> {
  // the routing rests on the explorations' proof: one read, taken here (never one from before this
  // pass's writes), both waits while a product label recomputes and gives what it routes from
  const { settled, proven, recomputing } = await explorationState(ctx, doc);
  if (recomputing) return;
  const k = (a?.k ?? 0) + 1;
  const lineage = planLineage(ctx.mission, b.n);
  // explorations that settled since: route by decision type (3.10); a conclusion whose artifact is not proven is no conclusion.
  // Each conclusion is routed once, under the settle that first recorded it: a re-check that confirms it after a
  // reopening is not routed again; a changed one (another product, or no conclusion) is (code review r1 #3)
  for (const [id, c] of settled) {
    if ((await eventOf(ctx, PLAN_LINE, 'exploration-routed', c.route)) !== null) continue;
    const s0 = c.body;
    const s: ExplorationSettledBody = s0.outcome === 'conclusion' && !proven.has(id) ? { ...s0, outcome: 'no-conclusion' } : s0;
    const again = c.routeN > 1;
    const routed = (route: string): FlowEventInput => ev(ctx, PLAN_LINE, 'exploration-routed', c.route, { exploration: id, route, ...(again ? { settle: c.routeN } : {}) });
    if (s.decision.type === 'structure' && s.outcome === 'conclusion') {
      const instruction = again ? `Exploration ${id} has stood again with a changed result after an environment change reopened it: revise the plan to it.` : `Exploration ${id} has stood: plan the part that waited for it.`;
      await newAttempt(ctx, b, { reason: 'exploration', previous: dplan, mechanicalFailures: [], feasibilityFindings: [], instructions: [instruction], conclusions: [{ exploration: id, summary: s.summary }] }, k, [routed('architect')]);
      return;
    }
    const esc = await routingEscalation(ctx, id, c.routeN);
    await raiseEscalation(ctx, {
      id: esc,
      source: s.stop === 'budget' ? 'exploration-budget' : s.stop === 'repeated-fatal' || s.stop === 'no-progress' ? 'exploration-repeated-fatal' : 'exploration-direction',
      lineage,
      subject: `exploration:${id}`,
      summary: `Exploration ${id} stopped (${s.stop}, ${s.outcome})${again ? ' again after an environment change reopened it' : ''} and serves a ${s.decision.type} decision (${s.decision.id}): ${s.summary}`,
      reasons: [...s.unresolved],
      // every routing escalation offers a decision the flow carries out: accept a conclusion, or have
      // the PM re-plan the waiting part with the user when there is none (code review S1)
      options: s.outcome === 'conclusion' ? ['accept', 'ask-user'] : ['replan', 'ask-user'],
      facts: s,
    });
    const d = await decisionFor(ctx, esc);
    if (d === null) continue;
    if (d.option === 'accept') {
      await newAttempt(ctx, b, { reason: 'exploration', previous: dplan, mechanicalFailures: [], feasibilityFindings: [], instructions: [`Exploration ${id} has stood (accepted within authority): plan the part that waited for it.`], conclusions: [{ exploration: id, summary: s.summary }] }, k, [routed('accept')], [await carryOut(ctx, esc, { option: 'accept' })]);
      return;
    }
    if (d.option === 'replan') {
      // the PM re-plans the part that waited for it with the user (a notice, WI-08); the routing is done
      await notify(ctx, {
        category: 'exploration-no-conclusion',
        wi: WI.loopExhausted,
        key: `${id}:${c.route}`,
        trigger: `exploration ${id} ended without a conclusion that stands (${s.stop}): ${s.summary.slice(0, 300)}`,
        defaultAction: `re-plan the part that waited for it with the user (a new exploration id or another approach): mp pm plan submit with their words; until then the work that waited for exploration ${id} stays unplanned and the rest of the mission goes on`,
        detail: { exploration: id, settle: c.route, stop: s.stop, decision: s.decision },
      });
    }
    await commitCarrying(ctx, `flow:exploration-routed:${ctx.mission}:${c.route}`, [routed(d.option)], [await carryOut(ctx, esc, { option: d.option })]);
  }
  const replans = await replanRouting(ctx, b, k, dplanObject(ctx.mission, b.n, a?.k ?? 1));
  if (replans.events.length > 0) {
    await newAttempt(ctx, b, { reason: 'replan', previous: dplan, mechanicalFailures: [], feasibilityFindings: [], instructions: replans.instructions, conclusions: [] }, k, replans.events);
    return;
  }
  void doc;
}

/** Route unanswered requests into the next attempt, versioning every superseded route. */
async function replanRouting(ctx: FlowCtx, b: PmBatchBody, k: number, current: string | null): Promise<{ instructions: string[]; events: FlowEventInput[] }> {
  const instructions: string[] = [];
  const events: FlowEventInput[] = [];
  for (const r of await eventsOf<{ escalation: string; task: string; instructions: string }>(ctx, PLAN_LINE, 'replan-request')) {
    const routes = (await eventsOf<{ escalation?: string }>(ctx, PLAN_LINE, 'replan-routed')).filter((e) => e.key === r.key || e.body.escalation === r.key);
    if (routes.length > 0) {
      const effective = await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective');
      if ((current !== null && await planAnswersReplan(ctx, current, r.key)) || (await Promise.all(effective.map((e) => planAnswersReplan(ctx, e.body.dplan, r.key)))).some(Boolean)) continue;
    }
    const routing = routes.length + 1;
    instructions.push(`Re-plan task ${r.body.task}: ${r.body.instructions}`);
    events.push(ev(ctx, PLAN_LINE, 'replan-routed', `${r.key}#${routing}`, { escalation: r.key, routing, attempt: k, dplan: dplanObject(ctx.mission, b.n, k) }));
  }
  return { instructions, events };
}

// ---------------------------------------------------------------- cards

async function submitArchitect(ctx: FlowCtx, b: PmBatchBody, doc: PmPlanDoc, a: AttemptBody, task: string, dplan: string): Promise<void> {
  const ex = await explorationState(ctx, doc);
  // its card names the unsettled explorations and the products the plan rests on: not while they recompute
  if (ex.recomputing) return;
  const items = await currentItems(ctx);
  const planItems = new Set(doc.elements.flatMap((e) => e.items.map((i) => itemLine(ctx.mission, i))));
  const snap = await ctx.ports.scheduler.snapshot({ mission: ctx.mission, purpose: 'architect' });
  const history = await ctx.ports.scheduler.history(ctx.mission);
  const previous = a.previous === null ? null : await detailedPlanOf(ctx, a.previous);
  const conclusions = [...a.conclusions];
  for (const [id, s] of ex.settled) if (!ex.unsettled.has(id) && !conclusions.some((c) => c.exploration === id)) conclusions.push({ exploration: id, summary: s.body.summary });
  const revision = !(a.k === 1 && a.previous === null);
  const card: ArchitectDecomposeCard = {
    ...cardBase(ctx, task, {
      duties: revision
        ? 'Revise the previous detailed plan for this round: change exactly what this revision asks, and carry every other task over unchanged (the same id, every field the same), since a changed task card starts a new attempt while its records remain and it continues from its previous candidate; trace every element.'
        : 'Decompose the approved PM plan into a detailed plan for this round; trace every element; fix exactly what a revision asks.',
    }),
    seat: 'architect-decompose',
    workspace: { snapshot: snap.path, writablePaths: [] },
    pmPlan: {
      object: b.plan,
      round: doc.round,
      order: doc.order,
      elements: doc.elements.filter((e) => e.kind !== 'exploration').map((e) => ({ id: e.id, kind: e.kind, text: e.text, after: e.after.filter((x) => ex.unsettled.has(x)) })),
      goalsBeyond: [...doc.goalsBeyond],
    },
    requirementItems: items.filter((i) => planItems.has(i.line) || i.type === 'acceptance' || i.type === 'limit').map((i) => ({ id: i.line, text: i.text })),
    unsettledExplorations: [...ex.unsettled],
    explorationConclusions: conclusions,
    history: { gitLog: history.gitLog, runs: [...history.runs] },
    revision: !revision ? null : { previous: a.previous, previousPlan: previous?.plan ?? null, mechanicalFailures: [...a.mechanicalFailures], feasibilityFindings: [...a.feasibilityFindings], instructions: [...a.instructions] },
    // the previous plan in full, read page by page (a long plan would not fit in the card's body)
    ...(revision && previous !== null ? { materials: [material(ctx, PREVIOUS_PLAN_MATERIAL, `Detailed plan ${a.previous} (the plan this revision revises, in full)`, previousPlanText(a.previous, previous.plan), true, 'plan')] } : {}),
    output: {
      object: dplan,
      predecessor: a.previous,
      path: DETAILED_PLAN_PATH,
      // the plan rests on the PM plan and on the products of the explorations it plans from (code review r1 #2)
      calibrator2: { basisLines: [], reliesOn: [b.plan, ...ex.artifacts] },
      feasibility: { basisLines: [], reliesOn: [b.plan, ...ex.artifacts] },
    },
  };
  // the elements tab must not be empty (a plan with only explorations has nothing to decompose yet)
  if (card.pmPlan.elements.length === 0) return;
  await rememberReviewInputs(ctx, task, {});
  await ctx.ports.scheduler.submit({ task, lineage: planLineage(ctx.mission, b.n), mission: ctx.mission, card, priority: 100, capabilities: card.capabilities, mode: 'fast', estimateMicros: 1_000_000, binds: [dplan] });
  ctx.progressed = true;
}

async function submitFeasibility(ctx: FlowCtx, b: PmBatchBody, a: AttemptBody, dplan: string, plan: DetailedPlanDoc, task: string): Promise<void> {
  const snap = await ctx.ports.scheduler.snapshot({ mission: ctx.mission, purpose: 'feasibility' });
  const history = await ctx.ports.scheduler.history(ctx.mission);
  const ix = await basisIndex(ctx);
  const obj = await objectRecord(ctx, dplan);
  if (obj === null) throw new Error(`Missing plan object ${dplan}`);
  const constraints = objectConstraints(await currentConstraints(ctx), obj);
  const card: ArchitectFeasibilityCard = {
    ...cardBase(ctx, task, { constraints: constraints.list, duties: 'Check independently whether this detailed plan can work; report blocking findings and risks.' }),
    seat: 'architect-feasibility',
    workspace: { snapshot: snap.path, writablePaths: [] },
    target: dplan,
    review: 'feasibility',
    plan,
    history: { gitLog: history.gitLog, runs: [...history.runs] },
    earlierFindings: [...a.feasibilityFindings],
    binding: binding(ctx, { judgment: `j.${task}`, constraints: constraints.checks, bases: currentVersions(ix, []), reliesOn: await contractReliesOn(ctx, dplan, 'feasibility', b.plan) }),
  };
  await rememberReviewInputs(ctx, task, card);
  await ctx.ports.scheduler.submit({ task, lineage: planLineage(ctx.mission, b.n), mission: ctx.mission, card, priority: 100, capabilities: card.capabilities, mode: 'fast', estimateMicros: 500_000, binds: [dplan] });
  ctx.progressed = true;
}

async function submitCalibrator2(ctx: FlowCtx, b: PmBatchBody, doc: PmPlanDoc, a: AttemptBody, dplan: string, plan: DetailedPlanDoc, task: string, forceFull: boolean): Promise<void> {
  const ix = await basisIndex(ctx);
  const obj = await objectRecord(ctx, dplan);
  if (obj === null) throw new Error(`Missing plan object ${dplan}`);
  const constraints = objectConstraints(await currentConstraints(ctx), obj);
  const items = await currentItems(ctx);
  // continuation: the predecessor detailed plan's deciding calibrator-2 pass (same PM plan version only)
  let mode: Calibrator2Card['mode'] = { kind: 'full' };
  let focus: string[] = [];
  let old: StoredDetailedPlan | null = null;
  const elements = planElements(plan);
  if (!forceFull && a.previous !== null) {
    old = await detailedPlanOf(ctx, a.previous);
    const j0 = await cal2PassOf(ctx, a.previous);
    if (old !== null && j0 !== null && old.pmPlan === b.plan) {
      const before = new Map(planElements(old.plan).map((e) => [e.id, canonicalJson(e)]));
      focus = elements.filter((e) => before.get(e.id) !== canonicalJson(e)).map((e) => e.id);
      if (focus.length > 0) mode = { kind: 'continuation', extends: j0 };
    }
  }
  if (mode.kind === 'full') focus = elements.map((e) => e.id);
  const materials = [
    material(ctx, 'pm-plan', `PM plan ${b.plan} (full text)`, renderPmPlan(doc), true, 'plan'),
    material(ctx, 'plan', `Detailed plan ${dplan} (full text)`, renderDetailedPlan(plan), true, 'plan'),
    ...(mode.kind === 'continuation' && old !== null ? [material(ctx, 'plan-old', `Detailed plan ${a.previous} (the previous version)`, renderDetailedPlan(old.plan), true, 'plan')] : []),
    material(ctx, 'provenance', 'Provenance map', elements.map((e) => `${e.id} → ${e.mapsTo ?? 'architect'}`).join('\n'), true, 'record'),
    material(ctx, 'authorizations', 'Authorizations (verbatim)', renderItems(items.filter((i) => i.type === 'authorization')) || '(none)', true, 'authorizations'),
  ];
  const card: Calibrator2Card = {
    ...cardBase(ctx, task, { constraints: constraints.list, duties: "Audit the Architect's supplements and the fidelity of the provenance mapping; pass or escalate." }),
    seat: 'calibrator-2',
    target: dplan,
    review: 'calibrator-2',
    pmPlan: b.plan,
    mode,
    materials,
    elements: elements.map((e) => ({ id: e.id, text: e.text, provenance: e.mapsTo === null ? 'architect' : `plan element ${e.mapsTo}`, mapsTo: e.mapsTo })),
    focus,
    binding: binding(ctx, { judgment: `j.${task}`, constraints: constraints.checks, bases: currentVersions(ix, []), reliesOn: await contractReliesOn(ctx, dplan, 'calibrator-2', b.plan), extends: mode.kind === 'continuation' ? mode.extends : null }),
  };
  await rememberReviewInputs(ctx, task, card);
  await ctx.ports.scheduler.submit({ task, lineage: planLineage(ctx.mission, b.n), mission: ctx.mission, card, priority: 100, capabilities: card.capabilities, mode: 'fast', estimateMicros: 500_000, binds: [dplan] });
  ctx.progressed = true;
}

/**
 * The elements a new PM plan version added, changed and removed against the version of the plan
 * in effect, for the Architect's instruction (" Elements against <version>: …", or "" when that
 * version cannot be read): the revision changes the tasks these elements need, and only those.
 */
async function changedElements(ctx: FlowCtx, oldPlan: string, doc: PmPlanDoc): Promise<string> {
  const old = await pmPlanDoc(ctx, oldPlan).catch(() => null);
  if (old === null) return '';
  const before = new Map(old.elements.map((e) => [e.id, canonicalJson(e)]));
  const now = new Set(doc.elements.map((e) => e.id));
  const added = doc.elements.filter((e) => !before.has(e.id)).map((e) => e.id);
  const changed = doc.elements.filter((e) => before.has(e.id) && before.get(e.id) !== canonicalJson(e)).map((e) => e.id);
  const removed = old.elements.filter((e) => !now.has(e.id)).map((e) => e.id);
  const parts = [added.length > 0 ? `added ${added.join(', ')}` : '', changed.length > 0 ? `changed ${changed.join(', ')}` : '', removed.length > 0 ? `removed ${removed.join(', ')}` : ''].filter((x) => x !== '');
  return ` Elements against ${oldPlan}: ${parts.length > 0 ? `${parts.join('; ')}; every other element is unchanged` : 'none changed'}.`;
}

/**
 * What a detailed plan would restart once in effect (§6.2: a task whose card changes is re-specced
 * and restarts at a new attempt; a task the plan drops leaves it): the tasks of the plan in effect
 * whose card it changes or drops, with those that have accepted work or work under way (read from
 * the task lines as the execution flow keeps them). Told to the PM as a notice before the plan's
 * reviews; nothing is held.
 */
async function restartNotice(ctx: FlowCtx, dplan: string, plan: DetailedPlanDoc): Promise<void> {
  if ((await eventOf(ctx, PLAN_LINE, 'told', `plan-revision-restarts-work:${dplan}`)) !== null) return;
  const effective = await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective');
  const own = effective.findIndex((e) => e.body.dplan === dplan);
  const eff = own < 0 ? effective.at(-1)?.body : effective[own - 1]?.body;
  const cutoff = own < 0 ? Number.POSITIVE_INFINITY : effective[own]!.revision;
  if (eff === undefined) return;
  const stored = await detailedPlanOf(ctx, eff.dplan);
  if (stored === null) return;
  const next = new Map(plan.tasks.map((t) => [t.id, shortHash(DetailedTask.parse(t))]));
  const changed: string[] = [];
  const dropped: string[] = [];
  const accepted: string[] = [];
  const underWay: string[] = [];
  for (const t of stored.plan.tasks) {
    const h = next.get(t.id);
    if (h === shortHash(DetailedTask.parse(t))) continue;
    (h === undefined ? dropped : changed).push(t.id);
    const events = (await eventsOf(ctx, taskLine(t.id))).filter((e) => e.revision < cutoff);
    const specAt = events.filter((e) => e.event === 'spec').at(-1)?.revision ?? 0;
    if (events.some((e) => e.event === 'abandoned' && e.revision > specAt)) continue;
    const k = 1 + events.filter((e) => e.event === 'rework').length;
    if (events.some((e) => e.event === 'accepted' && e.key === String(k))) accepted.push(t.id);
    else if (events.some((e) => e.event === 'dispatched' && e.revision > specAt)) underWay.push(t.id);
  }
  if (accepted.length === 0 && underWay.length === 0) return;
  const kept = stored.plan.tasks.length - changed.length - dropped.length;
  await tellOnce(ctx, PLAN_LINE, {
    category: 'plan-revision-restarts-work',
    wi: null,
    key: dplan,
    trigger: `detailed plan ${dplan} changes the card of ${changed.length} and drops ${dropped.length} of the ${stored.plan.tasks.length} tasks of the plan in effect (${eff.dplan}), keeping ${kept}; accepted work it would restart or drop: ${accepted.join(', ') || 'none'}; work under way: ${underWay.join(', ') || 'none'}`,
    defaultAction: `nothing is held: the plan goes on to its reviews; once it takes effect, each task whose card changed restarts at a new attempt (its earlier records remain, it continues from its previous candidate, and work under way is cancelled) and each dropped task leaves the plan. Expected when the revision had to change those tasks; otherwise the Architect rewrote cards it should have carried over unchanged`,
    detail: { dplan, inEffect: eff.dplan, tasks: stored.plan.tasks.length, kept, changed, dropped, accepted, underWay },
  });
}

/** What a review position's contract on the plan relies on (fixed with the object, 10.1): the judgment binds at least that. */
async function contractReliesOn(ctx: FlowCtx, dplan: string, review: string, fallback: string): Promise<string[]> {
  const c = (await objectRecord(ctx, dplan))?.reviews.find((r) => r.review === review);
  return c !== undefined && c.reliesOn.length > 0 ? [...c.reliesOn] : [fallback];
}

async function cal2PassOf(ctx: FlowCtx, dplan: string): Promise<string | null> {
  for (const t of [cal2Task(dplan, true), cal2Task(dplan, false)]) {
    const o = (await eventOf<Cal2Body>(ctx, PLAN_LINE, 'cal2', t))?.body ?? null;
    if (o !== null && o.outcome === 'pass') return o.judgment;
    if (o !== null && o.outcome !== 'needs-full-review') return null;
  }
  return null;
}

/** The detailed plan as Calibrator ② elements (stable ids). */
function planElements(p: DetailedPlanDoc): Array<{ id: string; text: string; mapsTo: string | null }> {
  const mapsTo = (x: { provenance: 'architect' | { planElement: string } }): string | null => (x.provenance === 'architect' ? null : x.provenance.planElement);
  return [
    ...p.reusedInterfaces.map((i) => ({ id: `reuse:${i.name}`, text: `reuse ${i.name} at ${i.file}:${i.location}`, mapsTo: mapsTo(i) })),
    ...p.newInterfaces.map((i) => ({ id: `iface:${i.name}`, text: `new interface ${i.name}: ${i.definition}`, mapsTo: mapsTo(i) })),
    ...p.modules.map((m) => ({ id: `module:${m.id}`, text: `module ${m.id} writes ${m.writeScope.join(', ')}`, mapsTo: mapsTo(m) })),
    ...p.tasks.map((t) => ({ id: `task:${t.id}`, text: `${t.kind} task ${t.id}: ${t.goal} (standards: ${t.standards.map((s) => s.text).join('; ')})`, mapsTo: mapsTo(t) })),
  ];
}

/** A program defect inside the flow (WI-20): only this line waits; the rest goes on. */
export async function internalError(ctx: FlowCtx, key: string, what: string): Promise<void> {
  await notify(ctx, {
    category: 'flow-internal-error',
    wi: WI.internalError,
    key,
    trigger: what,
    defaultAction: 'only this line of work waits (it is checked again on every pass); the rest of the mission continues',
    detail: { key, what },
  });
}

/** Content of a PM plan version (for other flows). */
export async function pmPlanDoc(ctx: FlowCtx, plan: string): Promise<PmPlanDoc | null> {
  const o = await objectRecord(ctx, plan);
  return o === null ? null : PmPlanDoc.parse(JSON.parse(ctx.ports.ledger.content.get(o.content as ContentHash)));
}
