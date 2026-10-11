// Typed refusals of the project memory (4.1; the 4.0 ledger service used the
// same codes). Every refusal is one of these codes, so the caller can map it to
// a PM work instruction (design 4.1 §6.9): a refusal only stops the one action
// that caused it, never the whole flow. Each code carries the 4.1 WI of its row
// in the exception table; null marks a normal branch of the flow, which the
// table says is not an exception (the caller re-reads, retries, or fixes its
// request, and goes on).

export type LedgerErrorCode =
  | 'STOPPED'
  /** The dispatch is not in flight any more (released, or already handed back): its result is not accepted. */
  | 'UNRECOGNIZED_LAUNCH'
  | 'OP_CONFLICT'
  | 'FACT_CONFLICT'
  | 'KIND_NOT_ALLOWED'
  | 'RECORD_INVALID'
  | 'TOO_LARGE'
  | 'DOMAIN_BUSY'
  | 'NOT_PENDING'
  | 'BELOW_FLOOR'
  | 'CONTENT_MISSING'
  /** The caller's scope tag differs from the scope persisted for the pending operation or the delivery (core review r2 F1). */
  | 'SCOPE_MISMATCH'
  /** An attempt on a loop that is exhausted (6.5 "耗尽之后"); only loops recorded when an attempt starts. */
  | 'LOOP_EXHAUSTED'
  /** A second Secretary grant on one lineage (6.5: once per lineage, across all its loops). */
  | 'GRANT_LIMIT'
  /** The task is not in the queue (already dispatched, cancelled or superseded). */
  | 'NOT_QUEUED'
  /** The request changed after its content was verified (or was never verified): verify and send it again. */
  | 'STALE_REQUEST'
  /** An unexpected failure inside the program (a defect). */
  | 'INTERNAL_ERROR'
  /** A continuation judgment without a passing check at the latest label revision (5.2 part 5): a full review instead. */
  | 'CONTINUATION_REFUSED'
  /** A renewal that does not meet the renewal rule (5.3): the judgment needs a new review instead. */
  | 'RENEWAL_REFUSED'
  /**
   * A landing or delivery-ref action for a delivery that is not the mission's
   * current one: superseded by a later delivery, withdrawn, or never recorded
   * (6.6 授权: "确认这次交付仍是当前的、没有被取消"; git review r1 #11).
   */
  | 'DELIVERY_NOT_CURRENT'
  | 'BAD_REQUEST'
  /** 4.1 §4.1: the memory's write lock was not obtained within the busy limit (30 s); nothing was written. Retry. */
  | 'BUSY'
  /** 4.1 §4.1: one write transaction did more than its work budget (2 s); it was rolled back, nothing was written. */
  | 'OVER_BUDGET'
  /** 4.1 §4.1: a process lock (landing, maintenance) is held by another process. */
  | 'LOCKED'
  /** 4.1 §3.3: another process is recovering the folder after a move; retry once it is done. */
  | 'MOVING'
  /** 4.1 §3.3: the event log's hash chain is broken; every write is refused until the PM follows WI-29. */
  | 'CHAIN_BROKEN'
  /** 4.1 §3.3 step 2: commands that write to git are held until the PM confirms this copy of the folder is the one in use. */
  | 'GIT_WRITES_HELD'
  /** 4.1 §3.1: the folder has no project memory (`mp init` creates it). */
  | 'NOT_INITIALIZED'
  /** 4.1 §5: no dispatch with this id. */
  | 'UNKNOWN_DISPATCH'
  /** 4.1 §4.1: the labels are still recomputing (a propagation frontier is not empty): a decision that needs "proven" waits. */
  | 'RECOMPUTING';

export type WorkInstruction = `WI-${string}`;

/**
 * The 4.1 work instruction for each refusal (§6.9). Codes whose WI depends on
 * the action carry the most common one here; the raising code overrides it
 * where it knows better (a lease held by another dispatch is no exception: the
 * step waits).
 */
export const REFUSAL_WI: Readonly<Record<LedgerErrorCode, WorkInstruction | null>> = {
  // A stop in force is the safety floor (3.11 principle 4), not an exception: the stop report covers it (6.4).
  STOPPED: null,
  // A result for a dispatch that is not in flight any more: an interrupted dispatch (4.1 §5.4).
  UNRECOGNIZED_LAUNCH: 'WI-28',
  // The program's records disagree (the same identity with other content; a request that does not match
  // what the memory holds; data a record names is missing), or a program defect.
  FACT_CONFLICT: 'WI-20',
  NOT_PENDING: 'WI-20',
  SCOPE_MISMATCH: 'WI-20',
  CONTENT_MISSING: 'WI-20',
  INTERNAL_ERROR: 'WI-20',
  OVER_BUDGET: 'WI-20',
  // The caller fixes its request and runs the command again (a seat's malformed hand-back is refused at the seat, decision 14).
  OP_CONFLICT: null,
  BAD_REQUEST: null,
  KIND_NOT_ALLOWED: null,
  RECORD_INVALID: null,
  TOO_LARGE: null,
  UNKNOWN_DISPATCH: null,
  // A conflict domain held by an unfinished landing or delivery-ref intent.
  DOMAIN_BUSY: 'WI-06',
  // 交付已不是当前的 (WI-06, class A: nothing was written; the landing ends)
  DELIVERY_NOT_CURRENT: 'WI-06',
  // 回路次数耗尽
  LOOP_EXHAUSTED: 'WI-08',
  GRANT_LIMIT: 'WI-08',
  // Normal branches (6.1, 6.3): re-read and go on.
  BELOW_FLOOR: null,
  NOT_QUEUED: null,
  STALE_REQUEST: null,
  // Normal branches (5.2 part 5, 5.3): a full review, or a new judgment, instead.
  CONTINUATION_REFUSED: null,
  RENEWAL_REFUSED: null,
  // Retry later (busy, a process lock held, a move being recovered); a missing memory is set up with `mp init`.
  BUSY: null,
  LOCKED: null,
  MOVING: null,
  NOT_INITIALIZED: null,
  // 4.1 §4.1: wait for the labels, then retry (WI-32 only after its 10-minute notice).
  RECOMPUTING: null,
  // 4.1 §3.3: a broken event chain stops every write; git writes are held until the PM confirms the copy in use.
  CHAIN_BROKEN: 'WI-29',
  GIT_WRITES_HELD: 'WI-31',
};

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  /** The work instruction the PM follows for this refusal, or null for a normal branch. */
  readonly wi: WorkInstruction | null;
  constructor(code: LedgerErrorCode, message: string, wi?: WorkInstruction | null) {
    super(`${code}: ${message}`);
    this.name = 'LedgerError';
    this.code = code;
    this.wi = wi === undefined ? REFUSAL_WI[code] : wi;
  }
}
