// Delivery manifest and consistency (design 6.6 steps 1-2, 5.3; §14 item 11).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildManifest } from '../src/delivery/manifest.ts';
import { FakeProofView, fakeObject, mod, obj, ov, pu, unit } from './delivery-fixtures.test.ts';

const ids = (xs: readonly { readonly id: string }[]): string[] => xs.map((x) => x.id);

test('the manifest is the prerequisite closure of each selected output, and every entry knows who needs it', () => {
  const view = new FakeProofView().add(
    fakeObject('a1', { paths: ['a/x'], prerequisites: [obj('b1')] }),
    fakeObject('b1', { paths: ['b/y'], prerequisites: [obj('c1')] }),
    fakeObject('c1', { paths: ['c/z'] }),
    fakeObject('d1', { paths: ['d/w'], prerequisites: [obj('c1')] }),
    fakeObject('e1', { paths: ['e/v'] }), // not needed by anything selected
  );
  const r = buildManifest(view, [obj('a1'), obj('d1')]);
  assert.equal(r.kind, 'manifest');
  if (r.kind !== 'manifest') return;
  assert.deepEqual(r.manifest.entries.map((e) => e.object.id), ['a1', 'b1', 'c1', 'd1']);
  const c1 = r.manifest.entries.find((e) => e.object.id === 'c1');
  assert.deepEqual(ids(c1?.requiredBy ?? []), ['a1', 'd1']);
  assert.deepEqual(ids(c1?.chain ?? []), ['a1', 'b1', 'c1']);
  assert.deepEqual([...r.manifest.paths.entries()].sort(), [
    ['a/x', 'a1'],
    ['b/y', 'b1'],
    ['c/z', 'c1'],
    ['d/w', 'd1'],
  ]);
  assert.equal(r.manifest.revision, view.revision);
});

test('a proof unit enters the manifest whole, whichever member brought it in (§14 item 11)', () => {
  const view = new FakeProofView()
    .add(
      fakeObject('x1', { paths: ['x/f'], prerequisites: [obj('y1')] }),
      fakeObject('y1', { paths: ['y/f'], prerequisites: [obj('x1')] }),
      fakeObject('w1', { paths: ['w/f'] }),
      fakeObject('z1', { paths: ['z/f'], prerequisites: [obj('y1')] }),
    )
    .unit(pu('u1'), [ov('x1'), ov('y1'), ov('w1')])
    .setLabel(unit('u1'), 'not-fully-proven');
  for (const selected of [obj('x1'), obj('z1'), unit('u1')]) {
    const r = buildManifest(view, [selected]);
    assert.equal(r.kind, 'manifest', JSON.stringify(selected));
    if (r.kind !== 'manifest') continue;
    const got = r.manifest.entries.map((e) => e.object.id);
    for (const m of ['x1', 'y1', 'w1']) assert.ok(got.includes(m as never), `${selected.id}: ${m} missing from ${got.join(',')}`);
    assert.deepEqual(r.manifest.units.map((u) => [u.unit, [...u.members]]), [['u1', ['x1', 'y1', 'w1']]]);
    for (const e of r.manifest.entries.filter((x) => x.unit !== null)) {
      assert.equal(e.label, 'not-fully-proven', 'a member is proven only with its unit (5.3)');
    }
  }
});

test('two versions of one path are incompatible; the result names both sides (§14 item 11)', () => {
  const view = new FakeProofView().add(
    fakeObject('a1', { paths: ['a/x'], prerequisites: [obj('b1')] }),
    fakeObject('c1', { paths: ['c/x'], prerequisites: [obj('b2')] }),
    fakeObject('b1', { module: 'b', paths: ['b/shared.ts', 'b/old.ts'] }),
    fakeObject('b2', { module: 'b', paths: ['b/shared.ts', 'b/new.ts'] }),
  );
  const r = buildManifest(view, [obj('a1'), obj('c1')]);
  assert.equal(r.kind, 'incompatible');
  if (r.kind !== 'incompatible') return;
  const samePath = r.conflicts.find((c) => c.kind === 'same-path');
  assert.equal(samePath?.path, 'b/shared.ts');
  assert.deepEqual(samePath?.sides.map((s) => [s.version, ids(s.requiredBy), ids(s.chain)]), [
    ['b1', ['a1'], ['a1', 'b1']],
    ['b2', ['c1'], ['c1', 'b2']],
  ]);
  const sameModule = r.conflicts.find((c) => c.kind === 'same-module');
  assert.equal(sameModule?.module, mod('b'));
  assert.deepEqual(sameModule?.sides.map((s) => s.version), ['b1', 'b2']);
});

test('two modules delivering one path are incompatible too; plans and interpretations take no paths', () => {
  const view = new FakeProofView().add(
    fakeObject('p1', { module: 'p', paths: ['shared/conf.json'] }),
    fakeObject('q1', { module: 'q', paths: ['shared/conf.json', 'q/main.ts'] }),
    fakeObject('plan1', { kind: 'plan', module: null, paths: ['docs/plan.md'] }),
    fakeObject('plan2', { kind: 'plan', module: null, paths: ['docs/plan.md'] }),
  );
  const r = buildManifest(view, [obj('p1'), obj('q1')]);
  assert.equal(r.kind, 'incompatible');
  if (r.kind === 'incompatible') assert.deepEqual(r.conflicts.map((c) => [c.kind, c.path]), [['same-path', 'shared/conf.json']]);
  const plans = buildManifest(view, [obj('plan1'), obj('plan2')]);
  assert.equal(plans.kind, 'manifest', 'documents outside the repository are not delivered paths');
});

test('unknown ids are reported as such, and prerequisite cycles without a unit still terminate', () => {
  const view = new FakeProofView().add(
    fakeObject('a1', { paths: ['a/x'], prerequisites: [obj('b1'), unit('nope')] }),
    fakeObject('b1', { paths: ['b/x'], prerequisites: [obj('a1')] }),
  );
  const r = buildManifest(view, [obj('a1'), obj('ghost')]);
  assert.equal(r.kind, 'unknown');
  if (r.kind === 'unknown') assert.deepEqual(r.missing.map((t) => `${t.kind}:${t.id}`).sort(), ['object:ghost', 'unit:nope']);
  const cyclic = new FakeProofView().add(
    fakeObject('a1', { paths: ['a/x'], prerequisites: [obj('b1')] }),
    fakeObject('b1', { paths: ['b/x'], prerequisites: [obj('a1')] }),
  );
  const c = buildManifest(cyclic, [obj('a1')]);
  assert.equal(c.kind, 'manifest');
  if (c.kind === 'manifest') assert.deepEqual(c.manifest.entries.map((e) => e.object.id), ['a1', 'b1']);
});
