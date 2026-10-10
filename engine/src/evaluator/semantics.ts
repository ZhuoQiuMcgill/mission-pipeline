// Reference semantics of the derived state (design v35: 5.2–5.3, 5.6, 6.1, 8.1).
//
// `fullCompute` is the definition of "the derived state at revision R": it
// recomputes everything from the base records with revision <= R. It is the
// oracle for the incremental evaluator (incremental.ts): every published
// revision must equal fullCompute over the same records (5.5).
//
// The proof model in brief (5.2):
//   - objects carry only what is fixed with their content: identity,
//     prerequisites, scope (concrete paths), and a contract for each required
//     review position;
//   - judgments carry everything that can change: evidence, basis versions,
//     constraint checks (content version + paths reviewed), objects relied on,
//     issue responses, and what they continue or supersede;
//   - a judgment is current iff its (validly renewed) evidence is applicable,
//     its basis versions are valid, it conforms to its position's contract, a
//     continuation carries every input of the judgment it continues that it did
//     not supersede, and every object it relies on is proven;
//   - downstream depends only on objects being proven, never on a bare position;
//   - a proof unit is proven, negated or withdrawn as a whole (5.3): its state
//     combines its own positions with every member's own state, and a member is
//     never better than its unit.
//
// Least fixed point. "Proven" and "current" are conjunctive over their
// dependencies, so the state is the unique least fixed point: anything on a
// dependency cycle, and anything depending on it, does not hold. The evaluation
// is a depth-first search over judgment ("j:"), own-state ("o:") and target
// ("t:") nodes with one visiting set. A dependency met while still on the search
// path closes a cycle and is read as "does not hold"; its label then follows
// from records alone, which is also its final label. Every memoized value
// equals its least-fixed-point value whatever order nodes are evaluated in,
// which lets the incremental evaluator drop and recompute any subset. The
// search uses an explicit stack: a chain of 100,000 objects must not overflow
// the call stack.

import type {
  BasisLineId,
  BasisVersionId,
  EnvLineId,
  EnvSnapshotId,
  EvidenceId,
  IssueId,
  JudgmentId,
  ObjectVersionId,
  OpId,
  ProofUnitId,
  Revision,
} from '../common/ids.ts';
import { continuationInputsHash, decodeConstraintCheck, fixKey, reviewPosition } from '../common/records.ts';
import type {
  BasisVersionRecord,
  ConstraintCheck,
  ConstraintScope,
  EvidenceRecord,
  FixCoverageRecord,
  JudgmentRecord,
  ObjectScope,
  ObjectVersionRecord,
  PendingOpRecord,
  ProofOpKind,
  ProofUnitRecord,
  Resolved,
  ReviewContract,
  ReviewPosition,
} from '../common/records.ts';
import { renewalDecision } from './renewal.ts';

/** A committed record with its lists resolved, as the ledger read API returns it. */
export type ResolvedRecord =
  | Resolved<BasisVersionRecord>
  | { readonly kind: 'constraint.scope'; readonly line: BasisLineId; readonly scope: ConstraintScope }
  | { readonly kind: 'basis.withdrawn'; readonly line: BasisLineId }
  | { readonly kind: 'env.snapshot'; readonly line: EnvLineId; readonly snapshot: EnvSnapshotId }
  | Resolved<EvidenceRecord>
  | { readonly kind: 'evidence.revoked'; readonly evidence: EvidenceId }
  | { readonly kind: 'evidence.renewal'; readonly judgment: JudgmentId; readonly original: EvidenceId; readonly replacement: EvidenceId }
  | Resolved<ObjectVersionRecord>
  | Resolved<ProofUnitRecord>
  | Resolved<JudgmentRecord>
  | { readonly kind: 'issue'; readonly issue: IssueId; readonly module: string | null; readonly observedOn: readonly string[] }
  | Resolved<FixCoverageRecord>
  | Resolved<PendingOpRecord>
  | { readonly kind: 'op.executed'; readonly op: OpId; readonly asOf: Revision };

export interface ResolvedCommitted {
  readonly revision: Revision;
  readonly record: ResolvedRecord;
}

// ---------------------------------------------------------------- outputs

export type BasisState = 'valid' | 'revised' | 'withdrawn';
export type Conclusion = 'unaccepted' | 'passed' | 'negated';
/** Display label, in priority order (5.3). */
export type Label = 'negated' | 'basis-withdrawn' | 'unaccepted' | 'not-fully-proven' | 'proven';
export const LABEL_RANK: Readonly<Record<Label, number>> = Object.freeze({
  negated: 0,
  'basis-withdrawn': 1,
  unaccepted: 2,
  'not-fully-proven': 3,
  proven: 4,
});
export type FixState = 'fixed' | 'fixed-not-fully-proven' | 'unfixed';

export interface TargetState {
  readonly conclusion: Conclusion;
  /** Every required review position is in effect. */
  readonly inEffect: boolean;
  readonly fresh: boolean;
  readonly label: Label;
}

export interface OpState {
  readonly kind: ProofOpKind;
  readonly allProven: boolean;
  readonly executedAsOf: Revision | null;
}

export interface DerivedState {
  readonly revision: Revision;
  readonly basis: ReadonlyMap<BasisVersionId, BasisState>;
  readonly evidenceApplicable: ReadonlyMap<EvidenceId, boolean>;
  /** Every recorded judgment. */
  readonly judgmentCurrent: ReadonlyMap<JudgmentId, boolean>;
  /**
   * Review positions with at least one judgment: is the deciding judgment a
   * current pass? Diagnostic only: used for the target's own proof and never as
   * a dependency of anything downstream.
   */
  readonly positionInEffect: ReadonlyMap<ReviewPosition, boolean>;
  /** Every recorded object and proof unit. */
  readonly targets: ReadonlyMap<string, TargetState>;
  /** Key fixKey(issue, version) (a JSON pair): versions with a regression run registered for the issue or a deciding response to it (5.6). */
  readonly fixes: ReadonlyMap<string, FixState>;
  readonly ops: ReadonlyMap<OpId, OpState>;
}

export function worse(a: Label, b: Label): Label {
  return LABEL_RANK[a] <= LABEL_RANK[b] ? a : b;
}

function worseConclusion(a: Conclusion, b: Conclusion): Conclusion {
  if (a === 'negated' || b === 'negated') return 'negated';
  if (a === 'unaccepted' || b === 'unaccepted') return 'unaccepted';
  return 'passed';
}

// ---------------------------------------------------------------- constraint scopes

/** Does a constraint path pattern match a path? Exact, "dir/**" prefix, or "**". */
export function pathMatches(pattern: string, path: string): boolean {
  if (pattern === '**') return true;
  if (pattern.endsWith('/**')) {
    const dir = pattern.slice(0, -3);
    return path === dir || path.startsWith(dir + '/');
  }
  return pattern === path;
}

export function constraintApplies(scope: ConstraintScope, obj: ObjectScope): boolean {
  return requiredRange(scope, obj).length > 0;
}

/** v33 5.2: the constraint's required range on an object: the object's paths inside its current scope. */
export function requiredRange(scope: ConstraintScope, obj: ObjectScope): string[] {
  if (scope.taskTypes.length > 0 && !scope.taskTypes.includes(obj.taskType)) return [];
  return obj.paths.filter((p) => scope.paths.some((pat) => pathMatches(pat, p)));
}

/** The patterns that can match `path`: itself, each ancestor (and itself) as "dir/**", and "**". */
function candidatePatterns(path: string): string[] {
  const out = [path, '**', `${path}/**`];
  let i = path.lastIndexOf('/');
  while (i > 0) {
    out.push(`${path.slice(0, i)}/**`);
    i = path.lastIndexOf('/', i - 1);
  }
  return out;
}

// ---------------------------------------------------------------- index of the base records

export interface JudgmentInfo {
  readonly rev: Revision;
  readonly rec: Resolved<JudgmentRecord>;
}

export interface ConstraintLine {
  /** The current content version. */
  latest: BasisVersionId;
  /** The current scope; a scope change alone does not create a content version (v30 9.5). */
  scope: ConstraintScope | null;
}

export interface RegressionRun {
  readonly evidence: EvidenceId;
  readonly command: string;
  readonly tests: readonly string[];
  readonly inputs: readonly string[];
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

function removeFrom<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

/**
 * The base records, indexed. Besides the forward lookups the rules need, it
 * keeps reverse indexes ("who depends on this?") for the incremental evaluator;
 * they are keyed by id string, so a record may name an id before its own record
 * arrives. A fact with an identity is taken from its first record; a later
 * record with the same identity is ignored (the ledger refuses those anyway).
 */
export class Index {
  basisLatest = new Map<BasisLineId, BasisVersionId>();
  basisLineOf = new Map<BasisVersionId, BasisLineId>();
  basisKindOf = new Map<BasisVersionId, string>();
  versionsByLine = new Map<BasisLineId, Set<BasisVersionId>>();
  withdrawn = new Set<BasisLineId>();
  /** Object constraints only (v34: execution instructions are never proof obligations). */
  constraints = new Map<BasisLineId, ConstraintLine>();
  /** pattern -> constraint lines whose current scope contains it. */
  constraintsByPattern = new Map<string, Set<BasisLineId>>();
  envCurrent = new Map<EnvLineId, EnvSnapshotId>();
  evidence = new Map<EvidenceId, Resolved<EvidenceRecord>>();
  evidenceByEnvLine = new Map<EnvLineId, Set<EvidenceId>>();
  revoked = new Set<EvidenceId>();
  /** (judgment, original evidence) -> renewals in revision order; the latest one before a revision wins. */
  renewal = new Map<string, Array<{ readonly rev: Revision; readonly replacement: EvidenceId }>>();
  objects = new Map<ObjectVersionId, Resolved<ObjectVersionRecord>>();
  /** exact path -> objects with that path; directory -> objects with a path under it. */
  objectsByPath = new Map<string, Set<ObjectVersionId>>();
  objectsUnderDir = new Map<string, Set<ObjectVersionId>>();
  units = new Map<ProofUnitId, Resolved<ProofUnitRecord>>();
  /** member -> the latest unit that lists it. */
  unitOf = new Map<ObjectVersionId, ProofUnitId>();
  judgments = new Map<JudgmentId, JudgmentInfo>();
  /** position -> judgments in revision order. */
  byPosition = new Map<ReviewPosition, JudgmentInfo[]>();
  /** target -> review kinds that have judgments. */
  positionsByTarget = new Map<string, Set<string>>();
  /** fixKey(issue, version) -> registered regression runs. */
  regression = new Map<string, RegressionRun[]>();
  regressionIssuesByTarget = new Map<string, Set<IssueId>>();
  pendingOps = new Map<OpId, Resolved<PendingOpRecord>>();
  executed = new Map<OpId, Revision>();

  // Revisions, for checks "as the records stood before revision R" (a continuation's acceptance, r3 F1).
  basisRev = new Map<BasisVersionId, Revision>();
  /** line -> its first withdrawal. */
  withdrawnRev = new Map<BasisLineId, Revision>();
  /** line -> its snapshots in revision order. */
  envHistory = new Map<EnvLineId, Array<{ readonly rev: Revision; readonly snapshot: EnvSnapshotId }>>();
  evidenceRev = new Map<EvidenceId, Revision>();
  /** evidence -> its first revocation. */
  revokedRev = new Map<EvidenceId, Revision>();

  // Reverse indexes.
  judgmentsByEvidence = new Map<string, Set<JudgmentId>>();
  judgmentsByBasisVersion = new Map<string, Set<JudgmentId>>();
  judgmentsByTarget = new Map<string, Set<JudgmentId>>();
  /** J0 -> continuations naming it (their structural check reads J0's inputs). */
  continuationsOf = new Map<string, Set<JudgmentId>>();
  reliers = new Map<string, Set<JudgmentId>>();
  prereqDependents = new Map<string, Set<ObjectVersionId>>();
  unitsByMember = new Map<string, Set<ProofUnitId>>();
  opsByTarget = new Map<string, Set<OpId>>();
  regressionTargetsByEvidence = new Map<string, Set<string>>();

  private readonly checks = new Map<string, ConstraintCheck | null>();

  /** Index one record. Returns false when it was ignored (a duplicate identity). */
  add(c: ResolvedCommitted): boolean {
    const r = c.record;
    switch (r.kind) {
      case 'basis.version':
        if (this.basisLineOf.has(r.version)) return false;
        this.basisLatest.set(r.line, r.version);
        this.basisLineOf.set(r.version, r.line);
        this.basisRev.set(r.version, c.revision);
        this.basisKindOf.set(r.version, r.basisKind);
        addTo(this.versionsByLine, r.line, r.version);
        if (r.basisKind === 'constraint') {
          // A new content version keeps the current scope unless it states one.
          const prev = this.constraints.get(r.line);
          this.setConstraint(r.line, r.version, r.scope ?? prev?.scope ?? null);
        }
        return true;
      case 'constraint.scope': {
        const prev = this.constraints.get(r.line);
        if (prev) this.setConstraint(r.line, prev.latest, r.scope);
        return true;
      }
      case 'basis.withdrawn':
        this.withdrawn.add(r.line);
        if (!this.withdrawnRev.has(r.line)) this.withdrawnRev.set(r.line, c.revision);
        return true;
      case 'env.snapshot': {
        this.envCurrent.set(r.line, r.snapshot);
        let h = this.envHistory.get(r.line);
        if (!h) this.envHistory.set(r.line, (h = []));
        h.push({ rev: c.revision, snapshot: r.snapshot });
        return true;
      }
      case 'evidence':
        if (this.evidence.has(r.evidence)) return false;
        this.evidence.set(r.evidence, r);
        this.evidenceRev.set(r.evidence, c.revision);
        addTo(this.evidenceByEnvLine, r.envLine, r.evidence);
        return true;
      case 'evidence.revoked':
        this.revoked.add(r.evidence);
        if (!this.revokedRev.has(r.evidence)) this.revokedRev.set(r.evidence, c.revision);
        return true;
      case 'evidence.renewal': {
        const key = JSON.stringify([r.judgment, r.original]);
        let list = this.renewal.get(key);
        if (!list) this.renewal.set(key, (list = []));
        list.push({ rev: c.revision, replacement: r.replacement });
        addTo(this.judgmentsByEvidence, r.replacement, r.judgment);
        addTo(this.judgmentsByEvidence, r.original, r.judgment);
        return true;
      }
      case 'object.version':
        if (this.objects.has(r.object)) return false;
        this.objects.set(r.object, r);
        for (const p of r.prerequisites) addTo(this.prereqDependents, p, r.object);
        for (const p of r.scope.paths) {
          addTo(this.objectsByPath, p, r.object);
          let i = p.lastIndexOf('/');
          while (i > 0) {
            addTo(this.objectsUnderDir, p.slice(0, i), r.object);
            i = p.lastIndexOf('/', i - 1);
          }
        }
        return true;
      case 'proof.unit':
        if (this.units.has(r.unit)) return false;
        this.units.set(r.unit, r);
        for (const m of r.members) {
          this.unitOf.set(m as ObjectVersionId, r.unit);
          addTo(this.unitsByMember, m, r.unit);
        }
        return true;
      case 'judgment': {
        if (this.judgments.has(r.judgment)) return false;
        const info: JudgmentInfo = { rev: c.revision, rec: r };
        this.judgments.set(r.judgment, info);
        const pos = reviewPosition(r.target, r.review);
        let list = this.byPosition.get(pos);
        if (!list) this.byPosition.set(pos, (list = []));
        list.push(info);
        addTo(this.positionsByTarget, r.target, r.review);
        addTo(this.judgmentsByTarget, r.target, r.judgment);
        for (const e of r.evidence) addTo(this.judgmentsByEvidence, e, r.judgment);
        for (const b of r.bases) addTo(this.judgmentsByBasisVersion, b, r.judgment);
        for (const o of r.reliesOn) addTo(this.reliers, o, r.judgment);
        if (r.extends !== null) addTo(this.continuationsOf, r.extends, r.judgment);
        return true;
      }
      case 'issue':
        return true;
      case 'issue.coverage': {
        const key = fixKey(r.issue, r.version);
        let list = this.regression.get(key);
        if (!list) this.regression.set(key, (list = []));
        list.push({ evidence: r.evidence, command: r.command, tests: r.tests, inputs: r.inputs });
        addTo(this.regressionIssuesByTarget, r.version, r.issue);
        addTo(this.regressionTargetsByEvidence, r.evidence, r.version);
        return true;
      }
      case 'op.pending':
        if (this.pendingOps.has(r.op)) return false;
        this.pendingOps.set(r.op, r);
        for (const o of r.objects) addTo(this.opsByTarget, o, r.op);
        return true;
      case 'op.executed':
        if (this.executed.has(r.op)) return false;
        this.executed.set(r.op, r.asOf);
        return true;
    }
  }

  private setConstraint(line: BasisLineId, latest: BasisVersionId, scope: ConstraintScope | null): void {
    const prev = this.constraints.get(line);
    for (const pat of prev?.scope?.paths ?? []) removeFrom(this.constraintsByPattern, pat, line);
    this.constraints.set(line, { latest, scope });
    for (const pat of scope?.paths ?? []) addTo(this.constraintsByPattern, pat, line);
  }

  /** Object constraint lines whose current scope can match one of the object's paths. */
  constraintsFor(scope: ObjectScope): Set<BasisLineId> {
    const out = new Set<BasisLineId>();
    for (const p of scope.paths) for (const pat of candidatePatterns(p)) for (const l of this.constraintsByPattern.get(pat) ?? []) out.add(l);
    return out;
  }

  /** Objects one of whose paths a constraint scope matches (before task-type filtering). */
  objectsMatching(scope: ConstraintScope): Set<ObjectVersionId> {
    const out = new Set<ObjectVersionId>();
    for (const pat of scope.paths) {
      if (pat === '**') {
        for (const o of this.objects.keys()) out.add(o);
        return out;
      }
      if (pat.endsWith('/**')) {
        const dir = pat.slice(0, -3);
        for (const o of this.objectsByPath.get(dir) ?? []) out.add(o);
        for (const o of this.objectsUnderDir.get(dir) ?? []) out.add(o);
      } else {
        for (const o of this.objectsByPath.get(pat) ?? []) out.add(o);
      }
    }
    return out;
  }

  /** A decoded constraint check; a malformed entry covers nothing. */
  check(enc: string): ConstraintCheck | null {
    let c = this.checks.get(enc);
    if (c === undefined) {
      try {
        c = decodeConstraintCheck(enc);
      } catch {
        c = null;
      }
      this.checks.set(enc, c);
    }
    return c;
  }

  /** The review contracts of an object or proof unit, or null for an unknown target. */
  contracts(target: string): readonly ReviewContract[] | null {
    return (this.objects.get(target as ObjectVersionId) ?? this.units.get(target as ProofUnitId))?.reviews ?? null;
  }

  isTarget(target: string): boolean {
    return this.objects.has(target as ObjectVersionId) || this.units.has(target as ProofUnitId);
  }
}

// ---------------------------------------------------------------- leaf rules (records only)

export function basisState(ix: Index, v: BasisVersionId): BasisState {
  const line = ix.basisLineOf.get(v);
  if (line === undefined) return 'withdrawn'; // an unknown basis can never be valid
  if (ix.withdrawn.has(line)) return 'withdrawn';
  return ix.basisLatest.get(line) === v ? 'valid' : 'revised';
}

/** Constraint and instruction versions are not bases of currency: constraints count only through coverage. */
const isConstraintKind = (ix: Index, v: string): boolean => {
  const k = ix.basisKindOf.get(v as BasisVersionId);
  return k === 'constraint' || k === 'instruction';
};

/** 5.2: applicable iff bound to the current snapshot of its environment line and not revoked. */
export function evidenceApplicable(ix: Index, e: EvidenceId): boolean {
  const ev = ix.evidence.get(e);
  if (!ev || ix.revoked.has(e)) return false;
  return ix.envCurrent.get(ev.envLine) === ev.envSnapshot;
}

/**
 * The evidence a judgment relies on in place of `e`, following valid renewals
 * only (5.3), among those recorded before `beforeRev`: from each evidence, the
 * latest renewal that passes the renewal rule against the judgment's declared
 * evidence use. An invalid renewal is skipped, so it never hides an older valid
 * one (core review r3 F14); a renewal back to an evidence already on the chain
 * is skipped too.
 */
function effectiveEvidence(ix: Index, j: Resolved<JudgmentRecord>, e: EvidenceId, beforeRev: number = Infinity): EvidenceId {
  let cur = e;
  const seen = new Set<EvidenceId>([e]);
  for (;;) {
    const list = ix.renewal.get(JSON.stringify([j.judgment, cur])) ?? [];
    const a = ix.evidence.get(cur);
    let next: EvidenceId | undefined;
    for (let i = list.length - 1; i >= 0 && a !== undefined; i--) {
      const r = list[i]!;
      if (r.rev >= beforeRev || seen.has(r.replacement)) continue;
      const b = ix.evidence.get(r.replacement);
      if (!b || (ix.evidenceRev.get(r.replacement) ?? Infinity) >= beforeRev) continue;
      if (renewalDecision(a, b, j.evidenceUse).renew) {
        next = r.replacement;
        break;
      }
    }
    if (next === undefined) return cur;
    seen.add(next);
    cur = next;
  }
}

/** The snapshot of an environment line as it stood before `beforeRev`. */
function envSnapshotBefore(ix: Index, line: EnvLineId, beforeRev: number): EnvSnapshotId | undefined {
  const h = ix.envHistory.get(line);
  if (!h) return undefined;
  for (let i = h.length - 1; i >= 0; i--) if (h[i]!.rev < beforeRev) return h[i]!.snapshot;
  return undefined;
}

/** 5.2 evidence applicability as the records stood before `beforeRev`. */
function evidenceApplicableBefore(ix: Index, e: EvidenceId, beforeRev: number): boolean {
  const ev = ix.evidence.get(e);
  if (!ev || (ix.evidenceRev.get(e) ?? Infinity) >= beforeRev) return false;
  if ((ix.revokedRev.get(e) ?? Infinity) < beforeRev) return false;
  return envSnapshotBefore(ix, ev.envLine, beforeRev) === ev.envSnapshot;
}

type PositionState = { readonly state: 'none' } | { readonly state: 'pass' | 'fail' | 'undecided'; readonly by: JudgmentInfo };

/**
 * v30 5.2: the state of one review position. A negation stands until a later
 * pass on the same position names it in `revokes`; a pass that does not name
 * it, and any Auditor-executed judgment, do not revoke it. A later negation
 * replaces an earlier one. Outside a negation the latest judgment decides;
 * revoking a pass is a later negation or undecided judgment on the position.
 */
function positionState(ix: Index, target: string, review: string, beforeRev: number = Infinity): PositionState {
  let st: PositionState = { state: 'none' };
  for (const j of ix.byPosition.get(reviewPosition(target, review)) ?? []) {
    if (j.rev >= beforeRev) break;
    if (st.state === 'fail') {
      const revokes = j.rec.verdict === 'pass' && j.rec.executor !== 'auditor' && j.rec.revokes === st.by.rec.judgment;
      if (revokes) st = { state: 'pass', by: j };
      else if (j.rec.verdict === 'fail') st = { state: 'fail', by: j };
    } else {
      st = { state: j.rec.verdict, by: j };
    }
  }
  return st;
}

/**
 * v30 5.2: a judgment conforms to its position's contract iff it binds a version
 * of every basis line the contract names and relies on every object the contract
 * names. The executor does not matter: an Auditor is held to the same contract.
 * A judgment on a position the target does not require has no contract and
 * never conforms.
 */
function conforms(ix: Index, j: Resolved<JudgmentRecord>): boolean {
  const contract = ix.contracts(j.target)?.find((c) => c.review === j.review);
  if (!contract) return false;
  const boundLines = new Set<BasisLineId>();
  for (const b of j.bases) {
    const line = ix.basisLineOf.get(b as BasisVersionId);
    if (line !== undefined) boundLines.add(line);
  }
  if (!contract.basisLines.every((l) => boundLines.has(l))) return false;
  const relied = new Set<string>(j.reliesOn);
  return contract.reliesOn.every((o) => relied.has(o));
}

/**
 * v32 5.2 part 5, enforced structurally (core review r1 #12, r2 F4, r3 F1). A
 * continuation is judged by the records as they stood when it was recorded,
 * never by later ones:
 *   - J0 existed then, has the same review kind, and was then the deciding pass
 *     of its position (condition 1);
 *   - J's target is J0's target or that target's successor (`predecessor`);
 *   - condition 2: J0 was current then, apart from what the batch changes. The
 *     batch's changes are, by definition, every basis line J0 binds whose version
 *     was revised; everything else had to hold: J0's evidence in force (after
 *     the valid renewals recorded before J) applicable, no basis line of J0
 *     withdrawn, J0 conforming to its contract, and J0 itself a valid
 *     continuation if it is one. The objects J0 relies on are J's own reliances
 *     (J carries them), so they count through J's own currency;
 *   - J carries every validity input of J0 as of J's revision, and for evidence
 *     that is the evidence in force after renewals, not a renewed original
 *     (5.2: "按续期替换后的当前证据计"), except inputs J superseded with a
 *     replacement of the same kind that it carries.
 * After acceptance only J's own conditions matter: a later renewal or a later
 * negation of J0 does not change whether J is a valid continuation.
 */
function continuationCarries(ix: Index, info: JudgmentInfo): boolean {
  const j = info.rec;
  if (j.extends === null) return j.superseded.length === 0;
  const j0info = ix.judgments.get(j.extends);
  if (!j0info || j0info.rev >= info.rev) return false;
  const j0 = j0info.rec;
  if (j0.review !== j.review || j0.judgment === j.judgment) return false;
  const sameLine = j0.target === j.target || ix.objects.get(j.target as ObjectVersionId)?.predecessor === j0.target;
  if (!sameLine) return false;
  const then = positionState(ix, j0.target, j0.review, info.rev);
  if (then.state !== 'pass' || then.by.rec.judgment !== j0.judgment) return false;
  if (!currentOutsideChangesBefore(ix, j0info, info.rev)) return false;
  const sup = new Map<string, string>();
  for (const x of j.superseded) sup.set(x.input, x.by);
  const ev = new Set(j.evidence);
  const rel = new Set(j.reliesOn);
  const con = new Set(j.constraints);
  const lines = new Set<string>();
  for (const b of j.bases) lines.add(ix.basisLineOf.get(b as BasisVersionId) ?? `?${b}`);
  const carried = (input: string, own: Set<string>): boolean => {
    if (own.has(input)) return true;
    const by = sup.get(input);
    return by !== undefined && own.has(by);
  };
  const j0ev = new Set<string>();
  for (const e of j0.evidence) {
    const eff = effectiveEvidence(ix, j0, e as EvidenceId, info.rev);
    j0ev.add(e);
    j0ev.add(eff);
    // The evidence in force must be carried (or replaced); carrying a renewed original does not count.
    const replaced = (x: string): boolean => sup.has(x) && ev.has(sup.get(x)!);
    if (!carried(eff, ev) && !replaced(e)) return false;
  }
  for (const o of j0.reliesOn) if (!carried(o, rel)) return false;
  for (const c of j0.constraints) if (!carried(c, con)) return false;
  for (const b of j0.bases) {
    const line = ix.basisLineOf.get(b as BasisVersionId) ?? `?${b}`;
    if (lines.has(line)) continue;
    const by = sup.get(b);
    if (by === undefined || !lines.has(ix.basisLineOf.get(by as BasisVersionId) ?? `?${by}`)) return false;
  }
  // Every superseded entry names an input of J0, replaced by an input of the same kind.
  for (const x of j.superseded) {
    if (j0ev.has(x.input)) {
      if (!ev.has(x.by)) return false;
    } else if (j0.reliesOn.includes(x.input)) {
      if (!rel.has(x.by)) return false;
    } else if (j0.constraints.includes(x.input)) {
      if (!con.has(x.by)) return false;
    } else if (j0.bases.includes(x.input)) {
      if (!j.bases.includes(x.by)) return false;
    } else return false;
  }
  return true;
}

/**
 * Condition 2 of a continuation, as the records stood before `beforeRev`: the
 * record-level conditions of J0's currency hold, where a basis line whose bound
 * version was revised counts as part of the batch (only a withdrawn line, or a
 * version not recorded yet, fails).
 */
function currentOutsideChangesBefore(ix: Index, info: JudgmentInfo, beforeRev: number): boolean {
  const rec = info.rec;
  for (const e of rec.evidence) if (!evidenceApplicableBefore(ix, effectiveEvidence(ix, rec, e as EvidenceId, beforeRev), beforeRev)) return false;
  for (const b of rec.bases) {
    if (isConstraintKind(ix, b)) continue;
    const line = ix.basisLineOf.get(b as BasisVersionId);
    if (line === undefined || (ix.basisRev.get(b as BasisVersionId) ?? Infinity) >= beforeRev) return false;
    if ((ix.withdrawnRev.get(line) ?? Infinity) < beforeRev) return false;
  }
  return conforms(ix, rec) && continuationCarries(ix, info);
}

/**
 * Everything about a judgment's currency that does not depend on other derived
 * values. `assumeValid`: basis lines to treat as valid (the continuation check
 * asks "is J0 current if this batch's changes count as reviewed?").
 */
function judgmentLeavesOk(ix: Index, info: JudgmentInfo, assumeValid: ReadonlySet<string> = EMPTY): boolean {
  const rec = info.rec;
  for (const e of rec.evidence) if (!evidenceApplicable(ix, effectiveEvidence(ix, rec, e as EvidenceId))) return false;
  for (const b of rec.bases) {
    if (isConstraintKind(ix, b)) continue;
    const line = ix.basisLineOf.get(b as BasisVersionId);
    if (line !== undefined && assumeValid.has(line) && !ix.withdrawn.has(line)) continue;
    if (basisState(ix, b as BasisVersionId) !== 'valid') return false;
  }
  return conforms(ix, rec) && continuationCarries(ix, info);
}

const EMPTY: ReadonlySet<string> = new Set();

function composite(ix: Index, target: string, reviews: readonly ReviewContract[]): { conclusion: Conclusion; deciding: JudgmentInfo[]; all: JudgmentInfo[] } {
  if (reviews.length === 0) return { conclusion: 'unaccepted', deciding: [], all: [] };
  const states = reviews.map((c) => positionState(ix, target, c.review));
  const all = states.flatMap((s) => (s.state === 'none' ? [] : [s.by]));
  if (states.some((s) => s.state === 'fail')) return { conclusion: 'negated', deciding: [], all };
  if (states.every((s) => s.state === 'pass')) return { conclusion: 'passed', deciding: states.map((s) => (s as { by: JudgmentInfo }).by), all };
  return { conclusion: 'unaccepted', deciding: [], all };
}

/**
 * v33 5.2 constraint coverage: for every object constraint that currently
 * applies (by its current scope, not withdrawn), its required range on the
 * target is covered by the union of the paths the deciding judgments reviewed
 * against its current content version.
 */
function covered(ix: Index, scopes: readonly ObjectScope[], deciding: readonly JudgmentInfo[]): boolean {
  const reviewed = new Map<string, Set<string>>(); // content version -> paths reviewed
  for (const d of deciding) {
    for (const enc of d.rec.constraints) {
      const c = ix.check(enc);
      if (!c) continue;
      let set = reviewed.get(c.version);
      if (!set) reviewed.set(c.version, (set = new Set()));
      for (const p of c.paths) set.add(p);
    }
  }
  for (const s of scopes) {
    for (const line of ix.constraintsFor(s)) {
      const c = ix.constraints.get(line)!;
      if (ix.withdrawn.has(line) || c.scope === null) continue;
      const have = reviewed.get(c.latest);
      for (const p of requiredRange(c.scope, s)) if (!have?.has(p)) return false;
    }
  }
  return true;
}

/** 5.3 label priority. A deciding judgment of any verdict whose basis line was withdrawn gives "basis-withdrawn". */
function basisWithdrawnIn(ix: Index, deciding: readonly JudgmentInfo[]): boolean {
  return deciding.some((d) => d.rec.bases.some((b) => !isConstraintKind(ix, b) && basisState(ix, b as BasisVersionId) === 'withdrawn'));
}


export const NOT_PROVEN: TargetState = Object.freeze({ conclusion: 'unaccepted', inEffect: false, fresh: false, label: 'unaccepted' });

/** An object's own structure (its own positions, prerequisites outside its unit, coverage). */
interface OwnStructure {
  readonly conclusion: Conclusion;
  readonly deciding: readonly JudgmentInfo[];
  readonly prereqs: readonly string[];
  readonly coverageOk: boolean;
  readonly basisWithdrawn: boolean;
}

function ownStructure(ix: Index, x: string): OwnStructure | null {
  const o = ix.objects.get(x as ObjectVersionId);
  if (!o) return null;
  const myUnit = ix.unitOf.get(o.object);
  const coMembers = new Set<string>(myUnit ? (ix.units.get(myUnit)?.members ?? []) : []);
  const comp = composite(ix, x, o.reviews);
  return {
    conclusion: comp.conclusion,
    deciding: comp.deciding,
    prereqs: o.prerequisites.filter((p) => !coMembers.has(p)),
    // A path that is not concrete cannot be matched against constraint scopes, so coverage cannot hold (core review r2 F8).
    coverageOk: o.scope.paths.every((p) => !p.includes('*')) && covered(ix, [o.scope], comp.deciding),
    basisWithdrawn: basisWithdrawnIn(ix, comp.all),
  };
}

/** A unit's structure: its own positions combined with every member's own state (5.3). */
interface UnitStructure {
  /** Combined over the unit's positions and the members' own conclusions. */
  readonly conclusion: Conclusion;
  /** The unit's own positions all pass. */
  readonly ownPassed: boolean;
  readonly deciding: readonly JudgmentInfo[];
  readonly members: readonly string[];
  readonly recordsOk: boolean;
  readonly basisWithdrawn: boolean;
}

function unitStructure(ix: Index, u: string): UnitStructure | null {
  const unit = ix.units.get(u as ProofUnitId);
  if (!unit) return null;
  const comp = composite(ix, u, unit.reviews);
  let conclusion = comp.conclusion;
  let bw = basisWithdrawnIn(ix, comp.all);
  let recordsOk = unit.members.length > 0;
  const scopes: ObjectScope[] = [];
  const decidingAll: JudgmentInfo[] = [...comp.deciding];
  for (const m of unit.members) {
    const own = ownStructure(ix, m);
    if (!own) {
      recordsOk = false;
      conclusion = worseConclusion(conclusion, 'unaccepted');
      continue;
    }
    conclusion = worseConclusion(conclusion, own.conclusion);
    if (own.basisWithdrawn) bw = true;
    scopes.push(ix.objects.get(m as ObjectVersionId)!.scope);
    decidingAll.push(...own.deciding);
  }
  // Coverage of the whole unit: the union over the unit's and its members' deciding judgments.
  if (!covered(ix, scopes, decidingAll)) recordsOk = false;
  return { conclusion, ownPassed: comp.conclusion === 'passed', deciding: comp.deciding, members: unit.members, recordsOk, basisWithdrawn: bw };
}

// ---------------------------------------------------------------- continuation judgments (v32 5.2 part 5)

/**
 * The hash a continuation judgment's validity inputs must match (core review
 * r3 F1), defined once in records.ts (each list as a set, the four together):
 * the evaluator returns it with a passing check (`inputsHash`), and the ledger
 * refuses a continuation whose own lists hash otherwise.
 */
export { continuationInputsHash };

export interface ContinuationRequest {
  /** J0, the judgment being continued. */
  readonly extends: JudgmentId;
  /** The new judgment's target: J0's target or its successor (an object whose `predecessor` is J0's target). */
  readonly target: string;
  /** The review kind of the new judgment (must equal J0's). */
  readonly review: string;
  /** Basis lines changed in this batch, including the requirement-set line when items were added or removed. */
  readonly changedLines: readonly BasisLineId[];
  /** What the seat's new judgment itself carries. */
  readonly draft: {
    readonly evidence: readonly string[];
    readonly bases: readonly string[];
    readonly constraints: readonly string[];
    readonly reliesOn: readonly string[];
  };
  /** Inputs of J0 the seat re-reviewed and replaced; `by` must be among the draft's inputs of the same kind. */
  readonly superseded: readonly { readonly input: string; readonly by: string }[];
}

/** One evidence a deciding judgment rests on (5.2), after valid renewals (5.3). */
export interface DecidingEvidence {
  /** As the judgment names it. */
  readonly original: EvidenceId;
  /** The evidence in force after valid renewals. */
  readonly effective: EvidenceId;
  readonly applicable: boolean;
  /** The effective evidence's record, or null when it is not recorded. */
  readonly record: {
    readonly envLine: EnvLineId;
    readonly envSnapshot: EnvSnapshotId;
    readonly runClass: EvidenceRecord['runClass'];
    readonly fields: Readonly<Record<string, string>>;
  } | null;
}

/**
 * What decides a target's proof (5.2, 5.3): every required review position
 * with its state and deciding judgment, and the deciding judgments (present
 * only when every required position passes) with their evidence in force.
 * Delivery reads this instead of re-deriving the rules (6.6).
 */
export interface DecidingView {
  readonly kind: 'object' | 'unit';
  readonly conclusion: Conclusion;
  readonly label: Label;
  readonly inEffect: boolean;
  readonly fresh: boolean;
  readonly positions: readonly { readonly review: string; readonly state: 'none' | 'pass' | 'fail' | 'undecided'; readonly by: JudgmentId | null }[];
  readonly deciding: readonly {
    readonly judgment: JudgmentId;
    readonly review: string;
    readonly executor: string;
    readonly current: boolean;
    readonly evidence: readonly DecidingEvidence[];
  }[];
}

export type ContinuationResult =
  | {
      readonly ok: true;
      readonly merged: { readonly evidence: string[]; readonly bases: string[]; readonly constraints: string[]; readonly reliesOn: string[] };
      /** continuationInputsHash(merged): the continuation judgment's four lists must hash to it (the ledger checks, r3 F1). */
      readonly inputsHash: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'unknown-judgment'
        | 'different-review'
        | 'different-line'
        | 'not-deciding-pass'
        | 'not-current-outside-changes'
        | 'replacement-missing'
        | 'not-an-input'
        | 'inherited-input-invalid';
    };

// ---------------------------------------------------------------- the derivation (least fixed point)

function labelOf(conclusion: Conclusion, basisWithdrawn: boolean, fresh: boolean): Label {
  if (conclusion === 'negated') return 'negated';
  if (basisWithdrawn) return 'basis-withdrawn';
  if (conclusion === 'unaccepted') return 'unaccepted';
  return fresh ? 'proven' : 'not-fully-proven';
}

/**
 * Memoized evaluation of the derivation's boolean facts, each a conjunction of
 * other facts and record-only conditions (so each is a monotone Horn rule and
 * the least fixed point is computed per fact):
 *   j:J  judgment current      = leaves(J) and every relied-on target proven
 *   e:X  positions in effect   = X's own positions all pass and every deciding
 *                                judgment is current (a unit also needs every
 *                                member's e:)
 *   f:X  fresh                 = e:X and coverage and every prerequisite proven
 *                                (a unit: e:U, its records, every member's f:)
 *   p:X  proven                = conclusion passed, no basis withdrawn, f:X (a
 *                                member also needs its unit proven)
 * A fact read while it is still on the search path closes a cycle and reads as
 * false. Displayed states (labels, conclusions) are assembled from final facts
 * and records only after the facts are computed, never copied from a value read
 * across a cycle, so every published value is independent of evaluation order.
 * `invalidate` drops a memo entry; the incremental evaluator drops everything
 * that may depend on a changed record and evaluates it again.
 */
export class Derivation {
  readonly current = new Map<JudgmentId, boolean>();
  readonly effect = new Map<string, boolean>();
  readonly freshness = new Map<string, boolean>();
  readonly provenness = new Map<string, boolean>();
  private readonly visiting = new Set<string>();
  private readonly ix: Index;

  constructor(ix: Index) {
    this.ix = ix;
  }

  private memo(kind: string): Map<string, boolean> {
    switch (kind) {
      case 'j':
        return this.current as Map<string, boolean>;
      case 'e':
        return this.effect;
      case 'f':
        return this.freshness;
      default:
        return this.provenness;
    }
  }

  private fact(node: string): boolean {
    this.run(node);
    return this.memo(node[0]!).get(node.slice(2)) ?? false;
  }

  judgmentCurrent(j: JudgmentId): boolean {
    return this.fact(`j:${j}`);
  }

  proven(t: string): boolean {
    return this.fact(`p:${t}`);
  }

  /** The displayed state of an object or unit, assembled from final facts. */
  targetState(t: string): TargetState {
    const u = unitStructure(this.ix, t);
    if (u) {
      const inEffect = this.fact(`e:${t}`);
      const fresh = this.fact(`f:${t}`);
      return Object.freeze({ conclusion: u.conclusion, inEffect, fresh, label: labelOf(u.conclusion, u.basisWithdrawn, fresh) });
    }
    const s = ownStructure(this.ix, t);
    if (!s) return NOT_PROVEN;
    const inEffect = this.fact(`e:${t}`);
    const fresh = this.fact(`f:${t}`);
    let label = labelOf(s.conclusion, s.basisWithdrawn, fresh);
    const myUnit = this.ix.unitOf.get(t as ObjectVersionId);
    if (myUnit) label = worse(label, this.targetState(myUnit).label);
    return Object.freeze({ conclusion: s.conclusion, inEffect, fresh, label });
  }

  invalidate(node: string): void {
    this.memo(node[0]!).delete(node.slice(2));
  }

  private memoized(node: string): boolean {
    return this.memo(node[0]!).has(node.slice(2));
  }

  /** Evaluate `root` and everything it needs, depth first with an explicit stack. */
  run(root: string): void {
    if (this.memoized(root)) return;
    const stack: { node: string; post: boolean }[] = [{ node: root, post: false }];
    while (stack.length > 0) {
      const { node, post } = stack.pop()!;
      if (post) {
        this.memo(node[0]!).set(node.slice(2), this.combine(node));
        this.visiting.delete(node);
        continue;
      }
      if (this.memoized(node) || this.visiting.has(node)) continue;
      if (node.startsWith('j:') && !this.ix.judgments.has(node.slice(2) as JudgmentId)) continue;
      this.visiting.add(node);
      stack.push({ node, post: true });
      for (const c of this.children(node)) {
        // An edge to a node still on the search path is a back edge: a cycle. Marked
        // here, structurally, not where a value is read: a conjunction that stops
        // early never reads it, and detection must not depend on values or order.
        if (this.visiting.has(c)) this.cycleNodes.add(c);
        else if (!this.memoized(c)) stack.push({ node: c, post: false });
      }
    }
  }

  /** Exactly the facts the node's rule reads (never more: an extra edge could fake a cycle). */
  private children(node: string): string[] {
    const kind = node[0];
    const id = node.slice(2);
    if (kind === 'j') {
      const info = this.ix.judgments.get(id as JudgmentId);
      return info ? info.rec.reliesOn.map((o) => `p:${o}`) : [];
    }
    const u = unitStructure(this.ix, id);
    if (u) {
      if (kind === 'e') return u.ownPassed ? [...u.deciding.map((d) => `j:${d.rec.judgment}`), ...u.members.map((m) => `e:${m}`)] : [];
      if (kind === 'f') return [`e:${id}`, ...u.members.map((m) => `f:${m}`)];
      return [`f:${id}`];
    }
    const s = ownStructure(this.ix, id);
    if (!s) return [];
    if (kind === 'e') return s.conclusion === 'passed' ? s.deciding.map((d) => `j:${d.rec.judgment}`) : [];
    if (kind === 'f') return [`e:${id}`, ...s.prereqs.map((p) => `p:${p}`)];
    const myUnit = this.ix.unitOf.get(id as ObjectVersionId);
    return myUnit ? [`f:${id}`, `p:${myUnit}`] : [`f:${id}`];
  }

  /**
   * Nodes found on a dependency cycle (read while still on the search path).
   * The evaluator raises an alert for newly cyclic nodes (5.2 part 4, WI-16).
   * Which node of a cycle is met depends on the evaluation order; the cycle's
   * identity is its strongly connected component (`cyclicComponents`).
   */
  readonly cycleNodes = new Set<string>();

  /**
   * 5.2 part 4: the strongly connected components with a cycle (two or more
   * nodes, or one node reading itself) that contain or are reachable from
   * `roots`, over exactly the edges the rules read (`children`), restricted to
   * nodes for which `within` holds. A component is returned with its nodes
   * sorted, so it does not depend on the evaluation order. Iterative Tarjan: a
   * long chain must not overflow the call stack.
   */
  cyclicComponents(roots: Iterable<string>, within: (node: string) => boolean = () => true): string[][] {
    const keep = (n: string): boolean => within(n) && (!n.startsWith('j:') || this.ix.judgments.has(n.slice(2) as JudgmentId));
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const out: string[][] = [];
    let next = 0;
    for (const root of roots) {
      if (index.has(root) || !keep(root)) continue;
      const work: { node: string; children: string[]; i: number }[] = [];
      const open = (n: string): void => {
        index.set(n, next);
        low.set(n, next);
        next++;
        stack.push(n);
        onStack.add(n);
        work.push({ node: n, children: this.children(n).filter(keep), i: 0 });
      };
      open(root);
      while (work.length > 0) {
        const top = work[work.length - 1]!;
        if (top.i < top.children.length) {
          const c = top.children[top.i++]!;
          if (!index.has(c)) open(c);
          else if (onStack.has(c)) low.set(top.node, Math.min(low.get(top.node)!, index.get(c)!));
          continue;
        }
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(top.node)!));
        if (low.get(top.node) !== index.get(top.node)) continue;
        const comp: string[] = [];
        let x: string;
        do {
          x = stack.pop()!;
          onStack.delete(x);
          comp.push(x);
        } while (x !== top.node);
        if (comp.length > 1 || top.children.includes(top.node)) out.push(comp.sort());
      }
    }
    return out;
  }

  /** A fact read across a cycle (still on the search path, so not memoized) reads as false. */
  private peek(node: string): boolean {
    const v = this.memo(node[0]!).get(node.slice(2));
    if (v !== undefined) return v;
    if (this.visiting.has(node)) this.cycleNodes.add(node);
    return false;
  }

  private combine(node: string): boolean {
    const kind = node[0];
    const id = node.slice(2);
    if (kind === 'j') {
      const info = this.ix.judgments.get(id as JudgmentId)!;
      return judgmentLeavesOk(this.ix, info) && info.rec.reliesOn.every((o) => this.peek(`p:${o}`));
    }
    const u = unitStructure(this.ix, id);
    if (u) {
      if (kind === 'e') return u.ownPassed && u.deciding.every((d) => this.peek(`j:${d.rec.judgment}`)) && u.members.every((m) => this.peek(`e:${m}`));
      if (kind === 'f') return this.peek(`e:${id}`) && u.recordsOk && u.members.every((m) => this.peek(`f:${m}`));
      return u.conclusion === 'passed' && !u.basisWithdrawn && this.peek(`f:${id}`);
    }
    const s = ownStructure(this.ix, id);
    if (!s) return false;
    if (kind === 'e') return s.conclusion === 'passed' && s.deciding.every((d) => this.peek(`j:${d.rec.judgment}`));
    if (kind === 'f') return this.peek(`e:${id}`) && s.coverageOk && s.prereqs.every((p) => this.peek(`p:${p}`));
    const myUnit = this.ix.unitOf.get(id as ObjectVersionId);
    return s.conclusion === 'passed' && !s.basisWithdrawn && this.peek(`f:${id}`) && (myUnit === undefined || this.peek(`p:${myUnit}`));
  }

  // ------------------------------------------------------------ published values

  /** v30 5.2: pass, and the deciding judgment is current. */
  positionInEffect(target: string, review: string): boolean {
    const st = positionState(this.ix, target, review);
    return st.state === 'pass' && this.judgmentCurrent(st.by.rec.judgment);
  }

  /** 5.6 kind 1: a registered regression run counts only as a closed, applicable run with every registered test passed and unchanged inputs. */
  private regressionHolds(run: RegressionRun): boolean {
    const ev = this.ix.evidence.get(run.evidence);
    if (!ev || ev.runClass !== 'closed' || !evidenceApplicable(this.ix, run.evidence)) return false;
    if (run.tests.length === 0 || run.command.length === 0) return false;
    // 5.6: without registered test files and a declared runner configuration a run never counts mechanically.
    if (!run.inputs.some((x) => x.startsWith('testfile:')) || !run.inputs.some((x) => x.startsWith('runner:'))) return false;
    for (const t of run.tests) if (!Object.hasOwn(ev.fields, `test:${t}`) || ev.fields[`test:${t}`] !== 'passed') return false;
    for (const enc of run.inputs) {
      const eq = enc.indexOf('=');
      if (eq <= 0) return false;
      const name = `input:${enc.slice(0, eq)}`;
      if (!Object.hasOwn(ev.fields, name) || ev.fields[name] !== enc.slice(eq + 1)) return false;
    }
    return true;
  }

  /**
   * 5.6 (v31): the issue states on one version, decided in order: the version's
   * label (negated, basis withdrawn or unaccepted → unfixed); any "not fixed" or
   * "deferred" response of a deciding judgment → unfixed; a coverage proof (a
   * valid regression run, or a current deciding judgment responding "fixed") →
   * fixed when proven, fixed-not-fully-proven when not fully proven; otherwise
   * unfixed.
   */
  fixesOf(t: string): Map<string, FixState> {
    const out = new Map<string, FixState>();
    const blocked = new Set<string>();
    const fixedBy = new Map<string, JudgmentId[]>();
    for (const c of this.ix.contracts(t) ?? []) {
      const st = positionState(this.ix, t, c.review);
      if (st.state === 'none') continue;
      for (const r of st.by.rec.issues) {
        if (r.response === 'fixed') {
          let list = fixedBy.get(r.issue);
          if (!list) fixedBy.set(r.issue, (list = []));
          list.push(st.by.rec.judgment);
        } else blocked.add(r.issue);
      }
    }
    const issues = new Set<string>([...blocked, ...fixedBy.keys(), ...(this.ix.regressionIssuesByTarget.get(t) ?? [])]);
    if (issues.size === 0) return out;
    const label = this.ix.isTarget(t) ? this.targetState(t).label : 'unaccepted';
    for (const issue of issues) {
      const key = fixKey(issue, t);
      const coveredNow =
        (this.ix.regression.get(key) ?? []).some((run) => this.regressionHolds(run)) || (fixedBy.get(issue) ?? []).some((j) => this.judgmentCurrent(j));
      let state: FixState = 'unfixed';
      if (!blocked.has(issue) && coveredNow && label === 'proven') state = 'fixed';
      else if (!blocked.has(issue) && coveredNow && label === 'not-fully-proven') state = 'fixed-not-fully-proven';
      out.set(key, state);
    }
    return out;
  }

  /** What decides `t`'s proof (DecidingView), or null for an unknown target. */
  deciding(t: string): DecidingView | null {
    const ix = this.ix;
    const contracts = ix.contracts(t);
    if (contracts === null) return null;
    const positions = contracts.map((c) => {
      const st = positionState(ix, t, c.review);
      return Object.freeze({ review: c.review, state: st.state, by: st.state === 'none' ? null : st.by.rec.judgment });
    });
    const comp = composite(ix, t, contracts);
    const ts = this.targetState(t);
    const deciding = comp.deciding.map((d) =>
      Object.freeze({
        judgment: d.rec.judgment,
        review: d.rec.review,
        executor: d.rec.executor,
        current: this.judgmentCurrent(d.rec.judgment),
        evidence: Object.freeze(
          d.rec.evidence.map((e): DecidingEvidence => {
            const eff = effectiveEvidence(ix, d.rec, e as EvidenceId);
            const rec = ix.evidence.get(eff);
            return Object.freeze({
              original: e as EvidenceId,
              effective: eff,
              applicable: evidenceApplicable(ix, eff),
              record: rec ? Object.freeze({ envLine: rec.envLine, envSnapshot: rec.envSnapshot, runClass: rec.runClass, fields: rec.fields }) : null,
            });
          }),
        ),
      }),
    );
    return Object.freeze({
      kind: ix.units.has(t as ProofUnitId) ? 'unit' : 'object',
      conclusion: ts.conclusion,
      label: ts.label,
      inEffect: ts.inEffect,
      fresh: ts.fresh,
      positions: Object.freeze(positions),
      deciding: Object.freeze(deciding),
    });
  }

  opState(op: OpId): OpState | null {
    const rec = this.ix.pendingOps.get(op);
    if (!rec) return null;
    const allProven = rec.objects.length > 0 && rec.objects.every((o) => this.proven(o));
    return Object.freeze({ kind: rec.opKind, allProven, executedAsOf: this.ix.executed.get(op) ?? null });
  }

  /**
   * v32 5.2 part 5: may a continuation judgment extend J0, and which validity
   * inputs does it inherit? J0 must be the deciding pass of its position and be
   * current once the batch's changed basis lines count as reviewed. The
   * continuation inherits J0's evidence (after valid renewals), relied-on
   * objects, constraint checks (with their reviewed paths, never widened) and
   * bound basis versions (a changed line takes its current version). An input is
   * dropped only when the seat superseded it with a replacement of the same kind
   * that the draft carries. If an inherited input is itself invalid now, the
   * batch must be reviewed in full instead.
   */
  continuation(req: ContinuationRequest): ContinuationResult {
    const j0 = this.ix.judgments.get(req.extends);
    if (!j0) return { ok: false, reason: 'unknown-judgment' };
    if (j0.rec.review !== req.review) return { ok: false, reason: 'different-review' };
    if (j0.rec.target !== req.target && this.ix.objects.get(req.target as ObjectVersionId)?.predecessor !== j0.rec.target) {
      return { ok: false, reason: 'different-line' };
    }
    const st = positionState(this.ix, j0.rec.target, j0.rec.review);
    if (st.state !== 'pass' || st.by.rec.judgment !== j0.rec.judgment) return { ok: false, reason: 'not-deciding-pass' };
    const changed = new Set<string>(req.changedLines);
    let current = judgmentLeavesOk(this.ix, j0, changed);
    for (const o of j0.rec.reliesOn) if (!this.proven(o)) current = false;
    if (!current) return { ok: false, reason: 'not-current-outside-changes' };

    const j0ev = new Set<string>();
    for (const e of j0.rec.evidence) {
      j0ev.add(e);
      j0ev.add(effectiveEvidence(this.ix, j0.rec, e as EvidenceId));
    }
    const categories: Array<[Set<string>, readonly string[]]> = [
      [j0ev, req.draft.evidence],
      [new Set(j0.rec.reliesOn), req.draft.reliesOn],
      [new Set(j0.rec.constraints), req.draft.constraints],
      [new Set(j0.rec.bases), req.draft.bases],
    ];
    const dropped = new Set<string>();
    for (const sup of req.superseded) {
      const cat = categories.find(([inputs]) => inputs.has(sup.input));
      if (!cat) return { ok: false, reason: 'not-an-input' };
      if (!cat[1].includes(sup.by)) return { ok: false, reason: 'replacement-missing' };
      if (cat[0] === j0ev && !this.ix.evidence.has(sup.by as EvidenceId)) return { ok: false, reason: 'replacement-missing' };
      dropped.add(sup.input);
    }
    const keep = (x: string): boolean => !dropped.has(x);
    const evidence = new Set<string>(req.draft.evidence);
    for (const e of j0.rec.evidence) {
      const eff = effectiveEvidence(this.ix, j0.rec, e as EvidenceId);
      if (keep(e) && keep(eff)) evidence.add(eff);
    }
    const reliesOn = new Set<string>(req.draft.reliesOn);
    for (const o of j0.rec.reliesOn) if (keep(o)) reliesOn.add(o);
    const constraints = new Set<string>(req.draft.constraints);
    for (const c of j0.rec.constraints) if (keep(c)) constraints.add(c);
    // Bases: one version per line; the draft's versions win, then J0's (a changed line takes its current version).
    const byLine = new Map<string, string>();
    for (const b of req.draft.bases) byLine.set(this.ix.basisLineOf.get(b as BasisVersionId) ?? b, b);
    for (const b of j0.rec.bases) {
      if (!keep(b)) continue;
      const line = this.ix.basisLineOf.get(b as BasisVersionId);
      if (line === undefined) return { ok: false, reason: 'inherited-input-invalid' };
      if (byLine.has(line)) continue;
      byLine.set(line, changed.has(line) ? (this.ix.basisLatest.get(line) ?? b) : b);
    }
    const merged = {
      evidence: [...evidence].sort(),
      bases: [...byLine.values()].sort(),
      constraints: [...constraints].sort(),
      reliesOn: [...reliesOn].sort(),
    };
    for (const e of merged.evidence) if (!evidenceApplicable(this.ix, e as EvidenceId)) return { ok: false, reason: 'inherited-input-invalid' };
    for (const b of merged.bases) if (!isConstraintKind(this.ix, b) && basisState(this.ix, b as BasisVersionId) !== 'valid') return { ok: false, reason: 'inherited-input-invalid' };
    for (const o of merged.reliesOn) if (!this.proven(o)) return { ok: false, reason: 'inherited-input-invalid' };
    return { ok: true, merged, inputsHash: continuationInputsHash(merged) };
  }
}

// ---------------------------------------------------------------- full computation

export function fullCompute(records: readonly ResolvedCommitted[], at: Revision): DerivedState {
  const ix = new Index();
  for (const c of records) if (c.revision <= at) ix.add(c);
  const d = new Derivation(ix);

  const basis = new Map<BasisVersionId, BasisState>();
  for (const v of ix.basisLineOf.keys()) basis.set(v, basisState(ix, v));

  const evidenceApplicableMap = new Map<EvidenceId, boolean>();
  for (const e of ix.evidence.keys()) evidenceApplicableMap.set(e, evidenceApplicable(ix, e));

  const targets = new Map<string, TargetState>();
  for (const u of ix.units.keys()) targets.set(u, d.targetState(u));
  for (const o of ix.objects.keys()) targets.set(o, d.targetState(o));

  const judgmentCurrent = new Map<JudgmentId, boolean>();
  for (const j of ix.judgments.keys()) judgmentCurrent.set(j, d.judgmentCurrent(j));

  const positionInEffect = new Map<ReviewPosition, boolean>();
  for (const [t, reviews] of ix.positionsByTarget) for (const r of reviews) positionInEffect.set(reviewPosition(t, r), d.positionInEffect(t, r));

  const fixes = new Map<string, FixState>();
  for (const t of new Set<string>([...ix.objects.keys(), ...ix.units.keys(), ...ix.regressionIssuesByTarget.keys()])) {
    for (const [k, v] of d.fixesOf(t)) fixes.set(k, v);
  }

  const ops = new Map<OpId, OpState>();
  for (const op of ix.pendingOps.keys()) ops.set(op, d.opState(op)!);

  return Object.freeze({ revision: at, basis, evidenceApplicable: evidenceApplicableMap, judgmentCurrent, positionInEffect, targets, fixes, ops });
}
