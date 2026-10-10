// Delivery, steps 1-6 (design 6.6; 6.1 for the ref; 6.5 for the rebuild limit and disk admission).
//
//   1-2  manifest and consistency (manifest.ts)
//   3    candidate on the target branch's current commit (candidate.ts), each
//        write destination admitted before it is written (6.5; code review r1
//        #12): the repository's objects before the trees and the commit, the
//        snapshot (exact sizes from a dry run) before any of its files
//   4    proof check on the final candidate tree (candidate.ts)
//   5    the declared closing checks rerun on the canonical candidate, through a
//        ClosingCheckRunner (the exec subsystem's run host implements it)
//   6    the ledger authorizes (re-checks stops and the launch id, writes the
//        intent); then refs/mission-pipeline/delivered/<mission>/<op> is CREATED
//        pointing at the delivery commit. Every ref attempt has its own
//        authorization (review r1 #8): when a creation fails and the read-back
//        finds the ref absent (its writer confirmed gone), that intent is
//        finished and a NEW one is authorized before the next write, so a stop
//        committed in between is honoured. While a writer may still run, its
//        intent stays open and the conflict domain held (review r1 #9, WI-14).
//        If the target branch has moved off the candidate's base, the candidate
//        is rebuilt on the new base first; every rebuild is recorded BEFORE it
//        runs (6.5, WI-05), and the ledger refuses one on an exhausted loop
//        (LOOP_EXHAUSTED, WI-08). The program never updates refs/heads/, a
//        worktree or an index (landing, step 7, is separate).
// v50, v51 (6.6, 6.1, WI-13): only a files-backend repository with understood
// extensions gets a program ref, and so a delivery. A reftable repository, or
// one with extensions the program does not understand, is refused before
// anything is built or written (WI-13); a reftable repository can be converted
// with `git refs migrate --ref-format=files`, after which a new delivery runs.
// Step 8's record (manifest, commit, base, ref) goes to the ledger through
// DeliveryAuthority.complete(). Every exit that is an exception in 3.11's table
// sends its notice with the work instruction (review r1 #13): WI-20 (unknown
// targets, unplaced products, a program ref pointing elsewhere or an unsafe
// namespace), WI-19 (a version verified under another transform description),
// WI-21 (closing checks failed), WI-10 (disk admission), WI-14 (a writer still
// running), WI-08 (rebuilds exhausted), WI-13 (git or LFS objects not local:
// never fetched, v49), WI-05, WI-07.

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentHash, EvidenceId, GitOid, MissionId, ObjectVersionId, OpId } from '../common/ids.ts';
import { sha256 } from '../common/hash.ts';
import { admit, commitGenerationDemands, probeFs, roundUp, type AdmissionDecision, type FsProbe, type FsStats, type LedgerReserve } from '../git/admission.ts';
import { discoverRepo, gitOid, repoArgs, type Ident, type RepoLayout } from '../git/objects.ts';
import { createProgramRef, deliveryRef, recoverProgramRef, type CreateRefOptions, type ProgramRefName, type RefRecoveryAction, type RefState } from '../git/refs.ts';
import { repositoryFormat } from '../git/repoFormat.ts';
import { AttributeEvaluator, MissingObjectsError, RepresentationError, transformDescriptionHash, type TransformDescription } from '../git/representation.ts';
import { GitTimeoutError, type ProcessIdentity, type SafeGit } from '../git/safeGit.ts';
import { buildCandidate, checkCandidateProofs, type CandidateAdmission, type OverlayConflict, type ProofCheck } from './candidate.ts';
import { buildManifest, type DeliveryManifest, type ManifestConflict } from './manifest.ts';
import type { DeliveryProofView, DeliveryTarget } from './proofView.ts';

/** 6.5: delivery rebuilds per work lineage. */
export const DELIVERY_REBUILD_LIMIT = 3;

export interface DeliveryKey {
  readonly mission: MissionId;
  readonly op: OpId;
}

/** A closing check declared in the project configuration (9.5), rerun on the candidate (6.6 step 5). */
export interface ClosingCheck {
  readonly id: string;
  readonly command: readonly string[];
}

export interface ClosingCheckOutcome {
  readonly id: string;
  readonly passed: boolean;
  /** The run's evidence record, once the run host has registered it. */
  readonly evidence: EvidenceId | null;
  readonly detail: string;
}

/** Runs the declared closing checks on the canonical candidate (closed runs through the exec run host, 7.2-7.3). */
export interface ClosingCheckRunner {
  run(request: {
    readonly key: DeliveryKey;
    readonly commit: GitOid;
    /** The canonical candidate snapshot (7.1): the checks run on these bytes. */
    readonly snapshotDir: string;
    /** The bound transform description's hash (7.1). */
    readonly transform: ContentHash;
    readonly checks: readonly ClosingCheck[];
  }): Promise<readonly ClosingCheckOutcome[]>;
}

export interface DeliveryIntent {
  readonly ref: ProgramRefName;
  readonly commit: GitOid;
  readonly base: GitOid;
  /** On the ref writer's command line, so recovery can find it (6.1 v34). */
  readonly token: string;
  /**
   * The delivery this ref creates (6.6 授权): the ledger checks it is not withdrawn
   * or superseded (DELIVERY_NOT_CURRENT) and keeps it on the intent, so recovery
   * can record step 8 from it after a crash between the ref and the record.
   */
  readonly record: DeliveryRecord;
}

/** What the record of a finished delivery holds (6.6 step 8). */
export interface DeliveryRecord {
  readonly key: DeliveryKey;
  /** The target branch the delivery was built for (the ledger records it; landing must name the same one). */
  readonly targetBranch: string;
  readonly manifest: DeliveryManifest;
  readonly base: GitOid;
  readonly commit: GitOid;
  readonly ref: ProgramRefName;
  readonly proof: ProofCheck;
  readonly checks: readonly ClosingCheckOutcome[];
  /** Rebuilds this lineage has used, including this delivery's. */
  readonly rebuilds: number;
  /** Landing (step 7) is separate; whether the target contains the commit is read from git when shown. */
  readonly landed: false;
}

/** 6.5: a rebuild is recorded before it runs; the ledger refuses one on an exhausted loop (LOOP_EXHAUSTED, WI-08). */
export type RebuildRecord = { readonly kind: 'recorded'; readonly total: number } | { readonly kind: 'exhausted'; readonly detail: string };

/** The ledger side of a delivery. Every method resolves only once its record is durable. */
export interface DeliveryAuthority {
  /** 6.5: rebuilds this work lineage has used, and its limit (3 plus any granted extra attempts). */
  rebuildBudget(key: DeliveryKey): Promise<{ readonly used: number; readonly limit: number }>;
  /**
   * 6.1: re-check stop limits and the initiator's launch id, and write a NEW
   * intent. Every call is a new authorization attempt with its own identity,
   * never the replay of an earlier one (review r1 #8). Refused after a stop.
   */
  authorize(key: DeliveryKey, intent: DeliveryIntent): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  /** 6.1 v34: the ref writer's pid, start time and boot id, recorded in the intent as soon as it starts. */
  recordRefWriter(key: DeliveryKey, writer: ProcessIdentity): Promise<void>;
  /**
   * The current intent ended without a delivery: superseded by a rebuild, the
   * ref absent after its writer was confirmed gone, or the ref someone else's.
   * Called only once its executor (if any) is gone and the ref's state was read
   * back (6.1); never while a writer may still run (review r1 #9).
   */
  finish(key: DeliveryKey, outcome: 'failed'): Promise<void>;
  /** 6.5: one more rebuild on a new base, recorded BEFORE the rebuild runs (`signature` identifies it). */
  recordRebuild(key: DeliveryKey, signature: string): Promise<RebuildRecord>;
  /** 6.6 step 8, and the intent done (its writer gone, the ref read back). */
  complete(key: DeliveryKey, record: DeliveryRecord): Promise<void>;
  /** An exception notice for the PM with its work instruction (3.11): the trigger facts and the default action taken. */
  notify(key: DeliveryKey, notice: DeliveryNotice): Promise<void>;
}

/**
 * 3.11: an exception notice from a delivery, with its work instruction from the
 * exception table (review r1 #13): WI-05 (the target keeps moving: still not
 * quiet after an hour), WI-07 (a selected object's content changed on the
 * candidate), WI-08 (the rebuilds are used up), WI-10 (a write destination lacks
 * space or inodes, or a space reminder), WI-13 (git or LFS objects the
 * candidate needs are not local; never fetched, v49), WI-14 (the ref's writer is still
 * running), WI-19 (a version verified under another transform description),
 * WI-20 (unknown targets, unplaced products, a program ref pointing elsewhere or
 * an unsafe namespace), WI-21 (the candidate's closing checks failed).
 */
export interface DeliveryNotice {
  readonly wi: 'WI-05' | 'WI-07' | 'WI-08' | 'WI-10' | 'WI-13' | 'WI-14' | 'WI-19' | 'WI-20' | 'WI-21';
  readonly category: string;
  readonly trigger: string;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly defaultAction: string;
}

/**
 * WI-05: how long the target branch must stay unmoved before each rebuild
 * (default 5 minutes), how often it is read, and after how long without a quiet
 * period the PM is told (default 1 hour; the wait goes on).
 */
export interface QuietPolicy {
  readonly quietMs: number;
  readonly pollMs: number;
  readonly notifyAfterMs?: number;
}

export const DEFAULT_QUIET: QuietPolicy = { quietMs: 5 * 60_000, pollMs: 5_000, notifyAfterMs: 60 * 60_000 };

export interface DeliveryRequest {
  readonly key: DeliveryKey;
  /** Any directory of the repository. */
  readonly repoPath: string;
  readonly targetBranch: string;
  readonly selected: readonly DeliveryTarget[];
  /** The transform description the delivery is bound to (7.1). */
  readonly description: TransformDescription;
  readonly closingChecks: readonly ClosingCheck[];
  readonly author: Ident;
  readonly committer: Ident;
}

/** Where the delivery's writes are admitted (6.5): the ledger's reserve on its own volume. */
export interface DeliveryDisk {
  readonly reserve: LedgerReserve;
  /** True when a destination is on the volume that holds the ledger (found at install time, 6.6). */
  readonly sharesVolume: (fs: FsStats) => boolean;
  /** Filesystem statistics of a path (tests inject them); default: the real statfs. */
  readonly probe?: FsProbe;
}

export interface DeliveryDeps {
  readonly git: SafeGit;
  readonly view: DeliveryProofView;
  readonly authority: DeliveryAuthority;
  readonly checks: ClosingCheckRunner;
  /** Program scratch space outside the repository (attribute evaluation, candidate snapshots). */
  readonly scratchDir: string;
  /** Disk admission of the candidate's writes (6.5, review r1 #12). */
  readonly disk: DeliveryDisk;
  /** How long to wait for a still-running writer of an earlier attempt before reporting it (default 5 s). */
  readonly writerWaitMs?: number;
  /**
   * The program's state directory for the ref writer's records (review r2 #2,
   * #3): durable, outside the repository; default `<scratchDir>/ref-writes`.
   */
  readonly refRecordDir?: string;
  /** Tests only: passed to the ref writer (stop points, an injected link failure). */
  readonly testRefOptions?: Pick<CreateRefOptions, 'testPause' | 'testFailLink'>;
  /** WI-05: a rebuild waits until the target branch has been quiet this long (default 5 minutes). */
  readonly quiet?: QuietPolicy;
}

export type DeliveryResult =
  /** Step 2: the scheduler creates an integration task. */
  | { readonly kind: 'incompatible'; readonly conflicts: readonly ManifestConflict[] }
  | { readonly kind: 'unknown-targets'; readonly missing: readonly DeliveryTarget[] }
  /** Product versions recorded without a commit and write scope (5.1): nothing to deliver their files from. */
  | { readonly kind: 'unplaced-products'; readonly versions: readonly ObjectVersionId[] }
  /** Step 3: conflicts for an integration task. */
  | { readonly kind: 'conflict'; readonly base: GitOid; readonly conflicts: readonly OverlayConflict[] }
  /** 7.1: re-materialize and re-verify these versions under the bound description. */
  | { readonly kind: 'description-mismatch'; readonly versions: readonly ObjectVersionId[] }
  /** Step 5 (WI-21): no delivery ref; the candidate commit and the failure evidence are kept; no automatic rebuild. */
  | { readonly kind: 'checks-failed'; readonly base: GitOid; readonly commit: GitOid; readonly outcomes: readonly ClosingCheckOutcome[]; readonly proof: ProofCheck }
  /**
   * v49 (6.6, 7.1; WI-13): git objects (a partial or shallow clone) or LFS objects the candidate needs are not
   * usable locally; nothing was fetched. Missing git objects are found before anything is written.
   */
  | { readonly kind: 'objects-unavailable'; readonly code: string; readonly objects: readonly string[]; readonly paths: readonly string[] }
  /** 6.5 (WI-10): a write destination lacks space or inodes; `objects`: nothing was written; `snapshot`: no snapshot file was. */
  | { readonly kind: 'insufficient-space'; readonly stage: 'objects' | 'snapshot'; readonly reasons: readonly string[] }
  | { readonly kind: 'authorization-refused'; readonly reason: string }
  /** 6.5: the lineage used its rebuilds; Secretary or the user decides (6.5 "耗尽之后"). */
  | { readonly kind: 'rebuild-limit-exhausted'; readonly rebuilds: number }
  /** 6.1: the program namespace was changed from outside: never redo, never record completion; alert the user. */
  | { readonly kind: 'ref-tampered'; readonly ref: ProgramRefName; readonly state: RefState }
  /**
   * A writer of this ref still runs (6.1 v34, WI-14): its intent stays open and
   * the conflict domain held. resumeDeliveryRef() waits for it or ends it,
   * reads the ref back, and only then finishes (`pending` carries what it needs).
   */
  | { readonly kind: 'ref-writer-running'; readonly processes: readonly ProcessIdentity[]; readonly pending: PendingDelivery }
  /** The ref was not created and is absent, its writer confirmed gone: the intent is finished; deliver again (it re-authorizes). */
  | { readonly kind: 'ref-not-created'; readonly ref: ProgramRefName; readonly detail: string }
  /**
   * review r2 #3 (WI-14): a lock the program cannot prove is its own holds the
   * ref's name (another git process, or a writer that died before recording it).
   * It is never removed; the intent stays pending; resumeDeliveryRef() continues
   * once its owner has finished or removed it.
   */
  | { readonly kind: 'ref-lock-held'; readonly lock: string; readonly pending: PendingDelivery }
  /**
   * v50, v51 (WI-13): a reftable repository, or extensions the program does not
   * understand: nothing was built and nothing written, no ref.
   */
  | { readonly kind: 'repository-unsupported'; readonly detail: string; readonly extensions: readonly string[] }
  | { readonly kind: 'delivered'; readonly record: DeliveryRecord };

/** What resumeDeliveryRef needs to finish a delivery whose ref writer was still running. */
export interface PendingDelivery {
  readonly repo: RepoLayout;
  readonly record: DeliveryRecord;
  readonly writer: ProcessIdentity | null;
  /** Where the writer's record is kept (review r2 #2, #3). */
  readonly recordDir: string;
}

export function deliveryIntentToken(key: DeliveryKey): string {
  return `delivery-${sha256(`${key.mission}\0${key.op}`).slice(0, 32)}`;
}

/**
 * WI-05 (3.11, v42): before each rebuild, wait until the target branch has not
 * moved for `quietMs`; returns the tip it settled on. The wait is not counted;
 * after `notifyAfterMs` without a quiet period the PM is told once, and the wait
 * goes on. The rebuild that follows always counts.
 */
async function waitQuiet(git: SafeGit, repo: RepoLayout, branch: string, seen: GitOid, q: QuietPolicy, tooLong: (waitedMs: number, tips: readonly GitOid[]) => Promise<void>): Promise<GitOid> {
  let tip = seen;
  const tips: GitOid[] = [seen];
  const began = Date.now();
  let since = began;
  let told = false;
  for (;;) {
    const left = q.quietMs - (Date.now() - since);
    if (left <= 0) return tip;
    await new Promise((r) => setTimeout(r, Math.min(q.pollMs, left)));
    const now = await targetCommit(git, repo, branch);
    if (now !== tip) {
      tip = now;
      tips.push(now);
      since = Date.now();
    }
    if (!told && q.notifyAfterMs !== undefined && Date.now() - began >= q.notifyAfterMs) {
      told = true;
      await tooLong(Date.now() - began, tips);
    }
  }
}

async function targetCommit(git: SafeGit, repo: RepoLayout, branch: string): Promise<GitOid> {
  const r = await git.run([...repoArgs(repo), 'rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`], {
    cwd: repo.commonDir,
  });
  if (r.code !== 0) throw new Error(`target branch ${branch} does not exist`);
  return gitOid(r.stdout.toString('utf8').trim());
}

function describeManifest(manifest: DeliveryManifest): string {
  const lines = manifest.entries.map((e) => `  ${e.object.id}${e.unit !== null ? ` (unit ${e.unit})` : ''}: ${e.label}`);
  return `Delivery of ${manifest.selected.map((t) => t.id).join(', ')} as of revision ${manifest.revision}\n\n${lines.join('\n')}\n`;
}

/** The candidate's write destinations, admitted per filesystem with the ledger's reserve on its volume (6.5). */
function candidateAdmission(repo: RepoLayout, snapshotParent: string, disk: DeliveryDisk): CandidateAdmission {
  const probe = disk.probe ?? probeFs;
  return {
    objects: (newObjects) => {
      const fs = probe(join(repo.commonDir, 'objects'));
      return admit(commitGenerationDemands({ objects: { fs, sharesLedgerVolume: disk.sharesVolume(fs), newObjects }, lfs: null, temp: null }), disk.reserve);
    },
    snapshot: (fileSizes, directories) => {
      const fs = probe(snapshotParent);
      let data = 0;
      for (const size of fileSizes) data += roundUp(size, fs.blockSize);
      const entries = fileSizes.length + directories;
      return admit(
        [{ destination: 'candidate snapshot', fs, dataBytes: data, metadataEntries: entries, inodes: entries, fixedBytes: 0, sharesLedgerVolume: disk.sharesVolume(fs) }],
        disk.reserve,
      );
    },
  };
}

function spaceNotice(stage: 'objects' | 'snapshot', d: AdmissionDecision, key: DeliveryKey): DeliveryNotice {
  return {
    wi: 'WI-10',
    category: 'delivery-disk-admission',
    trigger: `not enough space to ${stage === 'objects' ? 'write the delivery candidate\'s objects' : 'materialize the delivery candidate'}: ${d.reasons.join('; ')}`,
    facts: { stage, filesystems: d.filesystems, delivery: key },
    defaultAction:
      stage === 'objects'
        ? 'nothing was written; this delivery is resource-blocked (6.5) until space is freed, then it is started again; other work goes on'
        : 'the candidate\'s trees and commit (admitted) exist, no snapshot file was written; this delivery is resource-blocked (6.5) until space is freed; other work goes on',
  };
}

export async function deliver(req: DeliveryRequest, deps: DeliveryDeps): Promise<DeliveryResult> {
  const { git, view, authority } = deps;

  // Steps 1-2.
  const m = buildManifest(view, req.selected);
  if (m.kind === 'unknown') {
    await authority.notify(req.key, {
      wi: 'WI-20',
      category: 'delivery-unknown-targets',
      trigger: `the delivery names objects or proof units the proof view does not know: ${m.missing.map((t) => `${t.kind}:${t.id}`).join(', ')}`,
      facts: { missing: m.missing, revision: view.revision, delivery: req.key },
      defaultAction: 'nothing is built or delivered; the request is refused as it stands; other work goes on',
    });
    return { kind: 'unknown-targets', missing: m.missing };
  }
  if (m.kind === 'unplaced') {
    await authority.notify(req.key, {
      wi: 'WI-20',
      category: 'delivery-unplaced-products',
      trigger: `product versions in the delivery have no commit and write scope to deliver their files from: ${m.versions.join(', ')}`,
      facts: { versions: m.versions, revision: view.revision, delivery: req.key },
      defaultAction: 'nothing is built or delivered; the record is not completed; other work goes on',
    });
    return { kind: 'unplaced-products', versions: m.versions };
  }
  if (m.kind === 'incompatible') return { kind: 'incompatible', conflicts: m.conflicts };
  const manifest = m.manifest;

  const repo = await discoverRepo(git, req.repoPath);
  const valid = await git.run([...repoArgs(repo), 'check-ref-format', `refs/heads/${req.targetBranch}`], { cwd: repo.commonDir });
  if (valid.code !== 0) throw new TypeError(`${req.targetBranch} is not a valid branch name`);
  // v50, v51: only the files ref backend with understood extensions gets a delivery: otherwise nothing at all (WI-13).
  const format = await repositoryFormat(git, repo);
  if (format.kind === 'reftable') {
    const detail = 'the repository stores refs in reftable: the program creates no ref and no delivery there';
    await authority.notify(req.key, {
      wi: 'WI-13',
      category: 'delivery-repository-unsupported',
      trigger: detail,
      facts: { extensions: ['extensions.refStorage=reftable'], repository: repo.commonDir, delivery: req.key },
      defaultAction:
        `nothing is built, no ref is created and the repository is not written; other work goes on (the repository is still read, dispatched and produced from); ` +
        `to deliver, the user converts it with \`git -C ${repo.worktree ?? repo.commonDir} refs migrate --ref-format=files\`, after which a new delivery runs`,
    });
    return { kind: 'repository-unsupported', detail, extensions: ['extensions.refStorage=reftable'] };
  }
  if (format.kind === 'unsupported') {
    await authority.notify(req.key, {
      wi: 'WI-13',
      category: 'delivery-repository-unsupported',
      trigger: format.detail,
      facts: { extensions: format.extensions, repository: repo.commonDir, delivery: req.key },
      defaultAction: 'nothing is built, no ref is created and the repository is not written; other work goes on; the user merges the delivered versions by hand, or the extensions are removed',
    });
    return { kind: 'repository-unsupported', detail: format.detail, extensions: format.extensions };
  }
  const ref = deliveryRef(req.key.mission, req.key.op);
  const token = deliveryIntentToken(req.key);
  const scratch = mkdtempSync(join(deps.scratchDir, 'mp-deliver-'));
  const attributes = await AttributeEvaluator.create(git, repo, req.description, scratch);
  const budget = await authority.rebuildBudget(req.key);
  let rebuilds = budget.used;
  const limit = budget.limit;
  const quiet = deps.quiet ?? DEFAULT_QUIET;
  const admission = candidateAdmission(repo, scratch, deps.disk);
  try {
    let base = await targetCommit(git, repo, req.targetBranch);
    const bases: GitOid[] = [base];
    const exhausted = async (now: GitOid, detail: string | null): Promise<DeliveryResult> => {
      // v42: at the cap the delivery is "exhausted" (WI-08): the quiet period never clears it.
      await authority.notify(req.key, {
        wi: 'WI-08',
        category: 'delivery-rebuild-exhausted',
        trigger: `the target branch ${req.targetBranch} kept moving (not a task failure): ${rebuilds} rebuild(s), limit ${limit}${detail !== null ? `; the ledger refused another: ${detail}` : ''}`,
        facts: { loop: 'delivery-rebuild', rebuilds, limit, bases: [...bases, now], delivery: req.key },
        defaultAction: 'this delivery stops rebuilding ("exhausted"); other work goes on; Secretary may grant one extra of up to 2 rebuilds, after that the user decides',
      });
      return { kind: 'rebuild-limit-exhausted', rebuilds };
    };
    outer: for (let attempt = 0; ; attempt++) {
      // Step 3.
      const snapshotDir = join(scratch, `candidate-${attempt}`);
      let c: Awaited<ReturnType<typeof buildCandidate>>;
      try {
        c = await buildCandidate({
          git,
          repo,
          manifest,
          base,
          attributes,
          snapshotDir,
          message: describeManifest(manifest),
          author: req.author,
          committer: req.committer,
          admission,
        });
      } catch (e) {
        // v49 (6.6, 7.1): objects that are not local are never fetched; the delivery waits for them (WI-13).
        const lfs = e instanceof RepresentationError && (e.code === 'lfs-object-missing' || e.code === 'lfs-object-corrupt');
        if (!(e instanceof MissingObjectsError) && !lfs) throw e;
        const objects = e instanceof MissingObjectsError ? e.objects : [];
        await authority.notify(req.key, {
          wi: 'WI-13',
          category: lfs ? 'delivery-lfs-objects-unavailable' : 'delivery-objects-missing',
          trigger: `the delivery candidate needs objects that are not usable locally: ${e.message}`,
          facts: { code: e.code, objects, paths: e.paths, base, delivery: req.key },
          defaultAction:
            'nothing is delivered and nothing is fetched (no network, no credentials); other work goes on; once the objects are local ' +
            (lfs ? '(`git lfs fetch`; corrupt objects: `git lfs fsck` first) ' : '(fetch them into the repository, or use a full clone) ') +
            'the delivery is started again',
        });
        return { kind: 'objects-unavailable', code: e.code, objects, paths: e.paths };
      }
      if (c.kind === 'conflict') return { kind: 'conflict', base: c.base, conflicts: c.conflicts };
      if (c.kind === 'description-mismatch') {
        await authority.notify(req.key, {
          wi: 'WI-19',
          category: 'transform-description-changed',
          trigger: `versions in the delivery were verified under another transform description than the delivery's (${c.expected}): ${c.versions.join(', ')}`,
          facts: { expected: c.expected, versions: c.versions, delivery: req.key },
          defaultAction: 'no candidate is built and no ref is created; no automatic rebuild: these versions are re-materialized and re-verified under the bound description, or the settings are changed back',
        });
        return { kind: 'description-mismatch', versions: c.versions };
      }
      if (c.kind === 'not-admitted') {
        await authority.notify(req.key, spaceNotice(c.stage, c.decision, req.key));
        return { kind: 'insufficient-space', stage: c.stage, reasons: c.decision.reasons };
      }
      const candidate = c.candidate;
      // Step 4.
      const proof = await checkCandidateProofs({ git, repo, view, manifest, candidate });
      // Step 5.
      const outcomes = await deps.checks.run({
        key: req.key,
        commit: candidate.commit,
        snapshotDir: candidate.snapshotDir,
        transform: transformDescriptionHash(req.description),
        checks: req.closingChecks,
      });
      const ran = new Set(outcomes.map((x) => x.id));
      const notRun = req.closingChecks.filter((x) => !ran.has(x.id));
      if (notRun.length > 0 || outcomes.some((x) => !x.passed)) {
        const all = [...outcomes, ...notRun.map((x) => ({ id: x.id, passed: false, evidence: null, detail: 'not run' }))];
        // WI-21 (v43): no ref; the candidate (its commit) and the failure evidence are kept; no automatic rebuild.
        await authority.notify(req.key, {
          wi: 'WI-21',
          category: 'delivery-closing-checks-failed',
          trigger: `closing checks failed on the delivery candidate ${candidate.commit} (base ${base}): ${all.filter((x) => !x.passed).map((x) => x.id).join(', ')}`,
          facts: { base, commit: candidate.commit, failed: all.filter((x) => !x.passed), delivery: req.key },
          defaultAction: 'no delivery ref is created; the candidate commit and the failing checks\' evidence are kept; no automatic rebuild (a rebuild as it stands would fail the same way); other work goes on',
        });
        return { kind: 'checks-failed', base, commit: candidate.commit, outcomes: all, proof };
      }

      // Step 6: the candidate must still sit on the target's tip; otherwise rebuild (6.5 limit, WI-05).
      const rebuildOn = async (now: GitOid): Promise<DeliveryResult | null> => {
        if (rebuilds >= limit) return exhausted(now, null);
        // WI-05: wait until the target has been quiet, then rebuild on the tip it settled on; every rebuild counts.
        const settled = await waitQuiet(git, repo, req.targetBranch, now, quiet, async (waitedMs, tips) => {
          await authority.notify(req.key, {
            wi: 'WI-05',
            category: 'delivery-target-busy',
            trigger: `the target branch ${req.targetBranch} has not been quiet for ${Math.round(quiet.quietMs / 60_000)} minute(s) in ${Math.round(waitedMs / 60_000)} minute(s): it keeps moving (not a task failure)`,
            facts: { tips, rebuilds, limit, delivery: req.key },
            defaultAction: 'the delivery keeps waiting for a quiet period before rebuilding; waiting is not counted, every rebuild is',
          });
        });
        // Recorded BEFORE the rebuild runs; the signature is the new base: rebuilds onto different bases are not "no progress" (6.5).
        const rec = await authority.recordRebuild(req.key, `base-moved:${settled}`);
        if (rec.kind === 'exhausted') return exhausted(settled, rec.detail);
        rebuilds = rec.total;
        base = settled;
        bases.push(settled);
        rmSync(snapshotDir, { recursive: true, force: true });
        return null;
      };
      let now = await targetCommit(git, repo, req.targetBranch);
      if (now !== base) {
        const ended = await rebuildOn(now);
        if (ended !== null) return ended;
        continue;
      }
      const record: DeliveryRecord = { key: req.key, targetBranch: req.targetBranch, manifest, base, commit: candidate.commit, ref, proof, checks: outcomes, rebuilds, landed: false };
      const recordDir = deps.refRecordDir ?? join(deps.scratchDir, 'ref-writes');
      // Every ref attempt is authorized anew (review r1 #8): a stop committed after a failed attempt refuses the next.
      for (let refTry = 0; ; refTry++) {
        const auth = await authority.authorize(req.key, { ref, commit: candidate.commit, base, token, record });
        if (!auth.ok) return { kind: 'authorization-refused', reason: auth.reason };
        // Moved between the check and the authorization: the authorized intent is for a stale candidate.
        now = await targetCommit(git, repo, req.targetBranch);
        if (now !== base) {
          await authority.finish(req.key, 'failed');
          const ended = await rebuildOn(now);
          if (ended !== null) return ended;
          continue outer;
        }
        const created = await createDeliveryRef(git, repo, ref, candidate.commit, token, req.key, authority, deps.writerWaitMs ?? 5_000, recordDir, deps.testRefOptions ?? {});
        if (created.kind === 'tampered') {
          await authority.finish(req.key, 'failed');
          await authority.notify(req.key, tamperedNotice(ref, candidate.commit, created.state, created.paths));
          return { kind: 'ref-tampered', ref, state: created.state };
        }
        if (created.kind === 'unsupported') {
          // review r2 #4: a filesystem without hard links (or a repository converted meanwhile): no program ref there.
          await authority.finish(req.key, 'failed');
          await authority.notify(req.key, {
            wi: 'WI-13',
            category: 'delivery-repository-unsupported',
            trigger: created.detail,
            facts: { ref, repository: repo.commonDir, delivery: req.key },
            defaultAction: 'no ref was created and nothing was written; other work goes on; the user merges the delivered versions by hand, or moves the repository to a filesystem with hard links',
          });
          return { kind: 'repository-unsupported', detail: created.detail, extensions: [] };
        }
        if (created.kind === 'lock-held') {
          // review r2 #3: never removed; the intent stays pending, the domain held, until the lock's owner is done.
          await authority.notify(req.key, lockNotice(ref, created.lock, req.key));
          return { kind: 'ref-lock-held', lock: created.lock, pending: { repo, record, writer: created.writer, recordDir } };
        }
        if (created.kind === 'writer-running') {
          // review r1 #9: the intent stays open (pending verification) and the domain held until the writer is gone.
          await authority.notify(req.key, {
            wi: 'WI-14',
            category: 'delivery-ref-writer-running',
            trigger: `a writer of ${ref} is still running after ${deps.writerWaitMs ?? 5_000} ms: ${created.processes.map((p) => p.pid).join(', ')}`,
            facts: { ref, commit: candidate.commit, processes: created.processes, delivery: req.key },
            defaultAction: 'the delivery waits: its authorization stays open and nothing else writes this ref; once the writer has exited (or was ended and confirmed gone) the ref is read back and the delivery finished',
          });
          return { kind: 'ref-writer-running', processes: created.processes, pending: { repo, record, writer: created.writer, recordDir } };
        }
        if (created.kind === 'not-done') {
          // Absent, its writer confirmed gone and any stale lock of it removed: this intent ends here.
          await authority.finish(req.key, 'failed');
          if (refTry >= 1) return { kind: 'ref-not-created', ref, detail: created.detail };
          continue;
        }
        await authority.complete(req.key, record);
        if (proof.needsReverification.length > 0) {
          // WI-07: these versions changed on the candidate; they are delivered as not fully proven until re-accepted.
          await authority.notify(req.key, {
            wi: 'WI-07',
            category: 'delivery-object-changed',
            trigger: `${proof.needsReverification.length} selected version(s) have different content on the delivery candidate than the accepted versions`,
            facts: { needsReverification: proof.needsReverification, commit: candidate.commit },
            defaultAction: 'register the new product versions and schedule re-verification and acceptance; until then they are delivered as not fully proven',
          });
        }
        return { kind: 'delivered', record };
      }
    }
  } finally {
    attributes.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
}

type RefAttempt =
  | { readonly kind: 'created' }
  | { readonly kind: 'tampered'; readonly state: RefState; readonly paths?: readonly string[] }
  | { readonly kind: 'writer-running'; readonly processes: readonly ProcessIdentity[]; readonly writer: ProcessIdentity | null }
  | { readonly kind: 'lock-held'; readonly lock: string; readonly writer: ProcessIdentity | null }
  | { readonly kind: 'unsupported'; readonly detail: string }
  | { readonly kind: 'not-done'; readonly detail: string };

function tamperedNotice(ref: ProgramRefName, commit: GitOid, state: RefState, paths: readonly string[] | undefined): DeliveryNotice {
  return {
    wi: 'WI-20',
    category: 'program-namespace-mismatch',
    trigger:
      paths !== undefined && paths.length > 0
        ? `the program's writer linked ${ref} into a directory that was moved out of its namespace and then died: it is now ${paths.join(', ')}`
        : state.kind === 'unsafe-namespace'
          ? `the program's ref namespace is not safe to write: ${state.detail}`
          : `${ref} exists and points to another commit than the delivery commit ${commit}`,
    facts: { ref, expected: commit, state, ...(paths !== undefined ? { escapedTo: paths } : {}) },
    defaultAction:
      'the ref is not overwritten, not redone and not deleted, no completion is recorded, nothing is written through the namespace; this delivery stays to be verified',
  };
}

function lockNotice(ref: ProgramRefName, lock: string, key: DeliveryKey): DeliveryNotice {
  return {
    wi: 'WI-14',
    category: 'delivery-ref-lock-held',
    trigger: `${lock} holds the delivery ref's name and the program cannot prove it created it (another git command may be using it right now)`,
    facts: { ref, lock, delivery: key },
    defaultAction:
      'the lock is never removed by the program; the delivery waits with its authorization open; ask its owner (a running git command, the user or an agent) to finish or remove it, then the delivery resumes',
  };
}

/**
 * One creation of the delivery ref under the current authorization (6.1). A
 * failure is read back only once every writer of it is confirmed gone; a lock
 * is removed then only if it is provably the program's writer's own (review r2
 * #3). An absent ref is `not-done`: the caller finishes this intent and
 * authorizes a new one before writing again.
 */
async function createDeliveryRef(
  git: SafeGit,
  repo: RepoLayout,
  ref: ProgramRefName,
  commit: GitOid,
  token: string,
  key: DeliveryKey,
  authority: DeliveryAuthority,
  writerWaitMs: number,
  recordDir: string,
  test: Pick<CreateRefOptions, 'testPause' | 'testFailLink'>,
): Promise<RefAttempt> {
  let writer: ProcessIdentity | null = null;
  let recorded: Promise<void> = Promise.resolve();
  let detail: string;
  try {
    const r = await createProgramRef(git, repo, ref, commit, {
      intentToken: token,
      recordDir,
      ...test,
      onSpawn: (p) => {
        writer = p;
        recorded = authority.recordRefWriter(key, p);
      },
    });
    await recorded;
    if (r.kind === 'created' || r.kind === 'exists-same') return { kind: 'created' };
    if (r.kind === 'exists-different') return { kind: 'tampered', state: r.state };
    if (r.kind === 'unsafe-namespace') return { kind: 'tampered', state: { kind: 'unsafe-namespace', detail: r.detail } };
    if (r.kind === 'unsupported-repository') return { kind: 'unsupported', detail: r.detail };
    detail = `the writer exited ${r.result.code ?? r.result.signal}: ${r.result.stdout.toString('utf8').trim() || r.result.stderr.toString('utf8').trim()}`;
  } catch (e) {
    await recorded;
    if (!(e instanceof GitTimeoutError)) throw e;
    if (!e.exitedInGrace) return { kind: 'writer-running', processes: e.process === null ? [] : [e.process], writer };
    detail = 'the writer timed out and was ended';
  }
  const rec: RefRecoveryAction = await recoverProgramRef(git, repo, ref, commit, { token, writer, recordDir }, { waitMs: writerWaitMs });
  return attemptOf(rec, detail, writer);
}

function attemptOf(rec: RefRecoveryAction, detail: string, writer: ProcessIdentity | null): RefAttempt {
  switch (rec.kind) {
    case 'done':
      return { kind: 'created' };
    case 'tampered':
      return { kind: 'tampered', state: rec.state };
    case 'escaped':
      return { kind: 'tampered', state: { kind: 'unsafe-namespace', detail: `linked outside the namespace: ${rec.paths.join(', ')}` }, paths: rec.paths };
    case 'writer-running':
      return { kind: 'writer-running', processes: rec.processes, writer };
    case 'lock-not-ours':
      return { kind: 'lock-held', lock: rec.lock, writer };
    case 'not-done':
      return { kind: 'not-done', detail: rec.removedLock !== null ? `${detail}; the lock its own writer left was removed (${rec.removedLock})` : detail };
  }
}

/**
 * A delivery whose ref writer was still running (review r1 #9, WI-14), or whose
 * ref name was held by a lock that is not provably the program's (review r2 #3):
 * wait for the writer, or end it (`kill`) and confirm it gone, then read the ref
 * back and finish the open intent accordingly. While a writer runs, or such a
 * lock stays, nothing is finished.
 */
export async function resumeDeliveryRef(
  git: SafeGit,
  key: DeliveryKey,
  pending: PendingDelivery,
  authority: DeliveryAuthority,
  opts: { readonly waitMs?: number; readonly kill?: boolean } = {},
): Promise<DeliveryResult> {
  const { record, repo } = pending;
  const rec = await recoverProgramRef(git, repo, record.ref, record.commit, { token: deliveryIntentToken(key), writer: pending.writer, recordDir: pending.recordDir }, opts);
  if (rec.kind === 'writer-running') return { kind: 'ref-writer-running', processes: rec.processes, pending };
  if (rec.kind === 'lock-not-ours') return { kind: 'ref-lock-held', lock: rec.lock, pending };
  if (rec.kind === 'done') {
    await authority.complete(key, record);
    return { kind: 'delivered', record };
  }
  await authority.finish(key, 'failed');
  if (rec.kind === 'tampered' || rec.kind === 'escaped') {
    const a = attemptOf(rec, '', pending.writer) as Extract<RefAttempt, { kind: 'tampered' }>;
    await authority.notify(key, tamperedNotice(record.ref, record.commit, a.state, a.paths));
    return { kind: 'ref-tampered', ref: record.ref, state: a.state };
  }
  return { kind: 'ref-not-created', ref: record.ref, detail: rec.removedLock !== null ? `absent; the lock its own writer left was removed (${rec.removedLock})` : 'absent once its writer was gone' };
}

/**
 * Recovery of an authorized delivery whose ref creation did not report back
 * (crash or timeout, 6.1): the full table, including the v34 stale-lock row.
 * `not-done` means re-authorize (re-check stops), then deliver again.
 */
export async function recoverDeliveryRef(
  git: SafeGit,
  repo: RepoLayout,
  key: DeliveryKey,
  intent: { readonly commit: GitOid; readonly writer: ProcessIdentity | null; readonly recordDir?: string },
  opts: { readonly waitMs?: number; readonly kill?: boolean } = {},
): Promise<RefRecoveryAction> {
  return recoverProgramRef(
    git,
    repo,
    deliveryRef(key.mission, key.op),
    intent.commit,
    { token: deliveryIntentToken(key), writer: intent.writer, ...(intent.recordDir !== undefined ? { recordDir: intent.recordDir } : {}) },
    opts,
  );
}
