// v42 WI-15: what happens after a failed attempt depends on its cause (6.2 table, 6.5, 7.1).
//   environment failure  -> redispatched automatically, env-retry (per class)
//   resource overflow    -> NOT redispatched; "needs disposition"; env-retry, resource class
//   seat failure         -> "needs disposition"; a Secretary restart counts toward
//                           "restarts after quarantine or seat failure" (2 in total)
//   quarantined by a stop -> never restarted (checked in v14-03)
// Real units; the overflow is a real memory.max kill of the unit.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { cleanupEnvs, hostTask, inProcessLedger, makeEnv, newScheduler, unitSkip, waitFor } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

describe('dispositions by cause (v42 WI-15)', { skip: unitSkip, timeout: 180_000 }, () => {
  test('resource overflow (the unit\'s own limit fired): no automatic redispatch; needs disposition; counted in the resource class', async () => {
    const e = makeEnv('overflow');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start();
      const spec = hostTask(e, { task: 'big', lineage: 'L-big' });
      const t = s.submit({
        ...spec,
        unit: { ...spec.unit, host: { ...spec.unit.host, argv: ['/bin/sh', '-c', 'python3 -c "b=bytearray(200*1024*1024)"'] }, limits: { memoryMax: 64 * 1024 * 1024, pidsMax: 64 }, heartbeat: false, seatUnit: false },
      });
      await waitFor(() => t.state === 'needs-disposition', 40_000, 'needs disposition');
      assert.equal(t.launches.length, 1, 'not redispatched');
      assert.equal(t.disposition, 'resource-exceeded');
      const proof = l.svc.proofFor(t.launches[0]!);
      assert.ok(proof && proof.unitOom > 0, 'the unit\'s own limit fired');
      assert.equal(l.svc.dispositionFor(t.launches[0]!), 'failed');
      assert.deepEqual(l.svc.loopState('L-big', 'env-retry').byClass, { 'resource-exceeded': 1 });
      const notice = s.cp.alerts().find((a) => a.category === 'attempt-failed' && a.key === t.launches[0]);
      assert.equal(notice?.wi, 'WI-15');
      assert.match(notice?.defaultAction ?? '', /not redispatched/);
      assert.equal(await s.restartQuarantined('big', 'restart'), null, 'restarted only with a changed declaration');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('seat failure: needs disposition; Secretary restarts count toward the shared cap of 2, then WI-08', async () => {
    const e = makeEnv('seatfail');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start();
      const t = s.submit(hostTask(e, { task: 'sf', lineage: 'L-sf', job: { seat: true, seatStatus: 'seat-failure' } }));
      for (let round = 1; round <= 2; round++) {
        await waitFor(() => t.state === 'needs-disposition' && t.launches.length === round, 30_000, `seat failure ${round}`);
        assert.equal(t.disposition, 'seat-failure');
        assert.equal(l.svc.dispositionFor(t.launches[round - 1]!), 'accepted', 'the attempt\'s facts are accepted; the seat failed');
        const v = await s.restartQuarantined('sf', `seat-failure-${round}`);
        assert.equal(v?.exhausted, round >= 2);
        assert.equal(t.state, 'queued');
      }
      await waitFor(() => t.state === 'needs-disposition' && t.launches.length === 3, 30_000, 'seat failure 3');
      const v = await s.restartQuarantined('sf', 'seat-failure-3');
      assert.equal(v?.exhausted, true);
      assert.equal(t.state, 'exhausted', 'a third restart is beyond the cap');
      assert.equal(l.svc.loopState('L-sf', 'quarantine-restart').attempts, 2);
      assert.equal(l.svc.loopState('L-sf', 'env-retry').attempts, 0, 'seat failures are not environment retries');
      assert.ok(s.cp.alerts().some((a) => a.wi === 'WI-08' && a.category.startsWith('loop-exhausted')));
    } finally {
      await s.close();
      await l.close();
    }
  });
});
