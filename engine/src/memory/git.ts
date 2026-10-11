// The few git commands the memory itself runs (design 4.1 §3.1, §3.3): the
// exclude line at init, the repository layout check, `git worktree repair`
// after a move, and the object closure of the commits the memory names. Plain
// git from PATH on every platform, synchronously, inside the `mp` command that
// needs it (§2.5); nothing here rewrites the repository except the worktree
// repair, and that only when the repository lies inside the folder.
//
// The memory's recovery runs while a folder is opened, so it uses this small
// synchronous runner by default; a caller may replace it (OpenOptions.git),
// usually with the git package's runner (git/plainGit.ts `runner()`).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { appendDurable } from './fsx.ts';
import { MEMORY_DIRNAME } from './paths.ts';

export interface GitResult {
  /** The exit code; -1 when git could not be started. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GitRunner = (args: readonly string[], opts: { readonly cwd: string; readonly input?: string }) => GitResult;

/** Variables that would point git at another repository than the folder's own. */
const LOCATOR_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES'];

/** Plain `git` from PATH; never prompts, never fetches a missing object of a partial clone. */
export function plainGit(gitPath = 'git'): GitRunner {
  return (args, opts) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' };
    for (const k of LOCATOR_VARS) delete env[k];
    const r = spawnSync(gitPath, [...args], { cwd: opts.cwd, env, input: opts.input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    if (r.error) return { code: -1, stdout: '', stderr: String(r.error.message) };
    return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Where the folder's repository lives, and what a plain copy of the folder would not carry (§3.3). */
export interface RepositoryLayout {
  readonly repository: boolean;
  readonly toplevel: string | null;
  readonly gitDir: string | null;
  readonly commonDir: string | null;
  readonly gitDirOutside: boolean;
  readonly commonDirOutside: boolean;
  /** Object directories borrowed through objects/info/alternates. */
  readonly alternates: readonly string[];
  readonly partialClone: boolean;
  /** Plain-language warnings for the WI (empty when a copy of the folder carries the code too). */
  readonly warnings: readonly string[];
}

const NO_REPOSITORY: RepositoryLayout = { repository: false, toplevel: null, gitDir: null, commonDir: null, gitDirOutside: false, commonDirOutside: false, alternates: [], partialClone: false, warnings: [] };

/**
 * The repository layout check (§3.3, at init and after a move): the git
 * directory or its common directory outside the folder, alternates, a partial
 * clone. It warns, never refuses, never rewrites the repository.
 */
export function repositoryLayout(git: GitRunner | null, projectDir: string): RepositoryLayout {
  if (git === null) return NO_REPOSITORY;
  const r = git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], { cwd: projectDir });
  if (r.code !== 0) return NO_REPOSITORY;
  const [toplevel, gitDir, commonDir] = r.stdout.split(/\r?\n/);
  if (!toplevel || !gitDir || !commonDir) return NO_REPOSITORY;
  const folder = real(projectDir);
  const gd = real(gitDir);
  const cd = real(commonDir);
  const gitDirOutside = !inside(gd, folder);
  const commonDirOutside = !inside(cd, folder);
  let alternates: string[] = [];
  try {
    alternates = readFileSync(join(cd, 'objects', 'info', 'alternates'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
  } catch {
    /* none */
  }
  const cfg = git(['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], { cwd: projectDir });
  const partialClone = cfg.code === 0 && cfg.stdout.split(/\r?\n/).some((l) => /^extensions\.partialclone\s+\S/i.test(l) || /\.promisor\s+true$/i.test(l));
  const warnings: string[] = [];
  if (commonDirOutside) {
    warnings.push(
      `the repository's common git directory (${cd}) lies outside the project folder: a copy of the folder carries the memory but not the code, and two copies on one machine share one repository (use only one of them, or make a standalone clone)`,
    );
  } else if (gitDirOutside) {
    warnings.push(`the git directory (${gd}) lies outside the project folder: a copy of the folder carries the memory but not necessarily the code`);
  }
  if (alternates.length > 0) warnings.push(`the repository borrows objects from ${alternates.join(', ')} (alternates): a copy of the folder does not carry them`);
  if (partialClone) warnings.push('the repository is a partial clone: objects it never fetched are not in the folder, and mp never fetches them');
  return { repository: true, toplevel: real(toplevel), gitDir: gd, commonDir: cd, gitDirOutside, commonDirOutside, alternates, partialClone, warnings };
}

/**
 * Add `.mission-pipeline/` to the repository's info/exclude (§3.1: the memory
 * is not committed by default), anchored at the project folder (which may be a
 * subdirectory of the repository).
 */
export function addGitExclude(git: GitRunner, projectDir: string): 'added' | 'present' | 'no-repository' {
  const r = git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude', '--show-prefix'], { cwd: projectDir });
  if (r.code !== 0) return 'no-repository';
  const [path, prefix] = r.stdout.split(/\r?\n/);
  if (!path) return 'no-repository';
  const line = `/${prefix ?? ''}${MEMORY_DIRNAME}/`;
  let content = '';
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    /* a new file */
  }
  if (content.split(/\r?\n/).some((l) => l.trim() === line || (prefix === '' && (l.trim() === `${MEMORY_DIRNAME}/` || l.trim() === `/${MEMORY_DIRNAME}`)))) return 'present';
  appendDurable(path, `${content === '' || content.endsWith('\n') ? '' : '\n'}${line}\n`);
  return 'added';
}

/** The dispatch worktrees under `.mission-pipeline/worktrees/` (each has a `.git` file). */
export function memoryWorktrees(worktreesDir: string): string[] {
  try {
    return readdirSync(worktreesDir)
      .map((n) => join(worktreesDir, n))
      .filter((p) => existsSync(join(p, '.git')))
      .sort();
  } catch {
    return [];
  }
}

/** `git worktree repair` for the folder's worktrees (§3.3 step 2), run in the main worktree. */
export function repairWorktrees(git: GitRunner, projectDir: string, worktrees: readonly string[]): GitResult {
  return git(['worktree', 'repair', ...worktrees], { cwd: projectDir });
}

/**
 * The commits of `commits` that are not reachable here with every object they
 * need (§3.3 step 5): missing themselves, or missing an object of their closure
 * (`git rev-list --objects --missing=print`, so a partial clone does not pass
 * and fail later).
 */
export function unreachableCommits(git: GitRunner, projectDir: string, commits: readonly string[]): string[] {
  const oids = [...new Set(commits.filter((c) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(c)))].sort();
  if (oids.length === 0) return [];
  const check = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { cwd: projectDir, input: `${oids.join('\n')}\n` });
  const present: string[] = [];
  const out: string[] = [];
  const lines = check.stdout.split(/\r?\n/);
  oids.forEach((oid, i) => {
    const l = lines[i] ?? '';
    if (check.code === 0 && l === `${oid} commit`) present.push(oid);
    else out.push(oid);
  });
  const closure = (xs: readonly string[]): boolean => {
    const r = git(['rev-list', '--objects', '--missing=print', ...xs], { cwd: projectDir });
    return r.code === 0 && !r.stdout.split(/\r?\n/).some((l) => l.startsWith('?'));
  };
  if (present.length > 0 && !closure(present)) {
    for (const oid of present) if (!closure([oid])) out.push(oid);
  }
  return out.sort();
}
