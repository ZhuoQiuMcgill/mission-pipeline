// The decision-layer commands (design 9.2; 3.1, 3.3, 3.8, 9.5, 11.1) through the flow functions,
// against a real ledger: requirement items quoting the user's booked words, constraints, a PM
// plan batch, the user's answer to an escalation, missions, and legalization (whose request
// needs the scheduler's snapshot: NOT_IMPLEMENTED from the CLI until the scheduler RPC has it).

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useFlowAdapter } from '../src/cli/adapters/flow.ts';
import { cleanupEnvs, LedgerProc } from './scheduler-fixtures.ts';
import { cliEnv, ledgerCall, mp, mpJson } from './cli-fixtures.ts';

const procs: LedgerProc[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) await p.kill();
  await cleanupEnvs();
});

test('requirement items, constraints, a PM plan batch, missions: recorded through the flows; arguments checked', async () => {
  const env = cliEnv('flow');
  const lp = new LedgerProc(env);
  await lp.start();
  procs.push(lp);
  await ledgerCall(env, 'recordUserWords', { message: 'msg-1', session: 's', at: Date.now(), text: 'the login page should support a dark mode' });
  assert.equal((await mp(env, 'requirement', 'add', 'm1', 'dark-mode', '--type', 'goal', '--text', 'x')).exitCode, 64, 'an item points to its source (3.1)');
  assert.equal((await mp(env, 'requirement', 'add', 'm1', 'dark-mode', '--type', 'wish', '--text', 'x', '--quote', 'q')).exitCode, 64);
  const add = await mpJson(env, 'requirement', 'add', 'm1', 'dark-mode', '--type', 'goal', '--text', 'The login page supports a dark mode', '--quote', 'support a dark mode');
  assert.equal(add.exitCode, 0, JSON.stringify(add.out));
  const version = (add.out['result'] as { version: string }).version;
  assert.match(version, /dark-mode\.v1$/);
  const shown = await mp(env, 'show', 'requirement', version);
  assert.equal(shown.exitCode, 0, shown.stderr);
  assert.match(shown.stdout, /Requirement item .*dark-mode\.v1/);
  const c = await mpJson(env, 'constraint', 'add', 'm1', 'no-globals', '--kind', 'object', '--text', 'No global variables', '--paths', 'src/**');
  assert.equal(c.exitCode, 0, JSON.stringify(c.out));
  const plan = {
    format: 'mp4.pm-plan.v1',
    mission: 'm1',
    round: 1,
    order: 'free',
    elements: [{ id: 'e1', kind: 'deliverable', text: 'Dark mode on the login page', provenance: { by: 'user', message: 'msg-1', quote: 'support a dark mode' }, items: ['dark-mode'], after: [] }],
    goalsBeyond: [],
    authorizations: [],
  };
  const planFile = join(env.root, 'plan.json');
  writeFileSync(planFile, JSON.stringify(plan));
  const p = await mpJson(env, 'plan', 'submit', 'm1', '--file', planFile, '--changed', 'dark-mode');
  assert.equal(p.exitCode, 0, JSON.stringify(p.out));
  assert.equal((p.out['result'] as { batch: string }).batch, 'b1');
  const bad = await mpJson(env, 'plan', 'submit', 'm1', '--file', join(env.root, 'missing.json'));
  assert.equal(bad.exitCode, 64);
  assert.equal((await mp(env, 'mission', 'open', 'm1')).exitCode, 0);
  assert.match((await mp(env, 'mission', 'list')).stdout, /m1: open/);
  const w = await mpJson(env, 'requirement', 'withdraw', 'm1', 'dark-mode', '--reason', 'user: drop the dark mode');
  assert.equal(w.exitCode, 0, JSON.stringify(w.out));
});

test('answer and legalize: argument checks, the flow\'s own refusals, NOT_IMPLEMENTED where the scheduler is needed, and the adapter seam', async () => {
  const env = cliEnv('flow-answer');
  const lp = new LedgerProc(env);
  await lp.start();
  procs.push(lp);
  assert.equal((await mp(env, 'answer', 'm1', 'esc-1', '--option', 'ask-user', '--words', 'w')).exitCode, 64, 'the PM never asks back on the user\'s behalf');
  assert.equal((await mp(env, 'answer', 'm1', 'esc-1', '--option', 'accept')).exitCode, 64, 'the user\'s words are required');
  const unknown = await mpJson(env, 'answer', 'm1', 'esc-1', '--option', 'accept', '--words', 'user: accept it');
  assert.equal(unknown.exitCode, 3, 'no such escalation: refused, nothing else affected');
  const legal = await mpJson(env, 'legalize', 'request', 'm1', 'obj-1', '--words', 'user: legalize it');
  assert.ok([70, 69, 3].includes(legal.exitCode), JSON.stringify(legal.out));
  const restore = useFlowAdapter({ answer: async (_ctx, r) => ({ text: `answered ${r.escalation}`, json: { escalation: r.escalation, option: r.option } }) });
  try {
    const r = await mpJson(env, 'answer', 'm1', 'esc-1', '--option', 'grant', '--extra', '1', '--words', 'user: one more', '--op', 'ans-1');
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.out['result'], { escalation: 'esc-1', option: 'grant' });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------- legalization through the scheduler's RPC (11.1)

import { serveRpc } from '../src/common/rpc.ts';
import { fakePorts } from '../src/flow/fakes.ts';
import { flowRpc } from '../src/scheduler/flowRpc.ts';
import { writeConfig } from './cli-fixtures.ts';
import type { BaseRecord, ReviewContract } from '../src/common/records.ts';

/** The legalization fixtures of flow-audit-legalization.test.ts, on the flows' fake ports. */
async function legalWorld() {
  const p = fakePorts();
  const c = p.ledger.content;
  const M = 'M1' as never;
  const obj = (id: string, prereqs: string[], reliesOn: string[]): BaseRecord => ({
    kind: 'object.version', object: id as never, objectKind: 'product', mission: M, module: null, content: c.put(`content of ${id}`), prerequisites: c.putList(prereqs),
    scope: { paths: [`src/${id.toLowerCase()}.ts`], taskType: 'code' }, reviews: [{ review: 'reviewer', basisLines: ['S1' as never], reliesOn: reliesOn as never }] as ReviewContract[],
  });
  const judgment = (j: string, target: string, verdict: 'pass' | 'fail', evidence: string[], reliesOn: string[]): BaseRecord => ({
    kind: 'judgment', judgment: j as never, review: 'reviewer', executor: 'reviewer', target: target as never, verdict, evidence: c.putList(evidence), bases: c.putList(['S1.v1']),
    constraints: c.putList([]), reliesOn: c.putList(reliesOn), issues: [], revokes: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [], extends: null,
  });
  await p.ledger.append('setup', {
    records: [
      { kind: 'basis.version', basisKind: 'standard', line: 'S1' as never, version: 'S1.v1' as never, mission: M, scope: null },
      { kind: 'env.snapshot', line: 'env.t' as never, snapshot: 'snap.1' as never },
      { kind: 'evidence', evidence: 'ev.A' as never, envLine: 'env.t' as never, envSnapshot: 'snap.1' as never, runClass: 'closed', fields: { exit: '0' } },
      obj('A', [], []), judgment('jA', 'A', 'pass', ['ev.A'], []), obj('B', ['A'], ['A']), obj('C', ['B'], ['B']), judgment('jC', 'C', 'pass', [], ['B']),
      obj('D', [], []), judgment('jD', 'D', 'fail', [], []), obj('E', ['D'], ['D']), judgment('jE', 'E', 'pass', [], ['D']),
    ],
  });
  return p;
}

test('legalize request goes to the scheduler, which runs it on the flows; the same request is idempotent; a refusal prints its WI; no flows: a clear refusal', async () => {
  const env = cliEnv('flow-legal');
  const world = await legalWorld();
  const ports = { ledger: world.ledger, scheduler: world.scheduler, evaluator: world.evaluator };
  let flows: typeof ports | null = ports;
  const server = serveRpc(env.schedulerSocket, async (method, params) => {
    const a = flowRpc(() => flows)(method, params);
    if (a === undefined) throw new Error(`unexpected method ${method}`);
    return a;
  });
  writeConfig(env, { scheduler: true });
  try {
    const first = await mpJson(env, 'legalize', 'request', 'M1', 'C', '--words', 'please legalize the parser');
    assert.equal(first.exitCode, 0, JSON.stringify(first.out));
    const r1 = first.out['result'] as { legalization: string; plan: { pending: string[]; chain: string[]; seats: number } };
    assert.deepEqual([r1.plan.pending, r1.plan.chain, r1.plan.seats], [['B', 'C'], ['A', 'B', 'C'], 3]);
    const text = await mp(env, 'legalize', 'request', 'M1', 'C', '--words', 'please legalize the parser');
    assert.match(text.stdout, new RegExp(`Legalization ${r1.legalization} of C: 2 of 3 nodes need a backfill; at most 3 Auditor seats\\. Show the user`));
    assert.equal(world.ledger.notices.filter((n) => n.category === 'legalization-plan').length, 1, 'the same request again: the same legalization, no second plan');
    assert.equal(world.scheduler.queued().length, 0, 'nothing starts before the user starts it');
    const refused = await mpJson(env, 'legalize', 'request', 'M1', 'E', '--words', 'legalize E');
    assert.equal(refused.exitCode, 3, JSON.stringify(refused.out));
    assert.equal((refused.out['result'] as { wi: string }).wi, 'WI-25');
    const rt = await mp(env, 'legalize', 'request', 'M1', 'E', '--words', 'legalize E', '--op', 'legal-again');
    assert.match(rt.stdout, /cannot proceed \(refused\)/);
    assert.match(rt.stdout, /Handle per WI-25 A legalization cannot complete.*: open the WI page .*WI-25\.md/);
    const started = await mpJson(env, 'legalize', 'start', 'M1', r1.legalization, '--words', 'go ahead');
    assert.notEqual(started.exitCode, 70, 'start runs from the CLI (ledger only)');
    flows = null;
    const none = await mpJson(env, 'legalize', 'request', 'M1', 'C', '--words', 'again');
    assert.equal(none.exitCode, 3);
    assert.match((none.out['error'] as { message: string }).message, /runs without the flows/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
