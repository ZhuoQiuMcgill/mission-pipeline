// 4.4.1: the Windows forms of what git reports about worktrees, with the platform injected so
// that every system runs both branches. Git for Windows prints and stores worktree paths with
// forward slashes ("C:/x/y") and records no inode in the index; the program's own paths are
// native ("C:\x\y") and Node reports a file id as the inode.

import assert from 'node:assert/strict';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { inferOrigin, statDiffers, type DebugEntry } from '../src/git/externalWorktrees.ts';
import { nativeGitPath, rootFromGitdirFile } from '../src/git/worktreeRecord.ts';
import { gitLinkPath, linkInGitForm, plainGit, type GitRunner } from '../src/memory/git.ts';
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
    // a git whose repair exits zero and fixes nothing in the copy (mp no longer asks git to repair)
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

/** Every file under `dir`, by path, with its bytes as hex (what "untouched" is compared on). */
function filesUnder(dir: string, rel = '', out = new Map<string, string>()): Map<string, string> {
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel === '' ? e.name : join(rel, e.name);
    if (e.isDirectory()) filesUnder(dir, p, out);
    else out.set(p, readFileSync(join(dir, p)).toString('hex'));
  }
  return out;
}

test('opening a copied folder never writes to the original folder, whatever git does with a repair', () => {
  // What `git worktree repair <copied worktree>` run in the copy did with git 2.45 (Git for
  // Windows): it followed the copied link back to the original's administrative directory and
  // pointed the ORIGINAL's two links into the copy, leaving the copy's links as they were.
  const plain = plainGit();
  const repairsTheOriginal: GitRunner = (args, opts) => {
    if (args[0] !== 'worktree' || args[1] !== 'repair') return plain(args, opts);
    for (const copied of args.slice(2)) {
      const originalAdmin = readFileSync(join(copied, '.git'), 'utf8').trim().slice('gitdir: '.length);
      const originalDotgit = readFileSync(join(originalAdmin, 'gitdir'), 'utf8').trim();
      writeFileSync(join(originalAdmin, 'gitdir'), `${gitLinkPath(join(copied, '.git'))}\n`);
      writeFileSync(originalDotgit, `gitdir: ${gitLinkPath(join(opts.cwd, '.git', 'worktrees', basename(originalAdmin)))}\n`);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  for (const [name, runner] of [['plain git', plain], ['a repair that rewrites the original', repairsTheOriginal]] as const) {
    const base = mkdtempSync(join(tmpdir(), 'mp-untouched-'));
    try {
      const original = join(base, 'original');
      const copied = join(base, 'copy');
      mkdirSync(original);
      repo(original);
      initMemory(original);
      for (const path of [join('.mission-pipeline', 'worktrees', 'D-1'), 'other-worktree']) git(original, 'worktree', 'add', '-q', '--detach', path);
      cpSync(original, copied, { recursive: true });
      const before = filesUnder(original);
      const m = openMemory(copied, { git: runner });
      try {
        assert.equal(m.status().gitHold, null, `${name}: ${JSON.stringify(m.status().gitHold)}`);
        assert.deepEqual(m.status().lastMove!.findings.git, { kind: 'repaired', worktrees: 2 }, name);
      } finally {
        m.close();
      }
      const after = filesUnder(original);
      assert.deepEqual([...after.keys()].filter((k) => after.get(k) !== before.get(k)), [], `${name}: nothing under the original folder changed`);
      assert.equal(after.size, before.size);
      for (const path of [join('.mission-pipeline', 'worktrees', 'D-1'), 'other-worktree']) {
        assert.equal(realpathSync(git(join(original, path), 'rev-parse', '--path-format=absolute', '--git-common-dir')), realpathSync(join(original, '.git')), `${name}: ${path} of the original`);
        assert.equal(realpathSync(git(join(copied, path), 'rev-parse', '--path-format=absolute', '--git-common-dir')), realpathSync(join(copied, '.git')), `${name}: ${path} of the copy`);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

/** The paths whose bytes differ between two filesUnder snapshots, or that only one has. */
function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).sort();
}

test('a copy whose .git/worktrees is a link back to the original is held, and nothing under the original changes', () => {
  const base = mkdtempSync(join(tmpdir(), 'mp-linked-admin-'));
  try {
    const original = join(base, 'original');
    const copied = join(base, 'copy');
    mkdirSync(original);
    repo(original);
    initMemory(original);
    git(original, 'worktree', 'add', '-q', '--detach', join('.mission-pipeline', 'worktrees', 'D-1'));
    cpSync(original, copied, { recursive: true });
    // the copy's administrative directories are the original's, through a link (on Windows a
    // directory junction, which needs no privilege); the copied worktree's .git still names the
    // original's, whose commondir "../.." resolves, through the link, into the original
    rmSync(join(copied, '.git', 'worktrees'), { recursive: true, force: true });
    symlinkSync(join(original, '.git', 'worktrees'), join(copied, '.git', 'worktrees'), 'junction');
    const before = filesUnder(original);
    const m = openMemory(copied);
    try {
      const st = m.status();
      assert.match(st.gitHold?.reason ?? '', /WI-31: copied worktree links could not be verified/);
      assert.notEqual(st.movePending, null, 'the move waits for the links');
    } finally {
      m.close();
    }
    assert.deepEqual(changedFiles(before, filesUnder(original)), [], 'nothing under the original folder changed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a link file holding a backslash is not in git\'s form on Windows only', () => {
  assert.equal(linkInGitForm('gitdir: C:\\r\\.git\\worktrees\\D-1', 'win32'), false);
  assert.equal(linkInGitForm('C:\\r\\.mission-pipeline\\worktrees\\D-1\\.git', 'win32'), false);
  assert.equal(linkInGitForm('gitdir: C:/r/.git/worktrees/D-1', 'win32'), true);
  assert.equal(linkInGitForm('gitdir: /r/odd\\name/.git/worktrees/D-1', 'linux'), true, 'off Windows a backslash is a name character');
});

test('a copy whose links an older engine wrote in the native form (backslashes on Windows, 4.3 and 4.4.0) is rewritten in git\'s form and is not held', () => {
  const base = mkdtempSync(join(tmpdir(), 'mp-native-links-'));
  try {
    const original = join(base, 'original');
    const copied = join(base, 'copy');
    mkdirSync(original);
    repo(original);
    initMemory(original);
    git(original, 'worktree', 'add', '-q', '--detach', join('.mission-pipeline', 'worktrees', 'D-1'));
    cpSync(original, copied, { recursive: true });
    const wt = join(copied, '.mission-pipeline', 'worktrees', 'D-1');
    const admin = join(copied, '.git', 'worktrees', 'D-1');
    // what the older direct repair left: both links into the copy, in the platform's native form
    // (rewritten in place: Git for Windows hides a worktree's .git file, and Windows refuses to
    // create over a hidden file)
    const rewrite = (p: string, text: string): void => {
      truncateSync(p, 0);
      writeFileSync(p, text, { flag: 'r+' });
    };
    rewrite(join(wt, '.git'), `gitdir: ${admin}\n`);
    rewrite(join(admin, 'gitdir'), `${join(wt, '.git')}\n`);
    const m = openMemory(copied);
    try {
      assert.equal(m.status().gitHold, null, JSON.stringify(m.status().gitHold));
      assert.equal(m.status().movePending, null);
      assert.deepEqual(m.status().lastMove!.findings.git, { kind: 'repaired', worktrees: 1 });
    } finally {
      m.close();
    }
    assert.equal(readFileSync(join(wt, '.git'), 'utf8'), `gitdir: ${gitLinkPath(admin)}\n`);
    assert.equal(readFileSync(join(admin, 'gitdir'), 'utf8'), `${gitLinkPath(join(wt, '.git'))}\n`);
    const listed = git(copied, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => realpathSync(nativeGitPath(l.slice('worktree '.length))));
    assert.ok(listed.includes(realpathSync(wt)), `git lists the worktree at its folder: ${listed.join(', ')}`);
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
