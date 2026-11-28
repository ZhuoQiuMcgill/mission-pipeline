// 4.4 (G9): a new requirement's filing takes a repair's light path. One Architect step under the mechanical checks; its card
// shows the new items and, by reference, the limit and acceptance items in force; the work is bound to the item (one item:
// every task it adds, changes or reopens, with no action of the Architect's; several: those the Architect names; none named:
// bound to none); the Reviewer's card shows the text of the items its judgment is bound to, and the old text after a change;
// a filing whose every item is withdrawn before its amendment is applied ends; `mp pm repair --item` binds the same way.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { planInEffect, submitPmBatch } from '../src/flow/planning.ts';
import type { DetailedTask } from '../src/flow/plandoc.ts';
import { withdrawItem } from '../src/flow/requirements.ts';
import { drive, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { listDispatches } from '../src/memory/index.ts';
import { pmExtend, pmRepair, pmRequirement } from '../src/process/pm.ts';
import { dispatchView } from '../src/process/seat.ts';
import { renderSeatCard, type ConstructorCard, type ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import { renderArchitectRepair, type ArchitectRepairCard } from '../src/seat/cards/architect.ts';
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
    // every task that carries items gets them, not only a new requirement's
    assert.deepEqual(claimed<ReviewerCard>(ports, 'rev.m1.impl.1').requirementItems?.map((i) => i.id), ['item.m1.g1', 'item.m1.s1']);
    assert.equal((await labels(ports, ['pmplan.m1.1', product]))['pmplan.m1.1'], 'proven');
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

  it('one item: a reopened task\'s new attempts are bound to it until one is accepted; fast mode flags the product after a revision', async () => {
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
    assert.ok(cards[1]?.revision?.mechanicalFailures.some((f) => f.includes('reopen[impl].items: "item.m1.g1" is not a requirement item of R-1 in force')), JSON.stringify(cards[1]?.revision));
    assert.ok(renderArchitectRepair(cards[0]!).includes('Name on each task the items it serves'));
    const pie = await planInEffect(flowCtx(ports, M));
    assert.deepEqual(pie?.plan.tasks.find((t) => t.id === 'json')?.requirementItems, ['item.m1.g2']);
    assert.deepEqual(pie?.plan.tasks.find((t) => t.id === 'docs2')?.requirementItems, [], 'none named: bound to none');
    assert.ok((await contractOf(ports, (await acceptedOf(ports, 'impl'))!)).includes('item.m1.g3'));
    assert.ok(!(await contractOf(ports, (await acceptedOf(ports, 'impl'))!)).includes('item.m1.g2'));
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
    // withdrawn before the step was claimed: it ends and the queued step is cancelled
    await extend(ports, [{ item: 'g3', text: 'TSV mode', quote: 'a TSV mode' }], 'And a TSV mode.');
    await engine.reconcile(M);
    const queued = ports.scheduler.queued('architect-repair')[0]!.task;
    await withdrawItem(ports, { mission: M, item: 'g3', reason: 'taken back' });
    await engine.reconcile(M);
    assert.equal(ports.scheduler.tasks.get(queued)?.state, 'abandoned', 'the queued step is cancelled');
    assert.deepEqual((await ports.ledger.events({ mission: M, line: 'repairs', event: 'ended' })).map((e) => e.key), ['R-1', 'R-2']);
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
