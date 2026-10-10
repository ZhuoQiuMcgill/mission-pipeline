// Delivery steps 1-6 end to end on real repositories (design 6.6; 6.1 ref rules; 6.5 rebuild limit).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { contentHash, id, type GitOid, type OpId } from '../src/common/ids.ts';
import { GIB, type FsStats } from '../src/git/admission.ts';
import { deliver, deliveryIntentToken, recoverDeliveryRef, resumeDeliveryRef, type DeliveryKey, type DeliveryRequest, type DeliveryIntent } from '../src/delivery/deliver.ts';
import { land, MemoryLandingJournal } from '../src/git/landing.ts';
import { discoverRepo, type RepoLayout } from '../src/git/objects.ts';
import { deliveryRef } from '../src/git/refs.ts';
import { readTransformDescription, transformDescriptionHash, type TransformDescription } from '../src/git/representation.ts';
import { findProcessesByToken, identifyProcess, isProcessAlive, killProcess } from '../src/git/safeGit.ts';
import { checkoutMain, initRepo, makeFixture, rawCommit, type FileSpec, type Fixture } from './git-fixtures.test.ts';
import { FakeProofView, MemoryAuthority, MISSION, StubChecks, obj, ov, productVersion } from './delivery-fixtures.test.ts';
import { NO_QUIET, TEST_DISK } from './delivery-fixtures.test.ts';

let fx: Fixture;
before(() => {
  fx = makeFixture('delivery');
});
after(() => fx.cleanup());

const ident = { name: 'Mission Pipeline', email: 'engine@example.invalid', date: '1700000300 +0000' };
const BASE: Record<string, FileSpec> = {
  'a/x.ts': 'export const x = 1;\n',
  'a/other.ts': 'other 1\n',
  'b/y.ts': 'y 1\n',
  'p/main.ts': 'main 1\n',
  'docs/readme.md': 'readme 1\n',
};

interface World {
  repo: string;
  layout: RepoLayout;
  M0: GitOid;
  d: TransformDescription;
  view: FakeProofView;
}

let n = 0;
async function world(extraInit: readonly string[] = []): Promise<World> {
  const repo = initRepo(fx, `d${n++}`, extraInit);
  const M0 = rawCommit(fx, repo, BASE, null, 'M0');
  checkoutMain(fx, repo, M0);
  const layout = await discoverRepo(fx.git, repo);
  const d = await readTransformDescription(fx.git, layout, fx.user);
  const dh = transformDescriptionHash(d);
  const CA1 = rawCommit(fx, repo, { ...BASE, 'a/x.ts': 'export const x = 2;\n' }, M0, 'A1');
  const CB1 = rawCommit(fx, repo, { ...BASE, 'b/y.ts': 'y 2\n' }, M0, 'B1');
  const CB2 = rawCommit(fx, repo, { ...BASE, 'b/y.ts': 'y 3\n' }, M0, 'B2');
  const CP1 = rawCommit(fx, repo, { ...BASE, 'p/main.ts': 'main 2\n' }, M0, 'P1');
  const CQ1 = rawCommit(fx, repo, { ...BASE, 'q/q.ts': 'q\n' }, M0, 'Q1');
  const view = new FakeProofView().add(
    await productVersion(fx.git, layout, { id: 'a1', module: 'a', writeScope: ['a/**'], commit: CA1, transform: dh }),
    await productVersion(fx.git, layout, { id: 'b1', module: 'b', writeScope: ['b/**'], commit: CB1, transform: dh }),
    await productVersion(fx.git, layout, { id: 'b2', module: 'b', writeScope: ['b/**'], commit: CB2, transform: dh }),
    await productVersion(fx.git, layout, { id: 'p1', module: 'p', writeScope: ['p/**'], commit: CP1, transform: dh, prerequisites: [obj('a1'), obj('b1')] }),
    await productVersion(fx.git, layout, { id: 'q1', module: 'q', writeScope: ['q/**'], commit: CQ1, transform: dh, prerequisites: [obj('b2')] }),
  );
  return { repo, layout, M0, d, view };
}

function request(w: World, op: string, selected = [obj('p1')]): DeliveryRequest {
  return {
    key: { mission: MISSION, op: id<OpId>(op) },
    repoPath: w.repo,
    targetBranch: 'main',
    selected,
    description: w.d,
    closingChecks: [
      { id: 'unit-tests', command: ['npm', 'test'] },
      { id: 'lint', command: ['npm', 'run', 'lint'] },
    ],
    author: ident,
    committer: ident,
  };
}

function rev(w: World, r: string): string {
  return fx.raw(['rev-parse', r], w.repo);
}

function refExists(w: World, key: DeliveryKey): boolean {
  return fx.rawStatus(['show-ref', '--verify', '--quiet', deliveryRef(key.mission, key.op)], w.repo).code === 0;
}

/** Waits for `path` to exist (a stop point of the ref writer). */
async function waitFor(path: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Kills the ref writer of `key` (found by the token on its command line) once it stopped at `point`. */
async function killWriterAt(key: DeliveryKey, pause: string, point: string): Promise<void> {
  await waitFor(`${pause}.paused-${point}`);
  for (const p of findProcessesByToken(`mission-pipeline.intent=${deliveryIntentToken(key)}`)) killProcess(p);
}

/** Advance main by a commit that only touches docs (a user working meanwhile). */
function advanceMain(w: World, tag: string): GitOid {
  const parent = rev(w, 'main');
  const c = rawCommit(fx, w.repo, { ...BASE, 'docs/readme.md': `readme ${tag}\n` }, parent, `user ${tag}`);
  fx.raw(['update-ref', 'refs/heads/main', c, parent], w.repo);
  return c;
}

test('delivers: manifest, candidate, proof check, closing checks, authorization, then the delivery ref; the PM can then land it', async () => {
  const w = await world();
  const req = request(w, 'op-ok');
  const authority = new MemoryAuthority();
  const checks = new StubChecks();
  let seenBytes = '';
  checks.onRun = () => {
    seenBytes = readFileSync(join(checks.calls[0]?.snapshotDir ?? '', 'p/main.ts'), 'utf8');
  };
  const r = await deliver(req, { git: fx.git, view: w.view, authority, checks, scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(r.kind, 'delivered', JSON.stringify(r));
  if (r.kind !== 'delivered') return;
  const ref = deliveryRef(req.key.mission, req.key.op);
  assert.equal(rev(w, ref), r.record.commit);
  assert.equal(r.record.base, w.M0);
  assert.equal(rev(w, `${r.record.commit}^`), w.M0);
  assert.equal(rev(w, 'main'), w.M0, 'the program never moves refs/heads/');
  assert.equal(seenBytes, 'main 2\n', 'the closing checks ran on the canonical candidate');
  assert.deepEqual(r.record.checks.map((c) => [c.id, c.passed]), [['unit-tests', true], ['lint', true]]);
  assert.deepEqual([...r.record.proof.proven].sort(), ['a1', 'b1', 'p1']);
  assert.deepEqual(
    authority.intents.map((i) => ({ ref: i.ref, commit: i.commit, base: i.base, token: i.token, record: i.record.commit, target: i.record.targetBranch })),
    [{ ref, commit: r.record.commit, base: w.M0, token: deliveryIntentToken(req.key), record: r.record.commit, target: 'main' }],
    'the authorization names the delivery it creates the ref for',
  );
  assert.ok(authority.writers.length >= 1 && authority.writers[0]?.pid !== undefined, 'the ref writer was recorded in the intent');
  assert.equal(authority.completed.length, 1);
  assert.equal(r.record.rebuilds, 0);
  // Step 7 takes it from here.
  const landed = await land(
    {
      key: req.key,
      repoPath: w.repo,
      targetBranch: 'main',
      base: r.record.base,
      delivery: r.record.commit,
      description: w.d,
      user: fx.user,
      ledger: { reserve: { recoveryReserveBytes: 0, evaluatorPoolBytes: 0 }, sharesVolume: () => false },
    },
    { git: fx.git, journal: new MemoryLandingJournal(), scratchDir: fx.root },
  );
  assert.equal(landed.kind === 'checked' && landed.verification.landed, true);
  assert.equal(readFileSync(join(w.repo, 'p/main.ts'), 'utf8'), 'main 2\n');
  assert.equal(readFileSync(join(w.repo, 'a/x.ts'), 'utf8'), 'export const x = 2;\n');
});

test('the target moved during verification: rebuilt on the new base and counted against the lineage limit (6.5)', async () => {
  const w = await world();
  const authority = new MemoryAuthority();
  const checks = new StubChecks();
  let moved: GitOid | null = null;
  checks.onRun = (call) => {
    if (call === 1) moved = advanceMain(w, 'moved');
  };
  const r = await deliver(request(w, 'op-moved'), { git: fx.git, view: w.view, authority, checks, scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(r.kind, 'delivered', JSON.stringify(r));
  if (r.kind !== 'delivered') return;
  assert.equal(checks.calls.length, 2, 'verified again on the new base');
  assert.equal(r.record.base, moved);
  assert.equal(rev(w, `${r.record.commit}^`), moved);
  assert.equal(fx.raw(['cat-file', 'blob', `${r.record.commit}:docs/readme.md`], w.repo), 'readme moved');
  assert.equal(r.record.rebuilds, 1);
  assert.equal(authority.rebuildCount, 1);
  assert.deepEqual(authority.signatures, [`base-moved:${moved}`]);
  assert.equal(authority.intents.length, 1, 'only the final candidate was authorized');
});

test('a target that keeps moving exhausts the rebuild limit of 3: no ref (6.5)', async () => {
  const w = await world();
  const authority = new MemoryAuthority(1);
  const checks = new StubChecks();
  checks.onRun = (call) => {
    advanceMain(w, `again-${call}`);
  };
  const req = request(w, 'op-limit', [obj('p1')]);
  const r = await deliver(req, { git: fx.git, view: w.view, authority, checks, scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.deepEqual(r, { kind: 'rebuild-limit-exhausted', rebuilds: 3 });
  assert.equal(checks.calls.length, 3);
  assert.equal(refExists(w, req.key), false);
  assert.equal(authority.intents.length, 0);
  // v42: at the cap the delivery is exhausted: WI-08, with every base it was rebuilt on; the quiet period never clears it.
  assert.deepEqual(authority.notices.map((x) => [x.wi, x.category]), [['WI-08', 'delivery-rebuild-exhausted']]);
  assert.equal((authority.notices[0]?.facts.bases as string[]).length, 4);
  assert.match(authority.notices[0]?.trigger ?? '', /kept moving \(not a task failure\)/);
  assert.match(authority.notices[0]?.defaultAction ?? '', /Secretary may grant one extra of up to 2/);
});

test('WI-05: the target keeps moving while the delivery waits: it rebuilds once, after the branch went quiet; that rebuild counts', async () => {
  const w = await world();
  const authority = new MemoryAuthority();
  const checks = new StubChecks();
  const tips: GitOid[] = [];
  const timers: NodeJS.Timeout[] = [];
  checks.onRun = (call) => {
    if (call !== 1) return;
    // Someone else merges three times in a row: once during the checks, twice while the delivery waits.
    tips.push(advanceMain(w, 'busy-1'));
    timers.push(setTimeout(() => tips.push(advanceMain(w, 'busy-2')), 150));
    timers.push(setTimeout(() => tips.push(advanceMain(w, 'busy-3')), 350));
  };
  const started = Date.now();
  const r = await deliver(request(w, 'op-quiet'), { git: fx.git, view: w.view, authority, checks, scratchDir: fx.root, disk: TEST_DISK, quiet: { quietMs: 700, pollMs: 40 } });
  for (const t of timers) clearTimeout(t);
  assert.equal(r.kind, 'delivered', JSON.stringify(r));
  if (r.kind !== 'delivered') return;
  assert.equal(tips.length, 3);
  assert.ok(Date.now() - started >= 350 + 700, 'it waited for a full quiet period after the last move');
  assert.equal(r.record.base, tips[2], 'rebuilt once, on the tip the branch settled on');
  assert.deepEqual(authority.signatures, [`base-moved:${tips[2]}`], 'one rebuild done, one counted: the waiting itself is not counted');
  assert.equal(r.record.rebuilds, 1);
  assert.equal(checks.calls.length, 2);
  assert.deepEqual(authority.notices, []);
});

test('WI-05: a target that is never quiet for long: the PM is told once after the notice delay, and the delivery keeps waiting', async () => {
  const w = await world();
  const authority = new MemoryAuthority();
  const checks = new StubChecks();
  let moving: NodeJS.Timeout | null = null;
  checks.onRun = (call) => {
    if (call !== 1) return;
    let k = 0;
    advanceMain(w, 'busy-0');
    moving = setInterval(() => {
      if (++k <= 6) advanceMain(w, `busy-${k}`);
      else if (moving !== null) clearInterval(moving);
    }, 100);
  };
  const r = await deliver(request(w, 'op-never-quiet'), {
    git: fx.git,
    view: w.view,
    authority,
    checks,
    scratchDir: fx.root, disk: TEST_DISK,
    quiet: { quietMs: 400, pollMs: 30, notifyAfterMs: 300 },
  });
  if (moving !== null) clearInterval(moving);
  assert.equal(r.kind, 'delivered', JSON.stringify(r));
  assert.deepEqual(authority.notices.map((x) => [x.wi, x.category]), [['WI-05', 'delivery-target-busy']], 'told once, after the delay');
  assert.match(authority.notices[0]?.defaultAction ?? '', /keeps waiting/);
  assert.equal(authority.signatures.length, 1, 'then one rebuild, counted');
});

test('moved after authorization: the stale intent is not executed; rebuilt, re-authorized, then delivered', async () => {
  const w = await world();
  class MovingAuthority extends MemoryAuthority {
    override async authorize(key: DeliveryKey, intent: DeliveryIntent) {
      const res = await super.authorize(key, intent);
      if (this.intents.length === 1) advanceMain(w, 'after-auth');
      return res;
    }
  }
  const authority = new MovingAuthority();
  const r = await deliver(request(w, 'op-after-auth'), { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(r.kind, 'delivered');
  if (r.kind !== 'delivered') return;
  assert.equal(authority.intents.length, 2);
  assert.deepEqual(authority.finished, ['failed'], 'the superseded intent was released before re-authorizing');
  assert.notEqual(authority.intents[0]?.commit, authority.intents[1]?.commit);
  assert.equal(r.record.commit, authority.intents[1]?.commit);
  assert.equal(rev(w, `${r.record.commit}^`), rev(w, 'main'));
});

test('failing closing checks, a refused authorization or an incompatible manifest: no delivery ref', async () => {
  const w = await world();
  const checks = new StubChecks();
  checks.failing.add('lint');
  const req1 = request(w, 'op-fail');
  const failed = await deliver(req1, { git: fx.git, view: w.view, authority: new MemoryAuthority(), checks, scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(failed.kind, 'checks-failed');
  if (failed.kind === 'checks-failed') assert.deepEqual(failed.outcomes.map((o) => [o.id, o.passed]), [['unit-tests', true], ['lint', false]]);
  assert.equal(refExists(w, req1.key), false);

  const stopped = new MemoryAuthority();
  stopped.authorization = { ok: false, reason: 'a stop covers this mission' };
  const req2 = request(w, 'op-stopped');
  const refused = await deliver(req2, { git: fx.git, view: w.view, authority: stopped, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.deepEqual(refused, { kind: 'authorization-refused', reason: 'a stop covers this mission' });
  assert.equal(refExists(w, req2.key), false);

  const req3 = request(w, 'op-incompatible', [obj('p1'), obj('q1')]); // p1 needs b1, q1 needs b2
  const incompatible = await deliver(req3, { git: fx.git, view: w.view, authority: new MemoryAuthority(), checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(incompatible.kind, 'incompatible');
  if (incompatible.kind === 'incompatible') assert.deepEqual(incompatible.conflicts.map((c) => c.kind), ['same-path', 'same-module']);
  assert.equal(refExists(w, req3.key), false);
});

test('a lock its own killed writer left is removed once that writer is gone; the retry is authorized anew and creates the ref (6.1 v34, review r2 #3)', async () => {
  const w = await world();
  const req = request(w, 'op-stale');
  const ref = deliveryRef(req.key.mission, req.key.op);
  const pause = join(fx.root, `pause-stale-${n++}`);
  const authority = new MemoryAuthority();
  // The first writer takes its lock (recorded as its own), then dies; the second one is let through.
  const killing = killWriterAt(req.key, pause, 'after-lock').then(() => writeFileSync(`${pause}.go-after-lock`, ''));
  const r = await deliver(req, { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET, testRefOptions: { testPause: { at: ['after-lock'], file: pause } } });
  await killing;
  assert.equal(r.kind, 'delivered', JSON.stringify(r));
  assert.equal(existsSync(join(w.layout.commonDir, `${ref}.lock`)), false);
  // review r1 #8: the failed attempt's intent was finished and the retry authorized anew (a stop in between would refuse it).
  assert.equal(authority.intents.length, 2);
  assert.deepEqual(authority.finished, ['failed']);
});

test('review r2 #3: a lock the program cannot prove is its own is never removed: the delivery waits (WI-14) with its authorization open, then resumes', async () => {
  const w = await world();
  const req = request(w, 'op-foreign-lock');
  const ref = deliveryRef(req.key.mission, req.key.op);
  mkdirSync(join(w.layout.commonDir, 'refs/mission-pipeline/delivered', MISSION), { recursive: true });
  const lock = join(w.layout.commonDir, `${ref}.lock`);
  writeFileSync(lock, ''); // someone else's: no record of the program's writer names it
  const authority = new MemoryAuthority();
  const r = await deliver(req, { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(r.kind, 'ref-lock-held', JSON.stringify(r));
  assert.equal(existsSync(lock), true, 'never removed by the program');
  assert.deepEqual(authority.finished, [], 'the authorization stays open');
  assert.deepEqual(authority.notices.map((x) => [x.wi, x.category]), [['WI-14', 'delivery-ref-lock-held']]);
  if (r.kind !== 'ref-lock-held') return;
  assert.equal((await resumeDeliveryRef(fx.git, req.key, r.pending, authority)).kind, 'ref-lock-held', 'still held: still waiting');
  rmSync(lock); // its owner removes it
  const resumed = await resumeDeliveryRef(fx.git, req.key, r.pending, authority);
  assert.equal(resumed.kind, 'ref-not-created', 'absent: the intent ends, a new delivery re-authorizes');
  assert.deepEqual(authority.finished, ['failed']);
  assert.equal((await deliver(req, { git: fx.git, view: w.view, authority: new MemoryAuthority(), checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET })).kind, 'delivered');
});

test('review r1 #8: a stop committed after a failed ref attempt refuses the retry: no ref, no write without a fresh authorization', async () => {
  const w = await world();
  const req = request(w, 'op-stop-between');
  const pause = join(fx.root, `pause-stop-${n++}`);
  class StopAfterFailure extends MemoryAuthority {
    override async finish(key: DeliveryKey, outcome: 'failed'): Promise<void> {
      await super.finish(key, outcome);
      this.authorization = { ok: false, reason: 'STOPPED: a stop was committed meanwhile' };
    }
  }
  const authority = new StopAfterFailure();
  const killing = killWriterAt(req.key, pause, 'after-lock'); // the first write fails: its writer dies holding its lock
  const r = await deliver(req, { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET, testRefOptions: { testPause: { at: ['after-lock'], file: pause } } });
  await killing;
  assert.deepEqual(r, { kind: 'authorization-refused', reason: 'STOPPED: a stop was committed meanwhile' });
  assert.equal(authority.intents.length, 2, 'the retry asked for a new authorization');
  assert.equal(refExists(w, req.key), false, 'and wrote nothing once refused');
});

test('review r2 #2: the writer dies after linking into a directory moved into refs/heads: WI-20 with where the ref is, nothing redone or deleted', async () => {
  const w = await world();
  const req = request(w, 'op-escape');
  const pause = join(fx.root, `pause-escape-${n++}`);
  const authority = new MemoryAuthority();
  const moving = (async () => {
    await waitFor(`${pause}.paused-before-link`);
    renameSync(join(w.layout.commonDir, 'refs/mission-pipeline/delivered', MISSION), join(w.layout.commonDir, 'refs/heads', MISSION));
    mkdirSync(join(w.layout.commonDir, 'refs/mission-pipeline/delivered', MISSION));
    writeFileSync(`${pause}.go-before-link`, '');
    await killWriterAt(req.key, pause, 'after-link');
  })();
  // The namespace directory must exist before the writer starts, so the move takes the writer's own directory.
  mkdirSync(join(w.layout.commonDir, 'refs/mission-pipeline/delivered', MISSION), { recursive: true });
  const r = await deliver(req, { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET, testRefOptions: { testPause: { at: ['before-link', 'after-link'], file: pause } } });
  await moving;
  assert.equal(r.kind, 'ref-tampered', JSON.stringify(r));
  const notice = authority.notices.find((x) => x.wi === 'WI-20');
  assert.deepEqual(notice?.facts.escapedTo, [`refs/heads/${MISSION}/op-escape`]);
  assert.equal(fx.raw(['rev-parse', `refs/heads/${MISSION}/op-escape`], w.repo).length, 40, 'not deleted');
  assert.equal(refExists(w, req.key), false, 'not redone');
  assert.deepEqual(authority.finished, ['failed']);
  assert.equal(authority.completed.length, 0, 'the delivery stays to be verified');
});

test('review r2 #4: a filesystem without hard links gets no program ref: WI-13, nothing written', async () => {
  const w = await world();
  const req = request(w, 'op-no-links');
  const refsBefore = fx.raw(['for-each-ref', '--format=%(refname) %(objectname)'], w.repo);
  const authority = new MemoryAuthority();
  const r = await deliver(req, { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET, testRefOptions: { testFailLink: 'EPERM' } });
  assert.equal(r.kind, 'repository-unsupported', JSON.stringify(r));
  assert.deepEqual(authority.notices.map((x) => [x.wi, x.category]), [['WI-13', 'delivery-repository-unsupported']]);
  assert.equal(fx.raw(['for-each-ref', '--format=%(refname) %(objectname)'], w.repo), refsBefore, 'no ref');
  assert.deepEqual(authority.finished, ['failed']);
});

test('review r1 #2, #13: an unsafe program namespace is never written through: WI-20, no ref, no branch', async () => {
  const w = await world();
  const req = request(w, 'op-unsafe');
  mkdirSync(join(w.layout.commonDir, 'refs/mission-pipeline'), { recursive: true });
  symlinkSync('../heads', join(w.layout.commonDir, 'refs/mission-pipeline/delivered'));
  const authority = new MemoryAuthority();
  const r = await deliver(req, { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(r.kind, 'ref-tampered');
  assert.equal(r.kind === 'ref-tampered' ? r.state.kind : null, 'unsafe-namespace');
  assert.deepEqual(authority.notices.map((x) => [x.wi, x.category]), [['WI-20', 'program-namespace-mismatch']]);
  assert.deepEqual(authority.finished, ['failed']);
  assert.equal(fx.rawStatus(['for-each-ref', 'refs/heads/m1/'], w.repo).stdout, '', 'no branch under refs/heads/');
  assert.equal(authority.completed.length, 0);
});

test('review r1 #13: every refusal exit of a delivery tells the PM with its work instruction', async () => {
  const w = await world();
  // Unknown targets and unplaced products: WI-20.
  const a1 = new MemoryAuthority();
  assert.equal((await deliver(request(w, 'op-unknown', [obj('nope')]), { git: fx.git, view: w.view, authority: a1, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET })).kind, 'unknown-targets');
  assert.deepEqual(a1.notices.map((x) => [x.wi, x.category]), [['WI-20', 'delivery-unknown-targets']]);
  const unplaced = w.view.object(ov('a1'));
  if (unplaced === null) assert.fail('a1');
  w.view.add({ ...unplaced, id: ov('u1'), tree: null });
  const a2 = new MemoryAuthority();
  assert.equal((await deliver(request(w, 'op-unplaced', [obj('u1')]), { git: fx.git, view: w.view, authority: a2, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET })).kind, 'unplaced-products');
  assert.deepEqual(a2.notices.map((x) => [x.wi, x.category]), [['WI-20', 'delivery-unplaced-products']]);
  // A version verified under another transform description: WI-19.
  const p1 = w.view.object(ov('p1'));
  if (p1 === null || p1.tree === null) assert.fail('p1');
  w.view.add({ ...p1, id: ov('p9'), tree: { ...p1.tree, transform: contentHash('1'.repeat(64)) } });
  const a3 = new MemoryAuthority();
  assert.equal((await deliver(request(w, 'op-desc', [obj('p9')]), { git: fx.git, view: w.view, authority: a3, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET })).kind, 'description-mismatch');
  assert.deepEqual(a3.notices.map((x) => [x.wi, x.category]), [['WI-19', 'transform-description-changed']]);
  // Closing checks failed: WI-21 (v43), no ref, no automatic rebuild, the candidate commit named.
  const checks = new StubChecks();
  checks.failing.add('lint');
  const a4 = new MemoryAuthority();
  const req4 = request(w, 'op-checks');
  const failed = await deliver(req4, { git: fx.git, view: w.view, authority: a4, checks, scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(failed.kind, 'checks-failed');
  assert.deepEqual(a4.notices.map((x) => [x.wi, x.category]), [['WI-21', 'delivery-closing-checks-failed']]);
  assert.equal(a4.notices[0]?.facts.commit, failed.kind === 'checks-failed' ? failed.commit : null);
  assert.match(a4.notices[0]?.defaultAction ?? '', /no automatic rebuild/);
  assert.equal(refExists(w, req4.key), false);
  assert.equal(checks.calls.length, 1, 'not rebuilt');
});

test('review r1 #12: the candidate is admitted per destination before it is written: objects first, then the snapshot', async () => {
  const w = await world();
  const tiny = (path: string): FsStats => ({ id: `fs:${path.startsWith(w.layout.commonDir) ? 'repo' : 'scratch'}`, kind: 'ext4', blockSize: 4096, totalBytes: 10 * GIB, availableBytes: 1024, totalInodes: 1000, availableInodes: 1000 });
  const roomy = (path: string): FsStats => ({ ...tiny(path), availableBytes: 100 * GIB, totalBytes: 200 * GIB });
  const objectsBefore = fx.raw(['count-objects', '-v'], w.repo);
  // Not even the objects fit: nothing is written at all.
  const a1 = new MemoryAuthority();
  const checks1 = new StubChecks();
  const r1 = await deliver(request(w, 'op-full'), { git: fx.git, view: w.view, authority: a1, checks: checks1, scratchDir: fx.root, disk: { ...TEST_DISK, probe: tiny }, quiet: NO_QUIET });
  assert.equal(r1.kind, 'insufficient-space');
  assert.equal(r1.kind === 'insufficient-space' ? r1.stage : null, 'objects');
  assert.equal(fx.raw(['count-objects', '-v'], w.repo), objectsBefore, 'no tree or commit was written');
  assert.deepEqual(a1.notices.map((x) => [x.wi, x.category]), [['WI-10', 'delivery-disk-admission']]);
  assert.equal(checks1.calls.length, 0, 'nothing ran');
  // The objects fit, the snapshot's filesystem does not: the snapshot is never started.
  const a2 = new MemoryAuthority();
  const checks2 = new StubChecks();
  const probe = (path: string): FsStats => (path.startsWith(w.layout.commonDir) ? roomy(path) : { ...tiny(path), availableInodes: 3 });
  const r2 = await deliver(request(w, 'op-no-inodes'), { git: fx.git, view: w.view, authority: a2, checks: checks2, scratchDir: fx.root, disk: { ...TEST_DISK, probe }, quiet: NO_QUIET });
  assert.equal(r2.kind, 'insufficient-space');
  assert.equal(r2.kind === 'insufficient-space' ? r2.stage : null, 'snapshot');
  assert.match(r2.kind === 'insufficient-space' ? r2.reasons.join(' ') : '', /candidate snapshot/);
  assert.equal(checks2.calls.length, 0);
  assert.deepEqual(a2.notices.map((x) => x.wi), ['WI-10']);
  // With the ledger's reserve on the same volume, the margin grows by it (6.6): refused where it would otherwise pass.
  const a3 = new MemoryAuthority();
  const tight = (path: string): FsStats => ({ ...roomy(path), totalBytes: 10 * GIB, availableBytes: 2 * GIB });
  const r3 = await deliver(request(w, 'op-ledger-volume'), {
    git: fx.git,
    view: w.view,
    authority: a3,
    checks: new StubChecks(),
    scratchDir: fx.root,
    disk: { reserve: { recoveryReserveBytes: 2 * GIB, evaluatorPoolBytes: 0 }, sharesVolume: () => true, probe: tight },
    quiet: NO_QUIET,
  });
  assert.equal(r3.kind, 'insufficient-space');
  const r4 = await deliver(request(w, 'op-ledger-elsewhere'), { git: fx.git, view: w.view, authority: new MemoryAuthority(), checks: new StubChecks(), scratchDir: fx.root, disk: { reserve: { recoveryReserveBytes: 2 * GIB, evaluatorPoolBytes: 0 }, sharesVolume: () => false, probe: tight }, quiet: NO_QUIET });
  assert.equal(r4.kind, 'delivered', 'the same disk without the ledger on it is enough');
});

test('ledger follow-up: a rebuild is recorded before it runs, and the ledger refusing it (LOOP_EXHAUSTED) is exhaustion, not a crash (WI-08)', async () => {
  const w = await world();
  const authority = new MemoryAuthority();
  authority.refuseRebuildsFrom = 1; // the ledger refuses the second record
  const checks = new StubChecks();
  checks.onRun = (call) => {
    advanceMain(w, `refused-${call}`);
  };
  const r = await deliver(request(w, 'op-loop-exhausted'), { git: fx.git, view: w.view, authority, checks, scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.deepEqual(r, { kind: 'rebuild-limit-exhausted', rebuilds: 1 });
  assert.equal(checks.calls.length, 2, 'the first rebuild (recorded) ran; the refused one never did');
  assert.equal(authority.signatures.length, 1);
  assert.deepEqual(authority.notices.map((x) => [x.wi, x.category]), [['WI-08', 'delivery-rebuild-exhausted']]);
  assert.match(authority.notices[0]?.trigger ?? '', /LOOP_EXHAUSTED/);
});

test('a still-running writer of an earlier attempt blocks the delivery; it is never raced', async () => {
  const w = await world();
  const req = request(w, 'op-busy');
  const ref = deliveryRef(req.key.mission, req.key.op);
  mkdirSync(join(w.layout.commonDir, 'refs/mission-pipeline/delivered', MISSION), { recursive: true });
  writeFileSync(join(w.layout.commonDir, `${ref}.lock`), '');
  const token = deliveryIntentToken(req.key);
  const child = spawn('/bin/sh', ['-c', 'sleep 30', 'sh', `mission-pipeline.intent=${token}`], { stdio: 'ignore' });
  await new Promise((res) => child.once('spawn', res));
  try {
    const authority = new MemoryAuthority();
    const r = await deliver(req, { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET, writerWaitMs: 100 });
    assert.equal(r.kind, 'ref-writer-running');
    assert.equal(refExists(w, req.key), false);
    // review r1 #9: the authorization stays open (nothing finished, the domain held) and the PM is told (WI-14).
    assert.deepEqual(authority.finished, [], 'the intent is not released while a writer may still run');
    assert.deepEqual(authority.notices.map((x) => [x.wi, x.category]), [['WI-14', 'delivery-ref-writer-running']]);
    if (r.kind !== 'ref-writer-running') return;
    // Waiting alone does not finish it either.
    const still = await resumeDeliveryRef(fx.git, req.key, r.pending, authority, { waitMs: 50 });
    assert.equal(still.kind, 'ref-writer-running');
    assert.deepEqual(authority.finished, []);
    // Ending it and confirming it gone: the lock it held is not provably the program's (review r2 #3), so it stays.
    const resumed = await resumeDeliveryRef(fx.git, req.key, r.pending, authority, { kill: true });
    assert.equal(resumed.kind, 'ref-lock-held');
    assert.equal(isProcessAlive(identifyProcess(child.pid as number)), false);
    assert.deepEqual(authority.finished, []);
    rmSync(join(w.layout.commonDir, `${ref}.lock`)); // its owner removes it
    const after = await resumeDeliveryRef(fx.git, req.key, r.pending, authority);
    assert.equal(after.kind, 'ref-not-created', 'read back absent: the intent ends (failed); a new delivery re-authorizes');
    assert.deepEqual(authority.finished, ['failed']);
    // Recovery from the table gives the same answer.
    const rec = await recoverDeliveryRef(fx.git, w.layout, req.key, { commit: rev(w, 'main') as GitOid, writer: null });
    assert.equal(rec.kind, 'not-done');
  } finally {
    child.kill('SIGKILL');
  }
});

test('an existing delivery ref pointing elsewhere is never overwritten (6.1: tampered); recovery follows the table', async () => {
  const w = await world();
  const req = request(w, 'op-taken');
  const ref = deliveryRef(req.key.mission, req.key.op);
  fx.raw(['update-ref', ref, w.M0], w.repo);
  const tampered = new MemoryAuthority();
  const r = await deliver(req, { git: fx.git, view: w.view, authority: tampered, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(r.kind, 'ref-tampered');
  assert.equal(rev(w, ref), w.M0);
  // 3.11 WI-20: no redo, no completion record; the delivery stays to be verified.
  assert.deepEqual(tampered.notices.map((x) => x.wi), ['WI-20']);
  assert.equal(tampered.completed.length, 0);

  const ok = request(w, 'op-recover');
  const delivered = await deliver(ok, { git: fx.git, view: w.view, authority: new MemoryAuthority(), checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  if (delivered.kind !== 'delivered') assert.fail(delivered.kind);
  const commit = delivered.record.commit;
  assert.deepEqual(await recoverDeliveryRef(fx.git, w.layout, ok.key, { commit, writer: null }), { kind: 'done' });
  assert.equal((await recoverDeliveryRef(fx.git, w.layout, req.key, { commit, writer: null })).kind, 'tampered');
  const fresh = { mission: MISSION, op: id<OpId>('never-started') };
  assert.deepEqual(await recoverDeliveryRef(fx.git, w.layout, fresh, { commit, writer: null }), { kind: 'not-done', removedLock: null });
});

test('WI-07: a user commit on main touches another file of a selected module: delivered as not fully proven, and the PM is told', async () => {
  const w = await world();
  // The user added a file to module a's write scope on main before the delivery.
  const parent = rev(w, 'main');
  const c = rawCommit(fx, w.repo, { ...BASE, 'a/extra.ts': 'extra\n' }, parent, 'user adds a/extra.ts');
  fx.raw(['update-ref', 'refs/heads/main', c, parent], w.repo);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'reset', '-q', '--hard', c], w.repo);
  const authority = new MemoryAuthority();
  const r = await deliver(request(w, 'op-changed'), { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(r.kind, 'delivered', JSON.stringify(r));
  if (r.kind !== 'delivered') return;
  assert.deepEqual(r.record.proof.needsReverification.map((x) => x.id), ['a1']);
  assert.deepEqual(authority.notices.map((x) => [x.wi, x.category]), [['WI-07', 'delivery-object-changed']]);
  assert.match(authority.notices[0]?.defaultAction ?? '', /re-verification/);
});

// ---------------------------------------------------------------- v49: missing objects are never fetched (WI-13)

/** Every file under the repository's object directory (loose objects and packs), sorted. */
function objectFiles(commonDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs, `${rel}${name}/`);
      else out.push(`${rel}${name}`);
    }
  };
  walk(join(commonDir, 'objects'), '');
  return out.sort();
}

test('v49 (6.6, 7.1): a blob the candidate needs is missing (a pruned object): WI-13, nothing fetched, no object file written', async () => {
  const w = await world();
  const missing = fx.raw(['rev-parse', `${rev(w, 'refs/heads/main')}:p/main.ts`], w.repo); // the base blob is fine; take p1's version of it
  const p1 = w.view.object(ov('p1'));
  if (p1 === null || p1.tree === null) assert.fail('p1');
  const blob = fx.raw(['rev-parse', `${p1.tree.commit}:p/main.ts`], w.repo);
  assert.notEqual(blob, missing);
  rmSync(join(w.layout.commonDir, 'objects', blob.slice(0, 2), blob.slice(2)));
  const before = objectFiles(w.layout.commonDir);
  const authority = new MemoryAuthority();
  const checks = new StubChecks();
  const req = request(w, 'op-missing-blob');
  const r = await deliver(req, { git: fx.git, view: w.view, authority, checks, scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(r.kind, 'objects-unavailable', JSON.stringify(r));
  if (r.kind !== 'objects-unavailable') return;
  assert.equal(r.code, 'object-missing');
  assert.deepEqual(r.objects, [blob]);
  assert.deepEqual(r.paths, ['p/main.ts']);
  assert.deepEqual(authority.notices.map((x) => [x.wi, x.category]), [['WI-13', 'delivery-objects-missing']]);
  assert.match(authority.notices[0]?.defaultAction ?? '', /nothing is fetched/);
  assert.deepEqual(objectFiles(w.layout.commonDir), before, 'no tree, commit or fetched object was written');
  assert.equal(checks.calls.length, 0);
  assert.equal(authority.intents.length, 0);
  assert.equal(refExists(w, req.key), false);
});

test('v49 (6.6, 7.1): a partial clone (blob:none) never fetches what the candidate needs: WI-13, the object directory unchanged', async () => {
  const w = await world();
  // The source serves filters; every version commit is reachable by a ref, so the clone has all commits and trees.
  fx.raw(['config', 'uploadpack.allowFilter', 'true'], w.repo);
  fx.raw(['config', 'uploadpack.allowAnySHA1InWant', 'true'], w.repo);
  for (const id of ['a1', 'b1', 'b2', 'p1', 'q1']) {
    const o = w.view.object(ov(id));
    if (o === null || o.tree === null) assert.fail(id);
    fx.raw(['update-ref', `refs/heads/v-${id}`, o.tree.commit], w.repo);
  }
  const clone = join(fx.root, `partial-${n++}`);
  // protocol.file.allow only for this fixture clone (git refuses file:// transport with filters by default).
  fx.raw(['-c', 'protocol.file.allow=always', 'clone', '-q', '--no-checkout', '--filter=blob:none', `file://${w.repo}`, clone], fx.root);
  const layout = await discoverRepo(fx.git, clone);
  assert.equal(fx.rawStatus(['config', '--get', 'remote.origin.promisor'], clone).stdout.trim(), 'true', 'a partial clone');
  const view = new FakeProofView();
  for (const id of ['a1', 'b1', 'b2', 'p1', 'q1']) view.add(w.view.object(ov(id)) as NonNullable<ReturnType<typeof w.view.object>>);
  const before = objectFiles(layout.commonDir);
  const authority = new MemoryAuthority();
  const req: DeliveryRequest = { ...request(w, 'op-partial'), repoPath: clone };
  const r = await deliver(req, { git: fx.git, view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(r.kind, 'objects-unavailable', JSON.stringify(r));
  if (r.kind !== 'objects-unavailable') return;
  assert.ok(r.objects.length > 0);
  assert.ok(r.paths.includes('p/main.ts'), JSON.stringify(r.paths));
  assert.deepEqual(authority.notices.map((x) => x.wi), ['WI-13']);
  assert.deepEqual(objectFiles(layout.commonDir), before, 'nothing was fetched or written into the partial clone');
});

test('v51: a reftable repository gets no delivery: refused before anything is built or written, with the conversion command (WI-13)', async () => {
  const w = await world(['--ref-format=reftable']);
  assert.equal(fx.raw(['rev-parse', '--show-ref-format'], w.repo), 'reftable');
  const refsBefore = fx.raw(['for-each-ref', '--format=%(refname) %(objectname)'], w.repo);
  const objectsBefore = objectFiles(w.layout.commonDir);
  const authority = new MemoryAuthority();
  const checks = new StubChecks();
  const r = await deliver(request(w, 'op-reftable'), { git: fx.git, view: w.view, authority, checks, scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(r.kind, 'repository-unsupported', JSON.stringify(r));
  assert.deepEqual(r.kind === 'repository-unsupported' ? r.extensions : null, ['extensions.refStorage=reftable']);
  assert.deepEqual(authority.notices.map((x) => [x.wi, x.category]), [['WI-13', 'delivery-repository-unsupported']]);
  assert.match(authority.notices[0]?.defaultAction ?? '', /git -C .* refs migrate --ref-format=files/);
  assert.equal(fx.raw(['for-each-ref', '--format=%(refname) %(objectname)'], w.repo), refsBefore, 'no ref');
  assert.deepEqual(objectFiles(w.layout.commonDir), objectsBefore, 'no tree, commit or other object was written');
  assert.deepEqual(authority.intents, []);
  assert.equal(checks.calls.length, 0, 'nothing was built or checked');
  // Converted to the files backend, the same delivery runs.
  fx.raw(['refs', 'migrate', '--ref-format=files'], w.repo);
  const again = await deliver(request(w, 'op-reftable'), { git: fx.git, view: w.view, authority: new MemoryAuthority(), checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(again.kind, 'delivered', JSON.stringify(again));
});

test('v50: a repository with an extension the program does not understand: WI-13, nothing built, nothing written', async () => {
  const w = await world();
  fx.raw(['config', 'core.repositoryformatversion', '1'], w.repo);
  fx.raw(['config', 'extensions.preciousObjects', 'true'], w.repo);
  const before = objectFiles(w.layout.commonDir);
  const authority = new MemoryAuthority();
  const checks = new StubChecks();
  const r = await deliver(request(w, 'op-ext'), { git: fx.git, view: w.view, authority, checks, scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(r.kind, 'repository-unsupported', JSON.stringify(r));
  assert.deepEqual(r.kind === 'repository-unsupported' ? r.extensions : null, ['extensions.preciousobjects=true']);
  assert.deepEqual(authority.notices.map((x) => [x.wi, x.category]), [['WI-13', 'delivery-repository-unsupported']]);
  assert.deepEqual(objectFiles(w.layout.commonDir), before);
  assert.equal(checks.calls.length, 0);
});

test('v50: a missing tree or commit (not only a blob) refuses the delivery with WI-13 before anything is written', async () => {
  // A subtree of the base is gone.
  const w = await world();
  const docs = fx.raw(['rev-parse', `${w.M0}:docs`], w.repo);
  rmSync(join(w.layout.commonDir, 'objects', docs.slice(0, 2), docs.slice(2)));
  const before = objectFiles(w.layout.commonDir);
  const a1 = new MemoryAuthority();
  const r1 = await deliver(request(w, 'op-no-tree'), { git: fx.git, view: w.view, authority: a1, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(r1.kind, 'objects-unavailable', JSON.stringify(r1));
  assert.ok(r1.kind === 'objects-unavailable' && r1.objects.includes(docs), JSON.stringify(r1));
  assert.deepEqual(a1.notices.map((x) => x.wi), ['WI-13']);
  assert.deepEqual(objectFiles(w.layout.commonDir), before);
  // The commit a version was built from is gone (as beyond a shallow boundary): never read as "no parent".
  const w2 = await world();
  const a = w2.view.object(ov('a1'));
  if (a === null || a.tree === null) assert.fail('a1');
  const parent = fx.raw(['rev-parse', `${a.tree.commit}^`], w2.repo);
  const otherUsers = fx.raw(['for-each-ref', '--contains', parent, '--format=%(refname)'], w2.repo);
  assert.ok(otherUsers.includes('refs/heads/main'), 'the parent is M0, the base itself: remove a version whose parent is not the base instead');
  const lone = rawCommit(fx, w2.repo, { ...BASE, 'docs/readme.md': 'readme x\n' }, w2.M0, 'lone parent');
  const child = rawCommit(fx, w2.repo, { ...BASE, 'docs/readme.md': 'readme x\n', 'a/x.ts': 'export const x = 3;\n' }, lone, 'version on lone');
  w2.view.add(await productVersion(fx.git, w2.layout, { id: 'a3', module: 'a', writeScope: ['a/**'], commit: child, transform: transformDescriptionHash(w2.d) }));
  rmSync(join(w2.layout.commonDir, 'objects', lone.slice(0, 2), lone.slice(2)));
  const before2 = objectFiles(w2.layout.commonDir);
  const a2 = new MemoryAuthority();
  const r2 = await deliver(request(w2, 'op-no-parent', [obj('a3')]), { git: fx.git, view: w2.view, authority: a2, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
  assert.equal(r2.kind, 'objects-unavailable', JSON.stringify(r2));
  assert.deepEqual(r2.kind === 'objects-unavailable' ? r2.objects : null, [lone]);
  assert.deepEqual(a2.notices.map((x) => x.wi), ['WI-13']);
  assert.deepEqual(objectFiles(w2.layout.commonDir), before2);
});
