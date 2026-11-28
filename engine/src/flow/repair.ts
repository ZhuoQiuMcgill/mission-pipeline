// Repairs (4.1.2, D-9, D-10): the user tried the product and found a problem; the PM records it as a
// repair item (`mp pm repair`) with the user's reason verbatim from a words entry and the kind the PM
// chose. The repair does not re-run the decision layer: no Calibrator ①, no feasibility review, no
// Calibrator ②, no new detailed-plan version.
//
//   about an exploration   the exploration is reopened for one more round with the repair as an added
//                          question (exploration/flow.ts recordExplorationRerun); its settled
//                          conclusion stays in the record as history; a new settle is routed again.
//                          4.1.3 (E-5, #31): the author gets the turn at once, even in the attempts
//                          phase (the method goes back to its author; a queued interpreter is
//                          withdrawn in the same write). With a change form (`--attempts`, `--rerun`,
//                          `--resnapshot`) the user's decision about the method is applied directly
//                          instead (process/explorationAttempts.ts, explorationSnapshot.ts): the repair
//                          and the change are one write, the change answers the repair, and no round
//                          is added
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
import { repairPlanMaterial, type ArchitectRepairCard, type ArchitectRepairResult } from '../seat/cards/architect.ts';
import { addressedForPlanning, addressedIndexOf, planningConstraints } from '../seat/cards/dynamic.ts';
import { answerText } from './openItems.ts';
import { basisIndex, cardBase, commit, countedReturn, ev, eventOf, eventsOf, flowCtx, idPart, missionClosed, nextBasisVersion, notify, objectRecord, safeId, shortHash, taskView, tellOnce, type FlowCtx } from './context.ts';
import { handleFailure } from './failures.ts';
import { mechanicalCheck, type MechanicalResult } from './mechanical.ts';
import { itemIds, riskItemsOf, takenItems } from './riskItems.ts';
import { DetailedPlanDoc, PLAN_LINE, REPAIRS_LINE, REPAIR_KINDS, amendedPlan, amendedTaskIds, cardChangedBy, explorationLine, repairOfTask, repairRef, taskCardHash, taskLine, type AmendmentEntry, type DetailedTask, type RepairBody, type RepairDecidedBody, type RepairKind, type RepairRef } from './plandoc.ts';
import { detailedPlanOf, explorationState, planInEffect, pmPlanDoc, projectCommandsOf, standardLine, REPLAN_ANSWERED, type EffectiveBody } from './planning.ts';
import { acceptedProduct, lineAcceptance, pathOwners, REOPEN_NOT_CARRIED, waitCircles, type ReopenNotCarriedBody } from './execution.ts';
import type { FlowPorts } from './ports.ts';
import { currentConstraints } from './requirements.ts';
import { carryOut, closing, commitCarrying, grantForDecision, grantedAttempt, decisionFor, escalateToUser, isApplied, markApplied, openEscalations, raiseEscalation, REPAIR_QUESTION_TO_PM } from './secretary.ts';
import { recordExplorationRerun } from './exploration/flow.ts';
import { ATTEMPT_RERUN, ATTEMPTS_AMENDED, RESNAPSHOTTED, type AttemptRerunBody, type AttemptsAmendedBody, type ConsumedBody, type ResnapshotBody, type Role } from './exploration/machine.ts';
import { WI } from './wi.ts';

/** One Architect repair attempt (line "repairs", event "attempt", key "<repair>#<k>"). */
interface RepairAttemptBody {
  readonly k: number;
  /** The plan in effect it amends. */
  readonly dplan: string;
  /** 4.4 (G4): "answered": the attempt after the PM answered the Architect's question (not counted on any loop). */
  readonly reason: 'initial' | 'mechanical' | 'plan-changed' | 'granted' | 'answered';
  readonly mechanicalFailures: readonly string[];
  /** 4.4 (G4): the question the Architect handed back with no edit, and the answer that came back on this attempt's card. */
  readonly answered?: { readonly escalation: string; readonly question: string; readonly answer: string; readonly by: string };
}

/** 4.4 (G4): the escalation of a repair Architect's question (one per Architect attempt). */
export const repairQuestionId = (task: string): string => safeId(`ask.${task}`);
/**
 * 4.4 (F13, p7-8): `mp pm repair … --again --op K` returned the same repair still in work: K is recorded against it
 * (line "repairs", key the hash of K), so a retry of K returns that repair, also once it was decided.
 */
const AGAIN_RETURNED = 'again-returned';
interface AgainReturnedBody {
  readonly op: string;
  readonly repair: string;
}

export const repairLineage = (mission: string, repair: string): string => safeId(`repair.${mission}.${idPart(repair)}`);
const archRepairTask = (mission: string, repair: string, k: number): string => safeId(`arch-repair.${mission}.${idPart(repair)}.${k}`);

/** A mission's repairs with where each stands (the one resolver: reads, cards and the close snapshot use it). */
export interface RepairState extends RepairBody {
  /**
   * exploration: reopened for one more round; answered: about an exploration, and answered by a
   * change the user's decision made to its method instead of a round (4.1.3: `mp pm repair --attempts`,
   * `--rerun`, `--resnapshot`; before: `mp pm amend-attempts --answers`); architect: its Architect
   * step is under way; decided: amended and/or reopened; waiting: nothing to amend yet.
   */
  readonly state: 'exploration' | 'answered' | 'architect' | 'decided' | 'waiting';
  readonly added: readonly string[];
  readonly reopened: readonly string[];
  /** 4.1.3: the tasks whose card it changed (absent: none). */
  readonly changed?: readonly string[];
  /** The plan it amended (decided), or works on. */
  readonly dplan: string | null;
  /**
   * answered: the change that answered it (its event, its number on the exploration, and the user's
   * words it rests on); `amendment` is that number for an amendment of the attempts.
   */
  readonly answeredBy?: { readonly exploration: string; readonly change: 'attempts-amended' | 'attempt-rerun' | 'resnapshotted'; readonly n: number; readonly amendment?: number; readonly words: string };
}

/** The change about an exploration that answered a repair (4.1.3: any of the three change forms), or null. */
async function answeringChange(c: FlowCtx, r: RepairBody): Promise<RepairState['answeredBy'] | null> {
  if (r.about?.kind !== 'exploration') return null;
  const x = r.about.id;
  const line = explorationLine(x);
  const amended = (await eventsOf<AttemptsAmendedBody>(c, line, ATTEMPTS_AMENDED)).find((e) => e.body.answers === r.id || e.body.repair === r.id)?.body;
  if (amended !== undefined) return { exploration: x, change: ATTEMPTS_AMENDED, n: amended.n, amendment: amended.n, words: amended.words };
  const rerun = (await eventsOf<AttemptRerunBody>(c, line, ATTEMPT_RERUN)).find((e) => e.body.answers === r.id)?.body;
  if (rerun !== undefined) return { exploration: x, change: ATTEMPT_RERUN, n: rerun.n, words: rerun.words };
  const snap = (await eventsOf<ResnapshotBody>(c, line, RESNAPSHOTTED)).find((e) => e.body.answers === r.id)?.body;
  if (snap !== undefined) return { exploration: x, change: RESNAPSHOTTED, n: snap.n, words: snap.words ?? r.words };
  return null;
}

/**
 * The repair a change form records in the write that applies it (4.1.3, E-5): its id (after the
 * repairs recorded so far) and its body. The caller checked the reason against the words entry.
 */
export function changeFormRepair(recorded: number, req: { readonly words: string; readonly kind: RepairKind; readonly text: string; readonly exploration: string }): RepairBody {
  if (!(REPAIR_KINDS as readonly string[]).includes(req.kind)) throw new Error(`a repair's kind is one of ${REPAIR_KINDS.join(', ')}`);
  if (req.text.trim() === '') throw new Error("a repair records the user's reason");
  return { id: `R-${recorded + 1}`, words: req.words, kind: req.kind, text: req.text, about: { kind: 'exploration', id: req.exploration } };
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
    // about an exploration: answered by a change to its method on the user's decision, or one more round
    const answered = await answeringChange(c, r);
    const state: RepairState['state'] = r.about?.kind === 'exploration' ? (answered !== null ? 'answered' : 'exploration') : d !== undefined ? 'decided' : a !== undefined ? 'architect' : 'waiting';
    out.push({
      ...r,
      state,
      added: d?.add ?? [],
      reopened: d?.reopen.map((x) => x.task) ?? [],
      ...((d?.changed ?? []).length > 0 ? { changed: [...d!.changed!] } : {}),
      dplan: d?.dplan ?? a?.dplan ?? null,
      ...(answered !== null ? { answeredBy: answered } : {}),
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
 * one recorded, while it is undecided or its amendment is part of the plan in effect. 4.4 (F13, #60):
 * `again` files a new one although the same repair was decided (about an exploration: its round is over);
 * one still in work is the same filing in flight, and is returned. `over` names the same repair whose work is over.
 */
export async function recordRepair(
  ports: FlowPorts,
  req: {
    readonly mission: MissionId;
    readonly words: string;
    readonly kind: RepairKind;
    readonly text: string;
    readonly about: { readonly kind: 'task' | 'exploration'; readonly id: string } | null;
    /** About an exploration in its attempts phase (4.1.3, #31): its interpreter step, only queued, withdrawn in the same write. */
    readonly withdraw?: ReadonlyArray<{ readonly task: string; readonly role: Role }>;
    /** 4.4 (F13, #60): `mp pm repair … --again`. */
    readonly again?: boolean;
    /** 4.4 (F13, p7-8): with `again`, the PM operation filing it: recorded with the repair, so its retry returns that repair. */
    readonly op?: string;
    /** 4.4 (G4, G5): `--open-items`: the open items left at the cap this repair is for (absent or empty: none, as 4.3). */
    readonly openItems?: readonly string[];
  },
): Promise<{ readonly id: string; readonly repeated: boolean; readonly over?: string }> {
  const ctx = flowCtx(ports, req.mission);
  if (!(REPAIR_KINDS as readonly string[]).includes(req.kind)) throw new Error(`a repair's kind is one of ${REPAIR_KINDS.join(', ')}`);
  if (req.text.trim() === '') throw new Error('a repair records the user\'s reason');
  if (await missionClosed(ctx)) throw new Error(`mission ${req.mission} is closed: a repair is recorded before the mission is closed`);
  const items = [...new Set(req.openItems ?? [])].sort();
  if (items.length > 0 && req.about?.kind === 'exploration') throw new Error('--open-items goes with a repair of the plan in effect: an exploration has no task to take an open item');
  const existing = await eventsOf<RepairBody>(ctx, REPAIRS_LINE, 'repair');
  const pie = await planInEffect(ctx);
  // 4.4 (F13, p7-8): the operation filed it already (a retry after its receipt was lost): that repair, whatever became of it since
  const op = req.again === true ? req.op : undefined;
  const mine = op === undefined ? undefined : existing.find((e) => e.body.op === op);
  // or it returned the same repair still in work: that one again, even once it was decided since
  const returned = op === undefined || mine !== undefined ? undefined : (await eventsOf<AgainReturnedBody>(ctx, REPAIRS_LINE, AGAIN_RETURNED)).find((e) => e.body.op === op)?.body;
  if (returned !== undefined) return { id: returned.repair, repeated: true };
  /** The same repair still in work, returned: with `--again --op`, the operation is recorded against it first. */
  const inWork = async (id: string): Promise<{ readonly id: string; readonly repeated: true }> => {
    if (op !== undefined) await commit(ctx, `flow:repair-again:${req.mission}:${shortHash(op)}`, { events: [ev(ctx, REPAIRS_LINE, AGAIN_RETURNED, shortHash(op), { op, repair: id } satisfies AgainReturnedBody)] });
    return { id, repeated: true };
  };
  let same: string | undefined;
  for (const e of existing) {
    const r = e.body;
    // 4.4 (G5): the open items it is for are part of what it is (none named on either: as 4.3)
    if (r.words !== req.words || r.kind !== req.kind || r.text !== req.text || canonicalJson(r.about) !== canonicalJson(req.about) || canonicalJson(r.openItems ?? []) !== canonicalJson(items)) continue;
    if (mine !== undefined) {
      if (e.key !== mine.key && e.revision < mine.revision) same = r.id;
      continue;
    }
    const d = (await eventOf<RepairDecidedBody>(ctx, REPAIRS_LINE, 'decided', r.id))?.body;
    if (r.about?.kind === 'exploration') {
      // about an exploration (never "decided"): its round is over once the exploration stopped since, or a change answered it
      const over = (await answeringChange(ctx, r)) !== null || (await eventsOf(ctx, explorationLine(r.about.id), 'stopped')).some((s) => s.revision > e.revision);
      if (!over && req.again === true) return inWork(r.id);
      if (!over || req.again !== true) return { id: r.id, repeated: true, ...(over ? { over: r.id } : {}) };
      same = r.id;
      continue;
    }
    if (d === undefined) return inWork(r.id);
    same = r.id;
    // the same repair stands while what it added is in the plan in effect, unless the PM files it again (4.4, F13)
    if (req.again !== true && (pie === null || d.add.every((t) => pie.plan.tasks.some((x) => x.id === t)))) return { id: r.id, repeated: true, over: r.id };
  }
  const again = same !== undefined && req.again === true ? { over: same } : {};
  if (mine !== undefined) return { id: mine.key, repeated: false, ...again };
  // checked only when filed anew (a repeated filing returns what was filed, whatever became of its items since)
  if (items.length > 0) await openItemsProblem(ctx, items);
  const id = `R-${existing.length + 1}`;
  const body: RepairBody = { id, words: req.words, kind: req.kind, text: req.text, about: req.about, ...(op !== undefined ? { op } : {}), ...(items.length > 0 ? { openItems: items } : {}) };
  const event = ev(ctx, REPAIRS_LINE, 'repair', id, body);
  if (req.about?.kind === 'exploration') {
    const x = req.about.id;
    if ((await eventsOf(ctx, `exploration:${x}`, 'defined')).length === 0) throw new Error(`mission ${req.mission} has no exploration ${x}`);
    // one more round with the repair as an added question, the author's turn at once (4.1.3); the
    // settled conclusion stays as history; a queued interpreter on the method it sends back is withdrawn (one write)
    const withdrawn = (req.withdraw ?? []).map((w) => {
      const c: ConsumedBody = { kind: 'withdrawn', task: w.task, role: w.role, reason: `repair ${id} sent the method back to its author: the interpretation waits for the method's new version` };
      return ev(ctx, explorationLine(x), 'consumed', w.task, c);
    });
    await recordExplorationRerun(ports, req.mission, x, { evidence: [], environment: `repair:${id}`, repair: repairRef(body), authorTurn: true }, { events: [event, ...withdrawn] });
    for (const w of req.withdraw ?? []) await ports.scheduler.cancel(w.task);
    return { id, repeated: false, ...again };
  }
  if (pie === null) throw new Error(`mission ${req.mission} has no detailed plan in effect: a repair amends the plan in effect (plan the work with mp pm plan submit first)`);
  if (req.about?.kind === 'task' && !pie.plan.tasks.some((t) => t.id === req.about!.id)) throw new Error(`task ${req.about.id} is not a task of the plan in effect (${pie.eff.dplan})`);
  await commit(ctx, `flow:repair:${req.mission}:${id}`, { events: [event] });
  return { id, repeated: false, ...again };
}

/**
 * 4.4 (G4, G5): the open items a repair names must be items left at the cap in its mission, still open, and the
 * repair must be about the plan in effect (an exploration has no task to take one). A new option: refused with the
 * reason, never a refusal of a repair filed without it.
 */
async function openItemsProblem(ctx: FlowCtx, ids: readonly string[]): Promise<void> {
  const known = new Map(riskItemsOf(await ctx.ports.ledger.events({ mission: ctx.mission })).map((i) => [i.id, i]));
  for (const id of ids) {
    const i = known.get(id);
    if (i === undefined) throw new Error(`${id} is not an item left at the cap in mission ${ctx.mission} (mp read open-items ${ctx.mission} lists them; a question is answered, not repaired)`);
    if (i.closed !== null) throw new Error(`open item ${id} is closed already: a repair is for what is still open`);
  }
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
  // 4.4 (F13): one read of the plan in effect, with the revision its decision's write is checked against
  const effective = (await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')).at(-1);
  if (effective === undefined) return;
  // 4.4 (p7-4): and the latest repair decided, which changes with every decision applied (a reopen-only one too)
  const decided = (await eventsOf(ctx, REPAIRS_LINE, 'decided')).at(-1)?.revision ?? null;
  const stored = await detailedPlanOf(ctx, effective.body.dplan);
  if (stored === null) return;
  const eff = effective.body;
  const plan = amendedPlan(stored.plan, eff.amendments);
  const list = await attemptsOf(ctx, r.id);
  if (list.length === 0) return newAttempt(ctx, r.id, { k: 1, dplan: eff.dplan, reason: 'initial', mechanicalFailures: [] });
  const a = list.at(-1)!;
  const task = archRepairTask(ctx.mission, r.id, a.k);
  // a new plan took effect since the step started: the repair amends that one (not counted)
  if (a.dplan !== eff.dplan) {
    if ((await ctx.ports.scheduler.status(task))?.state === 'queued') await ctx.ports.scheduler.cancel(task);
    const next: RepairAttemptBody = { k: a.k + 1, dplan: eff.dplan, reason: 'plan-changed', mechanicalFailures: [] };
    // 4.4 (G4): a question the Architect asked on the earlier plan closes with it, in the same write: the next step decides on the plan in effect
    const asked = (await openEscalations(ctx, `repair:${r.id}`)).filter((e) => e.source === 'repair-question').map((e) => e.id);
    if (asked.length === 0) return newAttempt(ctx, r.id, next);
    return commitCarrying(ctx, `flow:repair-attempt:${ctx.mission}:${r.id}:${next.k}`, [ev(ctx, REPAIRS_LINE, 'attempt', `${r.id}#${next.k}`, next)], [closing(ctx, asked, `a new plan took effect (${eff.dplan}): repair ${r.id}'s Architect decides again on it`)], asked);
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
  const change = result.change ?? [];
  // 4.4 (G4): a hand-back with no edit is the Architect's question; the repair waits undecided for the PM's answer
  if (result.reopen.length === 0 && added.length === 0 && change.length === 0) return askPm(ctx, r, a, task, result.note);
  // the mechanical checks only (D-10): the plan in effect with the changed cards (4.1.3), plus the added tasks.
  // 4.4 (F13, p7-5, p7-4): kept per plan in effect (its revision) and per repairs decided (the latest one's revision),
  // so a decision retried on a plan another repair amended since, or after another repair was decided, is checked
  // again; a result 4.3 kept (keyed by the step alone) is checked again too
  const mcKey = `${task}@r${effective.revision}.d${decided ?? 0}`;
  let mc = (await eventOf<MechanicalResult>(ctx, REPAIRS_LINE, 'mechanical-check', mcKey))?.body ?? null;
  if (mc === null) {
    const doc = await pmPlanDoc(ctx, eff.pmPlan);
    if (doc === null) return;
    const ex = await explorationState(ctx, doc);
    if (ex.recomputing) return;
    const snap = await ctx.ports.scheduler.snapshot({ mission: ctx.mission, purpose: 'architect' });
    const before = new Map(change.flatMap((c) => { const t = plan.tasks.find((x) => x.id === c.id); return t === undefined ? [] : [[c.id, t] as const]; }));
    mc = await mechanicalCheck({
      pmPlan: doc,
      plan: { ...plan, tasks: [...plan.tasks.map((t) => change.find((c) => c.id === t.id) ?? t), ...added] },
      unsettled: ex.unsettled,
      hasSymbol: (file, symbol) => ctx.ports.scheduler.findSymbol({ snapshot: snap.path, file, symbol }),
      fullSuite: ctx.ports.project?.fullSuite ?? [],
      amendment: { added: new Set(added.map((t) => t.id)), ...(before.size > 0 ? { changed: before } : {}) },
      // the tasks earlier repairs added stay outside the integration rule (S3)
      amended: amendedTaskIds((await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')).map((e) => e.body)),
      // 4.4 (G5): the open items an added or changed task may take (read only when one names one)
      ...([...added, ...change].some((t) => (t.openItems ?? []).length > 0) ? { openItems: itemIds(await ctx.ports.ledger.events({ mission: ctx.mission })) } : {}),
    });
    // 4.4 (G5): a reopened task takes only open items of the mission too
    const reopenNames = result.reopen.flatMap((x) => (x.open_items ?? []).map((id) => ({ task: x.task, id })));
    if (reopenNames.length > 0) {
      const known = itemIds(await ctx.ports.ledger.events({ mission: ctx.mission }));
      const bad = reopenNames.filter((x) => !known.has(x.id)).map((x) => `open items: the reopen of task ${x.task} takes "${x.id}", which is not an open item of the mission`);
      if (bad.length > 0) mc = { ...mc, ok: false, failures: [...mc.failures, ...bad] };
    }
    await commit(ctx, `flow:repair-mechanical:${ctx.mission}:${mcKey}`, { events: [ev(ctx, REPAIRS_LINE, 'mechanical-check', mcKey, mc)] });
  }
  if (!mc.ok) return repairReturn(ctx, r, a, task, mc.failures);
  // 4.4 (F5, p3-3): a changed card of a task that has an accepted product by now (the Architect's card was
  // stale, however it became so) is a mechanical failure of the hand-back, never an edit skipped while the
  // repair is recorded as decided: it goes back to the Architect through the mechanical-return loop, whose
  // next attempt's card is built on the work accepted now
  const accepted: string[] = [];
  for (const c of change) if (plan.tasks.some((t) => t.id === c.id) && (await acceptedProduct(ctx, c.id)) !== null) accepted.push(c.id);
  // 4.4 (F13, #61): a repair does not overwrite a card it has not seen. Each card it changes is compared with that
  // task's card on the plan its Architect was given; one changed since (another repair's amendment), and an added
  // id the plan in effect holds since, return the decision once to the Architect on the plan in effect now, by
  // the same mechanical-return loop
  const unseen = await unseenCards(ctx, view, plan, eff, result);
  const failures = [
    ...accepted.map((id) => `change[${id}]: task ${id} now has an accepted product: reopen it instead (the card it was changed on predates its acceptance)`),
    ...unseen,
    // 4.4 (F12 b, p7-4): no task may end up waiting in a circle with the waits the flow holds now (other repairs' reopens included)
    ...(await waitCircles(ctx, plan, result)),
  ];
  if (failures.length > 0) return repairReturn(ctx, r, a, task, failures);
  await decide(ctx, r, task, eff, plan, result, mc, { effective: effective.revision, decided });
}

/**
 * 4.4 (F13): the cards a repair's hand-back changes (or the ids it adds) that changed in the plan in effect since its
 * Architect was given its card (the card of its claim, rebuilt at the claim, F5), as mechanical failures. None when
 * the claimed card cannot be read (the decision is applied as 4.3 applied it).
 */
async function unseenCards(ctx: FlowCtx, view: Extract<Awaited<ReturnType<typeof taskView>>, { kind: 'done' }>, plan: DetailedPlanDoc, eff: EffectiveBody, result: ArchitectRepairResult): Promise<string[]> {
  const dispatch = view.status.handBack?.dispatch;
  if (dispatch === undefined) return [];
  const claimed = await eventOf<{ spec?: string }>(ctx, `dispatch:${dispatch}`, 'claimed', 'spec');
  let given: DetailedPlanDoc;
  try {
    if (typeof claimed?.body.spec !== 'string') return [];
    given = DetailedPlanDoc.parse((JSON.parse(ctx.ports.ledger.content.get(claimed.body.spec)) as { card: { plan: unknown } }).card.plan);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const c of result.change ?? []) {
    const was = given.tasks.find((t) => t.id === c.id);
    const now = plan.tasks.find((t) => t.id === c.id);
    if (now === undefined || (was !== undefined && taskCardHash(was) === taskCardHash(now))) continue;
    const by = cardChangedBy(eff.amendments, c.id);
    out.push(`change[${c.id}]: the card of task ${c.id} changed after your card was built${by !== null ? ` (repair ${by} changed it)` : ''}: make your change again on its card in the plan in effect now`);
  }
  for (const t of result.add) {
    if (given.tasks.some((x) => x.id === t.id) || !plan.tasks.some((x) => x.id === t.id)) continue;
    const by = repairOfTask(eff.amendments, t.id);
    out.push(`add[${t.id}]: task id "${t.id}" was added to the plan in effect after your card was built${by !== null ? ` (by repair ${by})` : ''}: use a fresh id, or change that task's card`);
  }
  return out;
}

/**
 * 4.4 (G4): the repair's Architect could not decide and handed back its question with no edit. The repair is
 * the PM's filing on the user's words, so the question goes to the PM's inbox (no Secretary step); the repair
 * stays undecided. When the PM (or the user) answers with "answer", the answer is carried out in the same write
 * as the repair's next Architect attempt, whose card carries the question and the answer.
 */
async function askPm(ctx: FlowCtx, r: RepairBody, a: RepairAttemptBody, task: string, question: string): Promise<void> {
  const id = repairQuestionId(task);
  const short = question.replace(/\s+/g, ' ').trim();
  // 4.4 (G4, p6-7): posted only while this attempt is the repair's latest and its plan is the one in effect, checked
  // inside the write: another pass that moved the repair on (a new plan, its next attempt) leaves no orphan question
  const effective = (await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')).at(-1);
  if (effective === undefined || effective.body.dplan !== a.dplan) return;
  const guard = {
    absent: [{ mission: ctx.mission, line: REPAIRS_LINE, event: 'attempt', key: `${r.id}#${a.k + 1}` }],
    latest: [{ mission: ctx.mission, line: PLAN_LINE, event: 'effective', revision: effective.revision }],
    code: 'STALE_REQUEST',
    message: `repair ${r.id} moved on (a new plan, or its next Architect attempt) while its Architect's question was being posted: nothing was posted`,
  };
  await raiseEscalation(ctx, {
    id,
    source: 'repair-question',
    lineage: repairLineage(ctx.mission, r.id),
    subject: `repair:${r.id}`,
    // the question in full is its reason (mp read show escalation prints it); the summary is bounded
    summary: `Repair ${r.id}'s Architect asks before it decides (attempt ${a.k}): ${short.length <= 1000 ? short : `${short.slice(0, 999)}…`}`,
    reasons: [question],
    options: ['answer'],
    facts: { repair: r.id, task, attempt: a.k },
    handover: { from: task, objects: [] },
  }, [], guard);
  // raised by an earlier pass that stopped before handing it over: hand it over now (idempotent)
  if (!(await isApplied(ctx, id))) await escalateToUser(ctx, id, REPAIR_QUESTION_TO_PM, null);
  const d = await decisionFor(ctx, id);
  if (d === null || d.option !== 'answer' || (await isApplied(ctx, id))) return;
  // a user's answer recorded with words and no instructions carries those words (answerText)
  const next: RepairAttemptBody = { k: a.k + 1, dplan: a.dplan, reason: 'answered', mechanicalFailures: [], answered: { escalation: id, question, answer: answerText(d), by: d.by } };
  await commitCarrying(ctx, `flow:repair-attempt:${ctx.mission}:${r.id}:${next.k}`, [ev(ctx, REPAIRS_LINE, 'attempt', `${r.id}#${next.k}`, next)], [await carryOut(ctx, id, { option: 'answer' })]);
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
    const g = await grantForDecision(ctx, { op: `grant:${ctx.mission}:${id}:${d.by}`, lineage, loop: 'mechanical-return', by: d.by === 'pm' ? 'pm' : d.by === 'user' ? 'user' : 'secretary', extra: Math.max(1, d.grantExtra), reason: d.reason });
    if (!g.granted) {
      await escalateToUser(ctx, id, `the Secretary's grant on lineage ${lineage} was refused (${g.why ?? 'refused'}): only the user can grant more`, WI.loopExhausted);
      return;
    }
    await grantedAttempt(ctx, g, { op: `flow:repair-return:${ctx.mission}:${task}:granted`, lineage, loop: 'mechanical-return', signature: `${signature}:granted` });
    await markApplied(ctx, id, { option: 'grant', extra: d.grantExtra }, g.records);
  }
  await newAttempt(ctx, r.id, { ...next, reason: 'granted', mechanicalFailures: [...failures, ...(d.instructions !== '' ? [d.instructions] : [])] });
}

/**
 * The repair decided (one write): the decision record, and, when it adds tasks, the amendment of the
 * plan in effect (a new "effective" event of the same detailed plan) with the added tasks' standards
 * as basis lines. Reopened tasks get their new attempts from execution (carryReopens). Each reopened
 * task is taken at the attempt it is accepted at now; one no longer accepted is left out, said.
 */
async function decide(ctx: FlowCtx, r: RepairBody, task: string, eff: EffectiveBody, plan: DetailedPlanDoc, result: ArchitectRepairResult, mc: MechanicalResult, read: { readonly effective: number; readonly decided: number | null }): Promise<void> {
  const reopen: Array<RepairDecidedBody['reopen'][number]> = [];
  const skipped: string[] = [];
  const notCarried: Array<{ readonly task: string; readonly attempt: number; readonly why: string }> = [];
  // 4.4 (p7-r3-1): the card of each task a record "not carried out" relies on, as read (its latest spec): checked in the write
  const specsRead: Array<{ readonly mission: string; readonly line: string; readonly event: string; readonly revision: number | null }> = [];
  for (const x of result.reopen) {
    const events = (await eventsOf(ctx, taskLine(x.task))).map((e) => ({ revision: e.revision, event: e.event, key: e.key, body: e.body }));
    const sel = lineAcceptance(events);
    // 4.4 (F12 b): the tasks of this repair the reopen comes after (absent when none: the 4.3 shape)
    const after = [...new Set(x.after ?? [])];
    // 4.4 (G5): the open items the reopened task takes (absent when none)
    const items = [...new Set(x.open_items ?? [])];
    const extra = { ...(after.length > 0 ? { after } : {}), ...(items.length > 0 ? { openItems: items } : {}) };
    if (sel.product !== null && (await acceptedProduct(ctx, x.task)) !== null) {
      reopen.push({ task: x.task, issue: x.issue, attempt: sel.k, product: sel.product, ...extra });
      continue;
    }
    // 4.4 (F13): a task that moved on since its Architect's card (another repair reopened it, say) is never dropped:
    // requested at the attempt it was last accepted at, its reopen waits for the open attempt's acceptance and then
    // opens the next attempt (execution, repairReopen)
    const last = events.filter((e) => e.event === 'accepted').at(-1)?.body as { k: number; product: string } | undefined;
    if (!sel.abandoned && plan.tasks.some((t) => t.id === x.task) && last !== undefined) {
      reopen.push({ task: x.task, issue: x.issue, attempt: last.k, product: last.product, ...extra });
      continue;
    }
    // a giving-up holds only under the card it was recorded under: a card of the plan in effect the task has not taken
    // yet (another repair changed it) revives the task once execution lays it, so nothing is decided now (read again)
    const spec = events.filter((e) => e.event === 'spec').at(-1);
    const card = plan.tasks.find((t) => t.id === x.task);
    if (sel.abandoned && card !== undefined && spec !== undefined && (spec.body as { hash?: string }).hash !== taskCardHash(card)) return;
    specsRead.push({ mission: ctx.mission, line: taskLine(x.task), event: 'spec', revision: spec?.revision ?? null });
    notCarried.push({ task: x.task, attempt: sel.k, why: sel.abandoned ? 'the task was given up' : 'the task has no accepted work to reopen' });
  }
  const added: readonly DetailedTask[] = result.add;
  // 4.1.3 (#35): a changed card is taken only for a task with no accepted product now; 4.4: one accepted
  // meanwhile went back to the Architect first (oneRepair), so what is left out here is said, never an accepted task's edit
  const changed: DetailedTask[] = [];
  for (const c of result.change ?? []) {
    if ((await acceptedProduct(ctx, c.id)) !== null || !plan.tasks.some((t) => t.id === c.id)) skipped.push(c.id);
    else changed.push(c);
  }
  // 4.4 (G3, F2): the Architect's note is recorded with its decision (also an empty one, so a read tells it from a
  // 4.3 decision, which has none); the cards of the tasks it added, changed or reopened print it
  // 4.4 (F13, p7-1): `tracked` tells this decision's reopens from those of 4.3 by the record, not by where the task is
  const body: RepairDecidedBody = { repair: r.id, dplan: eff.dplan, arch: task, add: added.map((t) => t.id), reopen, ...(changed.length > 0 ? { changed: changed.map((t) => t.id) } : {}), ...(reopen.length > 0 ? { tracked: true as const } : {}), note: result.note.trim() };
  const events = [ev(ctx, REPAIRS_LINE, 'decided', r.id, body)];
  const records: BaseRecord[] = [];
  if (added.length > 0 || changed.length > 0) {
    const entry: AmendmentEntry = { repair: r.id, tasks: added, reopen: reopen.map((x) => ({ task: x.task, issue: x.issue })), arch: task, ...(changed.length > 0 ? { changed } : {}) };
    const n = (eff.amendments ?? []).length + 1;
    const amended: EffectiveBody = { ...eff, tasks: [...eff.tasks, ...added.map((t) => t.id)], amendments: [...(eff.amendments ?? []), entry] };
    events.push(ev(ctx, PLAN_LINE, 'effective', `${eff.dplan}#a${n}`, amended));
    // a re-plan a changed task waits for is answered by the change (#35): it is not routed to the Architect any more
    const changedIds = new Set(changed.map((t) => t.id));
    const answered = new Set((await eventsOf(ctx, PLAN_LINE, REPLAN_ANSWERED)).map((e) => e.key));
    for (const q of await eventsOf<{ task: string }>(ctx, PLAN_LINE, 'replan-request')) {
      if (changedIds.has(q.body.task) && !answered.has(q.key)) events.push(ev(ctx, PLAN_LINE, REPLAN_ANSWERED, q.key, { escalation: q.key, task: q.body.task, repair: r.id }));
    }
    // the added tasks' standards, and the changed cards', become basis lines, as a plan's do when it takes effect
    const ix = await basisIndex(ctx);
    for (const t of [...added, ...changed]) {
      for (const s of t.standards) {
        const line = standardLine(ctx.mission, t.id, s.id);
        const version = nextBasisVersion(ix, line, shortHash(s.text));
        if (version !== null) records.push({ kind: 'basis.version', basisKind: 'standard', line: line as BasisLineId, version: version as BasisVersionId, mission: ctx.mission, scope: null });
      }
    }
  }
  // 4.4 (F13): a reopen that cannot be carried out is recorded with the decision (the first record of its request), so
  // the repair does not read as done; the PM's notice follows from the record (execution, reopenNotices)
  for (const x of notCarried) events.push(ev(ctx, REPAIRS_LINE, REOPEN_NOT_CARRIED, `${r.id}:${x.task}#1`, { repair: r.id, task: x.task, attempt: x.attempt, why: x.why } satisfies ReopenNotCarriedBody));
  // 4.4 (F13, p7-4): checked in the write: the plan in effect is still the one whose cards the decision was compared
  // with, and no other repair was decided since its waits were checked (a reopen-only decision leaves the plan as it
  // is, and its waits could close a circle with these), and (p7-r3-1) each task recorded as not carried out still has
  // the card it was read under (a new card revives a task given up). Any one changed: read again on the next pass
  await commit(ctx, `flow:repair-decided:${ctx.mission}:${r.id}`, { events, records, guard: { latest: [{ mission: ctx.mission, line: PLAN_LINE, event: 'effective', revision: read.effective }, { mission: ctx.mission, line: REPAIRS_LINE, event: 'decided', revision: read.decided }, ...specsRead], absent: [], code: 'STALE_REQUEST', message: `the plan in effect, the repairs decided, or the card of a task it reopens changed while repair ${r.id}'s decision was being recorded; nothing was written (the next pass reads it again)` } });
  await tellOnce(ctx, REPAIRS_LINE, {
    category: 'repair-decided',
    wi: null,
    key: r.id,
    trigger: `repair ${r.id} (${r.kind}) passed the mechanical checks: ${added.length > 0 ? `adds ${added.map((t) => t.id).join(', ')} to the plan in effect (${eff.dplan})` : 'adds no task'}; ${reopen.length > 0 ? `reopens ${reopen.map((x) => x.task).join(', ')}` : 'reopens no task'}${changed.length > 0 ? `; changes the card of ${changed.map((t) => t.id).join(', ')}` : ''}${skipped.length > 0 ? `; the card change of ${skipped.join(', ')} ${skipped.length === 1 ? 'was' : 'were'} left out (accepted meanwhile, so its card stays, or no longer in the plan)` : ''}${notCarried.length > 0 ? `; not carried out: the reopen of ${notCarried.map((x) => `${x.task} (${x.why})`).join(', ')}` : ''}${mc.orderChanges.length > 0 ? `; order changes against the user's order: ${mc.orderChanges.join('; ')}` : ''}`,
    defaultAction: `the work goes on: the added tasks run like any task of the plan, each reopened task gets a new attempt with the repair on its card (one with an open attempt, once that attempt is accepted)${changed.length > 0 ? ', each changed task starts a new attempt under its new card and carries its earlier work on' : ''}; nothing else is re-reviewed (D-10)${notCarried.length > 0 ? `. Repair ${r.id} does not read as done while a reopen was not carried out: a new repair on the user's words (mp pm repair … --again) or a re-plan routes that work` : ''}`,
    detail: { repair: r.id, dplan: eff.dplan, added: added.map((t) => t.id), reopen, ...(changed.length > 0 ? { changed: changed.map((t) => t.id) } : {}), skipped, ...(notCarried.length > 0 ? { notCarried } : {}), orderChanges: mc.orderChanges },
  });
}

/**
 * One entry of the repair card's accepted work, from its task line: the product, the attempt it is
 * accepted at, the paths it changed and (4.4, F3) its commit, which `mp seat <id> checkout --product`
 * serves. Built alike when the step is queued and when it is claimed (F5, seat/cards/refresh.ts).
 */
export function acceptedEntry(task: string, events: Parameters<typeof lineAcceptance>[0], product: string, commit: string | undefined): ArchitectRepairCard['accepted'][number] {
  const b = events.filter((e) => e.event === 'product').map((e) => e.body as { object: string; changedPaths: string[]; commit?: string }).find((x) => x.object === product);
  const c = commit ?? b?.commit;
  return { task, product, attempt: lineAcceptance(events).k, changedPaths: [...(b?.changedPaths ?? [])], ...(c !== undefined ? { commit: c } : {}) };
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
    accepted.push(acceptedEntry(t.id, events, p, (await objectRecord(ctx, p))?.source?.commit));
  }
  // the owners of the paths the repair is about: a task's accepted change, else none
  const about = r.about?.kind === 'task' ? accepted.find((x) => x.task === r.about!.id)?.changedPaths ?? [] : [];
  const owners = (await pathOwners(ctx, about)).map((o) => ({ path: o.path, owners: o.owners.map((x) => ({ task: x.task, product: x.product, attempt: x.attempt, current: x.current })) }));
  const constraints = await currentConstraints(ctx);
  // 4.4 (G3, F1): the instructions addressed to this repair or to the task it is about in full, the rest as an index
  const addressed = addressedForPlanning(constraints, ctx.mission, { repair: r.id, ...(r.about?.kind === 'task' ? { about: r.about.id } : {}) });
  // 4.4 (G4): the questions this repair's Architect asked, and the answers that came back
  const answers = (await attemptsOf(ctx, r.id)).flatMap((x) => (x.answered !== undefined ? [{ question: x.answered.question, answer: x.answered.answer, by: x.answered.by }] : []));
  // 4.4 (G4, G5): the open items the repair is for, still open, for the Architect to give to tasks
  const openItems = (r.openItems ?? []).length === 0 ? [] : takenItems(await ctx.ports.ledger.events({ mission: ctx.mission }), r.openItems);
  const card: ArchitectRepairCard = {
    ...cardBase(ctx, task, {
      duties: `Turn repair ${r.id} into the least work that fixes it: reopen the tasks whose accepted work causes it, change the card of a task with no accepted product when the repair is about its card, and add tasks only for work no existing task owns. A task with an accepted product keeps its card. Only the program's mechanical checks follow (no Calibrator, no feasibility review).`,
      constraints: planningConstraints(constraints, ctx.mission),
    }),
    ...addressedIndexOf(addressed.index, addressed.full),
    ...(answers.length > 0 ? { answers } : {}),
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
    materials: [repairPlanMaterial((d) => ctx.ports.ledger.content.put(d), eff.dplan, plan)],
    ...(openItems.length > 0 ? { openItems } : {}),
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
