// The execution unit of one seat launch (design 6.2, 7.1): the unit supervisor's config that
// starts the seat host (host-main.ts) in the unit's control layer. A seat unit gets a longer
// stop grace than a program run: after a stop the host still ends Claude Code through the
// SDK (its graceful close takes about 2 s), captures the transcript, submits its pending
// results and writes its outcome; 10 s could cut that short and lose the report.

import { fileURLToPath } from 'node:url';
import type { LaunchId } from '../common/ids.ts';
import type { LayerLimits } from '../exec/cgroup.ts';
import { exportTempDir } from '../exec/export.ts';
import type { RetryPolicy } from '../exec/proof.ts';
import type { LaunchSupervisorOptions, SinkModuleRef, SupervisorConfig } from '../exec/supervisor.ts';

/** The seat host's entry point (no import: loading host.ts would load the Agent SDK). */
export const SEAT_HOST_MAIN = fileURLToPath(new URL('./host-main.ts', import.meta.url));

/** Decision 5 (2026-10-09): seat units get 30 s after a stop; program runs keep the 10 s default. */
export const SEAT_STOP_GRACE_MS = 30_000;

export interface SeatUnitOptions {
  readonly launch: LaunchId;
  readonly stateDir: string;
  /** The seat host's config file (a SeatHostConfig). */
  readonly hostConfigPath: string;
  /** The unit's limits: memory.max is its reservation (exec/resources.ts unitMemoryReservation). */
  readonly unit: LayerLimits;
  readonly sink: SinkModuleRef;
  /** The host's complete environment (a transient service inherits nothing). */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly nodePath?: string;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  readonly retry?: Partial<RetryPolicy>;
  readonly stopScope?: SupervisorConfig['stopScope'];
  readonly cleanup?: SupervisorConfig['cleanup'];
  /**
   * The content store's root: the launch's export directory there (exec/export.ts
   * exportTempDir) is created by the supervisor before the host runs, bound to its identity,
   * and removed at the end, also when the host dies mid-export.
   */
  readonly contentRoot?: string;
  /** Default SEAT_STOP_GRACE_MS. */
  readonly stopGraceMs?: number;
}

export function seatUnitConfig(o: SeatUnitOptions): LaunchSupervisorOptions['config'] {
  return {
    launch: o.launch,
    stateDir: o.stateDir,
    host: {
      argv: [o.nodePath ?? process.execPath, '--experimental-strip-types', '--disable-warning=ExperimentalWarning', SEAT_HOST_MAIN, o.hostConfigPath],
      env: o.env,
      cwd: o.cwd,
      ...(o.stdoutPath !== undefined ? { stdoutPath: o.stdoutPath } : {}),
      ...(o.stderrPath !== undefined ? { stderrPath: o.stderrPath } : {}),
    },
    unit: o.unit,
    sink: o.sink,
    stopGraceMs: o.stopGraceMs ?? SEAT_STOP_GRACE_MS,
    ...(o.retry !== undefined ? { retry: o.retry } : {}),
    ...(o.stopScope !== undefined ? { stopScope: o.stopScope } : {}),
    ...(o.cleanup !== undefined || o.contentRoot !== undefined
      ? { cleanup: { ...o.cleanup, scratchDirs: [...(o.cleanup?.scratchDirs ?? []), ...(o.contentRoot !== undefined ? [exportTempDir(o.contentRoot, o.launch)] : [])] } }
      : {}),
  };
}
