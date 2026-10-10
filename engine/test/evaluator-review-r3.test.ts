// Regression tests from core review r3 (gpt-6.1-sol): the reviewer's repro
// scripts (scratch/*-r3.ts), evaluator side, turned into tests that assert the
// fixed behaviour. Ledger-side scenarios of the same scripts belong to the
// ledger suites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { LedgerService, ledgerPaths } from '../src/ledger/service.ts';
import { readRecords } from '../src/ledger/store.ts';
import { Evaluator, resolveRecord, type EvaluatorLedgerPort } from '../src/evaluator/evaluator.ts';
import { IncrementalDerivation } from '../src/evaluator/incremental.ts';
import { Derivation, Index, continuationInputsHash, fullCompute, type ContinuationRequest, type ResolvedCommitted, type ResolvedRecord } from '../src/evaluator/semantics.ts';
import { expandNotices, noticeIdentity } from '../src/evaluator/notices.ts';
import { EvaluatorSupervisor, resolveMemoryPool, type SupervisorLedgerPort } from '../src/evaluator/supervisor.ts';
import { selfIdentity } from '../src/evaluator/process-info.ts';
import { revision, type Revision } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';

const T = { timeout: 60_000 };
const MAPS = ['basis', 'evidenceApplicable', 'judgmentCurrent', 'positionInEffect', 'targets', 'fixes', 'ops'] as const;

// ---------------------------------------------------------------- review-r3.ts, derivation scenarios

const env = { kind: 'env.snapshot', line: 'env', snapshot: 's1' };
const ev = (evidence: string, fields: Record<string, string> = { exit: '0' }) => ({ kind: 'evidence', evidence, envLine: 'env', envSnapshot: 's1', runClass: 'closed', fields });
const ro = (object: string, extra: Record<string, unknown> = {}) => ({
  kind: 'object.version', object, objectKind: 'plan', mission: 'm', module: null, content: '0'.repeat(64), prerequisites: [],
  scope: { paths: ['src/x.ts'], taskType: 'construct' }, reviews: [{ review: 'r', basisLines: [], reliesOn: [] }], ...extra,
});
const judge = (judgment: string, target: string, extra: Record<string, unknown> = {}) => ({
  kind: 'judgment', judgment, target, review: 'r', executor: 'reviewer', verdict: 'pass', evidence: [], bases: [], constraints: [], reliesOn: [],
  issues: [], revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [], ...extra,
});

/** One record per update; incremental equals full at every revision; returns the final full state and the program's check. */
function calc(rs: Record<string, unknown>[]) {
  const records = rs.map((record, i): ResolvedCommitted => ({ revision: revision(i + 1), record: record as unknown as ResolvedRecord }));
  const ix = new Index();
  const inc = new IncrementalDerivation();
  for (const c of records) {
    ix.add(c);
    const got = inc.apply([c], c.revision).state;
    const want = fullCompute(records, c.revision);
    for (const k of MAPS) assert.deepEqual(new Map(got[k] as ReadonlyMap<unknown, unknown>), new Map(want[k] as ReadonlyMap<unknown, unknown>), `${k} at ${c.revision}`);
  }
  const full = fullCompute(records, revision(records.length));
  return { full, check: (r: ContinuationRequest) => new Derivation(ix).continuation(r) };
}

test('r3 F1 (CONTINUATION_RENEWED_INPUT): a continuation carrying J0\'s renewed original instead of the evidence in force is not current', T, () => {
  const rs = [
    env, ev('E1'), ev('E2'), ro('A'), judge('J0', 'A', { evidence: ['E1'] }),
    { kind: 'evidence.renewal', judgment: 'J0', original: 'E1', replacement: 'E2' },
    ro('B', { predecessor: 'A' }), judge('J1', 'B', { extends: 'J0', evidence: ['E1'] }),
    { kind: 'evidence.revoked', evidence: 'E2' },
  ];
  const c = calc(rs);
  assert.equal(c.full.judgmentCurrent.get('J1' as never), false);
  assert.notEqual(c.full.targets.get('B')?.label, 'proven');
  // Carrying the evidence in force (E2) is what the program generates; it is current until E2 is revoked.
  const ok = calc([...rs.slice(0, 7), judge('J1', 'B', { extends: 'J0', evidence: ['E2'] })]);
  assert.equal(ok.full.targets.get('B')?.label, 'proven');
});

test('r3 F1 (CONTINUATION_GATE): when J0 is not current outside the batch, the program refuses and the derivation agrees', T, () => {
  const rs = [env, ev('E1'), ev('E2'), ro('A'), judge('J0', 'A', { evidence: ['E1'] }), { kind: 'evidence.revoked', evidence: 'E1' }, ro('B', { predecessor: 'A' })];
  const superseded = [{ input: 'E1', by: 'E2' }];
  const req: ContinuationRequest = { extends: 'J0' as never, target: 'B', review: 'r', changedLines: [], draft: { evidence: ['E2'], bases: [], constraints: [], reliesOn: [] }, superseded };
  assert.deepEqual(calc(rs).check(req), { ok: false, reason: 'not-current-outside-changes' });
  const c = calc([...rs, judge('J1', 'B', { extends: 'J0', evidence: ['E2'], superseded })]);
  assert.equal(c.full.judgmentCurrent.get('J1' as never), false);
  assert.notEqual(c.full.targets.get('B')?.label, 'proven', 'full and incremental no longer prove B');
});

test('r3 F14 (INVALID_RENEWAL): an invalid newest renewal does not hide a valid older one', T, () => {
  const rs = [
    env, ev('E1'), ev('E2'), ev('BAD', { exit: '1' }), ro('A'), judge('J0', 'A', { evidence: ['E1'] }),
    { kind: 'evidence.renewal', judgment: 'J0', original: 'E1', replacement: 'E2' },
    { kind: 'evidence.revoked', evidence: 'E1' },
  ];
  assert.equal(calc(rs).full.targets.get('A')?.label, 'proven');
  const after = calc([...rs, { kind: 'evidence.renewal', judgment: 'J0', original: 'E1', replacement: 'BAD' }]);
  assert.equal(after.full.targets.get('A')?.label, 'proven', 'the invalid renewal is skipped');
  // A later valid renewal still wins over the earlier valid one.
  const later = calc([...rs, ev('E3'), { kind: 'evidence.renewal', judgment: 'J0', original: 'E1', replacement: 'E3' }, { kind: 'evidence.revoked', evidence: 'E2' }]);
  assert.equal(later.full.targets.get('A')?.label, 'proven');
});

// ---------------------------------------------------------------- continuation-ledger-r3.ts: the same through the real ledger

function ledger(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const svc = new LedgerService({ paths: ledgerPaths(join(dir, 'ledger'), join(dir, 'control')), watchStops: false, bootId: () => 'r3-test' } as ConstructorParameters<typeof LedgerService>[0]);
  svc.open();
  const port: EvaluatorLedgerPort = {
    readRecordsAfter: (after: Revision) => readRecords(svc.paths.db, after),
    beginEvaluator: () => svc.beginEvaluator({ gen: svc.currentGenerationNumber(), identity: selfIdentity() }),
    publish: (r) => svc.publish(r),
    recordEvaluatorFailure: () => svc.recordEvaluatorFailure(),
    recordEvaluatorSuccess: () => svc.recordEvaluatorSuccess(),
    raiseAlert: (r) => svc.raiseAlert(r),
  };
  return { svc, port, cleanup: () => (svc.close(), rmSync(dir, { recursive: true, force: true })) };
}

test('r3 F1 (continuation-ledger-r3): through the real ledger a continuation needs the evaluator\'s passing check and must carry its merged inputs; neither false proof happens', T, async () => {
  const { svc, port, cleanup } = ledger('mp-r3-cont-');
  try {
    const gen = await svc.beginGeneration();
    const L = (v: string[]) => svc.content.putList(v);
    const empty = L([]);
    const object = (id: string, previous?: string): BaseRecord => ({
      kind: 'object.version', object: id as never, objectKind: 'plan', mission: 'm' as never, module: null, content: svc.content.put('doc') as never,
      scope: { paths: ['x.ts'], taskType: 'construct' }, prerequisites: empty, reviews: [{ review: 'r', basisLines: [], reliesOn: [] }], ...(previous ? { predecessor: previous as never } : {}),
    });
    const judgment = (id: string, target: string, evidence: string[], extendsId: string | null = null, sup: { input: string; by: string }[] = []): BaseRecord => ({
      kind: 'judgment', judgment: id as never, target: target as never, review: 'r', executor: 'reviewer', verdict: 'pass', evidence: L(evidence), bases: empty, constraints: empty,
      reliesOn: empty, issues: [], revokes: null, extends: extendsId as never, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: sup,
    });
    const evidence = (id: string): BaseRecord => ({ kind: 'evidence', evidence: id as never, envLine: 'env' as never, envSnapshot: 'S' as never, runClass: 'closed', fields: { exit: '0' } });
    const inc = new IncrementalDerivation();
    const resolved: ResolvedCommitted[] = [];
    let seq = 0;
    /** Commit through the ledger; then incremental equals full over everything committed so far. */
    const add = async (record: BaseRecord) => {
      await svc.appendRecords({ op: `r3-cont-${++seq}`, gen: null, records: [record] });
      return sync();
    };
    const sync = () => {
      const fresh = readRecords(svc.paths.db, revision(resolved.length)).map((c) => ({ revision: c.revision, record: resolveRecord(c.record, svc.content) }));
      resolved.push(...fresh);
      const got = inc.apply(fresh, svc.head()).state;
      const want = fullCompute(resolved, svc.head());
      for (const k of MAPS) assert.deepEqual(new Map(got[k] as ReadonlyMap<unknown, unknown>), new Map(want[k] as ReadonlyMap<unknown, unknown>), `at ${svc.head()}: ${k}`);
      return want;
    };
    // The scheduler's step: ask the evaluator at the latest published revision, record its answer.
    const ev = new Evaluator(port, svc.content);
    const check = async (j: string, extendsId: string, target: string, draft: string[], superseded: { input: string; by: string }[] = []) => {
      await ev.update();
      const a = ev.continuationAt({ extends: extendsId as never, target, review: 'r', changedLines: [], draft: { evidence: draft, bases: [], constraints: [], reliesOn: [] }, superseded });
      assert.ok(a, 'answered at the published revision');
      await svc.recordContinuationCheck({
        op: `check-${j}`, gen, judgment: j as never, extends: extendsId as never, target, revision: a.revision,
        result: a.result.ok ? { ok: true, merged: a.result.merged } : { ok: false, reason: a.result.reason },
      });
      sync();
      return a.result;
    };
    const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as { code?: string }).code ?? String(e));

    await add({ kind: 'env.snapshot', line: 'env' as never, snapshot: 'S' as never });
    await add(evidence('E1'));
    await add(evidence('E2'));
    await add(object('A'));
    await add(judgment('J0', 'A', ['E1']));
    await add({ kind: 'evidence.renewal', judgment: 'J0' as never, original: 'E1' as never, replacement: 'E2' as never });
    await add(object('B', 'A'));
    // REAL_LEDGER_RENEWED_INPUT: the check passes for the draft and merges the evidence in force (E2).
    const c1 = await check('J1', 'J0', 'B', ['E1']);
    assert.ok(c1.ok);
    if (c1.ok) assert.deepEqual(c1.merged.evidence, ['E1', 'E2'], 'the renewed evidence in force is inherited');
    // The reviewer's record carries only the renewed original: its inputs differ from the check's, so the
    // ledger refuses it; the derivation would hold it not current anyway (the first test above).
    const r1 = await refusal(svc.appendRecords({ op: `r3-cont-${++seq}`, gen: null, records: [judgment('J1', 'B', ['E1'], 'J0')] }));
    assert.equal(r1, 'CONTINUATION_REFUSED');
    let f = sync();
    assert.notEqual(f.targets.get('B')?.label, 'proven');
    // The judgment the program generates carries exactly the merged inputs, and is proven ...
    await add(object('B2', 'A'));
    const c2 = await check('J2', 'J0', 'B2', ['E1']);
    assert.ok(c2.ok);
    if (!c2.ok) return;
    f = await add(judgment('J2', 'B2', c2.merged.evidence, 'J0'));
    assert.equal(f.targets.get('B2')?.label, 'proven');
    // ... until the inherited evidence is revoked.
    f = await add({ kind: 'evidence.revoked', evidence: 'E2' as never });
    assert.notEqual(f.targets.get('B2')?.label, 'proven');
    assert.notEqual(f.targets.get('B')?.label, 'proven');

    // REAL_LEDGER_INVALID_CONTINUATION: K0 is not current outside the batch (E3 revoked): the check fails, K1 is refused.
    await add(evidence('E3'));
    await add(evidence('E4'));
    await add(object('C'));
    await add(judgment('K0', 'C', ['E3']));
    await add({ kind: 'evidence.revoked', evidence: 'E3' as never });
    await add(object('D', 'C'));
    const sup = [{ input: 'E3', by: 'E4' }];
    assert.deepEqual(await check('K1', 'K0', 'D', ['E4'], sup), { ok: false, reason: 'not-current-outside-changes' });
    assert.equal(await refusal(svc.appendRecords({ op: `r3-cont-${++seq}`, gen: null, records: [judgment('K1', 'D', ['E4'], 'K0', sup)] })), 'CONTINUATION_REFUSED');
    f = sync();
    assert.equal(f.judgmentCurrent.has('K1' as never), false, 'never committed');
    assert.notEqual(f.targets.get('D')?.label, 'proven');
    // A full review of D (no continuation) is the way forward.
    f = await add(judgment('K2', 'D', ['E4']));
    assert.equal(f.targets.get('D')?.label, 'proven');
  } finally {
    cleanup();
  }
});

test('r3 F1: a passing check carries the hash of its merged inputs, independent of list order', () => {
  const rs = [env, ev('E1'), ev('E2'), ro('A'), judge('J0', 'A', { evidence: ['E1'] }), { kind: 'evidence.renewal', judgment: 'J0', original: 'E1', replacement: 'E2' }, ro('B', { predecessor: 'A' })];
  const r = calc(rs).check({ extends: 'J0' as never, target: 'B', review: 'r', changedLines: [], draft: { evidence: ['E1'], bases: [], constraints: [], reliesOn: [] }, superseded: [] });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.inputsHash, continuationInputsHash(r.merged));
  assert.equal(r.inputsHash, continuationInputsHash({ evidence: ['E2', 'E1'], bases: [], constraints: [], reliesOn: [] }), 'order does not matter');
  assert.notEqual(r.inputsHash, continuationInputsHash({ evidence: ['E1'], bases: [], constraints: [], reliesOn: [] }), 'a missing inherited input changes it');
});

// ---------------------------------------------------------------- review-r3.ts: notice identities

test('r3 F15 (COMPOSITE_IDENTITIES): notice identities of (A:B, C) and (A, B:C) differ, and both notices are committed', T, async () => {
  assert.notEqual(noticeIdentity('A:B', 'C'), noticeIdentity('A', 'B:C'));
  const { svc, cleanup } = ledger('mp-r3-notice-');
  try {
    const gen = await svc.beginGeneration();
    const { epoch } = await svc.beginEvaluator({ gen, identity: selfIdentity() });
    const change = (op: string) => svc.content.putList([JSON.stringify({ op, change: 'start' })]);
    await svc.publish({ epoch, revision: svc.head(), batch: { batch: 'A:B' as never, changes: change('C') } });
    await svc.publish({ epoch, revision: svc.head(), batch: { batch: 'A' as never, changes: change('B:C') } });
    const port = { readRecordsAfter: (r: Revision) => readRecords(svc.paths.db, r), appendRecords: (r: Parameters<LedgerService['appendRecords']>[0]) => svc.appendRecords(r) };
    const n = await expandNotices(port as never, svc.content, revision(0));
    assert.equal(n.committed, 2);
    const notices = readRecords(svc.paths.db, revision(0)).filter((c) => c.record.kind === 'notice').map((c) => (c.record as { notice: string }).notice);
    assert.deepEqual(notices.sort(), [noticeIdentity('A', 'B:C'), noticeIdentity('A:B', 'C')].sort());
    assert.equal((await expandNotices(port as never, svc.content, revision(0))).committed, 0, 'expansion stays idempotent');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- review-r3.ts: memory pool and failure records

test('r3 F9 (AUTO_MEMORY_DOWNGRADE): a failing systemd-run does not degrade silently; only an accepted degradation gives heap-only', T, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-r3-pool-'));
  try {
    const fake = join(dir, 'fake-systemd');
    writeFileSync(fake, '#!/bin/sh\necho unavailable >&2\nexit 1\n');
    chmodSync(fake, 0o700);
    const pool = await resolveMemoryPool({ heapMb: 16, memoryMb: 32, systemdRunPath: fake });
    assert.equal(pool.mode, 'unavailable');
    assert.match(pool.reason ?? '', /unavailable/);
    assert.equal((await resolveMemoryPool({ heapMb: 16, memoryMb: 32, systemdRunPath: fake, acceptedDegradations: ['resource-limits'] })).mode, 'heap-only');
    assert.equal((await resolveMemoryPool({ heapMb: 16, memoryMb: 32, systemdRunPath: fake, acceptedDegradations: ['isolation'] })).mode, 'unavailable', 'another accepted degradation does not count');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

class FakeWorker extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr = null;
  kill(sig: NodeJS.Signals = 'SIGKILL'): boolean {
    this.signalCode = sig;
    setImmediate(() => this.emit('exit', null, sig));
    return true;
  }
  crash(): void {
    this.exitCode = 1;
    this.emit('exit', 1, null);
  }
}

function fakeSup(ledgerPort: SupervisorLedgerPort) {
  const workers: FakeWorker[] = [];
  const configs: Array<{ rebuild: boolean }> = [];
  const sup = new EvaluatorSupervisor({
    worker: { dbPath: 'x', contentRoot: 'x', ledgerSocket: 'x', querySocket: 'x', checkpointPath: 'x', gen: 1, pollMs: 20, checkpointEvery: 1, faultInjection: false },
    deadlineMs: 60_000,
    heapMb: 16,
    memoryPool: 'heap-only',
    acceptedDegradations: ['resource-limits'],
    retryMs: { min: 5, max: 10 },
    launch: (cfg) => {
      configs.push({ rebuild: cfg.rebuild });
      const w = new FakeWorker();
      workers.push(w);
      return w as unknown as ChildProcess;
    },
    ledger: ledgerPort,
  });
  return { sup, workers, configs };
}

test('r3 F6 (FAILURE_RETRY): a failure whose reply was lost after the commit is counted once (one operation id per failure)', T, async () => {
  // The real ledger deduplicates by operation id; the first reply is lost after the commit.
  const { svc, cleanup } = ledger('mp-r3-fail-');
  try {
    assert.equal(Number(await svc.beginGeneration()), 1, 'the generation the fake supervisor belongs to');
    let drop = true;
    const port: SupervisorLedgerPort = {
      recordEvaluatorFailure: async (req) => {
        const n = await svc.recordEvaluatorFailure({ op: req.op, gen: req.gen as never });
        if (drop) {
          drop = false;
          throw new Error('reply lost after commit');
        }
        return n;
      },
      evaluatorHealth: async () => svc.evaluatorHealth(),
      setEvaluatorFault: (r, o) => svc.setEvaluatorFault(r, { gen: o.gen as never }),
      raiseAlert: (r) => svc.raiseAlert(r),
      putContent: (t) => svc.content.put(t),
    };
    const { sup, workers } = fakeSup(port);
    await sup.start();
    workers[0]!.crash();
    const end = Date.now() + 5000;
    while (sup.spawns < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    assert.equal(sup.spawns, 2, 'restarted after the failure was recorded');
    assert.equal(svc.evaluatorHealth().failures, 1, 'one crash, one failure');
    await sup.stop();
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- checkpoint-budget-r3.ts

test('r3 F4 (RESTORE_IDLE): a restore that caught up with a quiet ledger still publishes', T, async () => {
  const { svc, port, cleanup } = ledger('mp-r3-restore-');
  try {
    await svc.beginGeneration();
    const first = new Evaluator(port, svc.content);
    await first.update();
    const second = new Evaluator(port, svc.content);
    assert.equal(second.restore(first.checkpoint(), readRecords(svc.paths.db, revision(0))), true);
    assert.equal(second.state(), null);
    assert.equal(svc.head() > second.lastReadRevision(), false, 'nothing new to read');
    const r = await second.update();
    assert.equal(r.published, svc.head());
    assert.equal(second.state()?.revision, svc.head(), 'a published state exists');
  } finally {
    cleanup();
  }
});

function budgetLedger(start: { failures: number; fault: string | null }) {
  const state = { ...start, alerts: [] as Array<{ op: string; wi?: string }>, faults: 0 };
  const port: SupervisorLedgerPort = {
    recordEvaluatorFailure: async () => ++state.failures,
    evaluatorHealth: async () => ({ failures: state.failures, fault: state.fault }),
    setEvaluatorFault: async (r) => {
      state.fault = r;
      state.faults++;
    },
    raiseAlert: async (r) => {
      if (!state.alerts.some((a) => a.op === r.op)) state.alerts.push({ op: r.op, ...(r.wi !== undefined ? { wi: r.wi } : {}) });
    },
    putContent: () => '0'.repeat(64) as never,
  };
  return { state, port };
}

test('r3 F5 (BUDGET_AFTER_SUPERVISOR_RESTART): the one rebuild and the fault alert are unique across supervisor restarts', T, async () => {
  // 4 failures recorded (the rebuild failed), no fault yet: a restarted supervisor enters the fault, no second rebuild.
  const a = budgetLedger({ failures: 4, fault: null });
  const s1 = fakeSup(a.port);
  await s1.sup.start();
  assert.equal(s1.sup.state, 'fault');
  assert.equal(s1.sup.spawns, 0);
  assert.equal(a.state.faults, 1);
  assert.deepEqual(a.state.alerts.map((x) => x.wi), ['WI-11']);
  // Restarted again in the fault state: the same alert operation; still one alert.
  const s2 = fakeSup(a.port);
  await s2.sup.start();
  assert.equal(s2.sup.state, 'fault');
  assert.equal(a.state.alerts.length, 1);
  assert.equal(a.state.faults, 1);
  // A crash between the fault and its alert: the next start raises the alert.
  const b = budgetLedger({ failures: 4, fault: 'the from-scratch rebuild failed (exit 3 (update)) after 3 failures since the last publication; decided at 2026-10-09T00:00:00.000Z' });
  await fakeSup(b.port).sup.start();
  assert.equal(b.state.alerts.length, 1);
  // Exactly at the budget: the one rebuild.
  const c = budgetLedger({ failures: 3, fault: null });
  const s3 = fakeSup(c.port);
  await s3.sup.start();
  assert.deepEqual(s3.configs, [{ rebuild: true }]);
  s3.workers[0]!.crash(); // the rebuild fails
  const end = Date.now() + 5000;
  while (s3.sup.state !== 'fault' && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.equal(s3.sup.state, 'fault');
  assert.equal(s3.configs.length, 1, 'no second rebuild');
  assert.equal(c.state.alerts.length, 1);
  await s1.sup.stop();
  await s2.sup.stop();
  await s3.sup.stop();
});
