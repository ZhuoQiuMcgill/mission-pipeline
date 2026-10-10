// Cleanup on the scheduler side (design v35 7.1, 6.3 rule 1; WI-14): a launch with no cleanup
// state gets its resources derived from its launch id; a pending cleanup is finished once its
// supervisor is confirmed gone, with bounded back-off and notices; a state the supervisor
// could only write locally is carried into the ledger; a live supervisor's cleanup is never
// touched. The executor is src/exec/cleanup.ts completeCleanup.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { id, type LaunchId } from '../src/common/ids.ts';
import { formatCleanupResource, recordIdentities, writeCleanupFile } from '../src/exec/cleanup.ts';
import { processIdentity, supervisorIdentityPath } from '../src/exec/supervisor.ts';
import { ExecCleanupExecutor } from '../src/scheduler/cleanup.ts';
import { writePrepared } from '../src/scheduler/localState.ts';
import { derivedUnitCgroupPath, unitNameOf } from '../src/scheduler/units.ts';
import { cleanupEnvs, inProcessLedger, M, makeEnv, newScheduler, type Env } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

let n = 0;
function launchWithConfig(e: Env, paths: string[]): LaunchId {
  const launch = id<LaunchId>(`cl-${process.pid}-${++n}`);
  mkdirSync(join(e.stateDir, 'configs'), { recursive: true });
  writeFileSync(join(e.stateDir, 'configs', `${launch}.json`), JSON.stringify({ launch, stateDir: e.stateDir, cleanup: { paths } }));
  return launch;
}

describe('cleanup (v35)', () => {
  test('derive from the launch id: cgroup, configured paths, sandbox holders; an entry never bound to its identity is kept (identity-unknown, WI-20); bound entries are released', async () => {
    const e = makeEnv('derive');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start({ startLoops: false });
      const area = join(e.scratch, 'area');
      mkdirSync(area);
      writeFileSync(join(area, 'f'), 'x');
      const launch = launchWithConfig(e, [area]);
      await l.svc.registerLaunch({ op: `reg-${launch}`, gen: s.gen, launch, tag: { mission: M, capabilities: [] } });
      const derived = new ExecCleanupExecutor({ stateDir: e.stateDir }).derive(launch);
      assert.deepEqual(derived, [formatCleanupResource({ kind: 'cgroup', path: derivedUnitCgroupPath(unitNameOf(launch)) }), formatCleanupResource({ kind: 'path', path: area })]);
      // the supervisor never existed (no identity, service inactive): the scheduler takes over the
      // cleanup; the configured path was never bound to its identity, so it may not be the unit's:
      // kept, pending, WI-20 (exec cleanup, code review r2 finding 1)
      const r = await s.cleanup.pass();
      assert.ok(r.pending.includes(launch));
      assert.equal(l.svc.cleanupState(launch), 'pending');
      assert.equal(existsSync(area), true, 'not deleted without its identity');
      assert.equal(s.cp.alerts().find((a) => a.category === 'cleanup-identity-unknown')?.wi, 'WI-20');
      // a preparation the scheduler recorded with its identity (seats.ts) is released
      const launch2 = launchWithConfig(e, []);
      const seatDir = join(e.stateDir, 'seats', launch2);
      mkdirSync(seatDir, { recursive: true });
      writeFileSync(join(seatDir, 'host.json'), '{}');
      writePrepared(e.stateDir, { format: 'mp4.prepared-launch.v1', launch: launch2, resources: recordIdentities([formatCleanupResource({ kind: 'path', path: seatDir })], { roots: [join(e.stateDir, 'seats')] }), demand: null, at: Date.now() });
      await l.svc.registerLaunch({ op: `reg-${launch2}`, gen: s.gen, launch: launch2, tag: { mission: M, capabilities: [] } });
      const r2 = await s.cleanup.pass();
      assert.ok(r2.done.includes(launch2));
      assert.equal(l.svc.cleanupState(launch2), 'done');
      assert.equal(existsSync(seatDir), false);
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('a pending cleanup that keeps failing: bounded back-off, a WI-14 notice, done once possible; other launches are not held up', async () => {
    const e = makeEnv('failing');
    const l = inProcessLedger(e);
    const s = newScheduler(e, { cleanup: { initialBackoffMs: 50, maxBackoffMs: 200, alertAfter: 3, alertEvery: 10 } });
    const locked = join(e.scratch, 'locked');
    const area = join(locked, 'area');
    mkdirSync(area, { recursive: true });
    chmodSync(locked, 0o555);
    try {
      await s.start({ startLoops: false });
      const stuck = launchWithConfig(e, [area]);
      const fine = launchWithConfig(e, [join(e.scratch, 'other')]);
      mkdirSync(join(e.scratch, 'other'));
      for (const launch of [stuck, fine]) await l.svc.registerLaunch({ op: `reg-${launch}`, gen: s.gen, launch, tag: { mission: M, capabilities: [] } });
      // both registered by their supervisor with the identities of their paths
      for (const [launch, path] of [[stuck, area], [fine, join(e.scratch, 'other')]] as const) {
        const bound = recordIdentities([formatCleanupResource({ kind: 'path', path })], { roots: [e.scratch] });
        await l.svc.recordCleanup({ op: `cl-${launch}`, launch, state: 'pending', resources: l.svc.content.putList(bound) });
      }
      const first = await s.cleanup.pass();
      assert.ok(first.done.includes(fine), 'the other launch is cleaned up');
      assert.ok(first.pending.includes(stuck));
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 250));
        await s.cleanup.pass();
      }
      assert.ok(s.cleanup.failures(stuck) >= 3);
      const notice = s.cp.alerts().find((a) => a.category === 'cleanup-failing');
      assert.equal(notice?.wi, 'WI-14');
      assert.equal(l.svc.cleanupState(stuck), 'pending');
      chmodSync(locked, 0o755);
      await new Promise((r) => setTimeout(r, 250));
      await s.cleanup.pass();
      assert.equal(l.svc.cleanupState(stuck), 'done');
    } finally {
      chmodSync(locked, 0o755);
      await s.close();
      await l.close();
    }
  });

  test('a state the supervisor could only write locally is carried into the ledger', async () => {
    const e = makeEnv('local');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start({ startLoops: false });
      const launch = launchWithConfig(e, []);
      await l.svc.registerLaunch({ op: `reg-${launch}`, gen: s.gen, launch, tag: { mission: M, capabilities: [] } });
      writeCleanupFile(e.stateDir, { format: 'mp4.unit-cleanup.v1', launch, state: 'done', resources: [], recorded: false, at: new Date().toISOString() });
      await s.cleanup.pass();
      assert.equal(l.svc.cleanupState(launch), 'done');
      assert.equal(existsSync(join(e.stateDir, 'cleanup', `${launch}.json`)), false);
    } finally {
      await s.close();
      await l.close();
    }
  });

  test("a live supervisor's cleanup is left to it", async () => {
    const e = makeEnv('live');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start({ startLoops: false });
      const area = join(e.scratch, 'area');
      mkdirSync(area);
      const launch = launchWithConfig(e, [area]);
      await l.svc.registerLaunch({ op: `reg-${launch}`, gen: s.gen, launch, tag: { mission: M, capabilities: [] } });
      // an identity file naming a live process (this one) as the supervisor
      mkdirSync(join(e.stateDir, 'supervisors'), { recursive: true });
      writeFileSync(supervisorIdentityPath(e.stateDir, launch), JSON.stringify({ format: 'mp4.unit-supervisor-identity.v1', ...processIdentity(process.pid), launch, unitName: unitNameOf(launch), invocationId: null, startedAt: '' }));
      const r = await s.cleanup.pass();
      assert.ok(r.skipped.includes(launch));
      assert.equal(l.svc.cleanupState(launch), null);
      assert.ok(existsSync(area));
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('a resource that is no longer the one registered (identity mismatch) is not touched: WI-20, still pending', async () => {
    const e = makeEnv('identity');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start({ startLoops: false });
      const area = join(e.scratch, 'area');
      mkdirSync(area);
      const launch = launchWithConfig(e, [area]);
      await l.svc.registerLaunch({ op: `reg-${launch}`, gen: s.gen, launch, tag: { mission: M, capabilities: [] } });
      // the supervisor registered the area with its identity, then something replaced it
      const bound = recordIdentities([formatCleanupResource({ kind: 'path', path: area })], { roots: [e.scratch] });
      assert.match(bound[0]!, /^path@/);
      await l.svc.recordCleanup({ op: `cl-${launch}`, launch, state: 'pending', resources: l.svc.content.putList(bound) });
      rmSync(area, { recursive: true });
      mkdirSync(area);
      writeFileSync(join(area, 'someone-else'), 'not the unit\'s');
      const r = await s.cleanup.pass();
      assert.ok(r.pending.includes(launch));
      assert.equal(l.svc.cleanupState(launch), 'pending');
      assert.ok(existsSync(join(area, 'someone-else')), 'left untouched');
      const n = s.cp.alerts().find((a) => a.category === 'cleanup-identity-mismatch');
      assert.equal(n?.wi, 'WI-20');
    } finally {
      await s.close();
      await l.close();
    }
  });
});
