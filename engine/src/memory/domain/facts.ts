// Base records written by the program, with the checks the 4.0 ledger service
// made (design 4.1 §3.2, §6.5; 4.0 6.1, 5.2, 5.3, 6.5), now functions that run
// inside the caller's write transaction:
// - every record is validated (shape, value domains, size) and everything it
//   refers to in the data table is checked (values hash to their names; lists
//   are JSON lists of strings with the declared count, at most MAX_LIST_ITEMS);
// - each entry point writes only its own record kinds;
// - a fact's identity (object, judgment, evidence, unit, basis version, pending
//   operation...) is written once: the same fact again is a no-op, a different
//   payload under the same identity is refused (FACT_CONFLICT);
// - automatic loops (6.5): one Secretary grant per lineage across all its loops,
//   and an attempt on an exhausted loop counted at its start is refused
//   (LOOP_EXHAUSTED, GRANT_LIMIT: WI-08); exhaustion is persistent;
// - a continuation judgment needs a passing check recorded for it, and no
//   evaluator input committed since (5.2 part 5); a renewal is registered only
//   when the renewal rule holds (5.3);
// - a proof-conditioned operation executes once, only when registered as
//   pending, outside every stop covering its registered scope, and when the
//   extensions (labels, A2) let it through.
//
// Dropped with the service: the request queue and its pre-verification, the
// scheduler generation (assertCurrent: 4.1 fences late writes per dispatch,
// work.ts), the publication floor (commitProofOp no longer takes `asOf`), the
// evaluator's epochs and fault ("derived state uncomputable" ends).

import { canonicalJson, hashJson } from '../../common/hash.ts';
import type { AlertId, ContentHash, JudgmentId, OpId, Revision } from '../../common/ids.ts';
import {
  continuationInputsHash,
  EVALUATOR_INPUT_KINDS,
  LOOP_KINDS,
  LOOPS_REFUSED_WHEN_EXHAUSTED,
  type BaseRecord,
  type EvidenceRecord,
  type JudgmentInputs,
  type JudgmentRecord,
  type LoopKind,
} from '../../common/records.ts';
import { RecordInvalid, validateRecord } from '../../common/validate.ts';
import { renewalDecision } from '../../evaluator/renewal.ts';
import { requireContent } from '../data.ts';
import type { Db } from '../db.ts';
import { LedgerError } from '../errors.ts';
import type { WriteTx } from '../memory.ts';
import { identityOf } from '../projection.ts';
import { factById, readLoopState, type LoopState } from '../queries.ts';
import { sameTag, type ScopeTag } from '../stopTypes.ts';
import { assertNotStopped } from './stops.ts';

/** Request size limits: every write stays bounded (§4.1). */
export const MAX_RECORDS_PER_REQUEST = 1000;
/** One record, in UTF-8 bytes of its canonical JSON (core review r3 #10: bytes, not characters). */
export const MAX_RECORD_BYTES = 64 * 1024;
/** All records of one request together. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * Kinds the program may append directly: requirement items, registrations,
 * proof-model facts, pending operations, notices, loops, flow events, and the
 * hand-back's accepted records (a seat's result, its evidence, objects,
 * judgments, issues). 4.0's host facts (run layers, Claude Code exits) are gone.
 */
export const APPEND_KINDS: ReadonlySet<string> = new Set([
  'basis.version',
  'constraint.scope',
  'basis.withdrawn',
  'env.snapshot',
  'evidence',
  'evidence.revoked',
  'evidence.renewal',
  'object.version',
  'proof.unit',
  'judgment',
  'issue',
  'issue.coverage',
  'op.pending',
  'notice',
  'loop.attempt',
  'loop.grant',
  'mission.block',
  'seat.result',
  // The flows' own facts (records.ts FlowEventRecord): appended with the base records they belong to, in one write.
  'flow.event',
]);

const FLOW_EVENT_ONLY: ReadonlySet<string> = new Set(['flow.event']);

/** A deep copy fixed at entry: what is checked is exactly what is committed (core review r3 #10). */
export function freeze<T>(x: T): T {
  return JSON.parse(canonicalJson(x ?? null)) as T;
}

/** Validate a record's shape for one entry point (KIND_NOT_ALLOWED, RECORD_INVALID, TOO_LARGE). */
export function checkShape(record: BaseRecord, allowed: ReadonlySet<string>, entry: string): void {
  if (!allowed.has(record?.kind)) throw new LedgerError('KIND_NOT_ALLOWED', `${entry} cannot write ${String(record?.kind)} records`);
  try {
    validateRecord(record);
  } catch (e) {
    if (e instanceof RecordInvalid) throw new LedgerError('RECORD_INVALID', e.message);
    throw e;
  }
  if (Buffer.byteLength(canonicalJson(record), 'utf8') > MAX_RECORD_BYTES) throw new LedgerError('TOO_LARGE', `a ${record.kind} record exceeds ${MAX_RECORD_BYTES} bytes (UTF-8)`);
}

function hasFact(db: Db, kind: string, ident: string): boolean {
  return Boolean(db.stmt('SELECT 1 FROM facts WHERE kind = ? AND id = ?').get(kind, ident));
}

/** A fact's record read back by its identity (one indexed lookup), its event checked intact (§3.3: a damaged event is never used). */
function factRecord<T extends BaseRecord>(db: Db, kind: string, ident: string): T | null {
  return (factById(db, kind, ident)?.record as T | undefined) ?? null;
}

/**
 * Append program-authored base records (§3.2): checked, their data checked,
 * each appended as a fact. One request, one transaction: a refused record
 * leaves nothing of the request.
 */
export function appendRecords(tx: WriteTx, input: readonly BaseRecord[]): { revisions: Revision[] } {
  if (!Array.isArray(input)) throw new LedgerError('BAD_REQUEST', 'records is a list');
  if (input.length > MAX_RECORDS_PER_REQUEST) throw new LedgerError('TOO_LARGE', `${input.length} records in one request; the limit is ${MAX_RECORDS_PER_REQUEST}`);
  const records = freeze(input) as BaseRecord[];
  const bytes = Buffer.byteLength(canonicalJson(records), 'utf8');
  if (bytes > MAX_REQUEST_BYTES) throw new LedgerError('TOO_LARGE', `the request's records are ${bytes} bytes; the limit is ${MAX_REQUEST_BYTES} per request`);
  for (const r of records) checkShape(r, APPEND_KINDS, 'appendRecords');
  return { revisions: records.map((r) => appendFact(tx, r)) };
}

/**
 * Append one fact. A fact with an identity is written at most once: the same
 * payload again returns its original revision without a new record; another
 * payload under the same identity is refused (5.1: versions are immutable).
 * The record's shape must have been checked; its data is checked here.
 */
export function appendFact(tx: WriteTx, record: BaseRecord): Revision {
  const ident = identityOf(record);
  if (ident !== null) {
    const row = tx.stmt('SELECT payload_hash, rev FROM facts WHERE kind = ? AND id = ?').get(record.kind, ident) as { payload_hash: string; rev: number } | undefined;
    if (row) {
      if (row.payload_hash === hashJson(record)) return Number(row.rev) as Revision;
      throw new LedgerError('FACT_CONFLICT', `${record.kind} ${ident} already exists with different content`);
    }
    // Objects and proof units share one id space: the evaluator keeps one state per id.
    const other = record.kind === 'object.version' ? 'proof.unit' : record.kind === 'proof.unit' ? 'object.version' : null;
    if (other !== null && hasFact(tx, other, ident)) throw new LedgerError('FACT_CONFLICT', `${ident} is already the id of a ${other}; objects and proof units share one id space`);
  }
  const { inputs } = requireContent(tx.data, record);
  if (record.kind === 'loop.attempt' || record.kind === 'loop.grant') checkLoop(tx, record);
  if (record.kind === 'judgment' && record.extends !== null) checkContinuation(tx, record, inputs);
  if (record.kind === 'evidence.renewal') checkRenewal(tx, record);
  return tx.append(record);
}

/**
 * 6.5 "耗尽之后": the Secretary grants at most once per lineage, across all its
 * loops (GRANT_LIMIT, WI-08: after that only the user); an attempt that starts a
 * loop counted at its start is refused once the loop is exhausted
 * (LOOP_EXHAUSTED, WI-08). Checked in the transaction, so racing writers cannot
 * both pass.
 */
function checkLoop(db: Db, r: Extract<BaseRecord, { kind: 'loop.attempt' } | { kind: 'loop.grant' }>): void {
  if (r.kind === 'loop.grant') {
    if (r.by !== 'secretary') return;
    const used = db.stmt('SELECT COALESCE(SUM(secretary_grants), 0) AS n FROM loops WHERE lineage = ?').get(r.lineage) as { n: number };
    if (Number(used.n) >= 1) throw new LedgerError('GRANT_LIMIT', `the Secretary already granted extra attempts on lineage ${r.lineage} (6.5: once per lineage, across all its loops); a further grant is the user's decision`);
    return;
  }
  if (!LOOPS_REFUSED_WHEN_EXHAUSTED.has(r.loop)) return;
  const st = readLoopState(db, r.lineage, r.loop, r.failureClass);
  if (st.exhausted) throw new LedgerError('LOOP_EXHAUSTED', `${r.loop} on ${r.lineage} is exhausted (${st.reason}: ${st.attempts} of ${st.allowed} attempts); WI-08: the Secretary may grant once, then only the user`);
}

/** One loop's counters and verdict (6.5). `failureClass`: the class of the next env-retry attempt. */
export function loopState(db: Db, lineage: string, loop: LoopKind, failureClass: string | null = null): LoopState {
  if (!LOOP_KINDS.includes(loop)) throw new LedgerError('BAD_REQUEST', `unknown loop kind ${String(loop)}; the kinds are ${LOOP_KINDS.join(', ')}`);
  return readLoopState(db, lineage, loop, failureClass);
}

/**
 * The latest revision of an evaluator input after `rev`, up to now: committed
 * since, or appended earlier in this write (0: none). The proof inputs a
 * continuation check depends on are exactly these kinds (EVALUATOR_INPUT_KINDS).
 */
function inputSince(tx: WriteTx, rev: number): number {
  let latest = 0;
  for (const kind of EVALUATOR_INPUT_KINDS) {
    const r = tx.stmt('SELECT rev FROM log WHERE kind = ? AND rev > ? ORDER BY rev DESC LIMIT 1').get(kind, rev) as { rev: number } | undefined;
    if (r && Number(r.rev) > latest) latest = Number(r.rev);
  }
  return latest;
}

/**
 * 5.2 part 5 (core review r3 F1): a continuation judgment is committed only
 * with a passing check recorded for it (recordContinuationCheck), and only
 * while the log the evaluator checked is still the current one as far as proof
 * goes: no evaluator input after the revision the evaluator answered at, up to
 * the judgment itself (4.0: "at the latest published revision"; 4.1 keeps no
 * publication: the labels are stored and current with the log). New evidence
 * the continuation cites is committed before the check is made. A failed or
 * missing check sends the work to a full review (CONTINUATION_REFUSED); an
 * older check is asked again (BELOW_FLOOR). The judgment must carry exactly the
 * inputs the check merged (core review r3 #1).
 */
function checkContinuation(tx: WriteTx, r: JudgmentRecord, inputs: string | null): void {
  const c = tx.stmt('SELECT extends, target, revision, ok, reason, inputs, rev FROM continuation_checks WHERE judgment = ?').get(r.judgment) as
    | { extends: string; target: string; revision: number; ok: number; reason: string | null; inputs: string | null; rev: number }
    | undefined;
  if (!c) throw new LedgerError('CONTINUATION_REFUSED', `continuation judgment ${r.judgment} has no evaluator check: record one (recordContinuationCheck) or review in full`);
  if (c.extends !== r.extends || c.target !== r.target) throw new LedgerError('CONTINUATION_REFUSED', `the check recorded for ${r.judgment} was for another continuation (${c.extends} → ${c.target})`);
  if (c.ok !== 1) throw new LedgerError('CONTINUATION_REFUSED', `the evaluator refused continuation ${r.judgment} (${c.reason}): a full review instead (5.2 part 5)`);
  const since = inputSince(tx, Number(c.revision));
  if (since > 0) throw new LedgerError('BELOW_FLOOR', `the check of ${r.judgment} answered at revision ${c.revision}; revision ${since} changed the proof inputs since: check again`);
  if (inputs === null || inputs !== c.inputs) {
    throw new LedgerError('CONTINUATION_REFUSED', `continuation ${r.judgment} does not carry the inputs the evaluator merged (evidence, bases, constraints, relied-on objects): carry them, or review in full`);
  }
}

/**
 * 5.3: the program registers a renewal only when the rule holds (the same
 * renewalDecision the labels apply; core review r3 F14). Otherwise the
 * judgment needs a new review (RENEWAL_REFUSED, a normal branch).
 */
function checkRenewal(db: Db, r: Extract<BaseRecord, { kind: 'evidence.renewal' }>): void {
  const j = factRecord<JudgmentRecord>(db, 'judgment', r.judgment);
  const a = factRecord<EvidenceRecord>(db, 'evidence', r.original);
  const b = factRecord<EvidenceRecord>(db, 'evidence', r.replacement);
  if (!j || !a || !b) throw new LedgerError('RECORD_INVALID', `renewal of ${r.judgment}: the judgment and both evidence records must be committed first`);
  const d = renewalDecision(a, b, j.evidenceUse);
  if (!d.renew) throw new LedgerError('RENEWAL_REFUSED', `renewal of ${r.judgment} (${r.original} → ${r.replacement}) does not meet the rule: ${d.reason}${d.field ? ` (${d.field})` : ''}; the judgment needs a new review (5.3)`);
}

/**
 * Record the evaluator's answer for a continuation judgment (5.2 part 5).
 * `revision`: the log revision the evaluator's snapshot stood on when it
 * answered (the labels' revision). An answer older than the latest evaluator
 * input is refused (BELOW_FLOOR: ask again); a revision beyond the head is a
 * caller defect. The judgment can then be committed while no evaluator input
 * follows that revision (checkContinuation).
 */
export function recordContinuationCheck(
  tx: WriteTx,
  req: { judgment: JudgmentId; extends: JudgmentId; target: string; revision: number; result: { ok: boolean; reason?: string | null; merged?: JudgmentInputs } },
): { revision: Revision } {
  const ok = req.result?.ok === true;
  if (ok && !req.result.merged) throw new LedgerError('BAD_REQUEST', 'a passing continuation check carries the merged inputs the evaluator returned');
  const head = Number(tx.head());
  if (!Number.isSafeInteger(req.revision) || req.revision < 0 || req.revision > head) throw new LedgerError('BAD_REQUEST', `a check names the revision the evaluator answered at (0 to the head, ${head})`);
  const rec: BaseRecord = {
    kind: 'continuation.check',
    judgment: req.judgment,
    extends: req.extends,
    target: req.target,
    revision: req.revision,
    ok,
    reason: ok ? null : String(req.result?.reason ?? 'refused'),
    inputs: ok ? continuationInputsHash(req.result.merged!) : null,
  };
  checkShape(rec, new Set(['continuation.check']), 'recordContinuationCheck');
  if (hasFact(tx, 'judgment', req.judgment)) throw new LedgerError('FACT_CONFLICT', `judgment ${req.judgment} is already committed`);
  const since = inputSince(tx, req.revision);
  if (since > 0) throw new LedgerError('BELOW_FLOOR', `the check answered at revision ${req.revision}; revision ${since} changed the proof inputs since: ask the evaluator again`);
  return { revision: tx.append(rec) };
}

/**
 * Execute a proof-conditioned operation (6.1; 4.1 §4.1). The operation must
 * have been registered as pending; the scope registered with it must not be
 * stopped (a caller tag, if given, must equal it: SCOPE_MISMATCH); the
 * extensions may refuse it (labels recomputing); it executes once. `events`:
 * flow events committed with the execution (the legalization stamp's result).
 */
export function commitProofOp(tx: WriteTx, req: { opId: OpId; tag?: ScopeTag | null; events?: readonly BaseRecord[] }): { revision: Revision } {
  const events = req.events === undefined ? [] : (freeze(req.events) as BaseRecord[]);
  if (!Array.isArray(events)) throw new LedgerError('BAD_REQUEST', 'events is a list of flow.event records');
  if (events.length > MAX_RECORDS_PER_REQUEST) throw new LedgerError('TOO_LARGE', `${events.length} events; the limit is ${MAX_RECORDS_PER_REQUEST}`);
  for (const e of events) checkShape(e, FLOW_EVENT_ONLY, 'commitProofOp');
  const row = tx.stmt('SELECT mission, capabilities FROM op_scopes WHERE op = ?').get(req.opId) as { mission: string; capabilities: string } | undefined;
  if (!row) throw new LedgerError('NOT_PENDING', `operation ${req.opId} was never registered as pending`);
  const scope: ScopeTag = { mission: row.mission as ScopeTag['mission'], capabilities: JSON.parse(row.capabilities) as string[] };
  if (req.tag !== undefined && req.tag !== null && !sameTag(scope, req.tag)) {
    throw new LedgerError('SCOPE_MISMATCH', `operation ${req.opId} was registered with scope (mission ${scope.mission}, capabilities ${JSON.stringify(scope.capabilities)})`);
  }
  assertNotStopped(tx, scope, 'this operation');
  if (hasFact(tx, 'op.executed', req.opId)) throw new LedgerError('FACT_CONFLICT', `operation ${req.opId} was already executed`);
  for (const ext of tx.memory.extensions) ext.gateProof?.(tx, { opId: req.opId });
  const rec: BaseRecord = { kind: 'op.executed', op: req.opId, asOf: tx.head() };
  checkShape(rec, new Set(['op.executed']), 'commitProofOp');
  const revision = appendFact(tx, rec);
  for (const e of events) appendFact(tx, e);
  return { revision };
}

/** A notice to the PM (3.9): it names its WI (3.11), or says it is informational (core review r3 #18). Its body is data. */
export function raiseAlert(tx: WriteTx, req: { alert: AlertId; category: string; wi?: string; informational?: true; body: ContentHash }): { revision: Revision } {
  const rec: BaseRecord = {
    kind: 'alert',
    alert: req.alert,
    category: req.category,
    ...(req.wi !== undefined ? { wi: req.wi } : {}),
    ...(req.informational === true ? { informational: true as const } : {}),
    body: req.body,
  };
  checkShape(rec, new Set(['alert']), 'raiseAlert');
  requireContent(tx.data, rec);
  return { revision: tx.append(rec) };
}

