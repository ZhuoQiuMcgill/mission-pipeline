// 4.4 (G3, the plan's F1): text that reaches a task comes from the role that owns it. An instruction may be
// addressed to tasks or to a repair of one mission and then reaches those cards only, under "Instructions for
// this task", before the project's constraints; the Reviewer answers each one (it blocks nothing); a decision
// item may name its tasks; answers given under an earlier card stay listed; the plan reviews get the
// instructions whose task types name their plan; the Architect's cards index the addressed ones; layer 1 lists
// only the PM's unaddressed constraints. The flows run on a real project memory with scripted seats.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { recordConstraint } from '../src/flow/requirements.ts';
import { detailedPlan, drive, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { listDispatches } from '../src/memory/index.ts';
import { pmConstraint, pmConstraintScope, pmRequirement } from '../src/process/pm.ts';
import { dispatchView } from '../src/process/seat.ts';
import { renderSeatCard, type ConstructorCard, type ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectDecomposeCard, ArchitectFeasibilityCard } from '../src/seat/cards/architect.ts';
import type { Calibrator1Card, Calibrator2Card } from '../src/seat/cards/calibrator.ts';
import { constraintsRead, constraintsText } from '../src/cli/workReads.ts';
import { pmLayer1 } from '../src/cli/pmMemory.ts';
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

/** The card a task's latest dispatch was claimed with (refreshed at the claim). */
function claimed<C>(ports: World, task: string): C {
  const d = ports.memory.read((db) => listDispatches(db, { task, limit: 100 })).at(-1);
  if (d === undefined) throw new Error(`no dispatch of ${task}`);
  return dispatchView(ports.ctx, d.dispatch).card as unknown as C;
}

const instruction = (ports: World, id: string, text: string, scope: { tasks?: string[]; repairs?: string[]; taskTypes?: string[]; mission?: string } = {}) =>
  pmConstraint(ports.ctx, { mission: 'project', constraint: id, kind: 'instruction', text, scope: { paths: ['**'], taskTypes: scope.taskTypes ?? [], ...(scope.tasks !== undefined ? { tasks: scope.tasks } : {}), ...(scope.repairs !== undefined ? { repairs: scope.repairs } : {}) }, ...(scope.mission !== undefined ? { missionScope: scope.mission } : {}) });

describe('4.4 G3: an instruction addressed to a task reaches its cards only', () => {
  it('printed under "Instructions for this task" on its Constructor and Reviewer cards, before the project constraints, and nowhere else; the Reviewer answers it and a "not followed" blocks nothing', async () => {
    const { ports, engine } = await setup();
    await instruction(ports, 'impl-only', 'Keep the parser free of regular expressions.', { tasks: ['impl'], mission: 'm1' });
    await instruction(ports, 'everyone', 'Write the commit message in English.');
    await drive(engine, ports.scheduler, withKinds({ reviewer: (t) => ({ handBack: reviewer(t.card as never, 'pass', { instructions: 'not-followed' }) }) }));
    const con = claimed<ConstructorCard>(ports, 'con.m1.impl.1');
    assert.deepEqual(con.addressed?.map((a) => a.id), ['constraint.impl-only']);
    assert.match(con.addressed?.[0]?.version ?? '', /^constraint\.impl-only\.v1\./);
    assert.ok(!con.constraints.some((c) => c.id === 'constraint.impl-only'), 'an addressed instruction is not a project constraint of the card');
    assert.ok(con.constraints.some((c) => c.id === 'constraint.everyone'));
    const text = renderSeatCard(con as never, { dispatch: 'D-x' });
    const at = text.indexOf('## Instructions for this task');
    assert.ok(at > 0 && at < text.indexOf('## Project constraints'), text);
    assert.ok(text.includes('[constraint.impl-only, v1] Keep the parser free of regular expressions.'), text);
    // the other task's cards never see it
    for (const t of ['con.m1.iface.1', 'rev.m1.iface.1']) assert.equal(claimed<ConstructorCard>(ports, t).addressed, undefined, t);
    const rev = claimed<ReviewerCard>(ports, 'rev.m1.impl.1');
    assert.deepEqual(rev.addressed?.map((a) => a.id), ['constraint.impl-only']);
    // the Reviewer said "not followed" and passed: the task is accepted (an instruction is never a standard)
    const accepted = await ports.ledger.events({ mission: M, line: 'task:impl', event: 'accepted' });
    assert.equal(accepted.length, 1);
    const review = (await ports.ledger.events<{ instructions?: unknown }>({ mission: M, line: 'task:impl', event: 'review' })).at(-1)?.body;
    assert.deepEqual(review?.instructions, [{ instruction: 'constraint.impl-only', response: 'not-followed', reason: 'checked against the candidate' }]);
    // and the read shows its author, address, reach and the Reviewer's answer
    const r = ports.memory.read((db) => constraintsRead(db, ports.memory.data, 'm1', true));
    const c = r.constraints.find((x) => x.id === 'constraint.impl-only')!;
    assert.equal(c.author, 'pm');
    assert.deepEqual(c.address, { tasks: ['impl'], repairs: [] });
    assert.deepEqual(c.reach?.tasks, ['impl']);
    assert.deepEqual(c.answers?.map((a) => [a.task, a.response]), [['impl', 'not-followed']]);
    const out = constraintsText(r, true);
    assert.ok(out.includes("[constraint.impl-only] instruction, the PM's, addressed to task impl: Keep the parser free"), out);
    assert.ok(out.includes('reaches the cards of 1 task (impl)') && out.includes('the Reviewer of impl (rev.m1.impl.1): not-followed'), out);
    assert.ok(out.includes('reaches the cards of 2 tasks (iface, impl)'), 'an unaddressed "**" instruction reaches every task');
  });

  it('a Reviewer hand-back that leaves an addressed instruction unanswered is refused with the reason', async () => {
    const { ports, engine } = await setup();
    await instruction(ports, 'impl-only', 'No regular expressions.', { tasks: ['impl'], mission: 'm1' });
    await drive(engine, ports.scheduler, withKinds({ reviewer: (t) => (t.task === 'rev.m1.impl.1' ? null : { handBack: reviewer(t.card as never, 'pass') }) }));
    const card = ports.scheduler.card<ReviewerCard>('rev.m1.impl.1');
    const { instruction_responses: _drop, ...silent } = reviewer(card, 'pass');
    const problems = await ports.scheduler.run('rev.m1.impl.1', { handBack: silent });
    assert.deepEqual(problems, ['instruction_responses: instruction "constraint.impl-only" is not answered (followed, not-followed or unclear, with a reason)']);
    assert.deepEqual(await ports.scheduler.run('rev.m1.impl.1', { handBack: reviewer(card, 'pass', { instructions: 'unclear' }) }), []);
  });

  it('an instruction addressed after a step was queued reaches the card at its claim (a card queued earlier, or by 4.3, gets it there)', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds({ constructor: () => null }));
    assert.equal(ports.scheduler.card<ConstructorCard>('con.m1.iface.1').addressed, undefined, 'queued before the instruction');
    await instruction(ports, 'iface-late', 'Name the interface Parser, nothing else.', { tasks: ['iface'], mission: 'm1' });
    await drive(engine, ports.scheduler, happyScript(M));
    assert.deepEqual(claimed<ConstructorCard>(ports, 'con.m1.iface.1').addressed?.map((a) => a.id), ['constraint.iface-late']);
  });

  it('refused without a mission, and on an object constraint (new flags); nothing is recorded', async () => {
    const { ports } = await setup();
    await assert.rejects(instruction(ports, 'no-mission', 'x', { tasks: ['impl'] }), /names tasks or repairs of one mission.*give --mission/);
    await assert.rejects(pmConstraint(ports.ctx, { mission: 'project', constraint: 'obj', kind: 'object', text: 'x', scope: { paths: ['**'], taskTypes: [], tasks: ['impl'] }, missionScope: 'm1' }), /is for an instruction/);
    assert.equal((await ports.ledger.events({ mission: 'project' as MissionId, line: 'requirements', event: 'constraint' })).length, 0);
  });

  it('mp pm constraint scope addresses an existing instruction with no new version (one constraint-scope event); the same address again writes nothing', async () => {
    const { ports } = await setup();
    const v = (await instruction(ports, 'later', 'Prefer small functions.')).version;
    const scoped = await pmConstraintScope(ports.ctx, { constraint: 'later', tasks: ['impl'], mission: 'm1' });
    assert.equal(scoped.version, v, 'the version is kept');
    assert.equal(scoped.scopeChanged, true);
    assert.deepEqual(scoped.scope, { paths: ['**'], taskTypes: [], mission: 'm1', tasks: ['impl'] });
    const events = async () => (await ports.ledger.events({ mission: 'm1' as MissionId, line: 'requirements', event: 'constraint-scope' })).length;
    assert.equal(await events(), 1);
    assert.equal((await pmConstraintScope(ports.ctx, { constraint: 'later', tasks: ['impl'] })).scopeChanged, false);
    assert.equal(await events(), 1, 'nothing written');
    await assert.rejects(pmConstraintScope(ports.ctx, { constraint: 'later', tasks: ['impl'], mission: 'm2' }), /scoped to mission m1/);
  });

  it('a scope change of a version another writer replaced meanwhile is refused: the old text is never written back', async () => {
    const { ports } = await setup();
    const v1 = (await instruction(ports, 'moving', 'Prefer small functions.')).version;
    await instruction(ports, 'moving', 'Prefer small, pure functions.');
    await assert.rejects(recordConstraint(ports, { mission: M, constraint: 'moving', kind: 'instruction', text: 'Prefer small functions.', scope: { mission: 'm1', paths: ['**'], taskTypes: [], tasks: ['impl'] }, expect: v1 }), /has a new version since it was read/);
    const r = ports.memory.read((db) => constraintsRead(db, ports.memory.data, 'm1', false)).constraints.find((c) => c.id === 'constraint.moving');
    assert.equal(r?.first, 'Prefer small, pure functions.');
    assert.equal(r?.address, null);
  });
});

describe('4.4 G3: the author of a constraint, and layer 1', () => {
  it('a constraint recorded without an author (4.3, or the PM) reads as the PM\'s; the Secretary\'s reads as its own; layer 1 lists only the PM\'s unaddressed ones', async () => {
    const { ports } = await setup();
    await recordConstraint(ports, { mission: M, constraint: 'pm-rule', kind: 'instruction', text: 'Run the linter before handing back.', scope: { paths: ['**'], taskTypes: [] } });
    await recordConstraint(ports, { mission: M, constraint: 'sec-rule', kind: 'instruction', text: 'Use the fixtures folder for samples.', scope: { mission: 'm1', paths: ['**'], taskTypes: [] }, author: 'secretary' });
    await recordConstraint(ports, { mission: M, constraint: 'to-impl', kind: 'instruction', text: 'Stream the input.', scope: { mission: 'm1', paths: ['**'], taskTypes: [], tasks: ['impl'] } });
    const body = (await ports.ledger.events<Record<string, unknown>>({ mission: M, line: 'requirements', event: 'constraint' })).find((e) => e.key.startsWith('constraint.pm-rule'))!.body;
    assert.equal('author' in body, false, 'the PM\'s payload is 4.3\'s');
    const r = ports.memory.read((db) => constraintsRead(db, ports.memory.data, 'm1', false));
    assert.deepEqual(r.constraints.map((c) => [c.id, c.author]), [['constraint.pm-rule', 'pm'], ['constraint.sec-rule', 'secretary'], ['constraint.to-impl', 'pm']]);
    const layer1 = pmLayer1(ports.ctx);
    assert.ok(layer1.includes('[constraint.pm-rule]'), layer1);
    assert.ok(!layer1.includes('[constraint.sec-rule]') && !layer1.includes('[constraint.to-impl]'), layer1);
  });
});

describe('4.4 G3: a decision item may name its tasks', () => {
  it('printed on the named task\'s cards only; a decision that names none is printed as 4.3 printed it', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds({ constructor: () => null }));
    // recorded after the plan took effect: 4.3 printed such a decision on every card
    await pmRequirement(ports.ctx, { mission: M, item: 'd-iface', type: 'decision', text: 'The interface returns rows as arrays', authorization: 'a1', tasks: ['iface'] });
    await pmRequirement(ports.ctx, { mission: M, item: 'd-all', type: 'decision', text: 'Use LF line endings', authorization: 'a1' });
    await drive(engine, ports.scheduler, happyScript(M));
    const iface = claimed<ConstructorCard>(ports, 'con.m1.iface.1').decisionQuotes;
    const impl = claimed<ConstructorCard>(ports, 'con.m1.impl.1').decisionQuotes;
    assert.ok(iface.includes('The interface returns rows as arrays'), iface.join(' | '));
    assert.ok(!impl.some((q) => q.includes('rows as arrays')), impl.join(' | '));
    assert.ok(impl.includes('Use LF line endings (recorded after the plan)') && iface.includes('Use LF line endings (recorded after the plan)'));
    const body = (await ports.ledger.events<Record<string, unknown>>({ mission: M, line: 'requirements', event: 'item' })).find((e) => e.key.startsWith('item.m1.d-all'))!.body;
    assert.equal('tasks' in body, false, 'a decision without --tasks writes the 4.3 payload');
    await assert.rejects(pmRequirement(ports.ctx, { mission: M, item: 'g9', type: 'goal', text: 'x', authorization: 'a1', tasks: ['iface'] }), /--tasks goes with --type decision/);
  });
});

describe('4.4 G3 (F1): the plan reviews and the Architect\'s cards', () => {
  it('Calibrator ① gets the instructions naming "pm-plan", Calibrator ② and the feasibility review those naming "detailed-plan"; no task card gets either', async () => {
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    await instruction(ports, 'for-cal1', 'Read the plan against the words first.', { taskTypes: ['pm-plan'] });
    await instruction(ports, 'for-dplan', 'Check the write scopes do not overlap.', { taskTypes: ['detailed-plan'] });
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
    const engine = new FlowEngine(ports);
    const plan = detailedPlan(M);
    await drive(engine, ports.scheduler, (t, s) => happyScript(M, () => plan)(t, s));
    const ids = (cs: ReadonlyArray<{ id: string }>) => cs.map((c) => c.id);
    assert.deepEqual(ids(claimed<Calibrator1Card>(ports, 'cal1.m1.1').constraints), ['constraint.for-cal1']);
    assert.deepEqual(ids(claimed<Calibrator2Card>(ports, 'cal2.dplan.m1.1.1').constraints), ['constraint.for-dplan']);
    const feas = [...ports.scheduler.tasks.keys()].find((t) => t.startsWith('feas.'));
    if (feas !== undefined) assert.deepEqual(ids(claimed<ArchitectFeasibilityCard>(ports, feas).constraints), ['constraint.for-dplan']);
    for (const t of ['con.m1.iface.1', 'con.m1.impl.1']) assert.deepEqual(ids(claimed<ConstructorCard>(ports, t).constraints), [], t);
  });

  it('the decomposition card keeps unaddressed constraints in full and indexes the addressed ones', async () => {
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    await instruction(ports, 'plain', 'Prefer the standard library.');
    await instruction(ports, 'for-impl', 'The implementation streams its input and never loads a whole file.', { tasks: ['impl'], mission: 'm1' });
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
    await drive(new FlowEngine(ports), ports.scheduler, happyScript(M));
    const arch = claimed<ArchitectDecomposeCard>(ports, 'arch.m1.1.1');
    assert.deepEqual(arch.constraints.map((c) => c.id), ['constraint.plain']);
    assert.deepEqual(arch.addressedIndex?.map((x) => [x.id, x.to]), [['constraint.for-impl', 'task impl']]);
    const text = 'The implementation streams its input and never loads a whole file.';
    const rendered = renderSeatCard(arch as never, { dispatch: 'D-x' });
    assert.ok(rendered.includes(`[constraint.for-impl, v1] for task impl: ${text} (${Buffer.byteLength(text)} bytes)`), rendered);
  });
});
