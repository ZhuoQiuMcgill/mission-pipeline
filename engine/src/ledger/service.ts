// The ledger service: the only writer of the main ledger (design 6.1).
//
// Requests are executed one at a time; stop requests always go first. Every
// handler is a bounded piece of work inside one SQLite transaction: no derived
// state is ever computed here. A thing "happened" only if this service committed
// it. When the storage fails, or one transaction overruns the storage deadline,
// the service stops accepting writes (storage fault) until a probe succeeds; stops
// keep arriving through the inbox and the control plane.
//
// Boundaries enforced here (core reviews r1, r2):
// - every record is validated (shape, value domains, size) and everything it
//   refers to in the content store is verified (bytes hash to the name; lists are
//   JSON lists of strings with the declared count, at most MAX_LIST_ITEMS). That
//   work grows with the content, so it runs before the request enters the queue,
//   asynchronously and in chunks (verify.ts); inside the queue only a constant
//   check remains, and a stop never waits behind a large list (F7, F11);
// - each entry point may write only its own record kinds;
// - a fact's identity (object, judgment, evidence, unit, basis version, pending
//   operation...) is written once: the same fact again is a no-op, a different
//   payload under the same identity is refused;
// - every change to a state table is the projection of one record appended in
//   the same transaction (projection.ts), so the log rebuilds every table
//   (rebuild.ts, 10.1 rule 3, F17);
// - stop scopes come from what the ledger persisted (a launch's mission and
//   capabilities, a pending operation's scope), never from the caller (F1);
// - the evaluator is bound to the scheduler generation that started it (F10);
// - automatic loops (6.5): one Secretary grant per lineage across all its loops,
//   and an attempt on an exhausted loop counted at its start (a landing attempt
//   entering the push stage) is refused, in the transaction (LOOP_EXHAUSTED,
//   GRANT_LIMIT: WI-08); exhaustion is persistent (queries.ts readLoopState);
// - the startup decision after a reboot and the PM's resume are recovery.pause
//   records with their basis (v43 6.1 "开机后的处理", WI-12); user messages
//   (用户原话, 10.1 item 6) and the scheduler's task queue (4.1) are records too,
//   so WI-12's check and a restarted scheduler read them from the ledger;
// - business identity (the op id and payload) is checked before transport
//   identity (generation), so a retry after a scheduler handover gets the
//   original result (6.1 "业务身份与传输身份").
//
// Every refusal is a typed LedgerError (errors.ts) that the caller maps to a PM
// work instruction (3.11); a refusal stops only the action that caused it.

import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, hashJson, sha256 } from '../common/hash.ts';
import {
  id,
  missionIdProblem,
  revision,
  type AlertId,
  type ContentHash,
  type EpisodeBatchId,
  type Generation,
  type JudgmentId,
  type LaunchId,
  type MissionId,
  type OpId,
  type ReservationId,
  type Revision,
  type StopId,
} from '../common/ids.ts';
import {
  continuationInputsHash,
  LOOP_KINDS,
  LOOPS_REFUSED_WHEN_EXHAUSTED,
  type BaseRecord,
  type Committed,
  type EvidenceRecord,
  type IntentDelivery,
  type JudgmentInputs,
  type JudgmentRecord,
  type ListRef,
  type LoopKind,
  type MissionBlockRecord,
  type StartupBasis,
  type TerminationProofRecord,
  type UserWordsRecord,
} from '../common/records.ts';
import { RecordInvalid, validateRecord } from '../common/validate.ts';
import { renewalDecision } from '../evaluator/renewal.ts';
import { ContentStore } from './content.ts';
import { mkdirDurable } from './durable.ts';
import { LedgerError } from './errors.ts';
import {
  activeStops,
  currentDelivery,
  factById,
  listMissions,
  missionCloses,
  noticeDeliveries,
  pmAction,
  pmActions,
  stopInfo,
  flowEvents,
  flowMissions,
  recordsByKind,
  deliveryInfo,
  laterDelivery,
  latestUserWords,
  listLaunches,
  missionBlocks,
  openIntents,
  readLoopState,
  startupDecision,
  stopState,
  dispatchedTasks,
  taskInfo,
  taskQueue,
  type ActiveStop,
  type DispatchedTask,
  type BookedUserWords,
  type DeliveryInfo,
  type Disposition,
  type FlowEventRow,
  type MissionClose,
  type MissionInfo,
  type NoticeDelivery,
  type PmAction,
  type IntentState,
  type LaunchFilter,
  type LaunchInfo,
  type LoopState,
  type OpenIntent,
  type QueuedTask,
  type StartupDecision,
  type TaskInfo,
} from './queries.ts';
import { currentGeneration, identityOf, project, type ProjectionContext } from './projection.ts';
import { Store, isStorageError } from './store.ts';
import { ControlState, tryControlState } from './controlState.ts';
import { installInbox, readHeader, readSlotsAsync, readSlotsSync, zeroSlotsSync, type FsCheck, type InboxHeader, type InboxName, type SlotContent } from './inbox.ts';
import { bootsInInboxes, decideStartup, evaluateBoot, reclaimableSlots, scanInbox, type InboxScan } from './startup.ts';
import {
  inboxConfigFile,
  parseStopRequest,
  readStopResolution,
  writeStopResolution,
  resolveInboxes,
  sameTag,
  scopeWithin,
  spoolDir,
  stagedStops,
  stagedStopsAsync,
  stopCovers,
  writeInboxConfig,
  type InboxConfig,
  type ScopeTag,
  type StopPaths,
  type StopRequest,
  type StopScope,
} from './stops.ts';
import { ContentVerifier, emptyVerified, type Verified } from './verify.ts';
import { WriterLock } from './writerLock.ts';

export { LedgerError, REFUSAL_WI, type LedgerErrorCode, type WorkInstruction } from './errors.ts';
export type { LoopState } from './queries.ts';
export { MAX_LIST_BYTES, MAX_LIST_ITEMS } from './verify.ts';

export interface LedgerPaths extends StopPaths {
  readonly root: string;
  readonly db: string;
  readonly lock: string;
  readonly content: string;
}

/**
 * Ledger root must be on a Linux filesystem; the control plane on a memory
 * filesystem (6.1). The primary stop inbox lives under the root; the backup
 * inbox, on another volume, is chosen at install (`backupInbox`; undefined: as
 * recorded by the install, null: none).
 */
export function ledgerPaths(root: string, controlPlane: string, opts: { backupInbox?: string | null } = {}): LedgerPaths {
  return {
    root,
    db: join(root, 'ledger.sqlite'),
    lock: join(root, 'writer.lock'),
    inbox: join(root, 'stop-inbox', 'primary.inbox'),
    content: join(root, 'content'),
    controlPlane,
    ...(opts.backupInbox !== undefined ? { backupInbox: opts.backupInbox } : {}),
  };
}

export type { ActiveStop, BookedUserWords, DeliveryInfo, DispatchedTask, Disposition, FlowEventRow, MissionClose, MissionInfo, NoticeDelivery, PmAction, IntentState, LaunchFilter, LaunchInfo, OpenIntent, QueuedTask, StartupDecision, TaskInfo } from './queries.ts';

/** Who an evaluator process is (6.1, 6.3): recorded when it begins, so the scheduler can verify it. */
export interface EvaluatorIdentity {
  readonly pid: number;
  /** The process start time as the kernel reports it (/proc/<pid>/stat field 22). */
  readonly startTime: string;
  readonly bootId: string;
}

export interface ServiceOptions {
  readonly paths: LedgerPaths;
  readonly now?: () => number;
  readonly bootId?: () => string;
  /** Fault injection for tests: return true to make the next write fail as an I/O error. */
  readonly injectWriteFault?: () => boolean;
  /** Fault injection for tests: block this many ms inside the next transaction (a slow disk). */
  readonly injectWriteDelayMs?: () => number;
  /** Budget for one action (5.5: 500 ms). Slower actions are recorded in `slowActions`, never preempted. */
  readonly actionBudgetMs?: number;
  /** A storage transaction slower than this puts the service into storage fault after it returns (6.1). Default 5,000 ms. */
  readonly storageDeadlineMs?: number;
  /** Observes the duration of every action executed in the queue. */
  readonly onAction?: (name: string, ms: number) => void;
  /** Per-list item cap; defaults to MAX_LIST_ITEMS (250,000). */
  readonly maxListItems?: number;
  /**
   * Pick up stops sent as files while the service runs (default on, polling every
   * 250 ms; at most 500 ms). `false` leaves it to explicit drainStops() calls.
   */
  readonly watchStops?: boolean | { readonly pollMs?: number };
  /** Slots of a stop inbox created at open (default DEFAULT_SLOTS); tests use fewer. */
  readonly inboxSlots?: number;
  readonly inboxSlotSize?: number;
}

export interface OpenReport {
  readonly recoveryPause: boolean;
  readonly stopsCommitted: readonly StopId[];
}

/** Request size limits: every action stays bounded (5.5, 6.1). */
export const MAX_RECORDS_PER_REQUEST = 1000;
/** One record, in UTF-8 bytes of its canonical JSON (core review r3 #10: bytes, not characters). */
export const MAX_RECORD_BYTES = 64 * 1024;
/** All records of one request together: keeps the queued part of one action within the 500 ms budget (5.5). */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** Landing phase data and action details are stored as content; their size is still bounded. */
const MAX_DETAILS_BYTES = MAX_RECORD_BYTES * 4;
/** A user message's full text (10.1 item 6); the record itself carries only the hash and an excerpt. */
const MAX_USER_WORDS_BYTES = 16 * 1024 * 1024;
const PROBE_FIRST_MS = 250;
const PROBE_MAX_MS = 5_000;

/** Kinds the program may append directly (PM/CLI requirement items, registrations, scheduler bookkeeping). */
const APPEND_KINDS: ReadonlySet<string> = new Set([
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
  'notice',
  'loop.attempt',
  'loop.grant',
  'mission.block',
  // The flows' own facts (src/flow/RECORDS-NEEDED.md): appended with the base records they belong to, in one op.
  'flow.event',
]);

const FLOW_EVENT_ONLY: ReadonlySet<string> = new Set(['flow.event']);

/** Kinds a unit may hand back as pending results; they become base records only on acceptance (7.1). */
const PENDING_KINDS: ReadonlySet<string> = new Set([
  'seat.result',
  'evidence',
  'object.version',
  'proof.unit',
  'judgment',
  'issue',
  'issue.coverage',
  'evidence.renewal',
  'run.layer',
  'claude-code.exit',
]);

function linuxBootId(): string {
  return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

class InjectedIoError extends Error {
  constructor() {
    super('disk I/O error (injected)');
  }
}

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

const PRIORITY_STOP = 0;
const PRIORITY_NORMAL = 1;

interface Queued {
  readonly priority: number;
  readonly run: () => unknown;
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: unknown) => void;
}

function checkIdentity(x: unknown): EvaluatorIdentity {
  const o = x as Record<string, unknown> | null;
  const ok =
    o !== null &&
    typeof o === 'object' &&
    typeof o.pid === 'number' &&
    Number.isSafeInteger(o.pid) &&
    o.pid > 0 &&
    typeof o.startTime === 'string' &&
    o.startTime.length > 0 &&
    o.startTime.length <= 200 &&
    typeof o.bootId === 'string' &&
    o.bootId.length > 0 &&
    o.bootId.length <= 200;
  if (!ok) throw new LedgerError('BAD_REQUEST', 'an evaluator identity is { pid, startTime, bootId }');
  return { pid: o.pid as number, startTime: o.startTime as string, bootId: o.bootId as string };
}

/** The stop request a slot holds, its words marked when the slot cut them. */
function stopOf(c: SlotContent): StopRequest[] {
  if (c.state !== 'record' || c.record.kind !== 'stop') return [];
  const r = c.record;
  return [r.wordsTruncated ? { ...r.request, words: `${r.request.words}…` } : r.request];
}

export class LedgerService {
  readonly paths: LedgerPaths;
  readonly content: ContentStore;
  private readonly verifier: ContentVerifier;
  private readonly lock: WriterLock;
  private store: Store | null = null;
  private readonly now: () => number;
  private readonly bootId: () => string;
  private readonly injectWriteFault: () => boolean;
  private readonly injectWriteDelayMs: () => number;
  private readonly budgetMs: number;
  private readonly deadlineMs: number;
  private readonly onAction: ((name: string, ms: number) => void) | null;
  private readonly watchOpt: false | { readonly pollMs?: number };
  /** The boot id seen at open. */
  private boot: string | null = null;
  private readonly queue: Queued[] = [];
  private pumping = false;
  private fault = false;
  private faultReason: string | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private probeDelay = PROBE_FIRST_MS;
  /** The commit time of the transaction in progress; every timestamp it writes takes this value. */
  private txTime = 0;
  /** Content the transaction in progress already holds (for the projection), by hash. */
  private txBlobs = new Map<string, string>();
  private txLists = new Map<string, readonly string[]>();
  private watching: { watchers: FSWatcher[]; timer: NodeJS.Timeout } | null = null;
  private draining = false;
  private drainAgain = false;
  /** Spool files whose stop is committed: not read again (the spool itself stays for the units). */
  private readonly spoolSeen = new Set<string>();
  /** The stop path's control-plane state (controlState.ts): allocations, committed marks, the exit record. */
  private control: ControlState | null = null;
  /** The configured stop inboxes and their headers (null: not readable at open). */
  private inboxes: Array<{ name: InboxName; file: string; header: InboxHeader | null }> = [];
  /** The last control-plane allocation (this boot, kind stop) the drain has taken in. */
  private allocCursor = 0;
  /** Stop slots of this boot allocated but not read as a stop yet (the writer is still writing, or retrying). */
  private readonly pendingSlots = new Map<number, { inbox: InboxName; slot: number }>();
  private readonly inboxSlots: number | undefined;
  private readonly inboxSlotSize: number | undefined;
  /** Durations (ms) of actions that exceeded the budget; exposed for the 5.5 threshold tests. */
  readonly slowActions: Array<{ name: string; ms: number }> = [];

  constructor(opts: ServiceOptions) {
    this.paths = opts.paths;
    this.content = new ContentStore(opts.paths.content);
    this.verifier = new ContentVerifier(this.content, opts.maxListItems !== undefined ? { maxListItems: opts.maxListItems } : {});
    this.lock = new WriterLock(opts.paths.lock);
    this.now = opts.now ?? Date.now;
    this.bootId = opts.bootId ?? linuxBootId;
    this.injectWriteFault = opts.injectWriteFault ?? (() => false);
    this.injectWriteDelayMs = opts.injectWriteDelayMs ?? (() => 0);
    this.budgetMs = opts.actionBudgetMs ?? 500;
    this.deadlineMs = opts.storageDeadlineMs ?? 5_000;
    this.onAction = opts.onAction ?? null;
    this.watchOpt = opts.watchStops === false ? false : opts.watchStops === true || opts.watchStops === undefined ? {} : opts.watchStops;
    this.inboxSlots = opts.inboxSlots;
    this.inboxSlotSize = opts.inboxSlotSize;
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Take the writer lock and open the database; commit every stop the inboxes and
   * the staging copy hold before anything else; after a reboot, decide from the
   * previous boots' inbox evidence whether to go on or enter the recovery pause
   * (v45 6.1 "开机后的处理") and record the decision with its basis; mark those
   * boots processed, and only then reclaim their inbox slots. Then start watching
   * for stops (unless `watchStops: false`).
   */
  open(): OpenReport {
    mkdirDurable(this.paths.root);
    mkdirSync(spoolDir(this.paths), { recursive: true }); // control plane: a memory filesystem
    this.lock.acquire();
    try {
      this.content.init();
      this.store = new Store(this.paths.db);
      this.fault = false;
      this.faultReason = null;
      const store = this.store;
      const boot = this.bootId();
      this.boot = boot;
      this.control = tryControlState(this.paths.controlPlane);
      const ledgerClosedCleanly = store.getState('running') === null;
      const lastBoot = store.getState('last_boot');
      // The inboxes: read what they hold first (evidence), then install what is missing.
      const before = this.readInstallRecord();
      const configured = resolveInboxes(this.paths);
      const targets: Array<{ name: InboxName; file: string }> = [{ name: 'primary', file: configured.primary }, ...(configured.backup !== null ? [{ name: 'backup' as const, file: configured.backup }] : [])];
      const knownBefore = (name: InboxName): boolean => (name === 'primary' ? before !== null || existsSync(configured.primary) : before?.backup !== null && before?.backup !== undefined);
      const scans: InboxScan[] = targets.filter((t) => existsSync(t.file) || knownBefore(t.name)).map((t) => scanInbox(t.name, t.file));
      this.installInboxes(targets);
      const currentSlots = this.currentBootSlots(boot);
      // 1. Stops first: the staging copy (full words), then every stop record of the inboxes.
      const fromInboxes = scans.flatMap((sc) => sc.slots.flatMap((c) => stopOf(c)));
      const stopsCommitted = this.commitRequests([...stagedStops(this.paths.controlPlane), ...fromInboxes]);
      // 1b. Resolution markers a crash left missing (released or narrowed stops): until now they over-stopped.
      this.writeResolutions(null);
      this.takeInAllocations(scans);
      // 2. The previous boots not yet processed.
      const processed = new Set((store.stmt('SELECT boot FROM inbox_boots').all() as Array<{ boot: string }>).map((r) => r.boot));
      const prev = bootsInInboxes(scans, boot);
      if (lastBoot !== null && lastBoot !== boot) prev.add(lastBoot);
      for (const b of processed) prev.delete(b);
      const backupConfigured = before !== null ? before.backup !== null : configured.backup !== null && scans.some((sc) => sc.name === 'backup');
      this.write((s) => {
        if (prev.size > 0) {
          const evidence = [...prev].sort().map((b) => evaluateBoot(b, scans, { backupConfigured, currentSlots }));
          const work = this.autoAdvancingWork(s);
          const d = decideStartup(evidence, work);
          const pause = s.getState('recovery_pause') !== null || d.pause;
          const basis: StartupBasis = {
            boot,
            previousBoot: lastBoot,
            cleanShutdown: evidence.every((e) => e.row === 'clean-shutdown'),
            ledgerClosedCleanly,
            evidence: d.row,
            backupConfigured,
            boots: evidence,
            work,
            stopsCommitted: stopsCommitted.length,
            reminder: pause ? null : d.reminder,
          };
          this.emit(s, { kind: 'recovery.pause', state: pause ? 'set' : 'continued', basis }, null);
        }
        s.setState('running', String(process.pid));
        s.setState('last_boot', boot);
      });
      // 3. Reclaim the slots of processed boots (only after the decision is committed).
      this.reclaimSlots(scans, currentSlots, prev.size > 0);
      if (this.watchOpt !== false) this.watchStops(this.watchOpt);
      return { recoveryPause: store.getState('recovery_pause') !== null, stopsCommitted };
    } catch (e) {
      if (this.probeTimer) clearTimeout(this.probeTimer);
      this.probeTimer = null;
      this.control?.close();
      this.control = null;
      this.store?.close();
      this.store = null;
      this.lock.release();
      throw e;
    }
  }

  /** The install record of the inboxes as it was before this open (null: none yet). */
  private readInstallRecord(): InboxConfig | null {
    try {
      const c = JSON.parse(readFileSync(inboxConfigFile(this.paths.inbox), 'utf8')) as InboxConfig;
      return c.format === 'mp4.stop-inboxes.v1' && c.primary === this.paths.inbox ? c : null;
    } catch {
      return null;
    }
  }

  /** Install every configured inbox that is missing (6.1: pre-written, fsynced, chain durable); record the configuration. */
  private installInboxes(targets: ReadonlyArray<{ name: InboxName; file: string }>): void {
    const fs: { primary: FsCheck | null; backup: FsCheck | null } = { primary: null, backup: null };
    this.inboxes = [];
    for (const t of targets) {
      try {
        const opts = { ...(this.inboxSlots !== undefined ? { slots: this.inboxSlots } : {}), ...(this.inboxSlotSize !== undefined ? { slotSize: this.inboxSlotSize } : {}) };
        const r = installInbox(t.file, t.name, opts);
        this.inboxes.push({ ...t, header: r.header });
        fs[t.name] = r.header.fs;
      } catch {
        this.inboxes.push({ ...t, header: null }); // unreadable now: evidence at the next start, retried by the drain
      }
    }
    try {
      const primaryFs = fs.primary ?? { type: 'unknown', magic: '?', fullDiskGuarantee: false, reason: 'not installed' };
      writeInboxConfig(this.paths, {
        format: 'mp4.stop-inboxes.v1',
        primary: this.paths.inbox,
        backup: targets.find((t) => t.name === 'backup')?.file ?? null,
        installedAt: Date.now(),
        fs: { primary: primaryFs, backup: fs.backup },
      });
    } catch {
      /* the record only helps entries find the backup; the paths still name it */
    }
  }

  /** Slots allocated in this boot (the control plane), per inbox: never evidence of another boot, never reclaimed. */
  private currentBootSlots(boot: string): Map<InboxName, Set<number>> {
    const out = new Map<InboxName, Set<number>>();
    try {
      for (const a of this.control?.allocations(boot) ?? []) {
        const set = out.get(a.inbox) ?? new Set<number>();
        set.add(a.slot);
        out.set(a.inbox, set);
      }
    } catch {
      /* no control plane: nothing allocated in this boot yet */
    }
    return out;
  }

  /** After the start's scan: allocations of this boot not seen as a stop yet stay pending for the drain. */
  private takeInAllocations(scans: readonly InboxScan[]): void {
    if (this.control === null || this.boot === null) return;
    try {
      for (const a of this.control.allocations(this.boot, 0, 'stop')) {
        const c = scans.find((sc) => sc.name === a.inbox)?.slots[a.slot];
        if (!(c?.state === 'record' && c.record.kind === 'stop')) this.pendingSlots.set(a.id, { inbox: a.inbox, slot: a.slot });
        this.allocCursor = Math.max(this.allocCursor, a.id);
      }
    } catch {
      /* the drain starts from zero */
    }
  }

  private reclaimSlots(scans: readonly InboxScan[], currentSlots: ReadonlyMap<InboxName, ReadonlySet<number>>, decidedNow: boolean): void {
    const store = this.db();
    const processed = new Set((store.stmt('SELECT boot FROM inbox_boots').all() as Array<{ boot: string }>).map((r) => r.boot));
    for (const sc of scans) {
      if (!sc.readable || sc.header === null) continue;
      const idx = reclaimableSlots(sc, processed, currentSlots.get(sc.name) ?? new Set(), decidedNow);
      try {
        zeroSlotsSync(sc.file, sc.header, idx);
      } catch {
        /* a slot left over is recognized as processed by its boot and reclaimed at a later start */
      }
    }
  }

  /** Clean shutdown: clears the running marker so the next start is not "unclean". */
  close(): void {
    this.unwatchStops();
    this.control?.close();
    this.control = null;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    if (this.store && !this.fault) {
      try {
        this.store.tx(() => this.store!.deleteState('running'));
      } catch {
        /* an unclean close is handled at the next open */
      }
    }
    this.store?.close();
    this.store = null;
    this.lock.release();
  }

  get inStorageFault(): boolean {
    return this.fault;
  }

  get storageFaultReason(): string | null {
    return this.faultReason;
  }

  get recoveryPaused(): boolean {
    return this.db().getState('recovery_pause') !== null;
  }

  // ------------------------------------------------------------ queue

  private enqueue<T>(priority: number, name: string, fn: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: Queued = {
        priority,
        run: () => this.timed(name, fn),
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      // Stops jump ahead of every queued normal request.
      const at = priority === PRIORITY_STOP ? this.queue.findIndex((q) => q.priority > PRIORITY_STOP) : -1;
      if (at === -1) this.queue.push(item);
      else this.queue.splice(at, 0, item);
      this.pump();
    });
  }

  /**
   * Run queued actions one at a time. Between two actions the event loop gets a
   * turn (setImmediate), so the stop watcher, the poll and file reads can run and
   * a stop that arrives meanwhile goes ahead of every queued normal request; a
   * backlog never starves the stops (core review r3 #12).
   */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    const step = (): void => {
      const item = this.queue.shift();
      if (item === undefined) {
        this.pumping = false;
        return;
      }
      try {
        item.resolve(item.run());
      } catch (e) {
        item.reject(e);
      }
      if (this.queue.length === 0) {
        this.pumping = false;
        return;
      }
      setImmediate(step);
    };
    queueMicrotask(step);
  }

  private timed<T>(name: string, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      const ms = performance.now() - t0;
      if (ms > this.budgetMs) this.slowActions.push({ name, ms });
      this.onAction?.(name, ms);
    }
  }

  private db(): Store {
    if (!this.store) throw new Error('ledger service is not open');
    return this.store;
  }

  /** Refuse before any work when the service cannot write anyway. */
  private failFast(): void {
    this.db();
    if (this.fault) throw new LedgerError('STORAGE_FAULT', `the ledger storage is failing (${this.faultReason}); writes are refused until a probe succeeds`);
  }

  /**
   * A write transaction with storage-fault detection (6.1 "存储故障"). A storage
   * error (by SQLite result code) puts the service into fault mode; recovery is
   * the watchdog's restart or an explicit tryRecoverStorage(). A transaction
   * that overran the storage deadline also does, after it returns (its result
   * stands: it was committed); then a probe is scheduled automatically, with
   * backoff. Every write is refused until a probe succeeds.
   */
  private write<T>(fn: (s: Store) => T): T {
    if (this.fault) throw new LedgerError('STORAGE_FAULT', `the ledger storage is failing (${this.faultReason}); writes are refused until a probe succeeds`);
    const s = this.db();
    const t0 = performance.now();
    let out: T;
    try {
      out = s.tx(() => {
        this.txTime = this.now();
        this.txBlobs = new Map();
        this.txLists = new Map();
        if (this.injectWriteFault()) throw new InjectedIoError();
        const delay = this.injectWriteDelayMs();
        if (delay > 0) sleepSync(delay);
        return fn(s);
      });
    } catch (e) {
      if (e instanceof InjectedIoError || isStorageError(e)) {
        // An I/O error: the watchdog restarts the service with backoff (6.1); tryRecoverStorage() probes on request.
        this.enterFault(String((e as Error).message), false);
        throw new LedgerError('STORAGE_FAULT', String((e as Error).message));
      }
      if (e instanceof RecordInvalid) throw new LedgerError('RECORD_INVALID', e.message);
      throw e;
    } finally {
      this.txBlobs = new Map();
      this.txLists = new Map();
    }
    const ms = performance.now() - t0;
    // Over the deadline: the commit stands, then the service refuses writes until a probe (scheduled now) succeeds.
    if (ms > this.deadlineMs) this.enterFault(`a storage transaction took ${Math.round(ms)} ms, over the ${this.deadlineMs} ms storage deadline`, true);
    return out;
  }

  private enterFault(reason: string, probe: boolean): void {
    if (this.fault) return;
    this.fault = true;
    this.faultReason = reason;
    this.probeDelay = PROBE_FIRST_MS;
    if (probe) this.scheduleProbe();
  }

  private scheduleProbe(): void {
    if (this.probeTimer !== null || this.store === null) return;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.store === null || !this.fault) return;
      if (!this.tryRecoverStorage()) {
        this.probeDelay = Math.min(this.probeDelay * 2, PROBE_MAX_MS);
        this.scheduleProbe();
      }
    }, this.probeDelay);
    this.probeTimer.unref();
  }

  /**
   * Probe the storage with one small write that must also meet the deadline; on
   * success leave fault mode and commit pending stops first (6.1).
   */
  tryRecoverStorage(): boolean {
    if (!this.fault) return true;
    if (this.store === null) return false;
    const s = this.store;
    const t0 = performance.now();
    try {
      s.tx(() => {
        if (this.injectWriteFault()) throw new InjectedIoError();
        const delay = this.injectWriteDelayMs();
        if (delay > 0) sleepSync(delay);
        s.setState('storage_probe', String(this.now()));
      });
    } catch {
      return false;
    }
    if (performance.now() - t0 > this.deadlineMs) return false;
    this.fault = false;
    this.faultReason = null;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    try {
      this.drainStopsNow();
    } catch {
      /* the drain failed again: back in fault, the next probe repeats it */
    }
    return true;
  }

  // ------------------------------------------------------------ appending records (each with its projection)

  private ctx(rev: number): ProjectionContext {
    return {
      rev,
      at: this.txTime,
      blob: (h) => this.txBlobs.get(h) ?? this.content.get(h).toString('utf8'),
      list: (ref) => this.txLists.get(ref.hash) ?? this.content.getList(ref),
    };
  }

  /** Append a record to the log and apply its projection, in the transaction in progress. */
  private emit(s: Store, rec: BaseRecord, op: string | null): Revision {
    const rev = s.appendRecord(rec, op, this.txTime);
    project(s, rec, this.ctx(rev));
    return rev;
  }

  /** Append a service event that creates no revision (store.ts) and apply its projection. */
  private emitJournal(s: Store, rec: BaseRecord, op: string | null): void {
    s.appendJournal(rec, op, this.txTime);
    project(s, rec, this.ctx(s.head()));
  }

  // ------------------------------------------------------------ idempotency (6.1 业务身份与传输身份)

  /**
   * Business identity first: an op id already committed with the same business
   * payload (and launch) returns the original result, whatever the transport
   * identity of the retry; with a different payload it is refused. Transport
   * checks (generation, launch recognition) run only inside `fn`, for new ops.
   * A new op leaves a receipt (op, payload hash, launch, response) in the
   * journal, so the log can rebuild the table.
   */
  private idempotent<T>(s: Store, op: string, launch: string | null, payload: unknown, fn: () => T): T {
    const hash = hashJson(payload);
    const row = s.stmt('SELECT payload_hash, launch, response FROM ops WHERE op = ?').get(op) as
      | { payload_hash: string; launch: string | null; response: string }
      | undefined;
    if (row) {
      if (row.payload_hash !== hash || row.launch !== launch) {
        throw new LedgerError('OP_CONFLICT', `operation ${op} was already committed with a different payload`);
      }
      return JSON.parse(row.response) as T;
    }
    const out = fn();
    const json = canonicalJson(out ?? null);
    // In the transaction, so a committed receipt never names missing content.
    const response = this.content.put(json);
    this.txBlobs.set(response, json);
    this.emitJournal(s, { kind: 'op.receipt', op, payloadHash: hash, launch, response }, op);
    return out;
  }

  // ------------------------------------------------------------ records: validation, content, identity

  private checkShape(record: BaseRecord, allowed: ReadonlySet<string>, entry: string): void {
    if (!allowed.has(record?.kind)) throw new LedgerError('KIND_NOT_ALLOWED', `${entry} cannot write ${String(record?.kind)} records`);
    try {
      validateRecord(record);
    } catch (e) {
      if (e instanceof RecordInvalid) throw new LedgerError('RECORD_INVALID', e.message);
      throw e;
    }
    if (Buffer.byteLength(canonicalJson(record), 'utf8') > MAX_RECORD_BYTES) throw new LedgerError('TOO_LARGE', `a ${record.kind} record exceeds ${MAX_RECORD_BYTES} bytes (UTF-8)`);
  }

  /**
   * Append a fact. A fact with an identity is written at most once: the same
   * payload again returns its original revision without a new record; another
   * payload under the same identity is refused (5.1: versions are immutable).
   */
  private appendFact(s: Store, record: BaseRecord, op: string, v: Verified | null = null): Revision {
    const ident = identityOf(record);
    if (ident !== null) {
      const row = s.stmt('SELECT payload_hash, rev FROM facts WHERE kind = ? AND id = ?').get(record.kind, ident) as
        | { payload_hash: string; rev: number }
        | undefined;
      if (row) {
        if (row.payload_hash === hashJson(record)) return revision(row.rev);
        throw new LedgerError('FACT_CONFLICT', `${record.kind} ${ident} already exists with different content`);
      }
      // Objects and proof units share one id space: the evaluator keeps one state per id.
      const other = record.kind === 'object.version' ? 'proof.unit' : record.kind === 'proof.unit' ? 'object.version' : null;
      if (other !== null && this.hasFact(s, other, ident)) {
        throw new LedgerError('FACT_CONFLICT', `${ident} is already the id of a ${other}; objects and proof units share one id space`);
      }
    }
    if (record.kind === 'loop.attempt' || record.kind === 'loop.grant') this.checkLoop(s, record);
    if (record.kind === 'judgment' && record.extends !== null) this.checkContinuation(s, record, v);
    if (record.kind === 'evidence.renewal') this.checkRenewal(s, record);
    return this.emit(s, record, op);
  }

  /** A fact's record read back by its identity (one indexed lookup). */
  private factRecord<T extends BaseRecord>(s: Store, kind: string, ident: string): T | null {
    const row = s.stmt('SELECT rev FROM facts WHERE kind = ? AND id = ?').get(kind, ident) as { rev: number } | undefined;
    if (!row) return null;
    const r = s.stmt('SELECT record FROM log WHERE rev = ?').get(row.rev) as { record: string } | undefined;
    return r ? (JSON.parse(r.record) as T) : null;
  }

  /**
   * 5.3: the program registers a renewal only when the rule holds (the same
   * renewalDecision the evaluator applies; core review r3 F14). Otherwise the
   * judgment needs a new review (RENEWAL_REFUSED, a normal branch).
   */
  private checkRenewal(s: Store, r: Extract<BaseRecord, { kind: 'evidence.renewal' }>): void {
    const j = this.factRecord<JudgmentRecord>(s, 'judgment', r.judgment);
    const a = this.factRecord<EvidenceRecord>(s, 'evidence', r.original);
    const b = this.factRecord<EvidenceRecord>(s, 'evidence', r.replacement);
    if (!j || !a || !b) throw new LedgerError('RECORD_INVALID', `renewal of ${r.judgment}: the judgment and both evidence records must be committed first`);
    const d = renewalDecision(a, b, j.evidenceUse);
    if (!d.renew) throw new LedgerError('RENEWAL_REFUSED', `renewal of ${r.judgment} (${r.original} → ${r.replacement}) does not meet the rule: ${d.reason}${d.field ? ` (${d.field})` : ''}; the judgment needs a new review (5.3)`);
  }

  /**
   * 5.2 part 5 (core review r3 F1): a continuation judgment is committed only
   * after the evaluator's check passed for it at the latest published revision
   * (recordContinuationCheck). A failed or missing check sends the work to a full
   * review (CONTINUATION_REFUSED); a check at an older revision is asked again (BELOW_FLOOR).
   */
  private checkContinuation(s: Store, r: JudgmentRecord, v: Verified | null): void {
    const c = s.stmt('SELECT extends, target, revision, ok, reason, inputs FROM continuation_checks WHERE judgment = ?').get(r.judgment) as
      | { extends: string; target: string; revision: number; ok: number; reason: string | null; inputs: string | null }
      | undefined;
    if (!c) throw new LedgerError('CONTINUATION_REFUSED', `continuation judgment ${r.judgment} has no evaluator check: record one (recordContinuationCheck) or review in full`);
    if (c.extends !== r.extends || c.target !== r.target) throw new LedgerError('CONTINUATION_REFUSED', `the check recorded for ${r.judgment} was for another continuation (${c.extends} → ${c.target})`);
    if (c.ok !== 1) throw new LedgerError('CONTINUATION_REFUSED', `the evaluator refused continuation ${r.judgment} (${c.reason}): a full review instead (5.2 part 5)`);
    const floor = Number(s.getState('publication_floor') ?? '0');
    if (Number(c.revision) !== floor) throw new LedgerError('BELOW_FLOOR', `the check of ${r.judgment} answered at revision ${c.revision}; the latest published is ${floor}: ask the evaluator again`);
    // The judgment carries exactly the inputs the evaluator merged: J0's inherited inputs with renewals applied (core review r3 #1).
    const mine = v?.inputs.get(r.judgment);
    if (mine === undefined) throw new LedgerError('STALE_REQUEST', `the inputs of continuation ${r.judgment} were not read for this request`);
    if (mine !== c.inputs) {
      throw new LedgerError('CONTINUATION_REFUSED', `continuation ${r.judgment} does not carry the inputs the evaluator merged (evidence, bases, constraints, relied-on objects): carry them, or review in full`);
    }
  }

  /**
   * 6.5 "耗尽之后": the Secretary grants at most once per lineage, across all its
   * loops (GRANT_LIMIT, WI-08: after that only the user); an attempt that starts a
   * loop counted at its start is refused once the loop is exhausted
   * (LOOP_EXHAUSTED, WI-08). Checked in the transaction, so racing schedulers
   * cannot both pass.
   */
  private checkLoop(s: Store, r: Extract<BaseRecord, { kind: 'loop.attempt' } | { kind: 'loop.grant' }>): void {
    if (r.kind === 'loop.grant') {
      if (r.by !== 'secretary') return;
      const used = s.stmt('SELECT COALESCE(SUM(secretary_grants), 0) AS n FROM loops WHERE lineage = ?').get(r.lineage) as { n: number };
      if (Number(used.n) >= 1) {
        throw new LedgerError('GRANT_LIMIT', `the Secretary already granted extra attempts on lineage ${r.lineage} (6.5: once per lineage, across all its loops); a further grant is the user's decision`);
      }
      return;
    }
    if (!LOOPS_REFUSED_WHEN_EXHAUSTED.has(r.loop)) return;
    const st = readLoopState(s, r.lineage, r.loop, r.failureClass);
    if (st.exhausted) {
      throw new LedgerError('LOOP_EXHAUSTED', `${r.loop} on ${r.lineage} is exhausted (${st.reason}: ${st.attempts} of ${st.allowed} attempts); WI-08: the Secretary may grant once, then only the user`);
    }
  }

  private hasFact(s: Store, kind: string, ident: string): boolean {
    return Boolean(s.stmt('SELECT 1 FROM facts WHERE kind = ? AND id = ?').get(kind, ident));
  }

  private sized(n: number): void {
    if (!Number.isSafeInteger(n) || n > MAX_RECORDS_PER_REQUEST) throw new LedgerError('TOO_LARGE', `${n} records in one request; the limit is ${MAX_RECORDS_PER_REQUEST}`);
  }

  /** The request's records together, in UTF-8 bytes. */
  private requestBytes(records: readonly BaseRecord[]): void {
    const n = Buffer.byteLength(canonicalJson(records), 'utf8');
    if (n > MAX_REQUEST_BYTES) throw new LedgerError('TOO_LARGE', `the request's records are ${n} bytes; the limit is ${MAX_REQUEST_BYTES} per request`);
  }

  /** A deep copy of the caller's input, fixed at entry: what is verified is exactly what is committed (core review r3 #10). */
  private freeze<T>(x: T): T {
    return JSON.parse(canonicalJson(x ?? null)) as T;
  }

  /**
   * Business identity first (6.1 "业务身份与传输身份"; core review r3 #11): an
   * operation already committed with the same payload returns its original
   * result before any check or content verification; another payload is refused.
   */
  private priorReceipt<T>(op: string, launch: string | null, payload: unknown): T | undefined {
    const row = this.db().stmt('SELECT payload_hash, launch, response FROM ops WHERE op = ?').get(op) as { payload_hash: string; launch: string | null; response: string } | undefined;
    if (!row) return undefined;
    if (row.payload_hash !== hashJson(payload) || row.launch !== launch) throw new LedgerError('OP_CONFLICT', `operation ${op} was already committed with a different payload`);
    return JSON.parse(row.response) as T;
  }

  /** Store content before a request enters the queue; a failing disk is a storage fault (WI-12), not a malformed request (core review r3 #18). */
  private async putContent(data: string): Promise<ContentHash> {
    try {
      return await this.content.putAsync(data);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (['ENOSPC', 'EIO', 'EROFS', 'EDQUOT', 'ENOMEM', 'EMFILE', 'ENFILE'].includes(code) || isStorageError(e)) {
        this.enterFault(`the content store cannot be written: ${(e as Error).message}`, false);
        throw new LedgerError('STORAGE_FAULT', `the content store cannot be written: ${(e as Error).message}`);
      }
      throw new LedgerError('INTERNAL_ERROR', `the content store failed: ${(e as Error).message}`);
    }
  }

  /**
   * One loop's counters and verdict (6.5): attempts (per failure class for env
   * retries), consecutive repeats of the same failure signature, grants, the
   * attempt count at the last grant, the cap and whether the loop is exhausted
   * (and why). `failureClass`: the class of the next env-retry attempt.
   */
  loopState(lineage: string, loop: LoopKind, failureClass: string | null = null): LoopState {
    if (!LOOP_KINDS.includes(loop)) throw new LedgerError('BAD_REQUEST', `unknown loop kind ${String(loop)}; the kinds are ${LOOP_KINDS.join(', ')}`);
    return readLoopState(this.db(), lineage, loop, failureClass);
  }

  /**
   * 6.6 step 8: the delivery record (what was delivered, on which base, under
   * which ref, with its manifest; `target`: the target branch it was built for).
   * It becomes the mission's current delivery unless a later delivery of the
   * mission already exists (deliveries are ordered by their first ref
   * authorization). One record per delivery: the same delivery recorded again
   * with the same commit, base and ref returns the first record's revision; with
   * another, FACT_CONFLICT (a delivery ref is never re-pointed).
   */
  async recordDelivery(input: {
    op: string;
    mission: MissionId;
    delivery: string;
    commit: string;
    base: string;
    ref: string;
    manifest: ContentHash;
    target?: string | null;
    /** The bound transform description (7.1), in the content store. */
    description?: ContentHash | null;
  }): Promise<{ revision: Revision }> {
    this.db();
    const req = this.freeze(input);
    const prior = this.priorReceipt<{ revision: Revision }>(req.op, null, req);
    if (prior !== undefined) return prior;
    this.failFast();
    const description = req.description ?? null;
    if (description !== null && (typeof description !== 'string' || !CONTENT_HASH.test(description))) throw new LedgerError('RECORD_INVALID', 'description is a content hash or null');
    const v = await this.verifier.verifyRecords([], description === null ? [req.manifest] : [req.manifest, description]);
    return this.enqueue(PRIORITY_NORMAL, 'recordDelivery', () =>
      this.write((s) =>
        this.idempotent(s, req.op, null, req, () => {
          this.verifier.requireBlob(req.manifest, v);
          if (description !== null) this.verifier.requireBlob(description, v);
          if (!isOid(req.commit) || !isOid(req.base)) throw new LedgerError('RECORD_INVALID', 'commit and base must be git object ids');
          if (typeof req.ref !== 'string' || !req.ref.startsWith('refs/mission-pipeline/')) throw new LedgerError('RECORD_INVALID', 'delivery refs live under refs/mission-pipeline/');
          if (typeof req.mission !== 'string' || typeof req.delivery !== 'string' || req.delivery === '') throw new LedgerError('RECORD_INVALID', 'a delivery record names its mission and delivery');
          const target = req.target ?? null;
          if (target !== null && (typeof target !== 'string' || target === '')) throw new LedgerError('RECORD_INVALID', 'target is a branch name or null');
          const own = deliveryInfo(s, req.mission, req.delivery);
          if (own !== null && own.recordedRev !== null) {
            if (own.commit === req.commit && own.base === req.base && own.ref === req.ref) return { revision: own.recordedRev };
            throw new LedgerError('FACT_CONFLICT', `delivery ${req.delivery} of mission ${req.mission} is recorded with commit ${own.commit}, base ${own.base}, ref ${own.ref}; a delivery is never re-pointed`);
          }
          return {
            revision: this.emit(
              s,
              {
                kind: 'delivery.recorded',
                mission: req.mission,
                delivery: req.delivery,
                commit: req.commit,
                base: req.base,
                ref: req.ref,
                manifest: req.manifest,
                ...(target !== null ? { target } : {}),
                ...(description !== null ? { description } : {}),
              },
              req.op,
            ),
          };
        }),
      ),
    );
  }

  /**
   * The user withdrew a delivery (6.6 "用户撤回过交付的除外"; the authorization's
   * "没有被取消"): it is never current again, so no landing or ref creation of it
   * is authorized (DELIVERY_NOT_CURRENT). Earlier deliveries stay superseded.
   * Unknown deliveries are refused (BAD_REQUEST); an already withdrawn one is
   * left as is (`revision: null`).
   */
  async withdrawDelivery(input: { op: string; mission: MissionId; delivery: string; reason: string }): Promise<{ revision: Revision | null }> {
    this.db();
    const req = this.freeze(input);
    const prior = this.priorReceipt<{ revision: Revision | null }>(req.op, null, req);
    if (prior !== undefined) return prior;
    this.failFast();
    if (typeof req.reason !== 'string' || req.reason === '' || Buffer.byteLength(req.reason, 'utf8') > 4096) throw new LedgerError('BAD_REQUEST', 'a withdrawal carries a reason of 1 to 4096 bytes');
    return this.enqueue(PRIORITY_NORMAL, 'withdrawDelivery', () =>
      this.write((s) =>
        this.idempotent(s, req.op, null, req, () => {
          const own = deliveryInfo(s, req.mission, req.delivery);
          if (own === null) throw new LedgerError('BAD_REQUEST', `mission ${req.mission} has no delivery ${req.delivery}`);
          if (own.state === 'withdrawn') return { revision: null };
          return { revision: this.emit(s, { kind: 'delivery.withdrawn', mission: req.mission, delivery: req.delivery, reason: req.reason }, req.op) };
        }),
      ),
    );
  }

  /** One delivery of a mission, or null. */
  deliveryInfo(mission: MissionId, delivery: string): DeliveryInfo | null {
    return deliveryInfo(this.db(), mission, delivery);
  }

  /** The mission's current delivery (the latest recorded one; landable only while `state` is `recorded`), or null. */
  currentDelivery(mission: MissionId): DeliveryInfo | null {
    return currentDelivery(this.db(), mission);
  }

  // ------------------------------------------------------------ stops (6.4)

  private activeStopScopes(s: Store): StopScope[] {
    const rows = s.stmt("SELECT scope FROM stops WHERE state = 'active'").all() as Array<{ scope: string }>;
    return rows.map((r) => JSON.parse(r.scope) as StopScope);
  }

  private stoppedFor(s: Store, tag: ScopeTag): boolean {
    return this.activeStopScopes(s).some((scope) => stopCovers(scope, tag));
  }

  private commitStop(s: Store, req: StopRequest): boolean {
    if (s.stmt('SELECT 1 FROM stops WHERE stop = ?').get(req.stop)) return false;
    this.emit(s, { kind: 'stop.committed', stop: req.stop, scope: req.scope, words: req.words, at: req.at }, null);
    return true;
  }

  /**
   * Commit stop requests in one transaction (deduplicated by stop id, the first
   * copy kept), then mark them committed in the control plane: the probes and the
   * shutdown sequence read "no uncommitted stop in staging" from there.
   */
  private commitRequests(reqs: readonly StopRequest[]): StopId[] {
    if (reqs.length === 0) return [];
    const seen = new Set<string>();
    const unique = reqs.filter((r) => !seen.has(r.stop) && seen.add(r.stop));
    const ids = this.write((s) => unique.filter((r) => this.commitStop(s, r)).map((r) => r.stop));
    try {
      this.control?.markCommitted(unique.map((r) => r.stop), this.now());
    } catch {
      /* the probes then see the staging copy as not yet committed: conservative */
    }
    return ids;
  }

  private rememberSpool(files: ReadonlyArray<{ name: string; request: StopRequest | null }>): void {
    for (const f of files) {
      if (this.spoolSeen.size > 100_000) this.spoolSeen.clear();
      this.spoolSeen.add(f.name);
    }
  }

  /** New stop slots of this boot (control-plane allocations) and pending ones whose writer reported "written". */
  private slotsToRead(): Map<InboxName, Array<{ id: number; slot: number }>> {
    const out = new Map<InboxName, Array<{ id: number; slot: number }>>();
    if (this.control === null || this.boot === null) return out;
    try {
      for (const a of this.control.allocations(this.boot, this.allocCursor, 'stop')) {
        this.pendingSlots.set(a.id, { inbox: a.inbox, slot: a.slot });
        this.allocCursor = Math.max(this.allocCursor, a.id);
      }
      if (this.pendingSlots.size === 0) return out;
      const written = new Set((this.control.db.prepare("SELECT id FROM slots WHERE state = 'written' AND kind = 'stop' AND boot = ?").all(this.boot) as Array<{ id: number }>).map((r) => Number(r.id)));
      for (const [id, p] of this.pendingSlots) {
        if (!written.has(id)) continue;
        const list = out.get(p.inbox) ?? [];
        list.push({ id, slot: p.slot });
        out.set(p.inbox, list);
      }
    } catch {
      /* the control plane is unreadable: the staging copy still carries the stops */
    }
    return out;
  }

  private inboxHeader(name: InboxName): { file: string; header: InboxHeader } | null {
    const i = this.inboxes.find((x) => x.name === name);
    if (!i) return null;
    if (i.header === null) {
      try {
        i.header = readHeader(i.file);
      } catch {
        return null;
      }
    }
    return { file: i.file, header: i.header };
  }

  private takeSlots(name: InboxName, list: ReadonlyArray<{ id: number; slot: number }>, read: Map<number, SlotContent>): StopRequest[] {
    const out: StopRequest[] = [];
    for (const { id, slot } of list) {
      const got = stopOf(read.get(slot) ?? { state: 'empty' });
      if (got.length > 0) {
        out.push(...got);
        this.pendingSlots.delete(id);
      }
    }
    void name;
    return out;
  }

  /** Synchronous drain: right after a storage recovery, before any other request. */
  private drainStopsNow(): StopId[] {
    const reqs: StopRequest[] = [];
    const staged = stagedStops(this.paths.controlPlane);
    reqs.push(...staged);
    for (const [name, list] of this.slotsToRead()) {
      const h = this.inboxHeader(name);
      if (h === null) continue;
      try {
        reqs.push(...this.takeSlots(name, list, readSlotsSync(h.file, h.header, list.map((x) => x.slot))));
      } catch {
        /* unreadable now: retried by the next drain */
      }
    }
    return this.commitRequests(reqs);
  }

  /** One drain of the running service: read outside the queue, commit as a stop-priority action. */
  private async drainOnce(): Promise<StopId[]> {
    const spool = await stagedStopsAsync(this.paths.controlPlane, (name) => this.spoolSeen.has(name));
    const reqs: StopRequest[] = spool.flatMap((f) => (f.request ? [f.request] : []));
    for (const [name, list] of this.slotsToRead()) {
      const h = this.inboxHeader(name);
      if (h === null) continue;
      try {
        reqs.push(...this.takeSlots(name, list, await readSlotsAsync(h.file, h.header, list.map((x) => x.slot))));
      } catch {
        /* unreadable now: retried by the next drain */
      }
    }
    if (reqs.length === 0) {
      this.rememberSpool(spool);
      return [];
    }
    const ids = await this.enqueue(PRIORITY_STOP, 'drainStops', () => this.commitRequests(reqs));
    this.rememberSpool(spool);
    return ids;
  }

  /** Commit stops that arrived through the inboxes or the staging copy. Runs ahead of normal requests. */
  drainStops(): Promise<StopId[]> {
    return this.drainOnce();
  }

  /**
   * The ledger's part of a clean shutdown (v45 6.1 step 3): commit the staging
   * copy and every stop slot of this boot, then report whether the staging copy
   * holds no uncommitted stop. The caller records the exit (shutdown.ts
   * recordLedgerExit) and closes the service.
   */
  async shutdownDrain(): Promise<{ stagingEmpty: boolean }> {
    this.spoolSeen.clear(); // read the whole staging copy once more
    await this.drainOnce();
    if (this.fault || this.store === null) return { stagingEmpty: false };
    const staged = stagedStops(this.paths.controlPlane);
    const db = this.db();
    const stagingEmpty = staged.every((r) => Boolean(db.stmt('SELECT 1 FROM stops WHERE stop = ?').get(r.stop)));
    if (stagingEmpty) {
      try {
        this.control?.markCommitted(staged.map((r) => r.stop), this.now());
      } catch {
        return { stagingEmpty: false };
      }
    }
    return { stagingEmpty };
  }

  /** The boot id this service opened with. */
  get bootIdValue(): string | null {
    return this.boot;
  }

  private kickDrain(): void {
    if (this.store === null || this.fault) return;
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    void (async () => {
      try {
        do {
          this.drainAgain = false;
          await this.drainOnce();
        } while (this.drainAgain && this.store !== null && !this.fault);
      } catch {
        /* storage fault or closed: the probe or the next poll repeats the drain */
      } finally {
        this.draining = false;
      }
    })();
  }

  /** Something new for the drain: a staging file not seen yet, a new stop slot, or a pending slot now written. */
  private async stopsWaiting(): Promise<boolean> {
    if (this.control !== null && this.boot !== null) {
      try {
        if (this.control.maxAllocationId(this.boot, 'stop') > this.allocCursor) return true;
        if (this.pendingSlots.size > 0 && this.slotsToRead().size > 0) return true;
      } catch {
        /* fall through to the staging copy */
      }
    }
    return (await stagedStopsAsync(this.paths.controlPlane, (name) => this.spoolSeen.has(name))).length > 0;
  }

  /**
   * The running service picks up stops (6.1 "正常时取走并提交，数秒内提交"): it
   * watches the control-plane signal and the staging copy, and polls every
   * `pollMs` (at most 500 ms) for new inbox slots and anything an event missed.
   * Each trigger runs a stop-priority drain.
   */
  watchStops(opts: { pollMs?: number } = {}): void {
    if (this.watching !== null || this.store === null) return;
    const pollMs = Math.max(10, Math.min(opts.pollMs ?? 250, 500));
    const watchers: FSWatcher[] = [];
    const add = (dir: string, accept: (f: string | null) => boolean): void => {
      try {
        const w = watch(dir, { persistent: false }, (_e, f) => {
          if (accept(f === null ? null : String(f))) this.kickDrain();
        });
        w.on('error', () => undefined);
        watchers.push(w);
      } catch {
        /* the poll covers it */
      }
    };
    add(this.paths.controlPlane, (f) => f === null || f.includes('stop'));
    add(spoolDir(this.paths), () => true);
    const timer = setInterval(() => {
      if (this.store === null || this.fault || this.draining) return;
      this.stopsWaiting().then(
        (waiting) => {
          if (waiting) this.kickDrain();
        },
        () => undefined,
      );
    }, pollMs);
    timer.unref();
    this.watching = { watchers, timer };
    this.kickDrain();
  }

  unwatchStops(): void {
    if (this.watching === null) return;
    for (const w of this.watching.watchers) w.close();
    clearInterval(this.watching.timer);
    this.watching = null;
  }

  stop(req: StopRequest): Promise<boolean> {
    const parsed = parseStopRequest(JSON.stringify(req ?? null));
    if (parsed === null) return Promise.reject(new LedgerError('BAD_REQUEST', 'a stop request is { stop, scope: all | mission | capability, words, at }'));
    return this.enqueue(PRIORITY_STOP, 'stop', () => {
      const committed = this.write((s) => this.commitStop(s, parsed));
      try {
        this.control?.markCommitted([parsed.stop], this.now());
      } catch {
        /* conservative: the probes keep the stop as uncommitted */
      }
      return committed;
    });
  }

  releaseStop(stop: StopId): Promise<{ released: boolean }> {
    return this.enqueue(PRIORITY_NORMAL, 'releaseStop', () => {
      const out = this.write((s) => {
        if (!s.stmt("SELECT 1 FROM stops WHERE stop = ? AND state = 'active'").get(stop)) return { released: false };
        this.emit(s, { kind: 'stop.released', stop }, null);
        return { released: true };
      });
      // After the commit: the spool readers that run without the ledger stop counting it (stagedStopsInForce).
      this.writeResolutions([stop]);
      return out;
    });
  }

  /**
   * Write the control-plane resolution marker of each released stop that has
   * none (`stops`: these; null: every released stop, at the start). The
   * commit comes first, so a crash in between only over-stops until the next
   * start. A marker that cannot be written is retried at the next start.
   */
  private writeResolutions(stops: readonly StopId[] | null): void {
    const s = this.store;
    if (s === null) return;
    try {
      const rows = stops === null ? (s.stmt("SELECT stop FROM stops WHERE state = 'released'").all() as Array<{ stop: string }>).map((r) => r.stop as StopId) : stops;
      for (const stop of rows) {
        const info = stopInfo(s, stop);
        if (info === null || info.state !== 'released' || readStopResolution(this.paths.controlPlane, stop) !== null) continue;
        const to = info.narrowedTo === null ? null : stopInfo(s, info.narrowedTo);
        writeStopResolution(
          this.paths.controlPlane,
          to === null ? { stop, state: 'released', at: this.now() } : { stop, state: 'narrowed', to: to.stop, scope: to.scope, at: this.now() },
        );
      }
    } catch {
      /* the control plane cannot be written (or the store read failed): the stop over-stops until the next start */
    }
  }

  /**
   * 6.4 "再收窄": replace an active stop by a narrower one in ONE transaction:
   * the new stop is committed (linked to the old one) and the old one released
   * (linked to the new one), so nothing in the narrower scope is unrestricted
   * at any moment and the link is never half-written. The new scope must lie
   * within the old one and differ from it. A retry after it committed returns
   * `narrowed: false` with the same links.
   */
  narrowStop(input: { old: StopId; stop: StopRequest }): Promise<{ old: StopId; stop: StopId; narrowed: boolean }> {
    const parsed = parseStopRequest(JSON.stringify(input?.stop ?? null));
    if (parsed === null) return Promise.reject(new LedgerError('BAD_REQUEST', 'the narrower stop is { stop, scope: all | mission | capability, words, at }'));
    const old = input.old;
    if (typeof old !== 'string' || old === parsed.stop) return Promise.reject(new LedgerError('BAD_REQUEST', 'narrowStop names the old stop, and a new stop id'));
    return this.enqueue(PRIORITY_STOP, 'narrowStop', () => {
      const out = this.write((s) => {
        const prev = stopInfo(s, old);
        const next = stopInfo(s, parsed.stop);
        if (next !== null) {
          if (next.narrows === old && prev?.narrowedTo === parsed.stop) return { old, stop: parsed.stop, narrowed: false };
          throw new LedgerError('FACT_CONFLICT', `stop ${parsed.stop} is already committed${next.narrows !== null ? ` (narrowing ${next.narrows})` : ''}`);
        }
        if (prev === null || prev.state !== 'active') throw new LedgerError('BAD_REQUEST', `stop ${old} is not an active stop`);
        if (!scopeWithin(parsed.scope, prev.scope)) throw new LedgerError('BAD_REQUEST', `the new scope ${canonicalJson(parsed.scope)} is not within the old scope ${canonicalJson(prev.scope)}`);
        if (canonicalJson(parsed.scope) === canonicalJson(prev.scope)) throw new LedgerError('BAD_REQUEST', 'the new scope is the old scope');
        this.emit(s, { kind: 'stop.committed', stop: parsed.stop, scope: parsed.scope, words: parsed.words, at: parsed.at, narrows: old }, null);
        this.emit(s, { kind: 'stop.released', stop: old, narrowedTo: parsed.stop }, null);
        return { old, stop: parsed.stop, narrowed: true };
      });
      try {
        this.control?.markCommitted([parsed.stop], this.now());
      } catch {
        /* conservative: the probes keep the stop as uncommitted */
      }
      this.writeResolutions([old]);
      return out;
    });
  }

  /** A committed stop with its narrowing links, or null. */
  stopInfo(stop: StopId): ReturnType<typeof stopInfo> {
    return stopInfo(this.db(), stop);
  }

  // ------------------------------------------------------------ recovery pause (6.1, WI-12)

  /** Work that could advance automatically (6.1): open missions, undecided launches, unsettled intents, queued tasks. Bounded probes. */
  private autoAdvancingWork(s: Store): StartupBasis['work'] {
    return {
      openMission: Boolean(s.stmt("SELECT 1 FROM missions WHERE state = 'open' LIMIT 1").get()),
      undecidedLaunch: Boolean(s.stmt('SELECT 1 FROM launches l WHERE NOT EXISTS (SELECT 1 FROM dispositions d WHERE d.launch = l.launch) LIMIT 1').get()),
      unsettledIntent: Boolean(s.stmt("SELECT 1 FROM intents WHERE state IN ('authorized', 'pending_verify') LIMIT 1").get()),
      queuedTask: Boolean(s.stmt("SELECT 1 FROM tasks WHERE state = 'queued' LIMIT 1").get()),
    };
  }

  /**
   * The PM's WI-12 decision to resume after the user answered (a recovery.pause
   * record, cleared). `answer`: the user's answer as the PM recorded it, kept
   * with the cleared pause (startupDecision().answer); `op`: the PM's operation
   * id (a retry returns the first result). Without a pause in force nothing is
   * recorded (`cleared: false`).
   */
  async confirmResume(input: { op?: string; answer?: string } = {}): Promise<{ cleared: boolean }> {
    this.db();
    const req = this.freeze(input ?? {});
    if (req.answer !== undefined && (typeof req.answer !== 'string' || req.answer === '' || Buffer.byteLength(req.answer, 'utf8') > 16 * 1024)) {
      throw new LedgerError('BAD_REQUEST', "the user's answer is 1 byte to 16 KiB of text");
    }
    if (req.op !== undefined && (typeof req.op !== 'string' || req.op === '')) throw new LedgerError('BAD_REQUEST', 'op is an operation id');
    if (req.op !== undefined) {
      const prior = this.priorReceipt<{ cleared: boolean }>(req.op, null, req);
      if (prior !== undefined) return prior;
    }
    return this.enqueue(PRIORITY_NORMAL, 'confirmResume', () =>
      this.write((s) => {
        const run = (): { cleared: boolean } => {
          if (s.getState('recovery_pause') === null) return { cleared: false };
          this.emit(
            s,
            { kind: 'recovery.pause', state: 'cleared', basis: null, ...(req.answer !== undefined ? { answer: req.answer } : {}), ...(req.op !== undefined ? { op: req.op } : {}) },
            req.op ?? null,
          );
          return { cleared: true };
        };
        return req.op !== undefined ? this.idempotent(s, req.op, null, req, run) : run();
      }),
    );
  }

  private assertNotPaused(s: Store, what: string): void {
    if (s.getState('recovery_pause') !== null) {
      throw new LedgerError('RECOVERY_PAUSED', `${what} is refused until the PM confirms resuming after an abnormal restart (WI-12)`);
    }
  }

  // ------------------------------------------------------------ generations and missions (6.3)

  private assertCurrent(s: Store, gen: Generation): void {
    if (gen !== currentGeneration(s)) {
      throw new LedgerError('STALE_GENERATION', `generation ${gen} is not the current scheduler generation`);
    }
  }

  beginGeneration(): Promise<Generation> {
    return this.enqueue(PRIORITY_NORMAL, 'beginGeneration', () =>
      this.write((s) => {
        const gen = currentGeneration(s) + 1;
        this.emit(s, { kind: 'generation.begun', gen }, null);
        return gen as Generation;
      }),
    );
  }

  setMission(mission: MissionId, state: 'open' | 'closed'): Promise<{ mission: MissionId; state: 'open' | 'closed' }> {
    // a mission is created by opening it: only ids that keep derived ids injective (review r1 #17)
    const bad = state === 'open' ? missionIdProblem(mission) : null;
    if (bad !== null) return Promise.reject(new LedgerError('BAD_REQUEST', bad));
    return this.enqueue(PRIORITY_NORMAL, 'setMission', () =>
      this.write((s) => {
        this.emit(s, { kind: 'mission.state', mission, state }, null);
        return { mission, state };
      }),
    );
  }

  /** Missions by state (default: the open ones). */
  missions(req: { state?: 'open' | 'closed' | 'all' } = {}): MissionInfo[] {
    return listMissions(this.db(), req?.state ?? 'open');
  }

  /**
   * 6.6 关闭: close a mission and freeze its closing snapshot, in one
   * transaction: a mission.close record (a new version on every close: a close
   * after repairs is a new snapshot) with the evaluator's published revision it
   * stands on (`asOf`), the mission's unfinished tasks at that moment (queued;
   * dispatched without a final disposition), and the caller's snapshot document
   * (proof states, risk list), if any; then the mission's state is closed. The
   * scheduler stops production on it (running units are cancelled unless
   * `waitRunning`); a full close (完整收尾) is registered as an operation that
   * needs "proven" separately (op.pending, 6.1).
   */
  async closeMission(input: {
    op: string;
    mission: MissionId;
    mode: 'with-risk' | 'full' | 'post-audit';
    waitRunning?: boolean;
    snapshot?: ContentHash | null;
  }): Promise<{ version: number; asOf: number; unfinished: ContentHash; revision: Revision }> {
    this.db();
    const req = this.freeze(input);
    const prior = this.priorReceipt<{ version: number; asOf: number; unfinished: ContentHash; revision: Revision }>(req.op, null, req);
    if (prior !== undefined) return prior;
    this.failFast();
    if (typeof req.mission !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(req.mission)) throw new LedgerError('BAD_REQUEST', 'mission is a mission id');
    if (!['with-risk', 'full', 'post-audit'].includes(req.mode)) throw new LedgerError('BAD_REQUEST', 'mode is with-risk, full or post-audit');
    if (req.waitRunning !== undefined && typeof req.waitRunning !== 'boolean') throw new LedgerError('BAD_REQUEST', 'waitRunning is a boolean');
    const snapshot = req.snapshot ?? null;
    if (snapshot !== null && (typeof snapshot !== 'string' || !CONTENT_HASH.test(snapshot))) throw new LedgerError('BAD_REQUEST', 'snapshot is a content hash or null');
    const v = snapshot === null ? emptyVerified() : await this.verifier.verifyRecords([], [snapshot]);
    // The unfinished list is read again in the transaction; its content goes to the store before (it is small: task ids).
    return this.enqueue(PRIORITY_NORMAL, 'closeMission', () =>
      this.write((s) =>
        this.idempotent(s, req.op, null, req, () => {
          if (snapshot !== null) this.verifier.requireBlob(snapshot, v);
          const queued = (s.stmt("SELECT task FROM tasks WHERE mission = ? AND state = 'queued' ORDER BY queued_rev").all(req.mission) as Array<{ task: string }>).map((r) => r.task);
          const running = (
            s
              .stmt(
                "SELECT t.task AS task, t.launch AS launch FROM tasks t WHERE t.mission = ? AND t.state = 'dispatched' AND t.launch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dispositions d WHERE d.launch = t.launch) ORDER BY t.queued_rev",
              )
              .all(req.mission) as Array<{ task: string; launch: string }>
          ).map((r) => ({ task: r.task, launch: r.launch }));
          const unfinished = this.content.put(canonicalJson({ mission: req.mission, queued, running }));
          const version = Number((s.stmt('SELECT COALESCE(MAX(version), 0) AS v FROM mission_closes WHERE mission = ?').get(req.mission) as { v: number }).v) + 1;
          const asOf = Number(s.getState('publication_floor') ?? '0');
          const revision = this.emit(
            s,
            { kind: 'mission.close', mission: req.mission, version, mode: req.mode, waitRunning: req.waitRunning ?? false, asOf, unfinished, snapshot },
            req.op,
          );
          this.emit(s, { kind: 'mission.state', mission: req.mission, state: 'closed' }, req.op);
          return { version, asOf, unfinished, revision };
        }),
      ),
    );
  }

  /** A mission's closing snapshots, oldest first. */
  missionCloses(mission: MissionId): MissionClose[] {
    return missionCloses(this.db(), mission);
  }

  // ------------------------------------------------------------ notices to the PM and the PM's actions (3.9, 3.11)

  /**
   * A notice's delivery state (3.9): delivered, then acknowledged (which
   * implies delivered); never back. Absent: undelivered. Marking a state already
   * reached records nothing (`changed: false`). `notice` is the notice's id as
   * the CLI lists it (an alert id or a notice id).
   */
  markNotice(req: { notice: string; state: 'delivered' | 'acknowledged' }): Promise<{ state: 'delivered' | 'acknowledged'; changed: boolean }> {
    if (!req || typeof req.notice !== 'string' || req.notice === '' || [...req.notice].length > 200 || /[\u0000-\u001f\u007f]/.test(req.notice)) {
      return Promise.reject(new LedgerError('BAD_REQUEST', 'notice is 1 to 200 printable characters'));
    }
    if (req.state !== 'delivered' && req.state !== 'acknowledged') return Promise.reject(new LedgerError('BAD_REQUEST', 'state is delivered or acknowledged'));
    return this.enqueue(PRIORITY_NORMAL, 'markNotice', () =>
      this.write((s) => {
        const cur = s.stmt('SELECT state FROM notice_deliveries WHERE notice = ?').get(req.notice) as { state: 'delivered' | 'acknowledged' } | undefined;
        if (cur?.state === 'acknowledged' || (cur?.state === 'delivered' && req.state === 'delivered')) return { state: cur.state, changed: false };
        this.emit(s, { kind: 'notice.delivery', notice: req.notice, state: req.state }, null);
        return { state: req.state, changed: true };
      }),
    );
  }

  /** Delivery states of the given notices (those absent are undelivered), or of every notice marked so far. */
  noticeDeliveries(req: { notices?: string[] } = {}): NoticeDelivery[] {
    return noticeDeliveries(this.db(), req?.notices);
  }

  /**
   * A PM action through the CLI (3.11 principle 3), by the PM's operation id
   * (`action`): `started` when the command begins (again after a failure),
   * then `done` or `failed` with its result. The same action id with another
   * command or other arguments is OP_CONFLICT; `done` is final (later marks
   * record nothing). `args` and `result` are stored as canonical JSON.
   */
  async recordPmAction(input: {
    action: string;
    command: string;
    args: unknown;
    wi?: string | null;
    state: 'started' | 'done' | 'failed';
    result?: unknown;
  }): Promise<{ state: 'started' | 'done' | 'failed'; revision: Revision | null }> {
    this.db();
    const req = this.freeze(input);
    if (typeof req.action !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(req.action)) throw new LedgerError('BAD_REQUEST', 'action is an operation id');
    if (typeof req.command !== 'string' || req.command === '' || req.command.length > 200) throw new LedgerError('BAD_REQUEST', 'command is 1 to 200 characters');
    if (!['started', 'done', 'failed'].includes(req.state)) throw new LedgerError('BAD_REQUEST', 'state is started, done or failed');
    const wi = req.wi ?? null;
    if (wi !== null && (typeof wi !== 'string' || !/^WI-\d{2,3}$/.test(wi))) throw new LedgerError('BAD_REQUEST', 'wi is a work instruction number (WI-nn) or null');
    this.failFast();
    const argsJson = canonicalJson({ command: req.command, args: req.args ?? null });
    const resultJson = req.state === 'started' ? null : canonicalJson(req.result ?? null);
    for (const j of [argsJson, resultJson]) if (j !== null && Buffer.byteLength(j, 'utf8') > MAX_DETAILS_BYTES) throw new LedgerError('TOO_LARGE', 'the action’s arguments or result are too large');
    const argsHash = sha256(argsJson);
    const args = await this.putContent(argsJson);
    const result = resultJson === null ? null : await this.putContent(resultJson);
    return this.enqueue(PRIORITY_NORMAL, 'recordPmAction', () =>
      this.write((s) => {
        const cur = pmAction(s, req.action);
        if (cur !== null && (cur.command !== req.command || cur.argsHash !== argsHash)) {
          throw new LedgerError('OP_CONFLICT', `PM action ${req.action} was recorded for another command or other arguments (${cur.command})`);
        }
        if (cur !== null && (cur.state === 'done' || (cur.state === req.state && (req.state === 'started' || cur.result === result)))) return { state: cur.state, revision: null };
        // An end without a recorded start (the start mark was lost) is recorded as it is.
        const revision = this.emit(s, { kind: 'pm.action', action: req.action, command: req.command, argsHash, args, wi, state: req.state, result }, null);
        return { state: req.state, revision };
      }),
    );
  }

  pmAction(action: string): PmAction | null {
    return pmAction(this.db(), action);
  }

  /** PM actions, most recently changed first (`before`: a revision to page back from). */
  pmActions(req: { limit?: number; before?: number } = {}): PmAction[] {
    return pmActions(this.db(), req ?? {});
  }

  // ------------------------------------------------------------ base records written by the program

  /**
   * Program-authored base records (PM/CLI requirement items, environment
   * registrations, pending operations, renewals, scheduler bookkeeping).
   * `gen` is required for scheduler writes; a stale generation is refused for
   * new operations (6.3). Kinds with their own entry points (executed
   * operations, proofs, spend, alerts, episode batches, cleanup) are refused here.
   */
  async appendRecords(req: { op: string; gen: Generation | null; records: readonly BaseRecord[] }): Promise<{ revisions: Revision[] }> {
    this.db();
    if (!Array.isArray(req.records)) throw new LedgerError('BAD_REQUEST', 'records is a list');
    this.sized(req.records.length);
    const records = this.freeze(req.records) as BaseRecord[];
    const prior = this.priorReceipt<{ revisions: Revision[] }>(req.op, null, { records });
    if (prior !== undefined) return prior;
    this.failFast();
    this.requestBytes(records);
    for (const r of records) this.checkShape(r, APPEND_KINDS, 'appendRecords');
    const v = await this.verifier.verifyRecords(records);
    return this.enqueue(PRIORITY_NORMAL, 'appendRecords', () =>
      this.write((s) =>
        this.idempotent(s, req.op, null, { records }, () => {
          if (req.gen !== null) this.assertCurrent(s, req.gen);
          for (const r of records) this.verifier.require(r, v);
          return { revisions: records.map((r) => this.appendFact(s, r, req.op, v)) };
        }),
      ),
    );
  }

  // ------------------------------------------------------------ launches, results, proofs, dispositions (6.2, 6.3, 7.1)

  registerLaunch(req: { op: string; gen: Generation; launch: LaunchId; tag: ScopeTag }): Promise<{ launch: LaunchId }> {
    return this.enqueue(PRIORITY_NORMAL, 'registerLaunch', () =>
      this.write((s) =>
        this.idempotent(s, req.op, req.launch, { launch: req.launch, tag: req.tag }, () => {
          this.assertNotPaused(s, 'dispatch');
          this.assertCurrent(s, req.gen);
          if (!req.tag || typeof req.tag.mission !== 'string' || !Array.isArray(req.tag.capabilities) || !req.tag.capabilities.every((c) => typeof c === 'string')) {
            throw new LedgerError('BAD_REQUEST', 'a launch needs its scope tag { mission, capabilities }');
          }
          if (this.stoppedFor(s, req.tag)) throw new LedgerError('STOPPED', 'a stop restriction covers this dispatch');
          if (s.stmt('SELECT 1 FROM launches WHERE launch = ?').get(req.launch)) throw new LedgerError('FACT_CONFLICT', `launch ${req.launch} exists`);
          this.emit(s, { kind: 'launch.registered', launch: req.launch, gen: req.gen, mission: req.tag.mission, capabilities: req.tag.capabilities }, req.op);
          return { launch: req.launch };
        }),
      ),
    );
  }

  private launchRow(s: Store, launch: LaunchId): { gen: number; tag: ScopeTag } {
    const row = s.stmt('SELECT gen, mission, capabilities FROM launches WHERE launch = ?').get(launch) as
      | { gen: number; mission: string; capabilities: string }
      | undefined;
    if (!row) throw new LedgerError('UNKNOWN_LAUNCH', `no launch ${launch}`);
    return { gen: row.gen, tag: { mission: row.mission as MissionId, capabilities: JSON.parse(row.capabilities) as string[] } };
  }

  private recognized(s: Store, launch: LaunchId, gen: number, launchGen: number): boolean {
    if (launchGen === gen) return true;
    return Boolean(s.stmt('SELECT 1 FROM adoptions WHERE launch = ? AND gen = ?').get(launch, gen));
  }

  private dispositionOf(s: Store, launch: LaunchId): Disposition | null {
    const row = s.stmt('SELECT disposition FROM dispositions WHERE launch = ?').get(launch) as { disposition: Disposition } | undefined;
    return row?.disposition ?? null;
  }

  /** A unit hands back its result: stored as pending, never accepted here (7.1). */
  async submitPendingResult(req: { op: string; launch: LaunchId; records: readonly BaseRecord[] }): Promise<{ pending: true }> {
    this.db();
    if (!Array.isArray(req.records)) throw new LedgerError('BAD_REQUEST', 'records is a list');
    this.sized(req.records.length);
    // The stored form is fixed now: what is verified is what is committed.
    const json = canonicalJson(req.records);
    const records = JSON.parse(json) as BaseRecord[];
    const prior = this.priorReceipt<{ pending: true }>(req.op, req.launch, records);
    if (prior !== undefined) return prior;
    this.failFast();
    this.requestBytes(records);
    for (const r of records) this.checkShape(r, PENDING_KINDS, 'submitPendingResult');
    const v = await this.verifier.verifyRecords(records);
    const hash = await this.putContent(json);
    return this.enqueue(PRIORITY_NORMAL, 'submitPendingResult', () =>
      this.write((s) =>
        this.idempotent(s, req.op, req.launch, records, () => {
          this.launchRow(s, req.launch);
          for (const r of records) this.verifier.require(r, v);
          this.txBlobs.set(hash, json);
          this.emit(s, { kind: 'result.pending', launch: req.launch, op: req.op, records: hash }, req.op);
          return { pending: true as const };
        }),
      ),
    );
  }

  private pendingRows(s: Store, launch: LaunchId): Array<{ op: string; records: BaseRecord[] }> {
    const rows = s.stmt('SELECT op, records FROM pending_results WHERE launch = ? ORDER BY submitted_at, op').all(launch) as Array<{ op: string; records: string }>;
    return rows.map((r) => ({ op: r.op, records: JSON.parse(r.records) as BaseRecord[] }));
  }

  /** Pending results of a launch, in submission order (the acceptance check reads the host's records from here). */
  pendingResults(launch: LaunchId): BaseRecord[] {
    return this.pendingRows(this.db(), launch).flatMap((r) => r.records);
  }

  /**
   * Register termination facts (7.1 step 4). Valid proofs are always registered,
   * idempotently, even after a final disposition, under a stop, or during a
   * recovery pause. Deterministic rejection only, each with its own code: an
   * unknown launch (PROOF_UNKNOWN_LAUNCH), a malformed payload
   * (PROOF_MALFORMED), or different content already registered for the launch
   * (PROOF_CONFLICT).
   */
  registerProof(proof: TerminationProofRecord): Promise<{ registered: 'new' | 'same' }> {
    return this.enqueue(PRIORITY_NORMAL, 'registerProof', () =>
      this.write((s) => {
        try {
          if ((proof as { kind?: unknown })?.kind !== 'termination.proof') throw new RecordInvalid('not a termination proof');
          validateRecord(proof);
        } catch (e) {
          throw new LedgerError('PROOF_MALFORMED', `malformed termination proof: ${(e as Error).message}`);
        }
        if (!s.stmt('SELECT 1 FROM launches WHERE launch = ?').get(proof.launch)) {
          throw new LedgerError('PROOF_UNKNOWN_LAUNCH', `no launch ${proof.launch}`);
        }
        const row = s.stmt('SELECT payload_hash FROM proofs WHERE launch = ?').get(proof.launch) as { payload_hash: string } | undefined;
        if (row) {
          if (row.payload_hash !== hashJson(proof)) throw new LedgerError('PROOF_CONFLICT', `a different proof is already registered for ${proof.launch}`);
          return { registered: 'same' as const };
        }
        this.emit(s, proof, null);
        return { registered: 'new' as const };
      }),
    );
  }

  /** Adopt a launch for the current generation, alive or by proof (6.3 takeover). */
  adopt(req: { gen: Generation; launch: LaunchId; via: 'alive' | 'proof' }): Promise<{ adopted: boolean }> {
    return this.enqueue(PRIORITY_NORMAL, 'adopt', () =>
      this.write((s) => {
        this.assertCurrent(s, req.gen);
        this.launchRow(s, req.launch);
        if (req.via !== 'alive' && req.via !== 'proof') throw new LedgerError('BAD_REQUEST', 'adoption is via alive or proof');
        if (req.via === 'proof' && !s.stmt('SELECT 1 FROM proofs WHERE launch = ?').get(req.launch)) {
          throw new LedgerError('PROOF_REQUIRED', `cannot adopt ${req.launch} by proof: no proof registered`);
        }
        if (s.stmt('SELECT 1 FROM adoptions WHERE launch = ? AND gen = ?').get(req.launch, req.gen)) return { adopted: false };
        this.emit(s, { kind: 'launch.adopted', launch: req.launch, gen: req.gen, via: req.via }, null);
        return { adopted: true };
      }),
    );
  }

  /**
   * The one final disposition of an attempt (6.3). The first committed wins; a
   * later call returns the existing disposition unchanged.
   *
   * accepted: pre-publication review (6.1): no active stop covers the launch's
   *   persisted scope, the launch is recognized by the current generation, a
   *   termination proof is registered, every pending record is still valid and
   *   everything it refers to exists with the right hash (verified before the
   *   request enters the queue), and it does not conflict with an existing fact.
   *   Then the pending results become base records, in one transaction with the
   *   disposition.
   * failed with reason 'no-proof': re-checked atomically here: refused if a proof
   *   has been registered meanwhile (6.3 证明对账入口 step 3).
   */
  async dispose(req: { gen: Generation; launch: LaunchId; disposition: Disposition; reason: string }): Promise<{ disposition: Disposition; changed: boolean; revisions: Revision[] }> {
    this.failFast();
    for (let attempt = 0; ; attempt++) {
      // The acceptance reads the material as it is now, never from the cache (core review r3 #2).
      let v: Verified = emptyVerified();
      let ops: string[] = [];
      if (req.disposition === 'accepted' && this.dispositionOf(this.db(), req.launch) === null) {
        const rows = this.pendingRows(this.db(), req.launch);
        ops = rows.map((r) => r.op);
        v = await this.verifier.verifyRecords(
          rows.flatMap((p) => p.records),
          [],
          { fresh: true },
        );
      }
      try {
        return await this.enqueue(PRIORITY_NORMAL, 'dispose', () => this.write((s) => this.disposeNow(s, req, v, ops)));
      } catch (e) {
        // A pending result arrived after the verification: verify again (at most twice).
        if (e instanceof LedgerError && e.code === 'STALE_REQUEST' && attempt < 2) continue;
        throw e;
      }
    }
  }

  private disposeNow(s: Store, req: { gen: Generation; launch: LaunchId; disposition: Disposition; reason: string }, v: Verified, verifiedOps: readonly string[]): { disposition: Disposition; changed: boolean; revisions: Revision[] } {
    this.assertCurrent(s, req.gen);
    const launch = this.launchRow(s, req.launch);
    const existing = this.dispositionOf(s, req.launch);
    if (existing) return { disposition: existing, changed: false, revisions: [] };
    if (!['accepted', 'failed', 'cancelled'].includes(req.disposition) || typeof req.reason !== 'string') {
      throw new LedgerError('BAD_REQUEST', 'a disposition is accepted, failed or cancelled, with a reason');
    }
    const hasProof = Boolean(s.stmt('SELECT 1 FROM proofs WHERE launch = ?').get(req.launch));
    const revisions: Revision[] = [];
    if (req.disposition === 'accepted') {
      this.assertNotPaused(s, 'accepting a result');
      // Quarantined, never restarted: the stop goes first (WI-15).
      if (this.stoppedFor(s, launch.tag)) throw new LedgerError('STOPPED', 'a stop restriction covers this launch', 'WI-15');
      if (!this.recognized(s, req.launch, req.gen, launch.gen)) {
        throw new LedgerError('UNRECOGNIZED_LAUNCH', `launch ${req.launch} is not recognized by generation ${req.gen}`);
      }
      if (!hasProof) throw new LedgerError('PROOF_REQUIRED', `no termination proof for ${req.launch}`);
      const rows = this.pendingRows(s, req.launch);
      if (canonicalJson(rows.map((r) => r.op)) !== canonicalJson(verifiedOps)) throw new LedgerError('STALE_REQUEST', `the pending results of ${req.launch} changed after they were verified`);
      for (const p of rows) {
        for (const r of p.records) {
          this.checkShape(r, PENDING_KINDS, 'dispose');
          this.verifier.require(r, v, { fresh: true });
          revisions.push(this.appendFact(s, r, p.op, v));
        }
      }
    } else if (req.disposition === 'failed' && req.reason === 'no-proof' && hasProof) {
      throw new LedgerError('PROOF_EXISTS', `a proof was registered for ${req.launch}; reconcile by proof instead`);
    }
    this.emit(s, { kind: 'disposition', launch: req.launch, disposition: req.disposition, reason: req.reason }, null);
    return { disposition: req.disposition, changed: true, revisions };
  }

  // ------------------------------------------------------------ cleanup (v35 7.1, 6.3, 6.4)

  /**
   * Record a launch's cleanup state. It only progresses: pending with the
   * remaining resources (never more than before) → done. Independent of the
   * final disposition.
   */
  async recordCleanup(input: { op: string; launch: LaunchId; state: 'pending' | 'done'; resources: ListRef }): Promise<{ state: 'pending' | 'done' }> {
    this.db();
    const req = this.freeze(input);
    const prior = this.priorReceipt<{ state: 'pending' | 'done' }>(req.op, req.launch, req);
    if (prior !== undefined) return prior;
    this.failFast();
    const rec: BaseRecord = { kind: 'cleanup.state', launch: req.launch, state: req.state, resources: req.resources };
    this.checkShape(rec, new Set(['cleanup.state']), 'recordCleanup');
    const v = await this.verifier.verifyRecords([rec]);
    return this.enqueue(PRIORITY_NORMAL, 'recordCleanup', () =>
      this.write((s) =>
        this.idempotent(s, req.op, req.launch, req, () => {
          this.launchRow(s, req.launch);
          this.verifier.require(rec, v);
          const resources = this.verifier.itemsOf(req.resources, v);
          const row = s.stmt('SELECT state, resources FROM cleanups WHERE launch = ?').get(req.launch) as { state: string; resources: string } | undefined;
          if (row) {
            if (row.state === 'done') {
              if (req.state === 'done') return { state: 'done' as const };
              throw new LedgerError('CLEANUP_REGRESSION', `cleanup of ${req.launch} is already done`);
            }
            const before = new Set(JSON.parse(row.resources) as string[]);
            if (!resources.every((x) => before.has(x))) throw new LedgerError('CLEANUP_REGRESSION', 'pending resources may only shrink');
          }
          this.txLists.set(req.resources.hash, resources);
          this.emit(s, rec, req.op);
          return { state: req.state };
        }),
      ),
    );
  }

  /** Launches whose cleanup is pending, with the remaining resources. */
  pendingCleanups(): Array<{ launch: LaunchId; resources: string[] }> {
    const rows = this.db().stmt("SELECT launch, resources FROM cleanups WHERE state = 'pending' ORDER BY updated_at").all() as Array<{ launch: string; resources: string }>;
    return rows.map((r) => ({ launch: r.launch as LaunchId, resources: JSON.parse(r.resources) as string[] }));
  }

  /** Launches with no cleanup state at all (the supervisor vanished before recording one). */
  launchesWithoutCleanup(): LaunchId[] {
    const rows = this.db().stmt('SELECT launch FROM launches l WHERE NOT EXISTS (SELECT 1 FROM cleanups c WHERE c.launch = l.launch) ORDER BY l.rowid').all() as Array<{ launch: string }>;
    return rows.map((r) => r.launch as LaunchId);
  }

  cleanupState(launch: LaunchId): 'pending' | 'done' | null {
    const row = this.db().stmt('SELECT state FROM cleanups WHERE launch = ?').get(launch) as { state: 'pending' | 'done' } | undefined;
    return row?.state ?? null;
  }

  // ------------------------------------------------------------ landing phases (6.6 step 7)

  /**
   * Persist a landing's phase before the phase starts (6.6: authorize, admit,
   * record pre-state, push, verify). `data` is the phase's facts (content
   * stored, hash logged). Phases only move forward; recording the current phase
   * again with the same data is a no-op.
   */
  async recordLandingPhase(input: { op: string; landing: string; intent: string | null; phase: string; data: unknown }): Promise<{ phase: string }> {
    const order = ['authorized', 'admitted', 'pre-state', 'push', 'verify', 'done', 'refused'];
    this.db();
    const req = this.freeze(input);
    const prior = this.priorReceipt<{ phase: string }>(req.op, null, req);
    if (prior !== undefined) return prior;
    this.failFast();
    const json = canonicalJson(req.data ?? null);
    if (Buffer.byteLength(json, 'utf8') > MAX_DETAILS_BYTES) throw new LedgerError('TOO_LARGE', 'landing phase data is too large');
    const data = await this.putContent(json);
    return this.enqueue(PRIORITY_NORMAL, 'recordLandingPhase', () =>
      this.write((s) =>
        this.idempotent(s, req.op, null, req, () => {
          if (!order.includes(req.phase)) throw new LedgerError('BAD_REQUEST', `unknown landing phase ${req.phase}`);
          const row = s.stmt('SELECT phase FROM landings WHERE landing = ?').get(req.landing) as { phase: string } | undefined;
          if (row && order.indexOf(req.phase) < order.indexOf(row.phase)) {
            throw new LedgerError('BAD_REQUEST', `landing ${req.landing} is at ${row.phase}; cannot go back to ${req.phase}`);
          }
          if (row && (row.phase === 'done' || row.phase === 'refused') && row.phase !== req.phase) {
            throw new LedgerError('BAD_REQUEST', `landing ${req.landing} already ended (${row.phase})`);
          }
          this.txBlobs.set(data, json);
          this.emit(s, { kind: 'landing.phase', landing: req.landing, intent: req.intent, phase: req.phase, data }, req.op);
          return { phase: req.phase };
        }),
      ),
    );
  }

  landingState(landing: string): { phase: string; intent: string | null; data: unknown } | null {
    const row = this.db().stmt('SELECT phase, intent, data FROM landings WHERE landing = ?').get(landing) as { phase: string; intent: string | null; data: string } | undefined;
    return row ? { phase: row.phase, intent: row.intent, data: JSON.parse(row.data) as unknown } : null;
  }

  /** Landings that started and have not ended (recovery input). */
  unfinishedLandings(): Array<{ landing: string; phase: string; intent: string | null }> {
    const rows = this.db().stmt("SELECT landing, phase, intent FROM landings WHERE phase NOT IN ('done', 'refused') ORDER BY updated_at").all() as Array<{
      landing: string;
      phase: string;
      intent: string | null;
    }>;
    return rows;
  }

  // ------------------------------------------------------------ external actions (6.1 外部动作的授权)

  /**
   * Authorize one external action. At most one authorized-and-unfinished action
   * per conflict domain. After a stop is committed, every authorization in its
   * scope is refused. An action on behalf of a unit names its launch, which must
   * be recognized by the current generation and not finally disposed; its scope
   * is the launch's persisted mission and capabilities, and a request tag that
   * differs is refused (SCOPE_MISMATCH, core review r2 F1).
   */
  async authorize(req: {
    op: string;
    gen: Generation | null;
    launch: LaunchId | null;
    intent: string;
    kind: string;
    domain: string;
    tag: ScopeTag;
    details: unknown;
  }): Promise<{ intent: string }> {
    this.db();
    const business = this.freeze({ launch: req.launch, intent: req.intent, kind: req.kind, domain: req.domain, tag: req.tag, details: req.details });
    const prior = this.priorReceipt<{ intent: string }>(req.op, req.launch, business);
    if (prior !== undefined) return prior;
    this.failFast();
    const detailsJson = canonicalJson(business.details ?? null);
    if (Buffer.byteLength(detailsJson, 'utf8') > MAX_DETAILS_BYTES) throw new LedgerError('TOO_LARGE', 'action details are too large');
    const claim = deliveryClaim(business.kind, business.details);
    const details = await this.putContent(detailsJson);
    const claimBlobs = claim.kind === 'claim' && business.kind === 'delivery-ref' ? [claim.d.manifest, claim.d.description].filter((h): h is ContentHash => h !== null) : [];
    const v = claimBlobs.length > 0 ? await this.verifier.verifyRecords([], claimBlobs) : emptyVerified();
    return this.enqueue(PRIORITY_NORMAL, 'authorize', () =>
      this.write((s) =>
        this.idempotent(s, req.op, req.launch, business, () => {
          this.assertNotPaused(s, 'authorizing an external action');
          if (req.gen !== null) this.assertCurrent(s, req.gen);
          let tag: ScopeTag = req.tag;
          if (req.launch !== null) {
            if (req.gen === null) throw new LedgerError('BAD_REQUEST', 'an action for a launch needs the scheduler generation');
            const l = this.launchRow(s, req.launch);
            if (!this.recognized(s, req.launch, req.gen, l.gen)) throw new LedgerError('UNRECOGNIZED_LAUNCH', `launch ${req.launch} is not recognized by generation ${req.gen}`);
            if (this.dispositionOf(s, req.launch) !== null) throw new LedgerError('UNRECOGNIZED_LAUNCH', `launch ${req.launch} already has a final disposition`);
            if (!req.tag || !sameTag(l.tag, req.tag)) {
              throw new LedgerError('SCOPE_MISMATCH', `the action's scope must be its launch's persisted scope (mission ${l.tag.mission}, capabilities ${JSON.stringify(l.tag.capabilities)})`);
            }
            tag = l.tag;
          }
          if (!tag || typeof tag.mission !== 'string' || !Array.isArray(tag.capabilities)) throw new LedgerError('BAD_REQUEST', 'an action needs its scope tag { mission, capabilities }');
          if (this.stoppedFor(s, tag)) throw new LedgerError('STOPPED', 'a stop restriction covers this action');
          // Git review r1 #11 (6.6 授权): a landing or a delivery ref only for the mission's current, not withdrawn delivery.
          const delivery = this.checkDelivery(s, req.kind, claim, tag, v);
          const busy = s.stmt("SELECT intent FROM intents WHERE domain = ? AND state IN ('authorized', 'pending_verify') LIMIT 1").get(req.domain) as
            | { intent: string }
            | undefined;
          if (busy) throw new LedgerError('DOMAIN_BUSY', `conflict domain ${req.domain} has unfinished action ${busy.intent}`);
          if (s.stmt('SELECT 1 FROM intents WHERE intent = ?').get(req.intent)) throw new LedgerError('FACT_CONFLICT', `intent ${req.intent} exists`);
          this.emit(
            s,
            {
              kind: 'intent.authorized',
              intent: req.intent,
              op: req.op,
              intentKind: req.kind,
              domain: req.domain,
              launch: req.launch,
              mission: tag.mission,
              capabilities: tag.capabilities,
              details,
              ...(delivery !== null ? { delivery } : {}),
            },
            req.op,
          );
          return { intent: req.intent };
        }),
      ),
    );
  }

  /**
   * 6.6 授权 ("确认这次交付仍是当前的、没有被取消"; git review r1 #11), in the
   * authorization's transaction:
   * - `landing`: `details.delivery` must be the mission's current delivery (the
   *   latest recorded one) with the same op, commit and base, the same target
   *   branch when one was recorded, and not withdrawn;
   * - `delivery-ref`: the delivery is being created, so it is not recorded yet:
   *   it must not be withdrawn, not superseded by a later delivery of the
   *   mission, and, if already recorded, recorded with this commit, base and ref.
   * Refusals are DELIVERY_NOT_CURRENT (WI-06, class A). Returns what the intent
   * stores (item 2: recovery reads the expected commit and ref from it).
   */
  private checkDelivery(s: Store, kind: string, claim: DeliveryClaim, tag: ScopeTag, v: Verified): IntentDelivery | null {
    if (claim.kind === 'none') return null;
    if (claim.kind === 'missing') {
      throw new LedgerError('DELIVERY_NOT_CURRENT', `a ${kind} action names no delivery (details.delivery): the ledger cannot confirm it is the current one`);
    }
    const d = claim.d;
    if (d.mission !== tag.mission) throw new LedgerError('SCOPE_MISMATCH', `the delivery's mission ${d.mission} is not the action's mission ${tag.mission}`);
    const own = deliveryInfo(s, d.mission, d.op);
    if (own !== null && own.state === 'withdrawn') {
      throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} of mission ${d.mission} was withdrawn (${own.withdrawnReason ?? ''})`);
    }
    if (kind === 'landing') {
      const cur = currentDelivery(s, d.mission);
      if (cur === null) throw new LedgerError('DELIVERY_NOT_CURRENT', `no delivery of mission ${d.mission} is recorded`);
      if (cur.delivery !== d.op) {
        throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} is not current: the mission's latest recorded delivery is ${cur.delivery}${cur.state === 'withdrawn' ? ' (withdrawn)' : ''}`);
      }
      if (cur.state === 'withdrawn') throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} of mission ${d.mission} was withdrawn (${cur.withdrawnReason ?? ''})`);
      if (cur.commit !== d.commit || cur.base !== d.base) {
        throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} is recorded with commit ${cur.commit} on base ${cur.base}, not commit ${d.commit} on base ${d.base}`);
      }
      if (d.ref !== null && d.ref !== cur.ref) throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} is recorded under ${cur.ref}, not ${d.ref}`);
      if (cur.target !== null && d.targetBranch !== cur.target) {
        throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} was built for target branch ${cur.target}, not ${d.targetBranch ?? '(none named)'}`);
      }
      return { mission: d.mission, op: d.op, commit: cur.commit, base: cur.base, ref: cur.ref, targetBranch: d.targetBranch ?? cur.target, manifest: cur.manifest, description: cur.description ?? d.description };
    }
    // delivery-ref
    if (d.ref === null) throw new LedgerError('BAD_REQUEST', 'a delivery-ref action names its ref (details.delivery.ref)');
    if (own !== null) {
      if (own.recordedRev !== null && (own.commit !== d.commit || own.base !== d.base || own.ref !== d.ref)) {
        throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} is already recorded with commit ${own.commit} on base ${own.base} under ${own.ref}; a recorded delivery is never re-pointed`);
      }
      const later = laterDelivery(s, d.mission, d.op, own.seq);
      if (later !== null) throw new LedgerError('DELIVERY_NOT_CURRENT', `delivery ${d.op} is superseded by the mission's later delivery ${later.delivery} (${later.state})`);
    }
    if (d.manifest !== null) this.verifier.requireBlob(d.manifest, v);
    if (d.description !== null) this.verifier.requireBlob(d.description, v);
    return { mission: d.mission, op: d.op, commit: d.commit, base: d.base, ref: d.ref, targetBranch: d.targetBranch, manifest: d.manifest, description: d.description };
  }

  /** The action timed out: its outcome must be verified once the executor has exited (6.1). */
  markIntentPendingVerify(intent: string, executor: { pid: number; startTime: string; bootId: string }): Promise<{ state: IntentState | null }> {
    return this.enqueue(PRIORITY_NORMAL, 'markIntentPendingVerify', () =>
      this.write((s) => {
        if (this.intentStateOf(s, intent) === 'authorized') this.emit(s, { kind: 'intent.state', intent, state: 'pending_verify', executor }, null);
        return { state: this.intentStateOf(s, intent) };
      }),
    );
  }

  /**
   * Finish an action. An action awaiting verification is released only with the
   * caller's explicit statement that its executor (recorded pid, start time,
   * boot id) no longer exists and its outcome was verified (6.1: the domain is
   * not handed over before that).
   */
  finishIntent(
    intent: string,
    outcome: 'done' | 'failed',
    verified: { executorGone: boolean; outcomeVerified: boolean } | null = null,
  ): Promise<{ state: IntentState | null }> {
    return this.enqueue(PRIORITY_NORMAL, 'finishIntent', () =>
      this.write((s) => {
        if (outcome !== 'done' && outcome !== 'failed') throw new LedgerError('BAD_REQUEST', 'an action finishes done or failed');
        const state = this.intentStateOf(s, intent);
        if (state === 'pending_verify' && !(verified?.executorGone && verified.outcomeVerified)) {
          throw new LedgerError('VERIFY_REQUIRED', `intent ${intent} awaits verification: confirm its executor is gone and its outcome is verified`);
        }
        if (state === 'authorized' || state === 'pending_verify') this.emit(s, { kind: 'intent.state', intent, state: outcome, executor: verified }, null);
        return { state: this.intentStateOf(s, intent) };
      }),
    );
  }

  private intentStateOf(s: Store, intent: string): IntentState | null {
    const row = s.stmt('SELECT state FROM intents WHERE intent = ?').get(intent) as { state: IntentState } | undefined;
    return row?.state ?? null;
  }

  // ------------------------------------------------------------ derived-state publication (6.1)

  /**
   * Register a new evaluator instance for the current scheduler generation
   * (6.1: the evaluator belongs to the scheduler's generation; core review r2
   * F10). A caller from a stale generation is refused, so an old scheduler can
   * never displace the current evaluator. Only the latest epoch may publish.
   */
  beginEvaluator(req: { gen: Generation; identity: EvaluatorIdentity }): Promise<{ epoch: number }> {
    return this.enqueue(PRIORITY_NORMAL, 'beginEvaluator', () =>
      this.write((s) => {
        if (!req || typeof req !== 'object' || !Number.isSafeInteger(req.gen)) throw new LedgerError('BAD_REQUEST', 'beginEvaluator needs { gen, identity: { pid, startTime, bootId } }');
        const identity = checkIdentity(req.identity);
        this.assertCurrent(s, req.gen);
        const epoch = Number(s.getState('evaluator_epoch') ?? '0') + 1;
        this.emitJournal(s, { kind: 'evaluator.begun', epoch, gen: req.gen, identity }, null);
        return { epoch };
      }),
    );
  }

  /**
   * Publish revision `revision` (6.1): commit the update's episode batch (if
   * any) and raise the publication floor to `revision`, in one action, before
   * the evaluator shows the revision to readers. Refused for a stale epoch, an
   * epoch whose scheduler generation is no longer current, a revision beyond the
   * head, or one below the current floor. Raising the floor creates no revision
   * (it is a journal event).
   */
  async publish(req: { epoch: number; revision: Revision; batch: { batch: EpisodeBatchId; changes: ListRef } | null }): Promise<{ floor: Revision; batchRevision: Revision | null }> {
    this.failFast();
    const batch = req.batch ? this.freeze(req.batch) : null;
    const batchRec: BaseRecord | null = batch ? { kind: 'episode.batch', batch: batch.batch, publishes: req.revision, changes: batch.changes } : null;
    if (batchRec) this.checkShape(batchRec, new Set(['episode.batch']), 'publish');
    const v = batchRec ? await this.verifier.verifyRecords([batchRec]) : emptyVerified();
    return this.enqueue(PRIORITY_NORMAL, 'publish', () =>
      this.write((s) => {
        const epoch = Number(s.getState('evaluator_epoch') ?? '0');
        if (req.epoch !== epoch) throw new LedgerError('STALE_EVALUATOR', `evaluator epoch ${req.epoch} is not the current ${epoch}`);
        const egen = s.getState('evaluator_gen');
        const gen = currentGeneration(s);
        if (egen === null || Number(egen) !== gen) {
          throw new LedgerError('STALE_EVALUATOR', `evaluator epoch ${epoch} belongs to scheduler generation ${egen ?? 'none'}; the current generation is ${gen}`);
        }
        const head = s.head();
        if (!Number.isSafeInteger(req.revision) || req.revision > head) throw new LedgerError('BAD_REQUEST', `cannot publish ${req.revision} beyond head ${head}`);
        const floor = Number(s.getState('publication_floor') ?? '0');
        if (req.revision < floor) throw new LedgerError('STALE_PUBLICATION', `revision ${req.revision} is below the published ${floor}`);
        let batchRevision: Revision | null = null;
        if (batchRec) {
          this.verifier.require(batchRec, v);
          batchRevision = this.appendFact(s, batchRec, `episode-batch:${batch!.batch}`);
        }
        if (req.revision > floor) this.emitJournal(s, { kind: 'evaluator.published', epoch, revision: req.revision }, null);
        // A successful publication resets the failure budget in the same transaction (6.1; core review r3 #7).
        const h = this.health(s);
        if (h.failures !== 0) this.emitJournal(s, { kind: 'evaluator.health', failures: 0, fault: h.fault }, null);
        return { floor: req.revision, batchRevision };
      }),
    );
  }

  /** The scope a pending operation was registered with (F1). */
  private opScope(s: Store, op: OpId): ScopeTag | null {
    const row = s.stmt('SELECT mission, capabilities FROM op_scopes WHERE op = ?').get(op) as { mission: string; capabilities: string } | undefined;
    return row ? { mission: row.mission as MissionId, capabilities: JSON.parse(row.capabilities) as string[] } : null;
  }

  /**
   * Execute a proof-conditioned operation "as of revision R" (6.1). The
   * operation must have been registered as pending; R must be the latest
   * published revision (the floor), whose value the scheduler read; the scope
   * registered with the operation must not be stopped (a caller tag, if given,
   * must equal it: SCOPE_MISMATCH); an operation executes once.
   */
  async commitProofOp(req: { op: string; gen: Generation; opId: OpId; asOf: Revision; tag?: ScopeTag | null; events?: readonly BaseRecord[] }): Promise<{ revision: Revision }> {
    // `events`: flow events committed in the same transaction as the execution (src/flow/exploration/RECORDS-NEEDED.md:
    // the legalization stamp's `result` event goes with its op.executed). Only flow.event records.
    const events = req.events === undefined ? [] : (this.freeze(req.events) as BaseRecord[]);
    if (!Array.isArray(events)) throw new LedgerError('BAD_REQUEST', 'events is a list of flow.event records');
    this.sized(events.length);
    for (const r of events) this.checkShape(r, FLOW_EVENT_ONLY, 'commitProofOp');
    if (events.length > 0) this.requestBytes(events);
    const v = events.length > 0 ? await this.verifier.verifyRecords(events) : emptyVerified();
    const payload = { opId: req.opId, asOf: req.asOf, tag: req.tag ?? undefined, ...(events.length > 0 ? { events } : {}) };
    return this.enqueue(PRIORITY_NORMAL, 'commitProofOp', () => {
      const out = this.write((s) =>
        this.idempotent<{ revision: Revision } | { ended: 'derived-state-uncomputable' }>(s, req.op, null, payload, () => {
          this.assertNotPaused(s, 'a proof-conditioned operation');
          this.assertCurrent(s, req.gen);
          const scope = this.opScope(s, req.opId);
          if (scope === null) throw new LedgerError('NOT_PENDING', `operation ${req.opId} was never registered as pending`);
          if (s.stmt('SELECT 1 FROM op_ends WHERE op = ?').get(req.opId)) {
            throw new LedgerError('NOT_PENDING', `operation ${req.opId} ended because the derived state could not be computed; register it again under a new id (WI-11)`);
          }
          if (req.tag !== undefined && req.tag !== null && !sameTag(scope, req.tag)) {
            throw new LedgerError('SCOPE_MISMATCH', `operation ${req.opId} was registered with scope (mission ${scope.mission}, capabilities ${JSON.stringify(scope.capabilities)})`);
          }
          // 6.1, WI-11: while the derived state cannot be computed, the operation ends now
          // (recorded), instead of waiting or running on an old proof (core review r3 #3).
          if (this.health(s).fault !== null) {
            this.emit(s, { kind: 'op.ended', op: req.opId, reason: 'derived-state-uncomputable' }, req.op);
            return { ended: 'derived-state-uncomputable' as const };
          }
          const floor = Number(s.getState('publication_floor') ?? '0');
          if (floor === 0 || req.asOf !== floor) {
            throw new LedgerError('BELOW_FLOOR', `as-of revision ${req.asOf} is not the latest published revision ${floor}`);
          }
          if (this.stoppedFor(s, scope)) throw new LedgerError('STOPPED', 'a stop restriction covers this operation');
          const rec: BaseRecord = { kind: 'op.executed', op: req.opId, asOf: req.asOf };
          validateRecord(rec);
          if (this.hasFact(s, 'op.executed', req.opId)) throw new LedgerError('FACT_CONFLICT', `operation ${req.opId} was already executed`);
          for (const e of events) this.verifier.require(e, v);
          const revision = this.appendFact(s, rec, req.op);
          for (const e of events) this.appendFact(s, e, req.op, v);
          return { revision };
        }),
      );
      if ('ended' in out) throw new LedgerError('EVALUATOR_FAULT', `operation ${req.opId} ended: the derived state cannot be computed (6.1); register it again after the evaluator recovers`);
      return out;
    });
  }

  // ------------------------------------------------------------ spend (6.5)

  /** Set a mission's spend limit in micro-dollars; null is `unlimited` (the default). */
  setSpendLimit(req: { op: string; mission: MissionId; micros: number | null }): Promise<{ micros: number | null }> {
    return this.enqueue(PRIORITY_NORMAL, 'setSpendLimit', () =>
      this.write((s) =>
        this.idempotent(s, req.op, null, req, () => {
          const rec: BaseRecord = { kind: 'spend.limit', mission: req.mission, micros: req.micros };
          validateRecord(rec);
          this.emit(s, rec, req.op);
          return { micros: req.micros };
        }),
      ),
    );
  }

  /** Spent and in-flight amounts, kept per mission as running totals (bounded: no sum over history, F11). */
  private spendOf(s: Store, mission: MissionId): { limit: number | null; spent: number; inflight: number } {
    const lim = s.stmt('SELECT micros FROM spend_limits WHERE mission = ?').get(mission) as { micros: number | null } | undefined;
    const tot = s.stmt('SELECT spent, inflight FROM spend_totals WHERE mission = ?').get(mission) as { spent: number; inflight: number } | undefined;
    return { limit: lim?.micros ?? null, spent: Number(tot?.spent ?? 0), inflight: Number(tot?.inflight ?? 0) };
  }

  /**
   * The metering proxy reserves an upper bound before forwarding one model
   * request (6.5). With a limit, the reservation is refused unless
   * spent + in-flight reservations + this bound <= limit. A stopped or
   * finally-disposed launch makes no more requests.
   */
  reserveSpend(req: { op: string; reservation: ReservationId; launch: LaunchId; micros: number }): Promise<{ reserved: true }> {
    return this.enqueue(PRIORITY_NORMAL, 'reserveSpend', () =>
      this.write((s) =>
        this.idempotent(s, req.op, req.launch, req, () => {
          if (!Number.isSafeInteger(req.micros) || req.micros < 0) throw new LedgerError('BAD_REQUEST', 'bad amount');
          const launch = this.launchRow(s, req.launch);
          if (this.stoppedFor(s, launch.tag)) throw new LedgerError('STOPPED', 'a stop restriction covers this launch');
          if (this.dispositionOf(s, req.launch) !== null) throw new LedgerError('UNRECOGNIZED_LAUNCH', `launch ${req.launch} already has a final disposition`);
          if (s.stmt('SELECT 1 FROM spend WHERE reservation = ?').get(req.reservation)) throw new LedgerError('FACT_CONFLICT', `reservation ${req.reservation} exists`);
          const mission = launch.tag.mission;
          const cur = this.spendOf(s, mission);
          if (cur.limit !== null && cur.spent + cur.inflight + req.micros > cur.limit) {
            throw new LedgerError('SPEND_LIMIT', `spent ${cur.spent} + in flight ${cur.inflight} + ${req.micros} exceeds ${cur.limit}`);
          }
          const rec: BaseRecord = { kind: 'spend.reserve', reservation: req.reservation, mission, launch: req.launch, micros: req.micros };
          validateRecord(rec);
          this.emit(s, rec, req.op);
          return { reserved: true as const };
        }),
      ),
    );
  }

  /** Settle a reservation by the response's usage (6.5). Settling twice is refused. */
  settleSpend(req: { op: string; reservation: ReservationId; micros: number }): Promise<{ settled: number }> {
    return this.enqueue(PRIORITY_NORMAL, 'settleSpend', () =>
      this.write((s) =>
        this.idempotent(s, req.op, null, req, () => {
          if (!Number.isSafeInteger(req.micros) || req.micros < 0) throw new LedgerError('BAD_REQUEST', 'bad amount');
          const row = s.stmt('SELECT settled FROM spend WHERE reservation = ?').get(req.reservation) as { settled: number | null } | undefined;
          if (!row) throw new LedgerError('BAD_REQUEST', `no reservation ${req.reservation}`);
          if (row.settled !== null) throw new LedgerError('ALREADY_SETTLED', `reservation ${req.reservation} is settled`);
          this.emit(s, { kind: 'spend.settle', reservation: req.reservation, micros: req.micros, how: 'usage' }, req.op);
          return { settled: req.micros };
        }),
      ),
    );
  }

  /**
   * The host or proxy died with requests in flight: settle every open
   * reservation of the launch at the reserved amount (6.5). Returns how many.
   */
  settleLaunchAtReservation(req: { op: string; launch: LaunchId }): Promise<{ settled: number }> {
    return this.enqueue(PRIORITY_NORMAL, 'settleLaunchAtReservation', () =>
      this.write((s) =>
        this.idempotent(s, req.op, null, req, () => {
          const open = s.stmt('SELECT reservation, reserved FROM spend WHERE launch = ? AND settled IS NULL ORDER BY reservation').all(req.launch) as Array<{
            reservation: string;
            reserved: number;
          }>;
          for (const r of open) this.emit(s, { kind: 'spend.settle', reservation: r.reservation as ReservationId, micros: r.reserved, how: 'reservation' }, req.op);
          return { settled: open.length };
        }),
      ),
    );
  }

  spendSummary(mission: MissionId): { limit: number | null; spent: number; inflight: number } {
    return this.spendOf(this.db(), mission);
  }

  // ------------------------------------------------------------ system alerts (3.9)

  /** An alert names its WI (3.11), or is a notice that is not an exception (`informational: true`, core review r3 #18). */
  async raiseAlert(input: { op: string; alert: AlertId; category: string; wi?: string; informational?: true; body: ContentHash }): Promise<{ revision: Revision }> {
    this.db();
    const req = this.freeze(input);
    const prior = this.priorReceipt<{ revision: Revision }>(req.op, null, req);
    if (prior !== undefined) return prior;
    this.failFast();
    const rec: BaseRecord = {
      kind: 'alert',
      alert: req.alert,
      category: req.category,
      ...(req.wi !== undefined ? { wi: req.wi } : {}),
      ...(req.informational === true ? { informational: true as const } : {}),
      body: req.body,
    };
    try {
      validateRecord(rec);
    } catch (e) {
      if (e instanceof RecordInvalid) throw new LedgerError('RECORD_INVALID', e.message);
      throw e;
    }
    const v = await this.verifier.verifyRecords([], [req.body]);
    return this.enqueue(PRIORITY_NORMAL, 'raiseAlert', () =>
      this.write((s) =>
        this.idempotent(s, req.op, null, req, () => {
          this.verifier.requireBlob(req.body, v);
          return { revision: this.emit(s, rec, req.op) };
        }),
      ),
    );
  }

  // ------------------------------------------------------------ evaluator health (6.1)

  private health(s: Store): { failures: number; fault: string | null } {
    const fault = s.getState('evaluator_fault') ?? '';
    return { failures: Number(s.getState('evaluator_failures') ?? '0'), fault: fault === '' ? null : fault };
  }

  /** Enter the "derived state cannot be computed" fault: no more restarts until the user retries. */
  setEvaluatorFault(reason: string, req: { gen?: Generation } = {}): Promise<void> {
    return this.enqueue(PRIORITY_NORMAL, 'setEvaluatorFault', () =>
      this.write((s) => {
        if (typeof reason !== 'string' || reason.length === 0) throw new LedgerError('BAD_REQUEST', 'an evaluator fault needs a reason');
        if (req.gen !== undefined) this.assertCurrent(s, req.gen);
        this.emitJournal(s, { kind: 'evaluator.health', failures: this.health(s).failures, fault: reason }, null);
      }),
    );
  }

  /** A user-initiated retry clears the fault and the failure budget (6.1). */
  clearEvaluatorFault(): Promise<void> {
    return this.enqueue(PRIORITY_NORMAL, 'clearEvaluatorFault', () =>
      this.write((s) => {
        const h = this.health(s);
        if (h.failures !== 0 || h.fault !== null) this.emitJournal(s, { kind: 'evaluator.health', failures: 0, fault: null }, null);
      }),
    );
  }

  evaluatorHealth(): { failures: number; fault: string | null } {
    return this.health(this.db());
  }

  /**
   * Evaluator failure budget, accumulated since the last successful publication
   * (6.1). With `op` (one id per failure, e.g. "evaluator-failure:<epoch>:<pid>"),
   * a retried call returns the original count and does not count twice.
   */
  recordEvaluatorFailure(req: { op?: string; gen?: Generation } = {}): Promise<number> {
    return this.enqueue(PRIORITY_NORMAL, 'recordEvaluatorFailure', () =>
      this.write((s) => {
        // A supervisor of a superseded scheduler generation cannot change the budget (core review r3 #7).
        if (req.gen !== undefined) this.assertCurrent(s, req.gen);
        const count = (): number => {
          const h = this.health(s);
          const n = h.failures + 1;
          this.emitJournal(s, { kind: 'evaluator.health', failures: n, fault: h.fault }, req.op ?? null);
          return n;
        };
        if (req.op === undefined) return count();
        if (typeof req.op !== 'string' || req.op.length === 0) throw new LedgerError('BAD_REQUEST', 'an evaluator failure op is a non-empty string');
        return this.idempotent(s, req.op, null, { evaluatorFailure: true }, count);
      }),
    );
  }

  /**
   * A successful publication resets the budget: `publish` does it in its own
   * transaction (core review r3 #7), so this is only for callers that report
   * success separately. It is refused from an evaluator that is not current: an
   * older epoch, or an evaluator whose scheduler generation was superseded.
   */
  recordEvaluatorSuccess(req: { epoch?: number } = {}): Promise<void> {
    return this.enqueue(PRIORITY_NORMAL, 'recordEvaluatorSuccess', () =>
      this.write((s) => {
        const epoch = s.getState('evaluator_epoch');
        const egen = s.getState('evaluator_gen');
        if (req.epoch !== undefined && Number(epoch ?? '0') !== req.epoch) throw new LedgerError('STALE_EVALUATOR', `evaluator epoch ${req.epoch} is not the current ${epoch}`);
        if (egen !== null && Number(egen) !== currentGeneration(s)) throw new LedgerError('STALE_EVALUATOR', `the registered evaluator belongs to scheduler generation ${egen}, which is no longer current`);
        const h = this.health(s);
        if (h.failures !== 0) this.emitJournal(s, { kind: 'evaluator.health', failures: 0, fault: h.fault }, null);
      }),
    );
  }

  /** The evaluator registered last: its epoch, scheduler generation and process identity. */
  evaluatorInstance(): { epoch: number; gen: Generation; identity: EvaluatorIdentity } | null {
    const db = this.db();
    const epoch = db.getState('evaluator_epoch');
    const gen = db.getState('evaluator_gen');
    const identity = db.getState('evaluator_identity');
    if (epoch === null || gen === null || identity === null) return null;
    return { epoch: Number(epoch), gen: Number(gen) as Generation, identity: JSON.parse(identity) as EvaluatorIdentity };
  }

  // ------------------------------------------------------------ user words (10.1 item 6, WI-12)

  /**
   * Book one user message as the PM's prompt hook received it (用户原话). The
   * text goes to the content store; the record keeps its hash and an excerpt.
   * Written once per message id (a retry returns the original revision); never
   * refused by a stop or the recovery pause, so WI-12's check always has its
   * source.
   */
  async recordUserWords(req: { message: string; session: string; at: number; text: string }): Promise<{ revision: Revision }> {
    this.failFast();
    if (!req || typeof req.text !== 'string') throw new LedgerError('BAD_REQUEST', 'user words are { message, session, at, text }');
    if (Buffer.byteLength(req.text, 'utf8') > MAX_USER_WORDS_BYTES) throw new LedgerError('TOO_LARGE', `a user message is at most ${MAX_USER_WORDS_BYTES} bytes`);
    let excerpt = '';
    for (const ch of req.text) {
      if (excerpt.length + ch.length > 280) break;
      excerpt += ch;
    }
    const rec: BaseRecord = { kind: 'user.words', message: req.message, session: req.session, at: req.at, text: sha256(req.text), excerpt } satisfies UserWordsRecord;
    const op = `user-words:${req.message}`;
    const prior = this.priorReceipt<{ revision: Revision }>(op, null, rec);
    if (prior !== undefined) return prior;
    const kinds = new Set(['user.words']);
    this.checkShape(rec, kinds, 'recordUserWords');
    await this.putContent(req.text);
    const v = await this.verifier.verifyRecords([rec]);
    return this.enqueue(PRIORITY_NORMAL, 'recordUserWords', () =>
      this.write((s) =>
        this.idempotent(s, op, null, rec, () => {
          this.verifier.require(rec, v);
          return { revision: this.appendFact(s, rec, op) };
        }),
      ),
    );
  }

  /** The latest booked user messages, newest first (WI-12: the last booked user message). */
  latestUserWords(req: { limit?: number; session?: string } = {}): BookedUserWords[] {
    return latestUserWords(this.db(), req.limit ?? 1, req.session);
  }

  // ------------------------------------------------------------ continuation checks (5.2 part 5) and install state (9.6)

  /**
   * Record the evaluator's answer for a continuation judgment, obtained by the
   * scheduler at `revision` (it must be the latest published revision). The
   * judgment can then be committed while the answer holds (checkContinuation).
   */
  recordContinuationCheck(req: {
    op: string;
    gen: Generation;
    judgment: JudgmentId;
    extends: JudgmentId;
    target: string;
    revision: Revision;
    /** The evaluator's answer: on a pass, the inputs it merged (ContinuationResult.merged). */
    result: { ok: boolean; reason?: string | null; merged?: JudgmentInputs };
  }): Promise<{ revision: Revision }> {
    const ok = req.result?.ok === true;
    if (ok && !req.result.merged) return Promise.reject(new LedgerError('BAD_REQUEST', 'a passing continuation check carries the merged inputs the evaluator returned'));
    const rec: BaseRecord = {
      kind: 'continuation.check',
      judgment: req.judgment,
      extends: req.extends,
      target: req.target,
      revision: req.revision,
      ok,
      reason: ok ? null : String(req.result?.reason ?? 'refused'),
      inputs: ok ? continuationInputsHash(req.result.merged!) : null,
    };
    return this.enqueue(PRIORITY_NORMAL, 'recordContinuationCheck', () =>
      this.write((s) =>
        this.idempotent(s, req.op, null, rec, () => {
          this.assertCurrent(s, req.gen);
          this.checkShape(rec, new Set(['continuation.check']), 'recordContinuationCheck');
          if (this.hasFact(s, 'judgment', req.judgment)) throw new LedgerError('FACT_CONFLICT', `judgment ${req.judgment} is already committed`);
          const floor = Number(s.getState('publication_floor') ?? '0');
          if (req.revision !== floor) throw new LedgerError('BELOW_FLOOR', `the check answered at revision ${req.revision}; the latest published is ${floor}`);
          return { revision: this.emit(s, rec, req.op) };
        }),
      ),
    );
  }

  /** An installation fact, such as a degradation the user accepted (WI-18). */
  async recordInstallState(input: { op: string; item: string; value: string; accepted: boolean; by: 'user' | 'installer'; detail: ContentHash }): Promise<{ revision: Revision }> {
    this.db();
    const req = this.freeze(input);
    const rec: BaseRecord = { kind: 'install.state', item: req.item, value: req.value, accepted: req.accepted, by: req.by, detail: req.detail };
    const prior = this.priorReceipt<{ revision: Revision }>(req.op, null, rec);
    if (prior !== undefined) return prior;
    this.failFast();
    this.checkShape(rec, new Set(['install.state']), 'recordInstallState');
    const v = await this.verifier.verifyRecords([rec]);
    return this.enqueue(PRIORITY_NORMAL, 'recordInstallState', () =>
      this.write((s) =>
        this.idempotent(s, req.op, null, rec, () => {
          this.verifier.require(rec, v);
          return { revision: this.emit(s, rec, req.op) };
        }),
      ),
    );
  }

  /** The latest install state of every item (or one). */
  installStates(req: { item?: string } = {}): Array<{ item: string; value: string; accepted: boolean; by: 'user' | 'installer'; detail: ContentHash; revision: Revision }> {
    const db = this.db();
    const rows = (
      req.item === undefined ? db.stmt('SELECT * FROM install_states ORDER BY item').all() : db.stmt('SELECT * FROM install_states WHERE item = ?').all(req.item)
    ) as Array<{ item: string; value: string; accepted: number; by_whom: 'user' | 'installer'; detail: string; rev: number }>;
    return rows.map((r) => ({ item: r.item, value: r.value, accepted: r.accepted === 1, by: r.by_whom, detail: r.detail as ContentHash, revision: revision(Number(r.rev)) }));
  }

  // ------------------------------------------------------------ the task queue (4.1)

  /**
   * A task enters the queue (a scheduler write: the current generation only).
   * The same task queued again with the same card is a no-op returning its
   * revision; a different card while it is queued, or another lineage at any
   * time, is refused (FACT_CONFLICT): a replacing task keeps the lineage (6.5).
   */
  async queueTask(req: { op: string; gen: Generation; task: string; lineage: string; mission: MissionId; card: ContentHash }): Promise<{ revision: Revision }> {
    this.db();
    const rec: BaseRecord = { kind: 'task.queued', task: req.task, lineage: req.lineage, mission: req.mission, card: req.card };
    const prior = this.priorReceipt<{ revision: Revision }>(req.op, null, rec);
    if (prior !== undefined) return prior;
    this.failFast();
    const kinds = new Set(['task.queued']);
    this.checkShape(rec, kinds, 'queueTask');
    const v = await this.verifier.verifyRecords([rec]);
    return this.enqueue(PRIORITY_NORMAL, 'queueTask', () =>
      this.write((s) =>
        this.idempotent(s, req.op, null, rec, () => {
          this.assertCurrent(s, req.gen);
          this.verifier.require(rec, v);
          const cur = taskInfo(s, req.task);
          if (cur !== null && cur.lineage !== req.lineage) throw new LedgerError('FACT_CONFLICT', `task ${req.task} belongs to lineage ${cur.lineage}; a task keeps its lineage (6.5)`);
          if (cur?.state === 'queued') {
            if (cur.mission === req.mission && cur.card === req.card) return { revision: cur.queuedRevision };
            throw new LedgerError('FACT_CONFLICT', `task ${req.task} is queued with another card`);
          }
          return { revision: this.emit(s, rec, req.op) };
        }),
      ),
    );
  }

  /** A task leaves the queue: dispatched (as a registered launch of its mission), cancelled, or superseded by another task. */
  dequeueTask(req: { op: string; gen: Generation; task: string; reason: 'dispatched' | 'cancelled' | 'superseded'; launch?: LaunchId | null; by?: string | null }): Promise<{ revision: Revision }> {
    const rec: BaseRecord = { kind: 'task.dequeued', task: req.task, reason: req.reason, launch: req.launch ?? null, by: req.by ?? null };
    return this.enqueue(PRIORITY_NORMAL, 'dequeueTask', () =>
      this.write((s) =>
        this.idempotent(s, req.op, null, rec, () => {
          this.assertCurrent(s, req.gen);
          this.checkShape(rec, new Set(['task.dequeued']), 'dequeueTask');
          const cur = taskInfo(s, req.task);
          if (cur === null || cur.state !== 'queued') throw new LedgerError('NOT_QUEUED', `task ${req.task} is not in the queue (${cur?.state ?? 'never queued'})`);
          if (req.reason === 'dispatched') {
            const l = this.launchRow(s, req.launch!);
            if (l.tag.mission !== cur.mission) throw new LedgerError('SCOPE_MISMATCH', `launch ${req.launch} belongs to mission ${l.tag.mission}, task ${req.task} to ${cur.mission}`);
          }
          return { revision: this.emit(s, rec, req.op) };
        }),
      ),
    );
  }

  /** The current queue, in the order tasks were queued (rebuilt by a restarting scheduler). */
  taskQueue(req: { mission?: MissionId } = {}): QueuedTask[] {
    return taskQueue(this.db(), req.mission);
  }

  taskInfo(task: string): TaskInfo | null {
    return taskInfo(this.db(), task);
  }

  /** A mission's flow events in revision order (optionally one line / one event type), paged by `after` and `limit` (default 1000, max 10,000). */
  flowEvents(q: { mission: MissionId; line?: string; event?: string; after?: number; limit?: number }): FlowEventRow[] {
    return flowEvents(this.db(), q);
  }

  /** Missions that have flow events. */
  flowMissions(): MissionId[] {
    return flowMissions(this.db());
  }

  /** Committed records of the given kinds (optionally naming one mission) in revision order, paged by `after` and `limit`. */
  recordsByKind(q: { kinds: readonly string[]; mission?: MissionId; after?: number; limit?: number }): Committed[] {
    return recordsByKind(this.db(), q);
  }

  /** The committed object.version with this object id, or null. */
  objectVersion(object: string): Committed | null {
    return factById(this.db(), 'object.version', object);
  }

  /** The committed judgment with this id, or null. */
  judgmentById(judgment: string): Committed | null {
    return factById(this.db(), 'judgment', judgment);
  }

  /** Dispatched tasks never queued again, with their launch's final disposition (by default only disposed ones): a restarted scheduler's "needs disposition" / "exhausted" items. */
  dispatchedTasks(req: { mission?: MissionId; disposed?: boolean } = {}): DispatchedTask[] {
    return dispatchedTasks(this.db(), req);
  }

  // ------------------------------------------------------------ reads used by the service's callers

  /** Every active stop with its scope, the user's words and its times (6.4). */
  activeStops(): ActiveStop[] {
    return activeStops(this.db());
  }

  /** A stop's state: active, released, or not committed (null). */
  stopState(stop: StopId): 'active' | 'released' | null {
    return stopState(this.db(), stop);
  }

  /** External actions authorized and not settled, with their tag and executor (6.4 "停止前已开始，结果未定"). */
  openIntents(): OpenIntent[] {
    return openIntents(this.db());
  }

  /** Launches with tag, final disposition and cleanup state, disposed ones included; filter by stop scope, unfinished, or one launch. */
  launches(filter: LaunchFilter = {}): LaunchInfo[] {
    return listLaunches(this.db(), filter);
  }

  /** The latest mission.block of each mission (or of one) (6.5). */
  missionBlocks(req: { mission?: MissionId } = {}): ReturnType<typeof missionBlocks> {
    return missionBlocks(this.db(), req.mission);
  }

  /** The startup decision after the last reboot, with its basis (v43 6.1, WI-12). */
  startupDecision(): StartupDecision | null {
    return startupDecision(this.db());
  }

  /** The service's state for the scheduler, the CLI and the watchdog. */
  status(): {
    head: Revision;
    storageFault: boolean;
    storageFaultReason: string | null;
    evaluator: { failures: number; fault: string | null };
    slowActions: number;
    recoveryPause: boolean;
    recoveryPausedSince: number | null;
    boot: string | null;
    startup: StartupDecision | null;
    inboxes: Array<{ name: InboxName; file: string; readable: boolean; fs: FsCheck | null }>;
  } {
    const db = this.db();
    const since = db.getState('recovery_pause');
    return {
      head: db.head(),
      storageFault: this.fault,
      storageFaultReason: this.faultReason,
      evaluator: this.health(db),
      slowActions: this.slowActions.length,
      recoveryPause: since !== null,
      recoveryPausedSince: since === null ? null : Number(since),
      boot: this.boot,
      startup: startupDecision(db),
      inboxes: this.inboxes.map((i) => ({ name: i.name, file: i.file, readable: i.header !== null, fs: i.header?.fs ?? null })),
    };
  }


  head(): Revision {
    return this.db().head();
  }

  publicationFloor(): Revision {
    return revision(Number(this.db().getState('publication_floor') ?? '0'));
  }

  activeStopIds(): StopId[] {
    const rows = this.db().stmt("SELECT stop FROM stops WHERE state = 'active' ORDER BY committed_at, rowid").all() as Array<{ stop: string }>;
    return rows.map((r) => r.stop as StopId);
  }

  /** Launches without a final disposition (6.3 takeover input), oldest first. */
  openLaunches(): Array<{ launch: LaunchId; gen: Generation; tag: ScopeTag; adoptedBy: Generation[] }> {
    const db = this.db();
    const rows = db
      .stmt('SELECT l.launch, l.gen, l.mission, l.capabilities FROM launches l WHERE NOT EXISTS (SELECT 1 FROM dispositions d WHERE d.launch = l.launch) ORDER BY l.rowid')
      .all() as Array<{ launch: string; gen: number; mission: string; capabilities: string }>;
    return rows.map((r) => ({
      launch: r.launch as LaunchId,
      gen: r.gen as Generation,
      tag: { mission: r.mission as MissionId, capabilities: JSON.parse(r.capabilities) as string[] },
      adoptedBy: (db.stmt('SELECT gen FROM adoptions WHERE launch = ? ORDER BY gen').all(r.launch) as Array<{ gen: number }>).map((a) => a.gen as Generation),
    }));
  }

  currentGenerationNumber(): Generation {
    return currentGeneration(this.db()) as Generation;
  }

  dispositionFor(launch: LaunchId): Disposition | null {
    return this.dispositionOf(this.db(), launch);
  }

  proofFor(launch: LaunchId): TerminationProofRecord | null {
    const row = this.db().stmt('SELECT payload FROM proofs WHERE launch = ?').get(launch) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as TerminationProofRecord) : null;
  }

  intentState(intent: string): IntentState | null {
    return this.intentStateOf(this.db(), intent);
  }

  /** An intent's full record, including the executor identity recorded for verification (6.1). */
  intentInfo(intent: string): {
    state: IntentState;
    kind: string;
    domain: string;
    launch: LaunchId | null;
    mission: MissionId;
    capabilities: string[];
    executor: { pid: number; startTime: string; bootId: string } | null;
    /** For a landing or delivery-ref intent: the delivery checked at authorization (expected commit, ref, mission, op...); otherwise null. */
    delivery: IntentDelivery | null;
  } | null {
    const row = this.db().stmt('SELECT state, kind, domain, launch, mission, capabilities, executor, delivery FROM intents WHERE intent = ?').get(intent) as
      | { state: IntentState; kind: string; domain: string; launch: string | null; mission: string; capabilities: string; executor: string | null; delivery: string | null }
      | undefined;
    if (!row) return null;
    return {
      state: row.state,
      kind: row.kind,
      domain: row.domain,
      launch: row.launch as LaunchId | null,
      mission: row.mission as MissionId,
      capabilities: JSON.parse(row.capabilities) as string[],
      executor: row.executor ? (JSON.parse(row.executor) as { pid: number; startTime: string; bootId: string }) : null,
      delivery: row.delivery ? (JSON.parse(row.delivery) as IntentDelivery) : null,
    };
  }
}

// ------------------------------------------------------------ delivery claims (6.6 授权; git review r1 #11)

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;

function isOid(x: unknown): x is string {
  return typeof x === 'string' && OID.test(x);
}

/** The intent kinds whose authorization checks the delivery (6.6 steps 6 and 7). */
export const DELIVERY_BOUND_KINDS: ReadonlySet<string> = new Set(['landing', 'delivery-ref']);

interface DeliveryClaimFields {
  readonly mission: MissionId;
  readonly op: string;
  readonly commit: string;
  readonly base: string;
  readonly ref: string | null;
  readonly targetBranch: string | null;
  readonly manifest: ContentHash | null;
  readonly description: ContentHash | null;
}

type DeliveryClaim = { readonly kind: 'none' } | { readonly kind: 'missing' } | { readonly kind: 'claim'; readonly d: DeliveryClaimFields };

/**
 * The delivery a landing or delivery-ref action names in `details.delivery`:
 * { mission, op, commit, base, ref?, targetBranch? (or target), manifest? }.
 * A malformed one is a caller defect (BAD_REQUEST); an absent one is refused in
 * the transaction, after the stop check (DELIVERY_NOT_CURRENT).
 */
function deliveryClaim(kind: string, details: unknown): DeliveryClaim {
  if (!DELIVERY_BOUND_KINDS.has(kind)) return { kind: 'none' };
  const raw = details !== null && typeof details === 'object' ? (details as Record<string, unknown>).delivery : undefined;
  if (raw === undefined || raw === null) return { kind: 'missing' };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new LedgerError('BAD_REQUEST', 'details.delivery is an object');
  const d = raw as Record<string, unknown>;
  const str = (k: string): string => {
    const x = d[k];
    if (typeof x !== 'string' || x === '') throw new LedgerError('BAD_REQUEST', `details.delivery.${k} is a non-empty string`);
    return x;
  };
  const opt = (k: string): string | null => (d[k] === undefined || d[k] === null ? null : str(k));
  const commit = str('commit');
  const base = str('base');
  if (!isOid(commit) || !isOid(base)) throw new LedgerError('BAD_REQUEST', 'details.delivery.commit and .base are git object ids');
  const ref = opt('ref');
  if (ref !== null && !ref.startsWith('refs/mission-pipeline/')) throw new LedgerError('BAD_REQUEST', 'delivery refs live under refs/mission-pipeline/');
  const targetBranch = opt('targetBranch') ?? opt('target');
  const manifest = opt('manifest');
  if (manifest !== null && !CONTENT_HASH.test(manifest)) throw new LedgerError('BAD_REQUEST', 'details.delivery.manifest is a content hash');
  const description = opt('description');
  if (description !== null && !CONTENT_HASH.test(description)) throw new LedgerError('BAD_REQUEST', 'details.delivery.description is a content hash');
  const out: DeliveryClaimFields = {
    mission: str('mission') as MissionId,
    op: str('op'),
    commit,
    base,
    ref,
    targetBranch,
    manifest: manifest as ContentHash | null,
    description: description as ContentHash | null,
  };
  if (kind === 'delivery-ref') {
    // The delivery side's intent carries the ref writer's ref, commit and base at the top: they must be the checked ones.
    const top = details as Record<string, unknown>;
    for (const k of ['ref', 'commit', 'base'] as const) {
      if (top[k] !== undefined && top[k] !== out[k]) throw new LedgerError('BAD_REQUEST', `details.${k} differs from details.delivery.${k}`);
    }
  }
  return { kind: 'claim', d: out };
}
