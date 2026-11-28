// 4.4 (F10, P12): the health of the review seat: a change of the Reviewer's filler can change how
// strictly standards are judged, and no read showed it. `mp read reviews <mission>` gives the share of pass, rework and needs-decision of the mission's accepted Reviewer
// hand-backs, per filler of the Reviewer seat and per week, and the filler changes. When the pass share
// of the last REVIEW_WINDOW reviews, all by the filler now in the seat, is under half of the pass share of
// the REVIEW_WINDOW reviews before the change, the Secretary's loop is told once per change, with a notice
// that only informs (the PM design keeps operating detail away from the PM). Nothing is held: a stricter
// filler and harder tasks cannot be told apart from these numbers (the plan's residual for P12).

import { canonicalJson } from '../common/hash.ts';
import type { MissionId } from '../common/ids.ts';
import { noticeAlertId } from '../flow/context.ts';
import { listDispatches, type Db, type DispatchInfo, type Filler } from '../memory/index.ts';
import type { ProcessContext } from './context.ts';
import { handbackDoc, raiseNotice } from './ports.ts';

/** How many reviews each side of a filler change is compared on. */
export const REVIEW_WINDOW = 20;
/** The fewest reviews before a change the comparison needs (fewer: no notice). */
export const REVIEW_BEFORE_MIN = 10;
/** The notice category of a fall in the pass share after a change of filler. */
export const REVIEW_HEALTH = 'review-health';

export type ReviewVerdict = 'pass' | 'rework' | 'needs-decision';

/** One accepted Reviewer hand-back. */
export interface ReviewRow {
  readonly dispatch: string;
  readonly task: string;
  readonly filler: string;
  readonly verdict: ReviewVerdict;
  /** When it was handed back (ms). */
  readonly at: number;
}

export interface VerdictShares {
  readonly reviews: number;
  readonly pass: number;
  readonly rework: number;
  readonly needsDecision: number;
}

export interface FillerChange {
  /** The position (1-based) of the first review by the new filler. */
  readonly at: number;
  readonly from: string;
  readonly to: string;
  readonly dispatch: string;
  /** The reviews before the change compared (at most REVIEW_WINDOW) and their pass count. */
  readonly before: VerdictShares;
  /** The reviews since the change, up to the latest REVIEW_WINDOW, all by the new filler. */
  readonly since: VerdictShares;
  /** The pass share since fell under half of the share before, on full windows. */
  readonly fell: boolean;
}

export interface ReviewHealth {
  readonly mission: string;
  readonly all: VerdictShares;
  readonly byFiller: ReadonlyArray<{ readonly filler: string } & VerdictShares>;
  readonly byWeek: ReadonlyArray<{ readonly week: string } & VerdictShares>;
  readonly changes: readonly FillerChange[];
}

/** A filler as a name ("harness/model"), or "unknown" when the dispatch named none. */
export function fillerName(f: Filler | null): string {
  if (f === null) return 'unknown';
  return f.model !== null && f.model !== undefined && f.model !== '' ? `${f.harness}/${f.model}` : f.harness;
}

/** The ISO week of a time, as "2026-W47" (UTC, weeks from Monday). */
export function isoWeek(ms: number): string {
  const d = new Date(ms);
  // the Thursday of its week decides the year; week 1 holds January 4
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3));
  const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function shares(rows: readonly ReviewRow[]): VerdictShares {
  return { reviews: rows.length, pass: rows.filter((r) => r.verdict === 'pass').length, rework: rows.filter((r) => r.verdict === 'rework').length, needsDecision: rows.filter((r) => r.verdict === 'needs-decision').length };
}

/** The mission's accepted Reviewer hand-backs, in the order they were claimed, read in one snapshot (`db`). */
export function reviewRows(db: Db, data: { text(h: string): string }, mission: string): ReviewRow[] {
  const out: ReviewRow[] = [];
  let after: number | undefined;
  for (;;) {
    const page = listDispatches(db, { mission: mission as MissionId, ...(after !== undefined ? { after } : {}), limit: 1000 });
    for (const d of page) {
      const row = reviewRow(data, d);
      if (row !== null) out.push(row);
    }
    if (page.length < 1000) break;
    after = Number(page.at(-1)!.claimedRevision);
  }
  return out;
}

function reviewRow(data: { text(h: string): string }, d: DispatchInfo): ReviewRow | null {
  if (d.seat !== 'reviewer' || d.handback !== 'accepted') return null;
  const verdict = (handbackDoc(data, d)?.fields as { verdict?: unknown } | null)?.verdict;
  if (verdict !== 'pass' && verdict !== 'rework' && verdict !== 'needs-decision') return null;
  return { dispatch: d.dispatch, task: d.task, filler: fillerName(d.handbackFiller ?? d.filler), verdict, at: d.updatedAt };
}

/** The health of the review seat on a mission, from its rows (reviewRows). */
export function reviewHealth(mission: string, rows: readonly ReviewRow[]): ReviewHealth {
  const group = <K extends string>(key: (r: ReviewRow) => K): Array<[K, ReviewRow[]]> => {
    const m = new Map<K, ReviewRow[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return [...m.entries()];
  };
  const changes: FillerChange[] = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.filler === rows[i - 1]!.filler) continue;
    let end = i;
    while (end < rows.length && rows[end]!.filler === rows[i]!.filler) end++;
    const run = rows.slice(i, end);
    const before = shares(rows.slice(Math.max(0, i - REVIEW_WINDOW), i));
    const since = shares(run.slice(-REVIEW_WINDOW));
    const fell = before.reviews >= REVIEW_BEFORE_MIN && since.reviews >= REVIEW_WINDOW && before.pass > 0 && since.pass / since.reviews < before.pass / before.reviews / 2;
    changes.push({ at: i + 1, from: rows[i - 1]!.filler, to: rows[i]!.filler, dispatch: rows[i]!.dispatch, before, since, fell });
  }
  return {
    mission,
    all: shares(rows),
    byFiller: group((r) => r.filler).map(([filler, xs]) => ({ filler, ...shares(xs) })),
    byWeek: group((r) => isoWeek(r.at)).sort(([a], [b]) => a.localeCompare(b)).map(([week, xs]) => ({ week, ...shares(xs) })),
    changes,
  };
}

const pct = (n: number, of: number): string => `${of === 0 ? 0 : Math.round((100 * n) / of)}%`;

/** One line of shares, as `mp read reviews` prints it. */
export function sharesLine(s: VerdictShares): string {
  return `${s.reviews} review${s.reviews === 1 ? '' : 's'}: pass ${pct(s.pass, s.reviews)} (${s.pass}), rework ${pct(s.rework, s.reviews)} (${s.rework}), needs-decision ${pct(s.needsDecision, s.reviews)} (${s.needsDecision})`;
}

/**
 * After a Reviewer's hand-back (process/seat.ts): the latest change of filler on the mission, when the
 * pass share of the last REVIEW_WINDOW reviews since it fell under half of the share before it, is told
 * to the Secretary's loop once (raiseNotice is idempotent by its key), as a notice that only informs.
 * Read and raised in one write. Best effort: it never refuses the hand-back.
 */
export function tellReviewHealth(ctx: ProcessContext, mission: string): void {
  try {
    const seen = ctx.memory.read((db) => {
      const rows = reviewRows(db, ctx.memory.data, mission);
      const c = reviewHealth(mission, rows).changes.at(-1);
      // told already: nothing to write
      return c === undefined || !c.fell || db.stmt("SELECT 1 FROM log WHERE kind = 'alert' AND json_extract(record, '$.alert') = ? LIMIT 1").get(noticeAlertId({ mission: mission as MissionId, category: REVIEW_HEALTH, key: `${mission}:${c.dispatch}` })) !== undefined ? null : { change: c, rows: rows.length };
    });
    if (seen === null) return;
    // the notice is written with its journal entry under an operation of its own (one per state of the record read); what it says is read again in that write
    ctx.memory.write({ op: `review-health:${mission}:${seen.change.dispatch}:${seen.rows}`, payload: { mission, change: seen.change.dispatch } }, (tx) => {
      const change = reviewHealth(mission, reviewRows(tx, tx.data, mission)).changes.at(-1);
      if (change === undefined || !change.fell || change.dispatch !== seen.change.dispatch) return;
      raiseNotice(tx, {
        mission: mission as MissionId,
        category: REVIEW_HEALTH,
        wi: null,
        key: `${mission}:${change.dispatch}`,
        trigger: `mission ${mission}: after the Reviewer's filler changed from ${change.from} to ${change.to} (review ${change.at}), the pass share of its last ${change.since.reviews} reviews is ${pct(change.since.pass, change.since.reviews)}, under half of the ${pct(change.before.pass, change.before.reviews)} of the ${change.before.reviews} before`,
        defaultAction: `nothing is held; a stricter filler and harder tasks cannot be told apart from these numbers alone (mp read reviews ${mission})`,
        detail: { mission, change: JSON.parse(canonicalJson(change)) as unknown },
      });
    });
  } catch {
    /* a notice that only informs: the hand-back stands without it */
  }
}
