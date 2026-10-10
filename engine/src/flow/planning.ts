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
//                            standing → the Secretary, the PM and the user.
//   re-plan requests         from execution (a Secretary's "re-plan") → a new Architect attempt.

import type { BasisLineId, BasisVersionId, ContentHash, MissionId, ObjectVersionId } from '../common/ids.ts';
import { canonicalJson } from '../common/hash.ts';
import type { BaseRecord, JudgmentRecord, ObjectVersionRecord, UserWordsRecord } from '../common/records.ts';
import type { ArchitectDecomposeCard, ArchitectFeasibilityCard, ArchitectFeasibilityResult } from '../seat/cards/architect.ts';
import type { Calibrator1Card, Calibrator1Result, Calibrator2Card, Calibrator2Result } from '../seat/cards/calibrator.ts';
import { calibrator1Verdict, calibrator2Verdict } from '../seat/cards/calibrator.ts';
import {
  basisIndex,
  binding,
  cardBase,
  commit,
  currentVersions,
  defaultLimits,
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
  type FlowCtx,
} from './context.ts';
import { handleFailure } from './failures.ts';
import { mechanicalCheck, type MechanicalResult } from './mechanical.ts';
import {
  DetailedPlanDoc,
  EXPLORATION_SETTLED,
  PLAN_LINE,
  PM_PLAN_EFFECTIVE,
  PmPlanDoc,
  explorationLine,
  pmPlanIdProblems,
  feasibilityRequired,
  type ExplorationSettledBody,
  type PmPlanEffectiveBody,
  type StoredDetailedPlan,
} from './plandoc.ts';
import type { FlowEventInput, FlowPorts } from './ports.ts';
import { currentItems, itemLine, requirementSetLine, setContested, type CurrentItem } from './requirements.ts';
import { appliedEvent, decisionFor, escalateToUser, escalation, isApplied, markApplied, raiseEscalation } from './secretary.ts';
import { WI } from './wi.ts';
import { settledArtifactProven } from './exploration/step.ts';

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
const archTask = (mission: string, n: number, k: number): string => safeId(`arch.${mission}.${n}.${k}`);
const dplanObject = (mission: string, n: number, k: number): string => safeId(`dplan.${mission}.${n}.${k}`);
const feasTask = (dplan: string): string => safeId(`feas.${dplan}`);
const cal2Task = (dplan: string, full: boolean): string => safeId(`cal2.${dplan}${full ? '.full' : ''}`);

// ---------------------------------------------------------------- the PM's API (3.3)

/**
 * The PM records one alignment batch (3.3): the new PM plan version and what the batch touched.
 * Idempotent: the same plan and words again return the batch already recorded.
 */
export async function submitPmBatch(
  ports: FlowPorts,
  req: { readonly mission: MissionId; readonly plan: unknown; readonly userWords: readonly string[]; readonly changedItems?: readonly string[]; readonly dependentItems?: readonly string[]; readonly mode?: 'stable' | 'fast' },
): Promise<{ readonly batch: string; readonly plan: string }> {
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
  if (last !== null && last.doc === docHash && canonicalJson(last.userWords) === canonicalJson(req.userWords) && canonicalJson(last.changedItems) === canonicalJson(changed)) return { batch: last.batch, plan: last.plan };
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
  const body: PmBatchBody = { batch: `b${n}`, n, plan, predecessor: last?.plan ?? null, round: doc.round, doc: docHash, userWords: [...req.userWords], changedItems: changed, dependentItems: dependent, mode: req.mode ?? last?.mode ?? 'stable' };
  const records: BaseRecord[] = [rec];
  // the calibrator-1 contract needs a requirement-set version, even an empty one (v31 5.2)
  const ix = await basisIndex(ctx);
  const setLine = requirementSetLine(req.mission);
  if (!ix.current.has(setLine)) {
    records.unshift({ kind: 'basis.version', basisKind: 'requirement-set', line: setLine as BasisLineId, version: safeId(`${setLine}.v1`) as BasisVersionId, mission: req.mission, scope: null, snapshot: ports.ledger.content.putList([]) });
  }
  await commit(ctx, `flow:pm-batch:${req.mission}:${n}`, { events: [ev(ctx, PLAN_LINE, 'pm-batch', body.batch, body)], records });
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
        `[${e.id}] (${e.kind}) ${e.text}\n  provenance: ${e.provenance.by === 'user' ? `user said (message ${e.provenance.message}): "${e.provenance.quote}"` : 'PM supplement'}${e.after.length > 0 ? `\n  waits for: ${e.after.join(', ')}` : ''}${e.items.length > 0 ? `\n  items: ${e.items.join(', ')}` : ''}${e.exploration ? `\n  exploration ${e.exploration.id}: ${e.exploration.deliverable}; goal "${e.exploration.fuzzyGoal.quote}"; scope ${e.exploration.attackScope.join(', ')}; serves ${e.exploration.decision.type} decision ${e.exploration.decision.id}; budget ${e.exploration.budget.rounds} rounds` : ''}`,
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
    ...p.tasks.map((t) => `task ${t.id} (${t.kind}${t.module ? ` of ${t.module}` : ''}): ${t.goal}; standards: ${t.standards.map((s) => `[${s.id}] ${s.text}`).join(' ')}; writes ${t.writeScope.join(', ')}; depends on ${t.dependsOn.join(', ') || 'nothing'} (${prov(t)})`),
    ...p.risks.map((r) => `risk: ${r}`),
  ].join('\n');
}

async function userWordsText(ctx: FlowCtx, messages: readonly string[]): Promise<string> {
  const want = new Set(messages);
  const out: string[] = [];
  for (const c of await ctx.ports.ledger.records(['user.words'])) {
    const r = c.record as UserWordsRecord;
    if (!want.has(r.message)) continue;
    let text = r.excerpt;
    try {
      text = ctx.ports.ledger.content.get(r.text);
    } catch {
      /* the excerpt stands in */
    }
    out.push(`[message ${r.message}]\n${text}`);
  }
  for (const m of messages) if (!out.some((o) => o.startsWith(`[message ${m}]`))) out.push(`[message ${m}] (not booked)`);
  return out.join('\n\n');
}

function renderItems(items: readonly CurrentItem[]): string {
  return items.map((i) => `[${i.line}] (${i.type}, ${i.version}${i.state === 'contested' ? ', contested' : ''}) ${i.text}${i.source.kind === 'words' ? `\n  user said (message ${i.source.message}): "${i.source.quote}"` : `\n  rests on authorization ${i.source.line}`}`).join('\n');
}

// ---------------------------------------------------------------- the step

export async function planningStep(ctx: FlowCtx): Promise<void> {
  const batches = await eventsOf<PmBatchBody>(ctx, PLAN_LINE, 'pm-batch');
  const latest = batches.at(-1);
  if (latest === undefined) return;
  // a newer batch supersedes an older one's Calibrator ① that has not started
  for (const b of batches.slice(0, -1)) {
    for (const full of [false, true]) {
      const t = cal1Task(ctx.mission, b.body.n, full);
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
    await commit(ctx, `flow:pm-effective:${ctx.mission}:${b.plan}`, { events: [ev(ctx, PLAN_LINE, PM_PLAN_EFFECTIVE, b.plan, body)] });
  }
  await decompositionStep(ctx, b, doc);
}

// ---------------------------------------------------------------- Calibrator ① (3.3)

async function cal1Outcome(ctx: FlowCtx, task: string): Promise<Cal1Body | null> {
  return (await eventOf<Cal1Body>(ctx, PLAN_LINE, 'cal1', task))?.body ?? null;
}

/** The deciding pass of a PM plan version's calibrator-1 position, from the flow's own record. */
async function cal1PassOf(ctx: FlowCtx, batches: readonly PmBatchBody[], plan: string): Promise<string | null> {
  const b = batches.find((x) => x.plan === plan);
  if (b === undefined) return null;
  for (const full of [true, false]) {
    const o = await cal1Outcome(ctx, cal1Task(ctx.mission, b.n, full));
    if (o !== null && o.outcome === 'pass') return o.judgment;
    if (o !== null && o.outcome !== 'needs-full-review') return null;
  }
  return null;
}

async function calibrator1Step(ctx: FlowCtx, b: PmBatchBody, batches: readonly PmBatchBody[]): Promise<'pending' | 'pass' | 'returned'> {
  // released once: from then on the plan's proof degrades through the evaluator's labels
  if ((await eventOf(ctx, PLAN_LINE, PM_PLAN_EFFECTIVE, b.plan)) !== null) return 'pass';
  const primary = cal1Task(ctx.mission, b.n, false);
  const full = cal1Task(ctx.mission, b.n, true);
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
  if (reruns.length > 0) active = safeId(`cal1.${ctx.mission}.${b.n}.re${reruns.length}`);
  const done = await cal1Outcome(ctx, active);
  if (done !== null) {
    if (done.outcome === 'needs-full-review') return 'pending';
    if (done.outcome === 'pass') {
      for (const i of await currentItems(ctx)) if (i.state === 'contested') await setContested(ctx, i.line, false, `PM plan ${b.plan} passed Calibrator ①`);
      const j = done.judgment as string;
      const cur = (await ctx.ports.evaluator.judgments([j])).current[j] ?? null;
      if (cur === true) return 'pass';
      if (cur === null) return 'pending'; // the evaluator has not published the judgment yet
      const m = reruns.length + 1;
      await commit(ctx, `flow:cal1-rerun:${ctx.mission}:${b.plan}:${m}`, { events: [ev(ctx, PLAN_LINE, 'cal1-rerun', `${b.plan}#${m}`, { m, stale: j, reason: 'the judgment is not current any more (a basis changed while Calibrator ① ran)' })] });
      return 'pending';
    }
    await returnedToPm(ctx, b, done); // idempotent: contested marks and the PM's notice survive a crash (r1 #14)
    return 'returned';
  }
  const view = await taskView(ctx, active);
  if (view.kind === 'absent') {
    await submitCalibrator1(ctx, b, batches, active, forceFull);
    return 'pending';
  }
  if (view.kind === 'pending' || view.kind === 'evidence') return 'pending';
  if (view.kind === 'failed') {
    const f = await handleFailure(ctx, { task: active, lineage: planLineage(ctx.mission, b.n), subject: `plan:${b.plan}`, view, canAbandon: false, canReplan: false });
    if (f.kind === 'abandoned' || f.kind === 'decided') {
      await notify(ctx, { category: 'calibrator-1-unavailable', wi: WI.attemptFailed, key: active, trigger: `the Calibrator ① task ${active} for PM plan ${b.plan} was given up`, defaultAction: 'the plan does not take effect; record a new batch to audit it again', detail: { task: active } });
    }
    return 'pending';
  }
  const r = view.result as Calibrator1Result;
  const verdict = calibrator1Verdict(r);
  const doc = pmDoc(ctx, b);
  if (verdict === null) {
    await commit(ctx, `flow:cal1:${ctx.mission}:${active}`, { events: [ev(ctx, PLAN_LINE, 'cal1', active, { task: active, outcome: 'needs-full-review', judgment: null, contested: [], questions: [], reasons: [] } satisfies Cal1Body)] });
    return 'pending';
  }
  const judgment = `j.${active}`;
  if (!view.status.handBack?.records.some((x) => x.kind === 'judgment' && x.judgment === judgment)) {
    await internalError(ctx, active, `the accepted Calibrator ① hand-back of ${active} has no judgment ${judgment}`);
    return 'pending';
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
  void doc;
  return 'pending'; // the next pass checks the pass's currency, or returns the plan to the PM
}

/** 3.3: back to the PM with the reasons (a normal branch: no WI); the involved items are contested until a new version passes. */
async function returnedToPm(ctx: FlowCtx, b: PmBatchBody, done: Cal1Body): Promise<void> {
  const doc = pmDoc(ctx, b);
  const contestedItems = [...new Set(doc.elements.filter((e) => done.contested.includes(e.id)).flatMap((e) => e.items.map((i) => itemLine(ctx.mission, i))))];
  for (const line of contestedItems) await setContested(ctx, line, true, `Calibrator ① on PM plan ${b.plan}`);
  await tellOnce(ctx, PLAN_LINE, {
    category: 'calibrator-1-returned',
    wi: null,
    key: done.task,
    trigger: `Calibrator ① did not pass PM plan ${b.plan} (batch ${b.batch}): ${done.reasons.length} finding(s)${done.questions.length > 0 ? `, ${done.questions.length} question(s) for the user` : ''}`,
    defaultAction: `the plan does not take effect and the Architect does not start; the contested elements (${done.contested.join(', ') || 'none'}) are not used downstream until a new plan version passes or the user decides`,
    detail: { plan: b.plan, batch: b.batch, judgment: done.judgment, reasons: done.reasons, questions: done.questions, contested: done.contested },
    ...(done.questions.length > 0 ? { askUser: true } : {}),
  });
}

async function submitCalibrator1(ctx: FlowCtx, b: PmBatchBody, batches: readonly PmBatchBody[], task: string, forceFull: boolean): Promise<void> {
  const doc = pmDoc(ctx, b);
  const ix = await basisIndex(ctx);
  const items = await currentItems(ctx);
  const contractLines = [requirementSetLine(ctx.mission), ...doc.authorizations.map((a) => itemLine(ctx.mission, a))];
  const prevBatch = b.predecessor === null ? null : (batches.find((x) => x.plan === b.predecessor) ?? null);
  const j0 = forceFull || prevBatch === null ? null : await cal1PassOf(ctx, batches, prevBatch.plan);
  const j0rec: JudgmentRecord | null = j0 === null ? null : await judgmentRecordOf(ctx, j0);
  // focus: the changed elements and those resting on changed items (5.2 part 5)
  let focus = doc.elements.map((e) => e.id);
  let changedLines: string[] = [];
  let mode: Calibrator1Card['mode'] = { kind: 'full' };
  let oldDoc: PmPlanDoc | null = null;
  if (j0rec !== null && prevBatch !== null) {
    oldDoc = pmDoc(ctx, prevBatch);
    const oldEls = new Map(oldDoc.elements.map((e) => [e.id, canonicalJson(e)]));
    const touched = new Set([...b.changedItems, ...b.dependentItems]);
    const f = doc.elements.filter((e) => oldEls.get(e.id) !== canonicalJson(e) || e.items.some((i) => touched.has(itemLine(ctx.mission, i)))).map((e) => e.id);
    const j0Bases = ctx.ports.ledger.content.getList(j0rec.bases);
    const j0Lines = j0Bases.map((v) => ix.lineOf.get(v)).filter((l): l is string => l !== undefined);
    changedLines = [...new Set([...j0Lines.filter((l) => !j0Bases.includes(ix.current.get(l) ?? '')), ...contractLines.filter((l) => !j0Lines.includes(l))])];
    if (f.length > 0) {
      focus = f;
      mode = { kind: 'continuation', extends: j0rec.judgment };
    }
  }
  const j0Lines = j0rec === null ? [] : ctx.ports.ledger.content.getList(j0rec.bases).map((v) => ix.lineOf.get(v)).filter((l): l is string => l !== undefined);
  const touchedItems = mode.kind === 'full' ? items : items.filter((i) => b.changedItems.includes(i.line) || b.dependentItems.includes(i.line) || doc.elements.some((e) => focus.includes(e.id) && e.items.some((x) => itemLine(ctx.mission, x) === i.line)));
  const words = mode.kind === 'full' ? [...new Set([...b.userWords, ...items.flatMap((i) => (i.source.kind === 'words' ? [i.source.message] : []))])] : [...b.userWords];
  const auths = items.filter((i) => i.type === 'authorization');
  const materials = [
    material(ctx, 'words', "The user's words (verbatim)", await userWordsText(ctx, words), true, 'user-words'),
    material(ctx, 'items', mode.kind === 'full' ? 'Requirement items in force' : 'Changed and dependent requirement items', renderItems(touchedItems) || '(none)', true, 'requirements'),
    material(ctx, 'plan', `PM plan ${b.plan} (full text)`, renderPmPlan(doc), true, 'plan'),
    ...(mode.kind === 'continuation' && oldDoc !== null ? [material(ctx, 'plan-old', `PM plan ${b.predecessor} (the previous version, full text)`, renderPmPlan(oldDoc), true, 'plan')] : []),
    material(ctx, 'authorizations', 'Authorizations (verbatim)', renderItems(auths) || '(none)', true, 'authorizations'),
  ];
  const card: Calibrator1Card = {
    ...cardBase(ctx, task, { duties: 'Audit the direction of this PM plan batch against the user\'s words; report every finding; ask what only the user can decide.', limits: defaultLimits('materials') }),
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
      reliesOn: [],
      extends: mode.kind === 'continuation' ? mode.extends : null,
    }),
  };
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

// ---------------------------------------------------------------- decomposition and checks (3.4–3.7)

async function attempts(ctx: FlowCtx, b: PmBatchBody): Promise<AttemptBody[]> {
  return (await eventsOf<AttemptBody>(ctx, PLAN_LINE, 'attempt')).filter((e) => e.key.startsWith(`${b.plan}#`)).map((e) => e.body);
}

async function newAttempt(ctx: FlowCtx, b: PmBatchBody, a: Omit<AttemptBody, 'k'>, k: number, with_: readonly FlowEventInput[] = []): Promise<void> {
  if ((await eventOf(ctx, PLAN_LINE, 'attempt', `${b.plan}#${k}`)) !== null) return; // already decided: not progress
  const body: AttemptBody = { ...a, k };
  // the attempt and what decided it (a routing, an applied decision) are one append (code review r1 #13)
  await commit(ctx, `flow:attempt:${ctx.mission}:${b.plan}:${k}`, { events: [ev(ctx, PLAN_LINE, 'attempt', `${b.plan}#${k}`, body), ...with_] });
}

/** The latest effective detailed plan of the mission (any PM plan version), or null. */
export async function latestEffective(ctx: FlowCtx): Promise<EffectiveBody | null> {
  return (await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')).at(-1)?.body ?? null;
}

/**
 * Explorations of the plan, and which of them stand (3.10): settled with a conclusion, of
 * structure type or accepted within authority, AND its artifact proven now (code review r1 #2:
 * the "settled" event is history; a conclusion whose product lost its proof does not stand).
 * `artifacts`: the products the plan rests on, for its contracts.
 */
async function explorationState(ctx: FlowCtx, doc: PmPlanDoc): Promise<{ unsettled: Set<string>; settled: Map<string, ExplorationSettledBody>; proven: Set<string>; artifacts: string[] }> {
  const unsettled = new Set<string>();
  const settled = new Map<string, ExplorationSettledBody>();
  const proven = new Set<string>();
  const artifacts: string[] = [];
  for (const e of doc.elements) {
    if (!e.exploration) continue;
    const id = e.exploration.id;
    const s = await eventOf<ExplorationSettledBody>(ctx, explorationLine(id), EXPLORATION_SETTLED, id);
    if (s !== null) settled.set(id, s.body);
    const artifact = s !== null && s.body.outcome === 'conclusion' ? await settledArtifactProven(ctx.ports, ctx.mission, id) : null;
    if (artifact?.proven === true) proven.add(id);
    const stands = artifact?.proven === true && s !== null && (s.body.decision.type === 'structure' || (await explorationAccepted(ctx, id)));
    if (!stands) unsettled.add(id);
    else if (artifact?.artifact) artifacts.push(artifact.artifact);
  }
  return { unsettled, settled, proven, artifacts };
}

/** The escalation about an exploration's outcome (the id encoded injectively, review r2). */
const exploreEscalation = (mission: string, exploration: string): string => safeId(`explore.${mission}.${idPart(exploration)}`);

async function explorationAccepted(ctx: FlowCtx, exploration: string): Promise<boolean> {
  const id = exploreEscalation(ctx.mission, exploration);
  const d = await decisionFor(ctx, id);
  return d !== null && d.option === 'accept';
}

async function decompositionStep(ctx: FlowCtx, b: PmBatchBody, doc: PmPlanDoc): Promise<void> {
  const lineage = planLineage(ctx.mission, b.n);
  const list = await attempts(ctx, b);
  if (list.length === 0) {
    const ex0 = await explorationState(ctx, doc);
    const decomposable = doc.elements.some((e) => e.kind !== 'exploration' && !e.after.some((x) => ex0.unsettled.has(x)));
    if (!decomposable) {
      // 3.10: nothing to plan before the nearest exploration stands; its settling starts the Architect
      await roundsStep(ctx, b, doc, null, null, ex0.settled, ex0.proven);
      return;
    }
    // a new PM plan version re-plans from the latest effective detailed plan, if any
    const prev = await latestEffective(ctx);
    await newAttempt(ctx, b, { reason: 'initial', previous: prev?.dplan ?? null, mechanicalFailures: [], feasibilityFindings: [], instructions: prev !== null ? [`The PM plan changed to version ${b.plan}; revise the previous detailed plan to it.`] : [], conclusions: [] }, 1);
    return;
  }
  const a = list.at(-1) as AttemptBody;
  const task = archTask(ctx.mission, b.n, a.k);
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
    const snap = await ctx.ports.scheduler.snapshot({ mission: ctx.mission, purpose: 'architect' });
    mc = await mechanicalCheck({ pmPlan: doc, plan, unsettled: ex.unsettled, hasSymbol: (file, symbol) => ctx.ports.scheduler.findSymbol({ snapshot: snap.path, file, symbol }) });
    await commit(ctx, `flow:mechanical:${ctx.mission}:${dplan}`, { events: [ev(ctx, PLAN_LINE, 'mechanical-check', dplan, mc)] });
  }
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
    const ft = feasTask(dplan);
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
  await roundsStep(ctx, b, doc, a, dplan, ex.settled, ex.proven);
}

export const standardLine = (mission: string, task: string, standard: string): string => safeId(`std.${mission}.${idPart(task)}.${idPart(standard)}`);

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
  const primary = cal2Task(dplan, false);
  const full = cal2Task(dplan, true);
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

async function roundsStep(ctx: FlowCtx, b: PmBatchBody, doc: PmPlanDoc, a: AttemptBody | null, dplan: string | null, settled: ReadonlyMap<string, ExplorationSettledBody>, proven: ReadonlySet<string>): Promise<void> {
  const k = (a?.k ?? 0) + 1;
  const lineage = planLineage(ctx.mission, b.n);
  // explorations that settled since: route by decision type (3.10); a conclusion whose artifact is not proven is no conclusion
  for (const [id, s0] of settled) {
    if ((await eventOf(ctx, PLAN_LINE, 'exploration-routed', id)) !== null) continue;
    const s: ExplorationSettledBody = s0.outcome === 'conclusion' && !proven.has(id) ? { ...s0, outcome: 'no-conclusion' } : s0;
    const routed = (route: string): FlowEventInput => ev(ctx, PLAN_LINE, 'exploration-routed', id, { exploration: id, route });
    if (s.decision.type === 'structure' && s.outcome === 'conclusion') {
      await newAttempt(ctx, b, { reason: 'exploration', previous: dplan, mechanicalFailures: [], feasibilityFindings: [], instructions: [`Exploration ${id} has stood: plan the part that waited for it.`], conclusions: [{ exploration: id, summary: s.summary }] }, k, [routed('architect')]);
      return;
    }
    const esc = exploreEscalation(ctx.mission, id);
    await raiseEscalation(ctx, {
      id: esc,
      source: s.stop === 'budget' ? 'exploration-budget' : s.stop === 'repeated-fatal' || s.stop === 'no-progress' ? 'exploration-repeated-fatal' : 'exploration-direction',
      lineage,
      subject: `exploration:${id}`,
      summary: `Exploration ${id} stopped (${s.stop}, ${s.outcome}) and serves a ${s.decision.type} decision (${s.decision.id}): ${s.summary}`,
      reasons: [...s.unresolved],
      options: s.outcome === 'conclusion' ? ['accept', 'ask-user'] : ['ask-user'],
      facts: s,
    });
    const d = await decisionFor(ctx, esc);
    if (d === null) continue;
    if (d.option === 'accept') {
      await newAttempt(ctx, b, { reason: 'exploration', previous: dplan, mechanicalFailures: [], feasibilityFindings: [], instructions: [`Exploration ${id} has stood (accepted within authority): plan the part that waited for it.`], conclusions: [{ exploration: id, summary: s.summary }] }, k, [routed('accept'), appliedEvent(ctx, esc, { option: 'accept' })]);
      return;
    }
    await commit(ctx, `flow:exploration-routed:${ctx.mission}:${id}`, { events: [routed(d.option), appliedEvent(ctx, esc, { option: d.option })] });
  }
  // re-plan requests from execution (a Secretary's or the user's "re-plan")
  for (const r of await eventsOf<{ escalation: string; task: string; instructions: string }>(ctx, PLAN_LINE, 'replan-request')) {
    if ((await eventOf(ctx, PLAN_LINE, 'replan-routed', r.key)) !== null) continue;
    await newAttempt(ctx, b, { reason: 'replan', previous: dplan, mechanicalFailures: [], feasibilityFindings: [], instructions: [`Re-plan task ${r.body.task}: ${r.body.instructions}`], conclusions: [] }, k, [ev(ctx, PLAN_LINE, 'replan-routed', r.key, { attempt: k })]);
    return;
  }
  void doc;
}

// ---------------------------------------------------------------- cards

async function submitArchitect(ctx: FlowCtx, b: PmBatchBody, doc: PmPlanDoc, a: AttemptBody, task: string, dplan: string): Promise<void> {
  const ex = await explorationState(ctx, doc);
  const items = await currentItems(ctx);
  const planItems = new Set(doc.elements.flatMap((e) => e.items.map((i) => itemLine(ctx.mission, i))));
  const snap = await ctx.ports.scheduler.snapshot({ mission: ctx.mission, purpose: 'architect' });
  const history = await ctx.ports.scheduler.history(ctx.mission);
  const previous = a.previous === null ? null : await detailedPlanOf(ctx, a.previous);
  const conclusions = [...a.conclusions];
  for (const [id, s] of ex.settled) if (!ex.unsettled.has(id) && !conclusions.some((c) => c.exploration === id)) conclusions.push({ exploration: id, summary: s.summary });
  const card: ArchitectDecomposeCard = {
    ...cardBase(ctx, task, { duties: 'Decompose the approved PM plan into a detailed plan for this round; trace every element; fix exactly what a revision asks.', limits: defaultLimits('read') }),
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
    revision:
      a.k === 1 && a.previous === null
        ? null
        : { previous: a.previous, previousPlan: previous?.plan ?? null, mechanicalFailures: [...a.mechanicalFailures], feasibilityFindings: [...a.feasibilityFindings], instructions: [...a.instructions] },
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
  await ctx.ports.scheduler.submit({ task, lineage: planLineage(ctx.mission, b.n), mission: ctx.mission, card, priority: 100, capabilities: card.capabilities, mode: 'fast', estimateMicros: 1_000_000, binds: [dplan] });
  ctx.progressed = true;
}

async function submitFeasibility(ctx: FlowCtx, b: PmBatchBody, a: AttemptBody, dplan: string, plan: DetailedPlanDoc, task: string): Promise<void> {
  const snap = await ctx.ports.scheduler.snapshot({ mission: ctx.mission, purpose: 'feasibility' });
  const history = await ctx.ports.scheduler.history(ctx.mission);
  const ix = await basisIndex(ctx);
  const card: ArchitectFeasibilityCard = {
    ...cardBase(ctx, task, { duties: 'Check independently whether this detailed plan can work; report blocking findings and risks.', limits: defaultLimits('read') }),
    seat: 'architect-feasibility',
    workspace: { snapshot: snap.path, writablePaths: [] },
    target: dplan,
    review: 'feasibility',
    plan,
    history: { gitLog: history.gitLog, runs: [...history.runs] },
    earlierFindings: [...a.feasibilityFindings],
    binding: binding(ctx, { judgment: `j.${task}`, bases: currentVersions(ix, []), reliesOn: await contractReliesOn(ctx, dplan, 'feasibility', b.plan) }),
  };
  await ctx.ports.scheduler.submit({ task, lineage: planLineage(ctx.mission, b.n), mission: ctx.mission, card, priority: 100, capabilities: card.capabilities, mode: 'fast', estimateMicros: 500_000, binds: [dplan] });
  ctx.progressed = true;
}

async function submitCalibrator2(ctx: FlowCtx, b: PmBatchBody, doc: PmPlanDoc, a: AttemptBody, dplan: string, plan: DetailedPlanDoc, task: string, forceFull: boolean): Promise<void> {
  const ix = await basisIndex(ctx);
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
    ...cardBase(ctx, task, { duties: "Audit the Architect's supplements and the fidelity of the provenance mapping; pass or escalate.", limits: defaultLimits('materials') }),
    seat: 'calibrator-2',
    target: dplan,
    review: 'calibrator-2',
    pmPlan: b.plan,
    mode,
    materials,
    elements: elements.map((e) => ({ id: e.id, text: e.text, provenance: e.mapsTo === null ? 'architect' : `plan element ${e.mapsTo}`, mapsTo: e.mapsTo })),
    focus,
    binding: binding(ctx, { judgment: `j.${task}`, bases: currentVersions(ix, []), reliesOn: await contractReliesOn(ctx, dplan, 'calibrator-2', b.plan), extends: mode.kind === 'continuation' ? mode.extends : null }),
  };
  await ctx.ports.scheduler.submit({ task, lineage: planLineage(ctx.mission, b.n), mission: ctx.mission, card, priority: 100, capabilities: card.capabilities, mode: 'fast', estimateMicros: 500_000, binds: [dplan] });
  ctx.progressed = true;
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
