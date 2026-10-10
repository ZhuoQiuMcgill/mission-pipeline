// The lineage of a legalization (design 11.1, 5.2, 5.3): from the endpoint up its required edges
// (an object's required prerequisites and the objects its review contracts rely on), one
// generation at a time, stopping at proven nodes. A proof unit is one node: its members are
// replaced by the unit (5.3, 11.1 "证明单元在族谱里是一个节点").
//
// The walk reads base records only (objects, units) and the evaluator's labels; it decides:
//   chain     every node visited (the endpoint, the nodes not fully proven, and the proven nodes
//             where the walk stopped): the chain-acceptance object relies on all of them
//   pending   the nodes not proven (to be backfilled, top generation first)
//   blocked   nodes that are negated or rest on a withdrawn basis, with the required path from
//             the endpoint: no backfill can prove them (an Auditor never revokes a negation), so
//             the endpoint cannot be legalized (11.1 部分合法化: every path here is required)

import type { ObjectVersionRecord, ProofUnitRecord } from '../../common/records.ts';
import type { Label } from '../../evaluator/semantics.ts';
import type { FlowContent } from '../ports.ts';

export interface LineageNode {
  readonly id: string;
  readonly kind: 'object' | 'unit';
  readonly objectKind: string;
  readonly label: Label | 'unknown';
  /** Required parents (nodes), after mapping members to their units. */
  readonly parents: readonly string[];
  /** Generations from the endpoint (0). */
  readonly depth: number;
  /** One required path from the endpoint to this node (endpoint first). */
  readonly path: readonly string[];
}

export interface Lineage {
  readonly endpoint: string;
  readonly nodes: ReadonlyMap<string, LineageNode>;
  readonly chain: readonly string[];
  readonly pending: readonly string[];
  readonly blocked: readonly LineageNode[];
}

export interface LineageSource {
  readonly objects: ReadonlyMap<string, ObjectVersionRecord>;
  readonly units: ReadonlyMap<string, ProofUnitRecord>;
  /** Member object → its unit. */
  readonly unitOf: ReadonlyMap<string, string>;
  readonly content: FlowContent;
}

export function lineageSource(objects: readonly ObjectVersionRecord[], units: readonly ProofUnitRecord[], content: FlowContent): LineageSource {
  const o = new Map(objects.map((r) => [r.object as string, r]));
  const u = new Map(units.map((r) => [r.unit as string, r]));
  const unitOf = new Map<string, string>();
  for (const r of units) for (const m of content.getList(r.members)) unitOf.set(m, r.unit);
  return { objects: o, units: u, unitOf, content };
}

const nodeOf = (src: LineageSource, id: string): string => src.unitOf.get(id) ?? id;

/** The required parents of a node (objects relied on and prerequisites; a unit's members excluded). */
export function requiredParents(src: LineageSource, id: string): string[] {
  const out = new Set<string>();
  const fromObject = (o: ObjectVersionRecord, exclude: ReadonlySet<string>): void => {
    for (const p of src.content.getList(o.prerequisites)) if (!exclude.has(p)) out.add(nodeOf(src, p));
    for (const c of o.reviews) for (const r of c.reliesOn) if (!exclude.has(r)) out.add(nodeOf(src, r));
  };
  const u = src.units.get(id);
  if (u !== undefined) {
    const members = new Set(src.content.getList(u.members));
    for (const m of members) {
      const o = src.objects.get(m);
      if (o !== undefined) fromObject(o, members);
    }
    for (const c of u.reviews) for (const r of c.reliesOn) if (!members.has(r)) out.add(nodeOf(src, r));
  } else {
    const o = src.objects.get(id);
    if (o !== undefined) fromObject(o, new Set());
  }
  out.delete(id);
  return [...out].sort();
}

/** Walk the lineage from the endpoint (labels: the evaluator's, at one published revision). */
export function walkLineage(src: LineageSource, endpoint: string, labels: (ids: readonly string[]) => Readonly<Record<string, Label | null>>): Lineage {
  const start = nodeOf(src, endpoint);
  const nodes = new Map<string, LineageNode>();
  let frontier: Array<{ id: string; path: string[] }> = [{ id: start, path: [start] }];
  let depth = 0;
  while (frontier.length > 0) {
    const ls = labels(frontier.map((f) => f.id));
    const next: Array<{ id: string; path: string[] }> = [];
    for (const f of frontier) {
      if (nodes.has(f.id)) continue;
      const label = ls[f.id] ?? 'unknown';
      const parents = requiredParents(src, f.id);
      const u = src.units.get(f.id);
      nodes.set(f.id, { id: f.id, kind: u !== undefined ? 'unit' : 'object', objectKind: u !== undefined ? 'proof-unit' : (src.objects.get(f.id)?.objectKind ?? 'unknown'), label, parents, depth, path: f.path });
      // stop at proven nodes (11.1 "碰到已证明即停"), except the endpoint: its chain is judged anyway
      if (label === 'proven' && f.id !== start) continue;
      for (const p of parents) if (!nodes.has(p)) next.push({ id: p, path: [...f.path, p] });
    }
    frontier = next;
    depth++;
  }
  const all = [...nodes.values()];
  return {
    endpoint: start,
    nodes,
    chain: all.map((n) => n.id).sort(),
    pending: all.filter((n) => n.label !== 'proven').map((n) => n.id).sort(),
    blocked: all.filter((n) => n.label === 'negated' || n.label === 'basis-withdrawn' || n.label === 'unknown'),
  };
}

/** The pending nodes whose required parents (inside the chain) are all proven: the next generation to backfill. */
export function nextGeneration(l: Lineage, proven: (id: string) => boolean): string[] {
  return l.pending.filter((id) => !proven(id) && (l.nodes.get(id)?.parents ?? []).every((p) => !l.nodes.has(p) || proven(p)));
}
