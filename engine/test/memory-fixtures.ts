// Shared helpers of the memory tests: a fresh project folder with its memory,
// a git repository when a test needs one, child processes, refusal checks.

import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initMemory, LedgerError, openMemory, type LedgerErrorCode, type Memory, type OpenOptions } from '../src/memory/index.ts';

export const CHILD = fileURLToPath(new URL('./memory-fixture-child.ts', import.meta.url));

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

/** A git repository with one commit (file.txt). */
export function repo(dir: string): string {
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'file.txt'), 'hello\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '-q', '-m', 'first');
  return git(dir, 'rev-parse', 'HEAD');
}

/** A project folder with its memory, opened. `withGit`: a repository with one commit, else no git at all. */
export function project(opts: OpenOptions & { withGit?: boolean } = {}): { m: Memory; dir: string; reopen: (o?: OpenOptions) => Memory; cleanup: () => void } {
  const base = tempDir('mp-mem-');
  const dir = join(base, 'project');
  mkdirSync(dir, { recursive: true });
  if (opts.withGit) repo(dir);
  const o: OpenOptions = { ...(opts.withGit ? {} : { git: null }), ...opts };
  initMemory(dir, o);
  let m = openMemory(dir, o);
  return {
    get m() {
      return m;
    },
    dir,
    reopen: (more: OpenOptions = {}) => {
      m.close();
      m = openMemory(dir, { ...o, ...more });
      return m;
    },
    cleanup: () => {
      try {
        m.close();
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  };
}

export function throwsCode(fn: () => unknown, code: LedgerErrorCode, re?: RegExp): LedgerError {
  let caught: unknown = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof LedgerError, `expected LedgerError ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  if (re) assert.match(caught.message, re);
  return caught;
}

/** Start the child fixture; resolves once it printed its first line (or exited). */
export function child(action: unknown): { proc: ChildProcess; line: Promise<string>; exit: Promise<number | null> } {
  const proc = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CHILD, JSON.stringify(action)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const line = new Promise<string>((resolve) => {
    proc.stdout!.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      const nl = out.indexOf('\n');
      if (nl >= 0) resolve(out.slice(0, nl));
    });
    // 'close', not 'exit': the process can exit before its last output was read.
    proc.on('close', () => resolve(out.trim() === '' ? `no output: ${err.trim()}` : out.trim()));
    proc.on('error', (e) => resolve(`no output: ${e.message}`));
  });
  proc.stderr!.on('data', (d: Buffer) => {
    err += d.toString('utf8');
  });
  const exit = new Promise<number | null>((resolve) => {
    proc.on('close', (code, signal) => resolve(signal !== null ? -1 : code));
    proc.on('error', () => resolve(null));
  });
  return { proc, line, exit };
}

/** Event kinds in the log, in order. */
export function kinds(m: Memory): string[] {
  return (m.stmt('SELECT kind FROM log ORDER BY rev').all() as Array<{ kind: string }>).map((r) => r.kind);
}

/** A child's one-line JSON answer; anything else fails with what the child said. */
export function childJson(line: string): unknown {
  assert.ok(line.startsWith('{'), `the child gave no answer: ${line}`);
  return JSON.parse(line) as unknown;
}
