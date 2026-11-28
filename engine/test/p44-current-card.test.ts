// 4.4 (F5, problem P3): a card that is current when it is claimed. The architect-repair card is
// rebuilt at its claim from the planning inputs in force (issues 53, 68); the first `mp seat <id>
// card` records a served receipt (a failure to record it never refuses the card); and a release of a
// dispatch that had not started costs no re-dispatch, counted apart, the third in a row on one step
// raising a notice. A 4.3 memory, with neither the receipt nor the count, releases as 4.3 did.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import type { DetailedTask } from '../src/flow/plandoc.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { recordConstraint } from '../src/flow/requirements.ts';
import { cal1Pass, cal2Pass, drive, happyScript, pmPlan, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import { flowEvents, loopState } from '../src/memory/index.ts';
import { DISPATCH_LINE, pmDispatch, pmNext, pmRelease, pmRepair, seatCard, seatRead, SERVED_EVENT, UNSTARTED_RELEASE } from '../src/process/index.ts';
import { dispatchView } from '../src/process/seat.ts';
import { renderSeatCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import { cli } from './cli-fixtures.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';
import { done43, escalation43, live43, project43 } from './p43-fixtures.ts';
import { addDetailedPlan, processProject, readyOf, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
let p: ProcessProject | null = null;
afterEach(() => {
  p?.cleanup();
  p = null;
});

const ESTIMATE = { durationMs: 60_000, costMicros: 100_000, basis: 'small' };
const fixTask = (): DetailedTask => ({
  id: 'fixhdr', kind: 'implementation', module: 'parser', goal: 'Keep the header row', standards: [{ id: 'S1', text: 'The header row is kept' }], requirementItems: [],
  writeScope: ['src/parser/header.ts'], readableFiles: [], interpreter: 'node', verificationCommands: [{ id: 'test', command: 'npm test' }], implements: [], calls: [], dependsOn: ['impl'], exclusive: [], estimate: ESTIMATE, provenance: 'architect',
});

describe('4.4 F5: the architect-repair card is rebuilt at its claim (#53, #68)', () => {
  it('constraints recorded and repairs decided after the step was queued reach its card at the claim, and again after an unstarted release', async () => {
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
    const engine = new FlowEngine(ports);
    await drive(engine, ports.scheduler, happyScript(M));
    const scope = { paths: ['**'], taskTypes: [] };
    await recordConstraint(ports, { mission: M, constraint: 'c1', kind: 'instruction', text: 'Log nothing', scope });
    const w2 = say(ports, 'Trying it, the header row is lost and quoted commas split fields.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'defect', text: 'the header row is lost', about: 'impl' });
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'defect', text: 'quoted commas split fields' });
    await engine.reconcile();
    const steps = ports.scheduler.queued('architect-repair');
    const of = (id: string): string => steps.find((t) => (t.card as unknown as ArchitectRepairCard).repair.id === id)!.task;
    // R-1 is decided first: its amendment adds a task to the plan in effect
    assert.deepEqual(await ports.scheduler.run(of('R-1'), { handBack: { reopen: [], add: [fixTask()], note: 'a new task keeps the header' } }), []);
    await engine.reconcile();
    // while R-2 waits, the PM records a new version of c1 and a new constraint
    await recordConstraint(ports, { mission: M, constraint: 'c1', kind: 'instruction', text: 'Log nothing, errors included', scope });
    await recordConstraint(ports, { mission: M, constraint: 'c2', kind: 'object', text: 'No network access', scope });
    const queued = ports.scheduler.card<ArchitectRepairCard>(of('R-2'));
    assert.deepEqual(queued.constraints.map((c) => c.text), ['Log nothing'], 'the queued card is as it was built');
    assert.deepEqual(queued.plan.tasks.map((t) => t.id), ['iface', 'impl']);

    const d = pmDispatch(ports.ctx, of('R-2'), { filledBy: 'test/scripted' }).dispatch;
    const card = dispatchView(ports.ctx, d).card as unknown as ArchitectRepairCard;
    assert.deepEqual(card.constraints.map((c) => c.text).sort(), ['Log nothing, errors included', 'No network access'], 'the constraints in force at the claim');
    assert.deepEqual(card.plan.tasks.map((t) => t.id), ['iface', 'impl', 'fixhdr'], 'the plan in effect with the repair decided since');
    assert.deepEqual(card.accepted.map((a) => a.task), ['iface', 'impl']);
    assert.ok(card.accepted.every((a) => typeof a.commit === 'string' && a.commit.length > 0), JSON.stringify(card.accepted));
    const plan = ports.ledger.content.get(card.materials![0]!.ref as never);
    assert.ok(card.materials![0]!.id === 'plan' && plan.includes('"id":"fixhdr"'), 'its plan material is rebuilt with it');
    const rendered = renderSeatCard(card as never, { dispatch: d });
    assert.ok(rendered.includes('[constraint.c1] Instruction (follow it; not a proof input): Log nothing, errors included') &&rendered.includes('- [fixhdr] implementation of parser: Keep the header row'), rendered);
    assert.ok(rendered.includes(`\`mp seat ${d} checkout --product <task>\``), 'the repair Architect may read an accepted product');

    // released before its seat started: it costs nothing, and the next claim is rebuilt again
    const rel = await pmRelease(ports.ctx, d, 'ended');
    assert.equal(rel.unstarted, 1);
    await recordConstraint(ports, { mission: M, constraint: 'c1', kind: 'instruction', text: 'Log nothing at all', scope });
    const d2 = pmDispatch(ports.ctx, of('R-2'), { filledBy: 'test/scripted' }).dispatch;
    assert.ok((dispatchView(ports.ctx, d2).card as unknown as ArchitectRepairCard).constraints.some((c) => c.text === 'Log nothing at all'));
  });
});

describe('4.4 F5: the served receipt', () => {
  it('the first mp seat <id> card records that the card was served, once; a failure to record it never refuses the card', async () => {
    p = processProject();
    const ctx = p.ctx;
    await startAddMission(ctx, M);
    const d = pmDispatch(ctx, (await readyOf(ctx, 'calibrator-1')).step).dispatch;
    const served = () => ctx.memory.read((db) => flowEvents(db, { mission: M, line: DISPATCH_LINE(d), event: SERVED_EVENT }));
    assert.equal(served().length, 0, 'claiming is not serving');
    const first = seatCard(ctx, d);
    assert.equal(served().length, 1);
    assert.equal(seatCard(ctx, d).text, first.text);
    assert.equal(served().length, 1, 'recorded once');
    // a memory that refuses the write: the card is served all the same
    await pmRelease(ctx, d, 'ended');
    const d2 = pmDispatch(ctx, (await readyOf(ctx, 'calibrator-1')).step).dispatch;
    const write0 = ctx.memory.write.bind(ctx.memory);
    (ctx.memory as { write: unknown }).write = ((req: { op?: string }, fn: never) => {
      if (req.op?.startsWith('served:') === true) throw new Error('the disk is full');
      return write0(req as never, fn);
    }) as never;
    try {
      assert.equal(seatCard(ctx, d2).dispatch, d2);
    } finally {
      (ctx.memory as { write: unknown }).write = write0;
    }
    assert.equal(ctx.memory.read((db) => flowEvents(db, { mission: M, line: DISPATCH_LINE(d2), event: SERVED_EVENT })).length, 0);
  });

  it("the resident Secretary's mp sec card claims its round and prints the card: it is served at the claim", async () => {
    const q = project43();
    p = q;
    await escalation43(q);
    const id = await live43(q);
    const card = await done43(q, ['sec', 'card', 'choice'], id);
    assert.equal(q.ctx.memory.read((db) => flowEvents(db, { mission: M, line: DISPATCH_LINE(card.dispatch), event: SERVED_EVENT })).length, 1);
  });
});

describe('4.4 F5: releasing an unstarted dispatch costs nothing', () => {
  it('no served card, no read, no run, no checkout, no refused hand-back: not counted, counted apart; the third in a row raises a notice; a started one counts as before', async () => {
    p = processProject();
    const ctx = p.ctx;
    await startAddMission(ctx, M);
    const s = await readyOf(ctx, 'calibrator-1');
    const lineage = ctx.memory.read((db) => (db.stmt('SELECT lineage FROM tasks WHERE task = ?').get(s.step) as { lineage: string }).lineage);
    const attempts = () => ctx.memory.read((db) => loopState(db, lineage, 'quarantine-restart')).attempts;
    // a dispatch released after its seat read a material page (a 4.3 memory shows no served receipt): counted, as in 4.3
    const started = pmDispatch(ctx, s.step).dispatch;
    const m = (dispatchView(ctx, started).card['materials'] as Array<{ id: string }>)[0]!.id;
    seatRead(ctx, started, m, 1);
    const r0 = await pmRelease(ctx, started, 'ended');
    assert.deepEqual([r0.unstarted, r0.attempts, r0.requeued], [undefined, 1, true]);
    // then three releases before any seat started
    const rows: number[] = [];
    for (let i = 0; i < 3; i++) {
      const d = pmDispatch(ctx, s.step).dispatch;
      const r = await pmRelease(ctx, d, i === 1 ? 'abandoned' : 'ended');
      assert.equal(r.requeued, true);
      assert.equal(r.exhausted, false);
      assert.ok(ctx.memory.read((db) => flowEvents(db, { mission: M, line: DISPATCH_LINE(d), event: UNSTARTED_RELEASE })).length === 1, 'counted apart, on its dispatch line');
      rows.push(r.unstarted ?? 0);
    }
    assert.deepEqual(rows, [1, 2, 3]);
    assert.equal(attempts(), 1, 'none of them used a re-dispatch');
    const notices = (await pmNext(ctx)).notices.filter((n) => n.category === 'unstarted-releases');
    assert.equal(notices.length, 1, 'the third in a row raises one notice');
    assert.equal(notices[0]!.wi, 'WI-28');
    assert.match(notices[0]!.trigger, new RegExp(`^step ${s.step.replace(/\./g, '\\.')} was released 3 times in a row before its seat started`));
    // a served card is a start: that release counts and ends the row
    const d4 = pmDispatch(ctx, s.step).dispatch;
    seatCard(ctx, d4);
    const r4 = await pmRelease(ctx, d4, 'ended');
    assert.deepEqual([r4.unstarted, r4.attempts], [undefined, 2]);
    const r5 = await pmRelease(ctx, pmDispatch(ctx, s.step).dispatch, 'ended');
    assert.equal(r5.unstarted, 1, 'a new row');
    const out = await cli(p.dir, ['pm', 'release', pmDispatch(ctx, s.step).dispatch, '--ended']);
    assert.equal(out.code, 0, out.err);
    assert.match(out.out, /It had not started \(no card served, nothing read, run or checked out, no refused hand-back, no change in a worktree\): this release costs no re-dispatch\./);
  });

  it("a Constructor's dispatch is unstarted only with a clean worktree", async () => {
    p = processProject();
    const ctx = p.ctx;
    await startAddMission(ctx, M);
    await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(ctx, 'architect-decompose', () => addDetailedPlan(M));
    await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
    const s = await readyOf(ctx, 'constructor');
    const clean = pmDispatch(ctx, s.step);
    assert.equal((await pmRelease(ctx, clean.dispatch, 'ended')).unstarted, 1);
    const dirty = pmDispatch(ctx, s.step);
    write(join(p.dir, dirty.worktree!), 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    const r = await pmRelease(ctx, dirty.dispatch, 'ended');
    assert.deepEqual([r.unstarted, r.attempts], [undefined, 1], 'a change in the worktree is a start');
  });
});
