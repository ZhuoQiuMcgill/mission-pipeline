// Delivery and landing behaviours whose 4.0 tests went with the 4.0 code
// (package A6's review), at the deliver() / land() level, plus WI-03 at a
// delivery and a landing and the landing-attempt count (WI-08).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { id, type ObjectVersionId, type StopId } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';
import { deliver, rebuildDelivery, type DeliverRequest, type DeliveryResult } from '../src/delivery/delivery.ts';
import type { LabelView } from '../src/delivery/memoryView.ts';
import { writeScopeDocument } from '../src/delivery/writeScope.ts';
import { land, landingLineage, recoverLandings, type LandingResult } from '../src/git/land.ts';
import { discoverRepo, lsTree } from '../src/git/objects.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { detachDuplicateCheckout } from '../src/git/pmActions.ts';
import { readTransformDescription, transformDescriptionHash } from '../src/git/representation.ts';
import { ensureWorkspace } from '../src/git/workspace.ts';
import { appendRecords, commitStop, currentDelivery, deliveryInfo, initMemory, loopState, openIntents, openMemory, recordDelivery, withdrawDelivery } from '../src/memory/index.ts';
import { commitOn, fixture, IDENT, M, recordedDelivery, rejectsCode, sh, words, write, type Fixture } from './git41-fixtures.ts';
import { tempDir } from './memory-fixtures.ts';

const POSIX = process.platform !== 'win32';

// ---------------------------------------------------------------- helpers

async function product(f: Fixture, object: string, files: Record<string, string> = { 'src/a.txt': 'A1\n' }, opts: { commit?: string; mission?: string; source?: boolean } = {}): Promise<string> {
  const commit = opts.commit ?? commitOn(f.dir, f.git('rev-parse', 'main'), files, `product ${object}`);
  const repo = await discoverRepo(f.ctx.git, f.dir);
  const transform = transformDescriptionHash(await readTransformDescription(f.ctx.git, repo, f.dir));
  const scopeDoc = writeScopeDocument(await lsTree(f.ctx.git, repo, commit, { recursive: true }), ['src/**']);
  f.m.write({}, (tx) => {
    const rec = {
      kind: 'object.version',
      object,
      objectKind: 'product',
      mission: opts.mission ?? M,
      module: `mod-${object}`,
      content: tx.data.put(scopeDoc),
      prerequisites: tx.data.putList([]),
      scope: { paths: Object.keys(files), taskType: 'construct' },
      reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
      ...(opts.source === false ? {} : { source: { commit, writeScope: ['src/**'], transform } }),
    } as unknown as BaseRecord;
    appendRecords(tx, [rec]);
  });
  return commit;
}

function labels(f: Fixture): LabelView {
  return { revision: f.m.head(), recomputing: false, labelOf: () => 'proven', decidingRuns: () => [], recomputingIn: () => false };
}

function request(op: string, over: Partial<DeliverRequest> = {}): DeliverRequest {
  return { mission: M, delivery: op, targetBranch: 'main', selected: [{ kind: 'object', id: 'o1' as ObjectVersionId }], closingChecks: [], author: IDENT, committer: IDENT, ...over };
}

function delivered(r: DeliveryResult): Extract<DeliveryResult, { kind: 'delivered' }> {
  assert.equal(r.kind, 'delivered', JSON.stringify(r).slice(0, 600));
  return r as Extract<DeliveryResult, { kind: 'delivered' }>;
}

function landed(r: LandingResult): Extract<LandingResult, { kind: 'landed' }> {
  assert.equal(r.kind, 'landed', JSON.stringify(r).slice(0, 600));
  return r as Extract<LandingResult, { kind: 'landed' }>;
}

function alerts(f: Fixture, wi: string): string[] {
  return (f.m.stmt("SELECT record FROM log WHERE kind = 'alert'").all() as Array<{ record: string }>).map((r) => r.record).filter((r) => r.includes(`"${wi}"`));
}

function alertBodies(f: Fixture, wi: string): Array<{ trigger: string; facts: Record<string, unknown> }> {
  return alerts(f, wi).map((r) => JSON.parse(f.m.data.text((JSON.parse(r) as { body: string }).body)));
}

function advance(f: Fixture, name: string, files?: Record<string, string>): string {
  const c = commitOn(f.dir, f.git('rev-parse', 'main'), files ?? { [`other/${name}.txt`]: `${name}\n` });
  f.git('merge', '-q', '--ff-only', c);
  return c;
}

/** A lock that makes git's create-only update of the delivery ref fail. */
function refLock(f: Fixture, op: string): string {
  const lock = join(f.dir, '.git', 'refs', 'mission-pipeline', 'delivered', M, `${op}.lock`);
  mkdirSync(join(lock, '..'), { recursive: true });
  return lock;
}

/** A commit on `parent` whose entries carry modes: { path: [mode, content] } (content of a link: its target), null deletes. */
function commitWithModes(repo: string, parent: string, entries: Record<string, readonly [string, string] | null>): string {
  const idx = join(tempDir('mp-idx-'), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: idx, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['read-tree', parent], { cwd: repo, env });
  for (const [path, e] of Object.entries(entries)) {
    if (e === null) {
      execFileSync('git', ['update-index', '--force-remove', '--', path], { cwd: repo, env });
      continue;
    }
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, env, input: e[1], encoding: 'utf8' }).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `${e[0]},${blob},${path}`], { cwd: repo, env });
  }
  const tree = execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' }).trim();
  return execFileSync('git', ['commit-tree', tree, '-p', parent, '-m', 'modes'], { cwd: repo, env, encoding: 'utf8' }).trim();
}

/** A linked worktree on `branch` (created at main's tip), outside the project folder. */
function linkedWorktree(f: Fixture, branch: string): { root: string; gitDir: string } {
  const root = join(tempDir('mp-wt-'), branch);
  f.git('worktree', 'add', '-q', '-b', branch, root, 'main');
  return { root, gitDir: sh(root, 'rev-parse', '--absolute-git-dir') };
}

// ---------------------------------------------------------------- delivery

test('a selected module touched by a user commit on the target is delivered as not fully proven, with WI-07', async () => {
  const f = fixture({ files: { 'src/a.txt': 'a\n' } });
  try {
    await product(f, 'o1');
    advance(f, 'user', { 'src/user.txt': 'a user commit inside the write scope\n' });
    const r = delivered(await deliver(f.ctx, request('d1'), { labels: labels(f) }));
    assert.deepEqual(r.record.proof?.proven, []);
    assert.deepEqual(r.record.proof?.notFullyProven.map((n) => [n.id, n.reasons.map((x) => x.kind)]), [['o1', ['content-changed']]]);
    assert.equal(f.git('show', `${r.record.commit}:src/user.txt`), 'a user commit inside the write scope');
    assert.equal(alerts(f, 'WI-07').length, 1);
  } finally {
    f.cleanup();
  }
});

test('objects the candidate needs are missing: objects-unavailable with WI-13, nothing fetched, no ref', async () => {
  const f = fixture({ files: { 'src/a.txt': 'a\n' } });
  try {
    const missing = 'f'.repeat(40);
    const inner = execFileSync('git', ['mktree', '--missing'], { cwd: f.dir, input: `100644 blob ${missing}\tx.txt\n100644 blob ${f.git('rev-parse', 'HEAD:src/a.txt')}\ta.txt\n`, encoding: 'utf8' }).trim();
    const top = execFileSync('git', ['mktree', '--missing'], { cwd: f.dir, input: `100644 blob ${f.git('rev-parse', 'HEAD:file.txt')}\tfile.txt\n040000 tree ${inner}\tsrc\n`, encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['commit-tree', top, '-p', f.base, '-m', 'refers to a missing blob'], { cwd: f.dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
    await product(f, 'o1', { 'src/x.txt': '' }, { commit });
    const r = await deliver(f.ctx, request('d1'), { labels: labels(f) });
    assert.equal(r.kind, 'objects-unavailable', JSON.stringify(r));
    if (r.kind === 'objects-unavailable') assert.deepEqual(r.objects, [missing]);
    assert.equal(alerts(f, 'WI-13').length, 1);
    assert.throws(() => f.git('rev-parse', '--verify', 'refs/mission-pipeline/delivered/m1/d1'));
  } finally {
    f.cleanup();
  }
});

test('a stop committed after a failed ref attempt refuses the retry; the intent stays open', async () => {
  const f = fixture({ files: { 'src/a.txt': 'a\n' } });
  try {
    await product(f, 'o1');
    const lock = refLock(f, 'd1');
    const pend = await deliver(f.ctx, request('d1'), { labels: labels(f), hooks: { beforeRef: () => writeFileSync(lock, '') } });
    assert.equal(pend.kind, 'ref-pending');
    unlinkSync(lock);
    f.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-1'), scope: { kind: 'mission', mission: M }, words: 'stop', at: 1 }));
    await rejectsCode(deliver(f.ctx, request('d1'), { labels: labels(f) }), 'STOPPED');
    assert.throws(() => f.git('rev-parse', '--verify', 'refs/mission-pipeline/delivered/m1/d1'));
    assert.equal(f.m.read((db) => openIntents(db)).length, 1);
  } finally {
    f.cleanup();
  }
});

test('product versions without a commit and write scope are refused as unplaced', async () => {
  const f = fixture({ files: { 'src/a.txt': 'a\n' } });
  try {
    await product(f, 'o1', { 'src/a.txt': 'x\n' }, { source: false });
    const r = await deliver(f.ctx, request('d1'), { labels: labels(f) });
    assert.deepEqual(r, { kind: 'unplaced-products', versions: ['o1'] });
  } finally {
    f.cleanup();
  }
});

test('an older delivery recorded late (its ref created by a late git) never becomes current', async () => {
  const f = fixture({ files: { 'src/a.txt': 'a\n' } });
  try {
    await product(f, 'o1');
    const lock = refLock(f, 'd1');
    const pend = await deliver(f.ctx, request('d1'), { labels: labels(f), hooks: { beforeRef: () => writeFileSync(lock, '') } });
    assert.equal(pend.kind, 'ref-pending');
    if (pend.kind !== 'ref-pending') return;
    delivered(await deliver(f.ctx, request('d2'), { labels: labels(f) }));
    unlinkSync(lock);
    f.git('update-ref', pend.ref, pend.commit); // the late git
    const late = delivered(await deliver(f.ctx, request('d1'), { labels: labels(f) }));
    assert.equal(late.recovered, true);
    assert.equal(deliveryInfo(f.m, M, 'd1')?.state, 'recorded');
    assert.equal(currentDelivery(f.m, M)?.delivery, 'd2');
    await rejectsCode(land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m) }), 'DELIVERY_NOT_CURRENT');
  } finally {
    f.cleanup();
  }
});

test('a grant unblocks an exhausted delivery-rebuild loop', async () => {
  const f = fixture({ files: { 'src/a.txt': 'a\n' } });
  try {
    await product(f, 'o1');
    delivered(await deliver(f.ctx, request('d1'), { labels: labels(f) }));
    let prev = 'd1';
    for (const n of [1, 2, 3]) {
      advance(f, `m${n}`);
      prev = delivered(await rebuildDelivery(f.ctx, { mission: M, delivery: prev, closingChecks: [], author: IDENT, committer: IDENT }, { labels: labels(f) })).record.delivery;
    }
    advance(f, 'm4');
    assert.equal((await rebuildDelivery(f.ctx, { mission: M, delivery: prev, closingChecks: [], author: IDENT, committer: IDENT }, { labels: labels(f) })).kind, 'rebuild-limit-exhausted');
    f.m.write({}, (tx) => appendRecords(tx, [{ kind: 'loop.grant', lineage: 'delivery:m1:d1', loop: 'delivery-rebuild', by: 'secretary', extra: 2, reason: tx.data.put('the branch was busy with a release') } as BaseRecord]));
    const r = delivered(await rebuildDelivery(f.ctx, { mission: M, delivery: prev, closingChecks: [], author: IDENT, committer: IDENT }, { labels: labels(f) }));
    assert.deepEqual([r.record.delivery, r.record.rebuilds], ['d1-r4', 4]);
  } finally {
    f.cleanup();
  }
});

test('a withdrawal is checked on the delivery-ref intent: its retry is refused', async () => {
  const f = fixture({ files: { 'src/a.txt': 'a\n' } });
  try {
    await product(f, 'o1');
    const lock = refLock(f, 'd1');
    assert.equal((await deliver(f.ctx, request('d1'), { labels: labels(f), hooks: { beforeRef: () => writeFileSync(lock, '') } })).kind, 'ref-pending');
    unlinkSync(lock);
    f.m.write({}, (tx) => withdrawDelivery(tx, { mission: M, delivery: 'd1', reason: 'the maintainer withdrew it' }));
    await rejectsCode(deliver(f.ctx, request('d1'), { labels: labels(f) }), 'DELIVERY_NOT_CURRENT', /withdrawn/);
    assert.throws(() => f.git('rev-parse', '--verify', 'refs/mission-pipeline/delivered/m1/d1'));
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------- landing

/** A delivery on `release` (created at main's tip when missing). */
function releaseDelivery(f: Fixture, op = 'd1'): { B: string; D: string } {
  const B = f.git('rev-parse', 'main');
  if (f.git('branch', '--list', 'release') === '') f.git('branch', 'release', B);
  const D = commitOn(f.dir, B, { 'src/new.txt': `from ${op}\n` });
  recordedDelivery(f, op, D, B, 'release');
  return { B, D };
}

test('WI-01: a rebase or a bisect started from the target branch holds it', async () => {
  const f = fixture();
  try {
    const w = linkedWorktree(f, 'release');
    const { B } = releaseDelivery(f);
    sh(w.root, 'checkout', '-q', '--detach');
    mkdirSync(join(w.gitDir, 'rebase-merge'));
    writeFileSync(join(w.gitDir, 'rebase-merge', 'head-name'), 'refs/heads/release\n');
    const ww = words(f.m);
    const rebase = await land(f.ctx, { mission: M, delivery: 'd1', words: ww });
    assert.deepEqual(rebase.kind === 'not-landed' && [rebase.wi, rebase.reason], ['WI-01', 'operation']);
    rmSync(join(w.gitDir, 'rebase-merge'), { recursive: true });
    writeFileSync(join(w.gitDir, 'BISECT_START'), 'release\n');
    writeFileSync(join(w.gitDir, 'BISECT_LOG'), '');
    const bisect = await land(f.ctx, { mission: M, delivery: 'd1', words: ww });
    assert.deepEqual(bisect.kind === 'not-landed' && [bisect.wi, bisect.reason], ['WI-01', 'operation']);
    assert.equal(f.git('rev-parse', 'release'), B);
  } finally {
    f.cleanup();
  }
});

test('WI-02: a missing worktree directory, an external worktree, and landing into it when allowed', async () => {
  const f = fixture();
  try {
    const w = linkedWorktree(f, 'release');
    const { B, D } = releaseDelivery(f);
    const ww = words(f.m);
    const external = await land(f.ctx, { mission: M, delivery: 'd1', words: ww });
    assert.deepEqual(external.kind === 'not-landed' && [external.wi, external.reason], ['WI-02', 'external']);
    const r = landed(await land(f.ctx, { mission: M, delivery: 'd1', words: ww, allowExternal: w.root }));
    assert.equal(r.via, 'fast-forward');
    assert.equal(sh(w.root, 'rev-parse', 'HEAD'), D);
    assert.equal(readFileSync(join(w.root, 'src', 'new.txt'), 'utf8'), 'from d1\n');
    assert.equal(r.worktree?.relation, 'consistent');
    assert.equal(r.base, B);
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    const w = linkedWorktree(g, 'release');
    releaseDelivery(g);
    rmSync(w.root, { recursive: true, force: true });
    const missing = await land(g.ctx, { mission: M, delivery: 'd1', words: words(g.m) });
    assert.deepEqual(missing.kind === 'not-landed' && [missing.wi, missing.reason], ['WI-02', 'worktree-missing']);
  } finally {
    g.cleanup();
  }
});

test('a bare common repository with linked worktrees: the project’s own worktree lands by fast-forward, a branch checked out nowhere by compare-and-swap', async () => {
  const base = tempDir('mp-bare-');
  const seed = join(base, 'seed');
  const bare = join(base, 'repo.git');
  const wt = join(base, 'wt');
  mkdirSync(seed);
  sh(seed, 'init', '-q', '-b', 'main');
  write(seed, 'file.txt', 'hello\n');
  sh(seed, 'add', 'file.txt');
  sh(seed, 'commit', '-q', '-m', 'first');
  sh(base, 'clone', '-q', '--bare', seed, bare);
  sh(bare, 'worktree', 'add', '-q', wt, 'main');
  initMemory(wt);
  const m = openMemory(wt);
  try {
    const ctx = { memory: m, git: PlainGit.create() };
    const B = sh(wt, 'rev-parse', 'HEAD');
    const D = commitOn(wt, B, { 'new.txt': 'delivery\n' });
    sh(wt, 'update-ref', `refs/mission-pipeline/delivered/${M}/d1`, D);
    m.write({}, (tx) => recordDelivery(tx, { mission: M, delivery: 'd1', commit: D, base: B, ref: `refs/mission-pipeline/delivered/${M}/d1`, manifest: tx.data.put('m1'), target: 'main' }));
    const w1 = words(m);
    const r = landed(await land(ctx, { mission: M, delivery: 'd1', words: w1 }));
    assert.equal(r.via, 'fast-forward');
    assert.equal(sh(bare, 'rev-parse', 'refs/heads/main'), D);
    assert.equal(readFileSync(join(wt, 'new.txt'), 'utf8'), 'delivery\n');
    sh(wt, 'branch', 'release', D);
    const D2 = commitOn(wt, D, { 'more.txt': 'more\n' });
    sh(wt, 'update-ref', `refs/mission-pipeline/delivered/${M}/d2`, D2);
    m.write({}, (tx) => recordDelivery(tx, { mission: M, delivery: 'd2', commit: D2, base: D, ref: `refs/mission-pipeline/delivered/${M}/d2`, manifest: tx.data.put('m2'), target: 'release' }));
    const r2 = landed(await land(ctx, { mission: M, delivery: 'd2', words: w1 }));
    assert.equal(r2.via, 'cas');
    assert.equal(sh(bare, 'rev-parse', 'refs/heads/release'), D2);
  } finally {
    m.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('"consistent" after a fast-forward that changes end of line, ident, symlinks, modes and types', { skip: !POSIX }, async () => {
  const f = fixture({ files: { '.gitattributes': '*.crlf text eol=crlf\n*.id ident\n', 'a.crlf': 'one\n', 'b.id': '$Id$\n', 'tool.sh': 'echo\n', 'typ': 'plain\n' } });
  try {
    // Let git materialize the attribute-bearing files, as a checkout would.
    for (const p of ['a.crlf', 'b.id']) unlinkSync(join(f.dir, p));
    f.git('checkout', '--', 'a.crlf', 'b.id');
    assert.equal(readFileSync(join(f.dir, 'a.crlf'), 'utf8'), 'one\r\n');
    const B = f.git('rev-parse', 'HEAD');
    const D = commitWithModes(f.dir, B, {
      'a.crlf': ['100644', 'one\ntwo\n'],
      'b.id': ['100644', '$Id$\nmore\n'],
      link: ['120000', 'a.crlf'],
      'tool.sh': ['100755', 'echo\n'],
      typ: ['120000', 'b.id'],
    });
    recordedDelivery(f, 'd1', D, B, 'main');
    const r = landed(await land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m) }));
    assert.equal(r.via, 'fast-forward');
    assert.equal(readFileSync(join(f.dir, 'a.crlf'), 'utf8'), 'one\r\ntwo\r\n');
    assert.match(readFileSync(join(f.dir, 'b.id'), 'utf8'), /^\$Id: [0-9a-f]{40} \$\nmore\n$/);
    assert.equal(readlinkSync(join(f.dir, 'link')), 'a.crlf');
    assert.ok(lstatSync(join(f.dir, 'typ')).isSymbolicLink());
    assert.ok((lstatSync(join(f.dir, 'tool.sh')).mode & 0o100) !== 0);
    assert.equal(r.worktree?.relation, 'consistent', JSON.stringify(r.worktree));
  } finally {
    f.cleanup();
  }
});

test('recovery when the recorded worktree was removed: the landing is recorded done; the worktree cannot be determined', async () => {
  const f = fixture();
  try {
    const w = linkedWorktree(f, 'release');
    const { D } = releaseDelivery(f);
    await assert.rejects(land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m), allowExternal: w.root }, { afterGit: () => { throw new Error('killed after git'); } }), /killed after git/);
    assert.equal(f.git('rev-parse', 'release'), D);
    rmSync(w.root, { recursive: true, force: true });
    const rec = await recoverLandings(f.ctx);
    const r = rec.kind === 'checked' ? rec.results[0] : undefined;
    assert.equal(r?.kind, 'landed');
    if (r?.kind !== 'landed') return;
    assert.equal(r.worktree?.relation, 'cannot-determine');
    assert.equal(f.m.read((db) => openIntents(db)).length, 0);
  } finally {
    f.cleanup();
  }
});

test('the PM detaches a duplicate checkout (WI-01 option 2), then the landing goes through', async () => {
  const f = fixture();
  try {
    const dup = join(tempDir('mp-dup-'), 'dup');
    f.git('worktree', 'add', '-q', '--force', dup, 'main');
    const D = commitOn(f.dir, f.base, { 'new.txt': 'delivery\n' });
    recordedDelivery(f, 'd1', D, f.base, 'main');
    const ww = words(f.m);
    const several = await land(f.ctx, { mission: M, delivery: 'd1', words: ww });
    assert.deepEqual(several.kind === 'not-landed' && [several.wi, several.reason], ['WI-01', 'several-worktrees']);
    assert.equal((await detachDuplicateCheckout(f.ctx, { repoPath: f.dir, worktree: dup, targetBranch: 'main' })).kind, 'detached');
    const r = landed(await land(f.ctx, { mission: M, delivery: 'd1', words: ww }));
    assert.equal(r.via, 'fast-forward');
    assert.equal(sh(dup, 'rev-parse', 'HEAD'), f.base, 'the detached duplicate stays where it was');
  } finally {
    f.cleanup();
  }
});

test('WI-08: landing attempts that run git are counted, the first and 3 more; then refused until a grant', async () => {
  const f = fixture();
  try {
    releaseDelivery(f);
    const ww = words(f.m);
    const crash = { beforeGit: () => { throw new Error('crash before git'); } };
    for (let i = 0; i < 4; i++) await assert.rejects(land(f.ctx, { mission: M, delivery: 'd1', words: ww }, crash), /crash before git/);
    assert.equal(loopState(f.m, landingLineage(M, 'd1'), 'landing-attempt').attempts, 4);
    await rejectsCode(land(f.ctx, { mission: M, delivery: 'd1', words: ww }), 'LOOP_EXHAUSTED');
    assert.equal(alerts(f, 'WI-08').length, 1);
    f.m.write({}, (tx) => appendRecords(tx, [{ kind: 'loop.grant', lineage: landingLineage(M, 'd1'), loop: 'landing-attempt', by: 'secretary', extra: 1, reason: tx.data.put('the lock is gone now') } as BaseRecord]));
    landed(await land(f.ctx, { mission: M, delivery: 'd1', words: ww }));
  } finally {
    f.cleanup();
  }
});

test('WI-08: retries after the same verdict twice in a row are no progress', async () => {
  const f = fixture();
  try {
    const { B } = releaseDelivery(f);
    const ww = words(f.m);
    // Room beyond the cap, so the refusal below is "no progress", not the cap.
    f.m.write({}, (tx) => appendRecords(tx, [{ kind: 'loop.grant', lineage: landingLineage(M, 'd1'), loop: 'landing-attempt', by: 'secretary', extra: 2, reason: tx.data.put('room') } as BaseRecord]));
    // A git that never takes effect: the ref stays at B (class B) every time.
    const lockFile = join(f.dir, '.git', 'refs', 'heads', 'release.lock');
    await assert.rejects(land(f.ctx, { mission: M, delivery: 'd1', words: ww }, { beforeGit: () => { throw new Error('crash'); } }), /crash/);
    for (let i = 0; i < 3; i++) {
      const r = await land(f.ctx, { mission: M, delivery: 'd1', words: ww }, { beforeGit: () => writeFileSync(lockFile, '') });
      assert.equal(r.kind === 'open' && r.class, 'B', JSON.stringify(r));
      unlinkSync(lockFile);
    }
    await rejectsCode(land(f.ctx, { mission: M, delivery: 'd1', words: ww }), 'LOOP_EXHAUSTED', /no-progress/);
    assert.equal(f.git('rev-parse', 'release'), B);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------- WI-03

test('WI-03 at a delivery and at a landing: external worktrees and branches that changed paths in a write scope are noticed; nothing is blocked', async () => {
  const f = fixture({ files: { 'src/a.txt': 'a\n', 'docs/d.txt': 'd\n' } });
  try {
    await product(f, 'o1');
    // An external worktree with a committed and an uncommitted change inside src/, a branch checked out
    // nowhere inside src/, a branch outside it, and the pipeline's own dispatch worktree (never external).
    const w = linkedWorktree(f, 'feature');
    write(w.root, 'src/ext.txt', 'external\n');
    sh(w.root, 'add', 'src/ext.txt');
    sh(w.root, 'commit', '-q', '-m', 'external work');
    write(w.root, 'src/a.txt', 'uncommitted external edit\n');
    f.git('branch', 'side', f.base);
    f.git('update-ref', 'refs/heads/side', commitOn(f.dir, f.base, { 'src/side.txt': 'side\n' }));
    f.git('update-ref', 'refs/heads/docs-only', commitOn(f.dir, f.base, { 'docs/d.txt': 'other\n' }));
    const own = ensureWorkspace(f.ctx, { dispatch: 'D-1', base: f.base }).path;
    write(own, 'src/own.txt', 'the pipeline’s own work\n');
    delivered(await deliver(f.ctx, request('d1'), { labels: labels(f) }));
    const bodies = alertBodies(f, 'WI-03');
    assert.equal(bodies.length, 1);
    const overlaps = bodies[0]!.facts.overlaps as Array<{ worktree: string | null; branch: string | null; paths: string[] }>;
    assert.deepEqual(
      overlaps.map((o) => [o.branch, o.paths]).sort(),
      [
        ['refs/heads/feature', ['src/a.txt', 'src/ext.txt']],
        ['refs/heads/side', ['src/side.txt']],
      ],
    );
    assert.ok(!JSON.stringify(overlaps).includes('D-1'));
    // At the landing: noticed again for this landing, and it lands.
    const r = landed(await land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m) }));
    assert.equal(r.via, 'fast-forward');
    assert.equal(alertBodies(f, 'WI-03').length, 2);
    // The same finding at the same moment is not noticed twice.
    assert.equal((await land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m) })).kind, 'landed');
    assert.equal(alertBodies(f, 'WI-03').length, 2);
  } finally {
    f.cleanup();
  }
});

test('WI-03: nothing is noticed when no external work touches a write scope', async () => {
  const f = fixture({ files: { 'src/a.txt': 'a\n', 'docs/d.txt': 'd\n' } });
  try {
    await product(f, 'o1');
    f.git('update-ref', 'refs/heads/docs-only', commitOn(f.dir, f.base, { 'docs/d.txt': 'other\n' }));
    const merged = linkedWorktree(f, 'merged'); // at main's tip: nothing diverged
    void merged;
    delivered(await deliver(f.ctx, request('d1'), { labels: labels(f) }));
    assert.equal(alerts(f, 'WI-03').length, 0);
    assert.ok(existsSync(merged.root));
  } finally {
    f.cleanup();
  }
});
