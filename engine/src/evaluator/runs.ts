// Run classes (design 4.1 §6.5), replacing v51 7.3's closed / open / sampling.
//
// 4.1 has no sandbox and no frozen environment, so it defines its own classes:
// - declared: run by `mp` on a clean checkout of the candidate commit (§5.3),
//   with the commands declared on the card, its environment identity recorded,
//   no network access declared by the card, and not marked sampled;
// - sampling: one observation among possible others: a run the card marks as
//   sampled (a benchmark, a flaky-test probe, a statistical measurement, any
//   command whose judgment will use a timing, statistical or external field),
//   an experiment of an exploration, and every run started by
//   `mp seat <id> rerun`;
// - other: anything else (a command that declares network access, a seat's
//   scratch run, a run on a worktree).
// The class is fixed when the run is recorded, from the card (`runClassOf`); an
// evidence record is immutable, so it never changes later.
//
// Reuse (§6.5): only a declared run is reused, for the same candidate content,
// the same command run in the same working directory, and the same
// environment identity (renew.ts, findReusableRun). A sampling run is never reused: each one executes and gets
// a new run id (`sampleRunId`), so repeated samples stay separate observations.

import { randomBytes } from 'node:crypto';
import type { RunClass } from '../common/records.ts';

/** What a run's card declares about it, at the moment it is recorded. */
export interface RunDeclaration {
  /** Who ran it: `mp` itself (verification, closing, renew, rerun), or the seat with its harness's tools. */
  readonly by: 'mp' | 'seat';
  /** Where: a clean checkout of the candidate commit made by `mp`, or a worktree. */
  readonly checkout: 'clean' | 'worktree';
  /** The command is one the card declares (not a seat's own command line). */
  readonly declared: boolean;
  /** The card declares network access for it. */
  readonly network: boolean;
  /** The card marks it sampled (a benchmark, a flaky-test probe, a statistical measurement...). */
  readonly sampled: boolean;
  /** An experiment of an exploration (v51 4.3). */
  readonly experiment?: boolean;
  /** Started by `mp seat <id> rerun`. */
  readonly rerun?: boolean;
}

/** The class of a run, from its card's declarations (4.1 §6.5). Sampling marks win: they say the result is one observation. */
export function runClassOf(d: RunDeclaration): RunClass {
  if (d.sampled || d.experiment === true || d.rerun === true) return 'sampling';
  if (d.by === 'mp' && d.checkout === 'clean' && d.declared && !d.network) return 'declared';
  return 'other';
}

/**
 * Evidence fields every run `mp` records carries (A3 writes them): the
 * candidate's content identity, the command and its working directory
 * (normalized, relative to the project; a run without it ran at the root,
 * '.'), which with the environment identity are the reuse key of a declared
 * run (§6.5) and what `mp pm renew` reruns.
 */
export const RUN_FIELD = Object.freeze({ candidate: 'candidate', command: 'command', cwd: 'cwd' });

/** A run's working directory as its fields record it: missing reads as the project root, '.'. */
export function runCwdOf(fields: Readonly<Record<string, string>>): string {
  return Object.hasOwn(fields, RUN_FIELD.cwd) ? fields[RUN_FIELD.cwd]! : '.';
}

/**
 * A fresh run id for a sampling run (§6.5, scenario 13): never derived from the
 * candidate, command or environment alone, so two samples of the same command
 * are two runs. `base` is an id prefix (the caller's own naming).
 */
export function sampleRunId(base: string): string {
  return `${base}.s${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

/**
 * Why `rerun` is not a rerun of `original` (§6.5: "reruns the declared commands
 * on the affected candidates"), or null: the same candidate content, the same
 * full command and the same working directory (missing read as '.').
 * `strict`: the original must name the candidate and the command (the
 * program's own renewal entries); otherwise a run that names neither is not
 * checked (records made before runs carried them).
 */
export function rerunMismatch(original: Readonly<Record<string, string>>, rerun: Readonly<Record<string, string>>, strict: boolean): string | null {
  const keys = [RUN_FIELD.candidate, RUN_FIELD.command];
  const named = keys.filter((k) => Object.hasOwn(original, k));
  if (named.length === 0 && !strict) return null;
  for (const k of keys) {
    if (!Object.hasOwn(original, k)) return `the original run does not record its ${k}, so a rerun of it cannot be told from another run`;
    if (!Object.hasOwn(rerun, k) || rerun[k] !== original[k]) return `the new run is not a rerun of the original: its ${k} differs (${JSON.stringify(rerun[k] ?? null)}, not ${JSON.stringify(original[k])})`;
  }
  const [a, b] = [runCwdOf(original), runCwdOf(rerun)];
  if (a !== b) return `the new run is not a rerun of the original: its working directory differs (${JSON.stringify(b)}, not ${JSON.stringify(a)})`;
  return null;
}
