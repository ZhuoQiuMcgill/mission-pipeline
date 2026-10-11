// Stored labels in the project memory (4.1 §4.1): propagation inside the
// triggering write, the stored frontier and its batches, the gate of decisions
// that need "proven", stops never held back, the WI-32 and WI-16 notices, and
// the reads (layer 0 and 1, deciding views, continuation checks).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id, type StopId } from '../src/common/ids.ts';
import {
  continuationCheck,
  currentEnvironment,
  decidingViews,
  decisionLabels,
  dependencyCycles,
  drain,
  FRONTIER_NOTICE_MS,
  judgmentStates,
  labelBatch,
  labelStatus,
  labelSummary,
  opStates,
  readLabels,
  setLabelBatchLimit,
} from '../src/evaluator/index.ts';
import { appendRecords, commitProofOp, commitStop, LedgerError, recordsByKind, stopInfo, type Memory, type WriteTx } from '../src/memory/index.ts';
import { builders, labelProject, machine } from './labels-fixtures.ts';

let n = 0;
/** One write with a fresh operation id. */
function w<T>(m: Memory, fn: (tx: WriteTx) => T): T {
  const op = `t-${++n}`;
  return m.write({ op, payload: op }, fn);
}

function append(m: Memory, records: Parameters<typeof appendRecords>[1]): void {
  w(m, (tx) => appendRecords(tx, records));
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    throw e;
  }
  return 'ok';
}

/** A proven product P (evidence E1 on the current identity, basis B) and an unrelated proven product Q; their delivery operations. */
function provenWorld(m: Memory): { env: string } {
  const env = currentEnvironment(m, { observe: machine('linux') }).identity;
  const b = builders(m);
  append(m, [b.basis('B', 'B.v1'), b.basis('S', 'S.v1', 'standard'), b.evidence('E1', env), b.product('P'), b.judge('JP', 'P', { evidence: ['E1'], bases: ['B.v1', 'S.v1'] })]);
  append(m, [b.product('Q'), b.judge('JQ', 'Q', { evidence: ['E1'], bases: ['S.v1'] }), b.pending('opP', ['P']), b.pending('opQ', ['Q'])]);
  return { env };
}

/** N more products judged on the standard S: revising S then touches about 8 nodes each, more than a small batch. */
function crowd(m: Memory, n: number): void {
  const b = builders(m);
  append(m, Array.from({ length: n }, (_, i) => `C${i}`).flatMap((o) => [b.product(o), b.judge(`J${o}`, o, { evidence: ['E1'], bases: ['S.v1'] })]));
}

test('a small change is finished inside the write that records it: labels current when the write returns', () => {
  const p = labelProject();
  try {
    const { m } = p;
    provenWorld(m);
    let st = m.read((db) => labelStatus(db));
    assert.equal(st.recomputing, false);
    assert.equal(st.revision, st.head);
    assert.equal(m.read((db) => readLabels(db, ['P'])).states.P?.label, 'proven');
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P', 'Q', 'nope'])), { P: 'proven', Q: 'proven', nope: null });
    append(m, [builders(m).withdraw('B')]);
    st = m.read((db) => labelStatus(db));
    assert.equal(st.recomputing, false, 'no batch needed after the write');
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P', 'Q'])), { P: 'basis-withdrawn', Q: 'proven' });
    assert.deepEqual(m.read((db) => judgmentStates(db, ['JP', 'JQ', 'nope'])).current, { JP: false, JQ: true, nope: null });
    assert.deepEqual(m.read((db) => opStates(db, ['opP', 'opQ'])).states, {
      opP: { kind: 'delivery', allProven: false, executedAsOf: null },
      opQ: { kind: 'delivery', allProven: true, executedAsOf: null },
    });
  } finally {
    p.cleanup();
  }
});

test('every write finishes its own propagation at its end, with or without an operation id; a larger one leaves the rest, read as "recomputing"', () => {
  const p = labelProject();
  try {
    const { m } = p;
    provenWorld(m);
    m.write({}, (tx) => appendRecords(tx, [builders(m).withdraw('B')]));
    assert.equal(m.read((db) => labelStatus(db)).recomputing, false, 'finished in the write (beforeCommit)');
    assert.equal(m.read((db) => readLabels(db, ['P'])).states.P?.label, 'basis-withdrawn');
    crowd(m, 60);
    setLabelBatchLimit(256);
    m.write({}, (tx) => appendRecords(tx, [builders(m).basis('S', 'S.v2', 'standard')]));
    assert.equal(m.read((db) => labelStatus(db)).recomputing, true);
    const shown = m.read((db) => readLabels(db, ['Q']));
    assert.equal(shown.status.recomputing, true);
    assert.equal(shown.states.Q?.label, 'proven', 'the last label, marked recomputing by the status');
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P', 'Q'])), { P: 'recomputing', Q: 'recomputing' });
    // Every later write first does one batch (beforeWrite); `mp pm next` does the same with labelBatch.
    for (let i = 0; i < 40 && m.read((db) => labelStatus(db)).recomputing; i++) w(m, () => null);
    assert.equal(m.read((db) => labelStatus(db)).recomputing, false);
    assert.equal(m.read((db) => readLabels(db, ['Q'])).states.Q?.label, 'not-fully-proven');
    assert.equal(labelBatch(m), null, 'nothing left to do');
  } finally {
    setLabelBatchLimit(null);
    p.cleanup();
  }
});

test('the gate: a decision needs this process to have observed the environment, labels with no work left, and every listed object proven', () => {
  const p = labelProject();
  try {
    const { m } = p;
    provenWorld(m);
    // Proven, current, observed: the delivery of Q executes once.
    assert.equal(code(() => w(m, (tx) => commitProofOp(tx, { opId: 'opQ' as never }))), 'ok');
    assert.deepEqual(m.read((db) => opStates(db, ['opQ'])).states.opQ?.executedAsOf !== null, true);
    // P is not proven any more: refused, nothing written.
    append(m, [builders(m).withdraw('B')]);
    assert.equal(code(() => w(m, (tx) => commitProofOp(tx, { opId: 'opP' as never }))), 'STALE_REQUEST');
    // While anything is left to recompute, every decision waits (the whole project).
    crowd(m, 60);
    setLabelBatchLimit(256);
    append(m, [builders(m).pending('opQ2', ['Q'])]);
    m.write({}, (tx) => appendRecords(tx, [builders(m).basis('S', 'S.v2', 'standard')]));
    assert.equal(m.read((db) => labelStatus(db)).recomputing, true);
    const e = (() => {
      try {
        w(m, (tx) => commitProofOp(tx, { opId: 'opQ2' as never }));
      } catch (x) {
        return x as LedgerError;
      }
      return null;
    })();
    assert.equal(e?.code, 'RECOMPUTING');
    assert.match(e!.message, /recomputing \(\d+ nodes to visit, \d+ to evaluate/);
    assert.equal(e!.wi, null);
    setLabelBatchLimit(null);
    drain(m);
    // S was revised: Q's judgment binds S.v1, so Q is no longer proven; the decision is refused on the proof itself.
    assert.equal(code(() => w(m, (tx) => commitProofOp(tx, { opId: 'opQ2' as never }))), 'STALE_REQUEST');
  } finally {
    setLabelBatchLimit(null);
    p.cleanup();
  }
});

test('the gate does the pending work itself when it fits in one batch: records and the decision in one write', () => {
  const p = labelProject();
  try {
    const { m } = p;
    provenWorld(m);
    const b = builders(m);
    w(m, (tx) => {
      appendRecords(tx, [b.product('R'), b.judge('JR', 'R', { evidence: ['E1'], bases: ['S.v1'] }), b.pending('opR', ['R'])]);
      assert.equal(labelStatus(tx).recomputing, true, 'the new records are in the frontier');
      return commitProofOp(tx, { opId: 'opR' as never });
    });
    assert.notEqual(m.read((db) => opStates(db, ['opR'])).states.opR?.executedAsOf, null);
    assert.equal(m.read((db) => labelStatus(db)).recomputing, false);
  } finally {
    p.cleanup();
  }
});

test('stops are never held back: a stop write does no label work, the next write does', () => {
  const p = labelProject();
  try {
    const { m } = p;
    provenWorld(m);
    crowd(m, 60);
    setLabelBatchLimit(256);
    append(m, [builders(m).withdraw('B'), builders(m).basis('S', 'S.v2', 'standard')]);
    // What is left: the frontier and the marks, row by row.
    const left = (): unknown[] => m.read((db) => db.stmt('SELECT node, queued, dirty, cursor FROM lbl_work ORDER BY node').all().map((r) => ({ ...r })));
    const before = left();
    assert.ok(before.length > 0);
    m.write({ op: 'stop-1', payload: 1, stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S1'), scope: { kind: 'all' }, words: 'stop', at: 1 }));
    assert.deepEqual(left(), before, 'the stop did not wait for a batch, nor do one');
    assert.ok(m.read((db) => stopInfo(db, id<StopId>('S1'))) !== null);
    w(m, () => null);
    assert.notDeepEqual(left(), before, 'the next ordinary write did one batch first');
  } finally {
    setLabelBatchLimit(null);
    p.cleanup();
  }
});

test('WI-32: a frontier non-empty for 10 minutes raises one notice while changes keep arriving; drain empties it', () => {
  let clock = 1_000_000;
  const p = labelProject({ now: () => clock });
  try {
    const { m } = p;
    provenWorld(m);
    const b = builders(m);
    const objects = Array.from({ length: 40 }, (_, i) => `O${i}`);
    append(m, objects.flatMap((o) => [b.product(o), b.judge(`J${o}`, o, { evidence: ['E1'], bases: ['S.v1'] })]));
    setLabelBatchLimit(256);
    const alerts = (): Array<{ wi?: string; alert: string }> => m.read((db) => recordsByKind(db, { kinds: ['alert'] })).map((c) => c.record as unknown as { wi?: string; alert: string });
    for (let k = 2; k < 12; k++) {
      append(m, [b.basis('S', `S.v${k}`, 'standard')]);
      clock += 2 * 60_000;
      w(m, () => null);
    }
    const st = m.read((db) => labelStatus(db));
    assert.equal(st.recomputing, true);
    assert.ok(st.since !== null && clock - st.since >= FRONTIER_NOTICE_MS);
    const wi32 = alerts().filter((a) => a.wi === 'WI-32');
    assert.equal(wi32.length, 1, 'one notice for this frontier');
    for (let k = 0; k < 3; k++) w(m, () => null);
    assert.equal(alerts().filter((a) => a.wi === 'WI-32').length, 1, 'not repeated');
    // The PM stops new work and drains.
    const d = drain(m);
    assert.equal(d.status.recomputing, false);
    assert.equal(d.status.since, null);
    assert.equal(m.read((db) => decisionLabels(db, ['O1'])).O1, 'not-fully-proven', 'its judgment binds S.v1, revised since');
  } finally {
    setLabelBatchLimit(null);
    p.cleanup();
  }
});

test('WI-16: a judgment that closes a dependency cycle raises one notice once the labels are current; a rebuild does not raise it again', () => {
  const p = labelProject();
  try {
    const { m } = p;
    const env = currentEnvironment(m, { observe: machine('linux') }).identity;
    const b = builders(m);
    append(m, [
      b.evidence('E1', env),
      b.product('A', { reviews: [{ review: 'reviewer', reliesOn: ['B'] }] }),
      b.product('B', { reviews: [{ review: 'reviewer', reliesOn: ['A'] }] }),
      b.judge('JA', 'A', { evidence: ['E1'], reliesOn: ['B'] }),
      b.judge('JB', 'B', { evidence: ['E1'], reliesOn: ['A'] }),
    ]);
    labelBatch(m);
    const cycles = m.read((db) => dependencyCycles(db));
    assert.equal(cycles.length, 1);
    assert.ok(cycles[0]!.throughJudgment);
    assert.deepEqual([...cycles[0]!.nodes].filter((x) => x.startsWith('j:')), ['j:JA', 'j:JB']);
    assert.deepEqual(m.read((db) => decisionLabels(db, ['A', 'B'])), { A: 'not-fully-proven', B: 'not-fully-proven' });
    const wi16 = (): number => m.read((db) => recordsByKind(db, { kinds: ['alert'] })).filter((c) => (c.record as unknown as { wi?: string }).wi === 'WI-16').length;
    assert.equal(wi16(), 1);
    m.rebuild();
    assert.equal(m.read((db) => dependencyCycles(db)).length, 1);
    w(m, () => null);
    labelBatch(m);
    assert.equal(wi16(), 1, 'the notice is remembered through the log');
  } finally {
    p.cleanup();
  }
});

test('reads: layer 0 and 1 summary, deciding views and the continuation check come from the stored labels', () => {
  const p = labelProject();
  try {
    const { m } = p;
    provenWorld(m);
    w(m, (tx) => commitProofOp(tx, { opId: 'opP' as never }));
    append(m, [builders(m).withdraw('B')]);
    const s = m.read((db) => labelSummary(db));
    assert.equal(s.status.recomputing, false);
    assert.equal(s.targets.total, 2);
    assert.deepEqual(s.targets.byLabel['basis-withdrawn'], ['P']);
    assert.deepEqual(s.targets.byLabel.proven, ['Q']);
    assert.equal(s.ops.executedNotAllProven, 1, 'the executed delivery of P lost its proof');
    assert.equal(s.proofDebt, 1);
    assert.equal(s.judgments.total, 2);
    assert.equal(s.judgments.current, 1);
    const v = m.read((db) => decidingViews(db, ['Q', 'P', 'nope']));
    assert.equal(v.views.get('nope'), null);
    const q = v.views.get('Q')!;
    assert.equal(q.label, 'proven');
    assert.deepEqual(q.deciding.map((d) => [d.judgment, d.current, d.evidence.map((e) => [e.effective, e.applicable, e.record?.runClass])]), [['JQ', true, [['E1', true, 'declared']]]]);
    const c = m.read((db) => continuationCheck(db, { extends: 'JQ' as never, target: 'Q', review: 'reviewer', changedLines: [], draft: { evidence: [], bases: [], constraints: [], reliesOn: [] }, superseded: [] }));
    assert.equal(c.revision, m.read((db) => labelStatus(db)).head);
    assert.equal(c.result.ok, true);
    crowd(m, 60);
    setLabelBatchLimit(256);
    m.write({}, (tx) => appendRecords(tx, [builders(m).basis('S', 'S.v2', 'standard')]));
    assert.deepEqual(m.read((db) => continuationCheck(db, { extends: 'JQ' as never, target: 'Q', review: 'reviewer', changedLines: [], draft: { evidence: [], bases: [], constraints: [], reliesOn: [] }, superseded: [] })).result, {
      ok: false,
      reason: 'recomputing',
    });
  } finally {
    setLabelBatchLimit(null);
    p.cleanup();
  }
});

test('an executed operation that loses "all proven" starts an episode, one notice; regaining it ends the episode, one notice; a rebuild repeats none (6.1)', () => {
  const p = labelProject();
  try {
    const { m } = p;
    provenWorld(m);
    w(m, (tx) => commitProofOp(tx, { opId: 'opQ' as never }));
    const notices = (): Array<{ notice: string; trigger?: string }> => m.read((db) => recordsByKind(db, { kinds: ['notice'] })).map((c) => c.record as unknown as { notice: string; trigger?: string });
    labelBatch(m);
    assert.deepEqual(notices(), [], 'all proven: no episode');
    append(m, [builders(m).basis('S', 'S.v2', 'standard')]);
    labelBatch(m);
    assert.deepEqual(notices().map((x) => x.notice), [JSON.stringify(['episode', 'opQ', 1, 'start'])]);
    assert.match(notices()[0]!.trigger!, /executed operation opQ is no longer all proven/);
    assert.equal(m.read((db) => labelSummary(db)).proofDebt, 1);
    labelBatch(m);
    assert.equal(notices().length, 1, 'one notice per episode');
    append(m, [builders(m).judge('JQ2', 'Q', { evidence: ['E1'], bases: ['S.v2'] })]);
    labelBatch(m);
    assert.deepEqual(notices().map((x) => x.notice), [JSON.stringify(['episode', 'opQ', 1, 'start']), JSON.stringify(['episode', 'opQ', 1, 'end'])]);
    assert.equal(m.read((db) => labelSummary(db)).proofDebt, 0);
    m.rebuild();
    labelBatch(m);
    assert.equal(notices().length, 2, 'the log remembers the episodes');
    append(m, [builders(m).basis('S', 'S.v3', 'standard')]);
    labelBatch(m);
    assert.equal(notices().at(-1)!.notice, JSON.stringify(['episode', 'opQ', 2, 'start']));
  } finally {
    p.cleanup();
  }
});
