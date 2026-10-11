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
// stops (queued attempts cancelled; work in flight finishes and is kept, proposed WI-23).
//
// Decisions belong to the card they were made under (the task's spec): a new spec (a re-plan that
// changes the card, or brings back a task a re-plan dropped) starts from the user's newer words, so
// a giving-up recorded under an earlier spec does not hold for it, and the task's escalations still
// open from an earlier spec are closed as superseded in the same append (their decisions, then or
// later, are not carried out on the new card). An acceptance is per attempt, and a new spec of a
// started task starts the next attempt, so nothing accepted under the old card counts for the new.

import { encodeConstraintCheck, type IssueRecord } from '../common/records.ts';
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
import type { ProductVersion, VerificationRun } from './ports.ts';
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
  readonly reason: 'reviewer' | 'secretary' | 'respec' | 'replan';
  readonly issues: readonly string[];
  readonly instructions: readonly string[];
}
interface DispatchedBody {
  readonly k: number;
  readonly snapshot: string;
  readonly commit: string;
  readonly dplan: string;
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

async function readLine(ctx: FlowCtx, task: string): Promise<Line> {
  return new Line(await eventsOf(ctx, taskLine(task)));
}

/** The accepted product of a plan task at its current attempt, or null. */
export async function acceptedProduct(ctx: FlowCtx, task: string): Promise<string | null> {
  const l = await readLine(ctx, task);
  if (l.abandoned) return null;
  return l.one<{ product: string }>('accepted', String(l.k))?.product ?? null;
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
    return;
  }
  for (const t of stored.plan.tasks) await taskStep(ctx, eff, stored.plan, t);
  await droppedStep(ctx, eff, stored.plan);
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
  const accepted = line.one<{ product: string; judgment: string }>('accepted', String(k));
  const product = line.one<ProductBody>('product', String(k));
  if (accepted === null || product === null) return;
  const lineName = taskLine(t.id);
  const lineage = taskLineage(ctx.mission, t.id);
  // 4.1 §6.2 (v51 §4.1, the maintainer's fast/stable modes): a basis of the accepted result got a new
  // version after it was judged (an ordinary revision, never a rejection). Stable mode re-accepts it
  // on the new basis (a request below); fast mode goes on, the product "not fully proven" (a notice)
  const judged = line.all<{ k: number; judgment: string }>('reaccepted').filter((r) => r.body.k === k).at(-1)?.body.judgment ?? accepted.judgment;
  const revised = await revisedBases(ctx, judged);
  if (revised.length > 0) {
    const key = `${k}:${shortHash(revised)}`;
    if (eff.mode === 'stable') {
      if (line.one('basis-revised', key) === null) {
        await commit(ctx, `flow:basis-revised:${ctx.mission}:task:${idPart(t.id)}:${key}`, { events: [ev(ctx, lineName, 'basis-revised', key, { k, judgment: judged, revised, reason: `a basis has a new version (${revised.map((r) => `${r.from} → ${r.to}`).join(', ')}): re-accept on it` })] });
        return;
      }
    } else {
      await notify(ctx, {
        category: 'result-not-fully-proven',
        wi: null,
        key: `${t.id}:${key}`,
        trigger: `a basis of task ${t.id}'s accepted product ${accepted.product} got a new version after it was judged (${revised.map((r) => `${r.from} → ${r.to}`).join(', ')})`,
        defaultAction: 'fast mode: the task stays accepted and the work that depends on it goes on; the product is "not fully proven" until it is judged on the new basis (a re-plan, or stable mode)',
        detail: { task: t.id, product: accepted.product, judgment: judged, revised },
      });
    }
  }
  const requests: Array<{ readonly key: string; readonly revision: number; readonly body: { readonly reason: string } }> = [
    ...(await eventsOf<ReviewNeededBody>(ctx, RENEW_LINE, REVIEW_NEEDED))
      .filter((e) => e.body.target === accepted.product && e.body.review === 'reviewer')
      .map((e) => ({ key: e.key, revision: e.revision, body: { reason: `the environment changed (${e.body.reason}), so the runs were recorded again under the current environment` } })),
    ...line.all<{ k: number; reason: string }>('basis-revised').filter((e) => e.body.k === k),
  ].sort((a, b) => a.revision - b.revision);
  if (requests.length === 0) return;
  const rounds = line.all<RereviewBody>('rereview').filter((r) => r.body.k === k);
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
  const n = rounds.length + 1;
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
  await commit(ctx, `flow:rereview:${ctx.mission}:task:${idPart(t.id)}:${k}:${n}`, { events: [ev(ctx, lineName, 'rereview', `${k}:${n}`, { k, n, request: request.key, rev, runs } satisfies RereviewBody)] });
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
    const res = view.result as ReviewerResult;
    const issues = [
      ...res.judgments.filter((j) => j.met !== 'yes').map((j) => `[${j.standard}] ${j.met === 'no' ? 'not met' : 'unclear'}: ${j.reason}`),
      ...res.findings.map((f) => `finding: ${f}`),
      ...res.issue_responses.filter((i) => i.response === 'not-fixed').map((i) => `issue ${i.issue} not fixed: ${i.reason}`),
    ];
    review = { task: r.rev, k: r.k, verdict: res.verdict, judgment: `j.${r.rev}`, issues };
    await commit(ctx, `flow:review:${ctx.mission}:${r.rev}`, { events: [ev(ctx, lineName, 'review', r.rev, review)] });
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

async function taskStep(ctx: FlowCtx, eff: EffectiveBody, plan: DetailedPlanDoc, t: DetailedTask): Promise<void> {
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
  if (line.one('accepted', String(k)) !== null) return rereviewStep(ctx, eff, plan, t, line, k);

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
    const prev = line.one<ProductBody>('product', String(k - 1));
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
      prerequisites: deps,
      reviews: [{ review: 'reviewer', basisLines: contractLines(ctx, t, ix) as never, reliesOn: [eff.dplan] as never }],
      predecessor: prev?.object ?? null,
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
    const r = view.result as ReviewerResult;
    if (!view.status.handBack?.records.some((x) => x.kind === 'judgment' && x.judgment === `j.${rev}`)) return internalError(ctx, rev, `the accepted Reviewer hand-back of ${rev} has no judgment j.${rev}`);
    const issues = [
      ...r.judgments.filter((j) => j.met !== 'yes').map((j) => `[${j.standard}] ${j.met === 'no' ? 'not met' : 'unclear'}: ${j.reason}`),
      ...r.findings.map((f) => `finding: ${f}`),
      ...r.issue_responses.filter((i) => i.response === 'not-fixed').map((i) => `issue ${i.issue} not fixed: ${i.reason}`),
    ];
    review = { task: rev, k, verdict: r.verdict, judgment: `j.${rev}`, issues };
    await commit(ctx, `flow:review:${ctx.mission}:${rev}`, { events: [ev(ctx, lineName, 'review', rev, review)] });
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
    await commit(ctx, `flow:rework:${ctx.mission}:task:${idPart(t.id)}:${k + 1}`, { events: [ev(ctx, lineName, 'rework', String(k + 1), { k: k + 1, reason: instructions.length > 0 ? 'secretary' : 'reviewer', issues: [...issues], instructions: [...instructions] } satisfies ReworkBody)] });
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
  const product = line.one<ProductBody>('product', String(k));
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
      await commitCarrying(ctx, `flow:rework:${ctx.mission}:task:${idPart(t.id)}:${k + 1}`, [ev(ctx, lineName, 'rework', String(k + 1), { k: k + 1, reason: 'secretary', issues: facts.issues ?? [], instructions: d.instructions !== '' ? [d.instructions] : [] } satisfies ReworkBody)], [await carryOut(ctx, e.id, { option: 'grant' })]);
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

/** Cancel the queued (not running) tasks of an attempt. */
async function cancelAttempt(ctx: FlowCtx, t: DetailedTask, k: number, why: string): Promise<string[]> {
  const running: string[] = [];
  for (const task of [conTask(ctx.mission, t.id, k), ...[0, 1, 2, 3, 4].map((m) => revTask(ctx.mission, t.id, k, m))]) {
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
    if (line.one('accepted', String(line.k)) === null && !line.abandoned) {
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
  const prev = line.one<ProductBody>('product', String(k - 1));
  // a rework starts from the previous product; a first attempt from the base with its dependencies' products
  let snap: Awaited<ReturnType<typeof ctx.ports.scheduler.snapshot>>;
  try {
    snap = await ctx.ports.scheduler.snapshot(
      prev !== null ? { mission: ctx.mission, purpose: `constructor-${t.id}`, commit: prev.commit, writable: t.writeScope } : { mission: ctx.mission, purpose: `constructor-${t.id}`, products: deps, writable: t.writeScope },
    );
  } catch (e) {
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
  await commit(ctx, `flow:dispatched:${ctx.mission}:${task}`, { events: [ev(ctx, taskLine(t.id), 'dispatched', task, { k, snapshot: snap.path, commit: snap.commit, dplan: eff.dplan } satisfies DispatchedBody)] });
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
  o: { readonly duties?: string; readonly afterClose?: 'audit' } = {},
): Promise<void> {
  const ix = await basisIndex(ctx);
  const c = ctx.ports.ledger.content;
  const obj = await objectRecord(ctx, product.object);
  const scope = obj?.scope ?? { paths: [...product.changedPaths], taskType: t.kind };
  const objectConstraints = (await currentConstraints(ctx)).filter((x) => x.kind === 'object');
  const checks: string[] = [];
  const cardConstraintsList: Array<{ id: string; text: string; kind: 'object' | 'instruction' }> = [];
  for (const x of objectConstraints) {
    const range = requiredRange(x.scope, scope);
    if (range.length === 0) continue;
    checks.push(encodeConstraintCheck({ version: x.version, paths: range }));
    cardConstraintsList.push({ id: x.line, text: `${x.text} (applies to: ${range.join(', ')})`, kind: 'object' });
  }
  // the Constructor's gaps (8.1: answer every one)
  const conView = await ctx.ports.scheduler.status(product.task);
  const cr = (conView?.handBack?.result ?? null) as ConstructorResult | null;
  const gaps = [
    ...(cr?.unmet_standards ?? []).map((u, i) => ({ id: `unmet-${i + 1}`, text: `standard ${u.standard} not met: ${u.why}` })),
    ...(cr?.unfixed_problems ?? []).map((p, i) => ({ id: `problem-${i + 1}`, text: p })),
  ];
  // open issues observed on this task's earlier versions (5.6: the Reviewer answers each on this version)
  const earlier = new Set(line.all<ProductBody>('product').filter((p) => p.body.k < k).map((p) => p.body.object));
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
      openIssues.push({ issue: r.issue, text });
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
    candidate: { changedPaths: [...product.changedPaths] },
    verificationRuns: runs.map((r) => ({ evidence: r.evidence, command: r.command, summary: r.summary })),
    declaredCommands: t.verificationCommands.map((x) => ({ ...x })),
    selfReportedGaps: gaps,
    openIssues,
    binding: {
      judgment: `j.${task}`,
      bases: c.putList(currentVersions(ix, contractLines(ctx, t, ix))),
      constraints: c.putList([...new Set(checks)].sort()),
      reliesOn: c.putList([eff.dplan]),
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
    // who hands it over (§3.2, U-13): the Constructor whose candidate it judges (a re-review: the renewal)
    handover: o.afterClose !== undefined ? { from: null, objects: [product.object], step: `a re-review of ${product.object} after an environment change (mp pm renew)` } : { from: product.task, objects: [product.object], step: `the candidate of task ${t.id}, attempt ${k}` },
  });
  ctx.progressed = true;
}
