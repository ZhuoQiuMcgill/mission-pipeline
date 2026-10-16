// INT round 3 (Stabilizer): a queued card of a kept task is dispatched under the plan in effect.
// A plan that keeps a task's card writes no newer spec, so the task's last spec can name an older plan.
// The Constructor's ruling-3 check reads the plan in effect, as the flow's gate does (contestedProduction);
// a Reviewer keeps its fixed contract's plan, and a Secretary reads the card in force.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import type { JudgmentRecord } from '../src/common/records.ts';
import { canonicalJson } from '../src/common/hash.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { commit, ev, flowCtx, objectRecord } from '../src/flow/context.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import { contestedProduction, latestEffective, submitPmBatch } from '../src/flow/planning.ts';
import { RENEW_LINE, REVIEW_NEEDED, type DetailedTask } from '../src/flow/plandoc.ts';
import { currentItems, recordItem } from '../src/flow/requirements.ts';
import { raiseEscalation } from '../src/flow/secretary.ts';
import { cal1Fail, detailedPlan, drive, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import type { FlowTask } from '../src/flow/ports.ts';
import { pmDispatch, pmNext } from '../src/process/pm.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { Calibrator1Card } from '../src/seat/cards/calibrator.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
const iface = (): DetailedTask => detailedPlan(M).tasks.find((t) => t.id === 'iface')!;
const holdIface = (t: FlowTask, s: Parameters<ReturnType<typeof happyScript>>[1]) => (t.card.seat === 'constructor' && t.task.startsWith('con.m1.iface.') ? null : happyScript(M)(t, s));
const d1Text = 'The API and tests are read-only after parsing';

/** plan1 accepted; a fast plan2 links the new decision d1 to e1 and e2 and keeps every card. */
async function keptFastPlan() {
  const w = memoryPorts(); say(w, SEED_TEXT); await seedMission(w, M);
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'] });
  const engine = new FlowEngine(w);
  await drive(engine, w.scheduler, happyScript(M));
  const words = say(w, 'Keep both the API and its tests read-only after parsing.');
  await recordItem(w, { mission: M, item: 'd1', type: 'decision', text: d1Text, source: { kind: 'words', words, quote: 'read-only after parsing' } });
  const p = pmPlan(M);
  p.elements[0]!.text += '; read-only after parsing'; p.elements[0]!.items.push('d1');
  p.elements[1]!.text += '; verify read-only behavior'; p.elements[1]!.items.push('d1');
  await submitPmBatch(w, { mission: M, plan: p, userWords: [words], changedItems: ['d1'], mode: 'fast' });
  await drive(engine, w.scheduler, happyScript(M));
  const ctx = flowCtx(w, M);
  assert.equal((await latestEffective(ctx))!.dplan, 'dplan.m1.2.1');
  const spec = (await w.ledger.events({ mission: M, line: 'task:iface', event: 'spec' })).at(-1)!.body as { dplan: string };
  assert.equal(spec.dplan, 'dplan.m1.1.1', 'the kept card has no spec under plan2');
  return { w, engine, ctx, plan: p };
}

/** An environment re-review request on iface's accepted product (as `mp pm renew` records it). */
async function renew(w: World) {
  const ctx = flowCtx(w, M);
  const target = (await acceptedProduct(ctx, 'iface'))!;
  const judgment = (await w.evaluator.deciding([target])).views[target]!.positions.find((p) => p.review === 'reviewer')!.by!;
  const environment = w.ctx.environment().identity;
  await commit(ctx, 'test:renew:iface', { events: [ev(ctx, RENEW_LINE, REVIEW_NEEDED, `${judgment}@${environment}`, { target, judgment, review: 'reviewer', environment, reason: 'environment renewal requires a seat judgment', rerun: null, passed: null })] });
}

/** Re-check plan2 in place; Calibrator ① negates e2, so d1 (linked to e1 as well) becomes contested. */
async function contestE2(w: World, engine: FlowEngine, plan: ReturnType<typeof pmPlan>): Promise<string> {
  const words = say(w, 'Re-check the tests plan against the read-only decision.');
  await submitPmBatch(w, { mission: M, plan, userWords: [words], changedItems: ['d1'] });
  await engine.reconcile(M);
  const cal = w.scheduler.queued('calibrator-1')[0]!;
  assert.deepEqual(await w.scheduler.run(cal.task, { handBack: cal1Fail(cal.card as Calibrator1Card, 'e2', 'contradicts-user') }), []);
  await engine.reconcile(M);
  return `j.${cal.task}`;
}

describe('INT r3: dispatch under the plan in effect', () => {
  it('a kept card\'s fast rework Constructor is held by a dispute on the plan in effect, and released by the ruling', async () => {
    const { w, engine, ctx, plan } = await keptFastPlan();
    await renew(w);
    await drive(engine, w.scheduler, (t) => (t.card.seat === 'reviewer' && t.task.startsWith('rev.m1.iface.') ? { handBack: reviewer(t.card as never, 'rework') } : null));
    const con = 'con.m1.iface.2';
    assert.ok(w.scheduler.queued('constructor').some((t) => t.task === con), 'the rework Constructor is queued under plan2');
    const fail = await contestE2(w, engine, plan);
    const eff = (await latestEffective(ctx))!;
    assert.ok((await currentItems(ctx)).some((i) => i.line === 'item.m1.d1' && i.state === 'contested'));
    assert.equal(await contestedProduction(ctx, eff, detailedPlan(M), iface()), true, 'the flow holds iface');
    assert.throws(() => pmDispatch(w.ctx, con), /contested or negated/, 'dispatch agrees with the flow (ruling 3)');
    assert.ok((await pmNext(w.ctx)).ready.some((r) => r.step === con), 'the step stays queued: the refusal is the wait, not a cancellation');
    // the ruling: a pass revoking the negation (as in P3's dispatch-exit test)
    const neg = (await w.ledger.records(['judgment'])).find((r) => r.record.kind === 'judgment' && r.record.judgment === fail)!.record as JudgmentRecord;
    w.ledger.commit([{ ...neg, judgment: 'j.user.ruling' as never, verdict: 'pass', revokes: neg.judgment, extends: null }]);
    await engine.reconcile(M);
    assert.ok((await currentItems(ctx)).every((i) => i.state === 'valid'));
    assert.equal(await contestedProduction(ctx, eff, detailedPlan(M), iface()), false);
    const d = pmDispatch(w.ctx, con);
    // built under plan2: d1 took effect with plan2, so it is not "recorded after the plan" (D4)
    assert.doesNotMatch(d.card, /recorded after the plan/);
  });

  it('a dispute the revised plan in effect resolved no longer holds a kept card\'s queued Constructor', async () => {
    const w = memoryPorts(); say(w, SEED_TEXT); await seedMission(w, M);
    await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'], mode: 'fast' });
    const engine = new FlowEngine(w); const ctx = flowCtx(w, M);
    await drive(engine, w.scheduler, holdIface);
    const con = 'con.m1.iface.1';
    assert.ok(w.scheduler.queued('constructor').some((t) => t.task === con));
    await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: [say(w, 'Re-check the parser element.')], changedItems: ['g1'] });
    await engine.reconcile(M);
    const cal = w.scheduler.queued('calibrator-1')[0]!;
    assert.deepEqual(await w.scheduler.run(cal.task, { handBack: cal1Fail(cal.card as Calibrator1Card, 'e1', 'contradicts-user') }), []);
    await engine.reconcile(M);
    assert.throws(() => pmDispatch(w.ctx, con), /contested or negated/, 'held while plan1 is negated on e1');
    // the PM agrees a revised e1 with the user; the new plan keeps every card
    const p2 = pmPlan(M); p2.elements[0]!.text = 'A CSV and TSV parser library';
    await submitPmBatch(w, { mission: M, plan: p2, userWords: [say(w, 'A CSV parser library that also reads TSV.')], changedItems: ['g1'], mode: 'fast' });
    await drive(engine, w.scheduler, holdIface);
    const eff = (await latestEffective(ctx))!;
    assert.equal(eff.dplan, 'dplan.m1.2.1');
    assert.equal(await contestedProduction(ctx, eff, detailedPlan(M), iface()), false, 'the flow goes on under plan2');
    assert.ok(w.scheduler.queued('constructor').some((t) => t.task === con), 'the kept card keeps its queued step');
    // before the fix the superseded plan1's negation refused this step for good (no exit but a card change)
    assert.ok(pmDispatch(w.ctx, con).dispatch);
  });

  it('a step queued in fast mode is held by a dispute under a stable plan in effect that kept its card, and released by the ruling', async () => {
    const w = memoryPorts(); say(w, SEED_TEXT); await seedMission(w, M);
    await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'], mode: 'fast' });
    const engine = new FlowEngine(w); const ctx = flowCtx(w, M);
    await drive(engine, w.scheduler, holdIface);
    await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'], mode: 'stable' });
    await drive(engine, w.scheduler, holdIface);
    const eff = (await latestEffective(ctx))!;
    assert.deepEqual([eff.dplan, eff.mode], ['dplan.m1.2.1', 'stable']);
    const con = 'con.m1.iface.1';
    assert.ok(w.scheduler.queued('constructor').some((t) => t.task === con), 'the fast step is kept under the stable plan');
    await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: [say(w, 'Re-check the parser element.')], changedItems: ['g1'] });
    await engine.reconcile(M);
    const cal = w.scheduler.queued('calibrator-1')[0]!;
    assert.deepEqual(await w.scheduler.run(cal.task, { handBack: cal1Fail(cal.card as Calibrator1Card, 'e1', 'contradicts-user') }), []);
    await engine.reconcile(M);
    assert.notEqual((await w.evaluator.labels([eff.dplan])).labels[eff.dplan], 'proven', 'the stable gate holds the task too');
    assert.throws(() => pmDispatch(w.ctx, con), /contested or negated/);
    const neg = (await w.ledger.records(['judgment'])).find((r) => r.record.kind === 'judgment' && r.record.judgment === `j.${cal.task}`)!.record as JudgmentRecord;
    w.ledger.commit([{ ...neg, judgment: 'j.user.ruling' as never, verdict: 'pass', revokes: neg.judgment, extends: null }]);
    await engine.reconcile(M);
    assert.ok(pmDispatch(w.ctx, con).dispatch);
  });

  it('a Constructor step whose card the plan in effect no longer holds is refused as superseded; the next pass cancels it', async () => {
    const w = memoryPorts(); say(w, SEED_TEXT); await seedMission(w, M);
    await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'], mode: 'fast' });
    const engine = new FlowEngine(w); const ctx = flowCtx(w, M);
    await drive(engine, w.scheduler, holdIface);
    // a plan in effect that changes iface's card, before the flow's pass has re-specced the task
    const eff = (await latestEffective(ctx))!;
    const rec = (await objectRecord(ctx, eff.dplan))!;
    const stored = JSON.parse(w.ledger.content.get(rec.content)) as { plan: { tasks: Array<{ id: string; goal: string }> } };
    stored.plan.tasks.find((t) => t.id === 'iface')!.goal = 'Define the Parser interface and its error type';
    const dplan = 'dplan.m1.1.9';
    await commit(ctx, 'test:effective', { events: [ev(ctx, 'plan', 'effective', dplan, { ...eff, dplan })], records: [{ ...rec, object: dplan as never, content: w.ledger.content.put(canonicalJson(stored)) as never }] });
    assert.throws(() => pmDispatch(w.ctx, 'con.m1.iface.1'), /superseded/);
    await engine.reconcile(M);
    assert.ok(!w.scheduler.queued().some((t) => t.task === 'con.m1.iface.1'), 'the flow cancelled the superseded step');
    const next = w.scheduler.queued('constructor').find((t) => t.task === 'con.m1.iface.2');
    assert.ok(next, 'the re-specced card starts its next attempt');
    assert.match(pmDispatch(w.ctx, next.task).card, /its error type/);
  });

  it('Reviewer and Secretary cards of a kept task dispatch under the new plan with the card in force', async () => {
    const { w, engine } = await keptFastPlan();
    // Reviewer: an environment re-review of iface's plan1 product, queued and dispatched under plan2
    await renew(w);
    await engine.reconcile(M);
    const rev = w.scheduler.queued('reviewer').find((t) => t.task.startsWith('rev.m1.iface.'));
    assert.ok(rev, 'the re-review Reviewer is queued');
    const rd = pmDispatch(w.ctx, rev.task);
    // it judges under its fixed contract (plan1): d1 was recorded after plan1 took effect (D4)
    assert.match(rd.card, new RegExp(`${d1Text} \\(recorded after the plan\\)`));
    assert.match(rd.card, /The interface compiles/);
    // Secretary: an escalation on the kept task, queued and dispatched under plan2
    await raiseEscalation(flowCtx(w, M), { id: 'kept-question', source: 'constructor-decision', lineage: 'task.m1.iface', subject: 'task:iface', summary: 'Question', reasons: ['Choose'], options: ['answer', 'abandon', 'ask-user'], items: ['item.m1.g1'] });
    const sd = pmDispatch(w.ctx, 'sec.kept-question');
    const facts = (dispatchView(w.ctx, sd.dispatch).card['materials'] as Array<{ id: string; ref: string }>).find((m) => m.id === 'current-facts')!;
    const task = (JSON.parse(w.memory.data.text(facts.ref)) as { task: DetailedTask | null }).task;
    assert.deepEqual(task, iface(), 'the card in force, unchanged under plan2');
  });
});
