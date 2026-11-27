// #57: a kept product that a decision accepted with its risks, re-bound to a new plan version and sent
// back by its re-bind Reviewer on the same risks, can be accepted with its risks again. The loop-exhausted
// escalation offers accept-risk; the ruling accepts the re-bound version (event "rebound") and quotes the
// review's open findings as risks.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import type { DetailedPlanDoc } from '../src/flow/plandoc.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { recordItem } from '../src/flow/requirements.ts';
import { detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;

async function setup(): Promise<{ ports: World; engine: FlowEngine }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'] });
  return { ports, engine: new FlowEngine(ports) };
}

const plan2 = () => pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'A CSV parser library, read-only once it has parsed a file', items: ['g1', 'd1'] }, pmPlan(M).elements[1]!] });
const keeps = (): DetailedPlanDoc => {
  const p = detailedPlan(M, { extraTask: true });
  return { ...p, tasks: p.tasks.map((t) => (t.id === 'docs' ? { ...t, interpreter: 'node', verificationCommands: [{ id: 'lint', command: 'npx markdownlint docs/parser.md' }] } : t)) };
};
const current = async (ports: World, task: string): Promise<string | null> => acceptedProduct(flowCtx(ports, M), task);

describe('#57: accept-risk after a failed re-bind review', () => {
  it('a product accepted with its risks, re-bound and sent back on them, is accepted with its risks again by the ruling', async () => {
    const { ports, engine } = await setup();
    // iface's own review uses its loop up; the Secretary accepts the verified product with its findings as risks
    const first = happyScript(M);
    await drive(engine, ports.scheduler, (t, s) => {
      if (t.card.seat === 'reviewer' && /^rev\.m1\.iface\.\d+$/.test(t.task)) {
        const result = reviewer(t.card as ReviewerCard, 'rework');
        result.judgments[0]!.reason = `A distinct missing case in ${t.task}`;
        return { handBack: result };
      }
      if (t.card.seat === 'secretary') return { handBack: secretary(t.card as SecretaryCard, 'accept-risk') };
      return first(t, s);
    });
    const k = Number(/\.(\d+)$/.exec((await current(ports, 'iface'))!)![1]);
    // a later decision; the next plan keeps iface's card: the product is re-bound and its Reviewer sends it back
    const w = say(ports, 'Once it has parsed a file, keep the parser read-only.');
    await recordItem(ports, { mission: M, item: 'd1', type: 'decision', text: 'The parser is read-only once it has parsed a file', source: { kind: 'words', words: w, quote: 'keep the parser read-only' } });
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [w], changedItems: ['d1'] });
    const base = happyScript(M, keeps);
    await drive(engine, ports.scheduler, (t, s) => {
      if (t.card.seat === 'secretary') return null;
      if (t.card.seat === 'reviewer' && t.task === `rev.m1.iface.${k}.b1`) {
        const result = reviewer(t.card as ReviewerCard, 'rework');
        result.judgments[0]!.reason = 'The same accepted risk again';
        return { handBack: result };
      }
      return base(t, s);
    });
    const queued = ports.scheduler.queued('secretary');
    assert.equal(queued.length, 1, 'the re-bind exhaustion waits for one decision');
    const card = queued[0]!.card as SecretaryCard;
    assert.ok(card.options.some((o) => o.id === 'accept-risk'), `accept-risk is offered: ${card.options.map((o) => o.id).join(', ')}`);
    assert.equal(card.position?.target, `prod.con.m1.iface.${k}.b1`, 'the ruling is on the re-bound version');
    // the decision accepts the re-bound version with its risks; the dependent goes on
    await ports.scheduler.run(queued[0]!.task, { handBack: secretary(card, 'accept-risk') });
    await drive(engine, ports.scheduler, base);
    assert.equal(await current(ports, 'iface'), `prod.con.m1.iface.${k}.b1`);
    const rebound = (await ports.ledger.events<{ risks?: string[]; decision?: { option: string } }>({ mission: M, line: 'task:iface', event: 'rebound' })).at(-1)!.body;
    assert.equal(rebound.decision?.option, 'accept-risk');
    assert.ok((rebound.risks ?? []).some((r) => r.includes('The same accepted risk again')), 'the open findings are quoted as risks');
    const labels = (await ports.evaluator.labels([`prod.con.m1.iface.${k}.b1`])).labels;
    assert.equal(labels[`prod.con.m1.iface.${k}.b1`], 'proven', 'the ruling revokes the Reviewer negation');
    assert.ok(await current(ports, 'docs'), 'the dependent is built');
    // a further pass changes nothing
    await engine.reconcile(M);
    assert.equal(ports.scheduler.queued('secretary').length, 0);
  });

  it('a product accepted by a Reviewer pass is not offered accept-risk after its re-bind fails', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, happyScript(M));
    const w = say(ports, 'Once it has parsed a file, keep the parser read-only.');
    await recordItem(ports, { mission: M, item: 'd1', type: 'decision', text: 'The parser is read-only once it has parsed a file', source: { kind: 'words', words: w, quote: 'keep the parser read-only' } });
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [w], changedItems: ['d1'] });
    const base = happyScript(M, keeps);
    await drive(engine, ports.scheduler, (t, s) => {
      if (t.card.seat === 'secretary') return null;
      if (t.card.seat === 'reviewer' && /^rev\.m1\.iface\.\d+\.b1$/.test(t.task)) {
        const result = reviewer(t.card as ReviewerCard, 'rework');
        result.judgments[0]!.reason = 'A new finding on the re-bound version';
        return { handBack: result };
      }
      return base(t, s);
    });
    for (const q of ports.scheduler.queued('secretary')) {
      assert.ok(!(q.card as SecretaryCard).options.some((o) => o.id === 'accept-risk' && (q.card as SecretaryCard).position?.target?.includes('.b1')), 'no accept-risk on a re-bind of a product a Reviewer accepted');
    }
  });
});
