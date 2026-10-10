// The flows over the scheduler process (src/flow): the program actions on the project
// repository, the ports over this scheduler (schedulerFlowPorts), and the engine
// (createFlowEngine). The scheduler reconciles it on every tick and after every accepted
// outcome (Scheduler.attachFlow); main.ts builds it when its configuration names the project.

import { join } from 'node:path';
import { schedulerFlowPorts, type VerifyOptions } from '../flow/actions/index.ts';
import { createFlowEngine } from '../flow/compose.ts';
import type { FlowPorts } from '../flow/ports.ts';
import { discoverRepo, type Ident } from '../git/objects.ts';
import { readTransformDescription } from '../git/representation.ts';
import { SafeGit } from '../git/safeGit.ts';
import type { FlowReconciler, Scheduler } from './scheduler.ts';

export interface FlowConfig {
  /** The project repository (only new objects are written to it). */
  readonly repo: string;
  /** The program's work directory for snapshots, candidates and verification jobs (a Linux filesystem). */
  readonly workDir: string;
  /** The commit missions start from; default: the repository's HEAD when the scheduler starts. */
  readonly base?: string;
  /** Author and committer of the commits the program generates. */
  readonly ident?: Ident;
  /** The user's home, for the user's git configuration the transform description is read from (7.1); default $HOME. */
  readonly userHome?: string;
  readonly gitPath?: string;
  /** 6.5: capacity kept free on the ledger's volume (the recovery reserve and the evaluator pool). */
  readonly disk?: { readonly recoveryReserveBytes: number; readonly evaluatorPoolBytes: number };
  /** Verification runs (7.2): limits, environment, sandbox tools. */
  readonly verify?: Omit<VerifyOptions, 'units'>;
}

/** The flow engine over `s` (createFlowEngine with every flow step). */
export async function composeFlow(s: Scheduler, cfg: FlowConfig): Promise<FlowReconciler> {
  return (await composeFlowParts(s, cfg)).engine;
}

/** The flow engine and the ports it runs on (the scheduler's RPC runs PM requests on the same ports: flowRpc.ts). */
export async function composeFlowParts(s: Scheduler, cfg: FlowConfig): Promise<{ readonly engine: FlowReconciler; readonly ports: FlowPorts }> {
  const git = SafeGit.create({ stateDir: join(s.opts.stateDir, 'git'), ...(cfg.gitPath !== undefined ? { gitPath: cfg.gitPath } : {}) });
  const repo = await discoverRepo(git, cfg.repo);
  const description = await readTransformDescription(git, repo, { home: cfg.userHome ?? process.env['HOME'] ?? '/' });
  const base = cfg.base ?? (await git.text(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: cfg.repo }));
  const ports = schedulerFlowPorts(
    s,
    {
      git,
      repo,
      description,
      workDir: cfg.workDir,
      base: async () => base,
      disk: { reserve: cfg.disk ?? { recoveryReserveBytes: 0, evaluatorPoolBytes: 0 }, sharesVolume: () => false },
      ident: cfg.ident ?? { name: 'Mission Pipeline', email: 'engine@mission-pipeline.invalid' },
    },
    cfg.verify ?? {},
    s.evaluatorCaller(),
  );
  return { engine: createFlowEngine(ports), ports };
}
