// The materialized-change set (design 6.6 "物化变化集合").
//
// Admission, the update and the post-landing check all use one set: every path
// whose bytes materialized under the base commit's attributes differ from its
// bytes materialized under the delivery commit's attributes, with the bound
// transform description on both sides. That is
//   - every path whose tree entry changed (git's update writes or removes it);
//     these are always in the set, even when both blobs materialize identically;
//   - every path under a directory whose .gitattributes changed, when the
//     materialized bytes really differ ("attribute-only" paths). git's push does
//     not rewrite them, so their presence blocks automatic landing.
// Transform-description changes never reach here: landing refuses them first (6.6 step 7.5).

import type { ContentHash, GitOid } from '../common/ids.ts';
import type { LfsPointer } from './lfs.ts';
import { baseName, gitOid, lsTree, readObjects, repoArgs, treeOfCommit, type FileMode, type RepoLayout, type TreeEntry } from './objects.ts';
import {
  lfsObjectState,
  resolveConversion,
  sameConversion,
  toWorktree,
  transformDescriptionHash,
  unsafePathReason,
  type AttributeEvaluator,
  type ConversionAttributes,
  type PathConversion,
  type UnsupportedPath,
  type WorktreeBytes,
} from './representation.ts';
import type { SafeGit } from './safeGit.ts';

export interface MaterializedSide {
  readonly mode: FileMode;
  readonly oid: GitOid;
  readonly kind: 'file' | 'symlink' | 'gitlink';
  readonly conversion: PathConversion | null;
  /** Exact materialized size: converted bytes (LFS: the pointer's size), a symlink's target length; null for gitlinks and unsupported paths. */
  readonly size: number | null;
  readonly lfs: LfsPointer | null;
  readonly unsupported: string | null;
}

export interface ChangeSetEntry {
  readonly path: string;
  readonly before: MaterializedSide | null;
  readonly after: MaterializedSide | null;
  /** The tree entry differs: the push writes or removes this path. */
  readonly treeChanged: boolean;
  /** In the set because materialized bytes (or presence, kind) differ. Always true here. */
  readonly bytesChanged: boolean;
}

export interface MaterializedChangeSet {
  readonly base: GitOid;
  readonly delivery: GitOid;
  readonly baseTree: GitOid;
  readonly deliveryTree: GitOid;
  readonly descriptionHash: ContentHash;
  /** Sorted by path. */
  readonly entries: readonly ChangeSetEntry[];
  /** Bytes differ only because attributes changed: git will not rewrite them (blocks automatic landing). */
  readonly attributeOnly: readonly string[];
  /** Paths the landing would write whose transform the program cannot represent (blocks automatic landing). */
  readonly unsupported: readonly UnsupportedPath[];
  /** Paths the landing would write that are not safe to write into a worktree. */
  readonly unsafe: readonly UnsupportedPath[];
  readonly lfsPaths: readonly string[];
  /** LFS objects the landing needs that are not in the local store, or are there but corrupt (a landing never downloads, v49). */
  readonly lfsMissing: readonly LfsPointer[];
}

function kindOf(mode: FileMode): 'file' | 'symlink' | 'gitlink' {
  return mode === '120000' ? 'symlink' : mode === '160000' ? 'gitlink' : 'file';
}

function isRegular(mode: string): boolean {
  return mode === '100644' || mode === '100755';
}

function side(mode: FileMode, oid: GitOid, conv: PathConversion | null, w: WorktreeBytes | null, blobSize: number | null): MaterializedSide {
  const kind = kindOf(mode);
  if (kind === 'gitlink') return { mode, oid, kind, conversion: null, size: null, lfs: null, unsupported: null };
  if (kind === 'symlink') return { mode, oid, kind, conversion: null, size: blobSize, lfs: null, unsupported: null };
  if (w === null) throw new Error('regular file side needs its materialized bytes');
  switch (w.kind) {
    case 'bytes':
      return { mode, oid, kind, conversion: conv, size: w.data.length, lfs: null, unsupported: null };
    case 'lfs-object':
      return { mode, oid, kind, conversion: conv, size: w.pointer.size, lfs: w.pointer, unsupported: null };
    case 'unsupported':
      return { mode, oid, kind, conversion: conv, size: null, lfs: null, unsupported: w.reason };
  }
}

function sameBytes(a: WorktreeBytes, b: WorktreeBytes): boolean {
  if (a.kind === 'bytes' && b.kind === 'bytes') return a.data.equals(b.data);
  if (a.kind === 'lfs-object' && b.kind === 'lfs-object') return a.pointer.oid === b.pointer.oid && a.pointer.size === b.pointer.size;
  return false;
}

interface RawChange {
  readonly path: string;
  readonly before: { mode: FileMode; oid: GitOid } | null;
  readonly after: { mode: FileMode; oid: GitOid } | null;
}

function fileMode(m: string): FileMode {
  if (m === '100644' || m === '100755' || m === '120000' || m === '160000') return m;
  if (m === '100664') return '100644';
  throw new Error(`unsupported mode ${m}`);
}

async function diffTrees(git: SafeGit, repo: RepoLayout, a: GitOid, b: GitOid): Promise<RawChange[]> {
  const r = await git.ok([...repoArgs(repo), 'diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', '--no-ext-diff', '--no-textconv', a, b], {
    cwd: repo.commonDir,
    maxOutputBytes: 1024 * 1024 * 1024,
  });
  const fields = r.stdout.toString('utf8').split('\0');
  const out: RawChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i] as string;
    const path = fields[i + 1] as string;
    if (!meta.startsWith(':')) throw new Error(`unexpected diff-tree record ${meta}`);
    const [srcMode, dstMode, srcOid, dstOid] = meta.slice(1).split(' ');
    if (srcMode === undefined || dstMode === undefined || srcOid === undefined || dstOid === undefined) throw new Error('bad diff-tree record');
    out.push({
      path,
      before: srcMode === '000000' ? null : { mode: fileMode(srcMode), oid: gitOid(srcOid) },
      after: dstMode === '000000' ? null : { mode: fileMode(dstMode), oid: gitOid(dstOid) },
    });
  }
  return out;
}

function underDir(path: string, dir: string): boolean {
  return dir === '' || path.startsWith(dir + '/');
}

export interface ChangeSetOptions {
  readonly git: SafeGit;
  readonly repo: RepoLayout;
  readonly base: GitOid;
  readonly delivery: GitOid;
  /** Carries the bound transform description. */
  readonly attributes: AttributeEvaluator;
}

export async function computeMaterializedChangeSet(o: ChangeSetOptions): Promise<MaterializedChangeSet> {
  const { git, repo } = o;
  const d = o.attributes.description;
  const baseTree = await treeOfCommit(git, repo, o.base);
  const deliveryTree = await treeOfCommit(git, repo, o.delivery);
  const changes = await diffTrees(git, repo, baseTree, deliveryTree);
  const changed = new Set(changes.map((c) => c.path));
  const attrDirs = [...new Set(changes.filter((c) => baseName(c.path) === '.gitattributes').map((c) => c.path.slice(0, -'.gitattributes'.length).replace(/\/$/, '')))];

  // Paths whose tree entry did not change but whose attributes may have.
  const candidates: { path: string; entry: TreeEntry }[] = [];
  if (attrDirs.length > 0) {
    for (const e of await lsTree(git, repo, deliveryTree, { recursive: true })) {
      if (changed.has(e.path) || !isRegular(e.mode)) continue;
      if (attrDirs.some((dir) => underDir(e.path, dir))) candidates.push({ path: e.path, entry: e });
    }
  }

  const beforePaths = [...changes.filter((c) => c.before !== null && isRegular(c.before.mode)).map((c) => c.path), ...candidates.map((c) => c.path)];
  const afterPaths = [...changes.filter((c) => c.after !== null && isRegular(c.after.mode)).map((c) => c.path), ...candidates.map((c) => c.path)];
  const beforeAttrs = await o.attributes.atTree(baseTree, beforePaths);
  const afterAttrs = await o.attributes.atTree(deliveryTree, afterPaths);
  const conv = (m: Map<string, ConversionAttributes>, p: string): PathConversion => resolveConversion(m.get(p) as ConversionAttributes, d);

  // Blobs are read in bounded batches and materialized as they arrive; none is kept.
  // Read: every changed regular file's new blob (exact size), symlink targets (size),
  // and candidates whose conversion differs between the two sides.
  const differing = candidates.filter((c) => !sameConversion(conv(beforeAttrs, c.path), conv(afterAttrs, c.path)));
  const changedByOid = new Map<GitOid, RawChange[]>();
  for (const c of changes) {
    if (c.after === null || c.after.mode === '160000') continue;
    const list = changedByOid.get(c.after.oid);
    if (list === undefined) changedByOid.set(c.after.oid, [c]);
    else list.push(c);
  }
  const differingByOid = new Map<GitOid, { path: string; entry: TreeEntry }[]>();
  for (const c of differing) {
    const list = differingByOid.get(c.entry.oid);
    if (list === undefined) differingByOid.set(c.entry.oid, [c]);
    else list.push(c);
  }
  const afterSides = new Map<string, MaterializedSide>();
  const attributeEntries = new Map<string, ChangeSetEntry>();
  const unsupported: UnsupportedPath[] = [];
  await readObjects(git, repo, [...new Set([...changedByOid.keys(), ...differingByOid.keys()])], (oid, _t, blob) => {
    for (const c of changedByOid.get(oid) ?? []) {
      const after = c.after as { mode: FileMode; oid: GitOid };
      if (isRegular(after.mode)) {
        const ac = conv(afterAttrs, c.path);
        const s = side(after.mode, oid, ac, toWorktree(blob, ac, oid), null);
        if (s.unsupported !== null) unsupported.push({ path: c.path, reason: s.unsupported });
        afterSides.set(c.path, s);
      } else afterSides.set(c.path, side(after.mode, oid, null, null, blob.length));
    }
    for (const c of differingByOid.get(oid) ?? []) {
      const bc = conv(beforeAttrs, c.path);
      const ac = conv(afterAttrs, c.path);
      const bw = toWorktree(blob, bc, oid);
      const aw = toWorktree(blob, ac, oid);
      if (bw.kind === 'unsupported' || aw.kind === 'unsupported') {
        unsupported.push({ path: c.path, reason: aw.kind === 'unsupported' ? aw.reason : (bw as { reason: string }).reason });
      } else if (sameBytes(bw, aw)) continue;
      const mode = c.entry.mode as FileMode;
      attributeEntries.set(c.path, {
        path: c.path,
        before: side(mode, oid, bc, bw, null),
        after: side(mode, oid, ac, aw, null),
        treeChanged: false,
        bytesChanged: true,
      });
    }
  });

  const entries: ChangeSetEntry[] = [];
  const unsafe: UnsupportedPath[] = [];
  for (const c of changes) {
    let before: MaterializedSide | null = null;
    if (c.before !== null) {
      // The old bytes are not needed: the path is in the set whatever they were.
      const bc = isRegular(c.before.mode) ? conv(beforeAttrs, c.path) : null;
      before = { mode: c.before.mode, oid: c.before.oid, kind: kindOf(c.before.mode), conversion: bc, size: null, lfs: null, unsupported: bc?.unsupported ?? null };
    }
    let after: MaterializedSide | null = null;
    if (c.after !== null) {
      const why = unsafePathReason(c.path);
      if (why !== null) unsafe.push({ path: c.path, reason: why });
      after = c.after.mode === '160000' ? side(c.after.mode, c.after.oid, null, null, null) : (afterSides.get(c.path) as MaterializedSide);
    }
    entries.push({ path: c.path, before, after, treeChanged: true, bytesChanged: true });
  }
  const attributeOnly = [...attributeEntries.keys()];
  entries.push(...attributeEntries.values());
  const cmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  entries.sort((a, b) => cmp(a.path, b.path));
  const lfsPaths: string[] = [];
  const missing = new Map<string, LfsPointer>();
  for (const e of entries) {
    if (e.after?.lfs != null) {
      lfsPaths.push(e.path);
      // Verified by size and SHA-256, not only present (review r1 #6): a corrupt object counts as missing (WI-13).
      if (lfsObjectState(repo.commonDir, e.after.lfs) !== 'present') missing.set(e.after.lfs.oid, e.after.lfs);
    }
  }
  return {
    base: o.base,
    delivery: o.delivery,
    baseTree,
    deliveryTree,
    descriptionHash: transformDescriptionHash(d),
    entries,
    attributeOnly: attributeOnly.sort(cmp),
    unsupported: unsupported.sort((a, b) => cmp(a.path, b.path)),
    unsafe,
    lfsPaths,
    lfsMissing: [...missing.values()],
  };
}
