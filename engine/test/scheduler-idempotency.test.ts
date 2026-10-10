// §14 item 6 where it touches the scheduler: a write committed by the ledger whose answer is
// lost is sent again with the same operation id and gets the original result (6.1 "业务身份与
// 传输身份"): one launch, not two; one loop attempt, not two. A proxy between the scheduler
// and the ledger service drops chosen answers.

import assert from 'node:assert/strict';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { ledgerPaths } from '../src/ledger/service.ts';
import { readRecords } from '../src/ledger/store.ts';
import { LoopGuard } from '../src/scheduler/loops.ts';
import { evaluatorFailureRecorder } from '../src/scheduler/notices.ts';
import { Alerts } from '../src/scheduler/alerts.ts';
import { ControlPlane } from '../src/scheduler/controlPlane.ts';
import { SchedulerLedger } from '../src/scheduler/ledger.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { cleanupEnvs, hostTask, inProcessLedger, makeEnv, newScheduler, unitSkip, waitFor, type Env } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

/** Forwards JSON-line requests to the ledger; drops the answer to the first request of each listed method. */
function droppingProxy(listen: string, target: string, drop: Set<string>): { server: Server; dropped: string[] } {
  const dropped: string[] = [];
  const server = createServer((client: Socket) => {
    const upstream = createConnection(target);
    const methods = new Map<unknown, string>();
    let inBuf = '';
    let outBuf = '';
    client.setEncoding('utf8');
    upstream.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      inBuf += chunk;
      let nl: number;
      while ((nl = inBuf.indexOf('\n')) !== -1) {
        const line = inBuf.slice(0, nl);
        inBuf = inBuf.slice(nl + 1);
        try {
          const req = JSON.parse(line) as { id: unknown; method: string };
          methods.set(req.id, req.method);
        } catch {
          /* forwarded as is */
        }
        upstream.write(`${line}\n`);
      }
    });
    upstream.on('data', (chunk: string) => {
      outBuf += chunk;
      let nl: number;
      while ((nl = outBuf.indexOf('\n')) !== -1) {
        const line = outBuf.slice(0, nl);
        outBuf = outBuf.slice(nl + 1);
        const id = (JSON.parse(line) as { id: unknown }).id;
        const m = methods.get(id) ?? '';
        if (drop.has(m)) {
          drop.delete(m);
          dropped.push(m);
          continue; // committed by the ledger, the answer never arrives
        }
        client.write(`${line}\n`);
      }
    });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  server.listen(listen);
  return { server, dropped };
}

function kinds(e: Env): string[] {
  return readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, 0 as never).map((c) => c.record.kind);
}

describe('§14 item 6: a lost answer, then the same operation again', { skip: unitSkip, timeout: 120_000 }, () => {
  test('registerLaunch committed, its answer lost: the retry with the same op and launch id returns the original result; one launch, one unit', async () => {
    const e = makeEnv('lostanswer');
    const l = inProcessLedger(e);
    const proxySock = join(e.root, 'proxy.sock');
    const proxy = droppingProxy(proxySock, e.socket, new Set(['registerLaunch']));
    const s = newScheduler(e, { ledgerSocket: proxySock, ledgerTimeoutMs: 1_500 });
    try {
      await s.start();
      const t = s.submit(hostTask(e, { task: 't', job: { seat: true, seatStatus: 'handed-back' } }));
      await waitFor(() => t.state === 'done', 40_000, 'done');
      assert.deepEqual(proxy.dropped, ['registerLaunch']);
      assert.equal(t.launches.length, 1);
      assert.equal(kinds(e).filter((k) => k === 'launch.registered').length, 1, 'registered once');
      assert.equal(l.svc.dispositionFor(t.launches[0]!), 'accepted');
    } finally {
      await s.close();
      await new Promise<void>((r) => proxy.server.close(() => r()));
      await l.close();
    }
  });

  test('a loop attempt committed, its answer lost: retried with the same op, counted once', async () => {
    const e = makeEnv('lostattempt');
    const l = inProcessLedger(e);
    const proxySock = join(e.root, 'proxy.sock');
    const proxy = droppingProxy(proxySock, e.socket, new Set(['appendRecords']));
    const ledger = SchedulerLedger.connect(proxySock, 1_000);
    const content = new ContentStore(join(e.ledgerRoot, 'content'));
    const cp = new ControlPlane(e.cp);
    const loops = new LoopGuard({ ledger, content, alerts: new Alerts({ ledger, content, controlPlane: cp, source: 'test' }) });
    try {
      const req = { op: 'loop-attempt:env-retry:L1', gen: null, lineage: 'lin', loop: 'env-retry' as const, failureClass: 'no-proof', signature: 'no-proof' };
      await assert.rejects(loops.attempt(req), /timed out/);
      const v = await loops.attempt(req);
      assert.equal(v.attempts, 1, 'the retry returned the original commit');
      assert.equal(l.svc.loopState('lin', 'env-retry').attempts, 1);
      assert.deepEqual(proxy.dropped, ['appendRecords']);
    } finally {
      ledger.close();
      await new Promise<void>((r) => proxy.server.close(() => r()));
      await l.close();
    }
  });

  test('an evaluator failure whose answer was lost is recorded once: one op id per failure', async () => {
    const e = makeEnv('evalfail');
    const l = inProcessLedger(e);
    const proxySock = join(e.root, 'proxy.sock');
    const proxy = droppingProxy(proxySock, e.socket, new Set(['recordEvaluatorFailure']));
    const ledger = SchedulerLedger.connect(proxySock, 1_000);
    const record = evaluatorFailureRecorder(ledger);
    try {
      const gen = await l.svc.beginGeneration();
      // the supervisor names each failure and retries it until it is recorded
      await assert.rejects(record({ op: 'evaluator-failure:1', gen }), /timed out/);
      assert.equal(await record({ op: 'evaluator-failure:1', gen }), 1, 'the retry returned the original count');
      assert.equal(await record({ op: 'evaluator-failure:2', gen }), 2, 'the next failure is a new one');
      assert.equal(l.svc.evaluatorHealth().failures, 2);
      assert.deepEqual(proxy.dropped, ['recordEvaluatorFailure']);
      // a superseded supervisor cannot change the budget (r3 #7)
      await l.svc.beginGeneration();
      await assert.rejects(record({ op: 'evaluator-failure:3', gen }), /STALE_GENERATION/);
      assert.equal(l.svc.evaluatorHealth().failures, 2);
    } finally {
      ledger.close();
      await new Promise<void>((r) => proxy.server.close(() => r()));
      await l.close();
    }
  });
});
