// 4.4 package p6, review round 1: each finding with the case that showed it.
//   p6-1 a Secretary withdrawal, a scope change and a Secretary instruction act only on the constraint version
//        their caller checked, inside the write (a PM version recorded in between is never taken over)
//   p6-2 a user's answer given with words and no instructions reaches the repair's next Architect card and the
//        earlier-decisions list by those words
//   p6-3 a changed task is done only when accepted under the card this repair gave it
//   p6-4 a reopen carried by a grant on a used-up loop is a reopen of the repair (card and read); "done" needs the
//        accepted attempt's card to carry the repair's issue (the other direction is in p44-g4-repairs)
//   p6-5 a Reviewer's answer counts for the instruction version its card showed
//   p6-6 (kept) a decision with --tasks is not printed as a decision on other tasks; a task that links it lists it
//   p6-7 a repair Architect's question is not posted once another pass moved the repair on
//   p6-8 --reach counts the Architect of an undecided repair about an addressed task

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { flowCtx } from '../src/flow/context.ts';
import { planInEffect, submitPmBatch } from '../src/flow/planning.ts';
import { recordConstraint, recordItem } from '../src/flow/requirements.ts';
import { answerEscalation, type EscalationBody } from '../src/flow/secretary.ts';
import { constructorDone, detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import type { DetailedPlanDoc } from '../src/flow/plandoc.ts';
import { withdrawConstraint } from '../src/memory/domain/constraints.ts';
import { listDispatches } from '../src/memory/index.ts';
import { pmAnswer, pmConstraint, pmConstraintScope, pmRepair, pmRequirement } from '../src/process/pm.ts';
import { pmInbox } from '../src/process/secretary.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { ConstructorCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { constraintsRead, repairsRead } from '../src/cli/workReads.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
type Append = (op: string, entries: unknown) => Promise<void>;

async function setup(plan: () => DetailedPlanDoc = () => detailedPlan(M)): Promise<{ ports: World; engine: FlowEngine; script: (over?: Record<string, Script>) => Script }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  const script = (over: Record<string, Script> = {}): Script => (t, s) => (Object.hasOwn(over, t.task) ? over[t.task]! : Object.hasOwn(over, t.card.seat) ? over[t.card.seat]! : happyScript(M, plan))(t, s);
  return { ports, engine: new FlowEngine(ports), script };
}

/** Run `between` once, just before the first append whose op starts with `prefix` (another writer in between). */
function before(ledger: unknown, prefix: string, between: () => Promise<unknown>): void {
  const l = ledger as { append: Append };
  const orig = l.append.bind(l);
  let pending = true;
  l.append = async (op, entries) => {
    if (pending && op.startsWith(prefix)) { pending = false; await between(); }
    return orig(op, entries);
  };
}

function claimed<C>(ports: World, task: string): C {
  const d = ports.memory.read((db) => listDispatches(db, { task, limit: 100 })).at(-1);
  if (d === undefined) throw new Error(`no dispatch of ${task}`);
  return dispatchView(ports.ctx, d.dispatch).card as unknown as C;
}

const reach = (ports: World, id: string) => ports.memory.read((db) => constraintsRead(db, ports.memory.data, 'm1', true)).constraints.find((c) => c.id === id);
const repairs = (ports: World) => ports.memory.read((db) => repairsRead(db, ports.memory.data, 'm1')).repairs;
const SCOPE = { paths: ['**'], taskTypes: [] };

describe('p6-1: a constraint write acts only on the version its caller checked, inside the write', () => {
  it('a Secretary withdrawal raced by a PM object constraint under the same id withdraws nothing', async () => {
    const { ports } = await setup();
    const v1 = await recordConstraint(ports, { mission: M, constraint: 'x', kind: 'instruction', text: 'Use the fixtures folder.', scope: { ...SCOPE, mission: 'm1' }, author: 'secretary' });
    before(ports.ledger, 'flow:constraint-withdraw:', () => recordConstraint(ports, { mission: M, constraint: 'x', kind: 'object', text: 'Every parser file has a test.', scope: SCOPE }));
    await assert.rejects(withdrawConstraint(ports, { constraint: 'x', by: 'secretary', reason: 'the folder moved', expect: v1 }), /changed since it was read/);
    const now = reach(ports, 'constraint.x');
    assert.equal(now?.kind, 'object', 'the PM\'s object constraint stands');
    assert.equal(now?.author, 'pm');
    assert.equal((await ports.ledger.events({ mission: M, line: 'requirements', event: 'constraint-withdrawn' })).length, 0);
  });

  it('a scope change raced by a PM project-wide object replacement narrows nothing', async () => {
    const { ports } = await setup();
    await pmConstraint(ports.ctx, { mission: 'project', constraint: 'y', kind: 'instruction', text: 'Prefer small functions.', scope: SCOPE });
    before(ports.ctx.ports().ledger, 'flow:constraint-scope:', () => recordConstraint(ports.ctx.ports(), { mission: 'project' as MissionId, constraint: 'y', kind: 'object', text: 'Every public function is documented.', scope: SCOPE }));
    await assert.rejects(pmConstraintScope(ports.ctx, { constraint: 'y', tasks: ['impl'], mission: 'm1' }), /changed since it was read/);
    const now = reach(ports, 'constraint.y');
    assert.equal(now?.kind, 'object');
    assert.equal(now?.address, null, 'not addressed');
    assert.equal((await ports.ledger.events({ mission: 'm1' as MissionId, line: 'requirements', event: 'constraint-scope' })).length, 0);
  });

  it('a Secretary instruction for a new id raced by a PM constraint under that id takes nothing over', async () => {
    const { ports } = await setup();
    before(ports.ledger, 'flow:constraint:', () => recordConstraint(ports, { mission: M, constraint: 'z', kind: 'object', text: 'No network calls in tests.', scope: SCOPE }));
    await assert.rejects(recordConstraint(ports, { mission: M, constraint: 'z', kind: 'instruction', text: 'Name fixtures by case.', scope: { ...SCOPE, mission: 'm1' }, author: 'secretary', expect: null }), /changed since it was read/);
    assert.equal(reach(ports, 'constraint.z')?.author, 'pm');
  });
});

describe('p6-2: a user\'s answer with words and no instructions is carried by its words', () => {
  it('on the repair\'s next Architect card', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    const w2 = say(ports, 'The output loses the header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'loses the header row' });
    const cards: ArchitectRepairCard[] = [];
    const architect: Script = (t) => { cards.push(t.card as unknown as ArchitectRepairCard); return { handBack: cards.length === 1 ? { reopen: [], add: [], note: 'Keep the header of an empty file?' } : { reopen: [{ task: 'impl', issue: 'keep the header' }], add: [], note: 'impl' } }; };
    await drive(engine, ports.scheduler, script({ 'architect-repair': architect }));
    const id = pmInbox(ports.ctx).find((i) => i.kind === 'decision')!.id.slice('m1/'.length);
    const w3 = say(ports, 'Keep the header, also for an empty file.');
    await pmAnswer(ports.ctx, { mission: M, escalation: id, option: 'answer', words: w3, by: 'user' });
    await drive(engine, ports.scheduler, script({ 'architect-repair': architect }));
    assert.deepEqual(cards[1]?.answers, [{ question: 'Keep the header of an empty file?', answer: `Keep the header, also for an empty file. (${w3})`, by: 'user' }]);
  });

  it('in the earlier-decisions list after a new card', async () => {
    const plan = () => { const p = detailedPlan(M, { extraTask: true }); return { ...p, tasks: p.tasks.map((t) => (t.id === 'docs' ? { ...t, verificationCommands: [{ id: 'lint', command: 'npm run lint' }] } : t)) }; };
    const { ports, engine, script } = await setup(plan);
    await drive(engine, ports.scheduler, script({
      'con.m1.docs.1': () => ({ handBack: constructorDone({ decisions_needed: ['Which heading level?'] }) }),
      'rev.m1.docs.1': () => null,
      secretary: (t) => ({ handBack: secretary(t.card as SecretaryCard, 'ask-user', { classification: 'needs-user', notice: 'the user decides the heading' }) }),
    }));
    const esc = (await ports.ledger.events<EscalationBody>({ mission: M, line: 'secretary', event: 'escalation' })).find((e) => e.body.subject === 'task:docs')!.body;
    const w3 = say(ports, 'Use a level-2 heading.');
    await pmAnswer(ports.ctx, { mission: M, escalation: esc.id, option: 'answer', words: w3, by: 'user' });
    await drive(engine, ports.scheduler, script({ 'rev.m1.docs.1': () => null }));
    const w4 = say(ports, 'The docs should live in the README, not in a folder of their own.');
    await pmRepair(ports.ctx, { mission: M, words: w4, kind: 'usability', text: 'The docs should live in the README', about: 'docs' });
    await drive(engine, ports.scheduler, script({
      'architect-repair': (t) => { const docs = (t.card as unknown as ArchitectRepairCard).plan.tasks.find((x) => x.id === 'docs')!; return { handBack: { reopen: [], add: [], change: [{ ...docs, writeScope: ['README.md'] }], note: 'the README' } }; },
      'con.m1.docs.2': () => null,
    }));
    assert.deepEqual(ports.scheduler.card<ConstructorCard>('con.m1.docs.2').earlierAnswers, [`[${esc.id}] user: Use a level-2 heading. (${w3})`]);
  });
});

describe('p6-3: a changed task is done only under the card this repair gave it', () => {
  it('a re-plan that gives the task another card before its acceptance leaves the repair not done', async () => {
    let goal = 'Integrate and document the parser';
    const plan = () => { const p = detailedPlan(M, { extraTask: true }); return { ...p, tasks: p.tasks.map((t) => (t.id === 'docs' ? { ...t, goal, verificationCommands: [{ id: 'lint', command: 'npm run lint' }] } : t)) }; };
    const { ports, engine, script } = await setup(plan);
    await drive(engine, ports.scheduler, script({ 'rev.m1.docs.1': () => null }));
    const w2 = say(ports, 'The docs should live in the README, not in a folder of their own.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'The docs should live in the README', about: 'docs' });
    await drive(engine, ports.scheduler, script({
      'architect-repair': (t) => { const docs = (t.card as unknown as ArchitectRepairCard).plan.tasks.find((x) => x.id === 'docs')!; return { handBack: { reopen: [], add: [], change: [{ ...docs, writeScope: ['README.md'] }], note: 'the README' } }; },
      'con.m1.docs.2': () => null,
    }));
    // a re-plan gives docs another card (its own goal and write path), and that card is accepted
    goal = 'Document the parser in docs/ and in the README';
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: [pmPlan(M).elements[0]!, { ...pmPlan(M).elements[1]!, text: 'Covered by unit tests, documented' }] }), userWords: ['W-1'] });
    await drive(engine, ports.scheduler, script());
    const pie = await planInEffect(flowCtx(ports, M));
    assert.equal(pie?.plan.tasks.find((t) => t.id === 'docs')?.goal, goal, 'the re-plan\'s card is in effect');
    const r = repairs(ports)[0]!;
    assert.equal(r.changed[0]?.task, 'docs');
    assert.equal(r.changed[0]?.done, false, 'accepted under another card than this repair\'s');
    assert.match(r.changed[0]!.state, /accepted at attempt \d+ .*; its card changed since this repair/);
    assert.equal(r.done, false);
  });
});

describe('p6-4: a reopen carried by a grant on a used-up rework loop', () => {
  it('is the repair\'s reopen on the card (repair, note, addressed instruction) and in the read, which says done once that attempt is accepted', async () => {
    const { ports, engine, script } = await setup();
    // impl passes at its last allowed attempt (two reworks): a reopen then needs a grant
    await drive(engine, ports.scheduler, script({ reviewer: (t) => ({ handBack: reviewer(t.card as never, t.task.startsWith('rev.m1.impl.') && !t.task.startsWith('rev.m1.impl.3') ? 'rework' : 'pass', { findings: [`finding at ${t.task}`] }) }), secretary: () => null }));
    const w2 = say(ports, 'The output loses the header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'loses the header row', about: 'impl' });
    await pmConstraint(ports.ctx, { mission: 'project', constraint: 'for-r1', kind: 'instruction', text: 'Touch the header code only.', scope: { ...SCOPE, repairs: ['R-1'] }, missionScope: 'm1' });
    await drive(engine, ports.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [{ task: 'impl', issue: 'keep the header row' }], add: [], note: 'impl writes the rows.' } }), secretary: () => null }));
    const exh = (await ports.ledger.events<EscalationBody>({ mission: M, line: 'secretary', event: 'escalation' })).map((e) => e.body).find((e) => e.source === 'loop-exhausted' && e.subject === 'task:impl');
    assert.ok(exh !== undefined, 'the reopen met the used-up loop');
    const w3 = say(ports, 'Grant one more attempt for the header.');
    await answerEscalation(ports, { mission: M, escalation: exh.id, option: 'grant', grantExtra: 1, instructions: 'Keep the header.', words: `Grant one more attempt for the header. (${w3})` });
    await drive(engine, ports.scheduler, script());
    const con = claimed<ConstructorCard>(ports, 'con.m1.impl.4');
    assert.ok(con.duties.includes('keep the header row'), 'the granted attempt carries the repair\'s issue');
    assert.deepEqual(con.repairs?.map((r) => r.id), ['R-1']);
    assert.deepEqual(con.architectNotes?.map((n) => n.text), ['impl writes the rows.']);
    assert.deepEqual(con.addressed?.map((a) => a.id), ['constraint.for-r1']);
    const r = repairs(ports)[0]!;
    assert.equal(r.reopened[0]?.state, 'reopened at attempt 4; accepted at attempt 4 (prod.con.m1.impl.4)');
    assert.equal(r.done, true);
  });
});

describe('p6-5: a Reviewer\'s answer counts for the version its card showed', () => {
  it('after the instruction\'s text is replaced the read shows no answer for the new text (an older answer without a version is resolved from its claimed card)', async () => {
    const { ports, engine, script } = await setup();
    await pmConstraint(ports.ctx, { mission: 'project', constraint: 'tabs', kind: 'instruction', text: 'Use tabs.', scope: { ...SCOPE, tasks: ['impl'] }, missionScope: 'm1' });
    await drive(engine, ports.scheduler, script());
    const review = (await ports.ledger.events<{ task: string; instructions?: Array<{ instruction: string; version?: string }> }>({ mission: M, line: 'task:impl', event: 'review' })).at(-1)!.body;
    assert.match(review.instructions?.[0]?.version ?? '', /^constraint\.tabs\.v1\./);
    assert.deepEqual(reach(ports, 'constraint.tabs')?.answers?.map((a) => a.response), ['followed']);
    // an answer recorded without its version (as an earlier build did): the read takes it from the claimed card
    const { version: _v, ...bare } = review.instructions![0]!;
    await ports.ledger.append('test:bare-answer', { events: [{ mission: M, line: 'task:impl', event: 'review', key: 'bare', body: { ...review, instructions: [bare] } }] });
    assert.deepEqual(reach(ports, 'constraint.tabs')?.answers?.map((a) => a.response), ['followed']);
    await pmConstraint(ports.ctx, { mission: 'project', constraint: 'tabs', kind: 'instruction', text: 'Use spaces.', scope: { ...SCOPE, tasks: ['impl'] }, missionScope: 'm1' });
    assert.deepEqual(reach(ports, 'constraint.tabs')?.answers, [], 'no answer of the new text');
  });
});

describe('p6-6 (kept): a decision with --tasks and a task that links the item', () => {
  it('a decision recorded after the plan with --tasks iface is not printed as a decision on impl; impl, whose card links the item, lists its current text', async () => {
    const plan = () => { const p = detailedPlan(M); return { ...p, tasks: p.tasks.map((t) => (t.id === 'impl' ? { ...t, requirementItems: [...t.requirementItems, 'item.m1.d1'] } : t)) }; };
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    await recordItem(ports, { mission: M, item: 'd1', type: 'decision', text: 'Rows are arrays', source: { kind: 'authorization', line: 'item.m1.a1' } });
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
    const engine = new FlowEngine(ports);
    const base = happyScript(M, plan);
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'constructor' ? null : base(t, s)));
    await pmRequirement(ports.ctx, { mission: M, item: 'd1', type: 'decision', text: 'Rows are arrays of strings', authorization: 'a1', tasks: ['iface'] });
    await drive(engine, ports.scheduler, base);
    const impl = claimed<ConstructorCard>(ports, 'con.m1.impl.1');
    assert.ok(!impl.decisionQuotes.includes('Rows are arrays of strings'), 'not printed on impl as a decision');
    assert.deepEqual(impl.requirementItems.find((i) => i.id === 'item.m1.d1'), { id: 'item.m1.d1', text: 'Rows are arrays of strings' }, 'impl\'s card is bound to the item and lists its current text');
    assert.ok(claimed<ConstructorCard>(ports, 'con.m1.iface.1').decisionQuotes.includes('Rows are arrays of strings'));
  });
});

describe('p6-7: a repair Architect\'s question is posted only while the repair is where the question was asked', () => {
  it('another pass that moved the repair to its next attempt in between: nothing is posted and nothing waits in the inbox', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    const w2 = say(ports, 'The output loses the header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'loses the header row' });
    const dplan = (await planInEffect(flowCtx(ports, M)))!.eff.dplan;
    before(ports.ledger, 'flow:escalation:m1:ask.', () => ports.ledger.append('test:another-pass', { events: [{ mission: M, line: 'repairs', event: 'attempt', key: 'R-1#2', body: { k: 2, dplan, reason: 'plan-changed', mechanicalFailures: [] } }] }));
    let n = 0;
    await assert.rejects(drive(engine, ports.scheduler, script({ 'architect-repair': () => ({ handBack: n++ === 0 ? { reopen: [], add: [], note: 'Keep the header?' } : { reopen: [{ task: 'impl', issue: 'keep the header' }], add: [], note: 'impl' } }) })), /moved on .* nothing was posted/);
    assert.equal((await ports.ledger.events({ mission: M, line: 'secretary', event: 'escalation' })).filter((e) => e.key.startsWith('ask.')).length, 0);
    assert.equal(pmInbox(ports.ctx).filter((i) => i.kind === 'decision').length, 0);
    // the next pass goes on from the attempt the other pass started
    await drive(engine, ports.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [{ task: 'impl', issue: 'keep the header' }], add: [], note: 'impl' } }) }));
    assert.equal(repairs(ports)[0]?.state, 'decided');
  });
});

describe('p6-8: --reach counts the Architect card that prints an instruction in full', () => {
  it('an undecided repair about a task the instruction names', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    const r = await pmConstraint(ports.ctx, { mission: 'project', constraint: 'impl-rule', kind: 'instruction', text: 'Stream the input.', scope: { ...SCOPE, tasks: ['impl'] }, missionScope: 'm1' });
    assert.deepEqual(r.reach.repairs, []);
    const w2 = say(ports, 'The output loses the header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'loses the header row', about: 'impl' });
    assert.deepEqual(reach(ports, 'constraint.impl-rule')?.reach?.architects, ['R-1']);
    const again = await pmConstraint(ports.ctx, { mission: 'project', constraint: 'impl-rule', kind: 'instruction', text: 'Stream the input.', scope: { ...SCOPE, tasks: ['impl'] }, missionScope: 'm1' });
    assert.deepEqual(again.reach.repairs, ['R-1']);
    const arch = [...ports.scheduler.tasks.keys()].find((t) => t.startsWith('arch-repair.m1.'))!;
    assert.deepEqual(ports.scheduler.card<ArchitectRepairCard>(arch).addressed?.map((a) => a.id), ['constraint.impl-rule'], 'the card the read counts');
  });
});
