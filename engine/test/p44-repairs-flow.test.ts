// 4.4 (F12 a and b, the flow parts of F13; problem P13; issues 59, 60, 61): repairs in the flow. A repair's reopen
// is new work on the user's words: it is not counted on the task's loop, its work gets a fresh loop, and acceptance
// with risk is offered at its end. A reopen may come after other work of the same repair, and the work of a repair
// waits while a dependency it reopens has still to be reached. A repair is filed again with --again; a decision
// whose card changed since its Architect saw it goes back once. A reopen never joins an open attempt: it waits for
// that attempt to be accepted and opens the next one, or it is told as not carried out. (The cap itself, F12 c:
// p44-rework-cap.test.ts.)
//
// A repair's reopen request (repair R, task T) is in one of three states (flow/execution.ts):
//   requested(a)  R's decision, or its latest `reopen-pinned` (a): it waits for T's attempt a to be accepted
//   carried(c)    its latest `reopen-carried` (c): T's attempt c was opened with R's issue on its card; final once a
//                 seat took c (Constructor or Reviewer claimed, or reviewed), read as requested(c) until then
//   not carried   `reopen-not-carried`: final; the PM's inbox is told from the record
// Every move is one write of the request's next record, key `<R>:<T>#<n>`, guarded inside that write: no record #n
// of any kind exists yet, the plan in effect is the revision the pass read, and
//   requested(a) → carried(k+1)  T accepted at its attempt k ≥ a; T's rework k+1 in the same write; no rework k+1 yet
//   requested(a) → requested(k)  T's attempt k > a is open (queued, claimed or in review); no rework k+1 yet
//   → not carried                T given up, or not in the plan in effect; T's card (latest spec) is the one read
// A reopen of a 4.3 decision (no `tracked`), and one 4.3 counted, holds no other work of its repair.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { beginAction, endAction } from '../src/cli/project.ts';
import { idPart, type MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { acceptedProduct, executionStep, REOPEN_CARRIED, REOPEN_NOT_CARRIED, REOPEN_PINNED, reworkLineage, taskLineage } from '../src/flow/execution.ts';
import type { DetailedPlanDoc, DetailedTask } from '../src/flow/plandoc.ts';
import { noticeAudience, PM_NOTICE_ACTIONS } from '../src/process/noticeAudience.ts';
import { planInEffect, submitPmBatch } from '../src/flow/planning.ts';
import { answerEscalation, type EscalationBody } from '../src/flow/secretary.ts';
import { constructorDone, detailedPlan, drive, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { pmDispatch, pmNext, pmRepair, pmSay } from '../src/process/pm.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { ConstructorCard, ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import { cli } from './cli-fixtures.ts';
import { recordRepair, repairStep } from '../src/flow/repair.ts';
import { recordItem } from '../src/flow/requirements.ts';
import { attack, hand, M as XM, submit, world as xworld } from './flow-exploration-fixtures.ts';
import { memoryPorts, say, withReworkCap } from './flow-memory-fixtures.ts';
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
type Append = World['ledger']['append'];
/** Run `between` once, just before the append of `op` (another process writing in between this pass's read and its write). */
function before(w: World, op: string, between: () => Promise<void>): () => void {
  const append: Append = w.ledger.append.bind(w.ledger);
  const ledger = w.ledger as { append: Append };
  ledger.append = async (o, entries) => {
    if (o === op) {
      ledger.append = append;
      await between();
    }
    return append(o, entries);
  };
  return () => { ledger.append = append; };
}
/**
 * 4.3 decides `repairId`: its decision has no `tracked`, and its reopen of impl is counted on impl's rework loop with
 * `verdict`, kept in the same write (what a 4.3 memory holds; 4.4 neither marks a decision so nor counts a reopen).
 */
function decidedBy43(w: World, repairId: string, verdict: { readonly proceed: boolean; readonly attempts: number; readonly allowed: number; readonly reason: string | null }): () => void {
  const append: Append = w.ledger.append.bind(w.ledger);
  const ledger = w.ledger as { append: Append };
  ledger.append = async (op, entries) => {
    if (op !== `flow:repair-decided:${M}:${repairId}`) return append(op, entries);
    const events = (entries.events ?? []).map((e) => {
      if (e.event !== 'decided') return e;
      const body = { ...(e.body as Record<string, unknown>) };
      delete body['tracked'];
      return { ...e, body };
    });
    return append(op, { ...entries, events: [...events, { mission: M, line: 'task:impl', event: 'loop-verdict', key: `reopen:repair:${repairId}`, body: verdict }] });
  };
  return () => { ledger.append = append; };
}
const failuresOf = (w: World, repairId: string): readonly string[] =>
  (w.scheduler.queued('architect-repair').find((t) => (t.card as unknown as ArchitectRepairCard).repair.id === repairId)?.card as unknown as ArchitectRepairCard | undefined)?.revision?.mechanicalFailures ?? [];
const CIRCLE = (task: string): string => `reopen[${task}].after: it waits for work that waits for it (a circle through after and dependsOn)`;
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

  it('a later re-plan that keeps the card re-binds the reopened product against the work it came after too (stable mode)', async () => {
    const w = memoryPorts();
    say(w, SEED_TEXT);
    await seedMission(w, M);
    await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'] });
    const engine = new FlowEngine(w);
    await drive(engine, w.scheduler, script());
    await repair(w, 'quoted headers are split');
    const hdr = task({ id: 'hdr' });
    await drive(engine, w.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [{ task: 'impl', issue: 'read headers through hdr', after: ['hdr'] }], add: [hdr], note: 'impl reads headers through hdr' } }) }));
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.2');
    // a later decision takes the plan's proof away; the next PM plan version maps it, and its detailed plan keeps every card, hdr's too
    const words = say(w, 'Once it has parsed a file, keep the parser read-only.');
    await recordItem(w, { mission: M, item: 'd1', type: 'decision', text: 'The parser is read-only once it has parsed a file', source: { kind: 'words', words, quote: 'keep the parser read-only' } });
    const next = pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'A CSV parser library, read-only once it has parsed a file', items: ['g1', 'd1'] }, pmPlan(M).elements[1]!] });
    await submitPmBatch(w, { mission: M, plan: next, userWords: [words], changedItems: ['d1'] });
    const plan = detailedPlan(M);
    await drive(engine, w.scheduler, happyScript(M, () => ({ ...plan, tasks: [...plan.tasks, hdr] })));
    assert.equal((await planInEffect(flowCtx(w, M)))?.eff.dplan, 'dplan.m1.2.1');
    assert.ok(!w.ledger.notices.some((n) => n.category === 'kept-product-not-rebound' && (n.detail as { task?: string }).task === 'impl'), JSON.stringify(w.ledger.notices.filter((n) => n.category === 'kept-product-not-rebound')));
    assert.deepEqual((await events(w, 'task:impl', 'rebind')).map((e) => [e.body.from, e.body.dplan]), [['prod.con.m1.impl.2', 'dplan.m1.2.1']], 'impl is re-bound to the new plan');
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.2.b1');
  });

  it("a task the repair adds waits while the dependency the same repair reopens waits for that task's open attempt, and starts on the reopen's work", async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    // R-1 reopens impl; its attempt 2 is held
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    // R-2 reopens impl too (it waits for attempt 2) and adds tail on impl
    assert.deepEqual(await w.scheduler.run(s2, { handBack: { reopen: [{ task: 'impl', issue: 'keep the last row' }], add: [task({ id: 'tail', dependsOn: ['impl'] })], note: 'impl and a check' } }), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    assert.deepEqual((await events(w, 'repairs', REOPEN_PINNED)).map((e) => [e.key, e.body.attempt]), [['R-2:impl#1', 2]]);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.3') }));
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), null, "impl's attempt 2 was accepted and R-2's attempt 3 opened");
    assert.ok(!w.scheduler.tasks.has('con.m1.tail.1'), 'tail does not start on the impl work R-2 replaces');
    await drive(engine, w.scheduler, script());
    const start = (await events(w, 'task:tail', 'dispatched')).find((e) => e.body.k === 1)!.body;
    assert.ok(start.prerequisites.includes('prod.con.m1.impl.3'), JSON.stringify(start.prerequisites));
    await settled(w, engine);
  });

  it("the hand-back names in after only work of this repair, never the task itself; a circle comes back from the flow's check as a mechanical failure", async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    await repair(w, 'quoted headers are split');
    await repair(w, 'the interface follows the parser');
    await engine.reconcile();
    const step = archStep(w, 'R-1');
    const problems = await w.scheduler.run(step, { handBack: { reopen: [{ task: 'impl', issue: 'x', after: ['iface', 'impl'] }], add: [], note: 'n' } });
    assert.deepEqual([...problems].sort(), ['reopen[impl].after: "iface" is not a task this repair adds, changes or reopens', 'reopen[impl].after: a task does not come after itself'].sort());
    // the hand-back draws no graph of its own: these circles are found once, on what the scheduler waits for
    assert.deepEqual(await w.scheduler.run(step, { handBack: { reopen: [{ task: 'impl', issue: 'x', after: ['hdr'] }], add: [task({ id: 'hdr', dependsOn: ['impl'] })], note: 'n' } }), []);
    // impl, reopened too, depends on iface by its card: iface coming after impl would wait for ever
    assert.deepEqual(await w.scheduler.run(archStep(w, 'R-2'), { handBack: { reopen: [{ task: 'iface', issue: 'x', after: ['impl'] }, { task: 'impl', issue: 'y' }], add: [], note: 'n' } }), []);
    await engine.reconcile();
    assert.deepEqual(await events(w, 'repairs', 'decided'), [], 'neither is applied');
    assert.ok(failuresOf(w, 'R-1').includes(CIRCLE('impl')), JSON.stringify(failuresOf(w, 'R-1')));
    assert.ok(failuresOf(w, 'R-2').includes(CIRCLE('iface')), JSON.stringify(failuresOf(w, 'R-2')));
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
    // checked again on the plan in effect now (p7-5): the id R-1 added since is a duplicate there
    assert.ok(back.revision?.mechanicalFailures.some((f) => f.includes('task id "rows" is used more than once')), JSON.stringify(back.revision));
  });
});

/** Everything accepted; two repairs filed, and both Architects given their cards on attempt 1 of every task. */
async function bothClaimed(o: { engine?: (w: World) => FlowEngine } = {}): Promise<{ w: World; engine: FlowEngine; s1: string; s2: string }> {
  const x = await world();
  const w = x.w;
  const engine = o.engine?.(w) ?? x.engine;
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

describe('4.4 F13: a reopen never joins an open attempt: it waits for it and opens the next one', () => {
  it('a second reopen of the same accepted attempt waits for the attempt the first one opened, then opens the next one with its own issue', async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    assert.deepEqual(await w.scheduler.run(s2, reopenImpl('keep quoted commas in their field')), []);
    await engine.reconcile();
    assert.deepEqual((await events(w, 'repairs', 'decided')).map((e) => e.body.reopen[0].attempt), [1, 1]);
    assert.deepEqual((await events(w, 'repairs', REOPEN_CARRIED)).map((e) => [e.key, e.body]), [['R-1:impl#1', { repair: 'R-1', task: 'impl', attempt: 2, from: 1 }]]);
    assert.deepEqual((await events(w, 'repairs', REOPEN_PINNED)).map((e) => [e.key, e.body]), [['R-2:impl#1', { repair: 'R-2', task: 'impl', attempt: 2, from: 1 }]]);
    // attempt 2, queued and then claimed, carries R-1's issue only: its claim lays no other repair's on it
    const d = w.scheduler.dispatchOf('con.m1.impl.2');
    const claimed = dispatchView(w.ctx, d).card as unknown as ConstructorCard;
    assert.ok(claimed.duties.includes('keep the header row') && !claimed.duties.includes('keep quoted commas'), claimed.duties);
    assert.deepEqual(claimed.repairs?.map((r) => r.id), ['R-1']);
    assert.deepEqual(await w.scheduler.run('con.m1.impl.2', { handBack: constructorDone() }), []);
    await drive(engine, w.scheduler, script());
    assert.doesNotMatch(w.scheduler.card<ReviewerCard>('rev.m1.impl.2').duties, /keep quoted commas/);
    const rw = (await events(w, 'task:impl', 'rework')).find((e) => e.key === '3')!.body;
    assert.deepEqual([rw.reason, rw.reopen, rw.issues, rw.loop], ['reopen', { kind: 'repair', repair: 'R-2' }, ['keep quoted commas in their field'], `${taskLineage(M, 'impl')}.reopen3`]);
    const con = w.scheduler.card<ConstructorCard>('con.m1.impl.3');
    assert.ok(con.duties.includes('keep quoted commas in their field') && !con.duties.includes('keep the header row'), con.duties);
    assert.deepEqual(con.repairs?.map((r) => r.id), ['R-2']);
    assert.deepEqual((await events(w, 'repairs', REOPEN_CARRIED)).map((e) => [e.key, e.body.attempt, e.body.from]), [['R-1:impl#1', 2, 1], ['R-2:impl#2', 3, 2]]);
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.3');
    assert.ok(!w.scheduler.tasks.has('con.m1.impl.4'), 'each repair reopened it once');
    await settled(w, engine);
  });

  it('an attempt already claimed: the reopen waits for it, and reopens the task once it is accepted, on a fresh loop', async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    w.scheduler.dispatchOf('con.m1.impl.2');
    assert.deepEqual(await w.scheduler.run(s2, reopenImpl('keep quoted commas in their field')), []);
    await engine.reconcile();
    assert.deepEqual((await events(w, 'repairs', REOPEN_PINNED)).map((e) => e.body), [{ repair: 'R-2', task: 'impl', attempt: 2, from: 1 }]);
    assert.deepEqual(await w.scheduler.run('con.m1.impl.2', { handBack: constructorDone() }), []);
    await drive(engine, w.scheduler, script());
    const rw = (await events(w, 'task:impl', 'rework')).find((e) => e.key === '3')!.body;
    assert.deepEqual([rw.reason, rw.reopen, rw.issues, rw.loop], ['reopen', { kind: 'repair', repair: 'R-2' }, ['keep quoted commas in their field'], `${taskLineage(M, 'impl')}.reopen3`]);
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.3');
    await settled(w, engine);
  });

  it("a reopen whose task was given up is recorded as not carried out, and the PM's inbox is told from the record", async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    w.scheduler.dispatchOf('con.m1.impl.2');
    assert.deepEqual(await w.scheduler.run(s2, reopenImpl('keep quoted commas in their field')), []);
    await engine.reconcile();
    await w.ledger.append('test:impl-given-up', { events: [{ mission: M, line: 'task:impl', event: 'abandoned', key: 'abandoned', body: { escalation: 'x', reason: 'given up', attempt: 2 } }] });
    assert.deepEqual((await engine.reconcile()).flatMap((r) => r.errors), []);
    // R-1's issue was carried out on the attempt a seat took (the giving-up of that attempt is the task's own record);
    // R-2's waited for that attempt: it will not be carried out
    assert.deepEqual((await events(w, 'repairs', REOPEN_NOT_CARRIED)).map((e) => [e.key, e.body.why]), [['R-2:impl#2', 'the task was given up']]);
    const told = w.ledger.notices.filter((x) => x.category === 'reopen-not-carried');
    assert.deepEqual(told.map((x) => x.key), ['R-2:impl#2'], 'once, from the record');
    assert.match(told[0]!.trigger, /^repair R-2's reopen of task impl was not carried out: the task was given up/);
    assert.match(told[0]!.defaultAction ?? '', /repair R-2 does not read as done/);
    assert.equal(noticeAudience('reopen-not-carried'), 'pm', "the PM's inbox, not the Secretary's");
    assert.match(PM_NOTICE_ACTIONS['reopen-not-carried']!.action, /tell the user/);
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
    assert.deepEqual((await events(w, 'repairs', REOPEN_NOT_CARRIED)).map((e) => e.key), ['R-2:impl#1']);
    assert.match(w.ledger.notices.find((x) => x.category === 'reopen-not-carried')!.trigger, /accepted again at a later attempt before this reopen was carried out/);
    await settled(w, engine);
  });
});

const holdAll = (...ids: string[]): Script => (t, s) => (ids.includes(t.task) ? null : happyScript(M)(t, s));

describe('4.4 F12, F13: a reopen is never lost or held for ever, whatever writes in between (review round 1)', () => {
  it('p7-1: a reopen another process decides while this pass accepts the attempt it moved on to is carried out on that acceptance', async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    assert.deepEqual(await w.scheduler.run('con.m1.impl.2', { handBack: constructorDone() }), []);
    // R-2 is decided after this pass read the reopens, just before it accepts attempt 2 (its decision names attempt 1)
    const restore = before(w, 'flow:accepted:m1:task:impl:2', async () => {
      assert.deepEqual(await w.scheduler.run(s2, reopenImpl('keep quoted commas in their field')), []);
      await repairStep(flowCtx(w, M));
      assert.equal((await events(w, 'repairs', 'decided')).find((e) => e.key === 'R-2')?.body.reopen[0].attempt, 1);
    });
    await drive(engine, w.scheduler, script());
    restore();
    assert.deepEqual(await events(w, 'repairs', REOPEN_NOT_CARRIED), [], 'not taken for a reopen 4.3 left out');
    const rw = (await events(w, 'task:impl', 'rework')).find((e) => e.key === '3')!.body;
    assert.deepEqual([rw.reopen, rw.issues], [{ kind: 'repair', repair: 'R-2' }, ['keep quoted commas in their field']]);
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.3');
    await settled(w, engine);
  });

  it('p7-2: a reopen waits for an open attempt whose start holds the dependency work the same repair replaces, and opens the next one on the new work', async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    assert.ok((await events(w, 'task:impl', 'dispatched')).find((e) => e.body.k === 2)!.body.prerequisites.includes('prod.con.m1.iface.1'));
    // R-2 reopens iface and impl, which depends on it, before impl's attempt 2 is claimed
    assert.deepEqual(await w.scheduler.run(s2, { handBack: { reopen: [{ task: 'iface', issue: 'name the header type' }, { task: 'impl', issue: 'use the header type' }], add: [], note: 'both' } }), []);
    await engine.reconcile();
    assert.deepEqual((await events(w, 'repairs', REOPEN_PINNED)).map((e) => [e.body.task, e.body.attempt]), [['impl', 2]]);
    await drive(engine, w.scheduler, script());
    assert.deepEqual((await events(w, 'task:impl', 'rework')).find((e) => e.key === '3')!.body.reopen, { kind: 'repair', repair: 'R-2' });
    const start = (await events(w, 'task:impl', 'dispatched')).find((e) => e.body.k === 3)!.body;
    assert.ok(start.prerequisites.includes('prod.con.m1.iface.2'), `R-2's impl work starts on R-2's iface work: ${JSON.stringify(start.prerequisites)}`);
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.3');
    await settled(w, engine);
  });

  it("p7-2: with startOnHandback, a task of a repair does not start on a dependency's hand-back that the same repair still has to reopen", async () => {
    const project = { localCommands: [], fullSuite: [], startOnHandback: [M as string] };
    const { w, engine, s1, s2 } = await bothClaimed({ engine: (x) => new FlowEngine({ ...x, project }) });
    assert.deepEqual(await w.scheduler.run(s1, { handBack: { reopen: [{ task: 'iface', issue: 'name the header type' }], add: [], note: 'iface' } }), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.iface.2') }));
    w.scheduler.dispatchOf('con.m1.iface.2');
    // R-2 reopens iface as well (it waits for attempt 2, claimed) and adds a task on it
    assert.deepEqual(await w.scheduler.run(s2, { handBack: { reopen: [{ task: 'iface', issue: 'export the header type' }], add: [task({ id: 'hdr', dependsOn: ['iface'] })], note: 'hdr on iface' } }), []);
    assert.deepEqual(await w.scheduler.run('con.m1.iface.2', { handBack: constructorDone() }), []);
    await drive(engine, w.scheduler, script({ reviewer: hold('rev.m1.iface.2') }));
    assert.ok((await events(w, 'task:iface', 'verified')).some((e) => e.key === '2'), "iface's attempt 2 is a verified hand-back in review");
    assert.ok(!w.scheduler.tasks.has('con.m1.hdr.1'), 'hdr does not start on the iface work R-2 replaces');
    await drive(engine, w.scheduler, script());
    assert.ok((await events(w, 'task:hdr', 'dispatched')).find((e) => e.body.k === 1)!.body.prerequisites.includes('prod.con.m1.iface.3'));
    await settled(w, engine);
  });

  it('p7-2: a task of a repair never starts on dependency work the same repair replaces, even when that reopen is carried while its gate reads', async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    // R-1 reopens iface; its attempt 2 is held
    assert.deepEqual(await w.scheduler.run(s1, { handBack: { reopen: [{ task: 'iface', issue: 'name the header type' }], add: [], note: 'iface' } }), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.iface.2') }));
    // R-2 reopens iface too (it waits for attempt 2) and adds hdr on iface
    assert.deepEqual(await w.scheduler.run(s2, { handBack: { reopen: [{ task: 'iface', issue: 'export the header type' }], add: [task({ id: 'hdr', dependsOn: ['iface'] })], note: 'hdr on iface' } }), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.iface.2') }));
    assert.deepEqual((await events(w, 'repairs', REOPEN_PINNED)).map((e) => [e.body.repair, e.body.attempt]), [['R-2', 2]]);
    assert.ok(!w.scheduler.tasks.has('con.m1.hdr.1'));
    // the pass that accepts iface's attempt 2 reads hdr's gate; just as it reads iface's line there, another process
    // carries R-2's reopen (iface's attempt 3): what it read of iface is the accepted attempt 2
    const read = w.ledger.events.bind(w.ledger);
    const ledger = w.ledger as { events: typeof read };
    let armed = false;
    let ran = false;
    ledger.events = (async (q: Parameters<typeof read>[0]) => {
      const all = await read(q);
      if (!ran && q.line === 'task:hdr' && q.event === undefined && (await read({ mission: M, line: 'task:iface', event: 'accepted' })).some((e) => e.key === '2')) armed = true;
      if (!ran && armed && q.line === 'task:iface' && q.event === undefined) {
        ran = true;
        await new FlowEngine(w).reconcile();
      }
      return all;
    }) as typeof read;
    try {
      await drive(engine, w.scheduler, script());
    } finally {
      ledger.events = read;
    }
    assert.ok(ran, 'the other process carried the reopen in between');
    const start = (await events(w, 'task:hdr', 'dispatched')).find((e) => e.body.k === 1)!.body;
    assert.ok(start.prerequisites.includes('prod.con.m1.iface.3'), `hdr starts on R-2's iface work: ${JSON.stringify(start.prerequisites)}`);
    await settled(w, engine);
  });

  it('p7-3: an issue carried on an attempt that a new card supersedes before any seat took it waits for the new attempt and opens the next one', async () => {
    const { w, engine, s1 } = await bothClaimed();
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    // before attempt 2 is claimed, a third repair gives impl (not accepted now) a new card
    await repair(w, 'the parser is slow');
    await engine.reconcile();
    const impl = (await planInEffect(flowCtx(w, M)))!.plan.tasks.find((t) => t.id === 'impl')!;
    assert.deepEqual(await w.scheduler.run(archStep(w, 'R-3'), { handBack: { reopen: [], add: [], change: [{ ...impl, standards: [...impl.standards, { id: 'S3', text: 'It parses a large file in a second' }] }], note: 'impl is fast' } }), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.3') }));
    assert.equal(w.scheduler.tasks.get('con.m1.impl.2')?.dispatches.length, 0, 'attempt 2 was never claimed');
    assert.deepEqual((await events(w, 'repairs', REOPEN_PINNED)).map((e) => [e.key, e.body]), [['R-1:impl#2', { repair: 'R-1', task: 'impl', attempt: 3, from: 2 }]]);
    assert.ok(!w.scheduler.card<ConstructorCard>('con.m1.impl.3').duties.includes('keep the header row'), 'the new card is the new card');
    await drive(engine, w.scheduler, script());
    const rw = (await events(w, 'task:impl', 'rework')).find((e) => e.key === '4')!.body;
    assert.deepEqual([rw.reason, rw.reopen, rw.issues], ['reopen', { kind: 'repair', repair: 'R-1' }, ['keep the header row']]);
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.4');
    await settled(w, engine);
  });

  it("p7-4: a wait the hand-back adds is checked over the whole plan as the scheduler reads it: an unfinished task that waits on the reopened one counts", async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.1') }));
    await repair(w, 'quoted headers are split');
    await engine.reconcile();
    assert.deepEqual(await w.scheduler.run(archStep(w, 'R-1'), { handBack: { reopen: [{ task: 'iface', issue: 'x', after: ['hdr'] }], add: [task({ id: 'hdr', dependsOn: ['impl'] })], note: 'n' } }), []);
    await engine.reconcile();
    assert.deepEqual(await events(w, 'repairs', 'decided'), []);
    assert.ok(failuresOf(w, 'R-1').includes(CIRCLE('iface')), JSON.stringify(failuresOf(w, 'R-1')));
  });

  it("p7-4: the check reads an integration task's own dependencies as the gate does (the tasks repairs added)", async () => {
    const { w, engine } = await world();
    const withDocs = (): DetailedPlanDoc => {
      const p = detailedPlan(M);
      return { ...p, tasks: [...p.tasks, { ...p.tasks[1]!, id: 'docs', kind: 'integration' as const, module: null, writeScope: [], implements: [], calls: [], dependsOn: ['impl'], provenance: { planElements: ['e1', 'e2'] } }] };
    };
    const docsScript = (over: Record<string, Script> = {}): Script => (t, s) => (Object.hasOwn(over, t.card.seat) ? over[t.card.seat]! : happyScript(M, withDocs))(t, s);
    await drive(engine, w.scheduler, docsScript());
    await repair(w, 'the parser has no reader for streams');
    await drive(engine, w.scheduler, docsScript({ 'architect-repair': () => ({ handBack: { reopen: [], add: [task({ id: 'x' })], note: 'a stream reader' } }) }));
    for (const t of ['x', 'docs']) assert.ok(await acceptedProduct(flowCtx(w, M), t), t);
    // docs, an integration task, waits for x (a task a repair added): x coming after docs, docs reopened too, would wait for ever
    await repair(w, 'the stream reader is not documented');
    await engine.reconcile();
    assert.deepEqual(await w.scheduler.run(archStep(w, 'R-2'), { handBack: { reopen: [{ task: 'x', issue: 'document the stream reader', after: ['docs'] }, { task: 'docs', issue: 'document x' }], add: [], note: 'n' } }), []);
    await engine.reconcile();
    assert.ok(!(await events(w, 'repairs', 'decided')).some((e) => e.key === 'R-2'), 'R-2 is not applied');
    assert.ok(failuresOf(w, 'R-2').includes(CIRCLE('x')), JSON.stringify(failuresOf(w, 'R-2')));
  });

  it('p7-4: two reopen-only decisions checked on the same plan never both close a circle: the later write is refused and checked again', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    await repair(w, 'four readers are missing');
    await drive(engine, w.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [], add: [task({ id: 'a' }), task({ id: 'b', dependsOn: ['iface', 'c'] }), task({ id: 'c' }), task({ id: 'd', dependsOn: ['iface', 'a'] })], note: 'four readers' } }) }));
    for (const t of ['a', 'b', 'c', 'd']) assert.ok(await acceptedProduct(flowCtx(w, M), t), t);
    await repair(w, 'a reads through b');
    await repair(w, 'c reads through d');
    await engine.reconcile();
    const s2 = archStep(w, 'R-2');
    const s3 = archStep(w, 'R-3');
    w.scheduler.dispatchOf(s2);
    w.scheduler.dispatchOf(s3);
    assert.deepEqual(await w.scheduler.run(s3, { handBack: { reopen: [{ task: 'c', issue: 'read through d', after: ['d'] }, { task: 'd', issue: 'serve c' }], add: [], note: 'c after d' } }), []);
    // R-2 (a after b) is decided by another process between R-3's checks and its write; neither changes the plan in
    // effect, each alone is no circle, together they are one (a after b, b on c, c after d, d on a)
    const restore = before(w, 'flow:repair-decided:m1:R-3', async () => {
      assert.deepEqual(await w.scheduler.run(s2, { handBack: { reopen: [{ task: 'a', issue: 'read through b', after: ['b'] }, { task: 'b', issue: 'serve a' }], add: [], note: 'a after b' } }), []);
      await repairStep(flowCtx(w, M));
    });
    await engine.reconcile();
    restore();
    await engine.reconcile();
    assert.deepEqual((await events(w, 'repairs', 'decided')).map((e) => e.key), ['R-1', 'R-2']);
    assert.ok(failuresOf(w, 'R-3').includes(CIRCLE('c')), JSON.stringify(failuresOf(w, 'R-3')));
  });

  it('p7-4: a wait ends with the reopen that asked for it: a later repair may order the same tasks the other way', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    await repair(w, 'quoted headers are split');
    await drive(engine, w.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [{ task: 'impl', issue: 'read headers through hdr', after: ['hdr'] }], add: [task({ id: 'hdr' })], note: 'n' } }) }));
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.2');
    await repair(w, 'the header reader breaks on empty files');
    await drive(engine, w.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [{ task: 'hdr', issue: 'read empty files through the parser', after: ['impl'] }, { task: 'impl', issue: 'accept empty files' }], add: [], note: 'n' } }) }));
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.3');
    assert.equal(await acceptedProduct(flowCtx(w, M), 'hdr'), 'prod.con.m1.hdr.2');
    assert.ok((await events(w, 'task:hdr', 'dispatched')).find((e) => e.body.k === 2)!.body.prerequisites.includes('prod.con.m1.impl.3'));
    await settled(w, engine);
  });

  it("p7-4: a decision that would close a circle with another repair's open wait goes back to its Architect", async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    await repair(w, 'quoted headers are split');
    await drive(engine, w.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [{ task: 'impl', issue: 'read headers through hdr', after: ['hdr'] }], add: [task({ id: 'hdr' })], note: 'n' } }), constructor: hold('con.m1.hdr.1') }));
    // impl's reopened attempt waits for hdr; R-2 makes hdr (not accepted) depend on impl
    await repair(w, 'headers follow the parser');
    await engine.reconcile();
    const hdr = (await planInEffect(flowCtx(w, M)))!.plan.tasks.find((t) => t.id === 'hdr')!;
    assert.deepEqual(await w.scheduler.run(archStep(w, 'R-2'), { handBack: { reopen: [], add: [], change: [{ ...hdr, dependsOn: ['iface', 'impl'] }], note: 'hdr uses the parser' } }), []);
    await engine.reconcile();
    assert.ok(!(await events(w, 'repairs', 'decided')).some((e) => e.key === 'R-2'), 'R-2 is not applied');
    const back = w.scheduler.queued('architect-repair').find((t) => (t.card as unknown as ArchitectRepairCard).repair.id === 'R-2')!.card as unknown as ArchitectRepairCard;
    assert.ok(back.revision?.mechanicalFailures.some((f) => f.startsWith('task impl waits, for another repair\'s reopen, for work this decision makes wait for impl')), JSON.stringify(back.revision));
  });

  it('p7-5: a decision retried on a plan another repair amended since is checked again on that plan', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    await repair(w, 'two readers are missing');
    await drive(engine, w.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [], add: [task({ id: 'x' }), task({ id: 'y' })], note: 'two readers' } }), constructor: holdAll('con.m1.x.1', 'con.m1.y.1') }));
    await repair(w, 'x needs y');
    await repair(w, 'y needs x');
    await engine.reconcile();
    const s1 = archStep(w, 'R-2');
    const s2 = archStep(w, 'R-3');
    w.scheduler.dispatchOf(s1);
    w.scheduler.dispatchOf(s2);
    const card = (await planInEffect(flowCtx(w, M)))!.plan.tasks;
    const x = card.find((t) => t.id === 'x')!;
    const y = card.find((t) => t.id === 'y')!;
    assert.deepEqual(await w.scheduler.run(s2, { handBack: { reopen: [], add: [], change: [{ ...y, dependsOn: ['iface', 'x'] }], note: 'y on x' } }), []);
    // R-2 (x on y) is decided by another process between R-3's checks and its write
    const restore = before(w, 'flow:repair-decided:m1:R-3', async () => {
      assert.deepEqual(await w.scheduler.run(s1, { handBack: { reopen: [], add: [], change: [{ ...x, dependsOn: ['iface', 'y'] }], note: 'x on y' } }), []);
      await repairStep(flowCtx(w, M));
    });
    await engine.reconcile();
    restore();
    await engine.reconcile();
    assert.deepEqual((await events(w, 'repairs', 'decided')).map((e) => e.key), ['R-1', 'R-2']);
    const deps = Object.fromEntries((await planInEffect(flowCtx(w, M)))!.plan.tasks.map((t) => [t.id, t.dependsOn]));
    assert.deepEqual([deps['x'], deps['y']], [['iface', 'y'], ['iface']], 'no circle is applied');
    assert.ok(w.scheduler.queued('architect-repair').some((t) => (t.card as unknown as ArchitectRepairCard).repair.id === 'R-3' && ((t.card as unknown as ArchitectRepairCard).revision?.mechanicalFailures ?? []).some((f) => f.includes('cycle'))));
  });

  it('p7-6: a grant on a loop whose cap was lowered below its attempts still gives the attempts granted', async () => {
    const { w } = await world();
    const lineage = 'task.m1.capped';
    for (let i = 0; i < 4; i++) await w.ledger.loopAttempt({ op: `test:attempt:${i}`, lineage, loop: 'rework', signature: `s${i}` });
    const low = withReworkCap(w, 1);
    assert.equal((await low.ledger.loop(lineage, 'rework')).exhausted, true);
    await w.ledger.grantLoop({ op: 'test:grant', lineage, loop: 'rework', by: 'user', extra: 2 });
    let st = await low.ledger.loop(lineage, 'rework');
    assert.deepEqual([st.attempts, st.allowed, st.exhausted], [4, 6, false]);
    await w.ledger.loopAttempt({ op: 'test:attempt:4', lineage, loop: 'rework', signature: 's4' });
    st = await low.ledger.loop(lineage, 'rework');
    assert.deepEqual([st.attempts, st.exhausted], [5, false], 'the second granted attempt is still there');
    await w.ledger.loopAttempt({ op: 'test:attempt:5', lineage, loop: 'rework', signature: 's5' });
    assert.equal((await low.ledger.loop(lineage, 'rework')).exhausted, true);
    // two grants before another attempt starts: the second adds to the first, never lowers it (p7-6, round 2)
    const twice = 'task.m1.twice';
    for (let i = 0; i < 4; i++) await w.ledger.loopAttempt({ op: `test:twice:${i}`, lineage: twice, loop: 'rework', signature: `t${i}` });
    await w.ledger.grantLoop({ op: 'test:twice-grant-1', lineage: twice, loop: 'rework', by: 'user', extra: 2 });
    assert.equal((await low.ledger.loop(twice, 'rework')).allowed, 6);
    await w.ledger.grantLoop({ op: 'test:twice-grant-2', lineage: twice, loop: 'rework', by: 'user', extra: 1 });
    st = await low.ledger.loop(twice, 'rework');
    assert.deepEqual([st.attempts, st.allowed, st.exhausted], [4, 7, false]);
    for (let i = 4; i < 7; i++) {
      assert.equal((await low.ledger.loop(twice, 'rework')).exhausted, false, `attempt ${i + 1} is granted`);
      await w.ledger.loopAttempt({ op: `test:twice:${i}`, lineage: twice, loop: 'rework', signature: `t${i}` });
    }
    assert.equal((await low.ledger.loop(twice, 'rework')).exhausted, true);
    // a grant at the cap under a fixed cap gives what it gave before
    const fixed = 'task.m1.fixed';
    for (let i = 0; i < 2; i++) await w.ledger.loopAttempt({ op: `test:fixed:${i}`, lineage: fixed, loop: 'rework', signature: `f${i}` });
    await w.ledger.grantLoop({ op: 'test:fixed-grant', lineage: fixed, loop: 'rework', by: 'user', extra: 1 });
    assert.equal((await w.ledger.loop(fixed, 'rework')).allowed, 3);
  });

  it('p7-7: a repair reopen whose 4.3 counted return was cut after its exhausted marker goes on as 4.3 ran it', async () => {
    const { w, engine } = await usedUpThenAccepted();
    await repair(w, 'the parser drops the last row');
    await w.ledger.append('test:43-marker', { events: [{ mission: M, line: 'task:impl', event: 'loop-return', key: 'reopen:repair:R-1', body: { decision: 'exhausted', lineage: taskLineage(M, 'impl'), loop: 'rework', signature: 'legacy-repair-reopen' } }] });
    await drive(engine, w.scheduler, script({ 'architect-repair': () => reopenImpl('keep the last row'), secretary: () => null }));
    assert.equal((await events(w, 'task:impl', 'loop-verdict')).find((e) => e.key === 'reopen:repair:R-1')?.body.proceed, false);
    assert.equal(((await loopEscalations(w)).at(-1)!.facts as { reopen?: { repair: string } }).reopen?.repair, 'R-1', 'its 4.3 escalation comes');
    assert.ok(!w.scheduler.tasks.has('con.m1.impl.4'), 'no fresh loop');
  });

  it('p7-8: --again retried with the same operation after its repair was filed (and decided since) returns that repair', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    const words = say(w, 'Trying it: the header row is lost.');
    const req = { mission: M, words, kind: 'defect' as const, text: 'the header row is lost', about: 'impl' };
    assert.equal((await pmRepair(w.ctx, req)).repair, 'R-1');
    await drive(engine, w.scheduler, script({ 'architect-repair': () => reopenImpl('keep the header row') }));
    // the first run of --again --op K files R-2, and its receipt is lost; R-2 is decided meanwhile
    assert.deepEqual(await pmRepair(w.ctx, { ...req, again: true, op: 'K' }), { repair: 'R-2', repeated: false, about: { kind: 'task', id: 'impl' }, over: 'R-1' });
    assert.equal((await events(w, 'repairs', 'repair')).find((e) => e.key === 'R-2')!.body.op, 'K', 'the operation is recorded with the filing');
    await drive(engine, w.scheduler, script({ 'architect-repair': () => reopenImpl('keep the header row, again') }));
    assert.ok((await events(w, 'repairs', 'decided')).some((e) => e.key === 'R-2'));
    assert.deepEqual(await pmRepair(w.ctx, { ...req, again: true, op: 'K' }), { repair: 'R-2', repeated: false, about: { kind: 'task', id: 'impl' }, over: 'R-1' });
    assert.equal((await events(w, 'repairs', 'repair')).length, 2, 'nothing filed twice');
    // another operation files it again
    assert.equal((await pmRepair(w.ctx, { ...req, again: true, op: 'L' })).repair, 'R-3');
  });

  it('p7-8: --again with an operation that returned the same repair still in work returns that repair on its retry, also once it was decided', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    const words = say(w, 'Trying it: the header row is lost.');
    const req = { mission: M, words, kind: 'defect' as const, text: 'the header row is lost', about: 'impl' };
    assert.equal((await pmRepair(w.ctx, req)).repair, 'R-1');
    // R-1 is in work: --again --op K returns it, and its receipt is lost; R-1 is decided meanwhile
    assert.deepEqual(await pmRepair(w.ctx, { ...req, again: true, op: 'K' }), { repair: 'R-1', repeated: true, about: { kind: 'task', id: 'impl' } });
    await drive(engine, w.scheduler, script({ 'architect-repair': () => reopenImpl('keep the header row') }));
    assert.ok((await events(w, 'repairs', 'decided')).some((e) => e.key === 'R-1'));
    assert.deepEqual(await pmRepair(w.ctx, { ...req, again: true, op: 'K' }), { repair: 'R-1', repeated: true, about: { kind: 'task', id: 'impl' } }, 'the retry returns what the operation returned');
    assert.equal((await events(w, 'repairs', 'repair')).length, 1, 'nothing new was filed');
    // another operation files it again
    assert.deepEqual(await pmRepair(w.ctx, { ...req, again: true, op: 'L' }), { repair: 'R-2', repeated: false, about: { kind: 'task', id: 'impl' }, over: 'R-1' });
  });
});

describe('4.4 F13: a reopen moves only from the state it was read in, on the plan it was read on (review round 2)', () => {
  it('p7-r2-1: a move written on a state another pass moved on from is refused inside the write: a late pin cannot undo a reopen told as not carried out', async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    assert.deepEqual(await w.scheduler.run(s2, reopenImpl('keep quoted commas in their field')), []);
    // this pass reads R-2 as requested and pins it to impl's open attempt 2; before its write, impl is given up and
    // another pass records R-2 as not carried out
    const restore = before(w, `flow:reopen:${M}:${idPart('R-2')}:impl:1:${REOPEN_PINNED}:2`, async () => {
      await w.ledger.append('test:impl-given-up', { events: [{ mission: M, line: 'task:impl', event: 'abandoned', key: 'abandoned', body: { escalation: 'x', reason: 'given up', attempt: 2 } }] });
      await new FlowEngine(w).reconcile();
    });
    assert.deepEqual((await engine.reconcile()).flatMap((r) => r.errors), []);
    restore();
    await engine.reconcile();
    const r2 = (await w.ledger.events({ mission: M, line: 'repairs' })).filter((e) => (e.body as { repair?: string }).repair === 'R-2' && [REOPEN_PINNED, REOPEN_CARRIED, REOPEN_NOT_CARRIED].includes(e.event));
    assert.deepEqual(r2.map((e) => [e.event, e.key]), [[REOPEN_NOT_CARRIED, 'R-2:impl#1']], 'the late pin is not written');
    assert.deepEqual(w.ledger.notices.filter((n) => n.category === 'reopen-not-carried' && (n.detail as { repair?: string }).repair === 'R-2').map((n) => n.key), ['R-2:impl#1']);
    await settled(w, engine);
  });

  it("p7-r2-2: a pass that read the plan before the task was added cannot record the task's reopen as not carried out: the write checks the plan in effect", async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    const stale = (await events(w, 'plan', 'effective')).at(-1)!.revision;
    await repair(w, 'the header row is lost');
    await drive(engine, w.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [], add: [task({ id: 'hdr' })], note: 'a header reader' } }) }));
    assert.ok(await acceptedProduct(flowCtx(w, M), 'hdr'));
    await repair(w, 'the header reader drops quotes');
    await engine.reconcile();
    assert.deepEqual(await w.scheduler.run(archStep(w, 'R-2'), { handBack: { reopen: [{ task: 'hdr', issue: 'keep quotes' }], add: [], note: 'hdr owns it' } }), []);
    await repairStep(flowCtx(w, M));
    // a pass of execution that read the plan in effect before hdr was added (it was paused since)
    const read = w.ledger.events.bind(w.ledger);
    const ledger = w.ledger as { events: typeof read };
    ledger.events = (async (q: Parameters<typeof read>[0]) => {
      const all = await read(q);
      return q.line === 'plan' && q.event === 'effective' ? all.filter((e) => e.revision <= stale) : all;
    }) as typeof read;
    try {
      await executionStep(flowCtx(w, M));
    } finally {
      ledger.events = read;
    }
    assert.deepEqual(await events(w, 'repairs', REOPEN_NOT_CARRIED), [], 'nothing is recorded on the older plan');
    await drive(engine, w.scheduler, script());
    const rw = (await events(w, 'task:hdr', 'rework')).find((e) => e.key === '2')!.body;
    assert.deepEqual([rw.reopen, rw.issues], [{ kind: 'repair', repair: 'R-2' }, ['keep quotes']]);
    assert.equal(await acceptedProduct(flowCtx(w, M), 'hdr'), 'prod.con.m1.hdr.2');
    assert.ok(!w.ledger.notices.some((n) => n.category === 'reopen-not-carried'));
    await settled(w, engine);
  });

  it("p7-r2-3: a reopen of a 4.3 decision holds no work of its repair: the task it added starts on the accepted work while the reopen waits at its used-up loop", async () => {
    const { w, engine } = await usedUpThenAccepted();
    await repair(w, 'the parser drops the last row');
    const restore = decidedBy43(w, 'R-1', { proceed: false, attempts: 2, allowed: 2, reason: 'cap' });
    await drive(engine, w.scheduler, script({
      'architect-repair': () => ({ handBack: { reopen: [{ task: 'impl', issue: 'keep the last row' }], add: [task({ id: 'tail', dependsOn: ['impl'] })], note: 'impl and a check' } }),
      secretary: () => null,
    }));
    restore();
    assert.equal((await events(w, 'repairs', 'decided'))[0]!.body.tracked, undefined, 'a decision as 4.3 wrote it');
    const esc = (await loopEscalations(w)).at(-1)!;
    assert.equal((esc.facts as { reopen?: { repair: string } }).reopen?.repair, 'R-1', "impl's reopen waits for the Secretary, as 4.3 ran it");
    assert.equal(await acceptedProduct(flowCtx(w, M), 'tail'), 'prod.con.m1.tail.1', 'tail does not wait for it');
    assert.ok((await events(w, 'task:tail', 'dispatched')).find((e) => e.body.k === 1)!.body.prerequisites.includes('prod.con.m1.impl.3'));
    const words = say(w, 'Give impl one more attempt.');
    await answerEscalation(w, { mission: M, escalation: esc.id, option: 'grant', grantExtra: 1, words: `Grant it. (${words})` });
    await drive(engine, w.scheduler, script());
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.4');
    assert.equal(await acceptedProduct(flowCtx(w, M), 'tail'), 'prod.con.m1.tail.1', 'its dependents keep their work (no cascade)');
    await settled(w, engine);
  });

  it('p7-r2-3: a counted 4.3 reopen whose attempt a new card superseded before its review leaves no wait behind: the task its repair added starts once the task is accepted', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    await repair(w, 'the parser drops the last row');
    // 4.3 decided R-1, and its counted return opened impl's attempt 2
    const restore = decidedBy43(w, 'R-1', { proceed: true, attempts: 1, allowed: 2, reason: null });
    await drive(engine, w.scheduler, script({
      'architect-repair': () => ({ handBack: { reopen: [{ task: 'impl', issue: 'keep the last row' }], add: [task({ id: 'tail', dependsOn: ['impl'] })], note: 'impl and a check' } }),
      constructor: hold('con.m1.impl.2'),
    }));
    restore();
    const rw2 = (await events(w, 'task:impl', 'rework')).find((e) => e.key === '2')!.body;
    assert.deepEqual([rw2.reopen, rw2.loop], [{ kind: 'repair', repair: 'R-1' }, undefined], "4.3's counted return, on the task's own loop");
    // before attempt 2 is reviewed, another repair changes impl's card (impl has no accepted product now)
    await repair(w, 'the parser is slow');
    await engine.reconcile();
    const impl = (await planInEffect(flowCtx(w, M)))!.plan.tasks.find((t) => t.id === 'impl')!;
    assert.deepEqual(await w.scheduler.run(archStep(w, 'R-2'), { handBack: { reopen: [], add: [], change: [{ ...impl, standards: [...impl.standards, { id: 'S3', text: 'It parses a large file in a second' }] }], note: 'impl is fast' } }), []);
    await drive(engine, w.scheduler, script());
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.3');
    assert.equal(await acceptedProduct(flowCtx(w, M), 'tail'), 'prod.con.m1.tail.1', 'tail does not wait for ever');
    assert.ok((await events(w, 'task:tail', 'dispatched')).find((e) => e.body.k === 1)!.body.prerequisites.includes('prod.con.m1.impl.3'));
    await settled(w, engine);
  });
});

describe('4.4 F12, F13: a task given up is given up only under its card (review round 3)', () => {
  it("p7-r3-1: a decision that reads its task as given up while another repair's new card for it waits to be laid records nothing; once the card revives the task, the reopen is decided and carried out", async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    // R-2 reopens impl, and that attempt is given up
    assert.deepEqual(await w.scheduler.run(s2, reopenImpl('keep quoted commas in their field')), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    await w.ledger.append('test:impl-given-up', { events: [{ mission: M, line: 'task:impl', event: 'abandoned', key: 'abandoned', body: { escalation: 'x', reason: 'given up', attempt: 2 } }] });
    await engine.reconcile();
    // R-3 gives impl a new card: decided, not laid by execution yet
    await repair(w, 'the parser is slow');
    await engine.reconcile();
    const impl = (await planInEffect(flowCtx(w, M)))!.plan.tasks.find((t) => t.id === 'impl')!;
    assert.deepEqual(await w.scheduler.run(archStep(w, 'R-3'), { handBack: { reopen: [], add: [], change: [{ ...impl, standards: [...impl.standards, { id: 'S3', text: 'It parses a large file in a second' }] }], note: 'impl is fast' } }), []);
    await repairStep(flowCtx(w, M));
    assert.ok((await events(w, 'repairs', 'decided')).some((e) => e.key === 'R-3'));
    // R-1's Architect saw impl accepted; its decision reads impl given up under the card R-3 replaced
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    await repairStep(flowCtx(w, M));
    assert.ok(!(await events(w, 'repairs', 'decided')).some((e) => e.key === 'R-1'), 'nothing is decided on a giving-up the plan in effect revokes');
    await drive(engine, w.scheduler, script());
    assert.deepEqual((await events(w, 'repairs', REOPEN_NOT_CARRIED)).map((e) => e.key), ['R-2:impl#2'], 'R-1 is not recorded as not carried out');
    const rw = (await events(w, 'task:impl', 'rework')).find((e) => e.body.reopen?.repair === 'R-1')!.body;
    assert.deepEqual([rw.k, rw.issues], [4, ['keep the header row']], "R-1 waits for the attempt R-3's card opened, then opens the next one");
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.4');
    await settled(w, engine);
  });

  it('p7-r3-1: the decision write checks the card of each task it records as not carried out: a card laid in between makes it read again', async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    assert.deepEqual(await w.scheduler.run(s2, reopenImpl('keep quoted commas in their field')), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    await w.ledger.append('test:impl-given-up', { events: [{ mission: M, line: 'task:impl', event: 'abandoned', key: 'abandoned', body: { escalation: 'x', reason: 'given up', attempt: 2 } }] });
    await engine.reconcile();
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    // between R-1's read (impl given up) and its write, another card is laid on impl (a new spec revives it)
    const dplan = (await planInEffect(flowCtx(w, M)))!.eff.dplan;
    const restore = before(w, 'flow:repair-decided:m1:R-1', async () => {
      await w.ledger.append('test:impl-new-card', { events: [{ mission: M, line: 'task:impl', event: 'spec', key: `${dplan}#9`, body: { dplan, hash: 'another-card' } }] });
    });
    await assert.rejects(repairStep(flowCtx(w, M)), /the card of a task it reopens changed while repair R-1's decision was being recorded/);
    restore();
    assert.deepEqual((await events(w, 'repairs', REOPEN_NOT_CARRIED)).filter((e) => e.body.repair === 'R-1'), [], 'nothing is written on the card it read');
    assert.ok(!(await events(w, 'repairs', 'decided')).some((e) => e.key === 'R-1'));
  });

  it('p7-r3-2: a task given up whose card the hand-back changes is open in the circle check: a reopen after it, with its new card waiting on the reopened task, goes back to the Architect', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    await repair(w, 'two readers are missing');
    await drive(engine, w.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [], add: [task({ id: 'a' }), task({ id: 'b' })], note: 'two readers' } }) }));
    for (const t of ['a', 'b']) assert.ok(await acceptedProduct(flowCtx(w, M), t), t);
    await w.ledger.append('test:b-given-up', { events: [{ mission: M, line: 'task:b', event: 'abandoned', key: 'abandoned', body: { escalation: 'x', reason: 'given up', attempt: 1 } }] });
    await repair(w, 'a reads through b again');
    await engine.reconcile();
    const b = (await planInEffect(flowCtx(w, M)))!.plan.tasks.find((t) => t.id === 'b')!;
    // a comes after b, and b's new card (which revives it) depends on a: each would wait for the other
    assert.deepEqual(await w.scheduler.run(archStep(w, 'R-2'), { handBack: { reopen: [{ task: 'a', issue: 'read through the new b', after: ['b'] }], add: [], change: [{ ...b, dependsOn: ['iface', 'a'] }], note: 'b on a, a after b' } }), []);
    await engine.reconcile();
    assert.ok(!(await events(w, 'repairs', 'decided')).some((e) => e.key === 'R-2'), 'R-2 is not applied');
    assert.ok(failuresOf(w, 'R-2').includes(CIRCLE('a')), JSON.stringify(failuresOf(w, 'R-2')));
  });

  it("p7-r3-3: a task a repair added keeps waiting for that repair's reopen of its dependency after a new plan that keeps its card takes effect", async () => {
    const { w, engine, s1, s2 } = await bothClaimed();
    assert.deepEqual(await w.scheduler.run(s1, reopenImpl('keep the header row')), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    // R-2 reopens impl too (it waits for attempt 2) and adds hdr on impl
    const hdr = task({ id: 'hdr', dependsOn: ['impl'] });
    assert.deepEqual(await w.scheduler.run(s2, { handBack: { reopen: [{ task: 'impl', issue: 'keep the last row' }], add: [hdr], note: 'impl and a check' } }), []);
    await drive(engine, w.scheduler, script({ constructor: hold('con.m1.impl.2') }));
    // a new plan takes effect that keeps every card, hdr's too (it carries no amendment)
    const words = say(w, 'Once it has parsed a file, keep the parser read-only.');
    await recordItem(w, { mission: M, item: 'd1', type: 'decision', text: 'The parser is read-only once it has parsed a file', source: { kind: 'words', words, quote: 'keep the parser read-only' } });
    const next = pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'A CSV parser library, read-only once it has parsed a file', items: ['g1', 'd1'] }, pmPlan(M).elements[1]!] });
    await submitPmBatch(w, { mission: M, plan: next, userWords: [words], changedItems: ['d1'], mode: 'fast' });
    const plan = detailedPlan(M);
    const kept = (): DetailedPlanDoc => ({ ...plan, tasks: [...plan.tasks, hdr] });
    await drive(engine, w.scheduler, hold('con.m1.impl.2', happyScript(M, kept)));
    const eff = (await planInEffect(flowCtx(w, M)))!.eff;
    assert.deepEqual([eff.dplan, eff.amendments ?? []], ['dplan.m1.2.1', []]);
    // impl's attempt 2 is accepted: hdr waits for R-2's attempt, as before the new plan
    await drive(engine, w.scheduler, hold('con.m1.impl.3', happyScript(M, kept)));
    assert.equal((await events(w, 'task:impl', 'rework')).find((e) => e.key === '3')?.body.reopen?.repair, 'R-2');
    assert.ok(!w.scheduler.tasks.has('con.m1.hdr.1'), 'hdr does not start on the impl work R-2 replaces');
    await drive(engine, w.scheduler, happyScript(M, kept));
    assert.ok((await events(w, 'task:hdr', 'dispatched')).find((e) => e.body.k === 1)!.body.prerequisites.includes('prod.con.m1.impl.3'));
    await settled(w, engine);
  });
});
