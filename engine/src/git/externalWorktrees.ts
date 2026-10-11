// External worktrees and branches (design 4.1 §6.7; WI-02, WI-03).
//
// Every worktree of the repository is external except the maintainer's own
// checkout and the pipeline's dispatch worktrees under
// `.mission-pipeline/worktrees/`. This lists every worktree with its branch,
// HEAD, occupancy, lock, inferred origin, last modification and the paths it
// changed relative to a base (since it diverged from it), committed and
// uncommitted; and, for WI-03 (at a delivery and at a landing, never by a
// periodic scan), the external worktrees and branches checked out nowhere whose
// changes overlap the write scope of a module of a mission in flight. It is for
// explanation ONLY: no safety rule depends on it, and the inferred origin may
// be wrong.
//
// Pure reads: plumbing that runs no filter (worktree list, rev-parse,
// diff-tree, ls-tree, ls-files), with each worktree named by its own locators.
// Uncommitted changes are found from the index (staged) and from the index's
// stat data compared with the files (modified), never by hashing through a
// filter, so they are "possibly changed" when only the stat data moved.
//
// 4.1 (§2.4, §6.6): which processes work in a worktree is the harness's to
// report; nothing here looks at processes, so their presence is unknown here,
// never "none".

import { lstatSync, readFileSync } from 'node:fs';
import type { GitOid } from '../common/ids.ts';
import { gitOid, parseLsFiles } from './objects.ts';
import type { GitExec, GitLocators } from './plainGit.ts';
import { registeredWorktrees, type Occupancy } from './worktreeRecord.ts';
import { join } from 'node:path';

export type WorktreeOrigin = 'claude' | 'codex' | 'unknown';

export interface ExternalWorktree {
  readonly path: string;
  /** Its git dir (the common dir for the main worktree); null when no git dir names it. */
  readonly gitDir: string | null;
  readonly isMainCheckout: boolean;
  readonly bare: boolean;
  readonly prunable: boolean;
  readonly branch: string | null;
  readonly head: GitOid | null;
  readonly occupancy: Occupancy;
  /** `git worktree lock` reason; "" when locked without one; null when not locked. */
  readonly locked: string | null;
  readonly origin: WorktreeOrigin;
  /** Latest modification seen (ms since the epoch): the root, its HEAD, its index and its changed files. */
  readonly lastModified: number | null;
  /** Paths changed relative to the base: committed (base..HEAD) and uncommitted (staged, or modified by stat). */
  readonly changed: { readonly committed: readonly string[]; readonly uncommitted: readonly string[] } | null;
}

/** By path and branch name only (6.6 v41): `.claude/worktrees/` is a Claude sub-agent, a `codex/` branch is Codex. */
export function inferOrigin(path: string, branch: string | null): WorktreeOrigin {
  if (/(^|\/)\.claude\/worktrees\//.test(path)) return 'claude';
  if (branch !== null && branch.startsWith('refs/heads/codex/')) return 'codex';
  return 'unknown';
}

/** Write-scope patterns as constraint scopes read them (9.5): an exact path, "dir/**", or "**". */
function scopeMatches(pattern: string, path: string): boolean {
  if (pattern === '**') return true;
  if (pattern.endsWith('/**')) {
    const dir = pattern.slice(0, -3);
    return path === dir || path.startsWith(dir + '/');
  }
  return pattern === path;
}

/** WI-03: the changed paths that fall inside a mission module's write scope. */
export function overlappingPaths(changed: readonly string[], writeScope: readonly string[]): string[] {
  return changed.filter((p) => writeScope.some((pat) => scopeMatches(pat, p)));
}

function mtimeMs(path: string): number | null {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return null;
  }
}

interface DebugEntry {
  readonly path: string;
  readonly mtimeSec: bigint;
  readonly mtimeNsec: bigint;
  readonly ino: bigint;
  readonly size: bigint;
}

/** `git ls-files --debug -z`: each path, NUL, then five lines of its stat data. */
export function parseLsFilesDebug(buf: Buffer): DebugEntry[] {
  const chunks = buf.toString('utf8').split('\0');
  const out: DebugEntry[] = [];
  let path = chunks[0] ?? '';
  for (let i = 1; i < chunks.length; i++) {
    const lines = (chunks[i] as string).split('\n');
    const field = (re: RegExp): string[] => {
      for (const l of lines.slice(0, 5)) {
        const m = re.exec(l);
        if (m !== null) return m.slice(1);
      }
      return [];
    };
    const [ms, mns] = field(/^\s*mtime: (\d+):(\d+)/);
    const [ino] = field(/ino: (\d+)/);
    const [size] = field(/size: (\d+)/);
    if (path !== '' && ms !== undefined && mns !== undefined && ino !== undefined && size !== undefined) {
      out.push({ path, mtimeSec: BigInt(ms), mtimeNsec: BigInt(mns), ino: BigInt(ino), size: BigInt(size) });
    }
    path = lines.slice(5).join('\n');
  }
  return out;
}

function statDiffers(root: string, e: DebugEntry): boolean {
  try {
    const st = lstatSync(join(root, e.path), { bigint: true });
    if (st.size !== e.size || st.ino !== e.ino) return true;
    const sec = st.mtimeNs / 1_000_000_000n;
    const nsec = st.mtimeNs % 1_000_000_000n;
    return sec !== e.mtimeSec || (e.mtimeNsec !== 0n && nsec !== e.mtimeNsec);
  } catch {
    return true; // deleted
  }
}

async function changedPaths(git: GitExec, commonDir: string, loc: GitLocators, root: string, base: GitOid, head: GitOid | null): Promise<{ committed: string[]; uncommitted: string[] }> {
  const repo = { gitDir: commonDir };
  const committed = head === null ? [] : await divergedPaths(git, commonDir, base, head);
  const uncommitted = new Set<string>();
  // Staged: the index against HEAD's tree.
  const idx = await git.ok(['ls-files', '-s', '-t', '-z'], { cwd: root, locators: loc, maxOutputBytes: 1024 * 1024 * 1024 });
  const index = new Map<string, string>();
  for (const e of parseLsFiles(idx.stdout)) index.set(e.path, `${e.mode} ${e.oid} ${e.stage}`);
  const headEntries = new Map<string, string>();
  if (head !== null) {
    const t = await git.ok(['ls-tree', '-r', '-z', '--full-tree', head], { cwd: commonDir, locators: repo, maxOutputBytes: 1024 * 1024 * 1024 });
    for (const rec of t.stdout.toString('utf8').split('\0')) {
      if (rec === '') continue;
      const tab = rec.indexOf('\t');
      const [mode, , oid] = rec.slice(0, tab).split(' ');
      headEntries.set(rec.slice(tab + 1), `${mode} ${oid} 0`);
    }
  }
  for (const [p, v] of index) if (headEntries.get(p) !== v) uncommitted.add(p);
  for (const p of headEntries.keys()) if (!index.has(p)) uncommitted.add(p);
  // Modified: the index's stat data against the files.
  const dbg = await git.ok(['ls-files', '--debug', '-z'], { cwd: root, locators: loc, maxOutputBytes: 1024 * 1024 * 1024 });
  for (const e of parseLsFilesDebug(dbg.stdout)) if (statDiffers(root, e)) uncommitted.add(e.path);
  return { committed: committed.sort(), uncommitted: [...uncommitted].sort() };
}

/**
 * The paths `head` changed since it diverged from `base` (the merge base to
 * `head`): what the other side did, not what the base did meanwhile.
 */
async function divergedPaths(git: GitExec, commonDir: string, base: GitOid, head: GitOid): Promise<string[]> {
  const repo = { gitDir: commonDir };
  const mb = await git.run(['merge-base', base, head], { cwd: commonDir, locators: repo });
  const from = mb.code === 0 ? mb.stdout.toString('utf8').trim() : base;
  if (from === head) return [];
  const r = await git.run(['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', from, head], { cwd: commonDir, locators: repo, maxOutputBytes: 256 * 1024 * 1024 });
  return r.code === 0 ? r.stdout.toString('utf8').split('\0').filter((p) => p !== '').sort() : [];
}

/**
 * Every worktree of the repository, read outside any namespace. `base`: the
 * commit changes are reported against (the target branch's tip, typically).
 */
export async function listExternalWorktrees(git: GitExec, commonDir: string, opts: { readonly base: GitOid; readonly mainCheckout: string | null }): Promise<ExternalWorktree[]> {
  const all = await registeredWorktrees(git.withLocators({ gitDir: commonDir }), commonDir);
  const out: ExternalWorktree[] = [];
  for (const w of all) {
    const root = w.bare ? null : w.path;
    let locked: string | null = null;
    if (w.gitDir !== null && w.gitDir !== commonDir) {
      try {
        locked = readFileSync(join(w.gitDir, 'locked'), 'utf8').trim();
      } catch {
        locked = null;
      }
    }
    let changed: ExternalWorktree['changed'] = null;
    if (root !== null && !w.prunable && w.gitDir !== null) {
      const loc: GitLocators = { gitDir: w.gitDir, commonDir, workTree: root };
      try {
        changed = await changedPaths(git, commonDir, loc, root, opts.base, w.head);
      } catch {
        changed = null;
      }
    }
    const times = [
      root === null ? null : mtimeMs(root),
      w.gitDir === null ? null : mtimeMs(join(w.gitDir, 'HEAD')),
      w.gitDir === null ? null : mtimeMs(join(w.gitDir, 'index')),
      ...(root === null || changed === null ? [] : changed.uncommitted.map((p) => mtimeMs(join(root, p)))),
    ].filter((t): t is number => t !== null);
    out.push({
      path: w.path,
      gitDir: w.gitDir,
      isMainCheckout: root !== null && root === opts.mainCheckout,
      bare: w.bare,
      prunable: w.prunable,
      branch: w.branch,
      head: w.head === null ? null : gitOid(w.head),
      occupancy: w.occupancy,
      locked,
      origin: inferOrigin(w.path, w.branch),
      lastModified: times.length === 0 ? null : Math.max(...times),
      changed,
    });
  }
  return out;
}

/** One module's write scope, of a mission in flight. */
export interface WriteScopeOf {
  readonly mission: string;
  readonly module: string | null;
  readonly writeScope: readonly string[];
}

/** WI-03: an external worktree, or a branch checked out nowhere, whose changes overlap a module's write scope. */
export interface ExternalOverlap {
  /** The worktree's root; null for a branch checked out nowhere. */
  readonly worktree: string | null;
  readonly branch: string | null;
  readonly origin: WorktreeOrigin;
  readonly mission: string;
  readonly module: string | null;
  /** The overlapping paths, committed (since the branch diverged from the base) or not (staged, or modified by stat). */
  readonly paths: readonly string[];
}

/**
 * WI-03 (at a delivery and at a landing): the external worktrees and the local
 * branches checked out nowhere whose changes, relative to `base`, fall inside
 * a write scope of `scopes`. Not external: the maintainer's checkout
 * (`own`), the pipeline's dispatch worktrees (under `pipelineDir`), the target
 * branch itself. Reads commits, the index and stat data only.
 */
export async function externalOverlaps(
  git: GitExec,
  o: { readonly commonDir: string; readonly base: GitOid; readonly targetBranch: string; readonly own: string; readonly pipelineDir: string; readonly scopes: readonly WriteScopeOf[] },
): Promise<ExternalOverlap[]> {
  if (o.scopes.length === 0) return [];
  const inside = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
  const target = `refs/heads/${o.targetBranch}`;
  const found: Array<{ worktree: string | null; branch: string | null; origin: WorktreeOrigin; changed: string[] }> = [];
  const worktrees = await listExternalWorktrees(git, o.commonDir, { base: o.base, mainCheckout: o.own });
  const checkedOut = new Set(worktrees.map((w) => w.branch).filter((b): b is string => b !== null));
  for (const w of worktrees) {
    if (w.bare || w.prunable || w.isMainCheckout || w.path === o.own || inside(w.path, o.pipelineDir) || w.branch === target || w.changed === null) continue;
    found.push({ worktree: w.path, branch: w.branch, origin: w.origin, changed: [...new Set([...w.changed.committed, ...w.changed.uncommitted])] });
  }
  const refs = await git.run(['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads/'], { cwd: o.commonDir, locators: { gitDir: o.commonDir } });
  if (refs.code === 0) {
    for (const line of refs.stdout.toString('utf8').split('\n')) {
      const [ref, oid] = line.split('\0');
      if (ref === undefined || oid === undefined || ref === '' || ref === target || checkedOut.has(ref)) continue;
      const changed = await divergedPaths(git, o.commonDir, o.base, gitOid(oid));
      if (changed.length > 0) found.push({ worktree: null, branch: ref, origin: inferOrigin('', ref), changed });
    }
  }
  const out: ExternalOverlap[] = [];
  for (const f of found) {
    for (const s of o.scopes) {
      const paths = overlappingPaths(f.changed, s.writeScope).sort();
      if (paths.length > 0) out.push({ worktree: f.worktree, branch: f.branch, origin: f.origin, mission: s.mission, module: s.module, paths });
    }
  }
  return out;
}
