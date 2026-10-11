// Worktree reads (design 4.1 §6.7; 4.0 6.6 v38, v40, v41): every registered
// worktree of the repository, found through the common git dir, for the three
// layouts alike (a main worktree; a linked worktree; a bare common repository
// with linked worktrees), with the branch each one occupies (checked out, or
// held by a paused rebase or bisect). Landing (land.ts), the PM actions
// (pmActions.ts), the external-worktree check and the workspaces read them.
// Pure reads.
//
// Locators (6.6 v38): a repository-level command names only the common dir.
// Nothing is ever discovered from a `.git` file or the current directory.

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { GitOid } from '../common/ids.ts';
import { gitOid } from './objects.ts';
import type { GitExec } from './plainGit.ts';

export interface DirIdentity {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
}

/**
 * Which branch a worktree occupies (6.6 v40, v41): its HEAD, and the branch a
 * paused rebase or bisect started from. git still treats that branch as in use
 * by the worktree although HEAD is detached: moving it would destroy the rebase
 * or bisect in progress.
 */
export interface Occupancy {
  /** Full ref name HEAD points to; null when detached or bare. */
  readonly branch: string | null;
  /** `rebase-merge/head-name` or `rebase-apply/head-name` (a full ref); null when none. */
  readonly rebasing: string | null;
  /** The branch in `BISECT_START`, as a full ref; null when none or started from a detached HEAD. */
  readonly bisecting: string | null;
  /** A rebase, am or bisect is in progress in this worktree. */
  readonly inProgress: boolean;
}

function readText(path: string): string | null {
  const b = readBytes(path);
  return b === null ? null : b.toString('utf8').trim();
}

/** git's wt_status_check_rebase / wt_status_check_bisect, read from the worktree's git dir. */
export function readOccupancy(gitDir: string, branch: string | null): Occupancy {
  const asRef = (s: string | null): string | null => {
    if (s === null || s === '' || /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s)) return null;
    return s.startsWith('refs/') ? s : `refs/heads/${s}`;
  };
  const rebaseApply = existsSync(join(gitDir, 'rebase-apply'));
  const rebaseMerge = existsSync(join(gitDir, 'rebase-merge'));
  const rebasing = rebaseApply
    ? existsSync(join(gitDir, 'rebase-apply', 'applying'))
      ? null // `git am`, not a rebase: no branch is held
      : asRef(readText(join(gitDir, 'rebase-apply', 'head-name')))
    : rebaseMerge
      ? asRef(readText(join(gitDir, 'rebase-merge', 'head-name')))
      : null;
  const bisectLog = existsSync(join(gitDir, 'BISECT_LOG'));
  const bisectStart = readText(join(gitDir, 'BISECT_START'));
  const bisecting = bisectLog || bisectStart !== null ? asRef(bisectStart) : null;
  return { branch, rebasing, bisecting, inProgress: rebaseApply || rebaseMerge || bisectLog || bisectStart !== null };
}

/** Does this worktree hold `targetRef` (checked out, or being rebased or bisected from it)? */
export function occupies(o: Occupancy, targetRef: string): boolean {
  return o.branch === targetRef || o.rebasing === targetRef || o.bisecting === targetRef;
}

function identityOf(path: string): DirIdentity | null {
  try {
    const st = lstatSync(path, { bigint: true });
    if (!st.isDirectory()) return null;
    return { path, dev: String(st.dev), ino: String(st.ino) };
  } catch {
    return null;
  }
}

function readBytes(path: string): Buffer | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Where a linked git dir's `gitdir` file says the root is (git's get_linked_worktree: strip "/.git"; relative to the git dir). */
export function rootFromGitdirFile(gitDir: string, content: Buffer): string {
  let s = content.toString('utf8').replace(/\s+$/, '');
  if (!isAbsolute(s)) s = resolve(gitDir, s);
  return s.endsWith('/.git') ? s.slice(0, -'/.git'.length) : s;
}

export interface ListedWorktree {
  readonly path: string;
  readonly head: GitOid | null;
  readonly branch: string | null;
  readonly bare: boolean;
  readonly prunable: boolean;
}

/** `git worktree list --porcelain -z` naming the common dir explicitly. */
export async function listWorktreesAt(git: GitExec, commonDir: string): Promise<ListedWorktree[]> {
  const r = await git.ok(['worktree', 'list', '--porcelain', '-z'], { cwd: commonDir, locators: { gitDir: commonDir } });
  const out: ListedWorktree[] = [];
  let cur: { path: string; head: GitOid | null; branch: string | null; bare: boolean; prunable: boolean } | null = null;
  const flush = (): void => {
    if (cur !== null) out.push(cur);
    cur = null;
  };
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    if (rec === '') {
      flush();
      continue;
    }
    const sp = rec.indexOf(' ');
    const key = sp < 0 ? rec : rec.slice(0, sp);
    const val = sp < 0 ? '' : rec.slice(sp + 1);
    if (key === 'worktree') {
      flush();
      cur = { path: val, head: null, branch: null, bare: false, prunable: false };
    } else if (cur !== null) {
      if (key === 'HEAD') cur.head = /^0+$/.test(val) ? null : gitOid(val);
      else if (key === 'branch') cur.branch = val;
      else if (key === 'bare') cur.bare = true;
      else if (key === 'prunable') cur.prunable = true;
    }
  }
  flush();
  return out;
}

/** Every linked git dir under `<common>/worktrees` with the root its `gitdir` file names. */
export function linkedGitDirs(commonDir: string): { gitDir: string; root: string; gitdirFile: Buffer }[] {
  const base = join(commonDir, 'worktrees');
  if (!existsSync(base)) return [];
  const out: { gitDir: string; root: string; gitdirFile: Buffer }[] = [];
  for (const id of readdirSync(base).sort()) {
    const d = join(base, id);
    if (identityOf(d) === null) continue;
    const content = readBytes(join(d, 'gitdir'));
    if (content === null || content.length === 0) continue; // git does not list it either
    out.push({ gitDir: d, root: rootFromGitdirFile(d, content), gitdirFile: content });
  }
  return out;
}

/** A worktree as it is registered now (pure reads). */
export interface RegisteredWorktree extends ListedWorktree {
  /** Its git dir: the common dir for the main worktree and a bare repository; null when no linked git dir names it. */
  readonly gitDir: string | null;
  readonly gitDirIdentity: DirIdentity | null;
  readonly occupancy: Occupancy;
}

/** All registered worktrees, as git lists them, each with its git dir and the branch it occupies. */
export async function registeredWorktrees(git: GitExec, commonDir: string): Promise<RegisteredWorktree[]> {
  const listed = await listWorktreesAt(git, commonDir);
  const byRoot = new Map(linkedGitDirs(commonDir).map((l) => [l.root, l] as const));
  return listed.map((w, i) => {
    if (i === 0) return { ...w, gitDir: commonDir, gitDirIdentity: identityOf(commonDir), occupancy: readOccupancy(commonDir, w.branch) };
    const l = byRoot.get(w.path);
    const occupancy = l === undefined ? { branch: w.branch, rebasing: null, bisecting: null, inProgress: false } : readOccupancy(l.gitDir, w.branch);
    return { ...w, gitDir: l?.gitDir ?? null, gitDirIdentity: l === undefined ? null : identityOf(l.gitDir), occupancy };
  });
}
