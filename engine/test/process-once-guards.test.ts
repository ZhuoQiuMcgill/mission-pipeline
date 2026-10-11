// Once-only guards that a later re-entry reaches (the audit of the reopened-exploration fix): fail
// loudly, or carry out correctly; never silently lose or ignore. Real process, real git.
//   P3  the user's answer to an escalation already carried out → refused, nothing written (an accepting
//       answer would otherwise write a ruling that revokes a negation with no flow effect); an answer
//       to an escalation waiting for the user still works
//   P1  a requirement item withdrawn, then added again under the same id → refused, no new version; under
//       a new id it is in force
//   P2  a task given up, then a new PM plan keeps its id with a changed card → it runs (the giving-up
//       belongs to the earlier card); the same card under a newer plan stays given up, with a notice;
//       a dropped task re-added by a later plan → the escalation it left open is not applied to it

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { sweepThenClean } from './exploration-exits.ts';
import { resolveSubtasks } from '../src/cli/layers.ts';
import type { MissionId } from '../src/common/ids.ts';
import { decisionLabels } from '../src/evaluator/index.ts';
import { flowCtx } from '../src/flow/context.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import { currentItems } from '../src/flow/requirements.ts';
import { cal1Pass, cal2Escalate, cal2Pass } from '../src/flow/scripted.ts';
import { closedEscalation, decisionFor, isApplied, openEscalations } from '../src/flow/secretary.ts';
import { pmAnswer, pmDispatch, pmNext, pmPlan, pmRequirement, pmSay, pmWithdrawRequirement } from '../src/process/index.ts';
import { cli } from './cli-fixtures.ts';
import { addDetailedPlan, addPlan, CHECK_JS, handBack, processProject, readAll, readyOf, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const SEC = (option: string, o: { grantExtra?: number; instructions?: string } = {}) => () => ({ option, classification: option === 'ask-user' ? 'needs-user' : 'detail', authorization: null, reason: `the Secretary decides: ${option}`, instructions: o.instructions ?? '', grantExtra: o.grantExtra ?? 0, notice: option === 'ask-user' ? 'ask the user' : '', mayMatter: false });

async function toConstructor(p: ProcessProject, m: string): Promise<string> {
  const w = await startAddMission(p.ctx, m);
  await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
  await step(p.ctx, 'architect-decompose', () => addDetailedPlan(m));
  await step(p.ctx, 'calibrator-2', (c) => cal2Pass(c));
  return w;
}
async function build(p: ProcessProject, n: number): Promise<void> {
  const s = await readyOf(p.ctx, 'constructor');
  const d = pmDispatch(p.ctx, s.step);
  const wt = join(p.dir, d.worktree!);
  write(wt, 'src/add.js', `exports.add = (a, b) => a + b; // v${n}\n`);
  write(wt, 'src/check.js', CHECK_JS);
  const a = await handBack(p.ctx, d.dispatch, { done: `v${n}`, unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
  assert.equal(a.kind, 'recorded', JSON.stringify(a));
}
async function rework(p: ProcessProject, why: string): Promise<void> {
  await step(p.ctx, 'reviewer', (c) => {
    const pass = reviewerPass(c) as { judgments: Array<Record<string, unknown>> };
    return { ...pass, judgments: pass.judgments.map((j) => ({ ...j, met: 'no', reason: why })), findings: [why], verdict: 'rework' };
  });
}
/** Three reworks with a cap of two: the loop is used up and its escalation waits for the Secretary. */
async function reworksUsedUp(p: ProcessProject, m: string): Promise<string> {
  const w = await toConstructor(p, m);
  for (let n = 1; n <= 3; n++) {
    await build(p, n);
    await rework(p, `missing case ${n}`);
  }
  return w;
}
/** PM plan round `round` of the add mission, through Calibrator ①, the Architect (its one task as given) and Calibrator ②. */
async function replan(p: ProcessProject, m: string, w1: string, round: number, said: string, task: Record<string, unknown>): Promise<void> {
  const w = pmSay(p.ctx, `${said} (${m})`).words;
  await pmPlan(p.ctx, { mission: m, plan: { ...(addPlan(m, w1) as Record<string, unknown>), round }, words: [w1, w] });
  await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
  const dp = addDetailedPlan(m) as { tasks: Array<Record<string, unknown>> };
  dp.tasks[0] = { ...dp.tasks[0], ...task };
  await step(p.ctx, 'architect-decompose', () => dp);
  await step(p.ctx, 'calibrator-2', (c) => cal2Pass(c));
}

const head = (p: ProcessProject): number => Number(p.ctx.memory.head());
const notices = (p: ProcessProject): string[] => p.ctx.memory.read((db) => (db.stmt("SELECT json_extract(record, '$.category') AS c FROM log WHERE kind = 'alert' ORDER BY rev").all() as Array<{ c: string }>).map((r) => r.c));
const judgmentExists = (p: ProcessProject, id: string): boolean => p.ctx.memory.read((db) => db.stmt("SELECT 1 FROM log WHERE kind = 'judgment' AND json_extract(record, '$.judgment') = ?").get(id) !== undefined);
const lineEvents = (p: ProcessProject, m: string, line: string, event: string): string[] => p.ctx.memory.read((db) => (db.stmt('SELECT key FROM flow_events WHERE mission = ? AND line = ? AND event = ? ORDER BY revision').all(m, line, event) as Array<{ key: string }>).map((r) => r.key));
const taskLabel = async (p: ProcessProject, id: string): Promise<string> => (await resolveSubtasks(p.ctx)).entries.find((e) => e.kind === 'task' && e.id === id)!.label;

async function refusal(f: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await f();
  } catch (e) {
    return { code: String((e as { code?: unknown }).code), message: (e as Error).message };
  }
  assert.fail('expected a refusal');
}

describe('once-only guards reached by a later re-entry: refused loudly, or carried out', () => {
  const ps: ProcessProject[] = [];
  const fresh = (o: Parameters<typeof processProject>[0] = {}): ProcessProject => {
    const p = processProject(o);
    ps.push(p);
    return p;
  };
  after(() => sweepThenClean(ps));

  it('P3: an answer to an escalation the Secretary decided and the flow carried out is refused; nothing is written; the CLI says WI-24', async () => {
    const p = fresh();
    await reworksUsedUp(p, 'm1');
    await step(p.ctx, 'secretary', SEC('grant', { grantExtra: 1 }));
    const ctx = flowCtx(p.ctx.ports(), 'm1' as MissionId);
    const esc = 'exh.task.m1.impl.3';
    assert.equal(await isApplied(ctx, esc), true);
    const w = pmSay(p.ctx, 'No, give it up. (m1)').words;
    const before = head(p);
    const r = await refusal(() => pmAnswer(p.ctx, { mission: 'm1', escalation: esc, option: 'abandon', words: w }));
    assert.equal(r.code, 'already-applied');
    assert.match(r.message, /already decided by the Secretary \(option grant\) and carried out/);
    assert.match(r.message, /nothing was recorded/);
    assert.equal(head(p), before, 'nothing is written');
    assert.equal((await decisionFor(ctx, esc))?.option, 'grant', 'the decision in effect is still the one carried out');
    assert.deepEqual(lineEvents(p, 'm1', 'secretary', 'user-answer'), []);
    // the CLI maps it like the other refusals: exit 3, WI-24
    const c = await cli(p.dir, ['pm', 'answer', 'm1', esc, '--option', 'abandon', '--words', w, '--json']);
    assert.equal(c.code, 3, c.out + c.err);
    assert.equal(c.json.error.code, 'already-applied');
    assert.equal(c.json.error.wi, 'WI-24');
    // the CLI keeps its own record of the PM's command (its refused receipt); nothing about the escalation is written
    const wrote = p.ctx.memory.read((db) => (db.stmt('SELECT DISTINCT kind FROM log WHERE rev > ?').all(before) as Array<{ kind: string }>).map((x) => x.kind).sort());
    assert.deepEqual(wrote, ['op.receipt', 'pm.action']);
    assert.deepEqual(lineEvents(p, 'm1', 'secretary', 'user-answer'), []);
    // the grant goes on as carried out
    await readyOf(p.ctx, 'constructor');
  });

  it('P3: an accepting answer after a send-back was carried out is refused before its ruling is written: the negation and the labels stand', async () => {
    const p = fresh();
    await startAddMission(p.ctx, 'm2');
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(p.ctx, 'architect-decompose', () => addDetailedPlan('m2'));
    await step(p.ctx, 'calibrator-2', (c) => cal2Escalate(c, 'the user should decide the error handling'));
    await step(p.ctx, 'secretary', SEC('send-back', { instructions: 'state the error handling explicitly' }));
    const dplan = 'dplan.m2.1.1';
    const esc = `cal2.${dplan}`;
    const ctx = flowCtx(p.ctx.ports(), 'm2' as MissionId);
    assert.equal(await isApplied(ctx, esc), true);
    const label = p.ctx.memory.read((db) => decisionLabels(db, [dplan]))[dplan];
    const w = pmSay(p.ctx, 'Accept the plan as it is. (m2)').words;
    const before = head(p);
    const r = await refusal(() => pmAnswer(p.ctx, { mission: 'm2', escalation: esc, option: 'accept', words: w }));
    assert.equal(r.code, 'already-applied');
    assert.match(r.message, /option send-back/);
    assert.equal(head(p), before);
    assert.equal(judgmentExists(p, `j.user.${esc}`), false, 'no ruling revokes the negation');
    assert.equal(p.ctx.memory.read((db) => decisionLabels(db, [dplan]))[dplan], label);
  });

  it('P3: an answer to an escalation waiting for the user is recorded and carried out', async () => {
    const p = fresh();
    await reworksUsedUp(p, 'm3');
    await step(p.ctx, 'secretary', SEC('ask-user'));
    const esc = (await pmNext(p.ctx)).waitingOnUser[0]!.escalation;
    await pmAnswer(p.ctx, { mission: 'm3', escalation: esc, option: 'grant', grantExtra: 1, words: pmSay(p.ctx, 'Give it one more try. (m3)').words });
    const ctx = flowCtx(p.ctx.ports(), 'm3' as MissionId);
    assert.equal(await isApplied(ctx, esc), true);
    assert.equal((await decisionFor(ctx, esc))?.by, 'user');
    await readyOf(p.ctx, 'constructor');
  });

  it('P1: a withdrawn item added again under the same id is refused with no new version; under a new id it is in force', async () => {
    const p = fresh();
    await startAddMission(p.ctx, 'm4');
    await pmWithdrawRequirement(p.ctx, { mission: 'm4', item: 'g1', reason: 'not needed' });
    const w = pmSay(p.ctx, 'Actually, keep the add function goal. (m4)').words;
    const before = head(p);
    const r = await refusal(() => pmRequirement(p.ctx, { mission: 'm4', item: 'g1', type: 'goal', text: 'An add function, again', quote: 'keep the add function goal', words: w }));
    assert.equal(r.code, 'withdrawn-item');
    assert.match(r.message, /was withdrawn \(not needed\) and stays withdrawn, so nothing was recorded\. Add it under a new id, quoting the user's words/);
    assert.equal(head(p), before, 'no new version');
    assert.deepEqual(lineEvents(p, 'm4', 'requirements', 'item').filter((k) => k.startsWith('item.m4.g1.')), ['item.m4.g1.v1']);
    const c = await cli(p.dir, ['pm', 'requirement', 'add', 'm4', 'g1', '--type', 'goal', '--text', 'An add function, again', '--quote', 'keep the add function goal', '--words', w, '--json']);
    assert.equal(c.code, 3, c.out + c.err);
    assert.equal(c.json.error.code, 'withdrawn-item');
    assert.match(c.json.error.message, /new id/);
    // under a new id: in force
    await pmRequirement(p.ctx, { mission: 'm4', item: 'g2', type: 'goal', text: 'An add function, again', quote: 'keep the add function goal', words: w });
    const items = await currentItems(flowCtx(p.ctx.ports(), 'm4' as MissionId));
    assert.ok(items.some((i) => i.line === 'item.m4.g2') && !items.some((i) => i.line === 'item.m4.g1'), JSON.stringify(items.map((i) => i.line)));
  });

  it('P2: a task given up, then a new PM plan keeps its id with a changed card: it runs, builds and is accepted; the giving-up does not cancel it', async () => {
    const p = fresh();
    const w1 = await reworksUsedUp(p, 'm5');
    await step(p.ctx, 'secretary', SEC('abandon'));
    assert.equal(await acceptedProduct(flowCtx(p.ctx.ports(), 'm5' as MissionId), 'impl'), null);
    assert.match(await taskLabel(p, 'impl'), /^abandoned/);
    // the user wants it after all: round 2, the Architect keeps id impl with a new goal
    await replan(p, 'm5', w1, 2, 'Please do the add task after all, more carefully.', { goal: 'Implement add, second try' });
    await build(p, 4);
    await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
    for (let i = 0; i < 2; i++) await pmNext(p.ctx);
    const product = await acceptedProduct(flowCtx(p.ctx.ports(), 'm5' as MissionId), 'impl');
    assert.ok(product !== null, 'accepted under the new card');
    assert.match(await taskLabel(p, 'impl'), /^accepted/);
    assert.deepEqual(lineEvents(p, 'm5', 'task:impl', 'abandoned'), ['abandoned'], 'the giving-up under the first card is history, not repeated');
    assert.deepEqual((await resolveSubtasks(p.ctx)).blocked, []);
  });

  it('P2: a newer plan that keeps the card a task was given up under: it stays given up, and the PM is told', async () => {
    const p = fresh();
    const w1 = await reworksUsedUp(p, 'm6');
    await step(p.ctx, 'secretary', SEC('abandon'));
    await replan(p, 'm6', w1, 2, 'Keep the plan as it is.', {});
    for (let i = 0; i < 2; i++) await pmNext(p.ctx);
    assert.ok(!(await pmNext(p.ctx)).ready.some((r) => r.kind === 'constructor'));
    assert.equal(await acceptedProduct(flowCtx(p.ctx.ports(), 'm6' as MissionId), 'impl'), null);
    assert.ok(notices(p).includes('plan-task-still-abandoned'), JSON.stringify(notices(p)));
  });

  it('P2: a dropped task re-added by a later plan: the drop closes its escalation; the Secretary in flight hands back abandon, not accepted; the re-added task runs', async () => {
    const p = fresh();
    const w1 = await reworksUsedUp(p, 'm7');
    const esc = 'exh.task.m7.impl.3';
    // the Secretary is dispatched, then round 2 replaces impl with impl2 while it decides
    const sec = pmDispatch(p.ctx, (await readyOf(p.ctx, 'secretary')).step);
    await replan(p, 'm7', w1, 2, 'Drop that add task and do it fresh as a new task.', { id: 'impl2', goal: 'Implement add afresh' });
    const ctx = flowCtx(p.ctx.ports(), 'm7' as MissionId);
    assert.equal(await closedEscalation(ctx, esc), `task impl was dropped by the plan in effect (dplan.m7.2.1)`, 'closed with the drop');
    // the in-flight Secretary gives impl up: recorded as history, not accepted, nothing carried out
    readAll(p.ctx, sec.dispatch);
    const a = await handBack(p.ctx, sec.dispatch, SEC('abandon')());
    assert.ok(a.kind === 'recorded' && a.outcome !== 'accepted', JSON.stringify(a));
    assert.equal(await decisionFor(ctx, esc), null, 'no decision recorded');
    // round 3 brings impl back
    await replan(p, 'm7', w1, 3, 'Go back to the first add task.', {});
    for (let i = 0; i < 2; i++) await pmNext(p.ctx);
    assert.deepEqual((await openEscalations(ctx, 'task:impl')).map((e) => e.id), []);
    assert.deepEqual(lineEvents(p, 'm7', 'task:impl', 'abandoned'), [], 'nothing decided on the dropped task is carried out on the re-added one');
    // and it runs: the next attempt builds and is accepted
    await build(p, 4);
    await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
    for (let i = 0; i < 2; i++) await pmNext(p.ctx);
    assert.ok((await acceptedProduct(ctx, 'impl')) !== null);
    // an answer to the closed escalation is refused, naming why
    const r = await refusal(() => pmAnswer(p.ctx, { mission: 'm7', escalation: esc, option: 'grant', grantExtra: 1, words: pmSay(p.ctx, 'Grant it. (m7)').words }));
    assert.equal(r.code, 'already-applied');
    assert.match(r.message, /closed without being carried out: task impl was dropped/);
  });
});
