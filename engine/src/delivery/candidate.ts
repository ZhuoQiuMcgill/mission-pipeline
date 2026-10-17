// The delivery candidate and its proof check (design 6.6 steps 3 and 4; 7.1).
//
// 3. Candidate: base = the target branch's current commit. Each version in the
//    manifest that lives in the repository brings ITS OWN changes: inside its
//    write scope, the difference between the commit the program generated for
//    it and its origin, the snapshot its work started from (versionOrigin; design
//    4.1 Appendix H). For a first attempt that is the commit's parent. A rework
//    continues in a worktree at the previous attempt's commit, so a version
//    accepted at a later attempt has that commit as its parent; its origin is
//    inherited until the work is carried onto a new start, and its change is
//    every attempt's, not only the last one's. They are overlaid onto the base
//    one after the other, each after the versions it rests on (its
//    prerequisites, transitively; unrelated versions by id: Appendix L), since
//    a dependent's work started from a snapshot that already held them. Each is
//    laid path by path, three-way, against the base AS CHANGED by the versions
//    laid before it (the running overlay):
//      the version did not change the path               -> it stays as it is
//      it still has what the version started from         -> the version's entry
//      it already has the version's entry                 -> nothing to do
//      otherwise (the base or an earlier version changed  -> conflict, typed, for
//      it differently from what the version started from)    an integration task
//    The result is a commit whose only parent is the base (landing is a
//    fast-forward, 6.6 step 7), written with plumbing that never runs a filter,
//    and the canonical candidate snapshot materialized from it (7.1: checks and
//    verification run on the canonical candidate).
// 4. Proof check on the final candidate tree:
//    - the object itself: its write-scope identity, recomputed on the candidate,
//      must equal the accepted version's (a user commit on main that touched
//      any other file in the scope makes it a new version, 6.6 step 4);
//    - its prerequisites: the versions actually in the candidate must be the
//      ones it was proven against;
//    - each shared path is delivered by the strictly stacked top version; the
//      lower version is checked only on its other paths, on the final tree;
//    - its evidence: the input hashes of the runs its deciding judgments used
//      must match the candidate's content.
//    A version failing any of these, or not proven at the view's revision, can
//    only be delivered as "not fully proven" (listed with the reasons). Then,
//    to a fixed point (code review r1 #5; 5.2, 5.3): a proof unit is proven only
//    as a whole, so one failing member fails every member; and a version whose
//    prerequisite (an object, or any member of a prerequisite unit) is not
//    proven on the candidate is not proven either, transitively.

import { lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentHash, EvidenceId, GitOid, ObjectVersionId, ProofUnitId } from '../common/ids.ts';
import { contentHash } from '../common/ids.ts';
import type { Label } from '../evaluator/semantics.ts';
import {
  batchCheck,
  buildTrees,
  commitTree,
  gitOid,
  lsTree,
  mktree,
  readObjects,
  repoArgs,
  type FileMode,
  type Ident,
  type RepoLayout,
  type TreeEntry,
} from '../git/objects.ts';
import {
  materializeSnapshot,
  MissingObjectsError,
  missingObjectsAsTyped,
  sha256File,
  sha256Hex,
  transformDescriptionHash,
  type AttributeEvaluator,
  type SnapshotManifest,
} from '../git/representation.ts';
import type { GitExec } from '../git/plainGit.ts';
import { buildManifest, layingClosure, prerequisiteClosure, stackOrder, type DeliveryManifest, type ManifestEntry } from './manifest.ts';
import type { DeliveryObject, DeliveryProofView, DeliveryTarget } from './proofView.ts';
import type { Memory } from '../memory/index.ts';
import { inWriteScope, writeScopeIdentity } from './writeScope.ts';

export interface EntryState {
  readonly mode: FileMode;
  readonly oid: GitOid;
}

export interface OverlayConflict {
  readonly path: string;
  readonly version: ObjectVersionId;
  /**
   * What the version started from (its origin's entry), what it delivers, and what the candidate has there when it
   * is laid (null: absent): the base's entry, or that of the version laid before it named by `by`.
   */
  readonly original: EntryState | null;
  readonly delivered: EntryState | null;
  readonly base: EntryState | null;
  /** The version laid before it that put `base` there; null: the base's own entry. */
  readonly by: ObjectVersionId | null;
}

/** One version as the overlay laid it (Appendix L): the entry it found on each path it changed (null: absent). */
export interface OverlayLayer {
  readonly version: ObjectVersionId;
  readonly found: ReadonlyMap<string, EntryState | null>;
}

export interface Candidate {
  readonly base: GitOid;
  readonly commit: GitOid;
  readonly tree: GitOid;
  /** The canonical candidate, materialized under the bound transform description (7.1). */
  readonly snapshotDir: string;
  readonly snapshot: SnapshotManifest;
  /** Paths the overlay changed relative to the base. */
  readonly changedPaths: readonly string[];
  /** The versions in the order they were laid, each with what it found on the paths it changed (Appendix L). */
  readonly layers: readonly OverlayLayer[];
}

export type CandidateResult =
  | { readonly kind: 'candidate'; readonly candidate: Candidate }
  /** 6.6 step 3: conflicts are resolved by an integration task and accepted by a Reviewer. */
  | { readonly kind: 'conflict'; readonly base: GitOid; readonly conflicts: readonly OverlayConflict[] }
  /** 7.1: every object of a candidate must rest on one transform description; re-materialize and re-verify the others. */
  | { readonly kind: 'description-mismatch'; readonly expected: ContentHash; readonly versions: readonly ObjectVersionId[] };

export interface CandidateOptions {
  readonly git: GitExec;
  readonly repo: RepoLayout;
  readonly manifest: DeliveryManifest;
  /** The target branch's current commit. */
  readonly base: GitOid;
  /** Carries the bound transform description. */
  readonly attributes: AttributeEvaluator;
  /** Created; must be empty. */
  readonly snapshotDir: string;
  readonly message: string;
  readonly author: Ident;
  readonly committer: Ident;
  /**
   * The recorded object versions by id (the memory's), so the origin of a version
   * recorded without one is derived down its predecessors (versionOrigin). Without
   * it such a version's origin is its commit's parent.
   */
  readonly versionOf?: (id: ObjectVersionId) => VersionLine | null;
  /** Versions in landed deliveries ancestral to this base; skip their overlay, still check their proof. */
  readonly alreadyLaid?: ReadonlySet<ObjectVersionId>;
}

/** What versionOrigin reads of an object version: its id, the version it revises, and where it lives. */
export interface VersionLine {
  readonly id: string;
  readonly predecessor?: string | null;
  readonly tree: { readonly commit: GitOid; readonly origin?: GitOid; readonly writeScope?: readonly string[] } | null;
}

function sameEntry(a: EntryState | null | undefined, b: EntryState | null | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  return x.mode === y.mode && x.oid === y.oid;
}

function entryMap(entries: readonly TreeEntry[]): Map<string, EntryState> {
  const m = new Map<string, EntryState>();
  for (const e of entries) if (e.type !== 'tree') m.set(e.path, { mode: e.mode as FileMode, oid: e.oid });
  return m;
}

/**
 * The commit a generated version commit was built from: its first parent as the
 * commit object records it (not as a shallow boundary or a graft would show it);
 * null for a root commit. A recorded parent that is not in the repository is a
 * missing object (v49, WI-13), never "no parent".
 */
async function recordedParent(git: GitExec, repo: RepoLayout, commit: GitOid): Promise<GitOid | null> {
  let raw: Buffer | null = null;
  await readObjects(git, repo, [commit], (_o, type, content) => {
    if (type !== 'commit') throw new Error(`${commit} is a ${type}, not a commit`);
    raw = content;
  });
  const text = (raw as Buffer | null)?.toString('latin1') ?? '';
  const end = text.indexOf('\n\n');
  let parent: GitOid | null = null;
  for (const line of (end < 0 ? text : text.slice(0, end)).split('\n')) {
    if (line.startsWith('parent ')) {
      parent = gitOid(line.slice('parent '.length).trim());
      break;
    }
  }
  if (parent === null) return null;
  const info = (await batchCheck(git, repo, [parent])).get(parent);
  if (info === null || info === undefined) {
    throw new MissingObjectsError(`the commit ${parent} that ${commit} was built from is not in the repository (a shallow or partial clone?); it is never fetched`, [parent]);
  }
  return parent;
}

/**
 * The origin of a version that lives in the repository (design 4.1 Appendix H): the
 * snapshot the version's own change is taken against: inherited while an attempt
 * continues, replaced when the work is carried onto a new start. An unchanged start
 * continues at the latest recorded candidate; the change includes every attempt since
 * the inherited origin. A carry onto a new start records that start as its origin.
 * - The recorded origin (ObjectVersionRecord.source.origin), when there is one.
 * - Otherwise (a version recorded before the origin was recorded) it is derived from
 *   the records and the commits alone: down the version's predecessors for as long as
 *   each commit was built on its predecessor's commit (its recorded parent IS that
 *   commit: the next attempt continued from it), then the parent of the last commit
 *   reached; a predecessor's recorded origin ends the walk. A version with no
 *   predecessor, or not built on its predecessor's commit, starts at its own parent.
 *   A version on the very commit of its predecessor (a kept product re-bound under a
 *   new plan, Appendix J) brings its predecessor's change: the walk goes on there.
 * Null when the commit reached is a root commit (nothing to start from). An origin
 * that is not in the repository is a missing object (WI-13), never fetched.
 */
export async function versionOrigin(git: GitExec, repo: RepoLayout, version: VersionLine, versionOf?: (id: ObjectVersionId) => VersionLine | null): Promise<GitOid | null> {
  const seen = new Set<string>();
  for (let v: VersionLine = version; ; ) {
    const tree = v.tree;
    if (tree === null) throw new Error(`${v.id} is not a version in the repository`);
    if (tree.origin !== undefined) {
      const info = (await batchCheck(git, repo, [tree.origin])).get(tree.origin);
      if (info === null || info === undefined) {
        throw new MissingObjectsError(`the commit ${tree.origin} that the work of ${v.id} started from is not in the repository (a shallow or partial clone?); it is never fetched`, [tree.origin]);
      }
      return tree.origin;
    }
    seen.add(v.id);
    const same = v.predecessor === undefined || v.predecessor === null || versionOf === undefined ? null : versionOf(v.predecessor as ObjectVersionId);
    if (same !== null && same.tree !== null && same.tree.commit === tree.commit && !seen.has(same.id)) {
      v = same;
      continue;
    }
    const parent = await recordedParent(git, repo, tree.commit);
    const pred = parent === null || v.predecessor === undefined || v.predecessor === null || versionOf === undefined ? null : versionOf(v.predecessor as ObjectVersionId);
    // the line goes on below only where this commit was built on the predecessor's commit
    if (pred === null || pred.tree === null || pred.tree.commit !== parent || seen.has(pred.id)) return parent;
    v = pred;
  }
}

/**
 * Versions whose delivered change is already in the base. Only a completed landing and local
 * ancestry authorize this; equal file contents or an unlanded delivery do not. A landed successor
 * covers its predecessors too (the version lineage, never a guessed product-id prefix).
 * Successors with the same commit, write scope and origin (re-binds) count to a fixed point.
 */
export async function landedVersions(git: GitExec, repo: RepoLayout, memory: Memory, base: GitOid, versionOf: (id: ObjectVersionId) => VersionLine | null): Promise<Set<ObjectVersionId>> {
  const rows = memory.read((db) => ({
    landings: db.stmt("SELECT data FROM landings WHERE phase = 'done'").all() as Array<{ data: string }>,
    products: db.stmt("SELECT mission, line, event, body, revision FROM flow_events WHERE event IN ('product', 'rebind') ORDER BY revision").all() as Array<{ mission: string; line: string; event: string; body: string; revision: number }>,
    deliveries: db.stmt("SELECT commit_id, manifest FROM deliveries WHERE manifest IS NOT NULL AND recorded_rev IS NOT NULL").all() as Array<{ commit_id: string; manifest: string }>,
    versions: db.stmt("SELECT id FROM facts WHERE kind = 'object.version'").all() as Array<{ id: ObjectVersionId }>,
  }));
  const landed = new Set(rows.landings.map((r) => (JSON.parse(memory.data.text(r.data)) as { ref?: string }).ref));
  const lineage = rows.products.map((r) => {
    const body = JSON.parse(memory.data.text(r.body)) as { object?: ObjectVersionId; product?: ObjectVersionId };
    return { ...r, version: r.event === 'product' ? body.object : body.product };
  });
  const out = new Set<ObjectVersionId>();
  for (const d of rows.deliveries) {
    if (!landed.has(d.commit_id)) continue;
    const ancestry = await git.run([...repoArgs(repo), 'merge-base', '--is-ancestor', d.commit_id, base], { cwd: repo.commonDir });
    if (ancestry.code !== 0) continue; // absent history is never fetched or treated as ancestry
    const doc = JSON.parse(memory.data.text(d.manifest)) as { version?: string; entries?: Array<{ id: ObjectVersionId }> };
    if (doc.version !== 'mp41-delivery/1') continue;
    const contained = new Set((doc.entries ?? []).map((e) => e.id));
    // A card change deliberately starts without a predecessor; the task's recorded flow line
    // still identifies earlier versions of that same task (never infer lineage from id spelling).
    for (const top of lineage.filter((r) => r.version !== undefined && contained.has(r.version))) {
      for (const earlier of lineage) if (earlier.version !== undefined && earlier.mission === top.mission && earlier.line === top.line && earlier.revision <= top.revision) contained.add(earlier.version);
    }
    for (const id0 of contained) {
      const seen = new Set<string>();
      for (let id: ObjectVersionId | null = id0; id !== null && !seen.has(id); ) {
        seen.add(id);
        out.add(id);
        id = (versionOf(id)?.predecessor as ObjectVersionId | undefined) ?? null;
      }
    }
  }
  // Follow unchanged placements forward too: a kept product re-bound after landing brings
  // exactly the landed change, even when an upper layer has since changed its shared paths.
  const origins = new Map<string, Promise<GitOid | null>>();
  const origin = (v: VersionLine) => {
    if (!origins.has(v.id)) origins.set(v.id, versionOrigin(git, repo, v, versionOf));
    return origins.get(v.id)!;
  };
  const successors = new Set([...rows.versions.map((r) => r.id), ...lineage.map((r) => r.version)]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of successors) {
      if (id === undefined || out.has(id)) continue;
      const v = versionOf(id);
      if (v?.tree == null || v.predecessor == null || !out.has(v.predecessor as ObjectVersionId)) continue;
      const prev = versionOf(v.predecessor as ObjectVersionId);
      if (prev?.tree == null || v.tree.commit !== prev.tree.commit || v.tree.writeScope === undefined || prev.tree.writeScope === undefined) continue;
      if (JSON.stringify([...new Set(v.tree.writeScope)].sort()) !== JSON.stringify([...new Set(prev.tree.writeScope)].sort())) continue;
      if (await origin(v) !== await origin(prev)) continue;
      out.add(id);
      changed = true;
    }
  }
  return out;
}

/** The unit members of a manifest, as prerequisiteClosure reads them. */
function membersIn(manifest: DeliveryManifest): (unit: ProofUnitId) => readonly ObjectVersionId[] | null {
  return (unit) => manifest.units.find((u) => u.unit === unit)?.members ?? null;
}

export async function buildCandidate(o: CandidateOptions): Promise<CandidateResult> {
  const { git, repo } = o;
  // each version after the versions it rests on (Appendix L; a superseded prerequisite read as the version laid in its place, 4.1.2)
  const closure = layingClosure(o.manifest);
  const byVersion = new Map(o.manifest.entries.filter((e) => e.object.tree !== null).map((e) => [e.object.id, e]));
  const placed = stackOrder([...byVersion.keys()], closure).map((id) => byVersion.get(id) as ManifestEntry);
  const expected = transformDescriptionHash(o.attributes.description);
  const wrongDescription = placed.filter((e) => e.object.tree?.transform !== expected).map((e) => e.object.id);
  if (wrongDescription.length > 0) return { kind: 'description-mismatch', expected, versions: wrongDescription };

  // Planning reads trees and commits only, and writes nothing; an object missing from the repository is reported
  // as MissingObjectsError (v49, WI-13) and never fetched.
  const commits = [o.base, ...placed.map((e) => (e.object.tree as NonNullable<DeliveryObject['tree']>).commit)];
  // where each version's own change starts (Appendix H)
  const origins = await missingObjectsAsTyped(git, repo, commits, 'delivery candidate', async () => {
    const out: (GitOid | null)[] = [];
    for (const e of placed) out.push(await versionOrigin(git, repo, e.object, o.versionOf));
    return out;
  });
  const planned = await missingObjectsAsTyped(git, repo, [...commits, ...origins.filter((x): x is GitOid => x !== null)], 'delivery candidate', async () => {
    const baseEntries = entryMap(await lsTree(git, repo, o.base, { recursive: true }));
    const overlay = new Map<string, EntryState | null>();
    const setBy = new Map<string, ObjectVersionId>();
    const layers: OverlayLayer[] = [];
    const conflicts: OverlayConflict[] = [];
    for (const [i, e] of placed.entries()) {
      if (o.alreadyLaid?.has(e.object.id)) continue;
      const found = new Map<string, EntryState | null>();
      layers.push({ version: e.object.id, found });
      const tree = e.object.tree as NonNullable<DeliveryObject['tree']>;
      const scope = tree.writeScope;
      const origin = origins[i] ?? null;
      const delivered = entryMap((await lsTree(git, repo, tree.commit, { recursive: true })).filter((x) => inWriteScope(scope, x.path)));
      const original =
        origin === null ? new Map<string, EntryState>() : entryMap((await lsTree(git, repo, origin, { recursive: true })).filter((x) => inWriteScope(scope, x.path)));
      for (const path of new Set([...delivered.keys(), ...original.keys()])) {
        const d = delivered.get(path) ?? null;
        const before = original.get(path) ?? null;
        if (sameEntry(d, before)) continue; // the version did not change it: it stays as it is
        // the base as the versions laid before this one left it
        const now = overlay.has(path) ? (overlay.get(path) ?? null) : (baseEntries.get(path) ?? null);
        if (sameEntry(now, before)) {
          overlay.set(path, d);
          setBy.set(path, e.object.id);
          found.set(path, now);
        } else if (sameEntry(now, d)) continue;
        else conflicts.push({ path, version: e.object.id, original: before, delivered: d, base: now, by: setBy.get(path) ?? null });
      }
    }
    return { baseEntries, overlay, conflicts, layers };
  });
  const { baseEntries, overlay, conflicts, layers } = planned;
  if (conflicts.length > 0) return { kind: 'conflict', base: o.base, conflicts };

  const files = new Map(baseEntries);
  for (const [path, entry] of overlay) {
    if (entry === null) files.delete(path);
    else files.set(path, entry);
  }
  // v49: every blob the candidate names must be local BEFORE anything is written (the snapshot reads them all).
  const blobPaths = new Map<GitOid, string[]>();
  for (const [path, entry] of files) {
    if (entry.mode === '160000') continue; // a submodule's commit lives in the submodule
    const l = blobPaths.get(entry.oid);
    if (l === undefined) blobPaths.set(entry.oid, [path]);
    else l.push(path);
  }
  const present = await batchCheck(git, repo, [...blobPaths.keys()]);
  const absent = [...blobPaths.keys()].filter((oid) => present.get(oid) == null);
  if (absent.length > 0) {
    throw new MissingObjectsError(
      `the delivery candidate needs ${absent.length} blob(s) that are not in the repository (a partial clone, or pruned objects); they are never fetched`,
      absent.sort(),
      absent.flatMap((oid) => blobPaths.get(oid) ?? []).sort(),
    );
  }
  const baseTrees = new Set((await lsTree(git, repo, o.base, { recursive: true, withTrees: true })).filter((x) => x.type === 'tree').map((x) => x.oid));
  const trees = buildTrees(repo.objectFormat, files);
  const newTrees = trees.filter((t) => !baseTrees.has(t.oid));
  for (const t of newTrees) {
    const written = await mktree(git, repo, t.items);
    if (written !== t.oid) throw new Error(`git wrote tree ${t.dir || '/'} as ${written}, expected ${t.oid}`);
  }
  const root = (trees[trees.length - 1] as (typeof trees)[number]).oid;
  const commit = await commitTree(git, repo, root, [o.base], o.message, o.author, o.committer);
  const snapshot = await materializeSnapshot({ git, repo, commit, attributes: o.attributes, dest: o.snapshotDir });
  return {
    kind: 'candidate',
    candidate: {
      base: o.base,
      commit,
      tree: root,
      snapshotDir: o.snapshotDir,
      snapshot,
      // a path a later version put back as the base had it is not changed
      changedPaths: [...overlay.entries()].filter(([path, entry]) => !sameEntry(entry, baseEntries.get(path))).map(([path]) => path).sort(),
      layers,
    },
  };
}

// ---------------------------------------------------------------- proof check (6.6 step 4)

export type ProofMismatch =
  | { readonly kind: 'not-proven'; readonly label: Label }
  | { readonly kind: 'start-lacks-prerequisite'; readonly missing: StartHoldsResult['missing'] }
  /** The candidate's write scope differs from the accepted version: record a new product version and verify it again. */
  | { readonly kind: 'content-changed'; readonly expected: ContentHash; readonly actual: ContentHash }
  | { readonly kind: 'prerequisite-mismatch'; readonly prerequisite: ObjectVersionId; readonly expected: ContentHash; readonly actual: ContentHash }
  | { readonly kind: 'evidence-input-mismatch'; readonly evidence: EvidenceId; readonly path: string; readonly expected: ContentHash; readonly actual: ContentHash | null }
  /** 5.3: a member of its proof unit is not proven on the candidate; a unit is proven only as a whole. */
  | { readonly kind: 'unit-member-not-proven'; readonly unit: ProofUnitId; readonly member: ObjectVersionId }
  /** 5.2: a prerequisite (an object, or a member of a prerequisite unit) is not proven on the candidate. */
  | { readonly kind: 'prerequisite-not-proven'; readonly prerequisite: ObjectVersionId }
  | { readonly kind: 'delivering-version-not-proven'; readonly path: string; readonly by: ObjectVersionId }
  /**
   * 4.1.2 (D-6, no cascade): the version was proven built on `prerequisite`, a task's earlier version,
   * and is delivered with that task's newer version `deliveredWith`, and no delivered, proven version
   * (an integration reviewed on that very combination) records both as its prerequisites.
   */
  | { readonly kind: 'built-on-superseded'; readonly prerequisite: ObjectVersionId; readonly deliveredWith: ObjectVersionId };

/**
 * 6.6 step 4: the candidate holds a NEW version of this object. To deliver it as
 * proven, the process records it as a new product version (source = this
 * placement, content = `content`) and has it verified and reviewed again,
 * within the loop caps; otherwise it is delivered as not fully proven.
 */
export interface Reverification {
  readonly id: ObjectVersionId;
  readonly module: DeliveryObject['module'];
  /** The new version's ObjectVersionRecord.content (write-scope identity on the candidate). */
  readonly content: ContentHash;
  /** The new version's ObjectVersionRecord.source. */
  readonly source: { readonly commit: GitOid; readonly writeScope: readonly string[]; readonly transform: ContentHash };
}

export interface ProofCheck {
  /** Deliverable as proven: every check passed and the version is proven at the view's revision. */
  readonly proven: readonly ObjectVersionId[];
  /** Deliverable only as "not fully proven", listed in the risk list with the reasons. */
  readonly notFullyProven: readonly { readonly id: ObjectVersionId; readonly reasons: readonly ProofMismatch[] }[];
  /** Shared paths whose final identity and proof are checked against the named top version. */
  readonly deliveredBy?: readonly { readonly version: ObjectVersionId; readonly path: string; readonly by: ObjectVersionId }[];
  /** Versions the candidate changed: new product versions to record and re-verify (the process dispatches them, not this module). */
  readonly needsReverification: readonly Reverification[];
}

/** sha256 of a candidate file as a run would read it; a symlink by its target; null when absent. */
function candidateFileHash(snapshotDir: string, path: string): ContentHash | null {
  const abs = join(snapshotDir, path);
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return contentHash(sha256Hex(readlinkSync(abs, { encoding: 'buffer' })));
    if (st.isFile()) return contentHash(sha256File(abs).sha256);
    return null;
  } catch {
    return null;
  }
}

/** One identity rule for a composed tree, including strictly stacked path ownership. */
async function treeIdentities(git: GitExec, repo: RepoLayout, manifest: DeliveryManifest, entries: readonly TreeEntry[]) {
  const closure = layingClosure(manifest);
  const handedOver = new Map<ObjectVersionId, Map<string, ObjectVersionId>>();
  const identities = new Map<ObjectVersionId, { expected: ContentHash; actual: ContentHash; missing: readonly string[] }>();
  for (const { object } of manifest.entries) {
    const paths = new Map<string, ObjectVersionId>();
    if (object.tree !== null) for (const [path, owner] of manifest.paths) {
      if (inWriteScope(object.tree.writeScope, path) && owner !== object.id && closure.get(owner)?.has(object.id) === true && closure.get(object.id)?.has(owner) !== true) paths.set(path, owner);
    }
    handedOver.set(object.id, paths);
    if (object.tree === null) continue;
    const keep = (e: TreeEntry) => !paths.has(e.path) && inWriteScope(object.tree!.writeScope, e.path);
    let original = paths.size > 0 ? (await lsTree(git, repo, object.tree.commit, { recursive: true })).filter(keep) : null;
    const expected = original === null ? object.content : writeScopeIdentity(original, object.tree.writeScope);
    const actualEntries = entries.filter(keep);
    const actual = writeScopeIdentity(actualEntries, object.tree.writeScope);
    const missing: string[] = [];
    if (expected !== actual) {
      original ??= (await lsTree(git, repo, object.tree.commit, { recursive: true })).filter(keep);
      const before = entryMap(original);
      const found = entryMap(actualEntries);
      for (const path of new Set([...before.keys(), ...found.keys()])) {
        if (!sameEntry(before.get(path), found.get(path))) missing.push(path);
      }
    }
    identities.set(object.id, { expected, actual, missing: missing.sort() });
  }
  return { handedOver, identities };
}

export interface StartHoldsResult {
  readonly holds: boolean;
  readonly missing: readonly { readonly prerequisite: ObjectVersionId; readonly path: string }[];
}

/** Mechanical provenance: the version's origin must hold its whole recorded prerequisite composition. */
export async function startHolds(git: GitExec, repo: RepoLayout, view: DeliveryProofView, version: DeliveryObject): Promise<StartHoldsResult> {
  const built = buildManifest(view, version.prerequisites, { compositionOnly: true });
  if (built.kind !== 'manifest') throw new Error(`cannot resolve the start prerequisites of ${version.id}: ${built.kind}`);
  if (!built.manifest.entries.some((e) => e.object.tree !== null)) return { holds: true, missing: [] };
  const origin = await versionOrigin(git, repo, version, (id) => view.object(id));
  const entries = origin === null ? [] : await lsTree(git, repo, origin, { recursive: true });
  const { identities } = await treeIdentities(git, repo, built.manifest, entries);
  return {
    holds: [...identities.values()].every((i) => i.actual === i.expected),
    missing: [...identities].flatMap(([prerequisite, i]) => i.missing.map((path) => ({ prerequisite, path }))),
  };
}

export async function checkCandidateProofs(o: {
  readonly git: GitExec;
  readonly repo: RepoLayout;
  readonly view: DeliveryProofView;
  readonly manifest: DeliveryManifest;
  readonly candidate: Candidate;
}): Promise<ProofCheck> {
  const entries = await lsTree(o.git, o.repo, o.candidate.commit, { recursive: true });
  // Per maintainer ruling 2, 2026-10-13: read only the final delivered tree.
  // Shared paths belong to the strictly stacked top version; no tree is reconstructed.
  const { handedOver, identities } = await treeIdentities(o.git, o.repo, o.manifest, entries);
  const objectsOf = (t: DeliveryTarget): DeliveryObject[] => {
    if (t.kind === 'object') {
      // a prerequisite superseded in this manifest: the content in the candidate is the version laid in its place (4.1.2)
      const x = o.view.object(o.manifest.superseded?.get(t.id)?.by ?? t.id);
      return x === null ? [] : [x];
    }
    return (o.view.unitMembers(t.id) ?? []).map((m) => o.view.object(m)).filter((x): x is DeliveryObject => x !== null);
  };
  const reasonsOf = new Map<ObjectVersionId, ProofMismatch[]>();
  const needsReverification: Reverification[] = [];
  // 4.1.2: members built on a superseded prerequisite, and the delivered versions whose recorded
  // prerequisites hold both the newer version and the member (an integration of that combination)
  const recordedIds = (obj: DeliveryObject): Set<string> => new Set(obj.prerequisites.flatMap((p) => (p.kind === 'object' ? [p.id] : [...(o.view.unitMembers(p.id) ?? [])])));
  const builtOnSuperseded: Array<{ member: ObjectVersionId; prerequisite: ObjectVersionId; deliveredWith: ObjectVersionId; covers: ObjectVersionId[] }> = [];
  for (const e of o.manifest.entries) {
    for (const p of recordedIds(e.object)) {
      const sup = o.manifest.superseded?.get(p as ObjectVersionId);
      if (sup === undefined) continue;
      const covers = o.manifest.entries.filter((v) => v.object.id !== e.object.id && v.label === 'proven' && ((ids) => ids.has(sup.by) && ids.has(e.object.id))(recordedIds(v.object))).map((v) => v.object.id);
      builtOnSuperseded.push({ member: e.object.id, prerequisite: p as ObjectVersionId, deliveredWith: sup.by, covers });
    }
  }
  // 1. Each version's own checks.
  for (const e of o.manifest.entries) {
    const reasons: ProofMismatch[] = [];
    reasonsOf.set(e.object.id, reasons);
    const obj = e.object;
    if (e.label !== 'proven') reasons.push({ kind: 'not-proven', label: e.label });
    // The object itself.
    if (obj.tree !== null) {
      const start = await startHolds(o.git, o.repo, o.view, obj);
      if (!start.holds) reasons.push({ kind: 'start-lacks-prerequisite', missing: start.missing });
      const { expected, actual } = identities.get(obj.id)!;
      if (actual !== expected) {
        reasons.push({ kind: 'content-changed', expected, actual });
        needsReverification.push({
          id: obj.id,
          module: obj.module,
          content: writeScopeIdentity(entries, obj.tree.writeScope),
          source: { commit: o.candidate.commit, writeScope: obj.tree.writeScope, transform: obj.tree.transform },
        });
      }
    }
    // Its prerequisites (members of its own unit are not prerequisites of each other, 5.3).
    for (const p of obj.prerequisites) {
      for (const pre of objectsOf(p)) {
        if (pre.tree === null || pre.id === obj.id) continue;
        if (e.unit !== null && o.view.unitOf(pre.id) === e.unit) continue;
        const found = identities.get(pre.id);
        if (found === undefined) {
          reasons.push({ kind: 'prerequisite-not-proven', prerequisite: pre.id });
        } else if (found.actual !== found.expected) reasons.push({ kind: 'prerequisite-mismatch', prerequisite: pre.id, expected: found.expected, actual: found.actual });
      }
    }
    // The evidence its deciding judgments used (a unit member also rests on its unit's).
    const targets: DeliveryTarget[] = [{ kind: 'object', id: obj.id }];
    if (e.unit !== null) targets.push({ kind: 'unit', id: e.unit });
    for (const t of targets) {
      for (const ev of o.view.decidingEvidence(t)) {
        for (const input of ev.inputs) {
          if (handedOver.get(obj.id)!.has(input.path)) continue;
          const actual = candidateFileHash(o.candidate.snapshotDir, input.path);
          if (actual !== input.sha256) reasons.push({ kind: 'evidence-input-mismatch', evidence: ev.evidence, path: input.path, expected: input.sha256, actual });
        }
      }
    }
  }
  const deliveredBy = [...handedOver].flatMap(([version, paths]) => [...paths].map(([path, by]) => ({ version, path, by })));
  // 2. To a fixed point: units as a whole, then down prerequisite edges (reasons are only ever added).
  const failing = (oid: ObjectVersionId): boolean => (reasonsOf.get(oid)?.length ?? 0) > 0;
  for (let changed = true; changed; ) {
    changed = false;
    // a member built on a superseded prerequisite stands only while a delivered integration of that combination does (4.1.2)
    for (const b of builtOnSuperseded) {
      const rs = reasonsOf.get(b.member)!;
      if (b.covers.some((v) => !failing(v)) || rs.some((r) => r.kind === 'built-on-superseded' && r.prerequisite === b.prerequisite)) continue;
      rs.push({ kind: 'built-on-superseded', prerequisite: b.prerequisite, deliveredWith: b.deliveredWith });
      changed = true;
    }
    for (const d of deliveredBy) {
      const rs = reasonsOf.get(d.version)!;
      if (failing(d.by) && !rs.some((r) => r.kind === 'delivering-version-not-proven' && r.path === d.path)) {
        rs.push({ kind: 'delivering-version-not-proven', path: d.path, by: d.by });
        changed = true;
      }
    }
    for (const u of o.manifest.units) {
      // A member that fails for any reason other than this unit itself (no echo back to the member that caused it).
      const bad = u.members.filter((m) => (reasonsOf.get(m) ?? []).some((r) => !(r.kind === 'unit-member-not-proven' && r.unit === u.unit)));
      for (const m of u.members) {
        const rs = reasonsOf.get(m);
        if (rs === undefined) continue;
        for (const b of bad) {
          if (b === m || rs.some((r) => r.kind === 'unit-member-not-proven' && r.member === b)) continue;
          rs.push({ kind: 'unit-member-not-proven', unit: u.unit, member: b });
          changed = true;
        }
      }
    }
    for (const e of o.manifest.entries) {
      const rs = reasonsOf.get(e.object.id) as ProofMismatch[];
      for (const p of e.object.prerequisites) {
        for (const pre of objectsOf(p)) {
          if (pre.id === e.object.id || !failing(pre.id)) continue;
          if (e.unit !== null && o.view.unitOf(pre.id) === e.unit) continue; // its own unit: the unit rule above
          if (rs.some((r) => (r.kind === 'prerequisite-not-proven' || r.kind === 'prerequisite-mismatch') && r.prerequisite === pre.id)) continue;
          rs.push({ kind: 'prerequisite-not-proven', prerequisite: pre.id });
          changed = true;
        }
      }
    }
  }
  const proven: ObjectVersionId[] = [];
  const notFullyProven: { id: ObjectVersionId; reasons: ProofMismatch[] }[] = [];
  for (const e of o.manifest.entries) {
    const reasons = reasonsOf.get(e.object.id) as ProofMismatch[];
    if (reasons.length === 0) proven.push(e.object.id);
    else notFullyProven.push({ id: e.object.id, reasons });
  }
  return { proven, notFullyProven, needsReverification, deliveredBy };
}

/** The entries of a manifest that live in the repository (for reports). */
export function placedEntries(manifest: DeliveryManifest): readonly ManifestEntry[] {
  return manifest.entries.filter((e) => e.object.tree !== null);
}
