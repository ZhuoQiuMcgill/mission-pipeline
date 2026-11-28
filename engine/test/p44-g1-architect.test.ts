// 4.4 (G1, PM design §4): a design question is answered by an Architect, in one step. A decider chooses
// `ask-architect` on a Constructor's questions, a Reviewer's "needs a decision" or a used-up rework loop; one
// Architect step (card "architect-answer") gets the task, the question and the decider's instructions; the task
// waits as for any decision; the step changes nothing and hands back one of three replies. An answer is
// carried out as the escalation's answer; "the plan has to change" and "I need to know this first" send the
// escalation back to the decider that asked. The flows run on a real memory with scripted seats.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { flowCtx } from '../src/flow/context.ts';
import type { FlowEvent, FlowTask } from '../src/flow/ports.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { constructorDone, detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { answerByPm, answerEscalation, closeEscalations, decisionFor, escalation, pmOptions, raiseEscalation, secretaryOptions } from '../src/flow/secretary.ts';
import { askTask } from '../src/flow/architectAsk.ts';
import { ARCHITECT_ANSWER, type ArchitectAnswerBody } from '../src/flow/architectAnswers.ts';
import { pmDispatch, readSteps } from '../src/process/pm.ts';
import { resolveSubtasks } from '../src/cli/layers.ts';
import { architectNotesFor } from '../src/seat/cards/dynamic.ts';
import { REDISPATCH_LOOP } from '../src/process/index.ts';
import { pmInbox } from '../src/process/secretary.ts';
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

  it('a used-up rework loop: the answer is recorded and comes back to the Secretary; its grant carries the answer to the next attempt', async () => {
    const { ports, engine } = await setup();
    let reworks = 0;
    let granted = false;
    let back = null as SecretaryCard | null;
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
        if (!c.request.reasons.some((r) => r.startsWith('The Architect'))) return { handBack: secretary(c, 'ask-architect', { instructions: ASK }) };
        back = c;
        granted = true;
        return { handBack: secretary(c, 'grant', { instructions: 'One more attempt with the Architect\'s answer.', grantExtra: 1 }) };
      },
      'architect-answer': reply({ reply: 'answer', text: 'S1 and S2 are both met by RFC 4180 quoting.' }),
    }));
    const esc = (await events(ports, { line: 'secretary', event: 'escalation' })).map((e) => e.body as { id: string; source: string; options: string[] }).find((e) => e.source === 'loop-exhausted')!;
    assert.ok(esc.options.includes('ask-architect'), 'offered on a used-up loop');
    const r = await replies(ports);
    assert.deepEqual(r.map((x) => [x.key, x.body.reply, x.body.moot ?? null]), [[`${esc.id}:s0`, 'answer', null]], 'recorded on the escalation that asked');
    assert.ok(back !== null, 'the escalation came back to the Secretary');
    assert.ok(back!.request.reasons.some((x) => x.includes('answered: S1 and S2 are both met by RFC 4180 quoting. A grant carries this answer to the next attempt')));
    assert.equal(((await applied(ports, esc.id))?.['what'] as { option: string }).option, 'grant', 'the decider\'s grant is what was carried out');
    const rw = (await events(ports, { line: 'task:impl', event: 'rework' })).at(-1)?.body as { instructions: string[] };
    assert.ok(rw.instructions.some((i) => i.includes('The Architect\'s answer') && i.includes('S1 and S2 are both met by RFC 4180 quoting.')), JSON.stringify(rw));
    const con = [...ports.scheduler.tasks.keys()].filter((t) => t.startsWith('con.m1.impl.')).at(-1)!;
    assert.ok(ports.scheduler.card<ConstructorCard>(con).duties.includes('S1 and S2 are both met by RFC 4180 quoting.'), 'the next attempt\'s card carries it');
    // the Architect's step counted on no loop of the task: the grant's attempt only
    assert.equal((await ports.ledger.loop('task.m1.impl', REDISPATCH_LOOP)).attempts, 0);
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
});

describe('4.4 G1: who asks, and who answers in between', () => {
  it('the PM asks on the user\'s words; a reply that comes back reopens the PM\'s inbox item with it; the user does not ask', async () => {
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
    assert.equal(rejected?.architect, `${id}:p1`);
    const item = pmInbox(ports.ctx).find((i) => i.id === `${M}/${id}`);
    assert.equal(item?.round, 2);
    assert.match(item?.text ?? '', /your ask came back: The Architect \(step .*\) needs to know this first: Does the user run it on Windows\?/);
    assert.equal(await decisionFor(flowCtx(ports, M), id), null, 'the work waits for the PM again');
    await answerByPm(ports, { mission: M, escalation: id, option: 'answer', words: [], noWords: true, reason: 'the user said so', instructions: 'Use LF.' });
    await drive(engine, ports.scheduler, withKinds({ secretary: () => null }));
    assert.equal((await applied(ports, id))?.['by'], 'pm');
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
