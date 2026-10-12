// The delivery's proof view over the project memory (design 4.1 §4.1, §6.7;
// 4.0 6.6 steps 1-4, 5.1-5.3): replaces evaluatorView.ts, which asked the 4.0
// evaluator process over a socket.
//
// - The structure (object versions, their prerequisites and paths, proof units
//   and their members) is read from the skeleton's records, with their lists
//   from its data table, up to the labels' revision.
// - What decides each target (its stored label, and the runs its deciding
//   judgments rest on after renewals) comes from the labels package through the
//   narrow LabelView port; delivery derives none of it itself.
// - `recomputing` (§4.1): while a propagation frontier is non-empty every
//   decision that needs "proven" (a delivery among them) waits.

import type { EvidenceId, ObjectVersionId, ProofUnitId, Revision } from '../common/ids.ts';
import type { ObjectVersionRecord, ProofUnitRecord } from '../common/records.ts';
import type { Label } from '../evaluator/semantics.ts';
import { factById, recordsByKind, type Db, type Memory } from '../memory/index.ts';
import { runInputsFromFields, type DecidingEvidence, type DeliveryObject, type DeliveryProofView, type DeliveryTarget } from './proofView.ts';

/** What delivery reads from the stored labels (package A2 implements it, §4.1). */
export interface LabelView {
  /** The log revision the stored labels reflect. */
  readonly revision: Revision;
  /** A propagation frontier is non-empty: nothing may be used as proven; the delivery waits (§4.1). */
  readonly recomputing: boolean;
  /**
   * The same question inside a write transaction (the delivery's final
   * authorization, §4.1): is a frontier non-empty now? Label inputs committed
   * since `revision` are found by the delivery itself, from the log.
   */
  recomputingIn(db: Db): boolean;
  /** The stored display label of an object version or a proof unit; one with no label is "unaccepted". */
  labelOf(target: DeliveryTarget): Label;
  /**
   * The runs the deciding judgment of every required review position of the
   * target rests on, after valid renewals (5.2, 5.3), with their recorded
   * fields (the file inputs are read from `input:<path>` fields).
   */
  decidingRuns(target: DeliveryTarget): readonly { readonly evidence: EvidenceId; readonly fields: Readonly<Record<string, string>> | null }[];
}

/** The DeliveryProofView (proofView.ts) of the memory's records at `labels.revision`, with the labels' answers. */
export function memoryProofView(m: Memory, labels: LabelView): DeliveryProofView {
  const at = Number(labels.revision);
  const objects = new Map<string, DeliveryObject | null>();
  const units = new Map<string, readonly ObjectVersionId[] | null>();
  let unitOfMember: Map<string, ProofUnitId> | null = null;

  const fact = <R>(kind: string, id: string): R | null =>
    m.read((db) => {
      const c = factById(db, kind, id);
      return c !== null && Number(c.revision) <= at ? (c.record as unknown as R) : null;
    });
  const isUnit = (id: string): boolean => unitMembers(id as ProofUnitId) !== null;

  function unitMembers(unit: ProofUnitId): readonly ObjectVersionId[] | null {
    if (!units.has(unit)) {
      const r = fact<ProofUnitRecord>('proof.unit', unit);
      units.set(unit, r === null ? null : Object.freeze(m.data.getList(r.members) as ObjectVersionId[]));
    }
    return units.get(unit)!;
  }

  function memberIndex(): Map<string, ProofUnitId> {
    if (unitOfMember !== null) return unitOfMember;
    const idx = new Map<string, ProofUnitId>();
    let after = 0;
    for (;;) {
      const page = m.read((db) => recordsByKind(db, { kinds: ['proof.unit'], after, limit: 1000 }));
      for (const c of page) {
        if (Number(c.revision) > at) continue;
        const r = c.record as ProofUnitRecord;
        for (const member of m.data.getList(r.members)) idx.set(member, r.unit);
      }
      if (page.length === 0) break;
      after = Number(page[page.length - 1]!.revision);
    }
    unitOfMember = idx;
    return idx;
  }

  return {
    revision: labels.revision,
    object(id: ObjectVersionId): DeliveryObject | null {
      if (!objects.has(id)) {
        const r = fact<ObjectVersionRecord>('object.version', id);
        objects.set(
          id,
          r === null
            ? null
            : Object.freeze({
                id: r.object,
                kind: r.objectKind,
                mission: r.mission,
                module: r.module,
                content: r.content,
                prerequisites: Object.freeze(m.data.getList(r.prerequisites).map((p): DeliveryTarget => (isUnit(p) ? { kind: 'unit', id: p as ProofUnitId } : { kind: 'object', id: p as ObjectVersionId }))),
                paths: r.scope.paths,
                tree: r.source ?? null,
                predecessor: r.predecessor ?? null,
              }),
        );
      }
      return objects.get(id)!;
    },
    unitOf(id: ObjectVersionId): ProofUnitId | null {
      return memberIndex().get(id) ?? null;
    },
    unitMembers,
    label(target: DeliveryTarget): Label {
      return labels.labelOf(target);
    },
    decidingEvidence(target: DeliveryTarget): readonly DecidingEvidence[] {
      const seen = new Set<string>();
      const out: DecidingEvidence[] = [];
      for (const run of labels.decidingRuns(target)) {
        if (seen.has(run.evidence)) continue;
        seen.add(run.evidence);
        out.push({ evidence: run.evidence, inputs: run.fields === null ? [] : runInputsFromFields(run.fields) });
      }
      return out;
    },
  };
}
