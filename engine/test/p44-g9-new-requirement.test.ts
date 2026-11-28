// 4.4 (G9, H-9): a new requirement is recorded as one, and takes the light path a repair takes.
//
// The hard question: the plan's Calibrator ① judgment is bound to the mission's requirement-set line, and every item write
// makes a new version of that set. An item recorded by `mp pm extend` must leave that judgment, and the proof of every
// product not bound to the item, as they were; a change to an item the plan WAS checked against must take the plan's proof
// off as in 4.3; and an audit of the whole mission must still go out of date when any item changes.
//
// The answer (the smallest change to what the plan's check is bound to):
// - `reqset.<m>` keeps exactly what every plan has been checked against (the items of `mp pm requirement add`), written as
//   4.3 writes it. An item recorded by `mp pm extend` is never written into it: it goes into the requirement-set line of
//   its term, `reqnew.<m>.t<n>` (n: the latest PM plan version submitted), and into the mission-wide `reqnew.<m>`; its
//   revision or withdrawal, by any path, writes those two lines again.
// - A PM plan version submitted from 4.4 on binds, besides `reqset.<m>` and its authorizations, the term lines that exist
//   at its submission: a changed plan is checked against every item in force, and a change to one of those items takes its
//   proof off as in 4.3. Items recorded after it fall in its own term, outside it. A plan submitted under 4.3 stays bound
//   to `reqset.<m>` alone, which an extension leaves alone; nothing is rewritten.
// - A re-check judges the set lines of the plan's own contract, so it leaves later items aside.
// - An audit made from 4.4 on (a legalization's chain object) binds `reqset.<m>` and `reqnew.<m>`, so any item change
//   takes it off. A chain object made before 4.4 binds `reqset.<m>` alone and is not rewritten: the label computation
//   reads it as resting on `reqnew.<m>` too, so it reads as in 4.3 until `reqnew.<m>` first lists an item, then out of
//   date (review r1-1); `mp pm extend` names it.
// - A PM plan's write is checked against the filings since it read the term lines, and built again (review r1-4); an
//   item's revision decides its set from one read and is refused by a withdrawal since (r1-5).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { basisIndex, flowCtx } from '../src/flow/context.ts';
import { setVersionsFor } from '../src/memory/domain/requirementSets.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { planInEffect, submitPmBatch } from '../src/flow/planning.ts';
import { recordItem, withdrawItem } from '../src/flow/requirements.ts';
import { recordExtension } from '../src/flow/repair.ts';
import { cal1Pass, drive, happyScript, pmPlan, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { pmExtend, pmRepair, pmRequirement, pmSay } from '../src/process/pm.ts';
import type { Calibrator1Card } from '../src/seat/cards/calibrator.ts';
import type { AuditChainCard, AuditChainResult } from '../src/seat/cards/auditor.ts';
import { advanceLegalization, requestLegalization, startLegalization } from '../src/flow/audit/flow.ts';
import '../src/seat/cards/index.ts';
import { repairsRead, repairsText } from '../src/cli/workReads.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;

async function setup(mode: 'stable' | 'fast' = 'stable'): Promise<{ ports: World; engine: FlowEngine }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'], mode });
  return { ports, engine: new FlowEngine(ports) };
}

const labels = async (ports: World, ids: readonly string[]): Promise<Record<string, unknown>> => (await ports.evaluator.labels(ids)).labels;
const products = async (ports: World): Promise<string[]> => (await ports.ledger.events<{ product: string }>({ mission: M, event: 'accepted' })).map((e) => e.body.product);
const current = async (ports: World, line: string): Promise<string | undefined> => {
  const recs = (await ports.ledger.records(['basis.version'])).map((c) => c.record).filter((r) => r.line === line);
  return recs.at(-1)?.version;
};
const LATER = 'Could it also export the rows as JSON?';
const extendJson = async (ports: World, item = 'g2') => {
  const w = say(ports, LATER);
  return { w, r: await pmExtend(ports.ctx, { mission: M, items: [{ item, type: 'goal', text: 'The parser exports rows as JSON', quote: 'export the rows as JSON', words: w }] }) };
};

describe('4.4 G9: an item recorded by mp pm extend leaves the plan\'s check as it was', () => {
  for (const mode of ['stable', 'fast'] as const) {
    it(`${mode} mode: the plan, the detailed plan and every product keep their labels; reqset is not written; the item is in its term line and reqnew`, async () => {
      const { ports, engine } = await setup(mode);
      await drive(engine, ports.scheduler, happyScript(M));
      const chain = ['pmplan.m1.1', 'dplan.m1.1.1', ...(await products(ports))];
      assert.equal(chain.length, 4);
      for (const [id, l] of Object.entries(await labels(ports, chain))) assert.equal(l, 'proven', `${id} before`);
      const reqset = await current(ports, 'reqset.m1');
      const { r } = await extendJson(ports);
      assert.equal(r.repeated, false);
      assert.equal(r.term, 1, 'recorded in the term of the latest PM plan version');
      for (const [id, l] of Object.entries(await labels(ports, chain))) assert.equal(l, 'proven', `${id} after the new item`);
      assert.equal(await current(ports, 'reqset.m1'), reqset, 'the set the plan was checked against is not written');
      assert.equal(await current(ports, 'reqnew.m1.t1'), 'reqnew.m1.t1.v1');
      assert.equal(await current(ports, 'reqnew.m1'), 'reqnew.m1.v1');
      // revised and withdrawn by the ordinary commands: still outside the plan's check
      const w = say(ports, 'As JSON lines, one row per line.');
      await pmRequirement(ports.ctx, { mission: M, item: 'g2', type: 'goal', text: 'The parser exports rows as JSON lines', quote: 'As JSON lines', words: w });
      assert.equal(await current(ports, 'reqnew.m1.t1'), 'reqnew.m1.t1.v2');
      await withdrawItem(ports, { mission: M, item: 'g2', reason: 'the user took it back' });
      assert.equal(await current(ports, 'reqnew.m1.t1'), 'reqnew.m1.t1.v3');
      assert.equal(await current(ports, 'reqset.m1'), reqset);
      for (const [id, l] of Object.entries(await labels(ports, chain))) assert.equal(l, 'proven', `${id} after the revision and the withdrawal`);
    });
  }

  it('stable mode: work in flight goes on and new work starts while the new item is recorded (nothing is held)', async () => {
    const { ports, engine } = await setup('stable');
    const base = happyScript(M);
    let hold = true;
    const script: Script = (t, s) => (hold && t.card.seat === 'reviewer' ? null : base(t, s));
    await drive(engine, ports.scheduler, script);
    assert.equal((await products(ports)).length, 0);
    await extendJson(ports);
    hold = false;
    // the filing's Architect step is left queued: only the plan's own work runs here
    const ran = await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? null : base(t, s)));
    assert.ok(ran.some((t) => t.startsWith('con.m1.impl')), `the dependent starts: ${ran.join(', ')}`);
    assert.equal((await products(ports)).length, 2, 'the held review is taken in and the dependent accepted');
  });

  it('a change to an item the plan was checked against takes the plan\'s proof off as in 4.3; its re-check leaves the new item aside and restores it', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? null : happyScript(M)(t, s)));
    const chain = ['pmplan.m1.1', 'dplan.m1.1.1', ...(await products(ports))];
    await extendJson(ports);
    const w = say(ports, 'Make it a fast CSV parser.');
    await recordItem(ports, { mission: M, item: 'g1', type: 'goal', text: 'A fast CSV parser', source: { kind: 'words', words: w, quote: 'a fast CSV parser' } });
    for (const [id, l] of Object.entries(await labels(ports, chain))) assert.equal(l, 'not-fully-proven', `${id}: as in 4.3`);
    const r = await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: [w], changedItems: ['g1'] });
    assert.deepEqual(r, { batch: 'b1.c1', plan: 'pmplan.m1.1', recheck: true });
    await engine.reconcile(M);
    const card = ports.scheduler.card<Calibrator1Card>('cal1.m1.1.c1');
    const items = ports.ledger.content.get(card.materials.find((m) => m.id === 'items')!.ref);
    assert.ok(items.includes('item.m1.g1') && !items.includes('item.m1.g2'), `the re-check leaves the new item aside: ${items}`);
    // asked for a full review, the re-check lists every item the plan is checked against, and still not the new one
    const full: Script = (t, s) => (t.task === 'cal1.m1.1.c1' ? { handBack: { ...cal1Pass(t.card as never), verdict: 'needs-full-review' } } : t.card.seat === 'architect-repair' ? null : happyScript(M)(t, s));
    await drive(engine, ports.scheduler, full);
    const fullCard = ports.scheduler.card<Calibrator1Card>('cal1.m1.1.c1.full');
    assert.equal(fullCard.mode.kind, 'full');
    const all = ports.ledger.content.get(fullCard.materials.find((m) => m.id === 'items')!.ref);
    assert.ok(all.includes('item.m1.g1') && all.includes('item.m1.s1') && !all.includes('item.m1.g2'), `the full re-check leaves the new item aside: ${all}`);
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? null : happyScript(M)(t, s)));
    for (const [id, l] of Object.entries(await labels(ports, chain))) assert.equal(l, 'proven', `${id} after the re-check`);
  });

  it('a changed plan submitted later binds the term: it is checked against every item in force, and a revision of the item then takes its proof off', async () => {
    const { ports, engine } = await setup();
    const noArch: Script = (t, s) => (t.card.seat === 'architect-repair' ? null : happyScript(M)(t, s));
    await drive(engine, ports.scheduler, noArch);
    await extendJson(ports);
    const plan2 = pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, items: ['g1', 'g2'] }, pmPlan(M).elements[1]!] });
    assert.deepEqual(await submitPmBatch(ports, { mission: M, plan: plan2, userWords: ['W-1'] }), { batch: 'b2', plan: 'pmplan.m1.2' });
    const obj = (await ports.ledger.records(['object.version'])).map((c) => c.record).find((o) => o.object === 'pmplan.m1.2')!;
    assert.deepEqual(obj.reviews[0]?.basisLines, ['reqset.m1', 'reqnew.m1.t1', 'item.m1.a1'], 'the plan binds the term of the items recorded before it');
    const old = (await ports.ledger.records(['object.version'])).map((c) => c.record).find((o) => o.object === 'pmplan.m1.1')!;
    assert.deepEqual(old.reviews[0]?.basisLines, ['reqset.m1', 'item.m1.a1'], 'the plan before it is not changed');
    await engine.reconcile(M);
    const card = ports.scheduler.card<Calibrator1Card>('cal1.m1.2');
    const items = ports.ledger.content.get(card.materials.find((m) => m.id === 'items')!.ref);
    assert.ok(items.includes('item.m1.g2'), `the changed plan is checked against the new item: ${items}`);
    await drive(engine, ports.scheduler, noArch);
    assert.equal((await planInEffect(flowCtx(ports, M)))?.eff.pmPlan, 'pmplan.m1.2');
    assert.equal((await labels(ports, ['pmplan.m1.2']))['pmplan.m1.2'], 'proven');
    // the read says what the record shows: the plan in effect now was checked against the item
    const read = repairsText(ports.memory.read((db) => repairsRead(db, ports.memory.data, 'm1')));
    assert.ok(read.includes('its items: item.m1.g2; PM plan pmplan.m1.2 was checked against them'), read);
    // an item recorded now falls in the new plan's term, outside it
    const w3 = say(ports, 'And a TSV mode too.');
    const r3 = await pmExtend(ports.ctx, { mission: M, items: [{ item: 'g3', type: 'goal', text: 'A TSV mode', quote: 'a TSV mode', words: w3 }] });
    assert.equal(r3.term, 2);
    assert.equal((await labels(ports, ['pmplan.m1.2']))['pmplan.m1.2'], 'proven', 'an item recorded after it leaves its check');
    // a revision of the item it was checked against takes its proof off (a re-check restores it)
    const w4 = say(ports, 'As JSON lines.');
    await pmRequirement(ports.ctx, { mission: M, item: 'g2', type: 'goal', text: 'The parser exports rows as JSON lines', quote: 'As JSON lines', words: w4 });
    assert.equal((await labels(ports, ['pmplan.m1.2']))['pmplan.m1.2'], 'not-fully-proven');
    assert.equal((await labels(ports, ['pmplan.m1.1']))['pmplan.m1.1'], 'proven', 'the plan that was not checked against it keeps its proof');
    assert.deepEqual(await submitPmBatch(ports, { mission: M, plan: plan2, userWords: [w4], changedItems: ['g2'] }), { batch: 'b2.c1', plan: 'pmplan.m1.2', recheck: true });
    await drive(engine, ports.scheduler, noArch);
    assert.equal((await labels(ports, ['pmplan.m1.2']))['pmplan.m1.2'], 'proven', 'the re-check restores it');
  });

  it('an audit of the whole mission goes out of date when a new item is recorded (its chain object binds reqset and reqnew)', async () => {
    const { ports, engine } = await setup();
    const noArch: Script = (t, s) => (t.card.seat === 'architect-repair' ? null : happyScript(M)(t, s));
    await drive(engine, ports.scheduler, noArch);
    const endpoint = (await products(ports)).at(-1)!;
    const seam = (await ports.ledger.records(['evidence'])).map((c) => c.record.evidence).at(-1)!;
    await requestLegalization(ports, { legalization: 'L1', mission: M, endpoint, words: 'legalize the parser', chainEvidence: [seam], capabilities: [] });
    await startLegalization(ports, M, 'L1', 'go ahead');
    for (let i = 0; i < 6; i++) {
      await advanceLegalization(ports, M, 'L1');
      for (const t of ports.scheduler.queued('auditor-chain')) {
        const card = t.card as unknown as AuditChainCard;
        const cite = [`evidence:${seam}`];
        await ports.scheduler.run(t.task, { handBack: { quotes: card.quotes.map((q) => ({ quote: q.id, honored: 'yes', reason: 'it does', evidence: cite })), seams: card.seams.map((x) => ({ seam: x.id, holds: 'yes', reason: 'it holds', evidence: cite })), findings: [], verdict: 'pass' } satisfies AuditChainResult });
      }
    }
    const s = await advanceLegalization(ports, M, 'L1');
    assert.equal(s.result?.outcome, 'stamped', JSON.stringify(s));
    const chain = (await ports.ledger.records(['object.version'])).map((c) => c.record).find((o) => o.objectKind === 'chain-acceptance')!;
    assert.deepEqual(chain.reviews[0]?.basisLines, ['reqset.m1', 'reqnew.m1']);
    assert.equal((await labels(ports, [chain.object]))[chain.object], 'proven');
    const { r } = await extendJson(ports);
    assert.deepEqual(r.olderAudits, [], 'an audit made from 4.4 on is taken off by the new item: nothing to name');
    assert.equal((await labels(ports, [chain.object]))[chain.object], 'not-fully-proven', 'the audit goes out of date');
    assert.equal((await ports.evaluator.ops(['legal.m1.L1'])).states['legal.m1.L1']?.allProven, false);
    assert.equal((await labels(ports, ['pmplan.m1.1']))['pmplan.m1.1'], 'proven', 'the plan keeps its check');
  });

  it('p12-1: a stamped audit whose chain object was made before 4.4 (it binds reqset alone) reads as in 4.3 until the first new item, then goes out of date; the plan and the products keep their labels', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? null : happyScript(M)(t, s)));
    const all = await products(ports);
    const endpoint = all.at(-1)!;
    const seam = (await ports.ledger.records(['evidence'])).map((c) => c.record.evidence).at(-1)!;
    await requestLegalization(ports, { legalization: 'L43', mission: M, endpoint, words: 'legalize the parser', chainEvidence: [seam], capabilities: [] });
    await startLegalization(ports, M, 'L43', 'go ahead');
    // the chain object as 4.3 wrote it: its contract binds reqset alone (and no reqnew line is seeded)
    type Append = World['ledger']['append'];
    const append: Append = ports.ledger.append.bind(ports.ledger);
    (ports.ledger as { append: Append }).append = async (op, entries) => {
      if (!op.includes(':chain')) return append(op, entries);
      const records = (entries.records ?? []).filter((r) => !(r.kind === 'basis.version' && r.line === 'reqnew.m1')).map((r) => (r.kind === 'object.version' ? { ...r, reviews: r.reviews.map((c) => ({ ...c, basisLines: c.basisLines.filter((l) => l !== 'reqnew.m1') })) } : r));
      return append(op, { ...entries, records });
    };
    for (let i = 0; i < 6; i++) {
      await advanceLegalization(ports, M, 'L43');
      for (const t of ports.scheduler.queued('auditor-chain')) {
        const card = t.card as unknown as AuditChainCard;
        const cite = [`evidence:${seam}`];
        await ports.scheduler.run(t.task, { handBack: { quotes: card.quotes.map((q) => ({ quote: q.id, honored: 'yes', reason: 'it does', evidence: cite })), seams: card.seams.map((x) => ({ seam: x.id, holds: 'yes', reason: 'it holds', evidence: cite })), findings: [], verdict: 'pass' } satisfies AuditChainResult });
      }
    }
    (ports.ledger as { append: Append }).append = append;
    assert.equal((await advanceLegalization(ports, M, 'L43')).result?.outcome, 'stamped');
    const chain = (await ports.ledger.records(['object.version'])).map((c) => c.record).find((o) => o.objectKind === 'chain-acceptance')!;
    assert.deepEqual(chain.reviews[0]?.basisLines, ['reqset.m1'], 'the 4.3 shape');
    const before = await labels(ports, ['pmplan.m1.1', ...all, chain.object]);
    for (const [id, l] of Object.entries(before)) assert.equal(l, 'proven', `${id} before the new item`);
    assert.equal((await ports.evaluator.ops(['legal.m1.L43'])).states['legal.m1.L43']?.allProven, true);
    const { r } = await extendJson(ports);
    assert.deepEqual(r.olderAudits, ['L43'], 'still named');
    const after = await labels(ports, ['pmplan.m1.1', ...all, chain.object]);
    assert.equal(after[chain.object], 'not-fully-proven', 'the audit no longer covers every item in force');
    assert.equal((await ports.evaluator.ops(['legal.m1.L43'])).states['legal.m1.L43']?.allProven, false);
    for (const id of ['pmplan.m1.1', ...all]) assert.equal(after[id], 'proven', `${id} does not move`);
    // the item withdrawn again: an item changed since the audit, so it stays out of date (as a chain that binds the set)
    await withdrawItem(ports, { mission: M, item: 'g2', reason: 'not now' });
    assert.equal((await labels(ports, [chain.object]))[chain.object], 'not-fully-proven', 'not current again by a later empty set');
    assert.equal((await ports.evaluator.ops(['legal.m1.L43'])).states['legal.m1.L43']?.allProven, false);
  });

  it('another process submits a PM plan between the new requirement\'s read and its write: nothing is recorded; run again, it falls in the new plan\'s term', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? null : happyScript(M)(t, s)));
    type Append = World['ledger']['append'];
    const append: Append = ports.ledger.append.bind(ports.ledger);
    const ledger = ports.ledger as { append: Append };
    ledger.append = async (op, entries) => {
      if (op.startsWith('flow:extend:')) {
        ledger.append = append;
        await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: [pmPlan(M).elements[0]!, { ...pmPlan(M).elements[1]!, text: 'Covered by unit tests only' }] }), userWords: ['W-1'] });
      }
      return append(op, entries);
    };
    const w = say(ports, LATER);
    await assert.rejects(recordExtension(ports, { mission: M, items: [{ item: 'g2', type: 'goal', text: 'The parser exports rows as JSON', quote: 'export the rows as JSON', words: w }] }), /a PM plan version was submitted while the new requirement was being recorded: nothing was recorded/);
    assert.equal(await current(ports, 'reqnew.m1'), undefined, 'nothing written');
    const r = await pmExtend(ports.ctx, { mission: M, items: [{ item: 'g2', type: 'goal', text: 'The parser exports rows as JSON', quote: 'export the rows as JSON', words: w }] });
    assert.equal(r.term, 2);
    const obj = (await ports.ledger.records(['object.version'])).map((c) => c.record).find((o) => o.object === 'pmplan.m1.2')!;
    assert.ok(!(obj.reviews[0]!.basisLines as readonly string[]).includes('reqnew.m1.t2'), 'the plan submitted first is not checked against it');
  });

  it('p12-4: a new requirement filed between a PM plan\'s read and its write: the plan\'s write is refused and built again, and its contract binds the new term line', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? null : happyScript(M)(t, s)));
    type Append = World['ledger']['append'];
    const append: Append = ports.ledger.append.bind(ports.ledger);
    const ledger = ports.ledger as { append: Append };
    const ops: string[] = [];
    ledger.append = async (op, entries) => {
      ops.push(op);
      if (op === 'flow:pm-batch:m1:2' && ops.filter((o) => o === op).length === 1) {
        const w = say(ports, LATER);
        const r = await recordExtension(ports, { mission: M, items: [{ item: 'g2', type: 'goal', text: 'The parser exports rows as JSON', quote: 'export the rows as JSON', words: w }] });
        assert.equal(r.term, 1, 'the new requirement falls in the term of the plan before');
      }
      return append(op, entries);
    };
    const plan2 = pmPlan(M, { elements: [pmPlan(M).elements[0]!, { ...pmPlan(M).elements[1]!, text: 'Covered by unit tests only' }] });
    assert.deepEqual(await submitPmBatch(ports, { mission: M, plan: plan2, userWords: ['W-1'] }), { batch: 'b2', plan: 'pmplan.m1.2' });
    ledger.append = append;
    assert.equal(ops.filter((o) => o === 'flow:pm-batch:m1:2').length, 2, 'refused once, built again');
    const obj = (await ports.ledger.records(['object.version'])).map((c) => c.record).find((o) => o.object === 'pmplan.m1.2')!;
    assert.deepEqual(obj.reviews[0]?.basisLines, ['reqset.m1', 'reqnew.m1.t1', 'item.m1.a1'], 'the plan binds the term written in between');
    await engine.reconcile(M);
    const card = ports.scheduler.card<Calibrator1Card>('cal1.m1.2');
    assert.ok(ports.ledger.content.get(card.materials.find((m) => m.id === 'items')!.ref).includes('item.m1.g2'), 'and is checked against its item');
  });

  it('p12-r2-3: ordinary repairs filed while a changed plan is being recorded do not refuse it (only a new version of reqnew.<m> does)', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? null : happyScript(M)(t, s)));
    type Append = World['ledger']['append'];
    const append: Append = ports.ledger.append.bind(ports.ledger);
    const ledger = ports.ledger as { append: Append };
    const ops: string[] = [];
    let filed = 0;
    ledger.append = async (op, entries) => {
      ops.push(op);
      // a distinct repair between the plan's read and its write, on each try (another process)
      if (op === 'flow:pm-batch:m1:2' && filed < 3) {
        filed++;
        const w = say(ports, `The parser fails on case ${filed}.`);
        await pmRepair(ports.ctx, { mission: M, words: w, kind: 'defect', text: `fails on case ${filed}` });
      }
      return append(op, entries);
    };
    const plan2 = pmPlan(M, { elements: [pmPlan(M).elements[0]!, { ...pmPlan(M).elements[1]!, text: 'Covered by unit tests only' }] });
    assert.deepEqual(await submitPmBatch(ports, { mission: M, plan: plan2, userWords: ['W-1'] }), { batch: 'b2', plan: 'pmplan.m1.2' });
    ledger.append = append;
    assert.equal(ops.filter((o) => o === 'flow:pm-batch:m1:2').length, 1, 'written at the first try');
    assert.equal((await ports.ledger.events({ mission: M, line: 'repairs', event: 'repair' })).length, 1, 'the repair is recorded beside it');
    const obj = (await ports.ledger.records(['object.version'])).map((c) => c.record).find((o) => o.object === 'pmplan.m1.2')!;
    assert.deepEqual(obj.reviews[0]?.basisLines, ['reqset.m1', 'item.m1.a1'], 'no new requirement: 4.3\'s contract');
  });

  it('p12-5: another process withdraws a new item between its revision\'s read and its write: nothing is recorded, the item stays withdrawn and never enters reqset', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? null : happyScript(M)(t, s)));
    await extendJson(ports);
    const reqset = await current(ports, 'reqset.m1');
    type Append = World['ledger']['append'];
    const append: Append = ports.ledger.append.bind(ports.ledger);
    const ledger = ports.ledger as { append: Append };
    ledger.append = async (op, entries) => {
      if (op === 'flow:item:m1:item.m1.g2.v2') {
        ledger.append = append;
        await withdrawItem(ports, { mission: M, item: 'g2', reason: 'taken back meanwhile' });
      }
      return append(op, entries);
    };
    const w = say(ports, 'As JSON lines.');
    await assert.rejects(recordItem(ports, { mission: M, item: 'g2', type: 'goal', text: 'The parser exports rows as JSON lines', source: { kind: 'words', words: w, quote: 'As JSON lines' } }), /was withdrawn while this version of it was being recorded, so nothing was recorded/);
    ledger.append = append;
    assert.equal(await current(ports, 'item.m1.g2'), 'item.m1.g2.v1', 'no version over the withdrawal');
    assert.equal(await current(ports, 'reqset.m1'), reqset, 'reqset is not written');
    assert.ok((await ports.ledger.records(['basis.withdrawn'])).some((c) => c.record.line === 'item.m1.g2'), 'it stays withdrawn');
    assert.equal(await current(ports, 'reqnew.m1.t1'), 'reqnew.m1.t1.v2', 'its term line has the withdrawal');
    assert.equal((await labels(ports, ['pmplan.m1.1']))['pmplan.m1.1'], 'proven', 'the plan keeps its proof');
    // an item ever recorded by mp pm extend is one of its term's, withdrawn too: a set computed for it is never reqset
    const ix = await basisIndex(flowCtx(ports, M));
    assert.deepEqual(setVersionsFor(ix, (r) => ports.ledger.content.getList(r), M, { line: 'item.m1.g2', version: 'item.m1.g2.v2' }, []).map((s) => s.line), ['reqnew.m1.t1', 'reqnew.m1']);
  });

  it('a supersession that withdraws a new requirement item writes its term line, not reqset', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? null : happyScript(M)(t, s)));
    const reqset = await current(ports, 'reqset.m1');
    const { w } = await extendJson(ports);
    ports.memory.write({}, (tx) => tx.append({ kind: 'mission.state', mission: M, state: 'open' }));
    pmSay(ports.ctx, LATER, { tags: ['requirement@m1'] });
    pmSay(ports.ctx, 'Forget the JSON export.', { tags: ['decision@m1'], supersedes: [`${w}#1`], withdraw: ['item.m1.g2'] });
    assert.ok((await ports.ledger.records(['basis.withdrawn'])).some((c) => c.record.line === 'item.m1.g2'), 'withdrawn');
    assert.equal(await current(ports, 'reqset.m1'), reqset);
    assert.equal(await current(ports, 'reqnew.m1.t1'), 'reqnew.m1.t1.v2');
    assert.equal((await labels(ports, ['pmplan.m1.1']))['pmplan.m1.1'], 'proven');
  });
});
