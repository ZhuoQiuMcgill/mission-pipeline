// 4.4 (F4; PM design G5, "A question put off stays open"): open items of kind `question`. A Constructor's
// question that its hand-back raises as `later`, or that the answer to its escalation puts off, is an
// open item from that moment, whether or not the task is later accepted with risk. Nobody assigns it:
// the decider its escalation belongs to under F-3 (the Secretary within the plan, the PM for its class)
// answers it at any time, and the answer goes onto the task's next cards; until then the open question
// is listed on every card of the task (taskQuestions), through rework and acceptance.
//
// The record is small, and flow/riskItems.ts extends it (the items of an acceptance with risk, kinds other than `question`):
//   line "open-items", event "open-item", key <id>: {id, kind, text, task, attempt, escalation, question, when, why}
//   line "open-items", event "open-item-answer", key <id>: {id, by, answer, words?}
// A 4.3 memory has neither: every question of its escalations reads as before-review, answered by the
// escalation's answer once it is carried out.

import type { QuestionWhen } from '../seat/results.ts';
import type { DecisionBody, EscalationBody } from './secretary.ts';

export const OPEN_ITEMS_LINE = 'open-items';
export const OPEN_ITEM = 'open-item';
export const OPEN_ITEM_ANSWER = 'open-item-answer';

export interface OpenItemBody {
  readonly id: string;
  readonly kind: 'question';
  readonly text: string;
  readonly task: string;
  readonly attempt: number;
  readonly escalation: string;
  /** The question's number on its escalation (1-based, as its reasons list them). */
  readonly question: number;
  readonly when: QuestionWhen;
  /** later: the hand-back raised it as later; deferred: the answer to its escalation put it off. */
  readonly why: 'later' | 'deferred';
}

export interface OpenItemAnswerBody {
  readonly id: string;
  /** Who answered: the Secretary or the PM (`open-item-answer`); the user, for an answer carried out on the escalation (openItemsOf). */
  readonly by: 'secretary' | 'pm' | 'user';
  readonly answer: string;
  readonly words?: string;
}

export interface OpenItem extends OpenItemBody {
  readonly revision: number;
  readonly answer: OpenItemAnswerBody | null;
  /** 4.4 (review r2-1): an answer recorded to the item that the escalation's carried-out answer took precedence over. */
  readonly superseded?: OpenItemAnswerBody;
}

/** An event as the flow and the claim read it. */
type Ev = { readonly revision: number; readonly line: string; readonly event: string; readonly key: string; readonly body: unknown };

/** The id of the open item a question of an escalation becomes (deterministic: raised again, it is the same item). */
export const openItemId = (escalation: string, n: number): string => `${escalation}.q${n}`;

/** The questions of a Constructor's escalation, numbered, with when each must be settled (an escalation raised by 4.3: before-review). */
export function escalationQuestions(e: Pick<EscalationBody, 'source' | 'facts'>): Array<{ readonly n: number; readonly text: string; readonly when: QuestionWhen }> {
  if (e.source !== 'constructor-decision') return [];
  const f = (e.facts ?? {}) as { questions?: unknown; when?: unknown };
  const qs = Array.isArray(f.questions) ? f.questions.filter((q): q is string => typeof q === 'string') : [];
  const when = Array.isArray(f.when) ? f.when : [];
  return qs.map((text, i) => ({ n: i + 1, text, when: when[i] === 'later' ? 'later' as const : 'before-review' as const }));
}

/** An escalation's reasons for its questions: numbered, so an answer can put one off by its number. */
export function questionReasons(qs: ReadonlyArray<{ readonly text: string; readonly when: QuestionWhen }>): string[] {
  return qs.map((q, i) => `Q${i + 1} (${q.when}): ${q.text}`);
}

/**
 * The open items of a mission's events, each with its answer. A question put off by a decision that was
 * not carried out is answered by the escalation's answer that was carried out whenever that answer covers
 * it (it does not put it off): the decision carried out takes precedence over an answer recorded to the
 * item before it, in either order (the user's words win over the PM's earlier answer). Otherwise the
 * item's own answer (`open-item-answer`); a `later` question is never covered by its escalation's answer.
 */
export function openItemsOf(events: readonly Ev[]): OpenItem[] {
  const answers = new Map(events.filter((e) => e.line === OPEN_ITEMS_LINE && e.event === OPEN_ITEM_ANSWER).map((e) => [e.key, e.body as OpenItemAnswerBody]));
  const sec = events.filter((e) => e.line === 'secretary');
  // 4.4 (G5): the items an acceptance with risk or a deferral left share the line; they are read by flow/riskItems.ts
  return events.filter((e) => e.line === OPEN_ITEMS_LINE && e.event === OPEN_ITEM && (e.body as { kind?: unknown }).kind === 'question').map((e) => {
    const b = e.body as OpenItemBody;
    const own = answers.get(e.key) ?? null;
    const carried = b.why !== 'deferred' ? null : appliedAnswer(sec, b.escalation);
    if (carried !== null && !carried.defer.includes(b.question)) {
      const answer: OpenItemAnswerBody = { id: b.id, by: carried.by as OpenItemAnswerBody['by'], answer: carried.text };
      return { ...b, revision: e.revision, answer, ...(own !== null ? { superseded: own } : {}) };
    }
    return { ...b, revision: e.revision, answer: own };
  });
}

/**
 * 4.4 (F4): the text of an answer: its instructions; where there are none (a user's answer may give only
 * the words it rests on), the user's cited words, quoted with the entry's id.
 */
export function answerText(d: Pick<DecisionBody, 'instructions' | 'by' | 'reason'>): string {
  if (d.instructions.trim() !== '') return d.instructions;
  const w = /^([\s\S]*) \((W-[0-9]+)\)\s*$/.exec(d.reason);
  return w === null ? d.reason : `"${w[1]!.trim()}" (the user's words ${w[2]})`;
}

/**
 * The answer an escalation's carried-out decision gave, when it was an answer: its text, who gave it,
 * and the questions it put off (the decision in effect, as the cards read it: the user's, else the PM's
 * last round not rejected, else the Secretary's last round). Null: not carried out as an answer.
 */
export function appliedAnswer(sec: readonly Ev[], escalation: string): { readonly text: string; readonly by: string; readonly defer: readonly number[] } | null {
  const applied = sec.find((a) => a.line === 'secretary' && a.event === 'applied' && a.key === escalation)?.body as { what?: { option?: string }; by?: string } | undefined;
  if (applied?.what?.option !== 'answer') return null;
  const answers = sec.filter((a) => a.line === 'secretary' && ((a.event === 'user-answer' && a.key === escalation) || ((a.event === 'decision' || a.event === 'pm-answer') && (a.body as DecisionBody).escalation === escalation && !sec.some((r) => r.event === 'pm-answer-rejected' && r.key === a.key))));
  const d = (answers.find((a) => a.event === 'user-answer') ?? answers.filter((a) => a.event === 'pm-answer').at(-1) ?? answers.at(-1))?.body as DecisionBody | undefined;
  if (d?.option !== 'answer' || d.by !== applied.by) return null;
  return { text: answerText(d), by: d.by, defer: d.defer ?? [] };
}

/**
 * Who answers an open item under F-3, as its escalation's class says: the PM when the PM or the user
 * decided the escalation or it was sent to them; otherwise the Secretary. `handedUp`: whether the
 * Secretary's accepted hand-back of the escalation's current round sent it to the PM (the inbox's check,
 * before a pass writes the decision event; process/openItems.ts reads it in the answer's write).
 */
export function itemDecider(events: readonly Ev[], item: Pick<OpenItemBody, 'escalation'>, handedUp: (escalation: string) => boolean = () => false): 'secretary' | 'pm' {
  const esc = item.escalation;
  const sec = events.filter((e) => e.line === 'secretary');
  const applied = sec.find((e) => e.event === 'applied' && e.key === esc)?.body as { by?: string } | undefined;
  if (applied?.by === 'secretary') return 'secretary';
  if (applied?.by === 'pm' || applied?.by === 'user') return 'pm';
  const sentUp = sec.some((e) =>
    (e.event === 'user-answer' && e.key === esc) || (e.event === 'to-user' && e.key === esc) ||
    ((e.event === 'pm-answer' || e.event === 'decision') && (e.body as DecisionBody).escalation === esc && (e.event === 'pm-answer' || ['needs-pm', 'needs-user'].includes((e.body as DecisionBody).classification))));
  return sentUp || handedUp(esc) ? 'pm' : 'secretary';
}

/** 4.4 (F4; G5): the open items of a hand-back's "later" questions: recorded with the accepted hand-back, and again (the same ids and bodies) by the flow. */
export function laterItemBodies(task: string, attempt: number, escalation: string, qs: ReadonlyArray<{ readonly text: string; readonly when: QuestionWhen }>): OpenItemBody[] {
  return qs.flatMap((q, i) => (q.when !== 'later' ? [] : [{ id: openItemId(escalation, i + 1), kind: 'question' as const, text: q.text, task, attempt, escalation, question: i + 1, when: 'later' as const, why: 'later' as const }]));
}

/** 4.4 (F4; G5): the open items a decision puts off (`defer`): recorded with the decision, and again (the same ids and bodies) when it is carried out. */
export function deferredItemBodies(e: Pick<EscalationBody, 'id' | 'source' | 'facts' | 'subject'>, defer: readonly number[]): OpenItemBody[] {
  const task = e.subject.startsWith('task:') ? e.subject.slice('task:'.length) : null;
  const facts = (e.facts ?? {}) as { attempt?: unknown; blocked?: unknown };
  const attempt = facts.attempt;
  // a pause's questions are all needed before the work resumes: none is put off (review r2, p8-7)
  if (task === null || typeof attempt !== 'number' || defer.length === 0 || facts.blocked === true) return [];
  return escalationQuestions(e).filter((q) => defer.includes(q.n) && q.when !== 'later').map((q) => ({ id: openItemId(e.id, q.n), kind: 'question' as const, text: q.text, task, attempt, escalation: e.id, question: q.n, when: q.when, why: 'deferred' as const }));
}

/** A Constructor's question as a card shows it. */
export interface TaskQuestion {
  readonly escalation: string;
  readonly n: number;
  readonly attempt: number;
  readonly text: string;
  readonly when: QuestionWhen;
  /** answered; open: an open item not answered yet; waiting: its escalation is not decided and carried out yet. */
  readonly state: 'answered' | 'open' | 'waiting';
  readonly answer?: string;
  readonly by?: string;
  /** The open item it is, if it is one. */
  readonly item?: string;
}

/** The questions as a card carries them (seat/card.ts `questions`): an open item by its id, another by its escalation and number. */
export function cardQuestions(qs: readonly TaskQuestion[]): Array<{ id: string; attempt: number; text: string; when: QuestionWhen; state: TaskQuestion['state']; answer?: string; by?: string }> {
  return qs.map((q) => ({ id: q.item ?? `${q.escalation}#${q.n}`, attempt: q.attempt, text: q.text, when: q.when, state: q.state, ...(q.answer !== undefined ? { answer: q.answer } : {}), ...(q.by !== undefined ? { by: q.by } : {}) }));
}

/** A card's verbatim decisions without the answers its questions show (each answer is printed once). */
export function withoutAnswers(quotes: readonly string[], qs: readonly TaskQuestion[]): string[] {
  const shown = new Set(qs.flatMap((q) => (q.answer !== undefined ? [q.answer] : [])));
  return quotes.filter((x) => !shown.has(x));
}

/**
 * The Constructor's questions on a task for a card of attempt `attempt`: every question of that
 * attempt's escalations (its pauses, and its hand-back with a product) not closed otherwise, and every
 * question of the task that is an open item, answered or not (its answer reaches the next cards). Pure:
 * the queue-time builders and the claim use it.
 */
export function taskQuestions(events: readonly Ev[], task: string, attempt: number): TaskQuestion[] {
  const sec = events.filter((e) => e.line === 'secretary');
  const items = new Map(openItemsOf(events).filter((i) => i.task === task).map((i) => [`${i.escalation}#${i.question}`, i]));
  const out: TaskQuestion[] = [];
  const shown = new Set<string>();
  const ofItem = (i: OpenItem): TaskQuestion => {
    shown.add(i.id);
    const base = { escalation: i.escalation, n: i.question, attempt: i.attempt, text: i.text, when: i.when, item: i.id };
    return i.answer !== null ? { ...base, state: 'answered', answer: i.answer.answer, by: i.answer.by } : { ...base, state: 'open' };
  };
  for (const e of sec) {
    if (e.event !== 'escalation') continue;
    const esc = e.body as EscalationBody;
    if (esc.subject !== `task:${task}` || esc.source !== 'constructor-decision') continue;
    const k = ((esc.facts ?? {}) as { attempt?: unknown }).attempt;
    if (typeof k !== 'number') continue;
    const qs = escalationQuestions(esc);
    if (qs.length === 0) continue;
    const applied = sec.some((a) => a.event === 'applied' && a.key === esc.id);
    const answer = applied ? appliedAnswer(sec, esc.id) : null;
    for (const q of qs) {
      const item = items.get(`${esc.id}#${q.n}`);
      if (item === undefined && k !== attempt) continue;
      const base = { escalation: esc.id, n: q.n, attempt: k, text: q.text, when: q.when };
      if (item !== undefined) out.push(ofItem(item));
      else if (answer !== null) out.push({ ...base, state: 'answered', answer: answer.text, by: answer.by });
      // carried out otherwise (closed, re-planned): not a question of this card any more
      else if (!applied) out.push({ ...base, state: 'waiting' });
    }
  }
  // 4.4 (F4, G5): an item with no escalation (a hand-back whose questions are all "later" raises none)
  for (const i of items.values()) if (!shown.has(i.id)) out.push(ofItem(i));
  return out;
}
