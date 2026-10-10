// The lineage walk of a legalization (design 11.1, 5.3): required edges only, one generation at a
// time, stopping at proven nodes; a proof unit is one node (its members are replaced by it and do
// not count each other as parents); negated or withdrawn nodes block with their required path.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ObjectVersionRecord, ProofUnitRecord, ReviewContract } from '../src/common/records.ts';
import { FakeContent } from '../src/flow/fakes.ts';
import { lineageSource, nextGeneration, requiredParents, walkLineage } from '../src/flow/audit/lineage.ts';
import type { Label } from '../src/evaluator/semantics.ts';

const c = new FakeContent();
const obj = (id: string, prereqs: string[], reliesOn: string[] = []): ObjectVersionRecord => ({
  kind: 'object.version',
  object: id as never,
  objectKind: 'product',
  mission: 'M1' as never,
  module: null,
  content: c.put(id),
  prerequisites: c.putList(prereqs),
  scope: { paths: [`${id}.ts`], taskType: 'code' },
  reviews: [{ review: 'reviewer', basisLines: [], reliesOn: reliesOn as never } satisfies ReviewContract],
});
const unit = (id: string, members: string[]): ProofUnitRecord => ({ kind: 'proof.unit', unit: id as never, members: c.putList(members), reviews: [{ review: 'integration', basisLines: [], reliesOn: [] }] });

describe('legalization lineage', () => {
  test('a proof unit is one node; members do not count each other; the walk stops at proven nodes', () => {
    // X and Y depend on each other (a unit U); Y relies on Z; the endpoint E relies on X; Z relies on P (proven), P on Q
    const src = lineageSource([obj('E', ['X']), obj('X', ['Y']), obj('Y', ['X', 'Z']), obj('Z', [], ['P']), obj('P', ['Q']), obj('Q', [])], [unit('U', ['X', 'Y'])], c);
    assert.deepEqual(requiredParents(src, 'U'), ['Z']);
    assert.deepEqual(requiredParents(src, 'E'), ['U']);
    const labels: Record<string, Label> = { E: 'not-fully-proven', U: 'unaccepted', Z: 'not-fully-proven', P: 'proven', Q: 'proven', X: 'unaccepted', Y: 'unaccepted' };
    const l = walkLineage(src, 'E', (ids) => Object.fromEntries(ids.map((i) => [i, labels[i] ?? null])));
    assert.deepEqual(l.chain, ['E', 'P', 'U', 'Z'], 'Q is behind a proven node: not walked');
    assert.deepEqual(l.pending, ['E', 'U', 'Z']);
    assert.deepEqual(l.blocked, []);
    assert.deepEqual(l.nodes.get('U')?.kind, 'unit');
    // top generation first: Z (its parent P is proven); U waits for Z; E waits for U
    const proven = new Set(['P']);
    assert.deepEqual(nextGeneration(l, (id) => proven.has(id)), ['Z']);
    proven.add('Z');
    assert.deepEqual(nextGeneration(l, (id) => proven.has(id)), ['U']);
    // an endpoint that is a member walks from its unit
    assert.equal(walkLineage(src, 'X', (ids) => Object.fromEntries(ids.map((i) => [i, labels[i] ?? null]))).endpoint, 'U');
  });

  test('a negated node blocks with its required path', () => {
    const src = lineageSource([obj('E', ['B']), obj('B', [], ['D']), obj('D', [])], [], c);
    const labels: Record<string, Label> = { E: 'not-fully-proven', B: 'not-fully-proven', D: 'negated' };
    const l = walkLineage(src, 'E', (ids) => Object.fromEntries(ids.map((i) => [i, labels[i] ?? null])));
    assert.deepEqual(l.blocked.map((b) => [b.id, b.path]), [['D', ['E', 'B', 'D']]]);
  });
});
