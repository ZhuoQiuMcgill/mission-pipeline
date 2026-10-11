// Landing a delivery on its target branch (design 4.1 §6.6, §6.7; WI-01,
// WI-02, WI-03, WI-04, WI-05, WI-06, WI-08; decision 2), with plain git.
//
// The maintainer's "deliver" is consent to land; `mp pm land <delivery>
// --words W-<n>` links the landing to that words entry. The delivery commit D
// was built and proven on base B; a landing moves the target branch from B to D
// and nothing else:
//   1. take the landing lock (§4.1: an OS file lock the kernel frees when its
//      holder exits) for the whole landing; another landing waits, then gets
//      "landing in progress";
//   2. record the intent (branch, B, D, the worktree it uses) and the attempt,
//      in one write that also checks stops, the delivery's currency and the
//      git-writes hold; git then runs with no database lock held;
//   3. branch checked out nowhere: `git update-ref refs/heads/<b> D B`
//      (compare-and-swap);
//   4. branch checked out in one clean worktree: right before, `symbolic-ref
//      HEAD` must be the branch and HEAD = B there; then `git merge --ff-only D`;
//   5. the result is judged only by the target ref (D: landed), never by git's
//      messages, and recorded. A ref that is not D, or a HEAD that changed
//      between the check and the merge, is WI-06 class C.
// Before the intent: a target already moved off B is WI-05 (the caller rebuilds
// the candidate on the new base, counted, or leaves the delivery ref); several
// worktrees or an operation holding the branch is WI-01; one dirty or external
// worktree is WI-02; a leftover git lock file is WI-06. Nothing is written then.
// "Clean" and, after the landing, "matches D" (WI-04) are judged on the
// worktree's actual index, files and modes against the commit's clean
// checkout (workspace.ts compareToCommit), never on `git status`; what cannot
// be judged is reported as undetermined. The stop scope is the delivery's
// (delivery/scope.ts), persisted with the intent and derived again on a retry.
// Every attempt that runs git is counted in its authorizing write (loop
// `landing-attempt`: the first and 3 more per delivery; the same verdict twice
// in a row is no progress), so retries end in WI-08 until a grant. External
// work in a write scope of a mission in flight is noticed before git runs
// (WI-03, delivery/external.ts); it never blocks the landing.
//
// Recovery (§6.7, r2 F1, r3 F1): any later call that finds an open landing
// intent tries the landing lock without waiting. Held: "landing in progress",
// nothing touched. Taken: the `mp` that held it has ended, but a git command it
// started may still run (a killed parent does not kill its child; on Windows it
// never does), so the lock proves nothing about git:
//   - target ref at D: recorded done (the worktree, if any, compared: WI-04);
//   - target ref at B: the intent stays open; "at B" never closes it. A retry
//     (`land` again) reissues the same B→D under the lock, checked against
//     stops like a new landing; in a worktree only when it is clean at B with
//     no git lock file. A late finish of the old git command and the retry
//     cannot both apply: both are B→D, so only D can ever land;
//   - anything else: WI-06 class C, never redone automatically.
// Only the PM closes an intent as not landed (closeNotLanded), after a fresh
// check. The remaining races (someone running git by hand in the maintainer's
// worktree during a landing) end in WI-06, not in more machinery (U-8).
//
// Replaces landing.ts (the five-phase landing in the bubblewrap view),
// landingView.ts, landingLedger.ts, landingRetry.ts and landingResult.ts.

import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../common/hash.ts';
import type { AlertId, ContentHash, GitOid, MissionId } from '../common/ids.ts';
import type { BaseRecord } from '../common/records.ts';
import {
  appendRecords,
  assertNotStopped,
  authorizeIntent,
  deliveryInfo,
  finishIntent,
  intentInfo,
  landingState,
  LedgerError,
  lock,
  loopState,
  openIntents,
  raiseAlert,
  recheckIntent,
  recordLandingPhase,
  stoppedFor,
  tryLock,
  wordsEntry,
  type Db,
  type DeliveryInfo,
  type Filler,
  type IntentInfo,
  type ProcessLock,
  type WriteTx,
} from '../memory/index.ts';
import { gitOid } from './objects.ts';
import type { GitResult } from './plainGit.ts';
import { assertScopeNotStopped, deriveScope, scopeStopped, storedScope, tagScope, unionWork, type WorkScope } from '../delivery/scope.ts';
import { noticeExternalWork } from '../delivery/external.ts';
import { shellQuote } from './plainGit.ts';
import { linkedGitDirs, occupies, readOccupancy } from './worktreeRecord.ts';
import { compareToCommit, type GitContext } from './workspace.ts';

/** The name of the landing lock under `.mission-pipeline/locks/`. */
export const LANDING_LOCK = 'landing';

/** The intent's conflict domain: one open landing per target branch. */
export function landingDomain(branch: string): string {
  return `landing:refs/heads/${branch}`;
}

/** How the worktree holding the branch relates to the delivery after a landing (WI-04). */
export interface WorktreeCheck {
  readonly root: string;
  readonly relation: 'consistent' | 'branch-advanced-files-stale' | 'cannot-determine';
  readonly head: GitOid | null;
  readonly branch: string | null;
  /** Paths whose index entry or file differs from the delivery commit's (at most 200). */
  readonly differing: readonly string[];
  /** WI-04 option 1: given only when its precondition held at the check (HEAD = D on the branch, index = files = B). */
  readonly command: string | null;
  /** Why it is not consistent, or why it could not be determined. */
  readonly detail: string;
}

export interface Occupant {
  readonly root: string;
  readonly gitDir: string | null;
  /** The repository's main worktree, or the worktree the project folder is in: not external (WI-02). */
  readonly main: boolean;
  readonly branch: string | null;
  /** A rebase or bisect started from the target branch holds it although HEAD is detached. */
  readonly operation: 'rebase' | 'bisect' | null;
  readonly missing: boolean;
}

export type LandingResult =
  | {
      readonly kind: 'landed';
      readonly mission: MissionId;
      readonly delivery: string;
      readonly branch: string;
      readonly base: GitOid;
      readonly commit: GitOid;
      /** cas: update-ref; fast-forward: merge --ff-only in the worktree; found: the ref was already at D (an earlier attempt, or by hand). */
      readonly via: 'cas' | 'fast-forward' | 'found';
      /** The landing intent; for a branch found at D while no intent could be authorized (a stop, git writes held), its `<intent>.found` landing record. */
      readonly intent: string;
      /** The worktree holding the branch, compared with D (WI-04 when not consistent). */
      readonly worktree: WorktreeCheck | null;
      /** The attempt's git step had started before a stop that now covers it (§6.6). */
      readonly startedBeforeStop: boolean;
    }
  /** Another `mp` holds the landing lock (WI-06 "in progress"): nothing was touched. */
  | { readonly kind: 'in-progress' }
  /** WI-05: the target branch is not at the delivery's base: nothing landed; rebuild on `now`, or leave the delivery ref. `now` null: the branch is gone. */
  | { readonly kind: 'base-moved'; readonly wi: 'WI-05'; readonly branch: string; readonly base: GitOid; readonly now: GitOid | null; readonly intent: string | null }
  /** WI-01 / WI-02: the occupancy does not allow a landing; the delivery ref stays. `intent`: an open intent stays open (a retry found it so). */
  | {
      readonly kind: 'not-landed';
      readonly wi: 'WI-01' | 'WI-02';
      /** undetermined: whether the worktree is clean at the base could not be judged on its files (WI-02). */
      readonly reason: 'several-worktrees' | 'operation' | 'dirty' | 'external' | 'worktree-missing' | 'undetermined';
      readonly detail: string;
      readonly occupants: readonly Occupant[];
      readonly paths: readonly string[];
      readonly intent: string | null;
    }
  /** WI-06: an intent is open after this call. B: the ref is at the base (a retry may land it); C: anything else, never redone automatically. */
  | {
      readonly kind: 'open';
      readonly wi: 'WI-06';
      readonly class: 'B' | 'C';
      readonly intent: string;
      readonly branch: string;
      readonly base: GitOid;
      readonly commit: GitOid;
      /** The target ref's value now (null: the branch does not exist). */
      readonly ref: GitOid | null;
      readonly detail: string;
      readonly lockFiles: readonly string[];
      readonly startedBeforeStop: boolean;
    }
  /** WI-06: refused before any intent: a git lock file is present, or another delivery's landing intent is open on the branch. */
  | { readonly kind: 'refused'; readonly wi: 'WI-06'; readonly reason: 'lock-file' | 'other-intent-open'; readonly detail: string; readonly lockFiles: readonly string[]; readonly intent: string | null };

export interface LandRequest {
  readonly mission: MissionId;
  /** The delivery's id (its op): it must be the mission's current, recorded, not withdrawn delivery. */
  readonly delivery: string;
  /** W-<n>: the maintainer's words that gave the consent (decision 1). */
  readonly words: string;
  /** WI-02 option 2: land into this external worktree (its root), when it is clean and at the base. */
  readonly allowExternal?: string | null;
  /** How long to wait for the landing lock (default: the memory's busy limit). */
  readonly waitMs?: number;
  /** The PM's filler, recorded with the command (§3.2 item 13). */
  readonly filler?: Filler | null;
}

/** Test hooks: a crash right before or right after the git step. */
export interface LandHooks {
  readonly beforeGit?: () => void;
  readonly afterGit?: () => void;
}

interface IntentDetails {
  readonly delivery: { readonly mission: string; readonly op: string; readonly commit: string; readonly base: string; readonly ref: string; readonly targetBranch: string };
  readonly branch: string;
  readonly base: GitOid;
  readonly commit: GitOid;
  readonly words: string;
  /** The stop scope the authorization used: every related mission and capability (delivery/scope.ts). */
  readonly scope?: WorkScope;
}

interface AttemptData {
  readonly mode: 'cas' | 'fast-forward';
  readonly worktree: string | null;
  readonly words: string;
  /** The stop scope this attempt was checked against, in its authorizing write. */
  readonly scope: WorkScope;
}

// ---------------------------------------------------------------- reads of the repository

function readRef(ctx: GitContext, branch: string): GitOid | null {
  const r = ctx.git.runSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`], { cwd: ctx.memory.projectDir });
  return r.code === 0 ? gitOid(r.stdout.toString('utf8').trim()) : null;
}

/** The worktree the project folder is in (the maintainer's checkout, also when it is a linked worktree, §11.15). */
function projectRoot(ctx: GitContext): string {
  return real(ctx.git.textSync(['rev-parse', '--path-format=absolute', '--show-toplevel'], { cwd: ctx.memory.projectDir }));
}

function commonDirOf(ctx: GitContext): string {
  return real(ctx.git.textSync(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ctx.memory.projectDir }));
}

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Every worktree that holds `refs/heads/<branch>`: checked out, or rebased or bisected from it (WI-01). */
export function occupantsOf(ctx: GitContext, branch: string): Occupant[] {
  const target = `refs/heads/${branch}`;
  const common = commonDirOf(ctx);
  const listed = ctx.git.okSync(['worktree', 'list', '--porcelain', '-z'], { cwd: ctx.memory.projectDir }).stdout.toString('utf8');
  const linked = new Map(linkedGitDirs(common).map((l) => [real(l.root), l.gitDir] as const));
  const own = projectRoot(ctx);
  const out: Occupant[] = [];
  let first = true;
  for (const block of listed.split('\0\0')) {
    const fields = block.split('\0').filter((f) => f !== '');
    const path = fields.find((f) => f.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined) continue;
    const main = first;
    first = false;
    if (fields.includes('bare')) continue;
    const branchField = fields.find((f) => f.startsWith('branch '))?.slice('branch '.length) ?? null;
    const gitDir = main ? common : (linked.get(real(path)) ?? null);
    const occ = gitDir === null ? { branch: branchField, rebasing: null, bisecting: null, inProgress: false } : readOccupancy(gitDir, branchField);
    if (!occupies(occ, target)) continue;
    const operation = occ.branch === target ? null : occ.rebasing === target ? 'rebase' : 'bisect';
    out.push({ root: path, gitDir, main: main || real(path) === own, branch: occ.branch, operation, missing: !existsSync(path) });
  }
  return out;
}

/** Untracked files at paths the delivery adds (WI-02: "an untracked file where the delivery puts one"). */
function untrackedInTheWay(ctx: GitContext, root: string, base: GitOid, commit: GitOid): string[] {
  const added = ctx.git.okSync(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', base, commit, '--'], { cwd: root }).stdout.toString('utf8').split('\0').filter((p) => p !== '');
  return added.filter((p) => existsSync(join(root, ...p.split('/'))));
}

/** Git lock files a landing of `branch` (in `occupant`, if any) would collide with. */
function lockFilesOf(ctx: GitContext, branch: string, occupant: Occupant | null): string[] {
  const common = commonDirOf(ctx);
  const files = [join(common, 'refs', 'heads', ...branch.split('/')) + '.lock'];
  if (occupant?.gitDir) files.push(join(occupant.gitDir, 'index.lock'), join(occupant.gitDir, 'HEAD.lock'));
  return files.filter((f) => existsSync(f));
}

function headOf(ctx: GitContext, root: string): { head: GitOid | null; branch: string | null } {
  const sym = ctx.git.runSync(['symbolic-ref', '-q', 'HEAD'], { cwd: root });
  const head = ctx.git.runSync(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: root });
  return { branch: sym.code === 0 ? sym.stdout.toString('utf8').trim() : null, head: head.code === 0 ? gitOid(head.stdout.toString('utf8').trim()) : null };
}

/**
 * WI-04 option 1, offered only when a fresh check finds HEAD = D on the branch
 * and the index and files exactly B: a two-tree read-tree brings the index and
 * files from B to D and keeps local changes that do not conflict (on a
 * conflict it refuses and changes nothing), with the delivery's attributes,
 * sparse checkout off, no submodule recursion and no replace objects.
 */
export function staleFilesRecoveryCommand(root: string, base: GitOid, delivery: GitOid): string {
  return `git -C ${shellQuote(root)} --attr-source=${delivery} -c core.sparseCheckout=false -c submodule.recurse=false -c core.useReplaceRefs=false read-tree -u -m ${base} ${delivery}`;
}

/**
 * WI-04: the worktree holding the branch, compared with the delivery after a
 * landing, on its actual index, files and modes (compareToCommit). Consistent
 * only when that comparison says so; "branch advanced, files stale" only when
 * HEAD is D on the branch and the index and files are exactly B; anything else,
 * or a comparison that cannot be made, is "cannot determine".
 */
export async function compareWorktree(ctx: GitContext, root: string, branch: string, base: GitOid, commit: GitOid): Promise<WorktreeCheck> {
  if (!existsSync(root)) return { root, relation: 'cannot-determine', head: null, branch: null, differing: [], command: null, detail: `${root} does not exist` };
  const { head, branch: on } = headOf(ctx, root);
  const onBranch = on === `refs/heads/${branch}`;
  const vsD = await compareToCommit(ctx, root, commit);
  if (vsD.state === 'match' && onBranch && head === commit) return { root, relation: 'consistent', head, branch: on, differing: [], command: null, detail: 'HEAD, index and files are the delivery commit' };
  if (vsD.state === 'undetermined') return { root, relation: 'cannot-determine', head, branch: on, differing: [], command: null, detail: vsD.reason };
  const differing = vsD.state === 'differs' ? [...new Set([...vsD.index, ...vsD.files])].slice(0, 200) : [];
  if (onBranch && head === commit && (await compareToCommit(ctx, root, base)).state === 'match') {
    return { root, relation: 'branch-advanced-files-stale', head, branch: on, differing, command: staleFilesRecoveryCommand(root, base, commit), detail: 'the branch is at the delivery commit; the index and files are still the base' };
  }
  return {
    root,
    relation: 'cannot-determine',
    head,
    branch: on,
    differing,
    command: null,
    detail: onBranch && head === commit ? 'the index or files differ from the delivery commit' : `HEAD is ${on ?? 'detached'} at ${head ?? '(none)'}, not ${branch} at the delivery commit`,
  };
}

// ---------------------------------------------------------------- records

function intentId(db: Db, mission: string, delivery: string): string {
  for (let k = 1; ; k++) {
    const id = `land:${mission}:${delivery}:${k}`;
    const i = intentInfo(db, id);
    if (i === null || i.state === 'authorized') return id;
  }
}

/**
 * The id of a `.found` landing record (recordFound) for this consent: the same
 * request (same words, same commit) finds its own record again (idempotent); a
 * new consent gets a record, and an operation id, of its own.
 */
function foundId(db: Db, data: { text(hash: string): string }, mission: string, delivery: string, words: string, commit: string): string {
  for (let k = 1; ; k++) {
    const id = `land:${mission}:${delivery}:${k}.found`;
    const st = landingState(db, id);
    if (st === null) return id;
    try {
      const d = JSON.parse(data.text(st.data)) as { words?: unknown; ref?: unknown };
      if (d.words === words && d.ref === commit) return id;
    } catch {
      /* not ours: the next id */
    }
  }
}

/** WI-08 (6.5): the landing attempts of a delivery that run git are counted, the first and 3 more (LOOP_CAPS). */
export const LANDING_LOOP = 'landing-attempt';

export function landingLineage(mission: string, delivery: string): string {
  return `landing:${mission}:${delivery}`;
}

/**
 * The loop record of one more landing attempt, counted in its authorizing
 * write. Its signature is what the previous attempt of the intent ended with:
 * two retries after the same verdict (the same class, the ref at the same
 * commit) are "no progress" (WI-08); a first attempt, or one after a crash
 * that left no verdict, is never a repeat.
 */
function landingAttemptRecord(db: Db, data: { text(hash: string): string }, mission: string, delivery: string, intent: string, mode: string): BaseRecord {
  const attempts = attemptsOf(db, intent);
  const last = attempts[attempts.length - 1];
  let signature = `${mode}|first|${intent}`;
  if (last !== undefined) {
    signature = `${mode}|unjudged|${last.id}`;
    if (last.phase === 'verify') {
      try {
        const v = JSON.parse(data.text(last.data)) as { class?: unknown; ref?: unknown };
        signature = `${mode}|${String(v.class)}|${String(v.ref)}`;
      } catch {
        /* keep the unjudged signature */
      }
    }
  }
  return { kind: 'loop.attempt', lineage: landingLineage(mission, delivery), loop: LANDING_LOOP, failureClass: null, signature };
}

/** The landing attempts are used up (LOOP_EXHAUSTED): a WI-08 notice, then the refusal goes to the caller. */
function attemptsExhausted(ctx: GitContext, e: unknown, mission: string, delivery: string): void {
  if (!(e instanceof LedgerError) || e.code !== 'LOOP_EXHAUSTED') return;
  const m = ctx.memory;
  const st = m.read((db) => loopState(db, landingLineage(mission, delivery), LANDING_LOOP));
  m.write({}, (tx) =>
    notice(tx, `landing.${mission}.${delivery}.exhausted.${st.attempts}`, 'WI-08', 'landing-attempts-exhausted', {
      trigger: `the landing of ${mission}/${delivery} used its attempts (${st.attempts} of ${st.allowed}${st.reason === 'no-progress' ? ', the same verdict twice in a row' : ''})`,
      facts: { loop: LANDING_LOOP, lineage: landingLineage(mission, delivery), attempts: st.attempts, allowed: st.allowed, reason: st.reason },
      defaultAction: 'no further landing attempt runs git; the delivery ref is kept; the Secretary may grant once, then only the maintainer',
    }),
  );
}

function attemptId(intent: string, n: number): string {
  return `${intent}.a${n}`;
}

/** The intent's attempts so far (each a landing record with its phases). */
function attemptsOf(db: Db, intent: string): Array<{ id: string; phase: string; data: ContentHash }> {
  const out: Array<{ id: string; phase: string; data: ContentHash }> = [];
  for (let n = 1; ; n++) {
    const s = landingState(db, attemptId(intent, n));
    if (s === null) return out;
    out.push({ id: s.landing, phase: s.phase, data: s.data });
  }
}

function openLandingFor(db: Db, branch: string): IntentInfo | null {
  return openIntents(db).find((i) => i.kind === 'landing' && i.domain === landingDomain(branch)) ?? null;
}

function detailsOf(ctx: GitContext, i: IntentInfo): IntentDetails {
  return JSON.parse(ctx.memory.data.text(i.details)) as IntentDetails;
}

function notice(tx: WriteTx, id: string, wi: string, category: string, body: { trigger: string; facts: unknown; defaultAction: string }): void {
  raiseAlert(tx, { alert: id.replace(/[^A-Za-z0-9._:@-]/g, '-').slice(0, 200) as AlertId, category, wi, body: tx.data.put(canonicalJson(body)) });
}

function currentDeliveryOf(ctx: GitContext, mission: MissionId, delivery: string): DeliveryInfo {
  const d = ctx.memory.read((db) => deliveryInfo(db, mission, delivery));
  if (d === null || d.recordedRev === null) throw new LedgerError('DELIVERY_NOT_CURRENT', `mission ${mission} has no recorded delivery ${delivery}`);
  if (d.target === null) throw new LedgerError('BAD_REQUEST', `delivery ${delivery} names no target branch`);
  return d;
}

// ---------------------------------------------------------------- landing

type Mode = { readonly mode: 'cas'; readonly occupant: null } | { readonly mode: 'fast-forward'; readonly occupant: Occupant };

/** The occupancy decision of §6.7 / WI-01 / WI-02 for a landing B→D now. */
async function decideMode(ctx: GitContext, branch: string, base: GitOid, commit: GitOid, allowExternal: string | null): Promise<Mode | Extract<LandingResult, { kind: 'not-landed' }>> {
  const occ = occupantsOf(ctx, branch);
  const no = (wi: 'WI-01' | 'WI-02', reason: Extract<LandingResult, { kind: 'not-landed' }>['reason'], detail: string, paths: readonly string[] = []) =>
    ({ kind: 'not-landed', wi, reason, detail, occupants: occ, paths, intent: null }) as const;
  if (occ.length === 0) return { mode: 'cas', occupant: null };
  const op = occ.find((o) => o.operation !== null);
  if (op !== undefined) return no('WI-01', 'operation', `a ${op.operation} started from ${branch} is in progress in ${op.root}`);
  if (occ.length > 1) return no('WI-01', 'several-worktrees', `${branch} is checked out in ${occ.length} worktrees: ${occ.map((o) => o.root).join(', ')}`);
  const o = occ[0]!;
  if (o.missing || o.gitDir === null) return no('WI-02', 'worktree-missing', `${branch} is checked out in ${o.root}, which is missing or not registered as git expects`);
  if (!o.main && (allowExternal === null || real(allowExternal) !== real(o.root))) {
    return no('WI-02', 'external', `${branch} is checked out in the external worktree ${o.root}, not the repository's main checkout`);
  }
  // Clean = the index, files and modes are exactly the base's, judged on what is there (not git status, not index flags).
  const clean = await compareToCommit(ctx, o.root, base);
  if (clean.state === 'undetermined') return no('WI-02', 'undetermined', `whether ${o.root} is clean at the base cannot be determined: ${clean.reason}`);
  if (clean.state === 'differs') return no('WI-02', 'dirty', `${o.root} has uncommitted changes`, [...new Set([...clean.index, ...clean.files])].slice(0, 200));
  const inTheWay = untrackedInTheWay(ctx, o.root, base, commit);
  if (inTheWay.length > 0) return no('WI-02', 'dirty', `${o.root} has untracked files where the delivery puts files`, inTheWay.slice(0, 200));
  return { mode: 'fast-forward', occupant: o };
}

/**
 * `mp pm land <delivery> --words W-<n>` (§6.7): a new landing, or the retry of
 * this delivery's open intent. Stops, a delivery that is not current and held
 * git writes are refused (LedgerError: STOPPED, DELIVERY_NOT_CURRENT,
 * GIT_WRITES_HELD), before anything is run.
 */
export async function land(ctx: GitContext, req: LandRequest, hooks: LandHooks = {}): Promise<LandingResult> {
  const { memory: m } = ctx;
  if (typeof req.words !== 'string' || !/^W-[1-9][0-9]*$/.test(req.words)) throw new LedgerError('BAD_REQUEST', 'a landing names the words entry that gave the consent: --words W-<n>');
  if (m.read((db) => wordsEntry(db, req.words)) === null) throw new LedgerError('BAD_REQUEST', `no words entry ${req.words}`);
  let held: ProcessLock;
  try {
    held = lock(m.paths.locks, LANDING_LOCK, { waitMs: req.waitMs ?? m.busyTimeoutMs });
  } catch (e) {
    if (e instanceof LedgerError && e.code === 'LOCKED') return { kind: 'in-progress' };
    throw e;
  }
  try {
    return await landLocked(ctx, req, hooks);
  } finally {
    held.release();
  }
}

/**
 * The landing's stop scope (§6.6), derived in `db` (an authorizing write's
 * transaction): the delivery's mission and the source missions of its objects,
 * with the capabilities its delivery recorded and those derived now
 * (delivery/scope.ts).
 */
function landingScope(db: Db, data: { text(hash: string): string }, d: DeliveryInfo): WorkScope {
  let recorded: string[] = [];
  let missions: string[] = [];
  if (d.manifest !== null) {
    try {
      const doc = JSON.parse(data.text(d.manifest)) as { capabilities?: unknown; entries?: Array<{ mission?: unknown }> };
      if (Array.isArray(doc.capabilities)) recorded = doc.capabilities.filter((c): c is string => typeof c === 'string');
      if (Array.isArray(doc.entries)) missions = doc.entries.map((e) => e.mission).filter((x): x is string => typeof x === 'string');
    } catch {
      /* a delivery not made by this mp: derived only */
    }
  }
  return deriveScope(db, d.mission, missions, recorded);
}

/** The scope an open intent was authorized and retried with: its tag, its details', its attempts'. */
function intentScope(db: Db, data: { text(hash: string): string }, i: IntentInfo, det: IntentDetails): WorkScope {
  let s = tagScope(i.tag);
  const stored = storedScope(det.scope);
  if (stored !== null) s = unionWork(s, stored);
  for (const a of attemptsOf(db, i.intent)) {
    try {
      const at = storedScope((JSON.parse(data.text(a.data)) as { scope?: unknown }).scope);
      if (at !== null) s = unionWork(s, at);
    } catch {
      /* an attempt without data */
    }
  }
  return s;
}

async function landLocked(ctx: GitContext, req: LandRequest, hooks: LandHooks): Promise<LandingResult> {
  const { memory: m } = ctx;
  const d = currentDeliveryOf(ctx, req.mission, req.delivery);
  const branch = d.target!;
  const base = gitOid(d.base);
  const commit = gitOid(d.commit);
  const open = m.read((db) => openLandingFor(db, branch));
  const allowExternal = req.allowExternal ?? null;

  if (open !== null) {
    const det = detailsOf(ctx, open);
    if (det.delivery.mission !== req.mission || det.delivery.op !== req.delivery) {
      return { kind: 'refused', wi: 'WI-06', reason: 'other-intent-open', detail: `the landing of ${det.delivery.mission}/${det.delivery.op} on ${branch} is still open (intent ${open.intent}); resolve it first`, lockFiles: [], intent: open.intent };
    }
    // The retry of this delivery's open intent (WI-06 option 3). A ref already at D is what happened:
    // recorded, also under a stop or the git-writes hold (nothing is written to git).
    const now = readRef(ctx, branch);
    if (now === commit) return recordLanded(ctx, open, det, 'found', null);
    // Checked like a new landing (§6.6): the stored scope and the scope derived now (again inside the write below).
    m.read((db) => assertScopeNotStopped(db, unionWork(intentScope(db, m.data, open, det), landingScope(db, m.data, d)), 'this landing'));
    m.assertGitWrites('a landing');
    if (now !== base) return recordOpen(ctx, open, det, 'C', now, `the target ref is at ${now ?? '(absent)'}, neither the base nor the delivery commit`, []);
    await noticeExternalWork(ctx, { mission: req.mission, delivery: req.delivery, base, targetBranch: branch, at: 'landing' });
    const mode = await decideMode(ctx, branch, base, commit, allowExternal);
    if ('kind' in mode) return { ...mode, intent: open.intent };
    const locks = lockFilesOf(ctx, branch, mode.occupant);
    if (locks.length > 0) return recordOpen(ctx, open, det, 'C', now, `git lock files are present: ${locks.join(', ')}`, locks);
    const n = m.read((db) => attemptsOf(db, open.intent).length) + 1;
    const attempt = attemptId(open.intent, n);
    try {
      m.write({ op: attempt, payload: { land: req.delivery, mission: req.mission, words: req.words, attempt: n }, command: 'land', filler: req.filler ?? null }, (tx) => {
        // In the authorizing write: a stop committed during the checks above is seen here.
        const scope = unionWork(intentScope(tx, tx.data, open, det), landingScope(tx, tx.data, d));
        assertScopeNotStopped(tx, scope, 'this landing');
        recheckIntent(tx, open.intent);
        appendRecords(tx, [landingAttemptRecord(tx, tx.data, req.mission, req.delivery, open.intent, mode.mode)]);
        recordLandingPhase(tx, { landing: attempt, intent: open.intent, phase: 'push', data: { mode: mode.mode, worktree: mode.occupant?.root ?? null, words: req.words, scope } satisfies AttemptData });
        return { attempt };
      });
    } catch (e) {
      attemptsExhausted(ctx, e, req.mission, req.delivery);
      throw e;
    }
    return runAttempt(ctx, open.intent, det, attempt, mode, hooks);
  }

  // A new landing: nothing is written until the occupancy allows it (class A otherwise). The actual result
  // is judged first: a branch already at D is only recorded (no git write). Then a stop is reported first,
  // and checked again, with the scope derived again, inside the authorizing write.
  const authorize = (tx: WriteTx): WorkScope => {
    const scope = landingScope(tx, tx.data, d);
    assertScopeNotStopped(tx, scope, 'this landing');
    authorizeIntent(tx, { intent, kind: 'landing', domain: landingDomain(branch), tag: { mission: req.mission, capabilities: [...scope.capabilities] }, details: { ...det, scope } });
    return scope;
  };
  const now = readRef(ctx, branch);
  const det: IntentDetails = {
    delivery: { mission: req.mission, op: req.delivery, commit, base, ref: d.ref, targetBranch: branch },
    branch,
    base,
    commit,
    words: req.words,
  };
  const intent = m.read((db) => intentId(db, req.mission, req.delivery));
  if (now === commit) {
    // Already at D (landed by hand, or an earlier landing whose record was lost): recorded as landed with this
    // consent. Under a stop or the git-writes hold no intent can be authorized; what happened is still recorded.
    try {
      m.write({ op: attemptId(intent, 1), payload: { land: req.delivery, mission: req.mission, words: req.words, found: commit }, command: 'land', filler: req.filler ?? null }, (tx) => {
        authorize(tx);
        return { intent };
      });
    } catch (e) {
      if (e instanceof LedgerError && (e.code === 'STOPPED' || e.code === 'GIT_WRITES_HELD')) {
        return recordFound(ctx, det, m.read((db) => foundId(db, m.data, req.mission, req.delivery, req.words, commit)), e.code, req);
      }
      throw e;
    }
    const i = m.read((db) => intentInfo(db, intent))!;
    return recordLanded(ctx, i, det, 'found', null);
  }
  m.read((db) => assertScopeNotStopped(db, landingScope(db, m.data, d), 'this landing'));
  m.assertGitWrites('a landing');
  if (now !== base) return { kind: 'base-moved', wi: 'WI-05', branch, base, now, intent: null };
  await noticeExternalWork(ctx, { mission: req.mission, delivery: req.delivery, base, targetBranch: branch, at: 'landing' });
  const mode = await decideMode(ctx, branch, base, commit, allowExternal);
  if ('kind' in mode) return mode;
  const locks = lockFilesOf(ctx, branch, mode.occupant);
  if (locks.length > 0) {
    return { kind: 'refused', wi: 'WI-06', reason: 'lock-file', detail: `git lock files are present (never removed by mp; their owner finishes or removes them): ${locks.join(', ')}`, lockFiles: locks, intent: null };
  }
  const attempt = attemptId(intent, 1);
  try {
    m.write({ op: attempt, payload: { land: req.delivery, mission: req.mission, words: req.words, attempt: 1 }, command: 'land', filler: req.filler ?? null }, (tx) => {
      const scope = authorize(tx);
      appendRecords(tx, [landingAttemptRecord(tx, tx.data, req.mission, req.delivery, intent, mode.mode)]);
      recordLandingPhase(tx, { landing: attempt, intent, phase: 'push', data: { mode: mode.mode, worktree: mode.occupant?.root ?? null, words: req.words, scope } satisfies AttemptData });
      return { intent, attempt };
    });
  } catch (e) {
    attemptsExhausted(ctx, e, req.mission, req.delivery);
    throw e;
  }
  return runAttempt(ctx, intent, det, attempt, mode, hooks);
}

/** Steps 3-5: the git step with no database lock held, then the judgment by the target ref. Under the landing lock. */
async function runAttempt(ctx: GitContext, intent: string, det: IntentDetails, attempt: string, mode: Mode, hooks: LandHooks): Promise<LandingResult> {
  const { branch, base, commit } = det;
  const target = `refs/heads/${branch}`;
  hooks.beforeGit?.();
  let headChanged: string | null = null;
  let git: GitResult | null = null;
  if (mode.mode === 'cas') {
    git = ctx.git.runSync(['update-ref', '-m', `mission-pipeline: land ${det.delivery.mission}/${det.delivery.op}`, target, commit, base], { cwd: ctx.memory.projectDir });
  } else {
    const root = mode.occupant.root;
    const before = headOf(ctx, root);
    if (before.branch !== target || before.head !== base) {
      headChanged = `right before the fast-forward, HEAD in ${root} was ${before.branch ?? 'detached'} at ${before.head ?? '(none)'}, not ${target} at ${base}`;
    } else {
      git = ctx.git.runSync(['merge', '--ff-only', '--no-edit', commit], { cwd: root });
      const after = headOf(ctx, root);
      if (after.branch !== target) headChanged = `HEAD in ${root} changed between the check and the fast-forward (now ${after.branch ?? 'detached'} at ${after.head ?? '(none)'})`;
    }
  }
  hooks.afterGit?.();
  const now = readRef(ctx, branch);
  const i = ctx.memory.read((db) => intentInfo(db, intent))!;
  if (now === commit) return recordLanded(ctx, i, det, mode.mode, mode.occupant?.root ?? null, attempt);
  const said = git === null ? '' : `; git exited ${git.code ?? git.signal}: ${git.stderr.toString('utf8').trim().split(/\r?\n/).slice(-2).join(' | ')}`;
  if (headChanged !== null) return recordOpen(ctx, i, det, 'C', now, headChanged + said, [], attempt);
  if (now === base) return recordOpen(ctx, i, det, 'B', now, `the target ref is still at the base${said}`, [], attempt);
  return recordOpen(ctx, i, det, 'C', now, `the target ref is at ${now ?? '(absent)'}, neither the base nor the delivery commit${said}`, [], attempt);
}

/** The authorization scope an attempt's earlier phase holds, carried into its next phase (intentScope reads it). */
function carriedScope(db: Db, data: { text(hash: string): string }, landing: string): { scope?: WorkScope } {
  const st = landingState(db, landing);
  if (st === null) return {};
  try {
    const scope = storedScope((JSON.parse(data.text(st.data)) as { scope?: unknown }).scope);
    return scope === null ? {} : { scope };
  } catch {
    return {};
  }
}

/**
 * The branch was found at D with no open intent while no intent can be
 * authorized (a stop, or git writes held): nothing is written to git, so what
 * happened is recorded as a landing record of its own (`<intent>.found`, done),
 * with the consent and the reason no intent was made; the worktree is compared
 * (WI-04). `intent` in the result names that record.
 */
async function recordFound(ctx: GitContext, det: IntentDetails, landing: string, why: string, req: LandRequest): Promise<LandingResult> {
  const { memory: m } = ctx;
  const occupant = occupantsOf(ctx, det.branch).find((o) => o.operation === null && !o.missing)?.root ?? null;
  const worktree = occupant === null ? null : await compareWorktree(ctx, occupant, det.branch, det.base, det.commit);
  m.write({ op: landing, payload: { found: det.commit, delivery: det.delivery, words: det.words }, command: 'land', filler: req.filler ?? null }, (tx) => {
    if (landingState(tx, landing) === null) recordLandingPhase(tx, { landing, intent: null, phase: 'done', data: { ref: det.commit, delivery: det.delivery, words: det.words, noIntent: why, worktree } });
    if (worktree !== null && worktree.relation !== 'consistent') {
      notice(tx, `${landing}.wi04`, 'WI-04', 'landing-worktree-mismatch', {
        trigger: `${det.branch} is at the delivery commit ${det.commit}, but the worktree ${worktree.root} does not match it (${worktree.relation})`,
        facts: { worktree, base: det.base, delivery: det.delivery },
        defaultAction: 'the landing is recorded as done; the worktree is not touched',
      });
    }
    return { landing };
  });
  return { kind: 'landed', mission: det.delivery.mission as MissionId, delivery: det.delivery.op, branch: det.branch, base: det.base, commit: det.commit, via: 'found', intent: landing, worktree, startedBeforeStop: false };
}

/** The target ref is at D: the intent is done (once), the latest attempt done, the worktree compared (WI-04). */
async function recordLanded(ctx: GitContext, i: IntentInfo, det: IntentDetails, via: 'cas' | 'fast-forward' | 'found', root: string | null, attempt?: string): Promise<LandingResult> {
  const { memory: m } = ctx;
  const attempts = m.read((db) => attemptsOf(db, i.intent));
  const last = attempt ?? attempts[attempts.length - 1]?.id ?? null;
  const lastData = attempts.find((a) => a.id === last);
  const wtRoot = root ?? (lastData !== undefined ? (JSON.parse(m.data.text(lastData.data)) as Partial<AttemptData>).worktree ?? null : null);
  const occupant = wtRoot ?? occupantsOf(ctx, det.branch).find((o) => o.operation === null && !o.missing)?.root ?? null;
  const worktree = occupant === null ? null : await compareWorktree(ctx, occupant, det.branch, det.base, det.commit);
  const startedBeforeStop = m.read((db) => scopeStopped(db, intentScope(db, m.data, i, det))) && last !== null;
  m.write({}, (tx) => {
    const was = intentInfo(tx, i.intent);
    if (was?.state !== 'authorized') return;
    finishIntent(tx, { intent: i.intent, outcome: 'done' });
    if (last !== null) recordLandingPhase(tx, { landing: last, intent: i.intent, phase: 'done', data: { ref: det.commit, worktree, ...carriedScope(tx, tx.data, last) } });
    if (worktree !== null && worktree.relation !== 'consistent') {
      notice(tx, `${i.intent}.wi04`, 'WI-04', 'landing-worktree-mismatch', {
        trigger: `${det.branch} is at the delivery commit ${det.commit}, but the worktree ${worktree.root} does not match it (${worktree.relation})`,
        facts: { worktree, base: det.base, delivery: det.delivery },
        defaultAction: 'the landing is recorded as done; the worktree is not touched',
      });
    }
  });
  return { kind: 'landed', mission: det.delivery.mission as MissionId, delivery: det.delivery.op, branch: det.branch, base: det.base, commit: det.commit, via, intent: i.intent, worktree, startedBeforeStop };
}

/**
 * The intent stays open (B or C): the attempt's verdict recorded once, with its
 * WI-06 notice. A later check that finds the ref where the recorded verdict saw
 * it records nothing; it never turns a C into a B (a C is read by the PM, not
 * retried by itself).
 */
function recordOpen(ctx: GitContext, i: IntentInfo, det: IntentDetails, cls: 'B' | 'C', now: GitOid | null, detail: string, lockFiles: readonly string[], attempt?: string): LandingResult {
  const { memory: m } = ctx;
  const startedBeforeStop = m.read((db) => scopeStopped(db, intentScope(db, m.data, i, det)) && attemptsOf(db, i.intent).length > 0);
  const verdict = m.write({}, (tx): { cls: 'B' | 'C'; detail: string } => {
    const attempts = attemptsOf(tx, i.intent);
    const last = attempt ?? attempts[attempts.length - 1]?.id ?? null;
    const lastState = attempts.find((a) => a.id === last);
    if (last === null || lastState === undefined) return { cls, detail };
    if (lastState.phase === 'verify') {
      const prev = JSON.parse(tx.data.text(lastState.data)) as { class: 'B' | 'C'; ref: string | null; detail: string };
      if (prev.ref === now && (prev.class === cls || (prev.class === 'C' && cls === 'B'))) return { cls: prev.class, detail: prev.class === cls ? detail : prev.detail };
    }
    recordLandingPhase(tx, { landing: last, intent: i.intent, phase: 'verify', data: { class: cls, ref: now, detail, lockFiles, ...carriedScope(tx, tx.data, last) } });
    notice(tx, `${last}.${cls}`, 'WI-06', cls === 'B' ? 'landing-open-at-base' : 'landing-open-unexpected', {
      trigger: `the landing of ${det.delivery.mission}/${det.delivery.op} on ${det.branch} did not complete: class ${cls} (${detail})`,
      facts: { intent: i.intent, base: det.base, commit: det.commit, ref: now, lockFiles, startedBeforeStop },
      defaultAction: cls === 'B' ? 'the intent stays open; nothing retries by itself' : 'the intent stays open; git is never run again automatically',
    });
    return { cls, detail };
  });
  return { kind: 'open', wi: 'WI-06', class: verdict.cls, intent: i.intent, branch: det.branch, base: det.base, commit: det.commit, ref: now, detail: verdict.detail, lockFiles, startedBeforeStop };
}

// ---------------------------------------------------------------- recovery and closing

export type RecoveryReport =
  /** The landing lock is held: a landing is running; nothing was touched. */
  | { readonly kind: 'in-progress'; readonly intents: readonly string[] }
  | { readonly kind: 'checked'; readonly results: readonly LandingResult[] };

/**
 * §6.7 recovery, for any later call (`mp read status`, `mp pm next`, ...): open
 * landing intents are checked only when the landing lock can be taken without
 * waiting. Held: "landing in progress", nothing recorded. Taken: each open
 * intent is judged by its target ref (D: done; B: stays open; else C).
 */
export async function recoverLandings(ctx: GitContext): Promise<RecoveryReport> {
  const { memory: m } = ctx;
  const open = m.read((db) => openIntents(db).filter((i) => i.kind === 'landing'));
  if (open.length === 0) return { kind: 'checked', results: [] };
  const held = tryLock(m.paths.locks, LANDING_LOCK);
  if (held === null) return { kind: 'in-progress', intents: open.map((i) => i.intent) };
  try {
    const results: LandingResult[] = [];
    for (const i of open) {
      const det = detailsOf(ctx, i);
      const now = readRef(ctx, det.branch);
      if (now === det.commit) results.push(await recordLanded(ctx, i, det, 'found', null));
      else if (now === det.base) results.push(recordOpen(ctx, i, det, 'B', now, 'the target ref is at the base: git did not take effect, or a git command started by an mp that has ended may still be running', []));
      else results.push(recordOpen(ctx, i, det, 'C', now, `the target ref is at ${now ?? '(absent)'}, neither the base nor the delivery commit`, []));
    }
    return { kind: 'checked', results };
  } finally {
    held.release();
  }
}

export type CloseResult =
  | { readonly kind: 'closed'; readonly intent: string; readonly ref: GitOid | null }
  /** The fresh check found the branch at D: recorded as landed instead. */
  | { readonly kind: 'landed'; readonly result: LandingResult }
  | { readonly kind: 'in-progress' }
  | { readonly kind: 'no-open-intent' };

/**
 * `mp pm land <delivery> --close-not-landed` (decision 2, WI-06 option 4): the
 * PM closes the delivery's open landing intent as not landed, after a fresh
 * check under the landing lock. The delivery ref stays; a later landing starts
 * a new intent. Only the PM does this; `mp` never closes an intent by itself.
 */
export async function closeNotLanded(ctx: GitContext, req: { readonly mission: MissionId; readonly delivery: string; readonly filler?: Filler | null; readonly waitMs?: number }): Promise<CloseResult> {
  const { memory: m } = ctx;
  let held: ProcessLock;
  try {
    held = lock(m.paths.locks, LANDING_LOCK, { waitMs: req.waitMs ?? m.busyTimeoutMs });
  } catch (e) {
    if (e instanceof LedgerError && e.code === 'LOCKED') return { kind: 'in-progress' };
    throw e;
  }
  try {
    const i = m.read((db) => openIntents(db).find((x) => x.kind === 'landing' && x.delivery?.mission === req.mission && x.delivery?.op === req.delivery) ?? null);
    if (i === null) return { kind: 'no-open-intent' };
    const det = detailsOf(ctx, i);
    const now = readRef(ctx, det.branch);
    if (now === det.commit) return { kind: 'landed', result: await recordLanded(ctx, i, det, 'found', null) };
    m.write({ op: `${i.intent}.closed`, payload: { close: i.intent, ref: now }, command: 'land --close-not-landed', filler: req.filler ?? null }, (tx) => {
      const attempts = attemptsOf(tx, i.intent);
      const last = attempts[attempts.length - 1];
      finishIntent(tx, { intent: i.intent, outcome: 'failed' });
      if (last !== undefined) recordLandingPhase(tx, { landing: last.id, intent: i.intent, phase: 'refused', data: { closedNotLanded: true, ref: now, ...carriedScope(tx, tx.data, last.id) } });
      return { closed: i.intent };
    });
    return { kind: 'closed', intent: i.intent, ref: now };
  } finally {
    held.release();
  }
}
