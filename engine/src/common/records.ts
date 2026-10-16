// Base records: the immutable facts appended to the project memory's event log
// (design 4.1 §3.2; 4.0 6.1). Each committed record is assigned a Revision.
// Derived state (the labels, 5.2) is computed from these records alone and
// stored apart (src/evaluator); "the derived state at revision R" is defined as
// a full recomputation over the records with revision <= R.
//
// Large lists (a judgment's evidence, an object's prerequisites, an operation's
// objects) are skeleton data (memory/data.ts): the record carries the list's
// hash and length, and reads resolve them (`Resolved<...>`).

import { canonicalJson, sha256 } from './hash.ts';
import type {
  AlertId,
  GitOid,
  BasisLineId,
  BasisVersionId,
  ContentHash,
  EnvLineId,
  EnvSnapshotId,
  EpisodeBatchId,
  EvidenceId,
  IssueId,
  JudgmentId,
  LaunchId,
  MissionId,
  ModuleId,
  ObjectVersionId,
  OpId,
  ProofUnitId,
  Revision,
  StopId,
} from './ids.ts';

/** Reference to a list stored as skeleton data (memory/data.ts). */
export interface ListRef {
  readonly hash: ContentHash;
  readonly count: number;
}

// ---------------------------------------------------------------- roots (bases)

/**
 * Kinds of basis line (5.2 "依据"): user requirement items, a mission's
 * requirement set (v31: one line per mission; each version snapshots the item
 * versions in force), user authorization quotes, project object constraints
 * (scoped; they take part in constraint coverage), execution instructions
 * (v34: delivered to their seats only, never a proof obligation), acceptance
 * standards. A basis version is valid while it is the latest version of its
 * line and the line is not withdrawn.
 */
export type BasisKind = 'requirement' | 'requirement-set' | 'authorization' | 'constraint' | 'instruction' | 'standard';

interface BasisVersionFields {
  readonly kind: 'basis.version';
  readonly line: BasisLineId;
  /** For constraints: the content version. A scope change alone does not create one (v30 5.2, 9.5). */
  readonly version: BasisVersionId;
  readonly mission: MissionId | null; // null: project-wide (constraints, standards)
  /** Constraints and instructions: the initial scope; later scope changes are `constraint.scope` records. */
  readonly scope: ConstraintScope | null;
}

/** A requirement-set version (v31 5.2) always carries its snapshot: the requirement item versions in force (core review r3 #23). */
export interface RequirementSetVersionRecord extends BasisVersionFields {
  readonly basisKind: 'requirement-set';
  readonly snapshot: ListRef;
}

/** Every other basis version has no snapshot. */
export interface PlainBasisVersionRecord extends BasisVersionFields {
  readonly basisKind: Exclude<BasisKind, 'requirement-set'>;
  readonly snapshot?: undefined;
}

export type BasisVersionRecord = RequirementSetVersionRecord | PlainBasisVersionRecord;

/** A constraint's scope changed without a content change (v30 9.5). */
export interface ConstraintScopeRecord {
  readonly kind: 'constraint.scope';
  readonly line: BasisLineId;
  readonly scope: ConstraintScope;
}

/**
 * Where a project constraint applies (9.5). `paths` are patterns over the
 * object's write scope: an exact path, a directory prefix ending in "/**", or
 * "**" for everything. Empty `taskTypes` means every task type.
 */
export interface ConstraintScope {
  /** Absent: project-wide. Explicit scope never changes the recording mission. */
  readonly mission?: string;
  readonly paths: readonly string[];
  readonly taskTypes: readonly string[];
}

/** What a checked object covers, for matching constraint scopes. */
/** What an object version covers (v33 5.2): its concrete paths (files of a product's write scope, or a document path) and task type. */
export interface ObjectScope {
  readonly paths: readonly string[];
  readonly taskType: string;
}

/**
 * One constraint a review checked (v33 5.2): the constraint's content version and
 * the object paths actually reviewed against it. Coverage needs every path in
 * the constraint's current scope to be covered by the union of these paths over
 * the deciding judgments that checked the current content version. Stored in a
 * judgment's `constraints` list as canonical JSON (`encodeConstraintCheck`).
 */
export interface ConstraintCheck {
  readonly version: string;
  readonly paths: readonly string[];
}

export function encodeConstraintCheck(c: ConstraintCheck): string {
  return JSON.stringify({ paths: [...new Set(c.paths)].sort(), version: c.version });
}

export function decodeConstraintCheck(s: string): ConstraintCheck {
  const v = JSON.parse(s) as unknown;
  if (!v || typeof v !== 'object') throw new TypeError(`malformed constraint check: ${s}`);
  const o = v as { version?: unknown; paths?: unknown };
  if (typeof o.version !== 'string' || !Array.isArray(o.paths) || !o.paths.every((p) => typeof p === 'string')) {
    throw new TypeError(`malformed constraint check: ${s}`);
  }
  return { version: o.version, paths: o.paths as string[] };
}

/**
 * A review position: one target and one review kind (v30 5.2). Only the
 * target's own proof uses it. Encoded as a JSON pair so no id or review name
 * can make two positions collide (core review r2 F3).
 */
export type ReviewPosition = string;
export function reviewPosition(target: string, review: string): ReviewPosition {
  return JSON.stringify([target, review]);
}

/** The key of an issue's state on one version (5.6), a JSON pair for the same reason. */
export function fixKey(issue: string, version: string): string {
  return JSON.stringify([issue, version]);
}

/**
 * The contract of one required review position (v30 5.2), fixed with the
 * object: any judgment on this position, whoever executes it, must bind a
 * version of every listed basis line and rely on every listed object.
 */
export interface ReviewContract {
  readonly review: string;
  readonly basisLines: readonly BasisLineId[];
  readonly reliesOn: readonly (ObjectVersionId | ProofUnitId)[];
}

export interface BasisWithdrawnRecord {
  readonly kind: 'basis.withdrawn';
  readonly line: BasisLineId;
}

// ---------------------------------------------------------------- environments

/**
 * The current snapshot of an environment line is the latest one registered (7.2).
 * 4.1 §6.5: the environment identity of the machine `mp` runs on, recorded when
 * it changes (line "env", snapshot = the hash of `parts`).
 */
export interface EnvSnapshotRecord {
  readonly kind: 'env.snapshot';
  readonly line: EnvLineId;
  readonly snapshot: EnvSnapshotId;
  /** 4.1 §6.5: what the identity hashes, kept for reading. */
  readonly parts?: EnvironmentParts;
}

/**
 * An environment identity's parts (4.1 §6.5): operating system and version,
 * architecture, and the output of each version command the project declares in
 * `.mission-pipeline/config.json` (by command).
 */
export interface EnvironmentParts {
  readonly os: string;
  readonly osVersion: string;
  readonly arch: string;
  /** Each command's output, shortened for reading. */
  readonly versions: Readonly<Record<string, string>>;
  /** The sha256 of each command's whole output (what makes the identity cover all of it). */
  readonly digests?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------- evidence

/**
 * The run classes of 4.1 §6.5, fixed when the run is recorded, from its card:
 * - declared: run by `mp` on a clean checkout of the candidate commit with the
 *   card's declared commands, its environment identity recorded, no network
 *   declared, not marked sampled. The only class reused (same candidate content,
 *   commands and environment identity) and renewed mechanically (5.3);
 * - sampling: one observation among possible others (a run the card marks
 *   sampled, an exploration's experiment, every `mp seat <id> rerun`). Never
 *   reused; a judgment that uses a timing, statistical or external field rests
 *   only on sampling runs;
 * - other: anything else (network declared, a seat's scratch run, a run on a
 *   worktree). Never reused or renewed.
 */
export type RunClass = 'declared' | 'sampling' | 'other';

export const RUN_CLASSES: readonly RunClass[] = ['declared', 'sampling', 'other'];

export interface EvidenceRecord {
  readonly kind: 'evidence';
  readonly evidence: EvidenceId;
  readonly envLine: EnvLineId;
  readonly envSnapshot: EnvSnapshotId;
  readonly runClass: RunClass;
  /** Field name -> canonical value (exit status, output hash, duration, per-test results...). */
  readonly fields: Readonly<Record<string, string>>;
}

/** Targeted revocation (7.2 "定向撤销"): the evidence needs a rerun regardless of environment. */
export interface EvidenceRevokedRecord {
  readonly kind: 'evidence.revoked';
  readonly evidence: EvidenceId;
}

/**
 * Mechanical renewal (5.3): after an environment change, `replacement` (a new
 * declared run) stands in for `original` in `judgment`, because every field the
 * judgment uses is equal. The program writes this only when the rules hold.
 */
export interface EvidenceRenewalRecord {
  readonly kind: 'evidence.renewal';
  readonly judgment: JudgmentId;
  readonly original: EvidenceId;
  readonly replacement: EvidenceId;
}

// ---------------------------------------------------------------- checked objects

/** `chain-acceptance`: the object the chain Auditor judges and the legalization seal depends on (v31 11.1). */
export type ObjectKind = 'product' | 'interface' | 'plan' | 'interpretation' | 'chain-acceptance';

/**
 * One immutable version of a checked object (5.1). New content = new version.
 * Design v29 5.2: an object records only what cannot change: its content
 * identity, the prerequisite objects fixed with that content, its scope (for
 * matching constraints) and its required review set (8.1). Every condition that
 * can change (requirement items, authorizations, standards, constraint versions,
 * relied-on review positions) is recorded on the judgments that review it, so a
 * new judgment can restore proof without a new object.
 */
export interface ObjectVersionRecord {
  readonly kind: 'object.version';
  readonly object: ObjectVersionId;
  readonly objectKind: ObjectKind;
  readonly mission: MissionId;
  readonly module: ModuleId | null;
  /** Content identity of the write scope (product) or document hash. */
  readonly content: ContentHash;
  /** Required prerequisite objects (5.3). */
  readonly prerequisites: ListRef;
  readonly scope: ObjectScope;
  /** Required review positions and their contracts (8.1, v30 5.2). */
  readonly reviews: readonly ReviewContract[];
  /**
   * Product versions: where the content comes from (6.6, 7.1). `content` is the
   * write-scope identity computed by src/delivery/writeScope.ts over `commit`
   * and the `writeScope` patterns, under the transform description `transform`.
   * `origin` is the commit the version's own change is taken against (design 4.1
   * Appendix H): the snapshot the first attempt of its task started from. A
   * rework continues in a worktree at the previous attempt's commit, so
   * `commit`'s parent is where the last attempt started, not where the work
   * began. Versions recorded before it was recorded have none; they derive it
   * (src/delivery/candidate.ts versionOrigin).
   */
  readonly source?: { readonly commit: GitOid; readonly writeScope: readonly string[]; readonly transform: ContentHash; readonly origin?: GitOid };
  /**
   * The previous version of the same object line, if any (a plan's earlier
   * version). A continuation judgment may continue a judgment on this object or
   * on its predecessor only (v32 5.2 part 5, core review r2 F4).
   */
  readonly predecessor?: ObjectVersionId;
}

/** Prerequisite cycles are judged as a whole (5.3). Members do not count each other as prerequisites. */
export interface ProofUnitRecord {
  readonly kind: 'proof.unit';
  readonly unit: ProofUnitId;
  readonly members: ListRef; // ObjectVersionId[]
  readonly reviews: readonly ReviewContract[];
}

// ---------------------------------------------------------------- judgments

/**
 * pass: the target meets the standard.
 * fail: negated (Reviewer "返修", Crititor fatal finding standing, Calibrator "违背").
 * undecided: needs a decision; counts as not accepted.
 */
export type Verdict = 'pass' | 'fail' | 'undecided';

export interface JudgmentRecord {
  readonly kind: 'judgment';
  readonly judgment: JudgmentId;
  /** Review kind = the position on the target, e.g. 'reviewer', 'reviewer:security', 'calibrator-1', 'feasibility', 'crititor', 'auditor'. */
  readonly review: string;
  /** Which seat made it. An 'auditor' backfill may fill a position but never revokes a negation (v29 5.2). */
  readonly executor: string;
  readonly target: ObjectVersionId | ProofUnitId;
  readonly verdict: Verdict;
  /** Evidence the judgment requires (5.2). */
  readonly evidence: ListRef;
  /** Bases that must stay valid: requirement items, authorizations, the standard version. */
  readonly bases: ListRef;
  /** Constraints this review checked: encoded `ConstraintCheck`s (content version + paths reviewed); used for coverage (v33 5.2). */
  readonly constraints: ListRef;
  /** Objects (or proof units) that must be proven for this judgment to be current; a superset of the contract's (v30 5.2). */
  readonly reliesOn: ListRef;
  /** Responses to issues on this version (v30 5.6). */
  readonly issues: readonly IssueResponse[];
  /**
   * Revoking a negation (8.1): a pass of the same review kind on the same target
   * must name the negating judgment it revokes; otherwise the negation stands.
   */
  readonly revokes: JudgmentId | null;
  /**
   * What the judgment's card declared about its use of evidence (5.3): the
   * fields it uses, and whether it relies on statistical inference or external
   * state. Mechanical renewal is valid only under these declarations, and the
   * evaluator checks it (renewal.ts).
   */
  readonly evidenceUse: { readonly fields: readonly string[]; readonly statisticalOrExternal: boolean };
  /**
   * Continuation only (v32 5.2 part 5): inputs of J0 the seat re-reviewed and
   * replaced, each with its replacement (of the same kind) carried by this
   * judgment. Every other input of J0 must be carried here too; the evaluator
   * holds a continuation that drops one to be not current.
   */
  readonly superseded: readonly { readonly input: string; readonly by: string }[];
  /**
   * A continuation judgment (v31 5.2 part 5): the seat reviewed only the changes
   * since J0 and the program accepted it after checking J0 was a deciding pass
   * whose only reasons for not being current lie inside those changes. Recorded
   * for the trail only: the judgment itself binds every current version its
   * contract needs, so currency never looks at J0 again.
   */
  readonly extends: JudgmentId | null;
}

// ---------------------------------------------------------------- issues (5.6)

export interface IssueRecord {
  readonly kind: 'issue';
  readonly issue: IssueId;
  readonly module: ModuleId | null;
  readonly observedOn: ListRef; // ObjectVersionId[]
  /** The issue's text (a finding document) in skeleton data. */
  readonly text?: ContentHash;
}

/**
 * What a seat unit handed back (6.2, 4.2, 8.1): its outcome status and the
 * content-store hashes of the typed result (e.g. the Constructor's four-part
 * completion notes, the Reviewer's per-standard judgments), the export
 * manifest, the transcript, the resume state and an evidence request. Submitted
 * as a pending result; it becomes a base record only when the attempt is
 * accepted. One per launch.
 */
export interface SeatResultRecord {
  readonly kind: 'seat.result';
  readonly launch: LaunchId;
  readonly seat: string;
  readonly status: 'handed-back' | 'needs-evidence' | 'seat-failure' | 'environment-failure' | 'resource-exceeded' | 'cancelled' | 'timed-out';
  readonly result: ContentHash | null;
  readonly export: ContentHash | null;
  readonly transcript: ContentHash | null;
  readonly recoveryState: ContentHash | null;
  readonly evidenceRequest: ContentHash | null;
  /** The transcript was cut (export cap, 7.1); the reason is in the transcript's tree document. */
  readonly transcriptIncomplete?: boolean;
  /** The seat's tool log in skeleton data (7.1), when the host kept one. */
  readonly toolLog?: ContentHash | null;
  /** The tool log was cut; the reason is in its tree document. */
  readonly toolLogIncomplete?: boolean;
  /** The seat's session, to resume it after a "needs evidence" hand-back (6.2); null or absent when there is none. */
  readonly sessionId?: string | null;
}

export interface IssueResponse {
  readonly issue: IssueId;
  readonly response: 'fixed' | 'not-fixed' | 'deferred';
  /** Deferred only (5.6): who owns it and why (content hash of the reason). */
  readonly owner?: string;
  readonly reason?: ContentHash;
}

/**
 * Mechanical regression coverage of an issue on one version (5.6 kind 1);
 * Reviewer answers live on judgments. The registration names the exact test ids
 * covering the issue and the content hashes of the test files, the runner
 * configuration and the shared fixtures. The covering run counts only when it
 * is a declared run (4.1 §6.5), reports every registered test id as actually run and
 * passed (`fields["test:<id>"] === "passed"`), and its recorded input hashes
 * (`fields["input:<name>"]`) equal the registered ones.
 */
export interface FixCoverageRecord {
  readonly kind: 'issue.coverage';
  readonly issue: IssueId;
  readonly version: ObjectVersionId;
  readonly evidence: EvidenceId;
  /** The registered command (5.6). */
  readonly command: string;
  /** Test ids from the runner's per-test results. Never empty. */
  readonly tests: ListRef;
  /**
   * Registered input hashes, each "name=sha256" with a prefixed name:
   * `testfile:<path>` (at least one), `runner:<name>` (at least one: the
   * project must declare its runner configuration), `fixture:<path>` (zero or
   * more, as declared). Without the declarations a run can never count
   * mechanically (5.6): the issue goes to the Reviewer instead.
   */
  readonly inputs: ListRef;
}

// ---------------------------------------------------------------- operations needing "proven" (6.1)

export type ProofOpKind = 'stable-dispatch' | 'legalization' | 'delivery' | 'full-close';

/** Registered first; the evaluator maintains "all objects proven" incrementally. */
export interface PendingOpRecord {
  readonly kind: 'op.pending';
  readonly op: OpId;
  readonly opKind: ProofOpKind;
  readonly objects: ListRef; // (ObjectVersionId | ProofUnitId)[]
  /** The operation's stop scope, fixed at registration; execution is checked against it (core review r2 F1). */
  readonly scope: { readonly mission: MissionId; readonly capabilities: readonly string[] };
}

/** Executed "as of revision R"; R must be >= the publication floor when committed. */
export interface OpExecutedRecord {
  readonly kind: 'op.executed';
  readonly op: OpId;
  readonly asOf: Revision;
}

// ---------------------------------------------------------------- bookkeeping (never evaluator inputs)

/** One bounded commit per evaluator update whose change list is non-empty (6.1). */
export interface EpisodeBatchRecord {
  readonly kind: 'episode.batch';
  readonly batch: EpisodeBatchId;
  readonly publishes: Revision; // the revision this batch precedes
  readonly changes: ListRef; // EpisodeChange[]
}

export interface EpisodeChange {
  readonly op: OpId;
  readonly change: 'start' | 'end';
}

export interface NoticeRecord {
  readonly kind: 'notice';
  readonly notice: string; // stable identity, e.g. `${batch}:${op}`
  readonly audience: 'pm';
  readonly body: ContentHash;
  /** What happened, in plain words (an episode notice is a normal branch of the flow, 3.11: no WI). */
  readonly trigger?: string;
  /** What the program did by default. */
  readonly defaultAction?: string;
}

/**
 * The labels' answer to a continuation judgment (5.2 part 5; core review r3 F1),
 * read at the current label revision and recorded before the judgment: a
 * continuation judgment is committed only after a passing check at the latest
 * revision; a failing one sends the work to a full review.
 */
export interface ContinuationCheckRecord {
  readonly kind: 'continuation.check';
  readonly judgment: JudgmentId;
  readonly extends: JudgmentId;
  readonly target: string;
  /** The label revision the check answered at. */
  readonly revision: number;
  readonly ok: boolean;
  /** The evaluator's reason when it failed. */
  readonly reason: string | null;
  /**
   * A passing check: continuationInputsHash of the inputs the evaluator merged
   * (the draft plus what J0 contributes, renewals applied). The judgment's own
   * lists must hash the same to be committed (core review r3 #1, at entry).
   */
  readonly inputs: string | null;
}

/** The four input lists of a judgment, as the evaluator's continuation check merges them. */
export interface JudgmentInputs {
  readonly evidence: readonly string[];
  readonly bases: readonly string[];
  readonly constraints: readonly string[];
  readonly reliesOn: readonly string[];
}

/** The identity of a judgment's inputs: each list as a set (sorted, without repeats), the four together. */
export function continuationInputsHash(i: JudgmentInputs): string {
  const set = (xs: readonly string[]): string[] => [...new Set(xs)].sort();
  return sha256(canonicalJson({ bases: set(i.bases), constraints: set(i.constraints), evidence: set(i.evidence), reliesOn: set(i.reliesOn) }));
}

// ---------------------------------------------------------------- state events (10.1: an append-only log the state tables can be rebuilt from)

/**
 * Every change the program makes to the memory's state tables is also an event
 * in the log, in the same transaction (10.1 rule 3). None of these is an
 * evaluator input.
 */
export type ServiceEventRecord =
  /** `narrows`: the stop this one narrows (6.4 "再收窄"), released in the same transaction. */
  | { readonly kind: 'stop.committed'; readonly stop: StopId; readonly scope: unknown; readonly words: string; readonly at: number; readonly narrows?: StopId }
  /** `narrowedTo`: the narrower stop committed in the same transaction. */
  | { readonly kind: 'stop.released'; readonly stop: StopId; readonly narrowedTo?: StopId }
  | { readonly kind: 'mission.state'; readonly mission: MissionId; readonly state: 'open' | 'closed' }
  | {
      readonly kind: 'intent.authorized';
      readonly intent: string;
      readonly op: string;
      readonly intentKind: string;
      readonly domain: string;
      readonly launch: LaunchId | null;
      readonly mission: MissionId;
      readonly capabilities: readonly string[];
      readonly details: ContentHash;
      /** The delivery a landing or delivery-ref intent is for, as checked at authorization (6.6; git review r1 #11). */
      readonly delivery?: IntentDelivery | null;
    }
  | { readonly kind: 'intent.state'; readonly intent: string; readonly state: string; readonly executor: unknown }
  | { readonly kind: 'op.receipt'; readonly op: string; readonly payloadHash: string; readonly launch: string | null; readonly response: ContentHash }
  | { readonly kind: 'landing.phase'; readonly landing: string; readonly intent: string | null; readonly phase: string; readonly data: ContentHash }
  | {
      readonly kind: 'delivery.recorded';
      readonly mission: MissionId;
      readonly delivery: string;
      readonly commit: string;
      readonly base: string;
      readonly ref: string;
      readonly manifest: ContentHash;
      /** The target branch the delivery was built for, when the delivery side sends it. */
      readonly target?: string | null;
      /** The bound transform description (7.1) in skeleton data, when the delivery side sends it. */
      readonly description?: ContentHash | null;
    }
  /** A notice's delivery to the PM (3.9): delivered, then acknowledged; never back. Absent: undelivered. */
  | { readonly kind: 'notice.delivery'; readonly notice: string; readonly state: 'delivered' | 'acknowledged' }
  /**
   * A PM action through the CLI (3.11 principle 3: the PM's choice per a WI is a
   * record with an operation id, open to review): started, then done or failed.
   * `args` and `result` are canonical JSON in skeleton data.
   */
  | {
      readonly kind: 'pm.action';
      readonly action: string;
      readonly command: string;
      readonly argsHash: string;
      readonly args: ContentHash;
      readonly wi: string | null;
      readonly state: 'started' | 'done' | 'failed';
      readonly result: ContentHash | null;
    }
  /**
   * A mission closed (6.6 关闭), with its frozen closing snapshot: the label
   * revision it stands on (`asOf`), the unfinished tasks at that moment
   * (content), and the caller's snapshot document (proof states, risk list), if
   * any. A later close after repairs is a new version.
   */
  | {
      readonly kind: 'mission.close';
      readonly mission: MissionId;
      readonly version: number;
      readonly mode: 'with-risk' | 'full' | 'post-audit';
      readonly waitRunning: boolean;
      readonly asOf: number;
      readonly unfinished: ContentHash;
      readonly snapshot: ContentHash | null;
    }
  /** A delivery the user withdrew (6.6 授权 "没有被取消"; 6.6 "用户撤回过交付的除外"): it is never current again. */
  | { readonly kind: 'delivery.withdrawn'; readonly mission: MissionId; readonly delivery: string; readonly reason: string };

/**
 * The delivery an external action is for (6.6 steps 6 and 7), stored with its
 * intent: recovery of a ref creation reads the expected commit and ref name
 * from here ("ref exists and points to the expected commit → record
 * completion", 6.1 recovery table).
 */
export interface IntentDelivery {
  readonly mission: MissionId;
  /** The delivery's operation id (DeliveryKey.op; `delivery` in delivery.recorded). */
  readonly op: string;
  readonly commit: string;
  readonly base: string;
  /** refs/mission-pipeline/delivered/<mission>/<op>. */
  readonly ref: string;
  readonly targetBranch: string | null;
  /** The bound transform description (7.1), when known. */
  readonly description?: ContentHash | null;
  /**
   * The delivery record's content (the manifest recordDelivery takes), when the
   * delivery side stored it before creating the ref: recovery can then record
   * completion from the intent alone.
   */
  readonly manifest: ContentHash | null;
}

// ---------------------------------------------------------------- automatic loops (6.5)

/**
 * The automatic loops of 6.5, each with a cap per work lineage:
 * environment-failure retries (3 per failure class, 6 in total), mechanical-check
 * returns to Architect (3), feasibility returns (1), Reviewer rework (initial + 2),
 * restarts after quarantine or seat failure (2), delivery rebuilds (3, per
 * delivery), landing attempts that enter the push stage (the first + 3, per
 * delivery, whoever started them: v43 6.5, WI-06).
 */
export type LoopKind = 'env-retry' | 'mechanical-return' | 'feasibility-return' | 'rework' | 'quarantine-restart' | 'delivery-rebuild' | 'landing-attempt';

export const LOOP_KINDS: readonly LoopKind[] = ['env-retry', 'mechanical-return', 'feasibility-return', 'rework', 'quarantine-restart', 'delivery-rebuild', 'landing-attempt'];

/** Attempts allowed per lineage before grants (6.5). The one table every module reads. */
export const LOOP_CAPS: Readonly<Record<LoopKind, number>> = {
  'env-retry': 6,
  'mechanical-return': 3,
  'feasibility-return': 1,
  rework: 2,
  'quarantine-restart': 2,
  'delivery-rebuild': 3,
  'landing-attempt': 4,
};

/** env-retry: at most this many per failure class (6.5). */
export const ENV_RETRY_PER_CLASS = 3;

/** Loops where two equal failure signatures in a row do not mean "no progress" (6.5: delivery rebuilds follow someone else's push). */
export const NO_PROGRESS_EXEMPT: ReadonlySet<LoopKind> = new Set<LoopKind>(['delivery-rebuild']);

/**
 * Loops whose attempt is recorded when it starts (a landing attempt entering the
 * push stage; a delivery rebuild, recorded before it runs), so the memory
 * refuses an attempt on an exhausted loop (LOOP_EXHAUSTED, WI-08) and no
 * automatic path can run it again (6.5 "耗尽之后"). Other loops record a failure
 * that already happened and are never refused.
 */
export const LOOPS_REFUSED_WHEN_EXHAUSTED: ReadonlySet<LoopKind> = new Set<LoopKind>(['landing-attempt', 'delivery-rebuild']);

/** One attempt of an automatic loop. `signature` identifies the failure for no-progress detection. */
export interface LoopAttemptRecord {
  readonly kind: 'loop.attempt';
  readonly lineage: string;
  readonly loop: LoopKind;
  /** For env-retry: the failure class. */
  readonly failureClass: string | null;
  readonly signature: string;
}

/**
 * Extra attempts after a loop is exhausted: Secretary may grant once per lineage
 * (at most 2, with a reason); after that only the user (6.5).
 */
export interface LoopGrantRecord {
  readonly kind: 'loop.grant';
  readonly lineage: string;
  readonly loop: LoopKind;
  readonly by: 'secretary' | 'user';
  readonly extra: number;
  readonly reason: ContentHash;
}

/**
 * 用户原话 (10.1 item 6): one user message as the PM's prompt hook received it.
 * Written once per message id, in arrival order; WI-12's "last booked user
 * message" check reads the latest ones.
 */
export interface UserWordsRecord {
  readonly kind: 'user.words';
  /** Stable id of the message from the hook (one per user message). */
  readonly message: string;
  /** The PM session the message belongs to. */
  readonly session: string;
  /** When the user sent it (ms since the epoch, as the hook saw it). */
  readonly at: number;
  /** The full text in skeleton data. */
  readonly text: ContentHash;
  /** The first characters of the text (at most 280), for listings. */
  readonly excerpt: string;
}

/**
 * One fact of a flow line (src/flow/**: a PM batch, a consumed seat result, an
 * escalation and its decision, an exploration round...). Bookkeeping, never an
 * evaluator input. Its identity is (mission, line, event, key): the same
 * identity with the same body is a no-op, with another body FACT_CONFLICT. The
 * body is a canonical JSON document in skeleton data, typed by the flow
 * module that owns the line.
 */
export interface FlowEventRecord {
  readonly kind: 'flow.event';
  readonly mission: MissionId;
  /** 1..200 printable characters, e.g. "plan", "task:impl", "exploration:x1". */
  readonly line: string;
  /** 1..64 characters of [a-z0-9-]. */
  readonly event: string;
  /** 1..200 printable characters; unique within (mission, line, event). */
  readonly key: string;
  readonly body: ContentHash;
}

/**
 * A task entered the dispatch queue: a ready step of `mp pm next` (4.1 §5). The
 * queue is in the memory, so any later PM session sees it; "only queued tasks"
 * still counts as work that can advance (6.1).
 */
export interface TaskQueuedRecord {
  readonly kind: 'task.queued';
  readonly task: string;
  /** The work lineage its loop counters belong to (6.5). */
  readonly lineage: string;
  readonly mission: MissionId;
  /** The task's card (its spec) in skeleton data. */
  readonly card: ContentHash;
  /**
   * Who handed the task over (4.1 §3.2, U-13): the dispatch whose hand-back led to it (null: a PM
   * command or the program itself), the task it came from, the object versions it was handed
   * over on, and the step in words. Absent on records written before 4.1 package A3 r1, and on
   * the re-queue of a released dispatch (the original handover stands).
   */
  readonly queuedBy?: TaskHandover;
}

/** Who handed a queued task over (TaskQueuedRecord.queuedBy). */
export interface TaskHandover {
  readonly dispatch: string | null;
  readonly task: string | null;
  readonly objects: readonly string[];
  readonly step: string;
}

/** A task left the queue: dispatched (as a launch), cancelled, or superseded by another task (which keeps the lineage, 6.5). */
export interface TaskDequeuedRecord {
  readonly kind: 'task.dequeued';
  readonly task: string;
  readonly reason: 'dispatched' | 'cancelled' | 'superseded';
  /** dispatched: the launch it became. */
  readonly launch: LaunchId | null;
  /** superseded: the task that replaces it. */
  readonly by: string | null;
}

/** A mission blocked by budget or resources (6.5), with the snapshot, risk list and reason delivered to the PM. */
export interface MissionBlockRecord {
  readonly kind: 'mission.block';
  readonly mission: MissionId;
  readonly reason: 'budget' | 'resource';
  readonly state: 'blocked' | 'released';
  readonly report: ContentHash;
}

// ---------------------------------------------------------------- alerts and spend (bookkeeping)

/**
 * The PM's work instructions of 4.1 (design 4.1 §6.9): WI-01..08, 13, 16, 19..21, 23..26 carried
 * from 4.0, and WI-28..34 (interrupted dispatches, a broken event chain, missing or edited leaves and
 * unreachable commits, a repository outside the folder, labels that keep recomputing, an
 * exploration awaiting a ruling, a plan constraint-coverage gap). Numbers of retired WIs are not reused.
 */
export const WI_CATALOG: ReadonlySet<string> = new Set(['01', '02', '03', '04', '05', '06', '07', '08', '13', '16', '19', '20', '21', '23', '24', '25', '26', '28', '29', '30', '31', '32', '33', '34'].map((n) => `WI-${n}`));

/**
 * A system alert (3.9). An exception carries the PM work instruction for it
 * (3.11, from WI_CATALOG); the body carries the trigger facts and the default
 * action taken. A notice that is not an exception (a normal branch of the flow,
 * such as a stop report) says so with `informational: true` and has no WI
 * (core review r3 #18).
 */
export interface SystemAlertRecord {
  readonly kind: 'alert';
  readonly alert: AlertId;
  readonly category: string;
  readonly wi?: string;
  readonly informational?: true;
  readonly body: ContentHash;
}

export type BaseRecord =
  | BasisVersionRecord
  | ConstraintScopeRecord
  | BasisWithdrawnRecord
  | EnvSnapshotRecord
  | EvidenceRecord
  | EvidenceRevokedRecord
  | EvidenceRenewalRecord
  | ObjectVersionRecord
  | ProofUnitRecord
  | JudgmentRecord
  | IssueRecord
  | FixCoverageRecord
  | PendingOpRecord
  | OpExecutedRecord
  | EpisodeBatchRecord
  | NoticeRecord
  | SeatResultRecord
  | SystemAlertRecord
  | ServiceEventRecord
  | UserWordsRecord
  | FlowEventRecord
  | TaskQueuedRecord
  | TaskDequeuedRecord
  | ContinuationCheckRecord
  | LoopAttemptRecord
  | LoopGrantRecord
  | MissionBlockRecord;

export type BaseRecordKind = BaseRecord['kind'];

/** Records that can change derived state. Everything else is bookkeeping (6.1: never re-triggers the evaluator). */
export const EVALUATOR_INPUT_KINDS: ReadonlySet<BaseRecordKind> = new Set<BaseRecordKind>([
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

/** A committed record as read back from the memory. */
export interface Committed<R extends BaseRecord = BaseRecord> {
  readonly revision: Revision;
  readonly record: R;
}

// ---------------------------------------------------------------- resolved form for the evaluator

type ResolveRef<T> = T extends ListRef ? readonly string[] : T;
/** A record with every ListRef replaced by the list it points to. */
export type Resolved<R extends BaseRecord> = { readonly [K in keyof R]: ResolveRef<R[K]> };
