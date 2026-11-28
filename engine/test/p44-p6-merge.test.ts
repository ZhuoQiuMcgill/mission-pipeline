// 4.4 package p6 with p7 (F13): `mp read repairs` and the cards read a repair's reopen 4.4 decided from its records
// on the repairs line (seat/cards/dynamic.ts reopenRecordState, repairReopensCarried), never from the task's card:
//   carried       a `reopen-carried` record names attempt c: done once a seat took c and the task is accepted at c or
//                 later (a re-plan that changes the card after it, or a Reviewer who carries the issue on, keeps it)
//   requested     the decision or a `reopen-pinned` record: not done; the read says which attempt it waits for
//   not carried   a `reopen-not-carried` record: not done; the read says why (also one recorded with the decision)
// A reopen 4.3 decided and counted (no record) reads what its record establishes (p44-p6-v1). A repair filed with
// --again says so.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { REOPEN_CARRIED, REOPEN_NOT_CARRIED, REOPEN_PINNED, type DetailedPlanDoc } from '../src/flow/plandoc.ts';
import { detailedPlan, drive, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { listDispatches } from '../src/memory/index.ts';
import { pmRepair } from '../src/process/pm.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { ConstructorCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import { repairsRead, repairsText } from '../src/cli/workReads.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;

async function setup(plan: () => DetailedPlanDoc = () => detailedPlan(M)): Promise<{ ports: World; engine: FlowEngine; script: (over?: Record<string, Script>) => Script }> {
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

const read = (ports: World) => ports.memory.read((db) => repairsRead(db, ports.memory.data, 'm1'));
const repair = (ports: World, id: string) => read(ports).repairs.find((r) => r.id === id)!;
const events = <B = any>(ports: World, line: string, event: string) => ports.ledger.events<B>({ mission: M, line, event });
const reopenOfImpl = (issue: string) => ({ handBack: { reopen: [{ task: 'impl', issue }], add: [], note: 'impl writes the rows.' } });
const reopenImpl = (issue: string): Script => () => reopenOfImpl(issue);

async function fileRepair(ports: World, text: string, extra: { again?: boolean; op?: string } = {}): Promise<string> {
  const words = say(ports, `Trying it: the output ${text}.`);
  return (await pmRepair(ports.ctx, { mission: M, words, kind: 'defect', text, about: 'impl', ...extra })).repair;
}

/** Repairs filed with these texts, each Architect step claimed on the cards as they are now (as in p44-repairs-flow bothClaimed). */
async function architectsClaimed(ports: World, engine: FlowEngine, ...texts: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const t of texts) ids.push(await fileRepair(ports, t));
  await engine.reconcile();
  const steps = ids.map((id) => ports.scheduler.queued('architect-repair').find((t) => (t.card as unknown as ArchitectRepairCard).repair.id === id)!.task);
  for (const s of steps) ports.scheduler.dispatchOf(s);
  return steps;
}

/**
 * 4.3 decides `repairId` (as in p44-repairs-flow): its decision has no `tracked`, and its reopen of impl is counted on
 * impl's own rework loop in the same write, proceeding (what a 4.3 memory holds; 4.4 neither marks nor counts so).
 */
function decidedBy43(ports: World, repairId: string): () => void {
  type Entries = { events?: Array<{ event: string; body: unknown }> };
  const l = ports.ledger as unknown as { append: (op: string, entries: Entries) => Promise<void> };
  const orig = l.append.bind(l);
  l.append = async (op, entries) => {
    if (op !== `flow:repair-decided:${M}:${repairId}`) return orig(op, entries);
    const evs = (entries.events ?? []).map((e) => { if (e.event !== 'decided') return e; const { tracked: _t, ...body } = e.body as Record<string, unknown>; return { ...e, body }; });
    return orig(op, { ...entries, events: [...evs, { mission: M, line: 'task:impl', event: 'loop-verdict', key: `reopen:repair:${repairId}`, body: { proceed: true, attempts: 1, allowed: 2, reason: null } }] } as Entries);
  };
  return () => { l.append = orig; };
}

describe('p6 with p7: a reopen 4.4 decided is done by its records', () => {
  it('a re-plan that changes the task\'s card after the reopened attempt was accepted leaves the repair done, and the later cards still answer it', async () => {
    let replanned = false;
    const plan = (): DetailedPlanDoc => { const p = detailedPlan(M); return replanned ? { ...p, tasks: p.tasks.map((t) => (t.id === 'impl' ? { ...t, goal: `${t.goal}, reading the input as a stream` } : t)) } : p; };
    const { ports, engine, script } = await setup(plan);
    await drive(engine, ports.scheduler, script());
    await fileRepair(ports, 'loses the header row');
    await drive(engine, ports.scheduler, script({ 'architect-repair': reopenImpl('keep the header row') }));
    assert.deepEqual((await events(ports, 'repairs', REOPEN_CARRIED)).map((e) => [e.key, e.body.attempt]), [['R-1:impl#1', 2]]);
    assert.deepEqual([repair(ports, 'R-1').reopened[0]?.state, repair(ports, 'R-1').done], ['reopened at attempt 2; accepted at attempt 2 (prod.con.m1.impl.2)', true]);
    // a re-plan gives impl another card after that acceptance: impl starts again at attempt 3 and is accepted there
    replanned = true;
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'A CSV parser library that reads its input as a stream' }, pmPlan(M).elements[1]!] }), userWords: ['W-1'] });
    await drive(engine, ports.scheduler, script());
    const rw3 = (await events(ports, 'task:impl', 'rework')).find((e) => e.key === '3');
    const lastSpec = (await events(ports, 'task:impl', 'spec')).at(-1)!;
    assert.ok(rw3 !== undefined && rw3.body.reason === 'respec' && lastSpec.revision > (await events(ports, 'repairs', REOPEN_CARRIED))[0]!.revision, 'the card changed after the reopen');
    assert.equal(await acceptedProduct(flowCtx(ports, M), 'impl'), 'prod.con.m1.impl.3');
    const r = repair(ports, 'R-1');
    // final review (F1-4, F3-1): credited with the attempt that carried the issue (2), done for good; the re-planned card's
    // acceptance (3) is said as what came later, never credited to the repair
    assert.equal(r.reopened[0]?.state, 'reopened at attempt 2; accepted at attempt 2 (prod.con.m1.impl.2); later changed by a plan; accepted at attempt 3 (prod.con.m1.impl.3)');
    assert.deepEqual(r.reopened[0]?.credited, { attempt: 2, product: 'prod.con.m1.impl.2', risk: null });
    assert.equal(r.done, true);
    // the attempt under the new card still answers the repair whose fix it holds
    assert.deepEqual(claimed<ConstructorCard>(ports, 'con.m1.impl.3').repairs?.map((x) => x.id), ['R-1']);
  });

  it('a Reviewer who carries the reopen\'s issue on to a further attempt: done once that attempt is accepted', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    await fileRepair(ports, 'loses the header row');
    await drive(engine, ports.scheduler, script({
      'architect-repair': reopenImpl('keep the header row'),
      // the reopened attempt's Reviewer finds the issue not fixed and sends it on
      'rev.m1.impl.2': (t) => ({ handBack: reviewer(t.card as never, 'rework', { findings: ['keep the header row: the header row is still lost on an empty file'] }) }),
    }));
    assert.ok(claimed<ConstructorCard>(ports, 'con.m1.impl.3').duties.includes('the header row is still lost'), 'attempt 3 carries the issue on');
    assert.equal(await acceptedProduct(flowCtx(ports, M), 'impl'), 'prod.con.m1.impl.3');
    const r = repair(ports, 'R-1');
    assert.equal(r.reopened[0]?.state, 'reopened at attempt 2; accepted at attempt 3 (prod.con.m1.impl.3)');
    assert.equal(r.done, true);
  });

  it('requested: an attempt no seat took, and a reopen pinned to an open attempt, are not done, and the read says what each waits for', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    // both repairs' Architects get their cards while impl is accepted at attempt 1
    const [s1, s2] = await architectsClaimed(ports, engine, 'loses the header row', 'drops the last row');
    assert.deepEqual(await ports.scheduler.run(s1!, reopenOfImpl('keep the header row')), []);
    await drive(engine, ports.scheduler, script({ 'con.m1.impl.2': () => null }));
    assert.deepEqual([repair(ports, 'R-1').reopened[0]?.state, repair(ports, 'R-1').done], ['the reopen opened attempt 2, which no seat has taken yet; attempt 2 in work', false]);
    assert.deepEqual(await ports.scheduler.run(s2!, reopenOfImpl('keep the last row')), []);
    await drive(engine, ports.scheduler, script({ 'con.m1.impl.2': () => null }));
    assert.deepEqual((await events(ports, 'repairs', REOPEN_PINNED)).map((e) => [e.key, e.body.attempt]), [['R-2:impl#1', 2]]);
    const r2 = repair(ports, 'R-2');
    assert.equal(r2.reopened[0]?.state, 'the reopen is not carried out yet: it waits for attempt 2 to be accepted, then opens the next attempt with its issue; attempt 2 in work');
    assert.equal(r2.done, false);
    await drive(engine, ports.scheduler, script());
    assert.deepEqual(read(ports).repairs.map((r) => [r.id, r.reopened[0]?.state, r.done]), [
      ['R-1', 'reopened at attempt 2; accepted at attempt 3 (prod.con.m1.impl.3)', true],
      ['R-2', 'reopened at attempt 3; accepted at attempt 3 (prod.con.m1.impl.3)', true],
    ]);
  });

  it('not carried out: a reopen of a task given up, recorded with the decision, is shown with its reason and the repair is not done', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    // its Architect got its card while impl was accepted; impl is given up before the decision is recorded
    const [s1] = await architectsClaimed(ports, engine, 'loses the header row');
    await ports.ledger.append('test:impl-given-up', { events: [{ mission: M, line: 'task:impl', event: 'abandoned', key: 'abandoned', body: { escalation: 'x', reason: 'given up', attempt: 1 } }] });
    assert.deepEqual(await ports.scheduler.run(s1!, reopenOfImpl('keep the header row')), []);
    await drive(engine, ports.scheduler, script());
    assert.deepEqual((await events(ports, 'repairs', 'decided'))[0]!.body.reopen, [], 'not in the decision\'s reopens');
    assert.deepEqual((await events(ports, 'repairs', REOPEN_NOT_CARRIED)).map((e) => e.key), ['R-1:impl#1']);
    const r = repair(ports, 'R-1');
    assert.deepEqual(r.reopened, [{ task: 'impl', state: 'the reopen was not carried out: the task was given up; given up', done: false, notCarried: true }]);
    assert.equal(r.done, false);
    const text = repairsText(read(ports));
    assert.ok(text.includes('\n    decided; not carried out: reopened impl\n') && text.includes('    reopened impl: the reopen was not carried out: the task was given up; given up'), text);
  });

  it('a reopen 4.3 decided and counted (no record) reads what its record establishes: reopened under 4.3 and accepted at a later attempt', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    await fileRepair(ports, 'loses the header row');
    const restore = decidedBy43(ports, 'R-1');
    await drive(engine, ports.scheduler, script({ 'architect-repair': reopenImpl('keep the header row'), 'rev.m1.impl.2': (t) => ({ handBack: reviewer(t.card as never, 'rework') }) }));
    restore();
    assert.equal((await events(ports, 'repairs', REOPEN_CARRIED)).length, 0, '4.3 ran it: no record');
    // v1 (verification on 4.3 memories): 4.3 counted it and the task was accepted later; nothing in 4.4 acts on it
    const r = repair(ports, 'R-1');
    assert.equal(r.reopened[0]?.state, 'reopened under 4.3 at attempt 2 and accepted at attempt 3 (prod.con.m1.impl.3)');
    assert.equal(r.done, true);
  });
});

describe('p6 with p7: a repair filed with --again says so', () => {
  it('the read and its text name the flag and the earlier repair it repeats', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    const words = say(ports, 'Trying it: the output loses the header row.');
    const req = { mission: M, words, kind: 'defect' as const, text: 'loses the header row', about: 'impl' };
    await pmRepair(ports.ctx, req);
    await drive(engine, ports.scheduler, script({ 'architect-repair': reopenImpl('keep the header row') }));
    assert.equal((await pmRepair(ports.ctx, { ...req, again: true, op: 'again-op' })).repair, 'R-2');
    assert.deepEqual(read(ports).repairs.map((r) => [r.id, r.filedAgain]), [['R-1', null], ['R-2', { flag: true, of: 'R-1' }]]);
    const text = repairsText(read(ports));
    assert.ok(text.includes('[R-2] defect') && text.includes('    filed again with --again: the same repair as R-1 (words, kind, text and subject)'), text);
    assert.equal(text.split('\n').filter((l) => l.includes('filed again')).length, 1, 'R-1 was not filed again');
  });
});
