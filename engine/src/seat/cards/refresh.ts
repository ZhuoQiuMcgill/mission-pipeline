// Claim-time selection is owned by the queue-time builders; refresh adds no seat context.
import { liveSecretary } from '../../memory/resident.ts';
import type { BaseRecord, ObjectVersionRecord, ProofUnitRecord, ListRef } from '../../common/records.ts';
import type { BasisIndex } from '../../flow/context.ts';
import { predecessorMaterials, predecessorsFrom, withPredecessorMaterials } from '../../flow/exploration/predecessors.ts';
import { decidingViews, labelStatus } from '../../evaluator/index.ts';
import { changedBoundLines, reviewInputVersions, changedPlanningInputs, type PlanningInputs, auditBasisTexts, auditPositionInputs, auditNodeConstraints, auditChainInputs, contractLines, objectConstraints, withdrawnPlanReason } from './inputs.ts';
import { resolveBases, resolveConstraints, resolveItems } from '../../memory/domain/constraints.ts';
import { factById, flowEvents, flowMissions, recordsByKind, loopState, type Db } from '../../memory/index.ts';
import type { DataStore } from '../../memory/data.ts';
import { attemptPast, lineAcceptance, ownersOfPaths, planData, productAttempt, targetConstructor, taskCardHash, taskLineage } from '../../flow/execution.ts';
import { acceptedEntry } from '../../flow/repair.ts';
import { CONSTRUCTOR_CLAIMS_MATERIAL, FEASIBILITY_REPORT_MATERIAL, PREVIOUS_HANDBACK_MATERIAL, PREVIOUS_REVIEW_MATERIAL, attach, attemptOfPlan, claimsMaterial, type Attached, feasibilityReportMaterial, previousHandBackMaterial, previousReviewMaterial, returnedFeasibilityOf, sourceAt, type HandBackReaders } from '../../flow/handbackMaterials.ts';
import { repairPlanMaterial } from './architect.ts';
import { cardQuestions, taskQuestions, withoutAnswers } from '../../flow/openItems.ts';
import type { MaterialRef } from './common.ts';
import { DetailedPlanDoc, PmPlanDoc, amendedPlan, latestEffectiveOf, type DetailedTask, type StoredDetailedPlan } from '../../flow/plandoc.ts';
import type { EffectiveBody } from '../../flow/planning.ts';
import type { FlowEvent } from '../../flow/ports.ts';
import { secretaryOptions, type EscalationBody } from '../../flow/secretary.ts';
import { ProcessError } from '../../process/errors.ts';
import type { TaskSpecDoc } from '../../process/ports.ts';
import { constraintsForExploration, constraintsForTask, taskDecisionQuotes, taskReferencePlan, taskRequirementItems, reviewerDecisionQuotes, secretaryInputs, secretaryRoundInputs, planInEffect, productionDisputed, planningConstraints, addressedForPlanning, planReviewInstructions, repairsOfTaskWork, writtenForTask } from './dynamic.ts';
import { repairRef, type RepairBody } from '../../flow/plandoc.ts';
import type { ConstructorCard, ReviewerCard } from '../card.ts';
import type { Calibrator1Card, Calibrator2Card } from './calibrator.ts';
import type { ArchitectDecomposeCard, ArchitectFeasibilityCard, ArchitectRepairCard } from './architect.ts';
import type { SecretaryCard } from './secretary.ts';
import type { AuditNodeCard, AuditChainCard } from './auditor.ts';
import type { AuthorCard, ReaderCard, InterpreterCard } from './researcher.ts';
import type { ExperimentCard } from './experiment.ts';
import type { CrititorCard } from './crititor.ts';
import type { StabilizerCard } from './stabilizer.ts';

type DispatchCard = ConstructorCard | ReviewerCard | Calibrator1Card | Calibrator2Card | ArchitectDecomposeCard | ArchitectFeasibilityCard | ArchitectRepairCard | SecretaryCard | AuditNodeCard | AuditChainCard | AuthorCard | ReaderCard | InterpreterCard | ExperimentCard | CrititorCard | StabilizerCard;

/** A card's constraint that is a project constraint (a basis line of `mp pm constraint`), not an exploration definition's own. */
function projectConstraint(ix: BasisIndex, id: string): boolean {
  const kind = ix.records.get(ix.current.get(id) ?? '')?.basisKind;
  return kind === 'constraint' || kind === 'instruction';
}

function pages<T extends { revision: number }>(read: (after: number) => readonly T[]): T[] {
  const out: T[] = [];
  let after = 0;
  for (;;) { const rows = read(after); if (rows.length === 0) return out; out.push(...rows); after = rows.at(-1)!.revision; }
}

/**
 * What a claim gives the refresh besides the memory (process/pm.ts, in the claim's write): the readers
 * of the recorded hand-backs (4.4, F3: a material a card queued by 4.3 lacks is filled in from them), and
 * the starts of a repair card's unpinned accepted products, checked by the flow's own resolver before
 * the write (F5, p3-3: absent when the caller could not check them).
 */
export interface ClaimInputs extends Partial<HandBackReaders> {
  readonly starts?: ReadonlyMap<string, boolean>;
}

/** 4.4 (F5): the refusal detail of a claim whose repair card found an unpinned accepted product its caller did not check: check again and claim again. */
export const STARTS_CHANGED = 'starts-changed';

export function refreshDispatchCard(db: Db, data: DataStore, spec: TaskSpecDoc, o: ClaimInputs = {}): TaskSpecDoc {
  const card = structuredClone(spec.card) as DispatchCard;
  // Exploration definition inputs stay fixed. Its project constraints (§9.5) and the materials of the
  // explorations planned before it are selected below. Blind cards exclude intent (§4.3).
  switch (card.seat) {
    case 'architect-repair':
    case 'researcher-author':
    case 'researcher-reader':
    case 'researcher-interpreter':
    case 'constructor-experiment':
    case 'crititor':
    case 'stabilizer':
    case 'constructor':
    case 'reviewer':
    case 'secretary':
    case 'calibrator-1':
    case 'calibrator-2':
    case 'architect-feasibility':
    case 'architect-decompose':
    case 'auditor-node':
    case 'auditor-chain':
      break;
    default: {
      const unknown: never = card;
      throw new ProcessError('NOT_READY', `Unknown seat kind ${(unknown as { seat: string }).seat}; rebuild the step.`);
    }
  }
  const mission = spec.mission;
  const events = pages((after) => flowEvents(db, { mission, after })).map((e): FlowEvent => ({ ...e, body: JSON.parse(data.text(e.body)) }));
  const constraintEvents = [...new Set([mission, ...flowMissions(db)])].flatMap((m) => m === mission ? events : pages((after) => flowEvents(db, { mission: m, after })).map((e): FlowEvent => ({ ...e, body: JSON.parse(data.text(e.body)) }))).sort((a, b) => a.revision - b.revision);
  const records = pages((after) => recordsByKind(db, { kinds: ['basis.version', 'basis.withdrawn'], after })).map((r) => r.record as BaseRecord);
  const ix = resolveBases(records);
  const items = resolveItems(ix, events);
  const constraints = resolveConstraints(ix, constraintEvents);
  const object = (id: string) => factById(db, 'object.version', id)?.record as ObjectVersionRecord | undefined;
  // the start resolver's rule that needs no git (delivery/candidate.ts startHolds): a version with no recorded prerequisite starts where it should
  const noRecordedPrerequisites = (id: string): boolean => { const r = object(id); return r !== undefined && data.getList(r.prerequisites).length === 0; };
  // what the explorations planned before an exploration handed on, as they stand now (flow/exploration/predecessors.ts: the author must read them; never on a blind card)
  const predecessors = (x: string, mustRead: boolean) => predecessorMaterials(predecessorsFrom(events, (h) => data.text(h), x), { get: (h) => data.text(h), put: (d) => data.put(d) }, mustRead);
  // The task's card in force: its latest spec. A plan that keeps the card writes no newer spec, so the
  // spec's plan can be older than the plan in effect; only the card is read from it, never plan-level inputs.
  let task: DetailedTask | undefined;
  let cardHash: string | undefined;
  for (const e of events.filter((e) => e.line.startsWith('task:') && e.event === 'spec').toReversed()) {
    const id = e.line.slice('task:'.length);
    const subject = card.seat === 'secretary' ? card.request.subject : undefined;
    if (taskLineage(mission, id) !== spec.lineage && subject !== `task:${id}`) continue;
    const dplan = (e.body as { dplan: string }).dplan;
    const obj = object(dplan);
    // the plan as it is in effect: its version's tasks plus the tasks repairs added (4.1.2, D-10)
    if (obj !== undefined) task = amendedPlan(DetailedPlanDoc.parse((JSON.parse(data.text(obj.content)) as StoredDetailedPlan).plan), latestEffectiveOf<EffectiveBody>(events, dplan)?.amendments).tasks.find((t) => t.id === id);
    cardHash = (e.body as { hash: string }).hash;
    break;
  }
  const lines = new Map<string, FlowEvent[]>();
  for (const e of events) {
    if (!e.line.startsWith('task:')) continue;
    const l = lines.get(e.line);
    if (l === undefined) lines.set(e.line, [e]);
    else l.push(e);
  }
  const lineOf = (id: string): FlowEvent[] => lines.get(`task:${id}`) ?? [];
  // 4.4 (F3): a material the card lacks (it was queued by 4.3, or its hand-back was not readable then), from the recorded hand-backs
  const put = (d: string): string => data.put(d);
  const readers = o.handBack !== undefined && o.leaf !== undefined ? { handBack: o.handBack, leaf: o.leaf } : null;
  type WithMaterials = { materials?: MaterialRef[] | undefined; materialsNotAttached?: string[] | undefined };
  const lacks = (c: WithMaterials, id: string): boolean => readers !== null && !(c.materials ?? []).some((m) => m.id === id) && !(c.materialsNotAttached ?? []).some((l) => l.startsWith(`[${id}] `));
  // a material that cannot be built or stored never refuses the claim: the card carries one line in its place
  const plus = (c: WithMaterials, id: string, task: string, build: () => Attached | null): void => {
    let m: Attached | null;
    try {
      m = build();
    } catch (e) {
      const why = (e as { code?: unknown }).code;
      m = { notAttached: `[${id}] could not be attached${typeof why === 'string' ? ` (${why})` : ''}; read the hand-back of step ${task}` };
    }
    if (m === null) return;
    const a = attach([m], c);
    if (a.materials !== undefined) c.materials = a.materials;
    if (a.materialsNotAttached !== undefined) c.materialsNotAttached = a.materialsNotAttached;
  };
  // 4.4 (G3): the repairs a task's work answers and what was written for it, by the queue-time builder's
  // derivation (a card queued by 4.3 gets them here); `k` null: the attempt is not known, the card's repairs stand
  const writtenFor = (c: ConstructorCard | ReviewerCard, t: DetailedTask, k: number | null): void => {
    const ids = k === null ? (c.repairs ?? []).map((r) => r.id) : repairsOfTaskWork(mission, planInEffect(events)?.amendments, t.id, lineOf(t.id), events.filter((e) => e.line === 'secretary'), events.filter((e) => e.line === 'repairs'), k);
    const refs = events.filter((e) => e.line === 'repairs' && e.event === 'repair' && ids.includes(e.key)).map((e) => repairRef(e.body as RepairBody));
    if (refs.length > 0) c.repairs = refs;
    else delete c.repairs;
    delete c.addressed;
    delete c.architectNotes;
    delete c.earlierAnswers;
    Object.assign(c, writtenForTask(constraints, events, mission, t.id, ids));
  };
  // 4.4 (G3, F1): an Architect's card prints the addressed instructions of the repair in hand (or its task) in full, the rest as an index
  const planningAddressed = (c: ArchitectRepairCard | ArchitectDecomposeCard, inHand: { repair?: string; about?: string }): void => {
    const a = addressedForPlanning(constraints, mission, inHand);
    delete c.addressed;
    delete c.addressedIndex;
    if (a.full.length > 0) c.addressed = a.full;
    if (a.index.length > 0) c.addressedIndex = a.index;
  };
  const feasibility = (c: WithMaterials, dplan: string): void => {
    const r = readers === null ? null : returnedFeasibilityOf(events, attemptOfPlan(events, dplan));
    if (r !== null) plus(c, FEASIBILITY_REPORT_MATERIAL, r.review, () => feasibilityReportMaterial(put, sourceAt(readers!, r.review), r));
  };
  switch (card.seat) {
    case 'architect-repair': {
      // 4.4 (F5, #53, #68): rebuilt from the planning inputs in force at the claim, by the queue-time
      // builder's own derivations: the constraints, the plan in effect with the repairs decided since, the
      // accepted work (with its commits) and the owners of the paths the repair is about.
      const eff = planInEffect(events);
      if (eff === undefined) break;
      // a new plan in effect is the flow's (it cancels this step and starts the repair's next attempt): as a
      // plan-review card whose inputs changed, the claim is refused and the flow's next pass rebuilds the step
      if (eff.dplan !== card.dplan) throw new ProcessError('NOT_READY', `Repair step ${spec.task} was queued on ${card.dplan}, and ${eff.dplan} took effect since; run mp pm next to rebuild the step.`);
      const stored = object(eff.dplan);
      if (stored === undefined) break;
      const plan = amendedPlan(DetailedPlanDoc.parse((JSON.parse(data.text(stored.content)) as StoredDetailedPlan).plan), eff.amendments);
      const queued = new Set(card.accepted.map((a) => a.product));
      card.constraints = planningConstraints(constraints, mission);
      planningAddressed(card, { repair: card.repair.id, ...(card.repair.about?.startsWith('task ') === true ? { about: card.repair.about.slice('task '.length) } : {}) });
      card.plan = plan;
      card.accepted = plan.tasks.flatMap((t) => {
        const sel = lineAcceptance(lineOf(t.id));
        if (sel.product === null) return [];
        // an unpinned start is the flow's resolver's to check (git): checked before this write (o.starts), or by
        // the queue-time builder (on the card); without either, the resolver's own rule for a start with no
        // recorded prerequisite (it holds); a product its caller did not check sends the claim back to check it
        if (!sel.pinned) {
          const checked = o.starts?.get(sel.product);
          const holds = checked ?? (queued.has(sel.product) ? true : o.starts !== undefined ? undefined : noRecordedPrerequisites(sel.product));
          if (holds === undefined) throw new ProcessError('NOT_READY', `nothing was claimed: the accepted work of ${t.id} changed while the claim of ${spec.task} checked it; run the dispatch again`, { detail: { [STARTS_CHANGED]: true } });
          if (!holds) return [];
        }
        return [acceptedEntry(t.id, lineOf(t.id), sel.product, object(sel.product)?.source?.commit)];
      });
      const about = card.repair.about?.startsWith('task ') === true ? card.accepted.find((a) => a.task === card.repair.about!.slice('task '.length))?.changedPaths ?? [] : [];
      const tasks = new Set(events.filter((e) => e.line === 'plan' && e.event === 'effective').flatMap((e) => (e.body as EffectiveBody).tasks));
      card.owners = ownersOfPaths(new Map([...tasks].map((id) => [id, lineOf(id)])), about).map((o) => ({ path: o.path, owners: o.owners.map((x) => ({ task: x.task, product: x.product, attempt: x.attempt, current: x.current })) }));
      card.materials = [repairPlanMaterial((d) => data.put(d), eff.dplan, plan), ...(card.materials ?? []).filter((m) => m.id !== 'plan')];
      break;
    }
    case 'researcher-author':
    case 'researcher-interpreter':
    case 'researcher-reader':
    case 'constructor-experiment': {
      // as the queue-time builder (flow/exploration/cards.ts): the definition's own, then the project's in force (a blind card names no exploration)
      const exploration = card.seat === 'researcher-author' || card.seat === 'researcher-interpreter' ? card.exploration.id : null;
      card.constraints = [...card.constraints.filter((c) => !projectConstraint(ix, c.id)), ...constraintsForExploration(constraints, card.seat, mission, exploration)];
      if (card.seat === 'researcher-author' || card.seat === 'researcher-interpreter') card.materials = withPredecessorMaterials(card.materials, predecessors(card.exploration.id, card.seat === 'researcher-author'));
      break;
    }
    case 'crititor':
    case 'stabilizer': {
      const own = card.constraints.filter((c) => !projectConstraint(ix, c.id));
      let objects = card.constraints.filter((c) => c.kind === 'object' && projectConstraint(ix, c.id));
      const obj = card.binding === null || card.target === null ? undefined : object(card.target);
      if (obj !== undefined && card.binding !== null) {
        const input = objectConstraints(constraints, obj);
        card.binding.constraints = data.putList(input.checks);
        objects = input.list;
      }
      card.constraints = [...own, ...objects, ...constraintsForExploration(constraints, card.seat, mission, card.exploration.id).filter((c) => c.kind === 'instruction')];
      card.materials = withPredecessorMaterials(card.materials, predecessors(card.exploration.id, false));
      break;
    }
    case 'constructor': {
      // Production is built under the plan in effect (taskReferencePlan, as submitConstructor queued it), so
      // ruling 3 is decided under that plan's PM plan and dependency graph, by the flow gate's own decision
      // (productionDisputed, as contestedProduction). A step queued in fast mode never passed the stable
      // gate, so it is checked under a stable plan in effect too. A card the plan in effect no longer holds
      // is superseded: the flow's next pass cancels the step (re-planned or dropped).
      const eff = planInEffect(events);
      const stored = eff === undefined ? undefined : object(eff.dplan);
      const plan = stored === undefined || eff === undefined ? undefined : amendedPlan(DetailedPlanDoc.parse((JSON.parse(data.text(stored.content)) as StoredDetailedPlan).plan), eff.amendments);
      const current = task === undefined ? undefined : plan?.tasks.find((t) => t.id === task!.id);
      if (eff === undefined || plan === undefined || current === undefined || taskCardHash(current) !== cardHash) throw new ProcessError('NOT_READY', `Constructor step ${spec.task} was superseded: the plan in effect${eff === undefined ? '' : ` (${eff.dplan})`} does not hold its card; run mp pm next.`);
      task = current;
      if (eff.mode === 'fast' || spec.mode === 'fast') {
        const pm = object(eff.pmPlan);
        const cal1 = events.filter((e) => e.line === 'plan' && e.event === 'cal1').map((e) => e.body as { judgment: string | null; contested: string[] });
        if (labelStatus(db).recomputing || pm === undefined || productionDisputed(mission, items, PmPlanDoc.parse(JSON.parse(data.text(pm.content))), decidingViews(db, [eff.pmPlan]).views.get(eff.pmPlan), cal1, plan, task)) throw new ProcessError('NOT_READY', `Task ${task.id} waits: its production inputs include contested or negated elements, or their labels are recomputing. It can be dispatched once the dispute is ruled; run mp pm next.`);
      }
      const applicable = constraintsForTask(constraints, task, mission);
      card.constraints = applicable.map((c) => ({ id: c.line, text: c.text, kind: c.kind }));
      card.decisionQuotes = taskDecisionQuotes(items, events, task, applicable, taskReferencePlan(events));
      card.requirementItems = taskRequirementItems(items, task);
      // 4.4 (F3): the data formats and storage of the plan in effect, which the card is built under
      delete card.dataFormats;
      delete card.storage;
      Object.assign(card, planData(plan));
      // 4.4 (F3): a later attempt's past, when the card lacks it
      const k = (lineOf(task.id).find((e) => e.event === 'dispatched' && e.key === spec.task)?.body as { k?: number } | undefined)?.k;
      writtenFor(card, task, k ?? null);
      // 4.4 (F4; G5): the questions as they stand at the claim: an answer given since the step was queued reaches this card
      const qs = k === undefined ? [] : taskQuestions(events, task.id, k);
      card.decisionQuotes = withoutAnswers(card.decisionQuotes, qs);
      if (qs.length > 0) card.questions = cardQuestions(qs);
      else delete card.questions;
      const was = k === undefined ? null : attemptPast(lineOf(task.id), k);
      const review = was?.review ?? null;
      if (was !== null && review !== null && lacks(card, PREVIOUS_REVIEW_MATERIAL)) plus(card, PREVIOUS_REVIEW_MATERIAL, review, () => previousReviewMaterial(put, sourceAt(readers!, review), { review, attempt: was.attempt }));
      if (was !== null && lacks(card, PREVIOUS_HANDBACK_MATERIAL)) plus(card, PREVIOUS_HANDBACK_MATERIAL, was.constructor, () => previousHandBackMaterial(put, sourceAt(readers!, was.constructor), { attempt: was.attempt }));
      break;
    }
    case 'reviewer': {
      const obj = object(card.target);
      const fixed = obj?.reviews.find((r) => r.review === 'reviewer');
      if (obj === undefined || (fixed === undefined && task === undefined)) break;
      const previous = data.getList(card.binding.bases as ListRef);
      const versions = contractLines(obj.mission, task!, ix, fixed).map((line) => ix.current.get(line));
      const standardChanged = changedBoundLines(ix, previous).some((line) => ix.records.get(ix.current.get(line)!)?.basisKind === 'standard');
      if (!standardChanged && versions.every((v) => v !== undefined)) card.binding.bases = data.putList([...new Set(versions as string[])].sort());
      const input = objectConstraints(constraints, obj);
      card.binding.constraints = data.putList(input.checks);
      card.constraints = [...input.list, ...(task === undefined ? [] : constraintsForTask(constraints, task, mission).filter((c) => c.kind === 'instruction').map((c) => ({ id: c.line, text: c.text, kind: c.kind })))];
      if (task !== undefined) {
        const attempt = productAttempt(events.filter((e) => e.line === `task:${task!.id}`), card.target);
        if (attempt !== null) card.decisionQuotes = reviewerDecisionQuotes(mission, items, events, task, constraints, attempt, taskReferencePlan(events, fixed));
        writtenFor(card, task, attempt);
        // 4.4 (F4): the questions of the attempt under review and their answers, as they stand at the claim
        const qs = attempt === null ? [] : taskQuestions(events, task.id, attempt);
        card.decisionQuotes = withoutAnswers(card.decisionQuotes, qs);
        if (qs.length > 0) card.questions = cardQuestions(qs);
        else delete card.questions;
      }
      // 4.4 (F3): the data formats and storage of the plan the target's review contract relies on
      const relied = taskReferencePlan(events, fixed);
      const contract = relied === undefined ? undefined : object(relied);
      delete card.dataFormats;
      delete card.storage;
      Object.assign(card, planData(contract === undefined ? null : (JSON.parse(data.text(contract.content)) as StoredDetailedPlan).plan));
      // 4.4 (F3, E-4): the Constructor's claims, when the card lacks them
      const made = task === undefined ? null : targetConstructor(lineOf(task.id), card.target);
      if (made !== null && lacks(card, CONSTRUCTOR_CLAIMS_MATERIAL)) plus(card, CONSTRUCTOR_CLAIMS_MATERIAL, made.constructor, () => claimsMaterial(put, sourceAt(readers!, made.constructor), { task: task!.id, attempt: made.attempt }));
      break;
    }
    case 'secretary': {
      const e = events.find((e) => e.line === 'secretary' && e.event === 'escalation' && e.key === card.request.id)?.body as EscalationBody | undefined;
      if (e === undefined) throw new ProcessError('NOT_READY', `Missing escalation ${card.request.id}; rebuild the step.`);
      const round = secretaryRoundInputs(e, events);
      if (round.esc.task !== spec.task) throw new ProcessError('NOT_READY', `Secretary step ${spec.task} was superseded; run mp pm next.`);
      delete card.addressed;
      Object.assign(card, secretaryInputs(mission, round.esc, items, constraints, events, task, !loopState(db, card.request.lineage, 'env-retry').secretaryGrantUsed, (text) => data.put(text)));
      card.options = secretaryOptions(round.esc, liveSecretary(db) !== null);
      break;
    }
    case 'calibrator-1':
    case 'calibrator-2':
    case 'architect-feasibility':
    case 'architect-decompose': {
      // the Architect's card shows the constraints in force (4.1.2, item 7), by the queue-time builder's selection
      if (card.seat === 'architect-decompose') {
        card.constraints = planningConstraints(constraints, mission);
        planningAddressed(card, {});
      }
      // 4.4 (G3, F1): a plan review gets the instructions whose task types name its plan; its object constraints stay as bound
      if (card.seat !== 'architect-decompose') card.constraints = [...card.constraints.filter((c) => c.kind === 'object'), ...planReviewInstructions(constraints, mission, card.seat === 'calibrator-1' ? 'pm-plan' : 'detailed-plan')];
      const obj = card.seat === 'architect-decompose' ? undefined : object(card.target);
      const withdrawn = obj === undefined ? null : withdrawnPlanReason(obj, ix);
      if (withdrawn !== null) throw new ProcessError('NOT_READY', withdrawn);
      const inputs = events.filter((e) => e.line === 'plan' && e.event === 'review-inputs' && (e.body as PlanningInputs).task === spec.task).at(-1)?.body as PlanningInputs | undefined;
      const boundChanged = 'binding' in card && changedBoundLines(ix, reviewInputVersions(data.getList(card.binding.bases as ListRef), data.getList(card.binding.constraints as ListRef))).length > 0;
      if (inputs === undefined || boundChanged || changedPlanningInputs(inputs, ix, items, constraints, obj).length > 0) throw new ProcessError('NOT_READY', `Review inputs changed for ${spec.task}; run mp pm next to rebuild the step.`);
      // 4.4 (F3): a revision's and a re-review's previous feasibility report, when the card lacks it
      if (card.seat === 'architect-feasibility' && lacks(card, FEASIBILITY_REPORT_MATERIAL)) feasibility(card, card.target);
      if (card.seat === 'architect-decompose' && card.revision !== null && lacks(card, FEASIBILITY_REPORT_MATERIAL)) feasibility(card, card.output.object);
      break;
    }
    case 'auditor-node': {
      const target = card.target.id;
      const obj = object(target);
      const unit = factById(db, 'proof.unit', target)?.record as ProofUnitRecord | undefined;
      const bound = obj !== undefined ? [obj] : unit === undefined ? [] : data.getList(unit.members).flatMap((m) => { const o = object(m); return o === undefined ? [] : [o]; });
      if (bound.length === 0 || (unit !== undefined && bound.length !== data.getList(unit.members).length)) throw new ProcessError('NOT_READY', `Missing audit objects for ${target}.`);
      const texts = auditBasisTexts(ix, constraintEvents, { get: (hash) => data.text(hash), getList: (hash) => data.getList(hash) }, object);
      card.positions = card.positions.map((p) => {
        const contract = (obj?.reviews ?? unit?.reviews ?? []).find((c) => c.review === p.review);
        if (contract === undefined) throw new ProcessError('NOT_READY', `Missing audit contract ${target}/${p.review}.`);
        const input = auditPositionInputs(contract, bound, ix, texts, constraints);
        if ('missingBasis' in input) throw new ProcessError('NOT_READY', `Missing audit basis ${input.missingBasis}; rebuild the audit.`);
        return { ...p, bases: input.bases, constraints: input.constraints, binding: { ...p.binding, bases: data.putList(input.versions), constraints: data.putList(input.checks) } };
      });
      card.constraints = auditNodeConstraints(card.positions);
      break;
    }
    case 'auditor-chain': {
      const obj = object(card.chain.object);
      const req = events.find((e) => e.line === `audit:${card.legalization}` && e.event === 'requested')?.body as { words: string } | undefined;
      if (obj === undefined || req === undefined) throw new ProcessError('NOT_READY', `Missing chain inputs for ${card.chain.object}.`);
      const input = auditChainInputs(items, ix, constraints, obj, req.words);
      card.quotes = input.quotes;
      card.constraints = input.list;
      card.binding.bases = data.putList(input.bases);
      card.binding.constraints = data.putList(input.checks);
      break;
    }
    default: {
      const unknown: never = card;
      throw new ProcessError('NOT_READY', `Unknown seat kind ${(unknown as { seat: string }).seat}.`);
    }
  }
  return { ...spec, card };
}
