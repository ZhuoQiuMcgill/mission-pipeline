// 4.4 (PM design G5): an open item is taken when a re-plan or a repair names it and gives it to a task. The
// Architect's decomposition card lists the items no task of the plan it revises takes; a task names the ones it
// takes in `openItems` (a name that is not an item of the mission goes back as a mechanical failure); its cards
// list them. The Secretary's card for a used-up loop shows what is left open on the task. The commands: a repair
// names items (`--open-items`), the PM closes one on the user's words, and an item left at the cap is not
// answered as a question is.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { DetailedPlanDoc, type DetailedTask } from '../src/flow/plandoc.ts';
import { OPEN_ITEM, OPEN_ITEMS_LINE } from '../src/flow/openItems.ts';
import type { RiskItemBody } from '../src/flow/riskItems.ts';
import { architect, detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import type { EscalationBody } from '../src/flow/secretary.ts';
import { answerOpenItem, listAllItems } from '../src/process/openItems.ts';
import { pmRepair } from '../src/process/pm.ts';
import type { ConstructorCard, ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectDecomposeCard, ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { cli } from './cli-fixtures.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
const events = <B = any>(w: World, line: string, event: string) => w.ledger.events<B>({ mission: M, line, event });

async function world(): Promise<{ w: World; engine: FlowEngine }> {
  const w = memoryPorts();
  say(w, SEED_TEXT);
  await seedMission(w, M);
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  return { w, engine: new FlowEngine(w) };
}
function script(over: Record<string, Script> = {}, plan?: () => DetailedPlanDoc): Script {
  const base = happyScript(M, plan);
  return (t, s) => (Object.hasOwn(over, t.card.seat) ? over[t.card.seat]! : base)(t, s);
}
const acceptsRisk: Script = (t) => {
  const c = t.card as unknown as SecretaryCard;
  return c.request.source === 'loop-exhausted' && c.options.some((o) => o.id === 'accept-risk') ? { handBack: secretary(c, 'accept-risk') } : null;
};
/** impl's Reviewer sends back every attempt until its loop is used up; the Secretary accepts it with its risk. */
async function acceptedWithRisk(): Promise<{ w: World; engine: FlowEngine; items: RiskItemBody[] }> {
  const { w, engine } = await world();
  let n = 0;
  await drive(engine, w.scheduler, script({
    reviewer: (t) => {
      const c = t.card as unknown as ReviewerCard;
      if (!c.target.includes('.impl.')) return { handBack: reviewer(c, 'pass') };
      n++;
      return { handBack: reviewer(c, 'rework', { failing: n % 2 === 1 ? 'S1' : 'S2', findings: [`a finding of review ${n}`] }) };
    },
    secretary: acceptsRisk,
  }));
  const items = (await events<RiskItemBody>(w, OPEN_ITEMS_LINE, OPEN_ITEM)).map((e) => e.body);
  assert.ok(items.length >= 2, 'the acceptance left several items');
  return { w, engine, items };
}
/** The next PM plan version (its first element restated) and a task that takes `items`. */
const plan2 = () => pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'A CSV parser library that keeps empty fields' }, pmPlan(M).elements[1]!] });
const taker = (items: string[]): DetailedTask => ({ ...detailedPlan(M).tasks.find((t) => t.id === 'impl')!, id: 'fields', goal: 'Keep empty fields', writeScope: ['src/parser/fields/**'], implements: [], dependsOn: ['impl'], provenance: { planElements: ['e1'] }, openItems: items });
/** In a plan, the task that takes them integrates the work (a second implementation task would need one). */
const withTaker = (items: string[]): DetailedPlanDoc => ({ ...detailedPlan(M), tasks: [...detailedPlan(M).tasks, { ...taker(items), kind: 'integration', module: null, writeScope: ['docs/fields.md'] }] });

describe('4.4 G5: an item is taken by a re-plan or a repair', () => {
  it('a re-plan: the decomposition card lists the items no task takes; a name that is no item goes back as a mechanical failure; the task that names one has it on its cards', async () => {
    const { w, engine, items } = await acceptedWithRisk();
    const [first] = items as [RiskItemBody];
    await submitPmBatch(w, { mission: M, plan: plan2(), userWords: ['W-1'] });
    let hand = 0;
    await drive(engine, w.scheduler, script({
      'architect-decompose': (t) => {
        const c = t.card as unknown as ArchitectDecomposeCard;
        if (c.revision === null) return { handBack: architect(detailedPlan(M)) };
        hand++;
        return { handBack: architect(withTaker([hand === 1 ? 'no-such-item' : first.id])) };
      },
      reviewer: () => null,
    }));
    const card1 = w.scheduler.card<ArchitectDecomposeCard>('arch.m1.2.1');
    assert.deepEqual(card1.openItems?.map((i) => i.id), items.map((i) => i.id), 'the items no task takes are on the card');
    assert.equal(card1.openItems?.[0]?.from, `task impl, attempt ${first.attempt}`);
    const card2 = w.scheduler.card<ArchitectDecomposeCard>('arch.m1.2.2');
    assert.ok(card2.revision?.mechanicalFailures.includes('open items: task fields takes "no-such-item", which is not an open item of the mission'), JSON.stringify(card2.revision?.mechanicalFailures));
    const con = w.scheduler.card<ConstructorCard>('con.m1.fields.1');
    assert.deepEqual(con.openItems?.map((i) => i.id), [first.id]);
    const listed = listAllItems(w.ctx, M).items.find((i) => i.id === first.id)!;
    assert.deepEqual(listed.takenBy, [{ task: 'fields', by: 'the plan' }]);
  });

  it('the Secretary\'s card for a used-up loop shows what is left open on the task, the items it took included', async () => {
    const { w, engine, items } = await acceptedWithRisk();
    const taken = items[0]!;
    const words = say(w, 'Trying it: empty fields still vanish.');
    const filed = await pmRepair(w.ctx, { mission: M, words, kind: 'defect', text: 'empty fields still vanish', openItems: [taken.id] });
    await drive(engine, w.scheduler, script({
      'architect-repair': (t) => ((t.card as unknown as ArchitectRepairCard).repair.id === filed.repair ? { handBack: { reopen: [], add: [{ ...taker([taken.id]), provenance: 'architect' as const }], note: 'fields takes it' } } : null),
      reviewer: (t) => ({ handBack: reviewer(t.card as unknown as ReviewerCard, (t.card as unknown as ReviewerCard).target.includes('.fields.') ? 'rework' : 'pass') }),
      secretary: () => null,
    }));
    const sec = w.scheduler.queued('secretary').map((t) => t.card as unknown as SecretaryCard).find((c) => c.request.subject === 'task:fields' && c.request.source === 'loop-exhausted');
    assert.ok(sec !== undefined, 'the loop of fields is used up');
    const facts = w.ledger.content.get(sec.materials.find((m) => m.id === 'current-facts')!.ref as never);
    assert.match(facts, /What is left open on this task \(items of earlier acceptances with risk, deferrals, items it took\):/);
    assert.ok(facts.includes(`[${taken.id}] fix, attempt ${taken.attempt} of task impl, taken by this task`), facts);
  });

  it('G4: the repair\'s Architect card lists the items it is for; a reopen takes one (open_items), whose next attempt\'s cards list it; mp read repairs says which task took each, and that one given to no task stays open', async () => {
    const { w, engine, items } = await acceptedWithRisk();
    const [first, second] = items as [RiskItemBody, RiskItemBody];
    const words = say(w, 'Trying it: empty fields still vanish.');
    const filed = await pmRepair(w.ctx, { mission: M, words, kind: 'defect', text: 'empty fields still vanish', openItems: [first.id, second.id] });
    let hand = 0;
    await drive(engine, w.scheduler, script({
      'architect-repair': (t) => {
        if ((t.card as unknown as ArchitectRepairCard).repair.id !== filed.repair) return null;
        hand++;
        return { handBack: { reopen: [{ task: 'impl', issue: 'empty fields vanish', open_items: [hand === 1 ? 'no-such-item' : first.id] }], add: [], note: 'impl owns it' } };
      },
      reviewer: (t) => ({ handBack: reviewer(t.card as unknown as ReviewerCard, 'pass') }),
      secretary: acceptsRisk,
    }));
    const cards = [...w.scheduler.tasks.values()].map((t) => t.spec.card as unknown as ArchitectRepairCard).filter((c) => c.seat === 'architect-repair' && c.repair.id === filed.repair);
    assert.equal(cards.length, 2, 'the hand-back went back once');
    const [arch, again] = cards as [ArchitectRepairCard, ArchitectRepairCard];
    assert.deepEqual(arch.openItems?.map((i) => i.id), [first.id, second.id], 'the repair card lists the items it is for');
    assert.ok(again.revision?.mechanicalFailures.includes('open items: the reopen of task impl takes "no-such-item", which is not an open item of the mission'), JSON.stringify(again.revision));
    const decided = (await events<any>(w, 'repairs', 'decided')).find((e) => e.key === filed.repair)!.body;
    assert.deepEqual(decided.reopen.map((x: any) => [x.task, x.openItems]), [['impl', [first.id]]]);
    const k = first.attempt + 1;
    assert.deepEqual(w.scheduler.card<ConstructorCard>(`con.m1.impl.${k}`).openItems?.map((i) => i.id), [first.id]);
    assert.deepEqual(w.scheduler.card<ReviewerCard>(`rev.m1.impl.${k}`).openItems?.map((i) => i.id), [first.id]);
    const all = listAllItems(w.ctx, M).items;
    assert.equal(all.find((i) => i.id === first.id)!.closed?.how, 'fixed');
    assert.equal(all.find((i) => i.id === second.id)!.closed, null);
    const r = await cli(w.dir, ['read', 'repairs', 'm1']);
    assert.ok(r.out.includes(`open item ${first.id}: taken by task impl; closed`), r.out);
    assert.ok(r.out.includes(`open item ${second.id}: given to no task by its decision; still open`), r.out);
  });

  it('the commands: a repair names an item that is none, or one closed, and is refused with the reason; the PM closes one with mp pm open-item close; one left at the cap is not answered as a question is', async () => {
    const { w, items } = await acceptedWithRisk();
    const [first, second] = items as [RiskItemBody, RiskItemBody];
    const words = say(w, 'Trying it: the second one is fine as it is.');
    await assert.rejects(pmRepair(w.ctx, { mission: M, words, kind: 'defect', text: 'the second one is fine as it is', openItems: ['nope'] }), /nope is not an item left at the cap in mission m1/);
    const r = await cli(w.dir, ['pm', 'open-item', 'close', `m1/${second.id}`, '--words', words, '--reason', 'the user accepts it as it is', '--op', 'close-a']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`Open item m1/${second.id.replace(/\./g, '\\.')} \\(task impl, attempt ${second.attempt}\\) closed on the user's words ${words}\\.`));
    const replay = await cli(w.dir, ['pm', 'open-item', 'close', `m1/${second.id}`, '--words', words, '--reason', 'the user accepts it as it is', '--op', 'close-a']);
    assert.equal(replay.code, 0, replay.err);
    await assert.rejects(pmRepair(w.ctx, { mission: M, words, kind: 'defect', text: 'the second one is fine as it is', openItems: [second.id] }), /is closed already/);
    const noWords = await cli(w.dir, ['pm', 'open-item', 'close', `m1/${first.id}`, '--reason', 'x']);
    assert.notEqual(noWords.code, 0, 'the close rests on the user\'s words');
    assert.throws(() => answerOpenItem(w.ctx, { op: 'a', ref: first.id, by: 'pm', answer: 'done' }), /left at an acceptance with risk: it is not answered but closed/);
    const open = await cli(w.dir, ['read', 'open-items', 'm1', '--open']);
    assert.ok(open.out.includes(`[${first.id}]`) && !open.out.includes(`[${second.id}]`), open.out);
  });
});
