// A varied workload over the memory's domain functions, touching almost every
// state table: the rebuild and the move tests compare the tables before and
// after replaying the log.

import { sha256 } from '../src/common/hash.ts';
import { id, type AlertId, type BasisLineId, type BasisVersionId, type MissionId, type OpId, type StopId } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';
import {
  acquireLease,
  appendRecords,
  authorizeIntent,
  claimDispatch,
  closeMission,
  commitProofOp,
  commitStop,
  finishIntent,
  markNotice,
  narrowStop,
  queueTask,
  raiseAlert,
  recordContinuationCheck,
  recordDelivery,
  recordHandback,
  recordLandingPhase,
  recordPmAction,
  recordWords,
  releaseDispatch,
  setCursor,
  setMission,
  type Memory,
} from '../src/memory/index.ts';

export const BASE = 'b'.repeat(40);
export const C1 = '1'.repeat(40);

export function domainWorkload(m: Memory): void {
  const M = id<MissionId>('m1');
  const M2 = id<MissionId>('m2');
  let n = 0;
  const w = <T>(fn: Parameters<Memory['write']>[1], extra: { command?: string } = {}): T =>
    m.write({ op: `w-${++n}`, payload: n, ...extra, ...(extra.command ? { filler: { harness: 'h', model: 'm' } } : {}) }, fn) as T;
  w((tx) => setMission(tx, M, 'open'), { command: 'open' });
  w((tx) => setMission(tx, M2, 'open'));
  w((tx) => recordWords(tx, { message: 'msg-1', session: 'pm', at: 1_700_000_000_000, text: 'build the login page; stop m2 later' }));
  const L = (xs: string[]) => m.data.putList(xs);
  const facts: BaseRecord[] = [
    { kind: 'basis.version', basisKind: 'requirement', line: id<BasisLineId>('req-a'), version: id<BasisVersionId>('req-a.v1'), mission: M, scope: null },
    { kind: 'evidence', evidence: 'E1' as never, envLine: 'py' as never, envSnapshot: 'py@1' as never, runClass: 'declared', fields: { exit: '0' } },
    {
      kind: 'object.version', object: 'P' as never, objectKind: 'product', mission: M, module: null, content: m.data.put('body P'),
      prerequisites: L([]), scope: { paths: ['a.ts'], taskType: 'construct' }, reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
    },
    {
      kind: 'judgment', judgment: 'J0' as never, review: 'reviewer', executor: 'reviewer', target: 'P' as never, verdict: 'pass', evidence: L(['E1']), bases: L([]),
      constraints: L([]), reliesOn: L([]), issues: [], revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [],
    },
    { kind: 'issue', issue: 'N' as never, module: null, observedOn: L(['P']), text: m.data.put('finding') },
    { kind: 'issue.coverage', issue: 'N' as never, version: 'P' as never, evidence: 'E1' as never, command: 'npm test', tests: L(['t1']), inputs: L([`testfile:t.ts=${sha256('t')}`, `runner:node=${sha256('n')}`]) },
    { kind: 'op.pending', op: id<OpId>('OP1'), opKind: 'delivery', objects: L(['P']), scope: { mission: M, capabilities: [] } },
    { kind: 'notice', notice: 'eb-0:D', audience: 'pm', body: m.data.put('notice') },
    { kind: 'loop.attempt', lineage: 'T1', loop: 'env-retry', failureClass: 'env', signature: 'sig-x' },
    { kind: 'loop.attempt', lineage: 'T1', loop: 'env-retry', failureClass: 'env', signature: 'sig-x' },
    { kind: 'loop.grant', lineage: 'T1', loop: 'env-retry', by: 'secretary', extra: 2, reason: m.data.put('why') },
    { kind: 'mission.block', mission: M, reason: 'resource', state: 'blocked', report: m.data.put('report') },
    { kind: 'flow.event', mission: M, line: 'plan', event: 'pm-batch', key: '1', body: m.data.put('{"n":1}') },
  ];
  w((tx) => appendRecords(tx, facts));
  w((tx) =>
    recordContinuationCheck(tx, { judgment: id('J1'), extends: id('J0'), target: 'P', revision: tx.head(), result: { ok: true, merged: { evidence: ['E1'], bases: [], constraints: [], reliesOn: [] } } }),
  );
  w((tx) => commitProofOp(tx, { opId: id<OpId>('OP1') }));
  const card = m.data.put('task spec');
  for (const t of ['T1', 'T2', 'T3']) w((tx) => queueTask(tx, { task: t, lineage: `lin-${t}`, mission: M, card }));
  w((tx) => claimDispatch(tx, { dispatch: 'D-1', task: 'T1', seat: 'constructor', card: '# card D-1\n', filler: { harness: 'codex', model: 'gpt' } }));
  w((tx) => acquireLease(tx, { resource: 'gpu-0', dispatch: 'D-1' }));
  w((tx) => recordHandback(tx, { dispatch: 'D-1', report: '# report D-1\n', result: { verdict: 'done' } }));
  w((tx) => claimDispatch(tx, { dispatch: 'D-2', task: 'T2', seat: 'reviewer' }));
  w((tx) => acquireLease(tx, { resource: 'db-1', dispatch: 'D-2' }));
  w((tx) => releaseDispatch(tx, { dispatch: 'D-2', how: 'abandoned' }));
  w((tx) => claimDispatch(tx, { dispatch: 'D-3', task: 'T3', seat: 'reviewer' }));
  w((tx) => recordDelivery(tx, { mission: M, delivery: 'op-1', commit: C1, base: BASE, ref: 'refs/mission-pipeline/delivered/m1/op-1', manifest: m.data.put('manifest'), target: 'main' }));
  w((tx) =>
    authorizeIntent(tx, { intent: 'land-1', kind: 'landing', domain: 'landing:main', tag: { mission: M, capabilities: [] }, details: { delivery: { mission: M, op: 'op-1', commit: C1, base: BASE, targetBranch: 'main' } } }),
  );
  w((tx) => recordLandingPhase(tx, { landing: 'L-1', intent: 'land-1', phase: 'authorized', data: { b: BASE } }));
  w((tx) => finishIntent(tx, { intent: 'land-1', outcome: 'done' }));
  w((tx) => markNotice(tx, { notice: 'A1', state: 'acknowledged' }));
  w((tx) => recordPmAction(tx, { action: 'act-1', command: 'resume', args: { a: 1 }, wi: 'WI-12', state: 'done', result: { ok: true } }));
  w((tx) => raiseAlert(tx, { alert: id<AlertId>('al-1'), category: 'flow', wi: 'WI-23', body: m.data.put('alert body') }));
  w((tx) => setCursor(tx, { cursor: 'maintainer-asked' }));
  m.write({ stop: true }, (tx) => commitStop(tx, { stop: id<StopId>('S-all'), scope: { kind: 'all' }, words: 'stop everything', at: 2, wordsEntry: 'W-1' }));
  m.write({ stop: true }, (tx) => narrowStop(tx, { old: id<StopId>('S-all'), stop: { stop: id<StopId>('S-m2'), scope: { kind: 'mission', mission: M2 }, words: 'only m2', at: 3 } }));
  w((tx) => closeMission(tx, { mission: M2, mode: 'with-risk' }));
}
