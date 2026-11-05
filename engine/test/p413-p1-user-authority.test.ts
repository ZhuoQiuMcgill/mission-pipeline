// 4.1.3 part P1: the user's say on the process, and the dead ends on the delivery side
// (DesignDoc_UserAuthority v01: E-1, E-2; DesignDoc_ExecutionRedundancy v01: D-10, D-11; field issues
// #22, #23, #35, #41; field commits planReviewsWaived and startOnHandback). Every test here fails on
// the field branch (a5a9e7b): the plan reviews are waived on the user's words and labelled, a plan in
// effect never goes back through its reviews, an integration task judges the tree that is delivered,
// "replan" always leads somewhere, a loop-exhausted task can be accepted with its risks, a repair may
// change the card of a task with no accepted product, `after` names elements or explorations alike,
// and a cycle over `after` is refused. The flows run on a real project memory with scripted seats.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { WI_CATALOG } from '../src/common/records.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import { mechanicalCheck } from '../src/flow/mechanical.ts';
import { afterCycle, afterOf, type DetailedPlanDoc, type DetailedTask, type PmPlanDoc } from '../src/flow/plandoc.ts';
import { planInEffect, submitPmBatch, AFTER_CYCLE } from '../src/flow/planning.ts';
import type { FlowProject } from '../src/flow/ports.ts';
import { repairsOf } from '../src/flow/repair.ts';
import { answerEscalation } from '../src/flow/secretary.ts';
import { cal1Pass, constructorDone, detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { planReviewsWaiverIn, waiverLabel } from '../src/flow/waivers.ts';
import { pmClose } from '../src/process/close.ts';
import { acceptedOutputs } from '../src/process/finish.ts';
import { pmRepair, pmWaive, readSteps } from '../src/process/pm.ts';
import { processContext } from '../src/process/context.ts';
import type { ConstructorCard, ReviewerCard } from '../src/seat/card.ts';
import { renderArchitectDecompose, repairProblems, type ArchitectDecomposeCard, type ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { buildGraph, resolveNodes, walk } from '../src/cli/tree.ts';
import { showItem } from '../src/cli/status.ts';
import type { Project } from '../src/cli/project.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;

async function setup(mode: 'stable' | 'fast' = 'fast', project?: FlowProject): Promise<{ ports: World; engine: FlowEngine }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode });
  return { ports, engine: new FlowEngine(project === undefined ? ports : { ...ports, project }) };
}

function withKinds(over: Record<string, Script>, plan?: () => DetailedPlanDoc): Script {
  const base = happyScript(M, plan);
  return (t, s) => (Object.hasOwn(over, t.card.seat) ? (over[t.card.seat] as Script) : base)(t, s);
}

const tasksOf = (ports: World): string[] => [...ports.scheduler.tasks.keys()];
const stateOf = (ports: World, task: string): string | undefined => ports.scheduler.tasks.get(task)?.state;
const events = async <B>(ports: World, line: string, event?: string) => (await ports.ledger.events<B>({ mission: M, line, ...(event !== undefined ? { event } : {}) })).map((e) => ({ key: e.key, body: e.body, revision: e.revision }));
const project = (ports: World): Project => ({ ctx: ports.ctx, dir: ports.dir } as unknown as Project);

function assertNoticesHaveWi(notices: ReadonlyArray<{ category: string; wi: string | null }>, normal: readonly string[] = []): void {
  const ok = new Set(['calibrator-1-returned', 'secretary-decision', 'needs-user-decision', 'plan-revision-restarts-work', 'repair-decided', ...normal]);
  for (const n of notices) {
    if (n.wi === null) assert.ok(ok.has(n.category), `notice ${n.category} has no WI but is not a normal branch`);
    else assert.ok(WI_CATALOG.has(n.wi) || n.wi === 'WI-24', `notice ${n.category} names unknown WI ${n.wi}`);
  }
}

const ESTIMATE = { durationMs: 60_000, costMicros: 100_000, basis: 'small' };

/** iface → impl, impl2 → integ (an integration task that writes nothing). */
function integrationPlan(): DetailedPlanDoc {
  const base = detailedPlan(M);
  const impl = base.tasks[1] as DetailedTask;
  return {
    ...base,
    modules: [...base.modules, { id: 'parser2', writeScope: ['src/parser/impl2/**'], provenance: { planElements: ['e2'] } }],
    tasks: [
      ...base.tasks,
      { ...impl, id: 'impl2', module: 'parser2', goal: 'Implement the streaming parser', writeScope: ['src/parser/impl2/**'], verificationCommands: [{ id: 'test2', command: 'npm run test2' }] },
      { id: 'integ', kind: 'integration', module: null, goal: 'Both parsers work together', standards: [{ id: 'S1', text: 'The parsers agree on every sample' }], requirementItems: [], writeScope: [], readableFiles: [], interpreter: '', verificationCommands: [{ id: 'unit', command: 'npm run unit' }], implements: [], calls: [], dependsOn: ['impl', 'impl2'], exclusive: [], estimate: ESTIMATE, provenance: { planElements: ['e1', 'e2'] } },
    ],
  };
}

function fixTask(id: string, over: Partial<DetailedTask> = {}): DetailedTask {
  return { id, kind: 'implementation', module: 'parser', goal: `Fix ${id}`, standards: [{ id: 'S1', text: `${id} works` }], requirementItems: [], writeScope: [`src/parser/${id}.ts`], readableFiles: [], interpreter: 'node', verificationCommands: [{ id: 'test', command: 'npm run unit' }], implements: [], calls: [], dependsOn: ['impl'], exclusive: [], estimate: ESTIMATE, provenance: 'architect', ...over };
}

const REVIEW_SEATS = new Set(['architect-feasibility', 'calibrator-2']);
const reviewTasks = (ports: World): string[] => [...ports.scheduler.tasks.values()].filter((t) => REVIEW_SEATS.has(t.spec.card.seat)).map((t) => t.spec.task);

/** Reviews of impl send it back every time (a new finding each, so the loop runs out on its count). */
function implAlwaysRework(): Script {
  let n = 0;
  return (t) => {
    const c = t.card as unknown as ReviewerCard;
    if (!c.target.includes('impl')) return { handBack: reviewer(c, 'pass') };
    return { handBack: reviewer(c, 'rework', { failing: 'S2', findings: [`slow on big files (${++n})`] }) };
  };
}

// ---------------------------------------------------------------- 1. waiving the plan reviews (E-2)

describe('P1 item 1: the plan reviews are waived on the user\'s words, on the record', () => {
  it('a waiver on W-n: the plan takes effect after the mechanical checks, no feasibility or Calibrator ② runs, and every read says so', async () => {
    const { ports, engine } = await setup('fast');
    const w2 = say(ports, 'I decide the plan myself: skip the plan reviews for this mission.');
    const r = await pmWaive(ports.ctx, { mission: M, check: 'plan-reviews', words: w2, reason: 'the user decides the plan' });
    assert.equal(r.recorded, true);
    await drive(engine, ports.scheduler, happyScript(M));
    assert.deepEqual(reviewTasks(ports), [], 'no feasibility review and no Calibrator ② was queued');
    const eff = (await events<{ reviewsWaived?: unknown }>(ports, 'plan', 'effective')).find((e) => e.key === 'dplan.m1.1.1');
    assert.deepEqual(eff?.body.reviewsWaived, { by: 'words', ref: w2, reason: 'the user decides the plan', skipped: ['feasibility', 'calibrator-2'] });
    const label = `this plan took effect without its reviews (feasibility, Calibrator ②), on ${w2}; reason: the user decides the plan`;
    // mp read show plan, mp read why
    const shown = await showItem(project(ports), 'plan', 'dplan.m1.1.1');
    assert.ok(shown?.text.includes(label), shown?.text);
    const g = buildGraph(ports.ctx, { mission: M });
    const why = walk(ports.ctx, g, resolveNodes(g, ports.ctx, 'prod.con.m1.impl.1'), 'back').text;
    assert.ok(why.includes(label), why);
    // the work went on, and the close snapshot says the plan took effect without its reviews
    assert.notEqual(await acceptedProduct(flowCtx(ports, M), 'impl'), null);
    const closed = await pmClose(ports.ctx, M, { mode: 'with-risk' });
    assert.deepEqual(closed.doc.planReviews?.map((p) => [p.dplan, p.by, p.ref]), [['dplan.m1.1.1', 'words', w2]]);
    assert.ok(closed.risks.includes(`plan dplan.m1.1.1: ${label}`), closed.risks.join('\n'));
    assert.ok(closed.message.includes('Plans that took effect without their reviews: dplan.m1.1.1'), closed.message);
  });

  it('under an authorization in force; the full run\'s check is reused, so a goal item is refused; only plan-reviews is waivable', async () => {
    const { ports, engine } = await setup('fast');
    await assert.rejects(() => pmWaive(ports.ctx, { mission: M, check: 'plan-reviews', authority: 'g1' }), /g1 is not an authorization item in force in mission m1 \(it is a goal item\): nothing was recorded/);
    await assert.rejects(() => pmWaive(ports.ctx, { mission: M, check: 'feasibility', words: 'W-1' }), /only plan-reviews .* is waivable/);
    await assert.rejects(() => pmWaive(ports.ctx, { mission: M, check: 'plan-reviews' }), /rests on the user's words .* or on an authorization item in force/);
    await pmWaive(ports.ctx, { mission: M, check: 'plan-reviews', authority: 'a1' });
    await drive(engine, ports.scheduler, happyScript(M));
    assert.deepEqual(reviewTasks(ports), []);
    const eff = (await events<{ reviewsWaived?: { by: string; ref: string } }>(ports, 'plan', 'effective'))[0];
    assert.deepEqual([eff?.body.reviewsWaived?.by, eff?.body.reviewsWaived?.ref], ['authority', 'item.m1.a1']);
    const label = waiverLabel(eff!.body.reviewsWaived as never);
    assert.ok(label.includes('under authorization item.m1.a1'), label);
  });

  it('one detailed plan version: the later plans get their reviews; a waiver of a plan in effect is refused', async () => {
    const { ports, engine } = await setup('fast');
    const w2 = say(ports, 'Skip the reviews of this first plan only.');
    await pmWaive(ports.ctx, { mission: M, check: 'plan-reviews', plan: 'dplan.m1.1.1', words: w2 });
    await drive(engine, ports.scheduler, happyScript(M));
    assert.deepEqual(reviewTasks(ports), []);
    await assert.rejects(() => pmWaive(ports.ctx, { mission: M, check: 'plan-reviews', plan: 'dplan.m1.1.1', words: w2 }), /in effect already/);
    await assert.rejects(() => pmWaive(ports.ctx, { mission: M, check: 'plan-reviews', plan: 'dplan.other.1.1', words: w2 }), /names a detailed plan version of mission m1/);
    // a re-plan: the next version has its reviews again
    const p = pmPlan(M);
    await submitPmBatch(ports, { mission: M, plan: { ...p, elements: p.elements.map((e) => (e.id === 'e2' ? { ...e, text: 'Covered by unit tests, every edge case' } : e)) }, userWords: ['W-1'], mode: 'fast' });
    await drive(engine, ports.scheduler, happyScript(M));
    assert.deepEqual(reviewTasks(ports), ['feas.dplan.m1.2.1', 'cal2.dplan.m1.2.1']);
    assert.equal((await events<{ reviewsWaived?: unknown }>(ports, 'plan', 'effective')).find((e) => e.key === 'dplan.m1.2.1')?.body.reviewsWaived, undefined);
  });

  it('withdrawal: later plans get their reviews again, the plan in effect stays in effect, and the Architect\'s revision card says the plan it revises took effect without its reviews', async () => {
    const { ports, engine } = await setup('fast');
    const w2 = say(ports, 'Skip the plan reviews.');
    await pmWaive(ports.ctx, { mission: M, check: 'plan-reviews', words: w2 });
    await drive(engine, ports.scheduler, happyScript(M));
    const w3 = say(ports, 'From now on review the plans again.');
    const r = await pmWaive(ports.ctx, { mission: M, check: 'plan-reviews', withdraw: true, words: w3 });
    assert.equal(r.recorded, true);
    assert.equal((await pmWaive(ports.ctx, { mission: M, check: 'plan-reviews', withdraw: true, words: w3 })).recorded, false, 'nothing left to withdraw');
    await drive(engine, ports.scheduler, happyScript(M));
    assert.deepEqual(reviewTasks(ports), [], 'the plan in effect does not go back through its reviews');
    assert.equal((await planInEffect(flowCtx(ports, M)))?.eff.dplan, 'dplan.m1.1.1');
    const p = pmPlan(M);
    await submitPmBatch(ports, { mission: M, plan: { ...p, elements: p.elements.map((e) => (e.id === 'e2' ? { ...e, text: 'Covered by unit tests, every edge case' } : e)) }, userWords: ['W-1'], mode: 'fast' });
    await drive(engine, ports.scheduler, happyScript(M));
    assert.deepEqual(reviewTasks(ports), ['feas.dplan.m1.2.1', 'cal2.dplan.m1.2.1']);
    const arch = ports.scheduler.card<ArchitectDecomposeCard>('arch.m1.2.1');
    assert.equal(arch.planReviews?.previous, `this plan took effect without its reviews (feasibility, Calibrator ②), on ${w2}`);
    assert.equal(arch.planReviews?.next, null);
    assert.ok(renderArchitectDecompose(arch).includes(`The plan this revision revises: this plan took effect without its reviews (feasibility, Calibrator ②), on ${w2}.`));
  });

  it('stable mode (the default): the gate reads the waived plan as settled by the waiver, so the work starts; the labels stay honest (sol review: the mission stalled)', async () => {
    const { ports, engine } = await setup('stable');
    const w2 = say(ports, 'Skip the plan reviews.');
    const r = await pmWaive(ports.ctx, { mission: M, check: 'plan-reviews', words: w2 });
    assert.ok(r.notes.some((x) => x.includes('stable mode') && x.includes('not fully proven')), r.notes.join('; '));
    await drive(engine, ports.scheduler, happyScript(M));
    assert.ok(tasksOf(ports).includes('con.m1.iface.1') && tasksOf(ports).includes('con.m1.impl.1'), `the tasks were dispatched: ${tasksOf(ports).join(', ')}`);
    assert.equal(await acceptedProduct(flowCtx(ports, M), 'impl'), 'prod.con.m1.impl.1', 'the dependent started on its dependency, which relies on the waived plan');
    const labels = (await ports.evaluator.labels(['dplan.m1.1.1', 'prod.con.m1.iface.1', 'prod.con.m1.impl.1'])).labels;
    assert.notEqual(labels['dplan.m1.1.1'], 'proven', 'nothing calls the plan reviewed');
    assert.equal(labels['prod.con.m1.impl.1'], 'not-fully-proven');
    assert.ok(!ports.ledger.notices.some((n) => n.category === 'plan-reviews-waived-stable'));
  });

  it('the config key (field 4.1.2) still waives, labelled "no words on record"; a plan that took effect by it before 4.1.3 reads the same, derived from the record', async () => {
    const proj: FlowProject = { localCommands: [], fullSuite: [], planReviewsWaived: [M] };
    const { ports, engine } = await setup('fast', proj);
    await drive(engine, ports.scheduler, happyScript(M));
    assert.deepEqual(reviewTasks(ports), []);
    const all = await ports.ledger.events({ mission: M, line: 'plan' });
    const eff = all.find((e) => e.event === 'effective' && e.key === 'dplan.m1.1.1')!;
    assert.deepEqual((eff.body as { reviewsWaived?: unknown }).reviewsWaived, { by: 'config', ref: 'planReviewsWaived', reason: null, skipped: ['feasibility', 'calibrator-2'] });
    // the field's own record: its "effective" event has no reviewsWaived, and no Calibrator ② outcome exists
    const field = all.map((e) => (e === eff ? { ...e, body: { ...(e.body as Record<string, unknown>), reviewsWaived: undefined } } : e)).map((e) => ({ event: e.event, key: e.key, body: JSON.parse(JSON.stringify(e.body)) as unknown }));
    const w = planReviewsWaiverIn(field, M, 'dplan.m1.1.1', [], ['calibrator-2', 'feasibility']);
    assert.equal(w === null ? null : waiverLabel(w), 'this plan took effect without its reviews (feasibility, Calibrator ②), waived by config `planReviewsWaived`; no words on record');
    // a read in a project that still sets the key shows the same label
    const ctx = processContext(ports.memory, { planReviewsWaived: [M] });
    const g = buildGraph(ctx, { mission: M });
    assert.ok(walk(ctx, g, resolveNodes(g, ctx, 'dplan.m1.1.1'), 'back').text.includes('waived by config `planReviewsWaived`; no words on record'));
  });

  it('the cause of #35: the config key removed after the plan took effect; the plan stays in effect without its reviews and a re-plan is routed at once', async () => {
    const proj: FlowProject = { localCommands: [], fullSuite: [], planReviewsWaived: [M] };
    const { ports, engine } = await setup('fast', proj);
    // impl's loop runs out while the key is set; then the key is removed and the Secretary decides "replan"
    await drive(engine, ports.scheduler, withKinds({ reviewer: implAlwaysRework(), secretary: () => null }));
    assert.ok(ports.scheduler.queued('secretary').length === 1, 'the loop-exhausted escalation waits');
    const later = new FlowEngine(ports);
    await drive(later, ports.scheduler, withKinds({ reviewer: implAlwaysRework(), secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'replan', { instructions: 'split the parser' }) }), 'architect-decompose': () => null }));
    assert.deepEqual(reviewTasks(ports), [], 'the plan in effect does not go back through feasibility and Calibrator ②');
    assert.ok(tasksOf(ports).includes('arch.m1.1.2'), `the Architect re-plan step is queued: ${tasksOf(ports).join(', ')}`);
    // it was routed in the write that recorded the request
    const request = (await events(ports, 'plan', 'replan-request'))[0]!;
    const attempt = (await events<{ reason: string; instructions: string[] }>(ports, 'plan', 'attempt')).find((e) => e.key === 'pmplan.m1.1#2')!;
    assert.equal(attempt.body.reason, 'replan');
    assert.ok(attempt.body.instructions.some((i) => i.includes('Re-plan task impl: split the parser')));
    assert.ok(ports.ledger.appended.includes(`flow:replan-request:m1:${request.key}`));
    assert.ok(!ports.ledger.appended.some((op) => op.startsWith('flow:attempt:m1:pmplan.m1.1:2')), 'the Architect attempt was written with the request, not by a later write');
    assert.ok(attempt.revision > request.revision && attempt.revision - request.revision <= 3, 'in the same write');
  });
});

// ---------------------------------------------------------------- 2. an integration task judges what is delivered (#41)

describe('P1 item 2: an integration task judges what will be delivered (#41)', () => {
  it('a repair adds two tasks after the integration started: it starts again, its new start holds their work, and its candidate is what mp pm deliver builds', async () => {
    const { ports, engine } = await setup('fast');
    const integNotYet: Script = withKinds({ reviewer: (t) => ((t.card as unknown as ReviewerCard).target.includes('integ') ? null : { handBack: reviewer(t.card as unknown as ReviewerCard, 'pass') }) }, integrationPlan);
    await drive(engine, ports.scheduler, integNotYet);
    assert.equal(stateOf(ports, 'rev.m1.integ.1'), 'queued', 'the integration Reviewer waits to be dispatched');
    const w2 = say(ports, 'Two parsers miss the BOM and the trailing comma.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'missing', text: 'miss the BOM and the trailing comma' });
    await drive(engine, ports.scheduler, withKinds({ 'architect-repair': () => ({ handBack: { reopen: [], add: [fixTask('fixbom'), fixTask('fixcomma')], note: 'two small tasks' } }), reviewer: (t) => ((t.card as unknown as ReviewerCard).target.includes('integ') ? null : { handBack: reviewer(t.card as unknown as ReviewerCard, 'pass') }) }, integrationPlan));
    assert.notEqual(stateOf(ports, 'rev.m1.integ.1'), 'queued', 'the Reviewer of the old start is cancelled');
    const rw = (await events<{ reason: string; instructions: string[] }>(ports, 'task:integ', 'rework')).map((e) => e.body);
    assert.equal(rw[0]?.reason, 'rebuild');
    assert.ok(rw[0]?.instructions[0]?.includes('fixbom (added by repair R-1)'), rw[0]?.instructions[0]);
    assert.ok(ports.ledger.notices.some((n) => n.category === 'integration-restarted'));
    await drive(engine, ports.scheduler, happyScript(M, integrationPlan));
    const rev = ports.scheduler.card<ReviewerCard>('rev.m1.integ.2');
    assert.deepEqual(rev.integration?.dependencies.filter((d) => d.direct).map((d) => d.task).sort(), ['fixbom', 'fixcomma', 'impl', 'impl2']);
    const prod = await ports.ledger.objectVersion('prod.con.m1.integ.2');
    const pre = ports.ledger.content.getList(prod!.prerequisites);
    assert.ok(pre.includes('prod.con.m1.fixbom.1') && pre.includes('prod.con.m1.fixcomma.1'), pre.join(', '));
    // the integration's tree is the delivered one: its start holds every other accepted output
    const outputs = (await acceptedOutputs(ports.ctx, M)).map((t) => t.id).filter((id) => !id.includes('integ'));
    assert.deepEqual([...pre].sort(), [...(await ports.scheduler.composition(outputs))].sort());
    assert.notEqual(await acceptedProduct(flowCtx(ports, M), 'integ'), null);
    assertNoticesHaveWi(ports.ledger.notices, ['integration-restarted']);
  });

  it('a Reviewer in flight finishes; its hand-back counts for the old tree only, and the integration starts again on the new one', async () => {
    const { ports, engine } = await setup('fast');
    const integHeld: Script = withKinds({ reviewer: (t) => ((t.card as unknown as ReviewerCard).target.includes('integ') ? null : { handBack: reviewer(t.card as unknown as ReviewerCard, 'pass') }) }, integrationPlan);
    await drive(engine, ports.scheduler, integHeld);
    const d = ports.scheduler.dispatchOf('rev.m1.integ.1');
    assert.ok(d.startsWith('D-'));
    const w2 = say(ports, 'The parser misses the BOM.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'missing', text: 'misses the BOM' });
    await drive(engine, ports.scheduler, withKinds({ 'architect-repair': () => ({ handBack: { reopen: [], add: [fixTask('fixbom')], note: 'one task' } }), reviewer: (t) => ((t.card as unknown as ReviewerCard).target.includes('integ') ? null : { handBack: reviewer(t.card as unknown as ReviewerCard, 'pass') }) }, integrationPlan));
    assert.ok(ports.ledger.notices.some((n) => n.category === 'integration-start-stale' && n.defaultAction.includes('counts for the tree it was given only')), ports.ledger.notices.map((n) => n.category).join(', '));
    // the old tree's Reviewer hands back a pass: not an acceptance of the integration
    assert.deepEqual(await ports.scheduler.run('rev.m1.integ.1', { handBack: reviewer(ports.scheduler.card<ReviewerCard>('rev.m1.integ.1'), 'pass') }), []);
    await drive(engine, ports.scheduler, happyScript(M, integrationPlan));
    const acc = (await events<{ k: number }>(ports, 'task:integ', 'accepted')).map((e) => e.body.k);
    assert.deepEqual(acc, [2], 'accepted on the new tree only');
    const pre = ports.ledger.content.getList((await ports.ledger.objectVersion('prod.con.m1.integ.2'))!.prerequisites);
    assert.ok(pre.includes('prod.con.m1.fixbom.1'));
  });
});

// ---------------------------------------------------------------- startOnHandback reads correctly with item 2 and repairs

describe('P1 item 1: startOnHandback stays a project setting and removes no check', () => {
  it('a dependent starts on a verified hand-back in review, but is accepted only once its dependency is, on that version; a version sent back is carried onto the next', async () => {
    const proj: FlowProject = { localCommands: [], fullSuite: [], startOnHandback: [M] };
    const { ports, engine } = await setup('fast', proj);
    let ifaceReviews = 0;
    // iface's first review is held back while impl starts on its hand-back and passes
    await drive(engine, ports.scheduler, withKinds({ reviewer: (t) => ((t.card as unknown as ReviewerCard).target.includes('iface') ? null : { handBack: reviewer(t.card as unknown as ReviewerCard, 'pass') }) }));
    assert.ok(tasksOf(ports).includes('con.m1.impl.1'), 'impl started on iface\'s verified hand-back');
    assert.equal((await events(ports, 'task:impl', 'review')).length, 1, 'impl was reviewed');
    assert.equal(await acceptedProduct(flowCtx(ports, M), 'impl'), null, 'impl is not accepted while iface is in review (field bug)');
    // iface's review sends it back: impl's work is carried onto iface's next version, then both are accepted
    await drive(engine, ports.scheduler, withKinds({ reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return c.target.includes('iface') && ifaceReviews++ === 0 ? { handBack: reviewer(c, 'rework') } : { handBack: reviewer(c, 'pass') }; } }));
    const rw = (await events<{ reason: string }>(ports, 'task:impl', 'rework')).map((e) => e.body.reason);
    assert.deepEqual(rw, ['program'], 'carried onto iface\'s next version (not counted on its rework loop)');
    assert.ok(ports.ledger.notices.some((n) => n.category === 'early-start-rebuilt'));
    const acc = await acceptedProduct(flowCtx(ports, M), 'impl');
    assert.equal(acc, 'prod.con.m1.impl.2');
    const pre = ports.ledger.content.getList((await ports.ledger.objectVersion(acc!))!.prerequisites);
    assert.ok(pre.includes('prod.con.m1.iface.2') && !pre.includes('prod.con.m1.iface.1'), pre.join(', '));
    const dispatched = (await events<{ predecessor?: string | null }>(ports, 'task:impl', 'dispatched')).at(-1)!.body;
    assert.equal(dispatched.predecessor, 'prod.con.m1.impl.1', 'the earlier work is carried on');
  });

  it('an integration task never starts early: it judges the delivered tree', async () => {
    const proj: FlowProject = { localCommands: [], fullSuite: [], startOnHandback: [M] };
    const { ports, engine } = await setup('fast', proj);
    await drive(engine, ports.scheduler, withKinds({ reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return c.target.includes('impl2') ? null : { handBack: reviewer(c, 'pass') }; } }, integrationPlan));
    assert.ok(!tasksOf(ports).some((t) => t.startsWith('rev.m1.integ.')), `the integration waits for impl2's acceptance: ${tasksOf(ports).join(', ')}`);
  });
});

// ---------------------------------------------------------------- 3. no dead end after a loop is exhausted (#35)

describe('P1 item 3: no dead end after a loop is exhausted (#35, E-1)', () => {
  it('accept-risk: the decision accepts the verified product, the open findings go to the risk list quoted, the ruling is the Secretary\'s; nothing is written in the Reviewer\'s place', async () => {
    const { ports, engine } = await setup('stable');
    const cards: SecretaryCard[] = [];
    await drive(engine, ports.scheduler, withKinds({ reviewer: implAlwaysRework(), secretary: (t) => { const c = t.card as unknown as SecretaryCard; cards.push(c); return { handBack: secretary(c, 'accept-risk', { classification: 'important-within-authority', notice: 'accepted with the slow path as a risk' }) }; } }));
    assert.equal(cards.length, 1);
    assert.ok(cards[0]!.options.some((o) => o.id === 'accept-risk'));
    assert.ok(cards[0]!.position !== null, 'the decision rules on the Reviewer\'s position');
    const acc = (await events<{ k: number; product: string; judgment: string; decision?: { by: string; escalation: string }; risks?: string[] }>(ports, 'task:impl', 'accepted'))[0]!.body;
    assert.equal(acc.k, 3);
    assert.equal(acc.decision?.by, 'secretary');
    assert.ok(acc.judgment.startsWith('j.sec.exh.'), acc.judgment);
    assert.ok((acc.risks ?? []).some((r) => r.includes('slow on big files (3)')), JSON.stringify(acc.risks));
    const ruling = await ports.ledger.judgment(acc.judgment);
    assert.equal(ruling?.executor, 'secretary');
    assert.equal(ruling?.verdict, 'pass');
    assert.equal(ruling?.revokes, 'j.rev.m1.impl.3');
    // no Reviewer pass exists on the product: only the Reviewer's rework and the decider's ruling
    const onProduct = (await ports.ledger.records(['judgment'])).map((r) => r.record as { target: string; executor: string; verdict: string }).filter((j) => j.target === acc.product);
    assert.deepEqual(onProduct.map((j) => [j.executor, j.verdict]).sort(), [['reviewer', 'fail'], ['secretary', 'pass']].sort());
    assert.equal((await ports.evaluator.labels([acc.product])).labels[acc.product], 'proven', 'stable mode: the work that depends on it can go on');
    const g = buildGraph(ports.ctx, { mission: M });
    const shown = walk(ports.ctx, g, resolveNodes(g, ports.ctx, acc.product), 'back').text;
    assert.ok(shown.includes('accepted with its risk by the Secretary on exh.'), shown);
    const closed = await pmClose(ports.ctx, M, { mode: 'with-risk' });
    assert.deepEqual(closed.doc.acceptedWithRisk?.map((a) => a.task), ['impl']);
    assert.ok(closed.risks.some((r) => r.startsWith('task impl (prod.con.m1.impl.3): accepted with its risk by the Secretary on exh.') && r.includes('slow on big files (3)')), closed.risks.join('\n'));
  });

  it('accept-risk on the user\'s words: the ruling is the user\'s, cited by words', async () => {
    const { ports, engine } = await setup('fast');
    await drive(engine, ports.scheduler, withKinds({ reviewer: implAlwaysRework(), secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'ask-user') }) }));
    const esc = (await events<{ id: string; source: string }>(ports, 'secretary', 'escalation')).find((e) => e.body.source === 'loop-exhausted')!.body.id;
    const w2 = say(ports, 'Good enough, accept it as it is.');
    await answerEscalation(ports, { mission: M, escalation: esc, option: 'accept-risk', words: `Good enough, accept it as it is. (${w2})` });
    await drive(engine, ports.scheduler, happyScript(M));
    const acc = (await events<{ judgment: string; decision?: { by: string; words?: string } }>(ports, 'task:impl', 'accepted'))[0]!.body;
    assert.equal(acc.judgment, `j.user.${esc}`);
    assert.deepEqual([acc.decision?.by, acc.decision?.words], ['user', w2]);
    assert.equal((await ports.ledger.judgment(acc.judgment))?.executor, 'user');
  });

  it('"replan" with the decision layer busy elsewhere: the PM is told exactly what the routing waits on; a repair that changes the card answers it', async () => {
    const { ports, engine } = await setup('fast');
    await drive(engine, ports.scheduler, withKinds({ reviewer: implAlwaysRework(), secretary: () => null }));
    // a new PM plan waits for Calibrator ① (its step not run yet), so no Architect attempt can start
    const p = pmPlan(M);
    await submitPmBatch(ports, { mission: M, plan: { ...p, elements: p.elements.map((e) => (e.id === 'e2' ? { ...e, text: 'Covered by property tests' } : e)) }, userWords: ['W-1'], mode: 'fast' });
    await drive(engine, ports.scheduler, withKinds({ 'calibrator-1': () => null, secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'replan', { instructions: 'split the parser' }) }) }));
    const n = ports.ledger.notices.find((x) => x.category === 'replan-waits');
    assert.ok(n !== undefined, ports.ledger.notices.map((x) => x.category).join(', '));
    assert.ok(n.trigger.includes('Calibrator ① is checking the latest PM plan pmplan.m1.2') && n.defaultAction.includes('mp pm next') && n.defaultAction.includes('mp pm repair m1 --about impl'), `${n.trigger} / ${n.defaultAction}`);
    assert.equal(n.wi, 'WI-08');
    // the user's repair changes impl's card (the slow-path standard dropped): it answers the re-plan
    const w2 = say(ports, 'Big files do not matter: drop the speed standard of the parser.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'drop the speed standard of the parser', about: 'impl' });
    const impl = detailedPlan(M).tasks[1] as DetailedTask;
    const changed: DetailedTask = { ...impl, standards: [{ id: 'S1', text: 'Parses quoted fields' }] };
    await drive(engine, ports.scheduler, withKinds({ 'architect-repair': () => ({ handBack: { reopen: [], add: [], change: [changed], note: 'the user dropped S2' } }), 'calibrator-1': () => null }));
    assert.deepEqual((await events(ports, 'plan', 'replan-answered')).map((e) => e.key), [(await events(ports, 'plan', 'replan-request'))[0]!.key]);
    assert.deepEqual((await repairsOf(flowCtx(ports, M))).map((r) => [r.state, r.changed]), [['decided', ['impl']]]);
    const spec = (await events<{ repair?: string }>(ports, 'task:impl', 'spec')).at(-1)!.body;
    assert.equal(spec.repair, 'R-1');
    const con = ports.scheduler.card<ConstructorCard>('con.m1.impl.4');
    assert.deepEqual(con.standards.map((s) => s.id), ['S1']);
    assert.ok(con.duties.includes('Repair R-1') && con.duties.includes('carry your earlier work on'), con.duties);
    const dispatched = (await events<{ predecessor?: string | null }>(ports, 'task:impl', 'dispatched')).at(-1)!.body;
    assert.equal(dispatched.predecessor, 'prod.con.m1.impl.3', 'the earlier work is carried on');
    assert.equal(await acceptedProduct(flowCtx(ports, M), 'impl'), 'prod.con.m1.impl.4');
    assert.ok(!tasksOf(ports).some((t) => t.startsWith('arch.m1.1.2') || t.startsWith('arch.m1.2.')), 'no Architect re-plan runs for it');
  });

  it('a repair\'s change: only of a task with no accepted product, the same kind, a real change; an exhausted escalation it makes moot is closed', async () => {
    const { ports, engine } = await setup('fast');
    await drive(engine, ports.scheduler, withKinds({ reviewer: implAlwaysRework(), secretary: () => null }));
    const pie = await planInEffect(flowCtx(ports, M));
    const iface = pie!.plan.tasks[0] as DetailedTask;
    const impl = pie!.plan.tasks[1] as DetailedTask;
    const card = { accepted: [{ task: 'iface', product: 'prod.con.m1.iface.1', attempt: 1, changedPaths: [] }], plan: pie!.plan, elements: [{ id: 'e1', kind: 'deliverable', text: 'x' }, { id: 'e2', kind: 'behavior', text: 'y' }] } as unknown as ArchitectRepairCard;
    assert.ok(repairProblems(card, { reopen: [], add: [], change: [{ ...iface, goal: 'other' }], note: '' }).some((p) => p.includes('has an accepted product')));
    assert.ok(repairProblems(card, { reopen: [], add: [], change: [{ ...impl, kind: 'integration' }], note: '' }).some((p) => p.includes('keeps the task\'s kind')));
    assert.ok(repairProblems(card, { reopen: [], add: [], change: [impl], note: '' }).some((p) => p.includes('the card is unchanged')));
    assert.deepEqual(repairProblems(card, { reopen: [], add: [], change: [{ ...impl, goal: 'Implement the parser simply' }], note: '' }), []);
    const w2 = say(ports, 'Simplify the parser.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'Simplify the parser', about: 'impl' });
    await drive(engine, ports.scheduler, withKinds({ 'architect-repair': () => ({ handBack: { reopen: [], add: [], change: [{ ...impl, goal: 'Implement the parser simply' }], note: 'n' } }), secretary: () => null }));
    const closed = (await events<{ what?: { option?: string; why?: string } }>(ports, 'secretary', 'applied')).find((e) => e.key.startsWith('exh.'));
    assert.equal(closed?.body.what?.option, 'superseded');
    assert.notEqual(await acceptedProduct(flowCtx(ports, M), 'impl'), null);
  });
});

// ---------------------------------------------------------------- 5. `after` resolved in one place (#22), cycles refused (#23)

type Element = PmPlanDoc['elements'][number];
function explore(id: string, x: string, after: string[] = []): Element {
  return { id, kind: 'exploration', text: `the design of ${x}`, provenance: { by: 'pm' }, exploration: { id: x, deliverable: `a design of ${x}`, fuzzyGoal: { quote: 'Build me a CSV parser', words: 'W-1' }, attackScope: ['internal contradiction'], decision: { id: `D-${x}`, type: 'structure' }, budget: { rounds: 3, micros: null }, stop: '', research: false }, after, items: [] };
}

describe('P1 item 5: `after` resolved in one place (#22) and cycles refused (#23)', () => {
  it('#22 reproduced: a deliverable after an exploration element by element id waits for it (the mechanical checks and the decision layer alike)', async () => {
    const base = pmPlan(M);
    const doc: PmPlanDoc = { ...base, elements: [explore('x1', 'XA'), { ...base.elements[0]!, after: ['x1'] }, base.elements[1]!] };
    assert.deepEqual(afterOf(doc, doc.elements[1]!).explorations, ['XA']);
    // e1 waits for XA: a plan that covers only e2 passes; one that plans e1 now is refused
    const onlyE2: DetailedPlanDoc = { ...detailedPlan(M), newInterfaces: [], modules: [{ id: 'parser', writeScope: ['src/parser/**'], provenance: { planElements: ['e2'] } }], tasks: [{ ...(detailedPlan(M).tasks[1] as DetailedTask), implements: [], dependsOn: [] }] };
    const r = await mechanicalCheck({ pmPlan: doc, plan: onlyE2, unsettled: new Set(['XA']), hasSymbol: async () => true });
    assert.deepEqual(r.failures, [], 'e1 waits for XA (element id x1)');
    const both = await mechanicalCheck({ pmPlan: doc, plan: detailedPlan(M), unsettled: new Set(['XA']), hasSymbol: async () => true });
    assert.ok(both.failures.some((f) => f.includes('plans element "e1", which waits for an exploration that has not stood')), both.failures.join('; '));
    // the decision layer: the Architect's card shows e1 waiting for XA
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: doc, userWords: ['W-1'], mode: 'fast' });
    const engine = new FlowEngine(ports);
    await drive(engine, ports.scheduler, withKinds({ 'architect-decompose': () => null }));
    const arch = ports.scheduler.card<ArchitectDecomposeCard>('arch.m1.1.1');
    assert.deepEqual(arch.pmPlan.elements.find((e) => e.id === 'e1')?.after, ['XA']);
    // with only the waiting deliverable, nothing is decomposed until XA stands
    const ports2 = memoryPorts();
    say(ports2, SEED_TEXT);
    await seedMission(ports2, M);
    await submitPmBatch(ports2, { mission: M, plan: { ...doc, elements: [doc.elements[0]!, doc.elements[1]!] }, userWords: ['W-1'], mode: 'fast' });
    await drive(new FlowEngine(ports2), ports2.scheduler, happyScript(M));
    assert.ok(!tasksOf(ports2).some((t) => t.startsWith('arch.')), `no Architect while e1 waits for XA: ${tasksOf(ports2).join(', ')}`);
  });

  it('#23: the PM plan with a cycle over `after` is refused with a named error that lists the cycle', async () => {
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    const base = pmPlan(M);
    const doc: PmPlanDoc = { ...base, elements: [explore('x1', 'XA', ['x2']), explore('x2', 'XB', ['XA']), ...base.elements] };
    assert.deepEqual(afterCycle(doc), ['x1 (XA)', 'x2 (XB)', 'x1 (XA)']);
    await assert.rejects(() => submitPmBatch(ports, { mission: M, plan: doc, userWords: ['W-1'], mode: 'fast' }), (e: unknown) => (e as { code?: string }).code === AFTER_CYCLE && /form a cycle: x1 \(XA\) → x2 \(XB\) → x1 \(XA\)/.test((e as Error).message));
    assert.equal((await ports.ledger.events({ mission: M, line: 'plan', event: 'pm-batch' })).length, 0, 'nothing recorded');
    assert.equal(afterCycle({ elements: [explore('x1', 'XA', ['x1']), ...base.elements] }), null, 'its own id is no wait');
  });

  it('#23: a plan in effect with a cycle (recorded before the check) is not refused after the fact: the PM is told, and mp pm next names the cycle', async () => {
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    const base = pmPlan(M);
    const doc: PmPlanDoc = { ...base, elements: [explore('x1', 'XA', ['x2']), explore('x2', 'XB', ['x1']), ...base.elements] };
    // the field's record: the batch as 4.1.2 recorded it, without the check
    await submitPmBatch(ports, { mission: M, plan: { ...doc, elements: [explore('x1', 'XA'), explore('x2', 'XB'), ...base.elements] }, userWords: ['W-1'], mode: 'fast' });
    const batch = (await ports.ledger.events<Record<string, unknown>>({ mission: M, line: 'plan', event: 'pm-batch' }))[0]!;
    const cyclic = ports.ledger.content.put(JSON.stringify(doc));
    const rec = await ports.ledger.objectVersion('pmplan.m1.1');
    // a second version recorded as the field branch would (the same record shapes)
    ports.ledger.commit([{ ...rec!, object: 'pmplan.m1.2' as never, content: cyclic as never, predecessor: 'pmplan.m1.1' as never }]);
    await ports.ledger.append('field-batch-2', { events: [{ mission: M, line: 'plan', event: 'pm-batch', key: 'b2', body: { ...batch.body, batch: 'b2', n: 2, plan: 'pmplan.m1.2', predecessor: 'pmplan.m1.1', doc: cyclic } }] });
    await drive(new FlowEngine(ports), ports.scheduler, withKinds({ 'architect-decompose': () => null }));
    const n = ports.ledger.notices.find((x) => x.category === 'after-cycle');
    assert.ok(n !== undefined && n.trigger.includes('x1 (XA) → x2 (XB) → x1 (XA)') && n.wi === 'WI-16', JSON.stringify(ports.ledger.notices.map((x) => x.category)));
    const held = readSteps(ports.ctx).held.filter((h) => h.kind === 'researcher-author');
    assert.ok(held.length > 0 && held.every((h) => h.why.includes('they wait for each other')), JSON.stringify(held.map((h) => h.why)));
  });
});

// ---------------------------------------------------------------- 6. #40 still holds with a changed card

describe('P1 item 6: a changed card does not reopen #40', () => {
  it('a changed card that keeps a reused interface whose file accepted work renamed passes; one that adds that use fails', async () => {
    const base = detailedPlan(M);
    const stale = { name: 'Conventions', file: 'docs/conventions_v01.md', location: 'section 2', provenance: { planElements: ['e1'] } };
    const hasSymbol = async (file: string): Promise<boolean> => file !== 'docs/conventions_v01.md';
    const tasks = base.tasks.map((t) => (t.id === 'impl' ? { ...t, calls: ['Conventions'] } : t));
    const plan = { ...base, reusedInterfaces: [stale], tasks };
    const before = tasks.find((t) => t.id === 'impl') as DetailedTask;
    const changed = { ...before, goal: 'Implement the parser simply' };
    const ok = await mechanicalCheck({ pmPlan: pmPlan(M), plan: { ...plan, tasks: tasks.map((t) => (t.id === 'impl' ? changed : t)) }, unsettled: new Set(), hasSymbol, amendment: { added: new Set(), changed: new Map([['impl', before]]) } });
    assert.equal(ok.ok, true, JSON.stringify(ok.failures));
    const ifaceBefore = tasks.find((t) => t.id === 'iface') as DetailedTask;
    const adds = { ...ifaceBefore, calls: ['Conventions'] };
    const bad = await mechanicalCheck({ pmPlan: pmPlan(M), plan: { ...plan, tasks: tasks.map((t) => (t.id === 'iface' ? adds : t)) }, unsettled: new Set(), hasSymbol, amendment: { added: new Set(), changed: new Map([['iface', ifaceBefore]]) } });
    assert.deepEqual(bad.failures, ['interfaces: reused interface Conventions is not found in docs/conventions_v01.md of the snapshot']);
  });
});

void constructorDone;
void cal1Pass;

// ---------------------------------------------------------------- the command line: mp pm waive, mp config

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach } from 'node:test';
import { cli } from './cli-fixtures.ts';
import { processProject, type ProcessProject } from './process-fixtures.ts';

let cliProject: ProcessProject | null = null;
afterEach(() => {
  cliProject?.cleanup();
  cliProject = null;
});

describe('P1 item 1: mp pm waive and mp config', () => {
  it('mp pm waive records the waiver on the words, refuses it without who decided, withdraws it; mp config warns that planReviewsWaived is deprecated', async () => {
    cliProject = processProject();
    const dir = cliProject.dir;
    assert.equal((await cli(dir, ['pm', 'say', 'Skip the plan reviews of m1: I decide the plan.'])).code, 0);
    const none = await cli(dir, ['pm', 'waive', 'm1', 'plan-reviews']);
    assert.notEqual(none.code, 0);
    assert.match(none.err, /needs who decided it: --words W-<n>/);
    const other = await cli(dir, ['pm', 'waive', 'm1', 'mechanical', '--words', 'W-1']);
    assert.match(other.err, /only plan-reviews .* is waivable/);
    const ok = await cli(dir, ['pm', 'waive', 'm1', 'plan-reviews', '--words', 'W-1', '--reason', 'the user decides the plan']);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /Plan reviews waived on W-1 for every plan of mission m1 not in effect yet/);
    const back = await cli(dir, ['pm', 'waive', 'm1', 'plan-reviews', '--withdraw', '--words', 'W-1']);
    assert.match(back.out, /withdrawn on W-1: plans not in effect yet get their feasibility review and Calibrator ② again/);
    const file = join(dir, '.mission-pipeline', 'config.json');
    writeFileSync(file, JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main', planReviewsWaived: ['m1'], startOnHandback: ['m1'] }));
    const shown = await cli(dir, ['config']);
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /Warning: planReviewsWaived is deprecated \(a project setting is not a waiver\)\. It still waives the plan reviews of m1, labelled "waived by config; no words on record"\. Record the user's words instead: mp pm waive <mission> plan-reviews --words W-<n>/);
    assert.match(shown.out, /startOnHandback .*:\n {2}m1/);
  });
});

// ---------------------------------------------------------------- sol review round 1 on P1

import { recordItem } from '../src/flow/requirements.ts';

describe('P1 sol r1: no decision accepts ahead of the gate; no kept product stalls under a waived plan', () => {
  it('accept-risk on a task that started on a dependency\'s hand-back in review waits for that dependency, then accepts; the decision stays recorded meanwhile', async () => {
    const proj: FlowProject = { localCommands: [], fullSuite: [], startOnHandback: [M] };
    const { ports, engine } = await setup('fast', proj);
    const held: Script = withKinds({
      reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return c.target.includes('iface') ? null : { handBack: reviewer(c, 'needs-decision') }; },
      secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'accept-risk', { classification: 'important-within-authority', notice: 'accept it as it is' }) }),
    });
    await drive(engine, ports.scheduler, held);
    const esc = (await events<{ id: string; source: string; options: string[] }>(ports, 'secretary', 'escalation')).find((e) => e.body.source === 'reviewer-needs-decision')!.body;
    assert.ok(esc.options.includes('accept-risk'));
    assert.ok((await events(ports, 'secretary', 'decision')).some((e) => e.key.startsWith(esc.id)), 'the Secretary decided accept-risk');
    assert.equal(await acceptedProduct(flowCtx(ports, M), 'iface'), null, 'iface is still in review');
    assert.equal(await acceptedProduct(flowCtx(ports, M), 'impl'), null, 'impl is not accepted ahead of iface (sol r1)');
    assert.ok(!(await events(ports, 'secretary', 'applied')).some((e) => e.key === esc.id), 'the decision is recorded, not carried out yet');
    // iface passes: the decision is carried out on the version impl started on
    await drive(engine, ports.scheduler, happyScript(M));
    const acc = (await events<{ k: number; product: string; decision?: { escalation: string } }>(ports, 'task:impl', 'accepted'))[0]!.body;
    assert.deepEqual([acc.k, acc.product, acc.decision?.escalation], [1, 'prod.con.m1.impl.1', esc.id]);
    assert.equal(await acceptedProduct(flowCtx(ports, M), 'iface'), 'prod.con.m1.iface.1');
  });

  it('accept-risk while the dependency\'s version is sent back: the decision is closed with the attempt, and the work is carried onto the next version', async () => {
    const proj: FlowProject = { localCommands: [], fullSuite: [], startOnHandback: [M] };
    const { ports, engine } = await setup('fast', proj);
    await drive(engine, ports.scheduler, withKinds({
      reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return c.target.includes('iface') ? null : { handBack: reviewer(c, 'needs-decision') }; },
      secretary: () => null,
    }));
    let ifaceReviews = 0;
    await drive(engine, ports.scheduler, withKinds({
      reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return c.target.includes('iface') && ifaceReviews++ === 0 ? { handBack: reviewer(c, 'rework') } : { handBack: reviewer(c, 'pass') }; },
      secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'accept-risk', { classification: 'important-within-authority', notice: 'accept it' }) }),
    }));
    const accepted = (await events<{ k: number; decision?: unknown }>(ports, 'task:impl', 'accepted')).map((e) => e.body);
    assert.ok(!accepted.some((a) => a.k === 1), 'nothing is accepted on the version iface\'s review sent back');
    assert.ok(ports.ledger.notices.some((n) => n.category === 'early-start-rebuilt'));
    assert.equal(await acceptedProduct(flowCtx(ports, M), 'impl'), 'prod.con.m1.impl.2');
  });

  it('stable mode, a waived re-plan after a later requirement that keeps the accepted tasks: they are re-bound onto it and judged, and the work that depends on them starts (sol r1: keptStep held)', async () => {
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'stable' });
    const engine = new FlowEngine(ports);
    await drive(engine, ports.scheduler, happyScript(M));
    const w = say(ports, 'Once it has parsed a file, keep the parser read-only.');
    await recordItem(ports, { mission: M, item: 'd1', type: 'decision', text: 'The parser is read-only once it has parsed a file', source: { kind: 'words', words: w, quote: 'keep the parser read-only' } });
    const before = (await ports.evaluator.labels(['prod.con.m1.impl.1'])).labels['prod.con.m1.impl.1'];
    assert.equal(before, 'not-fully-proven', 'the later requirement took the first plan\'s proof away');
    await pmWaive(ports.ctx, { mission: M, check: 'plan-reviews', words: w });
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'A CSV parser library, read-only once it has parsed a file', items: ['g1', 'd1'] }, pmPlan(M).elements[1]!] }), userWords: ['W-1', w], mode: 'stable' });
    const keeps = (): DetailedPlanDoc => {
      const p = detailedPlan(M, { extraTask: true });
      return { ...p, tasks: p.tasks.map((t) => (t.id === 'docs' ? { ...t, interpreter: 'node', verificationCommands: [{ id: 'lint', command: 'npx markdownlint docs/parser.md' }] } : t)) };
    };
    const ran = await drive(engine, ports.scheduler, happyScript(M, keeps));
    assert.deepEqual(reviewTasks(ports).filter((x) => x.includes('dplan.m1.2.')), [], 'the re-plan took effect without its reviews');
    assert.ok(ran.includes('rev.m1.iface.1.b1') && ran.includes('rev.m1.impl.1.b1'), `the kept products are re-bound and judged: ${ran.join(', ')}`);
    assert.ok(ran.includes('con.m1.docs.1'), 'the dependent of the kept products starts');
    assert.equal(await acceptedProduct(flowCtx(ports, M), 'impl'), 'prod.con.m1.impl.1.b1');
    assert.notEqual(await acceptedProduct(flowCtx(ports, M), 'docs'), null);
    const labels = (await ports.evaluator.labels(['prod.con.m1.impl.1.b1', 'dplan.m1.2.1'])).labels;
    assert.equal(labels['prod.con.m1.impl.1.b1'], 'not-fully-proven', 'honest: the plan it relies on was not reviewed');
    assert.notEqual(labels['dplan.m1.2.1'], 'proven');
  });
});
