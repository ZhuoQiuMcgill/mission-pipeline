// Ledger follow-up to the core review r2 (coordinator's list a–g, open questions 2 and 4):
// landing attempts as a loop, one Secretary grant per lineage, idempotent evaluator
// failures, one id space for objects and proof units, the scheduler's queries over IPC,
// user words, the persisted task queue, the recovery.pause record with its basis,
// the remaining content checks, and the WI of every refusal (3.11).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerError, LedgerService, REFUSAL_WI, ledgerPaths, type LedgerErrorCode, type LedgerPaths } from '../src/ledger/service.ts';
import { LedgerClient, RemoteLedgerError, serveLedger } from '../src/ledger/ipc.ts';
import { Store, readRecords } from '../src/ledger/store.ts';
import { DatabaseSync } from 'node:sqlite';
import { LOOP_CAPS, type BaseRecord, type LoopKind } from '../src/common/records.ts';
import { id, revision, type ContentHash, type Generation, type LaunchId, type MissionId, type StopId } from '../src/common/ids.ts';

const M = id<MissionId>('m1');
const M2 = id<MissionId>('m2');

function fresh(): { dir: string; paths: LedgerPaths; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mp-ledger-r3-'));
  return { dir, paths: ledgerPaths(join(dir, 'ledger'), join(dir, 'control')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function service(bootId: () => string = () => 'boot-A'): { svc: LedgerService; paths: LedgerPaths; dir: string; cleanup: () => void } {
  const f = fresh();
  const svc = new LedgerService({ paths: f.paths, bootId });
  svc.open();
  return {
    svc,
    paths: f.paths,
    dir: f.dir,
    cleanup: () => {
      try {
        svc.close();
      } finally {
        f.cleanup();
      }
    },
  };
}

async function rejects(p: Promise<unknown>, code: LedgerErrorCode, wi?: string | null): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof LedgerError, `not a LedgerError: ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (wi !== undefined) assert.equal(e.wi, wi, `${code} maps to ${wi}`);
    return true;
  });
}

/** A crash: the process dies without close(); the kernel drops the lock. A later close() is a no-op. */
function crash(svc: LedgerService): void {
  svc.unwatchStops();
  const x = svc as unknown as { lock: { release(): void }; store: { close(): void } | null };
  x.store?.close();
  x.store = null;
  x.lock.release();
}

let seq = 0;
const attempt = (svc: LedgerService, lineage: string, loop: LoopKind, signature: string, failureClass: string | null = null) =>
  svc.appendRecords({ op: `att-${++seq}`, gen: null, records: [{ kind: 'loop.attempt', lineage, loop, failureClass, signature }] });
const grant = (svc: LedgerService, lineage: string, loop: LoopKind, by: 'secretary' | 'user', extra: number) =>
  svc.appendRecords({ op: `grant-${++seq}`, gen: null, records: [{ kind: 'loop.grant', lineage, loop, by, extra, reason: svc.content.put(`why ${seq}`) }] });

// ---------------------------------------------------------------- a. landing attempts

test('a: landing attempts that enter the push stage are counted per delivery: the first + 3; then exhausted (WI-08); a Secretary grant once, then only the user', async () => {
  const { svc, paths, cleanup } = service();
  try {
    const D = 'delivery:m1/op-7';
    assert.equal(LOOP_CAPS['landing-attempt'], 4);
    // Program and PM attempts count alike: the ledger only sees attempts entering the push stage.
    for (const who of ['program-1', 'pm-cli-2', 'program-3', 'program-4']) await attempt(svc, D, 'landing-attempt', who);
    assert.deepEqual(
      (({ attempts, allowed, exhausted, reason }) => ({ attempts, allowed, exhausted, reason }))(svc.loopState(D, 'landing-attempt')),
      { attempts: 4, allowed: 4, exhausted: true, reason: 'cap' },
    );
    await rejects(attempt(svc, D, 'landing-attempt', 'program-5'), 'LOOP_EXHAUSTED', 'WI-08');
    // Persistent across a restart.
    svc.close();
    svc.open();
    await rejects(attempt(svc, D, 'landing-attempt', 'program-5'), 'LOOP_EXHAUSTED');
    await grant(svc, D, 'landing-attempt', 'secretary', 2);
    await attempt(svc, D, 'landing-attempt', 'program-5');
    await attempt(svc, D, 'landing-attempt', 'program-6');
    await rejects(attempt(svc, D, 'landing-attempt', 'program-7'), 'LOOP_EXHAUSTED');
    await rejects(grant(svc, D, 'landing-attempt', 'secretary', 1), 'GRANT_LIMIT', 'WI-08');
    await grant(svc, D, 'landing-attempt', 'user', 1);
    await attempt(svc, D, 'landing-attempt', 'program-7');
    const st = svc.loopState(D, 'landing-attempt');
    assert.deepEqual([st.attempts, st.allowed, st.exhausted, st.attemptsAtLastGrant, st.secretaryGrantUsed], [7, 7, true, 6, true]);
    assert.throws(() => svc.loopState(D, 'landing-retry' as LoopKind), (e: unknown) => e instanceof LedgerError && e.code === 'BAD_REQUEST');
    // Nothing the refusals tried reached the log.
    const attempts = readRecords(paths.db, revision(0)).filter((c) => c.record.kind === 'loop.attempt');
    assert.equal(attempts.length, 7);
  } finally {
    cleanup();
  }
});

test('a: "no progress" exhaustion is persistent: a later attempt with another signature does not clear it; only a grant does', async () => {
  const { svc, cleanup } = service();
  try {
    const D = 'delivery:m1/op-8';
    await attempt(svc, D, 'landing-attempt', 'rejected: uncommitted changes in wt-1');
    await attempt(svc, D, 'landing-attempt', 'rejected: uncommitted changes in wt-1');
    assert.equal(svc.loopState(D, 'landing-attempt').reason, 'no-progress');
    await rejects(attempt(svc, D, 'landing-attempt', 'something else'), 'LOOP_EXHAUSTED');
    // A loop that records failures after the fact is never refused, but stays exhausted.
    const T = 'task-lineage-1';
    await attempt(svc, T, 'rework', 'same finding');
    await attempt(svc, T, 'rework', 'same finding');
    await attempt(svc, T, 'rework', 'another finding');
    assert.equal(svc.loopState(T, 'rework').reason, 'cap');
    const T2 = 'task-lineage-2';
    await attempt(svc, T2, 'env-retry', 'sig');
    await attempt(svc, T2, 'env-retry', 'sig');
    await attempt(svc, T2, 'env-retry', 'other');
    assert.equal(svc.loopState(T2, 'env-retry').reason, 'no-progress', 'stays exhausted after a different signature');
    await grant(svc, T2, 'env-retry', 'secretary', 2);
    assert.equal(svc.loopState(T2, 'env-retry').exhausted, false, 'a grant clears it');
    await attempt(svc, T2, 'env-retry', 'other');
    assert.equal(svc.loopState(T2, 'env-retry').reason, 'no-progress', 'the same failure again after the grant exhausts it again');
    // Delivery rebuilds never exhaust by repetition (6.5).
    const R = 'delivery:m1/op-9';
    await attempt(svc, R, 'delivery-rebuild', 'base moved');
    await attempt(svc, R, 'delivery-rebuild', 'base moved');
    assert.equal(svc.loopState(R, 'delivery-rebuild').exhausted, false);
    // env-retry: the per-class cap is reported for the class of the next attempt.
    const E = 'task-lineage-3';
    for (const sig of ['a', 'b', 'c']) await attempt(svc, E, 'env-retry', sig, 'disk');
    assert.equal(svc.loopState(E, 'env-retry', 'disk').reason, 'class-cap');
    assert.equal(svc.loopState(E, 'env-retry', 'network').exhausted, false);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- b. one Secretary grant per lineage

test('b: the Secretary grants once per lineage across all its loops, enforced in the ledger even when two requests race', async () => {
  const { svc, cleanup } = service();
  try {
    const T = 'lineage-X';
    await grant(svc, T, 'env-retry', 'secretary', 2);
    await rejects(grant(svc, T, 'rework', 'secretary', 1), 'GRANT_LIMIT', 'WI-08');
    assert.equal(svc.loopState(T, 'rework').secretaryGrantUsed, true, 'every loop of the lineage sees the grant used');
    assert.equal(svc.loopState(T, 'rework').attemptsAtLastGrant, null);
    await grant(svc, T, 'rework', 'user', 1);
    await grant(svc, 'lineage-Y', 'rework', 'secretary', 1);
    // Racing grants on two loops of a fresh lineage: exactly one is committed.
    const results = await Promise.allSettled([grant(svc, 'lineage-Z', 'env-retry', 'secretary', 1), grant(svc, 'lineage-Z', 'quarantine-restart', 'secretary', 2)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal((refused.reason as LedgerError).code, 'GRANT_LIMIT');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- c. idempotent evaluator failures

test('c: an evaluator failure with an operation id counts once, whatever the retries', async () => {
  const { svc, cleanup } = service();
  try {
    assert.equal(await svc.recordEvaluatorFailure({ op: 'evaluator-failure:1:4242:timeout' }), 1);
    assert.equal(await svc.recordEvaluatorFailure({ op: 'evaluator-failure:1:4242:timeout' }), 1, 'a retry returns the original count');
    assert.equal(svc.evaluatorHealth().failures, 1);
    assert.equal(await svc.recordEvaluatorFailure({ op: 'evaluator-failure:1:4243:oom' }), 2);
    assert.equal(await svc.recordEvaluatorFailure(), 3, 'without an id it still counts (legacy callers)');
    await rejects(svc.recordEvaluatorFailure({ op: '' }), 'BAD_REQUEST');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- d. one id space for objects and proof units

test('d: a proof unit cannot take an object’s id, nor an object a unit’s (one state per id in the evaluator)', async () => {
  const { svc, cleanup } = service();
  try {
    const L = (xs: string[]) => svc.content.putList(xs);
    const obj = (object: string): BaseRecord => ({
      kind: 'object.version', object: object as never, objectKind: 'product', mission: M, module: null, content: svc.content.put(`body ${object}`),
      prerequisites: L([]), scope: { paths: ['a.ts'], taskType: 'construct' }, reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
    });
    const unit = (u: string): BaseRecord => ({ kind: 'proof.unit', unit: u as never, members: L(['A', 'B']), reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }] });
    await svc.appendRecords({ op: 'o-x', gen: null, records: [obj('X')] });
    await rejects(svc.appendRecords({ op: 'u-x', gen: null, records: [unit('X')] }), 'FACT_CONFLICT', 'WI-20');
    await svc.appendRecords({ op: 'u-y', gen: null, records: [unit('Y')] });
    await rejects(svc.appendRecords({ op: 'o-y', gen: null, records: [obj('Y')] }), 'FACT_CONFLICT');
    await rejects(svc.appendRecords({ op: 'both', gen: null, records: [obj('Z'), unit('Z')] }), 'FACT_CONFLICT', 'WI-20');
    // The same object again is still a no-op.
    await svc.appendRecords({ op: 'o-x2', gen: null, records: [obj('X')] });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- e. queries the scheduler reads over IPC

test('e: active stops, open intents, launches (disposed ones too, by scope), mission blocks and status over the socket', async () => {
  const { svc, dir, cleanup } = service();
  const sock = join(dir, 'ledger.sock');
  const server = serveLedger(svc, sock);
  const client = new LedgerClient(sock, 5000);
  try {
    const gen = (await client.call('beginGeneration', {})) as Generation;
    const reg = (launch: string, mission: MissionId, capabilities: string[]) => client.call('registerLaunch', { op: `reg-${launch}`, gen, launch: id<LaunchId>(launch), tag: { mission, capabilities } });
    await reg('L1', M, ['net']);
    await reg('L2', M, []);
    await reg('L3', M2, ['net']);
    await client.call('dispose', { gen, launch: id<LaunchId>('L2'), disposition: 'cancelled', reason: 'user stop' });
    await client.call('recordCleanup', { op: 'c2', launch: id<LaunchId>('L2'), state: 'pending', resources: svc.content.putList(['mount:/x']) });
    await client.call('dispose', { gen, launch: id<LaunchId>('L3'), disposition: 'failed', reason: 'env' });
    await client.call('recordCleanup', { op: 'c3', launch: id<LaunchId>('L3'), state: 'done', resources: svc.content.putList([]) });
    await client.call('stop', { stop: id<StopId>('S-NET'), scope: { kind: 'capability', capability: 'net' }, words: '不许联网', at: 7 });
    await client.call('authorize', { op: 'a1', gen, launch: null, intent: 'I1', kind: 'ref', domain: 'refs/x', tag: { mission: M2, capabilities: [] }, details: {} });
    await client.call('markIntentPendingVerify', { intent: 'I1', executor: { pid: 99, startTime: '5', bootId: 'b' } });

    const stops = (await client.call('activeStops', {})) as Array<{ stop: string; scope: unknown; words: string; requestedAt: number; committedAt: number }>;
    assert.deepEqual(stops.map((s) => [s.stop, s.scope, s.words, s.requestedAt]), [['S-NET', { kind: 'capability', capability: 'net' }, '不许联网', 7]]);
    assert.equal(typeof stops[0]!.committedAt, 'number');
    assert.equal(await client.call('stopState', { stop: 'S-NET' }), 'active');
    assert.equal(await client.call('stopState', { stop: 'nope' }), null);

    const intents = (await client.call('openIntents', {})) as Array<{ intent: string; state: string; tag: unknown; executor: unknown }>;
    assert.deepEqual(intents.map((i) => [i.intent, i.state, i.tag, i.executor]), [['I1', 'pending_verify', { mission: M2, capabilities: [] }, { pid: 99, startTime: '5', bootId: 'b' }]]);

    type L = { launch: string; disposition: string | null; cleanup: string | null; tag: { mission: string } };
    const all = (await client.call('launches', {})) as L[];
    assert.deepEqual(all.map((l) => [l.launch, l.disposition, l.cleanup]), [['L1', null, null], ['L2', 'cancelled', 'pending'], ['L3', 'failed', 'done']]);
    const net = (await client.call('launches', { scope: { kind: 'capability', capability: 'net' } })) as L[];
    assert.deepEqual(net.map((l) => l.launch), ['L1', 'L3'], 'disposed launches are listed too');
    const m1 = (await client.call('launches', { scope: { kind: 'mission', mission: M } })) as L[];
    assert.deepEqual(m1.map((l) => l.launch), ['L1', 'L2']);
    const unfinished = (await client.call('launches', { unfinished: true })) as L[];
    assert.deepEqual(unfinished.map((l) => l.launch), ['L1', 'L2'], 'L3 is disposed and cleaned up');
    assert.deepEqual(((await client.call('launches', { launch: id<LaunchId>('L2') })) as L[]).map((l) => l.launch), ['L2']);

    const report = svc.content.put('blocked report');
    await client.call('appendRecords', { op: 'mb1', gen, records: [{ kind: 'mission.block', mission: M, reason: 'budget', state: 'blocked', report }] });
    await client.call('appendRecords', { op: 'mb2', gen, records: [{ kind: 'mission.block', mission: M, reason: 'budget', state: 'released', report: svc.content.put('released') }] });
    await client.call('appendRecords', { op: 'mb3', gen, records: [{ kind: 'mission.block', mission: M2, reason: 'resource', state: 'blocked', report }] });
    const blocks = (await client.call('missionBlocks', {})) as Array<{ mission: string; record: { state: string } }>;
    assert.deepEqual(blocks.map((b) => [b.mission, b.record.state]), [['m1', 'released'], ['m2', 'blocked']]);

    const status = (await client.call('status', {})) as { recoveryPause: boolean; boot: string; startup: unknown; storageFault: boolean; head: number };
    assert.equal(status.recoveryPause, false);
    assert.equal(status.boot, 'boot-A');
    assert.equal(status.startup, null, 'no reboot yet');
    assert.equal(status.storageFault, false);

    // Refusals carry their work instruction over the socket.
    await assert.rejects(
      client.call('dispose', { gen, launch: id<LaunchId>('L1'), disposition: 'accepted', reason: 'ok' }),
      (e: unknown) => e instanceof RemoteLedgerError && e.code === 'STOPPED' && e.wi === 'WI-15',
    );
  } finally {
    client.close();
    await new Promise<void>((r) => server.close(() => r()));
    cleanup();
  }
});

// ---------------------------------------------------------------- f. user words

test('f: user words are booked once per message, readable newest first, and booked even under a stop or the recovery pause', async () => {
  const { svc, paths, cleanup } = service();
  try {
    const r1 = await svc.recordUserWords({ message: 'msg-1', session: 'pm-s1', at: 100, text: '帮我做登录页' });
    await svc.recordUserWords({ message: 'msg-2', session: 'pm-s1', at: 200, text: '先停一下交付' });
    assert.deepEqual(await svc.recordUserWords({ message: 'msg-1', session: 'pm-s1', at: 100, text: '帮我做登录页' }), r1, 'a retry returns the original revision');
    await rejects(svc.recordUserWords({ message: 'msg-1', session: 'pm-s1', at: 100, text: 'something else' }), 'OP_CONFLICT', 'WI-20');
    await svc.stop({ stop: id<StopId>('S'), scope: { kind: 'all' }, words: '全部停下', at: 300 });
    await svc.recordUserWords({ message: 'msg-3', session: 'pm-s2', at: 300, text: '全部停下' });
    const latest = svc.latestUserWords({ limit: 2 });
    assert.deepEqual(latest.map((w) => [w.message, w.excerpt]), [['msg-3', '全部停下'], ['msg-2', '先停一下交付']]);
    assert.equal(svc.content.get(latest[0]!.text).toString(), '全部停下');
    assert.deepEqual(svc.latestUserWords({ session: 'pm-s1' }).map((w) => w.message), ['msg-2']);
    // A long message keeps its full text; the excerpt stays within 280 UTF-16 units without splitting a character.
    const long = '😀'.repeat(200);
    await svc.recordUserWords({ message: 'msg-4', session: 'pm-s1', at: 400, text: long });
    const w4 = svc.latestUserWords()[0]!;
    assert.equal(w4.excerpt, '😀'.repeat(140));
    assert.equal(svc.content.get(w4.text).toString(), long);
    // During the recovery pause too.
    await svc.setMission(M, 'open');
    crash(svc);
    const svc2 = new LedgerService({ paths, bootId: () => 'boot-B' });
    try {
      assert.equal(svc2.open().recoveryPause, true);
      await svc2.recordUserWords({ message: 'msg-5', session: 'pm-s1', at: 500, text: '刚才我说过停吗？' });
      assert.equal(svc2.latestUserWords()[0]!.message, 'msg-5');
    } finally {
      svc2.close();
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- g. the task queue

test('g: the task queue lives in the ledger: queued, dispatched, cancelled, superseded; a restarted scheduler reads it back', async () => {
  const { svc, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    const card = (t: string): ContentHash => svc.content.put(`card ${t}`);
    for (const t of ['T1', 'T2', 'T3', 'T4']) await svc.queueTask({ op: `q-${t}`, gen, task: t, lineage: `lin-${t}`, mission: t === 'T4' ? M2 : M, card: card(t) });
    assert.deepEqual(await svc.queueTask({ op: 'q-T1-again', gen, task: 'T1', lineage: 'lin-T1', mission: M, card: card('T1') }), { revision: svc.taskInfo('T1')!.queuedRevision }, 'queued again, same card: no-op');
    await rejects(svc.queueTask({ op: 'q-T1-other', gen, task: 'T1', lineage: 'lin-T1', mission: M, card: card('T1 v2') }), 'FACT_CONFLICT', 'WI-20');
    await svc.registerLaunch({ op: 'reg-L1', gen, launch: id<LaunchId>('L1'), tag: { mission: M, capabilities: [] } });
    await svc.dequeueTask({ op: 'd-T1', gen, task: 'T1', reason: 'dispatched', launch: id<LaunchId>('L1') });
    await svc.dequeueTask({ op: 'd-T2', gen, task: 'T2', reason: 'cancelled' });
    await svc.dequeueTask({ op: 'd-T3', gen, task: 'T3', reason: 'superseded', by: 'T3b' });
    await svc.queueTask({ op: 'q-T3b', gen, task: 'T3b', lineage: 'lin-T3', mission: M, card: card('T3b') });
    await rejects(svc.dequeueTask({ op: 'd-T1-again', gen, task: 'T1', reason: 'cancelled' }), 'NOT_QUEUED', null);
    await rejects(svc.dequeueTask({ op: 'd-T4-x', gen, task: 'T4', reason: 'dispatched', launch: id<LaunchId>('L1') }), 'SCOPE_MISMATCH');
    await rejects(svc.dequeueTask({ op: 'd-T4-y', gen, task: 'T4', reason: 'dispatched' }), 'RECORD_INVALID');
    // A task keeps its lineage, also when it is queued again (a retry).
    await rejects(svc.queueTask({ op: 'q-T1-lin', gen, task: 'T1', lineage: 'other', mission: M, card: card('T1') }), 'FACT_CONFLICT');
    await svc.queueTask({ op: 'q-T1-retry', gen, task: 'T1', lineage: 'lin-T1', mission: M, card: card('T1') });
    // A stale scheduler cannot change the queue.
    const g2 = await svc.beginGeneration();
    await rejects(svc.queueTask({ op: 'q-old', gen, task: 'T9', lineage: 'lin-T9', mission: M, card: card('T9') }), 'STALE_GENERATION', 'WI-15');
    // The queue as a restarted scheduler reads it.
    svc.close();
    svc.open();
    assert.deepEqual(svc.taskQueue().map((t) => [t.task, t.lineage, t.mission]), [['T4', 'lin-T4', 'm2'], ['T3b', 'lin-T3', 'm1'], ['T1', 'lin-T1', 'm1']]);
    assert.deepEqual(svc.taskQueue({ mission: M2 }).map((t) => t.task), ['T4']);
    assert.deepEqual([svc.taskInfo('T3')?.state, svc.taskInfo('T3')?.by, svc.taskInfo('T2')?.state], ['superseded', 'T3b', 'cancelled']);
    await svc.dequeueTask({ op: 'd-T4', gen: g2, task: 'T4', reason: 'cancelled' });
    assert.equal(svc.taskQueue().length, 2);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- the recovery.pause record and the startup decision

test('recovery.pause: every start after a reboot records its decision and basis; only queued tasks count as work; the PM clears the pause', async () => {
  const { paths, cleanup } = fresh();
  let boot = 'boot-A';
  const make = () => new LedgerService({ paths, bootId: () => boot });
  let svc = make();
  try {
    svc.open();
    // The service closed cleanly, then a reboot: not a clean machine shutdown (no probe clean-exit
    // records, core review r3 #13); with no work it goes on.
    svc.close();
    boot = 'boot-B';
    assert.equal(svc.open().recoveryPause, false);
    let d = svc.startupDecision()!;
    assert.deepEqual(
      [d.state, d.basis.evidence, d.basis.cleanShutdown, d.basis.ledgerClosedCleanly, d.basis.previousBoot, d.basis.boot],
      ['continued', 'abnormal-stop-no-spare-inbox', false, true, 'boot-A', 'boot-B'],
    );
    // An abnormal stop with nothing that could advance: go on.
    crash(svc);
    boot = 'boot-C';
    svc = make();
    assert.equal(svc.open().recoveryPause, false);
    d = svc.startupDecision()!;
    assert.deepEqual([d.state, d.basis.evidence, d.basis.work], ['continued', 'abnormal-stop-no-spare-inbox', { openMission: false, undecidedLaunch: false, unsettledIntent: false, queuedTask: false }]);
    // Only a queued task, no process running: still work that can advance (6.1).
    const gen = await svc.beginGeneration();
    await svc.queueTask({ op: 'q', gen, task: 'T1', lineage: 'lin-1', mission: M, card: svc.content.put('card') });
    crash(svc);
    boot = 'boot-D';
    svc = make();
    assert.equal(svc.open().recoveryPause, true);
    d = svc.startupDecision()!;
    assert.deepEqual([d.state, d.basis.work.queuedTask, d.clearedAt], ['set', true, null]);
    const status = svc.status();
    assert.deepEqual([status.recoveryPause, status.boot, status.startup?.state], [true, 'boot-D', 'set']);
    await rejects(svc.registerLaunch({ op: 'l', gen, launch: id<LaunchId>('L'), tag: { mission: M, capabilities: [] } }), 'RECOVERY_PAUSED', 'WI-12');
    await svc.confirmResume();
    assert.equal(svc.status().recoveryPause, false);
    assert.equal(typeof svc.startupDecision()!.clearedAt, 'number');
    const kinds = readRecords(paths.db, revision(0)).filter((c) => c.record.kind === 'recovery.pause').map((c) => (c.record as { state: string }).state);
    assert.deepEqual(kinds, ['continued', 'continued', 'set', 'cleared']);
    // The scheduler's own WI-12 alert can use its category again.
    await svc.raiseAlert({ op: 'al', alert: 'recovery-pause-1' as never, category: 'recovery-pause', wi: 'WI-12', body: svc.content.put('notice') });
  } finally {
    try {
      svc.close();
    } catch {
      /* closed */
    }
    cleanup();
  }
});

// ---------------------------------------------------------------- open question 4: the remaining content references

test('the remaining content references are verified: notice body, loop grant reason, mission block report, deferred issue reason', async () => {
  const { svc, cleanup } = service();
  try {
    const missing = 'e'.repeat(64) as ContentHash;
    const corrupt = svc.content.put('original');
    writeFileSync(svc.content.path(corrupt), 'tampered');
    for (const h of [missing, corrupt]) {
      await rejects(svc.appendRecords({ op: `n-${h}`, gen: null, records: [{ kind: 'notice', notice: `n-${h.slice(0, 8)}`, audience: 'pm', body: h }] }), 'CONTENT_MISSING', 'WI-15');
      await rejects(svc.appendRecords({ op: `g-${h}`, gen: null, records: [{ kind: 'loop.grant', lineage: 'L', loop: 'rework', by: 'user', extra: 1, reason: h }] }), 'CONTENT_MISSING');
      await rejects(svc.appendRecords({ op: `b-${h}`, gen: null, records: [{ kind: 'mission.block', mission: M, reason: 'budget', state: 'blocked', report: h }] }), 'CONTENT_MISSING');
    }
    const L = (xs: string[]) => svc.content.putList(xs);
    const judgment = (reason: ContentHash): BaseRecord => ({
      kind: 'judgment', judgment: `J-${reason.slice(0, 6)}` as never, review: 'reviewer', executor: 'reviewer', target: 'P' as never, verdict: 'pass', evidence: L([]), bases: L([]),
      constraints: L([]), reliesOn: L([]), issues: [{ issue: 'N' as never, response: 'deferred', owner: 'pm', reason }], revokes: null, extends: null,
      evidenceUse: { fields: [], statisticalOrExternal: false }, superseded: [],
    });
    await rejects(svc.appendRecords({ op: 'j-missing', gen: null, records: [judgment(missing)] }), 'CONTENT_MISSING');
    await svc.appendRecords({ op: 'j-ok', gen: null, records: [judgment(svc.content.put('owner pm, after the release'))] });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- 3.11: every refusal maps to a WI

test('every refusal code maps to a WI of the 3.11 exception table, or is a normal branch (null)', () => {
  const table = new Set(['WI-01', 'WI-02', 'WI-03', 'WI-04', 'WI-05', 'WI-06', 'WI-07', 'WI-08', 'WI-09', 'WI-10', 'WI-11', 'WI-12', 'WI-13', 'WI-14', 'WI-15', 'WI-16', 'WI-17', 'WI-18', 'WI-19', 'WI-20', 'WI-21']);
  for (const [code, wi] of Object.entries(REFUSAL_WI)) assert.ok(wi === null || table.has(wi), `${code} → ${wi}`);
  assert.deepEqual(
    Object.entries(REFUSAL_WI)
      .filter(([, wi]) => wi === null)
      .map(([c]) => c)
      .sort(),
    ['BELOW_FLOOR', 'CONTINUATION_REFUSED', 'NOT_QUEUED', 'PROOF_EXISTS', 'RENEWAL_REFUSED', 'STALE_REQUEST', 'STOPPED'],
  );
  assert.equal(new LedgerError('LOOP_EXHAUSTED', 'x').wi, 'WI-08');
  assert.equal(new LedgerError('STOPPED', 'x', 'WI-15').wi, 'WI-15');
});

test('an older ledger gets the loop columns added in place when it is opened', () => {
  const { dir, cleanup } = fresh();
  try {
    const path = join(dir, 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(
      'CREATE TABLE loops (lineage TEXT NOT NULL, loop TEXT NOT NULL, attempts INTEGER NOT NULL, by_class TEXT NOT NULL, last_signature TEXT, repeats INTEGER NOT NULL, secretary_grants INTEGER NOT NULL, extra INTEGER NOT NULL, PRIMARY KEY (lineage, loop))',
    );
    old.exec("INSERT INTO loops VALUES ('T', 'rework', 1, '{}', 's', 0, 0, 0)");
    old.close();
    const store = new Store(path);
    try {
      const cols = (store.db.prepare('PRAGMA table_info(loops)').all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes('attempts_at_grant') && cols.includes('no_progress_at'));
      assert.deepEqual({ ...(store.db.prepare('SELECT attempts, attempts_at_grant, no_progress_at FROM loops').get() as object) }, { attempts: 1, attempts_at_grant: null, no_progress_at: null });
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('dispatched tasks never queued again come back with their launch’s final disposition, so a restarted scheduler rebuilds its waiting items', async () => {
  const { svc, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    const card = (t: string): ContentHash => svc.content.put(`card ${t}`);
    for (const t of ['T1', 'T2', 'T3']) {
      await svc.queueTask({ op: `q-${t}`, gen, task: t, lineage: `lin-${t}`, mission: M, card: card(t) });
      await svc.registerLaunch({ op: `reg-${t}`, gen, launch: id<LaunchId>(`L-${t}`), tag: { mission: M, capabilities: [] } });
      await svc.dequeueTask({ op: `d-${t}`, gen, task: t, reason: 'dispatched', launch: id<LaunchId>(`L-${t}`) });
    }
    await svc.dispose({ gen, launch: id<LaunchId>('L-T1'), disposition: 'failed', reason: 'seat-failure' });
    await svc.dispose({ gen, launch: id<LaunchId>('L-T2'), disposition: 'failed', reason: 'environment-failure' });
    // T2 was queued again (a retry): no longer a waiting item.
    await svc.queueTask({ op: 'q-T2-again', gen, task: 'T2', lineage: 'lin-T2', mission: M, card: card('T2') });
    svc.close();
    svc.open(); // the scheduler restarts against the same ledger
    const waiting = svc.dispatchedTasks();
    assert.deepEqual(waiting.map((t) => [t.task, t.lineage, t.launch, t.disposition, t.reason, t.card]), [['T1', 'lin-T1', 'L-T1', 'failed', 'seat-failure', card('T1')]]);
    assert.deepEqual(svc.dispatchedTasks({ disposed: false }).map((t) => [t.task, t.disposition]), [['T1', 'failed'], ['T3', null]]);
  } finally {
    cleanup();
  }
});
