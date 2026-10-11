// Workspaces, candidate collection and clean checkouts (design 4.1 §3.1,
// §5.3, §5.4; decisions 10 and 17).
//
// - A Constructor dispatch works in its own git worktree,
//   `.mission-pipeline/worktrees/<dispatch>/`, created detached at the
//   dispatch's base commit, so a released dispatch's late writes never reach the
//   next filler's worktree (r1 F5). It is removed on hand-back and on
//   `release --ended`, and kept on `--abandoned` (§5.4). Creating and removing
//   it write to the repository, so both are refused while git writes are held
//   after a move (§3.3 step 2).
// - Collection (§5.3, decision 17): the candidate is the difference between the
//   base commit and the worktree's full current content: the commits the seat
//   made, uncommitted changes and new files git does not ignore, deletions; the
//   seat never runs `git add`. Which paths differ is judged on the files' actual
//   content: a temporary index of the seat's HEAD, free of its own index's flags
//   (assume-unchanged, skip-worktree, fsmonitor), is refreshed by hashing the
//   files; the seat's commits and staged entries are added. The kept
//   representation (representation.ts) turns those paths into the canonical
//   candidate commit, whose only parent is the base, keeping the modes the seat
//   recorded when the filesystem does not track them. A non-ignored change
//   outside the card's write paths refuses the hand-back with the path list; a
//   submodule pointer change is refused (outside the write paths: listed with
//   them); hidden absent paths are refused; ignored files inside the write paths
//   are listed so the seat sees what was left out. A seat that switched its HEAD
//   to a branch, or reset it off the base, is refused too (decision 17).
// - Checkouts (§5.3, decision 10): a commit materialized into a fresh directory
//   under `.mission-pipeline/tmp/` (a verification run's `tmp/<run>/`, a seat's
//   `tmp/<dispatch>/checkout/`) from the commit's objects alone: no worktree is
//   registered and no untracked or ignored file of any worktree is in it.
//   Removed after use.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { GitOid } from '../common/ids.ts';
import { inWriteScope } from '../delivery/writeScope.ts';
import { LedgerError, PATH_ID, type Memory, type MemoryPaths } from '../memory/index.ts';
import { decodePath, discoverRepo, gitOid, NonUtf8PathError, type FileMode, type Ident, type RepoLayout } from './objects.ts';
import { GitError, GitExitError, type PlainGit } from './plainGit.ts';
import { linkedGitDirs } from './worktreeRecord.ts';
import {
  AttributeEvaluator,
  materializeSnapshot,
  MissingObjectsError,
  planCommit,
  readTransformDescription,
  RepresentationError,
  sha256File,
  sha256Hex,
  writeCommit,
  type RepresentationRejection,
  type SnapshotManifest,
  type TransformDescription,
  type UnsupportedPath,
} from './representation.ts';

/** What the git package works with: the project memory (its folder, the git-writes hold) and the git runner. */
export interface GitContext {
  readonly memory: Memory;
  readonly git: PlainGit;
}

/** At most this many ignored entries are listed in a collection's answer (the count is always given). */
export const MAX_IGNORED_LISTED = 200;

function checkDispatch(dispatch: string): void {
  if (typeof dispatch !== 'string' || !PATH_ID.test(dispatch)) throw new LedgerError('BAD_REQUEST', `a dispatch id is 1 to 64 letters, digits and "-": ${JSON.stringify(dispatch)}`);
}

/** `.mission-pipeline/worktrees/<dispatch>` (§3.1). */
export function workspaceDir(paths: MemoryPaths, dispatch: string): string {
  checkDispatch(dispatch);
  return join(paths.worktrees, dispatch);
}

/** `.mission-pipeline/tmp/<run>` for a verification run's clean checkout (§5.3). */
export function runCheckoutDir(paths: MemoryPaths, run: string): string {
  if (typeof run !== 'string' || !PATH_ID.test(run)) throw new LedgerError('BAD_REQUEST', `a run id is 1 to 64 letters, digits and "-": ${JSON.stringify(run)}`);
  return join(paths.tmp, run);
}

/** `.mission-pipeline/tmp/<dispatch>/checkout` for `mp seat <id> checkout` (decision 10). */
export function seatCheckoutDir(paths: MemoryPaths, dispatch: string): string {
  checkDispatch(dispatch);
  return join(paths.tmp, dispatch, 'checkout');
}

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** The worktrees git has registered for the repository, by real path. */
function registeredWorktreePaths(ctx: GitContext): Set<string> {
  const r = ctx.git.okSync(['worktree', 'list', '--porcelain', '-z'], { cwd: ctx.memory.projectDir });
  const out = new Set<string>();
  for (const rec of r.stdout.toString('utf8').split('\0')) if (rec.startsWith('worktree ')) out.add(real(rec.slice('worktree '.length)));
  return out;
}

/** The administrative directories (`<common>/worktrees/<id>`) that register `path`. */
function adminDirsOf(ctx: GitContext, path: string): string[] {
  const common = real(ctx.git.textSync(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ctx.memory.projectDir }));
  const want = real(path);
  return linkedGitDirs(common)
    .filter((l) => l.root === path || real(l.root) === want)
    .map((l) => l.gitDir);
}

function resolveBase(ctx: GitContext, base: string): GitOid {
  const r = ctx.git.runSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`], { cwd: ctx.memory.projectDir });
  if (r.code !== 0) throw new LedgerError('BAD_REQUEST', `the base ${base} is not a commit in this repository (a missing object is never fetched)`);
  return gitOid(r.stdout.toString('utf8').trim());
}

// ---------------------------------------------------------------- workspaces

export interface Workspace {
  readonly dispatch: string;
  readonly path: string;
  /** False when it already existed (ensureWorkspace is idempotent; the seat's work in it is left as it is). */
  readonly created: boolean;
}

/**
 * The dispatch's worktree, created detached at `base` if it does not exist yet
 * (call it after claimDispatch, and again on any later call: a crash between
 * the claim and the creation leaves nothing half done). GIT_WRITES_HELD while
 * git writes are held after a move.
 */
export function ensureWorkspace(ctx: GitContext, req: { readonly dispatch: string; readonly base: string }): Workspace {
  const path = workspaceDir(ctx.memory.paths, req.dispatch);
  ctx.memory.assertGitWrites('a dispatch with a worktree');
  const registered = registeredWorktreePaths(ctx);
  if (existsSync(path)) {
    if (registered.has(real(path)) && existsSync(join(path, '.git'))) return { dispatch: req.dispatch, path, created: false };
    throw new LedgerError('BAD_REQUEST', `${path} exists but is not a worktree of this repository; it is left as it is (remove it by hand if it is a leftover)`);
  }
  const base = resolveBase(ctx, req.base);
  mkdirSync(ctx.memory.paths.worktrees, { recursive: true });
  // A registration whose directory is gone (a crash, a deleted folder) is replaced: one --force does only that.
  const force = registered.has(real(path)) || registered.has(path) ? ['--force'] : [];
  ctx.git.okSync(['worktree', 'add', '--detach', ...force, '--', path, base], { cwd: ctx.memory.projectDir });
  return { dispatch: req.dispatch, path, created: true };
}

/**
 * Remove the dispatch's worktree (on hand-back, or `release --ended`), with
 * everything in it, ignored files included; its registration goes with it.
 * Absent: nothing to do. GIT_WRITES_HELD while git writes are held.
 */
export function removeWorkspace(ctx: GitContext, dispatch: string): { readonly removed: boolean; readonly path: string } {
  const path = workspaceDir(ctx.memory.paths, dispatch);
  ctx.memory.assertGitWrites('removing a dispatch worktree');
  const registered = registeredWorktreePaths(ctx);
  const known = registered.has(real(path)) || registered.has(path);
  if (!known && !existsSync(path)) return { removed: false, path };
  if (known && existsSync(path)) {
    // Twice forced: also a worktree with changes, untracked files or a lock. It removes this registration only.
    const r = ctx.git.runSync(['worktree', 'remove', '--force', '--force', '--', path], { cwd: ctx.memory.projectDir });
    if (r.code !== 0 && existsSync(path)) throw new GitExitError(r);
  }
  // A directory git no longer knows (or left behind): ours, under worktrees/.
  rmSync(path, { recursive: true, force: true });
  // A registration whose directory was already gone: its own administrative directory only (never a
  // repository-wide prune, which would also drop other worktrees' registrations and indexes).
  if (known) for (const admin of adminDirsOf(ctx, path)) rmSync(admin, { recursive: true, force: true });
  return { removed: true, path };
}

/** §5.4: `release --ended` removes the worktree; `--abandoned` keeps it (a late write of the old filler may still land there). */
export function releaseWorkspace(ctx: GitContext, dispatch: string, how: 'ended' | 'abandoned'): { readonly removed: boolean; readonly kept: boolean; readonly path: string } {
  if (how === 'abandoned') return { removed: false, kept: existsSync(workspaceDir(ctx.memory.paths, dispatch)), path: workspaceDir(ctx.memory.paths, dispatch) };
  if (how !== 'ended') throw new LedgerError('BAD_REQUEST', 'a dispatch is released ended or abandoned');
  const r = removeWorkspace(ctx, dispatch);
  return { removed: r.removed, kept: false, path: r.path };
}

// ---------------------------------------------------------------- collection

export interface CollectRequest {
  readonly dispatch: string;
  /** The dispatch's base commit (the card's). */
  readonly base: string;
  /** The card's write paths, relative to the repository root: an exact path, "dir/**", or "**". */
  readonly writePaths: readonly string[];
  readonly message: string;
  readonly author: Ident;
  readonly committer: Ident;
  /** The transform description to represent files under; default: read from the worktree's effective configuration. */
  readonly description?: TransformDescription;
}

export interface IgnoredInScope {
  /** Ignored paths inside the write paths (an ignored directory once, with a trailing "/"); at most MAX_IGNORED_LISTED. */
  readonly paths: readonly string[];
  readonly total: number;
}

export type Collection =
  | {
      readonly kind: 'candidate';
      readonly base: GitOid;
      /** The canonical candidate commit; its only parent is the base. */
      readonly commit: GitOid;
      readonly tree: GitOid;
      /** No path differs from the base. */
      readonly empty: boolean;
      readonly added: readonly string[];
      readonly modified: readonly string[];
      readonly deleted: readonly string[];
      readonly modeChanged: readonly string[];
      readonly ignored: IgnoredInScope;
    }
  /** §5.3: changes outside the card's write paths: the hand-back is refused, listing them. */
  | { readonly kind: 'outside-write-paths'; readonly paths: readonly string[]; readonly ignored: IgnoredInScope }
  /** Decision 17: the seat switched its HEAD to a branch, or reset it off the base. */
  | { readonly kind: 'head-moved'; readonly head: GitOid | null; readonly branch: string | null; readonly detail: string }
  /** The representation cannot represent what the seat left (7.1: an unsupported filter, an unsafe path, a special file, ...). */
  | { readonly kind: 'rejected'; readonly rejection: RepresentationRejection }
  /** Objects the base needs are not in the repository (a partial or shallow clone): never fetched. */
  | { readonly kind: 'objects-missing'; readonly objects: readonly string[]; readonly paths: readonly string[] }
  | { readonly kind: 'no-workspace'; readonly path: string };

/** The NUL-separated paths of a git listing; a path that is not UTF-8 is a rejection. */
function zPaths(buf: Buffer): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < buf.length) {
    const end = buf.indexOf(0, start);
    const stop = end < 0 ? buf.length : end;
    if (stop > start) out.push(decodePath(buf.subarray(start, stop)));
    start = stop + 1;
  }
  return out;
}

/** Settings that would let git answer from a cache instead of the files (fsmonitor, the untracked cache). */
const NO_CACHES: readonly (readonly [string, string])[] = [
  ['core.fsmonitor', 'false'],
  ['core.untrackedCache', 'false'],
];

interface RawChange {
  readonly path: string;
  /** A submodule pointer on either side. */
  readonly gitlink: boolean;
}

/** `--raw -z --no-renames` records of diff-tree, diff-files, diff-index: `:<mode> <mode> <oid> <oid> <status>` NUL `<path>` NUL. */
function rawChanges(buf: Buffer): RawChange[] {
  const out: RawChange[] = [];
  const fields: Buffer[] = [];
  for (let start = 0; start < buf.length; ) {
    const end = buf.indexOf(0, start);
    const stop = end < 0 ? buf.length : end;
    fields.push(buf.subarray(start, stop));
    start = stop + 1;
  }
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i]!.toString('latin1');
    if (!meta.startsWith(':')) throw new Error(`unexpected raw diff record ${JSON.stringify(meta)}`);
    const [src, dst] = meta.slice(1).split(' ');
    out.push({ path: decodePath(fields[i + 1]!), gitlink: src === '160000' || dst === '160000' });
  }
  return out;
}

/** `ls-files -z -s -t`: tag, mode, stage and path of each index entry. */
function indexEntries(buf: Buffer): Array<{ tag: string; mode: string; stage: number; path: string }> {
  const out: Array<{ tag: string; mode: string; stage: number; path: string }> = [];
  for (let start = 0; start < buf.length; ) {
    const end = buf.indexOf(0, start);
    const stop = end < 0 ? buf.length : end;
    const rec = buf.subarray(start, stop);
    start = stop + 1;
    const tab = rec.indexOf(9);
    if (tab < 0) continue;
    const [tag, mode, , stage] = rec.subarray(0, tab).toString('latin1').split(' ');
    out.push({ tag: tag ?? '', mode: mode ?? '', stage: Number(stage), path: decodePath(rec.subarray(tab + 1)) });
  }
  return out;
}

/** Can a write path pattern match something inside directory `dir` (or `dir` itself)? */
function scopeReachesDir(writePaths: readonly string[], dir: string): boolean {
  return writePaths.some((p) => {
    if (p === '**') return true;
    const base = p.endsWith('/**') ? p.slice(0, -3) : p;
    return base === dir || base.startsWith(`${dir}/`) || dir.startsWith(`${base}/`);
  });
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Collect the dispatch's candidate at hand-back (§5.3, decision 17). Nothing in
 * the worktree is changed (git reads only; no `git add`); the candidate's
 * objects are written to the repository, so GIT_WRITES_HELD while git writes
 * are held after a move.
 */
export async function collectCandidate(ctx: GitContext, req: CollectRequest): Promise<Collection> {
  const { git, memory } = ctx;
  const wt = workspaceDir(memory.paths, req.dispatch);
  if (!existsSync(join(wt, '.git'))) return { kind: 'no-workspace', path: wt };
  memory.assertGitWrites('a hand-back that commits');
  if (!Array.isArray(req.writePaths) || req.writePaths.some((p) => typeof p !== 'string' || p === '' || p.startsWith('/') || p.includes('\\'))) {
    throw new LedgerError('BAD_REQUEST', 'write paths are repository-relative patterns: an exact path, "dir/**", or "**"');
  }
  const base = resolveBase(ctx, req.base);
  const at = { cwd: wt };

  // Decision 17: HEAD detached, at the base or on commits the seat made on top of it.
  const sym = git.runSync(['symbolic-ref', '-q', 'HEAD'], at);
  const headRun = git.runSync(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], at);
  const head = headRun.code === 0 ? gitOid(headRun.stdout.toString('utf8').trim()) : null;
  if (sym.code === 0) {
    const branch = sym.stdout.toString('utf8').trim();
    return { kind: 'head-moved', head, branch, detail: `HEAD was switched to ${branch}; the worktree must stay detached on the base ${base} (commits on top of it are fine)` };
  }
  if (head === null) return { kind: 'head-moved', head, branch: null, detail: 'HEAD does not name a commit' };
  if (head !== base) {
    const anc = git.runSync(['merge-base', '--is-ancestor', base, head], at);
    if (anc.code !== 0) return { kind: 'head-moved', head, branch: null, detail: `HEAD ${head} does not descend from the base ${base}: the worktree was reset or switched to another base` };
  }

  const scratch = mkdtempSync(join(memory.paths.tmp, `collect-${req.dispatch}-`));
  let attributes: AttributeEvaluator | null = null;
  try {
    // Which paths differ from the base, judged on the files' actual content (§5.3, decision 17): a
    // temporary index holds the seat's HEAD without any flag of its own index (assume-unchanged,
    // skip-worktree, fsmonitor validity), refreshed by hashing what is on disk.
    const tmp = { cwd: wt, env: { GIT_INDEX_FILE: join(scratch, 'index') }, config: NO_CACHES };
    let changes: RawChange[];
    let untracked: string[];
    let ignoredAll: string[];
    let hidden: string[];
    let recorded: Map<string, FileMode>;
    try {
      git.okSync(['read-tree', head], tmp);
      git.runSync(['update-index', '-q', '--refresh'], tmp);
      changes = [
        // The seat's commits.
        ...(head === base ? [] : rawChanges(git.okSync(['diff-tree', '-r', '-z', '--raw', '--no-renames', base, head], at).stdout)),
        // Its files on disk against HEAD, by content (a submodule's own changes inside do not count; its commit does).
        ...rawChanges(git.okSync(['diff-files', '-z', '--raw', '--no-renames', '--ignore-submodules=dirty'], tmp).stdout),
        // What it staged and did not commit (index entries against HEAD: no worktree flag applies).
        ...rawChanges(git.okSync(['diff-index', '--cached', '-z', '--raw', '--no-renames', 'HEAD'], at).stdout),
      ];
      // New files git does not ignore, and the ignored ones (listed, never collected).
      untracked = zPaths(git.okSync(['ls-files', '-z', '--others', '--exclude-standard'], tmp).stdout);
      ignoredAll = zPaths(git.okSync(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], tmp).stdout);
      const own = indexEntries(git.okSync(['ls-files', '-z', '-s', '-t'], { ...at, config: NO_CACHES }).stdout);
      hidden = own.filter((e) => e.tag === 'S' && !existsSync(join(wt, ...e.path.split('/')))).map((e) => e.path);
      recorded = new Map(own.filter((e) => e.stage === 0 && (e.mode === '100644' || e.mode === '100755' || e.mode === '120000')).map((e) => [e.path, e.mode as FileMode]));
    } catch (e) {
      if (e instanceof NonUtf8PathError) return { kind: 'rejected', rejection: { code: 'non-utf8-path', detail: e.message, paths: [] } };
      throw e;
    }
    const ignoredIn = ignoredAll.filter((p) => (p.endsWith('/') ? scopeReachesDir(req.writePaths, p.slice(0, -1)) : inWriteScope(req.writePaths, p))).sort(compareBytes);
    const ignored: IgnoredInScope = { paths: ignoredIn.slice(0, MAX_IGNORED_LISTED), total: ignoredIn.length };
    const embedded = untracked.filter((p) => p.endsWith('/'));
    if (embedded.length > 0) {
      return { kind: 'rejected', rejection: { code: 'special-file', detail: 'nested git repositories cannot be part of a candidate', paths: embedded.map((p) => p.slice(0, -1)) } };
    }
    const all = [...new Set([...changes.map((c) => c.path), ...untracked])].sort(compareBytes);
    const outside = all.filter((p) => !inWriteScope(req.writePaths, p));
    if (outside.length > 0) return { kind: 'outside-write-paths', paths: outside, ignored };
    const gitlinks = [...new Set(changes.filter((c) => c.gitlink).map((c) => c.path))].sort(compareBytes);
    if (gitlinks.length > 0) {
      return { kind: 'rejected', rejection: { code: 'gitlink-modified', detail: 'a submodule pointer changed: candidates never carry submodule changes (change it in its own repository and its own task)', paths: gitlinks } };
    }
    if (hidden.length > 0) {
      return { kind: 'rejected', rejection: { code: 'hidden-entries', detail: 'the worktree index marks these paths skip-worktree and their files are absent: whether they were deleted cannot be told', paths: hidden.sort(compareBytes) } };
    }

    const inside = new Set(all);
    const dirs = new Set<string>();
    for (const p of inside) for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) dirs.add(p.slice(0, i));
    const select = (p: string, isDir: boolean): boolean => (isDir ? dirs.has(p) : inside.has(p));

    const repo = await discoverRepo(git, wt);
    const description = req.description ?? (await readTransformDescription(git, repo, wt));
    attributes = await AttributeEvaluator.create(git, repo, description, scratch);
    // The base as the seat's files would show it, for the paths that changed; the whole base when a .gitattributes changed.
    const attrs = [...inside].some((p) => p === '.gitattributes' || p.endsWith('/.gitattributes'));
    const manifest: SnapshotManifest = await materializeSnapshot({ git, repo, commit: base, attributes, ...(attrs ? {} : { exclude: (p: string) => !inside.has(p) }) });
    // With core.filemode=false the executable bit, and with core.symlinks=false the link type, that the seat
    // recorded (its commits, its index) are kept: the filesystem does not carry them.
    const planned = await planCommit({ git, repo, base: manifest, snapshotDir: wt, attributes, select, recordedMode: (p) => recorded.get(p) ?? null });
    if (!planned.ok) return { kind: 'rejected', rejection: planned.rejection };
    const plan = planned.plan;
    const commit = await writeCommit(git, repo, plan, { message: req.message, author: req.author, committer: req.committer, tempDir: scratch });
    return {
      kind: 'candidate',
      base,
      commit,
      tree: plan.tree,
      empty: plan.tree === plan.baseTree,
      added: plan.added,
      modified: plan.modified,
      deleted: plan.deleted,
      modeChanged: plan.modeChanged,
      ignored,
    };
  } catch (e) {
    if (e instanceof MissingObjectsError) return { kind: 'objects-missing', objects: e.objects, paths: e.paths };
    if (e instanceof RepresentationError) return { kind: 'rejected', rejection: { code: e.code === 'unsafe-path' || e.code === 'path-collision' ? 'unsafe-path' : 'unsupported-transform', detail: e.message, paths: e.paths } };
    throw e;
  } finally {
    attributes?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- a worktree against a commit

export type WorktreeComparison =
  | { readonly state: 'match' }
  /** `index`: index entries that differ from the commit's tree; `files`: files that differ from its materialization. */
  | { readonly state: 'differs'; readonly index: readonly string[]; readonly files: readonly string[] }
  | { readonly state: 'undetermined'; readonly reason: string };

/**
 * Does the worktree at `root` hold exactly `commit` (§6.7, WI-02, WI-04)?
 * Judged on what is there, never on `git status` or the index's flags: every
 * index entry against the commit's tree (path, mode, object), and every file
 * of the commit against the bytes, mode and kind a clean checkout of it would
 * have (representation.ts, under the worktree's transform description).
 * Untracked files do not count. When the comparison cannot be made (a
 * transform the program does not implement, an LFS object that is not local, a
 * missing object), the answer is "undetermined", never "match".
 */
export async function compareToCommit(ctx: GitContext, root: string, commit: string): Promise<WorktreeComparison> {
  if (!existsSync(root)) return { state: 'undetermined', reason: `${root} does not exist` };
  const scratch = mkdtempSync(join(ctx.memory.paths.tmp, 'compare-'));
  let attributes: AttributeEvaluator | null = null;
  try {
    const { git } = ctx;
    const repo = await discoverRepo(git, root);
    const description = await readTransformDescription(git, repo, root);
    attributes = await AttributeEvaluator.create(git, repo, description, scratch);
    const manifest = await materializeSnapshot({ git, repo, commit, attributes });
    if (manifest.unsupported.length > 0) {
      return { state: 'undetermined', reason: `transforms the program does not implement: ${manifest.unsupported.map((u) => `${u.path} (${u.reason})`).join(', ')}` };
    }
    const index = rawChanges(git.okSync(['diff-index', '--cached', '-z', '--raw', '--no-renames', commit, '--'], { cwd: root, config: NO_CACHES }).stdout).map((c) => c.path);
    const files: string[] = [];
    for (const e of manifest.entries) {
      const abs = join(root, ...e.path.split('/'));
      if (e.mode === '160000') {
        // A submodule: its checked-out commit must be the gitlink's, and its own index and files exactly
        // that commit (the same comparison, inside it); not checked out at all (absent, or an empty
        // directory) is what a clean checkout has.
        const sub = await submoduleState(ctx, abs, e.oid);
        if (sub.state === 'undetermined') return { state: 'undetermined', reason: `the submodule ${e.path}: ${sub.reason}` };
        if (sub.state === 'differs') files.push(e.path);
        continue;
      }
      // Only a path that is not there (or whose parent is not a directory) differs by absence; any other
      // error reading it means the comparison cannot be made.
      try {
        const st = lstatSync(abs);
        let same: boolean;
        if (e.mode === '120000' && description.symlinks) same = st.isSymbolicLink() && sha256Hex(readlinkSync(abs, { encoding: 'buffer' })) === e.sha256;
        else if (!st.isFile()) same = false;
        else {
          same = st.size === e.size && sha256File(abs).sha256 === e.sha256;
          if (same && e.mode !== '120000' && description.fileMode) same = ((st.mode & 0o100) !== 0) === (e.mode === '100755');
        }
        if (!same) files.push(e.path);
      } catch (err) {
        if (isAbsent(err)) files.push(e.path);
        else return { state: 'undetermined', reason: `${e.path} cannot be read: ${(err as Error).message}` };
      }
    }
    return index.length === 0 && files.length === 0 ? { state: 'match' } : { state: 'differs', index: [...new Set(index)].sort(compareBytes), files: files.sort(compareBytes) };
  } catch (e) {
    if (e instanceof RepresentationError || e instanceof NonUtf8PathError || e instanceof GitError) return { state: 'undetermined', reason: e.message };
    throw e;
  } finally {
    attributes?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A path that is not there: ENOENT, or ENOTDIR (a parent is not a directory). */
function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** A submodule's directory against its gitlink commit. */
async function submoduleState(ctx: GitContext, dir: string, gitlink: string): Promise<WorktreeComparison> {
  let entries: string[];
  try {
    if (!lstatSync(dir).isDirectory()) return { state: 'differs', index: [], files: [dir] };
    entries = readdirSync(dir);
  } catch (err) {
    if (isAbsent(err)) return { state: 'match' }; // not checked out
    return { state: 'undetermined', reason: `cannot be read: ${(err as Error).message}` };
  }
  if (entries.length === 0) return { state: 'match' };
  if (!entries.includes('.git')) return { state: 'differs', index: [], files: [dir] }; // files where an uninitialized submodule is empty
  const head = ctx.git.runSync(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: dir });
  if (head.code !== 0) return { state: 'undetermined', reason: 'its HEAD cannot be read' };
  if (head.stdout.toString('utf8').trim() !== gitlink) return { state: 'differs', index: [], files: [dir] };
  // Its index and files against that commit, on content: assume-unchanged and skip-worktree hide nothing.
  return compareToCommit(ctx, dir, gitlink);
}

// ---------------------------------------------------------------- checkouts

export interface Checkout {
  readonly dir: string;
  readonly commit: GitOid;
  /** Every materialized file with its size and hash (representation.ts). */
  readonly manifest: SnapshotManifest;
  /** Paths materialized raw because their transform is not one the program implements. */
  readonly unsupported: readonly UnsupportedPath[];
}

function insideDir(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Materialize `commit` into `dir` (§5.3; decision 10): a fresh directory under
 * `.mission-pipeline/tmp/`, replaced if it exists, holding exactly the commit's
 * files under the repository's transform description, from its objects alone
 * (nothing of any worktree, no registered worktree, no fetch). A missing object
 * is MissingObjectsError (representation.ts).
 */
export async function checkoutCommit(ctx: GitContext, req: { readonly commit: string; readonly dir: string; readonly description?: TransformDescription }): Promise<Checkout> {
  const tmp = ctx.memory.paths.tmp;
  if (!insideDir(req.dir, tmp)) throw new LedgerError('BAD_REQUEST', `a checkout goes under ${tmp}, not ${req.dir}`);
  mkdirSync(tmp, { recursive: true });
  rmSync(req.dir, { recursive: true, force: true });
  const scratch = mkdtempSync(join(tmp, 'checkout-attr-'));
  let attributes: AttributeEvaluator | null = null;
  try {
    const repo: RepoLayout = await discoverRepo(ctx.git, ctx.memory.projectDir);
    const description = req.description ?? (await readTransformDescription(ctx.git, repo, ctx.memory.projectDir));
    attributes = await AttributeEvaluator.create(ctx.git, repo, description, scratch);
    const manifest = await materializeSnapshot({ git: ctx.git, repo, commit: req.commit, attributes, dest: req.dir });
    return { dir: req.dir, commit: manifest.commit, manifest, unsupported: manifest.unsupported };
  } catch (e) {
    rmSync(req.dir, { recursive: true, force: true });
    throw e;
  } finally {
    attributes?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Remove a checkout after use (its run, or the seat's dispatch, is over). Only directories under `tmp/`. */
export function removeCheckout(ctx: GitContext, dir: string): { readonly removed: boolean } {
  if (!insideDir(dir, ctx.memory.paths.tmp)) throw new LedgerError('BAD_REQUEST', `only checkouts under ${ctx.memory.paths.tmp} are removed, not ${dir}`);
  if (!existsSync(dir)) return { removed: false };
  rmSync(dir, { recursive: true, force: true });
  return { removed: true };
}
