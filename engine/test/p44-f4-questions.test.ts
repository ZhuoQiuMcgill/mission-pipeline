// 4.4 (F4, problems P4 and P3): a Constructor can stop and ask; a review waits for the answer. A blocked
// hand-back records nothing as a product, verifies nothing and queues no review; its escalation, keyed by
// the attempt and the number of the pause, blocks the task, and its answer resumes the attempt with a new
// Constructor step on the parked commit, counted on no loop. A hand-back with a product and questions
// goes on to verification, and its review is held, in the ready list and in the claim, while a
// before-review question is not answered and carried out. A question put off, or raised as later, is an
// open item of kind question (PM design G5), listed on the task's cards until its decider answers it.
// The flows run on a real memory with scripted seats (test/flow-memory-fixtures.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { flowCtx } from '../src/flow/context.ts';
import { openItemsOf, taskQuestions } from '../src/flow/openItems.ts';
import type { FlowEvent, FlowTask } from '../src/flow/ports.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { constructorDone, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { escalation, raiseEscalation, secretaryOptions } from '../src/flow/secretary.ts';
import { heldForQuestions } from '../src/process/questions.ts';
import { pmDispatch, readSteps } from '../src/process/pm.ts';
import { REDISPATCH_LOOP } from '../src/process/index.ts';
import { answerOpenItem, listOpenItems } from '../src/process/openItems.ts';
import { renderSeatCard, type ConstructorCard, type ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { resultProblems, type ConstructorResult } from '../src/seat/results.ts';
import { secretaryProblems } from '../src/seat/cards/secretary.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;

async function setup(): Promise<{ ports: World; engine: FlowEngine }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  return { ports, engine: new FlowEngine(ports) };
}

function withKinds(over: Record<string, Script>): Script {
  const base = happyScript(M);
  return (t, s) => (Object.hasOwn(over, t.card.seat) ? (over[t.card.seat] as Script) : base)(t, s);
}

const events = async (w: World, q: { line?: string; event?: string } = {}): Promise<FlowEvent[]> => [...(await w.ledger.events({ mission: M, ...q }))] as FlowEvent[];
/** The card a step's (last) claim gave its seat: refreshed at the claim (seat/cards/refresh.ts). */
function claimedCard<C>(w: World, step: string): C {
  return w.ctx.memory.read((db) => {
    const d = (db.stmt('SELECT dispatch FROM dispatches WHERE task = ? ORDER BY claimed_rev DESC LIMIT 1').get(step) as { dispatch: string }).dispatch;
    const body = (db.stmt("SELECT body FROM flow_events WHERE event = 'claimed' AND line = ?").get(`dispatch:${d}`) as { body: string }).body;
    return (JSON.parse(w.ctx.memory.data.text((JSON.parse(w.ctx.memory.data.text(body)) as { spec: string }).spec)) as { card: C }).card;
  });
}
const blocked = (questions: ConstructorResult['decisions_needed'], done = 'read the card; stopped before choosing'): ConstructorResult => ({ ...constructorDone({ done, decisions_needed: questions }), blocked: true });
/** The Secretary answers the escalations of `ids` (a predicate) with `instructions`, and leaves every other one queued. */
const answers = (pick: (c: SecretaryCard) => boolean, instructions: string, o: { defer?: number[] } = {}): Script => (t) => {
  const c = t.card as unknown as SecretaryCard;
  return pick(c) ? { handBack: { ...secretary(c, 'answer', { instructions }), ...(o.defer !== undefined ? { defer: o.defer } : {}) } } : null;
};

describe('4.4 F4: a Constructor stops and asks (a blocked hand-back)', () => {
  it('records no product, verifies nothing and queues no review; its escalation blocks the task; the answer resumes the same attempt on the parked commit, counted on no loop', async () => {
    const { ports, engine } = await setup();
    const asks = blocked([{ question: 'Is a header row required?', when: 'before-review' }, { question: 'May the output be cached later?', when: 'later' }]);
    const script = withKinds({
      constructor: (t: FlowTask) => ({ handBack: t.task === 'con.m1.impl.1' ? asks : constructorDone({ done: 'finished on the parked edits' }) }),
      secretary: () => null,
    });
    await drive(engine, ports.scheduler, script);

    const id = 'cblk.con.m1.impl.1.1';
    const line = await events(ports, { line: 'task:impl' });
    assert.ok(line.every((e) => e.event !== 'product' && e.event !== 'verified'), 'nothing is recorded as a product or verified');
    assert.ok(![...ports.scheduler.tasks.keys()].some((t) => t.startsWith('rev.m1.impl.')), 'no review is queued');
    const paused = line.find((e) => e.event === 'paused');
    assert.equal(paused?.key, '1#1');
    const hb = ports.scheduler.answers.get('con.m1.impl.1');
    assert.ok(hb?.kind === 'recorded' && hb.candidate !== null && hb.parked === true, 'the hand-back is recorded with its parked commit');
    assert.equal((paused!.body as { parked: string }).parked, hb.candidate.commit);
    const esc = await escalation(flowCtx(ports, M), id);
    assert.ok(esc !== null, 'the pause has its own escalation, keyed by the attempt and the number of the pause');
    assert.equal(esc.source, 'constructor-decision');
    assert.deepEqual(esc.reasons, ['Q1 (before-review): Is a header row required?', 'Q2 (later): May the output be cached later?']);
    assert.deepEqual(esc.options, ['answer', 'replan', 'ask-user'], 'the options of a Constructor\'s questions');
    assert.match(secretaryOptions(esc, true).find((o) => o.id === 'answer')!.outcome, /the paused attempt resumes on its parked edits; a question it puts off \(defer, by number\) stays an open item/);
    assert.deepEqual(ports.scheduler.queued().map((t) => t.task), [`sec.${id}`], 'the task waits: only the decision is queued');
    // a "later" question is an open item from the hand-back
    assert.deepEqual(openItemsOf(await events(ports)).map((i) => [i.id, i.why, i.answer]), [[`${id}.q2`, 'later', null]]);
    // no loop counts it
    assert.equal((await ports.ledger.loop('task.m1.impl', 'rework')).attempts, 0);
    assert.equal((await ports.ledger.loop('task.m1.impl', REDISPATCH_LOOP)).attempts, 0);

    let review: ReviewerCard | null = null;
    await drive(engine, ports.scheduler, withKinds({
      constructor: (t: FlowTask) => ({ handBack: constructorDone({ done: `finished ${t.task}` }) }),
      secretary: answers((c) => c.request.id === id, 'A header row is required.'),
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (c.target.includes('impl')) review = c;
        return { handBack: reviewer(c, 'pass') };
      },
    }));
    const after = await events(ports, { line: 'task:impl' });
    assert.deepEqual(after.filter((e) => e.event === 'resumed').map((e) => [e.key, (e.body as { step: string }).step]), [['1#1', 'con.m1.impl.1.p1']]);
    assert.ok(after.every((e) => e.event !== 'rework'), 'the attempt goes on: no rework');
    const first = ports.scheduler.card<ConstructorCard>('con.m1.impl.1');
    const next = ports.scheduler.card<ConstructorCard>('con.m1.impl.1.p1');
    assert.equal(next.workspace.start, hb.candidate.commit, 'the continuation opens its worktree on the parked commit');
    assert.equal(next.workspace.snapshot, first.workspace.snapshot, 'its candidate is taken against the attempt\'s start');
    assert.ok(next.duties.includes('stopped to ask (pause 1)'), next.duties);
    assert.deepEqual(next.questions?.map((q) => [q.id, q.state, q.answer ?? null]), [[`${id}#1`, 'answered', 'A header row is required.'], [`${id}.q2`, 'open', null]]);
    assert.ok(next.materials?.some((m) => m.id === 'paused-handback' && !m.mustRead), 'the hand-back that stopped to ask is an optional material');
    assert.ok(renderSeatCard(next as never, { dispatch: 'D-x' }).includes(`created at commit ${hb.candidate.commit} (this attempt's edits so far`));
    const product = after.find((e) => e.event === 'product');
    assert.equal(product?.key, '1');
    assert.equal((product!.body as { task: string }).task, 'con.m1.impl.1.p1');
    assert.ok(after.some((e) => e.event === 'accepted' && e.key === '1'), 'accepted at attempt 1');
    assert.deepEqual(review!.questions?.map((q) => [q.id, q.state]), [[`${id}#1`, 'answered'], [`${id}.q2`, 'open']], 'the Reviewer sees the questions and the answers');
    assert.ok(!review!.decisionQuotes.includes('A header row is required.'), 'each answer is printed once');
    assert.equal((await ports.ledger.loop('task.m1.impl', 'rework')).attempts, 0);
    assert.equal((await ports.ledger.loop('task.m1.impl', REDISPATCH_LOOP)).attempts, 0);
  });

  it('each pause has its own escalation and continuation; a third pause is accepted and the Secretary is told', async () => {
    const { ports, engine } = await setup();
    const stops = new Set(['con.m1.impl.1', 'con.m1.impl.1.p1', 'con.m1.impl.1.p2']);
    await drive(engine, ports.scheduler, withKinds({
      constructor: (t: FlowTask) => ({ handBack: stops.has(t.task) ? blocked([`Which separator, at ${t.task}?`]) : constructorDone() }),
      secretary: answers((c) => c.request.id.startsWith('cblk.'), 'Use a comma.'),
    }));
    const escs = (await events(ports, { line: 'secretary', event: 'escalation' })).map((e) => e.key).filter((k) => k.startsWith('cblk.'));
    assert.deepEqual(escs, ['cblk.con.m1.impl.1.1', 'cblk.con.m1.impl.1.2', 'cblk.con.m1.impl.1.3']);
    assert.deepEqual([...ports.scheduler.tasks.keys()].filter((t) => t.startsWith('con.m1.impl.')), ['con.m1.impl.1', 'con.m1.impl.1.p1', 'con.m1.impl.1.p2', 'con.m1.impl.1.p3']);
    const told = ports.ledger.notices.filter((n) => n.category === 'constructor-paused-again');
    assert.deepEqual(told.map((n) => [n.key, n.wi]), [['impl:1:3', 'WI-08']], 'the third pause is accepted, and the Secretary is told once, with an action');
    const line = await events(ports, { line: 'task:impl' });
    assert.ok(line.some((e) => e.event === 'accepted' && e.key === '1'));
    assert.ok(line.every((e) => e.event !== 'rework'));
    const last = ports.scheduler.card<ConstructorCard>('con.m1.impl.1.p3');
    assert.equal(last.questions?.length, 3, 'the answers of every pause of the attempt');
  });

  it('the hand-back rules: a stop to ask names its questions; a question says when it must be settled; a plain string is before-review', () => {
    const card = { seat: 'constructor', standards: [{ id: 'S1', text: 's' }] } as unknown as ConstructorCard;
    assert.deepEqual(resultProblems(card, { ...constructorDone(), blocked: true }, { snapshot: { lines: () => null } }), ['blocked: name the questions you stopped for in decisions_needed']);
    assert.deepEqual(resultProblems(card, constructorDone({ decisions_needed: ['plain', { question: 'q', when: 'later' }] }), { snapshot: { lines: () => null } }), []);
    assert.ok(resultProblems(card, constructorDone({ decisions_needed: [{ question: 'q', when: 'someday' } as never] }), { snapshot: { lines: () => null } }).length > 0);
  });
});

describe('4.4 F4: a review waits for the answer to its Constructor\'s questions', () => {
  it('held in the ready list and refused in the claim until the answer is carried out; then the Reviewer sees the questions and the answers (target: 0 reviews claimed before the answer)', async () => {
    const { ports, engine } = await setup();
    // a hand-back in the 4.3 shape: a plain string, read as before-review
    await drive(engine, ports.scheduler, withKinds({
      constructor: (t: FlowTask) => ({ handBack: constructorDone(t.task === 'con.m1.impl.1' ? { decisions_needed: ['Should empty lines be skipped?'] } : {}) }),
      secretary: () => null,
    }));
    const id = 'cdec.con.m1.impl.1';
    assert.ok((await events(ports, { line: 'task:impl', event: 'verified' })).length === 1, 'the product is verified meanwhile');
    const queued = ports.scheduler.card<ReviewerCard>('rev.m1.impl.1');
    assert.deepEqual(queued.questions?.map((q) => [q.state, q.text]), [['waiting', 'Should empty lines be skipped?']]);
    const held = readSteps(ports.ctx).held.find((h) => h.step === 'rev.m1.impl.1');
    assert.ok(held !== undefined && held.why.includes(id), `held with the escalation named: ${JSON.stringify(held)}`);
    assert.ok(!readSteps(ports.ctx).ready.some((r) => r.step === 'rev.m1.impl.1'));
    assert.throws(() => pmDispatch(ports.ctx, 'rev.m1.impl.1', { filledBy: 'test/scripted' }), (e: Error & { code?: string }) => e.code === 'NOT_READY' && e.message.includes(id));

    // the Secretary answers; the review is ready once the answer is carried out
    await drive(engine, ports.scheduler, withKinds({ secretary: answers((c) => c.request.id === id, 'Skip empty lines.') }));
    const all = await events(ports);
    const applied = all.find((e) => e.line === 'secretary' && e.event === 'applied' && e.key === id)!;
    const claim = ports.ctx.memory.read((db) => db.stmt("SELECT claimed_rev FROM dispatches WHERE task = 'rev.m1.impl.1'").all() as Array<{ claimed_rev: number }>);
    assert.equal(claim.length, 1, 'one claim of the review');
    assert.ok(Number(claim[0]!.claimed_rev) > applied.revision, 'claimed after the answer was carried out');
    // the claim's card: the answer that came after the step was queued
    const claimed = claimedCard<ReviewerCard>(ports, 'rev.m1.impl.1');
    assert.deepEqual(claimed.questions?.map((q) => [q.state, q.answer]), [['answered', 'Skip empty lines.']]);
    assert.ok(!claimed.decisionQuotes.includes('Skip empty lines.'), 'the answer is printed once, with its question');
    assert.ok(renderSeatCard(claimed as never, { dispatch: 'D-x' }).includes('## Questions on this task and their answers\n- [cdec.con.m1.impl.1#1] attempt 1, before-review: Should empty lines be skipped?\n  Answered by the Secretary: Skip empty lines.'));
    assert.ok(all.some((e) => e.line === 'task:impl' && e.event === 'accepted'));
  });

  it('a question raised as later does not hold the review: it is an open item, listed on the cards until its decider answers it, and the answer reaches the next card', async () => {
    const { ports, engine } = await setup();
    let reviews = 0;
    await drive(engine, ports.scheduler, withKinds({
      secretary: () => null,
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (!c.target.includes('impl')) return { handBack: reviewer(c, 'pass') };
        if (reviews > 0) return null;
        reviews++;
        return { handBack: reviewer(c, 'rework', { failing: 'S1' }) };
      },
      constructor: (t: FlowTask) => (t.task === 'con.m1.impl.2' ? null : { handBack: constructorDone(t.task === 'con.m1.impl.1' ? { decisions_needed: [{ question: 'Is a BOM kept?', when: 'later' }] } : {}) }),
    }));
    const item = 'cdec.con.m1.impl.1.q1';
    assert.equal(reviews, 1, 'the review ran while the later question was open');
    assert.deepEqual(claimedCard<ReviewerCard>(ports, 'rev.m1.impl.1').questions?.map((q) => [q.id, q.state]), [[item, 'open']]);
    assert.deepEqual(ports.scheduler.card<ConstructorCard>('con.m1.impl.2').questions?.map((q) => [q.id, q.state]), [[item, 'open']], 'listed on the next attempt\'s card');
    // the Secretary answers it (the escalation is undecided: the item is the Secretary's)
    const a = answerOpenItem(ports.ctx, { op: 't1', ref: item, by: 'secretary', answer: 'The BOM is dropped.' });
    assert.equal(a.repeated, false);
    assert.equal(answerOpenItem(ports.ctx, { op: 't2', ref: `${M}/${item}`, by: 'secretary', answer: 'The BOM is dropped.' }).repeated, true, 'the same answer again is a no-op');
    assert.throws(() => answerOpenItem(ports.ctx, { op: 't3', ref: item, by: 'pm', answer: 'Keep it.' }), /answered already/);
    assert.deepEqual(listOpenItems(ports.ctx, M).map((i) => [i.id, i.answer?.answer ?? null, i.decider]), [[item, 'The BOM is dropped.', 'secretary']]);
    // the next card claimed carries the answer (refreshed at its claim)
    const d = pmDispatch(ports.ctx, 'con.m1.impl.2', { filledBy: 'test/scripted' });
    assert.ok(d.card.includes(`[${item}] attempt 1, later: Is a BOM kept?\n  Answered by the Secretary: The BOM is dropped.`), d.card);
  });

  it('an answer may put a question off: it becomes an open item at once, the review goes on, and the PM may answer it later', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds({
      constructor: (t: FlowTask) => ({ handBack: constructorDone(t.task === 'con.m1.impl.1' ? { decisions_needed: ['Which quote character?', 'Which licence header?'] } : {}) }),
      secretary: answers((c) => c.request.source === 'constructor-decision', 'Use double quotes.', { defer: [2] }),
    }));
    const id = 'cdec.con.m1.impl.1';
    assert.deepEqual(openItemsOf(await events(ports)).map((i) => [i.id, i.why, i.question]), [[`${id}.q2`, 'deferred', 2]]);
    const rev = claimedCard<ReviewerCard>(ports, 'rev.m1.impl.1');
    assert.deepEqual(rev.questions?.map((q) => [q.id, q.state, q.answer ?? null]), [[`${id}#1`, 'answered', 'Use double quotes.'], [`${id}.q2`, 'open', null]]);
    assert.ok((await events(ports, { line: 'task:impl', event: 'accepted' })).length === 1, 'the deferral released the review');
    const r = answerOpenItem(ports.ctx, { op: 'pm1', ref: `${id}.q2`, by: 'pm', answer: 'MIT header.', words: 'W-1' });
    assert.equal(r.item.answer?.words, 'W-1');
    const after = taskQuestions(await events(ports), 'impl', 2);
    assert.deepEqual(after.map((q) => [q.item, q.state, q.answer, q.by]), [[`${id}.q2`, 'answered', 'MIT header.', 'pm']], 'a later attempt\'s card lists the answered item');
  });

  it('upgrade: a question 4.3 left open on an attempt accepted already holds none of its later reviews', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, happyScript(M));
    const product = (await events(ports, { line: 'task:impl', event: 'accepted' }))[0]!.body as { product: string };
    // the 4.3 shape: plain questions, no timing, never answered (4.3 let the review go on)
    await raiseEscalation(flowCtx(ports, M), { id: 'cdec.con.m1.impl.1', source: 'constructor-decision', lineage: 'task.m1.impl', subject: 'task:impl', summary: 'questions', reasons: ['left open?'], options: ['answer', 'replan', 'ask-user'], facts: { task: 'impl', attempt: 1, questions: ['left open?'], product: product.product } });
    const spec = { mission: M, lineage: 'task.m1.impl', card: { seat: 'reviewer', target: product.product } } as never;
    assert.equal(ports.ctx.memory.read((db) => heldForQuestions(db, ports.ctx.memory.data, spec)), null, 'a re-review of the accepted attempt is not held');
    assert.deepEqual(taskQuestions(await events(ports), 'impl', 1).map((q) => [q.state, q.text]), [['waiting', 'left open?']], 'its cards still list the question');
  });

  it('the Secretary\'s deferral is checked: only with an answer to a Constructor\'s questions, by their numbers', () => {
    const card = { materials: [], options: [{ id: 'answer' }, { id: 'replan' }], authorizations: [], grantAvailable: true, request: { source: 'constructor-decision', reasons: ['Q1 (before-review): a', 'Q2 (later): b'] } } as unknown as SecretaryCard;
    const base = { classification: 'detail', authorization: null, reason: 'r', instructions: 'do', grantExtra: 0, notice: '', mayMatter: false } as const;
    assert.deepEqual(secretaryProblems(card, { ...base, option: 'answer', defer: [2] }, new Set()), []);
    assert.ok(secretaryProblems(card, { ...base, option: 'answer', defer: [3] }, new Set()).some((p) => p.startsWith('defer: name questions')));
    assert.ok(secretaryProblems(card, { ...base, option: 'replan', defer: [1] }, new Set()).some((p) => p.startsWith('defer: only')));
  });
});
