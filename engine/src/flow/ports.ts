// The flow's narrow ports (design 3, 4, 8, 11.1): everything the orchestration reads and does
// goes through these three interfaces, so the flows run against in-memory fakes in tests
// (src/flow/fakes.ts) and against the real ledger, scheduler and evaluator through adapters
// (src/flow/adapters.ts).
//
// Restartability: the flow keeps no state of its own. Everything it decided is a ledger fact
// (a flow event, a base record, a task in the ledger's queue, a loop count), every action it
// takes has a deterministic identity (op id, task id, event key), so a flow restarted from
// ledger state recomputes the same next actions and repeats nothing (duplicates are no-ops).
//
// Flow events are the one ledger record kind the flow needs that does not exist yet
// ('flow.event', see RECORDS-NEEDED.md): (mission, line, event, key) is its identity; its body
// is a JSON document in the content store, typed by the flow module that owns the line.

import type { ContentHash, LaunchId, MissionId } from '../common/ids.ts';
import type { BaseRecord, BaseRecordKind, Committed, ListRef, LoopKind, ReviewContract, SeatResultRecord } from '../common/records.ts';
import type { DecidingView, Label } from '../evaluator/semantics.ts';

// ---------------------------------------------------------------- content

/** The content store as the flow uses it (ContentStore satisfies it, with string results). */
export interface FlowContent {
  put(doc: string): ContentHash;
  get(hash: string): string;
  putList(items: readonly string[]): ListRef;
  getList(ref: ListRef): string[];
}

// ---------------------------------------------------------------- flow events (proposed ledger kind)

/** The proposed base record (RECORDS-NEEDED.md). Bookkeeping: never an evaluator input. */
export interface FlowEventRecord {
  readonly kind: 'flow.event';
  readonly mission: MissionId;
  /** The flow line the event belongs to, e.g. "plan", "task:<id>", "exploration:<id>", "audit:<id>". */
  readonly line: string;
  /** The event type within its line, e.g. "pm-batch", "consumed", "mechanical-check". */
  readonly event: string;
  /** Unique within (mission, line, event). */
  readonly key: string;
  /** The event body: a JSON document in the content store. */
  readonly body: ContentHash;
}

export interface FlowEventInput {
  readonly mission: MissionId;
  readonly line: string;
  readonly event: string;
  readonly key: string;
  /** Any JSON value; stored as canonical JSON. */
  readonly body: unknown;
}

/** A committed flow event with its body read back (parsed JSON). */
export interface FlowEvent<B = unknown> {
  readonly revision: number;
  readonly mission: MissionId;
  readonly line: string;
  readonly event: string;
  readonly key: string;
  readonly body: B;
}

// ---------------------------------------------------------------- loops and notices

/** A loop's verdict for one lineage (6.5; the ledger's loopState). */
export interface LoopStatus {
  readonly lineage: string;
  readonly loop: LoopKind;
  readonly attempts: number;
  /** Attempts allowed in total, grants included. */
  readonly allowed: number;
  readonly exhausted: boolean;
  readonly reason: 'cap' | 'class-cap' | 'no-progress' | null;
  /** The Secretary already used its one grant on this lineage (any loop). */
  readonly secretaryGrantUsed: boolean;
}

/**
 * A notice to the PM (3.9): an exception with its WI (3.11, or a proposed WI in
 * src/flow/WI-NEEDED.md), or a normal-branch notice (`wi: null`: Secretary notices, Calibrator ①
 * returns, results of work the user asked for). Idempotent by (category, key).
 */
export interface FlowNotice {
  readonly category: string;
  readonly wi: string | null;
  readonly key: string;
  readonly mission: MissionId;
  /** What happened and how the program found it. */
  readonly trigger: string;
  /** What the program already did (only the affected action stops, 3.11 principle 1). */
  readonly defaultAction: string;
  /** The facts. */
  readonly detail: unknown;
  /** The PM asks the user (3.2 important decision, or the WI's "问用户"). */
  readonly askUser?: boolean;
}

// ---------------------------------------------------------------- the ledger port

export interface FlowLedgerPort {
  readonly content: FlowContent;
  /**
   * Append flow events and base records in one operation, atomically. Idempotent by `op`: the
   * same op with the same payload is a no-op; the same op with another payload, or an event
   * identity committed with another body, is refused (OP_CONFLICT / FACT_CONFLICT).
   */
  append(op: string, entries: { readonly events?: readonly FlowEventInput[]; readonly records?: readonly BaseRecord[] }): Promise<void>;
  /** Committed flow events of a mission, in commit order (optionally one line and/or one event type). */
  events<B = unknown>(q: { readonly mission: MissionId; readonly line?: string; readonly event?: string }): Promise<readonly FlowEvent<B>[]>;
  /**
   * Committed base records of the given kinds, in commit order (an indexed read, paged by the
   * adapter). `mission` narrows to records that name it; judgments, issues, user words,
   * evidence and environment snapshots name no mission: read those without it.
   */
  records<K extends BaseRecordKind>(kinds: readonly K[], o?: { readonly mission?: MissionId }): Promise<ReadonlyArray<Committed<Extract<BaseRecord, { kind: K }>>>>;
  /** The committed object version with this id, or null (an indexed lookup). */
  objectVersion(object: string): Promise<Extract<BaseRecord, { kind: 'object.version' }> | null>;
  /** The committed judgment with this id, or null (an indexed lookup). */
  judgment(judgment: string): Promise<Extract<BaseRecord, { kind: 'judgment' }> | null>;
  /**
   * Execute a proof-conditioned operation (6.1: a legalization stamp, a delivery) "as of" a
   * published revision: the ledger checks it was registered (op.pending), that `asOf` is the
   * latest published revision (the publication floor), the stop scope and the evaluator's health,
   * and records op.executed. Idempotent by `op`. A stale `asOf` is a retryable refusal (code
   * NOT_READY): read the evaluator again and retry on the next pass. `events` are committed in
   * the same transaction as the execution (e.g. the legalization result).
   * An `append` that carries op.executed is routed here (with the append's events).
   */
  commitProofOp(req: { readonly op: string; readonly opId: string; readonly asOf: number; readonly events?: readonly FlowEventInput[] }): Promise<void>;
  /** A loop's state for a lineage (6.5). */
  loop(lineage: string, loop: LoopKind): Promise<LoopStatus>;
  /** Record one attempt of a loop (a return, a rework); `op` names the attempt (no double count on retry). */
  loopAttempt(req: { readonly op: string; readonly lineage: string; readonly loop: LoopKind; readonly signature: string; readonly failureClass?: string | null }): Promise<LoopStatus>;
  /** A notice to the PM (3.9, 3.11). */
  notify(n: FlowNotice): Promise<void>;
  /** Missions that have flow events (the engine reconciles each). */
  missions(): Promise<readonly MissionId[]>;
}

// ---------------------------------------------------------------- the scheduler port

/** src/scheduler/tasks.ts TaskState. */
export type FlowTaskState = 'queued' | 'running' | 'waiting-evidence' | 'done' | 'needs-disposition' | 'exhausted' | 'budget-blocked' | 'blocked' | 'abandoned';

/** A card of any registered kind (src/seat/cards). */
export type AnyCard = { readonly seat: string } & Readonly<Record<string, unknown>>;

/** A seat task as the flow submits it (the adapter turns it into a scheduler TaskSpec). */
export interface FlowTask {
  /** Deterministic id: submitting the same task again is a no-op. */
  readonly task: string;
  /** Loop counts accumulate per lineage (6.5). */
  readonly lineage: string;
  readonly mission: MissionId;
  readonly card: AnyCard;
  /** Higher first. */
  readonly priority: number;
  readonly capabilities: readonly string[];
  readonly mode: 'stable' | 'fast';
  /** The spend estimate (micro-dollars, 6.5). */
  readonly estimateMicros: number;
  /** A Secretary task runs in the lineage it handles (6.5 "Secretary 自己被调用的次数也计入它所处理的谱系"). */
  readonly secretaryFor?: string;
  /** Objects the result binds (6.2 routing). */
  readonly binds?: readonly string[];
  /** Write scope patterns (WI-03). */
  readonly writeScope?: readonly string[];
  /** A continuation review's changed basis lines (5.2 part 5). */
  readonly changedLines?: readonly string[];
  /** The commit the seat's snapshot is made from (LFS objects must be local, 7.1). */
  readonly snapshot?: { readonly repo: string; readonly commit: string };
  /**
   * Work that outlives the mission's close (6.6): an audit, a delivery (or its conflict
   * integration), a repair after an audit. Unset: production work, cancelled when the mission
   * closes. (Auditor seats are inferred by the scheduler.)
   */
  readonly afterClose?: 'audit' | 'delivery' | 'repair';
}

/** What an accepted launch handed back (its seat.result and the pending results accepted with it). */
export interface AcceptedHandBack {
  readonly launch: LaunchId;
  readonly status: SeatResultRecord['status'];
  /** The typed hand-back (the payload of submit_result), or null. */
  readonly result: unknown;
  readonly resultHash: ContentHash | null;
  readonly export: ContentHash | null;
  readonly evidenceRequest: ContentHash | null;
  readonly recoveryState: ContentHash | null;
  /** The session to resume after async evidence (6.2), when known. */
  readonly sessionId: string | null;
  /** The accepted pending results of the launch: judgments, object versions, issues. */
  readonly records: readonly BaseRecord[];
}

export interface FlowTaskStatus {
  readonly task: string;
  readonly state: FlowTaskState;
  readonly note: string | null;
  readonly disposition: 'stop' | 'quarantine' | 'seat-failure' | 'resource-exceeded' | 'full-review' | null;
  readonly launches: readonly LaunchId[];
  /** The last accepted hand-back (state done or waiting-evidence), else null. */
  readonly handBack: AcceptedHandBack | null;
}

/** 4.2: the product version the program makes from an accepted Constructor export. */
export interface ProductRequest {
  readonly mission: MissionId;
  readonly module: string;
  readonly task: string;
  readonly launch: LaunchId;
  readonly export: ContentHash;
  /** The snapshot commit the Constructor worked on. */
  readonly base: string;
  readonly writeScope: readonly string[];
  readonly taskType: string;
  readonly prerequisites: readonly string[];
  readonly reviews: readonly ReviewContract[];
  readonly predecessor: string | null;
}

export interface ProductVersion {
  readonly object: string;
  /** The generated commit. */
  readonly commit: string;
  /** The canonical candidate snapshot (7.1), for the Reviewer and the verification runs. */
  readonly snapshot: string;
  readonly changedPaths: readonly string[];
}

export interface VerifyRequest {
  readonly mission: MissionId;
  readonly object: string;
  readonly snapshot: string;
  readonly commands: ReadonlyArray<{ readonly id: string; readonly command: string; readonly cwd?: string }>;
}

export interface VerificationRun {
  readonly evidence: string;
  readonly command: string;
  readonly summary: string;
  readonly passed: boolean;
}

export interface FlowSchedulerPort {
  /** Queue a seat task (idempotent by task id). */
  submit(task: FlowTask): Promise<void>;
  /** The task's state, or null when the scheduler does not know it. */
  status(task: string): Promise<FlowTaskStatus | null>;
  /** Give a task up (not running): it leaves the queue. */
  cancel(task: string): Promise<boolean>;
  /** Replace a task that is not running (e.g. waiting for evidence) by another in the same lineage (6.5: counts go on). */
  supersede(task: string, by: FlowTask): Promise<void>;
  /** The Secretary restarts a task that needs disposition (quarantine-restart loop, 6.5). Null: not restartable. */
  restart(task: string, signature: string): Promise<LoopStatus | null>;
  /** Extra attempts for an exhausted loop (6.5): the Secretary once per lineage, at most 2; the user any. */
  grant(req: { readonly op: string; readonly lineage: string; readonly loop: LoopKind; readonly by: 'secretary' | 'user'; readonly extra: number; readonly reason: string }): Promise<{ readonly granted: boolean; readonly why?: string }>;
  /**
   * 7.1: a read-only snapshot of the project (default: the mission's base commit), optionally
   * with accepted product versions laid over it (a dependent task sees its prerequisites, 5.3).
   */
  snapshot(req: {
    readonly mission: MissionId;
    readonly purpose: string;
    readonly commit?: string;
    readonly products?: readonly string[];
    /** The seat's write-scope patterns: the result names the sandbox writable paths prepared for them (they must exist in the snapshot). */
    readonly writable?: readonly string[];
  }): Promise<{ readonly path: string; readonly commit: string; readonly writable?: readonly string[] }>;
  /** 3.5: whether a file of a snapshot exists and contains a symbol (the interface check; read-only, no model). */
  findSymbol(req: { readonly snapshot: string; readonly file: string; readonly symbol: string }): Promise<boolean>;
  /** 3.4: git history and run durations, exported into the Architect's card. */
  history(mission: MissionId): Promise<{ readonly gitLog: string; readonly runs: ReadonlyArray<{ readonly task: string; readonly seat: string; readonly durationMs: number; readonly costMicros: number }> }>;
  /** 4.2: the product version of an accepted Constructor export (idempotent per launch). */
  product(req: ProductRequest): Promise<ProductVersion>;
  /** 4.1: the program's verification runs on a product version (idempotent; 'pending' while they run). */
  verify(req: VerifyRequest): Promise<readonly VerificationRun[] | 'pending'>;
}

// ---------------------------------------------------------------- the evaluator port

export interface FlowEvaluatorPort {
  /** Display labels of objects / proof units (5.2), at one published revision (null: unknown target). */
  labels(ids: readonly string[]): Promise<{ readonly revision: number; readonly labels: Readonly<Record<string, Label | null>> }>;
  /** What decides each target's proof: positions, their states and deciding judgments (5.2, 8.1). */
  deciding(ids: readonly string[]): Promise<{ readonly revision: number; readonly views: Readonly<Record<string, DecidingView | null>> }>;
  /** Whether each judgment is current (null: unknown). */
  judgments(ids: readonly string[]): Promise<{ readonly revision: number; readonly current: Readonly<Record<string, boolean | null>> }>;
  /** Proof-conditioned operations (6.1): all proven, executed as of. */
  ops(ids: readonly string[]): Promise<{ readonly revision: number; readonly states: Readonly<Record<string, { readonly allProven: boolean; readonly executedAsOf: number | null } | null>> }>;
}

/** The three ports together, plus the clock. */
export interface FlowPorts {
  readonly ledger: FlowLedgerPort;
  readonly scheduler: FlowSchedulerPort;
  readonly evaluator: FlowEvaluatorPort;
  readonly now?: () => number;
}
