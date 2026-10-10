// The watchdog (design 6.3 "监督", "重启的上限", "启动时机", 6.1 storage fault; WI-12, WI-22):
// restarts on a lost heartbeat or an exit, each with a WI-22 notice; at most 5 restarts per
// service per hour (counts in the state directory), then "restart-exhausted" with one merged
// notice, one PM retry per episode, the count cleared after healthy running; a ledger in
// storage fault is restarted at most 3 times (the stricter case); while the scheduler is away
// the watchdog itself ends the units in a stop's scope; ensureRunning starts the engine when
// the PM opens, once. Real processes: the ledger service (fixture with fault injection), the
// scheduler process, the watchdog process.

import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { id, type Generation, type LaunchId, type MissionId, type StopId } from '../src/common/ids.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { sendStop } from '../src/ledger/stops.ts';
import { ControlPlane } from '../src/scheduler/controlPlane.ts';
import { engineState, ensureRunning } from '../src/scheduler/engine.ts';
import type { UnitControl } from '../src/scheduler/units.ts';
import { DEFAULT_RESTART_POLICY, Watchdog, requestRetry } from '../src/scheduler/watchdog.ts';
import { cleanupEnvs, LedgerProc, M, makeEnv, NODE_ARGS, SCHEDULER_MAIN_TS, schedulerOptions, startWatched, waitFor, watchdogOptions, writeSchedulerConfig } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

const WATCHDOG_MAIN = fileURLToPath(new URL('../src/scheduler/watchdog-main.ts', import.meta.url));
const ENSURE_MAIN = fileURLToPath(new URL('../src/scheduler/ensure-running-main.ts', import.meta.url));

describe('watchdog', { timeout: 180_000 }, () => {
  test('a scheduler whose heartbeat stops (SIGSTOP) is killed and restarted as a new generation, with a notice', async () => {
    const e = makeEnv('wd-sched');
    const sys = await startWatched(e);
    try {
      const g1 = ((await sys.rpc.call('ping', {})) as { gen: number }).gen;
      const pid = sys.w.pidOf('scheduler')!;
      process.kill(pid, 'SIGSTOP');
      await waitFor(() => sys.w.pidOf('scheduler') !== pid, 20_000, 'scheduler restarted');
      sys.rpc.close();
      const g2 = await waitFor(async () => {
        try {
          const p = (await sys.rpc.call('ping', {})) as { gen: number; started: boolean };
          return p.started && p.gen > g1 ? p.gen : null;
        } catch {
          return null;
        }
      }, 30_000, 'a new generation');
      assert.equal(g2, g1 + 1);
      const cp = new ControlPlane(e.cp);
      const n = cp.alerts().find((a) => a.category === 'service-restarted' && (a.detail as { service: string }).service === 'scheduler');
      assert.equal(n?.wi, 'WI-22');
      assert.match(String(n?.trigger), /heartbeat lost/);
    } finally {
      await sys.close();
    }
  });

  test('a ledger service that dies is started again, with a notice', async () => {
    const e = makeEnv('wd-ledger');
    const sys = await startWatched(e);
    try {
      const pid = sys.w.pidOf('ledger')!;
      process.kill(pid, 'SIGKILL');
      await waitFor(() => sys.w.pidOf('ledger') !== pid && sys.w.stateOf('ledger') === 'running', 20_000, 'ledger restarted');
      await waitFor(() => new ControlPlane(e.cp).alerts().some((a) => a.category === 'service-restarted' && a.wi === 'WI-22' && /exited/.test(String(a.trigger))), 10_000, 'WI-22 notice');
      // the scheduler keeps working against the new service
      await waitFor(async () => ((await sys.rpc.call('ping', {})) as { started: boolean }).started, 10_000, 'scheduler alive');
    } finally {
      await sys.close();
    }
  });

  test('a storage fault that does not clear: 3 restarts with back-off, then the fault is kept and the notice repeats (WI-12)', async () => {
    const e = makeEnv('wd-fault');
    const fault = join(e.root, 'fault');
    const sys = await startWatched(e, { faultFile: fault }, { storageFault: { maxRestarts: 3, backoffMs: [300, 300, 300], healthyResetMs: 3_000 }, faultAlertEveryMs: 500 });
    try {
      writeFileSync(fault, '');
      await waitFor(() => sys.w.stateOf('ledger') === 'fault-held', 30_000, 'fault held');
      assert.equal(sys.w.faultRestarts(), 3);
      const restartsAtHold = sys.w.restartsOf('ledger');
      const cp = new ControlPlane(e.cp);
      const held = () => cp.alerts().filter((a) => a.category === 'ledger-storage-fault-held');
      await waitFor(() => held().length >= 3, 10_000, 'repeated notices');
      assert.ok(held().every((a) => a.wi === 'WI-12'));
      assert.equal(sys.w.restartsOf('ledger'), restartsAtHold, 'no more restarts while held');
      const status = JSON.parse(readFileSync(join(e.cp, 'watchdog.json'), 'utf8')) as { processes: Array<{ name: string; state: string }> };
      assert.equal(status.processes.find((p) => p.name === 'ledger')?.state, 'fault-held');
    } finally {
      await sys.close();
    }
  });

  test('watchdog-main runs as a plain process and stops both managed processes on SIGTERM', async () => {
    const e = makeEnv('wd-main');
    const lp = new LedgerProc(e);
    const { log: _l, ...opts } = schedulerOptions(e);
    const schedCfg = join(e.root, 'sched.json');
    writeFileSync(schedCfg, JSON.stringify(opts));
    const cfgPath = join(e.root, 'watchdog.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        controlPlane: e.cp,
        stateDir: e.stateDir,
        ledger: { argv: lp.argv, heartbeatPath: join(e.cp, 'ledger.heartbeat'), heartbeatTimeoutMs: 2_000 },
        scheduler: { argv: [process.execPath, ...NODE_ARGS, SCHEDULER_MAIN_TS, schedCfg], heartbeatPath: join(e.cp, 'scheduler.heartbeat'), heartbeatTimeoutMs: 3_000 },
        checkMs: 200,
      }),
    );
    const w = fork(WATCHDOG_MAIN, [cfgPath], { execArgv: NODE_ARGS, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    try {
      await new Promise<void>((resolve, reject) => {
        w.once('message', () => resolve());
        w.once('exit', (c) => reject(new Error(`watchdog exited ${c}`)));
      });
      const cp = new ControlPlane(e.cp);
      const sched = await waitFor(() => cp.readSchedulerHeartbeat()?.gen, 30_000, 'scheduler heartbeat with a generation');
      assert.equal(sched, 1);
      const ledgerPid = cp.readLedgerHeartbeat()!.pid;
      const schedPid = cp.readSchedulerHeartbeat()!.pid;
      const exited = new Promise<number | null>((r) => w.once('exit', (c) => r(c)));
      w.kill('SIGTERM');
      assert.equal(await exited, 0);
      for (const pid of [ledgerPid, schedPid]) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        assert.equal(alive, false, `process ${pid} stopped`);
      }
    } finally {
      if (w.exitCode === null) w.kill('SIGKILL');
    }
  });
});

describe('watchdog: the restart bound (v45 6.3, WI-22)', { timeout: 180_000 }, () => {
  test('a service that keeps dying: back-off restarts, at most 5 an hour, then restart-exhausted with one merged notice; the count survives a watchdog restart; one PM retry per episode, then the user', async () => {
    const e = makeEnv('wd-bound');
    const lp = new LedgerProc(e);
    const bad = join(e.root, 'missing-config.json'); // the scheduler exits at once on every start
    const o = watchdogOptions(e, lp, bad);
    const w = new Watchdog(o);
    let w2: Watchdog | null = null;
    try {
      assert.deepEqual(
        { per: DEFAULT_RESTART_POLICY.maxPerWindow, window: DEFAULT_RESTART_POLICY.windowMs, first: DEFAULT_RESTART_POLICY.initialBackoffMs, max: DEFAULT_RESTART_POLICY.maxBackoffMs, healthy: DEFAULT_RESTART_POLICY.healthyResetMs },
        { per: 5, window: 3_600_000, first: 1_000, max: 300_000, healthy: 3_600_000 },
      );
      await w.start();
      await waitFor(() => w.stateOf('scheduler') === 'restart-exhausted', 30_000, 'restart-exhausted');
      assert.equal(w.restartCount('scheduler'), 5);
      assert.equal(w.restartsOf('scheduler'), 5);
      const cp = new ControlPlane(e.cp);
      const restarted = cp.alerts().filter((a) => a.category === 'service-restarted');
      assert.equal(restarted.length, 5);
      assert.ok(restarted.every((a) => a.wi === 'WI-22'));
      const exhausted = () => cp.alerts().filter((a) => a.category === 'service-restart-exhausted');
      assert.equal(exhausted().length, 1, 'one merged notice for the episode');
      assert.equal(exhausted()[0]?.wi, 'WI-22');
      // back-off doubled between restarts
      const backoffs = w.events.filter((x) => x.name === 'scheduler' && x.event === 'backoff').map((x) => (x.detail as { delayMs: number }).delayMs);
      assert.deepEqual(backoffs.slice(0, 5), [100, 200, 400, 800, 1_000]);
      // the ledger is not affected
      assert.equal(w.stateOf('ledger'), 'running');
      await w.stop(5_000);
      // a new watchdog keeps the episode (the count is in the state directory, not the ledger)
      w2 = new Watchdog(o);
      await w2.start();
      assert.equal(w2.stateOf('scheduler'), 'restart-exhausted');
      // the PM retries once: the count is cleared, the service is started again (and dies again)
      requestRetry(e.cp, 'scheduler', 'pm');
      await waitFor(() => w2!.events.some((x) => x.event === 'retry'), 10_000, 'retry taken');
      await waitFor(() => w2!.stateOf('scheduler') === 'restart-exhausted' && w2!.restartsOf('scheduler') >= 5, 30_000, 'exhausted again');
      assert.equal(exhausted().length, 1, 'still the one merged notice: the episode goes on');
      assert.deepEqual(await w2.retry('scheduler', 'pm'), { retried: false, why: 'the PM already retried in this episode; the user decides' });
      assert.ok(cp.alerts().some((a) => a.category === 'service-retry-refused' && a.wi === 'WI-22'));
      assert.deepEqual(await w2.retry('scheduler', 'user'), { retried: true });
    } finally {
      await w.stop(5_000);
      await w2?.stop(5_000);
    }
  });

  test('healthy running clears the count', async () => {
    const e = makeEnv('wd-healthy');
    const sys = await startWatched(e, {}, { restart: { initialBackoffMs: 100, maxBackoffMs: 1_000, maxPerWindow: 5, windowMs: 3_600_000, healthyResetMs: 2_000 } });
    try {
      const pid = sys.w.pidOf('scheduler')!;
      process.kill(pid, 'SIGKILL');
      await waitFor(() => sys.w.pidOf('scheduler') !== pid && sys.w.stateOf('scheduler') === 'running', 30_000, 'restarted');
      assert.equal(sys.w.restartCount('scheduler'), 1);
      await waitFor(() => sys.w.restartCount('scheduler') === 0, 15_000, 'cleared after healthy running');
      assert.ok(sys.w.events.some((x) => x.name === 'scheduler' && x.event === 'restart-count-cleared'));
    } finally {
      await sys.close();
    }
  });

  test('while the scheduler is away (restart-exhausted), the watchdog ends the units in a stop\'s scope from the host list', async () => {
    const e = makeEnv('wd-stops');
    const lp = new LedgerProc(e);
    const calls: string[] = [];
    const units: UnitControl = {
      launch: async () => {
        throw new Error('not used');
      },
      stop: async (name) => void calls.push(`stop:${name}`),
      kill: async (name) => void calls.push(`kill:${name}`),
      activeState: async () => 'active',
    };
    const o = watchdogOptions(e, lp, join(e.root, 'missing-config.json'), { units, stopTimeoutMs: 500, restart: { initialBackoffMs: 50, maxBackoffMs: 100, maxPerWindow: 1, windowMs: 3_600_000, healthyResetMs: 3_600_000 } });
    const w = new Watchdog(o);
    const cp = new ControlPlane(e.cp);
    try {
      cp.putHost({ format: 'mp4.host-entry.v1', launch: id<LaunchId>('L-left'), tag: { mission: M, capabilities: [] }, unitName: 'mp-unit-L-left.service', task: 't', lineage: 'l', seatUnit: true, heartbeat: true, gen: 1 as Generation, at: Date.now() });
      cp.putHost({ format: 'mp4.host-entry.v1', launch: id<LaunchId>('L-other'), tag: { mission: id<MissionId>('m-other'), capabilities: [] }, unitName: 'mp-unit-L-other.service', task: 't2', lineage: 'l2', seatUnit: true, heartbeat: true, gen: 1 as Generation, at: Date.now() });
      await w.start();
      await waitFor(() => w.stateOf('scheduler') === 'restart-exhausted', 20_000, 'scheduler away');
      sendStop({ inbox: ledgerPaths(e.ledgerRoot, e.cp).inbox, controlPlane: e.cp }, { stop: id<StopId>('stop-away'), scope: { kind: 'mission', mission: M }, words: '停', at: Date.now() });
      await waitFor(() => calls.includes('kill:mp-unit-L-left.service'), 10_000, 'stopped, then killed');
      assert.deepEqual(calls, ['stop:mp-unit-L-left.service', 'kill:mp-unit-L-left.service'], 'only the unit in scope');
      assert.deepEqual(w.endedUnits(), ['L-left']);
    } finally {
      await w.stop(5_000);
    }
  });
});

describe('engine start when the PM opens (v45 6.3 "启动时机")', { timeout: 180_000 }, () => {
  test('ensureRunning starts the watchdog once (two PM sessions at once), then does nothing; the CLI entry reports it', async () => {
    const e = makeEnv('ensure');
    const lp = new LedgerProc(e);
    const schedCfg = writeSchedulerConfig(e);
    const wdCfg = join(e.root, 'watchdog.json');
    writeFileSync(wdCfg, JSON.stringify(watchdogOptions(e, lp, schedCfg)));
    const engineCfg = { watchdogConfig: wdCfg, startTimeoutMs: 60_000, logPath: join(e.root, 'watchdog.log') };
    let pid: number | null = null;
    try {
      const [r1, r2] = await Promise.all([ensureRunning(engineCfg), ensureRunning(engineCfg)]);
      assert.equal([r1, r2].filter((r) => r.started).length, 1, 'exactly one start');
      assert.equal(r1.watchdogPid, r2.watchdogPid);
      pid = r1.watchdogPid;
      assert.ok(r1.ledgerBeating && r1.schedulerBeating);
      const cfgPath = join(e.root, 'engine.json');
      writeFileSync(cfgPath, JSON.stringify(engineCfg));
      const cli = spawnSync(process.execPath, [...NODE_ARGS, ENSURE_MAIN, cfgPath], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(cli.status, 0);
      const out = JSON.parse(cli.stdout.trim()) as { started: boolean; running: boolean; watchdogPid: number };
      assert.deepEqual([out.started, out.running, out.watchdogPid], [false, true, pid], 'already running: nothing done');
      assert.equal(engineState(engineCfg).running, true);
    } finally {
      if (pid !== null) {
        process.kill(pid, 'SIGTERM');
        await waitFor(() => !engineState(engineCfg).running && !isAlive(pid!), 30_000, 'the engine stopped');
      }
    }
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
