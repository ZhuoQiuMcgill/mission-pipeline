// The domain checks of the 4.0 ledger service, now inside the memory's write
// transaction (design 4.1 §3.2, §5, §6.6, §6.7; 4.0 6.1-6.6): ported from
// ledger-service, ledger-delivery, ledger-flow, ledger-review-r3 and
// ledger-followup-r3, with launches replaced by dispatches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { id, type AlertId, type BasisLineId, type BasisVersionId, type ContentHash, type MissionId, type OpId, type StopId } from '../src/common/ids.ts';
import { LOOP_CAPS, WI_CATALOG, type BaseRecord, type LoopKind } from '../src/common/records.ts';
import {
  acquireLease,
  appendRecords,
  assertDispatchCurrent,
  authorizeIntent,
  checkQuote,
  claimDispatch,
  closeMission,
  commitProofOp,
  commitStop,
  currentDelivery,
  cursor,
  deliveryInfo,
  dequeueTask,
  dispatchInfo,
  finishIntent,
  flowEvents,
  flowMissions,
  intentInfo,
  latestUserWords,
  leases,
  LedgerError,
  listDispatches,
  listMissions,
  loopState,
  markNotice,
  missionCloses,
  narrowStop,
  noticeDeliveries,
  pmAction,
  pmActions,
  queueTask,
  raiseAlert,
  recheckIntent,
  recordContinuationCheck,
  recordDelivery,
  recordHandback,
  recordLandingPhase,
  recordPmAction,
  recordsByKind,
  recordWords,
  REFUSAL_WI,
  releaseDispatch,
  releaseStop,
  setCursor,
  setMission,
  stopInfo,
  activeStops,
  taskInfo,
  taskQueue,
  withdrawDelivery,
  wordsEntry,
  type Memory,
  type MemoryExtension,
  type WriteTx,
} from '../src/memory/index.ts';
import { project, throwsCode } from './memory-fixtures.ts';

const M = id<MissionId>('m1');
const M2 = id<MissionId>('m2');
const TAG = { mission: M, capabilities: [] as string[] };
const BASE = 'b'.repeat(40);
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const C3 = '3'.repeat(40);
const ref = (op: string): string => `refs/mission-pipeline/delivered/${M}/${op}`;

let n = 0;
/** One write with a fresh operation id. */
function w<T>(m: Memory, fn: (tx: WriteTx) => T): T {
  const op = `op-${++n}`;
  return m.write({ op, payload: op }, fn);
}

function basis(k: number, mission: MissionId | null = M): BaseRecord {
  return { kind: 'basis.version', basisKind: 'requirement', line: id<BasisLineId>(`req-${mission ?? 'p'}`), version: id<BasisVersionId>(`req-${mission ?? 'p'}.v${k}`), mission, scope: null } as BaseRecord;
}

function plan(m: Memory, object: string, extra: Record<string, unknown> = {}): BaseRecord {
  return {
    kind: 'object.version', object: object as never, objectKind: 'plan', mission: M, module: null, content: m.data.put(`body ${object}`),
    prerequisites: m.data.putList([]), scope: { paths: ['p.md'], taskType: 'plan' }, reviews: [{ review: 'r', basisLines: [], reliesOn: [] }], ...extra,
  } as BaseRecord;
}

function judge(m: Memory, judgment: string, target: string, evidence: string[] = [], ext: string | null = null): BaseRecord {
  const e = m.data.putList([]);
  return {
    kind: 'judgment', judgment: judgment as never, target: target as never, review: 'r', executor: 'reviewer', verdict: 'pass', evidence: m.data.putList(evidence), bases: e, constraints: e, reliesOn: e,
    issues: [], revokes: null, extends: ext as never, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [],
  };
}

function event(m: Memory, line: string, ev: string, key: string, body: unknown, mission: MissionId = M): BaseRecord {
  return { kind: 'flow.event', mission, line, event: ev, key, body: m.data.put(JSON.stringify(body)) } as BaseRecord;
}

const evidence = (e: string, fields: Record<string, string> = { exit: '0' }, runClass: 'declared' | 'other' = 'declared'): BaseRecord => ({ kind: 'evidence', evidence: e as never, envLine: 'py' as never, envSnapshot: 's' as never, runClass, fields });

// ---------------------------------------------------------------- facts

test('appendRecords: shapes, kinds, fact identities, data references, size limits; one request is atomic', () => {
  const p = project();
  try {
    const { m } = p;
    throwsCode(() => w(m, (tx) => appendRecords(tx, [{ kind: 'evidence', evidence: 'E' } as never])), 'RECORD_INVALID');
    throwsCode(() => w(m, (tx) => appendRecords(tx, [{ kind: 'nonsense' } as never])), 'KIND_NOT_ALLOWED');
    throwsCode(() => w(m, (tx) => appendRecords(tx, [{ kind: 'op.executed', op: id<OpId>('op-y'), asOf: 1 } as never])), 'KIND_NOT_ALLOWED');
    throwsCode(() => w(m, (tx) => appendRecords(tx, [{ kind: 'run.layer' } as never])), 'KIND_NOT_ALLOWED', /cannot write run.layer/);
    const r1 = w(m, (tx) => appendRecords(tx, [basis(1)]));
    assert.deepEqual(w(m, (tx) => appendRecords(tx, [basis(1)])).revisions, r1.revisions, 'the same fact again: its first revision');
    throwsCode(() => w(m, (tx) => appendRecords(tx, [{ ...basis(1), line: id<BasisLineId>('other') } as BaseRecord])), 'FACT_CONFLICT');
    const list = m.data.putList(['P']);
    const pending = (objects: { hash: ContentHash; count: number }): BaseRecord => ({ kind: 'op.pending', op: id<OpId>('o9'), opKind: 'delivery', objects, scope: { mission: M, capabilities: [] } });
    throwsCode(() => w(m, (tx) => appendRecords(tx, [pending({ ...list, count: 3 })])), 'RECORD_INVALID');
    throwsCode(() => w(m, (tx) => appendRecords(tx, [pending({ hash: '0'.repeat(64) as ContentHash, count: 1 })])), 'CONTENT_MISSING');
    throwsCode(() => w(m, (tx) => appendRecords(tx, [{ ...plan(m, 'X'), content: '1'.repeat(64) } as BaseRecord])), 'CONTENT_MISSING');
    throwsCode(() => w(m, (tx) => appendRecords(tx, [{ kind: 'notice', notice: 'BAD', audience: 'pm', body: 'f'.repeat(64) as ContentHash }])), 'CONTENT_MISSING', /not in the memory/);
    throwsCode(() => w(m, (tx) => appendRecords(tx, Array.from({ length: 1001 }, (_, i) => basis(10 + i)))), 'TOO_LARGE');
    throwsCode(() => w(m, (tx) => appendRecords(tx, [pending({ hash: list.hash, count: 250_001 })])), 'TOO_LARGE');
    // Atomic: an op whose second record is refused commits nothing.
    const head = m.head();
    throwsCode(() => w(m, (tx) => appendRecords(tx, [basis(2), { ...basis(1), line: id<BasisLineId>('x') } as BaseRecord])), 'FACT_CONFLICT');
    assert.equal(m.head(), head);
    // Objects and proof units share one id space (followup-r3 d).
    const unit = (u: string): BaseRecord => ({ kind: 'proof.unit', unit: u as never, members: m.data.putList(['A', 'B']), reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }] });
    w(m, (tx) => appendRecords(tx, [plan(m, 'X')]));
    throwsCode(() => w(m, (tx) => appendRecords(tx, [unit('X')])), 'FACT_CONFLICT');
    w(m, (tx) => appendRecords(tx, [unit('Y')]));
    throwsCode(() => w(m, (tx) => appendRecords(tx, [plan(m, 'Y')])), 'FACT_CONFLICT');
    // A regression registration declares a test file and a runner (r2 F21).
    const cover = (inputs: string[]): BaseRecord => ({ kind: 'issue.coverage', issue: 'N' as never, version: 'X' as never, evidence: 'E1' as never, command: 'npm test', tests: m.data.putList(['t1']), inputs: m.data.putList(inputs) });
    throwsCode(() => w(m, (tx) => appendRecords(tx, [cover([`fixture:a=${'a'.repeat(64)}`])])), 'RECORD_INVALID', /at least one testfile/);
  } finally {
    p.cleanup();
  }
});

test('loops: counters per class and signature, persistent exhaustion, one Secretary grant per lineage across its loops (6.5, WI-08)', () => {
  const p = project();
  try {
    const { m } = p;
    const reason = m.data.put('why');
    const attempt = (lineage: string, loop: LoopKind, signature: string, failureClass: string | null = null) =>
      w(m, (tx) => appendRecords(tx, [{ kind: 'loop.attempt', lineage, loop, failureClass, signature }]));
    const grant = (lineage: string, loop: LoopKind, by: 'secretary' | 'user', extra: number) => w(m, (tx) => appendRecords(tx, [{ kind: 'loop.grant', lineage, loop, by, extra, reason }]));
    attempt('T1', 'env-retry', 'sig-x', 'env');
    attempt('T1', 'env-retry', 'sig-y', 'env');
    attempt('T1', 'env-retry', 'sig-y', 'env');
    assert.deepEqual(loopState(m, 'T1', 'env-retry'), {
      attempts: 3, byClass: { env: 3 }, repeats: 1, secretaryGrants: 0, extra: 0, attemptsAtLastGrant: null, secretaryGrantUsed: false, cap: 6, allowed: 6, exhausted: true, reason: 'no-progress',
    });
    grant('T1', 'env-retry', 'secretary', 2);
    throwsCode(() => grant('T1', 'rework', 'secretary', 1), 'GRANT_LIMIT');
    assert.equal(new LedgerError('GRANT_LIMIT', 'x').wi, 'WI-08');
    throwsCode(() => grant('T1', 'env-retry', 'secretary', 3), 'RECORD_INVALID');
    grant('T1', 'env-retry', 'user', 5);
    assert.deepEqual([loopState(m, 'T1', 'env-retry').allowed, loopState(m, 'T1', 'env-retry').exhausted], [13, false]);
    // Landing attempts: the first + 3, then exhausted; persistent across a reopen.
    const D = 'delivery:m1/op-7';
    assert.equal(LOOP_CAPS['landing-attempt'], 4);
    for (const s of ['a', 'b', 'c', 'd']) attempt(D, 'landing-attempt', s);
    throwsCode(() => attempt(D, 'landing-attempt', 'e'), 'LOOP_EXHAUSTED');
    const m2 = p.reopen();
    throwsCode(() => w(m2, (tx) => appendRecords(tx, [{ kind: 'loop.attempt', lineage: D, loop: 'landing-attempt', failureClass: null, signature: 'e' }])), 'LOOP_EXHAUSTED');
    // Delivery rebuilds never exhaust by repetition; env-retry reports the class cap of the next attempt's class.
    for (const s of ['base moved', 'base moved']) w(m2, (tx) => appendRecords(tx, [{ kind: 'loop.attempt', lineage: 'R', loop: 'delivery-rebuild', failureClass: null, signature: s }]));
    assert.equal(loopState(m2, 'R', 'delivery-rebuild').exhausted, false);
    for (const s of ['a', 'b', 'c']) w(m2, (tx) => appendRecords(tx, [{ kind: 'loop.attempt', lineage: 'E', loop: 'env-retry', failureClass: 'disk', signature: s }]));
    assert.equal(loopState(m2, 'E', 'env-retry', 'disk').reason, 'class-cap');
    assert.equal(loopState(m2, 'E', 'env-retry', 'network').exhausted, false);
    throwsCode(() => loopState(m2, 'E', 'landing-retry' as LoopKind), 'BAD_REQUEST');
  } finally {
    p.cleanup();
  }
});

test('a continuation judgment needs a passing check made at the current proof inputs, and carries exactly the merged inputs (r3 F1, r3 #1)', () => {
  const p = project();
  try {
    const { m } = p;
    w(m, (tx) => appendRecords(tx, [evidence('E1'), evidence('E2'), plan(m, 'A'), judge(m, 'J0', 'A', ['E1'])]));
    const cont = (j: string, ev: string[] = []) => w(m, (tx) => appendRecords(tx, [judge(m, j, 'A', ev, 'J0')]));
    const check = (j: string, result: { ok: boolean; reason?: string; merged?: { evidence: string[]; bases: string[]; constraints: string[]; reliesOn: string[] } }, revision = Number(m.head())) =>
      w(m, (tx) => recordContinuationCheck(tx, { judgment: id(j), extends: id('J0'), target: 'A', revision, result }));
    const e = throwsCode(() => cont('J1'), 'CONTINUATION_REFUSED');
    assert.equal(e.wi, null, 'a normal branch');
    check('J1', { ok: false, reason: 'not-current-outside-changes' });
    throwsCode(() => cont('J1'), 'CONTINUATION_REFUSED', /not-current-outside-changes/);
    const merged = { evidence: ['E2'], bases: [], constraints: [], reliesOn: [] };
    throwsCode(() => check('J2', { ok: true }), 'BAD_REQUEST');
    throwsCode(() => check('J2', { ok: true, merged }, Number(m.head()) + 1), 'BAD_REQUEST', /revision the evaluator answered at/);
    check('J2', { ok: true, merged });
    // An unrelated proof input since the check: ask again.
    w(m, (tx) => appendRecords(tx, [plan(m, 'Z')]));
    throwsCode(() => cont('J2', ['E2']), 'BELOW_FLOOR');
    check('J2', { ok: true, merged });
    throwsCode(() => cont('J2', ['E1']), 'CONTINUATION_REFUSED', /merged/);
    assert.equal(cont('J2', ['E2', 'E2']).revisions.length, 1, 'order and repeats do not matter');
    throwsCode(() => check('J2', { ok: true, merged }), 'FACT_CONFLICT');
    // New evidence is committed first; then the check (at the head) and the judgment, in one write: fine.
    w(m, (tx) => appendRecords(tx, [evidence('E3')]));
    w(m, (tx) => {
      recordContinuationCheck(tx, { judgment: id('J3'), extends: id('J0'), target: 'A', revision: tx.head(), result: { ok: true, merged: { ...merged, evidence: ['E3'] } } });
      return appendRecords(tx, [judge(m, 'J3', 'A', ['E3'], 'J0')]);
    });
  } finally {
    p.cleanup();
  }
});

test('review #7: a continuation check stays bound to the revision the evaluator answered at; every proof input after it, in the same write too, makes it stale', () => {
  const p = project();
  try {
    const { m } = p;
    w(m, (tx) => appendRecords(tx, [plan(m, 'P'), judge(m, 'J0', 'P')]));
    const merged = { evidence: [], bases: [], constraints: [], reliesOn: [] };
    // The reviewer's repro: the evaluator allowed the continuation at revision r0; then J0 was negated.
    const r0 = Number(m.head());
    w(m, (tx) => appendRecords(tx, [{ ...(judge(m, 'JF', 'P') as object), verdict: 'fail', revokes: 'J0' } as BaseRecord]));
    throwsCode(() => w(m, (tx) => recordContinuationCheck(tx, { judgment: id('J1'), extends: id('J0'), target: 'P', revision: r0, result: { ok: true, merged } })), 'BELOW_FLOOR', /answered at revision/);
    assert.equal(m.stmt("SELECT COUNT(*) AS n FROM continuation_checks WHERE judgment = 'J1'").get()!.n, 0);
    // A check recorded at the head, then a proof input in the same write as the judgment: stale.
    w(m, (tx) => recordContinuationCheck(tx, { judgment: id('J2'), extends: id('J0'), target: 'P', revision: tx.head(), result: { ok: true, merged } }));
    assert.equal(Number(m.stmt("SELECT revision FROM continuation_checks WHERE judgment = 'J2'").get()!.revision), Number(m.head()) - 2, 'the evaluator’s revision is kept');
    throwsCode(() => w(m, (tx) => appendRecords(tx, [plan(m, 'Q'), judge(m, 'J2', 'P', [], 'J0')])), 'BELOW_FLOOR');
    throwsCode(
      () =>
        w(m, (tx) => {
          recordContinuationCheck(tx, { judgment: id('J3'), extends: id('J0'), target: 'P', revision: tx.head(), result: { ok: true, merged } });
          appendRecords(tx, [plan(m, 'R')]);
          return appendRecords(tx, [judge(m, 'J3', 'P', [], 'J0')]);
        }),
      'BELOW_FLOOR',
    );
  } finally {
    p.cleanup();
  }
});

test('a renewal is registered only when the renewal rule holds (r3 F14)', () => {
  const p = project();
  try {
    const { m } = p;
    const J = (j: string, fields: string[]): BaseRecord => ({ ...(judge(m, j, 'P') as object), evidenceUse: { fields, statisticalOrExternal: false } }) as unknown as BaseRecord;
    w(m, (tx) => appendRecords(tx, [plan(m, 'P'), evidence('E1', { exit: '0', 'time:ms': '10' }), evidence('E2', { exit: '0', 'time:ms': '12' }), evidence('E3', { exit: '1' }), evidence('E4', { exit: '0' }, 'other'), J('J', ['exit']), J('JT', ['exit', 'time:ms'])]));
    const renew = (judgment: string, original: string, replacement: string) => w(m, (tx) => appendRecords(tx, [{ kind: 'evidence.renewal', judgment: judgment as never, original: original as never, replacement: replacement as never }]));
    renew('J', 'E1', 'E2');
    const e = throwsCode(() => renew('J', 'E2', 'E3'), 'RENEWAL_REFUSED', /field-differs/);
    assert.equal(e.wi, null);
    throwsCode(() => renew('JT', 'E1', 'E2'), 'RENEWAL_REFUSED', /uses-timing/);
    throwsCode(() => renew('J', 'E1', 'E4'), 'RENEWAL_REFUSED', /not-declared/);
    throwsCode(() => renew('J', 'E1', 'NOPE'), 'RECORD_INVALID');
  } finally {
    p.cleanup();
  }
});

test('a proof-conditioned operation executes once, only when pending, outside stops of its registered scope, with its flow events; extensions may hold it', () => {
  let recomputing = false;
  const gate: MemoryExtension = {
    name: 'labels-gate',
    gateProof: () => {
      if (recomputing) throw new LedgerError('BELOW_FLOOR', 'labels are recomputing');
    },
  };
  const p = project({ extensions: [gate] });
  try {
    const { m } = p;
    const objects = m.data.putList([]);
    w(m, (tx) => appendRecords(tx, [{ kind: 'op.pending', op: id<OpId>('LG1'), opKind: 'legalization', objects, scope: { mission: M, capabilities: [] } }, { kind: 'op.pending', op: id<OpId>('OP2'), opKind: 'delivery', objects, scope: { mission: M, capabilities: ['net'] } }]));
    throwsCode(() => w(m, (tx) => commitProofOp(tx, { opId: id<OpId>('never') })), 'NOT_PENDING');
    throwsCode(() => w(m, (tx) => commitProofOp(tx, { opId: id<OpId>('OP2'), tag: { mission: M, capabilities: [] } })), 'SCOPE_MISMATCH');
    const result = event(m, 'audit:L1', 'result', 'LG1', { stamped: true });
    throwsCode(() => w(m, (tx) => commitProofOp(tx, { opId: id<OpId>('LG1'), events: [basis(9)] })), 'KIND_NOT_ALLOWED');
    recomputing = true;
    throwsCode(() => w(m, (tx) => commitProofOp(tx, { opId: id<OpId>('LG1'), events: [result] })), 'BELOW_FLOOR', /recomputing/);
    assert.equal(flowEvents(m, { mission: M, line: 'audit:L1' }).length, 0, 'nothing written, the result event neither');
    recomputing = false;
    const out = m.write({ op: 'x', payload: 'LG1' }, (tx) => commitProofOp(tx, { opId: id<OpId>('LG1'), events: [result] }));
    assert.deepEqual(flowEvents(m, { mission: M, line: 'audit:L1' }).map((e) => [e.event, e.key]), [['result', 'LG1']]);
    assert.deepEqual(m.write({ op: 'x', payload: 'LG1' }, () => null), out, 'a retry returns the first answer');
    throwsCode(() => w(m, (tx) => commitProofOp(tx, { opId: id<OpId>('LG1') })), 'FACT_CONFLICT');
    m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-net'), scope: { kind: 'capability', capability: 'net' }, words: 'no network', at: 1 }));
    throwsCode(() => w(m, (tx) => commitProofOp(tx, { opId: id<OpId>('OP2') })), 'STOPPED');
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------- stops

test('stops: recorded with their words entry; in scope, dispatches and actions are refused; narrowing in one transaction; release', () => {
  const p = project();
  try {
    const { m } = p;
    const card = m.data.put('spec');
    w(m, (tx) => {
      setMission(tx, M, 'open');
      for (const t of ['T1', 'T2', 'T3']) queueTask(tx, { task: t, lineage: t, mission: M, card });
      queueTask(tx, { task: 'U1', lineage: 'U1', mission: M2, card });
      claimDispatch(tx, { dispatch: 'D-1', task: 'T1', seat: 'constructor' });
      return null;
    });
    const s = m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-all'), scope: { kind: 'all' }, words: '全停', at: 1, wordsEntry: 'W-4' }));
    assert.deepEqual(s, { committed: true, inFlight: 1 }, 'stop recorded; one dispatch was in flight');
    assert.deepEqual(m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-all'), scope: { kind: 'all' }, words: '全停', at: 1 })), { committed: false, inFlight: 1 });
    assert.equal(stopInfo(m, id<StopId>('S-all'))?.wordsEntry, 'W-4');
    throwsCode(() => m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-x'), scope: { kind: 'all' }, words: 'x', at: 1, wordsEntry: 'msg-3' })), 'BAD_REQUEST');
    throwsCode(() => w(m, (tx) => claimDispatch(tx, { dispatch: 'D-2', task: 'T2', seat: 'reviewer' })), 'STOPPED');
    throwsCode(() => w(m, (tx) => authorizeIntent(tx, { intent: 'i1', kind: 'network', domain: 'n1', tag: TAG, details: {} })), 'STOPPED');
    throwsCode(() => w(m, (tx) => narrowStop(tx, { old: id<StopId>('S-all'), stop: { stop: id<StopId>('S-all-2'), scope: { kind: 'all' }, words: 'x', at: 2 } })), 'BAD_REQUEST', /is the old scope/);
    const out = m.write({ stop: true }, (tx) => narrowStop(tx, { old: id<StopId>('S-all'), stop: { stop: id<StopId>('S-m1'), scope: { kind: 'mission', mission: M }, words: '只停 m1', at: 2 } }));
    assert.deepEqual(out as unknown, { old: 'S-all', stop: 'S-m1', narrowed: true });
    const log = recordsByKind(m, { kinds: ['stop.committed', 'stop.released'] });
    const [c, r] = log.slice(-2);
    assert.deepEqual([c!.record.kind, r!.record.kind, r!.revision - c!.revision], ['stop.committed', 'stop.released', 1], 'one transaction, nothing between them');
    assert.deepEqual(activeStops(m).map((x) => [x.stop, x.narrows]) as unknown, [['S-m1', 'S-all']]);
    // The narrower scope stays restricted; the rest is free.
    throwsCode(() => w(m, (tx) => claimDispatch(tx, { dispatch: 'D-2', task: 'T2', seat: 'reviewer' })), 'STOPPED');
    w(m, (tx) => claimDispatch(tx, { dispatch: 'D-9', task: 'U1', seat: 'reviewer' }));
    assert.deepEqual(m.write({ stop: true }, (tx) => narrowStop(tx, { old: id<StopId>('S-all'), stop: { stop: id<StopId>('S-m1'), scope: { kind: 'mission', mission: M }, words: '只停 m1', at: 2 } })) as unknown, { old: 'S-all', stop: 'S-m1', narrowed: false });
    throwsCode(() => w(m, (tx) => narrowStop(tx, { old: id<StopId>('S-m1'), stop: { stop: id<StopId>('S-cap'), scope: { kind: 'capability', capability: 'net' }, words: 'x', at: 3 } })), 'BAD_REQUEST', /not within/);
    assert.deepEqual(w(m, (tx) => releaseStop(tx, id<StopId>('S-m1'))), { released: true });
    assert.deepEqual(w(m, (tx) => releaseStop(tx, id<StopId>('S-m1'))), { released: false });
    w(m, (tx) => claimDispatch(tx, { dispatch: 'D-2', task: 'T2', seat: 'reviewer' }));
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------- dispatches

test('dispatches: a step is claimed once; one hand-back per dispatch; late hand-backs after a release or a stop are recorded, not accepted', () => {
  const p = project();
  try {
    const { m } = p;
    const root = join(p.dir, '.mission-pipeline');
    const card = m.data.put('spec');
    w(m, (tx) => {
      for (const t of ['T1', 'T2', 'T3']) queueTask(tx, { task: t, lineage: `lin-${t}`, mission: M, card });
      return null;
    });
    const c = w(m, (tx) => claimDispatch(tx, { dispatch: 'D-1', task: 'T1', seat: 'constructor', capabilities: ['shell'], filler: { harness: 'claude-code', model: 'opus' }, worktree: true, card: '# Card D-1\n' }));
    assert.equal(c.worktree, 'worktrees/D-1');
    assert.equal(readFileSync(join(root, 'missions', 'm1', 'dispatches', 'D-1', 'card.md'), 'utf8'), '# Card D-1\n');
    throwsCode(() => w(m, (tx) => claimDispatch(tx, { dispatch: 'D-1b', task: 'T1', seat: 'constructor' })), 'NOT_QUEUED', /claimed by D-1/);
    throwsCode(() => w(m, (tx) => claimDispatch(tx, { dispatch: 'D-1', task: 'T2', seat: 'reviewer' })), 'FACT_CONFLICT');
    throwsCode(() => w(m, (tx) => claimDispatch(tx, { dispatch: 'D:1', task: 'T2', seat: 'reviewer' })), 'BAD_REQUEST');
    throwsCode(() => w(m, (tx) => queueTask(tx, { task: 'T1', lineage: 'lin-T1', mission: M, card })), 'FACT_CONFLICT', /still in flight/);
    assert.equal(taskInfo(m, 'T1')?.dispatch, 'D-1');
    assert.equal(dispatchInfo(m, 'D-1')?.filler?.harness, 'claude-code');
    assertDispatchCurrent(m, 'D-1');
    // Leases.
    w(m, (tx) => acquireLease(tx, { resource: 'gpu-0', dispatch: 'D-1' }));
    assert.deepEqual(w(m, (tx) => acquireLease(tx, { resource: 'gpu-0', dispatch: 'D-1' })), { acquired: false });
    // One hand-back.
    const h = w(m, (tx) => recordHandback(tx, { dispatch: 'D-1', report: '# Report\n', result: { verdict: 'done', standards: [1, 2] }, filler: { harness: 'codex', model: null } }));
    assert.deepEqual([h.outcome, h.accepted, h.repeated], ['accepted', true, false]);
    assert.equal(w(m, (tx) => recordHandback(tx, { dispatch: 'D-1', report: '# Report\n', result: { standards: [1, 2], verdict: 'done' } })).repeated, true, 'the same content again: a no-op');
    throwsCode(() => w(m, (tx) => recordHandback(tx, { dispatch: 'D-1', report: '# Another report\n' })), 'FACT_CONFLICT', /one hand-back per dispatch/);
    assert.deepEqual(leases(m), [], 'the hand-back frees its leases');
    assert.equal(m.data.text(dispatchInfo(m, 'D-1')!.result!), '{"standards":[1,2],"verdict":"done"}');
    assert.equal(m.readLeaf(h.report!)?.status, 'ok');
    throwsCode(() => assertDispatchCurrent(m, 'D-1'), 'UNRECOGNIZED_LAUNCH');
    throwsCode(() => w(m, (tx) => recordHandback(tx, { dispatch: 'D-404' })), 'UNKNOWN_DISPATCH');
    // Released abandoned: queued again at once; its leases stay held; its late hand-back is recorded, not accepted.
    w(m, (tx) => claimDispatch(tx, { dispatch: 'D-2', task: 'T2', seat: 'reviewer' }));
    w(m, (tx) => acquireLease(tx, { resource: 'db-1', dispatch: 'D-2' }));
    assert.deepEqual(w(m, (tx) => releaseDispatch(tx, { dispatch: 'D-2', how: 'abandoned' })), { released: true, requeued: true });
    assert.equal(taskInfo(m, 'T2')?.state, 'queued');
    assert.deepEqual(leases(m).map((l) => [l.resource, l.dispatch]), [['db-1', 'D-2']]);
    w(m, (tx) => claimDispatch(tx, { dispatch: 'D-2b', task: 'T2', seat: 'reviewer' }));
    throwsCode(() => w(m, (tx) => acquireLease(tx, { resource: 'db-1', dispatch: 'D-2b' })), 'DOMAIN_BUSY', /held by dispatch D-2/);
    const late = w(m, (tx) => recordHandback(tx, { dispatch: 'D-2', report: '# late\n' }));
    assert.deepEqual([late.outcome, late.accepted], ['after-release', false]);
    assert.equal(dispatchInfo(m, 'D-2')?.state, 'released');
    assert.deepEqual(leases(m).length, 1, 'still held until the PM releases it as ended');
    assert.deepEqual(w(m, (tx) => releaseDispatch(tx, { dispatch: 'D-2', how: 'ended' })), { released: true, requeued: false });
    assert.deepEqual(leases(m), []);
    assert.deepEqual(w(m, (tx) => releaseDispatch(tx, { dispatch: 'D-2', how: 'ended' })), { released: false, requeued: false });
    assert.equal(taskInfo(m, 'T2')?.dispatch, 'D-2b', 'the step stays with its new dispatch');
    // A hand-back inside a stop's scope: recorded, not accepted.
    w(m, (tx) => claimDispatch(tx, { dispatch: 'D-3', task: 'T3', seat: 'reviewer' }));
    m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S1'), scope: { kind: 'mission', mission: M }, words: 'stop', at: 1 }));
    const stopped = w(m, (tx) => recordHandback(tx, { dispatch: 'D-3', report: '# after the stop\n' }));
    assert.deepEqual([stopped.outcome, stopped.accepted], ['after-stop', false]);
    assert.deepEqual(listDispatches(m, { state: 'in-flight' }).map((d) => d.dispatch), ['D-2b']);
    assert.deepEqual(listDispatches(m, { task: 'T2' }).map((d) => [d.dispatch, d.state, d.handback]), [['D-2', 'released', 'after-release'], ['D-2b', 'in-flight', null]]);
  } finally {
    p.cleanup();
  }
});

test('the task queue: queued, claimed, cancelled, superseded; a task keeps its lineage; queued again once its dispatch ended', () => {
  const p = project();
  try {
    const { m } = p;
    const card = (t: string): ContentHash => m.data.put(`card ${t}`);
    for (const t of ['T1', 'T2', 'T3', 'T4']) w(m, (tx) => queueTask(tx, { task: t, lineage: `lin-${t}`, mission: t === 'T4' ? M2 : M, card: card(t) }));
    assert.deepEqual(w(m, (tx) => queueTask(tx, { task: 'T1', lineage: 'lin-T1', mission: M, card: card('T1') })), { revision: taskInfo(m, 'T1')!.queuedRevision }, 'same card: no-op');
    throwsCode(() => w(m, (tx) => queueTask(tx, { task: 'T1', lineage: 'lin-T1', mission: M, card: card('T1 v2') })), 'FACT_CONFLICT');
    throwsCode(() => w(m, (tx) => queueTask(tx, { task: 'T1', lineage: 'other', mission: M, card: card('T1') })), 'FACT_CONFLICT');
    throwsCode(() => w(m, (tx) => queueTask(tx, { task: 'T9', lineage: 'x', mission: M, card: 'c'.repeat(64) as ContentHash })), 'CONTENT_MISSING');
    w(m, (tx) => claimDispatch(tx, { dispatch: 'D-1', task: 'T1', seat: 'constructor' }));
    w(m, (tx) => dequeueTask(tx, { task: 'T2', reason: 'cancelled' }));
    w(m, (tx) => dequeueTask(tx, { task: 'T3', reason: 'superseded', by: 'T3b' }));
    w(m, (tx) => queueTask(tx, { task: 'T3b', lineage: 'lin-T3', mission: M, card: card('T3b') }));
    throwsCode(() => w(m, (tx) => dequeueTask(tx, { task: 'T1', reason: 'cancelled' })), 'NOT_QUEUED');
    throwsCode(() => w(m, (tx) => dequeueTask(tx, { task: 'T4', reason: 'dispatched' as never })), 'BAD_REQUEST');
    assert.deepEqual(taskQueue(m).map((t) => t.task), ['T4', 'T3b']);
    assert.deepEqual(taskQueue(m, M2).map((t) => t.task), ['T4']);
    assert.deepEqual([taskInfo(m, 'T3')?.state, taskInfo(m, 'T3')?.by, taskInfo(m, 'T2')?.state], ['superseded', 'T3b', 'cancelled']);
    // After its hand-back, the flow may queue the step again (rework).
    w(m, (tx) => recordHandback(tx, { dispatch: 'D-1', report: '# r\n' }));
    w(m, (tx) => queueTask(tx, { task: 'T1', lineage: 'lin-T1', mission: M, card: card('T1') }));
    assert.equal(taskInfo(m, 'T1')?.state, 'queued');
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------- deliveries and intents

function authorizeLanding(m: Memory, op: string, commit: string, opts: { base?: string; targetBranch?: string; delivery?: unknown; domain?: string } = {}): string {
  const intent = `land-${op}-${++n}`;
  const delivery = opts.delivery !== undefined ? opts.delivery : { mission: M, op, commit, base: opts.base ?? BASE, targetBranch: opts.targetBranch ?? 'main' };
  w(m, (tx) => authorizeIntent(tx, { intent, kind: 'landing', domain: opts.domain ?? `landing:repo-${n}`, tag: TAG, details: { landing: `L-${n}`, ...(delivery !== null ? { delivery } : {}) } }));
  return intent;
}

function authorizeRef(m: Memory, op: string, commit: string, extra: { manifest?: string } = {}): string {
  const intent = `dref-${op}-${++n}`;
  const delivery = { mission: M, op, commit, base: BASE, ref: ref(op), targetBranch: 'main', ...(extra.manifest ? { manifest: extra.manifest } : {}) };
  w(m, (tx) => authorizeIntent(tx, { intent, kind: 'delivery-ref', domain: `ref:${ref(op)}`, tag: TAG, details: { ref: ref(op), commit, base: BASE, delivery } }));
  return intent;
}

function record(m: Memory, op: string, commit: string, target: string | null = 'main') {
  return w(m, (tx) => recordDelivery(tx, { mission: M, delivery: op, commit, base: BASE, ref: ref(op), manifest: m.data.put(`manifest ${op} ${commit}`), target }));
}

test('a landing is authorized only for the mission’s current delivery; a withdrawn one never; a stop is reported first (WI-06)', () => {
  const p = project();
  try {
    const { m } = p;
    throwsCode(() => authorizeLanding(m, 'op-1', C1), 'DELIVERY_NOT_CURRENT', /no delivery of mission m1 is recorded/);
    record(m, 'op-1', C1);
    const i1 = authorizeLanding(m, 'op-1', C1);
    assert.deepEqual(intentInfo(m, i1)?.delivery, { mission: M, op: 'op-1', commit: C1, base: BASE, ref: ref('op-1'), targetBranch: 'main', manifest: deliveryInfo(m, M, 'op-1')?.manifest, description: null });
    record(m, 'op-2', C2);
    throwsCode(() => authorizeLanding(m, 'op-1', C1), 'DELIVERY_NOT_CURRENT', /latest recorded delivery is op-2/);
    const i2 = authorizeLanding(m, 'op-2', C2);
    throwsCode(() => authorizeLanding(m, 'op-2', C3), 'DELIVERY_NOT_CURRENT', /not commit/);
    throwsCode(() => authorizeLanding(m, 'op-2', C2, { base: 'c'.repeat(40) }), 'DELIVERY_NOT_CURRENT', /base/);
    throwsCode(() => authorizeLanding(m, 'op-2', C2, { targetBranch: 'release' }), 'DELIVERY_NOT_CURRENT', /target branch main/);
    throwsCode(() => authorizeLanding(m, 'op-2', C2, { delivery: null }), 'DELIVERY_NOT_CURRENT', /names no delivery/);
    throwsCode(() => authorizeLanding(m, 'op-2', C2, { delivery: { mission: M, op: 'op-2', commit: 'nope', base: BASE } }), 'BAD_REQUEST');
    throwsCode(() => authorizeLanding(m, 'op-2', C2, { delivery: { mission: M2, op: 'op-2', commit: C2, base: BASE, targetBranch: 'main' } }), 'SCOPE_MISMATCH');
    assert.equal(new LedgerError('DELIVERY_NOT_CURRENT', 'x').wi, 'WI-06');
    // One open intent per conflict domain; a finished one frees it.
    const a = authorizeLanding(m, 'op-2', C2, { domain: 'landing:main' });
    throwsCode(() => authorizeLanding(m, 'op-2', C2, { domain: 'landing:main' }), 'DOMAIN_BUSY');
    // A retry of the open intent is checked like a new landing.
    assert.equal(w(m, (tx) => recheckIntent(tx, a)).state, 'authorized');
    assert.deepEqual(w(m, (tx) => finishIntent(tx, { intent: a, outcome: 'done' })), { state: 'done' });
    assert.deepEqual(w(m, (tx) => finishIntent(tx, { intent: a, outcome: 'failed' })), { state: 'done' }, 'a finished intent stays as it is');
    throwsCode(() => w(m, (tx) => recheckIntent(tx, a)), 'BAD_REQUEST', /not open/);
    authorizeLanding(m, 'op-2', C2, { domain: 'landing:main' });
    // Withdrawn: never current again; the earlier one stays superseded.
    throwsCode(() => w(m, (tx) => withdrawDelivery(tx, { mission: M, delivery: 'op-9', reason: 'x' })), 'BAD_REQUEST');
    assert.ok(w(m, (tx) => withdrawDelivery(tx, { mission: M, delivery: 'op-2', reason: 'the user withdrew the delivery' })).revision !== null);
    assert.deepEqual(w(m, (tx) => withdrawDelivery(tx, { mission: M, delivery: 'op-2', reason: 'again' })), { revision: null });
    throwsCode(() => w(m, (tx) => recheckIntent(tx, i2)), 'DELIVERY_NOT_CURRENT', /withdrawn/);
    throwsCode(() => authorizeLanding(m, 'op-1', C1), 'DELIVERY_NOT_CURRENT', /latest recorded delivery is op-2 \(withdrawn\)/);
    record(m, 'op-3', C3);
    const i3 = authorizeLanding(m, 'op-3', C3);
    // A committed stop is the safety floor: reported first, also for a retry.
    m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('s1'), scope: { kind: 'mission', mission: M }, words: '停', at: 1 }));
    throwsCode(() => authorizeLanding(m, 'op-1', C1), 'STOPPED');
    throwsCode(() => w(m, (tx) => recheckIntent(tx, i3)), 'STOPPED');
  } finally {
    p.cleanup();
  }
});

test('delivery refs and records: not withdrawn, not superseded, never re-pointed; one record per delivery', () => {
  const p = project();
  try {
    const { m } = p;
    throwsCode(() => w(m, (tx) => authorizeIntent(tx, { intent: 'x', kind: 'delivery-ref', domain: 'ref:x', tag: TAG, details: { ref: ref('op-1'), commit: C1, base: BASE } })), 'DELIVERY_NOT_CURRENT', /names no delivery/);
    throwsCode(
      () => w(m, (tx) => authorizeIntent(tx, { intent: 'y', kind: 'delivery-ref', domain: 'ref:y', tag: TAG, details: { ref: ref('op-1'), commit: C2, base: BASE, delivery: { mission: M, op: 'op-1', commit: C1, base: BASE, ref: ref('op-1') } } })),
      'BAD_REQUEST',
      /details.commit differs/,
    );
    const a1 = authorizeRef(m, 'op-1', C1);
    assert.equal(deliveryInfo(m, M, 'op-1')?.state, 'creating');
    assert.equal(currentDelivery(m, M), null, 'a delivery being created is not current for landing');
    w(m, (tx) => finishIntent(tx, { intent: a1, outcome: 'failed' }));
    const b1 = authorizeRef(m, 'op-2', C3);
    throwsCode(() => authorizeRef(m, 'op-1', C2), 'DELIVERY_NOT_CURRENT', /superseded by the mission's later delivery op-2 \(creating\)/);
    record(m, 'op-2', C3);
    w(m, (tx) => finishIntent(tx, { intent: b1, outcome: 'done' }));
    const b2 = authorizeRef(m, 'op-2', C3);
    w(m, (tx) => finishIntent(tx, { intent: b2, outcome: 'done' }));
    throwsCode(() => authorizeRef(m, 'op-2', C1), 'DELIVERY_NOT_CURRENT', /never re-pointed/);
    throwsCode(() => authorizeRef(m, 'op-4', C1, { manifest: 'f'.repeat(64) }), 'CONTENT_MISSING');
    // One record per delivery.
    const first = record(m, 'op-5', C1);
    const manifest = m.data.put('another manifest');
    assert.equal(w(m, (tx) => recordDelivery(tx, { mission: M, delivery: 'op-5', commit: C1, base: BASE, ref: ref('op-5'), manifest })).revision, first.revision);
    throwsCode(() => w(m, (tx) => recordDelivery(tx, { mission: M, delivery: 'op-5', commit: C2, base: BASE, ref: ref('op-5'), manifest })), 'FACT_CONFLICT', /never re-pointed/);
    throwsCode(() => w(m, (tx) => recordDelivery(tx, { mission: M, delivery: 'op-6', commit: C1, base: BASE, ref: ref('op-6'), manifest, description: 'e'.repeat(64) as ContentHash })), 'CONTENT_MISSING');
    // Landing phases only move forward.
    w(m, (tx) => recordLandingPhase(tx, { landing: 'L-1', intent: null, phase: 'push', data: { b: BASE } }));
    throwsCode(() => w(m, (tx) => recordLandingPhase(tx, { landing: 'L-1', intent: null, phase: 'admitted', data: {} })), 'BAD_REQUEST', /cannot go back/);
    w(m, (tx) => recordLandingPhase(tx, { landing: 'L-1', intent: null, phase: 'done', data: {} }));
    throwsCode(() => w(m, (tx) => recordLandingPhase(tx, { landing: 'L-1', intent: null, phase: 'refused', data: {} })), 'BAD_REQUEST', /already ended/);
  } finally {
    p.cleanup();
  }
});

test('review #8: a landing intent names only data the memory holds (its delivery’s, or the request’s description)', () => {
  const p = project();
  try {
    const { m } = p;
    w(m, (tx) => recordDelivery(tx, { mission: M, delivery: 'D', commit: C1, base: BASE, ref: ref('D'), target: 'main', manifest: tx.data.put('manifest') }));
    const land = (description: string) =>
      w(m, (tx) => authorizeIntent(tx, { intent: `I-${description.slice(0, 4)}`, kind: 'landing', domain: 'main', tag: TAG, details: { delivery: { mission: M, op: 'D', commit: C1, base: BASE, targetBranch: 'main', description } } }));
    throwsCode(() => land('f'.repeat(64)), 'CONTENT_MISSING');
    assert.equal(intentInfo(m, 'I-ffff'), null);
    const real = m.data.put('{"transform":"v1"}');
    land(real);
    assert.equal(intentInfo(m, `I-${real.slice(0, 4)}`)?.delivery?.description, real);
  } finally {
    p.cleanup();
  }
});

test('review #6: dispatch and mission ids that differ only in letter case are refused (one folder on Windows and macOS)', () => {
  const p = project();
  try {
    const { m } = p;
    const card = m.data.put('spec');
    w(m, (tx) => {
      setMission(tx, id<MissionId>('Login'), 'open');
      for (const t of ['T1', 'T2']) queueTask(tx, { task: t, lineage: t, mission: M, card });
      return claimDispatch(tx, { dispatch: 'D-a', task: 'T1', seat: 'reviewer', card: '# a\n' });
    });
    throwsCode(() => w(m, (tx) => claimDispatch(tx, { dispatch: 'D-A', task: 'T2', seat: 'reviewer', card: '# A\n' })), 'FACT_CONFLICT', /differs only in letter case/);
    throwsCode(() => w(m, (tx) => setMission(tx, id<MissionId>('login'), 'open')), 'BAD_REQUEST', /differs only in letter case/);
    // Round 2: every entry that names a mission first checks it too.
    throwsCode(() => w(m, (tx) => closeMission(tx, { mission: id<MissionId>('login'), mode: 'with-risk' })), 'BAD_REQUEST', /differs only in letter case/);
    throwsCode(() => w(m, (tx) => queueTask(tx, { task: 'T9', lineage: 'T9', mission: id<MissionId>('LOGIN'), card })), 'BAD_REQUEST', /differs only in letter case/);
    assert.deepEqual(listMissions(m, 'all').map((x) => x.mission), ['Login']);
    w(m, (tx) => setMission(tx, id<MissionId>('Login'), 'closed'));
    assert.equal(m.readLeaf('missions/m1/dispatches/D-a/card.md')?.text, '# a\n');
  } finally {
    p.cleanup();
  }
});

test('review #11: a failure class named like an Object property ("constructor") is counted like any other', () => {
  const p = project();
  try {
    const { m } = p;
    for (let k = 0; k < 4; k++) w(m, (tx) => appendRecords(tx, [{ kind: 'loop.attempt', lineage: 'L', loop: 'env-retry', failureClass: 'constructor', signature: `sig${k}` }]));
    const st = loopState(m, 'L', 'env-retry', 'constructor');
    assert.equal(st.byClass.constructor, 4);
    assert.equal(st.reason, 'class-cap');
    assert.equal(loopState(m, 'L', 'env-retry', 'toString').reason, null);
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------- flow events, notices, PM actions, missions

test('flow.event: identity (mission, line, event, key); the same body is a no-op, another FACT_CONFLICT; indexed and paged reads', () => {
  const p = project();
  try {
    const { m } = p;
    const r = w(m, (tx) => appendRecords(tx, [event(m, 'plan', 'pm-batch', '1', { n: 1 }), plan(m, 'pmplan.m1.1')]));
    assert.deepEqual(w(m, (tx) => appendRecords(tx, [event(m, 'plan', 'pm-batch', '1', { n: 1 })])).revisions, [r.revisions[0]]);
    throwsCode(() => w(m, (tx) => appendRecords(tx, [event(m, 'plan', 'pm-batch', '1', { n: 2 })])), 'FACT_CONFLICT');
    w(m, (tx) => appendRecords(tx, [event(m, 'task:a', 'consumed', 'b:c', 1), event(m, 'task:a:b', 'consumed', 'c', 2)]));
    const bad = (x: Record<string, unknown>) => w(m, (tx) => appendRecords(tx, [{ ...event(m, 'plan', 'x', 'k', 0), ...x } as BaseRecord]));
    throwsCode(() => bad({ event: 'Has Space' }), 'RECORD_INVALID', /event is 1 to 64/);
    throwsCode(() => bad({ line: 'a\nb' }), 'RECORD_INVALID');
    throwsCode(() => bad({ body: 'f'.repeat(64) }), 'CONTENT_MISSING');
    const recs: BaseRecord[] = [];
    for (let i = 0; i < 25; i++) recs.push(event(m, 'sec', 'decision', `k${i}`, { i }));
    recs.push(event(m, 'plan', 'pm-batch', 'other', 0, M2));
    w(m, (tx) => appendRecords(tx, recs));
    const pages: string[] = [];
    for (let after = 0; ; ) {
      const page = flowEvents(m, { mission: M, line: 'sec', after, limit: 10 });
      pages.push(...page.map((e) => e.key));
      if (page.length < 10) break;
      after = page[page.length - 1]!.revision;
    }
    assert.deepEqual(pages, Array.from({ length: 25 }, (_, i) => `k${i}`));
    assert.deepEqual(JSON.parse(m.data.text(flowEvents(m, { mission: M, line: 'sec', limit: 1 })[0]!.body)), { i: 0 });
    throwsCode(() => flowEvents(m, { mission: M, limit: 0 }), 'BAD_REQUEST');
    assert.deepEqual(flowMissions(m), [M, M2]);
    assert.deepEqual(recordsByKind(m, { kinds: ['object.version'], mission: M }).map((c) => (c.record as { object: string }).object), ['pmplan.m1.1']);
  } finally {
    p.cleanup();
  }
});

test('notices: delivered, then acknowledged, never back; PM actions: started, done or failed, done final; alerts name a WI', () => {
  const p = project();
  try {
    const { m } = p;
    assert.deepEqual(noticeDeliveries(m, ['A1']), []);
    assert.deepEqual(w(m, (tx) => markNotice(tx, { notice: 'A1', state: 'delivered' })), { state: 'delivered', changed: true });
    assert.deepEqual(w(m, (tx) => markNotice(tx, { notice: 'A1', state: 'delivered' })), { state: 'delivered', changed: false });
    assert.deepEqual(w(m, (tx) => markNotice(tx, { notice: 'A1', state: 'acknowledged' })), { state: 'acknowledged', changed: true });
    assert.deepEqual(w(m, (tx) => markNotice(tx, { notice: 'A1', state: 'delivered' })), { state: 'acknowledged', changed: false }, 'never back');
    throwsCode(() => w(m, (tx) => markNotice(tx, { notice: 'x\ny', state: 'delivered' })), 'BAD_REQUEST');
    const start = { action: 'resume-1', command: 'resume', args: { answer: 'no' }, wi: 'WI-12', state: 'started' as const };
    assert.equal(w(m, (tx) => recordPmAction(tx, start)).state, 'started');
    assert.equal(w(m, (tx) => recordPmAction(tx, start)).revision, null);
    throwsCode(() => w(m, (tx) => recordPmAction(tx, { ...start, args: { answer: 'yes' } })), 'OP_CONFLICT');
    w(m, (tx) => recordPmAction(tx, { ...start, state: 'failed', result: { error: 'BUSY' } }));
    w(m, (tx) => recordPmAction(tx, start));
    w(m, (tx) => recordPmAction(tx, { ...start, state: 'done', result: { resumed: true } }));
    assert.deepEqual(w(m, (tx) => recordPmAction(tx, { ...start, state: 'failed', result: {} })), { state: 'done', revision: null }, 'done is final');
    const a = pmAction(m, 'resume-1')!;
    assert.deepEqual(JSON.parse(m.data.text(a.result!)), { resumed: true });
    assert.deepEqual(JSON.parse(m.data.text(a.args)), { command: 'resume', args: { answer: 'no' } });
    assert.deepEqual(pmActions(m).map((x) => x.action), ['resume-1']);
    throwsCode(() => w(m, (tx) => recordPmAction(tx, { ...start, action: 'x', wi: 'WI-xx' })), 'BAD_REQUEST');
    w(m, (tx) => raiseAlert(tx, { alert: id<AlertId>('a-1'), category: 'flow', wi: 'WI-23', body: m.data.put('body') }));
    throwsCode(() => w(m, (tx) => raiseAlert(tx, { alert: id<AlertId>('a-2'), category: 'flow', wi: 'WI-99', body: m.data.put('x') })), 'RECORD_INVALID');
    throwsCode(() => w(m, (tx) => raiseAlert(tx, { alert: id<AlertId>('a-3'), category: 'flow', informational: true, body: 'e'.repeat(64) as ContentHash })), 'CONTENT_MISSING');
  } finally {
    p.cleanup();
  }
});

test('missions: open with a valid id; closing freezes a snapshot (head revision, queued tasks, dispatches in flight, the caller’s document)', () => {
  const p = project();
  try {
    const { m } = p;
    throwsCode(() => w(m, (tx) => setMission(tx, 'a.b' as MissionId, 'open')), 'BAD_REQUEST', /no "\."/);
    w(m, (tx) => setMission(tx, M, 'open'));
    w(m, (tx) => setMission(tx, M2, 'open'));
    const card = m.data.put('card');
    for (const t of ['T1', 'T2', 'T3']) w(m, (tx) => queueTask(tx, { task: t, lineage: `lin-${t}`, mission: M, card }));
    w(m, (tx) => claimDispatch(tx, { dispatch: 'D-2', task: 'T2', seat: 'reviewer' }));
    w(m, (tx) => claimDispatch(tx, { dispatch: 'D-3', task: 'T3', seat: 'reviewer' }));
    w(m, (tx) => releaseDispatch(tx, { dispatch: 'D-3', how: 'ended', requeue: false }));
    throwsCode(() => w(m, (tx) => closeMission(tx, { mission: M, mode: 'full', snapshot: 'f'.repeat(64) as ContentHash })), 'CONTENT_MISSING');
    throwsCode(() => w(m, (tx) => closeMission(tx, { mission: M, mode: 'soon' as never })), 'BAD_REQUEST');
    const snapshot = m.data.put('{"risks":["r1"]}');
    const head = Number(m.head());
    const c1 = m.write({ op: 'c1', payload: 1 }, (tx) => closeMission(tx, { mission: M, mode: 'with-risk', waitRunning: true, snapshot }));
    assert.deepEqual([c1.version, c1.asOf], [1, head]);
    assert.deepEqual(JSON.parse(m.data.text(c1.unfinished)), { mission: M, queued: ['T1'], running: [{ task: 'T2', dispatch: 'D-2' }] });
    assert.deepEqual(m.write({ op: 'c1', payload: 1 }, () => null), c1);
    assert.deepEqual(listMissions(m).map((x) => x.mission), [M2]);
    assert.deepEqual(listMissions(m, 'closed'), [{ mission: M, state: 'closed', closes: 1 }]);
    const c2 = w(m, (tx) => closeMission(tx, { mission: M, mode: 'post-audit' }));
    assert.equal(c2.version, 2);
    assert.deepEqual(missionCloses(m, M).map((x) => [x.version, x.mode, x.waitRunning, x.snapshot]), [[1, 'with-risk', true, snapshot], [2, 'post-audit', false, null]]);
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------- the maintainer's words, cursors, refusal codes

test('the maintainer’s words: verbatim, once per message, W-<n> in a journal leaf, recorded under a stop; quotes are checked against them', () => {
  const p = project();
  try {
    const { m } = p;
    const r1 = m.write({ op: 'say:msg-1', payload: 'msg-1' }, (tx) => recordWords(tx, { message: 'msg-1', session: 'pm-s1', at: 1_760_000_000_000, text: '帮我做登录页' }));
    assert.deepEqual([r1.words, r1.repeated], ['W-1', false]);
    w(m, (tx) => recordWords(tx, { message: 'msg-2', session: 'pm-s1', at: 1_760_000_100_000, text: '先停一下交付' }));
    assert.equal(w(m, (tx) => recordWords(tx, { message: 'msg-1', session: 'pm-s1', at: 1_760_000_000_000, text: '帮我做登录页' })).repeated, true);
    throwsCode(() => w(m, (tx) => recordWords(tx, { message: 'msg-1', session: 'pm-s1', at: 1, text: 'something else' })), 'FACT_CONFLICT', /W-1 with other text/);
    m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S'), scope: { kind: 'all' }, words: '全部停下', at: 300, wordsEntry: 'W-3' }));
    const r3 = w(m, (tx) => recordWords(tx, { message: 'msg-3', session: 'pm-s2', at: 1_760_000_200_000, text: '全部停下' }));
    assert.equal(r3.words, 'W-3');
    const leaf = m.readLeaf(r1.leaf!)!;
    assert.equal(leaf.status, 'ok');
    assert.equal(leaf.file, 'words/2025-10-09.md');
    assert.match(leaf.text!, /^### W-1 · 2025-10-09T08:53:20\.000Z · session pm-s1\n\n帮我做登录页\n$/);
    assert.deepEqual(latestUserWords(m, 2).map((x) => [x.message, x.excerpt]), [['msg-3', '全部停下'], ['msg-2', '先停一下交付']]);
    assert.equal(m.data.text(wordsEntry(m, 'W-2')!.text), '先停一下交付');
    assert.equal(checkQuote(m, m.data, 'W-1', '登录页').words, 'W-1');
    throwsCode(() => checkQuote(m, m.data, 'W-1', '注册页'), 'RECORD_INVALID', /verbatim/);
    throwsCode(() => checkQuote(m, m.data, 'W-9', 'x'), 'RECORD_INVALID');
    // A long message keeps its full text; the excerpt stays within 280 UTF-16 units without splitting a character.
    w(m, (tx) => recordWords(tx, { message: 'msg-4', session: 'pm-s1', at: 400, text: '😀'.repeat(200) }));
    assert.equal(latestUserWords(m)[0]!.excerpt, '😀'.repeat(140));
  } finally {
    p.cleanup();
  }
});

test('cursors move to a revision of the log; the 4.1 refusal codes map to a WI or are a normal branch', () => {
  const p = project();
  try {
    const { m } = p;
    assert.equal(cursor(m, 'maintainer-asked'), null);
    w(m, (tx) => setMission(tx, M, 'open'));
    const h = Number(m.head());
    assert.deepEqual(w(m, (tx) => setCursor(tx, { cursor: 'maintainer-asked' })), { rev: h });
    assert.equal(Number(cursor(m, 'maintainer-asked')!.rev), h);
    throwsCode(() => w(m, (tx) => setCursor(tx, { cursor: 'x', rev: 10_000 })), 'BAD_REQUEST');
    throwsCode(() => w(m, (tx) => setCursor(tx, { cursor: 'Bad' })), 'BAD_REQUEST');
  } finally {
    p.cleanup();
  }
  for (const c of ['BUSY', 'LOCKED', 'MOVING', 'NOT_INITIALIZED', 'RECOMPUTING'] as const) assert.equal(REFUSAL_WI[c], null, c);
  assert.equal(REFUSAL_WI.OVER_BUDGET, 'WI-20');
  assert.equal(REFUSAL_WI.UNKNOWN_DISPATCH, null);
  assert.equal(REFUSAL_WI.CHAIN_BROKEN, 'WI-29');
  assert.equal(REFUSAL_WI.GIT_WRITES_HELD, 'WI-31');
  for (const [c, wi] of Object.entries(REFUSAL_WI)) assert.ok(wi === null || WI_CATALOG.has(wi), `${c}: ${wi} is a 4.1 work instruction`);
});
