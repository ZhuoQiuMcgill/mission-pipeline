// §14 item 10: exhaustion and budget block (design 6.5; WI-08, WI-09 of 3.11). The Secretary can
// grant extra attempts only once per lineage; a budget too small to start anything with
// nothing in flight puts the mission in budget block with a snapshot, a risk list and a notice.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { id, type LaunchId, type MissionId, type ReservationId } from '../src/common/ids.ts';
import type { MissionBlockRecord } from '../src/common/records.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { readRecords } from '../src/ledger/store.ts';
import { cleanupEnvs, hostTask, inProcessLedger, makeEnv, newScheduler, touch, unitSkip, waitFor, type Env } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

function blocks(e: Env): MissionBlockRecord[] {
  return readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, 0 as never)
    .filter((c) => c.record.kind === 'mission.block')
    .map((c) => c.record as MissionBlockRecord);
}

describe('§14 item 10: the Secretary grants only once per lineage', { skip: unitSkip, timeout: 180_000 }, () => {
  test('exhausted by no progress; one Secretary grant (+2 at most) re-opens only that lineage; a second is refused with a WI-08 notice for the user; the user can still grant', async () => {
    const e = makeEnv('grant');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start();
      const bad = s.submit(hostTask(e, { task: 'bad', lineage: 'L-bad', job: { seat: true, exitCode: 3 } }));
      const good = s.submit(hostTask(e, { task: 'good', lineage: 'L-good', job: { seat: true, seatStatus: 'handed-back', goFile: join(e.root, 'go') } }));
      await waitFor(() => bad.state === 'exhausted', 60_000, 'exhausted');
      assert.equal(bad.launches.length, 2, 'the same failure twice in a row: no progress');
      const exhaustedNotice = s.cp.alerts().find((a) => a.category === 'loop-exhausted');
      assert.equal(exhaustedNotice?.wi, 'WI-08');
      assert.match(exhaustedNotice?.defaultAction ?? '', /only lineage L-bad/);
      assert.equal(good.state, 'running', 'the rest of the mission continues (WI-08)');

      assert.deepEqual(await s.grant({ op: 'g-too-many', lineage: 'L-bad', loop: 'env-retry', by: 'secretary', extra: 3, reason: 'more' }), { granted: false, why: 'too-many' });
      assert.deepEqual(await s.grant({ op: 'g1', lineage: 'L-bad', loop: 'env-retry', by: 'secretary', extra: 2, reason: 'flaky machine, try again' }), { granted: true });
      assert.equal(bad.state, 'queued', 'the grant re-opens the lineage');
      // it fails the same way again: exhausted again at once (no progress)
      await waitFor(() => bad.state === 'exhausted' && bad.launches.length === 3, 60_000, 'exhausted again');
      // the Secretary's second grant on this lineage is refused, on any loop
      assert.deepEqual(await s.grant({ op: 'g2', lineage: 'L-bad', loop: 'env-retry', by: 'secretary', extra: 1, reason: 'again' }), { granted: false, why: 'secretary-already-granted' });
      assert.deepEqual(await s.grant({ op: 'g3', lineage: 'L-bad', loop: 'rework', by: 'secretary', extra: 1, reason: 'other loop' }), { granted: false, why: 'secretary-already-granted' });
      const askUser = s.cp.alerts().filter((a) => a.category === 'loop-exhausted-needs-user');
      assert.ok(askUser.length >= 1 && askUser.every((a) => a.wi === 'WI-08'), 'the user is asked through a WI-08 notice');
      assert.equal(l.svc.loopState('L-bad', 'env-retry').secretaryGrants, 1);
      // the user may grant more
      assert.deepEqual(await s.grant({ op: 'g-user', lineage: 'L-bad', loop: 'env-retry', by: 'user', extra: 1, reason: 'the user insists' }), { granted: true });
      assert.equal(bad.state, 'queued');
      touch(join(e.root, 'go'));
      await waitFor(() => good.state === 'done', 30_000, 'the other lineage finished');
    } finally {
      await s.close();
      await l.close();
    }
  });
});

describe('§14 item 10: budget block', { skip: unitSkip, timeout: 180_000 }, () => {
  test('a budget too small to start any paid step, nothing in flight: mission.block with snapshot, risks and reason, a WI-09 notice, no paid seat starts; unpaid work and other missions continue; raising the limit releases it', async () => {
    const e = makeEnv('budget');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    const M1 = id<MissionId>('m-budget');
    const M2 = id<MissionId>('m-other');
    try {
      await s.start();
      await s.ledger.setSpendLimit('limit-1', M1, 100);
      const paid = s.submit(hostTask(e, { task: 'paid', mission: M1, paid: true, estimateMicros: 500, job: { seat: true, seatStatus: 'handed-back' } }));
      const unpaid = s.submit(hostTask(e, { task: 'verify', mission: M1, job: {} }));
      const other = s.submit(hostTask(e, { task: 'elsewhere', mission: M2, paid: true, estimateMicros: 500, job: { seat: true, seatStatus: 'handed-back' } }));
      await waitFor(() => paid.state === 'budget-blocked', 20_000, 'budget block');
      assert.equal(paid.launches.length, 0, 'no paid seat started');
      assert.ok(s.isBlocked(M1));
      const b = blocks(e);
      assert.equal(b.length, 1);
      assert.equal(b[0]?.state, 'blocked');
      assert.equal(b[0]?.reason, 'budget');
      const report = JSON.parse(s.content.get(b[0]!.report).toString('utf8')) as { snapshot: unknown[]; risks: string[]; reason: string; spend: { limit: number } };
      assert.equal(report.spend.limit, 100);
      assert.ok(report.snapshot.length >= 2 && report.risks.length >= 1 && /cannot start/.test(report.reason));
      // the notice is raised right after the block; its copy is marked committed once the ledger has it
      const notice = await waitFor(() => s.cp.alerts().find((a) => a.category === 'budget-block' && a.committed), 10_000, 'the WI-09 notice in the ledger');
      assert.equal(notice.wi, 'WI-09');
      await waitFor(() => unpaid.state === 'done', 30_000, 'unpaid work of the same mission continues');
      await waitFor(() => other.state === 'done', 30_000, 'another mission (unlimited) continues');
      for (let i = 0; i < 3; i++) await s.tick();
      assert.equal(blocks(e).length, 1, 'one block record, not one per pass');
      // the user raises the limit
      await s.ledger.setSpendLimit('limit-2', M1, 10_000);
      await waitFor(() => paid.state === 'done', 30_000, 'released and run');
      assert.deepEqual(blocks(e).map((x) => x.state), ['blocked', 'released']);
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('not enough budget while work is in flight: wait for the in-flight reservations, no block', async () => {
    const e = makeEnv('budgetwait');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    const M1 = id<MissionId>('m-wait');
    try {
      await s.start();
      await s.ledger.setSpendLimit('limit-w', M1, 1_000);
      const first = s.submit(hostTask(e, { task: 'first', mission: M1, paid: true, estimateMicros: 400, job: { goFile: join(e.root, 'go'), seat: true, seatStatus: 'handed-back' } }));
      const launch = (await waitFor(() => first.launches[0], 20_000, 'first launched')) as LaunchId;
      // its metering proxy reserves for a model request in flight
      await l.svc.reserveSpend({ op: 'r1', reservation: id<ReservationId>('r1'), launch, micros: 900 });
      const second = s.submit(hostTask(e, { task: 'second', mission: M1, paid: true, estimateMicros: 400, job: { seat: true, seatStatus: 'handed-back' } }));
      await s.tick();
      await s.tick();
      assert.equal(second.state, 'queued');
      assert.equal(second.note, 'waiting for in-flight reservations');
      assert.ok(s.waitingReasons().some((w) => w.task === 'second' && w.reason === 'waiting for in-flight reservations'));
      assert.equal(blocks(e).length, 0, 'no budget block while work is in flight');
      // the request settles for less than reserved
      await l.svc.settleSpend({ op: 's1', reservation: id<ReservationId>('r1'), micros: 100 });
      touch(join(e.root, 'go'));
      await waitFor(() => second.state === 'done', 30_000, 'second runs once the reservation is released');
    } finally {
      await s.close();
      await l.close();
    }
  });
});
