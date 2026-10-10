// Regression tests for the git landing code review r1 (gpt-6.1-sol: findings 1,
// 3, 4, 7, 10, 11, 14) and for design v43-v49 (6.6 "目标分支的占用", "落地的结果",
// "可以安全重试", the push-to-checkout hook, submodules, materialization inputs,
// the one command generator, replace objects, read-only checks, raw history, no
// implicit fetch, no network), on real repositories and real bubblewrap.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { id, type GitOid, type MissionId, type OpId } from '../src/common/ids.ts';
import { computeMaterializedChangeSet } from '../src/git/changeSet.ts';
import { land, landingLocks, MemoryLandingJournal, recoverLanding, REFUSAL_WORK_INSTRUCTIONS, SimulatedCrash, type LandingDeps, type LandingReport, type LandingRequest } from '../src/git/landing.ts';

const REFUSAL_TEXT = (r: keyof typeof REFUSAL_WORK_INSTRUCTIONS): string => REFUSAL_WORK_INSTRUCTIONS[r].defaultAction;
import { classifyLandingOutcome, safeToRetry, type ApprovedState } from '../src/git/landingResult.ts';
import { landWhenReady } from '../src/git/landingRetry.ts';
import { bwrapArgv, LandingView, LFS_COMPARE_SCRIPT } from '../src/git/landingView.ts';
import { encodeLfsPointer, lfsObjectPath, lfsPointerFor } from '../src/git/lfs.ts';
import { ancestry, discoverRepo, gitOid, type RepoLayout } from '../src/git/objects.ts';
import { createProgramRef, deliveryRef } from '../src/git/refs.ts';
import { AttributeEvaluator, readTransformDescription, type TransformDescription } from '../src/git/representation.ts';
import { checkoutMain, initRepo, makeFixture, rawCommit, readTreeContent, sameTreeContent, writeExecutable, type FileSpec, type Fixture } from './git-fixtures.test.ts';

let fx: Fixture;
before(() => {
  fx = makeFixture('landing-review');
});
after(() => fx.cleanup());

const M = id<MissionId>('m1');
const NO_LEDGER = { reserve: { recoveryReserveBytes: 0, evaluatorPoolBytes: 0 }, sharesVolume: () => false };
let n = 0;

interface R {
  repo: string;
  layout: RepoLayout;
  common: string;
  A: GitOid;
  d: TransformDescription;
}

async function makeRepo(files: Record<string, FileSpec> = { 'f.txt': 'one\n', 'g.txt': 'g\n' }, parent: GitOid | null = null): Promise<R> {
  const repo = initRepo(fx, `rv${n++}`);
  const A = rawCommit(fx, repo, files, parent, 'A');
  checkoutMain(fx, repo, A);
  fx.raw(['branch', 'feature', A], repo);
  const layout = await discoverRepo(fx.git, repo);
  const d = await readTransformDescription(fx.git, layout, fx.user);
  return { repo, layout, common: layout.commonDir, A, d };
}

async function delivery(r: R, files: Record<string, FileSpec>, base: GitOid = r.A): Promise<LandingRequest> {
  const B = rawCommit(fx, r.repo, files, base, 'delivery');
  const op = id<OpId>(`op${n++}`);
  assert.equal((await createProgramRef(fx.git, r.layout, deliveryRef(M, op), B)).kind, 'created');
  return { key: { mission: M, op }, repoPath: r.repo, targetBranch: 'main', base, delivery: B, description: r.d, user: fx.user, ledger: NO_LEDGER };
}

function deps(journal = new MemoryLandingJournal(), extra: Partial<LandingDeps> = {}): LandingDeps {
  return { git: fx.git, journal, scratchDir: fx.root, ...extra };
}

function checked(r: LandingReport): Extract<LandingReport, { kind: 'checked' }> {
  assert.equal(r.kind, 'checked', JSON.stringify(r));
  return r as Extract<LandingReport, { kind: 'checked' }>;
}

function refused(r: LandingReport): Extract<LandingReport, { kind: 'not-auto-landed' }> {
  assert.equal(r.kind, 'not-auto-landed', JSON.stringify(r));
  return r as Extract<LandingReport, { kind: 'not-auto-landed' }>;
}

function rev(dir: string, r: string): string {
  return fx.raw(['rev-parse', r], dir);
}

function raw(args: readonly string[], cwd: string): string {
  return fx.raw(['-c', 'core.hooksPath=/dev/null', ...args], cwd);
}

async function waitFile(p: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(p)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${p}`);
    await new Promise((res) => setTimeout(res, 10));
  }
}

/** Runs `fn` at a barrier of the program's push-to-checkout hook (6.6 v47 test plan), during land(). */
async function landAt(req: LandingRequest, at: 'start' | 'before-read-tree' | 'after-read-tree', fn: () => void, journal = new MemoryLandingJournal(), extra: Partial<LandingDeps> = {}): Promise<LandingReport> {
  const dir = mkdtempSync(join(fx.root, 'barrier-'));
  const p = land(req, deps(journal, { ...extra, checkoutBarrier: { at, dir } }));
  let failed: unknown = null;
  const reached = waitFile(join(dir, 'ready')).then(
    () => {
      try {
        fn();
      } catch (e) {
        failed = e;
      }
      writeFileSync(join(dir, 'go'), '');
    },
    (e: unknown) => {
      failed = e;
    },
  );
  const rep = await p;
  await Promise.race([reached, new Promise((res) => setTimeout(res, 100))]);
  if (!existsSync(join(dir, 'ready'))) throw new Error(`the hook never reached ${at}: ${JSON.stringify(rep)}`);
  if (failed !== null) throw failed;
  return rep;
}

function sha(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** A view command as the engine starts it (descriptors passed on, then released). */
function runInView(view: LandingView, script: string, env: Record<string, string>, cwd: string): ReturnType<typeof spawnSync> {
  const spec = view.spawnSpec(['/bin/sh', '-c', script], { ...view.gitEnvironment(), ...env }, cwd);
  try {
    return spawnSync(spec.file, [...spec.args], { env: spec.env, stdio: ['pipe', 'pipe', 'pipe', ...(spec.fds ?? [])] });
  } finally {
    spec.release?.();
  }
}

// ---------------------------------------------------------------- review r1 #1: nothing git reads by name can be swapped

test('review r1 #1: a config renamed and recreated from outside during a command is never read (control: the single-file overlay is detached)', async () => {
  const r = await makeRepo({ '.gitattributes': 'f filter=evil\n', f: 'x\n' });
  const mark = join(fx.root, `evil-${n++}`);
  const evil = join(fx.root, `evil-config-${n++}`);
  writeFileSync(evil, readFileSync(join(r.common, 'config')));
  fx.raw(['config', '--file', evil, 'filter.evil.clean', `sh -c 'echo EXECUTED >> ${mark}; cat'`], r.repo);
  const view = await LandingView.build({ git: fx.git, repo: r.layout, description: r.d, scratchDir: fx.root });
  const sync = mkdtempSync(join(fx.root, 'sync-'));
  // Inside: read the filter (none), wait until the config was swapped outside, then make git clean `f`.
  const script = `git config --get filter.evil.clean > ${sync}/before; : > ${sync}/ready; while [ ! -e ${sync}/go ]; do sleep 0.01; done; printf 'payload\\n' | git hash-object --path=f --stdin > ${sync}/oid`;
  const swap = async (): Promise<void> => {
    await waitFile(join(sync, 'ready'));
    renameSync(join(r.common, 'config'), join(r.common, 'config-renamed'));
    writeFileSync(join(r.common, 'config'), readFileSync(evil));
    writeFileSync(join(sync, 'go'), '');
  };
  const restore = (): void => {
    rmSync(join(r.common, 'config'));
    renameSync(join(r.common, 'config-renamed'), join(r.common, 'config'));
    for (const f of ['ready', 'go', 'before', 'oid']) rmSync(join(sync, f), { force: true });
  };
  try {
    // Control: the v34 namespace, a read-only bind of the view's config over the real path.
    const args = bwrapArgv({ bwrapPath: view.bwrapPath, mounts: view.pathOverlayMounts(), clearEnv: true, env: { ...view.gitEnvironment(), GIT_DIR: r.common }, cwd: r.repo });
    const control = new Promise<number | null>((resolve) => {
      const child = require_spawn(view.bwrapPath, [...args, '--', '/bin/sh', '-c', script]);
      child.on('exit', (code) => resolve(code));
    });
    await swap();
    assert.equal(await control, 0);
    assert.match(existsSync(mark) ? readFileSync(mark, 'utf8') : '', /EXECUTED/, 'control: the overlay was detached and git read the new config');
    rmSync(mark, { force: true });
    restore();

    // The view: the common dir's path is a tmpfs only this namespace has.
    const spec = view.spawnSpec(['/bin/sh', '-c', script], { ...view.gitEnvironment(), GIT_DIR: r.common }, r.repo);
    const inView = new Promise<number | null>((resolve) => {
      const child = require_spawn(spec.file, [...spec.args], spec.fds);
      child.on('exit', (code) => resolve(code));
    });
    spec.release?.();
    await swap();
    assert.equal(await inView, 0);
    assert.equal(readFileSync(join(sync, 'before'), 'utf8'), '', 'no evil filter before');
    assert.equal(existsSync(mark), false, 'the swapped config was never read');
    restore();
  } finally {
    view.dispose();
  }
});

/** spawn with extra descriptors (3, 4, ...), not waiting. */
function require_spawn(file: string, args: readonly string[], fds: readonly number[] = []): import('node:child_process').ChildProcess {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn } = process.getBuiltinModule('node:child_process') as typeof import('node:child_process');
  return spawn(file, [...args], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'ignore', 'ignore', ...fds] });
}

test('review r1 #1: a linked git dir\'s locator files stay the recorded copies when swapped outside; HEAD stays live', async () => {
  const r = await makeRepo();
  fx.raw(['switch', '-q', 'feature'], r.repo);
  const L = join(fx.root, `L-${n++}`);
  raw(['worktree', 'add', '-q', L, 'main'], r.repo);
  const admin = realpathOf(raw(['rev-parse', '--absolute-git-dir'], L));
  const recorded = readFileSync(join(admin, 'gitdir'), 'utf8');
  const topic = `topic-${n++}`;
  const view = await LandingView.build({ git: fx.git, repo: r.layout, description: r.d, scratchDir: fx.root });
  const sync = mkdtempSync(join(fx.root, 'sync-'));
  try {
    const script = `cat ${admin}/gitdir > ${sync}/gitdir1; GIT_DIR=${admin} GIT_COMMON_DIR=${r.common} git symbolic-ref HEAD > ${sync}/head1; : > ${sync}/ready; while [ ! -e ${sync}/go ]; do sleep 0.01; done; cat ${admin}/gitdir > ${sync}/gitdir2; GIT_DIR=${admin} GIT_COMMON_DIR=${r.common} git symbolic-ref HEAD > ${sync}/head2`;
    const spec = view.spawnSpec(['/bin/sh', '-c', script], { ...view.gitEnvironment(), GIT_DIR: r.common }, r.repo);
    const done = new Promise<number | null>((resolve) => require_spawn(spec.file, [...spec.args], spec.fds).on('exit', (c) => resolve(c)));
    spec.release?.();
    await waitFile(join(sync, 'ready'));
    renameSync(join(admin, 'gitdir'), join(admin, 'gitdir-old'));
    writeFileSync(join(admin, 'gitdir'), `${join(fx.root, 'elsewhere', '.git')}\n`);
    raw(['switch', '-q', '-c', topic], L);
    writeFileSync(join(sync, 'go'), '');
    assert.equal(await done, 0);
    assert.equal(readFileSync(join(sync, 'gitdir1'), 'utf8'), recorded);
    assert.equal(readFileSync(join(sync, 'gitdir2'), 'utf8'), recorded, 'the recorded gitdir, not the one written outside');
    assert.equal(readFileSync(join(sync, 'head1'), 'utf8').trim(), 'refs/heads/main');
    assert.equal(readFileSync(join(sync, 'head2'), 'utf8').trim(), `refs/heads/${topic}`, 'HEAD is live (a switch outside is seen)');
  } finally {
    view.dispose();
    if (existsSync(join(admin, 'gitdir-old'))) {
      rmSync(join(admin, 'gitdir'));
      renameSync(join(admin, 'gitdir-old'), join(admin, 'gitdir'));
    }
  }
});

function realpathOf(p: string): string {
  return spawnSync('realpath', [p]).stdout.toString().trim();
}

// ---------------------------------------------------------------- review r1 #3: a worktree directory that is missing

test('review r1 #3: the target held by a registered worktree whose directory is missing: refused before the push; a directory recreated there is never written', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  fx.raw(['switch', '-q', 'feature'], r.repo);
  const L = join(fx.root, `L-${n++}`);
  raw(['worktree', 'add', '-q', L, 'main'], r.repo);
  renameSync(L, `${L}-away`);
  const journal = new MemoryLandingJournal();
  const rep = refused(await land({ ...req, mainCheckout: L }, deps(journal)));
  assert.equal(`${rep.reason}/${rep.wi}`, 'worktree-root-missing/WI-06');
  assert.equal(rev(r.repo, 'main'), r.A);
  assert.deepEqual(journal.pushStageAttempts.size, 0, 'nothing entered the push stage');
  // The reviewer's attack: the directory reappears (recreated by someone) right after the view was built.
  const j2 = new MemoryLandingJournal();
  const rep2 = await land({ ...req, mainCheckout: L }, deps(j2, {
    onViewBuilt: () => {
      mkdirSync(L);
      writeFileSync(join(L, '.git'), `gitdir: ${join(r.common, 'worktrees', L.split('/').pop() as string)}\n`);
      writeFileSync(join(L, 'f.txt'), 'one\n');
    },
  }));
  assert.equal(refused(rep2).reason, 'worktree-root-missing', 'recorded missing: never landed into');
  assert.equal(readFileSync(join(L, 'f.txt'), 'utf8'), 'one\n', 'the recreated directory was not written');
  assert.equal(rev(r.repo, 'main'), r.A);
});

test('review r1 #3: a worktree directory missing when recorded that reappears before the push ends the attempt (class A, worktrees-changed)', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  const P = join(fx.root, `P-${n++}`);
  raw(['worktree', 'add', '-q', P, 'feature'], r.repo);
  renameSync(P, `${P}-away`);
  const journal = new MemoryLandingJournal();
  journal.onBeginPhase = (rec) => {
    if (rec.phase === 'record-pre-state') renameSync(`${P}-away`, P);
  };
  const rep = refused(await land(req, deps(journal)));
  assert.equal(`${rep.reason}/${rep.wi}`, 'worktrees-changed/WI-06');
  assert.match(rep.detail, /appeared or disappeared/);
  assert.equal(rev(r.repo, 'main'), r.A);
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'one\n');
});

// ---------------------------------------------------------------- review r1 #4, v47: the inputs of the materialization

test('review r1 #4: an untracked .gitattributes in the approved worktree does not change the landed bytes', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  writeFileSync(join(r.repo, '.gitattributes'), 'f.txt eol=crlf\n'); // untracked, never in any commit
  const rep = checked(await land(req, deps()));
  assert.equal(rep.outcome, 'landed');
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'latin1'), 'two\n', 'the delivery bytes (LF), not the worktree attribute (CRLF)');
  assert.equal(rep.admission?.ok, true);
});

test('v47: a .gitattributes written (and an attempt to stage it) between the hook\'s last check and its read-tree does not change the bytes written', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\nthree\n', 'g.txt': 'g\n' });
  const staged: { r: { code: number; stderr: string } | null } = { r: null };
  const rep = checked(
    await landAt(req, 'before-read-tree', () => {
      writeFileSync(join(r.repo, '.gitattributes'), 'f.txt text eol=crlf\n');
      staged.r = fx.rawStatus(['-c', 'core.hooksPath=/dev/null', 'add', '.gitattributes'], r.repo);
    }),
  );
  // Review r2 #1: the landing holds git's index lock while it works on its copy, so nothing can be staged meanwhile.
  assert.notEqual(staged.r?.code, 0);
  assert.match(staged.r?.stderr ?? '', /index\.lock/);
  assert.equal(rep.outcome, 'landed');
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'latin1'), 'two\nthree\n', 'materialized with the delivery\'s attributes (--attr-source)');
});

test('v47: sparse checkout or a skip-worktree entry in the approved worktree: not landed automatically (class A)', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  raw(['update-index', '--skip-worktree', 'g.txt'], r.repo);
  let rep = refused(await land(req, deps()));
  assert.equal(`${rep.reason}/${rep.wi}`, 'sparse-checkout/WI-06');
  assert.match(rep.detail, /1 skip-worktree entry/);
  raw(['update-index', '--no-skip-worktree', 'g.txt'], r.repo);
  fx.raw(['config', 'core.sparseCheckout', 'true'], r.repo);
  rep = refused(await land(req, deps()));
  assert.equal(rep.reason, 'sparse-checkout');
  assert.match(rep.detail, /sparse checkout enabled/);
  assert.equal(rev(r.repo, 'main'), r.A);
});

test('v47: a skip-worktree bit set after the pre-push check: the hook refuses, nothing is written; the flags changed, so C', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  const rep = checked(await landAt(req, 'start', () => raw(['update-index', '--skip-worktree', 'g.txt'], r.repo)));
  assert.equal(rep.push !== 'unknown' && rep.push.kind === 'rejected' && rep.push.reason, 'checkout-hook-declined');
  assert.match(rep.push !== 'unknown' && rep.push.kind === 'rejected' ? rep.push.stderr : '', /skip-worktree entries/);
  assert.equal(rev(r.repo, 'main'), r.A);
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'one\n');
  // v46: the index flags are compared too, and with such an entry only "untouched" counts.
  assert.equal(rep.outcome, 'C');
  assert.match(rep.why, /index entries changed/);
});

// ---------------------------------------------------------------- v46: the program's push-to-checkout hook

test('v46: the hook refuses when HEAD is no longer the recorded base: nothing written; the target moved by someone else: base moved', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  const C = rawCommit(fx, r.repo, { 'f.txt': 'one\n', 'g.txt': 'someone else\n' }, r.A, 'C');
  const journal = new MemoryLandingJournal();
  const rep = checked(await landAt(req, 'start', () => fx.raw(['update-ref', 'refs/heads/main', C, r.A], r.repo), journal));
  assert.equal(rep.push !== 'unknown' && rep.push.kind === 'rejected' && rep.push.reason, 'checkout-hook-declined');
  assert.match(rep.push !== 'unknown' && rep.push.kind === 'rejected' ? rep.push.stderr : '', /is not the recorded base/);
  assert.equal(rev(r.repo, 'main'), C);
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'one\n');
  assert.equal(readFileSync(join(r.repo, 'g.txt'), 'utf8'), 'g\n', 'the hook wrote nothing');
  assert.deepEqual([rep.outcome, rep.next], ['base-moved', 'rebuild']);
});

test('v46: the branch advanced after the hook\'s read-tree and before the ref update: the worktree has the delivery, the branch does not: C', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  const C = rawCommit(fx, r.repo, { 'f.txt': 'one\n', 'g.txt': 'someone else\n' }, r.A, 'C');
  const journal = new MemoryLandingJournal();
  const rep = checked(await landAt(req, 'after-read-tree', () => fx.raw(['update-ref', 'refs/heads/main', C, r.A], r.repo), journal));
  assert.notEqual(rep.push !== 'unknown' && rep.push.kind, 'updated');
  assert.equal(rev(r.repo, 'main'), C);
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'two\n', 'written within the admitted change set');
  assert.equal(rep.outcome, 'C');
  assert.equal(rep.next, null, 'never redone automatically');
  assert.deepEqual(journal.notices.map((x) => x.wi).sort(), ['WI-04', 'WI-06']);
});

test('v46: only the change set is written: an unrelated file keeps its inode and mtime; the repository\'s own hooks never run', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  const mark = join(fx.root, `hooks-${n++}`);
  for (const h of ['push-to-checkout', 'post-checkout', 'post-index-change', 'reference-transaction', 'pre-receive', 'update', 'post-receive', 'post-update']) {
    writeExecutable(join(r.common, 'hooks', h), `#!/bin/sh\necho ${h} >> '${mark}'\n`);
  }
  const before = statSync(join(r.repo, 'g.txt'));
  const rep = checked(await land(req, deps()));
  assert.equal(rep.outcome, 'landed');
  const after = statSync(join(r.repo, 'g.txt'));
  assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs]);
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'two\n');
  assert.equal(existsSync(mark), false, existsSync(mark) ? readFileSync(mark, 'utf8') : '');
});

test('v47, v48: one command generator: the sender and the receiver for zero, main and linked occupancy', async () => {
  const r = await makeRepo();
  fx.raw(['switch', '-q', 'feature'], r.repo);
  const L = join(fx.root, `L-${n++}`);
  raw(['worktree', 'add', '-q', L, 'main'], r.repo);
  const admin = realpathOf(raw(['rev-parse', '--absolute-git-dir'], L));
  const view = await LandingView.build({ git: fx.git, repo: r.layout, description: r.d, scratchDir: fx.root });
  try {
    assert.throws(() => view.pushPlan({ kind: 'main' }, { deliveryRef: 'refs/x', targetRef: 'refs/heads/main', base: r.A }), /installCheckoutHook first/);
    view.installCheckoutHook({ base: r.A, delivery: r.A, approvedGitDir: r.common, lfsObjects: [] });
    assert.deepEqual(readdirSync(view.checkoutHooksDir as string), ['push-to-checkout'], 'the only file there');
    assert.equal(statSync(view.checkoutHooksDir as string).mode & 0o777, 0o555);
    const g = view.gitPath;
    const tail = `-c mission-pipeline.landing=${view.token} receive-pack`;
    const zero = view.pushPlan({ kind: 'zero' }, { deliveryRef: 'refs/x', targetRef: 'refs/heads/main', base: r.A });
    assert.equal(zero.receiver, `${g} -c core.fsmonitor=false -c receive.autogc=false -c submodule.recurse=false -c core.useReplaceRefs=false -c core.hooksPath=${view.noHooksDir} -c receive.denyCurrentBranch=refuse ${tail}`);
    assert.deepEqual(zero.senderArgs, ['-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', '-c', 'core.useReplaceRefs=false', 'push', '--porcelain', `--receive-pack=${zero.receiver}`, r.common, 'refs/x:refs/heads/main', `--force-with-lease=refs/heads/main:${r.A}`]);
    const main = view.pushPlan({ kind: 'main' }, { deliveryRef: 'refs/x', targetRef: 'refs/heads/main', base: r.A });
    assert.equal(main.receiver, `${g} -c core.fsmonitor=false -c receive.autogc=false -c submodule.recurse=false -c core.useReplaceRefs=false -c core.hooksPath=${view.checkoutHooksDir} -c receive.denyCurrentBranch=updateInstead ${tail}`);
    const linked = view.pushPlan({ kind: 'linked', gitDir: admin }, { deliveryRef: 'refs/x', targetRef: 'refs/heads/main', base: r.A });
    assert.equal(linked.receiver, `${g} -c core.fsmonitor=false -c receive.autogc=false -c submodule.recurse=false -c core.useReplaceRefs=false -c core.hooksPath=${view.checkoutHooksDir} -c receive.denyCurrentBranch=updateInstead -c core.bare=true ${tail}`);
    // The namespace from the same generator: which linked git dirs exist for each class.
    const listed = (v: LandingView): string => {
      const p = runInView(v, `ls ${r.common}/worktrees 2>/dev/null | wc -l`, { GIT_DIR: r.common }, r.repo);
      return p.stdout.toString().trim();
    };
    assert.deepEqual([listed(zero.view), listed(main.view), listed(linked.view)], ['1', '0', '1']);
  } finally {
    view.dispose();
  }
});

// ---------------------------------------------------------------- v46: submodules

test('v46: a gitlink change is not landed automatically; the PM gets the merge and `git submodule update` commands', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'one\n', 'g.txt': 'g\n', sub: { gitlink: r.A } });
  const rep = refused(await land(req, deps()));
  assert.equal(`${rep.reason}/${rep.wi}`, 'submodule-change/WI-06');
  assert.deepEqual(rep.paths, ['sub']);
  assert.match(rep.manualCommands.join('\n'), /merge --ff-only refs\/mission-pipeline\/delivered\/m1\/.*\n.*submodule update --init -- sub/);
  assert.equal(rev(r.repo, 'main'), r.A);
});

test('v46: an unchanged submodule is never entered: its git dir, config and worktree are byte-identical; the view has submodule.recurse=false and no submodule.* key', async () => {
  const s = initRepo(fx, `sub-src-${n++}`);
  const S1 = rawCommit(fx, s, { 's.txt': 'sub\n' }, null, 'S1');
  checkoutMain(fx, s, S1);
  const r = await makeRepo();
  fx.raw(['-c', 'protocol.file.allow=always', '-c', 'core.hooksPath=/dev/null', 'submodule', 'add', '-q', s, 'sub'], r.repo);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'with sub'], r.repo);
  const A2 = gitOid(rev(r.repo, 'HEAD'));
  fx.raw(['config', 'submodule.recurse', 'true'], r.repo); // tempts git to recurse
  const filesWithSub: Record<string, FileSpec> = { 'f.txt': 'two\n', 'g.txt': 'g\n', '.gitmodules': readFileSync(join(r.repo, '.gitmodules')), sub: { gitlink: S1 } };
  const req = await delivery({ ...r, A: A2 }, filesWithSub, A2);
  const digest = (dir: string): string => {
    const h = createHash('sha256');
    const walk = (rel: string): void => {
      for (const name of readdirSync(join(dir, rel)).sort()) {
        const p = rel === '' ? name : `${rel}/${name}`;
        const st = lstatSync(join(dir, p));
        if (st.isDirectory()) walk(p);
        else h.update(`${p}\0${st.mtimeMs}\0`).update(st.isSymbolicLink() ? readlinkSync(join(dir, p)) : readFileSync(join(dir, p)));
      }
    };
    walk('');
    return h.digest('hex');
  };
  const modBefore = digest(join(r.common, 'modules'));
  const subBefore = digest(join(r.repo, 'sub'));
  const rep = checked(await land(req, deps()));
  assert.equal(rep.outcome, 'landed', JSON.stringify(rep.why));
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'two\n');
  assert.equal(digest(join(r.common, 'modules')), modBefore, "the submodule's git dir and config are untouched");
  assert.equal(digest(join(r.repo, 'sub')), subBefore, "the submodule's worktree is untouched");
  const view = await LandingView.build({ git: fx.git, repo: r.layout, description: r.d, scratchDir: fx.root });
  try {
    const keys = view.configEntries.map(([k]) => k.toLowerCase()).filter((k) => k.startsWith('submodule.'));
    assert.deepEqual(keys, ['submodule.recurse']);
    assert.deepEqual(view.configEntries.find(([k]) => k === 'submodule.recurse'), ['submodule.recurse', 'false']);
  } finally {
    view.dispose();
  }
});

// ---------------------------------------------------------------- v44, v45: change set and the retry criterion

test('v44: mode-only and type changes are in the change set, and land', async () => {
  const r = await makeRepo({ 'f.txt': 'one\n', 'run.sh': '#!/bin/sh\n', 'link': 'plain\n' });
  const req = await delivery(r, { 'f.txt': 'one\n', 'run.sh': { exec: '#!/bin/sh\n' }, link: { link: 'f.txt' } });
  const ev = await AttributeEvaluator.create(fx.git, r.layout, r.d, fx.root);
  try {
    const cs = await computeMaterializedChangeSet({ git: fx.git, repo: r.layout, base: r.A, delivery: req.delivery, attributes: ev });
    const byPath = new Map(cs.entries.map((e) => [e.path, e] as const));
    assert.equal(byPath.get('run.sh')?.before?.mode, '100644');
    assert.equal(byPath.get('run.sh')?.after?.mode, '100755', 'a mode-only change (same bytes)');
    assert.equal(byPath.get('link')?.after?.kind, 'symlink', 'a type change');
  } finally {
    ev.dispose();
  }
  const rep = checked(await land(req, deps()));
  assert.equal(rep.outcome, 'landed');
  assert.equal(rep.verification.overall, 'expected', JSON.stringify(rep.verification.worktrees));
  assert.ok((statSync(join(r.repo, 'run.sh')).mode & 0o100) !== 0, 'executable now');
  assert.equal(readlinkSync(join(r.repo, 'link')), 'f.txt');
});

function approved(over: Partial<ApprovedState> = {}): ApprovedState {
  return {
    worktree: '/w',
    gitDir: '/w/.git',
    head: gitOid('a'.repeat(40)),
    branch: 'refs/heads/main',
    headTree: gitOid('1'.repeat(40)),
    index: ['H 100644 ' + 'b'.repeat(40) + ' 0\tf'],
    indexTree: gitOid('1'.repeat(40)),
    skipWorktree: 0,
    assumeUnchanged: 0,
    sparseCheckout: false,
    dirty: [],
    paths: [{ path: 'f', state: { kind: 'file', size: 2, sha256: 'x', executable: false } }],
    parents: [],
    unreadable: null,
    ...over,
  };
}

test('v45-v47: "safe to retry" is one of two whole states of the approved worktree; anything else, a mix included, is C', () => {
  const D = gitOid('d'.repeat(40));
  const pre = approved();
  assert.equal(safeToRetry(pre, approved(), D).state, 'untouched');
  // Someone merged another commit in the worktree; it is coherent with its new HEAD.
  const coherent = approved({ head: gitOid('c'.repeat(40)), headTree: gitOid('2'.repeat(40)), indexTree: gitOid('2'.repeat(40)), index: ['H 100644 ' + 'e'.repeat(40) + ' 0\tf'], paths: [{ path: 'f', state: { kind: 'file', size: 3, sha256: 'y', executable: false } }] });
  assert.equal(safeToRetry(pre, coherent, D).state, 'coherent');
  // A mix: the index moved on, but a tracked path differs from it.
  assert.equal(safeToRetry(pre, { ...coherent, dirty: ['f'] }, D).state, null);
  // HEAD is the delivery: written by this landing, never "coherent".
  assert.equal(safeToRetry(pre, { ...coherent, head: D }, D).state, null);
  // v46: with skip-worktree or assume-unchanged entries, or sparse checkout, only "untouched" counts.
  assert.equal(safeToRetry(approved({ assumeUnchanged: 1 }), { ...coherent, assumeUnchanged: 1 }, D).state, null);
  assert.equal(safeToRetry(approved({ assumeUnchanged: 1 }), approved({ assumeUnchanged: 1 }), D).state, 'untouched');
  // Flags are part of the index entries compared.
  assert.equal(safeToRetry(pre, approved({ index: ['h 100644 ' + 'b'.repeat(40) + ' 0\tf'], assumeUnchanged: 1 }), D).state, null);
  // An incomplete record is never safe.
  assert.equal(safeToRetry(approved({ unreadable: 'x' }), approved(), D).state, null);
  // The fixed order of 6.6 "落地的结果".
  const base = gitOid('a'.repeat(40));
  const input = { targetAfter: base, landed: false, base, delivery: D, binding: 'one' as const, approvedBefore: pre, approvedAfter: approved(), locks: [] as string[] };
  assert.deepEqual(classifyLandingOutcome({ ...input, landed: true, locks: ['/l'] }).outcome, 'landed', '1. landed wins over everything');
  assert.deepEqual(classifyLandingOutcome({ ...input, historyUnconfirmed: true }).outcome, 'C', 'v49: cannot confirm');
  assert.deepEqual(pick(classifyLandingOutcome({ ...input, locks: ['/l'] })), ['C', 'after-lock'], '2. a lock: C, then a new attempt once it is gone');
  assert.deepEqual(pick(classifyLandingOutcome({ ...input, locks: ['/l'], approvedAfter: { ...coherent, dirty: ['f'] } })), ['C', null], 'a lock and a changed worktree: C, no attempt');
  assert.deepEqual(pick(classifyLandingOutcome({ ...input, binding: 'zero', approvedBefore: null, approvedAfter: null })), ['B', 'new-attempt'], '3. zero: by the target ref');
  assert.deepEqual(pick(classifyLandingOutcome({ ...input, binding: 'zero', targetAfter: gitOid('9'.repeat(40)) })), ['base-moved', 'rebuild']);
  assert.deepEqual(pick(classifyLandingOutcome(input)), ['B', 'new-attempt'], '4. one: untouched');
  assert.deepEqual(pick(classifyLandingOutcome({ ...input, approvedAfter: { ...coherent, dirty: ['f'] } })), ['C', null], '5. else C');
});

function pick(r: { outcome: string; next: string | null }): [string, string | null] {
  return [r.outcome, r.next];
}

test('v44: the checks read the approved worktree through a copy of its index: the real index is never rewritten', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  // A stat-dirty but unchanged file: git's own refresh would rewrite the index to update its stat data.
  const t = new Date('2001-01-01');
  const { utimesSync } = await import('node:fs');
  utimesSync(join(r.repo, 'g.txt'), t, t);
  writeFileSync(join(r.repo, 'f.txt'), 'local edit\n'); // dirty: the hook refuses before touching anything
  const view = await LandingView.build({ git: fx.git, repo: r.layout, description: r.d, scratchDir: fx.root });
  const ev = await AttributeEvaluator.create(fx.git, r.layout, r.d, fx.root);
  try {
    const cs = await computeMaterializedChangeSet({ git: fx.git, repo: r.layout, base: r.A, delivery: req.delivery, attributes: ev });
    const { readApprovedState } = await import('../src/git/landingResult.ts');
    const before = sha(join(r.common, 'index'));
    const st = await readApprovedState({ git: fx.git, view, worktree: view.record.worktrees[0] as never, changeSet: cs, scratchDir: fx.root });
    assert.equal(st.unreadable, null);
    assert.deepEqual(st.dirty, ['f.txt'], 'judged on content: g.txt is only stat-dirty');
    assert.equal(sha(join(r.common, 'index')), before, 'the real index is byte-identical');
  } finally {
    view.dispose();
    ev.dispose();
  }
});

test('6.6 step 8: a delivery that has already landed is reported as landed (nothing pushed), never as "base moved"', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  assert.equal(checked(await land(req, deps())).outcome, 'landed');
  // Landing the same delivery again: the target contains it.
  const journal = new MemoryLandingJournal();
  const again = checked(await land(req, deps(journal)));
  assert.deepEqual([again.outcome, again.push !== 'unknown' && again.push.kind, again.next], ['landed', 'not-run', null]);
  assert.equal(journal.pushStageAttempts.size, 0, 'no landing attempt was counted');
  assert.deepEqual(journal.notices, []);
  // Someone built on top of it since: still landed (the delivery is an ancestor of the target), no rebuild.
  const C = rawCommit(fx, r.repo, { 'f.txt': 'two\n', 'g.txt': 'later\n' }, req.delivery, 'C');
  fx.raw(['update-ref', 'refs/heads/main', C], r.repo);
  const later = checked(await land(req, deps()));
  assert.equal(later.outcome, 'landed');
  assert.equal(later.verification.targetAfter, C);
  const { nextLandingStep } = await import('../src/git/landingRetry.ts');
  assert.deepEqual(nextLandingStep(later), { step: 'landed' });
  assert.equal(rev(r.repo, 'main'), C);
});

// ---------------------------------------------------------------- review r2 #1, #5

test('review r2 #1: an index replaced by a link to a file outside the admitted directories is never written through', async () => {
  const setup = async () => {
    const r = await makeRepo();
    const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
    const victim = join(fx.root, `victim-index-${n++}`);
    return { r, req, victim };
  };
  const swap = (r: R, victim: string): void => {
    const idx = join(r.common, 'index');
    writeFileSync(victim, readFileSync(idx));
    rmSync(idx);
    symlinkSync(victim, idx);
  };
  // Before the landing: the pre-landing record refuses to read through it (class A).
  {
    const { r, req, victim } = await setup();
    swap(r, victim);
    const before = sha(victim);
    const rep = refused(await land(req, deps()));
    assert.equal(`${rep.reason}/${rep.wi}`, 'worktree-unreadable/WI-06');
    assert.equal(sha(victim), before);
    assert.equal(rev(r.repo, 'main'), r.A);
  }
  // When the hook starts: its guard refuses to take a link; nothing written, the victim untouched.
  {
    const { r, req, victim } = await setup();
    let before = '';
    const rep = checked(await landAt(req, 'start', () => {
      swap(r, victim);
      before = sha(victim);
    }));
    assert.match(rep.push !== 'unknown' && rep.push.kind === 'rejected' ? rep.push.stderr : '', /index is not a regular file/);
    assert.equal(sha(victim), before);
    assert.equal(rev(r.repo, 'main'), r.A);
    assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'one\n');
    assert.equal(rep.outcome, 'C');
  }
  // After the guard took the index: git works on the private copy; the replaced index is never published over.
  {
    const { r, req, victim } = await setup();
    let before = '';
    const rep = checked(await landAt(req, 'before-read-tree', () => {
      swap(r, victim);
      before = sha(victim);
    }));
    assert.match(rep.push !== 'unknown' && rep.push.kind === 'rejected' ? rep.push.stderr : '', /the index was replaced during the landing/);
    assert.equal(sha(victim), before, 'the file outside was not written');
    assert.ok(lstatSync(join(r.common, 'index')).isSymbolicLink(), 'the link itself is left as it was');
    assert.equal(existsSync(join(r.common, 'index.lock')), false, 'the guard released its own lock');
    assert.equal(rev(r.repo, 'main'), r.A);
    assert.equal(rep.outcome, 'C');
  }
});

test('review r2 #5: a worktree whose HEAD advanced to the delivery is "files stale" only if every tracked file is the base: a modified file outside the change set means no command', async () => {
  const { compareWorktreeWithDelivery } = await import('../src/git/worktreeCompare.ts');
  const r = await makeRepo({ f: 'base\n', g: 'unchanged\n' });
  const req = await delivery(r, { f: 'delivery\n', g: 'unchanged\n' });
  fx.raw(['update-ref', 'refs/heads/main', req.delivery], r.repo);
  const ev = await AttributeEvaluator.create(fx.git, r.layout, r.d, fx.root);
  try {
    const cs = await computeMaterializedChangeSet({ git: fx.git, repo: r.layout, base: r.A, delivery: req.delivery, attributes: ev });
    const ctx = { git: fx.git, repo: r.layout, description: r.d, changeSet: cs, baseTree: cs.baseTree, attributes: ev };
    const loc = { gitDir: r.common, commonDir: r.common, workTree: r.repo };
    // Exactly the stale state: the predicate holds.
    let c = await compareWorktreeWithDelivery(ctx, fx.git, loc, r.repo);
    assert.equal(c.relation, 'branch-advanced-files-stale');
    // The reviewer's case: g (outside the change set) has the user's uncommitted change.
    writeFileSync(join(r.repo, 'g'), 'USER LOCAL MODIFICATION\n');
    c = await compareWorktreeWithDelivery(ctx, fx.git, loc, r.repo);
    assert.equal(c.relation, 'cannot-determine');
    assert.ok(c.differing.includes('g'), JSON.stringify(c));
    // Same size, same mtime: content, not stat data, decides (a racy write).
    writeFileSync(join(r.repo, 'g'), 'unchanged\n');
    c = await compareWorktreeWithDelivery(ctx, fx.git, loc, r.repo);
    assert.equal(c.relation, 'branch-advanced-files-stale');
    writeFileSync(join(r.repo, 'g'), 'UNCHANGED\n');
    c = await compareWorktreeWithDelivery(ctx, fx.git, loc, r.repo);
    assert.equal(c.relation, 'cannot-determine');
    writeFileSync(join(r.repo, 'g'), 'unchanged\n');
    // An assume-unchanged entry hides g's content: nothing whole is claimed.
    raw(['update-index', '--assume-unchanged', 'g'], r.repo);
    c = await compareWorktreeWithDelivery(ctx, fx.git, loc, r.repo);
    assert.equal(c.relation, 'cannot-determine');
    assert.match(c.detail, /assume-unchanged/);
  } finally {
    ev.dispose();
  }
});

// ---------------------------------------------------------------- v45: leftover locks

test('v45: a leftover index.lock in the approved worktree: C, never deleted, the owner is told; a new attempt only once it is gone', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  const lock = join(r.common, 'index.lock');
  const journal = new MemoryLandingJournal();
  const reports: LandingReport[] = [];
  let removed = false;
  const result = await landWhenReady(
    r.common,
    async (i) => {
      // A git command elsewhere took the index lock before the landing could (left behind by a crashed command, say).
      const rep = i === 1 ? await landAt(req, 'start', () => writeFileSync(lock, ''), journal) : await land(req, deps(journal));
      reports.push(rep);
      return rep;
    },
    {
      recheckMs: 120_000,
      minAttemptIntervalMs: 0,
      onWaiting: () => {
        assert.ok(existsSync(lock), 'the program never deletes the lock');
        if (!removed) {
          removed = true;
          setTimeout(() => unlinkSync(lock), 300); // its owner cleans it
        }
      },
    },
  );
  const first = checked(reports[0] as LandingReport);
  assert.deepEqual([first.outcome, first.next], ['C', 'after-lock']);
  assert.deepEqual(first.locks, [lock]);
  assert.deepEqual(landingLocks(r.common, 'refs/heads/main', r.common), []);
  const notice = journal.notices.find((x) => x.category === 'landing-leftover-lock');
  assert.ok(notice !== undefined && notice.wi === 'WI-06' && notice.trigger.includes(lock), JSON.stringify(journal.notices));
  assert.match(notice?.defaultAction ?? '', /never delete a git lock/);
  assert.equal(result.ended, 'landed', JSON.stringify(result.report));
  assert.equal(result.attempts, 2);
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'two\n');
});

// ---------------------------------------------------------------- review r1 #14: landed is landed

test('review r1 #14: landed with a worktree that is not as expected: the class is "landed", the worktree is reported (WI-04)', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  const W = join(fx.root, `W-${n++}`);
  raw(['worktree', 'add', '-q', W, 'feature'], r.repo);
  const journal = new MemoryLandingJournal();
  journal.onBeginPhase = (rec) => {
    // After the pre-push re-check: a forced second checkout of main (git's own guard bypassed).
    if (rec.phase === 'push') raw(['switch', '-q', '--ignore-other-worktrees', 'main'], W);
  };
  const rep = checked(await land(req, deps(journal)));
  assert.equal(rep.verification.landed, true);
  assert.equal(rep.outcome, 'landed', 'not C: the target contains the delivery');
  assert.equal(rep.verification.worktrees.find((x) => x.worktree === W)?.kind, 'branch-advanced-files-stale');
  assert.deepEqual(journal.notices.map((x) => x.wi), ['WI-04']);
});

// ---------------------------------------------------------------- v48: replace objects, read-only checks, attributes file

test('v48: a replace ref created after admission does not change the bytes written', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'delivered\n', 'g.txt': 'g\n' });
  const X = rev(r.repo, `${req.delivery}:f.txt`);
  const Y = fx.raw(['hash-object', '-w', '--stdin'], r.repo, { input: Buffer.alloc(100_000, 89) });
  const journal = new MemoryLandingJournal();
  journal.onBeginPhase = (rec) => {
    if (rec.phase === 'push') fx.raw(['replace', X, Y], r.repo);
  };
  const rep = checked(await land(req, deps(journal)));
  assert.equal(rep.outcome, 'landed');
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'delivered\n', 'the delivered blob, not its replacement');
  assert.equal(fx.raw(['cat-file', '-p', X], r.repo).length, 100_000, 'control: git honours the replace ref outside the landing');
});

test('v48: checks never write into the LFS store: a large uncommitted change to an LFS file outside the change set', async () => {
  const X = Buffer.from('lfs object\n');
  const r = await makeRepo({ '.gitattributes': '*.bin filter=lfs -text\n', 'f.txt': 'one\n', 'data.bin': encodeLfsPointer(lfsPointerFor(X)) });
  const store = join(r.common, 'lfs', 'objects');
  mkdirSync(join(lfsObjectPath(r.common, lfsPointerFor(X).oid), '..'), { recursive: true });
  writeFileSync(lfsObjectPath(r.common, lfsPointerFor(X).oid), X);
  // The repository's own LFS clean stores the content first, as git-lfs does: a check must never run it (v48, v50).
  const fake = join(fx.root, `writing-lfs-${n++}`);
  writeExecutable(fake, `#!/bin/sh\nif [ "$1" = clean ]; then t=$(mktemp ${store}/tmp.XXXXXX); cat > "$t"; echo clean >> ${store}/../ran; cat "$t"; else cat; fi\n`);
  fx.raw(['config', 'filter.lfs.clean', `${fake} clean -- %f`], r.repo);
  fx.raw(['config', 'filter.lfs.smudge', `${fake} smudge -- %f`], r.repo);
  writeFileSync(join(r.repo, 'data.bin'), Buffer.alloc(3_000_000, 5)); // the user's uncommitted work
  const count = (): number => {
    let k = 0;
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else k++;
      }
    };
    walk(store);
    return k;
  };
  const before = count();
  const req = await delivery(r, { '.gitattributes': '*.bin filter=lfs -text\n', 'f.txt': 'two\n', 'data.bin': encodeLfsPointer(lfsPointerFor(X)) });
  const rep = checked(await land(req, deps()));
  assert.equal(rep.push !== 'unknown' && rep.push.kind === 'rejected' && rep.push.reason, 'checkout-hook-declined', 'the hook saw the change (read-only comparison)');
  assert.equal(rep.outcome, 'B');
  assert.deepEqual(rep.approvedAfter?.dirty, ['data.bin']);
  assert.equal(count(), before, 'nothing was written into the LFS store');
  assert.equal(existsSync(join(store, '..', 'ran')), false, "git-lfs's clean never ran");
});

test('v48, v49: the read-only LFS comparator: empty -> empty, a valid pointer -> itself, an extension pointer -> error, content -> its pointer', () => {
  const dir = mkdtempSync(join(fx.root, 'cmp-'));
  const f = join(dir, 'cmp.mjs');
  writeFileSync(f, LFS_COMPARE_SCRIPT);
  const run = (input: Buffer) => spawnSync(process.execPath, [f], { input });
  const ptr = (b: Buffer): string => `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(b).digest('hex')}\nsize ${b.length}\n`;
  let p = run(Buffer.alloc(0));
  assert.deepEqual([p.status, p.stdout.length], [0, 0]);
  const pointer = Buffer.from(ptr(Buffer.from('x')));
  p = run(pointer);
  assert.ok(p.status === 0 && p.stdout.equals(pointer));
  p = run(Buffer.from(`version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${'a'.repeat(64)}\noid sha256:${'b'.repeat(64)}\nsize 3\n`));
  assert.equal(p.status, 3);
  assert.match(p.stderr.toString(), /extensions are not supported/);
  const big = Buffer.alloc(2_000_000, 1);
  p = run(big);
  assert.equal(p.status, 0);
  assert.equal(p.stdout.toString(), ptr(big));
});

test('v48: core.attributesFile is never the live path: the bound description\'s content as a read-only copy', async () => {
  const r = await makeRepo();
  const attrs = join(fx.home, `global-attrs-${n++}`);
  writeFileSync(attrs, '*.txt text\n');
  const user = { home: fx.home, gitConfigGlobal: join(fx.home, `.gitconfig-${n++}`) };
  writeFileSync(user.gitConfigGlobal, `[core]\n\tattributesFile = ${attrs}\n`);
  const d = await readTransformDescription(fx.git, r.layout, user);
  const view = await LandingView.build({ git: fx.git, repo: r.layout, description: d, scratchDir: fx.root });
  try {
    const af = view.configEntries.find(([k]) => k === 'core.attributesfile')?.[1] ?? '';
    assert.ok(af.startsWith(view.dir), `a copy inside the view: ${af}`);
    assert.notEqual(af, attrs);
    assert.match(readFileSync(af, 'utf8'), /\*\.txt text/);
    assert.equal(statSync(af).mode & 0o222, 0, 'read-only');
    writeFileSync(attrs, '*.txt -text\n'); // the live file changes: the view does not
    assert.match(readFileSync(af, 'utf8'), /\*\.txt text/);
  } finally {
    view.dispose();
  }
});

// ---------------------------------------------------------------- v49: raw history, no fetch, no network

test('v49: info/grafts cannot make the target look like it contains the delivery', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  writeFileSync(join(r.repo, 'f.txt'), 'local edit\n'); // the hook refuses: the target stays at A
  mkdirSync(join(r.common, 'info'), { recursive: true });
  writeFileSync(join(r.common, 'info', 'grafts'), `${r.A} ${req.delivery}\n`);
  assert.equal(fx.rawStatus(['-c', 'advice.graftFileDeprecated=false', 'merge-base', '--is-ancestor', req.delivery, r.A], r.repo).code, 0, 'control: grafts make B look contained in A');
  const rep = checked(await land(req, deps()));
  assert.equal(rev(r.repo, 'main'), r.A);
  assert.equal(rep.verification.landed, false, 'judged on the commit objects themselves');
  assert.equal(rep.outcome, 'B');
  assert.equal(await ancestry(fx.git.withLocators({ gitDir: r.common }), { ...r.layout, gitDir: r.common }, req.delivery, r.A), 'no');
});

test('v49: a shallow repository and a partial clone are not landed automatically (class A); a missing commit is "unknown"', async () => {
  const r0 = await makeRepo();
  const r = await makeRepo({ 'f.txt': 'one\n', 'g.txt': 'g\n' });
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  writeFileSync(join(r.common, 'shallow'), `${r.A}\n`);
  let rep = refused(await land(req, deps()));
  assert.equal(`${rep.reason}/${rep.wi}`, 'shallow-repository/WI-06');
  rmSync(join(r.common, 'shallow'));
  fx.raw(['config', 'remote.origin.url', r0.repo], r.repo);
  fx.raw(['config', 'remote.origin.promisor', 'true'], r.repo);
  rep = refused(await land(req, deps()));
  assert.equal(`${rep.reason}/${rep.wi}`, 'partial-clone/WI-06');
  assert.match(rep.detail, /remote\.origin\.promisor=true/);
  fx.raw(['config', '--unset', 'remote.origin.promisor'], r.repo);
  fx.raw(['config', 'core.repositoryformatversion', '1'], r.repo);
  fx.raw(['config', 'extensions.partialClone', 'origin'], r.repo);
  rep = refused(await land(req, deps()));
  assert.match(rep.detail, /extensions\.partialClone=origin/);
  assert.equal(rev(r.repo, 'main'), r.A);
  assert.equal(await ancestry(fx.git.withLocators({ gitDir: r0.common }), { ...r0.layout, gitDir: r0.common }, gitOid('e'.repeat(40)), r0.A), 'unknown');
});

test('v49: the landing namespace has no network', async () => {
  const r = await makeRepo();
  const server = createServer((s) => s.end('hello'));
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const port = (server.address() as { port: number }).port;
  const view = await LandingView.build({ git: fx.git, repo: r.layout, description: r.d, scratchDir: fx.root });
  try {
    const outside = readlinkSync('/proc/self/ns/net');
    const p = runInView(view, `readlink /proc/self/ns/net; (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo CONNECTED || echo REFUSED`, { GIT_DIR: r.common }, r.repo);
    const [ns, conn] = p.stdout.toString().trim().split('\n');
    assert.notEqual(ns, outside, 'its own network namespace');
    assert.equal(conn, 'REFUSED', "the host's loopback is not reachable");
  } finally {
    view.dispose();
    server.close();
  }
});

test('v49: an LFS object removed between admission and the hook: the hook refuses (nothing written); the next attempt is WI-13', async () => {
  const X = Buffer.from('lfs A\n');
  const Y = Buffer.from('lfs B, the delivered one\n');
  const r = await makeRepo({ '.gitattributes': '*.bin filter=lfs -text\n', 'f.txt': 'one\n', 'data.bin': encodeLfsPointer(lfsPointerFor(X)) });
  for (const c of [X, Y]) {
    mkdirSync(join(lfsObjectPath(r.common, lfsPointerFor(c).oid), '..'), { recursive: true });
    writeFileSync(lfsObjectPath(r.common, lfsPointerFor(c).oid), c);
  }
  const req = await delivery(r, { '.gitattributes': '*.bin filter=lfs -text\n', 'f.txt': 'two\n', 'data.bin': encodeLfsPointer(lfsPointerFor(Y)) });
  const journal = new MemoryLandingJournal();
  journal.onBeginPhase = (rec) => {
    if (rec.phase === 'push') unlinkSync(lfsObjectPath(r.common, lfsPointerFor(Y).oid));
  };
  const rep = checked(await land(req, deps(journal)));
  assert.match(rep.push !== 'unknown' && rep.push.kind === 'rejected' ? rep.push.stderr : '', /Git LFS object .* is not in the local store/);
  assert.equal(rev(r.repo, 'main'), r.A);
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'one\n');
  assert.equal(rep.outcome, 'B');
  const next = refused(await land(req, deps()));
  assert.equal(`${next.reason}/${next.wi}`, 'lfs-object-missing/WI-13');
});

// ---------------------------------------------------------------- v50: the program's own LFS smudge, extensions

test('v50: an LFS object corrupted after the hook\'s last check: the program\'s smudge refuses it, nothing is fetched, the result is C', async () => {
  const X = Buffer.from('lfs A\n');
  const Y = Buffer.alloc(200_000, 3);
  const r = await makeRepo({ '.gitattributes': '*.bin filter=lfs -text\n', 'f.txt': 'one\n', 'data.bin': encodeLfsPointer(lfsPointerFor(X)) });
  for (const c of [X, Y]) {
    mkdirSync(join(lfsObjectPath(r.common, lfsPointerFor(c).oid), '..'), { recursive: true });
    writeFileSync(lfsObjectPath(r.common, lfsPointerFor(c).oid), c);
  }
  const req = await delivery(r, { '.gitattributes': '*.bin filter=lfs -text\n', 'f.txt': 'two\n', 'data.bin': encodeLfsPointer(lfsPointerFor(Y)) });
  const storeBytes = (): number => {
    let total = 0;
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else total += statSync(join(d, e.name)).size;
      }
    };
    walk(join(r.common, 'lfs'));
    return total;
  };
  const before = storeBytes();
  // Same length, different bytes: the hook's presence check passes, the smudge's SHA-256 check does not.
  const rep = checked(await landAt(req, 'before-read-tree', () => writeFileSync(lfsObjectPath(r.common, lfsPointerFor(Y).oid), Buffer.alloc(200_000, 4))));
  assert.match(rep.push !== 'unknown' && rep.push.kind === 'rejected' ? rep.push.stderr : '', /does not match its pointer/);
  assert.equal(rev(r.repo, 'main'), r.A);
  assert.equal(storeBytes(), before, 'nothing was fetched or written into the LFS store');
  const landedBytes = existsSync(join(r.repo, 'data.bin')) ? readFileSync(join(r.repo, 'data.bin')) : null;
  assert.ok(landedBytes === null || !landedBytes.equals(Buffer.alloc(200_000, 4)), 'the corrupt bytes were never materialized');
  // read-tree stopped half way (git had already removed the old file): neither untouched nor coherent: C.
  assert.equal(rep.outcome, 'C');
});

test('v50: the view copies only extensions.objectFormat and extensions.worktreeConfig; reftable and unknown extensions are not landed (WI-13)', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  fx.raw(['config', 'core.repositoryformatversion', '1'], r.repo);
  fx.raw(['config', 'extensions.worktreeConfig', 'true'], r.repo);
  const view = await LandingView.build({ git: fx.git, repo: r.layout, description: r.d, scratchDir: fx.root });
  try {
    assert.deepEqual(view.configEntries.filter(([k]) => k.toLowerCase().startsWith('extensions.')).map(([k]) => k.toLowerCase()), ['extensions.worktreeconfig']);
  } finally {
    view.dispose();
  }
  fx.raw(['config', 'extensions.preciousObjects', 'true'], r.repo);
  let rep = refused(await land(req, deps()));
  assert.equal(`${rep.reason}/${rep.wi}`, 'unsupported-extension/WI-13');
  assert.match(rep.detail, /extensions\.preciousobjects=true/);
  fx.raw(['config', '--unset', 'extensions.preciousObjects'], r.repo);
  // reftable: the program creates no ref and never lands; the user converts the repository (v51).
  const t = join(fx.root, `reftable-${n++}`);
  fx.raw(['init', '-q', '--ref-format=reftable', '-b', 'main', t], fx.root);
  const T1 = rawCommit(fx, t, { 'f.txt': 'one\n' }, null, 'T1');
  checkoutMain(fx, t, T1);
  const T2 = rawCommit(fx, t, { 'f.txt': 'two\n' }, T1, 'T2');
  const tl = await discoverRepo(fx.git, t);
  const td = await readTransformDescription(fx.git, tl, fx.user);
  rep = refused(await land({ key: { mission: M, op: id<OpId>(`op${n++}`) }, repoPath: t, targetBranch: 'main', base: T1, delivery: T2, description: td, user: fx.user, ledger: NO_LEDGER }, deps()));
  assert.equal(`${rep.reason}/${rep.wi}`, 'reftable/WI-13');
  assert.match(rep.kind === 'not-auto-landed' ? REFUSAL_TEXT('reftable') : '', /git refs migrate --ref-format=files/);
  assert.equal(rev(t, 'main'), T1);
});

// ---------------------------------------------------------------- review r1 #10: recovery from the record alone

test('review r1 #10: recovery after the starting worktree was removed: verified from the persisted record, never from the request path', async () => {
  const r = await makeRepo();
  const req0 = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  const W0 = join(fx.root, `W0-${n++}`);
  raw(['worktree', 'add', '-q', W0, 'feature'], r.repo);
  mkdirSync(join(W0, 'sub'));
  const req: LandingRequest = { ...req0, repoPath: join(W0, 'sub'), mainCheckout: r.repo };
  const journal = new MemoryLandingJournal();
  journal.crashAfterPushProcess = true;
  await assert.rejects(() => land(req, deps(journal)), SimulatedCrash);
  for (let i = 0; i < 200 && rev(r.repo, 'main') !== req.delivery; i++) await new Promise((res) => setTimeout(res, 20));
  await new Promise((res) => setTimeout(res, 300));
  // The worktree the landing was started from disappears.
  fx.raw(['worktree', 'remove', '--force', W0], r.repo);
  assert.equal(existsSync(W0), false);
  const rec = await recoverLanding(req, deps(journal));
  assert.equal(rec.kind, 'checked', JSON.stringify(rec));
  if (rec.kind !== 'checked') return;
  const rep = checked(rec.report);
  assert.equal(rep.recovered, true);
  assert.equal(rep.verification.landed, true);
  assert.equal(rep.outcome, 'landed');
  assert.equal(rep.verification.worktrees.find((x) => x.worktree === W0)?.kind, 'cannot-determine');
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'two\n');
});

test('review r1 #10: a recovery whose repository is gone reports C (cannot determine) instead of throwing', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n', 'g.txt': 'g\n' });
  const journal = new MemoryLandingJournal();
  journal.crashAtPhase = { phase: 'push', when: 'after-record' };
  await assert.rejects(() => land(req, deps(journal)), SimulatedCrash);
  renameSync(r.repo, `${r.repo}-moved`);
  const rec = await recoverLanding(req, deps(journal));
  assert.equal(rec.kind, 'checked');
  if (rec.kind !== 'checked') return;
  const rep = checked(rec.report);
  assert.equal(rep.outcome, 'C');
  assert.equal(rep.verification.overall, 'cannot-determine');
  assert.ok(journal.notices.some((x) => x.wi === 'WI-06' && /class C/.test(x.trigger)));
  renameSync(`${r.repo}-moved`, r.repo);
});

// unused helpers kept for symmetry with the other landing tests
void chmodSync;
void sameTreeContent;
void readTreeContent;
void sha;
