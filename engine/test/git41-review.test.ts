// Regression tests for the code review of package A4 (gpt-6.1-sol, findings
// #1-#12 and #14): one or more tests per finding, named by it.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { id, type ObjectVersionId, type StopId } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';
import { deliver, type DeliverRequest, type DeliveryFullRun, type DeliveryResult } from '../src/delivery/delivery.ts';
import type { LabelView } from '../src/delivery/memoryView.ts';
import { writeScopeDocument } from '../src/delivery/writeScope.ts';
import { land, recoverLandings } from '../src/git/land.ts';
import { discoverRepo, lsTree } from '../src/git/objects.ts';
import { detachDuplicateCheckout } from '../src/git/pmActions.ts';
import { GitTimeoutError, PlainGit } from '../src/git/plainGit.ts';
import { AttributeEvaluator, materializeSnapshot, nameCollisions, readTransformDescription, RepresentationError, resolveConversion, transformDescriptionHash } from '../src/git/representation.ts';
import { checkoutCommit, collectCandidate, compareToCommit, ensureWorkspace, removeWorkspace, runCheckoutDir } from '../src/git/workspace.ts';
import { appendRecords, claimDispatch, commitStop, deliveryInfo, finishIntent, intentInfo, landingState, openIntents, queueTask } from '../src/memory/index.ts';
import { commitOn, fixture, gitWrapper, holdGitWrites, IDENT, M, recordedDelivery, rejectsCode, sh, words, write, type Fixture } from './git41-fixtures.ts';
import { tempDir } from './memory-fixtures.ts';

const POSIX = process.platform !== 'win32';
const DELIVER_CHILD = fileURLToPath(new URL('./git41-deliver-child.ts', import.meta.url));

// ---------------------------------------------------------------- helpers

async function product(f: Fixture, object: string, mission: string = M, files: Record<string, string> = { 'src/a.txt': 'candidate\n' }): Promise<string> {
  const commit = commitOn(f.dir, f.git('rev-parse', 'main'), files, `product ${object}`);
  const repo = await discoverRepo(f.ctx.git, f.dir);
  const transform = transformDescriptionHash(await readTransformDescription(f.ctx.git, repo, f.dir));
  const scopeDoc = writeScopeDocument(await lsTree(f.ctx.git, repo, commit, { recursive: true }), ['src/**']);
  f.m.write({}, (tx) => {
    const rec = {
      kind: 'object.version',
      object,
      objectKind: 'product',
      mission,
      module: `mod-${object}`,
      content: tx.data.put(scopeDoc),
      prerequisites: tx.data.putList([]),
      scope: { paths: Object.keys(files), taskType: 'construct' },
      reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
      source: { commit, writeScope: ['src/**'], transform },
    } as unknown as BaseRecord;
    appendRecords(tx, [rec]);
  });
  return commit;
}

function labels(f: Fixture, over: Partial<LabelView> = {}): LabelView {
  return { revision: f.m.head(), recomputing: false, labelOf: () => 'proven', decidingRuns: () => [], recomputingIn: () => false, ...over };
}

function request(op: string, over: Partial<DeliverRequest> = {}): DeliverRequest {
  return { mission: M, delivery: op, targetBranch: 'main', selected: [{ kind: 'object', id: 'o1' as ObjectVersionId }], author: IDENT, committer: IDENT, ...over };
}

function collect(f: Fixture, dispatch: string, writePaths: string[], base = f.base) {
  return collectCandidate(f.ctx, { dispatch, base, writePaths, message: 'candidate\n', author: IDENT, committer: IDENT });
}

function pending(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// ---------------------------------------------------------------- #1

test('#1 two deliveries running at once each build and record their own candidate, in their own directory', { skip: !POSIX }, async () => {
  const f = fixture({ files: { 'src/a.txt': 'base\n' } });
  try {
    await product(f, 'o1', M, { 'src/a.txt': 'BAD\n' });
    await product(f, 'o2', 'm2', { 'src/a.txt': 'GOOD\n' });
    const req = (mission: string, object: string): DeliverRequest => request('d1', { mission: mission as typeof M, selected: [{ kind: 'object', id: object as ObjectVersionId }] });
    const reached1 = pending();
    const go1 = pending();
    const asked: string[] = [];
    // the first delivery waits after its candidate is built and proof-checked, while the second one runs whole
    const first = deliver(f.ctx, req(M, 'o1'), { labels: labels(f), fullRun: async (c) => { asked.push(c.commit); reached1.resolve(); await go1.promise; return { line: 'never run', status: null }; } });
    await reached1.promise;
    const second = deliver(f.ctx, req('m2', 'o2'), { labels: labels(f), fullRun: (c) => { asked.push(c.commit); return { line: 'never run', status: null }; } });
    const r2 = await second;
    go1.resolve();
    const r1 = await first;
    assert.equal(r1.kind, 'delivered');
    assert.equal(r2.kind, 'delivered');
    if (r1.kind !== 'delivered' || r2.kind !== 'delivered') return;
    assert.equal(f.git('show', `${r1.record.commit}:src/a.txt`), 'BAD', 'each delivery carries its own candidate');
    assert.equal(f.git('show', `${r2.record.commit}:src/a.txt`), 'GOOD');
    assert.deepEqual(asked, [r1.record.commit, r2.record.commit], 'the first asked first, and finished after the second');
    assert.equal(readdirSync(f.m.paths.tmp).filter((x) => x.startsWith('deliver-')).length, 0, 'each scratch directory is removed by its own delivery');
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------- #2

test('#2 a delivery-ref intent is never closed because the ref is absent: a late git, a retry and a lock all end with one record at D', { skip: !POSIX }, async () => {
  const f = fixture({ files: { 'src/a.txt': 'base\n' } });
  try {
    await product(f, 'o1');
    const mark = join(f.dir, '.git', 'dref-mark');
    const wrapper = gitWrapper(tempDir('mp-wrap-'), { pattern: '*" update-ref "*refs/mission-pipeline/delivered*', mark, sleep: 3 });
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', DELIVER_CHILD, JSON.stringify({ dir: f.dir, gitPath: wrapper, req: request('d1') })], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    for (let i = 0; i < 200 && !existsSync(mark); i++) await sleep(50);
    assert.ok(existsSync(mark), `the child reached its git step (stderr: ${err})`);
    child.kill('SIGKILL');
    await exited;
    assert.equal(f.m.read((db) => openIntents(db)).length, 1);
    // The retry: the same create-only update of the same D, no rebuild (a rebuild would ask for a new full-run status).
    const retry = await deliver(f.ctx, request('d1'), { labels: labels(f), fullRun: (): DeliveryFullRun => { throw new Error('the retry rebuilt the candidate'); } });
    assert.equal(retry.kind === 'delivered' && retry.recovered, true, JSON.stringify(retry));
    const D = retry.kind === 'delivered' ? retry.record.commit : '';
    for (let i = 0; i < 200 && !existsSync(`${mark}.done`); i++) await sleep(50);
    assert.equal(f.git('rev-parse', 'refs/mission-pipeline/delivered/m1/d1'), D, 'the late git changed nothing');
    assert.equal(deliveryInfo(f.m, M, 'd1')?.state, 'recorded');
    assert.equal(f.m.read((db) => openIntents(db)).length, 0);

    // A lock in the way: the intent stays open with D ("ref-pending"); once the lock is gone, the same D is created.
    const lock = join(f.dir, '.git', 'refs', 'mission-pipeline', 'delivered', 'm1', 'd2.lock');
    const pend = await deliver(f.ctx, request('d2'), { labels: labels(f), hooks: { beforeRef: () => { mkdirSync(join(lock, '..'), { recursive: true }); writeFileSync(lock, ''); } } });
    assert.equal(pend.kind, 'ref-pending', JSON.stringify(pend));
    if (pend.kind !== 'ref-pending') return;
    assert.equal(intentInfo(f.m, pend.intent)?.state, 'authorized');
    unlinkSync(lock);
    const after = await deliver(f.ctx, request('d2'), { labels: labels(f) });
    assert.equal(after.kind === 'delivered' && [after.recovered, after.record.commit].join(), [true, pend.commit].join());

    // An intent closed earlier, and the ref created afterwards at its commit: recorded from that intent.
    const p3 = await deliver(f.ctx, request('d3'), { labels: labels(f), hooks: { beforeRef: () => { mkdirSync(join(lock, '..'), { recursive: true }); writeFileSync(join(lock, '..', 'd3.lock'), ''); } } });
    assert.equal(p3.kind, 'ref-pending');
    if (p3.kind !== 'ref-pending') return;
    f.m.write({}, (tx) => finishIntent(tx, { intent: p3.intent, outcome: 'failed' }));
    unlinkSync(join(lock, '..', 'd3.lock'));
    f.git('update-ref', p3.ref, p3.commit);
    const late = await deliver(f.ctx, request('d3'), { labels: labels(f) });
    assert.equal(late.kind === 'delivered' && late.recovered, true);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------- #3, #5

test('#3 collection judges actual content: assume-unchanged and skip-worktree hide nothing; gitlink changes count and are refused', async () => {
  const f = fixture({ files: { 'src/a.txt': 'base\n', 'docs/out.txt': 'outside\n' } });
  try {
    const w1 = ensureWorkspace(f.ctx, { dispatch: 'D-1', base: f.base }).path;
    sh(w1, 'update-index', '--assume-unchanged', 'src/a.txt', 'docs/out.txt');
    write(w1, 'src/a.txt', 'changed\n');
    write(w1, 'docs/out.txt', 'forbidden\n');
    const out = await collect(f, 'D-1', ['src/**']);
    assert.deepEqual(out.kind === 'outside-write-paths' && out.paths, ['docs/out.txt']);
    write(w1, 'docs/out.txt', 'outside\n');
    const inside = await collect(f, 'D-1', ['src/**']);
    assert.equal(inside.kind === 'candidate' && f.git('show', `${inside.commit}:src/a.txt`), 'changed');
    // skip-worktree with the file gone: a deletion cannot be told from a hidden path.
    const w2 = ensureWorkspace(f.ctx, { dispatch: 'D-2', base: f.base }).path;
    sh(w2, 'update-index', '--skip-worktree', 'src/a.txt');
    unlinkSync(join(w2, 'src', 'a.txt'));
    const hidden = await collect(f, 'D-2', ['src/**']);
    assert.deepEqual(hidden.kind === 'rejected' && [hidden.rejection.code, hidden.rejection.paths], ['hidden-entries', ['src/a.txt']]);
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    g.git('update-index', '--add', '--cacheinfo', `160000,${g.base},sub`);
    g.git('commit', '-qm', 'a submodule');
    const base = g.git('rev-parse', 'HEAD');
    const next = commitOn(g.dir, g.base, { 'new.txt': 'next\n' });
    const w = ensureWorkspace(g.ctx, { dispatch: 'D-1', base }).path;
    sh(w, 'update-index', '--cacheinfo', `160000,${next},sub`);
    sh(w, 'commit', '-qm', 'move the submodule');
    const outside = await collect(g, 'D-1', ['src/**'], base);
    assert.deepEqual(outside.kind === 'outside-write-paths' && outside.paths, ['sub']);
    const inside = await collect(g, 'D-1', ['**'], base);
    assert.deepEqual(inside.kind === 'rejected' && [inside.rejection.code, inside.rejection.paths], ['gitlink-modified', ['sub']]);
  } finally {
    g.cleanup();
  }
});

test('#5 with core.filemode=false the executable bit the seat committed is kept', async () => {
  const f = fixture({ files: { 'src/a.txt': 'base\n' } });
  try {
    f.git('config', 'core.filemode', 'false');
    const w = ensureWorkspace(f.ctx, { dispatch: 'D-1', base: f.base }).path;
    sh(w, 'update-index', '--chmod=+x', 'src/a.txt');
    sh(w, 'commit', '-qm', 'make it executable');
    const c = await collect(f, 'D-1', ['src/**']);
    assert.equal(c.kind, 'candidate');
    if (c.kind !== 'candidate') return;
    assert.equal(f.git('ls-tree', c.commit, 'src/a.txt').split(' ')[0], '100755');
    assert.deepEqual([c.empty, c.modeChanged], [false, ['src/a.txt']]);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------- #4

test('#4 removing one dispatch worktree never prunes another worktree’s registration or index', async () => {
  const f = fixture();
  try {
    const outside = join(f.dir, 'external');
    f.git('worktree', 'add', '-q', '-b', 'external', outside);
    write(outside, 'file.txt', 'staged only\n');
    sh(outside, 'add', 'file.txt');
    const index = sh(outside, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const gitdir = join(index.slice(0, -'index'.length), 'gitdir');
    renameSync(outside, join(f.dir, 'external-moved'));
    utimesSync(gitdir, new Date(0), new Date(0));
    ensureWorkspace(f.ctx, { dispatch: 'D-1', base: f.base });
    removeWorkspace(f.ctx, 'D-1');
    assert.ok(existsSync(index), 'the other worktree’s index is still there');
    assert.ok(!f.git('worktree', 'list', '--porcelain').includes('D-1'));
    // A registration of ours whose directory vanished: only its own administrative directory goes.
    const w2 = ensureWorkspace(f.ctx, { dispatch: 'D-2', base: f.base }).path;
    rmSync(w2, { recursive: true, force: true });
    removeWorkspace(f.ctx, 'D-2');
    assert.ok(!f.git('worktree', 'list', '--porcelain').includes('D-2'));
    assert.ok(existsSync(index));
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------- #6

test('#6 a landing judges "clean" and "matches D" on the actual files: hidden changes refuse it; files that differ from D are never "consistent"', async () => {
  const f = fixture();
  try {
    const D = commitOn(f.dir, f.base, { 'new.txt': 'delivery\n' });
    recordedDelivery(f, 'd1', D, f.base, 'main');
    f.git('update-index', '--assume-unchanged', 'file.txt');
    write(f.dir, 'file.txt', 'uncommitted and hidden\n');
    const r = await land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m) });
    assert.deepEqual(r.kind === 'not-landed' && [r.wi, r.reason, r.paths], ['WI-02', 'dirty', ['file.txt']]);
    assert.equal(f.git('rev-parse', 'main'), f.base);
  } finally {
    f.cleanup();
  }
  const g = fixture({ files: { '.gitattributes': '*.txt text eol=lf\n', 'src/a.txt': 'a\n' } });
  try {
    const D = commitOn(g.dir, g.base, { '.gitattributes': '*.txt text eol=crlf\n' });
    recordedDelivery(g, 'd1', D, g.base, 'main');
    const co = await checkoutCommit(g.ctx, { commit: D, dir: runCheckoutDir(g.m.paths, 'check-1') });
    assert.equal(readFileSync(join(co.dir, 'src', 'a.txt'), 'utf8'), 'a\r\n');
    const r = await land(g.ctx, { mission: M, delivery: 'd1', words: words(g.m) });
    assert.equal(r.kind, 'landed');
    if (r.kind !== 'landed') return;
    assert.equal(readFileSync(join(g.dir, 'src', 'a.txt'), 'utf8'), 'a\n', 'git did not rewrite the file');
    assert.equal(r.worktree?.relation, 'cannot-determine');
    assert.ok(r.worktree?.differing.includes('src/a.txt'));
    const alerts = g.m.stmt("SELECT record FROM log WHERE kind = 'alert'").all() as Array<{ record: string }>;
    assert.ok(alerts.some((a) => a.record.includes('"WI-04"')));
  } finally {
    g.cleanup();
  }
});

// ---------------------------------------------------------------- #7

test('#7 a capability stop reaches deliveries and landings: derived from the mission’s dispatches, conservative when unknown, persisted in the intent', async () => {
  const f = fixture({ files: { 'src/a.txt': 'base\n' } });
  try {
    await product(f, 'o1');
    const d = await deliver(f.ctx, request('d1'), { labels: labels(f) });
    assert.equal(d.kind, 'delivered');
    // No dispatch recorded for the mission: the provenance is unknown, any capability stop covers it.
    f.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-1'), scope: { kind: 'capability', capability: 'construct' }, words: 'stop construction', at: 1 }));
    await rejectsCode(deliver(f.ctx, request('d2'), { labels: labels(f) }), 'STOPPED');
    await rejectsCode(land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m) }), 'STOPPED');
  } finally {
    f.cleanup();
  }
  const g = fixture({ files: { 'src/a.txt': 'base\n' } });
  try {
    await product(g, 'o1');
    g.m.write({ op: 'claim-1', payload: 1 }, (tx) => {
      queueTask(tx, { task: 'T1', lineage: 'L1', mission: M, card: tx.data.put('card') });
      return claimDispatch(tx, { dispatch: 'D-1', task: 'T1', seat: 'constructor', capabilities: ['net'] });
    });
    // A stop on a capability no dispatch of the mission has does not cover it; one it has does.
    g.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-gpu'), scope: { kind: 'capability', capability: 'gpu' }, words: 'no gpu', at: 1 }));
    const d = await deliver(g.ctx, request('d1'), { labels: labels(g) });
    assert.equal(d.kind, 'delivered');
    const dref = g.m.read((db) => intentInfo(db, 'dref:m1:d1:1'));
    assert.deepEqual(dref?.tag.capabilities, ['net'], 'the scope is persisted with the intent');
    g.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-net'), scope: { kind: 'capability', capability: 'net' }, words: 'no network', at: 2 }));
    await rejectsCode(land(g.ctx, { mission: M, delivery: 'd1', words: words(g.m) }), 'STOPPED');
    await rejectsCode(deliver(g.ctx, request('d2'), { labels: labels(g) }), 'STOPPED');
  } finally {
    g.cleanup();
  }
});

// ---------------------------------------------------------------- #8

test('#8 the final authorization re-checks the labels: recomputing waits; a label input committed meanwhile reopens them and checks again', { skip: !POSIX }, async () => {
  const f = fixture({ files: { 'src/a.txt': 'base\n' } });
  try {
    await product(f, 'o1');
    let frontier = false;
    const r = await deliver(f.ctx, request('d1'), {
      labels: labels(f, { recomputingIn: () => frontier }),
      fullRun: () => {
        frontier = true;
        return { line: 'never run', status: null };
      },
    });
    assert.deepEqual(r, { kind: 'recomputing' });
    assert.equal(deliveryInfo(f.m, M, 'd1'), null);
    assert.equal(f.m.read((db) => openIntents(db)).length, 0);
    assert.throws(() => f.git('rev-parse', '--verify', 'refs/mission-pipeline/delivered/m1/d1'));
    // An evaluator input while the checks run: the labels are opened again, the proof check redone.
    let runs = 0;
    let opened = 0;
    const second: DeliveryResult = await deliver(f.ctx, request('d2'), {
      labels: () => {
        opened++;
        return labels(f);
      },
      fullRun: async () => {
        // an evaluator input committed after the proof check, before the authorization
        if (runs++ === 0) await product(f, 'o9', M, { 'src/z.txt': 'z\n' });
        return { line: 'never run', status: null };
      },
    });
    assert.equal(second.kind, 'delivered');
    assert.deepEqual([runs, opened], [2, 2]);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------- #9

test('#9 detaching a duplicate checkout is refused while git writes are held, and without the memory', async () => {
  const f = fixture();
  try {
    const dup = join(f.dir, 'dup');
    f.git('worktree', 'add', '-q', '--force', dup, 'main');
    holdGitWrites(f.m);
    await rejectsCode(detachDuplicateCheckout(f.ctx, { repoPath: f.dir, worktree: dup, targetBranch: 'main' }), 'GIT_WRITES_HELD');
    assert.equal((await detachDuplicateCheckout(f.ctx.git, { repoPath: f.dir, worktree: dup, targetBranch: 'main' })).kind, 'refused');
    assert.equal(sh(dup, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
    f.m.connection.prepare("DELETE FROM meta WHERE key = 'git_hold'").run();
    assert.equal((await detachDuplicateCheckout(f.ctx, { repoPath: f.dir, worktree: dup, targetBranch: 'main' })).kind, 'detached');
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------- #10

test('#10 the Windows branch of the async runner ends on time although a descendant keeps the pipes open', { skip: !POSIX }, async () => {
  const dir = tempDir('mp-timeout-');
  try {
    const script = join(dir, 'slow.sh');
    writeFileSync(script, '#!/bin/sh\nsleep 3\ntrue\n');
    chmodSync(script, 0o755);
    for (const platform of ['win32', 'linux'] as const) {
      const began = Date.now();
      await assert.rejects(PlainGit.create({ gitPath: script, timeoutMs: 100, platform }).run([], { cwd: dir }), GitTimeoutError);
      assert.ok(Date.now() - began < 1500, `${platform}: ended after ${Date.now() - began} ms`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#10b the synchronous runner (the landing\u2019s git step) returns when git exits: a descendant holding its output neither delays it nor makes it a timeout', { skip: !POSIX }, () => {
  const dir = tempDir('mp-timeout-');
  try {
    const slow = join(dir, 'slow.sh');
    writeFileSync(slow, '#!/bin/sh\nsleep 3\ntrue\n');
    const detach = join(dir, 'detach.sh');
    writeFileSync(detach, '#!/bin/sh\nsleep 3 &\necho done\nexit 0\n');
    chmodSync(slow, 0o755);
    chmodSync(detach, 0o755);
    for (const platform of ['win32', 'linux'] as const) {
      let began = Date.now();
      assert.throws(() => PlainGit.create({ gitPath: slow, timeoutMs: 100, platform }).runSync([], { cwd: dir }), GitTimeoutError);
      assert.ok(Date.now() - began < 1500, `${platform}: the deadline ended it after ${Date.now() - began} ms`);
      began = Date.now();
      const r = PlainGit.create({ gitPath: detach, timeoutMs: 1000, platform }).runSync([], { cwd: dir });
      assert.deepEqual([r.code, r.stdout.toString('utf8')], [0, 'done\n']);
      assert.ok(Date.now() - began < 900, `${platform}: returned after ${Date.now() - began} ms, not when its descendant ended`);
      const memory = PlainGit.create({ gitPath: detach, timeoutMs: 1000, platform }).runner()([], { cwd: dir, input: 'x' });
      assert.equal(memory.code, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- #11

test('#11 on Windows "native" and an unset core.eol mean CRLF: the description says so and a checkout writes CRLF', async () => {
  const f = fixture({ files: { '.gitattributes': '*.txt text\n', 'src/a.txt': 'a\n' } });
  try {
    const repo = await discoverRepo(f.ctx.git, f.dir);
    const linux = await readTransformDescription(f.ctx.git, repo, f.dir, undefined, 'linux');
    const windows = await readTransformDescription(f.ctx.git, repo, f.dir, undefined, 'win32');
    assert.equal(linux.nativeEol, undefined);
    assert.equal(windows.nativeEol, 'crlf');
    assert.notEqual(transformDescriptionHash(linux), transformDescriptionHash(windows));
    const text = { text: { kind: 'set' }, crlf: { kind: 'unspecified' }, eol: { kind: 'unspecified' }, ident: { kind: 'unspecified' }, filter: { kind: 'unspecified' }, workingTreeEncoding: { kind: 'unspecified' } } as const;
    assert.equal(resolveConversion(text, { ...linux, autocrlf: 'false', eol: 'native' }).crlf, 'text-input');
    assert.equal(resolveConversion(text, { ...windows, autocrlf: 'false', eol: 'native' }).crlf, 'text-crlf');
    assert.equal(resolveConversion(text, { ...windows, autocrlf: 'false', eol: 'unset' }).crlf, 'text-crlf');
    assert.equal(resolveConversion(text, { ...windows, autocrlf: 'input', eol: 'unset' }).crlf, 'text-input');
    const co = await checkoutCommit(f.ctx, { commit: f.base, dir: runCheckoutDir(f.m.paths, 'win-1'), description: { ...windows, autocrlf: 'false', eol: 'unset' } });
    assert.equal(readFileSync(join(co.dir, 'src', 'a.txt'), 'utf8'), 'a\r\n');
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------- #12

test('#12 names that fold together on a case- or normalization-insensitive filesystem are refused, never overwritten', async () => {
  assert.deepEqual(nameCollisions(['A.txt', 'a.txt', 'b.txt'], { case: true, normalization: false }), [['A.txt', 'a.txt']]);
  assert.deepEqual(nameCollisions(['A.txt', 'a.txt'], { case: false, normalization: false }), []);
  assert.deepEqual(nameCollisions(['café.txt', 'café.txt'], { case: false, normalization: true }).length, 1);
  assert.deepEqual(nameCollisions(['a', 'A/x'], { case: true, normalization: false }), [['A/', 'a']]);
  assert.deepEqual(nameCollisions(['Src/a', 'src/b'], { case: true, normalization: true }), [], 'directories merge; no file is lost');
  const f = fixture();
  try {
    const C = commitOn(f.dir, f.base, { 'A.txt': 'upper\n', 'a.txt': 'lower\n' });
    const repo = await discoverRepo(f.ctx.git, f.dir);
    const scratch = tempDir('mp-attr-');
    const attributes = await AttributeEvaluator.create(f.ctx.git, repo, await readTransformDescription(f.ctx.git, repo, f.dir), scratch);
    try {
      await assert.rejects(
        materializeSnapshot({ git: f.ctx.git, repo, commit: C, attributes, dest: join(scratch, 'out'), folding: { case: true, normalization: true } }),
        (e: unknown) => e instanceof RepresentationError && e.code === 'path-collision' && e.paths.includes('A.txt') && e.paths.includes('a.txt'),
      );
      // On this (case-sensitive) filesystem the probe finds no folding: both files are written.
      const ok = await materializeSnapshot({ git: f.ctx.git, repo, commit: C, attributes, dest: join(scratch, 'out2') });
      assert.equal(ok.entries.length, 3);
    } finally {
      attributes.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------- round 2

test('r2 #1 a capability stop committed while the landing checks the worktree is seen in the authorizing write, for a new landing and a retry', async () => {
  for (const retry of [false, true]) {
    const f = fixture();
    try {
      const D = commitOn(f.dir, f.base, { 'new.txt': 'delivery\n' });
      recordedDelivery(f, 'd1', D, f.base, 'main');
      const w = words(f.m);
      if (retry) await assert.rejects(land(f.ctx, { mission: M, delivery: 'd1', words: w }, { beforeGit: () => { throw new Error('leave the intent open'); } }), /leave the intent open/);
      const git = f.ctx.git;
      const run = git.run.bind(git);
      let fired = false;
      git.run = async (args, opts) => {
        const r = await run(args, opts);
        if (!fired && args[0] === 'rev-parse' && args.includes('--git-dir')) {
          fired = true;
          f.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-gpu'), scope: { kind: 'capability', capability: 'gpu' }, words: 'no gpu', at: 1 }));
        }
        return r;
      };
      await rejectsCode(land(f.ctx, { mission: M, delivery: 'd1', words: w }), 'STOPPED');
      assert.equal(fired, true);
      assert.equal(f.git('rev-parse', 'main'), f.base, retry ? 'retry' : 'new landing');
    } finally {
      f.cleanup();
    }
  }
});

test('r2 #2 a ref already at D is recorded under a stop and the git-writes hold: the delivery ref, and a landing', async () => {
  const f = fixture({ files: { 'src/a.txt': 'base\n' } });
  try {
    await product(f, 'o1');
    await assert.rejects(deliver(f.ctx, request('d1'), { labels: labels(f), hooks: { afterRef: () => { throw new Error('crash after the ref'); } } }), /crash after the ref/);
    f.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-all'), scope: { kind: 'all' }, words: 'stop everything', at: 1 }));
    holdGitWrites(f.m);
    const r = await deliver(f.ctx, request('d1'), { labels: labels(f) });
    assert.equal(r.kind === 'delivered' && r.recovered, true, JSON.stringify(r));
    assert.equal(deliveryInfo(f.m, M, 'd1')?.state, 'recorded');
    assert.equal(f.m.read((db) => openIntents(db)).length, 0);
    // A new delivery is refused under the same stop and hold.
    await rejectsCode(deliver(f.ctx, request('d2'), { labels: labels(f) }), 'STOPPED');
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    const D = commitOn(g.dir, g.base, { 'new.txt': 'delivery\n' });
    g.git('branch', 'release', g.base);
    recordedDelivery(g, 'd1', D, g.base, 'release');
    const w = words(g.m);
    await assert.rejects(land(g.ctx, { mission: M, delivery: 'd1', words: w }, { afterGit: () => { throw new Error('killed after git'); } }), /killed after git/);
    g.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-all'), scope: { kind: 'all' }, words: 'stop everything', at: 1 }));
    holdGitWrites(g.m);
    const r = await land(g.ctx, { mission: M, delivery: 'd1', words: w });
    assert.equal(r.kind === 'landed' && [r.via, r.startedBeforeStop].join(), ['found', true].join());
  } finally {
    g.cleanup();
  }
});

test('r2 #3 a stop on the source mission of a delivered object covers the delivery and its landing', async () => {
  const f = fixture({ files: { 'src/a.txt': 'base\n' } });
  try {
    await product(f, 'o1', 'm2');
    f.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-m3'), scope: { kind: 'mission', mission: 'm3' as typeof M }, words: 'stop m3', at: 1 }));
    const d = await deliver(f.ctx, request('d1'), { labels: labels(f) });
    assert.equal(d.kind, 'delivered', 'a stop on an unrelated mission does not cover it');
    f.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-m2'), scope: { kind: 'mission', mission: 'm2' as typeof M }, words: 'stop m2', at: 2 }));
    await rejectsCode(deliver(f.ctx, request('d2'), { labels: labels(f) }), 'STOPPED');
    await rejectsCode(land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m) }), 'STOPPED');
    assert.equal(f.git('rev-parse', 'main'), f.base);
  } finally {
    f.cleanup();
  }
});

test('r2 #4 a submodule checked out at another commit than its gitlink is not "match", not clean, and not "consistent"', async () => {
  const f = fixture();
  try {
    f.git('update-index', '--add', '--cacheinfo', `160000,${f.base},sub`);
    f.git('commit', '-qm', 'gitlink');
    const B = f.git('rev-parse', 'HEAD');
    // Not checked out: as a clean checkout has it.
    assert.deepEqual(await compareToCommit(f.ctx, f.dir, B), { state: 'match' });
    const next = commitOn(f.dir, f.base, { 'file.txt': 'another child commit\n' });
    f.git('update-ref', 'refs/heads/aux', next);
    const sub = join(f.dir, 'sub');
    f.git('clone', '-q', '--no-hardlinks', '--no-checkout', f.dir, sub);
    sh(sub, 'checkout', '-q', '--detach', next);
    const cmp = await compareToCommit(f.ctx, f.dir, B);
    assert.deepEqual(cmp.state === 'differs' && cmp.files, ['sub']);
    const D = commitOn(f.dir, B, { 'new.txt': 'delivery\n' });
    recordedDelivery(f, 'd1', D, B, 'main');
    const r = await land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m) });
    assert.deepEqual(r.kind === 'not-landed' && [r.wi, r.reason, r.paths], ['WI-02', 'dirty', ['sub']]);
    // At the gitlink's commit it matches.
    sh(sub, 'checkout', '-q', '--detach', f.base);
    assert.deepEqual(await compareToCommit(f.ctx, f.dir, B), { state: 'match' });
  } finally {
    f.cleanup();
  }
});

test('r2 #5 with core.symlinks=false the link type the seat recorded is kept: a new link, and a link turned into a file', async () => {
  const f = fixture();
  try {
    // A base with a link.
    const blob = sh(f.dir, 'hash-object', '-w', 'file.txt');
    f.git('update-index', '--add', '--cacheinfo', `120000,${blob},src/old-link`);
    f.git('commit', '-qm', 'a link');
    const base = f.git('rev-parse', 'HEAD');
    f.git('config', 'core.symlinks', 'false');
    f.git('config', 'core.filemode', 'false');
    const w = ensureWorkspace(f.ctx, { dispatch: 'D-1', base }).path;
    write(w, 'src/link', '../file.txt');
    const oid = sh(w, 'hash-object', '-w', 'src/link');
    sh(w, 'update-index', '--add', '--cacheinfo', `120000,${oid},src/link`);
    write(w, 'src/old-link', 'now a plain file\n');
    const fileOid = sh(w, 'hash-object', '-w', 'src/old-link');
    sh(w, 'update-index', '--cacheinfo', `100644,${fileOid},src/old-link`);
    sh(w, 'commit', '-qm', 'a new link; the old link becomes a file');
    const c = await collectCandidate(f.ctx, { dispatch: 'D-1', base, writePaths: ['src/**'], message: 'candidate\n', author: IDENT, committer: IDENT });
    assert.equal(c.kind, 'candidate', JSON.stringify(c));
    if (c.kind !== 'candidate') return;
    assert.equal(f.git('ls-tree', c.commit, 'src/link').split(' ')[0], '120000');
    assert.equal(f.git('show', `${c.commit}:src/link`), '../file.txt');
    assert.equal(f.git('ls-tree', c.commit, 'src/old-link').split(' ')[0], '100644');
    assert.equal(f.git('show', `${c.commit}:src/old-link`), 'now a plain file');
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------- round 3

/** A repository whose commit B has a gitlink `sub` at f.base, checked out (a clone) at that commit. */
function withSubmodule(f: Fixture): { B: string; sub: string } {
  f.git('update-index', '--add', '--cacheinfo', `160000,${f.base},sub`);
  f.git('commit', '-qm', 'gitlink');
  const B = f.git('rev-parse', 'HEAD');
  const sub = join(f.dir, 'sub');
  f.git('clone', '-q', '--no-hardlinks', '--no-checkout', f.dir, sub);
  sh(sub, 'checkout', '-q', '--detach', f.base);
  return { B, sub };
}

test('r3 #1 a submodule’s changes hidden by assume-unchanged or skip-worktree are found on its content', async () => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const f = fixture();
    try {
      const { B, sub } = withSubmodule(f);
      assert.deepEqual(await compareToCommit(f.ctx, f.dir, B), { state: 'match' });
      sh(sub, 'update-index', flag, 'file.txt');
      write(sub, 'file.txt', 'DIRTY HIDDEN CONTENT\n');
      assert.equal(sh(sub, 'status', '--porcelain', '--untracked-files=no'), '', `${flag}: git status sees nothing`);
      const cmp = await compareToCommit(f.ctx, f.dir, B);
      assert.deepEqual(cmp.state === 'differs' && cmp.files, ['sub'], flag);
      const D = commitOn(f.dir, B, { 'new.txt': 'delivery\n' });
      recordedDelivery(f, 'd1', D, B, 'main');
      const r = await land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m) });
      assert.deepEqual(r.kind === 'not-landed' && [r.reason, r.paths], ['dirty', ['sub']], flag);
    } finally {
      f.cleanup();
    }
  }
});

test('r3 #2 a path or submodule that cannot be read is "undetermined", never "match"', { skip: !POSIX || process.getuid?.() === 0 }, async () => {
  const f = fixture({ files: { 'src/a.txt': 'a\n' } });
  const locked: string[] = [];
  try {
    const { B, sub } = withSubmodule(f);
    write(sub, 'file.txt', 'dirty contents\n');
    chmodSync(sub, 0);
    locked.push(sub);
    const cmp = await compareToCommit(f.ctx, f.dir, B);
    assert.equal(cmp.state, 'undetermined', JSON.stringify(cmp));
    const D = commitOn(f.dir, B, { 'new.txt': 'delivery\n' });
    recordedDelivery(f, 'd1', D, B, 'main');
    const r = await land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m) });
    assert.deepEqual(r.kind === 'not-landed' && [r.wi, r.reason], ['WI-02', 'undetermined']);
    chmodSync(sub, 0o755);
    locked.pop();
    // An unreadable directory in the worktree itself.
    const src = join(f.dir, 'src');
    chmodSync(src, 0);
    locked.push(src);
    const cmp2 = await compareToCommit(f.ctx, f.dir, B);
    assert.equal(cmp2.state, 'undetermined', JSON.stringify(cmp2));
  } finally {
    for (const p of locked) chmodSync(p, 0o755);
    f.cleanup();
  }
});

test('r3 #3 with core.symlinks=false an untracked plain file where the base had a link is collected as a file, as git add records it', async () => {
  const f = fixture();
  try {
    const blob = sh(f.dir, 'hash-object', '-w', 'file.txt');
    f.git('update-index', '--add', '--cacheinfo', `120000,${blob},src/old-link`);
    f.git('commit', '-qm', 'a link');
    const B = f.git('rev-parse', 'HEAD');
    f.git('config', 'core.symlinks', 'false');
    f.git('config', 'core.filemode', 'false');
    const w = ensureWorkspace(f.ctx, { dispatch: 'D-1', base: B }).path;
    sh(w, 'rm', '-q', '--cached', 'src/old-link');
    sh(w, 'commit', '-qm', 'remove the recorded link');
    write(w, 'src/old-link', 'now a normal untracked file\n');
    const c = await collectCandidate(f.ctx, { dispatch: 'D-1', base: B, writePaths: ['src/**'], message: 'candidate\n', author: IDENT, committer: IDENT });
    assert.equal(c.kind, 'candidate', JSON.stringify(c));
    if (c.kind !== 'candidate') return;
    assert.equal(f.git('ls-tree', c.commit, 'src/old-link').split(' ')[0], '100644');
    sh(w, 'add', 'src/old-link');
    assert.equal(sh(w, 'ls-files', '--stage', 'src/old-link').split(' ')[0], '100644', 'what git add records');
  } finally {
    f.cleanup();
  }
});

test('r3 #4 every phase of an attempt keeps the scope it was authorized with: "started before the stop" after a widened retry', async () => {
  const f = fixture();
  try {
    const claim = (n: number, cap: string): void => {
      f.m.write({}, (tx) => {
        queueTask(tx, { task: `T${n}`, lineage: `L${n}`, mission: M, card: tx.data.put('card') });
        claimDispatch(tx, { dispatch: `D-${n}`, task: `T${n}`, seat: 'constructor', capabilities: [cap] });
      });
    };
    claim(1, 'net');
    const D = commitOn(f.dir, f.base, { 'new.txt': 'delivery\n' });
    f.git('branch', 'release', f.base);
    recordedDelivery(f, 'd1', D, f.base, 'release');
    const w = words(f.m);
    const crash = () => assert.rejects(land(f.ctx, { mission: M, delivery: 'd1', words: w }, { beforeGit: () => { throw new Error('pending'); } }), /pending/);
    await crash();
    claim(2, 'gpu');
    await crash();
    await recoverLandings(f.ctx); // records the verify phase of attempt 2
    const verify = JSON.parse(f.m.data.text(f.m.read((db) => landingState(db, 'land:m1:d1:1.a2'))!.data)) as { scope?: { capabilities: string[] } };
    assert.deepEqual(verify.scope?.capabilities, ['gpu', 'net']);
    f.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-gpu'), scope: { kind: 'capability', capability: 'gpu' }, words: 'no gpu', at: 1 }));
    f.git('update-ref', 'refs/heads/release', D, f.base);
    const rec = await recoverLandings(f.ctx);
    const r = rec.kind === 'checked' ? rec.results[0] : undefined;
    assert.equal(r?.kind === 'landed' && r.startedBeforeStop, true, JSON.stringify(r));
  } finally {
    f.cleanup();
  }
});

test('r3 #5 with no open intent, a branch already at D is recorded before the git-writes hold or a stop is checked', async () => {
  for (const blocker of ['hold', 'stop'] as const) {
    const f = fixture();
    try {
      const D = commitOn(f.dir, f.base, { 'new.txt': 'delivery\n' });
      f.git('branch', 'release', D);
      recordedDelivery(f, 'd1', D, f.base, 'release');
      const w = words(f.m);
      if (blocker === 'hold') holdGitWrites(f.m);
      else f.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-all'), scope: { kind: 'all' }, words: 'stop', at: 1 }));
      const r = await land(f.ctx, { mission: M, delivery: 'd1', words: w });
      assert.equal(r.kind === 'landed' && r.via, 'found', `${blocker}: ${JSON.stringify(r)}`);
      if (r.kind !== 'landed') return;
      assert.match(r.intent, /\.found$/);
      assert.equal(f.m.read((db) => landingState(db, r.intent))?.phase, 'done');
      assert.equal(f.m.read((db) => openIntents(db)).length, 0);
      // A branch not at D is still refused.
      const D2 = commitOn(f.dir, f.base, { 'other.txt': 'x\n' });
      f.git('branch', 'other', f.base);
      recordedDelivery(f, 'd2', D2, f.base, 'other');
      await rejectsCode(land(f.ctx, { mission: M, delivery: 'd2', words: w }), blocker === 'hold' ? 'GIT_WRITES_HELD' : 'STOPPED');
    } finally {
      f.cleanup();
    }
  }
});

// ---------------------------------------------------------------- round 4

test('r4 a branch found at D under a stop or the hold: the same request is idempotent; a new consent gets its own record and operation', async () => {
  for (const blocker of ['hold', 'stop'] as const) {
    const f = fixture();
    try {
      const D = commitOn(f.dir, f.base, { 'new.txt': 'delivery\n' });
      f.git('branch', 'release', D);
      recordedDelivery(f, 'd1', D, f.base, 'release');
      const w1 = words(f.m);
      if (blocker === 'hold') holdGitWrites(f.m);
      else f.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-all'), scope: { kind: 'all' }, words: 'stop', at: 1 }));
      const r1 = await land(f.ctx, { mission: M, delivery: 'd1', words: w1 });
      assert.equal(r1.kind === 'landed' && r1.via, 'found');
      const head = f.m.head();
      const again = await land(f.ctx, { mission: M, delivery: 'd1', words: w1 });
      assert.equal(again.kind === 'landed' && again.intent, r1.kind === 'landed' ? r1.intent : '');
      assert.equal(f.m.head(), head, `${blocker}: the same request records nothing new`);
      const w2 = words(f.m, 'deliver it again');
      const r2 = await land(f.ctx, { mission: M, delivery: 'd1', words: w2 });
      assert.equal(r2.kind === 'landed' && r2.via, 'found', `${blocker}: ${JSON.stringify(r2)}`);
      assert.notEqual(r2.kind === 'landed' && r2.intent, r1.kind === 'landed' && r1.intent);
      const rec = JSON.parse(f.m.data.text(f.m.read((db) => landingState(db, r2.kind === 'landed' ? r2.intent : ''))!.data)) as { words: string };
      assert.equal(rec.words, w2);
    } finally {
      f.cleanup();
    }
  }
});
