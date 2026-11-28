// 4.4 (G3, G4, the plan's F2 and F13): a repair's text reaches every card it caused. The Architect's note on a
// repair decision is recorded and printed on the cards of the tasks it added, changed or reopened; the repair
// is shown on the cards of tasks whose card it changed and on every later attempt of a task it reopened; an
// instruction addressed to a repair reaches its Architect card and those tasks; a repair's Architect that
// cannot decide hands back its question with no edit, which goes to the PM's inbox, and the answer comes back
// on the repair's next Architect card; `mp read repairs` says what each repair did and whether it is done.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { planInEffect, submitPmBatch } from '../src/flow/planning.ts';
import type { DetailedTask } from '../src/flow/plandoc.ts';
import { REPAIR_QUESTION_TO_PM } from '../src/flow/secretary.ts';
import { constructorDone, detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { listDispatches } from '../src/memory/index.ts';
import { pmAnswer, pmConstraint, pmRepair } from '../src/process/pm.ts';
import { pmInbox } from '../src/process/secretary.ts';
import { dispatchView } from '../src/process/seat.ts';
import { renderSeatCard, type ConstructorCard, type ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import { ArchitectRepairCardSchema, renderArchitectRepair, repairProblems, type ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { repairsRead, repairsText } from '../src/cli/workReads.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;

async function setup(plan = () => detailedPlan(M)): Promise<{ ports: World; engine: FlowEngine; script: (over?: Record<string, Script>) => Script }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  // overrides by task id first, then by seat
  const script = (over: Record<string, Script> = {}): Script => (t, s) => (Object.hasOwn(over, t.task) ? over[t.task]! : Object.hasOwn(over, t.card.seat) ? over[t.card.seat]! : happyScript(M, plan))(t, s);
  return { ports, engine: new FlowEngine(ports), script };
}

function claimed<C>(ports: World, task: string): C {
  const d = ports.memory.read((db) => listDispatches(db, { task, limit: 100 })).at(-1);
  if (d === undefined) throw new Error(`no dispatch of ${task}`);
  return dispatchView(ports.ctx, d.dispatch).card as unknown as C;
}

const repairs = (ports: World) => ports.memory.read((db) => repairsRead(db, ports.memory.data, 'm1'));

const FIX: DetailedTask = {
  id: 'fixhdr', kind: 'implementation', module: 'parser', goal: 'Keep the header row', standards: [{ id: 'S1', text: 'The header row is kept' }], requirementItems: [],
  writeScope: ['src/parser/header.ts'], readableFiles: [], interpreter: 'node', verificationCommands: [{ id: 'test', command: 'npm test' }], implements: [], calls: [],
  dependsOn: ['impl'], exclusive: [], estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'small' }, provenance: 'architect',
};

describe('4.4 G3, F2: the Architect\'s note and the repair on every card it caused', () => {
  it('a reopen: the note is recorded with the decision and printed on the reopened attempt and on every later one, with the repair; done once the task is accepted at the reopened attempt or later', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    const w2 = say(ports, 'The output loses the header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'loses the header row', about: 'impl' });
    let reviews = 0;
    await drive(engine, ports.scheduler, script({
      'architect-repair': () => ({ handBack: { reopen: [{ task: 'impl', issue: 'keep the header row' }], add: [], note: 'impl writes the rows, so the header is its to keep.' } }),
      // the reopened attempt's review asks for one more rework: attempt 3 is a later attempt of the reopened task
      reviewer: (t) => ({ handBack: reviewer(t.card as never, t.task === 'rev.m1.impl.2' && reviews++ === 0 ? 'rework' : 'pass') }),
    }));
    const decided = (await ports.ledger.events<{ note?: string }>({ mission: M, line: 'repairs', event: 'decided' })).at(-1)?.body;
    assert.equal(decided?.note, 'impl writes the rows, so the header is its to keep.');
    for (const t of ['con.m1.impl.2', 'rev.m1.impl.2', 'con.m1.impl.3', 'rev.m1.impl.3']) {
      const c = claimed<ConstructorCard>(ports, t);
      assert.deepEqual(c.repairs?.map((r) => r.id), ['R-1'], `${t}: the repair is shown`);
      assert.deepEqual(c.architectNotes, [{ from: "repair R-1, the Architect's note on its decision", text: 'impl writes the rows, so the header is its to keep.' }], t);
    }
    assert.ok(renderSeatCard(claimed<ConstructorCard>(ports, 'con.m1.impl.3') as never, { dispatch: 'D-x' }).includes("## The Architect's notes on this work\n- [repair R-1, the Architect's note on its decision] impl writes the rows"));
    assert.equal(claimed<ConstructorCard>(ports, 'con.m1.iface.1').architectNotes, undefined);
    const r = repairs(ports).repairs[0]!;
    assert.equal(r.state, 'decided');
    assert.equal(r.note, 'impl writes the rows, so the header is its to keep.');
    // 4.4 (F13): the reopen's record names attempt 2, and a rework of the Reviewer's on the reopen's own loop is part of
    // its work: accepted at attempt 3, the repair is done (a decision of 4.3, read from its cards: p44-p6-merge)
    assert.equal(r.reopened[0]?.state, 'reopened at attempt 2; accepted at attempt 3 (prod.con.m1.impl.3)');
    assert.equal(r.done, true);
    assert.ok(r.dispatches.length >= 1 && r.dispatches.every((d) => d.seat === 'architect-repair'), JSON.stringify(r.dispatches));
    const text = repairsText(repairs(ports));
    assert.ok(text.includes('[R-1] usability (W-2), about task impl: "loses the header row"') && text.includes('decided; done') && text.includes("the Architect's note: impl writes the rows"), text);
  });

  it('an added task: read repairs says not done until it is accepted; an instruction addressed to the repair reaches its Architect card in full and the added task\'s cards; another repair\'s Architect card indexes it', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    const w2 = say(ports, 'Trying it, the parser drops the header row of every file. Please fix that.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'defect', text: 'the parser drops the header row', about: 'impl' });
    // addressed after the repair's step was queued: its Architect card gets it at the claim
    await pmConstraint(ports.ctx, { mission: 'project', constraint: 'for-r1', kind: 'instruction', text: 'A repair of the header touches the header code only.', scope: { paths: ['**'], taskTypes: [], repairs: ['R-1'] }, missionScope: 'm1' });
    await pmConstraint(ports.ctx, { mission: 'project', constraint: 'for-iface', kind: 'instruction', text: 'Keep the interface stable.', scope: { paths: ['**'], taskTypes: [], tasks: ['iface'] }, missionScope: 'm1' });
    await drive(engine, ports.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [], add: [FIX], note: 'a new task keeps the header' } }), 'con.m1.fixhdr.1': () => null }));
    const arch = claimed<ArchitectRepairCard>(ports, [...ports.scheduler.tasks.keys()].find((t) => t.startsWith('arch-repair.m1.'))!);
    assert.deepEqual(arch.addressed?.map((a) => a.id), ['constraint.for-r1'], 'the repair\'s own instruction in full');
    assert.deepEqual(arch.addressedIndex?.map((x) => [x.id, x.to]), [['constraint.for-iface', 'task iface']], 'the others as an index');
    assert.ok(!arch.constraints.some((c) => c.id.startsWith('constraint.for-')));
    assert.equal(repairs(ports).repairs[0]?.done, false, 'its added task is not accepted yet');
    assert.deepEqual(repairs(ports).repairs[0]?.instructions, ['constraint.for-r1']);
    await drive(engine, ports.scheduler, script());
    assert.deepEqual(claimed<ConstructorCard>(ports, 'con.m1.fixhdr.1').addressed?.map((a) => a.id), ['constraint.for-r1']);
    assert.deepEqual(claimed<ReviewerCard>(ports, 'rev.m1.fixhdr.1').addressed?.map((a) => a.id), ['constraint.for-r1']);
    assert.equal(claimed<ConstructorCard>(ports, 'con.m1.impl.1').addressed, undefined, 'not on the tasks it did not cause');
    const r = repairs(ports).repairs[0]!;
    assert.deepEqual([r.added.map((t) => t.task), r.added[0]?.done, r.done], [['fixhdr'], true, true]);
    assert.ok(r.taskDispatches >= 2, 'the dispatches on its tasks since its decision');
  });

  it('a changed card: the repair, its note and the answers given under the earlier card are on the new attempt\'s cards; done once accepted after the change', async () => {
    const plan = () => { const p = detailedPlan(M, { extraTask: true }); return { ...p, tasks: p.tasks.map((t) => (t.id === 'docs' ? { ...t, verificationCommands: [{ id: 'lint', command: 'npm run lint' }] } : t)) }; };
    const { ports, engine, script } = await setup(plan);
    await drive(engine, ports.scheduler, script({
      'con.m1.docs.1': () => ({ handBack: constructorDone({ decisions_needed: ['Which heading level?'] }) }),
      'rev.m1.docs.1': () => null,
      secretary: (t) => ({ handBack: secretary(t.card as SecretaryCard, 'answer', { instructions: 'Use a level-2 heading.' }) }),
    }));
    assert.equal(await planInEffect(flowCtx(ports, M)).then((p) => p?.plan.tasks.length), 3);
    const w2 = say(ports, 'The docs should live in the README, not in a folder of their own.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'The docs should live in the README', about: 'docs' });
    await drive(engine, ports.scheduler, script({
      'architect-repair': (t) => {
        const docs = (t.card as unknown as ArchitectRepairCard).plan.tasks.find((x) => x.id === 'docs')!;
        return { handBack: { reopen: [], add: [], change: [{ ...docs, goal: 'Document the parser in the README', writeScope: ['README.md'] }], note: 'the docs task now writes the README' } };
      },
      'con.m1.docs.2': () => null,
    }));
    const con = ports.scheduler.card<ConstructorCard>('con.m1.docs.2');
    assert.deepEqual(con.repairs?.map((r) => r.id), ['R-1'], 'a repair that changed the card is shown (4.3 did not)');
    assert.deepEqual(con.architectNotes?.map((n) => n.text), ['the docs task now writes the README']);
    assert.equal(con.earlierAnswers?.length, 1);
    assert.match(con.earlierAnswers?.[0] ?? '', /^\[[^\]]+\] secretary: Use a level-2 heading\.$/);
    assert.ok(!con.decisionQuotes.includes('Use a level-2 heading.'), 'no longer a decision in force on the new card');
    assert.ok(renderSeatCard(con as never, { dispatch: 'D-x' }).includes('## Earlier decisions on this task (made under an earlier card)\n- ['));
    assert.equal(repairs(ports).repairs[0]?.done, false);
    await drive(engine, ports.scheduler, script());
    const r = repairs(ports).repairs[0]!;
    assert.deepEqual([r.changed.map((t) => t.task), r.changed[0]?.done, r.done], [['docs'], true, true]);
  });
});

describe('4.4 compatibility: a repair decided by 4.3 (no note)', () => {
  it('its reopen still runs with the repair on the card and no note; read repairs says the note was not recorded', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    const w2 = say(ports, 'The output loses the header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'loses the header row' });
    const pie = await planInEffect(flowCtx(ports, M));
    // the decision as 4.3 wrote it: no note field
    await ports.ledger.append('test:decided-4.3', { events: [{ mission: M, line: 'repairs', event: 'decided', key: 'R-1', body: { repair: 'R-1', dplan: pie!.eff.dplan, arch: 'arch-repair.m1.R-2d1.1', add: [], reopen: [{ task: 'impl', issue: 'keep the header row', attempt: 1, product: 'prod.con.m1.impl.1' }] } }] });
    await drive(engine, ports.scheduler, script());
    const con = claimed<ConstructorCard>(ports, 'con.m1.impl.2');
    assert.deepEqual(con.repairs?.map((r) => r.id), ['R-1']);
    assert.equal(con.architectNotes, undefined);
    const r = repairs(ports).repairs[0]!;
    assert.equal(r.note, null);
    // its Architect step left no hand-back here, so no note can be read from it (p44-p6-v1: one that did)
    assert.ok(repairsText(repairs(ports)).includes("the Architect's note: (not recorded: decided under 4.3, and its Architect's hand-back has none that can be read)"));
    assert.equal(r.done, true);
  });
});

describe('4.4 G4: a repair\'s Architect hands back its question; it goes to the PM', () => {
  const ask = 'Should an empty file keep its header row, or produce no output at all?';

  it('a hand-back with no edit and a question: the PM\'s inbox shows it as its brief, no Secretary step runs, the repair stays undecided; the answer reaches the next Architect card, which decides', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    const w2 = say(ports, 'The output loses the header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'loses the header row' });
    const archCards: ArchitectRepairCard[] = [];
    const architect: Script = (t) => {
      archCards.push(t.card as unknown as ArchitectRepairCard);
      return { handBack: archCards.length === 1 ? { reopen: [], add: [], note: ask } : { reopen: [{ task: 'impl', issue: 'keep the header row, also for an empty file' }], add: [], note: 'impl owns the rows' } };
    };
    await drive(engine, ports.scheduler, script({ 'architect-repair': architect }));
    assert.equal(archCards.length, 1);
    assert.equal(repairs(ports).repairs[0]?.state, 'architect', 'undecided');
    assert.equal(repairs(ports).repairs[0]?.question?.text, ask);
    assert.ok(![...ports.scheduler.tasks.keys()].some((t) => t.startsWith('sec.')), 'no Secretary step: the question is the PM\'s');
    const item = pmInbox(ports.ctx).find((i) => i.kind === 'decision');
    assert.ok(item !== undefined, JSON.stringify(pmInbox(ports.ctx)));
    assert.ok(item.text.includes(ask), item.text);
    assert.equal(item.brief?.handedOver, REPAIR_QUESTION_TO_PM);
    assert.deepEqual(item.brief?.options.map((o) => o.id), ['answer']);
    assert.match(item.brief?.options[0]?.outcome ?? '', /the repair's next Architect step/);
    const escalation = item.id.slice('m1/'.length);
    await pmAnswer(ports.ctx, { mission: M, escalation, option: 'answer', words: '', by: 'pm', noWords: true, reason: 'the user wants the header kept', instructions: 'Keep the header row, also for an empty file.' });
    await drive(engine, ports.scheduler, script({ 'architect-repair': architect }));
    assert.equal(archCards.length, 2);
    assert.deepEqual(archCards[1]?.answers, [{ question: ask, answer: 'Keep the header row, also for an empty file.', by: 'pm' }]);
    assert.ok(renderArchitectRepair(archCards[1]!).includes(`## Your questions on this repair and the answers\n- You asked: ${ask}\n  Answer (pm): Keep the header row, also for an empty file.`));
    assert.equal(repairs(ports).repairs[0]?.state, 'decided');
    assert.equal(repairs(ports).repairs[0]?.question, null);
    assert.equal(pmInbox(ports.ctx).some((i) => i.id === item.id), false, 'answered and carried out');
    const attempts = (await ports.ledger.events<{ reason: string }>({ mission: M, line: 'repairs', event: 'attempt' })).map((e) => e.body.reason);
    assert.deepEqual(attempts, ['initial', 'answered'], 'the answer is not counted as a return');
  });

  it('a hand-back with no edit and no question is refused as in 4.3; the card asks for the question in the note', () => {
    const card = ArchitectRepairCardSchema.parse({
      format: 'mp41.seat-card.v1', task: 'arch-repair.m1.R-1.1', mission: 'm1', module: null, capabilities: [], duties: 'd', decisionQuotes: [], constraints: [],
      seat: 'architect-repair', workspace: { snapshot: 'a'.repeat(40), writablePaths: [] }, repair: { id: 'R-1', kind: 'defect', text: 'it breaks', words: 'W-2', about: null },
      dplan: 'dplan.m1.1.1', pmPlan: 'pmplan.m1.1', elements: [], plan: { reusedInterfaces: [], newInterfaces: [], modules: [], tasks: [FIX], risks: [] }, accepted: [], owners: [], history: { gitLog: '', runs: [] }, revision: null,
    });
    assert.deepEqual(repairProblems(card, { reopen: [], add: [], note: ' ' }), ['reopen, add, change: a repair reopens, changes or adds at least one task; if you cannot decide, hand back none of them with your question as the note']);
    assert.deepEqual(repairProblems(card, { reopen: [], add: [], note: 'May I add a task?' }), []);
    assert.ok(renderArchitectRepair(card).includes('hand back no reopen, add or change, with your question as the note: it goes to the PM'));
    assert.equal(card.answers, undefined, 'a card queued before 4.4 has no answers and renders');
  });

  it('a question still open when a new plan takes effect closes with it; the next Architect step decides on the new plan', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    const w2 = say(ports, 'The output loses the header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'loses the header row' });
    let n = 0;
    const architect: Script = () => ({ handBack: n++ === 0 ? { reopen: [], add: [], note: ask } : { reopen: [{ task: 'impl', issue: 'keep the header row' }], add: [], note: 'impl owns it' } });
    await drive(engine, ports.scheduler, script({ 'architect-repair': architect }));
    assert.equal(pmInbox(ports.ctx).filter((i) => i.kind === 'decision').length, 1);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: [pmPlan(M).elements[0]!, { ...pmPlan(M).elements[1]!, text: 'Covered by unit tests only' }] }), userWords: ['W-1'] });
    await drive(engine, ports.scheduler, script({ 'architect-repair': architect }));
    assert.equal(pmInbox(ports.ctx).filter((i) => i.kind === 'decision').length, 0, 'the question closed with the plan it was asked on');
    const closed = (await ports.ledger.events<{ what?: { option?: string; why?: string } }>({ mission: M, line: 'secretary', event: 'applied' })).find((e) => e.key.startsWith('ask.'));
    assert.equal(closed?.body.what?.option, 'superseded');
    assert.equal(repairs(ports).repairs[0]?.state, 'decided');
  });
});
