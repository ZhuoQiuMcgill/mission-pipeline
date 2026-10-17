// Design 4.1 §6.7, §11 scenario 9, decision 16; WI-05, WI-08, WI-20; 4.1.2 D-7:
// delivery with plain git over the project memory: manifest, candidate on the
// target's current commit, proof check, the full-run status of its tree (no
// command runs), the delivery ref; rebuilds on a moved base, counted, then the
// ref is left.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { id, type ObjectVersionId, type StopId } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';
import { deliver, rebuildDelivery, type DeliverRequest, type DeliveryFullRun, type DeliveryResult } from '../src/delivery/delivery.ts';
import type { LabelView } from '../src/delivery/memoryView.ts';
import { writeScopeDocument } from '../src/delivery/writeScope.ts';
import { land } from '../src/git/land.ts';
import { shellQuote } from '../src/git/plainGit.ts';
import { discoverRepo, lsTree } from '../src/git/objects.ts';
import { readTransformDescription, transformDescriptionHash } from '../src/git/representation.ts';
import { appendRecords, commitStop, deliveryInfo, loopState, openIntents } from '../src/memory/index.ts';
import { commitOn, fixture, holdGitWrites, IDENT, M, words, write, type Fixture } from './git41-fixtures.ts';
import { tempDir } from './memory-fixtures.ts';

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
  return { mission: M, delivery: op, targetBranch: 'main', selected: [{ kind: 'object', id: 'o1' as ObjectVersionId }], author: IDENT, committer: IDENT, ...over };
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

test('delivery setup runs no global hooks: none has run when the candidate is built and proof-checked', { skip: !POSIX }, async () => {
  const f = fixture({ files: FILES });
  const saved = process.env['GIT_CONFIG_GLOBAL'];
  const scratch = tempDir('mp-deliver-hooks-');
  try {
    await product(f);
    const hooks = join(scratch, 'hooks');
    const marker = join(scratch, 'hook-calls');
    mkdirSync(hooks);
    const hook = join(hooks, 'reference-transaction');
    writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${marker}'\ncat >> '${marker}'\n`);
    chmodSync(hook, 0o755);
    const global = join(scratch, 'gitconfig');
    writeFileSync(global, `[core]\n\thooksPath = ${JSON.stringify(hooks)}\n`);
    process.env['GIT_CONFIG_GLOBAL'] = global;
    let reached = false;
    const fullRun = (): DeliveryFullRun => {
      reached = true;
      assert.equal(existsSync(marker), false, 'no reference transaction hook during attribute setup or the candidate build');
      return { line: 'full suite never run', status: null };
    };
    delivered(await deliver(f.ctx, request('hook-test'), { labels: labels(f), fullRun }));
    assert.equal(reached, true);
  } finally {
    if (saved === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
    else process.env['GIT_CONFIG_GLOBAL'] = saved;
    f.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a delivery: the candidate on main’s current commit, proven, no command run, its full-run status recorded, the delivery ref created and recorded once', { skip: !POSIX }, async () => {
  const f = fixture({ files: FILES });
  try {
    const B = f.git('rev-parse', 'main');
    await product(f);
    write(f.dir, 'untracked.txt', 'untracked in the main worktree\n');
    write(f.dir, 'main.log', 'ignored in the main worktree\n');
    const asked = words(f.m, 'deliver the feature');
    await assert.rejects(deliver(f.ctx, request('d1', { words: 'W-99' }), { labels: labels(f) }), /no words entry/);
    // D-7: the delivery asks for the full-run status of its tree and runs nothing
    const asks: Array<{ commit: string; tree: string }> = [];
    const fullRun = (c: { commit: string; tree: string }): DeliveryFullRun => {
      asks.push(c);
      return { line: 'full suite never run', status: { last: null, sameTree: false, changedSince: null } };
    };
    const r = delivered(await deliver(f.ctx, request('d1', { words: asked }), { labels: labels(f), fullRun }));
    const rec = r.record;
    assert.equal(rec.base, B);
    assert.equal(rec.ref, 'refs/mission-pipeline/delivered/m1/d1');
    assert.equal(f.git('rev-parse', rec.ref), rec.commit);
    assert.equal(f.git('rev-parse', `${rec.commit}^@`), B, 'a fast-forward of the base');
    assert.equal(f.git('show', `${rec.commit}:src/a.txt`), 'A1');
    assert.equal(f.git('show', `${rec.commit}:file2.txt`), 'x');
    assert.deepEqual([rec.proof?.proven, rec.rebuilds], [['o1'], 0]);
    assert.equal(rec.tree, f.git('rev-parse', `${rec.commit}^{tree}`));
    assert.deepEqual(asks, [{ commit: rec.commit, tree: rec.tree }]);
    assert.equal(rec.fullRun?.line, 'full suite never run');
    const info = deliveryInfo(f.m, M, 'd1');
    assert.deepEqual([info?.state, info?.commit, info?.base, info?.target], ['recorded', rec.commit, B, 'main']);
    const leaf = readFileSync(join(f.m.paths.root, 'missions', 'm1', 'deliveries', 'd1.md'), 'utf8');
    assert.match(leaf, /Delivery commit: [0-9a-f]{40}/);
    assert.match(leaf, new RegExp(`Asked for in ${asked}`));
    assert.match(leaf, /## Full suite\n\n- full suite never run\n- No command ran at this delivery/);
    assert.doesNotMatch(leaf, /Closing checks/);
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

test('labels recomputing: nothing built; not proven delivered with its label; a stop and held git writes refuse', { skip: !POSIX }, async () => {
  const f = fixture({ files: FILES });
  try {
    await product(f);
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

test('4.1.2: --message sets the delivery commit\'s subject; a candidate-only build records nothing and creates no ref', { skip: !POSIX }, async () => {
  const f = fixture({ files: FILES });
  try {
    await product(f);
    const only = await deliver(f.ctx, request('c1', { candidateOnly: true }), { labels: labels(f) });
    assert.equal(only.kind, 'candidate', JSON.stringify(only));
    if (only.kind !== 'candidate') return;
    assert.equal(only.tree, f.git('rev-parse', `${only.commit}^{tree}`));
    assert.equal(f.git('show', `${only.commit}:src/a.txt`), 'A1');
    assert.equal(deliveryInfo(f.m, M, 'c1'), null);
    assert.equal(f.m.read((db) => openIntents(db)).length, 0);
    assert.throws(() => f.git('rev-parse', '--verify', 'refs/mission-pipeline/delivered/m1/c1'));
    const r = delivered(await deliver(f.ctx, request('d1', { message: 'feat: the o1 change' }), { labels: labels(f) }));
    assert.equal(f.git('log', '-1', '--format=%s', r.record.commit), 'feat: the o1 change');
    assert.match(f.git('log', '-1', '--format=%b', r.record.commit), /Delivery d1 of mission m1 as of revision \d+:\n  o1: proven/);
    const plain = delivered(await deliver(f.ctx, request('d2'), { labels: labels(f) }));
    assert.match(f.git('log', '-1', '--format=%s', plain.record.commit), /^Delivery d2 of mission m1 \(o1\) as of revision \d+$/, 'the default subject stays');
  } finally {
    f.cleanup();
  }
});

test('the target moved while the candidate was built: rebuilt on the new base, counted (decision 16)', { skip: !POSIX }, async () => {
  const f = fixture({ files: FILES });
  try {
    await product(f);
    let calls = 0;
    let moved = '';
    // the full-run status is asked after the candidate is built and proof-checked, before the base is read again
    const racing = (): DeliveryFullRun => {
      if (calls++ === 0) moved = advance(f, 'during-checks');
      return { line: 'full suite never run', status: null };
    };
    const r = delivered(await deliver(f.ctx, request('d1'), { labels: labels(f), fullRun: racing }));
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
    const r1 = delivered(await rebuildDelivery(f.ctx, { mission: M, delivery: 'd1', author: IDENT, committer: IDENT }, { labels: labels(f) }));
    assert.deepEqual([r1.record.delivery, r1.record.rebuilds, r1.record.base], ['d1-r1', 1, f.git('rev-parse', 'main')]);
    const landed = await land(f.ctx, { mission: M, delivery: 'd1-r1', words: w });
    assert.equal(landed.kind, 'landed');
    let prev = 'd1-r1';
    for (const n of [2, 3]) {
      advance(f, `m${n}`);
      const r = delivered(await rebuildDelivery(f.ctx, { mission: M, delivery: prev, author: IDENT, committer: IDENT }, { labels: labels(f) }));
      assert.deepEqual([r.record.delivery, r.record.rebuilds], [`d1-r${n}`, n]);
      prev = r.record.delivery;
    }
    advance(f, 'm4');
    const out = await rebuildDelivery(f.ctx, { mission: M, delivery: prev, author: IDENT, committer: IDENT }, { labels: labels(f) });
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
