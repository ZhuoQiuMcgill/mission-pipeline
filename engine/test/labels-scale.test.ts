// Bounded label work (4.1 §4.1; review findings 6 and 7): no batch does more
// than UNIT_LIMIT units or outlasts the 2 s work budget, and every batch makes
// progress, so a drain always ends.
//
// Scenario 11 (§11): a basis withdrawn under 100,000 dependent variables. The
// withdrawal's own write stays within its budget and leaves a stored frontier;
// every later write, and `mp pm next`, does one bounded batch; meanwhile seats
// hand back and a stop arrives, every call completes, the stop is written
// without waiting for a batch, reads show "recomputing" and no decision sees
// "proven", not even for an object the withdrawal does not touch. Once drained,
// every label is what the rules say. Also: a fact with 22,000 inputs; a new
// cycle next to a proven chain of 50,000 objects; a cycle of 8,000 facts; one
// environment change reaching a chain of 100,000 objects, and back (equal to
// fullCompute), then an executed delivery losing its proof at the chain head.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id, type StopId } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';
import { currentEnvironment, decisionLabels, dependencyCycles, labelBatch, labelStatus, readLabels, setLabelBatchLimit, UNIT_LIMIT } from '../src/evaluator/index.ts';
import { appendRecords, commitProofOp, commitStop, LedgerError, recordsByKind, WORK_BUDGET_MS, type Memory } from '../src/memory/index.ts';
import { builders, labelProject, machine, Mirror } from './labels-fixtures.ts';

/** Objects under the withdrawn basis: each brings 4 dependent variables (its judgment's currency, in effect, fresh, proven). */
const OBJECTS = 25_000;

function timed<T>(fn: () => T): { out: T; ms: number } {
  const t = performance.now();
  const out = fn();
  return { out, ms: performance.now() - t };
}

test('scenario 11: a withdrawal under 100,000 dependent variables propagates in bounded batches across calls; nothing reads as proven until it is done', (t) => {
  const p = labelProject();
  try {
    const { m } = p;
    const env = currentEnvironment(m, { observe: machine('linux') }).identity;
    const b = builders(m);
    let op = 0;
    const write = (fn: Parameters<Memory['write']>[1]): unknown => m.write({ op: `s-${++op}`, payload: op }, fn);
    write((tx) => appendRecords(tx, [b.basis('B', 'B.v1'), b.basis('S', 'S.v1', 'standard'), b.evidence('E1', env)]));
    // The fan-out: every object's judgment binds B (built with the same lists, 1000 records per write).
    const evidence = m.data.putList(['E1']);
    const bases = m.data.putList(['B.v1', 'S.v1']);
    const none = m.data.putList([]);
    const content = m.data.put('content');
    let slowestSetup = 0;
    for (let i = 0; i < OBJECTS; i += 500) {
      const recs: unknown[] = [];
      for (let k = i; k < Math.min(OBJECTS, i + 500); k++) {
        recs.push({ kind: 'object.version', object: `O${k}`, objectKind: 'product', mission: 'm1', module: null, content, prerequisites: none, scope: { paths: [`src/o${k}.ts`], taskType: 'construct' }, reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }] });
        recs.push({ kind: 'judgment', judgment: `J${k}`, review: 'reviewer', executor: 'reviewer', target: `O${k}`, verdict: 'pass', evidence, bases, constraints: none, reliesOn: none, issues: [], revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [] });
      }
      slowestSetup = Math.max(slowestSetup, timed(() => write((tx) => appendRecords(tx, recs as never))).ms);
    }
    // An object outside the fan-out, with its delivery registered.
    write((tx) => appendRecords(tx, [b.product('Q'), b.judge('JQ', 'Q', { evidence: ['E1'], bases: ['S.v1'] }), b.pending('opQ', ['Q'])]));
    assert.equal(m.read((db) => labelStatus(db)).recomputing, false, 'each setup write finished its own propagation');
    assert.deepEqual(m.read((db) => decisionLabels(db, ['O0', `O${OBJECTS - 1}`, 'Q'])), { O0: 'proven', [`O${OBJECTS - 1}`]: 'proven', Q: 'proven' });
    assert.ok(slowestSetup < WORK_BUDGET_MS, `setup writes within the budget (slowest ${Math.round(slowestSetup)} ms)`);

    // The withdrawal: its write does one batch and returns.
    const wd = timed(() => write((tx) => appendRecords(tx, [b.withdraw('B')])));
    assert.ok(wd.ms < WORK_BUDGET_MS, `the withdrawal's write took ${Math.round(wd.ms)} ms`);
    let st = m.read((db) => labelStatus(db));
    assert.equal(st.recomputing, true, 'a stored frontier is left');

    // Batches across calls, with seats handing back and a stop arriving in between.
    let batches = 0;
    let slowest = 0;
    let largest = 0;
    let handbacks = 0;
    let stopped = false;
    let refusedDecisions = 0;
    while (st.recomputing) {
      // Reads: the last labels, marked recomputing; no decision sees "proven" anywhere.
      assert.deepEqual(m.read((db) => decisionLabels(db, ['O0', `O${OBJECTS - 1}`, 'Q'])), { O0: 'recomputing', [`O${OBJECTS - 1}`]: 'recomputing', Q: 'recomputing' });
      assert.equal(m.read((db) => readLabels(db, ['Q'])).states.Q?.label, 'proven', 'display: the last label');
      if (batches % 2 === 1 && handbacks < 8) {
        // A seat hands back: its write completes (its beforeWrite batch, then its own records and propagation).
        const h = timed(() => write((tx) => appendRecords(tx, [b.evidence(`H${handbacks}`, env)])));
        assert.ok(h.ms < 2 * WORK_BUDGET_MS, `a hand-back took ${Math.round(h.ms)} ms`);
        handbacks++;
      }
      if (batches === 6 && !stopped) {
        const s = timed(() => m.write({ op: 'stop', payload: 1, stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S1'), scope: { kind: 'all' }, words: 'stop', at: 1 })));
        assert.ok(s.ms < 250, `the stop is written without waiting for a batch (${Math.round(s.ms)} ms)`);
        stopped = true;
      }
      if (batches % 7 === 3) {
        try {
          write((tx) => commitProofOp(tx, { opId: 'opQ' as never }));
          assert.fail('a decision went on while the labels were recomputing');
        } catch (e) {
          // Before the stop: refused because the labels are recomputing; after it, the stop refuses first.
          assert.ok(e instanceof LedgerError && (e.code === 'RECOMPUTING' || (stopped && e.code === 'STOPPED')), String(e));
          if (e.code === 'RECOMPUTING') refusedDecisions++;
        }
      }
      const r = timed(() => labelBatch(m));
      if (r.out === null) break;
      batches++;
      slowest = Math.max(slowest, r.ms);
      largest = Math.max(largest, r.out.units);
      st = m.read((db) => labelStatus(db));
    }
    assert.ok(batches >= 10, `the work took ${batches} batches`);
    assert.ok(slowest < WORK_BUDGET_MS, `every batch inside the work budget (slowest ${Math.round(slowest)} ms)`);
    assert.ok(largest <= UNIT_LIMIT, `every batch bounded (largest ${largest} units)`);
    assert.ok(stopped && handbacks === 8 && refusedDecisions > 0, `stop ${stopped}, ${handbacks} hand-backs, ${refusedDecisions} decisions refused while recomputing`);
    assert.equal(st.recomputing, false);
    t.diagnostic(`withdrawal write ${Math.round(wd.ms)} ms; ${batches} batches (slowest ${Math.round(slowest)} ms, largest ${largest} units); slowest setup write ${Math.round(slowestSetup)} ms`);
    // Done: the rules' labels.
    assert.deepEqual(m.read((db) => decisionLabels(db, ['O0', 'O12345', `O${OBJECTS - 1}`, 'Q'])), { O0: 'basis-withdrawn', O12345: 'basis-withdrawn', [`O${OBJECTS - 1}`]: 'basis-withdrawn', Q: 'proven' });
    const counts = m.read((db) => db.stmt("SELECT label, COUNT(*) AS n FROM lbl_labels GROUP BY label ORDER BY label").all().map((r) => ({ ...r })));
    assert.deepEqual(counts, [{ label: 'basis-withdrawn', n: OBJECTS }, { label: 'proven', n: 1 }]);
    const facts = m.read((db) => db.stmt("SELECT COUNT(*) AS n FROM lbl_facts WHERE holds = 0").get() as { n: number });
    assert.ok(Number(facts.n) >= 4 * OBJECTS, `${facts.n} variables dropped`);
  } finally {
    p.cleanup();
  }
});

/** Batches until nothing is left, each checked: at most UNIT_LIMIT units, inside the work budget, some progress. */
function batchesUntilDone(m: Memory, max = 1000): { batches: number; largest: number; slowest: number } {
  let batches = 0;
  let largest = 0;
  let slowest = 0;
  for (;;) {
    const r = timed(() => labelBatch(m));
    if (r.out === null) break;
    batches++;
    assert.ok(r.out.units <= UNIT_LIMIT, `batch ${batches}: ${r.out.units} units`);
    assert.ok(r.out.progress > 0 || r.out.done, `batch ${batches} made progress`);
    assert.ok(r.ms < WORK_BUDGET_MS, `batch ${batches} took ${Math.round(r.ms)} ms`);
    largest = Math.max(largest, r.out.units);
    slowest = Math.max(slowest, r.ms);
    assert.ok(batches < max, 'the batches come to an end');
  }
  return { batches, largest, slowest };
}

test('finding 6: a fact with 22,000 inputs is counted and evaluated in resumable chunks, never more than UNIT_LIMIT units per batch', (t) => {
  const N = 22_000;
  const p = labelProject();
  try {
    const { m } = p;
    const b = builders(m);
    let op = 0;
    const write = (fn: Parameters<Memory['write']>[1]): unknown => m.write({ op: `fi-${++op}`, payload: op }, fn);
    for (let i = 0; i < N; i += 500) write((tx) => appendRecords(tx, Array.from({ length: Math.min(500, N - i) }, (_, j) => `Q${i + j}`).flatMap((q) => [b.product(q), b.judge(`J${q}`, q)])));
    write((tx) => appendRecords(tx, [b.product('P', { prereqs: Array.from({ length: N }, (_, i) => `Q${i}`) }), b.judge('JP', 'P')]));
    batchesUntilDone(m);
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P'])), { P: 'proven' });
    // A new judgment on P: its write does one batch; the rest goes in bounded batches.
    const wd = timed(() => write((tx) => appendRecords(tx, [b.judge('JP2', 'P')])));
    assert.ok(wd.ms < WORK_BUDGET_MS);
    const r = batchesUntilDone(m);
    t.diagnostic(`fan-in ${N}: ${r.batches} more batches, largest ${r.largest} units, slowest ${Math.round(r.slowest)} ms`);
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P'])), { P: 'proven' });
    // One input lost: P is not fully proven any more.
    write((tx) => appendRecords(tx, [b.judge('NQ7', 'Q7', { verdict: 'fail' })]));
    batchesUntilDone(m);
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P', 'Q7'])), { P: 'not-fully-proven', Q7: 'negated' });
  } finally {
    p.cleanup();
  }
});

test('finding 6: a new cycle next to a proven chain of 50,000 objects is found without walking the chain, in bounded batches; WI-16 raised once', (t) => {
  const N = 50_000;
  const p = labelProject();
  try {
    const { m } = p;
    const b = builders(m);
    let op = 0;
    const write = (fn: Parameters<Memory['write']>[1]): unknown => m.write({ op: `cy-${++op}`, payload: op }, fn);
    for (let i = 0; i < N; i += 500) {
      const records: BaseRecord[] = [];
      for (let k = i; k < Math.min(i + 500, N); k++) records.push(b.product(`Q${k}`, { prereqs: k === 0 ? [] : [`Q${k - 1}`] }), b.judge(`JQ${k}`, `Q${k}`));
      write((tx) => appendRecords(tx, records));
    }
    batchesUntilDone(m);
    assert.deepEqual(m.read((db) => decisionLabels(db, [`Q${N - 1}`])), { [`Q${N - 1}`]: 'proven' });
    const wd = timed(() => m.write({}, (tx) => appendRecords(tx, [b.product('P'), b.judge('JP', 'P', { reliesOn: ['P', `Q${N - 1}`] })])));
    assert.ok(wd.ms < WORK_BUDGET_MS, `the write took ${Math.round(wd.ms)} ms`);
    const r = batchesUntilDone(m);
    t.diagnostic(`cycle next to a chain of ${N}: write ${Math.round(wd.ms)} ms, then ${r.batches} batches`);
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P', `Q${N - 1}`])), { P: 'not-fully-proven', [`Q${N - 1}`]: 'proven' });
    const cycles = m.read((db) => dependencyCycles(db));
    assert.deepEqual(cycles.map((c) => c.nodes), [['e:P', 'f:P', 'j:JP', 'p:P']]);
    const wi16 = m.read((db) => recordsByKind(db, { kinds: ['alert'] })).filter((c) => (c.record as unknown as { wi?: string }).wi === 'WI-16');
    assert.equal(wi16.length, 1);
  } finally {
    p.cleanup();
  }
});

test('finding 6: a cycle of 8,000 facts is walked and closed across many small batches, each within its limit', () => {
  const N = 2_000;
  const p = labelProject();
  setLabelBatchLimit(256);
  try {
    const { m } = p;
    const b = builders(m);
    // A ring: each object's judgment relies on the next object; the last on the first.
    const records: BaseRecord[] = [];
    for (let k = 0; k < N; k++) records.push(b.product(`R${k}`), b.judge(`JR${k}`, `R${k}`, { reliesOn: [`R${(k + 1) % N}`] }));
    for (let i = 0; i < records.length; i += 1000) m.write({}, (tx) => appendRecords(tx, records.slice(i, i + 1000)));
    let batches = 0;
    for (;;) {
      const r = labelBatch(m);
      if (r === null) break;
      batches++;
      assert.ok(r.units <= 256, `${r.units} units`);
      assert.ok(r.progress > 0 || r.done);
      assert.ok(batches < 5000);
    }
    assert.ok(batches > 20, `${batches} batches`);
    assert.deepEqual(m.read((db) => decisionLabels(db, ['R0', `R${N - 1}`])), { R0: 'not-fully-proven', [`R${N - 1}`]: 'not-fully-proven' });
    const cycles = m.read((db) => dependencyCycles(db));
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0]!.nodes.length, 4 * N);
    assert.ok(cycles[0]!.throughJudgment);
  } finally {
    setLabelBatchLimit(null);
    p.cleanup();
  }
});

/** PM batches until none is needed, each checked under the v06 rules: it commits a step; within the targets unless it is one step, alone. */
function pmDrain(m: Memory): { batches: number; largest: number; slowest: number } {
  let batches = 0;
  let largest = 0;
  let slowest = 0;
  for (;;) {
    const r = timed(() => labelBatch(m));
    if (r.out === null) break;
    batches++;
    assert.ok(r.out.progress > 0 || r.out.done, `batch ${batches} committed no step`);
    if (r.out.oversized) assert.equal(r.out.progress, 1, `batch ${batches}: an oversized step runs alone`);
    else {
      assert.ok(r.out.units <= UNIT_LIMIT, `batch ${batches}: ${r.out.units} units`);
      assert.ok(r.ms < WORK_BUDGET_MS, `batch ${batches} took ${Math.round(r.ms)} ms`);
      largest = Math.max(largest, r.out.units);
      slowest = Math.max(slowest, r.ms);
    }
    assert.ok(batches < 200_000, 'the batches come to an end');
  }
  return { batches, largest, slowest };
}

test('one environment change reaches a chain of 100,000 objects, and back: drained under the v06 rules, equal to fullCompute; then an executed delivery loses its proof at the chain head', (t) => {
  const N = 100_000;
  const p = labelProject();
  try {
    const { m } = p;
    const mirror = new Mirror(m);
    const obj = (k: number) => ({
      kind: 'object.version', object: `C${k}`, objectKind: 'product', mission: 'm1', module: null, content: '0'.repeat(64),
      prerequisites: k > 0 ? [`C${k - 1}`] : [], scope: { paths: [`src/c${k}.ts`], taskType: 'construct' }, reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
    });
    const jdg = (j: string, target: string, verdict = 'pass') => ({
      kind: 'judgment', judgment: j, review: 'reviewer', executor: 'reviewer', target, verdict, evidence: ['E'], bases: [], constraints: [], reliesOn: [],
      issues: [], revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [],
    });
    // a v51 environment line other than 4.1's ENV_LINE: there a snapshot change still invalidates (4.1.2 only labels
    // a run on ENV_LINE "older environment"), so one change still propagates through the whole chain
    mirror.append([{ kind: 'env.snapshot', line: 'lab', snapshot: 's1' }, { kind: 'evidence', evidence: 'E', envLine: 'lab', envSnapshot: 's1', runClass: 'declared', fields: { exit: '0' } }]);
    const t0 = performance.now();
    for (let i = 0; i < N; i += 500) mirror.append(Array.from({ length: Math.min(500, N - i) }, (_, k) => i + k).flatMap((k) => [obj(k), jdg(`J${k}`, `C${k}`)]));
    const built = pmDrain(m);
    const setupMs = performance.now() - t0;
    assert.equal(mirror.state().targets.get(`C${N - 1}`)?.label, 'proven');
    const last = [`C0`, `C${N / 2}`, `C${N - 1}`];
    // Down: one environment change; every run under it stops applying, the whole chain loses its proof.
    mirror.append([{ kind: 'env.snapshot', line: 'lab', snapshot: 's2' }]);
    assert.equal(m.read((db) => labelStatus(db)).recomputing, true);
    assert.deepEqual(m.read((db) => decisionLabels(db, last)), Object.fromEntries(last.map((x) => [x, 'recomputing'])));
    const t1 = performance.now();
    const down = pmDrain(m);
    const downMs = performance.now() - t1;
    assert.deepEqual(m.read((db) => decisionLabels(db, last)), Object.fromEntries(last.map((x) => [x, 'not-fully-proven'])));
    mirror.state();
    // Up: the environment comes back.
    mirror.append([{ kind: 'env.snapshot', line: 'lab', snapshot: 's1' }]);
    const t2 = performance.now();
    const up = pmDrain(m);
    const upMs = performance.now() - t2;
    assert.deepEqual(m.read((db) => decisionLabels(db, last)), Object.fromEntries(last.map((x) => [x, 'proven'])));
    mirror.state();
    // A small change at the chain end, then a delivery and a legalization over it.
    mirror.append([jdg(`J${N - 1}b`, `C${N - 1}`, 'fail')]);
    mirror.append([
      { kind: 'op.pending', op: 'DELIVER', opKind: 'delivery', objects: [`C${N - 2}`] },
      { kind: 'op.pending', op: 'SEAL', opKind: 'legalization', objects: [`C${N - 1}`] },
    ]);
    pmDrain(m);
    let s = mirror.state();
    assert.equal(s.ops.get('DELIVER' as never)?.allProven, true);
    assert.equal(s.ops.get('SEAL' as never)?.allProven, false);
    // The delivery executes; then the chain head is negated: the executed delivery loses its proof (one episode notice).
    mirror.append([{ kind: 'op.executed', op: 'DELIVER', asOf: m.read((db) => labelStatus(db)).head }]);
    pmDrain(m);
    mirror.append([jdg('J0b', 'C0', 'fail')]);
    const t3 = performance.now();
    const head = pmDrain(m);
    const headMs = performance.now() - t3;
    s = mirror.state();
    assert.equal(s.ops.get('DELIVER' as never)?.allProven, false);
    const episodes = m.read((db) => recordsByKind(db, { kinds: ['notice'] })).filter((c) => String((c.record as unknown as { notice: string }).notice).startsWith('["episode","DELIVER"'));
    assert.deepEqual(episodes.map((c) => (c.record as unknown as { notice: string }).notice), [JSON.stringify(['episode', 'DELIVER', 1, 'start'])]);
    t.diagnostic(
      `chain ${N}: setup ${Math.round(setupMs)} ms (+${built.batches} batches); down ${down.batches} batches ${Math.round(downMs)} ms (largest ${down.largest} units, slowest ${Math.round(down.slowest)} ms); ` +
        `up ${up.batches} batches ${Math.round(upMs)} ms; head negation ${head.batches} batches ${Math.round(headMs)} ms`,
    );
  } finally {
    p.cleanup();
  }
});
