// The program's runs (design 4.1 §5.3, §6.5): `mp` checks a commit out clean into
// `.mission-pipeline/tmp/<run>/` and runs commands the card (or config.json) declares there,
// with the platform's shell, inside the `mp` command that needs them; the checkout is removed
// afterwards. The checkout is a git repository of its own at the commit (checkoutRepository.ts),
// and the commands get no variable that points git elsewhere (GIT_DIR, GIT_WORK_TREE,
// GIT_INDEX_FILE, ...), so what they ask git is answered for the candidate. Each command without reusable evidence becomes
// one evidence record (reusable commands executed only as setup add none):
//   - envLine ENV_LINE and the environment identity observed by this process (§6.5);
//   - the run class fixed now, from the card (runClassOf): a declared run (`mp`, clean checkout,
//     a declared command, no network, not sampled), or a sampling run (`mp seat <id> rerun`, an
//     experiment, a command the card marks sampled), or another run;
//   - fields: the candidate commit, the command and its working directory (RUN_FIELD plus
//     CWD_FIELD, normalized and project-relative, "." for the root: the reuse key of a declared
//     run and what `mp pm renew` reruns), status, exit, the output's sha256, the duration (a
//     timing field), the per-test results when the runner prints TAP lines (`test:<name>`).
// The run summary leaf `missions/<m>/runs/<run>.md` holds the commands, the environment identity,
// the exit codes, the per-test results, the output's hash and the last lines of a failing
// command; the full output is not kept (U-13).
//
// Time limits (config.json): each command gets `commandTimeoutMs`, except the reruns of an
// exploration's experiment executor (`mp seat <id> rerun` on a constructor-experiment card: the
// declaration marks them `experiment` and `rerun`), which get `experimentCommandTimeoutMs` (default
// `commandTimeoutMs`): an experiment may need a day where a hung test should end in minutes. Such a
// rerun is a sampling run: it takes no run lock and holds no write lock of the memory while it executes.
//
// Reuse (§6.5): a declared run is reused for the same candidate, command, working directory and
// environment identity (reusableMethodRun's key); a sampling run never is: each one executes and gets
// a new run id.
//
// Run locks (§4.1 "Process locks"): a declared run is recorded only after all its commands have
// run, so while it executes, its reuse key finds nothing, and every other `mp` process that
// advances the flow (a seat's hand-back, a PM write command, `mp pm next`) would start another
// execution of the same run. So a declared run executes only under one process lock per reuse key,
// `locks/runs/run-<hash of the key>.lock`, taken without waiting: the holder checks reuse again
// inside the lock (a run recorded meanwhile is reused), executes and records, then releases; while
// another process holds it, nothing is run or recorded (RunInProgress, a LOCKED refusal: busy,
// retry), and the flow's verification waits for its next pass, which reuses the recorded run. The
// operating system releases the lock when its holder exits however it exits, so a killed holder
// blocks nothing: the next call executes in a checkout of its own. Sampling runs take no lock.

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalJson, sha256 } from '../common/hash.ts';
import { normalRelDir } from '../common/fullSuite.ts';
import type { EnvSnapshotId, EvidenceId, MissionId } from '../common/ids.ts';
import { idPart } from '../common/ids.ts';
import type { BaseRecord, EvidenceRecord, RunClass } from '../common/records.ts';
import { validateRecord } from '../common/validate.ts';
import { ENV_LINE, RUN_FIELD, runClassOf, sampleRunId, type RunDeclaration } from '../evaluator/index.ts';
import { RUN_METHOD } from '../evaluator/environment.ts';
import { reusableMethodRun } from '../evaluator/runs.ts';
import { withoutRepositoryLocators } from '../git/plainGit.ts';
import { checkoutCommit, removeCheckout, runCheckoutDir } from '../git/workspace.ts';
import { appendRecords, LedgerError, tryLock, type ProcessLock, type WriteTx } from '../memory/index.ts';
import type { ProcessContext } from './context.ts';
import { ProcessError } from './errors.ts';

// ---------------------------------------------------------------- running one command

export interface CommandOutcome {
  /** The exit code, or null when it ended by a signal or never started. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Why it did not start (or could not be waited for), or null. */
  readonly error: string | null;
  readonly timedOut: boolean;
  /** stdout then stderr. */
  readonly output: Buffer;
  readonly durationMs: number;
}

/** Runs one command line in `cwd`. */
export type CommandRunner = (req: { readonly command: string; readonly cwd: string; readonly timeoutMs: number }) => CommandOutcome;

/**
 * The platform's shell (§9: verification commands are declared per project and run with the
 * platform's shell), in an environment without the variables that would point git at another
 * repository than the checkout's own.
 */
export const shellRunner: CommandRunner = ({ command, cwd, timeoutMs }) => {
  const t0 = performance.now();
  const r = spawnSync(command, { cwd, shell: true, env: withoutRepositoryLocators(process.env), timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = Buffer.concat([r.stdout ?? Buffer.alloc(0), r.stderr ?? Buffer.alloc(0)]);
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  return { exitCode: r.status, signal: r.signal ?? null, error: r.error !== undefined && !timedOut ? r.error.message : null, timedOut, output, durationMs: Math.round(performance.now() - t0) };
};

/**
 * The evidence field naming a run's working directory, normalized and relative to the checkout
 * root ("." for the root). Part of the run's identity (§5.3, §6.5): a run in another directory is
 * another run, never reused for this one, and `mp pm renew` reruns it in the same directory. A
 * run recorded without it ran at the root.
 */
export const CWD_FIELD = RUN_FIELD.cwd;

/** A command's working directory, normalized and relative to the checkout root ("." for the root); a path that leaves the checkout is refused. */
export function normalizeCwd(cwd: string | undefined | null): string {
  const n = normalRelDir(cwd);
  const s = (cwd ?? '').replace(/\\/g, '/').trim();
  if (n === null && (s.startsWith('/') || /^[A-Za-z]:/.test(s))) throw new ProcessError('NOT_ALLOWED', `the working directory "${cwd}" is not relative to the repository root`);
  if (n === null || n.split('/').includes('.git')) throw new ProcessError('NOT_ALLOWED', `the working directory "${cwd}" leaves the checkout`);
  return n;
}

/** The working directory a recorded run ran in ("." when it recorded none). */
export function runCwd(fields: Readonly<Record<string, string>>): string {
  return Object.hasOwn(fields, CWD_FIELD) ? fields[CWD_FIELD]! : '.';
}

/**
 * The time limit of each command of a run (see the top of this file): an experiment executor's
 * rerun (`experiment` and `rerun` declared: `mp seat <id> rerun` on a constructor-experiment card)
 * gets `experimentCommandTimeoutMs`; every other run, `commandTimeoutMs`.
 */
export function commandTimeoutFor(ctx: Pick<ProcessContext, 'commandTimeoutMs' | 'experimentCommandTimeoutMs'>, declaration: Pick<RunDeclaration, 'experiment' | 'rerun'>): number {
  return declaration.experiment === true && declaration.rerun === true ? ctx.experimentCommandTimeoutMs : ctx.commandTimeoutMs;
}

/** One command as a card declares it. `sampled` / `network`: the card's marks (§6.5). */
export interface DeclaredCommand {
  readonly id: string;
  readonly command: string;
  readonly cwd?: string;
  readonly sampled?: boolean;
  readonly network?: boolean;
}

// ---------------------------------------------------------------- per-test results (TAP)

const TAP = /^\s*(not ok|ok)\b\s*\d*\s*(?:-\s*)?(.*?)\s*(?:#\s*(SKIP|TODO)\b.*)?$/i;
const MAX_TESTS = 200;

/** Per-test results from TAP lines (`ok 3 - name`, `not ok 4 - name # SKIP`), when the runner prints them. */
export function tapResults(output: string): Array<{ readonly name: string; readonly result: 'passed' | 'failed' | 'skipped' }> {
  const out: Array<{ name: string; result: 'passed' | 'failed' | 'skipped' }> = [];
  for (const line of output.split(/\r?\n/)) {
    const m = TAP.exec(line);
    if (m === null) continue;
    const name = (m[2] ?? '').trim();
    if (name === '' || /^\d+$/.test(name)) continue;
    const result = m[3] !== undefined ? 'skipped' : m[1]!.toLowerCase() === 'ok' ? 'passed' : 'failed';
    out.push({ name: name.slice(0, 150), result });
    if (out.length >= MAX_TESTS) break;
  }
  return out;
}

/** How much of a failing command's output a run keeps (U-13: never the whole output). */
export interface TailLimit {
  readonly lines: number;
  /** UTF-8 bytes; the end of the output is kept. */
  readonly bytes: number;
}

/** A local run (a task's verification, a rerun): the last 40 lines of a failing command. */
export const LOCAL_TAIL: TailLimit = { lines: 40, bytes: 1024 * 1024 };
/** A full run (4.1.2, D-6): the last 400 lines of each failing command, at most 64 KiB, so a failure can be traced to its task. */
export const FULL_RUN_TAIL: TailLimit = { lines: 400, bytes: 64 * 1024 };

/** The last lines of an output, within `limit` (whole characters: a cut never splits one). */
export function tail(output: Buffer, limit: TailLimit = LOCAL_TAIL): string {
  const all = output.toString('utf8').replace(/\r\n/g, '\n').trimEnd().split('\n');
  let text = all.slice(-limit.lines).join('\n');
  if (Buffer.byteLength(text, 'utf8') <= limit.bytes) return text;
  const buf = Buffer.from(text, 'utf8');
  let at = buf.length - limit.bytes;
  // skip continuation bytes: start on a character boundary
  while (at < buf.length && (buf[at]! & 0xc0) === 0x80) at++;
  text = buf.subarray(at).toString('utf8');
  return text;
}

/** A declared command as a shell command line: a string as it is, an argv joined with each word quoted when it needs it. */
export function commandLine(command: string | readonly string[]): string {
  return typeof command === 'string' ? command : command.map((a) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}

// ---------------------------------------------------------------- run locks

/**
 * A declared run of the same reuse key (candidate, command, working directory, environment
 * identity, run method) is executing in another `mp` process: its run lock is held. Nothing was run or
 * recorded; once that run is recorded, the next call reuses it. A LOCKED refusal: busy, retry.
 */
export class RunInProgress extends LedgerError {
  readonly commit: string;
  readonly commands: readonly string[];
  constructor(commit: string, commands: readonly string[]) {
    super('LOCKED', `the declared run of ${commands.join(', ')} on ${commit} is executing in another mp process: nothing was run or recorded here; once it is recorded, it is reused`);
    this.commit = commit;
    this.commands = commands;
  }
}

/** The folder of the run locks, under `.mission-pipeline/locks/`. */
function runLocksDir(ctx: ProcessContext): string {
  return join(ctx.memory.paths.locks, 'runs');
}

/** The name of the run lock of one reuse key (reusableMethodRun's): the candidate, the command, its normalized working directory, the environment identity. */
function runLockName(key: { readonly candidate: string; readonly command: string; readonly cwd: string; readonly environment: string }): string {
  return `run-${sha256(canonicalJson({ candidate: key.candidate, command: key.command, cwd: key.cwd, environment: key.environment, method: RUN_METHOD })).slice(0, 40)}`;
}

/** Take the run lock of every command without waiting (in name order); RunInProgress, with none kept, when another process holds one. */
function takeRunLocks(ctx: ProcessContext, commit: string, commands: readonly DeclaredCommand[], environment: string): ProcessLock[] {
  const names = [...new Set(commands.map((c) => runLockName({ candidate: commit, command: c.command, cwd: normalizeCwd(c.cwd), environment })))].sort();
  const held: ProcessLock[] = [];
  try {
    for (const name of names) {
      const l = tryLock(runLocksDir(ctx), name);
      if (l === null) throw new RunInProgress(commit, commands.map((c) => c.id));
      held.push(l);
    }
  } catch (e) {
    for (const l of held) l.release();
    throw e;
  }
  return held;
}

// ---------------------------------------------------------------- recorded runs

/** One command's run as `mp` recorded it. */
export interface RecordedRun {
  readonly evidence: string;
  readonly command: DeclaredCommand;
  readonly passed: boolean;
  readonly summary: string;
  readonly fields: Readonly<Record<string, string>>;
  /** The last lines of a failing command (not kept in the memory; the summary leaf has them). */
  readonly tail: string;
  /** Reused from an earlier declared run (§6.5), possibly re-executed only as setup. */
  readonly reused: boolean;
  /** Failure of this call's setup-only execution; never evidence. */
  readonly setupFailure?: string;
}

/** A run id that names a directory and a leaf (letters, digits and "-"). */
export function newRunId(prefix = 'run'): string {
  return `${prefix}-${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}

function summaryOf(fields: Readonly<Record<string, string>>): string {
  const tests = Number(fields['tests'] ?? '0');
  const failed = Number(fields['testsFailed'] ?? '0');
  return `${fields['status']}; exit ${fields['exit']}; ${fields['durationMs']} ms${tests > 0 ? `; ${tests - failed} of ${tests} tests passed` : ''}`;
}

/** The evidence fields of one command's outcome. */
function fieldsOf(o: CommandOutcome, extra: Record<string, string>): Record<string, string> {
  const status = o.timedOut ? 'timeout' : o.error !== null && o.exitCode === null ? 'not-started' : 'completed';
  const exit = o.exitCode !== null ? String(o.exitCode) : o.signal !== null ? `signal:${o.signal}` : 'none';
  const fields: Record<string, string> = { ...extra, status, exit, output: sha256(o.output), durationMs: String(o.durationMs) };
  const tests = tapResults(o.output.toString('utf8'));
  if (tests.length > 0) {
    fields['tests'] = String(tests.length);
    fields['testsFailed'] = String(tests.filter((t) => t.result === 'failed').length);
    for (const t of tests) fields[`test:${t.name}`] = t.result;
  }
  return fields;
}

/** The run summary leaf (§5.3): commands, environment identity, exit codes, per-test results, output hash, last lines of a failing command. */
function summaryLeaf(o: { readonly run: string; readonly mission: string; readonly commit: string; readonly purpose: string; readonly runClass: RunClass; readonly environment: { readonly identity: string; readonly parts: unknown }; readonly runs: readonly RecordedRun[] }): string {
  const lines = [
    `# Run ${o.run}`,
    '',
    `- Mission: ${o.mission}`,
    `- Purpose: ${o.purpose}`,
    `- Commit: ${o.commit} (a clean checkout)`,
    `- Run class: ${o.runClass}`,
    `- Environment identity: ${o.environment.identity}`,
    `- Environment: ${canonicalJson(o.environment.parts)}`,
    '',
  ];
  for (const r of o.runs) {
    lines.push(`## ${r.command.id}: \`${r.command.command}\` (in ${runCwd(r.fields)})`, '');
    if (r.setupFailure !== undefined) lines.push(`- Note: ${r.setupFailure}`);
    lines.push(`- Evidence: ${r.evidence}${r.reused ? ' (reused; execution only as setup)' : ''}`, `- Result: ${r.passed ? 'passed' : 'failed'}; ${r.summary}`, `- Output sha256: ${r.fields['output'] ?? ''} (the output itself is not kept)`);
    const tests = Object.entries(r.fields).filter(([k]) => k.startsWith('test:'));
    if (tests.length > 0) lines.push('- Tests:', ...tests.map(([k, v]) => `  - ${k.slice(5)}: ${v}`));
    if ((!r.passed || r.setupFailure !== undefined) && r.tail !== '') lines.push('', 'Last lines of the output:', '', '```', r.tail, '```');
    lines.push('');
  }
  return lines.join('\n');
}

export function runLeaf(mission: string, run: string): string {
  return `missions/${mission}/runs/${run}.md`;
}

/**
 * Run `commands` on a clean checkout of `commit` (§5.3) and record them in one write: an evidence
 * record per command, and the run summary leaf. `declaration`: what the card declares about the
 * runs (§6.5 classes). Reuse: a declared run is reused, with nothing executed, when every command
 * has a reusable run (same candidate, command, cwd, environment identity and method); a sampling
 * run never is. Otherwise all commands execute in order; reusable ones are setup only, with no
 * new evidence. A setup failure is a note, and does not stop later commands.
 * A declared run executes only under its run locks (see the top of this file): RunInProgress,
 * with nothing run or recorded, while another process executes the same run.
 * `also`: more records for the same write (e.g. renewal pairs); `result` is that write's returned answer.
 */
export async function runOnCommit(
  ctx: ProcessContext,
  req: {
    readonly mission: MissionId | string;
    readonly commit: string;
    readonly commands: readonly DeclaredCommand[];
    readonly purpose: string;
    readonly declaration: Omit<RunDeclaration, 'sampled' | 'network'>;
    /** Evidence ids: deterministic (`ev(command)`) or fresh per run (sampling, the default for them). */
    readonly evidenceId?: (run: string, c: DeclaredCommand) => string;
    /** More fields on every run (e.g. the dispatch). */
    readonly fields?: Readonly<Record<string, string>>;
    /** More in the recording write (same transaction). */
    readonly also?: (tx: WriteTx, runs: readonly RecordedRun[], run: string, records: readonly EvidenceRecord[]) => unknown;
    /** These reusable evidence ids must be replaced by actual fresh executions under their run locks. */
    readonly doNotReuse?: readonly string[];
    /** An op id for the recording write (journal-safe retries). */
    readonly op?: string;
    /** How much of a failing command's output is kept (default LOCAL_TAIL; a full run: FULL_RUN_TAIL). */
    readonly tail?: TailLimit;
    /** A run id prefix for an execution (default "run", "rerun" for a rerun). */
    readonly runPrefix?: string;
  },
): Promise<{ readonly run: string; readonly runs: readonly RecordedRun[]; readonly reused: boolean; readonly leaf: string | null; readonly result: unknown }> {
  const env = ctx.environment();
  const classOf = (c: DeclaredCommand): RunClass => runClassOf({ ...req.declaration, sampled: c.sampled === true, network: c.network === true });
  // Every declared command takes its own lock, including in a mixed group and when
  // re-executed only as setup (per maintainer ruling 5, 2026-10-13).
  const declared = req.commands.filter((c) => classOf(c) === 'declared');
  const locks = takeRunLocks(ctx, req.commit, declared, env.identity);
  try {
    const reusable = ctx.memory.read((db) => req.commands.map((c): RecordedRun | null => {
      if (classOf(c) !== 'declared') return null;
      const r = reusableMethodRun(db, { candidate: req.commit, command: c.command, cwd: normalizeCwd(c.cwd), environment: env.identity });
      if (r === null || req.doNotReuse?.includes(r.evidence)) return null;
      return { evidence: r.evidence, command: c, passed: r.fields['status'] === 'completed' && r.fields['exit'] === '0', summary: summaryOf(r.fields), fields: r.fields, tail: '', reused: true };
    }));
    if (reusable.length > 0 && reusable.every((r) => r !== null)) {
      const runs = reusable as RecordedRun[];
      return { run: runs[0]!.fields['run'] ?? runs[0]!.evidence, runs, reused: true, leaf: null, result: undefined };
    }
    return await executeRuns(ctx, req, env, classOf, reusable);
  } finally {
    // Including checkout, execution and write failures: every exit releases every lock.
    for (const l of locks) l.release();
  }
}

/** Execute the commands on a clean checkout (a repository at the candidate) and record them in one write (runOnCommit, past reuse and the run locks). */
async function executeRuns(
  ctx: ProcessContext,
  req: Parameters<typeof runOnCommit>[1],
  env: ReturnType<ProcessContext['environment']>,
  classOf: (c: DeclaredCommand) => RunClass,
  reusable: readonly (RecordedRun | null)[],
): Promise<{ readonly run: string; readonly runs: readonly RecordedRun[]; readonly reused: boolean; readonly leaf: string | null; readonly result: unknown }> {
  const run = newRunId(req.runPrefix ?? (req.declaration.rerun === true ? 'rerun' : 'run'));
  const dir = runCheckoutDir(ctx.memory.paths, run);
  const executed: RecordedRun[] = [];
  const records: EvidenceRecord[] = [];
  const staged = new Map<string, RecordedRun>();
  const group = canonicalJson(req.commands.map((c) => ({ command: c.command, cwd: normalizeCwd(c.cwd), sampled: c.sampled === true, network: c.network === true })));
  const timeoutMs = commandTimeoutFor(ctx, req.declaration);
  // a git repository at the candidate, borrowing the project's objects (checkoutRepository.ts)
  await checkoutCommit(ctx.gitCtx, { commit: req.commit, dir, repository: true });
  try {
    for (const [i, c] of req.commands.entries()) {
      const rel = normalizeCwd(c.cwd);
      const cwd = rel === '.' ? dir : join(dir, ...rel.split('/'));
      mkdirSync(cwd, { recursive: true });
      const out = ctx.runner({ command: c.command, cwd, timeoutMs });
      const runClass = classOf(c);
      const key = canonicalJson({ command: c.command, cwd: rel });
      const prior = reusable[i] ?? (runClass === 'declared' ? staged.get(key) : undefined);
      if (prior !== null && prior !== undefined) {
        const failed = out.timedOut || out.error !== null || out.exitCode !== 0;
        const setupFailure = failed ? `Setup-only execution of ${c.id} failed (${out.timedOut ? 'timeout' : out.error ?? out.signal ?? `exit ${out.exitCode}`}); evidence ${prior.evidence} is unchanged; later commands still ran.` : undefined;
        // the failing setup's last lines are kept with the run (its summary leaf), never as evidence
        executed.push({ ...prior, command: c, reused: true, ...(setupFailure === undefined ? {} : { setupFailure, tail: tail(out.output, req.tail ?? LOCAL_TAIL) }) });
        continue;
      }
      const fields = fieldsOf(out, { ...(req.fields ?? {}), group, [RUN_FIELD.method]: RUN_METHOD, [RUN_FIELD.candidate]: req.commit, [RUN_FIELD.command]: c.command, [CWD_FIELD]: rel, commandId: c.id.slice(0, 200), run, purpose: req.purpose.slice(0, 200) });
      const evidence = req.evidenceId?.(run, c) ?? (runClass === 'sampling' ? sampleRunId(`${run}.${idPart(c.id)}`) : `${run}.${idPart(c.id)}`);
      const rec: EvidenceRecord = { kind: 'evidence', evidence: evidence as EvidenceId, envLine: ENV_LINE, envSnapshot: env.identity as EnvSnapshotId, runClass, fields };
      validateRecord(rec);
      records.push(rec);
      const passed = fields['status'] === 'completed' && fields['exit'] === '0';
      const recorded = { evidence, command: c, passed, summary: summaryOf(fields), fields, tail: passed ? '' : tail(out.output, req.tail ?? LOCAL_TAIL), reused: false };
      executed.push(recorded);
      if (runClass === 'declared') staged.set(key, recorded);
    }
  } finally {
    removeCheckout(ctx.gitCtx, dir);
  }
  const text = summaryLeaf({ run, mission: req.mission, commit: req.commit, purpose: req.purpose, runClass: records[0]?.runClass ?? 'other', environment: env, runs: executed });
  const leaf = runLeaf(req.mission, run);
  const result = ctx.memory.write({ op: req.op ?? `run:${run}`, payload: { run, evidence: records.map((r) => r.evidence) } }, (tx) => {
    if (records.length > 0) appendRecords(tx, records as BaseRecord[]);
    tx.leaves.writeDocument(leaf, text);
    return req.also?.(tx, executed, run, records);
  });
  return { run, runs: executed, reused: false, leaf, result };
}

