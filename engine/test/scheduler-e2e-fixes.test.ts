// Scheduler bugs the end-to-end run through real processes found (2026-10-09): B5 a released
// stop held work forever (the inbox and spool keep the request after the ledger resolved it);
// B3 the installation's fuse2fs did not reach the seat host; W1 the Secretary could not act on
// an exhausted lineage (its own task was refused as an attempt of that lineage).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { id, type StopId } from '../src/common/ids.ts';
import type { GateVerdict } from '../src/exec/selfcheck.ts';
import type { LaunchSupervisorOptions } from '../src/exec/supervisor.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { readPendingStops, sendStop } from '../src/ledger/stops.ts';
import { systemUnits, type UnitControl } from '../src/scheduler/units.ts';
import { cleanupEnvs, hostTask, inProcessLedger, M, makeEnv, newScheduler, waitFor, type Env } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

const MiB = 1024 * 1024;
const PASS: GateVerdict = { seatsAllowed: true, moneyModeAllowed: true, key: 'test-key', missing: [], failed: [], reason: null };

function capturing(): { units: UnitControl; launched: LaunchSupervisorOptions[] } {
  const launched: LaunchSupervisorOptions[] = [];
  return { launched, units: { ...systemUnits, launch: async (o) => (launched.push(o), { pid: 0 } as never), activeState: async () => 'active', stop: async () => undefined, kill: async () => undefined } };
}

function stopPaths(e: Env): { inbox: string; controlPlane: string } {
  const p = ledgerPaths(e.ledgerRoot, e.cp);
  return { inbox: p.inbox, controlPlane: p.controlPlane };
}

describe('e2e fixes', { timeout: 120_000 }, () => {
  test('B5: after a stop is released its work is dispatched, also after a scheduler restart (the inbox still holds the request)', async () => {
    const e = makeEnv('e2e-b5');
    const l = inProcessLedger(e);
    const cap = capturing();
    const s1 = newScheduler(e, {}, { units: cap.units });
    const s2 = newScheduler(e, {}, { units: cap.units });
    try {
      await s1.start({ startLoops: false });
      const S = id<StopId>('stop-b5');
      sendStop(stopPaths(e), { stop: S, scope: { kind: 'mission', mission: M }, words: '停下', at: Date.now() });
      await waitFor(async () => {
        await s1.tick();
        return l.svc.stopState(S) === 'active';
      }, 10_000, 'stop committed');
      const a = await s1.submitDurable(hostTask(e, { task: 'a' }));
      await s1.tick();
      assert.equal(a.state, 'queued', 'held while the stop is in force');
      await l.svc.releaseStop(S);
      assert.ok(readPendingStops(stopPaths(e)).some((r) => r.stop === S), 'the inbox still holds the resolved request (the case of B5)');
      await s1.tick();
      await s1.tick();
      assert.equal(a.state, 'running', 'dispatched after the release');
      s1.abandon();
      await s2.start({ startLoops: false });
      const b = await s2.submitDurable(hostTask(e, { task: 'b' }));
      await s2.tick();
      assert.equal(b.state, 'running', 'and after a restart');
    } finally {
      await s2.close();
      await l.close();
    }
  });

  test('B3: the installation\'s fuse2fs goes to the seat host config', async () => {
    const e = makeEnv('e2e-b3');
    const l = inProcessLedger(e);
    const cap = capturing();
    const fuse2fs = '/opt/test/fuse2fs';
    const inst = { selfCheckDir: join(e.root, 'selfcheck'), credentials: { kind: 'fake-api-key' as const, key: 'sk-test' }, geometry: { blockBytes: 4096 }, fuse2fs, privateFuseMount: false, install: { bwrap: '/usr/bin/bwrap' } };
    const s = newScheduler(e, { seats: inst as never }, { selfCheck: () => PASS, units: cap.units });
    try {
      await s.start({ startLoops: false });
      const base = hostTask(e, { task: 'seat', job: { seat: true } });
      const card = new ContentStore(join(e.ledgerRoot, 'content')).put(JSON.stringify({ format: 'mp4.seat-card.v1', launch: 'template', seat: 'constructor', mission: M }));
      const demand = { hostBytes: 200 * MiB, runPeakBytes: 100 * MiB, runParallelism: 1, areaBytes: 16 * MiB, enclosureBytes: 64 * MiB, exportCaps: { maxLogicalBytes: MiB, maxFiles: 10 }, recoveryState: null };
      s.submit({ ...base, seat: { card, demand }, unit: { ...base.unit, seatUnit: true, heartbeat: true } });
      await waitFor(async () => {
        await s.tick();
        return cap.launched.length > 0;
      }, 20_000, 'unit start asked for');
      const host = JSON.parse(readFileSync(cap.launched[0]!.config.host.argv.at(-1)!, 'utf8')) as { install?: { fuse2fs?: string; bwrap?: string } };
      assert.deepEqual(host.install, { bwrap: '/usr/bin/bwrap', fuse2fs });
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('W1: the Secretary task deciding an exhausted lineage is dispatched, and its grant frees the lineage', async () => {
    const e = makeEnv('e2e-w1');
    const l = inProcessLedger(e);
    const cap = capturing();
    const s = newScheduler(e, {}, { units: cap.units });
    try {
      await s.start({ startLoops: false });
      for (const op of ['w1-f1', 'w1-f2']) await l.svc.appendRecords({ op, gen: s.gen, records: [{ kind: 'loop.attempt', lineage: 'LX', loop: 'env-retry', failureClass: 'no-proof', signature: 'same' }] });
      const work = await s.submitDurable(hostTask(e, { task: 'work', lineage: 'LX' }));
      await s.tick();
      assert.equal(work.state, 'exhausted');
      const sec = await s.submitDurable({ ...hostTask(e, { task: 'secretary-LX', lineage: 'L-sec' }), secretaryFor: { lineage: 'LX' } });
      await s.tick();
      assert.equal(sec.state, 'running', 'the Secretary is dispatched on the exhausted lineage');
      const g = await s.grant({ op: 'w1-grant', lineage: 'LX', loop: 'env-retry', by: 'secretary', extra: 1, reason: 'one more try after fixing the environment' });
      assert.equal(g.granted, true);
      assert.equal(work.state, 'queued', 'the grant requeues the exhausted task');
      await s.tick();
      assert.equal(work.state, 'running');
    } finally {
      await s.close();
      await l.close();
    }
  });
});
