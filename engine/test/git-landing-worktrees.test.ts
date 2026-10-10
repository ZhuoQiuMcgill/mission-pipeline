// 6.6 v35-v38: the worktree set is fixed inside the landing namespace. A worktree
// registered after the view was built does not exist there: the receiving side
// does not update it, checks do not walk it, its config.worktree is never read
// and nothing is written to it. Right after the push it is scanned from outside
// the namespace and classified against the delivery (v37, v38).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { id, type GitOid, type MissionId, type OpId } from '../src/common/ids.ts';
import { land, MemoryLandingJournal, recoverLanding, SimulatedCrash, type LandingRequest, type PhaseRecord } from '../src/git/landing.ts';
import { bwrapArgv, LandingView } from '../src/git/landingView.ts';
import { discoverRepo, type RepoLayout } from '../src/git/objects.ts';
import { createProgramRef, deliveryRef } from '../src/git/refs.ts';
import { readTransformDescription, type TransformDescription } from '../src/git/representation.ts';
import { checkoutMain, initRepo, makeFixture, rawCommit, writeExecutable, type FileSpec, type Fixture } from './git-fixtures.test.ts';

let fx: Fixture;
before(() => {
  fx = makeFixture('landing-wt');
});
after(() => fx.cleanup());

const M = id<MissionId>('m1');
const NO_LEDGER = { reserve: { recoveryReserveBytes: 0, evaluatorPoolBytes: 0 }, sharesVolume: () => false };
const BASE: Record<string, FileSpec> = { '.gitattributes': '*.wt filter=wt\n', 'f.txt': 'one\n', 'x.wt': 'wt content\n' };
let n = 0;

interface World {
  repo: string;
  layout: RepoLayout;
  A: GitOid;
  B: GitOid;
  d: TransformDescription;
  req: LandingRequest;
  mark: string;
}

/** A repository with per-worktree config enabled, main at A, a delivery B (f.txt changes; x.wt never does). */
async function world(bare = false): Promise<World> {
  const repo = bare ? join(fx.root, `bare${n++}.git`) : initRepo(fx, `w${n++}`);
  if (bare) fx.raw(['init', '-q', '--bare', '-b', 'main', repo], fx.root);
  if (!bare) {
    // Per-worktree config (with a shared core.bare=true, git would treat linked worktrees as bare: keep it off there).
    fx.raw(['config', 'core.repositoryformatversion', '1'], repo);
    fx.raw(['config', 'extensions.worktreeConfig', 'true'], repo);
  }
  const A = rawCommit(fx, repo, BASE, null, 'A');
  if (bare) fx.raw(['update-ref', 'refs/heads/main', A], repo);
  else checkoutMain(fx, repo, A);
  fx.raw(['branch', 'feature', A], repo);
  const B = rawCommit(fx, repo, { ...BASE, 'f.txt': 'two\n' }, A, 'B');
  const layout = await discoverRepo(fx.git, repo);
  const d = await readTransformDescription(fx.git, layout, fx.user);
  const op = id<OpId>(`op${n++}`);
  assert.equal((await createProgramRef(fx.git, layout, deliveryRef(M, op), B)).kind, 'created');
  return {
    repo,
    layout,
    A,
    B,
    d,
    mark: join(fx.root, `marker-${n++}`),
    req: { key: { mission: M, op }, repoPath: repo, targetBranch: 'main', base: A, delivery: B, description: d, user: fx.user, ledger: NO_LEDGER },
  };
}

/**
 * A worktree whose own config.worktree defines a content filter (and hooks) that
 * write to an absolute marker; x.wt is made stat-dirty, so any git command that
 * refreshes or updates this worktree would run the filter.
 */
function addMarkedWorktree(w: World, path: string, branchArgs: readonly string[]): void {
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', ...branchArgs.slice(0, -1), path, branchArgs[branchArgs.length - 1] as string], w.repo);
  const admin = fx.raw(['rev-parse', '--path-format=absolute', '--git-dir'], path);
  const cfg = join(admin, 'config.worktree');
  fx.raw(['config', '--file', cfg, 'filter.wt.clean', `sh -c 'echo wt-clean >> ${w.mark}; cat'`], w.repo);
  fx.raw(['config', '--file', cfg, 'filter.wt.smudge', `sh -c 'echo wt-smudge >> ${w.mark}; cat'`], w.repo);
  const hooks = join(fx.root, `wt-hooks-${n++}`);
  mkdirSync(hooks);
  for (const h of ['post-index-change', 'post-checkout', 'push-to-checkout']) writeExecutable(join(hooks, h), `#!/bin/sh\necho hook:${h} >> '${w.mark}'\n`);
  fx.raw(['config', '--file', cfg, 'core.hooksPath', hooks], w.repo);
  utimesSync(join(path, 'x.wt'), new Date('2000-01-01'), new Date('2000-01-01'));
}

function marks(w: World): string {
  return existsSync(w.mark) ? readFileSync(w.mark, 'utf8') : '';
}

function rev(repo: string, r: string): string {
  return fx.raw(['rev-parse', r], repo);
}

test('control: without the fixed set, a worktree registered after the view was built is updated through its own config.worktree', async () => {
  const w = await world();
  fx.raw(['switch', '-q', 'feature'], w.repo); // so the late worktree is the only one holding main
  const view = await LandingView.build({ git: fx.git, repo: w.layout, description: w.d, scratchDir: fx.root });
  try {
    const late = join(fx.root, `late-${n++}`);
    addMarkedWorktree(w, late, ['main']);
    // The v34 namespace: the same copies as path overlays, and .git/worktrees is the real one.
    const v34 = view.pathOverlayMounts().filter((m) => !m.dst.startsWith(join(w.layout.commonDir, 'worktrees') + '/'));
    // The v34 receiving side: git's own updateInstead, no binding and no program hook.
    const v34Receiver = `${view.gitPath} -c core.hooksPath=${view.noHooksDir} -c core.fsmonitor=false -c receive.denyCurrentBranch=updateInstead receive-pack`;
    const ref = deliveryRef(w.req.key.mission, w.req.key.op);
    const args = bwrapArgv({ bwrapPath: view.bwrapPath, mounts: v34, clearEnv: true, env: view.gitEnvironment(), cwd: w.repo });
    const p = spawnSync(view.bwrapPath, [
      ...args,
      '--',
      view.gitPath,
      '-c',
      `core.hooksPath=${view.noHooksDir}`,
      'push',
      '-q',
      `--receive-pack=${v34Receiver}`,
      '.',
      `${ref}:refs/heads/main`,
      `--force-with-lease=refs/heads/main:${w.A}`,
    ]);
    assert.equal(p.status, 0, p.stderr.toString());
    assert.equal(readFileSync(join(late, 'f.txt'), 'utf8'), 'two\n', 'the late worktree was updated');
    assert.match(marks(w), /wt-clean/, "its config.worktree filter ran: the hazard v35 closes");
  } finally {
    view.dispose();
  }
});

test('a worktree added between the last check and the push is never updated or read; the known worktrees, main included, land correctly', async () => {
  const w = await world();
  const w2 = join(fx.root, `known-${n++}`);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', w2, 'feature'], w.repo);
  const late = join(fx.root, `late-${n++}`);
  const journal = new MemoryLandingJournal();
  journal.onBeginPhase = (rec: PhaseRecord) => {
    if (rec.phase === 'push') addMarkedWorktree(w, late, ['-f', 'main']); // also holds main: forced
  };
  const rep = await land(w.req, { git: fx.git, journal, scratchDir: fx.root });
  assert.equal(rep.kind, 'checked', JSON.stringify(rep));
  if (rep.kind !== 'checked') return;
  // The known set: the main worktree (holding main) was updated, the linked one on feature left alone.
  assert.deepEqual(rep.verification.worktrees.map((v) => v.kind), ['expected', 'expected'], JSON.stringify(rep.verification));
  assert.equal(rev(w.repo, 'HEAD'), w.B);
  assert.equal(readFileSync(join(w.repo, 'f.txt'), 'utf8'), 'two\n');
  assert.equal(fx.raw(['status', '--porcelain'], w.repo), '');
  assert.equal(readFileSync(join(w2, 'f.txt'), 'utf8'), 'one\n');
  // The late worktree: never updated (its index and files are still A), never read (no filter, no hook).
  assert.equal(readFileSync(join(late, 'f.txt'), 'utf8'), 'one\n');
  assert.equal(fx.raw(['ls-files', '-s', 'f.txt'], late).split(' ')[1], rev(w.repo, `${w.A}:f.txt`));
  assert.equal(marks(w), '', 'nothing of the late worktree was executed, not even by the scan');
  // v37, v38: it shares the branch ref, so its HEAD is now B while its index and f.txt are A. Review r2 #5: the
  // worktree is judged as a whole: its x.wt is stat-dirty and uses a filter the program cannot reproduce, so its
  // content cannot be confirmed: "cannot determine", and no recovery command (its predicate is not proven).
  assert.equal(rep.verification.overall, 'cannot-determine');
  const late0 = rep.verification.newWorktrees[0];
  assert.deepEqual(rep.verification.newWorktrees.map((x) => [x.path, x.kind, x.branch, x.head]), [[late, 'cannot-determine', 'refs/heads/main', w.B]]);
  assert.ok(late0?.differing.includes('x.wt'), JSON.stringify(late0));
  assert.equal(late0?.recovery, null);
  assert.deepEqual(journal.notices.map((x) => x.wi), ['WI-04']);
});

test('a worktree added during verification is not walked by the checks; scanned from outside, consistent ones are not reported', async () => {
  const w = await world();
  const late = join(fx.root, `late-${n++}`);
  const journal = new MemoryLandingJournal();
  journal.onBeginPhase = (rec: PhaseRecord) => {
    if (rec.phase === 'verify') addMarkedWorktree(w, late, ['-b', 'side', 'main']);
  };
  const rep = await land(w.req, { git: fx.git, journal, scratchDir: fx.root });
  assert.equal(rep.kind, 'checked');
  if (rep.kind !== 'checked') return;
  assert.equal(rep.verification.worktrees.length, 1, 'only the fixed set was checked');
  assert.equal(rep.verification.worktrees[0]?.kind, 'expected');
  // Scanned from outside right after the push, without running any of its filters: its stat-dirty x.wt uses a
  // filter the program cannot reproduce, so it cannot be confirmed consistent (review r2 #5): reported, no command.
  assert.deepEqual(rep.verification.newWorktrees.map((x) => [x.path, x.kind, x.differing, x.recovery]), [[late, 'cannot-determine', ['x.wt'], null]]);
  assert.equal(marks(w), '');
});

test('a recorded worktree removed right before the push: the push does not run (v36), and the worktree is reported as cannot-determine', async () => {
  const w = await world();
  const gone = join(fx.root, `gone-${n++}`);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', gone, 'feature'], w.repo);
  const journal = new MemoryLandingJournal();
  journal.onBeginPhase = (rec: PhaseRecord) => {
    if (rec.phase === 'push') {
      fx.raw(['worktree', 'remove', '--force', gone], w.repo);
      rmSync(gone, { recursive: true, force: true });
    }
  };
  const rep = await land(w.req, { git: fx.git, journal, scratchDir: fx.root });
  assert.equal(rep.kind, 'checked');
  if (rep.kind !== 'checked') return;
  // Its git dir is not the recorded directory object any more: the push's identity check stops it.
  assert.equal(rep.push !== 'unknown' && rep.push.kind, 'not-run', JSON.stringify(rep.push));
  assert.equal(rep.verification.landed, false);
  assert.equal(rev(w.repo, 'main'), w.A);
  const v = rep.verification.worktrees.find((x) => x.worktree === gone);
  assert.equal(v?.kind, 'cannot-determine');
  assert.equal(rep.verification.overall, 'cannot-determine');
  assert.deepEqual(rep.verification.identityChanged.map((p) => p.problem), ['missing', 'missing']);
  // v44, v45: with one occupant only the approved worktree is judged (the receiver cannot write the others): it is
  // untouched and the target is at the base, so B; the removed worktree is reported on its own (WI-04).
  assert.deepEqual([rep.outcome, rep.next], ['B', 'new-attempt']);
  assert.deepEqual(journal.notices.map((x) => x.wi), ['WI-04', 'WI-06']);
  assert.equal(readFileSync(join(w.repo, 'f.txt'), 'utf8'), 'one\n');
});

test('a bare repository with linked worktrees: the one holding the target is updated, the others are left alone', async () => {
  const w = await world(true);
  const holder = join(fx.root, `holder-${n++}`);
  const other = join(fx.root, `other-${n++}`);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', holder, 'main'], w.repo);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '--detach', other, w.A], w.repo);
  // v41: the registered main checkout of a bare repository is one of its linked worktrees.
  const rep = await land({ ...w.req, mainCheckout: holder }, { git: fx.git, journal: new MemoryLandingJournal(), scratchDir: fx.root });
  assert.equal(rep.kind, 'checked', JSON.stringify(rep));
  if (rep.kind !== 'checked') return;
  assert.equal(rep.verification.overall, 'expected', JSON.stringify(rep.verification));
  assert.equal(rep.verification.landed, true);
  assert.equal(rev(holder, 'HEAD'), w.B);
  assert.equal(readFileSync(join(holder, 'f.txt'), 'utf8'), 'two\n');
  assert.equal(fx.raw(['status', '--porcelain'], holder), '');
  assert.equal(rev(other, 'HEAD'), w.A);
  assert.equal(readFileSync(join(other, 'f.txt'), 'utf8'), 'one\n');
});

// ---------------------------------------------------------------- v37, v38: the scan right after the push, and the re-check before the report

/** main at A in the main worktree; B changes f.txt and h.txt; a plain late worktree on main, added (forced) right before the push. */
async function scanWorld(): Promise<{ w: World; late: string; journal: MemoryLandingJournal }> {
  const repo = initRepo(fx, `scan${n++}`);
  const files: Record<string, FileSpec> = { 'f.txt': 'one\n', 'h.txt': 'h one\n', 'k.txt': 'keep\n' };
  const A = rawCommit(fx, repo, files, null, 'A');
  checkoutMain(fx, repo, A);
  const B = rawCommit(fx, repo, { ...files, 'f.txt': 'two\n', 'h.txt': 'h two\n' }, A, 'B');
  const layout = await discoverRepo(fx.git, repo);
  const d = await readTransformDescription(fx.git, layout, fx.user);
  const op = id<OpId>(`op${n++}`);
  assert.equal((await createProgramRef(fx.git, layout, deliveryRef(M, op), B)).kind, 'created');
  const w: World = {
    repo,
    layout,
    A,
    B,
    d,
    mark: join(fx.root, `marker-${n++}`),
    req: { key: { mission: M, op }, repoPath: repo, targetBranch: 'main', base: A, delivery: B, description: d, user: fx.user, ledger: NO_LEDGER },
  };
  const late = join(fx.root, `late-${n++}`);
  const journal = new MemoryLandingJournal();
  journal.onBeginPhase = (rec: PhaseRecord) => {
    if (rec.phase === 'push') fx.raw(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-f', late, 'main'], repo);
  };
  return { w, late, journal };
}

function then(journal: MemoryLandingJournal, phase: PhaseRecord['phase'], act: () => void): void {
  const before = journal.onBeginPhase;
  journal.onBeginPhase = async (rec: PhaseRecord) => {
    if (before !== null) await before(rec);
    if (rec.phase === phase) act();
  };
}

const quiet = (args: readonly string[], cwd: string): string => fx.raw(['-c', 'core.hooksPath=/dev/null', ...args], cwd);

test('v37: advanced, then `git switch -c topic` from the delivery commit with stale files: found and reported with the command, never missed', async () => {
  const { w, late, journal } = await scanWorld();
  then(journal, 'verify', () => quiet(['switch', '-q', '-c', 'topic'], late));
  const rep = await land(w.req, { git: fx.git, journal, scratchDir: fx.root });
  assert.equal(rep.kind, 'checked');
  if (rep.kind !== 'checked') return;
  assert.equal(rev(w.repo, 'main'), w.B);
  const r = rep.verification.newWorktrees.find((x) => x.path === late);
  assert.deepEqual([r?.kind, r?.firstScan, r?.branch, r?.head], ['branch-advanced-files-stale', 'branch-advanced-files-stale', 'refs/heads/topic', w.B]);
  assert.deepEqual(r?.differing, ['f.txt', 'h.txt']);
  assert.match(r?.recovery ?? '', new RegExp(`--attr-source=${w.B} -c core.sparseCheckout=false -c submodule.recurse=false -c core.useReplaceRefs=false read-tree -u -m ${w.A} ${w.B}.*refuses and changes nothing`));
  const p = spawnSync('sh', ['-c', (r?.recovery ?? '').split('  #')[0] as string], { env: fx.env });
  assert.equal(p.status, 0, p.stderr.toString());
  assert.equal(quiet(['status', '--porcelain'], late), '');
  assert.equal(readFileSync(join(late, 'h.txt'), 'utf8'), 'h two\n');
});

test('v37: index and files undo the delivery on part of the delivered paths only: suspected reverse change, no command', async () => {
  const { w, late, journal } = await scanWorld();
  then(journal, 'verify', () => {
    quiet(['switch', '-q', '-c', 'topic'], late);
    quiet(['checkout', w.B, '--', 'h.txt'], late); // h.txt brought along by hand, f.txt still A's
  });
  const rep = await land(w.req, { git: fx.git, journal, scratchDir: fx.root });
  if (rep.kind !== 'checked') return assert.fail(JSON.stringify(rep));
  const r = rep.verification.newWorktrees.find((x) => x.path === late);
  assert.deepEqual([r?.kind, r?.differing, r?.recovery], ['suspected-reverse-change', ['f.txt'], null]);
  assert.equal(rep.verification.overall, 'cannot-determine');
  assert.deepEqual(journal.notices.map((x) => x.wi), ['WI-04']);
});

test('v38: a state that changes between the scan and the report gets no command; other changes are "cannot determine" with the paths', async () => {
  const { w, late, journal } = await scanWorld();
  let pushed = false;
  then(journal, 'verify', () => {
    pushed = true;
  });
  const rep = await land(w.req, {
    git: fx.git,
    journal,
    scratchDir: fx.root,
    onViewBuilt: (view) => {
      // During the verification inside the namespace, i.e. after the scan and before the re-check.
      view.afterIdentityCheck = (argv) => {
        if (pushed && argv.includes('ls-files') && readFileSync(join(late, 'f.txt'), 'utf8') === 'one\n') writeFileSync(join(late, 'f.txt'), 'someone else\n');
      };
    },
  });
  if (rep.kind !== 'checked') return assert.fail(JSON.stringify(rep));
  const r = rep.verification.newWorktrees.find((x) => x.path === late);
  assert.deepEqual([r?.firstScan, r?.kind, r?.recovery], ['branch-advanced-files-stale', 'cannot-determine', null]);
  assert.ok(r?.differing.includes('f.txt'));
  assert.match(r?.detail ?? '', new RegExp(`HEAD ${w.B}.*delivery ${w.B}`));
});

test('recovery after a crash once the push started, with a recorded worktree removed meanwhile: the rest is still verified against the recorded set', async () => {
  const w = await world();
  const other = join(fx.root, `other-${n++}`);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', other, 'feature'], w.repo);
  const journal = new MemoryLandingJournal();
  journal.crashAfterPushProcess = true;
  await assert.rejects(() => land(w.req, { git: fx.git, journal, scratchDir: fx.root }), SimulatedCrash);
  // The engine is gone; the user removes the other worktree; then recovery runs.
  await new Promise((r) => setTimeout(r, 300));
  fx.raw(['worktree', 'remove', '--force', other], w.repo);
  const rec = await recoverLanding(w.req, { git: fx.git, journal, scratchDir: fx.root, exitWaitMs: 10_000 });
  assert.equal(rec.kind, 'checked', JSON.stringify(rec));
  if (rec.kind !== 'checked' || rec.report.kind !== 'checked') return;
  const v = rec.report.verification;
  assert.equal(v.landed, true);
  assert.deepEqual(
    v.worktrees.map((x) => [x.worktree, x.kind]),
    [
      [w.repo, 'expected'],
      [other, 'cannot-determine'],
    ],
  );
  assert.ok(v.identityChanged.some((p) => p.problem === 'missing'));
  assert.deepEqual(journal.notices.map((x) => x.wi), ['WI-04']);
});
