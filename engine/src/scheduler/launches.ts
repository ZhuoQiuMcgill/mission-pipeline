// What the scheduler remembers about each launch beyond the ledger (6.2, 6.3): which task and
// lineage it belongs to, whether it is a seat unit (7.1 check 1), whether its host beats, its
// unit name and deadline. Kept durably in the state directory (a Linux filesystem), and as a
// host-manifest copy in the control plane for stops during a storage fault (6.1).

import { mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../common/fsx.ts';
import type { Generation, LaunchId } from '../common/ids.ts';
import type { ScopeTag } from '../ledger/stops.ts';

export interface LaunchMeta {
  readonly format: 'mp4.launch-meta.v1';
  readonly launch: LaunchId;
  readonly task: string | null;
  readonly lineage: string | null;
  readonly tag: ScopeTag;
  readonly unitName: string;
  readonly seatUnit: boolean;
  readonly heartbeat: boolean;
  readonly gen: Generation;
  readonly dispatchedAt: number;
  readonly timeoutMs: number | null;
  readonly mode: 'stable' | 'fast';
  /** The unit's peak reservation (6.5): counted until its cleanup is done. */
  readonly demand?: { readonly memoryBytes: number; readonly diskBytes: number; readonly inodes: number };
}

export function launchMetaDir(stateDir: string): string {
  return join(stateDir, 'launches');
}

export function writeLaunchMeta(stateDir: string, meta: LaunchMeta): void {
  mkdirSync(launchMetaDir(stateDir), { recursive: true, mode: 0o700 });
  writeFileAtomic(join(launchMetaDir(stateDir), `${meta.launch}.json`), `${JSON.stringify(meta, null, 2)}\n`);
}

export function readLaunchMeta(stateDir: string, launch: LaunchId): LaunchMeta | null {
  try {
    const m = JSON.parse(readFileSync(join(launchMetaDir(stateDir), `${launch}.json`), 'utf8')) as LaunchMeta;
    return m.format === 'mp4.launch-meta.v1' ? m : null;
  } catch {
    return null;
  }
}

export function removeLaunchMeta(stateDir: string, launch: LaunchId): void {
  try {
    unlinkSync(join(launchMetaDir(stateDir), `${launch}.json`));
  } catch {
    /* gone */
  }
}

export function allLaunchMeta(stateDir: string): LaunchMeta[] {
  let names: string[];
  try {
    names = readdirSync(launchMetaDir(stateDir));
  } catch {
    return [];
  }
  const out: LaunchMeta[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue;
    const m = readLaunchMeta(stateDir, n.slice(0, -'.json'.length) as LaunchId);
    if (m) out.push(m);
  }
  return out;
}
