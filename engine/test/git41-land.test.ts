// Design 4.1 §6.6, §6.7, §11 scenarios 6, 9 and 14; WI-01, WI-02, WI-04,
// WI-05, WI-06; decision 2: landing with plain git, its recovery, closing an
// intent as not landed.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { closeNotLanded, land, recoverLandings, type LandingResult } from '../src/git/land.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { id, type StopId } from '../src/common/ids.ts';
import { commitStop, initMemory, intentInfo, openIntents, openMemory, recordDelivery } from '../src/memory/index.ts';
import { commitOn, fixture, gitWrapper, holdGitWrites, M, recordedDelivery, rejectsCode, sh, words, write, type Fixture } from './git41-fixtures.ts';
import { kinds, tempDir } from './memory-fixtures.ts';

const CHILD = fileURLToPath(new URL('./git41-land-child.ts', import.meta.url));
const POSIX = process.platform !== 'win32';

/** A delivery D on B for `branch` (created at B when it does not exist). */
function delivery(f: Fixture, op: string, branch: string, files: Record<string, string> = { 'src/new.txt': `from ${op}\n` }): { B: string; D: string; ref: string } {
  const B = f.git('rev-parse', 'main');
  if (branch !== 'main') f.git('branch', '-f', branch, B);
  const D = commitOn(f.dir, B, files, `delivery ${op}`);
  return { B, D, ref: recordedDelivery(f, op, D, B, branch) };
}

function landed(r: LandingResult): Extract<LandingResult, { kind: 'landed' }> {
  assert.equal(r.kind, 'landed', JSON.stringify(r));
  return r as Extract<LandingResult, { kind: 'landed' }>;
}

function doneEvents(f: Fixture): number {
  return (f.m.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'intent.state' AND record LIKE '%\"done\"%'").get() as { n: number }).n;
}

test('branch checked out nowhere: compare-and-swap B→D; judged by the ref; recorded done once', async () => {
  const f = fixture();
  try {
    const { B, D } = delivery(f, 'd1', 'release');
    const w = words(f.m);
    const r = landed(await land(f.ctx, { mission: M, delivery: 'd1', words: w }));
    assert.deepEqual([r.via, r.base, r.commit, r.worktree, r.startedBeforeStop], ['cas', B, D, null, false]);
    assert.equal(f.git('rev-parse', 'release'), D);
    assert.equal(f.git('rev-parse', 'main'), B, 'the checked-out branch is untouched');
    assert.equal(intentInfo(f.m, r.intent)?.state, 'done');
    assert.equal(doneEvents(f), 1);
    // Again: the delivery is at D already; a new intent records it, no git update.
    const again = landed(await land(f.ctx, { mission: M, delivery: 'd1', words: w }));
    assert.equal(again.via, 'found');
    await rejectsCode(land(f.ctx, { mission: M, delivery: 'd1', words: 'W-99' }), 'BAD_REQUEST', /no words entry/);
    await rejectsCode(land(f.ctx, { mission: M, delivery: 'nope', words: w }), 'DELIVERY_NOT_CURRENT');
    holdGitWrites(f.m);
    // Already at D: recorded without a git write, also while git writes are held (r3 #5); a landing that must write is refused.
    assert.equal((await land(f.ctx, { mission: M, delivery: 'd1', words: w })).kind, 'landed');
    const D2 = commitOn(f.dir, B, { 'src/d2.txt': 'd2\n' });
    f.git('branch', 'next', B);
    recordedDelivery(f, 'd2', D2, B, 'next');
    await rejectsCode(land(f.ctx, { mission: M, delivery: 'd2', words: w }), 'GIT_WRITES_HELD');
  } finally {
    f.cleanup();
  }
});

test('branch checked out in one clean worktree: the checked fast-forward moves branch, index and files together', async () => {
  const f = fixture();
  try {
    const { B, D } = delivery(f, 'd1', 'main');
    write(f.dir, 'scratch-untracked.txt', 'an untracked file elsewhere is fine\n');
    const r = landed(await land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m) }));
    assert.equal(r.via, 'fast-forward');
    assert.equal(f.git('rev-parse', 'HEAD'), D);
    assert.equal(f.git('symbolic-ref', 'HEAD'), 'refs/heads/main');
    assert.equal(readFileSync(join(f.dir, 'src', 'new.txt'), 'utf8'), 'from d1\n');
    assert.equal(r.worktree?.relation, 'consistent');
    assert.equal(r.base, B);
  } finally {
    f.cleanup();
  }
});

test('class A: dirty worktree (WI-02), several worktrees (WI-01), base moved (WI-05), a leftover lock file (WI-06): nothing written', async () => {
  const f = fixture();
  try {
    const { B, D } = delivery(f, 'd1', 'main');
    const w = words(f.m);
    const before = kinds(f.m).length;
    write(f.dir, 'file.txt', 'uncommitted change\n');
    const dirty = await land(f.ctx, { mission: M, delivery: 'd1', words: w });
    assert.deepEqual(dirty.kind === 'not-landed' && [dirty.wi, dirty.reason, dirty.paths], ['WI-02', 'dirty', ['file.txt']]);
    f.git('checkout', '--', 'file.txt');
    // An untracked file where the delivery puts one.
    write(f.dir, 'src/new.txt', 'in the way\n');
    const inTheWay = await land(f.ctx, { mission: M, delivery: 'd1', words: w });
    assert.deepEqual(inTheWay.kind === 'not-landed' && inTheWay.paths, ['src/new.txt']);
    f.git('clean', '-fdq', 'src');
    // A duplicate checkout of main.
    const dup = join(tempDir('mp-dup-'), 'dup');
    f.git('worktree', 'add', '-q', '--force', dup, 'main');
    const several = await land(f.ctx, { mission: M, delivery: 'd1', words: w });
    assert.deepEqual(several.kind === 'not-landed' && [several.wi, several.reason], ['WI-01', 'several-worktrees']);
    f.git('worktree', 'remove', '--force', dup);
    // A ref lock git left.
    const lockFile = join(f.dir, '.git', 'refs', 'heads', 'main.lock');
    write(f.dir, '.git/refs/heads/main.lock', 'x');
    const locked = await land(f.ctx, { mission: M, delivery: 'd1', words: w });
    assert.deepEqual(locked.kind === 'refused' && [locked.wi, locked.reason, locked.lockFiles], ['WI-06', 'lock-file', [lockFile]]);
    sh(f.dir, 'update-ref', 'refs/heads/unused', B); // git itself still works on other refs
    // The base moved.
    const moved = commitOn(f.dir, B, { 'other.txt': 'someone else\n' });
    rmSync(lockFile);
    f.git('merge', '-q', '--ff-only', moved);
    const m2 = await land(f.ctx, { mission: M, delivery: 'd1', words: w });
    assert.deepEqual(m2.kind === 'base-moved' && [m2.wi, m2.base, m2.now], ['WI-05', B, moved]);
    assert.equal(kinds(f.m).length - before, 0, 'nothing recorded');
    assert.equal(f.m.read((db) => openIntents(db)).length, 0);
    assert.notEqual(f.git('rev-parse', 'main'), D);
  } finally {
    f.cleanup();
  }
});

test('HEAD switched between the check and the merge: WI-06 class C; git is not run again automatically; the PM closes it after a fresh check', { skip: !POSIX }, async () => {
  const f = fixture();
  try {
    const { B, D } = delivery(f, 'd1', 'main');
    f.git('branch', 'other', B);
    const wrapper = gitWrapper(tempDir('mp-wrap-'), { pattern: '*" merge "*', mark: join(f.dir, '.git', 'mp-merge-mark'), before: `git symbolic-ref HEAD refs/heads/other` });
    const raced = { memory: f.m, git: PlainGit.create({ gitPath: wrapper }) };
    const w = words(f.m);
    const r = await land(raced, { mission: M, delivery: 'd1', words: w });
    assert.equal(r.kind, 'open', JSON.stringify(r));
    if (r.kind !== 'open') return;
    assert.equal(r.class, 'C');
    assert.match(r.detail, /changed between the check and the fast-forward/);
    assert.equal(f.git('rev-parse', 'main'), B, 'the target never moved');
    assert.equal(intentInfo(f.m, r.intent)?.state, 'authorized', 'the intent stays open');
    // Recovery reports it, records the same verdict only once.
    const n = kinds(f.m).length;
    const rec = await recoverLandings(f.ctx);
    assert.equal(rec.kind === 'checked' && rec.results[0]?.kind, 'open');
    assert.equal(kinds(f.m).length, n, 'the same verdict is not recorded again');
    // The PM closes it as not landed (decision 2), after a fresh check.
    f.git('symbolic-ref', 'HEAD', 'refs/heads/main');
    f.git('reset', '-q', '--hard', B);
    const closed = await closeNotLanded(f.ctx, { mission: M, delivery: 'd1' });
    assert.deepEqual(closed, { kind: 'closed', intent: r.intent, ref: B });
    assert.equal(intentInfo(f.m, r.intent)?.state, 'failed');
    assert.deepEqual(await closeNotLanded(f.ctx, { mission: M, delivery: 'd1' }), { kind: 'no-open-intent' });
    // A later landing starts a new intent and lands.
    const again = landed(await land(f.ctx, { mission: M, delivery: 'd1', words: w }));
    assert.notEqual(again.intent, r.intent);
    assert.equal(f.git('rev-parse', 'main'), D);
  } finally {
    f.cleanup();
  }
});

test('a crash between the intent and git leaves it open at B; a stop committed meanwhile refuses the retry; recovery reports "started before the stop"', async () => {
  const f = fixture();
  try {
    const { B } = delivery(f, 'd1', 'release');
    const w = words(f.m);
    await assert.rejects(land(f.ctx, { mission: M, delivery: 'd1', words: w }, { beforeGit: () => { throw new Error('crash before git'); } }), /crash before git/);
    const open = f.m.read((db) => openIntents(db));
    assert.equal(open.length, 1);
    const rec = await recoverLandings(f.ctx);
    assert.equal(rec.kind === 'checked' && rec.results[0]?.kind === 'open' && rec.results[0].class, 'B');
    // Another delivery cannot land on the branch while this intent is open.
    const D2 = commitOn(f.dir, B, { 'src/d2.txt': 'd2\n' });
    recordedDelivery(f, 'd2', D2, B, 'release');
    const other = await land(f.ctx, { mission: M, delivery: 'd2', words: w });
    assert.deepEqual(other.kind === 'refused' && [other.reason, other.intent], ['other-intent-open', open[0]!.intent]);
    f.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-1'), scope: { kind: 'mission', mission: M }, words: 'stop', at: 1 }));
    await rejectsCode(land(f.ctx, { mission: M, delivery: 'd1', words: w }), 'STOPPED');
    assert.equal(f.git('rev-parse', 'release'), B);
    const after = await recoverLandings(f.ctx);
    const res = after.kind === 'checked' ? after.results[0] : undefined;
    assert.equal(res?.kind === 'open' && res.startedBeforeStop, true);
    assert.equal(intentInfo(f.m, open[0]!.intent)?.state, 'authorized', 'at B never closes the intent');
  } finally {
    f.cleanup();
  }
});

test('the parent mp killed while its git child survives: "landing in progress" for an ordinary call; at B the intent stays open; the retry lands D once; done when seen at D', { skip: !POSIX }, async () => {
  const f = fixture();
  try {
    const { B, D } = delivery(f, 'd1', 'release');
    const w = words(f.m);
    const mark = join(f.dir, '.git', 'mp-update-mark');
    const wrapper = gitWrapper(tempDir('mp-wrap-'), { pattern: '*" update-ref "*refs/heads/release*', mark, sleep: 3 });
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CHILD, JSON.stringify({ dir: f.dir, mission: M, delivery: 'd1', words: w, gitPath: wrapper })], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    for (let i = 0; i < 200 && !existsSync(mark); i++) await sleep(50);
    assert.ok(existsSync(mark), `the child's git step started (stderr: ${err})`);
    // An ordinary call while the landing runs: in progress, nothing recorded.
    const n = kinds(f.m).length;
    const during = await recoverLandings(f.ctx);
    assert.equal(during.kind, 'in-progress');
    assert.equal(kinds(f.m).length, n);
    // The parent dies; its git child goes on sleeping.
    child.kill('SIGKILL');
    await exited;
    assert.ok(!existsSync(`${mark}.done`), 'the git child is still running');
    const after = await recoverLandings(f.ctx);
    const r1 = after.kind === 'checked' ? after.results[0] : undefined;
    assert.equal(r1?.kind === 'open' && r1.class, 'B');
    assert.equal(f.git('rev-parse', 'release'), B);
    // The retry reissues the same B→D under the lock.
    const retry = landed(await land(f.ctx, { mission: M, delivery: 'd1', words: w }));
    assert.equal(retry.intent, r1?.kind === 'open' ? r1.intent : '');
    assert.equal(f.git('rev-parse', 'release'), D);
    // The old git command finishes later: its B→D no longer applies; D stays, landed once.
    for (let i = 0; i < 200 && !existsSync(`${mark}.done`); i++) await sleep(50);
    assert.ok(existsSync(`${mark}.done`));
    assert.equal(f.git('rev-parse', 'release'), D);
    const last = await recoverLandings(f.ctx);
    assert.deepEqual(last, { kind: 'checked', results: [] });
    assert.equal(doneEvents(f), 1);
  } finally {
    f.cleanup();
  }
});

test('the parent killed after the git update and before its record: the next call sees D and records it done without a second update (§11.6)', async () => {
  const f = fixture();
  try {
    const { D } = delivery(f, 'd1', 'release');
    const w = words(f.m);
    await assert.rejects(land(f.ctx, { mission: M, delivery: 'd1', words: w }, { afterGit: () => { throw new Error('killed after git'); } }), /killed after git/);
    assert.equal(f.git('rev-parse', 'release'), D);
    const reflog = f.git('reflog', 'show', '--format=%H', 'refs/heads/release').split('\n').length;
    const rec = await recoverLandings(f.ctx);
    const r = rec.kind === 'checked' ? rec.results[0] : undefined;
    assert.equal(r?.kind === 'landed' && r.via, 'found');
    assert.equal(f.git('reflog', 'show', '--format=%H', 'refs/heads/release').split('\n').length, reflog, 'no second update');
    assert.equal(doneEvents(f), 1);
  } finally {
    f.cleanup();
  }
});

test('the worktree does not match after the landing: recorded done, WI-04 with the recovery command when its precondition holds', async () => {
  const f = fixture();
  try {
    const { B, D } = delivery(f, 'd1', 'main');
    // Someone moves only the ref (as a CAS landing would if the branch were checked out in a worktree mp did not see).
    await assert.rejects(land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m) }, { beforeGit: () => { f.git('update-ref', 'refs/heads/main', D, B); throw new Error('crash'); } }), /crash/);
    const rec = await recoverLandings(f.ctx);
    const r = rec.kind === 'checked' ? rec.results[0] : undefined;
    assert.equal(r?.kind, 'landed');
    if (r?.kind !== 'landed') return;
    assert.equal(r.worktree?.relation, 'branch-advanced-files-stale');
    assert.match(r.worktree?.command ?? '', /read-tree -u -m/);
    const alerts = f.m.stmt("SELECT record FROM log WHERE kind = 'alert'").all() as Array<{ record: string }>;
    assert.ok(alerts.some((a) => a.record.includes('"WI-04"')));
  } finally {
    f.cleanup();
  }
});

test('a project folder in a linked worktree (§11.15): its own branch is not external; the fast-forward lands there; the main checkout is untouched', async () => {
  const base = tempDir('mp-linked-');
  const main = join(base, 'main');
  const wt = join(base, 'wt');
  sh(base, 'init', '-q', '-b', 'main', main);
  repo_commit(main);
  sh(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  initMemory(wt);
  const m = openMemory(wt);
  try {
    const ctx = { memory: m, git: PlainGit.create() };
    const B = sh(wt, 'rev-parse', 'HEAD');
    const D = commitOn(wt, B, { 'feature.txt': 'feature\n' });
    sh(wt, 'update-ref', `refs/mission-pipeline/delivered/${M}/d1`, D);
    m.write({}, (tx) => recordDelivery(tx, { mission: M, delivery: 'd1', commit: D, base: B, ref: `refs/mission-pipeline/delivered/${M}/d1`, manifest: tx.data.put('m'), target: 'feature' }));
    const r = landed(await land(ctx, { mission: M, delivery: 'd1', words: words(m) }));
    assert.equal(r.via, 'fast-forward');
    assert.equal(sh(wt, 'rev-parse', 'HEAD'), D);
    assert.equal(readFileSync(join(wt, 'feature.txt'), 'utf8'), 'feature\n');
    assert.equal(sh(main, 'rev-parse', 'HEAD'), B);
  } finally {
    m.close();
    rmSync(base, { recursive: true, force: true });
  }
});

function repo_commit(dir: string): void {
  write(dir, 'file.txt', 'hello\n');
  sh(dir, 'add', 'file.txt');
  sh(dir, 'commit', '-q', '-m', 'first');
}
