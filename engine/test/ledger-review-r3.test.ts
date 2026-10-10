// Ledger: regressions for the core review round 3 (gpt-6.1-sol) ledger-side findings
// 2, 3, 6, 7, 8, 10, 11, 15, 16, 17, 18, 22, 23 (12 and 13 are in ledger-stops-startup),
// ported from the reviewer's scratch/*-r3.ts; plus the seat result's transcript and tool
// log fields, and the v48 wording of the stop entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LedgerError, LedgerService, MAX_REQUEST_BYTES, ledgerPaths, type LedgerPaths, type ServiceOptions } from '../src/ledger/service.ts';
import { LedgerClient, RemoteLedgerError, serveLedger } from '../src/ledger/ipc.ts';
import { rebuildStateFromLog } from '../src/ledger/rebuild.ts';
import { Store, readRecords } from '../src/ledger/store.ts';
import { STOP_NOT_PERSISTED_NOTICE, STOP_PERSISTED_MESSAGE, stopDeliveryStates, stopEntry } from '../src/ledger/stops.ts';
import { validateRecord } from '../src/common/validate.ts';
import { id, revision, type AlertId, type BasisLineId, type BasisVersionId, type ContentHash, type Generation, type LaunchId, type MissionId, type OpId, type StopId } from '../src/common/ids.ts';
import type { BaseRecord, ListRef, TerminationProofRecord } from '../src/common/records.ts';

const M = id<MissionId>('m1');
const IDENT = { pid: process.pid, startTime: 't', bootId: 'b' };

function service(opts: Partial<ServiceOptions> = {}): { svc: LedgerService; paths: LedgerPaths; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mp-ledger-r3-'));
  const paths = ledgerPaths(join(dir, 'ledger'), join(dir, 'control'), { backupInbox: null });
  const svc = new LedgerService({ paths, bootId: () => 'boot-r3', watchStops: false, inboxSlots: 34, ...opts });
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

async function rejects(p: Promise<unknown>, code: string, wi?: string | null): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof LedgerError || e instanceof RemoteLedgerError, String(e));
    assert.equal((e as LedgerError).code, code, (e as Error).message);
    if (wi !== undefined) assert.equal((e as LedgerError).wi, wi);
    return true;
  });
}

function plan(svc: LedgerService, object: string, extra: Record<string, unknown> = {}): BaseRecord {
  return {
    kind: 'object.version', object: object as never, objectKind: 'plan', mission: M, module: null, content: svc.content.put(`body ${object}`),
    prerequisites: svc.content.putList([]), scope: { paths: ['p.md'], taskType: 'plan' }, reviews: [{ review: 'r', basisLines: [], reliesOn: [] }], ...extra,
  } as BaseRecord;
}

function judge(svc: LedgerService, judgment: string, target: string): BaseRecord {
  const e = svc.content.putList([]);
  return {
    kind: 'judgment', judgment: judgment as never, target: target as never, review: 'r', executor: 'reviewer', verdict: 'pass', evidence: e, bases: e, constraints: e, reliesOn: e,
    issues: [], revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [],
  };
}

const proof = (launch: string): TerminationProofRecord => ({ kind: 'termination.proof', launch: id<LaunchId>(launch), exit: { code: 0, signal: null }, controlOomKill: 0, unitOomKill: 0, unitOom: 0 });

test('r3 #2: the acceptance reads the material as it is now: a body damaged after submission is refused by the same service (cache bypassed), lists too', async () => {
  const { svc, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    for (const [launch, damage] of [['L1', 'body'], ['L2', 'list']] as const) {
      await svc.registerLaunch({ op: `l-${launch}`, gen, launch: id<LaunchId>(launch), tag: { mission: M, capabilities: [] } });
      const body = svc.content.put(`valid pending body ${launch}`);
      const list = svc.content.putList([`x-${launch}`]);
      await svc.submitPendingResult({ op: `p-${launch}`, launch: id<LaunchId>(launch), records: [plan(svc, `CACHED-${launch}`, { content: body, prerequisites: list })] });
      await svc.registerProof(proof(launch));
      writeFileSync(svc.content.path(damage === 'body' ? body : list.hash), 'damaged');
      await rejects(svc.dispose({ gen, launch: id<LaunchId>(launch), disposition: 'accepted', reason: 'ok' }), 'CONTENT_MISSING', 'WI-15');
      assert.equal(svc.dispositionFor(id<LaunchId>(launch)), null);
    }
  } finally {
    cleanup();
  }
});

test('r3 #3: a proof-conditioned operation while the derived state cannot be computed ends (recorded, WI-11) instead of executing', async () => {
  const { svc, paths, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    const objects = svc.content.putList(['P']);
    await svc.appendRecords({ op: 'records', gen, records: [plan(svc, 'P'), judge(svc, 'J', 'P'), { kind: 'op.pending', op: id<OpId>('D'), opKind: 'delivery', objects, scope: { mission: M, capabilities: [] } }] });
    const { epoch } = await svc.beginEvaluator({ gen, identity: IDENT });
    await svc.publish({ epoch, revision: svc.head(), batch: null });
    await svc.setEvaluatorFault('rebuild failed');
    const asOf = svc.publicationFloor();
    await rejects(svc.commitProofOp({ op: 'execute', gen, opId: id<OpId>('D'), asOf }), 'EVALUATOR_FAULT', 'WI-11');
    await rejects(svc.commitProofOp({ op: 'execute', gen, opId: id<OpId>('D'), asOf }), 'EVALUATOR_FAULT'); // a retry: the same answer
    const log = readRecords(paths.db, revision(0)).map((c) => c.record.kind);
    assert.ok(log.includes('op.ended'));
    assert.ok(!log.includes('op.executed'));
    // After recovery the ended operation stays ended: it is registered again under a new id.
    await svc.clearEvaluatorFault();
    await rejects(svc.commitProofOp({ op: 'execute-2', gen, opId: id<OpId>('D'), asOf: svc.publicationFloor() }), 'NOT_PENDING');
  } finally {
    cleanup();
  }
});

test('r3 #6 (ledger side): a failure recorded with its id and a lost reply counts once when retried', async () => {
  const { svc, cleanup } = service();
  try {
    assert.equal(await svc.recordEvaluatorFailure({ op: 'evaluator-failure:1:4242:crash' }), 1); // committed; the reply is lost
    assert.equal(await svc.recordEvaluatorFailure({ op: 'evaluator-failure:1:4242:crash' }), 1); // the supervisor retries
    assert.equal(svc.evaluatorHealth().failures, 1);
  } finally {
    cleanup();
  }
});

test('r3 #7: a successful publication resets the budget in the same transaction; a superseded scheduler or evaluator cannot change it', async () => {
  const { svc, cleanup } = service();
  try {
    const g1 = await svc.beginGeneration();
    const { epoch } = await svc.beginEvaluator({ gen: g1, identity: IDENT });
    await svc.recordEvaluatorFailure();
    await svc.recordEvaluatorFailure();
    await svc.recordEvaluatorFailure();
    await svc.publish({ epoch, revision: svc.head(), batch: null });
    assert.equal(svc.evaluatorHealth().failures, 0, 'reset by the publication itself');
    await svc.recordEvaluatorFailure({ gen: g1 });
    const g2: Generation = await svc.beginGeneration();
    await rejects(svc.recordEvaluatorSuccess(), 'STALE_EVALUATOR', 'WI-11');
    await rejects(svc.recordEvaluatorSuccess({ epoch }), 'STALE_EVALUATOR');
    await rejects(svc.recordEvaluatorFailure({ gen: g1 }), 'STALE_GENERATION');
    await rejects(svc.setEvaluatorFault('x', { gen: g1 }), 'STALE_GENERATION');
    assert.equal(svc.evaluatorHealth().failures, 1);
    const e2 = await svc.beginEvaluator({ gen: g2, identity: IDENT });
    await svc.recordEvaluatorSuccess({ epoch: e2.epoch });
    assert.equal(svc.evaluatorHealth().failures, 0);
  } finally {
    cleanup();
  }
});

test('r3 #8: a rebuild of a live ledger reads one consistent snapshot, whatever the writer commits between pages', async () => {
  const { svc, dir, cleanup } = service();
  const original = DatabaseSync.prototype.prepare;
  try {
    const gen = await svc.beginGeneration();
    await svc.beginEvaluator({ gen, identity: IDENT });
    let injected = false;
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      if (!injected && sql.startsWith('SELECT seq, after_rev, kind, op, record, committed_at FROM journal')) {
        injected = true;
        // The reviewer's interleaving: a legitimate writer commit between the last log page and the first journal page.
        const x = svc as unknown as { write(fn: (s: unknown) => void): void; emit(s: unknown, r: BaseRecord, op: null): number; emitJournal(s: unknown, r: BaseRecord, op: null): void };
        x.write((s) => {
          const rev = x.emit(s, { kind: 'mission.state', mission: id<MissionId>('RACE'), state: 'open' }, null);
          x.emitJournal(s, { kind: 'evaluator.published', epoch: 1, revision: rev }, null);
        });
      }
      return original.call(this, sql);
    } as typeof original;
    const into = join(dir, 'rebuilt.sqlite');
    rebuildStateFromLog(svc.paths.db, svc.paths.content, { into });
    DatabaseSync.prototype.prepare = original;
    assert.ok(injected);
    const result = new Store(into);
    try {
      const head = result.head();
      const floor = Number(result.getState('publication_floor') ?? '0');
      const race = Boolean(result.stmt('SELECT 1 FROM missions WHERE mission = ?').get('RACE'));
      assert.ok(floor <= head, `floor ${floor} beyond head ${head}`);
      assert.equal(race, floor > 0 && floor === head, 'the mission and the floor that follows it come from the same moment');
    } finally {
      result.close();
    }
  } finally {
    DatabaseSync.prototype.prepare = original;
    cleanup();
  }
});

test('r3 #10: limits in UTF-8 bytes and per request; the queued part of the largest legal request stays within budget; the request is fixed at entry', async () => {
  const actions: Array<{ name: string; ms: number }> = [];
  const { svc, paths, cleanup } = service({ onAction: (name, ms) => actions.push({ name, ms }) });
  try {
    const ev = (evidence: string, x: string): BaseRecord => ({ kind: 'evidence', evidence: evidence as never, envLine: 'env' as never, envSnapshot: 's1' as never, runClass: 'closed', fields: { x } });
    // The reviewer's record: 60,113 characters, 180,113 UTF-8 bytes.
    await rejects(svc.appendRecords({ op: 'unicode', gen: null, records: [ev('UNICODE', '汉'.repeat(60_000))] }), 'TOO_LARGE', 'WI-15');
    // The reviewer's batch: 1,000 records of 60 KB.
    const t0 = Date.now();
    await rejects(svc.appendRecords({ op: 'big-batch', gen: null, records: Array.from({ length: 1000 }, (_, i) => ev(`BIG${i}`, 'x'.repeat(60_000))) }), 'TOO_LARGE');
    assert.ok(Date.now() - t0 < 2_000);
    // The largest legal request: just under MAX_REQUEST_BYTES.
    const n = Math.floor(MAX_REQUEST_BYTES / 62_000);
    await svc.appendRecords({ op: 'max', gen: null, records: Array.from({ length: n }, (_, i) => ev(`MAX${i}`, 'y'.repeat(61_000))) });
    const queued = actions.filter((a) => a.name === 'appendRecords').at(-1)!;
    assert.ok(queued.ms < 500, `the queued part took ${queued.ms.toFixed(1)} ms`);
    // The reviewer's REQUEST_MUTATION: a change after the call never reaches the log.
    const mutate = plan(svc, 'MUTATE') as { scope: { paths: string[] } };
    const p = svc.appendRecords({ op: 'mutate', gen: null, records: [mutate as unknown as BaseRecord] });
    mutate.scope.paths = ['other/path'];
    await p;
    const rec = readRecords(paths.db, revision(0)).find((c) => (c.record as { object?: string }).object === 'MUTATE')!.record as { scope: { paths: string[] } };
    assert.deepEqual(rec.scope.paths, ['p.md']);
  } finally {
    cleanup();
  }
});

test('r3 #11: a committed operation retried after a restart returns its original result before any check, even when its content is damaged now', async () => {
  const { svc, paths, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    const recs = [plan(svc, 'P')];
    const first = await svc.appendRecords({ op: 'records', gen, records: recs });
    writeFileSync(svc.content.path((recs[0] as { content: ContentHash }).content), 'broken');
    svc.close();
    const next = new LedgerService({ paths, bootId: () => 'boot-r3', watchStops: false });
    next.open();
    try {
      assert.deepEqual(await next.appendRecords({ op: 'records', gen, records: recs }), first);
      await rejects(next.appendRecords({ op: 'records', gen, records: [plan(next, 'OTHER')] }), 'OP_CONFLICT', 'WI-20');
    } finally {
      next.close();
    }
    svc.open();
  } finally {
    cleanup();
  }
});

test('r3 #15: composite identities are unambiguous: run layers (A:B, C) and (A, B:C) are two facts', async () => {
  const { svc, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    await svc.registerLaunch({ op: 'l', gen, launch: id<LaunchId>('A:B'), tag: { mission: M, capabilities: [] } });
    const layer = (launch: string, run: string): BaseRecord => ({ kind: 'run.layer', launch: launch as never, run: run as never, finalOom: 0, finalOomKill: 0, oomDelta: 0, oomKillDelta: 0, status: 'completed' });
    await svc.submitPendingResult({ op: 'p', launch: id<LaunchId>('A:B'), records: [layer('A:B', 'C'), layer('A', 'B:C')] });
    await svc.registerProof(proof('A:B'));
    const d = await svc.dispose({ gen, launch: id<LaunchId>('A:B'), disposition: 'accepted', reason: 'ok' });
    assert.equal(d.revisions.length, 2);
    assert.notEqual(d.revisions[0], d.revisions[1]);
  } finally {
    cleanup();
  }
});

test('r3 #16 and #17: a second Secretary grant on another loop of the lineage is refused; a notice whose body is missing is refused', async () => {
  const { svc, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    const reason = svc.content.put('extra retry');
    await svc.appendRecords({ op: 'grant1', gen, records: [{ kind: 'loop.grant', lineage: 'LINEAGE', loop: 'env-retry', by: 'secretary', extra: 2, reason }] });
    await rejects(svc.appendRecords({ op: 'grant2', gen, records: [{ kind: 'loop.grant', lineage: 'LINEAGE', loop: 'rework', by: 'secretary', extra: 2, reason }] }), 'GRANT_LIMIT', 'WI-08');
    await rejects(svc.appendRecords({ op: 'n', gen: null, records: [{ kind: 'notice', notice: 'BAD_CONTENT', audience: 'pm', body: 'f'.repeat(64) as ContentHash }] }), 'CONTENT_MISSING');
  } finally {
    cleanup();
  }
});

test('r3 #18: an alert names a 3.11 WI or says it is informational; a failing content disk is a storage fault; a defect over IPC is INTERNAL_ERROR, not BAD_REQUEST', async () => {
  const { svc, dir, cleanup } = service();
  try {
    const body = svc.content.put('trigger and default action');
    await rejects(svc.raiseAlert({ op: 'a1', alert: id<AlertId>('NO_WI'), category: 'arbitrary-exception', body }), 'RECORD_INVALID');
    await rejects(svc.raiseAlert({ op: 'a2', alert: id<AlertId>('BAD_WI'), category: 'x', wi: 'WI-99', body }), 'RECORD_INVALID');
    await rejects(svc.raiseAlert({ op: 'a3', alert: id<AlertId>('BOTH'), category: 'x', wi: 'WI-12', informational: true, body }), 'RECORD_INVALID');
    await svc.raiseAlert({ op: 'a4', alert: id<AlertId>('STOP_REPORT'), category: 'stop-report', informational: true, body });
    await svc.raiseAlert({ op: 'a5', alert: id<AlertId>('WI_ALERT'), category: 'cleanup', wi: 'WI-14', body });
    // IPC: a defect keeps its own code.
    const sock = join(dir, 'l.sock');
    const server = serveLedger(svc, sock);
    const client = new LedgerClient(sock, 5_000);
    try {
      await assert.rejects(client.call('landingState', {} as never), (e: unknown) => e instanceof RemoteLedgerError && e.code === 'INTERNAL_ERROR' && e.wi === 'WI-20');
    } finally {
      client.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
    // The content disk is full: STORAGE_FAULT (WI-12), and the service refuses writes.
    const native = svc.content.putAsync.bind(svc.content);
    svc.content.putAsync = async () => {
      throw Object.assign(new Error('ENOSPC: content volume full'), { code: 'ENOSPC' });
    };
    await rejects(svc.authorize({ op: 'fail-content', gen: null, launch: null, intent: 'I', kind: 'network', domain: 'net', tag: { mission: M, capabilities: [] }, details: {} }), 'STORAGE_FAULT', 'WI-12');
    svc.content.putAsync = native;
    assert.equal(svc.inStorageFault, true);
    await rejects(svc.beginGeneration(), 'STORAGE_FAULT');
  } finally {
    cleanup();
  }
});

test('r3 #22: a request line has a size limit and a connection a limit of waiting requests; pipelined requests are all answered, in order', async () => {
  const { svc, dir, cleanup } = service();
  const sock = join(dir, 'l.sock');
  let maxPending = 0;
  const server = serveLedger(svc, sock, { maxLineBytes: 64 * 1024, maxPending: 8, onPending: (n) => (maxPending = Math.max(maxPending, n)) });
  try {
    const { createConnection } = await import('node:net');
    // A line without end: refused once it passes the limit; the connection closes.
    const big = await new Promise<string>((resolve) => {
      const c = createConnection(sock);
      let got = '';
      c.setEncoding('utf8');
      c.on('data', (d: string) => (got += d));
      c.on('close', () => resolve(got));
      c.on('connect', () => c.write('{"id":1,"method":"head","params":' + ' '.repeat(100 * 1024)));
    });
    assert.match(big, /TOO_LARGE/);
    // 300 pipelined requests: never more than 8 waiting on the server; all answered in order.
    const answers = await new Promise<number[]>((resolve) => {
      const c = createConnection(sock);
      let buf = '';
      const ids: number[] = [];
      c.setEncoding('utf8');
      c.on('data', (d: string) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          ids.push((JSON.parse(buf.slice(0, nl)) as { id: number }).id);
          buf = buf.slice(nl + 1);
        }
        if (ids.length === 300) {
          c.end();
          resolve(ids);
        }
      });
      c.on('connect', () => {
        for (let i = 1; i <= 300; i++) c.write(JSON.stringify({ id: i, method: 'head', params: {} }) + '\n');
      });
    });
    assert.deepEqual(answers, Array.from({ length: 300 }, (_, i) => i + 1));
    assert.ok(maxPending <= 8, `${maxPending} requests waited`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    cleanup();
  }
});

test('r3 #23: a requirement-set version must carry its snapshot (types and validation)', async () => {
  const { svc, cleanup } = service();
  try {
    // @ts-expect-error: a requirement-set version without its snapshot does not type-check
    const missing: BaseRecord = { kind: 'basis.version', basisKind: 'requirement-set', line: id<BasisLineId>('rs'), version: id<BasisVersionId>('rs.v1'), mission: M, scope: null };
    await rejects(svc.appendRecords({ op: 'rs1', gen: null, records: [missing] }), 'RECORD_INVALID');
    const snapshot: ListRef = svc.content.putList(['req-a.v1']);
    await svc.appendRecords({ op: 'rs2', gen: null, records: [{ kind: 'basis.version', basisKind: 'requirement-set', line: id<BasisLineId>('rs'), version: id<BasisVersionId>('rs.v1'), mission: M, scope: null, snapshot }] });
  } finally {
    cleanup();
  }
});

test('seat result: transcriptIncomplete, toolLog and toolLogIncomplete are recorded, checked, and the tool log content is verified', async () => {
  const base = { kind: 'seat.result', launch: 'L', seat: 'constructor', status: 'handed-back', result: null, export: null, recoveryState: null, evidenceRequest: null } as const;
  const h = 'a'.repeat(64);
  validateRecord({ ...base, transcript: h, transcriptIncomplete: true, toolLog: h, toolLogIncomplete: true });
  validateRecord({ ...base, transcript: null, toolLog: null });
  assert.throws(() => validateRecord({ ...base, transcript: h, transcriptIncomplete: 'yes' }));
  assert.throws(() => validateRecord({ ...base, transcript: null, transcriptIncomplete: true }));
  assert.throws(() => validateRecord({ ...base, transcript: null, toolLogIncomplete: true }));
  assert.throws(() => validateRecord({ ...base, transcript: null, toolLog: 'not-a-hash' }));
  const { svc, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    await svc.registerLaunch({ op: 'l', gen, launch: id<LaunchId>('L'), tag: { mission: M, capabilities: [] } });
    const rec = { ...base, launch: id<LaunchId>('L'), transcript: svc.content.put('cut transcript'), transcriptIncomplete: true, toolLog: 'b'.repeat(64) as ContentHash, toolLogIncomplete: false } as BaseRecord;
    await rejects(svc.submitPendingResult({ op: 'p1', launch: id<LaunchId>('L'), records: [rec] }), 'CONTENT_MISSING');
    await svc.submitPendingResult({ op: 'p2', launch: id<LaunchId>('L'), records: [{ ...rec, toolLog: svc.content.put('tool log') } as BaseRecord] });
  } finally {
    cleanup();
  }
});

test('v48 stop entry wording (English) and layer 0: persisted (awaiting commit); not-persisted from the actual confirmations; committed once committed', async () => {
  const { svc, paths, cleanup } = service({ watchStops: false });
  const pids: number[] = [];
  try {
    const ok = stopEntry(paths, { stop: id<StopId>('S-OK'), scope: { kind: 'all' }, words: '停', at: Date.now() }, { bootId: 'boot-r3' });
    assert.deepEqual([ok.result, ok.message, ok.notice], ['persisted', STOP_PERSISTED_MESSAGE, null]);
    // The product text is English; the result kinds are unchanged.
    assert.equal(STOP_PERSISTED_MESSAGE, 'Fast notice sent; persisted (awaiting commit).');
    assert.equal(STOP_NOT_PERSISTED_NOTICE, 'Fast notice sent, but it could not be persisted (awaiting commit).');
    const slow = stopEntry(paths, { stop: id<StopId>('S-SLOW'), scope: { kind: 'all' }, words: '停', at: Date.now() }, { bootId: 'boot-r3', writerDelayMs: 4_000, timeoutMs: 300 });
    pids.push(...slow.writerPids);
    assert.deepEqual([slow.result, slow.notice], ['notified-not-persisted', STOP_NOT_PERSISTED_NOTICE]);
    const states = new Map(stopDeliveryStates(paths.controlPlane).map((x) => [x.stop, x.state]));
    assert.equal(states.get('S-OK'), 'persisted');
    assert.equal(states.get('S-SLOW'), 'not-persisted');
    await svc.drainStops();
    const after = new Map(stopDeliveryStates(paths.controlPlane).map((x) => [x.stop, x.state]));
    assert.deepEqual([after.get('S-OK'), after.get('S-SLOW')], ['committed', 'committed']);
  } finally {
    for (const p of pids) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    cleanup();
  }
});

test('entry checks: a continuation judgment needs a passing evaluator check at the latest published revision (r3 F1); otherwise a full review', async () => {
  const { svc, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    await svc.appendRecords({ op: 'base', gen, records: [plan(svc, 'A'), judge(svc, 'J0', 'A')] });
    const { epoch } = await svc.beginEvaluator({ gen, identity: IDENT });
    await svc.publish({ epoch, revision: svc.head(), batch: null });
    const cont = (j: string): BaseRecord => ({ ...(judge(svc, j, 'A') as object), extends: 'J0' } as BaseRecord);
    // No check: refused, a normal branch (no WI).
    await rejects(svc.appendRecords({ op: 'c0', gen, records: [cont('J1')] }), 'CONTINUATION_REFUSED', null);
    // A failing check: refused with the evaluator's reason.
    await svc.recordContinuationCheck({ op: 'k1', gen, judgment: id('J1'), extends: id('J0'), target: 'A', revision: svc.publicationFloor(), result: { ok: false, reason: 'not-current-outside-changes' } });
    await assert.rejects(svc.appendRecords({ op: 'c1', gen, records: [cont('J1')] }), /not-current-outside-changes/);
    // A passing check answered at an older revision: ask again.
    await svc.recordContinuationCheck({ op: 'k2', gen, judgment: id('J2'), extends: id('J0'), target: 'A', revision: svc.publicationFloor(), result: { ok: true, merged: { evidence: [], bases: [], constraints: [], reliesOn: [] } } });
    await svc.appendRecords({ op: 'unrelated', gen, records: [plan(svc, 'Z')] });
    await svc.publish({ epoch, revision: svc.head(), batch: null });
    await rejects(svc.appendRecords({ op: 'c2', gen, records: [cont('J2')] }), 'BELOW_FLOOR');
    await rejects(svc.recordContinuationCheck({ op: 'k3', gen, judgment: id('J2'), extends: id('J0'), target: 'A', revision: revision(1), result: { ok: true, merged: { evidence: [], bases: [], constraints: [], reliesOn: [] } } }), 'BELOW_FLOOR');
    await svc.recordContinuationCheck({ op: 'k4', gen, judgment: id('J2'), extends: id('J0'), target: 'A', revision: svc.publicationFloor(), result: { ok: true, merged: { evidence: [], bases: [], constraints: [], reliesOn: [] } } });
    await svc.appendRecords({ op: 'c3', gen, records: [cont('J2')] });
    await rejects(svc.recordContinuationCheck({ op: 'k5', gen, judgment: id('J2'), extends: id('J0'), target: 'A', revision: svc.publicationFloor(), result: { ok: true, merged: { evidence: [], bases: [], constraints: [], reliesOn: [] } } }), 'FACT_CONFLICT');
  } finally {
    cleanup();
  }
});

test('entry checks: a renewal is registered only when the renewal rule holds (r3 F14)', async () => {
  const { svc, cleanup } = service();
  try {
    const ev = (e: string, fields: Record<string, string>, runClass: 'closed' | 'open' = 'closed'): BaseRecord => ({ kind: 'evidence', evidence: e as never, envLine: 'py' as never, envSnapshot: 's' as never, runClass, fields });
    const J = (j: string, fields: string[]): BaseRecord => ({ ...(judge(svc, j, 'P') as object), evidenceUse: { fields, statisticalOrExternal: false } }) as unknown as BaseRecord;
    await svc.appendRecords({ op: 'base', gen: null, records: [plan(svc, 'P'), ev('E1', { exit: '0', 'time:ms': '10' }), ev('E2', { exit: '0', 'time:ms': '12' }), ev('E3', { exit: '1' }), ev('E4', { exit: '0' }, 'open'), J('J', ['exit']), J('JT', ['exit', 'time:ms'])] });
    const renew = (op: string, judgment: string, original: string, replacement: string) => svc.appendRecords({ op, gen: null, records: [{ kind: 'evidence.renewal', judgment: judgment as never, original: original as never, replacement: replacement as never }] });
    await renew('r1', 'J', 'E1', 'E2');
    await assert.rejects(renew('r2', 'J', 'E2', 'E3'), (e: unknown) => e instanceof LedgerError && e.code === 'RENEWAL_REFUSED' && e.wi === null && /field-differs/.test(e.message));
    await assert.rejects(renew('r3', 'JT', 'E1', 'E2'), /uses-timing/);
    await assert.rejects(renew('r4', 'J', 'E1', 'E4'), /not-closed/);
    await rejects(renew('r5', 'J', 'E1', 'NOPE'), 'RECORD_INVALID');
  } finally {
    cleanup();
  }
});

test('install state: an accepted degradation is recorded at install with its facts, auditable, the latest per item', async () => {
  const { svc, paths, cleanup } = service();
  try {
    await svc.recordInstallState({ op: 'i1', item: 'resource-limits', value: 'heap-only', accepted: true, by: 'user', detail: svc.content.put('no cgroup delegation; the user accepted (WI-18)') });
    await svc.recordInstallState({ op: 'i2', item: 'resource-limits', value: 'cgroup', accepted: false, by: 'installer', detail: svc.content.put('cgroup delegation available again') });
    assert.deepEqual(
      svc.installStates().map((x) => [x.item, x.value, x.accepted, x.by]),
      [['resource-limits', 'cgroup', false, 'installer']],
    );
    assert.equal(readRecords(paths.db, revision(0)).filter((c) => c.record.kind === 'install.state').length, 2);
    await rejects(svc.recordInstallState({ op: 'i3', item: 'x', value: 'y', accepted: true, by: 'user', detail: 'c'.repeat(64) as ContentHash }), 'CONTENT_MISSING');
  } finally {
    cleanup();
  }
});

test('episode notices carry plain trigger and default-action text (no WI: a normal branch)', async () => {
  const { svc, cleanup } = service();
  try {
    const body = svc.content.put('{"change":"start"}');
    await svc.appendRecords({ op: 'n1', gen: null, records: [{ kind: 'notice', notice: 'eb-1:D', audience: 'pm', body, trigger: 'delivery D is no longer all proven at revision 9', defaultAction: 'nothing is undone; the PM is told' }] });
    await rejects(svc.appendRecords({ op: 'n2', gen: null, records: [{ kind: 'notice', notice: 'eb-1:E', audience: 'pm', body, trigger: '' }] }), 'RECORD_INVALID');
  } finally {
    cleanup();
  }
});

test('r3 #1 at entry: a continuation judgment must carry exactly the inputs the evaluator merged (renewals applied), as sets', async () => {
  const { svc, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    const ev = (e: string): BaseRecord => ({ kind: 'evidence', evidence: e as never, envLine: 'py' as never, envSnapshot: 's' as never, runClass: 'closed', fields: { exit: '0' } });
    const J = (j: string, target: string, evidence: string[], ext: string | null): BaseRecord =>
      ({ ...(judge(svc, j, target) as object), evidence: svc.content.putList(evidence), extends: ext }) as unknown as BaseRecord;
    await svc.appendRecords({ op: 'base', gen, records: [ev('E1'), ev('E2'), plan(svc, 'A'), J('J0', 'A', ['E1'], null), plan(svc, 'B', { predecessor: 'A' })] });
    // J0's E1 was renewed to E2: the evaluator merges E2, not E1 (the reviewer's first repro).
    await svc.appendRecords({ op: 'renew', gen, records: [{ kind: 'evidence.renewal', judgment: 'J0' as never, original: 'E1' as never, replacement: 'E2' as never }] });
    const { epoch } = await svc.beginEvaluator({ gen, identity: IDENT });
    await svc.publish({ epoch, revision: svc.head(), batch: null });
    const merged = { evidence: ['E2'], bases: [], constraints: [], reliesOn: [] };
    await rejects(svc.recordContinuationCheck({ op: 'k0', gen, judgment: id('J1'), extends: id('J0'), target: 'B', revision: svc.publicationFloor(), result: { ok: true } }), 'BAD_REQUEST');
    await svc.recordContinuationCheck({ op: 'k1', gen, judgment: id('J1'), extends: id('J0'), target: 'B', revision: svc.publicationFloor(), result: { ok: true, merged } });
    // Carrying the original E1 only: refused, a full review instead.
    await assert.rejects(svc.appendRecords({ op: 'j1-old', gen, records: [J('J1', 'B', ['E1'], 'J0')] }), (e: unknown) => e instanceof LedgerError && e.code === 'CONTINUATION_REFUSED' && /merged/.test(e.message));
    // Carrying the merged inputs (order and repeats do not matter): committed.
    const r = await svc.appendRecords({ op: 'j1', gen, records: [J('J1', 'B', ['E2', 'E2'], 'J0')] });
    assert.equal(r.revisions.length, 1);
  } finally {
    cleanup();
  }
});
