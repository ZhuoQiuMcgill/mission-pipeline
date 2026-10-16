// The Architect's revision card and the previous detailed plan (design 4.1 Appendix K; 3.4, 3.6,
// 6.2). A revision (a new PM plan version revising the plan in effect, a feasibility return, a
// Secretary's re-plan) asks the Architect to revise the previous detailed plan, and a task whose
// card changes restarts. So the card gives that plan in full, as a must-read material written as
// the hand-back's own fields, and states the carry rule; a scripted Architect that copies the
// unchanged tasks from it leaves their accepted products accepted (and re-bound, Appendix J). The
// PM is told before the plan's reviews which accepted work, or work under way, a revision would
// restart.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import { DetailedPlanDoc, type DetailedTask } from '../src/flow/plandoc.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { recordItem } from '../src/flow/requirements.ts';
import { architect, detailedPlan, drive, feasibilityReturn, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { renderSeatCard, type ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import { renderArchitectDecompose, type ArchitectDecomposeCard, type ArchitectFeasibilityCard } from '../src/seat/cards/architect.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;

/** The carry rule, as the card and the material state it. */
const CARRY = /Carry over every task the revision does not need to change exactly as it is in the previous detailed plan: the same id and the same value in every field [^\n]*any change to its card, however small, restarts the task at a new attempt; its earlier records remain, and it continues from its previous candidate\. Change only what the instructions, the changed PM plan elements, the feasibility findings or the mechanical check failures require/;

async function setup(): Promise<{ ports: World; engine: FlowEngine }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'] });
  return { ports, engine: new FlowEngine(ports) };
}

function withKinds(over: Record<string, Script>, plan?: () => DetailedPlanDoc): Script {
  const base = happyScript(M, plan);
  return (t, s) => (Object.hasOwn(over, t.card.seat) ? (over[t.card.seat] as Script) : base)(t, s);
}

/** The next PM plan version: its first element restated. */
const plan2 = (items: string[] = ['g1']) => pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'A CSV parser library, read-only once it has parsed a file', items }, pmPlan(M).elements[1]!] });

/** A new task that depends on the implementation (with a run its Reviewer can cite). */
const docsTask = (): DetailedTask => ({ ...detailedPlan(M, { extraTask: true }).tasks.find((t) => t.id === 'docs')!, interpreter: 'node', verificationCommands: [{ id: 'lint', command: 'npx markdownlint docs/parser.md' }] });

/** The previous plan as a seat reads it: the JSON block of the card's must-read material. */
function previousFromMaterial(ports: World, card: ArchitectDecomposeCard): { doc: DetailedPlanDoc; text: string } {
  const m = card.materials?.find((x) => x.id === 'plan-old');
  assert.ok(m !== undefined, `the revision card has the previous plan as a material: ${JSON.stringify(card.materials ?? null)}`);
  assert.equal(m.mustRead, true);
  assert.equal(m.role, 'plan');
  const text = ports.ledger.content.get(m.ref as never);
  const json = /```json\n([\s\S]*)\n```/.exec(text)?.[1];
  assert.ok(json !== undefined, 'the material holds the plan as a json block');
  return { doc: DetailedPlanDoc.parse(JSON.parse(json)), text };
}

/** Every field of every task, interface and module of `plan`, as on a revision card for it. */
function assertRevisionCard(ports: World, card: ArchitectDecomposeCard, previous: string, plan: DetailedPlanDoc): string {
  assert.equal(card.revision?.previous, previous);
  const { doc, text } = previousFromMaterial(ports, card);
  assert.deepEqual(doc, DetailedPlanDoc.parse(plan), 'the material is the previous plan, in full');
  assert.match(text, CARRY, 'the material states the carry rule');
  // every task in full, one per line, as the hand-back writes it
  for (const t of DetailedPlanDoc.parse(plan).tasks) assert.ok(text.includes(`\n    ${JSON.stringify(t)}`), `task ${t.id} in full`);
  const rendered = renderSeatCard(card as never, { dispatch: 'd-test' });
  assert.ok(rendered.includes('## This is a revision'));
  assert.ok(rendered.includes(`Previous detailed plan: ${previous}, ${plan.tasks.length} tasks (${plan.tasks.map((t) => t.id).join(', ')}), in full in material plan-old (must read: every page).`), rendered);
  assert.match(rendered.slice(rendered.indexOf('## This is a revision')), /### What to carry over\nCarry over every task/, 'the card states the carry rule');
  assert.match(rendered, CARRY);
  assert.ok(rendered.includes('[plan-old] Detailed plan') && rendered.includes('(must read)'), 'the material is listed as must read');
  assert.ok(rendered.includes('`mp seat d-test read <material> [--page <n>]`'), 'the seat has the read command');
  assert.match(card.duties, /carry every other task over unchanged/);
  return rendered;
}

const labelsOf = async (ports: World, ids: readonly string[]): Promise<Record<string, unknown>> => (await ports.evaluator.labels(ids)).labels;
const current = async (ports: World, task: string): Promise<string | null> => acceptedProduct(flowCtx(ports, M), task);
const lineEvents = async <B>(ports: World, task: string, event: string): Promise<Array<{ key: string; body: B }>> => (await ports.ledger.events<B>({ mission: M, line: `task:${task}`, event })).map((e) => ({ key: e.key, body: e.body }));

describe('flow: the Architect revision card gives the previous detailed plan in full (Appendix K)', () => {
  it('a new PM plan version: the plan in effect in full as a must-read material, the carry rule, and the elements that changed', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, happyScript(M));
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: ['W-1'] });
    await drive(engine, ports.scheduler, withKinds({ 'architect-decompose': () => null }));
    const card = ports.scheduler.card<ArchitectDecomposeCard>('arch.m1.2.1');
    assertRevisionCard(ports, card, 'dplan.m1.1.1', detailedPlan(M));
    assert.deepEqual(card.revision?.instructions, ['The PM plan changed to version pmplan.m1.2; revise the previous detailed plan to it. Elements against pmplan.m1.1: changed e1; every other element is unchanged.']);
    // the must-read list is enforced: a hand-back before reading the plan is refused
    const refused = await ports.scheduler.run('arch.m1.2.1', { handBack: architect(detailedPlan(M)), materialsRead: new Set() });
    assert.ok(refused.some((p) => p.startsWith('must-read page plan-old#1 was not read')), refused.join('; '));
    // a card queued before the material existed shows the plan inline, in full
    const { materials: _m, ...old } = card;
    const inline = renderArchitectDecompose(old as ArchitectDecomposeCard);
    assert.ok(inline.includes('It is shown in full at the end of this card.') && inline.includes('## The previous detailed plan, in full'));
    for (const t of DetailedPlanDoc.parse(detailedPlan(M)).tasks) assert.ok(inline.includes(`\n    ${JSON.stringify(t)}`), `task ${t.id} inline`);
    assert.ok(!inline.includes('[plan-old]'));
  });

  it('a feasibility return: the plan that came back in full, with the findings', async () => {
    const { ports, engine } = await setup();
    let returned = false;
    await drive(
      engine,
      ports.scheduler,
      withKinds({
        'architect-feasibility': (t) => (returned ? null : ((returned = true), { handBack: feasibilityReturn(t.card as unknown as ArchitectFeasibilityCard, 'the parser buffers whole files in memory') })),
        'architect-decompose': (t) => ((t.card as unknown as ArchitectDecomposeCard).revision === null ? { handBack: architect(detailedPlan(M)) } : null),
      }),
    );
    const card = ports.scheduler.card<ArchitectDecomposeCard>('arch.m1.1.2');
    const rendered = assertRevisionCard(ports, card, 'dplan.m1.1.1', detailedPlan(M));
    assert.ok(rendered.includes('## Feasibility findings to answer\n- [F1] capacity (iface): the parser buffers whole files in memory'));
  });

  it("a Secretary's re-plan of a task: the plan in effect in full, with the instruction", async () => {
    const { ports, engine } = await setup();
    let reworks = 0;
    await drive(
      engine,
      ports.scheduler,
      withKinds({
        reviewer: (t) => {
          const c = t.card as unknown as ReviewerCard;
          if (c.target.includes('iface')) return { handBack: reviewer(c, 'pass') };
          reworks++;
          return { handBack: reviewer(c, 'rework', { failing: reworks % 2 === 0 ? 'S2' : 'S1' }) };
        },
        secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'replan', { instructions: 'stream the input instead of buffering it' }) }),
        'architect-decompose': (t) => ((t.card as unknown as ArchitectDecomposeCard).revision === null ? { handBack: architect(detailedPlan(M)) } : null),
      }),
    );
    const card = ports.scheduler.card<ArchitectDecomposeCard>('arch.m1.1.2');
    const rendered = assertRevisionCard(ports, card, 'dplan.m1.1.1', detailedPlan(M));
    assert.ok(rendered.includes('## Instructions\n- Re-plan task impl: stream the input instead of buffering it'));
  });
});

describe('flow: a revision that carries the unchanged tasks over keeps their accepted work (Appendix K, J)', () => {
  it('copying the unchanged tasks from the material: no task is re-specced or rebuilt, the kept products are re-bound, no restart notice', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, happyScript(M));
    const old = { iface: (await current(ports, 'iface'))!, impl: (await current(ports, 'impl'))! };
    // a later decision takes the plan's proof away; the next version maps it
    const w = say(ports, 'Once it has parsed a file, keep the parser read-only.');
    await recordItem(ports, { mission: M, item: 'd1', type: 'decision', text: 'The parser is read-only once it has parsed a file', source: { kind: 'words', words: w, quote: 'keep the parser read-only' } });
    assert.equal((await labelsOf(ports, [old.impl]))[old.impl], 'not-fully-proven');
    await submitPmBatch(ports, { mission: M, plan: plan2(['g1', 'd1']), userWords: [w], changedItems: ['d1'] });
    // the Architect copies every task from the previous plan as the material gives it, and adds one
    let copied = false;
    const ran = await drive(
      engine,
      ports.scheduler,
      withKinds({
        'architect-decompose': (t) => {
          const card = t.card as unknown as ArchitectDecomposeCard;
          const { doc } = previousFromMaterial(ports, card);
          copied = true;
          return { handBack: architect({ ...doc, tasks: [...doc.tasks, docsTask()] }) };
        },
      }),
    );
    assert.ok(copied);
    assert.equal((await labelsOf(ports, ['dplan.m1.2.1']))['dplan.m1.2.1'], 'proven');
    for (const t of ['iface', 'impl']) {
      assert.ok(!ran.some((x) => x.startsWith(`con.m1.${t}.`) || x.startsWith(`rev.m1.${t}.`)), `${t} is neither rebuilt nor judged again: ${ran.join(', ')}`);
      assert.equal((await lineEvents(ports, t, 'spec')).length, 1, `${t} keeps its card`);
      assert.deepEqual(await lineEvents(ports, t, 'rework'), [], `${t} is not restarted`);
      assert.deepEqual((await lineEvents<{ how: string }>(ports, t, 'rebind')).map((e) => e.body.how), ['carried'], `${t} is re-bound without a seat`);
    }
    const iface = (await current(ports, 'iface'))!;
    const impl = (await current(ports, 'impl'))!;
    assert.deepEqual([iface, impl], ['prod.con.m1.iface.1.b1', 'prod.con.m1.impl.1.b1']);
    assert.ok(ran.includes('con.m1.docs.1'), 'the new task is built');
    const docs = (await current(ports, 'docs'))!;
    assert.deepEqual(await labelsOf(ports, [iface, impl, docs]), { [iface]: 'proven', [impl]: 'proven', [docs]: 'proven' });
    assert.deepEqual(ports.ledger.notices.filter((n) => n.category === 'plan-revision-restarts-work'), [], 'nothing to tell: no work restarts');
  });

  it('a revision that rewrites cards: the PM is told, before the reviews, which accepted work and which work under way it would restart, and what it drops', async () => {
    const { ports, engine } = await setup();
    const three = () => detailedPlan(M, { extraTask: true });
    // the implementation's review is held: the interface is accepted, the implementation under way, the integration not started
    await drive(engine, ports.scheduler, withKinds({ reviewer: (t, s) => ((t.card as unknown as ReviewerCard).target.includes('impl') ? null : happyScript(M, three)(t, s)) }, three));
    assert.ok((await current(ports, 'iface')) !== null);
    assert.equal(await current(ports, 'impl'), null);
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: ['W-1'] });
    const rewritten = (): DetailedPlanDoc => {
      const p = three();
      return {
        ...p,
        tasks: p.tasks
          .filter((t) => t.id !== 'docs')
          .map((t) => (t.id === 'iface' ? { ...t, estimate: { ...t.estimate, durationMs: 90_000 } } : t.id === 'impl' ? { ...t, goal: 'Implement the read-only parser with unit tests' } : t)),
      };
    };
    const ran = await drive(
      engine,
      ports.scheduler,
      withKinds({ 'architect-decompose': () => ({ handBack: architect(rewritten()) }), 'architect-feasibility': () => null, reviewer: () => null }, three),
    );
    assert.ok(ran.includes('arch.m1.2.1') && !ran.some((x) => x.startsWith('feas.')), ran.join(', '));
    assert.ok(ports.scheduler.queued('architect-feasibility').some((t) => t.task === 'feas.dplan.m1.2.1'), 'nothing is held: the feasibility review is queued');
    const n = ports.ledger.notices.filter((x) => x.category === 'plan-revision-restarts-work');
    assert.equal(n.length, 1);
    assert.equal(n[0]!.wi, null);
    assert.equal(n[0]!.key, 'dplan.m1.2.1');
    assert.deepEqual(n[0]!.detail, { dplan: 'dplan.m1.2.1', inEffect: 'dplan.m1.1.1', tasks: 3, kept: 0, changed: ['iface', 'impl'], dropped: ['docs'], accepted: ['iface'], underWay: ['impl'] });
    assert.match(n[0]!.trigger, /changes the card of 2 and drops 1 of the 3 tasks of the plan in effect \(dplan\.m1\.1\.1\), keeping 0; accepted work it would restart or drop: iface; work under way: impl/);
    // told once
    await drive(engine, ports.scheduler, withKinds({ 'architect-feasibility': () => null, reviewer: () => null }, three));
    assert.equal(ports.ledger.notices.filter((x) => x.category === 'plan-revision-restarts-work').length, 1);
  });
});
