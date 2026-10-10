// "This unit was ended because a stop covers it" (design 6.4), recorded by whoever ended it: the
// unit supervisor (its stop watcher saw a covering stop in the control-plane spool, a stop file,
// or a SIGTERM while a covering stop is spooled), the seat host (its heartbeat saw a covering
// stop), or the scheduler's stop executor (a committed stop: it stops the unit itself). Written durably to <stateDir>/units/<launch>/ended-by-stop.json BEFORE the proof, so
// whoever classifies the attempt by its proof finds it: an attempt ended by a stop is stopped
// (cancelled), not an environment failure; it takes nothing from the env-retry budget and needs
// no quarantine notice, whether the stop is still in force (the ledger's cancelled record is the
// source of truth) or was released, or mistaken, before the attempt was classified. A SIGTERM
// with no covering stop is not recorded: it stays an environment failure.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LaunchId } from '../common/ids.ts';
import { stagedStopsInForce, stopCovers, type ScopeTag } from '../ledger/stops.ts';
import { REAL_DURABLE_OPS, ensureDirChainDurable, writeDurable } from './durable.ts';

export const ENDED_BY_STOP_FORMAT = 'mp4.ended-by-stop.v1';

export interface EndedByStop {
  readonly format: typeof ENDED_BY_STOP_FORMAT;
  readonly launch: LaunchId;
  readonly at: string;
  /** Who ended the unit. */
  readonly by: 'supervisor' | 'host' | 'scheduler';
  /** How the stop reached it. */
  readonly via: 'spool' | 'file' | 'signal';
  /** The covering stops seen (empty when only a stop file named it). */
  readonly stops: readonly string[];
  readonly detail: string;
}

export function endedByStopPath(stateDir: string, launch: LaunchId): string {
  return join(stateDir, 'units', launch, 'ended-by-stop.json');
}

/** Records the cause once (the first record stays: the stop that ended the unit). Best effort: never throws. */
export function recordEndedByStop(stateDir: string, launch: LaunchId, cause: Omit<EndedByStop, 'format' | 'launch' | 'at'>): boolean {
  const path = endedByStopPath(stateDir, launch);
  try {
    if (existsSync(path)) return true;
    ensureDirChainDurable(join(stateDir, 'units', launch), stateDir, REAL_DURABLE_OPS);
    const rec: EndedByStop = { format: ENDED_BY_STOP_FORMAT, launch, at: new Date().toISOString(), ...cause, stops: [...cause.stops] };
    writeDurable(path, `${JSON.stringify(rec)}\n`, REAL_DURABLE_OPS);
    return true;
  } catch {
    return false;
  }
}

export function readEndedByStop(stateDir: string, launch: LaunchId): EndedByStop | null {
  try {
    const r = JSON.parse(readFileSync(endedByStopPath(stateDir, launch), 'utf8')) as EndedByStop;
    if (r.format !== ENDED_BY_STOP_FORMAT || r.launch !== launch || !Array.isArray(r.stops)) return null;
    return r;
  } catch {
    return null;
  }
}

/** The ids of the staged stops in force covering `tag` (the control plane's fast signal, 6.4; released stops left out); empty on any error. */
export function coveringSpoolStops(scope: { readonly controlPlane: string; readonly tag: ScopeTag } | undefined): string[] {
  if (scope === undefined) return [];
  try {
    return stagedStopsInForce({ inbox: join(scope.controlPlane, '.no-inbox'), controlPlane: scope.controlPlane })
      .filter((r) => stopCovers(r.scope, scope.tag))
      .map((r) => r.stop as string);
  } catch {
    return [];
  }
}
