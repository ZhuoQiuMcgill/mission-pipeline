// The scheduler (design 6.2, 6.3, 6.4, 6.5): one generation of it at a time.
//
// On start it begins a new generation in the ledger (every older generation's writes are
// refused from then on), writes its heartbeat and lease to the control plane, reloads every
// active stop, submits proof files left in the state directory, and applies the takeover
// rules to every launch without a final disposition. Then it runs independent loops, none of
// which waits on another:
//   - stops: on the control-plane fast signal (polled) and on every tick;
//   - reconciliation: takeover rules on every open launch, acceptance, quarantine, retries;
//   - cleanup: pending cleanups with bounded back-off (never blocks anything else);
//   - dispatch: stops, recovery pause, storage fault, loop caps, LFS, spend and machine
//     admission, then registerLaunch (stop- and pause-checked in the ledger) and the unit;
//   - notices and alert copies after each evaluator publication.
// It never holds a reservation for a task that waits (6.2): only running launches reserve.
// The task queue is kept in the ledger (queueTask / dequeueTask, 4.1): a restarted scheduler
// rebuilds it. Every question about the ledger's state goes over its IPC (6.1).

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../common/hash.ts';
import { contentHash, type ContentHash } from '../common/ids.ts';
import { id, type Generation, type LaunchId, type MissionId, type Revision } from '../common/ids.ts';
import type { LoopKind, MissionBlockRecord, SeatResultRecord } from '../common/records.ts';
import { RpcClient } from '../common/rpc.ts';
import type { EvaluatorSupervisor } from '../evaluator/supervisor.ts';
import { faultTimeView, readCheckpointSummary } from '../evaluator/checkpoint.ts';
import type { Label } from '../evaluator/semantics.ts';
import { deliverPendingAlerts } from '../exec/alerts.ts';
import { createProofSink } from '../exec/ledgerSink.ts';
import type { ProofSink } from '../exec/proof.ts';
import { ContentStore } from '../ledger/content.ts';
import { ledgerPaths, type LedgerErrorCode } from '../ledger/service.ts';
import { readStopHistory, type ScopeTag } from '../ledger/stops.ts';
import { MachineAdmission, spendAdmits, systemProbe, budgetLeft, type MachineAdmissionConfig, type MachineProbe } from './admission.ts';
import { Alerts } from './alerts.ts';
import { CleanupManager, ExecCleanupExecutor, type CleanupExecutor } from './cleanup.ts';
import { ControlPlane, type SchedulerStatus } from './controlPlane.ts';
import { allLaunchMeta, readLaunchMeta, writeLaunchMeta, type LaunchMeta } from './launches.ts';
import { errorCode, isStale, isTransient, SchedulerLedger, type LedgerStatus, type OpenIntent, type StartupDecision } from './ledger.ts';
import { LoopGuard, type LoopVerdict } from './loops.ts';
import { acceptedDegradations, NoticePump, startEvaluator, type EvaluatorRunnerOptions } from './notices.ts';
import { LedgerReader } from './reader.ts';
import { checkContinuations } from './continuation.ts';
import { readEndedAcceptances, readPrepared, removePrepared, writeEndedAcceptances, type EndedAcceptance } from './localState.ts';
import { cleanupPass } from '../exec/cleanup.ts';
import { LOOP_KINDS } from '../common/records.ts';
import { routeAccepted, routeFullReview, routeQuarantined, type NextStep } from './routing.ts';
import { StopManager } from './stops.ts';
import { outcomeOfDisposition, Takeover, type AttemptOutcome, type FailureKind } from './takeover.ts';
import { TaskQueue, type Demand, type TaskRecord, type TaskSpec } from './tasks.ts';
import { overlappingPaths, type ExternalWorkScan, type ExternalWork } from './external.ts';
import { prepareSeatLaunch, readSeatOutcome, seatAreaPlan, seatAreaTools, seatCardKind, seatGate, seatNeedsArea, seatReservation, stampCard, type PreparedSeat, type SeatInstall } from './seats.ts';
import type { AreaTools } from '../exec/resources.ts';
import { readEndedByStop } from '../exec/stopcause.ts';
import type { GateVerdict } from '../exec/selfcheck.ts';
import {
  currentBootId,
  derivedUnitCgroupPath,
  systemProcesses,
  systemUnits,
  unitNameOf,
  type ProcessControl,
  type UnitControl,
} from './units.ts';
import { processIdentity } from '../exec/supervisor.ts';

export const LEDGER_SINK_MODULE = fileURLToPath(new URL('../exec/ledgerSink.ts', import.meta.url));

export interface SchedulerOptions {
  readonly ledgerSocket: string;
  /** The ledger's root directory (database, content store, stop inbox): read-only use. */
  readonly ledgerRoot: string;
  /** A ledger request without an answer within this time counts as unavailable (default 10 s). */
  readonly ledgerTimeoutMs?: number;
  readonly controlPlane: string;
  /** Program state directory on a Linux filesystem: proofs, supervisor identities, launch metadata. */
  readonly stateDir: string;
  /** Program-owned directories cleanup may release paths under. */
  readonly scratchRoots?: readonly string[];
  readonly nodePath?: string;
  readonly sinkModule?: string;
  readonly tickMs?: number;
  readonly stopPollMs?: number;
  readonly heartbeatMs?: number;
  readonly leaseTtlMs?: number;
  readonly maxRunning?: number;
  readonly takeover?: {
    readonly proofPendingLimitMs?: number;
    readonly heartbeatTimeoutMs?: number;
    readonly startGraceMs?: number;
    readonly proofGraceMs?: number;
    readonly killWaitMs?: number;
  };
  readonly stops?: { readonly stopTimeoutMs?: number; readonly unkillableAfterMs?: number };
  readonly cleanup?: { readonly initialBackoffMs?: number; readonly maxBackoffMs?: number; readonly alertAfter?: number; readonly alertEvery?: number };
  readonly admission?: MachineAdmissionConfig & { readonly diskPaths?: readonly string[] };
  readonly evaluator?: EvaluatorRunnerOptions & { readonly querySocket: string };
  /** The seat installation (9.3, 9.6): the self-check evidence, credentials, model configuration. Without it no seat is dispatched. */
  readonly seats?: SeatInstall;
  /** WI-03: how often external worktrees are scanned for overlap with in-flight write scopes (default 10 minutes). */
  readonly externalScanMs?: number;
  /** Log lines (default: none). */
  readonly log?: (line: string) => void;
}

/**
 * Ledger refusals the scheduler did not expect where they happened, with the PM's work
 * instruction (3.11 exit table). Codes absent here are handled where they occur, or are
 * normal branches (null in the ledger's REFUSAL_WI): the next pass reads again and goes on.
 */
const UNEXPECTED_REFUSALS: Partial<Record<LedgerErrorCode, { readonly category: string; readonly wi: string; readonly defaultAction: string }>> = {
  TOO_LARGE: { category: 'request-too-large', wi: 'WI-10', defaultAction: 'only that request is dropped; it is retried on the next pass if still needed; other work continues' },
  SCOPE_MISMATCH: { category: 'scope-mismatch', wi: 'WI-20', defaultAction: 'only that request is dropped; it is retried on the next pass if still needed; other work continues' },
  // e.g. a task queued again under another lineage or card
  FACT_CONFLICT: { category: 'fact-conflict', wi: 'WI-20', defaultAction: 'only that request is dropped; it is retried on the next pass if still needed; other work continues' },
  // 派生状态无法计算 (6.1): the operation ended; it is registered again after the evaluator recovers
  EVALUATOR_FAULT: {
    category: 'derived-state-unavailable',
    wi: 'WI-11',
    defaultAction: 'that operation ended with "the derived state cannot be computed"; the next pass after the evaluator publishes again registers it anew; other work continues',
  },
  // a program defect inside the ledger service (the closest row of the exit table)
  INTERNAL_ERROR: { category: 'ledger-internal-error', wi: 'WI-20', defaultAction: 'only that request is dropped; it is retried on the next pass; other work continues' },
};

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** WI-12 (v43 6.1): the risk-28 reminder the PM gives after an abnormal stop without fault evidence. */
import { RISK28_REMINDER as LEDGER_RISK28_REMINDER } from '../ledger/startup.ts';
export const RISK28_REMINDER: string = LEDGER_RISK28_REMINDER;

/**
 * WI-12 data for the PM: the ledger's startup decision after the last reboot and its basis;
 * every stop in the inboxes and the spool and whether it is committed; the latest booked user
 * words (the PM compares them with its own conversation only to re-submit a stop it finds
 * missing, never to decide whether to continue); the external actions still unsettled.
 */
export interface RecoveryCheck {
  readonly format: 'mp4.recovery-check.v3';
  readonly paused: boolean;
  readonly startup: StartupDecision | null;
  /** Every stop request in the inboxes and the control-plane spool, and whether it is committed. */
  readonly inboxStops: ReadonlyArray<{ readonly stop: string; readonly words: string; readonly at: number; readonly committed: boolean }>;
  readonly committedStops: ReadonlyArray<{ readonly stop: string; readonly words: string; readonly committedAt: number }>;
  /** The latest booked user message (用户原话, 10.1 item 6). */
  readonly lastUserWords: { readonly revision: number; readonly message: string; readonly session: string; readonly at: number; readonly excerpt: string } | null;
  readonly pendingIntents: ReadonlyArray<{ readonly intent: string; readonly kind: string; readonly domain: string; readonly state: string; readonly mission: string; readonly executor: unknown }>;
  /** Stops in an inbox not committed yet (should be none: they are committed first). */
  readonly uncommittedStops: readonly string[];
  /**
   * Whether the ledger answered. When it did not, no inbox stop is shown as committed (the
   * conservative reading: the PM asks the user to repeat what was not seen as persisted).
   */
  readonly ledgerAnswered: boolean;
  /** The configured stop inboxes and whether each was readable when the ledger opened (v45 6.1); empty when unknown. */
  readonly inboxes: LedgerStatus['inboxes'];
}

export interface LfsVerdict {
  readonly ok: boolean;
  readonly hint: string | null;
}

export interface SchedulerDeps {
  readonly processes?: ProcessControl;
  readonly units?: UnitControl;
  readonly probe?: MachineProbe;
  readonly cleanupExecutor?: CleanupExecutor;
  /** 7.1 v34: the task's snapshot needs its Git LFS objects locally (git/representation.ts checkLfsObjectsPresent). */
  readonly lfsCheck?: (task: TaskSpec) => Promise<LfsVerdict>;
  readonly sink?: ProofSink;
  /** WI-03: the git module's scan of external worktrees and branches (called periodically and before deliveries). */
  readonly externalWork?: ExternalWorkScan;
  /**
   * The ledger's startup decision after the last reboot (v43 6.1, WI-12). Default: the
   * `startup` field of the ledger's `status`. Tests inject decisions the ledger cannot make
   * yet (an abnormal stop with the spare inbox, risk 28).
   */
  readonly startup?: () => Promise<StartupDecision | null>;
  /** Tests: the startup self-check gate's verdict instead of reading the evidence (9.3). */
  readonly selfCheck?: () => GateVerdict;
  /** Tests: a stand-in for the evaluator's query socket (continuation checks, routing). */
  readonly evaluatorQuery?: EvaluatorQuery;
  readonly now?: () => number;
}

/** What the scheduler needs of the flow engine (src/flow/engine.ts FlowEngine satisfies it). */
export interface FlowReconciler {
  reconcile(): Promise<unknown>;
}

/** The evaluator's query socket as the scheduler uses it (RpcClient satisfies it). */
export interface EvaluatorQuery {
  call(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

/** A coalescing single-flight runner: a call while running schedules exactly one more run. */
class Runner {
  private running: Promise<void> | null = null;
  private again = false;
  private readonly fn: () => Promise<void>;
  private readonly onError: (e: unknown) => void;

  constructor(fn: () => Promise<void>, onError: (e: unknown) => void) {
    this.fn = fn;
    this.onError = onError;
  }

  kick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          try {
            await this.fn();
          } catch (e) {
            this.onError(e);
          }
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class Scheduler {
  readonly opts: SchedulerOptions;
  readonly cp: ControlPlane;
  readonly reader: LedgerReader;
  readonly content: ContentStore;
  readonly ledger: SchedulerLedger;
  /** Its own connection: stops never queue behind other requests (6.1). */
  readonly stopLedger: SchedulerLedger;
  readonly tasks = new TaskQueue();
  readonly alerts: Alerts;
  readonly loops: LoopGuard;
  readonly takeover: Takeover;
  readonly stops: StopManager;
  readonly cleanup: CleanupManager;
  readonly notices: NoticePump;
  readonly processes: ProcessControl;
  readonly units: UnitControl;
  private readonly admission: MachineAdmission;
  private readonly lfsCheck: ((task: TaskSpec) => Promise<LfsVerdict>) | null;
  private readonly externalWork: ExternalWorkScan | null;
  private readonly startupOverride: (() => Promise<StartupDecision | null>) | null;
  private readonly selfCheckOverride: (() => GateVerdict) | null;
  /** The gate's verdict for this dispatch pass (9.3). */
  private gateNow: GateVerdict | null = null;
  /** Seat launches prepared at admission (image, host config), kept for a registration retry. */
  private readonly preparedSeats = new Map<LaunchId, PreparedSeat>();
  private areaToolsCache: Promise<AreaTools> | null = null;
  private startup: StartupDecision | null = null;
  private startupNoticed: string | null = null;
  /** Dequeue records still to write (dispatched tasks whose dequeue answer did not arrive). */
  private readonly pendingDequeues = new Map<string, LaunchId>();
  private readonly externalNoticed = new Set<string>();
  private readonly sink: ProofSink;
  private readonly now: () => number;
  private genValue: Generation | null = null;
  private timers: NodeJS.Timeout[] = [];
  private lastStopSignal: string | null = null;
  private readonly reconcileRunner: Runner;
  private readonly cleanupRunner: Runner;
  private readonly dispatchRunner: Runner;
  private readonly noticeRunner: Runner;
  /** The flows (src/flow): reconciled on every tick and after every accepted outcome. */
  private flow: FlowReconciler | null = null;
  private readonly flowRunner: Runner;
  private readonly stopRunner: Runner;
  /** Launches registered (or being registered) by this scheduler whose unit is not started yet. */
  private readonly dispatching = new Set<LaunchId>();
  /** A registration whose response was lost: retried with the same op and launch id (6.1, §14 item 6). */
  private readonly unconfirmed = new Map<string, LaunchId>();
  /** Missions in budget block (6.5), from the ledger at start and maintained after. */
  private readonly blocked = new Map<MissionId, MissionBlockRecord>();
  private readonly waiting = new Map<string, { mission: MissionId | null; task: string | null; reason: string }>();
  private evaluator: EvaluatorSupervisor | null = null;
  /** Launches whose acceptance waits for the evaluator's continuation check (5.2 part 5). */
  private readonly awaitingEvaluator = new Set<LaunchId>();
  /** Stable tasks held because a dependency is not proven (r1 #2). */
  private readonly proofHolds = new Map<string, { dep: string; why: string; step: string }>();
  private readonly cardAreaCache = new Map<string, boolean | null>();
  /** 6.6: closed missions and whether their (latest) close waits for running units. */
  private closedMissions = new Map<MissionId, { readonly waitRunning: boolean; readonly closes: number }>();
  /** The state rebuilt from the ledger at start (queue, reservations, blocks, open tasks); dispatch waits for it (r1 #7). */
  private recovered = false;
  /** WI-11: acceptances that ended for want of the derived state, re-registered after the next publication (r1 #9). */
  private endedAcceptances: Record<string, EndedAcceptance> = {};
  private evalQuery: EvaluatorQuery | null = null;
  private lastPublished: number | null = null;
  /** WI-11: set while the evaluator is in its fault state. */
  evaluatorFault: string | null = null;
  /** The evaluator's memory pool runs degraded (heap-only): level 0 shows it. */
  evaluatorDegraded: unknown = null;
  /** The evaluator could not start: its pool cannot be enforced (WI-18). */
  evaluatorBlocked: unknown = null;
  /** Checkpoints paused for want of room in the pool (WI-11). */
  checkpointPaused: unknown = null;
  /** Routing attempts per task (WI-11 re-registration records which attempt it retries). */
  private readonly routeAttempts = new Map<string, { n: number; id: string }>();
  /** Steps that ended because the derived state could not be computed, to route again after the next publication. */
  private readonly endedForProven = new Map<string, LaunchId>();
  readonly nextSteps = new Map<string, NextStep>();
  readonly outcomes: AttemptOutcome[] = [];
  private readonly undelivered: AttemptOutcome[] = [];
  stale = false;
  paused = false;
  private pauseNoticed = false;
  private faultSince: number | null = null;
  /** Peak reservations of launches whose cleanup is not done yet (6.5; WI-14: kept while processes or resources remain). */
  private readonly reserved = new Map<LaunchId, { demand: Demand; unitName: string }>();
  private externalScanAt = 0;
  storageFault = false;
  started = false;
  private closing = false;
  private readonly log: (line: string) => void;

  constructor(opts: SchedulerOptions, deps: SchedulerDeps = {}) {
    this.opts = opts;
    this.now = deps.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    const lp = ledgerPaths(opts.ledgerRoot, opts.controlPlane);
    this.cp = new ControlPlane(opts.controlPlane);
    this.reader = new LedgerReader(lp.db);
    this.content = new ContentStore(lp.content);
    this.ledger = SchedulerLedger.connect(opts.ledgerSocket, opts.ledgerTimeoutMs ?? 10_000);
    // stops must not wait long on a stuck service: they fall back to the control plane
    this.stopLedger = SchedulerLedger.connect(opts.ledgerSocket, Math.min(opts.ledgerTimeoutMs ?? 10_000, 3_000));
    this.processes = deps.processes ?? systemProcesses;
    this.units = deps.units ?? systemUnits;
    this.alerts = new Alerts({ ledger: this.ledger, content: this.content, controlPlane: this.cp, source: 'scheduler', now: this.now });
    this.loops = new LoopGuard({ ledger: this.ledger, content: this.content, alerts: this.alerts });
    // after close, a late caller gets "unavailable" instead of a new connection
    const sink = deps.sink ?? createProofSink({ socketPath: opts.ledgerSocket, contentRoot: lp.content });
    this.sink = {
      submit: (p) => (this.closing ? Promise.resolve({ kind: 'unavailable' as const, detail: 'scheduler closed' }) : sink.submit(p)),
      close: () => sink.close?.(),
    };
    this.takeover = new Takeover({
      ledger: this.ledger,
      cp: this.cp,
      stateDir: opts.stateDir,
      processes: this.processes,
      units: this.units,
      alerts: this.alerts,
      sink: this.sink,
      gen: () => this.gen,
      paused: () => this.paused,
      now: this.now,
      // 5.2 part 5: a continuation judgment is checked by the evaluator before the acceptance
      beforeAccept: async (launch, records) => {
        const gate = await checkContinuations(
          {
            ledger: this.ledger,
            content: this.content,
            gen: () => this.gen,
            query: () => this.evalQuery,
            evaluatorDown: () => this.evaluatorFault,
            changedLines: (l) => this.changedLinesOf(l),
          },
          launch,
          records,
        );
        if (gate.kind === 'wait' || gate.kind === 'ended') this.awaitingEvaluator.add(launch);
        else this.awaitingEvaluator.delete(launch);
        if (gate.kind === 'ended') await this.acceptanceEnded(launch, gate.why);
        return gate;
      },
      // 6.6: a production unit of a closed mission (the close not waiting for running units) is cancelled
      closedFor: (launch, tag) => this.closedFor(launch, tag.mission),
      ...(opts.takeover ?? {}),
    });
    this.stops = new StopManager({
      ledger: this.stopLedger,
      cp: this.cp,
      stopPaths: { inbox: lp.inbox, controlPlane: opts.controlPlane },
      stateDir: opts.stateDir,
      processes: this.processes,
      units: this.units,
      alerts: this.alerts,
      takeover: this.takeover,
      now: this.now,
      ...(opts.stops ?? {}),
    });
    const executor = deps.cleanupExecutor ?? new ExecCleanupExecutor({ stateDir: opts.stateDir, roots: [...(opts.scratchRoots ?? []), join(opts.stateDir, 'seats')] });
    this.cleanup = new CleanupManager({
      ledger: this.ledger,
      content: this.content,
      executor,
      alerts: this.alerts,
      stateDir: opts.stateDir,
      supervisorGone: (l) => this.takeover.supervisorGone(l),
      busy: (l) => this.dispatching.has(l),
      lingering: (l) => this.takeover.lingering(l),
      now: this.now,
      ...(opts.cleanup ?? {}),
    });
    this.notices = new NoticePump({ reader: this.reader, ledger: this.ledger, content: this.content, cp: this.cp });
    const adm = opts.admission ?? { memoryReserveBytes: 256 * 1024 * 1024, diskReserveBytes: 512 * 1024 * 1024, inodeReserve: 10_000 };
    this.admission = new MachineAdmission(adm, deps.probe ?? systemProbe(opts.admission?.diskPaths ?? [lp.content]));
    this.lfsCheck = deps.lfsCheck ?? null;
    this.externalWork = deps.externalWork ?? null;
    this.startupOverride = deps.startup ?? null;
    this.selfCheckOverride = deps.selfCheck ?? null;
    this.evalQuery = deps.evaluatorQuery ?? null;
    const onError = (where: string) => (e: unknown) => this.onLoopError(where, e);
    this.reconcileRunner = new Runner(() => this.reconcilePass(), onError('reconcile'));
    this.cleanupRunner = new Runner(async () => {
      await this.cleanup.pass();
      await this.sweepHosts();
      await this.sweepPrepared();
    }, onError('cleanup'));
    this.dispatchRunner = new Runner(() => this.dispatchPass(), onError('dispatch'));
    this.noticeRunner = new Runner(() => this.notices.run(), onError('notices'));
    this.flowRunner = new Runner(async () => {
      if (this.flow !== null && !this.stale && !this.closing) await this.flow.reconcile();
    }, onError('flow'));
    this.stopRunner = new Runner(() => this.stops.check(), onError('stops'));
  }

  get gen(): Generation {
    if (this.genValue === null) throw new Error('the scheduler has no generation yet');
    return this.genValue;
  }

  get generation(): Generation | null {
    return this.genValue;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Begin a generation (retrying while the ledger is unavailable), take over, start the loops. */
  async start(opts: { readonly startLoops?: boolean } = {}): Promise<Generation> {
    mkdirSync(this.opts.stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.opts.controlPlane, { recursive: true });
    let delay = 200;
    for (;;) {
      try {
        this.genValue = await this.ledger.beginGeneration();
        break;
      } catch (e) {
        if (!isTransient(e) || this.closing) throw e;
        this.storageFault = errorCode(e) === 'STORAGE_FAULT';
        await sleep(delay);
        delay = Math.min(delay * 2, 5_000);
      }
    }
    this.writeHeartbeat();
    await this.refreshFlags();
    // 6.4: reload every active stop first; then proofs left behind; then takeover of every open launch.
    await this.stopRunner.kick();
    // the evaluator before the takeover: routing the results decided below needs its labels, and
    // without it they would end as "derived state cannot be computed" (false WI-11, e2e M1)
    if (this.opts.evaluator) await this.startEvaluator(this.opts.evaluator);
    await this.takeover.submitLeftProofs().catch((e: unknown) => this.onLoopError('proofs', e));
    await this.reconcileRunner.kick();
    // the queue, the reservations, the budget blocks and the tasks that still need something,
    // from the ledger; retried on every dispatch pass until it succeeds, and nothing is
    // dispatched before (r1 #7)
    this.recovered = await this.recoverState();
    this.started = true;
    if (opts.startLoops !== false) this.startLoops();
    return this.gen;
  }

  private startLoops(): void {
    const tick = this.opts.tickMs ?? 1_000;
    this.timers.push(setInterval(() => this.writeHeartbeat(), this.opts.heartbeatMs ?? 1_000));
    this.timers.push(
      setInterval(() => {
        const s = this.cp.readStopSignal();
        if (s !== this.lastStopSignal) {
          this.lastStopSignal = s;
          void this.stopRunner.kick();
        }
      }, this.opts.stopPollMs ?? 200),
    );
    this.timers.push(setInterval(() => void this.tick(), tick));
  }

  /** One round of every loop (tests drive the scheduler with this when loops are off). */
  async tick(): Promise<void> {
    if (this.stale || this.closing) return;
    this.checkLease();
    await this.refreshFlags();
    await Promise.all([this.stopRunner.kick(), this.reconcileRunner.kick(), this.cleanupRunner.kick()]);
    await this.dispatchRunner.kick();
    await this.noticeRunner.kick();
    await this.flowRunner.kick();
    // exceptions the units and seat hosts could only write locally reach the ledger (and then the control plane)
    await deliverPendingAlerts(this.opts.stateDir, { call: (_m, p) => this.ledger.raiseAlert(p.op, p.alert, p.category, p.body, p.wi) }, this.content).catch(() => 0);
    if (this.externalWork !== null && this.now() - this.externalScanAt >= (this.opts.externalScanMs ?? 600_000)) {
      await this.scanExternalWork().catch((e: unknown) => this.onLoopError('external-work', e));
    }
    await this.alerts.flush().catch(() => 0);
    this.writeStatus();
  }

  /** Clean shutdown: no unit is touched (they are independent services, 6.2). */
  async close(): Promise<void> {
    this.closing = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.all([this.stopRunner.idle(), this.reconcileRunner.idle(), this.cleanupRunner.idle(), this.dispatchRunner.idle(), this.noticeRunner.idle(), this.flowRunner.idle()]);
    await this.evaluator?.stop();
    this.evalQuery?.close();
    this.ledger.close();
    this.stopLedger.close();
    this.sink.close?.();
  }

  /** A crash, as far as the outside world can tell: everything stops at once, nothing is cleaned up. */
  abandon(): void {
    this.closing = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    void this.evaluator?.stop();
    this.evalQuery?.close();
    this.ledger.close();
    this.stopLedger.close();
    this.sink.close?.();
  }

  private onLoopError(where: string, e: unknown): void {
    if (isStale(e)) {
      this.becomeStale(`${where}: ${(e as Error).message}`);
      return;
    }
    if (isTransient(e)) {
      if (errorCode(e) === 'STORAGE_FAULT') this.storageFault = true;
      return;
    }
    if (errorCode(e) === 'RECOVERY_PAUSED') {
      this.paused = true;
      return;
    }
    const code = errorCode(e);
    const exit = code === null || code === 'UNAVAILABLE' ? undefined : UNEXPECTED_REFUSALS[code];
    if (exit !== undefined) {
      // an exit of the ledger the scheduler did not expect here: tell the PM (v42 exit table)
      void this.alerts
        .raise({
          category: exit.category,
          wi: exit.wi,
          key: `${where}:${(e as Error).message}`.slice(0, 300),
          trigger: `the ledger refused a ${where} request: ${(e as Error).message}`,
          defaultAction: exit.defaultAction,
          detail: { where, code, message: (e as Error).message },
        })
        .catch(() => undefined);
    }
    // normal branches (BELOW_FLOOR, STALE_REQUEST, NOT_QUEUED, PROOF_EXISTS, CONTINUATION_REFUSED,
    // RENEWAL_REFUSED): nothing to tell; the next pass reads again and goes on
    this.log(`[scheduler] ${where}: ${(e as Error).stack ?? String(e)}`);
  }

  private becomeStale(why: string): void {
    if (this.stale) return;
    this.stale = true;
    this.log(`[scheduler] generation ${this.genValue} superseded: ${why}`);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.writeStatus();
  }

  private writeHeartbeat(): void {
    const self = processIdentity(process.pid);
    const now = this.now();
    const base = { pid: process.pid, startTime: self?.startTime ?? 0, bootId: currentBootId() };
    this.cp.writeHeartbeat({ format: 'mp4.scheduler-heartbeat.v1', ...base, gen: this.genValue, at: now });
    if (this.genValue !== null && !this.stale) {
      const lease = this.cp.readLease();
      if (lease === null || lease.gen <= this.genValue) {
        this.cp.writeLease({ format: 'mp4.scheduler-lease.v1', ...base, gen: this.genValue, renewedAt: now, ttlMs: this.opts.leaseTtlMs ?? 10_000 });
      }
    }
  }

  /** A newer generation's lease in the control plane: this scheduler is superseded (6.3). */
  private checkLease(): void {
    const lease = this.cp.readLease();
    if (lease !== null && this.genValue !== null && lease.gen > this.genValue) this.becomeStale(`the lease belongs to generation ${lease.gen}`);
  }

  /** The ledger's status: storage fault, recovery pause, the startup decision (v43 6.1, WI-12). */
  private async refreshFlags(): Promise<void> {
    let ledgerFault = false;
    try {
      const st = await this.ledger.status();
      this.paused = st.recoveryPause;
      ledgerFault = st.storageFault;
      this.startup = this.startupOverride !== null ? await this.startupOverride() : st.startup;
    } catch {
      /* the service cannot answer: keep the last known values; the heartbeat below still counts */
    }
    const hb = this.cp.readLedgerHeartbeat();
    const hbFault = hb !== null && hb.storageFault === true;
    this.storageFault = ledgerFault || hbFault || this.stops.ledgerDown;
    if (this.paused && !this.pauseNoticed) {
      this.pauseNoticed = true;
      void this.noticeRecoveryPause().catch((e: unknown) => this.onLoopError('recovery-pause', e));
    }
    if (!this.paused) this.pauseNoticed = false;
    // WI-12: the ledger decided to continue after a reboot: dispatch goes on by itself, the PM is
    // told with the basis; after an abnormal stop without fault evidence (risk 28, option A) the
    // PM also reminds the user to repeat any stop not seen as persisted
    const d = this.startup;
    if (d !== null && d.state === 'continued' && !this.paused) {
      const key = `${d.basis.boot}:${d.at}`;
      if (this.startupNoticed !== key) {
        this.startupNoticed = key;
        // the ledger writes the reminder into the basis (risk 28); the text of WI-12 otherwise
        const reminder = (d.basis as { reminder?: string | null }).reminder ?? (d.basis.evidence === 'abnormal-stop-spare-inbox' ? RISK28_REMINDER : null);
        const abnormal = reminder !== null;
        void this.recoveryCheck()
          .then((check) =>
            this.alerts.raise({
              category: abnormal ? 'startup-continued-after-abnormal-stop' : 'startup-continued',
              wi: 'WI-12',
              key,
              trigger: `the machine rebooted (${d.basis.previousBoot ?? '?'} -> ${d.basis.boot}); the ledger's startup decision: continue (${d.basis.evidence})`,
              defaultAction: abnormal
                ? `dispatch resumed automatically (risk 28, option A); the PM reminds the user: ${reminder}`
                : 'dispatch resumed automatically; unsettled external actions are verified ("outcome pending verification"); no confirmation needed',
              detail: { startup: d, ...(abnormal ? { reminder } : {}), check },
            }),
          )
          .catch(() => undefined);
      }
    }
    if (this.storageFault && this.faultSince === null) {
      this.faultSince = this.now();
      void this.alerts
        .raise({
          category: 'storage-fault-seen',
          wi: 'WI-12',
          key: `${this.genValue}:${this.faultSince}`,
          trigger: 'the ledger reports a storage fault, or refuses to commit stops',
          defaultAction: 'dispatch is paused; stops are carried out through the control plane (processes in scope are ended); running units continue',
          detail: { gen: this.genValue, heartbeat: hb },
        })
        .catch(() => undefined);
    }
    if (!this.storageFault) this.faultSince = null;
  }

  /** WI-12 check data for the PM (also over the scheduler's RPC). */
  async recoveryCheck(): Promise<RecoveryCheck> {
    const lp = ledgerPaths(this.opts.ledgerRoot, this.opts.controlPlane);
    // every stop the inbox and the spool have seen, committed (archived) or still pending
    const requested = readStopHistory({ inbox: lp.inbox, controlPlane: this.opts.controlPlane });
    let committed: Array<{ stop: string; words: string; committedAt: number }> = [];
    let intents: OpenIntent[] = [];
    let paused = this.paused;
    let startup = this.startup;
    let last: RecoveryCheck['lastUserWords'] = null;
    const uncommitted: string[] = [];
    let answered = false;
    let inboxes: LedgerStatus['inboxes'] = [];
    try {
      committed = (await this.ledger.activeStops()).map((s) => ({ stop: s.stop, words: s.words, committedAt: s.committedAt }));
      intents = await this.ledger.openIntents();
      const st = await this.ledger.status();
      paused = st.recoveryPause;
      startup = this.startupOverride !== null ? await this.startupOverride() : st.startup;
      const w = (await this.ledger.latestUserWords(1))[0];
      last = w === undefined ? null : { revision: w.revision, message: w.message, session: w.session, at: w.at, excerpt: w.excerpt };
      for (const r of requested) if ((await this.ledger.stopState(r.stop)) === null) uncommitted.push(r.stop);
      inboxes = st.inboxes ?? [];
      answered = true;
    } catch {
      /* the ledger cannot answer now */
    }
    return {
      format: 'mp4.recovery-check.v3',
      paused,
      startup,
      inboxStops: requested.map((r) => ({ stop: r.stop, words: r.words, at: r.at, committed: answered && !uncommitted.includes(r.stop) })),
      committedStops: committed,
      lastUserWords: last,
      pendingIntents: intents.map((i) => ({ intent: i.intent, kind: i.kind, domain: i.domain, state: i.state, mission: i.tag.mission, executor: i.executor })),
      uncommittedStops: answered ? uncommitted : requested.map((r) => r.stop),
      ledgerAnswered: answered,
      inboxes,
    };
  }

  private async noticeRecoveryPause(): Promise<void> {
    const check = await this.recoveryCheck();
    await this.alerts.raise({
      category: 'recovery-pause',
      wi: 'WI-12',
      key: `${this.genValue}:${check.startup?.at ?? 'pause'}`,
      trigger: `the machine rebooted while work could still advance, and the ledger's startup decision is to pause (${check.startup?.basis.evidence ?? 'recovery pause'}) (6.1)`,
      defaultAction:
        'recovery pause for every scope: no dispatch, no authorization, no acceptance; unsettled intents stay pending verification; stops still work. The PM asks the user whether they asked to stop or withdraw anything that was not shown as persisted, records any stop first, then confirms resume (confirmResume)',
      detail: check,
    });
  }

  private writeStatus(): void {
    const status: SchedulerStatus = {
      format: 'mp4.scheduler-status.v1',
      gen: this.genValue,
      recoveryPause: this.paused,
      storageFault: this.storageFault,
      stale: this.stale,
      dispatchPaused: this.dispatchBlockReason(),
      waiting: [...this.waiting.values()],
      blocked: [...this.blocked.values()].map((b) => ({ mission: b.mission, reason: b.reason })),
      evaluator: {
        fault: this.evaluatorFault,
        degraded: this.evaluatorDegraded,
        blocked: this.evaluatorBlocked,
        checkpointPaused: this.checkpointPaused,
        published: this.lastPublished,
        // fault-time reads: the last checkpoint's summary and how far it lags (6.1, WI-11)
        lastCheckpoint: this.evaluatorFault !== null ? this.faultView() : null,
      },
      at: this.now(),
    };
    this.cp.putStatus(status);
  }

  private dispatchBlockReason(): string | null {
    if (this.stale) return 'superseded by a newer scheduler generation';
    if (this.paused) return 'recovery pause after a reboot: waiting for the user\'s answer through the PM (WI-12)';
    if (this.storageFault) return 'the ledger is in storage fault (6.1)';
    return null;
  }

  // ---------------------------------------------------------------- tasks (API)

  /**
   * A task enters the queue (4.1). It is kept in memory at once and written to the ledger's
   * queue (`queueTask`) before it can be dispatched, so a restarted scheduler rebuilds it. A
   * Secretary task runs in the lineage it handles (6.5).
   */
  submit(spec: TaskSpec): TaskRecord {
    const s = spec.secretaryFor !== undefined ? { ...spec, lineage: spec.secretaryFor.lineage } : spec;
    const t = this.tasks.add(s);
    if (this.genValue !== null) void this.persistQueued(t).catch((e: unknown) => this.onLoopError('queue', e));
    return t;
  }

  /** submit, then wait until the ledger has the task queued. */
  async submitDurable(spec: TaskSpec): Promise<TaskRecord> {
    const t = this.submit(spec);
    await this.persistQueued(t);
    return t;
  }

  /** The task's card: its spec in the content store (the ledger keeps the hash). */
  private cardOf(spec: TaskSpec): ReturnType<ContentStore['put']> {
    return this.content.put(canonicalJson({ format: 'mp4.task-card.v1', spec }));
  }

  /** Write a queued task to the ledger's queue. Idempotent: the op id names this queueing occurrence. */
  private async persistQueued(t: TaskRecord): Promise<void> {
    if (t.persisted || t.state !== 'queued') return;
    const info = await this.ledger.taskInfo(t.spec.task);
    if (info?.state === 'queued') {
      t.persisted = true;
      return;
    }
    await this.ledger.queueTask({
      op: `queue:${t.spec.task}:${info?.queuedRevision ?? 0}`,
      gen: this.gen,
      task: t.spec.task,
      lineage: t.spec.lineage,
      mission: t.spec.mission,
      card: this.cardOf(t.spec),
    });
    t.persisted = true;
  }

  /** Back into the queue (a retry, a grant, a restart, evidence in): in memory now, in the ledger before dispatch. */
  private requeue(t: TaskRecord, note: string): void {
    t.state = 'queued';
    t.note = note;
    t.persisted = false;
    void this.persistQueued(t).catch((e: unknown) => this.onLoopError('queue', e));
  }

  /** Rebuild the in-memory queue from the ledger's (a restarted scheduler, 4.1). */
  private async rebuildQueue(): Promise<void> {
    for (const q of await this.ledger.taskQueue()) {
      if (this.tasks.get(q.task)) continue;
      const spec = this.specOfCard(q.card);
      if (spec === null) continue;
      const t = this.tasks.add(spec);
      t.persisted = true;
      t.note = 'rebuilt from the ledger queue after a restart';
    }
  }

  /**
   * After a restart (4.1): tasks an earlier generation dispatched, never queued again, whose
   * launch has its final disposition (ledger `dispatchedTasks`): the same consequences as when
   * the outcome arrives, so "needs disposition", "exhausted" and "waiting for evidence" come
   * back without anyone queueing them again; a retryable failure the earlier generation did not
   * requeue yet is requeued. An accepted, handed-back task is done: not rebuilt.
   */
  /**
   * Everything the scheduler keeps in memory that the ledger can give back: the budget blocks,
   * the reservations of launches whose cleanup is not done (WI-14), the queue (4.1), the tasks
   * an earlier generation dispatched that still need something, and seat preparations that
   * never reached the ledger (r1 #11). Each step is idempotent; false when the ledger could not
   * answer (retried on the next dispatch pass, which waits for it).
   */
  private async recoverState(): Promise<boolean> {
    try {
      for (const b of await this.ledger.missionBlocks()) if (b.record.state === 'blocked') this.blocked.set(b.mission, b.record);
      const unfinished = new Map((await this.ledger.launches({ unfinished: true })).map((l) => [l.launch, l]));
      for (const m of allLaunchMeta(this.opts.stateDir)) {
        const l = unfinished.get(m.launch);
        if (l !== undefined && l.cleanup !== 'done' && m.demand !== undefined) this.reserved.set(m.launch, { demand: m.demand, unitName: m.unitName });
      }
      await this.rebuildQueue();
      await this.rebuildDispatched();
      await this.sweepPrepared();
      this.endedAcceptances = readEndedAcceptances(this.opts.stateDir);
      return true;
    } catch (e) {
      this.onLoopError('recover', e);
      return false;
    }
  }

  private async rebuildDispatched(): Promise<void> {
    // every task this ledger has dispatched comes back, so its status is never unknown after a
    // restart (the flows resubmit a task whose status is null): running ones (the reconciliation
    // decides them), done ones (routed again), and those that still need something
    for (const d of await this.ledger.dispatchedTasks({ disposed: false })) {
      if (this.tasks.get(d.task)) continue;
      if (d.disposition === null) {
        await this.ensureTask(d.task, d.launch);
        continue;
      }
      if (d.disposition === 'accepted') {
        const seat = (await this.ledger.pendingResults(d.launch)).find((r): r is SeatResultRecord => r.kind === 'seat.result') ?? null;
        if (seat === null || seat.status === 'handed-back') {
          const t = await this.ensureTask(d.task, d.launch);
          if (!t) continue;
          t.current = null;
          t.state = 'done';
          t.note = 'done (rebuilt from the ledger after a restart)';
          void this.route(t, d.launch).catch((e: unknown) => this.onLoopError('routing', e));
          continue;
        }
      }
      const t = await this.ensureTask(d.task, d.launch);
      if (!t) continue;
      t.note = 'rebuilt from the ledger after a restart';
      await this.onDecided(outcomeOfDisposition(d.launch, d.disposition, d.reason));
    }
  }

  /**
   * Dispatchable tasks: queued, every dependency done; for a stable task also proven (r1 #2):
   * a dependency counts only once its accepted result was routed "continue" with the label
   * "proven" by the evaluator. Otherwise the task waits (5.4: a stable dispatch waits for its
   * prerequisites to be proven); the hold is noted for the PM.
   */
  private readyTasks(): TaskRecord[] {
    return this.tasks.ready().filter((t) => {
      if (t.spec.mode !== 'stable') return true;
      for (const d of t.spec.dependsOn) {
        const step = this.nextSteps.get(d);
        if (step?.kind === 'continue' && step.label === 'proven') continue;
        const why = step === undefined ? 'its result is still being routed' : step.kind === 'continue' ? `its label is ${step.label}` : `its next step is ${step.kind}${'reason' in step ? ` (${step.reason})` : ''}`;
        this.proofHolds.set(t.spec.task, { dep: d, why, step: step?.kind ?? 'routing' });
        this.waiting.set(t.spec.task, { mission: t.spec.mission, task: t.spec.task, reason: `waiting: dependency ${d} is not proven (${why})` });
        return false;
      }
      this.proofHolds.delete(t.spec.task);
      return true;
    });
  }

  /** One informational notice per held stable task and reason (5.4: waiting is the rule, not an exception). */
  private async noticeProofHolds(): Promise<void> {
    for (const [task, h] of this.proofHolds) {
      if (h.step === 'routing') continue;
      const t = this.tasks.get(task);
      if (!t || t.state !== 'queued') continue;
      await this.alerts.raise({
        category: 'stable-dispatch-waits-for-proof',
        wi: null,
        key: `${task}:${h.dep}:${h.step}`,
        trigger: `stable task ${task} depends on ${h.dep}, which is not proven: ${h.why}`,
        defaultAction: `task ${task} is not dispatched until ${h.dep}'s result is proven (it is checked again after every publication); fast-mode and unrelated work continue`,
        detail: { task, dependency: h.dep, why: h.why, options: [`re-accept (or rerun) ${h.dep} on the current versions (Secretary)`, `run ${task} in fast mode: its result is then "not fully proven"`, `abandon ${task}`] },
      });
    }
  }

  /**
   * Dependencies of queued tasks that this scheduler does not hold: finished under an earlier
   * generation (r1 #6). From the ledger: dispatched, accepted, and handed back (a seat) are
   * done; their next step is routed again (the evaluator's labels).
   */
  private async restoreDependencies(): Promise<void> {
    const missing = new Set<string>();
    for (const t of this.tasks.all()) if (t.state === 'queued') for (const d of t.spec.dependsOn) if (!this.tasks.get(d)) missing.add(d);
    for (const d of missing) {
      try {
        const info = await this.ledger.taskInfo(d);
        if (info === null || info.state !== 'dispatched' || info.launch === null || info.launch === undefined) continue;
        if ((await this.ledger.dispositionFor(info.launch)) !== 'accepted') continue;
        const seat = (await this.ledger.pendingResults(info.launch)).find((r): r is SeatResultRecord => r.kind === 'seat.result') ?? null;
        if (seat !== null && seat.status !== 'handed-back') continue;
        const t = await this.ensureTask(d, info.launch);
        if (!t) continue;
        if (t.current === info.launch) t.current = null;
        t.state = 'done';
        t.note = 'done (restored from the ledger after a restart)';
        void this.route(t, info.launch).catch((e: unknown) => this.onLoopError('routing', e));
      } catch (e) {
        if (isStale(e)) throw e;
        /* the ledger cannot answer now: the dependent keeps waiting; tried again next pass */
      }
    }
  }

  /**
   * 6.6 关闭: production stops on a closed mission. Queued (and waiting) production tasks leave the
   * queue; running ones are cancelled unless the close waits for running units (their results
   * are then refused as cancelled); post-close work (audits, deliveries and their conflict
   * integration, repairs after an audit) still starts.
   */
  private async applyMissionCloses(): Promise<void> {
    const closed = await this.ledger.missions('closed');
    const next = new Map<MissionId, { waitRunning: boolean; closes: number }>();
    for (const m of closed) {
      const known = this.closedMissions.get(m.mission);
      if (known !== undefined && known.closes === m.closes) {
        next.set(m.mission, known);
        continue;
      }
      const last = (await this.ledger.missionCloses(m.mission)).at(-1);
      next.set(m.mission, { waitRunning: last?.waitRunning ?? false, closes: m.closes });
    }
    this.closedMissions = next;
    for (const t of this.tasks.all()) {
      const c = this.closedMissions.get(t.spec.mission);
      if (c === undefined || this.allowedAfterClose(t.spec)) continue;
      if (t.state === 'running') {
        if (!c.waitRunning && t.current !== null) this.stopForClose(t, t.current);
        continue;
      }
      if (t.state !== 'done' && t.state !== 'abandoned') await this.cancelForClose(t);
    }
  }

  /** Post-close work (6.6): marked so by its author, or a post-hoc audit seat. */
  private allowedAfterClose(spec: TaskSpec): boolean {
    if (spec.afterClose !== undefined) return true;
    if (spec.seat === undefined) return false;
    try {
      return seatCardKind(this.content, spec.seat.card).startsWith('auditor');
    } catch {
      return false;
    }
  }

  private async cancelForClose(t: TaskRecord): Promise<void> {
    if (!(await this.cancelTask(t.spec.task))) return;
    t.note = `cancelled: mission ${t.spec.mission} is closed (6.6)`;
  }

  private readonly closeStopped = new Set<LaunchId>();

  /** A running production unit of a closed mission (the close does not wait for it): ended; its result is refused. */
  private stopForClose(t: TaskRecord, launch: LaunchId): void {
    if (this.closeStopped.has(launch)) return;
    this.closeStopped.add(launch);
    t.note = `cancelling: mission ${t.spec.mission} is closed (6.6)`;
    const unitName = readLaunchMeta(this.opts.stateDir, launch)?.unitName ?? unitNameOf(launch);
    void this.units.stop(unitName, 30_000).catch(() => undefined);
  }

  /** The mission a launch's result is cancelled for (6.6), or null. */
  private closedFor(launch: LaunchId, mission: MissionId): string | null {
    const c = this.closedMissions.get(mission);
    if (c === undefined || c.waitRunning) return null;
    const task = readLaunchMeta(this.opts.stateDir, launch)?.task ?? null;
    const t = task !== null ? this.tasks.get(task) : undefined;
    if (t !== undefined && this.allowedAfterClose(t.spec)) return null;
    return mission;
  }

  /**
   * 6.5, WI-08: the lineage's environment retries are exhausted, so no new attempt of it runs,
   * whatever its task id (r1 #8). The loops counted when an attempt starts (restarts, returns,
   * rebuilds, landings) are refused by the ledger at their next start (LOOP_EXHAUSTED); their
   * "exhausted" means that the attempt just counted was the last, which may still run.
   */
  private async lineageExhausted(lineage: string): Promise<LoopVerdict | null> {
    const v = await this.loops.verdict(lineage, 'env-retry');
    return v.exhausted ? v : null;
  }

  /** Host entries stay until the launch's cleanup is done (the stop report and the watchdog read them, r1 #3). */
  private async sweepHosts(): Promise<void> {
    for (const h of this.cp.hosts()) {
      if (this.dispatching.has(h.launch)) continue;
      const l = (await this.ledger.launches({ launch: h.launch }))[0];
      if (l !== undefined && l.cleanup === 'done') {
        this.cp.removeHost(h.launch);
        removePrepared(this.opts.stateDir, h.launch);
      }
    }
  }

  /**
   * Seat preparations (an image, a directory) whose launch never reached the ledger: a crash
   * or a refusal between admission and registration (r1 #11). Released through the exec
   * cleanup with the identities bound at preparation; kept (and reserved) while that fails.
   */
  private async sweepPrepared(): Promise<void> {
    const records = readPrepared(this.opts.stateDir);
    // a seat directory with no preparation record (a crash between creating it and recording it):
    // without its identity it is never deleted (it may not be ours); the PM is told once (WI-20)
    for (const name of listDirs(join(this.opts.stateDir, 'seats'))) {
      const launch = name as LaunchId;
      if (records.some((r) => r.launch === launch) || this.dispatching.has(launch) || this.preparedSeats.has(launch)) continue;
      if ((await this.ledger.launches({ launch }))[0] !== undefined) continue;
      await this.alerts.raise({
        category: 'seat-dir-unrecorded',
        wi: 'WI-20',
        key: launch,
        trigger: `${join(this.opts.stateDir, 'seats', name)} belongs to no registered launch and has no preparation record (a crash while it was being prepared)`,
        defaultAction: 'left as it is (without a recorded identity it is never deleted); nothing else is affected',
        detail: { path: join(this.opts.stateDir, 'seats', name), options: ['delete it by hand once no process uses it', 'leave it'] },
      });
    }
    for (const r of records) {
      if (this.dispatching.has(r.launch) || this.preparedSeats.has(r.launch) || [...this.unconfirmed.values()].includes(r.launch)) continue;
      const known = (await this.ledger.launches({ launch: r.launch }))[0];
      if (known !== undefined) {
        if (known.cleanup === 'done') removePrepared(this.opts.stateDir, r.launch);
        continue;
      }
      const res = await cleanupPass(r.resources, { roots: [join(this.opts.stateDir, 'seats')] });
      if (res.left.length === 0) {
        removePrepared(this.opts.stateDir, r.launch);
        this.reserved.delete(r.launch);
        continue;
      }
      if (r.demand !== null) this.reserved.set(r.launch, { demand: r.demand, unitName: unitNameOf(r.launch) });
      if (res.refusals.length > 0) {
        await this.alerts.raise({
          category: 'prepared-cleanup-failing',
          wi: res.refusals.some((x) => x.reason === 'identity-mismatch' || x.reason === 'identity-unknown') ? 'WI-20' : 'WI-14',
          key: `${r.launch}:${res.left.length}`,
          trigger: `the seat preparation of ${r.launch} (never registered) could not be released: ${res.refusals.map((x) => x.detail).join('; ')}`,
          defaultAction: 'kept and counted in the reservations; retried on every cleanup pass; other work continues',
          detail: { launch: r.launch, left: res.left, refusals: res.refusals },
        });
      }
    }
  }

  /** WI-11: an acceptance ended with "the derived state cannot be computed" (persisted, one notice per attempt). */
  private async acceptanceEnded(launch: LaunchId, why: string): Promise<void> {
    const cur = this.endedAcceptances[launch];
    if (cur?.ended === true) return;
    const next: EndedAcceptance = cur === undefined ? { attempt: 1, retryOf: null, ended: true, reason: why, at: this.now() } : { ...cur, ended: true, reason: why, at: this.now() };
    this.endedAcceptances[launch] = next;
    writeEndedAcceptances(this.opts.stateDir, this.endedAcceptances);
    const t = await this.taskOf(launch);
    if (t) t.note = `acceptance attempt ${next.attempt} of ${launch} ended: ${why}; registered again after the next publication`;
    await this.alerts.raise({
      category: 'acceptance-ended-derived-state',
      wi: 'WI-11',
      key: `${launch}:accept-${next.attempt}`,
      trigger: `accepting ${launch} needs the evaluator's continuation check (5.2 part 5): ${why}`,
      defaultAction: 'this acceptance ended, nothing is held; after the next successful publication it is registered again as a new attempt that names this one; everything else continues',
      detail: { launch, task: t?.spec.task ?? null, attempt: next.attempt, retryOf: next.retryOf },
    });
  }

  /** After a publication: every ended acceptance becomes a new attempt linked to the ended one. */
  private reregisterEndedAcceptances(): void {
    let changed = false;
    for (const [launch, e] of Object.entries(this.endedAcceptances)) {
      if (!e.ended) continue;
      this.endedAcceptances[launch] = { attempt: e.attempt + 1, retryOf: e.attempt, ended: false, reason: e.reason, at: this.now() };
      changed = true;
    }
    if (changed) {
      writeEndedAcceptances(this.opts.stateDir, this.endedAcceptances);
      void this.reconcileRunner.kick();
    }
  }

  /** The acceptance record of a decided launch is no longer needed. */
  private forgetAcceptance(launch: LaunchId): void {
    if (this.endedAcceptances[launch] === undefined) return;
    delete this.endedAcceptances[launch];
    writeEndedAcceptances(this.opts.stateDir, this.endedAcceptances);
  }

  /** 5.2 part 5: the basis lines a continuation review's task declared as changed. */
  private async changedLinesOf(launch: LaunchId): Promise<readonly string[]> {
    const meta = readLaunchMeta(this.opts.stateDir, launch);
    if (!meta?.task) return [];
    const t = this.tasks.get(meta.task) ?? (await this.ensureTask(meta.task, launch));
    return t?.spec.changedLines ?? [];
  }

  private specOfCard(card: string): TaskSpec | null {
    try {
      const doc = JSON.parse(this.content.get(contentHash(card)).toString('utf8')) as { format?: string; spec?: TaskSpec };
      return doc.format === 'mp4.task-card.v1' && doc.spec !== undefined ? doc.spec : null;
    } catch {
      return null;
    }
  }

  /** A task this scheduler does not hold in memory (dispatched by an earlier generation): from its ledger card. */
  private async ensureTask(task: string, launch: LaunchId): Promise<TaskRecord | undefined> {
    const known = this.tasks.get(task);
    if (known) return known;
    const info = await this.ledger.taskInfo(task);
    if (info === null) return undefined;
    const spec = this.specOfCard(info.card);
    if (spec === null) return undefined;
    const t = this.tasks.add(spec);
    t.persisted = info.state === 'queued';
    if (info.state === 'dispatched') {
      this.tasks.bindLaunch(t, info.launch ?? launch);
      t.state = 'running';
    } else if (info.state !== 'queued') {
      t.state = 'abandoned';
    }
    return t;
  }

  /** The PM or the Secretary gives a task up: it leaves the ledger's queue ("cancelled"). */
  async cancelTask(task: string): Promise<boolean> {
    const t = this.tasks.get(task);
    if (!t || t.state === 'running') return false;
    const info = await this.ledger.taskInfo(task);
    if (info?.state === 'queued') await this.ledger.dequeueTask({ op: `dequeue:${task}:cancelled:${info.queuedRevision}`, gen: this.gen, task, reason: 'cancelled' });
    t.state = 'abandoned';
    t.note = 'cancelled';
    return true;
  }

  /** The PM records the user's answer (WI-12, v42): any missing stop is submitted first, then this resumes. */
  async confirmResume(req: { op?: string; answer?: string } = {}): Promise<void> {
    await this.ledger.confirmResume(req);
    this.paused = false;
  }

  /** The Secretary (or the user) grants extra attempts to an exhausted loop (6.5). */
  async grant(req: { lineage: string; loop: LoopKind; by: 'secretary' | 'user'; extra: number; reason: string; op: string }): Promise<{ granted: boolean; why?: string }> {
    const g = await this.loops.grant({ ...req, gen: this.gen });
    if (!g.granted) return { granted: false, why: g.why };
    // only the tasks stopped by the granted loop, once it and the lineage's environment retries
    // are no longer exhausted (a grant on another loop frees nothing, r1 #8)
    const v = await this.loops.verdict(req.lineage, req.loop);
    const env = await this.lineageExhausted(req.lineage);
    const free = !v.exhausted && (env === null || req.loop === 'env-retry');
    if (free) {
      for (const t of this.tasks.all()) {
        if (t.spec.lineage !== req.lineage || t.state !== 'exhausted' || (t.exhaustedBy ?? 'env-retry') !== req.loop) continue;
        t.exhaustedBy = null;
        this.requeue(t, `granted ${req.extra} more by ${req.by}`);
      }
    }
    return { granted: true, ...(!free ? { why: `lineage ${req.lineage} is still exhausted on ${v.exhausted ? req.loop : 'env-retry'}` } : {}) };
  }

  /**
   * The Secretary restarts a task that needs disposition (v42 6.2, 6.5: quarantine and seat
   * failure share one cap of 2). A result quarantined because of a stop is never restarted;
   * a resource overflow is restarted only with a changed declaration (resubmit the task).
   */
  async restartQuarantined(task: string, signature: string): Promise<LoopVerdict | null> {
    const t = this.tasks.get(task);
    if (!t || t.state !== 'needs-disposition') return null;
    if (t.disposition === 'stop' || t.disposition === 'resource-exceeded') return null;
    const last = t.launches.at(-1) ?? task;
    const pre = await this.loops.verdict(t.spec.lineage, 'quarantine-restart');
    if (pre.exhausted) {
      t.state = 'exhausted';
      t.exhaustedBy = 'quarantine-restart';
      t.note = `quarantine restarts exhausted (${pre.reason})`;
      await this.loops.escalate(pre, { task });
      return pre;
    }
    const v = await this.loops.attempt({ op: `loop-attempt:quarantine-restart:${last}`, gen: this.gen, lineage: t.spec.lineage, loop: 'quarantine-restart', failureClass: null, signature });
    t.disposition = null;
    this.requeue(t, `restarted after ${signature} (${v.attempts}/${v.allowed})`);
    return v;
  }

  // ---------------------------------------------------------------- reconciliation

  private async reconcilePass(): Promise<void> {
    if (this.stale) return;
    // consequences whose ledger writes failed last time (e.g. a lost response): same op ids again
    for (const o of this.undelivered.splice(0)) await this.deliver(o);
    await this.takeover.submitLeftProofs();
    const open = await this.ledger.openLaunches();
    await Promise.all(
      open.map(async (l) => {
        if (this.dispatching.has(l.launch)) return;
        const st = await this.takeover.reconcile(l);
        if (st.kind === 'decided') await this.deliver(st.outcome);
        else if (st.kind === 'running') await this.markRunning(l.launch);
      }),
    );
  }

  /** The final disposition is committed; its consequences are retried until they are (idempotent by op id). */
  private async deliver(o: AttemptOutcome): Promise<void> {
    try {
      await this.onDecided(o);
    } catch (e) {
      if (isStale(e)) throw e;
      this.undelivered.push(o);
      this.onLoopError('outcome', e);
    }
  }

  private async markRunning(launch: LaunchId): Promise<void> {
    const t = await this.taskOf(launch);
    if (t && t.state !== 'running' && t.current === launch) t.state = 'running';
  }

  private async taskOf(launch: LaunchId): Promise<TaskRecord | undefined> {
    const t = this.tasks.ofLaunch(launch);
    if (t) return t;
    const meta = readLaunchMeta(this.opts.stateDir, launch);
    if (!meta?.task) return undefined;
    return this.ensureTask(meta.task, launch);
  }

  /** The consequences of an attempt's final disposition for its task (6.2 table, 6.5 loops). */
  private async onDecided(outcome: AttemptOutcome): Promise<void> {
    if (!this.outcomes.some((o) => o.launch === outcome.launch && o.kind === outcome.kind)) this.outcomes.push(outcome);
    this.forgetAcceptance(outcome.launch);
    this.awaitingEvaluator.delete(outcome.launch);
    const meta = readLaunchMeta(this.opts.stateDir, outcome.launch);
    const t = await this.taskOf(outcome.launch);
    const lineage = t?.spec.lineage ?? meta?.lineage ?? null;
    if (t && t.current === outcome.launch) t.current = null;
    switch (outcome.kind) {
      case 'accepted': {
        if (!t) return;
        // A seat's hand-back status (its pending seat.result, now a base record) decides the next step.
        const seat = (await this.ledger.pendingResults(outcome.launch)).find((r): r is SeatResultRecord => r.kind === 'seat.result') ?? null;
        await this.onAccepted(t, outcome.launch, seat, lineage);
        return;
      }
      case 'already': {
        if (t && t.state === 'running') {
          t.state = outcome.disposition === 'accepted' ? 'done' : 'needs-disposition';
          t.note = `final disposition ${outcome.disposition} (made earlier)`;
        }
        return;
      }
      case 'cancelled': {
        if (outcome.closedMission !== undefined) {
          // 6.6: the mission closed while it ran; nothing to quarantine or restart
          if (t) {
            t.state = 'abandoned';
            t.note = `cancelled: mission ${outcome.closedMission} closed while it ran (6.6)`;
          }
          return;
        }
        if (outcome.endedByStop === true) {
          // 6.4: the stop ended the unit: stopped (the stop's own report says so); no result to quarantine, no WI-15
          if (t) {
            t.state = 'needs-disposition';
            t.disposition = 'stop';
            t.note = `stopped by ${outcome.stops.join(', ') || 'a stop since released'}`;
            this.nextSteps.set(t.spec.task, routeQuarantined('cancelled by a stop'));
          }
          return;
        }
        if (t) {
          t.state = 'needs-disposition';
          t.disposition = 'stop';
          t.note = `quarantined: the result arrived under stop ${outcome.stops.join(', ')}; not restarted (the stop comes first)`;
          this.nextSteps.set(t.spec.task, routeQuarantined('cancelled by a stop'));
        }
        await this.alerts.raise({
          category: 'attempt-quarantined',
          wi: 'WI-15',
          key: outcome.launch,
          trigger: `the result of ${outcome.launch} arrived under stop ${outcome.stops.join(', ')}: refused and quarantined (6.1, 6.2)`,
          defaultAction: `the result is kept in quarantine; ${t ? `task ${t.spec.task}` : 'its task'} is not restarted while the stop holds (v42: a stop-quarantined result never is); nothing else is affected`,
          detail: { launch: outcome.launch, task: t?.spec.task ?? null, lineage, stops: outcome.stops },
        });
        return;
      }
      case 'failed':
        await this.onFailed(outcome, t, lineage);
        return;
    }
  }

  /**
   * An accepted attempt (its facts are base records now). A unit without a seat, or a seat
   * that handed back, is done and routed by its labels (6.2). Other hand-back statuses:
   *   needs-evidence      the session ended and released its reservation; the task waits,
   *                       holding nothing, until the evidence is in (6.2 async)
   *   environment-failure, timed-out   the env-retry loop (6.5)
   *   seat-failure, resource-exceeded, cancelled   the Secretary decides ("needs disposition")
   */
  private async onAccepted(t: TaskRecord, launch: LaunchId, seat: SeatResultRecord | null, lineage: string | null): Promise<void> {
    const status = seat?.status ?? 'handed-back';
    // the flows take the accepted hand-back on (whatever its status)
    void this.flowRunner.kick();
    if (status === 'handed-back') {
      t.state = 'done';
      t.note = 'accepted';
      void this.route(t, launch).catch((e: unknown) => this.onLoopError('routing', e));
      return;
    }
    if (status === 'needs-evidence') {
      t.state = 'waiting-evidence';
      t.note = `needs evidence (${seat?.evidenceRequest ?? 'no request document'}); no reservation is held while waiting`;
      return;
    }
    if ((status === 'environment-failure' || status === 'timed-out' || status === 'resource-exceeded') && lineage !== null) {
      // v42 WI-15: environment failures are redispatched automatically; resource overflow (the
      // export over its cap) is counted in the resource class and goes to the Secretary
      const failure: FailureKind = status === 'timed-out' ? 'timed-out' : status === 'resource-exceeded' ? 'resource-exceeded' : 'environment-failure';
      await this.onFailed({ kind: 'failed', launch, failure, detail: `seat ${status}`, signature: `seat:${status}` }, t, lineage);
      return;
    }
    t.state = 'needs-disposition';
    t.disposition = status === 'cancelled' ? 'stop' : 'seat-failure';
    t.note = `seat ${status}`;
    this.nextSteps.set(t.spec.task, { kind: 'secretary', reason: `the seat ended with ${status}` });
    // 6.4: a seat the stop ended is stopped, not a failure: no WI-15 notice
    if (status === 'cancelled' && readEndedByStop(this.opts.stateDir, launch) !== null) return;
    await this.alerts.raise({
      category: 'seat-ended-without-hand-back',
      wi: 'WI-15',
      key: launch,
      trigger: `the seat of ${launch} ended with ${status}`,
      defaultAction: `task ${t.spec.task} needs a decision (retry within the caps; more resources for "resource-exceeded"; WI-08 when exhausted); nothing else is affected`,
      detail: { launch, task: t.spec.task, lineage, status },
    });
  }

  /** The evidence a seat asked for is in: its continuation is queued again (6.2 async). */
  async resumeAfterEvidence(task: string, evidence = ''): Promise<boolean> {
    const t = this.tasks.get(task);
    if (!t || t.state !== 'waiting-evidence') return false;
    const seat = t.spec.seat;
    const last = t.launches.at(-1);
    if (seat !== undefined && last !== undefined) {
      // a continuation, not the same card again (6.2, r1 #10): the session to resume (the host's
      // outcome), the state it saved (its seat.result), the evidence results; the reservation
      // then includes the restored copy of the state (resumesFromState)
      const result = (await this.ledger.pendingResults(last)).find((r): r is SeatResultRecord => r.kind === 'seat.result') ?? null;
      const sessionId = readSeatOutcome(this.opts.stateDir, last)?.sessionId ?? null;
      const state = sessionId === null ? null : (result?.recoveryState ?? null);
      if (state === null) {
        // WI-17: a new session; the card gives what the ledger has and the evidence results
        await this.alerts.raise({
          category: 'recovery-state-missing',
          wi: 'WI-17',
          key: `${task}:${last}`,
          trigger: `task ${task}: the round of ${last} cannot be continued (${sessionId === null ? 'no session id was recorded' : 'no recovery state was kept'})`,
          defaultAction: 'a new session continues the task; its card carries the evidence results and what the ledger holds; this degradation is recorded',
          detail: { task, launch: last, sessionId, recoveryState: result?.recoveryState ?? null },
        });
      }
      const resume = { sessionId: sessionId ?? 'none', state, evidence };
      const spec: TaskSpec = { ...t.spec, seat: { ...seat, resume, demand: { ...seat.demand, resumesFromState: state !== null } } };
      (t as { spec: TaskSpec }).spec = spec;
    }
    this.requeue(t, 'continuing after evidence');
    return true;
  }

  private async onFailed(outcome: Extract<AttemptOutcome, { kind: 'failed' }>, t: TaskRecord | undefined, lineage: string | null): Promise<void> {
    const retryable: readonly FailureKind[] = ['no-proof', 'environment-failure', 'timed-out', 'heartbeat-lost'];
    if (outcome.failure === 'continuation-refused' || outcome.failure === 'renewal-refused') {
      // 5.2 part 5 / 5.3, a normal branch (not an exception, no WI): a full review instead
      const what =
        outcome.failure === 'continuation-refused'
          ? 'the evaluator refused the continuation judgment (5.2 part 5)'
          : 'a renewal among the results does not meet the renewal rule (5.3)';
      if (t) {
        t.state = 'needs-disposition';
        t.disposition = 'full-review';
        t.note = `${what}: ${outcome.detail}`;
        this.nextSteps.set(t.spec.task, routeFullReview(`${what}: give the position a full review (a new judgment), not a continuation`));
      }
      await this.alerts.raise({
        category: 'full-review-needed',
        wi: null,
        key: outcome.launch,
        trigger: `${outcome.launch}: ${what}: ${outcome.detail}`,
        defaultAction: `the attempt ended "failed" with that reason (not counted as a retry); ${t ? `task ${t.spec.task}` : 'its task'} goes to a full review; nothing else is affected`,
        detail: { launch: outcome.launch, task: t?.spec.task ?? null, lineage, failure: outcome.failure, detail: outcome.detail },
      });
      return;
    }
    if (lineage === null) return;
    // v42 WI-15, by cause:
    //  - environment failure: quarantined result, automatic redispatch, env-retry (per class);
    //  - resource overflow: no automatic redispatch (it would overflow again); env-retry, resource class;
    //  - an invalid result (publication recheck refused it): quarantine; counted only when the
    //    Secretary restarts it (quarantine-restart).
    // Counted per lineage whether or not this scheduler still knows the task; the op id is
    // the launch, so a retry after a lost answer does not count twice.
    if (outcome.failure === 'result-invalid') {
      // the ledger's reason decides the instruction: a result too large is a resource matter
      // (WI-10), a scope that does not match its registration a consistency anomaly (WI-20)
      const code = outcome.signature.split(':')[1] ?? '';
      await this.alerts.raise({
        category: 'attempt-quarantined',
        wi: code === 'TOO_LARGE' ? 'WI-10' : code === 'SCOPE_MISMATCH' ? 'WI-20' : 'WI-15',
        key: outcome.launch,
        trigger: `the result of ${outcome.launch} was refused at publication: ${outcome.detail}`,
        defaultAction: `the result is kept in quarantine; ${t ? `task ${t.spec.task}` : 'its task'} needs a decision (restart through the Secretary, counted with seat failures; abandon; escalate)`,
        detail: { launch: outcome.launch, task: t?.spec.task ?? null, lineage, failure: outcome.failure },
      });
      if (t) {
        t.state = 'needs-disposition';
        t.disposition = 'quarantine';
        t.note = `quarantined: ${outcome.detail}`;
        this.nextSteps.set(t.spec.task, routeQuarantined(outcome.failure));
      }
      return;
    }
    const v = await this.loops.attempt({
      op: `loop-attempt:env-retry:${outcome.launch}`,
      gen: this.gen,
      lineage,
      loop: 'env-retry',
      failureClass: outcome.failure,
      signature: outcome.signature,
    });
    const retry = retryable.includes(outcome.failure);
    const action = !t
      ? 'counted toward the lineage cap; its task is not known to this scheduler'
      : !retry
        ? `not redispatched as it is (it would overflow again): task ${t.spec.task} needs a larger resource declaration or a smaller task (Secretary); nothing else is affected`
        : v.exhausted
          ? `lineage ${lineage} is exhausted (WI-08); the rest of the mission continues`
          : `retried automatically (${v.attempts}/${v.allowed} on this lineage)`;
    await this.alerts.raise({
      category: 'attempt-failed',
      wi: 'WI-15',
      key: outcome.launch,
      trigger: `attempt ${outcome.launch}: ${outcome.failure}: ${outcome.detail}`,
      defaultAction: action,
      detail: { launch: outcome.launch, task: t?.spec.task ?? null, lineage, failure: outcome.failure, signature: outcome.signature, loop: { attempts: v.attempts, allowed: v.allowed, exhausted: v.exhausted, reason: v.reason } },
    });
    if (!t) return;
    if (!retry) {
      t.state = 'needs-disposition';
      t.disposition = 'resource-exceeded';
      t.note = `quarantined: ${outcome.failure}: ${outcome.detail}`;
      this.nextSteps.set(t.spec.task, routeQuarantined(outcome.failure));
      return;
    }
    if (v.exhausted) {
      t.state = 'exhausted';
      t.exhaustedBy = 'env-retry';
      t.note = `environment retries exhausted (${v.reason}, ${v.attempts}/${v.allowed}): ${outcome.detail}`;
      await this.loops.escalate(v, { task: t.spec.task, failure: outcome.failure });
      return;
    }
    this.requeue(t, `retry after ${outcome.failure} (${v.attempts}/${v.allowed}): ${outcome.detail}`);
  }

  /** 6.2: the next step of an accepted result, from the evaluator's labels at a revision including it. */
  private async route(t: TaskRecord, launch: LaunchId): Promise<void> {
    const binds = t.spec.binds ?? [];
    if (binds.length === 0) {
      // nothing bound: nothing for the evaluator to prove
      this.nextSteps.set(t.spec.task, { kind: 'continue', label: 'proven' });
      return;
    }
    const prev = this.routeAttempts.get(t.spec.task) ?? null;
    const attempt = `${t.spec.task}#route-${(prev?.n ?? 0) + 1}`;
    this.routeAttempts.set(t.spec.task, { n: (prev?.n ?? 0) + 1, id: attempt });
    if (this.evaluatorFault !== null || this.evalQuery === null) {
      // WI-11 (v42): what needs "proven" ends with this reason, no waiting; routed again after
      // the next successful publication, as a new attempt naming the one it retries. Only the
      // evaluator's labels count as proof (6.1): without an evaluator nothing is "proven" (r1 #1).
      this.nextSteps.set(t.spec.task, { kind: 'ended', reason: 'the derived state cannot be computed', attempt, retryOf: prev?.id ?? null });
      this.endedForProven.set(t.spec.task, launch);
      if (this.evalQuery === null) {
        await this.alerts.raise({
          category: 'derived-state-unavailable',
          wi: 'WI-11',
          key: `${t.spec.task}:no-evaluator`,
          trigger: `task ${t.spec.task} bound ${binds.length} object(s), but no evaluator runs here: their labels cannot be derived (6.1)`,
          defaultAction: 'its next step ended with "the derived state cannot be computed"; stable dispatches that depend on it wait; work that needs no proof continues',
          detail: { task: t.spec.task, binds, options: ['configure and start the evaluator (it routes the step again after its first publication)', 'continue in fast mode: results stay "not fully proven"'] },
        });
      }
      return;
    }
    const head = await this.ledger.head();
    const deadline = this.now() + 60_000;
    let states: { revision: number; states: Record<string, { label: Label } | null> } | null = null;
    while (this.now() < deadline && !this.closing) {
      try {
        const s = (await this.evalQuery.call('targets', { ids: binds })) as { revision: number; states: Record<string, { label: Label } | null> };
        if (s.revision >= head) {
          states = s;
          break;
        }
      } catch {
        /* not ready yet */
      }
      await sleep(100);
    }
    if (states === null) {
      this.nextSteps.set(t.spec.task, { kind: 'secretary', reason: 'the derived state did not catch up in time; route manually' });
      return;
    }
    const labels = binds.map((b) => states.states[b]?.label ?? ('unaccepted' as Label));
    const step = routeAccepted({ mode: t.spec.mode, labels, judgmentsCurrent: [] });
    this.nextSteps.set(t.spec.task, step);
    void launch;
  }

  // ---------------------------------------------------------------- seats (9.3, 6.5)

  /** The startup self-check gate (9.3): seats only with a passing record; money limits only with item 9. */
  gate(): GateVerdict {
    if (this.selfCheckOverride !== null) return this.selfCheckOverride();
    if (this.opts.seats === undefined) {
      return { seatsAllowed: false, moneyModeAllowed: false, key: 'no-seat-installation', missing: [], failed: [], reason: 'no seat installation is configured (9.6)' };
    }
    return seatGate(this.opts.seats);
  }

  /**
   * The PM sets a mission's spend limit (6.5): a money limit only when the startup self-check's
   * item 9 passed (moneyModeAllowed), else it is refused with a WI-18 notice and the mission
   * stays `unlimited`.
   */
  async setSpendLimit(mission: MissionId, micros: number | null, op: string): Promise<{ set: boolean; why?: string }> {
    if (micros !== null) {
      const g = this.gate();
      if (!g.moneyModeAllowed) {
        await this.alerts.raise({
          category: 'money-limit-refused',
          wi: 'WI-18',
          key: `${mission}:${g.key}`,
          trigger: `a money spend limit for mission ${mission} was asked for, but the startup self-check's metering item (9) has not passed for these versions (${g.key})`,
          defaultAction: 'refused: the mission stays unlimited (the proxy still meters every request); the money form is offered once item 9 passes (6.5)',
          detail: { mission, micros, gate: g },
        });
        return { set: false, why: 'the money form needs a passing self-check item 9 (6.5, WI-18)' };
      }
    }
    await this.ledger.setSpendLimit(op, mission, micros);
    return { set: true };
  }

  // ---------------------------------------------------------------- dispatch

  private async dispatchPass(): Promise<void> {
    this.waiting.clear();
    if (this.stale || this.closing) return;
    if (!this.recovered) {
      this.recovered = await this.recoverState();
      if (!this.recovered) {
        for (const t of this.tasks.all().filter((x) => x.state === 'queued')) this.waiting.set(t.spec.task, { mission: t.spec.mission, task: t.spec.task, reason: 'waiting: the queue and reservations are being recovered from the ledger' });
        return;
      }
    }
    const blockedBy = this.dispatchBlockReason();
    if (blockedBy !== null) {
      for (const t of this.readyTasks()) this.waiting.set(t.spec.task, { mission: t.spec.mission, task: t.spec.task, reason: blockedBy });
      return;
    }
    // 6.6: closed missions stop production
    await this.applyMissionCloses().catch((e: unknown) => this.onLoopError('mission-close', e));
    // dependencies the scheduler does not hold (finished under an earlier generation, r1 #6)
    await this.restoreDependencies();
    // the ledger's queue first: a task is dispatched only once the ledger has it queued (4.1)
    for (const t of this.readyTasks()) {
      if (!t.persisted) await this.persistQueued(t).catch((e: unknown) => this.onLoopError('queue', e));
    }
    for (const [task, launch] of [...this.pendingDequeues]) await this.dequeueDispatched(task, launch);
    // registrations whose response was lost first: same op, same launch id
    for (const [task, launch] of [...this.unconfirmed]) {
      const t = this.tasks.get(task);
      if (t) await this.register(t, launch);
    }
    await this.releaseReservations();
    this.gateNow = null;
    const spendRefused = new Map<MissionId, TaskRecord[]>();
    const spendAdmitted = new Set<MissionId>();
    const maxRunning = this.opts.maxRunning ?? Number.POSITIVE_INFINITY;
    await this.noticeProofHolds();
    for (const t of this.readyTasks()) {
      if (this.stale || this.paused) return;
      if (this.unconfirmed.has(t.spec.task)) continue; // its registration is retried above, never replaced
      if (!t.persisted) {
        this.waiting.set(t.spec.task, { mission: t.spec.mission, task: t.spec.task, reason: 'waiting for the ledger to queue it' });
        continue;
      }
      if (this.tasks.running().length >= maxRunning) {
        this.waiting.set(t.spec.task, { mission: t.spec.mission, task: t.spec.task, reason: 'waiting for a free slot' });
        continue;
      }
      const tag: ScopeTag = { mission: t.spec.mission, capabilities: [...t.spec.capabilities] };
      if (await this.stops.covers(tag)) {
        t.note = 'held: a stop covers it';
        this.waiting.set(t.spec.task, { mission: t.spec.mission, task: t.spec.task, reason: t.note });
        continue;
      }
      if (this.blocked.has(t.spec.mission) && t.spec.paid) {
        t.state = 'budget-blocked';
        continue;
      }
      if (this.closedMissions.has(t.spec.mission) && !this.allowedAfterClose(t.spec)) {
        await this.cancelForClose(t);
        continue;
      }
      // 6.5, WI-08: an exhausted lineage stops, whatever the task id of its next attempt (r1 #8);
      // the Secretary task deciding on that lineage (6.5 "耗尽之后": its one grant) is not an attempt of it (e2e W1)
      const ex = t.spec.secretaryFor !== undefined ? null : await this.lineageExhausted(t.spec.lineage);
      if (ex !== null) {
        t.state = 'exhausted';
        t.exhaustedBy = ex.loop;
        t.note = `lineage ${t.spec.lineage} is exhausted (${ex.loop}: ${ex.reason}, ${ex.attempts}/${ex.allowed})`;
        await this.loops.escalate(ex, { task: t.spec.task, at: 'dispatch' });
        continue;
      }
      if (t.spec.seat !== undefined) {
        // 9.3: no seat without a passing startup self-check for the toolchain in use (WI-18)
        this.gateNow ??= this.gate();
        if (!this.gateNow.seatsAllowed) {
          t.note = `held: ${this.gateNow.reason ?? 'no passing startup self-check'}`;
          this.waiting.set(t.spec.task, { mission: t.spec.mission, task: t.spec.task, reason: t.note });
          await this.alerts.raise({
            category: 'seats-held-selfcheck',
            wi: 'WI-18',
            key: this.gateNow.key,
            trigger: this.gateNow.reason ?? 'no passing startup self-check (9.3)',
            defaultAction: 'no seat is started; work that needs no seat (queries, stops, cleanup, program runs, landings) goes on',
            detail: { key: this.gateNow.key, missing: this.gateNow.missing, failed: this.gateNow.failed },
          });
          continue;
        }
        // 7.1: the writable area is decided now; a large-disk unit without fuse2fs (or without FUSE
        // mounts in a private namespace, v49) is a resource block. A 'materials' seat has none.
        const needsArea = this.seatNeedsArea(t.spec.seat.card);
        const plan = this.opts.seats === undefined ? null : needsArea === false ? { kind: 'tmpfs' as const } : seatAreaPlan(t.spec.seat.demand, await this.areaTools());
        if (plan === null || plan.kind === 'resource-blocked') {
          t.state = 'blocked';
          t.note = `resource blocked: ${plan?.reason ?? 'no seat installation'}`;
          await this.alerts.raise({
            category: 'resource-block',
            wi: 'WI-10',
            key: `${t.spec.task}:area`,
            trigger: plan?.reason ?? 'no seat installation (9.6)',
            defaultAction: `task ${t.spec.task} is not dispatched (no other degradation path, 7.1); everything else goes on; install the missing tools or have Architect shrink the task`,
            detail: { task: t.spec.task, missing: plan?.kind === 'resource-blocked' ? plan.missing : [] },
          });
          continue;
        }
      }
      if (t.spec.snapshot && this.lfsCheck) {
        const lfs = await this.lfsCheck(t.spec);
        if (!lfs.ok) {
          // WI-13: held, rechecked on every pass (it runs once the user has fetched the objects)
          t.note = lfs.hint ?? 'Git LFS objects missing locally';
          this.waiting.set(t.spec.task, { mission: t.spec.mission, task: t.spec.task, reason: `held: ${t.note}` });
          await this.alerts.raise({
            category: 'lfs-objects-missing',
            wi: 'WI-13',
            key: `${t.spec.task}:${t.spec.snapshot.commit}`,
            trigger: `Git LFS objects of ${t.spec.snapshot.commit} are not available locally (7.1 v34)`,
            defaultAction: `task ${t.spec.task} is not dispatched; everything else continues; it is retried after \`git lfs fetch\``,
            detail: { task: t.spec.task, hint: lfs.hint },
          });
          continue;
        }
      }
      if (t.spec.paid) {
        const s = await this.ledger.spendSummary(t.spec.mission);
        if (!spendAdmits(s, t.spec.estimateMicros)) {
          const l = spendRefused.get(t.spec.mission) ?? [];
          l.push(t);
          spendRefused.set(t.spec.mission, l);
          continue;
        }
        spendAdmitted.add(t.spec.mission);
      }
      const inflight = [...this.reserved.values()].map((r) => ({ demand: r.demand, cgroup: derivedUnitCgroupPath(r.unitName) }));
      const adm = this.admission.check(this.demandOf(t.spec), inflight);
      if (!adm.admitted) {
        if (adm.decision === 'wait') {
          t.note = 'waiting for resources';
          this.waiting.set(t.spec.task, { mission: t.spec.mission, task: t.spec.task, reason: `waiting for resources: ${adm.shortfalls.map((s) => `${s.resource} -${s.missing}`).join(', ')}` });
        } else {
          t.state = 'blocked';
          t.note = `resource blocked: needs more than the machine has (${adm.shortfalls.map((s) => s.resource).join(', ')})`;
          await this.alerts.raise({
            category: 'resource-block',
            wi: 'WI-10',
            key: t.spec.task,
            trigger: `task ${t.spec.task} needs more than the whole machine has (6.5)`,
            defaultAction: 'progress is saved; this task waits in "resource blocked"; everything else that fits keeps running',
            detail: { task: t.spec.task, mission: t.spec.mission, shortfalls: adm.shortfalls },
          });
        }
        continue;
      }
      await this.launch(t);
    }
    await this.budgetPass(spendRefused, spendAdmitted);
  }

  /** A launch's reservation ends when its cleanup is done, not at its disposition (WI-14). */
  private async releaseReservations(): Promise<void> {
    if (this.reserved.size === 0) return;
    let unfinished: Set<LaunchId>;
    try {
      unfinished = new Set((await this.ledger.launches({ unfinished: true })).filter((l) => l.cleanup !== 'done').map((l) => l.launch));
    } catch {
      return;
    }
    for (const l of [...this.reserved.keys()]) if (!unfinished.has(l)) this.reserved.delete(l);
  }

  /** The dispatched task leaves the ledger's queue (retried until the ledger has it). */
  private async dequeueDispatched(task: string, launch: LaunchId): Promise<void> {
    try {
      await this.ledger.dequeueTask({ op: `dequeue:${task}:${launch}`, gen: this.gen, task, reason: 'dispatched', launch });
      this.pendingDequeues.delete(task);
    } catch (e) {
      if (errorCode(e) === 'NOT_QUEUED') {
        this.pendingDequeues.delete(task);
        return;
      }
      this.pendingDequeues.set(task, launch);
      if (isStale(e)) throw e;
    }
  }

  reservedLaunches(): LaunchId[] {
    return [...this.reserved.keys()];
  }

  private newLaunchId(t: TaskRecord): LaunchId {
    const base = t.spec.task.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    return id<LaunchId>(`${base}.${t.attempts + 1}.${randomBytes(4).toString('hex')}`);
  }

  private async launch(t: TaskRecord): Promise<void> {
    const launch = this.newLaunchId(t);
    const tag: ScopeTag = { mission: t.spec.mission, capabilities: [...t.spec.capabilities] };
    const meta: LaunchMeta = {
      format: 'mp4.launch-meta.v1',
      launch,
      task: t.spec.task,
      lineage: t.spec.lineage,
      tag,
      unitName: unitNameOf(launch),
      seatUnit: t.spec.unit.seatUnit,
      heartbeat: t.spec.unit.heartbeat,
      gen: this.gen,
      dispatchedAt: this.now(),
      timeoutMs: t.spec.unit.timeoutMs ?? null,
      mode: t.spec.mode,
      demand: this.demandOf(t.spec),
    };
    writeLaunchMeta(this.opts.stateDir, meta);
    if (t.spec.seat !== undefined && this.opts.seats !== undefined) {
      // admission's side effects: the image (allocated now), the host and supervisor configs
      const plan = this.seatNeedsArea(t.spec.seat.card) === false ? null : seatAreaPlan(t.spec.seat.demand, await this.areaTools());
      if (plan !== null && plan.kind === 'resource-blocked') return;
      // this launch's own card: the seat host checks that the card names its launch
      let card: ContentHash;
      try {
        card = stampCard(this.content, t.spec.seat.card, launch, t.spec.seat.resume);
      } catch (e) {
        t.state = 'needs-disposition';
        t.disposition = 'seat-failure';
        t.note = `the seat card cannot be used: ${(e as Error).message}`;
        await this.alerts.raise({
          category: 'seat-card-invalid',
          wi: 'WI-20',
          key: `${t.spec.task}:${t.spec.seat.card}`,
          trigger: `task ${t.spec.task}: its seat card ${t.spec.seat.card} cannot be read as a seat card (${(e as Error).message})`,
          defaultAction: 'the task is not dispatched and needs a decision (a corrected card through the Secretary); everything else goes on',
          detail: { task: t.spec.task, card: t.spec.seat.card, error: (e as Error).message },
        });
        return;
      }
      try {
        mkdirSync(join(this.opts.stateDir, 'logs'), { recursive: true, mode: 0o700 });
        const lp = ledgerPaths(this.opts.ledgerRoot, this.opts.controlPlane);
        this.preparedSeats.set(
          launch,
          await prepareSeatLaunch({
            launch,
            card,
            reservation: this.demandOf(t.spec),
            generation: this.gen,
            stateDir: this.opts.stateDir,
            controlPlane: this.opts.controlPlane,
            ledgerSocket: this.opts.ledgerSocket,
            contentRoot: lp.content,
            install: this.opts.seats,
            seat: t.spec.seat,
            plan,
            sink: { module: this.opts.sinkModule ?? LEDGER_SINK_MODULE, options: { socketPath: this.opts.ledgerSocket, contentRoot: lp.content } },
            stopScope: { controlPlane: this.opts.controlPlane, tag },
            ...(this.opts.nodePath !== undefined ? { nodePath: this.opts.nodePath } : {}),
            ...(t.spec.unit.proofRetry !== undefined ? { retry: t.spec.unit.proofRetry } : {}),
          }),
        );
      } catch (e) {
        // what was created is released by the preparation sweep (identity-bound, r1 #11)
        void this.sweepPrepared().catch(() => undefined);
        t.note = `held: the writable area could not be prepared (${(e as Error).message})`;
        await this.alerts.raise({
          category: 'area-preparation-failed',
          wi: 'WI-10',
          key: launch,
          trigger: `the large-disk image of ${t.spec.task} could not be created at admission: ${(e as Error).message}`,
          defaultAction: 'not dispatched; retried on the next pass; everything else goes on',
          detail: { task: t.spec.task, launch, error: (e as Error).message },
        });
        return;
      }
    }
    await this.register(t, launch);
  }

  /** Whether a seat card's kind needs a writable area (not a 'materials' seat); null when the card cannot be read (refused at launch). */
  private seatNeedsArea(template: string): boolean | null {
    const known = this.cardAreaCache.get(template);
    if (known !== undefined) return known;
    let v: boolean | null;
    try {
      v = seatNeedsArea(seatCardKind(this.content, template));
    } catch {
      v = null;
    }
    this.cardAreaCache.set(template, v);
    return v;
  }

  /** The machine's area tools, probed once (9.6, v49 7.1). */
  private areaTools(): Promise<AreaTools> {
    if (this.opts.seats === undefined) return Promise.resolve({ fuse2fs: null, mkfsExt4: null, fallocate: null, fusermount: null, fuseDevice: false });
    this.areaToolsCache ??= seatAreaTools(this.opts.seats);
    return this.areaToolsCache;
  }

  /** What a task reserves (6.5): a seat's whole-life demand, or the generic declaration. */
  private demandOf(spec: TaskSpec): Demand {
    return spec.seat !== undefined ? seatReservation(spec.seat.demand, this.opts.seats?.geometry) : spec.demand;
  }

  /** registerLaunch (stop- and pause-checked by the ledger), then the unit. */
  private async register(t: TaskRecord, launch: LaunchId): Promise<void> {
    const meta = readLaunchMeta(this.opts.stateDir, launch);
    if (meta === null) return;
    this.dispatching.add(launch);
    try {
      try {
        await this.ledger.registerLaunch(`launch:${launch}`, this.gen, launch, meta.tag);
        this.unconfirmed.delete(t.spec.task);
      } catch (e) {
        const code = errorCode(e);
        if (isTransient(e)) {
          // The registration may have committed with its answer lost: retry the same op later.
          // The launch stays protected from the reconciliation until then (r1 #5).
          this.unconfirmed.set(t.spec.task, launch);
          if (code === 'STORAGE_FAULT') this.storageFault = true;
          return;
        }
        this.unconfirmed.delete(t.spec.task);
        // refused: the preparation is released by the sweep (identity-bound, r1 #11)
        this.preparedSeats.delete(launch);
        if (code === 'STOPPED') {
          t.note = 'held: a stop covers it';
          return;
        }
        if (code === 'RECOVERY_PAUSED') {
          this.paused = true;
          return;
        }
        throw e;
      }
      // the receipt may be an old one: a launch that already has its final disposition is never started (r1 #5)
      const decided = await this.ledger.dispositionFor(launch);
      if (decided !== null) {
        this.preparedSeats.delete(launch);
        t.note = `the registration of ${launch} was confirmed after it had been decided (${decided}); not started`;
        return;
      }
      this.tasks.bindLaunch(t, launch);
      this.reserved.set(launch, { demand: this.demandOf(t.spec), unitName: meta.unitName });
      await this.dequeueDispatched(t.spec.task, launch);
      t.state = 'running';
      t.note = null;
      this.cp.putHost({
        format: 'mp4.host-entry.v1',
        launch,
        tag: meta.tag,
        unitName: meta.unitName,
        task: t.spec.task,
        lineage: t.spec.lineage,
        seatUnit: meta.seatUnit,
        heartbeat: meta.heartbeat,
        gen: this.gen,
        at: this.now(),
      });
      const lp = ledgerPaths(this.opts.ledgerRoot, this.opts.controlPlane);
      const u = t.spec.unit;
      mkdirSync(join(this.opts.stateDir, 'logs'), { recursive: true, mode: 0o700 });
      const prepared = this.preparedSeats.get(launch);
      this.preparedSeats.delete(launch);
      try {
        await this.units.launch({
          config: prepared?.config ?? {
            launch,
            stateDir: this.opts.stateDir,
            host: u.host,
            unit: u.limits,
            sink: { module: this.opts.sinkModule ?? LEDGER_SINK_MODULE, options: { socketPath: this.opts.ledgerSocket, contentRoot: lp.content } },
            ...(u.proofRetry !== undefined ? { retry: u.proofRetry } : {}),
            stopScope: { controlPlane: this.opts.controlPlane, tag: meta.tag },
            // the host's time to end itself on a stop: 30 s for a seat, 10 s for a program run
            stopGraceMs: u.stopGraceMs ?? (u.seatUnit ? 30_000 : 10_000),
            ...(u.orphanGraceMs !== undefined ? { orphanGraceMs: u.orphanGraceMs } : {}),
            ...(u.cleanup !== undefined ? { cleanup: u.cleanup } : {}),
          },
          unitName: meta.unitName,
          ...(this.opts.nodePath !== undefined ? { nodePath: this.opts.nodePath } : {}),
          logPath: join(this.opts.stateDir, 'logs', `${launch}.log`),
        });
      } catch (e) {
        // Registered but not started: the takeover rules find no supervisor and the
        // reconciliation entry disposes it "failed, no proof"; the env-retry loop counts it.
        await this.alerts.raise({
          category: 'unit-launch-failed',
          wi: 'WI-15',
          key: launch,
          trigger: `the unit of ${launch} could not be started`,
          defaultAction: 'the launch is decided by the reconciliation entry (failed, no proof) and retried within the env-retry cap',
          detail: { launch, error: (e as Error).message },
        });
      }
    } finally {
      if (![...this.unconfirmed.values()].includes(launch)) this.dispatching.delete(launch);
    }
  }

  // ---------------------------------------------------------------- budget block (6.5)

  private async budgetPass(spendRefused: Map<MissionId, TaskRecord[]>, spendAdmitted: Set<MissionId>): Promise<void> {
    // missions in block: released once a paid next step fits again
    for (const [mission, rec] of [...this.blocked]) {
      const waiting = this.tasks.all().filter((t) => t.spec.mission === mission && t.spec.paid && (t.state === 'budget-blocked' || t.state === 'queued'));
      if (waiting.length === 0) continue;
      const s = await this.ledger.spendSummary(mission);
      if (waiting.some((t) => spendAdmits(s, t.spec.estimateMicros))) {
        const report = this.content.put(canonicalJson({ format: 'mp4.budget-release.v1', mission, spend: s, released: rec.report }));
        await this.ledger.appendRecords(`mission-block:${mission}:released:${report}`, this.gen, [{ kind: 'mission.block', mission, reason: 'budget', state: 'released', report }]);
        this.blocked.delete(mission);
        for (const t of waiting) if (t.state === 'budget-blocked') t.state = 'queued';
      }
    }
    for (const [mission, refused] of spendRefused) {
      if (spendAdmitted.has(mission) || this.blocked.has(mission)) continue;
      const s = await this.ledger.spendSummary(mission);
      const runningHere = this.tasks.running().some((t) => t.spec.mission === mission);
      if (s.inflight > 0 || runningHere) {
        // 6.5: in-flight reservations will be released: wait, and say so on level 0
        for (const t of refused) {
          t.note = 'waiting for in-flight reservations';
          this.waiting.set(t.spec.task, { mission, task: t.spec.task, reason: 'waiting for in-flight reservations' });
        }
        continue;
      }
      await this.blockMission(mission, refused, s);
    }
  }

  private async blockMission(mission: MissionId, refused: TaskRecord[], s: { limit: number | null; spent: number; inflight: number }): Promise<void> {
    const tasks = this.tasks.all().filter((t) => t.spec.mission === mission);
    const smallest = Math.min(...refused.map((t) => t.spec.estimateMicros));
    const report = {
      format: 'mp4.budget-block.v1',
      mission,
      reason: `the remaining budget (${budgetLeft(s)} micro-dollars) cannot start any necessary next step (smallest estimate ${smallest}); nothing is in flight`,
      spend: s,
      snapshot: tasks.map((t) => ({ task: t.spec.task, lineage: t.spec.lineage, state: t.state, note: t.note, estimateMicros: t.spec.estimateMicros, launches: t.launches })),
      risks: [
        ...refused.map((t) => `task ${t.spec.task} cannot start: estimate ${t.spec.estimateMicros} exceeds what is left`),
        ...tasks.filter((t) => t.state === 'needs-disposition').map((t) => `task ${t.spec.task} has a quarantined result awaiting a decision`),
        'raise the spend limit, or treat the budget as used up (exploration: 8.2 "budget used up")',
      ],
      at: this.now(),
    };
    const hash = this.content.put(canonicalJson(report));
    const rec: MissionBlockRecord = { kind: 'mission.block', mission, reason: 'budget', state: 'blocked', report: hash };
    await this.ledger.appendRecords(`mission-block:${mission}:blocked:${hash}`, this.gen, [rec]);
    this.blocked.set(mission, rec);
    for (const t of refused) {
      t.state = 'budget-blocked';
      t.note = 'budget block: no paid seat starts until the limit is raised';
    }
    await this.alerts.raise({
      category: 'budget-block',
      wi: 'WI-09',
      key: `${mission}:${hash}`,
      trigger: report.reason,
      defaultAction: `mission ${mission}: no paid seat starts; unpaid work and other missions continue`,
      detail: report,
    });
  }

  /**
   * WI-03: external worktrees or branches that changed paths inside the write scope of an
   * in-flight mission. Called periodically and before deliveries. The default action is to
   * do nothing else: no merge, no adoption; the pipeline sees external work only once it is
   * on the target branch.
   */
  async scanExternalWork(): Promise<Array<{ work: ExternalWork; mission: MissionId; tasks: string[]; paths: string[] }>> {
    this.externalScanAt = this.now();
    if (this.externalWork === null) return [];
    const inFlight = this.tasks.all().filter((t) => !['done', 'abandoned'].includes(t.state) && (t.spec.writeScope?.length ?? 0) > 0);
    if (inFlight.length === 0) return [];
    const found: Array<{ work: ExternalWork; mission: MissionId; tasks: string[]; paths: string[] }> = [];
    for (const w of await this.externalWork.scan()) {
      const byMission = new Map<MissionId, { tasks: string[]; paths: Set<string> }>();
      for (const t of inFlight) {
        const hit = overlappingPaths(w.paths, t.spec.writeScope ?? []);
        if (hit.length === 0) continue;
        const m = byMission.get(t.spec.mission) ?? { tasks: [], paths: new Set<string>() };
        m.tasks.push(t.spec.task);
        for (const p of hit) m.paths.add(p);
        byMission.set(t.spec.mission, m);
      }
      for (const [mission, m] of byMission) {
        const paths = [...m.paths].sort();
        found.push({ work: w, mission, tasks: m.tasks, paths });
        const key = `${w.worktree ?? ''}:${w.branch ?? ''}:${mission}:${paths.join(',')}`;
        if (this.externalNoticed.has(key)) continue;
        this.externalNoticed.add(key);
        await this.alerts.raise({
          category: 'external-work-overlap',
          wi: 'WI-03',
          key,
          trigger: `${w.worktree ?? w.branch ?? 'external work'} changed ${paths.length} path(s) inside the write scope of mission ${mission}`,
          defaultAction: 'nothing else: no merge, no adoption; the pipeline keeps working and sees the external work only once it is on the target branch',
          detail: { worktree: w.worktree, branch: w.branch, source: w.source, mission, tasks: m.tasks, paths },
        });
      }
    }
    return found;
  }

  isBlocked(mission: MissionId): boolean {
    return this.blocked.has(mission);
  }

  waitingReasons(): Array<{ mission: MissionId | null; task: string | null; reason: string }> {
    return [...this.waiting.values()];
  }

  // ---------------------------------------------------------------- evaluator

  private async startEvaluator(o: EvaluatorRunnerOptions & { readonly querySocket: string }): Promise<void> {
    // the degradations the user accepted at install come from the ledger's install state (9.6, WI-18)
    const accepted = await acceptedDegradations(this.ledger);
    if (this.closing) return;
    this.evaluator = startEvaluator(o, this.gen, this.ledger, this.content, (rev) => {
      this.lastPublished = rev;
      this.evaluatorFault = null;
      void this.noticeRunner.kick();
      // WI-11: acceptances that ended for want of the derived state are registered again, each
      // as a new attempt naming the one it retries (r1 #9)
      this.reregisterEndedAcceptances();
      // a launch whose acceptance waited for the continuation check is decided now
      if (this.awaitingEvaluator.size > 0) void this.reconcileRunner.kick();
      // stable dependents wait for proof: results not proven yet are routed again (r1 #2)
      for (const t of this.tasks.all()) {
        const step = this.nextSteps.get(t.spec.task);
        if (t.state !== 'done' || step === undefined || (step.kind === 'continue' && step.label === 'proven') || step.kind === 'ended') continue;
        if (![...this.proofHolds.values()].some((h) => h.dep === t.spec.task)) continue;
        const last = t.launches.at(-1);
        if (last !== undefined) void this.route(t, last).catch((e: unknown) => this.onLoopError('routing', e));
      }
      // WI-11: steps that ended for want of the derived state are routed again
      for (const [task, launch] of [...this.endedForProven]) {
        this.endedForProven.delete(task);
        const t = this.tasks.get(task);
        if (t) void this.route(t, launch).catch((e: unknown) => this.onLoopError('routing', e));
      }
    }, accepted);
    this.evalQuery = new RpcClient(o.querySocket, 5_000);
    // WI-11: the evaluator supervisor raises the notice itself; the scheduler only reacts:
    // what needs "proven" ends with that reason, everything else goes on
    this.evaluator.on('fault', (reason: string) => {
      this.evaluatorFault = reason;
    });
    // 6.3: the ledger refused the supervisor's writes as an old generation (STALE_GENERATION); that
    // supervisor stopped its worker. The current generation's scheduler runs the evaluator.
    this.evaluator.on('superseded', () => void this.onEvaluatorSuperseded().catch((e: unknown) => this.onLoopError('evaluator', e)));
    // 'blocked' (the memory pool cannot be enforced and no degradation was accepted: WI-18, raised
    // by the supervisor) is like the fault for what needs "proven"; level 0 shows it
    this.evaluator.on('blocked', (pool: unknown) => {
      this.evaluatorFault = 'the evaluator is blocked: its memory pool cannot be enforced (WI-18)';
      this.evaluatorBlocked = pool;
      this.writeStatus();
    });
    this.evaluator.on('checkpoint-paused', (info: unknown) => {
      this.checkpointPaused = info;
      this.writeStatus();
    });
    this.evaluator.on('checkpoint-resumed', () => {
      this.checkpointPaused = null;
      this.writeStatus();
    });
    // an install-time accepted degradation (WI-18): shown on level 0, not raised at runtime
    this.evaluator.on('degraded', (info: unknown) => {
      this.evaluatorDegraded = info;
      this.writeStatus();
    });
    void this.evaluator.start().catch((e: unknown) => this.onLoopError('evaluator', e));
  }

  /**
   * The evaluator's supervisor was superseded (6.3). When a newer scheduler generation exists,
   * this scheduler is superseded too (that generation runs its own evaluator); when this one is
   * still current, it starts its evaluator again.
   */
  private async onEvaluatorSuperseded(): Promise<void> {
    if (this.closing || this.stale || !this.opts.evaluator) return;
    const current = await this.ledger.currentGeneration();
    if (current !== this.gen) {
      this.becomeStale(`the evaluator of generation ${this.gen} was superseded: generation ${current} is current`);
      return;
    }
    this.evalQuery?.close();
    this.evalQuery = null;
    await this.startEvaluator(this.opts.evaluator);
  }

  /**
   * The flows (src/flow) over this scheduler: their engine is reconciled on every tick and after
   * every accepted outcome (single-flight; an error is logged and the next tick tries again).
   */
  attachFlow(flow: FlowReconciler): void {
    this.flow = flow;
    void this.flowRunner.kick();
  }

  /** The evaluator's query socket for the flows; refuses while no evaluator runs here. */
  evaluatorCaller(): EvaluatorQuery {
    return {
      call: (method, params) => {
        const q = this.evalQuery;
        if (q === null) return Promise.reject(new Error('no evaluator runs here (the derived state cannot be computed)'));
        return q.call(method, params);
      },
      close: () => undefined,
    };
  }

  /** WI-11 option 1: the PM retries the evaluator: the fault and the failure budget are cleared, the evaluator restarts. */
  async retryEvaluator(): Promise<void> {
    if (!this.opts.evaluator) return;
    await this.ledger.clearEvaluatorFault();
    await this.evaluator?.stop();
    this.evalQuery?.close();
    this.evaluatorFault = null;
    await this.startEvaluator(this.opts.evaluator);
  }

  /** The last checkpoint summary and its lag behind the ledger head, for level 0 while the evaluator is down. */
  private faultView(): unknown {
    const path = this.opts.evaluator?.worker.checkpointPath;
    if (path === undefined) return null;
    const summary = readCheckpointSummary(path);
    if (summary === null) return null;
    // the ledger's head from its heartbeat (no read of the log)
    return faultTimeView(summary, this.cp.readLedgerHeartbeat()?.head ?? summary.revision ?? 0);
  }

  get publishedRevision(): number | null {
    return this.lastPublished;
  }

  /** Wait until every loop is idle (tests). */
  async settle(): Promise<void> {
    await Promise.all([this.stopRunner.idle(), this.reconcileRunner.idle(), this.cleanupRunner.idle(), this.dispatchRunner.idle(), this.noticeRunner.idle()]);
  }

  /** Revision helper for tests and routing. */
  async ledgerHead(): Promise<Revision> {
    return this.ledger.head();
  }
}
