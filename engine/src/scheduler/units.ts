// What the scheduler knows about a running unit, and how it ends one (6.2, 6.3, 6.4).
//
// Identity is always (pid, start time, boot id) (6.3): a pid alone can be reused, and a
// process of another boot is gone. The supervisor's identity is the file it writes at start
// (src/exec/supervisor.ts); a seat host's is its control-plane heartbeat. The unit's cgroup
// (the subtree the supervisor builds inside its transient service) tells whether anything of
// the unit still runs, whatever wrote heartbeats.
//
// The system calls go through two small interfaces so a test can inject a fault (a process
// that cannot be ended) without faking anything else.

import { existsSync, readFileSync } from 'node:fs';
import type { LaunchId } from '../common/ids.ts';
import { CGROUP_FS, Cgroup } from '../exec/cgroup.ts';
import {
  bootId,
  defaultUnitName,
  isProcessAlive as execIsProcessAlive,
  killUnit,
  launchUnitSupervisor,
  readSupervisorIdentity,
  stopUnit,
  unitActiveState,
  type LaunchSupervisorOptions,
  type LaunchedSupervisor,
  type SupervisorIdentity,
} from '../exec/supervisor.ts';
import type { ControlPlane, HostHeartbeat, ProcessIdentityJson } from './controlPlane.ts';

export interface Identity {
  readonly pid: number;
  /** /proc/<pid>/stat field 22; exec writes a number, the ledger's executor records a string. */
  readonly startTime: number | string;
  readonly bootId: string;
}

export interface KillResult {
  readonly sent: boolean;
  /** Why the signal could not be sent (EPERM...), if it could not. */
  readonly error: string | null;
}

/** Processes, by identity. */
export interface ProcessControl {
  alive(id: Identity): boolean;
  kill(id: Identity, signal: NodeJS.Signals): KillResult;
}

/** Transient systemd user services holding units (src/exec/supervisor.ts). */
export interface UnitControl {
  launch(opts: LaunchSupervisorOptions): Promise<LaunchedSupervisor>;
  /** systemctl stop: SIGTERM to the supervisor only (KillMode=mixed), SIGKILL after TimeoutStopSec. */
  stop(unitName: string, timeoutMs: number): Promise<void>;
  /** SIGKILL to everything in the service. */
  kill(unitName: string): Promise<void>;
  activeState(unitName: string): Promise<string>;
}

export const systemProcesses: ProcessControl = {
  alive(id: Identity): boolean {
    return execIsProcessAlive({ pid: id.pid, startTime: Number(id.startTime), bootId: id.bootId });
  },
  kill(id: Identity, signal: NodeJS.Signals): KillResult {
    if (!systemProcesses.alive(id)) return { sent: false, error: null };
    try {
      process.kill(id.pid, signal);
      return { sent: true, error: null };
    } catch (e) {
      return { sent: false, error: (e as NodeJS.ErrnoException).code ?? String(e) };
    }
  },
};

export const systemUnits: UnitControl = {
  launch: (opts) => launchUnitSupervisor(opts),
  stop: (unitName, timeoutMs) => stopUnit(unitName, timeoutMs),
  kill: (unitName) => killUnit(unitName),
  activeState: (unitName) => unitActiveState(unitName),
};

/** The transient service of a launch; derived from the launch id (v35: resources are named by it). */
export function unitNameOf(launch: LaunchId): string {
  return defaultUnitName(launch);
}

/**
 * The unit subtree of a launch's service, derived from the unit name: transient user
 * services live in app.slice of the user's manager (probed 2026-10-09).
 */
export function derivedUnitCgroupPath(unitName: string): string {
  const uid = process.getuid?.() ?? -1;
  return `${CGROUP_FS}/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unitName}/unit`;
}

/** The unit subtree from the live supervisor's own cgroup, when it can still be read. */
export function unitCgroupOfSupervisor(sup: Identity): string | null {
  try {
    const line = readFileSync(`/proc/${sup.pid}/cgroup`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'));
    if (!line) return null;
    const rel = line.slice(3).trim();
    // the supervisor sits in <service>/sup; the unit is <service>/unit
    if (!rel.endsWith('/sup')) return null;
    return `${CGROUP_FS}${rel.slice(0, -'/sup'.length)}/unit`;
  } catch {
    return null;
  }
}

/** True when some process of the unit still runs; false when the subtree is empty or gone. */
export function unitPopulated(path: string): boolean {
  try {
    const cg = Cgroup.at(path);
    if (!cg.exists()) return false;
    return cg.populated();
  } catch {
    return false;
  }
}

export function unitProcesses(path: string): number[] {
  try {
    return Cgroup.at(path).allProcs();
  } catch {
    return [];
  }
}

/** cgroup.kill on the unit subtree: every host, seat and run process; never the supervisor (7.1). */
export function killUnitSubtree(path: string): boolean {
  try {
    const cg = Cgroup.at(path);
    if (!cg.exists()) return false;
    cg.kill();
    return true;
  } catch {
    return false;
  }
}

export function supervisorIdentity(stateDir: string, launch: LaunchId): SupervisorIdentity | null {
  try {
    return readSupervisorIdentity(stateDir, launch);
  } catch {
    return null;
  }
}

export function asIdentity(x: ProcessIdentityJson | SupervisorIdentity | HostHeartbeat): Identity {
  return { pid: x.pid, startTime: x.startTime, bootId: x.bootId };
}

/** A host's identity and the time of its last heartbeat, from the control plane. */
export function hostHeartbeat(cp: ControlPlane, launch: LaunchId): { identity: Identity; at: number } | null {
  const hb = cp.readHostHeartbeat(launch);
  if (!hb || typeof hb.pid !== 'number' || typeof hb.bootId !== 'string' || hb.startTime === undefined) return null;
  return { identity: asIdentity(hb), at: Number(hb.at) };
}

/** Whether a host process really belongs to this unit: its cgroup is the unit's control layer. */
export function inUnit(pid: number, unitName: string): boolean {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'));
    return line !== undefined && line.includes(`/${unitName}/unit/`);
  } catch {
    return false;
  }
}

export function currentBootId(): string {
  return bootId();
}

export function pathExists(p: string): boolean {
  return existsSync(p);
}
