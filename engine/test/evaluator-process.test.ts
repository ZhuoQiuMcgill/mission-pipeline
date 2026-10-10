// Evaluator process logic (design 6.1): publication, floor, episodes, quiescence,
// failure budget, checkpoints. Runs against a real ledger service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerService, ledgerPaths } from '../src/ledger/service.ts';
import { readRecords } from '../src/ledger/store.ts';
import { Evaluator, resolveRecord, RULES_VERSION, type EvaluatorLedgerPort } from '../src/evaluator/evaluator.ts';
import { CheckpointSchedule, checkpointRoom, faultTimeView, readCheckpointSummary, summaryPath, writeCheckpoint } from '../src/evaluator/checkpoint.ts';
import { evaluatorQueryHandler } from '../src/evaluator/queries.ts';
import { RpcError } from '../src/common/rpc.ts';
import { selfIdentity } from '../src/evaluator/process-info.ts';
import { fullCompute } from '../src/evaluator/semantics.ts';
import { sha256 } from '../src/common/hash.ts';
import { id, revision, type OpId, type Revision } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';

function setup(): { svc: LedgerService; port: EvaluatorLedgerPort; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mp-eval-'));
  const paths = ledgerPaths(join(dir, 'ledger'), join(dir, 'control'));
  const svc = new LedgerService({ paths });
  svc.open();
  const port: EvaluatorLedgerPort = {
    readRecordsAfter: (after: Revision) => readRecords(paths.db, after),
    // The ledger binds the registration to the current scheduler generation and this process (F10).
    beginEvaluator: () => svc.beginEvaluator({ gen: svc.currentGenerationNumber(), identity: selfIdentity() }),
    publish: (r) => svc.publish(r),
    recordEvaluatorFailure: () => svc.recordEvaluatorFailure(),
    recordEvaluatorSuccess: () => svc.recordEvaluatorSuccess(),
    raiseAlert: (r) => svc.raiseAlert(r),
  };
  return {
    svc,
    port,
    cleanup: () => {
      svc.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let opSeq = 0;
async function put(svc: LedgerService, ...records: BaseRecord[]): Promise<void> {
  await svc.appendRecords({ op: `t-${++opSeq}`, gen: null, records });
}

/** A proven product P (one evidence on env py@1) plus an executed delivery D over it. */
async function seed(svc: LedgerService): Promise<void> {
  const L = (xs: string[]) => svc.content.putList(xs);
  await put(
    svc,
    { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@1' as never },
    { kind: 'evidence', evidence: 'E1' as never, envLine: 'py' as never, envSnapshot: 'py@1' as never, runClass: 'closed', fields: { exit: '0' } },
    {
      kind: 'object.version',
      object: 'P' as never,
      objectKind: 'product',
      mission: 'm1' as never,
      module: null,
      content: svc.content.put('object content') as never,
      prerequisites: L([]),
      scope: { paths: ['src/p.ts'], taskType: 'construct' },
      reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
    },
    {
      kind: 'judgment',
      judgment: 'J1' as never,
      review: 'reviewer',
      executor: 'reviewer',
      target: 'P' as never,
      verdict: 'pass',
      evidence: L(['E1']),
      bases: L([]),
      constraints: L([]),
      reliesOn: L([]),
      issues: [],
      revokes: null,
      extends: null,
      evidenceUse: { fields: ['exit'], statisticalOrExternal: false },
      superseded: [],
    },
    { kind: 'op.pending', op: 'D1' as never, opKind: 'delivery', objects: L(['P']), scope: { mission: 'm1' as never, capabilities: [] } },
  );
}

test('publication: the published state equals the full recomputation, and the floor follows it (6.1)', { timeout: 60_000 }, async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seed(svc);
    const ev = new Evaluator(port, svc.content);
    const r = await ev.update();
    assert.equal(r.published, svc.head());
    assert.equal(svc.publicationFloor(), r.published);
    const oracle = fullCompute(
      readRecords(svc.paths.db, revision(0)).map((c) => ({ revision: c.revision, record: resolveRecord(c.record, svc.content) })),
      r.published,
    );
    assert.deepEqual(new Map(ev.state()?.targets), oracle.targets);
    assert.equal(ev.state()?.targets.get('P')?.label, 'proven');
  } finally {
    cleanup();
  }
});

test('episodes: an executed operation that loses proof opens an episode; regaining it closes it; one batch per change (6.1)', { timeout: 60_000 }, async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seed(svc);
    const gen = await svc.beginGeneration();
    const ev = new Evaluator(port, svc.content);
    const first = await ev.update();
    await svc.commitProofOp({ op: 'exec-d1', gen, opId: id<OpId>('D1'), asOf: first.published, tag: { mission: 'm1' as never, capabilities: [] } });
    assert.equal((await ev.update()).batch, null, 'still proven: no episode');
    // The environment changes: the delivery is no longer all proven.
    await put(svc, { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@2' as never });
    const down = await ev.update();
    assert.deepEqual(down.changes, [{ op: 'D1', change: 'start' }]);
    assert.notEqual(down.batch, null);
    // A renewal restores it.
    await put(
      svc,
      { kind: 'evidence', evidence: 'E2' as never, envLine: 'py' as never, envSnapshot: 'py@2' as never, runClass: 'closed', fields: { exit: '0' } },
      { kind: 'evidence.renewal', judgment: 'J1' as never, original: 'E1' as never, replacement: 'E2' as never },
    );
    const up = await ev.update();
    assert.deepEqual(up.changes, [{ op: 'D1', change: 'end' }]);
  } finally {
    cleanup();
  }
});

test('quiescence: bookkeeping records never produce new batches; the ledger stops growing (6.1)', { timeout: 60_000 }, async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seed(svc);
    const gen = await svc.beginGeneration();
    const ev = new Evaluator(port, svc.content);
    const r0 = await ev.update();
    await svc.commitProofOp({ op: 'exec-d1', gen, opId: id<OpId>('D1'), asOf: r0.published, tag: { mission: 'm1' as never, capabilities: [] } });
    await put(svc, { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@2' as never });
    await ev.update(); // commits one batch
    const afterBatch = svc.head();
    const r2 = await ev.update(); // reads only the batch
    assert.equal(r2.batch, null);
    assert.equal(r2.published, afterBatch, 'publishes the batch revision it read');
    const r3 = await ev.update();
    assert.equal(r3.batch, null);
    assert.equal(svc.head(), afterBatch, 'no further records');
  } finally {
    cleanup();
  }
});

test('failure budget: a failing update is recorded; a successful one resets the budget (6.1)', { timeout: 60_000 }, async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seed(svc);
    const ev = new Evaluator(port, svc.content);
    let fail = true;
    ev.injectComputeFault = () => fail;
    await assert.rejects(ev.update());
    await assert.rejects(ev.update());
    assert.equal(await svc.recordEvaluatorFailure(), 3, 'two recorded failures plus this probe');
    fail = false;
    await ev.update();
    assert.equal(await svc.recordEvaluatorFailure(), 1, 'reset by the successful update');
  } finally {
    cleanup();
  }
});

test('checkpoint: restored under the same rules and records; discarded when the records differ (6.1)', { timeout: 60_000 }, async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seed(svc);
    const ev = new Evaluator(port, svc.content);
    await ev.update();
    const cp = ev.checkpoint();
    const prefix = readRecords(svc.paths.db, revision(0));
    const restored = new Evaluator(port, svc.content);
    assert.equal(restored.restore(cp, prefix), true);
    await restored.update();
    assert.deepEqual(new Map(restored.state()?.targets), new Map(ev.state()?.targets));
    const tampered = prefix.map((c, i) => (i === 0 ? { ...c, record: { ...c.record, snapshot: 'other' } as BaseRecord } : c));
    assert.equal(new Evaluator(port, svc.content).restore(cp, tampered), false, 'the ledger no longer holds the same records');
    // Re-encode a checkpoint with a changed body, keeping its hash consistent.
    const reencode = (edit: (body: { rules: string; records: Array<{ record: Record<string, unknown> }> }) => void): string => {
      const outer = JSON.parse(cp) as { body: string };
      const body = JSON.parse(outer.body) as { rules: string; records: Array<{ record: Record<string, unknown> }> };
      edit(body);
      const b = JSON.stringify(body);
      return JSON.stringify({ body: b, hash: sha256(b) });
    };
    assert.equal(new Evaluator(port, svc.content).restore(reencode((b) => void (b.rules = 'v0')), prefix), false, 'other rules');
    // Only the cached records are changed (a contract), the chain claim kept: refused (core review r1 #14).
    const forged = reencode((b) => {
      const obj = b.records.find((c) => c.record.kind === 'object.version')!;
      obj.record.reviews = [];
    });
    assert.equal(new Evaluator(port, svc.content).restore(forged, prefix), false, 'cached records that do not hash to the chain');
    const badHash = JSON.stringify({ ...(JSON.parse(cp) as object), hash: '0'.repeat(64) });
    assert.equal(new Evaluator(port, svc.content).restore(badHash, prefix), false, 'a checkpoint whose body hash is wrong');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- core review r2: F5, F19, F22

const L0 = (svc: LedgerService, xs: string[]) => svc.content.putList(xs);
const judgment = (svc: LedgerService, j: string, target: string, verdict: 'pass' | 'fail', more: { evidence?: string[]; reliesOn?: string[] } = {}): BaseRecord => ({
  kind: 'judgment', judgment: j as never, review: 'reviewer', executor: 'reviewer', target: target as never, verdict,
  evidence: L0(svc, more.evidence ?? ['E1']), bases: L0(svc, []), constraints: L0(svc, []), reliesOn: L0(svc, more.reliesOn ?? []),
  issues: [], revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [],
});
const object = (svc: LedgerService, o: string): BaseRecord => ({
  kind: 'object.version', object: o as never, objectKind: 'product', mission: 'm1' as never, module: null, content: svc.content.put(`content ${o}`) as never,
  prerequisites: L0(svc, []), scope: { paths: [`src/${o}.ts`], taskType: 'construct' }, reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
});

test('F5: while the second publication is blocked, queries answer at the published revision, never with the newer decision', { timeout: 60_000 }, async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seed(svc); // P proven by J1
    let entered!: () => void;
    const inPublish = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let block = false;
    const gated: EvaluatorLedgerPort = {
      ...port,
      publish: async (r) => {
        if (block) {
          entered();
          await gate;
        }
        return port.publish(r);
      },
    };
    const ev = new Evaluator(gated, svc.content);
    const r1 = (await ev.update()).published;
    const req = { extends: 'J1' as never, target: 'P', review: 'reviewer', changedLines: [], draft: { evidence: [], bases: [], constraints: [], reliesOn: [] }, superseded: [] };
    assert.deepEqual(ev.continuationAt(req)?.revision, r1);
    assert.equal(ev.continuation(req)?.ok, true);
    // J1 is negated; the next update applies it, then waits in publish.
    await put(svc, judgment(svc, 'J1n', 'P', 'fail'));
    block = true;
    const second = ev.update();
    await inPublish;
    assert.equal(ev.state()?.revision, r1, 'readers still see R1');
    assert.equal(ev.continuation(req), null, 'NOT_READY: the incremental state is ahead of R1');
    const quick = evaluatorQueryHandler(ev, { head: () => svc.head(), waitMs: 30 });
    await assert.rejects(Promise.resolve(quick('continuation', req)), (e: unknown) => e instanceof RpcError && e.code === 'NOT_READY');
    const t = (await quick('targets', { ids: ['P'] })) as { revision: number; states: Record<string, { label: string }> };
    assert.equal(t.revision, r1);
    assert.equal(t.states.P?.label, 'proven', 'map reads answer at R1 with R1 values');
    // A query that may wait answers once the publication settles, at the new revision.
    const patient = evaluatorQueryHandler(ev, { head: () => svc.head(), waitMs: 5000 });
    const waiting = Promise.resolve(patient('continuation', req)) as Promise<{ revision: number; result: unknown }>;
    release();
    const r2 = (await second).published;
    const answer = await waiting;
    assert.equal(answer.revision, r2);
    assert.deepEqual(answer.result, { ok: false, reason: 'not-deciding-pass' }, 'the R2 decision, labelled R2');
    assert.deepEqual(ev.continuationAt(req), { revision: r2, result: { ok: false, reason: 'not-deciding-pass' } });
  } finally {
    cleanup();
  }
});

test('F5: after a failed publication the continuation check is not ready until a rebuild publishes', { timeout: 60_000 }, async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seed(svc);
    let fail = false;
    const ev = new Evaluator({ ...port, publish: async (r) => (fail ? Promise.reject(new Error('ledger down')) : port.publish(r)) }, svc.content);
    await ev.update();
    const req = { extends: 'J1' as never, target: 'P', review: 'reviewer', changedLines: [], draft: { evidence: [], bases: [], constraints: [], reliesOn: [] }, superseded: [] };
    assert.equal(ev.continuation(req)?.ok, true);
    await put(svc, judgment(svc, 'J1n', 'P', 'fail'));
    fail = true;
    await assert.rejects(ev.update(), /ledger down/);
    assert.equal(ev.continuation(req), null);
    await ev.settled();
    fail = false;
    const r = await ev.update();
    assert.deepEqual(ev.continuationAt(req), { revision: r.published, result: { ok: false, reason: 'not-deciding-pass' } });
  } finally {
    cleanup();
  }
});

test('F19: a judgment closing a cycle raises exactly one WI-16 notice naming the judgments and targets; none on later updates or after a restart', { timeout: 60_000 }, async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seed(svc);
    await put(svc, object(svc, 'A'), object(svc, 'B'), judgment(svc, 'JA', 'A', 'pass', { reliesOn: ['B'] }));
    const ev = new Evaluator(port, svc.content);
    await ev.update();
    const alerts = () => readRecords(svc.paths.db, revision(0)).filter((c) => c.record.kind === 'alert');
    assert.equal(alerts().length, 0, 'no cycle yet');
    await put(svc, judgment(svc, 'JB', 'B', 'pass', { reliesOn: ['A'] })); // closes A -> B -> A
    await ev.update();
    const a = alerts();
    assert.equal(a.length, 1);
    const rec = a[0]!.record as { kind: 'alert'; category: string; wi?: string; body: string };
    assert.equal(rec.category, 'dependency-cycle');
    assert.equal(rec.wi, 'WI-16');
    const body = JSON.parse(svc.content.get(rec.body as never).toString('utf8')) as { detail: { judgments: string[]; targets: string[] }; trigger: string; defaultAction: string };
    assert.deepEqual(body.detail.judgments, ['JA', 'JB']);
    assert.deepEqual(body.detail.targets, ['A', 'B']);
    assert.match(body.trigger, /JA, JB/);
    assert.ok(body.defaultAction.length > 0);
    // Unchanged and unrelated updates raise nothing more.
    await put(svc, object(svc, 'C'), judgment(svc, 'JC', 'C', 'pass'));
    await ev.update();
    await put(svc, { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@2' as never });
    await ev.update();
    assert.equal(alerts().length, 1);
    // A restarted evaluator meets the same cycle again: the same operation, no second notice.
    const fresh = new Evaluator(port, svc.content);
    await fresh.update();
    assert.equal(fresh.pendingAlertCount(), 0);
    assert.equal(alerts().length, 1);
    assert.equal(fresh.summary(svc.head())?.cycles, 1);
  } finally {
    cleanup();
  }
});

test('F19: a notice the ledger cannot take now is kept and raised after a later update; it never fails the update', { timeout: 60_000 }, async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seed(svc);
    let down = true;
    const ev = new Evaluator({ ...port, raiseAlert: async (r) => (down ? Promise.reject(new Error('ledger busy')) : port.raiseAlert!(r)) }, svc.content);
    await put(svc, object(svc, 'A'), object(svc, 'B'), judgment(svc, 'JA', 'A', 'pass', { reliesOn: ['B'] }), judgment(svc, 'JB', 'B', 'pass', { reliesOn: ['A'] }));
    await ev.update();
    assert.equal(ev.pendingAlertCount(), 1);
    down = false;
    await put(svc, { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@2' as never });
    await ev.update();
    assert.equal(ev.pendingAlertCount(), 0);
    assert.equal(readRecords(svc.paths.db, revision(0)).filter((c) => c.record.kind === 'alert').length, 1);
  } finally {
    cleanup();
  }
});

test('F22: checkpoints are due after N publications or after the interval, never without a publication to save', () => {
  let now = 1_000_000;
  const s = new CheckpointSchedule({ every: 3, intervalMs: 1000, now: () => now });
  assert.equal(s.due(), null);
  s.published();
  s.published();
  assert.equal(s.due(), null);
  s.published();
  assert.equal(s.due(), 'count');
  s.written();
  assert.equal(s.due(), null);
  s.published();
  now += 999;
  assert.equal(s.due(), null);
  now += 1;
  assert.equal(s.due(), 'interval', 'one unsaved publication, ten minutes (here 1 s) later');
  s.written();
  now += 10_000;
  assert.equal(s.due(), null, 'nothing new to save');
  s.published();
  assert.equal(s.due(), 'interval');
  // A failed write (e.g. the disk pool is full) pauses retries instead of retrying every loop.
  s.failed();
  assert.equal(s.due(), null);
  now += 1000;
  assert.equal(s.due(), 'interval');
  // The default interval is the design's ten minutes.
  let t = 0;
  const d = new CheckpointSchedule({ every: 1_000_000, now: () => t });
  d.published();
  t = 10 * 60_000 - 1;
  assert.equal(d.due(), null);
  t = 10 * 60_000;
  assert.equal(d.due(), 'interval');
});

test('F22: the summary beside a checkpoint holds the revision, time, label counts, operations and current judgments', { timeout: 60_000 }, async () => {
  const { svc, port, cleanup } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'mp-evcp-'));
  try {
    await seed(svc); // P proven, D1 pending over P
    await put(svc, object(svc, 'Q'), judgment(svc, 'JQ', 'Q', 'fail'), object(svc, 'R'));
    await put(svc, { kind: 'op.pending', op: 'D2' as never, opKind: 'delivery', objects: L0(svc, ['Q']), scope: { mission: 'm1' as never, capabilities: [] } });
    const ev = new Evaluator(port, svc.content);
    const r = await ev.update();
    const when = new Date('2026-10-09T12:00:00.000Z');
    const sum = ev.summary(svc.head(), { now: when, checkpoint: ev.checkpointWithHash().hash })!;
    assert.equal(sum.revision, r.published);
    assert.equal(sum.head, svc.head());
    assert.equal(sum.writtenAt, when.toISOString());
    assert.equal(sum.rules, RULES_VERSION);
    assert.deepEqual(sum.targets, {
      total: 3,
      labels: { negated: 1, 'basis-withdrawn': 0, unaccepted: 1, 'not-fully-proven': 0, proven: 1 },
      byLabel: { negated: ['Q'], 'basis-withdrawn': [], unaccepted: ['R'], 'not-fully-proven': [], proven: ['P'] },
    });
    assert.deepEqual(sum.ops, {
      total: 2, allProven: 1, notAllProven: 1, executed: 0, executedNotAllProven: 0,
      byOp: { D1: { kind: 'delivery', allProven: true, executedAsOf: null }, D2: { kind: 'delivery', allProven: false, executedAsOf: null } },
    });
    assert.equal(sum.proofDebt, 0);
    assert.equal(sum.checkpoint, ev.checkpointWithHash().hash, 'bound to the checkpoint written with it');
    assert.deepEqual(sum.judgments, { total: 2, current: 2, notCurrent: 0 });
    assert.equal(sum.cycles, 0);
    const cp = join(dir, 'evaluator.checkpoint');
    writeCheckpoint(cp, ev.checkpoint(), sum);
    assert.ok(existsSync(cp) && existsSync(summaryPath(cp)));
    assert.deepEqual(readCheckpointSummary(cp), sum);
    assert.equal(readCheckpointSummary(join(dir, 'missing.checkpoint')), null);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- core review r3: deciding query, F19 fault-time reads, F20 disk pool

test('deciding({targets}): positions, deciding judgments and the evidence in force after renewals, at one published revision', { timeout: 60_000 }, async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seed(svc); // P decided by J1 on E1 (env py@1); D1 pending over P
    await put(
      svc,
      { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@2' as never },
      { kind: 'evidence', evidence: 'E2' as never, envLine: 'py' as never, envSnapshot: 'py@2' as never, runClass: 'closed', fields: { exit: '0', 'input:src/p.ts': 'a'.repeat(64) } },
      { kind: 'evidence.renewal', judgment: 'J1' as never, original: 'E1' as never, replacement: 'E2' as never },
      object(svc, 'Q'),
      judgment(svc, 'JQ', 'Q', 'fail'),
    );
    const ev = new Evaluator(port, svc.content);
    const r = await ev.update();
    const handler = evaluatorQueryHandler(ev, { head: () => svc.head() });
    const ans = (await handler('deciding', { targets: ['P', 'Q', 'nope'] })) as {
      revision: number;
      targets: Record<string, null | { kind: string; label: string; conclusion: string; positions: unknown[]; deciding: Array<{ judgment: string; current: boolean; evidence: Array<{ original: string; effective: string; applicable: boolean; record: { fields: Record<string, string> } | null }> }> }>;
    };
    assert.equal(ans.revision, r.published);
    const p = ans.targets.P!;
    assert.equal(p.kind, 'object');
    assert.equal(p.label, 'proven');
    assert.deepEqual(p.positions, [{ review: 'reviewer', state: 'pass', by: 'J1' }]);
    assert.equal(p.deciding.length, 1);
    assert.equal(p.deciding[0]!.judgment, 'J1');
    assert.equal(p.deciding[0]!.current, true);
    assert.deepEqual(
      p.deciding[0]!.evidence.map((e) => [e.original, e.effective, e.applicable, e.record?.fields['input:src/p.ts']]),
      [['E1', 'E2', true, 'a'.repeat(64)]],
      'the renewed evidence is the one in force',
    );
    const q = ans.targets.Q!;
    assert.equal(q.conclusion, 'negated');
    assert.deepEqual(q.positions, [{ review: 'reviewer', state: 'fail', by: 'JQ' }]);
    assert.deepEqual(q.deciding, [], 'no deciding judgments unless every position passes');
    assert.equal(ans.targets.nope, null);
    // It agrees with the published maps at the same revision.
    assert.equal(ev.state()!.targets.get('P')?.label, p.label);
    await assert.rejects(Promise.resolve(handler('deciding', { targets: 'P' })), (e: unknown) => e instanceof RpcError && e.code === 'BAD_REQUEST');
    // While a publication is in flight, it is NOT_READY (or waits), never ahead of the published revision.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let entered!: () => void;
    const inPublish = new Promise<void>((res) => (entered = res));
    const gated = new Evaluator({ ...port, publish: async (x) => (entered(), await gate, port.publish(x)) }, svc.content);
    const firstGate = gated.update();
    await inPublish;
    assert.equal(gated.decidingAt(['P']), null);
    const quick = evaluatorQueryHandler(gated, { head: () => svc.head(), waitMs: 20 });
    await assert.rejects(Promise.resolve(quick('deciding', { targets: ['P'] })), (e: unknown) => e instanceof RpcError && e.code === 'NOT_READY');
    release();
    await firstGate;
    assert.equal(gated.decidingAt(['P'])?.revision, gated.state()!.revision);
  } finally {
    cleanup();
  }
});

test('r3 F19: the summary supports fault-time reads: every target label, every operation, the lag behind the head', { timeout: 60_000 }, async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seed(svc);
    const gen = await svc.beginGeneration();
    const ev = new Evaluator(port, svc.content);
    const r0 = await ev.update();
    await svc.commitProofOp({ op: 'exec-d1', gen, opId: id<OpId>('D1'), asOf: r0.published, tag: { mission: 'm1' as never, capabilities: [] } });
    await put(svc, { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@2' as never });
    await ev.update();
    const sum = ev.summary(svc.head())!;
    assert.equal(sum.proofDebt, 1, 'the executed delivery is no longer all proven');
    assert.deepEqual(sum.ops.byOp.D1, { kind: 'delivery', allProven: false, executedAsOf: r0.published });
    // Later commits: the view shows how far the summary lags.
    await put(svc, object(svc, 'LATER'));
    const view = faultTimeView(sum, svc.head());
    assert.equal(view.revision, sum.revision);
    assert.equal(view.lag, svc.head() - sum.revision);
    assert.equal(view.label('P'), 'not-fully-proven');
    assert.equal(view.label('LATER'), null, 'not known at the summary revision');
    assert.deepEqual(view.op('D1'), { kind: 'delivery', allProven: false, executedAsOf: r0.published });
    assert.equal(view.op('nope'), null);
  } finally {
    cleanup();
  }
});

test('r3 F20: checkpoint room: the pool holds the old and the new checkpoint at once; the disk keeps its reserve', () => {
  assert.equal(checkpointRoom({ newBytes: 40, oldBytes: 50, poolBytes: 100, freeBytes: null, reserveBytes: 0 }), null);
  assert.match(checkpointRoom({ newBytes: 60, oldBytes: 50, poolBytes: 100, freeBytes: null, reserveBytes: 0 }) ?? '', /cannot hold the previous checkpoint \(50 bytes\) and the new one \(60 bytes\)/);
  assert.equal(checkpointRoom({ newBytes: 60, oldBytes: 50, poolBytes: null, freeBytes: 1000, reserveBytes: 900 }), null);
  assert.match(checkpointRoom({ newBytes: 60, oldBytes: 0, poolBytes: null, freeBytes: 1000, reserveBytes: 950 }) ?? '', /below the reserve of 950 bytes/);
});
