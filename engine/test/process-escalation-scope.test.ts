// Code review round 9 (stab9), real process with git.
// Class A: nothing acts on an escalation the flow will never carry out. An escalation is closed
//   (applied, superseded) the moment its owner leaves scope (a dropped task, a new card, a left stop,
//   a settled exploration, an older PM batch, a reopened exploration's routing), its queued Secretary
//   step is cancelled, a Secretary in flight hands back into history (not accepted, no ruling), the
//   Secretary step skips it (no decision, no notice), and a card quotes only decisions carried out
//   under the task's current card. A no-conclusion routing escalation offers "replan".
// Class B: a temporary state is never written as a permanent record: while an exploration product's
//   label recomputes, the decision layer routes nothing, plans nothing, and no "unproven" notice goes out.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { resolveSubtasks } from '../src/cli/layers.ts';
import type { MissionId } from '../src/common/ids.ts';
import { decisionLabels, setLabelBatchLimit } from '../src/evaluator/index.ts';
import { flowCtx } from '../src/flow/context.ts';
import { explorationState } from '../src/flow/exploration/flow.ts';
import { cal1Pass, cal2Escalate, cal2Pass } from '../src/flow/scripted.ts';
import { closedEscalation, decisionFor, isApplied, openEscalations, type EscalationBody } from '../src/flow/secretary.ts';
import { pmAnswer, pmDispatch, pmDrain, pmMission, pmNext, pmPlan, pmRequirement, pmSay } from '../src/process/index.ts';
import { dispatchView } from '../src/process/seat.ts';
import { assertExits, drained, frontier, seedFanout, sweepThenClean } from './exploration-exits.ts';
import { addDetailedPlan, addPlan, CHECK_JS, handBack, processProject, readAll, readyOf, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const X = 'X1';
const SEC = (option: string, o: { instructions?: string; classification?: string; authorization?: string | null } = {}) => ({
  option,
  classification: o.classification ?? (option === 'ask-user' ? 'needs-user' : 'detail'),
  authorization: o.authorization ?? null,
  reason: `the Secretary decides: ${option}`,
  instructions: o.instructions ?? '',
  grantExtra: 0,
  notice: option === 'ask-user' || o.classification === 'important-within-authority' ? `decided ${option}` : '',
  mayMatter: false,
});
const judgmentExists = (p: ProcessProject, id: string): boolean => p.ctx.memory.read((db) => db.stmt("SELECT 1 FROM log WHERE kind = 'judgment' AND json_extract(record, '$.judgment') = ?").get(id) !== undefined);
const label = (p: ProcessProject, id: string): string => String(p.ctx.memory.read((db) => decisionLabels(db, [id]))[id]);
const notices = (p: ProcessProject): string[] => p.ctx.memory.read((db) => (db.stmt("SELECT json_extract(record, '$.category') AS c FROM log WHERE kind = 'alert' ORDER BY rev").all() as Array<{ c: string }>).map((r) => r.c));
const escalations = (p: ProcessProject, m: string): EscalationBody[] =>
  p.ctx.memory.read((db) => (db.stmt("SELECT body FROM flow_events WHERE mission = ? AND line = 'secretary' AND event = 'escalation' ORDER BY revision").all(m) as Array<{ body: string }>).map((r) => JSON.parse(p.ctx.memory.data.text(r.body)) as EscalationBody));
const planEvents = (p: ProcessProject, m: string, event: string): string[] => p.ctx.memory.read((db) => (db.stmt("SELECT key FROM flow_events WHERE mission = ? AND line = 'plan' AND event = ? ORDER BY revision").all(m, event) as Array<{ key: string }>).map((r) => r.key));

async function dispatchedHandBack(p: ProcessProject, dispatch: string, fields: unknown): Promise<string> {
  readAll(p.ctx, dispatch);
  const a = await handBack(p.ctx, dispatch, fields);
  assert.equal(a.kind, 'recorded', JSON.stringify(a));
  return a.kind === 'recorded' ? a.outcome : 'refused';
}

// ---------------------------------------------------------------- explorations (as stb9-probe)

async function startExploration(p: ProcessProject, m: string, o: { rounds: number; type: 'structure' | 'direction' }): Promise<{ w: string; plan: (round: number, rounds: number) => Record<string, unknown> }> {
  pmMission(p.ctx, m);
  const w = pmSay(p.ctx, `Find a cache design with no obvious logical hole. Then build it. The details are yours to decide. (${m})`).words;
  await pmRequirement(p.ctx, { mission: m, item: 'g1', type: 'goal', text: 'A cache', quote: 'Then build it', words: w });
  await pmRequirement(p.ctx, { mission: m, item: 'a1', type: 'authorization', text: "Details are the PM's", quote: 'The details are yours to decide', words: w });
  const plan = (round: number, rounds: number): Record<string, unknown> => ({
    format: 'mp4.pm-plan.v1',
    mission: m,
    round,
    order: 'free',
    elements: [
      {
        id: 'x',
        kind: 'exploration',
        text: 'Design the cache',
        provenance: { by: 'user', words: w, quote: 'Find a cache design' },
        exploration: { id: X, deliverable: 'a cache design', fuzzyGoal: { quote: 'no obvious logical hole', words: w }, attackScope: ['internal contradiction', 'gets stuck'], decision: { id: 'D1', type: o.type }, budget: { rounds, micros: null }, stop: '', research: false },
        after: [],
        items: [],
      },
      { id: 'e1', kind: 'deliverable', text: 'The cache, built', provenance: { by: 'user', words: w, quote: 'Then build it' }, after: [X], items: ['g1'] },
    ],
    goalsBeyond: [],
    authorizations: ['a1'],
  });
  await pmPlan(p.ctx, { mission: m, words: [w], plan: plan(1, o.rounds) });
  await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
  return { w, plan };
}
const submit = (artifact: string, dispositions: unknown[] = []) => ({ step: 'submit', message: 'a version', artifact, dispositions, directionQuestions: [], attempts: [] });
const finding = (severity: string, cls: string, title: string) => ({ severity, class: cls, title, basis: `the passage on ${title}`, consequence: 'it goes wrong', direction: 'fix it', evidence: [] });
const attack = (findings: unknown[], card: any, resolved: 'yes' | 'no' = 'yes') => ({
  findings,
  rechecks: card.priorFindings.filter((f: any) => f.status === 'awaiting-recheck').map((f: any) => ({ finding: f.id, resolved, reason: resolved === 'yes' ? 'fixed' : 'still there', evidence: [] })),
  settled: [],
  reply: 'assessment',
});
const reviseAll = (card: any) => card.openFindings.map((f: any) => ({ finding: f.id, action: 'revise', note: 'changed' }));
const judge = (card: any, verdict: string, severity: string, drift: 'on-track' | 'drifting' = 'on-track') => ({
  findings: card.findings.map((f: any) => ({ finding: f.id, verdict, severity, reason: `judged ${verdict}`, question: verdict === 'shifts-direction' ? 'Should the cache also be distributed?' : '' })),
  round: { verdict: drift, reason: drift === 'drifting' ? 'moved away from the question' : 'answers the question', question: drift === 'drifting' ? 'Is the question still a single-node cache?' : '' },
});

/** A budget stop after one round: an escalation to the Secretary. */
async function budgetStop(p: ProcessProject, m: string): Promise<void> {
  await step(p.ctx, 'researcher-author', () => submit('v1'));
  await step(p.ctx, 'crititor', (c) => attack([finding('serious', 'internal contradiction', 'hole 1')], c));
  await step(p.ctx, 'researcher-author', (c) => submit('v2', reviseAll(c)));
  await step(p.ctx, 'stabilizer', (c) => judge(c, 'in-scope', 'serious'));
  assert.equal((await explorationState(p.ctx.ports(), m as MissionId, X)).stopped?.reason, 'budget-exhausted');
}

// ---------------------------------------------------------------- the add mission

async function toCal2Escalation(p: ProcessProject, m: string): Promise<string> {
  const w = await startAddMission(p.ctx, m);
  await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
  await step(p.ctx, 'architect-decompose', () => addDetailedPlan(m));
  await step(p.ctx, 'calibrator-2', (c) => cal2Escalate(c, 'the user should decide the error handling'));
  return w;
}
async function replanAdd(p: ProcessProject, m: string, w1: string, round: number, said: string, task: Record<string, unknown>): Promise<void> {
  const w = pmSay(p.ctx, `${said} (${m})`).words;
  await pmPlan(p.ctx, { mission: m, plan: { ...(addPlan(m, w1) as Record<string, unknown>), round }, words: [w1, w] });
  await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
  const dp = addDetailedPlan(m) as { tasks: Array<Record<string, unknown>> };
  dp.tasks[0] = { ...dp.tasks[0], ...task };
  await step(p.ctx, 'architect-decompose', () => dp);
  await step(p.ctx, 'calibrator-2', (c) => cal2Pass(c));
}
async function build(p: ProcessProject, n: number, decisions: string[] = []): Promise<string> {
  const s = await readyOf(p.ctx, 'constructor');
  const d = pmDispatch(p.ctx, s.step);
  const quotes = (dispatchView(p.ctx, d.dispatch).card as unknown as { decisionQuotes: string[] }).decisionQuotes;
  write(join(p.dir, d.worktree!), 'src/add.js', `exports.add = (a, b) => a + b; // v${n}\n`);
  write(join(p.dir, d.worktree!), 'src/check.js', CHECK_JS);
  const a = await handBack(p.ctx, d.dispatch, { done: `v${n}`, unmet_standards: [], unfixed_problems: [], decisions_needed: decisions });
  assert.equal(a.kind, 'recorded', JSON.stringify(a));
  return JSON.stringify(quotes);
}

describe('class A: nothing acts on an escalation the flow will never carry out', () => {
  const ps: ProcessProject[] = [];
  const fresh = (): ProcessProject => {
    const p = processProject();
    ps.push(p);
    return p;
  };
  after(() => sweepThenClean(ps));

  it('F1a: the user\'s send-back is carried out while the Secretary is in flight; its accept hands back into history: no ruling, the plan still negated, no decision notice', async () => {
    const p = fresh();
    await toCal2Escalation(p, 'm1');
    const d = pmDispatch(p.ctx, (await readyOf(p.ctx, 'secretary')).step);
    const esc = 'cal2.dplan.m1.1.1';
    const before = label(p, 'dplan.m1.1.1');
    assert.equal(before, 'negated');
    await pmAnswer(p.ctx, { mission: 'm1', escalation: esc, option: 'send-back', instructions: 'state the error handling', words: pmSay(p.ctx, 'Send it back, state the error handling. (m1)').words });
    await pmNext(p.ctx);
    const ctx = flowCtx(p.ctx.ports(), 'm1' as MissionId);
    assert.equal(await isApplied(ctx, esc), true);
    const auth = (dispatchView(p.ctx, d.dispatch).card as unknown as { authorizations: Array<{ id: string }> }).authorizations[0]?.id ?? null;
    const n0 = notices(p).filter((n) => n.startsWith('secretary'));
    const outcome = await dispatchedHandBack(p, d.dispatch, SEC('accept', { classification: 'important-within-authority', authorization: auth }));
    await pmNext(p.ctx);
    assert.notEqual(outcome, 'accepted');
    assert.equal(judgmentExists(p, `j.sec.${esc}`), false, 'no ruling');
    assert.equal(label(p, 'dplan.m1.1.1'), 'negated');
    assert.deepEqual(notices(p).filter((n) => n.startsWith('secretary')), n0, 'no "decided" notice');
    assert.equal((await decisionFor(ctx, esc))?.option, 'send-back', 'the decision in force is the one carried out');
  });

  it('regression: an accept on an open escalation still writes its ruling and proves the target', async () => {
    const p = fresh();
    await toCal2Escalation(p, 'm2');
    const s = await readyOf(p.ctx, 'secretary');
    const d = pmDispatch(p.ctx, s.step);
    const auth = (dispatchView(p.ctx, d.dispatch).card as unknown as { authorizations: Array<{ id: string }> }).authorizations[0]?.id ?? null;
    assert.equal(await dispatchedHandBack(p, d.dispatch, SEC('accept', { classification: 'important-within-authority', authorization: auth })), 'accepted');
    await pmNext(p.ctx);
    assert.equal(judgmentExists(p, 'j.sec.cal2.dplan.m2.1.1'), true);
    assert.equal(label(p, 'dplan.m2.1.1'), 'proven');
  });

  it('F1b: a PM plan raises a stopped exploration\'s budget: the stop escalation closes, its Secretary step is not offered, the one in flight hands back into history', async () => {
    const p = fresh();
    const { w, plan } = await startExploration(p, 'm3', { rounds: 1, type: 'structure' });
    await budgetStop(p, 'm3');
    const s0 = await explorationState(p.ctx.ports(), 'm3' as MissionId, X);
    const esc = `xp.m3.${X}.stop${s0.stopped!.n}`;
    const v1 = s0.versions[0]!.id;
    const d = pmDispatch(p.ctx, `sec.${esc}`);
    await pmPlan(p.ctx, { mission: 'm3', words: [w], plan: plan(2, 3) });
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    const nx = await pmNext(p.ctx);
    const ctx = flowCtx(p.ctx.ports(), 'm3' as MissionId);
    assert.match((await closedEscalation(ctx, esc)) ?? '', /left stop/);
    assert.ok(!nx.ready.some((r) => r.step === `sec.${esc}`));
    assert.ok(!nx.waitingOnUser.some((x) => x.escalation === esc));
    const v1Before = label(p, v1);
    assert.notEqual(await dispatchedHandBack(p, d.dispatch, SEC('accept-risk')), 'accepted');
    await pmNext(p.ctx);
    assert.equal(judgmentExists(p, `j.sec.${esc}`), false);
    assert.equal(label(p, v1), v1Before);
    assert.ok(!notices(p).includes('secretary-undecided'));
    await assertExits(p, 'm3', X, 'F1b');
  });

  it('F1c: a newer PM plan in effect closes the older batch\'s Calibrator ② escalation: not offered, not waiting; a late accept writes nothing', async () => {
    const p = fresh();
    const w1 = await toCal2Escalation(p, 'm4');
    const esc = 'cal2.dplan.m4.1.1';
    const d = pmDispatch(p.ctx, `sec.${esc}`);
    const before = label(p, 'dplan.m4.1.1');
    const w2 = pmSay(p.ctx, 'Errors throw. Same plan otherwise. (m4)').words;
    await pmPlan(p.ctx, { mission: 'm4', plan: { ...(addPlan('m4', w1) as Record<string, unknown>), round: 2 }, words: [w1, w2] });
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    const ctx = flowCtx(p.ctx.ports(), 'm4' as MissionId);
    assert.match((await closedEscalation(ctx, esc)) ?? '', /was submitted/, 'closed in the newer batch\'s own write');
    assert.notEqual(await dispatchedHandBack(p, d.dispatch, SEC('accept')), 'accepted');
    const nx = await pmNext(p.ctx);
    assert.ok(!nx.ready.some((r) => r.step === `sec.${esc}`));
    assert.deepEqual(nx.waitingOnUser, []);
    assert.equal(judgmentExists(p, `j.sec.${esc}`), false);
    assert.equal(label(p, 'dplan.m4.1.1'), before);
    assert.ok(!notices(p).includes('secretary-undecided'));
    await step(p.ctx, 'architect-decompose', () => addDetailedPlan('m4'));
    await step(p.ctx, 'calibrator-2', (c) => cal2Pass(c));
    assert.deepEqual((await resolveSubtasks(p.ctx)).blocked, []);
  });

  it('F1d: a card quotes only the decisions carried out under the task\'s current card; a superseded question is not offered', async () => {
    const p = fresh();
    const w1 = await startAddMission(p.ctx, 'm5');
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(p.ctx, 'architect-decompose', () => addDetailedPlan('m5'));
    await step(p.ctx, 'calibrator-2', (c) => cal2Pass(c));
    await build(p, 1, ['Which spelling of add?']);
    // the Secretary answers the question under card 1: carried out, quoted to that card's Reviewer
    const cdec = (await pmNext(p.ctx)).ready.find((r) => r.kind === 'secretary')!.step;
    await dispatchedHandBack(p, pmDispatch(p.ctx, cdec).dispatch, SEC('answer', { instructions: 'Use the old spelling' }));
    const rv = await readyOf(p.ctx, 'reviewer');
    const rd = pmDispatch(p.ctx, rv.step);
    await dispatchedHandBack(p, rd.dispatch, { ...(reviewerPass(dispatchView(p.ctx, rd.dispatch).card as never) as Record<string, unknown>), verdict: 'rework', findings: ['the spelling'] });
    // the next attempt under card 1 quotes it; a second question under card 1 waits for its Secretary
    assert.match(await build(p, 2, ['Which file holds add?']), /Use the old spelling/);
    const cdec2 = (await pmNext(p.ctx)).ready.find((r) => r.kind === 'secretary' && r.step !== cdec)!.step;
    await replanAdd(p, 'm5', w1, 2, 'Use the new spelling for add.', { goal: 'Implement add with the new spelling' });
    const nx = await pmNext(p.ctx);
    assert.ok(!nx.ready.some((r) => r.step === cdec2), 'the superseded question is not offered');
    // the new card's Constructor and Reviewer quote neither answer
    const quotes = await build(p, 3);
    assert.doesNotMatch(quotes, /old spelling/);
    const rv2 = await readyOf(p.ctx, 'reviewer');
    const card = dispatchView(p.ctx, pmDispatch(p.ctx, rv2.step).dispatch).card as unknown as { decisionQuotes: string[] };
    assert.deepEqual(card.decisionQuotes, []);
  });

  it('#5: two direction findings and a drift; one escalation abandoned: nothing of the exploration is left open or ready', async () => {
    const p = fresh();
    await startExploration(p, 'm6', { rounds: 3, type: 'structure' });
    await step(p.ctx, 'researcher-author', () => submit('v1'));
    await step(p.ctx, 'crititor', (c) => attack([finding('serious', 'internal contradiction', 'a'), finding('serious', 'gets stuck', 'b')], c));
    await step(p.ctx, 'researcher-author', (c) => submit('v2', reviseAll(c)));
    await step(p.ctx, 'stabilizer', (c) => judge(c, 'shifts-direction', 'serious', 'drifting'));
    const ctx = flowCtx(p.ctx.ports(), 'm6' as MissionId);
    const open0 = (await openEscalations(ctx, `exploration:${X}`)).map((e) => e.id);
    assert.equal(open0.length, 3, JSON.stringify(open0));
    await dispatchedHandBack(p, pmDispatch(p.ctx, `sec.${open0[0]}`).dispatch, SEC('abandon'));
    const nx = await pmNext(p.ctx);
    const s = await explorationState(p.ctx.ports(), 'm6' as MissionId, X);
    assert.equal(s.settled?.body.outcome, 'no-conclusion');
    assert.deepEqual((await openEscalations(ctx, `exploration:${X}`)).filter((e) => e.id.startsWith('xp.')).map((e) => e.id), []);
    assert.ok(!nx.ready.some((r) => r.step.startsWith('sec.xp.') || ['crititor', 'researcher-author', 'stabilizer'].includes(r.kind)), JSON.stringify(nx.ready.map((r) => r.step)));
    await assertExits(p, 'm6', X, '#5');
  });

  it('S1: a no-conclusion routing escalation offers replan; after the user re-plans without the exploration nothing waits and nothing is blocked', async () => {
    const p = fresh();
    const { w, plan } = await startExploration(p, 'm7', { rounds: 1, type: 'structure' });
    await budgetStop(p, 'm7');
    await step(p.ctx, 'secretary', () => SEC('abandon'));
    await assertExits(p, 'm7', X, 'given up');
    const routing = escalations(p, 'm7').find((e) => e.id === `explore.m7.${X}`)!;
    assert.deepEqual(routing.options, ['replan', 'ask-user']);
    await step(p.ctx, 'secretary', () => SEC('ask-user'));
    const n1 = await pmNext(p.ctx);
    assert.deepEqual(n1.waitingOnUser.find((x) => x.escalation === routing.id)?.options, ['replan']);
    // the user re-plans without the exploration
    const w2 = pmSay(p.ctx, 'Forget the exploration; just build a simple cache. (m7)').words;
    const p2 = plan(2, 1) as { elements: unknown[] };
    p2.elements = [{ id: 'e2', kind: 'deliverable', text: 'A simple cache', provenance: { by: 'user', words: w2, quote: 'just build a simple cache' }, after: [], items: ['g1'] }];
    await pmPlan(p.ctx, { mission: 'm7', words: [w, w2], plan: p2 });
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    const n2 = await pmNext(p.ctx);
    assert.deepEqual(n2.waitingOnUser, []);
    assert.deepEqual((await resolveSubtasks(p.ctx)).blocked, []);
    assert.match((await closedEscalation(flowCtx(p.ctx.ports(), 'm7' as MissionId), routing.id)) ?? '', /took effect without the exploration/);
  });

  it('S1: the user answers a no-conclusion routing escalation "replan": routed, applied, and the PM is told to re-plan the waiting part', async () => {
    const p = fresh();
    await startExploration(p, 'm8', { rounds: 1, type: 'structure' });
    await budgetStop(p, 'm8');
    await step(p.ctx, 'secretary', () => SEC('abandon'));
    await step(p.ctx, 'secretary', () => SEC('ask-user'));
    await pmAnswer(p.ctx, { mission: 'm8', escalation: `explore.m8.${X}`, option: 'replan', words: pmSay(p.ctx, 'Plan the cache without that exploration. (m8)').words });
    const ctx = flowCtx(p.ctx.ports(), 'm8' as MissionId);
    assert.equal(await isApplied(ctx, `explore.m8.${X}`), true);
    assert.deepEqual(planEvents(p, 'm8', 'exploration-routed'), [X]);
    assert.ok(notices(p).includes('exploration-no-conclusion'), JSON.stringify(notices(p)));
    assert.deepEqual((await pmNext(p.ctx)).waitingOnUser, []);
    await assertExits(p, 'm8', X, 'S1 replan');
  });
});

describe('class B: a temporary state is never written as a permanent record', () => {
  const ps: ProcessProject[] = [];
  after(() => {
    setLabelBatchLimit(null);
    sweepThenClean(ps);
  });

  for (const type of ['direction', 'structure'] as const) {
    it(`#2 (${type}): an exploration settles while the labels recompute: nothing is routed or planned until they are current; then the conclusion is routed as one`, async () => {
      const p = processProject();
      ps.push(p);
      const m = `m9${type[0]}`;
      await startExploration(p, m, { rounds: 3, type });
      await step(p.ctx, 'researcher-author', () => submit('v1: an LRU cache'));
      await step(p.ctx, 'crititor', (c) => attack([], c));
      await step(p.ctx, 'stabilizer', (c) => judge(c, 'in-scope', 'general'));
      await step(p.ctx, 'crititor', (c) => attack([], c));
      await seedFanout(p, m, 400);
      await frontier(p, m);
      await step(p.ctx, 'stabilizer', (c) => judge(c, 'in-scope', 'general'));
      const s = await explorationState(p.ctx.ports(), m as MissionId, X);
      assert.equal(s.settled?.body.outcome, 'conclusion');
      await pmNext(p.ctx);
      assert.deepEqual(escalations(p, m).filter((e) => e.id.startsWith('explore.')), [], 'nothing routed while recomputing');
      assert.deepEqual(planEvents(p, m, 'attempt'), [], 'nothing planned while recomputing');
      assert.ok(!notices(p).includes('exploration-conclusion-unproven'));
      drained(p);
      const nx = await pmNext(p.ctx);
      if (type === 'direction') {
        const routing = escalations(p, m).find((e) => e.id === `explore.${m}.${X}`)!;
        assert.deepEqual(routing.options, ['accept', 'ask-user']);
        assert.equal((routing.facts as { outcome: string }).outcome, 'conclusion');
        await step(p.ctx, 'secretary', () => SEC('accept'));
      } else assert.ok(nx.ready.some((r) => r.kind === 'architect-decompose'), JSON.stringify(nx.ready.map((r) => r.kind)));
      // accepting (or the structure route) plans the waiting element e1
      const arch = await readyOf(p.ctx, 'architect-decompose');
      const card = dispatchView(p.ctx, pmDispatch(p.ctx, arch.step).dispatch).card as unknown as { unsettledExplorations: string[]; pmPlan: { elements: Array<{ id: string }> }; output: { calibrator2: { reliesOn: string[] } } };
      assert.deepEqual(card.unsettledExplorations, []);
      assert.ok(card.output.calibrator2.reliesOn.includes(s.settled!.body.artifact!), JSON.stringify(card.output.calibrator2));
      assert.ok(!notices(p).includes('exploration-conclusion-unproven'));
      assert.deepEqual((await resolveSubtasks(p.ctx)).blocked, []);
      await assertExits(p, m, X, `#2 ${type}`);
    });
  }
});
