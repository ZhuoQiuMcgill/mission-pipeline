import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHolds } from '../src/delivery/candidate.ts';
import { discoverRepo } from '../src/git/objects.ts';
import { readTransformDescription, transformDescriptionHash } from '../src/git/representation.ts';
import { appendRecords } from '../src/memory/index.ts';
import { pmClose } from '../src/process/close.ts';
import { ProcessError } from '../src/process/errors.ts';
import { FakeProofView, obj, productVersion } from './delivery-fixtures.test.ts';
import { memoryPorts } from './flow-memory-fixtures.ts';
import { checkoutMain, initRepo, makeFixture, rawCommit } from './git-fixtures.test.ts';
import { builders } from './labels-fixtures.ts';

test('T1 real git: full close refuses the recorded prerequisite missing from an accepted legacy start', async () => {
  const fx = makeFixture('final-close');
  try {
    const dir = initRepo(fx, 'repo');
    const base = rawCommit(fx, dir, { 'a/f': '0\n', 'b/f': '0\n' }, null, 'base');
    checkoutMain(fx, dir, base);
    const a1 = rawCommit(fx, dir, { 'a/f': '1\n', 'b/f': '0\n' }, base, 'A1');
    const a2 = rawCommit(fx, dir, { 'a/f': '2\n', 'b/f': '0\n' }, base, 'A2');
    const bad = rawCommit(fx, dir, { 'a/f': '1\n', 'b/f': 'B\n' }, a1, 'B on A1');
    const repo = await discoverRepo(fx.git, dir);
    const transform = transformDescriptionHash(await readTransformDescription(fx.git, repo));
    const a = await productVersion(fx.git, repo, { id: 'a2', module: 'a', commit: a2, writeScope: ['a/**'], transform });
    const b = await productVersion(fx.git, repo, { id: 'bad', module: 'b', commit: bad, writeScope: ['b/**'], transform, prerequisites: [obj('a2')] });
    const view = new FakeProofView().add(a, b);
    const w = memoryPorts();
    w.scheduler.actions.startHolds = (id) => startHolds(fx.git, repo, view, view.object(id as never)!);
    const records = builders(w.memory);
    w.ctx.environment();
    w.memory.write({}, (tx) => {
      appendRecords(tx, [records.product('a2'), records.judge('ja', 'a2'), records.product('bad', { prereqs: ['a2'] }), records.judge('jb', 'bad'), records.product('plan'), records.judge('jp', 'plan'),
        { kind: 'flow.event', mission: 'm1', line: 'plan', event: 'effective', key: 'plan', body: tx.data.put(JSON.stringify({ dplan: 'plan', tasks: ['b'] })) },
        { kind: 'flow.event', mission: 'm1', line: 'task:b', event: 'dispatched', key: 'con.m1.b.1', body: tx.data.put(JSON.stringify({ k: 1, dplan: 'plan', commit: a1, snapshot: a1 })) },
        { kind: 'flow.event', mission: 'm1', line: 'task:b', event: 'product', key: '1', body: tx.data.put(JSON.stringify({ k: 1, object: 'bad' })) },
        { kind: 'flow.event', mission: 'm1', line: 'task:b', event: 'accepted', key: '1', body: tx.data.put(JSON.stringify({ product: 'bad', judgment: 'jb' })) },
      ] as never);
    });
    await assert.rejects(async () => pmClose(w.ctx, 'm1', { mode: 'full' }), (e) => e instanceof ProcessError && e.code === 'NOT_READY' && /bad.*a2 at a\/f/.test(e.message) && /mp pm next/.test(e.message));
    const closed = await pmClose(w.ctx, 'm1', { mode: 'with-risk' });
    assert.ok(closed.risks.some((r) => /bad.*a2 at a\/f/.test(r)));
  } finally {
    fx.cleanup();
  }
});
