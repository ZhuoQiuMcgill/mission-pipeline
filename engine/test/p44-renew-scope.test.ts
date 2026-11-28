// 4.4 (F14): `mp pm renew [--mission <m>]` covers the missions that are not closed by default; a closed
// mission's runs are renewed only when it is named. A memory with no closed mission renews as 4.3 did.
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, sha256 } from '../src/common/hash.ts';
import type { BaseRecord } from '../src/common/records.ts';
import type { MissionId } from '../src/common/ids.ts';
import { recordEnvironment } from '../src/evaluator/index.ts';
import { appendRecords, setMission } from '../src/memory/index.ts';
import { pmRenew } from '../src/process/index.ts';
import { builders } from './labels-fixtures.ts';
import { ENV_A, processProject, sh, write } from './process-fixtures.ts';

test('F14: renew covers the missions that are not closed; --mission names a closed one', async () => {
  const p = processProject();
  try {
    const first = p.git('rev-parse', 'HEAD');
    write(p.dir, 'two.txt', 'two\n');
    sh(p.dir, 'add', '-A');
    sh(p.dir, 'commit', '-q', '-m', 'two');
    const second = p.git('rev-parse', 'HEAD');
    const b = builders(p.ctx.memory);
    const legacy = sha256(canonicalJson(ENV_A));
    p.ctx.memory.write({}, (tx) => {
      recordEnvironment(tx, { identity: legacy as never, parts: ENV_A });
      for (const m of ['m1', 'm2'] as MissionId[]) setMission(tx, m, 'open');
      setMission(tx, 'm2' as MissionId, 'closed');
      const run = (id: string, candidate: string) => b.evidence(id, legacy, 'declared', { candidate, command: 'node -e 0', run: `g-${id}`, status: 'completed', exit: '0' });
      appendRecords(tx, [run('old-1', first), run('old-2', second)]);
      appendRecords(tx, [
        b.product('P1', { commit: first }), { ...b.product('P2', { commit: second }), mission: 'm2' } as BaseRecord,
        b.judge('J1', 'P1', { evidence: ['old-1'], fields: ['exit'] }), b.judge('J2', 'P2', { evidence: ['old-2'], fields: ['exit'] }),
      ]);
    });
    const ctx = p.reopen(ENV_A);
    const open = await pmRenew(ctx);
    assert.deepEqual(open.reruns.map((r) => r.original), ['old-1'], '4.3 reran the closed mission too');
    assert.deepEqual(open.missions, ['m1']);
    assert.equal(open.leftOut, 1);
    const named = await pmRenew(ctx, { mission: 'm2' });
    assert.deepEqual(named.reruns.map((r) => r.original), ['old-2']);
    assert.deepEqual(named.missions, ['m2']);
    assert.ok(named.reruns.every((r) => r.passed && r.renewed.length === 1));
  } finally {
    p.cleanup();
  }
});

test('F14 (review p2-3): a run that judgments of two missions cite renews only the judgment of the mission covered', async () => {
  const p = processProject();
  try {
    const commit = p.git('rev-parse', 'HEAD');
    const b = builders(p.ctx.memory);
    const legacy = sha256(canonicalJson(ENV_A));
    p.ctx.memory.write({}, (tx) => {
      recordEnvironment(tx, { identity: legacy as never, parts: ENV_A });
      for (const m of ['m1', 'm2'] as MissionId[]) setMission(tx, m, 'open');
      setMission(tx, 'm2' as MissionId, 'closed');
      appendRecords(tx, [b.evidence('old-shared', legacy, 'declared', { candidate: commit, command: 'node -e 0', run: 'g-shared', status: 'completed', exit: '0' })]);
      appendRecords(tx, [
        b.product('PA', { commit }), { ...b.product('PB', { commit }), mission: 'm2' } as BaseRecord,
        b.judge('JA', 'PA', { evidence: ['old-shared'], fields: ['exit'] }), b.judge('JB', 'PB', { evidence: ['old-shared'], fields: ['exit'] }),
      ]);
    });
    const ctx = p.reopen(ENV_A);
    const renewedJudgments = () => (ctx.memory.stmt("SELECT json_extract(record, '$.judgment') AS j FROM log WHERE kind = 'evidence.renewal' ORDER BY rev").all() as Array<{ j: string }>).map((r) => r.j);
    const open = await pmRenew(ctx);
    assert.deepEqual(open.reruns.map((r) => [r.original, r.renewed]), [['old-shared', ['JA']]]);
    assert.deepEqual(renewedJudgments(), ['JA'], 'the closed mission’s judgment was renewed through the shared run');
    assert.equal(open.leftOut, 1);
    const named = await pmRenew(ctx, { mission: 'm2' });
    assert.deepEqual(named.reruns.map((r) => [r.original, r.renewed]), [['old-shared', ['JB']]]);
    assert.deepEqual(renewedJudgments(), ['JA', 'JB']);
  } finally {
    p.cleanup();
  }
});
