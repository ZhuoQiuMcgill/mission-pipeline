// Mechanical evidence renewal (design 5.3 "证据续期", 4.1 §6.5): after an
// environment change and a rerun, the program may record a renewal that makes
// the original judgment current again, without a new seat judgment, only when
// all hold (v51 5.3 with "closed" read as "declared"):
//   - both the original and the new evidence are declared runs (4.1 §6.5: run
//     by `mp` on a clean checkout of the candidate with the card's declared
//     commands, no network, not sampled);
//   - every field the judgment uses is exactly equal in both;
//   - the judgment uses no timing field: "a judgment that uses duration can never
//     be renewed mechanically" holds by rule, not by luck (rounded timings are
//     often equal; core review r2 F12). Timing fields are named `time:<name>`, or
//     one of the conventional names in TIMING_FIELDS;
//   - the judgment uses no statistical inference and no external state (its
//     declaration says so, and it uses no `stat:` or `ext:` field).
// Sampling and other runs are never renewed. Everything else needs a new
// judgment of the same review position.
//
// The same field names decide which runs a judgment may rest on at all (4.1
// §6.5): a judgment that uses a timing, statistical or external field may cite
// only sampling runs (`usesSampledFields`; the label store refuses the record
// otherwise).

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

/** A statistical (`stat:<name>`) or external-state (`ext:<name>`) field: one observation among possible others (4.1 §6.5). */
export function isStatisticalOrExternalField(name: string): boolean {
  return name.startsWith('stat:') || name.startsWith('ext:');
}

/**
 * Why a judgment can rest only on sampling runs (4.1 §6.5), or null when it can
 * rest on any run: it declares statistical inference or external state, or it
 * uses a timing, statistical or external field.
 */
export function usesSampledFields(use: EvidenceUse): { readonly reason: 'statistical-or-external' | 'uses-timing' | 'uses-statistical-or-external-field'; readonly field?: string } | null {
  if (use.statisticalOrExternal) return { reason: 'statistical-or-external' };
  for (const f of use.fields) if (isTimingField(f)) return { reason: 'uses-timing', field: f };
  for (const f of use.fields) if (isStatisticalOrExternalField(f)) return { reason: 'uses-statistical-or-external-field', field: f };
  return null;
}

export type RenewalDecision =
  | { readonly renew: true }
  | {
      readonly renew: false;
      readonly reason: 'not-declared' | 'statistical-or-external' | 'no-declared-fields' | 'uses-timing' | 'field-missing' | 'field-differs';
      readonly field?: string;
    };

export function renewalDecision(original: EvidenceRecord, replacement: EvidenceRecord, use: EvidenceUse): RenewalDecision {
  if (original.runClass !== 'declared' || replacement.runClass !== 'declared') return { renew: false, reason: 'not-declared' };
  if (use.statisticalOrExternal) return { renew: false, reason: 'statistical-or-external' };
  if (use.fields.length === 0) return { renew: false, reason: 'no-declared-fields' };
  for (const f of use.fields) if (isTimingField(f)) return { renew: false, reason: 'uses-timing', field: f };
  for (const f of use.fields) if (isStatisticalOrExternalField(f)) return { renew: false, reason: 'statistical-or-external', field: f };
  for (const f of use.fields) {
    if (!Object.hasOwn(original.fields, f) || !Object.hasOwn(replacement.fields, f)) return { renew: false, reason: 'field-missing', field: f };
    const a = original.fields[f];
    const b = replacement.fields[f];
    if (a !== b) return { renew: false, reason: 'field-differs', field: f };
  }
  return { renew: true };
}
