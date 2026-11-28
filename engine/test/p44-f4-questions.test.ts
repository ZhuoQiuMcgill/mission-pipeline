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
import { architect, constructorDone, detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { answerByPm, answerEscalation, deferProblems, escalation, raiseEscalation, secretaryOptions } from '../src/flow/secretary.ts';
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
    // review r2 (p8-7): every question of a stop to ask is needed before the work resumes, whatever its mark
    assert.deepEqual(esc.reasons, ['Q1 (before-review): Is a header row required?', 'Q2 (before-review): May the output be cached later?']);
    assert.deepEqual(esc.options, ['answer', 'replan', 'ask-user'], 'the options of a Constructor\'s questions');
    assert.match(secretaryOptions(esc, true).find((o) => o.id === 'answer')!.outcome, /the paused attempt resumes on its parked edits/);
    assert.deepEqual(ports.scheduler.queued().map((t) => t.task), [`sec.${id}`], 'the task waits: only the decision is queued');
    assert.deepEqual(openItemsOf(await events(ports)), [], 'none of its questions is an open item');
    assert.match(deferProblems(esc, 'answer', [2]) ?? '', /stopped to ask: each of its questions is needed before the work resumes/, 'nor can an answer put one off');
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
    assert.deepEqual(next.questions?.map((q) => [q.id, q.state, q.answer ?? null]), [[`${id}#1`, 'answered', 'A header row is required.'], [`${id}#2`, 'answered', 'A header row is required.']]);
    assert.ok(next.materials?.some((m) => m.id === 'paused-handback' && !m.mustRead), 'the hand-back that stopped to ask is an optional material');
    assert.ok(renderSeatCard(next as never, { dispatch: 'D-x' }).includes(`created at commit ${hb.candidate.commit} (this attempt's edits so far`));
    const product = after.find((e) => e.event === 'product');
    assert.equal(product?.key, '1');
    assert.equal((product!.body as { task: string }).task, 'con.m1.impl.1.p1');
    assert.ok(after.some((e) => e.event === 'accepted' && e.key === '1'), 'accepted at attempt 1');
    assert.deepEqual(review!.questions?.map((q) => [q.id, q.state]), [[`${id}#1`, 'answered'], [`${id}#2`, 'answered']], 'the Reviewer sees the questions and the answers');
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

  it('questions that are all "later" raise no decision and hold no review: open items from the hand-back, on every card of the task, their answers on the next ones (p8-3, p8-7, p8-8)', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds({ constructor: (t: FlowTask) => (t.task === 'con.m1.impl.1' ? null : { handBack: constructorDone() }) }));
    await ports.scheduler.run('con.m1.impl.1', { handBack: constructorDone({ decisions_needed: [{ question: 'Is a BOM kept?', when: 'later' }] }) });
    const item = 'cdec.con.m1.impl.1.q1';
    assert.deepEqual(listOpenItems(ports.ctx, M).map((i) => [i.id, i.why, i.decider]), [[item, 'later', 'secretary']], 'an open item from the hand-back\'s write, before any pass');
    let reviewed = false;
    await drive(engine, ports.scheduler, withKinds({
      secretary: () => null,
      constructor: () => null,
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (!c.target.includes('impl')) return { handBack: reviewer(c, 'pass') };
        if (reviewed) return null;
        reviewed = true;
        return { handBack: reviewer(c, 'needs-decision') };
      },
    }));
    assert.ok(!(await events(ports, { line: 'secretary', event: 'escalation' })).some((e) => e.key.startsWith('cdec.')), 'no decision is raised: nothing waits on a later question');
    assert.ok(reviewed, 'the review ran while the later question was open');
    assert.deepEqual(claimedCard<ReviewerCard>(ports, 'rev.m1.impl.1').questions?.map((q) => [q.id, q.state]), [[item, 'open']]);
    // a Secretary card of the task (the Reviewer's needs-decision) lists it
    const sec = 'sec.rnd.rev.m1.impl.1';
    const digest = (c: SecretaryCard): string => ports.ledger.content.get(c.materials.find((m) => m.id === 'current-facts')!.ref as never);
    assert.ok(digest(ports.scheduler.card<SecretaryCard>(sec)).includes(`Its open items (questions left open, and their answers):\n- [${item}] attempt 1, later: Is a BOM kept?: open`));
    // the Secretary answers it (no escalation: the item is the Secretary's)
    const a = answerOpenItem(ports.ctx, { op: 't1', ref: item, by: 'secretary', answer: 'The BOM is dropped.' });
    assert.equal(a.repeated, false);
    assert.equal(answerOpenItem(ports.ctx, { op: 't2', ref: `${M}/${item}`, by: 'secretary', answer: 'The BOM is dropped.' }).repeated, true, 'the same answer again is a no-op');
    assert.throws(() => answerOpenItem(ports.ctx, { op: 't3', ref: item, by: 'pm', answer: 'Keep it.' }), /answered already/);
    assert.deepEqual(listOpenItems(ports.ctx, M).map((i) => [i.id, i.answer?.answer ?? null, i.decider]), [[item, 'The BOM is dropped.', 'secretary']]);
    // the next Secretary card of the task carries the answer and who gave it (p8-8)
    pmDispatch(ports.ctx, sec, { filledBy: 'test/scripted' });
    assert.ok(digest(claimedCard<SecretaryCard>(ports, sec)).includes(`- [${item}] attempt 1, later: Is a BOM kept?: answered by the Secretary: The BOM is dropped.`));
    await ports.scheduler.run(sec, { handBack: secretary(claimedCard<SecretaryCard>(ports, sec), 'rework', { instructions: 'Quote fields with commas.' }) });
    await drive(engine, ports.scheduler, withKinds({ constructor: () => null, secretary: () => null }));
    // and the next Constructor card (refreshed at its claim)
    const d = pmDispatch(ports.ctx, 'con.m1.impl.2', { filledBy: 'test/scripted' });
    assert.ok(d.card.includes(`[${item}] attempt 1, later: Is a BOM kept?\n  Answered by the Secretary: The BOM is dropped.`), d.card);
  });

  it('an answer may put a question off: it becomes an open item with the decision that defers it (p8-3), the review goes on, and the PM may answer it later', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds({
      constructor: (t: FlowTask) => ({ handBack: constructorDone(t.task === 'con.m1.impl.1' ? { decisions_needed: ['Which quote character?', 'Which licence header?'] } : {}) }),
      secretary: () => null,
    }));
    const id = 'cdec.con.m1.impl.1';
    // the Secretary's decision hand-back records the item in its own write, before any pass
    await ports.scheduler.run(`sec.${id}`, { handBack: { ...secretary(ports.scheduler.card<SecretaryCard>(`sec.${id}`), 'answer', { instructions: 'Use double quotes.' }), defer: [2] } });
    assert.deepEqual(listOpenItems(ports.ctx, M).map((i) => [i.id, i.why, i.answer]), [[`${id}.q2`, 'deferred', null]]);
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null }));
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
    // a retried round appends its reason after the numbered questions
    const card = { materials: [], options: [{ id: 'answer' }, { id: 'replan' }], authorizations: [], grantAvailable: true, request: { id: 'cdec.con.m1.impl.1', source: 'constructor-decision', reasons: ['Q1 (before-review): a', 'Q2 (later): b', 'The Secretary decision was not carried out: decide again.'] } } as unknown as SecretaryCard;
    const base = { classification: 'detail', authorization: null, reason: 'r', instructions: 'do', grantExtra: 0, notice: '', mayMatter: false } as const;
    assert.deepEqual(secretaryProblems(card, { ...base, option: 'answer', defer: [2] }, new Set()), []);
    assert.ok(secretaryProblems(card, { ...base, option: 'answer', defer: [3] }, new Set()).some((p) => p.startsWith('defer: name questions')));
    assert.ok(secretaryProblems(card, { ...base, option: 'replan', defer: [1] }, new Set()).some((p) => p.startsWith('defer: only')));
    // review r2 (p8-7): a pause's questions are all needed before the work resumes
    const pause = { ...card, request: { ...card.request, id: 'cblk.con.m1.impl.1.1' } } as SecretaryCard;
    assert.ok(secretaryProblems(pause, { ...base, option: 'answer', defer: [1] }, new Set()).some((p) => p.startsWith('defer: a Constructor that stopped to ask')));
  });
});

/** The impl task's Constructor hands back with `questions`; the Secretary step of its escalation is left queued. */
async function asks(questions: ConstructorResult['decisions_needed'], o: { blocked?: boolean } = {}): Promise<{ ports: World; engine: FlowEngine }> {
  const w = await setup();
  await drive(w.engine, w.ports.scheduler, withKinds({
    constructor: (t: FlowTask) => ({ handBack: t.task === 'con.m1.impl.1' ? (o.blocked === true ? blocked(questions) : constructorDone({ decisions_needed: questions })) : constructorDone() }),
    secretary: () => null,
  }));
  return w;
}

describe('4.4 F4, review round 1', () => {
  it('p8-1: a re-plan carries the question out with no answer: the old review stays held, in the ready list and in the claim, until the re-plan retires it', async () => {
    const { ports, engine } = await asks(['Should empty lines be skipped?']);
    const id = 'cdec.con.m1.impl.1';
    const firstPlan = detailedPlan(M);
    // the Secretary re-plans; the Architect's new decomposition is left queued (the window)
    await drive(engine, ports.scheduler, withKinds({
      secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'replan', { instructions: 'stream the input' }) }),
      'architect-decompose': () => null,
    }));
    assert.equal(((await events(ports, { line: 'secretary', event: 'applied' })).find((e) => e.key === id)?.body as { what: { option: string } }).what.option, 'replan');
    assert.ok(ports.scheduler.heldQueued().some((h) => h.task === 'rev.m1.impl.1'), 'the old review is still queued, and held');
    const held = readSteps(ports.ctx).held.find((h) => h.step === 'rev.m1.impl.1');
    assert.match(held?.why ?? '', /escalation cdec\.con\.m1\.impl\.1 was carried out without an answer \(replan\): the review waits until that work retires it/);
    assert.throws(() => pmDispatch(ports.ctx, 'rev.m1.impl.1', { filledBy: 'test/scripted' }), (e: Error & { code?: string }) => e.code === 'NOT_READY' && e.message.includes(id));
    // the new plan changes the card: the old review is cancelled, the next attempt starts
    await drive(engine, ports.scheduler, withKinds({
      'architect-decompose': () => ({ handBack: architect({ ...firstPlan, tasks: firstPlan.tasks.map((t) => (t.id === 'impl' ? { ...t, goal: 'Implement the parser, streaming' } : t)) }) }),
      constructor: () => null,
    }));
    assert.notEqual(ports.scheduler.tasks.get('rev.m1.impl.1')?.state, 'queued', 'retired by the re-plan');
    assert.ok(ports.scheduler.queued('constructor').some((t) => t.task === 'con.m1.impl.2'));
    assert.equal(ports.ctx.memory.read((db) => db.stmt("SELECT COUNT(*) AS n FROM dispatches WHERE task = 'rev.m1.impl.1'").get() as { n: number }).n, 0, 'the old review was never claimed');
  });

  it('p8-2: a user\'s answer with no instructions shows the user\'s cited words, on the resumed Constructor\'s card and on the Reviewer\'s', async () => {
    const { ports, engine } = await asks(['Which separator?'], { blocked: true });
    const id = 'cdec.con.m1.impl.1';
    void id;
    await answerEscalation(ports, { mission: M, escalation: 'cblk.con.m1.impl.1.1', option: 'answer', words: `${SEED_TEXT} (W-1)` });
    await drive(engine, ports.scheduler, withKinds({ constructor: (t: FlowTask) => (t.task === 'con.m1.impl.1.p1' ? null : { handBack: constructorDone() }) }));
    const expected = `"${SEED_TEXT}" (the user's words W-1)`;
    const d = pmDispatch(ports.ctx, 'con.m1.impl.1.p1', { filledBy: 'test/scripted' });
    assert.ok(d.card.includes(`[cblk.con.m1.impl.1.1#1] attempt 1, before-review: Which separator?\n  Answered by the user: ${expected}`), d.card);
    await ports.scheduler.run('con.m1.impl.1.p1', { handBack: constructorDone() });
    await drive(engine, ports.scheduler, happyScript(M));
    assert.deepEqual(claimedCard<ReviewerCard>(ports, 'rev.m1.impl.1').questions?.map((q) => [q.state, q.by, q.answer]), [['answered', 'user', expected]]);
  });

  it('p8-3: a user\'s answer that puts a question off records the open item in its own write', async () => {
    const { ports } = await asks(['Which quote character?', 'Which licence header?']);
    await answerEscalation(ports, { mission: M, escalation: 'cdec.con.m1.impl.1', option: 'answer', instructions: 'Double quotes.', defer: [2], words: `${SEED_TEXT} (W-1)` });
    assert.deepEqual(listOpenItems(ports.ctx, M).map((i) => [i.id, i.why, i.answer, i.decider]), [['cdec.con.m1.impl.1.q2', 'deferred', null, 'pm']], 'listed before any pass, the PM\'s (the user answered)');
  });

  it('p8-4: once the Secretary\'s accepted hand-back sends the escalation to the PM, its open items are the PM\'s, before any pass records the decision', async () => {
    const { ports } = await asks(['Which quote character?', { question: 'Which licence header?', when: 'later' }]);
    const id = 'cdec.con.m1.impl.1';
    await ports.scheduler.run(`sec.${id}`, { handBack: secretary(ports.scheduler.card<SecretaryCard>(`sec.${id}`), 'ask-user') });
    assert.equal((await events(ports, { line: 'secretary', event: 'decision' })).length, 0, 'no pass has recorded the decision');
    assert.throws(() => answerOpenItem(ports.ctx, { op: 's1', ref: `${id}.q2`, by: 'secretary', answer: 'MIT.' }), /is the PM's/);
    assert.equal(answerOpenItem(ports.ctx, { op: 'p1', ref: `${id}.q2`, by: 'pm', answer: 'MIT.' }).item.answer?.by, 'pm');
  });

  it('p8-5: upgrade: a product accepted at a later attempt (a 4.3 ruling adopting it) holds none of its reviews on the question 4.3 left open', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds({
      constructor: (t: FlowTask) => (t.task === 'con.m1.impl.2' ? null : { handBack: constructorDone() }),
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        return { handBack: reviewer(c, c.target.includes('impl') ? 'rework' : 'pass', { failing: 'S1' }) };
      },
    }));
    // attempt 1's product, not accepted at attempt 1; a ruling of 4.3 adopted it at attempt 2
    assert.equal((await events(ports, { line: 'task:impl', event: 'accepted' })).length, 0);
    const product = (await events(ports, { line: 'task:impl', event: 'product' }))[0]!.body as { object: string };
    await ports.ledger.append('test:adopted-at-2', { events: [{ mission: M, line: 'task:impl', event: 'accepted', key: '2', body: { k: 2, product: product.object, judgment: 'j.sec.x' } }] });
    await raiseEscalation(flowCtx(ports, M), { id: 'cdec.con.m1.impl.1', source: 'constructor-decision', lineage: 'task.m1.impl', subject: 'task:impl', summary: 'questions', reasons: ['left open?'], options: ['answer', 'replan', 'ask-user'], facts: { task: 'impl', attempt: 1, questions: ['left open?'], product: product.object } });
    const spec = { mission: M, lineage: 'task.m1.impl', card: { seat: 'reviewer', target: product.object } } as never;
    assert.equal(ports.ctx.memory.read((db) => heldForQuestions(db, ports.ctx.memory.data, spec)), null);
  });

  it('p8-6: a pause written while another pass started the next attempt is not recorded; the next attempt goes on', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds({ constructor: (t: FlowTask) => (t.task === 'con.m1.impl.1' ? null : { handBack: constructorDone() }) }));
    await ports.scheduler.run('con.m1.impl.1', { handBack: blocked(['Which separator?']) });
    const next = { mission: M, line: 'task:impl', event: 'rework', key: '2', body: { k: 2, reason: 'respec', issues: [], instructions: ['a repair changed the card'] } };
    const append = ports.ledger.append.bind(ports.ledger);
    let raced = false;
    ports.ledger.append = async (op, entries) => {
      // another pass starts attempt 2 just before this pass writes the pause
      if (!raced && op.startsWith(`flow:escalation:${M}:cblk.`)) {
        raced = true;
        await append('test:other-pass', { events: [next] });
      }
      return append(op, entries);
    };
    const reports = await engine.reconcile(M);
    ports.ledger.append = append;
    assert.ok(raced);
    assert.ok(reports[0]!.errors.some((e) => /moved past attempt 1/.test(e.message)), JSON.stringify(reports));
    assert.equal((await events(ports, { line: 'task:impl', event: 'paused' })).length, 0, 'the pause is not recorded');
    assert.ok(!(await events(ports, { line: 'secretary', event: 'escalation' })).some((e) => e.key.startsWith('cblk.')));
    await drive(engine, ports.scheduler, withKinds({ constructor: () => null }));
    assert.ok(ports.scheduler.queued('constructor').some((t) => t.task === 'con.m1.impl.2'), 'attempt 2 goes on');
  });

  it('p8-6: a pause of an attempt the task moved past is closed, and blocks the next attempt no more', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds({ constructor: (t: FlowTask) => (t.task === 'con.m1.impl.1' ? null : { handBack: constructorDone() }) }));
    await ports.ledger.append('test:next-attempt', { events: [{ mission: M, line: 'task:impl', event: 'rework', key: '2', body: { k: 2, reason: 'respec', issues: [], instructions: ['a repair changed the card'] } }] });
    // a pause of attempt 1 recorded anyway (as a pass without the attempt check wrote it)
    const id = 'cblk.con.m1.impl.1.1';
    await raiseEscalation(flowCtx(ports, M), { id, source: 'constructor-decision', lineage: 'task.m1.impl', subject: 'task:impl', summary: 'paused', reasons: ['Q1 (before-review): Which separator?'], options: ['answer', 'replan', 'ask-user'], facts: { task: 'impl', attempt: 1, pause: 1, blocked: true, parked: 'c'.repeat(40), questions: ['Which separator?'] } });
    await drive(engine, ports.scheduler, withKinds({ constructor: () => null, secretary: () => null }));
    const applied = (await events(ports, { line: 'secretary', event: 'applied' })).find((e) => e.key === id)?.body as { what?: { option?: string; why?: string } } | undefined;
    assert.equal(applied?.what?.option, 'superseded');
    assert.match(applied?.what?.why ?? '', /moved past attempt 1/);
    assert.ok(ports.scheduler.queued('constructor').some((t) => t.task === 'con.m1.impl.2'), 'attempt 2 goes on');
  });
});

/** Another pass starts attempt 2 of impl just before this pass makes the write whose op starts with `prefix`; returns a function that removes the hook and says whether it ran. */
function raceNextAttempt(w: World, prefix: string): () => boolean {
  const append = w.ledger.append.bind(w.ledger);
  let raced = false;
  w.ledger.append = async (op, entries) => {
    if (!raced && op.startsWith(prefix)) {
      raced = true;
      await append('test:other-pass', { events: [{ mission: M, line: 'task:impl', event: 'rework', key: '2', body: { k: 2, reason: 'respec', issues: [], instructions: ['a repair changed the card'] } }] });
    }
    return append(op, entries);
  };
  return () => {
    w.ledger.append = append;
    return raced;
  };
}

describe('4.4 F4, review round 2', () => {
  it('p8-r2-1: the answer carried out on the escalation takes precedence over an earlier answer to its open item; in the other order the item\'s answer is refused', async () => {
    const id = 'cdec.con.m1.impl.1';
    // order 1: the PM puts Q2 off and answers its item; the user then answers the escalation, not putting Q2 off
    {
      const { ports, engine } = await asks(['Which quote character?', 'Is a BOM kept?']);
      await answerByPm(ports, { mission: M, escalation: id, option: 'answer', words: [], noWords: true, reason: 'r', instructions: 'Double quotes.', defer: [2] });
      answerOpenItem(ports.ctx, { op: 'a1', ref: `${id}.q2`, by: 'pm', answer: 'Keep the BOM.' });
      await answerEscalation(ports, { mission: M, escalation: id, option: 'answer', instructions: 'Drop the BOM.', words: `${SEED_TEXT} (W-1)` });
      await drive(engine, ports.scheduler, withKinds({ secretary: () => null }));
      const q2 = claimedCard<ReviewerCard>(ports, 'rev.m1.impl.1').questions?.find((q) => q.id === `${id}.q2`);
      assert.deepEqual([q2?.state, q2?.by, q2?.answer], ['answered', 'user', 'Drop the BOM.'], 'the user\'s words win');
      const item = listOpenItems(ports.ctx, M).find((i) => i.id === `${id}.q2`)!;
      assert.deepEqual([item.answer?.by, item.superseded?.answer], ['user', 'Keep the BOM.']);
    }
    // order 2: the user's answer is carried out first; the PM's answer to the item afterwards is refused
    {
      const { ports, engine } = await asks(['Which quote character?', 'Is a BOM kept?']);
      await answerByPm(ports, { mission: M, escalation: id, option: 'answer', words: [], noWords: true, reason: 'r', instructions: 'Double quotes.', defer: [2] });
      await answerEscalation(ports, { mission: M, escalation: id, option: 'answer', instructions: 'Drop the BOM.', words: `${SEED_TEXT} (W-1)` });
      await drive(engine, ports.scheduler, withKinds({ secretary: () => null }));
      assert.throws(() => answerOpenItem(ports.ctx, { op: 'a2', ref: `${id}.q2`, by: 'pm', answer: 'Keep the BOM.' }), /answered already by the user: Drop the BOM\./);
      const q2 = claimedCard<ReviewerCard>(ports, 'rev.m1.impl.1').questions?.find((q) => q.id === `${id}.q2`);
      assert.deepEqual([q2?.by, q2?.answer], ['user', 'Drop the BOM.']);
    }
  });

  it('p8-r2-3: the notice of a third pause comes only from a recorded pause', async () => {
    const { ports, engine } = await setup();
    const stops = new Set(['con.m1.impl.1', 'con.m1.impl.1.p1']);
    await drive(engine, ports.scheduler, withKinds({
      constructor: (t: FlowTask) => (t.task === 'con.m1.impl.1.p2' ? null : { handBack: stops.has(t.task) ? blocked([`Which separator, at ${t.task}?`]) : constructorDone() }),
      secretary: answers((c) => c.request.id.startsWith('cblk.'), 'Use a comma.'),
    }));
    await ports.scheduler.run('con.m1.impl.1.p2', { handBack: blocked(['A third question?']) });
    const done = raceNextAttempt(ports, `flow:escalation:${M}:cblk.`);
    await engine.reconcile(M);
    assert.ok(done(), 'the race ran');
    assert.ok(!(await events(ports, { line: 'secretary', event: 'escalation' })).some((e) => e.key === 'cblk.con.m1.impl.1.3'), 'the third pause is not recorded');
    assert.deepEqual(ports.ledger.notices.filter((n) => n.category === 'constructor-paused-again'), [], 'and no notice names it');
  });

  it('p8-6: a pause\'s re-plan is written only while its attempt is current; the next attempt is not blocked by it', async () => {
    const { ports, engine } = await asks(['Which separator?'], { blocked: true });
    const id = 'cblk.con.m1.impl.1.1';
    await ports.scheduler.run(`sec.${id}`, { handBack: secretary(ports.scheduler.card<SecretaryCard>(`sec.${id}`), 'replan', { instructions: 'split the task' }) });
    const done = raceNextAttempt(ports, `flow:replan-request:${M}:${id}`);
    await engine.reconcile(M);
    assert.ok(done(), 'the race ran');
    assert.equal((await events(ports, { line: 'task:impl', event: 'waiting-replan' })).length, 0, 'no waiting-replan for the old attempt');
    await drive(engine, ports.scheduler, withKinds({ constructor: () => null, secretary: () => null, 'architect-decompose': () => null }));
    assert.equal(((await events(ports, { line: 'secretary', event: 'applied' })).find((e) => e.key === id)?.body as { what?: { option?: string } }).what?.option, 'superseded');
    assert.ok(ports.scheduler.queued('constructor').some((t) => t.task === 'con.m1.impl.2'), 'attempt 2 goes on');
  });

  it('p8-2: a user\'s words-only answer stays on the cards after a rework (the earlier decisions), and reaches a re-review', async () => {
    const words = `"${SEED_TEXT}" (the user's words W-1)`;
    {
      const { ports, engine } = await asks(['Which separator?']);
      await answerEscalation(ports, { mission: M, escalation: 'cdec.con.m1.impl.1', option: 'answer', words: `${SEED_TEXT} (W-1)` });
      let reviewed = false;
      await drive(engine, ports.scheduler, withKinds({
        constructor: (t: FlowTask) => (t.task === 'con.m1.impl.2' ? null : { handBack: constructorDone() }),
        reviewer: (t) => {
          const c = t.card as unknown as ReviewerCard;
          if (!c.target.includes('impl')) return { handBack: reviewer(c, 'pass') };
          if (reviewed) return null;
          reviewed = true;
          return { handBack: reviewer(c, 'rework', { failing: 'S1' }) };
        },
      }));
      const d = pmDispatch(ports.ctx, 'con.m1.impl.2', { filledBy: 'test/scripted' });
      assert.ok(claimedCard<ConstructorCard>(ports, 'con.m1.impl.2').decisionQuotes.includes(words), d.card);
    }
    {
      const { ports, engine } = await setup();
      let first = true;
      await drive(engine, ports.scheduler, withKinds({
        secretary: () => null,
        reviewer: (t) => {
          const c = t.card as unknown as ReviewerCard;
          if (c.target.includes('impl') && first) { first = false; return { handBack: reviewer(c, 'needs-decision') }; }
          return { handBack: reviewer(c, 'pass') };
        },
      }));
      await answerEscalation(ports, { mission: M, escalation: 'rnd.rev.m1.impl.1', option: 'answer', words: `${SEED_TEXT} (W-1)` });
      await drive(engine, ports.scheduler, happyScript(M));
      assert.ok(claimedCard<ReviewerCard>(ports, 'rev.m1.impl.1.r1').decisionQuotes.includes(words));
    }
  });

  it('p8-8: an answer cut in the Secretary\'s digest says so, and the task-line material holds it in full', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds({
      constructor: (t: FlowTask) => ({ handBack: constructorDone(t.task === 'con.m1.impl.1' ? { decisions_needed: [{ question: 'Is a BOM kept?', when: 'later' }] } : {}) }),
      secretary: () => null,
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        return { handBack: reviewer(c, c.target.includes('impl') ? 'needs-decision' : 'pass') };
      },
    }));
    const long = `The BOM is dropped. ${'Reasons follow, one by one, at length. '.repeat(12)}The last qualification: keep it for UTF-16 input.`;
    answerOpenItem(ports.ctx, { op: 'l1', ref: 'cdec.con.m1.impl.1.q1', by: 'secretary', answer: long });
    pmDispatch(ports.ctx, 'sec.rnd.rev.m1.impl.1', { filledBy: 'test/scripted' });
    const card = claimedCard<SecretaryCard>(ports, 'sec.rnd.rev.m1.impl.1');
    const text = (id: string): string => ports.ledger.content.get(card.materials.find((m) => m.id === id)!.ref as never);
    assert.match(text('current-facts'), /answered by the Secretary: The BOM is dropped\. .*… \(cut; in full: material task-line\)/);
    const line = JSON.parse(text('task-line')) as { openItems?: Array<{ id: string; answer: { answer: string } }> };
    assert.equal(line.openItems?.find((i) => i.id === 'cdec.con.m1.impl.1.q1')?.answer.answer, long);
  });
});
