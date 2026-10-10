// Design 5.5 acceptance gates for the evaluator, measured on the maintainer's
// WSL machine. Run with `npm run test:perf` (not part of the default suite: it
// builds ledgers of 100,000+ records). Every update in every scenario is checked
// against the full recomputation, outside the timed part (5.5: "每个发布的修订号，
// 全部派生值都与从头完整计算的结果一致"; core review r2 F18).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fullCompute, type DerivedState, type ResolvedCommitted, type ResolvedRecord } from '../../src/evaluator/semantics.ts';
import { IncrementalDerivation } from '../../src/evaluator/incremental.ts';
import { revision, type Revision } from '../../src/common/ids.ts';

const SMALL_UPDATE_MS = 200; // 5.5: small update published within 200 ms
const FULL_BUILD_MS = 30_000; // 5.5: from-scratch build of 100,000 records

class Ledger {
  readonly records: ResolvedCommitted[] = [];
  private pending: ResolvedCommitted[] = [];
  readonly inc = new IncrementalDerivation();
  add(r: Record<string, unknown>): void {
    const c = { revision: revision(this.records.length + 1), record: r as unknown as ResolvedRecord };
    this.records.push(c);
    this.pending.push(c);
  }
  head(): Revision {
    return revision(this.records.length);
  }
  /**
   * Apply what was added since the last update; returns elapsed ms and the
   * affected-set size. Then, untimed, compare every derived map with the full
   * recomputation at this revision.
   */
  update(): { ms: number; affected: number; state: DerivedState } {
    const batch = this.pending;
    this.pending = [];
    const t0 = performance.now();
    const rep = this.inc.apply(batch, this.head());
    const ms = performance.now() - t0;
    this.assertMatchesFull();
    return { ms, affected: rep.affected, state: rep.state };
  }
  assertMatchesFull(): void {
    const want = fullCompute(this.records, this.head());
    const got = this.inc.state();
    for (const k of ['basis', 'evidenceApplicable', 'judgmentCurrent', 'positionInEffect', 'targets', 'fixes', 'ops'] as const) {
      assert.deepEqual(new Map(got[k] as ReadonlyMap<unknown, unknown>), new Map(want[k] as ReadonlyMap<unknown, unknown>), k);
    }
  }
  object(id: string, prereqs: string[] = [], reviews: unknown[] = [{ review: 'reviewer', basisLines: [], reliesOn: [] }]): void {
    this.add({
      kind: 'object.version', object: id, objectKind: 'product', mission: 'm1', module: null, content: '0'.repeat(64),
      prerequisites: prereqs, scope: { paths: [`src/${id}.ts`], taskType: 'construct' }, reviews,
    });
  }
  judge(id: string, target: string, verdict: string, evidence: string[], extra: Record<string, unknown> = {}): void {
    this.add({
      kind: 'judgment', judgment: id, review: 'reviewer', executor: 'reviewer', target, verdict, evidence,
      bases: [], constraints: [], reliesOn: [], issues: [], revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [], ...extra,
    });
  }
  env(line: string, snap: string): void {
    this.add({ kind: 'env.snapshot', line, snapshot: snap });
  }
  evidence(id: string, line: string, snap: string): void {
    this.add({ kind: 'evidence', evidence: id, envLine: line, envSnapshot: snap, runClass: 'closed', fields: { exit: '0' } });
  }
}

function label(L: Ledger, t: string): string | undefined {
  return L.inc.state().targets.get(t)?.label;
}

test('dependency graph shapes: chain of 20, diamond net (width 2, depth 6), fan-out of 200, unequal paths — every revision equals full recomputation', () => {
  const L = new Ledger();
  L.env('py', 'py@1');
  L.evidence('E', 'py', 'py@1');
  L.update();
  const step = (): void => void L.update();
  // Chain of 20.
  for (let i = 0; i < 20; i++) {
    L.object(`C${i}`, i ? [`C${i - 1}`] : []);
    L.judge(`JC${i}`, `C${i}`, 'pass', ['E']);
    step();
  }
  // Diamond net: width 2, depth 6; each layer depends on both nodes of the previous one.
  for (let d = 0; d < 6; d++) {
    for (const w of [0, 1]) {
      L.object(`D${d}_${w}`, d ? [`D${d - 1}_0`, `D${d - 1}_1`] : ['C19']);
      L.judge(`JD${d}_${w}`, `D${d}_${w}`, 'pass', ['E']);
    }
    step();
  }
  // Fan-out of 200 cross-task nodes over the diamond's last layer, and an unequal-path join.
  for (let i = 0; i < 200; i++) {
    L.object(`F${i}`, ['D5_0']);
    L.judge(`JF${i}`, `F${i}`, 'pass', ['E']);
  }
  L.object('JOIN', ['C0', 'D5_1', 'F7']);
  L.judge('JJOIN', 'JOIN', 'pass', ['E']);
  step();
  assert.equal(label(L, 'JOIN'), 'proven');
  // Evidence invalidation reaches the products; a negation is not revived by an older pass.
  L.env('py', 'py@2');
  step();
  assert.equal(label(L, 'F199'), 'not-fully-proven');
  L.evidence('E2', 'py', 'py@2');
  L.judge('JC0b', 'C0', 'fail', ['E2']);
  step();
  assert.equal(label(L, 'C0'), 'negated');
  L.env('py', 'py@1');
  step();
  assert.equal(label(L, 'C0'), 'negated', 'the older pass does not come back');
  assert.equal(label(L, 'JOIN'), 'not-fully-proven');
  // A proof unit propagates as a whole.
  L.object('UA', ['UB']);
  L.object('UB', ['UA']);
  L.judge('JUA', 'UA', 'pass', ['E']);
  L.judge('JUB', 'UB', 'pass', ['E']);
  L.add({ kind: 'proof.unit', unit: 'U', members: ['UA', 'UB'], reviews: [{ review: 'integration', basisLines: [], reliesOn: [] }] });
  L.add({ kind: 'judgment', judgment: 'JU', review: 'integration', executor: 'reviewer', target: 'U', verdict: 'pass', evidence: ['E'], bases: [], constraints: [], reliesOn: [], issues: [], revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [] });
  step();
  assert.equal(label(L, 'UA'), 'proven');
  L.add({ kind: 'evidence.revoked', evidence: 'E' });
  step();
  assert.equal(label(L, 'UA'), 'not-fully-proven');
  assert.equal(label(L, 'UB'), 'not-fully-proven');
});

test('small update latency and from-scratch build at 100,000 records (5.5)', () => {
  const L = new Ledger();
  // 1,000 modules, each a chain of 50 objects with its own environment line: 102,000 records.
  for (let m = 0; m < 1000; m++) {
    L.env(`env${m}`, `env${m}@1`);
    L.evidence(`E${m}`, `env${m}`, `env${m}@1`);
    for (let i = 0; i < 50; i++) {
      L.object(`M${m}_${i}`, i ? [`M${m}_${i - 1}`] : []);
      L.judge(`J${m}_${i}`, `M${m}_${i}`, 'pass', [`E${m}`]);
    }
  }
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  const build = L.update();
  const after = process.memoryUsage().heapUsed;
  console.log(`  from-scratch build: ${L.records.length} records in ${build.ms.toFixed(0)} ms; heap grew ${((after - before) / 2 ** 20).toFixed(0)} MiB (records already in memory)`);
  assert.ok(build.ms < FULL_BUILD_MS, `build ${build.ms} ms`);
  assert.equal(label(L, 'M999_49'), 'proven');

  // A small event: one module's environment changes (affects 100 variables).
  L.env('env500', 'env500@2');
  const small = L.update();
  console.log(`  small update: affected ${small.affected} in ${small.ms.toFixed(1)} ms`);
  assert.ok(small.affected <= 1000);
  assert.ok(small.ms < SMALL_UPDATE_MS, `small update ${small.ms} ms`);
  assert.equal(label(L, 'M500_49'), 'not-fully-proven');
  assert.equal(label(L, 'M501_49'), 'proven');

  // A new judgment at the end of one chain.
  L.judge('J7_49b', 'M7_49', 'fail', ['E7']);
  const one = L.update();
  console.log(`  one judgment: affected ${one.affected} in ${one.ms.toFixed(1)} ms`);
  assert.ok(one.ms < SMALL_UPDATE_MS);
  assert.equal(label(L, 'M7_49'), 'negated');

  // Layer-0 style reads straight from the published snapshot.
  const t0 = performance.now();
  const s = L.inc.state();
  let proven = 0;
  for (let m = 0; m < 1000; m++) if (s.targets.get(`M${m}_49`)?.label === 'proven') proven++;
  const readMs = performance.now() - t0;
  console.log(`  1,000 reads: ${readMs.toFixed(1)} ms`);
  assert.equal(proven, 998);
  assert.ok(readMs < 50);
});

test('small event, large affected set: one environment change reaches a 100,000-object chain; and back (5.5)', () => {
  const L = new Ledger();
  L.env('py', 'py@1');
  L.evidence('E', 'py', 'py@1');
  const N = 100_000;
  for (let i = 0; i < N; i++) {
    L.object(`C${i}`, i ? [`C${i - 1}`] : []);
    L.judge(`J${i}`, `C${i}`, 'pass', ['E']);
  }
  const build = L.update();
  console.log(`  build ${L.records.length} records: ${build.ms.toFixed(0)} ms`);
  assert.ok(build.ms < FULL_BUILD_MS, `build ${build.ms} ms`);
  assert.equal(label(L, `C${N - 1}`), 'proven');
  L.env('py', 'py@2');
  const down = L.update();
  console.log(`  down: affected ${down.affected} in ${down.ms.toFixed(0)} ms`);
  assert.equal(label(L, `C${N - 1}`), 'not-fully-proven');
  L.env('py', 'py@1');
  const up = L.update();
  console.log(`  up: affected ${up.affected} in ${up.ms.toFixed(0)} ms`);
  assert.equal(label(L, `C${N - 1}`), 'proven');
  // Small change, huge upstream: one change at the chain end, then a delivery and a legalization over it.
  L.judge(`J${N - 1}b`, `C${N - 1}`, 'fail', ['E']);
  const end = L.update();
  console.log(`  chain-end change: affected ${end.affected} in ${end.ms.toFixed(1)} ms`);
  assert.ok(end.ms < SMALL_UPDATE_MS);
  L.add({ kind: 'op.pending', op: 'DELIVER', opKind: 'delivery', objects: [`C${N - 2}`] });
  L.add({ kind: 'op.pending', op: 'SEAL', opKind: 'legalization', objects: [`C${N - 1}`] });
  const ops = L.update();
  assert.ok(ops.ms < SMALL_UPDATE_MS);
  assert.equal(L.inc.state().ops.get('DELIVER' as never)?.allProven, true);
  assert.equal(L.inc.state().ops.get('SEAL' as never)?.allProven, false);
  // "Proven as of R" affected after R: the head of the chain changes; the executed delivery loses proof.
  L.add({ kind: 'op.executed', op: 'DELIVER', asOf: L.head() });
  L.update();
  L.judge('J0b', 'C0', 'fail', ['E']);
  const head = L.update();
  console.log(`  chain-head negation: affected ${head.affected} in ${head.ms.toFixed(0)} ms`);
  assert.equal(L.inc.state().ops.get('DELIVER' as never)?.allProven, false);
});

test('large fan-in: one object with 100,000 required prerequisites; one fails and recovers (5.5)', () => {
  const L = new Ledger();
  L.env('py', 'py@1');
  const N = 100_000;
  for (let i = 0; i < N; i++) {
    L.evidence(`E${i}`, 'py', 'py@1');
    L.object(`P${i}`);
    L.judge(`J${i}`, `P${i}`, 'pass', [`E${i}`]);
  }
  L.evidence('EZ', 'py', 'py@1');
  L.object('Z', Array.from({ length: N }, (_, i) => `P${i}`));
  L.judge('JZ', 'Z', 'pass', ['EZ']);
  const build = L.update();
  console.log(`  build ${L.records.length} records: ${build.ms.toFixed(0)} ms`);
  assert.ok(build.ms < FULL_BUILD_MS, `build ${build.ms} ms`);
  assert.equal(label(L, 'Z'), 'proven');
  L.add({ kind: 'evidence.revoked', evidence: 'E4242' });
  const down = L.update();
  console.log(`  one prerequisite fails: affected ${down.affected} in ${down.ms.toFixed(1)} ms`);
  assert.equal(label(L, 'Z'), 'not-fully-proven');
  assert.ok(down.ms < SMALL_UPDATE_MS);
  L.evidence('E4242b', 'py', 'py@1');
  L.add({ kind: 'evidence.renewal', judgment: 'J4242', original: 'E4242', replacement: 'E4242b' });
  const up = L.update();
  console.log(`  and recovers: affected ${up.affected} in ${up.ms.toFixed(1)} ms`);
  assert.equal(label(L, 'Z'), 'proven');
  assert.ok(up.ms < SMALL_UPDATE_MS);
});

test('one environment registration affects 100,000 evidence records (5.5)', () => {
  const L = new Ledger();
  L.env('py', 'py@1');
  const N = 100_000;
  for (let i = 0; i < N; i++) L.evidence(`E${i}`, 'py', 'py@1');
  for (let k = 0; k < 10_000; k++) {
    L.object(`O${k}`);
    L.judge(`J${k}`, `O${k}`, 'pass', Array.from({ length: 10 }, (_, j) => `E${k * 10 + j}`));
  }
  const build = L.update();
  console.log(`  build ${L.records.length} records: ${build.ms.toFixed(0)} ms`);
  assert.ok(build.ms < FULL_BUILD_MS, `build ${build.ms} ms`);
  L.env('py', 'py@2');
  const r = L.update();
  console.log(`  environment change: affected ${r.affected} in ${r.ms.toFixed(0)} ms`);
  assert.equal(L.inc.state().evidenceApplicable.get('E99999' as never), false);
  assert.equal(label(L, 'O9999'), 'not-fully-proven');
});
