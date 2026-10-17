// The program actions the flows need beyond the memory (design 4.1 §5.3, §14 "Process"), with
// plain git (src/git) and the project's declared commands (runs.ts):
//   snapshot    the commit a seat reads: the mission's base (the target branch's head) or a given
//               commit, with accepted product versions laid over it (a dependent task sees its
//               prerequisites, 5.3) by the delivery's overlay (delivery/candidate.ts); the card
//               names the commit, `mp seat <id> checkout` materializes it (the snapshot itself writes
//               nothing to disk: only its commit is used, 4.1.2). A later attempt's start
//               (carry): the previous candidate, or, when its dependencies' products changed, the
//               previous version's whole change laid over their current snapshot (Appendix M)
//   product     the product version of a Constructor's candidate commit (5.1): its content is the
//               write-scope identity of the commit, its source the commit, the write scope, the
//               transform description (A4's handoff) and its origin, the snapshot the task's
//               first attempt started from (a rework continues from the previous attempt's
//               candidate; its change is every attempt's, Appendix H)
//   rebind      a kept product re-bound under the plan in effect (Appendix J): a successor version
//               with the same content and source, its origin recorded, its own prerequisites and
//               review contracts
//   verify      the declared runs on a clean checkout of the candidate (§5.3; reused when §6.5 allows;
//               "pending", with nothing run or recorded, while another mp process executes them, and
//               while a stop covers the work: §6.6, it resumes once the stop is released). 4.1.2
//               (D-4, D-5, D-7): never a command of the project's full suite, whatever the task kind
//               or the card's age: the suite is the integration Reviewer's `mp seat <id> full-run`,
//               recorded with a full-run marker
//   findSymbol  3.5: a file of a commit names a symbol (read-only, no model)
//   history     3.4: the git log and past run durations, for the Architect's card
// Every action is idempotent: a product version is recorded once per object id, a snapshot of the
// same inputs is the same commit, a verification is reused.

import { canonicalJson } from '../common/hash.ts';
import { isFullSuiteCommand, type SuiteCommand } from '../common/fullSuite.ts';
import type { GitOid, MissionId, ModuleId, ObjectVersionId, ProofUnitId } from '../common/ids.ts';
import type { ObjectVersionRecord } from '../common/records.ts';
import { validateRecord } from '../common/validate.ts';
import { buildCandidate, landedVersions, startHolds, versionOrigin } from '../delivery/candidate.ts';
import { buildManifest, type DeliveryManifest } from '../delivery/manifest.ts';
import { deriveScope, scopeStopped } from '../delivery/scope.ts';
import { memoryProofView } from '../delivery/memoryView.ts';
import type { DeliveryObject, DeliveryProofView } from '../delivery/proofView.ts';
import { inWriteScope, writeScopeDocument } from '../delivery/writeScope.ts';
import { discoverRepo, gitOid, lsTree, type RepoLayout } from '../git/objects.ts';
import { MissingObjectsError, readTransformDescription, transformDescriptionHash, type TransformDescription } from '../git/representation.ts';
import { appendRecords, factById, LedgerError } from '../memory/index.ts';
import { safeId } from '../flow/context.ts';
import type { ProductRequest, ProductVersion, RebindRequest, VerificationRun, VerifyRequest } from '../flow/ports.ts';
import type { GitActions, ProcessContext } from './context.ts';
import { RunInProgress, runOnCommit } from './runs.ts';

/** A program action that cannot go on as it is: the flow keeps only this task waiting, with the WI for `code` (execution.ts actionRefused). */
export class ActionError extends Error {
  readonly code: 'product-rejected' | 'conflict' | 'missing-objects' | 'unknown-product' | 'unsafe-path' | 'git-held';
  readonly detail: unknown;
  constructor(code: ActionError['code'], message: string, detail: unknown = null) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export const productObjectId = (task: string): string => safeId(`prod.${task}`);

interface Shared {
  repo: Promise<RepoLayout> | null;
  description: Promise<TransformDescription> | null;
}

/**
 * The commands of a task the program runs at hand-back and in the flow's verification (4.1.2, D-4,
 * D-5, D-7): its declared commands without the project's full suite (by normalized text), for every
 * task kind and every card, a 4.1.1 plan's included. The suite is left to the integration review.
 */
export function verificationCommands<C extends { readonly command: string | readonly string[] }>(suite: readonly SuiteCommand[], commands: readonly C[]): C[] {
  return commands.filter((c) => !isFullSuiteCommand(suite, c.command));
}

/** Whether a stop covers the work of `mission` (§6.6; the delivery's scope resolver): its verification waits until the stop is released. */
export function verificationStopped(ctx: ProcessContext, mission: MissionId): boolean {
  return ctx.memory.read((db) => scopeStopped(db, deriveScope(db, mission)));
}

/** Resolve the prerequisite closure and whole proof units; the delivery overlay orders them by prerequisites.
 * Composition labels confer no proof; delivery still applies its compatibility checks.
 */
export function compose(view: DeliveryProofView, products: readonly string[]): DeliveryManifest {
  const built = buildManifest(view, products.map((id) => view.unitMembers(id as ProofUnitId) !== null ? { kind: 'unit', id: id as ProofUnitId } : { kind: 'object', id: id as ObjectVersionId }), { compositionOnly: true });
  if (built.kind !== 'manifest') throw new ActionError('unknown-product', 'the snapshot products have an unknown or unplaced prerequisite', built);
  return built.manifest;
}

export function gitActions(ctx: ProcessContext): GitActions {
  const shared: Shared = { repo: null, description: null };
  const repo = (): Promise<RepoLayout> => (shared.repo ??= discoverRepo(ctx.git, ctx.projectDir));
  const description = async (): Promise<TransformDescription> => (shared.description ??= readTransformDescription(ctx.git, await repo(), ctx.projectDir));
  const compositionView = () => memoryProofView(ctx.memory, { revision: ctx.memory.head(), recomputing: false, recomputingIn: () => false, labelOf: () => 'unaccepted', decidingRuns: () => [] });

  /** The mission's base: the target branch's head (a mission starts from where it will land). */
  function missionBase(): string {
    const r = ctx.git.runSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${ctx.targetBranch}^{commit}`], { cwd: ctx.projectDir });
    if (r.code === 0) return r.stdout.toString('utf8').trim();
    const head = ctx.git.runSync(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: ctx.projectDir });
    if (head.code === 0) return head.stdout.toString('utf8').trim();
    throw new ActionError('missing-objects', `the target branch ${ctx.targetBranch} has no commit in this repository`);
  }

  function commitOf(rev: string): string {
    const r = ctx.git.runSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { cwd: ctx.projectDir });
    if (r.code !== 0) throw new ActionError('missing-objects', `${rev} is not a commit of the project repository (a missing object is never fetched)`, { rev });
    return r.stdout.toString('utf8').trim();
  }

  function productRecord(id: string): ObjectVersionRecord | null {
    const c = ctx.memory.read((db) => factById(db, 'object.version', id));
    return c === null ? null : (c.record as ObjectVersionRecord);
  }

  /** A recorded version that lives in the repository, as the delivery's overlay reads it. */
  function placedVersion(r: ObjectVersionRecord & { source: NonNullable<ObjectVersionRecord['source']> }): DeliveryObject {
    return { id: r.object, kind: r.objectKind, mission: r.mission, module: r.module, content: r.content, prerequisites: [], paths: [...r.scope.paths], tree: r.source, predecessor: r.predecessor ?? null };
  }

  /** The recorded versions by id, for the origin of one recorded without it (versionOrigin walks its predecessors). */
  function versionOf(id: ObjectVersionId): DeliveryObject | null {
    const r = productRecord(id);
    return r === null || r.source === undefined ? null : placedVersion(r as ObjectVersionRecord & { source: NonNullable<ObjectVersionRecord['source']> });
  }

  function treeOf(commit: string): string {
    const r = ctx.git.runSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^{tree}`], { cwd: ctx.projectDir });
    if (r.code !== 0) throw new ActionError('missing-objects', `${commit} is not a commit of the project repository (a missing object is never fetched)`, { rev: commit });
    return r.stdout.toString('utf8').trim();
  }

  /**
   * A later attempt's start (Appendix M): the previous attempt's candidate as it is while the
   * snapshot a first attempt would get now is the one its version's work started from (the same
   * tree); otherwise that snapshot with the version's whole change since its origin laid over it.
   */
  async function carried(req: Parameters<GitActions['snapshot']>[0], carry: NonNullable<Parameters<GitActions['snapshot']>[0]['carry']>) {
    const writable = req.writable !== undefined ? { writable: [...req.writable] } : {};
    const prev = commitOf(req.commit ?? missionBase());
    const v = versionOf(carry.version as ObjectVersionId);
    if (v === null || v.tree === null) throw new ActionError('unknown-product', `product version ${carry.version} is not recorded with a commit`, { product: carry.version });
    let from: GitOid | null;
    try {
      from = await versionOrigin(ctx.git, await repo(), v, versionOf);
    } catch (e) {
      if (e instanceof MissingObjectsError) throw new ActionError('missing-objects', e.message, e);
      throw e;
    }
    const next = await laid(req.mission, missionBase(), carry.products);
    const start = next.commit;
    if (from !== null && treeOf(from) === treeOf(start)) return { path: prev, commit: prev, products: next.products, ...writable };
    const r = await laid(req.mission, start, [carry.version], `mission-pipeline: ${carry.version} laid over a new start of ${req.mission}`, true);
    return { path: r.commit, commit: r.commit, origin: start, products: next.products, ...writable };
  }

  /** The products laid over `at` (the delivery's overlay); a conflict is an ActionError ('conflict'). */
  async function laid(mission: string, at: string, given: readonly string[], message?: string, carry = false): Promise<{ readonly commit: string; readonly products: readonly string[] }> {
    const base = commitOf(at);
    if (given.length === 0) return { commit: base, products: [] };
    // Read closure and proof-unit membership through the delivery's resolver. Labels here are
    // unused: compositionOnly lays content without declaring any of it proven.
    const view = compositionView();
    let manifest: DeliveryManifest;
    if (carry) {
      const objects = given.map((id) => view.object(id as ObjectVersionId));
      if (objects.some((v) => v === null || v.tree === null)) throw new ActionError('unknown-product', 'a carried product has no recorded commit', { products: given });
      // Lay only the task's change; its former dependencies must not replace the new start.
      manifest = { revision: view.revision, selected: [], entries: objects.map((v) => ({ object: { ...v!, prerequisites: [] }, unit: null, label: 'unaccepted', requiredBy: [], chain: [] })), units: [], paths: new Map() };
    } else {
      manifest = compose(view, given);
    }
    const products = manifest.entries.filter((e) => e.object.kind === 'product').map((e) => e.object.id);
    try {
      const layout = await repo();
      // 4.1.2: only the commit is used; nothing is materialized, so no scratch directory or
      // attribute repository is made (the description alone checks the versions rest on it)
      const r = await buildCandidate({
        git: ctx.git,
        repo: layout,
        manifest,
        base: gitOid(base),
        attributes: { description: await description() },
        materialize: 'none',
        message: message ?? `mission-pipeline: snapshot of ${mission} with ${products.join(', ')}`,
        author: ctx.ident(0),
        committer: ctx.ident(0),
        versionOf,
        alreadyLaid: await landedVersions(ctx.git, layout, ctx.memory, gitOid(base), versionOf),
      });
      if (r.kind === 'conflict' && carry) {
        throw new ActionError('conflict', `the change of ${products.join(', ')} since its task's work began conflicts with its dependencies' current products on ${r.conflicts.map((c) => c.path).join(', ')}`, { carried: true, conflicts: r.conflicts });
      }
      if (r.kind === 'conflict') throw new ActionError('conflict', `the accepted products ${products.join(', ')} conflict on ${r.conflicts.map((c) => c.path).join(', ')}`, r.conflicts);
      if (r.kind === 'description-mismatch') throw new ActionError('conflict', `products ${r.versions.join(', ')} rest on another transform description`, r);
      return { commit: r.candidate.commit, products };
    } catch (e) {
      if (e instanceof MissingObjectsError) throw new ActionError('missing-objects', e.message, e);
      throw e;
    }
  }

  return {
    async startHolds(product) {
      try {
        const view = compositionView();
        const version = view.object(product as ObjectVersionId);
        if (version === null || version.tree === null) throw new ActionError('unknown-product', `product version ${product} has no recorded commit`, { product });
        return await startHolds(ctx.git, await repo(), view, version);
      } catch (e) {
        if (e instanceof ActionError) throw e;
        throw new ActionError('missing-objects', `the start of ${product} cannot be checked: ${(e as Error).message}`, e);
      }
    },

    async composition(products) {
      return compose(compositionView(), products).entries.filter((e) => e.object.kind === 'product').map((e) => e.object.id);
    },

    async snapshot(req) {
      if (req.carry !== undefined) return carried(req, req.carry);
      const r = await laid(req.mission, req.commit ?? missionBase(), req.products ?? []);
      return { path: r.commit, commit: r.commit, products: r.products, ...(req.writable !== undefined ? { writable: [...req.writable] } : {}) };
    },

    async product(req: ProductRequest): Promise<ProductVersion> {
      const object = productObjectId(req.task);
      const known = productRecord(object);
      const layout = await repo();
      let entries;
      try {
        entries = await lsTree(ctx.git, layout, req.candidate, { recursive: true });
      } catch (e) {
        if (e instanceof MissingObjectsError) throw new ActionError('missing-objects', e.message, e);
        throw new ActionError('missing-objects', `the candidate ${req.candidate} cannot be read: ${(e as Error).message}`, { candidate: req.candidate });
      }
      if (known !== null && known.source?.commit !== req.candidate) throw new ActionError('conflict', `product version ${object} is recorded with another commit (${known.source?.commit ?? 'none'})`, { object });
      // The origin is the snapshot the version's own change is taken against: inherited while
      // an attempt continues, replaced when the work is carried onto a new start (Appendices H, M).
      let origin: GitOid | null;
      let before: Map<string, string>;
      try {
        origin =
          known?.source?.origin ??
          (await versionOrigin(ctx.git, layout, { id: object, predecessor: req.predecessor, tree: { commit: gitOid(req.candidate), ...(req.origin !== undefined ? { origin: gitOid(req.origin) } : {}) } }, versionOf));
        before =
          origin === null
            ? new Map<string, string>()
            : new Map((await lsTree(ctx.git, layout, origin, { recursive: true })).filter((e) => e.type !== 'tree' && inWriteScope(req.writeScope, e.path)).map((e) => [e.path, `${e.mode} ${e.oid}`]));
      } catch (e) {
        if (e instanceof MissingObjectsError) throw new ActionError('missing-objects', e.message, e);
        throw e;
      }
      const inScope = new Map(entries.filter((e) => e.type !== 'tree' && inWriteScope(req.writeScope, e.path)).map((e) => [e.path, `${e.mode} ${e.oid}`]));
      const changedPaths = [...new Set([...before.keys(), ...inScope.keys()])].filter((p) => before.get(p) !== inScope.get(p)).sort();
      // a task that only reads and runs (an empty write scope), or a first attempt that changed
      // nothing of its base (its dependencies' products and the mission base): its product claims
      // no path, so a delivery that selects it adds no path of its own and never meets its
      // dependencies' paths as "another version". A later attempt keeps its claim: it carries the
      // previous attempts' work.
      const writeScope = req.writeScope.length === 0 || (changedPaths.length === 0 && req.predecessor === null) ? [] : [...req.writeScope];
      const after = writeScope.length === 0 ? new Map<string, string>() : inScope;
      const pv: ProductVersion = { object, commit: req.candidate, snapshot: req.candidate, changedPaths };
      if (known !== null) return pv;
      const d = await description();
      const content = ctx.memory.data.put(writeScopeDocument(entries, writeScope));
      // the bound transform description itself, stored before the version that names it (the landing reads it back by this hash)
      const transform = ctx.memory.data.put(canonicalJson(d));
      if (transform !== transformDescriptionHash(d)) throw new Error(`the stored transform description ${transform} is not its hash ${transformDescriptionHash(d)}`);
      const rec: ObjectVersionRecord = {
        kind: 'object.version',
        object: object as ObjectVersionId,
        objectKind: 'product',
        mission: req.mission as MissionId,
        module: req.module as ModuleId,
        content,
        prerequisites: ctx.memory.data.putList([...req.prerequisites]),
        scope: { paths: writeScope.length === 0 ? [] : [...new Set([...before.keys(), ...after.keys()])].sort(), taskType: req.taskType },
        reviews: [...req.reviews],
        source: { commit: gitOid(req.candidate), writeScope, transform, ...(origin !== null ? { origin } : {}) },
        ...(req.predecessor !== null ? { predecessor: req.predecessor as ObjectVersionId } : {}),
      };
      validateRecord(rec);
      ctx.memory.write({ op: `flow:product-version:${req.mission}:${object}`, payload: { object, commit: req.candidate } }, (tx) => appendRecords(tx, [rec]));
      return pv;
    },

    async rebind(req: RebindRequest): Promise<{ readonly object: string; readonly commit: string }> {
      const from = productRecord(req.of);
      if (from === null || from.source === undefined) throw new ActionError('unknown-product', `product version ${req.of} is not recorded with a commit`, { product: req.of });
      if (req.mission !== from.mission) throw new ActionError('conflict', `product version ${req.of} belongs to another mission`, { object: req.of });
      const source = from.source;
      // the same change as its predecessor: the same commit, taken against the same origin (Appendix H);
      // a predecessor recorded before origins were recorded has it derived now, and the new version records it
      let origin: GitOid | null;
      try {
        origin = source.origin ?? (await versionOrigin(ctx.git, await repo(), placedVersion(from as ObjectVersionRecord & { source: NonNullable<ObjectVersionRecord['source']> }), versionOf));
      } catch (e) {
        if (e instanceof MissingObjectsError) throw new ActionError('missing-objects', e.message, e);
        throw e;
      }
      const rec: ObjectVersionRecord = {
        kind: 'object.version',
        object: req.object as ObjectVersionId,
        objectKind: from.objectKind,
        mission: from.mission,
        module: from.module,
        content: from.content,
        prerequisites: ctx.memory.data.putList([...req.prerequisites]),
        scope: from.scope,
        reviews: [...req.reviews],
        source: { commit: source.commit, writeScope: [...source.writeScope], transform: source.transform, ...(origin !== null ? { origin } : {}) },
        predecessor: req.of as ObjectVersionId,
      };
      validateRecord(rec);
      const known = productRecord(req.object);
      if (known !== null) {
        if (canonicalJson(known) !== canonicalJson(rec)) throw new ActionError('conflict', `product version ${req.object} is recorded with different immutable inputs`, { object: req.object });
        return { object: req.object, commit: source.commit };
      }
      ctx.memory.write({ op: `flow:product-rebind:${req.mission}:${req.object}`, payload: { object: req.object, of: req.of } }, (tx) => appendRecords(tx, [rec]));
      return { object: req.object, commit: source.commit };
    },

    async verify(req: VerifyRequest): Promise<readonly VerificationRun[] | 'pending'> {
      const ids = req.commands.map((c) => c.id);
      const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
      if (dup.length > 0) throw new ActionError('conflict', `the verification commands of ${req.object} repeat ids (${dup.join(', ')}); nothing was run or recorded`, { object: req.object, duplicates: dup });
      // the project's full suite is never run here (a 4.1.1 plan, an integration task, a card in flight):
      // it is left to the integration review, whose full run leaves a marker (D-5, D-7)
      const commands = verificationCommands(ctx.fullSuite, req.commands);
      if (commands.length === 0) return [];
      // a stop stops (§6.6): nothing executes in its scope; the step waits, as for runs in progress
      if (verificationStopped(ctx, req.mission)) return 'pending';
      try {
        const r = await runOnCommit(ctx, {
          mission: req.mission,
          commit: req.snapshot,
          commands,
          purpose: `verification of ${req.object}`,
          declaration: { by: 'mp', checkout: 'clean', declared: true },
          fields: { object: req.object },
        });
        return r.runs.map((x) => ({ evidence: x.evidence, command: x.command.command, summary: x.summary, passed: x.passed, ...(x.setupFailure === undefined ? {} : { setupFailure: x.setupFailure }) }));
      } catch (e) {
        // the same declared runs are executing in another mp process (their run lock is held):
        // nothing was run or recorded; the step waits, and its next pass reuses the recorded runs
        if (e instanceof RunInProgress) return 'pending';
        if (e instanceof MissingObjectsError) throw new ActionError('missing-objects', e.message, e);
        if (e instanceof LedgerError && e.code === 'GIT_WRITES_HELD') throw new ActionError('git-held', e.message, null);
        throw e;
      }
    },

    async findSymbol(req) {
      // read-only, no model: the file exists in the commit and names the symbol
      const rel = req.file.replace(/^\.\//, '');
      if (rel === '' || rel.startsWith('/') || rel.split('/').some((x) => x === '..' || x === '.git')) return false;
      const r = ctx.git.runSync(['cat-file', '-p', `${req.snapshot}:${rel}`], { cwd: ctx.projectDir });
      return r.code === 0 && r.stdout.toString('utf8').includes(req.symbol);
    },

    async history(mission: MissionId) {
      const log = ctx.git.runSync(['log', '--oneline', '-n', '30', missionBase()], { cwd: ctx.projectDir });
      // past run durations: the declared runs this project recorded (newest 50)
      const runs = ctx.memory.read((db) =>
        (db.stmt("SELECT record FROM log WHERE kind = 'evidence' ORDER BY rev DESC LIMIT 50").all() as Array<{ record: string }>).flatMap((r) => {
          const rec = JSON.parse(r.record) as { fields: Record<string, string> };
          const ms = Number(rec.fields['durationMs']);
          return Number.isFinite(ms) && rec.fields['purpose'] !== undefined ? [{ task: rec.fields['purpose']!, seat: 'mp', durationMs: ms, costMicros: 0 }] : [];
        }),
      );
      void mission;
      return { gitLog: log.code === 0 ? log.stdout.toString('utf8').trim() : '', runs };
    },
  };
}
