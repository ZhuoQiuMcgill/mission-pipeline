// Scratch directories under `.mission-pipeline/tmp/` and their owners (4.1.2, design
// "Execution redundancy", leftovers).
//
// Every directory a process creates under tmp/ for its own work (a run's checkout, a checkout's
// attribute scratch, a collection's or a comparison's scratch, a shared checkout being built) has
// an OWNER: the process holds an SQLite exclusive lock in `locks/owners/<path under tmp>.lock`
// for the directory's whole life (locks.ts). The operating system releases that lock however the
// process exits, so a sweep tests whether the owner is gone by trying the lock; no process id is
// trusted. The order is fixed: the lock is taken BEFORE the directory is created and released
// only AFTER it is gone, so a directory whose owner is alive always has a held lock file.
//
// Removal goes by rename first: the directory is renamed to `tmp/.trash-<random>` (one atomic
// step: nobody ever sees half a tree at its own path), then deleted entry by entry within a time
// budget; what is left stays in the trash for the next sweep.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { LedgerError } from './errors.ts';
import { tryLockFile, type ProcessLock } from './locks.ts';
import type { MemoryPaths } from './paths.ts';

/** The owner locks' directory under `locks/`. */
export const OWNERS_DIR = 'owners';
/** Directories under tmp/ already decided for removal (renamed there, deleted within a budget). */
export const TRASH_PREFIX = '.trash-';

/** The owner locks this process holds, by lock file. */
const owned = new Map<string, ProcessLock>();

function relUnderTmp(paths: MemoryPaths, dir: string): string {
  const rel = relative(paths.tmp, dir);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new LedgerError('BAD_REQUEST', `a scratch directory goes under ${paths.tmp}, not ${dir}`);
  return rel;
}

/** The owner lock file of a directory under tmp/: `locks/owners/<its path under tmp>.lock`. */
export function ownerLockFile(paths: MemoryPaths, dir: string): string {
  return join(paths.locks, OWNERS_DIR, `${relUnderTmp(paths, dir)}.lock`);
}

/**
 * This process owns `dir` (under tmp/) from now until releaseOwner: call it BEFORE the directory
 * is created. Idempotent in one process; LOCKED when another process owns it.
 */
export function holdOwner(paths: MemoryPaths, dir: string): void {
  const file = ownerLockFile(paths, dir);
  const mine = owned.get(file);
  if (mine !== undefined && mine.held) return;
  mkdirSync(dirname(file), { recursive: true });
  const l = tryLockFile(file);
  if (l === null) throw new LedgerError('LOCKED', `${dir} belongs to another mp process that is still running`);
  owned.set(file, l);
}

/** True when this process owns `dir`. */
export function ownsDir(paths: MemoryPaths, dir: string): boolean {
  return owned.get(ownerLockFile(paths, dir))?.held === true;
}

function removeLockFile(file: string): void {
  for (const f of [file, `${file}-journal`]) {
    try {
      unlinkSync(f);
    } catch {
      /* absent, or still open elsewhere (Windows): an orphan lock file the sweep removes later */
    }
  }
}

/**
 * Give up the ownership of `dir`: the lock is released and its file removed (call once the
 * directory is gone). `keepFile`: the directory is still there; the free lock file tells the sweep
 * its owner is gone, so it is removed on the next sweep.
 */
export function releaseOwner(paths: MemoryPaths, dir: string, o: { readonly keepFile?: boolean } = {}): void {
  const file = ownerLockFile(paths, dir);
  const l = owned.get(file);
  if (l === undefined) return;
  owned.delete(file);
  l.release();
  if (o.keepFile !== true) removeLockFile(file);
}

/** A new directory `<parent>/<prefix><random>` owned by this process (`parent`: tmp/ or a directory under it). */
export function ownedTempDir(paths: MemoryPaths, prefix: string, parent: string = paths.tmp): string {
  mkdirSync(parent, { recursive: true });
  for (;;) {
    const dir = join(parent, `${prefix}${randomBytes(6).toString('hex')}`);
    holdOwner(paths, dir);
    try {
      mkdirSync(dir);
      return dir;
    } catch (e) {
      releaseOwner(paths, dir);
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/** Remove an owned directory, then give up its ownership. Best effort: what cannot be removed now is left with a free owner lock, which the next sweep reads as "owner gone". */
export function removeOwned(paths: MemoryPaths, dir: string): void {
  let gone = false;
  try {
    gone = removeTree(dir).done;
  } catch {
    /* left for the sweep */
  } finally {
    releaseOwner(paths, dir, { keepFile: !gone });
  }
}

export type OwnerCheck =
  /** The owner is gone; the caller now holds its lock: move the directory away, then dropOwnerLock. */
  | { readonly state: 'gone'; readonly file: string; readonly lock: ProcessLock }
  /** A process that is still running owns it (this one included). */
  | { readonly state: 'live' }
  /** No owner was ever recorded: made before 4.1.2, or by code that takes no ownership. */
  | { readonly state: 'none' };

/** Whether the owner of `dir` is still running (tried on its lock, never on a process id). */
export function checkOwner(paths: MemoryPaths, dir: string): OwnerCheck {
  const file = ownerLockFile(paths, dir);
  if (owned.get(file)?.held === true) return { state: 'live' };
  if (!existsSync(file)) return { state: 'none' };
  let lock: ProcessLock | null;
  try {
    lock = tryLockFile(file);
  } catch {
    return { state: 'live' }; // a lock file that cannot be read as one: nothing is decided on it
  }
  return lock === null ? { state: 'live' } : { state: 'gone', file, lock };
}

/** Release a lock checkOwner took from a gone owner, and remove its file (`keepFile`: the directory is still there, so the next sweep finds its owner gone again). */
export function dropOwnerLock(check: Extract<OwnerCheck, { state: 'gone' }>, o: { readonly keepFile?: boolean } = {}): void {
  check.lock.release();
  if (o.keepFile !== true) removeLockFile(check.file);
}

/**
 * Owner lock files whose directory is gone and whose holder is gone too (a process killed between
 * removing its directory and its lock file): removed. Returns how many.
 */
export function removeOrphanOwnerLocks(paths: MemoryPaths, deadline = Number.POSITIVE_INFINITY): number {
  const root = join(paths.locks, OWNERS_DIR);
  let n = 0;
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (Date.now() > deadline) return;
      const p = join(dir, name);
      let isFile: boolean;
      try {
        const st = lstatSync(p);
        if (st.isDirectory()) {
          walk(p);
          continue;
        }
        isFile = st.isFile();
      } catch {
        continue;
      }
      if (!isFile) continue;
      if (name.endsWith('.lock-journal')) {
        if (!existsSync(p.slice(0, -'-journal'.length))) n += tryUnlink(p);
        continue;
      }
      if (!name.endsWith('.lock')) continue;
      const target = join(paths.tmp, relative(root, p.slice(0, -'.lock'.length)));
      if (owned.has(p) || existsSync(target)) continue;
      let l: ProcessLock | null;
      try {
        l = tryLockFile(p);
      } catch {
        continue;
      }
      if (l === null) continue; // its holder is alive: it is between creating the lock and the directory
      l.release();
      removeLockFile(p);
      n++;
    }
  };
  walk(root);
  return n;
}

function tryUnlink(p: string): number {
  try {
    unlinkSync(p);
    return 1;
  } catch {
    return 0;
  }
}

/** A new name in the trash: `tmp/.trash-<random>`. */
function trashName(paths: MemoryPaths): string {
  return join(paths.tmp, `${TRASH_PREFIX}${randomBytes(6).toString('hex')}`);
}

/**
 * Rename `dir` into the trash (one atomic step); null when it is not there. A read-only
 * directory is made writable first when the rename needs it. Throws when it cannot be renamed
 * now (a file held open on Windows, a permission).
 */
export function moveToTrash(paths: MemoryPaths, dir: string): string | null {
  const to = trashName(paths);
  try {
    renameSync(dir, to);
    return to;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code !== 'EACCES' && code !== 'EPERM') throw e;
  }
  // moving a directory to another parent updates its "..": it must be writable
  chmodSync(dir, 0o755);
  renameSync(dir, to);
  return to;
}

export interface Removal {
  /** The tree is gone. */
  readonly done: boolean;
  /** Bytes of the files removed (when asked). */
  readonly bytes: number;
}

function isAbsent(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Delete `root` entry by entry until `deadline` (ms since the epoch; none by default): read-only
 * directories and files are made writable first. An entry already gone is fine (another process
 * may be deleting the same trash). Not done: what is left stays for the next call.
 */
export function removeTree(root: string, o: { readonly deadline?: number; readonly bytes?: boolean } = {}): Removal {
  const deadline = o.deadline ?? Number.POSITIVE_INFINITY;
  let bytes = 0;
  const visit = (p: string): boolean => {
    let st;
    try {
      st = lstatSync(p);
    } catch (e) {
      if (isAbsent(e)) return true;
      throw e;
    }
    if (st.isDirectory()) {
      if ((st.mode & 0o700) !== 0o700) {
        try {
          chmodSync(p, 0o755);
        } catch {
          /* the listing or the removal below says what is wrong */
        }
      }
      let names: string[];
      try {
        names = readdirSync(p);
      } catch (e) {
        if (isAbsent(e)) return true;
        throw e;
      }
      for (const name of names) {
        if (Date.now() > deadline) return false;
        if (!visit(join(p, name))) return false;
      }
      try {
        rmdirSync(p);
      } catch (e) {
        if (isAbsent(e)) return true;
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY' || code === 'EEXIST') return false; // someone added to it meanwhile: next time
        throw e;
      }
      return true;
    }
    if (o.bytes === true && st.isFile()) bytes += st.size;
    try {
      unlinkSync(p);
    } catch (e) {
      if (isAbsent(e)) return true;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EISDIR') throw e;
      if (st.isSymbolicLink()) rmdirSync(p); // a directory link (Windows)
      else {
        chmodSync(p, 0o666); // a read-only file (Windows)
        unlinkSync(p);
      }
    }
    return true;
  };
  const done = visit(root);
  return { done, bytes };
}

/** Bytes of the files under `root` (a measurement for reports; links are not followed). */
export function treeBytes(root: string): number {
  let bytes = 0;
  const visit = (p: string): void => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = readdirSync(p);
      } catch {
        return;
      }
      for (const name of names) visit(join(p, name));
    } else if (st.isFile()) bytes += st.size;
  };
  visit(root);
  return bytes;
}
