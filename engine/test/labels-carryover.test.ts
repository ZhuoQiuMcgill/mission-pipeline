// Label behaviours whose tests went with the 4.0 evaluator (package A6), on the
// stored labels of 4.1: ids containing '@', '|' or ':' never collide in fix
// keys, review positions or node ids; continuations, including one that
// carries a renewed input, are judged by the records of their own time; a
// dependency cycle's lifecycle (found once, kept through unrelated changes and
// a rebuild, broken, closed again, replaced). Every sequence is appended one
// record per write, and after each write the drained stored labels equal
// fullCompute (Mirror.state). (One environment change reaching a chain of
// 100,000 objects: labels-scale.test.ts.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixKey, reviewPosition } from '../src/common/records.ts';
import { decisionLabels, dependencyCycles, fixStates } from '../src/evaluator/index.ts';
import type { ContinuationRequest, DerivedState } from '../src/evaluator/semantics.ts';
import { recordsByKind, type Memory } from '../src/memory/index.ts';
import { labelProject, Mirror } from './labels-fixtures.ts';

const env = (snapshot = 's1') => ({ kind: 'env.snapshot', line: 'env', snapshot });
const ev = (evidence: string, fields: Record<string, string> = { exit: '0' }, snapshot = 's1') => ({ kind: 'evidence', evidence, envLine: 'env', envSnapshot: snapshot, runClass: 'declared', fields });
const obj = (object: string, extra: Record<string, unknown> = {}) => ({
  kind: 'object.version',
  object,
  objectKind: 'product',
  mission: 'm1',
  module: null,
  content: '0'.repeat(64),
  prerequisites: [],
  scope: { paths: [`src/${object}.ts`], taskType: 'construct' },
  reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
  ...extra,
});
const jdg = (judgment: string, target: string, evidence: string[], extra: Record<string, unknown> = {}) => ({
  kind: 'judgment',
  judgment,
  review: 'reviewer',
  executor: 'reviewer',
  target,
  verdict: 'pass',
  evidence,
  bases: [],
  constraints: [],
  reliesOn: [],
  issues: [],
  revokes: null,
  extends: null,
  evidenceUse: { fields: ['exit'], statisticalOrExternal: false },
  superseded: [],
  ...extra,
});

/** One write per record; after each the drained stored labels equal fullCompute. Returns the last state. */
function stepwise(mirror: Mirror, recs: ReadonlyArray<Record<string, unknown>>): DerivedState {
  let last: DerivedState | undefined;
  for (const r of recs) {
    mirror.append([r]);
    last = mirror.state();
  }
  return last!;
}

function project<T>(fn: (m: Memory, reopen: () => Memory, rebuild: () => void) => T): T {
  const p = labelProject();
  try {
    return fn(
      p.m,
      () => p.reopen(),
      () => p.m.rebuild(),
    );
  } finally {
    p.cleanup();
  }
}

test('ids containing "@", "|" or ":" never collide in fix keys, review positions or node ids; stepwise equal to fullCompute', () => {
  // Encodings that join with a separator collide: ("N@P", "Q") and ("N", "P@Q") would both give "N@P@Q".
  assert.notEqual(fixKey('N@P', 'Q'), fixKey('N', 'P@Q'));
  assert.notEqual(fixKey('N:P', 'Q'), fixKey('N', 'P:Q'));
  assert.notEqual(reviewPosition('A|r', 'x'), reviewPosition('A', 'r|x'));
  assert.notEqual(reviewPosition('A:r', 'x'), reviewPosition('A', 'r:x'));
  project((m) => {
    const fields = { exit: '0', 'test:t1': 'passed', 'input:testfile:t.py': 'h1', 'input:runner:cfg': 'h1' };
    const cov = (issue: string, version: string) => ({ kind: 'issue.coverage', issue, version, evidence: 'E1', command: 'pytest', tests: ['t1'], inputs: ['testfile:t.py=h1', 'runner:cfg=h1'] });
    const s = stepwise(new Mirror(m), [
      env(),
      ev('E1', fields),
      obj('Q'),
      obj('P@Q'),
      obj('P:Q'),
      jdg('JQ', 'Q', ['E1']),
      jdg('JPQ', 'P@Q', ['E1']),
      jdg('JPQ2', 'P:Q', ['E1']),
      cov('N@P', 'Q'),
      cov('N', 'P@Q'),
      cov('N:P', 'Q'),
      cov('N', 'P:Q'),
      // Only Q changes: its issues reopen, the other versions' do not.
      jdg('JQ2', 'Q', ['E1'], { verdict: 'fail' }),
      // Review positions whose joined encodings would collide: (A|r, x) and (A, r|x); (B:r, x) and (B, r:x).
      obj('A|r', { reviews: [{ review: 'x', basisLines: [], reliesOn: [] }] }),
      obj('A', { reviews: [{ review: 'r|x', basisLines: [], reliesOn: [] }] }),
      jdg('JA1', 'A|r', ['E1'], { review: 'x', executor: 'x' }),
      jdg('JA2', 'A', ['E1'], { review: 'r|x', executor: 'r|x', verdict: 'fail' }),
      obj('B:r', { reviews: [{ review: 'x', basisLines: [], reliesOn: [] }] }),
      obj('B', { reviews: [{ review: 'r:x', basisLines: [], reliesOn: [] }] }),
      jdg('JB1', 'B:r', ['E1'], { review: 'x', executor: 'x' }),
      jdg('JB2', 'B', ['E1'], { review: 'r:x', executor: 'r:x', verdict: 'fail' }),
      // A judgment id with ':' on an object id with ':', relying on another (node ids "j:K:1", "e:R:1", "p:P:Q").
      obj('R:1'),
      jdg('K:1', 'R:1', ['E1'], { reliesOn: ['P:Q'] }),
    ]);
    assert.equal(s.fixes.get(fixKey('N@P', 'Q')), 'unfixed');
    assert.equal(s.fixes.get(fixKey('N', 'P@Q')), 'fixed');
    assert.equal(s.fixes.get(fixKey('N:P', 'Q')), 'unfixed');
    assert.equal(s.fixes.get(fixKey('N', 'P:Q')), 'fixed');
    assert.equal(s.positionInEffect.get(reviewPosition('A|r', 'x')), true);
    assert.equal(s.positionInEffect.get(reviewPosition('A', 'r|x')), false);
    assert.equal(s.positionInEffect.get(reviewPosition('B:r', 'x')), true);
    assert.equal(s.positionInEffect.get(reviewPosition('B', 'r:x')), false);
    assert.equal(s.judgmentCurrent.get('K:1' as never), true);
    assert.deepEqual(m.read((db) => decisionLabels(db, ['Q', 'P@Q', 'P:Q', 'R:1', 'A|r', 'A', 'B:r', 'B'])), {
      Q: 'negated',
      'P@Q': 'proven',
      'P:Q': 'proven',
      'R:1': 'proven',
      'A|r': 'proven',
      A: 'negated',
      'B:r': 'proven',
      B: 'negated',
    });
    const states = m.read((db) => fixStates(db, [fixKey('N@P', 'Q'), fixKey('N', 'P@Q')])).states;
    assert.deepEqual({ ...states }, { [fixKey('N@P', 'Q')]: 'unfixed', [fixKey('N', 'P@Q')]: 'fixed' });
  });
});

test('continuations: one carrying the renewed original of its predecessor instead of the evidence in force is not current; one carrying the evidence in force is', () => {
  const rs = [env(), ev('E1'), ev('E2'), obj('A'), jdg('J0', 'A', ['E1']), { kind: 'evidence.renewal', judgment: 'J0', original: 'E1', replacement: 'E2' }, obj('B', { predecessor: 'A' })];
  project((m) => {
    const s = stepwise(new Mirror(m), [...rs, jdg('J1', 'B', ['E1'], { extends: 'J0' }), { kind: 'evidence.revoked', evidence: 'E2' }]);
    assert.equal(s.judgmentCurrent.get('J1' as never), false);
    assert.notEqual(s.targets.get('B')?.label, 'proven');
  });
  project((m) => {
    const s = stepwise(new Mirror(m), [...rs, jdg('J1', 'B', ['E2'], { extends: 'J0' })]);
    assert.equal(s.judgmentCurrent.get('J1' as never), true);
    assert.equal(s.targets.get('B')?.label, 'proven');
  });
});

test('continuations: the check refuses one whose predecessor is not current outside the batch, and the labels agree', () => {
  project((m) => {
    const mirror = new Mirror(m);
    const rs = [env(), ev('E1'), ev('E2'), obj('A'), jdg('J0', 'A', ['E1']), { kind: 'evidence.revoked', evidence: 'E1' }, obj('B', { predecessor: 'A' })];
    stepwise(mirror, rs);
    const superseded = [{ input: 'E1', by: 'E2' }];
    const req: ContinuationRequest = { extends: 'J0' as never, target: 'B', review: 'reviewer', changedLines: [], draft: { evidence: ['E2'], bases: [], constraints: [], reliesOn: [] }, superseded };
    assert.deepEqual(mirror.continuation(req), { ok: false, reason: 'not-current-outside-changes' });
    const s = stepwise(mirror, [jdg('J1', 'B', ['E2'], { extends: 'J0', superseded })]);
    assert.equal(s.judgmentCurrent.get('J1' as never), false);
    assert.notEqual(s.targets.get('B')?.label, 'proven');
  });
});

test('continuations: recorded before the judgment they continue, or before a renewal of it, they are checked again when it arrives', () => {
  project((m) => {
    stepwise(new Mirror(m), [env(), ev('E1'), obj('P'), obj('Q'), jdg('K', 'Q', ['E1'], { extends: 'J0' }), jdg('J0', 'Q', ['E1'])]);
  });
  project((m) => {
    const s = stepwise(new Mirror(m), [
      env('s1'),
      ev('E1'),
      obj('Q'),
      jdg('J0', 'Q', ['E1']),
      env('s2'),
      ev('E2', { exit: '0' }, 's2'),
      jdg('K', 'Q', ['E2'], { extends: 'J0' }),
      { kind: 'evidence.renewal', judgment: 'J0', original: 'E1', replacement: 'E2' },
    ]);
    assert.ok(s.targets.has('Q'));
  });
});

test('continuations: an accepted one is judged by the records of its own time; later renewals and negations of its predecessor do not change it', () => {
  project((m) => {
    const s = stepwise(new Mirror(m), [
      env(),
      ev('E1'),
      ev('E2'),
      obj('M1'),
      jdg('J0', 'M1', ['E1']),
      obj('M2', { predecessor: 'M1' }),
      jdg('K', 'M2', ['E2'], { extends: 'J0', superseded: [{ input: 'E1', by: 'E2' }] }),
      obj('Y'),
      jdg('KY', 'Y', ['E2'], { extends: 'J0', superseded: [{ input: 'E1', by: 'E2' }] }), // an unrelated object
      ev('E3'),
      { kind: 'evidence.renewal', judgment: 'J0', original: 'E1', replacement: 'E3' },
      jdg('J0n', 'M1', ['E3'], { verdict: 'fail' }),
      obj('M3', { predecessor: 'M1' }),
      jdg('K3', 'M3', ['E3'], { extends: 'J0' }), // J0 no longer decides its position
      { kind: 'evidence.revoked', evidence: 'E1' },
    ]);
    assert.equal(s.judgmentCurrent.get('K' as never), true);
    assert.equal(s.targets.get('M2')?.label, 'proven');
    assert.equal(s.judgmentCurrent.get('KY' as never), false);
    assert.equal(s.judgmentCurrent.get('K3' as never), false);
  });
});

test('a dependency cycle: found once with one WI-16 notice, kept by its identity through unrelated changes, environment changes and a rebuild; broken, closed again, replaced', () => {
  project((m0, _reopen, rebuild) => {
    const m = m0;
    const mirror = new Mirror(m);
    const wi16 = (): number => m.read((db) => recordsByKind(db, { kinds: ['alert'] })).filter((c) => (c.record as unknown as { wi?: string }).wi === 'WI-16').length;
    const cycles = () => m.read((db) => dependencyCycles(db));
    // A's judgment relies on B, B's on A: the second closes the cycle.
    stepwise(mirror, [env(), ev('E1'), obj('A'), obj('B'), obj('C'), jdg('JC', 'C', ['E1']), jdg('JA', 'A', ['E1'], { reliesOn: ['B'] })]);
    assert.deepEqual(cycles(), []);
    assert.equal(wi16(), 0);
    stepwise(mirror, [jdg('JB', 'B', ['E1'], { reliesOn: ['A'] })]);
    const found = cycles();
    assert.equal(found.length, 1);
    const nodes = found[0]!.nodes;
    assert.ok(nodes.includes('j:JA') && nodes.includes('j:JB') && nodes.includes('p:A') && nodes.includes('p:B'), JSON.stringify(nodes));
    assert.ok(!nodes.some((n) => n.endsWith(':C') || n === 'j:JC'), 'nodes off the cycle are not part of it');
    assert.ok(found[0]!.throughJudgment);
    assert.equal(wi16(), 1, 'one notice, raised when it is found');
    const id = found[0]!.id;
    // Unrelated changes, and environment changes that evaluate the cycle again: the same cycle, no new notice.
    stepwise(mirror, [obj('D'), jdg('JD', 'D', ['E1']), ev('E2'), { kind: 'evidence.revoked', evidence: 'E2' }, env('s2'), env('s1')]);
    assert.deepEqual(cycles().map((c) => c.id), [id]);
    assert.equal(wi16(), 1);
    // A rebuild finds it by the same identity (the identity does not depend on the evaluation order).
    rebuild();
    mirror.state();
    assert.deepEqual(cycles().map((c) => c.id), [id]);
    assert.equal(wi16(), 1);
    // Broken: B judged again without relying on A.
    stepwise(mirror, [jdg('JB2', 'B', ['E1'])]);
    assert.deepEqual(cycles(), []);
    assert.equal(m.read((db) => decisionLabels(db, ['A', 'B'])).B, 'proven');
    // Closed again by another judgment: another cycle (other members), one more notice.
    stepwise(mirror, [jdg('JB3', 'B', ['E1'], { reliesOn: ['A'] })]);
    const again = cycles();
    assert.equal(again.length, 1);
    assert.notEqual(again[0]!.id, id);
    assert.ok(again[0]!.nodes.includes('j:JB3') && !again[0]!.nodes.includes('j:JB'));
    assert.equal(wi16(), 2);
    // Replaced: a new deciding judgment on A that still relies on B closes a different cycle; the replaced one is gone.
    stepwise(mirror, [jdg('JA2', 'A', ['E1'], { reliesOn: ['B'] })]);
    const swapped = cycles();
    assert.equal(swapped.length, 1, JSON.stringify(swapped));
    assert.ok(swapped[0]!.nodes.includes('j:JA2') && !swapped[0]!.nodes.includes('j:JA'), JSON.stringify(swapped[0]!.nodes));
    assert.notEqual(swapped[0]!.id, again[0]!.id);
    assert.equal(wi16(), 3);
    assert.deepEqual(m.read((db) => decisionLabels(db, ['A', 'B', 'C'])), { A: 'not-fully-proven', B: 'not-fully-proven', C: 'proven' });
  });
});
