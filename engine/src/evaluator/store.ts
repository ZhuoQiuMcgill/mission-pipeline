// The stored index of the proof model (design 4.1 §4.1, §6.5; v51 5.2-5.4).
//
// 4.1 keeps no long-lived evaluator process, so what the 4.0 evaluator held in
// memory lives in the project memory's skeleton, as tables of the labels
// extension (labels.ts):
// - index tables: the base records of the proof model, indexed the way the
//   rules read them (basis lines and versions, constraint scopes, environment
//   history, evidence, renewals, targets, unit members, judgments by position,
//   regression registrations, pending and executed operations). They are the
//   projection of the log's base records, rebuilt with every other state table;
// - `lbl_edges`: the reverse dependency edges at node level ("who reads this?"),
//   the stored form of 4.0's in-memory reverse indexes: from a fact node
//   ("j:J", "e:X", "f:X", "p:X") or an expansion node ("ev:E" evidence,
//   "env:L" environment line, "line:L" basis line, "bv:V" basis version, "tj:T"
//   judgments on a target) to the nodes that read it, and to the display nodes
//   ("x:T" fixes, "o:OP" operations) that read it. Every edge over-approximates
//   what a rule reads, as the in-memory reverse edges did.
//
// `projectRecord` adds one base record to the index and returns the nodes it
// touches directly (the seeds of 5.4 step 1). `StoredIndex` answers the
// `IndexView` questions of the rules (semantics.ts) from these tables; one
// instance serves one transaction (its caches never outlive it).
//
// Nothing here trusts a value it has not checked (§3.3): records are read back
// from the log through the memory's integrity checks (`factById`,
// `intactRecord`: a damaged event is CHAIN_BROKEN), and lists through the data
// store's checks (`DataStore.getList`: hash, type and count; a missing or
// damaged list is a refusal, never an empty list).
//
// Every stored read a rule makes is counted on the index's `Meter` (one unit
// each, a list one unit), so a batch can bound the work it does (labels.ts).

import { canonicalJson } from '../common/hash.ts';
import type { BasisLineId, BasisVersionId, EnvLineId, EnvSnapshotId, EvidenceId, IssueId, JudgmentId, ObjectVersionId, OpId, ProofUnitId, Revision } from '../common/ids.ts';
import {
  decodeConstraintCheck,
  type BaseRecord,
  type ConstraintCheck,
  type ConstraintScope,
  type EvidenceRecord,
  type FixCoverageRecord,
  type JudgmentRecord,
  type ListRef,
  type ObjectScope,
  type ObjectVersionRecord,
  type PendingOpRecord,
  type ProofUnitRecord,
  type Resolved,
  type ReviewContract,
  type ReviewPosition,
} from '../common/records.ts';
import { DataStore, factById, intactRecord, LedgerError, LOG_COLUMNS, type Db, type LogRow } from '../memory/index.ts';
import { candidatePatterns, type Conclusion, type ConstraintLine, type FactMemo, type IndexView, type JudgmentInfo, type PositionState, type ReadMap, type ReadSet, type RegressionRun, type TargetScan } from './semantics.ts';
import { RUN_FIELD } from './runs.ts';

/**
 * Index tables: the projection of the base records (rebuilt by replaying the
 * log). `lbl_patterns` lists the active object constraints under each pattern
 * of their current scope (a withdrawn one is gone from it). `lbl_judgments`
 * keeps, with each judgment, its review position's state right after it
 * (`state`, `decided_by`: semantics.ts `positionState`), so a position's state
 * at any revision is one lookup, never a walk over its history.
 */
const INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS lbl_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lbl_basis (version TEXT PRIMARY KEY, line TEXT NOT NULL, kind TEXT NOT NULL, rev INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lbl_lines (line TEXT PRIMARY KEY, latest TEXT, withdrawn_rev INTEGER, scope TEXT, constraint_line INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lbl_patterns (pattern TEXT NOT NULL, line TEXT NOT NULL, PRIMARY KEY (pattern, line)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lbl_env (line TEXT NOT NULL, rev INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY (line, rev)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lbl_evidence (
  evidence TEXT PRIMARY KEY,
  env_line TEXT NOT NULL,
  env_snapshot TEXT NOT NULL,
  run_class TEXT NOT NULL,
  fields TEXT NOT NULL,
  candidate TEXT,
  command TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lbl_evidence_env ON lbl_evidence (env_line, env_snapshot);
CREATE INDEX IF NOT EXISTS lbl_evidence_reuse ON lbl_evidence (candidate, command, env_snapshot) WHERE run_class = 'declared';
CREATE TABLE IF NOT EXISTS lbl_revoked (evidence TEXT PRIMARY KEY, rev INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lbl_renewals (judgment TEXT NOT NULL, original TEXT NOT NULL, rev INTEGER NOT NULL, replacement TEXT NOT NULL, PRIMARY KEY (judgment, original, rev)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lbl_targets (target TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('object', 'unit')), rev INTEGER NOT NULL, scope TEXT);
CREATE TABLE IF NOT EXISTS lbl_members (member TEXT NOT NULL, unit TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (member, unit)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lbl_judgments (judgment TEXT PRIMARY KEY, target TEXT NOT NULL, review TEXT NOT NULL, rev INTEGER NOT NULL, state TEXT NOT NULL, decided_by TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS lbl_judgments_position ON lbl_judgments (target, review, rev);
CREATE TABLE IF NOT EXISTS lbl_regression (version TEXT NOT NULL, issue TEXT NOT NULL, rev INTEGER NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY (version, issue, rev)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lbl_ops (op TEXT PRIMARY KEY, kind TEXT NOT NULL, rev INTEGER NOT NULL, all_proven INTEGER);
CREATE TABLE IF NOT EXISTS lbl_executed (op TEXT PRIMARY KEY, as_of INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lbl_edges (src TEXT NOT NULL, dst TEXT NOT NULL, PRIMARY KEY (src, dst)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lbl_alerts (alert TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS lbl_episodes (op TEXT PRIMARY KEY, open INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lbl_cites (evidence TEXT NOT NULL, judgment TEXT NOT NULL, PRIMARY KEY (evidence, judgment)) WITHOUT ROWID;
`;

/**
 * Derived tables (§4.1): the facts of the derivation, the stored frontier and
 * the affected-set marks, the published labels, fixes and cycles.
 * `lbl_work`: one row per node with work left: `queued` (in the frontier, still
 * to visit; `cursor` resumes a long expansion) and `dirty` (an affected-set
 * mark: to recompute; phase 0 facts, phase 1 display values). A marked fact is
 * evaluated in resumable steps: `step` 0 counts its marked inputs (`wait`, one
 * `lbl_wait` row each; `pos` resumes a long input list), 1 waits for them, 2
 * combines them (`pos`, `acc`: the conjunction so far). `lbl_walk` is the path
 * of a cycle search when only waiting facts are left, and `lbl_scc` the search
 * of the cycle's whole strongly connected component. `lbl_scan*`: a unit's
 * combination over its members, or an object's coverage, read in resumable
 * steps (`phase`, `pos`, `sub`) and kept once `done`.
 */
const DERIVED_SCHEMA = `
CREATE TABLE IF NOT EXISTS lbl_facts (node TEXT PRIMARY KEY, holds INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lbl_work (
  node TEXT NOT NULL UNIQUE,
  queued INTEGER NOT NULL,
  dirty INTEGER NOT NULL,
  phase INTEGER NOT NULL,
  cursor TEXT,
  step INTEGER NOT NULL DEFAULT 0,
  wait INTEGER NOT NULL DEFAULT 0,
  pos INTEGER NOT NULL DEFAULT 0,
  acc INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS lbl_work_queued ON lbl_work (queued) WHERE queued = 1;
CREATE INDEX IF NOT EXISTS lbl_work_dirty ON lbl_work (phase, step) WHERE dirty = 1;
CREATE INDEX IF NOT EXISTS lbl_work_ready ON lbl_work (phase) WHERE dirty = 1 AND step >= 1 AND wait = 0;
CREATE INDEX IF NOT EXISTS lbl_work_releasing ON lbl_work (step) WHERE dirty = 0 AND step = 3;
CREATE TABLE IF NOT EXISTS lbl_wait (child TEXT NOT NULL, parent TEXT NOT NULL, PRIMARY KEY (child, parent)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS lbl_wait_parent ON lbl_wait (parent, child);
CREATE TABLE IF NOT EXISTS lbl_walk (seq INTEGER PRIMARY KEY, node TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS lbl_scc (node TEXT PRIMARY KEY, fwd INTEGER NOT NULL, fq INTEGER NOT NULL, fc TEXT, bwd INTEGER NOT NULL, bq INTEGER NOT NULL, bc TEXT) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS lbl_scc_fq ON lbl_scc (fq) WHERE fq = 1;
CREATE INDEX IF NOT EXISTS lbl_scc_bq ON lbl_scc (bq) WHERE bq = 1;
CREATE INDEX IF NOT EXISTS lbl_scc_both ON lbl_scc (fwd, bwd) WHERE fwd = 1 AND bwd = 1;
CREATE TABLE IF NOT EXISTS lbl_scan (target TEXT PRIMARY KEY, kind TEXT NOT NULL, phase INTEGER NOT NULL, pos INTEGER NOT NULL, sub INTEGER NOT NULL, conclusion TEXT NOT NULL, bw INTEGER NOT NULL, ok INTEGER NOT NULL, done INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lbl_scan_judgments (target TEXT NOT NULL, seq INTEGER NOT NULL, judgment TEXT NOT NULL, PRIMARY KEY (target, seq)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lbl_scan_reviewed (target TEXT NOT NULL, version TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (target, version, path)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lbl_labels (target TEXT PRIMARY KEY, conclusion TEXT NOT NULL, in_effect INTEGER NOT NULL, fresh INTEGER NOT NULL, label TEXT NOT NULL, rev INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS lbl_labels_label ON lbl_labels (label);
CREATE TABLE IF NOT EXISTS lbl_fixes (key TEXT PRIMARY KEY, target TEXT NOT NULL, issue TEXT NOT NULL, state TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS lbl_fixes_target ON lbl_fixes (target);
CREATE TABLE IF NOT EXISTS lbl_cycles (cycle TEXT PRIMARY KEY, nodes TEXT NOT NULL, judgment INTEGER NOT NULL, rev INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lbl_cycle_members (node TEXT NOT NULL, cycle TEXT NOT NULL, PRIMARY KEY (node, cycle)) WITHOUT ROWID;
`;

export const LABEL_SCHEMA = INDEX_SCHEMA + DERIVED_SCHEMA;

export const INDEX_TABLES: readonly string[] = [
  'lbl_meta',
  'lbl_basis',
  'lbl_lines',
  'lbl_patterns',
  'lbl_env',
  'lbl_evidence',
  'lbl_revoked',
  'lbl_renewals',
  'lbl_targets',
  'lbl_members',
  'lbl_judgments',
  'lbl_regression',
  'lbl_ops',
  'lbl_executed',
  'lbl_edges',
  'lbl_alerts',
  'lbl_episodes',
  'lbl_cites',
];

export const DERIVED_TABLES: readonly string[] = [
  'lbl_facts',
  'lbl_work',
  'lbl_wait',
  'lbl_walk',
  'lbl_scc',
  'lbl_scan',
  'lbl_scan_judgments',
  'lbl_scan_reviewed',
  'lbl_labels',
  'lbl_fixes',
  'lbl_cycles',
  'lbl_cycle_members',
];

export const LABEL_TABLES: readonly string[] = [...INDEX_TABLES, ...DERIVED_TABLES];

/**
 * Alert ids the labels raise (WI-16 cycles, WI-32 a lingering frontier) and the
 * episode notices of executed operations (6.1): kept (`lbl_alerts`,
 * `lbl_episodes`, from the log) so a rebuild never raises one twice.
 */
export const CYCLE_ALERT_PREFIX = 'cycle-';
export const FRONTIER_ALERT_PREFIX = 'labels-recomputing-';

// ---------------------------------------------------------------- small helpers

export function metaGet(db: Db, key: string): string | null {
  const row = db.stmt('SELECT value FROM lbl_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function metaSet(db: Db, key: string, value: string | null): void {
  if (value === null) db.stmt('DELETE FROM lbl_meta WHERE key = ?').run(key);
  else db.stmt('INSERT INTO lbl_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function edge(db: Db, src: string, dst: string): void {
  db.stmt('INSERT OR IGNORE INTO lbl_edges (src, dst) VALUES (?, ?)').run(src, dst);
}

function isListRef(v: unknown): v is ListRef {
  return Boolean(v) && typeof v === 'object' && typeof (v as ListRef).hash === 'string' && typeof (v as ListRef).count === 'number';
}

/** The memory's data store behind a Db (a Memory, a read through it, or a write transaction). */
function dataOf(db: Db): DataStore {
  const d = (db as { data?: unknown }).data;
  if (d instanceof DataStore) return d;
  throw new LedgerError('BAD_REQUEST', 'the labels read through the memory: pass the Memory, a read of it, or a write transaction');
}

/** A list, through the data store's checks: hash, a JSON list of strings, the declared count. Missing or damaged: refused. */
export function readList(db: Db, ref: ListRef): string[] {
  if (!isListRef(ref)) throw new LedgerError('RECORD_INVALID', 'a list reference is { hash, count }');
  return dataOf(db).getList(ref);
}

/**
 * A record with its lists resolved, each on first use (through `readList`,
 * counted on `meter`): a rule that never reads a list never pays for it.
 */
export function resolveLists<R extends BaseRecord>(db: Db, rec: R, lists?: Map<string, string[]>, meter?: Meter): Resolved<R> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!isListRef(v)) {
      out[k] = v;
      continue;
    }
    let items: string[] | undefined;
    Object.defineProperty(out, k, {
      enumerable: true,
      get: () => {
        if (items !== undefined) return items;
        items = lists?.get(v.hash);
        if (items === undefined) {
          meter?.tick();
          items = readList(db, v);
          lists?.set(v.hash, items);
        }
        return items;
      },
    });
  }
  return out as unknown as Resolved<R>;
}

/** A fact's committed record and revision, by its identity, through the memory's integrity check (a damaged event: CHAIN_BROKEN). */
export function factRecord<R extends BaseRecord>(db: Db, kind: string, ident: string): { rev: number; rec: R } | null {
  const c = factById(db, kind, ident);
  return c === null ? null : { rev: Number(c.revision), rec: c.record as R };
}

/** The record of one log event, through the memory's integrity check. */
export function eventRecord<R>(db: Db, rev: number): R {
  const row = db.stmt(`SELECT ${LOG_COLUMNS} FROM log WHERE rev = ?`).get(rev) as unknown as LogRow | undefined;
  if (row === undefined) throw new LedgerError('CHAIN_BROKEN', `event ${rev} is missing from the log`);
  return intactRecord<R>(db, row);
}

/** The node kind: the text before the first ':' ("j", "ev", "cs"...). */
export function nodeKind(node: string): string {
  return node.slice(0, node.indexOf(':'));
}

export function nodeId(node: string): string {
  return node.slice(node.indexOf(':') + 1);
}

/** A constraint scan node: every object whose scope the constraint scope matches gets its freshness recomputed. */
export function scopeNode(scope: ConstraintScope): string {
  return `cs:${canonicalJson({ paths: scope.paths, taskTypes: scope.taskTypes })}`;
}

// ---------------------------------------------------------------- projection of base records

/** The record kinds that can change labels (records.ts EVALUATOR_INPUT_KINDS). */
export const INPUT_KINDS: ReadonlySet<string> = new Set([
  'basis.version',
  'constraint.scope',
  'basis.withdrawn',
  'env.snapshot',
  'evidence',
  'evidence.revoked',
  'evidence.renewal',
  'object.version',
  'proof.unit',
  'judgment',
  'issue',
  'issue.coverage',
  'op.pending',
  'op.executed',
]);

/** The line's patterns go from `before` to `after`; a withdrawn line has none (the coverage reads active constraints only). */
function setPatterns(db: Db, line: string, before: ConstraintScope | null, after: ConstraintScope | null, withdrawn: boolean): void {
  for (const p of before?.paths ?? []) db.stmt('DELETE FROM lbl_patterns WHERE pattern = ? AND line = ?').run(p, line);
  if (withdrawn) return;
  for (const p of after?.paths ?? []) db.stmt('INSERT OR IGNORE INTO lbl_patterns (pattern, line) VALUES (?, ?)').run(p, line);
}

function lineRow(db: Db, line: string): { latest: string | null; withdrawn_rev: number | null; scope: string | null; constraint_line: number } | null {
  return (db.stmt('SELECT latest, withdrawn_rev, scope, constraint_line FROM lbl_lines WHERE line = ?').get(line) as
    | { latest: string | null; withdrawn_rev: number | null; scope: string | null; constraint_line: number }
    | undefined) ?? null;
}

function parseScope(s: string | null): ConstraintScope | null {
  return s === null ? null : (JSON.parse(s) as ConstraintScope);
}

/**
 * Add one base record to the index (and its reverse edges), as the in-memory
 * Index.add did, and return the nodes it touches directly (the seeds of 5.4
 * step 1). A fact with an identity already indexed is
 * ignored, as there.
 */
export function projectRecord(db: Db, rec: BaseRecord, rev: number): string[] {
  const seeds: string[] = [];
  switch (rec.kind) {
    case 'basis.version': {
      if (db.stmt('SELECT 1 FROM lbl_basis WHERE version = ?').get(rec.version)) return seeds;
      db.stmt('INSERT INTO lbl_basis (version, line, kind, rev) VALUES (?, ?, ?, ?)').run(rec.version, rec.line, rec.basisKind, rev);
      edge(db, `line:${rec.line}`, `bv:${rec.version}`);
      const prev = lineRow(db, rec.line);
      if (rec.basisKind === 'constraint') {
        // A new content version keeps the current scope unless it states one.
        const before = prev !== null && prev.constraint_line === 1 ? parseScope(prev.scope) : null;
        const after = rec.scope ?? before;
        setPatterns(db, rec.line, before, after, prev !== null && prev.withdrawn_rev !== null);
        db.stmt(
          'INSERT INTO lbl_lines (line, latest, withdrawn_rev, scope, constraint_line) VALUES (?, ?, NULL, ?, 1) ON CONFLICT(line) DO UPDATE SET latest = excluded.latest, scope = excluded.scope, constraint_line = 1',
        ).run(rec.line, rec.version, after === null ? null : canonicalJson(after));
        if (before !== null) seeds.push(scopeNode(before));
        if (after !== null) seeds.push(scopeNode(after));
      } else {
        db.stmt('INSERT INTO lbl_lines (line, latest, withdrawn_rev, scope, constraint_line) VALUES (?, ?, NULL, NULL, 0) ON CONFLICT(line) DO UPDATE SET latest = excluded.latest').run(rec.line, rec.version);
      }
      seeds.push(`line:${rec.line}`);
      return seeds;
    }
    case 'constraint.scope': {
      const prev = lineRow(db, rec.line);
      if (prev === null || prev.constraint_line !== 1) return seeds;
      const before = parseScope(prev.scope);
      setPatterns(db, rec.line, before, rec.scope, prev.withdrawn_rev !== null);
      db.stmt('UPDATE lbl_lines SET scope = ? WHERE line = ?').run(canonicalJson(rec.scope), rec.line);
      if (before !== null) seeds.push(scopeNode(before));
      seeds.push(scopeNode(rec.scope));
      return seeds;
    }
    case 'basis.withdrawn': {
      const prev = lineRow(db, rec.line);
      db.stmt('INSERT INTO lbl_lines (line, latest, withdrawn_rev, scope, constraint_line) VALUES (?, NULL, ?, NULL, 0) ON CONFLICT(line) DO UPDATE SET withdrawn_rev = COALESCE(lbl_lines.withdrawn_rev, excluded.withdrawn_rev)').run(
        rec.line,
        rev,
      );
      const scope = prev !== null && prev.constraint_line === 1 ? parseScope(prev.scope) : null;
      setPatterns(db, rec.line, scope, null, true);
      if (scope !== null) seeds.push(scopeNode(scope));
      seeds.push(`line:${rec.line}`);
      return seeds;
    }
    case 'env.snapshot':
      db.stmt('INSERT OR REPLACE INTO lbl_env (line, rev, snapshot) VALUES (?, ?, ?)').run(rec.line, rev, rec.snapshot);
      seeds.push(`env:${rec.line}`);
      return seeds;
    case 'evidence': {
      if (db.stmt('SELECT 1 FROM lbl_evidence WHERE evidence = ?').get(rec.evidence)) return seeds;
      const f = rec.fields;
      db.stmt('INSERT INTO lbl_evidence (evidence, env_line, env_snapshot, run_class, fields, candidate, command, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        rec.evidence,
        rec.envLine,
        rec.envSnapshot,
        rec.runClass,
        canonicalJson(f),
        Object.hasOwn(f, RUN_FIELD.candidate) ? f[RUN_FIELD.candidate]! : null,
        Object.hasOwn(f, RUN_FIELD.command) ? f[RUN_FIELD.command]! : null,
        rev,
      );
      edge(db, `env:${rec.envLine}`, `ev:${rec.evidence}`);
      seeds.push(`ev:${rec.evidence}`);
      return seeds;
    }
    case 'evidence.revoked':
      db.stmt('INSERT OR IGNORE INTO lbl_revoked (evidence, rev) VALUES (?, ?)').run(rec.evidence, rev);
      seeds.push(`ev:${rec.evidence}`);
      return seeds;
    case 'evidence.renewal':
      db.stmt('INSERT OR IGNORE INTO lbl_renewals (judgment, original, rev, replacement) VALUES (?, ?, ?, ?)').run(rec.judgment, rec.original, rev, rec.replacement);
      edge(db, `ev:${rec.original}`, `j:${rec.judgment}`);
      edge(db, `ev:${rec.replacement}`, `j:${rec.judgment}`);
      seeds.push(`j:${rec.judgment}`);
      return seeds;
    case 'object.version': {
      if (db.stmt('SELECT 1 FROM lbl_targets WHERE target = ?').get(rec.object)) return seeds;
      db.stmt("INSERT INTO lbl_targets (target, kind, rev, scope) VALUES (?, 'object', ?, ?)").run(rec.object, rev, canonicalJson(rec.scope));
      for (const p of readList(db, rec.prerequisites)) edge(db, `p:${p}`, `f:${rec.object}`);
      seeds.push(`e:${rec.object}`, `f:${rec.object}`, `p:${rec.object}`, `tj:${rec.object}`);
      return seeds;
    }
    case 'proof.unit': {
      if (db.stmt('SELECT 1 FROM lbl_targets WHERE target = ?').get(rec.unit)) return seeds;
      db.stmt("INSERT INTO lbl_targets (target, kind, rev, scope) VALUES (?, 'unit', ?, NULL)").run(rec.unit, rev);
      seeds.push(`e:${rec.unit}`, `f:${rec.unit}`, `p:${rec.unit}`, `tj:${rec.unit}`);
      for (const m of readList(db, rec.members)) {
        db.stmt('INSERT OR IGNORE INTO lbl_members (member, unit, rev) VALUES (?, ?, ?)').run(m, rec.unit, rev);
        edge(db, `e:${m}`, `e:${rec.unit}`);
        edge(db, `f:${m}`, `f:${rec.unit}`);
        edge(db, `p:${rec.unit}`, `p:${m}`);
        seeds.push(`e:${m}`, `f:${m}`, `p:${m}`);
      }
      return seeds;
    }
    case 'judgment': {
      if (db.stmt('SELECT 1 FROM lbl_judgments WHERE judgment = ?').get(rec.judgment)) return seeds;
      // The position's state after this judgment (semantics.ts positionState, one step of its fold): a negation
      // stands until a pass of a non-Auditor names it in `revokes`; a later negation replaces it.
      const prev = db.stmt('SELECT state, decided_by FROM lbl_judgments WHERE target = ? AND review = ? ORDER BY rev DESC LIMIT 1').get(rec.target, rec.review) as
        | { state: string; decided_by: string }
        | undefined;
      let state: string = rec.verdict;
      let by: string = rec.judgment;
      if (prev?.state === 'fail' && rec.verdict !== 'fail' && !(rec.verdict === 'pass' && rec.executor !== 'auditor' && rec.revokes === prev.decided_by)) {
        state = 'fail';
        by = prev.decided_by;
      }
      db.stmt('INSERT INTO lbl_judgments (judgment, target, review, rev, state, decided_by) VALUES (?, ?, ?, ?, ?, ?)').run(rec.judgment, rec.target, rec.review, rev, state, by);
      const j = `j:${rec.judgment}`;
      edge(db, j, `e:${rec.target}`);
      edge(db, `tj:${rec.target}`, j);
      for (const e of readList(db, rec.evidence)) edge(db, `ev:${e}`, j);
      for (const b of readList(db, rec.bases)) edge(db, `bv:${b}`, j);
      for (const o of readList(db, rec.reliesOn)) edge(db, `p:${o}`, j);
      if (rec.extends !== null) edge(db, `j:${rec.extends}`, j);
      seeds.push(j, `e:${rec.target}`, `f:${rec.target}`, `p:${rec.target}`);
      return seeds;
    }
    case 'issue':
      return seeds;
    case 'issue.coverage':
      db.stmt('INSERT OR IGNORE INTO lbl_regression (version, issue, rev, evidence) VALUES (?, ?, ?, ?)').run(rec.version, rec.issue, rev, rec.evidence);
      edge(db, `ev:${rec.evidence}`, `x:${rec.version}`);
      seeds.push(`x:${rec.version}`);
      return seeds;
    case 'op.pending': {
      if (db.stmt('SELECT 1 FROM lbl_ops WHERE op = ?').get(rec.op)) return seeds;
      db.stmt('INSERT INTO lbl_ops (op, kind, rev, all_proven) VALUES (?, ?, ?, NULL)').run(rec.op, rec.opKind, rev);
      for (const t of readList(db, rec.objects)) edge(db, `p:${t}`, `o:${rec.op}`);
      seeds.push(`o:${rec.op}`);
      return seeds;
    }
    case 'op.executed':
      if (db.stmt('SELECT 1 FROM lbl_executed WHERE op = ?').get(rec.op)) return seeds;
      db.stmt('INSERT INTO lbl_executed (op, as_of) VALUES (?, ?)').run(rec.op, rec.asOf);
      seeds.push(`o:${rec.op}`);
      return seeds;
    default:
      return seeds;
  }
}

// ---------------------------------------------------------------- the rules' view of the index

/** Thrown by a full meter: the step that read it stops before it changes anything, and its batch ends. */
export const METER_FULL: unique symbol = Symbol('meter full');

/** Stored reads counted for a batch (labels.ts): every read the rules make costs one unit; past `cap` the reader stops. */
export class Meter {
  n = 0;
  cap = Number.POSITIVE_INFINITY;

  tick(): void {
    if (++this.n > this.cap) throw METER_FULL;
  }
}

/** A lookup that loads each key once per instance (negative answers included), each load counted on the meter. */
class Lazy<K, V> implements ReadMap<K, V> {
  private readonly cache = new Map<K, V | undefined>();
  private readonly load: (key: K) => V | undefined;
  private readonly meter: Meter;

  constructor(meter: Meter, load: (key: K) => V | undefined) {
    this.meter = meter;
    this.load = load;
  }

  get(key: K): V | undefined {
    if (this.cache.has(key)) return this.cache.get(key);
    this.meter.tick();
    const v = this.load(key);
    this.cache.set(key, v);
    return v;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }
}

function pair(key: string): [string, string] {
  return JSON.parse(key) as [string, string];
}

/** A read-through view over metered lookups (no cache and no count of its own). */
function view<K, V>(get: (key: K) => V | undefined): ReadMap<K, V> {
  return { get, has: (key) => get(key) !== undefined };
}

/**
 * The rules' IndexView over the stored index (semantics.ts reads only this).
 * Each answer is loaded once per instance and counted on its meter; an
 * instance serves one transaction and is dropped before anything is appended
 * to the index again.
 */
export class StoredIndex implements IndexView {
  readonly meter: Meter;
  private readonly db: Db;
  private readonly lists = new Map<string, string[]>();
  private readonly checks = new Map<string, ConstraintCheck | null>();
  private readonly patternLines: Lazy<string, readonly BasisLineId[]>;
  private readonly positions: Lazy<string, PositionState>;
  private readonly envBefore: Lazy<string, EnvSnapshotId | null>;

  readonly basisLatest: ReadMap<BasisLineId, BasisVersionId>;
  readonly basisLineOf: ReadMap<BasisVersionId, BasisLineId>;
  readonly basisKindOf: ReadMap<BasisVersionId, string>;
  readonly withdrawn: ReadSet<BasisLineId>;
  readonly constraints: ReadMap<BasisLineId, ConstraintLine>;
  readonly envCurrent: ReadMap<EnvLineId, EnvSnapshotId>;
  readonly evidence: ReadMap<EvidenceId, Resolved<EvidenceRecord>>;
  readonly revoked: ReadSet<EvidenceId>;
  readonly renewal: ReadMap<string, ReadonlyArray<{ readonly rev: Revision; readonly replacement: EvidenceId }>>;
  readonly objects: ReadMap<ObjectVersionId, Resolved<ObjectVersionRecord>>;
  readonly units: ReadMap<ProofUnitId, Resolved<ProofUnitRecord>>;
  readonly unitOf: ReadMap<ObjectVersionId, ProofUnitId>;
  readonly judgments: ReadMap<JudgmentId, JudgmentInfo>;
  readonly byPosition: ReadMap<ReviewPosition, readonly JudgmentInfo[]>;
  readonly regression: ReadMap<string, readonly RegressionRun[]>;
  readonly regressionIssuesByTarget: ReadMap<string, Iterable<IssueId>>;
  readonly pendingOps: ReadMap<OpId, Resolved<PendingOpRecord>>;
  readonly executed: ReadMap<OpId, Revision>;
  readonly basisRev: ReadMap<BasisVersionId, Revision>;
  readonly withdrawnRev: ReadMap<BasisLineId, Revision>;
  readonly envHistory: ReadMap<EnvLineId, ReadonlyArray<{ readonly rev: Revision; readonly snapshot: EnvSnapshotId }>>;
  readonly evidenceRev: ReadMap<EvidenceId, Revision>;
  readonly revokedRev: ReadMap<EvidenceId, Revision>;

  constructor(db: Db, meter: Meter = new Meter()) {
    this.db = db;
    this.meter = meter;
    const m = meter;
    this.patternLines = new Lazy(m, (p) => (db.stmt('SELECT line FROM lbl_patterns WHERE pattern = ?').all(p) as Array<{ line: string }>).map((r) => r.line as BasisLineId));
    const lines = new Lazy(m, (l: string) => lineRow(db, l) ?? undefined);
    const basis = new Lazy(m, (v: string) => db.stmt('SELECT line, kind, rev FROM lbl_basis WHERE version = ?').get(v) as { line: string; kind: string; rev: number } | undefined);
    const revoked = new Lazy(m, (e: string) => (db.stmt('SELECT rev FROM lbl_revoked WHERE evidence = ?').get(e) as { rev: number } | undefined)?.rev);
    this.basisLatest = view((l) => (lines.get(l)?.latest ?? undefined) as BasisVersionId | undefined);
    this.basisLineOf = view((v) => basis.get(v)?.line as BasisLineId | undefined);
    this.basisKindOf = view((v) => basis.get(v)?.kind);
    this.basisRev = view((v) => basis.get(v)?.rev as Revision | undefined);
    this.withdrawnRev = view((l) => (lines.get(l)?.withdrawn_rev ?? undefined) as Revision | undefined);
    this.withdrawn = { has: (l) => this.withdrawnRev.get(l) !== undefined };
    this.constraints = view((l) => {
      const r = lines.get(l);
      if (!r || r.constraint_line !== 1 || r.latest === null) return undefined;
      return { latest: r.latest as BasisVersionId, scope: parseScope(r.scope) };
    });
    this.envHistory = new Lazy(m, (l) =>
      (db.stmt('SELECT rev, snapshot FROM lbl_env WHERE line = ? ORDER BY rev').all(l) as Array<{ rev: number; snapshot: string }>).map((r) => ({
        rev: Number(r.rev) as Revision,
        snapshot: r.snapshot as EnvSnapshotId,
      })),
    );
    this.envCurrent = new Lazy(m, (l) => (db.stmt('SELECT snapshot FROM lbl_env WHERE line = ? ORDER BY rev DESC LIMIT 1').get(l) as { snapshot: string } | undefined)?.snapshot as EnvSnapshotId | undefined);
    const evidenceRows = new Lazy<string, { rec: Resolved<EvidenceRecord>; rev: number }>(m, (e) => {
      const r = db.stmt('SELECT env_line, env_snapshot, run_class, fields, rev FROM lbl_evidence WHERE evidence = ?').get(e) as
        | { env_line: string; env_snapshot: string; run_class: string; fields: string; rev: number }
        | undefined;
      if (r === undefined) return undefined;
      const rec = { kind: 'evidence', evidence: e, envLine: r.env_line, envSnapshot: r.env_snapshot, runClass: r.run_class, fields: JSON.parse(r.fields) } as unknown as Resolved<EvidenceRecord>;
      return { rec, rev: Number(r.rev) };
    });
    this.evidence = view((e) => evidenceRows.get(e)?.rec);
    this.evidenceRev = view((e) => evidenceRows.get(e)?.rev as Revision | undefined);
    this.revokedRev = view((e) => revoked.get(e) as Revision | undefined);
    this.revoked = { has: (e) => revoked.get(e) !== undefined };
    this.renewal = new Lazy(m, (key) => {
      const [judgment, original] = pair(key);
      return (db.stmt('SELECT rev, replacement FROM lbl_renewals WHERE judgment = ? AND original = ? ORDER BY rev').all(judgment, original) as Array<{ rev: number; replacement: string }>).map((r) => ({
        rev: Number(r.rev) as Revision,
        replacement: r.replacement as EvidenceId,
      }));
    });
    this.objects = new Lazy(m, (o) => {
      const f = factRecord<ObjectVersionRecord>(db, 'object.version', o);
      return f === null ? undefined : resolveLists(db, f.rec, this.lists, m);
    });
    this.units = new Lazy(m, (u) => {
      const f = factRecord<ProofUnitRecord>(db, 'proof.unit', u);
      return f === null ? undefined : resolveLists(db, f.rec, this.lists, m);
    });
    this.unitOf = new Lazy(m, (mm) => (db.stmt('SELECT unit FROM lbl_members WHERE member = ? ORDER BY rev DESC LIMIT 1').get(mm) as { unit: string } | undefined)?.unit as ProofUnitId | undefined);
    this.judgments = new Lazy(m, (j) => {
      const f = factRecord<JudgmentRecord>(db, 'judgment', j);
      return f === null ? undefined : { rev: f.rev as Revision, rec: resolveLists(db, f.rec, this.lists, m) };
    });
    this.byPosition = new Lazy(m, (pos) => {
      const [target, review] = pair(pos);
      const ids = db.stmt('SELECT judgment FROM lbl_judgments WHERE target = ? AND review = ? ORDER BY rev').all(target, review) as Array<{ judgment: string }>;
      return ids.map((r) => this.judgments.get(r.judgment as JudgmentId)).filter((x): x is JudgmentInfo => x !== undefined);
    });
    this.regression = new Lazy(m, (key) => {
      const [issue, version] = pair(key);
      const revs = db.stmt('SELECT rev FROM lbl_regression WHERE version = ? AND issue = ? ORDER BY rev').all(version, issue) as Array<{ rev: number }>;
      return revs.map((r) => {
        m.tick();
        const rec = resolveLists(db, eventRecord<FixCoverageRecord>(db, Number(r.rev)), this.lists, m);
        return { evidence: rec.evidence, command: rec.command, tests: rec.tests, inputs: rec.inputs };
      });
    });
    this.regressionIssuesByTarget = new Lazy(m, (t) => new Set((db.stmt('SELECT DISTINCT issue FROM lbl_regression WHERE version = ?').all(t) as Array<{ issue: string }>).map((r) => r.issue as IssueId)));
    this.pendingOps = new Lazy(m, (op) => {
      const f = factRecord<PendingOpRecord>(db, 'op.pending', op);
      return f === null ? undefined : resolveLists(db, f.rec, this.lists, m);
    });
    this.executed = new Lazy(m, (op) => (db.stmt('SELECT as_of FROM lbl_executed WHERE op = ?').get(op) as { as_of: number } | undefined)?.as_of as Revision | undefined);
    this.positions = new Lazy(m, (key) => {
      const [target, review, before] = JSON.parse(key) as [string, string, number | null];
      const r = (
        before === null
          ? db.stmt('SELECT state, decided_by FROM lbl_judgments WHERE target = ? AND review = ? ORDER BY rev DESC LIMIT 1').get(target, review)
          : db.stmt('SELECT state, decided_by FROM lbl_judgments WHERE target = ? AND review = ? AND rev < ? ORDER BY rev DESC LIMIT 1').get(target, review, before)
      ) as { state: 'pass' | 'fail' | 'undecided'; decided_by: string } | undefined;
      if (r === undefined) return { state: 'none' };
      const by = this.judgments.get(r.decided_by as JudgmentId);
      return by === undefined ? { state: 'none' } : { state: r.state, by };
    });
    this.envBefore = new Lazy(m, (key) => {
      const [line, before] = JSON.parse(key) as [string, number];
      const r = db.stmt('SELECT snapshot FROM lbl_env WHERE line = ? AND rev < ? ORDER BY rev DESC LIMIT 1').get(line, before) as { snapshot: string } | undefined;
      return r === undefined ? null : (r.snapshot as EnvSnapshotId);
    });
  }

  /** A position's state before `beforeRev` (Infinity: now), one stored lookup (the fold is kept with each judgment). */
  positionAt(target: string, review: string, beforeRev: number): PositionState {
    return this.positions.get(JSON.stringify([target, review, Number.isFinite(beforeRev) ? beforeRev : null]))!;
  }

  /** An environment line's snapshot before `beforeRev`, one stored lookup. */
  envAt(line: EnvLineId, beforeRev: number): EnvSnapshotId | undefined {
    if (!Number.isFinite(beforeRev)) return this.envCurrent.get(line);
    return this.envBefore.get(JSON.stringify([line, beforeRev])) ?? undefined;
  }

  constraintsFor(scope: ObjectScope): Set<BasisLineId> {
    const out = new Set<BasisLineId>();
    for (const p of scope.paths) for (const pat of candidatePatterns(p)) for (const l of this.patternLines.get(pat) ?? []) out.add(l);
    return out;
  }

  check(enc: string): ConstraintCheck | null {
    let c = this.checks.get(enc);
    if (c === undefined) {
      try {
        c = decodeConstraintCheck(enc);
      } catch {
        c = null;
      }
      this.checks.set(enc, c);
    }
    return c;
  }

  contracts(target: string): readonly ReviewContract[] | null {
    return (this.objects.get(target as ObjectVersionId) ?? this.units.get(target as ProofUnitId))?.reviews ?? null;
  }

  isTarget(target: string): boolean {
    return this.objects.has(target as ObjectVersionId) || this.units.has(target as ProofUnitId);
  }

  /** A finished scan (never cached: a scan finishes inside a batch). */
  scanned(target: string): TargetScan | undefined {
    this.meter.tick();
    const r = this.db.stmt('SELECT ok, conclusion, bw FROM lbl_scan WHERE target = ? AND done = 1').get(target) as { ok: number; conclusion: Conclusion; bw: number } | undefined;
    return r === undefined ? undefined : { ok: r.ok === 1, conclusion: r.conclusion, basisWithdrawn: r.bw === 1 };
  }
}

/** A target's scan is out of date (its facts are marked again). */
export function dropScan(db: Db, target: string): void {
  db.stmt('DELETE FROM lbl_scan WHERE target = ?').run(target);
  db.stmt('DELETE FROM lbl_scan_judgments WHERE target = ?').run(target);
  db.stmt('DELETE FROM lbl_scan_reviewed WHERE target = ?').run(target);
}

// ---------------------------------------------------------------- stored facts

/**
 * A Derivation's facts read from `lbl_facts` (§4.1), for reads: values computed
 * on demand stay in this instance.
 */
export class StoredMemo implements FactMemo {
  private readonly db: Db;
  private readonly cache = new Map<string, boolean | undefined>();

  constructor(db: Db) {
    this.db = db;
  }

  get(node: string): boolean | undefined {
    if (this.cache.has(node)) return this.cache.get(node);
    const v = factOf(this.db, node);
    this.cache.set(node, v);
    return v;
  }

  set(node: string, value: boolean): void {
    this.cache.set(node, value);
  }

  delete(node: string): void {
    this.cache.set(node, undefined);
  }
}

/** A stored fact, or undefined when it is not (or no longer) computed. */
export function factOf(db: Db, node: string): boolean | undefined {
  const row = db.stmt('SELECT holds FROM lbl_facts WHERE node = ?').get(node) as { holds: number } | undefined;
  return row === undefined ? undefined : row.holds === 1;
}

/** The node's affected-set mark is done: the row goes unless it is still in the frontier. */
export function clearMark(db: Db, node: string): void {
  db.stmt('DELETE FROM lbl_work WHERE node = ? AND queued = 0').run(node);
  db.stmt('UPDATE lbl_work SET dirty = 0, step = 0, wait = 0, pos = 0, acc = 1 WHERE node = ?').run(node);
}
