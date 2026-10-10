// Loop caps, no progress, exhaustion and grants (design 6.5, WI-08) against a real ledger
// service: the counts live in the ledger, so they survive a scheduler restart.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { LoopKind } from '../src/common/records.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { Alerts } from '../src/scheduler/alerts.ts';
import { ControlPlane } from '../src/scheduler/controlPlane.ts';
import { SchedulerLedger } from '../src/scheduler/ledger.ts';
import { LOOP_CAPS, LoopGuard } from '../src/scheduler/loops.ts';
import { cleanupEnvs, inProcessLedger, makeEnv, type Env } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

function guard(e: Env): { g: LoopGuard; ledger: SchedulerLedger; cp: ControlPlane } {
  const ledger = SchedulerLedger.connect(e.socket, 5_000);
  const content = new ContentStore(join(e.ledgerRoot, 'content'));
  const cp = new ControlPlane(e.cp);
  const g = new LoopGuard({ ledger, content, alerts: new Alerts({ ledger, content, controlPlane: cp, source: 'test' }) });
  return { g, ledger, cp };
}

let seq = 0;
function attempt(g: LoopGuard, lineage: string, loop: LoopKind, signature: string, failureClass: string | null = null) {
  return g.attempt({ op: `a-${++seq}`, gen: null, lineage, loop, failureClass, signature });
}

describe('loop caps (6.5)', () => {
  test('each loop stops at its cap, with distinct failure signatures', async () => {
    const e = makeEnv('caps');
    const l = inProcessLedger(e);
    const { g, ledger } = guard(e);
    try {
      for (const loop of ['mechanical-return', 'feasibility-return', 'rework', 'quarantine-restart', 'delivery-rebuild'] as const) {
        const cap = LOOP_CAPS[loop];
        for (let i = 1; i <= cap; i++) {
          const v = await attempt(g, `L-${loop}`, loop, `sig-${i}`);
          assert.equal(v.exhausted, i >= cap, `${loop} attempt ${i}/${cap}`);
        }
        assert.equal((await g.verdict(`L-${loop}`, loop)).reason, 'cap');
      }
      assert.deepEqual(
        { mech: LOOP_CAPS['mechanical-return'], feas: LOOP_CAPS['feasibility-return'], rework: LOOP_CAPS.rework, quarantine: LOOP_CAPS['quarantine-restart'], rebuild: LOOP_CAPS['delivery-rebuild'], env: LOOP_CAPS['env-retry'] },
        { mech: 3, feas: 1, rework: 2, quarantine: 2, rebuild: 3, env: 6 },
      );
    } finally {
      ledger.close();
      await l.close();
    }
  });

  test('v42: delivery rebuilds count every rebuild, and repeated signatures are not "no progress" for them', async () => {
    const e = makeEnv('rebuild');
    const l = inProcessLedger(e);
    const { g, ledger } = guard(e);
    try {
      assert.equal((await attempt(g, 'D', 'delivery-rebuild', 'base-moved')).exhausted, false);
      assert.equal((await attempt(g, 'D', 'delivery-rebuild', 'base-moved')).exhausted, false, 'same signature twice: still allowed');
      const v = await attempt(g, 'D', 'delivery-rebuild', 'base-moved');
      assert.equal(v.exhausted, true);
      assert.equal(v.reason, 'cap');
    } finally {
      ledger.close();
      await l.close();
    }
  });

  test('environment retries: 3 per failure class, 6 in total', async () => {
    const e = makeEnv('envcaps');
    const l = inProcessLedger(e);
    const { g, ledger } = guard(e);
    try {
      for (let i = 1; i <= 3; i++) await attempt(g, 'L', 'env-retry', `a${i}`, 'no-proof');
      assert.equal((await g.verdict('L', 'env-retry', 'no-proof')).reason, 'class-cap', 'class no-proof used up');
      assert.equal((await g.verdict('L', 'env-retry', 'timed-out')).exhausted, false, 'another class still has room');
      for (let i = 1; i <= 2; i++) await attempt(g, 'L', 'env-retry', `b${i}`, 'timed-out');
      const v = await attempt(g, 'L', 'env-retry', 'c1', 'heartbeat-lost');
      assert.equal(v.attempts, 6);
      assert.equal(v.reason, 'cap', '6 in total');
    } finally {
      ledger.close();
      await l.close();
    }
  });

  test('no progress: the same signature twice in a row exhausts at once; exhaustion survives a restart; a grant clears it until the next attempt', async () => {
    const e = makeEnv('noprogress');
    const l = inProcessLedger(e);
    const { g, ledger } = guard(e);
    try {
      assert.equal((await attempt(g, 'L', 'mechanical-return', 'same')).exhausted, false);
      const v = await attempt(g, 'L', 'mechanical-return', 'same');
      assert.equal(v.exhausted, true);
      assert.equal(v.reason, 'no-progress');
      // a restarted scheduler (a new guard, a new connection) sees the same state
      const again = guard(e);
      assert.equal((await again.g.verdict('L', 'mechanical-return')).reason, 'no-progress');
      again.ledger.close();
      // the Secretary grants +2: the loop is open again until the next attempt
      assert.deepEqual(await g.grant({ op: 'grant-1', gen: null, lineage: 'L', loop: 'mechanical-return', by: 'secretary', extra: 2, reason: 'different approach' }), { granted: true, extra: 2 });
      assert.equal((await g.verdict('L', 'mechanical-return')).exhausted, false);
      // the next attempt repeats the signature: no progress again
      assert.equal((await attempt(g, 'L', 'mechanical-return', 'same')).reason, 'no-progress');
      // a second Secretary grant on this lineage, even on another loop, is refused; the user is asked
      assert.deepEqual(await g.grant({ op: 'grant-2', gen: null, lineage: 'L', loop: 'rework', by: 'secretary', extra: 1, reason: 'x' }), { granted: false, why: 'secretary-already-granted' });
      // the ledger itself refuses a second Secretary grant on the same (lineage, loop)
      const c = l.svc.content.put('direct');
      await assert.rejects(l.svc.appendRecords({ op: 'grant-direct', gen: null, records: [{ kind: 'loop.grant', lineage: 'L', loop: 'mechanical-return', by: 'secretary', extra: 1, reason: c }] }), /GRANT_LIMIT/);
      // a different signature after a user grant makes progress
      assert.deepEqual(await g.grant({ op: 'grant-user', gen: null, lineage: 'L', loop: 'mechanical-return', by: 'user', extra: 1, reason: 'the user decided' }), { granted: true, extra: 1 });
      const after = await attempt(g, 'L', 'mechanical-return', 'different');
      assert.equal(after.exhausted, after.attempts >= after.allowed);
      assert.equal(after.reason === 'no-progress', false);
    } finally {
      ledger.close();
      await l.close();
    }
  });

  test('WI-08: exhaustion notices name the work instruction, stop only that lineage, and ask the user once the Secretary has granted', async () => {
    const e = makeEnv('wi08');
    const l = inProcessLedger(e);
    const { g, ledger, cp } = guard(e);
    try {
      await attempt(g, 'L1', 'mechanical-return', 's');
      const v = await attempt(g, 'L1', 'mechanical-return', 's');
      await g.escalate(v, { task: 't' });
      const first = cp.alerts().find((a) => a.category === 'loop-exhausted');
      assert.equal(first?.wi, 'WI-08');
      assert.match(first?.defaultAction ?? '', /only lineage L1/);
      await g.grant({ op: 'g', gen: null, lineage: 'L1', loop: 'mechanical-return', by: 'secretary', extra: 1, reason: 'r' });
      const v2 = await attempt(g, 'L1', 'mechanical-return', 's');
      await g.escalate(v2, { task: 't' });
      const ask = cp.alerts().find((a) => a.category === 'loop-exhausted-needs-user');
      assert.equal(ask?.wi, 'WI-08');
      assert.equal((ask?.detail as { askUser: boolean }).askUser, true);
    } finally {
      ledger.close();
      await l.close();
    }
  });
});
