// The Architect's two cards (design 3.4 decomposition, 3.6 feasibility review, 7.1, 10.1).
//
// Decomposition: a read-only seat on the program's project snapshot (no command execution; the
// git history and past run durations are exported into the card). It turns an approved PM plan
// into a detailed plan: reused interfaces with their locations, new interfaces each with the
// line "searched these existing interfaces, and why none was reused" (maintainer: required),
// module write scopes, the task list (interface definitions, one implementation task per
// module, one integration task), scheduling dependencies, estimates with their basis,
// provenance of every element, and the risks a read-only look cannot settle. The hand-back
// becomes the detailed plan version (an object, 10.1) whose required reviews are calibrator-2,
// plus feasibility when the program's rule says so (3.6).
//
// Feasibility review: another read-only instance, which sees the detailed plan, the snapshot and
// the run history but not the decomposer's reasoning. Its verdict becomes the judgment on the
// plan version's feasibility position.

import { z } from 'zod';
import type { ContentHash, JudgmentId, MissionId, ObjectVersionId } from '../../common/ids.ts';
import type { BaseRecord, JudgmentRecord, ListRef, ObjectVersionRecord, ReviewContract } from '../../common/records.ts';
import { canonicalJson } from '../../common/hash.ts';
import { validateRecord } from '../../common/validate.ts';
import { DetailedPlanDoc, DetailedTask, feasibilityRequired, planIdProblems, type StoredDetailedPlan } from '../../flow/plandoc.ts';
import { Binding, Item, ReadOnlyWorkspace, TOOLS_NOTE_SNAPSHOT, commonCardFields, list, renderCommon } from './common.ts';
import { EMPTY_LIST } from './calibrator.ts';
import { registerSeatCard, type SeatCardEntry } from './registry.ts';

const Contract = z.object({ basisLines: z.array(z.string()), reliesOn: z.array(z.string()) });

const RunHistory = z.array(z.object({ task: z.string(), seat: z.string(), durationMs: z.number().int().nonnegative(), costMicros: z.number().int().nonnegative() }));

// ---------------------------------------------------------------- decomposition (3.4)

export const ArchitectDecomposeCardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('architect-decompose'),
  workspace: ReadOnlyWorkspace,
  /** Required: the approved PM plan version and its elements in this round's scope. */
  pmPlan: z.object({
    object: z.string().min(1),
    round: z.number().int().positive(),
    /** "user": a user-specified order (a direction: keep it, or report it cannot work); "free": a detail. */
    order: z.enum(['user', 'free']),
    elements: z.array(z.object({ id: z.string(), kind: z.string(), text: z.string(), after: z.array(z.string()) })).min(1),
    /** 3.10: the user's goals beyond the nearest unsettled exploration (not to be planned into tasks). */
    goalsBeyond: z.array(z.string()),
  }),
  /** Required: the requirement items the plan rests on. */
  requirementItems: z.array(Item),
  /** Explorations that have not stood yet: no task may depend on them (3.10). */
  unsettledExplorations: z.array(z.string()),
  /** Conclusions of settled structure-type explorations to plan the waiting part from (3.10). */
  explorationConclusions: z.array(z.object({ exploration: z.string(), summary: z.string() })),
  /** Exported by the program: git history and past run durations (3.4). */
  history: z.object({ gitLog: z.string(), runs: RunHistory }),
  /** A revision: the previous detailed plan and why it comes back (mechanical failures, feasibility findings, a Secretary instruction). */
  revision: z
    .object({
      previous: z.string().nullable(),
      previousPlan: DetailedPlanDoc.nullable(),
      mechanicalFailures: z.array(z.string()),
      feasibilityFindings: z.array(z.string()),
      instructions: z.array(z.string()),
    })
    .nullable(),
  /** What the program records the hand-back as (the seat never sees ids it could change). */
  output: z.object({
    object: z.string().min(1),
    predecessor: z.string().nullable(),
    path: z.string().min(1),
    calibrator2: Contract,
    feasibility: Contract,
  }),
});
export type ArchitectDecomposeCard = z.infer<typeof ArchitectDecomposeCardSchema>;

export const ArchitectDecomposeResultShape = {
  reusedInterfaces: z.array(z.object({ name: z.string(), file: z.string(), location: z.string(), provenance: z.union([z.object({ planElement: z.string() }), z.literal('architect')]) })).describe('Existing interfaces the plan reuses, with file and location.'),
  newInterfaces: z
    .array(
      z.object({
        name: z.string(),
        definition: z.string(),
        searched: z.string().describe('Required: which existing interfaces you searched, and why none was reused.'),
        provenance: z.union([z.object({ planElement: z.string() }), z.literal('architect')]),
      }),
    )
    .describe('Interfaces to create.'),
  modules: z.array(z.object({ id: z.string(), writeScope: z.array(z.string()), provenance: z.union([z.object({ planElement: z.string() }), z.literal('architect')]) })).describe('Modules and their write scopes (exact paths, "dir/**", or "**").'),
  tasks: z.array(DetailedTask).describe('Interface definition tasks, one implementation task per module, one integration task (a single-task plan keeps a full task card).'),
  risks: z.array(z.string()).describe('Risks a read-only look cannot settle.'),
};
const ArchitectDecomposeResultSchema = z.object(ArchitectDecomposeResultShape);
export type ArchitectDecomposeResult = z.infer<typeof ArchitectDecomposeResultSchema>;

// ---------------------------------------------------------------- feasibility review (3.6)

export const FEASIBILITY_CATEGORIES = [
  'recovery-path',
  'capacity',
  'estimate-basis',
  'critical-path',
  'external-dependency',
  'missing-dependency',
  'extra-dependency',
  'input-missing',
  'interface-missing',
  'wrong-version',
  'parallel-write-conflict',
  'exclusive-resource-conflict',
  'exploration-order',
  'other',
] as const;

export const ArchitectFeasibilityCardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('architect-feasibility'),
  workspace: ReadOnlyWorkspace,
  /** Required: the detailed plan version and its content. */
  target: z.string().min(1),
  review: z.literal('feasibility'),
  plan: DetailedPlanDoc,
  /** Required: past run data (3.6). */
  history: z.object({ gitLog: z.string(), runs: RunHistory }),
  /** Findings of an earlier review this plan answers (the Architect revised once). */
  earlierFindings: z.array(z.string()),
  binding: Binding,
});
export type ArchitectFeasibilityCard = z.infer<typeof ArchitectFeasibilityCardSchema>;

export const ArchitectFeasibilityResultShape = {
  findings: z
    .array(
      z.object({
        id: z.string(),
        category: z.enum(FEASIBILITY_CATEGORIES),
        severity: z.enum(['blocking', 'risk']).describe('blocking: the plan cannot work as written; risk: it can, with a stated risk.'),
        tasks: z.array(z.string()),
        detail: z.string(),
        suggestion: z.string(),
      }),
    )
    .describe('What does not work, or works only with a risk.'),
  criticalPath: z.array(z.string()).describe('Task ids on the critical path, in order.'),
  verdict: z.enum(['feasible', 'return']).describe('"return" when any finding is blocking; "feasible" otherwise (risks go to the risk list).'),
};
const ArchitectFeasibilityResultSchema = z.object(ArchitectFeasibilityResultShape);
export type ArchitectFeasibilityResult = z.infer<typeof ArchitectFeasibilityResultSchema>;

// ---------------------------------------------------------------- definitions

export const ARCHITECT_DECOMPOSE_DEFINITION = [
  'You are the Architect seat of a software pipeline, decomposition: you turn an approved PM plan into a detailed plan. You only read: you cannot run commands; the git history and past run durations are on the card.',
  TOOLS_NOTE_SNAPSHOT,
  'Hand back: the existing interfaces you reuse, with file and location; the new interfaces, each with its definition and one line saying which existing interfaces you searched and why none was reused (required); the modules and their write scopes; the tasks: interface definition tasks, one implementation task per module, one integration task that depends on every implementation task (a plan with a single task still gets a full task card, only without the interface split). Each task has its goal, acceptance standards, requirement items, write scope, files to read, interpreter, verification commands, implemented and called interfaces, scheduling dependencies (the tasks whose interfaces it needs), exclusive resources, and an estimate of duration and cost with its basis.',
  'Every element names its provenance: the PM plan element it comes from, or "architect" for your own addition. Tasks that can run in parallel must not have overlapping write scopes. Plan nothing that waits for an exploration that has not stood, and nothing for the goals beyond it. Keep a user-specified order; if it cannot work, say so in the risks instead of changing it. List the risks a read-only look cannot settle.',
  'On a revision the card says why the plan came back (mechanical failures, feasibility findings, an instruction): fix exactly that. Call submit_result once, then end your turn.',
  'Upstream: the PM plan approved by the Calibrator. Downstream: the program\'s mechanical checks, the feasibility review, then the Calibrator.',
].join('\n\n');

export const ARCHITECT_FEASIBILITY_DEFINITION = [
  'You are the Architect seat of a software pipeline, feasibility review: you check independently whether a detailed plan can work. You only read: the plan is on the card, the project snapshot and the run history are available; you do not see how the plan was made.',
  TOOLS_NOTE_SNAPSHOT,
  'Check: whether recovery paths are accepted by the existing validators; limits of memory, disk and time; whether the estimates have a basis; the critical path; whether external dependencies are available; and everything a read-only look can rule out (missing or superfluous dependencies, inputs not present, interfaces that do not exist, wrong versions, parallel write conflicts, exclusive resource conflicts, exploration order).',
  'Each finding has a category, a severity ("blocking": it cannot work as written; "risk": it can, with the stated risk), the tasks it concerns, the detail and a suggestion. Verdict "return" when any finding is blocking, "feasible" otherwise. Do not raise findings to look thorough. Call submit_result once, then end your turn.',
  'Upstream: the detailed plan. Downstream: a return goes to the Architect (decomposition) once; what is still unresolved goes to the Secretary.',
].join('\n\n');

// ---------------------------------------------------------------- render

const prov = (p: z.infer<typeof DetailedTask>['provenance']): string => (p === 'architect' ? 'architect' : `plan element ${p.planElement}`);

export function renderArchitectDecompose(c: ArchitectDecomposeCard): string {
  const r = c.revision;
  return (
    renderCommon(c) +
    `## PM plan version ${c.pmPlan.object} (round ${c.pmPlan.round}; order: ${c.pmPlan.order === 'user' ? 'specified by the user: keep it' : 'free'})\n` +
    c.pmPlan.elements.map((e) => `- [${e.id}] (${e.kind}) ${e.text}${e.after.length > 0 ? ` (waits for exploration ${e.after.join(', ')})` : ''}`).join('\n') +
    '\n\n' +
    list("The user's goals beyond this round (do not plan them)", c.pmPlan.goalsBeyond) +
    list('Requirement items', c.requirementItems.map((i) => `[${i.id}] ${i.text}`)) +
    list('Explorations that have not stood (no task may depend on them)', c.unsettledExplorations) +
    list('Settled exploration conclusions to plan from', c.explorationConclusions.map((x) => `[${x.exploration}] ${x.summary}`)) +
    `## Git history (exported)\n${c.history.gitLog || '(none)'}\n\n` +
    list('Past run durations', c.history.runs.map((h) => `${h.task} (${h.seat}): ${h.durationMs} ms, ${h.costMicros} micro-dollars`)) +
    (r === null
      ? ''
      : '## This is a revision\n' +
        (r.previous !== null ? `Previous detailed plan: ${r.previous} (its tasks: ${(r.previousPlan?.tasks ?? []).map((t) => t.id).join(', ') || 'none'})\n` : '') +
        list('Mechanical check failures to fix', r.mechanicalFailures) +
        list('Feasibility findings to answer', r.feasibilityFindings) +
        list('Instructions', r.instructions)) +
    'When done, call submit_result with the detailed plan; then end your turn.'
  );
}

export function renderArchitectFeasibility(c: ArchitectFeasibilityCard): string {
  const p = c.plan;
  return (
    renderCommon(c) +
    `## Target\nDetailed plan version ${c.target} (review position: feasibility)\n\n` +
    list('Reused interfaces', p.reusedInterfaces.map((i) => `${i.name} at ${i.file}:${i.location}`)) +
    list('New interfaces', p.newInterfaces.map((i) => `${i.name}: ${i.definition}`)) +
    list('Modules', p.modules.map((m) => `${m.id}: ${m.writeScope.join(', ')}`)) +
    list(
      'Tasks',
      p.tasks.map(
        (t) =>
          `[${t.id}] ${t.kind}${t.module !== null ? ` of ${t.module}` : ''}: ${t.goal}; writes ${t.writeScope.join(', ')}; depends on ${t.dependsOn.join(', ') || 'nothing'}; exclusive ${t.exclusive.join(', ') || 'none'}; estimate ${t.estimate.durationMs} ms / ${t.estimate.costMicros} micro-dollars (${t.estimate.basis}); verification ${t.verificationCommands.map((v) => v.command).join(' && ') || 'none'} (${prov(t.provenance)})`,
      ),
    ) +
    list('Risks the Architect listed', p.risks) +
    list('Past run durations', c.history.runs.map((h) => `${h.task} (${h.seat}): ${h.durationMs} ms`)) +
    list('Findings of the earlier review this revision answers', c.earlierFindings) +
    'When done, call submit_result with your findings, the critical path and one verdict; then end your turn.'
  );
}

// ---------------------------------------------------------------- program rules (the hand-back's own consistency; 3.5 checks run after)

export function decomposeProblems(c: ArchitectDecomposeCard, r: ArchitectDecomposeResult): string[] {
  const out: string[] = [];
  const parsed = DetailedPlanDoc.safeParse(r);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  const ids = r.tasks.map((t) => t.id);
  // unique ids: tasks, modules, interfaces, and each task's standards and verification commands (release review r4)
  out.push(...planIdProblems(parsed.data));
  const known = new Set(ids);
  for (const t of r.tasks) for (const d of t.dependsOn) if (!known.has(d)) out.push(`tasks[${t.id}].dependsOn: "${d}" is not a task of this plan`);
  const elements = new Set(c.pmPlan.elements.map((e) => e.id));
  const provs = [...r.tasks.map((t) => [`tasks[${t.id}]`, t.provenance] as const), ...r.newInterfaces.map((i) => [`newInterfaces[${i.name}]`, i.provenance] as const), ...r.modules.map((m) => [`modules[${m.id}]`, m.provenance] as const)];
  for (const [where, p] of provs) if (p !== 'architect' && !elements.has(p.planElement)) out.push(`${where}.provenance: "${p.planElement}" is not an element of the PM plan`);
  for (const i of r.newInterfaces) if (i.searched.trim() === '') out.push(`newInterfaces[${i.name}].searched: say which existing interfaces you searched and why none was reused`);
  const modules = new Set(r.modules.map((m) => m.id));
  for (const t of r.tasks) {
    if ((t.kind === 'implementation' || t.kind === 'interface') && (t.module === null || !modules.has(t.module))) out.push(`tasks[${t.id}].module: an ${t.kind} task names one of the plan's modules`);
    if (t.estimate.basis.trim() === '') out.push(`tasks[${t.id}].estimate.basis: give the basis of the estimate`);
  }
  return out;
}

export function feasibilityProblems(c: ArchitectFeasibilityCard, r: ArchitectFeasibilityResult): string[] {
  const out: string[] = [];
  const ids = new Set(c.plan.tasks.map((t) => t.id));
  for (const f of r.findings) for (const t of f.tasks) if (!ids.has(t)) out.push(`findings[${f.id}].tasks: "${t}" is not a task of the plan`);
  for (const t of r.criticalPath) if (!ids.has(t)) out.push(`criticalPath: "${t}" is not a task of the plan`);
  const blocking = r.findings.some((f) => f.severity === 'blocking');
  if (r.verdict === 'return' && !blocking) out.push('verdict: "return" needs at least one blocking finding');
  if (r.verdict === 'feasible' && blocking) out.push('verdict: "feasible" leaves a blocking finding');
  const fids = r.findings.map((f) => f.id);
  for (const id of new Set(fids)) if (fids.filter((x) => x === id).length > 1) out.push(`findings: id "${id}" is used twice`);
  return out;
}

// ---------------------------------------------------------------- records

/** The stored document of a detailed plan version (its content identity). */
export function detailedPlanDocument(c: ArchitectDecomposeCard, r: ArchitectDecomposeResult): string {
  const doc: StoredDetailedPlan = { format: 'mp4.detailed-plan.v1', mission: c.mission, pmPlan: c.pmPlan.object, round: c.pmPlan.round, plan: DetailedPlanDoc.parse(r) };
  return canonicalJson(doc);
}

export function detailedPlanRecord(c: ArchitectDecomposeCard, r: ArchitectDecomposeResult, content: { put(doc: string): string; putList(items: readonly string[]): ListRef }): ObjectVersionRecord {
  const plan = DetailedPlanDoc.parse(r);
  const reviews: ReviewContract[] = [{ review: 'calibrator-2', basisLines: c.output.calibrator2.basisLines as never, reliesOn: c.output.calibrator2.reliesOn as never }];
  if (feasibilityRequired(plan)) reviews.push({ review: 'feasibility', basisLines: c.output.feasibility.basisLines as never, reliesOn: c.output.feasibility.reliesOn as never });
  const rec: ObjectVersionRecord = {
    kind: 'object.version',
    object: c.output.object as ObjectVersionId,
    objectKind: 'plan',
    mission: c.mission as MissionId,
    module: null,
    content: content.put(detailedPlanDocument(c, r)) as ContentHash,
    prerequisites: content.putList([]),
    scope: { paths: [c.output.path], taskType: 'detailed-plan' },
    reviews,
    ...(c.output.predecessor !== null ? { predecessor: c.output.predecessor as ObjectVersionId } : {}),
  };
  validateRecord(rec);
  return rec;
}

export function feasibilityJudgment(c: ArchitectFeasibilityCard, r: ArchitectFeasibilityResult): JudgmentRecord {
  const b = c.binding;
  const rec: JudgmentRecord = {
    kind: 'judgment',
    judgment: b.judgment as JudgmentId,
    review: 'feasibility',
    executor: 'architect-feasibility',
    target: c.target as ObjectVersionId,
    verdict: r.verdict === 'feasible' ? 'pass' : 'fail',
    evidence: (b.evidence ?? EMPTY_LIST) as ListRef,
    bases: b.bases as ListRef,
    constraints: b.constraints as ListRef,
    reliesOn: b.reliesOn as ListRef,
    issues: [],
    revokes: b.revokes as JudgmentId | null,
    evidenceUse: b.evidenceUse,
    superseded: b.superseded,
    extends: b.extends as JudgmentId | null,
  };
  validateRecord(rec);
  return rec;
}

const decomposeEntry: SeatCardEntry<ArchitectDecomposeCard, ArchitectDecomposeResult> = {
  kind: 'architect-decompose',
  seat: 'architect',
  schema: ArchitectDecomposeCardSchema,
  resultShape: ArchitectDecomposeResultShape,
  resultSchema: ArchitectDecomposeResultSchema,
  definition: ARCHITECT_DECOMPOSE_DEFINITION,
  toolProfile: 'read',
  render: renderArchitectDecompose,
  problems: (c, r) => decomposeProblems(c, r),
  records: (c, r, ctx): BaseRecord[] => [detailedPlanRecord(c, r, ctx.content)],
};

const feasibilityEntry: SeatCardEntry<ArchitectFeasibilityCard, ArchitectFeasibilityResult> = {
  kind: 'architect-feasibility',
  seat: 'architect',
  schema: ArchitectFeasibilityCardSchema,
  resultShape: ArchitectFeasibilityResultShape,
  resultSchema: ArchitectFeasibilityResultSchema,
  definition: ARCHITECT_FEASIBILITY_DEFINITION,
  toolProfile: 'read',
  render: renderArchitectFeasibility,
  problems: (c, r) => feasibilityProblems(c, r),
  records: (c, r) => [feasibilityJudgment(c, r)],
};

registerSeatCard(decomposeEntry);
registerSeatCard(feasibilityEntry);
