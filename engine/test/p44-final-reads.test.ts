// 4.4, the final review (F1-4, F3-1, F3-2, F3-3, the reads' part): a read credits a repair, a filing or a requirement
// item only with the attempt that carried it, and takes the acceptance, the risk, the proof and the delivery from that
// attempt's product. Once that attempt is accepted the part is done for good, whatever later attempts do; an
// acceptance of an attempt whose card did not carry it never counts; an acceptance is matched to the card its attempt
// ran under, never to the order of writes; a reopen of 4.3 counts only an attempt whose card carried its issue.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson } from '../src/common/hash.ts';
import type { ContentHash, MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { planInEffect, submitPmBatch } from '../src/flow/planning.ts';
import type { DetailedPlanDoc, DetailedTask } from '../src/flow/plandoc.ts';
import { detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import type { EscalationBody } from '../src/flow/secretary.ts';
import { appendRecords } from '../src/memory/index.ts';
import { pmRepair } from '../src/process/pm.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import '../src/seat/cards/index.ts';
import { repairsRead } from '../src/cli/workReads.ts';
import { readItems } from '../src/cli/itemsRead.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;

async function setup(): Promise<{ ports: World; engine: FlowEngine }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  const engine = new FlowEngine(ports);
  await drive(engine, ports.scheduler, happyScript(M));
  return { ports, engine };
}
const repair = (ports: World, id: string) => ports.memory.read((db) => repairsRead(db, ports.memory.data, 'm1')).repairs.find((r) => r.id === id)!;
const events = <B = any>(ports: World, line: string, event: string) => ports.ledger.events<B>({ mission: M, line, event });
const PLAN2 = () => pmPlan(M, { elements: [pmPlan(M).elements[0]!, { ...pmPlan(M).elements[1]!, text: 'Covered by unit tests only' }] });
const JSON_TASK: DetailedTask = {
  id: 'json', kind: 'implementation', module: 'parser', goal: 'Export rows as JSON', standards: [{ id: 'S1', text: 'Rows export as JSON' }], requirementItems: [],
  writeScope: ['src/parser/json.ts'], readableFiles: [], interpreter: 'node', verificationCommands: [{ id: 'test', command: 'npm test' }], implements: [], calls: [],
  dependsOn: ['impl'], exclusive: [], estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'small' }, provenance: 'architect',
};
async function file(ports: World, text: string, about = 'impl'): Promise<string> {
  return (await pmRepair(ports.ctx, { mission: M, words: say(ports, `Trying it: the output ${text}.`), kind: 'defect', text, about })).repair;
}
const architect = (handBack: unknown): Script => (t, s) => (t.card.seat === 'architect-repair' ? { handBack } : happyScript(M)(t, s));
/** A re-plan of the mission whose detailed plan gives `task` another card (the plan's tasks, and `extra` after them). */
async function replan(ports: World, engine: FlowEngine, change: (t: DetailedTask) => DetailedTask, extra: readonly DetailedTask[] = [], hold: (task: string) => boolean = () => false): Promise<void> {
  const plan = (): DetailedPlanDoc => ({ ...detailedPlan(M), tasks: [...detailedPlan(M).tasks, ...extra].map(change) });
  await submitPmBatch(ports, { mission: M, plan: PLAN2(), userWords: ['W-1'] });
  await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' || hold(t.task) ? null : happyScript(M, plan)(t, s)));
}
const newGoal = (id: string) => (t: DetailedTask): DetailedTask => (t.id === id ? { ...t, goal: `${t.goal}, read as a stream`, standards: [{ id: 'S9', text: 'It reads its input as a stream' }] } : t);

describe('final review: a repair is credited with the attempt that carried it, and for good', () => {
  it('F1-4 (done stays done): a reopen carried and accepted at attempt 2 stays done while another repair\'s reopen keeps attempt 3 open', async () => {
    const { ports, engine } = await setup();
    await file(ports, 'loses the header row');
    await drive(engine, ports.scheduler, architect({ reopen: [{ task: 'impl', issue: 'keep the header row' }], add: [], note: 'impl writes the rows.' }));
    assert.equal(repair(ports, 'R-1').done, true);
    await file(ports, 'drops the last line');
    await drive(engine, ports.scheduler, (t, s) => (t.task === 'con.m1.impl.3' ? null : architect({ reopen: [{ task: 'impl', issue: 'keep the last line' }], add: [], note: 'the last line.' })(t, s)));
    assert.ok(ports.scheduler.queued().some((t) => t.task === 'con.m1.impl.3'), 'attempt 3 is open');
    const r = repair(ports, 'R-1');
    assert.equal(r.done, true, 'done for good');
    assert.deepEqual(r.reopened[0]?.credited, { attempt: 2, product: 'prod.con.m1.impl.2', risk: null });
    assert.equal(r.reopened[0]?.state, 'reopened at attempt 2; accepted at attempt 2 (prod.con.m1.impl.2); attempt 3 in work');
  });

  it('F1-4, F3-3 (an unrelated acceptance does not count): the reopened attempt claimed, its card replaced by a re-plan before its hand-back, the new card accepted: not done, superseded by the plan', async () => {
    const { ports, engine } = await setup();
    await file(ports, 'loses the header row');
    await drive(engine, ports.scheduler, (t, s) => (t.task === 'con.m1.impl.2' ? null : architect({ reopen: [{ task: 'impl', issue: 'keep the header row' }], add: [], note: 'impl writes the rows.' })(t, s)));
    ports.scheduler.dispatchOf('con.m1.impl.2');
    await replan(ports, engine, newGoal('impl'));
    assert.ok((await events<{ k: number }>(ports, 'task:impl', 'accepted')).some((e) => e.body.k === 3), 'the re-planned card is accepted');
    const r = repair(ports, 'R-1');
    assert.equal(r.done, false);
    assert.equal(r.reopened[0]?.superseded, 'a later plan');
    assert.equal(r.reopened[0]?.credited, undefined);
    assert.match(r.reopened[0]!.state, /^reopened at attempt 2; superseded before it was accepted, by a later plan; accepted at attempt 3 /);
  });

  it('F3-3 (4.3): a reopen whose loop was used up and that nothing carried, then an unrelated re-planned card accepted: what became of it is not recorded, never done', async () => {
    const { ports, engine } = await setup();
    await file(ports, 'loses the header row');
    // 4.3 decided it: no `tracked`, and its reopen met a used-up loop (the loop's verdict, not proceeding)
    type Entries = { events?: Array<{ event: string; body: unknown }> };
    const l = ports.ledger as unknown as { append: (op: string, entries: Entries) => Promise<void> };
    const orig = l.append.bind(l);
    l.append = async (op, entries) => {
      if (op !== `flow:repair-decided:${M}:R-1`) return orig(op, entries);
      const evs = (entries.events ?? []).map((e) => { if (e.event !== 'decided') return e; const { tracked: _t, ...body } = e.body as Record<string, unknown>; return { ...e, body }; });
      return orig(op, { ...entries, events: [...evs, { mission: M, line: 'task:impl', event: 'loop-verdict', key: 'reopen:repair:R-1', body: { proceed: false, attempts: 2, allowed: 2, reason: 'cap' } }] } as Entries);
    };
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'secretary' ? null : architect({ reopen: [{ task: 'impl', issue: 'keep the header row' }], add: [], note: 'impl writes the rows.' })(t, s)));
    l.append = orig;
    assert.equal((await events(ports, 'task:impl', 'rework')).filter((e) => (e.body as { reopen?: unknown }).reopen !== undefined).length, 0, 'no attempt carried its issue');
    await replan(ports, engine, newGoal('impl'));
    assert.ok((await events<{ k: number }>(ports, 'task:impl', 'accepted')).some((e) => e.body.k > 1), 'an unrelated card accepted');
    const r = repair(ports, 'R-1');
    assert.equal(r.done, false);
    assert.equal(r.reopened[0]?.notRecorded, true);
    assert.match(r.reopened[0]!.state, /^decided under 4\.3: what became of this reopen is not recorded; accepted at attempt [2-9] /);
  });

  it('F3-2: an acceptance of attempt 1 committed after another process laid a repair\'s card for attempt 2 does not credit that repair', async () => {
    const { ports, engine } = await setup();
    await pmRepair(ports.ctx, { mission: M, words: say(ports, 'It should export JSON too.'), kind: 'missing', text: 'export JSON too' });
    await drive(engine, ports.scheduler, (t, s) => (t.task === 'rev.m1.json.1' ? null : architect({ reopen: [], add: [JSON_TASK], note: 'json' })(t, s)));
    assert.ok((await events(ports, 'task:json', 'product')).length > 0, 'attempt 1 handed back; its review is not recorded yet');
    // another process: R-2 changes the card, its spec and the rework for attempt 2 are written
    await file(ports, 'writes the JSON slowly', 'json');
    await drive(engine, ports.scheduler, (t, s) => (t.task.startsWith('con.m1.json.') || t.task.startsWith('rev.m1.json.') ? null : architect({ reopen: [], add: [], change: [{ ...JSON_TASK, goal: 'Export rows as JSON, fast' }], note: 'faster' })(t, s)));
    const specs = await events<{ repair?: string }>(ports, 'task:json', 'spec');
    assert.equal(specs.at(-1)?.body.repair, 'R-2');
    // the pass that read attempt 1's passing review commits its acceptance now
    ports.memory.write({}, (tx) => appendRecords(tx, [{ kind: 'flow.event', mission: M, line: 'task:json', event: 'accepted', key: '1', body: tx.data.put(canonicalJson({ k: 1, product: 'prod.con.m1.json.1', judgment: 'j.rev.m1.json.1' })) as ContentHash }]));
    const r2 = repair(ports, 'R-2');
    assert.equal(r2.changed[0]?.done, false, 'attempt 2 has not run R-2\'s card');
    assert.equal(r2.changed[0]?.credited, undefined);
    assert.equal(r2.done, false);
  });

  it('F3-1: a repair whose card was accepted with risk at attempt 2, then re-planned and passed at attempt 3, reads accepted with risk, with its open risk and attempt 2\'s product and proof', async () => {
    const { ports, engine } = await setup();
    await pmRepair(ports.ctx, { mission: M, words: say(ports, 'It should export JSON too.'), kind: 'missing', text: 'export JSON too' });
    await drive(engine, ports.scheduler, (t, s) => (t.task.startsWith('con.m1.json.') ? null : architect({ reopen: [], add: [JSON_TASK], note: 'json' })(t, s)));
    await file(ports, 'writes the JSON slowly', 'json');
    const changed: DetailedTask = { ...JSON_TASK, goal: 'Export rows as JSON, fast', standards: [{ id: 'S1', text: 'Rows export as JSON' }, { id: 'S2', text: 'A million rows export in a second' }] };
    await drive(engine, ports.scheduler, (t, s) => {
      if (t.card.seat === 'architect-repair') return { handBack: { reopen: [], add: [], change: [changed], note: 'faster' } };
      if (t.task === 'rev.m1.json.2') return { handBack: reviewer(t.card as never, 'needs-decision', { failing: 'S2' }) };
      if (t.card.seat === 'secretary') { const c = t.card as unknown as SecretaryCard; return c.options.some((o) => o.id === 'accept-risk') ? { handBack: secretary(c, 'accept-risk') } : null; }
      return happyScript(M)(t, s);
    });
    const acc2 = (await events<{ k: number; decision?: { option?: string } }>(ports, 'task:json', 'accepted')).find((e) => e.body.k === 2);
    assert.equal(acc2?.body.decision?.option, 'accept-risk', 'attempt 2 accepted with its risk');
    // a re-plan with the failed standard removed; attempt 3 passes
    const card = (await planInEffect(flowCtx(ports, M)))!.plan.tasks.find((t) => t.id === 'json')!;
    await replan(ports, engine, (t) => (t.id === 'json' ? { ...t, standards: [{ id: 'S1', text: 'Rows export as JSON' }] } : t), [card]);
    assert.ok((await events<{ k: number }>(ports, 'task:json', 'accepted')).some((e) => e.body.k === 3), 'attempt 3 passed');
    const r2 = repair(ports, 'R-2');
    assert.deepEqual([r2.done, r2.changed[0]?.credited?.attempt, r2.changed[0]?.credited?.product], [true, 2, 'prod.con.m1.json.2']);
    assert.ok(r2.changed[0]?.credited?.risk !== null, 'with the escalation it was accepted on');
    const row = readItems(ports.ctx, 'm1').find((x) => x.id === 'R-2')!;
    assert.equal(row.state, 'accepted with risk');
    assert.ok(row.open >= 1, `its open risk stays on its row: ${row.open}`);
    assert.deepEqual(row.tasks.map((t) => [t.task, t.product, t.attempt]), [['json', 'prod.con.m1.json.2', 2]]);
    const label = (await ports.evaluator.labels(['prod.con.m1.json.2'])).labels['prod.con.m1.json.2'];
    assert.equal(row.proof, label, 'the proof of attempt 2\'s product, never attempt 3\'s');
  });
});

void (null as unknown as EscalationBody);

describe('closing confirmation: an acceptance before a repair\'s decision is never that repair\'s', () => {
  it('C-3: R-1 adds json, accepted at attempt 1; a re-plan drops it; R-2 adds the identical card again, attempt 2 queued: R-2 is not done and claims no product, R-1 stays done with attempt 1', async () => {
    const { ports, engine } = await setup();
    await pmRepair(ports.ctx, { mission: M, words: say(ports, 'It should export JSON too.'), kind: 'missing', text: 'export JSON too' });
    await drive(engine, ports.scheduler, architect({ reopen: [], add: [JSON_TASK], note: 'json' }));
    assert.ok((await events<{ k: number }>(ports, 'task:json', 'accepted')).some((e) => e.body.k === 1), 'attempt 1 accepted');
    await replan(ports, engine, (t) => t);
    assert.ok((await events(ports, 'task:json', 'dropped')).length > 0, 'the drop is recorded');
    await pmRepair(ports.ctx, { mission: M, words: say(ports, 'Bring the JSON export back.'), kind: 'missing', text: 'Bring the JSON export back' });
    await drive(engine, ports.scheduler, (t, s) => (t.task.startsWith('con.m1.json.') ? null : architect({ reopen: [], add: [JSON_TASK], note: 'json again' })(t, s)));
    assert.ok(ports.scheduler.queued().some((t) => t.task === 'con.m1.json.2'), 'attempt 2 queued');
    const r2 = repair(ports, 'R-2');
    assert.deepEqual([r2.done, r2.added[0]?.done, r2.added[0]?.credited, r2.added[0]?.superseded], [false, false, undefined, undefined]);
    assert.match(r2.added[0]!.state, /^attempt 2 in work/);
    const r1 = repair(ports, 'R-1');
    assert.deepEqual([r1.done, r1.added[0]?.credited?.attempt, r1.added[0]?.credited?.product], [true, 1, 'prod.con.m1.json.1']);
    const row = readItems(ports.ctx, 'm1').find((x) => x.id === 'R-2')!;
    assert.equal(row.proof, null, 'no proof of attempt 1\'s product');
    assert.ok(!['accepted after a passing review', 'accepted with risk', 'delivered', 'landed'].includes(row.state), row.state);
  });
});
