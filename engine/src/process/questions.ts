// 4.4 (F4, problem P3): a review waits for the answer to its Constructor's questions. The review of an
// attempt is not ready while a before-review question of that attempt is unanswered or its answer is not
// carried out: its escalation (constructor-decision, raised with the product it is about) has no
// "applied" event. `mp pm next` lists the step as held with the escalation named, and the claim checks
// it again in its own write, as a closed mission is checked (process/pm.ts). The wait is not a hold
// record: nothing is written, and it ends when the escalation is carried out (or closed).
//
// A question of an escalation raised by 4.3 carries no mark and reads as before-review.

import { flowEventExists, flowEvents, type Db } from '../memory/index.ts';
import type { MissionId } from '../common/ids.ts';
import { escalationQuestions } from '../flow/openItems.ts';
import { SECRETARY_LINE } from '../flow/plandoc.ts';
import type { EscalationBody } from '../flow/secretary.ts';
import type { TaskSpecDoc } from './ports.ts';

/** The escalations of a mission that hold the review of a product (a Constructor's before-review questions, not carried out), by product. */
export function openQuestionHolds(db: Db, data: { text(h: string): string }, mission: string): Map<string, Array<{ readonly escalation: string; readonly attempt: number | null; readonly task: string | null }>> {
  const out = new Map<string, Array<{ escalation: string; attempt: number | null; task: string | null }>>();
  for (let after = 0; ; ) {
    const page = flowEvents(db, { mission: mission as MissionId, line: SECRETARY_LINE, event: 'escalation', after, limit: 1000 });
    for (const e of page) {
      // the flow names a Constructor's questions with its product "cdec.<step>"; no other body is read
      if (!e.key.startsWith('cdec.')) continue;
      if (flowEventExists(db, { mission, line: SECRETARY_LINE, event: 'applied', key: e.key })) continue;
      const esc = JSON.parse(data.text(e.body)) as EscalationBody;
      const facts = (esc.facts ?? {}) as { product?: unknown; attempt?: unknown; task?: unknown };
      if (typeof facts.product !== 'string' || !escalationQuestions(esc).some((q) => q.when === 'before-review')) continue;
      // an attempt accepted already (under 4.3, whose questions held nothing) is past its review: its later
      // reviews (a re-review, a re-bind) do not wait for a question 4.3 left open; its cards still list it
      if (typeof facts.task === 'string' && typeof facts.attempt === 'number' && flowEventExists(db, { mission, line: `task:${facts.task}`, event: 'accepted', key: String(facts.attempt) })) continue;
      const list = out.get(facts.product) ?? [];
      list.push({ escalation: esc.id, attempt: typeof facts.attempt === 'number' ? facts.attempt : null, task: typeof facts.task === 'string' ? facts.task : null });
      out.set(facts.product, list);
    }
    if (page.length < 1000) return out;
    after = Number(page.at(-1)!.revision);
  }
}

/** Why a queued Reviewer step waits for its Constructor's questions, or null (it does not). `holds`: the mission's, read once per report. */
export function heldForQuestions(db: Db, data: { text(h: string): string }, spec: TaskSpecDoc, holds?: ReturnType<typeof openQuestionHolds>): string | null {
  if (spec.card.seat !== 'reviewer') return null;
  const target = (spec.card as { target?: unknown }).target;
  if (typeof target !== 'string') return null;
  const waits = (holds ?? openQuestionHolds(db, data, spec.mission)).get(target) ?? [];
  if (waits.length === 0) return null;
  const w = waits[0]!;
  return `the review waits for the answer to the Constructor's questions${w.task !== null ? ` on task ${w.task}${w.attempt !== null ? ` (attempt ${w.attempt})` : ''}` : ''}: escalation ${waits.map((x) => x.escalation).join(', ')} is not answered and carried out yet`;
}
