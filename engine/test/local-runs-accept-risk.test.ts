// Local fix (W-51): a task whose rework loop is used up, on an attempt whose program runs did not all pass, offers
// accept-risk to the PM and the user only. The Secretary seat's card leaves it out (the Secretary's accept-risk
// stays with verified hand-backs); a PM answer accepts the product and quotes the failed runs among the risks.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import type { DetailedPlanDoc } from '../src/flow/plandoc.ts';
import { detailedPlan, drive, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import { answerByPm, escalationsOf } from '../src/flow/secretary.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
// task iface gets one program run (the default plan gives it none, which counts as verified)
const withRun = (): DetailedPlanDoc => {
  const p = detailedPlan(M);
  return { ...p, tasks: p.tasks.map((x) => (x.id === 'iface' ? { ...x, interpreter: 'node', verificationCommands: [{ id: 'unit', command: 'node --test' }] } : x)) };
};

async function exhaustWithFailedRuns(): Promise<{ ports: ReturnType<typeof memoryPorts>; engine: FlowEngine }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'] });
  const engine = new FlowEngine(ports);
  // every program run on task iface's products fails; its Reviewer sends each attempt back
  ports.scheduler.verifyPass = (req) => !req.object.includes('.iface.');
  const base = happyScript(M, withRun);
  await drive(engine, ports.scheduler, (t, s) => {
    if (t.card.seat === 'secretary') return null;
    if (t.card.seat === 'reviewer' && /^rev\.m1\.iface\.\d+$/.test(t.task)) {
      const result = reviewer(t.card as ReviewerCard, 'rework');
      result.judgments[0]!.reason = `A distinct finding in ${t.task}`;
      return { handBack: result };
    }
    return base(t, s);
  });
  return { ports, engine };
}

describe('local fix: accept-risk on an attempt whose program runs failed is the PM\'s or the user\'s', () => {
  it('the escalation offers accept-risk as pmOnly, lists the failed runs, and the Secretary card leaves it out', async () => {
    const { ports } = await exhaustWithFailedRuns();
    const esc = (await escalationsOf(flowCtx(ports, M), 'task:iface')).filter((e) => e.source === 'loop-exhausted').at(-1)!;
    assert.ok(esc, 'the used-up loop raised an escalation');
    assert.ok(esc.options.includes('accept-risk'), `accept-risk is among the options: ${esc.options.join(', ')}`);
    assert.deepEqual(esc.pmOnly, ['accept-risk']);
    assert.ok(esc.reasons.some((r) => r.startsWith('a program run did not pass on the product')), 'the failed runs are among the reasons');
    const queued = ports.scheduler.queued('secretary');
    assert.equal(queued.length, 1, 'the exhaustion waits for one decision');
    const card = queued[0]!.card as SecretaryCard;
    assert.ok(!card.options.some((o) => o.id === 'accept-risk'), `the Secretary card does not offer accept-risk: ${card.options.map((o) => o.id).join(', ')}`);
  });

  it('a PM answer accepts the product with the failed runs quoted as risks', async () => {
    const { ports, engine } = await exhaustWithFailedRuns();
    const esc = (await escalationsOf(flowCtx(ports, M), 'task:iface')).filter((e) => e.source === 'loop-exhausted').at(-1)!;
    await answerByPm(ports, { mission: M, escalation: esc.id, option: 'accept-risk', words: [], noWords: true, reason: 'accepted with its risks by the PM' });
    await engine.reconcile(M);
    const product = await acceptedProduct(flowCtx(ports, M), 'iface');
    assert.ok(product, 'iface is accepted');
    const accepted = (await ports.ledger.events<{ risks?: string[]; decision?: { option: string; by: string } }>({ mission: M, line: 'task:iface', event: 'accepted' })).at(-1)!.body;
    assert.equal(accepted.decision?.option, 'accept-risk');
    assert.equal(accepted.decision?.by, 'pm');
    assert.ok((accepted.risks ?? []).some((r) => r.includes('a program run did not pass on the product')), 'the failed runs are quoted as risks');
  });

  it('a verified attempt keeps the Secretary\'s accept-risk and gets no pmOnly', async () => {
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'] });
    const engine = new FlowEngine(ports);
    const base = happyScript(M);
    await drive(engine, ports.scheduler, (t, s) => {
      if (t.card.seat === 'secretary') return null;
      if (t.card.seat === 'reviewer' && /^rev\.m1\.iface\.\d+$/.test(t.task)) {
        const result = reviewer(t.card as ReviewerCard, 'rework');
        result.judgments[0]!.reason = `A distinct finding in ${t.task}`;
        return { handBack: result };
      }
      return base(t, s);
    });
    const esc = (await escalationsOf(flowCtx(ports, M), 'task:iface')).filter((e) => e.source === 'loop-exhausted').at(-1)!;
    assert.equal(esc.pmOnly, undefined);
    const card = ports.scheduler.queued('secretary')[0]!.card as SecretaryCard;
    assert.ok(card.options.some((o) => o.id === 'accept-risk'), 'the Secretary card offers accept-risk on a verified attempt');
  });
});
