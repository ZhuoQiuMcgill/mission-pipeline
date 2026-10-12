// Design 4.1 §6.7, §11 scenario 9, decision 16; WI-05, WI-08, WI-20, WI-21:
// delivery with plain git over the project memory: manifest, candidate on the
// target's current commit, proof check, closing checks in a clean checkout,
// the delivery ref; rebuilds on a moved base, counted, then the ref is left.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { id, type ObjectVersionId, type StopId } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';
import { deliver, rebuildDelivery, shellClosingRunner, type ClosingRunner, type DeliverRequest, type DeliveryResult } from '../src/delivery/delivery.ts';
import type { LabelView } from '../src/delivery/memoryView.ts';
import { writeScopeDocument } from '../src/delivery/writeScope.ts';
import { land } from '../src/git/land.ts';
import { discoverRepo, lsTree } from '../src/git/objects.ts';
import { readTransformDescription, transformDescriptionHash } from '../src/git/representation.ts';
import { appendRecords, commitStop, deliveryInfo, loopState, openIntents } from '../src/memory/index.ts';
import { commitOn, fixture, holdGitWrites, IDENT, M, words, write, type Fixture } from './git41-fixtures.ts';

const POSIX = process.platform !== 'win32';
const FILES = { 'src/a.txt': 'a\n', 'file2.txt': 'x\n', '.gitignore': '*.log\n' };

/** A product version o1 on main: its own commit on the base, changing src/ (write scope src/**). */
async function product(f: Fixture, object = 'o1', files: Record<string, string> = { 'src/a.txt': 'A1\n', 'src/c.txt': 'new\n' }): Promise<string> {
  const base = f.git('rev-parse', 'main');
  const commit = commitOn(f.dir, base, files, `product ${object}`);
  const repo = await discoverRepo(f.ctx.git, f.dir);
  const transform = transformDescriptionHash(await readTransformDescription(f.ctx.git, repo, f.dir));
  const scopeDoc = writeScopeDocument(await lsTree(f.ctx.git, repo, commit, { recursive: true }), ['src/**']);
  f.m.write({}, (tx) => {
    const content = tx.data.put(scopeDoc);
    const rec = {
      kind: 'object.version',
      object,
      objectKind: 'product',
      mission: M,
      module: `mod-${object}`,
      content,
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
  return { mission: M, delivery: op, targetBranch: 'main', selected: [{ kind: 'object', id: 'o1' as ObjectVersionId }], closingChecks: [], author: IDENT, committer: IDENT, ...over };
}

function delivered(r: DeliveryResult): Extract<DeliveryResult, { kind: 'delivered' }> {
  assert.equal(r.kind, 'delivered', JSON.stringify(r).slice(0, 600));
  return r as Extract<DeliveryResult, { kind: 'delivered' }>;
}

/** A commit on main by "someone else". */
function advance(f: Fixture, name: string): string {
  const c = commitOn(f.dir, f.git('rev-parse', 'main'), { [`other/${name}.txt`]: `${name}\n` });
  f.git('merge', '-q', '--ff-only', c);
  return c;
}

test('a delivery: the candidate on main’s current commit, proven, its closing checks run in a clean checkout, the delivery ref created and recorded once', { skip: !POSIX }, async () => {
  const f = fixture({ files: FILES });
  try {
    const B = f.git('rev-parse', 'main');
    await product(f);
    write(f.dir, 'untracked.txt', 'untracked in the main worktree\n');
    write(f.dir, 'main.log', 'ignored in the main worktree\n');
    // The run directory is a repository of its own at the candidate (on B), never the project's worktree.
    const checks = [{ id: 'clean', command: `test -f src/c.txt && test ! -e untracked.txt && test ! -e main.log && test "$(git rev-parse --show-toplevel)" = "$(pwd -P)" && test "$(git rev-parse HEAD^)" = ${B} && git diff-index --quiet HEAD --` }];
    const asked = words(f.m, 'deliver the feature');
    await assert.rejects(deliver(f.ctx, request('d1', { words: 'W-99' }), { labels: labels(f) }), /no words entry/);
    const r = delivered(await deliver(f.ctx, request('d1', { closingChecks: checks, words: asked }), { labels: labels(f) }));
    const rec = r.record;
    assert.equal(rec.base, B);
    assert.equal(rec.ref, 'refs/mission-pipeline/delivered/m1/d1');
    assert.equal(f.git('rev-parse', rec.ref), rec.commit);
    assert.equal(f.git('rev-parse', `${rec.commit}^@`), B, 'a fast-forward of the base');
    assert.equal(f.git('show', `${rec.commit}:src/a.txt`), 'A1');
    assert.equal(f.git('show', `${rec.commit}:file2.txt`), 'x');
    assert.deepEqual([rec.proof?.proven, rec.checks.map((c) => [c.id, c.passed]), rec.rebuilds], [['o1'], [['clean', true]], 0]);
    const info = deliveryInfo(f.m, M, 'd1');
    assert.deepEqual([info?.state, info?.commit, info?.base, info?.target], ['recorded', rec.commit, B, 'main']);
    const leaf = readFileSync(join(f.m.paths.root, 'missions', 'm1', 'deliveries', 'd1.md'), 'utf8');
    assert.match(leaf, /Delivery commit: [0-9a-f]{40}/);
    assert.match(leaf, new RegExp(`Asked for in ${asked}`));
    assert.ok(!existsSync(join(f.m.paths.tmp, 'deliver-d1')), 'the run directory is removed');
    assert.equal(f.git('rev-parse', 'main'), B, 'delivery never moves the target branch');
    assert.equal(f.m.read((db) => openIntents(db)).length, 0);
    // Asked again: the record as it is.
    const again = delivered(await deliver(f.ctx, request('d1'), { labels: labels(f) }));
    assert.equal(again.record.commit, rec.commit);
    // Then landed with the maintainer's consent.
    const l = await land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m) });
    assert.equal(l.kind === 'landed' && l.via, 'fast-forward');
    assert.equal(f.git('rev-parse', 'main'), rec.commit);
  } finally {
    f.cleanup();
  }
});

test('closing checks failing: no ref, nothing recorded (WI-21); labels recomputing: nothing built; a stop and held git writes refuse', { skip: !POSIX }, async () => {
  const f = fixture({ files: FILES });
  try {
    await product(f);
    const failed = await deliver(f.ctx, request('d1', { closingChecks: [{ id: 'fails', command: 'echo broken >&2; exit 3' }] }), { labels: labels(f) });
    assert.equal(failed.kind, 'checks-failed');
    if (failed.kind === 'checks-failed') assert.deepEqual([failed.outcomes[0]?.exitCode, failed.outcomes[0]?.tail.trim()], [3, 'broken']);
    assert.equal(deliveryInfo(f.m, M, 'd1'), null);
    assert.throws(() => f.git('rev-parse', '--verify', 'refs/mission-pipeline/delivered/m1/d1'));
    assert.deepEqual(await deliver(f.ctx, request('d2'), { labels: labels(f, { recomputing: true }) }), { kind: 'recomputing' });
    const notProven = delivered(await deliver(f.ctx, request('d3'), { labels: labels(f, { labelOf: () => 'not-fully-proven' }) }));
    assert.deepEqual(notProven.record.proof?.notFullyProven.map((n) => n.id), ['o1']);
    const unknown = await deliver(f.ctx, request('d4', { selected: [{ kind: 'object', id: 'nope' as ObjectVersionId }] }), { labels: labels(f) });
    assert.equal(unknown.kind, 'unknown-targets');
    holdGitWrites(f.m);
    await assert.rejects(deliver(f.ctx, request('d5'), { labels: labels(f) }), /GIT_WRITES_HELD|held/);
    f.m.connection.prepare("DELETE FROM meta WHERE key = 'git_hold'").run();
    f.m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-1'), scope: { kind: 'mission', mission: M }, words: 'stop', at: 1 }));
    await assert.rejects(deliver(f.ctx, request('d6'), { labels: labels(f) }), /STOPPED|stop/);
  } finally {
    f.cleanup();
  }
});

test('the target moved while the candidate was checked: rebuilt on the new base, counted (decision 16)', { skip: !POSIX }, async () => {
  const f = fixture({ files: FILES });
  try {
    await product(f);
    let calls = 0;
    let moved = '';
    const racing: ClosingRunner = {
      run(req) {
        if (calls++ === 0) moved = advance(f, 'during-checks');
        return shellClosingRunner.run(req);
      },
    };
    const r = delivered(await deliver(f.ctx, request('d1', { closingChecks: [{ id: 'ok', command: 'true' }] }), { labels: labels(f), closing: racing }));
    assert.equal(r.record.base, moved);
    assert.equal(r.record.rebuilds, 1);
    assert.equal(f.git('show', `${r.record.commit}:other/during-checks.txt`), 'during-checks');
    assert.equal(loopState(f.m, 'delivery:m1:d1', 'delivery-rebuild').attempts, 1);
  } finally {
    f.cleanup();
  }
});

test('a landing on a moved branch rebuilds the delivery (WI-05), 3 times per delivery, then leaves the delivery ref (WI-08)', { skip: !POSIX }, async () => {
  const f = fixture({ files: FILES });
  try {
    await product(f);
    const w = words(f.m);
    const d1 = delivered(await deliver(f.ctx, request('d1'), { labels: labels(f) }));
    advance(f, 'm1');
    const moved = await land(f.ctx, { mission: M, delivery: 'd1', words: w });
    assert.equal(moved.kind, 'base-moved');
    assert.equal(f.git('rev-parse', 'main') !== d1.record.commit, true, 'nothing merged');
    const r1 = delivered(await rebuildDelivery(f.ctx, { mission: M, delivery: 'd1', closingChecks: [], author: IDENT, committer: IDENT }, { labels: labels(f) }));
    assert.deepEqual([r1.record.delivery, r1.record.rebuilds, r1.record.base], ['d1-r1', 1, f.git('rev-parse', 'main')]);
    const landed = await land(f.ctx, { mission: M, delivery: 'd1-r1', words: w });
    assert.equal(landed.kind, 'landed');
    let prev = 'd1-r1';
    for (const n of [2, 3]) {
      advance(f, `m${n}`);
      const r = delivered(await rebuildDelivery(f.ctx, { mission: M, delivery: prev, closingChecks: [], author: IDENT, committer: IDENT }, { labels: labels(f) }));
      assert.deepEqual([r.record.delivery, r.record.rebuilds], [`d1-r${n}`, n]);
      prev = r.record.delivery;
    }
    advance(f, 'm4');
    const out = await rebuildDelivery(f.ctx, { mission: M, delivery: prev, closingChecks: [], author: IDENT, committer: IDENT }, { labels: labels(f) });
    assert.equal(out.kind, 'rebuild-limit-exhausted');
    if (out.kind !== 'rebuild-limit-exhausted') return;
    assert.deepEqual([out.rebuilds, out.limit, out.leftRef], [3, 3, 'refs/mission-pipeline/delivered/m1/d1-r3']);
    assert.equal(f.git('rev-parse', out.leftRef!), deliveryInfo(f.m, M, 'd1-r3')?.commit, 'the delivery ref is left');
    const alerts = f.m.stmt("SELECT record FROM log WHERE kind = 'alert'").all() as Array<{ record: string }>;
    assert.ok(alerts.some((a) => a.record.includes('"WI-08"')));
    assert.ok(alerts.some((a) => a.record.includes('"WI-05"')));
  } finally {
    f.cleanup();
  }
});

test('a crash between the delivery ref and its record: the next call reads the ref and records it; a ref pointing elsewhere is never overwritten (WI-20)', { skip: !POSIX }, async () => {
  const f = fixture({ files: FILES });
  try {
    await product(f);
    await assert.rejects(deliver(f.ctx, request('d1'), { labels: labels(f), hooks: { afterRef: () => { throw new Error('crash after the ref'); } } }), /crash after the ref/);
    assert.equal(deliveryInfo(f.m, M, 'd1')?.recordedRev ?? null, null);
    assert.equal(f.m.read((db) => openIntents(db)).length, 1);
    const r = delivered(await deliver(f.ctx, request('d1'), { labels: labels(f) }));
    assert.equal(r.recovered, true);
    assert.equal(deliveryInfo(f.m, M, 'd1')?.state, 'recorded');
    assert.equal(f.m.read((db) => openIntents(db)).length, 0);
    // A ref of the program's namespace someone pointed elsewhere.
    f.git('update-ref', 'refs/mission-pipeline/delivered/m1/d2', f.git('rev-parse', 'main'));
    const mism = await deliver(f.ctx, request('d2'), { labels: labels(f) });
    assert.equal(mism.kind, 'ref-mismatch');
    assert.equal(f.git('rev-parse', 'refs/mission-pipeline/delivered/m1/d2'), f.git('rev-parse', 'main'));
    assert.equal(deliveryInfo(f.m, M, 'd2')?.recordedRev ?? null, null);
    await assert.rejects(deliver(f.ctx, request('bad id'), { labels: labels(f) }), /BAD_REQUEST|delivery id/);
  } finally {
    f.cleanup();
  }
});
