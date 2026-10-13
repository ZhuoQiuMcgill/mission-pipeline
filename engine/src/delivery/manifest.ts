// Delivery manifest and consistency check (design 6.6 steps 1 and 2; 5.3).
//
// 1. Manifest: from the selected outputs, follow prerequisite edges to every
//    object version they depend on, with its module, paths and version. A proof
//    unit enters whole: reaching any member brings in every member (5.3:
//    delivery, legalization and revocation always take the whole unit).
// 2. Consistency: every path may have one version only, and so may every
//    module. Two selected outputs depending on different versions of the same
//    path or module make the manifest incompatible; the result names both
//    sides, so an integration task can be planned (6.6 step 2). Versions
//    stacked on each other are one line of work, not two sides (design 4.1
//    Appendix L): when one rests on the other (the other is in its
//    prerequisite closure), its task started from a snapshot that already held
//    the other, so both may cover a path or a module; the one on top delivers
//    the path, and the candidate's overlay (candidate.ts) still checks, path
//    by path, that it really started from what the one below delivered.

import type { ModuleId, ObjectVersionId, ProofUnitId, Revision } from '../common/ids.ts';
import type { Label } from '../evaluator/semantics.ts';
import { targetKey, type DeliveryObject, type DeliveryProofView, type DeliveryTarget } from './proofView.ts';

export interface ManifestEntry {
  readonly object: DeliveryObject;
  /** The proof unit this version entered with (whole), if it is a member of one. */
  readonly unit: ProofUnitId | null;
  /** Its label at the view's revision; a unit member takes its unit's label (proven as a whole, 5.3). */
  readonly label: Label;
  /** The selected outputs whose dependency closure contains this version. */
  readonly requiredBy: readonly DeliveryTarget[];
  /** One dependency chain from a selected output down to this version, for explanations. */
  readonly chain: readonly DeliveryTarget[];
}

export interface ManifestUnit {
  readonly unit: ProofUnitId;
  readonly members: readonly ObjectVersionId[];
  readonly label: Label;
}

export interface DeliveryManifest {
  readonly revision: Revision;
  readonly selected: readonly DeliveryTarget[];
  /** Every object version in the manifest, sorted by id. */
  readonly entries: readonly ManifestEntry[];
  readonly units: readonly ManifestUnit[];
  /** Every repository path of the manifest and the one version that delivers it (of stacked versions, the one on top). */
  readonly paths: ReadonlyMap<string, ObjectVersionId>;
}

export interface ConflictSide {
  readonly version: ObjectVersionId;
  readonly requiredBy: readonly DeliveryTarget[];
  readonly chain: readonly DeliveryTarget[];
}

export interface ManifestConflict {
  /** same-path: two versions deliver one path. same-module: two versions of one module. */
  readonly kind: 'same-path' | 'same-module';
  readonly path: string | null;
  readonly module: ModuleId | null;
  readonly sides: readonly ConflictSide[];
}

export type ManifestResult =
  | { readonly kind: 'manifest'; readonly manifest: DeliveryManifest }
  /** 6.6 step 2: an integration task producing compatible versions is planned, then the manifest is recomputed. */
  | { readonly kind: 'incompatible'; readonly conflicts: readonly ManifestConflict[]; readonly entries: readonly ManifestEntry[] }
  /** The view does not know a selected or prerequisite id: a broken request, not a proof state. */
  | { readonly kind: 'unknown'; readonly missing: readonly DeliveryTarget[] }
  /**
   * Product versions without a tree placement (ObjectVersionRecord.source): 5.1
   * defines a product version as a write scope's content hash AND a commit, so
   * their files cannot be delivered. Refused rather than silently left out.
   */
  | { readonly kind: 'unplaced'; readonly versions: readonly ObjectVersionId[] };

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * For each of `objects`, the ids of the others it rests on (Appendix L): its
 * prerequisites, a prerequisite unit by its members, followed down through the
 * objects given, transitively; never itself.
 */
export function prerequisiteClosure(
  objects: readonly Pick<DeliveryObject, 'id' | 'prerequisites'>[],
  unitMembers: (unit: ProofUnitId) => readonly ObjectVersionId[] | null,
): Map<ObjectVersionId, Set<ObjectVersionId>> {
  const byKey = new Map(objects.map((x) => [x.id, x]));
  const out = new Map<ObjectVersionId, Set<ObjectVersionId>>();
  for (const x of objects) {
    const seen = new Set<ObjectVersionId>();
    const queue = [...x.prerequisites];
    while (queue.length > 0) {
      const t = queue.shift() as DeliveryTarget;
      const ids = t.kind === 'unit' ? (unitMembers(t.id) ?? []) : [t.id];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const next = byKey.get(id);
        if (next !== undefined) queue.push(...next.prerequisites);
      }
    }
    seen.delete(x.id);
    out.set(x.id, new Set([...seen].filter((id) => byKey.has(id))));
  }
  return out;
}

/**
 * The order in which versions are laid over a base (Appendix L): every version
 * after the versions it rests on, unrelated versions by id. Prerequisites that
 * form a cycle (members of one proof unit) are broken by taking the version with
 * the fewest of them still to place, then by id.
 */
export function stackOrder(ids: readonly ObjectVersionId[], closure: ReadonlyMap<ObjectVersionId, ReadonlySet<ObjectVersionId>>): ObjectVersionId[] {
  const remaining = [...new Set(ids)].sort(byId);
  const order: ObjectVersionId[] = [];
  while (remaining.length > 0) {
    let pick = 0;
    let fewest = Infinity;
    for (const [i, id] of remaining.entries()) {
      const below = closure.get(id);
      const open = below === undefined ? 0 : remaining.filter((r) => r !== id && below.has(r)).length;
      if (open < fewest) {
        fewest = open;
        pick = i;
        if (open === 0) break;
      }
    }
    order.push(...remaining.splice(pick, 1));
  }
  return order;
}

/** Whether every two of `ids` are stacked: one rests on the other. */
function stacked(ids: readonly ObjectVersionId[], closure: ReadonlyMap<ObjectVersionId, ReadonlySet<ObjectVersionId>>): boolean {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i] as ObjectVersionId;
      const b = ids[j] as ObjectVersionId;
      if (!(closure.get(a)?.has(b) ?? false) && !(closure.get(b)?.has(a) ?? false)) return false;
    }
  }
  return true;
}

export function buildManifest(view: DeliveryProofView, selected: readonly DeliveryTarget[]): ManifestResult {
  const entries = new Map<ObjectVersionId, { object: DeliveryObject; unit: ProofUnitId | null; requiredBy: Map<string, DeliveryTarget>; chain: DeliveryTarget[] }>();
  const units = new Map<ProofUnitId, readonly ObjectVersionId[]>();
  const missing = new Map<string, DeliveryTarget>();

  // One walk per selected output, so every entry knows exactly which outputs need it.
  for (const root of selected) {
    const seen = new Set<string>();
    const queue: { t: DeliveryTarget; chain: DeliveryTarget[] }[] = [{ t: root, chain: [root] }];
    while (queue.length > 0) {
      const { t, chain } = queue.shift() as { t: DeliveryTarget; chain: DeliveryTarget[] };
      const key = targetKey(t);
      if (seen.has(key)) continue;
      seen.add(key);
      if (t.kind === 'unit') {
        const members = view.unitMembers(t.id);
        if (members === null) {
          missing.set(key, t);
          continue;
        }
        units.set(t.id, members);
        for (const m of members) queue.push({ t: { kind: 'object', id: m }, chain: [...chain, { kind: 'object', id: m }] });
        continue;
      }
      const object = view.object(t.id);
      if (object === null) {
        missing.set(key, t);
        continue;
      }
      const unit = view.unitOf(t.id);
      let e = entries.get(t.id);
      if (e === undefined) {
        e = { object, unit, requiredBy: new Map(), chain };
        entries.set(t.id, e);
      }
      e.requiredBy.set(targetKey(root), root);
      // A member brings its whole unit (5.3).
      if (unit !== null) queue.push({ t: { kind: 'unit', id: unit }, chain: [...chain, { kind: 'unit', id: unit }] });
      for (const p of object.prerequisites) queue.push({ t: p, chain: [...chain, p] });
    }
  }
  if (missing.size > 0) return { kind: 'unknown', missing: [...missing.values()] };
  const unplaced = [...entries.values()].filter((e) => e.object.kind === 'product' && e.object.tree === null).map((e) => e.object.id);
  if (unplaced.length > 0) return { kind: 'unplaced', versions: unplaced.sort(byId) };

  const unitLabels = new Map<ProofUnitId, Label>();
  for (const u of units.keys()) unitLabels.set(u, view.label({ kind: 'unit', id: u }));
  const list: ManifestEntry[] = [...entries.entries()]
    .sort(([a], [b]) => byId(a, b))
    .map(([id, e]) => ({
      object: e.object,
      unit: e.unit,
      label: e.unit !== null ? (unitLabels.get(e.unit) ?? view.label({ kind: 'unit', id: e.unit })) : view.label({ kind: 'object', id }),
      requiredBy: [...e.requiredBy.values()],
      chain: e.chain,
    }));

  // Consistency (6.6 step 2): one version per repository path and per module.
  const side = (e: ManifestEntry): ConflictSide => ({ version: e.object.id, requiredBy: e.requiredBy, chain: e.chain });
  const byPath = new Map<string, ManifestEntry[]>();
  const byModule = new Map<ModuleId, ManifestEntry[]>();
  for (const e of list) {
    if (e.object.tree === null) continue; // plans and interpretations are not files of the delivery
    for (const p of e.object.paths) {
      const l = byPath.get(p);
      if (l === undefined) byPath.set(p, [e]);
      else l.push(e);
    }
    if (e.object.module !== null) {
      const l = byModule.get(e.object.module);
      if (l === undefined) byModule.set(e.object.module, [e]);
      else l.push(e);
    }
  }
  // Versions stacked on each other share paths and modules as one line of work (Appendix L).
  const closure = prerequisiteClosure(
    list.map((e) => e.object),
    (u) => units.get(u) ?? null,
  );
  const apart = (es: readonly ManifestEntry[]): boolean => es.length > 1 && !stacked(es.map((e) => e.object.id), closure);
  const conflicts: ManifestConflict[] = [];
  for (const [path, es] of [...byPath.entries()].sort(([a], [b]) => byId(a, b))) {
    if (apart(es)) conflicts.push({ kind: 'same-path', path, module: null, sides: es.map(side) });
  }
  for (const [module, es] of [...byModule.entries()].sort(([a], [b]) => byId(a, b))) {
    if (apart(es)) conflicts.push({ kind: 'same-module', path: null, module, sides: es.map(side) });
  }
  if (conflicts.length > 0) return { kind: 'incompatible', conflicts, entries: list };

  const rank = new Map(stackOrder(list.map((e) => e.object.id), closure).map((id, i) => [id, i]));
  const paths = new Map<string, ObjectVersionId>();
  for (const [p, es] of byPath) {
    const top = es.reduce((a, b) => ((rank.get(b.object.id) ?? 0) > (rank.get(a.object.id) ?? 0) ? b : a));
    paths.set(p, top.object.id);
  }
  return {
    kind: 'manifest',
    manifest: {
      revision: view.revision,
      selected,
      entries: list,
      units: [...units.entries()]
        .sort(([a], [b]) => byId(a, b))
        .map(([unit, members]) => ({ unit, members, label: unitLabels.get(unit) as Label })),
      paths,
    },
  };
}
