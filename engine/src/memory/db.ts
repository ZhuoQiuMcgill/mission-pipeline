// The SQLite connection of the project memory (design 4.1 §3.1, §4.1).
//
// Journal mode DELETE, not WAL: a committed database is one complete file, and
// the rollback journal works on every local filesystem (WSL's /mnt, macOS,
// Windows). synchronous=FULL: a commit is on disk when it returns. Concurrent
// `mp` processes serialize on SQLite's own lock, waiting up to the busy timeout.
//
// Node 22.12 is the promised minimum (§9). Its node:sqlite has neither the
// `timeout` option nor `isTransaction` (both 22.16), so the busy timeout is set
// with `PRAGMA busy_timeout` and transactions are tracked here, with an explicit
// ROLLBACK on every failure.

import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** What a query needs: prepared statements on one connection (a Memory, a read, or a write transaction). */
export interface Db {
  stmt(sql: string): StatementSync;
}

/** The busy limit of §4.1: a caller that cannot get the lock within 30 s gets "busy, retry". */
export const BUSY_TIMEOUT_MS = 30_000;

/** SQLite's busy timeout for every statement of the connection (works on every Node 22 release). */
export function setBusyTimeout(db: DatabaseSync, timeoutMs: number): void {
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeoutMs))}`);
}

/** Open a connection with the memory's pragmas. `timeoutMs`: SQLite's busy timeout for every statement. */
export function openDatabase(path: string, timeoutMs: number): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    setBusyTimeout(db, timeoutMs);
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('PRAGMA synchronous = FULL');
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/** A prepared-statement cache over one connection, and its transaction state (tracked here, not asked of node:sqlite). */
export class Statements implements Db {
  readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private open = false;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** True between begin() and commit()/rollback(). */
  get inTransaction(): boolean {
    return this.open;
  }

  begin(mode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE'): void {
    this.db.exec(`BEGIN ${mode}`);
    this.open = true;
  }

  /** COMMIT; when it fails (busy), the transaction is still open and the caller rolls back. */
  commit(): void {
    this.db.exec('COMMIT');
    this.open = false;
  }

  /** ROLLBACK whatever is open; a transaction SQLite already ended by itself (e.g. on a full disk) is not an error. */
  rollback(): void {
    this.open = false;
    try {
      this.db.exec('ROLLBACK');
    } catch {
      /* no transaction left to roll back: keep the caller's error */
    }
  }

  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }
}

function primaryCode(e: unknown): number | null {
  const errcode = (e as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === 'number' ? errcode & 0xff : null;
}

/** SQLITE_BUSY or SQLITE_LOCKED: another connection holds the lock. */
export function isBusyError(e: unknown): boolean {
  const c = primaryCode(e);
  if (c !== null) return c === 5 || c === 6;
  return e instanceof Error && /database is locked|database table is locked|SQLITE_BUSY/i.test(e.message);
}

/** A value read from `meta` or `state`. */
export function getKey(db: Db, table: 'meta' | 'state', key: string): string | null {
  const row = db.stmt(`SELECT value FROM ${table} WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setKey(db: Db, table: 'meta' | 'state', key: string, value: string): void {
  db.stmt(`INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export function deleteKey(db: Db, table: 'meta' | 'state', key: string): void {
  db.stmt(`DELETE FROM ${table} WHERE key = ?`).run(key);
}
