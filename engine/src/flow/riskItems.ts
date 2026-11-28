// 4.4 (PM design G5; the plan's F11 where G5 is silent): what is left at the cap is recorded by the program.
// At an acceptance with risk the flow writes one open item for each risk accepted, from the sentences the
// acceptance stores (a standard not met or unclear, an issue not fixed, a finding, a failed run, and any
// other reason it stores, which keeps the kind `fix`). A Reviewer's deferral of an issue is an open item too.
// An item is taken when a task's card names it (`openItems`, written by an Architect's re-plan or repair);
// that task's cards list it and its Reviewer answers it (fixed, not fixed or unclear, on the review event).
// It is closed when that task is accepted and the review of the accepted attempt answered it fixed, whether
// the acceptance followed a pass or a ruling, or on the user's words (`mp pm open-item close`, `mp pm
// verified`). Accepted again without it fixed, it stays open and its carry count rises. Nothing happens by
// itself and nobody is prompted: no owner, no assignment, no count in an inbox, no block.
//
//   line "open-items", event "open-item", key <escalation>.r<n> | dfr.<task>.<hash>: RiskItemBody
//   line "open-items", event "open-item-closed", key <id>: ItemClosedBody
//   line "verified", event "verified", key <subject>@<W-n>: VerifiedBody
//
// An acceptance with risk made under 4.3 has no item: its sentences are listed with the same ids, marked
// as not recorded ("what became of it is not recorded"); nothing is written for them at the upgrade.

import { shortHash, safeId } from './context.ts';
import { OPEN_ITEM, OPEN_ITEMS_LINE } from './openItems.ts';
import { cardChangedBy, repairOfTask, type AmendmentEntry, type DetailedPlanDoc } from './plandoc.ts';

export const OPEN_ITEM_CLOSED = 'open-item-closed';
export const VERIFIED_LINE = 'verified';
export const VERIFIED = 'verified';

/** fix: a standard not met or unclear, an issue not fixed, or a reason of another form; finding; run: a failed program run; deferred: a Reviewer deferred the issue. */
export type RiskKind = 'fix' | 'finding' | 'run' | 'deferred';

export interface RiskItemBody {
  readonly id: string;
  readonly kind: RiskKind;
  readonly text: string;
  /** The task and attempt it came from. */
  readonly task: string;
  readonly attempt: number;
  /** The escalation whose acceptance with risk left it (absent: a deferral, left by a review). */
  readonly escalation?: string;
  readonly why: 'risk' | 'deferred';
  /** The reference into the Reviewer's structured hand-back: the standard or the issue it names (absent: none). */
  readonly ref?: { readonly standard: string } | { readonly issue: string };
  /** A deferral: the review that deferred it. */
  readonly review?: string;
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
const CARRIED = /^open item \S+ (not fixed|unclear): /;

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
 * reason that is an open item answered not fixed is that item carried, not a new one.
 */
export function riskItemBodies(task: string, attempt: number, escalation: string, reasons: readonly string[], findings: ReadonlyMap<string, string> = new Map()): RiskItemBody[] {
  const seen = new Set<string>();
  const out: RiskItemBody[] = [];
  for (const r of reasons) {
    if (CARRIED.test(r) || seen.has(r)) continue;
    seen.add(r);
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
  | { readonly how: 'fixed'; readonly task: string; readonly attempt: number; readonly revision: number }
  | { readonly how: 'words'; readonly words: string; readonly reason: string; readonly statement?: string; readonly revision: number };

export interface RiskItem extends RiskItemBody {
  readonly revision: number;
  /** false: a sentence of an acceptance with risk with no item recorded (one made under 4.3: what became of it is not recorded). */
  readonly recorded: boolean;
  readonly closed: ItemClosure | null;
  /** The acceptances of a task that took it at which its Reviewer did not answer it fixed. */
  readonly carried: number;
  /** The latest answer of a Reviewer to it, if any. */
  readonly answer: (ItemAnswer & { readonly task: string; readonly attempt: number }) | null;
}

/** A review as the outcome of an item reads it: its attempt, its answers to open items, the deferred issues it answered fixed. */
type ReviewLike = { readonly k?: unknown; readonly items?: readonly ItemAnswer[]; readonly fixed?: readonly string[] };

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
  /** Made before 4.4: no item of it is recorded and it carried none; its sentences are all it left. */
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
  for (const e of events) {
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
    const bodies = riskItemBodies(a.task, a.k, esc, acceptanceReasons(a.body, esc));
    for (const b of bodies) if (!all.has(b.id)) all.set(b.id, { body: b, revision: a.revision, recorded: false });
    // what it created: its recorded items (its escalation's, whatever their number), else the ones its sentences give
    const mine = [...recorded.values()].filter((r) => r.body.escalation === esc && r.body.task === a.task).map((r) => r.body.id);
    created.set(a, mine.length > 0 ? mine : bodies.map((b) => b.id));
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
      if (a.response === 'fixed') o.closed = { how: 'fixed', task: acc.task, attempt: k, revision: acc.revision };
      else o.carried += 1;
    }
    carriedAt.set(acc, carried);
    // a deferral: its task's later review answered the issue fixed
    for (const issue of acc.review?.fixed ?? []) {
      for (const [id, x] of all) {
        if (x.body.kind !== 'deferred' || x.body.task !== acc.task || x.body.attempt >= k || !('issue' in (x.body.ref ?? {})) || (x.body.ref as { issue: string }).issue !== issue) continue;
        const o = of(id);
        if (o.closed === null) o.closed = { how: 'fixed', task: acc.task, attempt: k, revision: acc.revision };
      }
    }
  }
  const items = [...all.entries()].sort((a, b) => a[1].revision - b[1].revision).map(([id, x]) => {
    const o = outcome.get(id);
    return { ...x.body, revision: x.revision, recorded: x.recorded, closed: o?.closed ?? null, carried: o?.carried ?? 0, answer: o?.answer ?? null };
  });
  const acceptances = withRisk.map((a): AcceptanceSummary => {
    const made = created.get(a) ?? [];
    const carried = carriedAt.get(a) ?? [];
    const legacy = carried.length === 0 && made.every((id) => all.get(id)?.recorded === false) && made.length > 0;
    return { line: a.line, event: a.event, key: a.key, task: a.task, k: a.k, escalation: a.body.decision!.escalation!, created: made, carried, legacy, risks: (a.body.risks ?? []).length };
  });
  return { items, acceptances };
}

/** The items left at the caps and the deferrals, with what became of each (riskRecord's items). */
export function riskItemsOf(events: readonly Ev[]): RiskItem[] {
  return riskRecord(events).items;
}

/**
 * 4.4 (G5, p10-4): what one acceptance with risk left still open: the distinct items it created or carried that
 * are not closed; `legacy`, an acceptance made before 4.4 (what became of its sentences is not recorded).
 */
export function stillOpen(summary: AcceptanceSummary, items: ReadonlyMap<string, RiskItem>): { readonly open: readonly string[]; readonly legacy: boolean } {
  const ids = [...new Set([...summary.created, ...summary.carried])];
  return { open: ids.filter((id) => (items.get(id)?.closed ?? null) === null), legacy: summary.legacy };
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
 * 4.4 (G5, p10-4): how one acceptance with risk reads in status, the tree and `mp read items`: "n open" (the
 * distinct items it created or carried that are not closed), or, made before 4.4, its sentences whose fate is not
 * recorded. One function, so the reads never disagree.
 */
export function withRiskText(record: RiskRecord, a: AcceptanceSummary | undefined): string {
  if (a === undefined) return 'what it left is not recorded';
  const s = stillOpen(a, new Map(record.items.map((i) => [i.id, i])));
  return s.legacy ? `${a.risks} risk(s); what became of them is not recorded` : `${s.open.length} open`;
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
export function takenItems(events: readonly Ev[], names: readonly string[] | undefined): CardItem[] {
  if (names === undefined || names.length === 0) return [];
  const byId = new Map(riskItemsOf(events).map((i) => [i.id, i]));
  return names.flatMap((id) => {
    const i = byId.get(id);
    const issue = i?.ref !== undefined && 'issue' in i.ref ? i.ref.issue : undefined;
    return i === undefined || i.closed !== null ? [] : [{ id, kind: i.kind, text: i.text, from: `task ${i.task}, attempt ${i.attempt}`, ...(issue !== undefined ? { issue } : {}) }];
  });
}

/** Whether an id names an item of the mission (recorded, or a sentence of an acceptance with risk). */
export function itemIds(events: readonly Ev[]): Set<string> {
  return new Set(riskItemsOf(events).map((i) => i.id));
}
