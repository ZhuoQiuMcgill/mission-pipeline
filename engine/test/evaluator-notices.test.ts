// Notices from episode batches (6.1), quiescence (6.1, 14.4), and the renewal rule (5.3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerService, ledgerPaths } from '../src/ledger/service.ts';
import { readRecords } from '../src/ledger/store.ts';
import { Evaluator, type EvaluatorLedgerPort } from '../src/evaluator/evaluator.ts';
import { selfIdentity } from '../src/evaluator/process-info.ts';
import { expandNotices, noticeIdentity, type NoticeLedgerPort } from '../src/evaluator/notices.ts';
import { renewalDecision } from '../src/evaluator/renewal.ts';
import { id, revision, type OpId, type Revision } from '../src/common/ids.ts';
import type { BaseRecord, EvidenceRecord } from '../src/common/records.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mp-notice-'));
  const paths = ledgerPaths(join(dir, 'ledger'), join(dir, 'control'));
  const svc = new LedgerService({ paths });
  svc.open();
  const port: EvaluatorLedgerPort & NoticeLedgerPort = {
    readRecordsAfter: (after: Revision) => readRecords(paths.db, after),
    appendRecords: (r) => svc.appendRecords(r),
    // The ledger binds the registration to the current scheduler generation and this process (F10).
    beginEvaluator: () => svc.beginEvaluator({ gen: svc.currentGenerationNumber(), identity: selfIdentity() }),
    publish: (r) => svc.publish(r),
    recordEvaluatorFailure: () => svc.recordEvaluatorFailure(),
    recordEvaluatorSuccess: () => svc.recordEvaluatorSuccess(),
  };
  return { svc, port, cleanup: () => (svc.close(), rmSync(dir, { recursive: true, force: true })) };
}

let seq = 0;
const put = (svc: LedgerService, ...records: BaseRecord[]) => svc.appendRecords({ op: `n-${++seq}`, gen: null, records });

async function seed(svc: LedgerService): Promise<void> {
  const L = (xs: string[]) => svc.content.putList(xs);
  await put(
    svc,
    { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@1' as never },
    { kind: 'evidence', evidence: 'E1' as never, envLine: 'py' as never, envSnapshot: 'py@1' as never, runClass: 'closed', fields: { exit: '0' } },
    {
      kind: 'object.version', object: 'P' as never, objectKind: 'product', mission: 'm1' as never, module: null, content: svc.content.put('object content') as never,
      prerequisites: L([]), scope: { paths: ['src/p.ts'], taskType: 'construct' }, reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
    },
    {
      kind: 'judgment', judgment: 'J1' as never, review: 'reviewer', executor: 'reviewer', target: 'P' as never, verdict: 'pass',
      evidence: L(['E1']), bases: L([]), constraints: L([]), reliesOn: L([]), issues: [], revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [],
    },
    { kind: 'op.pending', op: 'D1' as never, opKind: 'delivery', objects: L(['P']), scope: { mission: 'm1' as never, capabilities: [] } },
  );
}

test('lose, confirm, recover, lose again: two episodes and two notices; expansion is idempotent (6.1, 14.4)', async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seed(svc);
    const gen = await svc.beginGeneration();
    const ev = new Evaluator(port, svc.content);
    const r0 = await ev.update();
    await svc.commitProofOp({ op: 'x', gen, opId: id<OpId>('D1'), asOf: r0.published, tag: { mission: 'm1' as never, capabilities: [] } });
    await ev.update();
    await put(svc, { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@2' as never }); // lose
    await ev.update();
    let cursor = revision(0);
    const first = await expandNotices(port, svc.content, cursor);
    assert.equal(first.committed, 1);
    cursor = first.cursor;
    await put(svc, { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@1' as never }); // recover
    await ev.update();
    await put(svc, { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@3' as never }); // lose again
    await ev.update();
    const second = await expandNotices(port, svc.content, cursor);
    assert.equal(second.committed, 2, 'one end and one new start');
    // A restarted scheduler with no cursor expands nothing new.
    const again = await expandNotices(port, svc.content, revision(0));
    assert.equal(again.committed, 0);
    const notices = readRecords(svc.paths.db, revision(0)).filter((c) => c.record.kind === 'notice');
    assert.equal(notices.length, 3);
    const starts = notices
      .map((c) => (c.record.kind === 'notice' ? (JSON.parse(svc.content.get(c.record.body).toString()) as { change: string }) : null))
      .filter((b) => b?.change === 'start');
    assert.equal(starts.length, 2, 'the second loss is a new episode with its own notice');
  } finally {
    cleanup();
  }
});

test('quiescence: once business writes stop and notices are expanded, the ledger stops growing within two updates (6.1, 14.4)', async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seed(svc);
    const gen = await svc.beginGeneration();
    const ev = new Evaluator(port, svc.content);
    const r0 = await ev.update();
    await svc.commitProofOp({ op: 'x', gen, opId: id<OpId>('D1'), asOf: r0.published, tag: { mission: 'm1' as never, capabilities: [] } });
    await put(svc, { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@2' as never });
    await ev.update();
    await expandNotices(port, svc.content, revision(0));
    await ev.update(); // reads the notice: bookkeeping only
    const head = svc.head();
    const u1 = await ev.update();
    const u2 = await ev.update();
    assert.equal(u1.batch, null);
    assert.equal(u2.batch, null);
    assert.equal((await expandNotices(port, svc.content, revision(0))).committed, 0);
    assert.equal(svc.head(), head, 'no further records');
  } finally {
    cleanup();
  }
});

test('renewal rule: closed runs, every used field equal, no statistics (5.3)', () => {
  const ev = (fields: Record<string, string>, runClass: EvidenceRecord['runClass'] = 'closed'): EvidenceRecord => ({
    kind: 'evidence', evidence: 'E' as never, envLine: 'py' as never, envSnapshot: 'py@1' as never, runClass, fields,
  });
  const use = { fields: ['exit', 'outputHash'], statisticalOrExternal: false };
  assert.deepEqual(renewalDecision(ev({ exit: '0', outputHash: 'h', ms: '10' }), ev({ exit: '0', outputHash: 'h', ms: '99' }), use), { renew: true });
  assert.deepEqual(renewalDecision(ev({ exit: '0', outputHash: 'h' }), ev({ exit: '0', outputHash: 'x' }), use), { renew: false, reason: 'field-differs', field: 'outputHash' });
  assert.deepEqual(
    renewalDecision(ev({ exit: '0', ms: '10' }), ev({ exit: '0', ms: '10' }), { fields: ['exit', 'ms'], statisticalOrExternal: false }),
    { renew: false, reason: 'uses-timing', field: 'ms' },
    'a judgment using duration never renews, even when the timings happen to be equal (core review r2 F12)',
  );
  assert.equal(renewalDecision(ev({ exit: '0', 'time:wall': '5' }), ev({ exit: '0', 'time:wall': '5' }), { fields: ['time:wall'], statisticalOrExternal: false }).renew, false);
  assert.deepEqual(
    renewalDecision(ev({ exit: '0' }), ev({ exit: '0' }), { fields: ['constructor'], statisticalOrExternal: false }),
    { renew: false, reason: 'field-missing', field: 'constructor' },
    'only own fields count',
  );
  assert.deepEqual(renewalDecision(ev({ exit: '0' }, 'open'), ev({ exit: '0' }), { fields: ['exit'], statisticalOrExternal: false }), { renew: false, reason: 'not-closed' });
  assert.deepEqual(renewalDecision(ev({ exit: '0' }), ev({ exit: '0' }, 'sampling'), { fields: ['exit'], statisticalOrExternal: false }), { renew: false, reason: 'not-closed' });
  assert.deepEqual(renewalDecision(ev({ exit: '0' }), ev({ exit: '0' }), { fields: ['exit'], statisticalOrExternal: true }), { renew: false, reason: 'statistical-or-external' });
  assert.deepEqual(renewalDecision(ev({ exit: '0' }), ev({}), { fields: ['exit'], statisticalOrExternal: false }), { renew: false, reason: 'field-missing', field: 'exit' });
  assert.deepEqual(renewalDecision(ev({}), ev({}), { fields: [], statisticalOrExternal: false }), { renew: false, reason: 'no-declared-fields' });
});

test('notices carry their trigger facts and default handling, and pair identities are unambiguous (3.9, 3.11; core review r3 F15)', async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seed(svc);
    const gen = await svc.beginGeneration();
    const ev = new Evaluator(port, svc.content);
    const r0 = await ev.update();
    await svc.commitProofOp({ op: 'exec-d1-text', gen, opId: id<OpId>('D1'), asOf: r0.published, tag: { mission: 'm1' as never, capabilities: [] } });
    await put(svc, { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@2' as never });
    await ev.update();
    await expandNotices(port, svc.content, revision(0));
    const notices = readRecords(svc.paths.db, revision(0)).filter((c) => c.record.kind === 'notice').map((c) => c.record as { notice: string; trigger?: string; defaultAction?: string });
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.trigger ?? '', /executed operation D1 is no longer all proven as of revision \d+/);
    assert.match(notices[0]!.defaultAction ?? '', /nothing is undone/);
    assert.deepEqual(JSON.parse(notices[0]!.notice), [JSON.parse(notices[0]!.notice)[0], 'D1'], 'a JSON pair (batch, operation)');
    assert.equal(noticeIdentity('A:B', 'C'), '["A:B","C"]');
    assert.notEqual(noticeIdentity('A:B', 'C'), noticeIdentity('A', 'B:C'));
  } finally {
    cleanup();
  }
});
