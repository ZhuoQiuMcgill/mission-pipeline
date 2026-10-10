// Seat units on the scheduler side (design 6.2, 6.5, 7.1, 9.3; WI-10, WI-18): the startup
// self-check gate before any seat; the writable area decided at admission (tmpfs, an image
// created and allocated now, or a resource block); reservations from the unit's whole-life
// demand (recovery state included); the seat host and supervisor configs; a money spend limit
// only with the self-check's item 9; exec alerts written only locally carried to the ledger.
// A real seat needs a model, so the unit start is intercepted where the configs are checked.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { id, type MissionId } from '../src/common/ids.ts';
import { execAlert, FileAlertSink } from '../src/exec/alerts.ts';
import { exportTempDir } from '../src/exec/export.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { readPrepared } from '../src/scheduler/localState.ts';
import { findFuse2fs } from '../src/exec/platform.ts';
import { unitMemoryReservation, type UnitDemand } from '../src/exec/resources.ts';
import type { GateVerdict } from '../src/exec/selfcheck.ts';
import type { LaunchSupervisorOptions } from '../src/exec/supervisor.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { readRecords } from '../src/ledger/store.ts';
import { readLaunchMeta } from '../src/scheduler/launches.ts';
import { seatReservation, type SeatInstall } from '../src/scheduler/seats.ts';
import { systemUnits, type UnitControl } from '../src/scheduler/units.ts';
import { SEAT_HOST_MAIN } from '../src/seat/unit.ts';
import { cleanupEnvs, hostTask, inProcessLedger, makeEnv, newScheduler, unitSkip, waitFor, type Env } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

const MiB = 1024 * 1024;
const EXTRACTED_FUSE2FS = process.env['MP_TEST_FUSE2FS']; // an unpacked fuse2fs for machines without one on PATH
const fuse2fs = findFuse2fs() ?? findFuse2fs(EXTRACTED_FUSE2FS);

const PASS: GateVerdict = { seatsAllowed: true, moneyModeAllowed: true, key: 'test-key', missing: [], failed: [], reason: null };
const NO_MONEY: GateVerdict = { ...PASS, moneyModeAllowed: false };

function install(e: Env, o: Partial<SeatInstall> = {}): SeatInstall {
  return { selfCheckDir: join(e.root, 'selfcheck'), credentials: { kind: 'fake-api-key', key: 'sk-test' }, geometry: { blockBytes: 4096 }, ...o };
}

function demand(areaBytes: number, recovery = false): UnitDemand {
  return {
    hostBytes: 200 * MiB,
    runPeakBytes: 100 * MiB,
    runParallelism: 1,
    areaBytes,
    enclosureBytes: 64 * MiB,
    exportCaps: { maxLogicalBytes: 8 * MiB, maxFiles: 200 },
    recoveryState: recovery ? { maxLogicalBytes: 4 * MiB, maxFiles: 50 } : null,
  };
}

/** A seat card template in the content store (each launch gets its own copy naming it). */
function cardTemplate(e: Env, task: string): string {
  return new ContentStore(join(e.ledgerRoot, 'content')).put(JSON.stringify({ format: 'mp4.seat-card.v1', launch: 'template', seat: 'constructor', mission: 'm1', task }));
}

function seatTask(e: Env, task: string, d: UnitDemand) {
  const base = hostTask(e, { task, job: { seat: true } });
  return { ...base, seat: { card: cardTemplate(e, task), demand: d }, unit: { ...base.unit, seatUnit: true, heartbeat: true } };
}

/** Records the unit configs instead of starting a seat (that needs a model). */
function capturing(): { units: UnitControl; launched: LaunchSupervisorOptions[] } {
  const launched: LaunchSupervisorOptions[] = [];
  return {
    launched,
    units: {
      ...systemUnits,
      launch: async (o) => {
        launched.push(o);
        throw new Error('not started in this test');
      },
    },
  };
}

describe('seat dispatch (9.3, 7.1, 6.5)', { timeout: 120_000 }, () => {
  test('no passing startup self-check: the seat is held with a WI-18 notice; work that needs no seat goes on', { skip: unitSkip }, async () => {
    const e = makeEnv('gate');
    const l = inProcessLedger(e);
    const s = newScheduler(e, { seats: install(e) }); // an empty evidence directory
    try {
      await s.start();
      const seat = s.submit(seatTask(e, 'seat', demand(16 * MiB)));
      const plain = s.submit(hostTask(e, { task: 'plain' }));
      await waitFor(() => plain.state === 'done', 30_000, 'the program run goes on');
      assert.equal(seat.launches.length, 0);
      assert.match(seat.note ?? '', /no passing startup self-check/);
      const n = s.cp.alerts().find((a) => a.category === 'seats-held-selfcheck');
      assert.equal(n?.wi, 'WI-18');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('a large-disk seat on a machine without fuse2fs: resource blocked (WI-10), not dispatched, no degradation', async () => {
    const e = makeEnv('area-blocked');
    const l = inProcessLedger(e);
    const cap = capturing();
    const s = newScheduler(e, { seats: install(e, { fuse2fs: '/nonexistent/fuse2fs' }) }, { selfCheck: () => PASS, units: cap.units });
    const saved = process.env['MP_FUSE2FS'];
    delete process.env['MP_FUSE2FS'];
    try {
      await s.start({ startLoops: false });
      const t = s.submit(seatTask(e, 'big', demand(512 * MiB)));
      await s.tick();
      await s.tick();
      if (findFuse2fs('/nonexistent/fuse2fs') !== null) return; // fuse2fs on PATH: the block cannot be produced here
      assert.equal(t.state, 'blocked');
      assert.equal(cap.launched.length, 0);
      const n = s.cp.alerts().find((a) => a.category === 'resource-block' && a.key === 'big:area');
      assert.equal(n?.wi, 'WI-10');
      assert.match(String(n?.trigger), /fuse2fs/);
    } finally {
      if (saved !== undefined) process.env['MP_FUSE2FS'] = saved;
      await s.close();
      await l.close();
    }
  });

  test('a tmpfs seat: reservations from the whole-life demand (recovery state included), the seat host and supervisor configs', async () => {
    const e = makeEnv('seat-tmpfs');
    const l = inProcessLedger(e);
    const cap = capturing();
    const inst = install(e);
    const s = newScheduler(e, { seats: inst }, { selfCheck: () => PASS, units: cap.units });
    try {
      await s.start({ startLoops: false });
      const d = demand(16 * MiB, true);
      const t = s.submit({ ...seatTask(e, 'seat', d) });
      await waitFor(async () => {
        await s.tick();
        return cap.launched.length > 0;
      }, 20_000, 'unit start asked for');
      const launch = t.launches[0]!;
      const o = cap.launched[0]!;
      assert.equal(o.config.host.argv.includes(SEAT_HOST_MAIN), true, 'the seat host');
      assert.equal(o.config.unit.memoryMax, unitMemoryReservation(d));
      assert.equal(o.config.stopGraceMs, 30_000, 'seat units get 30 s after a stop');
      const seatDir = join(e.stateDir, 'seats', launch);
      assert.ok(o.config.cleanup?.scratchDirs?.includes(exportTempDir(join(e.ledgerRoot, 'content'), launch)), 'the host\'s export directory is a scratch directory (bound to its identity by the supervisor)');
      assert.ok(o.config.cleanup?.scratchDirs?.includes(seatDir), 'the seat directory is a scratch directory too');
      const hostCfgPath = o.config.host.argv.at(-1)!;
      const host = JSON.parse(readFileSync(hostCfgPath, 'utf8')) as { area: { kind: string }; selfCheck: { dir: string }; card: string; format: string };
      assert.deepEqual([host.format, host.area.kind, host.selfCheck.dir], ['mp4.seat-host.v1', 'tmpfs', inst.selfCheckDir]);
      // the launch's own card: the template with this launch's id (the seat host checks it)
      const card = JSON.parse(new ContentStore(join(e.ledgerRoot, 'content')).get(host.card as never).toString('utf8')) as { launch: string; task: string };
      assert.deepEqual([card.launch, card.task], [launch, 'seat']);
      // recorded before registration, bound to its identity (r1 #11)
      const prep = readPrepared(e.stateDir).find((r) => r.launch === launch);
      assert.match(prep?.resources[0] ?? '', /^path@\d+\.\d+:/);
      const meta = readLaunchMeta(e.stateDir, launch)!;
      assert.deepEqual(meta.demand, seatReservation(d, { blockBytes: 4096 }));
      assert.ok(seatReservation(d).diskBytes > seatReservation({ ...d, recoveryState: null }).diskBytes, 'the recovery state is reserved at dispatch (6.2)');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('fuse2fs present but no FUSE mount inside a private namespace (v49 7.1): resource blocked (WI-10)', async () => {
    const e = makeEnv('area-noprivate');
    const l = inProcessLedger(e);
    const cap = capturing();
    const s = newScheduler(e, { seats: install(e, { fuse2fs: fuse2fs ?? '/usr/bin/true', privateFuseMount: false }) }, { selfCheck: () => PASS, units: cap.units });
    try {
      await s.start({ startLoops: false });
      const t = s.submit(seatTask(e, 'big', demand(128 * MiB)));
      await s.tick();
      assert.equal(t.state, 'blocked');
      assert.equal(cap.launched.length, 0);
      const n = s.cp.alerts().find((a) => a.category === 'resource-block' && a.key === 'big:area');
      assert.equal(n?.wi, 'WI-10');
      assert.match(String(n?.trigger), /private user namespace/);
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('a large-disk seat with fuse2fs: the image is created and fully allocated at admission; its mount and file are cleanup resources', { skip: fuse2fs === null ? 'no fuse2fs on this machine' : false }, async () => {
    const e = makeEnv('seat-image');
    const l = inProcessLedger(e);
    const cap = capturing();
    const s = newScheduler(e, { seats: install(e, { fuse2fs: fuse2fs! }) }, { selfCheck: () => PASS, units: cap.units });
    try {
      await s.start({ startLoops: false });
      const d = demand(128 * MiB); // over a quarter of the memory reservation: an image
      s.submit(seatTask(e, 'big', d));
      await waitFor(async () => {
        await s.tick();
        return cap.launched.length > 0;
      }, 30_000, 'unit start asked for');
      const o = cap.launched[0]!;
      const host = JSON.parse(readFileSync(o.config.host.argv.at(-1)!, 'utf8')) as { area: { kind: string; image: string; mountDir: string } };
      assert.equal(host.area.kind, 'image');
      assert.ok(existsSync(host.area.image));
      assert.ok(statSync(host.area.image).blocks * 512 >= 128 * MiB, 'allocated in full at admission');
      assert.deepEqual(o.config.cleanup?.images, [host.area.image]);
      assert.deepEqual(o.config.cleanup?.fuseMounts, [host.area.mountDir]);
      // the preparation record has the image bound to its identity, so a crash before
      // registration still releases it (r1 #11)
      const prep = readPrepared(e.stateDir).find((r) => r.launch === o.config.launch);
      assert.ok(prep?.resources.some((r) => r.startsWith('image@') && r.endsWith(`:${host.area.image}`)));
      assert.equal(o.config.unit.memoryMax, unitMemoryReservation(d), 'an image area is not charged to memory');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('a money spend limit only with the self-check\'s item 9 (6.5, WI-18)', async () => {
    const e = makeEnv('money');
    const l = inProcessLedger(e);
    const M1 = id<MissionId>('m-money');
    let verdict = NO_MONEY;
    const s = newScheduler(e, {}, { selfCheck: () => verdict });
    try {
      await s.start({ startLoops: false });
      assert.deepEqual(await s.setSpendLimit(M1, 1_000, 'limit-a'), { set: false, why: 'the money form needs a passing self-check item 9 (6.5, WI-18)' });
      assert.equal(l.svc.spendSummary(M1).limit, null, 'the mission stays unlimited');
      assert.equal(s.cp.alerts().find((a) => a.category === 'money-limit-refused')?.wi, 'WI-18');
      assert.deepEqual(await s.setSpendLimit(M1, null, 'limit-b'), { set: true }, 'unlimited is always allowed');
      verdict = PASS;
      assert.deepEqual(await s.setSpendLimit(M1, 1_000, 'limit-c'), { set: true });
      assert.equal(l.svc.spendSummary(M1).limit, 1_000);
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('exec alerts written only locally (the ledger was away) reach the ledger and the control plane with their WI', async () => {
    const e = makeEnv('execalerts');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start({ startLoops: false });
      new FileAlertSink(e.stateDir).alert(execAlert('cleanup-pending', null, 'left for the scheduler', { left: ['path:/x'] }, 'retried by the scheduler', 'k1'));
      await s.tick();
      await s.tick();
      const recs = readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, 0 as never).filter((c) => c.record.kind === 'alert');
      assert.ok(recs.some((c) => (c.record as { wi?: string; category: string }).category === 'cleanup-pending' && (c.record as { wi?: string }).wi === 'WI-14'));
      assert.ok(s.cp.alerts().some((a) => a.category === 'cleanup-pending' && a.wi === 'WI-14'), 'copied to the control plane');
    } finally {
      await s.close();
      await l.close();
    }
  });
});
