// CLI errors and exit codes (design 4.1 §4.1, §6.9). Every failure names what happened and,
// where one applies, the 4.1 work instruction the PM follows (WI-01..08, 13, 16, 19..21, 23..26,
// 28..33). A refusal stops only the one action that caused it.
//
// The memory, labels, process, git and delivery packages raise LedgerError and ProcessError with
// their own 4.1 WI numbers (memory/errors.ts REFUSAL_WI, or the raising code's own); the process
// actions' errors carry none and are mapped here.

import { isWi } from './wi.ts';

/** Exit codes. */
export const EXIT = {
  OK: 0,
  /** Something failed that is not one of the classes below (a defect: WI-20). */
  FAILED: 1,
  /** The program refused this action (a WI may apply); nothing else was stopped. */
  REFUSED: 3,
  /** Bad arguments (EX_USAGE). */
  USAGE: 64,
  /** The same operation id was used with other arguments (EX_DATAERR). */
  OP_CONFLICT: 65,
  /** Busy, retry: the memory's lock, a process lock or a move recovery held by another `mp`; nothing was written (EX_TEMPFAIL). */
  BUSY: 75,
  /** No project memory here: run `mp init` (EX_CONFIG). */
  NO_PROJECT: 78,
} as const;

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

export function usage(message: string): CliError {
  return new CliError('USAGE', message, { exitCode: EXIT.USAGE });
}

export function refused(code: string, message: string, wi: string | null = null, detail: unknown = null): CliError {
  return new CliError(code, message, { exitCode: EXIT.REFUSED, wi, detail });
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The 4.1 work instruction for the process actions' errors (process/actions.ts ActionError) and the flows' refusals of a PM action, which carry none. */
const BY_CODE: Readonly<Record<string, string | null>> = {
  // the flows' refusals of a PM action (nothing was written)
  'already-applied': 'WI-24',
  'withdrawn-item': null,
  'missing-objects': 'WI-13',
  'unsafe-path': 'WI-13',
  'product-rejected': 'WI-13',
  'git-held': 'WI-31',
  'unknown-product': 'WI-20',
  conflict: null,
};

/** A WI number as the PM should read it: a 4.1 page, or null (never a page that does not exist). */
export function wi41(wi: string | null | undefined): string | null {
  if (wi === null || wi === undefined) return null;
  return isWi(wi) ? wi : null;
}

const RETRY_CODES = new Set(['BUSY', 'LOCKED', 'MOVING']);

/** Any error as the CLI reports it: its code, a 4.1 WI and an exit code. */
export function toCliError(e: unknown): CliError {
  if (e instanceof CliError) return new CliError(e.code, e.message, { exitCode: e.exitCode, wi: wi41(e.wi), detail: e.detail });
  const x = e as { name?: string; code?: unknown; wi?: unknown; message?: unknown; detail?: unknown } | null;
  const code = typeof x?.code === 'string' ? x.code : null;
  const typed = x !== null && (x.name === 'LedgerError' || x.name === 'ProcessError');
  if (x !== null && code !== null && (typed || code in BY_CODE)) {
    const wi = typed ? wi41(typeof x.wi === 'string' ? x.wi : null) : BY_CODE[code]!;
    const exitCode = RETRY_CODES.has(code) ? EXIT.BUSY : code === 'NOT_INITIALIZED' ? EXIT.NO_PROJECT : code === 'OP_CONFLICT' ? EXIT.OP_CONFLICT : EXIT.REFUSED;
    const message = String(x.message ?? code).replace(new RegExp(`^${code}: `), '');
    const hint = RETRY_CODES.has(code) ? ' (busy, retry: nothing was written; run the same command again)' : '';
    return new CliError(code, `${message}${hint}`, { exitCode, wi, detail: x.detail ?? null });
  }
  return new CliError('FAILED', `program internal error: ${errorMessage(e)} (WI-20)`, { exitCode: EXIT.FAILED, wi: 'WI-20' });
}
