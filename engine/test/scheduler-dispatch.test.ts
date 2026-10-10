// Scheduler dispatch and acceptance (design 6.2, 6.3 rule 2, 6.5, 7.1) against a real ledger
// service and real units (transient systemd user services with their supervisors).

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { join } from 'node:path';
import { readRecords } from '../src/ledger/store.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { readLaunchMeta } from '../src/scheduler/launches.ts';
import type { MachineProbe } from '../src/scheduler/admission.ts';
import { cleanupEnvs, hostTask, inProcessLedger, makeEnv, newScheduler, readJson, touch, unitSkip, waitFor, M } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

describe('dispatch and acceptance', { skip: unitSkip, timeout: 180_000 }, () => {
  test('a unit runs, hands back, its proof is accepted, its cleanup is done (6.2, 7.1)', async () => {
    const e = makeEnv('dispatch');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start();
      const t = s.submit(hostTask(e, { task: 't1', job: { seat: true, seatStatus: 'handed-back' } }));
      await waitFor(() => t.state === 'done', 30_000, 'task done');
      const launch = t.launches[0]!;
      assert.equal(l.svc.dispositionFor(launch), 'accepted');
      assert.ok(l.svc.proofFor(launch), 'the supervisor registered the proof');
      await waitFor(() => l.svc.cleanupState(launch) === 'done', 20_000, 'cleanup done');
      const kinds = readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, 0 as never).map((c) => c.record.kind);
      assert.ok(kinds.includes('seat.result') && kinds.includes('claude-code.exit'), 'the pending results became base records');
      assert.equal(readLaunchMeta(e.stateDir, launch)?.task, 't1');
      // kept until the cleanup is done (stop reports and the watchdog read it, review r1 #3), then removed
      await waitFor(() => s.cp.host(launch) === null, 10_000, 'the host manifest entry is removed once cleaned up');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('a host exiting non-zero: environment failure, quarantined, retried within the env-retry cap (6.5)', async () => {
    const e = makeEnv('envfail');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start();
      const t = s.submit(hostTask(e, { task: 'bad', job: { seat: true, exitCode: 3 } }));
      // same failure twice in a row: no progress, exhausted after 2 attempts
      await waitFor(() => t.state === 'exhausted', 60_000, 'exhausted');
      assert.equal(t.launches.length, 2);
      for (const launch of t.launches) assert.equal(l.svc.dispositionFor(launch), 'failed');
      const ls = l.svc.loopState('lineage-bad', 'env-retry');
      assert.equal(ls.attempts, 2);
      assert.equal(ls.repeats, 1);
      assert.match(t.note ?? '', /no-progress/);
      // quarantined: the pending results never became base records
      const kinds = readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, 0 as never).map((c) => c.record.kind);
      assert.ok(!kinds.includes('claude-code.exit'));
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('scheduling dependencies and priority order the queue; machine admission makes the second unit wait (6.5)', async () => {
    const e = makeEnv('order');
    const l = inProcessLedger(e);
    // a machine with room for exactly one 64 MiB unit
    const probe: MachineProbe = {
      read: () => ({ memTotalBytes: 1 << 30, memAvailableBytes: 100 * 1024 * 1024, cpus: 4, disks: [{ path: '/', totalBytes: 1 << 30, freeBytes: 1 << 29, totalInodes: 1e6, freeInodes: 1e6, blockBytes: 4096 }] }),
      unitMemory: () => 0,
    };
    const s = newScheduler(e, {}, { probe });
    try {
      await s.start();
      const go = join(e.root, 'go');
      const a = s.submit(hostTask(e, { task: 'a', priority: 1, job: { goFile: go } }));
      const b = s.submit(hostTask(e, { task: 'b', priority: 5, job: { goFile: go } }));
      const c = s.submit(hostTask(e, { task: 'c', priority: 9, dependsOn: ['a'] }));
      await waitFor(() => b.state === 'running', 20_000, 'b running first (higher priority)');
      await s.tick();
      assert.equal(a.state, 'queued', 'a waits: the machine has room for one unit only');
      assert.ok(s.waitingReasons().some((w) => w.task === 'a' && /waiting for resources/.test(w.reason)));
      assert.equal(c.state, 'queued', 'c depends on a');
      touch(go);
      await waitFor(() => b.state === 'done', 30_000, 'b done');
      await waitFor(() => a.state === 'done', 30_000, 'a done');
      await waitFor(() => c.state === 'done', 30_000, 'c done after a');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('async waits hold no reservation (6.2): a seat that asks for evidence releases its reservation; the next unit is admitted', async () => {
    const e = makeEnv('asyncwait');
    const l = inProcessLedger(e);
    // a machine with room for exactly one 64 MiB unit
    const probe: MachineProbe = {
      read: () => ({ memTotalBytes: 1 << 30, memAvailableBytes: 100 * 1024 * 1024, cpus: 4, disks: [{ path: '/', totalBytes: 1 << 30, freeBytes: 1 << 29, totalInodes: 1e6, freeInodes: 1e6, blockBytes: 4096 }] }),
      unitMemory: () => 0,
    };
    const s = newScheduler(e, {}, { probe });
    try {
      await s.start();
      const a = s.submit(hostTask(e, { task: 'explore', priority: 9, job: { seat: true, seatStatus: 'needs-evidence' } }));
      const b = s.submit(hostTask(e, { task: 'evidence-run', priority: 1, job: {} }));
      await waitFor(() => a.state === 'waiting-evidence', 30_000, 'waiting for evidence');
      await waitFor(() => b.state === 'done', 30_000, 'the evidence unit was admitted while the seat waits');
      assert.ok(!s.reservedLaunches().includes(a.launches[0]!), 'the waiting seat holds no reservation');
      assert.equal(await s.resumeAfterEvidence('explore', 'evidence results'), true);
      await waitFor(() => a.state === 'waiting-evidence' && a.launches.length === 2, 30_000, 'continued after the evidence');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('a host whose heartbeat stops is ended (rule 5): its supervisor still proves it; an environment failure, retried', async () => {
    const e = makeEnv('hblost');
    const l = inProcessLedger(e);
    const s = newScheduler(e, { takeover: { proofPendingLimitMs: 4_000, heartbeatTimeoutMs: 1_500, startGraceMs: 10_000, proofGraceMs: 3_000, killWaitMs: 5_000 } });
    const go = join(e.root, 'go');
    try {
      await s.start();
      const t = s.submit(hostTask(e, { task: 'hb', job: { goFile: go, seat: true, seatStatus: 'handed-back', pidDir: join(e.root, 'pids') } }));
      const launch = await waitFor(() => t.launches[0], 20_000, 'launched');
      const pidInfo = await waitFor(() => readJson<{ pid: number }>(join(e.root, 'pids', `${launch}.pid`)), 15_000, 'host pid');
      process.kill(pidInfo.pid, 'SIGSTOP'); // alive, but no more heartbeats
      await waitFor(() => l.svc.dispositionFor(launch), 30_000, 'decided');
      assert.equal(l.svc.dispositionFor(launch), 'failed');
      assert.deepEqual(l.svc.proofFor(launch)?.exit, { code: null, signal: 'SIGKILL' }, 'the supervisor proved the end');
      const failed = s.outcomes.find((o) => o.launch === launch);
      assert.equal(failed?.kind === 'failed' && failed.failure, 'heartbeat-lost');
      touch(go);
      await waitFor(() => t.state === 'done', 30_000, 'retried and done');
      assert.equal(t.launches.length, 2);
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('a stopped mission: nothing in its scope is dispatched (6.4)', async () => {
    const e = makeEnv('heldbystop');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start();
      await l.svc.stop({ stop: 'stop-held' as never, scope: { kind: 'mission', mission: M }, words: '停', at: Date.now() });
      const t = s.submit(hostTask(e, { task: 'held' }));
      await s.tick();
      await s.tick();
      assert.equal(t.state, 'queued');
      assert.equal(t.launches.length, 0);
      assert.match(t.note ?? '', /stop/);
    } finally {
      await s.close();
      await l.close();
    }
  });
});
