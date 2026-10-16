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

import { encodeConstraintCheck, type IssueRecord, type IssueResponse, type ObjectScope, type ObjectVersionRecord, type ReviewContract } from '../common/records.ts';
import { requiredRange } from '../evaluator/semantics.ts';
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
import { scopesOverlap } from './mechanical.ts';
import { DetailedTask, PLAN_LINE, RENEW_LINE, REVIEW_NEEDED, SECRETARY_LINE, taskIdProblems, taskLine, type DetailedPlanDoc, type ReviewNeededBody } from './plandoc.ts';
import { detailedPlanOf, internalError, latestEffective, standardLine, type EffectiveBody } from './planning.ts';
import type { FlowSchedulerPort, ProductVersion, VerificationRun } from './ports.ts';
import { currentConstraints, currentItems } from './requirements.ts';
import { carryOut, closing, commitCarrying, decisionFor, escalateToUser, markApplied, openEscalations, raiseEscalation, type DecisionBody, type EscalationBody } from './secretary.ts';
import { WI } from './wi.ts';

interface SpecBody {
  readonly dplan: string;
  readonly hash: string;
}
interface ReworkBody {
  /** The new attempt number. */
  readonly k: number;
  readonly reason: 'reviewer' | 'secretary' | 'respec' | 'replan' | 'program';
  readonly issues: readonly string[];
  readonly instructions: readonly string[];
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
}

// the task id encoded injectively (review r2): safeId alone turned "a_b" and "a-b" into one id
export const taskLineage = (mission: string, task: string): string => safeId(`task.${mission}.${idPart(task)}`);
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

/** The accepted product of a plan task at its current attempt (its latest re-bound version, Appendix J), or null. */
export async function acceptedProduct(ctx: FlowCtx, task: string, revision = Infinity): Promise<string | null> {
  const l = await readLine(ctx, task, revision);
  if (l.abandoned) return null;
  const accepted = currentAcceptance(l, l.k);
  if (accepted === null) return null;
  const start = await acceptedStart(ctx, l, l.k, accepted.product);
  if (start !== undefined && (start === null || !start.holds)) return null;
  return accepted.product;
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
  const stored = await detailedPlanOf(ctx, start.body.dplan);
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
  const stored = await detailedPlanOf(ctx, eff.dplan);
  if (stored === null) return internalError(ctx, `exec:${eff.dplan}`, `the effective detailed plan ${eff.dplan} is not in the ledger`);
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
    const verdict = await rereviewResult(ctx, t, line, last.body, product, lineage);
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
async function rereviewResult(ctx: FlowCtx, t: DetailedTask, line: Line, r: RereviewBody, product: ProductBody, lineage: string): Promise<ReviewBody['verdict'] | 'pending'> {
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
        // the new evidence does not hold: the Constructor redoes the task (the next attempt)
        await rework(ctx, t, r.k, review.issues, [], `rework:${r.k}:re${r.n}`);
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
  const hash = shortHash(DetailedTask.parse(t));
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
    if (w.body.dplan === eff.dplan) return;
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

  // gate: dependencies accepted; stable mode: proven
  const deps: string[] = [];
  for (const d of t.dependsOn) {
    const p = await acceptedProduct(ctx, d);
    if (p === null) return;
    deps.push(p);
  }
  if (eff.mode === 'stable') {
    const labels = await ctx.ports.evaluator.labels([eff.dplan, ...deps]);
    if ([eff.dplan, ...deps].some((x) => labels.labels[x] !== 'proven')) return;
  }

  // the Constructor
  const con = conTask(ctx.mission, t.id, k);
  let product = line.one<ProductBody>('product', String(k));
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
    runs = [...v];
    await commit(ctx, `flow:verified:${ctx.mission}:${product.object}`, { events: [ev(ctx, lineName, 'verified', String(k), { runs })] });
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
      return rework(ctx, t, k, review.issues, [], `rework:${k}`);
    case 'needs-decision':
      await raiseEscalation(ctx, {
        id: `rnd.${rev}`,
        source: 'reviewer-needs-decision',
        lineage,
        subject: `task:${t.id}`,
        summary: `The Reviewer of task ${t.id} (attempt ${k}) needs a decision: the standards are unclear or in conflict.`,
        reasons: [...review.issues],
        options: ['answer', 'rework', 'replan', 'ask-user'],
        items: t.requirementItems,
        facts: { task: t.id, attempt: k, product: product.object, issues: review.issues },
        handover: { from: rev, objects: [product.object] },
      });
      return;
  }
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
  const review: ReviewBody = { task: rev, k, verdict: r.verdict, judgment: `j.${rev}`, issues, ...(deferred.length > 0 ? { deferred } : {}) };
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
  /** New re-binds always require a seat judgment (maintainer ruling 1, 2026-10-13). */
  readonly how: 'review';
  readonly carries: null;
  /** Why the new version needs review. */
  readonly why: readonly string[];
}

/** The re-bound version accepted (event "rebound", the rebind's key): its Reviewer's pass. */
interface ReboundBody {
  readonly k: number;
  readonly n: number;
  readonly product: string;
  readonly judgment: string;
  readonly how: 'review';
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

function currentAcceptance(line: Line, k: number): Acceptance | null {
  const acc = line.one<{ product: string; judgment: string }>('accepted', String(k));
  if (acc === null) return null;
  const rb = line.all<ReboundBody>('rebound').filter((r) => r.body.k === k).at(-1);
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
    if (r !== undefined) out.set(r.from, r.product);
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
  const open = rebinds.at(-1);
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
  }
  const stale = mapped.filter((x) => !deps.has(x));
  if (stale.length > 0) {
    await notify(ctx, {
      category: 'kept-product-not-rebound',
      wi: null,
      key: `${t.id}:${cur.product}:${eff.dplan}:prerequisites`,
      trigger: `the plan in effect (${eff.dplan}) keeps task ${t.id}'s card, but its accepted product ${cur.product} was built on ${stale.join(', ')}, which its dependencies no longer have accepted (their work was redone): it cannot be re-bound to the plan`,
      defaultAction: `task ${t.id} stays accepted with a product that is not fully proven (stable mode holds the work that depends on it); a re-plan that changes its card rebuilds it on its dependencies' current work`,
      detail: { task: t.id, product: cur.product, dplan: eff.dplan, stale },
    });
    return 'none';
  }
  for (const x of mapped) {
    if (labels[x] === 'proven') continue;
    const reliedX: readonly string[] = (await objectRecord(ctx, x))?.reviews.find((r) => r.review === 'reviewer')?.reliesOn ?? [];
    if (!reliedX.includes(eff.dplan)) return 'held';
  }
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
  // a re-review of this version that a Reviewer is judging now ends first (its hand-back is preserved)
  const rounds = openRounds(line, k, cur);
  for (const r of rounds) if (['running', 'waiting-evidence'].includes((await ctx.ports.scheduler.status(r))?.state ?? '')) return 'held';
  const n = rebinds.length + 1;
  const key = `${k}:b${n}`;
  const object = safeId(`${cur.original}.b${n}`);
  const contract: ReviewContract = { review: 'reviewer', basisLines: contractLines(ctx, t, await basisIndex(ctx)) as never, reliesOn: [eff.dplan] as never };
  try {
    await ctx.ports.scheduler.rebind({ mission: ctx.mission, of: cur.product, object, prerequisites: mapped, reviews: [contract] });
  } catch (e) {
    await actionRefused(ctx, `${cur.product}:rebind`, e);
    return 'held';
  }
  const why = ['the new version has a Reviewer contract under the plan in effect (maintainer ruling 1, 2026-10-13)'];
  const body: RebindBody = { k, n, from: cur.product, product: object, dplan: eff.dplan, prerequisites: mapped, how: 'review', carries: null, why };
  await commit(ctx, `flow:rebind:${ctx.mission}:task:${idPart(t.id)}:${key}`, { events: [ev(ctx, taskLine(t.id), 'rebind', key, body)] });
  for (const r of rounds) await ctx.ports.scheduler.cancel(r);
  kept.review.push({ task: t.id, from: cur.product, product: object, why });
  return 'held';
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
      await rework(ctx, t, k, review.issues, [], `rework:${k}:${rev}`);
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
  const std = t.standards.map((s) => standardLine(ctx.mission, t.id, s.id));
  const items = t.requirementItems.filter((l) => ix.current.has(l) && !ix.withdrawn.has(l));
  return [...std, ...items];
}

/** A Reviewer rework: counted (initial + 2); exhausted → WI-08 and the Secretary. */
async function rework(ctx: FlowCtx, t: DetailedTask, k: number, issues: readonly string[], instructions: readonly string[], key: string): Promise<void> {
  const lineName = taskLine(t.id);
  const lineage = taskLineage(ctx.mission, t.id);
  const r = await countedReturn(ctx, { line: lineName, key, lineage, loop: 'rework', signature: shortHash([...issues].sort()) });
  if (r.proceed) {
    const line = await readLine(ctx, t.id);
    const deferred = await deferredInstructions(ctx, line, k);
    await commit(ctx, `flow:rework:${ctx.mission}:task:${idPart(t.id)}:${k + 1}`, { events: [ev(ctx, lineName, 'rework', String(k + 1), { k: k + 1, reason: instructions.length > 0 ? 'secretary' : 'reviewer', issues: [...issues], instructions: [...instructions, ...deferred] } satisfies ReworkBody)] });
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
    const rebinds = line.all<RebindBody>('rebind').filter((r) => r.body.k === line.k);
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
      const stored = await detailedPlanOf(ctx, last.body.dplan);
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
  const items = await currentItems(ctx);
  const out = items.filter((i) => i.type === 'decision' && (t.requirementItems.includes(i.line) || i.source.kind === 'authorization')).map((i) => i.text);
  const specRev = (await readLine(ctx, t.id)).all('spec').at(-1)?.revision ?? 0;
  for (const e of await eventsOf<EscalationBody>(ctx, SECRETARY_LINE, 'escalation')) {
    if (e.body.subject !== `task:${t.id}` || e.revision <= specRev) continue;
    const applied = await eventOf<{ readonly what?: { readonly option?: unknown } }>(ctx, SECRETARY_LINE, 'applied', e.body.id);
    if (applied === null || applied.body.what?.option !== 'answer') continue;
    const d = await decisionFor(ctx, e.body.id);
    if (d !== null && d.option === 'answer' && d.instructions !== '') out.push(d.instructions);
  }
  return out;
}

async function cardConstraints(ctx: FlowCtx, t: DetailedTask, kinds: ReadonlySet<'object' | 'instruction'>): Promise<Array<{ id: string; text: string; kind: 'object' | 'instruction' }>> {
  return (await currentConstraints(ctx))
    .filter((c) => kinds.has(c.kind) && (c.scope.taskTypes.length === 0 || c.scope.taskTypes.includes(t.kind)) && scopesOverlap(c.scope.paths, t.writeScope).length > 0)
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
  const card: ConstructorCard = {
    ...cardBase(ctx, task, { module: t.module, duties, decisionQuotes: await decisionQuotes(ctx, t), constraints: await cardConstraints(ctx, t, new Set(['object', 'instruction'])) }),
    seat: 'constructor',
    workspace,
    goal: t.goal,
    standards: t.standards.map((s) => ({ id: s.id, text: s.text })),
    requirementItems: t.requirementItems.map((l) => ({ id: l, text: items.find((i) => i.line === l)?.text ?? '(this item is not in force)' })),
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

/** Latest real work under this spec, even when intervening attempts produced no product. */
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
  const { checks, list: cardConstraintsList } = await objectConstraints(ctx, scope);
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
  const answers = line.all<{ decision: string }>('reanswer').filter((x) => x.key.startsWith(`${k}:`)).map((x) => x.body.decision);
  const card: ReviewerCard = {
    ...cardBase(ctx, task, {
      module: t.module,
      duties: o.duties ?? `Judge the candidate of task ${t.id} (attempt ${k}${m > 0 ? `, review ${m + 1} after a decision` : ''}) against each standard, independently.`,
      decisionQuotes: [...(await decisionQuotes(ctx, t)), ...answers],
      constraints: cardConstraintsList,
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
    binding: {
      judgment: `j.${task}`,
      bases: c.putList(currentVersions(ix, contractLines(ctx, t, ix))),
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
          : { from: product.task, objects: [product.object], step: `the candidate of task ${t.id}, attempt ${k}` },
  });
  ctx.progressed = true;
}

/** The objects a product version's Reviewer contract relies on (the plan in effect for a version without a contract). */
function reliedPlans(obj: ObjectVersionRecord | null, eff: EffectiveBody): string[] {
  const relied = obj?.reviews.find((r) => r.review === 'reviewer')?.reliesOn ?? [];
  return relied.length > 0 ? [...relied] : [eff.dplan];
}

/** The object constraints that apply to a version's scope now (v51 §5.2, 9.5): the checks a judgment binds, and the card's list. */
async function objectConstraints(ctx: FlowCtx, scope: ObjectScope): Promise<{ readonly checks: string[]; readonly list: Array<{ id: string; text: string; kind: 'object' | 'instruction' }> }> {
  const checks: string[] = [];
  const list: Array<{ id: string; text: string; kind: 'object' | 'instruction' }> = [];
  for (const x of (await currentConstraints(ctx)).filter((y) => y.kind === 'object')) {
    const range = requiredRange(x.scope, scope);
    if (range.length === 0) continue;
    checks.push(encodeConstraintCheck({ version: x.version, paths: range }));
    list.push({ id: x.line, text: `${x.text} (applies to: ${range.join(', ')})`, kind: 'object' });
  }
  return { checks: [...new Set(checks)].sort(), list };
}
