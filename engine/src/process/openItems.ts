// 4.4 (F4; PM design G5): the open items of kind `question` for the PM and the Secretary. `mp read
// open-items <mission>` lists them; the decider an item belongs to under F-3 answers it at any time
// (`mp sec open-item answer`, the Secretary within the plan; `mp pm open-item answer`, the PM, which may
// answer any as the way through, R3). The answer goes onto the task's next cards (flow/openItems.ts
// taskQuestions, at the claim). Nobody assigns an item, and nothing waits for one but what its question
// was raised before (a pause, a review: those wait for the escalation, not for the item).

import { canonicalJson } from '../common/hash.ts';
import type { ContentHash, MissionId } from '../common/ids.ts';
import { OPEN_ITEM, OPEN_ITEMS_LINE, OPEN_ITEM_ANSWER, itemDecider, openItemsOf, type OpenItem, type OpenItemAnswerBody } from '../flow/openItems.ts';
import { appendRecords, flowEventExists, flowEvents, flowMissions, type Db } from '../memory/index.ts';
import { requireSecretary } from '../memory/resident.ts';
import type { EscalationBody } from '../flow/secretary.ts';
import { secretaryRoundInputs } from '../seat/cards/dynamic.ts';
import { isAskOption } from '../seat/cards/secretary.ts';
import type { ProcessContext } from './context.ts';
import { ProcessError } from './errors.ts';
import { handedBackResult } from './secretary.ts';

export interface OpenItemView extends OpenItem {
  readonly mission: string;
  /** Who answers it under F-3: the Secretary within the plan, the PM for its class. */
  readonly decider: 'secretary' | 'pm';
}

/** A mission's flow events on the lines the open items are read from, with their bodies, in one read. */
function linesOf(db: Db, data: { text(h: string): string }, mission: string) {
  const out: Array<{ revision: number; line: string; event: string; key: string; body: unknown }> = [];
  for (const line of [OPEN_ITEMS_LINE, 'secretary']) {
    for (let after = 0; ; ) {
      const page = flowEvents(db, { mission: mission as MissionId, line, after, limit: 1000 });
      for (const e of page) out.push({ revision: Number(e.revision), line: e.line, event: e.event, key: e.key, body: JSON.parse(data.text(e.body)) as unknown });
      if (page.length < 1000) break;
      after = Number(page.at(-1)!.revision);
    }
  }
  return out.sort((a, b) => a.revision - b.revision);
}

function viewsOf(db: Db, data: { text(h: string): string }, mission: string): OpenItemView[] {
  const events = linesOf(db, data, mission);
  // 4.4 (F4, p8-4): an escalation the Secretary's accepted hand-back sends to the PM is the PM's from that
  // hand-back, before a pass writes its decision: the inbox's check, read in the same snapshot or write
  const handedUp = (escalation: string): boolean => {
    const e = events.find((x) => x.line === 'secretary' && x.event === 'escalation' && x.key === escalation);
    if (e === undefined) return false;
    const r = handedBackResult(db, data, secretaryRoundInputs(e.body as EscalationBody, events as never).esc.task);
    return r !== undefined && (r.classification === 'needs-pm' || r.classification === 'needs-user' || isAskOption(r.option));
  };
  return openItemsOf(events).map((i) => ({ ...i, mission, decider: itemDecider(events, i, handedUp) }));
}

/** `mp read open-items <mission>`: every open item of the mission, oldest first, with its state and its decider (one read). */
export function listOpenItems(ctx: ProcessContext, mission: string): OpenItemView[] {
  return ctx.memory.read((db) => viewsOf(db, ctx.memory.data, mission));
}

/** The mission of an open item named `<mission>/<id>` or `<id>` (found in exactly one mission). */
function missionOf(db: Db, ref: string): { readonly mission: string; readonly id: string } {
  const slash = ref.indexOf('/');
  if (slash > 0) return { mission: ref.slice(0, slash), id: ref.slice(slash + 1) };
  const found = flowMissions(db).filter((m) => flowEventExists(db, { mission: m, line: OPEN_ITEMS_LINE, event: OPEN_ITEM, key: ref }));
  if (found.length === 1) return { mission: found[0]!, id: ref };
  if (found.length === 0) throw new ProcessError('NOT_READY', `no open item ${ref} (mp read open-items <mission> lists them)`);
  throw new ProcessError('NOT_ALLOWED', `open item ${ref} is in several missions (${found.join(', ')}): name it <mission>/${ref}`);
}

export interface AnsweredItem {
  readonly mission: string;
  readonly item: OpenItemView;
  /** The same answer was recorded before: nothing new was written. */
  readonly repeated: boolean;
}

/**
 * Answer an open item (one answer per item). `by` is who answers: the Secretary only for an item that
 * is its own under F-3; the PM for any (its words, when given, are recorded with the answer). Checked in
 * the write: the item, its state, its decider and, for the Secretary, that its generation is still live.
 * The same answer again is a no-op that says so; another answer to an answered item is refused.
 */
export function answerOpenItem(ctx: ProcessContext, req: { readonly op: string; readonly ref: string; readonly by: 'secretary' | 'pm'; readonly answer: string; readonly words?: string | null }): AnsweredItem {
  if (req.answer.trim() === '') throw new ProcessError('NOT_ALLOWED', 'give the answer (--answer "<text>")');
  const at = ctx.memory.read((db) => missionOf(db, req.ref));
  const body: OpenItemAnswerBody = { id: at.id, by: req.by, answer: req.answer, ...(req.words != null ? { words: req.words } : {}) };
  return ctx.memory.write({ op: `open-item-answer:${req.op}`, payload: { mission: at.mission, ...body } }, (tx) => {
    if (req.by === 'secretary' && ctx.secretary !== null) requireSecretary(tx, ctx.secretary);
    const item = viewsOf(tx, tx.data, at.mission).find((i) => i.id === at.id);
    if (item === undefined) throw new ProcessError('NOT_READY', `no open item ${at.id} in mission ${at.mission} (mp read open-items ${at.mission} lists them)`);
    if (item.answer !== null) {
      if (item.answer.answer === req.answer && item.answer.by === req.by) return { mission: at.mission, item, repeated: true };
      throw new ProcessError('NOT_ALLOWED', `open item ${at.id} was answered already by ${item.answer.by === 'pm' ? 'the PM' : item.answer.by === 'user' ? 'the user' : 'the Secretary'}: ${item.answer.answer}`);
    }
    // F-3: the Secretary answers within the plan; an item of the PM's class is the PM's
    if (req.by === 'secretary' && item.decider === 'pm') throw new ProcessError('NOT_ALLOWED', `open item ${at.id} is the PM's: its escalation ${item.escalation} went to the PM or the user. The PM answers it with mp pm open-item answer ${at.mission}/${at.id}`);
    appendRecords(tx, [{ kind: 'flow.event', mission: at.mission as MissionId, line: OPEN_ITEMS_LINE, event: OPEN_ITEM_ANSWER, key: at.id, body: tx.data.put(canonicalJson(body)) as ContentHash }]);
    return { mission: at.mission, item: { ...item, answer: body }, repeated: false };
  });
}
