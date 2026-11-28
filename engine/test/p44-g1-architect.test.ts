// 4.4 (G1, PM design §4): a design question is answered by an Architect, in one step. A decider chooses
// `ask-architect` on a Constructor's questions, a Reviewer's "needs a decision" or a used-up rework loop; one
// Architect step (card "architect-answer") gets the task, the question and the decider's instructions; the task
// waits as for any decision; the step changes nothing and hands back one of three replies. An answer is
// carried out as the escalation's answer; "the plan has to change" and "I need to know this first" send the
// escalation back to the Secretary. The flows run on a real memory with scripted seats.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { flowCtx } from '../src/flow/context.ts';
import type { FlowEvent, FlowTask } from '../src/flow/ports.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { constructorDone, detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { answerByPm, answerEscalation, closeEscalations, decisionFor, escalateToUser, escalation, pmOptions, raiseEscalation, secretaryOptions } from '../src/flow/secretary.ts';
import { askTask } from '../src/flow/architectAsk.ts';
import { ARCHITECT_ANSWER, askStanding, type ArchitectAnswerBody } from '../src/flow/architectAnswers.ts';
import { pmDispatch, readSteps } from '../src/process/pm.ts';
import { resolveSubtasks } from '../src/cli/layers.ts';
import { architectNotesFor, earlierDecisionsOf, taskDecisionQuotes } from '../src/seat/cards/dynamic.ts';
import type { EscalationBody } from '../src/flow/secretary.ts';
import { currentItems, recordItem } from '../src/flow/requirements.ts';
import { REDISPATCH_LOOP } from '../src/process/index.ts';
import { pmInbox } from '../src/process/secretary.ts';
import { decisionOutcome } from '../src/process/decisions.ts';
import { listOpenItems } from '../src/process/openItems.ts';
import { renderSeatCard, type ConstructorCard, type ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import { handBackProblems } from '../src/seat/cards/index.ts';
import { secretaryProblems, type SecretaryCard } from '../src/seat/cards/secretary.ts';
import type { ArchitectAnswerCard, ArchitectAnswerResult } from '../src/seat/cards/architectAnswer.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;

async function setup(o: { reworkCap?: number } = {}): Promise<{ ports: World; engine: FlowEngine }> {
  const ports = memoryPorts(o.reworkCap !== undefined ? { reworkCap: o.reworkCap } : {});
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
const replies = async (w: World): Promise<Array<FlowEvent<ArchitectAnswerBody>>> => (await events(w, { line: 'secretary', event: ARCHITECT_ANSWER })) as Array<FlowEvent<ArchitectAnswerBody>>;
const applied = async (w: World, id: string): Promise<Record<string, unknown> | undefined> => (await events(w, { line: 'secretary', event: 'applied' })).find((e) => e.key === id)?.body as Record<string, unknown> | undefined;
function claimedCard<C>(w: World, step: string): C {
  return w.ctx.memory.read((db) => {
    const d = (db.stmt('SELECT dispatch FROM dispatches WHERE task = ? ORDER BY claimed_rev DESC LIMIT 1').get(step) as { dispatch: string }).dispatch;
    const body = (db.stmt("SELECT body FROM flow_events WHERE event = 'claimed' AND line = ?").get(`dispatch:${d}`) as { body: string }).body;
    return (JSON.parse(w.ctx.memory.data.text((JSON.parse(w.ctx.memory.data.text(body)) as { spec: string }).spec)) as { card: C }).card;
  });
}

const ASK = 'Ask: does S1 cover fields with embedded newlines?';
/** The Secretary asks the Architect on the escalation `id`; every other decision is left queued. */
const asksArchitect = (id: (c: SecretaryCard) => boolean, instructions = ASK): Script => (t) => {
  const c = t.card as unknown as SecretaryCard;
  return id(c) ? { handBack: secretary(c, 'ask-architect', { instructions }) } : null;
};
const reply = (r: ArchitectAnswerResult): Script => () => ({ handBack: r });

/** The impl task's first Constructor asks `questions`; every Secretary step is left queued. */
async function constructorAsks(questions: string[], o: { blocked?: boolean } = {}): Promise<{ ports: World; engine: FlowEngine }> {
  const w = await setup();
  await drive(w.engine, w.ports.scheduler, withKinds({
    constructor: (t: FlowTask) => ({ handBack: t.task === 'con.m1.impl.1' ? { ...constructorDone({ decisions_needed: questions }), ...(o.blocked === true ? { blocked: true } : {}) } : constructorDone({ done: `finished ${t.task}` }) }),
    secretary: () => null,
  }));
  return w;
}

describe('4.4 G1: ask the Architect on a Constructor\'s questions', () => {
  it('one Architect step gets the task, the question and the instructions; the review waits; its answer is carried out as the escalation\'s answer and reaches the next cards; it counts on no loop', async () => {
    const { ports, engine } = await constructorAsks(['Should a quoted field keep its newlines?']);
    const id = 'cdec.con.m1.impl.1';
    const esc = (await escalation(flowCtx(ports, M), id))!;
    assert.deepEqual(esc.options, ['answer', 'ask-architect', 'replan', 'ask-user'], 'offered on a Constructor\'s questions');
    await drive(engine, ports.scheduler, withKinds({ secretary: asksArchitect((c) => c.request.id === id), 'architect-answer': () => null }));
    const step = askTask(M, { escalation: id, by: 'secretary', round: 0 });
    const card = ports.scheduler.card<ArchitectAnswerCard>(step);
    assert.equal(card.seat, 'architect-answer');
    assert.equal(card.taskCard.id, 'impl');
    assert.equal(card.asked.instructions, ASK);
    assert.equal(card.asked.by, 'secretary');
    assert.deepEqual(card.escalation.reasons, ['Q1 (before-review): Should a quoted field keep its newlines?']);
    assert.ok((card.materials ?? []).some((m) => m.id === 'constructor-claims' && !m.mustRead), 'the task\'s hand-back is readable');
    assert.ok((card.materials ?? []).some((m) => m.id === 'plan' && !m.mustRead), 'the plan in effect is readable');
    assert.deepEqual(card.accepted, [], 'no accepted product yet');
    assert.ok(readSteps(ports.ctx).held.some((h) => h.step === 'rev.m1.impl.1' && h.why.includes(id)), 'the review waits as for any decision');
    assert.equal(await applied(ports, id), undefined);
    const text = renderSeatCard(card as never, { dispatch: 'D-x' });
    assert.ok(text.includes('## What to hand back') && text.includes('You change nothing: no card text, no standard, no write path, no structure.'), text);
    assert.ok(text.includes(`The Secretary asks you: ${ASK}`));

    let review = null as ReviewerCard | null;
    await drive(engine, ports.scheduler, withKinds({
      'architect-answer': reply({ reply: 'answer', text: 'Yes: a quoted field keeps its newlines (RFC 4180).' }),
      reviewer: (t) => { const c = t.card as unknown as ReviewerCard; if (c.target.includes('impl')) review = c; return { handBack: reviewer(c, 'pass') }; },
    }));
    const r = await replies(ports);
    assert.deepEqual(r.map((x) => [x.key, x.body.reply, x.body.moot ?? null]), [[`${id}:s0`, 'answer', null]], 'the reply is recorded on the escalation that asked');
    const a = await applied(ports, id);
    assert.equal((a?.['what'] as { option: string }).option, 'answer', 'carried out as its answer');
    assert.equal(a?.['by'], 'secretary', 'the asker stays the decider of record');
    assert.equal(a?.['architect'], `${id}:s0`);
    const claimed = claimedCard<ReviewerCard>(ports, 'rev.m1.impl.1');
    assert.deepEqual(claimed.questions?.map((q) => [q.state, q.by, q.answer]), [['answered', 'architect', 'Yes: a quoted field keeps its newlines (RFC 4180).']]);
    assert.ok(renderSeatCard(claimed as never, { dispatch: 'D-x' }).includes('Answered by the Architect: Yes: a quoted field keeps its newlines'));
    assert.ok(review !== null);
    assert.ok((await events(ports, { line: 'task:impl', event: 'accepted' })).length === 1);
    // the step counts on no loop and no re-dispatch allowance of the task
    assert.equal((await ports.ledger.loop('task.m1.impl', 'rework')).attempts, 0);
    assert.equal((await ports.ledger.loop('task.m1.impl', REDISPATCH_LOOP)).attempts, 0);
    assert.ok((await events(ports, { line: 'task:impl', event: 'rework' })).length === 0, 'no rework');
  });

  it('a paused attempt resumes on its parked edits once the Architect\'s answer is carried out', async () => {
    const { ports, engine } = await constructorAsks(['Which escape character?'], { blocked: true });
    const id = 'cblk.con.m1.impl.1.1';
    const esc = (await escalation(flowCtx(ports, M), id))!;
    assert.ok(esc.options.includes('ask-architect'));
    // the description says what carrying its answer out does here, as the answer's own does
    assert.match(pmOptions(esc).find((o) => o.id === 'ask-architect')!.outcome, /its answer is carried out as this escalation's answer \(the paused attempt resumes on its parked edits\)/);
    await drive(engine, ports.scheduler, withKinds({
      secretary: asksArchitect((c) => c.request.id === id),
      'architect-answer': reply({ reply: 'answer', text: 'A doubled quote escapes a quote.' }),
      constructor: (t: FlowTask) => (t.task === 'con.m1.impl.1.p1' ? null : { handBack: constructorDone() }),
    }));
    const resumed = await events(ports, { line: 'task:impl', event: 'resumed' });
    assert.deepEqual(resumed.map((e) => e.key), ['1#1']);
    const next = ports.scheduler.card<ConstructorCard>('con.m1.impl.1.p1');
    assert.deepEqual(next.questions?.map((q) => [q.state, q.by, q.answer]), [['answered', 'architect', 'A doubled quote escapes a quote.']]);
  });

  it('the step changes nothing: no card, no standard, no plan; "the plan has to change" comes back to the Secretary with what and why, who then re-plans', async () => {
    const { ports, engine } = await constructorAsks(['May a field span two records?']);
    const id = 'cdec.con.m1.impl.1';
    const before = { effective: (await events(ports, { line: 'plan', event: 'effective' })).length, specs: (await events(ports, { line: 'task:impl', event: 'spec' })).length };
    let round1 = null as SecretaryCard | null;
    await drive(engine, ports.scheduler, withKinds({
      secretary: (t) => {
        const c = t.card as unknown as SecretaryCard;
        if (c.request.id !== id) return null;
        if (!c.request.reasons.some((r) => r.startsWith('The Architect'))) return { handBack: secretary(c, 'ask-architect', { instructions: ASK }) };
        round1 = c;
        return { handBack: secretary(c, 'replan', { instructions: 'Re-plan impl as the Architect says.' }) };
      },
      'architect-answer': reply({ reply: 'plan-must-change', text: 'S1 must say whether a field may span records.', why: 'The plan does not say it, and either reading changes what the user gets.' }),
      'architect-decompose': () => null,
    }));
    const r = await replies(ports);
    assert.deepEqual(r.map((x) => [x.body.reply, x.body.moot ?? null]), [['plan-must-change', null]]);
    assert.equal((await events(ports, { line: 'plan', event: 'effective' })).length, before.effective, 'no plan took effect');
    assert.equal((await events(ports, { line: 'task:impl', event: 'spec' })).length, before.specs, 'no card changed');
    const retry = (await events(ports, { line: 'secretary', event: 'secretary-retry' })).find((e) => e.key === `${id}#1`)?.body as { why: string } | undefined;
    assert.match(retry?.why ?? '', /says the plan has to change\. What: S1 must say whether a field may span records\. Why: The plan does not say it/);
    assert.ok(round1 !== null, 'the Secretary decides again, on its next round');
    assert.ok(round1!.request.reasons.some((x) => x.includes('the plan has to change')), 'with the reply on its card');
    assert.ok(round1!.options.some((o) => o.id === 'replan'), 'it chooses among what it has today');
    assert.equal(((await applied(ports, id))?.['what'] as { option: string }).option, 'replan');
    assert.ok((await events(ports, { line: 'plan', event: 'replan-request' })).some((e) => e.key === id));
  });

  it('"I need to know this first" comes back with the Architect\'s question; asked again, the second step sees the first reply, and its answer is carried out', async () => {
    const { ports, engine } = await constructorAsks(['Which encoding?']);
    const id = 'cdec.con.m1.impl.1';
    let second = null as ArchitectAnswerCard | null;
    await drive(engine, ports.scheduler, withKinds({
      secretary: (t) => {
        const c = t.card as unknown as SecretaryCard;
        if (c.request.id !== id) return null;
        const back = c.request.reasons.some((r) => r.includes('needs to know this first'));
        return { handBack: secretary(c, 'ask-architect', { instructions: back ? 'The input is UTF-8 (the user said so).' : ASK }) };
      },
      'architect-answer': (t) => {
        const c = t.card as unknown as ArchitectAnswerCard;
        if (c.asked.round === 0) return { handBack: { reply: 'need-to-know', text: 'Is the input always UTF-8?' } };
        second = c;
        return { handBack: { reply: 'answer', text: 'Decode as UTF-8 and reject invalid bytes.' } };
      },
    }));
    const r = await replies(ports);
    assert.deepEqual(r.map((x) => [x.key, x.body.reply]), [[`${id}:s0`, 'need-to-know'], [`${id}:s1`, 'answer']]);
    assert.ok(second !== null);
    assert.deepEqual(second!.earlier.map((x) => [x.reply, x.text]), [['need-to-know', 'Is the input always UTF-8?']], 'the second step sees the first reply');
    assert.equal(second!.asked.instructions, 'The input is UTF-8 (the user said so).');
    assert.equal((await applied(ports, id))?.['architect'], `${id}:s1`, 'the second answer is carried out');
    assert.ok((await events(ports, { line: 'task:impl', event: 'accepted' })).length === 1);
  });

  it('an answer that names other tasks is printed on their cards too, under the card they had then; one overridden or moot is not', async () => {
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
    const engine = new FlowEngine(ports);
    const base = happyScript(M, () => detailedPlan(M, { extraTask: true }));
    const over: Record<string, Script> = {
      constructor: (t: FlowTask) => ({ handBack: t.task === 'con.m1.impl.1' ? constructorDone({ decisions_needed: ['Is the README in English?'] }) : constructorDone() }),
      secretary: asksArchitect((c) => c.request.id === 'cdec.con.m1.impl.1'),
      'architect-answer': reply({ reply: 'answer', text: 'English, and docs writes its README in English too.', tasks: ['docs', 'impl'] }),
      // the docs task's review is not needed here: its Constructor's card is
      reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return c.target.includes('docs') ? null : { handBack: reviewer(c, 'pass') }; },
    };
    await drive(engine, ports.scheduler, (t, s) => (Object.hasOwn(over, t.card.seat) ? over[t.card.seat]! : base)(t, s));
    const r = await replies(ports);
    assert.deepEqual(r[0]!.body.tasks, ['docs'], 'the asking task is not named again: it has the answer as its escalation\'s');
    const docs = claimedCard<ConstructorCard>(ports, 'con.m1.docs.1');
    assert.deepEqual(docs.architectNotes?.map((n) => [n.from, n.text]), [['escalation cdec.con.m1.impl.1 (task:impl), the Architect\'s answer', 'English, and docs writes its README in English too.']]);
    assert.ok(!(claimedCard<ReviewerCard>(ports, 'rev.m1.impl.1').architectNotes ?? []).length, 'not as a note on the asking task');
    // the same reads on other records: moot, overridden, or the named task under a newer card
    const evs = await events(ports);
    assert.equal(architectNotesFor(evs, 'docs', []).length, 1);
    const reply0 = evs.find((e) => e.event === ARCHITECT_ANSWER)!;
    assert.deepEqual(architectNotesFor(evs.map((e) => (e === reply0 ? { ...e, body: { ...(e.body as object), moot: 'the PM answered' } } : e)), 'docs', []), [], 'a moot answer is never printed');
    assert.deepEqual(architectNotesFor(evs.map((e) => (e.event === 'applied' && e.key === 'cdec.con.m1.impl.1' ? { ...e, body: { what: { option: 'answer' }, by: 'pm' } } : e)), 'docs', []), [], 'an answer another decider\'s overrode is not printed');
    assert.deepEqual(architectNotesFor([...evs, { revision: reply0.revision + 10_000, mission: M, line: 'task:docs', event: 'spec', key: 'later', body: {} }], 'docs', []), [], 'not under a newer card of the named task');
  });
});

describe('4.4 G1: ask the Architect on a Reviewer\'s "needs a decision" and on a used-up loop', () => {
  it('a Reviewer\'s "needs a decision": the answer is carried out as the answer, and the re-review gets it', async () => {
    const { ports, engine } = await setup();
    let first = true;
    await drive(engine, ports.scheduler, withKinds({
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (c.target.includes('impl') && first) { first = false; return { handBack: reviewer(c, 'needs-decision') }; }
        return { handBack: reviewer(c, 'pass') };
      },
      secretary: asksArchitect((c) => c.request.source === 'reviewer-needs-decision'),
      'architect-answer': reply({ reply: 'answer', text: 'S1 means quoting as RFC 4180 has it.' }),
    }));
    const id = 'rnd.rev.m1.impl.1';
    assert.ok((await escalation(flowCtx(ports, M), id))!.options.includes('ask-architect'));
    assert.equal((await applied(ports, id))?.['architect'], `${id}:s0`);
    const re = await events(ports, { line: 'task:impl', event: 'reanswer' });
    assert.deepEqual(re.map((e) => (e.body as { decision: string }).decision), ['S1 means quoting as RFC 4180 has it.']);
    assert.ok(ports.scheduler.card<ReviewerCard>('rev.m1.impl.1.r1').decisionQuotes.includes('S1 means quoting as RFC 4180 has it.'), 'the next review of the work quotes it');
  });

  it('a used-up rework loop asked twice: each answer comes back to the Secretary; the grant\'s attempt carries the latest answer on both roles\' cards, the corrected one nowhere (p11-3, p11-5)', async () => {
    const { ports, engine } = await setup();
    let reworks = 0;
    let granted = false;
    const backs: SecretaryCard[] = [];
    await drive(engine, ports.scheduler, withKinds({
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (c.target.includes('iface') || granted) return { handBack: reviewer(c, 'pass') };
        reworks++;
        return { handBack: reviewer(c, 'rework', { failing: reworks % 2 === 0 ? 'S2' : 'S1' }) };
      },
      secretary: (t) => {
        const c = t.card as unknown as SecretaryCard;
        if (c.request.source !== 'loop-exhausted') return null;
        const answers = c.request.reasons.filter((r) => r.startsWith('The Architect')).length + backs.length;
        if (backs.length === 0 && answers === 0) return { handBack: secretary(c, 'ask-architect', { instructions: ASK }) };
        backs.push(c);
        if (backs.length === 1) return { handBack: secretary(c, 'ask-architect', { instructions: 'The files come from Windows: ask again.' }) };
        granted = true;
        return { handBack: secretary(c, 'grant', { instructions: 'One more attempt.', grantExtra: 1 }) };
      },
      'architect-answer': (t) => ({ handBack: (t.card as unknown as ArchitectAnswerCard).asked.round === 0 ? { reply: 'answer', text: 'Use commas.', tasks: ['iface'] } : { reply: 'answer', text: 'Use tabs instead of commas.', tasks: ['iface'] } }),
    }));
    const esc = (await events(ports, { line: 'secretary', event: 'escalation' })).map((e) => e.body as { id: string; source: string; options: string[] }).find((e) => e.source === 'loop-exhausted')!;
    assert.ok(esc.options.includes('ask-architect'), 'offered on a used-up loop');
    const r = await replies(ports);
    assert.deepEqual(r.map((x) => [x.key, x.body.reply, x.body.text, x.body.moot ?? null]), [[`${esc.id}:s0`, 'answer', 'Use commas.', null], [`${esc.id}:s1`, 'answer', 'Use tabs instead of commas.', null]], 'both recorded on the escalation: its history');
    assert.equal(backs.length, 2, 'each answer came back to the Secretary');
    assert.ok(backs[0]!.request.reasons.some((x) => x.includes('answered: Use commas. A grant carries this answer to the next attempt')));
    assert.equal(((await applied(ports, esc.id))?.['what'] as { option: string }).option, 'grant', 'the decider\'s grant is what was carried out');
    const rw = (await events(ports, { line: 'task:impl', event: 'rework' })).at(-1)?.body as { instructions: string[] };
    assert.deepEqual(rw.instructions, ['One more attempt.'], 'the rework body is the grant\'s, as in 4.3');
    const con = [...ports.scheduler.tasks.keys()].filter((t) => t.startsWith('con.m1.impl.')).at(-1)!;
    const rev = [...ports.scheduler.tasks.keys()].filter((t) => t.startsWith('rev.m1.impl.')).at(-1)!;
    for (const [role, quotes] of [['Constructor (queued)', ports.scheduler.card<ConstructorCard>(con).decisionQuotes], ['Constructor (claimed)', claimedCard<ConstructorCard>(ports, con).decisionQuotes], ['Reviewer (claimed)', claimedCard<ReviewerCard>(ports, rev).decisionQuotes]] as const) {
      assert.ok(quotes.includes('Use tabs instead of commas.'), `${role} carries the latest answer: ${JSON.stringify(quotes)}`);
      assert.ok(!quotes.includes('Use commas.'), `${role} does not carry the corrected one`);
    }
    assert.deepEqual(architectNotesFor(await events(ports), 'iface', []).map((n) => n.text), ['Use tabs instead of commas.'], 'a named task gets the latest answer only');
    // the Architect's steps counted on no loop of the task: the grant's attempt only
    assert.equal((await ports.ledger.loop('task.m1.impl', REDISPATCH_LOOP)).attempts, 0);
  });

  it('two grants that cover one attempt each carry their escalation\'s Architect answer onto the task\'s cards (p11-3)', async () => {
    const { ports } = await setup();
    const ctx = flowCtx(ports, M);
    // two used-up loops of the task under its card, both carried out with a grant, each with an Architect answer
    for (const n of [1, 2]) {
      const id = `exh.shared.${n}`;
      await raiseEscalation(ctx, { id, source: 'loop-exhausted', lineage: 'task.m1.impl', subject: 'task:impl', summary: 'used up', reasons: ['r'], options: ['grant', 'ask-architect', 'replan', 'abandon', 'ask-user'], facts: { task: 'impl', attempt: 1, loop: 'rework', issues: [] } });
      await ports.ledger.append(`test:shared:${n}`, { events: [
        { mission: M, line: 'secretary', event: 'architect-answer', key: `${id}:s0`, body: { escalation: id, ask: { escalation: id, by: 'secretary', round: 0 }, step: `arch-ask.${n}`, dispatch: null, reply: 'answer', text: `Answer ${n}.` } },
        { mission: M, line: 'secretary', event: 'applied', key: id, body: { what: { option: 'grant' }, by: 'secretary' } },
      ] });
    }
    const evs = await events(ports);
    const task = detailedPlan(M).tasks.find((t) => t.id === 'impl')!;
    const quotes = taskDecisionQuotes(await currentItems(ctx), evs, task, [], undefined);
    assert.ok(quotes.includes('Answer 1.') && quotes.includes('Answer 2.'), JSON.stringify(quotes));
  });
});

describe('4.4 G1: the step as a step like any other', () => {
  it('mp read blocked names the Architect\'s step of an ask, and where it stands', async () => {
    const { ports, engine } = await setup();
    let first = true;
    await drive(engine, ports.scheduler, withKinds({
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (c.target.includes('impl') && first) { first = false; return { handBack: reviewer(c, 'needs-decision') }; }
        return { handBack: reviewer(c, 'pass') };
      },
      secretary: asksArchitect((c) => c.request.source === 'reviewer-needs-decision'),
      'architect-answer': () => null,
    }));
    const id = 'rnd.rev.m1.impl.1';
    const step = askTask(M, { escalation: id, by: 'secretary', round: 0 });
    const line = async () => (await resolveSubtasks(ports.ctx)).blocked.flatMap((e) => (e.blocked !== null ? [e.blocked] : [])).find((b) => b.because.includes(id))!;
    assert.equal((await line()).next, `the Architect answers it: step ${step} is ready: dispatch it (mp pm next)`);
    const d = ports.scheduler.dispatchOf(step);
    assert.equal((await line()).next, `the Architect answers it: step ${step} (${d} in flight): wait for its hand-back`);
  });

  it('what waits on the user lists the user\'s options: never ask-architect, which the PM asks with --by pm', async () => {
    const { ports, engine } = await setup();
    let first = true;
    await drive(engine, ports.scheduler, withKinds({
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (c.target.includes('impl') && first) { first = false; return { handBack: reviewer(c, 'needs-decision') }; }
        return { handBack: reviewer(c, 'pass') };
      },
      secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'ask-pm') }),
    }));
    const id = 'rnd.rev.m1.impl.1';
    assert.ok((await escalation(flowCtx(ports, M), id))!.options.includes('ask-architect'));
    const waiting = readSteps(ports.ctx).waitingOnUser.find((w) => w.escalation === id);
    assert.ok(waiting !== undefined && !waiting.options.includes('ask-architect') && waiting.options.includes('answer'), JSON.stringify(waiting));
    const blocked = (await resolveSubtasks(ports.ctx)).blocked.flatMap((e) => (e.blocked !== null ? [e.blocked] : [])).find((b) => b.because.includes(id))!;
    assert.ok(blocked.next.startsWith('ask the user; then mp pm answer') && !blocked.next.includes('ask-architect'), blocked.next);
    assert.ok(pmInbox(ports.ctx).find((i) => i.id === `${M}/${id}`)?.options?.includes('ask-architect'), 'the PM may still ask (--by pm)');
  });

  it('a step that ends without a usable reply sends the question back to the decider, with why; its re-dispatches are its own', async () => {
    const { ports, engine } = await constructorAsks(['Which?']);
    const id = 'cdec.con.m1.impl.1';
    let releases = 0;
    let back = null as SecretaryCard | null;
    await drive(engine, ports.scheduler, withKinds({
      secretary: (t) => {
        const c = t.card as unknown as SecretaryCard;
        if (c.request.id !== id) return null;
        if (c.request.reasons.some((r) => r.includes('ended without a usable reply'))) { back = c; return null; }
        return { handBack: secretary(c, 'ask-architect', { instructions: ASK }) };
      },
      'architect-answer': () => (releases++ < 3 ? { release: 'abandoned' } : null),
    }));
    const r = await replies(ports);
    assert.deepEqual(r.map((x) => [x.body.reply, x.body.dispatch, x.body.moot ?? null]), [['failed', null, null]]);
    assert.ok(back !== null, 'the Secretary decides again');
    assert.equal(await applied(ports, id), undefined);
    assert.equal((await ports.ledger.loop('task.m1.impl', REDISPATCH_LOOP)).attempts, 0, 'the task\'s re-dispatch allowance is untouched');
  });

  it('a command run again: the PM\'s ask retried after its write writes nothing new; one ask, one step, and the passes queue it once', async () => {
    const { ports, engine } = await constructorAsks(['Which?']);
    const id = 'cdec.con.m1.impl.1';
    const req = { mission: M, escalation: id, option: 'ask-architect' as const, words: [], noWords: true, reason: 'a question of design', instructions: ASK };
    const first = await answerByPm(ports, req);
    const again = await answerByPm(ports, req);
    assert.deepEqual([first.round, again.round], [1, 1], 'the same round, the same record');
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null, 'architect-answer': () => null }));
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null, 'architect-answer': () => null }));
    assert.equal((await events(ports, { line: 'secretary', event: 'pm-answer' })).length, 1);
    assert.deepEqual([...ports.scheduler.tasks.keys()].filter((t) => t.startsWith('arch-ask.')), [askTask(M, { escalation: id, by: 'pm', round: 1 })]);
  });
});

describe('4.4 G1: who asks, and who answers in between', () => {
  it('the PM asks on the user\'s words; "I need to know this first" returns to a fresh Secretary round, which the earlier PM round does not shut out; the user does not ask (p11-2)', async () => {
    const { ports, engine } = await constructorAsks(['Which line ending?']);
    const id = 'cdec.con.m1.impl.1';
    await assert.rejects(answerByPm(ports, { mission: M, escalation: id, option: 'ask-architect', words: [], noWords: true, reason: 'the user wants the Architect to say' }), /ask-architect requires --instructions/);
    await assert.rejects(answerEscalation(ports, { mission: M, escalation: id, option: 'ask-architect', instructions: ASK, words: `${SEED_TEXT} (W-1)` }), /ask-architect is the Secretary's or the PM's choice/);
    const { round } = await answerByPm(ports, { mission: M, escalation: id, option: 'ask-architect', words: [], noWords: true, reason: 'the user wants the Architect to say', instructions: ASK });
    assert.equal(round, 1);
    assert.ok(!pmInbox(ports.ctx).some((i) => i.id === `${M}/${id}`), 'not in the inbox while the Architect works');
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null, 'architect-answer': reply({ reply: 'need-to-know', text: 'Does the user run it on Windows?' }) }));
    const step = askTask(M, { escalation: id, by: 'pm', round: 1 });
    assert.equal(ports.scheduler.card<ArchitectAnswerCard>(step).asked.by, 'pm');
    const rejected = (await events(ports, { line: 'secretary', event: 'pm-answer-rejected' })).find((e) => e.key === `${id}#1`)?.body as { architect?: string; why: string } | undefined;
    assert.equal(rejected?.architect, `${id}:p1`, 'the PM\'s round is closed by the reply');
    const retry = (await events(ports, { line: 'secretary', event: 'secretary-retry' })).find((e) => e.key === `${id}#1`)?.body as { architect?: string; why: string; task: string } | undefined;
    assert.equal(retry?.architect, `${id}:p1`, 'and the escalation returns to a fresh Secretary round with the reply');
    assert.match(retry?.why ?? '', /needs to know this first: Does the user run it on Windows\?/);
    assert.ok(!pmInbox(ports.ctx).some((i) => i.id === `${M}/${id}`), 'not drawn into the PM\'s inbox');
    const card = ports.scheduler.card<SecretaryCard>(`sec.${id}.retry1`);
    assert.ok(card.request.reasons.some((x) => x.includes('Does the user run it on Windows?')), 'the Secretary\'s card carries the Architect\'s question');
    // the Secretary settles the detail itself: carried out as its answer, though the PM had answered round 1
    await drive(engine, ports.scheduler, withKinds({ secretary: (t) => ((t.card as unknown as SecretaryCard).request.id === id ? { handBack: secretary(t.card as unknown as SecretaryCard, 'answer', { instructions: 'Use LF: the user runs Linux only.' }) } : null) }));
    const a = await applied(ports, id);
    assert.deepEqual([(a?.['what'] as { option: string }).option, a?.['by']], ['answer', 'secretary']);
  });

  it('the reopened Secretary round may send it to the PM: the PM gets it with the Secretary\'s brief, and answers it (p11-2)', async () => {
    const { ports, engine } = await constructorAsks(['Which line ending?']);
    const id = 'cdec.con.m1.impl.1';
    await answerByPm(ports, { mission: M, escalation: id, option: 'ask-architect', words: [], noWords: true, reason: 'design', instructions: ASK });
    await drive(engine, ports.scheduler, withKinds({
      secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'ask-pm', { notice: 'The question: CRLF or LF? The options: answer. The words: none. I would ask the user.' }) }),
      'architect-answer': reply({ reply: 'plan-must-change', text: 'The output format is undecided.', why: 'It changes what the user gets.' }),
    }));
    const item = pmInbox(ports.ctx).find((i) => i.id === `${M}/${id}`);
    assert.ok(item !== undefined, 'listed once the Secretary\'s round sends it up');
    assert.equal(item!.brief?.by, 'secretary');
    assert.match(item!.brief?.notice ?? '', /CRLF or LF\?/);
    await answerByPm(ports, { mission: M, escalation: id, option: 'answer', words: [], noWords: true, reason: 'the user said', instructions: 'CRLF.' });
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null }));
    assert.deepEqual([((await applied(ports, id))?.['what'] as { option: string }).option, (await applied(ports, id))?.['by']], ['answer', 'pm']);
  });

  it('the PM settles the escalation while its own ask is pending: one write closes the ask and records its answer as the next round; the step is cancelled; an identical ask again stays idempotent (p11-1)', async () => {
    const { ports, engine } = await constructorAsks(['Which quote character?']);
    const id = 'cdec.con.m1.impl.1';
    const ask = { mission: M, escalation: id, option: 'ask-architect' as const, words: [], noWords: true, reason: 'design', instructions: ASK };
    await answerByPm(ports, ask);
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null, 'architect-answer': () => null }));
    const step = askTask(M, { escalation: id, by: 'pm', round: 1 });
    assert.equal(ports.scheduler.tasks.get(step)?.state, 'queued');
    assert.equal((await answerByPm(ports, ask)).round, 1, 'the same ask again: nothing new');
    const settled = await answerByPm(ports, { mission: M, escalation: id, option: 'answer', words: [], noWords: true, reason: 'the user said', instructions: 'Double quotes.' });
    assert.equal(settled.round, 2, 'the PM\'s choice is the next round');
    const closed = (await events(ports, { line: 'secretary', event: 'pm-answer-rejected' })).find((e) => e.key === `${id}#1`)?.body as { closedBy?: string } | undefined;
    assert.equal(closed?.closedBy, 'pm', 'the pending ask is closed in the same write');
    assert.equal((await answerByPm(ports, { mission: M, escalation: id, option: 'answer', words: [], noWords: true, reason: 'the user said', instructions: 'Double quotes.' })).round, 2, 'that answer run again: nothing new');
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null, 'architect-answer': () => null }));
    assert.notEqual(ports.scheduler.tasks.get(step)?.state, 'queued', 'the Architect\'s step is cancelled');
    const a = await applied(ports, id);
    assert.deepEqual([(a?.['what'] as { option: string }).option, a?.['by'], a?.['answerRound']], ['answer', 'pm', 2]);
  });

  it('a queued step is cancelled when another decider answers first, and its claim is refused before that pass', async () => {
    const { ports, engine } = await constructorAsks(['Which quote character?']);
    const id = 'cdec.con.m1.impl.1';
    await drive(engine, ports.scheduler, withKinds({ secretary: asksArchitect((c) => c.request.id === id), 'architect-answer': () => null }));
    const step = askTask(M, { escalation: id, by: 'secretary', round: 0 });
    assert.equal(ports.scheduler.tasks.get(step)?.state, 'queued');
    await answerByPm(ports, { mission: M, escalation: id, option: 'answer', words: [], noWords: true, reason: 'the user said', instructions: 'Use double quotes.' });
    assert.throws(() => pmDispatch(ports.ctx, step, { filledBy: 'test/scripted' }), (e: Error & { code?: string }) => e.code === 'NOT_READY' && /superseded: the PM answered escalation cdec\.con\.m1\.impl\.1/.test(e.message));
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null, 'architect-answer': () => null }));
    assert.notEqual(ports.scheduler.tasks.get(step)?.state, 'queued', 'cancelled');
    assert.deepEqual(await replies(ports), [], 'no reply');
    assert.equal((await applied(ports, id))?.['by'], 'pm', 'the PM\'s answer is carried out');
  });

  it('a step in flight when the escalation is answered or closed hands back; its reply is kept with why and changes nothing', async () => {
    for (const how of ['answered', 'closed'] as const) {
      const { ports, engine } = await constructorAsks(['Which delimiter?']);
      const id = 'cdec.con.m1.impl.1';
      await drive(engine, ports.scheduler, withKinds({ secretary: asksArchitect((c) => c.request.id === id), 'architect-answer': () => null }));
      const step = askTask(M, { escalation: id, by: 'secretary', round: 0 });
      ports.scheduler.dispatchOf(step);
      if (how === 'answered') await answerByPm(ports, { mission: M, escalation: id, option: 'answer', words: [], noWords: true, reason: 'the user said', instructions: 'A comma.' });
      else await closeEscalations(flowCtx(ports, M), 'test:close', 'task:impl', 'the work it was about changed (test)');
      await drive(engine, ports.scheduler, withKinds({ secretary: () => null, 'architect-answer': () => null }));
      const was = await applied(ports, id);
      assert.equal(await ports.scheduler.run(step, { handBack: { reply: 'answer', text: 'A semicolon.' } }).then((p) => p.length), 0, 'the late hand-back is accepted: it is kept on the record');
      await drive(engine, ports.scheduler, withKinds({ secretary: () => null }));
      const r = await replies(ports);
      assert.equal(r.length, 1);
      assert.match(r[0]!.body.moot ?? '', how === 'answered' ? /escalation cdec\.con\.m1\.impl\.1 was carried out \(answer by the PM\)/ : /escalation cdec\.con\.m1\.impl\.1 was closed: the work it was about changed/);
      assert.deepEqual(await applied(ports, id), was, 'nothing changed');
      assert.ok(!(await events(ports, { line: 'secretary', event: 'secretary-retry' })).some((e) => e.key.startsWith(id)), 'nothing came back');
    }
  });

  it('checked inside the write: a PM answer recorded between the read and the write of a reply refuses it; the next pass keeps it as moot', async () => {
    const { ports, engine } = await constructorAsks(['Which header?']);
    const id = 'cdec.con.m1.impl.1';
    await drive(engine, ports.scheduler, withKinds({ secretary: asksArchitect((c) => c.request.id === id), 'architect-answer': () => null }));
    const step = askTask(M, { escalation: id, by: 'secretary', round: 0 });
    await ports.scheduler.run(step, { handBack: { reply: 'plan-must-change', text: 'S2 must name the header.', why: 'It is open.' } });
    const append = ports.ledger.append.bind(ports.ledger);
    let raced = false;
    ports.ledger.append = async (op, entries) => {
      if (!raced && op.startsWith('flow:architect-answer:') && op.endsWith(':current')) {
        raced = true;
        await answerByPm(ports, { mission: M, escalation: id, option: 'answer', words: [], noWords: true, reason: 'the user said', instructions: 'No header.' });
      }
      return append(op, entries);
    };
    const reports = await engine.reconcile(M);
    assert.ok(raced);
    assert.ok(reports[0]!.errors.some((e) => e.step === 'architect-ask' && /nothing was written/.test(e.message)), JSON.stringify(reports));
    ports.ledger.append = append;
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null }));
    const r = await replies(ports);
    assert.equal(r.length, 1);
    assert.match(r[0]!.body.moot ?? '', /the PM answered escalation|was carried out/);
    assert.ok(!(await events(ports, { line: 'secretary', event: 'secretary-retry' })).some((e) => e.key.startsWith(id)), 'the reply sent nothing back');
    assert.equal((await applied(ports, id))?.['by'], 'pm');
  });
});

describe('4.4 G1: the hand-back, the option and compatibility', () => {
  const card = { seat: 'architect-answer', taskCard: { id: "impl" }, tasks: ['iface'] } as unknown as ArchitectAnswerCard;
  const problems = (raw: unknown): string[] => handBackProblems(card, raw, {});
  it('the mechanical check refuses anything but the three replies', () => {
    assert.deepEqual(problems({ reply: 'answer', text: 'Yes.' }), []);
    assert.deepEqual(problems({ reply: 'answer', text: 'Yes.', tasks: ['iface'] }), []);
    assert.deepEqual(problems({ reply: 'plan-must-change', text: 'S1 must change.', why: 'it is unclear' }), []);
    assert.deepEqual(problems({ reply: 'need-to-know', text: 'Which OS?' }), []);
    assert.match(problems({ reply: 'answer', text: 'Yes.', change: [{ id: 'impl' }] }).join('\n'), /change: not a field of this hand-back\. You change nothing here/);
    assert.ok(problems({ reply: 'reopen', text: 'x' }).length > 0, 'no other reply');
    assert.match(problems({ reply: 'answer', text: ' ' }).join('\n'), /text: give the answer/);
    assert.match(problems({ reply: 'plan-must-change', text: 'S1.' }).join('\n'), /why: say why the plan must change/);
    assert.match(problems({ reply: 'answer', text: 'Yes.', why: 'because' }).join('\n'), /why: only for reply "plan-must-change"/);
    assert.match(problems({ reply: 'need-to-know', text: 'Which?', tasks: ['iface'] }).join('\n'), /tasks: only with reply "answer"/);
    assert.match(problems({ reply: 'answer', text: 'Yes.', tasks: ['nope'] }).join('\n'), /tasks: "nope" is not a task of the plan in effect/);
    assert.match(problems({ reply: 'answer', text: 'x'.repeat(10_001) }).join('\n'), /at most 10000 characters/);
  });

  it('the Secretary gives instructions with an ask; the option says what always holds', async () => {
    const { ports } = await constructorAsks(['Which?']);
    const esc = (await escalation(flowCtx(ports, M), 'cdec.con.m1.impl.1'))!;
    const c = ports.scheduler.card<SecretaryCard>('sec.cdec.con.m1.impl.1');
    const base = { option: 'ask-architect', classification: 'detail', authorization: null, reason: 'a design question', instructions: '', grantExtra: 0, notice: '', mayMatter: false } as const;
    assert.ok(secretaryProblems(c, base, new Set(c.materials.flatMap((m) => Array.from({ length: m.pages }, (_, i) => `${m.id}#${i + 1}`)))).includes('instructions: option "ask-architect" needs the instructions'));
    assert.match(pmOptions(esc).find((o) => o.id === 'ask-architect')!.outcome, /one Architect step answers the question with your instructions and changes no card, standard or plan; .*its answer is carried out as this escalation's answer \(a review that waits for it is ready once it is carried out\)/);
    assert.ok(renderSeatCard(c as never, { dispatch: 'D-x' }).includes('A question of design (the plan would have to say something it does not say) goes to the Architect: ask-architect'));
  });

  it('upgrade: an escalation raised before 4.4 does not offer it, to the Secretary or the PM, and reads as before', async () => {
    const { ports } = await setup();
    const ctx = flowCtx(ports, M);
    // the 4.3 shape of a Constructor's questions: no ask-architect among its options
    await raiseEscalation(ctx, { id: 'cdec.old', source: 'constructor-decision', lineage: 'task.m1.impl', subject: 'task:impl', summary: 'questions', reasons: ['an old question'], options: ['answer', 'replan', 'ask-user'], facts: { task: 'impl', attempt: 1, questions: ['an old question'] } });
    const esc = (await escalation(ctx, 'cdec.old'))!;
    assert.ok(!secretaryOptions(esc, true).some((o) => o.id === 'ask-architect'));
    assert.ok(!pmOptions(esc).some((o) => o.id === 'ask-architect'));
    await assert.rejects(answerByPm(ports, { mission: M, escalation: 'cdec.old', option: 'ask-architect', words: [], noWords: true, reason: 'r', instructions: ASK }), /choose an offered decision option/);
    assert.equal(await decisionFor(ctx, 'cdec.old'), null);
  });

  it('the answer card offers checkout --product for a task with an accepted product only', async () => {
    const accepted = { seat: 'architect-answer', accepted: [{ task: 'impl', product: 'p', attempt: 1, changedPaths: [] }] } as never;
    const none = { seat: 'architect-answer', accepted: [] } as never;
    const lines = (c: never) => renderSeatCard({ ...(c as object), ...baseCard() } as never, { dispatch: 'D-9' });
    assert.ok(lines(accepted).includes('`mp seat D-9 checkout --product <task>`'));
    assert.ok(!lines(none).includes('`mp seat D-9 checkout --product <task>`'));
  });
});

/** A new effective event of the plan in effect with one amendment (a repair's change of a card, or an added task). */
async function amend(w: World, entry: Record<string, unknown>, tasks: string[] = []): Promise<void> {
  const eff = (await events(w, { line: 'plan', event: 'effective' })).at(-1)!;
  const body = eff.body as { dplan: string; tasks: string[]; amendments?: unknown[] };
  const amendments = [...(body.amendments ?? []), { repair: 'R-9', tasks: [], reopen: [], arch: 'arch-repair.test', ...entry }];
  await w.ledger.append(`test:amend:${amendments.length}`, { events: [{ mission: M, line: 'plan', event: 'effective', key: `${body.dplan}#a${amendments.length}`, body: { ...body, tasks: [...body.tasks, ...tasks], amendments } }] });
}

describe('4.4 G1, review round 1', () => {
  it('p11-4: the asking task\'s card replaced before its escalation is closed: a reply recorded in that window is moot, and no named task gets it', async () => {
    const { ports, engine } = await constructorAsks(['Which delimiter?']);
    const id = 'cdec.con.m1.impl.1';
    await drive(engine, ports.scheduler, withKinds({ secretary: asksArchitect((c) => c.request.id === id), 'architect-answer': () => null }));
    const step = askTask(M, { escalation: id, by: 'secretary', round: 0 });
    ports.scheduler.dispatchOf(step);
    const impl = detailedPlan(M).tasks.find((t) => t.id === 'impl')!;
    await amend(ports, { changed: [{ ...impl, goal: 'Implement the parser, streaming' }] });
    await ports.scheduler.run(step, { handBack: { reply: 'answer', text: 'A comma, and iface documents it.', tasks: ['iface'] } });
    await engine.reconcile(M);
    const r = await replies(ports);
    assert.equal(r.length, 1);
    assert.match(r[0]!.body.moot ?? '', /task impl has a new card in the plan in effect: the question was about its earlier card/);
    assert.deepEqual(architectNotesFor(await events(ports), 'iface', []), [], 'not printed on the task it names');
    assert.notEqual(((await applied(ports, id))?.['what'] as { option?: string } | undefined)?.option, 'answer', 'not carried out as the answer');
  });

  it('p11-6: the Architect reads the review of the attempt before when the asking attempt has none, and the hand-back of a Constructor whose export used the loop up', async () => {
    const { ports, engine } = await setup();
    let reviewed = false;
    await drive(engine, ports.scheduler, withKinds({
      reviewer: (t) => { const c = t.card as unknown as ReviewerCard; if (c.target.includes('impl') && !reviewed) { reviewed = true; return { handBack: reviewer(c, 'rework') }; } return { handBack: reviewer(c, 'pass') }; },
      constructor: (t: FlowTask) => ({ handBack: t.task === 'con.m1.impl.2' ? { ...constructorDone({ decisions_needed: ['Which escape?'] }), blocked: true } : constructorDone({ done: `finished ${t.task}` }) }),
      secretary: asksArchitect((c) => c.request.id === 'cblk.con.m1.impl.2.1'),
      'architect-answer': () => null,
    }));
    const card = ports.scheduler.card<ArchitectAnswerCard>(askTask(M, { escalation: 'cblk.con.m1.impl.2.1', by: 'secretary', round: 0 }));
    assert.deepEqual((card.materials ?? []).map((m) => m.id).sort(), ['constructor-claims', 'plan', 'previous-review']);
    assert.match(card.materials!.find((m) => m.id === 'previous-review')!.title, /attempt 1/, 'the latest review of the work, with its attempt');
    assert.match(card.materials!.find((m) => m.id === 'constructor-claims')!.title, /attempt 2/, 'the hand-back that paused attempt 2');

    // the export case: no product is recorded, and the loop is used up by the rejected candidates
    const w = await setup();
    await drive(w.engine, w.ports.scheduler, withKinds({ constructor: (t: FlowTask) => (t.task.startsWith('con.m1.impl.') ? null : { handBack: constructorDone() }) }));
    w.ports.scheduler.actions = { product: async () => { throw Object.assign(new Error('the candidate cannot be recorded'), { code: 'product-rejected' }); } };
    await drive(w.engine, w.ports.scheduler, withKinds({ secretary: asksArchitect((c) => c.request.source === 'loop-exhausted'), 'architect-answer': () => null }));
    const ask = [...w.ports.scheduler.tasks.keys()].find((t) => t.startsWith('arch-ask.'));
    assert.ok(ask !== undefined, JSON.stringify([...w.ports.scheduler.tasks.keys()]));
    const export_ = w.ports.scheduler.card<ArchitectAnswerCard>(ask!);
    assert.ok((export_.materials ?? []).some((m) => m.id === 'constructor-claims'), `the completed hand-back is readable: ${JSON.stringify(export_.materials?.map((m) => m.id))}`);
  });

  it('p11-7: a queued answer card is current when claimed: a decision recorded since and a task added since are on it', async () => {
    const { ports, engine } = await constructorAsks(['Which encoding?']);
    const id = 'cdec.con.m1.impl.1';
    await drive(engine, ports.scheduler, withKinds({ secretary: asksArchitect((c) => c.request.id === id), 'architect-answer': () => null }));
    const step = askTask(M, { escalation: id, by: 'secretary', round: 0 });
    const queued = ports.scheduler.card<ArchitectAnswerCard>(step);
    assert.ok(!queued.tasks.includes('extra'));
    await recordItem(ports, { mission: M, item: 'd9', type: 'decision', text: 'Fields are UTF-8.', source: { kind: 'words', words: 'W-1', quote: 'The details are yours to decide' } });
    const impl = detailedPlan(M).tasks.find((t) => t.id === 'impl')!;
    await amend(ports, { tasks: [{ ...impl, id: 'extra', goal: 'An added task', dependsOn: ['impl'], writeScope: ['src/extra/**'] }] }, ['extra']);
    pmDispatch(ports.ctx, step, { filledBy: 'test/scripted' });
    const claimed = claimedCard<ArchitectAnswerCard>(ports, step);
    assert.ok(claimed.tasks.includes('extra'), 'a task added since can be named');
    assert.ok(claimed.decisionQuotes.some((q) => q.startsWith('Fields are UTF-8.')), JSON.stringify(claimed.decisionQuotes));
    assert.deepEqual(handBackProblems(claimed, { reply: 'answer', text: 'UTF-8.', tasks: ['extra'] }, {}), []);
  });

  it('p11-8: mp read blocked names the Architect\'s step when the PM passed an escalation the Secretary sent up to the Architect', async () => {
    const { ports, engine } = await setup();
    let first = true;
    await drive(engine, ports.scheduler, withKinds({
      reviewer: (t) => { const c = t.card as unknown as ReviewerCard; if (c.target.includes('impl') && first) { first = false; return { handBack: reviewer(c, 'needs-decision') }; } return { handBack: reviewer(c, 'pass') }; },
      secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'ask-pm') }),
    }));
    const id = 'rnd.rev.m1.impl.1';
    assert.ok(readSteps(ports.ctx).waitingOnUser.some((w) => w.escalation === id), 'sent up: waits on the user');
    await answerByPm(ports, { mission: M, escalation: id, option: 'ask-architect', words: [], noWords: true, reason: 'design', instructions: ASK });
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null, 'architect-answer': () => null }));
    assert.ok(!readSteps(ports.ctx).waitingOnUser.some((w) => w.escalation === id), 'the consultation in effect: no longer waiting on the user');
    const step = askTask(M, { escalation: id, by: 'pm', round: 1 });
    const line = (await resolveSubtasks(ports.ctx)).blocked.flatMap((e) => (e.blocked !== null ? [e.blocked] : [])).find((b) => b.because.includes(id))!;
    assert.equal(line.next, `the Architect answers it: step ${step} is ready: dispatch it (mp pm next)`);
  });
});

/** The used-up rework loop of impl (its Reviewer always sends it back); the Secretary's script on it: `round` 0 or a returned one. */
const reworksImpl: Script = (t) => { const c = t.card as unknown as ReviewerCard; return { handBack: reviewer(c, c.target.includes('impl') ? 'rework' : 'pass') }; };
const onLoop = (f: (c: SecretaryCard, returned: boolean) => ReturnType<Script>): Script => (t) => {
  const c = t.card as unknown as SecretaryCard;
  return c.request.source === 'loop-exhausted' ? f(c, c.request.reasons.some((r) => r.startsWith('The Architect'))) : null;
};
const blockedLine = async (w: World, id: string): Promise<string> => (await resolveSubtasks(w.ctx)).blocked.flatMap((e) => (e.blocked !== null ? [e.blocked] : [])).find((b) => b.because.includes(id))!.next;
/** What the PM inbox lists about one escalation: its decision item, or a notice whose action answers it. */
const inboxAbout = (w: World, id: string) => pmInbox(w.ctx).filter((i) => i.id.includes(id) || i.action.includes(id));

describe('4.4 G1, review round 2', () => {
  it('p11-r2-1: the PM asks, the Architect needs to know first, the returned Secretary round answers: the released Reviewer\'s card carries that answer under the question, and the task\'s next cards in their decision quotes', async () => {
    const { ports, engine } = await constructorAsks(['Which line ending?']);
    const id = 'cdec.con.m1.impl.1';
    await answerByPm(ports, { mission: M, escalation: id, option: 'ask-architect', words: [], noWords: true, reason: 'design', instructions: ASK });
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null, 'architect-answer': reply({ reply: 'need-to-know', text: 'Does the user run it on Windows?' }) }));
    const answer = 'Use LF: the user runs Linux only.';
    await drive(engine, ports.scheduler, withKinds({
      secretary: (t) => { const c = t.card as unknown as SecretaryCard; return c.request.id === id ? { handBack: secretary(c, 'answer', { instructions: answer }) } : null; },
      reviewer: (t) => ({ handBack: reviewer(t.card as unknown as ReviewerCard, t.task === 'rev.m1.impl.1' ? 'rework' : 'pass') }),
    }));
    const a = await applied(ports, id);
    assert.deepEqual([(a?.['what'] as { option: string }).option, a?.['by']], ['answer', 'secretary']);
    const rev = claimedCard<ReviewerCard>(ports, 'rev.m1.impl.1');
    assert.deepEqual(rev.questions?.map((q) => [q.state, q.by, q.answer]), [['answered', 'secretary', answer]], 'under the question (its own attempt\'s answers are not repeated in its quotes, F4)');
    // the decision quotes: the next attempt's Constructor, queued and claimed
    for (const [where, quotes] of [['queued', ports.scheduler.card<ConstructorCard>('con.m1.impl.2').decisionQuotes], ['claimed', claimedCard<ConstructorCard>(ports, 'con.m1.impl.2').decisionQuotes]] as const) assert.ok(quotes.includes(answer), `${where}: ${JSON.stringify(quotes)}`);
    // and in the earlier decisions a Secretary card lists for another escalation of the task
    const earlier = earlierDecisionsOf({ id: 'other', subject: 'task:impl' } as EscalationBody, await events(ports)).find((x) => x.escalation === id);
    assert.deepEqual([earlier?.option, earlier?.by], ['answer', 'secretary']);
  });

  it('p11-r2-2: a grant the returned round chose and the ledger refused hands it up for that round: the PM inbox lists it, and mp read blocked says to ask the user', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds({
      reviewer: reworksImpl,
      secretary: onLoop((c, returned) => (returned ? null : { handBack: secretary(c, 'ask-architect', { instructions: ASK }) })),
      'architect-answer': reply({ reply: 'answer', text: 'Use commas.' }),
    }));
    const id = (await events(ports, { line: 'secretary', event: 'escalation' })).map((e) => e.body as { id: string; source: string }).find((e) => e.source === 'loop-exhausted')!.id;
    const retry = `sec.${id}.retry1`;
    assert.equal(ports.scheduler.tasks.get(retry)?.state, 'queued', 'returned to a fresh Secretary round');
    // the used-up loop's card (with G5): a question of design is the Architect's or a re-plan's, and why not an acceptance
    assert.ok(renderSeatCard(ports.scheduler.card<SecretaryCard>(retry) as never, { dispatch: 'D-x' }).includes('ask the Architect or choose replan, not an acceptance: an acceptance with risk leaves each of its reasons open, as an open item of the task.'));
    // claimed while its grant is available; another escalation of the lineage uses the Secretary's one grant meanwhile
    ports.scheduler.dispatchOf(retry);
    await ports.scheduler.grant({ op: 'other-escalation', lineage: 'task.m1.impl', loop: 'rework', extra: 1, by: 'secretary', reason: 'another escalation of the lineage' });
    assert.deepEqual(await ports.scheduler.run(retry, { handBack: secretary(ports.scheduler.card<SecretaryCard>(retry), 'grant', { instructions: 'One more attempt.', grantExtra: 1 }) }), []);
    await drive(engine, ports.scheduler, withKinds({ reviewer: reworksImpl, secretary: () => null }));
    assert.deepEqual((await events(ports, { line: 'secretary', event: 'to-user' })).map((e) => e.key), [`${id}#1`], 'the hand-up is the returned round\'s');
    assert.equal(await decisionFor(flowCtx(ports, M), id), null, 'no decision of the Secretary\'s to carry out');
    const item = pmInbox(ports.ctx).find((i) => i.id === `${M}/${id}`);
    assert.ok(item !== undefined, 'the PM gets it');
    assert.match(item!.brief?.handedOver ?? '', /grant on lineage task\.m1\.impl was refused/);
    assert.ok(readSteps(ports.ctx).waitingOnUser.some((w) => w.escalation === id), 'it waits on the user');
    assert.match(await blockedLine(ports, id), /^ask the user; then mp pm answer m1 /);
    assert.equal(await applied(ports, id), undefined, 'nothing carried out');
    // what the Secretary's hand-back command reports (F9): handed on to the PM, with the flow's reason
    const told = ports.ctx.memory.read((db) => decisionOutcome(db, ports.ctx.memory.data, { mission: M, escalation: id, task: retry, fields: null, why: null }));
    assert.deepEqual([told.state, /grant on lineage task\.m1\.impl was refused/.test(told.text)], ['to-pm', true], told.text);
  });

  it('p11-r2-2, p11-2: handed up before an Architect\'s return: in the returned round neither the escalation nor its hand-up notice waits for the PM; a hand-up in that round is its own, and honoured', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds({ reviewer: reworksImpl, secretary: () => null }));
    const id = (await events(ports, { line: 'secretary', event: 'escalation' })).map((e) => e.body as { id: string; source: string }).find((e) => e.source === 'loop-exhausted')!.id;
    // the first round's grant: claimed while available, refused by the ledger (another escalation used it)
    ports.scheduler.dispatchOf(`sec.${id}`);
    await ports.scheduler.grant({ op: 'other-escalation', lineage: 'task.m1.impl', loop: 'rework', extra: 1, by: 'secretary', reason: 'another escalation of the lineage' });
    await ports.scheduler.run(`sec.${id}`, { handBack: secretary(ports.scheduler.card<SecretaryCard>(`sec.${id}`), 'grant', { instructions: 'One more attempt.', grantExtra: 1 }) });
    await drive(engine, ports.scheduler, withKinds({ reviewer: reworksImpl, secretary: () => null }));
    assert.deepEqual((await events(ports, { line: 'secretary', event: 'to-user' })).map((e) => e.key), [id], 'handed up');
    assert.deepEqual(inboxAbout(ports, id).map((i) => i.kind), ['decision']);
    await answerByPm(ports, { mission: M, escalation: id, option: 'ask-architect', words: [], noWords: true, reason: 'design', instructions: ASK });
    await drive(engine, ports.scheduler, withKinds({ reviewer: reworksImpl, secretary: () => null, 'architect-answer': reply({ reply: 'need-to-know', text: 'Which OS does the user run?' }) }));
    assert.equal(ports.scheduler.tasks.get(`sec.${id}.retry1`)?.state, 'queued', 'back with the Secretary');
    assert.deepEqual(inboxAbout(ports, id), [], 'no item, and not the earlier hand-up\'s notice, waits for the PM meanwhile');
    assert.ok(!readSteps(ports.ctx).waitingOnUser.some((w) => w.escalation === id));
    assert.match(await blockedLine(ports, id), /^the Secretary decides/);
    const roundAsk = { escalation: id, by: 'secretary', round: 1 } as const;
    assert.equal(askStanding(await events(ports, { line: 'secretary' }), roundAsk), null, 'an ask of the returned round would stand: the earlier hand-up is history');
    // the program hands the returned round up (as a refused grant or used-up restarts do): that round's own hand-up
    await escalateToUser(flowCtx(ports, M), id, 'only the user can allow more (test)', 'WI-08');
    assert.deepEqual((await events(ports, { line: 'secretary', event: 'to-user' })).map((e) => e.key), [id, `${id}#1`]);
    assert.equal(await decisionFor(flowCtx(ports, M), id), null);
    assert.match(askStanding(await events(ports, { line: 'secretary' }), roundAsk) ?? '', /was handed to the PM/, 'and stands no more once that round is handed up');
    const listed = inboxAbout(ports, id);
    assert.deepEqual(listed.map((i) => i.kind), ['decision'], 'listed once, as the decision to take');
    assert.equal(listed[0]!.brief?.handedOver, 'only the user can allow more (test)');
    assert.ok(readSteps(ports.ctx).waitingOnUser.some((w) => w.escalation === id && w.why === 'only the user can allow more (test)'));
    assert.match(await blockedLine(ports, id), /^ask the user; then mp pm answer m1 /);
  });

  it('p11-2: sent up by the Secretary, sent to the Architect by the PM, back with the Secretary: no inbox item or notice for it until the fresh round sends it up, with its new brief', async () => {
    const { ports, engine } = await constructorAsks(['Which line ending?']);
    const id = 'cdec.con.m1.impl.1';
    const sendsUp = (notice: string): Script => (t) => { const c = t.card as unknown as SecretaryCard; return c.request.id === id ? { handBack: secretary(c, 'ask-pm', { notice }) } : null; };
    await drive(engine, ports.scheduler, withKinds({ secretary: sendsUp('First brief: LF or CRLF?') }));
    assert.match(inboxAbout(ports, id).find((i) => i.kind === 'decision')?.brief?.notice ?? '', /First brief/);
    await answerByPm(ports, { mission: M, escalation: id, option: 'ask-architect', words: [], noWords: true, reason: 'design', instructions: ASK });
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null, 'architect-answer': reply({ reply: 'need-to-know', text: 'Which OS does the user run?' }) }));
    assert.equal(ports.scheduler.tasks.get(`sec.${id}.retry1`)?.state, 'queued');
    assert.deepEqual(inboxAbout(ports, id), [], 'neither the escalation nor the Secretary\'s earlier notice waits for the PM');
    await drive(engine, ports.scheduler, withKinds({ secretary: sendsUp('Second brief: the Architect asks which OS; ask the user.') }));
    const listed = inboxAbout(ports, id);
    assert.deepEqual(listed.map((i) => i.kind), ['decision']);
    assert.match(listed[0]!.brief?.notice ?? '', /Second brief/);
  });

  it('p11-r2-3: the Secretary round in flight when the escalation returns to a fresh round hands back an answer that puts question 2 off: recorded as moot, no open item, nothing carried out', async () => {
    const { ports, engine } = await constructorAsks(['Which quote character?', 'Which licence header?']);
    const id = 'cdec.con.m1.impl.1';
    const old = `sec.${id}`;
    const dispatch = ports.scheduler.dispatchOf(old);
    await answerByPm(ports, { mission: M, escalation: id, option: 'ask-architect', words: [], noWords: true, reason: 'design', instructions: ASK });
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null, 'architect-answer': reply({ reply: 'need-to-know', text: 'Which OS does the user run?' }) }));
    assert.equal(ports.scheduler.tasks.get(`sec.${id}.retry1`)?.state, 'queued', 'a fresh round');
    assert.equal(ports.scheduler.tasks.get(old)?.state, 'running', 'the old round is still in flight');
    await ports.scheduler.run(old, { handBack: { ...secretary(ports.scheduler.card<SecretaryCard>(old), 'answer', { instructions: 'Double quotes.' }), defer: [2] } });
    const a = ports.scheduler.answers.get(old);
    assert.ok(a?.kind === 'recorded' && a.notes.some((n) => /round sec\.cdec\.con\.m1\.impl\.1 on escalation cdec\.con\.m1\.impl\.1 was replaced by a newer round/.test(n)), JSON.stringify(a));
    assert.deepEqual(await events(ports, { line: 'open-items' }), [], 'no open item');
    assert.ok((await events(ports, { line: 'tasks', event: 'decision-released' })).some((e) => e.key === dispatch), 'taken back');
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null }));
    assert.equal(await applied(ports, id), undefined, 'nothing carried out');
    const fresh = `sec.${id}.retry1`;
    assert.equal(ports.scheduler.tasks.get(fresh)?.state, 'queued', 'the fresh round decides');
    // the fresh round's own answer puts question 2 off: its open item is the Secretary's (the PM's closed round does not make it the PM's)
    assert.deepEqual(await ports.scheduler.run(fresh, { handBack: { ...secretary(ports.scheduler.card<SecretaryCard>(fresh), 'answer', { instructions: 'Double quotes.' }), defer: [2] } }), []);
    assert.deepEqual(listOpenItems(ports.ctx, M).map((i) => [i.id, i.decider]), [[`${id}.q2`, 'secretary']]);
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null }));
    assert.deepEqual([((await applied(ports, id))?.['what'] as { option: string }).option, (await applied(ports, id))?.['by']], ['answer', 'secretary']);
  });

  it('p11-r2-3: mp read blocked names the fresh round\'s step, not the replaced one still in flight', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds({ reviewer: reworksImpl, secretary: () => null }));
    const id = (await events(ports, { line: 'secretary', event: 'escalation' })).map((e) => e.body as { id: string; source: string }).find((e) => e.source === 'loop-exhausted')!.id;
    ports.scheduler.dispatchOf(`sec.${id}`);
    await answerByPm(ports, { mission: M, escalation: id, option: 'ask-architect', words: [], noWords: true, reason: 'design', instructions: ASK });
    await drive(engine, ports.scheduler, withKinds({ reviewer: reworksImpl, secretary: () => null, 'architect-answer': reply({ reply: 'need-to-know', text: 'Which OS does the user run?' }) }));
    assert.equal(ports.scheduler.tasks.get(`sec.${id}.retry1`)?.state, 'queued');
    assert.equal(await blockedLine(ports, id), 'the Secretary decides: dispatch its step (mp pm next)');
    const d = ports.scheduler.dispatchOf(`sec.${id}.retry1`);
    assert.equal(await blockedLine(ports, id), `the Secretary is deciding (${d} in flight): wait for its hand-back`);
  });

  it('p11-6: a paused attempt resumed, whose export used the loop up: the Architect reads the resumed step\'s hand-back, not the pause\'s', async () => {
    const { ports, engine } = await setup({ reworkCap: 0 });
    await drive(engine, ports.scheduler, withKinds({
      constructor: (t: FlowTask) => ({ handBack: t.task === 'con.m1.impl.1' ? { ...constructorDone({ done: 'stopped to ask', decisions_needed: ['Which escape?'] }), blocked: true } : constructorDone({ done: `finished ${t.task}` }) }),
      secretary: () => null,
    }));
    ports.scheduler.actions = { product: async () => { throw Object.assign(new Error('the candidate cannot be recorded'), { code: 'product-rejected' }); } };
    await drive(engine, ports.scheduler, withKinds({
      constructor: (t: FlowTask) => ({ handBack: constructorDone({ done: `finished ${t.task}` }) }),
      secretary: (t) => {
        const c = t.card as unknown as SecretaryCard;
        if (c.request.id.startsWith('cblk.')) return { handBack: secretary(c, 'answer', { instructions: 'A backslash.' }) };
        return c.request.source === 'loop-exhausted' ? { handBack: secretary(c, 'ask-architect', { instructions: ASK }) } : null;
      },
      'architect-answer': () => null,
    }));
    assert.ok([...ports.scheduler.tasks.keys()].includes('con.m1.impl.1.p1'), 'the attempt resumed');
    const ask = [...ports.scheduler.tasks.keys()].find((t) => t.startsWith('arch-ask.'));
    assert.ok(ask !== undefined, JSON.stringify([...ports.scheduler.tasks.keys()]));
    const claims = ports.scheduler.card<ArchitectAnswerCard>(ask!).materials?.find((m) => m.id === 'constructor-claims');
    assert.ok(claims !== undefined);
    const doc = ports.ledger.content.get(claims!.ref);
    assert.ok(doc.includes('finished con.m1.impl.1.p1') && !doc.includes('stopped to ask'), doc);
  });
});

/** A minimal valid answer card (the fields renderSeatCard parses). */
function baseCard(): Omit<ArchitectAnswerCard, 'accepted'> {
  const t = detailedPlan(M).tasks.find((x) => x.id === 'impl')!;
  return {
    format: 'mp41.seat-card.v1', task: 'arch-ask.m1.x.s0', mission: M, module: null, capabilities: ['seat', 'model'], duties: 'answer', decisionQuotes: [], constraints: [],
    seat: 'architect-answer', workspace: { snapshot: 'b'.repeat(40), writablePaths: [] },
    escalation: { id: 'cdec.x', source: 'constructor-decision', subject: 'task:impl', summary: 's', reasons: ['Q1 (before-review): q'] },
    asked: { by: 'secretary', round: 0, instructions: 'i', reason: 'r' }, taskCard: t, attempt: 1, dplan: 'dplan.m1.1.1', requirementItems: [], earlier: [], tasks: ['iface'],
  };
}
