// Project constraints on an exploration's cards (9.5): every card shows the constraints in force that
// apply to its seat, selected as a task card's (src/seat/cards/dynamic.ts constraintsForExploration)
// when the card is built and again when its dispatch is claimed (src/seat/cards/refresh.ts). The
// seats that know the exploration take its product's path and the task type "exploration", an
// instruction their own seat name too; a blind executor gets only an instruction whose task types
// name its seat (4.3). Instructions are context: no judgment binds them.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ConstraintScope } from '../src/common/records.ts';
import type { FlowTask } from '../src/flow/ports.ts';
import { recordConstraint } from '../src/flow/requirements.ts';
import { withdrawConstraint } from '../src/memory/domain/constraints.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { ExperimentCard } from '../src/seat/cards/experiment.ts';
import { renderAuthorCard, type AuthorCard, type InterpreterCard, type ReaderCard, type RegisteredAttemptT } from '../src/seat/cards/researcher.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import { M, RUN_PLACEHOLDER, attack, blind, cardOf, finding, hand, only, reviseAll, stabilizeAll, submit, world, type World } from './flow-exploration-fixtures.ts';

const add = (w: World, id: string, kind: 'object' | 'instruction', text: string, scope: Partial<ConstraintScope> = {}) =>
  recordConstraint(w.ports, { mission: M, constraint: id, kind, text, scope: { paths: ['**'], taskTypes: [], ...scope } });

const ids = (c: { readonly constraints: readonly { readonly id: string }[] }): string[] => c.constraints.map((x) => x.id);

/** The card as the seat receives it: the task claimed (or its dispatch already in flight). */
function claimed<C>(w: World, t: FlowTask): C {
  return dispatchView(w.ports.ctx, w.scheduler.dispatchOf(t.task)).card as unknown as C;
}

/** Hand back a claimed task (fixtures.ts hand() takes a queued one); an experiment's claims cite the run `mp` reran for it. */
async function handClaimed(w: World, t: FlowTask, result: unknown): Promise<void> {
  const run = t.card.seat === 'constructor-experiment' ? w.scheduler.rerun(w.scheduler.dispatchOf(t.task), 'step') : null;
  const fields = run === null ? result : JSON.parse(JSON.stringify(result).split(RUN_PLACEHOLDER).join(`run:${run}`));
  assert.deepEqual(await w.scheduler.run(t.task, { handBack: fields }), []);
}

const ATTEMPTS: RegisteredAttemptT[] = [
  { id: 'A1', kind: 'experiment', purpose: 'does the count hold', steps: ['run count.sh'], data: '', measure: ['count'], assertions: [] },
  { id: 'A2', kind: 'reading', purpose: 'what the source says', steps: ['read the source'], data: '', measure: ['stated count'], assertions: [] },
];

describe('exploration cards show the project constraints in force (9.5)', () => {
  test("a mission-scoped instruction reaches the author, the attacker and the Stabilizer; another mission's does not; no judgment binds it", async () => {
    const w = await world();
    w.autoStabilize = false;
    await add(w, 'recount', 'instruction', 'When you read result X, also report recount Y', { mission: M });
    await add(w, 'elsewhere', 'instruction', 'Only for the other mission', { mission: 'M2' });
    await w.advance();
    const at = only(w, 'researcher-author');
    const author = at.card as unknown as AuthorCard;
    assert.deepEqual(ids(author), ['constraint.recount']);
    assert.deepEqual(claimed<AuthorCard>(w, at), author, 'the claim selects the same constraints');
    const text = renderAuthorCard(author);
    assert.ok(text.includes('## Project constraints\n- [constraint.recount] Instruction (context only; not a proof input): When you read result X, also report recount Y'));
    assert.ok(!text.includes('Only for the other mission'));
    await handClaimed(w, at, submit('design v1'));
    await w.advance();
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.deepEqual(ids(c), ['constraint.recount']);
    assert.deepEqual(w.ledger.content.getList(c.binding!.constraints as never), [], 'an instruction is no proof input');
    await hand(w, 'crititor', attack());
    await w.advance();
    const st = cardOf<StabilizerCard>(w, 'stabilizer');
    assert.deepEqual(ids(st), ['constraint.recount']);
    assert.deepEqual(w.ledger.content.getList(st.binding.constraints as never), []);
    await hand(w, 'stabilizer', stabilizeAll(st));
    await w.advance();
    assert.equal((await w.evaluator.labels([c.target!])).labels[c.target!], 'proven');
  });

  test('task types name exploration seats; the interpreter gets what the author gets; a blind executor only an instruction naming its seat', async () => {
    const w = await world({ product: 'answer', research: true, question: 'How many records are there?', decision: { type: 'structure', text: 'which count to use' }, readingNetwork: ['https://example.org/'] });
    await add(w, 'recount', 'instruction', 'When you read the count, also report the recount', { mission: M });
    await add(w, 'readers', 'instruction', 'Record the page number of every value', { taskTypes: ['researcher-reader'] });
    await add(w, 'authors', 'instruction', 'Register a recount attempt', { taskTypes: ['researcher-author'] });
    await add(w, 'seats', 'instruction', 'Name the count you rely on', { taskTypes: ['exploration'] });
    await add(w, 'code', 'instruction', 'Keep the parser pure', { taskTypes: ['implementation'] });
    await add(w, 'parser', 'instruction', 'Log nothing from the parser', { paths: ['src/parser/**'] });
    await add(w, 'private', 'object', 'Keep private details out of the result');
    await w.advance();
    assert.deepEqual(ids(cardOf<AuthorCard>(w, 'researcher-author')), ['constraint.recount', 'constraint.authors', 'constraint.seats', 'constraint.private']);
    await hand(w, 'researcher-author', submit('method v1', [], { attempts: ATTEMPTS }));
    await w.advance();
    // the attacker: the object constraint it reviews against (bound), then the instructions for it
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.deepEqual(ids(c), ['constraint.private', 'constraint.recount', 'constraint.seats']);
    const bound = w.ledger.content.getList(c.binding!.constraints as never);
    assert.equal(bound.length, 1);
    assert.ok(bound[0]!.includes('constraint.private'), 'the judgment binds the object constraint only');
    await hand(w, 'crititor', attack());
    await w.advance();
    // the attempts run blind: the reading gets the instruction written for readers, the experiment nothing
    const xt = only(w, 'constructor-experiment');
    const rt = only(w, 'researcher-reader');
    const ex = xt.card as unknown as ExperimentCard;
    const rd = rt.card as unknown as ReaderCard;
    assert.deepEqual(ids(ex), []);
    assert.deepEqual(ids(rd), ['constraint.readers']);
    assert.deepEqual(ids(claimed<ExperimentCard>(w, xt)), []);
    assert.deepEqual(ids(claimed<ReaderCard>(w, rt)), ['constraint.readers']);
    for (const card of [ex, rd]) assert.ok(!JSON.stringify(card).includes('recount'), 'no reading of the results reaches a blind card');
    await handClaimed(w, xt, blind(ex));
    await handClaimed(w, rt, blind(rd));
    await w.advance();
    const it = only(w, 'researcher-interpreter');
    assert.deepEqual(ids(it.card as unknown as InterpreterCard), ['constraint.recount', 'constraint.seats', 'constraint.private']);
    assert.deepEqual(ids(claimed<InterpreterCard>(w, it)), ['constraint.recount', 'constraint.seats', 'constraint.private']);
  });

  test('a constraint recorded after the exploration started is on the next card and on a queued card at its claim; a withdrawn one leaves both', async () => {
    const w = await world();
    await w.advance();
    await hand(w, 'researcher-author', submit('design v1'));
    await w.advance();
    await add(w, 'late', 'instruction', 'Report the recount too', { mission: M });
    // built before it, the queued attacker's card gets it when it is claimed
    const ct = only(w, 'crititor');
    assert.deepEqual(ids(ct.card as unknown as CrititorCard), []);
    assert.deepEqual(ids(claimed<CrititorCard>(w, ct)), ['constraint.late']);
    // a card in flight stays as it was claimed
    await add(w, 'later', 'instruction', 'Recorded while the attacker works', { mission: M });
    assert.deepEqual(ids(claimed<CrititorCard>(w, ct)), ['constraint.late']);
    await handClaimed(w, ct, attack([finding('serious', 'logic', 'a hole')]));
    await w.advance();
    const at = only(w, 'researcher-author');
    const author = at.card as unknown as AuthorCard;
    assert.deepEqual(ids(author), ['constraint.late', 'constraint.later'], 'the next card is built with them');
    await withdrawConstraint(w.ports, { constraint: 'late', words: 'W-1' });
    assert.deepEqual(ids(cardOf<AuthorCard>(w, 'researcher-author')), ['constraint.late', 'constraint.later'], 'the queued card is the one built');
    assert.deepEqual(ids(claimed<AuthorCard>(w, at)), ['constraint.later'], 'the claim drops the withdrawn one');
    await handClaimed(w, at, submit('design v2', reviseAll(author)));
    await w.advance();
    await hand(w, 'stabilizer', stabilizeAll(cardOf<StabilizerCard>(w, 'stabilizer')));
    await w.advance();
    assert.deepEqual(ids(cardOf<CrititorCard>(w, 'crititor')), ['constraint.later']);
  });
});
