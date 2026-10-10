// Ledger service (design 6.1, 6.3, 6.4; §14 items 3 and 6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerError, LedgerService, ledgerPaths, type LedgerPaths } from '../src/ledger/service.ts';
import { sendStop, type StopRequest } from '../src/ledger/stops.ts';
import { WriterLockHeld } from '../src/ledger/writerLock.ts';
import { readRecords } from '../src/ledger/store.ts';
import { id, revision, type BasisLineId, type BasisVersionId, type EvidenceId, type LaunchId, type MissionId, type OpId, type ReservationId, type StopId } from '../src/common/ids.ts';
import type { BaseRecord, TerminationProofRecord } from '../src/common/records.ts';

const M = id<MissionId>('m1');
const tag = { mission: M, capabilities: ['shell'] };

function fresh(): { paths: LedgerPaths; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mp-ledger-'));
  return { paths: ledgerPaths(join(dir, 'ledger'), join(dir, 'control')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function basis(n: number): BaseRecord {
  return {
    kind: 'basis.version',
    basisKind: 'requirement',
    line: id<BasisLineId>('req-a'),
    version: id<BasisVersionId>(`req-a.v${n}`),
    mission: M,
    scope: null,
  };
}

function proof(launch: string, code = 0): TerminationProofRecord {
  return { kind: 'termination.proof', launch: id<LaunchId>(launch), exit: { code, signal: null }, controlOomKill: 0, unitOomKill: 0, unitOom: 0 };
}

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof LedgerError && e.code === code);
}

test('lost response: retrying an operation returns the original result; a different payload conflicts (§14.6)', async () => {
  const { paths, cleanup } = fresh();
  const svc = new LedgerService({ paths });
  try {
    svc.open();
    const a = await svc.appendRecords({ op: 'op-1', gen: null, records: [basis(1)] });
    const b = await svc.appendRecords({ op: 'op-1', gen: null, records: [basis(1)] });
    assert.deepEqual(a, b);
    assert.equal(svc.head(), a.revisions[0]);
    await rejects(svc.appendRecords({ op: 'op-1', gen: null, records: [basis(2)] }), 'OP_CONFLICT');
    assert.equal(readRecords(paths.db, revision(0)).length, 1);
  } finally {
    svc.close();
    cleanup();
  }
});

test('single writer: a second service cannot open while the first holds the lock', () => {
  const { paths, cleanup } = fresh();
  const a = new LedgerService({ paths });
  const b = new LedgerService({ paths });
  try {
    a.open();
    assert.throws(() => b.open(), WriterLockHeld);
    a.close();
    b.open();
  } finally {
    b.close();
    cleanup();
  }
});

test('stops jump ahead of queued requests; every authorization in scope is then refused (6.4)', async () => {
  const { paths, cleanup } = fresh();
  const svc = new LedgerService({ paths });
  try {
    svc.open();
    const gen = await svc.beginGeneration();
    const auths = [1, 2, 3].map((i) =>
      svc.authorize({ op: `auth-${i}`, gen, launch: null, intent: `i${i}`, kind: 'landing', domain: `d${i}`, tag, details: {} }),
    );
    const stopped = svc.stop({ stop: id<StopId>('s1'), scope: { kind: 'mission', mission: M }, words: '停', at: 1 });
    assert.equal(await stopped, true);
    for (const a of auths) await rejects(a, 'STOPPED');
    // Another mission is not covered (a landing would also need its current delivery: see ledger-delivery tests).
    await svc.authorize({ op: 'auth-other', gen, launch: null, intent: 'io', kind: 'ref', domain: 'do', tag: { mission: id<MissionId>('m2'), capabilities: [] }, details: {} });
  } finally {
    svc.close();
    cleanup();
  }
});

test('stops sent through the inbox before the service starts are committed first on open (6.1)', () => {
  const { paths, cleanup } = fresh();
  const svc = new LedgerService({ paths });
  try {
    svc.open();
    svc.close();
    const req: StopRequest = { stop: id<StopId>('s-inbox'), scope: { kind: 'all' }, words: '全部停下', at: Date.now() };
    const out = sendStop(paths, req);
    assert.deepEqual(out, { durable: true, spooled: true });
    const report = svc.open();
    assert.deepEqual(report.stopsCommitted, ['s-inbox']);
    assert.deepEqual(svc.activeStopIds(), ['s-inbox']);
  } finally {
    svc.close();
    cleanup();
  }
});

test('storage fault: writes are refused, stops still arrive through the inbox and commit first on recovery (6.1)', async () => {
  const { paths, cleanup } = fresh();
  let failing = false;
  const svc = new LedgerService({ paths, injectWriteFault: () => failing });
  try {
    svc.open();
    const gen = await svc.beginGeneration();
    failing = true;
    await rejects(svc.appendRecords({ op: 'w1', gen: null, records: [basis(1)] }), 'STORAGE_FAULT');
    assert.equal(svc.inStorageFault, true);
    await rejects(svc.registerLaunch({ op: 'l1', gen, launch: id<LaunchId>('L1'), tag }), 'STORAGE_FAULT');
    // The hook sends the stop without the service.
    sendStop(paths, { stop: id<StopId>('s-fault'), scope: { kind: 'all' }, words: '停', at: Date.now() });
    assert.equal(svc.tryRecoverStorage(), false);
    failing = false;
    assert.equal(svc.tryRecoverStorage(), true);
    assert.deepEqual(svc.activeStopIds(), ['s-fault']);
    await rejects(svc.registerLaunch({ op: 'l2', gen, launch: id<LaunchId>('L2'), tag }), 'STOPPED');
  } finally {
    svc.close();
    cleanup();
  }
});

test('recovery pause after an unclean shutdown and a reboot while work is open (6.1)', async () => {
  const { paths, cleanup } = fresh();
  const first = new LedgerService({ paths, bootId: () => 'boot-A' });
  first.open();
  await first.setMission(M, 'open');
  // Simulate a crash: the process dies without close(); the kernel drops the lock.
  first.unwatchStops();
  (first as unknown as { lock: { release(): void } }).lock.release();
  (first as unknown as { store: { close(): void } }).store.close();

  const second = new LedgerService({ paths, bootId: () => 'boot-B' });
  try {
    const report = second.open();
    assert.equal(report.recoveryPause, true);
    const gen = await second.beginGeneration();
    await rejects(second.registerLaunch({ op: 'l1', gen, launch: id<LaunchId>('L1'), tag }), 'RECOVERY_PAUSED');
    await second.confirmResume();
    await second.registerLaunch({ op: 'l1', gen, launch: id<LaunchId>('L1'), tag });
  } finally {
    second.close();
    cleanup();
  }
});

test('no recovery pause after a clean shutdown, or after an unclean one on the same boot', () => {
  const { paths, cleanup } = fresh();
  try {
    const a = new LedgerService({ paths, bootId: () => 'boot-A' });
    a.open();
    a.close();
    const b = new LedgerService({ paths, bootId: () => 'boot-B' });
    assert.equal(b.open().recoveryPause, false);
    b.unwatchStops();
    (b as unknown as { lock: { release(): void } }).lock.release();
    (b as unknown as { store: { close(): void } }).store.close();
    const c = new LedgerService({ paths, bootId: () => 'boot-B' });
    assert.equal(c.open().recoveryPause, false);
    c.close();
  } finally {
    cleanup();
  }
});

test('final disposition: pending results become base records only on acceptance with a proof (6.3, 7.1)', async () => {
  const { paths, cleanup } = fresh();
  const svc = new LedgerService({ paths });
  try {
    svc.open();
    const gen = await svc.beginGeneration();
    const L = id<LaunchId>('L1');
    await svc.registerLaunch({ op: 'l1', gen, launch: L, tag });
    const ev: BaseRecord = { kind: 'evidence', evidence: id<EvidenceId>('E1'), envLine: 'py' as never, envSnapshot: 'py@1' as never, runClass: 'closed', fields: { exit: '0' } };
    await svc.submitPendingResult({ op: 'r1', launch: L, records: [ev] });
    await rejects(svc.submitPendingResult({ op: 'r2', launch: L, records: [basis(1)] }), 'KIND_NOT_ALLOWED');
    const kinds = () => readRecords(paths.db, revision(0)).map((c) => c.record.kind);
    assert.ok(!kinds().includes('evidence'), 'pending results are not base records');
    await rejects(svc.dispose({ gen, launch: L, disposition: 'accepted', reason: 'ok' }), 'PROOF_REQUIRED');
    assert.deepEqual(await svc.registerProof(proof('L1')), { registered: 'new' });
    assert.deepEqual(await svc.registerProof(proof('L1')), { registered: 'same' });
    await rejects(svc.registerProof(proof('L1', 3)), 'PROOF_CONFLICT');
    const d = await svc.dispose({ gen, launch: L, disposition: 'accepted', reason: 'ok' });
    assert.equal(d.changed, true);
    assert.equal(d.revisions.length, 1);
    const again = await svc.dispose({ gen, launch: L, disposition: 'failed', reason: 'late' });
    assert.deepEqual(again, { disposition: 'accepted', changed: false, revisions: [] });
  } finally {
    svc.close();
    cleanup();
  }
});

test('takeover: a new generation must adopt a launch before accepting it; adoption by proof needs the proof (6.3)', async () => {
  const { paths, cleanup } = fresh();
  const svc = new LedgerService({ paths });
  try {
    svc.open();
    const g1 = await svc.beginGeneration();
    const L = id<LaunchId>('L1');
    await svc.registerLaunch({ op: 'l1', gen: g1, launch: L, tag });
    const g2 = await svc.beginGeneration();
    await rejects(svc.registerLaunch({ op: 'l2', gen: g1, launch: id<LaunchId>('L2'), tag }), 'STALE_GENERATION');
    await rejects(svc.adopt({ gen: g2, launch: L, via: 'proof' }), 'PROOF_REQUIRED');
    await svc.registerProof(proof('L1'));
    await rejects(svc.dispose({ gen: g2, launch: L, disposition: 'accepted', reason: 'ok' }), 'UNRECOGNIZED_LAUNCH');
    await svc.adopt({ gen: g2, launch: L, via: 'proof' });
    assert.equal((await svc.dispose({ gen: g2, launch: L, disposition: 'accepted', reason: 'ok' })).changed, true);
  } finally {
    svc.close();
    cleanup();
  }
});

test('no-proof failure is refused if a proof was registered meanwhile; late proofs are still registered as facts (6.3, 7.1)', async () => {
  const { paths, cleanup } = fresh();
  const svc = new LedgerService({ paths });
  try {
    svc.open();
    const gen = await svc.beginGeneration();
    const L1 = id<LaunchId>('L1');
    const L2 = id<LaunchId>('L2');
    await svc.registerLaunch({ op: 'l1', gen, launch: L1, tag });
    await svc.registerLaunch({ op: 'l2', gen, launch: L2, tag });
    await svc.registerProof(proof('L1'));
    await rejects(svc.dispose({ gen, launch: L1, disposition: 'failed', reason: 'no-proof' }), 'PROOF_EXISTS');
    await svc.dispose({ gen, launch: L2, disposition: 'cancelled', reason: 'user stop' });
    assert.deepEqual(await svc.registerProof(proof('L2')), { registered: 'new' });
    assert.equal(svc.dispositionFor(L2), 'cancelled');
  } finally {
    svc.close();
    cleanup();
  }
});

test('acceptance is refused while a stop covers the launch (6.1 pre-publication review)', async () => {
  const { paths, cleanup } = fresh();
  const svc = new LedgerService({ paths });
  try {
    svc.open();
    const gen = await svc.beginGeneration();
    const L = id<LaunchId>('L1');
    await svc.registerLaunch({ op: 'l1', gen, launch: L, tag });
    await svc.registerProof(proof('L1'));
    await svc.stop({ stop: id<StopId>('s-net'), scope: { kind: 'capability', capability: 'shell' }, words: '不许跑命令', at: 1 });
    await rejects(svc.dispose({ gen, launch: L, disposition: 'accepted', reason: 'ok' }), 'STOPPED');
  } finally {
    svc.close();
    cleanup();
  }
});

test('one unfinished external action per conflict domain (6.1)', async () => {
  const { paths, cleanup } = fresh();
  const svc = new LedgerService({ paths });
  try {
    svc.open();
    const gen = await svc.beginGeneration();
    await svc.authorize({ op: 'a1', gen, launch: null, intent: 'i1', kind: 'ref', domain: 'refs/x', tag, details: {} });
    await rejects(svc.authorize({ op: 'a2', gen, launch: null, intent: 'i2', kind: 'ref', domain: 'refs/x', tag, details: {} }), 'DOMAIN_BUSY');
    await svc.markIntentPendingVerify('i1', { pid: 1, startTime: '1', bootId: 'b' });
    await rejects(svc.authorize({ op: 'a3', gen, launch: null, intent: 'i3', kind: 'ref', domain: 'refs/x', tag, details: {} }), 'DOMAIN_BUSY');
    // An action awaiting verification is not released without an explicit verification (core review r1 #4).
    await rejects(svc.finishIntent('i1', 'done'), 'VERIFY_REQUIRED');
    await rejects(svc.finishIntent('i1', 'done', { executorGone: false, outcomeVerified: true }), 'VERIFY_REQUIRED');
    await svc.finishIntent('i1', 'done', { executorGone: true, outcomeVerified: true });
    await svc.authorize({ op: 'a4', gen, launch: null, intent: 'i4', kind: 'ref', domain: 'refs/x', tag, details: {} });
  } finally {
    svc.close();
    cleanup();
  }
});

test('publication floor: a proof operation judged on an older revision is refused; only a pending operation executes, once, outside stops (6.1)', async () => {
  const { paths, cleanup } = fresh();
  const svc = new LedgerService({ paths });
  try {
    svc.open();
    const gen = await svc.beginGeneration();
    const ident = { pid: process.pid, startTime: 'test', bootId: 'test' };
    const { epoch } = await svc.beginEvaluator({ gen, identity: ident });
    const objects = svc.content.putList(['P']);
    const r = await svc.appendRecords({ op: 'b', gen: null, records: [basis(1), { kind: 'op.pending', op: id<OpId>('op-x'), opKind: 'delivery', objects, scope: { mission: M, capabilities: [] } }, basis(2)] });
    await svc.publish({ epoch, revision: r.revisions[1]!, batch: null });
    await svc.publish({ epoch, revision: r.revisions[2]!, batch: null });
    const t = { mission: M, capabilities: [] };
    await rejects(svc.commitProofOp({ op: 'p1', gen, opId: id<OpId>('op-x'), asOf: r.revisions[1]!, tag: t }), 'BELOW_FLOOR');
    await rejects(svc.commitProofOp({ op: 'p0', gen, opId: id<OpId>('op-x'), asOf: revision(999), tag: t }), 'BELOW_FLOOR');
    await rejects(svc.commitProofOp({ op: 'p3', gen, opId: id<OpId>('never-registered'), asOf: r.revisions[2]!, tag: t }), 'NOT_PENDING');
    await svc.commitProofOp({ op: 'p2', gen, opId: id<OpId>('op-x'), asOf: r.revisions[2]!, tag: t });
    await rejects(svc.commitProofOp({ op: 'p4', gen, opId: id<OpId>('op-x'), asOf: r.revisions[2]!, tag: t }), 'FACT_CONFLICT');
    // Publishing beyond the head, below the floor, or from an older evaluator epoch is refused.
    await rejects(svc.publish({ epoch, revision: revision(9999), batch: null }), 'BAD_REQUEST');
    await rejects(svc.publish({ epoch, revision: r.revisions[0]!, batch: null }), 'STALE_PUBLICATION');
    const newer = await svc.beginEvaluator({ gen, identity: ident });
    await rejects(svc.publish({ epoch, revision: svc.head(), batch: null }), 'STALE_EVALUATOR');
    await svc.publish({ epoch: newer.epoch, revision: svc.head(), batch: null });
    // Executed operations cannot be appended directly.
    await rejects(svc.appendRecords({ op: 'forge', gen: null, records: [{ kind: 'op.executed', op: id<OpId>('op-y'), asOf: revision(1) }] }), 'KIND_NOT_ALLOWED');
    // A stop covering the operation's scope refuses it.
    await svc.appendRecords({ op: 'b2', gen: null, records: [{ kind: 'op.pending', op: id<OpId>('op-z'), opKind: 'delivery', objects, scope: { mission: M, capabilities: [] } }] });
    await svc.publish({ epoch: newer.epoch, revision: svc.head(), batch: null });
    await svc.stop({ stop: id<StopId>('s1'), scope: { kind: 'mission', mission: M }, words: '停', at: 1 });
    await rejects(svc.commitProofOp({ op: 'p5', gen, opId: id<OpId>('op-z'), asOf: svc.publicationFloor(), tag: t }), 'STOPPED');
  } finally {
    svc.close();
    cleanup();
  }
});

test('a record that references a list missing from the content store is refused (6.1 review item 3)', async () => {
  const { paths, cleanup } = fresh();
  const svc = new LedgerService({ paths });
  try {
    svc.open();
    const present = svc.content.putList(['a', 'b']);
    const missing = { hash: '0'.repeat(64) as never, count: 1 };
    const pending = (ref: typeof present): BaseRecord => ({ kind: 'op.pending', op: id<OpId>('o1'), opKind: 'delivery', objects: ref, scope: { mission: 'm1' as never, capabilities: [] } });
    await svc.appendRecords({ op: 'ok', gen: null, records: [pending(present)] });
    await rejects(svc.appendRecords({ op: 'bad', gen: null, records: [pending(missing)] }), 'CONTENT_MISSING');
  } finally {
    svc.close();
    cleanup();
  }
});

test('evaluator failure budget accumulates until a successful publication (6.1)', async () => {
  const { paths, cleanup } = fresh();
  const svc = new LedgerService({ paths });
  try {
    svc.open();
    assert.equal(await svc.recordEvaluatorFailure(), 1);
    assert.equal(await svc.recordEvaluatorFailure(), 2);
    svc.close();
    svc.open();
    assert.equal(await svc.recordEvaluatorFailure(), 3, 'the count survives a restart');
    await svc.recordEvaluatorSuccess();
    assert.equal(await svc.recordEvaluatorFailure(), 1);
  } finally {
    svc.close();
    cleanup();
  }
});

function setup(): { svc: LedgerService; cleanup: () => void } {
  const { paths, cleanup } = fresh();
  const svc = new LedgerService({ paths });
  svc.open();
  return { svc, cleanup: () => (svc.close(), cleanup()) };
}

test('spend: reservations are checked against the limit before forwarding; settlement by usage or at the reservation (6.5)', async () => {
  const { svc, cleanup } = setup();
  try {
    const gen = await svc.beginGeneration();
    const tag = { mission: id<MissionId>('m1'), capabilities: [] };
    await svc.registerLaunch({ op: 'l1', gen, launch: id<LaunchId>('L1'), tag });
    await svc.setSpendLimit({ op: 'lim', mission: id<MissionId>('m1'), micros: 1000 });
    await svc.reserveSpend({ op: 'r1', reservation: id<ReservationId>('R1'), launch: id<LaunchId>('L1'), micros: 600 });
    await rejects(svc.reserveSpend({ op: 'r2', reservation: id<ReservationId>('R2'), launch: id<LaunchId>('L1'), micros: 500 }), 'SPEND_LIMIT');
    await svc.settleSpend({ op: 's1', reservation: id<ReservationId>('R1'), micros: 100 });
    await rejects(svc.settleSpend({ op: 's1b', reservation: id<ReservationId>('R1'), micros: 100 }), 'ALREADY_SETTLED');
    assert.deepEqual(svc.spendSummary(id<MissionId>('m1')), { limit: 1000, spent: 100, inflight: 0 });
    await svc.reserveSpend({ op: 'r2', reservation: id<ReservationId>('R2'), launch: id<LaunchId>('L1'), micros: 500 });
    await svc.reserveSpend({ op: 'r3', reservation: id<ReservationId>('R3'), launch: id<LaunchId>('L1'), micros: 400 });
    assert.deepEqual(svc.spendSummary(id<MissionId>('m1')), { limit: 1000, spent: 100, inflight: 900 });
    // The host died with two requests in flight: both settle at the reserved amount.
    assert.deepEqual(await svc.settleLaunchAtReservation({ op: 'dead', launch: id<LaunchId>('L1') }), { settled: 2 });
    assert.deepEqual(svc.spendSummary(id<MissionId>('m1')), { limit: 1000, spent: 1000, inflight: 0 });
    // A retried reservation with the same operation id returns the original result.
    assert.deepEqual(await svc.reserveSpend({ op: 'r1', reservation: id<ReservationId>('R1'), launch: id<LaunchId>('L1'), micros: 600 }), { reserved: true });
    // Unlimited never refuses; a stop does.
    await svc.setSpendLimit({ op: 'lim2', mission: id<MissionId>('m1'), micros: null });
    await svc.reserveSpend({ op: 'r4', reservation: id<ReservationId>('R4'), launch: id<LaunchId>('L1'), micros: 10_000 });
    await svc.stop({ stop: id<StopId>('S1'), scope: { kind: 'all' }, words: '停', at: 1 });
    await rejects(svc.reserveSpend({ op: 'r5', reservation: id<ReservationId>('R5'), launch: id<LaunchId>('L1'), micros: 1 }), 'STOPPED');
    // The ledger can be rebuilt from its log: every reservation and settlement is a record.
    const kinds = readRecords(svc.paths.db, revision(0)).map((c) => c.record.kind);
    assert.equal(kinds.filter((k) => k === 'spend.reserve').length, 4);
    assert.equal(kinds.filter((k) => k === 'spend.settle').length, 3);
  } finally {
    cleanup();
  }
});

test('evaluator health: failures accumulate, a fault stops restarts until the user retries (6.1)', async () => {
  const { svc, cleanup } = setup();
  try {
    await svc.recordEvaluatorFailure();
    await svc.recordEvaluatorFailure();
    await svc.setEvaluatorFault('rebuild failed');
    assert.deepEqual(svc.evaluatorHealth(), { failures: 2, fault: 'rebuild failed' });
    await svc.clearEvaluatorFault();
    assert.deepEqual(svc.evaluatorHealth(), { failures: 0, fault: null });
  } finally {
    cleanup();
  }
});

test('boundary checks: malformed records, conflicting fact identities, oversize requests and malformed proofs are refused (core review r1)', async () => {
  const { svc, cleanup } = setup();
  try {
    const gen = await svc.beginGeneration();
    // Shape validation.
    await rejects(svc.appendRecords({ op: 'bad', gen: null, records: [{ kind: 'evidence', evidence: 'E' } as never] }), 'RECORD_INVALID');
    await rejects(svc.appendRecords({ op: 'bad2', gen: null, records: [{ kind: 'nonsense' } as never] }), 'KIND_NOT_ALLOWED');
    // Fact identity: the same fact again is a no-op; a different payload under the same id is refused.
    const r1 = await svc.appendRecords({ op: 'f1', gen: null, records: [basis(1)] });
    const r2 = await svc.appendRecords({ op: 'f2', gen: null, records: [basis(1)] });
    assert.deepEqual(r2.revisions, r1.revisions);
    await rejects(svc.appendRecords({ op: 'f3', gen: null, records: [{ ...basis(1), line: id<BasisLineId>('other') } as BaseRecord] }), 'FACT_CONFLICT');
    // A list whose stored items do not match its count is refused.
    const list = svc.content.putList(['P']);
    await rejects(svc.appendRecords({ op: 'f4', gen: null, records: [{ kind: 'op.pending', op: id<OpId>('o9'), opKind: 'delivery', objects: { ...list, count: 3 }, scope: { mission: M, capabilities: [] } }] }), 'RECORD_INVALID');
    // Object content must be stored.
    const obj: BaseRecord = {
      kind: 'object.version', object: 'X' as never, objectKind: 'product', mission: M, module: null, content: '1'.repeat(64) as never,
      prerequisites: svc.content.putList([]), scope: { paths: ['a.ts'], taskType: 'construct' }, reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
    };
    await rejects(svc.appendRecords({ op: 'f5', gen: null, records: [obj] }), 'CONTENT_MISSING');
    // Request size.
    await rejects(svc.appendRecords({ op: 'big', gen: null, records: Array.from({ length: 1001 }, (_, i) => basis(10 + i)) }), 'TOO_LARGE');
    // Malformed proofs are rejected deterministically.
    await svc.registerLaunch({ op: 'l1', gen, launch: id<LaunchId>('L1'), tag });
    await rejects(svc.registerProof({ kind: 'termination.proof', launch: id<LaunchId>('L1') } as never), 'PROOF_MALFORMED');
    await rejects(svc.registerProof({ ...proof('L1'), exit: { code: 0, signal: 'SIGKILL' } }), 'PROOF_MALFORMED');
    await rejects(svc.registerProof({ ...proof('L1'), unitOom: -1 }), 'PROOF_MALFORMED');
    assert.deepEqual(await svc.registerProof(proof('L1')), { registered: 'new' });
  } finally {
    cleanup();
  }
});

test('business identity before transport identity: a retry after a scheduler handover returns the original result (core review r1 #20)', async () => {
  const { svc, cleanup } = setup();
  try {
    const g1 = await svc.beginGeneration();
    const first = await svc.appendRecords({ op: 'once', gen: g1, records: [basis(1)] });
    const g2 = await svc.beginGeneration();
    assert.deepEqual(await svc.appendRecords({ op: 'once', gen: g1, records: [basis(1)] }), first, 'same op from the old generation: original result');
    assert.deepEqual(await svc.appendRecords({ op: 'once', gen: g2, records: [basis(1)] }), first);
    await rejects(svc.appendRecords({ op: 'new', gen: g1, records: [basis(2)] }), 'STALE_GENERATION');
  } finally {
    cleanup();
  }
});

test('every state change is also an event in the log (10.1 rule 3, core review r1 #19)', async () => {
  const { svc, cleanup } = setup();
  try {
    const gen = await svc.beginGeneration();
    await svc.setMission(M, 'open');
    await svc.registerLaunch({ op: 'l1', gen, launch: id<LaunchId>('L1'), tag });
    await svc.registerProof(proof('L1'));
    await svc.adopt({ gen, launch: id<LaunchId>('L1'), via: 'proof' });
    await svc.dispose({ gen, launch: id<LaunchId>('L1'), disposition: 'failed', reason: 'x' });
    await svc.stop({ stop: id<StopId>('s1'), scope: { kind: 'all' }, words: '停', at: 1 });
    await svc.releaseStop(id<StopId>('s1'));
    await svc.authorize({ op: 'a', gen, launch: null, intent: 'i1', kind: 'ref', domain: 'd', tag, details: {} });
    await svc.finishIntent('i1', 'done');
    await svc.recordCleanup({ op: 'c', launch: id<LaunchId>('L1'), state: 'done', resources: svc.content.putList([]) });
    const kinds = new Set(readRecords(svc.paths.db, revision(0)).map((c) => c.record.kind));
    for (const k of ['generation.begun', 'mission.state', 'launch.registered', 'termination.proof', 'launch.adopted', 'disposition', 'stop.committed', 'stop.released', 'intent.authorized', 'intent.state', 'cleanup.state']) {
      assert.ok(kinds.has(k as never), `missing event ${k}`);
    }
  } finally {
    cleanup();
  }
});

test('cleanup only progresses: pending resources shrink, done is terminal, independent of the final disposition (v35 7.1)', async () => {
  const { svc, cleanup } = setup();
  try {
    const gen = await svc.beginGeneration();
    await svc.registerLaunch({ op: 'l1', gen, launch: id<LaunchId>('L1'), tag });
    await svc.dispose({ gen, launch: id<LaunchId>('L1'), disposition: 'cancelled', reason: 'stop' });
    assert.deepEqual(svc.launchesWithoutCleanup(), ['L1']);
    await svc.recordCleanup({ op: 'c1', launch: id<LaunchId>('L1'), state: 'pending', resources: svc.content.putList(['mount:/a', 'cgroup:/b']) });
    await rejects(svc.recordCleanup({ op: 'c2', launch: id<LaunchId>('L1'), state: 'pending', resources: svc.content.putList(['mount:/a', 'cgroup:/b', 'image:/c']) }), 'CLEANUP_REGRESSION');
    await svc.recordCleanup({ op: 'c3', launch: id<LaunchId>('L1'), state: 'pending', resources: svc.content.putList(['cgroup:/b']) });
    assert.deepEqual(svc.pendingCleanups(), [{ launch: 'L1', resources: ['cgroup:/b'] }]);
    await svc.recordCleanup({ op: 'c4', launch: id<LaunchId>('L1'), state: 'done', resources: svc.content.putList([]) });
    await rejects(svc.recordCleanup({ op: 'c5', launch: id<LaunchId>('L1'), state: 'pending', resources: svc.content.putList([]) }), 'CLEANUP_REGRESSION');
    assert.equal(svc.cleanupState(id<LaunchId>('L1')), 'done');
  } finally {
    cleanup();
  }
});

test('a real SQLite storage error (disk full) enters the storage fault; stops still arrive through the inbox (core review r1 #1)', async () => {
  const { svc, cleanup } = setup();
  try {
    const store = (svc as unknown as { store: { db: import('node:sqlite').DatabaseSync } }).store;
    const pages = (store.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    store.db.exec(`PRAGMA max_page_count=${pages}`);
    const big: BaseRecord = { kind: 'evidence', evidence: id<EvidenceId>('E'), envLine: 'py' as never, envSnapshot: 'py@1' as never, runClass: 'closed', fields: { x: 'y'.repeat(60_000) } };
    await rejects(svc.appendRecords({ op: 'full', gen: null, records: [big] }), 'STORAGE_FAULT');
    assert.equal(svc.inStorageFault, true);
    await rejects(svc.appendRecords({ op: 'after', gen: null, records: [basis(1)] }), 'STORAGE_FAULT');
  } finally {
    cleanup();
  }
});

test('stop inbox: a torn slot never hides a later stop (core review r1 #2; v45 fixed slots)', async () => {
  const { readHeader, writeSlotSync } = await import('../src/ledger/inbox.ts');
  const { rmSync: rm } = await import('node:fs');
  const { join: j } = await import('node:path');
  const { paths, cleanup } = fresh();
  try {
    const first = new LedgerService({ paths, inboxSlots: 34, watchStops: false });
    first.open();
    first.close();
    // A writer died in the middle of slot 2: its record is torn.
    const h = readHeader(paths.inbox);
    const torn = Buffer.alloc(h.slotSize);
    torn.write('MPS1garbage', 0, 'latin1');
    writeSlotSync(paths.inbox, h, 2, torn);
    sendStop(paths, { stop: id<StopId>('s-after'), scope: { kind: 'all' }, words: '停', at: 2 });
    rm(j(paths.controlPlane, 'stops'), { recursive: true, force: true }); // only the inbox copy is left
    const svc = new LedgerService({ paths, watchStops: false });
    const report = svc.open();
    assert.deepEqual(report.stopsCommitted, ['s-after']);
    svc.close();
  } finally {
    cleanup();
  }
});

test('loop counters: attempts per class, repeated failure signatures, one Secretary grant per lineage (6.5)', async () => {
  const { svc, cleanup } = setup();
  try {
    const reason = svc.content.put('why');
    const attempt = (op: string, signature: string, failureClass: string | null = 'env'): Promise<unknown> =>
      svc.appendRecords({ op, gen: null, records: [{ kind: 'loop.attempt', lineage: 'T1', loop: 'env-retry', failureClass, signature }] });
    await attempt('a1', 'sig-x');
    await attempt('a2', 'sig-y');
    await attempt('a3', 'sig-y');
    assert.deepEqual(svc.loopState('T1', 'env-retry'), {
      attempts: 3, byClass: { env: 3 }, repeats: 1, secretaryGrants: 0, extra: 0, attemptsAtLastGrant: null, secretaryGrantUsed: false,
      cap: 6, allowed: 6, exhausted: true, reason: 'no-progress',
    });
    await svc.appendRecords({ op: 'g1', gen: null, records: [{ kind: 'loop.grant', lineage: 'T1', loop: 'env-retry', by: 'secretary', extra: 2, reason }] });
    await rejects(svc.appendRecords({ op: 'g2', gen: null, records: [{ kind: 'loop.grant', lineage: 'T1', loop: 'env-retry', by: 'secretary', extra: 1, reason }] }), 'GRANT_LIMIT');
    await rejects(svc.appendRecords({ op: 'g3', gen: null, records: [{ kind: 'loop.grant', lineage: 'T1', loop: 'env-retry', by: 'secretary', extra: 3, reason }] }), 'RECORD_INVALID');
    await svc.appendRecords({ op: 'g4', gen: null, records: [{ kind: 'loop.grant', lineage: 'T1', loop: 'env-retry', by: 'user', extra: 5, reason }] });
    assert.deepEqual(svc.loopState('T1', 'env-retry'), {
      attempts: 3, byClass: { env: 3 }, repeats: 1, secretaryGrants: 1, extra: 7, attemptsAtLastGrant: 3, secretaryGrantUsed: true,
      cap: 6, allowed: 13, exhausted: false, reason: null,
    });
  } finally {
    cleanup();
  }
});

test('mission ids (review r1 #17): opening a dotted id is refused with the rule; normal ids open', async () => {
  const { svc, cleanup } = setup();
  try {
    // the reviewer's repro: mission "a.b" + exploration "c" and mission "a" + exploration "b.c" made the same ids
    await assert.rejects(svc.setMission('a.b' as MissionId, 'open'), (e: unknown) => e instanceof LedgerError && e.code === 'BAD_REQUEST' && /mission id "a\.b" is not allowed.*no "\."/.test(e.message));
    for (const bad of ['', '-x', 'a_b', 'a b', 'x'.repeat(65)]) await rejects(svc.setMission(bad as MissionId, 'open'), 'BAD_REQUEST');
    for (const good of ['a', 'm1', 'Mission-2', 'x'.repeat(64)]) assert.deepEqual(await svc.setMission(good as MissionId, 'open'), { mission: good, state: 'open' });
  } finally {
    cleanup();
  }
});
