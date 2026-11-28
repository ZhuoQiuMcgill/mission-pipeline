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
//                     A used-up loop has no answer that continues it: the reply goes back, as below, and a
//                     grant carries the answer to the next attempt (execution.ts).
//   plan-must-change, need-to-know, and a step that ended without a reply
//                     the escalation goes back to the decider that asked, in the write that records the
//                     reply: a new Secretary round with the reply among its reasons, or the PM's answer
//                     round closed with the reply, so the PM's inbox lists the escalation again.
//
// The step changes no card, standard or structure (its hand-back has no field for one), so no plan review
// follows (E-2). It counts on no loop of the task: its re-dispatches count on its own lineage. The task waits
// for it as for any decision (applyTaskDecision; a review waits on process/questions.ts).
//
// Another writer in between: the ask stops being current when the escalation is answered by the PM or the
// user, carried out, closed as superseded (a new card, a giving-up), or its round closed. A queued step is then
// cancelled; a claim of it is refused (seat/cards/refresh.ts); a reply that arrives anyway is recorded with
// `moot` and changes nothing. The write that records a current reply checks, inside the write, that the ask is
// still current; otherwise nothing is written and the next pass reads it again.

import type { MissionId } from '../common/ids.ts';
import type { AppendGuard, FlowEvent, FlowEventInput } from './ports.ts';
import { attach, constructorClaims, previousReviewReport, type Attached } from './handbackMaterials.ts';
import { cardBase, commit, ev, eventOf, eventsOf, idPart, material, missionClosed, objectRecord, safeId, taskView, type FlowCtx, type TaskView } from './context.ts';
import { SECRETARY_LINE, taskLine, type DetailedPlanDoc } from './plandoc.ts';
import { planInEffect } from './planning.ts';
import { acceptedProduct } from './execution.ts';
import { acceptedEntry } from './repair.ts';
import { currentConstraints, currentItems } from './requirements.ts';
import { decisionFor, escalation, escalationTask, isApplied, type DecisionBody, type EscalationBody } from './secretary.ts';
import { addressedForPlanning, addressedIndexOf, constraintsForTask, planningConstraints, secretaryRoundInputs, taskDecisionQuotes, taskRequirementItems } from '../seat/cards/dynamic.ts';
import type { ArchitectAnswerCard, ArchitectAnswerResult } from '../seat/cards/architectAnswer.ts';
import { ARCHITECT_ANSWER, answerKey, answersInPlace, askOf, askStanding, askTag, repliesOn, replyText, type ArchitectAnswerBody, type Ask } from './architectAnswers.ts';

/** The Architect step of an ask (its own lineage too: it counts on no loop or re-dispatch allowance of the task). */
export const askTask = (mission: string, a: Ask): string => safeId(`arch-ask.${mission}.${idPart(a.escalation)}.${askTag(a)}`);

type Ev = FlowEvent;

/** The secretary line's events an ask's standing is read from (askStanding), and the replies; one read each. */
async function standingEvents(ctx: FlowCtx): Promise<Ev[]> {
  const out: Ev[] = [];
  for (const event of ['applied', 'user-answer', 'to-user', 'pm-answer', 'pm-answer-rejected', 'secretary-retry', ARCHITECT_ANSWER]) out.push(...(await eventsOf(ctx, SECRETARY_LINE, event)));
  return out;
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
      // a step that ended without a usable reply while its ask is current: the decider gets the question back (P-4: a safe default)
      if (standing === null) await recordReply(ctx, a, task, { reply: 'failed', text: `${view.why}${view.status.note !== null ? `: ${view.status.note}` : ''}`, dispatch: null }, null);
      return;
    case 'done':
      await recordReply(ctx, a, task, replyOf(view), standing);
  }
}

function replyOf(view: Extract<TaskView, { kind: 'done' }>): Pick<ArchitectAnswerBody, 'reply' | 'text' | 'why' | 'tasks' | 'dispatch'> {
  const r = view.result as ArchitectAnswerResult;
  const tasks = [...new Set(r.tasks ?? [])];
  return { reply: r.reply, text: r.text, dispatch: view.status.handBack?.dispatch ?? null, ...(r.reply === 'plan-must-change' && r.why !== undefined ? { why: r.why } : {}), ...(r.reply === 'answer' && tasks.length > 0 ? { tasks } : {}) };
}

/** What must still be absent for an ask to be current inside a write (askStanding, as a guard). */
function standingGuard(ctx: FlowCtx, a: Ask): AppendGuard['absent'] {
  const at = (event: string, key: string) => ({ mission: ctx.mission, line: SECRETARY_LINE, event, key });
  const id = a.escalation;
  return [
    at('applied', id),
    at('user-answer', id),
    ...(a.by === 'pm'
      ? [at('pm-answer-rejected', `${id}#${a.round}`)]
      : [at('pm-answer', `${id}#1`), at('to-user', id), at('secretary-retry', `${id}#${a.round + 1}`)]),
  ];
}

/**
 * The reply recorded on the escalation, one write. A current ask's reply that is not carried out as an answer
 * sends the escalation back to its decider in the same write; the guard checks the ask is still current. A
 * reply of an ask no longer current is recorded with why (`moot`) and nothing else.
 */
async function recordReply(ctx: FlowCtx, a: Ask, task: string, r: Pick<ArchitectAnswerBody, 'reply' | 'text' | 'why' | 'tasks' | 'dispatch'>, standing: string | null): Promise<void> {
  const esc = await escalation(ctx, a.escalation);
  if (esc === null) return;
  const key = answerKey(a);
  // the asking task gets the answer as its escalation's; `tasks` names only the others
  const others = (r.tasks ?? []).filter((x) => `task:${x}` !== esc.subject);
  const { tasks: _named, ...rest } = r;
  const body: ArchitectAnswerBody = { escalation: esc.id, ask: a, step: task, ...rest, ...(others.length > 0 ? { tasks: others } : {}), ...(standing !== null ? { moot: standing } : {}) };
  const events: FlowEventInput[] = [ev(ctx, SECRETARY_LINE, ARCHITECT_ANSWER, key, body)];
  const absent: Array<AppendGuard['absent'][number]> = [{ mission: ctx.mission, line: SECRETARY_LINE, event: ARCHITECT_ANSWER, key }];
  if (standing === null) {
    absent.push(...standingGuard(ctx, a));
    if (!(r.reply === 'answer' && answersInPlace(esc.source))) events.push(backTo(ctx, esc, a, key, replyText(body, answersInPlace(esc.source))));
  }
  await commit(ctx, `flow:architect-answer:${ctx.mission}:${key}:${standing === null ? 'current' : 'moot'}`, {
    events,
    guard: { absent, code: 'STALE_REQUEST', message: `escalation ${esc.id} was answered, carried out, closed or returned by another writer while the Architect's reply was being recorded; nothing was written (the next pass reads it again)` },
  });
}

/** The escalation goes back to the decider that asked: the Secretary's next round, or the PM's answer round closed. */
function backTo(ctx: FlowCtx, esc: EscalationBody, a: Ask, key: string, why: string): FlowEventInput {
  if (a.by === 'pm') return ev(ctx, SECRETARY_LINE, 'pm-answer-rejected', `${esc.id}#${a.round}`, { id: esc.id, round: a.round, why, architect: key });
  // the shape of flow/secretary.ts rejectDecision's retry: the next round's task, and the reply among its reasons
  const n = a.round + 1;
  return ev(ctx, SECRETARY_LINE, 'secretary-retry', `${esc.id}#${n}`, { id: esc.id, task: `${escalationTask(esc.id)}.retry${n}`, why });
}

/** The decision that asked (its instructions and reason go on the card). */
async function askingDecision(ctx: FlowCtx, a: Ask): Promise<DecisionBody | null> {
  const key = a.by === 'pm' ? `${a.escalation}#${a.round}` : a.round === 0 ? a.escalation : `${a.escalation}#${a.round}`;
  return (await eventOf<DecisionBody>(ctx, SECRETARY_LINE, a.by === 'pm' ? 'pm-answer' : 'decision', key))?.body ?? null;
}

/** The plan in effect as the card's optional material: its fields, one task (interface, module, risk) per line. */
function planText(dplan: string, plan: DetailedPlanDoc): string {
  const fields = Object.entries(plan).map(([k, xs]) => `  ${JSON.stringify(k)}: [${(xs as unknown[]).length === 0 ? ']' : `\n${(xs as unknown[]).map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]`}`);
  return `# Detailed plan ${dplan}, as it is in effect (with earlier repairs)\n\n${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}: ${plan.tasks.map((t) => t.id).join(', ')}.\n\n\`\`\`json\n{\n${fields.join(',\n')}\n}\n\`\`\`\n`;
}

/** The attempt's hand-back (its product's Constructor, else the step that paused it) and its last review, from the task line. */
function attemptSteps(line: readonly Ev[], k: number | null): { readonly constructor: string | null; readonly review: string | null } {
  if (k === null) return { constructor: null, review: null };
  const of = <B extends { k?: unknown }>(event: string): B[] => line.filter((e) => e.event === event && (e.body as B).k === k).map((e) => e.body as B);
  const product = of<{ k: number; task: string }>('product').at(-1)?.task ?? null;
  const paused = of<{ k: number; step: string }>('paused').at(-1)?.step ?? null;
  return { constructor: product ?? paused, review: of<{ k: number; task: string }>('review').at(-1)?.task ?? null };
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
  const steps = attemptSteps(line, k);
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
    plan = material(ctx, 'plan', `Detailed plan ${pie.eff.dplan} as it is in effect, in full`, planText(pie.eff.dplan, pie.plan), false, 'plan');
  } catch (e) {
    plan = { notAttached: `[plan] the detailed plan in effect could not be attached${typeof (e as { code?: unknown }).code === 'string' ? ` (${(e as { code: string }).code})` : ''}; its task card is above` };
  }
  const materials = attach([
    plan,
    steps.constructor === null ? null : await constructorClaims(ctx, { constructor: steps.constructor, task: taskId, attempt: k ?? 1 }),
    steps.review === null ? null : await previousReviewReport(ctx, { review: steps.review, attempt: k ?? 1 }),
  ]);
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
    earlier: repliesOn(sec, esc.id).map((x) => ({ step: x.step, reply: x.reply, text: x.reply === 'plan-must-change' ? `${x.text} (why: ${x.why ?? ''})` : x.text })),
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
