// 4.4 (G7): the planner's choice of a plan-review waiver, as a pure function with no imports, so the
// words' dependency lookup (memory/words.ts) and the reads use the very choice the planner makes.
// flow/waivers.ts re-exports it; planReviewsWaiverIn decides with it.

import type { ReviewsWaiverBody } from './waivers.ts';

type PlanEvent = { readonly event: string; readonly key: string; readonly body: unknown };

/**
 * The waiver on the record the planner applies to one plan not in effect yet: the latest that covers
 * it, unless a withdrawal that covers it came after. A withdrawal for the whole mission (dplan null)
 * covers every plan, also when it was written for the mission-wide waiver alone (scope-only).
 */
export function selectedWaiver(events: readonly PlanEvent[], dplan: string): { readonly waiver: ReviewsWaiverBody | null; readonly withdrawn: boolean } {
  let inForce: ReviewsWaiverBody | null = null;
  let withdrawn = false;
  for (const e of events) {
    if (e.event !== 'reviews-waiver') continue;
    const b = e.body as ReviewsWaiverBody;
    if (b.check !== 'plan-reviews') continue;
    if (b.action === 'withdraw') {
      if (b.scopeOnly !== true || b.dplan === null || b.dplan === dplan) {inForce = null; withdrawn = true;}
    } else if (b.dplan === null || b.dplan === dplan) inForce = b;
  }
  return { waiver: inForce, withdrawn };
}
