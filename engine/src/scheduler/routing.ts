// The next step after a hand-back (design 6.2 "交回之后的去向"): every result has a definite
// next step, nothing waits forever.
//
//   accepted, still on the latest versions            -> continue by its label
//   accepted, a basis or prerequisite moved on during execution
//                                    stable mode      -> re-acceptance (or rerun) on the new versions
//                                    fast mode        -> continue, "not fully proven"
//                                    basis withdrawn  -> the Secretary judges whether to re-plan
//   quarantined                                       -> "needs disposition": the Secretary restarts
//                                                        (within the 6.5 cap), abandons or escalates
//   continuation refused (5.2 part 5), renewal refused (5.3)
//                                                     -> a full review instead (a normal branch)
//
// An ordinary revision during execution never rejects a result (6.1 review, §14 item 8): the
// ledger accepts it bound to the versions it actually used, and the evaluator's label shows
// the degradation. This module reads that label and picks the step.

import type { Label } from '../evaluator/semantics.ts';

export type NextStep =
  | { readonly kind: 'continue'; readonly label: Label }
  | { readonly kind: 'reaccept'; readonly label: Label; readonly reason: string }
  | { readonly kind: 'continue-unproven'; readonly label: Label }
  | { readonly kind: 'secretary'; readonly reason: string }
  /**
   * 5.2 part 5 / 5.3, a normal branch: the continuation was refused (or a renewal did not meet
   * the rule): the Secretary (or Architect) gives the position a full review, a new task with a
   * card that does not extend the earlier judgment.
   */
  | { readonly kind: 'full-review'; readonly reason: string }
  /**
   * WI-11 (v42): the step needed "proven" while the derived state could not be computed: it
   * ends with that reason instead of waiting; after the next successful publication the
   * program routes it again as a new attempt that records which one it retries.
   */
  | { readonly kind: 'ended'; readonly reason: string; readonly attempt: string; readonly retryOf: string | null };

export interface AcceptedFacts {
  readonly mode: 'stable' | 'fast';
  /** Labels of the objects the result bound, at a revision that includes the acceptance. */
  readonly labels: readonly Label[];
  /** Whether each judgment the result carried is current at that revision. */
  readonly judgmentsCurrent: readonly boolean[];
}

const ORDER: readonly Label[] = ['negated', 'basis-withdrawn', 'unaccepted', 'not-fully-proven', 'proven'];

function worst(labels: readonly Label[]): Label {
  let w: Label = 'proven';
  for (const l of labels) if (ORDER.indexOf(l) < ORDER.indexOf(w)) w = l;
  return w;
}

export function routeAccepted(f: AcceptedFacts): NextStep {
  const label = worst(f.labels);
  if (label === 'basis-withdrawn') return { kind: 'secretary', reason: 'a basis of the result was withdrawn during execution: re-plan?' };
  const stale = f.judgmentsCurrent.some((c) => !c) || label === 'not-fully-proven';
  if (!stale) return { kind: 'continue', label };
  if (f.mode === 'stable') return { kind: 'reaccept', label, reason: 'a basis or prerequisite has a new version: re-accept (or rerun) on it' };
  return { kind: 'continue-unproven', label };
}

export function routeFullReview(reason: string): NextStep {
  return { kind: 'full-review', reason };
}

export function routeQuarantined(reason: string): NextStep {
  return { kind: 'secretary', reason: `quarantined (${reason}): restart within the cap, abandon, or escalate` };
}
