// The DeliveryProofView over the real system (design 6.1; 6.6 steps 1-4; 5.1-5.3).
//
// - Records that give the delivery its structure (object versions and proof
//   units) are read from the ledger database (read-only, readRecords) up to the
//   evaluator's published revision R, with their lists resolved from the content
//   store exactly as the evaluator resolves them (resolveRecord).
// - What decides each target's proof comes from the evaluator itself, through
//   its `deciding` query at ONE published revision: per target its kind,
//   conclusion, label, whether its positions are in effect, freshness, every
//   required review position {review, state, by}, and, only when every position
//   passes, the deciding judgments with their evidence in force (after valid
//   renewals) and those runs' records. The view no longer derives any of this
//   with ported copies of the evaluator's rules (the copies drifted: an invalid
//   newest renewal still hid an older valid one there after the evaluator had
//   fixed it, core review r3 #14).
// - Every answer carries the revision it was computed at. When an answer comes
//   back at another revision (a publication in between, or a restart from an
//   older checkpoint), the records are read again at that revision and the view
//   starts over, a bounded number of times. So "proven" in a delivery always
//   means "proven as of R" (6.1), and every record the view answers from has
//   revision <= R. NOT_READY (the evaluator already waited, bounded, for a
//   publication in flight) is retried after a short pause within the same
//   bound; then ViewNotReady.
// - The answers are checked against the records at R and against themselves:
//   every target of the closure must be known, of the recorded kind, with the
//   recorded review positions in order; the conclusion must follow the
//   positions (a failing position negates, all passing concludes), the deciding
//   judgments must be exactly the passing positions' judgments, and "in effect"
//   must agree with their currency. A disagreement is ViewInconsistent (another
//   database, or a bug), never papered over.
//
// The view answers only for the dependency closure of the outputs it was opened
// for (the same walk as the manifest: prerequisites, a member's unit, a unit's
// members); the deciding answers are fetched for that closure, in batches of at
// most MAX_DECIDING_TARGETS targets.

import { setTimeout as sleep } from 'node:timers/promises';
import { revision as toRevision, type EvidenceId, type JudgmentId, type ObjectVersionId, type ProofUnitId, type Revision } from '../common/ids.ts';
import type { ObjectVersionRecord, Resolved } from '../common/records.ts';
import { RpcError } from '../common/rpc.ts';
import { resolveRecord } from '../evaluator/evaluator.ts';
import { MAX_DECIDING_TARGETS } from '../evaluator/queries.ts';
import { Index, type Conclusion, type Label, type TargetState } from '../evaluator/semantics.ts';
import type { ContentStore } from '../ledger/content.ts';
import { readHead, readRecords } from '../ledger/store.ts';
import { runInputsFromFields, targetKey, type DecidingEvidence, type DeliveryObject, type DeliveryProofView, type DeliveryTarget } from './proofView.ts';

/** The evaluator's query socket (RpcClient satisfies it). */
export interface EvaluatorQueryPort {
  call(method: string, params?: unknown): Promise<unknown>;
}

export interface EvaluatorViewOptions {
  /** The ledger database (read-only). */
  readonly dbPath: string;
  /** The ledger's content store, for list contents. */
  readonly content: ContentStore;
  /** The evaluator process's query socket. */
  readonly evaluator: EvaluatorQueryPort;
  /** The outputs the delivery selects; the view answers for their dependency closure. */
  readonly selected: readonly DeliveryTarget[];
  /** How many times to start over when answers come back at different revisions, or not ready (default 5). */
  readonly attempts?: number;
  /** The pause before asking again after NOT_READY (default 250 ms). */
  readonly notReadyDelayMs?: number;
}

/** The evaluator has published no revision yet (just started, rebuilding, or in its fault state). */
export class ViewNotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewNotReady';
  }
}

/** The evaluator kept publishing new revisions while the view was being read. */
export class ViewRevisionUnstable extends Error {
  readonly revisions: readonly number[];
  constructor(revisions: readonly number[]) {
    super(`the evaluator's revision kept moving while the delivery view was read (saw ${revisions.join(', ')}); try again`);
    this.name = 'ViewRevisionUnstable';
    this.revisions = revisions;
  }
}

/**
 * The records at R and the evaluator's answers at R disagree, or an answer is
 * malformed. Delivery must not proceed on such a view; the cause is a bug or a
 * misconfiguration (another database), so it is reported, not retried.
 */
export class ViewInconsistent extends Error {
  readonly revision: Revision;
  readonly target: string | null;
  constructor(revision: Revision, target: string | null, detail: string) {
    super(`delivery view at revision ${revision}${target === null ? '' : `, ${target}`}: ${detail}`);
    this.name = 'ViewInconsistent';
    this.revision = revision;
    this.target = target;
  }
}

// ---------------------------------------------------------------- the records at R

/** The record kinds the view reads: the delivery's structure only (what decides proofs comes from the evaluator). */
const VIEW_KINDS: ReadonlySet<string> = new Set(['object.version', 'proof.unit']);

interface Snapshot {
  readonly revision: Revision;
  readonly ix: Index;
  /** Target keys of the closure (known or not). */
  readonly closure: ReadonlySet<string>;
  readonly closureObjects: readonly ObjectVersionId[];
  readonly closureUnits: readonly ProofUnitId[];
}

function tagOf(ix: Index, rev: Revision, id: string): DeliveryTarget {
  const isUnit = ix.units.has(id as ProofUnitId);
  if (isUnit && ix.objects.has(id as ObjectVersionId)) {
    // The ledger refuses this (objects and proof units share one id space, FACT_CONFLICT); kept as a defence.
    throw new ViewInconsistent(rev, id, 'the id names both an object version and a proof unit; the evaluator publishes one state per id');
  }
  return isUnit ? { kind: 'unit', id: id as ProofUnitId } : { kind: 'object', id: id as ObjectVersionId };
}

function readSnapshot(o: EvaluatorViewOptions, at: Revision): Snapshot {
  const head = readHead(o.dbPath);
  if (head < at) throw new ViewInconsistent(at, null, `the ledger database ends at revision ${head}: it is not the database the evaluator reads`);
  const ix = new Index();
  for (const c of readRecords(o.dbPath, toRevision(0), at)) {
    if (VIEW_KINDS.has(c.record.kind)) ix.add({ revision: c.revision, record: resolveRecord(c.record, o.content) });
  }
  // The closure: the manifest's walk (manifest.ts), over the records at R.
  const closure = new Set<string>();
  const objects: ObjectVersionId[] = [];
  const units: ProofUnitId[] = [];
  const queue: DeliveryTarget[] = [...o.selected];
  while (queue.length > 0) {
    const t = queue.shift() as DeliveryTarget;
    const key = targetKey(t);
    if (closure.has(key)) continue;
    closure.add(key);
    if (t.kind === 'unit') {
      const u = ix.units.get(t.id);
      if (!u) continue;
      units.push(t.id);
      for (const m of u.members) queue.push({ kind: 'object', id: m as ObjectVersionId });
      continue;
    }
    const r = ix.objects.get(t.id);
    if (!r) continue;
    objects.push(t.id);
    const unit = ix.unitOf.get(t.id);
    if (unit !== undefined) queue.push({ kind: 'unit', id: unit });
    for (const p of r.prerequisites) queue.push(tagOf(ix, at, p));
  }
  return { revision: at, ix, closure, closureObjects: objects, closureUnits: units };
}

// ---------------------------------------------------------------- the evaluator's answers

const LABELS: ReadonlySet<string> = new Set<Label>(['negated', 'basis-withdrawn', 'unaccepted', 'not-fully-proven', 'proven']);
const CONCLUSIONS: ReadonlySet<string> = new Set<Conclusion>(['unaccepted', 'passed', 'negated']);
const POSITION_STATES: ReadonlySet<string> = new Set(['none', 'pass', 'fail', 'undecided']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function answerRevision(method: string, answer: unknown, at: Revision): { revision: Revision; body: Record<string, unknown> } {
  if (!isRecord(answer) || typeof answer.revision !== 'number' || !Number.isSafeInteger(answer.revision) || answer.revision < 0) {
    throw new ViewInconsistent(at, null, `the evaluator's ${method} answer carries no revision`);
  }
  return { revision: toRevision(answer.revision), body: answer };
}

/** "Not ready" from the evaluator: no published state, or an update being published past its bounded wait. */
function isNotReady(e: unknown): boolean {
  return e instanceof RpcError && e.code === 'NOT_READY';
}

/** One target's answer, checked (see the header). */
interface Decided {
  readonly state: TargetState;
  readonly ownPassed: boolean;
  readonly deciding: readonly { readonly judgment: JudgmentId; readonly current: boolean; readonly evidence: readonly { readonly effective: EvidenceId; readonly fields: Readonly<Record<string, string>> | null }[] }[];
}

function stringField(v: Record<string, unknown>, k: string): string | null {
  return typeof v[k] === 'string' ? (v[k] as string) : null;
}

function parseDecided(at: Revision, id: string, v: unknown, kind: 'object' | 'unit', reviews: readonly string[]): Decided {
  if (v === null || v === undefined) throw new ViewInconsistent(at, id, 'recorded at or before this revision, but the evaluator publishes no state for it');
  const bad = (what: string): ViewInconsistent => new ViewInconsistent(at, id, `malformed deciding answer (${what}): ${JSON.stringify(v).slice(0, 400)}`);
  if (!isRecord(v)) throw bad('not an object');
  if (v.kind !== kind) throw new ViewInconsistent(at, id, `the records make it ${kind === 'unit' ? 'a proof unit' : 'an object version'}, the evaluator answers for ${String(v.kind)}`);
  if (!LABELS.has(v.label as string) || !CONCLUSIONS.has(v.conclusion as string) || typeof v.inEffect !== 'boolean' || typeof v.fresh !== 'boolean') throw bad('state');
  const state: TargetState = { label: v.label as Label, conclusion: v.conclusion as Conclusion, inEffect: v.inEffect, fresh: v.fresh };
  if (!Array.isArray(v.positions) || !Array.isArray(v.deciding)) throw bad('positions or deciding');
  const positions = v.positions.map((p) => {
    if (!isRecord(p) || stringField(p, 'review') === null || !POSITION_STATES.has(p.state as string) || !(p.by === null || typeof p.by === 'string')) throw bad('position');
    if ((p.state === 'none') !== (p.by === null)) throw bad('position judgment');
    return { review: p.review as string, state: p.state as string, by: p.by as string | null };
  });
  // The recorded review contracts, in order: an evaluator reading another database answers for other positions.
  if (positions.length !== reviews.length || positions.some((p, i) => p.review !== reviews[i])) {
    throw new ViewInconsistent(at, id, `the evaluator answers for review positions [${positions.map((p) => p.review).join(', ')}], the records require [${reviews.join(', ')}]`);
  }
  const deciding = v.deciding.map((d) => {
    if (!isRecord(d) || stringField(d, 'judgment') === null || stringField(d, 'review') === null || typeof d.current !== 'boolean' || !Array.isArray(d.evidence)) throw bad('deciding judgment');
    const evidence = d.evidence.map((e) => {
      if (!isRecord(e) || stringField(e, 'original') === null || stringField(e, 'effective') === null || typeof e.applicable !== 'boolean') throw bad('evidence');
      const rec = e.record;
      if (rec !== null && !(isRecord(rec) && isRecord(rec.fields) && Object.values(rec.fields).every((x) => typeof x === 'string'))) throw bad('evidence record');
      return { effective: e.effective as EvidenceId, fields: rec === null ? null : (rec.fields as Record<string, string>) };
    });
    return { judgment: d.judgment as JudgmentId, review: d.review as string, current: d.current, evidence };
  });
  // The composite rule over the required positions (v30 5.2): any failing position negates; all passing conclude.
  const ownPassed = positions.length > 0 && positions.every((p) => p.state === 'pass');
  const ownNegated = positions.some((p) => p.state === 'fail');
  if (ownPassed) {
    if (deciding.length !== positions.length || deciding.some((d, i) => d.judgment !== positions[i]?.by || d.review !== positions[i]?.review)) {
      throw new ViewInconsistent(at, id, 'the deciding judgments are not the judgments its passing positions name');
    }
  } else if (deciding.length > 0) {
    throw new ViewInconsistent(at, id, 'deciding judgments are given although not every required position passes');
  }
  if (kind === 'object') {
    const want: Conclusion = ownNegated ? 'negated' : ownPassed ? 'passed' : 'unaccepted';
    if (state.conclusion !== want) throw new ViewInconsistent(at, id, `the evaluator concludes ${state.conclusion}, its positions give ${want}`);
    const inEffect = ownPassed && deciding.every((d) => d.current);
    if (state.inEffect !== inEffect) throw new ViewInconsistent(at, id, `the evaluator has its positions ${state.inEffect ? '' : 'not '}in effect; the deciding judgments say otherwise`);
  } else {
    // A unit's conclusion is also bounded by its members' (5.3): only its own positions are checked here.
    if (ownNegated && state.conclusion !== 'negated') throw new ViewInconsistent(at, id, `the evaluator concludes ${state.conclusion}, a failing position of the unit negates it`);
    if (!ownPassed && state.conclusion === 'passed') throw new ViewInconsistent(at, id, 'the evaluator concludes passed, but not every required position of the unit passes');
  }
  return { state, ownPassed, deciding };
}

// ---------------------------------------------------------------- the view

class EvaluatorDeliveryView implements DeliveryProofView {
  readonly revision: Revision;
  /** The evaluator's published state of every known target of the closure, at `revision`. */
  readonly states: ReadonlyMap<string, TargetState>;
  private readonly ix: Index;
  private readonly closure: ReadonlySet<string>;
  private readonly deciding: ReadonlyMap<string, readonly DecidingEvidence[]>;
  private readonly objects = new Map<ObjectVersionId, DeliveryObject>();

  constructor(s: Snapshot, states: ReadonlyMap<string, TargetState>, deciding: ReadonlyMap<string, readonly DecidingEvidence[]>) {
    this.revision = s.revision;
    this.ix = s.ix;
    this.closure = s.closure;
    this.states = states;
    this.deciding = deciding;
  }

  object(id: ObjectVersionId): DeliveryObject | null {
    const cached = this.objects.get(id);
    if (cached !== undefined) return cached;
    const r: Resolved<ObjectVersionRecord> | undefined = this.ix.objects.get(id);
    if (r === undefined) return null;
    const o: DeliveryObject = Object.freeze({
      id: r.object,
      kind: r.objectKind,
      mission: r.mission,
      module: r.module,
      content: r.content,
      prerequisites: Object.freeze(r.prerequisites.map((p) => tagOf(this.ix, this.revision, p))),
      paths: r.scope.paths,
      tree: r.source ?? null,
    });
    this.objects.set(id, o);
    return o;
  }

  unitOf(id: ObjectVersionId): ProofUnitId | null {
    return this.ix.unitOf.get(id) ?? null;
  }

  unitMembers(unit: ProofUnitId): readonly ObjectVersionId[] | null {
    const u = this.ix.units.get(unit);
    return u === undefined ? null : (u.members as readonly ObjectVersionId[]);
  }

  private known(t: DeliveryTarget): boolean {
    return t.kind === 'unit' ? this.ix.units.has(t.id) : this.ix.objects.has(t.id);
  }

  private inScope(t: DeliveryTarget): void {
    if (!this.closure.has(targetKey(t)) && this.known(t)) {
      throw new RangeError(`${targetKey(t)} is outside the dependency closure of the outputs this delivery view was opened for`);
    }
  }

  label(target: DeliveryTarget): Label {
    this.inScope(target);
    // A target with no record at R is not proven (the evaluator answers null for it).
    return this.states.get(target.id)?.label ?? 'unaccepted';
  }

  decidingEvidence(target: DeliveryTarget): readonly DecidingEvidence[] {
    this.inScope(target);
    return this.deciding.get(targetKey(target)) ?? [];
  }
}

type ReadAt = { readonly kind: 'view'; readonly view: EvaluatorDeliveryView } | { readonly kind: 'moved'; readonly to: Revision };

/** One try at revision `at`: the records at `at`, the deciding answers for the closure (batched), all at `at`. */
async function readAt(o: EvaluatorViewOptions, at: Revision): Promise<ReadAt> {
  const snap = readSnapshot(o, at);
  const targets: { id: string; kind: 'object' | 'unit'; reviews: readonly string[] }[] = [
    ...snap.closureObjects.map((id) => ({ id, kind: 'object' as const, reviews: snap.ix.objects.get(id)!.reviews.map((r) => r.review) })),
    ...snap.closureUnits.map((id) => ({ id, kind: 'unit' as const, reviews: snap.ix.units.get(id)!.reviews.map((r) => r.review) })),
  ];
  const decided = new Map<string, Decided>();
  for (let i = 0; i < targets.length; i += MAX_DECIDING_TARGETS) {
    const batch = targets.slice(i, i + MAX_DECIDING_TARGETS);
    const a = answerRevision('deciding', await o.evaluator.call('deciding', { targets: batch.map((t) => t.id) }), at);
    if (a.revision !== at) return { kind: 'moved', to: a.revision };
    const raw = a.body.targets;
    if (!isRecord(raw)) throw new ViewInconsistent(at, null, 'the deciding answer has no targets');
    for (const t of batch) decided.set(t.id, parseDecided(at, t.id, raw[t.id] ?? null, t.kind, t.reviews));
  }
  // A unit is in effect only with every member in effect (5.3): checked once every answer is in.
  for (const id of snap.closureUnits) {
    const d = decided.get(id)!;
    const members = snap.ix.units.get(id)!.members;
    const inEffect = d.ownPassed && d.deciding.every((j) => j.current) && members.every((m) => decided.get(m)?.state.inEffect === true);
    if (d.state.inEffect !== inEffect) throw new ViewInconsistent(at, id, `the evaluator has the unit ${d.state.inEffect ? '' : 'not '}in effect; its positions and members say otherwise`);
  }
  const states = new Map<string, TargetState>();
  const deciding = new Map<string, readonly DecidingEvidence[]>();
  for (const t of targets) {
    const d = decided.get(t.id)!;
    states.set(t.id, d.state);
    // The runs the deciding judgments rest on, after valid renewals (as the evaluator decides them), with their file inputs (7.2).
    const out: DecidingEvidence[] = [];
    const done = new Set<EvidenceId>();
    for (const j of d.deciding) {
      for (const e of j.evidence) {
        if (done.has(e.effective)) continue;
        done.add(e.effective);
        // An unrecorded run makes its judgment not current (the label already says so); it has no known inputs.
        out.push({ evidence: e.effective, inputs: e.fields === null ? [] : runInputsFromFields(e.fields) });
      }
    }
    deciding.set(targetKey(t.kind === 'unit' ? { kind: 'unit', id: t.id as ProofUnitId } : { kind: 'object', id: t.id as ObjectVersionId }), Object.freeze(out));
  }
  return { kind: 'view', view: new EvaluatorDeliveryView(snap, states, deciding) };
}

/**
 * Opens a delivery view at the evaluator's current published revision R.
 * Throws ViewNotReady when nothing is published yet (or the evaluator stays not
 * ready for the attempts), ViewRevisionUnstable when the revision kept moving
 * for `attempts` tries, ViewInconsistent when records and answers at R
 * disagree, and RpcUnavailable when the evaluator cannot be reached (6.1: the
 * caller retries later; delivery never runs on a guess).
 */
export async function openEvaluatorDeliveryView(o: EvaluatorViewOptions): Promise<EvaluatorDeliveryViewHandle> {
  const attempts = o.attempts ?? 5;
  const seen: number[] = [];
  const published = async (): Promise<Revision | null> => {
    const sum = await o.evaluator.call('summary', {});
    if (isRecord(sum) && sum.revision === null) return null;
    return answerRevision('summary', sum, toRevision(0)).revision;
  };
  const first = await published();
  if (first === null) throw new ViewNotReady('the evaluator has not published a revision yet');
  let want: Revision = first;
  for (let attempt = 0; attempt < attempts; attempt++) {
    seen.push(want);
    let r: ReadAt;
    try {
      r = await readAt(o, want);
    } catch (e) {
      if (!isNotReady(e)) throw e;
      // The evaluator already waited (bounded) for a publication in flight, or it restarted: ask again shortly.
      if (attempt + 1 >= attempts) throw new ViewNotReady(`the evaluator was not ready to answer at a published revision after ${attempts} tries`);
      await sleep(o.notReadyDelayMs ?? 250);
      want = (await published()) ?? want;
      continue;
    }
    if (r.kind === 'view') return r.view;
    want = r.to;
  }
  seen.push(want);
  throw new ViewRevisionUnstable(seen);
}

/** The view, plus the evaluator's published state of each target of the closure (for reports). */
export type EvaluatorDeliveryViewHandle = DeliveryProofView & { readonly states: ReadonlyMap<string, TargetState> };
