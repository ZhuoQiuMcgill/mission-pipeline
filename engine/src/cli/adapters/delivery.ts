// The CLI's thin adapter to delivery (src/delivery/deliver.ts) and landing
// (src/git/landing.ts, landingLedger.ts) — design 6.6 steps 1-8, WI-01/02/05/06.
//
// Those modules are being changed by their owners; everything the CLI needs from
// them goes through this one file, so an API change is fixed here only. The
// adapter is an object (`deliveryAdapter`) whose methods tests can replace.
//
// Gaps (each throws NotImplemented with the exact upstream change):
//  - declared closing checks (6.6 step 5) need the exec run host's ClosingCheckRunner;
//  - the project configuration (9.5) has no reader for declared closing checks yet: the
//    CLI configuration's `closingChecks` is used meanwhile;
//  - "deliver the ref only" (WI-01/02/05/06/19 option) has no ledger record: the choice
//    is the PM action recorded in the CLI's journal and shown with the delivery.

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../common/hash.ts';
import { id, type GitOid, type MissionId, type ObjectVersionId, type OpId, type ProofUnitId } from '../../common/ids.ts';
import { RpcClient } from '../../common/rpc.ts';
import { deliver, type DeliveryResult, type ClosingCheckRunner } from '../../delivery/deliver.ts';
import { openEvaluatorDeliveryView } from '../../delivery/evaluatorView.ts';
import { LedgerDeliveryAuthority, deliveryRefDomain } from '../../delivery/ledgerAuthority.ts';
import { objectTarget, unitTarget, type DeliveryTarget } from '../../delivery/proofView.ts';
import { probeFs, type FsStats, type LedgerReserve } from '../../git/admission.ts';
import { land, manualLandingCommands, type LandingReport, type LandingRequest } from '../../git/landing.ts';
import { LedgerLandingJournal, deliveryLineage, landingAttempts, landingDomain, landingIdentity, summarizeLandingRequest } from '../../git/landingLedger.ts';
import { discoverRepo, gitOid, type RepoLayout } from '../../git/objects.ts';
import { detachDuplicateCheckout, type DetachResult } from '../../git/pmActions.ts';
import { asProgramRef, deliveryRef } from '../../git/refs.ts';
import { readTransformDescription, type TransformDescription } from '../../git/representation.ts';
import { SafeGit } from '../../git/safeGit.ts';
import type { ProjectConfig } from '../config.ts';
import { ledgerPathsOf } from '../config.ts';
import type { Ctx } from '../context.ts';
import { CliError, EXIT, NotImplemented } from '../errors.ts';
import type { DeliveryRecorded } from '../layer2.ts';

/** The ledger volume as the install found it (6.6, the volume holding the ledger): filesystem ids on it, and its reserve. */
export interface LedgerVolume {
  readonly fsIds: readonly string[];
  readonly reserve: LedgerReserve;
}

const DEFAULT_RESERVE: LedgerReserve = { recoveryReserveBytes: 2 * 2 ** 30, evaluatorPoolBytes: 2 * 2 ** 30 };

export function ledgerVolumeOf(ctx: Ctx): LedgerVolume {
  const raw = (ctx.config as unknown as { ledgerVolume?: Partial<LedgerVolume> }).ledgerVolume;
  let ids = raw?.fsIds ?? [];
  if (ids.length === 0) {
    try {
      ids = [probeFs(ctx.config.ledgerRoot).id];
    } catch {
      ids = [];
    }
  }
  return { fsIds: ids, reserve: raw?.reserve ?? DEFAULT_RESERVE };
}

/** A program scratch directory outside the repository (created on first use). */
function scratch(ctx: Ctx, name: string): string {
  const d = join(ctx.config.stateDir, name);
  mkdirSync(d, { recursive: true });
  return d;
}

function safeGit(ctx: Ctx): SafeGit {
  return SafeGit.create({ stateDir: join(ctx.config.stateDir, 'git') });
}

function userEnv(ctx: Ctx): { home: string } {
  return { home: ctx.io.env['HOME'] ?? '/' };
}

function target(s: string): DeliveryTarget {
  return s.startsWith('unit:') ? unitTarget(id<ProofUnitId>(s.slice(5))) : objectTarget(id<ObjectVersionId>(s.replace(/^object:/, '')));
}

/** The transform description a delivery is bound to: the one its placed products were verified under (7.1). */
function boundDescription(ctx: Ctx, rec: DeliveryRecorded): TransformDescription {
  let doc: { manifest?: { entries?: Array<{ object?: { tree?: { transform?: string } | null } }> } };
  try {
    doc = JSON.parse(ctx.content().get(rec.manifest as never).toString('utf8')) as typeof doc;
  } catch (e) {
    throw new CliError('CONTENT_MISSING', `cannot read the delivery manifest ${rec.manifest}: ${(e as Error).message}`, { exitCode: EXIT.FAILED, wi: 'WI-20' });
  }
  const hash = doc.manifest?.entries?.find((e) => e.object?.tree?.transform)?.object?.tree?.transform;
  if (hash === undefined) {
    throw new NotImplemented('reading the transform description a delivery is bound to from its record', 'delivery.recorded (or its manifest) records the bound transform description\'s hash (DeliveryRecord.description), for the landing (6.6 item 5)');
  }
  return JSON.parse(ctx.content().get(hash as never).toString('utf8')) as TransformDescription;
}

export interface DeliverInput {
  readonly op: string;
  readonly mission: string;
  readonly outputs: readonly string[];
  readonly project: ProjectConfig;
}

export interface LandInput {
  readonly op: string;
  readonly delivery: DeliveryRecorded;
  readonly project: ProjectConfig;
  /** WI-02 option 2: allow this landing into the single external worktree that holds the target branch. */
  readonly allowExternal: string | null;
}

export interface LandingSummary {
  readonly landed: boolean | null;
  readonly attempts: { readonly attempts: number; readonly allowed: number; readonly exhausted: boolean } | null;
  readonly refOnly: boolean;
  readonly summary: string;
}

export interface DeliveryAdapter {
  deliver(ctx: Ctx, i: DeliverInput): Promise<DeliveryResult>;
  land(ctx: Ctx, i: LandInput): Promise<LandingReport>;
  manualCommands(ctx: Ctx, rec: DeliveryRecorded, project: ProjectConfig): readonly string[];
  landingState(ctx: Ctx, rec: DeliveryRecorded): Promise<LandingSummary>;
  detachDuplicate(ctx: Ctx, i: { readonly worktree: string; readonly project: ProjectConfig }): Promise<DetachResult>;
}

/** Closing checks declared for the project; the exec run host has no ClosingCheckRunner for the CLI yet. */
function closingChecksOf(project: ProjectConfig): ReadonlyArray<{ id: string; command: readonly string[] }> {
  return (project as unknown as { closingChecks?: Array<{ id: string; command: string[] }> }).closingChecks ?? [];
}

const NO_CHECKS: ClosingCheckRunner = { run: async () => [] };

async function containsCommit(git: SafeGit, repo: RepoLayout, branch: string, commit: string): Promise<boolean | null> {
  try {
    // SafeGit already turns off replace objects, grafts and lazy fetches (6.6 v48, v49).
    const r = await git.run(['merge-base', '--is-ancestor', commit, `refs/heads/${branch}`], { cwd: repo.commonDir, locators: { gitDir: repo.commonDir }, config: [['core.commitGraph', 'false']] });
    return r.code === 0 ? true : r.code === 1 ? false : null;
  } catch {
    return null;
  }
}

export const realDeliveryAdapter: DeliveryAdapter = {
  async deliver(ctx, i) {
    const checks = closingChecksOf(i.project);
    if (checks.length > 0) throw new NotImplemented('re-running the declared closing checks on the delivery candidate (6.6 step 5)', 'the exec run host provides the CLI a ClosingCheckRunner (the interface in src/delivery/deliver.ts), and the project configuration (9.5) gives the declared closing checks');
    if (ctx.config.evaluatorSocket === null) throw new CliError('UNAVAILABLE', 'no evaluator query socket is configured: a delivery needs the derived state (6.6 step 4)', { exitCode: EXIT.UNAVAILABLE, wi: 'WI-11' });
    const git = safeGit(ctx);
    const repo = await discoverRepo(git, i.project.root);
    const mission = id<MissionId>(i.mission);
    const op = id<OpId>(i.op);
    const selected = i.outputs.map(target);
    const evaluator = new RpcClient(ctx.config.evaluatorSocket, 30_000);
    const vol = ledgerVolumeOf(ctx);
    try {
      const view = await openEvaluatorDeliveryView({ dbPath: ledgerPathsOf(ctx.config).db, content: ctx.content(), evaluator, selected });
      const authority = new LedgerDeliveryAuthority({
        client: ctx.ledger(),
        content: ctx.content(),
        gen: null,
        tag: { mission, capabilities: [] },
        lineage: `delivery:${mission}/${op}`,
        domain: deliveryRefDomain(repo, deliveryRef(mission, op)),
      });
      const description = await readTransformDescription(git, repo, userEnv(ctx));
      const ident = { name: 'Mission Pipeline', email: 'mission-pipeline@localhost' };
      return await deliver(
        { key: { mission, op }, repoPath: i.project.root, targetBranch: i.project.targetBranch, selected, description, closingChecks: [], author: ident, committer: ident },
        { git, view, authority, checks: NO_CHECKS, scratchDir: scratch(ctx, 'delivery-scratch'), disk: { reserve: vol.reserve, sharesVolume: (fs: FsStats) => vol.fsIds.includes(fs.id) } },
      );
    } finally {
      evaluator.close();
    }
  },

  async land(ctx, i) {
    const git = safeGit(ctx);
    const repo = await discoverRepo(git, i.project.root);
    const key = { mission: id<MissionId>(i.delivery.mission), op: id<OpId>(i.delivery.delivery) };
    const vol = ledgerVolumeOf(ctx);
    const req: LandingRequest = {
      key,
      repoPath: i.project.root,
      targetBranch: i.project.targetBranch,
      base: gitOid(i.delivery.base) as GitOid,
      delivery: gitOid(i.delivery.commit) as GitOid,
      description: boundDescription(ctx, i.delivery),
      user: userEnv(ctx),
      ledger: { reserve: vol.reserve, sharesVolume: (fs: FsStats) => vol.fsIds.includes(fs.id) },
      mainCheckout: i.project.mainCheckout,
      allowExternal: i.allowExternal,
    };
    // A new attempt gets new ids (landingLedger.ts): the first attempt number without a landing record.
    let attempt = 0;
    for (; attempt < 64; attempt++) {
      const st = await ctx.call('landingState', { landing: landingIdentity(key, attempt).landing });
      if (st === null) break;
    }
    const ids = landingIdentity(key, attempt);
    const journal = new LedgerLandingJournal({
      client: ctx.ledger(),
      content: ctx.content(),
      gen: null,
      landing: ids.landing,
      intent: ids.intent,
      tag: { mission: key.mission, capabilities: [] },
      request: summarizeLandingRequest(req, ctx.content(), landingDomain(repo)),
    });
    return land(req, { git, journal, scratchDir: scratch(ctx, 'landing-scratch') });
  },

  manualCommands(_ctx, rec, project) {
    return manualLandingCommands(project.mainCheckout ?? project.root, asProgramRef(rec.ref));
  },

  async landingState(ctx, rec) {
    const refOnly = ctx.journal.list(1000).some((r) => {
      const j = (r.result as { json?: { refOnly?: boolean; delivery?: string } } | null)?.json;
      return r.command === 'land' && r.state === 'done' && j?.refOnly === true && j.delivery === rec.delivery;
    });
    let attempts: LandingSummary['attempts'] = null;
    try {
      attempts = await landingAttempts(ctx.ledger(), deliveryLineage({ mission: id<MissionId>(rec.mission), op: id<OpId>(rec.delivery) }));
    } catch {
      attempts = null;
    }
    let landed: boolean | null = null;
    const project = ctx.config.projects[0];
    if (project !== undefined) {
      try {
        const git = safeGit(ctx);
        landed = await containsCommit(git, await discoverRepo(git, project.root), project.targetBranch, rec.commit);
      } catch {
        landed = null;
      }
    }
    const state = landed === true ? 'landed (the target branch contains the delivery commit)' : refOnly ? 'delivered, not landed (the PM chose to deliver the ref only)' : landed === false ? 'not landed' : 'whether it landed is unknown';
    const tries = attempts !== null ? `; attempts that reached the push: ${attempts.attempts}/${attempts.allowed}${attempts.exhausted ? ', exhausted (WI-08)' : ''}` : '';
    const summary = `${state}${tries}`;
    return { landed, attempts, refOnly, summary };
  },

  async detachDuplicate(ctx, i) {
    return detachDuplicateCheckout(safeGit(ctx), { repoPath: i.project.root, worktree: i.worktree, targetBranch: i.project.targetBranch });
  },
};

let current: DeliveryAdapter = realDeliveryAdapter;

export function deliveryAdapter(): DeliveryAdapter {
  return current;
}

/** Tests: replace the adapter; returns a function that restores the previous one. */
export function useDeliveryAdapter(a: DeliveryAdapter): () => void {
  const prev = current;
  current = a;
  return () => {
    current = prev;
  };
}

export async function deliveryLandingState(ctx: Ctx, rec: DeliveryRecorded): Promise<LandingSummary> {
  return current.landingState(ctx, rec);
}

/** For JSON output: a stable form of a delivery result. */
export function deliveryJson(r: unknown): unknown {
  return JSON.parse(canonicalJson(r));
}

export function readJsonFile<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}
