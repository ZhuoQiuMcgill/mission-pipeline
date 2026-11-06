// Waivers of a process check (4.1.3, E-2): the user's words waive a mission's plan reviews (the
// feasibility review and Calibrator ②), for the whole mission or for one detailed plan version, and
// the waiver is on the record. The program never waives a check on its own, and a project setting
// is not a waiver: the config key `planReviewsWaived` (field 4.1.2) is still read so missions in the
// middle of their re-plans go on, labelled "waived by config; no words on record".
//
//   record        `mp pm waive <mission> plan-reviews [--plan <dplan>] (--words W-<n> | --authority <item>)`
//                 writes event "reviews-waiver" on the plan line (key "plan-reviews#<n>"): the scope
//                 (the mission, or one detailed plan version), who decided (the words entry or the
//                 authorization item in force) and the reason. `--withdraw` writes the same event
//                 with action "withdraw": later plans get their reviews again (and the config key no
//                 longer waives them); a plan already in effect stays in effect.
//   the plan      planning reads the waiver in force through planReviewsWaiver (the one resolver).
//                 A plan that takes effect waived records it on its "effective" event
//                 (`reviewsWaived`, with the reviews it went without); a plan that took effect before
//                 4.1.3 without any Calibrator ② outcome was waived by the config key (the only way it
//                 could), and reads so, derived from the record, not from config history.
//   the label     "this plan took effect without its reviews (feasibility, Calibrator ②), on W-n":
//                 the plan's reads (mp read show, mp read why), the Architect's revision card and the
//                 close snapshot show it.
// Only the plan reviews are waivable: the command names the check so a later release can add one.

import { PLAN_LINE } from './plandoc.ts';
import { eventsOf, objectRecord, type FlowCtx } from './context.ts';

/** The one check a waiver names in 4.1.3. */
export const WAIVABLE_CHECKS = ['plan-reviews'] as const;
export type WaivableCheck = (typeof WAIVABLE_CHECKS)[number];

/** The event a waiver (or its withdrawal) is recorded as, on the plan line. */
export const REVIEWS_WAIVER = 'reviews-waiver';

/** A waiver or a withdrawal on the record (line "plan", event "reviews-waiver", key "plan-reviews#<n>"). */
export interface ReviewsWaiverBody {
  readonly check: WaivableCheck;
  readonly n: number;
  readonly action: 'waive' | 'withdraw';
  /** waive: one detailed plan version, or null for every plan of the mission not in effect yet. */
  readonly dplan: string | null;
  readonly by: 'words' | 'authority';
  /** The words entry (W-<n>) or the authorization item line in force. */
  readonly ref: string;
  readonly reason: string | null;
  readonly scopeOnly?: boolean;
}


/** What waived a plan's reviews: the user's words, an authorization item in force, or (field 4.1.2) the config key. */
export interface PlanReviewsWaiver {
  readonly by: 'words' | 'authority' | 'config';
  /** W-<n>, the authorization item line, or "planReviewsWaived". */
  readonly ref: string;
  readonly reason: string | null;
  /** The reviews the plan took effect without (recorded when it took effect; null: not in effect yet). */
  readonly skipped?: readonly string[];
}

export const CONFIG_KEY = 'planReviewsWaived';

type PlanEvent = { readonly event: string; readonly key: string; readonly body: unknown };

/** The reviews' names as people read them. */
export function reviewNames(reviews: readonly string[]): string {
  return reviews.map((r) => (r === 'calibrator-2' ? 'Calibrator ②' : r === 'feasibility' ? 'feasibility' : r)).join(', ');
}

/** Who decided, in words: "on W-3", "under authorization item.m1.a1", "waived by config `planReviewsWaived`; no words on record". */
export function waiverBy(w: PlanReviewsWaiver): string {
  return w.by === 'words' ? `on ${w.ref}` : w.by === 'authority' ? `under authorization ${w.ref}` : `waived by config \`${CONFIG_KEY}\`; no words on record`;
}

/** The honest label of a plan waived (4.1.3, E-2). In effect: "this plan took effect without its reviews (...), on W-n"; not yet: what will happen. */
export function waiverLabel(w: PlanReviewsWaiver): string {
  const reason = w.reason !== null && w.reason !== '' ? `; reason: ${w.reason}` : '';
  if (w.skipped !== undefined) return `this plan took effect without its reviews (${reviewNames(w.skipped.length > 0 ? w.skipped : ['calibrator-2'])}), ${waiverBy(w)}${reason}`;
  return `its reviews (feasibility, Calibrator ②) are waived, ${waiverBy(w)}${reason}: it takes effect after the mechanical checks and the order ruling`;
}

/**
 * The waiver of one detailed plan version's reviews, from the plan line's events in record order (pure:
 * the flow, the reads and the close snapshot all use it through planReviewsWaiver or with their rows).
 *   - in effect: what its "effective" event recorded; before 4.1.3, a plan that took effect without any
 *     Calibrator ② outcome was waived by the config key (derived from the record);
 *   - not in effect: the latest waiver on the record whose scope covers it, unless withdrawn since;
 *     else the config key (field 4.1.2), unless a withdrawal is on the record.
 * `reviews`: the reviews fixed with the plan version's object (null: not recorded yet).
 */
export function planReviewsWaiverIn(events: readonly PlanEvent[], mission: string, dplan: string, config: readonly string[], reviews: readonly string[] | null): PlanReviewsWaiver | null {
  const eff = events.find((e) => e.event === 'effective' && e.key === dplan);
  if (eff !== undefined) {
    const recorded = (eff.body as { reviewsWaived?: PlanReviewsWaiver }).reviewsWaived;
    if (recorded !== undefined) return recorded;
    const hadCal2 = events.some((e) => e.event === 'cal2' && (e.body as { dplan?: string }).dplan === dplan);
    if (hadCal2) return null;
    const hadFeasibility = events.some((e) => e.event === 'feasibility' && (e.body as { dplan?: string }).dplan === dplan);
    const skipped = [...((reviews ?? ['feasibility']).includes('feasibility') && !hadFeasibility ? ['feasibility'] : []), 'calibrator-2'];
    return { by: 'config', ref: CONFIG_KEY, reason: null, skipped };
  }
  let inForce: ReviewsWaiverBody | null = null;
  let withdrawn = false;
  for (const e of events) {
    if (e.event !== REVIEWS_WAIVER) continue;
    const b = e.body as ReviewsWaiverBody;
    if (b.check !== 'plan-reviews') continue;
    if (b.action === 'withdraw') {
      if (b.scopeOnly !== true || b.dplan === null || b.dplan === dplan) {inForce = null; withdrawn = true;}
    } else if (b.dplan === null || b.dplan === dplan) inForce = b;
  }
  if (inForce !== null) return { by: inForce.by, ref: inForce.ref, reason: inForce.reason };
  if (!withdrawn && (config.includes(mission) || config.includes(dplan))) return { by: 'config', ref: CONFIG_KEY, reason: null };
  return null;
}

/** The waivers on the record still in force (for `mp pm waive --withdraw`): the latest of each scope since the last withdrawal. */
export function waiversInForce(events: readonly PlanEvent[]): ReviewsWaiverBody[] {
  let out: ReviewsWaiverBody[] = [];
  for (const e of events) {
    if (e.event !== REVIEWS_WAIVER) continue;
    const b = e.body as ReviewsWaiverBody;
    if (b.action === 'withdraw') out = b.scopeOnly === true ? out.filter((w) => w.dplan !== b.dplan) : [];
    else out = [...out.filter((x) => x.dplan !== b.dplan), b];
  }
  return out;
}

/**
 * The one resolver of a plan's review waiver (4.1.3, E-2): `{ by, ref, reason }` (with the reviews it
 * went without once in effect), or null. Planning decides with it; the reads, the Architect's card
 * and the close snapshot label with it.
 */
export async function planReviewsWaiver(ctx: FlowCtx, dplan: string): Promise<PlanReviewsWaiver | null> {
  const raw = await eventsOf(ctx, PLAN_LINE);
  const events = raw.filter((e) => {if (e.event !== REVIEWS_WAIVER) return true; const w = e.body as ReviewsWaiverBody; return w.action === 'withdraw' || w.by !== 'words' || ctx.ports.wordsAuthority === undefined || ctx.ports.wordsAuthority(w.ref, ctx.mission) !== null;});
  const reviews = (await objectRecord(ctx, dplan))?.reviews.map((r) => r.review) ?? null;
  return planReviewsWaiverIn(events, ctx.mission, dplan, ctx.ports.project?.planReviewsWaived ?? [], reviews);
}
