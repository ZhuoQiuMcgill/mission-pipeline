// The stop path's state in the control plane (design v45 6.1): a small SQLite
// database on the memory filesystem. Its write transaction is "the lock in the
// control plane" (槽位协议, 干净退出记录): slot allocation, entry registration and
// the shutdown seal all take it, and the kernel drops it if a holder dies. Nothing
// here touches the disk the inboxes live on, so a hanging disk never holds the lock.
//
// Tables:
//   alloc     per inbox: the boot it is allocating for, its free slots, the next sequence
//   slots     every slot allocated in this boot: inbox, slot, kind, the entry or probe
//   writes    per entry and inbox: started | written | failed | exhausted
//   entries   stop entries in progress, and whether they registered before the seal
//   seal      the shutdown seal of a boot
//   committed stop ids the ledger committed (probes read it: "no uncommitted stop in staging")
//   ledger_exit  the ledger service's clean exit of a boot (after its last drain)

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { InboxName } from './inbox.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS alloc (inbox TEXT PRIMARY KEY, boot TEXT NOT NULL, free TEXT NOT NULL, next_seq INTEGER NOT NULL, exhausted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS slots (id INTEGER PRIMARY KEY AUTOINCREMENT, inbox TEXT NOT NULL, boot TEXT NOT NULL, slot INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, stop TEXT, owner TEXT, state TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS writes (entry TEXT NOT NULL, inbox TEXT NOT NULL, state TEXT NOT NULL, slot_id INTEGER, at INTEGER NOT NULL, PRIMARY KEY (entry, inbox));
CREATE TABLE IF NOT EXISTS entries (entry TEXT PRIMARY KEY, boot TEXT NOT NULL, stop TEXT NOT NULL, pid INTEGER NOT NULL, started INTEGER NOT NULL, before_seal INTEGER NOT NULL, ended INTEGER);
CREATE TABLE IF NOT EXISTS seal (boot TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS committed (stop TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ledger_exit (boot TEXT PRIMARY KEY, pid INTEGER NOT NULL, at INTEGER NOT NULL, clean INTEGER NOT NULL, staging_empty INTEGER NOT NULL);
`;

export function controlDbPath(controlPlane: string): string {
  return join(controlPlane, 'stop-entry.sqlite');
}

/** Every connection waits this long for a lock (busy_timeout), set before its first statement. */
export const CONTROL_BUSY_TIMEOUT_MS = 5_000;
/** How long opening may keep retrying a lock the busy handler does not cover (the WAL switch). */
const OPEN_RETRY_MS = 15_000;

/** SQLITE_BUSY (5) or SQLITE_LOCKED (6), including their extended codes. */
export function isBusyError(e: unknown): boolean {
  const code = (e as { errcode?: unknown })?.errcode;
  if (typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6)) return true;
  return /database is locked|database table is locked|SQLITE_BUSY/i.test(e instanceof Error ? e.message : String(e));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Open the control-plane database: busy_timeout first, then the WAL switch and
 * the schema. Switching a new file to WAL needs an exclusive lock that SQLite
 * does not wait for through the busy handler: when the probes, the ledger, the
 * watchdog or a stop writer open the file at the same moment, the loser gets
 * SQLITE_BUSY at once (e2e: "[probe] database is locked"). Such a lock is
 * retried with a growing pause for a bounded time; any other error, or a lock
 * still held after the bound, is thrown (a real failure).
 */
export function openControlDb(path: string, retryMs: number = OPEN_RETRY_MS): DatabaseSync {
  const deadline = Date.now() + retryMs;
  let pause = 5;
  for (;;) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { timeout: CONTROL_BUSY_TIMEOUT_MS });
      db.exec(`PRAGMA busy_timeout = ${CONTROL_BUSY_TIMEOUT_MS}`);
      const mode = String((db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined)?.journal_mode ?? '');
      if (mode.toLowerCase() !== 'wal') db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = OFF');
      db.exec(SCHEMA);
      return db;
    } catch (e) {
      try {
        db?.close();
      } catch {
        /* closed */
      }
      if (!isBusyError(e) || Date.now() + pause > deadline) throw e;
      sleepSync(pause);
      pause = Math.min(pause * 2, 200);
    }
  }
}

export type Allocation = { readonly id: number; readonly slot: number; readonly seq: number } | { readonly needInit: true } | { readonly exhausted: true };

/** Free slots as [from, to) ranges, so a whole inbox is a short string. */
function toRanges(free: readonly number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const i of free) {
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

export class ControlState {
  readonly db: DatabaseSync;
  readonly controlPlane: string;

  constructor(controlPlane: string) {
    this.controlPlane = controlPlane;
    mkdirSync(controlPlane, { recursive: true });
    this.db = openControlDb(controlDbPath(controlPlane));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* closed */
    }
  }

  /** The control-plane lock: one IMMEDIATE transaction. */
  locked<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ------------------------------------------------------------ entries and the seal

  /** Register "entry in progress" (v45 6.1 step 1). Registered after the seal: it counts as arriving after the clean exit. */
  registerEntry(entry: string, boot: string, stop: string, pid: number, now: number): { beforeSeal: boolean } {
    return this.locked(() => {
      const sealed = Boolean(this.db.prepare('SELECT 1 FROM seal WHERE boot = ?').get(boot));
      this.db.prepare('INSERT OR REPLACE INTO entries (entry, boot, stop, pid, started, before_seal, ended) VALUES (?, ?, ?, ?, ?, ?, NULL)').run(entry, boot, stop, pid, now, sealed ? 0 : 1);
      return { beforeSeal: !sealed };
    });
  }

  endEntry(entry: string, now: number): void {
    this.locked(() => this.db.prepare('UPDATE entries SET ended = ? WHERE entry = ?').run(now, entry));
  }

  /** Seal for shutdown under the lock (v45 6.1 shutdown step 1). The first seal of a boot stands. */
  seal(boot: string, now: number): { at: number; entriesBefore: string[] } {
    return this.locked(() => {
      this.db.prepare('INSERT OR IGNORE INTO seal (boot, at) VALUES (?, ?)').run(boot, now);
      const at = Number((this.db.prepare('SELECT at FROM seal WHERE boot = ?').get(boot) as { at: number }).at);
      const rows = this.db.prepare('SELECT entry FROM entries WHERE boot = ? AND before_seal = 1 AND ended IS NULL').all(boot) as Array<{ entry: string }>;
      return { at, entriesBefore: rows.map((r) => r.entry) };
    });
  }

  sealOf(boot: string): number | null {
    const r = this.db.prepare('SELECT at FROM seal WHERE boot = ?').get(boot) as { at: number } | undefined;
    return r ? Number(r.at) : null;
  }

  /** Entries registered before the seal that have not ended. */
  openEntriesBeforeSeal(boot: string): string[] {
    return (this.db.prepare('SELECT entry FROM entries WHERE boot = ? AND before_seal = 1 AND ended IS NULL').all(boot) as Array<{ entry: string }>).map((r) => r.entry);
  }

  activeEntries(boot: string): string[] {
    return (this.db.prepare('SELECT entry FROM entries WHERE boot = ? AND ended IS NULL').all(boot) as Array<{ entry: string }>).map((r) => r.entry);
  }

  // ------------------------------------------------------------ slots

  /**
   * Allocate one slot of `inbox` for this boot, under the lock (槽位协议). The
   * first allocation of a boot needs the inbox's free slots, read by the caller
   * outside the lock (`needInit`), so a hanging disk never holds the lock. A slot
   * is handed out once per boot and never again.
   */
  allocate(req: { inbox: InboxName; boot: string; kind: string; stop: string | null; owner: string; now: number; free: readonly number[] | null }): Allocation {
    return this.locked(() => {
      let row = this.db.prepare('SELECT boot, free, next_seq, exhausted FROM alloc WHERE inbox = ?').get(req.inbox) as
        | { boot: string; free: string; next_seq: number; exhausted: number }
        | undefined;
      if (!row || row.boot !== req.boot) {
        if (req.free === null) return { needInit: true } as const;
        this.db.prepare('INSERT OR REPLACE INTO alloc (inbox, boot, free, next_seq, exhausted) VALUES (?, ?, ?, 1, 0)').run(req.inbox, req.boot, JSON.stringify(toRanges(req.free)));
        row = { boot: req.boot, free: JSON.stringify(toRanges(req.free)), next_seq: 1, exhausted: 0 };
      }
      const ranges = JSON.parse(row.free) as Array<[number, number]>;
      const first = ranges[0];
      if (!first) {
        this.db.prepare('UPDATE alloc SET exhausted = 1 WHERE inbox = ?').run(req.inbox);
        return { exhausted: true } as const;
      }
      const slot = first[0];
      if (first[0] + 1 >= first[1]) ranges.shift();
      else first[0] += 1;
      const seq = Number(row.next_seq);
      this.db.prepare('UPDATE alloc SET free = ?, next_seq = ? WHERE inbox = ?').run(JSON.stringify(ranges), seq + 1, req.inbox);
      const r = this.db
        .prepare("INSERT INTO slots (inbox, boot, slot, seq, kind, stop, owner, state, at) VALUES (?, ?, ?, ?, ?, ?, ?, 'allocated', ?)")
        .run(req.inbox, req.boot, slot, seq, req.kind, req.stop, req.owner, req.now);
      return { id: Number(r.lastInsertRowid), slot, seq };
    });
  }

  markSlot(id: number, state: 'written' | 'failed'): void {
    this.db.prepare('UPDATE slots SET state = ? WHERE id = ?').run(state, id);
  }

  /** Slots allocated in this boot, after `afterId`, of one kind (or all). */
  allocations(boot: string, afterId = 0, kind?: string): Array<{ id: number; inbox: InboxName; slot: number; seq: number; kind: string; stop: string | null; state: string }> {
    const rows = (
      kind === undefined
        ? this.db.prepare('SELECT id, inbox, slot, seq, kind, stop, state FROM slots WHERE boot = ? AND id > ? ORDER BY id').all(boot, afterId)
        : this.db.prepare('SELECT id, inbox, slot, seq, kind, stop, state FROM slots WHERE boot = ? AND id > ? AND kind = ? ORDER BY id').all(boot, afterId, kind)
    ) as Array<{ id: number; inbox: InboxName; slot: number; seq: number; kind: string; stop: string | null; state: string }>;
    return rows.map((r) => ({ ...r, id: Number(r.id), slot: Number(r.slot), seq: Number(r.seq) }));
  }

  maxAllocationId(boot: string, kind?: string): number {
    const r = (kind === undefined
      ? this.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM slots WHERE boot = ?').get(boot)
      : this.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM slots WHERE boot = ? AND kind = ?').get(boot, kind)) as { n: number };
    return Number(r.n);
  }

  exhaustedInboxes(boot: string): InboxName[] {
    return (this.db.prepare('SELECT inbox FROM alloc WHERE boot = ? AND exhausted = 1').all(boot) as Array<{ inbox: InboxName }>).map((r) => r.inbox);
  }

  // ------------------------------------------------------------ entry writes

  setWrite(entry: string, inbox: InboxName, state: 'started' | 'written' | 'failed' | 'exhausted', slotId: number | null, now: number): void {
    this.db
      .prepare('INSERT INTO writes (entry, inbox, state, slot_id, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(entry, inbox) DO UPDATE SET state = excluded.state, slot_id = COALESCE(excluded.slot_id, writes.slot_id), at = excluded.at')
      .run(entry, inbox, state, slotId, now);
  }

  writesOf(entry: string): Map<InboxName, string> {
    const rows = this.db.prepare('SELECT inbox, state FROM writes WHERE entry = ?').all(entry) as Array<{ inbox: InboxName; state: string }>;
    return new Map(rows.map((r) => [r.inbox, r.state]));
  }

  // ------------------------------------------------------------ committed stops and the ledger's exit

  markCommitted(stops: readonly string[], now: number): void {
    if (stops.length === 0) return;
    this.locked(() => {
      const st = this.db.prepare('INSERT OR IGNORE INTO committed (stop, at) VALUES (?, ?)');
      for (const s of stops) st.run(s, now);
    });
  }

  isCommitted(stop: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM committed WHERE stop = ?').get(stop));
  }

  recordLedgerExit(boot: string, pid: number, clean: boolean, stagingEmpty: boolean, now: number): void {
    this.db.prepare('INSERT OR REPLACE INTO ledger_exit (boot, pid, at, clean, staging_empty) VALUES (?, ?, ?, ?, ?)').run(boot, pid, now, clean ? 1 : 0, stagingEmpty ? 1 : 0);
  }

  ledgerExit(boot: string): { pid: number; at: number; clean: boolean; stagingEmpty: boolean } | null {
    const r = this.db.prepare('SELECT pid, at, clean, staging_empty FROM ledger_exit WHERE boot = ?').get(boot) as { pid: number; at: number; clean: number; staging_empty: number } | undefined;
    return r ? { pid: Number(r.pid), at: Number(r.at), clean: r.clean === 1, stagingEmpty: r.staging_empty === 1 } : null;
  }
}

/** Open the control state, or null when the control plane is unusable (the caller then proceeds without it). */
export function tryControlState(controlPlane: string): ControlState | null {
  try {
    return new ControlState(controlPlane);
  } catch {
    return null;
  }
}
