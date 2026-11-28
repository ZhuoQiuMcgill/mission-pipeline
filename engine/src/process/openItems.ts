// 4.4 (F4; PM design G5): the open items for the PM and the Secretary. `mp read open-items <mission>` lists
// them: the Constructor's questions put off (kind `question`), and what was left at the cap (the items an
// acceptance with risk wrote, a Reviewer's deferrals, and the risk sentences of acceptances made under 4.3,
// marked as not recorded), each with its age, how often it was carried and what took it. The decider a
// question belongs to under F-3 answers it at any time (`mp sec open-item answer`, the Secretary within the
// plan; `mp pm open-item answer`, the PM, which may answer any as the way through, R3); the answer goes onto
// the task's next cards (flow/openItems.ts taskQuestions, at the claim). An item left at the cap is closed by
// the record (its task accepted with it answered fixed) or on the user's words (`mp pm open-item close`, `mp
// pm verified`). Nobody assigns an item, and nothing waits for one but what its question was raised before.

import { canonicalJson } from '../common/hash.ts';
import type { ContentHash, MissionId } from '../common/ids.ts';
import type { ObjectVersionRecord } from '../common/records.ts';
import { OPEN_ITEM, OPEN_ITEMS_LINE, OPEN_ITEM_ANSWER, itemDecider, openItemsOf, type OpenItem, type OpenItemAnswerBody } from '../flow/openItems.ts';
import { OPEN_ITEM_CLOSED, VERIFIED, VERIFIED_LINE, reopenTakers, riskItemsOf, takersOf, type ItemClosedBody, type RiskItem, type Taker, type VerifiedBody } from '../flow/riskItems.ts';
import { DetailedPlanDoc, PLAN_LINE, REPAIRS_LINE, REQUIREMENTS_LINE, amendedPlan, type AmendmentEntry, type RepairBody, type StoredDetailedPlan } from '../flow/plandoc.ts';
import { appendRecords, factById, flowEventExists, flowEvents, flowMissions, type Db } from '../memory/index.ts';
import { requireSecretary } from '../memory/resident.ts';
import { itemLine } from '../flow/requirements.ts';
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
  /** 4.4 (G5): when it was recorded (null: not known). */
  readonly at?: number | null;
}

/** 4.4 (G5): an item left at the cap or deferred, as the reads show it. */
export interface RiskItemView extends RiskItem {
  readonly mission: string;
  /** When it was recorded (for a sentence of a 4.3 acceptance: when that acceptance was), null when not known. */
  readonly at: number | null;
  /** The tasks of the plan in effect whose card takes it, and what wrote that card. */
  readonly takenBy: readonly Taker[];
  /** The repairs filed for it (`mp pm repair --open-items`). */
  readonly namedBy: readonly string[];
}

type Ev = { revision: number; line: string; event: string; key: string; body: unknown };

/** A mission's flow events with their bodies, in one read (every line: the items' outcomes are on the task lines). */
export function missionEvents(db: Db, data: { text(h: string): string }, mission: string): Ev[] {
  const out: Ev[] = [];
  for (let after = 0; ; ) {
    const page = flowEvents(db, { mission: mission as MissionId, after, limit: 1000 });
    for (const e of page) out.push({ revision: Number(e.revision), line: e.line, event: e.event, key: e.key, body: JSON.parse(data.text(e.body)) as unknown });
    if (page.length < 1000) break;
    after = Number(page.at(-1)!.revision);
  }
  return out;
}

/** The plan in effect of a mission as it stands (its version's tasks and the repairs' amendments), from events already read; null: none. */
export function planInEffectOf(db: Db, data: { text(h: string): string }, events: readonly Ev[]): { readonly dplan: string; readonly plan: DetailedPlanDoc; readonly amendments: readonly AmendmentEntry[] } | null {
  const eff = events.filter((e) => e.line === PLAN_LINE && e.event === 'effective').at(-1)?.body as { dplan?: string; amendments?: AmendmentEntry[] } | undefined;
  if (eff?.dplan === undefined) return null;
  const obj = factById(db, 'object.version', eff.dplan)?.record as ObjectVersionRecord | undefined;
  if (obj === undefined) return null;
  const plan = amendedPlan(DetailedPlanDoc.parse((JSON.parse(data.text(obj.content)) as StoredDetailedPlan).plan), eff.amendments);
  return { dplan: eff.dplan, plan, amendments: eff.amendments ?? [] };
}

/** The commit times of some revisions, in one query. */
export function timesOf(db: Db, revisions: Iterable<number>): Map<number, number> {
  const revs = [...new Set(revisions)];
  const out = new Map<number, number>();
  for (let i = 0; i < revs.length; i += 500) {
    const part = revs.slice(i, i + 500);
    for (const r of db.stmt(`SELECT rev, committed_at FROM log WHERE rev IN (${part.map(() => '?').join(',')})`).all(...part) as Array<{ rev: number; committed_at: number }>) out.set(Number(r.rev), Number(r.committed_at));
  }
  return out;
}

function questionViews(db: Db, data: { text(h: string): string }, mission: string, events: readonly Ev[]): OpenItemView[] {
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

/** 4.4 (G5): the items left at the cap or deferred, with what took them, read from events already read. */
export function riskViews(db: Db, data: { text(h: string): string }, mission: string, events: readonly Ev[]): RiskItemView[] {
  const items = riskItemsOf(events);
  if (items.length === 0) return [];
  const eff = planInEffectOf(db, data, events);
  const takers = takersOf(eff?.plan ?? null, eff?.amendments);
  // 4.4 (G4, G5): and the reopens a repair's decision gave items to
  for (const [id, xs] of reopenTakers(events)) takers.set(id, [...(takers.get(id) ?? []), ...xs]);
  const named = new Map<string, string[]>();
  for (const e of events) {
    if (e.line !== REPAIRS_LINE || e.event !== 'repair') continue;
    const r = e.body as RepairBody;
    for (const id of r.openItems ?? []) named.set(id, [...(named.get(id) ?? []), r.id]);
  }
  const times = timesOf(db, items.map((i) => i.revision));
  return items.map((i) => ({ ...i, mission, at: times.get(i.revision) ?? null, takenBy: takers.get(i.id) ?? [], namedBy: named.get(i.id) ?? [] }));
}

/** `mp read open-items <mission>`: the questions left open (p8) and what was left at the cap, oldest first (one snapshot). */
export function listOpenItems(ctx: ProcessContext, mission: string): OpenItemView[] {
  return ctx.memory.read((db) => questionViews(db, ctx.memory.data, mission, missionEvents(db, ctx.memory.data, mission)));
}

/** 4.4 (G5): both kinds of item in one snapshot, each with the time it was recorded. */
export function listAllItems(ctx: ProcessContext, mission: string): { readonly questions: OpenItemView[]; readonly items: RiskItemView[] } {
  return ctx.memory.read((db) => listOpenItemsIn(db, ctx.memory.data, mission, missionEvents(db, ctx.memory.data, mission)));
}

/** Both kinds of item from events already read (a read or a write that has them). */
export function listOpenItemsIn(db: Db, data: { text(h: string): string }, mission: string, events: readonly Ev[]): { readonly questions: OpenItemView[]; readonly items: RiskItemView[] } {
  const qs = questionViews(db, data, mission, events);
  const times = timesOf(db, qs.map((q) => q.revision));
  return { questions: qs.map((q) => ({ ...q, at: times.get(q.revision) ?? null })), items: riskViews(db, data, mission, events) };
}

/** The mission of an open item named `<mission>/<id>` or `<id>` (found in exactly one mission). */
function missionOf(db: Db, ref: string, also?: (mission: string, id: string) => boolean): { readonly mission: string; readonly id: string } {
  const slash = ref.indexOf('/');
  if (slash > 0) return { mission: ref.slice(0, slash), id: ref.slice(slash + 1) };
  const found = flowMissions(db).filter((m) => flowEventExists(db, { mission: m, line: OPEN_ITEMS_LINE, event: OPEN_ITEM, key: ref }) || (also?.(m, ref) ?? false));
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
    const events = missionEvents(tx, tx.data, at.mission);
    const item = questionViews(tx, tx.data, at.mission, events).find((i) => i.id === at.id);
    if (item === undefined) {
      // 4.4 (G5): an item left at the cap is not answered: the record closes it, or the user's words do
      if (riskItemsOf(events).some((i) => i.id === at.id)) throw new ProcessError('NOT_ALLOWED', `open item ${at.id} was left at an acceptance with risk: it is not answered but closed, when a task that takes it (a re-plan or a repair names it) is accepted with it answered fixed, or on the user's words: mp pm open-item close ${at.mission}/${at.id} --words W-<n> --reason "…"`);
      throw new ProcessError('NOT_READY', `no open item ${at.id} in mission ${at.mission} (mp read open-items ${at.mission} lists them)`);
    }
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

export interface ClosedItem {
  readonly mission: string;
  readonly item: RiskItem;
  /** It was closed before, with these words and reason (a retry): nothing new was written. */
  readonly repeated: boolean;
}

/** The items a close names, checked in the write: each one left at the cap (a question is answered, not closed), of this mission. */
function closable(events: readonly Ev[], mission: string, ids: readonly string[]): RiskItem[] {
  const all = new Map(riskItemsOf(events).map((i) => [i.id, i]));
  const questions = new Set(openItemsOf(events).map((q) => q.id));
  return ids.map((id) => {
    const i = all.get(id);
    if (i !== undefined) return i;
    if (questions.has(id)) throw new ProcessError('NOT_ALLOWED', `open item ${id} is a question: it is answered, not closed (mp pm open-item answer ${mission}/${id} --answer "…")`);
    throw new ProcessError('NOT_READY', `no item ${id} left at the cap in mission ${mission} (mp read open-items ${mission} lists them)`);
  });
}

/**
 * 4.4 (G5, the way through, E-1): `mp pm open-item close <id> --words W-n --reason …` closes an item left at
 * the cap on the user's words. Checked in the write: the item (a 4.3 sentence too, which is then recorded as
 * closed), and whether it is closed already: with the same words and reason, a no-op that says so; otherwise
 * refused, naming how it was closed.
 */
export function closeOpenItem(ctx: ProcessContext, req: { readonly op: string; readonly ref: string; readonly words: string; readonly reason: string }): ClosedItem {
  if (req.reason.trim() === '') throw new ProcessError('NOT_ALLOWED', 'give the reason (--reason "…"), from the user\'s words');
  const at = ctx.memory.read((db) => missionOf(db, req.ref, (m, id) => riskItemsOf(missionEvents(db, ctx.memory.data, m)).some((i) => i.id === id)));
  const body: ItemClosedBody = { id: at.id, by: 'pm', words: req.words, reason: req.reason };
  return ctx.memory.write({ op: `open-item-close:${req.op}`, payload: { mission: at.mission, ...body } }, (tx) => {
    const [item] = closable(missionEvents(tx, tx.data, at.mission), at.mission, [at.id]);
    if (item!.closed !== null) {
      const c = item!.closed;
      if (c.how === 'words' && c.words === req.words && c.reason === req.reason && c.statement === undefined) return { mission: at.mission, item: item!, repeated: true };
      throw new ProcessError('NOT_ALLOWED', `open item ${at.id} is closed already: ${closureText(c)}`);
    }
    appendRecords(tx, [{ kind: 'flow.event', mission: at.mission as MissionId, line: OPEN_ITEMS_LINE, event: OPEN_ITEM_CLOSED, key: at.id, body: tx.data.put(canonicalJson(body)) as ContentHash }]);
    return { mission: at.mission, item: { ...item!, closed: { how: 'words', words: req.words, reason: req.reason, revision: 0 } }, repeated: false };
  });
}

/** How an item was closed, in words (from its record). */
export function closureText(c: NonNullable<RiskItem['closed']>): string {
  return c.how === 'fixed' ? `fixed: task ${c.task} was accepted at attempt ${c.attempt} with it answered fixed` : `on the user's words ${c.words}${c.statement !== undefined ? ` (their statement ${c.statement})` : ''}: ${c.reason}`;
}

/** The most open items one statement closes (one append takes at most 1,000 records). */
export const ITEMS_PER_STATEMENT = 500;

/** A requirement item's line, or null for an id that cannot be one. */
function itemLineOf(mission: string, item: string): string | null {
  try {
    return itemLine(mission, item);
  } catch {
    return null;
  }
}

export interface Verified {
  readonly mission: string;
  readonly subject: string;
  readonly words: string;
  /** The items this statement closed now. */
  readonly closed: readonly string[];
  /** Items it names that were closed already (kept as they were). */
  readonly already: readonly string[];
  readonly repeated: boolean;
}

/**
 * 4.4 (F15, G5): `mp pm verified <mission> <item|repair> --words W-n [--open-items <ids>]` records the user's
 * statement that a requirement item or a repair was checked in the field and holds: a statement on those
 * words, never proof (no label changes). It closes the open items it names, in the same write. The same
 * statement again (the same subject and words) writes nothing and says so.
 */
export function recordVerified(ctx: ProcessContext, req: { readonly op: string; readonly mission: string; readonly subject: string; readonly words: string; readonly items: readonly string[] }): Verified {
  const subject = /^R-[1-9][0-9]*$/.test(req.subject) ? `repair:${req.subject}` : `item:${req.subject}`;
  const key = `${subject}@${req.words}`;
  const items = [...new Set(req.items)].sort();
  // one append takes at most 1,000 records
  if (items.length > ITEMS_PER_STATEMENT) throw new ProcessError('NOT_ALLOWED', `one statement closes at most ${ITEMS_PER_STATEMENT} open items: record the rest with further statements on the same words (mp pm open-item close)`);
  if (key.length > 200) throw new ProcessError('NOT_ALLOWED', `the subject ${req.subject} is too long for a statement`);
  const body: VerifiedBody = { subject, words: req.words, items };
  return ctx.memory.write({ op: `verified:${req.op}`, payload: { mission: req.mission, key, ...body } }, (tx) => {
    const events = missionEvents(tx, tx.data, req.mission);
    const known = subject.startsWith('repair:')
      ? events.some((e) => e.line === REPAIRS_LINE && e.event === 'repair' && e.key === req.subject)
      : events.some((e) => e.line === REQUIREMENTS_LINE && e.event === 'item' && (e.body as { line?: string }).line === itemLineOf(req.mission, req.subject));
    if (!known) throw new ProcessError('NOT_READY', `mission ${req.mission} has no ${subject.startsWith('repair:') ? 'repair' : 'requirement item'} ${req.subject} (mp read items ${req.mission} lists them)`);
    const prior = events.find((e) => e.line === VERIFIED_LINE && e.event === VERIFIED && e.key === key)?.body as VerifiedBody | undefined;
    if (prior !== undefined) {
      if (canonicalJson(prior) !== canonicalJson(body)) throw new ProcessError('NOT_ALLOWED', `the user's statement on ${req.words} about ${req.subject} is recorded already, naming open items ${prior.items.join(', ') || 'none'}; a statement on newer words is recorded with those`);
      return { mission: req.mission, subject, words: req.words, closed: [], already: [...prior.items], repeated: true };
    }
    const named = closable(events, req.mission, items);
    const open = named.filter((i) => i.closed === null);
    const reason = `the user's statement on ${req.words}: ${req.subject} was checked in the field and holds`;
    appendRecords(tx, [
      { kind: 'flow.event', mission: req.mission as MissionId, line: VERIFIED_LINE, event: VERIFIED, key, body: tx.data.put(canonicalJson(body)) as ContentHash },
      ...open.map((i) => ({ kind: 'flow.event' as const, mission: req.mission as MissionId, line: OPEN_ITEMS_LINE, event: OPEN_ITEM_CLOSED, key: i.id, body: tx.data.put(canonicalJson({ id: i.id, by: 'pm', words: req.words, reason, statement: key } satisfies ItemClosedBody)) as ContentHash })),
    ]);
    return { mission: req.mission, subject, words: req.words, closed: open.map((i) => i.id), already: named.filter((i) => i.closed !== null).map((i) => i.id), repeated: false };
  });
}
