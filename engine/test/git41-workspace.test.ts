// Design 4.1 §5.3, §5.4, decisions 10 and 17: dispatch worktrees, candidate
// collection, clean checkouts; the plain git runner.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PlainGit } from '../src/git/plainGit.ts';
import { checkoutCommit, collectCandidate, ensureWorkspace, releaseWorkspace, removeCheckout, removeWorkspace, runCheckoutDir, seatCheckoutDir, workspaceDir } from '../src/git/workspace.ts';
import { openMemory } from '../src/memory/index.ts';
import { fixture, holdGitWrites, IDENT, sh, write } from './git41-fixtures.ts';
import { throwsCode } from './memory-fixtures.ts';

const FILES = { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n', 'docs/readme.md': '# r\n', '.gitignore': '*.log\nbuild/\n' };

function collect(f: ReturnType<typeof fixture>, dispatch: string, writePaths: string[]) {
  return collectCandidate(f.ctx, { dispatch, base: f.base, writePaths, message: `candidate of ${dispatch}\n`, author: IDENT, committer: IDENT });
}

test('the plain runner: async and sync forms, the memory shape, no repository locators inherited', async () => {
  const f = fixture();
  const saved = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = '/nonexistent/.git';
    const git = PlainGit.create();
    assert.equal(await git.text(['rev-parse', 'HEAD'], { cwd: f.dir }), f.base);
    assert.equal(git.textSync(['rev-parse', 'HEAD'], { cwd: f.dir }), f.base);
    const r = git.runner()(['rev-parse', 'HEAD'], { cwd: f.dir });
    assert.deepEqual([r.code, r.stdout.trim()], [0, f.base]);
    assert.equal(git.runSync(['rev-parse', '--verify', 'nope'], { cwd: f.dir }).code !== 0, true);
    await assert.rejects(git.ok(['rev-parse', '--verify', 'nope'], { cwd: f.dir }), /exited/);
    assert.equal(PlainGit.create({ gitPath: '/nonexistent/git' }).runner()(['status'], { cwd: f.dir }).code, -1);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
    f.cleanup();
  }
});

test('a dispatch worktree: created detached at its base, idempotent, kept on --abandoned, removed on --ended; refused while git writes are held', () => {
  const f = fixture({ files: FILES });
  try {
    const w = ensureWorkspace(f.ctx, { dispatch: 'D-1', base: f.base });
    assert.equal(w.created, true);
    assert.equal(w.path, join(f.m.paths.worktrees, 'D-1'));
    assert.equal(sh(w.path, 'rev-parse', 'HEAD'), f.base);
    assert.throws(() => sh(w.path, 'symbolic-ref', '-q', 'HEAD'), 'detached');
    assert.equal(readFileSync(join(w.path, 'src', 'a.txt'), 'utf8'), 'a\n');
    write(w.path, 'src/a.txt', 'work in progress\n');
    assert.equal(ensureWorkspace(f.ctx, { dispatch: 'D-1', base: f.base }).created, false, 'the seat’s work is left as it is');
    assert.equal(readFileSync(join(w.path, 'src', 'a.txt'), 'utf8'), 'work in progress\n');
    // The main worktree does not see it (the memory folder is excluded).
    assert.equal(f.git('status', '--porcelain'), '');
    assert.deepEqual(releaseWorkspace(f.ctx, 'D-1', 'abandoned'), { removed: false, kept: true, path: w.path });
    assert.ok(existsSync(w.path));
    assert.deepEqual(releaseWorkspace(f.ctx, 'D-1', 'ended'), { removed: true, kept: false, path: w.path });
    assert.ok(!existsSync(w.path));
    assert.ok(!f.git('worktree', 'list', '--porcelain').includes('D-1'));
    assert.deepEqual(removeWorkspace(f.ctx, 'D-1'), { removed: false, path: w.path });
    // A registration whose directory vanished is replaced.
    const w2 = ensureWorkspace(f.ctx, { dispatch: 'D-2', base: f.base });
    rmSync(w2.path, { recursive: true, force: true });
    assert.equal(ensureWorkspace(f.ctx, { dispatch: 'D-2', base: f.base }).created, true);
    throwsCode(() => ensureWorkspace(f.ctx, { dispatch: 'D-3', base: 'f'.repeat(40) }), 'BAD_REQUEST', /not a commit/);
    throwsCode(() => ensureWorkspace(f.ctx, { dispatch: '../x', base: f.base }), 'BAD_REQUEST');
    holdGitWrites(f.m);
    throwsCode(() => ensureWorkspace(f.ctx, { dispatch: 'D-4', base: f.base }), 'GIT_WRITES_HELD');
    throwsCode(() => removeWorkspace(f.ctx, 'D-2'), 'GIT_WRITES_HELD');
  } finally {
    f.cleanup();
  }
});

test('collection: new files, the seat’s commits, uncommitted changes and deletions form one candidate on the base; ignored files are listed, not collected', async () => {
  const f = fixture({ files: FILES });
  try {
    const w = ensureWorkspace(f.ctx, { dispatch: 'D-1', base: f.base }).path;
    // A commit the seat made, then more work on top of it, uncommitted.
    write(w, 'src/a.txt', 'a, committed by the seat\n');
    sh(w, 'commit', '-q', '-am', 'seat commit');
    write(w, 'src/a.txt', 'a, then changed again\n');
    write(w, 'src/new/c.txt', 'a new file, never added\n');
    unlinkSync(join(w, 'src', 'b.txt'));
    write(w, 'src/debug.log', 'ignored\n');
    write(w, 'src/build/out.bin', 'ignored too\n');
    const c = await collect(f, 'D-1', ['src/**']);
    assert.equal(c.kind, 'candidate', JSON.stringify(c));
    if (c.kind !== 'candidate') return;
    assert.deepEqual([c.added, c.modified, c.deleted, c.empty], [['src/new/c.txt'], ['src/a.txt'], ['src/b.txt'], false]);
    assert.deepEqual(c.ignored, { paths: ['src/build/', 'src/debug.log'], total: 2 });
    assert.equal(f.git('rev-parse', `${c.commit}^@`), f.base, 'the only parent is the base');
    assert.equal(f.git('show', `${c.commit}:src/a.txt`), 'a, then changed again');
    assert.equal(f.git('show', `${c.commit}:src/new/c.txt`), 'a new file, never added');
    assert.equal(f.git('show', `${c.commit}:docs/readme.md`), '# r');
    assert.deepEqual(f.git('ls-tree', '-r', '--name-only', c.commit).split('\n').sort(), ['.gitignore', 'docs/readme.md', 'file.txt', 'src/a.txt', 'src/new/c.txt']);
    // Nothing in the worktree was staged or changed by the collection.
    assert.equal(sh(w, 'status', '--porcelain', '--untracked-files=no').includes('A '), false);
    assert.equal(readFileSync(join(w, 'src', 'debug.log'), 'utf8'), 'ignored\n');
    // A seat that changed nothing: an empty candidate.
    ensureWorkspace(f.ctx, { dispatch: 'D-2', base: f.base });
    const e = await collect(f, 'D-2', ['src/**']);
    assert.equal(e.kind === 'candidate' && e.empty, true);
  } finally {
    f.cleanup();
  }
});

test('collection refuses changes outside the write paths (listed), a switched or reset HEAD, a missing worktree; git writes held', async () => {
  const f = fixture({ files: FILES });
  try {
    const w = ensureWorkspace(f.ctx, { dispatch: 'D-1', base: f.base }).path;
    write(w, 'src/a.txt', 'inside\n');
    write(w, 'docs/readme.md', 'outside, modified\n');
    write(w, 'notes.txt', 'outside, new\n');
    unlinkSync(join(w, 'file.txt'));
    write(w, 'docs/ignored.log', 'ignored outside: never a change\n');
    const out = await collect(f, 'D-1', ['src/**']);
    assert.deepEqual(out.kind === 'outside-write-paths' && out.paths, ['docs/readme.md', 'file.txt', 'notes.txt']);
    // An exact path counts as inside.
    const ok = await collect(f, 'D-1', ['src/**', 'docs/readme.md', 'notes.txt', 'file.txt']);
    assert.equal(ok.kind, 'candidate');
    // Decision 17: a branch switched to, or a base reset to another commit.
    const w2 = ensureWorkspace(f.ctx, { dispatch: 'D-2', base: f.base }).path;
    sh(w2, 'switch', '-q', '-c', 'seat-branch');
    const moved = await collect(f, 'D-2', ['**']);
    assert.equal(moved.kind === 'head-moved' && moved.branch, 'refs/heads/seat-branch');
    const w3 = ensureWorkspace(f.ctx, { dispatch: 'D-3', base: f.base }).path;
    sh(w3, 'checkout', '-q', '--detach', `${f.base}~1`);
    const reset = await collect(f, 'D-3', ['**']);
    assert.equal(reset.kind, 'head-moved');
    assert.match(reset.kind === 'head-moved' ? reset.detail : '', /does not descend from the base/);
    assert.equal((await collect(f, 'D-9', ['**'])).kind, 'no-workspace');
    holdGitWrites(f.m);
    await assert.rejects(collect(f, 'D-1', ['src/**']), /GIT_WRITES_HELD|held/);
  } finally {
    f.cleanup();
  }
});

test('a clean checkout holds exactly the commit’s files: no untracked or ignored file of any worktree; removed after use', async () => {
  const f = fixture({ files: FILES });
  try {
    const w = ensureWorkspace(f.ctx, { dispatch: 'D-1', base: f.base }).path;
    write(w, 'src/a.txt', 'changed\n');
    write(w, 'src/debug.log', 'ignored in the worktree\n');
    write(f.dir, 'untracked-in-main.txt', 'untracked in the main worktree\n');
    write(f.dir, 'main.log', 'ignored in the main worktree\n');
    const c = await collect(f, 'D-1', ['src/**']);
    assert.equal(c.kind, 'candidate');
    if (c.kind !== 'candidate') return;
    const dir = runCheckoutDir(f.m.paths, 'run-1');
    const co = await checkoutCommit(f.ctx, { commit: c.commit, dir });
    assert.equal(co.commit, c.commit);
    assert.equal(readFileSync(join(dir, 'src', 'a.txt'), 'utf8'), 'changed\n');
    for (const absent of ['src/debug.log', 'untracked-in-main.txt', 'main.log', '.git']) assert.ok(!existsSync(join(dir, ...absent.split('/'))), absent);
    assert.deepEqual(co.manifest.entries.map((e) => e.path).sort(), ['.gitignore', 'docs/readme.md', 'file.txt', 'src/a.txt', 'src/b.txt']);
    // Not a registered worktree.
    assert.ok(!f.git('worktree', 'list', '--porcelain').includes('run-1'));
    // A seat's checkout (decision 10) is replaced when asked again.
    const seat = seatCheckoutDir(f.m.paths, 'D-7');
    write(seat, 'stale.txt', 'left from before\n');
    await checkoutCommit(f.ctx, { commit: f.base, dir: seat });
    assert.ok(!existsSync(join(seat, 'stale.txt')));
    assert.equal(readFileSync(join(seat, 'src', 'a.txt'), 'utf8'), 'a\n');
    assert.deepEqual(removeCheckout(f.ctx, dir), { removed: true });
    assert.ok(!existsSync(dir));
    assert.deepEqual(removeCheckout(f.ctx, dir), { removed: false });
    await assert.rejects(checkoutCommit(f.ctx, { commit: f.base, dir: join(f.dir, 'elsewhere') }), /under/);
    assert.throws(() => removeCheckout(f.ctx, f.dir), /only checkouts under/);
    assert.equal(workspaceDir(f.m.paths, 'D-1'), w);
    // The memory opened with the same runner.
    const again = openMemory(f.dir, { git: PlainGit.create().runner() });
    again.close();
  } finally {
    f.cleanup();
  }
});
