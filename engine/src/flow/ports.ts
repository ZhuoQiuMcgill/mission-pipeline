// The flow's narrow ports (design 4.1 §14 "Process"; 4.0 3, 4, 8, 11.1): everything the
// orchestration reads and does goes through these three interfaces. In 4.1 they run on the
// project memory (src/process/ports.ts): the ledger port is the memory's domain functions inside
// its writes, the content port its data table, the scheduler port the dispatch table (a
// submitted task is a ready step for `mp pm next`; a hand-back recorded by `mp seat <id>
// handback` is what `status()` returns), and the evaluator port the stored labels.
//
// Restartability: the flow keeps no state of its own. Everything it decided is a memory fact
// (a flow event, a base record, a task in the queue, a loop count), every action it takes has
// a deterministic identity (op id, task id, event key), so a flow restarted from the memory
// recomputes the same next actions and repeats nothing (duplicates are no-ops).
//
// Flow events ('flow.event'): (mission, line, event, key) is their identity; the body is a JSON
// document in the data table, typed by the flow module that owns the line.

import type { ContentHash, MissionId } from '../common/ids.ts';
import type { BaseRecord, BaseRecordKind, Committed, ListRef, LoopKind, ReviewContract } from '../common/records.ts';
import type { DecidingView, Label } from '../evaluator/semantics.ts';
import type { SuiteCommand } from '../common/fullSuite.ts';

// ---------------------------------------------------------------- content

/** The memory's data table as the flow uses it (DataStore satisfies it, with string results). */
export interface FlowContent {
  put(doc: string): ContentHash;
  get(hash: string): string;
  putList(items: readonly string[]): ListRef;
  getList(ref: ListRef): string[];
}

// ---------------------------------------------------------------- flow events (proposed ledger kind)

/** The flow event base record (src/common/records.ts). Bookkeeping: never an evaluator input. */
export interface FlowEventRecord {
  readonly kind: 'flow.event';
  readonly mission: MissionId;
  /** The flow line the event belongs to, e.g. "plan", "task:<id>", "exploration:<id>", "audit:<id>". */
  readonly line: string;
  /** The event type within its line, e.g. "pm-batch", "consumed", "mechanical-check". */
  readonly event: string;
  /** Unique within (mission, line, event). */
  readonly key: string;
  /** The event body: a JSON document in the data table. */
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
 * A notice to the PM (3.9): an exception with its WI (3.11; the pages are plugin/pm/wi/), or a
 * normal-branch notice (`wi: null`: Secretary notices, Calibrator ①
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

/**
 * A precondition checked inside an append's own write: none of `absent` may be committed, else
 * nothing is written and an error with `code` and `message` is thrown (a decision that must not be
 * recorded once another one was carried out).
 */
export interface AppendGuard {
  readonly absent: ReadonlyArray<{ readonly mission: string; readonly line: string; readonly event: string; readonly key: string }>;
  readonly code: string;
  readonly message: string;
}

export interface FlowLedgerPort {
  readonly content: FlowContent;
  /**
   * Append flow events and base records in one operation, atomically. Idempotent by `op`: the
   * same op with the same payload is a no-op; the same op with another payload, or an event
   * identity committed with another body, is refused (OP_CONFLICT / FACT_CONFLICT).
   */
  append(op: string, entries: { readonly events?: readonly FlowEventInput[]; readonly records?: readonly BaseRecord[]; readonly guard?: AppendGuard }): Promise<void>;
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
   * Execute a proof-conditioned operation (6.1: a legalization stamp): the memory checks it was
   * registered (op.pending), the stop scope, and the labels (every listed object proven, nothing
   * recomputing), and records op.executed. Idempotent by `op`. A refusal while the labels are
   * recomputing, or a stop that covers it for now, is retryable (code NOT_READY): the flow
   * retries on the next pass. `asOf` is kept for the record (4.1 has no publication floor).
   * `events` are committed in the same transaction as the execution (e.g. the legalization result).
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
  /** Whether the mission is closed (4.1 §6.7: its production steps are held; post-close work goes on). Absent: never closed. */
  missionClosed?(mission: MissionId): Promise<boolean>;
}

// ---------------------------------------------------------------- the scheduler port (the dispatch table)

/**
 * A task's state as the flows see it: queued (a ready step, or held by a stop or a lease),
 * running (a dispatch in flight), waiting-evidence (its hand-back asked for evidence), done
 * (accepted hand-back), needs-disposition (a hand-back not accepted because it came after a stop),
 * exhausted (released dispatches used up its re-dispatch loop, decision 15), abandoned
 * (cancelled or superseded). The 4.0 states budget-blocked and blocked are never set.
 */
export type FlowTaskState = 'queued' | 'running' | 'waiting-evidence' | 'done' | 'needs-disposition' | 'exhausted' | 'budget-blocked' | 'blocked' | 'abandoned';

/** A card of any registered kind (src/seat/cards). */
export type AnyCard = { readonly seat: string } & Readonly<Record<string, unknown>>;

/** A seat task as the flow submits it: the task's spec, kept in the memory's data table. */
export interface FlowTask {
  /** Deterministic id: submitting the same task again is a no-op. */
  readonly task: string;
  /** Loop counts accumulate per lineage (6.5). */
  readonly lineage: string;
  readonly mission: MissionId;
  readonly card: AnyCard;
  /** Higher first (`mp pm next` lists ready steps by priority). */
  readonly priority: number;
  /** The task's stop scope (6.4). */
  readonly capabilities: readonly string[];
  readonly mode: 'stable' | 'fast';
  /** Informational only (4.1 meters nothing). */
  readonly estimateMicros?: number;
  /** A Secretary task runs in the lineage it handles (6.5 "Secretary 自己被调用的次数也计入它所处理的谱系"). */
  readonly secretaryFor?: string;
  /** Objects the result binds (6.2 routing). */
  readonly binds?: readonly string[];
  /** Write scope patterns (WI-03). */
  readonly writeScope?: readonly string[];
  /** A continuation review's changed basis lines (5.2 part 5). */
  readonly changedLines?: readonly string[];
  /** The commit the seat reads, or its worktree is created at (a Constructor). */
  readonly snapshot?: { readonly repo: string; readonly commit: string };
  /** Exclusive resources (§6.2): leased to the dispatch while it is in flight; the step waits while another holds one. */
  readonly exclusive?: readonly string[];
  /**
   * Work that outlives the mission's close (6.6): an audit, a delivery (or its conflict
   * integration), a repair after an audit. Unset: production work, cancelled when the mission
   * closes.
   */
  readonly afterClose?: 'audit' | 'delivery' | 'repair';
  /**
   * Who hands the task over (4.1 §3.2, U-13), when the flow knows better than the advance that
   * queues it: the task whose hand-back led to it (null: none), the object versions it is handed
   * over on, the step in words. Unset parts come from the advance (the hand-back or PM command
   * that triggered it) and the task's binds.
   */
  readonly handover?: { readonly from?: string | null; readonly objects?: readonly string[]; readonly step?: string };
}

/** What an accepted hand-back brought (its structured fields, and the records accepted with it). */
export interface AcceptedHandBack {
  /** The dispatch that handed back. */
  readonly dispatch: string;
  /** handed-back, or needs-evidence (`mp seat <id> request-evidence`, decision 13). */
  readonly status: 'handed-back' | 'needs-evidence';
  /** The structured fields (the seat's result JSON), or null. */
  readonly result: unknown;
  readonly resultHash: ContentHash | null;
  /** Constructor (§5.3): the candidate commit collected from its worktree, on its base. */
  readonly candidate: { readonly commit: string; readonly base: string; readonly changedPaths: readonly string[] } | null;
  /** needs-evidence: the request (a data value). */
  readonly evidenceRequest: ContentHash | null;
  /** needs-evidence: the notes the seat saved to continue from (a data value). */
  readonly notes: ContentHash | null;
  /** The report leaf (`missions/<m>/dispatches/<d>/report.md`). */
  readonly report: string | null;
  /** The runs the dispatch had `mp` rerun (`mp seat <id> rerun`), in order, with the environment identity each was recorded under. */
  readonly runs: ReadonlyArray<{ readonly run: string; readonly completed: boolean; readonly envLine?: string; readonly envSnapshot?: string }>;
  /** The records accepted with it: judgments, object versions, issues. */
  readonly records: readonly BaseRecord[];
}

export interface FlowTaskStatus {
  readonly task: string;
  readonly state: FlowTaskState;
  readonly note: string | null;
  readonly disposition: 'stop' | 'full-review' | null;
  /** Every dispatch of the task, oldest first. */
  readonly dispatches: readonly string[];
  /** The last accepted hand-back (state done or waiting-evidence), else null. */
  readonly handBack: AcceptedHandBack | null;
  /** exhausted: the loop that is used up. */
  readonly loop?: LoopKind;
}

/** 4.2: the product version the program records from an accepted Constructor candidate. */
export interface ProductRequest {
  readonly mission: MissionId;
  readonly module: string;
  readonly task: string;
  readonly dispatch: string;
  /** The candidate commit (§5.3). */
  readonly candidate: string;
  /** The base commit the Constructor's worktree was created at (the candidate's parent; a rework's: the previous attempt's candidate, or its change laid over its dependencies' current products, Appendix M). */
  readonly base: string;
  readonly writeScope: readonly string[];
  readonly taskType: string;
  readonly prerequisites: readonly string[];
  readonly reviews: readonly ReviewContract[];
  /** The latest recorded product under this spec whose work was carried (including a re-bound version); null for a new spec. */
  readonly predecessor: string | null;
  /** The snapshot the version's own change is taken against: inherited while an attempt continues, replaced when the work is carried onto a new start. Supplied for a new carried start, otherwise derived (versionOrigin). */
  readonly origin?: string;
}

export interface ProductVersion {
  readonly object: string;
  /** The candidate commit. */
  readonly commit: string;
  /** What the Reviewer and the verification runs read: the candidate commit. */
  readonly snapshot: string;
  /** The write-scope paths changed since the origin: the snapshot the version's own change is taken against, inherited while an attempt continues, replaced when the work is carried onto a new start (Appendices H, M). */
  readonly changedPaths: readonly string[];
}

/**
 * A kept product version re-bound under the plan in effect (design 4.1 Appendix J): a successor of
 * `of` with the same content and source (commit, write scope, transform description and origin),
 * so it brings exactly the change `of` brings, and its own prerequisites and review contracts.
 * Replaying an id must match every immutable field. A new version requires a Reviewer judgment
 * in stable mode; no judgment is carried over by the program (maintainer ruling 1, 2026-10-13).
 */
export interface RebindRequest {
  readonly mission: MissionId;
  /** The recorded product version it re-binds (its predecessor). */
  readonly of: string;
  /** The new version's id. */
  readonly object: string;
  readonly prerequisites: readonly string[];
  readonly reviews: readonly ReviewContract[];
}

export interface VerifyRequest {
  readonly mission: MissionId;
  readonly object: string;
  /** The candidate commit the runs check out clean (§5.3). */
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
  /** Whether the product's origin holds its recorded prerequisite composition; unreadable git is a refusal. */
  startHolds(product: string): Promise<{ readonly holds: boolean; readonly missing: readonly { readonly prerequisite: string; readonly path: string }[] }>;
  /** Exact product closure (whole proof units included) sorted by id; the overlay uses prerequisite order. Confers no proof. */
  composition(products: readonly string[]): Promise<readonly string[]>;
  /** Queue a seat task (idempotent by task id): a ready step for `mp pm next`. */
  submit(task: FlowTask): Promise<void>;
  /** The task's state, or null when the memory does not know it. */
  status(task: string): Promise<FlowTaskStatus | null>;
  /** Give a task up (not in flight): it leaves the queue. */
  cancel(task: string): Promise<boolean>;
  /** Replace a task that is not in flight by another in the same lineage (6.5: counts go on). */
  supersede(task: string, by: FlowTask): Promise<void>;
  /** The Secretary restarts a task that needs disposition (counted on the quarantine-restart loop, 6.5). Null: not restartable. */
  restart(task: string, signature: string): Promise<LoopStatus | null>;
  /** Extra attempts for an exhausted loop (6.5): the Secretary once per lineage, at most 2; the user any. */
  grant(req: { readonly op: string; readonly lineage: string; readonly loop: LoopKind; readonly by: 'secretary' | 'user'; readonly extra: number; readonly reason: string }): Promise<{ readonly granted: boolean; readonly why?: string }>;
  /**
   * The commit a seat reads (default: the mission's base commit, the target branch's), with
   * accepted product versions laid over it when given (a dependent task sees its prerequisites,
   * 5.3). `path` is what the card names: the commit, or a project-relative path.
   */
  snapshot(req: {
    readonly mission: MissionId;
    readonly purpose: string;
    readonly commit?: string;
    readonly products?: readonly string[];
    /** The seat's write paths (kept on the card as they are; nothing is prepared in 4.1). */
    readonly writable?: readonly string[];
    /**
     * A later attempt's start (design 4.1 Appendix M): `commit` is the latest recorded candidate under the current spec,
     * of product version `version`, and `products` are the task's dependencies' accepted products
     * now. When the snapshot of those products over the mission base is not what that version's
     * work started from (its origin), the version's whole change since its origin is laid over that
     * snapshot instead (three-way; a conflict is an ActionError 'conflict' with `carried: true` in
     * its detail) and `origin` names that snapshot; otherwise the result is `commit` itself.
     */
    readonly carry?: { readonly version: string; readonly products: readonly string[] };
  }): Promise<{
    readonly path: string;
    readonly commit: string;
    readonly writable?: readonly string[];
    /** Exact product versions composing the start, including their prerequisite closure. */
    readonly products?: readonly string[];
    /** Set when a carried change was laid over a new start: the snapshot the attempt's work now starts from (its product's origin). */
    readonly origin?: string;
  }>;
  /** 3.5: whether a file of a snapshot exists and contains a symbol (the interface check; read-only, no model). */
  findSymbol(req: { readonly snapshot: string; readonly file: string; readonly symbol: string }): Promise<boolean>;
  /** 3.4: git history and run durations, exported into the Architect's card. */
  history(mission: MissionId): Promise<{ readonly gitLog: string; readonly runs: ReadonlyArray<{ readonly task: string; readonly seat: string; readonly durationMs: number; readonly costMicros: number }> }>;
  /** 4.2: the product version of an accepted Constructor candidate (idempotent per dispatch). */
  product(req: ProductRequest): Promise<ProductVersion>;
  /** Appendix J: the re-bound version of a kept product (idempotent per object id). */
  rebind(req: RebindRequest): Promise<{ readonly object: string; readonly commit: string }>;
  /**
   * 4.1 §5.3: the program's declared runs on a candidate's clean checkout (idempotent: reused).
   * 'pending': the same runs are executing in another `mp` process; nothing was run or recorded,
   * and the step waits for a later pass, which reuses them once they are recorded.
   */
  verify(req: VerifyRequest): Promise<readonly VerificationRun[] | 'pending'>;
}

// ---------------------------------------------------------------- the evaluator port

export interface FlowEvaluatorPort {
  /**
   * Labels of objects / proof units for a decision (5.2; 4.1 §4.1): "recomputing" for every id
   * while a propagation frontier is left (nothing may be used as proven then), null for an
   * unknown target. The revision is the one the stored labels reflect.
   */
  labels(ids: readonly string[]): Promise<{ readonly revision: number; readonly labels: Readonly<Record<string, Label | 'recomputing' | null>> }>;
  /** What decides each target's proof: positions, their states and deciding judgments (5.2, 8.1). */
  deciding(ids: readonly string[]): Promise<{ readonly revision: number; readonly views: Readonly<Record<string, DecidingView | null>> }>;
  /** Whether each judgment is current (null: unknown). */
  judgments(ids: readonly string[]): Promise<{ readonly revision: number; readonly current: Readonly<Record<string, boolean | null>> }>;
  /** Proof-conditioned operations (6.1): all proven, executed as of. */
  ops(ids: readonly string[]): Promise<{ readonly revision: number; readonly states: Readonly<Record<string, { readonly allProven: boolean; readonly executedAsOf: number | null } | null>> }>;
}

/**
 * What the project's configuration declares that the flows read (4.1.2): its local test commands
 * (`verificationCommands`) and its full suite (`fullSuite`, or the 4.1.1 alias `closingChecks`:
 * src/common/fullSuite.ts). Absent: none declared.
 */
export interface FlowProject {
  readonly localCommands: readonly SuiteCommand[];
  readonly fullSuite: readonly SuiteCommand[];
}

/** The three ports together, plus the clock and the project's declared commands. */
export interface FlowPorts {
  readonly ledger: FlowLedgerPort;
  readonly scheduler: FlowSchedulerPort;
  readonly evaluator: FlowEvaluatorPort;
  readonly now?: () => number;
  readonly project?: FlowProject;
}
