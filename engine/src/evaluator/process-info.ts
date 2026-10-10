// Facts about the current process (Linux /proc), for the evaluator's
// registration with the ledger (6.1, 6.3) and its resource reports (F13, F18).

import { readFileSync } from 'node:fs';

/** The identity the ledger binds an evaluator registration to: pid, start time (ticks since boot, /proc/<pid>/stat field 22), boot id. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly bootId: string;
}

export function selfIdentity(): ProcessIdentity {
  let startTime = '';
  let bootId = '';
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ')[19] ?? '';
  } catch {
    /* not Linux: no start time */
  }
  try {
    bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    /* not Linux */
  }
  return { pid: process.pid, startTime, bootId };
}

/** VmHWM (peak resident set) and VmRSS of a process in KiB, or nulls when unreadable. */
export function memoryStatus(pid: number | 'self' = 'self'): { vmHwmKb: number | null; vmRssKb: number | null } {
  try {
    const s = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k: string): number | null => {
      const m = new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(s);
      return m ? Number(m[1]) : null;
    };
    return { vmHwmKb: kb('VmHWM'), vmRssKb: kb('VmRSS') };
  } catch {
    return { vmHwmKb: null, vmRssKb: null };
  }
}

/** This process's cgroup v2 path, or null. */
export function ownCgroup(): string | null {
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'));
    return line ? line.slice(3) : null;
  } catch {
    return null;
  }
}
