// 4.4 package p3, review round 1: the eight findings (p3-1 to p3-8), each with the case it names, and
// the retry of an operation recorded by 4.3. Flow-level cases run on a real memory with scripted seats
// (test/flow-memory-fixtures.ts); the release and run cases go through the process commands.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { canonicalJson, hashJson } from '../src/common/hash.ts';
import type { ContentHash, MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import type { DetailedPlanDoc, DetailedTask } from '../src/flow/plandoc.ts';
import { planInEffect, planningStep, submitPmBatch } from '../src/flow/planning.ts';
import type { FlowTask } from '../src/flow/ports.ts';
import { architect, cal2Pass, constructorDone, detailedPlan, drive, feasibilityReturn, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { appendRecords, claimDispatch, flowEvents, listDispatches, loopState, releaseDispatch, taskInfo } from '../src/memory/index.ts';
import { DISPATCH_LINE, pmDispatch, pmDispatchChecked, pmRelease, pmRepair, seatCard, seatRerun, shellRunner, UNSTARTED_RELEASE, type CommandRunner, type ProcessContext } from '../src/process/index.ts';
import { dispatchView, RUN_STARTED_EVENT } from '../src/process/seat.ts';
import type { ConstructorCard, ReviewerCard } from '../src/seat/card.ts';
import { renderSeatCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectDecomposeCard, ArchitectFeasibilityCard, ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import type { MaterialRef } from '../src/seat/cards/common.ts';
import { STARTS_CHANGED } from '../src/seat/cards/refresh.ts';
import { anotherProcess, memoryPorts, say } from './flow-memory-fixtures.ts';
import { addMissionToReview, processProject, readyOf, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
let p: ProcessProject | null = null;
afterEach(() => {
  p?.cleanup();
  p = null;
});

async function world(): Promise<{ ports: World; engine: FlowEngine }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  return { ports, engine: new FlowEngine(ports) };
}

function withKinds(over: Record<string, Script>, plan?: () => DetailedPlanDoc): Script {
  const base = happyScript(M, plan);
  return (t, s) => (Object.hasOwn(over, t.card.seat) ? (over[t.card.seat] as Script) : base)(t, s);
}

/** The card the latest dispatch of a task claimed (what its seat reads). */
function claimed<C>(ports: World, task: string): C {
  const d = ports.ctx.memory.read((db) => listDispatches(db, { task, limit: 100 })).at(-1);
  assert.ok(d !== undefined, `task ${task} was dispatched`);
  return dispatchView(ports.ctx, d.dispatch).card as unknown as C;
}

const ids = (c: { materials?: readonly MaterialRef[] | undefined }): string[] => (c.materials ?? []).map((m) => m.id);
const withFormats = (): DetailedPlanDoc => ({ ...detailedPlan(M), dataFormats: ['CSV in, string[][] out'], storage: ['nothing is stored'] });
const plan2 = () => pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'A CSV parser library, read-only once it has parsed a file' }, pmPlan(M).elements[1]!] });
const fixTask = (): DetailedTask => ({
  id: 'fixhdr', kind: 'implementation', module: 'parser', goal: 'Keep the header row', standards: [{ id: 'S1', text: 'The header row is kept' }], requirementItems: [],
  writeScope: ['src/parser/header.ts'], readableFiles: [], interpreter: 'node', verificationCommands: [{ id: 'test', command: 'npm test' }], implements: [], calls: [], dependsOn: ['impl'], exclusive: [],
  estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'small' }, provenance: 'architect',
});

describe('p3-1: a step queued by 4.3 gets its 4.4 card at the claim', () => {
  it('the Reviewer, a rework Constructor, a feasibility review and a revising Architect queued without the F3 materials get them from the recorded hand-backs when claimed', async () => {
    const { ports, engine } = await world();
    // the cards as the 4.3 builders queued them: no materials of F3, no data formats
    const submit = ports.scheduler.submit.bind(ports.scheduler);
    ports.scheduler.submit = async (t: FlowTask) => {
      const card = { ...t.card } as Record<string, unknown>;
      if (['constructor', 'reviewer', 'architect-feasibility'].includes(String(card['seat']))) for (const k of ['materials', 'dataFormats', 'storage']) delete card[k];
      if (card['seat'] === 'architect-decompose' && Array.isArray(card['materials'])) card['materials'] = (card['materials'] as MaterialRef[]).filter((m) => m.id !== 'feasibility-report');
      return submit({ ...t, card: card as FlowTask['card'] });
    };
    let returned = false;
    let reworked = false;
    await drive(engine, ports.scheduler, withKinds({
      'architect-feasibility': (t) => (returned ? { handBack: { findings: [], criticalPath: [], verdict: 'feasible' } } : ((returned = true), { handBack: feasibilityReturn(t.card as unknown as ArchitectFeasibilityCard, 'the parser buffers whole files'), report: '# Feasibility\n\nWhole files in memory.\n' })),
      constructor: (t: FlowTask) => ({ handBack: constructorDone({ done: `the work of ${t.task}` }), report: `# Constructor report of ${t.task}\n` }),
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (c.target.includes('iface') || reworked) return { handBack: reviewer(c, 'pass') };
        reworked = true;
        return { handBack: reviewer(c, 'rework', { failing: 'S1' }), report: '# Review\n\nS1 fails.\n' };
      },
    }, withFormats));
    // queued in the 4.3 shape ...
    assert.deepEqual(ids(ports.scheduler.card<ReviewerCard>('rev.m1.impl.1')), []);
    assert.deepEqual(ids(ports.scheduler.card<ConstructorCard>('con.m1.impl.2')), []);
    assert.deepEqual(ids(ports.scheduler.card<ArchitectFeasibilityCard>('feas.dplan.m1.1.2')), []);
    assert.deepEqual(ids(ports.scheduler.card<ArchitectDecomposeCard>('arch.m1.1.2')), ['plan-old']);
    // ... and claimed with the 4.4 materials and lists, through the dispatch
    const rev = claimed<ReviewerCard>(ports, 'rev.m1.impl.1');
    assert.deepEqual(ids(rev), ['constructor-claims']);
    assert.ok(ports.ledger.content.get(rev.materials![0]!.ref as never).includes('# Constructor report of con.m1.impl.1'));
    assert.deepEqual([rev.dataFormats, rev.storage], [['CSV in, string[][] out'], ['nothing is stored']]);
    assert.ok(renderSeatCard(rev as never, { dispatch: 'd-test' }).includes('`mp seat d-test read <material> [--page <n>]`'), 'the Reviewer can read the report');
    const con = claimed<ConstructorCard>(ports, 'con.m1.impl.2');
    assert.deepEqual(ids(con), ['previous-review', 'previous-handback']);
    assert.ok(ports.ledger.content.get(con.materials![0]!.ref as never).includes('S1 fails.'));
    assert.deepEqual(con.dataFormats, ['CSV in, string[][] out']);
    assert.deepEqual(ids(claimed<ArchitectFeasibilityCard>(ports, 'feas.dplan.m1.1.2')), ['feasibility-report']);
    assert.deepEqual(ids(claimed<ArchitectDecomposeCard>(ports, 'arch.m1.1.2')), ['plan-old', 'feasibility-report']);
  });
});

describe('p3-2: a repair step whose plan is no longer in effect is not claimed with its old card', () => {
  it('the claim is refused with the plan-review card\'s work instruction, and the next pass rebuilds the step on the plan in effect', async () => {
    const { ports, engine } = await world();
    await drive(engine, ports.scheduler, happyScript(M));
    const w2 = say(ports, 'Trying it, the header row is lost.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'defect', text: 'the header row is lost' });
    await engine.reconcile();
    const old = ports.scheduler.queued('architect-repair')[0]!.task;
    assert.equal(ports.scheduler.card<ArchitectRepairCard>(old).dplan, 'dplan.m1.1.1');
    // plan B: its last review handed back, and its effect written by one pass that has not reached the repair step yet
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: ['W-1'], mode: 'fast' });
    await drive(engine, ports.scheduler, withKinds({ 'architect-repair': () => null, 'calibrator-2': () => null }));
    const cal2 = ports.scheduler.queued('calibrator-2')[0]!;
    assert.deepEqual(await ports.scheduler.run(cal2.task, { handBack: cal2Pass(cal2.card as never) }), []);
    await planningStep(flowCtx(ports, M));
    assert.equal((await planInEffect(flowCtx(ports, M)))?.eff.dplan, 'dplan.m1.2.1');
    assert.throws(() => pmDispatch(ports.ctx, old), (e: unknown) => (e as { code?: string }).code === 'NOT_READY' && /was queued on dplan\.m1\.1\.1, and dplan\.m1\.2\.1 took effect since; run mp pm next to rebuild the step/.test((e as Error).message));
    await engine.reconcile();
    const next = ports.scheduler.queued('architect-repair');
    assert.deepEqual(next.map((t) => (t.card as unknown as ArchitectRepairCard).dplan), ['dplan.m1.2.1'], 'the repair moved to an attempt on the plan in effect');
    const d = pmDispatch(ports.ctx, next[0]!.task).dispatch;
    assert.equal((dispatchView(ports.ctx, d).card as unknown as ArchitectRepairCard).dplan, 'dplan.m1.2.1');
  });
});

describe('p3-3: an unpinned product accepted after the repair step was queued is on the card when its start holds', () => {
  it('the start resolver decides it: its rule with no recorded prerequisite at a plain claim, the flow\'s resolver checked before the write at mp pm dispatch, and a claim that meets one it did not check is sent back to check it', async () => {
    const { ports, engine } = await world();
    // iface's dispatch as a pre-4.1.3 engine recorded it: without its prerequisite pin
    const append = ports.ledger.append.bind(ports.ledger);
    ports.ledger.append = ((op, e) => append(op, { ...e, ...(e.events !== undefined ? { events: e.events.map((x) => {
      if (x.event !== 'dispatched' || x.key !== 'con.m1.iface.1') return x;
      const { prerequisites: _pin, ...body } = x.body as { prerequisites?: unknown };
      return { ...x, body };
    }) } : {}) })) as typeof ports.ledger.append;
    await drive(engine, ports.scheduler, withKinds({ reviewer: (t) => ((t.card as unknown as ReviewerCard).target.includes('iface') ? null : { handBack: reviewer(t.card as unknown as ReviewerCard, 'pass') }) }));
    const w2 = say(ports, 'Trying it, the header row is lost.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'defect', text: 'the header row is lost' });
    await engine.reconcile();
    const step = ports.scheduler.queued('architect-repair')[0]!.task;
    assert.deepEqual(ports.scheduler.card<ArchitectRepairCard>(step).accepted, [], 'queued before iface was accepted');
    const rev = ports.scheduler.queued('reviewer')[0]!;
    assert.deepEqual(await ports.scheduler.run(rev.task, { handBack: reviewer(rev.card as never, 'pass') }), []);
    await engine.reconcile();
    const d1 = pmDispatch(ports.ctx, step).dispatch;
    assert.deepEqual((dispatchView(ports.ctx, d1).card as unknown as ArchitectRepairCard).accepted.map((a) => a.task), ['iface'], 'its start holds: it is offered to reopen, not to change');
    await pmRelease(ports.ctx, d1, 'ended');
    // a claim that meets an unpinned product its caller did not check is refused, to check and claim again
    assert.throws(() => pmDispatch(ports.ctx, step, { starts: new Map() }), (e: unknown) => (e as { detail?: Record<string, unknown> }).detail?.[STARTS_CHANGED] === true);
    // mp pm dispatch checks the starts with the flow's own resolver first: in this process the resolver finds the start does not hold
    const other = anotherProcess(ports, { startHolds: async () => ({ holds: false, missing: [] }) });
    const d2 = await pmDispatchChecked(other, step);
    assert.deepEqual((dispatchView(other, d2.dispatch).card as unknown as ArchitectRepairCard).accepted, []);
  });
});

/** A claim as a 4.3 engine wrote it (no served-receipt mark on its claimed event). */
function claim43(ctx: ProcessContext, step: string): string {
  return ctx.memory.write({}, (tx) => {
    const t = taskInfo(tx, step)!;
    const dispatch = `D-${Number((tx.stmt('SELECT COUNT(*) AS n FROM dispatches').get() as { n: number }).n) + 1}`;
    const prior = Number((tx.stmt('SELECT COUNT(*) AS n FROM dispatches WHERE task = ?').get(step) as { n: number }).n);
    claimDispatch(tx, { dispatch, task: step, seat: 'calibrator-1', capabilities: [], filler: null, worktree: false, card: '# the card of a 4.3 claim\n' });
    appendRecords(tx, [{ kind: 'flow.event', mission: M, line: DISPATCH_LINE(dispatch), event: 'claimed', key: 'spec', body: tx.data.put(canonicalJson({ spec: t.card, task: step, lineage: t.lineage, dispatches: prior, generation: null })) as ContentHash }]);
    return dispatch;
  });
}

describe('p3-4, p3-6 and a retry across the upgrade: release accounting', () => {
  it('p3-4: a dispatch claimed by 4.3 keeps 4.3 accounting: its release counts even with no trace, and an exhausted lineage stays exhausted', async () => {
    const { ports, engine } = await world();
    await engine.reconcile();
    const ctx = ports.ctx;
    const step = ports.scheduler.queued('calibrator-1')[0]!.task;
    for (let i = 0; i < 2; i++) {
      const d = pmDispatch(ctx, step).dispatch;
      seatCard(ctx, d);
      assert.equal((await pmRelease(ctx, d, 'ended')).requeued, true);
    }
    // claimed under 4.3 and its card read there (4.3 recorded no receipt); released after the upgrade
    const d3 = claim43(ctx, step);
    const r = await pmRelease(ctx, d3, 'ended');
    assert.deepEqual([r.unstarted, r.exhausted, r.requeued], [undefined, true, false]);
  });

  it('p3-6: past a thousand claims of one step a claim is a new dispatch, and the row of unstarted releases is read newest first', async () => {
    const { ports, engine } = await world();
    await engine.reconcile();
    const ctx = ports.ctx;
    const step = ports.scheduler.queued('calibrator-1')[0]!.task;
    const filler = { harness: 'test', model: 'scripted' };
    // 1,001 claims of the step released before a seat started, with their operations' receipts
    for (let chunk = 0; chunk < 11; chunk++) ctx.memory.write({}, (tx) => {
      for (let i = 0; i < 91; i++) {
        const dispatch = `D-${Number((tx.stmt('SELECT COUNT(*) AS n FROM dispatches').get() as { n: number }).n) + 1}`;
        const ord = Number((tx.stmt('SELECT COUNT(*) AS n FROM dispatches WHERE task = ?').get(step) as { n: number }).n) + 1;
        claimDispatch(tx, { dispatch, task: step, seat: 'calibrator-1', capabilities: [], filler, worktree: false });
        tx.append({ kind: 'op.receipt', op: `dispatch:${step}:${ord}`, payloadHash: hashJson({ step, attempt: ord, filler }), response: canonicalJson({ dispatch, card: '', cardLeaf: '', worktree: null }) });
        releaseDispatch(tx, { dispatch, how: 'ended', requeue: true });
        appendRecords(tx, [{ kind: 'flow.event', mission: M, line: DISPATCH_LINE(dispatch), event: UNSTARTED_RELEASE, key: 'release', body: tx.data.put(canonicalJson({ dispatch, how: 'ended' })) as ContentHash }]);
      }
    });
    assert.equal(ctx.memory.read((db) => (db.stmt('SELECT COUNT(*) AS n FROM dispatches WHERE task = ?').get(step) as { n: number }).n), 1001);
    const d = pmDispatch(ctx, step, { filledBy: 'test/scripted' });
    assert.equal(d.dispatch, 'D-1002', 'a new claim, not the receipt of an earlier one');
    assert.equal(ctx.memory.read((db) => listDispatches(db, { state: 'in-flight', limit: 10 })).map((x) => x.dispatch).join(), 'D-1002');
    assert.equal((await pmRelease(ctx, d.dispatch, 'ended')).unstarted, 1002);
  });

  it('a release and a claim recorded by 4.3 and retried under 4.4 replay their receipts: the same operation ids and payloads, no conflict', async () => {
    const { ports, engine } = await world();
    await engine.reconcile();
    const ctx = ports.ctx;
    const step = ports.scheduler.queued('calibrator-1')[0]!.task;
    const d = pmDispatch(ctx, step, { filledBy: 'test/scripted' }).dispatch;
    const receipt = (op: string) => ctx.memory.read((db) => db.stmt('SELECT payload_hash FROM ops WHERE op = ?').get(op) as { payload_hash: string } | undefined)?.payload_hash;
    assert.equal(receipt(`dispatch:${step}:1`), hashJson({ step, attempt: 1, filler: { harness: 'test', model: 'scripted' } }), 'the claim keeps the 4.3 identity and payload');
    // the release 4.3 committed, with its 4.3 answer (counted)
    const lineage = ctx.memory.read((db) => taskInfo(db, step))!.lineage;
    ctx.memory.write({}, (tx) => {
      appendRecords(tx, [{ kind: 'loop.attempt', lineage, loop: 'quarantine-restart', failureClass: null, signature: `release:${d}` }]);
      releaseDispatch(tx, { dispatch: d, how: 'ended', requeue: true });
      tx.append({ kind: 'op.receipt', op: `release:${d}:ended`, payloadHash: hashJson({ dispatch: d, how: 'ended' }), response: canonicalJson({ released: true, requeued: true, exhausted: false, attempts: 1, allowed: 2 }) });
    });
    const r = await pmRelease(ctx, d, 'ended');
    assert.deepEqual([r.released, r.attempts, r.unstarted], [true, 1, undefined], 'the recorded answer');
    assert.equal(ctx.memory.read((db) => loopState(db, lineage, 'quarantine-restart')).attempts, 1, 'counted once');
  });
});

describe('p3-5: a foreground run started by a seat is a start while it executes', () => {
  it('released while its rerun runs, the dispatch counts as started', async () => {
    let hold = false;
    let entered!: () => void;
    const inRun = new Promise<void>((r) => (entered = r));
    let go!: () => void;
    const gate = new Promise<void>((r) => (go = r));
    const runner: CommandRunner = async (req) => {
      if (hold) {
        entered();
        await gate;
      }
      return shellRunner(req);
    };
    p = processProject({ options: { runner } });
    const ctx = p.ctx;
    await addMissionToReview(p, M);
    const d = pmDispatch(ctx, (await readyOf(ctx, 'reviewer')).step).dispatch;
    hold = true;
    const running = seatRerun(ctx, d, 'check');
    await inRun;
    assert.equal(ctx.memory.read((db) => flowEvents(db, { mission: M, line: DISPATCH_LINE(d), event: RUN_STARTED_EVENT })).length, 1, 'recorded when admitted');
    const r = await pmRelease(ctx, d, 'abandoned');
    assert.deepEqual([r.unstarted, r.attempts], [undefined, 1]);
    hold = false;
    go();
    assert.equal((await running).passed, true, 'its evidence is recorded when it ends, as before');
  });
});

describe('p3-7: the data formats and storage are those of the plan of the card', () => {
  it("a Constructor queued under plan A and claimed under plan B gets B's lists; its Reviewer gets those of the plan its target's contract relies on", async () => {
    const { ports, engine } = await world();
    const planA = (): DetailedPlanDoc => ({ ...detailedPlan(M), dataFormats: ['format A'] });
    const planB = (): DetailedPlanDoc => ({ ...detailedPlan(M), dataFormats: ['format B'] });
    await drive(engine, ports.scheduler, withKinds({ constructor: () => null }, planA));
    assert.deepEqual(ports.scheduler.card<ConstructorCard>('con.m1.iface.1').dataFormats, ['format A']);
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: ['W-1'], mode: 'fast' });
    await drive(engine, ports.scheduler, withKinds({ constructor: () => null, 'architect-decompose': () => ({ handBack: architect(planB()) }) }));
    assert.equal((await planInEffect(flowCtx(ports, M)))?.eff.dplan, 'dplan.m1.2.1');
    assert.ok(ports.scheduler.queued('constructor').some((t) => t.task === 'con.m1.iface.1'), 'the kept card stays queued');
    assert.deepEqual(await ports.scheduler.run('con.m1.iface.1', { handBack: constructorDone() }), []);
    assert.deepEqual(claimed<ConstructorCard>(ports, 'con.m1.iface.1').dataFormats, ['format B'], 'the plan in effect at the claim');
    await drive(engine, ports.scheduler, withKinds({ reviewer: () => null, constructor: () => null }));
    assert.deepEqual(ports.scheduler.card<ReviewerCard>('rev.m1.iface.1').dataFormats, ['format A'], 'the plan its target was made and is judged under');
    assert.deepEqual(await ports.scheduler.run('rev.m1.iface.1', { handBack: reviewer(ports.scheduler.card<ReviewerCard>('rev.m1.iface.1'), 'pass') }), []);
    assert.deepEqual(claimed<ReviewerCard>(ports, 'rev.m1.iface.1').dataFormats, ['format A']);
  });
});

describe('p3-8: a mechanical return keeps the previous feasibility report', () => {
  it('after a feasibility return and a mechanical return of the revision, the next feasibility review and the Architect still get the returned report', async () => {
    const { ports, engine } = await world();
    let returned = false;
    const broken = (): DetailedPlanDoc => ({ ...detailedPlan(M), tasks: detailedPlan(M).tasks.map((t) => (t.id === 'impl' ? { ...t, writeScope: [] } : t)) });
    await drive(engine, ports.scheduler, withKinds({
      'architect-feasibility': (t) => (returned ? { handBack: { findings: [], criticalPath: [], verdict: 'feasible' } } : ((returned = true), { handBack: feasibilityReturn(t.card as unknown as ArchitectFeasibilityCard, 'the parser buffers whole files'), report: '# Feasibility\n\nWhole files in memory.\n' })),
      'architect-decompose': (t) => {
        const r = (t.card as unknown as ArchitectDecomposeCard).revision;
        return { handBack: architect(r !== null && r.feasibilityFindings.length > 0 ? broken() : detailedPlan(M)) };
      },
    }));
    const third = ports.scheduler.card<ArchitectDecomposeCard>('arch.m1.1.3');
    assert.ok((third.revision?.mechanicalFailures.length ?? 0) > 0 && third.revision?.feasibilityFindings.length === 0, 'a mechanical return');
    for (const card of [third, ports.scheduler.card<ArchitectFeasibilityCard>('feas.dplan.m1.1.3')]) {
      const m = card.materials?.find((x) => x.id === 'feasibility-report');
      assert.ok(m !== undefined, JSON.stringify(card.materials ?? null));
      assert.ok(ports.ledger.content.get(m.ref as never).startsWith('# The feasibility review of detailed plan dplan.m1.1.1\nReview feas.dplan.m1.1.1 '));
    }
  });
});

void fixTask;
