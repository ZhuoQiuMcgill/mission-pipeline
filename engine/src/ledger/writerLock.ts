// Single-writer lock (6.1). SQLite's EXCLUSIVE locking mode holds a POSIX
// advisory lock on the lock file for as long as the connection is open. The
// kernel drops it when the holding process dies, and keeps it while that process
// still exists, even when it is stuck (for example in uninterruptible disk I/O),
// so a new service never takes over while an old writer may still write.
// Probed on 2026-10-09: refused while held, refused while the holder is SIGSTOPped,
// acquired after the holder is killed.

import { DatabaseSync } from 'node:sqlite';

export class WriterLockHeld extends Error {
  constructor(path: string) {
    super(`ledger writer lock is held by another process: ${path}`);
    this.name = 'WriterLockHeld';
  }
}

export class WriterLock {
  private db: DatabaseSync | null = null;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  acquire(): void {
    if (this.db) return;
    const db = new DatabaseSync(this.path, { timeout: 0 });
    try {
      db.exec('PRAGMA locking_mode=EXCLUSIVE');
      db.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER, at INTEGER)');
      // A write is what takes the exclusive lock; it is then kept until close.
      db.exec('BEGIN EXCLUSIVE');
      db.prepare('INSERT INTO holder (pid, at) VALUES (?, ?)').run(process.pid, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      if (e instanceof Error && /locked|busy/i.test(e.message)) throw new WriterLockHeld(this.path);
      throw e;
    }
    this.db = db;
  }

  release(): void {
    this.db?.close();
    this.db = null;
  }

  get held(): boolean {
    return this.db !== null;
  }
}
