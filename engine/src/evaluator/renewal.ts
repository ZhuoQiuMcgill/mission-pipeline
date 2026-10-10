// Mechanical evidence renewal (design 5.3 "证据续期"): after an environment
// change and a rerun, the program may record a renewal that makes the original
// judgment current again, without a new seat judgment, only when all hold:
//   - both the original and the new evidence are closed runs;
//   - every field the judgment uses is exactly equal in both;
//   - the judgment uses no timing field: "a judgment that uses duration can never
//     be renewed mechanically" holds by rule, not by luck (rounded timings are
//     often equal; core review r2 F12). Timing fields are named `time:<name>`, or
//     one of the conventional names in TIMING_FIELDS;
//   - the judgment uses no statistical inference and no external state.
// Open and sampling runs are never renewed. Everything else needs a new judgment.

import type { EvidenceRecord } from '../common/records.ts';

/** What the judgment's card declared about its use of evidence (5.3). */
export interface EvidenceUse {
  /** The evidence fields the judgment actually uses, e.g. ['exit', 'outputHash']. Must be non-empty. */
  readonly fields: readonly string[];
  /** The judgment relies on statistical inference or on external state. */
  readonly statisticalOrExternal: boolean;
}

/** Conventional names of timing fields; any field named `time:<...>` is a timing field too. */
export const TIMING_FIELDS: ReadonlySet<string> = new Set(['ms', 'duration', 'durationMs', 'elapsed', 'elapsedMs', 'wallMs', 'cpuMs', 'seconds']);

export function isTimingField(name: string): boolean {
  return name.startsWith('time:') || TIMING_FIELDS.has(name);
}

export type RenewalDecision =
  | { readonly renew: true }
  | {
      readonly renew: false;
      readonly reason: 'not-closed' | 'statistical-or-external' | 'no-declared-fields' | 'uses-timing' | 'field-missing' | 'field-differs';
      readonly field?: string;
    };

export function renewalDecision(original: EvidenceRecord, replacement: EvidenceRecord, use: EvidenceUse): RenewalDecision {
  if (original.runClass !== 'closed' || replacement.runClass !== 'closed') return { renew: false, reason: 'not-closed' };
  if (use.statisticalOrExternal) return { renew: false, reason: 'statistical-or-external' };
  if (use.fields.length === 0) return { renew: false, reason: 'no-declared-fields' };
  for (const f of use.fields) if (isTimingField(f)) return { renew: false, reason: 'uses-timing', field: f };
  for (const f of use.fields) {
    if (!Object.hasOwn(original.fields, f) || !Object.hasOwn(replacement.fields, f)) return { renew: false, reason: 'field-missing', field: f };
    const a = original.fields[f];
    const b = replacement.fields[f];
    if (a !== b) return { renew: false, reason: 'field-differs', field: f };
  }
  return { renew: true };
}
