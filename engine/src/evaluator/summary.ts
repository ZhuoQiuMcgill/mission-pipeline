// The layer-0 and layer-1 summary of the stored labels (design 10.2; 4.1 §4.1,
// §8.1-8.3), read from the label tables in one read, with how current they are.
// Layer 0 shows the derived part (label counts, proof debt, cycles); layer 1
// joins the label of every target and the state of every operation that needs
// "proven" with the records (which task produced which objects and operations).

import type { ProofOpKind } from '../common/records.ts';
import type { Db } from '../memory/index.ts';
import { LABEL_RULES, labelStatus, type LabelStatus } from './labels.ts';
import type { FixState, Label } from './semantics.ts';

export const SUMMARY_FORMAT = 'mp41.label-summary.v1';

/** The summary read from the stored labels (4.1 §4.1), with how current they are. */
export interface StoredSummary {
  readonly format: typeof SUMMARY_FORMAT;
  /** The label revision this summary describes (every value below is at it). */
  readonly revision: number;
  /** The memory's head when the summary was read. */
  readonly head: number | null;
  /** ISO time the summary was read. */
  readonly writtenAt: string;
  readonly rules: string;
  readonly targets: {
    readonly total: number;
    readonly labels: Readonly<Record<Label, number>>;
    /** Every object and proof unit, by label, ids sorted (layer 1). */
    readonly byLabel: Readonly<Record<Label, readonly string[]>>;
  };
  readonly ops: {
    readonly total: number;
    readonly allProven: number;
    readonly notAllProven: number;
    readonly executed: number;
    readonly executedNotAllProven: number;
    /** Every operation that needs "proven" (layer 1). */
    readonly byOp: Readonly<Record<string, { readonly kind: ProofOpKind; readonly allProven: boolean; readonly executedAsOf: number | null }>>;
  };
  readonly judgments: { readonly total: number; readonly current: number; readonly notCurrent: number };
  readonly fixes: Readonly<Record<FixState, number>>;
  /** Layer 0's proof debt: executed operations no longer all proven. */
  readonly proofDebt: number;
  /** Dependency cycles in the stored state (WI-16). */
  readonly cycles: number;
  readonly status: LabelStatus;
}

/**
 * Layer 0's derived part and layer 1's labels (10.2), from the stored label
 * tables in one read: label counts and every target by label, every operation
 * that needs "proven", judgment currency counts, fix states, the proof debt
 * (executed operations no longer all proven) and dependency cycles. While the
 * labels are recomputing (`status.recomputing`), these are the last labels.
 */
export function labelSummary(db: Db, o: { readonly now?: Date } = {}): StoredSummary {
  const status = labelStatus(db);
  const labels: Record<Label, number> = { negated: 0, 'basis-withdrawn': 0, unaccepted: 0, 'not-fully-proven': 0, proven: 0 };
  const byLabel: Record<Label, string[]> = { negated: [], 'basis-withdrawn': [], unaccepted: [], 'not-fully-proven': [], proven: [] };
  let targets = 0;
  for (const r of db.stmt('SELECT target, label FROM lbl_labels ORDER BY target').all() as Array<{ target: string; label: Label }>) {
    labels[r.label]++;
    byLabel[r.label].push(r.target);
    targets++;
  }
  let ops = 0;
  let allProven = 0;
  let executed = 0;
  let executedNotAllProven = 0;
  const byOp: Record<string, { kind: ProofOpKind; allProven: boolean; executedAsOf: number | null }> = {};
  for (const r of db.stmt('SELECT o.op AS op, o.kind AS kind, o.all_proven AS all_proven, e.as_of AS as_of FROM lbl_ops o LEFT JOIN lbl_executed e ON e.op = o.op ORDER BY o.op').all() as Array<{
    op: string;
    kind: ProofOpKind;
    all_proven: number | null;
    as_of: number | null;
  }>) {
    const proven = r.all_proven === 1;
    ops++;
    if (proven) allProven++;
    if (r.as_of !== null) {
      executed++;
      if (!proven) executedNotAllProven++;
    }
    byOp[r.op] = { kind: r.kind, allProven: proven, executedAsOf: r.as_of === null ? null : Number(r.as_of) };
  }
  // Judgment facts are the "j:" rows of lbl_facts (a key range of its primary key).
  const j = db.stmt("SELECT COUNT(*) AS n, COALESCE(SUM(holds), 0) AS current FROM lbl_facts WHERE node >= 'j:' AND node < 'j;'").get() as { n: number; current: number };
  const fixes: Record<FixState, number> = { fixed: 0, 'fixed-not-fully-proven': 0, unfixed: 0 };
  for (const r of db.stmt('SELECT state, COUNT(*) AS n FROM lbl_fixes GROUP BY state').all() as Array<{ state: FixState; n: number }>) fixes[r.state] = Number(r.n);
  const cycles = Number((db.stmt('SELECT COUNT(*) AS n FROM lbl_cycles').get() as { n: number }).n);
  return {
    format: SUMMARY_FORMAT,
    revision: status.revision,
    head: status.head,
    writtenAt: (o.now ?? new Date()).toISOString(),
    rules: LABEL_RULES,
    targets: { total: targets, labels, byLabel },
    ops: { total: ops, allProven, notAllProven: ops - allProven, executed, executedNotAllProven, byOp },
    judgments: { total: Number(j.n), current: Number(j.current), notCurrent: Number(j.n) - Number(j.current) },
    fixes,
    proofDebt: executedNotAllProven,
    cycles,
    status,
  };
}

