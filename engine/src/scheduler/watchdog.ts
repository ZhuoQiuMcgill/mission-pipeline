// The watchdog (design 6.3 "监督" and "重启的上限", 6.1 "存储故障"; WI-12, WI-22): a small process
// manager that keeps the ledger service and the scheduler running, by heartbeat. In
// production it runs as a user service; here it is a plain process (the systemd unit files are
// out of scope). It is started when the user opens the PM (engine.ts ensureRunning), never at boot.
//
//  - Each managed process writes a heartbeat file to the control plane. A heartbeat older than
//    its timeout (the process is stuck: its event loop no longer runs), or one from another
//    pid, means the process is killed (SIGKILL) and started again; an exit is restarted too.
//    Every restart is a WI-22 notice.
//  - Restarts are bounded (v45 6.3): the counts live in the state directory, not the ledger
//    (the ledger may be the one failing); back-off from 1 s doubling to 5 minutes; at most 5
//    restarts per service per hour. Beyond that the service is "restart-exhausted": no more
//    restarts, one merged WI-22 notice for the whole episode, kept on display. An hour of
//    healthy running clears the count; the PM may retry once per exhaustion episode (the
//    count is cleared); after that only the user decides.
//  - A ledger whose heartbeat reports a storage fault is restarted with back-off, at most 3
//    times per fault episode (a restart re-opens the storage and commits the inbox's stops
//    first): the stricter special case. After that it is kept in its fault state with
//    continuous WI-12 notices. A ledger process that does not die after SIGKILL still holds the
//    writer lock: handled as a storage fault too.
//  - While the scheduler is down or restart-exhausted, the watchdog itself ends the processes in
//    the scope of a stop (committed, or in force through the spool) from the control-plane
//    host list (6.3: stops never depend on the scheduler being there).
//  - The inbox probes (v45 6.1 "收件箱探针") are started first and supervised like the others.
//    A clean stop is the v45 shutdown sequence (src/ledger/shutdown.ts): the scheduler ends;
//    the stop entries are sealed; the ledger service commits the staging copy and both inboxes
//    and exits; the probes write "clean exit". The next start after a reboot then continues.
//  - The ledger's "ready" message is copied to the control plane as ledger.ready.json; the
//    watchdog's own identity and state are in watchdog.json (ensureRunning reads it).

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../common/fsx.ts';
import { ContentStore } from '../ledger/content.ts';
import type { InboxName } from '../ledger/inbox.ts';
import { probeHeartbeatPath } from '../ledger/probe.ts';
import { runCleanShutdown, type ShutdownReport } from '../ledger/shutdown.ts';
import { readBootId, stagedStopsInForce, stopCovers, type StopScope } from '../ledger/stops.ts';
import { processIdentity } from '../exec/supervisor.ts';
import { Alerts } from './alerts.ts';
import { ControlPlane } from './controlPlane.ts';
import { SchedulerLedger } from './ledger.ts';
import { currentBootId, systemUnits, type UnitControl } from './units.ts';

/** The ledger service, the scheduler, and the inbox probes ("probe:primary", "probe:backup"). */
export type ServiceName = 'ledger' | 'scheduler' | `probe:${InboxName}`;

/** src/ledger/probe-main.ts, run as `node --experimental-strip-types probe-main.ts <config.json>`. */
export const PROBE_MAIN = fileURLToPath(new URL('../ledger/probe-main.ts', import.meta.url));

/**
 * One inbox probe (src/ledger/probe-main.ts), started first and watched by its heartbeat. The
 * watchdog writes probe-main's config ({ inbox, file, other, controlPlane, boot?, intervalMs?,
 * staleMs?, shutdownMs? }) to <stateDir>/watchdog/probe-<inbox>.json and starts
 * `node probe-main.ts <that file>`. SIGTERM runs the probe's clean-exit step; it exits 0 when
 * the clean-exit record was written, 2 when it was not.
 */
export interface ProbeSpec {
  readonly inbox: InboxName;
  /** The inbox file this probe writes to. */
  readonly file: string;
  /** The other configured inbox, whose probe this one watches; null when there is only one. */
  readonly other: InboxName | null;
  readonly intervalMs?: number;
  readonly staleMs?: number;
  /** The clean-exit deadline after the seal (probe default 30 s). */
  readonly shutdownMs?: number;
  /** Tests only: the boot the probe records (default: the probe reads the machine's boot id). */
  readonly boot?: string;
  /** The node command before the script (default: this node with --experimental-strip-types). */
  readonly node?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly heartbeatTimeoutMs?: number;
  readonly startGraceMs?: number;
  readonly logPath?: string;
}

export interface ManagedSpec {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** The heartbeat file it writes ({ pid, at, ... }); for the ledger also { storageFault }. */
  readonly heartbeatPath: string;
  readonly heartbeatTimeoutMs?: number;
  /** Time a fresh process has to write its first heartbeat. */
  readonly startGraceMs?: number;
  readonly logPath?: string;
}

/** v45 6.3 "重启的上限". */
export interface RestartPolicy {
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly maxPerWindow: number;
  readonly windowMs: number;
  /** Healthy running this long clears the count (and an exhaustion episode). */
  readonly healthyResetMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = { initialBackoffMs: 1_000, maxBackoffMs: 300_000, maxPerWindow: 5, windowMs: 3_600_000, healthyResetMs: 3_600_000 };

export interface WatchdogOptions {
  readonly controlPlane: string;
  /** Where restart counts are kept (a Linux filesystem; not the ledger). */
  readonly stateDir: string;
  readonly ledger: ManagedSpec;
  readonly scheduler: ManagedSpec;
  /** The inbox probes; with them a stop is the clean shutdown sequence (v45 6.1). */
  readonly probes?: readonly ProbeSpec[];
  /** The boot the probes and the seal belong to (default: the machine's boot id). */
  readonly boot?: string;
  /** The shutdown sequence's limit (v45 6.1: 30 s). */
  readonly shutdownMs?: number;
  /** When given, alerts are also committed to the ledger, and committed stops are read from it. */
  readonly ledgerSocket?: string;
  readonly ledgerContentRoot?: string;
  /** The stop inbox (to see stops in force while the scheduler is away); default: none, the spool only. */
  readonly stopInbox?: string;
  readonly checkMs?: number;
  readonly restart?: Partial<RestartPolicy>;
  readonly storageFault?: { readonly maxRestarts?: number; readonly backoffMs?: readonly number[]; readonly healthyResetMs?: number };
  readonly faultAlertEveryMs?: number;
  readonly killWaitMs?: number;
  /** While the scheduler is away: how long `systemctl stop` gets before everything in a unit is killed. */
  readonly stopTimeoutMs?: number;
  /** While the scheduler is away: how long a unit may resist killing before a WI-14 notice (60 s). */
  readonly unkillableAfterMs?: number;
  readonly units?: UnitControl;
  readonly now?: () => number;
}

export type ManagedState = 'starting' | 'running' | 'backoff' | 'fault-held' | 'unkillable' | 'restart-exhausted' | 'stopped';

interface Managed {
  readonly name: ServiceName;
  readonly spec: ManagedSpec;
  child: ChildProcess | null;
  pid: number | null;
  startedAt: number;
  state: ManagedState;
  restarts: number;
  nextStartAt: number;
  /** Why the next start happens (for the notice when it does). */
  downReason: string | null;
  /** Storage-fault episode (ledger only). */
  faultRestarts: number;
  faultSince: number | null;
  faultHealthySince: number | null;
  nextFaultRestartAt: number;
  healthySince: number | null;
  exited: boolean;
}

/** The restart record of one service, kept in the state directory. */
interface RestartRecord {
  /** Restart times within the window. */
  times: number[];
  /** No restart now: the bound was reached and no retry has been granted since. */
  exhausted: boolean;
  /** The exhaustion episode's start; it lasts until an hour of healthy running ends it. */
  exhaustedSince: number | null;
  /** The PM used its one retry of this episode. */
  retryUsed: boolean;
  /**
   * The storage-fault episode of the ledger (6.1: at most 3 restarts per episode), kept here
   * too so a restarted watchdog does not start counting again (code review r1 #12).
   */
  fault?: { restarts: number; since: number | null; nextAt: number };
}

interface Heartbeat {
  readonly pid: number;
  readonly at: number;
  readonly storageFault?: boolean;
}

function readHeartbeat(path: string): Heartbeat | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Heartbeat;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const st = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = st.slice(st.lastIndexOf(')') + 2).split(' ')[0];
    return state !== 'Z' && state !== 'X';
  } catch {
    return false;
  }
}

/** The file a PM retry request is written to (the CLI or `requestRetry`). */
export function retryRequestPath(controlPlane: string, name: ServiceName): string {
  return join(controlPlane, `watchdog-retry-${name}.json`);
}

/** Ask a running watchdog to retry a restart-exhausted service (WI-22): once per episode by the PM, then only by the user. */
export function requestRetry(controlPlane: string, name: ServiceName, by: 'pm' | 'user'): void {
  writeFileAtomic(retryRequestPath(controlPlane, name), JSON.stringify({ by, at: Date.now() }));
}

/** probe-main's config file for one probe (written by the watchdog before it starts the probe). */
function writeProbeConfig(o: WatchdogOptions, p: ProbeSpec): string {
  const path = join(o.stateDir, 'watchdog', `probe-${p.inbox}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const cfg = {
    inbox: p.inbox,
    file: p.file,
    other: p.other,
    controlPlane: o.controlPlane,
    ...(p.boot !== undefined ? { boot: p.boot } : {}),
    ...(p.intervalMs !== undefined ? { intervalMs: p.intervalMs } : {}),
    ...(p.staleMs !== undefined ? { staleMs: p.staleMs } : {}),
    ...(p.shutdownMs !== undefined ? { shutdownMs: p.shutdownMs } : {}),
  };
  writeFileAtomic(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return path;
}

export function watchdogStatusPath(controlPlane: string): string {
  return join(controlPlane, 'watchdog.json');
}

export class Watchdog {
  private readonly o: WatchdogOptions;
  private readonly cp: ControlPlane;
  readonly alerts: Alerts;
  private readonly ledgerClient: SchedulerLedger | null;
  private readonly procs: Managed[];
  private readonly policy: RestartPolicy;
  private readonly units: UnitControl;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private readonly now: () => number;
  private stopping = false;
  private readonly records: Record<string, RestartRecord>;
  /** The last clean-shutdown report (tests, status). */
  lastShutdown: ShutdownReport | null = null;
  /** Units the watchdog has asked to stop while the scheduler is away: when it asked, and whether it killed. */
  private readonly ended = new Map<string, { at: number; killed: boolean; kills: number; lastKillAt: number | null; gone: boolean; alerted: boolean }>();
  /** Every event, for tests and the status file. */
  readonly events: Array<{ at: number; name: string; event: string; detail?: unknown }> = [];

  constructor(o: WatchdogOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.cp = new ControlPlane(o.controlPlane);
    this.policy = { ...DEFAULT_RESTART_POLICY, ...(o.restart ?? {}) };
    this.units = o.units ?? systemUnits;
    this.ledgerClient = o.ledgerSocket !== undefined ? SchedulerLedger.connect(o.ledgerSocket, 2_000) : null;
    const content = o.ledgerContentRoot !== undefined ? new ContentStore(o.ledgerContentRoot) : null;
    this.alerts = new Alerts({ ledger: this.ledgerClient, content, controlPlane: this.cp, source: 'watchdog', now: this.now });
    const mk = (name: ServiceName, spec: ManagedSpec): Managed => ({
      name,
      spec,
      child: null,
      pid: null,
      startedAt: 0,
      state: 'stopped',
      restarts: 0,
      nextStartAt: 0,
      downReason: null,
      faultRestarts: 0,
      faultSince: null,
      faultHealthySince: null,
      nextFaultRestartAt: 0,
      healthySince: null,
      exited: true,
    });
    this.procs = [
      mk('ledger', o.ledger),
      mk('scheduler', o.scheduler),
      ...(o.probes ?? []).map((p) =>
        mk(`probe:${p.inbox}`, {
          argv: [...(p.node ?? [process.execPath, '--experimental-strip-types', '--disable-warning=ExperimentalWarning']), PROBE_MAIN, writeProbeConfig(o, p)],
          ...(p.env !== undefined ? { env: p.env } : {}),
          heartbeatPath: probeHeartbeatPath(o.controlPlane, p.inbox),
          heartbeatTimeoutMs: p.heartbeatTimeoutMs ?? 30_000,
          startGraceMs: p.startGraceMs ?? 15_000,
          ...(p.logPath !== undefined ? { logPath: p.logPath } : {}),
        }),
      ),
    ];
    this.records = this.loadRecords();
  }

  // ---------------------------------------------------------------- restart counts (state directory)

  private get recordsPath(): string {
    return join(this.o.stateDir, 'watchdog', 'restarts.json');
  }

  private loadRecords(): Record<string, RestartRecord> {
    const empty = (): RestartRecord => ({ times: [], exhausted: false, exhaustedSince: null, retryUsed: false });
    let r: Record<string, RestartRecord> = {};
    try {
      r = JSON.parse(readFileSync(this.recordsPath, 'utf8')) as Record<string, RestartRecord>;
    } catch {
      r = {};
    }
    for (const p of this.procs) r[p.name] ??= empty();
    // the storage-fault episode survives a watchdog restart
    const f = r['ledger']?.fault;
    const l = this.procs.find((p) => p.name === 'ledger');
    if (f !== undefined && l !== undefined) {
      l.faultRestarts = f.restarts;
      l.faultSince = f.since;
      l.nextFaultRestartAt = f.nextAt;
    }
    return r;
  }

  /** False when the counts could not be written: then no restart happens (it would go uncounted). */
  private saveRecords(): boolean {
    const l = this.procs.find((p) => p.name === 'ledger');
    if (l !== undefined && this.records['ledger'] !== undefined) {
      this.records['ledger'].fault = { restarts: l.faultRestarts, since: l.faultSince, nextAt: l.nextFaultRestartAt };
    }
    try {
      mkdirSync(dirname(this.recordsPath), { recursive: true });
      writeFileAtomic(this.recordsPath, JSON.stringify(this.records, null, 2));
      return true;
    } catch (e) {
      this.event('watchdog', 'restart-counts-unwritable', { error: (e as Error).message });
      return false;
    }
  }

  private record(name: ServiceName): RestartRecord {
    const r = (this.records[name] ??= { times: [], exhausted: false, exhaustedSince: null, retryUsed: false });
    const cutoff = this.now() - this.policy.windowMs;
    r.times = r.times.filter((t) => t > cutoff);
    return r;
  }

  restartCount(name: ServiceName): number {
    return this.record(name).times.length;
  }

  // ---------------------------------------------------------------- accessors

  private proc(name: ServiceName): Managed {
    const p = this.procs.find((x) => x.name === name);
    if (p === undefined) throw new Error(`no managed service ${name}`);
    return p;
  }

  pidOf(name: ServiceName): number | null {
    return this.proc(name).pid;
  }

  stateOf(name: ServiceName): ManagedState {
    return this.proc(name).state;
  }

  restartsOf(name: ServiceName): number {
    return this.proc(name).restarts;
  }

  faultRestarts(): number {
    return this.proc('ledger').faultRestarts;
  }

  private event(name: string, event: string, detail?: unknown): void {
    this.events.push({ at: this.now(), name, event, ...(detail !== undefined ? { detail } : {}) });
    this.writeStatus();
  }

  private writeStatus(): void {
    const self = processIdentity(process.pid);
    this.cp.write(watchdogStatusPath(this.o.controlPlane), {
      format: 'mp4.watchdog-status.v2',
      pid: process.pid,
      startTime: self?.startTime ?? 0,
      bootId: currentBootId(),
      at: this.now(),
      processes: this.procs.map((p) => ({
        name: p.name,
        pid: p.pid,
        state: p.state,
        restarts: p.restarts,
        restartsThisHour: this.record(p.name).times.length,
        exhaustedSince: this.record(p.name).exhaustedSince,
        faultRestarts: p.faultRestarts,
        faultSince: p.faultSince,
      })),
    });
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    mkdirSync(this.o.controlPlane, { recursive: true });
    // the probes first: they watch the inboxes independently of the ledger service
    const order = [...this.procs.filter((p) => p.name.startsWith('probe:')), this.proc('ledger'), this.proc('scheduler')];
    for (const p of order) {
      if (this.record(p.name).exhausted) {
        // an exhaustion episode survives a watchdog restart: no start until the PM or the user retries
        p.state = 'restart-exhausted';
        continue;
      }
      this.spawn(p);
      if (p.name === 'ledger') await this.waitBeat(p, p.spec.startGraceMs ?? 15_000);
    }
    this.writeStatus();
    this.timer = setInterval(() => void this.check(), this.o.checkMs ?? 500);
  }

  private async waitBeat(p: Managed, ms: number): Promise<boolean> {
    const deadline = this.now() + ms;
    while (this.now() < deadline) {
      const hb = readHeartbeat(p.spec.heartbeatPath);
      if (hb !== null && hb.pid === p.pid) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  private spawn(p: Managed): void {
    const [cmd, ...args] = p.spec.argv;
    if (cmd === undefined) throw new Error(`${p.name}: empty argv`);
    let log: number | 'ignore' = 'ignore';
    if (p.spec.logPath !== undefined) {
      mkdirSync(dirname(p.spec.logPath), { recursive: true });
      log = openSync(p.spec.logPath, 'a');
    }
    const child = spawn(cmd, args, { env: { ...process.env, ...(p.spec.env ?? {}) }, stdio: ['ignore', log, log, 'ipc'] });
    if (typeof log === 'number') closeSync(log);
    p.child = child;
    p.pid = child.pid ?? null;
    p.startedAt = this.now();
    p.state = 'starting';
    p.exited = false;
    p.healthySince = null;
    child.on('exit', (code, signal) => {
      if (p.child !== child) return;
      p.exited = true;
      this.event(p.name, 'exited', { pid: child.pid, code, signal });
    });
    child.on('message', (m: unknown) => {
      if (p.name === 'ledger' && typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'ready') {
        this.cp.write(join(this.o.controlPlane, 'ledger.ready.json'), { ...(m as object), pid: child.pid, at: this.now() });
      }
    });
    child.on('error', () => undefined);
    this.event(p.name, 'started', { pid: child.pid });
  }

  /** SIGKILL and wait; false when the process is still there after killWaitMs. */
  private async kill(p: Managed): Promise<boolean> {
    const pid = p.pid;
    if (pid === null || p.exited) return true;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
    const deadline = this.now() + (this.o.killWaitMs ?? 5_000);
    while (this.now() < deadline) {
      if (p.exited || !alive(pid)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return p.exited || !alive(pid);
  }

  /**
   * The service is down (exited, or killed for a lost heartbeat): restart it after the back-off,
   * within the hourly bound; beyond it, the service is restart-exhausted (WI-22).
   */
  private async down(p: Managed, why: string): Promise<void> {
    const r = this.record(p.name);
    if (r.exhausted) {
      p.state = 'restart-exhausted';
      return;
    }
    if (r.times.length >= this.policy.maxPerWindow) {
      r.exhausted = true;
      r.exhaustedSince ??= this.now();
      this.saveRecords();
      p.state = 'restart-exhausted';
      this.event(p.name, 'restart-exhausted', { why, restarts: r.times.length });
      await this.alerts
        .raise({
          category: 'service-restart-exhausted',
          wi: 'WI-22',
          // one merged notice for the whole episode, kept on display until it ends
          key: `${p.name}:exhausted:${r.exhaustedSince}`,
          trigger: `${p.name} went down ${r.times.length + 1} times within ${Math.round(this.policy.windowMs / 60_000)} minutes (last: ${why})`,
          defaultAction: `no more restarts of the ${p.name}; stops still take effect through the inbox, the control plane and the fast signal${p.name === 'scheduler' ? ', and the watchdog ends the processes in their scope' : ''}; the PM may retry once (WI-22), then only the user decides`,
          detail: { service: p.name, restartsThisHour: r.times, why, logPath: p.spec.logPath ?? null },
        })
        .catch(() => undefined);
      return;
    }
    const delay = Math.min(this.policy.initialBackoffMs * 2 ** r.times.length, this.policy.maxBackoffMs);
    p.state = 'backoff';
    p.downReason = why;
    p.nextStartAt = this.now() + delay;
    this.event(p.name, 'backoff', { why, delayMs: delay });
  }

  private async restartNow(p: Managed): Promise<void> {
    const r = this.record(p.name);
    // every start, the storage-fault ones included, is within the general hourly bound (r1 #12)
    if (r.exhausted || r.times.length >= this.policy.maxPerWindow) {
      p.state = 'backoff';
      p.nextStartAt = Number.POSITIVE_INFINITY;
      await this.down(p, p.downReason ?? 'down');
      return;
    }
    r.times.push(this.now());
    if (!this.saveRecords()) {
      // an uncounted restart could exceed the bound: hold it and say so (WI-22)
      r.times.pop();
      p.state = 'backoff';
      p.nextStartAt = this.now() + this.policy.maxBackoffMs;
      await this.alerts
        .raise({
          category: 'restart-count-unwritable',
          wi: 'WI-22',
          key: `${p.name}:${Math.floor(this.now() / 600_000)}`,
          trigger: `the restart counts of the ${p.name} cannot be written to ${this.recordsPath}`,
          defaultAction: `the restart is held (an uncounted restart could exceed the bound) and tried again in ${Math.round(this.policy.maxBackoffMs / 1000)} s; stops still take effect through the inbox and the control plane`,
          detail: { service: p.name, path: this.recordsPath },
        })
        .catch(() => undefined);
      return;
    }
    p.restarts++;
    const why = p.downReason ?? 'down';
    p.downReason = null;
    this.spawn(p);
    await this.alerts
      .raise({
        category: 'service-restarted',
        wi: 'WI-22',
        key: `${p.name}:${p.pid}`,
        trigger: `${p.name} restarted by the watchdog: ${why}`,
        defaultAction: 'restarted after the back-off; it recovers from the ledger, stops are committed first, running units are taken over (6.3)',
        detail: { service: p.name, why, restartsThisHour: r.times.length, limit: this.policy.maxPerWindow, logPath: p.spec.logPath ?? null },
      })
      .catch(() => undefined);
  }

  /** One supervision round. */
  async check(): Promise<void> {
    if (this.checking || this.stopping) return;
    this.checking = true;
    try {
      await this.handleRetryRequests();
      await this.checkLedger();
      await this.checkGeneric(this.proc('scheduler'));
      for (const p of this.procs) if (p.name.startsWith('probe:')) await this.checkGeneric(p);
      await this.enforceStopsWithoutScheduler();
      await this.alerts.flush().catch(() => 0);
      this.writeStatus();
    } finally {
      this.checking = false;
    }
  }

  // ---------------------------------------------------------------- PM retry (WI-22)

  /** The PM retries a restart-exhausted service: once per episode; after that only the user. */
  async retry(name: ServiceName, by: 'pm' | 'user'): Promise<{ retried: boolean; why?: string }> {
    const p = this.proc(name);
    const r = this.record(name);
    if (!r.exhausted) return { retried: false, why: 'not restart-exhausted' };
    if (by === 'pm' && r.retryUsed) {
      await this.alerts
        .raise({
          category: 'service-retry-refused',
          wi: 'WI-22',
          key: `${name}:retry:${r.exhaustedSince}`,
          trigger: `the PM asked to retry the ${name} a second time in one exhaustion episode`,
          defaultAction: 'refused: the PM retries once per episode; the next retry is the user\'s decision',
          detail: { service: name, exhaustedSince: r.exhaustedSince },
        })
        .catch(() => undefined);
      return { retried: false, why: 'the PM already retried in this episode; the user decides' };
    }
    r.times = [];
    r.exhausted = false;
    r.retryUsed = by === 'pm' ? true : r.retryUsed;
    // the episode goes on (and with it the one PM retry) until an hour of healthy running ends it
    this.saveRecords();
    p.state = 'backoff';
    p.downReason = `retry by the ${by === 'pm' ? 'PM' : 'user'}`;
    p.nextStartAt = this.now();
    this.event(name, 'retry', { by });
    return { retried: true };
  }

  private async handleRetryRequests(): Promise<void> {
    for (const name of this.procs.map((p) => p.name)) {
      const path = retryRequestPath(this.o.controlPlane, name);
      if (!existsSync(path)) continue;
      let by: 'pm' | 'user' = 'pm';
      try {
        by = (JSON.parse(readFileSync(path, 'utf8')) as { by?: 'pm' | 'user' }).by === 'user' ? 'user' : 'pm';
      } catch {
        /* a torn request counts as the PM's */
      }
      try {
        unlinkSync(path);
      } catch {
        /* taken */
      }
      await this.retry(name, by);
    }
  }

  /** While the service runs healthily: an hour of it clears the count and ends an exhaustion episode. */
  private healthy(p: Managed): void {
    p.healthySince ??= this.now();
    if (this.now() - p.healthySince < this.policy.healthyResetMs) return;
    const r = this.record(p.name);
    if (r.times.length === 0 && r.exhaustedSince === null && !r.retryUsed) return;
    r.times = [];
    r.exhausted = false;
    r.exhaustedSince = null;
    r.retryUsed = false;
    this.saveRecords();
    this.event(p.name, 'restart-count-cleared');
  }

  // ---------------------------------------------------------------- the ledger

  private faultCfg(): { max: number; backoff: readonly number[]; healthyResetMs: number } {
    const f = this.o.storageFault ?? {};
    return { max: f.maxRestarts ?? 3, backoff: f.backoffMs ?? [1_000, 4_000, 16_000], healthyResetMs: f.healthyResetMs ?? 30_000 };
  }

  private async checkLedger(): Promise<void> {
    const p = this.proc('ledger');
    const now = this.now();
    const fc = this.faultCfg();
    if (p.state === 'restart-exhausted') return;
    if (p.state === 'unkillable') {
      if (p.pid !== null && alive(p.pid)) {
        await this.faultAlert(p, 'the old ledger process cannot be ended and still holds the writer lock (handled as a storage fault)');
        return;
      }
      this.event(p.name, 'unkillable-gone');
      p.exited = true;
      p.state = 'stopped';
    }
    if (p.state === 'backoff') {
      if (now >= p.nextStartAt) await this.restartNow(p);
      return;
    }
    if (p.exited) {
      // a crash during a storage-fault episode counts toward the (stricter) fault restarts
      if (p.faultSince !== null) {
        if (p.faultRestarts >= fc.max) {
          p.state = 'fault-held';
          await this.faultAlert(p, 'the ledger keeps failing on its storage; restarts exhausted');
          return;
        }
        if (now < p.nextFaultRestartAt) return;
        p.faultRestarts++;
        p.nextFaultRestartAt = now + (fc.backoff[Math.min(p.faultRestarts, fc.backoff.length - 1)] ?? 1_000);
        p.downReason = `exited during a storage fault (restart ${p.faultRestarts}/${fc.max})`;
        await this.restartNow(p);
        return;
      }
      if (p.state !== 'fault-held') await this.down(p, 'exited');
      return;
    }
    const hb = readHeartbeat(p.spec.heartbeatPath);
    const fresh = hb !== null && hb.pid === p.pid && now - hb.at <= (p.spec.heartbeatTimeoutMs ?? 5_000);
    if (!fresh) {
      if (now - p.startedAt <= (p.spec.startGraceMs ?? 15_000) && (hb === null || hb.pid !== p.pid)) return;
      if (!(await this.kill(p))) {
        p.state = 'unkillable';
        this.event(p.name, 'unkillable', { pid: p.pid });
        return;
      }
      await this.down(p, 'heartbeat lost');
      return;
    }
    if (p.state === 'starting') p.state = 'running';
    if (hb.storageFault === true) {
      p.faultHealthySince = null;
      p.healthySince = null;
      if (p.faultSince === null) {
        p.faultSince = now;
        p.nextFaultRestartAt = now + (fc.backoff[0] ?? 1_000);
        this.saveRecords();
        this.event(p.name, 'storage-fault');
        await this.alerts
          .raise({
            category: 'ledger-storage-fault',
            wi: 'WI-12',
            key: `${now}`,
            trigger: `the ledger service ${p.pid} reports a storage fault: it refuses every write (6.1)`,
            defaultAction: 'no dispatch, no authorization, no acceptance; stops still take effect through the inbox and the control plane; the service is restarted with back-off, at most 3 times',
            detail: { pid: p.pid },
          })
          .catch(() => undefined);
        return;
      }
      if (p.faultRestarts >= fc.max) {
        p.state = 'fault-held';
        await this.faultAlert(p, 'the ledger storage is still failing after the last restart; no more restarts');
        return;
      }
      if (now >= p.nextFaultRestartAt) {
        const r = this.record(p.name);
        if (r.exhausted || r.times.length >= this.policy.maxPerWindow) {
          // the general hourly bound holds for storage-fault restarts too (r1 #12): keep the fault state
          p.state = 'fault-held';
          await this.faultAlert(p, `the ledger storage is still failing and the ledger was restarted ${r.times.length} times this hour; no more restarts`);
          return;
        }
        p.faultRestarts++;
        p.nextFaultRestartAt = now + (fc.backoff[Math.min(p.faultRestarts, fc.backoff.length - 1)] ?? 1_000);
        if (!(await this.kill(p))) {
          p.state = 'unkillable';
          return;
        }
        p.downReason = `storage fault (restart ${p.faultRestarts}/${fc.max})`;
        await this.restartNow(p);
      }
      return;
    }
    // healthy
    if (p.state === 'fault-held') p.state = 'running';
    if (p.faultSince !== null) {
      p.faultHealthySince ??= now;
      if (now - p.faultHealthySince >= fc.healthyResetMs) {
        this.event(p.name, 'storage-recovered', { faultRestarts: p.faultRestarts });
        p.faultSince = null;
        p.faultRestarts = 0;
        p.faultHealthySince = null;
        this.saveRecords();
      }
    }
    this.healthy(p);
  }

  private async faultAlert(p: Managed, why: string): Promise<void> {
    const every = this.o.faultAlertEveryMs ?? 60_000;
    const bucket = Math.floor(this.now() / every);
    await this.alerts
      .raise({
        category: 'ledger-storage-fault-held',
        wi: 'WI-12',
        key: `${p.faultSince ?? 0}:${bucket}`,
        trigger: why,
        defaultAction: 'no more restarts; the fault state is kept and this notice repeats; stops still take effect through the inbox and the control plane',
        detail: { pid: p.pid, faultRestarts: p.faultRestarts, since: p.faultSince },
      })
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------- the scheduler

  /** The scheduler and the probes: restart on an exit or a lost heartbeat, within the bound. */
  private async checkGeneric(p: Managed): Promise<void> {
    const now = this.now();
    if (p.state === 'restart-exhausted') return;
    if (p.state === 'unkillable') {
      if (p.pid !== null && alive(p.pid)) return;
      p.exited = true;
      p.state = 'stopped';
    }
    if (p.state === 'backoff') {
      if (now >= p.nextStartAt) await this.restartNow(p);
      return;
    }
    if (p.exited) {
      await this.down(p, 'exited');
      return;
    }
    const hb = readHeartbeat(p.spec.heartbeatPath);
    const fresh = hb !== null && hb.pid === p.pid && now - hb.at <= (p.spec.heartbeatTimeoutMs ?? 5_000);
    if (!fresh) {
      if (now - p.startedAt <= (p.spec.startGraceMs ?? 30_000) && (hb === null || hb.pid !== p.pid)) return;
      if (!(await this.kill(p))) {
        p.state = 'unkillable';
        return;
      }
      await this.down(p, 'heartbeat lost');
      return;
    }
    if (p.state === 'starting') p.state = 'running';
    this.healthy(p);
  }

  // ---------------------------------------------------------------- stops while the scheduler is away (6.3)

  /**
   * The stops in force: the ledger's active ones, and requests it has not committed yet. The
   * inbox and spool keep a request after the ledger committed (and maybe released) it, so a
   * request the ledger already resolved does not count by itself (e2e B5); while the ledger
   * cannot answer, every request counts.
   */
  private async stopsInForce(): Promise<StopScope[]> {
    // Minus the stops the ledger released (its resolution markers), so this also holds while the ledger is down.
    const pending = stagedStopsInForce({ inbox: this.o.stopInbox ?? join(this.o.controlPlane, '.no-inbox'), controlPlane: this.o.controlPlane });
    if (this.ledgerClient === null) return pending.map((r) => r.scope);
    const scopes: StopScope[] = [];
    try {
      for (const s of await this.ledgerClient.activeStops()) scopes.push(s.scope);
      for (const r of pending) if ((await this.ledgerClient.stopState(r.stop)) === null) scopes.push(r.scope);
    } catch {
      return [...scopes, ...pending.map((r) => r.scope)];
    }
    return scopes;
  }

  /**
   * The scheduler is down or restart-exhausted: end the units in the scope of a stop in force,
   * from the control-plane host list (the unit supervisors also stop themselves on the spool).
   */
  private async enforceStopsWithoutScheduler(): Promise<void> {
    const s = this.proc('scheduler');
    if (s.state === 'running' || s.state === 'starting' || this.stopping) return;
    const hosts = this.cp.hosts();
    if (hosts.length === 0) return;
    const scopes = await this.stopsInForce();
    if (scopes.length === 0) return;
    const now = this.now();
    const timeout = this.o.stopTimeoutMs ?? 30_000;
    for (const h of hosts) {
      if (!scopes.some((sc) => stopCovers(sc, h.tag))) continue;
      const e = this.ended.get(h.launch);
      if (e === undefined) {
        this.ended.set(h.launch, { at: now, killed: false, kills: 0, lastKillAt: null, gone: false, alerted: false });
        this.event('watchdog', 'stop-unit', { launch: h.launch, unit: h.unitName });
        void this.units.stop(h.unitName, timeout).catch(() => undefined);
        continue;
      }
      if (e.gone || now - e.at < timeout) continue;
      // past the stop timeout: kill, and keep killing while the unit is still there (r1 #4); a
      // failed kill or an unreadable state counts as still there
      let state = 'unknown';
      try {
        state = await this.units.activeState(h.unitName);
      } catch {
        /* systemd cannot answer now */
      }
      if (state === 'inactive' || state === 'failed') {
        e.gone = true;
        continue;
      }
      if (e.lastKillAt === null || now - e.lastKillAt >= Math.min(timeout, 5_000)) {
        e.kills++;
        e.lastKillAt = now;
        e.killed = true;
        await this.units.kill(h.unitName).catch((err: unknown) => this.event('watchdog', 'kill-failed', { unit: h.unitName, error: (err as Error).message }));
      }
      const unkillableAfter = this.o.unkillableAfterMs ?? 60_000;
      if (!e.alerted && now - e.at - timeout >= unkillableAfter) {
        e.alerted = true;
        await this.alerts
          .raise({
            category: 'stop-unkillable',
            wi: 'WI-14',
            key: `watchdog:${h.launch}`,
            trigger: `while the scheduler is away, ${h.unitName} (in the scope of a stop) is still ${state} after ${e.kills} kill attempt(s)`,
            defaultAction: 'the stop is in effect; killing is retried; its resources stay counted; other work continues',
            detail: { launch: h.launch, unit: h.unitName, state, kills: e.kills },
          })
          .catch(() => undefined);
      }
    }
  }

  /** Units the watchdog ended while the scheduler was away (tests). */
  endedUnits(): string[] {
    return [...this.ended.keys()];
  }

  /**
   * SIGTERM, SIGKILL after `graceMs`, and wait for the exit until `until` (absolute ms); false
   * when the process did not exit by then (r1 #13: never an unbounded wait).
   */
  private async terminate(p: Managed, graceMs: number, until: number): Promise<boolean> {
    const c = p.child;
    if (c === null || p.exited) return true;
    const exited = new Promise<boolean>((r) => c.once('exit', () => r(true)));
    try {
      c.kill('SIGTERM');
    } catch {
      /* gone */
    }
    const t = setTimeout(() => {
      try {
        c.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, Math.max(0, graceMs));
    let late: NodeJS.Timeout | undefined;
    const ok = await Promise.race([exited, new Promise<boolean>((r) => (late = setTimeout(() => r(false), Math.max(0, until - Date.now()))))]);
    clearTimeout(t);
    clearTimeout(late);
    p.state = ok ? 'stopped' : 'unkillable';
    if (!ok) this.event(p.name, 'did-not-exit', { pid: p.pid });
    return ok;
  }

  /**
   * Stop everything, within one absolute deadline from the start (`shutdownMs`, 30 s; r1 #13).
   * With probes, the v45 6.1 clean shutdown: the scheduler ends; the stop entries are sealed;
   * the ledger commits the staging copy and both inboxes and exits; the probes write "clean
   * exit". A process that does not end in time makes the shutdown unclean: the probes are then
   * killed without writing "clean exit", and the next start treats the boot as an abnormal stop.
   * Without probes: SIGTERM to both. Returns whether everything ended cleanly.
   */
  async stop(graceMs = 10_000): Promise<boolean> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + (this.o.shutdownMs ?? 30_000);
    const left = (): number => Math.max(0, deadline - Date.now());
    const schedulerEnded = await this.terminate(this.proc('scheduler'), Math.min(graceMs, left()), deadline);
    const probes = this.procs.filter((p) => p.name.startsWith('probe:'));
    let clean = schedulerEnded;
    if (probes.length > 0) {
      const waitExit = async (p: Managed, until: number): Promise<boolean> => {
        const c = p.child;
        if (c === null || p.exited) return true;
        const exited = new Promise<boolean>((r) => c.once('exit', () => r(true)));
        try {
          c.kill('SIGTERM');
        } catch {
          return true;
        }
        let late: NodeJS.Timeout | undefined;
        const ok = await Promise.race([exited, new Promise<boolean>((r) => (late = setTimeout(() => r(false), Math.max(0, Math.min(until, deadline) - Date.now()))))]);
        clearTimeout(late);
        p.state = 'stopped';
        return ok;
      };
      // a probe's exit code says whether it wrote its clean-exit record (0) or not (2)
      const probeDone = async (p: Managed, until: number): Promise<boolean> => {
        const c = p.child;
        if (c === null || p.exited) return false;
        const exited = new Promise<boolean>((r) => c.once('exit', (code) => r(code === 0)));
        try {
          c.kill('SIGTERM');
        } catch {
          return false;
        }
        let late: NodeJS.Timeout | undefined;
        const ok = await Promise.race([exited, new Promise<boolean>((r) => (late = setTimeout(() => r(false), Math.max(0, Math.min(until, deadline) - Date.now()))))]);
        clearTimeout(late);
        p.state = 'stopped';
        return ok;
      };
      // the scheduler did not end: not a clean shutdown; the probes must not write "clean exit"
      const killProbes = async (): Promise<boolean> => {
        for (const p of probes) {
          try {
            p.child?.kill('SIGKILL');
          } catch {
            /* gone */
          }
        }
        return false;
      };
      this.lastShutdown = await runCleanShutdown({
        controlPlane: this.o.controlPlane,
        boot: this.o.boot ?? readBootId(),
        stopLedger: (until) => waitExit(this.proc('ledger'), until),
        stopProbes: schedulerEnded ? async (until) => (await Promise.all(probes.map((p) => probeDone(p, until)))).every(Boolean) : killProbes,
        totalMs: Math.max(1, left()),
        ...(left() < 5_000 ? { entryWaitMs: Math.floor(left() / 3) } : {}),
      });
      this.event('watchdog', 'clean-shutdown', this.lastShutdown);
      clean = clean && this.lastShutdown.ledgerExited && this.lastShutdown.probesDone;
      // whatever did not end in time is killed, with a bounded wait: the next start treats the boot as an abnormal stop
      for (const p of [this.proc('ledger'), ...probes]) if (!(await this.terminate(p, 0, deadline))) clean = false;
    } else {
      clean = (await this.terminate(this.proc('ledger'), Math.min(graceMs, left()), deadline)) && clean;
    }
    this.writeStatus();
    this.ledgerClient?.close();
    return clean;
  }
}
