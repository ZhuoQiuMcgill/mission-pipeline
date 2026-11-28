// 4.4 (G9): a new requirement's filing takes a repair's light path. One Architect step under the mechanical checks; its card
// shows the new items and, by reference, the limit and acceptance items in force; the work is bound to the item (by the
// number of the filing's items in force when the amendment is applied: one, every task it adds, changes or reopens, with no
// action of the Architect's; several, those the Architect names, only the filing's; none named: bound to none); the
// Reviewer's card shows the text of the items its judgment is bound to, and the old text after a change; an item a task
// took through a filing stays with its work, withdrawn or after an acceptance; a filing whose every item is withdrawn before
// its amendment is applied ends; one whose work was re-planned away files again; `mp pm repair --item` binds the same way.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { basisIndex, flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { planInEffect, submitPmBatch } from '../src/flow/planning.ts';
import type { DetailedPlanDoc, DetailedTask } from '../src/flow/plandoc.ts';
import { withdrawItem } from '../src/flow/requirements.ts';
import { detailedPlan, drive, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { listDispatches } from '../src/memory/index.ts';
import { pmExtend, pmRepair, pmRequirement } from '../src/process/pm.ts';
import { dispatchView } from '../src/process/seat.ts';
import { renderSeatCard, type ConstructorCard, type ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import { renderArchitectRepair, type ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import { buildGraph } from '../src/cli/tree.ts';
import { itemStateLines, readItems } from '../src/cli/itemsRead.ts';
import { listAllItems, recordVerified } from '../src/process/openItems.ts';
import { repairsRead, repairsText } from '../src/cli/workReads.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;

async function setup(mode: 'stable' | 'fast' = 'stable'): Promise<{ ports: World; engine: FlowEngine }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'], mode });
  const engine = new FlowEngine(ports);
  await drive(engine, ports.scheduler, happyScript(M));
  return { ports, engine };
}

function claimed<C>(ports: World, task: string): C {
  const d = ports.memory.read((db) => listDispatches(db, { task, limit: 100 })).at(-1);
  if (d === undefined) throw new Error(`no dispatch of ${task}`);
  return dispatchView(ports.ctx, d.dispatch).card as unknown as C;
}

const labels = async (ports: World, ids: readonly string[]): Promise<Record<string, unknown>> => (await ports.evaluator.labels(ids)).labels;
const contractOf = async (ports: World, product: string): Promise<readonly string[]> => (await ports.ledger.records(['object.version'])).map((c) => c.record).find((o) => o.object === product)?.reviews[0]?.basisLines ?? [];
const acceptedOf = async (ports: World, task: string): Promise<string | undefined> => (await ports.ledger.events<{ product: string }>({ mission: M, line: `task:${task}`, event: 'accepted' })).at(-1)?.body.product;
const current = async (ports: World, line: string): Promise<string | undefined> => (await basisIndex(flowCtx(ports, M))).current.get(line);

const JSON_TASK: DetailedTask = {
  id: 'json', kind: 'implementation', module: 'parser', goal: 'Export rows as JSON', standards: [{ id: 'S1', text: 'Rows export as JSON' }], requirementItems: [],
  writeScope: ['src/parser/json.ts'], readableFiles: [], interpreter: 'node', verificationCommands: [{ id: 'test', command: 'npm test' }], implements: [], calls: [],
  dependsOn: ['impl'], exclusive: [], estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'small' }, provenance: 'architect',
};

async function extend(ports: World, items: ReadonlyArray<{ item: string; text: string; quote: string }>, message: string) {
  const w = say(ports, message);
  return pmExtend(ports.ctx, { mission: M, items: items.map((i) => ({ ...i, type: 'goal' as const, words: w })) });
}

describe('4.4 G9: a new requirement\'s filing on the light path, its work bound to the item', () => {
  it('one item: the Architect card shows it and the limits by reference; an added task carries it with no action of the Architect\'s; its Reviewer card shows its text; a revision re-reviews it in stable mode and shows the old text; the plan keeps its proof', async () => {
    const { ports, engine } = await setup('stable');
    const r = await extend(ports, [{ item: 'g2', text: 'The parser exports rows as JSON', quote: 'export the rows as JSON' }], 'Could it also export the rows as JSON?');
    assert.equal(r.repair, 'R-1');
    let arch: ArchitectRepairCard | null = null;
    const ran = await drive(engine, ports.scheduler, (t, s) => {
      if (t.card.seat !== 'architect-repair') return happyScript(M)(t, s);
      arch = t.card as unknown as ArchitectRepairCard;
      return { handBack: { reopen: [], add: [JSON_TASK], note: 'a new task exports JSON' } };
    });
    assert.ok(arch !== null);
    const card = claimed<ArchitectRepairCard>(ports, ran.find((t) => t.startsWith('arch-repair.'))!);
    assert.equal(card.entry, 'extend');
    assert.deepEqual(card.items?.map((i) => [i.id, i.text, i.quote]), [['item.m1.g2', 'The parser exports rows as JSON', 'export the rows as JSON']]);
    assert.deepEqual(card.limits?.map((l) => l.id), ['item.m1.s1'], 'the acceptance item in force, by reference');
    const text = renderArchitectRepair(card);
    assert.ok(text.includes('## The new requirement\nR-1: what the user now wants'), text);
    assert.ok(text.includes('[item.m1.g2] (goal) The parser exports rows as JSON — the user\'s words (W-2): "export the rows as JSON"'), text);
    assert.ok(text.includes('bound to this item by itself') && text.includes('## Limits and acceptance items the user set for the mission'), text);
    assert.ok(!ran.some((t) => t.startsWith('cal1.') || t.startsWith('feas.') || t.startsWith('cal2.')), `no Calibrator, no feasibility review: ${ran.join(', ')}`);
    const pie = await planInEffect(flowCtx(ports, M));
    assert.deepEqual(pie?.plan.tasks.find((t) => t.id === 'json')?.requirementItems, ['item.m1.g2'], 'bound with no action of the Architect\'s');
    const product = (await acceptedOf(ports, 'json'))!;
    assert.ok((await contractOf(ports, product)).includes('item.m1.g2'), 'the Reviewer\'s contract binds it');
    assert.deepEqual(claimed<ConstructorCard>(ports, 'con.m1.json.1').requirementItems, [{ id: 'item.m1.g2', text: 'The parser exports rows as JSON' }]);
    const rev = claimed<ReviewerCard>(ports, 'rev.m1.json.1');
    assert.deepEqual(rev.requirementItems?.map((i) => [i.id, i.text, i.was]), [['item.m1.g2', 'The parser exports rows as JSON', undefined]]);
    assert.ok(renderSeatCard(rev as never, { dispatch: 'D-x' }).includes('## Requirement items this task carries (your judgment is bound to them'));
    // every task that carries items gets them, not only a new requirement's; the block stays small (one line an item)
    const plain = claimed<ReviewerCard>(ports, 'rev.m1.impl.1');
    assert.deepEqual(plain.requirementItems?.map((i) => i.id), ['item.m1.g1', 'item.m1.s1']);
    const { requirementItems: _items, ...without } = plain;
    void _items;
    const [after, before] = [renderSeatCard(plain as never, { dispatch: 'D-x' }).length, renderSeatCard(without as never, { dispatch: 'D-x' }).length];
    console.log(`reviewer card bytes: ${before} without the items block, ${after} with it`);
    assert.ok(after - before < 400, `${after - before} bytes`);
    assert.equal((await labels(ports, ['pmplan.m1.1', product]))['pmplan.m1.1'], 'proven');
    // the record says how the work came in: the tree's product node, and the read of repairs
    const g = buildGraph(ports.ctx, { mission: 'm1' });
    assert.match(g.nodes.get(`object:${product}`)?.checks ?? '', /its task came with new requirement R-1: it passed that filing's Architect and the mechanical checks, no plan review/);
    assert.doesNotMatch(g.nodes.get(`object:${(await acceptedOf(ports, 'impl'))!}`)?.checks ?? '', /came with/, 'a task of the plan says nothing of the kind');
    const read = repairsText(ports.memory.read((db) => repairsRead(db, ports.memory.data, 'm1')));
    assert.ok(read.includes('[R-1] new requirement (W-2): "export the rows as JSON"') && read.includes('its items: item.m1.g2; outside the set PM plan pmplan.m1.1 was checked against: item.m1.g2') && !read.includes('names no requirement item'), read);
    // the user revises the item: the bound product reads not fully proven and is reviewed again (stable); nothing else changes
    const w = say(ports, 'As JSON lines, one row per line.');
    await pmRequirement(ports.ctx, { mission: M, item: 'g2', type: 'goal', text: 'The parser exports rows as JSON lines', quote: 'As JSON lines', words: w });
    assert.deepEqual(await labels(ports, ['pmplan.m1.1', 'dplan.m1.1.1', product, (await acceptedOf(ports, 'impl'))!]), { 'pmplan.m1.1': 'proven', 'dplan.m1.1.1': 'proven', [product]: 'not-fully-proven', [(await acceptedOf(ports, 'impl'))!]: 'proven' });
    const again = await drive(engine, ports.scheduler, happyScript(M));
    const re = again.find((t) => t.startsWith('rev.m1.json.'))!;
    assert.ok(re !== undefined, `re-reviewed: ${again.join(', ')}`);
    const reCard = claimed<ReviewerCard>(ports, re);
    assert.deepEqual(reCard.requirementItems?.map((i) => [i.text, i.was]), [['The parser exports rows as JSON lines', 'The parser exports rows as JSON']], 'the old and the new text');
    assert.ok(renderSeatCard(reCard as never, { dispatch: 'D-x' }).includes('changed since this task was last judged; it read: The parser exports rows as JSON'));
    assert.equal((await labels(ports, [product]))[product], 'proven');
  });

  it('one item: a reopened task\'s new attempts are bound to it (its later attempts too: p12-3 below); fast mode flags the product after a revision', async () => {
    const { ports, engine } = await setup('fast');
    await extend(ports, [{ item: 'g2', text: 'Rows keep their order', quote: 'keep the rows in order' }], 'Please keep the rows in order.');
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [{ task: 'impl', issue: 'keep the rows in order' }], add: [], note: 'impl writes the rows' } } : happyScript(M)(t, s)));
    const decided = (await ports.ledger.events<{ reopen: Array<{ task: string; items?: string[] }> }>({ mission: M, line: 'repairs', event: 'decided' })).at(-1)?.body;
    assert.deepEqual(decided?.reopen.map((x) => [x.task, x.items]), [['impl', ['item.m1.g2']]]);
    const product = (await acceptedOf(ports, 'impl'))!;
    assert.equal(product, 'prod.con.m1.impl.2');
    assert.deepEqual(await contractOf(ports, product), [...(await contractOf(ports, 'prod.con.m1.impl.1')), 'item.m1.g2']);
    assert.deepEqual(claimed<ConstructorCard>(ports, 'con.m1.impl.2').requirementItems.map((i) => i.id), ['item.m1.g1', 'item.m1.s1', 'item.m1.g2']);
    assert.deepEqual(claimed<ReviewerCard>(ports, 'rev.m1.impl.2').requirementItems?.map((i) => i.id), ['item.m1.g1', 'item.m1.g2', 'item.m1.s1'].sort());
    const w = say(ports, 'Keep them in the order of the file.');
    await pmRequirement(ports.ctx, { mission: M, item: 'g2', type: 'goal', text: 'Rows keep the file order', quote: 'in the order of the file', words: w });
    assert.equal((await labels(ports, [product]))[product], 'not-fully-proven');
    assert.equal((await labels(ports, ['pmplan.m1.1']))['pmplan.m1.1'], 'proven');
    await engine.reconcile(M);
    assert.ok(ports.ledger.notices.some((n) => n.category === 'result-not-fully-proven' && (n.detail as { task?: string }).task === 'impl'), 'fast mode flags it');
  });

  it('several items: the Architect names on each task the items it serves; a task on which it names none is bound to none; an item not of the filing goes back to the Architect as a mechanical failure', async () => {
    const { ports, engine } = await setup('fast');
    await extend(ports, [{ item: 'g2', text: 'JSON export', quote: 'export JSON' }, { item: 'g3', text: 'Rows keep their order', quote: 'keep the order' }], 'Please export JSON and keep the order.');
    const cards: ArchitectRepairCard[] = [];
    await drive(engine, ports.scheduler, (t, s) => {
      if (t.card.seat !== 'architect-repair') return happyScript(M)(t, s);
      cards.push(t.card as unknown as ArchitectRepairCard);
      return cards.length === 1
        ? { handBack: { reopen: [{ task: 'impl', issue: 'keep the order', items: ['item.m1.g1'] }], add: [JSON_TASK], note: 'first try' } }
        : { handBack: { reopen: [{ task: 'impl', issue: 'keep the order', items: ['item.m1.g3'] }], add: [{ ...JSON_TASK, requirementItems: ['item.m1.g2'] }, { ...JSON_TASK, id: 'docs2', goal: 'Document it', writeScope: ['docs/json.md'] }], note: 'second try' } };
    });
    assert.equal(cards.length, 2, 'returned once');
    assert.deepEqual(cards[0]?.items?.map((i) => [i.id, i.withdrawn]), [['item.m1.g2', undefined], ['item.m1.g3', undefined]]);
    assert.ok(cards[1]?.revision?.mechanicalFailures.some((f) => f.includes('reopen[impl].items: "item.m1.g1" is not a requirement item of R-1 in force')), JSON.stringify(cards[1]?.revision));
    assert.ok(renderArchitectRepair(cards[0]!).includes('Name on each task the items it serves'));
    const pie = await planInEffect(flowCtx(ports, M));
    assert.deepEqual(pie?.plan.tasks.find((t) => t.id === 'json')?.requirementItems, ['item.m1.g2']);
    assert.deepEqual(pie?.plan.tasks.find((t) => t.id === 'docs2')?.requirementItems, [], 'none named: bound to none');
    assert.ok((await contractOf(ports, (await acceptedOf(ports, 'impl'))!)).includes('item.m1.g3'));
    assert.ok(!(await contractOf(ports, (await acceptedOf(ports, 'impl'))!)).includes('item.m1.g2'));
    const r = ports.memory.read((db) => repairsRead(db, ports.memory.data, 'm1')).repairs[0]!;
    assert.deepEqual(r.unnamed, ['docs2'], 'the read shows it under its filing, with its item not named');
    assert.ok(repairsText({ mission: 'm1', repairs: [r] }).includes('tasks on which its Architect named none of its items (bound to none): docs2'));
    assert.match(buildGraph(ports.ctx, { mission: 'm1' }).nodes.get(`object:${(await acceptedOf(ports, 'impl'))!}`)?.checks ?? '', /this work came with the reopen of new requirement R-1/);
  });

  it('an item withdrawn between the Architect step\'s queueing and its claim: the claimed card says so and asks nothing for it', async () => {
    const { ports, engine } = await setup('fast');
    await extend(ports, [{ item: 'g2', text: 'JSON export', quote: 'export JSON' }, { item: 'g3', text: 'Rows keep their order', quote: 'keep the order' }], 'Please export JSON and keep the order.');
    await engine.reconcile(M);
    const step = ports.scheduler.queued('architect-repair')[0]!.task;
    assert.equal(ports.scheduler.card<ArchitectRepairCard>(step).items?.some((i) => i.withdrawn === true), false);
    await withdrawItem(ports, { mission: M, item: 'g3', reason: 'not now' });
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [], add: [{ ...JSON_TASK, requirementItems: ['item.m1.g2'] }], note: 'JSON only' } } : happyScript(M)(t, s)));
    const card = claimed<ArchitectRepairCard>(ports, step);
    assert.deepEqual(card.items?.map((i) => [i.id, i.withdrawn]), [['item.m1.g2', undefined], ['item.m1.g3', true]]);
    assert.ok(renderArchitectRepair(card).includes('[item.m1.g3] (goal) Rows keep their order — the user\'s words (W-2): "keep the order" (withdrawn since: plan nothing for it)'));
  });

  it('the user takes it back: every item withdrawn before the amendment is applied ends the filing; a hand-back that comes afterwards is kept and not applied', async () => {
    const { ports, engine } = await setup('fast');
    await extend(ports, [{ item: 'g2', text: 'JSON export', quote: 'export JSON' }], 'Please export JSON.');
    // the Architect step is claimed and works; meanwhile the user takes it back
    await engine.reconcile(M);
    const step = ports.scheduler.queued('architect-repair')[0]!.task;
    await withdrawItem(ports, { mission: M, item: 'g2', reason: 'the user took it back' });
    await ports.scheduler.run(step, { handBack: { reopen: [], add: [JSON_TASK], note: 'a new task' } });
    await drive(engine, ports.scheduler, happyScript(M));
    const ended = await ports.ledger.events<{ repair: string; arch: string | null }>({ mission: M, line: 'repairs', event: 'ended' });
    assert.deepEqual(ended.map((e) => [e.key, e.body.arch]), [['R-1', step]]);
    assert.equal((await ports.ledger.events({ mission: M, line: 'repairs', event: 'decided' })).length, 0, 'not applied');
    assert.equal((await planInEffect(flowCtx(ports, M)))?.plan.tasks.some((t) => t.id === 'json'), false);
    assert.equal(ports.scheduler.tasks.get(step)?.state, 'done', 'the hand-back is kept on the record');
    const read = ports.memory.read((db) => repairsRead(db, ports.memory.data, 'm1'));
    assert.equal(read.repairs[0]?.state, 'ended');
    assert.ok(repairsText(read).includes('ended: every item of it was withdrawn before its amendment was applied') && repairsText(read).includes('item.m1.g2 (withdrawn)'), repairsText(read));
    // withdrawn before the step was claimed: it ends and the queued step is cancelled
    await extend(ports, [{ item: 'g3', text: 'TSV mode', quote: 'a TSV mode' }], 'And a TSV mode.');
    await engine.reconcile(M);
    const queued = ports.scheduler.queued('architect-repair')[0]!.task;
    await withdrawItem(ports, { mission: M, item: 'g3', reason: 'taken back' });
    await engine.reconcile(M);
    assert.equal(ports.scheduler.tasks.get(queued)?.state, 'abandoned', 'the queued step is cancelled');
    assert.deepEqual((await ports.ledger.events({ mission: M, line: 'repairs', event: 'ended' })).map((e) => e.key), ['R-1', 'R-2']);
  });

  it('a pass interrupted after it ended a filing and before it cancelled the queued step: the next pass cancels it', async () => {
    const { ports, engine } = await setup('fast');
    await extend(ports, [{ item: 'g2', text: 'JSON export', quote: 'export JSON' }], 'Please export JSON.');
    await engine.reconcile(M);
    const step = ports.scheduler.queued('architect-repair')[0]!.task;
    await withdrawItem(ports, { mission: M, item: 'g2', reason: 'taken back' });
    const sched = ports.scheduler as unknown as { cancel: (t: string) => Promise<void> };
    const cancel = sched.cancel.bind(ports.scheduler);
    sched.cancel = async () => { throw new Error('interrupted'); };
    await engine.reconcile(M).catch(() => undefined);
    sched.cancel = cancel;
    assert.deepEqual((await ports.ledger.events({ mission: M, line: 'repairs', event: 'ended' })).map((e) => e.key), ['R-1'], 'ended before the interruption');
    assert.equal(ports.scheduler.tasks.get(step)?.state, 'queued');
    await engine.reconcile(M);
    assert.equal(ports.scheduler.tasks.get(step)?.state, 'abandoned', 'cancelled on the next pass');
  });

  it('another process withdraws the item between the decision\'s read and its write: nothing is applied, and the next pass ends the filing', async () => {
    const { ports, engine } = await setup('fast');
    await extend(ports, [{ item: 'g2', text: 'JSON export', quote: 'export JSON' }], 'Please export JSON.');
    await engine.reconcile(M);
    const step = ports.scheduler.queued('architect-repair')[0]!.task;
    assert.deepEqual(await ports.scheduler.run(step, { handBack: { reopen: [], add: [JSON_TASK], note: 'a new task' } }), []);
    type Append = World['ledger']['append'];
    const append: Append = ports.ledger.append.bind(ports.ledger);
    const ledger = ports.ledger as { append: Append };
    ledger.append = async (op, entries) => {
      if (op === 'flow:repair-decided:m1:R-1') {
        ledger.append = append;
        await withdrawItem(ports, { mission: M, item: 'g2', reason: 'taken back meanwhile' });
      }
      return append(op, entries);
    };
    await engine.reconcile(M);
    ledger.append = append;
    await engine.reconcile(M);
    assert.equal((await ports.ledger.events({ mission: M, line: 'repairs', event: 'decided' })).length, 0, 'the decision was not written over the withdrawal');
    assert.deepEqual((await ports.ledger.events({ mission: M, line: 'repairs', event: 'ended' })).map((e) => e.key), ['R-1']);
  });

  it('withdrawn once the amendment is applied: the bound product reads basis withdrawn and a decider is asked; the rest keeps its proof', async () => {
    const { ports, engine } = await setup('fast');
    await extend(ports, [{ item: 'g2', text: 'JSON export', quote: 'export JSON' }], 'Please export JSON.');
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [], add: [JSON_TASK], note: 'a new task' } } : happyScript(M)(t, s)));
    const product = (await acceptedOf(ports, 'json'))!;
    await withdrawItem(ports, { mission: M, item: 'g2', reason: 'the user does not want it now' });
    assert.equal((await labels(ports, [product]))[product], 'basis-withdrawn');
    assert.equal((await labels(ports, ['pmplan.m1.1']))['pmplan.m1.1'], 'proven');
    await engine.reconcile(M);
    const esc = (await ports.ledger.events<{ subject: string }>({ mission: M, line: 'secretary', event: 'escalation' })).find((e) => e.key === `withdrawn.${product}`);
    assert.equal(esc?.body.subject, 'task:json');
  });

  it('mp pm repair --item: the Architect card shows the item; the added task is bound to it the same way; a repair with --kind missing still files', async () => {
    const { ports, engine } = await setup('fast');
    const w = say(ports, 'The parser fails on an empty file.');
    const r = await pmRepair(ports.ctx, { mission: M, words: w, kind: 'defect', text: 'fails on an empty file', item: 'g1' });
    const filed = (await ports.ledger.events<{ items?: string[] }>({ mission: M, line: 'repairs', event: 'repair' })).find((e) => e.key === r.repair)?.body;
    assert.deepEqual(filed?.items, ['g1']);
    let card: ArchitectRepairCard | null = null;
    await drive(engine, ports.scheduler, (t, s) => {
      if (t.card.seat !== 'architect-repair') return happyScript(M)(t, s);
      card = t.card as unknown as ArchitectRepairCard;
      return { handBack: { reopen: [], add: [{ ...JSON_TASK, id: 'empty', goal: 'Handle an empty file', writeScope: ['src/parser/empty.ts'] }], note: 'a new task' } };
    });
    assert.equal(card!.entry, undefined);
    assert.deepEqual(card!.items?.map((i) => i.id), ['item.m1.g1']);
    assert.ok(renderArchitectRepair(card!).includes('## The requirement item this repair falls short of'));
    assert.deepEqual((await planInEffect(flowCtx(ports, M)))?.plan.tasks.find((t) => t.id === 'empty')?.requirementItems, ['item.m1.g1']);
    // a repair that names an item not in force is refused (a new flag), nothing filed
    await assert.rejects(pmRepair(ports.ctx, { mission: M, words: w, kind: 'defect', text: 'fails on an empty file', item: 'nope' }), /no requirement item nope in force/);
  });
});

describe('4.4 G9 with G5 (p10): mp read items, mp pm verified, --open-items on a new requirement', () => {
  const linesOf = (ports: World) => readItems(ports.ctx, 'm1').flatMap(itemStateLines);

  it('one item: its line has its state, how its work came in and the plan\'s check; its task says it was added by the filing; the filing is named a new requirement; the user\'s statement on it is recorded', async () => {
    const { ports, engine } = await setup('fast');
    await extend(ports, [{ item: 'g2', text: 'The parser exports rows as JSON', quote: 'export the rows as JSON' }], 'Could it also export the rows as JSON?');
    let read = linesOf(ports).join('\n');
    assert.ok(read.includes('[g2] goal, W-2: not planned') && read.includes('came with new requirement R-1: its work passes its Architect and the mechanical checks, no plan review; outside the set PM plan pmplan.m1.1 was checked against'), read);
    assert.ok(read.includes('[R-1] new requirement, the user\'s words W-2: not planned'), read);
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [], add: [JSON_TASK], note: 'a new task exports JSON' } } : happyScript(M)(t, s)));
    read = linesOf(ports).join('\n');
    assert.match(read, /\[g2\] goal, W-2: accepted after a passing review; proof: proven; tasks: json accepted \[added by new requirement R-1\]/);
    assert.match(read, /\[g1\] goal, W-1: accepted after a passing review; proof: proven; tasks: iface accepted, impl accepted\n/, 'a task of the plan says nothing of the kind');
    const v = recordVerified(ports.ctx, { op: 'v1', mission: 'm1', subject: 'item:g2', words: say(ports, 'I tried the JSON export, it works.'), items: [] });
    assert.equal(v.subject, 'item:g2');
    assert.match(linesOf(ports).join('\n'), /\[g2\][^\n]*\n[^\n]*\n[^\n]*\n {2}the user's statement on W-3: checked in the field and holds/);
  });

  it('several items: an item bound by a reopen lists the reopened task as the repair read credits it; the filing\'s line lists its tasks that name no item', async () => {
    const { ports, engine } = await setup('fast');
    await extend(ports, [{ item: 'g2', text: 'JSON export', quote: 'export JSON' }, { item: 'g3', text: 'Rows keep their order', quote: 'keep the order' }], 'Please export JSON and keep the order.');
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [{ task: 'impl', issue: 'keep the order', items: ['item.m1.g3'] }], add: [{ ...JSON_TASK, requirementItems: ['item.m1.g2'] }, { ...JSON_TASK, id: 'docs2', goal: 'Document it', writeScope: ['docs/json.md'] }], note: 'n' } } : happyScript(M)(t, s)));
    const read = linesOf(ports).join('\n');
    assert.match(read, /\[g3\] goal, W-2: accepted after a passing review; proof: proven; tasks: impl \(reopened at attempt 2; accepted at attempt 2 \(prod\.con\.m1\.impl\.2\)\) \[reopened by new requirement R-1\]/);
    assert.ok(read.includes('tasks on which its Architect named none of its items (bound to none): docs2'), read);
  });

  it('mp pm extend --open-items: the filing names items left at the cap as a repair does; its Architect card lists them; an unknown one is refused, nothing recorded', async () => {
    const { ports, engine } = await setup('fast');
    // an item left at the cap: the task's open items written at an acceptance with risk (p10), here as its record
    await ports.ledger.append('test:open-item', { events: [{ mission: M, line: 'open-items', event: 'open-item', key: 'exh.x.r1', body: { id: 'exh.x.r1', kind: 'fix', text: '[S1] not met: slow on big files', task: 'impl', attempt: 1, escalation: 'exh.x', why: 'risk', ref: { standard: 'S1' } } }] });
    const w = say(ports, 'Make it fast on big files too.');
    await assert.rejects(pmExtend(ports.ctx, { mission: M, items: [{ item: 'g2', type: 'goal', text: 'Fast on big files', quote: 'fast on big files', words: w }], openItems: ['nope'] }), /nope is not an item left at the cap/);
    assert.equal((await ports.ledger.events({ mission: M, line: 'repairs', event: 'repair' })).length, 0, 'nothing recorded');
    const known = listAllItems(ports.ctx, M).items.map((i) => i.id);
    assert.ok(known.includes('exh.x.r1'), JSON.stringify(known));
    const r = await pmExtend(ports.ctx, { mission: M, items: [{ item: 'g2', type: 'goal', text: 'Fast on big files', quote: 'fast on big files', words: w }], openItems: ['exh.x.r1'] });
    await engine.reconcile(M);
    const card = ports.scheduler.queued('architect-repair').map((t) => t.card as unknown as ArchitectRepairCard).find((c) => c.repair.id === r.repair)!;
    assert.deepEqual(card.openItems?.map((i) => i.id), ['exh.x.r1']);
    assert.equal(card.entry, 'extend');
  });
});

describe('4.4 G9 compatibility: Reviewer cards queued before the block, and claimed after a change', () => {
  it('a Reviewer card without the items block (queued by 4.3) parses and renders as before; a queued card gets the items as they stand at its claim', async () => {
    const { ports, engine } = await setup('fast');
    await extend(ports, [{ item: 'g2', text: 'JSON export', quote: 'export JSON' }], 'Please export JSON.');
    await drive(engine, ports.scheduler, (t, s) => {
      if (t.card.seat === 'architect-repair') return { handBack: { reopen: [], add: [JSON_TASK], note: 'a new task' } };
      if (t.task === 'rev.m1.json.1') return null;
      return happyScript(M)(t, s);
    });
    const queued = ports.scheduler.card<ReviewerCard>('rev.m1.json.1');
    assert.deepEqual(queued.requirementItems?.map((i) => i.text), ['JSON export']);
    const { requirementItems: _drop, ...as43 } = queued;
    void _drop;
    assert.ok(!renderSeatCard(as43 as never, { dispatch: 'D-x' }).includes('Requirement items this task carries'), 'a 4.3 card renders with no block');
    // revised between its queueing and its claim: the claim shows the text the judgment is bound to then
    const w = say(ports, 'As JSON lines.');
    await pmRequirement(ports.ctx, { mission: M, item: 'g2', type: 'goal', text: 'JSON lines export', quote: 'As JSON lines', words: w });
    await drive(engine, ports.scheduler, (t, s) => (t.task === 'rev.m1.json.1' ? { handBack: reviewer(t.card as never, 'pass') } : happyScript(M)(t, s)));
    assert.deepEqual(claimed<ReviewerCard>(ports, 'rev.m1.json.1').requirementItems?.map((i) => i.text), ['JSON lines export']);
  });
});

describe('4.4 G9 review round 1: the item a filing gives its work stays with it', () => {
  it('p12-2: an item withdrawn after a task took it through a filing and before its product: the product keeps it in its contract and the Reviewer\'s binding keeps its last version; the product reads basis withdrawn and a decider is asked', async () => {
    const { ports, engine } = await setup('fast');
    await extend(ports, [{ item: 'g2', text: 'JSON export', quote: 'export JSON' }], 'Please export JSON.');
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [], add: [JSON_TASK], note: 'a new task' } } : t.task.startsWith('con.m1.json.') ? null : happyScript(M)(t, s)));
    assert.deepEqual((await planInEffect(flowCtx(ports, M)))?.plan.tasks.find((t) => t.id === 'json')?.requirementItems, ['item.m1.g2'], 'the task took it');
    assert.equal(await acceptedOf(ports, 'json'), undefined, 'no product yet');
    const g2 = (await basisIndex(flowCtx(ports, M))).current.get('item.m1.g2')!;
    await withdrawItem(ports, { mission: M, item: 'g2', reason: 'taken back after the amendment' });
    await drive(engine, ports.scheduler, happyScript(M));
    const product = (await acceptedOf(ports, 'json'))!;
    assert.ok((await contractOf(ports, product)).includes('item.m1.g2'), 'kept in the product\'s contract');
    assert.ok(ports.ledger.content.getList(ports.scheduler.card<ReviewerCard>('rev.m1.json.1').binding.bases as never).includes(g2), 'the queued Reviewer binding keeps its last version');
    const rev = claimed<ReviewerCard>(ports, 'rev.m1.json.1');
    assert.deepEqual(rev.requirementItems?.map((i) => [i.id, i.withdrawn]), [['item.m1.g2', true]], 'its card shows it withdrawn');
    assert.ok(renderSeatCard(rev as never, { dispatch: 'D-x' }).includes('withdrawn by the user since the task took it: a decider settles the work done for it'));
    const j = (await ports.ledger.records(['judgment'])).map((c) => c.record).find((r) => r.judgment === 'j.rev.m1.json.1')!;
    assert.ok(ports.ledger.content.getList(j.bases).includes(g2), 'the judgment is bound to it');
    assert.equal((await labels(ports, [product]))[product], 'basis-withdrawn');
    assert.equal((await labels(ports, ['pmplan.m1.1']))['pmplan.m1.1'], 'proven', 'the plan keeps its proof');
    await engine.reconcile(M);
    const esc = (await ports.ledger.events<{ subject: string }>({ mission: M, line: 'secretary', event: 'escalation' })).find((e) => e.key === `withdrawn.${product}`);
    assert.equal(esc?.body.subject, 'task:json', 'the existing withdrawn-basis escalation runs');
  });

  it('p12-3: a reopen\'s item goes with the accepted product\'s later attempts: a revision sends it back to review, the Reviewer asks for rework, and attempt 3 is still bound to it', async () => {
    const { ports, engine } = await setup('stable');
    await extend(ports, [{ item: 'g2', text: 'Rows keep their order', quote: 'keep the rows in order' }], 'Please keep the rows in order.');
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [{ task: 'impl', issue: 'keep the rows in order' }], add: [], note: 'impl writes the rows' } } : happyScript(M)(t, s)));
    assert.equal(await acceptedOf(ports, 'impl'), 'prod.con.m1.impl.2');
    assert.ok((await contractOf(ports, 'prod.con.m1.impl.2')).includes('item.m1.g2'));
    const w = say(ports, 'Keep them in the order of the file.');
    await pmRequirement(ports.ctx, { mission: M, item: 'g2', type: 'goal', text: 'Rows keep the file order', quote: 'in the order of the file', words: w });
    let failed = false;
    const ran = await drive(engine, ports.scheduler, (t, s) => {
      if (t.card.seat === 'reviewer' && t.task.startsWith('rev.m1.impl.') && !failed) { failed = true; return { handBack: reviewer(t.card as never, 'rework') }; }
      return happyScript(M)(t, s);
    });
    assert.ok(failed && ran.includes('con.m1.impl.3'), `a rework after the acceptance: ${ran.join(', ')}`);
    assert.ok((await contractOf(ports, 'prod.con.m1.impl.3')).includes('item.m1.g2'), 'attempt 3 is bound to the item');
    assert.ok(claimed<ConstructorCard>(ports, 'con.m1.impl.3').requirementItems.some((i) => i.id === 'item.m1.g2' && i.text === 'Rows keep the file order'), 'and its Constructor card shows it at the claim');
  });
});

describe('4.4 G9 review round 1: the binding rule the card states is the one the amendment applies', () => {
  it('p12-6: X and Y filed, Y withdrawn before the claim, a task added without naming X: the card says one item is in force and binds by itself, and X is bound', async () => {
    const { ports, engine } = await setup('fast');
    await extend(ports, [{ item: 'g2', text: 'JSON export', quote: 'export JSON' }, { item: 'g3', text: 'Rows keep their order', quote: 'keep the order' }], 'Please export JSON and keep the order.');
    await engine.reconcile(M);
    const step = ports.scheduler.queued('architect-repair')[0]!.task;
    assert.ok(renderArchitectRepair(ports.scheduler.card<ArchitectRepairCard>(step)).includes('2 items of it are in force: item.m1.g2, item.m1.g3. Name on each task the items it serves'), 'queued with two in force');
    await withdrawItem(ports, { mission: M, item: 'g3', reason: 'not now' });
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [], add: [JSON_TASK], note: 'JSON only' } } : happyScript(M)(t, s)));
    const text = renderArchitectRepair(claimed<ArchitectRepairCard>(ports, step));
    assert.ok(text.includes('One item of it is in force: item.m1.g2. Every task you add, change or reopen for it is bound to this item by itself, with no action of yours'), text);
    assert.ok(text.includes('The number of its items in force when your amendment is applied decides this.'), 'the card states the rule');
    assert.deepEqual((await planInEffect(flowCtx(ports, M)))?.plan.tasks.find((t) => t.id === 'json')?.requirementItems, ['item.m1.g2'], 'X is bound');
    const product = (await acceptedOf(ports, 'json'))!;
    assert.ok((await contractOf(ports, product)).includes('item.m1.g2'));
    // revising X takes the product's proof off
    const w = say(ports, 'As JSON lines.');
    await pmRequirement(ports.ctx, { mission: M, item: 'g2', type: 'goal', text: 'JSON lines export', quote: 'As JSON lines', words: w });
    assert.equal((await labels(ports, [product]))[product], 'not-fully-proven');
  });

  it('p12-7: on a filing with items, a newly named item must be the filing\'s in force: another mission\'s item and a plan item go back by the mechanical return; one already on a changed card stays', async () => {
    const { ports, engine } = await setup('fast');
    await seedMission(ports, 'm2' as MissionId);
    // a plain repair adds a task bound to an item of the plan (4.3's rule for it); its work is not started
    const w = say(ports, 'It should export JSON too.');
    await pmRepair(ports.ctx, { mission: M, words: w, kind: 'missing', text: 'export JSON too' });
    const notJson: Script = (t, s) => (t.task.startsWith('con.m1.json.') ? null : happyScript(M)(t, s));
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [], add: [{ ...JSON_TASK, requirementItems: ['item.m1.g1'] }], note: 'json' } } : notJson(t, s)));
    assert.deepEqual((await planInEffect(flowCtx(ports, M)))?.plan.tasks.find((t) => t.id === 'json')?.requirementItems, ['item.m1.g1']);
    await extend(ports, [{ item: 'g2', text: 'JSON in order', quote: 'in order' }, { item: 'g3', text: 'Documented', quote: 'documented' }], 'Keep it in order and keep it documented.');
    const DOCS: DetailedTask = { ...JSON_TASK, id: 'docs2', goal: 'Document it', writeScope: ['docs/json.md'] };
    const changed: DetailedTask = { ...JSON_TASK, goal: 'Export rows as JSON, in order', requirementItems: ['item.m1.g1', 'item.m1.g2'] };
    const cards: ArchitectRepairCard[] = [];
    await drive(engine, ports.scheduler, (t, s) => {
      if (t.card.seat !== 'architect-repair') return notJson(t, s);
      cards.push(t.card as unknown as ArchitectRepairCard);
      return cards.length === 1
        ? { handBack: { reopen: [], add: [{ ...DOCS, requirementItems: ['item.m2.g1', 'item.m1.g1'] }], change: [changed], note: 'first try' } }
        : { handBack: { reopen: [], add: [{ ...DOCS, requirementItems: ['item.m1.g3'] }], change: [changed], note: 'second try' } };
    });
    assert.equal(cards.length, 2, 'returned once');
    const failures = cards[1]?.revision?.mechanicalFailures ?? [];
    assert.ok(failures.some((f) => f.startsWith('add[docs2].requirementItems: "item.m2.g1" is not a requirement item of R-2 in force')), JSON.stringify(failures));
    assert.ok(failures.some((f) => f.startsWith('add[docs2].requirementItems: "item.m1.g1" is not a requirement item of R-2 in force')), JSON.stringify(failures));
    assert.ok(!failures.some((f) => f.startsWith('change[json]')), 'the binding already on the changed card stays');
    const pie = await planInEffect(flowCtx(ports, M));
    assert.deepEqual(pie?.plan.tasks.find((t) => t.id === 'json')?.requirementItems, ['item.m1.g1', 'item.m1.g2']);
    assert.deepEqual(pie?.plan.tasks.find((t) => t.id === 'docs2')?.requirementItems, ['item.m1.g3']);
  });
});

describe('4.4 G9 review round 1: a new requirement whose work was re-planned away is filed again', () => {
  it('p12-8: the same extend while its added task is in the plan returns the filing; once a changed plan drops the task, it files anew against the item as recorded, and an Architect step adds the work again', async () => {
    const { ports, engine } = await setup('fast');
    const w = say(ports, 'Please export JSON.');
    const item = { item: 'g2', type: 'goal' as const, text: 'JSON export', quote: 'export JSON', words: w };
    assert.equal((await pmExtend(ports.ctx, { mission: M, items: [item] })).repair, 'R-1');
    const addJson: Script = (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [], add: [JSON_TASK], note: 'a new task' } } : happyScript(M)(t, s));
    await drive(engine, ports.scheduler, addJson);
    assert.ok((await planInEffect(flowCtx(ports, M)))?.plan.tasks.some((t) => t.id === 'json'));
    assert.deepEqual(await pmExtend(ports.ctx, { mission: M, items: [item] }), { repair: 'R-1', repeated: true, term: 1, items: ['g2'], outsideOf: 'pmplan.m1.1', olderAudits: [] }, 'its work stands: the filing recorded');
    // a changed plan re-plans the work: its detailed plan has no task for the item
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: [pmPlan(M).elements[0]!, { ...pmPlan(M).elements[1]!, text: 'Covered by unit tests only' }] }), userWords: ['W-1'] });
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? null : happyScript(M)(t, s)));
    assert.equal((await planInEffect(flowCtx(ports, M)))?.eff.pmPlan, 'pmplan.m1.2');
    assert.ok(!(await planInEffect(flowCtx(ports, M)))?.plan.tasks.some((t) => t.id === 'json'), 'the work is gone');
    const before = await current(ports, 'item.m1.g2');
    const again = await pmExtend(ports.ctx, { mission: M, items: [item] });
    assert.deepEqual([again.repair, again.repeated, again.again], ['R-2', false, 'R-1'], 'filed anew');
    assert.equal(await current(ports, 'item.m1.g2'), before, 'against the item as recorded (no new version)');
    const ran = await drive(engine, ports.scheduler, addJson);
    assert.ok(ran.some((t) => t.startsWith('arch-repair.m1.R-2')), `its Architect step: ${ran.join(', ')}`);
    assert.deepEqual((await planInEffect(flowCtx(ports, M)))?.plan.tasks.find((t) => t.id === 'json')?.requirementItems, ['item.m1.g2'], 'the work is bound to the item again');
    const read = repairsText(ports.memory.read((db) => repairsRead(db, ports.memory.data, 'm1')));
    assert.ok(read.includes('filed again: the same items as new requirement R-1 (a task R-1 added had left the plan in effect)'), read);
  });
});

describe('4.4 G9 review round 2: what a filing gave a task, for as long as its card holds', () => {
  const PLAN2 = () => pmPlan(M, { elements: [pmPlan(M).elements[0]!, { ...pmPlan(M).elements[1]!, text: 'Covered by unit tests only' }] });
  const held: Script = (t, s) => (t.task.startsWith('con.m1.json.') ? null : happyScript(M)(t, s));

  it('p12-r2-1: X and Y filed, only X given to T; a plain repair\'s card lists both, Y withdrawn before it is applied: T\'s product is bound to X alone and is not escalated for Y', async () => {
    const { ports, engine } = await setup('fast');
    await extend(ports, [{ item: 'g2', text: 'JSON export', quote: 'export JSON' }, { item: 'g3', text: 'Rows keep their order', quote: 'keep the order' }], 'Please export JSON and keep the order.');
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [], add: [{ ...JSON_TASK, requirementItems: ['item.m1.g2'] }], note: 'JSON' } } : held(t, s)));
    const w = say(ports, 'The JSON export is too slow.');
    await pmRepair(ports.ctx, { mission: M, words: w, kind: 'defect', text: 'too slow', about: 'json' });
    await engine.reconcile(M);
    const step = ports.scheduler.queued('architect-repair')[0]!.task;
    await withdrawItem(ports, { mission: M, item: 'g3', reason: 'not now' });
    assert.deepEqual(await ports.scheduler.run(step, { handBack: { reopen: [], add: [], change: [{ ...JSON_TASK, goal: 'Export rows as JSON, fast', requirementItems: ['item.m1.g2', 'item.m1.g3'] }], note: 'faster' } }), []);
    await drive(engine, ports.scheduler, happyScript(M));
    assert.deepEqual((await planInEffect(flowCtx(ports, M)))?.plan.tasks.find((t) => t.id === 'json')?.requirementItems, ['item.m1.g2', 'item.m1.g3'], 'the plain repair\'s card lists both');
    const product = (await acceptedOf(ports, 'json'))!;
    assert.ok((await contractOf(ports, product)).includes('item.m1.g2'));
    assert.ok(!(await contractOf(ports, product)).includes('item.m1.g3'), 'Y was never given to T by its filing: 4.3\'s rule leaves it out');
    assert.equal((await labels(ports, [product]))[product], 'proven');
    await engine.reconcile(M);
    assert.equal((await ports.ledger.events({ mission: M, line: 'secretary', event: 'escalation' })).some((e) => e.key === `withdrawn.${product}`), false, 'no escalation for Y');
  });

  it('p12-2 (round 2): a task a filing added, carried unchanged into a new detailed plan, keeps its item once withdrawn: its product reads basis withdrawn and a decider is asked', async () => {
    const { ports, engine } = await setup('fast');
    await extend(ports, [{ item: 'g2', text: 'JSON export', quote: 'export JSON' }], 'Please export JSON.');
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [], add: [JSON_TASK], note: 'a new task' } } : held(t, s)));
    const card = (await planInEffect(flowCtx(ports, M)))!.plan.tasks.find((t) => t.id === 'json')!;
    assert.deepEqual(card.requirementItems, ['item.m1.g2']);
    // a changed plan whose detailed plan carries the card over unchanged (it has no amendment of its own)
    const carried = (): DetailedPlanDoc => ({ ...detailedPlan(M), tasks: [...detailedPlan(M).tasks, card] });
    await submitPmBatch(ports, { mission: M, plan: PLAN2(), userWords: ['W-1'] });
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' || t.task.startsWith('con.m1.json.') ? null : happyScript(M, carried)(t, s)));
    const pie = (await planInEffect(flowCtx(ports, M)))!;
    assert.equal(pie.eff.pmPlan, 'pmplan.m1.2');
    assert.equal((pie.eff.amendments ?? []).length, 0, 'no amendment history in the new plan');
    assert.ok(pie.plan.tasks.some((t) => t.id === 'json'));
    assert.equal(await acceptedOf(ports, 'json'), undefined, 'no product yet');
    await withdrawItem(ports, { mission: M, item: 'g2', reason: 'taken back' });
    await drive(engine, ports.scheduler, happyScript(M, carried));
    const product = (await acceptedOf(ports, 'json'))!;
    assert.ok((await contractOf(ports, product)).includes('item.m1.g2'), 'found from the original amendment');
    assert.equal((await labels(ports, [product]))[product], 'basis-withdrawn');
    await engine.reconcile(M);
    assert.ok((await ports.ledger.events({ mission: M, line: 'secretary', event: 'escalation' })).some((e) => e.key === `withdrawn.${product}`), 'a decider is asked');
  });

  it('p12-7 (round 2): a pending task carries live item X; a new requirement for Y changes its card naming only Y: the card keeps X and adds Y', async () => {
    const { ports, engine } = await setup('fast');
    const w = say(ports, 'It should export JSON too.');
    await pmRepair(ports.ctx, { mission: M, words: w, kind: 'missing', text: 'export JSON too' });
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [], add: [{ ...JSON_TASK, requirementItems: ['item.m1.g1'] }], note: 'json' } } : held(t, s)));
    await extend(ports, [{ item: 'g2', text: 'JSON in order', quote: 'in order' }], 'Keep the JSON in order.');
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [], add: [], change: [{ ...JSON_TASK, goal: 'Export rows as JSON, in order', requirementItems: ['item.m1.g2'] }], note: 'in order' } } : held(t, s)));
    assert.deepEqual((await planInEffect(flowCtx(ports, M)))?.plan.tasks.find((t) => t.id === 'json')?.requirementItems, ['item.m1.g1', 'item.m1.g2'], 'X is not removed by leaving it out');
  });

  it('p12-8 (round 2): a new requirement that changed the only task of its work: once a changed plan drops that task, the same extend files anew', async () => {
    const { ports, engine } = await setup('fast');
    const w0 = say(ports, 'It should export JSON too.');
    await pmRepair(ports.ctx, { mission: M, words: w0, kind: 'missing', text: 'export JSON too' });
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [], add: [JSON_TASK], note: 'json' } } : held(t, s)));
    const w = say(ports, 'Keep the JSON in order.');
    const item = { item: 'g2', type: 'goal' as const, text: 'JSON in order', quote: 'in order', words: w };
    assert.equal((await pmExtend(ports.ctx, { mission: M, items: [item] })).repair, 'R-2');
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [], add: [], change: [{ ...JSON_TASK, goal: 'Export rows as JSON, in order' }], note: 'in order' } } : held(t, s)));
    const d = (await ports.ledger.events<{ add: string[]; changed?: string[] }>({ mission: M, line: 'repairs', event: 'decided' })).find((e) => e.key === 'R-2')?.body;
    assert.deepEqual([d?.add, d?.changed], [[], ['json']], 'its work is the changed task only');
    assert.equal((await pmExtend(ports.ctx, { mission: M, items: [item] })).repeated, true, 'while the task is in the plan, the filing stands');
    await submitPmBatch(ports, { mission: M, plan: PLAN2(), userWords: ['W-1'] });
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? null : happyScript(M)(t, s)));
    assert.ok(!(await planInEffect(flowCtx(ports, M)))?.plan.tasks.some((t) => t.id === 'json'), 'the work is gone');
    const again = await pmExtend(ports.ctx, { mission: M, items: [item] });
    assert.deepEqual([again.repair, again.repeated, again.again], ['R-3', false, 'R-2'], 'filed anew');
  });

  it('p12-r2-2: an extend operation retried after a re-plan dropped its filing\'s task returns the filing it made or returned; another operation files anew', async () => {
    const { ports, engine } = await setup('fast');
    const w = say(ports, 'Please export JSON.');
    const item = { item: 'g2', type: 'goal' as const, text: 'JSON export', quote: 'export JSON', words: w };
    const first = await pmExtend(ports.ctx, { mission: M, items: [item], op: 'K1' });
    assert.deepEqual([first.repair, first.repeated], ['R-1', false]);
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: { reopen: [], add: [JSON_TASK], note: 'a new task' } } : happyScript(M)(t, s)));
    const returned = await pmExtend(ports.ctx, { mission: M, items: [item], op: 'K2' });
    assert.deepEqual([returned.repair, returned.repeated], ['R-1', true], 'its work stands: returned');
    await submitPmBatch(ports, { mission: M, plan: PLAN2(), userWords: ['W-1'] });
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? null : happyScript(M)(t, s)));
    assert.ok(!(await planInEffect(flowCtx(ports, M)))?.plan.tasks.some((t) => t.id === 'json'), 'the work is gone');
    // the retries of K1 and K2 (their receipts lost) return what each did then
    const r1 = await pmExtend(ports.ctx, { mission: M, items: [item], op: 'K1' });
    assert.deepEqual([r1.repair, r1.repeated], ['R-1', false], 'K1 made R-1');
    const r2 = await pmExtend(ports.ctx, { mission: M, items: [item], op: 'K2' });
    assert.deepEqual([r2.repair, r2.repeated], ['R-1', true], 'K2 returned R-1');
    assert.equal((await ports.ledger.events({ mission: M, line: 'repairs', event: 'repair' })).length, 1, 'no second filing');
    const k3 = await pmExtend(ports.ctx, { mission: M, items: [item], op: 'K3' });
    assert.deepEqual([k3.repair, k3.repeated, k3.again], ['R-2', false, 'R-1'], 'another operation files anew');
    assert.deepEqual((await pmExtend(ports.ctx, { mission: M, items: [item], op: 'K3' })).repair, 'R-2');
  });
});
