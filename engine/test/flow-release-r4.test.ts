// Release review r4: ids that repeat within a task (verification commands, standards) are
// refused at intake and bounced to the Architect; a task that still carries them is never
// dispatched or verified (the Secretary re-plans it); the verification entry refuses them
// before writing anything.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson } from '../src/common/hash.ts';
import type { MissionId } from '../src/common/ids.ts';
import { programActions, type ActionContext } from '../src/flow/actions/index.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { fakePorts } from '../src/flow/fakes.ts';
import { mechanicalCheck } from '../src/flow/mechanical.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { planIdProblems, PmPlanDoc, type DetailedPlanDoc } from '../src/flow/plandoc.ts';
import { architect, detailedPlan, drive, happyScript, pmPlan, seedMission } from '../src/flow/scripted.ts';
import type { ArchitectDecomposeCard } from '../src/seat/cards/architect.ts';
import { handBackProblems } from '../src/seat/cards/index.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';

const M = 'm1' as MissionId;

/** The reviewer's repro: two verification commands with the same id in one task. */
function duplicateCommands(): DetailedPlanDoc {
  const p = detailedPlan(M);
  return { ...p, tasks: p.tasks.map((t) => (t.id === 'impl' ? { ...t, verificationCommands: [{ id: 'V1', command: 'true' }, { id: 'V1', command: 'false' }] } : t)) };
}
function duplicateStandards(): DetailedPlanDoc {
  const p = detailedPlan(M);
  return { ...p, tasks: p.tasks.map((t) => (t.id === 'impl' ? { ...t, standards: [{ id: 'S1', text: 'parses quotes' }, { id: 'S1', text: 'tests pass' }] } : t)) };
}

async function architectQueued() {
  const ports = fakePorts();
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['msg1'] });
  const engine = new FlowEngine(ports);
  await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-decompose' ? null : happyScript(M)(t, s)));
  const task = ports.scheduler.queued('architect-decompose')[0];
  assert.ok(task !== undefined);
  return { ports, engine, task };
}

describe('release review r4: ids that repeat within a task', () => {
  it('the reviewer\'s repro (verification command V1 twice) is refused at the hand-back and bounced by the mechanical check, naming the duplicate', async () => {
    const { ports, engine, task } = await architectQueued();
    const problems = ports.scheduler.run(task.task, { handBack: architect(duplicateCommands()) });
    assert.ok(problems.some((p) => /verification command id "V1" is used more than once/.test(p)), problems.join('\n'));
    assert.equal(ports.scheduler.tasks.get(task.task)?.state, 'queued', 'the seat is told to fix it; nothing is recorded');
    assert.equal((await ports.ledger.records(['object.version'])).filter((c) => c.record.objectKind === 'plan' && c.record.object.startsWith('dplan')).length, 0);
    // a plan that reached the program's checks anyway goes back to the Architect with the reason
    const card = task.card as unknown as ArchitectDecomposeCard;
    void card;
    const mc = await mechanicalCheck({ pmPlan: PmPlanDoc.parse(pmPlan(M)), plan: duplicateCommands(), unsettled: new Set(), hasSymbol: async () => true });
    assert.equal(mc.ok, false);
    assert.ok(mc.failures.some((f) => /ids: task impl: verification command id "V1"/.test(f)));
    // the corrected hand-back goes through and the mission moves on
    assert.deepEqual(ports.scheduler.run(task.task, { handBack: architect(detailedPlan(M)) }), []);
    await drive(engine, ports.scheduler, happyScript(M));
    assert.equal((await ports.ledger.events({ mission: M, event: 'accepted' })).length, 2);
  });

  it('a standard id twice in one task is refused the same way', async () => {
    const { ports, task } = await architectQueued();
    const problems = handBackProblems(task.card, architect(duplicateStandards()), {});
    assert.ok(problems.some((p) => /standard id "S1" is used more than once/.test(p)), problems.join('\n'));
    assert.ok(planIdProblems(duplicateStandards()).length === 1);
    const mc = await mechanicalCheck({ pmPlan: PmPlanDoc.parse(pmPlan(M)), plan: duplicateStandards(), unsettled: new Set(), hasSymbol: async () => true });
    assert.ok(mc.failures.some((f) => /standard id "S1"/.test(f)));
    void ports;
  });

  it('a PM plan that repeats an element id is refused at intake', async () => {
    const ports = fakePorts();
    await seedMission(ports, M);
    const p = pmPlan(M);
    await assert.rejects(submitPmBatch(ports, { mission: M, plan: { ...p, elements: [p.elements[0]!, { ...p.elements[1]!, id: 'e1' }] }, userWords: ['msg1'] }), /element id "e1"/);
  });

  it('a task that still carries a repeated id is never dispatched or verified: the Secretary re-plans it', async () => {
    const ports = fakePorts();
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['msg1'] });
    // an effective plan with the repro, as if it had slipped past every check
    const c = ports.ledger.content;
    const doc = canonicalJson({ format: 'mp4.detailed-plan.v1', mission: M, pmPlan: 'pmplan.m1.1', round: 1, plan: duplicateCommands() });
    await ports.ledger.append('r4:plan', {
      records: [{ kind: 'object.version', object: 'dplan.m1.1.9' as never, objectKind: 'plan', mission: M, module: null, content: c.put(doc), prerequisites: c.putList([]), scope: { paths: ['plans/detailed-plan.json'], taskType: 'detailed-plan' }, reviews: [{ review: 'calibrator-2', basisLines: [], reliesOn: [] }] }],
      events: [{ mission: M, line: 'plan', event: 'effective', key: 'dplan.m1.1.9', body: { dplan: 'dplan.m1.1.9', pmPlan: 'pmplan.m1.1', n: 1, round: 1, mode: 'fast', tasks: ['iface', 'impl'], risks: [] } }],
    });
    const engine = new FlowEngine(ports);
    let replan: SecretaryCard | null = null;
    await drive(engine, ports.scheduler, (t, s) => {
      if (t.card.seat === 'secretary') {
        replan = t.card as unknown as SecretaryCard;
        return null;
      }
      if (t.card.seat === 'calibrator-1' || t.card.seat === 'architect-decompose') return null; // the decision layer is not what this test drives
      return happyScript(M)(t, s);
    });
    const sec = replan as SecretaryCard | null;
    assert.ok(sec !== null && sec.request.source === 'replan' && sec.request.subject === 'task:impl');
    assert.deepEqual(sec.options.map((o) => o.id), ['replan', 'abandon', 'ask-user']);
    assert.equal([...ports.scheduler.tasks.keys()].some((k) => k.startsWith('con.m1.impl')), false, 'the task was not dispatched');
    assert.equal((await ports.ledger.records(['evidence'])).length > 0 && (await ports.ledger.records(['evidence'])).some((e) => e.record.evidence.includes('V1')), false, 'no evidence under the repeated id');
  });

  it('the verification entry refuses repeated command ids before writing or queueing anything', async () => {
    const ports = fakePorts();
    let submitted = 0;
    const ctx = { workDir: '/nonexistent', ledger: ports.ledger, description: {} } as unknown as ActionContext;
    const actions = programActions(ctx, { units: { submit: async () => void submitted++, status: async () => null } });
    const before = ports.ledger.head;
    await assert.rejects(
      actions.verify({ mission: M, object: 'O1', snapshot: '/nonexistent', commands: [{ id: 'V1', command: 'true' }, { id: 'V1', command: 'false' }] }),
      (e: Error & { code?: string }) => e.code === 'conflict' && /repeat ids \(V1\)/.test(e.message),
    );
    assert.equal(ports.ledger.head, before, 'nothing written to the ledger');
    assert.equal(submitted, 0, 'no verification unit queued');
  });
});
