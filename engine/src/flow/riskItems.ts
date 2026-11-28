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
export function riskItemBodies(task: string, attempt: number, escalation: string, reasons: readonly string[]): RiskItemBody[] {
  const seen = new Set<string>();
  const out: RiskItemBody[] = [];
  for (const r of reasons) {
    if (CARRIED.test(r) || seen.has(r)) continue;
    seen.add(r);
    out.push({ id: `${escalation}.r${out.length + 1}`, ...riskOf(r), text: r, task, attempt, escalation, why: 'risk' });
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

/** The acceptances with risk on a mission's task lines (accepted, or a re-bound version accepted with its risk): the items each leaves. */
export function acceptanceItems(events: readonly Ev[]): Array<{ readonly revision: number; readonly items: RiskItemBody[] }> {
  const out: Array<{ revision: number; items: RiskItemBody[] }> = [];
  for (const e of events) {
    if (!e.line.startsWith('task:') || (e.event !== 'accepted' && e.event !== 'rebound')) continue;
    const b = e.body as Decided;
    const esc = b.decision?.escalation;
    if (b.decision?.option !== 'accept-risk' || typeof esc !== 'string' || typeof b.k !== 'number') continue;
    out.push({ revision: e.revision, items: riskItemBodies(e.line.slice('task:'.length), b.k, esc, acceptanceReasons(b, esc)) });
  }
  return out;
}

/**
 * Every item left at a cap or deferred, of one mission's events, each with what became of it: closed (fixed
 * at an acceptance of a task whose card carried it, or on the user's words), how often it was carried, and
 * the latest answer. Pure, one pass over the events (read once, never once per item).
 */
export function riskItemsOf(events: readonly Ev[]): RiskItem[] {
  const recorded = new Map<string, { body: RiskItemBody; revision: number }>();
  const closedByWords = new Map<string, ItemClosure>();
  for (const e of events) {
    if (e.line !== OPEN_ITEMS_LINE) continue;
    if (e.event === OPEN_ITEM && (e.body as { kind?: unknown }).kind !== 'question' && !recorded.has(e.key)) recorded.set(e.key, { body: e.body as RiskItemBody, revision: e.revision });
    if (e.event === OPEN_ITEM_CLOSED && !closedByWords.has(e.key)) {
      const c = e.body as ItemClosedBody;
      closedByWords.set(e.key, { how: 'words', words: c.words, reason: c.reason, ...(c.statement !== undefined ? { statement: c.statement } : {}), revision: e.revision });
    }
  }
  // the items an acceptance with risk left, recorded or not (4.3: none; 4.4: all, in its write and the batches after it)
  const all = new Map<string, { body: RiskItemBody; revision: number; recorded: boolean }>();
  for (const [id, r] of recorded) all.set(id, { ...r, recorded: true });
  for (const a of acceptanceItems(events)) for (const b of a.items) if (!all.has(b.id)) all.set(b.id, { body: b, revision: a.revision, recorded: false });
  // what the Reviewers answered at accepted attempts, in order, per task line
  const outcome = new Map<string, { closed: ItemClosure | null; carried: number; answer: RiskItem['answer'] }>();
  const of = (id: string) => outcome.get(id) ?? (outcome.set(id, { closed: null, carried: 0, answer: null }), outcome.get(id)!);
  const lines = new Map<string, Ev[]>();
  for (const e of events) if (e.line.startsWith('task:')) (lines.get(e.line) ?? (lines.set(e.line, []), lines.get(e.line)!)).push(e);
  for (const [line, evs] of lines) {
    const task = line.slice('task:'.length);
    const reviews = evs.filter((e) => e.event === 'review');
    for (const acc of evs.filter((e) => e.event === 'accepted' || e.event === 'rebound' || e.event === 'reaccepted')) {
      const k = (acc.body as { k?: unknown }).k;
      if (typeof k !== 'number') continue;
      const review = reviews.filter((r) => (r.body as { k?: unknown }).k === k && r.revision < acc.revision).at(-1)?.body as { items?: readonly ItemAnswer[]; fixed?: readonly string[] } | undefined;
      for (const a of review?.items ?? []) {
        const o = of(a.item);
        o.answer = { ...a, task, attempt: k };
        if (o.closed !== null) continue;
        if (a.response === 'fixed') o.closed = { how: 'fixed', task, attempt: k, revision: acc.revision };
        else o.carried += 1;
      }
      // a deferral: its task's later review answered the issue fixed
      for (const issue of review?.fixed ?? []) {
        for (const [id, x] of all) {
          if (x.body.kind !== 'deferred' || x.body.task !== task || x.body.attempt >= k || !('issue' in (x.body.ref ?? {})) || (x.body.ref as { issue: string }).issue !== issue) continue;
          const o = of(id);
          if (o.closed === null) o.closed = { how: 'fixed', task, attempt: k, revision: acc.revision };
        }
      }
    }
  }
  return [...all.entries()].sort((a, b) => a[1].revision - b[1].revision).map(([id, x]) => {
    const o = outcome.get(id);
    const words = closedByWords.get(id) ?? null;
    const fixed = o?.closed ?? null;
    // the first closure in the record stands
    const closed = words === null ? fixed : fixed === null ? words : words.revision < fixed.revision ? words : fixed;
    return { ...x.body, revision: x.revision, recorded: x.recorded, closed, carried: o?.carried ?? 0, answer: o?.answer ?? null };
  });
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
}

/** 4.4 (G5): the items a task's card names that are still open, as its cards list them (the Constructor fixes them; the Reviewer answers each). */
export function takenItems(events: readonly Ev[], names: readonly string[] | undefined): CardItem[] {
  if (names === undefined || names.length === 0) return [];
  const byId = new Map(riskItemsOf(events).map((i) => [i.id, i]));
  return names.flatMap((id) => {
    const i = byId.get(id);
    return i === undefined || i.closed !== null ? [] : [{ id, kind: i.kind, text: i.text, from: `task ${i.task}, attempt ${i.attempt}` }];
  });
}

/** Whether an id names an item of the mission (recorded, or a sentence of an acceptance with risk). */
export function itemIds(events: readonly Ev[]): Set<string> {
  return new Set(riskItemsOf(events).map((i) => i.id));
}
