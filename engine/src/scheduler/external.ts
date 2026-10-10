// WI-03 (design 3.11): external worktrees or branches whose changes overlap the write scope of
// an in-flight mission. The scan itself belongs to the git module (it inspects worktrees and
// branches with the safe wrapper); the scheduler calls it periodically and before deliveries,
// matches the changed paths against the write scopes of in-flight tasks, and emits a WI-03
// notice. The default action is to do nothing else: no merge, no adoption.

export interface ExternalWork {
  /** The worktree root, if the work is in a worktree. */
  readonly worktree: string | null;
  readonly branch: string | null;
  /** Paths changed relative to the baseline (committed or not). */
  readonly paths: readonly string[];
  /** Inferred origin (e.g. "codex worktree", "claude subagent"), if known. */
  readonly source: string | null;
}

export interface ExternalWorkScan {
  scan(): Promise<ExternalWork[]>;
}

/** Whether a repository path lies inside a write-scope pattern: an exact path, "dir/**", or "**". */
export function inScope(path: string, pattern: string): boolean {
  if (pattern === '**') return true;
  if (pattern.endsWith('/**')) {
    const dir = pattern.slice(0, -3);
    return path === dir || path.startsWith(`${dir}/`);
  }
  return path === pattern;
}

export function overlappingPaths(paths: readonly string[], scope: readonly string[]): string[] {
  return paths.filter((p) => scope.some((s) => inScope(p, s)));
}
