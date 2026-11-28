// 4.4 (G1, PM design §4; rulings F-3, E-2): a design question is answered by an Architect, in one step.
//
// A decider chooses `ask-architect` on one of three kinds of escalation: a Constructor's questions, a
// Reviewer's "needs a decision", a used-up rework loop (the Secretary, or the PM on the user's words;
// `answer`, `replan` and `ask-pm` stay as they are). This flow step queues one Architect step for the ask
// (card "architect-answer", read-only like the repair card) and records the step's reply on the escalation:
//
//   answer            recorded as the escalation's answer. On a Constructor's questions or a Reviewer's
//                     "needs a decision", decisionFor reads the ask and this reply as an answer, and the
//                     owning flow carries it out as any answer (flow/secretary.ts architectAnswered): the
//                     review's wait, a paused attempt's resume and the re-review behave as for any answer.
//                     A used-up loop has no answer that continues it: the reply goes back, as below, and the
//                     cards of the attempt a grant starts carry it (seat/cards/dynamic.ts carriedAnswer).
//   plan-must-change, need-to-know, and a step that ended without a reply
//                     the escalation returns to the Secretary, in the write that records the reply: a fresh
//                     Secretary round with the reply among its reasons, also when the PM asked (review p11-2:
//                     the PM is not drawn into what the Secretary can settle; the PM's round is closed and does
//                     not shut the Secretary out of that round). The Secretary settles it, asks again, or
//                     sends it to the PM with its brief.
//
// The step changes no card, standard or structure (its hand-back has no field for one), so no plan review
// follows (E-2). It counts on no loop of the task: its re-dispatches count on its own lineage. The task waits
// for it as for any decision (applyTaskDecision; a review waits on process/questions.ts).
//
// Another writer in between: the ask stops being current when the escalation is answered by the PM or the
// user, carried out, closed as superseded (a new card, a giving-up), or its round closed. A queued step is then
// cancelled; a claim of it is refused (seat/cards/refresh.ts); a reply that arrives anyway is recorded with
// `moot` and changes nothing. A reply is also moot when the asking authority or the asking task's card is out of
// date (review p11-4: the PM's cited words superseded, a new card in the plan in effect before its escalation
// is closed). The write that records a current reply checks all of it inside the write; otherwise nothing is
// written and the next pass reads it again.

import type { MissionId } from '../common/ids.ts';
import type { AppendGuard, FlowEvent, FlowEventInput } from './ports.ts';
import { attach, constructorClaims, previousReviewReport, type Attached } from './handbackMaterials.ts';
import { cardBase, commit, ev, eventOf, eventsOf, idPart, missionClosed, objectRecord, safeId, taskView, type FlowCtx, type TaskView } from './context.ts';
import { PLAN_LINE, SECRETARY_LINE, taskCardHash, taskLine } from './plandoc.ts';
import { planInEffect } from './planning.ts';
import { acceptedProduct } from './execution.ts';
import { acceptedEntry } from './repair.ts';
import { currentConstraints, currentItems } from './requirements.ts';
import { decisionFor, escalation, escalationTask, isApplied, type DecisionBody, type EscalationBody } from './secretary.ts';
import { addressedForPlanning, addressedIndexOf, constraintsForTask, planningConstraints, secretaryRoundInputs, taskDecisionQuotes, taskRequirementItems } from '../seat/cards/dynamic.ts';
import { answerPlanMaterial, type ArchitectAnswerCard, type ArchitectAnswerResult } from '../seat/cards/architectAnswer.ts';
import { ARCHITECT_ANSWER, answerKey, answersInPlace, askOf, askStanding, askTag, earlierReplies, handUpKey, pmRoundOf, replyText, type ArchitectAnswerBody, type Ask } from './architectAnswers.ts';

/** The Architect step of an ask (its own lineage too: it counts on no loop or re-dispatch allowance of the task). */
export const askTask = (mission: string, a: Ask): string => safeId(`arch-ask.${mission}.${idPart(a.escalation)}.${askTag(a)}`);

type Ev = FlowEvent;

/** The secretary line's events an ask's standing is read from (askStanding), and the replies; one read each. */
async function standingEvents(ctx: FlowCtx): Promise<Ev[]> {
  const out: Ev[] = [];
  for (const event of ['applied', 'user-answer', 'to-user', 'pm-answer', 'pm-answer-rejected', 'secretary-retry', ARCHITECT_ANSWER]) out.push(...(await eventsOf(ctx, SECRETARY_LINE, event)));
  return out.sort((a, b) => a.revision - b.revision);
}

/** The flow step: every ask of the Architect is queued, cancelled when moot, and its reply recorded. */
export async function architectAskStep(ctx: FlowCtx): Promise<void> {
  const asks = [...(await eventsOf(ctx, SECRETARY_LINE, 'decision')), ...(await eventsOf(ctx, SECRETARY_LINE, 'pm-answer'))].map(askOf).filter((a): a is Ask => a !== null);
  if (asks.length === 0) return;
  const replied = new Set((await eventsOf(ctx, SECRETARY_LINE, ARCHITECT_ANSWER)).map((e) => e.key));
  const open = asks.filter((a) => !replied.has(answerKey(a)));
  if (open.length === 0) return;
  // decisionFor first: it closes a round whose words or authority changed, with its own records, which the standing reads
  for (const id of new Set(open.map((a) => a.escalation))) if (!(await isApplied(ctx, id))) await decisionFor(ctx, id);
  const sec = await standingEvents(ctx);
  for (const a of open) await oneAsk(ctx, a, askStanding(sec, a), sec);
}

async function oneAsk(ctx: FlowCtx, a: Ask, standing: string | null, sec: readonly Ev[]): Promise<void> {
  const task = askTask(ctx.mission, a);
  const view = await taskView(ctx, task);
  switch (view.kind) {
    case 'absent':
      if (standing === null && !(await missionClosed(ctx))) await submitAsk(ctx, a, task, sec);
      return;
    case 'pending':
    case 'evidence':
      // moot before it ran: a queued step is cancelled (one in flight hands back, and its reply is kept as moot)
      if (standing !== null && (await ctx.ports.scheduler.status(task))?.state === 'queued' && (await ctx.ports.scheduler.cancel(task))) ctx.progressed = true;
      return;
    case 'failed':
      // a step that ended without a usable reply while its ask is current: the Secretary gets the question back (P-4: a safe default)
      if (standing === null) await recordReply(ctx, a, task, { reply: 'failed', text: `${view.why}${view.status.note !== null ? `: ${view.status.note}` : ''}`, dispatch: null }, null, sec);
      return;
    case 'done':
      await recordReply(ctx, a, task, replyOf(view), standing, sec);
  }
}

function replyOf(view: Extract<TaskView, { kind: 'done' }>): Pick<ArchitectAnswerBody, 'reply' | 'text' | 'why' | 'tasks' | 'dispatch'> {
  const r = view.result as ArchitectAnswerResult;
  const tasks = [...new Set(r.tasks ?? [])];
  return { reply: r.reply, text: r.text, dispatch: view.status.handBack?.dispatch ?? null, ...(r.reply === 'plan-must-change' && r.why !== undefined ? { why: r.why } : {}), ...(r.reply === 'answer' && tasks.length > 0 ? { tasks } : {}) };
}

/** What must still be absent for an ask to be current inside a write (askStanding, as a guard). */
function standingGuard(ctx: FlowCtx, a: Ask, sec: readonly Ev[]): AppendGuard['absent'] {
  const at = (event: string, key: string) => ({ mission: ctx.mission, line: SECRETARY_LINE, event, key });
  const id = a.escalation;
  return [
    at('applied', id),
    at('user-answer', id),
    ...(a.by === 'pm'
      ? [at('pm-answer-rejected', `${id}#${a.round}`)]
      : [
          // the PM's next answer round (a round an Architect's reply reopened follows closed PM rounds)
          at('pm-answer', `${id}#${pmRoundOf(sec, id)}`),
          // the hand-up of this round (review p11-r2-2: one from before a reopened round stays and is not this round's)
          at('to-user', handUpKey(sec, id)),
          at('secretary-retry', `${id}#${a.round + 1}`),
        ]),
  ];
}

/**
 * 4.4 (review p11-4): why a reply would act on an out-of-date ask, or null: the words a PM's ask rested on are no
 * longer in force (ruling A.6: checked at application), or the asking task's card in the plan in effect is not the
 * one its escalation was raised under (a repair or a re-plan replaced it before the escalation is closed). With the
 * revisions read, which the reply's write is checked against.
 */
async function outOfDate(ctx: FlowCtx, a: Ask, esc: EscalationBody, d: DecisionBody | null): Promise<{ readonly why: string | null; readonly latest: NonNullable<AppendGuard['latest']> }> {
  if (a.by === 'pm') for (const w of d?.words ?? []) if (ctx.ports.wordsAuthority?.(w.id, ctx.mission) !== w.fingerprint) return { why: `the words ${w.id} the PM's ask rested on changed`, latest: [] };
  const taskId = esc.subject.slice('task:'.length);
  const effective = (await eventsOf(ctx, PLAN_LINE, 'effective')).at(-1);
  const spec = (await eventsOf<{ hash: string }>(ctx, taskLine(taskId), 'spec')).at(-1);
  const latest = [{ mission: ctx.mission, line: PLAN_LINE, event: 'effective', revision: effective?.revision ?? null }, { mission: ctx.mission, line: taskLine(taskId), event: 'spec', revision: spec?.revision ?? null }];
  const pie = await planInEffect(ctx);
  const card = pie?.plan.tasks.find((t) => t.id === taskId);
  if (card === undefined) return { why: `task ${taskId} is no longer in the plan in effect`, latest };
  if (spec === undefined || spec.body.hash !== taskCardHash(card)) return { why: `task ${taskId} has a new card in the plan in effect: the question was about its earlier card`, latest };
  return { why: null, latest };
}

/**
 * The reply recorded on the escalation, one write. A current ask's reply that is not carried out as an answer
 * returns the escalation to a fresh Secretary round in the same write; the guard checks that the ask is still
 * current, its authority in force and its task's card unchanged. A reply of an ask no longer current, or out of
 * date, is recorded with why (`moot`) and nothing else.
 */
async function recordReply(ctx: FlowCtx, a: Ask, task: string, r: Pick<ArchitectAnswerBody, 'reply' | 'text' | 'why' | 'tasks' | 'dispatch'>, standing: string | null, sec: readonly Ev[]): Promise<void> {
  const esc = await escalation(ctx, a.escalation);
  if (esc === null) return;
  const key = answerKey(a);
  const d = await askingDecision(ctx, a);
  const dated = standing === null ? await outOfDate(ctx, a, esc, d) : { why: null, latest: [] };
  const moot = standing ?? dated.why;
  // the asking task gets the answer as its escalation's; `tasks` names only the others
  const others = (r.tasks ?? []).filter((x) => `task:${x}` !== esc.subject);
  const { tasks: _named, ...rest } = r;
  const body: ArchitectAnswerBody = { escalation: esc.id, ask: a, step: task, ...rest, ...(others.length > 0 ? { tasks: others } : {}), ...(moot !== null ? { moot } : {}) };
  const events: FlowEventInput[] = [ev(ctx, SECRETARY_LINE, ARCHITECT_ANSWER, key, body)];
  const absent: Array<AppendGuard['absent'][number]> = [{ mission: ctx.mission, line: SECRETARY_LINE, event: ARCHITECT_ANSWER, key }];
  const extra: { -readonly [K in 'latest' | 'words']?: AppendGuard[K] } & { previous?: string } = {};
  if (moot === null) {
    absent.push(...standingGuard(ctx, a, sec));
    // the asking authority, inside the write: the PM's cited words; the requirement items the Secretary's decision relied on
    if (a.by === 'pm') extra.words = (d?.words ?? []).map((w) => ({ ...w, mission: ctx.mission }));
    else absent.push(...(d?.inputs ?? []).filter((i) => i.type === 'decision' || i.type === 'decision-authority' || i.line === d?.authorization).flatMap((i) => [{ mission: ctx.mission, line: 'requirements', event: 'withdrawn', key: i.line }, { mission: ctx.mission, line: 'requirements', event: 'item', key: i.version.replace(/\.v(\d+)$/, (_, n: string) => `.v${Number(n) + 1}`) }]));
    extra.latest = dated.latest;
    if (!(r.reply === 'answer' && answersInPlace(esc.source))) {
      const back = backToSecretary(ctx, esc, a, key, replyText(body, answersInPlace(esc.source)), sec);
      events.push(...back.events);
      absent.push(...back.absent);
      extra.previous = back.previous;
    }
  }
  const { previous, ...guarded } = extra;
  await commit(ctx, `flow:architect-answer:${ctx.mission}:${key}:${moot === null ? 'current' : 'moot'}`, {
    events,
    guard: { absent, ...guarded, code: 'STALE_REQUEST', message: `escalation ${esc.id} was answered, carried out, closed or returned by another writer, or its authority or its task's card changed, while the Architect's reply was being recorded; nothing was written (the next pass reads it again)` },
  });
  // the Secretary round the fresh one replaces, when it never decided (the PM had asked first): its queued step is cancelled
  if (previous !== undefined && (await ctx.ports.scheduler.status(previous))?.state === 'queued') await ctx.ports.scheduler.cancel(previous);
}

/**
 * The escalation returns to the Secretary (review p11-2, G1): a fresh Secretary round with the reply as its reason,
 * marked with the reply (`architect`), in the shape of flow/secretary.ts rejectDecision's retry. When the PM asked,
 * the PM's round is closed with the reply in the same write, and the marked round is the Secretary's again.
 */
function backToSecretary(ctx: FlowCtx, esc: EscalationBody, a: Ask, key: string, why: string, sec: readonly Ev[]): { readonly events: FlowEventInput[]; readonly absent: AppendGuard['absent']; readonly previous: string } {
  const n = sec.filter((e) => e.event === 'secretary-retry' && (e.body as { id?: unknown }).id === esc.id).length + 1;
  const retry = ev(ctx, SECRETARY_LINE, 'secretary-retry', `${esc.id}#${n}`, { id: esc.id, task: `${escalationTask(esc.id)}.retry${n}`, why, architect: key });
  const absent = [{ mission: ctx.mission, line: SECRETARY_LINE, event: 'secretary-retry', key: `${esc.id}#${n}` }];
  const previous = n === 1 ? escalationTask(esc.id) : `${escalationTask(esc.id)}.retry${n - 1}`;
  if (a.by !== 'pm') return { events: [retry], absent, previous };
  return { events: [ev(ctx, SECRETARY_LINE, 'pm-answer-rejected', `${esc.id}#${a.round}`, { id: esc.id, round: a.round, why, architect: key }), retry], absent, previous };
}

/** The decision that asked (its instructions and reason go on the card; its authority is checked at the reply). */
async function askingDecision(ctx: FlowCtx, a: Ask): Promise<DecisionBody | null> {
  const key = a.by === 'pm' ? `${a.escalation}#${a.round}` : a.round === 0 ? a.escalation : `${a.escalation}#${a.round}`;
  return (await eventOf<DecisionBody>(ctx, SECRETARY_LINE, a.by === 'pm' ? 'pm-answer' : 'decision', key))?.body ?? null;
}

/**
 * 4.4 (F3, review p11-6): what the Architect reads of the task's work: the Constructor's latest completed hand-back
 * of the attempt (its steps the latest first: its product's, a step that continued it after a pause, a step that
 * paused it, its first; the submit takes the first with an accepted hand-back, so a resumed step whose export used
 * the loop up comes before the pause it resumed), and the task's last review (of the attempt, else the latest of
 * the work, with its own attempt number).
 */
function workSteps(line: readonly Ev[], k: number | null): { readonly constructors: Array<{ readonly step: string; readonly attempt: number }>; readonly review: { readonly step: string; readonly attempt: number } | null } {
  const of = <B extends { k?: unknown }>(event: string, attempt: number | null): Array<{ readonly key: string; readonly body: B }> => line.filter((e) => e.event === event && (attempt === null || (e.body as B).k === attempt)).map((e) => ({ key: e.key, body: e.body as B }));
  const constructors: Array<{ step: string; attempt: number }> = [];
  if (k !== null) {
    // each step's events follow the previous step's (dispatched, paused, resumed, product): their order is the steps'
    const steps = line.flatMap((e) => {
      const b = e.body as { k?: unknown; task?: unknown; step?: unknown };
      if (b.k !== k) return [];
      const step = e.event === 'product' ? b.task : e.event === 'paused' || e.event === 'resumed' ? b.step : e.event === 'dispatched' ? e.key : undefined;
      return typeof step === 'string' ? [{ step, revision: e.revision }] : [];
    });
    for (const s of steps.sort((a, b) => b.revision - a.revision)) constructors.push({ step: s.step, attempt: k });
  }
  const reviews = of<{ k: number; task: string }>('review', k);
  const review = (reviews.at(-1) ?? of<{ k: number; task: string }>('review', null).at(-1))?.body;
  return { constructors: constructors.filter((c, i) => constructors.findIndex((x) => x.step === c.step) === i), review: review === undefined ? null : { step: review.task, attempt: review.k } };
}

async function submitAsk(ctx: FlowCtx, a: Ask, task: string, sec: readonly Ev[]): Promise<void> {
  const esc0 = await escalation(ctx, a.escalation);
  const d = await askingDecision(ctx, a);
  if (esc0 === null || d === null || !esc0.subject.startsWith('task:')) return;
  // the question as the round that asked has it: a returned round's reasons carry the earlier replies
  const esc = secretaryRoundInputs(esc0, sec.filter((e) => e.event === 'secretary-retry' && (a.by === 'pm' || Number(e.key.slice(esc0.id.length + 1)) <= a.round))).esc;
  const taskId = esc.subject.slice('task:'.length);
  const pie = await planInEffect(ctx);
  // a task the plan in effect no longer holds: execution closes its escalation, and the step is not queued
  const t = pie?.plan.tasks.find((x) => x.id === taskId);
  if (pie === null || t === undefined) return;
  const k = typeof (esc.facts as { attempt?: unknown } | undefined)?.attempt === 'number' ? ((esc.facts as { attempt: number }).attempt) : null;
  const line = await eventsOf(ctx, taskLine(taskId));
  const work = workSteps(line, k);
  const accepted: ArchitectAnswerCard['accepted'] = [];
  const p = await acceptedProduct(ctx, taskId);
  if (p !== null) accepted.push(acceptedEntry(taskId, line, p, (await objectRecord(ctx, p))?.source?.commit));
  const items = await currentItems(ctx);
  const constraints = await currentConstraints(ctx);
  const events = await ctx.ports.ledger.events({ mission: ctx.mission });
  const snap = await ctx.ports.scheduler.snapshot({ mission: ctx.mission, purpose: 'architect' });
  // F3: what the Architect may read, all optional; one that cannot be stored never holds the step back
  let plan: Attached;
  try {
    plan = answerPlanMaterial((doc) => ctx.ports.ledger.content.put(doc), pie.eff.dplan, pie.plan);
  } catch (e) {
    plan = { notAttached: `[plan] the detailed plan in effect could not be attached${typeof (e as { code?: unknown }).code === 'string' ? ` (${(e as { code: string }).code})` : ''}; its task card is above` };
  }
  let claims: Attached | null = null;
  for (const c of work.constructors) if (claims === null) claims = await constructorClaims(ctx, { constructor: c.step, task: taskId, attempt: c.attempt });
  const materials = attach([plan, claims, work.review === null ? null : await previousReviewReport(ctx, { review: work.review.step, attempt: work.review.attempt })]);
  const card: ArchitectAnswerCard = {
    ...cardBase(ctx, task, {
      duties: `Answer one question of design on task ${taskId}: what the plan leaves open, decided as the plan's Architect would. You change nothing: no card, no standard, no write path, no structure. A change of the plan is your reply "plan-must-change", with what and why.`,
      constraints: planningConstraints(constraints, ctx.mission),
      decisionQuotes: taskDecisionQuotes(items, events, t, constraintsForTask(constraints, t, ctx.mission), pie.eff.dplan),
    }),
    // 4.4 (G3): the instructions addressed to its task in full, the mission's other addressed ones as an index
    ...(() => { const ad = addressedForPlanning(constraints, ctx.mission, { about: taskId }); return addressedIndexOf(ad.index, ad.full); })(),
    seat: 'architect-answer',
    workspace: { snapshot: snap.path, writablePaths: [] },
    escalation: { id: esc.id, source: esc.source, subject: esc.subject, summary: esc.summary, reasons: [...esc.reasons] },
    asked: { by: a.by, round: a.round, instructions: d.instructions, reason: d.reason },
    taskCard: t,
    attempt: k,
    dplan: pie.eff.dplan,
    requirementItems: taskRequirementItems(items, t),
    accepted,
    earlier: earlierReplies(sec, esc.id),
    tasks: pie.plan.tasks.map((x) => x.id).filter((x) => x !== taskId),
    ...materials,
  };
  await ctx.ports.scheduler.submit({
    task,
    lineage: task,
    mission: ctx.mission as MissionId,
    card,
    priority: 110,
    capabilities: card.capabilities,
    mode: 'fast',
    estimateMicros: 400_000,
    handover: { from: null, objects: [], step: `escalation ${esc.id} (${esc.source}) on ${esc.subject}: the ${a.by === 'pm' ? 'PM' : 'Secretary'} asked the Architect` },
  });
  ctx.progressed = true;
}
