// Code review round 10 (stab10): the split commit of a decision. A ruling judgment (j.sec.<id> when
// the Secretary decided, j.user.<id> when the user did) is written only in the write that carries
// the decision out, with its "applied"; and every write by which an escalation's owner leaves scope
// closes that escalation in the same append (its queued Secretary step cancelled after it). So a
// decision overridden, closed, or never carried out leaves no ruling, in any order. Real process
// with git; every project ends with the ruling sweep (test/exploration-exits.ts).

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { resolveSubtasks } from '../src/cli/layers.ts';
import { buildGraph } from '../src/cli/tree.ts';
import type { MissionId } from '../src/common/ids.ts';
import type { BaseRecord, ReviewContract } from '../src/common/records.ts';
import { decisionLabels, setLabelBatchLimit } from '../src/evaluator/index.ts';
import { legalizationState } from '../src/flow/audit/flow.ts';
import { flowCtx } from '../src/flow/context.ts';
import { explorationStep } from '../src/flow/exploration/step.ts';
import { explorationState } from '../src/flow/exploration/flow.ts';
import { planningStep, submitPmBatch } from '../src/flow/planning.ts';
import { cal1Pass, cal2Escalate, cal2Pass } from '../src/flow/scripted.ts';
import { closedEscalation, decisionFor, isApplied, openEscalations, secretaryStep } from '../src/flow/secretary.ts';
import { pmAnswer, pmDispatch, pmLegalize, pmMission, pmNext, pmPlan, pmRelease, pmRequirement, pmSay, pmStartLegalization } from '../src/process/index.ts';
import { dispatchView, recordSeatHandBack } from '../src/process/seat.ts';
import type { AuditNodeCard, AuditNodeResult } from '../src/seat/cards/auditor.ts';
import { assertExits, assertRulingsCarried, drained, frontier, seedFanout, sweepThenClean } from './exploration-exits.ts';
import { addDetailedPlan, addPlan, CHECK_JS, handBack, processProject, readAll, readyOf, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';
import { join } from 'node:path';

const X = 'X1';
const SEC = (option: string, o: { instructions?: string; classification?: string; authorization?: string | null } = {}) => ({
  option,
  classification: o.classification ?? (option === 'ask-user' ? 'needs-user' : 'detail'),
  authorization: o.authorization ?? null,
  reason: `the Secretary decides: ${option}`,
  instructions: o.instructions ?? (option === 'send-back' || option === 'replan' ? 'do it again' : ''),
  grantExtra: 0,
  notice: option === 'ask-user' || o.classification === 'important-within-authority' ? `decided ${option}` : '',
  mayMatter: false,
});
const judgmentExists = (p: ProcessProject, id: string): boolean => p.ctx.memory.read((db) => db.stmt("SELECT 1 FROM log WHERE kind = 'judgment' AND json_extract(record, '$.judgment') = ?").get(id) !== undefined);
const rulings = (p: ProcessProject): string[] => p.ctx.memory.read((db) => (db.stmt("SELECT json_extract(record, '$.judgment') AS j FROM log WHERE kind = 'judgment' AND (json_extract(record, '$.judgment') LIKE 'j.sec.%' OR json_extract(record, '$.judgment') LIKE 'j.user.%')").all() as Array<{ j: string }>).map((r) => r.j));
const label = (p: ProcessProject, id: string): string => String(p.ctx.memory.read((db) => decisionLabels(db, [id]))[id]);
const notices = (p: ProcessProject): string[] => p.ctx.memory.read((db) => (db.stmt("SELECT json_extract(record, '$.category') AS c FROM log WHERE kind = 'alert' ORDER BY rev").all() as Array<{ c: string }>).map((r) => r.c));
const applied = (p: ProcessProject, m: string, key: string): { what?: { option?: string }; by?: string; dispatch?: string; words?: string; ruling?: string } | null => {
  const r = p.ctx.memory.read((db) => db.stmt("SELECT body FROM flow_events WHERE mission = ? AND line = 'secretary' AND event = 'applied' AND key = ?").get(m, key) as { body: string } | undefined);
  return r === undefined ? null : JSON.parse(p.ctx.memory.data.text(r.body));
};
const opOf = (p: ProcessProject, sql: string, ...args: string[]): string | null => p.ctx.memory.read((db) => (db.stmt(sql).get(...args) as { op: string | null } | undefined)?.op ?? null);
const appliedOp = (p: ProcessProject, key: string): string | null => opOf(p, "SELECT op FROM log WHERE kind = 'flow.event' AND json_extract(record, '$.line') = 'secretary' AND json_extract(record, '$.event') = 'applied' AND json_extract(record, '$.key') = ?", key);
const judgmentOp = (p: ProcessProject, id: string): string | null => opOf(p, "SELECT op FROM log WHERE kind = 'judgment' AND json_extract(record, '$.judgment') = ?", id);
const authOf = (p: ProcessProject, dispatch: string): string | null => (dispatchView(p.ctx, dispatch).card as unknown as { authorizations: Array<{ id: string }> }).authorizations[0]?.id ?? null;

/** A hand-back recorded without advancing the process (the flows run later, as a later `mp pm next` would). */
async function handBackQuiet(p: ProcessProject, dispatch: string, fields: unknown): Promise<string> {
  readAll(p.ctx, dispatch);
  const a = await recordSeatHandBack(p.ctx, dispatch, { report: `# Report of ${dispatch}\n\nDone.\n`, fields, advance: false });
  assert.equal(a.kind, 'recorded', JSON.stringify(a));
  return a.kind === 'recorded' ? a.outcome : 'refused';
}
async function handOver(p: ProcessProject, dispatch: string, fields: unknown): Promise<string> {
  readAll(p.ctx, dispatch);
  const a = await handBack(p.ctx, dispatch, fields);
  assert.equal(a.kind, 'recorded', JSON.stringify(a));
  return a.kind === 'recorded' ? a.outcome : 'refused';
}

async function toCal2Escalation(p: ProcessProject, m: string): Promise<string> {
  const w = await startAddMission(p.ctx, m);
  await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
  await step(p.ctx, 'architect-decompose', () => addDetailedPlan(m));
  await step(p.ctx, 'calibrator-2', (c) => cal2Escalate(c, 'the user should decide the error handling'));
  return w;
}

// ---------------------------------------------------------------- explorations

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
const attack = (findings: unknown[], card: any) => ({
  findings,
  rechecks: card.priorFindings.filter((f: any) => f.status === 'awaiting-recheck').map((f: any) => ({ finding: f.id, resolved: 'yes', reason: 'fixed', evidence: [] })),
  settled: [],
  reply: 'assessment',
});
const reviseAll = (card: any) => card.openFindings.map((f: any) => ({ finding: f.id, action: 'revise', note: 'changed' }));
const judge = (card: any, verdict = 'in-scope', severity = 'serious') => ({ findings: card.findings.map((f: any) => ({ finding: f.id, verdict, severity, reason: `judged ${verdict}`, question: '' })), round: { verdict: 'on-track', reason: 'answers the question', question: '' } });

/** One round with a serious finding the author revises; the budget (1 round) stops it: an escalation whose position is the version's negation. */
async function budgetStop(p: ProcessProject, m: string): Promise<string> {
  await step(p.ctx, 'researcher-author', () => submit('v1'));
  await step(p.ctx, 'crititor', (c) => attack([finding('serious', 'internal contradiction', 'hole 1')], c));
  await step(p.ctx, 'researcher-author', (c) => submit('v2', reviseAll(c)));
  await step(p.ctx, 'stabilizer', (c) => judge(c));
  const s = await explorationState(p.ctx.ports(), m as MissionId, X);
  assert.equal(s.stopped?.reason, 'budget-exhausted');
  return `xp.${m}.${X}.stop${s.stopped!.n}`;
}

/** A structure exploration settled on a proven conclusion; its waiting element planned; Calibrator ② escalates the plan (stab10's P2 setup). */
async function exploredToCal2(p: ProcessProject, m: string): Promise<void> {
  await startExploration(p, m, { rounds: 3, type: 'structure' });
  await step(p.ctx, 'researcher-author', () => submit('v1: an LRU cache'));
  await step(p.ctx, 'crititor', (c) => attack([], c));
  await step(p.ctx, 'stabilizer', (c) => judge(c, 'in-scope', 'general'));
  await step(p.ctx, 'crititor', (c) => attack([], c));
  await step(p.ctx, 'stabilizer', (c) => judge(c, 'in-scope', 'general'));
  assert.equal((await explorationState(p.ctx.ports(), m as MissionId, X)).settled?.body.outcome, 'conclusion');
  const dp = addDetailedPlan(m) as { newInterfaces: Array<{ provenance: { planElement: string } }>; modules: Array<{ provenance: { planElement: string } }>; tasks: Array<{ provenance: { planElement: string } }> };
  for (const e of [...dp.newInterfaces, ...dp.modules, ...dp.tasks]) e.provenance.planElement = 'e1';
  await step(p.ctx, 'architect-decompose', () => dp);
  await step(p.ctx, 'calibrator-2', (c) => cal2Escalate(c, 'the user should decide the error handling'));
}

describe('a ruling is written only in the write that carries its decision out', () => {
  const ps: ProcessProject[] = [];
  const fresh = (): ProcessProject => {
    const p = processProject();
    ps.push(p);
    return p;
  };
  after(() => {
    setLabelBatchLimit(null);
    sweepThenClean(ps);
  });

  it('#2 Secretary then user: the Secretary\'s accept is recorded but not carried out: no ruling; the user\'s send-back is carried out: still no ruling, the plan still negated, no "in effect" notice', async () => {
    const p = fresh();
    await toCal2Escalation(p, 'm1');
    const esc = 'cal2.dplan.m1.1.1';
    const d = pmDispatch(p.ctx, (await readyOf(p.ctx, 'secretary')).step);
    assert.equal(await handBackQuiet(p, d.dispatch, SEC('accept', { classification: 'important-within-authority', authorization: authOf(p, d.dispatch) })), 'accepted');
    // the Secretary's decision is recorded (its step), before the owning flow carries it out
    await secretaryStep(flowCtx(p.ctx.ports(), 'm1' as MissionId));
    const ctx = flowCtx(p.ctx.ports(), 'm1' as MissionId);
    assert.equal((await decisionFor(ctx, esc))?.option, 'accept');
    assert.equal(await isApplied(ctx, esc), false);
    assert.deepEqual(rulings(p), [], 'no ruling while the decision waits');
    assert.ok(!notices(p).includes('secretary-decision'), 'not "in effect" before it is carried out');
    // the user overrides it before it is carried out (WI-24): the user's answer is the one carried out
    await pmAnswer(p.ctx, { mission: 'm1', escalation: esc, option: 'send-back', instructions: 'state the error handling', words: pmSay(p.ctx, 'No, send it back: state the error handling. (m1)').words });
    await pmNext(p.ctx);
    const a = applied(p, 'm1', esc);
    assert.deepEqual([a?.what?.option, a?.by], ['send-back', 'user']);
    assert.match(a?.words ?? '', /^W-\d+$/, 'who decided: the user\'s words entry');
    assert.deepEqual(rulings(p), []);
    assert.equal(label(p, 'dplan.m1.1.1'), 'negated');
    assert.ok(!notices(p).includes('secretary-decision'));
  });

  it('#2 user then Secretary: the user\'s accept is carried out with exactly one ruling (j.user) in that write; the Secretary\'s late accept writes nothing', async () => {
    const p = fresh();
    await toCal2Escalation(p, 'm2');
    const esc = 'cal2.dplan.m2.1.1';
    const d = pmDispatch(p.ctx, (await readyOf(p.ctx, 'secretary')).step);
    await pmAnswer(p.ctx, { mission: 'm2', escalation: esc, option: 'accept', words: pmSay(p.ctx, 'Accept the detailed plan. (m2)').words });
    assert.deepEqual(rulings(p), [`j.user.${esc}`]);
    assert.equal(judgmentOp(p, `j.user.${esc}`), appliedOp(p, esc), 'the ruling and its "applied" are one write');
    assert.equal(applied(p, 'm2', esc)?.ruling, `j.user.${esc}`);
    assert.notEqual(await handOver(p, d.dispatch, SEC('accept', { classification: 'important-within-authority', authorization: authOf(p, d.dispatch) })), 'accepted');
    await pmNext(p.ctx);
    assert.deepEqual(rulings(p), [`j.user.${esc}`], 'exactly one ruling');
    assert.equal(label(p, 'dplan.m2.1.1'), 'proven');
  });

  it('regression: a Secretary accept on an open escalation writes j.sec in the write that carries it out; the plan is proven and in effect; the PM is told it is in effect', async () => {
    const p = fresh();
    await toCal2Escalation(p, 'm3');
    const esc = 'cal2.dplan.m3.1.1';
    const d = pmDispatch(p.ctx, (await readyOf(p.ctx, 'secretary')).step);
    await handOver(p, d.dispatch, SEC('accept', { classification: 'important-within-authority', authorization: authOf(p, d.dispatch) }));
    assert.equal(judgmentOp(p, `j.sec.${esc}`), appliedOp(p, esc));
    assert.equal(applied(p, 'm3', esc)?.dispatch, d.dispatch, 'who decided: the Secretary\'s dispatch');
    assert.equal(label(p, 'dplan.m3.1.1'), 'proven');
    assert.ok(p.ctx.memory.read((db) => db.stmt("SELECT 1 FROM flow_events WHERE mission = 'm3' AND line = 'plan' AND event = 'effective' AND key = 'dplan.m3.1.1'").get() !== undefined), 'in effect');
    assert.ok(notices(p).includes('secretary-decision'));
    // the run-chain reads still find who decided: the ruling carries out the decision, handed back by the Secretary's dispatch
    const g = buildGraph(p.ctx, { mission: 'm3' });
    const j = g.nodes.get(`judgment:j.sec.${esc}`)!;
    assert.ok((g.out.get(j.key) ?? []).some((e) => e.rel === 'carries out' && e.to === `decision:m3/${esc}`), JSON.stringify(g.out.get(j.key)));
    assert.match(j.by ?? '', new RegExp(`dispatch ${d.dispatch}`));
  });

  it('regression with a recompute: Calibrator ② is not held by an unrelated recompute; the accept is carried out with its ruling in one write', async () => {
    const p = fresh();
    const m = 'm4';
    await exploredToCal2(p, m);
    const esc = `cal2.dplan.${m}.1.1`;
    const d = pmDispatch(p.ctx, (await readyOf(p.ctx, 'secretary')).step);
    await seedFanout(p, m, 400);
    await frontier(p, m);
    await handOver(p, d.dispatch, SEC('accept', { classification: 'important-within-authority', authorization: authOf(p, d.dispatch) }));
    await pmNext(p.ctx);
    assert.equal(await isApplied(flowCtx(p.ctx.ports(), m as MissionId), esc), true, 'carried out during the recompute');
    assert.equal(judgmentOp(p, `j.sec.${esc}`), appliedOp(p, esc));
    assert.ok(p.ctx.memory.read((db) => db.stmt(`SELECT 1 FROM flow_events WHERE mission = '${m}' AND line = 'plan' AND event = 'effective'`).get() !== undefined), 'in effect');
    drained(p);
    await pmNext(p.ctx);
    assert.equal(label(p, `dplan.${m}.1.1`), 'proven');
  });

  it('exploration accept-risk: the ruling, the settle, the exploration ruling and "applied" are one write; no record ever holds the settle without its ruling; planning routes it as a conclusion', async () => {
    const p = fresh();
    const m = 'm5';
    await startExploration(p, m, { rounds: 1, type: 'structure' });
    const esc = await budgetStop(p, m);
    await step(p.ctx, 'secretary', () => SEC('accept-risk'));
    const s = await explorationState(p.ctx.ports(), m as MissionId, X);
    assert.deepEqual([s.settled?.body.outcome, s.settled?.body.stop], ['conclusion', 'budget']);
    const jid = `j.sec.${esc}`;
    const op = judgmentOp(p, jid);
    assert.ok(op !== null);
    assert.equal(appliedOp(p, esc), op);
    assert.equal(opOf(p, "SELECT op FROM log WHERE kind = 'flow.event' AND json_extract(record, '$.line') = ? AND json_extract(record, '$.event') = 'settled'", `exploration:${X}`), op);
    assert.equal(opOf(p, "SELECT op FROM log WHERE kind = 'flow.event' AND json_extract(record, '$.line') = ? AND json_extract(record, '$.event') = 'ruling' AND json_extract(record, '$.key') = ?", `exploration:${X}`, esc), op);
    // a crash after any append: the state at every write boundary never has the settle without its ruling
    const writes = p.ctx.memory.read((db) => db.stmt("SELECT op, MAX(rev) AS last, MAX(kind = 'judgment' AND json_extract(record, '$.judgment') = ?) AS ruling, MAX(kind = 'flow.event' AND json_extract(record, '$.event') = 'settled' AND json_extract(record, '$.line') = ?) AS settled FROM log GROUP BY op ORDER BY last").all(jid, `exploration:${X}`) as Array<{ ruling: number; settled: number }>);
    let haveRuling = false;
    let haveSettle = false;
    for (const w of writes) {
      haveRuling ||= w.ruling === 1;
      haveSettle ||= w.settled === 1;
      assert.ok(!haveSettle || haveRuling, 'a prefix of the record with the settle but not its ruling');
    }
    assert.ok(haveSettle && haveRuling);
    assert.equal(label(p, s.settled!.body.artifact!), 'proven');
    assert.ok((await pmNext(p.ctx)).ready.some((r) => r.kind === 'architect-decompose'), 'routed as a conclusion: the waiting part is planned');
    await assertExits(p, m, X, 'accept-risk');
  });
});

describe('every scope-leaving write closes its escalations in the same append: no ruling in any order', () => {
  const ps: ProcessProject[] = [];
  const fresh = (): ProcessProject => {
    const p = processProject();
    ps.push(p);
    return p;
  };
  after(() => {
    setLabelBatchLimit(null);
    sweepThenClean(ps);
  });

  const newerBatch = async (p: ProcessProject, m: string, w1: string): Promise<void> => {
    const w2 = pmSay(p.ctx, `Errors throw. Same plan otherwise. (${m})`).words;
    await pmPlan(p.ctx, { mission: m, plan: { ...(addPlan(m, w1) as Record<string, unknown>), round: 2 }, words: [w1, w2] });
  };

  it('a newer PM batch (P1, case i): the older batch\'s escalation closes at the submission; its Secretary step is not offered, nothing waits; the Secretary in flight writes nothing', async () => {
    const p = fresh();
    const w1 = await toCal2Escalation(p, 'm1');
    const esc = 'cal2.dplan.m1.1.1';
    const d = pmDispatch(p.ctx, `sec.${esc}`);
    await newerBatch(p, 'm1', w1);
    const ctx = flowCtx(p.ctx.ports(), 'm1' as MissionId);
    assert.match((await closedEscalation(ctx, esc)) ?? '', /was submitted/);
    const nx = await pmNext(p.ctx);
    assert.ok(!nx.ready.some((r) => r.step === `sec.${esc}`));
    assert.deepEqual(nx.waitingOnUser, []);
    assert.notEqual(await handOver(p, d.dispatch, SEC('accept')), 'accepted');
    assert.deepEqual(rulings(p), []);
    assert.equal(label(p, 'dplan.m1.1.1'), 'negated');
  });

  it('a newer PM batch (P1u): the escalation waiting on the user closes at the submission; the user\'s answer is refused', async () => {
    const p = fresh();
    const w1 = await toCal2Escalation(p, 'm2');
    const esc = 'cal2.dplan.m2.1.1';
    await step(p.ctx, 'secretary', () => SEC('ask-user'));
    await newerBatch(p, 'm2', w1);
    assert.deepEqual((await pmNext(p.ctx)).waitingOnUser, []);
    await assert.rejects(() => pmAnswer(p.ctx, { mission: 'm2', escalation: esc, option: 'accept', words: pmSay(p.ctx, 'Accept it. (m2)').words }), /closed without being carried out/);
    assert.deepEqual(rulings(p), []);
  });

  it('a newer PM batch (case ii): a Secretary decision recorded before the submission, not carried out, is closed and never carried out', async () => {
    const p = fresh();
    const w1 = await toCal2Escalation(p, 'm3');
    const esc = 'cal2.dplan.m3.1.1';
    const d = pmDispatch(p.ctx, `sec.${esc}`);
    await handBackQuiet(p, d.dispatch, SEC('accept'));
    await secretaryStep(flowCtx(p.ctx.ports(), 'm3' as MissionId));
    assert.equal((await decisionFor(flowCtx(p.ctx.ports(), 'm3' as MissionId), esc))?.option, 'accept');
    await newerBatch(p, 'm3', w1);
    await pmNext(p.ctx);
    assert.equal(applied(p, 'm3', esc)?.what?.option, 'superseded');
    assert.deepEqual(rulings(p), []);
    assert.equal(label(p, 'dplan.m3.1.1'), 'negated');
  });

  it('a newer PM batch (case iii): a hand-back right after the batch\'s write (before any flow pass) is not accepted and writes nothing', async () => {
    const p = fresh();
    const w1 = await toCal2Escalation(p, 'm4');
    const esc = 'cal2.dplan.m4.1.1';
    const d = pmDispatch(p.ctx, `sec.${esc}`);
    const w2 = pmSay(p.ctx, 'Errors throw. Same plan otherwise. (m4)').words;
    await submitPmBatch(p.ctx.ports(), { mission: 'm4' as MissionId, plan: { ...(addPlan('m4', w1) as Record<string, unknown>), round: 2 }, userWords: [w1, w2] });
    assert.notEqual(await handBackQuiet(p, d.dispatch, SEC('accept')), 'accepted');
    await pmNext(p.ctx);
    assert.deepEqual(rulings(p), []);
    assert.equal(label(p, 'dplan.m4.1.1'), 'negated');
  });

  /** A stopped exploration with its Secretary in flight; a PM plan raising the budget recorded and its Calibrator ① handed back, the flows not yet run. */
  async function redefinitionPending(p: ProcessProject, m: string): Promise<{ esc: string; sec: string; v1: string }> {
    const { w, plan } = await startExploration(p, m, { rounds: 1, type: 'structure' });
    const esc = await budgetStop(p, m);
    const v1 = (await explorationState(p.ctx.ports(), m as MissionId, X)).versions.at(-1)!.id;
    const sec = pmDispatch(p.ctx, `sec.${esc}`).dispatch;
    await pmPlan(p.ctx, { mission: m, words: [w], plan: plan(2, 3) });
    const cal1 = pmDispatch(p.ctx, (await readyOf(p.ctx, 'calibrator-1')).step).dispatch;
    await handBackQuiet(p, cal1, cal1Pass(dispatchView(p.ctx, cal1).card as never));
    return { esc, sec, v1 };
  }

  /** The planning step alone until the newer plan is in effect (its write; no other flow runs). */
  async function planInEffect(p: ProcessProject, m: string): Promise<void> {
    for (let i = 0; i < 6; i++) {
      if (p.ctx.memory.read((db) => db.stmt(`SELECT 1 FROM flow_events WHERE mission = '${m}' AND line = 'plan' AND event = 'pm-plan-effective' AND key = 'pmplan.${m}.2'`).get() !== undefined)) return;
      await planningStep(flowCtx(p.ctx.ports(), m as MissionId));
    }
    assert.fail('the newer plan did not take effect');
  }

  it('a redefinition (case i): the stop escalation it leaves closes in the redefinition\'s write; the Secretary in flight hands back accept-risk into history', async () => {
    const p = fresh();
    const { esc, sec, v1 } = await redefinitionPending(p, 'm5');
    const before = label(p, v1);
    await pmNext(p.ctx);
    assert.equal(opOf(p, "SELECT op FROM log WHERE kind = 'flow.event' AND json_extract(record, '$.event') = 'redefined' AND json_extract(record, '$.line') = ?", `exploration:${X}`), appliedOp(p, esc), 'closed in the redefinition\'s own write');
    assert.notEqual(await handOver(p, sec, SEC('accept-risk')), 'accepted');
    assert.deepEqual(rulings(p), []);
    assert.equal(label(p, v1), before);
    await assertExits(p, 'm5', X, 'redefined i');
  });

  it('a redefinition (case ii): the Secretary\'s accept-risk recorded after the plan took effect, before the redefinition\'s write, is closed and never carried out', async () => {
    const p = fresh();
    const { esc, sec } = await redefinitionPending(p, 'm6');
    const ctx = flowCtx(p.ctx.ports(), 'm6' as MissionId);
    // the plan takes effect; the Secretary's accept-risk is recorded; then the exploration step redefines it
    await planInEffect(p, 'm6');
    await handBackQuiet(p, sec, SEC('accept-risk'));
    await secretaryStep(ctx);
    assert.equal((await decisionFor(ctx, esc))?.option, 'accept-risk');
    await explorationStep(flowCtx(p.ctx.ports(), 'm6' as MissionId));
    await pmNext(p.ctx);
    assert.equal(applied(p, 'm6', esc)?.what?.option, 'superseded');
    assert.deepEqual(rulings(p), []);
    assert.equal((await explorationState(p.ctx.ports(), 'm6' as MissionId, X)).settled, null, 'not settled on the never-carried-out acceptance');
    await assertExits(p, 'm6', X, 'redefined ii');
  });

  it('a redefinition (case iii): the hand-back right after the redefinition\'s write (no other pass between) is not accepted', async () => {
    const p = fresh();
    const { esc, sec } = await redefinitionPending(p, 'm7');
    const ctx = flowCtx(p.ctx.ports(), 'm7' as MissionId);
    await planInEffect(p, 'm7');
    await explorationStep(ctx);
    assert.match((await closedEscalation(ctx, esc)) ?? '', /left stop/);
    assert.notEqual(await handBackQuiet(p, sec, SEC('accept-risk')), 'accepted');
    await pmNext(p.ctx);
    assert.deepEqual(rulings(p), []);
  });

  it('a plan in effect without the exploration: its routing escalation closes in the takes-effect write; the Secretary in flight writes nothing', async () => {
    const p = fresh();
    const { w, plan } = await startExploration(p, 'm8', { rounds: 1, type: 'structure' });
    await budgetStop(p, 'm8');
    await step(p.ctx, 'secretary', () => SEC('abandon'));
    const routing = `explore.m8.${X}`;
    const sec = pmDispatch(p.ctx, `sec.${routing}`).dispatch;
    const w2 = pmSay(p.ctx, 'Forget the exploration; just build a simple cache. (m8)').words;
    const p2 = plan(2, 1) as { elements: unknown[] };
    p2.elements = [{ id: 'e2', kind: 'deliverable', text: 'A simple cache', provenance: { by: 'user', words: w2, quote: 'just build a simple cache' }, after: [], items: ['g1'] }];
    await pmPlan(p.ctx, { mission: 'm8', words: [w, w2], plan: p2 });
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    assert.equal(opOf(p, "SELECT op FROM log WHERE kind = 'flow.event' AND json_extract(record, '$.event') = 'pm-plan-effective' AND json_extract(record, '$.key') = 'pmplan.m8.2'"), appliedOp(p, routing), 'closed in the takes-effect write');
    assert.notEqual(await handOver(p, sec, SEC('replan')), 'accepted');
    assert.deepEqual((await pmNext(p.ctx)).waitingOnUser, []);
    assert.deepEqual((await resolveSubtasks(p.ctx)).blocked, []);
  });
});

describe('#3 and #4: a given-up task and an ended legalization leave nothing open, ready or blocked', () => {
  const ps: ProcessProject[] = [];
  after(() => sweepThenClean(ps));

  it('#4: a task given up closes its other open escalations (its Constructor questions) in the giving-up write', async () => {
    const p = processProject();
    ps.push(p);
    await startAddMission(p.ctx, 'm1');
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(p.ctx, 'architect-decompose', () => addDetailedPlan('m1'));
    await step(p.ctx, 'calibrator-2', (c) => cal2Pass(c));
    for (let n = 1; n <= 3; n++) {
      const s = await readyOf(p.ctx, 'constructor');
      const d = pmDispatch(p.ctx, s.step);
      write(join(p.dir, d.worktree!), 'src/add.js', `exports.add = (a, b) => a + b; // v${n}\n`);
      write(join(p.dir, d.worktree!), 'src/check.js', CHECK_JS);
      await handBack(p.ctx, d.dispatch, { done: `v${n}`, unmet_standards: [], unfixed_problems: [], decisions_needed: [`question ${n}?`] });
      await step(p.ctx, 'reviewer', (c) => {
        const pass = reviewerPass(c) as { judgments: Array<Record<string, unknown>> };
        return { ...pass, judgments: pass.judgments.map((j) => ({ ...j, met: 'no', reason: `missing ${n}` })), findings: [`missing ${n}`], verdict: 'rework' };
      });
    }
    const ctx = flowCtx(p.ctx.ports(), 'm1' as MissionId);
    assert.ok((await openEscalations(ctx, 'task:impl')).filter((e) => e.id.startsWith('cdec.')).length >= 2);
    await handOver(p, pmDispatch(p.ctx, 'sec.exh.task.m1.impl.3').dispatch, SEC('abandon'));
    const nx = await pmNext(p.ctx);
    assert.deepEqual((await openEscalations(ctx, 'task:impl')).map((e) => e.id), []);
    assert.ok(!nx.ready.some((r) => r.kind === 'secretary'), JSON.stringify(nx.ready.map((r) => r.step)));
    assert.deepEqual(nx.waitingOnUser, []);
    assert.deepEqual((await resolveSubtasks(p.ctx)).blocked, []);
  });

  it('#3: a legalization that ends closes the failed Auditor\'s escalation in the result\'s write', async () => {
    const p = processProject();
    ps.push(p);
    const m = 'm2';
    pmMission(p.ctx, m);
    const ports = p.ctx.ports();
    const c = ports.ledger.content;
    const reviewer = (reliesOn: string[]): ReviewContract[] => [{ review: 'reviewer', basisLines: ['S1' as never], reliesOn: reliesOn as never }];
    const obj = (id: string, prereqs: string[]): BaseRecord => ({ kind: 'object.version', object: id as never, objectKind: 'interpretation', mission: m as MissionId, module: null, content: c.put(`content of ${id}`), prerequisites: c.putList(prereqs), scope: { paths: ['README.md'], taskType: 'code' }, reviews: reviewer(prereqs) });
    await ports.ledger.append('item', { events: [{ mission: m as MissionId, line: 'requirements', event: 'item', key: 'S1.v1', body: { line: 'S1', version: 'S1.v1', type: 'acceptance', text: 'parses every field', source: { kind: 'words', words: 'W-1', quote: 'parse all fields' }, restatement: null, confirmedBy: null, notifyCondition: null } }] });
    await ports.ledger.append('setup', {
      records: [
        { kind: 'basis.version', basisKind: 'standard', line: 'S1' as never, version: 'S1.v1' as never, mission: m as MissionId, scope: null },
        { kind: 'env.snapshot', line: 'env.t' as never, snapshot: 'snap.1' as never },
        { kind: 'evidence', evidence: 'ev.A' as never, envLine: 'env.t' as never, envSnapshot: 'snap.1' as never, runClass: 'declared', fields: { exit: '0' } },
        obj('A', []),
        { kind: 'judgment', judgment: 'jA' as never, review: 'reviewer', executor: 'reviewer', target: 'A' as never, verdict: 'pass', evidence: c.putList(['ev.A']), bases: c.putList(['S1.v1']), constraints: c.putList([]), reliesOn: c.putList([]), issues: [], revokes: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [], extends: null },
        obj('B1', ['A']),
        obj('B2', ['A']),
        obj('C', ['B1', 'B2']),
      ],
    });
    const w = pmSay(p.ctx, 'Legalize C. (m2)').words;
    await pmLegalize(p.ctx, { legalization: 'L1', mission: m, endpoint: 'C', words: 'Legalize C.', chainEvidence: [], capabilities: [] });
    await pmStartLegalization(p.ctx, { mission: m, legalization: 'L1', words: w });
    const nodes = (await pmNext(p.ctx)).ready.filter((r) => r.kind === 'auditor-node');
    assert.equal(nodes.length, 2);
    const target = (step: string): string => (dispatchView(p.ctx, pmDispatch(p.ctx, step).dispatch).card as unknown as AuditNodeCard).target.id;
    // B1's dispatches are released until its re-dispatches are used up: an escalation to the Secretary
    const b1 = nodes.find((r) => r.step.includes('.1.'))?.step ?? nodes[0]!.step;
    for (let i = 0; i < 6; i++) {
      const r = (await pmNext(p.ctx)).ready.find((x) => x.step === b1);
      if (r === undefined) break;
      await pmRelease(p.ctx, pmDispatch(p.ctx, r.step).dispatch, 'abandoned');
    }
    const ctx = flowCtx(p.ctx.ports(), m as MissionId);
    const open = (await openEscalations(ctx, 'audit:L1')).map((e) => e.id);
    assert.equal(open.length, 1, JSON.stringify(open));
    // the other node's Auditor negates it: the legalization ends
    const b2 = nodes.find((r) => r.step !== b1)!.step;
    void target;
    await step(p.ctx, 'auditor-node', (card) => ({ positions: (card as AuditNodeCard).positions.map((x) => ({ review: x.review, verdict: 'fail', items: x.bases.map((b) => ({ basis: b.id, met: 'no', reason: 'it does not', evidence: ['file:README.md:1'] })), constraints: x.constraints.map((k) => ({ constraint: k.id, paths: k.paths })) })), findings: ['it drops a field'], summary: 'done' }) as AuditNodeResult);
    void b2;
    const nx = await pmNext(p.ctx);
    assert.equal((await legalizationState(p.ctx.ports(), m as MissionId, 'L1')).result?.outcome, 'not-legalized');
    assert.deepEqual((await openEscalations(ctx, 'audit:L1')).map((e) => e.id), []);
    assert.equal(opOf(p, "SELECT op FROM log WHERE kind = 'flow.event' AND json_extract(record, '$.line') = 'audit:L1' AND json_extract(record, '$.event') = 'result'"), appliedOp(p, open[0]!), 'closed in the result\'s write');
    assert.ok(!nx.ready.some((r) => r.kind === 'secretary'));
    assert.deepEqual(nx.waitingOnUser, []);
    assert.deepEqual((await resolveSubtasks(p.ctx)).blocked, []);
    assert.equal(assertRulingsCarried(p, '#3'), 0);
  });
});
