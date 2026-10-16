import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordConstraint } from '../src/flow/requirements.ts';
import { pmDispatch } from '../src/process/pm.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import { attack, cardOf, hand, M, only, stabilizeAll, submit, world } from './flow-exploration-fixtures.ts';

test('exploration: object constraints before the first turn bind both required positions and permit proof', async () => {
  const w = await world(); w.autoStabilize = false;
  await recordConstraint(w.ports, { mission: M, constraint: 'all', kind: 'object', text: 'Keep private details out of the result', scope: { paths: ['**'], taskTypes: [] } });
  await w.advance();
  const author = only(w, 'researcher-author');
  const claimed = dispatchView(w.ports.ctx, pmDispatch(w.ports.ctx, author.task).dispatch).card;
  assert.deepEqual(claimed, author.card, 'the author is unchanged at dispatch');
  assert.deepEqual(claimed['constraints'], []);
  assert.deepEqual(await w.scheduler.run(author.task, { handBack: submit('design v1') }), []); await w.advance();
  for (let round = 0; round < 2; round++) {
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.ok(c.constraints.some((x) => x.id === 'constraint.all'));
    assert.ok(w.ledger.content.getList(c.binding!.constraints as never).some((x) => x.includes('constraint.all')));
    await hand(w, 'crititor', attack()); await w.advance();
    const st = cardOf<StabilizerCard>(w, 'stabilizer');
    assert.ok(st.constraints.some((x) => x.id === 'constraint.all'));
    assert.ok(w.ledger.content.getList(st.binding.constraints as never).some((x) => x.includes('constraint.all')));
    await hand(w, 'stabilizer', stabilizeAll(st)); await w.advance();
  }
  const judgments = await w.ledger.records(['judgment']);
  assert.ok(judgments.length >= 2);
  const judged = judgments[0]!.record.target;
  assert.equal((await w.evaluator.labels([judged])).labels[judged], 'proven');
  assert.equal(w.scheduler.queued().length, 0, 'convergence is a deliberate terminal state');
});

for (const kind of ['crititor', 'stabilizer'] as const) test(`exploration: a constraint arriving while ${kind} is queued rebuilds its dispatched checks in place`, async () => {
  const w = await world(); w.autoStabilize = false;
  await w.advance(); await hand(w, 'researcher-author', submit('design v1')); await w.advance();
  if (kind === 'stabilizer') { await hand(w, 'crititor', attack()); await w.advance(); }
  const original = only(w, kind);
  await recordConstraint(w.ports, { mission: M, constraint: 'late', kind: 'object', text: 'Keep output bounded', scope: { paths: ['**'], taskTypes: [] } });
  const d = pmDispatch(w.ports.ctx, original.task);
  const c = dispatchView(w.ports.ctx, d.dispatch).card as unknown as CrititorCard | StabilizerCard;
  assert.ok(w.memory.data.getList(c.binding!.constraints as never).some((x) => x.includes('constraint.late')));
  assert.ok(c.constraints.some((x) => x.id === 'constraint.late'));
  const expected = structuredClone(original.card) as Record<string, unknown>;
  expected['constraints'] = c.constraints;
  (expected['binding'] as { constraints: unknown }).constraints = c.binding!.constraints;
  assert.deepEqual(c, expected, 'only shown and bound object constraints change');
  assert.deepEqual(await w.scheduler.run(original.task, { handBack: kind === 'crititor' ? attack() : stabilizeAll(c as StabilizerCard) }), []); await w.advance();
  for (let i = 0; i < 4 && w.scheduler.queued().length > 0; i++) {
    const q = w.scheduler.queued()[0]!;
    await hand(w, q.card.seat, q.card.seat === 'crititor' ? attack() : stabilizeAll(q.card as unknown as StabilizerCard)); await w.advance();
  }
  assert.equal((await w.evaluator.labels([c.target!])).labels[c.target!], 'proven');
  const j = (await w.ledger.judgment(c.binding!.judgment))!;
  assert.deepEqual(w.ledger.content.getList(j.constraints), w.memory.data.getList(c.binding!.constraints as never));
});

for (const arrival of ['crititor-running', 'stabilizer-running', 'after-judgment'] as const) test(`exploration exits: a constraint arriving ${arrival}`, async () => {
  const { flowCtx } = await import('../src/flow/context.ts');
  const { explorationStep } = await import('../src/flow/exploration/step.ts');
  const w = await world(); w.autoStabilize = false;
  await w.advance(); await hand(w, 'researcher-author', submit('design v1')); await w.advance();
  await hand(w, 'crititor', attack()); await w.advance();
  const first = cardOf<StabilizerCard>(w, 'stabilizer');
  await hand(w, 'stabilizer', stabilizeAll(first)); await w.advance();
  let target: string;
  const add = () => recordConstraint(w.ports, { mission: M, constraint: 'arrival', kind: 'object', text: 'Bound the result', scope: { paths: ['**'], taskTypes: [] } });
  if (arrival === 'crititor-running') {
    const task = only(w, 'crititor'); target = (task.card as unknown as CrititorCard).target!;
    w.scheduler.dispatchOf(task.task); await add();
    assert.deepEqual(await w.scheduler.run(task.task, { handBack: attack() }), []); await w.advance();
    const st = cardOf<StabilizerCard>(w, 'stabilizer');
    assert.ok(w.ledger.content.getList(st.binding.constraints as never).some((x) => x.includes('constraint.arrival')));
    await hand(w, 'stabilizer', stabilizeAll(st)); await w.advance();
  } else {
    await hand(w, 'crititor', attack()); await w.advance();
    const task = only(w, 'stabilizer'); const st = task.card as unknown as StabilizerCard; target = st.target;
    if (arrival === 'stabilizer-running') { w.scheduler.dispatchOf(task.task); await add(); }
    assert.deepEqual(await w.scheduler.run(task.task, { handBack: stabilizeAll(st) }), []); await w.advance();
    if (arrival === 'after-judgment') await add();
  }
  await explorationStep(flowCtx(w.ports, M));
  const label = (await w.evaluator.labels([target])).labels[target];
  if (arrival === 'crititor-running') assert.equal(label, 'proven', 'the queued Stabilizer selected the new check; existing coverage uses the deciding union');
  else {
    assert.equal(label, 'not-fully-proven');
    assert.ok(w.ledger.notices.some((n) => n.category === 'exploration-conclusion-unproven'), 'the terminal gap uses the existing exploration exit notice');
    assert.equal(w.scheduler.queued().length, 0, 'no new exploration re-review exit is invented');
  }
});
