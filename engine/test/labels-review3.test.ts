// Regression tests of the third review of the stored labels (A2), under the
// batch-bound amendment (design 4.1 v06, Appendix E): the batch numbers are
// targets; a step is one record's work; every PM batch commits at least one
// step, a step larger than the target running alone; the batches on other
// writes stop before a step that does not fit; no admission limit exists for
// the batch size. Each case is admitted, drains, and its stepwise result
// equals fullCompute. (The reviewers' other repro modes: the cycle next to
// 50,000 objects in labels-scale.test.ts; the 3,400-path scope and the
// 65-member unit in labels-review2.test.ts.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revision, type Revision } from '../src/common/ids.ts';
import { encodeConstraintCheck } from '../src/common/records.ts';
import { decisionLabels, derivedState, drain, labelBatch, labelStatus, setLabelBatchLimit, type BatchReport } from '../src/evaluator/index.ts';
import { fullCompute, type ResolvedCommitted } from '../src/evaluator/semantics.ts';
import type { Memory } from '../src/memory/index.ts';
import { labelProject, Mirror, sameState } from './labels-fixtures.ts';

const review = (r: string) => ({ review: r, basisLines: [], reliesOn: [] });
const product = (id: string, o: { paths?: string[]; reviews?: string[]; prereqs?: string[] } = {}) => ({
  kind: 'object.version',
  object: id,
  objectKind: 'product',
  mission: 'm1',
  module: null,
  content: '0'.repeat(64),
  prerequisites: o.prereqs ?? [],
  scope: { paths: o.paths ?? [`src/${id}.ts`], taskType: 'construct' },
  reviews: (o.reviews ?? ['reviewer']).map(review),
});
const judge = (id: string, target: string, o: { review?: string; constraints?: string[]; evidence?: string[]; verdict?: string } = {}) => ({
  kind: 'judgment',
  judgment: id,
  review: o.review ?? 'reviewer',
  executor: o.review ?? 'reviewer',
  target,
  verdict: o.verdict ?? 'pass',
  evidence: o.evidence ?? [],
  bases: [],
  constraints: o.constraints ?? [],
  reliesOn: [],
  issues: [],
  revokes: null,
  extends: null,
  evidenceUse: { fields: ['exit'], statisticalOrExternal: false },
  superseded: [],
});
const constraint = (line: string, version: string, paths: string[]) => ({ kind: 'basis.version', basisKind: 'constraint', line, version, mission: null, scope: { paths, taskTypes: [] } });

/** PM batches until none is needed; each one commits a step, and stays within `limit` unless it is one step, alone (v06). */
function pmBatches(m: Memory, limit: number, max = 5_000): { batches: number; oversized: number; reports: BatchReport[] } {
  const reports: BatchReport[] = [];
  for (let r = labelBatch(m); r !== null; r = labelBatch(m)) {
    reports.push(r);
    assert.ok(r.progress > 0 || r.done, `batch ${reports.length} committed no step`);
    assert.ok(r.oversized ? r.progress === 1 : r.units <= limit, `batch ${reports.length}: ${r.units} units, ${r.progress} steps, oversized ${r.oversized}`);
    assert.ok(reports.length < max, 'the batches come to an end');
  }
  return { batches: reports.length, oversized: reports.filter((r) => r.oversized).length, reports };
}

/** The stored labels of `m` (drained) against fullCompute over every mirror's records, in log order. */
function sameAsOracle(m: Memory, ...mirrors: Mirror[]): void {
  const all: ResolvedCommitted[] = mirrors.flatMap((x) => x.accepted).sort((a, b) => Number(a.revision) - Number(b.revision));
  const at = (all.at(-1)?.revision ?? revision(0)) as Revision;
  sameState(m.read((db) => derivedState(db)), fullCompute(all, at));
}

test('round 3, scope discovery: a constraint of 1,000 patterns over 60 objects of 3,400 paths each is discovered object by object; every PM batch commits, it drains, equal to fullCompute', () => {
  const p = labelProject();
  try {
    const shared = Array.from({ length: 3_399 }, (_, i) => `a${i}/b/c/d/e`);
    const a = new Mirror(p.m);
    const N = 60;
    for (let i = 0; i < N; i += 10) a.append(Array.from({ length: 10 }, (_, k) => i + k).flatMap((k) => [product(`P${k}`, { paths: [...shared, `u${k}/x`] }), judge(`J${k}`, `P${k}`)]));
    drain(p.m);
    // The constraint arrives through a process without the labels: the PM's batches index and discover it.
    const b = new Mirror(p.reopen({ extensions: [] }));
    b.append([constraint('Z', 'Z.v1', [...Array.from({ length: 999 }, (_, i) => `z${i}/**`), 'u59/**'])]);
    const m = p.reopen();
    const t0 = performance.now();
    const r = pmBatches(m, 20_000);
    const ms = performance.now() - t0;
    assert.ok(r.batches <= 40, `${r.batches} batches`);
    assert.ok(ms < 10_000, `discovery took ${Math.round(ms)} ms`);
    assert.equal(m.read((db) => labelStatus(db)).recomputing, false);
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P0', 'P58', 'P59'])), { P0: 'proven', P58: 'proven', P59: 'not-fully-proven' });
    sameAsOracle(m, a, b);
  } finally {
    p.cleanup();
  }
});

test('round 3, reviews: an object requiring 9 review positions is admitted and proven, as fullCompute says', () => {
  const p = labelProject();
  try {
    const names = ['functionality', 'security', 'performance', 'accessibility', 'compatibility', 'privacy', 'licensing', 'integration', 'deployment'];
    const mirror = new Mirror(p.m);
    mirror.append([product('P', { reviews: names }), ...names.map((r, i) => judge(`J${i}`, 'P', { review: r }))]);
    assert.equal(mirror.state().targets.get('P')?.label, 'proven');
    // A negation on one of them, then its revocation: the position's state is kept with each judgment.
    mirror.append([judge('JN', 'P', { review: 'privacy', verdict: 'fail' })]);
    assert.equal(mirror.state().targets.get('P')?.label, 'negated');
    mirror.append([{ ...judge('JR', 'P', { review: 'privacy' }), revokes: 'JN' }]);
    assert.equal(mirror.state().targets.get('P')?.label, 'proven');
  } finally {
    p.cleanup();
  }
});

test('round 3, regressions: 501 regression registrations on one version are admitted; its fixes drain, equal to fullCompute', () => {
  for (const limit of [null, 256]) {
    const p = labelProject();
    setLabelBatchLimit(limit);
    try {
      const mirror = new Mirror(p.m);
      const run = { kind: 'evidence', evidence: 'R', envLine: 'env', envSnapshot: 's1', runClass: 'declared', fields: { exit: '0', 'test:t': 'passed', 'input:testfile:t': 'a'.repeat(64), 'input:runner:cfg': 'b'.repeat(64) } };
      mirror.append([{ kind: 'env.snapshot', line: 'env', snapshot: 's1' }, run, product('P'), judge('JP', 'P')]);
      const coverage = (i: number) => ({ kind: 'issue.coverage', issue: `N${i}`, version: 'P', evidence: 'R', command: 'test', tests: ['t'], inputs: [`testfile:t=${'a'.repeat(64)}`, `runner:cfg=${'b'.repeat(64)}`] });
      for (let i = 0; i < 500; i += 100) mirror.append(Array.from({ length: 100 }, (_, k) => coverage(i + k)));
      mirror.append([coverage(500)]);
      const fixes = mirror.state().fixes;
      assert.equal(fixes.size, 501);
      assert.ok([...fixes.values()].every((s) => s === 'fixed'));
    } finally {
      setLabelBatchLimit(null);
      p.cleanup();
    }
  }
});

test('round 3, retired constraints: after 1,000 withdrawn constraints a new one is admitted, and coverage reads only the active one (its cost does not grow with them)', () => {
  /** The units the PM batches spend to settle a new judgment on P, in a project with `retired` withdrawn constraints on src/**. */
  const settle = (retired: number): { units: number; label: string | undefined } => {
    const p = labelProject();
    try {
      const mirror = new Mirror(p.m);
      for (let i = 0; i < retired; i += 100) mirror.append(Array.from({ length: 100 }, (_, k) => constraint(`C${i + k}`, `C${i + k}.v1`, ['src/**'])));
      for (let i = 0; i < retired; i += 100) mirror.append(Array.from({ length: 100 }, (_, k) => ({ kind: 'basis.withdrawn', line: `C${i + k}` })));
      mirror.append([constraint('NEW', 'NEW.v1', ['src/**']), product('P'), judge('JP', 'P')]);
      assert.equal(mirror.state().targets.get('P')?.label, 'not-fully-proven');
      assert.deepEqual(p.m.read((db) => db.stmt('SELECT pattern, line FROM lbl_patterns').all().map((r) => ({ ...r }))), [{ pattern: 'src/**', line: 'NEW' }], 'only the active constraint is listed');
      // A review covering the new constraint, appended without the labels so that every unit of its propagation is
      // done (and counted) by the PM's batches: the labels settle at the same cost whatever the history.
      const late = new Mirror(p.reopen({ extensions: [] }));
      late.append([judge('JP2', 'P', { constraints: [encodeConstraintCheck({ version: 'NEW.v1', paths: ['src/P.ts'] })] })]);
      const m = p.reopen();
      setLabelBatchLimit(256);
      const units = pmBatches(m, 256).reports.reduce((n, r) => n + r.units, 0);
      setLabelBatchLimit(null);
      sameAsOracle(m, mirror, late);
      return { units, label: m.read((db) => derivedState(db)).targets.get('P')?.label };
    } finally {
      setLabelBatchLimit(null);
      p.cleanup();
    }
  };
  const fresh = settle(0);
  const old = settle(1_000);
  assert.equal(old.label, 'proven');
  assert.equal(fresh.label, 'proven');
  assert.equal(old.units, fresh.units, `the same work with 1,000 withdrawn constraints (${old.units}) as without (${fresh.units})`);
});

test('round 3, unit gap: a 7,000-member unit committed without the labels is indexed by one lone step of a PM batch; the batches of other writes stop before it', () => {
  const p = labelProject();
  try {
    const a = new Mirror(p.m);
    a.append([product('Q'), judge('JQ', 'Q')]);
    drain(p.m);
    const b = new Mirror(p.reopen({ extensions: [] }));
    b.append([{ kind: 'proof.unit', unit: 'U', members: Array.from({ length: 7_000 }, (_, i) => `P${i}`), reviews: [review('integration')] }]);
    const m = p.reopen();
    // Seat writes: committed, their batches stop before the large event; nothing reads as proven meanwhile.
    const c = new Mirror(m);
    for (let i = 0; i < 3; i++) c.append([{ kind: 'env.snapshot', line: `seat${i}`, snapshot: 's' }]);
    const st = m.read((db) => labelStatus(db));
    assert.equal(st.recomputing, true);
    assert.ok(st.head - st.revision >= 4, `the unit and the writes after it wait for the PM's batch (${st.head - st.revision} events)`);
    assert.equal(m.read((db) => decisionLabels(db, ['Q'])).Q, 'recomputing');
    // The PM's batch: the unit's projection runs alone and commits.
    const first = labelBatch(m)!;
    assert.equal(first.oversized, true);
    assert.equal(first.progress, 1);
    assert.ok(first.units > 20_000, `${first.units} units`);
    pmBatches(m, 20_000);
    assert.deepEqual(m.read((db) => decisionLabels(db, ['Q', 'U'])), { Q: 'proven', U: 'unaccepted' });
    sameAsOracle(m, a, b, c);
  } finally {
    p.cleanup();
  }
});

test('round 3, one large rule: a judgment citing 600 runs is evaluated as the lone step of a PM batch; the batches on other writes never run it', () => {
  const p = labelProject();
  setLabelBatchLimit(256);
  try {
    const mirror = new Mirror(p.m);
    const runs = Array.from({ length: 600 }, (_, i) => `E${i}`);
    mirror.append([{ kind: 'env.snapshot', line: 'env', snapshot: 's1' }, product('P')]);
    for (let i = 0; i < runs.length; i += 200) mirror.append(runs.slice(i, i + 200).map((e) => ({ kind: 'evidence', evidence: e, envLine: 'env', envSnapshot: 's1', runClass: 'declared', fields: { exit: '0' } })));
    drain(p.m);
    // Its own write and later seat writes: each batch stops before the rule (it reads more than 256 entries).
    mirror.append([judge('J', 'P', { evidence: runs })]);
    for (let i = 0; i < 3; i++) mirror.append([{ kind: 'env.snapshot', line: `seat${i}`, snapshot: 's' }]);
    assert.equal(p.m.read((db) => labelStatus(db)).recomputing, true);
    assert.equal(p.m.read((db) => decisionLabels(db, ['P'])).P, 'recomputing');
    const r = pmBatches(p.m, 256);
    assert.ok(r.oversized >= 1, `${r.oversized} oversized batches`);
    assert.equal(mirror.state().targets.get('P')?.label, 'proven');
  } finally {
    setLabelBatchLimit(null);
    p.cleanup();
  }
});

test('round 3, multi-budget: 30 objects of 8 positions at a 256-unit target, with and without a gap; every batch within the target or one step alone; equal to fullCompute', () => {
  for (const gap of [false, true]) {
    const p = labelProject();
    setLabelBatchLimit(256);
    try {
      const names = Array.from({ length: 8 }, (_, i) => `review${i}`);
      const mirror = new Mirror(gap ? p.reopen({ extensions: [] }) : p.m);
      const records = Array.from({ length: 30 }, (_, i) => [product(`P${i}`, { reviews: names, prereqs: i > 0 ? [`P${i - 1}`] : [] }), ...names.map((r, j) => judge(`J${i}-${j}`, `P${i}`, { review: r }))]).flat();
      for (let i = 0; i < records.length; i += 90) mirror.append(records.slice(i, i + 90));
      const m = gap ? p.reopen() : p.m;
      pmBatches(m, 256);
      assert.equal(m.read((db) => decisionLabels(db, ['P29'])).P29, 'proven');
      sameAsOracle(m, mirror);
    } finally {
      setLabelBatchLimit(null);
      p.cleanup();
    }
  }
});
