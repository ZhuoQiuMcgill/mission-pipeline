// The plan documents and the cross-flow event bodies (design 3.3, 3.4, 3.10, 4.3), shared by
// the decision-layer flow, the exploration flow and the audit flow:
//   - the PM plan (3.3): result-level elements with provenance ("user said" with the quote, or
//     "PM added"), the exploration definitions (4.3, defined by the PM with the user), and the
//     user goals beyond the nearest unsettled exploration (3.10: goals only, no tasks);
//   - the detailed plan (3.4): the Architect's hand-back, stored as the plan object's content;
//   - flow lines and event names other flows read or write.

import { z } from 'zod';
import { ITEM_ID, wellFormed, type MissionId } from '../common/ids.ts';

/** A free-form id (standard, verification command, module, decision): non-empty and well-formed text (review r3: a lone surrogate would merge two ids). */
const FreeId = z.string().min(1).refine(wellFormed, 'an id must be well-formed text (no lone UTF-16 surrogate)');
/** A requirement item named by its id (it becomes the line item.<mission>.<id>). */
const ItemRef = z.string().regex(ITEM_ID, 'an item id is 1 to 64 letters, digits or "-"');

// ---------------------------------------------------------------- the PM plan (3.3, 4.3, 3.10)

/** 4.3 "定义（决策层，PM 与用户）": one exploration of the plan. */
export const ExplorationDefinition = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  /** What it produces: a design, a method, an analysis, or the answer to a question. */
  deliverable: z.string().min(1),
  /** The user's fuzzy acceptance goal, verbatim, with the message it comes from. */
  fuzzyGoal: z.object({ quote: z.string().min(1), message: z.string().min(1) }),
  /** What counts as a hole (default: contradictions, infeasible, deadlocks, silent errors, cost blow-up, conflict with the user's words). */
  attackScope: z.array(z.string()).min(1),
  /** The decision it serves and its type (3.10: fixed at definition). */
  decision: z.object({ id: FreeId, type: z.enum(['direction', 'structure']) }),
  budget: z.object({ rounds: z.number().int().positive(), micros: z.number().int().positive().nullable() }),
  /** Stop conditions beyond the standard three (8.2), if any. */
  stop: z.string(),
  /** A research exploration (4.3 "研究型探索"): the answer to a question. */
  research: z.boolean(),
});
export type ExplorationDefinition = z.infer<typeof ExplorationDefinition>;

export const PlanProvenance = z.discriminatedUnion('by', [
  /** "用户说过": the message and the quoted words. */
  z.object({ by: z.literal('user'), message: z.string().min(1), quote: z.string().min(1) }),
  /** "PM 补充". */
  z.object({ by: z.literal('pm') }),
]);

export const PmPlanElement = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  kind: z.enum(['deliverable', 'phase', 'behavior', 'constraint', 'exploration']),
  text: z.string().min(1),
  provenance: PlanProvenance,
  /** kind "exploration": its definition. */
  exploration: ExplorationDefinition.optional(),
  /** Explorations this element waits for (3.10): not planned into tasks while any is unsettled. */
  after: z.array(z.string()).default([]),
  /** Requirement item lines this element rests on. */
  items: z.array(ItemRef).default([]),
});
export type PmPlanElement = z.infer<typeof PmPlanElement>;

export const PmPlanDoc = z.object({
  format: z.literal('mp4.pm-plan.v1'),
  mission: z.string().min(1),
  /** The planning round (3.10). */
  round: z.number().int().positive(),
  /** "user": the user specified the element order (a direction, 3.4); "free": "按合适的来" (a detail). */
  order: z.enum(['user', 'free']),
  elements: z.array(PmPlanElement).min(1),
  /** 3.10: beyond the nearest unsettled exploration, only the user's goals (no tasks, no placeholders). */
  goalsBeyond: z.array(z.string()),
  /** Authorization lines the plan relies on (the calibrator-1 contract, 10.1). */
  authorizations: z.array(ItemRef),
});
export type PmPlanDoc = z.infer<typeof PmPlanDoc>;

// ---------------------------------------------------------------- the detailed plan (3.4)

export const TaskProvenance = z.union([z.object({ planElement: z.string().min(1) }), z.literal('architect')]);

export const DetailedTask = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  kind: z.enum(['interface', 'implementation', 'integration', 'experiment']),
  /** The module it builds (interface, implementation); null for integration and experiments. */
  module: z.string().nullable(),
  goal: z.string().min(1),
  standards: z.array(z.object({ id: FreeId, text: z.string().min(1) })).min(1),
  /** Requirement item lines the task rests on. */
  requirementItems: z.array(z.string()),
  writeScope: z.array(z.string()).min(1),
  readableFiles: z.array(z.string()),
  interpreter: z.string(),
  verificationCommands: z.array(z.object({ id: FreeId, command: z.string().min(1), cwd: z.string().optional() })),
  implements: z.array(z.string()),
  calls: z.array(z.string()),
  /** Scheduling dependencies: tasks that must be accepted first (interface definitions before their users). */
  dependsOn: z.array(z.string()),
  /** Exclusive resources it needs (4.1: GPU, final tests, main-branch delivery). */
  exclusive: z.array(z.string()),
  estimate: z.object({ durationMs: z.number().int().nonnegative(), costMicros: z.number().int().nonnegative(), basis: z.string().min(1) }),
  provenance: TaskProvenance,
});
export type DetailedTask = z.infer<typeof DetailedTask>;

export const DetailedPlanDoc = z.object({
  reusedInterfaces: z.array(z.object({ name: z.string().min(1), file: z.string().min(1), location: z.string().min(1), provenance: TaskProvenance })),
  newInterfaces: z.array(
    z.object({
      name: z.string().min(1),
      definition: z.string().min(1),
      /** 3.4 (maintainer: required): which existing interfaces were searched, and why none was reused. */
      searched: z.string().min(1),
      provenance: TaskProvenance,
    }),
  ),
  modules: z.array(z.object({ id: FreeId, writeScope: z.array(z.string()).min(1), provenance: TaskProvenance })),
  tasks: z.array(DetailedTask).min(1),
  /** Risks a read-only look cannot settle. */
  risks: z.array(z.string()),
});
export type DetailedPlanDoc = z.infer<typeof DetailedPlanDoc>;

/** The stored content of a detailed plan version (the plan object's content document). */
export interface StoredDetailedPlan {
  readonly format: 'mp4.detailed-plan.v1';
  readonly mission: string;
  readonly pmPlan: string;
  readonly round: number;
  readonly plan: DetailedPlanDoc;
}

function duplicates(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const x of xs) (seen.has(x) ? dup : seen).add(x);
  return [...dup];
}

/**
 * Ids that must be unique within one task (release review r4): its standards (a judgment per
 * standard) and its verification commands (an evidence record per command). Empty: none repeat.
 */
export function taskIdProblems(t: Pick<DetailedTask, 'id' | 'standards' | 'verificationCommands'>): string[] {
  return [
    ...duplicates(t.standards.map((x) => x.id)).map((d) => `task ${t.id}: standard id "${d}" is used more than once`),
    ...duplicates(t.verificationCommands.map((x) => x.id)).map((d) => `task ${t.id}: verification command id "${d}" is used more than once`),
  ];
}

/** Ids that must be unique in a detailed plan: tasks, modules, interface names, and each task's own lists. */
export function planIdProblems(p: DetailedPlanDoc): string[] {
  return [
    ...duplicates(p.tasks.map((t) => t.id)).map((d) => `task id "${d}" is used more than once`),
    ...duplicates(p.modules.map((m) => m.id)).map((d) => `module id "${d}" is used more than once`),
    ...duplicates([...p.newInterfaces.map((i) => i.name), ...p.reusedInterfaces.map((i) => i.name)]).map((d) => `interface "${d}" is listed more than once`),
    ...p.tasks.flatMap((t) => taskIdProblems(t)),
  ];
}

/** Ids that must be unique in a PM plan: its elements and its explorations. */
export function pmPlanIdProblems(p: PmPlanDoc): string[] {
  return [
    ...duplicates(p.elements.map((e) => e.id)).map((d) => `element id "${d}" is used more than once`),
    ...duplicates(p.elements.flatMap((e) => (e.exploration ? [e.exploration.id] : []))).map((d) => `exploration id "${d}" is used more than once`),
  ];
}

/** "Long" for the feasibility trigger (3.6 "预计耗时较长的运行"): 30 minutes. */
export const LONG_RUN_MS = 30 * 60 * 1000;

/** 3.6: the program's rule for running the feasibility review. */
export function feasibilityRequired(plan: DetailedPlanDoc): boolean {
  if (plan.tasks.length >= 2) return true;
  return plan.tasks.some((t) => t.kind === 'experiment' || t.exclusive.length > 0 || t.estimate.durationMs >= LONG_RUN_MS);
}

// ---------------------------------------------------------------- flow lines and cross-flow events

/** The decision layer's line of a mission. */
export const PLAN_LINE = 'plan';
/** The requirement hub's line (3.1). */
export const REQUIREMENTS_LINE = 'requirements';
/** Escalations to the Secretary and their decisions (3.8), from every flow. */
export const SECRETARY_LINE = 'secretary';
/** One plan task's execution line (4.2). */
export const taskLine = (task: string): string => `task:${task}`;
/** One exploration's line (4.3; owned by the exploration flow). */
export const explorationLine = (exploration: string): string => `exploration:${exploration}`;

/**
 * The event the decision layer writes when a PM plan version passes Calibrator ① (line "plan",
 * event "pm-plan-effective", key = the plan object): the exploration flow starts the
 * explorations it defines from here.
 */
export interface PmPlanEffectiveBody {
  readonly plan: string;
  readonly batch: string;
  readonly round: number;
  readonly doc: string;
  readonly explorations: readonly string[];
}

/**
 * The event the exploration flow writes when an exploration stops (line
 * "exploration:<id>", event "settled", key = the exploration id): the decision layer routes it
 * by decision type (3.10): structure → the Architect decomposes the waiting part; direction, no
 * conclusion, or the key conclusion not standing → the Secretary, then the PM and the user.
 */
export interface ExplorationSettledBody {
  readonly exploration: string;
  readonly decision: { readonly id: string; readonly type: 'direction' | 'structure' };
  /** conclusion: converged and the key answer stands; no-conclusion: anything else (8.2, 3.10). */
  readonly outcome: 'conclusion' | 'no-conclusion';
  /** Why it stopped (8.2): converged, budget, the same fatal problem twice, or a loop without progress (6.5). */
  readonly stop: 'converged' | 'budget' | 'repeated-fatal' | 'no-progress';
  /** The final artifact or interpretation version, if any. */
  readonly artifact: string | null;
  /** The conclusion in words (what the decision layer plans from). */
  readonly summary: string;
  /** Unresolved findings and residual risks, in words. */
  readonly unresolved: readonly string[];
}

export const PM_PLAN_EFFECTIVE = 'pm-plan-effective';
export const EXPLORATION_SETTLED = 'settled';

export function missionOf(s: string): MissionId {
  return s as MissionId;
}
