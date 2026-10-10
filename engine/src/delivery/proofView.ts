// What delivery reads from the proof state (design 6.6 steps 1-4; 5.1-5.3; 6.1).
//
// The evaluator implements this view at ONE published revision R: "proven" in
// a delivery always means "proven as of revision R" (6.1). Delivery reads
// nothing else from the evaluator or the ledger. Every method is a pure lookup.

import { contentHash, type ContentHash, type EvidenceId, type MissionId, type ModuleId, type ObjectVersionId, type ProofUnitId, type Revision } from '../common/ids.ts';
import type { EvidenceRecord, ObjectKind, ObjectVersionRecord } from '../common/records.ts';
import type { Label } from '../evaluator/semantics.ts';

/** A selected output or a prerequisite: an object version or a proof unit (tagged; never guessed from the id). */
export type DeliveryTarget = { readonly kind: 'object'; readonly id: ObjectVersionId } | { readonly kind: 'unit'; readonly id: ProofUnitId };

export function objectTarget(id: ObjectVersionId): DeliveryTarget {
  return { kind: 'object', id };
}

export function unitTarget(id: ProofUnitId): DeliveryTarget {
  return { kind: 'unit', id };
}

export function targetKey(t: DeliveryTarget): string {
  return `${t.kind}:${t.id}`;
}

/**
 * Where an object version lives in the repository: exactly ObjectVersionRecord.source
 * (5.1: a product version is "a write scope's content hash and a commit").
 * - commit: the commit the program generated for the version (7.1); its first
 *   parent is the snapshot it was built from;
 * - writeScope: the module's write scope, as path patterns with the meaning of
 *   constraint scopes (9.5): an exact path, "dir/**", or "**"; `content` is the
 *   identity of everything the commit's tree has inside it (writeScope.ts);
 * - transform: the hash of the transform description the version was
 *   materialized and verified under (7.1).
 */
export type TreePlacement = NonNullable<ObjectVersionRecord['source']>;

/** One object version, as recorded (ObjectVersionRecord, 5.1) plus its tree placement. */
export interface DeliveryObject {
  readonly id: ObjectVersionId;
  readonly kind: ObjectKind;
  readonly mission: MissionId;
  readonly module: ModuleId | null;
  /**
   * ObjectVersionRecord.content. For an object with a tree placement this is
   * writeScopeIdentity(placement.writeScope, tree of placement.commit) (writeScope.ts).
   */
  readonly content: ContentHash;
  /** ObjectVersionRecord.prerequisites (5.3): required prerequisite objects or proof units. */
  readonly prerequisites: readonly DeliveryTarget[];
  /** ObjectScope.paths (v33 5.2): the concrete paths this version covers. */
  readonly paths: readonly string[];
  /** Null for objects that are not files in the repository (plans, exploration interpretations). */
  readonly tree: TreePlacement | null;
}

/** 7.2 "输入文件哈希": a repository file a run read, hashed as the run saw it (worktree representation). */
export interface RunInput {
  readonly path: string;
  readonly sha256: ContentHash;
}

/**
 * A run's file inputs from its evidence record, by the convention the 5.6
 * regression check also reads: `fields["input:<name>"]` = sha256, where <name>
 * is the repository-relative path of the file as the run saw it.
 */
export function runInputsFromFields(fields: EvidenceRecord['fields']): RunInput[] {
  const out: RunInput[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!k.startsWith('input:')) continue;
    const path = k.slice('input:'.length);
    if (path === '') throw new TypeError('evidence field "input:" names no file');
    out.push({ path, sha256: contentHash(v) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A run used by a deciding judgment (5.2), with its file inputs. */
export interface DecidingEvidence {
  readonly evidence: EvidenceId;
  readonly inputs: readonly RunInput[];
}

export interface DeliveryProofView {
  /** The published revision every answer is read at (6.1). */
  readonly revision: Revision;
  /** An object version (5.1); null when no such version exists. */
  object(id: ObjectVersionId): DeliveryObject | null;
  /** The proof unit the version is a member of (5.3), if any. */
  unitOf(id: ObjectVersionId): ProofUnitId | null;
  /** The members of a proof unit (ProofUnitRecord.members, 5.3); null when no such unit exists. */
  unitMembers(unit: ProofUnitId): readonly ObjectVersionId[] | null;
  /** The display label at `revision` (5.2/5.3). A unit is proven or not as a whole. */
  label(target: DeliveryTarget): Label;
  /**
   * The runs the target's proof rests on: the required evidence of the deciding
   * judgment of every required review position (5.2), after renewals (5.3).
   */
  decidingEvidence(target: DeliveryTarget): readonly DecidingEvidence[];
}
