// 4.4 (F9, issue 62): what became of a Secretary decision handed back. `mp sec decide` and the
// seat way (`mp seat <D> handback` of a decision step) record the hand-back and run the same flow
// step, and both say what happened: carried out, sent to the PM, closed, or left to the next pass
// with the reason.

import type { Db } from '../memory/index.ts';
import { SECRETARY_LINE } from '../flow/plandoc.ts';
import { isAskOption } from '../seat/cards/secretary.ts';

export interface DecisionOutcome {
  readonly escalation: string;
  readonly mission: string;
  /** applied: carried out; to-pm: waits for the PM's answer; closed: the escalation closed without it; overridden: another decider's answer was carried out; pending: a later pass applies it. */
  readonly state: 'applied' | 'to-pm' | 'closed' | 'overridden' | 'pending';
  readonly text: string;
}

type Texts = { text(hash: string): string };

function secretaryEvent(db: Db, data: Texts, mission: string, event: string, key: string): Record<string, any> | null {
  const row = db.stmt('SELECT body FROM flow_events WHERE mission = ? AND line = ? AND event = ? AND key = ? ORDER BY revision LIMIT 1').get(mission, SECRETARY_LINE, event, key) as { body: string } | undefined;
  return row === undefined ? null : (JSON.parse(data.text(row.body)) as Record<string, any>);
}

/**
 * 4.4 (F9): what became of the answer `mp pm answer` just recorded: `round` is the PM answer round that
 * command wrote (null for the user's answer). "applied" only when the applied record is of this very answer
 * (its decider, its round, its option) and its recorded effect is the one asked for; anything else is said as
 * the record has it, with the read that shows it. Never inferred from the command.
 */
export function answerOutcome(db: Db, data: Texts, o: { readonly mission: string; readonly escalation: string; readonly by: 'pm' | 'user'; readonly round: number | null; readonly option: string; readonly resident: boolean }): { readonly applied: boolean; readonly text: string } {
  const read = `mp read show decision ${o.mission}/${o.escalation}`;
  const rejected = o.by === 'pm' && o.round !== null && secretaryEvent(db, data, o.mission, 'pm-answer-rejected', `${o.escalation}#${o.round}`) !== null;
  const ours = rejected ? `round ${String(o.round)} was rejected, the words it rested on changed; ` : '';
  const applied = secretaryEvent(db, data, o.mission, 'applied', o.escalation);
  if (applied !== null) {
    const what = (applied['what'] ?? {}) as { option?: unknown; why?: unknown; moot?: unknown; restarted?: unknown };
    if (what.option === 'superseded') return { applied: false, text: `not carried out: ${ours}escalation ${o.escalation} was closed (${typeof what.why === 'string' ? what.why : 'the work it was about changed'}); ${read}` };
    const by = applied['by'];
    // what was carried out: the applied record's option (a restart records what it restarted)
    const effect = typeof what.option === 'string' ? what.option : what.restarted !== undefined ? 'restart' : null;
    const same = effect !== null && (effect === o.option || (isAskOption(effect) && isAskOption(o.option)));
    const mine = by === o.by && (o.by === 'user' || applied['answerRound'] === o.round) && same;
    if (mine && what.moot !== true) return { applied: true, text: 'applied' };
    if (mine) return { applied: false, text: `carried out as moot: ${o.option} had nothing left to act on when it was applied (its notice says why); ${read}` };
    const who = by === 'user' ? 'the user\'s answer' : by === 'pm' ? `the PM's answer of round ${String(applied['answerRound'])}` : 'the Secretary\'s decision';
    return { applied: false, text: `not carried out: ${ours}${who} (${effect ?? 'its option'}${what.moot === true ? ', moot' : ''}) was carried out instead; ${read}` };
  }
  if (rejected) return { applied: false, text: `not carried out: ${ours}the inbox asks again in round ${String((o.round ?? 0) + 1)}; ${read}` };
  const userFirst = o.by === 'pm' && secretaryEvent(db, data, o.mission, 'user-answer', o.escalation) !== null ? '; the user\'s answer, recorded too, takes precedence' : '';
  return { applied: false, text: `${o.resident ? 'the Secretary’s next pass applies it' : 'the flow applies it when its work can move (mp pm next)'}${userFirst}` };
}

/** The decision round a Secretary step answers: `sec.<id>` is the escalation's own key, a retry step its `<id>#n`. */
export function roundKeyOf(db: Db, data: Texts, mission: string, escalation: string, task: string): string {
  const rows = db.stmt("SELECT key, body FROM flow_events WHERE mission = ? AND line = ? AND event = 'secretary-retry' ORDER BY revision").all(mission, SECRETARY_LINE) as { key: string; body: string }[];
  return rows.map((r) => ({ key: r.key, body: JSON.parse(data.text(r.body)) as { id?: string; task?: string } })).find((r) => r.body.id === escalation && r.body.task === task)?.key ?? escalation;
}

/**
 * The outcome of an accepted Secretary hand-back after its pass (`why`: why no pass ran or what
 * stopped it, null when it ran). Read from the record, never assumed from the command.
 */
export function decisionOutcome(db: Db, data: Texts, o: { readonly mission: string; readonly escalation: string; readonly task: string; readonly fields: unknown; readonly why: string | null }): DecisionOutcome {
  const base = { escalation: o.escalation, mission: o.mission };
  const later = o.why ?? 'the flow did not carry it out in this pass';
  const applied = secretaryEvent(db, data, o.mission, 'applied', o.escalation);
  if (applied !== null) {
    const what = (applied['what'] ?? {}) as { option?: unknown; why?: unknown };
    if (what.option === 'superseded') return { ...base, state: 'closed', text: `recorded; escalation ${o.escalation} was closed without it: ${typeof what.why === 'string' ? what.why : 'the work it was about changed'}` };
    const by = applied['by'];
    return by === 'secretary' ? { ...base, state: 'applied', text: `recorded and applied (${String(what.option ?? '')})` } : { ...base, state: 'overridden', text: `recorded; the ${by === 'pm' ? 'PM' : 'user'}'s answer was applied instead (${String(what.option ?? '')})` };
  }
  // 4.4 (F9): the flow may hand a decision on to the PM (a grant the ledger refuses, restarts used up): with the reason it recorded
  const toUser = secretaryEvent(db, data, o.mission, 'to-user', o.escalation);
  if (toUser !== null) return { ...base, state: 'to-pm', text: `recorded; the flow handed it to the PM (mp pm inbox lists it): ${String(toUser['why'] ?? '')}` };
  const key = roundKeyOf(db, data, o.mission, o.escalation, o.task);
  const rejected = secretaryEvent(db, data, o.mission, 'decision-rejected', key);
  if (rejected !== null) return { ...base, state: 'pending', text: `recorded; not carried out: ${String(rejected['why'] ?? '')} A fresh round is queued (mp sec card ${o.escalation}).` };
  const decided = secretaryEvent(db, data, o.mission, 'decision', key);
  const f = (decided ?? o.fields ?? {}) as { option?: unknown; classification?: unknown };
  const toPm = (typeof f.option === 'string' && isAskOption(f.option)) || f.classification === 'needs-pm' || f.classification === 'needs-user';
  if (toPm) return { ...base, state: 'to-pm', text: `recorded; sent to the PM (mp pm inbox lists it); only the work it is about waits${decided === null ? `; ${later}, and the next pass records the decision` : ''}` };
  return { ...base, state: 'pending', text: `recorded; the next pass applies it: ${later}` };
}
