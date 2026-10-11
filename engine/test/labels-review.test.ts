// Regression tests of the code review of the stored labels (A2, findings 1-5):
// damaged lists and events are refused, never read as something else; the
// sampled-field rule holds whatever the index's progress; a renewal needs a
// rerun of the same candidate and command; the environment identity covers a
// version command's whole output. (Findings 6 and 7, bounded batches on large
// fan-in and long cycles: labels-scale.test.ts.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentEnvironment,
  decisionLabels,
  drain,
  environmentIdentity,
  forgetObservedEnvironment,
  labelStatus,
  observeEnvironment,
  recompute,
  recordRenewal,
  recordRenewedRun,
  RUN_FIELD,
  VERSION_OUTPUT_MAX,
} from '../src/evaluator/index.ts';
import { appendRecords, commitProofOp, LedgerError, type Memory, type WriteTx } from '../src/memory/index.ts';
import { builders, labelProject, machine } from './labels-fixtures.ts';

let n = 0;
function w<T>(m: Memory, fn: (tx: WriteTx) => T): T {
  const op = `rv-${++n}`;
  return m.write({ op, payload: op }, fn);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    throw e;
  }
  return 'ok';
}

const labelsOf = (m: Memory, ids: string[]) => m.read((db) => decisionLabels(db, ids));

test('finding 1: an operation list damaged in place is refused by the gate, never read as other objects', () => {
  const p = labelProject();
  try {
    const { m } = p;
    currentEnvironment(m, { observe: machine('linux') });
    const b = builders(m);
    const pending = b.pending('op', ['P']) as unknown as { objects: { hash: string } };
    w(m, (tx) => appendRecords(tx, [b.product('P'), b.product('Q'), b.judge('JQ', 'Q'), pending as never]));
    assert.deepEqual(labelsOf(m, ['P', 'Q']), { P: 'unaccepted', Q: 'proven' });
    // Same hash, other content: the proven Q instead of P.
    m.connection.prepare('UPDATE data SET body = ? WHERE hash = ?').run(Buffer.from('["Q"]'), pending.objects.hash);
    assert.equal(codeOf(() => w(m, (tx) => commitProofOp(tx, { opId: 'op' as never }))), 'CONTENT_MISSING');
    // A missing list is not an empty list either.
    m.connection.prepare('DELETE FROM data WHERE hash = ?').run(pending.objects.hash);
    assert.equal(codeOf(() => w(m, (tx) => commitProofOp(tx, { opId: 'op' as never }))), 'CONTENT_MISSING');
  } finally {
    p.cleanup();
  }
});

test('finding 1: a prerequisite list damaged in place makes recompute refuse; the labels stay as they were and nothing unproven passes', () => {
  const p = labelProject();
  try {
    const { m } = p;
    currentEnvironment(m, { observe: machine('linux') });
    const b = builders(m);
    const product = b.product('P', { prereqs: ['A'] }) as unknown as { prerequisites: { hash: string } };
    w(m, (tx) => appendRecords(tx, [b.product('A'), b.product('Q'), b.judge('JQ', 'Q'), product as never, b.judge('JP', 'P'), b.pending('op', ['P'])]));
    assert.deepEqual(labelsOf(m, ['P']), { P: 'not-fully-proven' });
    m.connection.prepare('UPDATE data SET body = ? WHERE hash = ?').run(Buffer.from('["Q"]'), product.prerequisites.hash);
    assert.equal(codeOf(() => recompute(m)), 'CONTENT_MISSING');
    assert.deepEqual(labelsOf(m, ['P']), { P: 'not-fully-proven' });
    assert.equal(codeOf(() => w(m, (tx) => commitProofOp(tx, { opId: 'op' as never }))), 'STALE_REQUEST');
    // A new judgment makes P's rule read the list again: the damage stops the work, labels stay recomputing, nothing passes.
    m.write({}, (tx) => appendRecords(tx, [b.judge('JP2', 'P')]));
    assert.equal(m.read((db) => labelStatus(db)).recomputing, true);
    assert.equal(codeOf(() => drain(m)), 'CONTENT_MISSING');
    assert.equal(codeOf(() => w(m, (tx) => commitProofOp(tx, { opId: 'op' as never }))), 'CONTENT_MISSING');
  } finally {
    p.cleanup();
  }
});

test('finding 2: recompute verifies the log first: a changed event is refused (CHAIN_BROKEN), never turned into a proof', () => {
  const p = labelProject();
  try {
    const { m } = p;
    const env = currentEnvironment(m, { observe: machine('linux') }).identity;
    const b = builders(m);
    w(m, (tx) => appendRecords(tx, [b.evidence('E', 'old'), b.product('P'), b.judge('J', 'P', { evidence: ['E'] }), b.pending('op', ['P'])]));
    assert.deepEqual(labelsOf(m, ['P']), { P: 'not-fully-proven' });
    // A damaged copy: a non-tail event changed without its hash.
    m.connection.prepare("UPDATE log SET record = json_set(record, '$.envSnapshot', ?) WHERE kind = 'evidence'").run(env);
    assert.equal(codeOf(() => recompute(m)), 'CHAIN_BROKEN');
    assert.deepEqual(labelsOf(m, ['P']), { P: 'not-fully-proven' }, 'the labels were not rebuilt from it');
    assert.notEqual(codeOf(() => w(m, (tx) => commitProofOp(tx, { opId: 'op' as never }))), 'ok');
    assert.equal(m.verifyChain().ok, false);
  } finally {
    p.cleanup();
  }
});

test('finding 2: a rule that reads a damaged event refuses the write that needed it (CHAIN_BROKEN)', () => {
  const p = labelProject();
  try {
    const { m } = p;
    currentEnvironment(m, { observe: machine('linux') });
    const b = builders(m);
    w(m, (tx) => appendRecords(tx, [b.product('P'), b.judge('J', 'P')]));
    w(m, (tx) => appendRecords(tx, [b.product('Z')]));
    m.connection.prepare("UPDATE log SET record = json_set(record, '$.reviews', json('[]')) WHERE kind = 'object.version' AND json_extract(record, '$.object') = 'P'").run();
    // A new judgment on P: its rule reads P's record, through the integrity check.
    assert.equal(codeOf(() => w(m, (tx) => appendRecords(tx, [b.judge('J2', 'P')]))), 'CHAIN_BROKEN');
  } finally {
    p.cleanup();
  }
});

test('finding 3: a timing judgment on a declared run is refused whatever the index progress; one that reached the log anyway is never proof', () => {
  const p = labelProject();
  try {
    let m = p.m;
    const env = currentEnvironment(m, { observe: machine('linux') }).identity;
    w(m, (tx) => appendRecords(tx, [builders(m).product('P'), builders(m).pending('op', ['P'])]));
    // Another mp without the labels writes the declared run and many events: the index falls behind.
    m = p.reopen({ extensions: [] });
    const bare = builders(m);
    w(m, (tx) => appendRecords(tx, [bare.evidence('D', env, 'declared', { exit: '0', durationMs: '120' })]));
    for (let i = 0; i < 1200; i += 600) w(m, (tx) => appendRecords(tx, Array.from({ length: 600 }, (_, j) => bare.evidence(`x${i + j}`, env))));
    // ...and a judgment that uses the run's timing field (no labels there: nothing checks it).
    w(m, (tx) => appendRecords(tx, [bare.judge('JX', 'P', { evidence: ['D'], fields: ['durationMs'], review: 'perf' })]));
    m = p.reopen();
    const b = builders(m);
    assert.equal(m.read((db) => labelStatus(db)).head > m.read((db) => labelStatus(db)).revision, true, 'the index is behind');
    // Admitted here: refused from the run's own record, the index's progress does not matter.
    assert.equal(codeOf(() => m.write({ op: 'j', payload: 1 }, (tx) => appendRecords(tx, [b.judge('J', 'P', { evidence: ['D'], fields: ['durationMs'] })]))), 'RECORD_INVALID');
    // The judgment first, while the index is still behind; the run later: refused too.
    m.write({ op: 'j2', payload: 1 }, (tx) => appendRecords(tx, [b.judge('J2', 'P', { evidence: ['LATER'], fields: ['time:wall'], review: 'bench' })]));
    assert.equal(codeOf(() => m.write({ op: 'late', payload: 1 }, (tx) => appendRecords(tx, [b.evidence('LATER', env, 'declared', { 'time:wall': '5' })]))), 'RECORD_INVALID');
    drain(m);
    // JX reached the log without the check: after the catch-up it is no proof (P has only position 'reviewer', JX judged 'perf' anyway; judge it on the reviewer position too).
    m = p.reopen({ extensions: [] });
    w(m, (tx) => appendRecords(tx, [builders(m).judge('JY', 'P', { evidence: ['D'], fields: ['durationMs'] })]));
    m = p.reopen();
    drain(m);
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P'])), { P: 'not-fully-proven' });
    assert.equal(codeOf(() => w(m, (tx) => commitProofOp(tx, { opId: 'op' as never }))), 'STALE_REQUEST');
    recompute(m);
    assert.deepEqual(m.read((db) => decisionLabels(db, ['P'])), { P: 'not-fully-proven' }, 'after a recompute too');
  } finally {
    p.cleanup();
  }
});

test('finding 4: a renewal needs a rerun of the same candidate content and the same full command', () => {
  const p = labelProject();
  try {
    const { m } = p;
    const linux = currentEnvironment(m, { observe: machine('linux') }).identity;
    const b = builders(m);
    const run = (candidate: string, command: string): Record<string, string> => ({ exit: '0', [RUN_FIELD.candidate]: candidate, [RUN_FIELD.command]: command });
    w(m, (tx) => appendRecords(tx, [b.evidence('E', linux, 'declared', run('a'.repeat(40), 'npm test')), b.product('P'), b.judge('J', 'P', { evidence: ['E'] })]));
    forgetObservedEnvironment(m.projectDir);
    const win = currentEnvironment(m, { observe: machine('win32') }).identity;
    assert.deepEqual(labelsOf(m, ['P']), { P: 'not-fully-proven' });
    // Another candidate, another command, a longer command: none renews.
    for (const [id, fields] of [
      ['X1', run('b'.repeat(40), 'true')],
      ['X2', run('a'.repeat(40), 'true')],
      ['X3', run('b'.repeat(40), 'npm test')],
      ['X4', run('a'.repeat(40), 'npm test -- --only one')],
    ] as const) {
      assert.equal(codeOf(() => w(m, (tx) => recordRenewedRun(tx, { original: 'E' as never, run: b.evidence(id, win, 'declared', fields) as never }))), 'BAD_REQUEST');
    }
    // Recorded as runs, they cannot renew either, by the program's entry or as a plain record.
    w(m, (tx) => appendRecords(tx, [b.evidence('X5', win, 'declared', run('b'.repeat(40), 'true'))]));
    const out = w(m, (tx) => recordRenewal(tx, { judgment: 'J' as never, original: 'E' as never, replacement: 'X5' as never }));
    assert.equal(out.renewed, false);
    assert.equal(codeOf(() => w(m, (tx) => appendRecords(tx, [{ kind: 'evidence.renewal', judgment: 'J', original: 'E', replacement: 'X5' } as never]))), 'RENEWAL_REFUSED');
    assert.deepEqual(labelsOf(m, ['P']), { P: 'not-fully-proven' });
    // The real rerun renews.
    const ok = w(m, (tx) => recordRenewedRun(tx, { original: 'E' as never, run: b.evidence('E2', win, 'declared', run('a'.repeat(40), 'npm test')) as never }));
    assert.deepEqual(ok.renewed, ['J']);
    assert.deepEqual(labelsOf(m, ['P']), { P: 'proven' });
  } finally {
    p.cleanup();
  }
});

test('finding 5: the identity covers a version command\'s whole output; an output too long to cover fails explicitly', () => {
  const prefix = 'x'.repeat(500);
  const parts = (suffix: string) => observeEnvironment('/', { versionCommands: ['libs --list'] }, () => `${prefix}\nlibrary=${suffix}\n`);
  const a = parts('1');
  const b = parts('2');
  assert.equal(a.versions['libs --list'], b.versions['libs --list'], 'the shown part is the same');
  assert.notEqual(environmentIdentity(a), environmentIdentity(b), 'the identity is not');
  assert.notEqual(a.digests?.['libs --list'], b.digests?.['libs --list']);
  assert.throws(() => observeEnvironment('/', { versionCommands: ['huge'] }, () => 'y'.repeat(VERSION_OUTPUT_MAX + 1)), (e: unknown) => e instanceof LedgerError && e.code === 'TOO_LARGE');
  // Recorded with the parts, digests included.
  const p = labelProject();
  try {
    const cur = currentEnvironment(p.m, { observe: () => a });
    assert.equal(cur.identity, environmentIdentity(a));
  } finally {
    p.cleanup();
  }
});
