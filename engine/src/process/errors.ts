// Refusals of the process commands (design 4.1 §5): typed like the memory's (LedgerError), each
// with the work instruction the PM follows, or null when the caller (a seat, or the PM) just fixes
// its request and runs the command again.

export type ProcessErrorCode =
  /** A hand-back or evidence-request file is not where the card says (`.mission-pipeline/tmp/<dispatch>/`), or cannot be read. */
  | 'BAD_FILE'
  /** The command does not fit the dispatch (not in flight, not this seat's command, an unknown material or command). */
  | 'NOT_ALLOWED'
  /** A leaf the command needs is missing or was edited by hand (§3.3: shown, only the steps that need it are held; WI-30). */
  | 'LEAF_MISSING'
  | 'LEAF_EDITED'
  /** The step is not ready (claimed, held by a stop, a lease or the git-writes hold). */
  | 'NOT_READY'
  /** `mp pm resnapshot-exploration`: the exploration is settled (reopen it, or define a new one). */
  | 'EXPLORATION_SETTLED'
  /** `mp pm resnapshot-exploration`: the target branch's head is the exploration's snapshot already. */
  | 'SNAPSHOT_CURRENT'
  /** `mp pm resnapshot-exploration`: a dispatch of the exploration is in flight, or its hand-back is not taken into account yet. */
  | 'DISPATCH_IN_FLIGHT';

export class ProcessError extends Error {
  readonly code: ProcessErrorCode;
  readonly wi: string | null;
  readonly detail: unknown;
  constructor(code: ProcessErrorCode, message: string, o: { readonly wi?: string | null; readonly detail?: unknown } = {}) {
    super(`${code}: ${message}`);
    this.name = 'ProcessError';
    this.code = code;
    this.wi = o.wi ?? null;
    this.detail = o.detail ?? null;
  }
}
