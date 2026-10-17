// Disk and checkouts (4.1.2, card P2; design "Execution redundancy", items 2 and 3): no tree
// written that nobody reads, one shared read-only checkout per commit for the reading seats,
// built atomically and removed with its last holder, owned scratch swept once its owner is gone,
// tmp/<dispatch>/ removed when the dispatch is over, and `mp pm clean`.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, test } from 'node:test';
import { sha256 } from '../src/common/hash.ts';
import { contentHash, type MissionId } from '../src/common/ids.ts';
import { buildCandidate, candidateFileHashes, checkCandidateProofs, type Candidate } from '../src/delivery/candidate.ts';
import { buildManifest, type DeliveryManifest } from '../src/delivery/manifest.ts';
import { encodeLfsPointer, lfsPointerFor } from '../src/git/lfs.ts';
import { discoverRepo } from '../src/git/objects.ts';
import { AttributeEvaluator, readTransformDescription, sha256Hex, storeLfsObject, transformDescriptionHash } from '../src/git/representation.ts';
import { checkoutCommit, ensureWorkspace, removeCheckout, runCheckoutDir, sharedCheckoutDir, workspaceDir } from '../src/git/workspace.ts';
import { cal1Pass } from '../src/flow/scripted.ts';
import { queueTask } from '../src/memory/index.ts';
import { holdOwner, ownerLockFile, releaseOwner, removeTree } from '../src/memory/scratch.ts';
import { productObjectId } from '../src/process/actions.ts';
import { sweepTmp } from '../src/process/housekeeping.ts';
import { pmDispatch, pmNext, pmRelease, seatCheckout } from '../src/process/index.ts';
import { cli } from './cli-fixtures.ts';
import { evi, FakeProofView, obj, productVersion } from './delivery-fixtures.test.ts';
import { checkoutMain, initRepo, makeFixture, rawCommit, type Fixture } from './git-fixtures.test.ts';
import { addDetailedPlan, addMissionToReview, ENV_A, handBack, processProject, readAll, readyOf, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
const CHILD = fileURLToPath(new URL('./disk-housekeeping-child.ts', import.meta.url));
const ROOT = process.getuid?.() === 0;

let p: ProcessProject | null = null;
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null && c.pid !== undefined) process.kill(c.pid, 'SIGKILL');
  const q = p;
  p = null;
  q?.cleanup();
});

let fx: Fixture;
before(() => {
  fx = makeFixture('p2-disk');
});
after(() => fx.cleanup());

/** Every file and directory under `dir`, relative, sorted ('' when absent). */
function listing(dir: string, rel = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    out.push(r);
    if (e.isDirectory()) out.push(...listing(dir, r));
  }
  return out.sort();
}

/** The paths under `root` that the given fs functions were called on while `fn` ran (spied through the builtin ESM bindings). */
async function writesUnder<T>(root: string, fn: () => Promise<T>): Promise<{ value: T; writes: string[] }> {
  const names = ['mkdtempSync', 'mkdirSync', 'writeFileSync', 'symlinkSync', 'openSync', 'copyFileSync'] as const;
  const fsx = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  const orig = new Map(names.map((n) => [n, fsx[n]!]));
  const writes: string[] = [];
  for (const n of names) {
    fsx[n] = (...args: unknown[]) => {
      const target = String(args[0]);
      const flags = n === 'openSync' ? String(args[1] ?? 'r') : 'w';
      if (target.startsWith(root) && flags !== 'r') writes.push(`${n} ${target}`);
      return orig.get(n)!(...args);
    };
  }
  syncBuiltinESMExports();
  try {
    return { value: await fn(), writes };
  } finally {
    for (const n of names) fsx[n] = orig.get(n)!;
    syncBuiltinESMExports();
  }
}

/** Another mp process (disk-housekeeping-child.ts); resolves once it wrote its marker. */
async function childUntilMarker(action: Record<string, unknown>, marker: string): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CHILD, JSON.stringify({ ...action, marker })], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  let err = '';
  proc.stderr!.on('data', (b) => (err += String(b)));
  for (let i = 0; i < 600; i++) {
    if (existsSync(marker)) return proc;
    if (proc.exitCode !== null) throw new Error(`the child exited (${proc.exitCode}) before its marker: ${err.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the child wrote no marker in 30 s: ${err.slice(-2000)}`);
}

async function killByPid(proc: ChildProcess): Promise<void> {
  const exited = new Promise((r) => proc.once('exit', r));
  process.kill(proc.pid!, 'SIGKILL');
  await exited;
}

/** The mission at its Architect step (ready, not dispatched): its card names the base commit. */
async function atArchitect(): Promise<{ q: ProcessProject; step: string; base: string }> {
  const q = processProject();
  p = q;
  await startAddMission(q.ctx, M);
  await step(q.ctx, 'calibrator-1', (c) => cal1Pass(c));
  const s = await readyOf(q.ctx, 'architect-decompose');
  return { q, step: s.step, base: q.git('rev-parse', 'main') };
}

// ---------------------------------------------------------------- 1. no unread trees

test('a start snapshot for a dependent task writes nothing under tmp/: only its commit is made', async () => {
  const q = processProject();
  p = q;
  const base = q.git('rev-parse', 'HEAD');
  q.git('checkout', '-q', '-b', 'work');
  write(q.dir, 'src/a.txt', 'a\n');
  q.git('add', '-A');
  q.git('commit', '-q', '-m', 'work');
  const candidate = q.git('rev-parse', 'HEAD');
  q.git('checkout', '-q', 'main');
  await q.ctx.actions().product({ mission: M, module: 'core', task: 'con.m1.a.1', dispatch: 'D-1', candidate, base, writeScope: ['src/**'], taskType: 'implementation', prerequisites: [], reviews: [], predecessor: null });
  const tmp = q.ctx.memory.paths.tmp;
  // the spy sees a checkout's writes (a control: the assertion below is not vacuous)
  const control = await writesUnder(tmp, () => checkoutCommit(q.ctx.gitCtx, { commit: base, dir: runCheckoutDir(q.ctx.memory.paths, 'run-control') }));
  assert.ok(control.writes.some((w) => w.endsWith(`${sep}README.md`)), JSON.stringify(control.writes));
  removeCheckout(q.ctx.gitCtx, runCheckoutDir(q.ctx.memory.paths, 'run-control'));
  const { value: snap, writes } = await writesUnder(tmp, () => q.ctx.actions().snapshot({ mission: M, purpose: 'dependent', products: [productObjectId('con.m1.a.1')] }));
  assert.deepEqual(writes, [], 'nothing is written under tmp/ (v4.1.1 wrote the whole tree into tmp/snapshot-*/overlay and deleted it unread)');
  assert.deepEqual(listing(tmp).filter((x) => !x.startsWith('.leaves-pending')), []);
  assert.equal(q.git('rev-parse', `${snap.commit}^`), base, 'the start is laid over the mission base');
  assert.equal(q.git('show', `${snap.commit}:src/a.txt`), 'a', 'with the product it rests on');
});

test('candidate hashes: unmaterialized, the same bytes as a checkout for eol and LFS conversions; materialize none writes nothing, paths writes only those', async () => {
  const repo = initRepo(fx, 'hash');
  const attrs = '*.txt text eol=crlf\n*.bin filter=lfs diff=lfs merge=lfs -text\n';
  const M0 = rawCommit(fx, repo, { '.gitattributes': attrs, 'README': 'r\n', 'a/x.txt': 'one\n' }, null, 'M0');
  checkoutMain(fx, repo, M0);
  const layout = await discoverRepo(fx.git, repo);
  const big = randomBytes(3000);
  const ptr = lfsPointerFor(big);
  const obj0 = join(fx.root, 'lfs-object');
  writeFileSync(obj0, big);
  storeLfsObject(layout.commonDir, obj0, ptr);
  const CA1 = rawCommit(fx, repo, { '.gitattributes': attrs, 'README': 'r\n', 'a/x.txt': 'one\ntwo\n', 'a/big.bin': encodeLfsPointer(ptr), 'a/link': { link: 'x.txt' } }, M0, 'A1');
  const d = await readTransformDescription(fx.git, layout);
  const ev = await AttributeEvaluator.create(fx.git, layout, d, fx.root);
  try {
    const view = new FakeProofView().add(await productVersion(fx.git, layout, { id: 'a1', module: 'a', writeScope: ['a/**'], commit: CA1, transform: transformDescriptionHash(d) }));
    const crlf = sha256('one\r\ntwo\r\n');
    view.setEvidence(obj('a1'), [{ evidence: evi('run-a1'), inputs: [{ path: 'a/x.txt', sha256: crlf }, { path: 'a/big.bin', sha256: contentHash(sha256Hex(big)) }] }]);
    const built = buildManifest(view, [obj('a1')]);
    assert.equal(built.kind, 'manifest');
    const manifest = (built as { manifest: DeliveryManifest }).manifest;
    const ident = { name: 'Mission Pipeline', email: 'engine@example.invalid', date: '1700000200 +0000' };
    const make = async (dir: string, materialize?: 'none' | { paths: string[] }): Promise<Candidate> => {
      const r = await buildCandidate({ git: fx.git, repo: layout, manifest, base: M0, attributes: ev, snapshotDir: dir, message: 'delivery\n', author: ident, committer: ident, ...(materialize !== undefined ? { materialize } : {}) });
      assert.equal(r.kind, 'candidate');
      return (r as { candidate: Candidate }).candidate;
    };
    const paths = ['a/x.txt', 'a/big.bin', 'a/link', 'README', 'a/absent.txt', 'a'];
    // as v4.1.1: the whole candidate on disk, hashed from the files there
    const allDir = join(fx.root, 'cand-all');
    const all = await make(allDir);
    assert.equal(sha256(readFileSync(join(allDir, 'a/x.txt'))), crlf, 'the checkout holds CRLF');
    const fromDisk = await candidateFileHashes({ git: fx.git, repo: layout, candidate: all }, paths);
    assert.equal(fromDisk.get('a/x.txt'), crlf);
    assert.equal(fromDisk.get('a/big.bin'), contentHash(sha256Hex(big)), 'the LFS object, not its pointer');
    // nothing materialized: computed from the objects, the same values
    const noneDir = join(fx.root, 'cand-none');
    const none = await make(noneDir, 'none');
    assert.equal(none.snapshotDir, null);
    assert.equal(none.commit, all.commit, 'the same candidate commit');
    assert.ok(!existsSync(noneDir), 'nothing is written');
    await assert.rejects(candidateFileHashes({ git: fx.git, repo: layout, candidate: none }, paths), /attribute evaluator/);
    assert.deepEqual(await candidateFileHashes({ git: fx.git, repo: layout, candidate: none, attributes: ev }, paths), fromDisk);
    const proof = await checkCandidateProofs({ git: fx.git, repo: layout, view, manifest, candidate: none, attributes: ev });
    assert.deepEqual(proof.notFullyProven, []);
    assert.deepEqual(proof.proven, ['a1']);
    // a path list: only those paths are written
    const someDir = join(fx.root, 'cand-some');
    const some = await make(someDir, { paths: ['a/x.txt'] });
    assert.deepEqual(listing(someDir), ['a', 'a/x.txt']);
    assert.deepEqual(await candidateFileHashes({ git: fx.git, repo: layout, candidate: some, attributes: ev }, paths), fromDisk);
  } finally {
    ev.dispose();
  }
});

// ---------------------------------------------------------------- 2. shared, atomic, removed checkouts; 4. tmp/<dispatch>/

test('two seats on one commit share one read-only checkout: kept after the first hands back, removed after the second; tmp/<dispatch>/ goes at hand-back', async () => {
  const { q, step: arch, base } = await atArchitect();
  const ctx = q.ctx;
  const row = ctx.memory.read((db) => db.stmt('SELECT card, lineage, mission FROM tasks WHERE task = ?').get(arch)) as { card: string; lineage: string; mission: MissionId };
  ctx.memory.write({}, (tx) => queueTask(tx, { task: `${arch}.copy`, lineage: `${row.lineage}.copy`, mission: row.mission, card: row.card as never }));
  const d1 = pmDispatch(ctx, arch).dispatch;
  const d2 = pmDispatch(ctx, `${arch}.copy`).dispatch;
  const c1 = await seatCheckout(ctx, d1);
  const c2 = await seatCheckout(ctx, d2);
  const shared = sharedCheckoutDir(ctx.memory.paths, base);
  assert.equal(c1.path, shared);
  assert.equal(c2.path, shared, 'the second seat gets the same directory');
  assert.equal(c1.commit, base);
  assert.equal(readFileSync(join(shared, 'README.md'), 'utf8'), '# the project\n');
  assert.deepEqual(readdirSync(join(ctx.memory.paths.tmp, 'checkouts')), [base], 'one tree, nothing left from building it');
  for (const d of [d1, d2]) assert.ok(!existsSync(join(ctx.memory.paths.tmp, d, 'checkout')), 'no private copy');
  if (!ROOT) assert.throws(() => writeFileSync(join(shared, 'README.md'), 'changed by a seat\n'), /EACCES|EPERM/, 'its files are read-only: one seat cannot change what another reads');
  // the sweep leaves what dispatches in flight hold
  await pmNext(ctx);
  assert.ok(existsSync(shared));
  readAll(ctx, d1);
  readAll(ctx, d2);
  const a1 = await handBack(ctx, d1, addDetailedPlan(M));
  assert.equal(a1.kind, 'recorded', JSON.stringify(a1));
  assert.ok(!existsSync(join(ctx.memory.paths.tmp, d1)), 'tmp/<dispatch>/ is removed once the hand-back is recorded');
  assert.ok(existsSync(join(shared, 'README.md')), 'still held by the second seat');
  assert.ok(existsSync(join(ctx.memory.paths.tmp, d2)), 'the other dispatch keeps its own');
  const a2 = await handBack(ctx, d2, addDetailedPlan(M));
  assert.equal(a2.kind, 'recorded', JSON.stringify(a2));
  assert.ok(!existsSync(shared), 'removed after the last holder hands back');
  assert.ok(!existsSync(join(ctx.memory.paths.tmp, d2)));
  assert.deepEqual(listing(ctx.memory.paths.tmp).filter((x) => !x.startsWith('.leaves-pending')), ['checkouts'], 'nothing else is left, the trash included');
  // the same hand-back again: recorded once, its files (written again) removed again
  const again = await handBack(ctx, d1, addDetailedPlan(M));
  assert.ok(again.kind === 'recorded' && again.repeated);
  assert.ok(!existsSync(join(ctx.memory.paths.tmp, d1)));
  // a dispatch that is over holds nothing: no checkout for it
  await assert.rejects(seatCheckout(ctx, d1), /handed back/);
});

test('release --ended and --abandoned remove tmp/<dispatch>/ and the checkouts only that dispatch held', async () => {
  const { q, step: arch, base } = await atArchitect();
  const ctx = q.ctx;
  const shared = sharedCheckoutDir(ctx.memory.paths, base);
  for (const how of ['ended', 'abandoned'] as const) {
    const s = await readyOf(ctx, 'architect-decompose');
    assert.equal(s.step, arch);
    const d = pmDispatch(ctx, arch).dispatch;
    await seatCheckout(ctx, d);
    write(join(ctx.memory.paths.tmp, d), 'notes.md', 'half a report\n');
    assert.ok(existsSync(shared));
    const r = await pmRelease(ctx, d, how);
    assert.ok(r.released);
    assert.equal(r.notes, undefined);
    assert.ok(!existsSync(join(ctx.memory.paths.tmp, d)), `tmp/<dispatch>/ removed on release --${how}`);
    assert.ok(!existsSync(shared), `the checkout only it held is removed on release --${how}`);
  }
});

test('an interrupted checkout build leaves nothing at the announced path; the next checkout completes; the sweep removes the partial build', async () => {
  const { q, step: arch, base } = await atArchitect();
  const ctx = q.ctx;
  const d = pmDispatch(ctx, arch).dispatch;
  const marker = join(q.dir, '..', 'stalled');
  const child = await childUntilMarker({ action: 'stall-checkout', dir: q.dir, env: ENV_A, dispatch: d }, marker);
  assert.equal(readFileSync(marker, 'utf8'), 'stalled');
  await killByPid(child);
  const shared = sharedCheckoutDir(ctx.memory.paths, base);
  assert.ok(!existsSync(shared), 'nothing at the announced path');
  assert.ok(!existsSync(join(ctx.memory.paths.tmp, d, 'checkout')), 'and no partial private copy (v4.1.1 wrote the tree in place there)');
  const partial = readdirSync(join(ctx.memory.paths.tmp, 'checkouts')).filter((n) => n.startsWith('.build-'));
  assert.equal(partial.length, 1, 'the killed build is in its own temporary sibling');
  const c = await seatCheckout(ctx, d);
  assert.equal(c.path, shared);
  assert.equal(readFileSync(join(shared, 'README.md'), 'utf8'), '# the project\n');
  assert.equal(readFileSync(join(shared, '.gitignore'), 'utf8'), '*.local\n');
  const report = sweepTmp(ctx, { budgetMs: 10_000 });
  assert.ok(report.removed.some((x) => x.path === `checkouts/${partial[0]}` && x.why === 'its owner is gone' && x.done), JSON.stringify(report));
  assert.deepEqual(readdirSync(join(ctx.memory.paths.tmp, 'checkouts')), [base], 'the partial build is gone, the held checkout stays');
  assert.ok(!existsSync(ownerLockFile(ctx.memory.paths, join(ctx.memory.paths.tmp, 'checkouts', partial[0]!))), 'its owner lock file too');
});

// ---------------------------------------------------------------- 3. owned scratch, swept when its owner is gone

test('mp pm next sweeps a run checkout whose process was killed, never one whose owner runs; old unowned scratch goes, young or unknown stays', async () => {
  const q = processProject();
  p = q;
  const ctx = q.ctx;
  const tmp = ctx.memory.paths.tmp;
  const base = q.git('rev-parse', 'HEAD');
  const killed = await childUntilMarker({ action: 'own-run', dir: q.dir, env: ENV_A, commit: base, run: 'run-killed' }, join(q.dir, '..', 'killed-ready'));
  const live = await childUntilMarker({ action: 'own-run', dir: q.dir, env: ENV_A, commit: base, run: 'run-live' }, join(q.dir, '..', 'live-ready'));
  await killByPid(killed);
  assert.ok(existsSync(join(tmp, 'run-killed', 'README.md')) && existsSync(join(tmp, 'run-live', 'README.md')));
  // 4.1.1 leftovers have no owner: swept once a day old
  write(tmp, 'run-legacy/README.md', 'left by 4.1.1\n');
  const old = new Date(Date.now() - 2 * 24 * 3600_000);
  utimesSync(join(tmp, 'run-legacy'), old, old);
  write(tmp, 'snapshot-young/x', 'made a minute ago\n');
  write(tmp, 'user-notes/keep.txt', 'not mp\'s\n');
  await pmNext(ctx);
  assert.ok(!existsSync(join(tmp, 'run-killed')), 'the killed run\'s checkout is swept');
  assert.ok(!existsSync(ownerLockFile(ctx.memory.paths, join(tmp, 'run-killed'))), 'with its owner lock file');
  assert.ok(existsSync(join(tmp, 'run-live', 'README.md')), 'a live owner\'s checkout is never touched');
  assert.ok(!existsSync(join(tmp, 'run-legacy')), 'an unowned scratch directory a day old is swept');
  assert.ok(existsSync(join(tmp, 'snapshot-young', 'x')), 'a young one stays');
  assert.ok(existsSync(join(tmp, 'user-notes', 'keep.txt')), 'what mp does not know stays');
  // the memory's own notes of writes in progress are the memory's (its next write cleans them), never the sweep's
  write(tmp, '.leaves-pending/x.json', '{}');
  sweepTmp(ctx, { budgetMs: 10_000 });
  assert.ok(existsSync(join(tmp, '.leaves-pending', 'x.json')), 'the sweep never touches tmp/.leaves-pending/');
  // once its owner is gone, the next call sweeps it
  await killByPid(live);
  await pmNext(ctx);
  assert.ok(!existsSync(join(tmp, 'run-live')));
});

test('the sweep in mp pm next is bounded: a past deadline leaves the work in the trash for the next call', async () => {
  const q = processProject();
  p = q;
  const tmp = q.ctx.memory.paths.tmp;
  const dead = join(tmp, 'collect-D-9-abc');
  holdOwner(q.ctx.memory.paths, dead);
  for (let i = 0; i < 50; i++) write(dead, `f${i}.txt`, 'x'.repeat(100));
  // its owner gone: an unheld lock file (as a killed process leaves it)
  releaseOwner(q.ctx.memory.paths, dead);
  const file = ownerLockFile(q.ctx.memory.paths, dead);
  new DatabaseSync(file).close();
  const first = sweepTmp(q.ctx, { budgetMs: -1 });
  assert.deepEqual(first.removed, [], 'no budget left: nothing decided');
  assert.ok(existsSync(dead));
  // deleting stops at the deadline and goes on later
  const trash = join(tmp, '.trash-test');
  for (let i = 0; i < 5; i++) write(trash, `d${i}/f.txt`, 'x');
  assert.deepEqual(removeTree(trash, { deadline: Date.now() - 1 }), { done: false, bytes: 0 });
  assert.ok(existsSync(join(trash, 'd0', 'f.txt')));
  const second = sweepTmp(q.ctx, { budgetMs: 10_000 });
  assert.deepEqual(second.removed.map((x) => [x.path, x.why, x.done]).sort(), [['.trash-test', 'left in the trash by an earlier removal', true], ['collect-D-9-abc', 'its owner is gone', true]]);
  assert.ok(!existsSync(dead) && !existsSync(file) && !existsSync(trash));
  assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith('.trash-')), []);
});

// ---------------------------------------------------------------- 5. mp pm clean

test('mp pm clean removes what has no live owner and the worktrees of dispatches that are over, and reports the bytes freed', async () => {
  const q = processProject();
  p = q;
  const r = await addMissionToReview(q, M);
  const ctx = q.ctx;
  const tmp = ctx.memory.paths.tmp;
  // a crash after the Constructor's hand-back left its worktree
  ensureWorkspace(ctx.gitCtx, { dispatch: r.constructor, base: q.git('rev-parse', 'main') });
  const wt = workspaceDir(ctx.memory.paths, r.constructor);
  writeFileSync(join(wt, 'big.local'), Buffer.alloc(5000));
  // a dead owner's scratch (2,000 bytes), a 4.1.1 leftover a day old (1,000 bytes), trash (300 bytes)
  write(tmp, 'compare-dead/a', 'a'.repeat(2000));
  new DatabaseSync((mkdirSync(join(ctx.memory.paths.locks, 'owners'), { recursive: true }), ownerLockFile(ctx.memory.paths, join(tmp, 'compare-dead')))).close();
  write(tmp, 'deliver-m1-d1-old/x', 'b'.repeat(1000));
  const old = new Date(Date.now() - 2 * 24 * 3600_000);
  utimesSync(join(tmp, 'deliver-m1-d1-old'), old, old);
  write(tmp, '.trash-earlier/y', 'c'.repeat(300));
  // a live owner's (this process)
  const live = join(tmp, 'run-live');
  holdOwner(ctx.memory.paths, live);
  write(live, 'z', 'd'.repeat(700));
  try {
    const out = await cli(q.dir, ['pm', 'clean', '--json']);
    assert.equal(out.code, 0, out.out + out.err);
    const res = out.json.result;
    const worktreeBytes = res.worktrees.find((w: { dispatch: string }) => w.dispatch === r.constructor)?.bytes;
    assert.ok(worktreeBytes >= 5000, JSON.stringify(res.worktrees));
    assert.equal(res.bytes, 2000 + 1000 + 300, JSON.stringify(res.removed));
    assert.equal(res.totalBytes, res.bytes + worktreeBytes);
    assert.ok(!existsSync(wt), 'the worktree of a dispatch that is over is removed');
    for (const gone of ['compare-dead', 'deliver-m1-d1-old', '.trash-earlier']) assert.ok(!existsSync(join(tmp, gone)), gone);
    assert.ok(existsSync(join(live, 'z')), 'a live owner\'s directory stays');
    assert.ok(res.kept.some((k: { path: string; why: string }) => k.path === 'run-live' && k.why === 'its owner is running'));
    const text = await cli(q.dir, ['pm', 'clean']);
    assert.match(text.out, /^Freed 0 B\./m, 'nothing left to free the second time');
  } finally {
    releaseOwner(ctx.memory.paths, live);
  }
});

// ---------------------------------------------------------------- review r1 (general item 1)

test('a run checkout that cannot be removed does not fail its run: its owner record stays and the sweep removes it later', { skip: ROOT ? 'root ignores directory permissions' : false }, async () => {
  const q = processProject();
  p = q;
  const base = q.git('rev-parse', 'HEAD');
  const dir = runCheckoutDir(q.ctx.memory.paths, 'run-stuck');
  await checkoutCommit(q.ctx.gitCtx, { commit: base, dir });
  // a directory whose entries cannot be unlinked stands in for a file still in use
  mkdirSync(join(dir, 'held'), { recursive: true });
  writeFileSync(join(dir, 'held', 'f'), 'x');
  fs.chmodSync(join(dir, 'held'), 0o500);
  try {
    assert.deepEqual(removeCheckout(q.ctx.gitCtx, dir), { removed: false }, 'no throw: the run records its results');
    assert.ok(existsSync(ownerLockFile(q.ctx.memory.paths, dir)), 'the owner record is kept for the sweep');
  } finally {
    fs.chmodSync(join(dir, 'held'), 0o700);
  }
  const r = sweepTmp(q.ctx, { budgetMs: 60_000 });
  assert.ok(r.removed.some((x) => x.path === 'run-stuck' && x.done !== false), JSON.stringify(r));
  assert.equal(existsSync(dir), false);
});
