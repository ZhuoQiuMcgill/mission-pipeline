// External worktrees (design 6.6 v41 "外部工作区"; 3.11 WI-02, WI-03).
//
// The program never creates worktrees (seats work on snapshots made from
// commits, 7.1), so every worktree of the repository is external; only the main
// checkout registered at install time is a landing target. This lists every
// worktree with its branch, HEAD, occupancy, lock, inferred origin, live
// processes, last modification and the paths it changed relative to a base,
// committed and uncommitted: for the PM's layer-2 list, before every landing
// and periodically, and for the scheduler's WI-03 check (overlap with the write
// scopes of missions in flight). It is for explanation and scheduling ONLY: no
// safety rule depends on it, and the inferred origin may be wrong.
//
// Pure reads: plumbing that runs no filter (worktree list, rev-parse,
// diff-tree, ls-tree, ls-files), with each worktree named by its own locators.
// Uncommitted changes are found from the index (staged) and from the index's
// stat data compared with the files (modified), never by hashing through a
// filter, so they are "possibly changed" when only the stat data moved.

import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import type { GitOid } from '../common/ids.ts';
import { gitOid, parseLsFiles } from './objects.ts';
import type { GitLocators, SafeGit } from './safeGit.ts';
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
  /** Live processes whose current directory is inside the worktree. */
  readonly liveProcesses: readonly number[];
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

/** Current directories of live processes, by pid (processes of other users are invisible here). */
function processCwds(): Map<number, string> {
  const out = new Map<number, string>();
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      out.set(pid, readlinkSync(`/proc/${pid}/cwd`));
    } catch {
      /* gone, or not ours */
    }
  }
  return out;
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

async function changedPaths(git: SafeGit, commonDir: string, loc: GitLocators, root: string, base: GitOid, head: GitOid | null): Promise<{ committed: string[]; uncommitted: string[] }> {
  const repo = { gitDir: commonDir };
  let committed: string[] = [];
  if (head !== null) {
    const r = await git.run(['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', base, head], { cwd: commonDir, locators: repo, maxOutputBytes: 256 * 1024 * 1024 });
    if (r.code === 0) committed = r.stdout.toString('utf8').split('\0').filter((p) => p !== '');
  }
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
 * Every worktree of the repository, read outside any namespace. `base`: the
 * commit changes are reported against (the target branch's tip, typically).
 */
export async function listExternalWorktrees(git: SafeGit, commonDir: string, opts: { readonly base: GitOid; readonly mainCheckout: string | null }): Promise<ExternalWorktree[]> {
  const all = await registeredWorktrees(git.withLocators({ gitDir: commonDir }), commonDir);
  const cwds = processCwds();
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
    const live = root === null ? [] : [...cwds].filter(([, cwd]) => cwd === root || cwd.startsWith(root + '/')).map(([pid]) => pid).sort((a, b) => a - b);
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
      liveProcesses: live,
      lastModified: times.length === 0 ? null : Math.max(...times),
      changed,
    });
  }
  return out;
}
