// Admission before dispatch (design 6.5): machine resources and spend.
//
// Machine (6.5 "机器资源"): live readings before every dispatch, never only the install-time
// measurement. For memory, disk bytes and inodes alike:
//     in-flight peak reservations + this unit's peak + the recovery reserve
//         <= what is free now + what the in-flight units already use
// (persistent use is whatever is not free and not used by in-flight units, so it is already
// outside the right-hand side). A refusal is a wait when the in-flight units' end would make
// room (they never wait on admission themselves, 6.2, so the wait ends), and "resource
// blocked" when the unit needs more than the whole machine.
//
// Spend (6.5 "花费"): with a limit, dispatch needs spent + in-flight reservations + this
// estimate <= limit. Unlimited never waits on spend.
//
// Async waits never hold reservations (6.2): reservations are counted only for launches whose
// unit is running; a task waiting for evidence, dependencies or admission holds none.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMachine, type MachineReading } from '../exec/resources.ts';
import type { SpendSummary } from './ledger.ts';
import type { Demand } from './tasks.ts';

export interface MachineProbe {
  read(): MachineReading;
  /** Memory the unit at this cgroup path uses now (memory.current), 0 if unknown. */
  unitMemory(cgroupPath: string): number;
}

export function systemProbe(diskPaths: readonly string[]): MachineProbe {
  return {
    read: () => readMachine(diskPaths),
    unitMemory: (path) => {
      try {
        return Number(readFileSync(join(path, 'memory.current'), 'utf8').trim()) || 0;
      } catch {
        return 0;
      }
    },
  };
}

export interface MachineAdmissionConfig {
  /** Evaluator pool and margin kept free in memory (6.1, 6.5). */
  readonly memoryReserveBytes: number;
  /** Space the ledger needs to recover (6.5 "恢复保留空间"). */
  readonly diskReserveBytes: number;
  readonly inodeReserve: number;
}

export interface InFlight {
  readonly demand: Demand;
  /** The unit cgroup, to read what it uses now. */
  readonly cgroup: string | null;
}

export type MachineDecision =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly decision: 'wait' | 'resource-blocked';
      readonly shortfalls: ReadonlyArray<{ readonly resource: 'memory' | 'disk' | 'inodes'; readonly missing: number }>;
    };

export class MachineAdmission {
  private readonly cfg: MachineAdmissionConfig;
  private readonly probe: MachineProbe;

  constructor(cfg: MachineAdmissionConfig, probe: MachineProbe) {
    this.cfg = cfg;
    this.probe = probe;
  }

  check(need: Demand, inFlight: readonly InFlight[]): MachineDecision {
    const m = this.probe.read();
    const disk = m.disks[0];
    const used = inFlight.reduce((s, u) => s + (u.cgroup === null ? 0 : this.probe.unitMemory(u.cgroup)), 0);
    const reserved = inFlight.reduce(
      (s, u) => ({ memory: s.memory + u.demand.memoryBytes, disk: s.disk + u.demand.diskBytes, inodes: s.inodes + u.demand.inodes }),
      { memory: 0, disk: 0, inodes: 0 },
    );
    const rows = [
      { resource: 'memory' as const, capacity: m.memAvailableBytes + used, whole: m.memTotalBytes, inFlight: reserved.memory, need: need.memoryBytes, reserve: this.cfg.memoryReserveBytes },
      ...(disk
        ? [
            { resource: 'disk' as const, capacity: disk.freeBytes, whole: disk.totalBytes, inFlight: reserved.disk, need: need.diskBytes, reserve: this.cfg.diskReserveBytes },
            { resource: 'inodes' as const, capacity: disk.freeInodes, whole: disk.totalInodes, inFlight: reserved.inodes, need: need.inodes, reserve: this.cfg.inodeReserve },
          ]
        : []),
    ];
    const shortfalls = rows.map((r) => ({ resource: r.resource, missing: r.inFlight + r.need + r.reserve - r.capacity, r })).filter((s) => s.missing > 0);
    if (shortfalls.length === 0) return { admitted: true };
    // Beyond the whole machine no wait can help; anything else waits for in-flight units to end.
    const beyondMachine = shortfalls.some((s) => s.r.need + s.r.reserve > s.r.whole);
    return {
      admitted: false,
      decision: beyondMachine ? 'resource-blocked' : 'wait',
      shortfalls: shortfalls.map((s) => ({ resource: s.resource, missing: s.missing })),
    };
  }
}

/** 6.5: with a limit, spent + in-flight reservations + this estimate must fit. */
export function spendAdmits(s: SpendSummary, estimateMicros: number): boolean {
  return s.limit === null || s.spent + s.inflight + estimateMicros <= s.limit;
}

/** What is left of the budget for new work (null: unlimited). */
export function budgetLeft(s: SpendSummary): number | null {
  return s.limit === null ? null : s.limit - s.spent - s.inflight;
}
