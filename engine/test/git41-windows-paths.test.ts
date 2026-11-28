// 4.4.1: the Windows forms of what git reports about worktrees, with the platform injected so
// that every system runs both branches. Git for Windows prints and stores worktree paths with
// forward slashes ("C:/x/y") and records no inode in the index; the program's own paths are
// native ("C:\x\y") and Node reports a file id as the inode.

import assert from 'node:assert/strict';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inferOrigin, statDiffers, type DebugEntry } from '../src/git/externalWorktrees.ts';
import { nativeGitPath, rootFromGitdirFile } from '../src/git/worktreeRecord.ts';
import { gitLinkPath, plainGit, type GitRunner } from '../src/memory/git.ts';
import { initMemory, openMemory } from '../src/memory/index.ts';
import { git, repo } from './memory-fixtures.ts';

test('a worktree path from git is put in the native form on Windows only', () => {
  assert.equal(nativeGitPath('C:/Users/u/project/.mission-pipeline/worktrees/D-1', 'win32'), 'C:\\Users\\u\\project\\.mission-pipeline\\worktrees\\D-1');
  assert.equal(nativeGitPath('//server/share/repo/wt', 'win32'), '\\\\server\\share\\repo\\wt');
  assert.equal(nativeGitPath('C:\\already\\native', 'win32'), 'C:\\already\\native');
  assert.equal(nativeGitPath('/home/u/project/wt', 'linux'), '/home/u/project/wt');
  assert.equal(nativeGitPath('/home/u/odd\\name', 'linux'), '/home/u/odd\\name', 'a backslash is a name character off Windows');
  assert.equal(nativeGitPath('', 'win32'), '');
});

test("a linked git dir's gitdir file names its root in the native form, absolute or relative", () => {
  const admin = 'C:\\r\\.git\\worktrees\\D-1';
  assert.equal(rootFromGitdirFile(admin, Buffer.from('C:/r/.mission-pipeline/worktrees/D-1/.git\n'), 'win32'), 'C:\\r\\.mission-pipeline\\worktrees\\D-1');
  assert.equal(rootFromGitdirFile(admin, Buffer.from('../../../wt/.git\n'), 'win32'), 'C:\\r\\wt', 'relative to the git dir, with Windows rules');
  assert.equal(rootFromGitdirFile('/r/.git/worktrees/D-1', Buffer.from('/r/wt/.git\n'), 'linux'), '/r/wt');
  assert.equal(rootFromGitdirFile('/r/.git/worktrees/D-1', Buffer.from('../../../wt/.git\n'), 'linux'), '/r/wt');
});

test("a Claude sub-agent's worktree is recognized by a native Windows path too", () => {
  assert.equal(inferOrigin('C:\\r\\.claude\\worktrees\\agent-1', null, 'win32'), 'claude');
  assert.equal(inferOrigin('C:/r/.claude/worktrees/agent-1', null, 'win32'), 'claude');
  assert.equal(inferOrigin('/r/.claude/worktrees/agent-1', null, 'linux'), 'claude');
  assert.equal(inferOrigin('/r/x\\.claude\\worktrees\\agent-1', null, 'linux'), 'unknown', 'off Windows a backslash is no separator');
  assert.equal(inferOrigin('C:\\r\\wt', 'refs/heads/codex/fix', 'win32'), 'codex');
});

test('a worktree link file is written in git\'s form: forward slashes on Windows', () => {
  assert.equal(gitLinkPath('C:\\r\\.git\\worktrees\\D-1', 'win32'), 'C:/r/.git/worktrees/D-1');
  assert.equal(gitLinkPath('/r/.git/worktrees/D-1', 'linux'), '/r/.git/worktrees/D-1');
  assert.equal(gitLinkPath('/r/odd\\name/.git', 'linux'), '/r/odd\\name/.git');
});

test('a copied folder whose git left the worktree links as they were: the direct repair makes git list the worktree at its copied path', () => {
  const base = mkdtempSync(join(tmpdir(), 'mp-relink-'));
  try {
    const original = join(base, 'original');
    const copied = join(base, 'copy');
    mkdirSync(original);
    repo(original);
    initMemory(original);
    git(original, 'worktree', 'add', '-q', '--detach', join('.mission-pipeline', 'worktrees', 'D-1'));
    cpSync(original, copied, { recursive: true });
    // a git whose repair exits zero and fixes nothing (Git for Windows 2.45 does so for a copy)
    const plain = plainGit();
    const inert: GitRunner = (args, opts) => (args[0] === 'worktree' && args[1] === 'repair' ? { code: 0, stdout: '', stderr: '' } : plain(args, opts));
    const m = openMemory(copied, { git: inert });
    try {
      assert.equal(m.status().gitHold, null, JSON.stringify(m.status().gitHold));
      assert.deepEqual(m.status().lastMove!.findings.git, { kind: 'repaired', worktrees: 1 });
    } finally {
      m.close();
    }
    const wt = join(copied, '.mission-pipeline', 'worktrees', 'D-1');
    const listed = git(copied, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => realpathSync(nativeGitPath(l.slice('worktree '.length))));
    assert.ok(listed.includes(realpathSync(wt)), listed.join(', '));
    assert.equal(realpathSync(git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir')), realpathSync(join(copied, '.git')));
    assert.equal(git(wt, 'status', '--porcelain'), '');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an index that records no inode (Git for Windows) compares on size and time only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-stat-'));
  try {
    writeFileSync(join(dir, 'f.txt'), 'four');
    const st = lstatSync(join(dir, 'f.txt'), { bigint: true });
    const entry = (o: Partial<DebugEntry> = {}): DebugEntry => ({ path: 'f.txt', mtimeSec: st.mtimeNs / 1_000_000_000n, mtimeNsec: st.mtimeNs % 1_000_000_000n, ino: st.ino, size: st.size, ...o });
    assert.equal(statDiffers(dir, entry()), false, 'the stat data git recorded');
    assert.equal(statDiffers(dir, entry({ ino: 0n })), false, 'no inode recorded: not a change');
    assert.equal(statDiffers(dir, entry({ ino: st.ino + 1n })), true, 'another inode recorded: possibly changed');
    assert.equal(statDiffers(dir, entry({ ino: 0n, size: st.size + 1n })), true);
    assert.equal(statDiffers(dir, entry({ ino: 0n, mtimeSec: entry().mtimeSec - 5n })), true);
    assert.equal(statDiffers(dir, entry({ path: 'gone.txt' })), true, 'deleted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
