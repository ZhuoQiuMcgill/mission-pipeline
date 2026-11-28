// 4.4 (F4, problem P3): a review waits for the answer to its Constructor's questions. The review of an
// attempt is not ready while a before-review question of that attempt is unanswered or its answer is not
// carried out: its escalation (constructor-decision, raised with the product it is about) has not been
// carried out as an answer. Any other outcome (a re-plan, a close as superseded, an answer not carried out
// yet) leaves the question unanswered, and the review stays held until the work that retires its step (a
// new card, a next attempt, a drop or a giving-up) cancels it. `mp pm next` lists the step as held with
// the escalation named, and the claim checks the same condition again in its own write, as a closed
// mission is checked (process/pm.ts). The wait is not a hold record: nothing is written.
//
// A question of an escalation raised by 4.3 carries no mark and reads as before-review.

import { flowEvents, type Db } from '../memory/index.ts';
import type { MissionId } from '../common/ids.ts';
import { escalationQuestions } from '../flow/openItems.ts';
import { SECRETARY_LINE } from '../flow/plandoc.ts';
import type { EscalationBody } from '../flow/secretary.ts';
import type { TaskSpecDoc } from './ports.ts';

interface QuestionHold {
  readonly escalation: string;
  readonly attempt: number | null;
  readonly task: string | null;
  /** The option it was carried out with when that was not an answer (replan, superseded), else null. */
  readonly carried: string | null;
}

/** The escalations of a mission that hold the review of a product (a Constructor's before-review questions not answered), by product. */
export function openQuestionHolds(db: Db, data: { text(h: string): string }, mission: string): Map<string, QuestionHold[]> {
  const out = new Map<string, QuestionHold[]>();
  const one = (line: string, event: string, key: string): unknown => {
    const r = db.stmt('SELECT body FROM flow_events WHERE mission = ? AND line = ? AND event = ? AND key = ?').get(mission, line, event, key) as { body: string } | undefined;
    return r === undefined ? null : JSON.parse(data.text(r.body));
  };
  for (let after = 0; ; ) {
    const page = flowEvents(db, { mission: mission as MissionId, line: SECRETARY_LINE, event: 'escalation', after, limit: 1000 });
    for (const e of page) {
      // the flow names a Constructor's questions with its product "cdec.<step>"; no other body is read
      if (!e.key.startsWith('cdec.')) continue;
      const applied = one(SECRETARY_LINE, 'applied', e.key) as { what?: { option?: unknown } } | null;
      // carried out as an answer: the questions are answered (those it put off are open items, and hold nothing)
      if (applied?.what?.option === 'answer') continue;
      const esc = JSON.parse(data.text(e.body)) as EscalationBody;
      const facts = (esc.facts ?? {}) as { product?: unknown; attempt?: unknown; task?: unknown };
      if (typeof facts.product !== 'string' || !escalationQuestions(esc).some((q) => q.when === 'before-review')) continue;
      // a product accepted already (under 4.3, whose questions held nothing; at its own attempt, or adopted at a
      // later one by a ruling) is past its review: its later reviews (a re-review, a re-bind) do not wait for a
      // question 4.3 left open; its cards still list it
      if (typeof facts.task === 'string' && flowEvents(db, { mission: mission as MissionId, line: `task:${facts.task}`, event: 'accepted', limit: 10_000 }).some((a) => (JSON.parse(data.text(a.body)) as { product?: unknown }).product === facts.product)) continue;
      const list = out.get(facts.product) ?? [];
      const option = applied?.what?.option;
      list.push({ escalation: esc.id, attempt: typeof facts.attempt === 'number' ? facts.attempt : null, task: typeof facts.task === 'string' ? facts.task : null, carried: applied === null ? null : typeof option === 'string' ? option : 'closed' });
      out.set(facts.product, list);
    }
    if (page.length < 1000) return out;
    after = Number(page.at(-1)!.revision);
  }
}

/** Why a queued Reviewer step waits for its Constructor's questions, or null (it does not): the one condition of the ready list and the claim. `holds`: the mission's, read once per report. */
export function heldForQuestions(db: Db, data: { text(h: string): string }, spec: TaskSpecDoc, holds?: ReturnType<typeof openQuestionHolds>): string | null {
  if (spec.card.seat !== 'reviewer') return null;
  const target = (spec.card as { target?: unknown }).target;
  if (typeof target !== 'string') return null;
  const waits = (holds ?? openQuestionHolds(db, data, spec.mission)).get(target) ?? [];
  if (waits.length === 0) return null;
  const w = waits[0]!;
  const why = waits.map((x) => (x.carried === null ? `escalation ${x.escalation} is not answered and carried out yet` : `escalation ${x.escalation} was carried out without an answer (${x.carried}): the review waits until that work retires it`)).join('; ');
  return `the review waits for the answer to the Constructor's questions${w.task !== null ? ` on task ${w.task}${w.attempt !== null ? ` (attempt ${w.attempt})` : ''}` : ''}: ${why}`;
}
