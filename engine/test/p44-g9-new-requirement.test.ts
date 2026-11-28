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
//   takes it off. A chain object made before 4.4 binds `reqset.<m>` alone (residual; `mp pm extend` names it).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { planInEffect, submitPmBatch } from '../src/flow/planning.ts';
import { recordItem, withdrawItem } from '../src/flow/requirements.ts';
import { drive, happyScript, pmPlan, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { pmExtend, pmRequirement, pmSay } from '../src/process/pm.ts';
import type { Calibrator1Card } from '../src/seat/cards/calibrator.ts';
import type { AuditChainCard, AuditChainResult } from '../src/seat/cards/auditor.ts';
import { advanceLegalization, requestLegalization, startLegalization } from '../src/flow/audit/flow.ts';
import '../src/seat/cards/index.ts';
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
