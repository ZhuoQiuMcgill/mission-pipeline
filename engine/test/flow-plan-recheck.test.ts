// A requirement item recorded after the PM plan took effect (design v51 3.3, 5.2 part 5): the plan's
// calibrator-1 judgment binds the whole requirement set, so the plan, every detailed plan of it
// and every product accepted under them lose their proof. The PM submits the plan in effect,
// unchanged, with the batch's words and changed items: Calibrator ① judges the same version again
// (a continuation of its deciding pass), and a pass restores the whole chain without a new
// version, an Architect, a feasibility review or a Calibrator ②.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { recordItem } from '../src/flow/requirements.ts';
import { cal1Fail, cal1Pass, drive, happyScript, pmPlan, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import type { Calibrator1Card } from '../src/seat/cards/calibrator.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
const LATER = 'Once it has parsed a file, keep the parser read-only.';

async function setup() {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'] });
  return { ports, engine: new FlowEngine(ports) };
}

/** The user's later decision: a requirement item no plan element rests on. */
async function laterDecision(ports: ReturnType<typeof memoryPorts>): Promise<string> {
  const w = say(ports, LATER);
  await recordItem(ports, { mission: M, item: 'd1', type: 'decision', text: 'The parser is read-only once it has parsed a file', source: { kind: 'words', words: w, quote: 'keep the parser read-only' } });
  return w;
}

async function labelsOf(ports: ReturnType<typeof memoryPorts>, ids: readonly string[]): Promise<Record<string, unknown>> {
  return (await ports.evaluator.labels(ids)).labels;
}

const products = async (ports: ReturnType<typeof memoryPorts>): Promise<string[]> => (await ports.ledger.events<{ product: string }>({ mission: M, event: 'accepted' })).map((e) => e.body.product);

describe('flow: a requirement item recorded after the plan took effect (3.3, 5.2 part 5)', () => {
  it('the plan in effect submitted unchanged is re-checked in place: a pass restores the plan, the detailed plan and the accepted products, with no new version and no Architect', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, happyScript(M));
    const chain = ['pmplan.m1.1', 'dplan.m1.1.1', ...(await products(ports))];
    assert.equal(chain.length, 4);
    for (const [id, l] of Object.entries(await labelsOf(ports, chain))) assert.equal(l, 'proven', `${id} before`);

    const w = await laterDecision(ports);
    // the requirement set has a new version: the plan's pass is not current, and nothing relying on it is proven
    for (const [id, l] of Object.entries(await labelsOf(ports, chain))) assert.equal(l, 'not-fully-proven', `${id} after the item`);

    const r = await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: [w], changedItems: ['d1'] });
    assert.deepEqual(r, { batch: 'b1.c1', plan: 'pmplan.m1.1', recheck: true });
    // a retry of the same request is the same re-check
    assert.deepEqual(await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: [w], changedItems: ['d1'] }), r);
    assert.equal((await ports.ledger.events({ mission: M, line: 'plan', event: 'pm-batch' })).length, 1, 'no new batch, no new plan version');
    assert.equal((await ports.ledger.events({ mission: M, line: 'plan', event: 'cal1-recheck' })).length, 1);

    await engine.reconcile(M);
    const card = ports.scheduler.card<Calibrator1Card>('cal1.m1.1.c1');
    assert.equal(card.target, 'pmplan.m1.1', 'the same plan version is judged again');
    assert.deepEqual(card.mode, { kind: 'continuation', extends: 'j.cal1.m1.1' });
    assert.deepEqual(card.focus, ['e1', 'e2'], 'no element rests on the new item: every element is judged against it');
    assert.ok(!card.materials.some((m) => m.id === 'plan-old'), 'one plan text: it is unchanged');
    const items = ports.ledger.content.get(card.materials.find((m) => m.id === 'items')!.ref);
    assert.ok(items.includes('item.m1.d1'), `the changed item is on the card: ${items}`);
    const words = ports.ledger.content.get(card.materials.find((m) => m.id === 'words')!.ref);
    assert.ok(words.includes(LATER), "the batch's words are on the card");

    const ran = await drive(engine, ports.scheduler, happyScript(M));
    assert.deepEqual(ran, ['cal1.m1.1.c1'], 'only the re-check runs: no Architect, feasibility review or Calibrator ②');
    for (const [id, l] of Object.entries(await labelsOf(ports, chain))) assert.equal(l, 'proven', `${id} after the re-check`);
    assert.equal((await ports.ledger.events({ mission: M, line: 'plan', event: 'attempt' })).length, 1, 'no new Architect attempt');
    assert.equal(ports.ledger.notices.length, 0, ports.ledger.notices.map((n) => n.category).join(', '));
  });

  it('stable mode: work in flight waits while the plan is not proven (its review is not even taken in) and goes on after the re-check passes', async () => {
    const { ports, engine } = await setup();
    let hold = true;
    const base = happyScript(M);
    // the interface's Reviewer is held: the requirement item arrives before it judges the interface
    const script: Script = (t, s) => (hold && t.card.seat === 'reviewer' ? null : base(t, s));
    await drive(engine, ports.scheduler, script);
    assert.equal((await products(ports)).length, 0);
    const w = await laterDecision(ports);
    hold = false;
    const ran0 = await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'reviewer' ? base(t, s) : null));
    assert.deepEqual(ran0, ['rev.m1.iface.1'], 'the Reviewer hands back');
    assert.equal((await products(ports)).length, 0, 'stable mode: the gate holds the task, so its review is not taken in');
    assert.ok(!ports.scheduler.queued().some((t) => t.card.seat === 'constructor'), 'nothing new is released on a plan that is not proven');
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: [w], changedItems: ['d1'] });
    const ran = await drive(engine, ports.scheduler, base);
    assert.equal(ran[0], 'cal1.m1.1.c1');
    assert.ok(ran.some((t) => t.startsWith('con.m1.impl')), `the dependent starts after the re-check: ${ran.join(', ')}`);
    const all = await products(ports);
    assert.equal(all.length, 2, 'the held review is taken in and the dependent is accepted');
    for (const p of all) assert.equal((await labelsOf(ports, [p]))[p], 'proven', p);
  });

  it('a failing re-check goes back to the PM; the plan stays in effect unproven, and the next version is reviewed in full', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, happyScript(M));
    const w = await laterDecision(ports);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: [w], changedItems: ['d1'] });
    await drive(engine, ports.scheduler, (t) => (t.card.seat === 'calibrator-1' ? { handBack: cal1Fail(t.card as unknown as Calibrator1Card, 'e1', 'contradicts-user') } : null));
    const n = ports.ledger.notices.find((x) => x.category === 'calibrator-1-returned');
    assert.ok(n !== undefined && n.wi === null, 'a return to the PM is a normal branch');
    assert.match(String(n.defaultAction), /stays in effect/);
    assert.equal((await labelsOf(ports, ['pmplan.m1.1']))['pmplan.m1.1'], 'negated');
    // the PM changes the plan: a new version; the position's deciding judgment is the failed re-check, so no continuation
    const plan2 = pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'A CSV parser library, read-only once it has parsed a file', items: ['g1', 'd1'] }, pmPlan(M).elements[1]!] });
    const r = await submitPmBatch(ports, { mission: M, plan: plan2, userWords: [w], changedItems: ['d1'] });
    assert.deepEqual(r, { batch: 'b2', plan: 'pmplan.m1.2' });
    await engine.reconcile(M);
    assert.equal(ports.scheduler.card<Calibrator1Card>('cal1.m1.2').mode.kind, 'full');
  });

  it('after a passing re-check, the next version continues from the re-check, the deciding pass', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, happyScript(M));
    const w = await laterDecision(ports);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: [w], changedItems: ['d1'] });
    await drive(engine, ports.scheduler, (t) => (t.card.seat === 'calibrator-1' ? { handBack: cal1Pass(t.card as unknown as Calibrator1Card) } : null));
    const plan2 = pmPlan(M, { elements: [pmPlan(M).elements[0]!, { ...pmPlan(M).elements[1]!, text: 'Covered by unit and property tests' }] });
    await submitPmBatch(ports, { mission: M, plan: plan2, userWords: ['W-1'] });
    await engine.reconcile(M);
    const card = ports.scheduler.card<Calibrator1Card>('cal1.m1.2');
    assert.deepEqual(card.mode, { kind: 'continuation', extends: 'j.cal1.m1.1.c1' });
    assert.deepEqual(card.focus, ['e2']);
    const ran = await drive(engine, ports.scheduler, happyScript(M));
    assert.equal(ran[0], 'cal1.m1.2', 'the continuation is accepted (not refused into a full review)');
    assert.ok(!ran.includes('cal1.m1.2.full'));
  });

  it('the same document before the plan took effect, or with another mode, is still a new batch', async () => {
    const { ports, engine } = await setup();
    // not yet in effect: a new batch of the same document (the earlier one's Calibrator ① has not started)
    const r = await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1'] });
    assert.deepEqual(r, { batch: 'b2', plan: 'pmplan.m1.2' });
    await drive(engine, ports.scheduler, happyScript(M));
    // in effect, but the batch changes the mode: a new batch (the mode belongs to a version)
    const r2 = await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['s1'], mode: 'fast' });
    assert.deepEqual(r2, { batch: 'b3', plan: 'pmplan.m1.3' });
  });
});
