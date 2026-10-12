// The program's runs (design 4.1 §5.3, §6.5): `mp` checks a commit out clean into
// `.mission-pipeline/tmp/<run>/` and runs commands the card (or config.json) declares there,
// with the platform's shell, inside the `mp` command that needs them; the checkout is removed
// afterwards. The checkout is a git repository of its own at the commit (checkoutRepository.ts),
// and the commands get no variable that points git elsewhere (GIT_DIR, GIT_WORK_TREE,
// GIT_INDEX_FILE, ...), so what they ask git is answered for the candidate. Each command becomes
// one evidence record:
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
// Reuse (§6.5): a declared run is reused for the same candidate, command, working directory and
// environment identity (findReusableRun's key); a sampling run never is: each one executes and gets
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
import type { EnvSnapshotId, EvidenceId, MissionId } from '../common/ids.ts';
import { idPart } from '../common/ids.ts';
import type { BaseRecord, EvidenceRecord, RunClass } from '../common/records.ts';
import { validateRecord } from '../common/validate.ts';
import { ENV_LINE, findReusableRun, RUN_FIELD, runClassOf, sampleRunId, type RunDeclaration } from '../evaluator/index.ts';
import { withoutRepositoryLocators } from '../git/plainGit.ts';
import { checkoutCommit, removeCheckout, runCheckoutDir } from '../git/workspace.ts';
import type { ClosingCheck, ClosingOutcome, ClosingRunner } from '../delivery/delivery.ts';
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
  if (cwd === undefined || cwd === null) return '.';
  const s = cwd.replace(/\\/g, '/').trim();
  if (s === '' || s === '.' || s === './') return '.';
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) throw new ProcessError('NOT_ALLOWED', `the working directory "${cwd}" is not relative to the repository root`);
  const n = posix.normalize(s).replace(/\/+$/, '');
  if (n === '' || n === '.') return '.';
  if (n === '..' || n.startsWith('../') || n.split('/').includes('.git')) throw new ProcessError('NOT_ALLOWED', `the working directory "${cwd}" leaves the checkout`);
  return n;
}

/** The working directory a recorded run ran in ("." when it recorded none). */
export function runCwd(fields: Readonly<Record<string, string>>): string {
  return Object.hasOwn(fields, CWD_FIELD) ? fields[CWD_FIELD]! : '.';
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

function tail(output: Buffer, lines = 40): string {
  const all = output.toString('utf8').replace(/\r\n/g, '\n').trimEnd().split('\n');
  return all.slice(-lines).join('\n');
}

// ---------------------------------------------------------------- run locks

/**
 * A declared run of the same reuse key (candidate, command, working directory, environment
 * identity) is executing in another `mp` process: its run lock is held. Nothing was run or
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

/** The name of the run lock of one reuse key (findReusableRun's): the candidate, the command, its normalized working directory, the environment identity. */
function runLockName(key: { readonly candidate: string; readonly command: string; readonly cwd: string; readonly environment: string }): string {
  return `run-${sha256(canonicalJson({ candidate: key.candidate, command: key.command, cwd: key.cwd, environment: key.environment })).slice(0, 40)}`;
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
  /** Reused from an earlier declared run (§6.5), not executed now. */
  readonly reused: boolean;
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
    lines.push(`- Evidence: ${r.evidence}`, `- Result: ${r.passed ? 'passed' : 'failed'}; ${r.summary}`, `- Output sha256: ${r.fields['output'] ?? ''} (the output itself is not kept)`);
    const tests = Object.entries(r.fields).filter(([k]) => k.startsWith('test:'));
    if (tests.length > 0) lines.push('- Tests:', ...tests.map(([k, v]) => `  - ${k.slice(5)}: ${v}`));
    if (!r.passed && r.tail !== '') lines.push('', 'Last lines of the output:', '', '```', r.tail, '```');
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
 * has a reusable run (same candidate, command, environment identity); a sampling run never is.
 * A declared run executes only under its run locks (see the top of this file): RunInProgress,
 * with nothing run or recorded, while another process executes the same run.
 * `tx`: more records for the same write (e.g. a dispatch's flow event).
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
    readonly also?: (tx: WriteTx, runs: readonly RecordedRun[], run: string, records: readonly EvidenceRecord[]) => void;
    /** An op id for the recording write (journal-safe retries). */
    readonly op?: string;
  },
): Promise<{ readonly run: string; readonly runs: readonly RecordedRun[]; readonly reused: boolean; readonly leaf: string | null }> {
  const env = ctx.environment();
  const classOf = (c: DeclaredCommand): RunClass => runClassOf({ ...req.declaration, sampled: c.sampled === true, network: c.network === true });
  // §6.5 reuse: only declared runs, every command reusable
  if (req.commands.length > 0 && req.commands.every((c) => classOf(c) === 'declared')) {
    const reused = reusableRuns(ctx, req.commit, req.commands, env.identity);
    if (reused !== null) return reused;
    // a declared run executes once: under its run locks, taken without waiting (RunInProgress while
    // another process holds one); sampling runs take none, each one executes
    const locks = takeRunLocks(ctx, req.commit, req.commands, env.identity);
    try {
      // the holder that released just before may have recorded it: reused, not run again
      return reusableRuns(ctx, req.commit, req.commands, env.identity) ?? (await executeRuns(ctx, req, env, classOf));
    } finally {
      // released only after the recording write: the process that takes the lock next finds the run
      for (const l of locks) l.release();
    }
  }
  return executeRuns(ctx, req, env, classOf);
}

/** Every command reusable (§6.5): the recorded runs, or null. */
function reusableRuns(ctx: ProcessContext, commit: string, commands: readonly DeclaredCommand[], environment: string): { readonly run: string; readonly runs: readonly RecordedRun[]; readonly reused: boolean; readonly leaf: string | null } | null {
  // the reuse key is the candidate, the command, the working directory and the identity (a run of
  // the same command in another directory is another run: not reused, it executes)
  const reused = ctx.memory.read((db) =>
    commands.map((c) => {
      const cwd = normalizeCwd(c.cwd);
      const r = findReusableRun(db, { candidate: commit, command: c.command, cwd, environment });
      return { c, r: r !== null && runCwd(r.fields) === cwd ? r : null };
    }),
  );
  if (!reused.every((x) => x.r !== null)) return null;
  const runs = reused.map(({ c, r }): RecordedRun => {
    const fields = r!.fields;
    return { evidence: r!.evidence, command: c, passed: fields['status'] === 'completed' && fields['exit'] === '0', summary: summaryOf(fields), fields, tail: '', reused: true };
  });
  return { run: runs[0]!.fields['run'] ?? runs[0]!.evidence, runs, reused: true, leaf: null };
}

/** Execute the commands on a clean checkout (a repository at the candidate) and record them in one write (runOnCommit, past reuse and the run locks). */
async function executeRuns(
  ctx: ProcessContext,
  req: Parameters<typeof runOnCommit>[1],
  env: ReturnType<ProcessContext['environment']>,
  classOf: (c: DeclaredCommand) => RunClass,
): Promise<{ readonly run: string; readonly runs: readonly RecordedRun[]; readonly reused: boolean; readonly leaf: string | null }> {
  const run = newRunId(req.declaration.rerun === true ? 'rerun' : 'run');
  const dir = runCheckoutDir(ctx.memory.paths, run);
  const executed: RecordedRun[] = [];
  const records: EvidenceRecord[] = [];
  // a git repository at the candidate, borrowing the project's objects (checkoutRepository.ts)
  await checkoutCommit(ctx.gitCtx, { commit: req.commit, dir, repository: true });
  try {
    for (const c of req.commands) {
      const rel = normalizeCwd(c.cwd);
      const cwd = rel === '.' ? dir : join(dir, ...rel.split('/'));
      mkdirSync(cwd, { recursive: true });
      const out = ctx.runner({ command: c.command, cwd, timeoutMs: ctx.commandTimeoutMs });
      const fields = fieldsOf(out, { ...(req.fields ?? {}), [RUN_FIELD.candidate]: req.commit, [RUN_FIELD.command]: c.command, [CWD_FIELD]: rel, commandId: c.id.slice(0, 200), run, purpose: req.purpose.slice(0, 200) });
      const runClass = classOf(c);
      const evidence = req.evidenceId?.(run, c) ?? (runClass === 'sampling' ? sampleRunId(`${run}.${idPart(c.id)}`) : `${run}.${idPart(c.id)}`);
      const rec: EvidenceRecord = { kind: 'evidence', evidence: evidence as EvidenceId, envLine: ENV_LINE, envSnapshot: env.identity as EnvSnapshotId, runClass, fields };
      validateRecord(rec);
      records.push(rec);
      const passed = fields['status'] === 'completed' && fields['exit'] === '0';
      executed.push({ evidence, command: c, passed, summary: summaryOf(fields), fields, tail: passed ? '' : tail(out.output), reused: false });
    }
  } finally {
    removeCheckout(ctx.gitCtx, dir);
  }
  const text = summaryLeaf({ run, mission: req.mission, commit: req.commit, purpose: req.purpose, runClass: records[0]?.runClass ?? 'other', environment: env, runs: executed });
  const leaf = runLeaf(req.mission, run);
  ctx.memory.write({ op: req.op ?? `run:${run}`, payload: { run, evidence: records.map((r) => r.evidence) } }, (tx) => {
    if (records.length > 0) appendRecords(tx, records as BaseRecord[]);
    tx.leaves.writeDocument(leaf, text);
    req.also?.(tx, executed, run, records);
  });
  return { run, runs: executed, reused: false, leaf };
}

// ---------------------------------------------------------------- the delivery's closing checks

/**
 * The closing checks of a delivery (§6.7 step 5) as runs (A4's ClosingRunner): run by `mp` in the
 * candidate's clean checkout `deliver` made (a repository at the delivery candidate, like a run's
 * checkout: delivery.ts), each one recorded with its run summary leaf and a
 * flow event of the delivery (line `delivery:<d>`), never as an evidence record: a closing check
 * is no judgment's evidence, and a label input written while the delivery is built would move the
 * labels under it (A4 checks that none arrived since it read them).
 */
export function closingRunner(ctx: ProcessContext): ClosingRunner {
  return {
    run(req: { readonly mission: MissionId; readonly delivery: string; readonly commit: string; readonly dir: string; readonly checks: readonly ClosingCheck[] }): readonly ClosingOutcome[] {
      const env = ctx.environment();
      const run = newRunId('close');
      const recorded: RecordedRun[] = [];
      const outcomes: ClosingOutcome[] = [];
      for (const c of req.checks) {
        const command = typeof c.command === 'string' ? c.command : c.command.map((a) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
        const out = ctx.runner({ command, cwd: req.dir, timeoutMs: ctx.commandTimeoutMs });
        const fields = fieldsOf(out, { [RUN_FIELD.candidate]: req.commit, [RUN_FIELD.command]: command, commandId: c.id.slice(0, 200), run, purpose: `closing checks of delivery ${req.delivery}`, delivery: req.delivery });
        const id = `${run}.${idPart(c.id)}`;
        const passed = fields['status'] === 'completed' && fields['exit'] === '0';
        const t = passed ? '' : tail(out.output, 20);
        recorded.push({ evidence: id, command: { id: c.id, command }, passed, summary: summaryOf(fields), fields, tail: t, reused: false });
        outcomes.push({ id: c.id, passed, exitCode: out.exitCode, run: id, outputHash: fields['output']!, tail: t });
      }
      if (recorded.length > 0) {
        const text = summaryLeaf({ run, mission: req.mission, commit: req.commit, purpose: `closing checks of delivery ${req.delivery}`, runClass: 'declared', environment: env, runs: recorded });
        ctx.memory.write({ op: `run:${run}`, payload: { run, checks: recorded.map((r) => r.evidence) } }, (tx) => {
          tx.leaves.writeDocument(runLeaf(req.mission, run), text);
          appendRecords(
            tx,
            recorded.map((r): BaseRecord => ({
              kind: 'flow.event',
              mission: req.mission as MissionId,
              line: `delivery:${req.delivery}`,
              event: 'closing-run',
              key: r.evidence,
              body: tx.data.put(canonicalJson({ run, check: r.command.id, command: r.command.command, passed: r.passed, fields: r.fields, environment: env.identity })) as never,
            })),
          );
        });
      }
      return outcomes;
    },
  };
}
