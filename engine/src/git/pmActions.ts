// Git actions the PM starts from the CLI (design 3.11). The CLI wiring lives
// outside this module; each action here is one safe-wrapper operation with its
// own checks before and after.
//
// WI-01 option 2 (v43): an abandoned duplicate checkout of the target branch
// (one of "many") stops occupying it by having its HEAD detached at the same
// commit. Index and files, uncommitted changes, untracked and ignored files are
// all unchanged and nothing is deleted; `git switch <branch>` undoes it. The
// program and the PM never remove a worktree and never delete a file.
//
// The design names `git switch --detach`. The program does the same thing more
// narrowly: `git update-ref --no-deref HEAD <commit> <commit>` with the
// worktree's own explicit locators (no discovery), hooks off (SafeGit). It
// writes HEAD and its reflog only: it never reads or writes the index or a file,
// so no filter of any configuration runs (switch would refresh the index). git
// holds HEAD's lock during the update, and the old-value check makes it refuse
// if HEAD no longer resolves to the checked commit.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { GitOid } from '../common/ids.ts';
import { shellQuote } from './landingView.ts';
import { discoverRepo, gitOid } from './objects.ts';
import type { SafeGit } from './safeGit.ts';
import { occupies, registeredWorktrees } from './worktreeRecord.ts';

export type DetachResult =
  | {
      readonly kind: 'detached';
      readonly worktree: string;
      /** The branch it no longer occupies (full ref name). */
      readonly branch: string;
      /** HEAD is detached at this commit, the one it had. */
      readonly commit: GitOid;
      /** How its owner takes the branch back. */
      readonly undo: string;
    }
  | { readonly kind: 'refused'; readonly reason: string };

function indexHash(gitDir: string): string | null {
  const p = join(gitDir, 'index');
  return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null;
}

/**
 * WI-01 option 2: detach `worktree`, one of several checkouts of `targetBranch`.
 * Refused unless the worktree is registered, present, has the branch checked out
 * with no rebase or bisect in progress, and at least one OTHER registered
 * worktree also holds the branch (the option exists only for "many").
 */
export async function detachDuplicateCheckout(git: SafeGit, o: { readonly repoPath: string; readonly worktree: string; readonly targetBranch: string }): Promise<DetachResult> {
  const targetRef = `refs/heads/${o.targetBranch}`;
  const repo = await discoverRepo(git, o.repoPath);
  const commonDir = repo.commonDir;
  let root: string;
  try {
    root = realpathSync(o.worktree);
  } catch {
    return { kind: 'refused', reason: `${o.worktree} does not exist` };
  }
  const all = await registeredWorktrees(git.withLocators({ gitDir: commonDir }), commonDir);
  const w = all.find((x) => !x.bare && x.path === root);
  if (w === undefined || w.gitDir === null) return { kind: 'refused', reason: `${root} is not a registered worktree of ${commonDir}` };
  if (w.prunable) return { kind: 'refused', reason: `the directory of ${root} is missing` };
  if (w.occupancy.inProgress) return { kind: 'refused', reason: `${root} has a rebase or bisect in progress: its owner finishes it first (WI-01 option 4)` };
  if (w.occupancy.branch !== targetRef) return { kind: 'refused', reason: `${root} does not have ${targetRef} checked out (HEAD: ${w.occupancy.branch ?? 'detached'})` };
  const others = all.filter((x) => x !== w && occupies(x.occupancy, targetRef));
  if (others.length === 0) return { kind: 'refused', reason: `${root} is the only worktree holding ${targetRef}: not a duplicate (WI-01 option 2 applies to "many" only)` };

  const loc = { gitDir: w.gitDir, commonDir, workTree: root };
  const head = await git.run(['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'], { cwd: root, locators: loc });
  if (head.code !== 0) return { kind: 'refused', reason: `HEAD of ${root} does not name a commit` };
  const commit = gitOid(head.stdout.toString('utf8').trim());
  const sym = await git.run(['symbolic-ref', '--quiet', 'HEAD'], { cwd: root, locators: loc });
  if (sym.code !== 0 || sym.stdout.toString('utf8').trim() !== targetRef) return { kind: 'refused', reason: `HEAD of ${root} changed while checking` };
  const indexBefore = indexHash(w.gitDir);
  const r = await git.run(['update-ref', '--no-deref', '-m', `mission-pipeline: WI-01 detach a duplicate checkout of ${o.targetBranch}`, 'HEAD', commit, commit], { cwd: root, locators: loc });
  if (r.code !== 0) return { kind: 'refused', reason: `git refused to detach HEAD: ${r.stderr.toString('utf8').trim()}` };
  // After: HEAD detached at the same commit; the index untouched (byte for byte).
  const after = await git.run(['symbolic-ref', '--quiet', 'HEAD'], { cwd: root, locators: loc });
  const now = await git.run(['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'], { cwd: root, locators: loc });
  if (after.code === 0 || now.stdout.toString('utf8').trim() !== commit) return { kind: 'refused', reason: `HEAD of ${root} is not detached at ${commit} after the update` };
  if (indexHash(w.gitDir) !== indexBefore) return { kind: 'refused', reason: `the index of ${root} changed meanwhile (not by this action)` };
  return { kind: 'detached', worktree: root, branch: targetRef, commit, undo: `git -C ${shellQuote(root)} switch ${shellQuote(o.targetBranch)}` };
}
