// CLI errors and exit codes (design 9.2). Every failure the PM sees names what
// happened and, where the design has one, the work instruction (3.11) that tells
// the PM what to do next. A refusal stops only the one action that caused it.

/** Exit codes. 75/76 are the stop entry's own codes (6.1, src/ledger/stops.ts). */
export const EXIT = {
  OK: 0,
  /** Something failed that is not one of the classes below (a defect: WI-20). */
  FAILED: 1,
  /** The design refused this action (a WI applies); nothing else was stopped. */
  REFUSED: 3,
  /** Bad arguments (EX_USAGE). */
  USAGE: 64,
  /** The same operation id was used with different arguments (EX_DATAERR). */
  OP_CONFLICT: 65,
  /** A service the command needs is not running or did not answer (EX_UNAVAILABLE). */
  UNAVAILABLE: 69,
  /** The engine side of this command does not exist yet (EX_SOFTWARE): see the adapter's message. */
  NOT_IMPLEMENTED: 70,
  /** No configuration: run `mp install` first (EX_CONFIG). */
  NO_CONFIG: 78,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT] | 75 | 76;

export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly wi: string | null;
  readonly detail: unknown;
  constructor(code: string, message: string, o: { exitCode?: number; wi?: string | null; detail?: unknown } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = o.exitCode ?? EXIT.FAILED;
    this.wi = o.wi ?? null;
    this.detail = o.detail ?? null;
  }
}

/**
 * An engine API this command needs does not exist yet. The message names the
 * exact upstream change; the CLI side is complete and calls this adapter.
 */
export class NotImplemented extends CliError {
  readonly upstream: string;
  constructor(what: string, upstream: string) {
    super('NOT_IMPLEMENTED', `${what}: not provided by the engine yet (upstream change needed: ${upstream})`, { exitCode: EXIT.NOT_IMPLEMENTED, detail: { upstream } });
    this.name = 'NotImplemented';
    this.upstream = upstream;
  }
}

export function usage(message: string): CliError {
  return new CliError('USAGE', message, { exitCode: EXIT.USAGE });
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
