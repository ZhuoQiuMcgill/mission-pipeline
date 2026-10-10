// Small durable records the scheduler keeps in its state directory (a Linux filesystem), for
// facts that exist before (or beside) the ledger:
//
//  - prepared/<launch>.json: a seat launch prepared at admission (its directory and image,
//    bound to their identities as they were created) before the launch is registered. A crash
//    or a refusal in between leaves something only this record can clean up (code review r1
//    #11); the record goes once the launch's cleanup is done, or the preparation is released.
//  - ended-acceptances.json: acceptances that ended with "the derived state cannot be
//    computed" (WI-11, r1 #9), each with its attempt number and the attempt it retries, so
//    the re-registration after the next publication is linked to the original request.

import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../common/fsx.ts';
import type { LaunchId } from '../common/ids.ts';
import type { Demand } from './tasks.ts';

export interface PreparedRecord {
  readonly format: 'mp4.prepared-launch.v1';
  readonly launch: LaunchId;
  /** Cleanup resources (src/exec/cleanup.ts), filesystem ones bound to their identity. */
  readonly resources: readonly string[];
  /** What the preparation holds (counted while it cannot be released). */
  readonly demand: Demand | null;
  readonly at: number;
}

function preparedDir(stateDir: string): string {
  return join(stateDir, 'prepared');
}

export function writePrepared(stateDir: string, r: PreparedRecord): void {
  mkdirSync(preparedDir(stateDir), { recursive: true, mode: 0o700 });
  writeFileAtomic(join(preparedDir(stateDir), `${r.launch}.json`), `${JSON.stringify(r, null, 2)}\n`);
}

export function readPrepared(stateDir: string): PreparedRecord[] {
  let names: string[];
  try {
    names = readdirSync(preparedDir(stateDir));
  } catch {
    return [];
  }
  const out: PreparedRecord[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue;
    try {
      const r = JSON.parse(readFileSync(join(preparedDir(stateDir), n), 'utf8')) as PreparedRecord;
      if (r.format === 'mp4.prepared-launch.v1' && Array.isArray(r.resources)) out.push(r);
    } catch {
      /* an interrupted write leaves no file (atomic rename) */
    }
  }
  return out;
}

export function removePrepared(stateDir: string, launch: LaunchId): void {
  try {
    unlinkSync(join(preparedDir(stateDir), `${launch}.json`));
  } catch {
    /* gone */
  }
}

/** An acceptance that ended for want of the derived state (WI-11), awaiting its re-registration. */
export interface EndedAcceptance {
  /** The attempt number of the acceptance (1 for the first). */
  readonly attempt: number;
  /** The attempt it re-registers, or null for the first. */
  readonly retryOf: number | null;
  /** True while the attempt is ended (no publication since). */
  readonly ended: boolean;
  readonly reason: string;
  readonly at: number;
}

function endedPath(stateDir: string): string {
  return join(stateDir, 'ended-acceptances.json');
}

export function readEndedAcceptances(stateDir: string): Record<string, EndedAcceptance> {
  try {
    return JSON.parse(readFileSync(endedPath(stateDir), 'utf8')) as Record<string, EndedAcceptance>;
  } catch {
    return {};
  }
}

export function writeEndedAcceptances(stateDir: string, all: Record<string, EndedAcceptance>): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileAtomic(endedPath(stateDir), `${JSON.stringify(all, null, 2)}\n`);
}
