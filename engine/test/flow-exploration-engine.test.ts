// The exploration flow in the flow engine (design 3.8, 3.10, 8.2; 4.1 §6.3, decision 15): an
// effective PM plan starts its explorations; a converged exploration settles for the decision layer;
// a budget stop goes to the Secretary as an escalation whose decision is carried out once: a grant
// extends the rounds, an accepted residual risk settles the exploration with the version proven by
// the ruling. A released dispatch is re-dispatched (counted); used up, the Secretary decides.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { answerEscalation } from '../src/flow/secretary.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';
import { EXPLORATION_SETTLED, PLAN_LINE, PM_PLAN_EFFECTIVE, SECRETARY_LINE, type ExplorationSettledBody, type PmPlanDoc, type PmPlanEffectiveBody } from '../src/flow/plandoc.ts';
import { explorationStep } from '../src/flow/exploration/step.ts';
import { EXPLORATION_FLOW_STEPS } from '../src/flow/exploration/register.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import { attack, finding, recheckAll, reviseAll, stabilizeAll, submit } from './flow-exploration-fixtures.ts';

const M = 'M1' as MissionId;

async function planned(rounds: number, type: 'direction' | 'structure' = 'structure') {
  const p = memoryPorts();
  const ports = { ledger: p.ledger, scheduler: p.scheduler, evaluator: p.evaluator };
  const doc: PmPlanDoc = {
    format: 'mp4.pm-plan.v1',
    mission: M,
    round: 1,
    order: 'free',
    elements: [
      {
        id: 'el1',
        kind: 'exploration',
        text: 'how the scheduler hands evidence back',
        provenance: { by: 'user', words: 'W-1', quote: 'figure out the evidence hand-back' },
        exploration: {
          id: 'X1',
          deliverable: 'a design of the evidence hand-back',
          fuzzyGoal: { quote: 'no obvious hole', words: 'W-1' },
          attackScope: ['gets stuck', 'internal contradiction'],
          decision: { id: 'D1', type },
          budget: { rounds, micros: null },
          stop: '',
          research: false,
        },
        after: [],
        items: [],
      },
    ],
    goalsBeyond: [],
    authorizations: [],
  };
  const body: PmPlanEffectiveBody = { plan: 'pmplan.1', batch: 'b1', round: 1, doc: p.ledger.content.put(JSON.stringify(doc)), explorations: ['X1'] };
  await p.ledger.append('pm-effective', { events: [{ mission: M, line: PLAN_LINE, event: PM_PLAN_EFFECTIVE, key: 'pmplan.1', body }] });
  // passes until one makes no progress, as the flow engine does
  const step = async (): Promise<boolean> => {
    let any = false;
    for (let i = 0; i < 20; i++) {
      const ctx = flowCtx(ports, M);
      await explorationStep(ctx);
      if (!ctx.progressed) break;
      any = true;
    }
    return any;
  };
  const one = (kind: string) => {
    const q = p.scheduler.queued(kind);
    assert.equal(q.length, 1, `one queued ${kind}: ${q.map((t) => t.task).join(', ')}`);
    return q[0] as NonNullable<(typeof q)[0]>;
  };
  // every round's Stabilizer hands back its default judgment (4.1 §6.3), as in flow-exploration-fixtures.ts
  const hand = async (kind: string, r: unknown) => {
    const t = one(kind);
    assert.deepEqual(await p.scheduler.run(t.task, { handBack: r }), []);
    if (kind === 'researcher-author' || kind === 'crititor') {
      await step();
      const st = p.scheduler.queued('stabilizer')[0];
      if (st !== undefined) assert.deepEqual(await p.scheduler.run(st.task, { handBack: stabilizeAll(st.card as unknown as StabilizerCard) }), []);
    }
    return t;
  };
  return { ...p, ports, step, one, hand };
}

describe('exploration in the flow engine', () => {
  test('a PM plan starts the exploration; convergence settles it for the decision layer', async () => {
    const w = await planned(6);
    assert.equal(await w.step(), true);
    const a = w.one('researcher-author').card as unknown as AuthorCard;
    assert.equal(a.goal, 'no obvious hole');
    assert.deepEqual(a.attackScope, ['gets stuck', 'internal contradiction']);
    await w.hand('researcher-author', submit('design v1'));
    await w.step();
    await w.hand('crititor', attack());
    await w.step();
    await w.hand('crititor', attack());
    await w.step();
    const s = await w.ledger.events<ExplorationSettledBody>({ mission: M, line: 'exploration:X1', event: EXPLORATION_SETTLED });
    assert.equal(s.length, 1);
    assert.equal(s[0]?.key, 'X1');
    assert.deepEqual([s[0]?.body.outcome, s[0]?.body.stop, s[0]?.body.decision], ['conclusion', 'converged', { id: 'D1', type: 'structure' }]);
    assert.ok(s[0]?.body.artifact?.startsWith('xpv.M1.X1.'));
    // settled once; further passes change nothing
    assert.equal(await w.step(), false);
    assert.deepEqual(EXPLORATION_FLOW_STEPS.map((x) => x.name), ['exploration', 'legalization']);
  });

  test('budget stop → Secretary escalation; a grant extends once; a second stop accepted with residual risk settles with the version proven', async () => {
    const w = await planned(1);
    await w.step();
    await w.hand('researcher-author', submit('v1'));
    await w.step();
    await w.hand('crititor', attack([finding('serious', 'gets stuck', 'waits forever')]));
    await w.step();
    // the round ends with the author's disposition and the Stabilizer's judgment (4.1 §6.3)
    await w.hand('researcher-author', submit('v2', reviseAll(w.one('researcher-author').card as unknown as AuthorCard)));
    await w.step();
    const esc = await w.ledger.events<{ id: string; source: string; options: string[]; position: unknown }>({ mission: M, line: SECRETARY_LINE, event: 'escalation' });
    assert.equal(esc.length, 1);
    assert.equal(esc[0]?.body.source, 'exploration-budget');
    assert.ok(esc[0]?.body.options.includes('grant'));
    assert.ok(w.scheduler.queued('secretary').length === 1, 'a Secretary task decides it');
    assert.equal(w.ledger.notices.find((n) => n.category === 'exploration-budget-exhausted')?.wi, 'WI-08');

    // the decision (here the user's answer, as the PM records it): grant two rounds
    await answerEscalation(w.ports, { mission: M, escalation: esc[0]?.body.id as string, option: 'grant', grantExtra: 2, words: 'two more rounds' });
    await w.step();
    await w.hand('crititor', attack([finding('serious', 'internal contradiction', 'two rules')], recheckAll(w.one('crititor').card as unknown as CrititorCard, 'yes')));
    await w.step();
    const a3 = w.one('researcher-author').card as unknown as AuthorCard;
    assert.equal(a3.budgetRounds, 3);
    await w.hand('researcher-author', submit('v3', reviseAll(a3)));
    await w.step();
    const c = w.one('crititor').card as unknown as CrititorCard;
    await w.hand('crititor', attack([finding('fatal', 'gets stuck', 'a new deadlock')], recheckAll(c, 'yes')));
    await w.step();
    await w.hand('researcher-author', submit('v4', reviseAll(w.one('researcher-author').card as unknown as AuthorCard)));
    await w.step();
    const esc2 = (await w.ledger.events<{ id: string; position: { target: string; review: string; revokes: string } | null }>({ mission: M, line: SECRETARY_LINE, event: 'escalation' }))[1];
    assert.ok(esc2);
    assert.equal(esc2.body.position?.target, c.target);
    assert.equal(esc2.body.position?.review, 'crititor');
    assert.equal((await w.evaluator.labels([c.target as string])).labels[c.target as string], 'negated', 'the Stabilizer\'s judgment negated it');

    await answerEscalation(w.ports, { mission: M, escalation: esc2.body.id, option: 'accept-risk', words: 'ship it with that risk' });
    await w.step();
    const s = (await w.ledger.events<ExplorationSettledBody>({ mission: M, line: 'exploration:X1', event: EXPLORATION_SETTLED }))[0];
    assert.equal(s?.body.outcome, 'conclusion');
    assert.equal(s?.body.stop, 'budget');
    assert.ok(s?.body.unresolved.some((u) => u.includes('residual risk')));
    assert.equal((await w.evaluator.labels([c.target as string])).labels[c.target as string], 'proven', "the user's ruling revoked the negation (8.1)");
    assert.equal(w.scheduler.queued('researcher-author').length + w.scheduler.queued('crititor').length, 0);
  });

  test('an escalated finding becomes a Secretary question; the answer sends it back to the author', async () => {
    const w = await planned(6, 'direction');
    await w.step();
    await w.hand('researcher-author', submit('v1'));
    await w.step();
    await w.hand('crititor', attack([finding('serious', 'internal contradiction', 'server or not')]));
    await w.step();
    const a = w.one('researcher-author').card as unknown as AuthorCard;
    await w.hand('researcher-author', submit('', [{ finding: a.openFindings[0]?.id as string, action: 'escalate', note: 'the user said local only', question: 'May it run a local server?' }]));
    await w.step();
    const q = (await w.ledger.events<{ id: string; source: string }>({ mission: M, line: SECRETARY_LINE, event: 'escalation' })).find((e) => e.body.source === 'exploration-direction');
    assert.ok(q);
    assert.equal(w.scheduler.queued('researcher-author').length + w.scheduler.queued('crititor').length, 0, 'awaiting ruling: no attack, no author (4.1 §6.3)');
    await answerEscalation(w.ports, { mission: M, escalation: q.body.id, option: 'answer', instructions: 'No server: use a file lock.', words: 'no server' });
    await w.step();
    const a2 = w.one('researcher-author').card as unknown as AuthorCard;
    assert.equal(a2.openFindings.length, 1);
    assert.equal(a2.openFindings[0]?.ruling, 'No server: use a file lock.');
  });
});

describe('exploration in the flow engine: a released dispatch (decision 15)', () => {
  test('the PM releases the attacker\'s dispatch: re-dispatched twice (counted); the third release goes to the Secretary, whose grant dispatches it again', async () => {
    const w = await planned(6);
    await w.step();
    await w.hand('researcher-author', submit('v1'));
    await w.step();
    const t = w.one('crititor');
    for (let i = 1; i <= 2; i++) {
      await w.scheduler.run(t.task, { release: 'abandoned' });
      await w.step();
      assert.equal(w.one('crititor').task, t.task, 'the same task, dispatched again');
      assert.equal((await w.ledger.loop(t.lineage, 'quarantine-restart')).attempts, i);
    }
    await w.scheduler.run(t.task, { release: 'abandoned' });
    await w.step();
    assert.equal(w.scheduler.queued('crititor').length, 0, 'used up: only this line waits for the Secretary');
    const esc = (await w.ledger.events<{ id: string; source: string; options: string[] }>({ mission: M, line: SECRETARY_LINE, event: 'escalation' })).find((e) => e.body.source === 'loop-exhausted');
    assert.deepEqual(esc?.body.options, ['grant', 'abandon', 'ask-user']);
    assert.equal(w.ledger.notices.find((n) => n.category === 'loop-exhausted')?.wi, 'WI-08');
    await answerEscalation(w.ports, { mission: M, escalation: esc?.body.id as string, option: 'grant', grantExtra: 1, words: 'one more try' });
    await w.step();
    assert.equal(w.one('crititor').task, t.task);
  });
});

describe('exploration in the flow engine: used-up seat tasks go to the Secretary (failures.ts)', () => {
  test('an evidence run whose dispatches are used up is abandoned (recorded as failed, the attacker continues); a used-up author abandoned (no conclusion)', async () => {
    const w = await planned(6);
    await w.step();
    await w.hand('researcher-author', submit('v1'));
    await w.step();
    const escs = async () => (await w.ledger.events<{ id: string; source: string; options: string[]; subject: string }>({ mission: M, line: SECRETARY_LINE, event: 'escalation' })).map((e) => e.body);
    const useUp = async (task: string): Promise<void> => {
      for (let i = 0; i < 3; i++) {
        await w.scheduler.run(task, { release: 'abandoned' });
        await w.step();
      }
    };

    // the attacker asks for evidence; the run's dispatches are used up and the Secretary abandons it
    const atk = w.one('crititor');
    await w.scheduler.run(atk.task, { evidence: { steps: ['run it'], data: '', measure: ['x'], assertions: [] }, notes: 'sa' });
    await w.step();
    const ex = w.one('constructor-experiment');
    await useUp(ex.task);
    const e1 = (await escs()).find((e) => e.source === 'loop-exhausted');
    assert.ok(e1);
    assert.equal(e1.subject, 'exploration:X1');
    await answerEscalation(w.ports, { mission: M, escalation: e1.id, option: 'abandon', words: 'skip it' });
    await w.step();
    const ev = (await w.ledger.records(['evidence'])).filter((c) => c.record.evidence.startsWith('xpe.')).map((c) => c.record.fields['status']);
    assert.deepEqual(ev, ['failed']);
    const c = w.one('crititor').card as unknown as CrititorCard;
    assert.equal(c.continuation?.previous, atk.task);
    assert.match(c.continuation?.evidence ?? '', /failed/);

    // the attacker hands back a finding; the author's dispatches are used up and it is abandoned: the exploration settles without a conclusion
    await w.hand('crititor', attack([finding('serious', 'gets stuck', 'x')]));
    await w.step();
    const au = w.one('researcher-author');
    await useUp(au.task);
    const e2 = (await escs()).find((e) => e.source === 'loop-exhausted' && e.id !== e1.id);
    assert.ok(e2);
    await answerEscalation(w.ports, { mission: M, escalation: e2.id, option: 'abandon', words: 'give it up' });
    await w.step();
    const settled = await w.ledger.events<ExplorationSettledBody>({ mission: M, line: 'exploration:X1', event: EXPLORATION_SETTLED });
    assert.equal(settled[0]?.body.outcome, 'no-conclusion');
    assert.equal(w.scheduler.queued().filter((t) => t.card.seat !== 'secretary').length, 0);
  });
});

describe('exploration in the flow engine: the plan changes the exploration', () => {
  test('a changed goal is a new definition version: judgments on the old one stop being current and the version is attacked again', async () => {
    const w = await planned(6);
    await w.step();
    await w.hand('researcher-author', submit('v1'));
    await w.step();
    await w.hand('crititor', attack());
    await w.step();
    // the closing attacker is queued; the user changes the goal before it runs
    const c1 = w.one('crititor').card as unknown as CrititorCard;
    assert.equal(c1.fresh, true);
    await w.hand('crititor', attack([finding('serious', 'gets stuck', 'x')]));
    await w.step();
    const target = c1.target as string;
    const planDoc = JSON.parse(w.ledger.content.get((await w.ledger.events<PmPlanEffectiveBody>({ mission: M, line: PLAN_LINE, event: PM_PLAN_EFFECTIVE }))[0]?.body.doc as string)) as PmPlanDoc;
    const el = planDoc.elements[0];
    if (el?.exploration === undefined) throw new Error('fixture');
    const doc2: PmPlanDoc = { ...planDoc, round: 2, elements: [{ ...el, exploration: { ...el.exploration, fuzzyGoal: { quote: 'no hole, and fast', words: 'W-2' } } }] };
    const body: PmPlanEffectiveBody = { plan: 'pmplan.2', batch: 'b2', round: 2, doc: w.ledger.content.put(JSON.stringify(doc2)), explorations: ['X1'] };
    await w.ledger.append('pm-effective-2', { events: [{ mission: M, line: PLAN_LINE, event: PM_PLAN_EFFECTIVE, key: 'pmplan.2', body }] });
    await w.step();
    const bases = (await w.ledger.records(['basis.version'])).map((c) => c.record.version);
    assert.ok(bases.includes('xpdef.M1.X1.v2' as never));
    const judgments = (await w.ledger.records(['judgment'])).map((c) => c.record.judgment);
    const cur = await w.evaluator.judgments(judgments);
    assert.ok(Object.values(cur.current).every((v) => v === false), 'every judgment bound to the old definition is no longer current');
    // the author's task was queued before the change: a task in flight keeps its card
    const a = w.one('researcher-author').card as unknown as AuthorCard;
    assert.equal(a.goal, 'no obvious hole');
    await w.hand('researcher-author', submit('v2', reviseAll(a)));
    await w.step();
    const c2 = w.one('crititor').card as unknown as CrititorCard;
    assert.equal(c2.goal, 'no hole, and fast');
    assert.deepEqual(w.ledger.content.getList(c2.binding?.bases as never), ['xpdef.M1.X1.v2']);
    assert.notEqual(c2.target, target);
    // the same plan once more changes nothing
    const body3: PmPlanEffectiveBody = { ...body, plan: 'pmplan.3' };
    await w.ledger.append('pm-effective-3', { events: [{ mission: M, line: PLAN_LINE, event: PM_PLAN_EFFECTIVE, key: 'pmplan.3', body: body3 }] });
    await w.step();
    assert.equal((await w.ledger.records(['basis.version'])).filter((c) => c.record.line === ('xpdef.M1.X1' as never)).length, 2);
  });
});
