// Shared helpers of the 4.1 git, workspace, delivery and landing tests: a
// project folder with a git repository and its memory, the plain git runner,
// words and deliveries recorded directly, a git wrapper that stalls or races.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PlainGit } from '../src/git/plainGit.ts';
import type { GitContext } from '../src/git/workspace.ts';
import assert from 'node:assert/strict';
import { LedgerError, recordDelivery, recordWords, type LedgerErrorCode, type Memory } from '../src/memory/index.ts';
import type { MissionId } from '../src/common/ids.ts';
import { project, tempDir } from './memory-fixtures.ts';

export const M = 'm1' as MissionId;
export const IDENT = { name: 'mp test', email: 'mp@test', date: '1700000000 +0000' };
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

export function write(root: string, rel: string, text: string): void {
  const p = join(root, ...rel.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

/** A commit with `files` on top of `parent` (no worktree touched): its id. */
export function commitOn(repo: string, parent: string, files: Record<string, string | null>, message = 'c'): string {
  const idx = join(tempDir('mp-idx-'), 'index');
  const env = { ...process.env, ...GIT_ENV, GIT_INDEX_FILE: idx };
  execFileSync('git', ['read-tree', parent], { cwd: repo, env });
  for (const [path, text] of Object.entries(files)) {
    if (text === null) execFileSync('git', ['update-index', '--force-remove', '--', path], { cwd: repo, env });
    else {
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, env, input: text, encoding: 'utf8' }).trim();
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { cwd: repo, env });
    }
  }
  const tree = execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' }).trim();
  return execFileSync('git', ['commit-tree', tree, '-p', parent, '-m', message], { cwd: repo, env, encoding: 'utf8' }).trim();
}

export interface Fixture {
  readonly dir: string;
  readonly ctx: GitContext;
  readonly m: Memory;
  readonly base: string;
  git(...args: string[]): string;
  cleanup(): void;
}

/** A project folder: a repository on `main` with file.txt (and `extra`), its memory, the plain runner. */
export function fixture(opts: { files?: Record<string, string>; git?: PlainGit } = {}): Fixture {
  const p = project({ withGit: true });
  const dir = p.dir;
  if (opts.files !== undefined) {
    for (const [rel, text] of Object.entries(opts.files)) write(dir, rel, text);
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'files');
  }
  const base = sh(dir, 'rev-parse', 'HEAD');
  const git = opts.git ?? PlainGit.create();
  return {
    dir,
    get m() {
      return p.m;
    },
    get ctx() {
      return { memory: p.m, git };
    },
    base,
    git: (...args: string[]) => sh(dir, ...args),
    cleanup: () => p.cleanup(),
  };
}

/** The maintainer's words W-<n>. */
export function words(m: Memory, text = 'deliver it'): string {
  const message = `msg-${Math.random().toString(36).slice(2)}`;
  return m.write({ op: `say:${message}`, payload: { text } }, (tx) => recordWords(tx, { message, session: 's', at: Date.now(), text })).words;
}

/** A delivery recorded directly: D on B under its delivery ref, for target `branch`. */
export function recordedDelivery(f: Fixture, op: string, commit: string, base: string, branch: string): string {
  const ref = `refs/mission-pipeline/delivered/${M}/${op}`;
  f.git('update-ref', ref, commit);
  f.m.write({}, (tx) => recordDelivery(tx, { mission: M, delivery: op, commit, base, ref, manifest: tx.data.put(`manifest of ${op}`), target: branch }));
  return ref;
}

/**
 * A git wrapper (POSIX sh): for the commands whose arguments match `pattern`
 * it touches `<mark>`, runs `before` (shell), sleeps `sleep` seconds, runs git,
 * then touches `<mark>.done`; every other command is plain git.
 */
export function gitWrapper(dirFor: string, o: { pattern: string; mark: string; sleep?: number; before?: string }): string {
  const path = join(dirFor, 'git-wrapper.sh');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `case " $* " in`,
      `  ${o.pattern})`,
      `    touch '${o.mark}'`,
      ...(o.before !== undefined ? [`    ${o.before}`] : []),
      `    sleep ${o.sleep ?? 0}`,
      '    git "$@"; rc=$?',
      `    touch '${o.mark}.done'`,
      '    exit $rc;;',
      'esac',
      'exec git "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

/** Hold git writes as a move into a shared repository does (§3.3 step 2). */
export function holdGitWrites(m: Memory): void {
  m.connection.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('git_hold', ?)").run(JSON.stringify({ reason: 'test: copy shares its repository', since: 1 }));
}

/** The promise rejects with a LedgerError of `code` (and a message matching `re`). */
export async function rejectsCode(p: Promise<unknown>, code: LedgerErrorCode, re?: RegExp): Promise<LedgerError> {
  let caught: unknown = null;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof LedgerError, `expected LedgerError ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  if (re) assert.match(caught.message, re);
  return caught;
}
