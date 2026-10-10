// Landing a delivery onto the target branch: option A, PM-run automatic landing
// (design v47: 6.6 step 7 "目标分支的占用", "落地的结果", "可以安全重试"; 6.1 for the
// program ref and timeouts; 6.5 for the landing-attempt count; 3.11 WI-01, WI-02,
// WI-04, WI-05, WI-06, WI-08, WI-10, WI-13, WI-19, WI-20; 13 risks 18, 25, 26, 27).
//
// Five phases, each written to the ledger (LandingJournal) before it starts:
//   authorize -> admit -> record-pre-state -> push -> verify.
// - authorize: the ledger re-checks stop limits and that the delivery is current.
// - admit: the view records the fixed worktree set (worktreeRecord.ts: identities,
//   locator files, HEADs and in-progress operations) and the target's occupancy
//   is classified: zero (a ref-only controlled landing), one (lands if it is the
//   registered main checkout or the PM allowed it, else WI-02; its directory must
//   exist, review r1 #3), many or in-operation (WI-01). Then the platform gate,
//   the delivery ref (WI-20), the base (WI-05), the transform description, bound
//   vs actual (WI-19), the materialized-change set (WI-13, WI-06; a gitlink
//   change is never landed automatically, v46), disk admission per destination.
// - record-pre-state: every recorded worktree's HEAD and index tree (for the
//   report) and, with one occupant, the approved worktree as "可以安全重试" needs
//   it (landingResult.ts; a worktree with sparse checkout or skip-worktree
//   entries is not landed into automatically, v47). Right before the push phase,
//   outside the namespace: the worktree set, the directories' identities and
//   presence, the occupancy class and location, and the base must still be as
//   recorded; otherwise the attempt ends before the push (A). Then the attempt is
//   counted in the ledger (6.5: the first + 3 per delivery); an exhausted count
//   refuses it (WI-08) and nothing is pushed.
// - push: the command the one generator gives for the occupancy class (v47,
//   LandingView.pushPlan): zero -> the receiver refuses any checkout; one -> the
//   receiver sees only the approved worktree and updates it only through the
//   program's push-to-checkout hook, from the recorded base, with the delivery's
//   attributes and sparse checkout off (v46, v47).
// - verify: right after the push, every worktree NOT in the record is scanned
//   from outside the namespace (v37, v38); then every recorded worktree is
//   classified for the report (expected / race signature / branch advanced, files
//   stale / cannot determine, v40); right before reporting, every "branch
//   advanced, files stale" worktree is read again and gets the recovery command
//   only if that exact state still holds (v38). The RESULT is classified in the
//   fixed order of landingResult.ts: landed; a leftover lock (C); zero occupancy
//   by the target ref (B or base moved); one occupancy by the approved worktree
//   as a whole (B or base moved if safe to retry); else C.
// Once the push phase has started, recovery always verifies first (after making
// sure the old push process is gone), from the persisted record alone (no
// repository discovery, review r1 #10), and never pushes again.
//
// Every refusal and every alert names its work instruction (3.11's exception
// table) and reaches the PM through the journal. All git commands of a landing
// name their repository explicitly (SafeGit locators); those touching the
// repository run in the view (landingView.ts).

import { execFile } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { GitOid, MissionId, OpId } from '../common/ids.ts';
import { LOOP_CAPS } from '../common/records.ts';
import { admit, landingDemands, probeFs, type AdmissionDecision, type FsProbe, type FsStats, type LedgerReserve } from './admission.ts';
import { computeMaterializedChangeSet, type ChangeSetEntry, type MaterializedChangeSet, type MaterializedSide } from './changeSet.ts';
import {
  classifyLandingOutcome,
  hasHiddenEntries,
  pathState,
  readApprovedState,
  samePathState,
  type ApprovedState,
  type LandingOutcome,
  type PathState,
  type ResultClass,
} from './landingResult.ts';
import { DEFAULT_BWRAP, LandingView, shellQuote, worktreePrivateDirs, type CheckoutHookOptions, type PushBinding, type PushPlan } from './landingView.ts';
import { ancestry, discoverRepo, gitOid, parentDir, readObjects, repoArgs, type RepoLayout } from './objects.ts';
import { classifyProgramRef, deliveryRef, type ProgramRefName } from './refs.ts';
import {
  AttributeEvaluator,
  readTransformDescription,
  sha256File,
  toWorktree,
  transformDescriptionDifferences,
  transformDescriptionHash,
  type TransformDescription,
} from './representation.ts';
import {
  findProcessesByToken,
  GitTimeoutError,
  isProcessAlive,
  killProcess,
  SYSTEM_PATH,
  type GitResult,
  type ProcessIdentity,
  type SafeGit,
  type UserGitEnvironment,
} from './safeGit.ts';
import {
  compareWorktreeWithDelivery,
  readWorktreeHeadAndIndex,
  STALE_RECOVERY_NOTE,
  staleFilesRecoveryCommand,
  type CompareContext,
  type DeliveryRelation,
  type WorktreeComparison,
} from './worktreeCompare.ts';
import {
  identityProblems,
  occupies,
  registeredWorktrees,
  worktreeLocators,
  WorktreeIdentityChanged,
  type IdentityProblem,
  type Occupancy,
  type RecordedWorktree,
  type RegisteredWorktree,
  type WorktreeRecord,
} from './worktreeRecord.ts';

export { pathState, type ApprovedState, type LandingOutcome, type PathState } from './landingResult.ts';

// ---------------------------------------------------------------- journal

export interface LandingKey {
  readonly mission: MissionId;
  readonly op: OpId;
}

export type LandingPhase = 'authorize' | 'admit' | 'record-pre-state' | 'push' | 'verify';
export const LANDING_PHASES: readonly LandingPhase[] = ['authorize', 'admit', 'record-pre-state', 'push', 'verify'];

export type PhaseRecord =
  | { readonly phase: 'authorize' }
  | { readonly phase: 'admit' }
  | { readonly phase: 'record-pre-state' }
  /** `record`: the fixed worktree set, so recovery checks the same directory objects (6.6 v36) and needs no discovery (review r1 #10). */
  | { readonly phase: 'push'; readonly pre: PreLandingState; readonly token: string; readonly record?: WorktreeRecord }
  | { readonly phase: 'verify'; readonly push: PushOutcome | 'unknown' };

export type LandingAuthorization = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface LandingJournalState {
  readonly phases: readonly PhaseRecord[];
  readonly pushProcess: ProcessIdentity | null;
  readonly report: LandingReport | null;
}

/** The work instructions a landing can raise (design 3.11, the exception table). */
export type LandingWorkInstruction = 'WI-01' | 'WI-02' | 'WI-04' | 'WI-05' | 'WI-06' | 'WI-08' | 'WI-10' | 'WI-13' | 'WI-19' | 'WI-20';

/** 6.5: landing attempts that enter the push stage, per delivery, whoever starts them (the first + 3). */
export const LANDING_ATTEMPT_CAP: number = LOOP_CAPS['landing-attempt'];

export type PushStageEntry = { readonly ok: true; readonly attempt: number } | { readonly ok: false; readonly reason: string };

/**
 * An exception notice for the PM (3.11): the work instruction, the trigger with
 * its evidence, and the default action the program has taken. Never blocks
 * anything but this one landing.
 */
export interface LandingNotice {
  readonly wi: LandingWorkInstruction;
  readonly category: string;
  readonly trigger: string;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly defaultAction: string;
}

/**
 * Phase persistence and authorization. The ledger service implements it (6.1:
 * external actions are authorized and their intent written before they start).
 * Every method resolves only after its record is durable.
 */
export interface LandingJournal {
  /** Re-checks stop limits and that this delivery is still current; refuses after a stop. */
  authorize(key: LandingKey): Promise<LandingAuthorization>;
  /** Records that `record.phase` begins. */
  beginPhase(key: LandingKey, record: PhaseRecord): Promise<void>;
  /**
   * 6.5, WI-06: counts this attempt as it enters the push stage (the ledger's
   * `landing-attempt` loop of the delivery). An exhausted count is refused
   * (LOOP_EXHAUSTED, WI-08): the attempt then ends before the push.
   */
  enterPushStage(key: LandingKey, signature: string): Promise<PushStageEntry>;
  /** Records the push process (pid, start time, boot id) so recovery can confirm it exited (6.1). */
  recordPushProcess(key: LandingKey, p: ProcessIdentity): Promise<void>;
  /** Delivers a space reminder to the PM as a system alert BEFORE the push (6.6 空间提醒). Never blocks the landing. */
  remind(key: LandingKey, message: string): Promise<void>;
  /** Sends an exception notice with its work instruction to the PM (3.11). */
  notify(key: LandingKey, notice: LandingNotice): Promise<void>;
  /** Records the final report; a landing with a report is finished. */
  complete(key: LandingKey, report: LandingReport): Promise<void>;
  load(key: LandingKey): Promise<LandingJournalState | null>;
}

export class SimulatedCrash extends Error {
  constructor(where: string) {
    super(`simulated crash: ${where}`);
    this.name = 'SimulatedCrash';
  }
}

/** In-memory journal for tests. Crash points make a method throw as if the engine died there. */
export class MemoryLandingJournal implements LandingJournal {
  authorization: LandingAuthorization = { ok: true };
  /** Throw when this phase begins: before or after its record is stored. */
  crashAtPhase: { readonly phase: LandingPhase; readonly when: 'before-record' | 'after-record' } | null = null;
  /** Throw from recordPushProcess after storing it: the push keeps running while the "engine" is gone. */
  crashAfterPushProcess = false;
  /** Test hook, run after a phase record is stored (e.g. to simulate a user acting during the landing). */
  onBeginPhase: ((record: PhaseRecord) => void | Promise<void>) | null = null;
  readonly authorizeCalls: LandingKey[] = [];
  readonly reminders: { readonly key: LandingKey; readonly message: string; readonly phasesSoFar: readonly LandingPhase[] }[] = [];
  readonly notices: LandingNotice[] = [];
  /** Push-stage attempts per delivery (6.5) and the cap (LOOP_CAPS['landing-attempt'] plus grants). */
  readonly pushStageAttempts = new Map<string, string[]>();
  attemptCap: number = LANDING_ATTEMPT_CAP;
  private readonly states = new Map<string, { phases: PhaseRecord[]; pushProcess: ProcessIdentity | null; report: LandingReport | null }>();

  private state(key: LandingKey): { phases: PhaseRecord[]; pushProcess: ProcessIdentity | null; report: LandingReport | null } {
    const k = `${key.mission}\0${key.op}`;
    let s = this.states.get(k);
    if (s === undefined) {
      s = { phases: [], pushProcess: null, report: null };
      this.states.set(k, s);
    }
    return s;
  }

  async authorize(key: LandingKey): Promise<LandingAuthorization> {
    this.authorizeCalls.push(key);
    return this.authorization;
  }

  async beginPhase(key: LandingKey, record: PhaseRecord): Promise<void> {
    const c = this.crashAtPhase;
    if (c !== null && c.phase === record.phase && c.when === 'before-record') throw new SimulatedCrash(`before ${record.phase}`);
    this.state(key).phases.push(structuredClone(record));
    if (c !== null && c.phase === record.phase && c.when === 'after-record') throw new SimulatedCrash(`after ${record.phase}`);
    if (this.onBeginPhase !== null) await this.onBeginPhase(record);
  }

  async enterPushStage(key: LandingKey, signature: string): Promise<PushStageEntry> {
    const k = `${key.mission}\0${key.op}`;
    const list = this.pushStageAttempts.get(k) ?? [];
    if (list.length >= this.attemptCap) return { ok: false, reason: `landing-attempt is exhausted (${list.length} of ${this.attemptCap} attempts)` };
    list.push(signature);
    this.pushStageAttempts.set(k, list);
    return { ok: true, attempt: list.length };
  }

  async recordPushProcess(key: LandingKey, p: ProcessIdentity): Promise<void> {
    this.state(key).pushProcess = { ...p };
    if (this.crashAfterPushProcess) throw new SimulatedCrash('after recording the push process');
  }

  async remind(key: LandingKey, message: string): Promise<void> {
    this.reminders.push({ key, message, phasesSoFar: this.state(key).phases.map((p) => p.phase) });
  }

  async notify(_key: LandingKey, notice: LandingNotice): Promise<void> {
    this.notices.push(structuredClone(notice));
  }

  async complete(key: LandingKey, report: LandingReport): Promise<void> {
    this.state(key).report = structuredClone(report);
  }

  async load(key: LandingKey): Promise<LandingJournalState | null> {
    const s = this.states.get(`${key.mission}\0${key.op}`);
    return s === undefined ? null : structuredClone(s);
  }
}

// ---------------------------------------------------------------- reports

export type NotAutoLandedReason =
  | 'platform'
  | 'authorization-refused'
  | 'invalid-target'
  | 'delivery-ref-mismatch'
  | 'not-descendant'
  | 'transform-description-changed'
  | 'unsupported-transform'
  | 'unsafe-path'
  | 'attribute-only-change'
  | 'lfs-object-missing'
  | 'interrupted-before-push'
  /** v40: the target branch is checked out in more than one recorded worktree. */
  | 'target-in-several-worktrees'
  /** v41: a rebase or bisect in progress holds the target branch (or the worktree holding it). */
  | 'target-busy'
  /** v41: the only worktree holding the target is not the registered main checkout. */
  | 'target-in-external-worktree'
  /** v40-v42: right before the push, the target's occupancy class or location is no longer the recorded one. */
  | 'occupancy-changed'
  /** v42 (WI-05): the target branch is no longer at the delivery's base: rebuild on the new base. */
  | 'base-moved'
  /** v36: right before the push, the worktree set is no longer the recorded one. */
  | 'worktrees-changed'
  /** v36: a recorded directory is no longer the recorded directory object. */
  | 'worktree-identity-changed'
  | 'insufficient-space'
  /** Review r1 #3: the worktree holding the target is registered but its directory is missing (git still counts it). */
  | 'worktree-root-missing'
  /** v46: the materialized-change set has a gitlink change (added, removed, re-pointed, or a type change). */
  | 'submodule-change'
  /** v47: the approved worktree has sparse checkout enabled or skip-worktree entries. */
  | 'sparse-checkout'
  /** The approved worktree could not be read before the push: "safe to retry" could never be judged. */
  | 'worktree-unreadable'
  /** 6.5, WI-08: this delivery's landing attempts that enter the push stage are used up. */
  | 'attempts-exhausted'
  /** v49: a shallow repository: whether the target contains a commit cannot be confirmed from its history. */
  | 'shallow-repository'
  /** v49: a partial clone (extensions.partialClone or a promisor remote): reading a missing object would fetch it. */
  | 'partial-clone'
  /** v49: an ancestry judgment before the push could not be confirmed (a missing commit). */
  | 'history-unconfirmed'
  /** v50, v51: the reftable ref backend: the program creates no ref and never lands (the user converts it to files). */
  | 'reftable'
  /** v50: a repository extension the program does not know. */
  | 'unsupported-extension';

/**
 * What each refusal means for the PM (3.11 and its exception table): its work
 * instruction, and the default action already taken. Every refusal here ends the
 * attempt before the push stage (WI-06 class A): nothing was written.
 */
export const REFUSAL_WORK_INSTRUCTIONS: Readonly<Record<NotAutoLandedReason, { readonly wi: LandingWorkInstruction; readonly category: string; readonly defaultAction: string }>> = {
  platform: { wi: 'WI-06', category: 'landing-not-completed', defaultAction: 'class A: the delivery ref is kept and nothing is landed; this platform has no controlled view, so the PM gives the user the merge command (option 4)' },
  'authorization-refused': {
    wi: 'WI-06',
    category: 'landing-not-completed',
    defaultAction:
      'class A: the delivery ref is kept and nothing is landed: the ledger refused the authorization (a stop, which is a safety floor; another landing of this repository; or a delivery that is not the current one or was withdrawn). No new attempt is made automatically',
  },
  'invalid-target': { wi: 'WI-06', category: 'landing-not-completed', defaultAction: 'class A: the delivery ref is kept and nothing is landed: the target branch name is invalid' },
  'delivery-ref-mismatch': { wi: 'WI-20', category: 'program-namespace-mismatch', defaultAction: 'the delivery ref points elsewhere: it is not redone and no completion is recorded; the delivery stays to be verified' },
  'not-descendant': { wi: 'WI-06', category: 'landing-not-completed', defaultAction: 'class A: nothing is landed: the delivery commit is not built on the recorded base' },
  'transform-description-changed': { wi: 'WI-19', category: 'transform-description-changed', defaultAction: 'class A: the delivery ref is kept and nothing is landed; no automatic rebuild; a new attempt starts by itself once the settings match the bound description again' },
  'unsupported-transform': { wi: 'WI-13', category: 'landing-unsupported-transform', defaultAction: 'class A: the delivery ref is kept and nothing is landed; the user lands these paths by hand' },
  'unsafe-path': { wi: 'WI-06', category: 'landing-not-completed', defaultAction: 'class A: the delivery ref is kept and nothing is landed: a path is not safe to write into a worktree' },
  'attribute-only-change': { wi: 'WI-06', category: 'landing-not-completed', defaultAction: 'class A: the delivery ref is kept and nothing is landed; the user lands it by hand with the commands given (option 4)' },
  'lfs-object-missing': {
    wi: 'WI-13',
    category: 'landing-lfs-missing',
    defaultAction: 'class A: the delivery ref is kept and nothing is landed (a landing never fetches, v49, v50); a new attempt starts by itself once the objects are local again (`git lfs fetch`, run by the user)',
  },
  'interrupted-before-push': { wi: 'WI-06', category: 'landing-not-completed', defaultAction: 'class A: nothing outside the ledger happened; a new attempt is started' },
  'target-in-several-worktrees': { wi: 'WI-01', category: 'landing-occupancy', defaultAction: 'the attempt ended before the push; the delivery ref is kept; re-checked on every change of the target branch or the worktrees and at least every 10 minutes; a new attempt starts once the occupancy is zero or one' },
  'target-busy': { wi: 'WI-01', category: 'landing-occupancy', defaultAction: 'the attempt ended before the push; the delivery ref is kept; re-checked on every change and at least every 10 minutes; a new attempt starts once the rebase or bisect is over' },
  'target-in-external-worktree': { wi: 'WI-02', category: 'landing-external-occupant', defaultAction: 'the attempt ended before the push; nothing is landed into the external worktree; the delivery ref is kept; re-evaluated when it gives up the target branch or has been idle for 10 minutes' },
  'occupancy-changed': { wi: 'WI-06', category: 'landing-not-completed', defaultAction: 'class A: the push was not started; the next check classifies the occupancy again: zero or one starts a new attempt, many or in-operation is WI-01' },
  'worktrees-changed': { wi: 'WI-06', category: 'landing-not-completed', defaultAction: 'class A: the push was not started; a new attempt records the worktrees anew' },
  'worktree-identity-changed': { wi: 'WI-06', category: 'landing-not-completed', defaultAction: 'class A: the push was not started; a new attempt records the worktrees anew' },
  'insufficient-space': { wi: 'WI-06', category: 'landing-not-completed', defaultAction: 'class A: the delivery ref is kept and nothing is landed; a new attempt starts when the disk or the worktree changes (WI-10 reminder sent)' },
  'base-moved': { wi: 'WI-05', category: 'delivery-base-moved', defaultAction: 'class A: nothing is landed; the delivery is rebuilt on the new base once the target branch is quiet (every rebuild counts)' },
  'worktree-root-missing': {
    wi: 'WI-06',
    category: 'landing-not-completed',
    defaultAction:
      'class A: the push was not started; git still counts the missing worktree as holding the target branch. Restore its directory or let its owner run `git worktree prune`; the next check records the worktrees anew and starts a new attempt',
  },
  'submodule-change': {
    wi: 'WI-06',
    category: 'landing-not-completed',
    defaultAction: 'class A: the delivery ref is kept and nothing is landed: a landing never enters a submodule; the user or an agent merges by hand and runs `git submodule update` (option 4)',
  },
  'sparse-checkout': {
    wi: 'WI-06',
    category: 'landing-not-completed',
    defaultAction:
      'class A: the delivery ref is kept and nothing is landed: the worktree has sparse checkout or skip-worktree entries, where git\'s own "clean" cannot be trusted; a new attempt starts by itself once that changes, or the delivery is merged by hand (option 4)',
  },
  'worktree-unreadable': {
    wi: 'WI-06',
    category: 'landing-not-completed',
    defaultAction: 'class A: the push was not started because the worktree it would update could not be read; a new attempt starts when the worktree changes',
  },
  'shallow-repository': {
    wi: 'WI-06',
    category: 'landing-not-completed',
    defaultAction: 'class A: the delivery ref is kept and nothing is landed: in a shallow repository ancestry cannot be confirmed; the user merges by hand (option 4) or deepens the history',
  },
  'partial-clone': {
    wi: 'WI-06',
    category: 'landing-not-completed',
    defaultAction: 'class A: the delivery ref is kept and nothing is landed: a partial clone may need objects it does not have, and a landing never fetches; the user merges by hand (option 4)',
  },
  'history-unconfirmed': {
    wi: 'WI-06',
    category: 'landing-not-completed',
    defaultAction: 'class A: nothing is landed: the ancestry of the delivery could not be confirmed from the local history (a missing commit); the PM checks the repository',
  },
  reftable: {
    wi: 'WI-13',
    category: 'landing-unsupported-repository',
    defaultAction:
      'not landed and no ref created: with the reftable ref backend one ref update can rewrite the whole table stack and its lock covers every ref, so neither admission nor the lock rules hold (v51). The PM tells the user to convert the repository with `git refs migrate --ref-format=files`; after that a new delivery can run',
  },
  'unsupported-extension': {
    wi: 'WI-13',
    category: 'landing-unsupported-repository',
    defaultAction: 'not landed: the repository uses an extension the program does not support; the delivery ref is kept and the user merges by hand (option 4)',
  },
  'attempts-exhausted': {
    wi: 'WI-08',
    category: 'loop-exhausted',
    defaultAction:
      'nothing is pushed: this delivery used its 4 landing attempts that entered the push stage (6.5); the delivery ref is kept; the Secretary may grant once (at most 2 more), after that only the user decides',
  },
};

/**
 * git's own words about a refused push: for the report only; the result is
 * classified by the check (6.6 "落地的结果"), never by these.
 */
export type PushRejection = 'stale-lease' | 'checked-out' | 'checkout-hook-declined' | 'worktree-has-changes' | 'worktree-update-failed' | 'other';

export type PushOutcome =
  | { readonly kind: 'updated'; readonly summary: string }
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'rejected'; readonly reason: PushRejection; readonly summary: string; readonly stderr: string }
  | { readonly kind: 'error'; readonly code: number | null; readonly stderr: string }
  /** v36: a recorded directory changed identity when the push was about to start: it was not started. */
  | { readonly kind: 'not-run'; readonly reason: string };

export type WorktreeVerdict =
  | { readonly kind: 'expected'; readonly worktree: string; readonly note: string }
  /** HEAD left the target branch during landing and the index became the delivery tree: git's receive-side race (risk 18). */
  | { readonly kind: 'race-signature'; readonly worktree: string; readonly branch: string | null; readonly recovery: string }
  /**
   * v40: HEAD is now the delivery commit while index and files are still the
   * base (a second checkout of the target the receiving side did not update).
   * `recovery` only when a re-check right before the report found exactly that.
   */
  | { readonly kind: 'branch-advanced-files-stale'; readonly worktree: string; readonly branch: string | null; readonly recovery: string | null; readonly note: string }
  /** Changed during landing in a way the program cannot attribute; the changes are listed. */
  | { readonly kind: 'cannot-determine'; readonly worktree: string; readonly changes: readonly string[] };

/** v37, v38: a worktree registered after the fixed set was recorded, as found by the scan right after the push. */
export interface NewWorktreeReport {
  readonly path: string;
  readonly gitDir: string | null;
  readonly branch: string | null;
  readonly head: GitOid | null;
  /** The classification at the re-check right before the report ("consistent" ones are not reported). */
  readonly kind: Exclude<DeliveryRelation, 'consistent'>;
  /** What the scan right after the push found. */
  readonly firstScan: DeliveryRelation;
  readonly differing: readonly string[];
  readonly detail: string;
  /** Only when the re-check found HEAD = delivery and index = files = base (v38). */
  readonly recovery: string | null;
}

export interface LandingVerification {
  readonly overall: 'expected' | 'race-signature' | 'branch-advanced-files-stale' | 'cannot-determine';
  readonly targetBefore: GitOid | null;
  readonly targetAfter: GitOid | null;
  /** The target branch contains the delivery commit (6.6 step 8). */
  readonly landed: boolean;
  readonly worktrees: readonly WorktreeVerdict[];
  /**
   * Lock files present when checking: left by a push that was killed (they block
   * the user's next git command), or held by a git command running right now.
   * The program never removes them: it does not change the user's index or refs.
   */
  readonly leftoverLocks: readonly string[];
  /** Worktrees registered after the fixed set was recorded, except consistent ones (v37, v38). */
  readonly newWorktrees: readonly NewWorktreeReport[];
  /** Recorded directories that were no longer the recorded objects when checked (v36). */
  readonly identityChanged: readonly IdentityProblem[];
  /** v49: whether the target contains the delivery could not be confirmed (a shallow boundary or a missing commit): C. */
  readonly historyUnconfirmed: boolean;
}

/** Every index.lock of the repository and the target branch's ref lock, for the report (the program never removes them). */
function leftoverLocks(commonDir: string, targetRef: string): string[] {
  const candidates = [join(commonDir, 'index.lock'), ...targetRefLocks(commonDir, targetRef)];
  for (const dir of worktreePrivateDirs(commonDir).slice(1)) candidates.push(join(dir, 'index.lock'));
  return candidates.filter((p) => lexists(p));
}

/** The target branch's ref lock: the loose ref's in the files backend, the stack's in reftable. */
function targetRefLocks(commonDir: string, targetRef: string): string[] {
  return [join(commonDir, `${targetRef}.lock`), join(commonDir, 'reftable', 'tables.list.lock')];
}

/**
 * 6.6 v45: the locks THIS landing could have left behind once its push process
 * is gone: the target branch's ref lock and, with one occupant, the approved
 * worktree's index.lock. Any of them makes the result C.
 */
export function landingLocks(commonDir: string, targetRef: string, approvedGitDir: string | null): string[] {
  const candidates = targetRefLocks(commonDir, targetRef);
  if (approvedGitDir !== null) candidates.push(join(approvedGitDir, 'index.lock'));
  return candidates.filter((p) => lexists(p));
}

export type LandingReport =
  | {
      readonly kind: 'not-auto-landed';
      readonly reason: NotAutoLandedReason;
      /** The PM's work instruction for this refusal (3.11). */
      readonly wi: LandingWorkInstruction;
      readonly detail: string;
      readonly paths: readonly string[];
      /** What the PM gives the user to merge by hand; the delivery ref is kept. */
      readonly manualCommands: readonly string[];
    }
  | {
      readonly kind: 'checked';
      readonly push: PushOutcome | 'unknown';
      readonly verification: LandingVerification;
      /** v42-v47 (landingResult.ts): landed, B (safe to retry: a new attempt, never a replay), base moved (a rebuild, WI-05) or C (never redone automatically). */
      readonly outcome: LandingOutcome;
      /** B: a new landing attempt; base moved: a rebuild (WI-05); a C caused only by leftover locks: a new attempt once they are gone. */
      readonly next: ResultClass['next'];
      /** Why the result is in its class. */
      readonly why: string;
      /** Zero or one occupancy: what the classification looked at; null when nothing was pushed because the target already contained the delivery. */
      readonly binding: 'zero' | 'one' | null;
      /** The approved worktree after the push (one occupancy), as the classification read it. */
      readonly approvedAfter: ApprovedState | null;
      /** The locks this landing could have left that were still there (6.6 v45). */
      readonly locks: readonly string[];
      /** Space reminders for the PM (6.6 空间提醒); they never block. */
      readonly reminders: readonly string[];
      /** The disk admission per write destination (6.6); null in a recovery report. */
      readonly admission: AdmissionDecision | null;
      readonly recovered: boolean;
    }
  | { readonly kind: 'push-unconfirmed'; readonly detail: string; readonly processes: readonly ProcessIdentity[] };

// ---------------------------------------------------------------- platform gate (6.6 step 7.6)

export interface LandingPlatform {
  readonly supported: boolean;
  readonly reason: string | null;
  readonly wsl: boolean;
}

export async function detectLandingPlatform(bwrapPath: string = DEFAULT_BWRAP): Promise<LandingPlatform> {
  if (process.platform !== 'linux') {
    return { supported: false, reason: `automatic landing needs a bubblewrap mount namespace (Linux or WSL); this is ${process.platform}`, wsl: false };
  }
  let wsl = false;
  try {
    wsl = /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    /* not fatal */
  }
  const ok = await new Promise<string | null>((resolve) => {
    execFile(
      bwrapPath,
      ['--unshare-pid', '--unshare-net', '--die-with-parent', '--dev-bind', '/', '/', '--', '/bin/true'],
      { timeout: 10_000, env: { PATH: SYSTEM_PATH } },
      (err) => resolve(err === null ? null : String(err)),
    );
  });
  if (ok !== null) return { supported: false, reason: `bubblewrap is not usable here: ${ok}`, wsl };
  return { supported: true, reason: null, wsl };
}

// ---------------------------------------------------------------- occupancy (v40-v42)

/** One worktree's claim on the target branch, recorded or as registered now. */
export interface OccupantView {
  readonly root: string | null;
  readonly gitDir: string;
  readonly occupancy: Occupancy;
  /** Registered, but its directory is missing (git still counts what it holds). */
  readonly prunable?: boolean;
}

/**
 * 6.6 v42 "目标分支的占用": zero (nobody holds the target: only the ref moves),
 * one (exactly one worktree has it checked out, no operation in progress),
 * many (checked out more than once), in-operation (a rebase or bisect holds it).
 */
export type OccupancyClass = 'zero' | 'one' | 'many' | 'in-operation';

export type OccupancyDecision =
  | {
      readonly ok: true;
      readonly class: 'zero' | 'one';
      /** The worktree (by git dir) the receiving side will update; null for zero: only the ref moves. */
      readonly holder: string | null;
    }
  | { readonly ok: false; readonly class: OccupancyClass; readonly reason: NotAutoLandedReason; readonly detail: string; readonly worktrees: readonly string[] };

function describeOccupant(o: OccupantView): string {
  const what: string[] = [];
  if (o.occupancy.branch !== null) what.push(`HEAD ${o.occupancy.branch}`);
  if (o.occupancy.rebasing !== null) what.push(`rebasing ${o.occupancy.rebasing}`);
  if (o.occupancy.bisecting !== null) what.push(`bisecting from ${o.occupancy.bisecting}`);
  return `${o.root ?? o.gitDir} (${what.join(', ') || 'detached'})`;
}

/** v42: the class of the target's occupancy and, for zero or one, the worktree the push updates. */
export function classifyOccupancy(worktrees: readonly OccupantView[], targetRef: string): { readonly class: OccupancyClass; readonly occupants: readonly OccupantView[] } {
  const occupants = worktrees.filter((w) => occupies(w.occupancy, targetRef));
  if (occupants.some((w) => w.occupancy.inProgress)) return { class: 'in-operation', occupants };
  if (occupants.length > 1) return { class: 'many', occupants };
  return { class: occupants.length === 1 ? 'one' : 'zero', occupants };
}

/**
 * 6.6 v42 (WI-01, WI-02): zero lands as a ref-only controlled landing; one lands
 * normally if it is the registered main checkout, or the worktree the PM allowed
 * for this landing (WI-02 option 2); many and in-operation are WI-01. There is no
 * "designate one of many" (v42): git's receiving side picks the worktree itself.
 */
export function decideOccupancy(worktrees: readonly OccupantView[], targetRef: string, mainCheckout: string | null, allowExternal: string | null = null): OccupancyDecision {
  const { class: cls, occupants } = classifyOccupancy(worktrees, targetRef);
  const names = (ws: readonly OccupantView[]): string[] => ws.map((w) => w.root ?? w.gitDir);
  if (cls === 'in-operation') {
    const busy = occupants.filter((w) => w.occupancy.inProgress);
    return {
      ok: false,
      class: cls,
      reason: 'target-busy',
      detail: `${targetRef} is held by a rebase or bisect in progress: ${busy.map(describeOccupant).join('; ')}; landing would destroy it`,
      worktrees: names(busy),
    };
  }
  if (cls === 'many') {
    return {
      ok: false,
      class: cls,
      reason: 'target-in-several-worktrees',
      detail: `${targetRef} is checked out in ${occupants.length} worktrees: ${occupants.map(describeOccupant).join('; ')}; the receiving side would update only one`,
      worktrees: names(occupants),
    };
  }
  const only = occupants[0];
  if (cls === 'zero' || only === undefined) return { ok: true, class: 'zero', holder: null };
  if (only.prunable === true) {
    // Review r1 #3: a directory that is missing has no recorded identity and no admission; if it reappeared
    // during the landing, the receiving side would write into it. Never land into a missing worktree.
    return {
      ok: false,
      class: cls,
      reason: 'worktree-root-missing',
      detail: `${targetRef} is checked out in the registered worktree ${only.root ?? only.gitDir}, whose directory is missing`,
      worktrees: names([only]),
    };
  }
  if (only.root !== null && (only.root === mainCheckout || only.root === allowExternal)) return { ok: true, class: 'one', holder: only.gitDir };
  return {
    ok: false,
    class: cls,
    reason: 'target-in-external-worktree',
    detail:
      mainCheckout === null
        ? `${targetRef} is checked out only in ${only.root ?? only.gitDir}, and no main checkout is registered for this repository`
        : `${targetRef} is checked out only in ${only.root ?? only.gitDir}, not in the registered main checkout ${mainCheckout}`,
    worktrees: names([only]),
  };
}

// ---------------------------------------------------------------- worktree state

export interface WorktreeState {
  /** The worktree root (the common dir for a bare repository). */
  readonly path: string;
  readonly gitDir: string;
  readonly bare: boolean;
  readonly prunable: boolean;
  /** Full ref name HEAD points to; null when detached. */
  readonly branch: string | null;
  /** HEAD commit; null when unborn. */
  readonly head: GitOid | null;
  /** The tree the index corresponds to (computed without writing anything); null when unmerged or not applicable. */
  readonly indexTree: GitOid | null;
  readonly unmerged: boolean;
}

export interface PreLandingState {
  readonly targetRef: string;
  readonly targetBefore: GitOid | null;
  readonly worktrees: readonly WorktreeState[];
  /** The worktree that holds the target branch and that the push updates, if any. */
  readonly targetWorktree: string | null;
  /** The change-set paths in that worktree before the push. */
  readonly targetFiles: readonly { readonly path: string; readonly state: PathState }[];
  /** v42: the change-set paths in every recorded worktree with a root, before the push (for the report). */
  readonly files?: readonly { readonly worktree: string; readonly files: readonly { readonly path: string; readonly state: PathState }[] }[];
  /** v43-v47: which receiving side the push uses: zero (refuse) or one (the approved worktree only). Absent in a record from before v43: treated as unknown. */
  readonly binding?: 'zero' | 'one';
  /** v44-v47: the approved worktree as "可以安全重试" needs it (one occupancy). */
  readonly approved?: ApprovedState | null;
}

/** One recorded worktree's HEAD and index, inside the view, named by its own locators (6.6 v38). */
async function recordedWorktreeState(git: SafeGit, repo: RepoLayout, view: LandingView, w: RecordedWorktree): Promise<{ state: WorktreeState; skipWorktree: Set<string> }> {
  const path = w.root ?? view.commonDir;
  if (w.root === null || w.prunable) {
    return {
      state: { path, gitDir: w.gitDir, bare: w.root === null, prunable: w.prunable, branch: w.branch, head: w.head, indexTree: null, unmerged: false },
      skipWorktree: new Set(),
    };
  }
  const sgit = git.withSandbox(view);
  let s;
  try {
    s = await readWorktreeHeadAndIndex(sgit, repo, worktreeLocators(view.record, w), w.root);
  } catch (e) {
    if (e instanceof WorktreeIdentityChanged) throw e;
    // Unreadable (for instance an index that is a link, review r2 #1): recorded as such; never read through.
    return { state: { path, gitDir: w.gitDir, bare: false, prunable: false, branch: w.branch, head: w.head, indexTree: null, unmerged: false }, skipWorktree: new Set() };
  }
  return {
    state: { path, gitDir: w.gitDir, bare: false, prunable: false, branch: s.branch, head: s.head, indexTree: s.indexTree, unmerged: s.indexTree === null },
    skipWorktree: s.skipWorktree,
  };
}

async function readRef(git: SafeGit, repo: RepoLayout, ref: string, peel: 'commit' | 'tree' = 'commit'): Promise<GitOid | null> {
  const rev = peel === 'commit' ? `${ref}^{commit}` : ref;
  const r = await git.run([...repoArgs(repo), 'rev-parse', '--verify', '--quiet', '--end-of-options', rev], { cwd: repo.commonDir, locators: { gitDir: repo.commonDir } });
  return r.code === 0 ? gitOid(r.stdout.toString('utf8').trim()) : null;
}

/** The repository layout every landing command uses: the common dir as the git dir (6.6 v38). */
function commonLayout(repo: RepoLayout, commonDir: string): RepoLayout {
  return { ...repo, gitDir: commonDir, commonDir };
}

/**
 * The state the verification compares against, inside the view. `holder`: the
 * recorded worktree (by root) that holds the target branch and that the push
 * updates; by default the one recorded on the target branch.
 */
export async function recordPreLandingState(
  git: SafeGit,
  repo: RepoLayout,
  view: LandingView,
  targetRef: string,
  changeSet: MaterializedChangeSet,
  holder?: string | null,
): Promise<PreLandingState> {
  const crepo = commonLayout(repo, view.commonDir);
  const states: WorktreeState[] = [];
  for (const w of view.record.worktrees) states.push((await recordedWorktreeState(git, crepo, view, w)).state);
  const holderPath = holder !== undefined ? holder : (states.find((s) => s.branch === targetRef && !s.bare && !s.prunable)?.path ?? null);
  const filesOf = (root: string) => changeSet.entries.map((e) => ({ path: e.path, state: pathState(join(root, e.path)) }));
  const targetFiles = holderPath === null ? [] : filesOf(holderPath);
  return {
    targetRef,
    targetBefore: await readRef(git.withSandbox(view), crepo, targetRef),
    worktrees: states,
    targetWorktree: holderPath,
    targetFiles,
    files: states.filter((w) => !w.bare && !w.prunable).map((w) => ({ worktree: w.path, files: filesOf(w.path) })),
  };
}

// ---------------------------------------------------------------- verification

async function changeSetMismatches(
  git: SafeGit,
  repo: RepoLayout,
  description: TransformDescription,
  worktree: string,
  changeSet: MaterializedChangeSet,
  skipWorktree: ReadonlySet<string>,
): Promise<string[]> {
  const out: string[] = [];
  const byOid = new Map<GitOid, ChangeSetEntry[]>();
  for (const e of changeSet.entries) {
    if (skipWorktree.has(e.path)) continue;
    const a = e.after;
    if (a === null) {
      if (pathState(join(worktree, e.path)).kind !== 'absent') out.push(`${e.path}: should have been removed`);
      continue;
    }
    if (a.kind === 'gitlink') continue;
    const list = byOid.get(a.oid);
    if (list === undefined) byOid.set(a.oid, [e]);
    else list.push(e);
  }
  // Each blob is compared as it arrives (bounded batches); none is kept.
  await readObjects(git, repo, [...byOid.keys()], (oid, _t, blob) => {
    for (const e of byOid.get(oid) ?? []) out.push(...compareOne(description, worktree, e, blob));
  });
  return out;
}

function compareOne(description: TransformDescription, worktree: string, e: ChangeSetEntry, blob: Buffer): string[] {
  const abs = join(worktree, e.path);
  const a = e.after as MaterializedSide;
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return [`${e.path}: missing`];
  }
  if (a.kind === 'symlink') {
    if (description.symlinks) {
      return st.isSymbolicLink() && readlinkSync(abs, { encoding: 'buffer' }).equals(blob) ? [] : [`${e.path}: symlink differs`];
    }
    return st.isFile() && readFileSync(abs).equals(blob) ? [] : [`${e.path}: differs`];
  }
  if (!st.isFile()) return [`${e.path}: not a regular file`];
  // 7.1 v34: with the bound core.filemode true, the executable bit is part of what was verified.
  if (description.fileMode && ((st.mode & 0o100) !== 0) !== (a.mode === '100755')) {
    return [`${e.path}: executable bit differs (expected ${a.mode === '100755' ? 'executable' : 'not executable'})`];
  }
  const w = toWorktree(blob, a.conversion as NonNullable<typeof a.conversion>, a.oid);
  if (w.kind === 'bytes') return readFileSync(abs).equals(w.data) ? [] : [`${e.path}: bytes differ from the materialized delivery`];
  if (w.kind === 'lfs-object') {
    const f = sha256File(abs);
    return f.size === w.pointer.size && f.sha256 === w.pointer.oid ? [] : [`${e.path}: LFS content differs`];
  }
  return [`${e.path}: cannot be verified (${w.reason})`];
}

function describeHead(s: { branch: string | null; head: string | null }): string {
  return `${s.branch ?? 'detached'}@${s.head ?? 'unborn'}`;
}

export interface VerifyOptions {
  /** The engine's SafeGit; the verification binds the view (and the locators) itself. */
  readonly git: SafeGit;
  readonly repo: RepoLayout;
  readonly view: LandingView;
  readonly description: TransformDescription;
  readonly pre: PreLandingState;
  readonly delivery: GitOid;
  readonly changeSet: MaterializedChangeSet;
  /** For HEAD versions that are neither the base's nor the delivery's (the fourth class); optional. */
  readonly attributes?: AttributeEvaluator;
}

function overallOf(verdicts: readonly WorktreeVerdict[], newWorktrees: readonly NewWorktreeReport[] = []): LandingVerification['overall'] {
  if (verdicts.some((v) => v.kind === 'cannot-determine') || newWorktrees.some((n) => n.kind === 'cannot-determine' || n.kind === 'suspected-reverse-change')) {
    return 'cannot-determine';
  }
  if (verdicts.some((v) => v.kind === 'branch-advanced-files-stale') || newWorktrees.length > 0) return 'branch-advanced-files-stale';
  if (verdicts.some((v) => v.kind === 'race-signature')) return 'race-signature';
  return 'expected';
}

function compareContext(git: SafeGit, repo: RepoLayout, o: { description: TransformDescription; changeSet: MaterializedChangeSet; attributes?: AttributeEvaluator }): CompareContext {
  return {
    git: git.withLocators({ gitDir: repo.commonDir }),
    repo,
    description: o.description,
    changeSet: o.changeSet,
    baseTree: o.changeSet.baseTree,
    attributes: o.attributes ?? (null as unknown as AttributeEvaluator),
  };
}

/**
 * 6.6 "核对" (v40: four classes), over the fixed set, inside the view: every
 * recorded worktree is compared with its pre-landing state, whatever the target
 * branch says. A worktree whose directories changed identity is left out of the
 * namespace and reported as not determinable (v36).
 */
export async function verifyLanding(o: VerifyOptions): Promise<LandingVerification> {
  const { view, pre } = o;
  const commonDir = view.commonDir;
  const crepo = commonLayout(o.repo, commonDir);
  let problems = identityProblems(view.record);
  for (let attempt = 0; attempt <= view.record.worktrees.length + 1; attempt++) {
    if (problems.some((p) => p.worktree === null)) {
      // The repository's git dir itself is not the recorded object: nothing inside it can be judged.
      return {
        overall: 'cannot-determine',
        targetBefore: pre.targetBefore,
        targetAfter: null,
        landed: false,
        worktrees: pre.worktrees.map((w) => ({ kind: 'cannot-determine', worktree: w.path, changes: [`the repository's git dir ${commonDir} was moved or replaced during landing`] })),
        leftoverLocks: [],
        newWorktrees: [],
        identityChanged: problems,
        historyUnconfirmed: false,
      };
    }
    try {
      return await verifyInside(o, crepo, view.excluding(problems.map((p) => p.worktree as string)), problems);
    } catch (e) {
      if (!(e instanceof WorktreeIdentityChanged)) throw e;
      problems = [...problems, ...e.problems.filter((p) => !problems.some((q) => q.path === p.path))];
    }
  }
  throw new Error('the recorded directories keep changing identity during the verification');
}

async function verifyInside(o: VerifyOptions, crepo: RepoLayout, vview: LandingView, problems: readonly IdentityProblem[]): Promise<LandingVerification> {
  const { pre, delivery, changeSet } = o;
  const rgit = o.git.withSandbox(vview).withLocators({ gitDir: crepo.commonDir });
  const targetAfter = await readRef(rgit, crepo, pre.targetRef);
  // v49: on the raw history (no grafts, no replace objects, no commit-graph); "unknown" is never "landed".
  const contains = targetAfter === null ? 'no' : targetAfter === delivery ? 'yes' : await ancestry(rgit, crepo, delivery, targetAfter);
  const landed = contains === 'yes';
  const ctx = compareContext(o.git.withSandbox(vview), crepo, o);
  const changedIds = new Set(problems.map((p) => p.worktree));
  const verdicts: WorktreeVerdict[] = [];
  // Zero occupancy (only the ref moves) expects every worktree's HEAD, index AND files unchanged.
  const zero = pre.targetWorktree === null;
  const filesBefore = new Map((pre.files ?? []).map((f) => [f.worktree, f.files] as const));
  const fileChangesOf = (root: string): string[] =>
    (filesBefore.get(root) ?? []).filter((f) => !samePathState(f.state, pathState(join(root, f.path)))).map((f) => `${f.path}: changed`);
  for (const before of pre.worktrees) {
    const rec = vview.record.worktrees.find((w) => w.gitDir === before.gitDir) ?? null;
    if (rec === null) {
      verdicts.push({ kind: 'cannot-determine', worktree: before.path, changes: ['not in the recorded worktree set'] });
      continue;
    }
    if (changedIds.has(rec.gitDir)) {
      verdicts.push({ kind: 'cannot-determine', worktree: before.path, changes: ['its directory was moved or replaced during landing (identity changed)'] });
      continue;
    }
    if (before.bare) {
      verdicts.push({ kind: 'expected', worktree: before.path, note: 'bare repository' });
      continue;
    }
    if (before.prunable) {
      // Review r1 #3: a directory that was missing when recorded has no recorded state: if it is back, nothing can be said about it.
      verdicts.push(
        lexists(before.path)
          ? { kind: 'cannot-determine', worktree: before.path, changes: ['its directory was missing when the worktrees were recorded and exists now: it has no recorded state to compare with'] }
          : { kind: 'expected', worktree: before.path, note: 'its directory is still missing' },
      );
      continue;
    }
    let p: { state: WorktreeState; skipWorktree: Set<string> };
    try {
      p = await recordedWorktreeState(o.git, crepo, vview, rec);
    } catch (e) {
      if (e instanceof WorktreeIdentityChanged) throw e;
      verdicts.push({ kind: 'cannot-determine', worktree: before.path, changes: [`could not be read: ${(e as Error).message}`] });
      continue;
    }
    const after = p.state;
    const changes: string[] = [];
    if (before.branch !== after.branch || before.head !== after.head) changes.push(`HEAD ${describeHead(before)} -> ${describeHead(after)}`);
    if (before.indexTree !== after.indexTree) changes.push(`index tree ${before.indexTree ?? 'unmerged'} -> ${after.indexTree ?? 'unmerged'}`);
    const fileChanges = fileChangesOf(before.path);
    const stale = async (): Promise<WorktreeVerdict | null> => {
      // v40: HEAD followed the shared ref to the delivery, the index and files stayed at the base.
      if (after.head !== delivery || after.indexTree !== changeSet.baseTree) return null;
      const c = await compareWorktreeWithDelivery(ctx, o.git.withSandbox(vview), worktreeLocators(vview.record, rec), rec.root as string);
      return c.relation === 'branch-advanced-files-stale'
        ? { kind: 'branch-advanced-files-stale', worktree: before.path, branch: after.branch, recovery: null, note: c.detail }
        : null;
    };
    if (before.path === pre.targetWorktree) {
      if (targetAfter === delivery && targetAfter !== pre.targetBefore) {
        if (after.branch === pre.targetRef && after.head === delivery && after.indexTree === changeSet.deliveryTree) {
          const mismatches = await changeSetMismatches(rgit, crepo, o.description, after.path, changeSet, p.skipWorktree);
          if (mismatches.length === 0) verdicts.push({ kind: 'expected', worktree: before.path, note: 'branch, index and files updated to the delivery commit' });
          else verdicts.push({ kind: 'cannot-determine', worktree: before.path, changes: mismatches });
        } else if (
          after.branch !== pre.targetRef &&
          after.indexTree === changeSet.deliveryTree &&
          (after.head === null || (await readRef(rgit, crepo, `${after.head}^{tree}`, 'tree')) !== changeSet.deliveryTree)
        ) {
          verdicts.push({
            kind: 'race-signature',
            worktree: before.path,
            branch: after.branch,
            recovery:
              `The worktree moved to ${after.branch ?? 'a detached HEAD'} while landing, and git updated its index and files to the delivery commit. ` +
              `To restore it: git -C ${shellQuote(before.path)} --attr-source=HEAD -c core.sparseCheckout=false -c submodule.recurse=false -c core.useReplaceRefs=false read-tree -u -m ${delivery} HEAD`,
          });
        } else {
          verdicts.push((await stale()) ?? { kind: 'cannot-determine', worktree: before.path, changes: changes.length > 0 ? changes : ['changed during landing'] });
        }
      } else if (targetAfter === pre.targetBefore) {
        const targetFileChanges = pre.targetFiles.filter((f) => !samePathState(f.state, pathState(join(before.path, f.path)))).map((f) => `${f.path}: changed`);
        if (changes.length === 0 && targetFileChanges.length === 0) {
          verdicts.push({ kind: 'expected', worktree: before.path, note: 'the target branch did not move and this worktree is unchanged' });
        } else verdicts.push({ kind: 'cannot-determine', worktree: before.path, changes: [...changes, ...targetFileChanges] });
      } else {
        verdicts.push({ kind: 'cannot-determine', worktree: before.path, changes: [`target branch ${pre.targetBefore ?? 'absent'} -> ${targetAfter ?? 'absent'}`, ...changes] });
      }
    } else if (changes.length === 0 && (!zero || fileChanges.length === 0)) {
      verdicts.push({ kind: 'expected', worktree: before.path, note: zero ? 'HEAD, index and files unchanged' : 'HEAD and index unchanged' });
    } else {
      verdicts.push((await stale()) ?? { kind: 'cannot-determine', worktree: before.path, changes: [...changes, ...(zero ? fileChanges : [])] });
    }
  }
  return {
    overall: overallOf(verdicts),
    targetBefore: pre.targetBefore,
    targetAfter,
    landed,
    worktrees: verdicts,
    leftoverLocks: leftoverLocks(crepo.commonDir, pre.targetRef),
    newWorktrees: [],
    identityChanged: problems,
    historyUnconfirmed: contains === 'unknown',
  };
}

// ---------------------------------------------------------------- worktrees outside the fixed set (v37, v38)

function isRecorded(record: WorktreeRecord, w: RegisteredWorktree): boolean {
  const root = w.bare ? null : w.path;
  const rec = record.worktrees.find((r) => r.gitDir === w.gitDir && r.root === root);
  if (rec === undefined) return false;
  if (!rec.linked) return true;
  const id = rec.identities[0];
  return id !== undefined && w.gitDirIdentity !== null && w.gitDirIdentity.dev === id.dev && w.gitDirIdentity.ino === id.ino;
}

interface ScannedWorktree {
  readonly worktree: RegisteredWorktree;
  readonly first: WorktreeComparison;
}

async function compareOutside(git: SafeGit, crepo: RepoLayout, ctxOpts: { description: TransformDescription; changeSet: MaterializedChangeSet; attributes?: AttributeEvaluator }, w: RegisteredWorktree): Promise<WorktreeComparison> {
  if (w.gitDir === null || w.prunable) {
    return { relation: 'cannot-determine', branch: w.branch, head: w.head, differing: [], detail: w.prunable ? 'its directory is missing' : 'no git dir under the common dir names it' };
  }
  try {
    const ctx = compareContext(git, crepo, ctxOpts);
    return await compareWorktreeWithDelivery(ctx, git, { gitDir: w.gitDir, commonDir: crepo.commonDir, workTree: w.path }, w.path);
  } catch (e) {
    return { relation: 'cannot-determine', branch: w.branch, head: w.head, differing: [], detail: `could not be read: ${(e as Error).message}` };
  }
}

/**
 * v37, v38: right after the push, from OUTSIDE the namespace, every worktree
 * that is not in the record, whatever branch it has, is read and classified.
 */
export async function scanNewWorktrees(
  git: SafeGit,
  repo: RepoLayout,
  record: WorktreeRecord,
  o: { description: TransformDescription; changeSet: MaterializedChangeSet; attributes?: AttributeEvaluator },
): Promise<ScannedWorktree[]> {
  const crepo = commonLayout(repo, record.commonDir.path);
  const now = await registeredWorktrees(git.withLocators({ gitDir: crepo.commonDir }), crepo.commonDir);
  const out: ScannedWorktree[] = [];
  for (const w of now) {
    if (w.bare || isRecorded(record, w)) continue;
    out.push({ worktree: w, first: await compareOutside(git, crepo, o, w) });
  }
  return out;
}

/**
 * v38, v40: right before the report, every worktree that looked "branch
 * advanced, files stale" (and every new one) is read again; the recovery
 * command is attached only when HEAD = delivery and index = files = base now.
 */
async function recheckBeforeReport(
  git: SafeGit,
  repo: RepoLayout,
  view: LandingView,
  v: LandingVerification,
  scanned: readonly ScannedWorktree[],
  o: { description: TransformDescription; changeSet: MaterializedChangeSet; attributes?: AttributeEvaluator },
): Promise<LandingVerification> {
  const crepo = commonLayout(repo, view.commonDir);
  const { base, delivery } = o.changeSet;
  const command = (root: string): string => `${staleFilesRecoveryCommand(root, base, delivery)}  # ${STALE_RECOVERY_NOTE}`;
  const verdicts: WorktreeVerdict[] = [];
  for (const x of v.worktrees) {
    if (x.kind !== 'branch-advanced-files-stale') {
      verdicts.push(x);
      continue;
    }
    const rec = view.record.worktrees.find((w) => w.root === x.worktree);
    let c: WorktreeComparison;
    if (rec === undefined || rec.root === null) c = { relation: 'cannot-determine', branch: x.branch, head: null, differing: [], detail: 'not in the recorded set' };
    else {
      try {
        // Read again from outside: a pure read of the current state, with the worktree's own locators.
        c = await compareWorktreeWithDelivery(compareContext(git, crepo, o), git, worktreeLocators(view.record, rec), rec.root);
      } catch (e) {
        c = { relation: 'cannot-determine', branch: x.branch, head: null, differing: [], detail: `could not be read again: ${(e as Error).message}` };
      }
    }
    if (c.relation === 'branch-advanced-files-stale') verdicts.push({ ...x, recovery: command(x.worktree), note: c.detail });
    else if (c.relation === 'consistent') verdicts.push({ kind: 'expected', worktree: x.worktree, note: 'consistent with its HEAD when read again before the report' });
    else verdicts.push({ kind: 'cannot-determine', worktree: x.worktree, changes: [c.detail, ...c.differing.map((p) => `${p}: differs from HEAD`)] });
  }
  // New worktrees: the scan right after the push, plus any registered since; each read again now.
  const now = await registeredWorktrees(git.withLocators({ gitDir: crepo.commonDir }), crepo.commonDir);
  const firstByPath = new Map(scanned.map((s) => [s.worktree.path, s] as const));
  const reports: NewWorktreeReport[] = [];
  const seen = new Set<string>();
  for (const w of now) {
    if (w.bare || isRecorded(view.record, w)) continue;
    seen.add(w.path);
    const c = await compareOutside(git, crepo, o, w);
    const first = firstByPath.get(w.path)?.first.relation ?? 'consistent';
    if (c.relation === 'consistent') continue;
    reports.push({
      path: w.path,
      gitDir: w.gitDir,
      branch: c.branch,
      head: c.head,
      kind: c.relation,
      firstScan: firstByPath.has(w.path) ? first : c.relation,
      differing: c.differing,
      detail: c.detail,
      recovery: c.relation === 'branch-advanced-files-stale' ? command(w.path) : null,
    });
  }
  // Scanned right after the push but gone now: reported as such.
  for (const s of scanned) {
    if (seen.has(s.worktree.path) || s.first.relation === 'consistent') continue;
    reports.push({
      path: s.worktree.path,
      gitDir: s.worktree.gitDir,
      branch: s.first.branch,
      head: s.first.head,
      kind: 'cannot-determine',
      firstScan: s.first.relation,
      differing: s.first.differing,
      detail: `${s.first.detail}; the worktree was removed before the report`,
      recovery: null,
    });
  }
  return { ...v, worktrees: verdicts, newWorktrees: reports, overall: overallOf(verdicts, reports) };
}

// ---------------------------------------------------------------- push

export function parsePushPorcelain(r: GitResult): PushOutcome {
  const stderr = r.stderr.toString('utf8');
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const m = /^([ +\-*=!])\t[^\t]*\t(.*)$/.exec(line);
    if (m === null) continue;
    const flag = m[1] as string;
    const summary = m[2] as string;
    if (flag === '=') return { kind: 'up-to-date' };
    if (flag !== '!') return { kind: 'updated', summary };
    let reason: PushRejection = 'other';
    if (summary.includes('stale info')) reason = 'stale-lease';
    else if (summary.includes('push-to-checkout hook declined')) reason = 'checkout-hook-declined';
    else if (summary.includes('branch is currently checked out')) reason = 'checked-out';
    else if (/unstaged changes|staged changes/i.test(summary)) reason = 'worktree-has-changes';
    else if (summary.includes('Could not update working tree')) reason = 'worktree-update-failed';
    return { kind: 'rejected', reason, summary, stderr };
  }
  return { kind: 'error', code: r.code, stderr };
}

// ---------------------------------------------------------------- the landing command

export interface LandingRequest {
  readonly key: LandingKey;
  /** Any directory of the repository (a worktree, a subdirectory of one, or the git dir). */
  readonly repoPath: string;
  /** Branch name, e.g. "main". */
  readonly targetBranch: string;
  /** The lease: the target branch's commit the delivery was built on. */
  readonly base: GitOid;
  /** The delivery commit B (refs/mission-pipeline/delivered/<mission>/<op> points to it). */
  readonly delivery: GitOid;
  /** The transform description the delivery is bound to. */
  readonly description: TransformDescription;
  /** The user's git environment, to read the ACTUAL description at landing time. */
  readonly user: UserGitEnvironment;
  readonly ledger: {
    readonly reserve: LedgerReserve;
    /** True when a destination is on the volume that holds the ledger (found at install time, 6.6). */
    readonly sharesVolume: (fs: FsStats) => boolean;
  };
  /**
   * v41: the main checkout registered at install time (its root), the only
   * worktree landed into by default. Undefined: the repository's main worktree;
   * null: none registered (a bare repository with no main checkout).
   */
  readonly mainCheckout?: string | null;
  /**
   * WI-02 option 2: the PM allows this one landing into the single external
   * worktree (its root) that holds the target branch. Never applies to many or
   * in-operation (v42: there is no "designate one of many").
   */
  readonly allowExternal?: string | null;
}

export interface LandingDeps {
  readonly git: SafeGit;
  readonly journal: LandingJournal;
  /** Program scratch space outside the repository: the view, the attribute evaluator, the temp index. */
  readonly scratchDir: string;
  readonly bwrapPath?: string;
  readonly fsProbe?: FsProbe;
  /** Injected platform (tests); default: detectLandingPlatform(). */
  readonly platform?: LandingPlatform;
  readonly pushTimeoutMs?: number;
  /** How long recovery waits for a stray push process to disappear after SIGKILL. */
  readonly exitWaitMs?: number;
  /** Tests only: called once the view exists, before anything is decided from it. */
  readonly onViewBuilt?: (view: LandingView) => void | Promise<void>;
  /** Tests only: a barrier in the generated push-to-checkout hook (6.6 v47 test plan). */
  readonly checkoutBarrier?: CheckoutHookOptions['barrier'];
  /** Tests only: called with the push plan right before the push starts. */
  readonly onPushPlan?: (plan: PushPlan) => void | Promise<void>;
}

/** Commands the PM gives the user when the program does not land automatically. */
export function manualLandingCommands(worktree: string, ref: ProgramRefName, renormalize: readonly string[] = [], submodules: readonly string[] = []): string[] {
  const w = shellQuote(worktree);
  const cmds = [`git -C ${w} merge --ff-only ${ref}`];
  if (renormalize.length > 0) {
    cmds.push(`git -C ${w} checkout-index -f -- ${renormalize.map(shellQuote).join(' ')}`);
  }
  // v46: the landing never enters a submodule; after the merge the user (or an agent) updates them.
  if (submodules.length > 0) cmds.push(`git -C ${w} submodule update --init -- ${submodules.map(shellQuote).join(' ')}`);
  return cmds;
}

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function occupantsOfRecord(record: WorktreeRecord): OccupantView[] {
  return record.worktrees.map((w) => ({ root: w.root, gitDir: w.gitDir, occupancy: w.occupancy, prunable: w.prunable }));
}

/** The registered main checkout: the request's, or the repository's main worktree. */
function mainCheckoutOf(req: LandingRequest, record: WorktreeRecord): string | null {
  if (req.mainCheckout !== undefined) return req.mainCheckout;
  return record.worktrees[0]?.root ?? null;
}

/**
 * v36, v40, v41: right before the push phase, OUTSIDE the namespace: the
 * worktree set, the recorded directories' identities and the target's
 * occupancy must all still be as recorded.
 */
async function prePushCheck(
  git: SafeGit,
  view: LandingView,
  req: LandingRequest,
  targetRef: string,
  decided: Extract<OccupancyDecision, { ok: true }>,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: NotAutoLandedReason; readonly detail: string; readonly paths: readonly string[] }> {
  const record = view.record;
  const commonDir = view.commonDir;
  const now = await registeredWorktrees(git.withLocators({ gitDir: commonDir }), commonDir);
  const key = (gitDir: string | null, root: string | null): string => `${gitDir ?? '?'}\0${root ?? ''}`;
  const want = new Set(record.worktrees.map((w) => key(w.gitDir, w.root)));
  const have = new Set(now.map((w) => key(w.gitDir, w.bare ? null : w.path)));
  const added = now.filter((w) => !want.has(key(w.gitDir, w.bare ? null : w.path))).map((w) => w.path);
  const removed = record.worktrees.filter((w) => !have.has(key(w.gitDir, w.root))).map((w) => w.root ?? w.gitDir);
  if (added.length > 0 || removed.length > 0) {
    return {
      ok: false,
      reason: 'worktrees-changed',
      detail: `the worktrees changed since they were recorded${added.length > 0 ? `; added: ${added.join(', ')}` : ''}${removed.length > 0 ? `; removed: ${removed.join(', ')}` : ''}`,
      paths: [...added, ...removed],
    };
  }
  // Review r1 #3: a directory missing when recorded must still be missing (and the others still there):
  // a root that reappeared has no recorded identity, no binding and no admission.
  const presence = record.worktrees
    .filter((w) => w.root !== null)
    .filter((w) => {
      const nowListed = now.find((x) => x.gitDir === w.gitDir && x.path === w.root);
      const present = lexists(w.root as string);
      return w.prunable === present || (nowListed !== undefined && nowListed.prunable !== w.prunable);
    })
    .map((w) => w.root as string);
  if (presence.length > 0) {
    return {
      ok: false,
      reason: 'worktrees-changed',
      detail: `a worktree directory appeared or disappeared since the worktrees were recorded: ${presence.join(', ')}`,
      paths: presence,
    };
  }
  const problems = identityProblems(record);
  if (problems.length > 0) {
    return { ok: false, reason: 'worktree-identity-changed', detail: `recorded directories are no longer the recorded objects: ${problems.map((p) => `${p.path} (${p.problem})`).join(', ')}`, paths: problems.map((p) => p.path) };
  }
  // v42: the occupancy class and location must be the recorded ones; otherwise this attempt ends (class A)
  // and the next check classifies again.
  const occupants: OccupantView[] = now.map((w) => ({ root: w.bare ? null : w.path, gitDir: w.gitDir ?? '', occupancy: w.occupancy, prunable: w.prunable }));
  const again = decideOccupancy(occupants, targetRef, mainCheckoutOf(req, record), req.allowExternal ?? null);
  const nowClass = again.class;
  const nowHolder = again.ok ? again.holder : null;
  if (!again.ok || nowClass !== decided.class || nowHolder !== decided.holder) {
    return {
      ok: false,
      reason: 'occupancy-changed',
      detail: `${targetRef} is no longer held as recorded: recorded ${decided.class} (${decided.holder ?? 'nobody'}), now ${nowClass}${again.ok ? ` (${nowHolder ?? 'nobody'})` : `: ${again.detail}`}`,
      paths: again.ok ? [decided.holder, nowHolder].filter((x): x is string => x !== null) : again.worktrees,
    };
  }
  // WI-05: the target branch must still be at the base the delivery was built on.
  const tip = await git.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${targetRef}^{commit}`], { cwd: commonDir, locators: { gitDir: commonDir } });
  const tipNow = tip.code === 0 ? tip.stdout.toString('utf8').trim() : null;
  if (tipNow !== req.base) {
    return { ok: false, reason: 'base-moved', detail: `${targetRef} moved from the base ${req.base} to ${tipNow ?? 'nothing'} before the push`, paths: [] };
  }
  return { ok: true };
}

/**
 * The PM's notices for a landing past the push stage (3.11): WI-04 for worktrees
 * that are not as expected (whatever the class, also when it landed: review r1
 * #14), WI-06 for B and C, WI-05 for "base moved", and for a leftover lock the
 * lock's location and what its owner should do (the program never deletes it).
 */
function resultNotices(push: PushOutcome | 'unknown', v: LandingVerification, r: Pick<ResultClass, 'outcome' | 'next' | 'why'>, locks: readonly string[]): LandingNotice[] {
  const out: LandingNotice[] = [];
  const pushText = push === 'unknown' ? 'unknown (timed out or killed)' : push.kind === 'rejected' ? `refused: ${push.summary}` : push.kind === 'not-run' ? `not started: ${push.reason}` : push.kind;
  const inconsistent = v.worktrees.filter((w) => w.kind !== 'expected');
  if (inconsistent.length > 0 || v.newWorktrees.length > 0 || v.identityChanged.length > 0) {
    out.push({
      wi: 'WI-04',
      category: 'landing-inconsistent',
      trigger: `after the push stage, worktrees are not consistent with the delivery (${v.overall}; ${v.landed ? 'landed' : 'not landed'})`,
      facts: { worktrees: inconsistent, newWorktrees: v.newWorktrees, identityChanged: v.identityChanged, leftoverLocks: v.leftoverLocks, landed: v.landed },
      defaultAction: 'those worktrees are left untouched and shown on layer 0 until handled; recovery commands are given only where the state predicate held when read again',
    });
  }
  const facts = { class: r.outcome, push, targetBefore: v.targetBefore, targetAfter: v.targetAfter, why: r.why };
  if (r.outcome === 'B') {
    out.push({
      wi: 'WI-06',
      category: 'landing-not-completed',
      trigger: `class B: the push was ${pushText}; the check confirms it is safe to retry (${r.why})`,
      facts,
      defaultAction:
        'the delivery ref is kept; a NEW landing attempt (re-authorized, new view, new admission) starts after the worktree or the target branch changes; ' +
        `at most ${LANDING_ATTEMPT_CAP} attempts that enter the push stage per delivery, then WI-08`,
    });
  } else if (r.outcome === 'base-moved') {
    out.push({
      wi: 'WI-05',
      category: 'delivery-base-moved',
      trigger: `the push was ${pushText}: ${r.why}; the check confirms it is safe to retry`,
      facts,
      defaultAction: 'the delivery is rebuilt on the new base once the target branch is quiet (WI-05, every rebuild counts); the same commit is never pushed again',
    });
  } else if (r.outcome === 'C') {
    if (locks.length > 0) {
      out.push({
        wi: 'WI-06',
        category: 'landing-leftover-lock',
        trigger: `class C: a git lock was left after the push process exited: ${locks.join(', ')}`,
        facts: { ...facts, locks },
        defaultAction:
          'the program and the PM never delete a git lock (a lock no process holds open may still be in use). Tell its owner (the user or that agent) where it is and that a git command was interrupted there; ' +
          (r.next === 'after-lock' ? 'once it is gone, a new attempt starts by itself (counted).' : 'the worktree also changed, so no attempt starts by itself; the PM handles it first.'),
      });
    }
    if (locks.length === 0 || r.next !== 'after-lock') {
      out.push({
        wi: 'WI-06',
        category: 'landing-not-completed',
        trigger: `class C: the push was ${pushText}; ${r.why}; the target branch was not advanced`,
        facts,
        defaultAction: 'never redone automatically; the delivery ref is kept; after the PM has handled the reported worktrees, a new landing attempt can be started from the CLI (counted)',
      });
    }
  }
  return out;
}

/**
 * v49: a shallow repository or a partial clone (extensions.partialClone, a
 * promisor remote, or promisor packs) is never landed into automatically. Pure
 * reads, outside any namespace.
 */
export async function historyKind(git: SafeGit, commonDir: string): Promise<{ readonly shallow: boolean; readonly partial: string | null; readonly refStorage: string; readonly unknownExtensions: readonly string[] }> {
  const g = git.withLocators({ gitDir: commonDir });
  // v50: only objectFormat and worktreeConfig are known; partialClone is handled below; refStorage must be files.
  const ex = await g.run(['config', '--get-regexp', '^extensions\\.'], { cwd: commonDir });
  let refStorage = 'files';
  const unknownExtensions: string[] = [];
  for (const line of ex.stdout.toString('utf8').split('\n')) {
    if (line === '') continue;
    const sp = line.indexOf(' ');
    const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'extensions.refstorage') refStorage = value.toLowerCase();
    else if (key !== 'extensions.objectformat' && key !== 'extensions.worktreeconfig' && key !== 'extensions.partialclone') unknownExtensions.push(`${key}=${value}`);
  }
  const sh = await g.run(['rev-parse', '--is-shallow-repository'], { cwd: commonDir });
  const shallow = sh.code !== 0 || sh.stdout.toString('utf8').trim() !== 'false';
  const reasons: string[] = [];
  const pc = await g.run(['config', '--get', 'extensions.partialClone'], { cwd: commonDir });
  if (pc.code === 0) reasons.push(`extensions.partialClone=${pc.stdout.toString('utf8').trim()}`);
  const pr = await g.run(['config', '--type=bool', '--get-regexp', '^remote\\..*\\.promisor$'], { cwd: commonDir });
  for (const line of pr.stdout.toString('utf8').split('\n')) {
    const sp = line.lastIndexOf(' ');
    if (sp > 0 && line.slice(sp + 1) === 'true') reasons.push(`${line.slice(0, sp)}=true`);
  }
  try {
    if (readdirSync(join(commonDir, 'objects', 'pack')).some((f) => f.endsWith('.promisor'))) reasons.push('promisor packs in objects/pack');
  } catch {
    /* no pack directory */
  }
  return { shallow, partial: reasons.length > 0 ? reasons.join(', ') : null, refStorage, unknownExtensions };
}

/** v49: the Git LFS objects a checkout of the change set reads (checked at admission and again by the hook). */
export function lfsObjectsNeeded(changeSet: MaterializedChangeSet): { oid: string; size: number }[] {
  const out = new Map<string, number>();
  for (const e of changeSet.entries) if (e.after?.lfs != null) out.set(e.after.lfs.oid, e.after.lfs.size);
  return [...out].map(([oid, size]) => ({ oid, size }));
}

/** The gitlink paths of a change set (v46: a landing never enters a submodule). */
export function gitlinkChanges(changeSet: MaterializedChangeSet): string[] {
  return changeSet.entries.filter((e) => e.before?.kind === 'gitlink' || e.after?.kind === 'gitlink').map((e) => e.path);
}

export async function land(req: LandingRequest, deps: LandingDeps): Promise<LandingReport> {
  const { git, journal } = deps;
  const key = req.key;
  const ref = deliveryRef(req.key.mission, req.key.op);
  const targetRef = `refs/heads/${req.targetBranch}`;
  let manualWorktree = req.repoPath;
  const refuse = async (
    reason: NotAutoLandedReason,
    detail: string,
    paths: readonly string[] = [],
    renormalize: readonly string[] = [],
    facts: Record<string, unknown> = {},
    submodules: readonly string[] = [],
  ): Promise<LandingReport> => {
    const w = REFUSAL_WORK_INSTRUCTIONS[reason];
    const report: LandingReport = { kind: 'not-auto-landed', reason, wi: w.wi, detail, paths, manualCommands: manualLandingCommands(manualWorktree, ref, renormalize, submodules) };
    await journal.notify(key, { wi: w.wi, category: w.category, trigger: detail, facts: { reason, paths, deliveryRef: ref, delivery: req.delivery, ...facts }, defaultAction: w.defaultAction });
    await journal.complete(key, report);
    return report;
  };

  const platform = deps.platform ?? (await detectLandingPlatform(deps.bwrapPath));
  if (!platform.supported) return refuse('platform', platform.reason ?? 'unsupported platform');

  await journal.beginPhase(key, { phase: 'authorize' });
  const auth = await journal.authorize(key);
  if (!auth.ok) return refuse('authorization-refused', auth.reason);

  await journal.beginPhase(key, { phase: 'admit' });
  // Locating the repository is the one discovery a landing makes, outside any namespace (a pure read):
  // from here on, every command names the recorded common dir or a recorded worktree (6.6 v37, v38).
  const repo = await discoverRepo(git, req.repoPath);
  manualWorktree = repo.worktree ?? repo.commonDir;
  // v49, v50: repositories a landing never lands into (pure reads, outside any namespace).
  const history = await historyKind(git, repo.commonDir);
  if (history.refStorage !== 'files') return refuse('reftable', `${repo.commonDir} uses the ${history.refStorage} ref backend`);
  if (history.unknownExtensions.length > 0) return refuse('unsupported-extension', `${repo.commonDir} uses repository extensions the program does not support: ${history.unknownExtensions.join(', ')}`);
  if (history.shallow) return refuse('shallow-repository', `${repo.commonDir} is a shallow repository`);
  if (history.partial !== null) return refuse('partial-clone', `${repo.commonDir} is a partial clone (${history.partial})`);

  const scratch = mkdtempSync(join(deps.scratchDir, 'mp-land-'));
  let view: LandingView | null = null;
  let attributes: AttributeEvaluator | null = null;
  // Set while a push process may still be using the view (the engine "crashed" or the push timed out).
  const inFlight: { push: Promise<unknown> | null } = { push: null };
  try {
    view = await LandingView.build({
      git,
      repo,
      description: req.description,
      scratchDir: scratch,
      ...(deps.bwrapPath !== undefined ? { bwrapPath: deps.bwrapPath } : {}),
    });
    if (deps.onViewBuilt !== undefined) await deps.onViewBuilt(view);
    const record = view.record;
    const commonDir = view.commonDir;
    const crepo = commonLayout(repo, commonDir);
    // Repository-level commands: in the view, naming only the common dir (the sending side's locators, v38).
    const rgit = git.withSandbox(view).withLocators({ gitDir: commonDir });
    const valid = await rgit.run(['check-ref-format', targetRef], { cwd: commonDir });
    if (valid.code !== 0) return await refuse('invalid-target', `${req.targetBranch} is not a valid branch name`);
    const refState = await classifyProgramRef(rgit, crepo, ref, req.delivery);
    if (refState.kind !== 'done') return await refuse('delivery-ref-mismatch', `${ref} does not point to ${req.delivery} (${refState.kind})`);
    // 6.6 "落地的结果" 1 and step 8: whether the delivery has landed is decided FIRST, by the target branch containing the
    // delivery commit on the raw history (v49): an already landed delivery is reported as landed, never as "base moved".
    const tip0 = await readRef(rgit, crepo, targetRef);
    if (tip0 !== null && (tip0 === req.delivery || (await ancestry(rgit, crepo, req.delivery, tip0)) === 'yes')) {
      const report: LandingReport = {
        kind: 'checked',
        push: { kind: 'not-run', reason: 'the target branch already contains the delivery commit' },
        verification: {
          overall: 'expected',
          targetBefore: tip0,
          targetAfter: tip0,
          landed: true,
          worktrees: [],
          leftoverLocks: [],
          newWorktrees: [],
          identityChanged: [],
          historyUnconfirmed: false,
        },
        outcome: 'landed',
        next: null,
        why: `${targetRef} already contains the delivery commit ${req.delivery} (at ${tip0}): nothing was pushed`,
        binding: null,
        approvedAfter: null,
        locks: [],
        reminders: [],
        admission: null,
        recovered: false,
      };
      await journal.complete(key, report);
      return report;
    }
    const built = await ancestry(rgit, crepo, req.base, req.delivery);
    if (built === 'unknown') return await refuse('history-unconfirmed', `whether the delivery ${req.delivery} is built on ${req.base} cannot be confirmed from the local history`);
    if (built === 'no') return await refuse('not-descendant', `the delivery commit is not built on ${req.base}; the push would drop commits`);
    // WI-05: a target that moved since the candidate was built is a rebuild, not a push that is bound to fail.
    const tip = await readRef(rgit, crepo, targetRef);
    if (tip !== req.base) return await refuse('base-moved', `${targetRef} is at ${tip ?? 'nothing'}, not at the base ${req.base} the delivery was built on`);

    // v40-v42: who holds the target branch, from the recorded HEADs and in-progress operations.
    const decided = decideOccupancy(occupantsOfRecord(record), targetRef, mainCheckoutOf(req, record), req.allowExternal ?? null);
    if (!decided.ok) {
      return await refuse(decided.reason, decided.detail, decided.worktrees, [], {
        class: decided.class,
        occupancy: record.worktrees.map((w) => ({ worktree: w.root ?? w.gitDir, prunable: w.prunable, ...w.occupancy })),
      });
    }
    const holder = record.worktrees.find((w) => w.gitDir === decided.holder) ?? null;
    if (decided.class === 'one' && (holder === null || holder.root === null || holder.prunable)) {
      return await refuse('worktree-root-missing', `the worktree holding ${targetRef} has no directory`, [decided.holder ?? '']);
    }
    if (holder?.root != null) manualWorktree = holder.root;
    const holderRoot = holder !== null && holder.root !== null ? holder.root : null;
    // v43-v47: the receiving side per occupancy class.
    const binding: PushBinding = holder === null ? { kind: 'zero' } : holder.linked ? { kind: 'linked', gitDir: holder.gitDir } : { kind: 'main' };

    // The ACTUAL transform settings must be read from the user's real configuration, which the view hides
    // on purpose: pure reads (`git config --get-regexp`, `git var`), outside the view, naming the repository.
    const actual = await readTransformDescription(git, crepo, req.user, undefined, holder !== null && holderRoot !== null ? worktreeLocators(record, holder) : { gitDir: commonDir });
    if (transformDescriptionHash(actual) !== transformDescriptionHash(req.description)) {
      return await refuse(
        'transform-description-changed',
        `the transform settings changed since the delivery was verified: ${transformDescriptionDifferences(req.description, actual).join('; ')}. ` +
          'Rebuild and re-verify under the new settings, or merge by hand.',
      );
    }

    attributes = await AttributeEvaluator.create(git.withSandbox(view), crepo, req.description, scratch);
    const changeSet = await computeMaterializedChangeSet({ git: rgit, repo: crepo, base: req.base, delivery: req.delivery, attributes });
    if (changeSet.unsafe.length > 0) {
      return await refuse('unsafe-path', changeSet.unsafe.map((u) => `${u.path}: ${u.reason}`).join('; '), changeSet.unsafe.map((u) => u.path));
    }
    // v46: a landing never enters a submodule; a gitlink change is merged by hand.
    const gitlinks = gitlinkChanges(changeSet);
    if (gitlinks.length > 0) {
      return await refuse(
        'submodule-change',
        `the delivery changes ${gitlinks.length} submodule entr${gitlinks.length === 1 ? 'y' : 'ies'} (added, removed, re-pointed or changed type); a landing never enters a submodule`,
        gitlinks,
        [],
        {},
        gitlinks,
      );
    }
    if (changeSet.unsupported.length > 0) {
      return await refuse(
        'unsupported-transform',
        `paths in the delivery use transforms outside the whitelist: ${[...new Set(changeSet.unsupported.map((u) => u.reason))].join('; ')}`,
        changeSet.unsupported.map((u) => u.path),
      );
    }
    if (changeSet.attributeOnly.length > 0) {
      return await refuse(
        'attribute-only-change',
        'the delivery changes attributes so that files whose content did not change materialize differently; git does not rewrite them. ' +
          'After merging, re-materialize them (for example `git add --renormalize .`, then check these paths out again).',
        changeSet.attributeOnly,
        changeSet.attributeOnly,
      );
    }
    if (changeSet.lfsMissing.length > 0) {
      // 7.1 v34: the program never downloads LFS objects (no network, no credentials); git-lfs would.
      return await refuse(
        'lfs-object-missing',
        `${changeSet.lfsMissing.length} Git LFS object(s) the delivery needs are not available locally; run \`git lfs fetch\` first`,
        changeSet.lfsPaths,
      );
    }

    // Disk admission per write destination (6.6).
    const fsProbe = deps.fsProbe ?? probeFs;
    let worktreeDemand = null;
    let measured: number | null = null;
    if (holder !== null && holderRoot !== null) {
      const writes: { size: number; isNew: boolean }[] = [];
      const seenDirs = new Set<string>();
      let newDirectories = 0;
      for (const e of changeSet.entries) {
        if (e.after === null || e.after.kind === 'gitlink') continue;
        writes.push({ size: e.after.size ?? 0, isNew: !lexists(join(holderRoot, e.path)) });
        for (let dir = parentDir(e.path); dir !== ''; dir = parentDir(dir)) {
          if (seenDirs.has(dir)) break;
          seenDirs.add(dir);
          if (!lexists(join(holderRoot, dir))) newDirectories++;
        }
      }
      const fs = fsProbe(holderRoot);
      worktreeDemand = { fs, sharesLedgerVolume: req.ledger.sharesVolume(fs), files: writes, newDirectories };
      // The new index: read-tree into a temporary index inside the view, with the holder's own locators
      // (no worktree update, no filter, no hook).
      const idxDir = mkdtempSync(join(scratch, 'idx-'));
      const idx = join(idxDir, 'index');
      await git.withSandbox(view).ok(['read-tree', req.delivery], {
        cwd: holderRoot,
        locators: worktreeLocators(record, holder),
        env: { GIT_INDEX_FILE: idx },
        config: [['core.splitIndex', 'false']],
      });
      measured = statSync(idx).size;
    }
    const repoFs = fsProbe(commonDir);
    const decision = admit(
      landingDemands({
        worktree: worktreeDemand,
        repository: {
          fs: repoFs,
          sharesLedgerVolume: req.ledger.sharesVolume(repoFs),
          measuredIndexBytes: measured,
          updatedRefs: 1,
          updatedWorktreeHeads: holderRoot !== null ? 1 : 0,
          newMountPoints: view.newMountPoints,
        },
      }),
      req.ledger.reserve,
    );
    if (!decision.ok) {
      // WI-06 class A, and the WI-10 space reminder with it (3.11).
      await journal.remind(key, `not enough space to land: ${decision.reasons.join('; ')}`);
      return await refuse('insufficient-space', decision.reasons.join('; '));
    }
    // Admitted, but close to the margin: remind the PM before landing; the landing goes ahead (6.6 空间提醒).
    for (const m of decision.reminders) await journal.remind(key, m);

    await journal.beginPhase(key, { phase: 'record-pre-state' });
    const pre0 = await recordPreLandingState(git, crepo, view, targetRef, changeSet, holderRoot);
    // v44-v47: the approved worktree as "可以安全重试" needs it, read in the view through a copy of its index.
    let approved: ApprovedState | null = null;
    if (holder !== null) {
      approved = await readApprovedState({ git, view, worktree: holder, changeSet, scratchDir: scratch });
      if (approved.unsupportedLfs === true) {
        return await refuse('unsupported-transform', `a Git LFS pointer with extension lines in ${holderRoot ?? holder.gitDir}: not supported (v49)`, [holderRoot ?? holder.gitDir]);
      }
      if (approved.unreadable !== null) return await refuse('worktree-unreadable', approved.unreadable, [holderRoot ?? holder.gitDir]);
      if (approved.sparseCheckout || approved.skipWorktree > 0) {
        return await refuse(
          'sparse-checkout',
          `${holderRoot ?? holder.gitDir} has ${approved.sparseCheckout ? 'sparse checkout enabled' : ''}${approved.sparseCheckout && approved.skipWorktree > 0 ? ' and ' : ''}${approved.skipWorktree > 0 ? `${approved.skipWorktree} skip-worktree entr${approved.skipWorktree === 1 ? 'y' : 'ies'}` : ''}`,
          [holderRoot ?? holder.gitDir],
        );
      }
    }
    const pre: PreLandingState = { ...pre0, binding: holder === null ? 'zero' : 'one', approved };
    // v46-v49: the receiving side updates the approved worktree only through this landing's own hook.
    if (holder !== null) {
      view.installCheckoutHook({
        base: req.base,
        delivery: req.delivery,
        approvedGitDir: holder.gitDir,
        lfsObjects: lfsObjectsNeeded(changeSet),
        ...(deps.checkoutBarrier !== undefined ? { barrier: deps.checkoutBarrier } : {}),
      });
    }

    // v36, v40-v42: the last look before the push, outside the namespace.
    const check = await prePushCheck(git, view, req, targetRef, decided);
    if (!check.ok) return await refuse(check.reason, check.detail, check.paths);

    // 6.5: the attempt counts as it enters the push stage; an exhausted count means nothing is pushed (WI-08).
    const entry = await journal.enterPushStage(key, view.token);
    if (!entry.ok) return await refuse('attempts-exhausted', entry.reason);

    await journal.beginPhase(key, { phase: 'push', pre, token: view.token, record });
    const plan = view.pushPlan(binding, { deliveryRef: ref, targetRef, base: req.base });
    if (deps.onPushPlan !== undefined) await deps.onPushPlan(plan);
    const push = await runPush(git, plan, deps, key, (p) => {
      inFlight.push = p;
    });
    if (push.kind === 'unconfirmed') {
      return { kind: 'push-unconfirmed', detail: 'the push timed out and its process has not exited yet; recovery will verify', processes: push.processes };
    }

    await journal.beginPhase(key, { phase: 'verify', push: push.outcome });
    const report = await checkAfterPush({ git, repo: crepo, view, req, pre, changeSet, attributes, push: push.outcome, recovered: false, admission: decision, scratchDir: scratch });
    for (const n of resultNotices(push.outcome, report.verification, report, report.locks)) await journal.notify(key, n);
    await journal.complete(key, report);
    return report;
  } finally {
    const v = view as LandingView | null;
    const a = attributes as AttributeEvaluator | null;
    const cleanup = (): void => {
      v?.dispose();
      a?.dispose();
      rmSync(scratch, { recursive: true, force: true });
    };
    // Never pull the view out from under a push that may still be running.
    if (inFlight.push !== null) void inFlight.push.then(cleanup, cleanup);
    else cleanup();
  }
}

type CheckedReport = Extract<LandingReport, { kind: 'checked' }>;

/**
 * After the push process is gone (6.6 "落地的结果"): the scan of new worktrees,
 * the per-worktree verification and its re-check (for the report and WI-04),
 * then the result in the fixed order (landingResult.ts).
 */
async function checkAfterPush(o: {
  readonly git: SafeGit;
  readonly repo: RepoLayout;
  readonly view: LandingView;
  readonly req: LandingRequest;
  readonly pre: PreLandingState;
  readonly changeSet: MaterializedChangeSet;
  readonly attributes: AttributeEvaluator;
  readonly push: PushOutcome | 'unknown';
  readonly recovered: boolean;
  readonly admission: AdmissionDecision | null;
  readonly scratchDir: string;
}): Promise<CheckedReport> {
  const { git, repo, view, req, pre, changeSet } = o;
  // After the push, attribute queries (for HEAD versions other than the base's or the delivery's) run on the
  // program's scratch repository outside the view, so they do not depend on the user's directories.
  const ctxOpts = { description: req.description, changeSet, attributes: o.attributes.withGit(git) };
  // v37, v38: right after the push, the worktrees outside the fixed set, whatever branch they have.
  const scanned = await scanNewWorktrees(git, repo, view.record, ctxOpts);
  const inside = await verifyLanding({ git, repo, view, description: req.description, pre, delivery: req.delivery, changeSet, attributes: o.attributes });
  const verification = await recheckBeforeReport(git, repo, view, inside, scanned, ctxOpts);
  const binding: 'zero' | 'one' = pre.binding ?? (pre.targetWorktree === null ? 'zero' : 'one');
  const approvedRec = pre.approved != null ? (view.record.worktrees.find((w) => w.gitDir === (pre.approved as ApprovedState).gitDir) ?? null) : null;
  let approvedAfter: ApprovedState | null = null;
  if (binding === 'one' && approvedRec !== null) {
    const problems = identityProblems(view.record);
    approvedAfter = problems.some((p) => p.worktree === null || p.worktree === approvedRec.gitDir)
      ? null
      : await readApprovedState({ git, view: view.excluding(problems.map((p) => p.worktree as string)), worktree: approvedRec, changeSet, scratchDir: o.scratchDir });
  }
  // Review r2 #5: the approved worktree is judged as a whole: "expected" also needs every tracked file to match its index.
  let verified = verification;
  // (The hook refuses a dirty worktree, so after a landing every modified tracked file is news; before one, a dirty
  // worktree that stayed as it was is "expected".)
  if (verification.landed && approvedAfter !== null && approvedAfter.unreadable === null && approvedAfter.dirty.length > 0) {
    const w = approvedAfter.worktree;
    verified = {
      ...verification,
      overall: 'cannot-determine',
      worktrees: verification.worktrees.map((v) =>
        v.worktree === w && v.kind === 'expected' ? { kind: 'cannot-determine', worktree: w, changes: approvedAfter.dirty.map((p) => `${p}: differs from the index`) } : v,
      ),
    };
  }
  const locks = landingLocks(view.commonDir, pre.targetRef, binding === 'one' ? (pre.approved?.gitDir ?? null) : null);
  const r = classifyLandingOutcome({
    targetAfter: verification.targetAfter,
    landed: verification.landed,
    historyUnconfirmed: verification.historyUnconfirmed,
    base: req.base,
    delivery: req.delivery,
    binding,
    approvedBefore: pre.approved ?? null,
    approvedAfter,
    locks,
  });
  return {
    kind: 'checked',
    push: o.push,
    verification: verified,
    outcome: r.outcome,
    next: r.next,
    why: r.why,
    binding,
    approvedAfter,
    locks,
    reminders: o.admission?.reminders ?? [],
    admission: o.admission,
    recovered: o.recovered,
  };
}

async function runPush(
  git: SafeGit,
  plan: PushPlan,
  deps: LandingDeps,
  key: LandingKey,
  track: (inFlight: Promise<unknown> | null) => void,
): Promise<{ kind: 'done'; outcome: PushOutcome | 'unknown' } | { kind: 'unconfirmed'; processes: ProcessIdentity[] }> {
  const commonDir = plan.view.commonDir;
  let onSpawned: (p: ProcessIdentity) => void = () => {};
  const spawned = new Promise<ProcessIdentity>((r) => {
    onSpawned = r;
  });
  // v38, v39, v47: the sending side names the common dir (GIT_DIR) and pushes to its absolute path; the
  // receiving side gets no locator at all; both command lines come from the one generator (pushPlan).
  const pushing = git.run(plan.senderArgs, {
    cwd: commonDir,
    sandbox: plan.view,
    locators: { gitDir: commonDir },
    config: [['mission-pipeline.landing', plan.view.token]],
    timeoutMs: deps.pushTimeoutMs ?? 10 * 60_000,
    onSpawn: (p) => onSpawned(p),
  });
  pushing.catch(() => {
    /* observed below */
  });
  // Until the push process has exited, the view it runs in must stay.
  track(
    pushing.then(
      () => undefined,
      async (e: unknown) => {
        if (e instanceof GitTimeoutError) await e.exited;
      },
    ),
  );
  const first = await Promise.race([spawned.then((p) => ({ spawned: p })), pushing.then(() => null, () => null)]);
  if (first !== null) await deps.journal.recordPushProcess(key, first.spawned);
  try {
    const outcome = parsePushPorcelain(await pushing);
    track(null);
    return { kind: 'done', outcome };
  } catch (e) {
    if (e instanceof GitTimeoutError) {
      if (!e.exitedInGrace) return { kind: 'unconfirmed', processes: e.process === null ? [] : [e.process] };
      track(null);
      return { kind: 'done', outcome: 'unknown' };
    }
    track(null);
    // v36: a recorded directory changed identity when the push was about to start: nothing was started.
    if (e instanceof WorktreeIdentityChanged) return { kind: 'done', outcome: { kind: 'not-run', reason: e.message } };
    throw e;
  }
}

// ---------------------------------------------------------------- recovery

export type RecoveryResult =
  | { readonly kind: 'nothing-recorded' }
  | { readonly kind: 'already-complete'; readonly report: LandingReport }
  /** Crashed before the push phase: nothing outside the ledger happened. Landing again re-authorizes. */
  | { readonly kind: 'not-started'; readonly lastPhase: LandingPhase }
  | { readonly kind: 'checked'; readonly report: LandingReport }
  | { readonly kind: 'push-unconfirmed'; readonly processes: readonly ProcessIdentity[] };

async function waitGone(procs: readonly ProcessIdentity[], ms: number): Promise<ProcessIdentity[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const alive = procs.filter((p) => isProcessAlive(p));
    if (alive.length === 0 || Date.now() >= deadline) return alive;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The repository as the persisted record names it: recovery never discovers it again (review r1 #10). */
export function layoutFromRecord(record: WorktreeRecord): RepoLayout {
  const commonDir = record.commonDir.path;
  return { worktree: null, gitDir: commonDir, commonDir, bare: record.worktrees[0]?.root === null, objectFormat: record.objectFormat };
}

/** A report for a recovery that could not verify anything: class C (never redone automatically). */
function unverifiable(pre: PreLandingState, push: PushOutcome | 'unknown', why: string, problems: readonly IdentityProblem[] = []): CheckedReport {
  return {
    kind: 'checked',
    push,
    verification: {
      overall: 'cannot-determine',
      targetBefore: pre.targetBefore,
      targetAfter: null,
      landed: false,
      worktrees: pre.worktrees.map((w) => ({ kind: 'cannot-determine', worktree: w.path, changes: [why] })),
      leftoverLocks: [],
      newWorktrees: [],
      identityChanged: problems,
      historyUnconfirmed: false,
    },
    outcome: 'C',
    next: null,
    why,
    binding: pre.binding ?? (pre.targetWorktree === null ? 'zero' : 'one'),
    approvedAfter: null,
    locks: [],
    reminders: [],
    admission: null,
    recovered: true,
  };
}

/**
 * Recovery after a crash or timeout (6.6): once the push phase has begun, first
 * make sure the old push is gone (6.1), then verify every worktree whatever the
 * target branch says, against the worktree set recorded before the push, then
 * report. Never pushes again. Works from the persisted record alone: the
 * repository is the recorded common dir, never rediscovered from the request's
 * path (review r1 #10); whatever cannot be read becomes "cannot determine" (C).
 */
export async function recoverLanding(req: LandingRequest, deps: LandingDeps): Promise<RecoveryResult> {
  const { git, journal } = deps;
  const state = await journal.load(req.key);
  if (state === null || state.phases.length === 0) return { kind: 'nothing-recorded' };
  if (state.report !== null) return { kind: 'already-complete', report: state.report };
  const pushRec = state.phases.find((p): p is Extract<PhaseRecord, { phase: 'push' }> => p.phase === 'push');
  if (pushRec === undefined) return { kind: 'not-started', lastPhase: (state.phases[state.phases.length - 1] as PhaseRecord).phase };

  // 1. The old push must be gone (6.1): wait for it, then force it, then give up and report.
  const stray = new Map<string, ProcessIdentity>();
  if (state.pushProcess !== null && isProcessAlive(state.pushProcess)) stray.set(String(state.pushProcess.pid), state.pushProcess);
  for (const p of findProcessesByToken(pushRec.token)) stray.set(String(p.pid), p);
  if (stray.size > 0) {
    let alive = await waitGone([...stray.values()], deps.exitWaitMs ?? 60_000);
    if (alive.length > 0) {
      for (const p of alive) killProcess(p);
      alive = await waitGone(alive, 5_000);
      if (alive.length > 0) return { kind: 'push-unconfirmed', processes: alive };
    }
  }

  const verifyRec = state.phases.find((p): p is Extract<PhaseRecord, { phase: 'verify' }> => p.phase === 'verify');
  const push = verifyRec?.push ?? 'unknown';
  const finish = async (report: CheckedReport): Promise<RecoveryResult> => {
    for (const n of resultNotices(push, report.verification, report, report.locks)) await journal.notify(req.key, n);
    await journal.complete(req.key, report);
    return { kind: 'checked', report };
  };
  if (pushRec.record === undefined) {
    return finish(unverifiable(pushRec.pre, push, 'the worktree set recorded before the push is missing: nothing can be verified'));
  }
  const repo = layoutFromRecord(pushRec.record);
  let scratch: string | null = null;
  let view: LandingView | null = null;
  let attributes: AttributeEvaluator | null = null;
  try {
    scratch = mkdtempSync(join(deps.scratchDir, 'mp-recover-'));
    // The repository's git dir itself must still be the recorded object; worktrees whose directories changed are left out.
    const problems = identityProblems(pushRec.record);
    if (problems.some((p) => p.worktree === null)) {
      return await finish(unverifiable(pushRec.pre, push, `the repository's git dir ${repo.commonDir} was moved or replaced`, problems));
    }
    view = await LandingView.build({
      git,
      repo,
      description: req.description,
      scratchDir: scratch,
      ...(deps.bwrapPath !== undefined ? { bwrapPath: deps.bwrapPath } : {}),
      // The set recorded before the push: the same directory objects are checked again (6.6 v36).
      record: pushRec.record,
    });
    const tolerant = view.excluding(problems.map((p) => p.worktree as string));
    const rgit = git.withSandbox(tolerant).withLocators({ gitDir: view.commonDir });
    attributes = await AttributeEvaluator.create(git, repo, req.description, scratch);
    const changeSet = await computeMaterializedChangeSet({ git: rgit, repo, base: req.base, delivery: req.delivery, attributes });
    // A recovered push is 'unknown' unless its outcome was recorded; the class comes from the check alone.
    return await finish(
      await checkAfterPush({ git, repo, view, req, pre: pushRec.pre, changeSet, attributes, push, recovered: true, admission: null, scratchDir: scratch }),
    );
  } catch (e) {
    // Whatever cannot be read (a moved repository, a removed worktree, ...) is "cannot determine": C, reported.
    const problems = e instanceof WorktreeIdentityChanged ? e.problems : [];
    return finish(unverifiable(pushRec.pre, push, `the landing could not be verified: ${(e as Error).message}`, problems));
  } finally {
    view?.dispose();
    attributes?.dispose();
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
}
