// The scheduler's typed view of the ledger service (design 6.1: the scheduler never writes
// the main ledger itself; every write is a request to the service, executed in its queue).
//
// Every scheduler write carries the scheduler generation where the service takes one, so a
// write of an old generation is refused (6.3), and an operation id where the service takes
// one, so a retry after a lost response returns the original result (6.1 "业务身份与传输身份",
// §14 item 6). Operation ids are derived from what the write is about (a launch, a failed
// attempt, a cleanup step), never from time, so the same business fact always has the same id.

import type { AlertId, ContentHash, Generation, JudgmentId, LaunchId, MissionId, Revision, StopId } from '../common/ids.ts';
import type { BaseRecord, JudgmentInputs, ListRef, LoopKind, TerminationProofRecord } from '../common/records.ts';
import { LedgerClient, LedgerUnavailable, RemoteLedgerError, type LedgerMethods } from '../ledger/ipc.ts';
import type { Disposition, IntentState, LedgerErrorCode } from '../ledger/service.ts';
import type {
  ActiveStop,
  BookedUserWords,
  DispatchedTask,
  ExecutorIdentity,
  LaunchFilter,
  LaunchInfo,
  LoopState,
  OpenIntent,
  QueuedTask,
  StartupDecision,
  TaskInfo,
} from '../ledger/queries.ts';
import type { MissionBlockRecord } from '../common/records.ts';
import type { ScopeTag, StopRequest } from '../ledger/stops.ts';

export type { ActiveStop, BookedUserWords, DispatchedTask, ExecutorIdentity, LaunchFilter, LaunchInfo, LoopState, OpenIntent, QueuedTask, StartupDecision, TaskInfo };

/** One installation fact (ledger `installStates`). */
export interface InstallState {
  readonly item: string;
  readonly value: string;
  readonly accepted: boolean;
  readonly by: 'user' | 'installer';
  readonly detail: ContentHash;
  readonly revision: Revision;
}

export interface OpenLaunch {
  readonly launch: LaunchId;
  readonly gen: Generation;
  readonly tag: ScopeTag;
  readonly adoptedBy: readonly Generation[];
}

export interface SpendSummary {
  readonly limit: number | null;
  readonly spent: number;
  readonly inflight: number;
}

export interface IntentInfo {
  readonly state: IntentState;
  readonly kind: string;
  readonly domain: string;
  readonly launch: LaunchId | null;
  readonly mission: MissionId;
  readonly capabilities: string[];
  readonly executor: ExecutorIdentity | null;
}

/** The service's state (`status`): storage fault, recovery pause, the startup decision after a reboot (v43 6.1). */
export interface LedgerStatus {
  readonly head: Revision;
  readonly storageFault: boolean;
  readonly storageFaultReason: string | null;
  readonly evaluator: { failures: number; fault: string | null };
  readonly slowActions: number;
  readonly recoveryPause: boolean;
  readonly recoveryPausedSince: number | null;
  readonly boot: string | null;
  readonly startup: StartupDecision | null;
  /** The configured stop inboxes (v45 6.1) and whether each was readable when the service opened. */
  readonly inboxes: ReadonlyArray<{ readonly name: string; readonly file: string; readonly readable: boolean; readonly fs: unknown }>;
}

/** The code of a ledger error, 'UNAVAILABLE' when the service could not be reached, null otherwise. */
export function errorCode(e: unknown): LedgerErrorCode | 'UNAVAILABLE' | null {
  if (e instanceof RemoteLedgerError) return e.code;
  if (e instanceof LedgerUnavailable) return 'UNAVAILABLE';
  return null;
}

/** The service is down, unreachable or in storage fault: retry later, nothing was decided. */
export function isTransient(e: unknown): boolean {
  const c = errorCode(e);
  return c === 'UNAVAILABLE' || c === 'STORAGE_FAULT';
}

/** A newer scheduler generation has begun: this scheduler must stop acting (6.3). */
export function isStale(e: unknown): boolean {
  return errorCode(e) === 'STALE_GENERATION';
}

export class SchedulerLedger {
  readonly client: LedgerClient;
  private closed = false;

  constructor(client: LedgerClient) {
    this.client = client;
  }

  static connect(socketPath: string, timeoutMs = 10_000): SchedulerLedger {
    return new SchedulerLedger(new LedgerClient(socketPath, timeoutMs));
  }

  /** After close no request is sent (the client would otherwise reconnect for a late caller). */
  close(): void {
    this.closed = true;
    this.client.close();
  }

  private async call<M extends keyof LedgerMethods>(method: M, params: LedgerMethods[M]): Promise<unknown> {
    if (this.closed) throw new LedgerUnavailable('the scheduler closed its ledger client');
    return this.client.call(method, params);
  }

  // ---------------------------------------------------------------- generations (6.3)

  async beginGeneration(): Promise<Generation> {
    return (await this.call('beginGeneration', {})) as Generation;
  }

  async currentGeneration(): Promise<Generation> {
    return (await this.call('currentGeneration', {})) as Generation;
  }

  // ---------------------------------------------------------------- launches, proofs, dispositions

  async registerLaunch(op: string, gen: Generation, launch: LaunchId, tag: ScopeTag): Promise<{ launch: LaunchId }> {
    return (await this.call('registerLaunch', { op, gen, launch, tag })) as { launch: LaunchId };
  }

  async openLaunches(): Promise<OpenLaunch[]> {
    return (await this.call('openLaunches', {})) as OpenLaunch[];
  }

  async adopt(gen: Generation, launch: LaunchId, via: 'alive' | 'proof'): Promise<{ adopted: boolean }> {
    return (await this.call('adopt', { gen, launch, via })) as { adopted: boolean };
  }

  async proofFor(launch: LaunchId): Promise<TerminationProofRecord | null> {
    return (await this.call('proofFor', { launch })) as TerminationProofRecord | null;
  }

  async dispositionFor(launch: LaunchId): Promise<Disposition | null> {
    return (await this.call('dispositionFor', { launch })) as Disposition | null;
  }

  async pendingResults(launch: LaunchId): Promise<BaseRecord[]> {
    return (await this.call('pendingResults', { launch })) as BaseRecord[];
  }

  async registerProof(proof: TerminationProofRecord): Promise<{ registered: 'new' | 'same' }> {
    return (await this.call('registerProof', proof)) as { registered: 'new' | 'same' };
  }

  async dispose(
    gen: Generation,
    launch: LaunchId,
    disposition: Disposition,
    reason: string,
  ): Promise<{ disposition: Disposition; changed: boolean; revisions: Revision[] }> {
    return (await this.call('dispose', { gen, launch, disposition, reason })) as {
      disposition: Disposition;
      changed: boolean;
      revisions: Revision[];
    };
  }

  // ---------------------------------------------------------------- cleanup (v35)

  async recordCleanup(op: string, launch: LaunchId, state: 'pending' | 'done', resources: ListRef): Promise<{ state: 'pending' | 'done' }> {
    return (await this.call('recordCleanup', { op, launch, state, resources })) as { state: 'pending' | 'done' };
  }

  async pendingCleanups(): Promise<Array<{ launch: LaunchId; resources: string[] }>> {
    return (await this.call('pendingCleanups', {})) as Array<{ launch: LaunchId; resources: string[] }>;
  }

  async launchesWithoutCleanup(): Promise<LaunchId[]> {
    return (await this.call('launchesWithoutCleanup', {})) as LaunchId[];
  }

  async cleanupState(launch: LaunchId): Promise<'pending' | 'done' | null> {
    return (await this.call('cleanupState', { launch })) as 'pending' | 'done' | null;
  }

  // ---------------------------------------------------------------- stops (6.4)

  async stop(req: StopRequest): Promise<boolean> {
    return (await this.call('stop', req)) as boolean;
  }

  async drainStops(): Promise<StopId[]> {
    return (await this.call('drainStops', {})) as StopId[];
  }

  async activeStopIds(): Promise<StopId[]> {
    return (await this.call('activeStopIds', {})) as StopId[];
  }

  async releaseStop(stop: StopId): Promise<{ released: boolean }> {
    return (await this.call('releaseStop', { stop })) as { released: boolean };
  }

  /**
   * WI-12: the PM resumes after the user answered. `answer`: the user's answer as the PM
   * recorded it (kept with the cleared pause); `op`: the PM's operation id (a retry returns the
   * first result).
   */
  async confirmResume(req: { op?: string; answer?: string } = {}): Promise<{ cleared: boolean }> {
    return (await this.call('confirmResume', { ...(req.op !== undefined ? { op: req.op } : {}), ...(req.answer !== undefined ? { answer: req.answer } : {}) })) as { cleared: boolean };
  }

  // ---------------------------------------------------------------- missions (6.6)

  async missions(state: 'open' | 'closed' | 'all' = 'open'): Promise<Array<{ mission: MissionId; state: 'open' | 'closed'; closes: number }>> {
    return (await this.call('missions', { state })) as Array<{ mission: MissionId; state: 'open' | 'closed'; closes: number }>;
  }

  async missionCloses(mission: MissionId): Promise<Array<{ mission: MissionId; version: number; mode: string; waitRunning: boolean; at: number }>> {
    return (await this.call('missionCloses', { mission })) as Array<{ mission: MissionId; version: number; mode: string; waitRunning: boolean; at: number }>;
  }

  // ---------------------------------------------------------------- external actions (6.1)

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
    return (await this.call('authorize', req)) as { intent: string };
  }

  async markIntentPendingVerify(intent: string, executor: ExecutorIdentity): Promise<{ state: IntentState | null }> {
    return (await this.call('markIntentPendingVerify', { intent, executor })) as { state: IntentState | null };
  }

  async finishIntent(
    intent: string,
    outcome: 'done' | 'failed',
    verified: { executorGone: boolean; outcomeVerified: boolean } | null = null,
  ): Promise<{ state: IntentState | null }> {
    return (await this.call('finishIntent', { intent, outcome, verified })) as { state: IntentState | null };
  }

  async intentInfo(intent: string): Promise<IntentInfo | null> {
    return (await this.call('intentInfo', { intent })) as IntentInfo | null;
  }

  // ---------------------------------------------------------------- bookkeeping (6.5, 3.9)

  async appendRecords(op: string, gen: Generation | null, records: readonly BaseRecord[]): Promise<{ revisions: Revision[] }> {
    return (await this.call('appendRecords', { op, gen, records })) as { revisions: Revision[] };
  }

  /** The loop's counters and the ledger's verdict (6.5): exhausted, why, cap, allowed, the grant baseline, the lineage's Secretary grant. */
  async loopState(lineage: string, loop: LoopKind, failureClass: string | null = null): Promise<LoopState> {
    return (await this.call('loopState', { lineage, loop, failureClass })) as LoopState;
  }

  async spendSummary(mission: MissionId): Promise<SpendSummary> {
    return (await this.call('spendSummary', { mission })) as SpendSummary;
  }

  async setSpendLimit(op: string, mission: MissionId, micros: number | null): Promise<void> {
    await this.call('setSpendLimit', { op, mission, micros });
  }

  async setMission(mission: MissionId, state: 'open' | 'closed'): Promise<void> {
    await this.call('setMission', { mission, state });
  }

  /**
   * An alert names its WI (3.11); `wi: null` is a notice that is not an exception (a stop
   * report, a normal branch the PM should see) and goes as `informational: true` (core review r3 #18).
   */
  async raiseAlert(op: string, alert: AlertId, category: string, body: ContentHash, wi: string | null = null): Promise<{ revision: Revision }> {
    return (await this.call('raiseAlert', wi === null ? { op, alert, category, informational: true, body } : { op, alert, category, wi, body })) as { revision: Revision };
  }

  async status(): Promise<LedgerStatus> {
    return (await this.call('status', {})) as LedgerStatus;
  }

  async head(): Promise<Revision> {
    return (await this.call('head', {})) as Revision;
  }

  // ---------------------------------------------------------------- evaluator health (the EvaluatorSupervisor's port)

  async evaluatorHealth(): Promise<{ failures: number; fault: string | null }> {
    return (await this.call('evaluatorHealth', {})) as { failures: number; fault: string | null };
  }

  /**
   * `op`: one id per failure, so a retry after a lost answer does not count twice; `gen`: the
   * scheduler generation the supervisor belongs to (a superseded one cannot change the budget).
   */
  async recordEvaluatorFailure(op?: string, gen?: Generation): Promise<number> {
    return (await this.call('recordEvaluatorFailure', { ...(op !== undefined ? { op } : {}), ...(gen !== undefined ? { gen } : {}) })) as number;
  }

  async evaluatorInstance(): Promise<{ epoch: number; gen: Generation; identity: ExecutorIdentity } | null> {
    return (await this.call('evaluatorInstance', {})) as { epoch: number; gen: Generation; identity: ExecutorIdentity } | null;
  }

  // ---------------------------------------------------------------- queries (6.1: callers never read the database)

  async activeStops(): Promise<ActiveStop[]> {
    return (await this.call('activeStops', {})) as ActiveStop[];
  }

  async stopState(stop: StopId): Promise<'active' | 'released' | null> {
    return (await this.call('stopState', { stop })) as 'active' | 'released' | null;
  }

  async openIntents(): Promise<OpenIntent[]> {
    return (await this.call('openIntents', {})) as OpenIntent[];
  }

  async launches(filter: LaunchFilter = {}): Promise<LaunchInfo[]> {
    return (await this.call('launches', filter)) as LaunchInfo[];
  }

  async missionBlocks(mission?: MissionId): Promise<Array<{ mission: MissionId; revision: Revision; record: MissionBlockRecord }>> {
    return (await this.call('missionBlocks', mission === undefined ? {} : { mission })) as Array<{ mission: MissionId; revision: Revision; record: MissionBlockRecord }>;
  }

  async latestUserWords(limit = 1): Promise<BookedUserWords[]> {
    return (await this.call('latestUserWords', { limit })) as BookedUserWords[];
  }

  async startupDecision(): Promise<StartupDecision | null> {
    return (await this.call('startupDecision', {})) as StartupDecision | null;
  }

  // ---------------------------------------------------------------- the task queue (4.1)

  async queueTask(req: { op: string; gen: Generation; task: string; lineage: string; mission: MissionId; card: ContentHash }): Promise<{ revision: Revision }> {
    return (await this.call('queueTask', req)) as { revision: Revision };
  }

  async dequeueTask(req: { op: string; gen: Generation; task: string; reason: 'dispatched' | 'cancelled' | 'superseded'; launch?: LaunchId | null; by?: string | null }): Promise<{ revision: Revision }> {
    return (await this.call('dequeueTask', req)) as { revision: Revision };
  }

  async taskQueue(mission?: MissionId): Promise<QueuedTask[]> {
    return (await this.call('taskQueue', mission === undefined ? {} : { mission })) as QueuedTask[];
  }

  async taskInfo(task: string): Promise<TaskInfo | null> {
    return (await this.call('taskInfo', { task })) as TaskInfo | null;
  }

  /** Enter the evaluator's fault state, for generation `gen` only (when given). */
  async setEvaluatorFault(reason: string, gen?: Generation): Promise<void> {
    await this.call('setEvaluatorFault', gen === undefined ? { reason } : { reason, gen });
  }

  // ---------------------------------------------------------------- continuation checks (5.2 part 5), install state (9.6)

  /**
   * The evaluator's answer for a continuation judgment at `revision` (the latest published).
   * BELOW_FLOOR: a newer revision was published meanwhile: ask the evaluator again.
   */
  async recordContinuationCheck(req: {
    op: string;
    gen: Generation;
    judgment: JudgmentId;
    extends: JudgmentId;
    target: string;
    revision: Revision;
    result: { ok: boolean; reason?: string | null; merged?: JudgmentInputs };
  }): Promise<{ revision: Revision }> {
    return (await this.call('recordContinuationCheck', req as never)) as { revision: Revision };
  }

  /** The latest install state of every item (or one), e.g. an accepted degradation (WI-18). */
  async installStates(item?: string): Promise<InstallState[]> {
    return (await this.call('installStates', item === undefined ? {} : { item })) as InstallState[];
  }

  /**
   * Dispatched tasks never queued again, with their launch's final disposition (by default
   * only disposed ones): a restarted scheduler's "needs disposition" and "exhausted" items.
   */
  async dispatchedTasks(filter: { mission?: MissionId; disposed?: boolean } = {}): Promise<DispatchedTask[]> {
    return (await this.call('dispatchedTasks', filter)) as DispatchedTask[];
  }

  /** WI-11: a PM-initiated retry clears the fault and the failure budget (6.1). */
  async clearEvaluatorFault(): Promise<void> {
    await this.call('clearEvaluatorFault', {});
  }
}
