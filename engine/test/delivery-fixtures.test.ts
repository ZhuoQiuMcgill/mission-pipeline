// Shared fixtures for the delivery tests (helpers only, no tests): an in-memory
// DeliveryProofView (the evaluator will implement the real one), an in-memory
// DeliveryAuthority (the ledger service will), a stub ClosingCheckRunner (the
// exec run host will), and a helper that records a product version from a real
// commit the way the program does.

import { id, revision, type ContentHash, type EvidenceId, type GitOid, type MissionId, type ModuleId, type ObjectVersionId, type ProofUnitId } from '../src/common/ids.ts';
import type { Label } from '../src/evaluator/semantics.ts';
import type { ClosingCheckOutcome, ClosingCheckRunner, DeliveryAuthority, DeliveryDisk, DeliveryIntent, DeliveryKey, DeliveryNotice, DeliveryRecord, RebuildRecord } from '../src/delivery/deliver.ts';
import { targetKey, type DecidingEvidence, type DeliveryObject, type DeliveryProofView, type DeliveryTarget } from '../src/delivery/proofView.ts';
import { inWriteScope, writeScopeIdentityAt } from '../src/delivery/writeScope.ts';
import { lsTree, type RepoLayout } from '../src/git/objects.ts';
import type { ProcessIdentity, SafeGit } from '../src/git/safeGit.ts';

export const MISSION = id<MissionId>('m1');

/** WI-05's quiet period off: tests that move the target rebuild at once. */
export const NO_QUIET = { quietMs: 0, pollMs: 1 } as const;

/** Disk admission with the real filesystem statistics and no ledger on these volumes (6.5). */
export const TEST_DISK: DeliveryDisk = { reserve: { recoveryReserveBytes: 0, evaluatorPoolBytes: 0 }, sharesVolume: () => false };

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
  git: SafeGit,
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

export class MemoryAuthority implements DeliveryAuthority {
  authorization: { readonly ok: true } | { readonly ok: false; readonly reason: string } = { ok: true };
  readonly intents: DeliveryIntent[] = [];
  readonly writers: ProcessIdentity[] = [];
  readonly completed: DeliveryRecord[] = [];
  readonly finished: string[] = [];
  readonly signatures: string[] = [];
  rebuildCount: number;
  limit = 3;
  constructor(rebuildsUsed = 0) {
    this.rebuildCount = rebuildsUsed;
  }
  async rebuildBudget(_key: DeliveryKey): Promise<{ readonly used: number; readonly limit: number }> {
    return { used: this.rebuildCount, limit: this.limit };
  }
  async finish(_key: DeliveryKey, outcome: 'failed'): Promise<void> {
    this.finished.push(outcome);
  }
  async authorize(_key: DeliveryKey, intent: DeliveryIntent): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    this.intents.push(intent);
    return this.authorization;
  }
  async recordRefWriter(_key: DeliveryKey, writer: ProcessIdentity): Promise<void> {
    this.writers.push(writer);
  }
  /** The ledger's LOOP_EXHAUSTED refusal from this many recorded rebuilds on (null: never). */
  refuseRebuildsFrom: number | null = null;
  async recordRebuild(_key: DeliveryKey, signature: string): Promise<RebuildRecord> {
    if (this.refuseRebuildsFrom !== null && this.rebuildCount >= this.refuseRebuildsFrom) return { kind: 'exhausted', detail: 'LOOP_EXHAUSTED (stand-in)' };
    this.signatures.push(signature);
    return { kind: 'recorded', total: ++this.rebuildCount };
  }
  async complete(_key: DeliveryKey, record: DeliveryRecord): Promise<void> {
    this.completed.push(record);
  }
  readonly notices: DeliveryNotice[] = [];
  async notify(_key: DeliveryKey, notice: DeliveryNotice): Promise<void> {
    this.notices.push(notice);
  }
}

/** A closing-check runner stub: every check passes unless listed in `failing`; `onRun` simulates the world moving meanwhile. */
export class StubChecks implements ClosingCheckRunner {
  readonly calls: { commit: GitOid; snapshotDir: string }[] = [];
  failing = new Set<string>();
  onRun: ((call: number) => void | Promise<void>) | null = null;
  async run(request: Parameters<ClosingCheckRunner['run']>[0]): Promise<readonly ClosingCheckOutcome[]> {
    this.calls.push({ commit: request.commit, snapshotDir: request.snapshotDir });
    if (this.onRun !== null) await this.onRun(this.calls.length);
    return request.checks.map((c) => ({ id: c.id, passed: !this.failing.has(c.id), evidence: null, detail: this.failing.has(c.id) ? 'failed' : 'passed' }));
  }
}
