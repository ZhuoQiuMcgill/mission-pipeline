// The skeleton's own events (design 4.1 §3.2, §3.3, §5): what the memory
// records besides the base records of common/records.ts. Every change to a
// state table is the projection of one event appended in the same transaction
// (projection.ts), so the log rebuilds every table. The 4.0 service events that
// 4.1 keeps (stops, missions, intents, deliveries, notices, PM actions, landing
// phases) keep their 4.0 shapes; `op.receipt` now carries its response inline
// (the content store is gone), so it replaces the 4.0 shape.

import type { ContentHash } from '../common/ids.ts';
import type { BaseRecord } from '../common/records.ts';
import { LedgerError } from './errors.ts';

/** Who filled a seat or issued a PM command (§3.2 items 9 and 13): information only, never a condition (§2.1). */
export interface Filler {
  readonly harness: string;
  readonly model: string | null;
}

/** Where a copy of the folder lives (§3.3): the project path and the machine. */
export interface Place {
  readonly path: string;
  readonly machine: string;
}

/** What the checks after a move found (§3.3 step 5); lists are capped, the counts are exact. */
export interface MoveFindings {
  readonly chain: { readonly ok: boolean; readonly lastValid: number; readonly brokenAt: number | null; readonly reason: string | null };
  readonly git: GitStepOutcome;
  readonly leaves: { readonly checked: number; readonly missing: readonly string[]; readonly edited: readonly string[]; readonly missingCount: number; readonly editedCount: number };
  readonly commits: { readonly checked: number; readonly unreachable: readonly string[]; readonly unreachableCount: number; readonly skipped: string | null };
  readonly layout: readonly string[];
}

/** Step 2 of the recovery after a move. */
export type GitStepOutcome =
  | { readonly kind: 'repaired'; readonly worktrees: number }
  | { readonly kind: 'held'; readonly reason: string }
  | { readonly kind: 'no-repository' };

export type DispatchHandbackOutcome = 'accepted' | 'after-release' | 'after-stop';

export type MemoryEvent =
  /** The memory was created (`mp init`); the first event of the chain. */
  | { readonly kind: 'memory.init'; readonly format: string }
  /**
   * A committed operation (§4.1): its payload hash and its answer, so a retry
   * returns the same answer. `command` and `filler`: the `mp pm` command that
   * issued it and the PM's filler (§3.2 item 13).
   */
  | { readonly kind: 'op.receipt'; readonly op: string; readonly payloadHash: string; readonly response: string; readonly command?: string; readonly filler?: Filler | null }
  /** A step claimed by a dispatch (§5.1 step 2): the task leaves the queue. */
  | {
      readonly kind: 'dispatch.claimed';
      readonly dispatch: string;
      readonly task: string;
      readonly seat: string;
      readonly mission: string;
      readonly lineage: string;
      readonly capabilities: readonly string[];
      readonly filler: Filler | null;
      /** The dispatch's worktree, relative to the memory folder (`worktrees/<dispatch>`), or null. */
      readonly worktree: string | null;
      /** The card's leaf id. */
      readonly card: string | null;
    }
  /** The dispatch's one hand-back (§5.3), with how it was recorded (§5.4, §6.6). */
  | {
      readonly kind: 'dispatch.handback';
      readonly dispatch: string;
      readonly outcome: DispatchHandbackOutcome;
      readonly payloadHash: string;
      readonly report: string | null;
      readonly result: ContentHash | null;
      readonly filler: Filler | null;
    }
  /** The PM released a dispatch (§5.4): `ended` (its harness confirmed the seat ended) or `abandoned`. */
  | { readonly kind: 'dispatch.released'; readonly dispatch: string; readonly how: 'ended' | 'abandoned' }
  /** An exclusive resource leased to a dispatch (§6.2); freed by its hand-back or its release as ended. */
  | { readonly kind: 'lease.acquired'; readonly resource: string; readonly dispatch: string }
  /** A leaf the skeleton refers to (§3.2 item 12): its file, anchor and the hash of its text. */
  | { readonly kind: 'leaf.recorded'; readonly leaf: string; readonly leafKind: 'document' | 'journal'; readonly file: string; readonly anchor: string | null; readonly sha256: ContentHash }
  /** A cursor of the layered reads (§3.2 item 7), e.g. "since the maintainer last asked". */
  | { readonly kind: 'cursor.set'; readonly cursor: string; readonly rev: number }
  /** A completed recovery after a move (§3.3 step 6). */
  | { readonly kind: 'memory.moved'; readonly from: Place; readonly to: Place; readonly findings: MoveFindings }
  /** The PM confirmed, under the copy/move WI, that this copy is the one in use: git writes are no longer held (§3.3 step 2). */
  | { readonly kind: 'memory.git-confirmed'; readonly words: string | null }
  /**
   * The PM chose to continue from the last valid event of a broken chain (§3.3):
   * the log was cut after the last whole write up to it (`kept`), the events after removed.
   */
  | { readonly kind: 'memory.truncated'; readonly lastValid: number; readonly kept: number; readonly removed: number; readonly reason: string };

/** Everything the log holds: the base records (without the 4.0 receipt shape) and the memory's own events. */
export type LogRecord = Exclude<BaseRecord, { readonly kind: 'op.receipt' }> | MemoryEvent;

export type MemoryEventKind = MemoryEvent['kind'];

const TEXT_MAX = 200;

/** A filler as given on the command line or in a hand-back: harness 1..200 printable characters, model the same or null. */
export function checkFiller(x: unknown): Filler | null {
  if (x === null || x === undefined) return null;
  const o = x as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && [...v].length <= TEXT_MAX && !/[\u0000-\u001f\u007f]/.test(v);
  if (typeof o !== 'object' || !ok(o.harness) || !(o.model === null || o.model === undefined || ok(o.model))) {
    throw new LedgerError('BAD_REQUEST', 'a filler is { harness, model }: 1 to 200 printable characters each (model may be null)');
  }
  return { harness: o.harness, model: (o.model as string | null | undefined) ?? null };
}
