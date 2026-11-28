// 4.4 package p6, from the final review of the release: what reaches the cards of a repair's tasks, at the claim.
//   F3-6  a task a repair added keeps the repair, its Architect's note and the instructions addressed to it on its
//         cards when a later plan in effect keeps its card (that plan carries no amendment): the repair is found from
//         the history of plans in effect by the task's id and card hash (plandoc.ts cardAmendments, the one
//         resolution the gate of a repair's reopen and a filing's items use), at queue time and at the claim
//   F1-3  a step 4.3 queued for an attempt a grant gave a repair's reopen (its cards then carried no such line) gets,
//         at the claim, the reopen's issue, the repair, its note and the instructions addressed to it: the Reviewer
//         of a task with no Constructor, and a Constructor

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { taskLineage } from '../src/flow/execution.ts';
import { planInEffect, submitPmBatch } from '../src/flow/planning.ts';
import type { DetailedPlanDoc, DetailedTask } from '../src/flow/plandoc.ts';
import type { FlowTask } from '../src/flow/ports.ts';
import { recordItem } from '../src/flow/requirements.ts';
import { answerEscalation, type EscalationBody } from '../src/flow/secretary.ts';
import { constructorDone, detailedPlan, drive, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { listDispatches } from '../src/memory/index.ts';
import { pmConstraint, pmRepair } from '../src/process/pm.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { ConstructorCard, ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
const SCOPE = { paths: ['**'], taskTypes: [] };
const FROM = "repair R-1, the Architect's note on its decision";

function claimed<C>(ports: World, task: string): C {
  const d = ports.memory.read((db) => listDispatches(db, { task, limit: 100 })).at(-1);
  if (d === undefined) throw new Error(`no dispatch of ${task}`);
  return dispatchView(ports.ctx, d.dispatch).card as unknown as C;
}

/** Each listed step queued as 4.3 queued it: no repairs, notes, addressed instructions or answers, and `strip` taken out of its duties. */
function queuedAs43(ports: World, steps: readonly string[], strip: (duties: string) => string): () => void {
  const submit = ports.scheduler.submit.bind(ports.scheduler);
  ports.scheduler.submit = async (t: FlowTask) => {
    if (!steps.includes(t.task)) return submit(t);
    const card = { ...t.card } as Record<string, unknown>;
    for (const k of ['repairs', 'architectNotes', 'addressed', 'earlierAnswers']) delete card[k];
    card['duties'] = strip(String(card['duties']));
    return submit({ ...t, card: card as FlowTask['card'] });
  };
  return () => { ports.scheduler.submit = submit; };
}

/** 4.3 decides `repair`: its decision has no `tracked`, and its reopen of `task` is counted on the task's used-up loop in the same write. */
function decidedBy43(ports: World, repair: string, task: string): () => void {
  type Entries = { events?: Array<{ event: string; body: unknown }> };
  const l = ports.ledger as unknown as { append: (op: string, entries: Entries) => Promise<void> };
  const orig = l.append.bind(l);
  l.append = async (op, entries) => {
    if (op !== `flow:repair-decided:${M}:${repair}`) return orig(op, entries);
    const events = (entries.events ?? []).map((e) => { if (e.event !== 'decided') return e; const { tracked: _t, ...body } = e.body as Record<string, unknown>; return { ...e, body }; });
    return orig(op, { ...entries, events: [...events, { mission: M, line: `task:${task}`, event: 'loop-verdict', key: `reopen:repair:${repair}`, body: { proceed: false, attempts: 2, allowed: 2, reason: 'cap' } }] } as Entries);
  };
  return () => { l.append = orig; };
}

const HDR: DetailedTask = {
  id: 'hdr', kind: 'implementation', module: 'parser', goal: 'Keep the header row', standards: [{ id: 'S1', text: 'The header row is kept' }], requirementItems: [],
  writeScope: ['src/parser/header.ts'], readableFiles: [], interpreter: 'node', verificationCommands: [{ id: 'test', command: 'npm test' }], implements: [], calls: [],
  dependsOn: ['impl'], exclusive: [], estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'small' }, provenance: 'architect',
};

describe('F3-6: a later plan that keeps the card of a task a repair added', () => {
  it('the claim\'s cards (and the cards queued under the new plan) still carry the repair, its note and the instruction addressed to it', async () => {
    let replanned = false;
    const plan = (): DetailedPlanDoc => { const p = detailedPlan(M); return replanned ? { ...p, tasks: [...p.tasks, HDR] } : p; };
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'] });
    const engine = new FlowEngine(ports);
    const script = (over: Record<string, Script> = {}): Script => (t, s) => (Object.hasOwn(over, t.task) ? over[t.task]! : Object.hasOwn(over, t.card.seat) ? over[t.card.seat]! : happyScript(M, plan))(t, s);
    await drive(engine, ports.scheduler, script());
    const w2 = say(ports, 'Trying it: the output loses the header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'defect', text: 'the output loses the header row', about: 'impl' });
    await pmConstraint(ports.ctx, { mission: 'project', constraint: 'for-r1', kind: 'instruction', text: 'A repair of the header touches the header code only.', scope: { ...SCOPE, repairs: ['R-1'] }, missionScope: 'm1' });
    // R-1 adds hdr, with a note; hdr's Constructor waits
    await drive(engine, ports.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [], add: [HDR], note: 'hdr owns the header row.' } }), 'con.m1.hdr.1': () => null }));
    // a new plan takes effect and keeps hdr's card: it carries no amendment
    replanned = true;
    const words = say(ports, 'Once it has parsed a file, keep the parser read-only.');
    await recordItem(ports, { mission: M, item: 'd1', type: 'decision', text: 'The parser is read-only once it has parsed a file', source: { kind: 'words', words, quote: 'keep the parser read-only' } });
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'A CSV parser library, read-only once it has parsed a file', items: ['g1', 'd1'] }, pmPlan(M).elements[1]!] }), userWords: [words], changedItems: ['d1'] });
    await drive(engine, ports.scheduler, script({ 'con.m1.hdr.1': () => null }));
    const pie = await planInEffect(flowCtx(ports, M));
    assert.deepEqual([pie?.eff.dplan, pie?.eff.amendments ?? []], ['dplan.m1.2.1', []]);
    assert.equal((await ports.ledger.events({ mission: M, line: 'task:hdr', event: 'spec' })).length, 1, 'hdr keeps its card: no new spec');
    const expect = (c: ConstructorCard | ReviewerCard, who: string): void => {
      assert.deepEqual(c.repairs?.map((r) => r.id), ['R-1'], who);
      assert.deepEqual(c.architectNotes, [{ from: FROM, text: 'hdr owns the header row.' }], who);
      assert.deepEqual(c.addressed?.map((a) => a.id), ['constraint.for-r1'], who);
    };
    ports.scheduler.dispatchOf('con.m1.hdr.1');
    expect(claimed<ConstructorCard>(ports, 'con.m1.hdr.1'), 'the Constructor claimed under the new plan');
    assert.deepEqual(await ports.scheduler.run('con.m1.hdr.1', { handBack: constructorDone() }), []);
    await drive(engine, ports.scheduler, script({ 'rev.m1.hdr.1': () => null }));
    expect(ports.scheduler.card<ReviewerCard>('rev.m1.hdr.1'), 'the Reviewer queued under the new plan');
    ports.scheduler.dispatchOf('rev.m1.hdr.1');
    expect(claimed<ReviewerCard>(ports, 'rev.m1.hdr.1'), 'the Reviewer claimed');
  });
});

describe('F1-3: a step 4.3 queued for an attempt a grant gave a repair\'s reopen gets the reopen at the claim', () => {
  it('the Reviewer of a task with no Constructor: the reopen\'s issue, the repair, its note and the instruction addressed to it', async () => {
    const plan = (): DetailedPlanDoc => { const p = detailedPlan(M); return { ...p, tasks: [...p.tasks, { ...p.tasks[1]!, id: 'integ', kind: 'integration' as const, module: null, writeScope: [], implements: [], calls: [], dependsOn: ['impl'], provenance: { planElements: ['e1', 'e2'] } }] }; };
    const issue = 'compare the header rows of both parsers';
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
    const engine = new FlowEngine(ports);
    const script = (over: Record<string, Script> = {}): Script => (t, s) => (Object.hasOwn(over, t.card.seat) ? over[t.card.seat]! : happyScript(M, plan))(t, s);
    await drive(engine, ports.scheduler, script());
    for (const n of [1, 2]) await ports.ledger.loopAttempt({ op: `test:integ-rework:${n}`, lineage: taskLineage(M, 'integ'), loop: 'rework', signature: `used-${n}` });
    const w2 = say(ports, 'The combined output loses a header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'defect', text: 'The combined output loses a header row', about: 'integ' });
    await pmConstraint(ports.ctx, { mission: 'project', constraint: 'for-r1', kind: 'instruction', text: 'Compare the parsers on files with a header only.', scope: { ...SCOPE, repairs: ['R-1'] }, missionScope: 'm1' });
    const restore = decidedBy43(ports, 'R-1', 'integ');
    await drive(engine, ports.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [{ task: 'integ', issue }], add: [], note: 'integ judges the combination.' } }), secretary: () => null }));
    restore();
    const exh = (await ports.ledger.events<EscalationBody>({ mission: M, line: 'secretary', event: 'escalation' })).map((e) => e.body).find((e) => e.source === 'loop-exhausted' && e.subject === 'task:integ')!;
    // the granted attempt's Reviewer is queued as 4.3 queued it: its duties carry no reopen
    const back = queuedAs43(ports, ['rev.m1.integ.2'], (d) => d.replace(/ This attempt was granted for a reopen[^]*?say so as a finding\./, ''));
    const w3 = say(ports, 'Grant one more attempt.');
    await answerEscalation(ports, { mission: M, escalation: exh.id, option: 'grant', grantExtra: 1, words: `Grant one more attempt. (${w3})` });
    await drive(engine, ports.scheduler, script({ reviewer: () => null }));
    back();
    const queued = ports.scheduler.card<ReviewerCard>('rev.m1.integ.2');
    assert.ok(!queued.duties.includes(issue) && queued.repairs === undefined, `queued in the 4.3 shape: ${queued.duties}`);
    ports.scheduler.dispatchOf('rev.m1.integ.2');
    const rev = claimed<ReviewerCard>(ports, 'rev.m1.integ.2');
    assert.match(rev.duties, /This attempt was granted for a reopen \(repair R-1\): compare the header rows of both parsers\. Judge whether it is fixed too/);
    assert.deepEqual(rev.repairs?.map((r) => r.id), ['R-1']);
    assert.deepEqual(rev.architectNotes, [{ from: FROM, text: 'integ judges the combination.' }]);
    assert.deepEqual(rev.addressed?.map((a) => a.id), ['constraint.for-r1']);
  });

  it('a Constructor queued without the reopen\'s issue gets it at the claim, once (a card that has it is left as it is)', async () => {
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
    const engine = new FlowEngine(ports);
    const script = (over: Record<string, Script> = {}): Script => (t, s) => (Object.hasOwn(over, t.card.seat) ? over[t.card.seat]! : happyScript(M))(t, s);
    // impl passes at its last allowed attempt (two reworks): a reopen 4.3 counted then needs a grant
    await drive(engine, ports.scheduler, script({ reviewer: (t) => ({ handBack: reviewer(t.card as never, t.task.startsWith('rev.m1.impl.') && !t.task.startsWith('rev.m1.impl.3') ? 'rework' : 'pass', { findings: [`finding at ${t.task}`] }) }), secretary: () => null }));
    const w2 = say(ports, 'The output loses the header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'loses the header row', about: 'impl' });
    const restore = decidedBy43(ports, 'R-1', 'impl');
    await drive(engine, ports.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [{ task: 'impl', issue: 'keep the header row' }], add: [], note: 'impl writes the rows.' } }), secretary: () => null }));
    restore();
    const exh = (await ports.ledger.events<EscalationBody>({ mission: M, line: 'secretary', event: 'escalation' })).map((e) => e.body).find((e) => e.source === 'loop-exhausted' && e.subject === 'task:impl')!;
    const back = queuedAs43(ports, ['con.m1.impl.4'], (d) => d.split('\n').filter((l) => !l.includes('keep the header row')).join('\n'));
    const w3 = say(ports, 'Grant one more attempt for the header.');
    await answerEscalation(ports, { mission: M, escalation: exh.id, option: 'grant', grantExtra: 1, words: `Grant one more attempt for the header. (${w3})` });
    await drive(engine, ports.scheduler, script({ constructor: () => null }));
    back();
    assert.ok(!ports.scheduler.card<ConstructorCard>('con.m1.impl.4').duties.includes('keep the header row'), 'queued without the issue');
    ports.scheduler.dispatchOf('con.m1.impl.4');
    const con = claimed<ConstructorCard>(ports, 'con.m1.impl.4');
    assert.ok(con.duties.endsWith(' This attempt was granted for a reopen (repair R-1): keep the header row. Fix it in your task\'s work too.'), con.duties);
    assert.deepEqual([con.repairs?.map((r) => r.id), con.architectNotes?.map((n) => n.text)], [['R-1'], ['impl writes the rows.']]);
  });
});
