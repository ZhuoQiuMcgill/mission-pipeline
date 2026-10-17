// 4.1.2 part P3: plans, reopening and repairs (design DesignDoc_ExecutionRedundancy v01: D-4, D-6, D-9,
// D-10; analysis items 5 to 7). Every test here fails on v4.1.1: a task traces several plan elements,
// read-only tasks and the full suite on ordinary tasks are refused mechanically, an integration task
// with nothing to write gets no Constructor, an integration review reopens the original task, repairs
// amend the plan in effect under the mechanical checks only, and cards carry what their seat needs.
// The flows run on a real project memory with scripted seats (test/flow-memory-fixtures.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson, sha256 } from '../src/common/hash.ts';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { acceptedProduct, builtOnOlder } from '../src/flow/execution.ts';
import { mechanicalCheck, MECHANICAL_RULES } from '../src/flow/mechanical.ts';
import { DetailedPlanDoc, DetailedTask, taskCardHash, type DetailedPlanDoc as PlanDoc } from '../src/flow/plandoc.ts';
import { planInEffect, submitPmBatch } from '../src/flow/planning.ts';
import type { FlowProject, FlowTask } from '../src/flow/ports.ts';
import { recordRepair, repairsOf } from '../src/flow/repair.ts';
import { recordConstraint } from '../src/flow/requirements.ts';
import { constructorDone, detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { pmRepair } from '../src/process/pm.ts';
import type { ConstructorCard, ReviewerCard } from '../src/seat/card.ts';
import { renderArchitectDecompose, type ArchitectDecomposeCard, type ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import { renderSeatCard } from '../src/seat/card.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';
import { buildGraph, resolveNodes, tree, walk } from '../src/cli/tree.ts';
import { checkCandidateProofs, type Candidate } from '../src/delivery/candidate.ts';
import { buildManifest } from '../src/delivery/manifest.ts';
import type { DeliveryTarget } from '../src/delivery/proofView.ts';
import type { ObjectVersionId } from '../src/common/ids.ts';
import { auditBasisTexts, standardLine } from '../src/seat/cards/inputs.ts';
import { resolveBases } from '../src/memory/domain/constraints.ts';
import { oid as provenanceOid, provenancePorts, repo as provenanceRepo } from './start-provenance-fixtures.ts';
import { attack, cardOf, hand, submit, world } from './flow-exploration-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;

async function setup(mode: 'stable' | 'fast' = 'fast', project?: FlowProject): Promise<{ ports: World; engine: FlowEngine }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode });
  return { ports, engine: new FlowEngine(project === undefined ? ports : { ...ports, project }) };
}

function withKinds(over: Record<string, Script>, plan?: () => PlanDoc): Script {
  const base = happyScript(M, plan);
  return (t, s) => (Object.hasOwn(over, t.card.seat) ? (over[t.card.seat] as Script) : base)(t, s);
}

const ESTIMATE = { durationMs: 60_000, costMicros: 100_000, basis: 'small' };

/** iface → impl, impl2 → integ (an integration task that writes nothing). */
function integrationPlan(): PlanDoc {
  const base = detailedPlan(M);
  const impl = base.tasks[1] as DetailedTask;
  return {
    ...base,
    modules: [...base.modules, { id: 'parser2', writeScope: ['src/parser/impl2/**'], provenance: { planElements: ['e2'] } }],
    tasks: [
      ...base.tasks,
      { ...impl, id: 'impl2', module: 'parser2', goal: 'Implement the streaming parser', writeScope: ['src/parser/impl2/**'], verificationCommands: [{ id: 'test2', command: 'npm run test2' }] },
      {
        id: 'integ',
        kind: 'integration',
        module: null,
        goal: 'Both parsers work together',
        standards: [{ id: 'S1', text: 'The parsers agree on every sample' }],
        requirementItems: [],
        writeScope: [],
        readableFiles: [],
        interpreter: '',
        verificationCommands: [{ id: 'unit', command: 'npm run unit' }],
        implements: [],
        calls: [],
        dependsOn: ['impl', 'impl2'],
        exclusive: [],
        estimate: ESTIMATE,
        provenance: { planElements: ['e1', 'e2'] },
      },
    ],
  };
}

const tasksOf = (ports: World): string[] => [...ports.scheduler.tasks.keys()];
const accepted = async (ports: World): Promise<string[]> => (await ports.ledger.events({ mission: M, event: 'accepted' })).map((e) => e.line).sort();

/** The invariant of every re-entry path: settled with nothing stuck: every task of the plan in effect is accepted, and a further pass does nothing. */
async function assertSettledAndDone(ports: World, project?: FlowProject): Promise<void> {
  const flow = project === undefined ? ports : { ...ports, project };
  assert.equal((await new FlowEngine(flow).reconcile(M))[0]?.passes, 1, 'settled: nothing left to move');
  const pie = await planInEffect(flowCtx(ports, M));
  assert.ok(pie !== null);
  for (const t of pie.plan.tasks) assert.notEqual(await acceptedProduct(flowCtx(ports, M), t.id), null, `task ${t.id} is accepted`);
  assert.equal(ports.scheduler.queued().length, 0, 'nothing queued');
}

// ---------------------------------------------------------------- 1. several plan elements per task

describe('P3 item 1: a task may trace several plan elements', () => {
  it('one task covering two elements passes coverage; each element counts', async () => {
    const plan = detailedPlan(M);
    const one: PlanDoc = { ...plan, newInterfaces: [], tasks: [{ ...(plan.tasks[1] as DetailedTask), implements: [], dependsOn: [], provenance: { planElements: ['e1', 'e2'] } }] };
    const r = await mechanicalCheck({ pmPlan: pmPlan(M), plan: one, unsettled: new Set(), hasSymbol: async () => true });
    assert.deepEqual(r.failures, [], 'e1 and e2 are both covered by the one task');
    const unknown = await mechanicalCheck({ pmPlan: pmPlan(M), plan: { ...one, tasks: [{ ...(one.tasks[0] as DetailedTask), provenance: { planElements: ['e1', 'nope'] } }] }, unsettled: new Set(), hasSymbol: async () => true });
    assert.ok(unknown.failures.some((f) => f.includes('"nope", which is not a PM plan element')), unknown.failures.join('; '));
    assert.ok(unknown.failures.some((f) => f.includes('"e2" has no task')), 'every element must be covered');
  });

  it('a stored 4.1.1 plan with planElement still reads, and its tasks keep their 4.1.1 card identity (no restart on upgrade)', () => {
    const legacyTask = { ...(detailedPlan(M).tasks[1] as unknown as Record<string, unknown>), provenance: { planElement: 'e2' } };
    const legacyPlan = { ...(detailedPlan(M) as unknown as Record<string, unknown>), newInterfaces: [{ name: 'Parser', definition: 'parse()', searched: 'none found', provenance: { planElement: 'e1' } }], tasks: [legacyTask] };
    const parsed = DetailedPlanDoc.parse(legacyPlan);
    assert.deepEqual(parsed.tasks[0]?.provenance, { planElements: ['e2'] });
    assert.deepEqual(parsed.newInterfaces[0]?.provenance, { planElements: ['e1'] });
    // 4.1.1 hashed DetailedTask.parse(t), whose provenance was { planElement }
    assert.equal(taskCardHash(parsed.tasks[0] as DetailedTask), sha256(canonicalJson(legacyTask)).slice(0, 16));
  });

  it('the flow takes a plan whose task covers two elements into effect, and Calibrator ② sees the mapping', async () => {
    const { ports, engine } = await setup('fast');
    await drive(engine, ports.scheduler, happyScript(M, integrationPlan));
    const cal2 = ports.scheduler.card<{ elements: Array<{ id: string; mapsTo: string | null }> }>('cal2.dplan.m1.1.1');
    assert.equal(cal2.elements.find((e) => e.id === 'task:integ')?.mapsTo, 'e1, e2');
    await assertSettledAndDone(ports);
  });
});

// ---------------------------------------------------------------- 2, 3. mechanical refusals

describe('P3 items 2 and 3: no read-only tasks; no task declares the full suite', () => {
  it('an implementation task with an empty write scope is refused with the card\'s text', async () => {
    const plan = detailedPlan(M);
    const ro: PlanDoc = { ...plan, tasks: plan.tasks.map((t) => (t.id === 'impl' ? { ...t, writeScope: [] } : t)) };
    const r = await mechanicalCheck({ pmPlan: pmPlan(M), plan: ro, unsettled: new Set(), hasSymbol: async () => true });
    assert.ok(r.failures.includes("writes: task impl writes nothing: checks belong in the acceptance standards of the task whose change they check; the full suite runs in the integration task's review."), r.failures.join('; '));
    // an integration task (and an experiment) may write nothing
    const ok = await mechanicalCheck({ pmPlan: pmPlan(M), plan: integrationPlan(), unsettled: new Set(), hasSymbol: async () => true });
    assert.deepEqual(ok.failures, []);
  });

  it('a task that runs the full suite is refused, the integration task included (its Reviewer runs it with full-run, INT F1)', async () => {
    const fullSuite = [{ id: 'all', command: ['npm', 'test'] }];
    const r = await mechanicalCheck({ pmPlan: pmPlan(M), plan: detailedPlan(M), unsettled: new Set(), hasSymbol: async () => true, fullSuite });
    assert.ok(r.failures.includes('full suite: task impl runs the full suite: only the integration task\'s Reviewer runs it (D-5, D-6).'), r.failures.join('; '));
    const p = integrationPlan();
    const integ: PlanDoc = { ...p, tasks: p.tasks.map((t) => (t.id === 'impl' ? { ...t, verificationCommands: [{ id: 'unit', command: 'npm run unit' }] } : t.id === 'integ' ? { ...t, verificationCommands: [{ id: 'all', command: 'npm   test' }] } : t)) };
    const bad = await mechanicalCheck({ pmPlan: pmPlan(M), plan: integ, unsettled: new Set(), hasSymbol: async () => true, fullSuite });
    assert.deepEqual(bad.failures, ['full suite: task integ (integration) lists the full suite as a verification command: its Reviewer runs the suite with `mp seat <id> full-run`, last; give the task the project\'s local commands (D-5).']);
    const local: PlanDoc = { ...integ, tasks: integ.tasks.map((t) => (t.id === 'integ' ? { ...t, verificationCommands: [{ id: 'unit', command: 'npm run unit' }] } : t)) };
    const ok = await mechanicalCheck({ pmPlan: pmPlan(M), plan: local, unsettled: new Set(), hasSymbol: async () => true, fullSuite });
    assert.deepEqual(ok.failures, []);
  });

  it('the flow reads the full suite from the project (config) and returns such a plan to the Architect', async () => {
    const project: FlowProject = { localCommands: [{ id: 'unit', command: 'npm run unit' }], fullSuite: [{ id: 'all', command: 'npm test' }] };
    const { ports, engine } = await setup('fast', project);
    let n = 0;
    const fixed = (): PlanDoc => { const p = detailedPlan(M); return { ...p, tasks: p.tasks.map((t) => (t.id === 'impl' ? { ...t, verificationCommands: [{ id: 'unit', command: 'npm run unit' }] } : t)) }; };
    await drive(engine, ports.scheduler, withKinds({ 'architect-decompose': () => ({ handBack: n++ === 0 ? detailedPlan(M) : fixed() }) }));
    const mc = (await ports.ledger.events<{ ok: boolean; failures: string[] }>({ mission: M, line: 'plan', event: 'mechanical-check' })).map((e) => e.body);
    assert.equal(mc[0]?.ok, false);
    assert.ok(mc[0]?.failures.some((f) => f.includes('task impl runs the full suite')));
    const arch2 = ports.scheduler.card<ArchitectDecomposeCard>('arch.m1.1.2');
    assert.ok(arch2.revision?.mechanicalFailures.some((f) => f.includes('runs the full suite')));
    await assertSettledAndDone(ports, project);
  });
});

// ---------------------------------------------------------------- 4. an integration task with nothing to write

describe('P3 item 4: an integration task with nothing to write needs no Constructor', () => {
  it('no Constructor is dispatched; its start snapshot is its candidate and its Reviewer judges it', async () => {
    const { ports, engine } = await setup('stable');
    await drive(engine, ports.scheduler, happyScript(M, integrationPlan));
    const all = tasksOf(ports);
    assert.ok(!all.some((t) => t.startsWith('con.m1.integ.')), `no Constructor for integ: ${all.join(', ')}`);
    assert.ok(all.includes('rev.m1.integ.1'));
    const rev = ports.scheduler.card<ReviewerCard>('rev.m1.integ.1');
    assert.equal(rev.integration?.hasConstructor, false);
    assert.deepEqual(rev.integration?.dependencies.map((d) => d.task).sort(), ['iface', 'impl', 'impl2']);
    assert.deepEqual(rev.integration?.dependencies.find((d) => d.task === 'impl')?.changedPaths, ['src/parser/impl/index.ts']);
    assert.equal(rev.verificationRuns.length, 1, 'its local command ran on the start snapshot');
    // the product records the dependencies' products as its pinned prerequisites
    const prod = await ports.ledger.objectVersion('prod.con.m1.integ.1');
    assert.ok(prod !== null);
    assert.deepEqual(ports.ledger.content.getList(prod.prerequisites).sort(), ['prod.con.m1.iface.1', 'prod.con.m1.impl.1', 'prod.con.m1.impl2.1']);
    assert.ok(renderSeatCard(rev as never, { dispatch: 'D-1' }).includes('owners <path>'), 'the integration Reviewer may ask who changed a path');
    await assertSettledAndDone(ports);
  });

  it('a rework without a reopen is refused at hand-back: it must reopen a dependency or be needs-decision', async () => {
    const { ports, engine } = await setup('fast');
    await drive(engine, ports.scheduler, withKinds({ reviewer: (t) => ((t.card as unknown as ReviewerCard).target.includes('integ') ? null : { handBack: reviewer(t.card as unknown as ReviewerCard, 'pass') }) }, integrationPlan));
    const rev = ports.scheduler.card<ReviewerCard>('rev.m1.integ.1');
    const problems = await ports.scheduler.run('rev.m1.integ.1', { handBack: reviewer(rev, 'rework') });
    assert.ok(problems.some((p) => p.includes('writes nothing and has no Constructor')), problems.join('; '));
    const notDep = await ports.scheduler.run('rev.m1.integ.1', { handBack: { ...reviewer(rev, 'rework'), reopen: [{ task: 'nope', issue: 'x' }] } });
    assert.ok(notDep.some((p) => p.includes('task "nope" is not a dependency of this integration task')), notDep.join('; '));
  });
});

// ---------------------------------------------------------------- 5. reopening the original task

describe('P3 item 5: an integration review reopens the original task (D-6)', () => {
  it('the reopened task gets attempt k+1 with the issue on its card; the integration waits, then builds again on its new work', async () => {
    const { ports, engine } = await setup('stable');
    let integReviews = 0;
    await drive(engine, ports.scheduler, withKinds({
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (!c.target.includes('integ')) return { handBack: reviewer(c, 'pass') };
        if (integReviews++ > 0) return { handBack: reviewer(c, 'pass') };
        return { handBack: { ...reviewer(c, 'rework'), reopen: [{ task: 'impl', issue: 'impl drops quoted newlines', evidence: `evidence:${c.verificationRuns[0]?.evidence}` }] } };
      },
    }, integrationPlan));
    const all = tasksOf(ports);
    assert.ok(all.includes('con.m1.impl.2'), 'impl got a new attempt');
    assert.ok(!all.some((t) => t.startsWith('con.m1.impl2.2') || t.startsWith('con.m1.iface.2')), 'nothing else is rebuilt');
    const con = ports.scheduler.card<ConstructorCard>('con.m1.impl.2');
    assert.ok(con.duties.includes('impl drops quoted newlines'), con.duties);
    assert.ok(con.duties.includes('Reopened by the review rev.m1.integ.1 of integration task integ'), con.duties);
    const rw = (await ports.ledger.events<{ reason: string }>({ mission: M, line: 'task:impl', event: 'rework' })).map((e) => e.body.reason);
    assert.deepEqual(rw, ['reopen']);
    // the integration waited for impl's new acceptance, then built again on it (no Constructor either time)
    assert.ok(all.indexOf('rev.m1.integ.2') > all.indexOf('rev.m1.impl.2'));
    const prod = await ports.ledger.objectVersion('prod.con.m1.integ.2');
    assert.ok(prod !== null);
    const pre = ports.ledger.content.getList(prod.prerequisites);
    assert.ok(pre.includes('prod.con.m1.impl.2') && !pre.includes('prod.con.m1.impl.1'), pre.join(', '));
    const rev2 = ports.scheduler.card<ReviewerCard>('rev.m1.impl.2');
    assert.ok(rev2.duties.includes('This attempt was reopened'), 'the reopened task\'s Reviewer checks the issue too');
    assert.deepEqual(await accepted(ports), ['task:iface', 'task:impl', 'task:impl', 'task:impl2', 'task:integ'], 'impl accepted twice; the integration once, on its second attempt');
    await assertSettledAndDone(ports);
  });

  it('no cascade: a reopened task\'s other dependents keep their products and proof; the integration lays them over its new work', async () => {
    const { ports, engine } = await setup('stable');
    let integReviews = 0;
    await drive(engine, ports.scheduler, withKinds({
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (!c.target.includes('integ') || integReviews++ > 0) return { handBack: reviewer(c, 'pass') };
        return { handBack: { ...reviewer(c, 'rework'), reopen: [{ task: 'iface', issue: 'the interface misses a delimiter option' }] } };
      },
    }, integrationPlan));
    const all = tasksOf(ports);
    assert.ok(all.includes('con.m1.iface.2'));
    assert.ok(!all.some((t) => /^(con|rev)\.m1\.impl2?\.2/.test(t) || t.includes('.b1')), `impl and impl2 are neither rebuilt nor re-reviewed: ${all.join(', ')}`);
    const labels = (await ports.evaluator.labels(['prod.con.m1.impl.1', 'prod.con.m1.impl2.1'])).labels;
    assert.equal(labels['prod.con.m1.impl.1'], 'proven');
    assert.equal(labels['prod.con.m1.impl2.1'], 'proven');
    const prod = await ports.ledger.objectVersion('prod.con.m1.integ.2');
    const pre = ports.ledger.content.getList(prod!.prerequisites);
    assert.ok(pre.includes('prod.con.m1.iface.2') && !pre.includes('prod.con.m1.iface.1'), `the earlier iface is superseded in the composition: ${pre.join(', ')}`);
    // the read says honestly: impl is built on iface attempt 1; iface has a newer accepted version
    const lines = new Map<string, Array<{ revision: number; event: string; key: string; body: unknown }>>();
    for (const id of ['iface']) lines.set(id, (await ports.ledger.events({ mission: M, line: `task:${id}` })).map((e) => ({ revision: e.revision, event: e.event, key: e.key, body: e.body })));
    const implPre = ports.ledger.content.getList((await ports.ledger.objectVersion('prod.con.m1.impl.1'))!.prerequisites);
    assert.deepEqual(builtOnOlder(implPre, lines), [{ prerequisite: 'prod.con.m1.iface.1', task: 'iface', attempt: 1, newer: 'prod.con.m1.iface.2' }]);
    const g = buildGraph(ports.ctx, { mission: M });
    const shown = walk(ports.ctx, g, resolveNodes(g, ports.ctx, 'prod.con.m1.impl.1'), 'back').text;
    assert.ok(shown.includes('built on prod.con.m1.iface.1 (task iface, attempt 1); iface has a newer accepted version prod.con.m1.iface.2'), shown);
    await assertSettledAndDone(ports);
  });

  it('exit: a reopened task given up keeps the integration waiting, told to the PM', async () => {
    const { ports, engine } = await setup('fast');
    let integReviews = 0;
    await drive(engine, ports.scheduler, withKinds({
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (c.target.includes('integ')) return integReviews++ > 0 ? { handBack: reviewer(c, 'pass') } : { handBack: { ...reviewer(c, 'rework'), reopen: [{ task: 'impl', issue: 'broken' }] } };
        // impl's reviews after the reopen keep failing on a new issue each time, until its rework loop is used up
        if (c.target.includes('impl.') && !c.target.includes('impl2') && !c.target.endsWith('impl.1')) return { handBack: reviewer(c, 'rework', { findings: [`still broken ${c.target}`] }) };
        return { handBack: reviewer(c, 'pass') };
      },
      secretary: (t) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'abandon') }),
    }, integrationPlan));
    assert.ok(ports.ledger.notices.some((n) => n.category === 'reopened-task-abandoned'), `the PM is told why the integration waits: ${ports.ledger.notices.map((n) => n.category).join(', ')} / ${tasksOf(ports).join(', ')}`);
    assert.ok(!tasksOf(ports).includes('rev.m1.integ.2'), 'the integration does not build on work given up');
    assert.equal(ports.scheduler.queued().length, 0);
  });
});

// ---------------------------------------------------------------- 6. repairs

function fixTask(over: Partial<DetailedTask> = {}): DetailedTask {
  return {
    id: 'fixhdr',
    kind: 'implementation',
    module: 'parser',
    goal: 'Keep the header row',
    standards: [{ id: 'S1', text: 'The header row is kept' }],
    requirementItems: [],
    writeScope: ['src/parser/header.ts'],
    readableFiles: [],
    interpreter: 'node',
    verificationCommands: [{ id: 'test', command: 'npm test' }],
    implements: [],
    calls: [],
    dependsOn: ['impl'],
    exclusive: [],
    estimate: ESTIMATE,
    provenance: 'architect',
    ...over,
  };
}

const PLANNING_SEATS = new Set(['calibrator-1', 'architect-decompose', 'architect-feasibility', 'calibrator-2']);
const planningTasks = (ports: World): string[] => [...ports.scheduler.tasks.values()].filter((t) => PLANNING_SEATS.has(t.spec.card.seat)).map((t) => t.spec.task);

describe('P3 item 6: repairs (D-9, D-10)', () => {
  it('an Architect "add": mechanical checks only (no Calibrator, no feasibility), existing products stay proven with no re-bind; the added task runs with the repair on its cards', async () => {
    const { ports, engine } = await setup('stable');
    await drive(engine, ports.scheduler, happyScript(M));
    const before = planningTasks(ports);
    const w2 = say(ports, 'Trying it, the parser drops the header row of every file. Please fix that.');
    const r = await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'defect', text: 'the parser drops the header row', about: 'impl' });
    assert.equal(r.repair, 'R-1');
    const repairCards: ArchitectRepairCard[] = [];
    await drive(engine, ports.scheduler, withKinds({
      'architect-repair': (t) => {
        repairCards.push(t.card as unknown as ArchitectRepairCard);
        return { handBack: { reopen: [], add: [fixTask()], note: 'a new task keeps the header' } };
      },
    }));
    assert.deepEqual(planningTasks(ports), before, 'no Calibrator ①, Architect decomposition, feasibility or Calibrator ② was queued');
    assert.equal(repairCards.length, 1);
    assert.deepEqual(repairCards[0]?.accepted.map((a) => a.task).sort(), ['iface', 'impl']);
    assert.deepEqual(repairCards[0]?.owners.map((o) => o.path), ['src/parser/impl/index.ts'], 'the owners of the paths the repair is about');
    assert.equal(repairCards[0]?.repairs?.[0]?.text, 'the parser drops the header row');
    const mc = (await ports.ledger.events<{ ok: boolean }>({ mission: M, line: 'repairs', event: 'mechanical-check' })).map((e) => e.body.ok);
    assert.deepEqual(mc, [true]);
    // the amendment: the plan in effect gains the task, under the same detailed plan version
    const pie = await planInEffect(flowCtx(ports, M));
    assert.equal(pie?.eff.dplan, 'dplan.m1.1.1');
    assert.deepEqual(pie?.plan.tasks.map((t) => t.id), ['iface', 'impl', 'fixhdr']);
    // existing products keep their bindings: no re-bind, no re-review, still proven
    assert.equal((await ports.ledger.events({ mission: M, event: 'rebind' })).length, 0);
    assert.ok(!tasksOf(ports).some((t) => t.includes('.b1') || /^rev\.m1\.(iface|impl)\.1\.e/.test(t)));
    const labels = (await ports.evaluator.labels(['prod.con.m1.iface.1', 'prod.con.m1.impl.1', 'dplan.m1.1.1'])).labels;
    assert.deepEqual([labels['prod.con.m1.iface.1'], labels['prod.con.m1.impl.1'], labels['dplan.m1.1.1']], ['proven', 'proven', 'proven']);
    // the added task ran like any task, with the repair on its cards
    assert.equal(ports.scheduler.card<ConstructorCard>('con.m1.fixhdr.1').repairs?.[0]?.id, 'R-1');
    assert.equal(ports.scheduler.card<ReviewerCard>('rev.m1.fixhdr.1').repairs?.[0]?.id, 'R-1');
    const states = await repairsOf(flowCtx(ports, M));
    assert.deepEqual(states.map((s) => [s.id, s.state, s.added, s.reopened]), [['R-1', 'decided', ['fixhdr'], []]]);
    // the reads show the repair and the work it caused, back to the user's words
    const g = buildGraph(ports.ctx, { mission: M });
    const why = walk(ports.ctx, g, resolveNodes(g, ports.ctx, 'prod.con.m1.fixhdr.1'), 'back').text;
    assert.ok(why.includes('R-1') && why.includes(w2), why);
    const t = tree(ports.ctx, g, M).text;
    assert.ok(t.includes('amended by repair R-1: adds fixhdr') && t.includes('the parser drops the header row'), t);
    await assertSettledAndDone(ports);
  });

  it('an Architect "reopen": the task gets a new attempt with the repair on its card; nothing else is redone', async () => {
    const { ports, engine } = await setup('fast');
    await drive(engine, ports.scheduler, happyScript(M));
    const w2 = say(ports, 'The output loses the header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'loses the header row' });
    await drive(engine, ports.scheduler, withKinds({ 'architect-repair': () => ({ handBack: { reopen: [{ task: 'impl', issue: 'keep the header row' }], add: [], note: 'impl owns it' } }) }));
    const con = ports.scheduler.card<ConstructorCard>('con.m1.impl.2');
    assert.equal(con.repairs?.[0]?.id, 'R-1');
    assert.ok(con.duties.includes('keep the header row') && con.duties.includes('Reopened by repair R-1'), con.duties);
    assert.ok(!tasksOf(ports).includes('con.m1.iface.2'));
    assert.deepEqual((await repairsOf(flowCtx(ports, M))).map((s) => s.reopened), [['impl']]);
    await assertSettledAndDone(ports);
  });

  it('a mechanical failure returns the repair to the Architect with the failures', async () => {
    const { ports, engine } = await setup('fast');
    await drive(engine, ports.scheduler, happyScript(M));
    const w2 = say(ports, 'Headers vanish.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'defect', text: 'Headers vanish' });
    let n = 0;
    await drive(engine, ports.scheduler, withKinds({ 'architect-repair': () => ({ handBack: { reopen: [], add: [n++ === 0 ? fixTask({ writeScope: [] }) : fixTask()], note: 'n' } }) }));
    const ids = tasksOf(ports).filter((t) => t.startsWith('arch-repair.m1.'));
    assert.equal(ids.length, 2, ids.join(', '));
    const second = ports.scheduler.card<ArchitectRepairCard>(ids[1]!);
    assert.ok(second.revision?.mechanicalFailures.some((f) => f.includes('task fixhdr writes nothing')), JSON.stringify(second.revision));
    assert.deepEqual(planningTasks(ports).filter((t) => !t.startsWith('cal1.m1.1') && !t.startsWith('arch.m1.1.1') && !t.startsWith('feas.') && !t.startsWith('cal2.dplan.m1.1.1')), []);
    await assertSettledAndDone(ports);
  });

  it('the text must occur verbatim in the words entry (the requirement items\' check)', async () => {
    const { ports } = await setup('fast');
    const w2 = say(ports, 'The header row disappears.');
    await assert.rejects(() => pmRepair(ports.ctx, { mission: M, words: w2, kind: 'defect', text: 'the header is gone' }), /does not appear verbatim/);
    assert.equal((await ports.ledger.events({ mission: M, line: 'repairs' })).length, 0);
  });

  it('about an exploration: one more round with the repair on the round\'s cards; the settled conclusion stays as history', async () => {
    const w = await world();
    say(w.ports, 'The design has to survive a restart of the scheduler.');
    await w.advance();
    await hand(w, 'researcher-author', submit('design v1'));
    await w.advance();
    await hand(w, 'crititor', attack());
    await w.advance();
    await hand(w, 'crititor', attack());
    let r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    const rep = await recordRepair(w.ports, { mission: 'M1' as MissionId, words: 'W-1', kind: 'new-question', text: 'survive a restart of the scheduler', about: { kind: 'exploration', id: w.x } });
    r = await w.advance();
    assert.notEqual(r.state, 'stopped', 'reopened');
    const author = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(author.repairs?.[0]?.id, rep.id);
    await hand(w, 'researcher-author', submit('design v2: restarts recover from the memory'));
    await w.advance();
    assert.equal(cardOf<{ repairs?: Array<{ id: string }> }>(w, 'crititor').repairs?.[0]?.id, rep.id, 'the attacker sees the added question too');
    await hand(w, 'crititor', attack());
    await w.advance();
    await hand(w, 'crititor', attack());
    r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged', 'exit: the reopened round converges again (never stuck)');
    const settles = await w.ledger.events({ mission: 'M1' as MissionId, line: `exploration:${w.x}`, event: 'stopped' });
    assert.equal(settles.length, 2, 'the first stop stays in the record');
  });
});

// ---------------------------------------------------------------- 7. cards

describe('P3 item 7: cards carry what their seat needs', () => {
  it('the Architect card shows the constraints, the mechanical checks, the commands and what a Reviewer sees', async () => {
    const project: FlowProject = { localCommands: [{ id: 'unit', command: 'npm run unit' }], fullSuite: [{ id: 'all', command: ['npm', 'run', 'all'] }] };
    const { ports, engine } = await setup('fast', project);
    await recordConstraint(ports, { mission: M, constraint: 'no-network', kind: 'instruction', text: 'Tests never use the network', scope: { paths: ['**'], taskTypes: [] } });
    await drive(engine, ports.scheduler, happyScript(M));
    const card = ports.scheduler.card<ArchitectDecomposeCard>('arch.m1.1.1');
    assert.ok(card.constraints.some((c) => c.text === 'Tests never use the network'));
    const text = renderArchitectDecompose(card);
    assert.ok(text.includes('Mechanical checks your plan must pass'));
    for (const r of MECHANICAL_RULES) assert.ok(text.includes(r.text), `rule ${r.id} is on the card`);
    assert.ok(text.includes('[unit] npm run unit') && text.includes('[all] npm run all'));
    assert.ok(text.includes('What a Reviewer can see: the change, the local runs\' exit codes'));
    assert.ok(text.includes('one change that satisfies several elements is one task'));
  });

  it('the Reviewer card shows the previous Reviewer\'s verdict, unmet standards and reasons', async () => {
    const { ports, engine } = await setup('fast');
    let n = 0;
    await drive(engine, ports.scheduler, withKinds({ reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return c.target.includes('impl') && n++ === 0 ? { handBack: reviewer(c, 'rework', { failing: 'S2', findings: ['slow on big files'] }) } : { handBack: reviewer(c, 'pass') }; } }));
    const rev2 = ports.scheduler.card<ReviewerCard>('rev.m1.impl.2');
    assert.deepEqual(rev2.previousReview, { review: 'rev.m1.impl.1', attempt: 1, verdict: 'rework', unmet: [{ standard: 'S2', met: 'no', reason: 'checked' }], findings: ['slow on big files'] });
    assert.ok(renderSeatCard(rev2 as never, { dispatch: 'D-9' }).includes('The previous review of this task'));
    assert.equal(ports.scheduler.card<ReviewerCard>('rev.m1.impl.1').previousReview, undefined);
  });

  it('the Secretary card shows the earlier decisions on the same task line, with whether each was carried out', async () => {
    const { ports, engine } = await setup('fast');
    let cons = 0;
    let revs = 0;
    const secretaries: SecretaryCard[] = [];
    await drive(engine, ports.scheduler, withKinds({
      constructor: (t: FlowTask) => (t.task.includes('impl') && cons++ === 0 ? { handBack: constructorDone({ decisions_needed: ['Which delimiter is the default?'] }) } : { handBack: constructorDone() }),
      reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return c.target.includes('impl') && revs++ === 0 ? { handBack: reviewer(c, 'needs-decision') } : { handBack: reviewer(c, 'pass') }; },
      secretary: (t) => { const c = t.card as unknown as SecretaryCard; secretaries.push(c); return { handBack: secretary(c, 'answer', { instructions: 'comma' }) }; },
    }));
    assert.equal(secretaries.length, 2);
    const second = secretaries.find((s) => s.request.source === 'reviewer-needs-decision')!;
    assert.deepEqual(second.earlierDecisions?.map((d) => [d.escalation, d.option, d.applied]), [['cdec.con.m1.impl.1', 'answer', 'carried out']]);
    assert.equal(secretaries.find((s) => s.request.source === 'constructor-decision')?.earlierDecisions?.length ?? 0, 0);
  });
});


// ---------------------------------------------------------------- review round 1 (S1, S2, S3, G1)

const target = (id: string): DeliveryTarget => ({ kind: 'object', id: id as ObjectVersionId });

/** iface reopened by the integration review and accepted again (iface.2); impl stays built on iface.1 (no cascade); integ.2 integrates both. */
async function reopenedWorld() {
  const w = provenancePorts();
  say(w.ports, SEED_TEXT);
  await seedMission(w.ports, M);
  await submitPmBatch(w.ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  const engine = new FlowEngine(w.ports);
  const base = happyScript(M, integrationPlan);
  let integReviews = 0;
  await drive(engine, w.ports.scheduler, (t, s) => {
    const c = t.card as unknown as ReviewerCard;
    if (t.card.seat === 'reviewer' && c.target.includes('integ') && integReviews++ === 0) return { handBack: { ...reviewer(c, 'rework'), reopen: [{ task: 'iface', issue: 'the interface misses a delimiter option' }] } };
    return base(t, s);
  });
  return w;
}
const A1 = 'prod.con.m1.iface.1';
const A2 = 'prod.con.m1.iface.2';
const B1 = 'prod.con.m1.impl.1';
const C1 = 'prod.con.m1.impl2.1';
const I2 = 'prod.con.m1.integ.2';

async function proofOf(w: Awaited<ReturnType<typeof reopenedWorld>>, selected: readonly string[], commit?: string) {
  const built = buildManifest(w.view(), selected.map(target));
  assert.equal(built.kind, 'manifest', `composes: ${JSON.stringify(built).slice(0, 300)}`);
  if (built.kind !== 'manifest') throw new Error('not a manifest');
  const snap = commit ?? (await w.ports.scheduler.snapshot({ mission: M, purpose: 'delivery', products: [...selected] })).commit;
  const proof = await checkCandidateProofs({ git: w.objects.git, repo: provenanceRepo, view: w.view(), manifest: built.manifest, candidate: { commit: snap, snapshotDir: '/unused' } as Candidate });
  return { manifest: built.manifest, proof };
}

describe('P3 review S1, S2: delivering a dependent built on a reopened task\'s earlier version', () => {
  it('[A2, B1] with no integration of the two: B1 is not fully proven, "built on A1; delivered with A2"; its recorded prerequisites are untouched; same module, different paths composes', async () => {
    const w = await reopenedWorld();
    const { manifest, proof } = await proofOf(w, [A2, B1]);
    // iface and impl are both module "parser" on different paths: not incompatible
    assert.deepEqual(manifest.entries.map((e) => e.object.id).sort(), [A2, B1]);
    assert.equal(manifest.superseded?.get(A1 as ObjectVersionId)?.by, A2, 'A1 is recorded as superseded by A2, not lost');
    assert.deepEqual(manifest.entries.find((e) => e.object.id === B1)?.object.prerequisites, [target(A1)], 'B1 keeps its recorded prerequisite');
    assert.ok(proof.proven.includes(A2 as ObjectVersionId));
    const b = proof.notFullyProven.find((n) => n.id === B1);
    assert.ok(b !== undefined, `B1 is not proven as delivered: ${JSON.stringify(proof)}`);
    assert.deepEqual(b.reasons, [{ kind: 'built-on-superseded', prerequisite: A1, deliveredWith: A2 }]);
  });

  it('[A2, B1, C1, I2] with I2 reviewed on A2 and B1 together: everything is proven; the final-tree checks still run', async () => {
    const w = await reopenedWorld();
    const i2 = await w.ports.ledger.objectVersion(I2);
    assert.ok(i2 !== null);
    assert.deepEqual(w.ports.ledger.content.getList(i2.prerequisites).sort(), [A2, B1, C1].sort(), 'the integration was built on A2 and B1');
    const { proof } = await proofOf(w, [A2, B1, C1, I2]);
    assert.deepEqual(proof.notFullyProven, []);
    assert.deepEqual([...proof.proven].sort(), [A2, B1, C1, I2].sort());
    // the final tree is still read: A2's content changed in the candidate fails A2, and B1 through it
    const snap = (await w.ports.scheduler.snapshot({ mission: M, purpose: 'delivery', products: [A2, B1, C1, I2] })).commit;
    const tampered = w.objects.put(w.entries(snap).map((e) => (e.path === 'src/parser/api.ts' ? { ...e, oid: provenanceOid(4242) } : e)));
    const bad = await proofOf(w, [A2, B1, C1, I2], tampered);
    assert.ok(bad.proof.notFullyProven.find((n) => n.id === A2)?.reasons.some((r) => r.kind === 'content-changed'));
    assert.ok(bad.proof.notFullyProven.find((n) => n.id === B1)?.reasons.some((r) => (r.kind === 'prerequisite-mismatch' || r.kind === 'prerequisite-not-proven') && r.prerequisite === A2));
  });
});

describe('P3 review S3: the integration rule and amendments', () => {
  it('two successive repairs (add an implementation task, then reopen only) pass; a later re-plan that carries the added task passes too', async () => {
    const { ports, engine } = await setup('fast');
    let plan = integrationPlan();
    await drive(engine, ports.scheduler, happyScript(M, () => plan));
    const impl3 = fixTask({ id: 'impl3', goal: 'A third parser', writeScope: ['src/parser/impl3/**'], dependsOn: ['iface'] });
    const w2 = say(ports, 'A third parser is missing. Also the first parser mangles quotes.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'missing', text: 'A third parser is missing' });
    await drive(engine, ports.scheduler, withKinds({ 'architect-repair': () => ({ handBack: { reopen: [], add: [impl3], note: 'a new task' } }) }, () => plan));
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'defect', text: 'the first parser mangles quotes' });
    await drive(engine, ports.scheduler, withKinds({ 'architect-repair': () => ({ handBack: { reopen: [{ task: 'impl', issue: 'quotes' }], add: [], note: 'impl owns it' } }) }, () => plan));
    const repairChecks = (await ports.ledger.events<{ ok: boolean; failures: string[] }>({ mission: M, line: 'repairs', event: 'mechanical-check' })).map((e) => e.body);
    assert.deepEqual(repairChecks.map((c) => c.ok), [true, true], JSON.stringify(repairChecks));
    assert.deepEqual((await repairsOf(flowCtx(ports, M))).map((r) => r.state), ['decided', 'decided']);
    // a real re-plan (a new PM plan version) carries the added task over unchanged
    plan = { ...integrationPlan(), tasks: [...integrationPlan().tasks, impl3] };
    const changed = pmPlan(M);
    await submitPmBatch(ports, { mission: M, plan: { ...changed, elements: changed.elements.map((e) => (e.id === 'e2' ? { ...e, text: 'Covered by unit tests, all parsers' } : e)) }, userWords: ['W-1'], mode: 'fast' });
    await drive(engine, ports.scheduler, happyScript(M, () => plan));
    const mc = (await ports.ledger.events<{ ok: boolean; failures: string[] }>({ mission: M, line: 'plan', event: 'mechanical-check' })).find((e) => e.key === 'dplan.m1.2.1')?.body;
    assert.equal(mc?.ok, true, JSON.stringify(mc));
    assert.equal((await planInEffect(flowCtx(ports, M)))?.eff.dplan, 'dplan.m1.2.1');
    assert.ok(!tasksOf(ports).includes('con.m1.impl3.2'), 'the carried task keeps its card: no restart');
    await assertSettledAndDone(ports);
  });
});

describe('P3 review G1: audit basis texts read the plan in effect through the shared resolver', () => {
  it('an amendment never replaces a task the plan already has', () => {
    const plan = detailedPlan(M);
    const stored = JSON.stringify({ format: 'mp4.detailed-plan.v1', mission: M, pmPlan: 'pmplan.m1.1', round: 1, plan });
    const clash = { ...(plan.tasks[0] as DetailedTask), standards: [{ id: 'S1', text: 'overwritten by an amendment' }] };
    const events = [{ revision: 1, mission: M, line: 'plan', event: 'effective', key: 'dplan.m1.1.1#a1', body: { dplan: 'dplan.m1.1.1', amendments: [{ repair: 'R-1', tasks: [clash], reopen: [], arch: 'x' }] } }];
    const texts = auditBasisTexts(resolveBases([]), events as never, { get: () => stored, getList: () => [] }, () => ({ content: 'h' }) as never);
    assert.equal(texts.get(standardLine(M, 'iface', 'S1')), 'acceptance standard S1 of task iface: The interface compiles');
  });
});
