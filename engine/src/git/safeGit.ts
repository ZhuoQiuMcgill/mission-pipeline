// The only way the engine runs git (README conventions; design 6.1 "git", 6.6 step 7, 7.1).
//
// Every run:
// - starts from an EMPTY environment and sets only an allow-list: a fixed system
//   PATH, LANG, HOME pointing at an empty read-only directory, and the switches that
//   turn off system config, global config and system attributes. Inherited
//   variables, including every GIT_* (GIT_CONFIG_COUNT/KEY/VALUE can inject
//   config, 6.6), never reach git;
// - forces `core.hooksPath` to an empty read-only directory and turns off
//   fsmonitor, replace refs, commit signing, automatic gc/maintenance and
//   submodule recursion (6.6 v46) on the command line, which outranks every
//   configuration file;
// - has a deadline. On expiry the whole process group is killed. The caller gets
//   a typed error carrying the process identity (pid, start time, boot id) and a
//   promise for its exit, because a timeout does not mean nothing happened (6.1);
// - captures stdout and stderr with a size limit and returns a typed result.
//
// Program-internal object operations only use plumbing that never runs content
// filters (raw `cat-file`, `hash-object --no-filters`, `mktree`, `commit-tree`,
// `check-attr`). Landing commands additionally run inside a bubblewrap view
// (landingView.ts), passed in as a `GitSandbox`; this module is still the one
// place that spawns the process.
//
// Repository locators (6.6 v37/v38): GIT_DIR, GIT_COMMON_DIR and GIT_WORK_TREE
// are never inherited and never accepted as caller variables. A run names its
// repository with `locators`, and only this wrapper turns them into the three
// variables, so git never discovers a repository from a `.git` file or the
// current directory when the caller does not want it to.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Fixed PATH for every git process (system directories only, 6.6). */
export const SYSTEM_PATH = '/usr/bin:/bin';
export const FIXED_LANG = 'C.UTF-8';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** How long a timed-out process may take to disappear after SIGKILL before the caller is told it is still there. */
export const DEFAULT_KILL_GRACE_MS = 5_000;

/** Variables a caller may add to one invocation. Everything else is refused. */
const CALLER_ENV_KEYS: ReadonlySet<string> = new Set([
  'GIT_INDEX_FILE',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
]);

/** Config a caller may add with `-c`. None of these can name a program. */
const CALLER_CONFIG_KEYS: ReadonlySet<string> = new Set([
  // 6.6 v49: ancestry queries read the commit objects, not the commit-graph cache.
  'core.commitgraph',
  'core.fsync',
  'core.fsyncmethod',
  'core.splitindex',
  'mission-pipeline.landing',
  'mission-pipeline.intent',
]);

/**
 * Where git finds the repository, set by the wrapper as GIT_DIR, GIT_COMMON_DIR
 * and GIT_WORK_TREE (6.6 v38: per operation, never shared). Absolute paths.
 * - a repository-level operation: `gitDir` = the common git dir, nothing else;
 * - an operation on one worktree: its own git dir (the common dir for the main
 *   worktree, `<common>/worktrees/<id>` for a linked one), the common dir, and
 *   its root as `workTree`.
 */
export interface GitLocators {
  readonly gitDir: string;
  readonly commonDir?: string;
  readonly workTree?: string;
}

function checkLocatorPath(name: string, p: string): void {
  if (!isAbsolute(p) || /[\0\n]/.test(p)) throw new TypeError(`${name} must be an absolute path without NUL or newline: ${JSON.stringify(p)}`);
}

/** Subcommands allowed when reading the user's real configuration (pure reads, 7.1 transform description). */
const USER_SCOPE_SUBCOMMANDS: ReadonlySet<string> = new Set(['config', 'var']);
const CONFIG_READ_FLAGS: ReadonlySet<string> = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l']);

// ---------------------------------------------------------------- process identity

/** Enough to tell, later, whether a process is still the one we started (6.1: pid, start time, boot id). */
export interface ProcessIdentity {
  readonly pid: number;
  readonly bootId: string;
  /** Field 22 of /proc/<pid>/stat; null when the process was already gone. */
  readonly startTicks: string | null;
}

let cachedBootId: string | null = null;
export function currentBootId(): string {
  if (cachedBootId === null) {
    try {
      cachedBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      cachedBootId = 'unknown';
    }
  }
  return cachedBootId;
}

function readProcStat(pid: number): { state: string; startTicks: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    const state = fields[0];
    const startTicks = fields[19];
    if (state === undefined || startTicks === undefined) return null;
    return { state, startTicks };
  } catch {
    return null;
  }
}

export function identifyProcess(pid: number): ProcessIdentity {
  return { pid, bootId: currentBootId(), startTicks: readProcStat(pid)?.startTicks ?? null };
}

/** False after a reboot, after the pid was reused, or once the process is a zombie or gone. */
export function isProcessAlive(p: ProcessIdentity): boolean {
  if (p.bootId !== currentBootId()) return false;
  const st = readProcStat(p.pid);
  if (st === null || st.state === 'Z' || st.state === 'X') return false;
  return p.startTicks === null || p.startTicks === st.startTicks;
}

/** Live processes whose command line or environment contains `token` (landing recovery, 6.6). */
export function findProcessesByToken(token: string): ProcessIdentity[] {
  const needle = Buffer.from(token, 'utf8');
  const found: ProcessIdentity[] = [];
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return found;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    for (const file of ['cmdline', 'environ']) {
      let buf: Buffer;
      try {
        buf = readFileSync(`/proc/${pid}/${file}`);
      } catch {
        continue;
      }
      if (buf.indexOf(needle) >= 0) {
        const id = identifyProcess(pid);
        if (id.startTicks !== null && isProcessAlive(id)) found.push(id);
        break;
      }
    }
  }
  return found;
}

export function killProcess(p: ProcessIdentity): void {
  if (!isProcessAlive(p)) return;
  try {
    process.kill(p.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------- results and errors

export interface GitResult {
  /** The argv of the git process itself (before any sandbox wrapping). */
  readonly argv: readonly string[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly durationMs: number;
  readonly process: ProcessIdentity;
}

export class GitError extends Error {
  readonly argv: readonly string[];
  constructor(message: string, argv: readonly string[]) {
    super(message);
    this.name = 'GitError';
    this.argv = argv;
  }
}

export class GitSpawnError extends GitError {
  readonly reason: unknown;
  constructor(argv: readonly string[], reason: unknown) {
    super(`could not start git: ${String(reason)}`, argv);
    this.name = 'GitSpawnError';
    this.reason = reason;
  }
}

/** Nonzero (or not allowed) exit status. */
export class GitExitError extends GitError {
  readonly result: GitResult;
  constructor(result: GitResult) {
    const err = result.stderr.toString('utf8').trim().split('\n').slice(-3).join(' | ');
    super(`git ${describeArgs(result.argv)} exited ${result.code ?? result.signal}: ${err}`, result.argv);
    this.name = 'GitExitError';
    this.result = result;
  }
}

/**
 * The deadline passed. The process group was sent SIGKILL. `exitedInGrace` says
 * whether it disappeared within the grace period; `exited` resolves when it does.
 * Callers that change state outside the ledger must treat the outcome as
 * "pending verification" until `exited` resolves (6.1).
 */
export class GitTimeoutError extends GitError {
  readonly process: ProcessIdentity | null;
  readonly exited: Promise<void>;
  readonly exitedInGrace: boolean;
  constructor(argv: readonly string[], proc: ProcessIdentity | null, exited: Promise<void>, exitedInGrace: boolean) {
    super(`git ${describeArgs(argv)} timed out${exitedInGrace ? '' : ' and had not exited after SIGKILL'}`, argv);
    this.name = 'GitTimeoutError';
    this.process = proc;
    this.exited = exited;
    this.exitedInGrace = exitedInGrace;
  }
}

export class GitOutputLimitError extends GitError {
  readonly limit: number;
  constructor(argv: readonly string[], limit: number) {
    super(`git ${describeArgs(argv)} produced more than ${limit} bytes of output`, argv);
    this.name = 'GitOutputLimitError';
    this.limit = limit;
  }
}

function describeArgs(argv: readonly string[]): string {
  // Skip the binary and the forced -c pairs for readability.
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '-c') {
      i++;
      continue;
    }
    out.push(a);
  }
  return out.slice(0, 6).join(' ');
}

// ---------------------------------------------------------------- sandbox hook

export interface SpawnSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Open descriptors the process gets as fds 3, 4, ... (landing: directories bound by descriptor, 6.6 v36). */
  readonly fds?: readonly number[];
  /** Called once the process has started (or failed to): closes this side's copies of `fds`. */
  readonly release?: () => void;
}

/** Turns a fully built git argv and environment into the process actually spawned (landing view, 6.6). */
export interface GitSandbox {
  wrap(argv: readonly string[], env: Readonly<Record<string, string>>, cwd: string): SpawnSpec;
  /** Environment the sandbox gives git instead of the repository-scope default (it must not inherit). */
  gitEnvironment(): Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------- options

/**
 * Where git looks for configuration.
 * - `repository` (default): only the repository's own config files; system and
 *   global config and system attributes are off, HOME is an empty directory.
 * - `user`: the user's effective configuration, for READ-ONLY queries (`git config
 *   --get...`, `git var`) that build the transform description (7.1).
 */
export type ConfigScope =
  | { readonly kind: 'repository' }
  | { readonly kind: 'user'; readonly environment: UserGitEnvironment };

/** The user's git environment, captured explicitly (never inherited from this process). */
export interface UserGitEnvironment {
  readonly home: string;
  readonly xdgConfigHome?: string;
  readonly gitConfigGlobal?: string;
  readonly gitConfigSystem?: string;
  readonly gitConfigNoSystem?: boolean;
  readonly gitAttrNoSystem?: boolean;
}

export interface GitRunOptions {
  readonly cwd: string;
  readonly input?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
  /** Extra variables; only CALLER_ENV_KEYS are accepted. */
  readonly env?: Readonly<Record<string, string>>;
  /** Extra `-c key=value`; only CALLER_CONFIG_KEYS are accepted. */
  readonly config?: readonly (readonly [string, string])[];
  readonly scope?: ConfigScope;
  readonly sandbox?: GitSandbox;
  /** The repository this run names explicitly (GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE). */
  readonly locators?: GitLocators;
  readonly onSpawn?: (p: ProcessIdentity) => void;
  /** Exit codes `ok()` accepts. Default [0]. */
  readonly okCodes?: readonly number[];
}

export interface SafeGitOptions {
  /** Program-owned directory; holds the empty read-only hooks and home directories. */
  readonly stateDir: string;
  /** Absolute path of git. Default: the first executable `git` on SYSTEM_PATH. */
  readonly gitPath?: string;
}

/** Creates `dir` if needed, insists it is empty, and makes it read-only (0555). */
export function ensureEmptyReadOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (readdirSync(dir).length !== 0) throw new Error(`${dir} must be empty`);
  chmodSync(dir, 0o555);
}

export function resolveSystemBinary(name: string): string {
  for (const d of SYSTEM_PATH.split(':')) {
    const p = join(d, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  throw new Error(`${name} not found on ${SYSTEM_PATH}`);
}

// ---------------------------------------------------------------- the wrapper

export class SafeGit {
  readonly gitPath: string;
  /** Empty read-only directory: `core.hooksPath` for every run, and mounted over `.git/hooks` in a landing view. */
  readonly noHooksDir: string;
  /** Empty read-only directory used as HOME in repository scope. */
  readonly emptyHome: string;

  /** When set, every repository-scope run goes through this sandbox (landing: every command in the view, 6.6). */
  readonly boundSandbox: GitSandbox | null;
  /** Locators for runs that do not name their own (a landing's repository-level commands, 6.6 v38). */
  readonly boundLocators: GitLocators | null;

  private constructor(gitPath: string, noHooksDir: string, emptyHome: string, boundSandbox: GitSandbox | null = null, boundLocators: GitLocators | null = null) {
    this.gitPath = gitPath;
    this.noHooksDir = noHooksDir;
    this.emptyHome = emptyHome;
    this.boundSandbox = boundSandbox;
    this.boundLocators = boundLocators;
  }

  /** The same wrapper with every run inside `sandbox`. User-scope reads are refused on it. */
  withSandbox(sandbox: GitSandbox): SafeGit {
    return new SafeGit(this.gitPath, this.noHooksDir, this.emptyHome, sandbox, this.boundLocators);
  }

  /** The same wrapper naming `locators` for every run that does not name its own. */
  withLocators(locators: GitLocators): SafeGit {
    return new SafeGit(this.gitPath, this.noHooksDir, this.emptyHome, this.boundSandbox, locators);
  }

  static create(opts: SafeGitOptions): SafeGit {
    if (!isAbsolute(opts.stateDir)) throw new TypeError('stateDir must be absolute');
    const gitPath = opts.gitPath ?? resolveSystemBinary('git');
    if (!isAbsolute(gitPath)) throw new TypeError('gitPath must be absolute');
    const noHooks = join(opts.stateDir, 'no-hooks');
    const home = join(opts.stateDir, 'empty-home');
    ensureEmptyReadOnlyDir(noHooks);
    ensureEmptyReadOnlyDir(home);
    return new SafeGit(gitPath, noHooks, home);
  }

  /** `-c` pairs on every command line. Command-line config outranks every config file. */
  forcedConfig(): readonly (readonly [string, string])[] {
    return [
      ['core.hooksPath', this.noHooksDir],
      ['core.fsmonitor', 'false'],
      ['core.useReplaceRefs', 'false'],
      ['commit.gpgSign', 'false'],
      ['gc.auto', '0'],
      ['maintenance.auto', 'false'],
      // 6.6 v46: the program never enters a submodule (no recursion into its git dir, config or worktree).
      ['submodule.recurse', 'false'],
      // 6.6 v49: GIT_GRAFT_FILE=/dev/null is read as an (empty) graft file; silence git's deprecation hint about it.
      ['advice.graftFileDeprecated', 'false'],
    ];
  }

  /** The argv of the git process for `args` (exported for tests and diagnostics). */
  buildArgv(args: readonly string[], opts: Pick<GitRunOptions, 'config' | 'scope'> = {}): string[] {
    const scope = opts.scope ?? { kind: 'repository' };
    if (scope.kind === 'user') checkUserScopeArgs(args);
    const argv: string[] = [this.gitPath];
    for (const [k, v] of this.forcedConfig()) argv.push('-c', `${k}=${v}`);
    for (const [k, v] of opts.config ?? []) {
      if (!CALLER_CONFIG_KEYS.has(k.toLowerCase())) throw new TypeError(`config key not allowed: ${k}`);
      if (v.includes('\n')) throw new TypeError('config value must not contain a newline');
      argv.push('-c', `${k}=${v}`);
    }
    argv.push(...args);
    return argv;
  }

  buildEnv(opts: Pick<GitRunOptions, 'env' | 'scope' | 'sandbox' | 'locators'> = {}): Record<string, string> {
    const scope = opts.scope ?? { kind: 'repository' };
    let env: Record<string, string>;
    if (opts.sandbox) {
      if (scope.kind !== 'repository') throw new TypeError('a sandboxed run uses repository scope only');
      env = { ...opts.sandbox.gitEnvironment() };
    } else if (scope.kind === 'repository') {
      env = {
        PATH: SYSTEM_PATH,
        LANG: FIXED_LANG,
        HOME: this.emptyHome,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        // 6.6 v48: replace objects are off (also -c core.useReplaceRefs=false on every command line).
        GIT_NO_REPLACE_OBJECTS: '1',
        // 6.6 v49: history is the commit objects' own parent edges (no info/grafts).
        GIT_GRAFT_FILE: '/dev/null',
        // Program-internal reads never touch the network or a terminal.
        GIT_NO_LAZY_FETCH: '1',
        GIT_TERMINAL_PROMPT: '0',
      };
    } else {
      const u = scope.environment;
      // v50: every program git command, these read-only config queries included, runs without lazy fetch, grafts or replace objects.
      env = { PATH: SYSTEM_PATH, LANG: FIXED_LANG, HOME: u.home, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_GRAFT_FILE: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' };
      if (u.xdgConfigHome !== undefined) env.XDG_CONFIG_HOME = u.xdgConfigHome;
      if (u.gitConfigGlobal !== undefined) env.GIT_CONFIG_GLOBAL = u.gitConfigGlobal;
      if (u.gitConfigSystem !== undefined) env.GIT_CONFIG_SYSTEM = u.gitConfigSystem;
      if (u.gitConfigNoSystem) env.GIT_CONFIG_NOSYSTEM = '1';
      if (u.gitAttrNoSystem) env.GIT_ATTR_NOSYSTEM = '1';
    }
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (!CALLER_ENV_KEYS.has(k)) throw new TypeError(`environment variable not allowed: ${k}`);
      env[k] = v;
    }
    const loc = opts.locators;
    if (loc !== undefined) {
      checkLocatorPath('gitDir', loc.gitDir);
      env.GIT_DIR = loc.gitDir;
      if (loc.commonDir !== undefined) {
        checkLocatorPath('commonDir', loc.commonDir);
        env.GIT_COMMON_DIR = loc.commonDir;
      }
      if (loc.workTree !== undefined) {
        checkLocatorPath('workTree', loc.workTree);
        env.GIT_WORK_TREE = loc.workTree;
      }
    }
    return env;
  }

  /** Runs git and resolves with the result whatever the exit code. Rejects on bad options, spawn failure, timeout, output limit. */
  async run(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    let opts = options;
    if (this.boundSandbox !== null) {
      if ((opts.scope ?? { kind: 'repository' }).kind !== 'repository') throw new TypeError('a sandbox-bound SafeGit runs repository scope only');
      if (opts.sandbox === undefined) opts = { ...opts, sandbox: this.boundSandbox };
    }
    if (this.boundLocators !== null && opts.locators === undefined) opts = { ...opts, locators: this.boundLocators };
    const argv = this.buildArgv(args, opts);
    const env = this.buildEnv(opts);
    const spec: SpawnSpec = opts.sandbox
      ? opts.sandbox.wrap(argv, env, opts.cwd)
      : { file: argv[0] as string, args: argv.slice(1), env, cwd: opts.cwd };
    return spawnCollect(argv, spec, opts);
  }

  /** Like run(), but throws GitExitError unless the exit code is in `okCodes` (default [0]). */
  async ok(args: readonly string[], opts: GitRunOptions): Promise<GitResult> {
    const r = await this.run(args, opts);
    const okCodes = opts.okCodes ?? [0];
    if (r.code === null || !okCodes.includes(r.code)) throw new GitExitError(r);
    return r;
  }

  /** stdout of a successful run, decoded as UTF-8, with one trailing newline removed. */
  async text(args: readonly string[], opts: GitRunOptions): Promise<string> {
    const r = await this.ok(args, opts);
    const s = r.stdout.toString('utf8');
    return s.endsWith('\n') ? s.slice(0, -1) : s;
  }
}

function checkUserScopeArgs(args: readonly string[]): void {
  const sub = args.find((a) => !a.startsWith('-'));
  if (sub === undefined || !USER_SCOPE_SUBCOMMANDS.has(sub)) {
    throw new TypeError(`user scope allows only read-only config queries, not ${JSON.stringify(sub)}`);
  }
  if (sub === 'config' && !args.some((a) => CONFIG_READ_FLAGS.has(a))) {
    throw new TypeError('user scope `git config` must be a --get/--list query');
  }
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

function spawnCollect(argv: readonly string[], spec: SpawnSpec, opts: GitRunOptions): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const limit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise<GitResult>((resolve, reject) => {
    const started = Date.now();
    let identity: ProcessIdentity | null = null;
    let settled = false;
    let timedOut = false;
    let overLimit = false;
    let exitedResolve: () => void = () => {};
    const exited = new Promise<void>((r) => {
      exitedResolve = r;
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;

    let child: ChildProcessWithoutNullStreams;
    try {
      // stdin, stdout and stderr are pipes whatever follows them, so the streams exist.
      child = spawn(spec.file, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe', ...(spec.fds ?? [])],
        detached: true, // own process group, so a timeout kills git and its children together
      }) as ChildProcessWithoutNullStreams;
    } finally {
      // The child has its own copies now (or never started).
      spec.release?.();
    }

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      fn();
    };

    let graceTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
      graceTimer = setTimeout(() => {
        finish(() => reject(new GitTimeoutError(argv, identity, exited, false)));
      }, graceMs);
    }, timeoutMs);

    child.once('spawn', () => {
      if (child.pid !== undefined) {
        identity = identifyProcess(child.pid);
        try {
          opts.onSpawn?.(identity);
        } catch {
          /* the observer must not break the run */
        }
      }
    });
    child.once('error', (e) => {
      exitedResolve();
      finish(() => reject(new GitSpawnError(argv, e)));
    });
    const collect = (chunks: Buffer[], isOut: boolean) => (b: Buffer) => {
      if (isOut) outLen += b.length;
      else errLen += b.length;
      if (outLen + errLen > limit) {
        if (!overLimit) {
          overLimit = true;
          killGroup(child.pid);
        }
        return;
      }
      chunks.push(b);
    };
    child.stdout.on('data', collect(out, true));
    child.stderr.on('data', collect(err, false));
    child.stdin.on('error', () => {
      /* EPIPE when git exits without reading its input */
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();

    child.once('close', (code, signal) => {
      exitedResolve();
      const proc = identity ?? { pid: child.pid ?? -1, bootId: currentBootId(), startTicks: null };
      if (timedOut) {
        finish(() => reject(new GitTimeoutError(argv, proc, exited, true)));
        return;
      }
      if (overLimit) {
        finish(() => reject(new GitOutputLimitError(argv, limit)));
        return;
      }
      finish(() =>
        resolve({
          argv,
          code,
          signal,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err),
          durationMs: Date.now() - started,
          process: proc,
        }),
      );
    });
  });
}
