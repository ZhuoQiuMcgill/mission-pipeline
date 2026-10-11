// Shared fixtures for the delivery candidate and manifest tests (helpers only,
// no tests): an in-memory DeliveryProofView (the memory's is memoryView.ts) and
// a helper that records a product version from a real commit the way the
// program does.

import { id, revision, type ContentHash, type EvidenceId, type GitOid, type MissionId, type ModuleId, type ObjectVersionId, type ProofUnitId } from '../src/common/ids.ts';
import type { Label } from '../src/evaluator/semantics.ts';
import { targetKey, type DecidingEvidence, type DeliveryObject, type DeliveryProofView, type DeliveryTarget } from '../src/delivery/proofView.ts';
import { inWriteScope, writeScopeIdentityAt } from '../src/delivery/writeScope.ts';
import { lsTree, type RepoLayout } from '../src/git/objects.ts';
import type { GitExec } from '../src/git/plainGit.ts';

export const MISSION = id<MissionId>('m1');

export class FakeProofView implements DeliveryProofView {
  readonly revision = revision(42);
  readonly objects = new Map<ObjectVersionId, DeliveryObject>();
  readonly units = new Map<ProofUnitId, ObjectVersionId[]>();
  readonly labels = new Map<string, Label>();
  readonly evidence = new Map<string, DecidingEvidence[]>();

  add(...objs: DeliveryObject[]): this {
    for (const o of objs) this.objects.set(o.id, o);
    return this;
  }
  unit(u: ProofUnitId, members: ObjectVersionId[]): this {
    this.units.set(u, members);
    return this;
  }
  setLabel(t: DeliveryTarget, l: Label): this {
    this.labels.set(targetKey(t), l);
    return this;
  }
  setEvidence(t: DeliveryTarget, ev: DecidingEvidence[]): this {
    this.evidence.set(targetKey(t), ev);
    return this;
  }

  object(oid: ObjectVersionId): DeliveryObject | null {
    return this.objects.get(oid) ?? null;
  }
  unitOf(oid: ObjectVersionId): ProofUnitId | null {
    for (const [u, ms] of this.units) if (ms.includes(oid)) return u;
    return null;
  }
  unitMembers(u: ProofUnitId): readonly ObjectVersionId[] | null {
    return this.units.get(u) ?? null;
  }
  label(t: DeliveryTarget): Label {
    return this.labels.get(targetKey(t)) ?? 'proven';
  }
  decidingEvidence(t: DeliveryTarget): readonly DecidingEvidence[] {
    return this.evidence.get(targetKey(t)) ?? [];
  }
}

export const ov = (s: string): ObjectVersionId => id<ObjectVersionId>(s);
export const pu = (s: string): ProofUnitId => id<ProofUnitId>(s);
export const mod = (s: string): ModuleId => id<ModuleId>(s);
export const evi = (s: string): EvidenceId => id<EvidenceId>(s);
export const obj = (s: string): DeliveryTarget => ({ kind: 'object', id: ov(s) });
export const unit = (s: string): DeliveryTarget => ({ kind: 'unit', id: pu(s) });

const FAKE_HASH = '0'.repeat(64) as ContentHash;

/** An object version for manifest-only tests (no repository behind it). */
export function fakeObject(
  oid: string,
  o: { module?: string | null; paths?: string[]; prerequisites?: DeliveryTarget[]; kind?: DeliveryObject['kind']; placed?: boolean } = {},
): DeliveryObject {
  const placed = o.placed ?? (o.kind ?? 'product') === 'product';
  return {
    id: ov(oid),
    kind: o.kind ?? 'product',
    mission: MISSION,
    module: o.module === undefined ? mod(oid.replace(/[0-9]+$/, '')) : o.module === null ? null : mod(o.module),
    content: FAKE_HASH,
    prerequisites: o.prerequisites ?? [],
    paths: o.paths ?? [],
    tree: placed ? { commit: 'f'.repeat(40) as GitOid, writeScope: (o.paths ?? []).length > 0 ? (o.paths as string[]) : ['**'], transform: FAKE_HASH } : null,
  };
}

/** A product version recorded from a generated commit, as the program records it (5.1, writeScope.ts). */
export async function productVersion(
  git: GitExec,
  repo: RepoLayout,
  o: { id: string; module: string; writeScope: string[]; commit: GitOid; transform: ContentHash; prerequisites?: DeliveryTarget[] },
): Promise<DeliveryObject> {
  const entries = await lsTree(git, repo, o.commit, { recursive: true });
  return {
    id: ov(o.id),
    kind: 'product',
    mission: MISSION,
    module: mod(o.module),
    content: await writeScopeIdentityAt(git, repo, o.commit, o.writeScope),
    prerequisites: o.prerequisites ?? [],
    paths: entries.filter((e) => inWriteScope(o.writeScope, e.path)).map((e) => e.path),
    tree: { commit: o.commit, writeScope: o.writeScope, transform: o.transform },
  };
}
