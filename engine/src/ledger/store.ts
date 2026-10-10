// The main ledger database (6.1). Only the ledger service writes it. Readers
// (evaluator, CLI) open their own read-only connections and read WAL snapshots.
//
// Base records live in `log`; their rowid is the revision. The other tables are
// the service's own state: idempotency, stops, scheduler generations, launches,
// adoptions, pending results, termination proofs, final dispositions, intents,
// spend and its per-mission totals, the scopes of pending operations. None of
// them is an evaluator input, and every one of them is rebuilt from the log
// (rebuild.ts, 10.1 rule 3).
//
// `journal` holds the service events that must not create a revision: the
// publication floor (6.1: raising it "不产生新修订号"), the evaluator's epoch and
// health, and the receipts of committed operations. Each journal entry records
// the head it followed (`after_rev`), so log and journal replay as one sequence.
// Readers of base records (the evaluator) read `log` only.

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { canonicalJson } from '../common/hash.ts';
import { revision, type Revision } from '../common/ids.ts';
import type { BaseRecord, Committed } from '../common/records.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS log (
  rev INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  op TEXT,
  record TEXT NOT NULL,
  committed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ops (
  op TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  launch TEXT,
  response TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stops (
  stop TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  words TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'released')),
  requested_at INTEGER NOT NULL,
  committed_at INTEGER NOT NULL,
  released_at INTEGER,
  narrows TEXT,
  narrowed_to TEXT
);
CREATE TABLE IF NOT EXISTS generations (
  gen INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS missions (
  mission TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed'))
);
CREATE TABLE IF NOT EXISTS launches (
  launch TEXT PRIMARY KEY,
  gen INTEGER NOT NULL,
  mission TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS adoptions (
  launch TEXT NOT NULL,
  gen INTEGER NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('alive', 'proof')),
  at INTEGER NOT NULL,
  PRIMARY KEY (launch, gen)
);
CREATE TABLE IF NOT EXISTS pending_results (
  launch TEXT NOT NULL,
  op TEXT NOT NULL,
  records TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (launch, op)
);
CREATE TABLE IF NOT EXISTS proofs (
  launch TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dispositions (
  launch TEXT PRIMARY KEY,
  disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'failed', 'cancelled')),
  reason TEXT NOT NULL,
  gen INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS intents (
  intent TEXT PRIMARY KEY,
  op TEXT NOT NULL,
  kind TEXT NOT NULL,
  domain TEXT NOT NULL,
  launch TEXT,
  mission TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('authorized', 'pending_verify', 'done', 'failed')),
  details TEXT NOT NULL,
  executor TEXT,
  updated_at INTEGER NOT NULL,
  delivery TEXT
);
CREATE TABLE IF NOT EXISTS facts (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  rev INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS loops (
  lineage TEXT NOT NULL,
  loop TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  by_class TEXT NOT NULL,
  last_signature TEXT,
  repeats INTEGER NOT NULL,
  secretary_grants INTEGER NOT NULL,
  extra INTEGER NOT NULL,
  attempts_at_grant INTEGER,
  no_progress_at INTEGER,
  PRIMARY KEY (lineage, loop)
);
CREATE TABLE IF NOT EXISTS landings (
  landing TEXT PRIMARY KEY,
  intent TEXT,
  phase TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cleanups (
  launch TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  resources TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS intents_open ON intents (domain) WHERE state IN ('authorized', 'pending_verify');
CREATE TABLE IF NOT EXISTS spend_limits (
  mission TEXT PRIMARY KEY,
  micros INTEGER
);
CREATE TABLE IF NOT EXISTS spend (
  reservation TEXT PRIMARY KEY,
  mission TEXT NOT NULL,
  launch TEXT NOT NULL,
  reserved INTEGER NOT NULL,
  settled INTEGER,
  how TEXT CHECK (how IN ('usage', 'reservation'))
);
CREATE INDEX IF NOT EXISTS spend_open ON spend (mission) WHERE settled IS NULL;
CREATE INDEX IF NOT EXISTS spend_launch ON spend (launch) WHERE settled IS NULL;
CREATE TABLE IF NOT EXISTS service_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  after_rev INTEGER NOT NULL,
  kind TEXT NOT NULL,
  op TEXT,
  record TEXT NOT NULL,
  committed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS op_scopes (
  op TEXT PRIMARY KEY,
  mission TEXT NOT NULL,
  capabilities TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spend_totals (
  mission TEXT PRIMARY KEY,
  spent INTEGER NOT NULL,
  inflight INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mission_blocks (
  mission TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task TEXT PRIMARY KEY,
  lineage TEXT NOT NULL,
  mission TEXT NOT NULL,
  card TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'dispatched', 'cancelled', 'superseded')),
  queued_rev INTEGER NOT NULL,
  queued_at INTEGER NOT NULL,
  launch TEXT,
  by_task TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_queued ON tasks (queued_rev) WHERE state = 'queued';
CREATE TABLE IF NOT EXISTS continuation_checks (
  judgment TEXT PRIMARY KEY,
  extends TEXT NOT NULL,
  target TEXT NOT NULL,
  revision INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  reason TEXT,
  inputs TEXT,
  rev INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS install_states (
  item TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  by_whom TEXT NOT NULL,
  detail TEXT NOT NULL,
  rev INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS op_ends (
  op TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  rev INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS flow_events (
  mission TEXT NOT NULL,
  line TEXT NOT NULL,
  event TEXT NOT NULL,
  key TEXT NOT NULL,
  body TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (mission, line, event, key)
);
CREATE INDEX IF NOT EXISTS flow_events_line ON flow_events (mission, line, event, revision);
CREATE INDEX IF NOT EXISTS flow_events_order ON flow_events (mission, revision);
CREATE TABLE IF NOT EXISTS record_missions (
  rev INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  mission TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS record_missions_kind ON record_missions (mission, kind, rev);
CREATE TABLE IF NOT EXISTS deliveries (
  mission TEXT NOT NULL,
  delivery TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('creating', 'recorded', 'withdrawn')),
  commit_id TEXT NOT NULL,
  base TEXT NOT NULL,
  ref TEXT NOT NULL,
  target TEXT,
  manifest TEXT,
  seq INTEGER NOT NULL,
  recorded_rev INTEGER,
  withdrawn_reason TEXT,
  updated_at INTEGER NOT NULL,
  description TEXT,
  PRIMARY KEY (mission, delivery)
);
CREATE TABLE IF NOT EXISTS notice_deliveries (
  notice TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('delivered', 'acknowledged')),
  delivered_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  rev INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pm_actions (
  action TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  args TEXT NOT NULL,
  wi TEXT,
  state TEXT NOT NULL CHECK (state IN ('started', 'done', 'failed')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  result TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pm_actions_order ON pm_actions (rev);
CREATE TABLE IF NOT EXISTS mission_closes (
  mission TEXT NOT NULL,
  version INTEGER NOT NULL,
  mode TEXT NOT NULL,
  wait_running INTEGER NOT NULL,
  as_of INTEGER NOT NULL,
  unfinished TEXT NOT NULL,
  snapshot TEXT,
  rev INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (mission, version)
);
CREATE INDEX IF NOT EXISTS deliveries_order ON deliveries (mission, seq);
CREATE TABLE IF NOT EXISTS inbox_boots (
  boot TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  row TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS launches_mission ON launches (mission);
CREATE INDEX IF NOT EXISTS log_kind ON log (kind, rev);
`;

/** Columns added after a table was first created: added in place to an existing ledger. */
const ADDED_COLUMNS: ReadonlyArray<{ table: string; column: string; type: string }> = [
  { table: 'loops', column: 'attempts_at_grant', type: 'INTEGER' },
  { table: 'loops', column: 'no_progress_at', type: 'INTEGER' },
  { table: 'continuation_checks', column: 'inputs', type: 'TEXT' },
  { table: 'intents', column: 'delivery', type: 'TEXT' },
  { table: 'stops', column: 'narrows', type: 'TEXT' },
  { table: 'stops', column: 'narrowed_to', type: 'TEXT' },
  { table: 'deliveries', column: 'description', type: 'TEXT' },
];

/** The state tables, every one rebuilt from the log (rebuild.ts). */
export const STATE_TABLES: readonly string[] = [
  'stops',
  'generations',
  'missions',
  'launches',
  'adoptions',
  'pending_results',
  'proofs',
  'dispositions',
  'intents',
  'facts',
  'loops',
  'landings',
  'cleanups',
  'spend_limits',
  'spend',
  'spend_totals',
  'op_scopes',
  'ops',
  'mission_blocks',
  'tasks',
  'inbox_boots',
  'op_ends',
  'continuation_checks',
  'install_states',
  'deliveries',
  'flow_events',
  'record_missions',
  'notice_deliveries',
  'pm_actions',
  'mission_closes',
];

/** service_state keys that are ledger state (rebuilt from the log); the others are process lifecycle. */
export const STATE_KEYS: readonly string[] = [
  'recovery_pause',
  'startup_decision',
  'evaluator_epoch',
  'evaluator_gen',
  'evaluator_identity',
  'publication_floor',
  'evaluator_failures',
  'evaluator_fault',
];

export class Store {
  readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 2000 });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(SCHEMA);
    // An older ledger's tables get the columns added since (CREATE TABLE IF NOT EXISTS leaves them as they were).
    for (const c of ADDED_COLUMNS) {
      const cols = this.db.prepare(`PRAGMA table_info(${c.table})`).all() as Array<{ name: string }>;
      if (!cols.some((x) => x.name === c.column)) this.db.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.type}`);
    }
  }

  close(): void {
    this.db.close();
  }

  stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /**
   * Run fn in one IMMEDIATE transaction; roll back on any throw. The original
   * error is always the one rethrown: SQLite may already have rolled back by
   * itself (e.g. SQLITE_FULL), and a failing ROLLBACK must not hide the cause
   * (core review r1 #1).
   */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      if (this.db.isTransaction) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* keep the original error */
        }
      }
      throw e;
    }
  }

  appendRecord(record: BaseRecord, op: string | null, now: number): Revision {
    const r = this.stmt('INSERT INTO log (kind, op, record, committed_at) VALUES (?, ?, ?, ?)').run(
      record.kind,
      op,
      canonicalJson(record),
      now,
    );
    return revision(Number(r.lastInsertRowid));
  }

  /** Append a service event that does not create a revision (see the header). Returns its sequence number. */
  appendJournal(record: BaseRecord, op: string | null, now: number): number {
    const r = this.stmt('INSERT INTO journal (after_rev, kind, op, record, committed_at) VALUES ((SELECT COALESCE(MAX(rev), 0) FROM log), ?, ?, ?, ?)').run(
      record.kind,
      op,
      canonicalJson(record),
      now,
    );
    return Number(r.lastInsertRowid);
  }

  head(): Revision {
    const row = this.stmt('SELECT COALESCE(MAX(rev), 0) AS rev FROM log').get() as { rev: number };
    return revision(row.rev);
  }

  getState(key: string): string | null {
    const row = this.stmt('SELECT value FROM service_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.stmt('INSERT INTO service_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      key,
      value,
    );
  }

  deleteState(key: string): void {
    this.stmt('DELETE FROM service_state WHERE key = ?').run(key);
  }
}

/**
 * Errors that mean the storage itself is failing (6.1 "存储故障"): I/O errors,
 * a full disk, corruption, the file can no longer be opened or written. SQLite
 * result codes from node:sqlite's `errcode` (primary code in the low byte).
 */
export function isStorageError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const errcode = (e as { errcode?: unknown }).errcode;
  if (typeof errcode === 'number') {
    const primary = errcode & 0xff;
    // SQLITE_NOMEM 7, READONLY 8, IOERR 10, CORRUPT 11, FULL 13, CANTOPEN 14, PROTOCOL 15, NOTADB 26
    return [7, 8, 10, 11, 13, 14, 15, 26].includes(primary);
  }
  return /disk I\/O|SQLITE_IOERR|SQLITE_FULL|database or disk is full|readonly database|database disk image is malformed|ENOSPC|EIO/i.test(e.message);
}

/** Read committed base records in revision order. Opens its own read-only connection. */
export function readRecords(dbPath: string, after: Revision, upTo: Revision | null = null): Committed[] {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
  try {
    const rows = (
      upTo === null
        ? db.prepare('SELECT rev, record FROM log WHERE rev > ? ORDER BY rev').all(after)
        : db.prepare('SELECT rev, record FROM log WHERE rev > ? AND rev <= ? ORDER BY rev').all(after, upTo)
    ) as Array<{ rev: number; record: string }>;
    return rows.map((r) => ({ revision: revision(r.rev), record: JSON.parse(r.record) as BaseRecord }));
  } finally {
    db.close();
  }
}

/** The ledger head read directly (read-only), for cheap polling by readers such as the evaluator. */
export function readHead(dbPath: string): Revision {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
  try {
    const row = db.prepare('SELECT COALESCE(MAX(rev), 0) AS rev FROM log').get() as { rev: number };
    return revision(Number(row.rev));
  } finally {
    db.close();
  }
}

/** A journal entry as read back: a service event placed after revision `afterRev`. */
export interface JournalEntry {
  readonly seq: number;
  readonly afterRev: Revision;
  readonly record: BaseRecord;
  readonly op: string | null;
  readonly committedAt: number;
}

/** Read the service journal in order. Opens its own read-only connection. */
export function readJournal(dbPath: string, afterSeq = 0): JournalEntry[] {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
  try {
    const rows = db.prepare('SELECT seq, after_rev, op, record, committed_at FROM journal WHERE seq > ? ORDER BY seq').all(afterSeq) as Array<{
      seq: number;
      after_rev: number;
      op: string | null;
      record: string;
      committed_at: number;
    }>;
    return rows.map((r) => ({ seq: r.seq, afterRev: revision(r.after_rev), op: r.op, committedAt: r.committed_at, record: JSON.parse(r.record) as BaseRecord }));
  } finally {
    db.close();
  }
}
