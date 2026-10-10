// The exploration flow in the flow engine (design 3.8, 3.10, 8.2): an effective PM plan starts its
// explorations; a converged exploration settles for the decision layer; a budget stop goes to the
// Secretary as an escalation whose decision is carried out once: a grant extends the rounds, an
// accepted residual risk settles the exploration with the version proven by the ruling.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { answerEscalation } from '../src/flow/secretary.ts';
import { fakePorts } from '../src/flow/fakes.ts';
import { EXPLORATION_SETTLED, PLAN_LINE, PM_PLAN_EFFECTIVE, SECRETARY_LINE, type ExplorationSettledBody, type PmPlanDoc, type PmPlanEffectiveBody } from '../src/flow/plandoc.ts';
import { explorationStep } from '../src/flow/exploration/step.ts';
import { EXPLORATION_FLOW_STEPS } from '../src/flow/exploration/register.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import { attack, finding, recheckAll, reviseAll, submit } from './flow-exploration-fixtures.ts';

const M = 'M1' as MissionId;

async function planned(rounds: number, type: 'direction' | 'structure' = 'structure') {
  const p = fakePorts();
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
        provenance: { by: 'user', message: 'm1', quote: 'figure out the evidence hand-back' },
        exploration: {
          id: 'X1',
          deliverable: 'a design of the evidence hand-back',
          fuzzyGoal: { quote: 'no obvious hole', message: 'm1' },
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
  const hand = (kind: string, r: unknown) => {
    const t = one(kind);
    assert.deepEqual(p.scheduler.run(t.task, { handBack: r }), []);
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
    w.hand('researcher-author', submit('design v1'));
    await w.step();
    w.hand('crititor', attack());
    await w.step();
    w.hand('crititor', attack());
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
    w.hand('researcher-author', submit('v1'));
    await w.step();
    w.hand('crititor', attack([finding('serious', 'gets stuck', 'waits forever')]));
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
    const a2 = w.one('researcher-author').card as unknown as AuthorCard;
    assert.equal(a2.budgetRounds, 3);
    w.hand('researcher-author', submit('v2', reviseAll(a2)));
    await w.step();
    w.hand('crititor', attack([finding('serious', 'internal contradiction', 'two rules')], recheckAll(w.one('crititor').card as unknown as CrititorCard, 'yes')));
    await w.step();
    w.hand('researcher-author', submit('v3', reviseAll(w.one('researcher-author').card as unknown as AuthorCard)));
    await w.step();
    const c = w.one('crititor').card as unknown as CrititorCard;
    w.hand('crititor', attack([finding('fatal', 'gets stuck', 'a new deadlock')], recheckAll(c, 'yes')));
    await w.step();
    const esc2 = (await w.ledger.events<{ id: string; position: { target: string; review: string; revokes: string } | null }>({ mission: M, line: SECRETARY_LINE, event: 'escalation' }))[1];
    assert.ok(esc2);
    assert.equal(esc2.body.position?.target, c.target);
    assert.equal(esc2.body.position?.review, 'crititor');
    assert.equal((await w.evaluator.labels([c.target as string])).labels[c.target as string], 'negated');

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
    w.hand('researcher-author', submit('v1'));
    await w.step();
    w.hand('crititor', attack([finding('serious', 'internal contradiction', 'server or not')]));
    await w.step();
    const a = w.one('researcher-author').card as unknown as AuthorCard;
    w.hand('researcher-author', submit('', [{ finding: a.openFindings[0]?.id as string, action: 'escalate', note: 'the user said local only', question: 'May it run a local server?' }]));
    await w.step();
    const q = (await w.ledger.events<{ id: string; source: string }>({ mission: M, line: SECRETARY_LINE, event: 'escalation' })).find((e) => e.body.source === 'exploration-direction');
    assert.ok(q);
    w.hand('crititor', attack());
    await w.step();
    assert.equal(w.scheduler.queued('researcher-author').length, 0, 'waits for the ruling');
    await answerEscalation(w.ports, { mission: M, escalation: q.body.id, option: 'answer', instructions: 'No server: use a file lock.', words: 'no server' });
    await w.step();
    const a2 = w.one('researcher-author').card as unknown as AuthorCard;
    assert.equal(a2.openFindings.length, 1);
    assert.equal(a2.openFindings[0]?.ruling, 'No server: use a file lock.');
  });
});

describe('exploration in the flow engine: a given-up turn', () => {
  test('the Secretary restarts the given-up attacker turn (WI-15)', async () => {
    const w = await planned(6);
    await w.step();
    w.hand('researcher-author', submit('v1'));
    await w.step();
    const t = w.one('crititor');
    w.scheduler.run(t.task, { fail: 'seat-failure' });
    await w.scheduler.cancel(t.task);
    await w.step();
    const esc = (await w.ledger.events<{ id: string; source: string; options: string[] }>({ mission: M, line: SECRETARY_LINE, event: 'escalation' })).find((e) => e.body.source === 'needs-disposition');
    assert.deepEqual(esc?.body.options, ['restart', 'abandon', 'ask-user']);
    await answerEscalation(w.ports, { mission: M, escalation: esc?.body.id as string, option: 'restart', words: 'try again' });
    await w.step();
    const again = w.one('crititor');
    assert.notEqual(again.task, t.task);
  });
});

describe('exploration in the flow engine: failed seat tasks go to the Secretary (failures.ts)', () => {
  test('a failed attacker is restarted (counted), a failed evidence run abandoned (recorded as failed), a failed author abandoned (no conclusion)', async () => {
    const w = await planned(6);
    await w.step();
    w.hand('researcher-author', submit('v1'));
    await w.step();
    const atk = w.one('crititor');
    w.scheduler.run(atk.task, { fail: 'seat-failure' });
    await w.step();
    const escs = async () => (await w.ledger.events<{ id: string; source: string; options: string[]; subject: string }>({ mission: M, line: SECRETARY_LINE, event: 'escalation' })).map((e) => e.body);
    const e1 = (await escs()).find((e) => e.source === 'needs-disposition');
    assert.ok(e1);
    assert.equal(e1.subject, 'exploration:X1');
    assert.ok(e1.options.includes('restart'));
    await answerEscalation(w.ports, { mission: M, escalation: e1.id, option: 'restart', words: 'again' });
    await w.step();
    assert.equal(w.one('crititor').task, atk.task, 'the same task, restarted by the scheduler');
    assert.equal((await w.ledger.loop('xp.M1.X1', 'quarantine-restart')).attempts, 1);

    // the attacker asks for evidence; the run fails and is abandoned: recorded as failed, the attacker resumes
    w.scheduler.run(atk.task, { evidence: { steps: ['run it'], data: '', measure: ['x'], assertions: [] }, sessionId: 'sa' });
    await w.step();
    const ex = w.one('constructor-experiment');
    w.scheduler.run(ex.task, { fail: 'seat-failure' });
    await w.step();
    const e2 = (await escs()).find((e) => e.source === 'needs-disposition' && e.id !== e1.id);
    assert.ok(e2);
    await answerEscalation(w.ports, { mission: M, escalation: e2.id, option: 'abandon', words: 'skip it' });
    await w.step();
    const ev = (await w.ledger.records(['evidence'])).map((c) => c.record.fields['status']);
    assert.deepEqual(ev, ['failed']);
    const c = w.one('crititor').card as unknown as CrititorCard;
    assert.equal(c.resume?.sessionId, 'sa');

    // the attacker hands back a finding; the author fails and is abandoned: the exploration settles without a conclusion
    w.hand('crititor', attack([finding('serious', 'gets stuck', 'x')]));
    await w.step();
    const au = w.one('researcher-author');
    w.scheduler.run(au.task, { fail: 'seat-failure' });
    await w.step();
    const e3 = (await escs()).find((e) => e.source === 'needs-disposition' && e.id !== e1.id && e.id !== e2.id);
    assert.ok(e3);
    await answerEscalation(w.ports, { mission: M, escalation: e3.id, option: 'abandon', words: 'give it up' });
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
    w.hand('researcher-author', submit('v1'));
    await w.step();
    w.hand('crititor', attack());
    await w.step();
    // the closing attacker is queued; the user changes the goal before it runs
    const c1 = w.one('crititor').card as unknown as CrititorCard;
    assert.equal(c1.fresh, true);
    w.hand('crititor', attack([finding('serious', 'gets stuck', 'x')]));
    await w.step();
    const target = c1.target as string;
    const planDoc = JSON.parse(w.ledger.content.get((await w.ledger.events<PmPlanEffectiveBody>({ mission: M, line: PLAN_LINE, event: PM_PLAN_EFFECTIVE }))[0]?.body.doc as string)) as PmPlanDoc;
    const el = planDoc.elements[0];
    if (el?.exploration === undefined) throw new Error('fixture');
    const doc2: PmPlanDoc = { ...planDoc, round: 2, elements: [{ ...el, exploration: { ...el.exploration, fuzzyGoal: { quote: 'no hole, and fast', message: 'm2' } } }] };
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
    w.hand('researcher-author', submit('v2', reviseAll(a)));
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
