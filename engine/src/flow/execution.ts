import { contractLines as reviewContractLines, objectConstraints as reviewObjectConstraints } from '../seat/cards/inputs.ts';
import { constraintsForTask } from '../seat/cards/dynamic.ts';
import { taskDecisionQuotes, taskRequirementItems, reviewerDecisionQuotes, taskReferencePlan, coveredReopenKeys, repairsOfTaskWork, writtenForTask, stepsOfNotes43, noteOfHandBack } from '../seat/cards/dynamic.ts';
// Execution (design 4.1, 4.2, 8.1, 5.3, 5.6): the tasks of the effective detailed plan become
// Constructor and Reviewer tasks; the scheduler runs them; this module consumes their results.
//
// Per plan task (one line "task:<id>", one lineage "task.<mission>.<id>", stable across plan
// versions: 6.5 counts never reset by a re-plan):
//   gate         its scheduling dependencies are accepted (stable mode: their products and the
//                detailed plan are proven, 4.1 "求稳模式只用已证明的输入")
//   Constructor  attempt k: the card from the plan task (goal, standards, items, writable paths,
//                files to read, interpreter, verification commands, interfaces, the constraints
//                that apply, verbatim decisions; on a rework, the issue list)
//   product      the program records the product version of the candidate commit collected from
//                the Constructor's worktree at hand-back (4.1 §5.3; the object with its reviewer
//                contract: standards and items, relying on the detailed plan; prerequisites: the
//                accepted products of its dependencies, 5.3)
//   verification the program's declared runs on a clean checkout of the candidate: the only
//                evidence (4.1 §5.3, 7.2)
//   Reviewer     the card with the candidate, the runs, the Constructor's gaps and the open issues
//                to answer (5.6); its findings become issue records (the host does that)
//   pass         accepted; rework → attempt k+1 with the issue list (rework loop: initial + 2;
//                exhausted → WI-08 and the Secretary); needs-decision → the Secretary
//   Constructor's "questions that need a decision" → the Secretary, without stopping the task; 4.4 (F4):
//                the review waits for the answer to the before-review ones; a Constructor that stops to ask
//                (a blocked hand-back) pauses its attempt, and the answer resumes it on its parked edits
//   seat failures → the Secretary (failures.ts); re-plan → the decision layer; abandon → risk list
// A re-plan that changes a task's card restarts it at the next attempt; a task the new plan drops
// stops (queued attempts cancelled; work in flight finishes and is kept, proposed WI-23). A task
// whose card the new plan keeps stays accepted; once the new plan is proven, its accepted product,
// if it lost its proof with the plan it was recorded under, is re-bound to the new plan (a new
// version of the same content judged by a Reviewer in stable mode; fast mode notifies the PM,
// per maintainer ruling 1, 2026-10-13; design 4.1 Appendix J).
//
// Decisions belong to the card they were made under (the task's spec): a new spec (a re-plan that
// changes the card, or brings back a task a re-plan dropped) starts from the user's newer words, so
// a giving-up recorded under an earlier spec does not hold for it, and the task's escalations still
// open from an earlier spec are closed as superseded in the same append (their decisions, then or
// later, are not carried out on the new card). An acceptance is per attempt, and a new spec of a
// started task starts the next attempt, so nothing accepted under the old card counts for the new.

import { type IssueRecord, type IssueResponse, type ObjectScope, type ObjectVersionRecord, type ReviewContract } from '../common/records.ts';
import type { ConstructorCard, ReviewerCard } from '../seat/card.ts';
import { constructorQuestions, type ConstructorResult, type QuestionWhen, type ReviewerResult } from '../seat/results.ts';
import { OPEN_ITEM, OPEN_ITEMS_LINE, answerText, cardQuestions, deferredItemBodies, escalationQuestions, laterItemBodies, questionReasons, taskQuestions, withoutAnswers, type OpenItemBody } from './openItems.ts';
import { ITEM_BATCH, acceptanceReasons, cardItemNames, carriedBy, deferredItemBody, issueResolver, itemIssue, itemIssueLine, personItemBodies, riskItemBodies, riskItemsOf, takenItems, unverifiableLine, unverifiableOf, type IssueNote, type ItemAnswer, type RiskItem, type RiskItemBody } from './riskItems.ts';
import {
  basisIndex,
  cardBase,
  commit,
  countedReturn,
  currentVersions,
  ev,
  eventOf,
  eventsOf,
  idPart,
  notify,
  noticeAlertId,
  objectRecord,
  safeId,
  shortHash,
  taskView,
  missionClosed,
  judgmentRecordOf,
  tellOnce,
  type FlowCtx,
} from './context.ts';
import { handleFailure, type FailureOutcome } from './failures.ts';
import { attach, constructorClaims, pausedHandBack, previousHandBack, previousReviewReport } from './handbackMaterials.ts';
import { ARTIFACTS_LINE, DetailedTask, KEPT_ARTIFACTS, PLAN_LINE, RENEW_LINE, REOPEN_CARRIED, REOPEN_NOT_CARRIED, REOPEN_PINNED, REPAIRS_LINE, REVIEW_NEEDED, SECRETARY_LINE, amendedPlan, amendedTaskIds, cardChangedBy, repairOfTask, repairRef, taskCardHash, taskIdProblems, taskLine, type DetailedPlanDoc, type KeptArtifactsBody, type RepairBody, type RepairDecidedBody, type RepairRef, type ReviewNeededBody } from './plandoc.ts';
import { detailedPlanOf, internalError, latestEffective, planOf, standardLine, planAnswersReplan, contestedProduction, replanRoute, REPLAN_ANSWERED, type EffectiveBody } from './planning.ts';
import { planReviewsWaiverIn } from './waivers.ts';
import type { AppendGuard, FlowEventInput, FlowSchedulerPort, FlowTaskStatus, ProductVersion, VerificationRun } from './ports.ts';
import { currentConstraints, currentItems } from './requirements.ts';
import { isAskOption } from '../seat/cards/secretary.ts';
import { grantForDecision, grantedAttempt, cancelSecretarySteps, carryGuard, carried, carryOut, closedEscalation, closing, commitCarrying, decisionFor, deciderOf, escalateToUser, escalation, isApplied, markApplied, openEscalations, raiseEscalation, rulingJudgmentId, type DecisionBody, type EscalationBody } from './secretary.ts';
import { WI } from './wi.ts';

interface SpecBody {
  readonly dplan: string;
  readonly hash: string;
  /** 4.1.3: a repair's amendment changed the card (the same plan in effect): the new attempt carries the earlier work on. Absent: a plan's card. */
  readonly repair?: string;
}
/** Who reopened an accepted task (4.1.2): an integration task's review (D-6) or a repair (D-10). */
export type ReopenSource =
  | { readonly kind: 'review'; readonly integration: string; readonly review: string; readonly attempt: number }
  | { readonly kind: 'repair'; readonly repair: string };
interface ReworkBody {
  /** The new attempt number. */
  readonly k: number;
  /** "reopen": an accepted task reopened (D-6, D-10); "rebuild": an integration task that builds again on its reopened dependencies' new work. */
  readonly reason: 'reviewer' | 'secretary' | 'respec' | 'replan' | 'program' | 'reopen' | 'rebuild';
  readonly issues: readonly string[];
  readonly instructions: readonly string[];
  readonly reopen?: ReopenSource;
  /**
   * 4.4 (F12 a): a repair's reopen is new work on the user's words: the lineage its fresh rework loop is
   * counted on (reworkLineage), for this attempt and the reworks that follow it until one is accepted.
   * Absent (every rework before 4.4, and any other): the task's own loop.
   */
  readonly loop?: string;
  /** 4.4 (F12 b): the tasks of the same repair this reopened attempt comes after: its gate waits for them, and its start holds their work. */
  readonly after?: readonly string[];
}
/**
 * 4.4 (F13): the records of a repair's reopen request on the repairs line (plandoc.ts, beside the decision, so the
 * cards and the read of repairs read them without this module; the states they make, and the writes that move
 * them, are described above RequestState).
 */
export { REOPEN_PINNED, REOPEN_CARRIED, REOPEN_NOT_CARRIED };
export interface ReopenCarriedBody {
  readonly repair: string;
  readonly task: string;
  /** The attempt it opened. */
  readonly attempt: number;
  /** The attempt it waited for. */
  readonly from: number;
}
export interface ReopenPinnedBody {
  readonly repair: string;
  readonly task: string;
  /** The attempt it waits for now. */
  readonly attempt: number;
  readonly from: number;
}
export interface ReopenNotCarriedBody {
  readonly repair: string;
  readonly task: string;
  /** The task's attempt when it was found not possible. */
  readonly attempt: number;
  readonly why: string;
}
/** An integration review's reopen (task line event "reopen", key the integration's attempt): the decision record; each named task's new attempt follows it (carryReopens). */
interface ReopenBody {
  readonly k: number;
  readonly review: string;
  readonly tasks: ReadonlyArray<{ readonly task: string; readonly attempt: number; readonly product: string; readonly issue: string; readonly evidence?: string }>;
}
interface DispatchedBody {
  /** Exact products used to compose this attempt's start; absent in pre-upgrade dispatches. */
  readonly prerequisites?: readonly string[];
  readonly predecessor?: string | null;
  readonly k: number;
  readonly snapshot: string;
  readonly commit: string;
  readonly dplan: string;
  /** A later attempt whose start was laid anew over its dependencies' current products: that snapshot, its product's origin (Appendix M). */
  readonly origin?: string;
  /** An integration task with nothing to write: no Constructor ran, the start snapshot is the candidate (4.1.2). */
  readonly noConstructor?: true;
}
interface ProductBody extends ProductVersion {
  readonly k: number;
  readonly dispatch: string;
  readonly task: string;
  /** The Constructor's questions that need a decision (3.8), kept with the product. */
  readonly decisions?: readonly string[];
  /** 4.4 (F4): when each question must be settled, present when one is "later" (absent: all before-review, as 4.3 read them). */
  readonly when?: readonly QuestionWhen[];
}
/**
 * 4.4 (F4): a blocked hand-back, a pause of attempt k (task line event "paused", key "<k>#<n>"): the step
 * that stopped to ask, its dispatch, the parked commit of its edits (not a product: never verified,
 * reviewed, re-bound or delivered) and the escalation of this pause. Written with the escalation.
 */
interface PausedBody {
  readonly k: number;
  readonly n: number;
  readonly step: string;
  readonly dispatch: string;
  readonly parked: string;
  readonly escalation: string;
}
/** 4.4 (F4): the answer to pause n of attempt k was carried out (event "resumed", key "<k>#<n>"): the Constructor step that continues the attempt on the parked commit. */
interface ResumedBody {
  readonly k: number;
  readonly n: number;
  readonly step: string;
  readonly escalation: string;
}
interface ReviewBody {
  readonly task: string;
  readonly k: number;
  readonly verdict: 'pass' | 'rework' | 'needs-decision';
  readonly judgment: string;
  readonly issues: readonly string[];
  /** Ownership transferred by the Reviewer; context for the next seat, never work to fix here. */
  readonly deferred?: readonly string[];
  /** An integration review's reopen (D-6): the dependencies whose work causes the failure. */
  readonly reopen?: ReadonlyArray<{ readonly task: string; readonly issue: string; readonly evidence?: string }>;
  /** 4.4 (G3): the Reviewer's answer to each instruction addressed to this work (it never changes the verdict). Absent: none on the card. */
  readonly instructions?: ReadonlyArray<{ readonly instruction: string; readonly version?: string; readonly response: 'followed' | 'not-followed' | 'unclear'; readonly reason: string }>;
  /** 4.4 (G5): the Reviewer's answers to the open items its card listed (absent: none listed, every review before 4.4). */
  readonly items?: readonly ItemAnswer[];
  /** 4.4 (G5): the task's deferred issues this review answered fixed (absent: none). */
  readonly fixed?: readonly string[];
  /** 4.4 (F10): the standards the Reviewer could not verify from what it can see, with what would be needed (absent: none, every 4.3 review). */
  readonly unverifiable?: ReadonlyArray<{ readonly standard: string; readonly reason: string; readonly needed: string }>;
}

/**
 * 4.4 (F10): a review whose only open standards are ones the Reviewer could not verify, with nothing else
 * open (no standard not met or unclear, no finding, no issue not fixed, no reopen): it goes to a decider,
 * not back to the Constructor.
 */
export function onlyUnverifiable(r: Pick<ReviewBody, 'verdict' | 'issues' | 'unverifiable' | 'reopen'>): boolean {
  const n = r.unverifiable?.length ?? 0;
  return r.verdict !== 'pass' && n > 0 && r.issues.length === n && (r.reopen ?? []).length === 0;
}

/** 4.4 (F10): the issue line of a standard the Reviewer could not verify, in the form a standard not met takes ("[S1] not met: why"); one function with the open items' reading of it (flow/riskItems.ts). */
export { unverifiableLine };

// the task id encoded injectively (review r2): safeId alone turned "a_b" and "a-b" into one id
export const taskLineage = (mission: string, task: string): string => safeId(`task.${mission}.${idPart(task)}`);
/** 4.4 (F12 a): the lineage of the fresh rework loop a repair's reopen starts at attempt k (no task lineage has a fourth part). */
const reopenLoopLineage = (mission: string, task: string, k: number): string => safeId(`${taskLineage(mission, task)}.reopen${k}`);

/**
 * 4.4 (F12 a): the lineage attempt k's rework loop is counted on. A repair's reopen starts a fresh loop (its
 * rework event names it): the reopened attempt and the reworks that follow it count there until one of them is
 * accepted. Every other rework of the task (an attempt before the reopen, or work after the reopened work was
 * accepted: a re-bind, a re-review, a review's reopen) counts on the task's lineage, whose count the repair leaves as it was.
 */
export function reworkLineage(mission: string, task: string, events: ReadonlyArray<{ revision: number; event: string; key: string; body: unknown }>, k: number): string {
  const line = new Line(events);
  const base = taskLineage(mission, task);
  const fresh = line.all<ReworkBody>('rework').filter((r) => r.body.loop !== undefined && r.body.k <= k).at(-1);
  if (fresh === undefined) return base;
  for (let j = fresh.body.k; j <= k; j++) if (line.one('accepted', String(j)) !== null) return base;
  return fresh.body.loop!;
}
/** A task's card identity under a plan: a spec records it, and a different one is a re-plan of the task (taskStep; plandoc.ts). */
export { taskCardHash };

/** An integration task with nothing to write gets no Constructor (4.1.2): its candidate is its start snapshot. */
export const noConstructor = (t: Pick<DetailedTask, 'kind' | 'writeScope'>): boolean => t.kind === 'integration' && t.writeScope.length === 0;
const conTask = (mission: string, task: string, k: number): string => safeId(`con.${mission}.${idPart(task)}.${k}`);
const revTask = (mission: string, task: string, k: number, m: number): string => safeId(`rev.${mission}.${idPart(task)}.${k}${m > 0 ? `.r${m}` : ''}`);
/** 4.4 (F4): the Constructor step that continues attempt k after its n-th pause (a new step: not a rework, not a re-dispatch). */
const resumeTask = (mission: string, task: string, k: number, n: number): string => `${conTask(mission, task, k)}.p${n}`;

/** 4.4 (F4): the Constructor step of attempt k now: the continuation of its last pause answered, else the attempt's first. */
function constructorStep(ctx: FlowCtx, task: string, line: Line, k: number): string {
  return line.all<ResumedBody>('resumed').filter((r) => r.body.k === k).at(-1)?.body.step ?? conTask(ctx.mission, task, k);
}

/**
 * 4.4 (F4): the escalation a Constructor step's questions go to: `cdec.<step>` with its product; for a
 * stop to ask, `cblk.<the attempt's first step>.<n>`, its n-th pause (the pauses recorded before it, plus
 * one). Pure, from the task line: the hand-back's write (process/seat.ts, its open items) and the flow agree.
 */
export function questionsEscalationOf(mission: string, task: string, events: Line['events'], step: string, k: number, blocked: boolean): string {
  if (!blocked) return safeId(`cdec.${step}`);
  const line = new Line(events);
  const own = line.all<PausedBody>('paused').find((p) => p.body.step === step)?.body.n;
  return safeId(`cblk.${conTask(mission, task, k)}.${own ?? line.all<PausedBody>('paused').filter((p) => p.body.k === k).length + 1}`);
}

/** The state of one task line, read once per pass. */
class Line {
  readonly events: ReadonlyArray<{ revision: number; event: string; key: string; body: unknown }>;
  constructor(events: ReadonlyArray<{ revision: number; event: string; key: string; body: unknown }>) {
    this.events = events;
  }
  all<B>(event: string): Array<{ key: string; body: B; revision: number }> {
    return this.events.filter((e) => e.event === event).map((e) => ({ key: e.key, body: e.body as B, revision: e.revision }));
  }
  one<B>(event: string, key: string): B | null {
    return (this.events.find((e) => e.event === event && e.key === key)?.body as B | undefined) ?? null;
  }
  /** The current attempt: 1 + the reworks. */
  get k(): number {
    return 1 + this.all('rework').length;
  }
  /** How many specs (cards) the task has had; the current one is the last. */
  get specN(): number {
    return this.all('spec').length;
  }
  /** Given up under the current spec (a giving-up under an earlier card does not hold for a re-planned one). */
  get abandoned(): boolean {
    const r = this.all('spec').at(-1)?.revision ?? 0;
    return this.events.some((e) => e.event === 'abandoned' && e.revision > r);
  }
}

/** The key and op part of a giving-up under the n-th spec (the first keeps key "abandoned" and the plain op). */
function abandonKey(line: Line): { readonly key: string; readonly op: string } {
  const n = line.specN;
  return n <= 1 ? { key: 'abandoned', op: '' } : { key: `abandoned#${n}`, op: `:${n}` };
}

async function readLine(ctx: FlowCtx, task: string, revision = Infinity): Promise<Line> {
  return new Line((await eventsOf(ctx, taskLine(task))).filter((e) => e.revision <= revision));
}

/** Select acceptance from the task line, including the dispatch's prerequisite pin. */
export function lineAcceptance(events: Line['events']): { abandoned: boolean; k: number; product: string | null; pinned: boolean } {
  const line = new Line(events);
  const product = line.abandoned ? null : currentAcceptance(line, line.k)?.product ?? null;
  const dispatch = line.all<DispatchedBody>('dispatched').find((e) => e.body.k === line.k);
  return { abandoned: line.abandoned, k: line.k, product, pinned: dispatch === undefined || dispatch.body.prerequisites !== undefined };
}

/** A version stands at its own product/rebind attempt, unless a later accepted product
 * event adopts it. Prefer that accepted attempt; retain acceptance-only legacy records. */
export function productAttempt(events: Line['events'], product: string): number | null {
  const line = new Line(events);
  const products = line.all<ProductBody>('product').filter((p) => p.body.object === product);
  const accepted = line.all<{ k: number; product: string }>('accepted').filter((a) => a.body.product === product);
  const adoption = accepted.findLast((a) => products.some((p) => p.body.k === a.body.k));
  return adoption?.body.k ?? products[0]?.body.k ??
    line.all<RebindBody>('rebind').find((r) => r.body.product === product)?.body.k ?? accepted.at(-1)?.body.k ?? null;
}

/** A task's current acceptance by a decision with its risks (4.1.3, accept-risk). */
export interface RiskAcceptance {
  readonly k: number;
  readonly product: string;
  readonly escalation: string;
  readonly by: string;
  readonly words: string | null;
  /** The open findings it took on, quoted. */
  readonly risks: readonly string[];
}

/**
 * Whether the task's current attempt was accepted by a decision with its risks (4.1.3, #35, E-1), and
 * by whom, with the findings it took on; null when a Reviewer's pass accepted it (or judged it again
 * since), or it is not accepted. Pure, from the task line's events: the close snapshot reads it.
 */
export function riskAcceptance(events: Line['events']): RiskAcceptance | null {
  const line = new Line(events);
  if (line.abandoned) return null;
  const acc = line.one<{ product: string; judgment: string; decision?: { escalation: string; by: string; words?: string }; risks?: string[] }>('accepted', String(line.k));
  if (acc === null || acc.decision === undefined) return null;
  if (currentAcceptance(line, line.k)?.judgment !== acc.judgment) return null;
  return { k: line.k, product: acc.product, escalation: acc.decision.escalation, by: acc.decision.by, words: acc.decision.words ?? null, risks: acc.risks ?? [] };
}

/**
 * 4.4 (G5): the escalation whose acceptance with risk the task's current acceptance is (the attempt's accepting
 * record a ruling with risk: accepted, or a re-bound version accepted with its risk), or null (a Reviewer's pass
 * accepted it, or judged it again since, or it is not accepted). Pure, from the task line's events.
 */
export function currentRiskEscalation(events: Line['events']): string | null {
  const line = new Line(events);
  if (line.abandoned) return null;
  const cur = currentAcceptance(line, line.k);
  if (cur === null) return null;
  const acc = line.one<{ judgment: string; decision?: { escalation: string; option?: string } }>('accepted', String(line.k));
  const rb = line.all<ReboundBody>('rebound').filter((r) => r.body.k === line.k && bySeat(r.body)).at(-1)?.body;
  for (const x of [rb, acc]) if (x?.decision?.option === 'accept-risk' && x.judgment === cur.judgment) return x.decision.escalation;
  return null;
}

/** The production start resolver, shared by execution and the closing snapshot. */
export async function acceptedStartOf(ctx: FlowCtx, task: string, revision = Infinity) {
  const line = await readLine(ctx, task, revision);
  const selected = lineAcceptance(line.events);
  if (selected.product === null) return null;
  const check = await acceptedStart(ctx, line, selected.k, selected.product);
  const verdict: 'pinned' | 'holds' | 'lacks' | 'unreadable' = check === undefined ? 'pinned' : check === null ? 'unreadable' : check.holds ? 'holds' : 'lacks';
  return { product: selected.product, verdict, missing: check?.missing ?? [], rejected: check?.rejected ?? [] };
}

/** The accepted product of a plan task at its current attempt, with a valid start. */
export async function acceptedProduct(ctx: FlowCtx, task: string, revision = Infinity): Promise<string | null> {
  const start = await acceptedStartOf(ctx, task, revision);
  return start !== null && (start.verdict === 'pinned' || start.verdict === 'holds') ? start.product : null;
}

type StartHolds = Awaited<ReturnType<FlowSchedulerPort['startHolds']>>;
/** A start check of an accepted product: its own start, and every pre-pin version it rests on (`rejected`). */
type StartCheck = StartHolds & { readonly rejected?: readonly string[] };
const acceptedStarts = new WeakMap<FlowSchedulerPort, Map<string, Promise<StartHolds>>>();
const acceptedClosures = new WeakMap<FlowSchedulerPort, Map<string, StartCheck>>();

/** Versions recorded or re-bound at an attempt whose dispatch has no prerequisite pin (pre-upgrade). */
async function unpinnedVersions(ctx: FlowCtx): Promise<ReadonlySet<string>> {
  const all = await ctx.ports.ledger.events<{ readonly k?: number; readonly prerequisites?: unknown; readonly object?: string; readonly product?: string }>({ mission: ctx.mission });
  const pinned = new Map<string, boolean>();
  for (const e of all) if (e.event === 'dispatched' && !pinned.has(`${e.line}\n${e.body.k}`)) pinned.set(`${e.line}\n${e.body.k}`, e.body.prerequisites !== undefined);
  const out = new Set<string>();
  for (const e of all) {
    const version = e.event === 'product' ? e.body.object : e.event === 'rebind' || e.event === 'rebound' ? e.body.product : undefined;
    if (version !== undefined && pinned.get(`${e.line}\n${e.body.k}`) === false) out.add(version);
  }
  return out;
}

/**
 * Check each unpinned accepted object once; re-bound objects have their own recorded prerequisites.
 * The delivery's fixed point, applied at acceptance: an unpinned product is valid only when every
 * unpinned version in its recorded closure holds its own start too. Pinned products are composed
 * only from products that passed this check, and the check is a content fact of a fixed record.
 */
async function acceptedStart(ctx: FlowCtx, line: Line, k: number, product: string): Promise<StartCheck | null | undefined> {
  const dispatch = line.all<DispatchedBody>('dispatched').find((e) => e.body.k === k);
  if (dispatch === undefined || dispatch.body.prerequisites !== undefined) return undefined;
  const scheduler = ctx.ports.scheduler;
  let checks = acceptedStarts.get(scheduler);
  if (checks === undefined) acceptedStarts.set(scheduler, checks = new Map());
  const memo = checks;
  let closures = acceptedClosures.get(scheduler);
  if (closures === undefined) acceptedClosures.set(scheduler, closures = new Map());
  const known = closures.get(product);
  if (known !== undefined) return known;
  const holds = (id: string): Promise<StartHolds> => {
    let check = memo.get(id);
    if (check === undefined) {
      check = scheduler.startHolds(id);
      memo.set(id, check);
    }
    return check;
  };
  let at = product;
  try {
    const own = await holds(product);
    const record = await objectRecord(ctx, product);
    const recorded = record === null ? [] : ctx.ports.ledger.content.getList(record.prerequisites);
    const rejected: string[] = [];
    if (recorded.length > 0) {
      const unpinned = await unpinnedVersions(ctx);
      for (const member of await scheduler.composition(recorded)) {
        if (member === product || !unpinned.has(member)) continue;
        at = member;
        if (!(await holds(member)).holds) rejected.push(member);
      }
    }
    const result: StartCheck = rejected.length === 0 ? own : { holds: false, missing: own.missing, rejected };
    closures.set(product, result);
    return result;
  } catch (e) {
    // Missing history is not a content mismatch. Hold consumers and retry after the refusal.
    memo.delete(at);
    await notify(ctx, {
      category: 'legacy-prerequisites-unavailable', wi: null, key: product,
      trigger: `the recorded start of ${product} cannot be checked: ${(e as Error).message}`,
      defaultAction: 'the product is excluded from current acceptance until its start can be checked; restore the local objects and retry',
      detail: { product, error: (e as Error).message },
    });
    return null;
  }
}

/** Unaccepted pre-upgrade dependent attempts still need a new pinned, verified start. */
async function legacyPins(ctx: FlowCtx, line: Line, k: number): Promise<{ readonly recorded: readonly string[]; readonly product: string | null; readonly restart: true } | null> {
  const spec = line.all('spec').at(-1)?.revision ?? 0;
  const dispatches = line.all<DispatchedBody>('dispatched').filter((e) => e.revision > spec && e.body.k <= k);
  const current = dispatches.find((e) => e.body.k === k);
  if (current === undefined || current.body.prerequisites !== undefined) return null;
  const start = current;
  const stored = await planOf(ctx, start.body.dplan);
  // Dispatch ids encode the task injectively; the plan task is supplied by the line's dispatch.
  const dispatchedTask = stored?.plan.tasks.find((t) => conTask(ctx.mission, t.id, start.body.k) === start.key);
  if (dispatchedTask === undefined) throw new Error(`the dispatched plan ${start.body.dplan} has no task for ${start.key}`);
  if (dispatchedTask.dependsOn.length === 0) return null;
  const product = line.one<ProductBody>('product', String(k));
  const record = product === null ? null : await objectRecord(ctx, product.object);
  const recorded = record === null ? [] : ctx.ports.ledger.content.getList(record.prerequisites);
  return { recorded, product: product?.object ?? null, restart: true };
}

export async function executionStep(ctx: FlowCtx): Promise<void> {
  // 4.4 (F13): one read of the plan in effect, whose revision guards the moves of the repairs' reopens
  const effective = (await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')).at(-1);
  const eff = effective?.body ?? null;
  if (eff === null) return;
  const raw = await detailedPlanOf(ctx, eff.dplan);
  if (raw === null) return internalError(ctx, `exec:${eff.dplan}`, `the effective detailed plan ${eff.dplan} is not in the ledger`);
  // the plan in effect: its version's tasks plus the tasks repair amendments added (4.1.2, D-10)
  const stored = { ...raw, plan: amendedPlan(raw.plan, eff.amendments) };
  // a closed mission's production is held (4.1 §6.7); a re-review after an environment change is
  // post-close work (it keeps an accepted product proven for a delivery) and goes on
  if (await missionClosed(ctx)) {
    for (const t of stored.plan.tasks) {
      const line = await readLine(ctx, t.id);
      if (!line.abandoned && line.one('accepted', String(line.k)) !== null) await rereviewStep(ctx, eff, stored.plan, t, line, line.k);
    }
    // releases after the close can requeue obsolete steps: cancelling them is not production
    await supersededStep(ctx, eff);
    // 4.4 (F14): notices a 4.3 memory left open on a mission closed since are tracked, and closed once superseded
    await adoptKeptNotices(ctx);
    await keptSweep(ctx, eff);
    return;
  }
  // reopen decisions (an integration review's, a repair's) carried out before the tasks move (restartable)
  await carryReopens(ctx, stored.plan, { plan: stored.plan, revision: effective?.revision ?? null });
  const kept: KeptReport = { review: [], successors: null, waived: await waivedPlans(ctx) };
  await adoptKeptNotices(ctx);
  try {
    for (const t of stored.plan.tasks) await taskStep(ctx, eff, stored.plan, t, kept);
  } finally {
    // what this pass re-bound is told even when a later task's step failed
    await keptNotices(ctx, eff, kept);
  }
  await keptSweep(ctx, eff);
  await droppedStep(ctx, eff, stored.plan);
  await supersededStep(ctx, eff);
  await withdrawnStep(ctx, stored.plan);
}

// ---------------------------------------------------------------- re-review after an environment change

interface RereviewBody {
  readonly k: number;
  readonly n: number;
  /** The renew request (line "renew") it answers. */
  readonly request: string;
  readonly rev: string;
  readonly runs: readonly VerificationRun[];
  /** The version it judges again (absent: the attempt's accepted product, as before re-bound versions existed). */
  readonly product?: string;
}

/**
 * 4.1 §6.5, decision 18: `mp pm renew` could not renew the accepted product's review mechanically
 * (a sampling run, a timing or statistical field, a rerun whose fields differ). A new judgment of
 * the same review position on the same candidate: the declared commands run again under the
 * current identity (declared runs reused when a renewal rerun made them), then a Reviewer with
 * those runs. A pass keeps the task accepted; a rework sends it back to the Constructor (the next
 * attempt); a needs-decision goes to the Secretary, and its answer starts another re-review. No WI.
 */
async function rereviewStep(ctx: FlowCtx, eff: EffectiveBody, plan: DetailedPlanDoc, t: DetailedTask, line: Line, k: number): Promise<void> {
  // the version accepted now: the attempt's product, or its latest re-bound version (Appendix J)
  const cur = currentAcceptance(line, k);
  if (cur === null || cur.body === null) return;
  const product = cur.body;
  const original = cur.original;
  const lineName = taskLine(t.id);
  const lineage = taskLineage(ctx.mission, t.id);
  // 4.1 §6.2 (v51 §4.1, the maintainer's fast/stable modes): a basis of the accepted result got a new
  // version after it was judged (an ordinary revision, never a rejection). Stable mode re-accepts it
  // on the new basis (a request below); fast mode goes on, the product "not fully proven" (a notice)
  const judged = cur.judgment;
  const revised = await revisedBases(ctx, judged);
  if (revised.length > 0) {
    // a re-bound version's request names it (the attempt's own product keeps the key it always had)
    const key = `${k}:${shortHash(revised)}${cur.product === original ? '' : `@${shortHash(cur.product)}`}`;
    if (eff.mode === 'stable') {
      if (line.one('basis-revised', key) === null) {
        await commit(ctx, `flow:basis-revised:${ctx.mission}:task:${idPart(t.id)}:${key}`, {
          events: [ev(ctx, lineName, 'basis-revised', key, { k, judgment: judged, revised, ...(cur.product === original ? {} : { product: cur.product }), reason: `a basis has a new version (${revised.map((r) => `${r.from} → ${r.to}`).join(', ')}): re-accept on it` })],
        });
        return;
      }
    } else {
      await notify(ctx, {
        category: 'result-not-fully-proven',
        wi: null,
        key: `${t.id}:${key}`,
        trigger: `a basis of task ${t.id}'s accepted product ${cur.product} got a new version after it was judged (${revised.map((r) => `${r.from} → ${r.to}`).join(', ')})`,
        defaultAction: 'fast mode: the task stays accepted and the work that depends on it goes on; the product is "not fully proven" until it is judged on the new basis (a re-plan, or stable mode)',
        detail: { task: t.id, product: cur.product, judgment: judged, revised },
      });
    }
  }
  let requests: Array<{ readonly key: string; readonly revision: number; readonly body: { readonly reason: string } }> = [
    ...(await eventsOf<ReviewNeededBody>(ctx, RENEW_LINE, REVIEW_NEEDED))
      .filter((e) => e.body.target === cur.product && e.body.review === 'reviewer')
      .map((e) => ({ key: e.key, revision: e.revision, body: { reason: `the environment changed (${e.body.reason}), so the runs were recorded again under the current environment` } })),
    // Basis changes, like renewals, belong to the version even before its adoption.
    ...line.all<{ k: number; reason: string; product?: string }>('basis-revised').filter((e) =>
      (e.body.product ?? line.one<{ product: string }>('accepted', String(e.body.k))?.product) === cur.product),
  ].sort((a, b) => a.revision - b.revision);
  const history = line.all<RereviewBody>('rereview');
  // Completed requests belong to the product version, including rounds before adoption.
  // Their original attempt and runs remain history; only a later request starts a new round.
  const handled = history.filter((r) => r.body.k !== k && line.one('review', r.body.rev) !== null &&
    (r.body.product ?? line.one<{ product: string }>('accepted', String(r.body.k))?.product) === cur.product &&
    productAttempt(line.events, cur.product) === k);
  const through = Math.max(0, ...handled.map((r) => requests.find((q) => q.key === r.body.request)?.revision ?? 0));
  requests = requests.filter((q) => q.revision > through);
  if (requests.length === 0) return;
  const all = history.filter((r) => r.body.k === k);
  const rounds = all.filter((r) => (r.body.product ?? original) === cur.product);
  const last = rounds.at(-1);
  let request = requests.at(-1)!;
  if (last !== undefined) {
    // a crash between recording the round and queueing its Reviewer: queue it now
    if (line.one('review', last.body.rev) === null && (await taskView(ctx, last.body.rev)).kind === 'absent') {
      return submitReviewer(ctx, eff, plan, t, line, k, last.body.rev, product, last.body.runs, { duties: rereviewDuties(t, k, requests.find((r) => r.key === last.body.request)?.body.reason ?? 'an environment change'), afterClose: 'audit' });
    }
    const verdict = await rereviewResult(ctx, plan, t, line, last.body, product, lineage);
    // waiting for its Reviewer, or sent back to the Constructor (the next attempt takes over)
    if (verdict === 'pending' || verdict === 'rework') return;
    const lastRequest = requests.find((r) => r.key === last.body.request);
    const newer = requests.filter((r) => lastRequest === undefined || r.revision > lastRequest.revision).at(-1);
    if (verdict === 'needs-decision') {
      // the answer (a "reanswer" on the line) starts another round on the same request
      const answered = line.all('reanswer').some((x) => x.key.startsWith(`${k}:`) && x.revision > last.revision);
      if (!answered) return;
      request = newer ?? lastRequest ?? request;
    } else {
      // passed: only a later environment change asks again
      if (newer === undefined) return;
      request = newer;
    }
  }
  // numbered across the attempt's versions (a re-bound version's rounds follow its predecessor's)
  const n = all.length + 1;
  // the declared commands on the same candidate under the current identity
  let runs: VerificationRun[];
  try {
    const v = await ctx.ports.scheduler.verify({ mission: ctx.mission, object: product.object, snapshot: product.snapshot, commands: t.verificationCommands });
    if (v === 'pending') return;
    runs = [...v];
  } catch (e) {
    return actionRefused(ctx, `${product.object}:reverify`, e);
  }
  const rev = safeId(`rev.${ctx.mission}.${idPart(t.id)}.${k}.e${n}`);
  await commit(ctx, `flow:rereview:${ctx.mission}:task:${idPart(t.id)}:${k}:${n}`, {
    events: [ev(ctx, lineName, 'rereview', `${k}:${n}`, { k, n, request: request.key, rev, runs, ...(cur.product === original ? {} : { product: cur.product }) } satisfies RereviewBody)],
  });
  await submitReviewer(ctx, eff, plan, t, line, k, rev, product, runs, { duties: rereviewDuties(t, k, request.body.reason), afterClose: 'audit' });
}

function rereviewDuties(t: DetailedTask, k: number, reason: string): string {
  return `Judge the candidate of task ${t.id} (attempt ${k}) again against each standard: ${reason.slice(0, 300)}. The candidate is the same; the basis and the runs on this card are the current ones (§6.2, §6.5).`;
}

/** The basis versions a judgment was bound to that have a newer version now (withdrawn lines are withdrawnStep's). */
async function revisedBases(ctx: FlowCtx, judgment: string): Promise<Array<{ readonly from: string; readonly to: string }>> {
  const rec = await judgmentRecordOf(ctx, judgment);
  if (rec === null) return [];
  const ix = await basisIndex(ctx);
  const out: Array<{ from: string; to: string }> = [];
  for (const b of ctx.ports.ledger.content.getList(rec.bases)) {
    const l = ix.lineOf.get(b);
    if (l === undefined || ix.withdrawn.has(l)) continue;
    const cur = ix.current.get(l);
    if (cur !== undefined && cur !== b) out.push({ from: b, to: cur });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

/** The verdict of a re-review round, once its Reviewer handed back (recorded on the task line), or "pending". */
async function rereviewResult(ctx: FlowCtx, plan: DetailedPlanDoc, t: DetailedTask, line: Line, r: RereviewBody, product: ProductBody, lineage: string): Promise<ReviewBody['verdict'] | 'pending'> {
  const lineName = taskLine(t.id);
  let review = line.one<ReviewBody>('review', r.rev);
  if (review === null) {
    const view = await taskView(ctx, r.rev);
    if (view.kind === 'absent' || view.kind === 'pending' || view.kind === 'evidence') return 'pending';
    if (view.kind === 'failed') {
      await failed(ctx, t, r.rev, lineage, view);
      return 'pending';
    }
    review = await takeReview(ctx, t, r.k, r.rev, view);
    if (review === null) return 'pending';
    // 4.4 (F10): what the Reviewer could not verify, with nothing else open, goes to a decider, not back to the Constructor
    const unverified = onlyUnverifiable(review);
    switch (unverified ? 'needs-decision' : review.verdict) {
      case 'pass':
        await commit(ctx, `flow:reaccepted:${ctx.mission}:${r.rev}`, { events: [ev(ctx, lineName, 'reaccepted', `${r.k}:${r.n}`, { k: r.k, product: product.object, judgment: review.judgment })] });
        break;
      case 'rework':
        // an integration review that names the dependencies at fault reopens them (D-6)
        if (t.kind === 'integration' && (review.reopen ?? []).length > 0) await reopenFromReview(ctx, plan, t, r.k, r.rev, review, product);
        // the new evidence does not hold: the Constructor redoes the task (the next attempt)
        else await rework(ctx, t, r.k, review.issues, [], `rework:${r.k}:re${r.n}`);
        break;
      case 'needs-decision':
        await raiseEscalation(ctx, {
          id: `rnd.${r.rev}`,
          source: 'reviewer-needs-decision',
          lineage,
          subject: `task:${t.id}`,
          summary: `The Reviewer of task ${t.id} (attempt ${r.k}, re-review ${r.n} after an environment change) needs a decision: ${unverified ? `it could not verify ${(review.unverifiable ?? []).map((u) => u.standard).join(', ')} from what it can see, and nothing else is open` : 'the standards are unclear or in conflict'}.`,
          reasons: [...review.issues],
          // 4.4 (G1 with F10): what could not be verified is a question of evidence, not of design: no ask-architect
          options: unverified ? ['answer', 'rework', 'replan', 'ask-user'] : ['answer', 'ask-architect', 'rework', 'replan', 'ask-user'],
          items: t.requirementItems,
          facts: { task: t.id, attempt: r.k, product: product.object, issues: review.issues, rereview: r.n },
          handover: { from: r.rev, objects: [product.object] },
        });
        break;
    }
  }
  // 4.4 (F10, review p9-3): the disposition taken, when recorded and when resumed: such a review waits for its
  // decider's answer as a "needs decision" does (the hand-back keeps the verdict the Reviewer gave)
  return onlyUnverifiable(review) ? 'needs-decision' : review.verdict;
}

/** 6.2: an accepted product whose basis was withdrawn → the Secretary judges whether to re-plan. */
async function withdrawnStep(ctx: FlowCtx, plan: DetailedPlanDoc): Promise<void> {
  const accepted: Array<{ task: DetailedTask; product: string }> = [];
  for (const t of plan.tasks) {
    const p = await acceptedProduct(ctx, t.id);
    if (p !== null) accepted.push({ task: t, product: p });
  }
  if (accepted.length === 0) return;
  const labels = await ctx.ports.evaluator.labels(accepted.map((a) => a.product));
  for (const a of accepted) {
    if (labels.labels[a.product] !== 'basis-withdrawn') continue;
    await raiseEscalation(ctx, {
      id: `withdrawn.${a.product}`,
      source: 'replan',
      lineage: taskLineage(ctx.mission, a.task.id),
      subject: `task:${a.task.id}`,
      summary: `A basis of task ${a.task.id}'s accepted product ${a.product} was withdrawn: does the work need re-planning?`,
      reasons: ['the evaluator labels the product "basis withdrawn" (5.3)'],
      options: ['accept', 'replan', 'abandon', 'ask-user'],
      items: a.task.requirementItems,
      facts: { task: a.task.id, product: a.product },
      // the program's label check raised it (no seat): the product it is about
      handover: { from: null, objects: [a.product] },
    });
  }
}

// ---------------------------------------------------------------- one plan task

async function taskStep(ctx: FlowCtx, eff: EffectiveBody, plan: DetailedPlanDoc, t: DetailedTask, kept: KeptReport): Promise<void> {
  const lineName = taskLine(t.id);
  const lineage = taskLineage(ctx.mission, t.id);
  let line = await readLine(ctx, t.id);
  // 4.4 (G5): the open items of a large acceptance with risk that an interruption left out (written in batches)
  await riskItemsLeft(ctx, t, line);

  // the task's card under this plan; a changed card (re-plan) restarts it at the next attempt
  const hash = taskCardHash(t);
  const specs = line.all<SpecBody>('spec');
  const last = specs.at(-1);
  const droppedAfter = line.all<{ dplan: string }>('dropped').some((d) => last === undefined || d.revision > last.revision);
  if (last === undefined || last.body.hash !== hash || droppedAfter) {
    const started = line.all('dispatched').length > 0;
    // 4.1.3 (#35): a repair's amendment changed the card of this task with no accepted product (the same plan in effect)
    const repair = last !== undefined && !droppedAfter && last.body.dplan === eff.dplan ? cardChangedBy(eff.amendments, t.id) : null;
    const events = [ev(ctx, lineName, 'spec', `${eff.dplan}#${specs.length + 1}`, { dplan: eff.dplan, hash, ...(repair !== null ? { repair } : {}) } satisfies SpecBody)];
    if (started) {
      await cancelAttempt(ctx, t, line.k, repair !== null ? `given a new card by repair ${repair}` : 're-planned');
      const r = repair === null ? undefined : (await eventsOf<RepairBody>(ctx, REPAIRS_LINE, 'repair')).find((x) => x.key === repair)?.body;
      const instructions = repair === null ? [`The plan changed (${eff.dplan}).`] : [`Repair ${repair}${r !== undefined ? ` (${r.kind}; the user's words ${r.words}: "${r.text}")` : ''} changed this task's card: carry your earlier work on and meet the card as it is now.`];
      events.push(ev(ctx, lineName, 'rework', String(line.k + 1), { k: line.k + 1, reason: 'respec', issues: [], instructions } satisfies ReworkBody));
    }
    // decisions belong to the card they were made under: escalations still open from the earlier card
    // (raised before it changed, or while a re-plan had dropped the task) are closed, not carried out on this one
    const stale = last === undefined ? [] : (await openEscalations(ctx, `task:${t.id}`)).map((e) => e.id);
    await commitCarrying(ctx, `flow:spec:${ctx.mission}:task:${idPart(t.id)}:${specs.length + 1}`, events, [closing(ctx, stale, `task ${t.id} has a new card under ${eff.dplan}: a decision on the earlier card does not apply to it`)], stale);
    return;
  }
  // given up under this card (a giving-up under an earlier card does not hold: the re-plan is a newer decision)
  if (line.abandoned) {
    // a newer plan that keeps the very card it was given up under does not bring it back: said, not silent
    const given = line.events.filter((e) => e.event === 'abandoned').at(-1)?.revision ?? 0;
    const effRev = (await eventsOf(ctx, PLAN_LINE, 'effective')).at(-1)?.revision ?? 0;
    if (effRev > given) {
      await notify(ctx, {
        category: 'plan-task-still-abandoned',
        wi: null,
        key: `${t.id}:${eff.dplan}`,
        trigger: `the plan in effect (${eff.dplan}) keeps task ${t.id} with the card it was given up under`,
        defaultAction: `task ${t.id} stays given up (on the risk list); the rest of the plan goes on. To run it again, the re-plan changes its card (goal, standards, scope) or gives it a new id`,
        detail: { task: t.id, dplan: eff.dplan },
      });
    }
    return;
  }

  // Reconcile independent decisions before waiting on any still-open escalation or re-plan.
  let blocked = false;
  for (const e of await openEscalations(ctx, `task:${t.id}`)) {
    blocked = (await applyTaskDecision(ctx, eff, plan, t, line, e, kept.waived)) || blocked;
    line = await readLine(ctx, t.id);
    if (line.abandoned) return;
  }
  if (blocked) return;

  // a re-plan this task asked for: wait for a newer effective plan, then start the next attempt
  const waits = line.all<{ dplan: string; escalation: string }>('waiting-replan');
  const reworkRevisions = line.events.filter((e) => e.event === 'rework').map((e) => e.revision);
  const pending = waits.filter((w) => !reworkRevisions.some((r) => r > w.revision));
  for (const w of pending) {
    if (w.body.dplan === eff.dplan || !(await planAnswersReplan(ctx, eff.dplan, w.body.escalation))) {
      await tellReplanWait(ctx, t, w.body.escalation);
      return;
    }
    // the new plan kept this task's card: start the next attempt anyway (the re-plan was decided for it)
    await commit(ctx, `flow:replanned:${ctx.mission}:task:${idPart(t.id)}:${w.key}`, { events: [ev(ctx, lineName, 'rework', String(line.k + 1), { k: line.k + 1, reason: 'replan', issues: [], instructions: [`Re-planned (${w.key}).`] } satisfies ReworkBody)] });
    return;
  }

  const k = line.k;
  const accepted = line.one('accepted', String(k)) !== null;
  const current = accepted ? currentAcceptance(line, k) : null;
  const start = current === null ? undefined : await acceptedStart(ctx, line, k, current.product);
  if (start === null) return;
  const legacy = accepted ? null : await legacyPins(ctx, line, k);
  if (legacy?.restart === true || start?.holds === false) {
    const product = current?.product ?? legacy?.product ?? null;
    const record = product === null ? null : await objectRecord(ctx, product);
    const missing = start?.missing ?? [];
    const instructions = ['This pre-upgrade attempt has no reliable prerequisite pin. Carry its recorded work onto a pinned start and verify it again.'];
    await cancelAttempt(ctx, t, k, 'restarted for legacy prerequisite pins');
    await notify(ctx, {
      category: 'legacy-prerequisites-restarted', wi: null, key: `${t.id}:${k}`,
      trigger: `task ${t.id} attempt ${k} ${accepted ? `was accepted from a start lacking recorded prerequisite content (${missing.map((m) => `${m.prerequisite} at ${m.path}`).join(', ')})${(start?.rejected ?? []).length > 0 ? `, or rests on ${start!.rejected!.join(', ')}, whose own start lacks its recorded prerequisites` : ''}` : 'has no dispatch prerequisite pin'}`,
      defaultAction: `attempt ${k + 1} carries the latest recorded product onto a pinned start and is verified and reviewed again; old events remain`,
      detail: { task: t.id, attempt: k, product, recorded: record === null ? [] : ctx.ports.ledger.content.getList(record.prerequisites), missing, rejected: start?.rejected ?? [] },
    });
    await commit(ctx, `flow:legacy-pins:${ctx.mission}:task:${idPart(t.id)}:${k}`, { events: [ev(ctx, lineName, 'rework', String(k + 1), { k: k + 1, reason: 'program', issues: [], instructions } satisfies ReworkBody)] });
    return;
  }
  if (accepted) {
    // a card the plan in effect kept: its product re-bound to that plan first (Appendix J), then re-reviews
    if ((await keptStep(ctx, eff, plan, t, line, k, kept)) === 'held') return;
    return rereviewStep(ctx, eff, plan, t, line, k);
  }

  // ids that repeat within the task would write conflicting facts (one judgment per standard, one
  // evidence per command): nothing is dispatched or verified; the Secretary re-plans it (release review r4)
  const dupIds = taskIdProblems(t);
  if (dupIds.length > 0) {
    await raiseEscalation(ctx, {
      // one per card: a re-planned card with the same duplicates raises it again (the earlier one was superseded)
      id: `dupids.${lineage}.${shortHash(dupIds)}${line.specN > 1 ? `.s${line.specN}` : ''}`,
      source: 'replan',
      lineage,
      subject: `task:${t.id}`,
      summary: `Task ${t.id} repeats ids within itself, so its judgments or evidence would conflict: it needs a corrected plan.`,
      reasons: dupIds,
      options: ['replan', 'abandon', 'ask-user'],
      items: t.requirementItems,
      facts: { task: t.id, duplicates: dupIds },
      // the program's id check on the plan raised it (no seat)
      handover: { from: null, objects: [eff.dplan] },
    });
    return;
  }

  if (eff.mode === 'fast' && await contestedProduction(ctx, eff, plan, t)) return;

  // 4.1.3 (#41): the dependencies as execution reads them (an integration task's include the tasks repairs added)
  const depIds = await taskDependencies(ctx, plan, t, line);
  // an integration attempt whose start lacks its dependencies' current work starts again on a fresh start (#41)
  if (t.kind === 'integration' && (await integrationRestart(ctx, eff, t, line, k, depIds)) === 'restarted') return;
  // gate: dependencies accepted; stable mode: proven
  const deps = await dependencyGate(ctx, eff, plan, t, line, depIds, kept.waived);
  if (deps === null) return;

  // the Constructor (4.4, F4: after an answered pause, the step that continues the attempt)
  const con = constructorStep(ctx, t.id, line, k);
  let product = line.one<ProductBody>('product', String(k));
  // (a 4.1.1 read-only integration attempt whose Constructor was already dispatched keeps it)
  if (product === null && noConstructor(t) && line.one('dispatched', con) === null) {
    // an integration task with nothing to write (4.1.2): no Constructor; the program records its start
    // snapshot (the dependencies' products laid over the base) as its product, which is not a judgment
    product = await integrationStart(ctx, eff, t, k, con, deps);
    if (product === null) return;
    line = await readLine(ctx, t.id);
  }
  if (product === null) {
    const view = await taskView(ctx, con);
    if (view.kind === 'absent') return submitConstructor(ctx, eff, plan, t, line, k, con, deps);
    if (view.kind === 'pending' || view.kind === 'evidence') return;
    if (view.kind === 'failed') return failed(ctx, t, con, lineage, view);
    const hb = view.status.handBack;
    // 4.4 (F4): a stop to ask records no product, verifies nothing and queues no review: the attempt pauses
    if (hb !== null && (view.result as ConstructorResult).blocked === true) return pause(ctx, t, line, k, con, hb);
    const dispatched = line.one<DispatchedBody>('dispatched', con);
    if (hb === null || hb.candidate === null || dispatched === null) return internalError(ctx, con, `the accepted Constructor hand-back of ${con} has no candidate commit (or the flow lost its dispatch record)`);
    const ix = await basisIndex(ctx);
    const prev = await latestRecordedProduct(ctx, line, k);
    let pv: ProductVersion;
    try {
      pv = await ctx.ports.scheduler.product({
      mission: ctx.mission,
      module: t.module ?? t.id,
      task: con,
      dispatch: hb.dispatch,
      candidate: hb.candidate.commit,
      base: dispatched.commit,
      writeScope: t.writeScope,
      taskType: t.kind,
      // Old dispatches lack a trustworthy pin: keep the record conservative, never substitute current dependencies.
      prerequisites: dispatched.prerequisites ?? [],
      reviews: [{ review: 'reviewer', basisLines: contractLines(ctx, t, ix) as never, reliesOn: [dispatched.dplan] as never }],
      predecessor: dispatched.predecessor !== undefined ? dispatched.predecessor : (prev?.object ?? null),
      ...(dispatched.origin !== undefined ? { origin: dispatched.origin } : {}),
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      // 7.1: a candidate the program cannot record goes back to the Constructor as a rework issue
      if (code === 'product-rejected') return rework(ctx, t, k, [`The program could not record your candidate: ${(e as Error).message}`], [], `rework:${k}:export`);
      return actionRefused(ctx, con, e);
    }
    const qs = constructorQuestions(view.result as ConstructorResult);
    // 4.4 (F4): the questions' texts as 4.3 kept them; when each must be settled only when one is "later"
    product = { ...pv, k, dispatch: hb.dispatch, task: con, decisions: qs.map((q) => q.text), ...(qs.some((q) => q.when === 'later') ? { when: qs.map((q) => q.when) } : {}) };
    await commit(ctx, `flow:product:${ctx.mission}:${con}`, { events: [ev(ctx, lineName, 'product', String(k), product)] });
    line = await readLine(ctx, t.id);
  }
  // 4.1.3 (startOnHandback): work that started on a dependency's version its review sent back is carried onto
  // the dependency's next version before anything runs on it (earlyStart)
  if (t.kind !== 'integration') {
    const e = await earlyStart(ctx, t, line, k, depIds);
    if (e !== null && e !== 'wait') return rebuildOnAccepted(ctx, t, k, e);
  }
  if ((product.decisions ?? []).length > 0) {
    // 3.8: the Constructor's questions go to the Secretary (raised on every pass until it exists:
    // a crash after the product cannot lose them, code review r1 #14). 4.4 (F4): verification goes on, and
    // the review waits while a before-review question is not answered and carried out (process/questions.ts).
    // A "later" question is an open item from the accepted hand-back (process/seat.ts), written here again
    // when it is missing; questions that are all "later" raise no decision: nothing waits on them (G5)
    const qs = (product.decisions ?? []).map((text, i) => ({ text, when: product!.when?.[i] ?? 'before-review' as QuestionWhen }));
    const id = safeId(`cdec.${con}`);
    const later = laterItemBodies(t.id, k, id, qs);
    if (!qs.some((q) => q.when === 'before-review')) {
      if (await anyMissing(ctx, later)) await commit(ctx, `flow:later-items:${ctx.mission}:${id}`, { events: itemEvents(ctx, later) });
    } else await raiseEscalation(ctx, {
      id,
      source: 'constructor-decision',
      lineage,
      subject: `task:${t.id}`,
      summary: `The Constructor of task ${t.id} (attempt ${k}) raised questions that need a decision.${qs.some((q) => q.when === 'before-review') ? ' Its review waits for the answer to the before-review ones.' : ''}`,
      reasons: questionReasons(qs),
      options: ['answer', 'ask-architect', 'replan', 'ask-user'],
      items: t.requirementItems,
      facts: { task: t.id, attempt: k, questions: product.decisions, product: product.object, ...(product.when !== undefined ? { when: product.when } : {}) },
      handover: { from: con, objects: [product.object] },
    }, itemEvents(ctx, later));
  }

  // the program's verification runs (the only evidence): declared runs on a clean checkout of the candidate
  let runs = line.one<{ runs: VerificationRun[] }>('verified', String(k))?.runs ?? null;
  if (runs === null) {
    let v: Awaited<ReturnType<typeof ctx.ports.scheduler.verify>>;
    try {
      v = await ctx.ports.scheduler.verify({ mission: ctx.mission, object: product.object, snapshot: product.snapshot, commands: t.verificationCommands });
    } catch (e) {
      return actionRefused(ctx, `${product.object}:verify`, e);
    }
    if (v === 'pending') return;
    runs = await commitVerified(ctx, lineName, k, product.object, [...v]);
  }

  // the Reviewer (a re-review after an answered "needs decision")
  const m = line.all('reanswer').filter((x) => x.key.startsWith(`${k}:`)).length;
  const rev = revTask(ctx.mission, t.id, k, m);
  let review = line.one<ReviewBody>('review', rev);
  if (review === null) {
    const view = await taskView(ctx, rev);
    if (view.kind === 'absent') return submitReviewer(ctx, eff, plan, t, line, k, rev, product, runs);
    if (view.kind === 'pending' || view.kind === 'evidence') return;
    if (view.kind === 'failed') return failed(ctx, t, rev, lineage, view);
    review = await takeReview(ctx, t, k, rev, view);
    if (review === null) return;
  }
  // 4.4 (F10): what the Reviewer could not verify, with nothing else open, goes once to a decider, not back to the Constructor
  if (onlyUnverifiable(review)) return reviewerUnverifiable(ctx, t, k, rev, review, product);
  switch (review.verdict) {
    case 'pass': {
      // 4.1.3: an integration is accepted only on the tree that is delivered (#41: its start holds its dependencies'
      // current work); a task that started on a dependency's hand-back in review (startOnHandback) is accepted once
      // the dependency is, on that version (E-2: the setting removes no check)
      if (t.kind === 'integration' && (await integrationRestart(ctx, eff, t, line, k, depIds)) === 'restarted') return;
      if (t.kind !== 'integration') {
        const e = await earlyStart(ctx, t, line, k, depIds);
        if (e === 'wait') return;
        if (e !== null) return rebuildOnAccepted(ctx, t, k, e);
      }
      // 4.4 (F10): a standard a person checks starts as something to verify, in the write that accepts the task
      await commit(ctx, `flow:accepted:${ctx.mission}:task:${idPart(t.id)}:${k}`, { events: [ev(ctx, lineName, 'accepted', String(k), { k, product: product.object, judgment: review.judgment }), ...await personItems(ctx, t, k)] });
      return;
    }
    case 'rework':
      // an integration review that names the dependencies at fault reopens them (D-6); the integration does not absorb the fix
      if (t.kind === 'integration' && (review.reopen ?? []).length > 0) return reopenFromReview(ctx, plan, t, k, rev, review, product);
      // nothing to write here: a rework cannot be done by this task (refused at hand-back; an older card): the Secretary decides
      if (startOnly(line, product)) return reviewerNeedsDecision(ctx, t, k, rev, review, product, `a rework of integration task ${t.id}, which writes nothing, names no dependency to reopen`);
      return rework(ctx, t, k, review.issues, [], `rework:${k}`);
    case 'needs-decision':
      return reviewerNeedsDecision(ctx, t, k, rev, review, product, null);
  }
}

/** The guard code of a "verified" event another writer recorded first (commitVerified). */
const VERIFIED_FIRST = 'VERIFIED_FIRST';

/**
 * Attempt k's "verified" event (4.1.2): the Constructor's hand-back records its runs as this event
 * in its own process (seat.ts recordVerified), so the flow normally reads it and runs nothing. When
 * both reach it together, the first writer wins: the flow writes only while the event is absent
 * (in its write), and otherwise adopts the recorded runs; nothing conflicts.
 */
async function commitVerified(ctx: FlowCtx, lineName: string, k: number, object: string, runs: VerificationRun[]): Promise<VerificationRun[]> {
  const kept = async (): Promise<VerificationRun[] | null> => (await eventOf<{ runs: VerificationRun[] }>(ctx, lineName, 'verified', String(k)))?.body.runs ?? null;
  const first = await kept();
  if (first !== null) return first;
  try {
    await commit(ctx, `flow:verified:${ctx.mission}:${object}`, {
      events: [ev(ctx, lineName, 'verified', String(k), { runs })],
      guard: { absent: [{ mission: ctx.mission, line: lineName, event: 'verified', key: String(k) }], code: VERIFIED_FIRST, message: `attempt ${k} of ${lineName} was verified by another writer first` },
    });
    return runs;
  } catch (e) {
    if ((e as { code?: string }).code !== VERIFIED_FIRST) throw e;
    const adopted = await kept();
    if (adopted === null) throw e;
    return adopted;
  }
}

/**
 * 4.4 (F4; G5): open-item events, every one of `bodies`: an item is recorded with the hand-back or the
 * decision that makes it, and a write of the flow carries the same deterministic records again (review r2-2:
 * the same payload on every run of one operation; the fact writer keeps one of identical records).
 */
function itemEvents(ctx: FlowCtx, bodies: readonly OpenItemBody[]): FlowEventInput[] {
  return bodies.map((b) => ev(ctx, OPEN_ITEMS_LINE, OPEN_ITEM, b.id, b));
}

/** Whether one of these items is not recorded yet (a write that exists only to record them is made only then). */
async function anyMissing(ctx: FlowCtx, bodies: readonly OpenItemBody[]): Promise<boolean> {
  if (bodies.length === 0) return false;
  const existing = new Set((await eventsOf(ctx, OPEN_ITEMS_LINE, OPEN_ITEM)).map((x) => x.key));
  return bodies.some((b) => !existing.has(b.id));
}

/** 4.4 (F4): told when a third pause of one attempt, or a later one, is recorded; raised from the committed pause, so it never names one that is not (review r2-3). */
async function tellPausedAgain(ctx: FlowCtx, task: string, k: number, n: number, escalation: string): Promise<void> {
  if (n < PAUSES_TOLD) return;
  await notify(ctx, {
    category: 'constructor-paused-again',
    wi: WI.loopExhausted,
    key: `${task}:${k}:${n}`,
    trigger: `the Constructor of task ${task} stopped to ask for the ${n === 3 ? 'third' : `${n}th`} time in attempt ${k} (escalation ${escalation})`,
    defaultAction: `accepted: only task ${task} waits for the decision on ${escalation}; the rest of the mission goes on. When the card itself is the cause (it is contradictory, or lacks what the seat keeps asking for), say so in the answer, or choose replan`,
    detail: { task, attempt: k, pause: n, escalation },
  });
}

/** 4.4 (F4): the guard of a write that pauses or resumes attempt k: it is still the task's current attempt (no next attempt was started meanwhile). */
const attemptCurrent = (ctx: FlowCtx, task: string, k: number): AppendGuard['absent'][number] => ({ mission: ctx.mission, line: taskLine(task), event: 'rework', key: String(k + 1) });

/** How many pauses of one attempt are accepted before the Secretary is told (4.4, F4: a third is accepted too). */
export const PAUSES_TOLD = 3;

/**
 * 4.4 (F4): a Constructor stopped to ask (a blocked hand-back): pause n of attempt k. Its edits are the
 * parked commit its hand-back collected as it collects a candidate (and anchored, process/seat.ts):
 * nothing is recorded as a product, nothing is verified, no review is queued. The pause's own escalation,
 * keyed by the attempt and the number of the pause, blocks the task; an answer carried out resumes the
 * attempt on the parked commit (answerQuestions). It counts on no loop. The third pause of an attempt,
 * and every later one, is accepted, and the Secretary is told.
 */
async function pause(ctx: FlowCtx, t: DetailedTask, line: Line, k: number, con: string, hb: NonNullable<FlowTaskStatus['handBack']>): Promise<void> {
  // this step's pause is recorded (with its escalation, in one write): its decision says how the attempt goes on
  if (line.all<PausedBody>('paused').some((p) => p.body.step === con)) return;
  if (hb.candidate === null) return internalError(ctx, con, `the blocked hand-back of ${con} has no parked commit`);
  const n = line.all<PausedBody>('paused').filter((p) => p.body.k === k).length + 1;
  const id = questionsEscalationOf(ctx.mission, t.id, line.events, con, k, true);
  // review r2 (p8-7): every question of a stop to ask is needed before the work resumes, whatever its mark: none is an open item
  const qs = constructorQuestions(hb.result as ConstructorResult).map((q) => ({ ...q, when: 'before-review' as const }));
  const parked = hb.candidate.commit;
  const paused: PausedBody = { k, n, step: con, dispatch: hb.dispatch, parked, escalation: id };
  await raiseEscalation(ctx, {
    id,
    source: 'constructor-decision',
    lineage: taskLineage(ctx.mission, t.id),
    subject: `task:${t.id}`,
    summary: `The Constructor of task ${t.id} stopped to ask (attempt ${k}, pause ${n}): nothing is handed in yet. Its edits are parked at commit ${parked}; an answer resumes the attempt on them.`,
    reasons: questionReasons(qs),
    options: ['answer', 'ask-architect', 'replan', 'ask-user'],
    items: t.requirementItems,
    facts: { task: t.id, attempt: k, pause: n, blocked: true, parked, questions: qs.map((q) => q.text) },
    handover: { from: con, objects: [] },
  }, [ev(ctx, taskLine(t.id), 'paused', `${k}#${n}`, paused)],
  // the attempt is still current inside the write: a pass that started the next attempt meanwhile wins, and nothing is paused
  { absent: [attemptCurrent(ctx, t.id, k)], code: 'STALE_REQUEST', message: `task ${t.id} moved past attempt ${k} meanwhile; its pause is not recorded (the next pass reads it again)` });
  // only once the pause is recorded (and again by the next pass while it waits: applyTaskDecision)
  await tellPausedAgain(ctx, t.id, k, n, id);
}

/**
 * 4.4 (F4): an answer to a Constructor's questions, carried out: each question it puts off (`defer`) and
 * each one raised as "later" is an open item, and an answer to a pause resumes the attempt with a new
 * Constructor step on the parked commit (not a rework, not a re-dispatch), all in the write that marks
 * the escalation applied.
 */
async function answerQuestions(ctx: FlowCtx, t: DetailedTask, line: Line, e: EscalationBody, d: DecisionBody): Promise<void> {
  if (await isApplied(ctx, e.id)) return;
  const facts = (e.facts ?? {}) as { attempt?: number; pause?: number; blocked?: boolean };
  const k = facts.attempt ?? line.k;
  const blocked = facts.blocked === true;
  // the items it makes are recorded with the decision and the hand-back (flow/secretary.ts, process/seat.ts), and
  // carried here again, the same records (a pause makes none: its questions are all needed before it resumes)
  const items = blocked ? [] : itemEvents(ctx, [...laterItemBodies(t.id, k, e.id, escalationQuestions(e)), ...deferredItemBodies(e, d.defer ?? [])]);
  const n = blocked && typeof facts.pause === 'number' && line.k === k ? facts.pause : null;
  const resume = n === null || line.one('resumed', `${k}#${n}`) !== null ? [] : [ev(ctx, taskLine(t.id), 'resumed', `${k}#${n}`, { k, n, step: resumeTask(ctx.mission, t.id, k, n), escalation: e.id } satisfies ResumedBody)];
  const carry = await carryOut(ctx, e.id, { option: 'answer' });
  const guard = carryGuard([carry])!;
  await commit(ctx, `flow:answer:${ctx.mission}:${e.id}`, {
    events: [...items, ...resume, ...carry.events],
    records: carry.records,
    // every write of a pause's life needs its attempt still current inside the write (p8-6)
    guard: { ...guard, absent: [...guard.absent, ...(resume.length > 0 ? [{ mission: ctx.mission, line: taskLine(t.id), event: 'resumed', key: `${k}#${n}` }] : []), ...(blocked ? [attemptCurrent(ctx, t.id, k)] : [])] },
  });
  await carried(ctx, [carry]);
}

/** Whether a product is an integration task's start snapshot: no Constructor ran for its attempt (4.1.2). */
function startOnly(line: Line, product: ProductBody): boolean {
  return line.one<DispatchedBody>('dispatched', product.task)?.noConstructor === true;
}

/** A Reviewer's "needs decision" goes to the Secretary; a task with no Constructor offers no rework (its fix is a dependency's). */
async function reviewerNeedsDecision(ctx: FlowCtx, t: DetailedTask, k: number, rev: string, review: ReviewBody, product: ProductBody, why: string | null): Promise<void> {
  // 4.1.3 (E-1): the decision may also accept the verified product as it is, its open findings as risks
  const risk = await riskAcceptable(ctx, t, k);
  const accept = risk !== null ? (['accept-risk'] as const) : [];
  await raiseEscalation(ctx, {
    id: `rnd.${rev}`,
    source: 'reviewer-needs-decision',
    lineage: taskLineage(ctx.mission, t.id),
    subject: `task:${t.id}`,
    summary: why === null ? `The Reviewer of task ${t.id} (attempt ${k}) needs a decision: the standards are unclear or in conflict.` : `The Reviewer of task ${t.id} (attempt ${k}) needs a decision: ${why}.`,
    reasons: [...review.issues],
    options: startOnly(await readLine(ctx, t.id), product) ? ['answer', 'ask-architect', 'replan', ...accept, 'ask-user'] : ['answer', 'ask-architect', 'rework', 'replan', ...accept, 'ask-user'],
    ...(risk !== null ? { position: { target: risk.product, review: 'reviewer', revokes: risk.judgment } } : {}),
    items: t.requirementItems,
    facts: { task: t.id, attempt: k, product: product.object, issues: review.issues },
    handover: { from: rev, objects: [product.object] },
  });
}

/**
 * 4.4 (F10): a review whose only open standards are ones the Reviewer could not verify from what it can
 * see goes once to a decider (its escalation is keyed by the review): accept the verified product with
 * those standards recorded as left open (accept-risk: each one is among the acceptance's risks, with what
 * would be needed), send it back with instructions, or answer (what is missing, or where it is: the same
 * candidate is reviewed again). It is not sent back to the Constructor by itself, and it spends no rework.
 * The option list has the shape of a Reviewer's "needs decision".
 */
async function reviewerUnverifiable(ctx: FlowCtx, t: DetailedTask, k: number, rev: string, review: ReviewBody, product: ProductBody): Promise<void> {
  const risk = await riskAcceptable(ctx, t, k);
  // a hand-back whose program runs did not all pass is accepted with its risks by the PM or the user only
  const runRisk = risk === null ? await failedRunsRisk(ctx, t, k) : null;
  const offered = risk ?? runRisk;
  const standards = (review.unverifiable ?? []).map((u) => u.standard);
  const accept = offered !== null ? (['accept-risk'] as const) : [];
  await raiseEscalation(ctx, {
    id: `unv.${rev}`,
    source: 'reviewer-needs-decision',
    lineage: taskLineage(ctx.mission, t.id),
    subject: `task:${t.id}`,
    summary: `The Reviewer of task ${t.id} (attempt ${k}) could not verify ${standards.join(', ')} from what it can see, and nothing else is open: a decider settles it; it is not sent back to the Constructor by itself.`,
    reasons: [...review.issues, ...(runRisk?.failed.map((f) => `a program run did not pass on the product: ${f}`) ?? [])],
    // review p9-8: `answer` (what is missing, or where it is: the same candidate is reviewed again) stays, as on every Reviewer's "needs decision";
    // 4.4 (G1): not ask-architect: what could not be verified is a question of evidence, not of design
    options: startOnly(await readLine(ctx, t.id), product) ? ['answer', 'replan', ...accept, 'ask-user'] : ['answer', 'rework', 'replan', ...accept, 'ask-user'],
    ...(runRisk !== null ? { pmOnly: ['accept-risk'] as const } : {}),
    ...(offered !== null ? { position: { target: offered.product, review: 'reviewer', revokes: offered.judgment } } : {}),
    items: t.requirementItems,
    facts: { task: t.id, attempt: k, product: product.object, issues: review.issues, unverifiable: review.unverifiable },
    handover: { from: rev, objects: [product.object] },
  });
}

// ---------------------------------------------------------------- integration tasks, reopening (4.1.2, D-6)

/**
 * The start snapshot of an integration task with nothing to write, recorded as its product (4.1.2):
 * the dependencies' products laid over the base, pinned as the attempt's prerequisites, with the
 * Reviewer contract of any product. No seat writes it and no judgment is made by the program. A
 * conflict between the dependencies' products builds nothing: the task waits with a notice (ruling 6).
 */
async function integrationStart(ctx: FlowCtx, eff: EffectiveBody, t: DetailedTask, k: number, con: string, deps: readonly string[]): Promise<ProductBody | null> {
  let snap: Awaited<ReturnType<typeof ctx.ports.scheduler.snapshot>>;
  try {
    snap = await ctx.ports.scheduler.snapshot({ mission: ctx.mission, purpose: `integration-${t.id}`, products: deps });
  } catch (e) {
    if ((e as { code?: string }).code === 'conflict') {
      await notify(ctx, {
        category: 'integration-start-conflict',
        wi: null,
        key: `${con}:start`,
        trigger: `the start snapshot of integration task ${t.id} (attempt ${k}) cannot be built: ${(e as Error).message}`,
        defaultAction: `only task ${t.id} waits (tried again on every pass, so a dependency accepted again can clear it); nothing is built on part of the work. A repair that reopens the dependency whose work conflicts, or a re-plan, routes the work (ruling 6)`,
        detail: { task: t.id, attempt: k, dependencies: deps, conflicts: (e as { detail?: unknown }).detail ?? null },
      });
      return null;
    }
    await actionRefused(ctx, `${con}:start`, e);
    return null;
  }
  const products = snap.products ?? (await ctx.ports.scheduler.composition(deps));
  let pv: ProductVersion;
  try {
    pv = await ctx.ports.scheduler.product({
      mission: ctx.mission,
      module: t.module ?? t.id,
      task: con,
      dispatch: con,
      candidate: snap.commit,
      base: snap.commit,
      writeScope: [],
      taskType: t.kind,
      prerequisites: products,
      reviews: [{ review: 'reviewer', basisLines: contractLines(ctx, t, await basisIndex(ctx)) as never, reliesOn: [eff.dplan] as never }],
      predecessor: null,
      // its start is the snapshot itself: the dependencies' products laid over the base (not the
      // commit's parent), so its start holds them on the final tree (delivery, ruling 2)
      origin: snap.commit,
    });
  } catch (e) {
    await actionRefused(ctx, `${con}:start`, e);
    return null;
  }
  const product: ProductBody = { ...pv, k, dispatch: con, task: con, decisions: [] };
  const dispatched: DispatchedBody = { k, snapshot: snap.path, commit: snap.commit, dplan: eff.dplan, prerequisites: [...products], predecessor: null, origin: snap.commit, noConstructor: true };
  // the start and the product it is are one write (the attempt's pin and its candidate)
  await commit(ctx, `flow:integration-start:${ctx.mission}:${con}`, { events: [ev(ctx, taskLine(t.id), 'dispatched', con, dispatched), ev(ctx, taskLine(t.id), 'product', String(k), product)] });
  return product;
}

/**
 * A task's dependencies as execution reads them (4.1.3, #41): its card's `dependsOn`; for an integration
 * task, also every task repairs added to the plan in effect (plandoc.ts amendedTaskIds; a later re-plan
 * that carries one keeps it so), except an integration task, one that depends on it, and one given up
 * (its work is not delivered). The one resolver of an integration's dependencies: its gate and start,
 * its Reviewer's card (so the reopen check at its hand-back), and its restart read it. 4.4 (F12 b): for any
 * task, also the tasks a repair's reopen of it comes after (`line`: the task's line when the caller has it).
 */
export async function taskDependencies(ctx: FlowCtx, plan: DetailedPlanDoc, t: DetailedTask, line?: Line): Promise<string[]> {
  // 4.4 (F12 b): the tasks the repair's reopen of this task's current work comes after are its dependencies too
  const l = line ?? (await readLine(ctx, t.id));
  const added = t.kind === 'integration' ? amendedTaskIds((await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')).map((e) => e.body)) : new Set<string>();
  const after = afterOf(l, l.k);
  const givenUp = new Set<string>();
  for (const x of plan.tasks) if ((added.has(x.id) || after.includes(x.id)) && (await readLine(ctx, x.id)).abandoned) givenUp.add(x.id);
  return effectiveDependencies(plan, t, added, (id) => givenUp.has(id), after);
}

/**
 * 4.4 (p7-4): the one description of what a task waits for, read by the gate and by the circle check of a repair's
 * decision: its card's dependencies; for an integration task, every task repairs added (`added`) except an
 * integration task, one that reaches it, and one given up; and the tasks its reopen comes after (`after`), except one
 * given up (its reopen is not carried out, so no new work of it comes: the wait ends with it).
 */
export function effectiveDependencies(plan: DetailedPlanDoc, t: DetailedTask, added: ReadonlySet<string>, givenUp: (task: string) => boolean, after: readonly string[]): string[] {
  const out = [...t.dependsOn];
  if (t.kind === 'integration' && added.size > 0) {
    const byId = new Map(plan.tasks.map((x) => [x.id, x]));
    const reaches = (from: string, to: string): boolean => {
      const seen = new Set<string>();
      const stack = [from];
      while (stack.length > 0) {
        const at = stack.pop()!;
        if (at === to) return true;
        if (seen.has(at)) continue;
        seen.add(at);
        stack.push(...(byId.get(at)?.dependsOn ?? []));
      }
      return false;
    };
    for (const x of plan.tasks) {
      if (!added.has(x.id) || x.id === t.id || x.kind === 'integration' || out.includes(x.id) || reaches(x.id, t.id) || givenUp(x.id)) continue;
      out.push(x.id);
    }
  }
  for (const x of after) if (x !== t.id && !out.includes(x) && plan.tasks.some((p) => p.id === x) && !givenUp(x)) out.push(x);
  return out;
}

/**
 * 4.4 (F12 b, p7-4): the tasks attempt k comes after: those the repair's reopen that opened its work names, while
 * that work is not accepted yet (attempt k itself may be the accepted one: its product's re-bind reads them). Work
 * after that acceptance, a later reopen, or a new card waits for none of them: a wait never outlives the reopen
 * that asked for it.
 */
function afterOf(line: Line, k: number): string[] {
  const opened = line.all<ReworkBody>('rework').filter((r) => r.body.k <= k && r.body.reason === 'reopen' && r.body.reopen?.kind === 'repair').at(-1);
  if (opened === undefined || (opened.body.after ?? []).length === 0) return [];
  if ((line.all('spec').at(-1)?.revision ?? 0) > opened.revision) return [];
  for (let j = opened.body.k; j < k; j++) if (line.one('accepted', String(j)) !== null) return [];
  return [...new Set(opened.body.after)];
}

/**
 * 4.4 (F12 b, p7-4): the circles a repair's decision would close among the waits the flow holds once it is applied.
 * Every task that will wait (one not accepted, one this decision reopens, adds or changes, one a 4.4 reopen of
 * another repair has still to reach) waits for what the gate reads (effectiveDependencies: its card, an integration's
 * implicit dependencies, the tasks its reopens come after: this decision's, another repair's open or pending one). A
 * circle through an `after` wait would hold its tasks for ever: a mechanical failure of the decision. It is the only
 * circle check of a reopen's `after`, so the graph is described once.
 */
export async function waitCircles(ctx: FlowCtx, plan: DetailedPlanDoc, d: { readonly reopen: ReadonlyArray<{ readonly task: string; readonly after?: readonly string[] }>; readonly add: readonly DetailedTask[]; readonly change?: readonly DetailedTask[] }): Promise<string[]> {
  // no wait comes after anything unless a reopen named `after` (this decision's, or one decided before)
  const decided = await eventsOf<RepairDecidedBody>(ctx, REPAIRS_LINE, 'decided');
  if (!d.reopen.some((x) => (x.after ?? []).length > 0) && !decided.some((e) => e.body.reopen.some((x) => (x.after ?? []).length > 0))) return [];
  const requests = (await reopenRequests(ctx)).filter((q) => q.source.kind === 'repair' && q.by44);
  const cards = new Map(plan.tasks.map((t) => [t.id, t]));
  for (const t of [...(d.change ?? []), ...d.add]) cards.set(t.id, t);
  const after: DetailedPlanDoc = { ...plan, tasks: [...cards.values()] };
  const added = new Set([...amendedTaskIds((await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')).map((e) => e.body)), ...d.add.map((t) => t.id)]);
  const lines = new Map<string, Line>();
  for (const t of after.tasks) lines.set(t.id, await readLine(ctx, t.id));
  // 4.4 (p7-r3-2): a task given up stays given up only under the card it was given up under: one whose card this
  // decision changes (or the plan in effect changed, and execution has not laid yet) is open again under that card,
  // both as a task that waits and as the end of a wait
  const givenUp = (id: string): boolean => {
    const l = lines.get(id);
    const card = cards.get(id);
    return l !== undefined && l.abandoned && card !== undefined && l.all<SpecBody>('spec').at(-1)?.body.hash === taskCardHash(card);
  };
  const waits = new Map<string, string[]>();
  const afterWaits = new Map<string, string[]>();
  for (const t of after.tasks) {
    const line = lines.get(t.id)!;
    if (givenUp(t.id)) continue;
    const here = d.reopen.find((x) => x.task === t.id);
    // an added task has no line yet, a changed one no accepted product: both are open
    const open = lineAcceptance(line.events).product === null;
    const pending: ReopenRequest[] = [];
    for (const q of requests) if (q.task === t.id && (await waitingRequest(ctx, line, q))) pending.push(q);
    if (!open && here === undefined && pending.length === 0) continue;
    const waitsAfter = [...(here?.after ?? []), ...(open ? afterOf(line, line.k) : []), ...pending.flatMap((q) => q.after)].filter((x) => x !== t.id);
    waits.set(t.id, effectiveDependencies(after, t, added, givenUp, waitsAfter));
    if (waitsAfter.length > 0) afterWaits.set(t.id, waitsAfter);
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (at === to) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(waits.get(at) ?? []));
    }
    return false;
  };
  const out: string[] = [];
  for (const [x, after] of afterWaits) {
    if (!after.some((a) => waits.has(a) && reaches(a, x))) continue;
    out.push(d.reopen.some((r) => r.task === x && (r.after ?? []).length > 0)
      ? `reopen[${x}].after: it waits for work that waits for it (a circle through after and dependsOn)`
      : `task ${x} waits, for another repair's reopen, for work this decision makes wait for ${x} (a circle through after and dependsOn): order the work so that nothing waits in a circle`);
  }
  return out;
}

/** The current attempt's verified hand-back (4.1.3): its product, once the program's runs on it are recorded and all passed; null otherwise. */
function verifiedHandBack(line: Line): ProductBody | null {
  if (line.abandoned) return null;
  const product = line.one<ProductBody>('product', String(line.k));
  const runs = line.one<{ runs: VerificationRun[] }>('verified', String(line.k))?.runs;
  return product === null || runs === undefined || runs.some((r) => !r.passed) ? null : product;
}

/** A dependency given up holds its dependents (no accepted product to start on): told once per card, with the exits (4.1.3, E-1). */
async function dependencyGivenUp(ctx: FlowCtx, t: DetailedTask, dep: string): Promise<void> {
  const dl = await readLine(ctx, dep);
  if (!dl.abandoned) return;
  await notify(ctx, {
    category: 'dependency-abandoned',
    wi: WI.loopExhausted,
    key: `${t.id}:${dep}:${dl.specN}`,
    trigger: `task ${t.id} waits for task ${dep}, which was given up: it has no accepted product to start on`,
    defaultAction: `only task ${t.id} and the work after it wait; the rest of the mission goes on. A repair that changes the card of ${t.id} or of ${dep} (mp pm repair, with the user's words), or a re-plan, routes the work`,
    detail: { task: t.id, dependency: dep },
  });
}

/** The tasks repairs added to the mission's plans, each with the repair that added it (for the PM's notices). */
async function addedBy(ctx: FlowCtx): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')) for (const a of e.body.amendments ?? []) for (const x of a.tasks) if (!out.has(x.id)) out.set(x.id, a.repair);
  return out;
}

/**
 * 4.1.3 (#41): an integration attempt judges the tree that will be delivered. Its start (the snapshot its
 * candidate is, or its Constructor started from) holds the accepted product of each of its dependencies
 * (taskDependencies). When one is missing (a repair added a task, or reopened a dependency, after the start
 * was recorded), the attempt starts again: attempt k+1 in one write, its queued steps cancelled; the new
 * attempt waits for them to be accepted and lays its start fresh. A step of the attempt in flight finishes
 * first: its hand-back counts for the old tree only (told), and the attempt then starts again.
 */
async function integrationRestart(ctx: FlowCtx, eff: EffectiveBody, t: DetailedTask, line: Line, k: number, depIds: readonly string[]): Promise<'restarted' | 'none'> {
  const start = line.one<DispatchedBody>('dispatched', conTask(ctx.mission, t.id, k));
  if (start === null || start.prerequisites === undefined || line.one('accepted', String(k)) !== null) return 'none';
  const pre = new Set(start.prerequisites);
  let successors: Map<string, string> | null = null;
  const missing: Array<{ readonly task: string; readonly product: string | null }> = [];
  for (const d of depIds) {
    const p = await acceptedProduct(ctx, d);
    if (p !== null && pre.has(p)) continue;
    // a version re-bound since (the same content under a later plan) is the one the start holds
    successors ??= await reboundSuccessors(ctx);
    if (p !== null && [...pre].some((x) => latestOf(successors!, x) === p)) continue;
    missing.push({ task: d, product: p });
  }
  if (missing.length === 0) return 'none';
  const by = await addedBy(ctx);
  const named = missing.map((m) => `${m.task}${by.has(m.task) ? ` (added by repair ${by.get(m.task)})` : ''}${m.product === null ? ', not accepted yet' : ''}`).join(', ');
  const running: string[] = [];
  for (const task of attemptSteps(ctx, t.id, line, k)) if ((await ctx.ports.scheduler.status(task))?.state === 'running') running.push(task);
  if (running.length > 0) {
    await notify(ctx, {
      category: 'integration-start-stale',
      wi: null,
      key: `${t.id}:${k}:${shortHash(missing)}`,
      trigger: `the start of integration task ${t.id} (attempt ${k}) lacks the current work of ${named}, while ${running.join(', ')} runs`,
      defaultAction: `${running.join(', ')} finishes; its hand-back counts for the tree it was given only (it lacks that work). Then attempt ${k + 1} starts on a fresh start with it, once ${missing.length === 1 ? 'it is' : 'they are'} accepted`,
      detail: { task: t.id, attempt: k, missing, running },
    });
    return 'none';
  }
  const body: ReworkBody = { k: k + 1, reason: 'rebuild', issues: [], instructions: [`The start of attempt ${k} lacks the current work of ${named}: this attempt starts on a fresh start that holds it (what is delivered).`] };
  await nextAttemptOf(ctx, t, k, body, `flow:integration-restart:${ctx.mission}:task:${idPart(t.id)}:${k}`, `integration task ${t.id} started again: attempt ${k} lacked the current work of ${named}`);
  await cancelAttempt(ctx, t, k, 'started again on a fresh start');
  await notify(ctx, {
    category: 'integration-restarted',
    wi: null,
    key: `${t.id}:${k}`,
    trigger: `the start of integration task ${t.id} (attempt ${k}) lacks the current work of ${named}`,
    defaultAction: `attempt ${k + 1} starts on a fresh start that holds it, once ${missing.length === 1 ? 'it is' : 'they are'} accepted; its Reviewer judges what mp pm deliver builds (plan ${eff.dplan})`,
    detail: { task: t.id, attempt: k, missing },
  });
  return 'restarted';
}

/**
 * A task that started on a dependency's hand-back still in review (config `startOnHandback`, 4.1.3, E-2:
 * the setting removes no check): "wait", its acceptance waits for the dependency's (in review on that
 * version); the dependency and the version its review sent back (the work is carried onto the
 * dependency's next version, rebuildOnAccepted); or null, every version it started on was accepted. Read
 * from the attempt's pinned start and the dependencies' lines, so a field 4.1.2 attempt reads the same.
 */
async function earlyStart(ctx: FlowCtx, t: DetailedTask, line: Line, k: number, depIds: readonly string[]): Promise<'wait' | { readonly dep: string; readonly version: string } | null> {
  const start = line.one<DispatchedBody>('dispatched', conTask(ctx.mission, t.id, k));
  const pre = new Set(start?.prerequisites ?? []);
  if (pre.size === 0) return null;
  let wait = false;
  for (const d of depIds) {
    const dl = await readLine(ctx, d);
    const v = dl.all<ProductBody>('product').map((x) => x.body.object).filter((o) => pre.has(o)).at(-1);
    if (v === undefined) continue;
    if (dl.all<{ product: string }>('accepted').some((a) => a.body.product === v)) {
      // accepted once, but reopened since and not accepted now (sol INT r1): the acceptance waits until the
      // dependency is accepted again, as it would without the setting (dependencyGate reads acceptedProduct)
      if (!dl.abandoned && (await acceptedProduct(ctx, d)) === null) wait = true;
      continue;
    }
    if (!dl.abandoned && dl.one<ProductBody>('product', String(dl.k))?.object === v) {
      wait = true;
      continue;
    }
    return { dep: d, version: v };
  }
  return wait ? 'wait' : null;
}

/**
 * The program's next attempt k+1 of a task (not counted: no Reviewer asked for it), in one write with the
 * closing of the task's escalations still open about attempt k (their decisions would apply to work that
 * is not continued), guarded: nothing is written when attempt k was accepted or moved on meanwhile.
 */
async function nextAttemptOf(ctx: FlowCtx, t: DetailedTask, k: number, body: ReworkBody, op: string, why: string): Promise<void> {
  const stale = (await openEscalations(ctx, `task:${t.id}`)).filter((e) => ((e.facts ?? {}) as { attempt?: unknown }).attempt === k).map((e) => e.id);
  const close = closing(ctx, stale, why);
  const absent = [...(carryGuard([close])?.absent ?? []), { mission: ctx.mission, line: taskLine(t.id), event: 'accepted', key: String(k) }, { mission: ctx.mission, line: taskLine(t.id), event: 'rework', key: String(k + 1) }];
  await commit(ctx, op, { events: [ev(ctx, taskLine(t.id), 'rework', String(k + 1), body), ...close.events], guard: { absent, code: 'STALE_REQUEST', message: `task ${t.id} attempt ${k} moved meanwhile; nothing was written (the next pass reads it again)` } });
  await cancelSecretarySteps(ctx, stale);
}

/** Work that started on a dependency's version its review sent back: the next attempt carries it onto the dependency's accepted version (not counted: the program's, not a Reviewer's). */
async function rebuildOnAccepted(ctx: FlowCtx, t: DetailedTask, k: number, e: { readonly dep: string; readonly version: string }): Promise<void> {
  const body: ReworkBody = { k: k + 1, reason: 'program', issues: [], instructions: [`This attempt started on ${e.version} of task ${e.dep} while it was in review, and that version was not accepted: carry your work onto ${e.dep}'s next accepted version (your change is kept) and check it again.`] };
  await nextAttemptOf(ctx, t, k, body, `flow:early-start-rebuild:${ctx.mission}:task:${idPart(t.id)}:${k}`, `task ${t.id} was carried onto ${e.dep}'s next version: attempt ${k} started on ${e.version}, which was not accepted`);
  await cancelAttempt(ctx, t, k, `carried onto ${e.dep}'s next version`);
  await notify(ctx, {
    category: 'early-start-rebuilt',
    wi: null,
    key: `${t.id}:${k}`,
    trigger: `task ${t.id} (attempt ${k}) started on ${e.version} of task ${e.dep} while it was in review (config startOnHandback), and that version was not accepted`,
    defaultAction: `attempt ${k + 1} carries its work onto ${e.dep}'s next accepted version; nothing of it is accepted on the version sent back`,
    detail: { task: t.id, attempt: k, dependency: e.dep, version: e.version },
  });
}

/**
 * The dependency gate of a task's attempt: the products it builds on, or null while it waits (the one
 * gate: the pass reads it before the Constructor, and a decision that accepts the attempt reads it too,
 * so it never accepts ahead of the gate, 4.1.3). Each dependency's current accepted product
 * (acceptedProduct: a dependency reopened since is not accepted now), or with config `startOnHandback`
 * its current attempt's verified hand-back; the products of the dependencies an integration review
 * reopened, accepted again; stable mode: proven, a waived plan read as settled by its waiver.
 */
async function dependencyGate(ctx: FlowCtx, eff: EffectiveBody, plan: DetailedPlanDoc, t: DetailedTask, line: Line, depIds: readonly string[], waived: ReadonlySet<string>): Promise<string[] | null> {
  // an integration review reopened dependencies (D-6): this attempt waits until each is accepted again (one
  // given up is told to the PM), and builds on their new work too (a dependency reached only through another
  // one is laid over it: no cascade)
  const reopened = await reopenedProducts(ctx, plan, t, line);
  if (reopened === null) return null;
  // 4.4 (F12 b, #59): a dependency that the repair this work answers reopens, while that reopen has not reached it
  // yet, holds this attempt: its new work comes first. Read before the dependencies' products (p7-2): a reopen carried
  // after this read has its dependency's next attempt written already, so the products read next show it not accepted
  if (await sameRepairReopenPending(ctx, eff, t, line, depIds)) return null;
  const deps: string[] = [];
  // config `startOnHandback` (a project setting: it removes no check, E-2): a dependency still in review counts
  // with its current attempt's verified hand-back; the dependent's own acceptance still waits for the
  // dependency's (earlyStart, at its pass). Never for an integration task: it judges the tree that is delivered (#41)
  const early = t.kind !== 'integration' && (ctx.ports.project?.startOnHandback?.includes(ctx.mission) ?? false);
  for (const d of depIds) {
    let p = await acceptedProduct(ctx, d);
    if (p === null && early) p = verifiedHandBack(await readLine(ctx, d))?.object ?? null;
    if (p === null) {
      await dependencyGivenUp(ctx, t, d);
      return null;
    }
    deps.push(p);
  }
  for (const p of reopened) if (!deps.includes(p)) deps.push(p);
  if (eff.mode === 'stable') {
    const labels = await ctx.ports.evaluator.labels([eff.dplan, ...deps]);
    // 4.1.3 (E-2): a plan that took effect without its reviews (on the user's words, an authorization, or the
    // config key) is not proven, and never will be: the gate reads it as settled by that waiver, and a
    // dependency whose review passed but whose proof lacks only such a plan as usable. The labels stay as
    // they are: the plan unproven, the products "not fully proven"
    const usable = async (x: string): Promise<boolean> => {
      const l = labels.labels[x];
      if (l === 'proven') return true;
      if (x === eff.dplan) return waived.has(x);
      if (l !== 'not-fully-proven' || waived.size === 0) return false;
      return ((await objectRecord(ctx, x))?.reviews.find((r) => r.review === 'reviewer')?.reliesOn ?? []).some((o) => waived.has(o));
    };
    for (const x of [eff.dplan, ...deps]) if (!(await usable(x))) return null;
  }
  return deps;
}

/**
 * 4.4 (F12 b, #59): the repairs the task's current work answers: the one that added it, the one that changed its
 * card in force, and those that reopened an attempt under that card.
 */
function causingRepairs(history: readonly EffectiveBody[], eff: EffectiveBody, t: DetailedTask, line: Line): Set<string> {
  const out = new Set<string>();
  // the repair that added it, also once a later plan keeps the card it gave (that plan carries no amendment, p7-r3-3)
  const added = repairOfTask(eff.amendments, t.id) ?? history.flatMap((e) => e.amendments ?? []).find((a) => a.tasks.some((x) => x.id === t.id && taskCardHash(x) === taskCardHash(t)))?.repair ?? null;
  if (added !== null) out.add(added);
  const spec = line.all<SpecBody>('spec').at(-1);
  if (spec?.body.repair !== undefined) out.add(spec.body.repair);
  const since = spec?.revision ?? 0;
  for (const rw of line.all<ReworkBody>('rework')) if (rw.revision > since && rw.body.reopen?.kind === 'repair') out.add(rw.body.reopen.repair);
  return out;
}

/**
 * 4.4 (F12 b, #59, p7-2): whether a dependency of the task is reopened by a repair its work answers, and that 4.4
 * reopen has not reached the dependency yet (waitingRequest). The dependency's current product, accepted or
 * (startOnHandback) a verified hand-back in review, is the work the repair replaces: the task waits for the attempt
 * that carries the repair, and the gate reads that one once it is accepted. A reopen of 4.3 holds nothing (p7-r2-3).
 */
async function sameRepairReopenPending(ctx: FlowCtx, eff: EffectiveBody, t: DetailedTask, line: Line, depIds: readonly string[]): Promise<boolean> {
  if (depIds.length === 0) return false;
  const causing = causingRepairs((await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')).map((e) => e.body), eff, t, line);
  if (causing.size === 0) return false;
  for (const r of await reopenRequests(ctx)) {
    if (r.source.kind !== 'repair' || !causing.has(r.source.repair) || !depIds.includes(r.task)) continue;
    if (await waitingRequest(ctx, await readLine(ctx, r.task), r)) return true;
  }
  return false;
}

/**
 * Whether attempt k can be accepted with its risk (4.1.3, #35, E-1): it is not accepted, its product's
 * hand-back is verified (the program's runs recorded, all passed), and its last Reviewer judged that
 * product without a pass. The product and that judgment: the review position a ruling would overrule.
 */
async function riskAcceptable(ctx: FlowCtx, t: DetailedTask, k: number): Promise<{ readonly product: string; readonly judgment: string } | null> {
  const line = await readLine(ctx, t.id);
  if (line.abandoned || line.k !== k || line.one('accepted', String(k)) !== null) return null;
  const product = verifiedHandBack(line);
  if (product === null) return null;
  const review = line.all<ReviewBody>('review').filter((r) => r.body.k === k).at(-1);
  if (review === undefined || review.body.verdict === 'pass') return null;
  const judged = await judgmentRecordOf(ctx, review.body.judgment);
  if (judged === null || judged.target !== product.object) return null;
  return { product: product.object, judgment: review.body.judgment };
}

/**
 * Attempt k whose hand-back is recorded but whose program runs did not all pass, and whose last Reviewer judged
 * that product without a pass: the product, that judgment and the failed runs. Only the PM or the user may accept
 * it with its risks (the escalation lists accept-risk as pmOnly; the Secretary's accept-risk stays with verified
 * hand-backs, riskAcceptable). Null otherwise, and whenever the hand-back is verified.
 */
async function failedRunsRisk(ctx: FlowCtx, t: DetailedTask, k: number): Promise<{ readonly product: string; readonly judgment: string; readonly failed: readonly string[] } | null> {
  const line = await readLine(ctx, t.id);
  if (line.abandoned || line.k !== k || line.one('accepted', String(k)) !== null) return null;
  const product = line.one<ProductBody>('product', String(k));
  const runs = line.one<{ runs: VerificationRun[] }>('verified', String(k))?.runs;
  if (product === null || runs === undefined || !runs.some((r) => !r.passed)) return null;
  const review = line.all<ReviewBody>('review').filter((r) => r.body.k === k).at(-1);
  if (review === undefined || review.body.verdict === 'pass') return null;
  const judged = await judgmentRecordOf(ctx, review.body.judgment);
  if (judged === null || judged.target !== product.object) return null;
  return { product: product.object, judgment: review.body.judgment, failed: runs.filter((r) => !r.passed).map((r) => `${r.command} (${r.summary}; evidence ${r.evidence})`) };
}

/**
 * #57: the re-bind under review of attempt k, when its Reviewer sent it back (on `key`, or any key when null)
 * and its content is the attempt's product that an accept-risk decision accepted: it may be accepted with the
 * review's open findings as risks again. Null otherwise.
 */
async function rebindRiskAcceptable(ctx: FlowCtx, t: DetailedTask, k: number, key: string | null): Promise<{ readonly product: string; readonly judgment: string; readonly rebind: string; readonly review: string } | null> {
  const line = await readLine(ctx, t.id);
  if (line.abandoned || line.k !== k) return null;
  const acc = line.one<{ product: string; decision?: { option?: string } }>('accepted', String(k));
  if (acc === null || acc.decision?.option !== 'accept-risk') return null;
  const rb = line.all<RebindBody>('rebind').filter((r) => r.body.k === k && bySeat(r.body)).at(-1);
  if (rb === undefined || line.one('rebound', rb.key) !== null) return null;
  const rev = rebindReviewers(ctx, t.id, line, k, rb).at(-1)!;
  if (key !== null && key !== `rework:${k}:${rev}`) return null;
  const review = line.one<ReviewBody>('review', rev);
  if (review === null || review.verdict === 'pass') return null;
  const was = await objectRecord(ctx, acc.product);
  const now = await objectRecord(ctx, rb.body.product);
  if (was === null || now === null || was.content !== now.content) return null;
  const judged = await judgmentRecordOf(ctx, review.judgment);
  if (judged === null || judged.target !== rb.body.product) return null;
  return { product: rb.body.product, judgment: review.judgment, rebind: rb.key, review: rev };
}

/** #57: "accept-risk" on a failed re-bind review accepts the re-bound version (event "rebound") with the decider's ruling and its risks. */
async function acceptRebindWithRisk(ctx: FlowCtx, t: DetailedTask, k: number, e: EscalationBody, d: DecisionBody): Promise<void> {
  const rebind = (e.facts as { rebind?: string } | undefined)?.rebind;
  const risk = await rebindRiskAcceptable(ctx, t, k, null);
  const by = deciderOf(d.by);
  const line = await readLine(ctx, t.id);
  const rb = rebind === undefined ? null : line.one<RebindBody>('rebind', rebind);
  if (rebind === undefined || rb === null || risk === null || risk.rebind !== rebind || e.position?.target !== rb.product || by === null) {
    await notify(ctx, {
      category: 'accept-risk-moot',
      wi: null,
      key: e.id,
      trigger: `the decision on ${e.id} accepts task ${t.id}'s re-bound version with its risks, but ${by === null ? 'no user, PM or Secretary decided it' : 'that re-bind is no longer the one under review'}`,
      defaultAction: `nothing is accepted; the decision is closed. Task ${t.id} goes on from where it is now`,
      detail: { task: t.id, attempt: k, escalation: e.id },
    });
    await markApplied(ctx, e.id, { option: 'accept-risk', moot: true });
    return;
  }
  const words = by === 'pm' ? (d.words ?? []).map((w) => w.id).join(',') : by === 'user' ? /\((W-[0-9]+)\)\s*$/.exec(d.reason)?.[1] : undefined;
  const ruling = rulingJudgmentId(e.id, by);
  const risks = e.reasons.map((x) => `accepted with its risk by ${d.by === 'user' ? `the user${words !== undefined ? ` (${words})` : ''}` : d.by === 'pm' ? 'the PM' : 'the Secretary'} on ${e.id}: ${x}`);
  const body: ReboundBody = { k, n: rb.n, product: rb.product, judgment: ruling, how: 'review', decision: { escalation: e.id, option: 'accept-risk', by: d.by, ...(words !== undefined ? { words } : {}) }, risks };
  // 4.4 (G5): one open item per risk accepted, in the same write
  const items = await acceptanceItems(ctx, t.id, k, e.id, e.reasons, risk.review);
  await commitCarrying(
    ctx,
    `flow:rebound-risk:${ctx.mission}:task:${idPart(t.id)}:${rebind}`,
    [ev(ctx, taskLine(t.id), 'rebound', rebind, body), ...items.first, ...await personItems(ctx, t, k)],
    [await carryOut(ctx, e.id, { option: 'accept-risk', risks: [...e.reasons] })],
  );
  await writeItemBatches(ctx, items.rest);
}

/**
 * "accept-risk" on a task's escalation (4.1.3, #35, E-1): the decision accepts the attempt's verified
 * product; the open findings go to the risk list, quoted on the acceptance; the work goes on. The
 * decision is the user's or the Secretary's and is recorded as such: its ruling (the decider's pass that
 * overrules the Reviewer's position, flow/secretary.ts carryOut) is written in the same write, and the
 * acceptance names it. No review judgment is written in the Reviewer's place.
 */
async function acceptWithRisk(ctx: FlowCtx, eff: EffectiveBody, plan: DetailedPlanDoc, t: DetailedTask, k: number, e: EscalationBody, d: DecisionBody, waived: ReadonlySet<string>): Promise<void> {
  const moot = async (why = 'that attempt has no verified product to accept any more'): Promise<void> => {
    // the attempt moved since the escalation was raised (a re-plan, another decision): nothing is accepted
    await notify(ctx, {
      category: 'accept-risk-moot',
      wi: null,
      key: e.id,
      trigger: `the decision on ${e.id} accepts attempt ${k} of task ${t.id} with its risks, but ${why}`,
      defaultAction: `nothing is accepted; the decision is closed. Task ${t.id} goes on from where it is now`,
      detail: { task: t.id, attempt: k, escalation: e.id },
    });
    await markApplied(ctx, e.id, { option: 'accept-risk', moot: true });
  };
  // a product whose program runs did not all pass is accepted only on the PM's or the user's decision (pmOnly)
  const runsByPm = (e.pmOnly ?? []).includes('accept-risk') && (d.by === 'pm' || d.by === 'user');
  const risk = (await riskAcceptable(ctx, t, k)) ?? (runsByPm ? await failedRunsRisk(ctx, t, k) : null);
  if (risk === null) return moot();
  // the decision accepts the product as it is, never ahead of the dependency gate a Reviewer's pass goes through:
  // each dependency accepted now (one reopened since waits to be accepted again, sol review P1 r2), stable
  // mode's proof (dependencyGate); an integration's start must hold its dependencies' current work (#41), and
  // work that started on a dependency's hand-back in review (startOnHandback) is accepted once that version is
  // (sol review r1). Meanwhile the decision stays recorded, not carried out; a start that went stale closes it
  // with the attempt (nextAttemptOf)
  const depIds = await taskDependencies(ctx, plan, t);
  const line = await readLine(ctx, t.id);
  if (t.kind === 'integration' && (await integrationRestart(ctx, eff, t, line, k, depIds)) === 'restarted') return;
  if ((await dependencyGate(ctx, eff, plan, t, line, depIds, waived)) === null) return;
  if (t.kind !== 'integration') {
    const early = await earlyStart(ctx, t, line, k, depIds);
    if (early === 'wait') return;
    if (early !== null) return rebuildOnAccepted(ctx, t, k, early);
  }
  // only the user or the Secretary accepts with a risk: nothing is accepted in the program's name
  const by = deciderOf(d.by);
  if (by === null) return moot('no user or Secretary decided it');
  const words = by === 'pm' ? (d.words ?? []).map((w) => w.id).join(',') : by === 'user' ? /\((W-[0-9]+)\)\s*$/.exec(d.reason)?.[1] : undefined;
  // the decider's ruling, written by carryOut in this write (flow/secretary.ts deciderJudgment): the same id here
  const ruling = rulingJudgmentId(e.id, by);
  const risks = e.reasons.map((x) => `accepted with its risk by ${d.by === 'user' ? `the user${words !== undefined ? ` (${words})` : ''}` : d.by === 'pm' ? 'the PM' : 'the Secretary'} on ${e.id}: ${x}`);
  // 4.4 (G5): one open item per risk accepted, in the same write
  const items = await acceptanceItems(ctx, t.id, k, e.id, e.reasons, acceptedReview(line, k, Infinity));
  await commitCarrying(
    ctx,
    `flow:accepted-risk:${ctx.mission}:task:${idPart(t.id)}:${k}`,
    [ev(ctx, taskLine(t.id), 'accepted', String(k), { k, product: risk.product, judgment: ruling, decision: { escalation: e.id, option: 'accept-risk', by: d.by, ...(words !== undefined ? { words } : {}) }, risks }), ...items.first, ...await personItems(ctx, t, k)],
    [await carryOut(ctx, e.id, { option: 'accept-risk', risks: [...e.reasons] })],
  );
  await writeItemBatches(ctx, items.rest);
}

/**
 * 4.4 (G5): the open items an acceptance with risk leaves, one per distinct reason (flow/riskItems.ts): the first
 * ITEM_BATCH go in the acceptance's own write (the same deterministic records on every run of it), the rest in
 * writes of their own right after it (writeItemBatches; riskItemsLeft writes on a later pass what an interruption
 * left out). Nothing else in the acceptance changes.
 */
async function acceptanceItems(ctx: FlowCtx, task: string, k: number, escalation: string, reasons: readonly string[], review: string | undefined): Promise<{ readonly first: FlowEventInput[]; readonly rest: RiskItemBody[] }> {
  const bodies = await itemBodiesOf(ctx, task, k, escalation, reasons, review);
  return { first: bodies.slice(0, ITEM_BATCH).map((b) => ev(ctx, OPEN_ITEMS_LINE, OPEN_ITEM, b.id, b)), rest: bodies.slice(ITEM_BATCH) };
}

/**
 * The items of an acceptance with risk resting on `review` (a review of the task's line): one per reason, the issue
 * each finding became, and (p10-1) no new item only for an item that review answered not fixed (it is carried).
 * The writer and the later pass that completes its batches derive them alike; riskRecord reads them the same way.
 */
async function itemBodiesOf(ctx: FlowCtx, task: string, k: number, escalation: string, reasons: readonly string[], review: string | undefined): Promise<RiskItemBody[]> {
  const body = review === undefined ? undefined : (await eventOf<ReviewBody>(ctx, taskLine(task), 'review', review))?.body;
  // 4.4 (F10): a standard that could not be verified, from the structured copy (the escalation's facts, the review's)
  const facts = (await eventOf<EscalationBody>(ctx, SECRETARY_LINE, 'escalation', escalation))?.body.facts;
  return riskItemBodies(task, k, escalation, reasons, await findingIssues(ctx, review), carriedBy(body), unverifiableOf(facts, body));
}

/**
 * 4.4 (F10): the open items of the standards a person checks, for the write that accepts attempt k of the task (by
 * a pass or by a ruling): one per accepted attempt and standard, those not recorded yet (a re-bind of the attempt writes
 * none again). Nothing waits for them; they block nothing.
 */
async function personItems(ctx: FlowCtx, t: DetailedTask, k: number): Promise<FlowEventInput[]> {
  const bodies = personItemBodies(t, k);
  if (bodies.length === 0) return [];
  const recorded = new Set((await eventsOf(ctx, OPEN_ITEMS_LINE, OPEN_ITEM)).map((x) => x.key));
  return bodies.filter((b) => !recorded.has(b.id)).map((b) => ev(ctx, OPEN_ITEMS_LINE, OPEN_ITEM, b.id, b));
}

/**
 * 4.4 (G5, p10-5): the issue records the findings of a review's hand-back became ("finding: <text>" → its issue id),
 * so an item of a finding names its issue and a taking task's answer reaches the fix tracker. Empty when the
 * hand-back cannot be read (the item then names none).
 */
async function findingIssues(ctx: FlowCtx, review: string | undefined): Promise<ReadonlyMap<string, string>> {
  if (review === undefined) return new Map();
  const hb = (await ctx.ports.scheduler.status(review))?.handBack;
  const findings = ((hb?.result ?? null) as ReviewerResult | null)?.findings ?? [];
  const issues = (hb?.records ?? []).flatMap((r) => (r.kind === 'issue' ? [r.issue as string] : []));
  if (findings.length !== issues.length) return new Map();
  return new Map(findings.map((f, i) => [`finding: ${f}`, issues[i]!]));
}

/**
 * 4.4 (G5, p10-5): how a card finds the issue each item it lists is about: the item's own record, else (a finding of
 * an acceptance made before 4.4) the issue record of those words on the product accepted. The issue records are read
 * only when a listed item needs them.
 */
async function cardIssues(ctx: FlowCtx, events: Parameters<typeof riskItemsOf>[0], names: readonly string[]): Promise<(i: RiskItem) => string | undefined> {
  if (!riskItemsOf(events).some((i) => names.includes(i.id) && i.kind === 'finding' && itemIssue(i) === undefined)) return itemIssue;
  const c = ctx.ports.ledger.content;
  const notes: IssueNote[] = (await ctx.ports.ledger.records(['issue'])).map(({ record }) => {
    const r = record as IssueRecord;
    let text: string | null = null;
    try { if (r.text !== undefined) text = (JSON.parse(c.get(r.text)) as { text?: string }).text ?? null; } catch { /* the words are not readable: not this finding's */ }
    return { issue: r.issue as string, observedOn: c.getList(r.observedOn), text };
  });
  return issueResolver(events, notes);
}

/** The review an acceptance of attempt k rests on: the one it names as adopted, else the attempt's last review before it. */
function acceptedReview(line: Line, k: number, before: number, adopted?: string): string | undefined {
  return adopted ?? line.all<ReviewBody>('review').filter((r) => r.body.k === k && r.revision < before).at(-1)?.key;
}

/** 4.4 (G5): open items not recorded yet, in bounded writes (an append takes at most 1,000 records), each under the operation id of its own items. */
async function writeItemBatches(ctx: FlowCtx, bodies: readonly RiskItemBody[], requires?: string): Promise<void> {
  if (bodies.length === 0) return;
  const existing = new Set((await eventsOf(ctx, OPEN_ITEMS_LINE, OPEN_ITEM)).map((x) => x.key));
  // an acceptance made under 4.3 wrote no first batch: nothing is written for it (its sentences are listed as not recorded)
  if (requires !== undefined && !existing.has(requires)) return;
  const missing = bodies.filter((b) => !existing.has(b.id));
  for (let i = 0; i < missing.length; i += ITEM_BATCH) {
    const batch = missing.slice(i, i + ITEM_BATCH);
    await commit(ctx, `flow:risk-items:${ctx.mission}:${shortHash(batch.map((b) => b.id))}`, { events: batch.map((b) => ev(ctx, OPEN_ITEMS_LINE, OPEN_ITEM, b.id, b)) });
  }
}

/** 4.4 (G5): the items past the first batch of each acceptance with risk on the task's line, written when an interruption left them out (only such an acceptance is read again). */
async function riskItemsLeft(ctx: FlowCtx, t: DetailedTask, line: Line): Promise<void> {
  for (const e of [...line.all<{ k: number; decision?: { escalation: string; option?: string }; risks?: string[]; review?: string }>('accepted'), ...line.all<ReboundBody & { review?: string }>('rebound')]) {
    const d = e.body.decision;
    if (d?.option !== 'accept-risk' || (e.body.risks ?? []).length <= ITEM_BATCH) continue;
    const bodies = await itemBodiesOf(ctx, t.id, e.body.k, d.escalation, acceptanceReasons(e.body, d.escalation), acceptedReview(line, e.body.k, e.revision, e.body.review));
    if (bodies.length > ITEM_BATCH) await writeItemBatches(ctx, bodies.slice(ITEM_BATCH), bodies[0]!.id);
  }
}

/** The latest review reopen whose integration still waits at its undispatched rebuild. */
async function waitingReopenRisk(ctx: FlowCtx, dependency: string, attempt: number, source?: ReopenSource) {
  const all = await ctx.ports.ledger.events<ReopenBody>({ mission: ctx.mission, event: 'reopen' });
  for (const event of [...all].reverse()) {
    if (!event.line.startsWith('task:')) continue;
    const integration = event.line.slice('task:'.length);
    if (source !== undefined && (source.kind !== 'review' || source.integration !== integration || source.attempt !== event.body.k || source.review !== event.body.review)) continue;
    const line = await readLine(ctx, integration);
    const latest = line.all<ReopenBody>('reopen').at(-1);
    const rw = line.one<ReworkBody>('rework', String(line.k));
    if (latest?.key !== event.key || latest.revision <= (line.all('spec').at(-1)?.revision ?? 0) || line.abandoned ||
        !latest.body.tasks.some((x) => x.task === dependency && x.attempt === attempt) ||
        line.k !== latest.body.k + 1 || rw?.reason !== 'rebuild' ||
        line.all<DispatchedBody>('dispatched').some((x) => x.body.k === line.k) ||
        line.one('product', String(line.k)) !== null || line.one('accepted', String(line.k)) !== null) continue;
    const product = await reviewedProduct(ctx, line, latest.body.k);
    const review = line.one<ReviewBody>('review', latest.body.review);
    if (product !== null && review !== null) return { integration, line, product, review };
  }
  return null;
}

/** A review-reopen ruling accepts the product actually reviewed, with that review's findings. */
async function acceptReopenWithRisk(ctx: FlowCtx, plan: DetailedPlanDoc, dependency: DetailedTask, attempt: number, e: EscalationBody, d: DecisionBody): Promise<void> {
  const waiting = await waitingReopenRisk(ctx, dependency.id, attempt, (e.facts as { reopen?: ReopenSource } | undefined)?.reopen);
  const by = deciderOf(d.by);
  const moved = (await readLine(ctx, dependency.id)).k !== attempt;
  if (moved || waiting === null || !plan.tasks.some((t) => t.id === waiting.integration && t.kind === 'integration') || by === null || e.position?.target !== waiting.product.object || e.position.revokes !== waiting.review.judgment) {
    await notify(ctx, { category: 'accept-risk-moot', wi: null, key: e.id,
      trigger: moved ? `task ${dependency.id} moved beyond attempt ${attempt}; ${e.id} cannot accept its integration's older reviewed start` : `no integration waits for the review reopen of ${dependency.id} attempt ${attempt} on ${e.id}`,
      defaultAction: 'nothing is accepted; the decision is closed', detail: { escalation: e.id } });
    await markApplied(ctx, e.id, { option: 'accept-risk', moot: true });
    return;
  }
  const { integration, line, product, review } = waiting;
  const task = plan.tasks.find((t) => t.id === integration);
  const record = await objectRecord(ctx, product.object);
  const pins = record === null ? [] : ctx.ports.ledger.content.getList(record.prerequisites);
  const missing: string[] = [];
  if (task === undefined) missing.push(integration);
  else {
    const dependencies = new Set([...(await taskDependencies(ctx, plan, task)), ...reopenEntries(line).keys()]);
    // The reviewed start includes the whole prerequisite closure, not just direct dependencies.
    for (const dep of dependencies) {
      const spec = plan.tasks.find((t) => t.id === dep);
      for (const parent of spec?.dependsOn ?? []) dependencies.add(parent);
      const accepted = await acceptedProduct(ctx, dep);
      if (accepted === null || !pins.includes(accepted)) missing.push(dep);
    }
  }
  if (missing.length > 0) {
    await notify(ctx, { category: 'accept-risk-waits', wi: null, key: e.id,
      trigger: `accept-risk on ${e.id} waits: ${missing.join(', ')} must still be accepted at the versions reviewed in ${product.object}`,
      defaultAction: 'the decision is kept and checked on every pass', detail: { escalation: e.id, integration, dependencies: missing } });
    return;
  }
  const words = by === 'pm' ? (d.words ?? []).map((w) => w.id).join(',') : by === 'user' ? /\((W-[0-9]+)\)\s*$/.exec(d.reason)?.[1] : undefined;
  // 4.4 (G5, p10-1): the ruling accepts every reason of the escalation it decides (the dependency's reopen among them),
  // as the other acceptances with risk quote theirs; one open item per risk, on the integration task that is accepted,
  // in the same write. The acceptance names the review it adopts, whose attempt and answers its outcome reads.
  const risks = e.reasons.map((x) => `accepted with its risk by ${by === 'user' ? `the user${words !== undefined ? ` (${words})` : ''}` : d.by === 'pm' ? 'the PM' : 'the Secretary'} on ${e.id}: ${x}`);
  const items = await acceptanceItems(ctx, integration, line.k, e.id, e.reasons, review.task);
  await commitCarrying(ctx, `flow:accepted-risk:${ctx.mission}:task:${idPart(integration)}:${line.k}`,
    [
      // Adopt the reviewed product at this attempt, preserving its actual source dispatch.
      // Renewal and kept-product rebinds then read the same body as any accepted attempt.
      ev(ctx, taskLine(integration), 'product', String(line.k), { ...product, k: line.k } satisfies ProductBody),
      ev(ctx, taskLine(integration), 'accepted', String(line.k), { k: line.k, product: product.object, judgment: rulingJudgmentId(e.id, by), decision: { escalation: e.id, option: 'accept-risk', by: d.by, ...(words !== undefined ? { words } : {}) }, risks, review: review.task }),
      ...items.first,
      ...(task === undefined ? [] : await personItems(ctx, task, line.k)),
    ],
    // p10-1 (round 2): the decision's receipt names every reason it accepted, as the acceptance does
    [await carryOut(ctx, e.id, { option: 'accept-risk', risks: [...e.reasons] })]);
  await writeItemBatches(ctx, items.rest);
}

/**
 * The latest reopen of each dependency an integration review reopened under the task's current card and
 * since the task was last accepted: an acceptance after a reopen (its rebuild, or a ruling that accepted the
 * reviewed attempt with the reopen's risks) settles it, so a later attempt (a repair's) does not wait for it.
 */
function reopenEntries(line: Line): Map<string, { readonly task: string; readonly attempt: number; readonly product: string; readonly issue: string; readonly evidence?: string }> {
  const spec = line.all('spec').at(-1)?.revision ?? 0;
  const settled = line.all('accepted').at(-1)?.revision ?? 0;
  const out = new Map<string, { readonly task: string; readonly attempt: number; readonly product: string; readonly issue: string; readonly evidence?: string }>();
  for (const e of line.all<ReopenBody>('reopen')) if (e.revision > spec && e.revision > settled) for (const x of e.body.tasks) out.set(x.task, x);
  return out;
}

/**
 * The current accepted products of the dependencies the task's integration reviews reopened, or null
 * while one of them is not accepted again since (its new attempt, or the Secretary after its rework
 * loop is used up). A reopened task the plan in effect no longer has is left out; one given up keeps
 * the integration waiting, told to the PM (a re-plan or a repair routes the work).
 */
async function reopenedProducts(ctx: FlowCtx, plan: DetailedPlanDoc, t: DetailedTask, line: Line): Promise<string[] | null> {
  const out: string[] = [];
  for (const x of reopenEntries(line).values()) {
    if (!plan.tasks.some((p) => p.id === x.task)) continue;
    const dep = await readLine(ctx, x.task);
    if (dep.abandoned) {
      await notify(ctx, {
        category: 'reopened-task-abandoned',
        wi: WI.loopExhausted,
        key: `${t.id}:${x.task}:${x.attempt}`,
        trigger: `integration task ${t.id} waits for task ${x.task}, which its review reopened, but ${x.task} was given up`,
        defaultAction: `only task ${t.id} waits; the rest of the mission continues. A re-plan (mp pm plan submit) or a repair (mp pm repair) routes the work that the reopen asked for`,
        detail: { task: t.id, reopened: x.task, attempt: x.attempt, issue: x.issue },
      });
      return null;
    }
    if (dep.k <= x.attempt) return null;
    const p = await acceptedProduct(ctx, x.task);
    if (p === null) return null;
    out.push(p);
  }
  return out;
}

/**
 * An integration review that traces the failure to dependencies (D-6): the decision record (the
 * task line's "reopen") and the integration's next attempt, which waits for them, are one write;
 * each named task's new attempt follows (carryReopens, restartable). A named task no longer accepted
 * (it moved since the card was built) is left out; with none left, the Secretary decides.
 */
async function reopenFromReview(ctx: FlowCtx, plan: DetailedPlanDoc, t: DetailedTask, k: number, rev: string, review: ReviewBody, product: ProductBody): Promise<void> {
  const lineName = taskLine(t.id);
  const entries: Array<ReopenBody['tasks'][number]> = [];
  const skipped: string[] = [];
  for (const x of review.reopen ?? []) {
    const dep = await readLine(ctx, x.task);
    const acc = dep.abandoned || !plan.tasks.some((p) => p.id === x.task) ? null : currentAcceptance(dep, dep.k);
    if (acc === null) {
      skipped.push(x.task);
      continue;
    }
    entries.push({ task: x.task, attempt: dep.k, product: acc.product, issue: x.issue, ...(x.evidence !== undefined ? { evidence: x.evidence } : {}) });
  }
  if (entries.length === 0) return reviewerNeedsDecision(ctx, t, k, rev, review, product, `its review reopens ${skipped.join(', ')}, which ${skipped.length === 1 ? 'is' : 'are'} not accepted any more`);
  const body: ReopenBody = { k, review: rev, tasks: entries };
  const rebuild: ReworkBody = {
    k: k + 1,
    reason: 'rebuild',
    issues: startOnly(await readLine(ctx, t.id), product) ? [] : [...review.issues],
    instructions: [`The integration review ${rev} reopened ${entries.map((e) => e.task).join(', ')}: this attempt starts once ${entries.length === 1 ? 'it is' : 'they are'} accepted again, from the new work.`],
    reopen: { kind: 'review', integration: t.id, review: rev, attempt: k },
  };
  await commit(ctx, `flow:reopen:${ctx.mission}:task:${idPart(t.id)}:${k}`, { events: [ev(ctx, lineName, 'reopen', String(k), body), ev(ctx, lineName, 'rework', String(k + 1), rebuild)] });
  if (skipped.length > 0) {
    await notify(ctx, {
      category: 'reopen-skipped',
      wi: null,
      key: `${rev}:${skipped.join(',')}`,
      trigger: `the review ${rev} of integration task ${t.id} reopens ${skipped.join(', ')}, which ${skipped.length === 1 ? 'is' : 'are'} not accepted any more`,
      defaultAction: `the other named tasks are reopened (${entries.map((e) => e.task).join(', ')}); the integration builds again on their new work`,
      detail: { task: t.id, review: rev, skipped },
    });
  }
  await carryReopens(ctx, plan);
}

/** Reopens represented by this escalation, from the kept verdicts of this task attempt. */
function coveredReopens(ctx: FlowCtx, task: string, line: Line, e: { readonly body: EscalationBody; readonly revision: number }): string[] {
  // 4.4 (G3, F2): one pure mapping, which the cards and `mp read repairs` read too (seat/cards/dynamic.ts)
  return coveredReopenKeys(ctx.mission, task, line.events, e);
}

/** One reopened task's new attempt (D-6), counted on its rework loop (used up: WI-08 and the Secretary); restartable by `key`. A repair's: repairReopen. */
async function reopenTask(ctx: FlowCtx, plan: DetailedPlanDoc, r: ReopenRequest): Promise<void> {
  const t = plan.tasks.find((x) => x.id === r.task);
  // the plan in effect no longer has it (a re-plan dropped it): the reopen is moot
  if (t === undefined) return;
  const line = await readLine(ctx, r.task);
  // it moved on (its new attempt is this one, or a re-plan restarted it), or it was given up: nothing to do
  if (line.abandoned || line.k !== r.attempt || line.one('accepted', String(r.attempt)) === null) return;
  if (await coveredVerdict(ctx, line, r)) return;
  // No escalation covers this request: retry after a collision or an interrupted write.
  await rework(ctx, t, r.attempt, [r.issue], [r.instruction], r.key, { reason: 'reopen', reopen: r.source });
}

/** A request whose kept verdict found its loop used up, and whose escalation exists (it waits for that decision). */
async function coveredVerdict(ctx: FlowCtx, line: Line, r: ReopenRequest): Promise<boolean> {
  if (line.one<{ proceed: boolean }>('loop-verdict', r.key)?.proceed !== false) return false;
  const escalations = await eventsOf<EscalationBody>(ctx, SECRETARY_LINE, 'escalation');
  return escalations.some((e) => coveredReopens(ctx, r.task, line, e).includes(r.key));
}

/*
 * 4.4 (F13): a repair's reopen request (repair R, task T) is in one of three states, read from the repairs line.
 * A reopen always waits for T's open attempt and opens the next one; it never joins an open attempt.
 *   requested(a)  R's decision, or the request's latest `reopen-pinned` (a): it waits for T's attempt a to be accepted
 *   carried(c)    its latest `reopen-carried` (c): T's attempt c was opened with R's issue on its card. Final once a
 *                 seat took c (its Constructor or Reviewer was claimed, or it was reviewed); until then it is read as
 *                 requested(c), so an issue is never settled before a seat saw it (p7-3)
 *   not carried   `reopen-not-carried`: final; the notice goes to the PM's inbox
 * Each move is one append whose record is keyed by the request and its sequence number (`<R>:<T>#<n>`): its guard
 * checks inside the write that no record #n of any kind exists (two passes make a move at most once, and a pass that
 * read an older state writes nothing, p7-r2-1), that the plan in effect is still the revision the pass read, and:
 *   requested(a) → carried(k+1)  T accepted at its current attempt k ≥ a: T's rework k+1 with R's issue and
 *                                `reopen-carried` (k+1), one write. Checks: no rework k+1 on T's line
 *   requested(a) → requested(k)  T's current attempt k > a is open: `reopen-pinned` (k). Checks: no rework k+1
 *   → not carried                T given up, or not in the plan in effect: `reopen-not-carried`. Checks: T's card is
 *                                the one read (its latest spec, so a giving-up still holds); the PM's notice is sent
 *                                from the committed record, once (p7-r2-2)
 * A request of a 4.3 decision (no `tracked`) that 4.4 never wrote to keeps 4.3's ways: 4.3's counted return, and when
 * its task was accepted past it, it was left out (told as not carried out). No reopen of a 4.3 decision, and none 4.3
 * counted, holds a dependent (p7-r2-3).
 */
type RequestState =
  | { readonly kind: 'requested'; readonly at: number }
  | { readonly kind: 'carried'; readonly at: number; readonly taken: boolean }
  | { readonly kind: 'not-carried' };

/** Where a repair's reopen request stands (the states above); `taken`: a seat took the carried attempt. */
async function requestState(ctx: FlowCtx, line: Line, r: ReopenRequest): Promise<RequestState> {
  if (r.source.kind !== 'repair') return { kind: 'requested', at: r.attempt };
  if (r.state === 'not-carried') return { kind: 'not-carried' };
  if (r.state === 'carried') return { kind: 'carried', at: r.attempt, taken: await attemptTaken(ctx, r.task, line, r.attempt) };
  // a request 4.3 carried out: its task's attempt opened by its reopen (counted by 4.3; the issue on its card)
  if (!r.tracked) {
    const repair = r.source.repair;
    const opened = line.all<ReworkBody>('rework').find((x) => x.body.reopen?.kind === 'repair' && x.body.reopen.repair === repair && x.body.k > r.attempt);
    if (opened !== undefined) return { kind: 'carried', at: opened.body.k, taken: true };
  }
  return { kind: 'requested', at: r.attempt };
}

/**
 * Whether a reopen request a 4.4 decision made has still to reach its task: requested, or carried on an attempt no
 * seat took that the task moved past or that was accepted as it was (the next pass moves it on). A reopen of a 4.3
 * decision, or one 4.3 counted, holds nothing (p7-r2-3): no wait comes of it that 4.3 would not have had.
 */
async function waitingRequest(ctx: FlowCtx, line: Line, r: ReopenRequest): Promise<boolean> {
  if (r.source.kind !== 'repair' || !r.by44 || line.abandoned || countedBy43(line, r)) return false;
  const s = await requestState(ctx, line, r);
  return s.kind === 'requested' || (s.kind === 'carried' && !s.taken && (line.k > s.at || line.one('accepted', String(s.at)) !== null));
}

/** A repair's reopen 4.3 counted on the task's loop: its marker or its verdict (two writes; either one, p7-7). 4.4 never counts one. */
function countedBy43(line: Line, r: ReopenRequest): boolean {
  return line.one('loop-verdict', r.key) !== null || line.one('loop-return', r.key) !== null;
}

/** Whether a seat took attempt k of the task: its Constructor or its Reviewer was claimed, or it was reviewed. */
async function attemptTaken(ctx: FlowCtx, task: string, line: Line, k: number): Promise<boolean> {
  if (line.all<ReviewBody>('review').some((v) => v.body.k === k)) return true;
  for (const step of [conTask(ctx.mission, task, k), revTask(ctx.mission, task, k, 0)]) if (((await ctx.ports.scheduler.status(step))?.dispatches ?? []).length > 0) return true;
  return false;
}

/** The guard code of a move another writer made first (the request or the task moved on): nothing is written, the next pass reads it again. */
const MOVED_ON = 'REOPEN_MOVED_ON';

/** The plan in effect a pass of execution read: its revision guards every move of a request. */
interface PlanRead {
  readonly plan: DetailedPlanDoc;
  readonly revision: number | null;
}

/**
 * 4.4 (F12 a, F13): a repair's reopen of one task (the states above). It is new work on the user's words, so it is
 * not counted on the task's rework loop: the attempt it opens starts a fresh loop (reworkLineage). A reopen 4.3
 * already counted (its marker or its verdict) goes on as 4.3 ran it.
 */
async function repairReopen(ctx: FlowCtx, read: PlanRead, r: ReopenRequest): Promise<void> {
  if (r.source.kind !== 'repair') return;
  const t = read.plan.tasks.find((x) => x.id === r.task);
  const line = await readLine(ctx, r.task);
  const s = await requestState(ctx, line, r);
  // carried out (a seat took the attempt that carries it), or not carried out: final
  if (s.kind === 'not-carried' || (s.kind === 'carried' && s.taken)) return;
  // 4.3 counted it (p7-7: the marker and the verdict are two writes; either one means 4.3's counted return)
  if (countedBy43(line, r)) {
    if (t === undefined || line.abandoned || line.k !== r.attempt || line.one('accepted', String(r.attempt)) === null || (await coveredVerdict(ctx, line, r))) return;
    await rework(ctx, t, r.attempt, [r.issue], [r.instruction], r.key, { reason: 'reopen', reopen: r.source });
    return;
  }
  if (t === undefined) return reopenNotCarried(ctx, read, r, line, 'the plan in effect no longer has the task');
  if (line.abandoned) return reopenNotCarried(ctx, read, r, line, 'the task was given up');
  const k = line.k;
  const from = s.at;
  if (k < from) return;
  // a decision of 4.3 that 4.4 never wrote to, whose task was accepted again past it, was left out by 4.3: told, not revived (p7-1)
  if (!r.tracked && line.all<{ k: number }>('accepted').some((a) => a.body.k > from)) return reopenNotCarried(ctx, read, r, line, 'the task was accepted again at a later attempt before this reopen was carried out (a version before 4.4 left it out)');
  // the attempt it waits for is accepted (or, carried on an attempt no seat took, that attempt was accepted as it was,
  // or the task moved past it to an accepted one): the next attempt opens with its issue
  if (line.one('accepted', String(k)) !== null) return carryReopen(ctx, read, t, line, r, k);
  // the attempt it waits for is open, or the attempt that carries it is: it waits
  if (k === from) return;
  // its task moved past that attempt to an open one (queued, claimed or in review): someone else's work, the reopen
  // waits for it to be accepted (p7-3: an issue carried on an attempt no seat took goes on to the next one)
  await requestMove(ctx, read, r, line, { event: REOPEN_PINNED, body: { repair: r.source.repair, task: t.id, attempt: k, from } satisfies ReopenPinnedBody }, [{ mission: ctx.mission, line: taskLine(t.id), event: 'rework', key: String(k + 1) }]);
}

/**
 * One move of a request (the states above): its record keyed `<R>:<T>#<n+1>`, with `extra` events in the same write.
 * The guard: no record #n+1 of any kind yet (another pass moved it first), the plan in effect as read, the task
 * state `absent` names. A move another writer made first is not an error: the next pass reads where things are.
 * The operation names the move itself, so the same move made twice is one write, and another move of the same
 * record is refused by the guard (never taken for a replay).
 */
async function requestMove<B extends { readonly attempt: number }>(ctx: FlowCtx, read: PlanRead, r: ReopenRequest, line: Line, record: { readonly event: string; readonly body: B }, absent: AppendGuard['absent'], extra: readonly FlowEventInput[] = [], latestSpec = false): Promise<boolean> {
  if (r.source.kind !== 'repair') return false;
  const key = `${r.source.repair}:${r.task}#${r.seq + 1}`;
  try {
    await commit(ctx, `flow:reopen:${ctx.mission}:${idPart(r.source.repair)}:${idPart(r.task)}:${r.seq + 1}:${record.event}:${record.body.attempt}`, {
      events: [...extra, ev(ctx, REPAIRS_LINE, record.event, key, record.body)],
      guard: {
        absent: [...absent, ...[REOPEN_PINNED, REOPEN_CARRIED, REOPEN_NOT_CARRIED].map((event) => ({ mission: ctx.mission, line: REPAIRS_LINE, event, key }))],
        latest: [
          { mission: ctx.mission, line: PLAN_LINE, event: 'effective', revision: read.revision },
          ...(latestSpec ? [{ mission: ctx.mission, line: taskLine(r.task), event: 'spec', revision: line.all('spec').at(-1)?.revision ?? null }] : []),
        ],
        code: MOVED_ON,
        message: `repair ${r.source.repair}'s reopen of task ${r.task}, or the task or the plan in effect, moved on meanwhile; nothing was written (the next pass reads it again)`,
      },
    });
    return true;
  } catch (e) {
    if ((e as { code?: string }).code !== MOVED_ON) throw e;
    return false;
  }
}

/** requested → carried: attempt k+1 of T opened with R's issue on its card, on a fresh loop (F12 a), after the tasks it names (F12 b). */
async function carryReopen(ctx: FlowCtx, read: PlanRead, t: DetailedTask, line: Line, r: ReopenRequest, k: number): Promise<void> {
  if (r.source.kind !== 'repair') return;
  const product = currentAcceptance(line, k)?.product ?? r.product;
  const after = r.after.filter((x) => x !== t.id);
  const instructions = [
    `Reopened by repair ${r.source.repair}${r.repairText !== '' ? ` (${r.repairText})` : ''}: fix this in your task's work (your accepted product ${product} stays recorded until this attempt is accepted).`,
    ...(after.length > 0 ? [`This attempt starts once ${after.join(', ')} ${after.length === 1 ? 'is' : 'are'} accepted for the same repair, on ${after.length === 1 ? 'its' : 'their'} new work.`] : []),
    ...(await deferredInstructions(ctx, line, k)),
  ];
  const body: ReworkBody = { k: k + 1, reason: 'reopen', issues: [r.issue], instructions, reopen: r.source, loop: reopenLoopLineage(ctx.mission, t.id, k + 1), ...(after.length > 0 ? { after } : {}) };
  await requestMove(ctx, read, r, line, { event: REOPEN_CARRIED, body: { repair: r.source.repair, task: t.id, attempt: k + 1, from: r.attempt } satisfies ReopenCarriedBody }, [{ mission: ctx.mission, line: taskLine(t.id), event: 'rework', key: String(k + 1) }], [ev(ctx, taskLine(t.id), 'rework', String(k + 1), body)]);
}

/** → not carried: recorded under the guards of a move (the plan in effect and the task's card as read); the PM is told from the record (reopenNotices). */
async function reopenNotCarried(ctx: FlowCtx, read: PlanRead, r: ReopenRequest, line: Line, why: string): Promise<void> {
  if (r.source.kind !== 'repair') return;
  await requestMove(ctx, read, r, line, { event: REOPEN_NOT_CARRIED, body: { repair: r.source.repair, task: r.task, attempt: line.k, why } satisfies ReopenNotCarriedBody }, [], [], true);
}

/** The PM is told of every reopen recorded as not carried out, once, from its record (a lost notice is sent again). */
async function reopenNotices(ctx: FlowCtx): Promise<void> {
  for (const e of await eventsOf<ReopenNotCarriedBody>(ctx, REPAIRS_LINE, REOPEN_NOT_CARRIED)) {
    const b = e.body;
    await tellOnce(ctx, REPAIRS_LINE, {
      category: 'reopen-not-carried',
      wi: null,
      key: e.key,
      trigger: `repair ${b.repair}'s reopen of task ${b.task} was not carried out: ${b.why}`,
      defaultAction: `nothing is reopened for it and repair ${b.repair} does not read as done; the rest goes on. Tell the user what was not done; a new repair on their words (mp pm repair … --again) or a re-plan routes the work`,
      detail: { repair: b.repair, task: b.task, attempt: b.attempt, why: b.why },
    });
  }
}

/**
 * The reopen decisions carried out (D-6: an integration review's; D-10: a repair's): each named
 * task gets its new attempt once. Run on every pass, so a crash between a decision and its effects
 * loses nothing. The reopened task's other dependents keep their products and their proof (no
 * cascade): the integration's full run checks the combination.
 */
async function carryReopens(ctx: FlowCtx, plan: DetailedPlanDoc, read?: PlanRead): Promise<void> {
  // a repair's reopen moves only under the plan the pass read with its revision (the review's own reopen carries its at once)
  for (const r of await reopenRequests(ctx)) {
    if (r.source.kind === 'repair') {
      if (read !== undefined) await repairReopen(ctx, read, r);
    } else await reopenTask(ctx, plan, r);
  }
  if (read !== undefined) await reopenNotices(ctx);
}

/** One recorded reopen request (an integration review's or a repair's). */
interface ReopenRequest {
  readonly task: string;
  /** The attempt of its state: the one it waits for (requested: as decided, or as pinned again), or the one it opened (carried). */
  readonly attempt: number;
  /** A repair's (F13): its state as its latest record says (a review's: requested). */
  readonly state: 'requested' | 'carried' | 'not-carried';
  /** A repair's: the number of its 4.4 records (its next one is #seq+1). */
  readonly seq: number;
  /** A repair's: decided by 4.4, or written to by 4.4 since: none of 4.3's ways apply to it (p7-1). */
  readonly tracked: boolean;
  /** A repair's: its decision is 4.4's (`tracked` on it): only such a reopen holds the work of its repair (p7-r2-3). */
  readonly by44: boolean;
  readonly issue: string;
  readonly instruction: string;
  readonly key: string;
  readonly source: ReopenSource;
  /** The accepted product it was decided on. */
  readonly product: string;
  /** A repair's: the tasks of the same repair it comes after (F12 b; none before 4.4). */
  readonly after: readonly string[];
  /** A repair's: its kind and the user's words, for the instructions. */
  readonly repairText: string;
}

/** The recorded findings and requests, shared by reopening and a grant covering several reopens (one read of the repairs line). */
async function reopenRequests(ctx: FlowCtx): Promise<ReopenRequest[]> {
  const requests: ReopenRequest[] = [];
  for (const e of await ctx.ports.ledger.events<ReopenBody>({ mission: ctx.mission, event: 'reopen' })) {
    if (!e.line.startsWith('task:')) continue;
    const integration = e.line.slice('task:'.length);
    for (const x of e.body.tasks) {
      const issue = `${x.issue}${x.evidence !== undefined ? ` (evidence: ${x.evidence})` : ''}`;
      const instruction = `Reopened by the review ${e.body.review} of integration task ${integration} (attempt ${e.body.k}): fix this in your task's work (your accepted product ${x.product} stays recorded until this attempt is accepted); the integration task builds again on your new work.`;
      requests.push({ task: x.task, attempt: x.attempt, state: 'requested', seq: 0, tracked: true, by44: false, issue, instruction, key: `reopen:${integration}:${e.body.k}`, source: { kind: 'review', integration, review: e.body.review, attempt: e.body.k }, product: x.product, after: [], repairText: '' });
    }
  }
  const line = await eventsOf(ctx, REPAIRS_LINE);
  const repairs = new Map(line.filter((e) => e.event === 'repair').map((e) => [e.key, e.body as RepairBody]));
  // each request's 4.4 records, in order: the latest is its state
  const records = new Map<string, Array<{ readonly event: string; readonly attempt: number }>>();
  for (const e of line) {
    if (e.event !== REOPEN_PINNED && e.event !== REOPEN_CARRIED && e.event !== REOPEN_NOT_CARRIED) continue;
    const b = e.body as { repair: string; task: string; attempt: number };
    const id = `${b.repair}:${b.task}`;
    records.set(id, [...(records.get(id) ?? []), { event: e.event, attempt: b.attempt }]);
  }
  for (const e of line) {
    if (e.event !== 'decided') continue;
    const d = e.body as RepairDecidedBody;
    const r = repairs.get(d.repair);
    const repairText = r !== undefined ? `${r.kind}; the user's words ${r.words}: "${r.text}"` : '';
    for (const x of d.reopen) {
      const mine = records.get(`${d.repair}:${x.task}`) ?? [];
      const last = mine.at(-1);
      const state = last === undefined || last.event === REOPEN_PINNED ? 'requested' : last.event === REOPEN_CARRIED ? 'carried' : 'not-carried';
      const instruction = `Reopened by repair ${d.repair}${repairText !== '' ? ` (${repairText})` : ''}: fix this in your task's work (your accepted product ${x.product} stays recorded until this attempt is accepted).`;
      requests.push({ task: x.task, attempt: last?.attempt ?? x.attempt, state, seq: mine.length, tracked: d.tracked === true || mine.length > 0, by44: d.tracked === true, issue: x.issue, instruction, key: `reopen:repair:${d.repair}`, source: { kind: 'repair', repair: d.repair }, product: x.product, after: x.after ?? [], repairText });
    }
  }
  return requests;
}

/**
 * The repairs a task's work answers (D-10) and what was written for it: 4.4 (G3, F2) the repair that added the
 * task, those that changed its card, and those that reopened it at this attempt or before (seat/cards/dynamic.ts
 * repairsOfTaskWork); the instructions addressed to it or to those repairs, the Architect's notes and the answers
 * given under its earlier cards (writtenForTask).
 */
async function repairsOfWork(ctx: FlowCtx, eff: EffectiveBody, t: DetailedTask, line: Line, k: number): Promise<{ readonly repairs: RepairRef[]; readonly written: ReturnType<typeof writtenForTask> }> {
  const repairsLine = await eventsOf(ctx, REPAIRS_LINE);
  const ids = repairsOfTaskWork(ctx.mission, eff.amendments, t.id, line.events, await eventsOf(ctx, SECRETARY_LINE), repairsLine, k);
  const all = repairsLine.filter((e) => e.event === 'repair') as Array<{ readonly key: string; readonly body: RepairBody }>;
  const events = await ctx.ports.ledger.events({ mission: ctx.mission });
  // 4.4 (G3, G4): a 4.3 decision has no note; its Architect's accepted hand-back has one (one not readable is left out)
  const notes43 = new Map<string, string | null>();
  for (const step of stepsOfNotes43(events, ids)) {
    try {
      notes43.set(step, noteOfHandBack((await ctx.ports.scheduler.status(step))?.handBack));
    } catch {
      notes43.set(step, null);
    }
  }
  const written = writtenForTask(await currentConstraints(ctx), events, ctx.mission, t.id, ids, (step) => notes43.get(step) ?? null);
  return { repairs: all.filter((r) => ids.includes(r.key)).map((r) => repairRef(r.body)), written };
}

/** 4.4 (G3): a Reviewer's answers to the instructions addressed to its work, each with the version its claimed card showed. */
async function instructionAnswers(ctx: FlowCtx, dispatch: string | undefined, responses: NonNullable<ReviewerResult['instruction_responses']>): Promise<NonNullable<ReviewBody['instructions']>> {
  if (responses.length === 0) return [];
  const claimed = dispatch === undefined ? null : await eventOf<{ spec: string }>(ctx, `dispatch:${dispatch}`, 'claimed', 'spec');
  const card = claimed === null ? null : (JSON.parse(ctx.ports.ledger.content.get(claimed.body.spec)) as { card?: { addressed?: Array<{ id: string; version: string }> } }).card;
  return responses.map((i) => {
    const version = card?.addressed?.find((a) => a.id === i.instruction)?.version;
    return { instruction: i.instruction, ...(version !== undefined ? { version } : {}), response: i.response, reason: i.reason };
  });
}

/** A Reviewer's accepted hand-back as the task line's "review" event (null: it carries no judgment, a defect told to the PM). */
async function takeReview(ctx: FlowCtx, t: DetailedTask, k: number, rev: string, view: Extract<Awaited<ReturnType<typeof taskView>>, { kind: 'done' }>): Promise<ReviewBody | null> {
  const r = view.result as ReviewerResult;
  const judgment = view.status.handBack?.records.find((x) => x.kind === 'judgment' && x.judgment === `j.${rev}`);
  if (judgment?.kind !== 'judgment') {
    await internalError(ctx, rev, `the accepted Reviewer hand-back of ${rev} has no judgment j.${rev}`);
    return null;
  }
  // 4.4 (G5): an open item the task took and its Reviewer did not answer fixed goes back with the issues
  const items: ItemAnswer[] = (r.item_responses ?? []).map((i) => ({ item: i.item, response: i.response, reason: i.reason }));
  // 4.4 (F10): a standard the Reviewer could not verify, with what would be needed, in the form of a standard not met
  const unverifiable = r.judgments.filter((j) => j.met === 'cannot-verify').map((j) => ({ standard: j.standard, reason: j.reason, needed: j.needed ?? '' }));
  const issues = [
    ...r.judgments.filter((j) => j.met !== 'yes').map((j) => (j.met === 'cannot-verify' ? unverifiableLine({ standard: j.standard, reason: j.reason, needed: j.needed ?? '' }) : `[${j.standard}] ${j.met === 'no' ? 'not met' : 'unclear'}: ${j.reason}`)),
    ...r.findings.map((f) => `finding: ${f}`),
    ...r.issue_responses.filter((i) => i.response === 'not-fixed').map((i) => `issue ${i.issue} not fixed: ${i.reason}`),
    ...items.filter((i) => i.response !== 'fixed').map(itemIssueLine),
  ];
  const deferred = r.issue_responses.filter((i) => i.response === 'deferred').map((i) => `issue ${i.issue} deferred to ${i.owner}: ${i.reason}`);
  const reopen = (r.reopen ?? []).map((x) => ({ task: x.task, issue: x.issue, ...(x.evidence !== undefined ? { evidence: x.evidence } : {}) }));
  // 4.4 (G3, p6-5): each answer is of the version its claimed card showed, so a later text is never credited with it
  const answers = await instructionAnswers(ctx, view.status.handBack?.dispatch, r.instruction_responses ?? []);
  // 4.4 (G5; the plan's F11 "Deferred findings"): a deferral is an open item of the task, one per issue, recorded with
  // this review; its notice is raised once, when the item is new, not again at each re-review that defers it again
  const recorded = new Set((await eventsOf(ctx, OPEN_ITEMS_LINE, OPEN_ITEM)).map((x) => x.key));
  const deferrals = r.issue_responses.filter((i) => i.response === 'deferred').map((i) => ({ answer: i, body: deferredItemBody(t.id, k, rev, i.issue, `issue ${i.issue} deferred to ${i.owner}: ${i.reason}`) }));
  // the task's deferred issues this review answered fixed: they close those items once the attempt is accepted
  const fixed = r.issue_responses.filter((i) => i.response === 'fixed' && recorded.has(deferredItemBody(t.id, k, rev, i.issue, '').id)).map((i) => i.issue);
  const review: ReviewBody = { task: rev, k, verdict: r.verdict, judgment: `j.${rev}`, issues, ...(deferred.length > 0 ? { deferred } : {}), ...(reopen.length > 0 ? { reopen } : {}), ...(answers.length > 0 ? { instructions: answers } : {}), ...(items.length > 0 ? { items } : {}), ...(fixed.length > 0 ? { fixed } : {}), ...(unverifiable.length > 0 ? { unverifiable } : {}) };
  for (const { answer, body } of deferrals) {
    if (recorded.has(body.id)) continue;
    await notify(ctx, {
      category: 'reviewer-issue-deferred',
      wi: null,
      key: `${rev}:${answer.issue}`,
      trigger: `task ${t.id}, version ${judgment.target}: issue ${answer.issue} deferred to ${answer.owner}: ${answer.reason}`,
      defaultAction: `the issue stays unfixed and is listed at close, as open item ${body.id} (mp read open-items ${ctx.mission}); a re-plan or the user routes the work: a re-plan or a repair takes the item, or the user's words close it`,
      detail: { task: t.id, version: judgment.target, judgment: review.judgment, issue: answer.issue, owner: answer.owner, reason: answer.reason },
    });
  }
  const fresh = deferrals.filter((x) => !recorded.has(x.body.id)).map((x) => ev(ctx, OPEN_ITEMS_LINE, OPEN_ITEM, x.body.id, x.body));
  await commit(ctx, `flow:review:${ctx.mission}:${rev}`, { events: [ev(ctx, taskLine(t.id), 'review', rev, review), ...fresh] });
  return review;
}

// ---------------------------------------------------------------- kept products under a new plan (Appendix J)

/** A kept product re-bound to the plan in effect (task line event "rebind", key "<k>:b<n>"). */
interface RebindBody {
  readonly k: number;
  readonly n: number;
  /** The version re-bound: the attempt's accepted version then. */
  readonly from: string;
  /** The new version: the same content and source; its Reviewer contract relies on `dplan`, its prerequisites are `prerequisites`. */
  readonly product: string;
  readonly dplan: string;
  readonly prerequisites: readonly string[];
  /** New re-binds require a seat; carried re-binds are historical field-stack records. */
  readonly how: 'review' | 'carried';
  readonly carries: string | null;
  /** Why the new version needs review. */
  readonly why: readonly string[];
}

/** The re-bound version accepted (event "rebound", the rebind's key): its Reviewer's pass. */
interface ReboundBody {
  readonly k: number;
  readonly n: number;
  readonly product: string;
  readonly judgment: string;
  readonly how: 'review' | 'carried';
  /** #57: accepted with its risks by a decision on a used-up loop, not by the Reviewer's pass. */
  readonly decision?: { readonly escalation: string; readonly option: 'accept-risk'; readonly by: string; readonly words?: string };
  readonly risks?: readonly string[];
}

/** What one pass re-bound, for the PM's notices. */
interface KeptReport {
  readonly review: Array<{ readonly task: string; readonly from: string; readonly product: string; readonly why: readonly string[] }>;
  /** The re-bound versions' successors, read once per pass (dropped when this pass accepts a re-bound version). */
  successors: Map<string, string> | null;
  /** 4.1.3 (E-2): the plans in effect, now or before, that took effect without their reviews (read once per pass). */
  readonly waived: ReadonlySet<string>;
}

/** The mission's plans that took effect without their reviews (flow/waivers.ts, the one resolver): the stable gate reads them as settled by the waiver. */
async function waivedPlans(ctx: FlowCtx): Promise<ReadonlySet<string>> {
  const events = await eventsOf(ctx, PLAN_LINE);
  const out = new Set<string>();
  for (const e of events) {
    if (e.event !== 'effective' || e.key.includes('#')) continue;
    // (whether it was waived does not depend on which reviews it went without: no object read)
    if (planReviewsWaiverIn(events, ctx.mission, e.key, ctx.ports.project?.planReviewsWaived ?? [], null) !== null) out.add(e.key);
  }
  return out;
}

/** Attempt k's accepted version now, and the judgment that accepted it last. */
interface Acceptance {
  /** The product the attempt was accepted with. */
  readonly original: string;
  /** The accepted version now: `original`, or its latest re-bound version. */
  readonly product: string;
  readonly judgment: string;
  /** The attempt's product event with `object` the accepted version now (null: an older memory without one). */
  readonly body: ProductBody | null;
}

/** Carried field-stack re-binds are history; only a seat can accept one. */
export const bySeat = (b: { readonly how?: unknown }): boolean => b.how !== 'carried';

function currentAcceptance(line: Line, k: number): Acceptance | null {
  const acc = line.one<{ product: string; judgment: string }>('accepted', String(k));
  if (acc === null) return null;
  const rb = line.all<ReboundBody>('rebound').filter((r) => r.body.k === k && bySeat(r.body)).at(-1);
  const product = rb?.body.product ?? acc.product;
  const since = rb?.revision ?? 0;
  const again = line.all<{ k: number; product?: string; judgment: string }>('reaccepted').filter((r) => r.body.k === k && r.revision > since && (r.body.product ?? acc.product) === product).at(-1);
  const body = line.one<ProductBody>('product', String(k));
  return { original: acc.product, product, judgment: again?.body.judgment ?? rb?.body.judgment ?? acc.judgment, body: body === null ? null : { ...body, object: product } };
}

/** The version the attempt's last Reviewer judged, including a re-bind sent back for rework. */
async function reviewedProduct(ctx: FlowCtx, line: Line, k: number): Promise<ProductBody | null> {
  const body = line.one<ProductBody>('product', String(k));
  if (body === null) return null;
  const review = line.all<ReviewBody>('review').filter((r) => r.body.k === k).at(-1);
  const judged = review === undefined ? null : await judgmentRecordOf(ctx, review.body.judgment);
  return { ...body, object: judged?.target ?? currentAcceptance(line, k)?.product ?? body.object };
}

/** All attempts through k, including superseded re-bind siblings and the current version. */
function lineageVersions(line: Line, k: number): Set<string> {
  return new Set([
    ...line.all<ProductBody>('product').filter((p) => p.body.k <= k).map((p) => p.body.object),
    ...line.all<RebindBody>('rebind').filter((p) => p.body.k <= k).map((p) => p.body.product),
  ]);
}

/** Latest responses in record order, including hand-backs whose superseded verdict is not acted on. */
async function lineageIssueResponses(ctx: FlowCtx, line: Line, k: number): Promise<Map<string, { answer: IssueResponse; judgment: string; version: string }>> {
  const versions = lineageVersions(line, k);
  const responses = new Map<string, { answer: IssueResponse; judgment: string; version: string }>();
  for (const { record: judgment } of await ctx.ports.ledger.records(['judgment'])) {
    if (judgment.review !== 'reviewer' || !versions.has(judgment.target)) continue;
    for (const answer of judgment.issues) responses.set(answer.issue, { answer, judgment: judgment.judgment, version: judgment.target });
  }
  return responses;
}

function issueResponseContext(ctx: FlowCtx, response: { answer: IssueResponse; judgment: string; version: string }): string {
  const { answer, judgment, version } = response;
  let reason = answer.reason ?? '';
  if (reason !== '') {
    try {
      const text = ctx.ports.ledger.content.get(reason);
      try { reason = (JSON.parse(text) as { reason?: string }).reason ?? text; } catch { reason = text; }
    } catch { /* an older record can retain its reason hash */ }
  }
  const disposition = answer.response === 'deferred' ? `deferred to ${answer.owner}` : answer.response;
  return `${disposition} by ${judgment} on ${version}${reason !== '' ? `: ${reason}` : ''}`;
}

/** Deferred ownership remains context across later reworks, including a Secretary's grant. */
async function deferredInstructions(ctx: FlowCtx, line: Line, k: number): Promise<string[]> {
  const out: string[] = [];
  for (const [issue, response] of await lineageIssueResponses(ctx, line, k)) {
    if (response.answer.response !== 'deferred') continue;
    out.push(`issue ${issue} ${issueResponseContext(ctx, response)}`);
  }
  return out;
}

/** Each re-bound version's successor, over the mission's task lines (accepted re-binds only). */
async function reboundSuccessors(ctx: FlowCtx): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const rebinds = new Map<string, RebindBody>();
  for (const e of await ctx.ports.ledger.events<RebindBody>({ mission: ctx.mission, event: 'rebind' })) if (e.line.startsWith('task:')) rebinds.set(`${e.line}\n${e.key}`, e.body);
  for (const e of await ctx.ports.ledger.events<ReboundBody>({ mission: ctx.mission, event: 'rebound' })) {
    const r = rebinds.get(`${e.line}\n${e.key}`);
    if (r !== undefined) {
      if (bySeat(r) && bySeat(e.body)) out.set(r.from, r.product);
      else out.set(r.product, r.from);
    }
  }
  return out;
}

function latestOf(successor: ReadonlyMap<string, string>, x: string): string {
  const seen = new Set<string>();
  let v = x;
  while (successor.has(v) && !seen.has(v)) {
    seen.add(v);
    v = successor.get(v)!;
  }
  return v;
}

/**
 * Appendix J: the accepted product of a task whose card the plan in effect keeps. Its Reviewer
 * contract relies on the detailed plan in effect when it was recorded, and its prerequisites are
 * its dependencies' versions then; both are fixed with the object (v51 §5.2). When that plan no
 * longer holds (the pass of its PM plan went stale, or was negated) and the product lost its proof
 * with it, or a prerequisite was re-bound, no judgment of this version can make it proven again: it
 * is re-bound, a new version of the same content whose contract relies on the plan in effect and
 * whose prerequisites are the dependencies' current versions, once that plan is proven. The
 * stable mode queues a Reviewer on the new version with the current card and declared
 * runs (reused when recorded); fast mode notifies the PM. No program-written judgment replaces
 * the seat (per maintainer ruling 1, 2026-10-13). "held": the task waits this pass.
 */
async function keptStep(ctx: FlowCtx, eff: EffectiveBody, plan: DetailedPlanDoc, t: DetailedTask, line: Line, k: number, kept: KeptReport): Promise<'held' | 'none'> {
  const cur = currentAcceptance(line, k);
  if (cur === null || cur.body === null) return 'none';
  const c = ctx.ports.ledger.content;
  const rebinds = line.all<RebindBody>('rebind').filter((r) => r.body.k === k);
  const open = rebinds.filter((r) => bySeat(r.body)).at(-1);
  const pending = open !== undefined && line.one('rebound', open.key) === null ? open : undefined;
  // A superseded re-bind's running Reviewer settles before the next card collects its findings.
  const obsolete = obsoleteSteps(ctx, t.id, line, eff);
  for (const rev of rebinds.flatMap((rb) => rebindReviewers(ctx, t.id, line, k, rb))) {
    if (obsolete.has(rev) && (await ctx.ports.scheduler.status(rev))?.state === 'running') return 'held';
  }
  // a re-bind under review: the plan in effect is still the one it re-binds to
  if (eff.mode === 'stable' && pending !== undefined && pending.body.dplan === eff.dplan && pending.body.from === cur.product) return rebindReview(ctx, eff, plan, t, line, k, pending, cur.body, kept);
  const obj = await objectRecord(ctx, cur.product);
  if (obj === null) return 'none';
  const relied: readonly string[] = obj.reviews.find((r) => r.review === 'reviewer')?.reliesOn ?? [];
  const prerequisites = c.getList(obj.prerequisites);
  const successor = prerequisites.length === 0 ? new Map<string, string>() : (kept.successors ??= await reboundSuccessors(ctx));
  const mapped = prerequisites.map((x) => latestOf(successor, x));
  const prereqMoved = mapped.some((x, i) => x !== prerequisites[i]);
  if (relied.includes(eff.dplan) && !prereqMoved) return 'none';
  const others = relied.filter((r) => r !== eff.dplan);
  const ids = [...new Set([cur.product, eff.dplan, ...others, ...mapped])];
  const labels = (await ctx.ports.evaluator.labels(ids)).labels;
  if (ids.some((x) => labels[x] === 'recomputing')) return 'held';
  // proven, or unproven for a reason of its own (refuted, a withdrawn basis, a review undecided): the review paths handle it
  if (labels[cur.product] !== 'not-fully-proven') return 'none';
  // the plan it was recorded under still holds (or took effect without its reviews, and a re-bind onto the plan in
  // effect would prove no more) and no prerequisite moved: its proof is missing for another reason
  if (!prereqMoved && others.every((x) => labels[x] === 'proven' || (kept.waived.has(x) && labels[eff.dplan] !== 'proven'))) return 'none';
  // nothing is re-bound onto a plan that is not proven (it waits, and nothing re-reviews the version that cannot be
  // proven), except a plan that took effect without its reviews (4.1.3, E-2): it never will be, so the product is
  // re-bound onto it and judged by a Reviewer under it; the new version reads "not fully proven" (sol review r1)
  if (labels[eff.dplan] !== 'proven' && !kept.waived.has(eff.dplan)) return 'held';
  // the prerequisites: each must be its dependency's accepted version now, re-bound or proven itself first
  const deps = new Set<string>();
  // 4.4 (F12 b): a reopened attempt's start held the work of the tasks it came after, so its re-bind compares against them too
  for (const d of [...new Set([...t.dependsOn, ...afterOf(line, k)])]) {
    const p = await acceptedProduct(ctx, d);
    if (p !== null) deps.add(p);
    // A dependency's accepted closure still describes the old plan while its new version is
    // being judged. Compare only after that pending re-bind settles, avoiding a false stale notice.
    const dep = await readLine(ctx, d);
    const rb = dep.all<RebindBody>('rebind').filter((r) => r.body.k === dep.k && bySeat(r.body)).at(-1);
    if (rb !== undefined && rb.body.dplan === eff.dplan && rb.body.from === p && dep.one('rebound', rb.key) === null) return 'held';
  }
  // Stable mode: a dependency's accepted version not yet under the plan in effect is re-bound by its
  // own step first (whatever the plan's task order), or that step tells the PM why it cannot be; the
  // closures are compared only once the direct dependencies are settled, never on a passing state.
  // Fast mode re-binds nothing, so no such wait could end: the closures are compared as they are.
  if (eff.mode === 'stable') {
    const depLabels = (await ctx.ports.evaluator.labels([...deps])).labels;
    if ([...deps].some((x) => depLabels[x] === 'recomputing')) return 'held';
    for (const x of deps) if (await awaitsPlan(ctx, eff, depLabels, x)) return 'held';
  }
  const have = await ctx.ports.scheduler.composition(mapped);
  const want = await ctx.ports.scheduler.composition([...deps]);
  // 4.4 (F14, #66): both closures are read through the re-bound successors, so a prerequisite re-bound
  // to a successor of the same content is not stale (the dependencies' closures record older versions)
  const succ = prerequisites.length === 0 && deps.size > 0 ? (kept.successors ??= await reboundSuccessors(ctx)) : successor;
  const through = (xs: readonly string[]): string[] => [...new Set(xs.map((x) => latestOf(succ, x)))];
  const haveNow = through(have);
  const wantNow = through(want);
  const stale = haveNow.filter((x) => !wantNow.includes(x)).sort();
  const missing = wantNow.filter((x) => !haveNow.includes(x)).sort();
  if (stale.length > 0 || missing.length > 0) {
    await keptNotice(ctx, t, line, {
      key: `${t.id}:${cur.product}:${eff.dplan}:prerequisites:${shortHash({ stale, missing })}`,
      product: cur.product,
      dplan: eff.dplan,
      trigger: `the plan in effect (${eff.dplan}) keeps task ${t.id}'s card, but its accepted product ${cur.product} has stale prerequisites [${stale.join(', ')}] and missing prerequisites [${missing.join(', ')}] compared with its dependencies' accepted closure: it cannot be re-bound to the plan`,
      defaultAction: `task ${t.id} stays accepted with a product that is not fully proven${eff.mode === 'stable' ? ' (stable mode holds the work that depends on it)' : ''}; a re-plan that changes its card rebuilds it on its dependencies' current work`,
      detail: { task: t.id, product: cur.product, dplan: eff.dplan, stale, missing },
    });
    return 'none';
  }
  // fast mode: told once, then the re-review paths run (an environment re-review is still answered)
  if (eff.mode !== 'stable') {
    await keptNotice(ctx, t, line, {
      key: `${t.id}:${cur.product}:${eff.dplan}:fast`,
      product: cur.product,
      dplan: eff.dplan,
      trigger: `the plan in effect (${eff.dplan}) keeps task ${t.id}'s card, but its accepted product ${cur.product} lost its proof with the plan it was recorded under`,
      defaultAction: 'fast mode: the task stays accepted and the work that depends on it goes on; the product is "not fully proven" until a Reviewer judges it under the plan in effect (stable mode, or a re-plan that changes its card)',
      detail: { task: t.id, product: cur.product, dplan: eff.dplan },
    });
    return 'none';
  }
  // 4.4 (F14): the product is re-bound now; an open notice about it closes
  await closeKeptNotices(ctx, t.id, line, () => true);
  // every prerequisite is re-bound to the plan in effect, or proven, before this version is (stable mode only)
  for (const x of mapped) if (await awaitsPlan(ctx, eff, labels, x)) return 'held';
  // a re-review of this version that a Reviewer is judging now ends first (its hand-back is preserved)
  const rounds = openRounds(line, k, cur);
  for (const r of rounds) if (['running', 'waiting-evidence'].includes((await ctx.ports.scheduler.status(r))?.state ?? '')) return 'held';
  const n = rebinds.length + 1;
  const key = `${k}:b${n}`;
  const object = safeId(`${cur.original}.b${n}`);
  const contract: ReviewContract = { review: 'reviewer', basisLines: contractLines(ctx, t, await basisIndex(ctx)) as never, reliesOn: [eff.dplan] as never };
  try {
    await ctx.ports.scheduler.rebind({ mission: ctx.mission, of: cur.product, object, prerequisites: have, reviews: [contract] });
  } catch (e) {
    await actionRefused(ctx, `${cur.product}:rebind`, e);
    return 'held';
  }
  const why = ['the new version has a Reviewer contract under the plan in effect (maintainer ruling 1, 2026-10-13)'];
  const body: RebindBody = { k, n, from: cur.product, product: object, dplan: eff.dplan, prerequisites: have, how: 'review', carries: null, why };
  await commit(ctx, `flow:rebind:${ctx.mission}:task:${idPart(t.id)}:${key}`, { events: [ev(ctx, taskLine(t.id), 'rebind', key, body)] });
  for (const r of rounds) await ctx.ports.scheduler.cancel(r);
  kept.review.push({ task: t.id, from: cur.product, product: object, why });
  return 'held';
}

/** A version neither proven nor judged under the plan in effect: its own task's kept step re-binds it, or says why it cannot. */
async function awaitsPlan(ctx: FlowCtx, eff: EffectiveBody, labels: Readonly<Record<string, unknown>>, x: string): Promise<boolean> {
  if (labels[x] === 'proven') return false;
  const relied: readonly string[] = (await objectRecord(ctx, x))?.reviews.find((r) => r.review === 'reviewer')?.reliesOn ?? [];
  return !relied.includes(eff.dplan);
}

/** The Reviewer tasks of re-review rounds of the accepted version that have not handed back. */
function openRounds(line: Line, k: number, cur: Acceptance): string[] {
  return line
    .all<RereviewBody>('rereview')
    .filter((r) => r.body.k === k && (r.body.product ?? cur.original) === cur.product && line.one('review', r.body.rev) === null)
    .map((r) => r.body.rev);
}

/** The Reviewer tasks of a re-bind review: one per answered "needs decision" since it was recorded. */
function rebindReviewers(ctx: FlowCtx, taskId: string, line: Line, k: number, rb: { readonly revision: number; readonly body: RebindBody }): string[] {
  const answers = line.all('reanswer').filter((x) => x.key.startsWith(`${k}:`) && x.revision > rb.revision).length;
  return Array.from({ length: answers + 1 }, (_, j) => safeId(`rev.${ctx.mission}.${idPart(taskId)}.${k}.b${rb.body.n}${j > 0 ? `.r${j}` : ''}`));
}

/**
 * A re-bound version a Reviewer judges (stable mode): the same candidate, the declared runs on it
 * under the current identity (reused when they are recorded), the card under the plan in effect.
 * A pass accepts the new version; a rework sends the task back to its Constructor (the next
 * attempt); needs-decision goes to the Secretary, and its answer starts another review.
 */
async function rebindReview(
  ctx: FlowCtx,
  eff: EffectiveBody,
  plan: DetailedPlanDoc,
  t: DetailedTask,
  line: Line,
  k: number,
  rb: { readonly key: string; readonly revision: number; readonly body: RebindBody },
  body: ProductBody,
  kept: KeptReport,
): Promise<'held'> {
  const b = rb.body;
  const lineage = taskLineage(ctx.mission, t.id);
  const rev = rebindReviewers(ctx, t.id, line, k, rb).at(-1)!;
  const product: ProductBody = { ...body, object: b.product };
  let review = line.one<ReviewBody>('review', rev);
  if (review === null) {
    const view = await taskView(ctx, rev);
    if (view.kind === 'absent') {
      let runs: VerificationRun[];
      try {
        const v = await ctx.ports.scheduler.verify({ mission: ctx.mission, object: b.product, snapshot: product.snapshot, commands: t.verificationCommands });
        if (v === 'pending') return 'held';
        runs = [...v];
      } catch (e) {
        await actionRefused(ctx, `${b.product}:verify`, e);
        return 'held';
      }
      await submitReviewer(ctx, eff, plan, t, line, k, rev, product, runs, {
        duties: `Judge the candidate of task ${t.id} (attempt ${k}) against each standard: the plan in effect (${b.dplan}) keeps the task, the new version needs your judgment under that plan (${b.why.join('; ').slice(0, 400)}). The candidate is the same; the card and the runs are the current ones.`,
        observedOn: [b.from],
        handover: { from: null, objects: [b.product], step: `task ${t.id}'s accepted product re-bound to ${b.dplan}` },
      });
      return 'held';
    }
    if (view.kind === 'pending' || view.kind === 'evidence') return 'held';
    if (view.kind === 'failed') {
      await failed(ctx, t, rev, lineage, view);
      return 'held';
    }
    review = await takeReview(ctx, t, k, rev, view);
    if (review === null) return 'held';
  }
  // 4.4 (F10): what the Reviewer could not verify, with nothing else open, goes to a decider, not back to the Constructor
  const unverified = onlyUnverifiable(review);
  switch (unverified ? 'needs-decision' : review.verdict) {
    case 'pass':
      await commit(ctx, `flow:rebound:${ctx.mission}:task:${idPart(t.id)}:${rb.key}`, { events: [ev(ctx, taskLine(t.id), 'rebound', rb.key, { k, n: b.n, product: b.product, judgment: review.judgment, how: 'review' } satisfies ReboundBody), ...await personItems(ctx, t, k)] });
      kept.successors = null;
      break;
    case 'rework':
      if (t.kind === 'integration' && (review.reopen ?? []).length > 0) await reopenFromReview(ctx, plan, t, k, rev, review, product);
      else await rework(ctx, t, k, review.issues, [], `rework:${k}:${rev}`);
      break;
    case 'needs-decision':
      await raiseEscalation(ctx, {
        id: `rnd.${rev}`,
        source: 'reviewer-needs-decision',
        lineage,
        subject: `task:${t.id}`,
        summary: `The Reviewer of task ${t.id} (attempt ${k}, its product re-bound to ${b.dplan}) needs a decision: ${unverified ? `it could not verify ${(review.unverifiable ?? []).map((u) => u.standard).join(', ')} from what it can see, and nothing else is open` : 'the standards are unclear or in conflict'}.`,
        reasons: [...review.issues],
        // 4.4 (G1 with F10): what could not be verified is a question of evidence, not of design: no ask-architect
        options: unverified ? ['answer', 'rework', 'replan', 'ask-user'] : ['answer', 'ask-architect', 'rework', 'replan', 'ask-user'],
        items: t.requirementItems,
        facts: { task: t.id, attempt: k, product: b.product, issues: review.issues, rebind: b.n },
        handover: { from: rev, objects: [b.product] },
      });
      break;
  }
  return 'held';
}

/**
 * 4.4 (F14): a `kept-product-not-rebound` notice the flow keeps track of, on the task's line. The event's
 * key is a bounded hash of the notice's key (task, product and plan ids can be long); the body carries the
 * notice's key and its form without a recurrence suffix.
 */
interface KeptNoticeBody {
  readonly product: string;
  readonly dplan: string;
  readonly notice: string;
  readonly base: string;
}
const KEPT_NOTICE = 'kept-notice';
const KEPT_NOTICE_CLOSED = 'kept-notice-closed';
const KEPT_CATEGORY = 'kept-product-not-rebound';
const keptEventKey = (notice: string): string => `k.${shortHash(notice)}`;

function openKeptNotices(line: Line): Array<{ readonly key: string; readonly body: KeptNoticeBody }> {
  return line.all<KeptNoticeBody>(KEPT_NOTICE).filter((e) => line.one(KEPT_NOTICE_CLOSED, e.key) === null);
}

/** Close the open notices of a task that `which` selects: the lifecycle event and the notice's acknowledgement in one write. */
async function closeKeptNotices(ctx: FlowCtx, task: string, line: Line, which: (e: { readonly key: string; readonly body: KeptNoticeBody }) => boolean): Promise<void> {
  for (const e of openKeptNotices(line).filter(which)) {
    // the same body whoever closes it (re-bound, replaced, superseded), so two passes that close it at once agree
    await commit(ctx, `flow:${KEPT_NOTICE_CLOSED}:${ctx.mission}:task:${idPart(task)}:${e.key}`, {
      events: [ev(ctx, taskLine(task), KEPT_NOTICE_CLOSED, e.key, e.body)],
      records: [{ kind: 'notice.delivery', notice: noticeAlertId({ mission: ctx.mission, category: KEPT_CATEGORY, key: e.body.notice }), state: 'acknowledged' }],
    });
  }
}

/**
 * 4.4 (F14): one open `kept-product-not-rebound` notice per product and plan. A new stale set replaces
 * the open one (closed, and a notice with the new set raised); it closes when the product is re-bound
 * or superseded (keptSweep). Remembered before it is raised, so an interrupted notice is raised again.
 */
async function keptNotice(ctx: FlowCtx, t: DetailedTask, line: Line, n: { readonly key: string; readonly product: string; readonly dplan: string; readonly trigger: string; readonly defaultAction: string; readonly detail: unknown }): Promise<void> {
  // the same set again after its notice closed is a notice of its own (a closed notice stays acknowledged)
  const same = line.all<KeptNoticeBody>(KEPT_NOTICE).filter((e) => e.body.base === n.key);
  const open = same.find((e) => line.one(KEPT_NOTICE_CLOSED, e.key) === null);
  const notice = open?.body.notice ?? (same.length === 0 ? n.key : `${n.key}:${same.length + 1}`);
  const key = open?.key ?? keptEventKey(notice);
  const replaced = openKeptNotices(line).some((e) => e.key !== key && e.body.product === n.product && e.body.dplan === n.dplan);
  await closeKeptNotices(ctx, t.id, line, (e) => e.key !== key);
  if (line.one(KEPT_NOTICE, key) === null) {
    await commit(ctx, `flow:${KEPT_NOTICE}:${ctx.mission}:task:${idPart(t.id)}:${key}`, { events: [ev(ctx, taskLine(t.id), KEPT_NOTICE, key, { product: n.product, dplan: n.dplan, notice, base: n.key } satisfies KeptNoticeBody)] });
  }
  await notify(ctx, { category: KEPT_CATEGORY, wi: null, key: notice, trigger: `${n.trigger}${replaced ? ' (updated: it replaces the notice of the earlier set)' : ''}`, defaultAction: n.defaultAction, detail: n.detail });
}

/**
 * 4.4 (F14): the `kept-product-not-rebound` notices still open that the flow does not track are those 4.3
 * raised (4.4 records the lifecycle event before it raises one). Each pass takes them into the lifecycle
 * by their product and plan (one read of the open notices; nothing is written once all are tracked): the
 * pass then keeps the one of the current set and closes the others, and the sweep closes those of a
 * superseded plan or product.
 */
async function adoptKeptNotices(ctx: FlowCtx): Promise<void> {
  if (ctx.ports.ledger.openNotices === undefined) return;
  const open = await ctx.ports.ledger.openNotices({ mission: ctx.mission, category: KEPT_CATEGORY });
  if (open.length === 0) return;
  const tracked = new Set((await ctx.ports.ledger.events<KeptNoticeBody>({ mission: ctx.mission, event: KEPT_NOTICE })).map((e) => e.body.notice));
  const events: FlowEventInput[] = [];
  for (const n of open) {
    const d = n.detail as { task?: unknown; product?: unknown; dplan?: unknown } | null;
    if (tracked.has(n.key) || typeof d?.task !== 'string' || typeof d.product !== 'string' || typeof d.dplan !== 'string') continue;
    events.push(ev(ctx, taskLine(d.task), KEPT_NOTICE, keptEventKey(n.key), { product: d.product, dplan: d.dplan, notice: n.key, base: n.key } satisfies KeptNoticeBody));
  }
  // in bounded batches (an append takes at most 1,000 records), each under the operation id of its own
  // notices: a retry goes on with what is still untracked and never resubmits an oversized batch
  for (let i = 0; i < events.length; i += KEPT_ADOPT_BATCH) {
    const batch = events.slice(i, i + KEPT_ADOPT_BATCH);
    await commit(ctx, `flow:kept-adopted:${ctx.mission}:${shortHash(batch.map((e) => `${e.line}\n${e.key}`))}`, { events: batch });
  }
}
const KEPT_ADOPT_BATCH = 200;

/** 4.4 (F14): after a pass, a tracked notice closes once its plan is no longer in effect or its product is no longer the task's accepted one. */
async function keptSweep(ctx: FlowCtx, eff: EffectiveBody): Promise<void> {
  const raised = await ctx.ports.ledger.events<KeptNoticeBody>({ mission: ctx.mission, event: KEPT_NOTICE });
  if (raised.length === 0) return;
  const closed = new Set((await ctx.ports.ledger.events({ mission: ctx.mission, event: KEPT_NOTICE_CLOSED })).map((e) => `${e.line}\n${e.key}`));
  // superseded: a plan that was in effect before the one in effect now
  const effective = new Set((await eventsOf(ctx, PLAN_LINE, 'effective')).map((e) => e.key));
  for (const task of new Set(raised.filter((e) => !closed.has(`${e.line}\n${e.key}`)).map((e) => e.line.slice('task:'.length)))) {
    const line = await readLine(ctx, task);
    const product = line.abandoned ? null : currentAcceptance(line, line.k)?.product ?? null;
    await closeKeptNotices(ctx, task, line, (e) => (e.body.dplan !== eff.dplan && effective.has(e.body.dplan)) || e.body.product !== product);
  }
}

/** The PM's notices of one pass's re-binds (3.9; normal branch: nothing for the PM to decide). */
async function keptNotices(ctx: FlowCtx, eff: EffectiveBody, kept: KeptReport): Promise<void> {
  if (kept.review.length > 0) {
    await notify(ctx, {
      category: 'kept-products-rebind-review',
      wi: null,
      key: `${eff.dplan}:${shortHash(kept.review.map((x) => x.product))}`,
      trigger: `the plan in effect (${eff.dplan}) keeps the cards of tasks ${kept.review.map((x) => x.task).join(', ')}; their accepted products had lost their proof with the plan they were recorded under, and the new versions need a Reviewer judgment under that plan`,
      defaultAction: `re-bound to ${eff.dplan}: ${kept.review.map((x) => `${x.from} → ${x.product}`).join(', ')}. Each new version of the same candidate is queued for a Reviewer under the current card: a pass accepts it, a rework sends the task back to its Constructor; the work that depends on them waits in stable mode`,
      detail: { dplan: eff.dplan, review: kept.review },
    });
  }
}

/**
 * A program action that cannot go on as it is (src/process ActionError): only this task waits,
 * with the WI for its cause; it is tried again on every pass. Anything else is rethrown (the
 * engine reports it as a defect, WI-20).
 */
async function actionRefused(ctx: FlowCtx, key: string, e: unknown): Promise<void> {
  const code = (e as { code?: string }).code;
  const wi = code === 'missing-objects' || code === 'unsafe-path' ? WI.missingObjects : code === 'git-held' ? WI.gitHeld : code === 'conflict' || code === 'unknown-product' ? WI.internalError : null;
  if (wi === null) throw e;
  await notify(ctx, {
    category: code === 'missing-objects' ? 'flow-missing-objects' : code === 'git-held' ? 'flow-git-held' : 'flow-action-refused',
    wi,
    key: `${key}:${code}`,
    trigger: (e as Error).message,
    defaultAction: `only ${key} waits; it is tried again on every pass; the rest of the mission continues`,
    detail: { key, code, detail: (e as { detail?: unknown }).detail ?? null },
  });
}

/** The contract's basis lines of a product (10.1): the task's standards and the items that exist. */
function contractLines(ctx: FlowCtx, t: DetailedTask, ix: Awaited<ReturnType<typeof basisIndex>>): string[] {
  return reviewContractLines(ctx.mission, t, ix);
}

/** A Reviewer rework: counted (initial + the cap, config `loops.rework`); exhausted → WI-08 and the Secretary. */
async function rework(ctx: FlowCtx, t: DetailedTask, k: number, issues: readonly string[], instructions: readonly string[], key: string, o: { readonly reason?: ReworkBody['reason']; readonly reopen?: ReopenSource } = {}): Promise<void> {
  const lineName = taskLine(t.id);
  // 4.4 (F12 a): counted on the loop attempt k belongs to (a repair's reopened work has a fresh one)
  const before = await readLine(ctx, t.id);
  const lineage = reworkLineage(ctx.mission, t.id, before.events, k);
  const freshOf = lineage === taskLineage(ctx.mission, t.id) ? null : before.all<ReworkBody>('rework').filter((x) => x.body.loop === lineage).at(-1)?.body.reopen ?? null;
  const r = await countedReturn(ctx, { line: lineName, key, lineage, loop: 'rework', signature: shortHash([...issues].sort()) });
  if (r.proceed) {
    const line = await readLine(ctx, t.id);
    const deferred = await deferredInstructions(ctx, line, k);
    await commit(ctx, `flow:rework:${ctx.mission}:task:${idPart(t.id)}:${k + 1}`, { events: [ev(ctx, lineName, 'rework', String(k + 1), { k: k + 1, reason: o.reason ?? (instructions.length > 0 ? 'secretary' : 'reviewer'), issues: [...issues], instructions: [...instructions, ...deferred], ...(o.reopen !== undefined ? { reopen: o.reopen } : {}) } satisfies ReworkBody)] });
    return;
  }
  const v = r.status;
  // #51: only the attempt's own review keeps the base id; every other rework of the attempt (a reopen, a re-bind or
  // re-review, an export refusal, a Secretary rework) names its escalation by its key, so a decided base id never hides it
  let id = safeId(key === `rework:${k}` ? `exh.${lineage}.${k}` : `exh.${lineage}.${k}.${idPart(key)}`);
  // 4.1.3 (#35, E-1): with a verified hand-back, the decision may accept the attempt's product with its open findings as risks
  const reopenRisk = o.reopen?.kind === 'review' ? await waitingReopenRisk(ctx, t.id, k, o.reopen) : null;
  // #57: a re-bound version whose content an accept-risk decision accepted may be accepted with its risks again
  const rebindRisk = o.reopen === undefined ? await rebindRiskAcceptable(ctx, t, k, key) : null;
  const risk = reopenRisk !== null ? { product: reopenRisk.product.object, judgment: reopenRisk.review.judgment } : rebindRisk ?? await riskAcceptable(ctx, t, k);
  // an attempt whose program runs did not all pass may be accepted with its risks by the PM or the user only
  const runRisk = risk === null ? await failedRunsRisk(ctx, t, k) : null;
  const offered = risk ?? runRisk;
  if (rebindRisk !== null || runRisk !== null) {
    // an escalation raised before the option was offered here lacks it: an open one is closed as superseded and a fresh one offers it
    const old = await escalation(ctx, id);
    if (old !== null && !old.options.includes('accept-risk')) {
      if (!(await isApplied(ctx, id))) {
        const why = rebindRisk !== null
          ? 'accept-risk is offered after a failed re-bind review now (#57): a fresh escalation offers it'
          : 'accept-risk is offered to the PM and the user on an attempt whose program runs did not all pass now: a fresh escalation offers it';
        await commitCarrying(ctx, `flow:${rebindRisk !== null ? 'rebind' : 'runs'}-risk:${ctx.mission}:${id}`, [], [closing(ctx, [id], why)], [id]);
      }
      if ((await closedEscalation(ctx, id)) !== null) id = safeId(`${id}.risk`);
    }
  }
  await raiseEscalation(ctx, {
    id,
    source: 'loop-exhausted',
    lineage,
    subject: `task:${t.id}`,
    summary: `Task ${t.id}: the reworks${freshOf?.kind === 'repair' ? ` of repair ${freshOf.repair}'s reopen` : ''} are used up (${v.attempts}/${v.allowed}${v.reason === 'no-progress' ? ', the same issues twice in a row' : ''}).`,
    reasons: [...issues, ...(reopenRisk?.review.issues ?? []), ...(runRisk?.failed.map((f) => `a program run did not pass on the product: ${f}`) ?? [])],
    options: ['grant', 'ask-architect', 'replan', ...(offered !== null ? (['accept-risk'] as const) : []), 'abandon', 'ask-user'],
    ...(runRisk !== null ? { pmOnly: ['accept-risk'] as const } : {}),
    ...(offered !== null ? { position: { target: offered.product, review: 'reviewer', revokes: offered.judgment } } : {}),
    items: t.requirementItems,
    facts: { task: t.id, attempt: k, loop: 'rework', issues, attempts: v.attempts, allowed: v.allowed, reason: v.reason, ...(o.reopen !== undefined ? { reopen: o.reopen } : {}), ...(rebindRisk !== null ? { rebind: rebindRisk.rebind } : {}) },
    // the Reviewer whose rework used the loop up (or the Constructor whose candidate could not be recorded)
    handover: reopenRisk !== null ? { from: reopenRisk.review.task, objects: [reopenRisk.product.object] } : await reworkHandover(ctx, t, k),
  });
  await notify(ctx, {
    category: 'loop-exhausted',
    wi: WI.loopExhausted,
    key: id,
    trigger: `rework on lineage ${lineage}: ${v.reason === 'no-progress' ? 'the same issues twice in a row (no progress)' : `${v.attempts} of ${v.allowed} reworks used`}`,
    defaultAction: `only task ${t.id} stops at "exhausted"; the Secretary decides (one grant, re-plan, ${reopenRisk !== null ? `accept ${reopenRisk.integration}'s reviewed product with its findings as risks, ` : risk !== null ? 'accept its verified product with the open findings as risks, ' : ''}abandon, or the user); the rest of the mission continues`,
    detail: { task: t.id, lineage, attempt: k, issues },
  });
}

/** Who hands an exhausted rework over (§3.2, U-13): the attempt's last Reviewer, else its Constructor; with the attempt's product. */
async function reworkHandover(ctx: FlowCtx, t: DetailedTask, k: number): Promise<{ readonly from: string; readonly objects: readonly string[] }> {
  const line = await readLine(ctx, t.id);
  const review = line.all<ReviewBody>('review').filter((r) => r.body.k === k).at(-1);
  const product = await reviewedProduct(ctx, line, k);
  return { from: review?.body.task ?? conTask(ctx.mission, t.id, k), objects: product !== null ? [product.object] : [] };
}

/**
 * Carry out a decision on one of this task's escalations (rework exhausted, reviewer needs a
 * decision, constructor questions). Returns whether the task must wait.
 */
async function applyTaskDecision(ctx: FlowCtx, eff: EffectiveBody, plan: DetailedPlanDoc, t: DetailedTask, line: Line, e: EscalationBody, waived: ReadonlySet<string>): Promise<boolean> {
  const lineName = taskLine(t.id);
  const lineage = taskLineage(ctx.mission, t.id);
  const facts = (e.facts ?? {}) as { attempt?: number; loop?: string; issues?: string[] };
  // seat failures are carried out where the failed task is seen (failures.ts)
  if (e.source === 'needs-disposition' || (e.source === 'loop-exhausted' && facts.loop !== undefined && facts.loop !== 'rework')) return false;
  // 4.4 (F4): a Constructor's questions with its product do not hold the task (its review waits: process/questions.ts); a pause does
  const blocking = e.source !== 'constructor-decision' || (e.facts as { blocked?: unknown } | undefined)?.blocked === true;
  // 4.4 (F4, p8-6): a pause of an attempt the task has moved past (a pass started the next attempt while another
  // wrote the pause) blocks nothing and takes no decision: it is closed. Attempts only grow, so the read is safe.
  const pausedAt = (e.facts ?? {}) as { blocked?: unknown; attempt?: unknown; pause?: unknown };
  const isPause = e.source === 'constructor-decision' && pausedAt.blocked === true && typeof pausedAt.attempt === 'number';
  if (isPause && (pausedAt.attempt as number) < line.k) {
    await commitCarrying(ctx, `flow:pause-superseded:${ctx.mission}:${e.id}`, [], [closing(ctx, [e.id], `task ${t.id} moved past attempt ${pausedAt.attempt}: the pause of that attempt is moot`)], [e.id]);
    return false;
  }
  // review r2-3: the notice of a third pause comes from the committed pause, while it waits (raised once by its key)
  if (isPause && typeof pausedAt.pause === 'number') await tellPausedAgain(ctx, t.id, pausedAt.attempt as number, pausedAt.pause, e.id);
  const d = await decisionFor(ctx, e.id);
  // #57: an open loop-exhausted escalation that a failed re-bind review raised before accept-risk was offered there
  // (undecided, or waiting for the PM or the user) is closed as superseded; this pass's re-bind step raises a fresh
  // one that offers it. A decision already taken on it is carried out as before.
  if (e.source === 'loop-exhausted' && !e.options.includes('accept-risk') && (d === null || isAskOption(d.option)) && !(await isApplied(ctx, e.id))) {
    const k0 = facts.attempt ?? line.k;
    const rr = await rebindRiskAcceptable(ctx, t, k0, null);
    if (rr !== null && e.id === safeId(`exh.${lineage}.${k0}.${idPart(`rework:${k0}:${rr.review}`)}`)) {
      await commitCarrying(ctx, `flow:rebind-risk:${ctx.mission}:${e.id}`, [], [closing(ctx, [e.id], 'accept-risk is offered after a failed re-bind review now (#57): a fresh escalation offers it')], [e.id]);
      return false;
    }
    // the same for the attempt's own review on a hand-back whose program runs did not all pass: this pass's step
    // raises a fresh escalation that offers accept-risk to the PM and the user
    if (rr === null && e.id === safeId(`exh.${lineage}.${k0}`) && (await riskAcceptable(ctx, t, k0)) === null && (await failedRunsRisk(ctx, t, k0)) !== null) {
      await commitCarrying(ctx, `flow:runs-risk:${ctx.mission}:${e.id}`, [], [closing(ctx, [e.id], 'accept-risk is offered to the PM and the user on an attempt whose program runs did not all pass now: a fresh escalation offers it')], [e.id]);
      return false;
    }
  }
  if (d === null) return blocking;
  const k = facts.attempt ?? line.k;
  const raised = (await eventsOf<EscalationBody>(ctx, SECRETARY_LINE, 'escalation')).find((x) => x.key === e.id);
  const reopen = raised !== undefined && coveredReopens(ctx, t.id, line, raised).length > 0;
  switch (d.option) {
    case 'grant': {
      // 4.4 (F12 a): the grant goes to the loop that is used up (a repair's reopened work has its own; 4.3 escalations name the task's)
      const loopLineage = e.lineage;
      const g = await grantForDecision(ctx, { op: `grant:${ctx.mission}:${e.id}:${d.by}`, lineage: loopLineage, loop: 'rework', by: d.by === 'pm' ? 'pm' : d.by === 'user' ? 'user' : 'secretary', extra: Math.max(1, d.grantExtra), reason: d.reason });
      if (!g.granted) {
        await escalateToUser(ctx, e.id, `the Secretary's grant on lineage ${loopLineage} was refused (${g.why ?? 'refused'}): only the user can grant more`, WI.loopExhausted);
        return true;
      }
      const next = line.one<ReworkBody>('rework', String(k + 1));
      if (next === null) await grantedAttempt(ctx, g, { op: `flow:rework:${ctx.mission}:${e.id}:granted`, lineage: loopLineage, loop: 'rework', signature: `granted:${e.id}` });
      // 4.4 (G1, review p11-3): an Architect's answer on this loop reaches the granted attempt's cards as a decision of the
      // task (seat/cards/dynamic.ts carriedAnswer: both roles, at queue time and at the claim), not through this rework body
      const body: ReworkBody = { k: k + 1, reason: 'secretary', issues: facts.issues ?? [], instructions: [...(d.instructions !== '' ? [d.instructions] : []), ...await deferredInstructions(ctx, line, k)] };
      const carry = await carryOut(ctx, e.id, { option: 'grant' }, g.records);
      await commit(ctx, `flow:rework:${ctx.mission}:${e.id}:apply-grant`, {
        events: [...(next === null ? [ev(ctx, lineName, 'rework', String(k + 1), body)] : []), ...carry.events], records: carry.records,
        guard: { latest: carry.latest, words: carry.words, openMissions: carry.openMissions, absent: [...carry.absent, ...(next === null ? [{ mission: ctx.mission, line: lineName, event: 'rework', key: String(k + 1) }] : [])],
          code: 'STALE_REQUEST', message: 'the grant or next attempt was recorded meanwhile; retry from the task line' },
      });
      await carried(ctx, [carry]);
      return false;
    }
    case 'answer':
      if (e.source === 'reviewer-needs-decision') {
        // the re-review's number and the applied mark are one append (code review r1 #13)
        const m = line.all('reanswer').filter((x) => x.key.startsWith(`${k}:`)).length;
        await commitCarrying(ctx, `flow:reanswer:${ctx.mission}:${e.id}`, [ev(ctx, lineName, 'reanswer', `${k}:${m + 1}`, { escalation: e.id, decision: answerText(d) })], [await carryOut(ctx, e.id, { option: 'answer' })]);
        return false;
      }
      // 4.4 (F4): what the answer puts off stays open; a pause's answer resumes the attempt
      if (e.source === 'constructor-decision') {
        await answerQuestions(ctx, t, line, e, d);
        return false;
      }
      await markApplied(ctx, e.id, { option: 'answer' });
      return false;
    case 'rework':
      // the rework first, then the mark (a crash in between repeats the idempotent rework)
      await rework(ctx, t, k, facts.issues ?? [], [d.instructions], `rework:${k}:${e.id}`);
      await markApplied(ctx, e.id, { option: 'rework' });
      return false;
    case 'replan':
      // 4.4 (p8-6): a pause's re-plan (its waiting-replan above all) is written only while its attempt is current
      await requestReplan(ctx, eff, t, e.id, d, !reopen || line.k === k, isPause ? [attemptCurrent(ctx, t.id, k)] : []);
      return !reopen || line.k === k;
    case 'ask-architect':
      // 4.4 (G1): the Architect's step answers it (flow/architectAsk.ts); meanwhile the task waits as for any decision, and
      // its answer, once recorded, is read here as an answer (decisionFor)
      return blocking;
    case 'accept-risk':
      if ((e.facts as { rebind?: string } | undefined)?.rebind !== undefined) await acceptRebindWithRisk(ctx, t, k, e, d);
      else if (line.one('accepted', String(k)) !== null) await acceptReopenWithRisk(ctx, plan, t, k, e, d);
      else await acceptWithRisk(ctx, eff, plan, t, k, e, d, waived);
      return !reopen || line.k === k;
    case 'abandon':
      if (reopen) {
        await notify(ctx, { category: 'reopened-task-abandoned', wi: WI.loopExhausted, key: e.id,
          trigger: `the reopen request on ${e.id} for task ${t.id} attempt ${k} was given up`,
          defaultAction: 'only this reopen is dropped; other grants and work stay. A waiting integration needs new accepted dependency work, a re-plan or a repair',
          detail: { task: t.id, attempt: k, escalation: e.id, reason: d.reason } });
        // 4.4 (F13): a repair's reopen given up here (counted by 4.3) is recorded as not carried out: its repair does not read as done
        const given = coveredReopens(ctx, t.id, line, raised!).filter((key) => key.startsWith('reopen:repair:')).map((key) => key.slice('reopen:repair:'.length));
        // keyed as a move of its request (its next record), so no other move of it can be written beside this one
        const requests = (await reopenRequests(ctx)).filter((q) => q.source.kind === 'repair' && q.task === t.id && given.includes(q.source.repair) && q.state !== 'not-carried');
        const keys = requests.map((q) => ({ repair: (q.source as { repair: string }).repair, key: `${(q.source as { repair: string }).repair}:${t.id}#${q.seq + 1}` }));
        if (keys.length > 0) {
          await commit(ctx, `flow:reopen-given-up:${ctx.mission}:${e.id}`, {
            events: keys.map((x) => ev(ctx, REPAIRS_LINE, REOPEN_NOT_CARRIED, x.key, { repair: x.repair, task: t.id, attempt: k, why: `its reopen was given up on ${e.id}` } satisfies ReopenNotCarriedBody)),
            guard: { absent: keys.flatMap((x) => [REOPEN_PINNED, REOPEN_CARRIED, REOPEN_NOT_CARRIED].map((event) => ({ mission: ctx.mission, line: REPAIRS_LINE, event, key: x.key }))), code: 'STALE_REQUEST', message: `a reopen given up on ${e.id} moved meanwhile; nothing was written (the next pass reads it again)` },
          });
        }
        await markApplied(ctx, e.id, { option: 'abandon' });
        return false;
      }
      await abandon(ctx, t, line.k, e.id, d.reason);
      return true;
    default:
      await markApplied(ctx, e.id, { option: d.option });
      return false;
  }
}

/**
 * A Secretary's (or the user's) "re-plan": the decision layer re-decomposes; this task waits for the new
 * plan. 4.1.3 (#35): when the decision layer is idle on the plan in effect, the Architect attempt that
 * answers it is written in the same write (planning.ts replanRoute); otherwise the waiting task tells the
 * PM what the routing waits on (tellReplanWait).
 */
async function requestReplan(ctx: FlowCtx, eff: EffectiveBody, t: DetailedTask, escalationId: string, d: DecisionBody, wait = true, also: AppendGuard['absent'] = []): Promise<void> {
  const req = { escalation: escalationId, task: t.id, instructions: d.instructions };
  const route = await replanRoute(ctx, req);
  const carry = await carryOut(ctx, escalationId, { option: 'replan' });
  const guard = carryGuard([carry]);
  // 4.4 (F4, p8-6): `also`, what must still be absent for this write (a pause's: its attempt is still current)
  const absent = [...(guard?.absent ?? []), ...(route.kind === 'now' ? route.absent : []), ...also];
  await commit(ctx, `flow:replan-request:${ctx.mission}:${escalationId}`, {
    events: [ev(ctx, PLAN_LINE, 'replan-request', escalationId, req), ...(wait ? [ev(ctx, taskLine(t.id), 'waiting-replan', escalationId, { dplan: eff.dplan, escalation: escalationId })] : []), ...(route.kind === 'now' ? route.events : []), ...carry.events],
    records: carry.records,
    ...(absent.length > 0 ? { guard: { ...guard, absent, code: 'STALE_REQUEST', message: `escalation ${escalationId} was carried out, or the decision layer moved, while its re-plan was being recorded; nothing was written (the next pass reads it again)` } } : {}),
  });
  await carried(ctx, [carry]);
}

/**
 * 4.1.3 (#35): a task waiting for a re-plan that no Architect attempt has taken yet: the PM is told what
 * the routing waits on and what to do (planning.ts replanRoute), once per cause. Nothing when the decision
 * layer routes it by itself on the next pass.
 */
async function tellReplanWait(ctx: FlowCtx, t: DetailedTask, escalation: string): Promise<void> {
  if ((await eventsOf(ctx, PLAN_LINE, 'replan-routed')).some((e) => e.key.startsWith(`${escalation}#`))) return;
  const req = (await eventsOf<{ escalation: string; task: string; instructions: string }>(ctx, PLAN_LINE, 'replan-request')).find((e) => e.key === escalation)?.body;
  if (req === undefined) return;
  const route = await replanRoute(ctx, req);
  if (route.kind === 'now' || route.soon) return;
  await notify(ctx, {
    category: 'replan-waits',
    wi: WI.loopExhausted,
    key: `${escalation}:${shortHash(route.why)}`,
    trigger: `task ${t.id} waits for the re-plan that decision ${escalation} asked for, and no Architect attempt has taken it: ${route.why}`,
    defaultAction: `${route.todo}. Meanwhile only task ${t.id} and the work that depends on it wait. A repair that changes its card (mp pm repair ${ctx.mission} --about ${t.id}, with the user's words) also answers the re-plan`,
    detail: { task: t.id, escalation, why: route.why, todo: route.todo },
  });
}

async function abandon(ctx: FlowCtx, t: DetailedTask, k: number, escalationId: string, reason: string): Promise<void> {
  await cancelAttempt(ctx, t, k, 'abandoned');
  // one giving-up per card (a re-planned card that is given up again records its own); the task's other
  // open escalations close with it (nothing would carry a decision on them out), the one carried out excepted
  const a = abandonKey(await readLine(ctx, t.id));
  const others = (await openEscalations(ctx, `task:${t.id}`)).map((e) => e.id).filter((id) => id !== escalationId);
  await commitCarrying(
    ctx,
    `flow:abandon:${ctx.mission}:${t.id}${a.op}`,
    [ev(ctx, taskLine(t.id), 'abandoned', a.key, { escalation: escalationId, reason, attempt: k })],
    [await carryOut(ctx, escalationId, { option: 'abandon' }), closing(ctx, others, `task ${t.id} was given up`)],
    others,
  );
}

/** Every Constructor and Reviewer step of attempt j, including re-bind and re-review rounds. */
function attemptSteps(ctx: FlowCtx, taskId: string, line: Line, j: number): string[] {
  const answers = line.all('reanswer').filter((x) => x.key.startsWith(`${j}:`)).length;
  return [...new Set([
    conTask(ctx.mission, taskId, j),
    // 4.4 (F4): the steps that continued the attempt after its pauses
    ...line.all<ResumedBody>('resumed').filter((r) => r.body.k === j).map((r) => r.body.step),
    ...Array.from({ length: answers + 1 }, (_, m) => revTask(ctx.mission, taskId, j, m)),
    ...line.all<RereviewBody>('rereview').filter((r) => r.body.k === j).map((r) => r.body.rev),
    ...line.all<RebindBody>('rebind').filter((r) => r.body.k === j).flatMap((r) => rebindReviewers(ctx, taskId, line, j, r)),
    ...line.all<ReviewBody>('review').filter((r) => r.body.k === j).map((r) => r.body.task),
  ])];
}

/** Steps whose results are kept as records but are no longer continued by the flow. */
function obsoleteSteps(ctx: FlowCtx, taskId: string, line: Line, eff: EffectiveBody): Set<string> {
  const obsolete = new Set<string>();
  for (let j = 1; j < line.k; j++) for (const task of attemptSteps(ctx, taskId, line, j)) obsolete.add(task);
  const lastSpec = line.all<SpecBody>('spec').at(-1)?.revision ?? 0;
  if (line.abandoned || line.all('dropped').some((d) => d.revision > lastSpec)) {
    for (const task of attemptSteps(ctx, taskId, line, line.k)) obsolete.add(task);
  } else {
    const cur = currentAcceptance(line, line.k);
    const rebinds = line.all<RebindBody>('rebind').filter((r) => r.body.k === line.k && bySeat(r.body));
    const pending = rebinds.at(-1);
    for (const rb of rebinds) {
      if (line.one('rebound', rb.key) !== null) continue;
      if (rb === pending && rb.body.dplan === eff.dplan && rb.body.from === cur?.product) continue;
      for (const task of rebindReviewers(ctx, taskId, line, line.k, rb)) obsolete.add(task);
    }
  }
  return obsolete;
}

/** Cancel the queued (not running) tasks of an attempt immediately; reconciliation repeats it. */
async function cancelAttempt(ctx: FlowCtx, t: DetailedTask, k: number, why: string): Promise<string[]> {
  const running: string[] = [];
  const line = await readLine(ctx, t.id);
  const tasks = attemptSteps(ctx, t.id, line, k);
  for (const task of tasks) {
    const s = await ctx.ports.scheduler.status(task);
    if (s === null) continue;
    if (s.state === 'running') running.push(task);
    else if (s.state === 'queued' || s.state === 'waiting-evidence') await ctx.ports.scheduler.cancel(task);
  }
  if (running.length > 0) {
    await notify(ctx, {
      category: 'plan-task-in-flight',
      wi: WI.planTaskDropped,
      key: `${t.id}:${k}:${why}`,
      trigger: `task ${t.id} was ${why} while ${running.join(', ')} ran`,
      defaultAction: 'the running seats finish; their results are recorded but not continued under the old card; queued attempts were cancelled; the rest of the mission continues',
      detail: { task: t.id, attempt: k, running, why },
    });
  }
  return running;
}

async function failed(ctx: FlowCtx, t: DetailedTask, task: string, lineage: string, view: Extract<Awaited<ReturnType<typeof taskView>>, { kind: 'failed' }>): Promise<void> {
  const f: FailureOutcome = await handleFailure(ctx, { task, lineage, subject: `task:${t.id}`, view, canAbandon: true, canReplan: true });
  if (f.kind !== 'decided') {
    if (f.kind === 'abandoned') {
      const line = await readLine(ctx, t.id);
      if (!line.abandoned) {
        const a = abandonKey(line);
        const others = (await openEscalations(ctx, `task:${t.id}`)).map((e) => e.id);
        await commitCarrying(ctx, `flow:abandon:${ctx.mission}:${t.id}${a.op}`, [ev(ctx, taskLine(t.id), 'abandoned', a.key, { escalation: null, reason: `task ${task} was cancelled outside the flow`, attempt: line.k })], [closing(ctx, others, `task ${t.id} was given up`)], others);
      }
    }
    return;
  }
  const eff = await latestEffective(ctx);
  if (f.decision.option === 'replan' && eff !== null) return requestReplan(ctx, eff, t, f.escalation, f.decision);
  if (f.decision.option === 'abandon') return abandon(ctx, t, (await readLine(ctx, t.id)).k, f.escalation, f.decision.reason);
  await markApplied(ctx, f.escalation, { option: f.decision.option });
}

// ---------------------------------------------------------------- tasks the new plan dropped

/** Releases can requeue obsolete work after any exit: cancel it again on every pass (WI-23). */
async function supersededStep(ctx: FlowCtx, eff: EffectiveBody): Promise<void> {
  const seen = new Set<string>();
  for (const e of await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')) for (const t of e.body.tasks) seen.add(t);
  for (const taskId of seen) {
    const line = await readLine(ctx, taskId);
    for (const task of obsoleteSteps(ctx, taskId, line, eff)) {
      const state = (await ctx.ports.scheduler.status(task))?.state;
      if (state === 'queued' || state === 'waiting-evidence') await ctx.ports.scheduler.cancel(task);
    }
  }
}

async function droppedStep(ctx: FlowCtx, eff: EffectiveBody, plan: DetailedPlanDoc): Promise<void> {
  const now = new Set(plan.tasks.map((t) => t.id));
  const seen = new Set<string>();
  for (const e of await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')) for (const t of e.body.tasks) seen.add(t);
  for (const id of seen) {
    if (now.has(id)) continue;
    const line = await readLine(ctx, id);
    const last = line.all<SpecBody>('spec').at(-1);
    if (last === undefined) continue;
    if (line.all<{ dplan: string }>('dropped').some((d) => d.revision > last.revision)) continue;
    if (!line.abandoned) {
      const stored = await planOf(ctx, last.body.dplan);
      const t = stored?.plan.tasks.find((x) => x.id === id);
      if (t !== undefined) await cancelAttempt(ctx, t, line.k, 'dropped by the new plan');
    }
    // the flow no longer carries out a decision on a task the plan dropped: its open escalations are
    // closed with the drop (their queued Secretary steps cancelled); a later plan that brings the task
    // back starts it under a new card
    const stale = (await openEscalations(ctx, `task:${id}`)).map((e) => e.id);
    await commitCarrying(ctx, `flow:dropped:${ctx.mission}:${id}:${last.key}`, [ev(ctx, taskLine(id), 'dropped', `${eff.dplan}`, { dplan: eff.dplan })], [closing(ctx, stale, `task ${id} was dropped by the plan in effect (${eff.dplan})`)], stale);
  }
}

// ---------------------------------------------------------------- cards

/** A task's standards on its cards; 4.4 (F10): with how each is checked, when the plan names it (a 4.3 plan's card is as 4.3 built it). */
export function cardStandards(t: Pick<DetailedTask, 'standards'>): Array<{ id: string; text: string; check?: NonNullable<DetailedTask['standards'][number]['check']> }> {
  return t.standards.map((s) => ({ id: s.id, text: s.text, ...(s.check !== undefined ? { check: s.check } : {}) }));
}

function interfaceDefs(plan: DetailedPlanDoc, names: readonly string[]): Array<{ name: string; definition: string }> {
  return names.map((n) => {
    const nw = plan.newInterfaces.find((i) => i.name === n);
    if (nw !== undefined) return { name: n, definition: nw.definition };
    const re = plan.reusedInterfaces.find((i) => i.name === n);
    return { name: n, definition: re !== undefined ? `existing, at ${re.file}:${re.location}` : '(see the snapshot)' };
  });
}

/**
 * 4.4 (F3): the plan's data formats and storage lists, for the Constructor and Reviewer cards of its
 * tasks (absent when empty): a Constructor's from the plan in effect (again at its claim, refresh.ts), a
 * Reviewer's from the plan its target's review contract relies on.
 */
export function planData(plan: Pick<DetailedPlanDoc, 'dataFormats' | 'storage'> | null | undefined): { dataFormats?: string[]; storage?: string[] } {
  if (plan === null || plan === undefined) return {};
  return { ...((plan.dataFormats ?? []).length > 0 ? { dataFormats: [...plan.dataFormats!] } : {}), ...((plan.storage ?? []).length > 0 ? { storage: [...plan.storage!] } : {}) };
}

/**
 * 4.4 (F3): the past a later attempt k carries on, from its task line: the Constructor task and attempt
 * of the lineage's latest product under the current work (latestRecordedProduct), and the review that
 * judged it. Null on a first attempt or a fresh start. Pure: the queue-time builder and the claim use it.
 */
export function attemptPast(events: Line['events'], k: number): { readonly constructor: string; readonly attempt: number; readonly review: string | null } | null {
  const line = new Line(events);
  const spec = workSpecRevision(line);
  const p = line.all<ProductBody>('product').filter((e) => e.revision > spec && e.body.k < k).at(-1);
  if (p === undefined) return null;
  return { constructor: p.body.task, attempt: p.body.k, review: line.all<ReviewBody>('review').filter((r) => r.body.k === p.body.k).at(-1)?.body.task ?? null };
}

/**
 * 4.4 (F3): the Constructor dispatch task and attempt whose candidate a Reviewer's target is (a re-bound
 * version through the version it was re-bound from); null for an integration start with no Constructor.
 */
export function targetConstructor(events: Line['events'], target: string): { readonly constructor: string; readonly attempt: number } | null {
  const line = new Line(events);
  const seen = new Set<string>();
  for (let at = target; !seen.has(at); ) {
    seen.add(at);
    const p = line.all<ProductBody>('product').find((e) => e.body.object === at);
    if (p !== undefined) return startOnly(line, p.body) ? null : { constructor: p.body.task, attempt: p.body.k };
    const rb = line.all<RebindBody>('rebind').find((r) => r.body.product === at);
    if (rb === undefined) return null;
    at = rb.body.from;
  }
  return null;
}

/**
 * Verbatim decisions that bear on the task: decision items, and the answers carried out on its
 * escalations under its current card (an answer on an earlier card, or on an escalation closed as
 * superseded, is history: never quoted as a decision in force).
 */
async function decisionQuotes(ctx: FlowCtx, t: DetailedTask): Promise<string[]> {
  const events = await ctx.ports.ledger.events({ mission: ctx.mission });
  return taskDecisionQuotes(await currentItems(ctx), events, t, constraintsForTask(await currentConstraints(ctx), t, ctx.mission), taskReferencePlan(events));
}

async function cardConstraints(ctx: FlowCtx, t: DetailedTask, kinds: ReadonlySet<'object' | 'instruction'>): Promise<Array<{ id: string; text: string; kind: 'object' | 'instruction' }>> {
  return constraintsForTask(await currentConstraints(ctx), t, ctx.mission)
    .filter((c) => kinds.has(c.kind))
    .map((c) => ({ id: c.line, text: c.text, kind: c.kind }));
}

/** One next attempt, with the context of every grant that ensured it (the rework event stays immutable). */
async function reworkAt(ctx: FlowCtx, t: DetailedTask, line: Line, k: number): Promise<(ReworkBody & { readonly covered: ReadonlyArray<{ readonly issue: string; readonly source: ReopenSource }> }) | null> {
  const body = line.one<ReworkBody>('rework', String(k));
  if (body === null) return null;
  const applied = new Set((await eventsOf<{ what?: { option?: string } }>(ctx, SECRETARY_LINE, 'applied')).filter((e) => e.body.what?.option === 'grant').map((e) => e.key));
  const requests = await reopenRequests(ctx);
  const issues = [...body.issues];
  const instructions = [...body.instructions];
  // 4.4 (p6-r2-1): the reopen requests a grant covered, so the Reviewer of the attempt sees them too
  const reopens: Array<{ issue: string; source: ReopenSource }> = [];
  for (const e of await eventsOf<EscalationBody>(ctx, SECRETARY_LINE, 'escalation')) {
    const facts = e.body.facts as { attempt?: number; loop?: string; issues?: string[] } | undefined;
    if (!applied.has(e.key) || e.body.source !== 'loop-exhausted' || e.body.subject !== `task:${t.id}` || facts?.loop !== 'rework' || facts.attempt !== k - 1) continue;
    const d = await decisionFor(ctx, e.key);
    const keys = coveredReopens(ctx, t.id, line, e);
    const covered = requests.filter((r) => r.task === t.id && r.attempt === k - 1 && keys.includes(r.key));
    issues.push(...(facts.issues ?? []), ...covered.map((r) => r.issue));
    instructions.push(...(d?.instructions ? [d.instructions] : []), ...covered.map((r) => r.instruction));
    for (const r of covered) if (!reopens.some((x) => x.issue === r.issue)) reopens.push({ issue: r.issue, source: r.source });
  }
  return { ...body, issues: [...new Set(issues)], instructions: [...new Set(instructions)], covered: reopens };
}

/** Who reopened an attempt, in words (a Reviewer's card). */
function reopenedBy(s: ReopenSource | undefined): string {
  return s?.kind === 'repair' ? `repair ${s.repair}` : s?.kind === 'review' ? `the review ${s.review} of integration task ${s.integration}` : 'reopened';
}

async function submitConstructor(ctx: FlowCtx, eff: EffectiveBody, plan: DetailedPlanDoc, t: DetailedTask, line: Line, k: number, task: string, deps: readonly string[]): Promise<void> {
  const prev = await latestRecordedProduct(ctx, line, k);
  // A first attempt starts from the base with its dependencies' products. A later attempt (a rework,
  // or a respec after a re-plan) continues from the previous product's candidate while the snapshot
  // a first attempt would get now is the one that version's work started from (its origin). When
  // its dependencies changed since (a re-plan added one, or one was accepted again at a newer
  // version) it starts from that new snapshot with the previous version's whole change laid over it
  // (three-way, as a delivery lays it), so its worktree and its declared runs see the dependencies'
  // current work; the new snapshot is recorded as the attempt's origin, so its product's change is
  // the task's own work only. A conflicting carry starts fresh, with the earlier work
  // readable at its commit for the Constructor to carry over by hand (Appendix M).
  let snap: Awaited<ReturnType<typeof ctx.ports.scheduler.snapshot>>;
  let carryDropped = false;
  // 4.4 (F4): a step that continues attempt k after a pause keeps the attempt's start (its first dispatch:
  // the base its candidate is collected against, its pin) and opens its worktree on the parked commit
  const resumed = line.all<ResumedBody>('resumed').find((r) => r.body.step === task) ?? null;
  const paused = resumed === null ? null : line.one<PausedBody>('paused', resumed.key);
  const start = resumed === null ? null : line.one<DispatchedBody>('dispatched', conTask(ctx.mission, t.id, k));
  if (resumed !== null && (paused === null || start === null)) return internalError(ctx, task, `the step ${task} continues attempt ${k} of task ${t.id}, and its pause or its start is not recorded`);
  const startStep = resumed === null ? task : conTask(ctx.mission, t.id, k);
  const recorded = line.one<DispatchedBody>('dispatched', task) ?? start;
  try {
    snap = recorded !== null ? { path: recorded.snapshot, commit: recorded.commit, products: recorded.prerequisites ?? [], ...(recorded.origin !== undefined ? { origin: recorded.origin } : {}) } : await ctx.ports.scheduler.snapshot(
      prev !== null
        ? { mission: ctx.mission, purpose: `constructor-${t.id}`, commit: prev.commit, carry: { version: prev.object, products: deps }, writable: t.writeScope }
        : { mission: ctx.mission, purpose: `constructor-${t.id}`, products: deps, writable: t.writeScope },
    );
    if (recorded === null && snap.products === undefined) snap = { ...snap, products: await ctx.ports.scheduler.composition(deps) };
  } catch (e) {
    if (prev !== null && (e as { code?: string }).code === 'conflict' && (e as { detail?: { carried?: unknown } }).detail?.carried === true) {
      try {
        const fresh = await ctx.ports.scheduler.snapshot({ mission: ctx.mission, purpose: `constructor-${t.id}`, products: deps, writable: t.writeScope });
        snap = { ...fresh, origin: fresh.commit, products: fresh.products ?? await ctx.ports.scheduler.composition(deps) };
      } catch (freshError) {
        return actionRefused(ctx, task, freshError);
      }
      carryDropped = true;
      await notify(ctx, {
        category: 'rework-carry-dropped',
        wi: null,
        key: `${task}:carry`,
        trigger: `attempt ${k} of task ${t.id} starts fresh: the change from ${prev.object} at ${prev.commit} conflicts with the current dependencies: ${(e as Error).message}`,
        defaultAction: `the earlier change stays readable at ${prev.commit}; the Constructor carries over by hand what still applies to the current dependencies`,
        detail: { task: t.id, attempt: k, previous: prev.object, commit: prev.commit, dependencies: deps, conflicts: (e as { detail?: { conflicts?: unknown } }).detail?.conflicts ?? null },
      });
    } else return actionRefused(ctx, task, e);
  }
  // A crash after the dispatch event must rebuild the same card. Read the existing
  // notice rather than infer a dropped carry from an empty, non-conflicting change.
  if (recorded !== null && prev !== null && snap.origin === snap.commit) {
    const alert = noticeAlertId({ mission: ctx.mission, category: 'rework-carry-dropped', key: `${startStep}:carry` });
    carryDropped = (await ctx.ports.ledger.records(['alert'])).some(({ record }) => record.alert === alert);
  }
  const items = await currentItems(ctx);
  const rw = await reworkAt(ctx, t, line, k);
  // 4.4 (F4): an earlier attempt that stopped to ask and did not go on (re-planned): its edits stay readable
  const left = line.all<PausedBody>('paused').filter((p) => p.body.k === k - 1 && line.one('resumed', p.key) === null).at(-1)?.body;
  const duties = [
    ...(paused !== null ? [`This attempt stopped to ask (pause ${paused.n}) and goes on now: your worktree starts on its edits (commit ${paused.parked}), and the answers are under "Questions on this task". Hand back your finished work, or stop to ask again (blocked).`] : []),
    ...(left !== undefined ? [`Attempt ${left.k} stopped to ask and did not go on; its edits stay readable at commit ${left.parked}.`] : []),
    ...(prev !== null && carryDropped ? [`The earlier attempt's change is not in the tree; it stays readable at commit ${prev.commit}. Carry over by hand what still applies to the current dependencies.`] : []),
    `Implement task ${t.id} (${t.kind}${t.module !== null ? ` of module ${t.module}` : ''}) inside its writable paths, so that every acceptance standard is met.`,
    ...(rw !== null && rw.issues.length > 0 ? ['This is a rework. Fix exactly these issues from the review:', ...rw.issues.map((i) => `- ${i}`)] : []),
    ...(rw !== null && rw.instructions.length > 0 ? ['Instructions:', ...rw.instructions.map((i) => `- ${i}`)] : []),
  ].join('\n');
  // the Constructor's worktree is created at this commit when it is dispatched (§5.3); the write paths are the task's write scope.
  // 4.4 (F4): a continuation's worktree opens on the parked commit (`start`); its candidate is still taken against the attempt's start
  const workspace = { snapshot: snap.commit, ...(paused !== null ? { start: paused.parked } : {}), writablePaths: [...t.writeScope] };
  const { repairs, written } = await repairsOfWork(ctx, eff, t, line, k);
  // 4.4 (F3): a later attempt gets its past: the review of the attempt it carries on, and that attempt's own hand-back (optional)
  const was = attemptPast(line.events, k);
  const past: Array<Awaited<ReturnType<typeof previousHandBack>>> = was === null ? [] : [
    was.review === null ? null : await previousReviewReport(ctx, { review: was.review, attempt: was.attempt }),
    await previousHandBack(ctx, { constructor: was.constructor, attempt: was.attempt }),
  ];
  // 4.4 (F4): a continuation reads the hand-back that stopped to ask (optional)
  if (paused !== null) past.push(await pausedHandBack(ctx, { constructor: paused.step, attempt: k, pause: paused.n, parked: paused.parked }));
  // 4.4 (F4; G5): the attempt's questions with their answers, and every question of the task left open
  const missionEvents = await ctx.ports.ledger.events({ mission: ctx.mission });
  const questions = taskQuestions(missionEvents, t.id, k);
  // 4.4 (G5): the open items the task's card (or a repair's reopen of this work) takes, still open
  const names = cardItemNames(missionEvents, t, k);
  const openItems = takenItems(missionEvents, names, await cardIssues(ctx, missionEvents, names));
  const card: ConstructorCard = {
    ...cardBase(ctx, task, { module: t.module, duties, decisionQuotes: withoutAnswers(await decisionQuotes(ctx, t), questions), constraints: await cardConstraints(ctx, t, new Set(['object', 'instruction'])) }),
    ...(questions.length > 0 ? { questions: cardQuestions(questions) } : {}),
    ...(openItems.length > 0 ? { openItems } : {}),
    ...(repairs.length > 0 ? { repairs } : {}),
    ...written,
    seat: 'constructor',
    workspace,
    goal: t.goal,
    standards: cardStandards(t),
    requirementItems: taskRequirementItems(items, t),
    readableFiles: [...t.readableFiles],
    interpreter: t.interpreter,
    verificationCommands: t.verificationCommands.map((c) => ({ ...c })),
    interfaces: { implements: interfaceDefs(plan, t.implements), calls: interfaceDefs(plan, t.calls) },
    ...(t.exclusive.length > 0 ? { exclusive: [...t.exclusive] } : {}),
    ...planData(plan),
    ...attach(past),
  };
  await commit(ctx, `flow:dispatched:${ctx.mission}:${task}`, {
    events: [ev(ctx, taskLine(t.id), 'dispatched', task, recorded ?? { k, snapshot: snap.path, commit: snap.commit, dplan: eff.dplan, prerequisites: [...(snap.products ?? deps)], predecessor: prev?.object ?? null, ...(snap.origin !== undefined ? { origin: snap.origin } : {}) } satisfies DispatchedBody)],
  });
  await ctx.ports.scheduler.submit({
    task,
    lineage: taskLineage(ctx.mission, t.id),
    mission: ctx.mission,
    card,
    priority: 50,
    capabilities: [...card.capabilities, 'run-commands'],
    mode: eff.mode,
    estimateMicros: t.estimate.costMicros,
    writeScope: t.writeScope,
    snapshot: { repo: 'project', commit: snap.commit },
    ...(t.exclusive.length > 0 ? { exclusive: [...t.exclusive] } : {}),
    // who hands it over (§3.2, U-13): the Architect that decomposed the plan, or the Reviewer that asked for the rework;
    // 4.4 (F4): a continuation, the answer to the pause it continues
    handover: resumed !== null ? { objects: [eff.dplan], step: `attempt ${k} of task ${t.id}, resumed after pause ${resumed.body.n} by the answer to ${resumed.body.escalation}` } : handoverOfConstructor(ctx, eff, line, k, t),
  });
}

/**
 * Where the task's current work started: the revision of its latest spec that started afresh. A card a
 * repair changed (4.1.3) carries the earlier work on, so its spec does not start afresh: the one before it does.
 */
function workSpecRevision(line: Line): number {
  const specs = line.all<SpecBody>('spec');
  let i = specs.length - 1;
  while (i > 0 && specs[i]!.body.repair !== undefined) i--;
  return specs[i]?.revision ?? 0;
}

/** The lineage's latest recorded product under the current work (workSpecRevision) before attempt k, at the version its last Reviewer judged (a re-bound version included). */
async function latestRecordedProduct(ctx: FlowCtx, line: Line, k: number): Promise<ProductBody | null> {
  const spec = workSpecRevision(line);
  const product = line.all<ProductBody>('product').filter((e) => e.revision > spec && e.body.k < k).at(-1);
  return product === undefined ? null : reviewedProduct(ctx, line, product.body.k);
}

/** The handover of a Constructor attempt: the Architect dispatch and plan version (attempt 1), or the Reviewer that sent it back. */
function handoverOfConstructor(ctx: FlowCtx, eff: EffectiveBody, line: Line, k: number, t: DetailedTask): NonNullable<import('./ports.ts').FlowTask['handover']> {
  const rw = line.one<ReworkBody>('rework', String(k));
  if (rw !== null && rw.reason === 'reviewer') {
    const review = line.all<ReviewBody>('review').filter((r) => r.body.k === k - 1).at(-1);
    if (review !== undefined) return { from: review.body.task, objects: [eff.dplan], step: `the Reviewer's rework of task ${t.id}, attempt ${k - 1}` };
  }
  // reopened by an integration review (D-6): that Reviewer hands it over
  if (rw !== null && rw.reason === 'reopen' && rw.reopen?.kind === 'review') return { from: rw.reopen.review, objects: [eff.dplan], step: `the review ${rw.reopen.review} of integration task ${rw.reopen.integration} reopened task ${t.id}` };
  if (rw !== null) return { objects: [eff.dplan], step: `attempt ${k} of task ${t.id} (${rw.reason})` };
  return { from: eff.dplan.startsWith('dplan.') ? `arch.${eff.dplan.slice('dplan.'.length)}` : null, objects: [eff.dplan], step: `task ${t.id} of the detailed plan ${eff.dplan}` };
}

async function submitReviewer(
  ctx: FlowCtx,
  eff: EffectiveBody,
  plan: DetailedPlanDoc,
  t: DetailedTask,
  line: Line,
  k: number,
  task: string,
  product: ProductBody,
  runs: readonly VerificationRun[],
  o: {
    readonly duties?: string;
    readonly afterClose?: 'audit';
    /** Versions of this attempt whose open issues the Reviewer also answers (a re-bound version's predecessors). */
    readonly observedOn?: readonly string[];
    readonly handover?: { readonly from: string | null; readonly objects: readonly string[]; readonly step: string };
  } = {},
): Promise<void> {
  const ix = await basisIndex(ctx);
  const c = ctx.ports.ledger.content;
  const obj = await objectRecord(ctx, product.object);
  const changedPaths = obj?.source === undefined ? product.changedPaths : (await ctx.ports.scheduler.product({
    mission: ctx.mission, module: t.module ?? t.id, task: product.task, dispatch: product.dispatch,
    candidate: product.commit, base: product.commit, writeScope: obj.source.writeScope, taskType: t.kind,
    prerequisites: c.getList(obj.prerequisites), reviews: obj.reviews, predecessor: obj.predecessor ?? null,
    ...(obj.source.origin !== undefined ? { origin: obj.source.origin } : {}),
  })).changedPaths;
  const scope = obj?.scope ?? { paths: [...changedPaths], taskType: t.kind };
  const { checks, list: cardConstraintsList } = await objectConstraints(ctx, scope, obj?.mission ?? ctx.mission);
  // the Constructor's gaps (8.1: answer every one)
  const conView = await ctx.ports.scheduler.status(product.task);
  const cr = (conView?.handBack?.result ?? null) as ConstructorResult | null;
  const gaps = [
    ...(cr?.unmet_standards ?? []).map((u, i) => ({ id: `unmet-${i + 1}`, text: `standard ${u.standard} not met: ${u.why}` })),
    ...(cr?.unfixed_problems ?? []).map((p, i) => ({ id: `problem-${i + 1}`, text: p })),
  ];
  // One required-answers rule for every Reviewer path (v51 §5.6), including earlier
  // rounds on this target and superseded re-bind siblings. Deferral still needs a disposition.
  const earlier = lineageVersions(line, k);
  earlier.add(product.object);
  for (const version of o.observedOn ?? []) earlier.add(version);
  const responses = await lineageIssueResponses(ctx, line, k);
  const openIssues: Array<{ issue: string; text: string }> = [];
  if (earlier.size > 0) {
    for (const rec of await ctx.ports.ledger.records(['issue'])) {
      const r = rec.record as IssueRecord;
      if (!c.getList(r.observedOn).some((o) => earlier.has(o))) continue;
      let text = r.issue as string;
      try {
        if (r.text !== undefined) text = (JSON.parse(c.get(r.text)) as { text?: string }).text ?? text;
      } catch {
        /* the id stands in */
      }
      const answer = responses.get(r.issue);
      openIssues.push({ issue: r.issue, text: answer === undefined ? text : `${text}\nPrevious response: ${issueResponseContext(ctx, answer)}` });
    }
  }
  const m = line.all('reanswer').filter((x) => x.key.startsWith(`${k}:`)).length;
  // 4.1.2 (item 7): the previous Reviewer of this task, its verdict and its reasons
  const previousReview = await previousReviewOf(ctx, line, task);
  // 4.1.2 (D-6): an integration task's review sees each dependency's product and the paths it changed, and may reopen one
  const startOnlyAttempt = startOnly(line, product);
  const integration = t.kind === 'integration' ? { hasConstructor: !startOnlyAttempt, dependencies: await dependencyProducts(ctx, plan, t) } : undefined;
  const rw = await reworkAt(ctx, t, line, k);
  // 4.4 (p6-r2-1): an attempt a grant gave a covered reopen tells its Reviewer the reopen's issue too (with no Constructor, no other card shows it)
  const reopened = rw?.reason === 'reopen' ? ` This attempt was reopened (${reopenedBy(rw.reopen)}): ${rw.issues.join('; ')}. Judge whether it is fixed too; if it is not, say so as a finding.`
    : rw !== null && rw.covered.length > 0 ? ` This attempt was granted for a reopen (${[...new Set(rw.covered.map((c) => reopenedBy(c.source)))].join('; ')}): ${rw.covered.map((c) => c.issue).join('; ')}. Judge whether it is fixed too; if it is not, say so as a finding.` : '';
  // 4.4 (F13): the repairs this attempt carries (each reopen opens its own attempt), judged the same way
  const { repairs, written } = await repairsOfWork(ctx, eff, t, line, k);
  // 4.4 (F3, E-4): the Constructor's hand-back of the attempt under review, as claims to check (optional, never evidence)
  const claims = startOnlyAttempt ? null : await constructorClaims(ctx, { constructor: product.task, task: t.id, attempt: product.k });
  // 4.4 (F3): the data formats and storage of the plan the target's review contract relies on
  const contractPlan = taskReferencePlan(await ctx.ports.ledger.events({ mission: ctx.mission }), obj?.reviews.find((r) => r.review === 'reviewer'));
  const formats = contractPlan === undefined ? null : (await detailedPlanOf(ctx, contractPlan))?.plan;
  // 4.4 (F4): the questions of the attempt under review with their answers, and those left open on the task
  const missionEvents = await ctx.ports.ledger.events({ mission: ctx.mission });
  const questions = taskQuestions(missionEvents, t.id, product.k);
  // 4.4 (G5): the open items the task's card (or a repair's reopen of this work) takes, still open: the Reviewer answers each
  const names = cardItemNames(missionEvents, t, product.k);
  const openItems = takenItems(missionEvents, names, await cardIssues(ctx, missionEvents, names));
  // 4.4 (F10, E-4): the files the runs kept, and the files outside the commit the Constructor handed in, with its attempt
  const kept = new Map((await ctx.ports.ledger.events<KeptArtifactsBody>({ mission: ctx.mission, line: ARTIFACTS_LINE, event: KEPT_ARTIFACTS })).map((e) => [e.key, e.body.artifacts] as const));
  const handedIn = startOnlyAttempt ? [] : (conView?.handBack?.data ?? []).map((d) => ({ pointer: d.pointer, attempt: product.k, dispatch: conView!.handBack!.dispatch, label: d.label, ...(d.kept !== undefined ? { kept: `.mission-pipeline/${d.kept}` } : { notKept: d.notKept ?? 'no copy was made' }) }));
  const card: ReviewerCard = {
    ...cardBase(ctx, task, {
      module: t.module,
      duties: o.duties ?? `Judge the candidate of task ${t.id} (attempt ${k}${m > 0 ? `, review ${m + 1} after a decision` : ''}) against each standard, independently.${reopened}`,
      decisionQuotes: withoutAnswers(reviewerDecisionQuotes(ctx.mission, await currentItems(ctx), await ctx.ports.ledger.events({ mission: ctx.mission }), t, await currentConstraints(ctx), k, taskReferencePlan(await ctx.ports.ledger.events({ mission: ctx.mission }), obj?.reviews.find((r) => r.review === 'reviewer'))), questions),
      constraints: [...cardConstraintsList, ...await cardConstraints(ctx, t, new Set(['instruction']))],
    }),
    ...(questions.length > 0 ? { questions: cardQuestions(questions) } : {}),
    ...(openItems.length > 0 ? { openItems } : {}),
    seat: 'reviewer',
    workspace: { snapshot: product.snapshot, writablePaths: [] },
    target: product.object,
    review: 'reviewer',
    standards: cardStandards(t),
    interfaces: [...interfaceDefs(plan, t.implements), ...interfaceDefs(plan, t.calls)],
    candidate: { changedPaths: [...changedPaths] },
    // 4.4 (F10): with the files each run kept, read from its record (a run reused from one recorded before its command named them kept none: said so)
    verificationRuns: runs.map((r) => {
      const named = t.verificationCommands.find((c) => c.command === r.command)?.artifacts ?? [];
      const artifacts = kept.get(r.evidence) ?? named.map((path) => ({ path, why: 'this run kept no files: it was recorded before its command named them' }));
      return { evidence: r.evidence, command: r.command, summary: r.summary, ...(artifacts.length > 0 ? { artifacts: [...artifacts] } : {}) };
    }),
    ...(handedIn.length > 0 ? { handedIn } : {}),
    declaredCommands: t.verificationCommands.map((x) => ({ ...x })),
    selfReportedGaps: gaps,
    openIssues,
    ...(previousReview !== null ? { previousReview } : {}),
    ...(integration !== undefined ? { integration } : {}),
    ...(repairs.length > 0 ? { repairs } : {}),
    ...written,
    ...planData(formats),
    ...attach([claims]),
    binding: {
      judgment: `j.${task}`,
      bases: c.putList(currentVersions(ix, reviewContractLines(ctx.mission, t, ix, obj?.reviews.find((r) => r.review === 'reviewer')))),
      constraints: c.putList([...new Set(checks)].sort()),
      // the objects the version's contract relies on (v51 §5.2: a judgment conforms to the contract fixed with
      // its target), which for a version recorded under an earlier plan is that plan, not the one in effect
      reliesOn: c.putList(reliedPlans(obj, eff)),
      // 4.4 (F10, review p9-r2-1): the failing judgment of this very version that a decider's answer sent to this review
      revokes: await failureToSupersede(ctx, t.id, product.object, task),
      extends: null,
      evidenceUse: { fields: ['exit'], statisticalOrExternal: false },
      superseded: [],
    },
  };
  await ctx.ports.scheduler.submit({
    task,
    lineage: taskLineage(ctx.mission, t.id),
    mission: ctx.mission,
    card,
    priority: 60,
    capabilities: [...card.capabilities, 'run-commands'],
    mode: eff.mode,
    estimateMicros: Math.max(200_000, Math.round(t.estimate.costMicros / 2)),
    binds: [product.object],
    ...(o.afterClose !== undefined ? { afterClose: o.afterClose } : {}),
    // who hands it over (§3.2, U-13): the Constructor whose candidate it judges (a re-review: the renewal; a re-bind: the program)
    handover:
      o.handover !== undefined
        ? { from: o.handover.from, objects: [...o.handover.objects], step: o.handover.step }
        : o.afterClose !== undefined
          ? { from: null, objects: [product.object], step: `a re-review of ${product.object} after an environment change (mp pm renew)` }
          : startOnlyAttempt
            ? { from: null, objects: [product.object], step: `the start snapshot of integration task ${t.id}, attempt ${k} (it writes nothing: no Constructor)` }
            : { from: product.task, objects: [product.object], step: `the candidate of task ${t.id}, attempt ${k}` },
  });
  ctx.progressed = true;
}

/**
 * 4.4 (F10, review p9-r2-1): the judgment a new review of `target` supersedes: the task's latest review of that very
 * version, when it failed. A failing review is followed by another review of the same version only through a
 * decider's answer (a fourth answer's review sent back as "rework", an integration rework with nothing to reopen),
 * and a negation stands until a pass names it (evaluator/store.ts positionAfter). Null: the latest review of the
 * version did not fail, or there is none.
 */
async function failureToSupersede(ctx: FlowCtx, taskId: string, target: string, current: string): Promise<string | null> {
  const reviews = (await readLine(ctx, taskId)).all<ReviewBody>('review').filter((r) => r.body.task !== current);
  for (const r of reviews.toReversed()) {
    const j = await judgmentRecordOf(ctx, r.body.judgment);
    if (j === null || j.target !== target) continue;
    return j.verdict === 'fail' ? j.judgment : null;
  }
  return null;
}

/** The previous Reviewer of the task (any attempt, before this review task): its verdict, each standard it did not find met, with the reason, and its findings. */
async function previousReviewOf(ctx: FlowCtx, line: Line, current: string): Promise<NonNullable<ReviewerCard['previousReview']> | null> {
  const prev = line.all<ReviewBody>('review').filter((r) => r.body.task !== current).at(-1);
  if (prev === undefined) return null;
  const result = ((await ctx.ports.scheduler.status(prev.body.task))?.handBack?.result ?? null) as ReviewerResult | null;
  const unmet = result !== null
    // 4.4 (F10): a standard it could not verify, with what would be needed
    ? result.judgments.filter((j) => j.met !== 'yes').map((j) => ({ standard: j.standard, met: j.met as 'no' | 'unclear' | 'cannot-verify', reason: j.met === 'cannot-verify' ? `${j.reason}; needed: ${j.needed ?? ''}` : j.reason }))
    // a result not readable any more: the recorded issue lines stand in ("[S1] not met: why")
    : prev.body.issues.flatMap((i) => { const m = /^\[([^\]]+)\] (not met|unclear|cannot be verified): (.*)$/s.exec(i); return m === null ? [] : [{ standard: m[1]!, met: (m[2] === 'not met' ? 'no' : m[2] === 'unclear' ? 'unclear' : 'cannot-verify') as 'no' | 'unclear' | 'cannot-verify', reason: m[3]! }]; });
  const findings = result !== null ? [...result.findings] : prev.body.issues.filter((i) => i.startsWith('finding: ')).map((i) => i.slice('finding: '.length));
  return { review: prev.body.task, attempt: prev.body.k, verdict: prev.body.verdict, unmet, findings };
}

/** The paths a task's product changed, as recorded with its product event (a re-bound version brings its predecessor's change). */
function changedPathsOf(line: Line, product: string): string[] {
  const own = line.all<ProductBody>('product').find((p) => p.body.object === product);
  if (own !== undefined) return [...own.body.changedPaths];
  const rb = line.all<RebindBody>('rebind').find((r) => r.body.product === product);
  return rb === undefined ? [] : changedPathsOf(line, rb.body.from);
}

/** An integration task's dependencies (direct, through taskDependencies with the tasks repairs added, and through other tasks) with their accepted products and the paths those changed (D-6 tracing aid). */
async function dependencyProducts(ctx: FlowCtx, plan: DetailedPlanDoc, t: DetailedTask): Promise<NonNullable<ReviewerCard['integration']>['dependencies']> {
  const byId = new Map(plan.tasks.map((x) => [x.id, x]));
  const direct = await taskDependencies(ctx, plan, t);
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (ids: readonly string[]): void => {
    for (const d of ids) {
      if (seen.has(d)) continue;
      seen.add(d);
      order.push(d);
      visit(byId.get(d)?.dependsOn ?? []);
    }
  };
  visit(direct);
  const out: Array<NonNullable<ReviewerCard['integration']>['dependencies'][number]> = [];
  for (const id of order) {
    const p = await acceptedProduct(ctx, id);
    if (p === null) continue;
    const line = await readLine(ctx, id);
    out.push({ task: id, product: p, attempt: line.k, direct: direct.includes(id), changedPaths: changedPathsOf(line, p) });
  }
  return out;
}

/**
 * Which accepted products of the mission changed each path (`mp seat <id> owners`, the integration
 * review's and the repair's tracing aid): from the paths recorded with each product, through the
 * task lines' acceptances (current or earlier). A path ending in "/" or "/**" names a directory.
 */
export async function pathOwners(ctx: FlowCtx, paths: readonly string[]): Promise<PathOwners> {
  const tasks = new Set<string>();
  for (const e of await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')) for (const t of e.body.tasks) tasks.add(t);
  const lines = new Map<string, Line['events']>();
  for (const id of tasks) lines.set(id, (await readLine(ctx, id)).events);
  return ownersOfPaths(lines, paths);
}

type PathOwners = Array<{ readonly path: string; readonly owners: ReadonlyArray<{ readonly task: string; readonly attempt: number; readonly product: string; readonly current: boolean; readonly paths: readonly string[] }> }>;

/** pathOwners over task lines already read (4.4, F5: the repair card's claim-time rebuild reads them from the memory). */
export function ownersOfPaths(lines: ReadonlyMap<string, Line['events']>, paths: readonly string[]): PathOwners {
  const accepted: Array<{ task: string; attempt: number; product: string; current: boolean; changed: readonly string[] }> = [];
  for (const [id, events] of lines) {
    const line = new Line(events);
    const now = lineAcceptance(line.events).product;
    for (const a of line.all<{ k: number; product: string }>('accepted')) accepted.push({ task: id, attempt: a.body.k, product: a.body.product, current: a.body.product === now, changed: changedPathsOf(line, a.body.product) });
    for (const r of line.all<ReboundBody>('rebound')) accepted.push({ task: id, attempt: r.body.k, product: r.body.product, current: r.body.product === now, changed: changedPathsOf(line, r.body.product) });
  }
  return paths.map((path) => {
    const dir = path.endsWith('/**') ? path.slice(0, -3) : path.endsWith('/') ? path.slice(0, -1) : null;
    const hit = (p: string): boolean => (dir === null ? p === path : p === dir || p.startsWith(`${dir}/`));
    return { path, owners: accepted.filter((a) => a.changed.some(hit)).map((a) => ({ task: a.task, attempt: a.attempt, product: a.product, current: a.current, paths: a.changed.filter(hit) })) };
  });
}

/**
 * An accepted product built on a version its dependency has since replaced (4.1.2, D-6 no cascade):
 * its prerequisites that are a task's earlier accepted version, with that task's version now. The
 * read says so honestly; nothing is re-reviewed or rebuilt for it (the integration's full run checks
 * the combination). Pure: from the task lines' events and the product's recorded prerequisites.
 */
export function builtOnOlder(prerequisites: readonly string[], lines: ReadonlyMap<string, Line['events']>): Array<{ readonly prerequisite: string; readonly task: string; readonly attempt: number; readonly newer: string }> {
  const out: Array<{ prerequisite: string; task: string; attempt: number; newer: string }> = [];
  for (const [task, events] of lines) {
    const line = new Line(events);
    const versions = new Set([
      ...line.all<{ product: string }>('accepted').map((a) => a.body.product),
      ...line.all<ReboundBody>('rebound').map((r) => r.body.product),
    ]);
    const now = lineAcceptance(events);
    if (now.product === null) continue;
    for (const p of prerequisites) {
      const k = versions.has(p) ? productAttempt(events, p) : null;
      if (k !== null && p !== now.product && now.k > k) out.push({ prerequisite: p, task, attempt: k, newer: now.product });
    }
  }
  return out;
}

/** The objects a product version's Reviewer contract relies on (the plan in effect for a version without a contract). */
function reliedPlans(obj: ObjectVersionRecord | null, eff: EffectiveBody): string[] {
  const relied = obj?.reviews.find((r) => r.review === 'reviewer')?.reliesOn ?? [];
  return relied.length > 0 ? [...relied] : [eff.dplan];
}

/** The object constraints that apply to a version's scope now (v51 §5.2, 9.5): the checks a judgment binds, and the card's list. */
async function objectConstraints(ctx: FlowCtx, scope: ObjectScope, mission: string = ctx.mission): Promise<{ readonly checks: string[]; readonly list: Array<{ id: string; text: string; kind: 'object' | 'instruction' }> }> {
  return reviewObjectConstraints(await currentConstraints(ctx), { scope, mission });
}
