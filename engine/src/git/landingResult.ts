// What a landing that entered the push stage leads to (design 6.6 "落地的结果",
// "可以安全重试", v43-v47; 3.11 WI-04, WI-05, WI-06).
//
// The result is decided by a check after the push process has exited, never by
// git's messages, in one fixed order (the first match wins):
//   1. the target branch contains the delivery commit -> landed (worktrees that
//      are not as expected are reported under WI-04; the landing still happened);
//      judged on the raw history (v49); when that cannot be confirmed -> C;
//   2. a leftover lock this landing could have left (the target branch's ref
//      lock; with one occupant, its index.lock) -> C: the program and the PM
//      never delete a lock; the notice tells its owner to finish or clean it, and
//      when nothing else is wrong a new attempt starts once the lock is gone;
//   3. zero occupancy (the receiver refuses any checkout and never writes a
//      worktree or an index): judged on the target ref only: still at the base
//      -> B; moved by someone else to a commit without the delivery -> base moved;
//   4. one occupancy (the receiver can only see the approved worktree): judged on
//      that worktree only, as a WHOLE (v45), in one of two states:
//        (a) untouched: every index entry (path, mode, object, stage and flags,
//            without stat data) equals the record, every change-set path and its
//            parent directories are as recorded, and the tracked paths whose
//            files differ from the index are the same set as before the landing;
//        (b) coherent with its current HEAD: the index is HEAD's tree, no tracked
//            path differs from the index, and HEAD is not the delivery commit;
//            never when the worktree has skip-worktree or assume-unchanged entries
//            or sparse checkout enabled (v46): then only (a) counts;
//      then: target still at the base -> B; moved by someone else -> base moved;
//   5. anything else -> C (never redone automatically).
// The checks run on a COPY of the index (GIT_INDEX_FILE), so checking never
// writes anything of the user's. "Differs from the index" is judged on content:
// on the copy, the skip-worktree and assume-unchanged bits are cleared and the
// stat data refreshed first, so git's "clean" for flagged entries is never
// taken on trust (v46). Submodules are ignored (v46). An unreadable or
// incomplete record is C.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { GitOid } from '../common/ids.ts';
import type { MaterializedChangeSet } from './changeSet.ts';
import { gitOid, indexTree, parentDir, parseLsFiles } from './objects.ts';
import type { LandingView } from './landingView.ts';
import { sha256File } from './representation.ts';
import type { SafeGit } from './safeGit.ts';
import { worktreeLocators, type RecordedWorktree } from './worktreeRecord.ts';

export type PathState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'file'; readonly size: number; readonly sha256: string; readonly executable: boolean }
  | { readonly kind: 'symlink'; readonly sha256: string }
  | { readonly kind: 'dir' }
  | { readonly kind: 'other' };

/** Existence, type, mode and content hash of one path (never follows a symlink). */
export function pathState(abs: string): PathState {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return { kind: 'absent' };
  }
  if (st.isFile()) return { kind: 'file', ...sha256File(abs), executable: (st.mode & 0o100) !== 0 };
  if (st.isSymbolicLink()) return { kind: 'symlink', sha256: createHash('sha256').update(readlinkSync(abs, { encoding: 'buffer' })).digest('hex') };
  if (st.isDirectory()) return { kind: 'dir' };
  return { kind: 'other' };
}

export function samePathState(a: PathState, b: PathState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The approved worktree as far as a landing can write to it (6.6 v44-v47 "可以安全重试"). */
export interface ApprovedState {
  readonly worktree: string;
  readonly gitDir: string;
  readonly head: GitOid | null;
  readonly branch: string | null;
  readonly headTree: GitOid | null;
  /** Index entries without stat data: "tag mode oid stage\tpath" (the `ls-files -v` tag carries the skip-worktree and assume-unchanged flags), sorted. */
  readonly index: readonly string[];
  readonly indexTree: GitOid | null;
  /** Entries with the skip-worktree bit (tag S or s). */
  readonly skipWorktree: number;
  /** Entries with the assume-unchanged bit (a lowercase tag). */
  readonly assumeUnchanged: number;
  /** core.sparseCheckout as this worktree sees it in the view. */
  readonly sparseCheckout: boolean;
  /** Tracked paths whose content differs from the index (judged on a refreshed copy with the flags cleared). */
  readonly dirty: readonly string[];
  /** Every change-set path, with its state. */
  readonly paths: readonly { readonly path: string; readonly state: PathState }[];
  /** Every parent directory of a change-set path. */
  readonly parents: readonly { readonly path: string; readonly kind: 'dir' | 'absent' | 'other' }[];
  /** Null when everything was read; otherwise why the record is incomplete (then nothing is safe to retry). */
  readonly unreadable: string | null;
  /** v49: the read-only LFS clean met a pointer with extension lines (not supported: WI-13). */
  readonly unsupportedLfs?: boolean;
}

/** skip-worktree, assume-unchanged or sparse checkout: git's "clean" cannot be trusted there (v46). */
export function hasHiddenEntries(s: ApprovedState): boolean {
  return s.skipWorktree > 0 || s.assumeUnchanged > 0 || s.sparseCheckout;
}

function lstatKind(abs: string): 'dir' | 'absent' | 'other' {
  try {
    return lstatSync(abs).isDirectory() ? 'dir' : 'other';
  } catch {
    return 'absent';
  }
}

const BIG = 1024 * 1024 * 1024;

/**
 * Reads the approved worktree inside the view, with its own locators; the index
 * only through a copy in `scratchDir`. Never throws: a failure is an incomplete
 * record (`unreadable`).
 */
export async function readApprovedState(o: {
  readonly git: SafeGit;
  readonly view: LandingView;
  readonly worktree: RecordedWorktree;
  readonly changeSet: MaterializedChangeSet;
  readonly scratchDir: string;
}): Promise<ApprovedState> {
  const w = o.worktree;
  const root = w.root ?? '';
  const base = {
    worktree: root,
    gitDir: w.gitDir,
    paths: o.changeSet.entries.map((e) => ({ path: e.path, state: root === '' ? ({ kind: 'absent' } as PathState) : pathState(join(root, e.path)) })),
    parents: [
      ...new Set(
        o.changeSet.entries.flatMap((e) => {
          const out: string[] = [];
          for (let d = parentDir(e.path); d !== ''; d = parentDir(d)) out.push(d);
          return out;
        }),
      ),
    ]
      .sort()
      .map((p) => ({ path: p, kind: root === '' ? ('absent' as const) : lstatKind(join(root, p)) })),
  };
  const incomplete = (why: string): ApprovedState => ({
    ...base,
    head: null,
    branch: null,
    headTree: null,
    index: [],
    indexTree: null,
    skipWorktree: 0,
    assumeUnchanged: 0,
    sparseCheckout: false,
    dirty: [],
    unreadable: why,
  });
  if (w.root === null || w.prunable) return incomplete('the approved worktree has no directory');
  const sgit = o.git.withSandbox(o.view);
  const loc = worktreeLocators(o.view.record, w);
  let tmp: string | null = null;
  try {
    const h = await sgit.run(['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'], { cwd: root, locators: loc });
    const head = h.code === 0 ? gitOid(h.stdout.toString('utf8').trim()) : null;
    const b = await sgit.run(['symbolic-ref', '--quiet', 'HEAD'], { cwd: root, locators: loc });
    const branch = b.code === 0 ? b.stdout.toString('utf8').trim() : null;
    let headTree: GitOid | null = null;
    if (head !== null) headTree = gitOid((await sgit.ok(['rev-parse', '--verify', '--end-of-options', `${head}^{tree}`], { cwd: root, locators: loc })).stdout.toString('utf8').trim());
    const sp = await sgit.run(['config', '--bool', '--get', 'core.sparseCheckout'], { cwd: root, locators: loc });
    const sparseCheckout = sp.code === 0 && sp.stdout.toString('utf8').trim() === 'true';
    // The index is read and checked through a copy: the real one is never refreshed or rewritten by a check.
    tmp = mkdtempSync(join(o.scratchDir, 'idx-copy-'));
    const copy = join(tmp, 'index');
    const realIndex = join(w.gitDir, 'index');
    if (existsSync(realIndex) || lstatKind(realIndex) === 'other') {
      // Review r2 #1: an index that is a link (or anything but a regular file) is never followed.
      if (!lstatSync(realIndex).isFile()) return incomplete('the index is not a regular file (a link or something else): not judged, not landed into');
      copyFileSync(realIndex, copy);
    }
    const env = { GIT_INDEX_FILE: copy };
    const ls = await sgit.ok(['ls-files', '-s', '-v', '-z'], { cwd: root, locators: loc, env, maxOutputBytes: BIG });
    const entries = parseLsFiles(ls.stdout);
    const index = entries.map((e) => `${e.tag} ${e.mode} ${e.oid} ${e.stage}\t${e.path}`).sort();
    const skip = entries.filter((e) => e.tag === 'S' || e.tag === 's');
    const assume = entries.filter((e) => e.tag !== e.tag.toUpperCase());
    // Content, not git's word: clear both bits on the copy, then refresh it, then ask which paths differ.
    const flagged = [...new Set([...skip, ...assume].map((e) => e.path))];
    if (flagged.length > 0) {
      await sgit.ok(['update-index', '--no-skip-worktree', '--no-assume-unchanged', '-z', '--stdin'], { cwd: root, locators: loc, env, input: flagged.map((p) => `${p}\0`).join('') });
    }
    const attr = head !== null ? [`--attr-source=${head}`] : [];
    await sgit.ok([...attr, 'update-index', '-q', '--ignore-submodules', '--refresh'], { cwd: root, locators: loc, env, okCodes: [0, 1], maxOutputBytes: BIG });
    const df = await sgit.ok([...attr, 'diff-files', '--name-only', '-z', '--no-ext-diff', '--ignore-submodules'], { cwd: root, locators: loc, env, maxOutputBytes: BIG });
    const dirty = [...new Set(df.stdout.toString('utf8').split('\0').filter((p) => p !== ''))].sort();
    return {
      ...base,
      head,
      branch,
      headTree,
      index,
      indexTree: indexTree(o.view.record.objectFormat, entries),
      skipWorktree: skip.length,
      assumeUnchanged: assume.length,
      sparseCheckout,
      dirty,
      unreadable: null,
    };
  } catch (e) {
    const message = (e as Error).message;
    const stderr = (e as { stderr?: Buffer }).stderr?.toString('utf8') ?? '';
    const out = incomplete(`the approved worktree could not be read: ${message}`);
    return /pointer extensions are not supported/.test(`${message}\n${stderr}`) ? { ...out, unsupportedLfs: true } : out;
  } finally {
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export type RetryState = 'untouched' | 'coherent';

/** v45-v47: the approved worktree is safe to retry if it is, as a whole, in one of two states. */
export function safeToRetry(pre: ApprovedState, post: ApprovedState, delivery: GitOid): { readonly state: RetryState | null; readonly why: string } {
  if (pre.unreadable !== null) return { state: null, why: `the record before the landing is incomplete: ${pre.unreadable}` };
  if (post.unreadable !== null) return { state: null, why: post.unreadable };
  const pathsSame = sameList(
    pre.paths.map((p) => `${p.path}\0${JSON.stringify(p.state)}`),
    post.paths.map((p) => `${p.path}\0${JSON.stringify(p.state)}`),
  );
  const parentsSame = sameList(
    pre.parents.map((p) => `${p.path}\0${p.kind}`),
    post.parents.map((p) => `${p.path}\0${p.kind}`),
  );
  const indexSame = sameList(pre.index, post.index);
  const dirtySame = sameList(pre.dirty, post.dirty);
  if (indexSame && pathsSame && parentsSame && dirtySame) {
    return { state: 'untouched', why: 'every index entry (with its flags), every change-set path and its directories, and the set of modified tracked paths are as recorded' };
  }
  const hidden = hasHiddenEntries(pre) || hasHiddenEntries(post);
  if (!hidden && post.headTree !== null && post.indexTree === post.headTree && post.dirty.length === 0 && post.head !== delivery) {
    return { state: 'coherent', why: `the worktree is coherent with its current HEAD ${post.head ?? '?'}` };
  }
  const why: string[] = [];
  if (!indexSame) why.push('index entries changed');
  if (!pathsSame || !parentsSame) why.push('change-set paths or their directories changed');
  if (!dirtySame) why.push('the set of modified tracked paths changed');
  if (hidden) why.push('it has skip-worktree or assume-unchanged entries or sparse checkout, so only "untouched" counts');
  else {
    if (post.indexTree !== post.headTree) why.push('the index is not its HEAD tree');
    if (post.dirty.length > 0) why.push(`${post.dirty.length} tracked path(s) differ from the index`);
    if (post.head === delivery) why.push('HEAD is the delivery commit');
  }
  return { state: null, why: `neither untouched nor coherent with its HEAD: ${why.join('; ')}` };
}

/** v42-v47: the classes of a landing that entered the push stage. */
export type LandingOutcome = 'landed' | 'B' | 'base-moved' | 'C';

export interface ResultInput {
  /** The target branch now (null: unreadable or absent). */
  readonly targetAfter: GitOid | null;
  /** The target branch contains the delivery commit. */
  readonly landed: boolean;
  /** v49: whether it does could not be confirmed (a shallow boundary or a missing commit). */
  readonly historyUnconfirmed?: boolean;
  readonly base: GitOid;
  readonly delivery: GitOid;
  readonly binding: 'zero' | 'one';
  /** One occupancy: the approved worktree before and after. */
  readonly approvedBefore: ApprovedState | null;
  readonly approvedAfter: ApprovedState | null;
  /** Locks this landing could have left: the target ref's, and (one occupancy) the approved worktree's index.lock. */
  readonly locks: readonly string[];
}

export interface ResultClass {
  readonly outcome: LandingOutcome;
  /** B: a new landing attempt; base moved: a rebuild on the new base (WI-05); after-lock: a new attempt once the locks are gone. */
  readonly next: 'new-attempt' | 'rebuild' | 'after-lock' | null;
  readonly why: string;
  /** For a C caused only by leftover locks: what the class would be without them. */
  readonly withoutLocks: LandingOutcome | null;
}

function judge(i: ResultInput): { outcome: LandingOutcome; next: 'new-attempt' | 'rebuild' | null; why: string } {
  const moved = (): { outcome: LandingOutcome; next: 'new-attempt' | 'rebuild' | null; why: string } =>
    i.targetAfter === i.base
      ? { outcome: 'B', next: 'new-attempt', why: 'the target branch is still at the base' }
      : i.targetAfter !== null
        ? { outcome: 'base-moved', next: 'rebuild', why: `someone else moved the target branch to ${i.targetAfter}, which does not contain the delivery` }
        : { outcome: 'C', next: null, why: 'the target branch cannot be read' };
  if (i.binding === 'zero') {
    const m = moved();
    return { ...m, why: `zero occupancy (the receiver never writes a worktree): ${m.why}` };
  }
  if (i.approvedBefore === null || i.approvedAfter === null) return { outcome: 'C', next: null, why: 'the approved worktree has no complete record' };
  const s = safeToRetry(i.approvedBefore, i.approvedAfter, i.delivery);
  if (s.state === null) return { outcome: 'C', next: null, why: s.why };
  const m = moved();
  return { ...m, why: `${s.why}; ${m.why}` };
}

/** The fixed order of 6.6 "落地的结果" (v44-v47). */
export function classifyLandingOutcome(i: ResultInput): ResultClass {
  if (i.landed) return { outcome: 'landed', next: null, why: 'the target branch contains the delivery commit', withoutLocks: null };
  // v49: "cannot confirm" is never "not landed, safe to retry".
  if (i.historyUnconfirmed === true) {
    return { outcome: 'C', next: null, why: 'whether the target branch contains the delivery commit cannot be confirmed (a shallow boundary or a missing commit)', withoutLocks: null };
  }
  const rest = judge(i);
  if (i.locks.length > 0) {
    // Only the locks are wrong: once their owner has finished or cleaned them, a new attempt may start (WI-06 option 5).
    const onlyLocks = rest.outcome === 'B' || rest.outcome === 'base-moved';
    return {
      outcome: 'C',
      next: onlyLocks ? 'after-lock' : null,
      why: `a lock was left behind (${i.locks.join(', ')}); the program never deletes it${onlyLocks ? '' : `; besides: ${rest.why}`}`,
      withoutLocks: rest.outcome,
    };
  }
  return { ...rest, withoutLocks: null };
}
