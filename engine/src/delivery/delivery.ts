// Delivery (design 4.1 §6.7; 4.0 6.6 steps 1-6, 8; WI-05, WI-08, WI-13, WI-19,
// WI-20, WI-21; decision 16), with plain git and the project memory:
//
//   1-2  the manifest and the one-version-per-path check (manifest.ts), over the
//        memory's records with the stored labels (memoryView.ts);
//   3    the candidate on the target branch's current commit B (candidate.ts),
//        materialized into a fresh `tmp/<run>/`: the canonical candidate, a
//        clean checkout with nothing of any worktree in it;
//   4    the proof check on the final candidate tree (candidate.ts);
//   5    the closing checks: the declared commands, run in that clean checkout
//        (ClosingRunner; plain shell by default), which is first made a git
//        repository at the candidate that borrows the repository's objects
//        (checkoutRepository.ts; nothing is written to the repository itself),
//        removed afterwards;
//   6    the delivery ref `refs/mission-pipeline/delivered/<mission>/<op>`:
//        authorized as an intent first (stops, git-writes hold, not withdrawn
//        or superseded), then created with `git update-ref <ref> <D> ""` (only
//        if absent), judged by reading the ref back, and recorded with the
//        delivery (8) and its report leaf `missions/<m>/deliveries/<d>.md` in
//        one write. A crash in between leaves the intent open; the next call
//        for the delivery reads the ref and finishes it.
// The target branch moved while the candidate was built and checked: rebuilt on
// the new base, every rebuild counted before it runs (loop `delivery-rebuild`,
// 3 per delivery, decision 16); at the limit (LOOP_EXHAUSTED, WI-08) the
// delivery stops and the delivery ref already made, if any, is left for the
// maintainer. A landing that finds the branch moved (WI-05) rebuilds through
// rebuildDelivery(), counted on the same delivery's loop.
//
// Replaces deliver.ts (the ref-writer process, the IPC authority) and
// ledgerAuthority.ts. The program never updates refs/heads/, a worktree or an
// index here: landing (land.ts) is separate.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256 } from '../common/hash.ts';
import type { AlertId, ContentHash, GitOid, MissionId, ObjectVersionId, OpId } from '../common/ids.ts';
import { EVALUATOR_INPUT_KINDS, type BaseRecord } from '../common/records.ts';
import { discoverRepo, gitOid, type Ident } from '../git/objects.ts';
import { attachCheckoutRepository } from '../git/checkoutRepository.ts';
import { withoutRepositoryLocators, type PlainGit } from '../git/plainGit.ts';
import { deliveryRef } from '../git/refs.ts';
import { AttributeEvaluator, MissingObjectsError, readTransformDescription, RepresentationError } from '../git/representation.ts';
import type { GitContext } from '../git/workspace.ts';
import {
  appendRecords,
  assertNotStopped,
  authorizeIntent,
  deliveryInfo,
  finishIntent,
  intentInfo,
  LedgerError,
  loopState,
  openIntents,
  PATH_ID,
  raiseAlert,
  recheckIntent,
  recordDelivery,
  wordsEntry,
  type Db,
  type DeliveryInfo,
  type Filler,
  type IntentInfo,
  type Memory,
  type ScopeTag,
  type WriteTx,
} from '../memory/index.ts';
import { noticeExternalWork } from './external.ts';
import { assertScopeNotStopped, deriveScope, tagScope, unionWork, type WorkScope } from './scope.ts';
import { buildCandidate, checkCandidateProofs, landedVersions, type OverlayConflict, type ProofCheck } from './candidate.ts';
import { buildManifest, type DeliveryManifest, type ManifestConflict } from './manifest.ts';
import { memoryProofView, type LabelView } from './memoryView.ts';
import type { DeliveryTarget } from './proofView.ts';

/** Decision 16 (6.5): rebuilds on a moved base per delivery, before the Secretary or the maintainer grants more (LOOP_CAPS). */
export const DELIVERY_REBUILD_LOOP = 'delivery-rebuild';

/** A closing check declared in config.json: a command line run with the platform's shell, or an argv run as it is. */
export interface ClosingCheck {
  readonly id: string;
  readonly command: string | readonly string[];
}

export interface ClosingOutcome {
  readonly id: string;
  readonly passed: boolean;
  readonly exitCode: number | null;
  /** The run's id when the runner recorded it as a run (§5.3); null for the plain runner. */
  readonly run: string | null;
  /** sha256 of the combined output (the output itself is not kept, U-13). */
  readonly outputHash: string;
  /** The last lines of a failing command. */
  readonly tail: string;
}

/** Runs the declared closing checks in the candidate's clean checkout (package A3 may record them as runs). */
export interface ClosingRunner {
  run(req: { readonly mission: MissionId; readonly delivery: string; readonly commit: GitOid; readonly dir: string; readonly checks: readonly ClosingCheck[] }): Promise<readonly ClosingOutcome[]> | readonly ClosingOutcome[];
}

/**
 * The default runner: each command in `dir`, one after another, with the platform's shell (§9),
 * without the variables that would point git at another repository than the checkout's own.
 */
export const shellClosingRunner: ClosingRunner = {
  run({ dir, checks }) {
    const env = withoutRepositoryLocators(process.env);
    return checks.map((c) => {
      const argv = typeof c.command === 'string' ? null : c.command;
      const r =
        argv === null
          ? spawnSync(c.command as string, { cwd: dir, shell: true, env, maxBuffer: 256 * 1024 * 1024, windowsHide: true })
          : spawnSync(argv[0]!, argv.slice(1), { cwd: dir, env, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
      const out = Buffer.concat([r.stdout ?? Buffer.alloc(0), r.stderr ?? Buffer.alloc(0)]);
      const passed = r.error === undefined && r.status === 0;
      const tail = passed ? '' : (r.error !== undefined ? String(r.error.message) + '\n' : '') + out.toString('utf8').split(/\r?\n/).slice(-20).join('\n');
      return { id: c.id, passed, exitCode: r.status, run: null, outputHash: sha256(out), tail };
    });
  },
};

export interface DeliverRequest {
  readonly mission: MissionId;
  /** The delivery's id (its op): letters, digits and "-", 1 to 64; new, or the id of a delivery to finish. */
  readonly delivery: string;
  readonly targetBranch: string;
  readonly selected: readonly DeliveryTarget[];
  readonly closingChecks: readonly ClosingCheck[];
  readonly author: Ident;
  readonly committer: Ident;
  /** The delivery this one rebuilds on a moved base (WI-05): the rebuild is counted on its loop first. */
  readonly rebuildOf?: string | null;
  /** W-<n>: the maintainer's words that asked for the delivery (decision 1); recorded with it. */
  readonly words?: string | null;
  readonly filler?: Filler | null;
}

export interface DeliverDeps {
  /** The stored labels; a function opens them afresh (after they changed during the delivery, §4.1). */
  readonly labels: LabelView | (() => LabelView);
  /** Default: shellClosingRunner. */
  readonly closing?: ClosingRunner;
  /** Test hooks: a crash before the delivery ref's git step, or after it and before its record. */
  readonly hooks?: { readonly beforeRef?: () => void; readonly afterRef?: () => void };
}

export interface DeliveredRecord {
  readonly mission: MissionId;
  readonly delivery: string;
  readonly targetBranch: string;
  readonly base: GitOid;
  readonly commit: GitOid;
  readonly ref: string;
  /** The delivery document in the data table (what the record names). */
  readonly manifest: ContentHash;
  readonly proof: ProofCheck | null;
  readonly checks: readonly ClosingOutcome[];
  /** Rebuilds used on this delivery's loop so far. */
  readonly rebuilds: number;
}

export type DeliveryResult =
  /** §4.1: labels are recomputing; nothing is built; try again once they are done. */
  | { readonly kind: 'recomputing' }
  /** Steps 1-2. Unknown targets or unplaced products: WI-20. Incompatible: an integration task. */
  | { readonly kind: 'unknown-targets'; readonly missing: readonly DeliveryTarget[] }
  | { readonly kind: 'unplaced-products'; readonly versions: readonly ObjectVersionId[] }
  | { readonly kind: 'incompatible'; readonly conflicts: readonly ManifestConflict[] }
  /** Step 3: conflicts on the base, for an integration task. */
  | { readonly kind: 'conflict'; readonly base: GitOid; readonly conflicts: readonly OverlayConflict[] }
  /** WI-19: versions verified under another transform description. */
  | { readonly kind: 'description-mismatch'; readonly versions: readonly ObjectVersionId[] }
  /** WI-13: git or LFS objects the candidate needs are not local; never fetched. */
  | { readonly kind: 'objects-unavailable'; readonly code: string; readonly objects: readonly string[]; readonly paths: readonly string[] }
  /** Step 5 (WI-21): no delivery ref; the candidate commit is kept; no automatic rebuild. */
  | { readonly kind: 'checks-failed'; readonly base: GitOid; readonly commit: GitOid; readonly outcomes: readonly ClosingOutcome[]; readonly proof: ProofCheck }
  /** Decision 16 (WI-08): the rebuilds are used up; the delivery ref already made (the delivery rebuilt from), if any, is left. */
  | { readonly kind: 'rebuild-limit-exhausted'; readonly rebuilds: number; readonly limit: number; readonly leftRef: string | null; readonly detail: string }
  /** WI-20: the delivery ref exists and points elsewhere: never overwritten (deliver again under a new id). */
  | { readonly kind: 'ref-mismatch'; readonly ref: string; readonly found: GitOid | null; readonly expected: GitOid }
  /**
   * The delivery ref is not there yet: git did not take effect (a lock, an error), or a git command
   * started by an mp that has ended may still create it. The intent stays open with its commit;
   * delivering again reissues the same create-only update and records the delivery once the ref is
   * seen at that commit. Nothing is rebuilt.
   */
  | { readonly kind: 'ref-pending'; readonly ref: string; readonly commit: GitOid; readonly intent: string; readonly detail: string }
  | { readonly kind: 'delivered'; readonly record: DeliveredRecord; readonly recovered: boolean };

// ---------------------------------------------------------------- helpers

function checkIds(req: { mission: string; delivery: string }): void {
  if (typeof req.delivery !== 'string' || !PATH_ID.test(req.delivery)) throw new LedgerError('BAD_REQUEST', `a delivery id is 1 to 64 letters, digits and "-": ${JSON.stringify(req.delivery)}`);
  if (typeof req.mission !== 'string' || !PATH_ID.test(req.mission)) throw new LedgerError('BAD_REQUEST', `mission ${JSON.stringify(req.mission)} cannot name a folder`);
}

function readBranch(git: PlainGit, cwd: string, branch: string): GitOid | null {
  const r = git.runSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`], { cwd });
  return r.code === 0 ? gitOid(r.stdout.toString('utf8').trim()) : null;
}

function readRef(git: PlainGit, cwd: string, ref: string): GitOid | null {
  const r = git.runSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { cwd });
  return r.code === 0 ? gitOid(r.stdout.toString('utf8').trim()) : null;
}

function refDomain(ref: string): string {
  return `ref:${ref}`;
}

/** The loop a delivery's rebuilds count on: the first delivery of its rebuild chain. */
export function deliveryLineage(mission: string, root: string): string {
  return `delivery:${mission}:${root}`;
}

/** What the delivery's data document holds (the record's `manifest`): enough to rebuild it and to read it. */
interface DeliveryDocument {
  readonly version: 'mp41-delivery/1';
  readonly mission: string;
  readonly delivery: string;
  /** The first delivery of the rebuild chain: its loop counts the rebuilds. */
  readonly root: string;
  readonly rebuildOf: string | null;
  readonly words: string | null;
  readonly targetBranch: string;
  readonly selected: readonly DeliveryTarget[];
  readonly labelsRevision: number;
  readonly base: string;
  readonly commit: string;
  /** The stop scope's capabilities at authorization (scope.ts): the landing checks them with the ones derived then. */
  readonly capabilities: readonly string[];
  readonly entries: readonly { readonly id: string; readonly mission: string; readonly unit: string | null; readonly label: string; readonly paths: readonly string[] }[];
  readonly proof: ProofCheck;
  readonly checks: readonly ClosingOutcome[];
}

function documentOf(m: Memory, d: DeliveryInfo): DeliveryDocument | null {
  if (d.manifest === null) return null;
  try {
    const doc = JSON.parse(m.data.text(d.manifest)) as DeliveryDocument;
    return doc.version === 'mp41-delivery/1' ? doc : null;
  } catch {
    return null;
  }
}

function notice(m: Memory, id: string, wi: string, category: string, body: { trigger: string; facts: unknown; defaultAction: string }): void {
  m.write({}, (tx) => {
    raiseAlert(tx, { alert: id.replace(/[^A-Za-z0-9._:@-]/g, '-').slice(0, 200) as AlertId, category, wi, body: tx.data.put(canonicalJson(body)) });
  });
}

function reportLeaf(doc: DeliveryDocument, ref: string, rebuilds: number): string {
  const lines = [
    `# Delivery ${doc.delivery} of mission ${doc.mission}`,
    '',
    `- Target branch: ${doc.targetBranch}`,
    `- Base: ${doc.base}`,
    `- Delivery commit: ${doc.commit}`,
    `- Delivery ref: ${ref}`,
    `- Labels as of revision ${doc.labelsRevision}`,
    ...(doc.words !== null ? [`- Asked for in ${doc.words}`] : []),
    ...(doc.rebuildOf !== null ? [`- Rebuilt from delivery ${doc.rebuildOf} (rebuilds used: ${rebuilds})`] : []),
    '',
    '## Manifest',
    '',
    ...doc.entries.map((e) => `- ${e.id}${e.unit !== null ? ` (unit ${e.unit})` : ''}: ${e.label}`),
    '',
    '## Proof check on the candidate',
    '',
    `- Proven: ${doc.proof.proven.length === 0 ? 'none' : doc.proof.proven.join(', ')}`,
    ...(doc.proof.deliveredBy ?? []).map((d) => `- ${d.version}: ${d.path} is delivered by ${d.by}`),
    ...doc.proof.notFullyProven.map((n) => `- Not fully proven: ${n.id} (${n.reasons.map((r) => r.kind === 'start-lacks-prerequisite' ? `${r.kind}: ${r.missing.map((m) => `${m.prerequisite} at ${m.path}`).join(', ')}` : r.kind).join(', ')})`),
    '',
    '## Closing checks',
    '',
    ...(doc.checks.length === 0 ? ['- none declared'] : doc.checks.map((c) => `- ${c.id}: ${c.passed ? 'passed' : `failed (exit ${c.exitCode ?? 'none'})`}, output sha256 ${c.outputHash}`)),
    '',
  ];
  return lines.join('\n');
}

function intentClaim(doc: DeliveryDocument, ref: string, manifest: ContentHash): Record<string, unknown> {
  return {
    ref,
    commit: doc.commit,
    base: doc.base,
    delivery: { mission: doc.mission, op: doc.delivery, commit: doc.commit, base: doc.base, ref, targetBranch: doc.targetBranch, manifest },
  };
}

/** Record the delivery (step 8), its report leaf, and the intent done: one write. */
function recordDone(tx: WriteTx, i: IntentInfo, doc: DeliveryDocument, ref: string, manifest: ContentHash, rebuilds: number): void {
  const before = deliveryInfo(tx, doc.mission as MissionId, doc.delivery);
  if (before === null || before.recordedRev === null) {
    recordDelivery(tx, { mission: doc.mission as MissionId, delivery: doc.delivery, commit: doc.commit, base: doc.base, ref, manifest, target: doc.targetBranch });
    tx.leaves.writeDocument(`missions/${doc.mission}/deliveries/${doc.delivery}.md`, reportLeaf(doc, ref, rebuilds));
  }
  finishIntent(tx, { intent: i.intent, outcome: 'done' });
}

function recordOf(doc: DeliveryDocument, ref: string, manifest: ContentHash, rebuilds: number): DeliveredRecord {
  return {
    mission: doc.mission as MissionId,
    delivery: doc.delivery,
    targetBranch: doc.targetBranch,
    base: gitOid(doc.base),
    commit: gitOid(doc.commit),
    ref,
    manifest,
    proof: doc.proof,
    checks: doc.checks,
    rebuilds,
  };
}

function rebuildsUsed(m: Memory, mission: string, root: string): { used: number; limit: number; exhausted: boolean } {
  const s = m.read((db) => loopState(db, deliveryLineage(mission, root), DELIVERY_REBUILD_LOOP));
  return { used: s.attempts, limit: s.allowed, exhausted: s.exhausted };
}

/** Count one rebuild BEFORE it runs (decision 16); null when the loop refuses it (LOOP_EXHAUSTED, WI-08). */
function countRebuild(m: Memory, mission: string, root: string, signature: string): { total: number } | { exhausted: string } {
  const rec: BaseRecord = { kind: 'loop.attempt', lineage: deliveryLineage(mission, root), loop: DELIVERY_REBUILD_LOOP, failureClass: null, signature };
  try {
    m.write({}, (tx) => appendRecords(tx, [rec]));
  } catch (e) {
    if (e instanceof LedgerError && e.code === 'LOOP_EXHAUSTED') return { exhausted: e.message };
    throw e;
  }
  return { total: rebuildsUsed(m, mission, root).used };
}

/** The delivery's own data document named by an intent's claim. */
function intentDocument(m: Memory, i: IntentInfo): { doc: DeliveryDocument; manifest: ContentHash } | null {
  const manifest = i.delivery?.manifest ?? null;
  if (manifest === null) return null;
  try {
    const doc = JSON.parse(m.data.text(manifest)) as DeliveryDocument;
    return doc.version === 'mp41-delivery/1' ? { doc, manifest } : null;
  } catch {
    return null;
  }
}

/** The stop scope of a delivery (scope.ts), derived now from its mission and the missions of its objects. */
function deliveryScope(db: Db, mission: MissionId, missions: readonly string[], recorded: readonly string[] = []): WorkScope {
  return deriveScope(db, mission, missions, recorded);
}

/**
 * The delivery ref of an authorized delivery (§6.7; the landing rule, applied
 * to the ref): judged only by the ref. At the intent's commit D: the delivery
 * is recorded, once. Absent: the intent stays open with D, and the same
 * create-only update is reissued, after the same checks as a new authorization
 * (stops, with the scope derived again; the git-writes hold; currency). A late
 * finish of an earlier git command and this one are both "create at D", so
 * only D can appear. Elsewhere: WI-20, never overwritten.
 */
function resumeRef(ctx: GitContext, req: DeliverRequest, ref: string, deps: DeliverDeps): DeliveryResult | null {
  const { memory: m, git } = ctx;
  const i = m.read((db) => openIntents(db).find((x) => x.kind === 'delivery-ref' && x.domain === refDomain(ref)) ?? null);
  const found = readRef(git, m.projectDir, ref);
  if (i === null) {
    // No open intent, but the ref is there: an intent of this delivery closed before a late git created it.
    if (found === null) return null;
    const earlier = m.read((db) => {
      for (let k = 1; ; k++) {
        const x = intentInfo(db, `dref:${req.mission}:${req.delivery}:${k}`);
        if (x === null) return null;
        if (x.delivery?.commit === found) return x;
      }
    });
    const claim = earlier === null ? null : intentDocument(m, earlier);
    if (earlier === null || claim === null) return null;
    const used = rebuildsUsed(m, req.mission, claim.doc.root).used;
    m.write({}, (tx) => recordDone(tx, earlier, claim.doc, ref, claim.manifest, used));
    return { kind: 'delivered', record: recordOf(claim.doc, ref, claim.manifest, used), recovered: true };
  }
  if (i.delivery === null || i.delivery.op !== req.delivery || i.delivery.mission !== req.mission) return null;
  const claim = intentDocument(m, i);
  if (claim === null) throw new LedgerError('BAD_REQUEST', `intent ${i.intent} names no delivery document of this mp`);
  const { doc, manifest } = claim;
  const commit = gitOid(doc.commit);
  const done = (): DeliveryResult => {
    const used = rebuildsUsed(m, req.mission, doc.root).used;
    m.write({}, (tx) => recordDone(tx, i, doc, ref, manifest, used));
    return { kind: 'delivered', record: recordOf(doc, ref, manifest, used), recovered: true };
  };
  if (found === commit) return done();
  if (found !== null) return { kind: 'ref-mismatch', ref, found, expected: commit };
  // Absent: checked like a new authorization, then the same B→D create-only update again.
  m.write({ op: `${i.intent}.retry.${m.head()}`, payload: { retry: i.intent }, command: 'deliver', filler: req.filler ?? null }, (tx) => {
    // Every related mission, with the stored scope and the one derived now (§6.6).
    assertScopeNotStopped(tx, unionWork(tagScope(i.tag), deliveryScope(tx, req.mission, doc.entries.map((e) => e.mission ?? req.mission), doc.capabilities)), 'this delivery');
    recheckIntent(tx, i.intent);
    return { retried: i.intent };
  });
  deps.hooks?.beforeRef?.();
  const r = git.runSync(['update-ref', '-m', `mission-pipeline: deliver ${req.mission}/${req.delivery}`, ref, commit, ''], { cwd: m.projectDir });
  deps.hooks?.afterRef?.();
  const now = readRef(git, m.projectDir, ref);
  if (now === commit) return done();
  if (now !== null) return { kind: 'ref-mismatch', ref, found: now, expected: commit };
  return { kind: 'ref-pending', ref, commit, intent: i.intent, detail: `git did not create the ref: ${r.stderr.toString('utf8').trim().split(/\r?\n/).slice(-2).join(' | ') || `exit ${r.code}`}` };
}

/** Label-relevant records committed after `rev` (EVALUATOR_INPUT_KINDS): the labels a delivery read may be stale. */
function inputsSince(db: Db, rev: number): boolean {
  const kinds = [...EVALUATOR_INPUT_KINDS];
  return db.stmt(`SELECT 1 FROM log WHERE rev > ? AND kind IN (${kinds.map(() => '?').join(', ')}) LIMIT 1`).get(rev, ...kinds) !== undefined;
}

/** The authorization found the labels changed or recomputing (§4.1): nothing was written. */
class LabelsMoved extends Error {
  readonly recomputing: boolean;
  constructor(recomputing: boolean) {
    super(recomputing ? 'labels are recomputing' : 'labels changed');
    this.recomputing = recomputing;
  }
}

/** How many times a delivery reopens the labels after they changed under it, before it reports "recomputing". */
export const MAX_LABEL_REOPENS = 3;

// ---------------------------------------------------------------- deliver

/**
 * Build, check, prove and deliver (§6.7). Refusals that are the memory's
 * (STOPPED, GIT_WRITES_HELD, DELIVERY_NOT_CURRENT for a superseded or withdrawn
 * delivery) are thrown as LedgerError; everything else is a DeliveryResult.
 */
export async function deliver(ctx: GitContext, req: DeliverRequest, deps: DeliverDeps): Promise<DeliveryResult> {
  const { memory: m, git } = ctx;
  checkIds(req);
  const openLabels = typeof deps.labels === 'function' ? deps.labels : ((v: LabelView) => () => v)(deps.labels);
  let labels = openLabels();
  if (git.runSync(['check-ref-format', `refs/heads/${req.targetBranch}`], { cwd: m.projectDir }).code !== 0) throw new LedgerError('BAD_REQUEST', `${req.targetBranch} is not a valid branch name`);
  const ref = deliveryRef(req.mission, req.delivery as OpId);
  if (req.words !== undefined && req.words !== null && m.read((db) => wordsEntry(db, req.words!)) === null) throw new LedgerError('BAD_REQUEST', `no words entry ${req.words}`);

  // Already delivered (a repeated command): its record, as it is.
  const known = m.read((db) => deliveryInfo(db, req.mission, req.delivery));
  if (known !== null && known.recordedRev !== null) {
    const doc = documentOf(m, known);
    if (doc === null) throw new LedgerError('BAD_REQUEST', `delivery ${req.delivery} of mission ${req.mission} is recorded, but not by this mp`);
    return { kind: 'delivered', record: recordOf(doc, known.ref, known.manifest!, rebuildsUsed(m, req.mission, doc.root).used), recovered: false };
  }
  // A delivery whose ref was already created is completed first: a ref at its D is recorded even under a
  // stop or the git-writes hold (nothing is written to git); only a new git write is checked against them.
  const resumed = resumeRef(ctx, req, ref, deps);
  if (resumed !== null) return resumed;
  m.read((db) => assertScopeNotStopped(db, deliveryScope(db, req.mission, []), 'this delivery'));
  m.assertGitWrites('a delivery');
  if (labels.recomputing) return { kind: 'recomputing' };

  // The rebuild chain: a rebuild is counted on the first delivery's loop before it runs.
  let root = req.delivery;
  let leftRef: string | null = null;
  if (req.rebuildOf !== undefined && req.rebuildOf !== null) {
    const prev = m.read((db) => deliveryInfo(db, req.mission, req.rebuildOf!));
    if (prev === null || prev.recordedRev === null) throw new LedgerError('BAD_REQUEST', `mission ${req.mission} has no recorded delivery ${req.rebuildOf} to rebuild`);
    root = documentOf(m, prev)?.root ?? prev.delivery;
    leftRef = prev.ref;
    const now = readBranch(git, m.projectDir, req.targetBranch);
    const counted = countRebuild(m, req.mission, root, `base-moved:${now ?? 'absent'}`);
    if ('exhausted' in counted) return exhausted(m, req, root, leftRef, counted.exhausted);
    notice(m, `delivery.${req.mission}.${req.delivery}.rebuild`, 'WI-05', 'delivery-rebuild', {
      trigger: `the target branch ${req.targetBranch} moved off the base of delivery ${req.rebuildOf}: the candidate is rebuilt on ${now ?? '(absent)'} as delivery ${req.delivery}`,
      facts: { previous: req.rebuildOf, base: prev.base, now, rebuilds: counted.total, limit: rebuildsUsed(m, req.mission, root).limit },
      defaultAction: 'the candidate is rebuilt (manifest, proof check, closing checks again), counted; the previous delivery ref is kept; a rebuilt candidate whose content changed needs re-acceptance (WI-07)',
    });
  }

  let view = memoryProofView(m, labels);
  let built = buildManifest(view, req.selected);
  if (built.kind === 'unknown') {
    notice(m, `delivery.${req.mission}.${req.delivery}.unknown`, 'WI-20', 'delivery-unknown-targets', {
      trigger: `the delivery names objects or proof units the memory does not know: ${built.missing.map((t) => `${t.kind}:${t.id}`).join(', ')}`,
      facts: { missing: built.missing },
      defaultAction: 'nothing is built or delivered; other work goes on',
    });
    return { kind: 'unknown-targets', missing: built.missing };
  }
  if (built.kind === 'unplaced') return { kind: 'unplaced-products', versions: built.versions };
  if (built.kind === 'incompatible') return { kind: 'incompatible', conflicts: built.conflicts };
  let manifest = built.manifest;
  // A stop on any mission whose work the delivery carries covers it (§6.6).
  const sources = (): string[] => manifest.entries.map((e) => e.object.mission);
  m.read((db) => assertScopeNotStopped(db, deliveryScope(db, req.mission, sources()), 'this delivery'));

  // This call's own scratch directory: concurrent deliveries never share or remove each other's.
  mkdirSync(m.paths.tmp, { recursive: true });
  const scratch = mkdtempSync(join(m.paths.tmp, `deliver-${req.mission}-${req.delivery}-`));
  let attributes: AttributeEvaluator | null = null;
  let reopens = 0;
  try {
    const repo = await discoverRepo(git, m.projectDir);
    const description = await readTransformDescription(git, repo, m.projectDir);
    attributes = await AttributeEvaluator.create(git, repo, description, scratch);
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1 && reopens > 0) {
        // The labels changed under the previous attempt: read them again, and the manifest with them.
        labels = openLabels();
        if (labels.recomputing) return { kind: 'recomputing' };
        view = memoryProofView(m, labels);
        built = buildManifest(view, req.selected);
        if (built.kind !== 'manifest') return built.kind === 'unknown' ? { kind: 'unknown-targets', missing: built.missing } : built.kind === 'unplaced' ? { kind: 'unplaced-products', versions: built.versions } : { kind: 'incompatible', conflicts: built.conflicts };
        manifest = built.manifest;
      }
      const base = readBranch(git, m.projectDir, req.targetBranch);
      if (base === null) throw new LedgerError('BAD_REQUEST', `the target branch ${req.targetBranch} does not exist`);
      // WI-03: external work in a write scope of a mission in flight is noticed (never merged, never blocking).
      if (attempt === 1) await noticeExternalWork(ctx, { mission: req.mission, delivery: req.delivery, base, targetBranch: req.targetBranch, at: 'delivery' });
      // Step 3, in a clean run directory: the canonical candidate is the checkout the checks run in.
      const runDir = join(scratch, `candidate-${attempt}`);
      let c: Awaited<ReturnType<typeof buildCandidate>>;
      try {
        // a version recorded without its origin finds it down its predecessors, as this view has them (Appendix H)
        const v = view;
        c = await buildCandidate({ git, repo, manifest, base, attributes, snapshotDir: runDir, message: describe(req, manifest), author: req.author, committer: req.committer, versionOf: (id) => v.object(id), alreadyLaid: await landedVersions(git, repo, m, base, (id) => v.object(id)) });
      } catch (e) {
        const lfs = e instanceof RepresentationError && (e.code === 'lfs-object-missing' || e.code === 'lfs-object-corrupt');
        if (!(e instanceof MissingObjectsError) && !lfs) throw e;
        const objects = e instanceof MissingObjectsError ? e.objects : [];
        notice(m, `delivery.${req.mission}.${req.delivery}.objects`, 'WI-13', 'delivery-objects-missing', {
          trigger: `the delivery candidate needs objects that are not usable locally: ${e.message}`,
          facts: { code: e.code, objects, paths: e.paths, base },
          defaultAction: 'nothing is delivered and nothing is fetched; once the objects are local the delivery is started again',
        });
        return { kind: 'objects-unavailable', code: e.code, objects, paths: e.paths };
      }
      if (c.kind === 'conflict') return { kind: 'conflict', base: c.base, conflicts: c.conflicts };
      if (c.kind === 'description-mismatch') {
        notice(m, `delivery.${req.mission}.${req.delivery}.description`, 'WI-19', 'transform-description-changed', {
          trigger: `versions in the delivery were verified under another transform description than the repository's now (${c.expected}): ${c.versions.join(', ')}`,
          facts: { expected: c.expected, versions: c.versions },
          defaultAction: 'no candidate is built and no ref is created; these versions are verified again under the current description, or the settings are changed back',
        });
        return { kind: 'description-mismatch', versions: c.versions };
      }
      const candidate = c.candidate;
      // Step 4, then step 5 in the clean checkout; the run directory goes afterwards.
      const proof = await checkCandidateProofs({ git, repo, view, manifest, candidate });
      let outcomes: readonly ClosingOutcome[];
      try {
        // The checks ask git about the candidate: the run directory is a repository at it, borrowing the objects.
        if (req.closingChecks.length > 0) await attachCheckoutRepository(git, repo, { dir: runDir, commit: candidate.commit, description });
        outcomes = await (deps.closing ?? shellClosingRunner).run({ mission: req.mission, delivery: req.delivery, commit: candidate.commit, dir: runDir, checks: req.closingChecks });
      } finally {
        rmSync(runDir, { recursive: true, force: true });
      }
      const ran = new Set(outcomes.map((o) => o.id));
      const all = [...outcomes, ...req.closingChecks.filter((x) => !ran.has(x.id)).map((x) => ({ id: x.id, passed: false, exitCode: null, run: null, outputHash: sha256(''), tail: 'not run' }))];
      if (all.some((o) => !o.passed)) {
        notice(m, `delivery.${req.mission}.${req.delivery}.checks.${attempt}`, 'WI-21', 'delivery-closing-checks-failed', {
          trigger: `closing checks failed on the delivery candidate ${candidate.commit} (base ${base}): ${all.filter((o) => !o.passed).map((o) => o.id).join(', ')}`,
          facts: { base, commit: candidate.commit, failed: all.filter((o) => !o.passed) },
          defaultAction: 'no delivery ref is created; the candidate commit is kept; no automatic rebuild',
        });
        return { kind: 'checks-failed', base, commit: candidate.commit, outcomes: all, proof };
      }

      // Moved while it was built and checked: rebuild on the new base, counted first.
      const now = readBranch(git, m.projectDir, req.targetBranch);
      if (now !== base) {
        const counted = countRebuild(m, req.mission, root, `base-moved:${now ?? 'absent'}`);
        if ('exhausted' in counted) return exhausted(m, req, root, leftRef, counted.exhausted);
        continue;
      }

      // Step 6: authorize the ref, create it only if absent, judge by reading it back, record.
      const doc: DeliveryDocument = {
        version: 'mp41-delivery/1',
        mission: req.mission,
        delivery: req.delivery,
        root,
        rebuildOf: req.rebuildOf ?? null,
        words: req.words ?? null,
        targetBranch: req.targetBranch,
        selected: req.selected,
        labelsRevision: Number(labels.revision),
        base,
        commit: candidate.commit,
        capabilities: m.read((db) => deliveryScope(db, req.mission, sources()).capabilities),
        entries: manifest.entries.map((e) => ({ id: e.object.id, mission: e.object.mission, unit: e.unit, label: e.label, paths: e.object.paths })),
        proof,
        checks: all,
      };
      const docHash = m.data.put(canonicalJson(doc));
      const intent = m.read((db) => {
        for (let k = 1; ; k++) if (intentInfo(db, `dref:${req.mission}:${req.delivery}:${k}`) === null) return `dref:${req.mission}:${req.delivery}:${k}`;
      });
      const current = labels;
      try {
        m.write({ op: intent, payload: { deliver: req.delivery, mission: req.mission, commit: candidate.commit, base }, command: 'deliver', filler: req.filler ?? null }, (tx) => {
          // §4.1, in this transaction: no frontier, and no label input since the labels this proof check read.
          if (current.recomputingIn(tx)) throw new LabelsMoved(true);
          if (inputsSince(tx, Number(current.revision))) throw new LabelsMoved(false);
          // The stop scope, derived in this transaction over every related mission, and persisted with the
          // intent (its capabilities in the tag, its missions in the delivery document); a retry checks it again.
          const scope = deliveryScope(tx, req.mission, doc.entries.map((e) => e.mission), doc.capabilities);
          assertScopeNotStopped(tx, scope, 'this delivery');
          authorizeIntent(tx, { intent, kind: 'delivery-ref', domain: refDomain(ref), tag: { mission: req.mission, capabilities: [...scope.capabilities] }, details: intentClaim(doc, ref, docHash) });
          return { intent };
        });
      } catch (e) {
        if (!(e instanceof LabelsMoved)) throw e;
        if (e.recomputing || ++reopens > MAX_LABEL_REOPENS) return { kind: 'recomputing' };
        continue;
      }
      deps.hooks?.beforeRef?.();
      const created = ctx.git.runSync(['update-ref', '-m', `mission-pipeline: deliver ${req.mission}/${req.delivery}`, ref, candidate.commit, ''], { cwd: m.projectDir });
      deps.hooks?.afterRef?.();
      const found = readRef(git, m.projectDir, ref);
      const i = m.read((db) => intentInfo(db, intent))!;
      if (found === candidate.commit) {
        const used = rebuildsUsed(m, req.mission, root).used;
        m.write({}, (tx) => recordDone(tx, i, doc, ref, docHash, used));
        if (proof.needsReverification.length > 0) {
          notice(m, `delivery.${req.mission}.${req.delivery}.changed`, 'WI-07', 'delivery-object-changed', {
            trigger: `${proof.needsReverification.length} selected version(s) have different content on the delivery candidate than the accepted versions`,
            facts: { needsReverification: proof.needsReverification, commit: candidate.commit },
            defaultAction: 'they are delivered as not fully proven until re-accepted',
          });
        }
        return { kind: 'delivered', record: recordOf(doc, ref, docHash, used), recovered: false };
      }
      // Not at D: the intent stays open with D (never closed because the ref is absent: a late git may still create it).
      if (found !== null) {
        notice(m, `delivery.${req.mission}.${req.delivery}.ref`, 'WI-20', 'program-namespace-mismatch', {
          trigger: `${ref} exists and points to ${found}, not the delivery commit ${candidate.commit}`,
          facts: { ref, found, expected: candidate.commit },
          defaultAction: 'the ref is not overwritten; nothing is recorded as delivered; deliver again under a new id',
        });
        return { kind: 'ref-mismatch', ref, found, expected: candidate.commit };
      }
      return { kind: 'ref-pending', ref, commit: candidate.commit, intent, detail: `git did not create the ref: ${created.stderr.toString('utf8').trim().split(/\r?\n/).slice(-2).join(' | ') || `exit ${created.code}`}` };
    }
  } finally {
    attributes?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
}

function exhausted(m: Memory, req: DeliverRequest, root: string, leftRef: string | null, detail: string): DeliveryResult {
  const st = rebuildsUsed(m, req.mission, root);
  notice(m, `delivery.${req.mission}.${req.delivery}.exhausted`, 'WI-08', 'delivery-rebuild-exhausted', {
    trigger: `the target branch ${req.targetBranch} kept moving: ${st.used} rebuild(s) of delivery ${root}, limit ${st.limit}`,
    facts: { loop: DELIVERY_REBUILD_LOOP, lineage: deliveryLineage(req.mission, root), rebuilds: st.used, limit: st.limit, leftRef },
    defaultAction: 'the delivery stops rebuilding; the delivery ref already made is left for the maintainer (deliver the ref only, or a grant)',
  });
  return { kind: 'rebuild-limit-exhausted', rebuilds: st.used, limit: st.limit, leftRef, detail };
}

function describe(req: DeliverRequest, manifest: DeliveryManifest): string {
  const lines = manifest.entries.map((e) => `  ${e.object.id}${e.unit !== null ? ` (unit ${e.unit})` : ''}: ${e.label}`);
  return `Delivery ${req.delivery} of mission ${req.mission} (${manifest.selected.map((t) => t.id).join(', ')}) as of revision ${manifest.revision}\n\n${lines.join('\n')}\n`;
}

/**
 * WI-05: a landing found the target branch moved off delivery `delivery`'s
 * base. Rebuild it on the branch's current commit as a new delivery
 * (`<root>-r<n>`), counted on the first delivery's loop (3, decision 16); at the
 * limit the delivery ref is left. The new delivery is landed with its own
 * `mp pm land` (WI-05 option 1).
 */
export async function rebuildDelivery(
  ctx: GitContext,
  req: { readonly mission: MissionId; readonly delivery: string; readonly closingChecks: readonly ClosingCheck[]; readonly author: Ident; readonly committer: Ident; readonly filler?: Filler | null },
  deps: DeliverDeps,
): Promise<DeliveryResult> {
  const m = ctx.memory;
  const prev = m.read((db) => deliveryInfo(db, req.mission, req.delivery));
  if (prev === null || prev.recordedRev === null) throw new LedgerError('BAD_REQUEST', `mission ${req.mission} has no recorded delivery ${req.delivery}`);
  const doc = documentOf(m, prev);
  if (doc === null || prev.target === null) throw new LedgerError('BAD_REQUEST', `delivery ${req.delivery} was not made by this mp: rebuild it with a new delivery`);
  const next = `${doc.root}-r${rebuildsUsed(m, req.mission, doc.root).used + 1}`.slice(0, 64);
  return deliver(
    ctx,
    { mission: req.mission, delivery: next, targetBranch: prev.target, selected: doc.selected, closingChecks: req.closingChecks, author: req.author, committer: req.committer, rebuildOf: req.delivery, words: doc.words ?? null, filler: req.filler ?? null },
    deps,
  );
}

/** Whether a delivery's ref is present at its commit (for reads: "delivered, not landed"). */
export function deliveryRefState(ctx: GitContext, d: DeliveryInfo): 'present' | 'absent' | 'elsewhere' {
  const found = readRef(ctx.git, ctx.memory.projectDir, d.ref);
  return found === null ? 'absent' : found === d.commit ? 'present' : 'elsewhere';
}
