// Shared fixtures for the scheduler tests and the §14 scenarios (helpers only, no tests).
// Everything lives under os.tmpdir() (a Linux filesystem), never under /mnt; every unit a
// test starts is killed and its cgroup removed at the end.

import { fork, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { id, type LaunchId, type MissionId } from '../src/common/ids.ts';
import { detectExecCapabilities } from '../src/exec/platform.ts';
import { killUnit, unitActiveState } from '../src/exec/supervisor.ts';
import { serveLedger } from '../src/ledger/ipc.ts';
import { LedgerService, ledgerPaths, type ServiceOptions } from '../src/ledger/service.ts';
import { allLaunchMeta } from '../src/scheduler/launches.ts';
import { Scheduler, type SchedulerDeps, type SchedulerOptions } from '../src/scheduler/scheduler.ts';
import type { TaskSpec, UnitSpec } from '../src/scheduler/tasks.ts';
import { derivedUnitCgroupPath } from '../src/scheduler/units.ts';
import { Cgroup } from '../src/exec/cgroup.ts';
import { RpcClient } from '../src/common/rpc.ts';
import { checkSocketPath } from '../src/common/socketPath.ts';
import { Watchdog, type ProbeSpec, type WatchdogOptions } from '../src/scheduler/watchdog.ts';

export const HOST_TS = fileURLToPath(new URL('./scheduler-fixture-host.ts', import.meta.url));
export const LEDGER_FIXTURE_TS = fileURLToPath(new URL('./scheduler-fixture-ledger.ts', import.meta.url));
export const INJECT_MJS = fileURLToPath(new URL('./scheduler-fixture-inject.mjs', import.meta.url));
export const SCHEDULER_MAIN_TS = fileURLToPath(new URL('../src/scheduler/main.ts', import.meta.url));
export const NODE_ARGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

const caps = detectExecCapabilities();
export const canRunUnits = caps.systemdRun !== null && caps.delegatedControllers.includes('memory') && caps.delegatedControllers.includes('pids');
export const unitSkip: false | string = canRunUnits ? false : 'needs systemd-run --user with delegated memory and pids controllers';

export const M = id<MissionId>('mission-s');

export interface Env {
  readonly root: string;
  readonly ledgerRoot: string;
  readonly cp: string;
  readonly stateDir: string;
  readonly socket: string;
  readonly scratch: string;
  readonly jobs: string;
}

const envs: Env[] = [];

export function makeEnv(prefix: string): Env {
  const root = mkdtempSync(join(tmpdir(), `mp-sched-${prefix}-`));
  // every socket the suites put under root must fit (107 bytes): fail loudly, never collide on truncated paths
  for (const name of ['ledger.sock', 'scheduler.sock', 'evaluator.sock', 'proxy.sock']) checkSocketPath(join(root, name), `set a shorter TMPDIR (e.g. mktemp -d /tmp/mpc.XXXX); TMPDIR=${tmpdir()}`);
  const e: Env = {
    root,
    ledgerRoot: join(root, 'ledger'),
    cp: join(root, 'cp'),
    stateDir: join(root, 'state'),
    socket: join(root, 'ledger.sock'),
    scratch: join(root, 'scratch'),
    jobs: join(root, 'jobs'),
  };
  for (const d of [e.cp, e.stateDir, e.scratch, e.jobs]) mkdirSync(d, { recursive: true });
  envs.push(e);
  return e;
}

/** Kill every unit the tests started under these envs and remove their directories. */
export async function cleanupEnvs(): Promise<void> {
  for (const e of envs.splice(0)) {
    for (const m of allLaunchMeta(e.stateDir)) await killUnitAndCgroup(m.unitName);
    try {
      chmodSync(e.scratch, 0o755);
    } catch {
      /* gone */
    }
    rmSync(e.root, { recursive: true, force: true });
  }
}

export async function killUnitAndCgroup(unitName: string): Promise<void> {
  await killUnit(unitName);
  try {
    await Cgroup.at(derivedUnitCgroupPath(unitName)).destroy(5_000);
  } catch {
    /* gone */
  }
}

// ---------------------------------------------------------------- ledger: in process or as its own process

export interface InProcessLedger {
  readonly svc: LedgerService;
  readonly server: Server;
  close(): Promise<void>;
}

export function inProcessLedger(e: Env, opts: Partial<ServiceOptions> = {}): InProcessLedger {
  const svc = new LedgerService({ paths: ledgerPaths(e.ledgerRoot, e.cp), ...opts });
  svc.open();
  const server = serveLedger(svc, e.socket);
  const conns = new Set<import('node:net').Socket>();
  server.on('connection', (c) => {
    conns.add(c);
    c.on('close', () => conns.delete(c));
  });
  return {
    svc,
    server,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => {
          svc.close();
          r();
        });
        // connections of processes that outlive the test (supervisors, abandoned schedulers)
        for (const c of conns) c.destroy();
      }),
  };
}

export interface LedgerProcOptions {
  readonly faultFile?: string;
  readonly hangFile?: string;
  readonly bootIdFile?: string;
  readonly heartbeatMs?: number;
}

/** The ledger fixture as its own process (fault injection; see scheduler-fixture-ledger.ts). */
export class LedgerProc {
  readonly env: Env;
  readonly configPath: string;
  child: ChildProcess | null = null;
  ready: { recoveryPause: boolean; stopsCommitted: string[] } | null = null;

  constructor(e: Env, o: LedgerProcOptions = {}) {
    this.env = e;
    this.configPath = join(e.root, 'ledger-config.json');
    writeFileSync(this.configPath, JSON.stringify({ root: e.ledgerRoot, controlPlane: e.cp, socket: e.socket, heartbeatMs: o.heartbeatMs ?? 200, ...o }));
  }

  get argv(): string[] {
    return [process.execPath, ...NODE_ARGS, LEDGER_FIXTURE_TS, this.configPath];
  }

  async start(): Promise<void> {
    const child = fork(LEDGER_FIXTURE_TS, [this.configPath], { execArgv: NODE_ARGS, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    this.child = child;
    this.ready = await new Promise((resolve, reject) => {
      child.once('message', (m) => resolve(m as { recoveryPause: boolean; stopsCommitted: string[] }));
      child.once('exit', (c) => reject(new Error(`ledger fixture exited ${c}`)));
    });
  }

  get pid(): number {
    return this.child?.pid ?? -1;
  }

  async kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    const c = this.child;
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    const exited = new Promise<void>((r) => c.once('exit', () => r()));
    c.kill(signal);
    await exited;
  }
}

// ---------------------------------------------------------------- tasks running the test host

export interface HostJob {
  readonly heartbeatMs?: number;
  readonly goFile?: string;
  readonly submit?: 'end' | 'sigterm' | 'none';
  readonly seat?: boolean;
  readonly seatStatus?: string;
  readonly records?: readonly unknown[];
  readonly exitCode?: number;
  readonly pidDir?: string;
}

export interface TaskOptions {
  readonly task: string;
  readonly lineage?: string;
  readonly mission?: MissionId;
  readonly capabilities?: readonly string[];
  readonly priority?: number;
  readonly dependsOn?: readonly string[];
  readonly paid?: boolean;
  readonly estimateMicros?: number;
  readonly memoryBytes?: number;
  readonly job?: HostJob;
  readonly unit?: Partial<UnitSpec>;
  readonly mode?: 'stable' | 'fast';
  readonly binds?: readonly string[];
  readonly snapshot?: { repo: string; commit: string };
}

export function hostTask(e: Env, o: TaskOptions): TaskSpec {
  const jobPath = join(e.jobs, `${o.task}.json`);
  writeFileSync(jobPath, JSON.stringify({ controlPlane: e.cp, ledgerSocket: e.socket, ...(o.job ?? {}) }));
  const seat = o.job?.seat ?? false;
  return {
    task: o.task,
    lineage: o.lineage ?? `lineage-${o.task}`,
    mission: o.mission ?? M,
    capabilities: o.capabilities ?? [],
    priority: o.priority ?? 0,
    dependsOn: o.dependsOn ?? [],
    paid: o.paid ?? false,
    estimateMicros: o.estimateMicros ?? 0,
    demand: { memoryBytes: o.memoryBytes ?? 64 * 1024 * 1024, diskBytes: 1024 * 1024, inodes: 10 },
    mode: o.mode ?? 'stable',
    ...(o.binds !== undefined ? { binds: o.binds } : {}),
    ...(o.snapshot !== undefined ? { snapshot: o.snapshot } : {}),
    unit: {
      host: { argv: [process.execPath, ...NODE_ARGS, HOST_TS, jobPath], env: { PATH: '/usr/bin:/bin' }, cwd: e.root, stdoutPath: join(e.root, `${o.task}.out`), stderrPath: join(e.root, `${o.task}.err`) },
      limits: { memoryMax: 256 * 1024 * 1024, pidsMax: 64 },
      seatUnit: seat,
      heartbeat: (o.job?.heartbeatMs ?? 200) > 0,
      stopGraceMs: 3_000,
      proofRetry: { initialDelayMs: 100, maxDelayMs: 500, totalMs: 3_000, attemptTimeoutMs: 3_000 },
      ...(o.unit ?? {}),
    },
  };
}

/** A node "binary" that preloads the injection hook (scheduler-fixture-inject.mjs). */
export function nodeWithHook(e: Env): string {
  const p = join(e.root, 'node-with-hook.sh');
  writeFileSync(p, `#!/bin/sh\nexec ${process.execPath} --import ${INJECT_MJS} "$@"\n`, { mode: 0o755 });
  return p;
}

/** Ask the hook to kill or pause the supervisor of `launch` at `point`. */
export function inject(e: Env, launch: LaunchId, point: 'before-tmp' | 'after-tmp' | 'after-rename' | 'after-dirsync', mode: 'kill' | 'pause'): void {
  mkdirSync(join(e.stateDir, 'inject'), { recursive: true });
  writeFileSync(join(e.stateDir, 'inject', `${launch}.json`), JSON.stringify({ point, mode }));
}

export function schedulerOptions(e: Env, o: Partial<SchedulerOptions> = {}): SchedulerOptions {
  return {
    ledgerSocket: e.socket,
    ledgerRoot: e.ledgerRoot,
    controlPlane: e.cp,
    stateDir: e.stateDir,
    scratchRoots: [e.scratch],
    tickMs: 250,
    stopPollMs: 100,
    heartbeatMs: 250,
    admission: { memoryReserveBytes: 0, diskReserveBytes: 0, inodeReserve: 0 },
    takeover: { proofPendingLimitMs: 4_000, heartbeatTimeoutMs: 5_000, startGraceMs: 10_000, proofGraceMs: 2_000, killWaitMs: 5_000 },
    stops: { stopTimeoutMs: 5_000, unkillableAfterMs: 2_000 },
    cleanup: { initialBackoffMs: 100, maxBackoffMs: 500, alertAfter: 3, alertEvery: 10 },
    log: (l) => process.stderr.write(`${l}\n`),
    ...o,
  };
}

export function newScheduler(e: Env, o: Partial<SchedulerOptions> = {}, deps: SchedulerDeps = {}): Scheduler {
  return new Scheduler(schedulerOptions(e, o), deps);
}

export async function waitFor<T>(fn: () => T | Promise<T>, ms: number, what: string, every = 50): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  for (;;) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined && v !== false) return v as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

export async function unitInactive(unitName: string): Promise<boolean> {
  const s = await unitActiveState(unitName);
  return s === 'inactive' || s === 'failed';
}

export function readJson<T>(p: string): T | null {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;
  } catch {
    return null;
  }
}

export function touch(p: string): void {
  writeFileSync(p, '');
}

// ---------------------------------------------------------------- the whole system under the watchdog

export interface Watched {
  readonly w: Watchdog;
  readonly rpc: RpcClient;
  readonly lp: LedgerProc;
  readonly schedulerConfigPath: string;
  close(): Promise<void>;
}

/** Ledger fixture and scheduler process, both supervised by an (in-process) watchdog. */
export async function startWatched(
  e: Env,
  ledgerOpts: LedgerProcOptions = {},
  wd: Partial<WatchdogOptions> = {},
  sched: Partial<SchedulerOptions> = {},
): Promise<Watched> {
  const lp = new LedgerProc(e, ledgerOpts);
  const rpcSocket = join(e.root, 'scheduler.sock');
  const { log: _log, ...opts } = schedulerOptions(e, sched);
  const schedulerConfigPath = join(e.root, 'scheduler-config.json');
  writeFileSync(schedulerConfigPath, JSON.stringify({ ...opts, rpcSocket }));
  const w = new Watchdog(watchdogOptions(e, lp, schedulerConfigPath, wd));
  await w.start();
  const rpc = new RpcClient(rpcSocket, 10_000);
  await waitFor(async () => ((await rpc.call('ping', {})) as { started: boolean }).started, 30_000, 'scheduler process started');
  return {
    w,
    rpc,
    lp,
    schedulerConfigPath,
    close: async () => {
      rpc.close();
      await w.stop(5_000);
    },
  };
}

export const PROBE_MAIN_TS = fileURLToPath(new URL('../src/ledger/probe-main.ts', import.meta.url));

/** The primary inbox probe of an env (v45 6.1), as the watchdog starts it. */
export function probeSpec(e: Env, boot?: string): ProbeSpec {
  return {
    inbox: 'primary',
    file: ledgerPaths(e.ledgerRoot, e.cp).inbox,
    other: null,
    intervalMs: 300,
    staleMs: 3_000,
    shutdownMs: 10_000,
    ...(boot !== undefined ? { boot } : {}),
    node: [process.execPath, ...NODE_ARGS],
    heartbeatTimeoutMs: 5_000,
    startGraceMs: 10_000,
    logPath: join(e.root, 'probe.log'),
  };
}

/** The watchdog's options for an env (fast restart policy for tests). */
export function watchdogOptions(e: Env, lp: LedgerProc, schedulerConfigPath: string, wd: Partial<WatchdogOptions> = {}): WatchdogOptions {
  return {
    controlPlane: e.cp,
    stateDir: e.stateDir,
    ledger: { argv: lp.argv, heartbeatPath: join(e.cp, 'ledger.heartbeat'), heartbeatTimeoutMs: 1_500, startGraceMs: 10_000, logPath: join(e.root, 'ledger.log') },
    scheduler: { argv: [process.execPath, ...NODE_ARGS, SCHEDULER_MAIN_TS, schedulerConfigPath], heartbeatPath: join(e.cp, 'scheduler.heartbeat'), heartbeatTimeoutMs: 3_000, startGraceMs: 20_000, logPath: join(e.root, 'scheduler.log') },
    ledgerSocket: e.socket,
    ledgerContentRoot: join(e.ledgerRoot, 'content'),
    stopInbox: ledgerPaths(e.ledgerRoot, e.cp).inbox,
    checkMs: 200,
    restart: { initialBackoffMs: 100, maxBackoffMs: 1_000, maxPerWindow: 5, windowMs: 3_600_000, healthyResetMs: 3_600_000 },
    storageFault: { maxRestarts: 3, backoffMs: [1_000, 1_000, 1_000], healthyResetMs: 3_000 },
    faultAlertEveryMs: 1_000,
    killWaitMs: 3_000,
    stopTimeoutMs: 3_000,
    ...wd,
  };
}

/** The scheduler process's configuration file for an env (no log function: JSON). */
export function writeSchedulerConfig(e: Env, sched: Partial<SchedulerOptions> = {}): string {
  const rpcSocket = join(e.root, 'scheduler.sock');
  const { log: _log, ...opts } = schedulerOptions(e, sched);
  const path = join(e.root, 'scheduler-config.json');
  writeFileSync(path, JSON.stringify({ ...opts, rpcSocket }));
  return path;
}

export interface TaskView {
  readonly task: string;
  readonly state: string;
  readonly note: string | null;
  readonly launches: string[];
}

export async function rpcTask(rpc: RpcClient, task: string): Promise<TaskView | undefined> {
  const all = (await rpc.call('tasks', {})) as TaskView[];
  return all.find((t) => t.task === task);
}
