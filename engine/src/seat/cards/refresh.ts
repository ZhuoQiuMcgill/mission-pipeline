// Claim-time selection is owned by the queue-time builders; refresh adds no seat context.
import type { BaseRecord, ObjectVersionRecord, ProofUnitRecord, ListRef } from '../../common/records.ts';
import { predecessorMaterials, predecessorsFrom, withPredecessorMaterials } from '../../flow/exploration/predecessors.ts';
import { decidingViews, labelStatus } from '../../evaluator/index.ts';
import { changedBoundLines, reviewInputVersions, changedPlanningInputs, type PlanningInputs, auditBasisTexts, auditPositionInputs, auditNodeConstraints, auditChainInputs, contractLines, objectConstraints, withdrawnPlanReason } from './inputs.ts';
import { resolveBases, resolveConstraints, resolveItems } from '../../memory/domain/constraints.ts';
import { factById, flowEvents, flowMissions, recordsByKind, loopState, type Db } from '../../memory/index.ts';
import type { DataStore } from '../../memory/data.ts';
import { taskCardHash, taskLineage } from '../../flow/execution.ts';
import { DetailedPlanDoc, PmPlanDoc, amendedPlan, latestEffectiveOf, type DetailedTask, type StoredDetailedPlan } from '../../flow/plandoc.ts';
import type { EffectiveBody } from '../../flow/planning.ts';
import type { FlowEvent } from '../../flow/ports.ts';
import type { EscalationBody } from '../../flow/secretary.ts';
import { ProcessError } from '../../process/errors.ts';
import type { TaskSpecDoc } from '../../process/ports.ts';
import { constraintsForTask, taskDecisionQuotes, taskReferencePlan, taskRequirementItems, reviewerDecisionQuotes, secretaryInputs, secretaryRoundInputs, planInEffect, productionDisputed, planningConstraints } from './dynamic.ts';
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

function pages<T extends { revision: number }>(read: (after: number) => readonly T[]): T[] {
  const out: T[] = [];
  let after = 0;
  for (;;) { const rows = read(after); if (rows.length === 0) return out; out.push(...rows); after = rows.at(-1)!.revision; }
}

export function refreshDispatchCard(db: Db, data: DataStore, spec: TaskSpecDoc): TaskSpecDoc {
  const card = structuredClone(spec.card) as DispatchCard;
  // Exploration definition inputs stay fixed. Its review constraints (§9.5) and the materials of the
  // explorations planned before it are selected below. Blind cards exclude intent (§4.3).
  switch (card.seat) {
    case 'researcher-reader':
    case 'constructor-experiment':
    // a repair's Architect step: its plan inputs are fixed at queue time; the flow discards a hand-back on a plan no longer in effect
    case 'architect-repair':
      return spec;
    case 'researcher-author':
    case 'researcher-interpreter':
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
  switch (card.seat) {
    case 'researcher-author':
    case 'researcher-interpreter':
      card.materials = withPredecessorMaterials(card.materials, predecessors(card.exploration.id, card.seat === 'researcher-author'));
      break;
    case 'crititor':
    case 'stabilizer': {
      card.materials = withPredecessorMaterials(card.materials, predecessors(card.exploration.id, false));
      if (card.binding === null || card.target === null) break;
      const obj = object(card.target);
      if (obj === undefined) break;
      const input = objectConstraints(constraints, obj);
      card.binding.constraints = data.putList(input.checks);
      card.constraints = [...card.constraints.filter((c) => c.kind !== 'object'), ...input.list];
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
        const product = events.find((e) => e.line === `task:${task!.id}` && ((e.event === 'product' && (e.body as { object: string }).object === card.target) || (e.event === 'rebind' && (e.body as { product: string }).product === card.target)))?.body as { k: number } | undefined;
        if (product !== undefined) card.decisionQuotes = reviewerDecisionQuotes(mission, items, events, task, constraints, product.k, taskReferencePlan(events, fixed));
      }
      break;
    }
    case 'secretary': {
      const e = events.find((e) => e.line === 'secretary' && e.event === 'escalation' && e.key === card.request.id)?.body as EscalationBody | undefined;
      if (e === undefined) throw new ProcessError('NOT_READY', `Missing escalation ${card.request.id}; rebuild the step.`);
      const round = secretaryRoundInputs(e, events);
      if (round.esc.task !== spec.task) throw new ProcessError('NOT_READY', `Secretary step ${spec.task} was superseded; run mp pm next.`);
      Object.assign(card, secretaryInputs(mission, round.esc, items, constraints, events, task, !loopState(db, card.request.lineage, 'env-retry').secretaryGrantUsed, (text) => data.put(text)));
      break;
    }
    case 'calibrator-1':
    case 'calibrator-2':
    case 'architect-feasibility':
    case 'architect-decompose': {
      // the Architect's card shows the constraints in force (4.1.2, item 7), by the queue-time builder's selection
      if (card.seat === 'architect-decompose') card.constraints = planningConstraints(constraints, mission);
      const obj = card.seat === 'architect-decompose' ? undefined : object(card.target);
      const withdrawn = obj === undefined ? null : withdrawnPlanReason(obj, ix);
      if (withdrawn !== null) throw new ProcessError('NOT_READY', withdrawn);
      const inputs = events.filter((e) => e.line === 'plan' && e.event === 'review-inputs' && (e.body as PlanningInputs).task === spec.task).at(-1)?.body as PlanningInputs | undefined;
      const boundChanged = 'binding' in card && changedBoundLines(ix, reviewInputVersions(data.getList(card.binding.bases as ListRef), data.getList(card.binding.constraints as ListRef))).length > 0;
      if (inputs === undefined || boundChanged || changedPlanningInputs(inputs, ix, items, constraints, obj).length > 0) throw new ProcessError('NOT_READY', `Review inputs changed for ${spec.task}; run mp pm next to rebuild the step.`);
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
