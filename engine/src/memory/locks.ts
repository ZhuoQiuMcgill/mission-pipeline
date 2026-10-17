// Process locks (design 4.1 §4.1): the operations that need a lock that
// outlives a transaction, a landing (§6.7), the recovery after a move (§3.3)
// and a declared run while it executes (process/runs.ts, under `locks/runs/`).
// Each is `.mission-pipeline/locks/<name>.lock`, an SQLite database used only
// to hold an exclusive transaction for the life of its holder.
// SQLite's own file locking works the same on Linux, Windows and macOS, and the
// operating system releases the lock when the holding process exits, however it
// exits, so `mp` never watches a process to know whether the holder is alive
// (§2.5, U-4).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isBusyError, setBusyTimeout } from './db.ts';
import { LedgerError } from './errors.ts';

const NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** Held locks stay referenced here, so a holder that drops its handle never loses the lock to the garbage collector. */
const held = new Set<ProcessLock>();

export class ProcessLock {
  readonly name: string;
  readonly file: string;
  private db: DatabaseSync | null;

  constructor(name: string, file: string, db: DatabaseSync) {
    this.name = name;
    this.file = file;
    this.db = db;
    held.add(this);
  }

  get held(): boolean {
    return this.db !== null;
  }

  release(): void {
    const db = this.db;
    if (db === null) return;
    this.db = null;
    held.delete(this);
    try {
      db.exec('ROLLBACK');
    } catch {
      /* closing the connection ends the transaction anyway */
    } finally {
      db.close();
    }
  }
}

function acquire(locksDir: string, name: string, waitMs: number): ProcessLock | null {
  if (!NAME.test(name)) throw new LedgerError('BAD_REQUEST', `a lock name is 1 to 64 lowercase letters, digits and "-", starting with a letter: ${JSON.stringify(name)}`);
  mkdirSync(locksDir, { recursive: true });
  return acquireFile(join(locksDir, `${name}.lock`), name, waitMs);
}

function acquireFile(file: string, name: string, waitMs: number): ProcessLock | null {
  const db = new DatabaseSync(file);
  try {
    setBusyTimeout(db, waitMs);
    db.exec('BEGIN EXCLUSIVE');
  } catch (e) {
    db.close();
    if (isBusyError(e)) return null;
    throw e;
  }
  return new ProcessLock(name, file, db);
}

/** Take the lock if it is free now; null when another holder has it. */
export function tryLock(locksDir: string, name: string): ProcessLock | null {
  return acquire(locksDir, name, 0);
}

/** Take the lock, waiting up to `waitMs`; LOCKED when it is still held after that. */
export function lock(locksDir: string, name: string, opts: { readonly waitMs: number }): ProcessLock {
  const l = acquire(locksDir, name, opts.waitMs);
  if (l === null) throw new LedgerError('LOCKED', `the ${name} lock is held by another mp process (waited ${opts.waitMs} ms)`);
  return l;
}

/**
 * The same lock held in a file the caller names (4.1.2: the owner of a scratch directory under
 * `tmp/`, `memory/scratch.ts`): taken if it is free now; null when another holder has it. The
 * file's directory must exist.
 */
export function tryLockFile(file: string): ProcessLock | null {
  return acquireFile(file, file, 0);
}
