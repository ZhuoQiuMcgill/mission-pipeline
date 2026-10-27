// Repairs (4.1.2, D-9, D-10): the user tried the product and found a problem; the PM records it as a
// repair item (`mp pm repair`) with the user's reason verbatim from a words entry and the kind the PM
// chose. The repair does not re-run the decision layer: no Calibrator ①, no feasibility review, no
// Calibrator ②, no new detailed-plan version.
//
//   about an exploration   the exploration is reopened for one more round with the repair as an added
//                          question (exploration/flow.ts recordExplorationRerun); its settled
//                          conclusion stays in the record as history; a new settle is routed again
//   otherwise              an Architect repair step (card "architect-repair") on the plan in effect:
//                          its hand-back reopens tasks with accepted products and/or adds tasks. Only
//                          the mechanical checks apply (mechanical.ts, the plan in effect plus the
//                          added tasks); a failure returns the step to the Architect (mechanical-return
//                          loop; used up: WI-08 and the Secretary). On a pass, one write records the
//                          decision ("decided") and, when it adds tasks, the amendment of the plan in
//                          effect: a new "effective" event of the same detailed plan whose body lists
//                          the added tasks (plandoc.ts amendedPlan). Existing tasks keep their cards,
//                          their products keep their bindings (no re-bind, no Reviewer). The reopened
//                          tasks get their new attempts from execution (carryReopens), as an
//                          integration review's reopen does.
// Every card of the work a repair caused shows it (common card field `repairs`); `repairsOf` is the
// one resolver of a mission's repairs (the reads and the close snapshot use it).

import { canonicalJson } from '../common/hash.ts';
import type { BasisLineId, BasisVersionId, MissionId } from '../common/ids.ts';
import type { BaseRecord } from '../common/records.ts';
import { previousPlanText, type ArchitectRepairCard, type ArchitectRepairResult } from '../seat/cards/architect.ts';
import { planningConstraints } from '../seat/cards/dynamic.ts';
import { basisIndex, cardBase, commit, countedReturn, ev, eventOf, eventsOf, flowCtx, idPart, material, missionClosed, nextBasisVersion, notify, safeId, shortHash, taskView, tellOnce, type FlowCtx } from './context.ts';
import { handleFailure } from './failures.ts';
import { mechanicalCheck, type MechanicalResult } from './mechanical.ts';
import { PLAN_LINE, REPAIRS_LINE, REPAIR_KINDS, amendedTaskIds, explorationLine, repairRef, taskLine, type AmendmentEntry, type DetailedPlanDoc, type DetailedTask, type RepairBody, type RepairDecidedBody, type RepairKind, type RepairRef } from './plandoc.ts';
import { explorationState, planInEffect, pmPlanDoc, projectCommandsOf, standardLine, type EffectiveBody } from './planning.ts';
import { acceptedProduct, lineAcceptance, pathOwners } from './execution.ts';
import type { FlowPorts } from './ports.ts';
import { currentConstraints } from './requirements.ts';
import { decisionFor, escalateToUser, isApplied, markApplied, raiseEscalation } from './secretary.ts';
import { recordExplorationRerun } from './exploration/flow.ts';
import { ATTEMPTS_AMENDED, type AttemptsAmendedBody } from './exploration/machine.ts';
import { WI } from './wi.ts';

/** One Architect repair attempt (line "repairs", event "attempt", key "<repair>#<k>"). */
interface RepairAttemptBody {
  readonly k: number;
  /** The plan in effect it amends. */
  readonly dplan: string;
  readonly reason: 'initial' | 'mechanical' | 'plan-changed' | 'granted';
  readonly mechanicalFailures: readonly string[];
}

export const repairLineage = (mission: string, repair: string): string => safeId(`repair.${mission}.${idPart(repair)}`);
const archRepairTask = (mission: string, repair: string, k: number): string => safeId(`arch-repair.${mission}.${idPart(repair)}.${k}`);

/** A mission's repairs with where each stands (the one resolver: reads, cards and the close snapshot use it). */
export interface RepairState extends RepairBody {
  /**
   * exploration: reopened for one more round; answered: about an exploration, and answered by the
   * user's amendment of its method instead of a round (`mp pm amend-attempts --answers`); architect:
   * its Architect step is under way; decided: amended and/or reopened; waiting: nothing to amend yet.
   */
  readonly state: 'exploration' | 'answered' | 'architect' | 'decided' | 'waiting';
  readonly added: readonly string[];
  readonly reopened: readonly string[];
  /** The plan it amended (decided), or works on. */
  readonly dplan: string | null;
  /** answered: the amendment that answered it (its number on the exploration, and the user's words it rests on). */
  readonly answeredBy?: { readonly exploration: string; readonly amendment: number; readonly words: string };
}

export async function repairsOf(ctx: FlowCtx, mission: string = ctx.mission): Promise<RepairState[]> {
  const c = mission === ctx.mission ? ctx : flowCtx(ctx.ports, mission as MissionId);
  const decided = new Map((await eventsOf<RepairDecidedBody>(c, REPAIRS_LINE, 'decided')).map((e) => [e.key, e.body]));
  const attempts = await eventsOf<RepairAttemptBody>(c, REPAIRS_LINE, 'attempt');
  const out: RepairState[] = [];
  for (const e of await eventsOf<RepairBody>(c, REPAIRS_LINE, 'repair')) {
    const r = e.body;
    const d = decided.get(r.id);
    const a = attempts.filter((x) => x.key.startsWith(`${r.id}#`)).at(-1)?.body;
    // about an exploration: answered by the user's amendment of its method, or one more round
    const amended = r.about?.kind === 'exploration' ? (await eventsOf<AttemptsAmendedBody>(c, explorationLine(r.about.id), ATTEMPTS_AMENDED)).find((x) => x.body.answers === r.id)?.body : undefined;
    const state: RepairState['state'] = r.about?.kind === 'exploration' ? (amended !== undefined ? 'answered' : 'exploration') : d !== undefined ? 'decided' : a !== undefined ? 'architect' : 'waiting';
    out.push({
      ...r,
      state,
      added: d?.add ?? [],
      reopened: d?.reopen.map((x) => x.task) ?? [],
      dplan: d?.dplan ?? a?.dplan ?? null,
      ...(amended !== undefined && r.about !== null ? { answeredBy: { exploration: r.about.id, amendment: amended.n, words: amended.words } } : {}),
    });
  }
  return out;
}

/** The repairs as cards show them, by id. */
export async function repairRefs(ctx: FlowCtx, ids: Iterable<string>): Promise<RepairRef[]> {
  const want = new Set(ids);
  return (await eventsOf<RepairBody>(ctx, REPAIRS_LINE, 'repair')).filter((e) => want.has(e.key)).map((e) => repairRef(e.body));
}

// ---------------------------------------------------------------- recording (`mp pm repair`)

/**
 * Record a repair item. The caller checked that `text` occurs verbatim in the words entry (the
 * requirement items' check). The same repair again (same words, kind, text and subject) returns the
 * one recorded, while it is undecided or its amendment is part of the plan in effect.
 */
export async function recordRepair(
  ports: FlowPorts,
  req: { readonly mission: MissionId; readonly words: string; readonly kind: RepairKind; readonly text: string; readonly about: { readonly kind: 'task' | 'exploration'; readonly id: string } | null },
): Promise<{ readonly id: string; readonly repeated: boolean }> {
  const ctx = flowCtx(ports, req.mission);
  if (!(REPAIR_KINDS as readonly string[]).includes(req.kind)) throw new Error(`a repair's kind is one of ${REPAIR_KINDS.join(', ')}`);
  if (req.text.trim() === '') throw new Error('a repair records the user\'s reason');
  if (await missionClosed(ctx)) throw new Error(`mission ${req.mission} is closed: a repair is recorded before the mission is closed`);
  const existing = await eventsOf<RepairBody>(ctx, REPAIRS_LINE, 'repair');
  const pie = await planInEffect(ctx);
  for (const e of existing) {
    const r = e.body;
    if (r.words !== req.words || r.kind !== req.kind || r.text !== req.text || canonicalJson(r.about) !== canonicalJson(req.about)) continue;
    const d = (await eventOf<RepairDecidedBody>(ctx, REPAIRS_LINE, 'decided', r.id))?.body;
    // the same repair stands while undecided, or while what it added is in the plan in effect
    if (d === undefined || pie === null || d.add.every((t) => pie.plan.tasks.some((x) => x.id === t))) return { id: r.id, repeated: true };
  }
  const id = `R-${existing.length + 1}`;
  const body: RepairBody = { id, words: req.words, kind: req.kind, text: req.text, about: req.about };
  const event = ev(ctx, REPAIRS_LINE, 'repair', id, body);
  if (req.about?.kind === 'exploration') {
    const x = req.about.id;
    if ((await eventsOf(ctx, `exploration:${x}`, 'defined')).length === 0) throw new Error(`mission ${req.mission} has no exploration ${x}`);
    // one more round with the repair as an added question; the settled conclusion stays as history (one write)
    await recordExplorationRerun(ports, req.mission, x, { evidence: [], environment: `repair:${id}`, repair: repairRef(body) }, { events: [event] });
    return { id, repeated: false };
  }
  if (pie === null) throw new Error(`mission ${req.mission} has no detailed plan in effect: a repair amends the plan in effect (plan the work with mp pm plan submit first)`);
  if (req.about?.kind === 'task' && !pie.plan.tasks.some((t) => t.id === req.about!.id)) throw new Error(`task ${req.about.id} is not a task of the plan in effect (${pie.eff.dplan})`);
  await commit(ctx, `flow:repair:${req.mission}:${id}`, { events: [event] });
  return { id, repeated: false };
}

// ---------------------------------------------------------------- the repair step

/** The flow step: every repair not about an exploration goes through its Architect step and the mechanical checks. */
export async function repairStep(ctx: FlowCtx): Promise<void> {
  // a closed mission's production is held (4.1 §6.7)
  if (await missionClosed(ctx)) return;
  const repairs = await eventsOf<RepairBody>(ctx, REPAIRS_LINE, 'repair');
  if (repairs.length === 0) return;
  for (const e of repairs) {
    if (e.body.about?.kind === 'exploration') continue;
    if ((await eventOf(ctx, REPAIRS_LINE, 'decided', e.key)) !== null) continue;
    await oneRepair(ctx, e.body);
  }
}

async function attemptsOf(ctx: FlowCtx, repair: string): Promise<RepairAttemptBody[]> {
  return (await eventsOf<RepairAttemptBody>(ctx, REPAIRS_LINE, 'attempt')).filter((e) => e.key.startsWith(`${repair}#`)).map((e) => e.body);
}

async function newAttempt(ctx: FlowCtx, repair: string, a: RepairAttemptBody): Promise<void> {
  await commit(ctx, `flow:repair-attempt:${ctx.mission}:${repair}:${a.k}`, { events: [ev(ctx, REPAIRS_LINE, 'attempt', `${repair}#${a.k}`, a)] });
}

async function oneRepair(ctx: FlowCtx, r: RepairBody): Promise<void> {
  const pie = await planInEffect(ctx);
  if (pie === null) return;
  const { eff, plan } = pie;
  const list = await attemptsOf(ctx, r.id);
  if (list.length === 0) return newAttempt(ctx, r.id, { k: 1, dplan: eff.dplan, reason: 'initial', mechanicalFailures: [] });
  const a = list.at(-1)!;
  const task = archRepairTask(ctx.mission, r.id, a.k);
  // a new plan took effect since the step started: the repair amends that one (not counted)
  if (a.dplan !== eff.dplan) {
    if ((await ctx.ports.scheduler.status(task))?.state === 'queued') await ctx.ports.scheduler.cancel(task);
    return newAttempt(ctx, r.id, { k: a.k + 1, dplan: eff.dplan, reason: 'plan-changed', mechanicalFailures: [] });
  }
  const lineage = repairLineage(ctx.mission, r.id);
  const view = await taskView(ctx, task);
  if (view.kind === 'absent') return submitArchitectRepair(ctx, r, a, task, eff, plan);
  if (view.kind === 'pending' || view.kind === 'evidence') return;
  if (view.kind === 'failed') {
    await handleFailure(ctx, { task, lineage, subject: `repair:${r.id}`, view, canAbandon: false, canReplan: false });
    return;
  }
  const result = view.result as ArchitectRepairResult;
  const added = result.add;
  // the mechanical checks only (D-10): the plan in effect plus the added tasks
  let mc = (await eventOf<MechanicalResult>(ctx, REPAIRS_LINE, 'mechanical-check', task))?.body ?? null;
  if (mc === null) {
    const doc = await pmPlanDoc(ctx, eff.pmPlan);
    if (doc === null) return;
    const ex = await explorationState(ctx, doc);
    if (ex.recomputing) return;
    const snap = await ctx.ports.scheduler.snapshot({ mission: ctx.mission, purpose: 'architect' });
    mc = await mechanicalCheck({
      pmPlan: doc,
      plan: { ...plan, tasks: [...plan.tasks, ...added] },
      unsettled: ex.unsettled,
      hasSymbol: (file, symbol) => ctx.ports.scheduler.findSymbol({ snapshot: snap.path, file, symbol }),
      fullSuite: ctx.ports.project?.fullSuite ?? [],
      amendment: { added: new Set(added.map((t) => t.id)) },
      // the tasks earlier repairs added stay outside the integration rule (S3)
      amended: amendedTaskIds((await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')).map((e) => e.body)),
    });
    await commit(ctx, `flow:repair-mechanical:${ctx.mission}:${task}`, { events: [ev(ctx, REPAIRS_LINE, 'mechanical-check', task, mc)] });
  }
  if (!mc.ok) return repairReturn(ctx, r, a, task, mc.failures);
  await decide(ctx, r, task, eff, plan, result, mc);
}

/** A mechanical failure returns the step to the Architect (mechanical-return loop); used up: WI-08 and the Secretary. */
async function repairReturn(ctx: FlowCtx, r: RepairBody, a: RepairAttemptBody, task: string, failures: readonly string[]): Promise<void> {
  const lineage = repairLineage(ctx.mission, r.id);
  const signature = shortHash([...failures].sort());
  const next: RepairAttemptBody = { k: a.k + 1, dplan: a.dplan, reason: 'mechanical', mechanicalFailures: [...failures] };
  const c = await countedReturn(ctx, { line: REPAIRS_LINE, key: `mechanical:${task}`, lineage, loop: 'mechanical-return', signature });
  if (c.proceed) return newAttempt(ctx, r.id, next);
  const id = safeId(`exh.${task}`);
  const v = c.status;
  await raiseEscalation(ctx, {
    id,
    source: 'loop-exhausted',
    lineage,
    subject: `repair:${r.id}`,
    summary: `The returns of repair ${r.id}'s amendment to the Architect are used up (${v.attempts}/${v.allowed}${v.reason === 'no-progress' ? ', the same failures twice in a row' : ''}).`,
    reasons: [...failures],
    options: ['grant', 'ask-user'],
    facts: { repair: r.id, task, loop: 'mechanical-return', attempts: v.attempts, allowed: v.allowed, reason: v.reason, failures },
    handover: { from: task, objects: [] },
  });
  await notify(ctx, {
    category: 'loop-exhausted',
    wi: WI.loopExhausted,
    key: id,
    trigger: `mechanical-return on lineage ${lineage}: ${v.reason === 'no-progress' ? 'the same failure signature twice in a row (no progress)' : `${v.attempts} of ${v.allowed} returns used`}`,
    defaultAction: `only repair ${r.id} stops at "exhausted"; the Secretary decides (one grant, or the user); the rest of the mission continues`,
    detail: { repair: r.id, lineage, failures },
  });
  const d = await decisionFor(ctx, id);
  if (d === null || d.option !== 'grant') return;
  if (!(await isApplied(ctx, id))) {
    const g = await ctx.ports.scheduler.grant({ op: `grant:${ctx.mission}:${id}:${d.by}`, lineage, loop: 'mechanical-return', by: d.by === 'user' ? 'user' : 'secretary', extra: Math.max(1, d.grantExtra), reason: d.reason });
    if (!g.granted) {
      await escalateToUser(ctx, id, `the Secretary's grant on lineage ${lineage} was refused (${g.why ?? 'refused'}): only the user can grant more`, WI.loopExhausted);
      return;
    }
    await ctx.ports.ledger.loopAttempt({ op: `flow:repair-return:${ctx.mission}:${task}:granted`, lineage, loop: 'mechanical-return', signature: `${signature}:granted` });
    await markApplied(ctx, id, { option: 'grant', extra: d.grantExtra });
  }
  await newAttempt(ctx, r.id, { ...next, reason: 'granted', mechanicalFailures: [...failures, ...(d.instructions !== '' ? [d.instructions] : [])] });
}

/**
 * The repair decided (one write): the decision record, and, when it adds tasks, the amendment of the
 * plan in effect (a new "effective" event of the same detailed plan) with the added tasks' standards
 * as basis lines. Reopened tasks get their new attempts from execution (carryReopens). Each reopened
 * task is taken at the attempt it is accepted at now; one no longer accepted is left out, said.
 */
async function decide(ctx: FlowCtx, r: RepairBody, task: string, eff: EffectiveBody, plan: DetailedPlanDoc, result: ArchitectRepairResult, mc: MechanicalResult): Promise<void> {
  const reopen: Array<RepairDecidedBody['reopen'][number]> = [];
  const skipped: string[] = [];
  for (const x of result.reopen) {
    const events = (await eventsOf(ctx, taskLine(x.task))).map((e) => ({ revision: e.revision, event: e.event, key: e.key, body: e.body }));
    const sel = lineAcceptance(events);
    if (sel.product === null || (await acceptedProduct(ctx, x.task)) === null) skipped.push(x.task);
    else reopen.push({ task: x.task, issue: x.issue, attempt: sel.k, product: sel.product });
  }
  const added: readonly DetailedTask[] = result.add;
  const body: RepairDecidedBody = { repair: r.id, dplan: eff.dplan, arch: task, add: added.map((t) => t.id), reopen };
  const events = [ev(ctx, REPAIRS_LINE, 'decided', r.id, body)];
  const records: BaseRecord[] = [];
  if (added.length > 0) {
    const entry: AmendmentEntry = { repair: r.id, tasks: added, reopen: reopen.map((x) => ({ task: x.task, issue: x.issue })), arch: task };
    const n = (eff.amendments ?? []).length + 1;
    const amended: EffectiveBody = { ...eff, tasks: [...eff.tasks, ...added.map((t) => t.id)], amendments: [...(eff.amendments ?? []), entry] };
    events.push(ev(ctx, PLAN_LINE, 'effective', `${eff.dplan}#a${n}`, amended));
    // the added tasks' standards become basis lines, as a plan's do when it takes effect
    const ix = await basisIndex(ctx);
    for (const t of added) {
      for (const s of t.standards) {
        const line = standardLine(ctx.mission, t.id, s.id);
        const version = nextBasisVersion(ix, line, shortHash(s.text));
        if (version !== null) records.push({ kind: 'basis.version', basisKind: 'standard', line: line as BasisLineId, version: version as BasisVersionId, mission: ctx.mission, scope: null });
      }
    }
  }
  await commit(ctx, `flow:repair-decided:${ctx.mission}:${r.id}`, { events, records });
  await tellOnce(ctx, REPAIRS_LINE, {
    category: 'repair-decided',
    wi: null,
    key: r.id,
    trigger: `repair ${r.id} (${r.kind}) passed the mechanical checks: ${added.length > 0 ? `adds ${added.map((t) => t.id).join(', ')} to the plan in effect (${eff.dplan})` : 'adds no task'}; ${reopen.length > 0 ? `reopens ${reopen.map((x) => x.task).join(', ')}` : 'reopens no task'}${skipped.length > 0 ? `; ${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} not accepted any more and ${skipped.length === 1 ? 'was' : 'were'} left out` : ''}${mc.orderChanges.length > 0 ? `; order changes against the user's order: ${mc.orderChanges.join('; ')}` : ''}`,
    defaultAction: 'the work goes on: the added tasks run like any task of the plan, each reopened task gets a new attempt with the repair on its card; nothing else is re-reviewed (D-10)',
    detail: { repair: r.id, dplan: eff.dplan, added: added.map((t) => t.id), reopen, skipped, orderChanges: mc.orderChanges },
  });
}

async function submitArchitectRepair(ctx: FlowCtx, r: RepairBody, a: RepairAttemptBody, task: string, eff: EffectiveBody, plan: DetailedPlanDoc): Promise<void> {
  const doc = await pmPlanDoc(ctx, eff.pmPlan);
  if (doc === null) return;
  const snap = await ctx.ports.scheduler.snapshot({ mission: ctx.mission, purpose: 'architect' });
  const history = await ctx.ports.scheduler.history(ctx.mission);
  const accepted: ArchitectRepairCard['accepted'] = [];
  for (const t of plan.tasks) {
    const p = await acceptedProduct(ctx, t.id);
    if (p === null) continue;
    const events = (await eventsOf(ctx, taskLine(t.id))).map((e) => ({ revision: e.revision, event: e.event, key: e.key, body: e.body }));
    const k = lineAcceptance(events).k;
    const product = events.filter((e) => e.event === 'product').map((e) => e.body as { object: string; changedPaths: string[] }).find((b) => b.object === p);
    accepted.push({ task: t.id, product: p, attempt: k, changedPaths: [...(product?.changedPaths ?? [])] });
  }
  // the owners of the paths the repair is about: a task's accepted change, else none
  const about = r.about?.kind === 'task' ? accepted.find((x) => x.task === r.about!.id)?.changedPaths ?? [] : [];
  const owners = (await pathOwners(ctx, about)).map((o) => ({ path: o.path, owners: o.owners.map((x) => ({ task: x.task, product: x.product, attempt: x.attempt, current: x.current })) }));
  const card: ArchitectRepairCard = {
    ...cardBase(ctx, task, {
      duties: `Turn repair ${r.id} into the least work that fixes it: reopen the tasks whose accepted work causes it, and add tasks only for work no existing task owns. Change no existing task. Only the program's mechanical checks follow (no Calibrator, no feasibility review).`,
      constraints: planningConstraints(await currentConstraints(ctx), ctx.mission),
    }),
    repairs: [repairRef(r)],
    seat: 'architect-repair',
    workspace: { snapshot: snap.path, writablePaths: [] },
    repair: { id: r.id, kind: r.kind, text: r.text, words: r.words, about: r.about === null ? null : `${r.about.kind} ${r.about.id}` },
    dplan: eff.dplan,
    pmPlan: eff.pmPlan,
    elements: doc.elements.filter((e) => e.kind !== 'exploration').map((e) => ({ id: e.id, kind: e.kind, text: e.text })),
    plan,
    accepted,
    owners,
    history: { gitLog: history.gitLog, runs: [...history.runs] },
    revision: a.mechanicalFailures.length > 0 ? { mechanicalFailures: [...a.mechanicalFailures] } : null,
    projectCommands: projectCommandsOf(ctx),
    materials: [material(ctx, 'plan', `Detailed plan ${eff.dplan} as it is in effect (with earlier repairs), in full`, previousPlanText(eff.dplan, plan), true, 'plan')],
  };
  await ctx.ports.scheduler.submit({
    task,
    lineage: repairLineage(ctx.mission, r.id),
    mission: ctx.mission,
    card,
    priority: 100,
    capabilities: card.capabilities,
    mode: 'fast',
    estimateMicros: 500_000,
    handover: { from: null, objects: [eff.dplan], step: `repair ${r.id} (${r.kind}), recorded by the PM from the user's words ${r.words}` },
  });
  ctx.progressed = true;
}
