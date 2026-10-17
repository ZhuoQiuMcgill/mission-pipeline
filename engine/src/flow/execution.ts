import { contractLines as reviewContractLines, objectConstraints as reviewObjectConstraints } from '../seat/cards/inputs.ts';
import { constraintsForTask } from '../seat/cards/dynamic.ts';
import { taskDecisionQuotes, taskRequirementItems, reviewerDecisionQuotes, taskReferencePlan } from '../seat/cards/dynamic.ts';
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
//   Constructor's "questions that need a decision" → the Secretary, without stopping the task
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
import type { ConstructorResult, ReviewerResult } from '../seat/results.ts';
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
  objectRecord,
  safeId,
  shortHash,
  taskView,
  missionClosed,
  judgmentRecordOf,
  type FlowCtx,
} from './context.ts';
import { handleFailure, type FailureOutcome } from './failures.ts';
import { DetailedTask, PLAN_LINE, RENEW_LINE, REPAIRS_LINE, REVIEW_NEEDED, SECRETARY_LINE, amendedPlan, repairOfTask, repairRef, taskCardHash, taskIdProblems, taskLine, type DetailedPlanDoc, type RepairBody, type RepairDecidedBody, type RepairRef, type ReviewNeededBody } from './plandoc.ts';
import { detailedPlanOf, internalError, latestEffective, planOf, standardLine, planAnswersReplan, contestedProduction, type EffectiveBody } from './planning.ts';
import type { FlowSchedulerPort, ProductVersion, VerificationRun } from './ports.ts';
import { currentConstraints, currentItems } from './requirements.ts';
import { carryOut, closing, commitCarrying, decisionFor, escalateToUser, markApplied, openEscalations, raiseEscalation, type DecisionBody, type EscalationBody } from './secretary.ts';
import { WI } from './wi.ts';

interface SpecBody {
  readonly dplan: string;
  readonly hash: string;
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
}

// the task id encoded injectively (review r2): safeId alone turned "a_b" and "a-b" into one id
export const taskLineage = (mission: string, task: string): string => safeId(`task.${mission}.${idPart(task)}`);
/** A task's card identity under a plan: a spec records it, and a different one is a re-plan of the task (taskStep; plandoc.ts). */
export { taskCardHash };

/** An integration task with nothing to write gets no Constructor (4.1.2): its candidate is its start snapshot. */
export const noConstructor = (t: Pick<DetailedTask, 'kind' | 'writeScope'>): boolean => t.kind === 'integration' && t.writeScope.length === 0;
const conTask = (mission: string, task: string, k: number): string => safeId(`con.${mission}.${idPart(task)}.${k}`);
const revTask = (mission: string, task: string, k: number, m: number): string => safeId(`rev.${mission}.${idPart(task)}.${k}${m > 0 ? `.r${m}` : ''}`);

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
  const eff = await latestEffective(ctx);
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
    return;
  }
  // reopen decisions (an integration review's, a repair's) carried out before the tasks move (restartable)
  await carryReopens(ctx, stored.plan);
  const kept: KeptReport = { review: [], successors: null };
  try {
    for (const t of stored.plan.tasks) await taskStep(ctx, eff, stored.plan, t, kept);
  } finally {
    // what this pass re-bound is told even when a later task's step failed
    await keptNotices(ctx, eff, kept);
  }
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
  const requests: Array<{ readonly key: string; readonly revision: number; readonly body: { readonly reason: string } }> = [
    ...(await eventsOf<ReviewNeededBody>(ctx, RENEW_LINE, REVIEW_NEEDED))
      .filter((e) => e.body.target === cur.product && e.body.review === 'reviewer')
      .map((e) => ({ key: e.key, revision: e.revision, body: { reason: `the environment changed (${e.body.reason}), so the runs were recorded again under the current environment` } })),
    ...line.all<{ k: number; reason: string; product?: string }>('basis-revised').filter((e) => e.body.k === k && (e.body.product ?? original) === cur.product),
  ].sort((a, b) => a.revision - b.revision);
  if (requests.length === 0) return;
  const all = line.all<RereviewBody>('rereview').filter((r) => r.body.k === k);
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
    switch (review.verdict) {
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
          summary: `The Reviewer of task ${t.id} (attempt ${r.k}, re-review ${r.n} after an environment change) needs a decision: the standards are unclear or in conflict.`,
          reasons: [...review.issues],
          options: ['answer', 'rework', 'replan', 'ask-user'],
          items: t.requirementItems,
          facts: { task: t.id, attempt: r.k, product: product.object, issues: review.issues, rereview: r.n },
          handover: { from: r.rev, objects: [product.object] },
        });
        break;
    }
  }
  return review.verdict;
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

  // the task's card under this plan; a changed card (re-plan) restarts it at the next attempt
  const hash = taskCardHash(t);
  const specs = line.all<SpecBody>('spec');
  const last = specs.at(-1);
  const droppedAfter = line.all<{ dplan: string }>('dropped').some((d) => last === undefined || d.revision > last.revision);
  if (last === undefined || last.body.hash !== hash || droppedAfter) {
    const started = line.all('dispatched').length > 0;
    const events = [ev(ctx, lineName, 'spec', `${eff.dplan}#${specs.length + 1}`, { dplan: eff.dplan, hash } satisfies SpecBody)];
    if (started) {
      await cancelAttempt(ctx, t, line.k, 're-planned');
      events.push(ev(ctx, lineName, 'rework', String(line.k + 1), { k: line.k + 1, reason: 'respec', issues: [], instructions: [`The plan changed (${eff.dplan}).`] } satisfies ReworkBody));
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

  // a re-plan this task asked for: wait for a newer effective plan, then start the next attempt
  const waits = line.all<{ dplan: string; escalation: string }>('waiting-replan');
  const reworkRevisions = line.events.filter((e) => e.event === 'rework').map((e) => e.revision);
  const pending = waits.filter((w) => !reworkRevisions.some((r) => r > w.revision));
  for (const w of pending) {
    if (w.body.dplan === eff.dplan || !(await planAnswersReplan(ctx, eff.dplan, w.body.escalation))) return;
    // the new plan kept this task's card: start the next attempt anyway (the re-plan was decided for it)
    await commit(ctx, `flow:replanned:${ctx.mission}:task:${idPart(t.id)}:${w.key}`, { events: [ev(ctx, lineName, 'rework', String(line.k + 1), { k: line.k + 1, reason: 'replan', issues: [], instructions: [`Re-planned (${w.key}).`] } satisfies ReworkBody)] });
    return;
  }

  // decisions on this task's escalations
  for (const e of await openEscalations(ctx, `task:${t.id}`)) {
    const blocking = await applyTaskDecision(ctx, eff, t, line, e);
    line = await readLine(ctx, t.id);
    if (blocking) return;
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

  // an integration review reopened dependencies (D-6): this attempt waits until each is accepted again (one
  // given up is told to the PM), and builds on their new work too (a dependency reached only through another
  // one is laid over it: no cascade)
  const reopened = await reopenedProducts(ctx, plan, t, line);
  if (reopened === null) return;
  // gate: dependencies accepted; stable mode: proven
  const deps: string[] = [];
  for (const d of t.dependsOn) {
    const p = await acceptedProduct(ctx, d);
    if (p === null) return;
    deps.push(p);
  }
  for (const p of reopened) if (!deps.includes(p)) deps.push(p);
  if (eff.mode === 'stable') {
    const labels = await ctx.ports.evaluator.labels([eff.dplan, ...deps]);
    if ([eff.dplan, ...deps].some((x) => labels.labels[x] !== 'proven')) return;
  }

  // the Constructor
  const con = conTask(ctx.mission, t.id, k);
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
    const r = view.result as ConstructorResult;
    product = { ...pv, k, dispatch: hb.dispatch, task: con, decisions: [...r.decisions_needed] };
    await commit(ctx, `flow:product:${ctx.mission}:${con}`, { events: [ev(ctx, lineName, 'product', String(k), product)] });
    line = await readLine(ctx, t.id);
  }
  if ((product.decisions ?? []).length > 0) {
    // 3.8: the Constructor's questions go to the Secretary (raised on every pass until it exists:
    // a crash after the product cannot lose them, code review r1 #14); the task goes on to review meanwhile
    await raiseEscalation(ctx, {
      id: `cdec.${con}`,
      source: 'constructor-decision',
      lineage,
      subject: `task:${t.id}`,
      summary: `The Constructor of task ${t.id} (attempt ${k}) raised questions that need a decision.`,
      reasons: [...(product.decisions ?? [])],
      options: ['answer', 'replan', 'ask-user'],
      items: t.requirementItems,
      facts: { task: t.id, attempt: k, questions: product.decisions, product: product.object },
      handover: { from: con, objects: [product.object] },
    });
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
  switch (review.verdict) {
    case 'pass':
      await commit(ctx, `flow:accepted:${ctx.mission}:task:${idPart(t.id)}:${k}`, { events: [ev(ctx, lineName, 'accepted', String(k), { k, product: product.object, judgment: review.judgment })] });
      return;
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

/** Whether a product is an integration task's start snapshot: no Constructor ran for its attempt (4.1.2). */
function startOnly(line: Line, product: ProductBody): boolean {
  return line.one<DispatchedBody>('dispatched', product.task)?.noConstructor === true;
}

/** A Reviewer's "needs decision" goes to the Secretary; a task with no Constructor offers no rework (its fix is a dependency's). */
async function reviewerNeedsDecision(ctx: FlowCtx, t: DetailedTask, k: number, rev: string, review: ReviewBody, product: ProductBody, why: string | null): Promise<void> {
  await raiseEscalation(ctx, {
    id: `rnd.${rev}`,
    source: 'reviewer-needs-decision',
    lineage: taskLineage(ctx.mission, t.id),
    subject: `task:${t.id}`,
    summary: why === null ? `The Reviewer of task ${t.id} (attempt ${k}) needs a decision: the standards are unclear or in conflict.` : `The Reviewer of task ${t.id} (attempt ${k}) needs a decision: ${why}.`,
    reasons: [...review.issues],
    options: startOnly(await readLine(ctx, t.id), product) ? ['answer', 'replan', 'ask-user'] : ['answer', 'rework', 'replan', 'ask-user'],
    items: t.requirementItems,
    facts: { task: t.id, attempt: k, product: product.object, issues: review.issues },
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

/** The latest reopen of each dependency an integration review reopened under the task's current card. */
function reopenEntries(line: Line): Map<string, { readonly task: string; readonly attempt: number; readonly product: string; readonly issue: string; readonly evidence?: string }> {
  const spec = line.all('spec').at(-1)?.revision ?? 0;
  const out = new Map<string, { readonly task: string; readonly attempt: number; readonly product: string; readonly issue: string; readonly evidence?: string }>();
  for (const e of line.all<ReopenBody>('reopen')) if (e.revision > spec) for (const x of e.body.tasks) out.set(x.task, x);
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

/** One reopened task's new attempt (D-6, D-10), counted on its rework loop (used up: WI-08 and the Secretary); restartable by `key`. */
async function reopenTask(ctx: FlowCtx, plan: DetailedPlanDoc, taskId: string, attempt: number, issue: string, instruction: string, key: string, source: ReopenSource): Promise<void> {
  const t = plan.tasks.find((x) => x.id === taskId);
  // the plan in effect no longer has it (a re-plan dropped it): the reopen is moot
  if (t === undefined) return;
  const line = await readLine(ctx, taskId);
  // it moved on (its new attempt is this one, or a re-plan restarted it), or it was given up: nothing to do
  if (line.abandoned || line.k !== attempt || line.one('accepted', String(attempt)) === null) return;
  const verdict = line.one<{ proceed: boolean }>('loop-verdict', key);
  if (verdict !== null && !verdict.proceed) return; // its rework loop is used up: the escalation raised then decides
  await rework(ctx, t, attempt, [issue], [instruction], key, { reason: 'reopen', reopen: source });
}

/**
 * The reopen decisions carried out (D-6: an integration review's; D-10: a repair's): each named
 * task gets its new attempt once. Run on every pass, so a crash between a decision and its effects
 * loses nothing. The reopened task's other dependents keep their products and their proof (no
 * cascade): the integration's full run checks the combination.
 */
async function carryReopens(ctx: FlowCtx, plan: DetailedPlanDoc): Promise<void> {
  for (const e of await ctx.ports.ledger.events<ReopenBody>({ mission: ctx.mission, event: 'reopen' })) {
    if (!e.line.startsWith('task:')) continue;
    const integration = e.line.slice('task:'.length);
    for (const x of e.body.tasks) {
      const issue = `${x.issue}${x.evidence !== undefined ? ` (evidence: ${x.evidence})` : ''}`;
      const instruction = `Reopened by the review ${e.body.review} of integration task ${integration} (attempt ${e.body.k}): fix this in your task's work (your accepted product ${x.product} stays recorded until this attempt is accepted); the integration task builds again on your new work.`;
      await reopenTask(ctx, plan, x.task, x.attempt, issue, instruction, `reopen:${integration}:${e.body.k}`, { kind: 'review', integration, review: e.body.review, attempt: e.body.k });
    }
  }
  const repairs = new Map((await eventsOf<RepairBody>(ctx, REPAIRS_LINE, 'repair')).map((r) => [r.key, r.body]));
  for (const e of await eventsOf<RepairDecidedBody>(ctx, REPAIRS_LINE, 'decided')) {
    const r = repairs.get(e.body.repair);
    for (const x of e.body.reopen) {
      const instruction = `Reopened by repair ${e.body.repair}${r !== undefined ? ` (${r.kind}; the user's words ${r.words}: "${r.text}")` : ''}: fix this in your task's work (your accepted product ${x.product} stays recorded until this attempt is accepted).`;
      await reopenTask(ctx, plan, x.task, x.attempt, x.issue, instruction, `reopen:repair:${e.body.repair}`, { kind: 'repair', repair: e.body.repair });
    }
  }
}

/** The repairs a task's work answers (D-10): the repair that added the task, and the one that reopened this attempt. */
async function repairsOfWork(ctx: FlowCtx, eff: EffectiveBody, t: DetailedTask, line: Line, k: number): Promise<RepairRef[]> {
  const ids = new Set<string>();
  const added = repairOfTask(eff.amendments, t.id);
  if (added !== null) ids.add(added);
  const rw = line.one<ReworkBody>('rework', String(k));
  if (rw?.reopen?.kind === 'repair') ids.add(rw.reopen.repair);
  if (ids.size === 0) return [];
  const all = await eventsOf<RepairBody>(ctx, REPAIRS_LINE, 'repair');
  return all.filter((r) => ids.has(r.key)).map((r) => repairRef(r.body));
}

/** A Reviewer's accepted hand-back as the task line's "review" event (null: it carries no judgment, a defect told to the PM). */
async function takeReview(ctx: FlowCtx, t: DetailedTask, k: number, rev: string, view: Extract<Awaited<ReturnType<typeof taskView>>, { kind: 'done' }>): Promise<ReviewBody | null> {
  const r = view.result as ReviewerResult;
  const judgment = view.status.handBack?.records.find((x) => x.kind === 'judgment' && x.judgment === `j.${rev}`);
  if (judgment?.kind !== 'judgment') {
    await internalError(ctx, rev, `the accepted Reviewer hand-back of ${rev} has no judgment j.${rev}`);
    return null;
  }
  const issues = [
    ...r.judgments.filter((j) => j.met !== 'yes').map((j) => `[${j.standard}] ${j.met === 'no' ? 'not met' : 'unclear'}: ${j.reason}`),
    ...r.findings.map((f) => `finding: ${f}`),
    ...r.issue_responses.filter((i) => i.response === 'not-fixed').map((i) => `issue ${i.issue} not fixed: ${i.reason}`),
  ];
  const deferred = r.issue_responses.filter((i) => i.response === 'deferred').map((i) => `issue ${i.issue} deferred to ${i.owner}: ${i.reason}`);
  const reopen = (r.reopen ?? []).map((x) => ({ task: x.task, issue: x.issue, ...(x.evidence !== undefined ? { evidence: x.evidence } : {}) }));
  const review: ReviewBody = { task: rev, k, verdict: r.verdict, judgment: `j.${rev}`, issues, ...(deferred.length > 0 ? { deferred } : {}), ...(reopen.length > 0 ? { reopen } : {}) };
  for (const answer of r.issue_responses.filter((i) => i.response === 'deferred')) {
    await notify(ctx, {
      category: 'reviewer-issue-deferred',
      wi: null,
      key: `${rev}:${answer.issue}`,
      trigger: `task ${t.id}, version ${judgment.target}: issue ${answer.issue} deferred to ${answer.owner}: ${answer.reason}`,
      defaultAction: 'the issue stays unfixed and is listed at close; a re-plan or the user routes the work',
      detail: { task: t.id, version: judgment.target, judgment: review.judgment, issue: answer.issue, owner: answer.owner, reason: answer.reason },
    });
  }
  await commit(ctx, `flow:review:${ctx.mission}:${rev}`, { events: [ev(ctx, taskLine(t.id), 'review', rev, review)] });
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
}

/** What one pass re-bound, for the PM's notices. */
interface KeptReport {
  readonly review: Array<{ readonly task: string; readonly from: string; readonly product: string; readonly why: readonly string[] }>;
  /** The re-bound versions' successors, read once per pass (dropped when this pass accepts a re-bound version). */
  successors: Map<string, string> | null;
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
  // the plan it was recorded under still holds and no prerequisite moved: its proof is missing for another reason
  if (!prereqMoved && others.every((x) => labels[x] === 'proven')) return 'none';
  // nothing is re-bound onto a plan that is not proven (it waits, and nothing re-reviews the version that cannot be proven)
  if (labels[eff.dplan] !== 'proven') return 'held';
  // the prerequisites: each must be its dependency's accepted version now, re-bound or proven itself first
  const deps = new Set<string>();
  for (const d of t.dependsOn) {
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
  const stale = have.filter((x) => !want.includes(x)).sort();
  const missing = want.filter((x) => !have.includes(x)).sort();
  if (stale.length > 0 || missing.length > 0) {
    await notify(ctx, {
      category: 'kept-product-not-rebound',
      wi: null,
      key: `${t.id}:${cur.product}:${eff.dplan}:prerequisites:${shortHash({ stale, missing })}`,
      trigger: `the plan in effect (${eff.dplan}) keeps task ${t.id}'s card, but its accepted product ${cur.product} has stale prerequisites [${stale.join(', ')}] and missing prerequisites [${missing.join(', ')}] compared with its dependencies' accepted closure: it cannot be re-bound to the plan`,
      defaultAction: `task ${t.id} stays accepted with a product that is not fully proven (stable mode holds the work that depends on it); a re-plan that changes its card rebuilds it on its dependencies' current work`,
      detail: { task: t.id, product: cur.product, dplan: eff.dplan, stale, missing },
    });
    return 'none';
  }
  // fast mode: told once, then the re-review paths run (an environment re-review is still answered)
  if (eff.mode !== 'stable') {
    await notify(ctx, {
      category: 'kept-product-not-rebound',
      wi: null,
      key: `${t.id}:${cur.product}:${eff.dplan}:fast`,
      trigger: `the plan in effect (${eff.dplan}) keeps task ${t.id}'s card, but its accepted product ${cur.product} lost its proof with the plan it was recorded under`,
      defaultAction: 'fast mode: the task stays accepted and the work that depends on it goes on; the product is "not fully proven" until a Reviewer judges it under the plan in effect (stable mode, or a re-plan that changes its card)',
      detail: { task: t.id, product: cur.product, dplan: eff.dplan },
    });
    return 'none';
  }
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
  switch (review.verdict) {
    case 'pass':
      await commit(ctx, `flow:rebound:${ctx.mission}:task:${idPart(t.id)}:${rb.key}`, { events: [ev(ctx, taskLine(t.id), 'rebound', rb.key, { k, n: b.n, product: b.product, judgment: review.judgment, how: 'review' } satisfies ReboundBody)] });
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
        summary: `The Reviewer of task ${t.id} (attempt ${k}, its product re-bound to ${b.dplan}) needs a decision: the standards are unclear or in conflict.`,
        reasons: [...review.issues],
        options: ['answer', 'rework', 'replan', 'ask-user'],
        items: t.requirementItems,
        facts: { task: t.id, attempt: k, product: b.product, issues: review.issues, rebind: b.n },
        handover: { from: rev, objects: [b.product] },
      });
      break;
  }
  return 'held';
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

/** A Reviewer rework: counted (initial + 2); exhausted → WI-08 and the Secretary. */
async function rework(ctx: FlowCtx, t: DetailedTask, k: number, issues: readonly string[], instructions: readonly string[], key: string, o: { readonly reason?: ReworkBody['reason']; readonly reopen?: ReopenSource } = {}): Promise<void> {
  const lineName = taskLine(t.id);
  const lineage = taskLineage(ctx.mission, t.id);
  const r = await countedReturn(ctx, { line: lineName, key, lineage, loop: 'rework', signature: shortHash([...issues].sort()) });
  if (r.proceed) {
    const line = await readLine(ctx, t.id);
    const deferred = await deferredInstructions(ctx, line, k);
    await commit(ctx, `flow:rework:${ctx.mission}:task:${idPart(t.id)}:${k + 1}`, { events: [ev(ctx, lineName, 'rework', String(k + 1), { k: k + 1, reason: o.reason ?? (instructions.length > 0 ? 'secretary' : 'reviewer'), issues: [...issues], instructions: [...instructions, ...deferred], ...(o.reopen !== undefined ? { reopen: o.reopen } : {}) } satisfies ReworkBody)] });
    return;
  }
  const v = r.status;
  const id = safeId(`exh.${lineage}.${k}`);
  await raiseEscalation(ctx, {
    id,
    source: 'loop-exhausted',
    lineage,
    subject: `task:${t.id}`,
    summary: `Task ${t.id}: the reworks are used up (${v.attempts}/${v.allowed}${v.reason === 'no-progress' ? ', the same issues twice in a row' : ''}).`,
    reasons: [...issues],
    options: ['grant', 'replan', 'abandon', 'ask-user'],
    items: t.requirementItems,
    facts: { task: t.id, attempt: k, loop: 'rework', issues, attempts: v.attempts, allowed: v.allowed, reason: v.reason },
    // the Reviewer whose rework used the loop up (or the Constructor whose candidate could not be recorded)
    handover: await reworkHandover(ctx, t, k),
  });
  await notify(ctx, {
    category: 'loop-exhausted',
    wi: WI.loopExhausted,
    key: id,
    trigger: `rework on lineage ${lineage}: ${v.reason === 'no-progress' ? 'the same issues twice in a row (no progress)' : `${v.attempts} of ${v.allowed} reworks used`}`,
    defaultAction: `only task ${t.id} stops at "exhausted"; the Secretary decides (one grant, re-plan, abandon, or the user); the rest of the mission continues`,
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
async function applyTaskDecision(ctx: FlowCtx, eff: EffectiveBody, t: DetailedTask, line: Line, e: EscalationBody): Promise<boolean> {
  const lineName = taskLine(t.id);
  const lineage = taskLineage(ctx.mission, t.id);
  const facts = (e.facts ?? {}) as { attempt?: number; loop?: string; issues?: string[] };
  // seat failures are carried out where the failed task is seen (failures.ts)
  if (e.source === 'needs-disposition' || (e.source === 'loop-exhausted' && facts.loop !== undefined && facts.loop !== 'rework')) return false;
  const blocking = e.source !== 'constructor-decision';
  const d = await decisionFor(ctx, e.id);
  if (d === null) return blocking;
  const k = facts.attempt ?? line.k;
  switch (d.option) {
    case 'grant': {
      const g = await ctx.ports.scheduler.grant({ op: `grant:${ctx.mission}:${e.id}:${d.by}`, lineage, loop: 'rework', by: d.by === 'user' ? 'user' : 'secretary', extra: Math.max(1, d.grantExtra), reason: d.reason });
      if (!g.granted) {
        await escalateToUser(ctx, e.id, `the Secretary's grant on lineage ${lineage} was refused (${g.why ?? 'refused'}): only the user can grant more`, WI.loopExhausted);
        return true;
      }
      await ctx.ports.ledger.loopAttempt({ op: `flow:rework:${ctx.mission}:${e.id}:granted`, lineage, loop: 'rework', signature: `granted:${e.id}` });
      await commitCarrying(ctx, `flow:rework:${ctx.mission}:task:${idPart(t.id)}:${k + 1}`, [ev(ctx, lineName, 'rework', String(k + 1), { k: k + 1, reason: 'secretary', issues: facts.issues ?? [], instructions: [...(d.instructions !== '' ? [d.instructions] : []), ...await deferredInstructions(ctx, line, k)] } satisfies ReworkBody)], [await carryOut(ctx, e.id, { option: 'grant' })]);
      return false;
    }
    case 'answer':
      if (e.source === 'reviewer-needs-decision') {
        // the re-review's number and the applied mark are one append (code review r1 #13)
        const m = line.all('reanswer').filter((x) => x.key.startsWith(`${k}:`)).length;
        await commitCarrying(ctx, `flow:reanswer:${ctx.mission}:${e.id}`, [ev(ctx, lineName, 'reanswer', `${k}:${m + 1}`, { escalation: e.id, decision: d.instructions })], [await carryOut(ctx, e.id, { option: 'answer' })]);
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
      await requestReplan(ctx, eff, t, e.id, d);
      return true;
    case 'abandon':
      await abandon(ctx, t, line.k, e.id, d.reason);
      return true;
    default:
      await markApplied(ctx, e.id, { option: d.option });
      return false;
  }
}

/** A Secretary's (or the user's) "re-plan": the decision layer re-decomposes; this task waits for the new plan. */
async function requestReplan(ctx: FlowCtx, eff: EffectiveBody, t: DetailedTask, escalationId: string, d: DecisionBody): Promise<void> {
  await commitCarrying(
    ctx,
    `flow:replan-request:${ctx.mission}:${escalationId}`,
    [ev(ctx, PLAN_LINE, 'replan-request', escalationId, { escalation: escalationId, task: t.id, instructions: d.instructions }), ev(ctx, taskLine(t.id), 'waiting-replan', escalationId, { dplan: eff.dplan, escalation: escalationId })],
    [await carryOut(ctx, escalationId, { option: 'replan' })],
  );
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

function interfaceDefs(plan: DetailedPlanDoc, names: readonly string[]): Array<{ name: string; definition: string }> {
  return names.map((n) => {
    const nw = plan.newInterfaces.find((i) => i.name === n);
    if (nw !== undefined) return { name: n, definition: nw.definition };
    const re = plan.reusedInterfaces.find((i) => i.name === n);
    return { name: n, definition: re !== undefined ? `existing, at ${re.file}:${re.location}` : '(see the snapshot)' };
  });
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

async function submitConstructor(ctx: FlowCtx, eff: EffectiveBody, plan: DetailedPlanDoc, t: DetailedTask, line: Line, k: number, task: string, deps: readonly string[]): Promise<void> {
  const prev = await latestRecordedProduct(ctx, line, k);
  // A first attempt starts from the base with its dependencies' products. A later attempt (a rework,
  // or a respec after a re-plan) continues from the previous product's candidate while the snapshot
  // a first attempt would get now is the one that version's work started from (its origin). When
  // its dependencies changed since (a re-plan added one, or one was accepted again at a newer
  // version) it starts from that new snapshot with the previous version's whole change laid over it
  // (three-way, as a delivery lays it), so its worktree and its declared runs see the dependencies'
  // current work; the new snapshot is recorded as the attempt's origin, so its product's change is
  // the task's own work only. A carried change that conflicts with the new snapshot builds nothing:
  // the attempt waits with a notice (Appendix M).
  let snap: Awaited<ReturnType<typeof ctx.ports.scheduler.snapshot>>;
  const recorded = line.one<DispatchedBody>('dispatched', task);
  try {
    snap = recorded !== null ? { path: recorded.snapshot, commit: recorded.commit, products: recorded.prerequisites ?? [], ...(recorded.origin !== undefined ? { origin: recorded.origin } : {}) } : await ctx.ports.scheduler.snapshot(
      prev !== null
        ? { mission: ctx.mission, purpose: `constructor-${t.id}`, commit: prev.commit, carry: { version: prev.object, products: deps }, writable: t.writeScope }
        : { mission: ctx.mission, purpose: `constructor-${t.id}`, products: deps, writable: t.writeScope },
    );
    if (recorded === null && snap.products === undefined) snap = { ...snap, products: await ctx.ports.scheduler.composition(deps) };
  } catch (e) {
    if (prev !== null && (e as { code?: string }).code === 'conflict' && (e as { detail?: { carried?: unknown } }).detail?.carried === true) {
      return notify(ctx, {
        category: 'rework-start-conflict',
        wi: null,
        key: `${task}:carry`,
        trigger: `attempt ${k} of task ${t.id} cannot start: ${(e as Error).message}`,
        defaultAction: `only task ${t.id} waits (tried again on every pass, so its dependencies' work accepted again can clear it); nothing is built on part of the earlier work. A re-plan that changes its card starts its next attempt from its dependencies' current work without the earlier attempts' change (it stays readable at ${prev.commit})`,
        detail: { task: t.id, attempt: k, previous: prev.object, commit: prev.commit, dependencies: deps, conflicts: (e as { detail?: { conflicts?: unknown } }).detail?.conflicts ?? null },
      });
    }
    return actionRefused(ctx, task, e);
  }
  const items = await currentItems(ctx);
  const rw = line.one<ReworkBody>('rework', String(k));
  const duties = [
    `Implement task ${t.id} (${t.kind}${t.module !== null ? ` of module ${t.module}` : ''}) inside its writable paths, so that every acceptance standard is met.`,
    ...(rw !== null && rw.issues.length > 0 ? ['This is a rework. Fix exactly these issues from the review:', ...rw.issues.map((i) => `- ${i}`)] : []),
    ...(rw !== null && rw.instructions.length > 0 ? ['Instructions:', ...rw.instructions.map((i) => `- ${i}`)] : []),
  ].join('\n');
  // the Constructor's worktree is created at this commit when it is dispatched (§5.3); the write paths are the task's write scope
  const workspace = { snapshot: snap.commit, writablePaths: [...t.writeScope] };
  const repairs = await repairsOfWork(ctx, eff, t, line, k);
  const card: ConstructorCard = {
    ...cardBase(ctx, task, { module: t.module, duties, decisionQuotes: await decisionQuotes(ctx, t), constraints: await cardConstraints(ctx, t, new Set(['object', 'instruction'])) }),
    ...(repairs.length > 0 ? { repairs } : {}),
    seat: 'constructor',
    workspace,
    goal: t.goal,
    standards: t.standards.map((s) => ({ id: s.id, text: s.text })),
    requirementItems: taskRequirementItems(items, t),
    readableFiles: [...t.readableFiles],
    interpreter: t.interpreter,
    verificationCommands: t.verificationCommands.map((c) => ({ ...c })),
    interfaces: { implements: interfaceDefs(plan, t.implements), calls: interfaceDefs(plan, t.calls) },
    ...(t.exclusive.length > 0 ? { exclusive: [...t.exclusive] } : {}),
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
    // who hands it over (§3.2, U-13): the Architect that decomposed the plan, or the Reviewer that asked for the rework
    handover: handoverOfConstructor(ctx, eff, line, k, t),
  });
}

/** The lineage's latest recorded product under the current spec before attempt k, at the version its last Reviewer judged (a re-bound version included). */
async function latestRecordedProduct(ctx: FlowCtx, line: Line, k: number): Promise<ProductBody | null> {
  const spec = line.all('spec').at(-1)?.revision ?? 0;
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
  const rw = line.one<ReworkBody>('rework', String(k));
  const reopened = rw?.reason === 'reopen' ? ` This attempt was reopened (${rw.reopen?.kind === 'repair' ? `repair ${rw.reopen.repair}` : rw.reopen?.kind === 'review' ? `the review ${rw.reopen.review} of integration task ${rw.reopen.integration}` : 'reopened'}): ${rw.issues.join('; ')}. Judge whether it is fixed too; if it is not, say so as a finding.` : '';
  const repairs = await repairsOfWork(ctx, eff, t, line, k);
  const card: ReviewerCard = {
    ...cardBase(ctx, task, {
      module: t.module,
      duties: o.duties ?? `Judge the candidate of task ${t.id} (attempt ${k}${m > 0 ? `, review ${m + 1} after a decision` : ''}) against each standard, independently.${reopened}`,
      decisionQuotes: reviewerDecisionQuotes(ctx.mission, await currentItems(ctx), await ctx.ports.ledger.events({ mission: ctx.mission }), t, await currentConstraints(ctx), k, taskReferencePlan(await ctx.ports.ledger.events({ mission: ctx.mission }), obj?.reviews.find((r) => r.review === 'reviewer'))),
      constraints: [...cardConstraintsList, ...await cardConstraints(ctx, t, new Set(['instruction']))],
    }),
    seat: 'reviewer',
    workspace: { snapshot: product.snapshot, writablePaths: [] },
    target: product.object,
    review: 'reviewer',
    standards: t.standards.map((s) => ({ id: s.id, text: s.text })),
    interfaces: [...interfaceDefs(plan, t.implements), ...interfaceDefs(plan, t.calls)],
    candidate: { changedPaths: [...changedPaths] },
    verificationRuns: runs.map((r) => ({ evidence: r.evidence, command: r.command, summary: r.summary })),
    declaredCommands: t.verificationCommands.map((x) => ({ ...x })),
    selfReportedGaps: gaps,
    openIssues,
    ...(previousReview !== null ? { previousReview } : {}),
    ...(integration !== undefined ? { integration } : {}),
    ...(repairs.length > 0 ? { repairs } : {}),
    binding: {
      judgment: `j.${task}`,
      bases: c.putList(currentVersions(ix, reviewContractLines(ctx.mission, t, ix, obj?.reviews.find((r) => r.review === 'reviewer')))),
      constraints: c.putList([...new Set(checks)].sort()),
      // the objects the version's contract relies on (v51 §5.2: a judgment conforms to the contract fixed with
      // its target), which for a version recorded under an earlier plan is that plan, not the one in effect
      reliesOn: c.putList(reliedPlans(obj, eff)),
      revokes: null,
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

/** The previous Reviewer of the task (any attempt, before this review task): its verdict, each standard it did not find met, with the reason, and its findings. */
async function previousReviewOf(ctx: FlowCtx, line: Line, current: string): Promise<NonNullable<ReviewerCard['previousReview']> | null> {
  const prev = line.all<ReviewBody>('review').filter((r) => r.body.task !== current).at(-1);
  if (prev === undefined) return null;
  const result = ((await ctx.ports.scheduler.status(prev.body.task))?.handBack?.result ?? null) as ReviewerResult | null;
  const unmet = result !== null
    ? result.judgments.filter((j) => j.met !== 'yes').map((j) => ({ standard: j.standard, met: j.met as 'no' | 'unclear', reason: j.reason }))
    // a result not readable any more: the recorded issue lines stand in ("[S1] not met: why")
    : prev.body.issues.flatMap((i) => { const m = /^\[([^\]]+)\] (not met|unclear): (.*)$/s.exec(i); return m === null ? [] : [{ standard: m[1]!, met: (m[2] === 'not met' ? 'no' : 'unclear') as 'no' | 'unclear', reason: m[3]! }]; });
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

/** An integration task's dependencies (direct and through other tasks) with their accepted products and the paths those changed (D-6 tracing aid). */
async function dependencyProducts(ctx: FlowCtx, plan: DetailedPlanDoc, t: DetailedTask): Promise<NonNullable<ReviewerCard['integration']>['dependencies']> {
  const byId = new Map(plan.tasks.map((x) => [x.id, x]));
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (id: string): void => {
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      order.push(d);
      visit(d);
    }
  };
  visit(t.id);
  const out: Array<NonNullable<ReviewerCard['integration']>['dependencies'][number]> = [];
  for (const id of order) {
    const p = await acceptedProduct(ctx, id);
    if (p === null) continue;
    const line = await readLine(ctx, id);
    out.push({ task: id, product: p, attempt: line.k, direct: t.dependsOn.includes(id), changedPaths: changedPathsOf(line, p) });
  }
  return out;
}

/**
 * Which accepted products of the mission changed each path (`mp seat <id> owners`, the integration
 * review's and the repair's tracing aid): from the paths recorded with each product, through the
 * task lines' acceptances (current or earlier). A path ending in "/" or "/**" names a directory.
 */
export async function pathOwners(ctx: FlowCtx, paths: readonly string[]): Promise<Array<{ readonly path: string; readonly owners: ReadonlyArray<{ readonly task: string; readonly attempt: number; readonly product: string; readonly current: boolean; readonly paths: readonly string[] }> }>> {
  const tasks = new Set<string>();
  for (const e of await eventsOf<EffectiveBody>(ctx, PLAN_LINE, 'effective')) for (const t of e.body.tasks) tasks.add(t);
  const accepted: Array<{ task: string; attempt: number; product: string; current: boolean; changed: readonly string[] }> = [];
  for (const id of tasks) {
    const line = await readLine(ctx, id);
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
    const versions = new Map(line.all<{ k: number; product: string }>('accepted').map((a) => [a.body.product, a.body.k]));
    for (const r of line.all<ReboundBody>('rebound')) versions.set(r.body.product, r.body.k);
    const now = lineAcceptance(events);
    if (now.product === null) continue;
    for (const p of prerequisites) {
      const k = versions.get(p);
      if (k !== undefined && p !== now.product && now.k > k) out.push({ prerequisite: p, task, attempt: k, newer: now.product });
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
