import { secretaryInputs, secretaryRoundInputs } from '../seat/cards/dynamic.ts';
// Escalations to the Secretary (design 3.8, 3.2, 3.9, 6.5) for every flow.
//
// A flow raises an escalation with the options the program can carry out for it; this module
// starts one fresh Secretary task per escalation (in the lineage it handles, so its invocation
// counts toward that lineage, 6.5), records the decision, and tells the PM by 3.2:
//   detail                       recorded only (layer 2; "may matter" noted when set)
//   important-within-authority   takes effect; the PM is told (a Secretary notice, 3.9)
//   needs-user                   the related work waits; the PM is told and asks the user; the
//                                PM records the user's answer with answerEscalation()
// The owning flow reads the decision (decisionFor) and carries it out mechanically, then marks
// it applied (markApplied), so a restarted flow neither loses nor repeats it.
//
// Edge cases take the safe default with a notice (maintainer 2026-10-09): a Secretary that
// cannot decide (its seat failed, or its task is exhausted) hands the decision to the PM and the
// user (proposed WI-24); a Secretary grant the ledger refuses (its one grant on the lineage is
// used) asks the user (WI-08).

import type { JudgmentId, MissionId, ObjectVersionId } from '../common/ids.ts';
import type { BaseRecord, JudgmentRecord, ListRef } from '../common/records.ts';
import { validateRecord } from '../common/validate.ts';
import type { CardBinding } from '../seat/cards/common.ts';
import type { DecisionOption, EscalationSource, SecretaryCard, SecretaryResult } from '../seat/cards/secretary.ts';
import { cardBase, commit, currentVersions, basisIndex, ev, eventOf, eventsOf, flowCtx, judgmentRecordOf, safeId, shortHash, taskView, tellOnce, type FlowCtx } from './context.ts';
import { DetailedPlanDoc, PLAN_LINE, SECRETARY_LINE, amendedPlan, latestEffectiveOf, type AmendmentEntry, type StoredDetailedPlan } from './plandoc.ts';
import type { AppendGuard, FlowEventInput, FlowPorts } from './ports.ts';
import { currentItems, currentConstraints } from './requirements.ts';
import { WI } from './wi.ts';

export interface EscalationSpec {
  /** Deterministic and unique within the mission (safeId applied). */
  readonly id: string;
  readonly source: EscalationSource;
  readonly lineage: string;
  /** What it is about, e.g. "plan:<object>" or "task:<id>". */
  readonly subject: string;
  readonly summary: string;
  readonly original?: string;
  readonly changed?: string;
  readonly reasons: readonly string[];
  readonly options: readonly DecisionOption[];
  /** Requirement item lines involved. */
  readonly items?: readonly string[];
  /** A negated review position the decision rules on (accept → a pass revoking the negation). */
  readonly position?: { readonly target: string; readonly review: string; readonly revokes: string } | null;
  /** Facts for the Secretary (and for the owning flow when it applies the decision). */
  readonly facts?: unknown;
  /**
   * Who hands the decision over (4.1 §3.2, U-13): the seat task whose hand-back raised it (null: the
   * program's own check) and the object versions it is about. Unset: the advance that raised it.
   */
  readonly handover?: { readonly from: string | null; readonly objects: readonly string[] };
}

export interface EscalationBody extends EscalationSpec {
  readonly task: string;
}

export interface DecisionBody {
  readonly escalation: string;
  readonly by: 'secretary' | 'user' | 'program';
  readonly option: DecisionOption;
  readonly classification: 'detail' | 'important-within-authority' | 'needs-user';
  readonly authorization: string | null;
  readonly reason: string;
  readonly instructions: string;
  readonly grantExtra: number;
  readonly notice: string;
  readonly mayMatter: boolean;
  readonly inputs?: readonly { line: string; version: string; type: string }[];
}

/** What an option means, for the card. */
const OPTION_TEXT: Readonly<Record<DecisionOption, { label: string; outcome: string }>> = {
  accept: { label: 'Accept as it is', outcome: 'the item stands; the work goes on (a negated review position is overruled by your ruling)' },
  'accept-risk': { label: 'Accept the remaining risk', outcome: 'the unresolved items go to the risk list; the work goes on' },
  'send-back': { label: 'Send back with instructions', outcome: 'the Architect revises the plan per your instructions (counted with the plan returns)' },
  replan: { label: 'Re-plan', outcome: 'the Architect decomposes again with your instructions (split the task, change the approach)' },
  grant: { label: 'Grant 1 or 2 more attempts (your one grant on this lineage)', outcome: 'the exhausted loop runs again; after that only the user can grant more' },
  restart: { label: 'Restart the seat', outcome: 'the task is dispatched again (counted with the restarts after quarantine or seat failure, cap 2)' },
  abandon: { label: 'Give the task up', outcome: 'the task stops and goes to the risk list; the rest of the mission continues' },
  answer: { label: 'Answer the question', outcome: 'your answer goes to the seat as a decision; the work goes on' },
  rework: { label: 'Send back to the Constructor', outcome: 'the Constructor reworks per your instructions (counted with the reworks)' },
  'ask-user': { label: 'Ask the user', outcome: 'the related work waits; the PM asks the user' },
};

export const escalationTask = (id: string): string => `sec.${id}`;

export async function escalation(ctx: FlowCtx, id: string): Promise<EscalationBody | null> {
  return (await eventOf<EscalationBody>(ctx, SECRETARY_LINE, 'escalation', id))?.body ?? null;
}

/** The escalations of a subject, oldest first. */
export async function escalationsOf(ctx: FlowCtx, subject: string): Promise<EscalationBody[]> {
  return (await eventsOf<EscalationBody>(ctx, SECRETARY_LINE, 'escalation')).filter((e) => e.body.subject === subject).map((e) => e.body);
}

/** Raise an escalation (idempotent by id): the event, then the Secretary task. */
export async function raiseEscalation(ctx: FlowCtx, spec: EscalationSpec): Promise<void> {
  const id = safeId(spec.id);
  if ((await escalation(ctx, id)) !== null) return;
  const body: EscalationBody = { ...spec, id, task: escalationTask(id) };
  await commit(ctx, `flow:escalation:${ctx.mission}:${id}`, { events: [ev(ctx, SECRETARY_LINE, 'escalation', id, body)] });
  await submitSecretary(ctx, body);
}

async function submitSecretary(ctx: FlowCtx, e: EscalationBody): Promise<void> {
  if ((await ctx.ports.scheduler.status(e.task)) !== null) return;
  const card = await secretaryCard(ctx, e);
  await ctx.ports.scheduler.submit({
    task: e.task,
    lineage: e.lineage,
    mission: ctx.mission,
    card,
    priority: 120,
    capabilities: card.capabilities,
    mode: 'fast',
    estimateMicros: 200_000,
    secretaryFor: e.lineage,
    // a legalization's escalations are post-close work (§6.7)
    ...(e.subject.startsWith('audit:') ? { afterClose: 'audit' as const } : {}),
    // who hands it over (§3.2, U-13): the seat task that raised it, with the objects it is about (code review r2 #7)
    handover: { ...(e.handover !== undefined ? { from: e.handover.from, objects: [...e.handover.objects] } : {}), step: `escalation ${e.id} (${e.source}) on ${e.subject}` },
  });
  ctx.progressed = true;
}

async function secretaryCard(ctx: FlowCtx, e: EscalationBody): Promise<SecretaryCard> {
  const items = await currentItems(ctx);
  const allConstraints = await currentConstraints(ctx);
  const taskId = e.subject.startsWith('task:') ? e.subject.slice('task:'.length) : null;
  const spec = taskId === null ? undefined : (await eventsOf<{ dplan: string }>(ctx, `task:${taskId}`, 'spec')).at(-1)?.body;
  const obj = spec === undefined ? null : await ctx.ports.ledger.objectVersion(spec.dplan);
  const detailed = obj === null ? null : JSON.parse(ctx.ports.ledger.content.get(obj.content)) as StoredDetailedPlan;
  // the plan as it is in effect: its version's tasks plus the tasks repairs added (4.1.2, D-10)
  const amendments = spec === undefined ? undefined : latestEffectiveOf<{ dplan: string; amendments?: readonly AmendmentEntry[] }>(await eventsOf(ctx, PLAN_LINE, 'effective'), spec.dplan)?.amendments;
  const task = detailed === null ? undefined : amendedPlan(DetailedPlanDoc.parse(detailed.plan), amendments).tasks.find((t) => t.id === taskId);
  const inputs = secretaryInputs(ctx.mission, e, items, allConstraints, await ctx.ports.ledger.events({ mission: ctx.mission }), task, !(await ctx.ports.ledger.loop(e.lineage, 'env-retry')).secretaryGrantUsed, (text) => ctx.ports.ledger.content.put(text));
  let position: SecretaryCard['position'] = null;
  if (e.position) {
    const neg = await judgmentRecordOf(ctx, e.position.revokes);
    if (neg !== null) position = { target: e.position.target, review: e.position.review, revokes: e.position.revokes, binding: rulingBinding(neg, `j.sec.${e.id}`) };
  }
  return {
    ...cardBase(ctx, e.task, {
      duties: 'Decide this one escalation within the recorded authority, pick one option, classify it, and write the notice for the PM.',
    }),
    seat: 'secretary',
    request: { id: e.id, source: e.source, lineage: e.lineage, subject: e.subject, summary: e.summary, original: e.original ?? '', changed: e.changed ?? '', reasons: [...e.reasons] },
    ...inputs,
    options: e.options.map((o) => ({ id: o, ...OPTION_TEXT[o] })),
    position,
  };
}

/** A ruling's binding: the same contract inputs as the negation it overrules. */
function rulingBinding(neg: JudgmentRecord, judgment: string): CardBinding {
  return {
    judgment,
    bases: neg.bases,
    constraints: neg.constraints,
    reliesOn: neg.reliesOn,
    evidence: neg.evidence,
    revokes: neg.judgment,
    extends: null,
    evidenceUse: { fields: [...neg.evidenceUse.fields], statisticalOrExternal: neg.evidenceUse.statisticalOrExternal },
    superseded: [],
  };
}

async function secretaryRound(ctx: FlowCtx, esc: EscalationBody): Promise<{ esc: EscalationBody; key: string; round: number }> {
  return secretaryRoundInputs(esc, await ctx.ports.ledger.events({ mission: ctx.mission }));
}

/** Process every open escalation of the mission: start its Secretary, record its decision, tell the PM. */
export async function secretaryStep(ctx: FlowCtx): Promise<void> {
  for (const e of await eventsOf<EscalationBody>(ctx, SECRETARY_LINE, 'escalation')) {
    const round = await secretaryRound(ctx, e.body);
    const esc = round.esc;
    // closed before its Secretary decided (its owner left scope: superseded), or decided by the user
    // first: the Secretary step is moot. Before the task view: a cancelled step must not read as a
    // Secretary that could not decide (that would ask the user, WI-24). No decision, no notice.
    if ((await closedEscalation(ctx, esc.id)) !== null || ((await eventOf(ctx, SECRETARY_LINE, 'user-answer', esc.id)) !== null && (await eventOf(ctx, SECRETARY_LINE, 'decision', round.key)) === null)) {
      await cancelSecretarySteps(ctx, [esc.id]);
      continue;
    }
    const decided = await eventOf<DecisionBody>(ctx, SECRETARY_LINE, 'decision', round.key);
    if (decided !== null) {
      // the notices a decision calls for are sent until marked told (code review r1 #14)
      if (decided.body.by === 'program') await tellUndecided(ctx, esc, decided.body.reason);
      else await tellPm(ctx, esc, decided.body);
      const toUser = await eventOf<{ why: string; wi: string | null }>(ctx, SECRETARY_LINE, 'to-user', esc.id);
      if (toUser !== null && (await eventOf(ctx, SECRETARY_LINE, 'user-answer', esc.id)) === null) await tellToUser(ctx, esc.id, toUser.body.why, toUser.body.wi ?? null);
      continue;
    }
    const view = await taskView(ctx, esc.task);
    if (view.kind === 'absent') {
      await submitSecretary(ctx, esc);
      continue;
    }
    if (view.kind === 'pending' || view.kind === 'evidence') continue;
    if (view.kind === 'failed') {
      // the Secretary could not decide: the decision goes to the PM and the user (proposed WI-24)
      const d: DecisionBody = {
        escalation: esc.id,
        by: 'program',
        option: 'ask-user',
        classification: 'needs-user',
        authorization: null,
        reason: `the Secretary seat could not decide (${view.why}: ${view.status.note ?? ''})`,
        instructions: '',
        grantExtra: 0,
        notice: `The Secretary could not decide escalation ${esc.id} (${esc.summary}); please decide with the user.`,
        mayMatter: false,
      };
      await commit(ctx, `flow:decision:${ctx.mission}:${round.key}`, { events: [ev(ctx, SECRETARY_LINE, 'decision', round.key, d)] });
      await tellUndecided(ctx, esc, d.reason);
      continue;
    }
    const r = view.result as SecretaryResult;
    const dispatch = view.status.handBack?.dispatch;
    const claimed = dispatch === undefined ? null : await eventOf<{ spec: string }>(ctx, `dispatch:${dispatch}`, 'claimed', 'spec');
    const dispatched = claimed === null ? null : JSON.parse(ctx.ports.ledger.content.get(claimed.body.spec)) as { card: SecretaryCard };
    const d: DecisionBody = {
      escalation: esc.id,
      by: 'secretary',
      option: r.option,
      classification: r.classification,
      authorization: r.authorization,
      reason: r.reason,
      instructions: r.instructions,
      grantExtra: r.grantExtra,
      notice: r.notice,
      mayMatter: r.mayMatter,
      ...(dispatched?.card.contextItems !== undefined ? { inputs: dispatched.card.contextItems } : {}),
    };
    await commit(ctx, `flow:decision:${ctx.mission}:${round.key}`, { events: [ev(ctx, SECRETARY_LINE, 'decision', round.key, d)] });
    await tellPm(ctx, esc, d);
  }
}

async function tellUndecided(ctx: FlowCtx, esc: EscalationBody, why: string): Promise<void> {
  await tellOnce(ctx, SECRETARY_LINE, {
    category: 'secretary-undecided',
    wi: WI.secretaryUndecided,
    key: esc.id,
    trigger: `the Secretary task ${esc.task} for escalation ${esc.id} (${esc.source} on ${esc.subject}) ended without a decision: ${why}`,
    defaultAction: `only ${esc.subject} waits; the decision is handed to the PM and the user (options: ${esc.options.join(', ')}); the rest of the mission continues`,
    detail: { escalation: esc, why },
    askUser: true,
  });
}

/** 3.2, 3.9: detail → layer 2 only; important within authority → a Secretary notice; needs user → the PM asks. */
async function tellPm(ctx: FlowCtx, esc: EscalationBody, d: DecisionBody): Promise<void> {
  if (d.classification === 'detail' || d.by === 'user') return;
  const needsUser = d.classification === 'needs-user';
  // "in effect" only once the owning flow carried this very decision out (code review round 10): a
  // decision overridden by the user, closed, or never carried out never says it
  if (!needsUser) {
    const a = await eventOf<{ readonly what?: { readonly option?: unknown }; readonly by?: unknown }>(ctx, SECRETARY_LINE, 'applied', esc.id);
    if (a === null || a.body.by !== 'secretary' || a.body.what?.option !== d.option) return;
  }
  await tellOnce(ctx, SECRETARY_LINE, {
    category: needsUser ? 'needs-user-decision' : 'secretary-decision',
    wi: null,
    key: esc.id,
    trigger: `${esc.source} on ${esc.subject}: ${esc.summary}`,
    defaultAction: needsUser ? `only ${esc.subject} waits for the user's decision; the rest of the mission continues` : `decided within authority ${d.authorization ?? ''}: ${d.option}; in effect`,
    detail: { escalation: esc.id, notice: d.notice, option: d.option, reason: d.reason, options: esc.options, authorization: d.authorization },
    ...(needsUser ? { askUser: true } : {}),
  });
}

/** The "in effect" notice of a Secretary decision the flow carried out (sent at apply; again until told). */
async function tellApplied(ctx: FlowCtx, id: string): Promise<void> {
  const esc = await escalation(ctx, id);
  const key = esc === null ? id : (await secretaryRound(ctx, esc)).key;
  const d = await eventOf<DecisionBody>(ctx, SECRETARY_LINE, 'decision', key);
  if (esc !== null && d !== null && d.body.by === 'secretary') await tellPm(ctx, esc, d.body);
}

/** Hand a decided escalation to the user (e.g. the Secretary's grant was refused, WI-08). */
export async function escalateToUser(ctx: FlowCtx, id: string, why: string, wi: string | null): Promise<void> {
  if ((await eventOf(ctx, SECRETARY_LINE, 'to-user', id)) === null) await commit(ctx, `flow:to-user:${ctx.mission}:${id}`, { events: [ev(ctx, SECRETARY_LINE, 'to-user', id, { why, wi })] });
  await tellToUser(ctx, id, why, wi);
}

async function tellToUser(ctx: FlowCtx, id: string, why: string, wi: string | null): Promise<void> {
  const esc = await escalation(ctx, id);
  await tellOnce(ctx, SECRETARY_LINE, {
    category: wi === null ? 'needs-user-decision' : 'loop-exhausted-needs-user',
    wi,
    key: `${id}:to-user`,
    trigger: why,
    defaultAction: `only ${esc?.subject ?? id} waits for the user's decision; the rest of the mission continues`,
    detail: { escalation: id, options: esc?.options ?? [] },
    askUser: true,
  });
}

/** Reject and queue a fresh card in the same retry path, without recovering old inputs. */
async function rejectDecision(ctx: FlowCtx, esc: EscalationBody, round: { key: string; round: number }, d: DecisionBody, why: string): Promise<false> {
  const n = round.round + 1;
  const id = esc.id;
  const key = `${id}#${n}`;
  const original = await escalation(ctx, id);
  const task = `${original!.task}.retry${n}`;
  const inputs = (d.inputs ?? []).filter((i) => i.type === 'decision' || i.type === 'decision-authority' || i.line === d.authorization);
  await commit(ctx, `flow:secretary-retry:${ctx.mission}:${key}`, { events: [ev(ctx, SECRETARY_LINE, 'decision-rejected', round.key, { id, why, authorization: d.authorization, inputs }), ev(ctx, SECRETARY_LINE, 'secretary-retry', key, { id, task, why })] });
  await submitSecretary(ctx, { ...esc, task, reasons: [...esc.reasons, why] });
  return false;
}

async function decisionAuthorityCurrent(ctx: FlowCtx, esc: EscalationBody, round: { key: string; round: number }, d: DecisionBody): Promise<boolean> {
  if (d.by === 'secretary') {
    if (round.round === 0 && d.inputs === undefined) return rejectDecision(ctx, esc, round, d, 'The Secretary decided on a card from before 4.1.1, which kept no versions of what it relied on. Review the current facts and decide again.');
    const items = await currentItems(ctx);
    const relied = (d.inputs ?? []).filter((i) => i.type === 'decision' || i.type === 'decision-authority' || i.line === d.authorization);
    const authority = d.authorization === null || items.some((i) => i.line === d.authorization && i.type === 'authorization' && i.state === 'valid');
    const current = relied.every((i) => items.some((now) => now.line === i.line && now.version === i.version && now.state === 'valid'));
    if (!authority || !current) {
      const why = `The Secretary decision was not carried out: its authorization or a cited decision is no longer in force. Review the current facts and decide again.`;
      return rejectDecision(ctx, esc, round, d, why);
    }
  }
  return true;
}

/** The decision to carry out, or null while waiting. A user's answer overrides. */
export async function decisionFor(ctx: FlowCtx, id: string): Promise<DecisionBody | null> {
  const answer = await eventOf<DecisionBody>(ctx, SECRETARY_LINE, 'user-answer', id);
  if (answer !== null) return answer.body;
  if ((await eventOf(ctx, SECRETARY_LINE, 'to-user', id)) !== null) return null;
  const esc = await escalation(ctx, id);
  const round = esc === null ? null : await secretaryRound(ctx, esc);
  const d = await eventOf<DecisionBody>(ctx, SECRETARY_LINE, 'decision', round?.key ?? id);
  if (d === null || d.body.classification === 'needs-user') return null;
  if (round !== null && !(await isApplied(ctx, id)) && !(await decisionAuthorityCurrent(ctx, round.esc, round, d.body))) return null;
  return d.body;
}

/**
 * An escalation closed without being carried out (its owner left scope: a dropped task, a new card,
 * a stop the exploration left, a settled exploration, an older PM batch): the why, or null.
 */
export async function closedEscalation(ctx: FlowCtx, id: string): Promise<string | null> {
  const a = await eventOf<{ readonly what?: { readonly option?: unknown; readonly why?: unknown } }>(ctx, SECRETARY_LINE, 'applied', id);
  if (a === null || a.body.what?.option !== 'superseded') return null;
  return typeof a.body.what.why === 'string' ? a.body.what.why : 'the work it was about changed';
}

/** The "applied" event that closes an escalation without carrying it out (`superseded`): to commit with the change that made it moot. */
export function supersededEvent(ctx: FlowCtx, id: string, why: string): FlowEventInput {
  return appliedEvent(ctx, id, { what: { option: 'superseded', why } });
}

/** Cancel the queued Secretary steps of these escalations (one in flight is refused at its hand-back: process/seat.ts). */
export async function cancelSecretarySteps(ctx: FlowCtx, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const esc = await escalation(ctx, id);
    const t = esc === null ? escalationTask(id) : (await secretaryRound(ctx, esc)).esc.task;
    if ((await ctx.ports.scheduler.status(t))?.state === 'queued') await ctx.ports.scheduler.cancel(t);
  }
}

/**
 * Close the open escalations of a subject that `keep` does not keep, as superseded, with `with_` in
 * one append (the change that made them moot), then cancel their queued Secretary steps. Returns the
 * ids closed.
 */
export async function closeEscalations(ctx: FlowCtx, op: string, subject: string, why: string, o: { readonly keep?: (e: EscalationBody) => boolean; readonly with?: readonly FlowEventInput[] } = {}): Promise<string[]> {
  const ids = (await openEscalations(ctx, subject)).filter((e) => !(o.keep?.(e) ?? false)).map((e) => e.id);
  const c = closing(ctx, ids, why);
  const events = [...(o.with ?? []), ...c.events];
  const guard = carryGuard([c]);
  if (events.length > 0) await commit(ctx, `${op}:${shortHash(ids)}`, { events, ...(guard !== undefined ? { guard } : {}) });
  await cancelSecretarySteps(ctx, ids);
  return ids;
}

export async function isApplied(ctx: FlowCtx, id: string): Promise<boolean> {
  return (await eventOf(ctx, SECRETARY_LINE, 'applied', id)) !== null;
}

/** The "applied" event of an escalation (its body: `what` was carried out, and who decided). Only through carryOut and the closes. */
function appliedEvent(ctx: FlowCtx, id: string, body: Record<string, unknown>): FlowEventInput {
  return ev(ctx, SECRETARY_LINE, 'applied', id, body);
}

/**
 * What carrying out a decision appends, as one write with the effect that carries it out (code review
 * round 10: the split commit of a decision). Its "applied" event names who decided (the Secretary's
 * dispatch, or the user's words entry); accepting a negated position (accept, accept-risk on an
 * escalation with a position) also writes the ruling judgment here and only here: j.sec.<id> when the
 * Secretary decided, j.user.<id> when the user did, rebuilt from the negation it revokes. `absent`
 * guards the write: nothing is written when the escalation was carried out or closed meanwhile.
 */
export interface Carry {
  readonly id: string;
  readonly events: readonly FlowEventInput[];
  readonly records: readonly BaseRecord[];
  readonly absent: AppendGuard['absent'];
}

export async function carryOut(ctx: FlowCtx, id: string, what: Record<string, unknown>): Promise<Carry> {
  const original = await escalation(ctx, id);
  const round = original === null ? null : await secretaryRound(ctx, original);
  const esc = round?.esc ?? null;
  const d = await decisionFor(ctx, id);
  if (d === null) throw Object.assign(new Error('The decision is not carried out: it awaits a current Secretary choice or the user.'), { code: 'NOT_READY' });
  if (esc !== null && round !== null && !(await decisionAuthorityCurrent(ctx, esc, round, d))) throw Object.assign(new Error('The decision is not carried out: its authority changed.'), { code: 'STALE_REQUEST' });
  const records: BaseRecord[] = [];
  let ruling: string | null = null;
  const accepting = (o: unknown): boolean => o === 'accept' || o === 'accept-risk';
  if (esc !== null && d !== null && esc.position && accepting(what['option']) && accepting(d.option)) {
    const neg = await judgmentRecordOf(ctx, esc.position.revokes);
    const jid = `j.${d.by === 'user' ? 'user' : 'sec'}.${esc.id}`;
    if (neg !== null && (await judgmentRecordOf(ctx, jid)) === null) {
      records.push(rulingRecord(neg, esc.position, jid, d.by === 'user' ? 'user' : 'secretary'));
      ruling = jid;
    }
  }
  const decider: Record<string, unknown> = d === null ? {} : { by: d.by };
  if (d !== null && d.by === 'secretary' && esc !== null) {
    const dispatch = (await ctx.ports.scheduler.status(esc.task))?.handBack?.dispatch ?? null;
    if (dispatch !== null) decider['dispatch'] = dispatch;
  }
  if (d !== null && d.by === 'user') {
    const w = /\((W-[0-9]+)\)\s*$/.exec(d.reason);
    if (w !== null) decider['words'] = w[1];
  }
  return {
    id,
    events: [appliedEvent(ctx, id, { what, ...decider, ...(ruling !== null ? { ruling } : {}) })],
    records,
    absent: [
      { mission: ctx.mission, line: SECRETARY_LINE, event: 'applied', key: id },
      ...(d?.by === 'secretary' ? (d.inputs ?? []).filter((i) => i.type === 'decision' || i.type === 'decision-authority' || i.line === d.authorization).flatMap((i) => [{ mission: ctx.mission, line: 'requirements', event: 'withdrawn', key: i.line }, { mission: ctx.mission, line: 'requirements', event: 'item', key: i.version.replace(/\.v(\d+)$/, (_, n: string) => `.v${Number(n) + 1}`) }]) : []),
      // a decision not the user's is the one in force only while the user has not answered (nor been handed it)
      ...(d === null || d.by !== 'user' ? [{ mission: ctx.mission, line: SECRETARY_LINE, event: 'user-answer', key: id }, { mission: ctx.mission, line: SECRETARY_LINE, event: 'to-user', key: id }] : []),
    ],
  };
}

/** The guard of a write that carries out or closes these escalations (a concurrent writer did first: retried on the next pass). */
export function carryGuard(carries: readonly Carry[]): AppendGuard | undefined {
  const absent = carries.flatMap((c) => c.absent);
  return absent.length === 0 ? undefined : { absent, code: 'STALE_REQUEST', message: `escalation ${carries.map((c) => c.id).join(', ')} was carried out, closed or answered by another writer meanwhile; nothing was written (the next pass reads it again)` };
}

/** After the write that carried decisions out: the "in effect" notices of the Secretary's decisions. */
export async function carried(ctx: FlowCtx, carries: readonly Carry[]): Promise<void> {
  for (const c of carries) await tellApplied(ctx, c.id);
}

/**
 * One write: `events` together with the decisions carried out (and escalations closed) in it, guarded
 * against a concurrent application; then the cancelled Secretary steps of what was closed (`closed`),
 * and the "in effect" notices of what was carried out.
 */
export async function commitCarrying(ctx: FlowCtx, op: string, events: readonly FlowEventInput[], carries: readonly Carry[], closed: readonly string[] = []): Promise<void> {
  const guard = carryGuard(carries);
  await commit(ctx, op, { events: [...events, ...carries.flatMap((c) => c.events)], records: carries.flatMap((c) => c.records), ...(guard !== undefined ? { guard } : {}) });
  await cancelSecretarySteps(ctx, closed);
  await carried(ctx, carries);
}

/** Carry a decision out with nothing else in the write (the effect is in the decision's own event body, or elsewhere already). */
export async function markApplied(ctx: FlowCtx, id: string, what: Record<string, unknown>): Promise<void> {
  if (await isApplied(ctx, id)) return; // already carried out: not progress
  const c = await carryOut(ctx, id, what);
  const guard = carryGuard([c]);
  await commit(ctx, `flow:applied:${ctx.mission}:${id}`, { events: c.events, records: c.records, ...(guard !== undefined ? { guard } : {}) });
  await carried(ctx, [c]);
}

/**
 * Close escalations as superseded (their owner left scope), for inclusion in the write that makes them
 * moot: the "applied" events and the guard. Cancel their queued Secretary steps after the write.
 */
export function closing(ctx: FlowCtx, ids: readonly string[], why: string): Carry {
  return {
    id: ids.join(', '),
    events: ids.map((id) => supersededEvent(ctx, id, why)),
    records: [],
    absent: ids.map((id) => ({ mission: ctx.mission, line: SECRETARY_LINE, event: 'applied', key: id })),
  };
}

/** The ruling judgment on a negated position (8.1, 5.2): a pass with the negation's contract inputs, revoking it. */
function rulingRecord(neg: JudgmentRecord, position: NonNullable<EscalationSpec['position']>, judgment: string, executor: string): JudgmentRecord {
  const b = rulingBinding(neg, judgment);
  const rec: JudgmentRecord = {
    kind: 'judgment',
    judgment: b.judgment as JudgmentId,
    review: position.review,
    executor,
    target: position.target as ObjectVersionId,
    verdict: 'pass',
    evidence: b.evidence as ListRef,
    bases: b.bases as ListRef,
    constraints: b.constraints as ListRef,
    reliesOn: b.reliesOn as ListRef,
    issues: [],
    revokes: neg.judgment,
    evidenceUse: b.evidenceUse,
    superseded: [],
    extends: null,
  };
  validateRecord(rec);
  return rec;
}

/** Open escalations of a subject: raised and not applied yet. */
export async function openEscalations(ctx: FlowCtx, subject: string): Promise<EscalationBody[]> {
  const out: EscalationBody[] = [];
  for (const e of await escalationsOf(ctx, subject)) if (!(await isApplied(ctx, e.id))) out.push(e);
  return out;
}

/**
 * The PM records the user's decision on an escalation that needs the user (3.2, 3.9). Accepting
 * a negated position records the user's ruling as a pass that revokes the negation (8.1).
 */
export async function answerEscalation(
  ports: FlowPorts,
  req: { readonly mission: MissionId; readonly escalation: string; readonly option: DecisionOption; readonly instructions?: string; readonly grantExtra?: number; readonly words: string },
): Promise<void> {
  const ctx = flowCtx(ports, req.mission);
  const esc = await escalation(ctx, req.escalation);
  if (esc === null) throw new Error(`no escalation ${req.escalation} in mission ${req.mission}`);
  if (req.option === 'ask-user' || !esc.options.includes(req.option)) throw new Error(`option ${req.option} is not a decision for ${req.escalation} (choose one of ${esc.options.filter((o) => o !== 'ask-user').join(', ')})`);
  // an escalation already carried out (applied once) takes no later answer: it would never be carried out,
  // and an accepting answer would write a ruling judgment that revokes a negation with no flow effect.
  // Refused before anything is written.
  const applied = await eventOf<{ readonly what?: unknown }>(ctx, SECRETARY_LINE, 'applied', esc.id);
  if (applied !== null) throw await alreadyApplied(ctx, esc, applied.body.what);
  const d: DecisionBody = {
    escalation: esc.id,
    by: 'user',
    option: req.option,
    classification: 'important-within-authority',
    authorization: null,
    reason: req.words,
    instructions: req.instructions ?? '',
    grantExtra: req.grantExtra ?? 0,
    notice: '',
    mayMatter: false,
  };
  // the answer is the decision; its ruling (accepting a negated position) is written only in the write that
  // carries it out (carryOut), so a decision overridden, closed or never carried out writes no ruling
  // the same check inside the write that records the answer (a flow that carries the escalation out
  // meanwhile wins; nothing is written)
  await commit(ctx, `flow:user-answer:${req.mission}:${esc.id}`, {
    events: [ev(ctx, SECRETARY_LINE, 'user-answer', esc.id, d)],
    guard: { absent: [{ mission: req.mission, line: SECRETARY_LINE, event: 'applied', key: esc.id }], code: 'already-applied', message: `escalation ${esc.id} (${esc.source} on ${esc.subject}) was carried out or closed while this answer was being recorded; an answer now would not be carried out, so nothing was recorded (WI-24)` },
  });
}

/**
 * The refusal of an answer to an escalation already carried out (code "already-applied", WI-24): who
 * decided it, with which option, and how it was carried out (or that it was closed as superseded).
 */
async function alreadyApplied(ctx: FlowCtx, esc: EscalationBody, what: unknown): Promise<Error> {
  const w = (what ?? {}) as { readonly option?: unknown; readonly why?: unknown };
  const d = await decisionFor(ctx, esc.id);
  const { option: _o, ...rest } = w as Record<string, unknown>;
  const how = Object.keys(rest).length > 0 ? ` (${JSON.stringify(rest).slice(0, 200)})` : '';
  const done =
    w.option === 'superseded'
      ? `was closed without being carried out: ${typeof w.why === 'string' ? w.why : 'the work it was about changed'}`
      : `was already decided by ${d === null ? 'the flow' : d.by === 'user' ? 'the user' : d.by === 'program' ? 'the program' : 'the Secretary'} (option ${d?.option ?? (typeof w.option === 'string' ? w.option : 'unknown')}) and carried out${how}`;
  return Object.assign(
    new Error(
      `escalation ${esc.id} (${esc.source} on ${esc.subject}) ${done}; an answer now would not be carried out, so nothing was recorded. To change course with the user, take the change to the plan (mp pm plan submit with their words) or answer the next escalation the flow raises (WI-24)`,
    ),
    { code: 'already-applied', detail: { escalation: esc.id, subject: esc.subject, decidedBy: d?.by ?? null, option: d?.option ?? null, applied: what ?? null } },
  );
}

/** The ruling judgment on a position, made by the Secretary's launch or the user's answer (null: none). */
export async function rulingOf(ctx: FlowCtx, id: string): Promise<string | null> {
  for (const j of [`j.sec.${id}`, `j.user.${id}`]) if ((await judgmentRecordOf(ctx, j)) !== null) return j;
  return null;
}

/** Current versions of basis lines (re-exported for flows that bind decisions). */
export { currentVersions, basisIndex };
