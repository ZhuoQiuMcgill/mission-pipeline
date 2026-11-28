// 4.4 (F12 a and b, the flow parts of F13; problem P13; issues 59, 60, 61): repairs in the flow. A repair's reopen
// is new work on the user's words: it is not counted on the task's loop, its work gets a fresh loop, and acceptance
// with risk is offered at its end. A reopen may come after other work of the same repair, and a dependent of that
// repair's work waits while a dependency it reopens is pending. A repair is filed again with --again; a decision
// whose card changed since its Architect saw it goes back once; a second reopen of an attempt that moved on is
// merged or pinned again, never dropped. (The cap itself, F12 c: p44-rework-cap.test.ts.)

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { beginAction, endAction } from '../src/cli/project.ts';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { acceptedProduct, MERGED_DUTIES, REOPEN_MERGED, REOPEN_NOT_CARRIED, REOPEN_PINNED, reworkLineage, taskLineage } from '../src/flow/execution.ts';
import type { DetailedTask } from '../src/flow/plandoc.ts';
import { planInEffect, submitPmBatch } from '../src/flow/planning.ts';
import { answerEscalation, type EscalationBody } from '../src/flow/secretary.ts';
import { constructorDone, drive, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { pmDispatch, pmNext, pmRepair, pmSay } from '../src/process/pm.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { ConstructorCard, ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import { cli } from './cli-fixtures.ts';
import { recordRepair } from '../src/flow/repair.ts';
import { attack, hand, M as XM, submit, world as xworld } from './flow-exploration-fixtures.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';
import { command43, project43 } from './p43-fixtures.ts';
import { addMissionToReview, handBack, processProject, readAll, readyOf, reviewerPass, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
const events = <B = any>(w: World, line: string, event: string) => w.ledger.events<B>({ mission: M, line, event });
const loopEscalations = async (w: World) => (await events<EscalationBody>(w, 'secretary', 'escalation')).map((e) => e.body).filter((e) => e.source === 'loop-exhausted');
const ESTIMATE = { durationMs: 60_000, costMicros: 100_000, basis: 'small' };
const task = (o: Partial<DetailedTask> & { id: string }): DetailedTask => ({
  kind: 'implementation', module: 'parser', goal: `Task ${o.id}`, standards: [{ id: 'S1', text: `${o.id} works` }], requirementItems: [], writeScope: [`src/parser/${o.id}.ts`], readableFiles: [], interpreter: 'node',
  verificationCommands: [{ id: 'test', command: 'npm test' }], implements: [], calls: [], dependsOn: ['iface'], exclusive: [], estimate: ESTIMATE, provenance: 'architect', ...o,
});

async function world(o: { reworkCap?: number } = {}): Promise<{ w: World; engine: FlowEngine }> {
  const w = memoryPorts(o);
  say(w, SEED_TEXT);
  await seedMission(w, M);
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  return { w, engine: new FlowEngine(w) };
}
function script(over: Record<string, Script> = {}): Script {
  const base = happyScript(M);
  return (t, s) => (Object.hasOwn(over, t.card.seat) ? over[t.card.seat]! : base)(t, s);
}
/** A Reviewer that sends back the products `rework` names and passes the rest. */
const reviews = (rework: (target: string) => boolean): Script => (t) => {
  const c = t.card as unknown as ReviewerCard;
  return { handBack: reviewer(c, rework(c.target) ? 'rework' : 'pass', { findings: [`finding at ${c.target}`] }) };
};
/** Leaves one task queued; the rest as `s`. */
const hold = (id: string, s: Script = happyScript(M)): Script => (t, sc) => (t.task === id ? null : s(t, sc));
async function repair(w: World, text: string, about?: string): Promise<string> {
  const words = say(w, `Trying it: ${text}.`);
  return (await pmRepair(w.ctx, { mission: M, words, kind: 'defect', text, ...(about !== undefined ? { about } : {}) })).repair;
}
const archStep = (w: World, id: string): string => w.scheduler.queued('architect-repair').find((t) => (t.card as unknown as ArchitectRepairCard).repair.id === id)!.task;
const reopenImpl = (issue: string) => ({ handBack: { reopen: [{ task: 'impl', issue }], add: [], note: 'impl owns it' } });
async function settled(w: World, engine: FlowEngine): Promise<void> {
  const head = w.ledger.head;
  assert.deepEqual((await engine.reconcile()).flatMap((r) => r.errors), []);
  assert.equal(w.ledger.head, head, 'a further pass writes nothing');
}
/** The record 4.3 left of a repair's reopen counted on impl's used-up loop (a 4.4 reopen is not counted). */
async function countedBy43(w: World, repairId: string): Promise<void> {
  const lineage = taskLineage(M, 'impl');
  await w.ledger.append(`test:43-counted-reopen:${repairId}`, { events: [
    { mission: M, line: 'task:impl', event: 'loop-return', key: `reopen:repair:${repairId}`, body: { decision: 'exhausted', lineage, loop: 'rework', signature: 'legacy-repair-reopen' } },
    { mission: M, line: 'task:impl', event: 'loop-verdict', key: `reopen:repair:${repairId}`, body: { proceed: false, attempts: 2, allowed: 2, reason: 'cap' } },
  ] });
}
/** impl's own rework loop used up (attempts 1 and 2 sent back), its attempt 3 accepted. */
async function usedUpThenAccepted(): Promise<{ w: World; engine: FlowEngine }> {
  const x = await world();
  await drive(x.engine, x.w.scheduler, script({ reviewer: reviews((p) => p === 'prod.con.m1.impl.1' || p === 'prod.con.m1.impl.2'), secretary: () => null }));
  assert.equal(await acceptedProduct(flowCtx(x.w, M), 'impl'), 'prod.con.m1.impl.3');
  assert.equal((await x.w.ledger.loop(taskLineage(M, 'impl'), 'rework')).attempts, 2);
  return x;
}

let p: ProcessProject | null = null;
afterEach(() => {
  p?.cleanup();
  p = null;
});

describe('4.4 F12 (a): a repair reopen starts a fresh rework loop', () => {
  it("its reworks count on a loop of their own: the task's count stays, and acceptance with risk is offered at its end", async () => {
    const { w, engine } = await usedUpThenAccepted();
    await repair(w, 'the header row is lost', 'impl');
    // every review of the reopened work sends it back
    await drive(engine, w.scheduler, script({ 'architect-repair': () => reopenImpl('keep the header row'), reviewer: reviews((x) => /impl\.[4-9]$/.test(x)), secretary: () => null }));
    const fresh = `${taskLineage(M, 'impl')}.reopen4`;
    assert.ok(['4', '5', '6'].every((k) => w.scheduler.tasks.has(`con.m1.impl.${k}`)) && !w.scheduler.tasks.has('con.m1.impl.7'), 'the reopened attempt and two reworks');
    const es = (await loopEscalations(w)).filter((e) => e.lineage === fresh);
    assert.equal(es.length, 1);
    assert.match(es[0]!.summary, /the reworks of repair R-1's reopen are used up \(2\/2\)/);
    assert.ok(es[0]!.options.includes('accept-risk'), 'acceptance with risk is offered at its end, as for any attempt');
    assert.equal((await w.ledger.loop(taskLineage(M, 'impl'), 'rework')).attempts, 2, "the task's own count is left as it was");
    assert.equal((await w.ledger.loop(fresh, 'rework')).attempts, 2);
    const words = say(w, 'Accept the header fix as it is.');
    await answerEscalation(w, { mission: M, escalation: es[0]!.id, option: 'accept-risk', words: `Accept it as it is. (${words})` });
    await drive(engine, w.scheduler, script({ secretary: () => null }));
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.6');
  });

  it("the fresh loop ends with the acceptance of the repair's work; a 4.3 line counts on the task's loop", () => {
    const line: Array<{ revision: number; event: string; key: string; body: unknown }> = [];
    const add = (event: string, key: string, body: unknown) => line.push({ revision: line.length + 1, event, key, body });
    const base = taskLineage(M, 'impl');
    add('accepted', '1', { k: 1, product: 'p1' });
    add('rework', '2', { k: 2, reason: 'reopen', issues: ['x'], instructions: [], reopen: { kind: 'repair', repair: 'R-1' }, loop: `${base}.reopen2` });
    add('rework', '3', { k: 3, reason: 'reviewer', issues: ['y'], instructions: [] });
    assert.equal(reworkLineage(M, 'impl', line, 1), base, 'before the reopen');
    assert.equal(reworkLineage(M, 'impl', line, 2), `${base}.reopen2`);
    assert.equal(reworkLineage(M, 'impl', line, 3), `${base}.reopen2`, 'and the reworks that follow it');
    add('accepted', '3', { k: 3, product: 'p3' });
    assert.equal(reworkLineage(M, 'impl', line, 3), base, 'work after its acceptance (a re-bind, a re-review) is the task\'s own');
    const old = [{ revision: 1, event: 'rework', key: '2', body: { k: 2, reason: 'reopen', issues: ['x'], instructions: [], reopen: { kind: 'repair', repair: 'R-1' } } }];
    assert.equal(reworkLineage(M, 'impl', old, 2), base, 'a reopen 4.3 recorded names no loop');
  });
});

describe('4.4 F12 (b): a reopen may wait for other work of the same repair (#59)', () => {
  it('a reopen that comes after a task the repair adds waits for it, and starts on its work', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    await repair(w, 'quoted headers are split');
    await drive(engine, w.scheduler, script({
      'architect-repair': () => ({ handBack: { reopen: [{ task: 'impl', issue: 'read headers through hdr', after: ['hdr'] }], add: [task({ id: 'hdr' })], note: 'impl reads headers through hdr' } }),
      constructor: hold('con.m1.hdr.1'),
    }));
    const rw = (await events(w, 'task:impl', 'rework')).find((e) => e.key === '2')!.body;
    assert.deepEqual(rw.after, ['hdr']);
    assert.equal((await events(w, 'repairs', 'decided'))[0]!.body.reopen[0].after[0], 'hdr');
    assert.ok(!w.scheduler.tasks.has('con.m1.impl.2'), 'impl waits for hdr');
    await drive(engine, w.scheduler, script());
    const start = (await events(w, 'task:impl', 'dispatched')).find((e) => e.body.k === 2)!.body;
    assert.ok(start.prerequisites.includes('prod.con.m1.hdr.1'), `its start holds hdr's work: ${JSON.stringify(start.prerequisites)}`);
    assert.match(w.scheduler.card<ConstructorCard>('con.m1.impl.2').duties, /This attempt starts once hdr is accepted for the same repair, on its new work\./);
    for (const t of ['iface', 'impl', 'hdr']) assert.ok(await acceptedProduct(flowCtx(w, M), t), t);
    await settled(w, engine);
  });

  it("a task of the repair waits while a dependency the same repair reopens is pending (a 4.3 reopen waiting at its used-up loop)", async () => {
    const { w, engine } = await usedUpThenAccepted();
    await repair(w, 'the parser drops the last row');
    await countedBy43(w, 'R-1');
    await drive(engine, w.scheduler, script({
      'architect-repair': () => ({ handBack: { reopen: [{ task: 'impl', issue: 'keep the last row' }], add: [task({ id: 'tail', dependsOn: ['impl'] })], note: 'impl and a check' } }),
      secretary: () => null,
    }));
    const esc = (await loopEscalations(w)).at(-1)!;
    assert.equal((esc.facts as { reopen?: { repair: string } }).reopen?.repair, 'R-1', "impl's reopen waits for the Secretary");
    assert.ok(!w.scheduler.tasks.has('con.m1.tail.1'), 'tail does not start on the work its repair reopens');
    const words = say(w, 'Give impl one more attempt.');
    await answerEscalation(w, { mission: M, escalation: esc.id, option: 'grant', grantExtra: 1, words: `Grant it. (${words})` });
    await drive(engine, w.scheduler, script());
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.4');
    const start = (await events(w, 'task:tail', 'dispatched')).find((e) => e.body.k === 1)!.body;
    assert.ok(start.prerequisites.includes('prod.con.m1.impl.4'), JSON.stringify(start.prerequisites));
    await settled(w, engine);
  });

  it("the hand-back names in after only work of this repair, never the task itself, and no circle", async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    await repair(w, 'quoted headers are split');
    await engine.reconcile();
    const step = archStep(w, 'R-1');
    const problems = await w.scheduler.run(step, { handBack: { reopen: [{ task: 'impl', issue: 'x', after: ['iface', 'impl', 'hdr'] }], add: [task({ id: 'hdr', dependsOn: ['impl'] })], note: 'n' } });
    assert.ok(problems.includes('reopen[impl].after: "iface" is not a task this repair adds, changes or reopens'), problems.join('\n'));
    assert.ok(problems.includes('reopen[impl].after: a task does not come after itself'));
    assert.ok(problems.includes('reopen[impl].after: it waits for work that waits for it (a circle through after and dependsOn)'));
    // impl, reopened too, depends on iface by its card: iface coming after impl would wait for ever
    const again = await w.scheduler.run(step, { handBack: { reopen: [{ task: 'iface', issue: 'x', after: ['impl'] }, { task: 'impl', issue: 'y' }], add: [], note: 'n' } });
    assert.deepEqual(again, ['reopen[iface].after: it waits for work that waits for it (a circle through after and dependsOn)']);
  });
});

describe('4.4 F13: --again files a repair again (#60)', () => {
  it('without it the same repair returns the earlier one and says it was decided; with it a new one is filed, and one in work is returned', async () => {
    p = processProject();
    const ctx = p.ctx;
    await addMissionToReview(p, M);
    const rev = pmDispatch(ctx, (await readyOf(ctx, 'reviewer')).step).dispatch;
    readAll(ctx, rev);
    assert.equal((await handBack(ctx, rev, reviewerPass(dispatchView(ctx, rev).card as never))).kind, 'recorded');
    await pmNext(ctx);
    const words = pmSay(ctx, 'Trying it, add(2, 3) prints a warning. Please fix that.').words;
    const args = ['pm', 'repair', M, '--words', words, '--kind', 'defect', '--text', 'add(2, 3) prints a warning', '--about', 'impl'];
    let r = await cli(p.dir, args);
    assert.match(r.out, /Repair recorded: R-1 /, r.out + r.err);
    const d = pmDispatch(ctx, (await readyOf(ctx, 'architect-repair')).step).dispatch;
    readAll(ctx, d);
    assert.equal((await handBack(ctx, d, { reopen: [{ task: 'impl', issue: 'print no warning' }], add: [], note: 'impl owns it' })).kind, 'recorded');
    await pmNext(ctx);
    r = await cli(p.dir, args);
    assert.match(r.out, /Repair already recorded: R-1 \(defect\) of m1, from W-\d+: nothing new was filed\. R-1 is that repair, and it was decided: --again files a new one\./, r.out);
    const first = await cli(p.dir, [...args, '--again', '--op', 'again-op']);
    assert.match(first.out, /Repair recorded: R-2 .* Filed again: the same repair as R-1, and it was decided\./, first.out);
    // a retry with the same --op replays its receipt: nothing is filed twice
    const second = await cli(p.dir, [...args, '--again', '--op', 'again-op']);
    assert.match(second.out, /already done; its recorded result is shown/);
    assert.equal(second.out.split('\n')[0], first.out.split('\n')[0]);
    // again while R-2 is in work: the same filing in flight is returned
    r = await cli(p.dir, [...args, '--again', '--json']);
    assert.deepEqual([r.json.result.repair, r.json.result.repeated, r.json.result.over], ['R-2', true, undefined]);
    r = await cli(p.dir, [...args, '--again']);
    assert.match(r.out, /Repair already recorded: R-2 .*The same repair is still in work: --again filed nothing new\./, r.out);
    assert.equal(ctx.memory.read((db) => Number((db.stmt("SELECT COUNT(*) AS n FROM flow_events WHERE line = 'repairs' AND event = 'repair'").get() as { n: number }).n)), 2);
    r = await cli(p.dir, [...args, '--again', '--resnapshot']);
    assert.match(r.err, /--again files a repair again; a change form/);
  });

  it('about an exploration: the same repair is returned while its round runs; once the exploration stopped since, --again files a new one', async () => {
    const x = await xworld();
    say(x.ports, 'The design has to survive a restart of the scheduler.');
    await x.advance();
    await hand(x, 'researcher-author', submit('design v1'));
    await x.advance();
    await hand(x, 'crititor', attack());
    assert.equal((await x.advance()).stopped?.reason, 'converged');
    const req = { mission: XM, words: 'W-1', kind: 'new-question' as const, text: 'survive a restart of the scheduler', about: { kind: 'exploration' as const, id: x.x } };
    assert.deepEqual(await recordRepair(x.ports, req), { id: 'R-1', repeated: false });
    assert.deepEqual(await recordRepair(x.ports, { ...req, again: true }), { id: 'R-1', repeated: true }, 'its round runs: the same filing');
    await x.advance();
    await hand(x, 'researcher-author', submit('design v2'));
    await x.advance();
    await hand(x, 'crititor', attack());
    assert.equal((await x.advance()).stopped?.reason, 'converged');
    assert.deepEqual(await recordRepair(x.ports, req), { id: 'R-1', repeated: true, over: 'R-1' }, 'without --again, as in 4.3');
    assert.deepEqual(await recordRepair(x.ports, { ...req, again: true }), { id: 'R-2', repeated: false, over: 'R-1' });
  });

  it('compatibility: a 4.3 receipt of mp pm repair replays with the same --op (its identity without --again is unchanged)', async () => {
    p = project43();
    const op = 'old-repair';
    // the identity 4.3 computed for mp pm repair: its positionals, every flag as parsed (--op and --json included), the attempts file's hash
    const args43 = { positionals: ['m1'], flags: { words: 'W-1', kind: 'defect', text: 'it breaks', op, json: true }, attempts: null };
    const action = { op, command: 'repair', args: args43 };
    assert.equal(beginAction(p.ctx.memory, { ...action, filler: null }), null);
    endAction(p.ctx.memory, action, { exitCode: 0, text: 'recorded by 4.3 for repair', json: { recorded: 'repair' } }, false);
    const r = await command43(p, ['pm', 'repair', 'm1', '--words', 'W-1', '--kind', 'defect', '--text', 'it breaks', '--op', op]);
    assert.equal(r.code, 0, JSON.stringify(r));
    assert.equal(r.replayed, true);
    assert.deepEqual(r.result, { recorded: 'repair' });
  });
});

describe('4.4 F13: a repair does not overwrite a card it has not seen (#61)', () => {
  it("a change made on a card another repair changed since goes back once to its Architect, on the plan in effect, by the mechanical-return loop", async () => {
    const { w, engine } = await world();
    // iface accepted; impl's Constructor held, so impl has no accepted product and a repair may change its card
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.1') }));
    await repair(w, 'the header row is lost');
    await repair(w, 'quoted commas split fields');
    await engine.reconcile();
    const s1 = archStep(w, 'R-1');
    const s2 = archStep(w, 'R-2');
    // both Architects take their cards on the same plan
    w.scheduler.dispatchOf(s1);
    w.scheduler.dispatchOf(s2);
    const impl = (await planInEffect(flowCtx(w, M)))!.plan.tasks.find((t) => t.id === 'impl')!;
    assert.deepEqual(await w.scheduler.run(s1, { handBack: { reopen: [], add: [], change: [{ ...impl, standards: [...impl.standards, { id: 'S3', text: 'The header row is kept' }] }], note: 'impl keeps the header' } }), []);
    await engine.reconcile();
    assert.deepEqual(await w.scheduler.run(s2, { handBack: { reopen: [], add: [], change: [{ ...impl, standards: [...impl.standards, { id: 'S4', text: 'Quoted commas stay in their field' }] }], note: 'impl keeps quoted commas' } }), []);
    await engine.reconcile();
    assert.deepEqual((await events(w, 'repairs', 'decided')).map((e) => e.key), ['R-1'], 'R-2 is not applied over R-1');
    const back = w.scheduler.queued('architect-repair').find((t) => (t.card as unknown as ArchitectRepairCard).repair.id === 'R-2')!;
    const card = back.card as unknown as ArchitectRepairCard;
    assert.ok(card.revision?.mechanicalFailures.includes('change[impl]: the card of task impl changed after your card was built (repair R-1 changed it): make your change again on its card in the plan in effect now'), JSON.stringify(card.revision));
    const now = card.plan.tasks.find((t) => t.id === 'impl')!;
    assert.deepEqual(now.standards.map((s) => s.id), ['S1', 'S2', 'S3'], "the new card is built on R-1's change");
    assert.equal((await events(w, 'repairs', 'loop-verdict')).filter((e) => e.key.startsWith('mechanical:')).length, 1, 'one mechanical return');
    // on its new card the Architect makes its change again, and keeps R-1's
    assert.deepEqual(await w.scheduler.run(back.task, { handBack: { reopen: [], add: [], change: [{ ...now, standards: [...now.standards, { id: 'S4', text: 'Quoted commas stay in their field' }] }], note: 'both' } }), []);
    await engine.reconcile();
    assert.deepEqual((await planInEffect(flowCtx(w, M)))!.plan.tasks.find((t) => t.id === 'impl')!.standards.map((s) => s.id), ['S1', 'S2', 'S3', 'S4']);
  });

  it('an added id the plan in effect holds since the card was built goes back too; another amendment written in between the check and the write is read again, not overwritten', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    await repair(w, 'the header row is lost');
    await repair(w, 'the footer row is lost');
    await engine.reconcile();
    const s1 = archStep(w, 'R-1');
    const s2 = archStep(w, 'R-2');
    w.scheduler.dispatchOf(s1);
    w.scheduler.dispatchOf(s2);
    assert.deepEqual(await w.scheduler.run(s2, { handBack: { reopen: [], add: [task({ id: 'rows' })], note: 'a task for the footer' } }), []);
    // another process decides R-1 (which adds a task with the same id) between R-2's check and its write
    const append = w.ledger.append.bind(w.ledger);
    let between = true;
    (w.ledger as { append: typeof append }).append = async (op, entries) => {
      if (between && op === 'flow:repair-decided:m1:R-2') {
        between = false;
        assert.deepEqual(await w.scheduler.run(s1, { handBack: { reopen: [], add: [task({ id: 'rows', goal: 'Keep the header row' })], note: 'a task for the header' } }), []);
        const other = { ...w, ledger: w.ledger };
        (w.ledger as { append: typeof append }).append = append;
        await new FlowEngine(other).reconcile();
      }
      return append(op, entries);
    };
    const reports = await engine.reconcile();
    (w.ledger as { append: typeof append }).append = append;
    assert.ok(reports.flatMap((r) => r.errors).every((e) => /changed while repair R-2's decision was being recorded/.test(e.message)), JSON.stringify(reports));
    assert.ok(!w.ledger.notices.some((n) => n.category === 'flow-internal-error'), 'a transient refusal, retried; no defect');
    await engine.reconcile();
    assert.deepEqual((await events(w, 'repairs', 'decided')).map((e) => e.key), ['R-1']);
    const back = w.scheduler.queued('architect-repair').find((t) => (t.card as unknown as ArchitectRepairCard).repair.id === 'R-2')!.card as unknown as ArchitectRepairCard;
    assert.ok(back.revision?.mechanicalFailures.includes('add[rows]: task id "rows" was added to the plan in effect after your card was built (by repair R-1): use a fresh id, or change that task\'s card'), JSON.stringify(back.revision));
  });
});

describe('4.4 F13: two reopens of one accepted attempt are merged, not dropped', () => {
  async function bothClaimed(): Promise<{ w: World; engine: FlowEngine; s1: string; s2: string }> {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    await repair(w, 'the header row is lost');
    await repair(w, 'quoted commas split fields');
    await engine.reconcile();
    const s1 = archStep(w, 'R-1');
    const s2 = archStep(w, 'R-2');
    w.scheduler.dispatchOf(s1);
    w.scheduler.dispatchOf(s2);
    return { w, engine, s1, s2 };
  }

  it('a second reopen of the same accepted attempt joins the reopened attempt; one attempt answers both repairs', async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    assert.deepEqual(await w.scheduler.run(s2, reopenImpl('keep quoted commas in their field')), []);
    await engine.reconcile();
    assert.deepEqual((await events(w, 'repairs', 'decided')).map((e) => e.body.reopen[0].attempt), [1, 1]);
    assert.deepEqual((await events(w, 'repairs', REOPEN_MERGED)).map((e) => e.body), [{ repair: 'R-2', task: 'impl', attempt: 2, from: 1, issue: 'keep quoted commas in their field' }]);
    const con = w.scheduler.card<ConstructorCard>('con.m1.impl.2');
    assert.ok(con.duties.includes('keep the header row') && con.duties.includes(`${MERGED_DUTIES}\n- keep quoted commas in their field (repair R-2, defect;`), con.duties);
    assert.deepEqual(con.repairs?.map((r) => r.id).sort(), ['R-1', 'R-2']);
    await drive(engine, w.scheduler, script());
    assert.match(w.scheduler.card<ReviewerCard>('rev.m1.impl.2').duties, /Also reopened while it was open: repair R-2: keep quoted commas in their field\. Judge whether that is fixed too/);
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.2');
    assert.ok(!w.scheduler.tasks.has('con.m1.impl.3'), 'nothing reopened twice');
    await settled(w, engine);
  });

  it('merged into an attempt queued but not claimed: the claim lays the merged issue on its card', async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    assert.deepEqual(await w.scheduler.run(s2, reopenImpl('keep quoted commas in their field')), []);
    await engine.reconcile();
    assert.equal((await events(w, 'repairs', REOPEN_MERGED)).length, 1);
    assert.ok(!w.scheduler.card<ConstructorCard>('con.m1.impl.2').duties.includes('keep quoted commas'), 'the queued card was built before');
    const d = w.scheduler.dispatchOf('con.m1.impl.2');
    const claimed = dispatchView(w.ctx, d).card as unknown as ConstructorCard;
    assert.ok(claimed.duties.endsWith(`${MERGED_DUTIES}\n- keep quoted commas in their field (repair R-2, defect; the user's words W-3: "quoted commas split fields")`), claimed.duties);
    assert.deepEqual(claimed.repairs?.map((r) => r.id).sort(), ['R-1', 'R-2']);
  });

  it('an attempt already claimed: the reopen is pinned again to it, and reopens it once it is accepted, on a fresh loop', async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    w.scheduler.dispatchOf('con.m1.impl.2');
    assert.deepEqual(await w.scheduler.run(s2, reopenImpl('keep quoted commas in their field')), []);
    await engine.reconcile();
    assert.equal((await events(w, 'repairs', REOPEN_MERGED)).length, 0);
    assert.deepEqual((await events(w, 'repairs', REOPEN_PINNED)).map((e) => e.body), [{ repair: 'R-2', task: 'impl', attempt: 2, from: 1 }]);
    assert.deepEqual(await w.scheduler.run('con.m1.impl.2', { handBack: constructorDone() }), []);
    await drive(engine, w.scheduler, script());
    const rw = (await events(w, 'task:impl', 'rework')).find((e) => e.key === '3')!.body;
    assert.deepEqual([rw.reason, rw.reopen, rw.issues, rw.loop], ['reopen', { kind: 'repair', repair: 'R-2' }, ['keep quoted commas in their field'], `${taskLineage(M, 'impl')}.reopen3`]);
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.3');
    await settled(w, engine);
  });

  it('a reopen that can be neither merged nor pinned again is told to the PM as not carried out, and recorded', async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    w.scheduler.dispatchOf('con.m1.impl.2');
    assert.deepEqual(await w.scheduler.run(s2, reopenImpl('keep quoted commas in their field')), []);
    await engine.reconcile();
    await w.ledger.append('test:impl-given-up', { events: [{ mission: M, line: 'task:impl', event: 'abandoned', key: 'abandoned', body: { escalation: 'x', reason: 'given up', attempt: 2 } }] });
    await engine.reconcile();
    assert.deepEqual((await events(w, 'repairs', REOPEN_NOT_CARRIED)).map((e) => [e.key, e.body.why]), [['R-2:impl', 'the task was given up']]);
    const n = w.ledger.notices.find((x) => x.category === 'reopen-not-carried')!;
    assert.match(n.trigger, /^repair R-2's reopen of task impl was not carried out: the task was given up/);
    assert.match(n.defaultAction, /repair R-2 does not read as done/);
    await settled(w, engine);
  });

  it('compatibility: a second reopen 4.3 left out, its task accepted again since, is told as not carried out, not revived', async () => {
    const { w, engine, s1 } = await bothClaimed();
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    await drive(engine, w.scheduler, script({ 'architect-repair': () => null }));
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.2');
    // 4.3 recorded R-2's decision on attempt 1 and skipped it in silence once impl had moved on
    await w.ledger.append('test:43-decided', { events: [{ mission: M, line: 'repairs', event: 'decided', key: 'R-2', body: { repair: 'R-2', dplan: 'dplan.m1.1.1', arch: 'arch-repair.m1.R-2.1', add: [], reopen: [{ task: 'impl', issue: 'keep quoted commas in their field', attempt: 1, product: 'prod.con.m1.impl.1' }] } }] });
    await engine.reconcile();
    assert.ok(!w.scheduler.tasks.has('con.m1.impl.3'), 'no attempt is opened on work accepted since');
    assert.deepEqual((await events(w, 'repairs', REOPEN_NOT_CARRIED)).map((e) => e.key), ['R-2:impl']);
    assert.match(w.ledger.notices.find((x) => x.category === 'reopen-not-carried')!.trigger, /accepted again at a later attempt before this reopen was carried out/);
    await settled(w, engine);
  });

  it('a seat task claimed since it was read fails the merge guard inside the write', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.iface.1') }));
    const guard = (key: string) => ({ events: [{ mission: M, line: 'test', event: 'x', key, body: {} }], guard: { absent: [], unclaimed: ['con.m1.iface.1'], code: 'LATE', message: 'claimed meanwhile' } });
    await w.ledger.append('test:queued', guard('1'));
    w.scheduler.dispatchOf('con.m1.iface.1');
    await assert.rejects(w.ledger.append('test:claimed', guard('2')), /claimed meanwhile/);
  });
});
