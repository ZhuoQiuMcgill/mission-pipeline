// Incremental maintenance of the derived state (design 5.4, 5.5, 6.1).
//
// The evaluator keeps the indexed base records and the memoized derivation
// between updates. Applying a batch of new base records:
//   1. index each record and note what it touches directly (seeds);
//   2. collect the affected set: everything reachable from the seeds along the
//      reverse dependency edges ("who reads this?"), with a visited set;
//   3. drop the memoized values of the affected set and evaluate it again; the
//      derivation reuses every unaffected memoized value, which is still exact
//      because nothing it reads has changed;
//   4. publish a new snapshot that changes only the affected entries.
// The cost follows the affected subgraph, not the number of paths (5.4) and not
// the size of the ledger. Correctness is defined by fullCompute: every published
// state must equal it over the same records (tested in evaluator-incremental).
//
// The reverse edges must over-approximate what each rule reads (semantics.ts):
//   judgment J   <- its evidence and renewals, the versions of its basis lines,
//                   its target's record (the contract), the objects it relies
//                   on, and (for a continuation) the judgment it continues;
//   e:X (in effect) <- judgments on X (a unit: also its members' e:);
//   f:X (fresh)     <- e:X, X's record, its prerequisites' p:, its unit's
//                      membership, constraints whose scope matches X (before or
//                      after) (a unit: also its members' f:);
//   p:X (proven)    <- f:X; for a member, its unit's p:;
//   position     <- the target's judgments; fixes <- the target, regression runs;
//   operation    <- its record and the objects it lists (kept as sets of
//                   unproven objects, so a change costs O(operations touched)).

import { sha256 } from '../common/hash.ts';
import type { BasisLineId, BasisVersionId, EvidenceId, JudgmentId, OpId, ProofUnitId, Revision } from '../common/ids.ts';
import { reviewPosition, type ConstraintScope, type ReviewPosition } from '../common/records.ts';
import {
  Derivation,
  Index,
  basisState,
  constraintApplies,
  evidenceApplicable,
  type BasisState,
  type ContinuationRequest,
  type ContinuationResult,
  type DecidingView,
  type DerivedState,
  type FixState,
  type OpState,
  type ResolvedCommitted,
  type TargetState,
} from './semantics.ts';
import { SnapshotMap } from './snapshot.ts';

export interface PublishedState extends DerivedState {
  readonly basis: SnapshotMap<BasisVersionId, BasisState>;
  readonly evidenceApplicable: SnapshotMap<EvidenceId, boolean>;
  readonly judgmentCurrent: SnapshotMap<JudgmentId, boolean>;
  readonly positionInEffect: SnapshotMap<ReviewPosition, boolean>;
  readonly targets: SnapshotMap<string, TargetState>;
  readonly fixes: SnapshotMap<string, FixState>;
  readonly ops: SnapshotMap<OpId, OpState>;
}

/** A dependency cycle (5.2 part 4): a strongly connected component of fact nodes, sorted. */
export interface DependencyCycle {
  /** Stable identity: a hash of the sorted node list. */
  readonly id: string;
  readonly nodes: readonly string[];
}

export function cycleId(nodes: readonly string[]): string {
  return sha256(JSON.stringify(nodes)).slice(0, 16);
}

export interface ApplyReport {
  readonly state: PublishedState;
  /** Operations whose state changed (or appeared) in this batch. */
  readonly changedOps: readonly OpId[];
  /** Size of the affected set (fact nodes). */
  readonly affected: number;
  /** Cycles that exist after this batch and did not exist before it (WI-16). */
  readonly newCycles: readonly DependencyCycle[];
}

function emptyState(): PublishedState {
  return Object.freeze({
    revision: 0 as Revision,
    basis: SnapshotMap.empty(),
    evidenceApplicable: SnapshotMap.empty(),
    judgmentCurrent: SnapshotMap.empty(),
    positionInEffect: SnapshotMap.empty(),
    targets: SnapshotMap.empty(),
    fixes: SnapshotMap.empty(),
    ops: SnapshotMap.empty(),
  }) as PublishedState;
}

export class IncrementalDerivation {
  private readonly ix = new Index();
  private readonly d = new Derivation(this.ix);
  private current: PublishedState = emptyState();
  /** target -> fix keys currently published for it. */
  private readonly fixKeys = new Map<string, Set<string>>();
  /** operation -> the distinct listed targets that are not proven. */
  private readonly unproven = new Map<OpId, Set<string>>();
  /** The dependency cycles in the current state, by id. */
  private readonly cycleSet = new Map<string, readonly string[]>();

  state(): PublishedState {
    return this.current;
  }

  /** The dependency cycles in the state last applied. */
  cycles(): DependencyCycle[] {
    return [...this.cycleSet].map(([id, nodes]) => ({ id, nodes }));
  }

  /** The continuation check of v32 5.2 part 5, against the state last applied. */
  continuation(req: ContinuationRequest): ContinuationResult {
    return this.d.continuation(req);
  }

  /** What decides each target's proof, against the state last applied (null: unknown target). */
  deciding(targets: readonly string[]): Map<string, DecidingView | null> {
    const out = new Map<string, DecidingView | null>();
    for (const t of targets) out.set(t, this.d.deciding(t));
    return out;
  }

  /** Apply base records (all with revision <= at, in order) and publish revision `at`. */
  apply(batch: readonly ResolvedCommitted[], at: Revision): ApplyReport {
    const ix = this.ix;
    const seeds: string[] = [];
    const lines = new Set<BasisLineId>();
    const evidence = new Set<EvidenceId>();
    const fixTargets = new Set<string>();
    const ops = new Set<OpId>();
    const newOps = new Set<OpId>();
    const scopes: ConstraintScope[] = [];
    const scopeOf = (line: BasisLineId): void => {
      const c = ix.constraints.get(line);
      if (c?.scope) scopes.push(c.scope);
    };
    const targetSeeds = (t: string): void => {
      seeds.push(`e:${t}`, `f:${t}`, `p:${t}`);
    };

    this.d.cycleNodes.clear();

    // 1. Index the records and collect the seeds.
    for (const c of batch) {
      const r = c.record;
      switch (r.kind) {
        case 'basis.version':
          scopeOf(r.line);
          if (!ix.add(c)) break;
          scopeOf(r.line);
          lines.add(r.line);
          break;
        case 'constraint.scope':
          scopeOf(r.line);
          ix.add(c);
          scopeOf(r.line);
          break;
        case 'basis.withdrawn':
          ix.add(c);
          scopeOf(r.line);
          lines.add(r.line);
          break;
        case 'env.snapshot':
          ix.add(c);
          for (const e of ix.evidenceByEnvLine.get(r.line) ?? []) evidence.add(e);
          break;
        case 'evidence':
        case 'evidence.revoked':
          if (!ix.add(c)) break;
          evidence.add(r.evidence);
          break;
        case 'evidence.renewal':
          ix.add(c);
          seeds.push(`j:${r.judgment}`);
          break;
        case 'object.version':
          if (!ix.add(c)) break;
          targetSeeds(r.object);
          for (const j of ix.judgmentsByTarget.get(r.object) ?? []) seeds.push(`j:${j}`);
          for (const u of ix.unitsByMember.get(r.object) ?? []) targetSeeds(u);
          break;
        case 'proof.unit':
          if (!ix.add(c)) break;
          targetSeeds(r.unit);
          for (const m of r.members) targetSeeds(m);
          for (const j of ix.judgmentsByTarget.get(r.unit) ?? []) seeds.push(`j:${j}`);
          break;
        case 'judgment':
          if (!ix.add(c)) break;
          seeds.push(`j:${r.judgment}`);
          targetSeeds(r.target);
          for (const k of ix.continuationsOf.get(r.judgment) ?? []) seeds.push(`j:${k}`);
          break;
        case 'issue':
          ix.add(c);
          break;
        case 'issue.coverage':
          ix.add(c);
          fixTargets.add(r.version);
          break;
        case 'op.pending':
          if (!ix.add(c)) break;
          ops.add(r.op);
          newOps.add(r.op);
          break;
        case 'op.executed':
          if (!ix.add(c)) break;
          ops.add(r.op);
          break;
      }
    }
    for (const line of lines) {
      for (const v of ix.versionsByLine.get(line) ?? []) for (const j of ix.judgmentsByBasisVersion.get(v) ?? []) seeds.push(`j:${j}`);
    }
    for (const e of evidence) {
      for (const j of ix.judgmentsByEvidence.get(e) ?? []) seeds.push(`j:${j}`);
      for (const t of ix.regressionTargetsByEvidence.get(e) ?? []) fixTargets.add(t);
    }
    for (const s of scopes) {
      for (const o of ix.objectsMatching(s)) if (constraintApplies(s, ix.objects.get(o)!.scope)) seeds.push(`f:${o}`);
    }

    // 2. The affected set, in breadth-first order from the seeds.
    const affected = new Set<string>(seeds);
    const queue = [...affected];
    const push = (n: string): void => {
      if (affected.has(n)) return;
      affected.add(n);
      queue.push(n);
    };
    const touched = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i]!;
      const kind = node[0];
      const id = node.slice(2);
      if (kind === 'j') {
        const info = ix.judgments.get(id as JudgmentId);
        if (info) push(`e:${info.rec.target}`);
        for (const k of ix.continuationsOf.get(id) ?? []) push(`j:${k}`);
        continue;
      }
      touched.add(id);
      if (kind === 'e') {
        push(`f:${id}`);
        for (const u of ix.unitsByMember.get(id) ?? []) push(`e:${u}`);
      } else if (kind === 'f') {
        push(`p:${id}`);
        for (const u of ix.unitsByMember.get(id) ?? []) push(`f:${u}`);
      } else {
        for (const j of ix.reliers.get(id) ?? []) push(`j:${j}`);
        for (const o of ix.prereqDependents.get(id) ?? []) push(`f:${o}`);
        const unit = ix.units.get(id as ProofUnitId);
        if (unit) for (const m of unit.members) push(`p:${m}`);
      }
    }
    for (const id of touched) {
      for (const op of ix.opsByTarget.get(id) ?? []) ops.add(op);
      fixTargets.add(id);
    }

    // 3. Drop and re-evaluate.
    for (const node of affected) this.d.invalidate(node);
    for (const node of affected) this.d.run(node);

    // 4. Deltas and the new snapshot.
    const prev = this.current;
    const targets = new Map<string, TargetState | undefined>();
    const judgmentCurrent = new Map<JudgmentId, boolean | undefined>();
    const positionInEffect = new Map<ReviewPosition, boolean | undefined>();
    for (const node of affected) {
      if (!node.startsWith('j:')) continue;
      const id = node.slice(2);
      if (ix.judgments.has(id as JudgmentId)) judgmentCurrent.set(id as JudgmentId, this.d.judgmentCurrent(id as JudgmentId));
    }
    const relabelled = [...touched];
    for (const id of relabelled) {
      if (ix.isTarget(id)) targets.set(id, this.d.targetState(id));
      for (const r of ix.positionsByTarget.get(id) ?? []) positionInEffect.set(reviewPosition(id, r), this.d.positionInEffect(id, r));
    }

    const basis = new Map<BasisVersionId, BasisState | undefined>();
    for (const line of lines) for (const v of ix.versionsByLine.get(line) ?? []) basis.set(v, basisState(ix, v));

    const evidenceMap = new Map<EvidenceId, boolean | undefined>();
    for (const e of evidence) if (ix.evidence.has(e)) evidenceMap.set(e, evidenceApplicable(ix, e));

    const fixes = new Map<string, FixState | undefined>();
    for (const t of fixTargets) {
      const now = this.d.fixesOf(t);
      for (const k of this.fixKeys.get(t) ?? []) if (!now.has(k)) fixes.set(k, undefined);
      for (const [k, v] of now) fixes.set(k, v);
      if (now.size > 0) this.fixKeys.set(t, new Set(now.keys()));
      else this.fixKeys.delete(t);
    }

    // Operations: sets of unproven listed targets.
    for (const op of newOps) {
      const set = new Set<string>();
      for (const o of ix.pendingOps.get(op)!.objects) if (!this.d.proven(o)) set.add(o);
      this.unproven.set(op, set);
    }
    for (const t of relabelled) {
      const proven = this.d.proven(t);
      for (const op of ix.opsByTarget.get(t) ?? []) {
        if (newOps.has(op)) continue;
        const set = this.unproven.get(op);
        if (!set) continue;
        if (proven) set.delete(t);
        else set.add(t);
        ops.add(op);
      }
    }
    const opDelta = new Map<OpId, OpState | undefined>();
    const changedOps: OpId[] = [];
    for (const op of ops) {
      const rec = ix.pendingOps.get(op);
      const set = this.unproven.get(op);
      if (!rec || !set) continue;
      const st: OpState = Object.freeze({ kind: rec.opKind, allProven: rec.objects.length > 0 && set.size === 0, executedAsOf: ix.executed.get(op) ?? null });
      const before = prev.ops.get(op);
      if (!before || before.allProven !== st.allProven || before.executedAsOf !== st.executedAsOf || before.kind !== st.kind) {
        opDelta.set(op, st);
        changedOps.push(op);
      }
    }

    // 5. Dependency cycles (5.2 part 4). A cycle is affected as a whole (every node
    // on it depends on every other, and the affected set is closed under
    // dependents), so its component lies inside the affected set, and a cycle
    // that was re-evaluated and not met again no longer exists.
    const before = new Set(this.cycleSet.keys());
    for (const [cid, nodes] of this.cycleSet) if (affected.has(nodes[0]!)) this.cycleSet.delete(cid);
    const newCycles: DependencyCycle[] = [];
    if (this.d.cycleNodes.size > 0) {
      for (const nodes of this.d.cyclicComponents(this.d.cycleNodes, (n) => affected.has(n))) {
        const cid = cycleId(nodes);
        if (!before.has(cid) && !this.cycleSet.has(cid)) newCycles.push({ id: cid, nodes });
        this.cycleSet.set(cid, nodes);
      }
    }

    this.current = Object.freeze({
      revision: at,
      basis: prev.basis.with(basis),
      evidenceApplicable: prev.evidenceApplicable.with(evidenceMap),
      judgmentCurrent: prev.judgmentCurrent.with(judgmentCurrent),
      positionInEffect: prev.positionInEffect.with(positionInEffect),
      targets: prev.targets.with(targets),
      fixes: prev.fixes.with(fixes),
      ops: prev.ops.with(opDelta),
    }) as PublishedState;
    return { state: this.current, changedOps, affected: affected.size, newCycles };
  }
}
