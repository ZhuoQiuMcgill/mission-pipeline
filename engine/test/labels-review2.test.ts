// Regression tests of the second review of the stored labels (A2): the
// environment events are read through the log's integrity check; a proof unit
// of any size is evaluated, its members and coverage in resumable steps; an
// object's coverage is matched path by path in resumable steps; a dependency
// cycle is reported as its whole strongly connected component; admission
// refuses malformed input only (v06 Appendix E). The stepwise evaluation stays
// equal to fullCompute (Mirror.state checks it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeConstraintCheck } from '../src/common/records.ts';
import {
  currentEnvironment,
  decisionLabels,
  dependencyCycles,
  drain,
  environmentIdentity,
  forgetObservedEnvironment,
  labelBatch,
  PATH_DEPTH_MAX,
  recompute,
  setLabelBatchLimit,
} from '../src/evaluator/index.ts';
import { appendRecords, commitProofOp, LedgerError, recordsByKind, type Memory, type WriteTx } from '../src/memory/index.ts';
import { builders, labelProject, machine, Mirror } from './labels-fixtures.ts';

let n = 0;
function w<T>(m: Memory, fn: (tx: WriteTx) => T): T {
  const op = `r2-${++n}`;
  return m.write({ op, payload: op }, fn);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    throw e;
  }
  return 'ok';
}

const review = (r: string) => ({ review: r, basisLines: [], reliesOn: [] });
const product = (id: string, o: { prereqs?: string[]; paths?: string[] } = {}) => ({
  kind: 'object.version',
  object: id,
  objectKind: 'product',
  mission: 'm1',
  module: null,
  content: '0'.repeat(64),
  prerequisites: o.prereqs ?? [],
  scope: { paths: o.paths ?? [`src/${id}.ts`], taskType: 'construct' },
  reviews: [review('reviewer')],
});
const judge = (id: string, target: string, o: { review?: string; constraints?: string[]; reliesOn?: string[] } = {}) => ({
  kind: 'judgment',
  judgment: id,
  review: o.review ?? 'reviewer',
  executor: o.review ?? 'reviewer',
  target,
  verdict: 'pass',
  evidence: [],
  bases: [],
  constraints: o.constraints ?? [],
  reliesOn: o.reliesOn ?? [],
  issues: [],
  revokes: null,
  extends: null,
  evidenceUse: { fields: ['exit'], statisticalOrExternal: false },
  superseded: [],
});

test('finding 1 (round 2): a damaged environment event is never read as the current identity: observation and decisions refuse (CHAIN_BROKEN, latched)', () => {
  const p = labelProject();
  try {
    const { m } = p;
    const linux = machine('linux')();
    const old = currentEnvironment(m, { observe: () => linux }).identity;
    const b = builders(m);
    w(m, (tx) => appendRecords(tx, [b.evidence('E', old), b.product('P'), b.judge('JP', 'P', { evidence: ['E'] }), b.pending('op', ['P'])]));
    const win = { ...linux, os: 'win32' };
    m.connection.prepare("UPDATE log SET record = json_set(record, '$.snapshot', ?) WHERE kind = 'env.snapshot'").run(environmentIdentity(win));
    forgetObservedEnvironment(m.projectDir);
    assert.equal(codeOf(() => currentEnvironment(m, { observe: () => win })), 'CHAIN_BROKEN');
    assert.notEqual(m.status().chainBroken, null, 'the break is recorded: every write is refused');
    assert.equal(codeOf(() => w(m, (tx) => commitProofOp(tx, { opId: 'op' as never }))), 'CHAIN_BROKEN');
  } finally {
    p.cleanup();
  }
});

test('finding 2 (round 2): a proof unit of 65 members over a prerequisite ring is admitted and proven, as the reference semantics says', () => {
  const p = labelProject();
  try {
    const mirror = new Mirror(p.m);
    const N = 65;
    mirror.append(Array.from({ length: N }, (_, i) => [product(`P${i}`, { prereqs: [`P${(i + 1) % N}`] }), judge(`JP${i}`, `P${i}`)]).flat());
    mirror.append([
      { kind: 'proof.unit', unit: 'U', members: Array.from({ length: N }, (_, i) => `P${i}`), reviews: [review('integration')] },
      judge('JU', 'U', { review: 'integration' }),
    ]);
    const s = mirror.state();
    assert.equal(s.targets.get('U')?.label, 'proven');
    assert.equal(s.targets.get('P7')?.label, 'proven');
  } finally {
    p.cleanup();
  }
});

test('finding 2 (round 2): a unit of 1,200 members with a constraint on all of them is evaluated in resumable steps of at most 256 units, equal to fullCompute', () => {
  const p = labelProject();
  setLabelBatchLimit(256);
  try {
    const mirror = new Mirror(p.m);
    const N = 1_200;
    const all = Array.from({ length: N }, (_, i) => `src/m${i}.ts`);
    mirror.append([{ kind: 'basis.version', basisKind: 'constraint', line: 'C', version: 'C.v1', mission: null, scope: { paths: ['src/**'], taskTypes: [] } }]);
    for (let i = 0; i < N; i += 200) {
      mirror.append(
        Array.from({ length: Math.min(200, N - i) }, (_, k) => i + k).flatMap((k) => [
          product(`M${k}`, { prereqs: [`M${(k + 1) % N}`], paths: [`src/m${k}.ts`] }),
          judge(`JM${k}`, `M${k}`, { constraints: [encodeConstraintCheck({ version: 'C.v1', paths: [`src/m${k}.ts`] })] }),
        ]),
      );
    }
    // The unit's judgment reviewed every member's path but one: its records do not hold.
    mirror.append([
      { kind: 'proof.unit', unit: 'U', members: Array.from({ length: N }, (_, k) => `M${k}`), reviews: [review('integration')] },
      judge('JU', 'U', { review: 'integration', constraints: [encodeConstraintCheck({ version: 'C.v1', paths: all })] }),
    ]);
    let batches = 0;
    for (let r = labelBatch(p.m); r !== null; r = labelBatch(p.m)) {
      // At most the target, or one step larger than it, alone (v06).
      assert.ok(r.oversized ? r.progress === 1 : r.units <= 256, `${r.units} units, ${r.progress} steps`);
      assert.ok(r.progress > 0 || r.done);
      batches++;
    }
    assert.ok(batches > 20, `${batches} batches`);
    const s = mirror.state();
    assert.equal(s.targets.get('U')?.label, 'proven');
    // A new content version of the constraint nobody reviewed: the whole unit is no longer fresh.
    mirror.append([{ kind: 'basis.version', basisKind: 'constraint', line: 'C', version: 'C.v2', mission: null, scope: null }]);
    assert.equal(mirror.state().targets.get('U')?.label, 'not-fully-proven');
  } finally {
    setLabelBatchLimit(null);
    p.cleanup();
  }
});

test('finding 3 (round 2): coverage of a 3,400-path scope is matched path by path in resumable steps; it drains, equal to fullCompute', () => {
  for (const limit of [null, 256]) {
    const p = labelProject();
    setLabelBatchLimit(limit);
    try {
      const mirror = new Mirror(p.m);
      const paths = Array.from({ length: 3_400 }, (_, i) => `a${i}/b/c/d/e`);
      mirror.append([product('P', { paths }), judge('JP', 'P')]);
      assert.equal(mirror.state().targets.get('P')?.label, 'proven');
      // A constraint on one corner of it, then a review that covers it.
      mirror.append([{ kind: 'basis.version', basisKind: 'constraint', line: 'C', version: 'C.v1', mission: null, scope: { paths: ['a3399/b/**'], taskTypes: [] } }]);
      assert.equal(mirror.state().targets.get('P')?.label, 'not-fully-proven');
      mirror.append([judge('JP2', 'P', { constraints: [encodeConstraintCheck({ version: 'C.v1', paths: ['a3399/b/c/d/e'] })] })]);
      assert.equal(mirror.state().targets.get('P')?.label, 'proven');
      recompute(p.m);
      assert.equal(p.m.read((db) => decisionLabels(db, ['P'])).P, 'proven');
    } finally {
      setLabelBatchLimit(null);
      p.cleanup();
    }
  }
});

test('finding 4 (round 2): a dependency cycle is reported as its whole strongly connected component, with the same identity after a rebuild', () => {
  const p = labelProject();
  try {
    const mirror = new Mirror(p.m);
    mirror.append([product('A'), product('B'), product('C'), judge('JA', 'A', { reliesOn: ['B', 'C'] }), judge('JB', 'B', { reliesOn: ['A'] }), judge('JC', 'C', { reliesOn: ['A'] })]);
    mirror.state();
    const cycles = p.m.read((db) => dependencyCycles(db));
    assert.deepEqual(
      cycles.map((c) => c.nodes),
      [['e:A', 'e:B', 'e:C', 'f:A', 'f:B', 'f:C', 'j:JA', 'j:JB', 'j:JC', 'p:A', 'p:B', 'p:C']],
    );
    labelBatch(p.m);
    const wi16 = (): number => p.m.read((db) => recordsByKind(db, { kinds: ['alert'] })).filter((c) => (c.record as unknown as { wi?: string }).wi === 'WI-16').length;
    assert.equal(wi16(), 1);
    p.m.rebuild();
    assert.deepEqual(p.m.read((db) => dependencyCycles(db)).map((c) => c.id), [cycles[0]!.id]);
    drain(p.m);
    assert.equal(wi16(), 1, 'the same component: no second notice');
  } finally {
    p.cleanup();
  }
});

test('admission: only malformed input is refused (a scope path deeper than PATH_DEPTH_MAX), before anything commits; nothing is refused for its size (v06)', () => {
  const p = labelProject();
  try {
    const { m } = p;
    const b = builders(m);
    const deep = Array.from({ length: PATH_DEPTH_MAX + 1 }, (_, i) => `d${i}`).join('/');
    const before = m.read((db) => recordsByKind(db, { kinds: ['object.version'], limit: 10 })).length;
    assert.equal(codeOf(() => w(m, (tx) => appendRecords(tx, [{ ...(b.product('Q') as object), scope: { paths: [deep], taskType: 'construct' } } as never]))), 'RECORD_INVALID');
    assert.equal(m.read((db) => recordsByKind(db, { kinds: ['object.version'], limit: 10 })).length, before, 'nothing committed');
    const edge = Array.from({ length: PATH_DEPTH_MAX }, (_, i) => `d${i}`).join('/');
    assert.equal(codeOf(() => w(m, (tx) => appendRecords(tx, [{ ...(b.product('Q') as object), scope: { paths: [edge], taskType: 'construct' } } as never]))), 'ok');
    // Twenty review positions and 600 judgments on one of them: admitted (the review's limits are validate.ts's: 64 positions).
    const many = Array.from({ length: 20 }, (_, i) => ({ review: `r${i}` }));
    w(m, (tx) => appendRecords(tx, [b.product('R', { reviews: many })]));
    for (let i = 0; i < 600; i += 300) w(m, (tx) => appendRecords(tx, Array.from({ length: 300 }, (_, k) => b.judge(`JR${i + k}`, 'R', { review: 'r0', verdict: 'undecided' }))));
    assert.equal(codeOf(() => w(m, (tx) => appendRecords(tx, [b.judge('JR-last', 'R', { review: 'r0' })]))), 'ok');
    drain(m);
    assert.equal(m.read((db) => decisionLabels(db, ['R'])).R, 'unaccepted');
  } finally {
    p.cleanup();
  }
});
