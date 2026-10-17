// The plan documents and the cross-flow event bodies (design 3.3, 3.4, 3.10, 4.3), shared by
// the decision-layer flow, the exploration flow and the audit flow:
//   - the PM plan (3.3): result-level elements with provenance ("user said" with the quote, or
//     "PM added"), the exploration definitions (4.3, defined by the PM with the user), and the
//     user goals beyond the nearest unsettled exploration (3.10: goals only, no tasks);
//   - the detailed plan (3.4): the Architect's hand-back, stored as the plan object's content;
//   - flow lines and event names other flows read or write.

import { z } from 'zod';
import { ITEM_ID, wellFormed, type MissionId } from '../common/ids.ts';
import { canonicalJson, sha256 } from '../common/hash.ts';

/** An exploration's round budget when its definition sets none (4.1 §6.3, U-6). */
export const EXPLORATION_ROUNDS_DEFAULT = 3;

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
  /** The user's fuzzy acceptance goal, verbatim, with the words entry (W-<n>) it comes from. */
  fuzzyGoal: z.object({ quote: z.string().min(1), words: z.string().min(1) }),
  /** What counts as a hole (default: contradictions, infeasible, deadlocks, silent errors, cost blow-up, conflict with the user's words). */
  attackScope: z.array(z.string()).min(1),
  /** The decision it serves and its type (3.10: fixed at definition). */
  decision: z.object({ id: FreeId, type: z.enum(['direction', 'structure']) }),
  /** Attack rounds (4.1 §6.3: default 3); `micros` is informational (4.1 meters nothing). */
  budget: z.object({ rounds: z.number().int().positive().default(EXPLORATION_ROUNDS_DEFAULT), micros: z.number().int().positive().nullable().default(null) }).default({ rounds: EXPLORATION_ROUNDS_DEFAULT, micros: null }),
  /** Stop conditions beyond the standard three (8.2), if any. */
  stop: z.string(),
  /** A research exploration (4.3 "研究型探索"): the answer to a question. */
  research: z.boolean(),
  /**
   * The web addresses a reading may cite (url:<address>, decision 12): a citation scope only. The
   * Reader fetches with its harness's own tools; `mp` fetches nothing and checks only that a cited
   * address falls inside one of these. Absent: none (a reading then cites no web page).
   */
  readingNetwork: z.array(z.string().min(1)).optional(),
});
export type ExplorationDefinition = z.infer<typeof ExplorationDefinition>;

export const PlanProvenance = z.discriminatedUnion('by', [
  /** "用户说过": the words entry (W-<n>, decision 1) and the quoted words. */
  z.object({ by: z.literal('user'), words: z.string().min(1), quote: z.string().min(1) }),
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

/**
 * Where a detailed-plan element comes from (4.1.2, D-10 analysis item 7): the PM plan elements it
 * covers (a task may cover several: one change that satisfies several elements is one task), or
 * "architect" (the Architect's own supplement). The 4.1.1 shape `{ planElement }` is read as
 * `{ planElements: [planElement] }`, in hand-backs and in stored plans alike.
 */
export const TaskProvenance = z.preprocess(
  (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) && 'planElement' in v && !('planElements' in v) ? { planElements: [(v as { planElement: unknown }).planElement] } : v),
  z.union([z.object({ planElements: z.array(z.string().min(1)).min(1).describe('The PM plan element ids this element covers (at least one).') }), z.literal('architect')]),
);
export type TaskProvenanceT = z.infer<typeof TaskProvenance>;

/** The PM plan elements a provenance names (none for "architect"). */
export function elementsOf(p: TaskProvenanceT): readonly string[] {
  return p === 'architect' ? [] : p.planElements;
}

/** A provenance in words: "architect", or "from e1" / "from e1, e2". */
export function provenanceText(p: TaskProvenanceT, prefix = 'from'): string {
  return p === 'architect' ? 'architect' : `${prefix} ${p.planElements.join(', ')}`;
}

export const DetailedTask = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  kind: z.enum(['interface', 'implementation', 'integration', 'experiment']),
  /** The module it builds (interface, implementation); null for integration and experiments. */
  module: z.string().nullable(),
  goal: z.string().min(1),
  standards: z.array(z.object({ id: FreeId, text: z.string().min(1) })).min(1),
  /** Requirement item lines the task rests on. */
  requirementItems: z.array(z.string()),
  /**
   * The paths the task may change. Empty only for an integration task with nothing to write (it
   * gets no Constructor: its candidate is its start snapshot, which its Reviewer judges) or an
   * experiment; the mechanical check refuses any other task that writes nothing (4.1.2: checks
   * belong in the acceptance standards of the task whose change they check). A product with an
   * empty write scope claims no path, so a delivery that selects it adds no path of its own.
   */
  writeScope: z.array(z.string()).describe('The paths the task may change (exact paths, "dir/**", or "**"). Empty only for an integration task with nothing to write (it gets no Constructor; its Reviewer judges its dependencies\' work laid together) or an experiment: any other task must change something.'),
  readableFiles: z.array(z.string()),
  interpreter: z.string(),
  /**
   * Run by `mp` on a clean checkout of the candidate (4.1 §5.3). `sampled`: one observation among
   * possible others (a benchmark, a flaky-test probe: a sampling run, never reused); `network`: it
   * needs the network (another run, never reused or renewed) (§6.5).
   */
  verificationCommands: z.array(z.object({ id: FreeId, command: z.string().min(1), cwd: z.string().optional(), sampled: z.boolean().optional(), network: z.boolean().optional() })),
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

/**
 * A task's card identity (a spec records it; a different one is a re-plan of the task). A task
 * that covers one element hashes in the 4.1.1 shape `{ planElement }`, so the specs recorded by
 * 4.1.1 keep their identity and no task restarts because of the new provenance shape.
 */
export function taskCardHash(t: DetailedTask): string {
  const parsed = DetailedTask.parse(t);
  const p = parsed.provenance;
  const canonical = p !== 'architect' && p.planElements.length === 1 ? { ...parsed, provenance: { planElement: p.planElements[0] } } : parsed;
  return sha256(canonicalJson(canonical)).slice(0, 16);
}

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

/**
 * A repair's amendment of the plan in effect (D-10): the tasks it adds and the tasks it reopens. It is
 * recorded as a new "effective" event of the same detailed plan (key "<dplan>#a<n>"), whose body lists
 * every amendment of that plan so far: the plan's tasks plus the amendments' tasks are the plan in
 * effect (amendedPlan), and a later real re-plan carries them over like any other task (the
 * Architect's revision card shows the amended plan). No new detailed plan version, no re-bind.
 */
export interface AmendmentEntry {
  readonly repair: string;
  readonly tasks: readonly DetailedTask[];
  readonly reopen: ReadonlyArray<{ readonly task: string; readonly issue: string }>;
  /** The Architect repair task whose hand-back it is. */
  readonly arch: string;
}

/** The detailed plan with the amendments recorded on it, in order (an id the plan already has is never replaced). */
export function amendedPlan(plan: DetailedPlanDoc, amendments: readonly AmendmentEntry[] | undefined): DetailedPlanDoc {
  if (amendments === undefined || amendments.length === 0) return plan;
  const ids = new Set(plan.tasks.map((t) => t.id));
  const added: DetailedTask[] = [];
  for (const a of amendments) {
    for (const t of a.tasks) {
      if (ids.has(t.id)) continue;
      ids.add(t.id);
      added.push(DetailedTask.parse(t));
    }
  }
  return { ...plan, tasks: [...plan.tasks, ...added] };
}

/**
 * The tasks repairs added to any plan of the mission (every amendment of every "effective" event):
 * outside the integration rule in every later mechanical check (repairs and revisions that carry
 * them alike); whether their changes need another full run is the PM's close-time decision (D-7).
 */
export function amendedTaskIds(effective: ReadonlyArray<{ readonly amendments?: readonly AmendmentEntry[] }>): Set<string> {
  return new Set(effective.flatMap((e) => (e.amendments ?? []).flatMap((a) => a.tasks.map((t) => t.id))));
}

/** The latest "effective" event body of one detailed plan (its last amendment, if any), from the mission's events. */
export function latestEffectiveOf<B extends { readonly dplan: string }>(events: ReadonlyArray<{ readonly line: string; readonly event: string; readonly body: unknown }>, dplan: string): B | undefined {
  return events.filter((e) => e.line === PLAN_LINE && e.event === 'effective' && (e.body as { dplan?: string }).dplan === dplan).at(-1)?.body as B | undefined;
}

/** The repair an amended task was added by, from the effective body that lists it (null: a task of the plan itself). */
export function repairOfTask(amendments: readonly AmendmentEntry[] | undefined, task: string): string | null {
  return amendments?.find((a) => a.tasks.some((t) => t.id === task))?.repair ?? null;
}

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
 * Repairs (4.1.2, D-9, D-10): a problem the user found when trying the product, recorded by the PM
 * (`mp pm repair`) with the user's reason verbatim from a words entry and the kind the PM chose. Line
 * "repairs", event "repair", key the repair id (R-<n>). About an exploration, the exploration is
 * reopened for one more round with the repair as an added question; otherwise an Architect repair
 * step amends the plan in effect (added tasks) and/or reopens tasks, under the mechanical checks only.
 */
export const REPAIRS_LINE = 'repairs';
export const REPAIR_KINDS = ['defect', 'usability', 'missing', 'new-question'] as const;
export type RepairKind = (typeof REPAIR_KINDS)[number];
export interface RepairBody {
  readonly id: string;
  /** The words entry the reason is quoted from. */
  readonly words: string;
  readonly kind: RepairKind;
  /** The user's reason, verbatim from the words entry. */
  readonly text: string;
  /** What it is about: a task, an exploration, or the plan in effect as a whole. */
  readonly about: { readonly kind: 'task' | 'exploration'; readonly id: string } | null;
}
/** The Architect repair step's outcome, once its amendment passed the mechanical checks (event "decided", key the repair id). */
export interface RepairDecidedBody {
  readonly repair: string;
  readonly dplan: string;
  readonly arch: string;
  readonly add: readonly string[];
  /** The tasks it reopens, each at the attempt it was accepted at when the repair was decided. */
  readonly reopen: ReadonlyArray<{ readonly task: string; readonly issue: string; readonly attempt: number; readonly product: string }>;
}
/** A repair as a card shows it (every card of the work it caused). */
export interface RepairRef {
  readonly id: string;
  readonly kind: RepairKind;
  readonly text: string;
  readonly words: string;
}
export const repairRef = (r: RepairBody): RepairRef => ({ id: r.id, kind: r.kind, text: r.text, words: r.words });

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
 * "exploration:<id>", event "settled", key = the exploration id; once per opening: a rerun after
 * an environment change reopens a converged exploration, and a later stop settles again with key
 * "<id>#<n>"; only the current settle counts, exploration/step.ts currentSettle): the decision
 * layer routes it by decision type (3.10): structure → the Architect decomposes the waiting part;
 * direction, no conclusion, or the key conclusion not standing → the Secretary, then the PM and
 * the user.
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

/**
 * `mp pm renew` (4.1 §6.5, decision 18) records here the judgments it could not renew
 * mechanically (a sampling run, a timing or statistical field, or a rerun whose fields differ):
 * line "renew", event "review-needed", key "<judgment>@<environment identity>". The flow that owns
 * the judged object dispatches a new judgment of the same review position on the same version with
 * the runs recorded again under the current identity (execution: a Reviewer); no WI.
 */
export const RENEW_LINE = 'renew';
export const REVIEW_NEEDED = 'review-needed';
export interface ReviewNeededBody {
  readonly judgment: string;
  readonly target: string;
  readonly review: string;
  /** The identity the new judgment is under. */
  readonly environment: string;
  readonly reason: string;
  /** The renewal rerun that could not renew it (null: none was run: a sampling run, sampled fields). */
  readonly rerun: string | null;
  readonly passed: boolean | null;
}

export function missionOf(s: string): MissionId {
  return s as MissionId;
}
