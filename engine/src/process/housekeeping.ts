// Disk housekeeping under `.mission-pipeline/tmp/` (4.1.2; design "Execution redundancy",
// items 2 and 3: more than a step needs, leftovers).
//
//   shared checkouts  The seats that read one commit share `tmp/checkouts/<commit>/`, built
//                     atomically and read-only (workspace.ts ensureSharedCheckout). A dispatch that
//                     runs `mp seat <id> checkout` HOLDS it: a flow event `checkout` (key: the
//                     commit) on its dispatch line. The holders are the dispatches IN FLIGHT with
//                     that event, so a hand-back or a release ends a hold with nothing of its own
//                     to write; the checkout goes when no dispatch in flight holds it. One lock per
//                     commit (`locks/checkout-<commit>.lock`) serializes the build, the holders'
//                     check and the removal: a seat never loses a checkout it was just given.
//   tmp/<dispatch>/   The hand-back files. Removed once the hand-back is recorded (they were read
//                     first) and on release; what cannot be removed now is a note, and the sweep
//                     retries.
//   the sweep         `mp pm next` runs it within a small time budget, `mp pm clean` whole. It
//                     removes what nobody alive owns: scratch directories whose owner lock is free
//                     (memory/scratch.ts), the tmp/<dispatch>/ of dispatches no longer in flight,
//                     shared checkouts no dispatch in flight holds, the trash, and directories of
//                     the known scratch kinds made before owners existed (4.1.1) once they are a
//                     day old. It never touches `tmp/.leaves-pending/`, a directory whose owner is
//                     alive, the directory of a dispatch in flight, or an entry it does not know.

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../common/hash.ts';
import type { ContentHash, MissionId } from '../common/ids.ts';
import { dispatchTmpDir, ensureSharedCheckout, sharedCheckoutsRoot, trashSharedCheckout, workspaceDir } from '../git/workspace.ts';
import { appendRecords, dispatchInfo, flowEventExists, flowEvents, listDispatches, lock, tryLock, type Db, type DispatchInfo } from '../memory/index.ts';
import { checkOwner, dropOwnerLock, moveToTrash, removeOrphanOwnerLocks, removeTree, TRASH_PREFIX, treeBytes } from '../memory/scratch.ts';
import type { ProcessContext } from './context.ts';
import { DISPATCH_LINE } from './ports.ts';

/** The flow event of a dispatch line that records a hold on a shared checkout (key: the commit). */
export const CHECKOUT_EVENT = 'checkout';
/** `mp pm next` sweeps for at most this long (it never makes `next` slow; the rest waits for the next call). */
export const SWEEP_BUDGET_MS = 1_500;
/** A hand-back or a release deletes its directories for at most this long; the sweep finishes them. */
export const END_BUDGET_MS = 2_000;
/** How long `mp seat <id> checkout` waits while another process builds or removes the same checkout. */
export const CHECKOUT_WAIT_MS = 10 * 60_000;
/** A scratch directory of a known kind with no owner recorded (made before 4.1.2) is swept once it is this old. */
export const UNOWNED_AGE_MS = 24 * 60 * 60_000;
/** The scratch directories `mp` made under tmp/ before they had owners (4.1.1). */
const UNOWNED_KINDS = ['run-', 'rerun-', 'checkout-attr-', 'snapshot-', 'collect-', 'compare-', 'deliver-'];
const COMMIT_NAME = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const LEAVES_PENDING = '.leaves-pending';

function checkoutLockName(commit: string): string {
  return `checkout-${commit.slice(0, 40)}`;
}

/** True when a dispatch in flight holds the shared checkout of `commit`. */
function heldByInFlight(db: Db, commit: string): boolean {
  return listDispatches(db, { state: 'in-flight', limit: 10_000 }).some((d) => flowEventExists(db, { mission: d.mission, line: DISPATCH_LINE(d.dispatch), event: CHECKOUT_EVENT, key: commit }));
}

/** The commits a dispatch holds (whatever its state). */
function holdsOf(db: Db, d: Pick<DispatchInfo, 'mission' | 'dispatch'>): string[] {
  return flowEvents(db, { mission: d.mission, line: DISPATCH_LINE(d.dispatch), event: CHECKOUT_EVENT, limit: 10_000 }).map((e) => e.key);
}

/**
 * `mp seat <id> checkout` for a commit (4.1.2): the dispatch's hold is recorded, then the shared
 * checkout is built unless it is there; under the commit's lock, so a removal never runs between
 * the two. Waits while another process builds or removes it (LOCKED after CHECKOUT_WAIT_MS).
 */
export async function holdSharedCheckout(ctx: ProcessContext, d: DispatchInfo, commit: string): Promise<{ readonly path: string; readonly commit: string; readonly built: boolean }> {
  const l = lock(ctx.memory.paths.locks, checkoutLockName(commit), { waitMs: CHECKOUT_WAIT_MS });
  try {
    ctx.memory.write({ op: `checkout:${d.dispatch}:${commit}`, payload: { dispatch: d.dispatch, commit } }, (tx) => {
      if (flowEventExists(tx, { mission: d.mission, line: DISPATCH_LINE(d.dispatch), event: CHECKOUT_EVENT, key: commit })) return;
      appendRecords(tx, [{ kind: 'flow.event', mission: d.mission, line: DISPATCH_LINE(d.dispatch), event: CHECKOUT_EVENT, key: commit, body: tx.data.put(canonicalJson({ commit })) as ContentHash }]);
    });
    const r = await ensureSharedCheckout(ctx.gitCtx, commit);
    return { path: r.dir, commit, built: r.built };
  } finally {
    l.release();
  }
}

/**
 * The shared checkout of `commit` removed when no dispatch in flight holds it and nobody is
 * building or removing it now (busy: the sweep comes back to it). The commit's lock covers the
 * holders' check and the rename into the trash only; the trash is deleted after it.
 */
function releaseSharedCheckout(ctx: ProcessContext, commit: string, deadline: number): 'removed' | 'held' | 'busy' | 'absent' | 'partly' {
  const l = tryLock(ctx.memory.paths.locks, checkoutLockName(commit));
  if (l === null) return 'busy';
  let trash: string | null;
  try {
    if (ctx.memory.read((db) => heldByInFlight(db, commit))) return 'held';
    trash = trashSharedCheckout(ctx.gitCtx, commit);
  } finally {
    l.release();
  }
  if (trash === null) return 'absent';
  return removeTree(trash, { deadline }).done ? 'removed' : 'partly';
}

/**
 * A dispatch is over (its hand-back is recorded, or it was released): its `tmp/<dispatch>/` is
 * removed, and each shared checkout it held that no dispatch in flight holds any more. Within
 * END_BUDGET_MS; what is left (a file held open, a big tree) is the sweep's. Returns the notes
 * for the seat or the PM. Nothing happens for a dispatch still in flight.
 */
export function dispatchOver(ctx: ProcessContext, dispatch: string, budgetMs = END_BUDGET_MS): string[] {
  const info = ctx.memory.read((db) => dispatchInfo(db, dispatch));
  if (info === null || info.state === 'in-flight') return [];
  const deadline = Date.now() + budgetMs;
  const notes: string[] = [];
  try {
    const trash = moveToTrash(ctx.memory.paths, dispatchTmpDir(ctx.memory.paths, dispatch));
    if (trash !== null) removeTree(trash, { deadline });
  } catch (e) {
    notes.push(`.mission-pipeline/tmp/${dispatch}/ could not be removed now (${(e as Error).message}); mp pm next removes it later`);
  }
  for (const commit of ctx.memory.read((db) => holdsOf(db, info))) {
    try {
      releaseSharedCheckout(ctx, commit, deadline);
    } catch (e) {
      notes.push(`the shared checkout of ${commit} could not be removed now (${(e as Error).message}); mp pm next removes it later`);
    }
  }
  return notes;
}

// ---------------------------------------------------------------- the sweep

export interface SweptEntry {
  /** Its path under tmp/ when it was decided (a trash name for what an earlier call left). */
  readonly path: string;
  readonly why: string;
  /** Deleted completely in this call (else it waits in the trash). */
  readonly done: boolean;
  /** Bytes freed by this call (when counted). */
  readonly bytes: number;
}

export interface SweepReport {
  readonly removed: readonly SweptEntry[];
  /** Bytes freed (when counted: `mp pm clean`). */
  readonly bytes: number;
  /** Trash directories not yet deleted (the budget ran out, or a file is held open). */
  readonly pending: number;
  /** What was left and why: a live owner, a dispatch in flight, a held checkout, an unknown entry. */
  readonly kept: ReadonlyArray<{ readonly path: string; readonly why: string }>;
  /** Owner lock files of directories already gone, removed. */
  readonly orphanLocks: number;
}

function ageMs(abs: string, now: number): number {
  try {
    return now - lstatSync(abs).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The sweep (4.1.2): decide what nobody alive owns and move it into the trash (cheap renames), then
 * delete the trash until the budget runs out. `mission`: only that mission's dispatch directories
 * (scratch with no live owner, unheld checkouts and the trash belong to no mission and always go).
 */
export function sweepTmp(ctx: ProcessContext, o: { readonly budgetMs: number; readonly mission?: MissionId | null; readonly bytes?: boolean }): SweepReport {
  const paths = ctx.memory.paths;
  const deadline = Date.now() + o.budgetMs;
  const now = Date.now();
  const kept: Array<{ path: string; why: string }> = [];
  const decided: Array<{ path: string; why: string; trash: string }> = [];
  const earlier: string[] = [];
  if (!existsSync(paths.tmp)) return { removed: [], bytes: 0, pending: 0, kept, orphanLocks: 0 };

  /** False: it is still there (it could not be moved now). */
  const toTrash = (rel: string, abs: string, why: string): boolean => {
    try {
      const trash = moveToTrash(paths, abs);
      if (trash !== null) decided.push({ path: rel, why, trash });
      return true;
    } catch (e) {
      kept.push({ path: rel, why: `cannot be moved now (${(e as Error).message}); tried again next time` });
      return false;
    }
  };
  /** Decided by its owner lock, or (`unownedKind`) by age as a scratch directory made before owners existed; false: neither applies. */
  const byOwner = (rel: string, abs: string, unownedKind: boolean): boolean => {
    const c = checkOwner(paths, abs);
    if (c.state === 'live') {
      kept.push({ path: rel, why: 'its owner is running' });
      return true;
    }
    if (c.state === 'gone') {
      let moved = false;
      try {
        moved = toTrash(rel, abs, 'its owner is gone');
      } finally {
        dropOwnerLock(c, { keepFile: !moved });
      }
      return true;
    }
    if (!unownedKind) return false;
    if (ageMs(abs, now) >= UNOWNED_AGE_MS) toTrash(rel, abs, 'no owner recorded (made before 4.1.2), older than a day');
    else kept.push({ path: rel, why: 'no owner recorded, younger than a day' });
    return true;
  };

  for (const name of readdirSync(paths.tmp)) {
    if (Date.now() > deadline) break;
    if (name === LEAVES_PENDING) continue;
    const abs = join(paths.tmp, name);
    if (name.startsWith(TRASH_PREFIX)) {
      earlier.push(abs);
      continue;
    }
    let isDir = false;
    try {
      isDir = lstatSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) {
      kept.push({ path: name, why: 'not a directory mp made' });
      continue;
    }
    if (name === 'checkouts') {
      sweepSharedCheckouts(ctx, deadline, kept, toTrash, byOwner);
      continue;
    }
    if (byOwner(name, abs, false)) continue;
    const d = ctx.memory.read((db) => dispatchInfo(db, name));
    if (d !== null) {
      if (d.state === 'in-flight') kept.push({ path: name, why: 'its dispatch is in flight' });
      else if (o.mission !== undefined && o.mission !== null && d.mission !== o.mission) kept.push({ path: name, why: `dispatch of mission ${d.mission} (not swept with --mission ${o.mission})` });
      else toTrash(name, abs, `dispatch ${d.state === 'released' ? 'released' : 'handed back'}`);
      continue;
    }
    if (UNOWNED_KINDS.some((k) => name.startsWith(k))) {
      byOwner(name, abs, true);
      continue;
    }
    kept.push({ path: name, why: 'not known to mp' });
  }

  // Delete the trash (this call's decisions first, then what earlier calls left) until the budget runs out.
  const removed: SweptEntry[] = [];
  let bytes = 0;
  let pending = 0;
  for (const t of [...decided.map((x) => ({ path: x.path, why: x.why, trash: x.trash })), ...earlier.map((abs) => ({ path: abs.slice(paths.tmp.length + 1), why: 'left in the trash by an earlier removal', trash: abs }))]) {
    if (Date.now() > deadline) {
      pending++;
      if (decided.some((x) => x.trash === t.trash)) removed.push({ path: t.path, why: t.why, done: false, bytes: 0 });
      continue;
    }
    try {
      const r = removeTree(t.trash, { deadline, bytes: o.bytes === true });
      bytes += r.bytes;
      if (!r.done) pending++;
      removed.push({ path: t.path, why: t.why, done: r.done, bytes: r.bytes });
    } catch (e) {
      pending++;
      kept.push({ path: t.path, why: `in the trash, cannot be deleted now (${(e as Error).message})` });
    }
  }
  const orphanLocks = Date.now() > deadline ? 0 : removeOrphanOwnerLocks(paths, deadline);
  return { removed, bytes, pending, kept, orphanLocks };
}

function sweepSharedCheckouts(
  ctx: ProcessContext,
  deadline: number,
  kept: Array<{ path: string; why: string }>,
  toTrash: (rel: string, abs: string, why: string) => boolean,
  byOwner: (rel: string, abs: string, unownedKind: boolean) => boolean,
): void {
  const root = sharedCheckoutsRoot(ctx.memory.paths);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (Date.now() > deadline) return;
    const rel = `checkouts/${name}`;
    const abs = join(root, name);
    if (!COMMIT_NAME.test(name)) {
      // a checkout being built: its builder owns it
      if (!byOwner(rel, abs, name.startsWith('.build-'))) kept.push({ path: rel, why: 'not known to mp' });
      continue;
    }
    const l = tryLock(ctx.memory.paths.locks, checkoutLockName(name));
    if (l === null) {
      kept.push({ path: rel, why: 'being built or removed by another mp process' });
      continue;
    }
    try {
      if (ctx.memory.read((db) => heldByInFlight(db, name))) kept.push({ path: rel, why: 'held by a dispatch in flight' });
      else toTrash(rel, abs, 'no dispatch in flight holds it');
    } finally {
      l.release();
    }
  }
}

// ---------------------------------------------------------------- mp pm clean

export interface CleanReport extends SweepReport {
  /** Worktrees of dispatches that are over (handed back, released ended), removed. */
  readonly worktrees: ReadonlyArray<{ readonly dispatch: string; readonly path: string; readonly bytes: number }>;
  /** Worktrees that could not be removed, and why. */
  readonly worktreesKept: ReadonlyArray<{ readonly dispatch: string; readonly why: string }>;
  /** Everything freed: the sweep's bytes and the worktrees'. */
  readonly totalBytes: number;
}

/**
 * `mp pm clean [--mission <m>]` (4.1.2): the whole sweep now, without the per-call budget, and the
 * worktrees of dispatches that are over (those `mp pm next` tidies). Safe while other `mp`
 * processes work: it removes only what has no live owner. Reports what went and the bytes freed.
 */
export function pmClean(ctx: ProcessContext, o: { readonly mission?: MissionId | null } = {}): CleanReport {
  const worktrees: Array<{ dispatch: string; path: string; bytes: number }> = [];
  const worktreesKept: Array<{ dispatch: string; why: string }> = [];
  const mission = o.mission ?? null;
  const over = ctx.memory.read((db) =>
    [...listDispatches(db, { state: 'handed-back', limit: 10_000 }), ...listDispatches(db, { state: 'released', limit: 10_000 }).filter((d) => d.released === 'ended')].filter((d) => d.worktree !== null && (mission === null || d.mission === mission)),
  );
  const hold = ctx.memory.gitHold();
  for (const d of over) {
    const path = workspaceDir(ctx.memory.paths, d.dispatch);
    if (!existsSync(path)) continue;
    if (hold !== null) {
      worktreesKept.push({ dispatch: d.dispatch, why: `git writes are held (${hold.reason})` });
      continue;
    }
    const bytes = treeBytes(path);
    try {
      if (ctx.workspaces().remove(d.dispatch).removed) worktrees.push({ dispatch: d.dispatch, path: `.mission-pipeline/worktrees/${d.dispatch}`, bytes });
    } catch (e) {
      worktreesKept.push({ dispatch: d.dispatch, why: (e as Error).message });
    }
  }
  const sweep = sweepTmp(ctx, { budgetMs: Number.POSITIVE_INFINITY, mission, bytes: true });
  return { ...sweep, worktrees, worktreesKept, totalBytes: sweep.bytes + worktrees.reduce((n, w) => n + w.bytes, 0) };
}
