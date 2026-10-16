// The one way 4.1 runs git (design 4.1 §2.5, §6.7, §9): plain `git` from PATH,
// on Linux, Windows and macOS alike, inside the `mp` command that needs it.
//
// 4.0's runner ran every command from an empty environment with a fixed system
// PATH, forced hook and filter settings and a configuration allow-list, and
// landed inside an isolated view. Design 4.1 §6.7 removed all of that: it
// guarded against code run by the repository's configuration, which is the
// harness's and the maintainer's business (U-3). What stays are the
// correctness parts, here and in the callers:
// - the repository is the one the caller names: inherited variables that would
//   point git at another repository (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
//   ...) never reach git; a run names its repository with `locators` or `cwd`,
//   and a caller may set GIT_INDEX_FILE for one run (a temporary index);
// - git never prompts and never fetches a missing object (GIT_TERMINAL_PROMPT=0,
//   GIT_NO_LAZY_FETCH=1): what the memory names must be local (§3.3);
// - objects are read as they were committed: no replace objects
//   (GIT_NO_REPLACE_OBJECTS=1);
// - checks of someone's worktree take no optional lock (GIT_OPTIONAL_LOCKS=0),
//   so a status read never leaves an index.lock in the maintainer's way;
// - results are judged by the caller from refs and objects, never from git's
//   messages (LC_ALL=C only keeps the messages stable for reports).
//
// Two forms: asynchronous (`run`, `ok`, `text`), which the object and
// representation modules use (GitExec), and synchronous (`runSync`, `okSync`,
// `textSync`), which landing uses so that nothing else runs between its check
// and its git command.
// `runner()` gives the memory's own synchronous shape (memory/git.ts GitRunner),
// so `openMemory(dir, { git: git.runner() })` runs the same git.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { GitResult as MemoryGitResult, GitRunner } from '../memory/git.ts';

/** How long a git command may run before it is ended (a hung git must not hang `mp` forever). */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** Inherited variables that would point git at another repository than the one a run names. */
const LOCATOR_VARS: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE',
  'GIT_QUARANTINE_PATH',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_ATTR_SOURCE',
];

/**
 * `env` without the variables that would point git at another repository than the one found from
 * the working directory (LOCATOR_VARS, except GIT_CEILING_DIRECTORIES, which only bounds the
 * search): the environment of a declared command in a run checkout, whose own repository is the
 * candidate's (checkoutRepository.ts). Windows variable names are case-insensitive.
 */
export function withoutRepositoryLocators(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of Object.keys(out)) {
    const u = platform === 'win32' ? k.toUpperCase() : k;
    if (LOCATOR_VARS.includes(u) && u !== 'GIT_CEILING_DIRECTORIES') delete out[k];
  }
  return out;
}

/** Set on every run (see the header). */
const FIXED_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

/**
 * The repository a run names (GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE), absolute
 * paths: a repository-level command names the common dir; a command on one
 * worktree names its git dir, the common dir and its root.
 */
export interface GitLocators {
  readonly gitDir: string;
  readonly commonDir?: string;
  readonly workTree?: string;
}

export interface GitRunOptions {
  readonly cwd: string;
  readonly input?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Variables for this run (e.g. GIT_INDEX_FILE, author and committer identities). */
  readonly env?: Readonly<Record<string, string>>;
  /** `-c key=value` for this run. */
  readonly config?: readonly (readonly [string, string])[];
  readonly locators?: GitLocators;
  /** Exit codes `ok()` accepts. Default [0]. */
  readonly okCodes?: readonly number[];
}

export interface GitResult {
  /** The argv of the git process (the binary first). */
  readonly argv: readonly string[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly durationMs: number;
}

/**
 * What the object, representation, worktree-record, candidate and write-scope
 * modules need from a git runner. PlainGit implements it.
 */
export interface GitExec {
  run(args: readonly string[], opts: GitRunOptions): Promise<GitResult>;
  ok(args: readonly string[], opts: GitRunOptions): Promise<GitResult>;
  text(args: readonly string[], opts: GitRunOptions): Promise<string>;
  withLocators(locators: GitLocators): GitExec;
}

export class GitError extends Error {
  readonly argv: readonly string[];
  constructor(message: string, argv: readonly string[]) {
    super(message);
    this.name = 'GitError';
    this.argv = argv;
  }
}

/** git could not be started (not installed, not on PATH). */
export class GitSpawnError extends GitError {
  constructor(argv: readonly string[], reason: unknown) {
    super(`could not start git (${argv[0] ?? 'git'}): ${String(reason)}`, argv);
    this.name = 'GitSpawnError';
  }
}

/** An exit code `ok()` does not accept. */
export class GitExitError extends GitError {
  readonly result: GitResult;
  constructor(result: GitResult) {
    const err = result.stderr.toString('utf8').trim().split(/\r?\n/).slice(-3).join(' | ');
    super(`git ${result.argv.slice(1, 7).join(' ')} exited ${result.code ?? result.signal}: ${err}`, result.argv);
    this.name = 'GitExitError';
    this.result = result;
  }
}

/** The deadline passed; the process was ended. It may still have changed something before it ended: callers judge by refs. */
export class GitTimeoutError extends GitError {
  constructor(argv: readonly string[], ms: number) {
    super(`git ${argv.slice(1, 7).join(' ')} did not finish within ${ms} ms and was ended`, argv);
    this.name = 'GitTimeoutError';
  }
}

export class GitOutputLimitError extends GitError {
  constructor(argv: readonly string[], limit: number) {
    super(`git ${argv.slice(1, 7).join(' ')} produced more than ${limit} bytes of output`, argv);
    this.name = 'GitOutputLimitError';
  }
}

/** POSIX shell single-quoting, for the git command lines `mp` shows the maintainer to run. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function checkLocator(name: string, p: string): void {
  if (!isAbsolute(p) || /[\0\n]/.test(p)) throw new TypeError(`${name} must be an absolute path without NUL or newline: ${JSON.stringify(p)}`);
}

export interface PlainGitOptions {
  /** The git binary: a name found on PATH (default `git`) or an absolute path. */
  readonly gitPath?: string;
  /** Variables added to every run (tests: author and committer identities). */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** The platform whose process rules apply (default: this one; tests force the Windows branch). */
  readonly platform?: NodeJS.Platform;
}

export class PlainGit implements GitExec {
  readonly gitPath: string;
  /** Locators for runs that name none (a repository-level view, externalWorktrees and pmActions). */
  readonly boundLocators: GitLocators | null;
  private readonly baseEnv: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly windows: boolean;

  private constructor(gitPath: string, baseEnv: Readonly<Record<string, string>>, timeoutMs: number, bound: GitLocators | null, windows: boolean) {
    this.gitPath = gitPath;
    this.baseEnv = baseEnv;
    this.timeoutMs = timeoutMs;
    this.boundLocators = bound;
    this.windows = windows;
  }

  static create(opts: PlainGitOptions = {}): PlainGit {
    const gitPath = opts.gitPath ?? 'git';
    if (gitPath === '' || /[\0\n]/.test(gitPath)) throw new TypeError('gitPath is a program name or path');
    return new PlainGit(gitPath, { ...(opts.env ?? {}) }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, null, (opts.platform ?? process.platform) === 'win32');
  }

  withLocators(locators: GitLocators): PlainGit {
    return new PlainGit(this.gitPath, this.baseEnv, this.timeoutMs, locators, this.windows);
  }

  /** The argv of the git process for `args`. */
  buildArgv(args: readonly string[], opts: Pick<GitRunOptions, 'config'> = {}): string[] {
    const argv: string[] = [this.gitPath];
    for (const [k, v] of opts.config ?? []) {
      if (/[\0\n]/.test(k) || /[\0\n]/.test(v) || k.includes('=')) throw new TypeError(`bad config pair ${JSON.stringify([k, v])}`);
      argv.push('-c', `${k}=${v}`);
    }
    argv.push(...args);
    return argv;
  }

  /** The environment of one run: this process's, without repository locators, plus the fixed and the caller's variables. */
  buildEnv(opts: Pick<GitRunOptions, 'env' | 'locators'> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) {
      // Windows variable names are case-insensitive.
      if (LOCATOR_VARS.includes(this.windows ? k.toUpperCase() : k)) delete env[k];
    }
    Object.assign(env, FIXED_ENV, this.baseEnv, opts.env ?? {});
    const loc = opts.locators ?? this.boundLocators ?? undefined;
    if (loc !== undefined) {
      checkLocator('gitDir', loc.gitDir);
      env.GIT_DIR = loc.gitDir;
      if (loc.commonDir !== undefined) {
        checkLocator('commonDir', loc.commonDir);
        env.GIT_COMMON_DIR = loc.commonDir;
      }
      if (loc.workTree !== undefined) {
        checkLocator('workTree', loc.workTree);
        env.GIT_WORK_TREE = loc.workTree;
      }
    }
    return env;
  }

  private prepare(args: readonly string[], opts: GitRunOptions): { argv: string[]; env: NodeJS.ProcessEnv } {
    return { argv: this.buildArgv(args, opts), env: this.buildEnv(opts) };
  }

  /**
   * Run git; resolves with the result whatever the exit code. Rejects when git
   * cannot start, times out or overflows its output limit. On a timeout the
   * call ends at once: git (its process group off Windows, the process itself
   * on Windows) is sent SIGKILL and this side's pipes are closed, so a
   * descendant that still holds them never keeps the caller waiting. Whatever
   * git did before it ended is judged by the caller from refs and objects.
   */
  run(args: readonly string[], opts: GitRunOptions): Promise<GitResult> {
    const { argv, env } = this.prepare(args, opts);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const limit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const windows = this.windows;
    return new Promise<GitResult>((resolve, reject) => {
      const started = Date.now();
      let child: ChildProcessWithoutNullStreams;
      try {
        // Its own process group off Windows, so a timeout ends git and its children together.
        child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env, stdio: 'pipe', detached: !windows, windowsHide: true });
      } catch (e) {
        reject(new GitSpawnError(argv, e));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const end = (failure: GitError): void => {
        try {
          if (!windows && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        // Do not wait for 'close': a descendant may hold the pipes open for as long as it lives.
        for (const s of [child.stdout, child.stderr, child.stdin]) s.destroy();
        child.unref();
        settle(() => reject(failure));
      };
      const timer = setTimeout(() => end(new GitTimeoutError(argv, timeoutMs)), timeoutMs);
      const collect = (into: Buffer[]) => (b: Buffer) => {
        if (settled) return;
        size += b.length;
        if (size > limit) {
          end(new GitOutputLimitError(argv, limit));
          return;
        }
        into.push(b);
      };
      child.stdout.on('data', collect(out));
      child.stderr.on('data', collect(err));
      for (const s of [child.stdout, child.stderr, child.stdin]) {
        s.on('error', () => {
          /* EPIPE when git exits without reading its input; destroyed pipes after a timeout */
        });
      }
      child.stdin.end(opts.input);
      child.once('error', (e) => settle(() => reject(new GitSpawnError(argv, e))));
      child.once('close', (code, signal) => settle(() => resolve({ argv, code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err), durationMs: Date.now() - started })));
    });
  }

  async ok(args: readonly string[], opts: GitRunOptions): Promise<GitResult> {
    const r = await this.run(args, opts);
    if (r.code === null || !(opts.okCodes ?? [0]).includes(r.code)) throw new GitExitError(r);
    return r;
  }

  /** stdout of a successful run, as UTF-8, with one trailing newline removed. */
  async text(args: readonly string[], opts: GitRunOptions): Promise<string> {
    return trimNewline((await this.ok(args, opts)).stdout.toString('utf8'));
  }

  /**
   * The synchronous form of run(): nothing else in this process runs until git
   * has exited. Its input and output go through temporary files, not pipes, so
   * the call returns when git exits, on every platform: a descendant that
   * inherited git's output (a helper or daemon it started) can neither hold
   * the call until the deadline nor turn a finished git into a false timeout.
   * On the deadline git is sent SIGKILL and the call ends.
   */
  runSync(args: readonly string[], opts: GitRunOptions): GitResult {
    const { argv, env } = this.prepare(args, opts);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const limit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const started = Date.now();
    const dir = mkdtempSync(join(tmpdir(), 'mp-git-'));
    const names = { in: join(dir, 'in'), out: join(dir, 'out'), err: join(dir, 'err') };
    const fds: number[] = [];
    try {
      writeFileSync(names.in, opts.input ?? '');
      fds.push(openSync(names.in, 'r'), openSync(names.out, 'w'), openSync(names.err, 'w'));
      const r = spawnSync(argv[0]!, argv.slice(1), { cwd: opts.cwd, env, stdio: fds, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true });
      if (r.error !== undefined) {
        if ((r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') throw new GitTimeoutError(argv, timeoutMs);
        throw new GitSpawnError(argv, r.error);
      }
      if (fstatSync(fds[1]!).size + fstatSync(fds[2]!).size > limit) throw new GitOutputLimitError(argv, limit);
      return { argv, code: r.status, signal: r.signal, stdout: readFileSync(names.out), stderr: readFileSync(names.err), durationMs: Date.now() - started };
    } finally {
      for (const fd of fds) closeSync(fd);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows: a descendant still holds a file open; the system's temporary directory keeps it */
      }
    }
  }

  okSync(args: readonly string[], opts: GitRunOptions): GitResult {
    const r = this.runSync(args, opts);
    if (r.code === null || !(opts.okCodes ?? [0]).includes(r.code)) throw new GitExitError(r);
    return r;
  }

  textSync(args: readonly string[], opts: GitRunOptions): string {
    return trimNewline(this.okSync(args, opts).stdout.toString('utf8'));
  }

  /** The memory's synchronous runner shape (memory/git.ts), running this same git. */
  runner(): GitRunner {
    return (args, o): MemoryGitResult => {
      try {
        const r = this.runSync(args, { cwd: o.cwd, ...(o.input !== undefined ? { input: o.input } : {}) });
        return { code: r.code ?? -1, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8') };
      } catch (e) {
        return { code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
      }
    };
  }
}

function trimNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, s.endsWith('\r\n') ? -2 : -1) : s;
}
