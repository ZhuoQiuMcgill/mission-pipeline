import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, sha256 } from '../src/common/hash.ts';
import type { EvidenceRecord } from '../src/common/records.ts';
import { decisionLabels, recordEnvironment } from '../src/evaluator/index.ts';
import { appendRecords } from '../src/memory/index.ts';
import { pmRenew, runOnCommit, shellRunner } from '../src/process/index.ts';
import { builders } from './labels-fixtures.ts';
import { ENV_A, ENV_B, processProject } from './process-fixtures.ts';

const commands = [
  { id: 'install', command: 'touch installed' },
  { id: 'test', command: 'test -f installed' },
];

for (const scenario of ['legacy', 'legacy-v1', 'legacy-uncited-setup', 'all-reused', 'v2-partial-reuse'] as const) {
  test(`renew preserves the original group and records its pairs atomically: ${scenario}`, { skip: process.platform === 'win32' }, async () => {
    const calls: Array<{ command: string; cwd: string }> = [];
    const p = processProject({ options: { runner: (req) => {
      calls.push({ command: req.command, cwd: req.cwd });
      return shellRunner(req);
    } } });
    try {
      let ctx = p.ctx;
      const commit = p.git('rev-parse', 'HEAD');
      const b = builders(ctx.memory);
      let originals: string[];
      if (scenario === 'v2-partial-reuse') {
        const req = { mission: 'm1', commit, purpose: 'original verification', declaration: { by: 'mp' as const, checkout: 'clean' as const, declared: true } };
        const setup = await runOnCommit(ctx, { ...req, commands: [commands[0]!] });
        const group = await runOnCommit(ctx, { ...req, commands });
        assert.equal(group.runs[0]!.evidence, setup.runs[0]!.evidence);
        assert.equal(group.runs[0]!.reused, true);
        originals = [group.runs[1]!.evidence];
        assert.deepEqual(JSON.parse(group.runs[1]!.fields['group']!), commands.map((cmd) => ({ command: cmd.command, cwd: '.', sampled: false, network: false })), 'partial-reuse evidence keeps setup from another recording write');
      } else {
        const legacy = sha256(canonicalJson(ENV_A));
        // Evidence-id order is deliberately the reverse of command/log order.
        originals = scenario === 'legacy-uncited-setup' ? ['old-a-test'] : ['old-z-install', 'old-a-test'];
        ctx.memory.write({}, (tx) => {
          recordEnvironment(tx, { identity: legacy as never, parts: ENV_A });
          appendRecords(tx, commands.map((cmd, i) => b.evidence(i === 0 ? 'old-z-install' : 'old-a-test', legacy, 'declared', {
            candidate: commit, command: cmd.command, run: 'old-group', status: 'completed', exit: '0',
            ...(scenario === 'legacy-v1' ? { runMethod: 'v1' } : {}),
          })));
          appendRecords(tx, [b.evidence('old-other-candidate', legacy, 'declared', { candidate: 'd'.repeat(40), command: 'exit 42', run: 'old-group', status: 'completed', exit: '42' })]);
        });
      }
      ctx.memory.write({}, (tx) => appendRecords(tx, [b.product('P', { commit }), b.judge('J', 'P', { evidence: originals, fields: ['exit'] })]));
      // 4.1.2: a run of an older run method (4.1.0's plain checkouts) never counts (invalidation by cause);
      // a current-method run recorded under another environment identity still does (labelled "older environment")
      const olderMethod = scenario !== 'v2-partial-reuse';
      assert.equal(ctx.memory.read((db) => decisionLabels(db, ['P']))['P'], olderMethod ? 'not-fully-proven' : 'proven');
      ctx = p.reopen(scenario === 'v2-partial-reuse' ? ENV_B : ENV_A);
      const environment = ctx.environment().identity;
      assert.equal(ctx.memory.read((db) => decisionLabels(db, ['P']))['P'], olderMethod ? 'not-fully-proven' : 'proven', 'an environment change alone no longer invalidates proof');
      const req = { mission: 'm1', commit, purpose: 'verification under current identity', declaration: { by: 'mp' as const, checkout: 'clean' as const, declared: true } };
      if (scenario === 'all-reused' || scenario === 'v2-partial-reuse') {
        await runOnCommit(ctx, { ...req, commands: scenario === 'all-reused' ? commands : [commands[0]!] });
      }
      calls.length = 0;
      const head = ctx.memory.head();
      const result = await pmRenew(ctx);
      assert.deepEqual(result.skipped, []);
      assert.equal(result.reviewSteps, 0);
      assert.deepEqual(result.reviews, []);
      assert.deepEqual(result.reruns.map((r) => r.original), originals);
      assert.ok(result.reruns.every((r) => r.passed && r.renewed.includes('J') && r.refused.length === 0));
      assert.deepEqual(calls.map((call) => call.command), scenario === 'all-reused' ? [] : commands.map((cmd) => cmd.command));
      if (calls.length > 0) assert.equal(new Set(calls.map((call) => call.cwd)).size, 1, 'install and test share one checkout');
      assert.equal(ctx.memory.read((db) => decisionLabels(db, ['P']))['P'], 'proven');
      const current = (ctx.memory.stmt("SELECT record FROM log WHERE kind = 'evidence' AND json_extract(record, '$.envSnapshot') = ?").all(environment) as Array<{ record: string }>).map((row) => JSON.parse(row.record) as EvidenceRecord);
      assert.equal(current.length, 2, 'each current reuse key has one evidence record, including reused setup');
      assert.ok(current.every((rec) => rec.fields['runMethod'] === 'v2' && rec.fields['exit'] === '0'), 'renewal creates no false failure');
      const events = ctx.memory.stmt('SELECT kind FROM log WHERE rev > ? ORDER BY rev').all(head) as Array<{ kind: string }>;
      const firstRenewal = events.findIndex((event) => event.kind === 'evidence.renewal');
      const lastRenewal = events.findLastIndex((event) => event.kind === 'evidence.renewal');
      assert.ok(firstRenewal >= 0);
      assert.equal(events.slice(firstRenewal, lastRenewal + 1).some((event) => event.kind === 'op.receipt'), false, 'every original→new pair is in the same write');
      const callsAfterRenewal = calls.length;
      const verified = await runOnCommit(ctx, { ...req, commands });
      assert.equal(verified.reused, true);
      assert.ok(verified.runs.every((r) => r.passed));
      assert.equal(calls.length, callsAfterRenewal, 'a following full verify executes nothing');
      assert.deepEqual((await pmRenew(ctx)).reruns, [], 'renewal is resumable without another suite');
    } finally { p.cleanup(); }
  });
}
