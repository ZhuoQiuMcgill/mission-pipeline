// What one `mp` command works with (design 4.1 §4.1, §5): the project memory, plain git, the
// clock, the environment identity, the runner of the project's declared commands, and the
// program actions the flows need beyond the memory (snapshots, product versions, verification
// runs: actions.ts). A context lives for one `mp` process; nothing here runs in the background.

import { realpathSync } from 'node:fs';
import type { Filler, Memory } from '../memory/index.ts';
import { openMemory, type OpenOptions } from '../memory/index.ts';
import { currentEnvironment, type CurrentEnvironment, type EnvironmentParts } from '../evaluator/index.ts';
import type { Ident } from '../git/objects.ts';
import { PlainGit } from '../git/plainGit.ts';
import type { SnapshotFiles } from '../seat/results.ts';
import { collectCandidate, ensureWorkspace, releaseWorkspace, removeWorkspace, type Collection, type CollectRequest, type GitContext } from '../git/workspace.ts';
import type { FlowPorts, FlowSchedulerPort } from '../flow/ports.ts';
import { gitActions } from './actions.ts';
import { memoryFlowPorts } from './ports.ts';
import { shellRunner, type CommandRunner } from './runs.ts';

/** A Constructor dispatch's worktree (§3.1, §5.4): A4's workspace functions, or a test's. */
export interface WorkspaceOps {
  ensure(dispatch: string, base: string): { readonly path: string; readonly created: boolean };
  remove(dispatch: string): { readonly removed: boolean };
  release(dispatch: string, how: 'ended' | 'abandoned'): { readonly removed: boolean; readonly kept: boolean };
  /** The candidate collected from the worktree at hand-back (§5.3, decision 17). */
  collect(req: CollectRequest): Promise<Collection>;
}

/** The program actions the flows need beyond the memory (snapshot, product, rebind, verify, findSymbol, history): actions.ts gitActions. */
export type GitActions = Pick<FlowSchedulerPort, 'startHolds' | 'composition' | 'snapshot' | 'product' | 'rebind' | 'verify' | 'findSymbol' | 'history'>;

export interface ProcessOptions {
  /** How git runs (default: plain `git` from PATH). */
  readonly git?: PlainGit;
  readonly now?: () => number;
  /** Author and committer of the commits `mp` writes (candidates, snapshot overlays). */
  readonly ident?: Ident;
  /** Tests: the environment observation instead of running the declared version commands. */
  readonly observe?: () => EnvironmentParts;
  /** Runs the project's declared commands (default: the platform's shell). */
  readonly runner?: CommandRunner;
  /** Tests: program actions instead of the git-backed ones (actions.ts). */
  readonly actions?: (ctx: ProcessContext) => GitActions;
  /** Tests: worktree operations instead of git's (A4's workspace.ts). */
  readonly workspaces?: (ctx: ProcessContext) => WorkspaceOps;
  /** The PM's filler for the `mp pm` commands of this process (decision 8). */
  readonly filler?: Filler | null;
  /** The target branch the missions deliver to, and whose head is a mission's base (config.json `targetBranch`; default "main"). */
  readonly targetBranch?: string;
  /** Per declared command (default 30 minutes). */
  readonly commandTimeoutMs?: number;
  /** Tests without a repository: the files of a snapshot commit that hand-back pointers are checked against (null: not checked). Default: git's (seat.ts commitFiles). */
  readonly snapshotFiles?: (commit: string) => SnapshotFiles | null;
}

export interface ProcessContext {
  readonly memory: Memory;
  readonly git: PlainGit;
  readonly projectDir: string;
  readonly now: () => number;
  readonly runner: CommandRunner;
  readonly targetBranch: string;
  readonly commandTimeoutMs: number;
  /** The PM's filler for this process's `mp pm` writes (information only). */
  filler: Filler | null;
  /**
   * Who is handing work over while the process advances (4.1 §3.2, U-13): the hand-back whose
   * advance this is (its dispatch and task), or the PM command; recorded on each task queued then.
   */
  handover: { readonly dispatch: string | null; readonly task: string | null; readonly step: string } | null;
  /** Tests: the snapshot files hand-back pointers are checked against, instead of git's (ProcessOptions.snapshotFiles). */
  readonly snapshotFiles: ((commit: string) => SnapshotFiles | null) | null;
  /** The git package's context (A4). */
  readonly gitCtx: GitContext;
  /** The identity of the commits `mp` writes; `at` (ms) fixes their date (a retry makes the same commit). */
  ident(at?: number): Ident;
  /** The current environment identity (§6.5): observed once per process, recorded when it changed. Call it before any decision that reads labels. */
  environment(): CurrentEnvironment;
  /** The flows' ports on this memory (ports.ts), built once. */
  ports(): FlowPorts;
  /** The program actions (actions.ts). */
  actions(): GitActions;
  /** The Constructor's worktrees. */
  workspaces(): WorkspaceOps;
}

const DEFAULT_IDENT: Ident = { name: 'Mission Pipeline', email: 'mp@localhost' };

/** A context over an open memory (the caller closes the memory). */
export function processContext(memory: Memory, o: ProcessOptions = {}): ProcessContext {
  const git = o.git ?? PlainGit.create();
  let ports: FlowPorts | null = null;
  let actions: GitActions | null = null;
  let workspaces: WorkspaceOps | null = null;
  const ctx: ProcessContext = {
    memory,
    git,
    projectDir: memory.projectDir,
    now: o.now ?? Date.now,
    runner: o.runner ?? shellRunner,
    targetBranch: o.targetBranch ?? 'main',
    commandTimeoutMs: o.commandTimeoutMs ?? 30 * 60_000,
    filler: o.filler ?? null,
    snapshotFiles: o.snapshotFiles ?? null,
    handover: null,
    gitCtx: { memory, git },
    ident(at?: number): Ident {
      const base = o.ident ?? DEFAULT_IDENT;
      if (base.date !== undefined && at === undefined) return base;
      const secs = Math.floor((at ?? ctx.now()) / 1000);
      // "@" marks a Unix time whatever its size (git refuses a bare small one, such as the overlay's fixed 0)
      return { name: base.name, email: base.email, date: `@${secs} +0000` };
    },
    environment(): CurrentEnvironment {
      return currentEnvironment(memory, o.observe !== undefined ? { observe: o.observe } : {});
    },
    ports(): FlowPorts {
      if (ports === null) ports = memoryFlowPorts(ctx);
      return ports;
    },
    actions(): GitActions {
      if (actions === null) actions = o.actions !== undefined ? o.actions(ctx) : gitActions(ctx);
      return actions;
    },
    workspaces(): WorkspaceOps {
      if (workspaces === null) {
        workspaces =
          o.workspaces !== undefined
            ? o.workspaces(ctx)
            : {
                ensure: (dispatch, base) => ensureWorkspace(ctx.gitCtx, { dispatch, base }),
                remove: (dispatch) => removeWorkspace(ctx.gitCtx, dispatch),
                release: (dispatch, how) => releaseWorkspace(ctx.gitCtx, dispatch, how),
                collect: (req) => collectCandidate(ctx.gitCtx, req),
              };
      }
      return workspaces;
    },
  };
  return ctx;
}

/** Open the project's memory and a context on it (`mp` commands). The caller closes `ctx.memory`. */
export function openProcess(projectDir: string, o: ProcessOptions & { readonly open?: OpenOptions } = {}): ProcessContext {
  const git = o.git ?? PlainGit.create();
  const memory = openMemory(realpathSync.native(projectDir), { ...(o.open ?? {}), git: o.open?.git === undefined ? git.runner() : o.open.git });
  return processContext(memory, { ...o, git });
}
