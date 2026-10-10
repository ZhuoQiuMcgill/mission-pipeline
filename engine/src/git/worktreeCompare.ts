// A worktree compared with a delivery (design 6.6 "新增工作区与共享分支", v36-v40;
// the verification's fourth class, v40; WI-04, 3.11).
//
// A worktree can be left behind by a landing without being updated: its HEAD
// follows the shared branch ref to the delivery commit B while its index and
// files are still the base A (risks 26 and 27). This module reads one worktree
// (its HEAD, its index, and its files on the delivered paths) and classifies it:
// - consistent: index and files agree with HEAD (files compared on the
//   delivered paths, the only ones a landing writes);
// - branch-advanced-files-stale: HEAD is B (on the target branch or any other
//   branch made from it), the index is exactly A's tree and the files on the
//   delivered paths are A's;
// - suspected-reverse-change: index or files differ from HEAD only on delivered
//   paths, and exactly by undoing the delivery there (A's version where HEAD has B's);
// - cannot-determine: anything else, with both commits and the differing paths.
// Reading is pure: plumbing that runs no filter (rev-parse, symbolic-ref,
// ls-files, ls-tree, cat-file) with the worktree's own locators, and file bytes
// compared with the program's own materialization (7.1), never with git's clean
// filter. The recovery command is offered only by the caller, after a re-check
// that finds the exact branch-advanced-files-stale state (v38).

import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { GitOid } from '../common/ids.ts';
import type { ChangeSetEntry, MaterializedChangeSet, MaterializedSide } from './changeSet.ts';
import { parseLsFilesDebug } from './externalWorktrees.ts';
import { gitOid, indexTree, lsTree, parseLsFiles, readObjects, type RepoLayout } from './objects.ts';
import { resolveConversion, sha256File, toWorktree, type AttributeEvaluator, type PathConversion, type TransformDescription } from './representation.ts';
import type { GitLocators, SafeGit } from './safeGit.ts';
import { shellQuote } from './landingView.ts';

export type DeliveryRelation = 'consistent' | 'branch-advanced-files-stale' | 'suspected-reverse-change' | 'cannot-determine';

export interface WorktreeComparison {
  readonly relation: DeliveryRelation;
  readonly branch: string | null;
  readonly head: GitOid | null;
  /** Paths where the index or the files differ from HEAD (sorted). */
  readonly differing: readonly string[];
  readonly detail: string;
}

export interface CompareContext {
  /** Plumbing on the repository (refs, objects): names the common dir. */
  readonly git: SafeGit;
  readonly repo: RepoLayout;
  readonly description: TransformDescription;
  readonly changeSet: MaterializedChangeSet;
  readonly baseTree: GitOid;
  /** For HEAD versions that are neither the base's nor the delivery's (attributes as of HEAD's tree). */
  readonly attributes: AttributeEvaluator;
}

interface Entry {
  readonly mode: string;
  readonly oid: GitOid;
}

/** Does the file at `abs` hold what `side` materializes to (bytes, symlink, exec bit, LFS object)? `side` null: absent. */
export function fileMatchesSide(description: TransformDescription, abs: string, side: { mode: string; oid: GitOid; conversion: PathConversion | null } | null, blob: Buffer | null): boolean {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return side === null;
  }
  if (side === null) return false;
  if (side.mode === '160000') return st.isDirectory(); // a gitlink: only its presence is ours to check
  if (blob === null) return false;
  if (side.mode === '120000') {
    if (description.symlinks) return st.isSymbolicLink() && readlinkSync(abs, { encoding: 'buffer' }).equals(blob);
    return st.isFile() && readFileSync(abs).equals(blob);
  }
  if (!st.isFile()) return false;
  if (description.fileMode && ((st.mode & 0o100) !== 0) !== (side.mode === '100755')) return false;
  if (side.conversion === null) return readFileSync(abs).equals(blob);
  const w = toWorktree(blob, side.conversion, side.oid);
  if (w.kind === 'bytes') return readFileSync(abs).equals(w.data);
  if (w.kind === 'lfs-object') {
    const f = sha256File(abs);
    return f.size === w.pointer.size && f.sha256 === w.pointer.oid;
  }
  return false; // unsupported: cannot be shown equal
}

function sideEntry(s: MaterializedSide | null): Entry | null {
  return s === null ? null : { mode: s.mode, oid: s.oid };
}

function sameEntry(a: Entry | null | undefined, b: Entry | null | undefined): boolean {
  if (a === undefined || a === null) return b === undefined || b === null;
  if (b === undefined || b === null) return false;
  return a.mode === b.mode && a.oid === b.oid;
}

async function readHead(git: SafeGit, loc: GitLocators, cwd: string): Promise<{ head: GitOid | null; branch: string | null }> {
  const h = await git.run(['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'], { cwd, locators: loc });
  const b = await git.run(['symbolic-ref', '--quiet', 'HEAD'], { cwd, locators: loc });
  return {
    head: h.code === 0 ? gitOid(h.stdout.toString('utf8').trim()) : null,
    branch: b.code === 0 ? b.stdout.toString('utf8').trim() : null,
  };
}

/** HEAD, branch and index of one worktree, named by its locators (no discovery). */
export async function readWorktreeHeadAndIndex(
  git: SafeGit,
  repo: RepoLayout,
  loc: GitLocators,
  cwd: string,
): Promise<{ head: GitOid | null; branch: string | null; index: Map<string, Entry>; indexTree: GitOid | null; skipWorktree: Set<string>; hidden: Set<string> }> {
  const { head, branch } = await readHead(git, loc, cwd);
  // Review r2 #1: an index that is a link is never read through (it could be another worktree's).
  let ist;
  try {
    ist = lstatSync(join(loc.gitDir, 'index'));
  } catch {
    ist = null;
  }
  if (ist !== null && !ist.isFile()) throw new Error(`the index of ${cwd} is not a regular file (a link or something else)`);
  // -v: lowercase tags mark assume-unchanged entries, 'S'/'s' skip-worktree ones.
  const r = await git.ok(['ls-files', '-s', '-v', '-z'], { cwd, locators: loc, maxOutputBytes: 1024 * 1024 * 1024 });
  const entries = parseLsFiles(r.stdout);
  const index = new Map<string, Entry>();
  const skipWorktree = new Set<string>();
  const hidden = new Set<string>();
  for (const e of entries) {
    if (e.tag === 'S' || e.tag === 's') skipWorktree.add(e.path);
    if (e.tag === 'S' || e.tag !== e.tag.toUpperCase()) hidden.add(e.path);
    if (e.stage === 0 && e.mode !== '040000') index.set(e.path, { mode: e.mode, oid: e.oid });
  }
  return { head, branch, index, indexTree: indexTree(repo.objectFormat, entries), skipWorktree, hidden };
}

/** Does the file's type (and, when the bound description keeps it, its executable bit) match the index mode? */
function modeMatches(description: TransformDescription, mode: string, st: { isFile(): boolean; isSymbolicLink(): boolean; mode: bigint | number }): boolean {
  if (mode === '120000') return description.symlinks ? st.isSymbolicLink() : st.isFile();
  if (!st.isFile()) return false;
  if (!description.fileMode) return true;
  return ((Number(st.mode) & 0o100) !== 0) === (mode === '100755');
}

/**
 * Review r2 #5: every tracked file, not only the change set, against the index,
 * on content and never through a filter of the repository's configuration. The
 * index's stat data says "unchanged" only when it matches and is not racy (the
 * file is older than the index); otherwise the index blob is materialized with
 * `attrTree`'s attributes and the bound description, and compared byte for
 * byte. Gitlinks are never entered. skip-worktree and assume-unchanged entries
 * are "hidden": their content is not taken on git's word, so nothing whole can
 * be claimed about such a worktree.
 */
async function filesAgainstIndex(
  ctx: CompareContext,
  wgit: SafeGit,
  loc: GitLocators,
  root: string,
  index: ReadonlyMap<string, Entry>,
  hiddenSet: ReadonlySet<string>,
  skip: ReadonlySet<string>,
  attrTree: GitOid,
): Promise<{ differing: string[]; hidden: string[] }> {
  const dbg = await wgit.ok(['ls-files', '--debug', '-z'], { cwd: root, locators: loc, maxOutputBytes: 1024 * 1024 * 1024 });
  const stat = new Map(parseLsFilesDebug(dbg.stdout).map((e) => [e.path, e] as const));
  let indexMtimeNs: bigint | null = null;
  try {
    indexMtimeNs = lstatSync(join(loc.gitDir, 'index'), { bigint: true }).mtimeNs;
  } catch {
    indexMtimeNs = null;
  }
  const differing: string[] = [];
  const hidden: string[] = [];
  const toCompare: { path: string; e: Entry }[] = [];
  for (const [p, e] of index) {
    if (skip.has(p) || e.mode === '160000') continue;
    if (hiddenSet.has(p)) {
      hidden.push(p);
      continue;
    }
    let st;
    try {
      st = lstatSync(join(root, p), { bigint: true });
    } catch {
      differing.push(p);
      continue;
    }
    const d = stat.get(p);
    const statClean =
      d !== undefined &&
      st.size === d.size &&
      st.ino === d.ino &&
      st.mtimeNs / 1_000_000_000n === d.mtimeSec &&
      (d.mtimeNsec === 0n || st.mtimeNs % 1_000_000_000n === d.mtimeNsec) &&
      indexMtimeNs !== null &&
      st.mtimeNs < indexMtimeNs;
    if (statClean && modeMatches(ctx.description, e.mode, st)) continue;
    toCompare.push({ path: p, e });
  }
  if (toCompare.length > 0) {
    const regular = toCompare.filter((t) => t.e.mode !== '120000').map((t) => t.path);
    const attrs = regular.length > 0 ? await ctx.attributes.atTree(attrTree, regular) : new Map();
    const byOid = new Map<GitOid, { path: string; e: Entry }[]>();
    for (const t of toCompare) {
      const list = byOid.get(t.e.oid);
      if (list === undefined) byOid.set(t.e.oid, [t]);
      else list.push(t);
    }
    await readObjects(ctx.git, ctx.repo, [...byOid.keys()], (oid, _t, blob) => {
      for (const t of byOid.get(oid) ?? []) {
        const conversion = t.e.mode === '120000' ? null : resolveConversion(attrs.get(t.path) as Parameters<typeof resolveConversion>[0], ctx.description);
        if (!fileMatchesSide(ctx.description, join(root, t.path), { mode: t.e.mode, oid, conversion }, blob)) differing.push(t.path);
      }
    });
  }
  return { differing: differing.sort(), hidden: hidden.sort() };
}

/**
 * Compares one worktree with the delivery. `loc` and `root` name the worktree;
 * `ctx.git` reads the repository's objects.
 */
export async function compareWorktreeWithDelivery(ctx: CompareContext, wgit: SafeGit, loc: GitLocators, root: string): Promise<WorktreeComparison> {
  const { changeSet } = ctx;
  const B = changeSet.delivery;
  const A = changeSet.base;
  let st;
  try {
    st = await readWorktreeHeadAndIndex(wgit, ctx.repo, loc, root);
  } catch (e) {
    return { relation: 'cannot-determine', branch: null, head: null, differing: [], detail: `the worktree could not be read: ${(e as Error).message}` };
  }
  const { head, branch, index } = st;
  if (head === null) return { relation: 'cannot-determine', branch, head, differing: [], detail: 'HEAD does not name a commit (unborn or unreadable)' };
  if (st.indexTree === null) return { relation: 'cannot-determine', branch, head, differing: [], detail: 'the index has unmerged entries' };

  // HEAD's entries: the delivered paths always; the whole tree only when the index differs from it.
  const headTreeR = await ctx.git.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${head}^{tree}`], {
    cwd: ctx.repo.commonDir,
    locators: { gitDir: ctx.repo.commonDir },
  });
  const headTree = headTreeR.code === 0 ? gitOid(headTreeR.stdout.toString('utf8').trim()) : null;
  if (headTree === null) return { relation: 'cannot-determine', branch, head, differing: [], detail: `the tree of ${head} cannot be read` };
  const headEntries = new Map<string, Entry>();
  for (const e of await lsTree(ctx.git, ctx.repo, headTree, { recursive: true })) headEntries.set(e.path, { mode: e.mode, oid: e.oid });

  // Index against HEAD.
  const differing = new Set<string>();
  if (st.indexTree !== headTree) {
    for (const [p, e] of index) if (!sameEntry(e, headEntries.get(p))) differing.add(p);
    for (const p of headEntries.keys()) if (!index.has(p)) differing.add(p);
  }

  // Files on the delivered paths, against A, B and HEAD's version.
  const D = changeSet.entries;
  const blobs = new Map<GitOid, Buffer>();
  const want = new Set<GitOid>();
  for (const e of D) {
    if (e.before !== null && e.before.kind !== 'gitlink') want.add(e.before.oid);
    if (e.after !== null && e.after.kind !== 'gitlink') want.add(e.after.oid);
  }
  // HEAD versions that are neither A's nor B's: materialize them with HEAD's own attributes.
  const other: { e: ChangeSetEntry; h: Entry }[] = [];
  for (const e of D) {
    const h = headEntries.get(e.path) ?? null;
    if (h !== null && !sameEntry(h, sideEntry(e.before)) && !sameEntry(h, sideEntry(e.after))) {
      other.push({ e, h });
      if (h.mode !== '160000') want.add(h.oid);
    }
  }
  await readObjects(ctx.git, ctx.repo, [...want], (oid, _t, content) => {
    blobs.set(oid, content);
  });
  const otherConv = new Map<string, PathConversion>();
  if (other.length > 0) {
    const attrs = await ctx.attributes.atTree(headTree, other.map((o) => o.e.path));
    for (const o of other) otherConv.set(o.e.path, resolveConversion(attrs.get(o.e.path) as Parameters<typeof resolveConversion>[0], ctx.description));
  }
  const matches = (abs: string, s: MaterializedSide | null): boolean =>
    fileMatchesSide(ctx.description, abs, s === null ? null : { mode: s.mode, oid: s.oid, conversion: s.conversion }, s === null || s.kind === 'gitlink' ? null : (blobs.get(s.oid) ?? null));
  const fileIsA = new Map<string, boolean>();
  for (const e of D) {
    const abs = join(root, e.path);
    const isA = matches(abs, e.before);
    fileIsA.set(e.path, isA);
    const h = headEntries.get(e.path) ?? null;
    let matchesHead: boolean;
    if (sameEntry(h, sideEntry(e.before))) matchesHead = isA;
    else if (sameEntry(h, sideEntry(e.after))) matchesHead = matches(abs, e.after);
    else if (h === null) matchesHead = fileMatchesSide(ctx.description, abs, null, null);
    else matchesHead = fileMatchesSide(ctx.description, abs, { mode: h.mode, oid: h.oid, conversion: otherConv.get(e.path) ?? null }, blobs.get(h.oid) ?? null);
    if (!matchesHead) differing.add(e.path);
  }
  // Review r2 #5: the worktree as a whole, not only the delivered paths.
  const attrTree = st.indexTree === ctx.baseTree ? ctx.baseTree : headTree;
  let whole: { differing: string[]; hidden: string[] };
  try {
    whole = await filesAgainstIndex(ctx, wgit, loc, root, index, st.hidden, new Set(D.map((e) => e.path)), attrTree);
  } catch (e) {
    return { relation: 'cannot-determine', branch, head, differing: [...differing].sort(), detail: `the files could not be compared with the index: ${(e as Error).message}` };
  }
  for (const p of whole.differing) differing.add(p);
  const diff = [...differing].sort();
  if (whole.hidden.length > 0) {
    return {
      relation: 'cannot-determine',
      branch,
      head,
      differing: diff,
      detail: `${whole.hidden.length} skip-worktree or assume-unchanged entr${whole.hidden.length === 1 ? 'y' : 'ies'}: their content cannot be confirmed, so nothing is claimed about the worktree as a whole`,
    };
  }

  if (diff.length === 0) return { relation: 'consistent', branch, head, differing: diff, detail: 'index and files agree with HEAD' };
  const allA = D.every((e) => fileIsA.get(e.path) === true);
  if (head === B && st.indexTree === ctx.baseTree && allA && whole.differing.length === 0) {
    return {
      relation: 'branch-advanced-files-stale',
      branch,
      head,
      differing: diff,
      detail: `HEAD (${branch ?? 'detached'}) is the delivery commit ${B}, but the index and files are still the base ${A}`,
    };
  }
  const delivered = new Map(D.map((e) => [e.path, e] as const));
  const reverse = whole.differing.length === 0 && diff.every((p) => {
    const e = delivered.get(p);
    if (e === undefined) return false;
    return sameEntry(headEntries.get(p) ?? null, sideEntry(e.after)) && sameEntry(index.get(p) ?? null, sideEntry(e.before)) && fileIsA.get(p) === true;
  });
  if (reverse) {
    return {
      relation: 'suspected-reverse-change',
      branch,
      head,
      differing: diff,
      detail: `the index and files differ from HEAD ${head} exactly by undoing the delivery on ${diff.length} delivered path(s)`,
    };
  }
  return {
    relation: 'cannot-determine',
    branch,
    head,
    differing: diff,
    detail: `HEAD ${head} (${branch ?? 'detached'}), delivery ${B}: the index or files differ from HEAD on ${diff.length} path(s) in a way the program cannot attribute`,
  };
}

/**
 * 6.6 v38, v47: the recovery command, offered only when a fresh re-check finds
 * HEAD = B and index = files = A. The delivery's attributes, sparse checkout off
 * and no submodule recursion (v47), and no replace objects (v48: a replace ref
 * would make it write content that was never delivered).
 */
export function staleFilesRecoveryCommand(root: string, base: GitOid, delivery: GitOid): string {
  return `git -C ${shellQuote(root)} --attr-source=${delivery} -c core.sparseCheckout=false -c submodule.recurse=false -c core.useReplaceRefs=false read-tree -u -m ${base} ${delivery}`;
}

export const STALE_RECOVERY_NOTE =
  'It brings the index and files from the base to the delivery commit and keeps local changes that do not conflict; ' +
  'if local changes conflict it refuses and changes nothing, and the worktree must then be merged by hand.';

