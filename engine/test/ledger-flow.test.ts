// The flows' ledger records (src/flow/RECORDS-NEEDED.md, src/flow/exploration/RECORDS-NEEDED.md) and the
// queued CLI/git items: flow.event (identity, no-op, conflict, atomic with its base records, indexed and paged
// reads), seat.result.sessionId, reads by record kind and mission, the stamp's result event with its execution,
// WI-23..27, the WI-12 answer, notice delivery states, PM actions, narrowing a stop atomically, closing a
// mission with its frozen snapshot, and the delivery's bound transform description.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerError, LedgerService, ledgerPaths, type LedgerErrorCode, type LedgerPaths } from '../src/ledger/service.ts';
import { LedgerClient, RemoteLedgerError, serveLedger } from '../src/ledger/ipc.ts';
import { readRecords } from '../src/ledger/store.ts';
import { EVALUATOR_INPUT_KINDS, WI_CATALOG, type BaseRecord } from '../src/common/records.ts';
import { RecordInvalid, validateRecord } from '../src/common/validate.ts';
import { id, revision, type AlertId, type BasisLineId, type BasisVersionId, type Generation, type LaunchId, type MissionId, type OpId, type StopId } from '../src/common/ids.ts';

const M = id<MissionId>('m1');
const M2 = id<MissionId>('m2');
const IDENT = { pid: process.pid, startTime: 'test-start', bootId: 'test-boot' };

function service(): { svc: LedgerService; paths: LedgerPaths; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mp-ledger-flow-'));
  const paths = ledgerPaths(join(dir, 'ledger'), join(dir, 'control'));
  const svc = new LedgerService({ paths, bootId: () => 'boot-A' });
  svc.open();
  return {
    svc,
    paths,
    dir,
    cleanup: () => {
      try {
        svc.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

async function rejects(p: Promise<unknown>, code: LedgerErrorCode, re?: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof LedgerError, `not a LedgerError: ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}

function event(svc: LedgerService, line: string, ev: string, key: string, body: unknown, mission: MissionId = M): BaseRecord {
  return { kind: 'flow.event', mission, line, event: ev, key, body: svc.content.put(JSON.stringify(body)) } as BaseRecord;
}

function basis(n: number, mission: MissionId | null = M): BaseRecord {
  return { kind: 'basis.version', basisKind: 'requirement', line: id<BasisLineId>(`req-${mission ?? 'p'}`), version: id<BasisVersionId>(`req-${mission ?? 'p'}.v${n}`), mission, scope: null } as BaseRecord;
}

function objectVersion(svc: LedgerService, object: string): BaseRecord {
  return {
    kind: 'object.version', object: object as never, objectKind: 'plan', mission: M, module: null, content: svc.content.put(`body of ${object}`),
    prerequisites: svc.content.putList([]), scope: { paths: ['plans/pm-plan.json'], taskType: 'pm-plan' }, reviews: [{ review: 'calibrator-1', basisLines: [], reliesOn: [] }],
  } as BaseRecord;
}

// ---------------------------------------------------------------- 1. flow.event

test('flow.event: identity (mission, line, event, key); the same body later is a no-op, another body FACT_CONFLICT; never an evaluator input or a pending result', async () => {
  const { svc, paths, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    assert.equal(EVALUATOR_INPUT_KINDS.has('flow.event' as never), false);
    // A PM batch with its PM plan object version, in one op.
    const r = await svc.appendRecords({ op: 'batch-1', gen, records: [event(svc, 'plan', 'pm-batch', '1', { n: 1 }), objectVersion(svc, 'pmplan.m1.1')] });
    assert.equal(r.revisions.length, 2);
    // The same identity and body in a later op: nothing appended, the op succeeds and names the first revision.
    const again = await svc.appendRecords({ op: 'batch-1-again', gen, records: [event(svc, 'plan', 'pm-batch', '1', { n: 1 })] });
    assert.deepEqual(again.revisions, [r.revisions[0]]);
    await rejects(svc.appendRecords({ op: 'batch-1-other', gen, records: [event(svc, 'plan', 'pm-batch', '1', { n: 2 })] }), 'FACT_CONFLICT');
    // Separators cannot make two identities meet: ("a:b", "c") and ("a", "b:c") are different lines/keys.
    await svc.appendRecords({ op: 'sep', gen, records: [event(svc, 'task:a', 'consumed', 'b:c', 1), event(svc, 'task:a:b', 'consumed', 'c', 2)] });
    // Atomic: an op whose second record is refused commits nothing.
    const before = readRecords(paths.db, revision(0)).length;
    await rejects(svc.appendRecords({ op: 'half', gen, records: [event(svc, 'plan', 'pm-batch', '2', { n: 2 }), event(svc, 'plan', 'pm-batch', '1', { n: 3 })] }), 'FACT_CONFLICT');
    assert.equal(readRecords(paths.db, revision(0)).length, before);
    assert.deepEqual(svc.flowEvents({ mission: M, line: 'plan', event: 'pm-batch' }).map((e) => e.key), ['1']);
    // Validation: the fields, and the body in the content store.
    const bad = (x: Record<string, unknown>) => svc.appendRecords({ op: `bad-${JSON.stringify(x).length}-${Math.random()}`, gen, records: [{ ...event(svc, 'plan', 'x', 'k', 0), ...x } as BaseRecord] });
    await rejects(bad({ event: 'Has Space' }), 'RECORD_INVALID', /event is 1 to 64/);
    await rejects(bad({ event: 'e'.repeat(65) }), 'RECORD_INVALID');
    await rejects(bad({ line: 'a\nb' }), 'RECORD_INVALID', /line is 1 to 200 printable/);
    await rejects(bad({ key: 'k'.repeat(201) }), 'RECORD_INVALID');
    await rejects(bad({ key: '' }), 'RECORD_INVALID');
    await rejects(bad({ mission: 'not an id' }), 'RECORD_INVALID');
    await rejects(bad({ body: 'f'.repeat(64) }), 'CONTENT_MISSING');
    // Unicode lines and keys are fine (printable).
    await svc.appendRecords({ op: 'unicode', gen, records: [event(svc, '探索:x1', 'round', '第 1 轮', { ok: true })] });
    // Seats never write flow events.
    await svc.registerLaunch({ op: 'reg', gen, launch: id<LaunchId>('L1'), tag: { mission: M, capabilities: [] } });
    await rejects(svc.submitPendingResult({ op: 'pend', launch: id<LaunchId>('L1'), records: [event(svc, 'plan', 'pm-batch', '9', 9)] }), 'KIND_NOT_ALLOWED');
  } finally {
    cleanup();
  }
});

test('flowEvents: by mission, line and event, in revision order, paged by after/limit; flowMissions lists missions with events', async () => {
  const { svc, cleanup } = service();
  try {
    const recs: BaseRecord[] = [];
    for (let i = 0; i < 25; i++) recs.push(event(svc, i % 2 === 0 ? 'plan' : 'secretary', i % 3 === 0 ? 'escalation' : 'decision', `k${i}`, { i }));
    recs.push(event(svc, 'plan', 'pm-batch', 'other-mission', 0, M2));
    await svc.appendRecords({ op: 'many', gen: null, records: recs });
    const all = svc.flowEvents({ mission: M });
    assert.equal(all.length, 25);
    assert.ok(all.every((e, i) => i === 0 || e.revision > all[i - 1]!.revision), 'revision order');
    assert.deepEqual(new Set(svc.flowEvents({ mission: M, line: 'plan' }).map((e) => e.line)), new Set(['plan']));
    assert.equal(svc.flowEvents({ mission: M, line: 'secretary', event: 'escalation' }).length, [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23].filter((i) => i % 3 === 0).length);
    // Paging.
    const pages: string[] = [];
    let after = 0;
    for (;;) {
      const page = svc.flowEvents({ mission: M, after, limit: 10 });
      pages.push(...page.map((e) => e.key));
      if (page.length < 10) break;
      after = page[page.length - 1]!.revision;
    }
    assert.deepEqual(pages, all.map((e) => e.key));
    assert.throws(() => svc.flowEvents({ mission: M, limit: 0 }), (e: unknown) => e instanceof LedgerError && e.code === 'BAD_REQUEST');
    assert.throws(() => svc.flowEvents({ mission: M, limit: 10_001 }), (e: unknown) => e instanceof LedgerError && e.code === 'BAD_REQUEST');
    // The body is the content hash; its JSON is in the content store.
    assert.deepEqual(JSON.parse(svc.content.get(all[0]!.body).toString('utf8')), { i: 0 });
    assert.deepEqual(svc.flowMissions(), [M, M2]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- 2. seat.result.sessionId

test('seat.result carries the session to resume after "needs evidence" (sessionId: an id or null)', () => {
  const seat = { kind: 'seat.result', launch: 'L1', seat: 'reviewer', status: 'needs-evidence', result: null, export: null, transcript: null, recoveryState: null, evidenceRequest: 'a'.repeat(64) };
  validateRecord({ ...seat, sessionId: 'sess-0b6f.2' });
  validateRecord({ ...seat, sessionId: null });
  validateRecord(seat);
  assert.throws(() => validateRecord({ ...seat, sessionId: 'has space' }), RecordInvalid);
  assert.throws(() => validateRecord({ ...seat, sessionId: 42 }), RecordInvalid);
});

// ---------------------------------------------------------------- 3. indexed reads

test('recordsByKind: indexed by kind (and mission), revision order, paged; objectVersion and judgmentById are lookups', async () => {
  const { svc, cleanup } = service();
  try {
    await svc.appendRecords({ op: 'a', gen: null, records: [basis(1), basis(1, M2), objectVersion(svc, 'pmplan.m1.1'), basis(2), basis(1, null)] });
    await svc.recordUserWords({ message: 'msg-1', session: 'pm', at: 1, text: 'hello' });
    await svc.appendRecords({ op: 'b', gen: null, records: [basis(3), event(svc, 'plan', 'pm-batch', '1', 1)] });
    const kinds = (q: Parameters<LedgerService['recordsByKind']>[0]) => svc.recordsByKind(q).map((c) => `${c.record.kind}:${(c.record as { version?: string; object?: string; message?: string }).version ?? (c.record as { object?: string }).object ?? (c.record as { message?: string }).message ?? ''}`);
    assert.deepEqual(kinds({ kinds: ['basis.version', 'object.version'] }), [
      'basis.version:req-m1.v1', 'basis.version:req-m2.v1', 'object.version:pmplan.m1.1', 'basis.version:req-m1.v2', 'basis.version:req-p.v1', 'basis.version:req-m1.v3',
    ]);
    assert.deepEqual(kinds({ kinds: ['basis.version', 'object.version'], mission: M }), ['basis.version:req-m1.v1', 'object.version:pmplan.m1.1', 'basis.version:req-m1.v2', 'basis.version:req-m1.v3']);
    assert.deepEqual(kinds({ kinds: ['user.words'] }), ['user.words:msg-1']);
    // Paged: `after` is the last revision of the previous page.
    const first = svc.recordsByKind({ kinds: ['basis.version'], limit: 2 });
    const second = svc.recordsByKind({ kinds: ['basis.version'], after: first[1]!.revision, limit: 2 });
    assert.deepEqual([...first, ...second].map((c) => (c.record as { version: string }).version), ['req-m1.v1', 'req-m2.v1', 'req-m1.v2', 'req-p.v1']);
    assert.throws(() => svc.recordsByKind({ kinds: [] }), (e: unknown) => e instanceof LedgerError && e.code === 'BAD_REQUEST');
    assert.equal((svc.objectVersion('pmplan.m1.1')?.record as { object: string }).object, 'pmplan.m1.1');
    assert.equal(svc.objectVersion('nope'), null);
    assert.equal(svc.judgmentById('J-none'), null);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- exploration: the stamp's result with its execution

test('commitProofOp carries flow events into the execution’s transaction (the legalization stamp and its result event)', async () => {
  const { svc, paths, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    await svc.appendRecords({ op: 'pend', gen, records: [{ kind: 'op.pending', op: id<OpId>('LG1'), opKind: 'legalization', objects: svc.content.putList([]), scope: { mission: M, capabilities: [] } } as BaseRecord] });
    const { epoch } = await svc.beginEvaluator({ gen, identity: IDENT });
    await svc.publish({ epoch, revision: svc.head(), batch: null });
    const result = event(svc, 'audit:L1', 'result', 'LG1', { stamped: true });
    await rejects(svc.commitProofOp({ op: 'x-bad', gen, opId: id<OpId>('LG1'), asOf: svc.publicationFloor(), events: [basis(9)] }), 'KIND_NOT_ALLOWED');
    // Below the floor: nothing is written, the result event neither.
    await rejects(svc.commitProofOp({ op: 'x-old', gen, opId: id<OpId>('LG1'), asOf: revision(1), events: [result] }), 'BELOW_FLOOR');
    assert.equal(svc.flowEvents({ mission: M, line: 'audit:L1' }).length, 0);
    const out = await svc.commitProofOp({ op: 'x', gen, opId: id<OpId>('LG1'), asOf: svc.publicationFloor(), events: [result] });
    const log = readRecords(paths.db, revision(0));
    assert.equal(log.find((c) => c.record.kind === 'op.executed')?.revision, out.revision);
    assert.deepEqual(svc.flowEvents({ mission: M, line: 'audit:L1' }).map((e) => [e.event, e.key]), [['result', 'LG1']]);
    // A retry of the op returns the first answer.
    assert.deepEqual(await svc.commitProofOp({ op: 'x', gen, opId: id<OpId>('LG1'), asOf: svc.publicationFloor(), events: [result] }), out);
  } finally {
    cleanup();
  }
});

test('WI-23..WI-27 are in the catalog: the flows’ notices are accepted; WI-28 is not', async () => {
  const { svc, cleanup } = service();
  try {
    assert.deepEqual(['WI-23', 'WI-24', 'WI-25', 'WI-26', 'WI-27'].map((w) => WI_CATALOG.has(w)), [true, true, true, true, true]);
    for (const wi of ['WI-23', 'WI-24', 'WI-25', 'WI-26', 'WI-27']) {
      await svc.raiseAlert({ op: `al-${wi}`, alert: id<AlertId>(`a-${wi}`), category: 'flow', wi, body: svc.content.put(`${wi} body`) });
    }
    await assert.rejects(svc.raiseAlert({ op: 'al-28', alert: id<AlertId>('a-28'), category: 'flow', wi: 'WI-28', body: svc.content.put('x') }), (e: unknown) => e instanceof LedgerError);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- notices, PM actions

test('notice delivery: delivered, then acknowledged, never back; absent means undelivered', async () => {
  const { svc, cleanup } = service();
  try {
    assert.deepEqual(svc.noticeDeliveries({ notices: ['A1'] }), []);
    assert.deepEqual(await svc.markNotice({ notice: 'A1', state: 'delivered' }), { state: 'delivered', changed: true });
    assert.deepEqual(await svc.markNotice({ notice: 'A1', state: 'delivered' }), { state: 'delivered', changed: false });
    assert.deepEqual(await svc.markNotice({ notice: 'A1', state: 'acknowledged' }), { state: 'acknowledged', changed: true });
    assert.deepEqual(await svc.markNotice({ notice: 'A1', state: 'delivered' }), { state: 'acknowledged', changed: false }, 'never back');
    // Acknowledged straight away implies delivered.
    await svc.markNotice({ notice: 'N2', state: 'acknowledged' });
    const d = new Map(svc.noticeDeliveries({ notices: ['A1', 'N2', 'N3'] }).map((x) => [x.notice, x]));
    assert.deepEqual([d.get('A1')?.state, d.get('N2')?.state, d.has('N3')], ['acknowledged', 'acknowledged', false]);
    assert.ok(d.get('N2')!.deliveredAt > 0 && d.get('N2')!.acknowledgedAt !== null);
    await rejects(svc.markNotice({ notice: 'x\ny', state: 'delivered' }), 'BAD_REQUEST');
    await rejects(svc.markNotice({ notice: 'A1', state: 'read' as never }), 'BAD_REQUEST');
  } finally {
    cleanup();
  }
});

test('pm.action: the PM’s choice per a WI with its operation id: started, done or failed; other arguments under the same id are OP_CONFLICT; done is final', async () => {
  const { svc, cleanup } = service();
  try {
    const start = { action: 'resume-20261009T120000-ab12cd', command: 'resume', args: { answer: 'no' }, wi: 'WI-12', state: 'started' as const };
    assert.equal((await svc.recordPmAction(start)).state, 'started');
    assert.equal((await svc.recordPmAction(start)).revision, null, 'started again: nothing new');
    await rejects(svc.recordPmAction({ ...start, args: { answer: 'yes' } }), 'OP_CONFLICT');
    await svc.recordPmAction({ ...start, state: 'failed', result: { error: 'UNAVAILABLE' } });
    await svc.recordPmAction(start); // retried after the failure
    await svc.recordPmAction({ ...start, state: 'done', result: { resumed: true } });
    assert.deepEqual(await svc.recordPmAction({ ...start, state: 'failed', result: {} }), { state: 'done', revision: null }, 'done is final');
    const a = svc.pmAction(start.action)!;
    assert.deepEqual([a.command, a.wi, a.state], ['resume', 'WI-12', 'done']);
    assert.deepEqual(JSON.parse(svc.content.get(a.result!).toString('utf8')), { resumed: true });
    assert.deepEqual(JSON.parse(svc.content.get(a.args).toString('utf8')), { command: 'resume', args: { answer: 'no' } });
    await svc.recordPmAction({ action: 'deliver-1', command: 'deliver', args: { mission: 'm1' }, state: 'started' });
    assert.deepEqual(svc.pmActions({ limit: 10 }).map((x) => x.action), ['deliver-1', start.action]);
    await rejects(svc.recordPmAction({ ...start, action: 'x', wi: 'WI-xx' }), 'BAD_REQUEST');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- narrowStop

test('narrowStop: the narrower stop is committed and the old one released in one transaction, linked both ways; never wider', async () => {
  const { svc, paths, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    await svc.stop({ stop: id<StopId>('S-all'), scope: { kind: 'all' }, words: '全停', at: 1 });
    await rejects(svc.narrowStop({ old: id<StopId>('S-all'), stop: { stop: id<StopId>('S-all-2'), scope: { kind: 'all' }, words: 'x', at: 2 } }), 'BAD_REQUEST', /is the old scope/);
    const out = await svc.narrowStop({ old: id<StopId>('S-all'), stop: { stop: id<StopId>('S-m1'), scope: { kind: 'mission', mission: M }, words: '只停 m1', at: 2 } });
    assert.deepEqual(out as unknown, { old: 'S-all', stop: 'S-m1', narrowed: true });
    // One transaction: both records under adjacent revisions, nothing between them.
    const log = readRecords(paths.db, revision(0)).filter((c) => c.record.kind === 'stop.committed' || c.record.kind === 'stop.released');
    const [c, r] = log.slice(-2);
    assert.deepEqual([c!.record.kind, r!.record.kind, r!.revision - c!.revision], ['stop.committed', 'stop.released', 1]);
    assert.deepEqual([svc.stopInfo(id<StopId>('S-m1'))?.narrows, svc.stopInfo(id<StopId>('S-all'))?.narrowedTo, svc.stopInfo(id<StopId>('S-all'))?.state] as unknown, ['S-all', 'S-m1', 'released']);
    assert.deepEqual(svc.activeStops().map((s) => [s.stop, s.narrows]) as unknown, [['S-m1', 'S-all']]);
    // The narrower scope stays restricted; the rest is free.
    await rejects(svc.authorize({ op: 'a1', gen, launch: null, intent: 'i1', kind: 'network', domain: 'n1', tag: { mission: M, capabilities: [] }, details: {} }), 'STOPPED');
    await svc.authorize({ op: 'a2', gen, launch: null, intent: 'i2', kind: 'network', domain: 'n2', tag: { mission: M2, capabilities: [] }, details: {} });
    // A retry after it committed; a released or unknown old stop; a wider scope.
    assert.deepEqual((await svc.narrowStop({ old: id<StopId>('S-all'), stop: { stop: id<StopId>('S-m1'), scope: { kind: 'mission', mission: M }, words: '只停 m1', at: 2 } })) as unknown, { old: 'S-all', stop: 'S-m1', narrowed: false });
    await rejects(svc.narrowStop({ old: id<StopId>('S-all'), stop: { stop: id<StopId>('S-m2'), scope: { kind: 'mission', mission: M2 }, words: 'x', at: 3 } }), 'BAD_REQUEST', /not an active stop/);
    await rejects(svc.narrowStop({ old: id<StopId>('S-m1'), stop: { stop: id<StopId>('S-cap'), scope: { kind: 'capability', capability: 'net' }, words: 'x', at: 3 } }), 'BAD_REQUEST', /not within/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- missions and closing

test('closeMission: a frozen closing snapshot (published revision, unfinished tasks, the caller’s document) and the mission closed; a later close is a new version', async () => {
  const { svc, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    await svc.setMission(M, 'open');
    await svc.setMission(M2, 'open');
    const card = svc.content.put('card');
    for (const t of ['T1', 'T2', 'T3']) await svc.queueTask({ op: `q-${t}`, gen, task: t, lineage: `lin-${t}`, mission: M, card });
    await svc.registerLaunch({ op: 'reg', gen, launch: id<LaunchId>('L2'), tag: { mission: M, capabilities: [] } });
    await svc.dequeueTask({ op: 'd2', gen, task: 'T2', reason: 'dispatched', launch: id<LaunchId>('L2') });
    await svc.registerLaunch({ op: 'reg3', gen, launch: id<LaunchId>('L3'), tag: { mission: M, capabilities: [] } });
    await svc.dequeueTask({ op: 'd3', gen, task: 'T3', reason: 'dispatched', launch: id<LaunchId>('L3') });
    await svc.dispose({ gen, launch: id<LaunchId>('L3'), disposition: 'cancelled', reason: 'user stop' });
    const { epoch } = await svc.beginEvaluator({ gen, identity: IDENT });
    await svc.publish({ epoch, revision: svc.head(), batch: null });
    assert.deepEqual(svc.missions().map((m) => m.mission), [M, M2]);
    await rejects(svc.closeMission({ op: 'c-bad', mission: M, mode: 'full', snapshot: 'f'.repeat(64) as never }), 'CONTENT_MISSING');
    await rejects(svc.closeMission({ op: 'c-bad2', mission: M, mode: 'soon' as never }), 'BAD_REQUEST');
    const snapshot = svc.content.put('{"proof":"...","risks":["r1"]}');
    const c1 = await svc.closeMission({ op: 'c1', mission: M, mode: 'with-risk', waitRunning: true, snapshot });
    assert.deepEqual([c1.version, c1.asOf], [1, svc.publicationFloor()]);
    assert.deepEqual(JSON.parse(svc.content.get(c1.unfinished).toString('utf8')), { mission: M, queued: ['T1'], running: [{ task: 'T2', launch: 'L2' }] });
    assert.deepEqual(await svc.closeMission({ op: 'c1', mission: M, mode: 'with-risk', waitRunning: true, snapshot }), c1, 'a retry returns the first answer');
    assert.deepEqual(svc.missions().map((m) => m.mission), [M2]);
    assert.deepEqual(svc.missions({ state: 'closed' }), [{ mission: M, state: 'closed', closes: 1 }]);
    // After repairs, a new snapshot version.
    const c2 = await svc.closeMission({ op: 'c2', mission: M, mode: 'post-audit' });
    assert.equal(c2.version, 2);
    assert.deepEqual(svc.missionCloses(M).map((x) => [x.version, x.mode, x.waitRunning, x.snapshot]), [[1, 'with-risk', true, snapshot], [2, 'post-audit', false, null]]);
    assert.equal(svc.missions({ state: 'all' }).length, 2);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- the delivery's bound transform description

test('recordDelivery stores the bound transform description; deliveryInfo and the landing intent return it', async () => {
  const { svc, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    const description = svc.content.put('{"transform":"v1"}');
    const ref = 'refs/mission-pipeline/delivered/m1/op-1';
    await rejects(svc.recordDelivery({ op: 'r0', mission: M, delivery: 'op-1', commit: '1'.repeat(40), base: 'b'.repeat(40), ref, manifest: svc.content.put('m'), description: 'e'.repeat(64) as never }), 'CONTENT_MISSING');
    await svc.recordDelivery({ op: 'r1', mission: M, delivery: 'op-1', commit: '1'.repeat(40), base: 'b'.repeat(40), ref, manifest: svc.content.put('m'), target: 'main', description });
    assert.equal(svc.deliveryInfo(M, 'op-1')?.description, description);
    await svc.authorize({
      op: 'l1', gen, launch: null, intent: 'land-1', kind: 'landing', domain: 'landing:r', tag: { mission: M, capabilities: [] },
      details: { delivery: { mission: M, op: 'op-1', commit: '1'.repeat(40), base: 'b'.repeat(40), targetBranch: 'main' } },
    });
    assert.equal(svc.intentInfo('land-1')?.delivery?.description, description);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- over IPC

test('over IPC: flowEvents, flowMissions, recordsByKind, objectVersion, missions, narrowStop, markNotice, recordPmAction, closeMission, confirmResume', async () => {
  const { svc, dir, cleanup } = service();
  const sock = join(dir, 'ledger.sock');
  const server = serveLedger(svc, sock);
  const client = new LedgerClient(sock, 5000);
  try {
    const gen = (await client.call('beginGeneration', {})) as Generation;
    await client.call('appendRecords', { op: 'a', gen, records: [event(svc, 'plan', 'pm-batch', '1', 1), objectVersion(svc, 'pmplan.m1.1')] });
    assert.equal(((await client.call('flowEvents', { mission: M })) as unknown[]).length, 1);
    assert.deepEqual(await client.call('flowMissions', {}), [M]);
    assert.equal(((await client.call('recordsByKind', { kinds: ['object.version'], mission: M })) as unknown[]).length, 1);
    assert.notEqual(await client.call('objectVersion', { object: 'pmplan.m1.1' }), null);
    await client.call('setMission', { mission: M, state: 'open' });
    assert.deepEqual(((await client.call('missions', {})) as Array<{ mission: string }>).map((m) => m.mission), [M]);
    await client.call('stop', { stop: id<StopId>('S1'), scope: { kind: 'all' }, words: '停', at: 1 });
    assert.deepEqual(await client.call('narrowStop', { old: id<StopId>('S1'), stop: { stop: id<StopId>('S2'), scope: { kind: 'mission', mission: M }, words: '停 m1', at: 2 } }), { old: 'S1', stop: 'S2', narrowed: true });
    assert.equal(((await client.call('stopInfo', { stop: 'S2' })) as { narrows: string }).narrows, 'S1');
    assert.equal(((await client.call('markNotice', { notice: 'A1', state: 'delivered' })) as { changed: boolean }).changed, true);
    assert.equal(((await client.call('noticeDeliveries', { notices: ['A1'] })) as unknown[]).length, 1);
    await client.call('recordPmAction', { action: 'op-1', command: 'close', args: { mission: M }, state: 'started' });
    assert.equal(((await client.call('pmAction', { action: 'op-1' })) as { state: string }).state, 'started');
    assert.equal(((await client.call('closeMission', { op: 'c1', mission: M, mode: 'full' })) as { version: number }).version, 1);
    assert.equal(((await client.call('missionCloses', { mission: M })) as unknown[]).length, 1);
    assert.deepEqual(await client.call('confirmResume', { op: 'resume-1', answer: 'no' }), { cleared: false }, 'no pause in force: nothing recorded');
    await assert.rejects(client.call('appendRecords', { op: 'b', gen, records: [event(svc, 'plan', 'pm-batch', '1', 2)] }), (e: unknown) => e instanceof RemoteLedgerError && e.code === 'FACT_CONFLICT');
  } finally {
    client.close();
    await new Promise<void>((r) => server.close(() => r()));
    cleanup();
  }
});
