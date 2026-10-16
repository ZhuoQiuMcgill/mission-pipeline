// The project memory (design 4.1 §3, §4.1): `<project>/.mission-pipeline/`,
// read and written by each `mp` process directly, in short SQLite
// transactions. It replaces the 4.0 ledger service: no service, no socket, no
// queue, no daemon. Concurrent `mp` processes (several seats in parallel)
// serialize on SQLite's own lock.
//
// The write path (§4.1):
// - one write is one `BEGIN IMMEDIATE` transaction; a caller that cannot get
//   the lock within the busy limit (30 s) gets BUSY ("busy, retry") with
//   nothing written;
// - a write runs synchronously: a callback that returns a promise is refused
//   and rolled back, and a transaction that has ended cannot be used again;
// - a write with an operation id is idempotent: the same id with the same
//   payload returns the recorded answer (the first caller gets the same
//   answer), another payload is refused (OP_CONFLICT); the receipt is a log
//   event, so a rebuild keeps it;
// - one write may do at most 2 s of work (the work budget, measured from the
//   lock to the commit, retries included). A write over it is rolled back with
//   nothing written (OVER_BUDGET): work that can grow (label propagation,
//   package A2) is cut into bounded batches by its caller, each its own write,
//   and checks `budgetLeft()` to stop in time. This module never splits a write
//   by itself;
// - stops are written before anything queued, across processes: a stop writer
//   holds `locks/stop` while it waits for SQLite's lock; every other writer
//   waits for that lock before it takes SQLite's, and gives SQLite's back at
//   once if a stop announced itself meanwhile. A stop also skips the work
//   extensions do before every other write (a propagation batch). So a stop
//   waits at most for the one write in progress;
// - every event is appended to the hash-chained log and projected into the
//   state tables in the same transaction, and the transaction's last event is
//   marked as its end; leaves are written inside it, before the commit
//   (leaves.ts); data values put outside a write are inserted by the next one
//   (data.ts);
// - a broken event chain stops every write (CHAIN_BROKEN, §3.3). Every open
//   checks the log's structure and its last event; every rebuild and recovery
//   verifies the whole chain, inside its transaction, before it trusts it.
//
// Opening checks the folder's recorded place first and, after a copy or a move,
// recovers it under the maintenance lock before anything else (move.ts).

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { StatementSync } from 'node:sqlite';
import { canonicalJson, hashJson } from '../common/hash.ts';
import { revision, type Revision } from '../common/ids.ts';
import { chainTail, eventHash, inspectChain, logCounter, structureProblem, type ChainReport } from './chain.ts';
import { DataStore } from './data.ts';
import { BUSY_TIMEOUT_MS, deleteKey, getKey, isBusyError, openDatabase, setBusyTimeout, setKey, Statements, type Db } from './db.ts';
import { LedgerError } from './errors.ts';
import { checkFiller, type Filler, type LogRecord, type MoveFindings, type Place } from './events.ts';
import { cleanPendingLeaves, hasPendingLeaves, LeafWriter, readLeaf, type LeafRead, type LeafRef } from './leaves.ts';
import { addGitExclude, plainGit, repositoryLayout, type GitRunner, type RepositoryLayout } from './git.ts';
import { lock, tryLock, type ProcessLock } from './locks.ts';
import { LAYOUT_DIRS, memoryPaths, type MemoryPaths } from './paths.ts';
import { project, type ProjectionContext } from './projection.ts';
import { rebuildState, type RebuildReport } from './rebuild.ts';
import { MEMORY_FORMAT, SCHEMA } from './schema.ts';
import { machineIdentity, recoverIfMoved, type MoveHooks } from './move.ts';
import { mkdirDurable, removeFile, writeAtomic } from './fsx.ts';

/** The work budget of one write (§4.1). */
export const WORK_BUDGET_MS = 2_000;
/** The schema version kept in `PRAGMA user_version`; the DDL runs only when it is behind. */
const SCHEMA_VERSION = 1;
/** The lock a stop writer holds while it waits for the write lock (§4.1: stops before anything queued). */
export const STOP_LOCK = 'stop';

/**
 * A part of the memory another package adds (labels and their frontier, the
 * environment identity: package A2): its own tables, maintained by the same
 * writes and rebuilt by the same rebuild.
 */
export interface MemoryExtension {
  readonly name: string;
  /** DDL (CREATE TABLE IF NOT EXISTS ...), run when one of `tables` is missing. */
  readonly schema?: string;
  readonly tables?: readonly string[];
  /** Tables a rebuild empties before it replays the log (derived tables included). */
  readonly stateTables?: readonly string[];
  /** Apply one appended event's effects to the extension's tables, inside the write (and during a rebuild's replay). */
  project?(tx: WriteTx, rec: LogRecord, ctx: ProjectionContext): void;
  /** After a rebuild replayed the log, inside its transaction (e.g. recompute the derived labels). */
  afterRebuild?(tx: WriteTx): void;
  /** Before every write except a stop, outside that write (e.g. one bounded propagation batch, as its own write). */
  beforeWrite?(memory: Memory): void;
  /**
   * At the end of every write (not a retry, not maintenance), inside it, after
   * its callback and before its receipt and commit (A2: the write's own label
   * propagation). Synchronous: a promise it returns rolls the write back.
   */
  beforeCommit?(tx: WriteTx): undefined;
  /** Inside the write of a decision that needs "proven" (commitProofOp): throw to refuse it (labels still recomputing: LedgerError RECOMPUTING). */
  gateProof?(tx: WriteTx, what: { readonly opId: string }): void;
  /** Commits the extension's records name (runs, candidates), for the checks after a move (§3.3 step 5). */
  commits?(db: Db): Iterable<string>;
}

const registry: MemoryExtension[] = [];

/** Register an extension for every memory opened afterwards (unless `extensions` is passed to open). */
export function registerMemoryExtension(ext: MemoryExtension): void {
  if (!registry.some((e) => e.name === ext.name)) registry.push(ext);
}

export interface OpenOptions {
  /** SQLite's busy timeout, and the wait for the maintenance and stop locks (§4.1: 30 s). */
  readonly busyTimeoutMs?: number;
  /** The work budget of one write (§4.1: 2 s). */
  readonly workBudgetMs?: number;
  readonly now?: () => number;
  readonly extensions?: readonly MemoryExtension[];
  /** This machine's identity (default: machineIdentity()). */
  readonly machine?: string;
  /** How git runs (default: plain `git` from PATH); null: no git (no repository steps). */
  readonly git?: GitRunner | null;
  /** Test hooks: crash after a step of the recovery after a move, before a commit, or once a write holds the lock. */
  readonly hooks?: MoveHooks & { readonly beforeCommit?: () => void; readonly afterBegin?: (stop: boolean) => void };
}

export interface WriteRequest {
  /** The operation id (§4.1): with the same payload a retry returns the recorded answer; with another, OP_CONFLICT. */
  readonly op?: string | null;
  /** What the operation id stands for; required with `op`. */
  readonly payload?: unknown;
  /** A stop (§4.1): written before anything queued, in every process. */
  readonly stop?: boolean;
  /** The `mp pm` command that issues the write, and the PM's filler (§3.2 item 13); needs `op`. */
  readonly command?: string;
  readonly filler?: Filler | null;
  /**
   * This write's own work budget in ms (default: the memory's, §4.1);
   * `Number.POSITIVE_INFINITY`: no OVER_BUDGET rollback for this write (design
   * v06 Appendix E: an oversized lone propagation step in the PM's batch
   * commits). Never for a stop. The busy limit is unchanged.
   */
  readonly workBudgetMs?: number;
}

const OP_ID = /^[^\u0000-\u001f\u007f]{1,400}$/;

function isThenable(x: unknown): x is PromiseLike<unknown> {
  return x !== null && (typeof x === 'object' || typeof x === 'function') && typeof (x as { then?: unknown }).then === 'function';
}

function busy(e: unknown, ms: number): unknown {
  return isBusyError(e) ? new LedgerError('BUSY', `the project memory is busy (another mp process held its lock for ${ms} ms); nothing was written: retry`) : e;
}

/** An iterator whose every step (next, return, throw) first checks its transaction is still live. */
function guardIterator<T extends object>(it: T, live: () => void): T {
  const guarded: T = new Proxy(it, {
    get(target, prop) {
      if (prop === Symbol.iterator) return () => guarded;
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        live();
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return guarded;
}

function ended(): LedgerError {
  return new LedgerError('BAD_REQUEST', 'this write transaction has ended: a write runs synchronously inside its callback');
}

/** One write transaction: the domain functions take it, append events and write leaves through it. Unusable once it ended. */
export class WriteTx implements Db {
  readonly memory: Memory;
  /** The commit time: every timestamp the write records takes it. */
  readonly at: number;
  readonly op: string | null;
  /** The head when the write began: what it appends comes after. */
  readonly startHead: number;
  private readonly writer: LeafWriter;
  private readonly started: number;
  private readonly budgetMs: number;
  private tail: string | null = null;
  private last: { rev: number; kind: string; op: string | null; record: string; prev: string } | null = null;
  private readonly checkChain: boolean;
  private done = false;
  private readonly guarded = new Map<string, StatementSync>();

  constructor(memory: Memory, op: string | null, at: number, budgetMs: number, checkChain: boolean) {
    this.memory = memory;
    this.op = op;
    this.at = at;
    this.budgetMs = budgetMs;
    this.checkChain = checkChain;
    this.startHead = memory.head();
    this.started = performance.now();
    this.writer = new LeafWriter({
      root: memory.paths.root,
      pendingDir: memory.paths.pendingLeaves,
      db: this,
      op,
      record: (ref: LeafRef) => {
        this.append({ kind: 'leaf.recorded', leaf: ref.leaf, leafKind: ref.kind, file: ref.file, anchor: ref.anchor, sha256: ref.sha256 });
      },
    });
  }

  /** The data values (§3.2 item 11), written in this transaction. */
  get data(): DataStore {
    if (this.done) throw ended();
    return this.memory.data;
  }

  /** The leaf writer of this transaction. */
  get leaves(): LeafWriter {
    if (this.done) throw ended();
    return this.writer;
  }

  /**
   * A prepared statement of this transaction. Every execution checks the
   * transaction is still live, so a statement kept past the write (after an
   * await, in a closure) can never write outside it.
   */
  stmt(sql: string): StatementSync {
    if (this.done) throw ended();
    let guarded = this.guarded.get(sql);
    if (guarded === undefined) {
      const raw = this.memory.stmt(sql);
      const live = (): void => {
        if (this.done) throw ended();
      };
      guarded = new Proxy(raw, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target) as unknown;
          if (typeof v !== 'function') return v;
          return (...args: unknown[]) => {
            live();
            const out = (v as (...a: unknown[]) => unknown).apply(target, args);
            // iterate() executes later, on every step: its iterator is guarded too.
            return prop === 'iterate' && out !== null && typeof out === 'object' ? guardIterator(out, live) : out;
          };
        },
      });
      this.guarded.set(sql, guarded);
    }
    return guarded;
  }

  /** Milliseconds of the work budget left (a batching caller stops before it reaches 0). */
  budgetLeft(): number {
    return this.budgetMs - (performance.now() - this.started);
  }

  head(): Revision {
    if (this.done) throw ended();
    return this.memory.head();
  }

  /**
   * Append an event to the hash-chained log and apply its projection (the
   * core's, then each extension's), in this transaction. Returns its revision.
   */
  append(rec: LogRecord, op: string | null = this.op): Revision {
    if (this.done) throw ended();
    if (this.tail === null) {
      const t = chainTail(this);
      if (!t.ok && this.checkChain) {
        this.chainBroken(t.reason, t.rev);
        throw new LedgerError('CHAIN_BROKEN', `the event log's hash chain is broken (${t.reason}); every write is refused until the PM follows the WI on copying and moving the folder`);
      }
      this.tail = t.ok ? t.hash : (this.stmt('SELECT hash FROM log ORDER BY rev DESC LIMIT 1').get() as { hash: string } | undefined)?.hash ?? '0'.repeat(64);
    }
    const rev = Math.max(logCounter(this), Number((this.stmt('SELECT COALESCE(MAX(rev), 0) AS r FROM log').get() as { r: number }).r)) + 1;
    const record = canonicalJson(rec);
    const prev = this.tail;
    const hash = eventHash({ rev, kind: rec.kind, op, record, committedAt: this.at, prev, end: false });
    this.stmt('INSERT INTO log (rev, kind, op, record, committed_at, prev, hash, txn_end) VALUES (?, ?, ?, ?, ?, ?, ?, 0)').run(rev, rec.kind, op, record, this.at, prev, hash);
    this.tail = hash;
    this.last = { rev, kind: rec.kind, op, record, prev };
    const ctx: ProjectionContext = { rev, at: this.at };
    project(this, rec, ctx);
    for (const ext of this.memory.extensions) ext.project?.(this, rec, ctx);
    return revision(rev);
  }

  /** A rebuilt state value (the `state` table). */
  getState(key: string): string | null {
    return getKey(this, 'state', key);
  }

  /** A damaged event seen during this transaction (by any read or check): it never commits, maintenance included. */
  damaged: string | null = null;

  /** @internal A read through this transaction found a damaged event: latched on the memory (this write cannot commit). */
  chainBroken(reason: string, rev?: number | null): void {
    this.memory.chainBroken(reason, rev);
  }

  /** @internal Mark the transaction's last event as its end (its hash covers the mark), just before the commit. */
  seal(): void {
    const l = this.last;
    if (l === null) return;
    const hash = eventHash({ rev: l.rev, kind: l.kind, op: l.op, record: l.record, committedAt: this.at, prev: l.prev, end: true });
    this.stmt('UPDATE log SET txn_end = 1, hash = ? WHERE rev = ?').run(hash, l.rev);
  }

  /** @internal The transaction committed or rolled back: nothing may use it any more. */
  finish(): void {
    this.done = true;
  }

  /** @internal The write rolled back: remove its leaves (before the lock is released). */
  undoLeaves(): void {
    this.writer.undo();
  }

  /** @internal The write committed: its leaves are referenced. */
  leavesCommitted(): void {
    this.writer.committed();
  }
}

export interface MemoryStatus {
  readonly head: Revision;
  readonly format: string;
  readonly place: Place;
  /** A move being recovered (another process is at it), or null. */
  readonly movePending: { readonly from: Place; readonly to: Place; readonly startedAt: number } | null;
  /** The last recovery after a move, with what its checks found. */
  readonly lastMove: { readonly from: Place; readonly to: Place; readonly at: number; readonly findings: MoveFindings } | null;
  /** A broken event chain (writes refused), with the last valid event. */
  readonly chainBroken: ChainReport | null;
  /** Git writes held until the PM confirms this copy is the one in use (§3.3 step 2). */
  readonly gitHold: { readonly reason: string; readonly since: number } | null;
  /** Leaves of a write that did not finish, removed by the next write. */
  readonly pendingLeaves: boolean;
}

export class Memory implements Db {
  readonly paths: MemoryPaths;
  readonly data: DataStore;
  readonly extensions: readonly MemoryExtension[];
  readonly busyTimeoutMs: number;
  readonly workBudgetMs: number;
  readonly git: GitRunner | null;
  readonly hooks: OpenOptions['hooks'];
  readonly machine: string;
  private readonly statements: Statements;
  private readonly now: () => number;
  private current: WriteTx | null = null;
  private inBeforeWrite = false;
  private closed = false;
  /**
   * A damaged event this process saw (a read, a write, the open's gate, a
   * verification): kept, whatever the caller did with the error and whether or
   * not the database could record it, until this process itself, holding the
   * write lock, finds no marker, no record in the database and the whole chain
   * verified clean (tryUnlatch). Every write entry and every commit check it;
   * marker files carry breaks to other processes and across a reopen.
   */
  private latched: string | null = null;
  private latchedAt: number | null = null;
  /** Why the marker of this process's latest report could not be written, or null. */
  private markerError: string | null = null;

  /** Use openMemory(). */
  constructor(paths: MemoryPaths, statements: Statements, opts: OpenOptions) {
    this.paths = paths;
    this.statements = statements;
    this.extensions = opts.extensions ?? [...registry];
    this.busyTimeoutMs = opts.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
    this.workBudgetMs = opts.workBudgetMs ?? WORK_BUDGET_MS;
    this.now = opts.now ?? Date.now;
    this.git = opts.git === undefined ? plainGit() : opts.git;
    this.hooks = opts.hooks;
    this.machine = opts.machine ?? machineIdentity();
    this.data = new DataStore({ db: this, inWrite: () => this.current !== null });
  }

  get projectDir(): string {
    return this.paths.project;
  }

  stmt(sql: string) {
    if (this.closed) throw new Error('the memory is closed');
    return this.statements.stmt(sql);
  }

  /** The raw connection (maintenance and tests). */
  get connection() {
    return this.statements.db;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.statements.inTransaction) this.statements.rollback();
    this.statements.db.close();
  }

  head(): Revision {
    return revision(Number((this.stmt('SELECT COALESCE(MAX(rev), 0) AS r FROM log').get() as { r: number }).r));
  }

  getState(key: string): string | null {
    return getKey(this, 'state', key);
  }

  getMeta(key: string): string | null {
    return getKey(this, 'meta', key);
  }

  /**
   * @internal The one notification of damage (chain.ts intactRecord, walkChain
   * and verifyChain, the tail check, Memory.verifyChain): the write in progress
   * is marked damaged and never commits (maintenance included); the break is
   * latched in this process and marked in a file at once (no database needed);
   * outside a transaction the full report is recorded in the database now,
   * inside one when it ends.
   */
  chainBroken(reason: string, rev?: number | null, report?: ChainReport): void {
    if (this.current !== null) this.current.damaged ??= reason;
    this.latch(reason, rev ?? null);
    if (!this.statements.inTransaction) this.persistLatch(report);
  }

  /**
   * The marker files: one per detection, `locks/chain-broken-<id>.json`. A
   * recovery removes only those it handled. Fail closed: a folder that cannot
   * be listed (anything but "does not exist") refuses the write that asked.
   */
  private markerFiles(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.paths.locks);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new LedgerError('CHAIN_BROKEN', `the markers of broken chains in ${this.paths.locks} cannot be listed (${(e as Error).message}): every write is refused until they can be checked`);
    }
    return names.filter((n) => /^chain-broken-[0-9a-f]+\.json$/.test(n)).sort();
  }

  /** The newest break any process marked, or null. A marker that cannot be read still marks a break (fail closed). */
  readMarker(): { id: string; reason: string; brokenAt: number | null; at: number } | null {
    let newest: { id: string; reason: string; brokenAt: number | null; at: number } | null = null;
    for (const name of this.markerFiles()) {
      let marker: { id: string; reason: string; brokenAt: number | null; at: number };
      try {
        marker = JSON.parse(readFileSync(join(this.paths.locks, name), 'utf8')) as typeof marker;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // removed by a recovery meanwhile
        marker = { id: name.slice('chain-broken-'.length, -'.json'.length), reason: `a broken chain was marked (its marker cannot be read: ${(e as Error).message})`, brokenAt: null, at: 0 };
      }
      if (newest === null || marker.at >= newest.at) newest = marker;
    }
    return newest;
  }

  /** Latch a break this process saw; every detection gets its own marker (revisions are reused after a recovery: no two reports are taken for one). */
  private latch(reason: string, rev: number | null): void {
    this.latched = reason;
    this.latchedAt = rev;
    const id = randomBytes(12).toString('hex');
    try {
      mkdirSync(this.paths.locks, { recursive: true });
      writeAtomic(join(this.paths.locks, `chain-broken-${id}.json`), canonicalJson({ id, reason, brokenAt: rev, at: Date.now() }));
      this.markerError = null;
    } catch (e) {
      this.markerError = (e as Error).message;
    }
  }

  /** Latch a break another process marked (its marker stands for it: no new one). */
  private adopt(marker: { reason: string; brokenAt: number | null }): void {
    if (this.latched !== null) return;
    this.latched = marker.reason;
    this.latchedAt = marker.brokenAt;
  }

  /**
   * Record the latched break in the database (the full report), best effort:
   * the latch and the marker stay either way. A break that is neither marked
   * nor recorded is reported: CHAIN_BROKEN, "could not be recorded". Every
   * notification writes its marker before this runs (chainBroken: latch first),
   * so an error here, about the latest detection's marker, never keeps a later
   * detection from being marked.
   */
  private persistLatch(report?: ChainReport): void {
    if (this.latched === null || this.getMeta('chain_broken') !== null || this.recordChainBroken(report)) return;
    if (this.markerError !== null) {
      throw new LedgerError('CHAIN_BROKEN', `the event log's hash chain is broken (${this.latched}), and the break could not be recorded (marker: ${this.markerError}; the database was busy or failing): this process refuses every write; follow the WI on copying and moving the folder`);
    }
  }

  /**
   * Unlatch only on this process's own evidence, holding the write lock: no
   * marker, no record in the database, and the whole chain verified clean. A
   * recovery elsewhere therefore never lets through damage it did not handle.
   */
  private tryUnlatch(): boolean {
    if (this.latched === null) return true;
    if (this.markerFiles().length > 0) return false;
    try {
      this.begin();
    } catch {
      return false;
    }
    let report: ChainReport | null = null;
    try {
      if (this.markerFiles().length === 0 && this.getMeta('chain_broken') === null) report = inspectChain(this);
    } finally {
      this.statements.rollback();
    }
    if (report === null) return false;
    if (report.ok) {
      this.latched = null;
      this.latchedAt = null;
      this.markerError = null;
      return true;
    }
    // Damage this verification found is a detection like any other: a new marker, then the database.
    this.chainBroken(report.reason ?? 'broken chain', report.brokenAt, report);
    return false;
  }

  /** Refuse a write while a break is known: latched here, marked by any process (or recorded in the database: checked in the transaction). */
  private refuseIfBroken(): void {
    const marker = this.readMarker();
    if (marker !== null) this.adopt(marker);
    if (this.latched === null || (marker === null && this.tryUnlatch())) return;
    this.persistLatch();
    throw this.brokenError();
  }

  /** CHAIN_BROKEN with the recorded report (the last valid event) when the database has it, else the latched reason. */
  private brokenError(): LedgerError {
    const recorded = this.getMeta('chain_broken');
    if (recorded !== null) {
      const r = JSON.parse(recorded) as ChainReport;
      return new LedgerError('CHAIN_BROKEN', `the event log's hash chain is broken at event ${r.brokenAt} (${r.reason}); the last valid event is ${r.lastValid}. Every write is refused until the PM follows the WI on copying and moving the folder`);
    }
    return new LedgerError('CHAIN_BROKEN', `the event log's hash chain is broken (${this.latched}); every write is refused until the PM follows the WI on copying and moving the folder`);
  }

  /** Run `fn` in one read transaction: every query sees the same committed state. */
  read<T>(fn: (db: Db) => T): T {
    if (this.current !== null) return fn(this.current);
    if (this.statements.inTransaction) return fn(this);
    try {
      this.statements.begin('DEFERRED');
    } catch (e) {
      throw this.mapError(e);
    }
    try {
      const out = fn(this);
      if (isThenable(out)) throw new LedgerError('BAD_REQUEST', 'a read runs synchronously: its callback returned a promise');
      this.statements.commit();
      return out;
    } catch (e) {
      this.statements.rollback();
      throw this.mapError(e);
    } finally {
      // A damaged event seen by this read is recorded, even when the callback caught the error.
      if (this.latched !== null) this.persistLatch();
    }
  }

  /**
   * One write (§4.1): see the header. `fn` runs synchronously inside the
   * transaction with a WriteTx; whatever it returns is the write's answer
   * (recorded with `op`, and then returned in its recorded form).
   */
  write<T>(req: WriteRequest, fn: (tx: WriteTx) => T): T {
    if (this.closed) throw new Error('the memory is closed');
    if (this.current !== null) throw new Error('a write cannot start inside another: compose the domain functions inside one write');
    const op = req.op ?? null;
    if (op !== null && (typeof op !== 'string' || !OP_ID.test(op))) throw new LedgerError('BAD_REQUEST', 'an operation id is 1 to 400 printable characters');
    if (op !== null && req.payload === undefined) throw new LedgerError('BAD_REQUEST', `operation ${op} names no payload (the business content its id stands for)`);
    if (req.command !== undefined && (op === null || typeof req.command !== 'string' || req.command === '' || req.command.length > 200)) {
      throw new LedgerError('BAD_REQUEST', 'a PM command is 1 to 200 characters and its write has an operation id');
    }
    const filler = checkFiller(req.filler);
    if (req.workBudgetMs !== undefined) {
      if (typeof req.workBudgetMs !== 'number' || !(req.workBudgetMs > 0)) throw new LedgerError('BAD_REQUEST', 'a work budget is a positive number of milliseconds (Infinity: none)');
      if (req.stop === true) throw new LedgerError('BAD_REQUEST', 'a stop gets no work budget of its own');
    }
    this.refuseIfBroken();
    if (req.stop !== true && !this.inBeforeWrite) {
      this.inBeforeWrite = true;
      try {
        for (const ext of this.extensions) ext.beforeWrite?.(this);
      } finally {
        this.inBeforeWrite = false;
      }
    }
    return this.transaction({ op, payload: req.payload, command: req.command, filler }, fn, { budgetMs: req.workBudgetMs ?? this.workBudgetMs, maintenance: false, stop: req.stop === true });
  }

  /** @internal A write for maintenance (init, the recovery after a move, a rebuild): no work budget; `chain: false` skips the chain checks. */
  maintenance<T>(fn: (tx: WriteTx) => T, opts: { readonly chain?: boolean } = {}): T {
    if (this.current !== null) throw new Error('a write cannot start inside another');
    return this.transaction({ op: null, payload: null, command: undefined, filler: null }, fn, { budgetMs: Number.POSITIVE_INFINITY, maintenance: true, chain: opts.chain ?? true, stop: false });
  }

  private begin(): void {
    try {
      this.statements.begin('IMMEDIATE');
    } catch (e) {
      throw this.mapError(e);
    }
  }

  private busyBy(deadline: number, what: string): LedgerError {
    return new LedgerError('BUSY', `the project memory stayed busy for ${this.busyTimeoutMs} ms (${what}); nothing was written: retry`);
  }

  /**
   * COMMIT within the write's one busy limit (§4.1): it may wait for readers to
   * finish, but only for what is left. Past the limit the write is rolled back
   * by the caller: nothing written, BUSY.
   */
  private commitBy(deadline: number): void {
    const left = deadline - Date.now();
    if (left <= 0) throw this.busyBy(deadline, 'waiting to commit');
    setBusyTimeout(this.statements.db, left);
    try {
      this.statements.commit();
    } catch (e) {
      if (isBusyError(e)) throw this.busyBy(deadline, 'waiting to commit');
      throw e;
    } finally {
      setBusyTimeout(this.statements.db, this.busyTimeoutMs);
    }
  }

  /** Take SQLite's write lock, waiting at most until `deadline` (the write's one busy limit, §4.1). */
  private beginBy(deadline: number): void {
    const left = deadline - Date.now();
    if (left <= 0) throw this.busyBy(deadline, 'waiting for the write lock');
    setBusyTimeout(this.statements.db, left);
    try {
      this.statements.begin('IMMEDIATE');
    } catch (e) {
      if (isBusyError(e)) throw this.busyBy(deadline, 'waiting for the write lock');
      throw e;
    } finally {
      setBusyTimeout(this.statements.db, this.busyTimeoutMs);
    }
  }

  private mapError(e: unknown): unknown {
    return busy(e, this.busyTimeoutMs);
  }

  private stopLockOrBusy(deadline: number): ProcessLock {
    const left = deadline - Date.now();
    try {
      if (left <= 0) throw new LedgerError('LOCKED', 'no time left');
      return lock(this.paths.locks, STOP_LOCK, { waitMs: left });
    } catch (e) {
      if (e instanceof LedgerError && e.code === 'LOCKED') throw this.busyBy(deadline, 'stops were being written');
      throw e;
    }
  }

  /**
   * Take the write lock (§4.1, stops first across processes). A stop writer
   * announces itself with the stop lock, then waits for SQLite's lock, and
   * returns the stop lock to release after its commit. Any other writer first
   * waits for the stop lock to be free, then takes SQLite's lock; if a stop
   * announced itself meanwhile, it gives SQLite's lock back at once (nothing is
   * written yet) and waits for the stop again.
   */
  private enter(stop: boolean): ProcessLock | null {
    // One busy limit for the whole write: every wait (the stop lock, SQLite's lock) uses only what is left of it.
    const deadline = Date.now() + this.busyTimeoutMs;
    if (stop) {
      const held = this.stopLockOrBusy(deadline);
      try {
        this.beginBy(deadline);
        this.hooks?.afterBegin?.(true);
      } catch (e) {
        this.statements.rollback();
        held.release();
        throw this.mapError(e);
      }
      return held;
    }
    for (;;) {
      const free = tryLock(this.paths.locks, STOP_LOCK);
      if (free === null) this.stopLockOrBusy(deadline).release();
      else free.release();
      this.beginBy(deadline);
      try {
        this.hooks?.afterBegin?.(false);
      } catch (e) {
        this.statements.rollback();
        throw e;
      }
      const probe = tryLock(this.paths.locks, STOP_LOCK);
      if (probe !== null) {
        probe.release();
        return null;
      }
      this.statements.rollback();
    }
  }

  private transaction<T>(
    req: { op: string | null; payload: unknown; command: string | undefined; filler: Filler | null },
    fn: (tx: WriteTx) => T,
    opts: { budgetMs: number; maintenance: boolean; chain?: boolean; stop: boolean },
  ): T {
    let stopLock: ProcessLock | null = null;
    const deadline = Date.now() + this.busyTimeoutMs;
    if (opts.maintenance) this.begin();
    else stopLock = this.enter(opts.stop);
    let tx: WriteTx;
    try {
      if (opts.maintenance) this.hooks?.afterBegin?.(false);
      // The lock came within the busy limit, or the write does nothing at all (§4.1).
      else if (Date.now() > deadline) throw this.busyBy(deadline, 'waiting for the write lock');
      tx = new WriteTx(this, req.op, this.now(), opts.budgetMs, opts.chain ?? true);
    } catch (e) {
      this.statements.rollback();
      stopLock?.release();
      throw this.mapError(e);
    }
    this.current = tx;
    let flushed: string[] = [];
    let out: T;
    try {
      if (!opts.maintenance) {
        const marker = this.readMarker();
        if (marker !== null) this.adopt(marker);
        if (this.latched !== null) throw this.brokenError();
        const broken = this.getMeta('chain_broken');
        if (broken !== null) {
          const r = JSON.parse(broken) as ChainReport;
          throw new LedgerError('CHAIN_BROKEN', `the event log's hash chain is broken at event ${r.brokenAt} (${r.reason}); the last valid event is ${r.lastValid}. Every write is refused until the PM follows the WI on copying and moving the folder`);
        }
      }
      cleanPendingLeaves(this.paths.root, this.paths.pendingLeaves, tx);
      flushed = this.data.flushStaged();
      const prior = req.op === null ? undefined : (tx.stmt('SELECT payload_hash, response FROM ops WHERE op = ?').get(req.op) as { payload_hash: string; response: string } | undefined);
      if (prior !== undefined) {
        if (prior.payload_hash !== hashJson(req.payload ?? null)) throw new LedgerError('OP_CONFLICT', `operation ${req.op} was already committed with a different payload`);
        out = JSON.parse(prior.response) as T;
      } else {
        const ret = fn(tx);
        if (isThenable(ret)) {
          // Whatever the callback does after its first await runs on an ended transaction and fails there.
          ret.then(undefined, () => undefined);
          throw new LedgerError('BAD_REQUEST', 'a write runs synchronously: its callback returned a promise, so the write was rolled back');
        }
        // The extensions finish the write's own work in it (A2: the label propagation of what it appended).
        if (!opts.maintenance) {
          for (const ext of this.extensions) {
            const r: unknown = ext.beforeCommit?.(tx);
            if (isThenable(r)) {
              r.then(undefined, () => undefined);
              throw new LedgerError('BAD_REQUEST', `the ${ext.name} extension's beforeCommit returned a promise: it runs synchronously, so the write was rolled back`);
            }
          }
        }
        if (req.op !== null) {
          const response = canonicalJson(ret ?? null);
          tx.append({
            kind: 'op.receipt',
            op: req.op,
            payloadHash: hashJson(req.payload ?? null),
            response,
            ...(req.command !== undefined ? { command: req.command, filler: req.filler } : {}),
          });
          // The first answer is the recorded one, as every retry gets it.
          out = JSON.parse(response) as T;
        } else out = ret;
      }
      // A damaged event seen during the write, even if its error was caught: the write does not commit
      // (a maintenance write neither: a rebuild that found damage). And a break another process marked
      // meanwhile stops it too: the marker is read again right before the commit. A recovery removes the
      // marker only after its own commit, and no other write commits between (one writer at a time).
      if (tx.damaged !== null) throw new LedgerError('CHAIN_BROKEN', `the event log's hash chain is broken (${tx.damaged}); the write was rolled back and every write is refused until the PM follows the WI on copying and moving the folder`);
      tx.seal();
      // The budget covers all of the write's work, a retry's included (§4.1).
      const left = tx.budgetLeft();
      if (left < 0) throw new LedgerError('OVER_BUDGET', `the write did ${Math.round(opts.budgetMs - left)} ms of work; one write may do at most ${opts.budgetMs} ms (§4.1). It was rolled back, nothing was written`);
      this.hooks?.beforeCommit?.();
      if (!opts.maintenance) {
        const marker = this.readMarker();
        if (marker !== null) this.adopt(marker);
        if (this.latched !== null) throw new LedgerError('CHAIN_BROKEN', `the event log's hash chain is broken (${this.latched}); the write was rolled back and every write is refused until the PM follows the WI on copying and moving the folder`);
      }
      if (opts.maintenance) this.statements.commit();
      else this.commitBy(deadline);
    } catch (e) {
      tx.finish();
      try {
        tx.undoLeaves();
      } finally {
        this.statements.rollback();
        this.current = null;
        stopLock?.release();
      }
      if (this.latched !== null) this.persistLatch();
      throw this.mapError(e);
    }
    tx.finish();
    this.current = null;
    stopLock?.release();
    if (this.latched !== null) this.persistLatch();
    tx.leavesCommitted();
    this.data.dropStaged(flushed);
    return out;
  }

  /** Verify the whole event chain (§3.3 step 3); a break is recorded so every later write is refused until the PM acts. */
  verifyChain(): ChainReport {
    return this.read((db) => {
      const report = inspectChain(db);
      // Notified at once, inside the read: the new marker is written before anything else can fail.
      if (!report.ok) this.chainBroken(report.reason ?? 'broken chain', report.brokenAt, report);
      return report;
    });
  }

  /**
   * @internal The integrity gate of every open (§3.3): the log's structure
   * (revisions contiguous, nothing removed at the end) and its last event,
   * without hashing the whole log. A problem is verified in full and recorded.
   */
  checkIntegrity(): void {
    if (this.getMeta('chain_broken') !== null) return;
    const problem = this.read((db) => {
      const s = structureProblem(db);
      if (s !== null) return s;
      const t = chainTail(db);
      return t.ok ? null : t.reason;
    });
    if (problem !== null) this.chainBroken(problem);
    // A break another process marked (its database record may have failed); markers that cannot be read count as one.
    let marker: ReturnType<Memory['readMarker']>;
    try {
      marker = this.readMarker();
    } catch (e) {
      this.latched ??= (e as Error).message;
      return;
    }
    if (marker !== null) {
      this.adopt(marker);
      try {
        this.persistLatch();
      } catch {
        /* the marker holds it: every write is refused */
      }
    }
  }

  /**
   * Record a break in the database: the full report, verified inside the write
   * that records it. Returns whether it is recorded; false when the database is
   * busy or failing, or the full verification finds the chain intact (the
   * latch and the marker then stay until the PM's recovery checks again).
   */
  private recordChainBroken(given?: ChainReport): boolean {
    try {
      this.begin();
    } catch {
      return false;
    }
    try {
      const report = given ?? inspectChain(this);
      if (report.ok) {
        this.statements.rollback();
        return false;
      }
      setKey(this, 'meta', 'chain_broken', canonicalJson(report));
      this.statements.commit();
      return true;
    } catch {
      this.statements.rollback();
      return false;
    }
  }

  /**
   * The PM's choice under the copy/move WI for a broken chain (§3.3): continue
   * from the last valid event. Inside one write transaction (no other writer
   * between the verification and the cut), the chain is verified, the log is
   * cut after the last whole transaction up to the last valid event (a write is
   * atomic: none is kept in part), the state is rebuilt from what remains, and
   * a `memory.truncated` event records it. Under the maintenance lock.
   * Revisions after the cut are reused by later events. Returns the last valid
   * event, where the log was cut (`kept`), and how many events were removed.
   */
  continueFromLastValid(): { lastValid: number; kept: number; removed: number } {
    const held = lock(this.paths.locks, 'maintenance', { waitMs: this.busyTimeoutMs });
    try {
      // The reports this recovery handles: the markers present now. A marker written later is a newer report and stays.
      const handled = this.markerFiles();
      const out = this.maintenance(
        (tx) => {
          // The recovery's own, controlled verification (it does not mark the break again).
          const report = inspectChain(tx);
          if (report.ok) {
            deleteKey(tx, 'meta', 'chain_broken');
            return { lastValid: report.lastValid, kept: report.lastValid, removed: 0 };
          }
          const kept = report.lastWhole;
          const removed = Number(tx.stmt('DELETE FROM log WHERE rev > ?').run(kept).changes);
          tx.stmt("UPDATE sqlite_sequence SET seq = ? WHERE name = 'log'").run(kept);
          rebuildState(tx, this.extensions);
          tx.append({ kind: 'memory.truncated', lastValid: report.lastValid, kept, removed, reason: report.reason ?? 'broken chain' });
          deleteKey(tx, 'meta', 'chain_broken');
          return { lastValid: report.lastValid, kept, removed };
        },
        { chain: true },
      );
      for (const name of handled) removeFile(join(this.paths.locks, name));
      // This process unlatches only on its own verification, like any other.
      this.tryUnlatch();
      return out;
    } finally {
      held.release();
    }
  }

  /** Rebuild every state table from the log (`mp recompute` for the core tables; also run after a move). Refused (CHAIN_BROKEN) when the chain is broken. */
  rebuild(): RebuildReport {
    return this.maintenance((tx) => rebuildState(tx, this.extensions));
  }

  /** A recorded leaf as it is now (§5.2, §8.4 `mp read leaf`): its text, and whether it is missing or was edited. */
  readLeaf(leaf: string): LeafRead | null {
    return readLeaf(this.paths.root, this, leaf);
  }

  /** Git writes held after a move (§3.3 step 2), or null. */
  gitHold(): { reason: string; since: number } | null {
    const v = this.getMeta('git_hold');
    return v === null ? null : (JSON.parse(v) as { reason: string; since: number });
  }

  /** Throw GIT_WRITES_HELD while git writes are held (§3.3 step 2): a Constructor dispatch, a committing hand-back, a delivery, a landing. */
  assertGitWrites(what: string): void {
    const h = this.gitHold();
    if (h !== null) throw new LedgerError('GIT_WRITES_HELD', `${what} writes to git, which is held since this folder was moved or copied: ${h.reason}. The PM confirms under the copy/move WI that this copy is the one in use`);
  }

  /** Release a shared-repository hold after PM confirmation; pending link verification requires WI-31 and a retry. */
  confirmCopyInUse(req: { op: string; words?: string | null; filler?: Filler | null }): { released: boolean } {
    return this.write({ op: req.op, payload: { confirm: 'copy-in-use', words: req.words ?? null }, command: 'confirm-copy', filler: req.filler ?? null }, (tx) => {
      if ((JSON.parse(getKey(tx, 'meta', 'move') ?? '{}') as { gitLinksPending?: boolean }).gitLinksPending) {
        throw new LedgerError('GIT_WRITES_HELD', 'WI-31: copied worktree links still need verification. Fix the links and retry mp; confirm-copy cannot release this hold.');
      }
      if (getKey(tx, 'meta', 'git_hold') === null) return { released: false };
      tx.append({ kind: 'memory.git-confirmed', words: req.words ?? null });
      deleteKey(tx, 'meta', 'git_hold');
      return { released: true };
    });
  }

  status(): MemoryStatus {
    return this.read((db) => {
      const meta = (k: string): string | null => getKey(db, 'meta', k);
      const json = <T>(k: string): T | null => {
        const v = meta(k);
        return v === null ? null : (JSON.parse(v) as T);
      };
      return {
        head: revision(Number((db.stmt('SELECT COALESCE(MAX(rev), 0) AS r FROM log').get() as { r: number }).r)),
        format: meta('format') ?? '',
        place: { path: meta('project_path') ?? '', machine: meta('machine') ?? '' },
        movePending: json('move'),
        lastMove: json('last_move'),
        chainBroken: json<ChainReport>('chain_broken') ?? this.latchedReport(),
        gitHold: json('git_hold'),
        pendingLeaves: hasPendingLeaves(this.paths.pendingLeaves),
      };
    });
  }

  /** A break latched or marked but not (yet) in the database, as a report (its first bad revision when known). */
  private latchedReport(): ChainReport | null {
    let marker: ReturnType<Memory['readMarker']>;
    try {
      marker = this.readMarker();
    } catch (e) {
      return { ok: false, events: 0, lastValid: 0, lastWhole: 0, brokenAt: null, reason: (e as Error).message };
    }
    const reason = this.latched ?? marker?.reason ?? null;
    if (reason === null) return null;
    const at = marker?.brokenAt ?? null;
    return { ok: false, events: 0, lastValid: at === null ? 0 : Math.max(0, at - 1), lastWhole: 0, brokenAt: at, reason };
  }

  /** @internal The extensions' commits (§3.3 step 5). */
  extensionCommits(db: Db): string[] {
    const out: string[] = [];
    for (const ext of this.extensions) for (const c of ext.commits?.(db) ?? []) out.push(c);
    return out;
  }

  /** @internal Run the extensions' DDL when one of their tables is missing. */
  installExtensions(): void {
    const missing = this.extensions.filter((e) => e.schema !== undefined && (e.tables ?? []).some((t) => !this.stmt("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)));
    if (missing.length === 0) return;
    this.begin();
    try {
      for (const e of missing) this.statements.db.exec(e.schema!);
      this.statements.commit();
    } catch (e) {
      this.statements.rollback();
      throw this.mapError(e);
    }
  }
}

// ---------------------------------------------------------------- init and open

/** Create the schema when the database is new (or older than this mp): one transaction, harmless when two processes race. */
function ensureSchema(st: Statements, busyMs: number): void {
  try {
    const version = Number((st.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version >= SCHEMA_VERSION) return;
    st.begin('IMMEDIATE');
    try {
      st.db.exec(SCHEMA);
      st.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      st.commit();
    } catch (e) {
      st.rollback();
      throw e;
    }
  } catch (e) {
    throw busy(e, busyMs);
  }
}

function realDir(projectDir: string): string {
  let real: string;
  try {
    real = realpathSync.native(projectDir);
  } catch {
    throw new LedgerError('BAD_REQUEST', `project folder ${projectDir} does not exist`);
  }
  if (!statSync(real).isDirectory()) throw new LedgerError('BAD_REQUEST', `${projectDir} is not a folder`);
  return real;
}

export interface InitReport {
  /** False when the memory already existed (init is idempotent). */
  readonly created: boolean;
  readonly root: string;
  /** `.mission-pipeline/` in `.git/info/exclude` (§3.1, the maintainer's answer to Q2). */
  readonly exclude: 'added' | 'present' | 'no-repository';
  /** The repository layout check of §3.3: warnings, never a refusal. */
  readonly layout: RepositoryLayout;
}

/**
 * Create `<project>/.mission-pipeline/` (§3.1): the directories, memory.db with
 * its schema and the first event, the git exclude line. Idempotent. Role
 * descriptions, the handbook and config.json are the CLI's (`mp init`).
 */
export function initMemory(projectDir: string, opts: OpenOptions = {}): InitReport {
  const project = realDir(projectDir);
  const paths = memoryPaths(project);
  mkdirDurable(paths.root);
  for (const d of LAYOUT_DIRS) mkdirSync(join(paths.root, d), { recursive: true });
  const created = !existsSync(paths.db);
  const busyMs = opts.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
  const st = new Statements(openDatabase(paths.db, busyMs));
  try {
    ensureSchema(st, busyMs);
    const m = new Memory(paths, st, opts);
    m.installExtensions();
    if (m.getMeta('format') === null) {
      m.maintenance((tx) => {
        // Two inits racing: the second finds the first's.
        if (getKey(tx, 'meta', 'format') !== null) return;
        setKey(tx, 'meta', 'format', MEMORY_FORMAT);
        setKey(tx, 'meta', 'project_path', project);
        setKey(tx, 'meta', 'machine', m.machine);
        setKey(tx, 'meta', 'created_at', String(tx.at));
        tx.append({ kind: 'memory.init', format: MEMORY_FORMAT });
      });
    }
  } finally {
    if (st.inTransaction) st.rollback();
    st.db.close();
  }
  const git = opts.git === undefined ? plainGit() : opts.git;
  return { created, root: paths.root, exclude: git === null ? 'no-repository' : addGitExclude(git, project), layout: repositoryLayout(git, project) };
}

/**
 * Open the memory of a project folder. When the folder was copied or moved (its
 * recorded path or machine differs, or a recovery is unfinished), the recovery
 * of §3.3 runs first, under the maintenance lock; a second process waits for it
 * or gets MOVING after the busy limit. Then the integrity gate: a log whose
 * structure or last event is damaged is verified in full and recorded as
 * broken (every write refused).
 */
export function openMemory(projectDir: string, opts: OpenOptions = {}): Memory {
  const project = realDir(projectDir);
  const paths = memoryPaths(project);
  if (!existsSync(paths.db)) throw new LedgerError('NOT_INITIALIZED', `${project} has no project memory (.mission-pipeline/memory.db): run mp init`);
  const busyMs = opts.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
  let st: Statements;
  try {
    st = new Statements(openDatabase(paths.db, busyMs));
  } catch (e) {
    throw busy(e, busyMs);
  }
  let m: Memory | null = null;
  try {
    ensureSchema(st, busyMs);
    m = new Memory(paths, st, opts);
    m.installExtensions();
    const format = m.getMeta('format');
    if (format !== MEMORY_FORMAT) throw new LedgerError('BAD_REQUEST', `${paths.db} is not a project memory of this mp (format ${format ?? 'none'}, expected ${MEMORY_FORMAT})`);
    recoverIfMoved(m, { path: project, machine: m.machine });
    m.checkIntegrity();
    return m;
  } catch (e) {
    if (m !== null) m.close();
    else st.db.close();
    throw e;
  }
}
