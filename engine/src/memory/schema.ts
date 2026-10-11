// The skeleton's schema: `.mission-pipeline/memory.db` (design 4.1 §3.2).
//
// Three kinds of table:
// - base tables, never rebuilt: `log` (the hash-chained event log, §3.3; its
//   rowid is the revision; `txn_end` marks the last event of each write), `data` (every value the program reads to decide,
//   content-addressed, §3.2 item 11: what 4.0 kept in its content store) and
//   `meta` (this copy's own facts: where it lives, a move in progress, a broken
//   chain, git writes held; never copied into the log's state);
// - state tables, every one the projection of the log (projection.ts) and
//   rebuilt from it after a move (rebuild.ts);
// - extension tables (labels, environment identity: package A2), declared by a
//   MemoryExtension with their own schema and rebuild.
//
// The 4.0 runtime tables are gone: launches, adoptions, pending results,
// termination proofs, dispositions, cleanups, spend, generations, the stop
// inboxes' boots, install states, ended proof operations and the journal (its
// receipts are log events now).

/** The memory's format, recorded at init (meta `format`). */
export const MEMORY_FORMAT = 'mp-memory-1';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS log (
  rev INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  op TEXT,
  record TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  prev TEXT NOT NULL,
  hash TEXT NOT NULL,
  txn_end INTEGER NOT NULL DEFAULT 0 CHECK (txn_end IN (0, 1))
);
CREATE INDEX IF NOT EXISTS log_kind ON log (kind, rev);
CREATE TABLE IF NOT EXISTS data (
  hash TEXT PRIMARY KEY,
  body BLOB NOT NULL,
  bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops (
  op TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  rev INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS facts (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  rev INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS stops (
  stop TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  words TEXT NOT NULL,
  words_entry TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'released')),
  requested_at INTEGER NOT NULL,
  committed_at INTEGER NOT NULL,
  released_at INTEGER,
  narrows TEXT,
  narrowed_to TEXT
);
CREATE TABLE IF NOT EXISTS missions (
  mission TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed'))
);
CREATE TABLE IF NOT EXISTS intents (
  intent TEXT PRIMARY KEY,
  op TEXT NOT NULL,
  kind TEXT NOT NULL,
  domain TEXT NOT NULL,
  mission TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('authorized', 'done', 'failed')),
  details TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  delivery TEXT
);
CREATE INDEX IF NOT EXISTS intents_open ON intents (domain) WHERE state = 'authorized';
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
  dispatch TEXT,
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
CREATE TABLE IF NOT EXISTS op_scopes (
  op TEXT PRIMARY KEY,
  mission TEXT NOT NULL,
  capabilities TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS deliveries_order ON deliveries (mission, seq);
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
CREATE TABLE IF NOT EXISTS dispatches (
  dispatch TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  seat TEXT NOT NULL,
  mission TEXT NOT NULL,
  lineage TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in-flight', 'handed-back', 'released')),
  released TEXT CHECK (released IN ('ended', 'abandoned')),
  handback TEXT CHECK (handback IN ('accepted', 'after-release', 'after-stop')),
  handback_hash TEXT,
  result TEXT,
  filler_harness TEXT,
  filler_model TEXT,
  handback_harness TEXT,
  handback_model TEXT,
  worktree TEXT,
  card_leaf TEXT,
  report_leaf TEXT,
  claimed_rev INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dispatches_state ON dispatches (state, claimed_rev);
CREATE INDEX IF NOT EXISTS dispatches_task ON dispatches (task, claimed_rev);
CREATE INDEX IF NOT EXISTS dispatches_nocase ON dispatches (dispatch COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS leases (
  resource TEXT PRIMARY KEY,
  dispatch TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  rev INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leases_dispatch ON leases (dispatch);
CREATE TABLE IF NOT EXISTS leaves (
  leaf TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('document', 'journal')),
  file TEXT NOT NULL,
  anchor TEXT,
  sha256 TEXT NOT NULL,
  op TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leaves_file ON leaves (file);
CREATE INDEX IF NOT EXISTS leaves_file_nocase ON leaves (file COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS words (
  words TEXT PRIMARY KEY,
  message TEXT NOT NULL UNIQUE,
  session TEXT NOT NULL,
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  leaf TEXT,
  rev INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pm_commands (
  op TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  harness TEXT,
  model TEXT,
  at INTEGER NOT NULL,
  rev INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
  cursor TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  at INTEGER NOT NULL,
  set_rev INTEGER NOT NULL
);
`;

/** Tables that are never rebuilt: the log, the program's data, and this copy's own meta. */
export const BASE_TABLES: readonly string[] = ['log', 'data', 'meta'];

/** The state tables, every one rebuilt from the log (rebuild.ts). */
export const STATE_TABLES: readonly string[] = [
  'state',
  'ops',
  'facts',
  'stops',
  'missions',
  'intents',
  'loops',
  'landings',
  'mission_blocks',
  'tasks',
  'continuation_checks',
  'op_scopes',
  'flow_events',
  'record_missions',
  'deliveries',
  'notice_deliveries',
  'pm_actions',
  'mission_closes',
  'dispatches',
  'leases',
  'leaves',
  'words',
  'pm_commands',
  'cursors',
];
