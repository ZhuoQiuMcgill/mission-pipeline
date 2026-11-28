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
 * is the decider's): its Architect's answer is recorded and the escalation goes back to the decider.
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

/** An event as the flow and the claim read them. */
type Ev = { readonly event: string; readonly key: string; readonly body: unknown };

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
  if (sec.some((e) => e.event === 'pm-answer' && e.key.startsWith(`${id}#`))) return `the PM answered escalation ${id}`;
  if (at('to-user', id) !== undefined) return `escalation ${id} was handed to the PM`;
  if (at('secretary-retry', `${id}#${a.round + 1}`) !== undefined) return `the Secretary's round ${a.round} on ${id} was closed by a newer round`;
  return null;
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
