// Landing (design 6.6 step 7, option A) through the TypeScript API.
// Re-expresses probes-4.0/probe-git-landing.sh (cases 1-8) and
// probe-landing-config-view.sh (hazard, negative, hook-control and positive
// groups, with an absolute marker baked into the filter commands), then adds
// every configuration source, the representation round trip, the refusals,
// journaled phases and crash recovery.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { id, type MissionId, type OpId, type GitOid } from '../src/common/ids.ts';
import { GIB, type FsStats } from '../src/git/admission.ts';
import { computeMaterializedChangeSet } from '../src/git/changeSet.ts';
import {
  land,
  MemoryLandingJournal,
  recordPreLandingState,
  recoverLanding,
  SimulatedCrash,
  verifyLanding,
  type LandingDeps,
  type LandingReport,
  type LandingRequest,
} from '../src/git/landing.ts';
import { LandingView, renderConfig, type MountSpec } from '../src/git/landingView.ts';
import { discoverRepo, type RepoLayout } from '../src/git/objects.ts';
import { createProgramRef, deliveryRef } from '../src/git/refs.ts';
import { AttributeEvaluator, canonicalize, materializeSnapshot, readTransformDescription, type TransformDescription } from '../src/git/representation.ts';
import {
  checkoutMain,
  initRepo,
  makeFixture,
  rawCommit,
  readTreeContent,
  sameTreeContent,
  withProcessEnv,
  writeExecutable,
  type FileSpec,
  type Fixture,
} from './git-fixtures.test.ts';

let fx: Fixture;
before(() => {
  fx = makeFixture('landing');
});
after(() => fx.cleanup());

const NO_LEDGER = { reserve: { recoveryReserveBytes: 0, evaluatorPoolBytes: 0 }, sharesVolume: () => false };
const M = id<MissionId>('m1');
let opCounter = 0;
let repoCounter = 0;

interface LRepo {
  repo: string;
  layout: RepoLayout;
  A: GitOid;
  d: TransformDescription;
}

async function makeRepo(files: Record<string, FileSpec> = { 'f.txt': 'one\n' }, config: Record<string, string> = {}): Promise<LRepo> {
  const repo = initRepo(fx, `L${repoCounter++}`);
  for (const [k, v] of Object.entries(config)) fx.raw(['config', k, v], repo);
  const A = rawCommit(fx, repo, files, null, 'A');
  checkoutMain(fx, repo, A);
  fx.raw(['branch', 'feature', A], repo);
  const layout = await discoverRepo(fx.git, repo);
  const d = await readTransformDescription(fx.git, layout, fx.user);
  return { repo, layout, A, d };
}

/** A delivery commit on top of `base` and its program ref; returns the request. */
async function delivery(r: LRepo, files: Record<string, FileSpec>, base: GitOid = r.A, user = fx.user): Promise<LandingRequest> {
  const B = rawCommit(fx, r.repo, files, base, 'delivery');
  const op = id<OpId>(`op${opCounter++}`);
  const created = await createProgramRef(fx.git, r.layout, deliveryRef(M, op), B);
  assert.equal(created.kind, 'created');
  return { key: { mission: M, op }, repoPath: r.repo, targetBranch: 'main', base, delivery: B, description: r.d, user, ledger: NO_LEDGER };
}

function deps(journal = new MemoryLandingJournal(), extra: Partial<LandingDeps> = {}): LandingDeps {
  return { git: fx.git, journal, scratchDir: fx.root, ...extra };
}

function rev(repo: string, r: string): string {
  return fx.raw(['rev-parse', r], repo);
}

function checked(report: LandingReport): Extract<LandingReport, { kind: 'checked' }> {
  assert.equal(report.kind, 'checked', JSON.stringify(report));
  return report as Extract<LandingReport, { kind: 'checked' }>;
}

// ---------------------------------------------------------------- probe-git-landing.sh, cases 1-8

test('1. dirty checkout: the program\'s hook refuses, nothing moves, and the check says it is safe to retry (B)', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n' });
  writeFileSync(join(r.repo, 'f.txt'), 'local-edit\n');
  const journal = new MemoryLandingJournal();
  const rep = checked(await land(req, deps(journal)));
  assert.equal(rep.push !== 'unknown' && rep.push.kind, 'rejected');
  // v46: the worktree is updated only by the program's push-to-checkout hook, which refuses a dirty worktree.
  assert.equal(rep.push !== 'unknown' && rep.push.kind === 'rejected' && rep.push.reason, 'checkout-hook-declined');
  assert.match(rep.push !== 'unknown' && rep.push.kind === 'rejected' ? rep.push.stderr : '', /mission-pipeline: the worktree has unstaged changes/);
  assert.equal(rev(r.repo, 'main'), r.A);
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'local-edit\n');
  assert.equal(rep.verification.overall, 'expected');
  assert.equal(rep.verification.landed, false);
  // v45-v47: one occupancy, the approved worktree is "untouched" as a whole, the target is at the base: B.
  assert.deepEqual([rep.outcome, rep.next, rep.binding], ['B', 'new-attempt', 'one']);
  assert.match(rep.why, /every index entry .* as recorded/);
  assert.deepEqual(rep.approvedAfter?.dirty, ['f.txt'], 'the modification is seen on content');
  assert.deepEqual(journal.notices.map((x) => [x.wi, x.category]), [['WI-06', 'landing-not-completed']]);
  assert.match(journal.notices[0]?.trigger ?? '', /class B/);
  assert.match(journal.notices[0]?.defaultAction ?? '', /NEW landing attempt.*at most 4 attempts that enter the push stage/);
  assert.deepEqual([...journal.pushStageAttempts.values()].map((a) => a.length), [1], '6.5: the attempt was counted as it entered the push stage');
});

test('2. the user switched to another branch: only the named branch moves', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n' });
  fx.raw(['switch', '-q', 'feature'], r.repo);
  const rep = checked(await land(req, deps()));
  assert.equal(rep.push !== 'unknown' && rep.push.kind, 'updated');
  assert.equal(rev(r.repo, 'main'), req.delivery);
  assert.equal(rev(r.repo, 'feature'), r.A);
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'one\n');
  assert.equal(fx.raw(['status', '--porcelain'], r.repo), '');
  assert.equal(rep.verification.overall, 'expected');
  assert.equal(rep.verification.landed, true);
  // v42: zero occupancy is not an exception: a ref-only controlled landing; every worktree's HEAD, index and files unchanged.
  assert.deepEqual([rep.outcome, rep.binding], ['landed', 'zero']);
  assert.deepEqual(rep.admission?.filesystems.flatMap((f) => f.destinations), ['repository']);
});

test('3. stale lease: a second delivery still leasing the old base ends before the push (A); the delivery is rebuilt (WI-05)', async () => {
  const r = await makeRepo();
  fx.raw(['switch', '-q', 'feature'], r.repo);
  const first = await delivery(r, { 'f.txt': 'two\n' });
  assert.equal(checked(await land(first, deps())).verification.landed, true);
  const second = await delivery(r, { 'f.txt': 'three\n' });
  const journal = new MemoryLandingJournal();
  const rep = await land(second, deps(journal));
  assert.equal(rep.kind === 'not-auto-landed' && `${rep.reason}/${rep.wi}`, 'base-moved/WI-05', JSON.stringify(rep));
  assert.equal(rev(r.repo, 'main'), first.delivery);
  assert.deepEqual((await journal.load(second.key))?.phases.map((p) => p.phase), ['authorize', 'admit'], 'nothing past admission');
});

test('3b. the lease expires between the pre-push re-check and the push: refused, the worktree untouched: "base moved", the next step is a rebuild', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n' });
  const journal = new MemoryLandingJournal();
  const other = rawCommit(fx, r.repo, { 'f.txt': 'someone else\n' }, r.A, 'other');
  journal.onBeginPhase = (rec) => {
    // Someone else's merge lands right after the last look; the main checkout's files stay as they are (a ref move only).
    if (rec.phase === 'push') fx.raw(['update-ref', 'refs/heads/main', other, r.A], r.repo);
  };
  const rep = checked(await land(req, deps(journal)));
  assert.equal(rep.push !== 'unknown' && rep.push.kind === 'rejected' && rep.push.reason, 'stale-lease');
  assert.equal(rev(r.repo, 'main'), other);
  // v43-v45: moved by someone else to a commit without the delivery, the approved worktree untouched: "base moved",
  // a rebuild on the new base (WI-05), never reported as landed and never the same commit again.
  assert.deepEqual([rep.outcome, rep.next], ['base-moved', 'rebuild']);
  assert.equal(rep.verification.landed, false);
  // The main checkout's HEAD followed someone else's ref move while its files stayed at A: reported (WI-04), then the rebuild (WI-05).
  assert.deepEqual(journal.notices.map((x) => x.wi), ['WI-04', 'WI-05']);
});

test('4. clean checkout of the target: branch, index and files are updated together', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n' });
  const rep = checked(await land(req, deps()));
  assert.equal(rev(r.repo, 'HEAD'), req.delivery);
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'two\n');
  assert.equal(fx.raw(['status', '--porcelain'], r.repo), '');
  assert.equal(rep.verification.overall, 'expected');
  const v = rep.verification.worktrees.find((w) => w.worktree === r.layout.worktree);
  assert.equal(v?.kind, 'expected');
});

test('5. clean linked worktree holding the target: updated in place', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n' });
  fx.raw(['switch', '-q', 'feature'], r.repo);
  const w2 = join(fx.root, `w2-${repoCounter++}`);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', w2, 'main'], r.repo);
  // v41: only the registered main checkout is landed into; here that is the linked worktree.
  const external = await land(req, deps());
  assert.equal(external.kind === 'not-auto-landed' && `${external.reason}/${external.wi}`, 'target-in-external-worktree/WI-02', JSON.stringify(external));
  assert.equal(rev(r.repo, 'main'), r.A);
  // WI-02 option 2: the PM allows this one landing into it (the main checkout stays the registered one).
  const rep = checked(await land({ ...req, allowExternal: w2 }, deps()));
  assert.equal(rev(w2, 'HEAD'), req.delivery);
  assert.equal(readFileSync(join(w2, 'f.txt'), 'utf8'), 'two\n');
  assert.equal(fx.raw(['status', '--porcelain'], w2), '');
  assert.equal(rep.verification.overall, 'expected');
  assert.equal(rep.verification.worktrees.length, 2);
});

test('6. an untracked file where the delivery adds one: refused, the untracked file survives', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'one\n', 'new.txt': 'theirs\n' });
  writeFileSync(join(r.repo, 'new.txt'), 'mine\n');
  const rep = checked(await land(req, deps()));
  // The hook's read-tree -u -m refuses to overwrite the untracked file; nothing is written.
  assert.equal(rep.push !== 'unknown' && rep.push.kind === 'rejected' && rep.push.reason, 'checkout-hook-declined');
  assert.equal(rev(r.repo, 'main'), r.A);
  assert.equal(readFileSync(join(r.repo, 'new.txt'), 'utf8'), 'mine\n');
  assert.equal(rep.verification.overall, 'expected');
  assert.equal(rep.outcome, 'B');
});

test('7. a repository push-to-checkout hook: the hazard without protection, and the built-in update with the engine', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n' });
  const mark = join(fx.root, `hook-${repoCounter++}`);
  const hooks = join(r.repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeExecutable(join(hooks, 'push-to-checkout'), `#!/bin/sh\necho push-to-checkout >> '${mark}'\nexit 0\n`);
  // Hazard: a raw push without the hook override moves the branch but leaves files stale.
  const ref = deliveryRef(req.key.mission, req.key.op);
  fx.raw(['push', '-q', '--receive-pack=git -c receive.denyCurrentBranch=updateInstead receive-pack', '.', `${ref}:refs/heads/main`, `--force-with-lease=refs/heads/main:${r.A}`], r.repo);
  assert.equal(rev(r.repo, 'HEAD'), req.delivery);
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'one\n', 'hazard reproduced: files stale');
  assert.match(readFileSync(mark, 'utf8'), /push-to-checkout/);
  // Reset and land through the engine.
  checkoutMain(fx, r.repo, r.A);
  rmSync(mark);
  const rep = checked(await land(req, deps()));
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'two\n');
  assert.equal(fx.raw(['status', '--porcelain'], r.repo), '');
  assert.equal(existsSync(mark), false, 'the hook did not run');
  assert.equal(rep.verification.overall, 'expected');
});

test('8. the post-landing check passes a correct landing and flags the receive-side race end state', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n' });
  fx.raw(['switch', '-q', 'feature'], r.repo);
  const w2 = join(fx.root, `w2-${repoCounter++}`);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', w2, 'main'], r.repo);
  const scratch = mkdtempSync(join(fx.root, 'verify-'));
  const view = await LandingView.build({ git: fx.git, repo: r.layout, description: r.d, scratchDir: scratch });
  const ev = await AttributeEvaluator.create(fx.git, r.layout, r.d, scratch);
  try {
    const cs = await computeMaterializedChangeSet({ git: fx.git, repo: r.layout, base: r.A, delivery: req.delivery, attributes: ev });
    const pre = await recordPreLandingState(fx.git, r.layout, view, 'refs/heads/main', cs);
    // The race's end state: main moved to B, w2 left main between git's lookup and its update.
    fx.raw(['update-ref', 'refs/heads/main', req.delivery, r.A], r.repo);
    fx.raw(['switch', '-q', '-c', 'feature2', r.A], w2);
    fx.raw(['-c', 'core.hooksPath=/dev/null', 'read-tree', '-u', '-m', 'HEAD', req.delivery], w2);
    const v = await verifyLanding({ git: fx.git, repo: r.layout, view, description: r.d, pre, delivery: req.delivery, changeSet: cs });
    assert.equal(v.overall, 'race-signature');
    const w = v.worktrees.find((x) => x.worktree === w2);
    assert.equal(w?.kind, 'race-signature');
    assert.equal(w?.kind === 'race-signature' && w.branch, 'refs/heads/feature2');
    // The recovery command restores the worktree to its own HEAD.
    const cmd = w?.kind === 'race-signature' ? w.recovery.slice(w.recovery.indexOf('git -C')) : '';
    assert.equal(spawnSync('sh', ['-c', cmd], { env: fx.env }).status, 0);
    assert.equal(readFileSync(join(w2, 'f.txt'), 'utf8'), 'one\n');
    assert.equal(fx.raw(['status', '--porcelain'], w2), '');
    // A partial update (files and index at B, branch not moved) cannot be attributed: reported with its changes.
    fx.raw(['update-ref', 'refs/heads/main', r.A, req.delivery], r.repo);
    fx.raw(['switch', '-q', 'main'], w2);
    const pre2 = await recordPreLandingState(fx.git, r.layout, view, 'refs/heads/main', cs);
    fx.raw(['-c', 'core.hooksPath=/dev/null', 'read-tree', '-u', '-m', 'HEAD', req.delivery], w2);
    const v2 = await verifyLanding({ git: fx.git, repo: r.layout, view, description: r.d, pre: pre2, delivery: req.delivery, changeSet: cs });
    assert.equal(v2.overall, 'cannot-determine');
    const w2v = v2.worktrees.find((x) => x.worktree === w2);
    assert.ok(w2v?.kind === 'cannot-determine' && w2v.changes.some((c) => c.startsWith('index tree')), JSON.stringify(w2v));
  } finally {
    view.dispose();
    ev.dispose();
  }
});

// ---------------------------------------------------------------- probe-landing-config-view.sh

test('config view: hazard, negative and hook-control groups run the filter or hook; the positive view runs neither and still lands', async () => {
  const MARK = join(fx.root, `filter-ran-${repoCounter++}`);
  const r = await makeRepo();
  const SMUDGE = `sh -c 'echo smudge >> ${MARK}; cat'`;
  const CLEAN = `sh -c 'echo clean >> ${MARK}; cat'`;
  fx.raw(['config', 'filter.evil.smudge', SMUDGE], r.repo);
  fx.raw(['config', 'filter.evil.clean', CLEAN], r.repo);
  mkdirSync(join(r.repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(r.repo, '.git', 'info', 'attributes'), '*.dat filter=evil\n');
  writeExecutable(join(r.repo, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\necho hook >> '${MARK}'\n`);
  const evilHome = join(fx.root, `evil-home-${repoCounter++}`);
  mkdirSync(evilHome);
  fx.raw(['config', '--file', join(evilHome, '.gitconfig'), 'filter.evil.smudge', SMUDGE], r.repo);
  const injected = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'filter.evil.smudge', GIT_CONFIG_VALUE_0: SMUDGE, GIT_CONFIG_KEY_1: 'filter.evil.clean', GIT_CONFIG_VALUE_1: CLEAN };
  const d = await readTransformDescription(fx.git, r.layout, fx.user); // includes the info/attributes mapping
  const req = await delivery({ ...r, d }, { 'f.txt': 'two\n', 'g.dat': 'payload\n' });
  const ref = deliveryRef(req.key.mission, req.key.op);
  const RP = 'git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c receive.denyCurrentBranch=updateInstead receive-pack';
  const tmpIdx = join(fx.root, `probe-idx-${repoCounter++}`);
  // 6.6 v38, v39: every command names its repository; the push sends from and to the common dir's absolute path.
  const SEQ = `cd "$1" || exit 9
GIT_DIR="$6" git -c core.hooksPath=/dev/null push -q --receive-pack="$2" "$6" ${ref}:refs/heads/main --force-with-lease="refs/heads/main:$3" || exit 10
export GIT_DIR="$6" GIT_COMMON_DIR="$6" GIT_WORK_TREE="$1"
GIT_INDEX_FILE="$5" git read-tree "$4" || exit 16
touch -d "2000-01-01" g.dat || exit 12
git update-index -q --refresh; r=$?; [ $r -le 1 ] || exit 13
git diff-files --quiet; r=$?; [ $r -le 1 ] || exit 14
git status --porcelain >/dev/null || exit 15
[ "$(git rev-parse HEAD)" = "$4" ] || exit 11`;
  const common = r.layout.commonDir;
  const seqArgs = ['sh', '-c', SEQ, 'sh', r.repo, RP, r.A, req.delivery, tmpIdx, common];
  // A view command as the engine starts it: its descriptors passed on, then released.
  const spawnView = (spec: ReturnType<LandingView['spawnSpec']>, env: NodeJS.ProcessEnv) => {
    try {
      return spawnSync(spec.file, [...spec.args], { env, stdio: ['pipe', 'pipe', 'pipe', ...(spec.fds ?? [])] });
    } finally {
      spec.release?.();
    }
  };
  const viewEnv: Record<string, string> = { GIT_DIR: common };
  const reset = (): void => {
    fx.raw(['update-ref', 'refs/heads/main', r.A], r.repo);
    fx.raw(['-c', 'core.hooksPath=/dev/null', 'reset', '-q', '--hard', r.A], r.repo);
    rmSync(join(r.repo, 'g.dat'), { force: true });
    rmSync(tmpIdx, { force: true });
    rmSync(MARK, { force: true });
  };
  const marks = (): string => (existsSync(MARK) ? readFileSync(MARK, 'utf8') : '');
  const view = await LandingView.build({ git: fx.git, repo: r.layout, description: d, scratchDir: fx.root });
  view.installCheckoutHook({ base: r.A, delivery: req.delivery, approvedGitDir: r.layout.commonDir, lfsObjects: [] });
  try {
    // Hazard group: no view at all.
    reset();
    let p = spawnSync(seqArgs[0] as string, seqArgs.slice(1), { env: { ...fx.env, HOME: evilHome, ...injected } });
    assert.equal(p.status, 0, p.stderr.toString());
    assert.match(marks(), /smudge/);
    assert.match(marks(), /clean/);
    assert.match(marks(), /hook/);

    // Negative group: the view, but the environment inherited (injected definitions visible).
    reset();
    p = spawnView(view.spawnSpec(seqArgs, { ...view.gitEnvironment(), ...viewEnv }, r.repo, { clearEnv: false }), { ...fx.env, HOME: evilHome, ...injected });
    assert.equal(p.status, 0, p.stderr.toString());
    assert.match(marks(), /clean/, 'the injected clean ran in the check commands: the marker works');
    assert.doesNotMatch(marks(), /smudge/, 'observation: a local push resets the receiving side environment');

    // Hook control: cleared environment, but no core.hooksPath in the view and the real hooks directory visible.
    reset();
    const noGuardConfig = join(fx.root, `view-noguard-${repoCounter++}`);
    writeFileSync(noGuardConfig, renderConfig(view.configEntries.filter(([k]) => k !== 'core.hookspath')));
    const realHooks = join(view.realMountOf(common) ?? '', 'hooks');
    const noGuard = (mounts: MountSpec[]): MountSpec[] =>
      mounts
        .map((m): MountSpec => (m.dst === join(r.layout.commonDir, 'hooks') ? { kind: 'symlink', target: realHooks, dst: m.dst } : m))
        .map((m) => (m.kind === 'ro-bind' && m.dst === join(r.layout.commonDir, 'config') ? { ...m, src: noGuardConfig } : m));
    p = spawnView(view.spawnSpec(seqArgs, { ...view.gitEnvironment(), ...viewEnv }, r.repo, { editMounts: noGuard }), { ...fx.env, HOME: evilHome, ...injected });
    assert.equal(p.status, 0, p.stderr.toString());
    assert.match(marks(), /hook/, 'dropping core.hooksPath falls back to .git/hooks');
    assert.doesNotMatch(marks(), /smudge|clean/);

    // Positive group: exactly the production sandbox, same sequence.
    reset();
    const spec = view.wrap(seqArgs, { ...view.gitEnvironment(), ...viewEnv }, r.repo);
    p = spawnView(spec, { ...spec.env, HOME: evilHome, ...injected });
    assert.equal(p.status, 0, p.stderr.toString());
    assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'two\n');
    assert.equal(readFileSync(join(r.repo, 'g.dat'), 'utf8'), 'payload\n');
    assert.equal(marks(), '', 'no filter and no hook ran in push, temp-index build or checks');
    const wt = { gitDir: common, commonDir: common, workTree: r.repo };
    const attr = await fx.git.text(['check-attr', 'filter', 'g.dat'], { cwd: r.repo, sandbox: view, locators: wt });
    assert.equal(attr, 'g.dat: filter: evil', 'the mapping is in effect inside the view; only the definition is absent');

    // Positive group through the engine's own calls (SafeGit + view), same steps; the push is the generator's (v47).
    reset();
    const run = (args: string[], env: Record<string, string> = {}) => fx.git.run(args, { cwd: r.repo, sandbox: view, env, locators: wt });
    const plan = view.pushPlan({ kind: 'main' }, { deliveryRef: ref, targetRef: 'refs/heads/main', base: r.A });
    const push = await withProcessEnv({ HOME: evilHome, ...injected }, () =>
      fx.git.run(plan.senderArgs, {
        cwd: common,
        sandbox: plan.view,
        locators: { gitDir: common },
      }),
    );
    assert.equal(push.code, 0, push.stderr.toString());
    assert.equal((await run(['read-tree', req.delivery], { GIT_INDEX_FILE: tmpIdx })).code, 0);
    utimesSync(join(r.repo, 'g.dat'), new Date('2000-01-01'), new Date('2000-01-01'));
    assert.ok(((await run(['update-index', '-q', '--refresh'])).code ?? 9) <= 1);
    assert.ok(((await run(['diff-files', '--quiet'])).code ?? 9) <= 1);
    assert.equal((await run(['status', '--porcelain'])).code, 0);
    assert.equal(rev(r.repo, 'HEAD'), req.delivery);
    assert.equal(marks(), '');
    assert.equal(fx.raw(['config', '--file', join(r.repo, '.git', 'config'), 'filter.evil.clean'], r.repo), CLEAN, 'real config untouched');
  } finally {
    view.dispose();
  }
});

test('land(): no filter or hook from any configuration source runs (repository, worktree, global, system, environment, include)', async () => {
  const MARK = join(fx.root, `sources-${repoCounter++}`);
  const filt = (tag: string) => `sh -c 'echo ${tag} >> ${MARK}; cat'`;
  const sources = ['repo', 'wt', 'global', 'system', 'env', 'include'];
  const files: Record<string, FileSpec> = { 'f.txt': 'one\n' };
  for (const s of sources) files[`x.${s}`] = `${s} content\n`;
  const r = await makeRepo(files);
  const cfg = (k: string, v: string, file?: string) => fx.raw(file === undefined ? ['config', k, v] : ['config', '--file', file, k, v], r.repo);
  cfg('filter.frepo.clean', filt('repo'));
  cfg('filter.frepo.smudge', filt('repo'));
  cfg('core.repositoryformatversion', '1');
  cfg('extensions.worktreeConfig', 'true');
  cfg('filter.fwt.clean', filt('wt'), join(r.repo, '.git', 'config.worktree'));
  const incFile = join(fx.root, `evil-${repoCounter++}.inc`);
  cfg('filter.finclude.clean', filt('include'), incFile);
  cfg('include.path', incFile);
  const evilHome = join(fx.root, `evil-home-${repoCounter++}`);
  mkdirSync(evilHome);
  cfg('filter.fglobal.clean', filt('global'), join(evilHome, '.gitconfig'));
  const sysFile = join(fx.root, `system-${repoCounter++}.gitconfig`);
  cfg('filter.fsystem.clean', filt('system'), sysFile);
  const env = { HOME: evilHome, GIT_CONFIG_SYSTEM: sysFile, GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.fenv.clean', GIT_CONFIG_VALUE_0: filt('env') };
  writeFileSync(join(r.repo, '.git', 'info', 'attributes'), sources.map((s) => `*.${s} filter=f${s}`).join('\n') + '\n');
  for (const h of ['post-index-change', 'push-to-checkout', 'pre-receive', 'update', 'post-receive', 'post-update', 'reference-transaction', 'post-checkout']) {
    writeExecutable(join(r.repo, '.git', 'hooks', h), `#!/bin/sh\necho hook:${h} >> '${MARK}'\n${h === 'push-to-checkout' ? 'exit 0\n' : ''}`);
  }
  const old = (when: string) => {
    for (const s of sources) utimesSync(join(r.repo, `x.${s}`), new Date(when), new Date(when));
  };
  // Control: plain git, with that environment, runs every one of them.
  old('2000-01-01');
  fx.raw(['status', '--porcelain'], r.repo, { env });
  for (const s of sources) assert.match(readFileSync(MARK, 'utf8'), new RegExp(s), `control: ${s} filter is live`);
  assert.match(readFileSync(MARK, 'utf8'), /hook:post-index-change/);
  rmSync(MARK);
  old('2001-01-01'); // stat-dirty again, so the receive side would have to re-read them

  const user = { home: evilHome, gitConfigSystem: sysFile };
  const d = await readTransformDescription(fx.git, r.layout, user);
  const req = await delivery({ ...r, d }, { ...files, 'f.txt': 'two\n' }, r.A, user);
  const rep = await withProcessEnv(env, async () => checked(await land(req, deps())));
  assert.equal(rep.verification.overall, 'expected');
  assert.equal(rev(r.repo, 'main'), req.delivery);
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'two\n');
  assert.equal(existsSync(MARK), false, existsSync(MARK) ? readFileSync(MARK, 'utf8') : '');
});

// ---------------------------------------------------------------- representation through landing (7.1)

test('canonical candidate -> land -> the worktree is byte-identical (LF on eol=crlf, edited ident, symlink, deletion)', async () => {
  const r = await makeRepo({
    '.gitattributes': '*.txt eol=crlf\n*.id ident\n*.sh text eol=lf\n',
    'a.txt': 'one\ntwo\n',
    'x.id': '$Id$\nline1\n',
    'run.sh': { exec: '#!/bin/sh\necho hi\n' },
    'gone.txt': 'bye\n',
  });
  const ev = await AttributeEvaluator.create(fx.git, r.layout, r.d, fx.root);
  try {
    const snap = join(fx.root, `snap-${repoCounter++}`);
    const manifest = await materializeSnapshot({ git: fx.git, repo: r.layout, commit: r.A, attributes: ev, dest: snap });
    const oldId = rev(r.repo, `${r.A}:x.id`);
    writeFileSync(join(snap, 'new.txt'), 'n1\nn2\n');
    writeFileSync(join(snap, 'x.id'), `$Id: ${oldId} $\nline1\nline2\n`);
    mkdirSync(join(snap, 'dir', 'sub'), { recursive: true });
    writeFileSync(join(snap, 'dir', 'sub', 'deep.txt'), 'deep\n');
    symlinkSync('new.txt', join(snap, 'l2'));
    unlinkSync(join(snap, 'gone.txt'));
    const candidateDir = join(fx.root, `cand-${repoCounter++}`);
    const ident = { name: 'engine', email: 'engine@example.invalid' };
    const c = await canonicalize({ git: fx.git, repo: r.layout, base: manifest, snapshotDir: snap, attributes: ev, candidateDir, tempDir: fx.root, message: 'm\n', author: ident, committer: ident });
    assert.equal(c.kind, 'canonical');
    if (c.kind !== 'canonical') return;
    const op = id<OpId>(`op${opCounter++}`);
    assert.equal((await createProgramRef(fx.git, r.layout, deliveryRef(M, op), c.commit)).kind, 'created');
    const req: LandingRequest = { key: { mission: M, op }, repoPath: r.repo, targetBranch: 'main', base: r.A, delivery: c.commit, description: r.d, user: fx.user, ledger: NO_LEDGER };
    const rep = checked(await land(req, deps()));
    assert.equal(rep.verification.overall, 'expected');
    assert.equal(rep.verification.landed, true);
    assert.deepEqual(sameTreeContent(readTreeContent(r.repo), readTreeContent(candidateDir)), [], 'landed bytes equal the verified candidate');
    assert.equal(readFileSync(join(r.repo, 'new.txt'), 'latin1'), 'n1\r\nn2\r\n');
    assert.equal(fx.raw(['status', '--porcelain'], r.repo), '');
  } finally {
    ev.dispose();
  }
});

test('core.autocrlf changed after acceptance: not landed automatically, and the PM can say what changed', async () => {
  const r = await makeRepo({ '.gitattributes': '*.txt text\n', 'a.txt': 'a\n' });
  const req = await delivery(r, { '.gitattributes': '*.txt text\n', 'a.txt': 'a\nb\n' });
  fx.raw(['config', 'core.autocrlf', 'true'], r.repo);
  const rep = await land(req, deps());
  assert.equal(rep.kind, 'not-auto-landed');
  assert.equal(rep.kind === 'not-auto-landed' && `${rep.reason}/${rep.wi}`, 'transform-description-changed/WI-19');
  assert.match(rep.kind === 'not-auto-landed' ? rep.detail : '', /autocrlf: "false" -> "true"/);
  assert.equal(rev(r.repo, 'main'), r.A);
});

test('an attribute-only change is not landed automatically; the PM gets the re-materialization command', async () => {
  const r = await makeRepo({ '.gitattributes': '*.txt eol=lf\n', 'a.txt': 'a\nb\n', 'b.md': 'm\n' });
  const req = await delivery(r, { '.gitattributes': '*.txt eol=crlf\n', 'a.txt': 'a\nb\n', 'b.md': 'm\n' });
  const rep = await land(req, deps());
  assert.equal(rep.kind === 'not-auto-landed' && rep.reason, 'attribute-only-change');
  assert.deepEqual(rep.kind === 'not-auto-landed' ? rep.paths : null, ['a.txt']);
  assert.match(rep.kind === 'not-auto-landed' ? rep.manualCommands.join('\n') : '', /merge --ff-only refs\/mission-pipeline\/delivered\/m1\/.*\n.*checkout-index -f -- a\.txt/);
  assert.equal(rev(r.repo, 'main'), r.A);
});

test('a delivered path using a filter outside the whitelist blocks automatic landing', async () => {
  const r = await makeRepo({ '.gitattributes': '*.dat filter=evil\n', 'g.dat': 'x\n', 'f.txt': 'one\n' });
  const req = await delivery(r, { '.gitattributes': '*.dat filter=evil\n', 'g.dat': 'y\n', 'f.txt': 'one\n' });
  const rep = await land(req, deps());
  assert.equal(rep.kind === 'not-auto-landed' && rep.reason, 'unsupported-transform');
  assert.deepEqual(rep.kind === 'not-auto-landed' ? rep.paths : null, ['g.dat']);
  // An untouched path with that filter does not block a delivery that does not write it.
  const req2 = await delivery(r, { '.gitattributes': '*.dat filter=evil\n', 'g.dat': 'x\n', 'f.txt': 'two\n' });
  assert.equal(checked(await land(req2, deps())).verification.landed, true);
});

test('v50: Git LFS paths land through the program\'s own LFS filter (git-lfs never runs, nothing is fetched); bytes equal the candidate', async () => {
  const r = await makeRepo({ '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'f.txt': 'one\n' });
  // The repository's own configuration names a git-lfs that would leave a mark: the landing must never run it.
  const mark = join(fx.root, `git-lfs-ran-${repoCounter++}`);
  const fakeLfs = join(fx.root, `git-lfs-${repoCounter++}`);
  writeExecutable(fakeLfs, `#!/bin/sh\necho "$@" >> '${mark}'\ncat\n`);
  fx.raw(['config', 'filter.lfs.smudge', `${fakeLfs} smudge -- %f`], r.repo);
  fx.raw(['config', 'filter.lfs.clean', `${fakeLfs} clean -- %f`], r.repo);
  fx.raw(['config', 'filter.lfs.process', `${fakeLfs} filter-process`], r.repo);
  const ev = await AttributeEvaluator.create(fx.git, r.layout, r.d, fx.root);
  try {
    const snap = join(fx.root, `snap-${repoCounter++}`);
    const manifest = await materializeSnapshot({ git: fx.git, repo: r.layout, commit: r.A, attributes: ev, dest: snap });
    writeFileSync(join(snap, 'big.bin'), Buffer.alloc(50_000, 7));
    const candidateDir = join(fx.root, `cand-${repoCounter++}`);
    const ident = { name: 'engine', email: 'engine@example.invalid' };
    const c = await canonicalize({ git: fx.git, repo: r.layout, base: manifest, snapshotDir: snap, attributes: ev, candidateDir, tempDir: fx.root, message: 'm\n', author: ident, committer: ident });
    if (c.kind !== 'canonical') assert.fail(c.kind);
    const op = id<OpId>(`op${opCounter++}`);
    await createProgramRef(fx.git, r.layout, deliveryRef(M, op), c.commit);
    const req: LandingRequest = { key: { mission: M, op }, repoPath: r.repo, targetBranch: 'main', base: r.A, delivery: c.commit, description: r.d, user: fx.user, ledger: NO_LEDGER };
    const rep = checked(await land(req, deps()));
    assert.equal(rep.outcome, 'landed');
    assert.equal(rep.verification.overall, 'expected', JSON.stringify(rep.verification.worktrees));
    assert.ok(readFileSync(join(r.repo, 'big.bin')).equals(Buffer.alloc(50_000, 7)), 'smudged from the local store');
    assert.equal(existsSync(mark), false, existsSync(mark) ? readFileSync(mark, 'utf8') : 'git-lfs never ran');
  } finally {
    ev.dispose();
  }
});

test('admission sizes are the exact landed sizes: CRLF expansion and ident expansion are counted byte for byte', async () => {
  const r = await makeRepo({ '.gitattributes': '*.txt eol=crlf\n*.id ident\n', 'keep.md': 'k\n' });
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const req = await delivery(r, { '.gitattributes': '*.txt eol=crlf\n*.id ident\n', 'keep.md': 'k\n', 'big.txt': lines, 'v.id': '$Id$\n$Id$\nbody\n', 'deep/a/b/c.txt': 'x\ny\n' });
  const ev = await AttributeEvaluator.create(fx.git, r.layout, r.d, fx.root);
  try {
    const cs = await computeMaterializedChangeSet({ git: fx.git, repo: r.layout, base: r.A, delivery: req.delivery, attributes: ev });
    const sizes = new Map(cs.entries.map((e) => [e.path, e.after?.size]));
    assert.equal(sizes.get('big.txt'), Buffer.byteLength(lines) + 500, 'one CR per LF');
    // "$Id$" (4 bytes) becomes "$Id: <40 hex> $" (47 bytes): 43 more per keyword.
    assert.equal(sizes.get('v.id'), Buffer.byteLength('$Id$\n$Id$\nbody\n') + 2 * 43);
    checked(await land(req, deps()));
    for (const [p, size] of sizes) {
      if (size === null || size === undefined) continue;
      assert.equal(readFileSync(join(r.repo, p)).length, size, p);
    }
  } finally {
    ev.dispose();
  }
});

test('crash after the push, then the user resets main: recovery verifies and does not redo the push (14 item 7)', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n' });
  const journal = new MemoryLandingJournal();
  journal.crashAfterPushProcess = true;
  await assert.rejects(() => land(req, deps(journal)), SimulatedCrash);
  // Wait until the stray push has finished, then the user undoes it by hand.
  for (let i = 0; i < 100 && rev(r.repo, 'main') !== req.delivery; i++) await new Promise((res) => setTimeout(res, 20));
  await new Promise((res) => setTimeout(res, 200));
  checkoutMain(fx, r.repo, r.A);
  const rec = await recoverLanding(req, deps(journal));
  assert.equal(rec.kind, 'checked');
  if (rec.kind === 'checked') {
    const rep = checked(rec.report);
    assert.equal(rep.verification.landed, false);
  }
  assert.equal(rev(r.repo, 'main'), r.A, 'not pushed again');
  assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), 'one\n');
});

test('the view refuses to live inside the repository', async () => {
  const r = await makeRepo();
  await assert.rejects(
    () => LandingView.build({ git: fx.git, repo: r.layout, description: r.d, scratchDir: join(r.repo, '.git') }),
    /outside the repository/,
  );
});

test('LFS objects missing locally: not landed automatically; the program never downloads (7.1 v34)', async () => {
  const r = await makeRepo({ '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'f.txt': 'one\n' });
  const absent = Buffer.alloc(7000, 3);
  const { encodeLfsPointer, lfsPointerFor } = await import('../src/git/lfs.ts');
  const req = await delivery(r, { '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'f.txt': 'one\n', 'big.bin': encodeLfsPointer(lfsPointerFor(absent)) });
  const rep = await land(req, deps());
  assert.equal(rep.kind === 'not-auto-landed' && rep.reason, 'lfs-object-missing');
  assert.match(rep.kind === 'not-auto-landed' ? rep.detail : '', /git lfs fetch/);
  assert.equal(rev(r.repo, 'main'), r.A);
});

test('with the bound core.filemode true, verification compares the executable bit (7.1 v34)', async () => {
  const r = await makeRepo({ 'f.txt': 'one\n', 'run.sh': { exec: '#!/bin/sh\n' } });
  assert.equal(r.d.fileMode, true);
  const req = await delivery(r, { 'f.txt': 'one\n', 'run.sh': { exec: '#!/bin/sh\necho 2\n' }, 'tool.sh': { exec: '#!/bin/sh\n' } });
  const rep = checked(await land(req, deps()));
  assert.equal(rep.verification.overall, 'expected');
  // Reproduce a landing whose files are right but whose mode is not, and check it.
  checkoutMain(fx, r.repo, r.A);
  const scratch = mkdtempSync(join(fx.root, 'xbit-'));
  const view = await LandingView.build({ git: fx.git, repo: r.layout, description: r.d, scratchDir: scratch });
  const ev = await AttributeEvaluator.create(fx.git, r.layout, r.d, scratch);
  try {
    const cs = await computeMaterializedChangeSet({ git: fx.git, repo: r.layout, base: r.A, delivery: req.delivery, attributes: ev });
    const pre = await recordPreLandingState(fx.git, r.layout, view, 'refs/heads/main', cs);
    checkoutMain(fx, r.repo, req.delivery);
    chmodSync(join(r.repo, 'tool.sh'), 0o644);
    const v = await verifyLanding({ git: fx.git, repo: r.layout, view, description: r.d, pre, delivery: req.delivery, changeSet: cs });
    assert.equal(v.overall, 'cannot-determine');
    const w = v.worktrees.find((x) => x.worktree === r.layout.worktree);
    assert.ok(w?.kind === 'cannot-determine' && w.changes.some((c) => /tool\.sh: executable bit differs/.test(c)), JSON.stringify(w));
  } finally {
    view.dispose();
    ev.dispose();
  }
});

// ---------------------------------------------------------------- refusals before the push

test('refusals before any push: platform gate, authorization after a stop, admission, two worktrees on the target', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n' });
  const journal = new MemoryLandingJournal();
  let rep = await land(req, deps(journal, { platform: { supported: false, reason: 'macOS has no bubblewrap', wsl: false } }));
  assert.equal(rep.kind === 'not-auto-landed' && rep.reason, 'platform');
  assert.match(rep.kind === 'not-auto-landed' ? rep.manualCommands[0] ?? '' : '', /merge --ff-only refs\/mission-pipeline\/delivered\/m1\//);
  assert.deepEqual((await journal.load(req.key))?.phases, []);

  const stopped = new MemoryLandingJournal();
  stopped.authorization = { ok: false, reason: 'a stop covers this mission' };
  rep = await land(req, deps(stopped));
  assert.equal(rep.kind === 'not-auto-landed' && rep.reason, 'authorization-refused');
  assert.deepEqual((await stopped.load(req.key))?.phases.map((p) => p.phase), ['authorize']);

  const tiny: FsStats = { id: 'tiny', kind: 'ext4', blockSize: 4096, totalBytes: 10 * GIB, availableBytes: GIB + 4096, totalInodes: 1000, availableInodes: 1000 };
  const full = new MemoryLandingJournal();
  rep = await land(req, deps(full, { fsProbe: () => tiny }));
  assert.equal(rep.kind === 'not-auto-landed' && `${rep.reason}/${rep.wi}`, 'insufficient-space/WI-06');
  assert.deepEqual(full.notices.map((x) => x.wi), ['WI-06']);
  assert.equal(full.reminders.length, 1, 'WI-10: the space reminder goes with it');
  // Every refusal names its work instruction (3.11: a refusal without one is a defect).
  assert.equal(journal.notices[0]?.wi, 'WI-06');
  assert.equal(stopped.notices[0]?.wi, 'WI-06');

  fx.raw(['switch', '-q', 'feature'], r.repo);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', join(fx.root, `wa-${repoCounter++}`), 'main'], r.repo);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-f', join(fx.root, `wb-${repoCounter++}`), 'main'], r.repo);
  rep = await land(req, deps());
  assert.equal(rep.kind === 'not-auto-landed' && rep.reason, 'target-in-several-worktrees');
  assert.equal(rev(r.repo, 'main'), r.A);

  const wrongRef: LandingRequest = { ...req, delivery: r.A };
  rep = await land(wrongRef, deps());
  assert.equal(rep.kind === 'not-auto-landed' && `${rep.reason}/${rep.wi}`, 'delivery-ref-mismatch/WI-20');
});

test('admitted but close to the margin: the PM is reminded before the push, and the landing goes ahead (6.6 空间提醒)', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n' });
  // 10 GiB disk: margin 1 GiB; 1.5 GiB free stays above 1 GiB but below 2 x 1 GiB after landing.
  const close: FsStats = { id: 'close', kind: 'ext4', blockSize: 4096, totalBytes: 10 * GIB, availableBytes: 1.5 * GIB, totalInodes: 1000, availableInodes: 1000 };
  const journal = new MemoryLandingJournal();
  const rep = checked(await land(req, deps(journal, { fsProbe: () => close })));
  assert.equal(rep.verification.landed, true);
  assert.equal(journal.reminders.length, 1);
  assert.deepEqual(journal.reminders[0]?.phasesSoFar, ['authorize', 'admit'], 'reminded before the pre-state and the push');
  assert.deepEqual(rep.reminders, [journal.reminders[0]?.message]);
});

// ---------------------------------------------------------------- phases and recovery

test('phases are written in order before each starts; the pre-landing state travels with the push phase', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n' });
  const journal = new MemoryLandingJournal();
  checked(await land(req, deps(journal)));
  const st = await journal.load(req.key);
  assert.deepEqual(st?.phases.map((p) => p.phase), ['authorize', 'admit', 'record-pre-state', 'push', 'verify']);
  const push = st?.phases[3];
  assert.ok(push?.phase === 'push');
  if (push?.phase === 'push') {
    assert.equal(push.pre.targetBefore, r.A);
    assert.equal(push.pre.targetWorktree, r.layout.worktree);
    assert.deepEqual(push.pre.targetFiles.map((f) => f.path), ['f.txt']);
    assert.match(push.token, /^mp-landing-/);
  }
  assert.ok((st?.pushProcess?.pid ?? 0) > 0);
  assert.equal(st?.report?.kind, 'checked');
});

test('crash before the push phase: recovery finds nothing happened outside the ledger; landing again re-authorizes', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n' });
  const journal = new MemoryLandingJournal();
  journal.crashAtPhase = { phase: 'push', when: 'before-record' };
  await assert.rejects(() => land(req, deps(journal)), SimulatedCrash);
  const rec = await recoverLanding(req, deps(journal));
  assert.deepEqual(rec, { kind: 'not-started', lastPhase: 'record-pre-state' });
  assert.equal(rev(r.repo, 'main'), r.A);
  journal.crashAtPhase = null;
  const calls = journal.authorizeCalls.length;
  assert.equal(checked(await land(req, deps(journal))).verification.landed, true);
  assert.equal(journal.authorizeCalls.length, calls + 1);
});

test('crash once the push started: recovery waits for the old push, verifies every worktree, and never pushes again', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n' });
  fx.raw(['switch', '-q', 'feature'], r.repo);
  const w2 = join(fx.root, `w2-${repoCounter++}`);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', w2, 'main'], r.repo);
  const reflogBefore = fx.raw(['reflog', 'show', '--format=%H', 'refs/heads/main'], r.repo).split('\n').length;
  const journal = new MemoryLandingJournal();
  journal.crashAfterPushProcess = true;
  const req1 = { ...req, mainCheckout: w2 };
  await assert.rejects(() => land(req1, deps(journal)), SimulatedCrash);
  const rec = await recoverLanding(req1, deps(journal));
  assert.equal(rec.kind, 'checked');
  if (rec.kind !== 'checked') return;
  const rep = checked(rec.report);
  assert.equal(rep.recovered, true);
  assert.equal(rep.push, 'unknown');
  assert.equal(rep.verification.overall, 'expected');
  assert.equal(rep.verification.landed, true);
  assert.equal(readFileSync(join(w2, 'f.txt'), 'utf8'), 'two\n');
  const reflogAfter = fx.raw(['reflog', 'show', '--format=%H', 'refs/heads/main'], r.repo).split('\n').length;
  assert.equal(reflogAfter, reflogBefore + 1, 'exactly one push');
  assert.equal((await recoverLanding(req1, deps(journal))).kind, 'already-complete');

  // Crash right after the push phase was recorded, before any push process: verified, nothing landed, no push.
  const req2 = { ...(await delivery(r, { 'f.txt': 'three\n' }, req.delivery)), mainCheckout: w2 };
  const j2 = new MemoryLandingJournal();
  j2.crashAtPhase = { phase: 'push', when: 'after-record' };
  await assert.rejects(() => land(req2, deps(j2)), SimulatedCrash);
  const rec2 = await recoverLanding(req2, deps(j2));
  assert.equal(rec2.kind, 'checked');
  if (rec2.kind === 'checked') {
    const rep2 = checked(rec2.report);
    assert.equal(rep2.verification.landed, false);
    assert.equal(rep2.verification.overall, 'expected');
  }
  assert.equal(rev(r.repo, 'main'), req.delivery);
});

test('a push killed by its deadline is verified honestly against what actually happened', async () => {
  const r = await makeRepo();
  const req = await delivery(r, { 'f.txt': 'two\n' });
  const rep = await land(req, deps(undefined, { pushTimeoutMs: 1 }));
  if (rep.kind === 'push-unconfirmed') return; // the process outlived the grace period: recovery's job
  const c = checked(rep);
  const main = rev(r.repo, 'main');
  assert.equal(c.verification.landed, main === req.delivery);
  assert.equal(c.verification.targetAfter, main);
  if (c.verification.overall === 'expected') {
    assert.equal(readFileSync(join(r.repo, 'f.txt'), 'utf8'), main === req.delivery ? 'two\n' : 'one\n');
  }
});

test('a push killed while the receive side updates the worktree: verified first, partial updates and leftover locks reported (14 item 7)', async (t) => {
  const files: Record<string, FileSpec> = { 'f.txt': 'one\n' };
  const r = await makeRepo(files);
  const big: Record<string, FileSpec> = { 'f.txt': 'one\n' };
  for (let i = 0; i < 20_000; i++) big[`many/${String(i).padStart(5, '0')}.txt`] = `${i % 7}\n`;
  const req = await delivery(r, big);
  // A raw push of the same delivery into a scratch clone tells how long a full update takes here.
  const started = Date.now();
  const probe = join(fx.root, `probe-${repoCounter++}`);
  fx.raw(['clone', '-q', '--no-hardlinks', r.repo, probe], fx.root);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'read-tree', '-u', '-m', 'HEAD', req.delivery], probe);
  const full = Date.now() - started;
  const rep = await land(req, deps(undefined, { pushTimeoutMs: Math.max(50, Math.floor(full / 3)) }));
  if (rep.kind === 'push-unconfirmed') return; // still running after the grace period: recovery's job
  const c = checked(rep);
  const main = rev(r.repo, 'main');
  const present = existsSync(join(r.repo, 'many', '00000.txt')) || existsSync(join(r.repo, 'many', '19999.txt'));
  t.diagnostic(`full update ~${full} ms; main ${main === req.delivery ? 'moved' : 'unchanged'}; files ${present ? 'partly or fully written' : 'untouched'}; overall ${c.verification.overall}; locks ${c.verification.leftoverLocks.length}`);
  assert.equal(c.push, 'unknown', 'the push was killed by its deadline');
  assert.equal(c.verification.landed, main === req.delivery);
  if (main !== req.delivery && present) {
    // Files written but the branch not moved: never reported as expected.
    assert.equal(c.verification.overall, 'cannot-determine');
  }
  if (main !== req.delivery && !present) assert.equal(c.verification.overall, 'expected');
  for (const l of c.verification.leftoverLocks) assert.ok(existsSync(l), l);
});

test('the platform probe accepts this machine (Linux/WSL with bubblewrap)', async () => {
  const { detectLandingPlatform } = await import('../src/git/landing.ts');
  const p = await detectLandingPlatform();
  assert.equal(p.supported, true, p.reason ?? '');
});
