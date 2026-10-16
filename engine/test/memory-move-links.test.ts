import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listNotices } from '../src/process/notices.ts';
import { initMemory, openMemory } from '../src/memory/index.ts';
import type { GitRunner } from '../src/memory/git.ts';
import { tempDir, throwsCode } from './memory-fixtures.ts';

test('zero from old repair is insufficient: direct links are verified, failed listing holds and notices; retry finishes without touching work', () => {
  const base = tempDir('mp-links-');
  const original = join(base, 'original');
  const copied = join(base, 'copy');
  const suffix = join('.mission-pipeline', 'worktrees', 'D-1');
  const oldAdmin = join(original, '.git', 'worktrees', 'D-1');
  const oldWt = join(original, suffix);
  mkdirSync(oldAdmin, { recursive: true });
  mkdirSync(oldWt, { recursive: true });
  writeFileSync(join(oldWt, '.git'), `gitdir: ${oldAdmin}\n`);
  writeFileSync(join(oldAdmin, 'gitdir'), `${join(oldWt, '.git')}\n`);
  writeFileSync(join(oldAdmin, 'commondir'), '../..\n');
  writeFileSync(join(oldAdmin, 'HEAD'), 'head sentinel\n');
  writeFileSync(join(oldAdmin, 'index'), 'index sentinel\n');
  writeFileSync(join(oldWt, 'unfinished.txt'), 'uncommitted sentinel\n');
  initMemory(original, { git: null });
  cpSync(original, copied, { recursive: true });
  let listed = false;
  const git: GitRunner = (args) => {
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${copied}\n${join(copied, '.git')}\n${join(copied, '.git')}\n`, stderr: '' };
    if (args.includes('repair')) return { code: 0, stdout: '', stderr: '' }; // git 2.43's no-op
    if (args.includes('list')) return { code: 0, stdout: `worktree ${listed ? join(copied, suffix) : oldWt}\0\0`, stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  try {
    let m = openMemory(copied, { git });
    let status = m.status();
    assert.match(status.gitHold!.reason, /WI-31/);
    assert.notEqual(status.movePending, null, 'failed verification never finishes the move');
    assert.equal(m.read((db) => listNotices(db, m.data))[0]!.wi, 'WI-31');
    assert.equal((m.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'memory.moved'").get() as { n: number }).n, 0);
    assert.equal((m.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'notice'").get() as { n: number }).n, 1);
    const alreadyOpen = openMemory(copied, { git });
    try {
      const head = m.head();
      throwsCode(() => m.confirmCopyInUse({ op: 'confirm-pending-links' }), 'GIT_WRITES_HELD', /WI-31.*[Ff]ix the links and retry mp/);
      assert.equal(m.head(), head, 'a refused confirm appends neither an event nor a receipt');
      assert.notEqual(m.gitHold(), null);
      throwsCode(() => alreadyOpen.assertGitWrites('delivery'), 'GIT_WRITES_HELD');
    } finally { alreadyOpen.close(); }
    const admin = join(copied, '.git', 'worktrees', 'D-1');
    assert.equal(readFileSync(join(copied, suffix, '.git'), 'utf8'), `gitdir: ${admin}\n`, 'direct rewrite corrected the forward link');
    assert.equal(readFileSync(join(admin, 'gitdir'), 'utf8'), `${join(copied, suffix, '.git')}\n`);
    m.close();
    m = openMemory(copied, { git });
    assert.notEqual(m.status().movePending, null);
    assert.equal((m.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'notice'").get() as { n: number }).n, 1, 'retry is idempotent');
    m.close();
    m = openMemory(copied, { git: () => ({ code: -1, stdout: '', stderr: 'git temporarily unavailable' }) });
    assert.notEqual(m.status().gitHold, null, 'an unavailable repository cannot clear a failed verification');
    assert.notEqual(m.status().movePending, null);
    m.close();
    listed = true;
    m = openMemory(copied, { git });
    status = m.status();
    assert.equal(status.movePending, null);
    assert.equal(status.gitHold, null);
    assert.deepEqual(m.confirmCopyInUse({ op: 'confirm-pending-links' }), { released: false }, 'the refused operation left no successful receipt');
    assert.deepEqual(status.lastMove!.findings.git, { kind: 'repaired', worktrees: 1 });
    m.close();
    for (const dir of [oldAdmin, admin]) {
      assert.equal(readFileSync(join(dir, 'HEAD'), 'utf8'), 'head sentinel\n');
      assert.equal(readFileSync(join(dir, 'index'), 'utf8'), 'index sentinel\n');
    }
    assert.equal(readFileSync(join(copied, suffix, 'unfinished.txt'), 'utf8'), 'uncommitted sentinel\n');
    assert.equal(readFileSync(join(oldWt, '.git'), 'utf8'), `gitdir: ${oldAdmin}\n`, 'source untouched');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('confirm-copy still releases a shared-repository hold for already-open memories', () => {
  const base = tempDir('mp-shared-links-');
  const original = join(base, 'original');
  const copied = join(base, 'copy');
  mkdirSync(original);
  initMemory(original, { git: null });
  cpSync(original, copied, { recursive: true });
  const common = join(base, 'shared.git');
  const git: GitRunner = (args) => args[0] === 'rev-parse'
    ? { code: 0, stdout: `${copied}\n${common}\n${common}\n`, stderr: '' }
    : { code: 1, stdout: '', stderr: '' };
  const m = openMemory(copied, { git });
  const alreadyOpen = openMemory(copied, { git });
  try {
    assert.equal(m.status().movePending, null);
    throwsCode(() => alreadyOpen.assertGitWrites('delivery'), 'GIT_WRITES_HELD');
    assert.deepEqual(m.confirmCopyInUse({ op: 'confirm-shared' }), { released: true });
    assert.doesNotThrow(() => alreadyOpen.assertGitWrites('delivery'));
    assert.deepEqual(m.confirmCopyInUse({ op: 'confirm-shared' }), { released: true }, 'receipt is idempotent');
    assert.equal((m.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'memory.git-confirmed'").get() as { n: number }).n, 1);
  } finally {
    alreadyOpen.close();
    m.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('a copied Windows registration is relocated, and a wrong commondir refuses repair until corrected', async () => {
  const { copiedWorktrees, repairWorktrees } = await import('../src/memory/git.ts');
  const root = tempDir('mp-winlinks-');
  const common = join(root, '.git');
  const admin = join(common, 'worktrees', 'D-1');
  const worktree = join(root, 'nested-worktree');
  mkdirSync(admin, { recursive: true });
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), 'gitdir: C:/Project/.git/worktrees/D-1\n');
  writeFileSync(join(admin, 'gitdir'), 'C:/Project/nested-worktree/.git\n');
  writeFileSync(join(admin, 'commondir'), '../../../outside.git\n');
  const git: GitRunner = (args) => ({ code: 0, stdout: args.includes('list') ? `worktree ${worktree}\0\0` : '', stderr: '' });
  try {
    assert.deepEqual(copiedWorktrees(common, 'C:\\Project', root), [worktree]);
    assert.notEqual(repairWorktrees(git, root, [worktree], common, 'C:\\Project').code, 0);
    assert.match(readFileSync(join(worktree, '.git'), 'utf8'), /C:\/Project/, 'no unsafe rewrite on a wrong common directory');
    writeFileSync(join(admin, 'commondir'), '../..\n');
    assert.equal(repairWorktrees(git, root, [worktree], common, 'C:\\Project').code, 0);
    assert.equal(readFileSync(join(worktree, '.git'), 'utf8'), `gitdir: ${admin}\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a missing copied .git is reported as prunable without holding recovery', () => {
  const base = tempDir('mp-prunable-links-');
  const original = join(base, 'original');
  const copied = join(base, 'copy');
  for (const name of ['live', 'deleted']) {
    const admin = join(original, '.git', 'worktrees', name);
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, 'gitdir'), `${join(original, name, '.git')}\n`);
    writeFileSync(join(admin, 'commondir'), '../..\n');
    if (name === 'live') {
      mkdirSync(join(original, name));
      writeFileSync(join(original, name, '.git'), `gitdir: ${admin}\n`);
    }
  }
  initMemory(original, { git: null });
  cpSync(original, copied, { recursive: true });
  const live = join(copied, 'live');
  const git: GitRunner = (args) => {
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${copied}\n${join(copied, '.git')}\n${join(copied, '.git')}\n`, stderr: '' };
    if (args.includes('repair')) {
      assert.deepEqual(args.slice(2), [live], 'repair only targets the live registration');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args.includes('list')) return { code: 0, stdout: `worktree ${live}\0\0`, stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const m = openMemory(copied, { git });
  try {
    const status = m.status();
    assert.equal(status.gitHold, null);
    assert.equal(status.movePending, null);
    assert.deepEqual(status.lastMove!.findings.git, { kind: 'repaired', worktrees: 1 });
    assert.deepEqual(status.lastMove!.findings.layout, [`Skipped prunable worktree registration (no .git in this copy): ${join(copied, 'deleted')}`]);
    assert.equal(readFileSync(join(live, '.git'), 'utf8'), `gitdir: ${join(copied, '.git', 'worktrees', 'live')}\n`);
  } finally { m.close(); rmSync(base, { recursive: true, force: true }); }
});
