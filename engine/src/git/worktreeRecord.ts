// The fixed worktree set of a landing (design 6.6 v35, v36, v37, v38, v40).
//
// When the landing view is built, the program records every registered
// worktree of the repository, found through the common git dir, for the three
// layouts alike (a main worktree; a landing started from a linked worktree; a
// bare common repository with linked worktrees):
// - each worktree's git dir (the common dir for the main worktree), its root,
//   its HEAD, the contents of its locator files (`gitdir`, `commondir`) and of
//   its root's `.git` file, and the identity (device, inode) of the common dir,
//   of each linked git dir and of each root;
// - admission and the pre-landing state are computed from this record.
// Every landing command then opens each recorded directory read-only without
// following a symlink, checks its identity against the record, and has it bound
// into the namespace by descriptor (landingView.ts), so renaming, moving or
// re-registering a directory afterwards cannot change where the command writes.
// A mismatch refuses the landing before the push phase; after it, the command
// does not run and the worktree is reported as not determinable.
//
// Locators (6.6 v38) are per operation: a repository-level command names only
// the common dir; a command on one worktree names that worktree's git dir, the
// common dir and its root. Nothing is ever discovered from a `.git` file or the
// current directory.

import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { GitOid } from '../common/ids.ts';
import { gitOid } from './objects.ts';
import type { GitLocators, SafeGit } from './safeGit.ts';

export interface DirIdentity {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
}

/** A file whose recorded content is overlaid read-only in every landing command (locator files, a root's `.git` file). */
export interface RecordedFile {
  readonly path: string;
  /** Base64 of the exact bytes. */
  readonly content: string;
}

/**
 * Which branch a worktree occupies (6.6 v40, v41): its HEAD, and the branch a
 * paused rebase or bisect started from. git still treats that branch as in use
 * by the worktree although HEAD is detached, and its receiving side would update
 * that worktree, destroying the rebase or bisect in progress.
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

export interface RecordedWorktree {
  /** The worktree root; null for a bare common repository itself. */
  readonly root: string | null;
  /** Its git dir: the common dir for the main worktree (and a bare repository), `<common>/worktrees/<id>` for a linked one. */
  readonly gitDir: string;
  readonly linked: boolean;
  /** Full ref name HEAD points to; null when detached or bare. */
  readonly branch: string | null;
  /** HEAD commit; null when unborn. */
  readonly head: GitOid | null;
  /** The root directory was missing when recorded. */
  readonly prunable: boolean;
  /** What it occupied when recorded (6.6 v40, v41). */
  readonly occupancy: Occupancy;
  /** Identities of its linked git dir and its root (when present). */
  readonly identities: readonly DirIdentity[];
  /** `gitdir` and `commondir` of a linked git dir, and the root's `.git` file. */
  readonly files: readonly RecordedFile[];
}

export interface WorktreeRecord {
  readonly commonDir: DirIdentity;
  /** The repository's object format, so recovery can work from the record alone (review r1 #10). */
  readonly objectFormat: 'sha1' | 'sha256';
  /** The main worktree (or the bare repository) first, then the linked ones by git dir. */
  readonly worktrees: readonly RecordedWorktree[];
}

/** A recorded directory that is not the recorded directory object any more. */
export interface IdentityProblem {
  /** The git dir of the worktree it belongs to; null for the common dir itself. */
  readonly worktree: string | null;
  readonly path: string;
  readonly problem: 'missing' | 'not-a-directory' | 'replaced';
}

export class WorktreeIdentityChanged extends Error {
  readonly problems: readonly IdentityProblem[];
  constructor(problems: readonly IdentityProblem[]) {
    super(`recorded directories changed identity: ${problems.map((p) => `${p.path} (${p.problem})`).join(', ')}`);
    this.name = 'WorktreeIdentityChanged';
    this.problems = problems;
  }
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

/** `git worktree list --porcelain -z` naming the common dir explicitly; inside a landing view when `git` is bound to one. */
export async function listWorktreesAt(git: SafeGit, commonDir: string): Promise<ListedWorktree[]> {
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

/** A worktree as it is registered now, read OUTSIDE the namespace (pure reads). */
export interface RegisteredWorktree extends ListedWorktree {
  /** Its git dir: the common dir for the main worktree and a bare repository; null when no linked git dir names it. */
  readonly gitDir: string | null;
  readonly gitDirIdentity: DirIdentity | null;
  readonly occupancy: Occupancy;
}

/** All registered worktrees, as git lists them, each with its git dir: for the pre-push re-check and the post-push scan. */
export async function registeredWorktrees(git: SafeGit, commonDir: string): Promise<RegisteredWorktree[]> {
  const listed = await listWorktreesAt(git, commonDir);
  const byRoot = new Map(linkedGitDirs(commonDir).map((l) => [l.root, l] as const));
  return listed.map((w, i) => {
    if (i === 0) return { ...w, gitDir: commonDir, gitDirIdentity: identityOf(commonDir), occupancy: readOccupancy(commonDir, w.branch) };
    const l = byRoot.get(w.path);
    const occupancy = l === undefined ? { branch: w.branch, rebasing: null, bisecting: null, inProgress: false } : readOccupancy(l.gitDir, w.branch);
    return { ...w, gitDir: l?.gitDir ?? null, gitDirIdentity: l === undefined ? null : identityOf(l.gitDir), occupancy };
  });
}

/** Records the fixed set (outside the namespace: reads only). */
export async function recordWorktrees(git: SafeGit, commonDir: string, objectFormat: 'sha1' | 'sha256' = 'sha1'): Promise<WorktreeRecord> {
  const common = identityOf(commonDir);
  if (common === null) throw new Error(`${commonDir} is not a directory`);
  const listed = await listWorktreesAt(git, commonDir);
  const linked = linkedGitDirs(commonDir);
  const byRoot = new Map(linked.map((l) => [l.root, l] as const));
  const worktrees: RecordedWorktree[] = [];
  listed.forEach((w, i) => {
    const files: RecordedFile[] = [];
    const identities: DirIdentity[] = [];
    if (i === 0) {
      // The main worktree, or the bare repository itself.
      const root = w.bare ? null : w.path;
      if (root !== null) {
        const rid = identityOf(root);
        if (rid !== null) identities.push(rid);
        const dotGit = readBytes(join(root, '.git')); // a file only with a separate git dir
        if (dotGit !== null) files.push({ path: join(root, '.git'), content: dotGit.toString('base64') });
      }
      worktrees.push({
        root,
        gitDir: commonDir,
        linked: false,
        branch: w.branch,
        head: w.head,
        prunable: root !== null && identities.length === 0,
        occupancy: readOccupancy(commonDir, w.branch),
        identities,
        files,
      });
      return;
    }
    const l = byRoot.get(w.path);
    if (l === undefined) throw new Error(`worktree ${w.path} is listed but no git dir under ${commonDir}/worktrees names it`);
    const gid = identityOf(l.gitDir);
    if (gid === null) throw new Error(`${l.gitDir} is not a directory`);
    identities.push(gid);
    files.push({ path: join(l.gitDir, 'gitdir'), content: l.gitdirFile.toString('base64') });
    const commondir = readBytes(join(l.gitDir, 'commondir'));
    if (commondir !== null) files.push({ path: join(l.gitDir, 'commondir'), content: commondir.toString('base64') });
    const rid = identityOf(w.path);
    if (rid !== null) {
      identities.push(rid);
      const dotGit = readBytes(join(w.path, '.git'));
      if (dotGit !== null) files.push({ path: join(w.path, '.git'), content: dotGit.toString('base64') });
    }
    worktrees.push({
      root: w.path,
      gitDir: l.gitDir,
      linked: true,
      branch: w.branch,
      head: w.head,
      prunable: rid === null,
      occupancy: readOccupancy(l.gitDir, w.branch),
      identities,
      files,
    });
  });
  return { commonDir: common, objectFormat, worktrees };
}

/** 6.6 v38: the locators of an operation on one recorded worktree. */
export function worktreeLocators(record: WorktreeRecord, w: RecordedWorktree): GitLocators {
  if (w.root === null) return { gitDir: record.commonDir.path };
  return { gitDir: w.gitDir, commonDir: record.commonDir.path, workTree: w.root };
}

/** 6.6 v38: a repository-level operation (refs, objects, the push's sending side) names only the common dir. */
export function repositoryLocators(record: WorktreeRecord): GitLocators {
  return { gitDir: record.commonDir.path };
}

export function recordedWorktreeAt(record: WorktreeRecord, root: string): RecordedWorktree | null {
  return record.worktrees.find((w) => w.root === root) ?? null;
}

export interface OpenedDir {
  readonly fd: number;
  readonly path: string;
  /** The common git dir, a linked worktree's git dir, or a worktree root. */
  readonly role: 'common' | 'admin' | 'root';
  /** The git dir of the worktree it belongs to; null for the common dir. */
  readonly worktree: string | null;
}

function openChecked(id: DirIdentity, worktree: string | null): { fd: number } | IdentityProblem {
  let fd: number;
  try {
    fd = openSync(id.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { worktree, path: id.path, problem: code === 'ENOENT' ? 'missing' : 'not-a-directory' };
  }
  const st = fstatSync(fd, { bigint: true });
  if (String(st.dev) !== id.dev || String(st.ino) !== id.ino) {
    closeSync(fd);
    return { worktree, path: id.path, problem: 'replaced' };
  }
  return { fd };
}

export function closeOpened(opened: readonly OpenedDir[]): void {
  for (const o of opened) {
    try {
      closeSync(o.fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Opens every recorded directory (except the excluded worktrees') read-only,
 * without following a symlink, and checks it is the recorded object. The caller
 * owns the returned descriptors.
 */
export function openRecordedDirs(record: WorktreeRecord, exclude: ReadonlySet<string> = new Set()): { opened: OpenedDir[]; problems: IdentityProblem[] } {
  const opened: OpenedDir[] = [];
  const problems: IdentityProblem[] = [];
  const one = (id: DirIdentity, worktree: string | null, role: OpenedDir['role']): void => {
    const r = openChecked(id, worktree);
    if ('fd' in r) opened.push({ fd: r.fd, path: id.path, role, worktree });
    else problems.push(r);
  };
  one(record.commonDir, null, 'common');
  for (const w of record.worktrees) {
    if (exclude.has(w.gitDir)) continue;
    for (const id of w.identities) one(id, w.gitDir, id.path === w.root ? 'root' : 'admin');
  }
  return { opened, problems };
}

/** The identity problems right now (descriptors closed again). */
export function identityProblems(record: WorktreeRecord): IdentityProblem[] {
  const { opened, problems } = openRecordedDirs(record);
  closeOpened(opened);
  return problems;
}
