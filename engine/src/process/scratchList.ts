// 4.4 (F6, H-3): `mp read scratch`: the worktrees, shared checkouts and scratch folders under
// `.mission-pipeline/`, each with its size, owner and age; the project's free disk; the limits of
// config.json and whether one is passed. A read: it writes nothing and removes nothing (`mp pm clean`
// and the sweep of `mp pm next` do that).

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sharedCheckoutsRoot } from '../git/workspace.ts';
import { checkOwner, dropOwnerLock, TRASH_PREFIX, treeBytes } from '../memory/scratch.ts';
import type { DiskLimits, ProcessContext } from './context.ts';
import { CHECKOUT_EVENT } from './housekeeping.ts';
import { diskLimitPassed, worktreeFolders } from './holds.ts';

export interface ScratchEntry {
  readonly kind: 'worktree' | 'checkout' | 'scratch';
  /** Relative to the project folder. */
  readonly path: string;
  readonly bytes: number;
  /** Who it belongs to, in words: a dispatch and its state, the dispatches that hold a checkout, an mp process. */
  readonly owner: string;
  /** Since its dispatch was claimed, else since it last changed; null when it cannot be read. */
  readonly ageMs: number | null;
}

export interface ScratchReport {
  readonly entries: readonly ScratchEntry[];
  readonly totals: Readonly<Record<ScratchEntry['kind'], { readonly count: number; readonly bytes: number }>>;
  /** Free bytes of the project's disk (null: they cannot be read). */
  readonly freeBytes: number | null;
  readonly limits: DiskLimits;
  /** The limit passed now (new Constructor steps wait), or null. */
  readonly passed: string | null;
}

const COMMIT_NAME = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const LEAVES_PENDING = '.leaves-pending';

function mtimeAge(abs: string, now: number): number | null {
  try {
    return Math.max(0, now - lstatSync(abs).mtimeMs);
  } catch {
    return null;
  }
}

function sizeOf(abs: string): number {
  try {
    const st = lstatSync(abs);
    return st.isDirectory() ? treeBytes(abs) : st.size;
  } catch {
    return 0;
  }
}

/** The listing, with the dispatches read in one snapshot. */
export function scratchListing(ctx: ProcessContext): ScratchReport {
  const now = Date.now();
  const paths = ctx.memory.paths;
  const { dispatches, holders } = ctx.memory.read((db) => {
    const rows = db.stmt('SELECT dispatch, seat, mission, state, released, created_at FROM dispatches').all() as Array<{ dispatch: string; seat: string; mission: string; state: string; released: string | null; created_at: number }>;
    const flying = new Set(rows.filter((r) => r.state === 'in-flight').map((r) => r.dispatch));
    const holders = new Map<string, string[]>();
    for (const e of db.stmt('SELECT line, key FROM flow_events WHERE event = ? ORDER BY revision').all(CHECKOUT_EVENT) as Array<{ line: string; key: string }>) {
      const d = e.line.startsWith('dispatch:') ? e.line.slice('dispatch:'.length) : null;
      if (d !== null && flying.has(d)) holders.set(e.key, [...(holders.get(e.key) ?? []), d]);
    }
    return { dispatches: new Map(rows.map((r) => [r.dispatch, r])), holders };
  });
  const ownerOf = (dispatch: string): string | null => {
    const d = dispatches.get(dispatch);
    if (d === undefined) return null;
    const state = d.state === 'in-flight' ? 'in flight' : d.state === 'handed-back' ? 'handed back: mp pm next or mp pm clean removes it' : d.released === 'abandoned' ? 'released --abandoned: kept until --ended' : 'released: mp pm next or mp pm clean removes it';
    return `dispatch ${dispatch} (${d.seat}, ${d.mission}), ${state}`;
  };
  const byOwnerLock = (abs: string): string => {
    const c = checkOwner(paths, abs);
    if (c.state === 'live') return 'its owner, an mp process, is running';
    if (c.state === 'gone') {
      // the lock the check took is given back at once, its file kept: the sweep decides, not this read
      dropOwnerLock(c, { keepFile: true });
      return 'its owner is gone: the next sweep removes it';
    }
    return 'no owner recorded';
  };
  const entries: ScratchEntry[] = [];
  for (const name of worktreeFolders(paths.worktrees)) {
    const abs = join(paths.worktrees, name);
    const d = dispatches.get(name);
    entries.push({ kind: 'worktree', path: `.mission-pipeline/worktrees/${name}`, bytes: sizeOf(abs), owner: ownerOf(name) ?? 'no dispatch of this memory names it', ageMs: d !== undefined ? Math.max(0, now - Number(d.created_at)) : mtimeAge(abs, now) });
  }
  const checkouts = sharedCheckoutsRoot(paths);
  let names: string[] = [];
  try {
    names = readdirSync(checkouts).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const abs = join(checkouts, name);
    const held = holders.get(name) ?? [];
    const owner = COMMIT_NAME.test(name) ? (held.length > 0 ? `held by ${held.join(', ')} (in flight)` : 'no dispatch in flight holds it: the next sweep removes it') : name.startsWith('.build-') ? `being built: ${byOwnerLock(abs)}` : 'not known to mp';
    entries.push({ kind: 'checkout', path: `.mission-pipeline/tmp/checkouts/${name}`, bytes: sizeOf(abs), owner, ageMs: mtimeAge(abs, now) });
  }
  let tmp: string[] = [];
  try {
    tmp = readdirSync(paths.tmp).sort();
  } catch {
    tmp = [];
  }
  for (const name of tmp) {
    if (name === 'checkouts' || name === LEAVES_PENDING) continue;
    const abs = join(paths.tmp, name);
    let dir = false;
    try {
      dir = lstatSync(abs).isDirectory();
    } catch {
      continue;
    }
    const owner = !dir ? 'a file mp did not make' : name.startsWith(TRASH_PREFIX) ? 'in the trash: the next sweep deletes it' : ownerOf(name) ?? byOwnerLock(abs);
    entries.push({ kind: 'scratch', path: `.mission-pipeline/tmp/${name}`, bytes: sizeOf(abs), owner, ageMs: mtimeAge(abs, now) });
  }
  const total = (kind: ScratchEntry['kind']) => {
    const xs = entries.filter((e) => e.kind === kind);
    return { count: xs.length, bytes: xs.reduce((n, e) => n + e.bytes, 0) };
  };
  return { entries, totals: { worktree: total('worktree'), checkout: total('checkout'), scratch: total('scratch') }, freeBytes: ctx.diskFree(), limits: ctx.limits, passed: diskLimitPassed(ctx) };
}
