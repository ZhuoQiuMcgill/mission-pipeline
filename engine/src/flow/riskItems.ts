// 4.4 (PM design G5; the plan's F11 where G5 is silent): what is left at the cap is recorded by the program.
// At an acceptance with risk the flow writes one open item for each risk accepted, from the sentences the
// acceptance stores (a standard not met or unclear, an issue not fixed, a finding, a failed run, and any
// other reason it stores, which keeps the kind `fix`). A Reviewer's deferral of an issue is an open item too.
// 4.4 (F10): a standard the Reviewer could not verify, accepted with risk, is an item of kind `verify` with its
// standard and what is needed, from the structured copy; a standard a person checks is one too, written in the
// write that accepts its task (key vfy.<task>.<attempt>.<hash>, one per accepted attempt and standard).
// An item is taken when a task's card names it (`openItems`, written by an Architect's re-plan or repair);
// that task's cards list it and its Reviewer answers it (fixed, not fixed or unclear, on the review event).
// It is closed when that task is accepted and the review of the accepted attempt answered it fixed, whether
// the acceptance followed a pass or a ruling, or on the user's words (`mp pm open-item close`, `mp pm
// verified`). Accepted again without it fixed, it stays open and its carry count rises. Nothing happens by
// itself and nobody is prompted: no owner, no assignment, no count in an inbox, no block.
//
//   line "open-items", event "open-item", key <escalation>.r<n> | dfr.<task>.<hash> | vfy.<task>.<attempt>.<hash>: RiskItemBody
//   line "open-items", event "open-item-closed", key <id>: ItemClosedBody
//   line "verified", event "verified", key <subject>@<W-n>: VerifiedBody
//
// An acceptance with risk made under 4.3 has no item: its sentences are derived with the same ids, and the
// record does not say that they are open ("what became of them is not recorded"); nothing is written for them at
// the upgrade. One that someone acts on (a repair names it, a plan or a repair's decision gives it to a task, the
// user's words close it or a statement names it) is recorded from then on, in the write that acts on it
// (`before44: true`), and is an item like the others. Every read classifies an item the same way (`state`):
// open (recorded by 4.4, not closed), closed (answered fixed or closed on the user's words), or not recorded (a
// sentence of an acceptance made before 4.4 nobody acted on). Only the first is called open.

import { shortHash, safeId } from './context.ts';
import { OPEN_ITEM, OPEN_ITEMS_LINE } from './openItems.ts';
import { SECRETARY_LINE, cardChangedBy, repairOfTask, type AmendmentEntry, type DetailedPlanDoc } from './plandoc.ts';

export const OPEN_ITEM_CLOSED = 'open-item-closed';
export const VERIFIED_LINE = 'verified';
export const VERIFIED = 'verified';

/**
 * fix: a standard not met or unclear, an issue not fixed, or a reason of another form; finding; run: a failed program
 * run; deferred: a Reviewer deferred the issue; verify (4.4, F10): a standard its Reviewer could not verify, accepted
 * with what would be needed, or a standard a person checks, written when its task is accepted.
 */
export type RiskKind = 'fix' | 'finding' | 'run' | 'deferred' | 'verify';

export interface RiskItemBody {
  readonly id: string;
  readonly kind: RiskKind;
  readonly text: string;
  /** The task and attempt it came from. */
  readonly task: string;
  readonly attempt: number;
  /** The escalation whose acceptance with risk left it (absent: a deferral, left by a review; a standard a person checks). */
  readonly escalation?: string;
  /** risk: an acceptance with risk left it; deferred: a review deferred it; person: a standard a person checks, its task accepted. */
  readonly why: 'risk' | 'deferred' | 'person';
  /** The reference into the Reviewer's structured hand-back: the standard or the issue it names (absent: none). */
  readonly ref?: { readonly standard: string } | { readonly issue: string };
  /** A deferral: the review that deferred it. */
  readonly review?: string;
  /** 4.4 (F10): a standard that could not be verified: what would be needed to verify it (from the structured copy). */
  readonly needed?: string;
  /** A risk sentence of an acceptance made before 4.4, recorded when someone acted on it (its acceptance wrote none). */
  readonly before44?: true;
}

/** 4.4 (F10): a standard its Reviewer could not verify from what it can see, with what would be needed (the review event's and the escalation's structured copy). */
export interface Unverifiable {
  readonly standard: string;
  readonly reason: string;
  readonly needed: string;
}

/** 4.4 (F10): the sentence of such a standard among a review's issues and an acceptance's risks, in the form a standard not met takes ("[S1] not met: why"). */
export function unverifiableLine(u: Unverifiable): string {
  return `[${u.standard}] cannot be verified: ${u.reason}; needed: ${u.needed}`;
}

/** The structured copies a record carries (`unverifiable` of an escalation's facts or of a review event), kept when well formed. */
function unverifiableList(x: unknown): Unverifiable[] {
  if (!Array.isArray(x)) return [];
  return x.filter((u): u is Unverifiable => typeof u === 'object' && u !== null && typeof (u as Unverifiable).standard === 'string' && typeof (u as Unverifiable).reason === 'string' && typeof (u as Unverifiable).needed === 'string');
}

/**
 * 4.4 (F10, the seam with p9): the standards an acceptance with risk took on as not verifiable, from the structured
 * copies where they exist: its escalation's `facts.unverifiable`, then the accepted review's `unverifiable`. The writer
 * and the read derive them alike; an acceptance of 4.3 has neither, and its sentences keep the kind they had.
 */
export function unverifiableOf(facts: unknown, review: { readonly unverifiable?: unknown } | undefined): Unverifiable[] {
  const out = new Map<string, Unverifiable>();
  const f = typeof facts === 'object' && facts !== null ? (facts as { unverifiable?: unknown }).unverifiable : undefined;
  for (const u of [...unverifiableList(f), ...unverifiableList(review?.unverifiable)]) if (!out.has(unverifiableLine(u))) out.set(unverifiableLine(u), u);
  return [...out.values()];
}

/**
 * 4.4 (F10): the id of the open item of a standard a person checks: one per task, accepted attempt and standard (the
 * person checks the work accepted; a re-bind of the same attempt accepts the same work and writes none again).
 */
export const personItemId = (task: string, attempt: number, standard: string): string => safeId(`vfy.${task}.${attempt}.${shortHash(standard)}`);

/**
 * 4.4 (F10; the plan's F10: a standard a person checks starts as something to verify): the open items of a task's
 * standards whose check is `person`, written in the write that accepts attempt `attempt` (by a pass or by a ruling).
 * Nothing waits for them and they block nothing; a plan of 4.3 has no such standard, so none is written for it.
 */
export function personItemBodies(task: { readonly id: string; readonly standards: ReadonlyArray<{ readonly id: string; readonly text: string; readonly check?: string | undefined }> }, attempt: number): RiskItemBody[] {
  return task.standards.filter((s) => s.check === 'person').map((s) => ({ id: personItemId(task.id, attempt, s.id), kind: 'verify', text: `[${s.id}] is checked by a person: ${s.text}`, task: task.id, attempt, why: 'person', ref: { standard: s.id } }));
}

/** Closed on the user's words (`mp pm open-item close`, or `mp pm verified` naming it: `statement`). */
export interface ItemClosedBody {
  readonly id: string;
  readonly by: 'pm';
  readonly words: string;
  readonly reason: string;
  readonly statement?: string;
}

/** `mp pm verified`: the user's statement that an item or a repair was checked in the field and holds (never proof). */
export interface VerifiedBody {
  readonly subject: string;
  readonly words: string;
  readonly items: readonly string[];
}

/** A Reviewer's answer to an open item its card listed (review event `items`). */
export interface ItemAnswer {
  readonly item: string;
  readonly response: 'fixed' | 'not-fixed' | 'unclear';
  readonly reason: string;
}

/** The review line of an item answered not fixed or unclear: it joins the review's issues, and an acceptance with risk carries the item instead of writing a new one. */
export const itemIssueLine = (a: ItemAnswer): string => `open item ${a.item} ${a.response === 'unclear' ? 'unclear' : 'not fixed'}: ${a.reason}`;
const CARRIED = /^open item (\S+) (not fixed|unclear): /;

const STANDARD = /^\[([^\]]+)\] (not met|unclear): /;
const ISSUE = /^issue (\S+) not fixed: /;

/** The kind and reference of one reason an acceptance stores. Any form not known here is kept, as kind `fix` (G5: every risk accepted). */
export function riskOf(reason: string): { readonly kind: RiskKind; readonly ref?: RiskItemBody['ref'] } {
  const s = STANDARD.exec(reason);
  if (s !== null) return { kind: 'fix', ref: { standard: s[1]! } };
  const i = ISSUE.exec(reason);
  if (i !== null) return { kind: 'fix', ref: { issue: i[1]! } };
  if (reason.startsWith('finding: ')) return { kind: 'finding' };
  if (reason.startsWith('a program run did not pass on the product: ')) return { kind: 'run' };
  return { kind: 'fix' };
}

/**
 * The open items an acceptance with risk of `task` at `attempt` writes, one per distinct reason, with ids that
 * do not depend on when they are written (`<escalation>.r<n>`), so a write repeated writes the same records. A
 * reason that is an open item the accepted review answered not fixed (`carried`) is that item carried, not a new
 * one; any other reason, whatever its form (p10-1: a sentence that only looks like one), is an item.
 */
export function riskItemBodies(task: string, attempt: number, escalation: string, reasons: readonly string[], findings: ReadonlyMap<string, string> = new Map(), carried: ReadonlySet<string> = new Set(), unverifiable: readonly Unverifiable[] = []): RiskItemBody[] {
  const seen = new Set<string>();
  const out: RiskItemBody[] = [];
  const structured = new Map(unverifiable.map((u) => [unverifiableLine(u), u]));
  for (const r of reasons) {
    const c = CARRIED.exec(r);
    if ((c !== null && carried.has(c[1]!)) || seen.has(r)) continue;
    seen.add(r);
    // 4.4 (F10): a standard that could not be verified is something to verify, its standard and what is needed taken
    // from the structured copy (never parsed from the sentence)
    const u = structured.get(r);
    if (u !== undefined) {
      out.push({ id: `${escalation}.r${out.length + 1}`, kind: 'verify', ref: { standard: u.standard }, needed: u.needed, text: r, task, attempt, escalation, why: 'risk' });
      continue;
    }
    const kind = riskOf(r);
    // 4.4 (p10-5): a finding names the issue record it became, when the accepted review's hand-back says which
    const issue = kind.kind === 'finding' ? findings.get(r) : undefined;
    out.push({ id: `${escalation}.r${out.length + 1}`, ...kind, ...(issue !== undefined ? { ref: { issue } } : {}), text: r, task, attempt, escalation, why: 'risk' });
  }
  return out;
}

/** The reasons an acceptance stored, without the prefix each sentence carries ("accepted with its risk by … on <escalation>: "). */
export function acceptanceReasons(body: { readonly risks?: readonly string[] }, escalation: string): string[] {
  const marker = ` on ${escalation}: `;
  return (body.risks ?? []).map((s) => {
    const i = s.indexOf(marker);
    return s.startsWith('accepted with its risk by ') && i >= 0 ? s.slice(i + marker.length) : s;
  });
}

/** 4.4 (G5, the plan's F11 "Deferred findings"): the open item of a Reviewer's deferral of an issue: one per task and issue, whatever review deferred it again. */
export function deferredItemBody(task: string, attempt: number, review: string, issue: string, text: string): RiskItemBody {
  return { id: safeId(`dfr.${task}.${shortHash(issue)}`), kind: 'deferred', text, task, attempt, why: 'deferred', ref: { issue }, review };
}

/** How many items one acceptance writes in its own write; the rest follow in writes of this size (an append takes at most 1,000 records). */
export const ITEM_BATCH = 200;

type Ev = { readonly revision: number; readonly line: string; readonly event: string; readonly key: string; readonly body: unknown };
type Decided = { readonly decision?: { readonly escalation?: string; readonly option?: string }; readonly risks?: readonly string[]; readonly k?: number };

export type ItemClosure =
  /** `judgment`: the judgment of the review that answered it fixed (the fix tracker reads it). */
  | { readonly how: 'fixed'; readonly task: string; readonly attempt: number; readonly revision: number; readonly judgment?: string }
  | { readonly how: 'words'; readonly words: string; readonly reason: string; readonly statement?: string; readonly revision: number };

/**
 * How every read classifies an item (v1-4): open, an item recorded by 4.4 and not closed; closed, answered fixed or
 * closed on the user's words; not recorded, a risk sentence of an acceptance made before 4.4 that nobody acted on (the
 * record does not say that it is open). Only the first is called open.
 */
export type ItemState = 'open' | 'closed' | 'not recorded';

export interface RiskItem extends RiskItemBody {
  readonly revision: number;
  /** false: a sentence of an acceptance with risk with no item recorded (one made under 4.3, or a batch of a 4.4 one not written yet). */
  readonly recorded: boolean;
  readonly closed: ItemClosure | null;
  /** The acceptances of a task that took it at which its Reviewer did not answer it fixed. */
  readonly carried: number;
  /** The latest answer of a Reviewer to it, if any. */
  readonly answer: (ItemAnswer & { readonly task: string; readonly attempt: number }) | null;
  readonly state: ItemState;
}

/** A review as the outcome of an item reads it: its attempt, its answers to open items, the deferred issues it answered fixed. */
type ReviewLike = { readonly k?: unknown; readonly judgment?: string; readonly items?: readonly ItemAnswer[]; readonly fixed?: readonly string[]; readonly unverifiable?: unknown };

/** The items a review answered not fixed or unclear: an acceptance resting on it carries them (p10-1: only those). */
export function carriedBy(review: { readonly items?: readonly ItemAnswer[] } | undefined): Set<string> {
  return new Set((review?.items ?? []).filter((a) => a.response !== 'fixed').map((a) => a.item));
}

/** One acceptance of a task's attempt (accepted, re-bound and accepted, or accepted again), with the review it rests on. */
interface Acceptance {
  readonly revision: number;
  readonly line: string;
  readonly event: string;
  readonly key: string;
  readonly task: string;
  readonly k: number;
  /** The review of the attempt it accepts: the one it names as adopted (an integration's reviewed attempt), else the attempt's last review before it. */
  readonly review: ReviewLike | undefined;
  readonly body: Decided & { readonly review?: string };
}

/** Every acceptance on a mission's task lines (each with its own review). */
function acceptancesOf(events: readonly Ev[]): Acceptance[] {
  const lines = new Map<string, Ev[]>();
  for (const e of events) if (e.line.startsWith('task:')) (lines.get(e.line) ?? (lines.set(e.line, []), lines.get(e.line)!)).push(e);
  const out: Acceptance[] = [];
  for (const [line, evs] of lines) {
    const reviews = evs.filter((e) => e.event === 'review');
    for (const acc of evs) {
      if (acc.event !== 'accepted' && acc.event !== 'rebound' && acc.event !== 'reaccepted') continue;
      const body = acc.body as Acceptance['body'];
      if (typeof body.k !== 'number') continue;
      const k = body.k;
      // 4.4 (G5, p10-1): a ruling that adopts the reviewed attempt of an integration names that review
      const adopted = typeof body.review === 'string' ? reviews.find((r) => r.key === body.review)?.body as ReviewLike | undefined : undefined;
      const review = adopted ?? (reviews.filter((r) => (r.body as ReviewLike).k === k && r.revision < acc.revision).at(-1)?.body as ReviewLike | undefined);
      out.push({ revision: acc.revision, line, event: acc.event, key: acc.key, task: line.slice('task:'.length), k, review, body });
    }
  }
  // grouped by line here; riskRecord applies them in the order of their revisions
  return out;
}

/** An acceptance with risk and the items it left: those it created (one per distinct reason), and those it carried (taken, answered not fixed). */
export interface AcceptanceSummary {
  readonly line: string;
  readonly event: string;
  readonly key: string;
  readonly task: string;
  readonly k: number;
  readonly escalation: string;
  readonly created: readonly string[];
  readonly carried: readonly string[];
  /** Made before 4.4: its own write recorded no item and it carried none (a sentence recorded since, when someone acted on it, is `before44`). */
  readonly legacy: boolean;
  /** How many risk sentences it stores. */
  readonly risks: number;
}

/** The record of what was left at the caps: every item with what became of it, and every acceptance with risk with what it left. */
export interface RiskRecord {
  readonly items: RiskItem[];
  readonly acceptances: AcceptanceSummary[];
}

/**
 * Every item left at a cap or deferred, of one mission's events, each with what became of it, and every
 * acceptance with risk with the items it created or carried. The acceptances and the closures on the user's
 * words are applied in the order of their ledger revisions, each acceptance with its own review: the first
 * closure in the record stands, and a carry is counted at the acceptance that made it. Pure, one pass over the
 * events (read once, never once per item).
 */
export function riskRecord(events: readonly Ev[]): RiskRecord {
  const recorded = new Map<string, { body: RiskItemBody; revision: number }>();
  const closures: Array<{ revision: number; id: string; closure: ItemClosure }> = [];
  // 4.4 (F10): each escalation's facts, for the structured copy of the standards that could not be verified
  const facts = new Map<string, unknown>();
  for (const e of events) {
    if (e.line === SECRETARY_LINE && e.event === 'escalation') facts.set(e.key, (e.body as { facts?: unknown }).facts);
    if (e.line !== OPEN_ITEMS_LINE) continue;
    if (e.event === OPEN_ITEM && (e.body as { kind?: unknown }).kind !== 'question' && !recorded.has(e.key)) recorded.set(e.key, { body: e.body as RiskItemBody, revision: e.revision });
    if (e.event === OPEN_ITEM_CLOSED) {
      const c = e.body as ItemClosedBody;
      closures.push({ revision: e.revision, id: e.key, closure: { how: 'words', words: c.words, reason: c.reason, ...(c.statement !== undefined ? { statement: c.statement } : {}), revision: e.revision } });
    }
  }
  const accs = acceptancesOf(events);
  // the items an acceptance with risk left, recorded or not (4.3: none; 4.4: all, in its write and the batches after it)
  const all = new Map<string, { body: RiskItemBody; revision: number; recorded: boolean }>();
  for (const [id, r] of recorded) all.set(id, { ...r, recorded: true });
  const withRisk = accs.filter((a) => (a.event === 'accepted' || a.event === 'rebound') && a.body.decision?.option === 'accept-risk' && typeof a.body.decision.escalation === 'string');
  const created = new Map<Acceptance, string[]>();
  for (const a of withRisk) {
    const esc = a.body.decision!.escalation!;
    const bodies = riskItemBodies(a.task, a.k, esc, acceptanceReasons(a.body, esc), new Map(), carriedBy(a.review), unverifiableOf(facts.get(esc), a.review));
    for (const b of bodies) if (!all.has(b.id)) all.set(b.id, { body: b, revision: a.revision, recorded: false });
    // what it created: its recorded items (its escalation's) and the ones its sentences give (p10-r2-2: a batch an
    // interruption left out is still among them)
    // 4.4 (F10): and the standards a person checks its write left to verify (its task and attempt), so status, the
    // tree and `mp read items` count the same items
    const mine = [...recorded.values()].filter((r) => (r.body.escalation === esc || r.body.why === 'person') && r.body.task === a.task && (r.body.why !== 'person' || r.body.attempt === a.k)).map((r) => r.body.id);
    created.set(a, [...new Set([...mine, ...bodies.map((b) => b.id)])]);
  }
  // the timeline: acceptances and closures on the user's words, in revision order
  const outcome = new Map<string, { closed: ItemClosure | null; carried: number; answer: RiskItem['answer'] }>();
  const of = (id: string) => outcome.get(id) ?? (outcome.set(id, { closed: null, carried: 0, answer: null }), outcome.get(id)!);
  const carriedAt = new Map<Acceptance, string[]>();
  const steps: Array<{ revision: number; acc?: Acceptance; closure?: { id: string; closure: ItemClosure } }> = [...accs.map((acc) => ({ revision: acc.revision, acc })), ...closures.map((c) => ({ revision: c.revision, closure: c }))].sort((a, b) => a.revision - b.revision);
  for (const s of steps) {
    if (s.closure !== undefined) {
      const o = of(s.closure.id);
      if (o.closed === null) o.closed = s.closure.closure;
      continue;
    }
    const acc = s.acc!;
    const k = typeof acc.review?.k === 'number' ? acc.review.k : acc.k;
    const carried: string[] = [];
    for (const a of acc.review?.items ?? []) {
      const o = of(a.item);
      o.answer = { ...a, task: acc.task, attempt: k };
      if (a.response !== 'fixed') carried.push(a.item);
      if (o.closed !== null) continue;
      if (a.response === 'fixed') o.closed = { how: 'fixed', task: acc.task, attempt: k, revision: acc.revision, ...(typeof acc.review?.judgment === 'string' ? { judgment: acc.review.judgment } : {}) };
      else o.carried += 1;
    }
    carriedAt.set(acc, carried);
    // a deferral: its task's later review answered the issue fixed
    for (const issue of acc.review?.fixed ?? []) {
      for (const [id, x] of all) {
        if (x.body.kind !== 'deferred' || x.body.task !== acc.task || x.body.attempt >= k || !('issue' in (x.body.ref ?? {})) || (x.body.ref as { issue: string }).issue !== issue) continue;
        const o = of(id);
        if (o.closed === null) o.closed = { how: 'fixed', task: acc.task, attempt: k, revision: acc.revision, ...(typeof acc.review?.judgment === 'string' ? { judgment: acc.review.judgment } : {}) };
      }
    }
  }
  // made before 4.4: its own write recorded no item (every one it made is a sentence not recorded, or one recorded
  // since because someone acted on it) and it carried none
  const plain = (id: string): boolean => all.get(id)?.recorded === true && all.get(id)?.body.before44 !== true;
  const acceptances = withRisk.map((a): AcceptanceSummary => {
    const made = created.get(a) ?? [];
    const carried = carriedAt.get(a) ?? [];
    const legacy = carried.length === 0 && made.length > 0 && !made.some(plain);
    return { line: a.line, event: a.event, key: a.key, task: a.task, k: a.k, escalation: a.body.decision!.escalation!, created: made, carried, legacy, risks: (a.body.risks ?? []).length };
  });
  const before = new Set(acceptances.filter((a) => a.legacy).flatMap((a) => a.created));
  const items = [...all.entries()].sort((a, b) => a[1].revision - b[1].revision).map(([id, x]): RiskItem => {
    const o = outcome.get(id);
    const closed = o?.closed ?? null;
    const carried = o?.carried ?? 0;
    const answer = o?.answer ?? null;
    // v1-4: a sentence of an acceptance made before 4.4 is marked so; while nobody acted on it, it is not recorded
    const pre = !x.recorded && before.has(id);
    const state: ItemState = closed !== null ? 'closed' : pre && answer === null && carried === 0 ? 'not recorded' : 'open';
    return { ...x.body, ...(pre ? { before44: true as const } : {}), revision: x.revision, recorded: x.recorded, closed, carried, answer, state };
  });
  return { items, acceptances };
}

/**
 * v1-4: what an act on items records: for each of `ids` that is a sentence of an acceptance made before 4.4 not
 * recorded yet, its body as the read derives it (`before44`), to be written in the write that acts on it (a repair
 * naming it, a plan or a repair's decision giving it to a task, a close on the user's words, a statement naming it).
 * From then on it is an item like the others. Every other id gives nothing.
 */
export function recordOnAct(events: readonly Ev[], ids: Iterable<string>): RiskItemBody[] {
  const want = new Set(ids);
  if (want.size === 0) return [];
  return riskItemsOf(events).filter((i) => want.has(i.id) && !i.recorded && i.before44 === true).map(({ revision: _r, recorded: _c, closed: _x, carried: _n, answer: _a, state: _s, ...body }) => body);
}

/** v1-4: the phrase every read uses for the risk sentences of acceptances made before 4.4 nobody acted on. */
export function beforeText(n: number): string {
  return `${n} risk sentence${n === 1 ? '' : 's'} accepted before 4.4: what became of ${n === 1 ? 'it' : 'them'} is not recorded`;
}

/** v1-4: the sentences of acceptances made before 4.4 nobody acted on, counted per task, in the order first recorded. */
export function notRecordedByTask(items: readonly RiskItem[]): Array<{ readonly task: string; readonly count: number }> {
  const out = new Map<string, number>();
  for (const i of items) if (i.state === 'not recorded') out.set(i.task, (out.get(i.task) ?? 0) + 1);
  return [...out].map(([task, count]) => ({ task, count }));
}

/** The items left at the caps and the deferrals, with what became of each (riskRecord's items). */
export function riskItemsOf(events: readonly Ev[]): RiskItem[] {
  return riskRecord(events).items;
}

/**
 * 4.4 (G5, p10-4; v1-4): what one acceptance with risk left: the distinct items it created or carried that are open
 * (recorded by 4.4, not closed), and those that are sentences of an acceptance made before 4.4 nobody acted on (not
 * recorded: never counted as open).
 */
export function stillOpen(summary: AcceptanceSummary, items: ReadonlyMap<string, RiskItem>): { readonly open: readonly string[]; readonly notRecorded: readonly string[] } {
  const ids = [...new Set([...summary.created, ...summary.carried])];
  return { open: ids.filter((id) => items.get(id)?.state === 'open'), notRecorded: ids.filter((id) => items.get(id)?.state === 'not recorded') };
}

/** v1-4: "n open" (with how many of them are to verify, when asked), and apart the sentences before 4.4 not recorded: the one wording of status, the tree and `mp read items`. */
export function riskCountText(open: number, notRecorded: number, toVerify = 0): string {
  return `${open} open${toVerify > 0 ? `, ${toVerify} of them to verify` : ''}${notRecorded > 0 ? `; ${beforeText(notRecorded)}` : ''}`;
}

/** The acceptance with risk a task line's event is (its line, event and key), if it is one. */
export function acceptanceSummary(record: RiskRecord, line: string, event: string, key: string): AcceptanceSummary | undefined {
  return record.acceptances.find((a) => a.line === line && a.event === event && a.key === key);
}

/** A task's latest acceptance with risk on an escalation (status reads the current one by its escalation). */
export function acceptanceOf(record: RiskRecord, task: string, escalation: string): AcceptanceSummary | undefined {
  return record.acceptances.filter((a) => a.task === task && a.escalation === escalation).at(-1);
}

/**
 * 4.4 (G5, p10-4; v1-4): how one acceptance with risk reads in status and the tree: "n open" (the distinct items it
 * created or carried that are recorded and not closed) and, beside it, its sentences made before 4.4 that nobody acted
 * on (not recorded, never called open). One classification (`state`) for every read, so they never disagree.
 */
export function withRiskText(record: RiskRecord, a: AcceptanceSummary | undefined): string {
  if (a === undefined) return 'what it left is not recorded';
  const s = stillOpen(a, new Map(record.items.map((i) => [i.id, i])));
  return riskCountText(s.open.length, s.notRecorded.length);
}

/** Who took an item: the tasks of the plan in effect whose card names it, with what wrote that card (the plan, or a repair's amendment). */
export interface Taker {
  readonly task: string;
  /** "the plan" or "repair R-<n>". */
  readonly by: string;
}

export function takersOf(plan: Pick<DetailedPlanDoc, 'tasks'> | null, amendments: readonly AmendmentEntry[] | undefined): Map<string, Taker[]> {
  const out = new Map<string, Taker[]>();
  for (const t of plan?.tasks ?? []) {
    const repair = cardChangedBy(amendments, t.id) ?? repairOfTask(amendments, t.id);
    for (const id of t.openItems ?? []) out.set(id, [...(out.get(id) ?? []), { task: t.id, by: repair === null ? 'the plan' : `repair ${repair}` }]);
  }
  return out;
}

/** The reopens repairs' decisions gave open items to (a decided reopen's `openItems`): who took each. */
export function reopenTakers(events: readonly Ev[]): Map<string, Taker[]> {
  const out = new Map<string, Taker[]>();
  for (const e of events) {
    if (e.line !== 'repairs' || e.event !== 'decided') continue;
    const d = e.body as { repair: string; reopen?: ReadonlyArray<{ task: string; openItems?: readonly string[] }> };
    for (const x of d.reopen ?? []) for (const id of x.openItems ?? []) out.set(id, [...(out.get(id) ?? []), { task: x.task, by: `repair ${d.repair}, its reopen` }]);
  }
  return out;
}

/**
 * 4.4 (G5): the open items attempt `attempt` of a task takes: those its card names, and those a repair's reopen
 * gave it, on the reopened attempt and the reworks after it until one of them is accepted (the reopen's work).
 */
export function cardItemNames(events: readonly Ev[], task: { readonly id: string; readonly openItems?: readonly string[] | undefined }, attempt: number): string[] {
  const line = events.filter((e) => e.line === `task:${task.id}`);
  const accepted = new Set(line.filter((e) => e.event === 'accepted').map((e) => (e.body as { k?: unknown }).k));
  let reopened: readonly string[] = [];
  for (let j = attempt; j >= 1; j--) {
    const rw = line.find((e) => e.event === 'rework' && e.key === String(j))?.body as { reopen?: { kind?: string; repair?: string } } | undefined;
    if (rw?.reopen?.kind === 'repair') {
      const d = events.find((e) => e.line === 'repairs' && e.event === 'decided' && e.key === rw.reopen!.repair)?.body as { reopen?: ReadonlyArray<{ task: string; openItems?: readonly string[] }> } | undefined;
      reopened = d?.reopen?.find((x) => x.task === task.id)?.openItems ?? [];
      break;
    }
    if (accepted.has(j - 1)) break;
  }
  return [...new Set([...(task.openItems ?? []), ...reopened])];
}

/** An open item as a card lists it, for the task that took it. */
export interface CardItem {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  /** Where it was left: "task <id>, attempt <k>". */
  readonly from: string;
  /** 4.4 (p10-5): the issue record it is about, when it names one: a "fixed" answer is the Reviewer's answer to that issue too. */
  readonly issue?: string;
}

/** 4.4 (G5): the items a task's card names that are still open, as its cards list them (the Constructor fixes them; the Reviewer answers each). */
export function takenItems(events: readonly Ev[], names: readonly string[] | undefined, issueOf: (i: RiskItem) => string | undefined = itemIssue): CardItem[] {
  if (names === undefined || names.length === 0) return [];
  const byId = new Map(riskItemsOf(events).map((i) => [i.id, i]));
  return names.flatMap((id) => {
    const i = byId.get(id);
    const issue = i === undefined ? undefined : issueOf(i);
    return i === undefined || i.closed !== null ? [] : [{ id, kind: i.kind, text: i.text, from: `task ${i.task}, attempt ${i.attempt}`, ...(issue !== undefined ? { issue } : {}) }];
  });
}

/** The issue an item is about, as its record names it. */
export const itemIssue = (i: Pick<RiskItemBody, 'ref'>): string | undefined => (i.ref !== undefined && 'issue' in i.ref ? i.ref.issue : undefined);

/** An issue record as the resolver of a finding reads it: its id, the versions it was observed on, the finding's words. */
export interface IssueNote {
  readonly issue: string;
  readonly observedOn: readonly string[];
  readonly text: string | null;
}

/**
 * 4.4 (G5, p10-5): the issue an item is about: the one its record names, else (a finding of an acceptance made
 * before 4.4, whose record names none) the one issue record of that finding's words observed on the product the
 * acceptance accepted. Undefined when it cannot be recovered: a "fixed" answer then reaches no fix tracker, and the
 * read says so.
 */
export function issueResolver(events: readonly Ev[], notes: readonly IssueNote[]): (i: RiskItem) => string | undefined {
  const products = new Map<string, string>();
  for (const e of events) {
    if (!e.line.startsWith('task:') || (e.event !== 'accepted' && e.event !== 'rebound')) continue;
    const b = e.body as Decided & { product?: unknown };
    if (typeof b.decision?.escalation === 'string' && typeof b.product === 'string') products.set(`${e.line}\n${b.decision.escalation}`, b.product);
  }
  return (i) => {
    const own = itemIssue(i);
    if (own !== undefined || i.kind !== 'finding' || i.escalation === undefined) return own;
    const product = products.get(`task:${i.task}\n${i.escalation}`);
    const words = i.text.slice('finding: '.length);
    const hits = product === undefined ? [] : notes.filter((n) => n.text === words && n.observedOn.includes(product));
    return hits.length === 1 ? hits[0]!.issue : undefined;
  };
}

/** Whether an item has an issue the fix tracker could be told of (an issue-backed item: a finding, an issue not fixed, a deferral). */
export const issueBacked = (i: Pick<RiskItemBody, 'kind' | 'ref'>): boolean => i.kind === 'finding' || i.kind === 'deferred' || itemIssue(i) !== undefined;

/** Whether an id names an item of the mission (recorded, or a sentence of an acceptance with risk). */
export function itemIds(events: readonly Ev[]): Set<string> {
  return new Set(riskItemsOf(events).map((i) => i.id));
}
