// The delivery candidate and its proof check (design 6.6 steps 3 and 4; 7.1).
//
// 3. Candidate: base = the target branch's current commit. Each version in the
//    manifest that lives in the repository brings ITS OWN changes: inside its
//    write scope, the difference between the commit the program generated for
//    it and its origin, the snapshot its work started from (versionOrigin; design
//    4.1 Appendix H). For a first attempt that is the commit's parent. A rework
//    continues in a worktree at the previous attempt's commit, so a version
//    accepted at a later attempt has that commit as its parent; its origin is
//    still the snapshot the task's first attempt started from, and its change is
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
//    a version that versions resting on it were laid over is read as it stands
//    under them (Appendix L): the candidate with the paths they changed put back
//    to what the first of them found there, so their own changes do not count
//    against it (they are checked as theirs), and anything else still does;
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
import { prerequisiteClosure, stackOrder, type DeliveryManifest, type ManifestEntry } from './manifest.ts';
import type { DeliveryObject, DeliveryProofView, DeliveryTarget } from './proofView.ts';
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
}

/** What versionOrigin reads of an object version: its id, the version it revises, and where it lives. */
export interface VersionLine {
  readonly id: string;
  readonly predecessor?: string | null;
  readonly tree: { readonly commit: GitOid; readonly origin?: GitOid } | null;
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
 * commit its own change is taken against, the snapshot the first attempt of its task
 * started from. A rework's Constructor continues in a worktree at the previous
 * attempt's commit, so the commit of a version accepted at attempt k has attempt k-1's
 * commit as its parent; its change is everything since the first attempt's snapshot.
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

/** The unit members of a manifest, as prerequisiteClosure reads them. */
function membersIn(manifest: DeliveryManifest): (unit: ProofUnitId) => readonly ObjectVersionId[] | null {
  return (unit) => manifest.units.find((u) => u.unit === unit)?.members ?? null;
}

export async function buildCandidate(o: CandidateOptions): Promise<CandidateResult> {
  const { git, repo } = o;
  // each version after the versions it rests on (Appendix L)
  const closure = prerequisiteClosure(
    o.manifest.entries.map((e) => e.object),
    membersIn(o.manifest),
  );
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
  /** The candidate's write scope differs from the accepted version: record a new product version and verify it again. */
  | { readonly kind: 'content-changed'; readonly expected: ContentHash; readonly actual: ContentHash }
  | { readonly kind: 'prerequisite-mismatch'; readonly prerequisite: ObjectVersionId; readonly expected: ContentHash; readonly actual: ContentHash }
  | { readonly kind: 'evidence-input-mismatch'; readonly evidence: EvidenceId; readonly path: string; readonly expected: ContentHash; readonly actual: ContentHash | null }
  /** 5.3: a member of its proof unit is not proven on the candidate; a unit is proven only as a whole. */
  | { readonly kind: 'unit-member-not-proven'; readonly unit: ProofUnitId; readonly member: ObjectVersionId }
  /** 5.2: a prerequisite (an object, or a member of a prerequisite unit) is not proven on the candidate. */
  | { readonly kind: 'prerequisite-not-proven'; readonly prerequisite: ObjectVersionId };

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

export async function checkCandidateProofs(o: {
  readonly git: GitExec;
  readonly repo: RepoLayout;
  readonly view: DeliveryProofView;
  readonly manifest: DeliveryManifest;
  readonly candidate: Candidate;
}): Promise<ProofCheck> {
  const entries = await lsTree(o.git, o.repo, o.candidate.commit, { recursive: true });
  // A version as it stands under the versions laid over it that rest on it (Appendix L): each path they
  // changed back to what the first of them found there.
  const closure = prerequisiteClosure(
    o.manifest.entries.map((e) => e.object),
    membersIn(o.manifest),
  );
  const layers = o.candidate.layers;
  const under = new Map<ObjectVersionId, TreeEntry[]>();
  const entriesOf = (version: ObjectVersionId): readonly TreeEntry[] => {
    let es = under.get(version);
    if (es !== undefined) return es;
    const at = layers.findIndex((l) => l.version === version);
    const back = new Map<string, EntryState | null>();
    if (at >= 0) {
      for (const l of layers.slice(at + 1)) {
        if (!(closure.get(l.version)?.has(version) ?? false)) continue;
        for (const [path, entry] of l.found) if (!back.has(path)) back.set(path, entry);
      }
    }
    if (back.size === 0) es = entries as TreeEntry[];
    else {
      es = entries.filter((x) => x.type === 'tree' || !back.has(x.path));
      for (const [path, entry] of back) if (entry !== null) es.push({ path, mode: entry.mode, oid: entry.oid, type: entry.mode === '160000' ? 'commit' : 'blob' });
    }
    under.set(version, es);
    return es;
  };
  const identities = new Map<string, ContentHash>();
  const identity = (version: ObjectVersionId, scope: readonly string[]): ContentHash => {
    const es = entriesOf(version);
    const key = `${es === entries ? '' : version}\n${JSON.stringify(scope)}`;
    let id = identities.get(key);
    if (id === undefined) {
      id = writeScopeIdentity(es, scope);
      identities.set(key, id);
    }
    return id;
  };
  const objectsOf = (t: DeliveryTarget): DeliveryObject[] => {
    if (t.kind === 'object') {
      const x = o.view.object(t.id);
      return x === null ? [] : [x];
    }
    return (o.view.unitMembers(t.id) ?? []).map((m) => o.view.object(m)).filter((x): x is DeliveryObject => x !== null);
  };
  const reasonsOf = new Map<ObjectVersionId, ProofMismatch[]>();
  const needsReverification: Reverification[] = [];
  // 1. Each version's own checks.
  for (const e of o.manifest.entries) {
    const reasons: ProofMismatch[] = [];
    reasonsOf.set(e.object.id, reasons);
    const obj = e.object;
    if (e.label !== 'proven') reasons.push({ kind: 'not-proven', label: e.label });
    // The object itself.
    if (obj.tree !== null) {
      const actual = identity(obj.id, obj.tree.writeScope);
      if (actual !== obj.content) {
        reasons.push({ kind: 'content-changed', expected: obj.content, actual });
        needsReverification.push({
          id: obj.id,
          module: obj.module,
          content: actual,
          source: { commit: o.candidate.commit, writeScope: obj.tree.writeScope, transform: obj.tree.transform },
        });
      }
    }
    // Its prerequisites (members of its own unit are not prerequisites of each other, 5.3).
    for (const p of obj.prerequisites) {
      for (const pre of objectsOf(p)) {
        if (pre.tree === null || pre.id === obj.id) continue;
        if (e.unit !== null && o.view.unitOf(pre.id) === e.unit) continue;
        const actual = identity(pre.id, pre.tree.writeScope);
        if (actual !== pre.content) reasons.push({ kind: 'prerequisite-mismatch', prerequisite: pre.id, expected: pre.content, actual });
      }
    }
    // The evidence its deciding judgments used (a unit member also rests on its unit's).
    const targets: DeliveryTarget[] = [{ kind: 'object', id: obj.id }];
    if (e.unit !== null) targets.push({ kind: 'unit', id: e.unit });
    for (const t of targets) {
      for (const ev of o.view.decidingEvidence(t)) {
        for (const input of ev.inputs) {
          const actual = candidateFileHash(o.candidate.snapshotDir, input.path);
          if (actual !== input.sha256) reasons.push({ kind: 'evidence-input-mismatch', evidence: ev.evidence, path: input.path, expected: input.sha256, actual });
        }
      }
    }
  }
  // 2. To a fixed point: units as a whole, then down prerequisite edges (reasons are only ever added).
  const failing = (oid: ObjectVersionId): boolean => (reasonsOf.get(oid)?.length ?? 0) > 0;
  for (let changed = true; changed; ) {
    changed = false;
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
  return { proven, notFullyProven, needsReverification };
}

/** The entries of a manifest that live in the repository (for reports). */
export function placedEntries(manifest: DeliveryManifest): readonly ManifestEntry[] {
  return manifest.entries.filter((e) => e.object.tree !== null);
}
