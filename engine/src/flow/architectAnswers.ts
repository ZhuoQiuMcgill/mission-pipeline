// 4.4 (G1, PM design §4): a design question is answered by an Architect, in one step. The records and the
// pure reads of an ask, shared by the flow (flow/architectAsk.ts, flow/secretary.ts decisionFor), the cards
// (flow/openItems.ts, seat/cards/dynamic.ts) and the claim (seat/cards/refresh.ts), so they read alike.
//
//   the ask     a decision with option `ask-architect`: a Secretary decision of round n (event "decision",
//               tag s<n>) or a PM answer of round r (event "pm-answer", tag p<r>). The user does not ask:
//               the PM asks on the user's words.
//   the reply   line "secretary", event "architect-answer", key "<escalation>:<tag>": one per ask, written
//               by the flow when the Architect's step hands back (or fails). A reply that arrives when its
//               ask is no longer current (another answer was given, the escalation was closed) is kept on
//               the record with `moot` and changes nothing.
//
// An escalation raised before 4.4, or whose decisions are all of 4.3, has no ask and no reply: it reads as
// in 4.3.

import type { EscalationSource } from '../seat/cards/secretary.ts';

export const ARCHITECT_ANSWER = 'architect-answer';

/** The three kinds of escalation that offer `ask-architect` (PM design G1). */
export const ASK_ARCHITECT_SOURCES: readonly EscalationSource[] = ['constructor-decision', 'reviewer-needs-decision', 'loop-exhausted'];

/**
 * The kinds whose escalation is carried out as an answer: an Architect's answer is carried out as their
 * `answer`. A used-up loop has no answer that continues it (a grant, a re-plan, an acceptance or a giving-up
 * is the decider's): its Architect's answer is recorded and the escalation returns to the Secretary.
 */
export function answersInPlace(source: string): boolean {
  return source === 'constructor-decision' || source === 'reviewer-needs-decision';
}

/** Who asked, at which round: the Secretary's round n (0: the escalation's own) or the PM's answer round r. */
export interface Ask {
  readonly escalation: string;
  readonly by: 'secretary' | 'pm';
  readonly round: number;
}

export const askTag = (a: Pick<Ask, 'by' | 'round'>): string => `${a.by === 'secretary' ? 's' : 'p'}${a.round}`;
export const answerKey = (a: Ask): string => `${a.escalation}:${askTag(a)}`;

export type ArchitectReply = 'answer' | 'plan-must-change' | 'need-to-know';

export interface ArchitectAnswerBody {
  readonly escalation: string;
  readonly ask: Ask;
  /** The Architect's step and the dispatch whose hand-back this is (null: the step ended without one). */
  readonly step: string;
  readonly dispatch: string | null;
  /** `failed`: the step ended without a usable hand-back (the program's record, not the Architect's). */
  readonly reply: ArchitectReply | 'failed';
  /** The answer; what must change; the Architect's question; or why the step failed. */
  readonly text: string;
  /** plan-must-change: why. */
  readonly why?: string;
  /** answer: other tasks of the plan it names (printed on their cards too, G3). */
  readonly tasks?: readonly string[];
  /** Set when the ask was no longer current at the write: why. The reply is kept and changes nothing. */
  readonly moot?: string;
}

/** An event as the flow and the claim read them (the secretary line's; `revision` orders them). */
type Ev = { readonly event: string; readonly key: string; readonly body: unknown; readonly revision?: number };

/**
 * 4.4 (G1, review p11-2): the revision of the Secretary round an Architect's reply reopened (its retry names the
 * reply: `architect`), when no PM answer came after it; null otherwise. From that round on the escalation is the
 * Secretary's again: the PM's earlier rounds and an earlier hand-up do not shut it out (a later PM answer does).
 */
export function reopenedAt(sec: readonly Ev[], escalation: string): number | null {
  const mark = reopenMark(sec, escalation);
  return mark === undefined ? null : (mark.revision ?? 0);
}

/** The retry that reopened the escalation's current Secretary round (reopenedAt), or undefined. */
function reopenMark(sec: readonly Ev[], escalation: string): Ev | undefined {
  const mark = sec.filter((e) => e.event === 'secretary-retry' && (e.body as { id?: unknown; architect?: unknown }).id === escalation && typeof (e.body as { architect?: unknown }).architect === 'string').at(-1);
  if (mark === undefined) return undefined;
  const at = mark.revision ?? 0;
  return sec.some((e) => e.event === 'pm-answer' && e.key.startsWith(`${escalation}#`) && (e.revision ?? 0) > at) ? undefined : mark;
}

/**
 * 4.4 (G1, review p11-r2-2): the key of the hand-up (event "to-user") of the escalation's current round: its id, or,
 * in a round an Architect's reply reopened, that round's key (`<id>#<n>`, its retry's). A hand-up is written once per
 * round: one from before the reopen stays on the record and does not stand for the reopened round's.
 */
export function handUpKey(sec: readonly Ev[], escalation: string): string {
  return reopenMark(sec, escalation)?.key ?? escalation;
}

/**
 * The hand-up in effect on the escalation's current round, or undefined: in a reopened round, that round's own;
 * otherwise any (the latest). Read from the secretary line's retries, PM answers and hand-ups.
 */
export function currentHandUp(sec: readonly Ev[], escalation: string): Ev | undefined {
  const mark = reopenMark(sec, escalation);
  if (mark !== undefined) return sec.find((e) => e.event === 'to-user' && e.key === mark.key);
  return sec.filter((e) => e.event === 'to-user' && (e.key === escalation || e.key.startsWith(`${escalation}#`))).at(-1);
}

/** The PM's current answer round on an escalation: its rounds closed so far, plus one (flow/secretary.ts pmAnswerRound). */
export function pmRoundOf(sec: readonly Ev[], escalation: string): number {
  return sec.filter((e) => e.event === 'pm-answer-rejected' && e.key.startsWith(`${escalation}#`)).length + 1;
}

/** The ask a decision event makes, or null (not an ask). */
export function askOf(e: Ev): Ask | null {
  const b = e.body as { option?: unknown; escalation?: unknown; answerRound?: unknown; by?: unknown };
  if (b.option !== 'ask-architect' || typeof b.escalation !== 'string') return null;
  if (e.event === 'pm-answer') return typeof b.answerRound === 'number' ? { escalation: b.escalation, by: 'pm', round: b.answerRound } : null;
  if (e.event !== 'decision' || b.by !== 'secretary') return null;
  const n = e.key === b.escalation ? 0 : Number(e.key.slice(b.escalation.length + 1));
  return Number.isSafeInteger(n) ? { escalation: b.escalation, by: 'secretary', round: n } : null;
}

/**
 * Why an ask is no longer the decision in effect on its escalation, or null (it is), from the secretary
 * line's events: as decisionFor selects (the user's answer, then the PM's current round, then the
 * Secretary's current round). Read the same way by the flow (before it records a reply) and the claim.
 */
export function askStanding(sec: readonly Ev[], a: Ask): string | null {
  const id = a.escalation;
  const at = (event: string, key: string): Ev | undefined => sec.find((e) => e.event === event && e.key === key);
  const applied = at('applied', id)?.body as { what?: { option?: unknown; why?: unknown }; by?: unknown } | undefined;
  if (applied !== undefined) {
    if (applied.what?.option === 'superseded') return `escalation ${id} was closed: ${typeof applied.what.why === 'string' ? applied.what.why : 'the work it was about changed'}`;
    return `escalation ${id} was carried out (${String(applied.what?.option ?? 'decided')}${typeof applied.by === 'string' ? ` by ${applied.by === 'pm' ? 'the PM' : applied.by === 'user' ? 'the user' : 'the Secretary'}` : ''})`;
  }
  if (at('user-answer', id) !== undefined) return `the user answered escalation ${id}`;
  if (a.by === 'pm') {
    const rejected = at('pm-answer-rejected', `${id}#${a.round}`)?.body as { why?: unknown } | undefined;
    return rejected === undefined ? null : `the PM's answer round ${a.round} on ${id} was closed (${typeof rejected.why === 'string' ? rejected.why.slice(0, 200) : 'rejected'})`;
  }
  // a Secretary round an Architect's reply reopened after the PM's round is the Secretary's: only what came after it counts
  const since = reopenedAt(sec, id) ?? -1;
  if (sec.some((e) => e.event === 'pm-answer' && e.key.startsWith(`${id}#`) && (e.revision ?? 0) > since)) return `the PM answered escalation ${id}`;
  if (currentHandUp(sec, id) !== undefined) return `escalation ${id} was handed to the PM`;
  if (at('secretary-retry', `${id}#${a.round + 1}`) !== undefined) return `the Secretary's round ${a.round} on ${id} was closed by a newer round`;
  return null;
}

/**
 * 4.4 (G1, review p11-5): the effective Architect answer of an escalation: on a kind carried out as an answer, the
 * one carried out; on a used-up loop, the latest answer recorded and not moot (a later answer corrects an earlier
 * one; the earlier replies stay in the escalation's history). Null: none.
 */
export function effectiveAnswer(sec: readonly Ev[], escalation: string, source: string): (ArchitectAnswerBody & { readonly key: string }) | null {
  if (answersInPlace(source)) return carriedArchitectAnswer(sec, escalation);
  const last = sec.filter((e) => e.event === ARCHITECT_ANSWER && (e.body as ArchitectAnswerBody).escalation === escalation && (e.body as ArchitectAnswerBody).reply === 'answer' && (e.body as ArchitectAnswerBody).moot === undefined).at(-1);
  return last === undefined ? null : { ...(last.body as ArchitectAnswerBody), key: last.key };
}

/** The Architect's reply carried out as an escalation's answer (its applied record names it), or null. */
export function carriedArchitectAnswer(sec: readonly Ev[], escalation: string): (ArchitectAnswerBody & { readonly key: string }) | null {
  const applied = sec.find((e) => e.event === 'applied' && e.key === escalation)?.body as { what?: { option?: unknown }; architect?: unknown } | undefined;
  if (applied?.what?.option !== 'answer' || typeof applied.architect !== 'string') return null;
  const key = applied.architect;
  const a = sec.find((e) => e.event === ARCHITECT_ANSWER && e.key === key)?.body as ArchitectAnswerBody | undefined;
  return a === undefined ? null : { ...a, key };
}

/** The replies recorded on one escalation, oldest first. */
export function repliesOn(sec: readonly Ev[], escalation: string): Array<ArchitectAnswerBody & { readonly key: string }> {
  return sec.filter((e) => e.event === ARCHITECT_ANSWER && (e.body as ArchitectAnswerBody).escalation === escalation).map((e) => ({ ...(e.body as ArchitectAnswerBody), key: e.key }));
}

/** The earlier replies on an escalation as the answer card lists them (built alike at queue time and at the claim). */
export function earlierReplies(sec: readonly Ev[], escalation: string): Array<{ step: string; reply: string; text: string }> {
  return repliesOn(sec, escalation).map((x) => ({ step: x.step, reply: x.reply, text: x.reply === 'plan-must-change' ? `${x.text} (why: ${x.why ?? ''})` : x.text }));
}

/** One reply as a decider reads it on the escalation's next round (the round's reasons) or in the PM's inbox. */
export function replyText(b: Pick<ArchitectAnswerBody, 'reply' | 'text' | 'why' | 'step'>, kindAnswers: boolean): string {
  switch (b.reply) {
    case 'answer':
      return `The Architect (step ${b.step}) answered: ${b.text}${kindAnswers ? '' : ' A grant carries this answer to the next attempt; or choose another option.'}`;
    case 'plan-must-change':
      return `The Architect (step ${b.step}) says the plan has to change. What: ${b.text} Why: ${b.why ?? ''} Choose replan, or ask-pm where the change is of the PM's class.`;
    case 'need-to-know':
      return `The Architect (step ${b.step}) needs to know this first: ${b.text} Give it in your instructions and ask the Architect again, or choose another option.`;
    case 'failed':
      return `The Architect's step ${b.step} ended without a usable reply (${b.text}). Choose another option, or ask the Architect again.`;
  }
}
