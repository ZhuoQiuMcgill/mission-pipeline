import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordEnvironment, recordRenewal } from '../src/evaluator/index.ts';
import { replacementFollowsOriginal } from '../src/evaluator/renew.ts';
import { appendRecords, initMemory, openMemory } from '../src/memory/index.ts';
import { builders } from './labels-fixtures.ts';

test('recordRenewal refuses older and identical replacements, allowing only forward log order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'renew-'));
  initMemory(dir, { git: null });
  const m = openMemory(dir, { git: null });
  try {
    const b = builders(m);
    const fields = { candidate: 'a'.repeat(40), command: 'true', exit: '0', runMethod: 'v2' };
    m.write({}, (tx) => {
      recordEnvironment(tx, { identity: 'current' as never, parts: { os: 'test', osVersion: '1', arch: 'x64', versions: {} } });
      appendRecords(tx, [b.evidence('older', 'current', 'declared', fields), b.evidence('original', 'old', 'declared', fields), b.evidence('newer', 'current', 'declared', fields), b.product('P'), b.judge('J', 'P', { evidence: ['original'] })]);
    });
    for (const replacement of ['older', 'original']) {
      assert.equal(m.read((db) => replacementFollowsOriginal(db, 'original' as never, replacement as never)), false);
      const out = m.write({}, (tx) => recordRenewal(tx, { judgment: 'J' as never, original: 'original' as never, replacement: replacement as never }));
      assert.deepEqual(out, { renewed: false, reason: 'the replacement must be recorded after the evidence it replaces' });
      assert.equal((m.stmt('SELECT COUNT(*) AS n FROM lbl_renewals').get() as { n: number }).n, 0);
    }
    assert.equal(m.read((db) => replacementFollowsOriginal(db, 'original' as never, 'newer' as never)), true);
    assert.deepEqual(m.write({}, (tx) => recordRenewal(tx, { judgment: 'J' as never, original: 'original' as never, replacement: 'newer' as never })), { renewed: true });
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
