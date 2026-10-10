// Design 6.4, from the e2e run with real units: a unit ended BECAUSE a stop covers it is stopped,
// not an environment failure. Its supervisor (stop watcher) records the cause before the proof
// (exec/stopcause.ts); the takeover classifies the attempt as cancelled, whether the stop is still
// in force or was released before the classification; nothing counts toward env-retry and no
// WI-15 notice is raised. A SIGTERM with no covering stop stays an environment failure.
// Real units through the scheduler (test/scheduler-fixtures.ts).

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { id, type LaunchId, type StopId } from '../src/common/ids.ts';
import { endedByStopPath, readEndedByStop, recordEndedByStop } from '../src/exec/stopcause.ts';
import { stopUnit } from '../src/exec/supervisor.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { sendStop } from '../src/ledger/stops.ts';
import { unitNameOf } from '../src/scheduler/units.ts';
import { cleanupEnvs, hostTask, inProcessLedger, M, makeEnv, newScheduler, unitSkip, waitFor, type Env } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

const stopPaths = (e: Env): { inbox: string; controlPlane: string } => {
  const p = ledgerPaths(e.ledgerRoot, e.cp);
  return { inbox: p.inbox, controlPlane: p.controlPlane };
};

describe('the stop cause record', () => {
  test('written once, durably; read back only when it is a record of this launch', () => {
    const d = mkdtempSync(join(tmpdir(), 'mp-exec-stopcause-'));
    try {
      const L = id<LaunchId>('launch-stopcause-1');
      assert.equal(readEndedByStop(d, L), null);
      assert.ok(recordEndedByStop(d, L, { by: 'supervisor', via: 'spool', stops: ['stop-1'], detail: 'first' }));
      assert.ok(recordEndedByStop(d, L, { by: 'host', via: 'spool', stops: ['stop-2'], detail: 'second' }));
      const r = readEndedByStop(d, L);
      assert.deepEqual([r?.by, r?.stops, r?.detail], ['supervisor', ['stop-1'], 'first'], 'the first cause stays');
      assert.ok(existsSync(endedByStopPath(d, L)));
      assert.equal(readEndedByStop(d, id<LaunchId>('launch-stopcause-2')), null);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('a unit ended by a stop is stopped, not an environment failure (6.4)', { skip: unitSkip, timeout: 180_000 }, () => {
  const noWi15 = (s: ReturnType<typeof newScheduler>, launch: LaunchId): void => {
    const notices = s.cp.alerts().filter((a) => a.key === launch && (a.category === 'attempt-failed' || a.category === 'attempt-quarantined'));
    assert.deepEqual(notices, [], 'no WI-15 notice for a stopped unit');
  };

  test('the stop in force: cancelled; no env-retry, no WI-15; the cause is recorded with the stop id', async () => {
    const e = makeEnv('stopped');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start();
      const t = s.submit(hostTask(e, { task: 'held', lineage: 'L-held', job: { goFile: join(e.root, 'never') } }));
      await waitFor(() => t.state === 'running' && t.current !== null, 30_000, 'running');
      const launch = t.current as LaunchId;
      const S = id<StopId>('stop-ebs-1');
      sendStop(stopPaths(e), { stop: S, scope: { kind: 'mission', mission: M }, words: 'stop', at: Date.now() });
      await waitFor(() => l.svc.dispositionFor(launch), 40_000, 'decided').catch((err: Error) => {
        throw new Error(`${err.message}: task ${t.state} (${t.note}); stop ${l.svc.stopState(S)}; cause ${JSON.stringify(readEndedByStop(e.stateDir, launch))}`);
      });
      await waitFor(() => t.state === 'needs-disposition', 10_000, 'needs disposition').catch((err: Error) => {
        throw new Error(`${err.message}: task ${t.state} (${t.note}); disposition ${l.svc.dispositionFor(launch)}; outcomes ${JSON.stringify(s.outcomes.filter((o) => o.launch === launch))}; cause ${JSON.stringify(readEndedByStop(e.stateDir, launch))}`);
      });
      assert.equal(t.disposition, 'stop');
      assert.equal(l.svc.dispositionFor(launch), 'cancelled');
      assert.deepEqual(l.svc.loopState('L-held', 'env-retry').byClass, {}, 'nothing counted toward env-retry');
      noWi15(s, launch);
      const cause = readEndedByStop(e.stateDir, launch);
      assert.ok(cause !== null);
      // whoever got there first: the unit's own watcher (spool) or the scheduler's stop executor (committed stop)
      assert.ok(cause.by === 'supervisor' || cause.by === 'scheduler', cause.by);
      assert.deepEqual(cause.stops, [S]);
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('the stop released before the attempt is classified: still stopped (cancelled), not an environment failure', async () => {
    const e = makeEnv('released');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start({ startLoops: false });
      const t = s.submit(hostTask(e, { task: 'held', lineage: 'L-rel', job: { goFile: join(e.root, 'never') } }));
      await waitFor(async () => {
        await s.tick();
        return t.state === 'running' && t.current !== null;
      }, 30_000, 'running');
      const launch = t.current as LaunchId;
      const S = id<StopId>('stop-ebs-2');
      sendStop(stopPaths(e), { stop: S, scope: { kind: 'mission', mission: M }, words: 'stop', at: Date.now() });
      // the unit's own watcher ends it from the spool; its proof reaches the ledger without the scheduler
      await waitFor(() => l.svc.proofFor(launch), 30_000, 'the proof');
      await waitFor(async () => {
        await s.tick();
        return l.svc.stopState(S) === 'active' || t.state !== 'running';
      }, 10_000, 'the stop committed (or the attempt decided)');
      if (l.svc.stopState(S) === 'active') await l.svc.releaseStop(S);
      await waitFor(async () => {
        await s.tick();
        return t.state !== 'running';
      }, 30_000, 'decided');
      assert.equal(l.svc.dispositionFor(launch), 'cancelled');
      assert.deepEqual(l.svc.loopState('L-rel', 'env-retry').byClass, {}, 'a released stop burns no env-retry');
      assert.equal(t.launches.length, 1, 'not redispatched as an environment failure');
      noWi15(s, launch);
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('an unrelated SIGTERM (no covering stop) stays an environment failure', async () => {
    const e = makeEnv('sigterm');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start();
      const t = s.submit(hostTask(e, { task: 'held', lineage: 'L-term', job: { goFile: join(e.root, 'never') } }));
      await waitFor(() => t.state === 'running' && t.current !== null, 30_000, 'running');
      const launch = t.current as LaunchId;
      await stopUnit(unitNameOf(launch), 60_000);
      await waitFor(() => l.svc.dispositionFor(launch), 40_000, 'decided');
      assert.equal(l.svc.dispositionFor(launch), 'failed');
      assert.equal(readEndedByStop(e.stateDir, launch), null, 'no stop cause recorded');
      await waitFor(() => l.svc.loopState('L-term', 'env-retry').attempts === 1, 10_000, 'counted as an environment failure').catch((err: Error) => {
        throw new Error(`${err.message}: ${JSON.stringify(l.svc.loopState('L-term', 'env-retry'))}; task ${t.state} (${t.note})`);
      });
      const notice = s.cp.alerts().find((a) => a.category === 'attempt-failed' && a.key === launch);
      assert.equal(notice?.wi, 'WI-15');
    } finally {
      await s.close();
      await l.close();
    }
  });
});
