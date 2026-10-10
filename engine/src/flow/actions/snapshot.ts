// The project snapshot a seat works on (design 7.1 "只挂载这个席位的项目快照", 5.3, 6.5).
//
// A snapshot is a directory in the worktree representation, materialized by the program from a
// commit under the bound transform description (src/git/representation.ts materializeSnapshot):
// no .git, no project instruction files (7.1), never git's checkout path. A dependent task sees
// its prerequisites: their accepted product versions are laid over the base with the delivery
// candidate's overlay (src/delivery/candidate.ts buildCandidate: each version brings its own
// changes inside its write scope, three-way; a conflict is refused), which writes the overlay's
// trees and commit into the repository's object store, admitted first (6.5).
//
// Snapshots are cached by (commit, products, transform description): a complete one has its
// manifest written last. A seat's writable paths must exist in its snapshot (the sandbox binds
// them): write-scope directories are created empty when missing, and a write-scope file that
// does not exist yet is written through its parent directory (the product is still only what
// falls inside the write scope, product.ts).

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import { writeFileAtomic } from '../../common/fsx.ts';
import { shortHash } from '../context.ts';
import type { MissionId } from '../../common/ids.ts';
import type { ObjectVersionRecord } from '../../common/records.ts';
import { buildCandidate, type CandidateAdmission } from '../../delivery/candidate.ts';
import type { DeliveryManifest } from '../../delivery/manifest.ts';
import type { DeliveryObject } from '../../delivery/proofView.ts';
import { admit, commitGenerationDemands, probeFs, roundUp } from '../../git/admission.ts';
import { gitOid, resolveCommit } from '../../git/objects.ts';
import { materializeSnapshot, MissingObjectsError, transformDescriptionHash } from '../../git/representation.ts';
import { ActionError, attributesOf, excludeOf, type ActionContext } from './context.ts';
import { safeDir, safeKind } from './safefs.ts';

export interface SnapshotRequest {
  readonly mission: MissionId;
  readonly purpose: string;
  readonly commit?: string;
  readonly products?: readonly string[];
  /** Write-scope patterns of the seat: their sandbox writable paths are prepared and returned. */
  readonly writable?: readonly string[];
}

export interface SnapshotResult {
  readonly path: string;
  readonly commit: string;
  /** The sandbox writable paths for `writable` (existing in the snapshot, not nested). */
  readonly writable?: readonly string[];
}

/** 6.5: the overlay's objects and its materialized files, admitted per destination. */
function candidateAdmission(ctx: ActionContext, snapshotParent: string): CandidateAdmission {
  const probe = ctx.disk.probe ?? probeFs;
  return {
    objects: (newObjects) => {
      const fs = probe(join(ctx.repo.commonDir, 'objects'));
      return admit(commitGenerationDemands({ objects: { fs, sharesLedgerVolume: ctx.disk.sharesVolume(fs), newObjects }, lfs: null, temp: null }), ctx.disk.reserve);
    },
    snapshot: (fileSizes, directories) => {
      const fs = probe(snapshotParent);
      let data = 0;
      for (const size of fileSizes) data += roundUp(size, fs.blockSize);
      const entries = fileSizes.length + directories;
      return admit([{ destination: 'seat snapshot', fs, dataBytes: data, metadataEntries: entries, inodes: entries, fixedBytes: 0, sharesLedgerVolume: ctx.disk.sharesVolume(fs) }], ctx.disk.reserve);
    },
  };
}

/** The product versions named, as delivery objects with their tree placement (ObjectVersionRecord.source). */
async function placedProducts(ctx: ActionContext, ids: readonly string[]): Promise<DeliveryObject[]> {
  const records = new Map<string, ObjectVersionRecord | null>();
  for (const id of ids) records.set(id, await ctx.ledger.objectVersion(id));
  return ids.map((id) => {
    const r = records.get(id) ?? undefined;
    if (r === undefined || r.source === undefined) throw new ActionError('unknown-product', `product version ${id} is not recorded with a commit`, { product: id });
    return { id: r.object, kind: r.objectKind, mission: r.mission, module: r.module, content: r.content, prerequisites: [], paths: [...r.scope.paths], tree: r.source };
  });
}

/**
 * The sandbox writable paths of write-scope patterns, prepared in the snapshot directory. Every
 * component is checked without following links (code review r1 #1): a write scope through a
 * symbolic link of the snapshot is refused (ActionError "unsafe-path"; the sandbox would refuse
 * it too), and nothing is ever created outside the snapshot.
 */
export function prepareWritable(tree: string, patterns: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    const rel = p === '**' ? '.' : p.endsWith('/**') ? p.slice(0, -3) : p;
    if (rel === '.') {
      out.push('.');
      continue;
    }
    const kind = safeKind(tree, rel);
    if (kind === 'link') throw new ActionError('unsafe-path', `write scope ${p} names a symbolic link of the snapshot`, { pattern: p });
    if (kind !== 'missing') out.push(rel);
    else if (p.endsWith('/**')) {
      safeDir(tree, rel, true);
      out.push(rel);
    } else {
      // a file that does not exist yet: written through its parent directory
      const parent = posix.dirname(rel);
      safeDir(tree, parent, true);
      out.push(parent);
    }
  }
  // the sandbox refuses nested writable paths: keep the outermost
  const unique = [...new Set(out)].sort();
  return unique.filter((w) => !unique.some((o) => o !== w && (o === '.' || w.startsWith(`${o}/`))));
}

export async function makeSnapshot(ctx: ActionContext, req: SnapshotRequest): Promise<SnapshotResult> {
  const attributes = await attributesOf(ctx);
  const rev = req.commit ?? (await ctx.base(req.mission));
  const base = await resolveCommit(ctx.git, ctx.repo, rev);
  if (base === null) throw new ActionError('missing-objects', `${rev} is not a commit of the project repository`, { rev });
  const products = [...new Set(req.products ?? [])].sort();
  const key = shortHash({ base, products, description: transformDescriptionHash(ctx.description) });
  const dir = join(ctx.workDir, 'snapshots', key);
  const tree = join(dir, 'tree');
  const done = join(dir, 'snapshot.json');
  let commit: string;
  if (existsSync(done)) commit = (JSON.parse(readFileSync(done, 'utf8')) as { commit: string }).commit;
  else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    commit = base;
    try {
      if (products.length > 0) {
        const objects = await placedProducts(ctx, products);
        const manifest: DeliveryManifest = {
          revision: 0 as never,
          selected: [],
          entries: objects.map((object) => ({ object, unit: null, label: 'proven', requiredBy: [], chain: [] })),
          units: [],
          paths: new Map(),
        };
        const overlayDir = join(dir, 'overlay');
        const r = await buildCandidate({
          git: ctx.git,
          repo: ctx.repo,
          manifest,
          base: gitOid(base),
          attributes,
          snapshotDir: overlayDir,
          message: `mission-pipeline: snapshot of ${req.mission} with ${products.join(', ')}`,
          author: ctx.ident,
          committer: ctx.ident,
          admission: candidateAdmission(ctx, dir),
        });
        if (r.kind === 'conflict') throw new ActionError('conflict', `the accepted products ${products.join(', ')} conflict on ${r.conflicts.map((c) => c.path).join(', ')}`, r.conflicts);
        if (r.kind === 'description-mismatch') throw new ActionError('conflict', `products ${r.versions.join(', ')} rest on another transform description`, r);
        if (r.kind === 'not-admitted') throw new ActionError('not-admitted', `not enough space for the snapshot overlay: ${r.decision.reasons.join('; ')}`, r.decision);
        commit = r.candidate.commit;
        rmSync(overlayDir, { recursive: true, force: true }); // re-materialized below without the excluded files
      }
      await materializeSnapshot({ git: ctx.git, repo: ctx.repo, commit, attributes, dest: tree, exclude: excludeOf(ctx) });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      if (e instanceof MissingObjectsError) throw new ActionError('missing-objects', e.message, e);
      throw e;
    }
    writeFileAtomic(done, JSON.stringify({ format: 'mp4.flow-snapshot.v1', base, products, commit, purpose: req.purpose }));
  }
  return { path: tree, commit, ...(req.writable !== undefined ? { writable: prepareWritable(tree, req.writable) } : {}) };
}

