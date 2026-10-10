// The pre-dispatch Git LFS check (design 7.1 v34; WI-13): a task whose snapshot needs Git LFS
// objects that are not in the local store is not dispatched; the program never downloads them
// (no network, no credentials). The task is held and rechecked on every pass, so it runs once
// the user has run `git lfs fetch`; everything else continues.

import type { GitOid } from '../common/ids.ts';
import { checkLfsObjectsPresent, type AttributeEvaluator } from '../git/representation.ts';
import type { RepoLayout } from '../git/objects.ts';
import type { SafeGit } from '../git/safeGit.ts';
import type { LfsVerdict } from './scheduler.ts';
import type { TaskSpec } from './tasks.ts';

/** An lfsCheck for SchedulerDeps over one repository (git/representation.ts checkLfsObjectsPresent). */
export function gitLfsCheck(o: { readonly git: SafeGit; readonly repo: RepoLayout; readonly attributes: AttributeEvaluator }): (task: TaskSpec) => Promise<LfsVerdict> {
  return async (task) => {
    if (task.snapshot === undefined) return { ok: true, hint: null };
    const r = await checkLfsObjectsPresent({ git: o.git, repo: o.repo, commit: task.snapshot.commit as GitOid, attributes: o.attributes });
    return { ok: r.ok, hint: r.hint };
  };
}
