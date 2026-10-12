// The program actions the flows need beyond the memory (design 4.1 §5.3, §14 "Process"), with
// plain git (src/git) and the project's declared commands (runs.ts):
//   snapshot    the commit a seat reads: the mission's base (the target branch's head) or a given
//               commit, with accepted product versions laid over it (a dependent task sees its
//               prerequisites, 5.3) by the delivery's overlay (delivery/candidate.ts); the card
//               names the commit, `mp seat <id> checkout` materializes it
//   product     the product version of a Constructor's candidate commit (5.1): its content is the
//               write-scope identity of the commit, its source the commit, the write scope, the
//               transform description (A4's handoff) and its origin, the snapshot the task's
//               first attempt started from (a rework continues from the previous attempt's
//               candidate; its change is every attempt's, Appendix H)
//   rebind      a kept product re-bound under the plan in effect (Appendix J): a successor version
//               with the same content and source, its origin recorded, its own prerequisites and
//               review contracts
//   verify      the declared runs on a clean checkout of the candidate (§5.3; reused when §6.5 allows;
//               "pending", with nothing run or recorded, while another mp process executes them)
//   findSymbol  3.5: a file of a commit names a symbol (read-only, no model)
//   history     3.4: the git log and past run durations, for the Architect's card
// Every action is idempotent: a product version is recorded once per object id, a snapshot of the
// same inputs is the same commit, a verification is reused.

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../common/hash.ts';
import type { GitOid, MissionId, ModuleId, ObjectVersionId } from '../common/ids.ts';
import type { ObjectVersionRecord } from '../common/records.ts';
import { validateRecord } from '../common/validate.ts';
import { buildCandidate, versionOrigin } from '../delivery/candidate.ts';
import type { DeliveryManifest } from '../delivery/manifest.ts';
import type { DeliveryObject } from '../delivery/proofView.ts';
import { inWriteScope, writeScopeDocument } from '../delivery/writeScope.ts';
import { discoverRepo, gitOid, lsTree, type RepoLayout } from '../git/objects.ts';
import { AttributeEvaluator, MissingObjectsError, readTransformDescription, transformDescriptionHash, type TransformDescription } from '../git/representation.ts';
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

export function gitActions(ctx: ProcessContext): GitActions {
  const shared: Shared = { repo: null, description: null };
  const repo = (): Promise<RepoLayout> => (shared.repo ??= discoverRepo(ctx.git, ctx.projectDir));
  const description = async (): Promise<TransformDescription> => (shared.description ??= readTransformDescription(ctx.git, await repo(), ctx.projectDir));

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

  return {
    async snapshot(req) {
      const base = commitOf(req.commit ?? missionBase());
      const products = [...new Set(req.products ?? [])].sort();
      if (products.length === 0) return { path: base, commit: base, ...(req.writable !== undefined ? { writable: [...req.writable] } : {}) };
      // a dependent task sees its prerequisites: their versions laid over the base (the delivery's overlay, 5.3),
      // each with its whole change since its task's first attempt began (Appendix H)
      const objects: DeliveryObject[] = products.map((id) => {
        const v = versionOf(id as ObjectVersionId);
        if (v === null) throw new ActionError('unknown-product', `product version ${id} is not recorded with a commit`, { product: id });
        return v;
      });
      const manifest: DeliveryManifest = {
        revision: 0 as never,
        selected: [],
        entries: objects.map((object) => ({ object, unit: null, label: 'proven', requiredBy: [], chain: [] })),
        units: [],
        paths: new Map(),
      };
      const scratch = mkdtempSync(join(ctx.memory.paths.tmp, 'snapshot-'));
      let attributes: AttributeEvaluator | null = null;
      try {
        const layout = await repo();
        attributes = await AttributeEvaluator.create(ctx.git, layout, await description(), scratch);
        const r = await buildCandidate({
          git: ctx.git,
          repo: layout,
          manifest,
          base: gitOid(base),
          attributes,
          snapshotDir: join(scratch, 'overlay'),
          message: `mission-pipeline: snapshot of ${req.mission} with ${products.join(', ')}`,
          author: ctx.ident(0),
          committer: ctx.ident(0),
          versionOf,
        });
        if (r.kind === 'conflict') throw new ActionError('conflict', `the accepted products ${products.join(', ')} conflict on ${r.conflicts.map((c) => c.path).join(', ')}`, r.conflicts);
        if (r.kind === 'description-mismatch') throw new ActionError('conflict', `products ${r.versions.join(', ')} rest on another transform description`, r);
        return { path: r.candidate.commit, commit: r.candidate.commit, ...(req.writable !== undefined ? { writable: [...req.writable] } : {}) };
      } catch (e) {
        if (e instanceof MissingObjectsError) throw new ActionError('missing-objects', e.message, e);
        throw e;
      } finally {
        attributes?.dispose();
        rmSync(scratch, { recursive: true, force: true });
      }
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
      // the version's own change is taken against its origin, the snapshot its task's first attempt
      // started from: a rework's worktree starts at the previous attempt's candidate (its base here),
      // so the change since the base is only the last attempt's (Appendix H)
      let origin: GitOid | null;
      let before: Map<string, string>;
      try {
        origin =
          known?.source?.origin ??
          (await versionOrigin(ctx.git, layout, { id: object, predecessor: req.predecessor, tree: { commit: gitOid(req.candidate) } }, versionOf));
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
        scope: { paths: [...after.keys()].sort(), taskType: req.taskType },
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
      const source = from.source;
      const known = productRecord(req.object);
      if (known !== null) {
        if (known.predecessor !== req.of || known.source?.commit !== source.commit) throw new ActionError('conflict', `product version ${req.object} is recorded as another version`, { object: req.object });
        return { object: req.object, commit: source.commit };
      }
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
      ctx.memory.write({ op: `flow:product-rebind:${req.mission}:${req.object}`, payload: { object: req.object, of: req.of } }, (tx) => appendRecords(tx, [rec]));
      return { object: req.object, commit: source.commit };
    },

    async verify(req: VerifyRequest): Promise<readonly VerificationRun[] | 'pending'> {
      const ids = req.commands.map((c) => c.id);
      const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
      if (dup.length > 0) throw new ActionError('conflict', `the verification commands of ${req.object} repeat ids (${dup.join(', ')}); nothing was run or recorded`, { object: req.object, duplicates: dup });
      if (req.commands.length === 0) return [];
      try {
        const r = await runOnCommit(ctx, {
          mission: req.mission,
          commit: req.snapshot,
          commands: req.commands,
          purpose: `verification of ${req.object}`,
          declaration: { by: 'mp', checkout: 'clean', declared: true },
          fields: { object: req.object },
        });
        return r.runs.map((x) => ({ evidence: x.evidence, command: x.command.command, summary: x.summary, passed: x.passed }));
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
