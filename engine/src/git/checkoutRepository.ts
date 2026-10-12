// The repository of a run checkout (design 4.1 §5.3; Appendix G).
//
// A run checkout (a verification run's `tmp/<run>/`, a rerun's, a renewal's, the run directory of a
// delivery candidate's closing checks) is materialized from the candidate's objects alone
// (representation.ts) inside the project's work tree, under `.mission-pipeline/`, which `mp init`
// excludes. Without a repository of its own, every git question a declared command asks there is
// answered by the enclosing repository, where the whole checkout is an excluded path: `git
// ls-files` lists nothing, tracked files read as untracked or ignored, `git log` and `git diff
// <base>` see the enclosing branch, and tools that honour git's ignore rules find no file. So the
// checkout gets its own `.git`, positioned exactly at the candidate:
//   - `git init` without a template: no hooks, no info/exclude, no remote, no branch;
//   - the project's objects, borrowed: `objects/info/alternates` names the project's common git
//     directory's `objects` (git follows that store's own alternates as for any alternate); the
//     project's `shallow` list is copied, so history ends where it ends in the project; there is
//     no promisor remote, so an object the project does not have locally is missing here too and
//     is never fetched (WI-13);
//   - its configuration: the bound transform description (core.autocrlf, core.eol, core.symlinks,
//     core.filemode, core.ignorecase; the description's info attributes as `info/attributes` and
//     its global attributes as `core.attributesFile`), so git converts the files on disk by the
//     rules they were materialized under; no file system monitor (no daemon outlives the
//     checkout) and no automatic gc. Nothing else of the project's own configuration is copied:
//     no key that names a program, no remote, no identity. The user's global and system
//     configuration apply, as in any repository;
//   - HEAD detached at the candidate;
//   - the index read from the candidate's tree and refreshed against the files on disk, so its
//     stat data describe the checkout and plumbing that does not refresh them (`git diff-index
//     --quiet HEAD`, `git diff-files`) finds a pristine checkout clean. `git status` of a pristine
//     checkout is empty when every file's bytes convert back to its blob, as the files of the
//     supported transforms materialized from normalized blobs do. Where they do not (a blob stored
//     with line endings its `text` attribute normalizes), git reports the path as modified: git's
//     own judgement of those bytes, the one it gives in the project's work tree once it looks at
//     the file. The refresh runs with every configured content filter switched off, so `mp` itself
//     runs no program of the configuration (its own transforms, representation.ts, produced the
//     files): a file written raw (a filter the program does not implement) is its blob; a Git LFS
//     file holds the object's content and is left for git to judge with the user's filter when a
//     command first asks. As after any checkout, git judges a file written in the same timestamp
//     tick as the index again by content when a command first looks at it (racy entries), then
//     with the user's filters.
// Nothing is written to the project's repository: no worktree registration, no ref, no
// configuration, no object. The `.git` is removed with the checkout.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitOid } from '../common/ids.ts';
import type { RepoLayout } from './objects.ts';
import type { GitExec, GitLocators } from './plainGit.ts';
import type { TransformDescription } from './representation.ts';

/** A value for a git configuration file, always quoted (backslash, double quote and newline escaped). */
function configValue(v: string): string {
  if (v.includes('\0')) throw new TypeError(`a configuration value cannot hold NUL: ${JSON.stringify(v)}`);
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** The checkout's own configuration: the bound transform description, no file system monitor, no automatic gc. */
function checkoutConfig(d: TransformDescription, globalAttributes: string): string {
  return [
    '[core]',
    `\tautocrlf = ${d.autocrlf}`,
    // "unset" is what git itself reads for any value it does not know: the description's unset core.eol
    `\teol = ${d.eol}`,
    `\tsymlinks = ${d.symlinks}`,
    `\tfilemode = ${d.fileMode}`,
    `\tignorecase = ${d.ignoreCase}`,
    `\tattributesFile = ${configValue(globalAttributes)}`,
    '\tfsmonitor = false',
    '[gc]',
    '\tauto = 0',
    '',
  ].join('\n');
}

/**
 * Configuration pairs that switch off every content filter configured for the checkout's
 * repository (global, system, its own), for one git run: null when a driver's name cannot be named
 * on a command line (it holds "="), and the caller then leaves the index unrefreshed.
 */
async function filtersOff(git: GitExec, at: { readonly cwd: string; readonly locators: GitLocators }): Promise<Array<readonly [string, string]> | null> {
  const r = await git.run(['config', '-z', '--name-only', '--get-regexp', '^filter\\.'], at);
  if (r.code !== 0 && r.code !== 1) return null;
  const names = new Set<string>();
  for (const key of r.stdout.toString('utf8').split('\0')) {
    const last = key.lastIndexOf('.');
    if (!key.startsWith('filter.') || last <= 'filter.'.length) continue;
    names.add(key.slice('filter.'.length, last));
  }
  const pairs: Array<readonly [string, string]> = [];
  for (const n of [...names].sort()) {
    if (n.includes('=') || /[\0\n]/.test(n)) return null;
    pairs.push([`filter.${n}.process`, ''], [`filter.${n}.clean`, ''], [`filter.${n}.required`, 'false']);
  }
  return pairs;
}

/**
 * Make the materialized checkout `dir` of `commit` a git repository positioned at the commit (see
 * the top of this file). `description`: the transform description the files were materialized
 * under. Writes only inside `dir/.git`; nothing in the project's repository.
 */
export async function attachCheckoutRepository(git: GitExec, repo: RepoLayout, o: { readonly dir: string; readonly commit: GitOid; readonly description: TransformDescription }): Promise<void> {
  const gitDir = join(o.dir, '.git');
  // A tree never holds .git (unsafePathReason): one here is not the candidate's.
  if (existsSync(gitDir)) throw new Error(`${gitDir} already exists: a checkout's repository is made once, in a fresh checkout`);
  // The new repository is named explicitly from here on, never discovered (6.6 v37).
  const own = { cwd: o.dir, locators: { gitDir, workTree: o.dir } };
  await git.ok(['init', '--quiet', '--template=', `--object-format=${repo.objectFormat}`, '--', o.dir], { cwd: o.dir });
  mkdirSync(join(gitDir, 'objects', 'info'), { recursive: true });
  writeFileSync(join(gitDir, 'objects', 'info', 'alternates'), join(repo.commonDir, 'objects') + '\n');
  const shallow = join(repo.commonDir, 'shallow');
  if (existsSync(shallow)) copyFileSync(shallow, join(gitDir, 'shallow'));
  mkdirSync(join(gitDir, 'info'), { recursive: true });
  writeFileSync(join(gitDir, 'info', 'attributes'), o.description.attributes.info ?? '');
  const globalAttributes = join(gitDir, 'info', 'global-attributes');
  writeFileSync(globalAttributes, o.description.attributes.global ?? '');
  const config = join(gitDir, 'config');
  writeFileSync(config, readFileSync(config, 'utf8').replace(/\n?$/, '\n') + checkoutConfig(o.description, globalAttributes));
  await git.ok(['update-ref', '--no-deref', '-m', 'mp: a clean checkout of the candidate', 'HEAD', o.commit], own);
  await git.ok(['read-tree', o.commit], own);
  const off = await filtersOff(git, own);
  // Exit 1: some paths need an update (they are left for git to judge on demand). Any other failure
  // leaves the index as read-tree wrote it: the candidate's tree, without stat data.
  if (off !== null) await git.run(['update-index', '-q', '--refresh'], { ...own, config: off });
}
