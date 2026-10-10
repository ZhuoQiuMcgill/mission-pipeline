// The task queue in the ledger (design 4.1, 6.5): queueTask when a task enters, dequeueTask
// when it is dispatched; a restarted scheduler rebuilds its queue from the ledger and picks
// up tasks an earlier generation dispatched; only the current generation changes the queue.
// A Secretary task runs in the lineage it handles (6.5).

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { id, type MissionId, type StopId } from '../src/common/ids.ts';
import { cleanupEnvs, hostTask, inProcessLedger, makeEnv, newScheduler, touch, unitSkip, waitFor } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

describe('the task queue in the ledger (4.1)', { skip: unitSkip, timeout: 180_000 }, () => {
  test('a scheduler restart keeps the queued tasks; dispatched tasks leave the queue; an old generation cannot change it', async () => {
    const e = makeEnv('queue');
    const l = inProcessLedger(e);
    const held = id<MissionId>('m-held');
    const s1 = newScheduler(e);
    const s2 = newScheduler(e);
    try {
      const g1 = await s1.start();
      await l.svc.stop({ stop: id<StopId>('hold'), scope: { kind: 'mission', mission: held }, words: '先停', at: Date.now() });
      const a = await s1.submitDurable(hostTask(e, { task: 'a', mission: held }));
      await s1.submitDurable(hostTask(e, { task: 'b', mission: held, dependsOn: ['a'] }));
      const c = await s1.submitDurable(hostTask(e, { task: 'c' }));
      await waitFor(() => c.state === 'done', 30_000, 'c done');
      assert.equal(a.state, 'queued');
      assert.deepEqual(l.svc.taskQueue().map((q) => q.task), ['a', 'b'], 'the ledger queue holds the waiting tasks');
      const ci = l.svc.taskInfo('c');
      assert.equal(ci?.state, 'dispatched');
      assert.equal(ci?.launch, c.launches[0]);
      s1.abandon(); // the scheduler crashes
      const g2 = await s2.start();
      assert.deepEqual(
        s2.tasks
          .all()
          .filter((t) => t.state === 'queued')
          .map((t) => [t.spec.task, t.state, t.persisted]),
        [
          ['a', 'queued', true],
          ['b', 'queued', true],
        ],
        'rebuilt from the ledger',
      );
      // a task it ran is known too (the flows resubmit a task whose status is unknown)
      assert.equal(s2.tasks.get('c')?.state, 'done');
      // the old generation cannot touch the queue any more
      await assert.rejects(l.svc.queueTask({ op: 'old-gen', gen: g1, task: 'z', lineage: 'L-z', mission: held, card: s2.content.put('x') }), /STALE_GENERATION/);
      await l.svc.releaseStop(id<StopId>('hold'));
      await waitFor(() => s2.tasks.get('b')?.state === 'done', 40_000, 'a, then b, run under the new generation');
      assert.deepEqual(l.svc.taskQueue(), []);
      assert.ok(g2 > g1);
    } finally {
      await s2.close();
      await l.close();
    }
  });

  test('a task an earlier generation dispatched is picked up from its card: its failure is retried by the new generation', async () => {
    const e = makeEnv('queuecarry');
    const l = inProcessLedger(e);
    const go = join(e.root, 'go');
    const s1 = newScheduler(e);
    const s2 = newScheduler(e);
    try {
      await s1.start();
      const spec = hostTask(e, { task: 'flaky', job: { goFile: go, seat: true, seatStatus: 'handed-back', exitCode: 3 } });
      const t1 = await s1.submitDurable(spec);
      const first = await waitFor(() => t1.launches[0], 20_000, 'dispatched');
      await waitFor(() => s1.cp.readHostHeartbeat(first), 15_000, 'running');
      s1.abandon();
      // the next attempt's host will exit 0 (the running one already read exit code 3)
      writeFileSync(join(e.jobs, 'flaky.json'), JSON.stringify({ controlPlane: e.cp, ledgerSocket: e.socket, goFile: go, seat: true, seatStatus: 'handed-back', exitCode: 0 }));
      await s2.start();
      touch(go);
      await waitFor(() => s2.tasks.get('flaky')?.state === 'done', 40_000, 'retried and done under the new generation');
      const t2 = s2.tasks.get('flaky')!;
      assert.equal(t2.launches.length, 2);
      assert.equal(t2.launches[0], first);
      assert.equal(l.svc.dispositionFor(first), 'failed');
      assert.equal(l.svc.loopState('lineage-flaky', 'env-retry').attempts, 1);
    } finally {
      await s2.close();
      await l.close();
    }
  });

  test('a Secretary task runs in the lineage it handles: its attempts count there (6.5); an exhausted task survives a restart', async () => {
    const e = makeEnv('secretary');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    const s2 = newScheduler(e);
    try {
      await s.start();
      const t = await s.submitDurable({ ...hostTask(e, { task: 'secretary-1', lineage: 'L-secretary-own', job: { exitCode: 3 } }), secretaryFor: { lineage: 'L-handled' } });
      assert.equal(t.spec.lineage, 'L-handled');
      assert.equal(l.svc.taskInfo('secretary-1')?.lineage, 'L-handled', 'queued in the ledger under the handled lineage');
      await waitFor(() => t.state === 'exhausted', 40_000, 'its failures exhaust the handled lineage');
      assert.equal(l.svc.loopState('L-handled', 'env-retry').attempts, 2);
      assert.equal(l.svc.loopState('L-secretary-own', 'env-retry').attempts, 0);
      // a restarted scheduler rebuilds the exhausted task from the ledger (dispatchedTasks), counting nothing twice
      s.abandon();
      await s2.start();
      assert.equal(s2.tasks.get('secretary-1')?.state, 'exhausted');
      assert.equal(l.svc.loopState('L-handled', 'env-retry').attempts, 2);
    } finally {
      await s2.close();
      await l.close();
    }
  });
});
