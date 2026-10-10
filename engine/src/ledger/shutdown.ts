// The clean shutdown sequence (design v45 6.1 "干净退出记录"), for the watchdog:
//   1. seal, under the control-plane lock entries take: an entry arriving after the
//      seal still writes the inboxes, but counts as arriving after the clean exit;
//   2. wait at most 5 s for the entries registered before the seal;
//   3. the ledger service (still running) commits the staging copy and both
//      inboxes, then exits, recording its clean exit in the control plane;
//   4. the probes confirm the entries ended, the staging copy holds no uncommitted
//      stop and the ledger exited cleanly, and only then write "clean exit".
// At most 30 s in all; past that the probes exit without the record and the next
// start treats the boot as an abnormal stop.

import { ControlState } from './controlState.ts';
import { readBootId } from './stops.ts';

export interface SealReport {
  readonly boot: string;
  readonly sealedAt: number;
  /** Entries registered before the seal that had not ended when it was set. */
  readonly entriesBeforeSeal: readonly string[];
}

/** Step 1. Idempotent: the first seal of a boot stands. */
export function sealStopEntries(controlPlane: string, opts: { boot?: string; now?: number } = {}): SealReport {
  const boot = opts.boot ?? readBootId();
  const control = new ControlState(controlPlane);
  try {
    const s = control.seal(boot, opts.now ?? Date.now());
    return { boot, sealedAt: s.at, entriesBeforeSeal: s.entriesBefore };
  } finally {
    control.close();
  }
}

/** Step 2: whether every entry registered before the seal ended within `timeoutMs`. */
export async function waitForEntriesBeforeSeal(controlPlane: string, boot: string, timeoutMs: number): Promise<boolean> {
  const control = new ControlState(controlPlane);
  try {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (control.openEntriesBeforeSeal(boot).length === 0) return true;
      if (Date.now() >= end) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    control.close();
  }
}

/** Step 3, called by the ledger service process as it exits (main.ts). */
export function recordLedgerExit(controlPlane: string, r: { boot: string; pid: number; clean: boolean; stagingEmpty: boolean }): void {
  const control = new ControlState(controlPlane);
  try {
    control.recordLedgerExit(r.boot, r.pid, r.clean, r.stagingEmpty, Date.now());
  } finally {
    control.close();
  }
}

export interface ShutdownReport {
  readonly seal: SealReport;
  readonly entriesDone: boolean;
  readonly ledgerExited: boolean;
  readonly probesDone: boolean;
  readonly elapsedMs: number;
}

/**
 * The whole sequence. `stopLedger` asks the ledger service to drain and exit
 * (SIGTERM to src/ledger/main.ts) and resolves true once it exited; `stopProbes`
 * asks the probes to finish (SIGTERM to probe-main.ts) and resolves once they
 * exited. Each gets the absolute deadline.
 */
export async function runCleanShutdown(o: {
  readonly controlPlane: string;
  readonly boot?: string;
  readonly stopLedger: (deadline: number) => Promise<boolean>;
  readonly stopProbes: (deadline: number) => Promise<boolean>;
  readonly entryWaitMs?: number;
  readonly totalMs?: number;
}): Promise<ShutdownReport> {
  const t0 = Date.now();
  const deadline = t0 + (o.totalMs ?? 30_000);
  const seal = sealStopEntries(o.controlPlane, { boot: o.boot ?? readBootId(), now: t0 });
  const entriesDone = await waitForEntriesBeforeSeal(o.controlPlane, seal.boot, Math.min(o.entryWaitMs ?? 5_000, deadline - Date.now()));
  const bounded = async (p: Promise<boolean>): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([p.catch(() => false), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  const ledgerExited = await bounded(o.stopLedger(deadline));
  const probesDone = await bounded(o.stopProbes(deadline));
  return { seal, entriesDone, ledgerExited, probesDone, elapsedMs: Date.now() - t0 };
}
