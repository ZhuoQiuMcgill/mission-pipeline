import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { recordConstraint } from '../src/flow/requirements.ts';
import { cal1Pass, drive, happyScript, pmPlan, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import { withdrawConstraint } from '../src/memory/domain/constraints.ts';
import { listNotices } from '../src/process/notices.ts';
import type { Calibrator1Card } from '../src/seat/cards/calibrator.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
async function setup(mode: 'stable' | 'fast' = 'stable') {
  const w = memoryPorts(); say(w, SEED_TEXT); await seedMission(w, M);
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'], mode });
  const engine = new FlowEngine(w);
  await drive(engine, w.scheduler, happyScript(M));
  return { w, engine };
}
type World = Awaited<ReturnType<typeof setup>>['w'];
const add = (w: World, paths: string[]) => recordConstraint(w, { mission: M, constraint: 'late', kind: 'object', text: 'Keep the public promise explicit', scope: { paths, taskTypes: [] } });
const notices = (w: World) => w.ledger.notices.filter((n) => n.category === 'plan-constraint-gap');
const open = (w: World) => w.memory.read((db) => listNotices(db, w.memory.data).filter((n) => n.category === 'plan-constraint-gap'));

test('WI-34: a late default-scope constraint holds stable production once, without changing judgments or queueing reviews', async () => {
  const { w, engine } = await setup();
  const before = (await w.ledger.records(['judgment'])).map((r) => r.record);
  await add(w, ['**']);
  await engine.reconcile(M);
  const n = notices(w);
  assert.equal(n.length, 1); assert.equal(n[0]!.wi, 'WI-34');
  assert.match(n[0]!.trigger, /pmplan.m1.1.*constraint.late.*calibrator-1/);
  assert.match(n[0]!.defaultAction, /stable production waits/);
  assert.deepEqual(w.scheduler.queued(), []);
  assert.deepEqual((await w.ledger.records(['judgment'])).map((r) => r.record), before);
  assert.equal((await w.evaluator.labels(['pmplan.m1.1'])).labels['pmplan.m1.1'], 'not-fully-proven');
  const head = w.ledger.head; await engine.reconcile(M);
  assert.equal(w.ledger.head, head); assert.equal(notices(w).length, 1);
});

test('WI-34 exit 1: new user words and the same PM plan recover proof and close the notice', async () => {
  const { w, engine } = await setup(); await add(w, ['plans/pm-plan.json']);
  w.ledger.failNotifyNext = (n) => n.category === 'plan-constraint-gap';
  await engine.reconcile(M); assert.equal(notices(w).length, 0);
  await engine.reconcile(M); assert.equal(open(w).length, 1, 'interrupted notification is retried');
  const words = say(w, 'Please check this same plan against the new constraint.');
  const r = await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: [words], changedItems: [] });
  assert.ok(r.recheck);
  await engine.reconcile(M); assert.equal(open(w).length, 1, 'review in progress does not prematurely close an existing gap');
  await drive(engine, w.scheduler, happyScript(M));
  assert.equal((await w.evaluator.labels(['pmplan.m1.1', 'dplan.m1.1.1'])).labels['dplan.m1.1.1'], 'proven');
  assert.equal(open(w).length, 0); assert.equal(notices(w).length, 1);
});

test('WI-34 exit 2: a changed PM plan obtains a new detailed plan and closes its gap', async () => {
  const { w, engine } = await setup(); await add(w, ['plans/detailed-plan.json']);
  await engine.reconcile(M);
  assert.equal(open(w).length, 1);
  assert.match(open(w)[0]!.trigger, /dplan.m1.1.1.*calibrator-2.*feasibility/);
  const words = say(w, 'Revise the plan to meet the new explicit promise.');
  const plan = pmPlan(M); plan.elements[0]!.text += '; make the public promise explicit';
  await submitPmBatch(w, { mission: M, plan, userWords: [words], changedItems: [] });
  await drive(engine, w.scheduler, happyScript(M));
  assert.equal((await w.evaluator.labels(['dplan.m1.2.1'])).labels['dplan.m1.2.1'], 'proven');
  assert.equal(open(w).length, 0);
});

for (const state of ['queued', 'running'] as const) test(`WI-34 does not notify while the same PM plan review is ${state}`, async () => {
  const { w, engine } = await setup();
  const words = say(w, 'Check this same plan again.');
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: [words], changedItems: [] });
  await engine.reconcile(M);
  const task = w.scheduler.queued('calibrator-1')[0]!;
  if (state === 'running') w.scheduler.dispatchOf(task.task);
  await add(w, ['plans/pm-plan.json']);
  await engine.reconcile(M);
  assert.equal(notices(w).length, 0);
  if (state === 'running') {
    await w.scheduler.run(task.task, { handBack: cal1Pass(task.card as unknown as Calibrator1Card) });
    await engine.reconcile(M);
    assert.equal(notices(w).length, 1, 'an in-flight constraint gap becomes visible after hand-back');
  } else {
    await drive(engine, w.scheduler, happyScript(M));
    assert.equal(notices(w).length, 0, 'the queued builder refresh binds the constraint');
  }
});

test('WI-34 fast mode retains the unproven label and informs the PM without automatic reviews', async () => {
  const { w, engine } = await setup('fast'); await add(w, ['plans/pm-plan.json']); await engine.reconcile(M);
  assert.equal(notices(w).length, 1); assert.match(notices(w)[0]!.defaultAction, /fast mode goes on/);
  assert.equal((await w.evaluator.labels(['pmplan.m1.1'])).labels['pmplan.m1.1'], 'not-fully-proven');
  assert.deepEqual(w.scheduler.queued(), []);
});

test('WI-34 Stabilizer INT r1: a gap that recurs after its notice closed is a new notice, idempotent and retried', async () => {
  const { w, engine } = await setup();
  const label = async () => (await w.evaluator.labels(['pmplan.m1.1'])).labels['pmplan.m1.1'];
  await add(w, ['plans/pm-plan.json']); await engine.reconcile(M);
  assert.equal(open(w).length, 1); assert.equal(await label(), 'not-fully-proven');
  for (let round = 2; round <= 3; round++) {
    await add(w, ['other/file']); await engine.reconcile(M);
    assert.equal(await label(), 'proven'); assert.equal(open(w).length, 0, `round ${round}: the gap is gone, so is its notice`);
    await add(w, ['plans/pm-plan.json']);
    w.ledger.failNotifyNext = (n) => n.category === 'plan-constraint-gap';
    await engine.reconcile(M);
    assert.equal(await label(), 'not-fully-proven'); assert.equal(open(w).length, 0, 'the failed notification is not shown as sent');
    await engine.reconcile(M);
    assert.equal(open(w).length, 1, `round ${round}: the recurrence is told on a later pass`);
    assert.equal(notices(w).length, round);
    const head = w.ledger.head; await engine.reconcile(M);
    assert.equal(w.ledger.head, head); assert.equal(notices(w).length, round, 'idempotent while the gap stays open');
  }
  assert.deepEqual(w.scheduler.queued(), []);
});

test('WI-34 Stabilizer INT r1: an uncovered set A, then A+B, then A again tells each set when it applies', async () => {
  const { w, engine } = await setup();
  await add(w, ['plans/pm-plan.json']); await engine.reconcile(M);
  assert.equal(open(w).length, 1); assert.doesNotMatch(open(w)[0]!.trigger, /constraint\.second/);
  await recordConstraint(w, { mission: M, constraint: 'second', kind: 'object', text: 'Name every error code', scope: { paths: ['plans/pm-plan.json'], taskTypes: [] } });
  await engine.reconcile(M);
  assert.equal(open(w).length, 1, 'A is closed when A+B replaces it'); assert.match(open(w)[0]!.trigger, /constraint\.late.*constraint\.second|constraint\.second.*constraint\.late/);
  await withdrawConstraint(w, { constraint: 'second', words: say(w, 'Drop the error-code constraint.') });
  await engine.reconcile(M);
  assert.equal(open(w).length, 1, 'A is told again'); assert.doesNotMatch(open(w)[0]!.trigger, /constraint\.second/);
  assert.match(open(w)[0]!.trigger, /constraint\.late/);
  assert.equal(notices(w).length, 3);
  const head = w.ledger.head; await engine.reconcile(M);
  assert.equal(w.ledger.head, head);
  assert.equal((await w.evaluator.labels(['pmplan.m1.1'])).labels['pmplan.m1.1'], 'not-fully-proven');
});
