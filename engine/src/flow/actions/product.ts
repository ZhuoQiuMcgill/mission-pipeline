// The product version of an accepted Constructor export (design 4.2 "由程序生成提交", 7.1
// "先规范化，再验证", 5.1, 6.5 "生成提交也是一处写入，单独准入").
//
//   1. The Constructor's snapshot is materialized again from its commit (the base the seat saw),
//      and the export of its writable paths is laid over it: inside the write scope, the export
//      is the product (a path the export lacks is deleted); outside it nothing changes (a stray
//      write outside the scope is not part of the product).
//   2. canonicalize (src/git/representation.ts): the commit in the repository representation
//      (rejecting what cannot be represented: unsupported transforms, special files, unsafe
//      paths, excluded files written), admitted per destination before any object is written
//      (6.5), then the canonical candidate materialized from that commit: what verification and
//      review run on.
//   3. The product version (5.1): its content is the write-scope identity of the commit
//      (src/delivery/writeScope.ts), its scope the concrete paths inside the write scope, its
//      source the commit, the write scope and the transform description; plus the prerequisites
//      and the review contracts the flow fixed. Recorded once per Constructor task.
//
// Idempotent: the result is kept under the work directory, and the ledger op is per object.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import { writeFileAtomic } from '../../common/fsx.ts';
import { canonicalJson } from '../../common/hash.ts';
import { contentHash, type MissionId, type ModuleId, type ObjectVersionId } from '../../common/ids.ts';
import type { ObjectVersionRecord } from '../../common/records.ts';
import { validateRecord } from '../../common/validate.ts';
import { inWriteScope, writeScopeDocument } from '../../delivery/writeScope.ts';
import type { TreeDocument } from '../../exec/export.ts';
import { admit, commitGenerationDemands, probeFs } from '../../git/admission.ts';
import { lsTree } from '../../git/objects.ts';
import { canonicalize, materializeSnapshot, MissingObjectsError, transformDescriptionHash, type CommitWriteSizes } from '../../git/representation.ts';
import { safeId } from '../context.ts';
import type { ProductRequest, ProductVersion } from '../ports.ts';
import { ActionError, attributesOf, excludeOf, type ActionContext } from './context.ts';
import { safeSymlink, safeWriteFile } from './safefs.ts';

function safeRel(p: string): string {
  const n = posix.normalize(p);
  if (p === '' || posix.isAbsolute(p) || n !== p || n === '..' || n.startsWith('../') || n.split('/').includes('.git')) {
    throw new ActionError('product-rejected', `the export names an unsafe path ${JSON.stringify(p)}`, { path: p });
  }
  return n;
}

/** Every regular file and symlink under `root` (relative paths), not following links. */
function listFiles(root: string, rel = ''): string[] {
  const abs = rel === '' ? root : join(root, rel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const d of readdirSync(abs, { withFileTypes: true })) {
    const p = rel === '' ? d.name : `${rel}/${d.name}`;
    if (d.isDirectory()) out.push(...listFiles(root, p));
    else out.push(p);
  }
  return out;
}

/**
 * Lay the export over the seat directory: inside the write scope it replaces what is there.
 * Nothing is written through a symbolic link (code review r1 #1): an export entry under a link
 * (of the base or of the export itself) is refused as an unusable result.
 */
export function applyExport(seatDir: string, doc: TreeDocument, writeScope: readonly string[], read: (hash: string) => Buffer): void {
  if (doc.format !== 'mp4.tree.v1' || !Array.isArray(doc.entries)) throw new ActionError('product-rejected', 'the export is not a tree document');
  if (doc.incomplete !== undefined) throw new ActionError('product-rejected', `the export is incomplete (${doc.incomplete.reason})`);
  // a path inside the write scope that the export does not have is deleted (a link is removed, never followed)
  for (const p of listFiles(seatDir)) if (inWriteScope(writeScope, p)) rmSync(join(seatDir, p), { force: true });
  const entries = [...doc.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  try {
    for (const e of entries) {
      if (e.path === '.' || e.kind === 'dir') continue; // directories follow from their files
      const p = safeRel(e.path);
      if (!inWriteScope(writeScope, p)) continue; // outside the write scope: not part of the product
      if (e.truncatedFrom !== undefined) throw new ActionError('product-rejected', `${p} was cut in the export`, { path: p });
      if (e.kind === 'symlink') {
        safeSymlink(seatDir, p, e.target ?? '');
        continue;
      }
      if (e.hash === null) throw new ActionError('product-rejected', `${p} has no stored content`, { path: p });
      const data = read(e.hash);
      if (data.length !== e.size) throw new ActionError('product-rejected', `${p} is ${data.length} bytes in the store, ${e.size} in the export`, { path: p });
      safeWriteFile(seatDir, p, data, (e.mode & 0o111) !== 0);
    }
  } catch (err) {
    if (err instanceof ActionError && err.code === 'unsafe-path') throw new ActionError('product-rejected', `the export writes through a symbolic link: ${err.message}`, err.detail);
    throw err;
  }
}

/** 6.5: the commit's objects, LFS objects and temporary files, admitted per filesystem. */
function commitAdmission(ctx: ActionContext, tempDir: string): { check: (s: CommitWriteSizes) => boolean; reasons: () => string[] } {
  const probe = ctx.disk.probe ?? probeFs;
  let reasons: string[] = [];
  return {
    check: (s) => {
      const objFs = probe(join(ctx.repo.commonDir, 'objects'));
      const tmpFs = probe(tempDir);
      const lfsFs = probe(ctx.repo.commonDir);
      const d = admit(
        commitGenerationDemands({
          objects: { fs: objFs, sharesLedgerVolume: ctx.disk.sharesVolume(objFs), newObjects: s.newObjects },
          lfs: s.lfsObjectSizes.length > 0 ? { fs: lfsFs, sharesLedgerVolume: ctx.disk.sharesVolume(lfsFs), newObjects: s.lfsObjectSizes.map((size) => ({ size, hardlinked: false })) } : null,
          temp: s.tempFileSizes.length > 0 ? { fs: tmpFs, sharesLedgerVolume: ctx.disk.sharesVolume(tmpFs), fileSizes: s.tempFileSizes } : null,
        }),
        ctx.disk.reserve,
      );
      reasons = [...d.reasons];
      return d.ok;
    },
    reasons: () => reasons,
  };
}

export const productObjectId = (task: string): string => safeId(`prod.${task}`);

export async function makeProduct(ctx: ActionContext, req: ProductRequest): Promise<ProductVersion> {
  const object = productObjectId(req.task);
  const dir = join(ctx.workDir, 'products', object);
  const resultFile = join(dir, 'product.json');
  const commitFile = join(dir, 'commit.json');
  const candidateDir = join(dir, 'candidate');
  if (existsSync(resultFile)) {
    const known = JSON.parse(readFileSync(resultFile, 'utf8')) as ProductVersion;
    await recordVersion(ctx, req, known); // the ledger op is idempotent (a crash between the two writes)
    return known;
  }
  // recovery (code review r1 #16): a version already recorded, or a commit already generated, is
  // reused, never generated again (a new commit would not match the recorded version)
  const recorded = await ctx.ledger.objectVersion(object);
  const generated = recorded?.source?.commit ?? (existsSync(commitFile) ? (JSON.parse(readFileSync(commitFile, 'utf8')) as { commit: string }).commit : null);
  if (generated !== null) {
    const pv = await fromCommit(ctx, req, object, generated, candidateDir);
    await recordVersion(ctx, req, pv);
    writeFileAtomic(resultFile, JSON.stringify(pv));
    return pv;
  }
  const seatDir = join(dir, 'seat');
  const tempDir = join(dir, 'tmp');
  for (const d of [seatDir, candidateDir, tempDir]) rmSync(d, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  const attributes = await attributesOf(ctx);
  const exclude = excludeOf(ctx);
  try {
    // 1. the Constructor's snapshot, with its export laid over the write scope
    const base = await materializeSnapshot({ git: ctx.git, repo: ctx.repo, commit: req.base, attributes, dest: seatDir, exclude });
    const doc = JSON.parse(ctx.exports.get(contentHash(req.export)).toString('utf8')) as TreeDocument;
    applyExport(seatDir, doc, req.writeScope, (h) => ctx.exports.get(contentHash(h)));
    // 2. the commit and the canonical candidate (7.1), admitted first (6.5)
    const adm = commitAdmission(ctx, tempDir);
    const r = await canonicalize({
      git: ctx.git,
      repo: ctx.repo,
      base,
      snapshotDir: seatDir,
      attributes,
      exclude,
      message: `mission-pipeline: ${req.task} (mission ${req.mission})`,
      author: ctx.ident,
      committer: ctx.ident,
      tempDir,
      candidateDir,
      admit: adm.check,
    });
    if (r.kind === 'rejected') throw new ActionError('product-rejected', `the export cannot be committed (${r.rejection.code}): ${r.rejection.detail}`, r.rejection);
    if (r.kind === 'not-admitted') throw new ActionError('not-admitted', `not enough space to write the product commit: ${adm.reasons().join('; ')}`, r.sizes);
    const changed = [...new Set([...r.plan.added, ...r.plan.modified, ...r.plan.deleted, ...r.plan.modeChanged])].filter((p) => inWriteScope(req.writeScope, p)).sort();
    const pv: ProductVersion = { object, commit: r.commit, snapshot: candidateDir, changedPaths: changed };
    writeFileAtomic(commitFile, JSON.stringify({ commit: r.commit })); // before the ledger: a crash after it reuses this commit
    await recordVersion(ctx, req, pv);
    writeFileAtomic(resultFile, JSON.stringify(pv));
    rmSync(seatDir, { recursive: true, force: true });
    return pv;
  } catch (e) {
    if (e instanceof MissingObjectsError) throw new ActionError('missing-objects', e.message, e);
    throw e;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** A product version from a commit already generated: its canonical candidate and its changed paths (recovery). */
async function fromCommit(ctx: ActionContext, req: ProductRequest, object: string, commit: string, candidateDir: string): Promise<ProductVersion> {
  rmSync(candidateDir, { recursive: true, force: true });
  await materializeSnapshot({ git: ctx.git, repo: ctx.repo, commit, attributes: await attributesOf(ctx), dest: candidateDir, exclude: excludeOf(ctx) });
  const inScope = async (rev: string): Promise<Map<string, string>> =>
    new Map((await lsTree(ctx.git, ctx.repo, rev, { recursive: true })).filter((e) => e.type !== 'tree' && inWriteScope(req.writeScope, e.path)).map((e) => [e.path, `${e.mode} ${e.oid}`]));
  const before = await inScope(req.base);
  const after = await inScope(commit);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)).sort();
  return { object, commit, snapshot: candidateDir, changedPaths: changed };
}

/** 5.1: the product version, with its contracts (10.1) and its tree placement (6.6). */
async function recordVersion(ctx: ActionContext, req: ProductRequest, pv: ProductVersion): Promise<void> {
  const entries = await lsTree(ctx.git, ctx.repo, pv.commit, { recursive: true });
  const content = ctx.ledger.content.put(writeScopeDocument(entries, req.writeScope));
  const paths = entries.filter((e) => e.type !== 'tree' && inWriteScope(req.writeScope, e.path)).map((e) => e.path);
  // the bound transform description itself, stored before the version that names it (e2e B4: the
  // landing reads it back by this hash); exactly the bytes that were hashed
  const transform = ctx.ledger.content.put(canonicalJson(ctx.description));
  if (transform !== transformDescriptionHash(ctx.description)) throw new Error(`the stored transform description ${transform} is not its hash ${transformDescriptionHash(ctx.description)}`);
  const rec: ObjectVersionRecord = {
    kind: 'object.version',
    object: pv.object as ObjectVersionId,
    objectKind: 'product',
    mission: req.mission as MissionId,
    module: req.module as ModuleId,
    content,
    prerequisites: ctx.ledger.content.putList([...req.prerequisites]),
    scope: { paths, taskType: req.taskType },
    reviews: [...req.reviews],
    source: { commit: pv.commit as never, writeScope: [...req.writeScope], transform },
    ...(req.predecessor !== null ? { predecessor: req.predecessor as ObjectVersionId } : {}),
  };
  validateRecord(rec);
  await ctx.ledger.append(`flow:product-version:${req.mission}:${pv.object}`, { records: [rec] });
}
