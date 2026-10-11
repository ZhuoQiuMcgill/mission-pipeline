// Program ref names (refs.ts). Creating the delivery ref (`git update-ref <ref>
// <D> ""`, create-only) is tested with the delivery (git41-deliver.test.ts).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { id, type MissionId, type OpId } from '../src/common/ids.ts';
import { asProgramRef, deliveryRef, encodeRefComponent, programRef } from '../src/git/refs.ts';
import { initRepo, makeFixture, type Fixture } from './git-fixtures.test.ts';

let fx: Fixture;
let repo: string;

before(() => {
  fx = makeFixture('refs');
  repo = initRepo(fx);
});
after(() => fx.cleanup());

test('delivery refs live under refs/mission-pipeline/ with ids encoded into valid ref components', () => {
  const name = deliveryRef(id<MissionId>('m:1'), id<OpId>('op.2..x'));
  assert.equal(name, 'refs/mission-pipeline/delivered/m%3A1/op%2E2%2E%2Ex');
  assert.equal(fx.rawStatus(['check-ref-format', name], repo).code, 0);
  assert.equal(asProgramRef(name), name, 'a name this module produced is accepted back');
  assert.equal(programRef('a', 'b c'), 'refs/mission-pipeline/a/b%20c');
  assert.equal(encodeRefComponent('é'), '%C3%A9', 'UTF-8 bytes, each percent-encoded');
  assert.throws(() => encodeRefComponent(''), /empty ref component/);
  assert.throws(() => programRef(), /at least one component/);
  assert.throws(() => asProgramRef('refs/heads/main'), /not a program ref/);
  assert.throws(() => asProgramRef('refs/mission-pipeline/a:b'), /encoded alphabet/);
});
