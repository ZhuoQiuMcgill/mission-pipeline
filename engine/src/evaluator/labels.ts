// Stored proof labels (design 4.1 §4.1; v51 5.2-5.5, 6.1): the labels
// extension of the project memory.
//
// There is no long-lived process, so the derived state (proof labels, the
// affected-set marks of v51 5.4) lives in derived tables of the skeleton,
// stamped with the log revision they reflect (`lbl_meta.rev`). The base records
// stay the source of truth; `recompute` rebuilds every label table from them
// (after verifying the log), and a rebuild of the memory (after a move) does
// the same.
//
// Propagation is 4.0's in-memory algorithm (5.4) on stored tables, cut into
// bounded, resumable steps:
//   1. each appended base record is indexed (store.ts) and the nodes it
//      touches join the stored frontier (`lbl_work.queued`);
//   2. discovery: a frontier node is visited once, gets its affected-set mark
//      (`dirty`; a fact's stored value is dropped) and pushes every node that
//      reads it and is not already marked or queued (one that is marked and
//      half evaluated starts its evaluation again); a long expansion resumes
//      from its cursor;
//   3. evaluation, only once the frontier is empty, by readiness: a marked
//      fact counts its marked inputs (`lbl_wait`), and once none is left it is
//      evaluated by the kept rules (semantics.ts: `guard` and every input of
//      `kids` holding), its inputs read in chunks; a finished fact releases the
//      facts waiting on it. When only waiting facts are left, they wait on each
//      other: a walk along the waits finds a cycle, whose facts do not hold
//      (the least fixed point), and it is kept for WI-16. Then the display
//      values (labels, fixes, operations) of the marked targets.
// Work is counted in units: every edge scanned, every input read, every
// variable visited or decided, and every stored read a rule makes (the index's
// meter). A step is one record's work (one event's projection, one object
// against a changed constraint scope, one rule, one page or chunk of edges or
// inputs), never a page of records, and every step leaves its progress stored,
// so the next batch goes on from there (v06 Appendix E). The numbers are
// targets: a batch aims at UNIT_LIMIT units and the write's work budget and
// stops before a step that would go over. But a batch of the PM (`mp pm next`:
// `labelBatch`, `mp pm drain`: `drain`) commits at least one step: its first
// step runs alone whatever its size, so propagation always makes progress;
// the batches that ride on other writes (`beforeCommit`, `beforeWrite`, the
// gate) stop before any step that does not fit and leave it to the PM's. The
// write that appends records does one batch itself, at its end
// (`beforeCommit`); what does not fit stays stored, and every later write
// (`beforeWrite`), `mp pm next` and `mp pm drain` do one batch each, as their
// own write. New events join the same frontier.
//
// While any work is left (or an event is not indexed yet), every decision that
// needs "proven" treats the whole project as recomputing: the gate refuses
// (RECOMPUTING, with how much is left) and `decisionLabels` answers
// "recomputing"; display reads return the last labels marked recomputing.
// Stops are never held back: a stop write skips `beforeWrite`, and a write that
// appends no proof record does no propagation. A frontier left non-empty for
// 10 minutes raises WI-32; a new dependency cycle through a judgment raises
// WI-16 once the labels are current, and so does the episode notice of an
// executed operation that lost (or regained) "all proven" (6.1). Notices are
// raised only by batches that are their own write.
//
// Records are admitted with checks that never depend on how far the index has
// come (4.1 §6.5): a judgment that uses a timing, statistical or external field
// cites only sampling runs (checked against the runs' own records); a renewal
// names a rerun of the same candidate and command; a scope path has at most
// PATH_DEPTH_MAX segments (against malformed input). No admission limit exists
// to keep batches small (v06 Appendix E): a large record is one large step.
//
// The environment identity (environment.ts) is part of the label computation:
// a run is applicable only while its environment line's current snapshot is the
// identity it was recorded under (v51 5.2 "证据的适用性"), and the gate refuses a
// decision in a process that has not observed the current identity.

import { canonicalJson, sha256 } from '../common/hash.ts';
import { id, type AlertId, type JudgmentId, type ObjectVersionId, type ProofUnitId } from '../common/ids.ts';
import { reviewPosition, type BaseRecord, type ConstraintScope, type EvidenceRecord, type JudgmentRecord, type ObjectScope, type ProofOpKind } from '../common/records.ts';
import { appendFact, checkShape, intactRecord, LedgerError, LOG_COLUMNS, raiseAlert, registerMemoryExtension, walkChain, type Db, type LogRecord, type LogRow, type Memory, type MemoryExtension, type WriteRequest, type WriteTx } from '../memory/index.ts';
import { ENV_LINE, observedEnvironment, recordedEnvironment } from './environment.ts';
import { usesSampledFields } from './renewal.ts';
import { rerunMismatch } from './runs.ts';
import {
  basisState,
  basisWithdrawnIn,
  candidatePatterns,
  composite,
  concreteScope,
  Derivation,
  evidenceApplicable,
  ownStructure,
  worseConclusion,
  type Conclusion,
  type BasisState,
  type ContinuationRequest,
  type ContinuationResult,
  type DecidingView,
  type DerivedState,
  type FixState,
  type Label,
  type OpState,
  type TargetState,
} from './semantics.ts';
import {
  clearMark,
  CYCLE_ALERT_PREFIX,
  DERIVED_TABLES,
  dropScan,
  factOf,
  factRecord,
  FRONTIER_ALERT_PREFIX,
  INPUT_KINDS,
  LABEL_SCHEMA,
  LABEL_TABLES,
  METER_FULL,
  Meter,
  metaGet,
  metaSet,
  nodeId,
  nodeKind,
  projectRecord,
  readList,
  StoredIndex,
  StoredMemo,
} from './store.ts';

/** One batch's target (§4.1, v06): it stops before a step that would take it past this many units. */
export const UNIT_LIMIT = 20_000;
/** §4.1, WI-32: a frontier non-empty this long raises a notice. */
export const FRONTIER_NOTICE_MS = 10 * 60_000;
/** The rules the labels follow (4.0's v35 rules, stored as 4.1 §4.1 says). */
export const LABEL_RULES = 'v35-2026-10-09+4.1-stored';
/** The most segments of a scope path (against malformed input, v06 Appendix E: each is a pattern its coverage looks up). */
export const PATH_DEPTH_MAX = 64;

let batchLimit = UNIT_LIMIT;

/** The smallest batch a test may set. */
const BATCH_LIMIT_MIN = 256;

/** Tests: a smaller batch target (at least 256 units), to exercise the stored frontier on small graphs (null: back to UNIT_LIMIT). */
export function setLabelBatchLimit(units: number | null): void {
  batchLimit = units === null ? UNIT_LIMIT : Math.max(BATCH_LIMIT_MIN, units);
}

/** Edges read per visit of one node; a longer expansion resumes from its cursor in the next visit. */
const PAGE = 512;
/** A discovery visit costs its node, its implicit edges and its page of edges (as many as there is room for, up to PAGE). */
const VISIT_MIN = 6;
/** Inputs read per evaluation step; a longer input list resumes from its position in the next step. */
const CHUNK = 512;

/*
 * The steps and the worst case of each (units; a "list" is at most
 * MAX_LIST_ITEMS = 250,000 entries, a record at most 64 KiB, so a scope at
 * most 10,000 paths of at most PATH_DEPTH_MAX segments, a target at most 64
 * review positions). A step past the batch's target runs only as the first
 * step of a PM batch, alone.
 *   catch-up        one event's projection: 5 + its lists (a proof unit: 4 per
 *                   member, so ≤ 1,000,005; a judgment: its evidence twice,
 *                   bases and reliances; an object: its prerequisites)
 *   visit           one node: its mark and implicit edges (4) and one page of
 *                   its reverse edges (≤ PAGE)
 *   scope visit     one object against a changed constraint scope: 1 + its
 *                   paths (≤ 10,001; each path looks up its ≤ 66 candidate
 *                   patterns in the scope's set, built once per batch)
 *   count/combine   one rule's reads (a judgment: ≤ ~4 per entry of its
 *                   evidence, bases and constraint checks and its
 *                   continuation's; a target: ≤ ~3 per review position, the
 *                   position's state being one stored lookup, never its
 *                   history), then one chunk of its inputs (≤ CHUNK)
 *   release         one page of the facts waiting on a decided one (≤ PAGE)
 *   walk, component one page of waits (≤ PAGE)
 *   scan start      one target's positions and deciding judgments (≤ ~4 × 64)
 *   scan member     one member's positions and deciding judgments (≤ ~4 × 64)
 *   scan checks     one deciding judgment's constraint checks (its list and
 *                   their paths), then one chunk of them (≤ CHUNK)
 *   scan path       one scope path against the active constraints whose
 *                   patterns match it (≤ 66 lookups and one per such line)
 *   display         one target's label (≤ ~4 × 64), one target's fixes (≤ ~4
 *                   per registered regression run and per issue on it), or
 *                   one chunk of an operation's objects (≤ CHUNK)
 * No step reads a withdrawn constraint, a position's or an environment line's
 * history: their cost does not grow with the project's age.
 */

const FACT_KINDS: ReadonlySet<string> = new Set(['j', 'e', 'f', 'p']);
/** t: a target's label; x: its fixes; o: an operation's "all proven". */
const DISPLAY_KINDS: ReadonlySet<string> = new Set(['t', 'x', 'o']);
/** A fact that is decided and still releases the facts waiting on it. */
const RELEASING = 3;

function phaseOf(node: string): number {
  return DISPLAY_KINDS.has(nodeKind(node)) ? 1 : 0;
}

// ---------------------------------------------------------------- work accounting

/** How a batch runs (v06 Appendix E). */
interface BatchKind {
  /** The units it aims at (Infinity: no target, a full computation). */
  readonly limit: number;
  /** Time kept free of the write's work budget, for the rest of the write and its commit. */
  readonly reserveMs: number;
  /** The time it aims at, from its start (Infinity: the write's budget alone decides). */
  readonly targetMs: number;
  /** A PM batch: its first step runs alone, whatever it costs (the batch commits at least one step). */
  readonly lone: boolean;
  /** A batch that is its own write: it also raises the WI-32, WI-16 and episode notices. */
  readonly notices: boolean;
}

/**
 * The units and time of one batch. A step starts only with room for its cost
 * (known before, or capped on the meter: a step whose reads hit the cap stops
 * before it changes anything), in units and in time. The first step of a PM
 * batch (`lone`) has no cap at all, and is never stopped for its time.
 */
class Work {
  spent = 0;
  /** Steps committed in this batch (a drain checks every batch made some). */
  progress = 0;
  /** The first step went past the batch's targets (a PM batch's lone step). */
  oversized = false;
  readonly meter = new Meter();
  readonly limit: number;
  private readonly tx: WriteTx;
  private readonly kind: BatchKind;
  private readonly started = performance.now();

  constructor(tx: WriteTx, kind: BatchKind, limit: number) {
    this.tx = tx;
    this.kind = kind;
    this.limit = limit;
  }

  /** The first step of a PM batch: it runs alone, uncapped. */
  private lone(): boolean {
    return this.kind.lone && this.progress === 0;
  }

  left(): number {
    return this.lone() ? Number.POSITIVE_INFINITY : this.limit - this.spent;
  }

  /**
   * The units a divisible step (a page of edges, a chunk of inputs) may take:
   * the room left. Such a step is never larger than the target, even as a PM
   * batch's first one (which always gets room for a few entries).
   */
  pageRoom(): number {
    const left = this.limit - this.spent;
    return this.lone() ? Math.max(left, 8) : left;
  }

  private elapsed(): number {
    return performance.now() - this.started;
  }

  timeOk(): boolean {
    if (this.lone()) return true;
    return this.tx.budgetLeft() > this.kind.reserveMs && this.elapsed() < this.kind.targetMs - this.kind.reserveMs;
  }

  /** Room for a step that costs at most `cost` units, in units and in time. */
  room(cost: number): boolean {
    return cost <= this.left() && this.timeOk();
  }

  spend(units: number): void {
    this.spent += units;
  }

  /** One step is done (its results stored): from now on the batch's targets apply. */
  step(): void {
    if (this.lone() && (this.spent > this.limit || this.elapsed() > this.kind.targetMs - this.kind.reserveMs || this.tx.budgetLeft() < this.kind.reserveMs)) this.oversized = true;
    this.progress++;
  }

  /**
   * Run `read` (stored reads only, nothing changed) with at most `cap` of them
   * (each one unit, counted on the meter). METER_FULL when it needs more: the
   * step stops before it changes anything, and the batch ends (a PM batch does
   * it as its lone first step; nothing is ever refused for its size).
   */
  metered<T>(cap: number, read: () => T): T | typeof METER_FULL {
    const before = this.meter.n;
    this.meter.cap = before + Math.max(0, cap);
    try {
      return read();
    } catch (e) {
      if (e !== METER_FULL) throw e;
      return METER_FULL;
    } finally {
      this.spend(Math.min(this.meter.n - before, Math.max(0, cap)));
      this.meter.cap = Number.POSITIVE_INFINITY;
    }
  }
}

/** Time a batch keeps free of the write's work budget, for the rest of the write and its commit. */
function reserveOf(memory: Memory): number {
  return Math.min(250, memory.workBudgetMs * 0.2);
}

/** A batch riding on another write (its end, its `beforeWrite`, the gate): it stops before any step that does not fit. */
function seatBatch(memory: Memory, notices: boolean): BatchKind {
  return { limit: batchLimit, reserveMs: reserveOf(memory), targetMs: Number.POSITIVE_INFINITY, lone: false, notices };
}

/** A batch of the PM (`mp pm next`, `mp pm drain`): its first step runs alone, whatever its size; later ones stop before the targets. */
function pmBatch(memory: Memory): BatchKind {
  return { limit: batchLimit, reserveMs: reserveOf(memory), targetMs: memory.workBudgetMs, lone: true, notices: true };
}

/** Every label from scratch (maintenance: no work budget). */
const FULL: BatchKind = { limit: Number.POSITIVE_INFINITY, reserveMs: 0, targetMs: Number.POSITIVE_INFINITY, lone: false, notices: false };

/** Units each write already used for its labels (one write never does more than one batch's worth). */
const usedBy = new WeakMap<WriteTx, number>();

// ---------------------------------------------------------------- the stamp and the frontier

function stampOf(db: Db): number {
  return Number(metaGet(db, 'rev') ?? '0');
}

function headOf(db: Db): number {
  return Number((db.stmt('SELECT COALESCE(MAX(rev), 0) AS r FROM log').get() as { r: number }).r);
}

/** Writes whose own records joined the frontier (their propagation runs at their end). */
const seededWrites = new WeakSet<WriteTx>();
/** Writes that already know the frontier's start time is recorded. */
const sinceKnown = new WeakSet<WriteTx>();

/** A node touched by a new record: into the frontier (again), its expansion from the start. */
function seed(tx: WriteTx, node: string, own: boolean): void {
  if (!sinceKnown.has(tx)) {
    // The frontier's start (WI-32): when work appears in an empty table.
    if (metaGet(tx, 'since') === null && !anyWork(tx)) metaSet(tx, 'since', String(tx.at));
    sinceKnown.add(tx);
  }
  tx.stmt('INSERT INTO lbl_work (node, queued, dirty, phase, cursor) VALUES (?, 1, 0, ?, NULL) ON CONFLICT(node) DO UPDATE SET queued = 1, cursor = NULL').run(node, phaseOf(node));
  if (own) seededWrites.add(tx);
}

/** A half-evaluated node starts again: its count and position go, and it waits on nothing. */
function restart(db: Db, node: string): void {
  db.stmt('UPDATE lbl_work SET step = 0, wait = 0, pos = 0, acc = 1 WHERE node = ?').run(node);
  db.stmt('DELETE FROM lbl_wait WHERE parent = ?').run(node);
}

/**
 * A node that reads a visited one: into the frontier, unless it is queued
 * already; one that is marked and half evaluated starts its evaluation again
 * (an input it read as final changes); a decided fact still releasing its
 * waiters is visited again.
 */
function push(db: Db, node: string): void {
  const row = db.stmt('SELECT queued, dirty, step, pos FROM lbl_work WHERE node = ?').get(node) as { queued: number; dirty: number; step: number; pos: number } | undefined;
  if (row === undefined) db.stmt('INSERT INTO lbl_work (node, queued, dirty, phase, cursor) VALUES (?, 1, 0, ?, NULL)').run(node, phaseOf(node));
  else if (row.queued === 1) return;
  else if (row.dirty === 1) {
    if (row.step !== 0 || row.pos !== 0) restart(db, node);
    if (TARGET_FACTS.has(nodeKind(node))) dropScan(db, nodeId(node));
  } else db.stmt('UPDATE lbl_work SET queued = 1, cursor = NULL WHERE node = ?').run(node);
}

/** A target's facts: marking one makes the target's scan out of date. */
const TARGET_FACTS: ReadonlySet<string> = new Set(['e', 'f', 'p']);

/** The affected-set mark: to evaluate again. A fact's stored value goes, and so do the cycles through it (found again). */
function mark(db: Db, node: string, phase: number, cycles: boolean): void {
  db.stmt('UPDATE lbl_work SET dirty = 1, phase = ?, step = 0, wait = 0, pos = 0, acc = 1 WHERE node = ?').run(phase, node);
  if (phase !== 0) return;
  db.stmt('DELETE FROM lbl_wait WHERE parent = ?').run(node);
  db.stmt('DELETE FROM lbl_facts WHERE node = ?').run(node);
  if (TARGET_FACTS.has(nodeKind(node))) dropScan(db, nodeId(node));
  if (!cycles) return;
  for (const r of db.stmt('SELECT cycle FROM lbl_cycle_members WHERE node = ?').all(node) as Array<{ cycle: string }>) {
    db.stmt('DELETE FROM lbl_cycles WHERE cycle = ?').run(r.cycle);
    db.stmt('DELETE FROM lbl_cycle_members WHERE cycle = ?').run(r.cycle);
  }
}

function anyWork(db: Db): boolean {
  return Boolean(db.stmt('SELECT 1 FROM lbl_work LIMIT 1').get());
}

function anyQueued(db: Db): boolean {
  return Boolean(db.stmt('SELECT 1 FROM lbl_work WHERE queued = 1 LIMIT 1').get());
}

/** Labels reflect every event and no work is left. */
function isCurrent(db: Db): boolean {
  return stampOf(db) >= headOf(db) && !anyWork(db);
}

const CYCLE_META = ['scc_phase', 'scc_from', 'scc_cursor', 'cycle_hash', 'cycle_judgment'];

/** A cycle search in progress is dropped (the marks changed under it). */
function dropWalk(db: Db): void {
  db.stmt('DELETE FROM lbl_walk').run();
  db.stmt('DELETE FROM lbl_scc').run();
  db.stmt("DELETE FROM lbl_cycle_members WHERE cycle = ''").run();
  for (const k of CYCLE_META) metaSet(db, k, null);
}

// ---------------------------------------------------------------- admission (4.1 §4.1, §6.5)

function refuse(code: 'RECORD_INVALID' | 'RENEWAL_REFUSED', message: string): never {
  throw new LedgerError(code, message);
}

/**
 * Checks on a record appended by this write, made from base facts, never from
 * the label index (whose progress they must not depend on):
 * - a judgment that uses a timing, statistical or external field cites only
 *   sampling runs; a run of another class cited by such a judgment is refused
 *   too, whichever arrives first (`lbl_cites` keeps those judgments' runs from
 *   their admission on);
 * - a renewal names a rerun of the same candidate and command (when the
 *   original records them);
 * - a scope path has at most PATH_DEPTH_MAX segments (malformed input).
 * Nothing is refused for the size of the work it makes (v06 Appendix E).
 */
function admit(tx: WriteTx, rec: BaseRecord): void {
  switch (rec.kind) {
    case 'judgment': {
      const why = usesSampledFields(rec.evidenceUse);
      if (why === null) return;
      for (const e of readList(tx, rec.evidence)) {
        const run = factRecord<EvidenceRecord>(tx, 'evidence', e);
        if (run !== null && run.rec.runClass !== 'sampling') sampledRefusal(rec.judgment, e, run.rec.runClass, why.field);
        tx.stmt('INSERT OR IGNORE INTO lbl_cites (evidence, judgment) VALUES (?, ?)').run(e, rec.judgment);
      }
      return;
    }
    case 'evidence': {
      if (rec.runClass === 'sampling') return;
      const cited = tx.stmt('SELECT judgment FROM lbl_cites WHERE evidence = ? ORDER BY judgment LIMIT 1').get(rec.evidence) as { judgment: string } | undefined;
      if (cited !== undefined) {
        const j = factRecord<JudgmentRecord>(tx, 'judgment', cited.judgment);
        sampledRefusal(cited.judgment, rec.evidence, rec.runClass, j === null ? undefined : (usesSampledFields(j.rec.evidenceUse)?.field ?? undefined));
      }
      return;
    }
    case 'evidence.renewal': {
      const a = factRecord<EvidenceRecord>(tx, 'evidence', rec.original);
      const b = factRecord<EvidenceRecord>(tx, 'evidence', rec.replacement);
      if (a === null || b === null) return;
      const why = rerunMismatch(a.rec.fields, b.rec.fields, false);
      if (why !== null) refuse('RENEWAL_REFUSED', `renewal of ${rec.judgment} (${rec.original} → ${rec.replacement}): ${why}; the judgment needs a new review (4.1 §6.5)`);
      return;
    }
    case 'object.version': {
      const deep = rec.scope.paths.find((p) => p.split('/').length > PATH_DEPTH_MAX);
      if (deep !== undefined) refuse('RECORD_INVALID', `object ${rec.object} has a scope path of more than ${PATH_DEPTH_MAX} segments (${deep.slice(0, 80)}...) (4.1 §4.1)`);
      return;
    }
    default:
      return;
  }
}

function sampledRefusal(judgment: string, e: string, cls: string, field: string | undefined): never {
  refuse(
    'RECORD_INVALID',
    `judgment ${judgment} uses ${field !== undefined ? `the field ${field}` : 'statistical inference or external state'} of run ${e}, a ${cls} run: a judgment that uses a timing, statistical or external field rests only on sampling runs (4.1 §6.5)`,
  );
}

// ---------------------------------------------------------------- notices remembered through the log

/** The notices the labels raised, as the log has them (a rebuild keeps them noticed). */
function noteNotice(db: Db, rec: LogRecord): void {
  if (rec.kind === 'alert') {
    const alert = rec.alert as string;
    if (alert.startsWith(CYCLE_ALERT_PREFIX) || alert.startsWith(FRONTIER_ALERT_PREFIX)) db.stmt('INSERT OR IGNORE INTO lbl_alerts (alert) VALUES (?)').run(alert);
  } else if (rec.kind === 'notice') {
    const e = episodeOf(rec.notice);
    if (e !== null) db.stmt('INSERT INTO lbl_episodes (op, open, count) VALUES (?, ?, ?) ON CONFLICT(op) DO UPDATE SET open = excluded.open, count = MAX(lbl_episodes.count, excluded.count)').run(e.op, e.change === 'start' ? 1 : 0, e.n);
  }
}

/** An episode notice's identity (6.1): ["episode", operation, n, "start" | "end"]. */
function episodeIdentity(op: string, n: number, change: 'start' | 'end'): string {
  return JSON.stringify(['episode', op, n, change]);
}

function episodeOf(notice: string): { op: string; n: number; change: 'start' | 'end' } | null {
  if (!notice.startsWith('["episode",')) return null;
  try {
    const [, op, n, change] = JSON.parse(notice) as [string, string, number, 'start' | 'end'];
    return typeof op === 'string' && Number.isSafeInteger(n) && (change === 'start' || change === 'end') ? { op, n, change } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the projection hook

/** One event replayed into the index (catch-up, recompute): what it touches joins the frontier when `seeds`. */
function replay(tx: WriteTx, rec: LogRecord, rev: number, seeds: boolean): void {
  if (!INPUT_KINDS.has(rec.kind)) {
    noteNotice(tx, rec);
    return;
  }
  const base = rec as BaseRecord;
  if (base.kind === 'judgment' && usesSampledFields(base.evidenceUse) !== null) {
    for (const e of readList(tx, base.evidence)) tx.stmt('INSERT OR IGNORE INTO lbl_cites (evidence, judgment) VALUES (?, ?)').run(e, base.judgment);
  }
  const touched = projectRecord(tx, base, rev);
  if (seeds) for (const s of touched) seed(tx, s, false);
}

function countOf(ref: unknown): number {
  const n = (ref as { count?: unknown } | null)?.count;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * What replaying one event costs (known before it runs, from its lists'
 * counts): the event, the nodes it touches and the edges it adds. Never less
 * than `replay` does.
 */
function replayCost(rec: LogRecord): number {
  if (!INPUT_KINDS.has(rec.kind)) return 1;
  const r = rec as BaseRecord;
  switch (r.kind) {
    case 'proof.unit':
      return 5 + 4 * countOf(r.members);
    case 'judgment':
      return 5 + 2 * countOf(r.evidence) + countOf(r.bases) + countOf(r.reliesOn);
    case 'object.version':
      return 5 + countOf(r.prerequisites);
    case 'op.pending':
      return 2 + countOf(r.objects);
    default:
      return 5;
  }
}

function projectHook(tx: WriteTx, rec: LogRecord, ctx: { readonly rev: number }): void {
  // An event appended by this write (not replayed by a rebuild): admitted first, whatever the index's progress.
  const live = ctx.rev > Number(tx.startHead);
  if (live && INPUT_KINDS.has(rec.kind)) admit(tx, rec as BaseRecord);
  // Events committed without this extension leave a gap: they, and every event after them, are indexed by a catch-up batch.
  if (live && stampOf(tx) !== ctx.rev - 1) return;
  if (INPUT_KINDS.has(rec.kind)) {
    const base = rec as BaseRecord;
    if (base.kind === 'judgment' && usesSampledFields(base.evidenceUse) !== null) {
      for (const e of readList(tx, base.evidence)) tx.stmt('INSERT OR IGNORE INTO lbl_cites (evidence, judgment) VALUES (?, ?)').run(e, base.judgment);
    }
    const seeds = projectRecord(tx, base, ctx.rev);
    if (live) for (const s of seeds) seed(tx, s, true);
  } else noteNotice(tx, rec);
  metaSet(tx, 'rev', String(ctx.rev));
}

/**
 * Events committed without this extension (another mp, or before it was
 * installed): indexed now, in order, through the log's integrity check. Step:
 * one event (its cost known from its lists' counts before it runs).
 */
function catchUp(tx: WriteTx, w: Work): boolean {
  const from = stampOf(tx);
  let stamp = from;
  const head = headOf(tx);
  try {
    while (stamp < head) {
      const rows = tx.stmt(`SELECT ${LOG_COLUMNS} FROM log WHERE rev > ? ORDER BY rev LIMIT 64`).all(stamp) as unknown as LogRow[];
      if (rows.length === 0) break;
      for (const r of rows) {
        const rec = intactRecord<LogRecord>(tx, r);
        const cost = replayCost(rec);
        if (!w.room(cost)) return false;
        replay(tx, rec, Number(r.rev), true);
        w.spend(cost);
        stamp = Number(r.rev);
        w.step();
      }
    }
  } finally {
    if (stamp !== from) metaSet(tx, 'rev', String(stamp));
  }
  return stamp >= head;
}

// ---------------------------------------------------------------- discovery

/** A changed constraint scope (a cs: node), parsed once per batch: its patterns as a set. */
interface ScopeSet {
  readonly patterns: ReadonlySet<string>;
  readonly taskTypes: readonly string[];
}

/**
 * The constraint scope matches the object (semantics.ts `constraintApplies`):
 * one of its paths has a candidate pattern (itself, an ancestor's "dir/**",
 * "**") in the scope. The same answer for every valid object scope (concrete,
 * normalized paths), at a cost that does not depend on the number of patterns.
 */
function scopeMatches(s: ScopeSet, obj: ObjectScope): boolean {
  if (s.taskTypes.length > 0 && !s.taskTypes.includes(obj.taskType)) return false;
  for (const p of obj.paths) for (const pat of candidatePatterns(p)) if (s.patterns.has(pat)) return true;
  return false;
}

/** No room for the visit's next step: the batch ends here. */
const NO_ROOM: unique symbol = Symbol('no room');

/**
 * A changed constraint scope: every object it matches (before or after the
 * change) needs its coverage again. Step: one object (1 + its paths), from the
 * cursor (the last object's rowid).
 */
function visitScope(db: Db, w: Work, idPart: string, cursor: string | null, scopes: Map<string, ScopeSet>): string | null | typeof NO_ROOM {
  let s = scopes.get(idPart);
  if (s === undefined) {
    const parsed = JSON.parse(idPart) as ConstraintScope;
    if (!w.room(1 + parsed.paths.length)) return NO_ROOM;
    s = { patterns: new Set(parsed.paths), taskTypes: parsed.taskTypes };
    scopes.set(idPart, s);
    w.spend(1 + parsed.paths.length);
  }
  let after = Number(cursor ?? '0');
  let moved = false;
  for (;;) {
    const r = db.stmt("SELECT rowid AS rid, target, scope FROM lbl_targets WHERE kind = 'object' AND rowid > ? ORDER BY rowid LIMIT 1").get(after) as
      | { rid: number; target: string; scope: string }
      | undefined;
    if (r === undefined) {
      w.spend(1);
      w.step();
      return null;
    }
    const obj = JSON.parse(r.scope) as ObjectScope;
    const cost = 1 + obj.paths.length;
    if (!w.room(cost)) return moved ? String(after) : NO_ROOM;
    if (scopeMatches(s, obj)) push(db, `f:${r.target}`);
    w.spend(cost);
    after = Number(r.rid);
    moved = true;
    w.step();
  }
}

/**
 * Visit one frontier node; returns the cursor to resume from, null when its
 * expansion is complete, or NO_ROOM. Step: the node's mark and one page of
 * its reverse edges; a constraint scope's objects one at a time.
 */
function visit(db: Db, w: Work, node: string, cursor: string | null, cycles: boolean, scopes: Map<string, ScopeSet>): string | null | typeof NO_ROOM {
  const kind = nodeKind(node);
  const idPart = nodeId(node);
  if (kind === 'cs') return visitScope(db, w, idPart, cursor, scopes);
  const page = Math.min(PAGE, w.pageRoom() - 5);
  if (cursor === null) {
    if (FACT_KINDS.has(kind)) {
      mark(db, node, 0, cycles);
      // The implicit reverse edges: e:X is read by f:X, f:X by p:X, and all three by X's label and fixes.
      if (kind !== 'j') {
        if (kind === 'e') push(db, `f:${idPart}`);
        else if (kind === 'f') push(db, `p:${idPart}`);
        push(db, `t:${idPart}`);
        push(db, `x:${idPart}`);
      }
      w.spend(4);
    } else if (DISPLAY_KINDS.has(kind)) {
      mark(db, node, 1, false);
      w.spend(1);
      w.step();
      return null;
    }
  }
  const rows = db.stmt('SELECT dst FROM lbl_edges WHERE src = ? AND dst > ? ORDER BY dst LIMIT ?').all(node, cursor ?? '', page) as Array<{ dst: string }>;
  for (const r of rows) push(db, r.dst);
  w.spend(rows.length + 1);
  w.step();
  return rows.length === page ? rows[rows.length - 1]!.dst : null;
}

/** 5.4 step 1: the affected set, from the frontier. Returns whether it visited anything. */
function discover(db: Db, w: Work): boolean {
  const cycles = Boolean(db.stmt('SELECT 1 FROM lbl_cycles LIMIT 1').get());
  const scopes = new Map<string, ScopeSet>();
  let visited = false;
  while (w.room(VISIT_MIN)) {
    const rows = db.stmt('SELECT node, cursor FROM lbl_work WHERE queued = 1 ORDER BY rowid LIMIT 64').all() as Array<{ node: string; cursor: string | null }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      if (!w.room(VISIT_MIN)) break;
      const next = visit(db, w, r.node, r.cursor, cycles, scopes);
      if (next === NO_ROOM) return visited;
      if (next === null) {
        db.stmt('UPDATE lbl_work SET queued = 0, cursor = NULL WHERE node = ?').run(r.node);
        db.stmt('DELETE FROM lbl_work WHERE node = ? AND queued = 0 AND dirty = 0 AND step <> ?').run(r.node, RELEASING);
      } else db.stmt('UPDATE lbl_work SET cursor = ? WHERE node = ?').run(next, r.node);
      visited = true;
    }
  }
  return visited;
}

// ---------------------------------------------------------------- evaluation by readiness

/** One batch's evaluation context: the rules over the stored index, metered by the batch. */
interface Evaluation {
  readonly tx: WriteTx;
  readonly w: Work;
  readonly ix: StoredIndex;
  readonly d: Derivation;
  /** Each node's inputs, read once per batch. */
  readonly kids: Map<string, string[]>;
  /** Each operation's listed objects, read once per batch. */
  readonly objects: Map<string, string[]>;
  /** The reviewed paths of a scanned judgment, flattened, once per batch. */
  readonly reviewed: Map<string, Array<[string, string]>>;
  readonly stamp: number;
  /** Any active object constraint (read once per batch: the index does not change while it evaluates). */
  constrained(): boolean;
}

function evaluation(tx: WriteTx, w: Work): Evaluation {
  const ix = new StoredIndex(tx, w.meter);
  let any: boolean | undefined;
  const constrained = (): boolean => (any ??= Boolean(tx.stmt('SELECT 1 FROM lbl_patterns LIMIT 1').get()));
  return { tx, w, ix, d: new Derivation(ix, new StoredMemo(tx)), kids: new Map(), objects: new Map(), reviewed: new Map(), stamp: stampOf(tx), constrained };
}

/** The node's inputs (metered), or METER_FULL. */
function kidsOf(ev: Evaluation, node: string): string[] | typeof METER_FULL {
  const known = ev.kids.get(node);
  if (known !== undefined) return known;
  const k = ev.w.metered(ev.w.left() - 2, () => ev.d.kids(node));
  if (k !== METER_FULL) ev.kids.set(node, k);
  return k;
}

interface WorkRow {
  readonly dirty: number;
  readonly step: number;
  readonly wait: number;
  readonly pos: number;
  readonly acc: number;
}

function rowOf(db: Db, node: string): WorkRow | undefined {
  return db.stmt('SELECT dirty, step, wait, pos, acc FROM lbl_work WHERE node = ?').get(node) as WorkRow | undefined;
}

/** A fact is decided: stored, and the facts waiting on it are released next (step RELEASING), or at once when none waits. */
function decide(ev: Evaluation, node: string, holds: boolean): void {
  const db = ev.tx;
  db.stmt('INSERT INTO lbl_facts (node, holds) VALUES (?, ?) ON CONFLICT(node) DO UPDATE SET holds = excluded.holds').run(node, holds ? 1 : 0);
  db.stmt('DELETE FROM lbl_wait WHERE parent = ?').run(node);
  if (db.stmt('SELECT 1 FROM lbl_wait WHERE child = ? LIMIT 1').get(node)) {
    db.stmt('UPDATE lbl_work SET dirty = 0, step = ?, wait = 0, pos = 0, acc = 1 WHERE node = ?').run(RELEASING, node);
  } else clearMark(db, node);
  ev.w.spend(1);
  ev.w.step();
}

/** Release the facts waiting on a decided one, a page at a time. False: no room. */
function release(ev: Evaluation, node: string): boolean {
  const db = ev.tx;
  const n = Math.min(PAGE, ev.w.pageRoom() - 1);
  if (n < 1 || !ev.w.timeOk()) return false;
  const parents = db.stmt('SELECT parent FROM lbl_wait WHERE child = ? ORDER BY parent LIMIT ?').all(node, n) as Array<{ parent: string }>;
  for (const p of parents) {
    db.stmt('UPDATE lbl_work SET wait = wait - 1 WHERE node = ? AND wait > 0').run(p.parent);
    db.stmt('DELETE FROM lbl_wait WHERE child = ? AND parent = ?').run(node, p.parent);
  }
  ev.w.spend(1 + parents.length);
  if (parents.length < n) clearMark(db, node);
  ev.w.step();
  return true;
}

/** Count the node's marked inputs, a chunk at a time (an input never evaluated is marked now). False: no room. */
function count(ev: Evaluation, node: string): boolean {
  const db = ev.tx;
  const row = rowOf(db, node);
  if (row === undefined || row.dirty !== 1 || row.step !== 0) return true;
  if (!ev.w.room(2)) return false;
  const evaluable = ev.w.metered(ev.w.left() - 2, () => ev.d.evaluable(node));
  if (evaluable === METER_FULL) return false;
  if (!evaluable) {
    // A judgment's fact without its record: never decided, read as not holding.
    clearMark(db, node);
    ev.w.spend(1);
    ev.w.step();
    return true;
  }
  const kids = kidsOf(ev, node);
  if (kids === METER_FULL) return false;
  const n = Math.min(CHUNK, kids.length - row.pos, ev.w.pageRoom() - 1);
  if (n < 0 || (n === 0 && row.pos < kids.length)) return false;
  let wait = row.wait;
  for (let i = row.pos; i < row.pos + n; i++) {
    const c = kids[i]!;
    const st = rowOf(db, c);
    if (st === undefined && factOf(db, c) === undefined) {
      // Never evaluated (an object or unit that is only named, say): evaluated now, before this one.
      db.stmt('INSERT INTO lbl_work (node, queued, dirty, phase, cursor) VALUES (?, 0, 1, 0, NULL)').run(c);
    } else if (st === undefined || st.dirty !== 1) continue;
    if (Number(db.stmt('INSERT OR IGNORE INTO lbl_wait (child, parent) VALUES (?, ?)').run(c, node).changes) > 0) wait++;
  }
  const pos = row.pos + n;
  if (pos >= kids.length) db.stmt('UPDATE lbl_work SET step = 1, wait = ?, pos = 0 WHERE node = ?').run(wait, node);
  else db.stmt('UPDATE lbl_work SET wait = ?, pos = ? WHERE node = ?').run(wait, pos, node);
  ev.w.spend(1 + n);
  ev.w.step();
  return true;
}

/** Evaluate a node whose inputs are all decided: its guard, then its inputs a chunk at a time. False: no room. */
function combine(ev: Evaluation, node: string): boolean {
  const db = ev.tx;
  const row = rowOf(db, node);
  if (row === undefined || row.dirty !== 1 || row.step < 1 || row.wait !== 0) return true;
  if (!ev.w.room(2)) return false;
  let pos = row.pos;
  if (row.step === 1) {
    // A unit's records and conclusion, an object's coverage: read in their own resumable steps first.
    const target = scanFor(ev, node);
    if (target === METER_FULL || (target !== null && !scan(ev, target))) return false;
    const g = ev.w.metered(ev.w.left() - 2, () => ev.d.guard(node));
    if (g === METER_FULL) return false;
    if (!g) {
      decide(ev, node, false);
      return true;
    }
    db.stmt('UPDATE lbl_work SET step = 2, pos = 0 WHERE node = ?').run(node);
    pos = 0;
    ev.w.step();
  }
  const kids = kidsOf(ev, node);
  if (kids === METER_FULL) return false;
  const n = Math.min(CHUNK, kids.length - pos, ev.w.pageRoom() - 1);
  if (n < 0 || (n === 0 && pos < kids.length)) return false;
  for (let i = pos; i < pos + n; i++) {
    if (factOf(db, kids[i]!) !== true) {
      ev.w.spend(i - pos + 1);
      decide(ev, node, false);
      return true;
    }
  }
  ev.w.spend(n);
  if (pos + n >= kids.length) decide(ev, node, true);
  else {
    db.stmt('UPDATE lbl_work SET pos = ? WHERE node = ?').run(pos + n, node);
    ev.w.step();
  }
  return true;
}

/**
 * Only facts that wait are left: they wait on each other. Walk along the waits
 * (the smallest input each time) until a fact comes back: those on the loop
 * form a dependency cycle. False: no room.
 */
function walk(ev: Evaluation): boolean {
  const db = ev.tx;
  let last = (db.stmt('SELECT node FROM lbl_walk ORDER BY seq DESC LIMIT 1').get() as { node: string } | undefined)?.node;
  if (last === undefined) {
    const start = db.stmt('SELECT node FROM lbl_work WHERE dirty = 1 AND phase = 0 AND step >= 1 AND wait > 0 ORDER BY node LIMIT 1').get() as { node: string } | undefined;
    if (start === undefined) return true;
    db.stmt('INSERT INTO lbl_walk (node) VALUES (?)').run(start.node);
    last = start.node;
    ev.w.spend(1);
  }
  while (ev.w.room(2)) {
    const next = db.stmt('SELECT child FROM lbl_wait WHERE parent = ? ORDER BY child LIMIT 1').get(last) as { child: string } | undefined;
    ev.w.spend(1);
    ev.w.step();
    if (next === undefined) {
      // A count that no longer matches its waits: count it again.
      restart(db, last);
      dropWalk(db);
      return true;
    }
    const seen = db.stmt('SELECT seq FROM lbl_walk WHERE node = ?').get(next.child) as { seq: number } | undefined;
    if (seen !== undefined) {
      // A cycle: the walk from `seen` on. Its whole strongly connected component is found next.
      metaSet(db, 'scc_phase', 'seed');
      metaSet(db, 'scc_cursor', String(Number(seen.seq) - 1));
      return true;
    }
    db.stmt('INSERT INTO lbl_walk (node) VALUES (?)').run(next.child);
    last = next.child;
  }
  return false;
}

function xorHex(a: string, b: string): string {
  let out = '';
  for (let i = 0; i < a.length; i += 8) out += ((parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0).toString(16).padStart(8, '0');
  return out;
}

/**
 * The whole strongly connected component of the cycle the walk found (5.2 part
 * 4, WI-16), in resumable steps: the facts the cycle reaches along the waits
 * (forward), then, among those, the ones that reach the cycle back (backward).
 * Each fact of the component does not hold (least fixed point); the component
 * is kept, its identity the combined hash of its members, in any order. False:
 * no room.
 */
function component(ev: Evaluation): boolean {
  const db = ev.tx;
  for (;;) {
    if (!ev.w.room(3)) return false;
    const n = Math.min(PAGE, ev.w.pageRoom() - 2);
    const phase = metaGet(db, 'scc_phase');
    if (phase === 'seed') {
      const rows = db.stmt('SELECT seq, node FROM lbl_walk WHERE seq > ? ORDER BY seq LIMIT ?').all(Number(metaGet(db, 'scc_cursor')), n) as Array<{ seq: number; node: string }>;
      for (const r of rows) db.stmt('INSERT OR REPLACE INTO lbl_scc (node, fwd, fq, fc, bwd, bq, bc) VALUES (?, 1, 1, NULL, 1, 1, NULL)').run(r.node);
      if (rows.length < n) metaSet(db, 'scc_phase', 'forward');
      else metaSet(db, 'scc_cursor', String(rows[rows.length - 1]!.seq));
      ev.w.spend(1 + rows.length);
    } else if (phase === 'forward') {
      const r = db.stmt('SELECT node, fc FROM lbl_scc WHERE fq = 1 LIMIT 1').get() as { node: string; fc: string | null } | undefined;
      if (r === undefined) {
        metaSet(db, 'scc_phase', 'backward');
        continue;
      }
      const kids = db.stmt('SELECT child FROM lbl_wait WHERE parent = ? AND child > ? ORDER BY child LIMIT ?').all(r.node, r.fc ?? '', n) as Array<{ child: string }>;
      for (const k of kids) {
        db.stmt('INSERT INTO lbl_scc (node, fwd, fq, fc, bwd, bq, bc) VALUES (?, 1, 1, NULL, 0, 0, NULL) ON CONFLICT(node) DO UPDATE SET fq = CASE WHEN lbl_scc.fwd = 0 THEN 1 ELSE lbl_scc.fq END, fwd = 1').run(k.child);
      }
      if (kids.length < n) db.stmt('UPDATE lbl_scc SET fq = 0, fc = NULL WHERE node = ?').run(r.node);
      else db.stmt('UPDATE lbl_scc SET fc = ? WHERE node = ?').run(kids[kids.length - 1]!.child, r.node);
      ev.w.spend(1 + kids.length);
    } else if (phase === 'backward') {
      const r = db.stmt('SELECT node, bc FROM lbl_scc WHERE bq = 1 LIMIT 1').get() as { node: string; bc: string | null } | undefined;
      if (r === undefined) {
        metaSet(db, 'scc_phase', 'close');
        metaSet(db, 'cycle_hash', '0'.repeat(64));
        metaSet(db, 'cycle_judgment', '0');
        continue;
      }
      const parents = db.stmt('SELECT parent FROM lbl_wait WHERE child = ? AND parent > ? ORDER BY parent LIMIT ?').all(r.node, r.bc ?? '', n) as Array<{ parent: string }>;
      for (const p of parents) db.stmt('UPDATE lbl_scc SET bwd = 1, bq = 1 WHERE node = ? AND fwd = 1 AND bwd = 0').run(p.parent);
      if (parents.length < n) db.stmt('UPDATE lbl_scc SET bq = 0, bc = NULL WHERE node = ?').run(r.node);
      else db.stmt('UPDATE lbl_scc SET bc = ? WHERE node = ?').run(parents[parents.length - 1]!.parent, r.node);
      ev.w.spend(1 + parents.length);
    } else {
      const top = db.stmt('SELECT node FROM lbl_scc WHERE fwd = 1 AND bwd = 1 LIMIT 1').get() as { node: string } | undefined;
      if (top === undefined) {
        const cid = (metaGet(db, 'cycle_hash') ?? '0'.repeat(64)).slice(0, 16);
        const sample = (db.stmt("SELECT node FROM lbl_cycle_members WHERE cycle = '' ORDER BY node LIMIT 200").all() as Array<{ node: string }>).map((x) => x.node);
        db.stmt('INSERT OR IGNORE INTO lbl_cycles (cycle, nodes, judgment, rev) VALUES (?, ?, ?, ?)').run(cid, JSON.stringify(sample), Number(metaGet(db, 'cycle_judgment') ?? '0'), ev.stamp);
        db.stmt("UPDATE OR IGNORE lbl_cycle_members SET cycle = ? WHERE cycle = ''").run(cid);
        dropWalk(db);
        ev.w.spend(1);
        ev.w.step();
        return true;
      }
      const r = rowOf(db, top.node);
      if (r !== undefined && r.dirty === 1) decide(ev, top.node, false);
      else ev.w.spend(1);
      metaSet(db, 'cycle_hash', xorHex(metaGet(db, 'cycle_hash') ?? '0'.repeat(64), sha256(top.node)));
      if (top.node.startsWith('j:')) metaSet(db, 'cycle_judgment', '1');
      db.stmt("INSERT OR IGNORE INTO lbl_cycle_members (node, cycle) VALUES (?, '')").run(top.node);
      db.stmt('DELETE FROM lbl_scc WHERE node = ?').run(top.node);
    }
    ev.w.step();
  }
}

// ---------------------------------------------------------------- scans: a unit's members, an object's coverage

interface ScanRow {
  readonly phase: number;
  readonly pos: number;
  readonly sub: number;
  readonly conclusion: Conclusion;
  readonly bw: number;
  readonly ok: number;
  readonly done: number;
}

const SCAN_MEMBERS = 1;
const SCAN_CHECKS = 2;
const SCAN_PATHS = 3;

function saveScan(db: Db, target: string, r: ScanRow): void {
  db.stmt('UPDATE lbl_scan SET phase = ?, pos = ?, sub = ?, conclusion = ?, bw = ?, ok = ?, done = ? WHERE target = ?').run(r.phase, r.pos, r.sub, r.conclusion, r.bw, r.ok, r.done, target);
}

/**
 * A unit's combination over its members (semantics.ts `unitAggregate`) or an
 * object's coverage (`ownStructure` coverageOk), computed the same way in
 * resumable steps and kept until the target's facts are marked again: the
 * structure of each member (conclusion, withdrawn bases, deciding judgments),
 * the paths each deciding judgment reviewed against each constraint version,
 * then every scope path against the constraints whose current scope matches
 * it. The rules read the finished scan through the index (`scanned`). True:
 * finished. False: no room.
 */
function scan(ev: Evaluation, target: string): boolean {
  const db = ev.tx;
  for (;;) {
    const row = db.stmt('SELECT phase, pos, sub, conclusion, bw, ok, done FROM lbl_scan WHERE target = ?').get(target) as ScanRow | undefined;
    if (row !== undefined && row.done === 1) return true;
    if (!ev.w.room(3)) return false;
    // Each part does one or more steps (one target, member, judgment's chunk or path each), or none when it has no room.
    const progressed =
      row === undefined ? scanStart(ev, target) : row.phase === SCAN_MEMBERS ? scanMembers(ev, target, row) : row.phase === SCAN_CHECKS ? scanChecks(ev, target, row) : scanPaths(ev, target, row);
    if (!progressed) return false;
  }
}

/** The target's own part: a unit's positions, or an object's structure; the deciding judgments to read. */
function scanStart(ev: Evaluation, target: string): boolean {
  const db = ev.tx;
  const st = ev.w.metered(ev.w.left() - 2, () => {
    const unit = ev.ix.units.get(target as ProofUnitId);
    if (unit) {
      const comp = composite(ev.ix, target, unit.reviews);
      return { unit: true, conclusion: comp.conclusion, bw: basisWithdrawnIn(ev.ix, comp.all), ok: unit.members.length > 0, deciding: comp.deciding.map((d) => d.rec.judgment) };
    }
    const own = ownStructure(ev.ix, target);
    if (own === null) return null;
    return { unit: false, conclusion: own.conclusion, bw: false, ok: concreteScope(ev.ix.objects.get(target as ObjectVersionId)!.scope), deciding: own.deciding.map((d) => d.rec.judgment) };
  });
  if (st === METER_FULL) return false;
  if (st === null) {
    db.stmt("INSERT INTO lbl_scan (target, kind, phase, pos, sub, conclusion, bw, ok, done) VALUES (?, 'none', 0, 0, 0, 'unaccepted', 0, 0, 1)").run(target);
    ev.w.spend(1);
    ev.w.step();
    return true;
  }
  // Its whole cost before anything is written: the scan row and one row per deciding judgment.
  const cost = 1 + st.deciding.length;
  if (!ev.w.room(cost)) return false;
  st.deciding.forEach((j, i) => db.stmt('INSERT OR REPLACE INTO lbl_scan_judgments (target, seq, judgment) VALUES (?, ?, ?)').run(target, i, j));
  const phase = st.unit ? SCAN_MEMBERS : SCAN_CHECKS;
  db.stmt('INSERT INTO lbl_scan (target, kind, phase, pos, sub, conclusion, bw, ok, done) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)').run(
    target,
    st.unit ? 'unit' : 'object',
    phase,
    st.unit ? st.deciding.length : 0,
    st.conclusion,
    st.bw ? 1 : 0,
    st.ok ? 1 : 0,
    !st.unit && !st.ok ? 1 : 0,
  );
  ev.w.spend(cost);
  ev.w.step();
  return true;
}

/** A unit's members, one at a time: their conclusions, withdrawn bases and deciding judgments (`sub`: the next judgment's number). */
function scanMembers(ev: Evaluation, target: string, row: ScanRow): boolean {
  const db = ev.tx;
  const members = ev.w.metered(ev.w.left() - 2, () => ev.ix.units.get(target as ProofUnitId)?.members ?? []);
  if (members === METER_FULL) return false;
  let { pos, sub, conclusion, bw, ok } = row;
  let moved = false;
  while (pos < members.length && ev.w.room(3)) {
    const m = members[pos]!;
    const own = ev.w.metered(ev.w.left() - 2, () => {
      const o = ownStructure(ev.ix, m);
      return o === null ? null : { conclusion: o.conclusion, bw: o.basisWithdrawn, deciding: o.deciding.map((d) => d.rec.judgment) };
    });
    if (own === METER_FULL) break;
    // Its whole cost before anything is written: one row per deciding judgment.
    const cost = 1 + (own?.deciding.length ?? 0);
    if (!ev.w.room(cost)) break;
    if (own === null) {
      ok = 0;
      conclusion = worseConclusion(conclusion, 'unaccepted');
    } else {
      conclusion = worseConclusion(conclusion, own.conclusion);
      if (own.bw) bw = 1;
      for (const j of own.deciding) db.stmt('INSERT OR REPLACE INTO lbl_scan_judgments (target, seq, judgment) VALUES (?, ?, ?)').run(target, sub++, j);
    }
    ev.w.spend(cost);
    pos++;
    moved = true;
    ev.w.step();
  }
  // Coverage matters only while the records hold: a member missing already decides them.
  if (pos >= members.length) saveScan(db, target, { phase: SCAN_CHECKS, pos: 0, sub: 0, conclusion, bw, ok, done: ok === 1 ? 0 : 1 });
  else saveScan(db, target, { phase: SCAN_MEMBERS, pos, sub, conclusion, bw, ok, done: 0 });
  return moved;
}

/** The paths each deciding judgment reviewed, per constraint version, a chunk at a time (`pos`: the judgment, `sub`: the path). */
function scanChecks(ev: Evaluation, target: string, row: ScanRow): boolean {
  const db = ev.tx;
  const j = db.stmt('SELECT judgment FROM lbl_scan_judgments WHERE target = ? AND seq = ?').get(target, row.pos) as { judgment: string } | undefined;
  if (j === undefined) {
    saveScan(db, target, { ...row, phase: SCAN_PATHS, pos: 0, sub: 0 });
    ev.w.spend(1);
    ev.w.step();
    return true;
  }
  const key = `${target}\u0000${row.pos}`;
  let flat = ev.reviewed.get(key);
  if (flat === undefined) {
    const read = ev.w.metered(ev.w.left() - 2, () => {
      const out: Array<[string, string]> = [];
      for (const enc of ev.ix.judgments.get(j.judgment as JudgmentId)?.rec.constraints ?? []) {
        const c = ev.ix.check(enc);
        if (c) for (const p of c.paths) out.push([c.version, p]);
      }
      return out;
    });
    if (read === METER_FULL) return false;
    flat = read;
    ev.reviewed.set(key, flat);
  }
  const n = Math.min(CHUNK, flat.length - row.sub, ev.w.pageRoom() - 1);
  if (n <= 0 && row.sub < flat.length) return false;
  for (let i = row.sub; i < row.sub + n; i++) db.stmt('INSERT OR IGNORE INTO lbl_scan_reviewed (target, version, path) VALUES (?, ?, ?)').run(target, flat[i]![0], flat[i]![1]);
  const sub = row.sub + Math.max(0, n);
  saveScan(db, target, sub >= flat.length ? { ...row, pos: row.pos + 1, sub: 0 } : { ...row, sub });
  ev.w.spend(1 + Math.max(0, n));
  ev.w.step();
  return true;
}

/** Every scope path (a unit: every member's, `pos` the member, `sub` the path) against the constraints that apply to it. */
function scanPaths(ev: Evaluation, target: string, row: ScanRow): boolean {
  const db = ev.tx;
  if (!ev.constrained()) {
    // No active object constraint at all: every path is covered (a new one marks the objects it matches).
    saveScan(db, target, { ...row, done: 1 });
    ev.w.spend(1);
    ev.w.step();
    return true;
  }
  const list = ev.w.metered(ev.w.left() - 2, () => (ev.ix.units.get(target as ProofUnitId)?.members ?? [target]) as readonly string[]);
  if (list === METER_FULL) return false;
  let { pos, sub } = row;
  let moved = false;
  while (ev.w.room(3)) {
    if (pos >= list.length) {
      saveScan(db, target, { ...row, pos, sub, done: 1 });
      ev.w.spend(1);
      ev.w.step();
      return true;
    }
    const scope = ev.w.metered(ev.w.left() - 2, () => ev.ix.objects.get(list[pos]! as ObjectVersionId)?.scope ?? null);
    if (scope === METER_FULL) break;
    if (scope === null || sub >= scope.paths.length) {
      pos++;
      sub = 0;
      ev.w.spend(1);
      moved = true;
      ev.w.step();
      continue;
    }
    const path = scope.paths[sub]!;
    const covered = ev.w.metered(ev.w.left() - 2, () => pathCovered(ev, target, path, scope.taskType));
    if (covered === METER_FULL) break;
    ev.w.spend(1);
    moved = true;
    ev.w.step();
    if (!covered) {
      saveScan(db, target, { ...row, pos, sub, ok: 0, done: 1 });
      return true;
    }
    sub++;
  }
  saveScan(db, target, { ...row, pos, sub });
  return moved;
}

/**
 * One path's coverage (5.2, v33): for every object constraint whose current
 * scope matches the path (and the task type), not withdrawn, the path was
 * reviewed against its current content version by a deciding judgment. The
 * same as `covered` in semantics.ts, path by path. The index lists only the
 * active constraints under each pattern of their current scope
 * (`lbl_patterns`), and a line found under one of the path's candidate
 * patterns matches the path: its cost does not grow with withdrawn
 * constraints or with the size of a scope.
 */
function pathCovered(ev: Evaluation, target: string, path: string, taskType: string): boolean {
  for (const line of ev.ix.constraintsFor({ paths: [path], taskType })) {
    const c = ev.ix.constraints.get(line);
    if (c === undefined || ev.ix.withdrawn.has(line) || c.scope === null) continue;
    if (c.scope.taskTypes.length > 0 && !c.scope.taskTypes.includes(taskType)) continue;
    ev.w.meter.tick();
    if (!ev.tx.stmt('SELECT 1 FROM lbl_scan_reviewed WHERE target = ? AND version = ? AND path = ?').get(target, c.latest, path)) return false;
  }
  return true;
}

/** The target whose scan a node's rule or display reads: a unit's own (its records, conclusion), an object's coverage, a member's unit. */
function scanFor(ev: Evaluation, node: string): string | null | typeof METER_FULL {
  const kind = nodeKind(node);
  const t = nodeId(node);
  return ev.w.metered(ev.w.left() - 2, () => {
    if (ev.ix.units.has(t as ProofUnitId)) return kind === 'e' ? null : t;
    if (kind === 'f') return t;
    if (kind === 't' || kind === 'x') return ev.ix.unitOf.get(t as ObjectVersionId) ?? null;
    return null;
  });
}

/** One display value of a marked target or operation, from decided facts. False: no room. */
function display(ev: Evaluation, node: string): boolean {
  const db = ev.tx;
  const row = rowOf(db, node);
  if (row === undefined || row.dirty !== 1) return true;
  if (!ev.w.room(2)) return false;
  const t = nodeId(node);
  if (nodeKind(node) !== 'o') {
    const target = scanFor(ev, node);
    if (target === METER_FULL || (target !== null && !scan(ev, target))) return false;
  }
  switch (nodeKind(node)) {
    case 't': {
      const s = ev.w.metered(ev.w.left() - 2, () => (ev.ix.isTarget(t) ? ev.d.targetState(t) : null));
      if (s === METER_FULL) return false;
      if (s === null) db.stmt('DELETE FROM lbl_labels WHERE target = ?').run(t);
      else {
        db.stmt(
          `INSERT INTO lbl_labels (target, conclusion, in_effect, fresh, label, rev) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(target) DO UPDATE SET rev = CASE WHEN lbl_labels.label = excluded.label AND lbl_labels.conclusion = excluded.conclusion
             AND lbl_labels.in_effect = excluded.in_effect AND lbl_labels.fresh = excluded.fresh THEN lbl_labels.rev ELSE excluded.rev END,
             conclusion = excluded.conclusion, in_effect = excluded.in_effect, fresh = excluded.fresh, label = excluded.label`,
        ).run(t, s.conclusion, s.inEffect ? 1 : 0, s.fresh ? 1 : 0, s.label, ev.stamp);
      }
      ev.w.spend(1);
      break;
    }
    case 'x': {
      const now = ev.w.metered(ev.w.left() - 2, () => ev.d.fixesOf(t));
      if (now === METER_FULL) return false;
      if (now.size + 1 > ev.w.left()) return false;
      db.stmt('DELETE FROM lbl_fixes WHERE target = ?').run(t);
      for (const [key, state] of now) db.stmt('INSERT OR REPLACE INTO lbl_fixes (key, target, issue, state) VALUES (?, ?, ?, ?)').run(key, t, (JSON.parse(key) as [string, string])[0], state);
      ev.w.spend(1 + now.size);
      break;
    }
    case 'o': {
      // All proven: every listed object's fact, a chunk at a time (the list through the data store's checks).
      let objects = ev.objects.get(t);
      if (objects === undefined) {
        const read = ev.w.metered(ev.w.left() - 2, () => {
          ev.w.meter.tick();
          const f = factRecord<Extract<BaseRecord, { kind: 'op.pending' }>>(db, 'op.pending', t);
          if (f === null) return null;
          ev.w.meter.tick();
          return readList(db, f.rec.objects);
        });
        if (read === METER_FULL) return false;
        objects = read ?? [];
        ev.objects.set(t, objects);
        if (read === null) {
          clearMark(db, node);
          ev.w.step();
          return true;
        }
      }
      const n = Math.min(CHUNK, objects.length - row.pos, ev.w.pageRoom() - 1);
      if (n < 0 || (n === 0 && row.pos < objects.length)) return false;
      let acc = row.acc === 1 && objects.length > 0;
      for (let i = row.pos; i < row.pos + n && acc; i++) acc = factOf(db, `p:${objects[i]}`) === true;
      ev.w.spend(1 + n);
      if (acc && row.pos + n < objects.length) {
        db.stmt('UPDATE lbl_work SET step = 2, pos = ? WHERE node = ?').run(row.pos + n, node);
        ev.w.step();
        return true;
      }
      db.stmt('UPDATE lbl_ops SET all_proven = ? WHERE op = ?').run(acc ? 1 : 0, t);
      break;
    }
  }
  clearMark(db, node);
  ev.w.step();
  return true;
}

const RELEASING_PAGE = `SELECT node FROM lbl_work WHERE step = ${RELEASING} AND dirty = 0 LIMIT 64`;
// Pages of work in index order (the order does not matter; a sort would cost the whole set each time).
const READY_PAGE = 'SELECT node FROM lbl_work INDEXED BY lbl_work_ready WHERE dirty = 1 AND step >= 1 AND wait = 0 AND phase = 0 LIMIT 64';
const UNCOUNTED_PAGE = 'SELECT node FROM lbl_work WHERE dirty = 1 AND phase = 0 AND step = 0 LIMIT 64';
const WAITING = 'SELECT 1 FROM lbl_work WHERE dirty = 1 AND phase = 0 AND step >= 1 AND wait > 0 LIMIT 1';
const DISPLAY_PAGE = 'SELECT node FROM lbl_work WHERE dirty = 1 AND phase = 1 LIMIT 64';

/** 5.4 step 2, once the frontier is empty: evaluate, by readiness, until nothing is left or the batch is full. */
function evaluate(ev: Evaluation): void {
  const db = ev.tx;
  const each = (sql: string, step: (node: string) => boolean): boolean | null => {
    const rows = db.stmt(sql).all() as Array<{ node: string }>;
    if (rows.length === 0) return null;
    for (const r of rows) if (!step(r.node)) return false;
    return true;
  };
  for (;;) {
    if (!ev.w.room(2)) return;
    let r = each(RELEASING_PAGE, (n) => release(ev, n));
    if (r === null) r = each(READY_PAGE, (n) => combine(ev, n));
    if (r === null) r = each(UNCOUNTED_PAGE, (n) => count(ev, n));
    if (r === null && metaGet(db, 'scc_phase') !== null) r = component(ev);
    if (r === null && db.stmt(WAITING).get()) r = walk(ev);
    if (r === null) r = each(DISPLAY_PAGE, (n) => display(ev, n));
    if (r !== true) return;
  }
}

// ---------------------------------------------------------------- notices

/** WI-32 for a frontier left non-empty for 10 minutes; WI-16 for each new cycle through a judgment, once the labels are current. */
function raiseNotices(tx: WriteTx, current: boolean): void {
  if (!current) {
    const since = metaGet(tx, 'since');
    if (since === null || tx.at - Number(since) < FRONTIER_NOTICE_MS) return;
    const alert = `${FRONTIER_ALERT_PREFIX}${since}`;
    if (tx.stmt('SELECT 1 FROM lbl_alerts WHERE alert = ?').get(alert)) return;
    const st = labelStatus(tx);
    const left = { toVisit: st.toVisit, toRecompute: st.toRecompute };
    const body = canonicalJson({
      category: 'labels-recomputing',
      wi: 'WI-32',
      key: alert,
      source: 'labels',
      trigger: `the labels have been recomputing for ${Math.round((tx.at - Number(since)) / 60_000)} minutes (${left.toVisit} nodes to visit, ${left.toRecompute} to recompute): large changes keep arriving faster than the batches`,
      defaultAction: 'every decision that needs "proven" waits for the whole project; reads show the last labels marked recomputing; stops are never held back; every mp call still does one batch',
      detail: { since: Number(since), ...left },
    });
    raiseAlert(tx, { alert: id<AlertId>(alert), category: 'labels-recomputing', wi: 'WI-32', body: tx.data.put(body) });
    return;
  }
  // 6.1 "降级告知按失效轮次生成": an executed operation that lost "all proven" starts an episode, one that regained it ends it; one notice each.
  for (const r of tx.stmt(EPISODES_DUE).all() as Array<{ op: string; all_proven: number; as_of: number; count: number | null }>) {
    const change = r.all_proven === 1 ? 'end' : 'start';
    const n = (r.count ?? 0) + (change === 'start' ? 1 : 0);
    const text =
      change === 'start'
        ? {
            trigger: `executed operation ${r.op} is no longer all proven as of revision ${stampOf(tx)}: an object or proof unit it lists lost its proof (6.1)`,
            defaultAction: 'nothing is undone: the operation stays executed, its objects show their current labels, and it counts as proof debt on layer 0 (and in a closing risk list) until they are proven again',
          }
        : { trigger: `executed operation ${r.op} is all proven again as of revision ${stampOf(tx)} (6.1)`, defaultAction: 'none needed: the operation leaves the proof debt' };
    const notice: BaseRecord = {
      kind: 'notice',
      notice: episodeIdentity(r.op, n, change),
      audience: 'pm',
      body: tx.data.put(canonicalJson({ op: r.op, change, episode: n, executedAsOf: Number(r.as_of), revision: stampOf(tx) })),
      ...text,
    };
    checkShape(notice, NOTICE_ONLY, 'labels');
    appendFact(tx, notice);
  }
  const rows = tx
    .stmt(`SELECT cycle, nodes FROM lbl_cycles c WHERE judgment = 1 AND NOT EXISTS (SELECT 1 FROM lbl_alerts a WHERE a.alert = '${CYCLE_ALERT_PREFIX}' || c.cycle) ORDER BY cycle LIMIT 32`)
    .all() as Array<{ cycle: string; nodes: string }>;
  for (const r of rows) {
    const nodes = JSON.parse(r.nodes) as string[];
    const judgments = [...new Set(nodes.filter((n) => n.startsWith('j:')).map((n) => n.slice(2)))].sort();
    const targets = [...new Set(nodes.filter((n) => !n.startsWith('j:')).map((n) => n.slice(2)))].sort();
    const body = canonicalJson({
      category: 'dependency-cycle',
      wi: 'WI-16',
      key: `cycle:${r.cycle}`,
      source: 'labels',
      trigger: `a dependency cycle (5.2 part 4): judgments ${judgments.length > 0 ? judgments.join(', ') : '(none)'} and targets ${targets.join(', ')} depend on each other, so none of them can be proven`,
      defaultAction: 'the cycle and everything relying on it stay not proven (least fixed point); every other piece of work continues',
      detail: { cycle: r.cycle, judgments, targets, nodes },
    });
    raiseAlert(tx, { alert: id<AlertId>(`${CYCLE_ALERT_PREFIX}${r.cycle}`), category: 'dependency-cycle', wi: 'WI-16', body: tx.data.put(body) });
  }
}

const NOTICE_ONLY: ReadonlySet<string> = new Set(['notice']);

/** Executed operations whose "all proven" differs from their last episode notice. */
const EPISODES_DUE = `SELECT o.op AS op, o.all_proven AS all_proven, e.as_of AS as_of, ep.count AS count
  FROM lbl_ops o JOIN lbl_executed e ON e.op = o.op LEFT JOIN lbl_episodes ep ON ep.op = o.op
  WHERE (o.all_proven = 0 AND COALESCE(ep.open, 0) = 0) OR (o.all_proven = 1 AND ep.open = 1) ORDER BY o.op LIMIT 64`;


// ---------------------------------------------------------------- one batch

export interface BatchReport {
  /** Units of work this batch did (at most its target, unless `oversized`). */
  readonly units: number;
  /** Steps this batch committed (a PM batch with work left always commits one). */
  readonly progress: number;
  /** No work is left (the labels are current). */
  readonly done: boolean;
  /** Its first step was larger than a batch's target and ran alone (a PM batch only, v06 Appendix E). */
  readonly oversized: boolean;
}

/**
 * One batch inside `tx` (§4.1, v06): catch up with unindexed events, then
 * discovery from the frontier, then (frontier empty) evaluation of the marked
 * facts and display values, step by step, until the next step would go past
 * the batch's targets. A batch on another write never takes one write past
 * one batch's units, however many batches it runs; a PM batch's first step
 * runs whatever its size.
 */
function runBatch(tx: WriteTx, o: BatchKind): BatchReport {
  const used = o.lone ? 0 : (usedBy.get(tx) ?? 0);
  const w = new Work(tx, o, Number.isFinite(o.limit) ? Math.max(0, o.limit - used) : o.limit);
  if (catchUp(tx, w)) {
    if (discover(tx, w)) dropWalk(tx);
    if (!anyQueued(tx)) evaluate(evaluation(tx, w));
  }
  const current = isCurrent(tx);
  if (current) {
    metaSet(tx, 'since', null);
    sinceKnown.delete(tx);
  }
  if (o.notices) raiseNotices(tx, current);
  if (Number.isFinite(o.limit)) usedBy.set(tx, used + w.spent);
  return { units: w.spent, progress: w.progress, done: current, oversized: w.oversized };
}

/**
 * A batch inside a write that is not the labels' own (the write's end, the
 * gate): it stops before any step that does not fit (the PM's batch does
 * that one). Under a savepoint, so a batch that fails leaves the labels as
 * they were (still recomputing). A broken chain fails the write; anything else
 * is rethrown when `rethrow`, else left for `mp pm drain` to report.
 */
function batchIn(tx: WriteTx, rethrow: boolean): void {
  tx.stmt('SAVEPOINT labels_batch').run();
  try {
    runBatch(tx, seatBatch(tx.memory, false));
    tx.stmt('RELEASE labels_batch').run();
  } catch (e) {
    tx.stmt('ROLLBACK TO labels_batch').run();
    tx.stmt('RELEASE labels_batch').run();
    if (rethrow || (e instanceof LedgerError && e.code === 'CHAIN_BROKEN')) throw e;
  }
}

/** The end of every write: the propagation of what it appended, one batch (§4.1: a small change is finished in its own write). */
function beforeCommit(tx: WriteTx): undefined {
  if (!seededWrites.has(tx)) return undefined;
  seededWrites.delete(tx);
  batchIn(tx, false);
  return undefined;
}

// ---------------------------------------------------------------- full computation (rebuild, recompute)

/** Every label from scratch, inside a maintenance transaction (no work budget): after the index was replayed. */
function computeAll(tx: WriteTx): void {
  for (const t of DERIVED_TABLES) tx.stmt(`DELETE FROM ${t}`).run();
  tx.stmt('UPDATE lbl_ops SET all_proven = NULL').run();
  for (const k of ['since', ...CYCLE_META]) metaSet(tx, k, null);
  const add = (sql: string): void => {
    tx.stmt(`INSERT OR IGNORE INTO lbl_work (node, queued, dirty, phase, cursor) ${sql}`).run();
  };
  add("SELECT 'p:' || target, 0, 1, 0, NULL FROM lbl_targets");
  add("SELECT 'f:' || target, 0, 1, 0, NULL FROM lbl_targets");
  add("SELECT 'e:' || target, 0, 1, 0, NULL FROM lbl_targets");
  add("SELECT 'j:' || judgment, 0, 1, 0, NULL FROM lbl_judgments");
  add("SELECT 't:' || target, 0, 1, 1, NULL FROM lbl_targets");
  add("SELECT 'x:' || target, 0, 1, 1, NULL FROM lbl_targets");
  add("SELECT DISTINCT 'x:' || version, 0, 1, 1, NULL FROM lbl_regression");
  add("SELECT 'o:' || op, 0, 1, 1, NULL FROM lbl_ops");
  runBatch(tx, FULL);
}

/**
 * `mp recompute` (§4.1, WI-20): every label table rebuilt from the base
 * records. In one maintenance transaction: the log is verified as it is
 * replayed (a damaged log is refused, CHAIN_BROKEN, and nothing changes), the
 * index replayed, then every label computed from scratch.
 */
export function recompute(memory: Memory): { readonly events: number; readonly revision: number } {
  return memory.maintenance((tx) => {
    for (const t of LABEL_TABLES) tx.stmt(`DELETE FROM ${t}`).run();
    let events = 0;
    const report = walkChain(tx, (r) => {
      replay(tx, JSON.parse(r.record) as LogRecord, Number(r.rev), false);
      events++;
    });
    if (!report.ok) throw new LedgerError('CHAIN_BROKEN', `the event log's hash chain is broken at event ${report.brokenAt} (${report.reason}); the last valid event is ${report.lastValid}: the labels are not recomputed from a damaged log`);
    metaSet(tx, 'rev', String(report.lastValid));
    computeAll(tx);
    return { events, revision: report.lastValid };
  });
}

// ---------------------------------------------------------------- batches as their own writes

/** Memories draining now (their writes skip the extra batch of `beforeWrite`). */
const draining = new WeakSet<Memory>();

/** Work to do: events not indexed, frontier or marks left, a cycle or an episode not noticed yet. */
function batchNeeded(db: Db): boolean {
  if (!isCurrent(db)) return true;
  return Boolean(
    db.stmt(`SELECT 1 FROM lbl_cycles c WHERE judgment = 1 AND NOT EXISTS (SELECT 1 FROM lbl_alerts a WHERE a.alert = '${CYCLE_ALERT_PREFIX}' || c.cycle) LIMIT 1`).get() ||
      db.stmt(EPISODES_DUE).get(),
  );
}

/**
 * The write of a PM batch asks the memory for no work budget of its own
 * (`workBudgetMs`, memory.ts WriteRequest): its lone first step is the one
 * exception to the 2 s rollback (§4.1 "Busy and time limits", v06); every
 * later step stops before the batch's own time target (`Work`), so only that
 * step can take it past the budget. It appends no base record.
 */
const PM_WRITE: WriteRequest & { readonly workBudgetMs: number } = { workBudgetMs: Number.POSITIVE_INFINITY };

/** One batch as its own write: a PM batch (`mp pm next`, `mp pm drain`), or one before another write. */
function batchWrite(memory: Memory, pm: boolean): BatchReport {
  return pm ? memory.write(PM_WRITE, (tx) => runBatch(tx, pmBatch(memory))) : memory.write({}, (tx) => runBatch(tx, seatBatch(memory, true)));
}

/**
 * One batch of the PM as its own write, when there is work (§4.1: `mp pm next`
 * does one first): it commits at least one step, whatever its size. Returns
 * null when there was nothing to do.
 */
export function labelBatch(memory: Memory): BatchReport | null {
  if (!memory.read((db) => batchNeeded(db))) return null;
  draining.add(memory);
  try {
    return batchWrite(memory, true);
  } finally {
    draining.delete(memory);
  }
}

export interface DrainReport {
  readonly batches: number;
  readonly units: number;
  readonly ms: number;
  readonly status: LabelStatus;
}

/**
 * `mp pm drain` (§4.1, WI-32): PM batches until the frontier is empty (each
 * its own write, so other `mp` calls interleave). Every batch commits at
 * least one step, or the drain stops with an error. It ends while large
 * changes keep arriving only if `maxBatches` is set.
 */
export function drain(memory: Memory, o: { readonly maxBatches?: number } = {}): DrainReport {
  const t0 = performance.now();
  let batches = 0;
  let units = 0;
  draining.add(memory);
  try {
    while (memory.read((db) => batchNeeded(db))) {
      if (o.maxBatches !== undefined && batches >= o.maxBatches) break;
      const r = batchWrite(memory, true);
      batches++;
      units += r.units;
      if (r.progress === 0 && !r.done) throw new LedgerError('INTERNAL_ERROR', 'a label batch made no progress while work is left: mp recompute rebuilds the labels (WI-20)');
    }
  } finally {
    draining.delete(memory);
  }
  return { batches, units, ms: performance.now() - t0, status: memory.read((db) => labelStatus(db)) };
}

function beforeWrite(memory: Memory): void {
  if (draining.has(memory)) return;
  try {
    if (!memory.read((db) => batchNeeded(db))) return;
    draining.add(memory);
    try {
      batchWrite(memory, false);
    } finally {
      draining.delete(memory);
    }
  } catch {
    // The work stays stored: the next write, `mp pm next` or `mp pm drain` does it (drain reports the error).
  }
}

// ---------------------------------------------------------------- the gate of decisions that need "proven"

/** Up to `limit` of `objects` whose proven fact does not hold now. */
function unprovenIn(db: Db, objects: readonly string[], limit: number): string[] {
  return (
    db.stmt(`SELECT j.value AS t FROM json_each(?) j LEFT JOIN lbl_facts f ON f.node = 'p:' || j.value WHERE COALESCE(f.holds, 0) = 0 LIMIT ?`).all(JSON.stringify(objects), limit) as Array<{
      t: string;
    }>
  ).map((r) => r.t);
}

function gateProof(tx: WriteTx, what: { readonly opId: string }): void {
  // 4.1 §6.5: the decision reads labels, so this process must have observed the current environment identity.
  const mine = observedEnvironment(tx.memory.projectDir);
  if (mine === null) {
    throw new LedgerError('BAD_REQUEST', 'this mp process has not observed the environment identity (4.1 §6.5): call currentEnvironment(memory) before a decision that reads labels');
  }
  // Read through the log's integrity check (a damaged environment event refuses the decision: CHAIN_BROKEN).
  const recorded = recordedEnvironment(tx);
  if (recorded === null || recorded.identity !== mine.identity) {
    throw new LedgerError('STALE_REQUEST', `the recorded environment identity (${recorded?.identity ?? 'none'}) is not the one this process observed (${mine.identity}): call currentEnvironment(memory) again; it records the change`);
  }
  // §4.1: while any work is left the whole project is recomputing. This write first does one batch itself.
  if (!isCurrent(tx)) batchIn(tx, true);
  if (!isCurrent(tx)) {
    const st = labelStatus(tx);
    throw new LedgerError(
      'RECOMPUTING',
      `the labels are recomputing (${st.toVisit} nodes to visit, ${st.toRecompute} to evaluate${st.head > st.revision ? `, ${st.head - st.revision} events to index` : ''}): every decision that needs "proven" waits; every mp call does one batch, mp pm drain finishes them (WI-32)`,
    );
  }
  // The labels were computed under the identity the log records (the index took it from the same event when it was written).
  const indexed = (tx.stmt('SELECT snapshot FROM lbl_env WHERE line = ? ORDER BY rev DESC LIMIT 1').get(ENV_LINE) as { snapshot: string } | undefined)?.snapshot;
  if (indexed !== recorded.identity) throw new LedgerError('CHAIN_BROKEN', `the labels were computed under environment identity ${indexed ?? 'none'}, but the log records ${recorded.identity} as the current one: the log or the labels were changed; the decision is refused`);
  const f = factRecord<Extract<BaseRecord, { kind: 'op.pending' }>>(tx, 'op.pending', what.opId);
  if (f === null) return;
  // The listed objects through the data store's checks: a missing or damaged list refuses the decision.
  const objects = readList(tx, f.rec.objects);
  if (objects.length === 0) throw new LedgerError('STALE_REQUEST', `operation ${what.opId} lists no object: nothing can be proven for it`);
  const unproven = unprovenIn(tx, objects, 21);
  if (unproven.length > 0) {
    throw new LedgerError(
      'STALE_REQUEST',
      `operation ${what.opId} needs every object it lists proven; not proven now: ${unproven.slice(0, 20).join(', ')}${unproven.length > 20 ? ', ...' : ''}. Read the labels again`,
    );
  }
}

// ---------------------------------------------------------------- reads

/** How current the stored labels are (layer 0; every read carries it). */
export interface LabelStatus {
  /** The log revision the stored labels reflect. */
  readonly revision: number;
  readonly head: number;
  /** Work is left (or events are not indexed): decisions that need "proven" wait; displayed labels are the last ones. */
  readonly recomputing: boolean;
  /** Frontier nodes still to visit. */
  readonly toVisit: number;
  /** Marked variables and display values still to evaluate (and decided facts still releasing their waiters). */
  readonly toRecompute: number;
  /** When the frontier became non-empty (ms), or null. */
  readonly since: number | null;
}

export function labelStatus(db: Db): LabelStatus {
  const revision = stampOf(db);
  const head = headOf(db);
  const toVisit = Number((db.stmt('SELECT COUNT(*) AS n FROM lbl_work WHERE queued = 1').get() as { n: number }).n);
  const toRecompute = Number((db.stmt('SELECT COUNT(*) AS n FROM lbl_work WHERE queued = 0').get() as { n: number }).n);
  const since = metaGet(db, 'since');
  return { revision, head, recomputing: revision < head || toVisit + toRecompute > 0, toVisit, toRecompute, since: since === null ? null : Number(since) };
}

/** The stored states of objects and proof units (display: the last labels, marked recomputing by `status`). Null: unknown target. */
export function readLabels(db: Db, ids: readonly string[]): { readonly status: LabelStatus; readonly states: Readonly<Record<string, (TargetState & { readonly revision: number }) | null>> } {
  const states: Record<string, (TargetState & { revision: number }) | null> = {};
  for (const t of ids) {
    const r = db.stmt('SELECT conclusion, in_effect, fresh, label, rev FROM lbl_labels WHERE target = ?').get(t) as
      | { conclusion: TargetState['conclusion']; in_effect: number; fresh: number; label: Label; rev: number }
      | undefined;
    states[t] = r === undefined ? null : Object.freeze({ conclusion: r.conclusion, inEffect: r.in_effect === 1, fresh: r.fresh === 1, label: r.label, revision: Number(r.rev) });
  }
  return { status: labelStatus(db), states };
}

/**
 * Labels for a decision (§4.1): "recomputing" for every id while any work is
 * left, else the label (null: unknown target). Only "proven" lets a decision
 * that needs it go on.
 */
export function decisionLabels(db: Db, ids: readonly string[]): Readonly<Record<string, Label | 'recomputing' | null>> {
  const current = isCurrent(db);
  const { states } = readLabels(db, ids);
  return Object.fromEntries(ids.map((t) => [t, current ? (states[t]?.label ?? null) : 'recomputing']));
}

/** Whether each judgment is current (null: unknown judgment). */
export function judgmentStates(db: Db, ids: readonly string[]): { readonly status: LabelStatus; readonly current: Readonly<Record<string, boolean | null>> } {
  const current: Record<string, boolean | null> = {};
  for (const j of ids) {
    if (!db.stmt('SELECT 1 FROM lbl_judgments WHERE judgment = ?').get(j)) current[j] = null;
    else current[j] = (db.stmt('SELECT holds FROM lbl_facts WHERE node = ?').get(`j:${j}`) as { holds: number } | undefined)?.holds === 1;
  }
  return { status: labelStatus(db), current };
}

/** Operations that need "proven" (6.1): all proven, executed as of (null: unknown operation). */
export function opStates(db: Db, ids: readonly string[]): { readonly status: LabelStatus; readonly states: Readonly<Record<string, OpState | null>> } {
  const states: Record<string, OpState | null> = {};
  for (const op of ids) {
    const r = db.stmt('SELECT o.kind AS kind, o.all_proven AS all_proven, e.as_of AS as_of FROM lbl_ops o LEFT JOIN lbl_executed e ON e.op = o.op WHERE o.op = ?').get(op) as
      | { kind: ProofOpKind; all_proven: number | null; as_of: number | null }
      | undefined;
    states[op] = r === undefined ? null : { kind: r.kind, allProven: r.all_proven === 1, executedAsOf: (r.as_of === null ? null : Number(r.as_of)) as OpState['executedAsOf'] };
  }
  return { status: labelStatus(db), states };
}

/** Issue states on versions (5.6), by fixKey(issue, version) (null: no state recorded). */
export function fixStates(db: Db, keys: readonly string[]): { readonly status: LabelStatus; readonly states: Readonly<Record<string, FixState | null>> } {
  const states: Record<string, FixState | null> = {};
  for (const k of keys) states[k] = (db.stmt('SELECT state FROM lbl_fixes WHERE key = ?').get(k) as { state: FixState } | undefined)?.state ?? null;
  return { status: labelStatus(db), states };
}

/**
 * What decides each target's proof (5.2, 5.3; the delivery's view), computed
 * by the rules from the stored facts in this read. Meaningful as "proven" only
 * when `status.recomputing` is false.
 */
export function decidingViews(db: Db, targets: readonly string[]): { readonly status: LabelStatus; readonly views: ReadonlyMap<string, DecidingView | null> } {
  const d = new Derivation(new StoredIndex(db), new StoredMemo(db));
  const views = new Map<string, DecidingView | null>();
  for (const t of targets) views.set(t, d.deciding(t));
  return { status: labelStatus(db), views };
}

/**
 * The continuation check of v32 5.2 part 5, with the revision of the labels it
 * answered at, for `recordContinuationCheck` (`revision`, `result`): refused as
 * "recomputing" while work is left.
 */
export function continuationCheck(
  db: Db,
  req: ContinuationRequest,
): { readonly revision: number; readonly result: ContinuationResult | { readonly ok: false; readonly reason: 'recomputing' } } {
  const revision = stampOf(db);
  if (!isCurrent(db)) return { revision, result: { ok: false, reason: 'recomputing' } };
  return { revision, result: new Derivation(new StoredIndex(db), new StoredMemo(db)).continuation(req) };
}

/** The whole derived state as the reference semantics shapes it (fullCompute), from the stored tables: for checks and tests. */
export function derivedState(db: Db): DerivedState & { readonly status: LabelStatus } {
  const ix = new StoredIndex(db);
  const d = new Derivation(ix, new StoredMemo(db));
  const basis = new Map<never, BasisState>();
  for (const r of db.stmt('SELECT version FROM lbl_basis').all() as Array<{ version: never }>) basis.set(r.version, basisState(ix, r.version));
  const evidence = new Map<never, boolean>();
  for (const r of db.stmt('SELECT evidence FROM lbl_evidence').all() as Array<{ evidence: never }>) evidence.set(r.evidence, evidenceApplicable(ix, r.evidence));
  const judgmentCurrent = new Map<never, boolean>();
  const positionInEffect = new Map<string, boolean>();
  for (const r of db.stmt('SELECT judgment, target, review FROM lbl_judgments').all() as Array<{ judgment: JudgmentId; target: string; review: string }>) {
    judgmentCurrent.set(r.judgment as never, d.judgmentCurrent(r.judgment));
    positionInEffect.set(reviewPosition(r.target, r.review), d.positionInEffect(r.target, r.review));
  }
  const targets = new Map<string, TargetState>();
  for (const r of db.stmt('SELECT target, conclusion, in_effect, fresh, label FROM lbl_labels').all() as Array<{ target: string; conclusion: TargetState['conclusion']; in_effect: number; fresh: number; label: Label }>) {
    targets.set(r.target, Object.freeze({ conclusion: r.conclusion, inEffect: r.in_effect === 1, fresh: r.fresh === 1, label: r.label }));
  }
  const fixes = new Map<string, FixState>();
  for (const r of db.stmt('SELECT key, state FROM lbl_fixes').all() as Array<{ key: string; state: FixState }>) fixes.set(r.key, r.state);
  const ops = new Map<never, OpState>();
  for (const r of db.stmt('SELECT o.op AS op, o.kind AS kind, o.all_proven AS all_proven, e.as_of AS as_of FROM lbl_ops o LEFT JOIN lbl_executed e ON e.op = o.op').all() as Array<{
    op: never;
    kind: ProofOpKind;
    all_proven: number | null;
    as_of: number | null;
  }>) {
    ops.set(r.op, Object.freeze({ kind: r.kind, allProven: r.all_proven === 1, executedAsOf: (r.as_of === null ? null : Number(r.as_of)) as OpState['executedAsOf'] }));
  }
  const status = labelStatus(db);
  return { revision: status.revision as DerivedState['revision'], basis, evidenceApplicable: evidence, judgmentCurrent, positionInEffect, targets, fixes, ops, status };
}

/** The dependency cycles in the stored state (5.2 part 4, WI-16), each with all its nodes. */
export function dependencyCycles(db: Db): Array<{ readonly id: string; readonly nodes: readonly string[]; readonly throughJudgment: boolean }> {
  return (db.stmt('SELECT cycle, judgment FROM lbl_cycles ORDER BY cycle').all() as Array<{ cycle: string; judgment: number }>).map((r) => ({
    id: r.cycle,
    nodes: (db.stmt('SELECT node FROM lbl_cycle_members WHERE cycle = ? ORDER BY node').all(r.cycle) as Array<{ node: string }>).map((x) => x.node),
    throughJudgment: r.judgment === 1,
  }));
}

// ---------------------------------------------------------------- the extension

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const LABELS_EXTENSION: MemoryExtension = {
  name: 'labels',
  schema: LABEL_SCHEMA,
  tables: LABEL_TABLES,
  stateTables: LABEL_TABLES,
  project: projectHook,
  afterRebuild: computeAll,
  beforeWrite,
  beforeCommit,
  gateProof,
  // The candidates the runs were made on (§3.3 step 5): each must be reachable after a move.
  commits: (db) =>
    (db.stmt('SELECT DISTINCT candidate FROM lbl_evidence WHERE candidate IS NOT NULL').all() as Array<{ candidate: string }>).map((r) => r.candidate).filter((c) => COMMIT.test(c)),
};

// Every memory opened after this module is loaded keeps its labels (memory.ts registry).
registerMemoryExtension(LABELS_EXTENSION);
