// Evaluator checkpoints (design 6.1 "检查点"): when to write one, the summary
// written beside it, and whether the disk pool has room for it.
//
// - A checkpoint is written after a publication once `every` publications have
//   accumulated, or once `intervalMs` (default 10 minutes) has passed since the
//   last checkpoint with at least one publication not yet saved. The time
//   trigger is checked on every loop iteration, idle ones included, so the last
//   publication before a quiet period is saved within the interval.
// - The summary (`<checkpoint>.summary.json`) is what readers get while the
//   evaluator is down or in its fault state (6.1, WI-11; core review r3 F19):
//   the revision it describes, when it was written, the ledger head then, the
//   hash of the checkpoint it belongs to, the derived part of layer 0 (label
//   counts, proof debt, cycles) and what layer 1 needs per requirement and task:
//   the label of every target (grouped by label) and the state of every
//   operation that needs "proven". The CLI joins these with the base records
//   (which task produced which objects and operations) and shows the lag behind
//   the current head. It is written after the checkpoint, each with an atomic
//   rename, so the previous pair survives until the new one is complete.
// - Disk pool (6.1; r3 F20): the pool must hold the previous checkpoint and the
//   new one at once, and a write must leave the disk's reserve free. When it
//   does not, checkpoint writes pause (publication goes on) and the supervisor
//   raises WI-11 ("resource pool insufficient") instead of filling the disk.

import { readFileSync, statSync, statfsSync } from 'node:fs';
import { writeFileAtomic } from '../common/fsx.ts';
import type { ProofOpKind } from '../common/records.ts';
import type { DerivedState, FixState, Label } from './semantics.ts';

export const DEFAULT_CHECKPOINT_INTERVAL_MS = 10 * 60_000;
const FAILED_WRITE_PAUSE_MS = 60_000;

export interface CheckpointScheduleOptions {
  /** Write after this many publications not yet saved. */
  readonly every: number;
  /** Write once this long has passed since the last checkpoint and a publication is not yet saved. */
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export class CheckpointSchedule {
  private readonly every: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private unsaved = 0;
  private lastWritten: number;
  private blockedUntil = 0;

  constructor(o: CheckpointScheduleOptions) {
    this.every = Math.max(1, o.every);
    this.intervalMs = o.intervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
    this.now = o.now ?? Date.now;
    this.lastWritten = this.now();
  }

  /** A revision was published. */
  published(): void {
    this.unsaved++;
  }

  /** Publications not yet in a checkpoint. */
  pending(): number {
    return this.unsaved;
  }

  /** Is a checkpoint due now? Never without a publication to save, nor while backing off after a failed write. */
  due(): 'count' | 'interval' | null {
    if (this.unsaved === 0 || this.now() < this.blockedUntil) return null;
    if (this.unsaved >= this.every) return 'count';
    if (this.now() - this.lastWritten >= this.intervalMs) return 'interval';
    return null;
  }

  /** A checkpoint was written. */
  written(): void {
    this.unsaved = 0;
    this.lastWritten = this.now();
    this.blockedUntil = 0;
  }

  /** A write failed (e.g. the disk pool is full): try again after a pause, not on every loop. */
  failed(): void {
    this.blockedUntil = this.now() + Math.min(this.intervalMs, FAILED_WRITE_PAUSE_MS);
  }
}

export const SUMMARY_FORMAT = 'mp4.evaluator-summary.v2';

const LABELS: readonly Label[] = ['negated', 'basis-withdrawn', 'unaccepted', 'not-fully-proven', 'proven'];

export interface CheckpointSummary {
  readonly format: typeof SUMMARY_FORMAT;
  /** The published revision this summary describes (every value below is at it). */
  readonly revision: number;
  /** The ledger head when the summary was written. */
  readonly head: number | null;
  /** ISO time the summary was written. */
  readonly writtenAt: string;
  readonly rules: string;
  /** Hash of the checkpoint body written with it (null when written alone). */
  readonly checkpoint: string | null;
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
  /** Dependency cycles in the published state (WI-16). */
  readonly cycles: number;
}

export function summaryPath(checkpointPath: string): string {
  return `${checkpointPath}.summary.json`;
}

export function summarize(
  state: DerivedState,
  o: { readonly head: number | null; readonly rules: string; readonly cycles: number; readonly checkpoint?: string | null; readonly now?: Date },
): CheckpointSummary {
  const labels: Record<Label, number> = { negated: 0, 'basis-withdrawn': 0, unaccepted: 0, 'not-fully-proven': 0, proven: 0 };
  const byLabel: Record<Label, string[]> = { negated: [], 'basis-withdrawn': [], unaccepted: [], 'not-fully-proven': [], proven: [] };
  let targets = 0;
  for (const [id, t] of state.targets) {
    labels[t.label]++;
    byLabel[t.label].push(id);
    targets++;
  }
  for (const l of LABELS) byLabel[l].sort();
  let ops = 0;
  let allProven = 0;
  let executed = 0;
  let executedNotAllProven = 0;
  const byOp: Record<string, { kind: ProofOpKind; allProven: boolean; executedAsOf: number | null }> = {};
  for (const id of [...state.ops.keys()].sort()) {
    const op = state.ops.get(id)!;
    ops++;
    if (op.allProven) allProven++;
    if (op.executedAsOf !== null) {
      executed++;
      if (!op.allProven) executedNotAllProven++;
    }
    byOp[id] = { kind: op.kind, allProven: op.allProven, executedAsOf: op.executedAsOf };
  }
  let judgments = 0;
  let current = 0;
  for (const c of state.judgmentCurrent.values()) {
    judgments++;
    if (c) current++;
  }
  const fixes: Record<FixState, number> = { fixed: 0, 'fixed-not-fully-proven': 0, unfixed: 0 };
  for (const f of state.fixes.values()) fixes[f]++;
  return {
    format: SUMMARY_FORMAT,
    revision: state.revision,
    head: o.head,
    writtenAt: (o.now ?? new Date()).toISOString(),
    rules: o.rules,
    checkpoint: o.checkpoint ?? null,
    targets: { total: targets, labels, byLabel },
    ops: { total: ops, allProven, notAllProven: ops - allProven, executed, executedNotAllProven, byOp },
    judgments: { total: judgments, current, notCurrent: judgments - current },
    fixes,
    proofDebt: executedNotAllProven,
    cycles: o.cycles,
  };
}

/**
 * A fault-time read from a summary (6.1: "读取返回最后一个成功检查点的摘要，并明确标出它
 * 的修订号落后多少"): the summary's revision, the current head, the lag, and a
 * lookup of one target's label or one operation's state at that revision.
 */
export interface FaultTimeView {
  readonly revision: number;
  readonly head: number;
  readonly lag: number;
  readonly writtenAt: string;
  label(target: string): Label | null;
  op(id: string): CheckpointSummary['ops']['byOp'][string] | null;
}

export function faultTimeView(summary: CheckpointSummary, head: number): FaultTimeView {
  const labelOf = new Map<string, Label>();
  for (const l of LABELS) for (const id of summary.targets.byLabel[l]) labelOf.set(id, l);
  return {
    revision: summary.revision,
    head,
    lag: Math.max(0, head - summary.revision),
    writtenAt: summary.writtenAt,
    label: (target) => labelOf.get(target) ?? null,
    op: (id) => (Object.hasOwn(summary.ops.byOp, id) ? summary.ops.byOp[id]! : null),
  };
}

// ---------------------------------------------------------------- the disk pool (6.1, r3 F20)

/** Default reserve a checkpoint write must leave free on its disk (the ledger may share it). */
export const DEFAULT_CHECKPOINT_RESERVE_BYTES = 256 * 2 ** 20;

/**
 * Is there room for a new checkpoint? The pool (if one is set) must hold the
 * previous checkpoint and the new one at once (the previous one is kept until
 * the new one is complete), and the write must leave `reserveBytes` free on
 * the disk. Returns null when there is room, else the reason.
 */
export function checkpointRoom(r: {
  readonly newBytes: number;
  readonly oldBytes: number;
  readonly poolBytes: number | null;
  readonly freeBytes: number | null;
  readonly reserveBytes: number;
}): string | null {
  if (r.poolBytes !== null && r.oldBytes + r.newBytes > r.poolBytes) {
    return `the checkpoint disk pool (${r.poolBytes} bytes) cannot hold the previous checkpoint (${r.oldBytes} bytes) and the new one (${r.newBytes} bytes) at once`;
  }
  if (r.freeBytes !== null && r.freeBytes - r.newBytes < r.reserveBytes) {
    return `writing the new checkpoint (${r.newBytes} bytes) would leave ${Math.max(0, r.freeBytes - r.newBytes)} bytes free on its disk, below the reserve of ${r.reserveBytes} bytes`;
  }
  return null;
}

/** Bytes available to this user on the filesystem holding `dir`, or null when unknown. */
export function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Size of a file, 0 when absent. */
export function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** The summary as written to disk. */
export function summaryText(summary: CheckpointSummary): string {
  return `${JSON.stringify(summary)}\n`;
}

/** Write the checkpoint, then its summary; each atomically. */
export function writeCheckpoint(checkpointPath: string, checkpoint: string, summary: CheckpointSummary): void {
  writeFileAtomic(checkpointPath, checkpoint);
  writeFileAtomic(summaryPath(checkpointPath), summaryText(summary));
}

/** The summary beside a checkpoint, or null when absent or unreadable (for the CLI when the evaluator is down). */
export function readCheckpointSummary(checkpointPath: string): CheckpointSummary | null {
  try {
    const s = JSON.parse(readFileSync(summaryPath(checkpointPath), 'utf8')) as CheckpointSummary;
    return s.format === SUMMARY_FORMAT && typeof s.revision === 'number' ? s : null;
  } catch {
    return null;
  }
}
