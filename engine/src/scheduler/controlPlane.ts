// The control plane (design 6.1 "控制面"): a directory on a memory filesystem, a different
// medium from the main ledger. It only speeds things up and never decides whether anything
// took effect. The scheduler writes here:
//   scheduler.heartbeat      its heartbeat (the watchdog's signal, 6.3 "监督")
//   scheduler.lease          its generation and lease (6.3), so an older scheduler sees it is superseded
//   hosts/<launch>.json      the host manifest: what runs where and under which scope tag, so a
//                            stop can end processes in scope without the ledger (6.1 storage fault)
//   alerts/<id>.json         copies of system alerts (3.9: the PM's background monitor reads these)
//   reports/stops/<id>.json  stop reports (6.4)
//   scheduler.status.json    what the scheduler is waiting on (budget, resources, pause, fault)
// and reads: the stop signal and spool (src/ledger/stops.ts), the ledger heartbeat
// (src/ledger/main.ts), host heartbeats (heartbeats/<launch>.json, written by seat hosts).
// Every write is atomic; a failed write is swallowed: the control plane is best effort.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../common/fsx.ts';
import type { Generation, LaunchId, MissionId, StopId } from '../common/ids.ts';
import type { ScopeTag } from '../ledger/stops.ts';

export interface ProcessIdentityJson {
  readonly pid: number;
  readonly startTime: number | string;
  readonly bootId: string;
}

export interface SchedulerHeartbeat extends ProcessIdentityJson {
  readonly format: 'mp4.scheduler-heartbeat.v1';
  readonly gen: Generation | null;
  readonly at: number;
}

export interface SchedulerLease extends ProcessIdentityJson {
  readonly format: 'mp4.scheduler-lease.v1';
  readonly gen: Generation;
  readonly renewedAt: number;
  readonly ttlMs: number;
}

/** One unit the scheduler started or adopted (6.1: "宿主进程清单"). */
export interface HostEntry {
  readonly format: 'mp4.host-entry.v1';
  readonly launch: LaunchId;
  readonly tag: ScopeTag;
  readonly unitName: string;
  readonly task: string | null;
  readonly lineage: string | null;
  readonly seatUnit: boolean;
  readonly heartbeat: boolean;
  readonly gen: Generation;
  readonly at: number;
}

/** A host's heartbeat (seat hosts: src/seat/host.ts heartbeatPath). */
export interface HostHeartbeat extends ProcessIdentityJson {
  readonly launch: string;
  readonly at: number;
  readonly phase?: string;
}

export interface AlertCopy {
  readonly format: 'mp4.alert-copy.v1';
  readonly alert: string;
  readonly category: string;
  /** The PM work instruction (design 3.11). */
  readonly wi: string | null;
  readonly key: string;
  /** What happened and the evidence: a sentence (scheduler, watchdog) or structured facts (exec, seat hosts). */
  readonly trigger: unknown;
  readonly defaultAction: string | null;
  readonly detail: unknown;
  readonly source: string;
  readonly at: number;
  /** Whether the ledger has the alert (false while the ledger is unavailable). */
  readonly committed: boolean;
}

export type StopReportState =
  /** Committed; units in scope are being ended and cleaned up. */
  | 'stopping'
  /** Every unit in scope has ended and is cleaned up; no network grant is left. */
  | 'stopped'
  /** Committed, but some processes did not end after being killed (6.1: 60 s). */
  | 'stop-effective-unkillable'
  /** Not yet committed (storage fault): processes in scope are ended through the control plane. */
  | 'not-committed';

export interface StopReportUnit {
  readonly launch: LaunchId;
  readonly unitName: string;
  readonly processesEnded: boolean;
  readonly cleanup: 'pending' | 'done' | 'unknown';
  readonly disposition: string | null;
}

export interface StopReportProcess {
  readonly launch: LaunchId | null;
  readonly intent: string | null;
  readonly pid: number;
  readonly what: string;
  readonly reason: string;
}

export interface StopReportIntent {
  readonly intent: string;
  readonly kind: string;
  readonly domain: string;
  readonly state: string;
  readonly note: string;
}

export interface StopReport {
  readonly format: 'mp4.stop-report.v1';
  readonly stop: StopId;
  readonly state: StopReportState;
  /** The words shown to the PM. */
  readonly summary: string;
  readonly committed: boolean;
  readonly units: readonly StopReportUnit[];
  readonly unkillable: readonly StopReportProcess[];
  /** 6.4: "停止前已开始，结果未定". */
  readonly undeterminedActions: readonly StopReportIntent[];
  readonly at: number;
}

export interface SchedulerStatus {
  readonly format: 'mp4.scheduler-status.v1';
  readonly gen: Generation | null;
  readonly recoveryPause: boolean;
  readonly storageFault: boolean;
  readonly stale: boolean;
  readonly dispatchPaused: string | null;
  readonly waiting: ReadonlyArray<{ readonly mission: MissionId | null; readonly task: string | null; readonly reason: string }>;
  readonly blocked: ReadonlyArray<{ readonly mission: MissionId; readonly reason: string }>;
  /** Level 0: the evaluator's fault (WI-11), its degraded memory pool (WI-18), its last publication. */
  readonly evaluator: {
    readonly fault: string | null;
    readonly degraded: unknown;
    readonly blocked: unknown;
    readonly checkpointPaused: unknown;
    readonly published: number | null;
    readonly lastCheckpoint: unknown;
  };
  readonly at: number;
}

export interface LedgerHeartbeat {
  readonly pid: number;
  readonly at: number;
  readonly head: number;
  readonly storageFault: boolean;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export class ControlPlane {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get schedulerHeartbeatPath(): string {
    return join(this.dir, 'scheduler.heartbeat');
  }

  get leasePath(): string {
    return join(this.dir, 'scheduler.lease');
  }

  get hostsDir(): string {
    return join(this.dir, 'hosts');
  }

  get alertsDir(): string {
    return join(this.dir, 'alerts');
  }

  get stopReportsDir(): string {
    return join(this.dir, 'reports', 'stops');
  }

  get statusPath(): string {
    return join(this.dir, 'scheduler.status.json');
  }

  get stopSignalPath(): string {
    return join(this.dir, 'stop-signal');
  }

  get ledgerHeartbeatPath(): string {
    return join(this.dir, 'ledger.heartbeat');
  }

  hostHeartbeatPath(launch: LaunchId): string {
    return join(this.dir, 'heartbeats', `${launch}.json`);
  }

  /** Best-effort atomic write; false when the control plane could not be written. */
  write(path: string, value: unknown): boolean {
    try {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- heartbeat and lease (6.3)

  writeHeartbeat(hb: SchedulerHeartbeat): boolean {
    return this.write(this.schedulerHeartbeatPath, hb);
  }

  readSchedulerHeartbeat(): SchedulerHeartbeat | null {
    return readJson<SchedulerHeartbeat>(this.schedulerHeartbeatPath);
  }

  writeLease(lease: SchedulerLease): boolean {
    return this.write(this.leasePath, lease);
  }

  readLease(): SchedulerLease | null {
    return readJson<SchedulerLease>(this.leasePath);
  }

  readLedgerHeartbeat(): LedgerHeartbeat | null {
    return readJson<LedgerHeartbeat>(this.ledgerHeartbeatPath);
  }

  readHostHeartbeat(launch: LaunchId): HostHeartbeat | null {
    return readJson<HostHeartbeat>(this.hostHeartbeatPath(launch));
  }

  /** The stop signal's content (the request time of the latest stop), for change detection. */
  readStopSignal(): string | null {
    try {
      return readFileSync(this.stopSignalPath, 'utf8');
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- host manifest (6.1)

  putHost(entry: HostEntry): boolean {
    return this.write(join(this.hostsDir, `${entry.launch}.json`), entry);
  }

  removeHost(launch: LaunchId): void {
    try {
      unlinkSync(join(this.hostsDir, `${launch}.json`));
    } catch {
      /* gone */
    }
  }

  host(launch: LaunchId): HostEntry | null {
    return readJson<HostEntry>(join(this.hostsDir, `${launch}.json`));
  }

  hosts(): HostEntry[] {
    let names: string[];
    try {
      names = readdirSync(this.hostsDir);
    } catch {
      return [];
    }
    const out: HostEntry[] = [];
    for (const n of names.sort()) {
      if (n.startsWith('.') || !n.endsWith('.json')) continue;
      const e = readJson<HostEntry>(join(this.hostsDir, n));
      if (e?.format === 'mp4.host-entry.v1') out.push(e);
    }
    return out;
  }

  // ---------------------------------------------------------------- alerts (3.9)

  putAlert(copy: AlertCopy): boolean {
    return this.write(join(this.alertsDir, `${copy.alert}.json`), copy);
  }

  alerts(): AlertCopy[] {
    let names: string[];
    try {
      names = readdirSync(this.alertsDir);
    } catch {
      return [];
    }
    const out: AlertCopy[] = [];
    for (const n of names.sort()) {
      if (n.startsWith('.') || !n.endsWith('.json')) continue;
      const a = readJson<AlertCopy>(join(this.alertsDir, n));
      if (a?.format === 'mp4.alert-copy.v1') out.push(a);
    }
    return out.sort((a, b) => a.at - b.at);
  }

  hasAlert(alert: string): boolean {
    return existsSync(join(this.alertsDir, `${alert}.json`));
  }

  // ---------------------------------------------------------------- stop reports (6.4)

  putStopReport(report: StopReport): boolean {
    return this.write(join(this.stopReportsDir, `${report.stop}.json`), report);
  }

  stopReport(stop: StopId): StopReport | null {
    return readJson<StopReport>(join(this.stopReportsDir, `${stop}.json`));
  }

  // ---------------------------------------------------------------- status

  putStatus(status: SchedulerStatus): boolean {
    return this.write(this.statusPath, status);
  }

  status(): SchedulerStatus | null {
    return readJson<SchedulerStatus>(this.statusPath);
  }
}
