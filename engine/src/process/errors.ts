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
  /** `mp pm rerun-attempt`, `mp pm amend-attempts`: the exploration is settled (reopen it, or define a new one). */
  | 'EXPLORATION_SETTLED'
  /** `mp pm rerun-attempt`, `mp pm amend-attempts`: the exploration is stopped and waits for the decision layer. */
  | 'EXPLORATION_STOPPED'
  /** `mp pm rerun-attempt`: the method in effect registers no such attempt (or no method is in effect). */
  | 'ATTEMPT_NOT_REGISTERED'
  /** `mp pm rerun-attempt`: the attempt has no record yet. */
  | 'ATTEMPT_NO_EVIDENCE'
  /** `mp pm rerun-attempt`: a run of the attempt is queued or in flight; `mp pm amend-attempts`: a run of a replaced attempt is in flight, or handed back and not taken into account yet. */
  | 'ATTEMPT_QUEUED'
  /** `mp pm rerun-attempt`, `mp pm amend-attempts`: the interpretation of the attempts' records is submitted. */
  | 'INTERPRETATION_SUBMITTED'
  /** `mp pm rerun-attempt`, `mp pm amend-attempts`: a dispatch of the exploration is in flight (its interpreter). */
  | 'DISPATCH_IN_FLIGHT'
  /** `mp pm amend-attempts`: not a research exploration, or no method is in force yet (its method is still being attacked). */
  | 'NO_METHOD'
  /** `mp pm amend-attempts`: the attempts file is not a list of registered attempts the author's register would accept (schema, ids unique, a quantity or an assertion each). */
  | 'ATTEMPTS_INVALID'
  /** `mp pm amend-attempts`: every attempt in the file equals its registered one: nothing to amend. */
  | 'NOTHING_AMENDED'
  /** `mp pm amend-attempts`: an interpreter of the exploration was dispatched (its step given up, or otherwise past the queue): the records were read. */
  | 'INTERPRETER_DISPATCHED'
  /** `mp pm amend-attempts --answers`: no open repair of that id about this exploration (none, about something else, or answered already). */
  | 'REPAIR_NOT_OPEN'
  /** `mp pm amend-attempts --answers`: the repair's round has started (an author step was dispatched for it). */
  | 'REPAIR_STARTED';

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
