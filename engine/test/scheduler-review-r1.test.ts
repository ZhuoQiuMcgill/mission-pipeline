// The serious findings of the scheduler code review, round 1 (gpt-6.1-sol, 2026-10-09): one
// deterministic test each, in process (a real ledger service over its socket; units, systemd
// and the evaluator replaced where the finding is about the scheduler's own decisions).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { id, type JudgmentId, type LaunchId, type ObjectVersionId, type StopId } from '../src/common/ids.ts';
import type { BaseRecord, JudgmentRecord } from '../src/common/records.ts';
import { formatCleanupResource, recordIdentities } from '../src/exec/cleanup.ts';
import type { LaunchSupervisorOptions } from '../src/exec/supervisor.ts';
import { LedgerUnavailable } from '../src/ledger/ipc.ts';
import { ControlPlane } from '../src/scheduler/controlPlane.ts';
import { writeLaunchMeta } from '../src/scheduler/launches.ts';
import { readEndedAcceptances, readPrepared, writePrepared } from '../src/scheduler/localState.ts';
import type { Scheduler } from '../src/scheduler/scheduler.ts';
import { StopManager } from '../src/scheduler/stops.ts';
import type { TaskRecord, TaskSpec } from '../src/scheduler/tasks.ts';
import { systemUnits, type UnitControl } from '../src/scheduler/units.ts';
import { Watchdog } from '../src/scheduler/watchdog.ts';
import { cleanupEnvs, hostTask, inProcessLedger, M, makeEnv, newScheduler, waitFor, type Env, type InProcessLedger } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

/** Records unit starts instead of starting anything. */
function capturing(): { units: UnitControl; launched: LaunchSupervisorOptions[] } {
  const launched: LaunchSupervisorOptions[] = [];
  return {
    launched,
    units: {
      ...systemUnits,
      launch: async (o) => {
        launched.push(o);
        return { pid: 0 } as never;
      },
      activeState: async () => 'active',
    },
  };
}

/** Private members, for the decisions this file is about. */
type Inside = {
  route(t: TaskRecord, launch: LaunchId): Promise<void>;
  evalQuery: { call(m: string, p?: unknown): Promise<unknown>; close(): void } | null;
  evaluatorFault: string | null;
  reregisterEndedAcceptances(): void;
  recovered: boolean;
};
const inside = (s: Scheduler): Inside => s as unknown as Inside;

/** A launch accepted in the ledger, as an earlier generation would have left it. */
async function acceptedLaunch(l: InProcessLedger, gen: number, launch: string, task: string, records: BaseRecord[] = []): Promise<LaunchId> {
  const L = id<LaunchId>(launch);
  await l.svc.registerLaunch({ op: `reg-${launch}`, gen: gen as never, launch: L, tag: { mission: M, capabilities: [] } });
  await l.svc.dequeueTask({ op: `dq-${launch}`, gen: gen as never, task, reason: 'dispatched', launch: L });
  if (records.length > 0) await l.svc.submitPendingResult({ op: `res-${launch}`, launch: L, records } as never);
  await l.svc.registerProof({ kind: 'termination.proof', launch: L, exit: { code: 0, signal: null }, controlOomKill: 0, unitOomKill: 0, unitOom: 0 } as never);
  await l.svc.dispose({ gen: gen as never, launch: L, disposition: 'accepted', reason: 'accepted' });
  return L;
}

function task(e: Env, name: string, o: Partial<TaskSpec> = {}): TaskSpec {
  return { ...hostTask(e, { task: name }), ...o };
}

describe('scheduler code review r1: serious findings', { timeout: 120_000 }, () => {
  test('#1 without an evaluator, bound results are never "proven": the step ends (WI-11)', async () => {
    const e = makeEnv('r1-1');
    const l = inProcessLedger(e);
    const s = newScheduler(e, {}, { units: capturing().units });
    try {
      await s.start({ startLoops: false });
      const t = s.tasks.add(task(e, 'bound', { binds: ['obj-unproven'] }));
      await inside(s).route(t, id<LaunchId>('L1'));
      assert.equal(s.nextSteps.get('bound')?.kind, 'ended');
      assert.equal(s.cp.alerts().find((a) => a.category === 'derived-state-unavailable')?.wi, 'WI-11');
      const none = s.tasks.add(task(e, 'unbound'));
      await inside(s).route(none, id<LaunchId>('L2'));
      assert.deepEqual(s.nextSteps.get('unbound'), { kind: 'continue', label: 'proven' }, 'nothing bound, nothing to prove');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('#2 a stable task waits until its dependency is proven (an informational notice); it is dispatched once the label is proven', async () => {
    const e = makeEnv('r1-2');
    const l = inProcessLedger(e);
    const cap = capturing();
    let label = 'not-fully-proven';
    const s = newScheduler(e, {}, { units: cap.units, evaluatorQuery: { call: async () => ({ revision: 1e9, states: { 'obj-a': { label } } }), close: () => undefined } });
    try {
      await s.start({ startLoops: false });
      const parent = s.tasks.add(task(e, 'parent', { binds: ['obj-a'] }));
      parent.state = 'done';
      await inside(s).route(parent, id<LaunchId>('LP'));
      assert.equal(s.nextSteps.get('parent')?.kind, 'reaccept');
      const child = await s.submitDurable(task(e, 'child', { mode: 'stable', dependsOn: ['parent'] }));
      await s.tick();
      assert.equal(child.state, 'queued');
      assert.equal(cap.launched.length, 0);
      assert.ok(s.waitingReasons().some((w) => w.task === 'child' && /not proven/.test(w.reason)));
      const n = s.cp.alerts().find((a) => a.category === 'stable-dispatch-waits-for-proof');
      assert.equal(n?.wi, null, 'waiting for proof is the rule (5.4), not an exception');
      label = 'proven';
      await inside(s).route(parent, id<LaunchId>('LP'));
      await s.tick();
      assert.equal(child.state, 'running');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('#3 a stop is never "stopped" while the ledger cannot be read: tracked units and intents stay unknown', async () => {
    const e = makeEnv('r1-3');
    let down = false;
    const fail = (): never => {
      throw new LedgerUnavailable('outage');
    };
    const ledger = {
      drainStops: async () => (down ? fail() : undefined),
      activeStops: async () => (down ? fail() : [{ stop: 'S', scope: { kind: 'all' }, words: 'stop', committedAt: 1 }]),
      stopState: async () => (down ? fail() : 'active'),
      launches: async () => (down ? fail() : [{ launch: 'unclean', cleanup: 'pending', disposition: 'cancelled' }]),
      cleanupState: async () => (down ? fail() : 'pending'),
      openIntents: async () => (down ? fail() : []),
    };
    const cp = new ControlPlane(e.cp);
    const sm = new StopManager({
      ledger: ledger as never,
      cp,
      stopPaths: { inbox: join(e.root, 'no-inbox'), controlPlane: e.cp },
      stateDir: e.stateDir,
      units: { ...systemUnits, stop: async () => undefined, kill: async () => undefined, activeState: async () => 'inactive' },
      processes: { alive: () => false, kill: () => ({ sent: true, error: null }) },
      takeover: { meta: () => null, markEnded: () => undefined } as never,
      alerts: { raise: async () => 'a' } as never,
    });
    await sm.check();
    assert.equal(sm.report(id<StopId>('S'))?.state, 'stopping');
    down = true;
    await sm.check();
    const r = sm.report(id<StopId>('S'))!;
    assert.equal(r.state, 'stopping', 'unknown is not "stopped"');
    assert.deepEqual(r.units.map((u) => [u.launch, u.cleanup]), [['unclean', 'unknown']], 'the tracked unit is kept');
  });

  test('#4 while the scheduler is away, a failed kill is retried until the unit is gone; WI-14 if it resists', async () => {
    const e = makeEnv('r1-4');
    let now = 100;
    let kills = 0;
    let state = 'active';
    const wd = new Watchdog({
      controlPlane: e.cp,
      stateDir: e.stateDir,
      now: () => now,
      ledger: { argv: ['unused'], heartbeatPath: join(e.cp, 'l') },
      scheduler: { argv: ['unused'], heartbeatPath: join(e.cp, 's') },
      stopTimeoutMs: 10,
      unkillableAfterMs: 1_000,
      units: {
        ...systemUnits,
        stop: async () => {
          throw new Error('systemd outage');
        },
        kill: async () => {
          kills++;
          throw new Error('systemd outage');
        },
        activeState: async () => state,
      },
    });
    const w = wd as unknown as { proc(n: string): { state: string }; ledgerClient: unknown; enforceStopsWithoutScheduler(): Promise<void> };
    w.proc('scheduler').state = 'restart-exhausted';
    w.ledgerClient = { activeStops: async () => [{ scope: { kind: 'all' } }] };
    new ControlPlane(e.cp).putHost({ format: 'mp4.host-entry.v1', launch: id<LaunchId>('left'), unitName: 'left.service', tag: { mission: M, capabilities: [] }, task: 'left', lineage: 'left', seatUnit: true, heartbeat: true, gen: 1 as never, at: 100 });
    for (let i = 0; i < 5; i++) {
      now += 20;
      await w.enforceStopsWithoutScheduler();
    }
    assert.ok(kills >= 3, `kills retried (${kills})`);
    now += 2_000;
    await w.enforceStopsWithoutScheduler();
    assert.equal(wd.alerts.pending + new ControlPlane(e.cp).alerts().filter((a) => a.category === 'stop-unkillable' && a.wi === 'WI-14').length > 0, true);
    state = 'inactive';
    const before = kills;
    now += 20;
    await w.enforceStopsWithoutScheduler();
    now += 20;
    await w.enforceStopsWithoutScheduler();
    assert.equal(kills, before, 'no kill once the unit is gone');
  });

  test('#5 a registration whose answer was lost is not reconciled meanwhile; a launch decided before the confirmation is never started', async () => {
    const e = makeEnv('r1-5');
    const l = inProcessLedger(e);
    const cap = capturing();
    const s = newScheduler(e, {}, { units: cap.units });
    try {
      await s.start({ startLoops: false });
      const client = s.ledger.client as unknown as { call(m: string, p: unknown): Promise<unknown> };
      const real = client.call.bind(client);
      let drop = true;
      client.call = async (m, p) => {
        const r = await real(m, p);
        if (m === 'registerLaunch' && drop) {
          drop = false;
          throw new LedgerUnavailable('the answer was lost');
        }
        return r;
      };
      const t = await s.submitDurable(task(e, 'lost'));
      await s.tick(); // registered; the answer lost
      const launch = l.svc.openLaunches()[0]!.launch;
      assert.equal(cap.launched.length, 0);
      await s.tick(); // the reconciliation leaves it alone; the registration is confirmed and the unit started
      assert.equal(l.svc.dispositionFor(launch), null, 'not disposed while unconfirmed');
      assert.deepEqual(cap.launched.map((o) => o.config.launch), [launch]);
      assert.equal(t.current, launch);

      // the same, but the launch gets its final disposition before the confirmation
      drop = true;
      const u = await s.submitDurable(task(e, 'decided'));
      await s.tick();
      const second = l.svc.openLaunches().find((x) => x.launch !== launch)!.launch;
      await l.svc.dispose({ gen: s.gen, launch: second, disposition: 'cancelled', reason: 'decided elsewhere' });
      await s.tick();
      assert.ok(!cap.launched.some((o) => o.config.launch === second), 'a decided launch is never started');
      assert.notEqual(u.current, second);
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('#6 #7 after a restart: a finished dependency is restored from the ledger; a failed first read is retried before any dispatch', async () => {
    const e = makeEnv('r1-6');
    const l = inProcessLedger(e);
    const cap = capturing();
    const s1 = newScheduler(e, {}, { units: cap.units });
    const s2 = newScheduler(e, {}, { units: cap.units });
    try {
      await s1.start({ startLoops: false });
      await s1.submitDurable(task(e, 'A'));
      await s1.submitDurable(task(e, 'B', { dependsOn: ['A'] }));
      await acceptedLaunch(l, s1.gen, 'LA', 'A');
      s1.abandon();
      // the first read of the restarted scheduler fails
      const client = s2.ledger.client as unknown as { call(m: string, p: unknown): Promise<unknown> };
      const real = client.call.bind(client);
      let blip = true;
      client.call = async (m, p) => {
        if (m === 'missionBlocks' && blip) {
          blip = false;
          throw new LedgerUnavailable('a blip');
        }
        return real(m, p);
      };
      await s2.start({ startLoops: false });
      assert.equal(inside(s2).recovered, false);
      assert.equal(s2.tasks.get('B'), undefined, 'not rebuilt yet');
      await s2.tick();
      assert.equal(inside(s2).recovered, true);
      assert.equal(s2.tasks.get('A')?.state, 'done', 'A restored from the ledger');
      assert.equal(s2.tasks.get('B')?.state, 'running', 'B dispatched after A');
    } finally {
      await s2.close();
      await l.close();
    }
  });

  test('#8 an exhausted lineage is not dispatched under a new task id; a grant on another loop frees nothing', async () => {
    const e = makeEnv('r1-8');
    const l = inProcessLedger(e);
    const cap = capturing();
    const s = newScheduler(e, {}, { units: cap.units });
    try {
      await s.start({ startLoops: false });
      for (const op of ['f1', 'f2']) await l.svc.appendRecords({ op, gen: s.gen, records: [{ kind: 'loop.attempt', lineage: 'EX', loop: 'env-retry', failureClass: 'no-proof', signature: 'same' }] });
      assert.equal(l.svc.loopState('EX', 'env-retry').exhausted, true);
      const t = await s.submitDurable(task(e, 'replacement', { lineage: 'EX' }));
      await s.tick();
      assert.equal(t.state, 'exhausted');
      assert.equal(cap.launched.length, 0);
      assert.equal(s.cp.alerts().find((a) => a.category.startsWith('loop-exhausted'))?.wi, 'WI-08');
      const g = await s.grant({ op: 'g-rework', lineage: 'EX', loop: 'rework', by: 'user', extra: 1, reason: 'test' });
      assert.equal(g.granted, true);
      assert.equal(t.state, 'exhausted', 'env-retry is still exhausted');
      await s.grant({ op: 'g-env', lineage: 'EX', loop: 'env-retry', by: 'user', extra: 2, reason: 'test' });
      assert.equal(t.state, 'queued');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('#9 an acceptance that needs the derived state while the evaluator is in fault ends (WI-11); after the next publication it is registered again as a linked attempt', async () => {
    const e = makeEnv('r1-9');
    const l = inProcessLedger(e);
    const lists = { evidence: ['ev-1'], bases: ['b-1'], constraints: [] as string[], reliesOn: [] as string[] };
    const ev = { call: async () => ({ revision: Number(l.svc.publicationFloor()), result: { ok: true, merged: lists } }), close: () => undefined };
    const s = newScheduler(e, {}, { units: capturing().units, evaluatorQuery: ev });
    try {
      await s.start({ startLoops: false });
      inside(s).evaluatorFault = 'the evaluator is in its fault state';
      const c = l.svc.content;
      const j: JudgmentRecord = {
        kind: 'judgment',
        judgment: 'J1' as JudgmentId,
        review: 'reviewer',
        executor: 'reviewer',
        target: 'obj-1' as ObjectVersionId,
        verdict: 'pass',
        evidence: c.putList(lists.evidence),
        bases: c.putList(lists.bases),
        constraints: c.putList(lists.constraints),
        reliesOn: c.putList(lists.reliesOn),
        issues: [],
        revokes: null,
        evidenceUse: { fields: [], statisticalOrExternal: false },
        superseded: [],
        extends: 'J0' as JudgmentId,
      };
      const L = id<LaunchId>('LC');
      // a program unit (not a seat): the 7.1 checks need only its exit
      writeLaunchMeta(e.stateDir, { format: 'mp4.launch-meta.v1', launch: L, task: 'cont', lineage: 'L-cont', tag: { mission: M, capabilities: [] }, unitName: 'mp-unit-LC.service', seatUnit: false, heartbeat: false, gen: s.gen, dispatchedAt: Date.now(), timeoutMs: null, mode: 'stable' });
      await l.svc.registerLaunch({ op: 'reg-LC', gen: s.gen, launch: L, tag: { mission: M, capabilities: [] } });
      await l.svc.submitPendingResult({ op: 'res-LC', launch: L, records: [j] } as never);
      await l.svc.registerProof({ kind: 'termination.proof', launch: L, exit: { code: 0, signal: null }, controlOomKill: 0, unitOomKill: 0, unitOom: 0 } as never);
      await s.tick();
      assert.equal(l.svc.dispositionFor(L), null);
      assert.deepEqual(readEndedAcceptances(e.stateDir)['LC'], { ...readEndedAcceptances(e.stateDir)['LC']!, attempt: 1, retryOf: null, ended: true });
      assert.equal(s.cp.alerts().find((a) => a.category === 'acceptance-ended-derived-state')?.wi, 'WI-11');
      // the evaluator publishes again
      inside(s).evaluatorFault = null;
      inside(s).reregisterEndedAcceptances();
      assert.deepEqual([readEndedAcceptances(e.stateDir)['LC']?.attempt, readEndedAcceptances(e.stateDir)['LC']?.retryOf], [2, 1], 'a new attempt naming the ended one');
      await s.tick();
      assert.equal(l.svc.dispositionFor(L), 'accepted');
      assert.equal(readEndedAcceptances(e.stateDir)['LC'], undefined);
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('#10 continuing after evidence: a card with the session, its saved state and the evidence; the restored state reserved; without a session: WI-17', async () => {
    const e = makeEnv('r1-10');
    const l = inProcessLedger(e);
    const s = newScheduler(e, {}, { units: capturing().units });
    try {
      await s.start({ startLoops: false });
      const state = l.svc.content.put('saved state tree');
      const seatSpec = (name: string): TaskSpec => ({
        ...task(e, name),
        seat: {
          card: l.svc.content.put(JSON.stringify({ format: 'mp4.seat-card.v1', launch: 'template' })),
          demand: { hostBytes: 1, runPeakBytes: 1, runParallelism: 1, areaBytes: 1, enclosureBytes: 1, exportCaps: { maxLogicalBytes: 1, maxFiles: 1 }, recoveryState: { maxLogicalBytes: 1 << 20, maxFiles: 10 } },
        },
      });
      for (const [name, session] of [['explore', 'sess-1'], ['lost', null]] as const) {
        await s.submitDurable(seatSpec(name));
        const L = id<LaunchId>(`L-${name}`);
        const result = { kind: 'seat.result', launch: L, seat: 'constructor', status: 'needs-evidence', result: null, export: null, transcript: null, recoveryState: state, evidenceRequest: null } as BaseRecord;
        await acceptedLaunch(l, s.gen, `L-${name}`, name, [result]);
        if (session !== null) {
          mkdirSync(join(e.stateDir, 'units', L), { recursive: true });
          writeFileSync(join(e.stateDir, 'units', L, 'outcome.json'), JSON.stringify({ format: 'mp4.seat-host-outcome.v1', sessionId: session }));
        }
        const t = s.tasks.get(name)!;
        s.tasks.bindLaunch(t, L);
        t.state = 'waiting-evidence';
        assert.equal(await s.resumeAfterEvidence(name, `results for ${name}`), true);
      }
      const ok = s.tasks.get('explore')!.spec.seat!;
      assert.deepEqual(ok.resume, { sessionId: 'sess-1', state, evidence: 'results for explore' });
      assert.equal(ok.demand.resumesFromState, true, 'the restored copy is reserved');
      const lost = s.tasks.get('lost')!.spec.seat!;
      assert.equal(lost.resume?.state, null, 'no session: a new one, with the evidence');
      assert.equal(lost.demand.resumesFromState, false);
      assert.equal(s.cp.alerts().find((a) => a.category === 'recovery-state-missing')?.wi, 'WI-17');
      // the continuation card is what the ledger's queue holds
      await waitFor(() => l.svc.taskInfo('explore')?.state === 'queued', 5_000, 'queued again');
      const card = JSON.parse(l.svc.content.get(l.svc.taskInfo('explore')!.card).toString('utf8')) as { spec: TaskSpec };
      assert.equal(card.spec.seat?.resume?.sessionId, 'sess-1');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('#11 a seat preparation that never reached the ledger is released by its recorded identities; an unrecorded one is reported (WI-20)', async () => {
    const e = makeEnv('r1-11');
    const l = inProcessLedger(e);
    const s = newScheduler(e, {}, { units: capturing().units });
    try {
      const seats = join(e.stateDir, 'seats');
      const dir = join(seats, 'orphan');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'area.img'), 'allocated image stand-in');
      const policy = { roots: [seats] };
      writePrepared(e.stateDir, {
        format: 'mp4.prepared-launch.v1',
        launch: id<LaunchId>('orphan'),
        resources: [...recordIdentities([formatCleanupResource({ kind: 'image', path: join(dir, 'area.img') })], policy), ...recordIdentities([formatCleanupResource({ kind: 'path', path: dir })], policy)],
        demand: { memoryBytes: 1, diskBytes: 100, inodes: 1 },
        at: Date.now(),
      });
      mkdirSync(join(seats, 'unrecorded'), { recursive: true });
      await s.start({ startLoops: false });
      assert.equal(existsSync(dir), false, 'released at start');
      assert.equal(readPrepared(e.stateDir).length, 0);
      assert.equal(existsSync(join(seats, 'unrecorded')), true, 'never deleted without its identity');
      assert.equal(s.cp.alerts().find((a) => a.category === 'seat-dir-unrecorded')?.wi, 'WI-20');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('#12 storage-fault restarts stay within the hourly bound, and their count survives a watchdog restart', async () => {
    const e = makeEnv('r1-12');
    let now = 1_000_000;
    const opts = {
      controlPlane: e.cp,
      stateDir: e.stateDir,
      now: () => now,
      ledger: { argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], heartbeatPath: join(e.cp, 'l') },
      scheduler: { argv: ['unused'], heartbeatPath: join(e.cp, 's') },
      units: systemUnits,
    };
    const wd = new Watchdog(opts);
    type W = { proc(n: string): { state: string; exited: boolean; faultSince: number | null; faultRestarts: number; child: { kill(s: string): void } | null }; records: Record<string, { times: number[] }>; checkLedger(): Promise<void>; saveRecords(): boolean };
    const w = wd as unknown as W;
    const ledger = w.proc('ledger');
    ledger.state = 'running';
    ledger.exited = true;
    ledger.faultSince = now - 10;
    w.records['ledger']!.times = [now - 50, now - 40, now - 30, now - 20, now - 10];
    await w.checkLedger();
    assert.equal(wd.restartCount('ledger'), 5, 'no sixth restart in the hour');
    ledger.faultRestarts = 2;
    w.saveRecords();
    const again = new Watchdog(opts);
    assert.equal(again.faultRestarts(), 2, 'the storage-fault count is persisted');
    ledger.child?.kill('SIGKILL');
  });

  test('#13 the shutdown has one deadline: a child that never reports its exit does not hold it', async () => {
    const e = makeEnv('r1-13');
    const stuck = new EventEmitter() as EventEmitter & { kill(s: string): boolean };
    const signals: string[] = [];
    stuck.kill = (sig: string) => {
      signals.push(sig);
      return true;
    };
    const wd = new Watchdog({ controlPlane: e.cp, stateDir: e.stateDir, ledger: { argv: ['unused'], heartbeatPath: 'unused' }, scheduler: { argv: ['unused'], heartbeatPath: 'unused' }, shutdownMs: 100, units: systemUnits });
    const p = (wd as unknown as { proc(n: string): { child: unknown; exited: boolean } }).proc('scheduler');
    p.child = stuck;
    p.exited = false;
    const t0 = Date.now();
    const clean = await Promise.race([wd.stop(50), new Promise<string>((r) => setTimeout(() => r('still waiting'), 2_000))]);
    assert.equal(clean, false, 'returned, not clean');
    assert.ok(Date.now() - t0 < 1_000);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  });
});
