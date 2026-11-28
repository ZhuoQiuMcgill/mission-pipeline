// 4.4 (G2; review round 2): every option the PM's inbox describes is carried out through the flow that
// owns its escalation, for every kind of escalation that can reach the PM, and the effect its description
// names is checked on the record. A row: the kind, the option, the description it must give (pmOptions,
// the inbox's text; the Secretary card's is the same effect), a scenario that raises the escalation, and
// the effect. The decision is the Secretary's or the user's, through decisionFor, as a PM answer would be.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { flowCtx } from '../src/flow/context.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { EXPLORATION_SETTLED, PLAN_LINE, PM_PLAN_EFFECTIVE, SECRETARY_LINE, type DetailedPlanDoc, type ExplorationSettledBody, type PmPlanDoc, type PmPlanEffectiveBody } from '../src/flow/plandoc.ts';
import { answerByPm, answerEscalation, pmOptions, secretaryOptions, type EscalationBody } from '../src/flow/secretary.ts';
import { recordRepair } from '../src/flow/repair.ts';
import { currentItems, withdrawItem } from '../src/flow/requirements.ts';
import { architect, cal1Pass, cal2Escalate, constructorDone, detailedPlan, drive, feasibilityReturn, happyScript, pmPlan, reviewer, secretary, seedMission, type Script, type ScriptedOutcome } from '../src/flow/scripted.ts';
import { SEED_TEXT } from '../src/flow/scripted.ts';
import { explorationStep } from '../src/flow/exploration/step.ts';
import { explorationState, redefineExploration } from '../src/flow/exploration/flow.ts';
import { advanceLegalization, requestLegalization, startLegalization } from '../src/flow/audit/flow.ts';
import { taskDecisionQuotes, taskReferencePlan } from '../src/seat/cards/dynamic.ts';
import type { DecisionOption, SecretaryCard } from '../src/seat/cards/secretary.ts';
import type { ArchitectDecomposeCard, ArchitectFeasibilityCard } from '../src/seat/cards/architect.ts';
import type { Calibrator1Card, Calibrator2Card } from '../src/seat/cards/calibrator.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import type { BaseRecord, ReviewContract } from '../src/common/records.ts';
import type { FlowEvent, FlowTask } from '../src/flow/ports.ts';
import { dispatchInfo, recordHandback } from '../src/memory/index.ts';
import { claimSecretary, startSecretary } from '../src/memory/resident.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';
import { attack, finding, reviseAll, stabilizeAll, submit } from './flow-exploration-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
const INSTR = 'INSTR: do it this way';

// ---------------------------------------------------------------- shared reads

async function escalations(w: World, mission: MissionId = M): Promise<EscalationBody[]> {
  return (await w.ledger.events<EscalationBody>({ mission, line: SECRETARY_LINE, event: 'escalation' })).map((e) => e.body);
}
async function appliedOf(w: World, id: string, mission: MissionId = M): Promise<{ what?: Record<string, unknown>; by?: string } | undefined> {
  return (await w.ledger.events<{ what?: Record<string, unknown>; by?: string }>({ mission, line: SECRETARY_LINE, event: 'applied' })).find((e) => e.key === id)?.body;
}
async function events<T>(w: World, q: { line?: string; event: string }, mission: MissionId = M) {
  return w.ledger.events<T>({ mission, ...q });
}
function grants(w: World, loop: string): Array<{ lineage: string; loop: string; by: string; extra: number }> {
  return (w.memory.stmt("SELECT record FROM log WHERE kind = 'loop.grant'").all() as { record: string }[]).map((r) => JSON.parse(r.record)).filter((g: { loop: string }) => g.loop === loop);
}
function dispatchesOf(w: World, task: string): number {
  return Number((w.memory.stmt('SELECT COUNT(*) AS n FROM dispatches WHERE task = ?').get(task) as { n: number }).n);
}
/** The description the inbox gives (the Secretary card gives the same effect, where it offers the option). */
function says(e: EscalationBody, o: DecisionOption, re: RegExp): void {
  const pm = pmOptions(e).find((x) => x.id === o)?.outcome;
  assert.ok(pm !== undefined, `${e.source} offers ${o}`);
  assert.match(pm, re, `${e.source}/${o}: ${pm}`);
  const card = secretaryOptions(e, true).find((x) => x.id === o)?.outcome;
  if (card !== undefined) assert.match(card, re, `the Secretary card: ${e.source}/${o}: ${card}`);
  // 4.4 (G1): ask-architect is offered on a Constructor's questions, a Reviewer's needs-decision and a used-up rework loop, and on no other
  // kind; not on a review whose only open standards the Reviewer could not verify (F10's fourth answer, unv.<review>): a question of
  // evidence (what would be needed to verify it), not of design
  const unverifiable = e.id.startsWith('unv.') || (e.facts as { unverifiable?: unknown } | undefined)?.unverifiable !== undefined;
  const asks = e.source === 'constructor-decision' || (e.source === 'reviewer-needs-decision' && !unverifiable) || (e.source === 'loop-exhausted' && (e.facts as { loop?: unknown } | undefined)?.loop === 'rework');
  assert.equal(pmOptions(e).some((x) => x.id === 'ask-architect'), asks, `${e.source} (${e.subject}) offers ask-architect only when it is one of the three kinds, and not on the fourth answer`);
}

// ---------------------------------------------------------------- the decision layer and execution (scripted seats)

async function scripted(mode: 'stable' | 'fast' = 'stable', plan: PmPlanDoc = pmPlan(M)): Promise<{ w: World; engine: FlowEngine }> {
  const w = memoryPorts();
  say(w, SEED_TEXT);
  await seedMission(w, M);
  await submitPmBatch(w, { mission: M, plan, userWords: ['W-1'], mode });
  return { w, engine: new FlowEngine(w) };
}
function withKinds(over: Record<string, Script>, plan?: () => DetailedPlanDoc): Script {
  const base = happyScript(M, plan);
  return (t, s) => (Object.hasOwn(over, t.card.seat) ? (over[t.card.seat] as Script) : base)(t, s);
}
/** The Secretary decides the escalation of `source` with `option`; any other escalation goes to the PM (so nothing else moves). */
function decides(source: string, option: DecisionOption, o: { grantExtra?: number } = {}): Script {
  return (t) => {
    const c = t.card as unknown as SecretaryCard;
    if (c.request.source !== source) return { handBack: secretary(c, c.options.find((x) => x.id === 'ask-pm' || x.id === 'ask-user')?.id ?? c.options[0]!.id) };
    return { handBack: secretary(c, option, { instructions: INSTR, ...(o.grantExtra !== undefined ? { grantExtra: o.grantExtra } : {}) }) };
  };
}
const ofSource = async (w: World, source: string): Promise<EscalationBody> => {
  const e = (await escalations(w)).find((x) => x.source === source);
  assert.ok(e !== undefined, `an escalation of ${source}`);
  return e;
};
/** The re-plan request of a task decision: recorded, and the Architect's next decomposition carries the instructions. */
async function replanned(w: World, esc: EscalationBody, task: string): Promise<void> {
  const req = (await events<{ task: string; instructions: string }>(w, { line: PLAN_LINE, event: 'replan-request' })).find((e) => e.key === esc.id);
  assert.equal(req?.body.task, task);
  assert.equal(req?.body.instructions, INSTR);
  const arch = [...w.scheduler.tasks.keys()].filter((t) => t.startsWith('arch.')).map((t) => w.scheduler.card<ArchitectDecomposeCard>(t));
  assert.ok(arch.some((c) => (c.revision?.instructions ?? []).some((i) => i.includes(INSTR))), 'the Architect re-plans with the instructions');
}

describe('option effects: task escalations', () => {
  const constructorAsks = async (option: DecisionOption) => {
    const { w, engine } = await scripted();
    await drive(engine, w.scheduler, withKinds({
      constructor: (t: FlowTask): ScriptedOutcome | null => ({ handBack: constructorDone(t.task === 'con.m1.impl.1' ? { decisions_needed: ['Should empty lines be skipped?'] } : {}) }),
      secretary: decides('constructor-decision', option),
    }));
    return { w, esc: await ofSource(w, 'constructor-decision') };
  };
  test('constructor-decision / answer', async () => {
    const { w, esc } = await constructorAsks('answer');
    says(esc, 'answer', /the answer is recorded as the decision and goes to the next cards of the work; the work goes on/);
    assert.equal((await appliedOf(w, esc.id))?.what?.['option'], 'answer');
    const evs = await w.ledger.events({ mission: M }) as FlowEvent[];
    const task = detailedPlan(M).tasks.find((t) => t.id === 'impl')!;
    assert.ok(taskDecisionQuotes(await currentItems(flowCtx(w, M)), evs, task, [], taskReferencePlan(evs)).includes(INSTR), 'the next cards of the task quote it');
  });
  test('constructor-decision / replan', async () => {
    const { w, esc } = await constructorAsks('replan');
    says(esc, 'replan', /the task waits while the Architect re-plans it with the instructions/);
    await replanned(w, esc, 'impl');
  });
  // 4.4 (G1): one Architect step; its answer is carried out as the escalation's answer, any other reply comes back
  const architectReplies = (r: Record<string, unknown>): Script => () => ({ handBack: r });
  test('constructor-decision / ask-architect (an answer)', async () => {
    const { w, engine } = await scripted();
    await drive(engine, w.scheduler, withKinds({
      constructor: (t: FlowTask): ScriptedOutcome | null => ({ handBack: constructorDone(t.task === 'con.m1.impl.1' ? { decisions_needed: ['Should empty lines be skipped?'] } : {}) }),
      secretary: decides('constructor-decision', 'ask-architect'),
      'architect-answer': architectReplies({ reply: 'answer', text: 'ARCH: skip them' }),
    }));
    const esc = await ofSource(w, 'constructor-decision');
    says(esc, 'ask-architect', /one Architect step answers the question with your instructions and changes no card, standard or plan; the work waits for it as for any decision; its answer is carried out as this escalation's answer \(a review that waits for it is ready once it is carried out\) and goes to the next cards of the work; when the plan has to change, or the Architect needs to know something first, the escalation returns to the Secretary, with its reply/);
    const arch = [...w.scheduler.tasks.keys()].find((t) => t.startsWith('arch-ask.'))!;
    assert.equal(w.scheduler.card<{ asked: { instructions: string } }>(arch).asked.instructions, INSTR, 'one Architect step, with the instructions');
    const a = await appliedOf(w, esc.id);
    assert.equal(a?.what?.['option'], 'answer');
    assert.equal((a as { architect?: string } | undefined)?.architect, `${esc.id}:s0`);
    assert.ok((await events(w, { line: 'task:impl', event: 'accepted' })).length === 1, 'the review that waited went on');
    const evs = await w.ledger.events({ mission: M }) as FlowEvent[];
    const task = detailedPlan(M).tasks.find((t) => t.id === 'impl')!;
    assert.ok(taskDecisionQuotes(await currentItems(flowCtx(w, M)), evs, task, [], taskReferencePlan(evs)).includes('ARCH: skip them'), 'the next cards of the task quote it');
  });
  test('constructor-decision / ask-architect (the plan has to change: back to the decider)', async () => {
    const { w, engine } = await scripted();
    let rounds = 0;
    await drive(engine, w.scheduler, withKinds({
      constructor: (t: FlowTask): ScriptedOutcome | null => ({ handBack: constructorDone(t.task === 'con.m1.impl.1' ? { decisions_needed: ['Should empty lines be skipped?'] } : {}) }),
      // the first round asks; the round the reply comes back to goes to the PM (nothing else moves)
      secretary: (t, s) => (rounds++ === 0 ? decides('constructor-decision', 'ask-architect')(t, s) : { handBack: secretary(t.card as unknown as SecretaryCard, 'ask-pm') }),
      'architect-answer': architectReplies({ reply: 'plan-must-change', text: 'ARCH: S1 must change', why: 'it is silent' }),
    }));
    const esc = await ofSource(w, 'constructor-decision');
    says(esc, 'ask-architect', /when the plan has to change, or the Architect needs to know something first, the escalation returns to the Secretary, with its reply/);
    const back = (await events<{ why: string }>(w, { line: SECRETARY_LINE, event: 'secretary-retry' })).find((e) => e.key === `${esc.id}#1`);
    assert.match(back?.body.why ?? '', /the plan has to change\. What: ARCH: S1 must change Why: it is silent/);
    assert.equal(await appliedOf(w, esc.id), undefined, 'nothing is carried out');
  });

  const reviewerAsks = async (option: DecisionOption) => {
    const { w, engine } = await scripted();
    let first = true;
    await drive(engine, w.scheduler, withKinds({
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (c.target.includes('impl') && first) { first = false; return { handBack: reviewer(c, 'needs-decision') }; }
        return { handBack: reviewer(c, 'pass') };
      },
      secretary: decides('reviewer-needs-decision', option),
    }));
    return { w, esc: await ofSource(w, 'reviewer-needs-decision') };
  };
  test('reviewer-needs-decision / answer', async () => {
    const { w, esc } = await reviewerAsks('answer');
    says(esc, 'answer', /the answer is recorded as the decision and goes to the next cards of the work/);
    assert.ok((await events(w, { line: 'task:impl', event: 'reanswer' })).length === 1);
    assert.ok(w.scheduler.card<ReviewerCard>('rev.m1.impl.1.r1').decisionQuotes.includes(INSTR), 'the next review of the work quotes it');
  });
  test('reviewer-needs-decision / ask-architect', async () => {
    const { w, engine } = await scripted();
    let first = true;
    await drive(engine, w.scheduler, withKinds({
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (c.target.includes('impl') && first) { first = false; return { handBack: reviewer(c, 'needs-decision') }; }
        return { handBack: reviewer(c, 'pass') };
      },
      secretary: decides('reviewer-needs-decision', 'ask-architect'),
      'architect-answer': architectReplies({ reply: 'answer', text: 'ARCH: S1 means RFC quoting' }),
    }));
    const esc = await ofSource(w, 'reviewer-needs-decision');
    says(esc, 'ask-architect', /one Architect step answers the question with your instructions and changes no card, standard or plan; the work waits for it as for any decision; its answer is carried out as this escalation's answer and goes to the next cards of the work; when the plan has to change/);
    assert.deepEqual((await events<{ decision: string }>(w, { line: 'task:impl', event: 'reanswer' })).map((e) => e.body.decision), ['ARCH: S1 means RFC quoting']);
    assert.ok(w.scheduler.card<ReviewerCard>('rev.m1.impl.1.r1').decisionQuotes.includes('ARCH: S1 means RFC quoting'), 'the next review of the work quotes it');
  });
  test('reviewer-needs-decision / rework', async () => {
    const { w, esc } = await reviewerAsks('rework');
    says(esc, 'rework', /the Constructor reworks the task in a new attempt with the instructions/);
    const rw = (await events<{ k: number; instructions: string[] }>(w, { line: 'task:impl', event: 'rework' })).find((e) => e.key === '2');
    assert.ok(rw?.body.instructions.includes(INSTR));
    assert.ok(w.scheduler.tasks.has('con.m1.impl.2'), 'a new attempt');
  });
  test('reviewer-needs-decision / replan', async () => {
    const { w, esc } = await reviewerAsks('replan');
    says(esc, 'replan', /the task waits while the Architect re-plans it/);
    await replanned(w, esc, 'impl');
  });
  test('reviewer-needs-decision / accept-risk', async () => {
    const { w, esc } = await reviewerAsks('accept-risk');
    says(esc, 'accept-risk', /the work under review is accepted as it is, its unresolved findings recorded as risks/);
    const acc = (await events<{ decision: { option: string }; risks: string[] }>(w, { line: 'task:impl', event: 'accepted' })).at(-1);
    assert.equal(acc?.body.decision.option, 'accept-risk');
    assert.ok((acc?.body.risks.length ?? 0) > 0);
  });

  // 4.4 (F10; review p9-8): a review whose only open standard the Reviewer could not verify (escalation unv.<review>)
  const unverifiedAsks = async (option: DecisionOption) => {
    const { w, engine } = await scripted();
    let first = true;
    await drive(engine, w.scheduler, withKinds({
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        const r = reviewer(c, 'pass');
        if (!(c.target.includes('impl') && first)) return { handBack: r };
        first = false;
        return { handBack: { ...r, verdict: 'needs-decision', judgments: r.judgments.map((j) => (j.standard === 'S2' ? { ...j, met: 'cannot-verify' as const, needed: 'the device log', evidence: [] } : j)) } };
      },
      secretary: decides('reviewer-needs-decision', option),
    }));
    const esc = (await escalations(w)).find((e) => e.id.startsWith('unv.'));
    assert.ok(esc !== undefined, 'the escalation of the fourth answer');
    return { w, esc };
  };
  test('reviewer-needs-decision, cannot be verified / answer', async () => {
    const { w, esc } = await unverifiedAsks('answer');
    says(esc, 'answer', /the answer is recorded as the decision \(say what is missing, or where it is\), and the same candidate is reviewed again with the answer on the Reviewer's card; no new attempt starts/);
    assert.ok((await events(w, { line: 'task:impl', event: 'reanswer' })).length === 1);
    assert.ok(w.scheduler.card<ReviewerCard>('rev.m1.impl.1.r1').decisionQuotes.includes(INSTR), 'the next review of the same candidate quotes it');
    assert.ok(!w.scheduler.tasks.has('con.m1.impl.2'), 'no new attempt');
  });
  test('reviewer-needs-decision, cannot be verified / rework', async () => {
    const { w, esc } = await unverifiedAsks('rework');
    says(esc, 'rework', /the Constructor reworks the task in a new attempt with the instructions/);
    const rw = (await events<{ k: number; instructions: string[] }>(w, { line: 'task:impl', event: 'rework' })).find((e) => e.key === '2');
    assert.ok(rw?.body.instructions.includes(INSTR));
  });
  test('reviewer-needs-decision, cannot be verified / accept-risk', async () => {
    const { w, esc } = await unverifiedAsks('accept-risk');
    says(esc, 'accept-risk', /each standard the Reviewer could not verify is recorded among its risks, with what would be needed/);
    const acc = (await events<{ decision: { option: string }; risks: string[] }>(w, { line: 'task:impl', event: 'accepted' })).at(-1);
    assert.equal(acc?.body.decision.option, 'accept-risk');
    assert.ok(acc?.body.risks.some((x) => x.endsWith('[S2] cannot be verified: checked; needed: the device log')), JSON.stringify(acc?.body.risks));
  });
  test('reviewer-needs-decision, cannot be verified / replan', async () => {
    const { w, esc } = await unverifiedAsks('replan');
    says(esc, 'replan', /the task waits while the Architect re-plans it/);
    await replanned(w, esc, 'impl');
  });

  const reworkExhausted = async (option: DecisionOption) => {
    const { w, engine } = await scripted();
    let reworks = 0;
    let decided = false;
    await drive(engine, w.scheduler, withKinds({
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (c.target.includes('iface') || decided) return { handBack: reviewer(c, 'pass') };
        reworks++;
        return { handBack: reviewer(c, 'rework', { failing: reworks % 2 === 0 ? 'S2' : 'S1' }) };
      },
      secretary: (t, s) => { const c = t.card as unknown as SecretaryCard; if (c.request.source === 'loop-exhausted') decided = true; return decides('loop-exhausted', option, { grantExtra: 1 })(t, s); },
    }));
    return { w, esc: await ofSource(w, 'loop-exhausted') };
  };
  test('loop-exhausted (rework) / grant', async () => {
    const { w, esc } = await reworkExhausted('grant');
    says(esc, 'grant', /the rework loop gets the attempts granted, and the Constructor starts the next attempt/);
    assert.ok(grants(w, 'rework').some((g) => g.lineage === 'task.m1.impl'));
    assert.ok(w.scheduler.tasks.has('con.m1.impl.4'), 'the next attempt');
  });
  test('loop-exhausted (rework) / replan', async () => {
    const { w, esc } = await reworkExhausted('replan');
    says(esc, 'replan', /the task waits while the Architect re-plans it/);
    await replanned(w, esc, 'impl');
  });
  test('loop-exhausted (rework) / accept-risk', async () => {
    const { w, esc } = await reworkExhausted('accept-risk');
    says(esc, 'accept-risk', /accepted as it is, its unresolved findings recorded as risks/);
    const acc = (await events<{ decision: { option: string }; risks: string[] }>(w, { line: 'task:impl', event: 'accepted' })).at(-1);
    assert.equal(acc?.body.decision.option, 'accept-risk');
  });
  test('loop-exhausted (rework) / ask-architect', async () => {
    const { w, engine } = await scripted();
    let reworks = 0;
    let round = 0;
    await drive(engine, w.scheduler, withKinds({
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (c.target.includes('iface')) return { handBack: reviewer(c, 'pass') };
        reworks++;
        return { handBack: reviewer(c, 'rework', { failing: reworks % 2 === 0 ? 'S2' : 'S1' }) };
      },
      // the first round asks; the round the reply comes back to goes to the PM (nothing else moves)
      secretary: (t, s) => { const c = t.card as unknown as SecretaryCard; if (c.request.source !== 'loop-exhausted') return null; return round++ === 0 ? decides('loop-exhausted', 'ask-architect')(t, s) : { handBack: secretary(c, 'ask-pm') }; },
      'architect-answer': architectReplies({ reply: 'answer', text: 'ARCH: both standards hold with RFC quoting' }),
    }));
    const esc = await ofSource(w, 'loop-exhausted');
    says(esc, 'ask-architect', /one Architect step answers the question with your instructions and changes no card, standard or plan; the work waits for it as for any decision; every reply \(an answer, "the plan has to change", or a question\) is recorded on this escalation and returns it to the Secretary, and a grant then carries an answer to the next attempt's cards/);
    const reply = (await events<{ reply: string; moot?: string }>(w, { line: SECRETARY_LINE, event: 'architect-answer' })).find((e) => e.key === `${esc.id}:s0`);
    assert.equal(reply?.body.reply, 'answer', 'recorded on this escalation');
    const back = (await events<{ why: string }>(w, { line: SECRETARY_LINE, event: 'secretary-retry' })).find((e) => e.key === `${esc.id}#1`);
    assert.match(back?.body.why ?? '', /answered: ARCH: both standards hold with RFC quoting A grant carries this answer to the next attempt/, 'it returns to the Secretary');
    assert.equal(await appliedOf(w, esc.id), undefined, 'nothing is carried out by the reply itself');
    // the grant that follows carries it to the next attempt's cards, the Constructor's and the Reviewer's
    await answerByPm(w, { mission: M, escalation: esc.id, option: 'grant', words: [], noWords: true, reason: 'one more attempt', grantExtra: 1 });
    await drive(engine, w.scheduler, withKinds({ reviewer: (t) => ({ handBack: reviewer(t.card as unknown as ReviewerCard, 'pass') }), secretary: () => null }));
    const con = [...w.scheduler.tasks.keys()].filter((t) => t.startsWith('con.m1.impl.')).at(-1)!;
    const rev = [...w.scheduler.tasks.keys()].filter((t) => t.startsWith('rev.m1.impl.')).at(-1)!;
    assert.ok(w.scheduler.card<{ decisionQuotes: string[] }>(con).decisionQuotes.includes('ARCH: both standards hold with RFC quoting'));
    assert.ok(w.scheduler.card<ReviewerCard>(rev).decisionQuotes.includes('ARCH: both standards hold with RFC quoting'));
  });
  test('loop-exhausted (rework) / abandon', async () => {
    const { w, esc } = await reworkExhausted('abandon');
    says(esc, 'abandon', /the escalated work is given up and recorded; .*the rest of the mission goes on/);
    assert.equal((await events(w, { line: 'task:impl', event: 'abandoned' })).length, 1);
    assert.ok((await events(w, { line: 'task:iface', event: 'accepted' })).length > 0, 'the rest goes on');
  });

  const withdrawn = async (option: DecisionOption) => {
    const { w, engine } = await scripted('fast');
    await drive(engine, w.scheduler, happyScript(M));
    await withdrawItem(w, { mission: M, item: 's1', reason: 'the user no longer wants tests' });
    await drive(engine, w.scheduler, withKinds({ secretary: decides('replan', option) }));
    return { w, esc: await ofSource(w, 'replan') };
  };
  test('replan (a basis withdrawn) / accept', async () => {
    const { w, esc } = await withdrawn('accept');
    says(esc, 'accept', /the item under question is accepted as it is .*the work goes on/);
    assert.equal((await appliedOf(w, esc.id))?.what?.['option'], 'accept');
    assert.equal(w.scheduler.tasks.has('con.m1.impl.2'), false, 'the accepted product stays as it is');
  });
  test('replan (a basis withdrawn) / replan', async () => {
    const { w, esc } = await withdrawn('replan');
    says(esc, 'replan', /the task waits while the Architect re-plans it/);
    await replanned(w, esc, 'impl');
  });
  test('replan (a basis withdrawn) / abandon', async () => {
    const { w, esc } = await withdrawn('abandon');
    says(esc, 'abandon', /given up and recorded/);
    assert.equal((await events(w, { line: 'task:impl', event: 'abandoned' })).length, 1);
  });

  const usedUp = async (option: DecisionOption) => {
    const { w, engine } = await scripted();
    let releases = 0;
    await drive(engine, w.scheduler, withKinds({
      constructor: (t: FlowTask): ScriptedOutcome | null => (t.task === 'con.m1.iface.1' && releases++ < 3 ? { release: 'abandoned' } : { handBack: constructorDone() }),
      secretary: decides('loop-exhausted', option, { grantExtra: 1 }),
    }));
    return { w, esc: await ofSource(w, 'loop-exhausted') };
  };
  test('loop-exhausted (re-dispatches of a task) / grant', async () => {
    const { w, esc } = await usedUp('grant');
    says(esc, 'grant', /the step may be dispatched again: its re-dispatches get the attempts granted/);
    assert.ok(grants(w, 'quarantine-restart').some((g) => g.lineage === 'task.m1.iface'));
    assert.equal(dispatchesOf(w, 'con.m1.iface.1'), 4, 'dispatched again after the grant');
  });
  test('loop-exhausted (re-dispatches of a task) / replan', async () => {
    const { w, esc } = await usedUp('replan');
    says(esc, 'replan', /the task waits while the Architect re-plans it/);
    await replanned(w, esc, 'iface');
  });
  test('loop-exhausted (re-dispatches of a task) / abandon', async () => {
    const { w, esc } = await usedUp('abandon');
    says(esc, 'abandon', /given up and recorded/);
    assert.equal((await events(w, { line: 'task:iface', event: 'abandoned' })).length, 1);
  });

  // a hand-back the program cannot read (needs-disposition with no stop): restart, re-plan or abandon (failures.ts)
  const unusable = async (option: DecisionOption) => {
    const { w, engine } = await scripted();
    await drive(engine, w.scheduler, withKinds({ constructor: (t: FlowTask): ScriptedOutcome | null => (t.task === 'con.m1.iface.1' ? null : { handBack: constructorDone() }) }));
    const d = w.scheduler.dispatchOf('con.m1.iface.1');
    w.memory.write({ op: `unusable:${d}`, payload: d }, (tx) => recordHandback(tx, { dispatch: d, report: 'done', result: { format: 'not-a-handback' } as never }));
    assert.equal(w.memory.read((db) => dispatchInfo(db, d))?.handback, 'accepted');
    let once = false;
    await drive(engine, w.scheduler, withKinds({
      constructor: (t: FlowTask): ScriptedOutcome | null => (t.task === 'con.m1.iface.1' && once ? null : (once = true, { handBack: constructorDone() })),
      secretary: decides('needs-disposition', option),
    }));
    return { w, esc: await ofSource(w, 'needs-disposition') };
  };
  test('needs-disposition (a task hand-back not usable) / restart', async () => {
    const { w, esc } = await unusable('restart');
    says(esc, 'restart', /the step is not restarted as it is \(only a hand-back that came after a stop can be\): the question comes back to the PM with that reason/);
    const toUser = (await events<{ why: string }>(w, { line: SECRETARY_LINE, event: 'to-user' })).find((e) => e.key === esc.id);
    assert.match(toUser?.body.why ?? '', /cannot be restarted as it is/, 'the question comes back to the PM with the reason');
    assert.equal(dispatchesOf(w, 'con.m1.iface.1'), 1, 'not dispatched again');
  });
  test('needs-disposition (a task hand-back not usable) / replan', async () => {
    const { w, esc } = await unusable('replan');
    says(esc, 'replan', /the task waits while the Architect re-plans it/);
    await replanned(w, esc, 'iface');
  });
  test('needs-disposition (a task hand-back not usable) / abandon', async () => {
    const { w, esc } = await unusable('abandon');
    says(esc, 'abandon', /given up and recorded/);
    assert.equal((await events(w, { line: 'task:iface', event: 'abandoned' })).length, 1);
  });
});

describe('option effects: plan escalations', () => {
  const effective = async (w: World) => (await events<{ dplan: string }>(w, { line: PLAN_LINE, event: 'effective' })).map((e) => e.body.dplan);
  const archInstructions = (w: World, task: string) => w.scheduler.card<ArchitectDecomposeCard>(task).revision?.instructions ?? [];

  const orderChange = async (option: DecisionOption) => {
    const { w, engine } = await scripted('stable', pmPlan(M, { order: 'user' }));
    const swapped = detailedPlan(M);
    const plan: DetailedPlanDoc = { ...swapped, tasks: swapped.tasks.map((t) => (t.id === 'iface' ? { ...t, provenance: { planElements: ['e2'] } } : { ...t, provenance: { planElements: ['e1'] } })) };
    let decomposed = 0;
    // a revision sent back comes in the user's order
    await drive(engine, w.scheduler, withKinds({ 'architect-decompose': () => ({ handBack: architect(decomposed++ === 0 ? plan : detailedPlan(M)) }), secretary: decides('order-change', option) }));
    return { w, esc: await ofSource(w, 'order-change') };
  };
  test('order-change / accept', async () => {
    const { w, esc } = await orderChange('accept');
    says(esc, 'accept', /the changed order stands, and the plan goes on to its remaining checks/);
    assert.equal(w.scheduler.tasks.has('arch.m1.1.2'), false, 'not returned to the Architect');
    assert.ok(w.scheduler.tasks.has('feas.dplan.m1.1.1'), 'its remaining check ran');
    assert.deepEqual(await effective(w), ['dplan.m1.1.1']);
  });
  test('order-change / send-back', async () => {
    const { w, esc } = await orderChange('send-back');
    says(esc, 'send-back', /the Architect revises the plan with the instructions/);
    assert.ok(archInstructions(w, 'arch.m1.1.2').includes(INSTR));
  });

  const feasibility = async (option: DecisionOption) => {
    const { w, engine } = await scripted('stable');
    let returns = 0;
    await drive(engine, w.scheduler, withKinds({
      'architect-feasibility': (t) => (returns++ < 2 ? { handBack: feasibilityReturn(t.card as unknown as ArchitectFeasibilityCard, 'the parser buffers whole files') } : { handBack: { findings: [], criticalPath: [], verdict: 'feasible' } }),
      secretary: decides('feasibility-unresolved', option),
    }));
    return { w, esc: await ofSource(w, 'feasibility-unresolved') };
  };
  test('feasibility-unresolved / accept-risk', async () => {
    const { w, esc } = await feasibility('accept-risk');
    says(esc, 'accept-risk', /the blocking findings are accepted as the plan's risks, and the plan goes on to its remaining checks/);
    assert.ok(((await appliedOf(w, esc.id))?.what?.['risks'] as unknown[] | undefined)?.length);
    assert.ok([...w.scheduler.tasks.keys()].some((t) => t.startsWith('cal2.')), 'its remaining check ran');
    assert.deepEqual(await effective(w), ['dplan.m1.1.2']);
  });
  test('feasibility-unresolved / send-back', async () => {
    const { w, esc } = await feasibility('send-back');
    says(esc, 'send-back', /the Architect revises the plan with the instructions; this takes one more feasibility return on the lineage/);
    assert.ok(grants(w, 'feasibility-return').length === 1, 'one more feasibility return, granted');
    assert.ok(archInstructions(w, 'arch.m1.1.3').includes(INSTR));
  });

  const cal2 = async (option: DecisionOption) => {
    const { w, engine } = await scripted('stable');
    let escalated = false;
    await drive(engine, w.scheduler, withKinds({
      'calibrator-2': (t) => { const c = t.card as unknown as Calibrator2Card; if (escalated) return null; escalated = true; return { handBack: cal2Escalate(c, 'the layout fixes a file format') }; },
      secretary: decides('calibrator-2', option),
    }));
    return { w, esc: await ofSource(w, 'calibrator-2') };
  };
  test('calibrator-2 / accept', async () => {
    const { w, esc } = await cal2('accept');
    says(esc, 'accept', /the detailed plan is accepted as it is \(the ruling overrules Calibrator ②\) and takes effect/);
    assert.deepEqual(await effective(w), ['dplan.m1.1.1']);
  });
  test('calibrator-2 / send-back', async () => {
    const { w, esc } = await cal2('send-back');
    says(esc, 'send-back', /the Architect revises the plan with the instructions/);
    assert.ok(archInstructions(w, 'arch.m1.1.2').includes(INSTR));
  });

  test('loop-exhausted (mechanical returns of a plan) / grant', async () => {
    const { w, engine } = await scripted();
    const good = detailedPlan(M);
    const bad = detailedPlan(M, { implProvenance: 'e1' });
    let attempt = 0;
    // the same failure twice in a row is no progress: the loop is used up after two
    await drive(engine, w.scheduler, withKinds({ 'architect-decompose': () => ({ handBack: architect(attempt++ < 2 ? bad : good) }), secretary: decides('loop-exhausted', 'grant', { grantExtra: 1 }) }));
    const esc = await ofSource(w, 'loop-exhausted');
    says(esc, 'grant', /the Architect gets the returns granted and decomposes again/);
    assert.ok(grants(w, 'mechanical-return').length === 1);
    assert.equal(attempt, 3, 'the Architect decomposed again after the grant');
    assert.equal((await effective(w)).length, 1);
  });

  test('loop-exhausted (re-dispatches of a decision-layer seat) / grant', async () => {
    const { w, engine } = await scripted();
    let releases = 0;
    await drive(engine, w.scheduler, withKinds({ 'calibrator-1': (t) => (releases++ < 3 ? { release: 'abandoned' } : { handBack: cal1Pass(t.card as unknown as Calibrator1Card) }), secretary: decides('loop-exhausted', 'grant', { grantExtra: 1 }) }));
    const esc = await ofSource(w, 'loop-exhausted');
    says(esc, 'grant', /the step may be dispatched again: its re-dispatches get the attempts granted/);
    assert.equal(dispatchesOf(w, 'cal1.m1.1'), 4);
    assert.ok(grants(w, 'quarantine-restart').length === 1);
  });

  // a revised detailed plan with a structural difference waits for the PM or the user (approve / send-back)
  const structure = async (option: DecisionOption) => {
    const { w } = await scripted('fast');
    // a structural difference waits for the PM only while a Secretary is live (planning.ts): the world runs as that Secretary
    const g = startSecretary(w.memory, { name: 'p-Secretary', op: 'start' });
    claimSecretary(w.memory, g.generation, { op: 'session', filler: null });
    w.ctx.secretary = g.generation;
    const engine = new FlowEngine({ ...w, resident: () => true });
    let decomposed = 0;
    let reworks = 0;
    // the added integration task is held: its effect here is the plan's, not its work
    const holdDocs = (t: FlowTask): ScriptedOutcome | null => (t.task.startsWith('con.m1.docs') ? null : { handBack: constructorDone() });
    await drive(engine, w.scheduler, withKinds({
      'architect-decompose': () => ({ handBack: architect(decomposed++ === 0 ? detailedPlan(M) : detailedPlan(M, { extraTask: true })) }),
      constructor: holdDocs,
      reviewer: (t) => { const c = t.card as unknown as ReviewerCard; if (c.target.includes('iface') || decomposed > 1) return { handBack: reviewer(c, 'pass') }; reworks++; return { handBack: reviewer(c, 'rework', { failing: reworks % 2 === 0 ? 'S2' : 'S1' }) }; },
      secretary: decides('loop-exhausted', 'replan'),
    }));
    const esc = await ofSource(w, 'plan-structure-change');
    await answerEscalation(w, { mission: M, escalation: esc.id, option, ...(option === 'send-back' ? { instructions: INSTR } : {}), words: 'the user agrees (W-1)' });
    await drive(engine, w.scheduler, withKinds({ 'architect-decompose': () => ({ handBack: architect(detailedPlan(M, { extraTask: true })) }), constructor: holdDocs }));
    return { w, esc };
  };
  test('plan-structure-change / approve', async () => {
    const { w, esc } = await structure('approve');
    says(esc, 'approve', /the revision may take effect after its required checks/);
    assert.equal((await appliedOf(w, esc.id))?.what?.['option'], 'approve');
    assert.ok((await effective(w)).includes(String(esc.facts !== undefined ? (esc.facts as { dplan: string }).dplan : '')), 'the revision took effect');
  });
  test('plan-structure-change / send-back', async () => {
    const { w, esc } = await structure('send-back');
    says(esc, 'send-back', /the Architect revises the plan with the instructions/);
    const arch = [...w.scheduler.tasks.keys()].filter((t) => t.startsWith('arch.')).map((t) => archInstructions(w, t));
    assert.ok(arch.some((i) => i.includes(INSTR)));
  });

  test('loop-exhausted (mechanical returns of a repair) / grant', async () => {
    const { w, engine } = await scripted('fast');
    await drive(engine, w.scheduler, happyScript(M));
    const words = say(w, 'Please also handle tab separators.');
    await recordRepair(w, { mission: M, words, kind: 'missing', text: 'Please also handle tab separators.', about: { kind: 'task', id: 'impl' } });
    const bad = { ...detailedPlan(M).tasks[1]!, id: 'tabs', writeScope: [], dependsOn: ['impl'] };
    const good = { ...detailedPlan(M).tasks[1]!, id: 'tabs', writeScope: ['src/parser/tabs/**'], dependsOn: ['impl'] };
    let attempt = 0;
    await drive(engine, w.scheduler, withKinds({ 'architect-repair': () => ({ handBack: { add: [attempt++ < 2 ? bad : good], change: [], reopen: [], note: 'tabs' } }), secretary: decides('loop-exhausted', 'grant', { grantExtra: 1 }) }));
    const esc = await ofSource(w, 'loop-exhausted');
    assert.ok(esc.subject.startsWith('repair:'));
    says(esc, 'grant', /the repair's Architect gets the returns granted and amends the plan again/);
    assert.ok(grants(w, 'mechanical-return').length === 1);
    assert.equal(attempt, 3, 'the repair\'s Architect amended again after the grant');
  });
});

// ---------------------------------------------------------------- explorations (exploration/step.ts, in the flow engine's step)

async function planned(rounds: number, o: { type?: 'direction' | 'structure'; research?: boolean } = {}) {
  const w = memoryPorts();
  const ports = { ledger: w.ledger, scheduler: w.scheduler, evaluator: w.evaluator };
  const X = 'M1' as MissionId;
  const doc: PmPlanDoc = {
    format: 'mp4.pm-plan.v1', mission: X, round: 1, order: 'free', goalsBeyond: [], authorizations: [],
    elements: [{ id: 'el1', kind: 'exploration', text: 'how the scheduler hands evidence back', provenance: { by: 'user', words: 'W-1', quote: 'figure out the evidence hand-back' }, after: [], items: [],
      exploration: { id: 'X1', deliverable: o.research === true ? 'the answer: does the lock survive a crash?' : 'a design of the evidence hand-back', fuzzyGoal: { quote: 'no obvious hole', words: 'W-1' }, attackScope: ['gets stuck', 'internal contradiction'], decision: { id: 'D1', type: o.type ?? 'structure' }, budget: { rounds, micros: null }, stop: '', research: o.research === true } }],
  };
  const body: PmPlanEffectiveBody = { plan: 'pmplan.1', batch: 'b1', round: 1, doc: w.ledger.content.put(JSON.stringify(doc)), explorations: ['X1'] };
  await w.ledger.append('pm-effective', { events: [{ mission: X, line: PLAN_LINE, event: PM_PLAN_EFFECTIVE, key: 'pmplan.1', body }] });
  const step = async (): Promise<void> => { for (let i = 0; i < 20; i++) { const ctx = flowCtx(ports, X); await explorationStep(ctx); if (!ctx.progressed) break; } };
  const one = (kind: string) => { const q = w.scheduler.queued(kind); assert.equal(q.length, 1, `one queued ${kind}: ${q.map((t) => t.task).join(', ')}`); return q[0]!; };
  const hand = async (kind: string, r: unknown, stabilize: (c: StabilizerCard) => unknown = (c) => stabilizeAll(c)) => {
    const t = one(kind);
    assert.deepEqual(await w.scheduler.run(t.task, { handBack: r }), []);
    if (kind === 'researcher-author' || kind === 'crititor') {
      await step();
      const st = w.scheduler.queued('stabilizer')[0];
      if (st !== undefined) assert.deepEqual(await w.scheduler.run(st.task, { handBack: stabilize(st.card as unknown as StabilizerCard) }), []);
    }
    return t;
  };
  const escs = async () => escalations(w, X);
  const settled = async () => (await w.ledger.events<ExplorationSettledBody>({ mission: X, line: 'exploration:X1', event: EXPLORATION_SETTLED })).map((e) => e.body);
  const state = () => explorationState(ports, X, 'X1');
  return { w, ports, X, step, one, hand, escs, settled, state };
}
type Planned = Awaited<ReturnType<typeof planned>>;
const ATTEMPTS = [{ id: 'A1', kind: 'experiment' as const, purpose: 'does the lock survive a crash', steps: ['run crash.sh 20 times'], data: '', measure: ['survivals'], assertions: ['all 20 survive'] }];

describe('option effects: exploration escalations', () => {
  /** One round, a finding of `severity`: the budget stops the exploration (an escalation of exploration-budget). */
  const budgetStop = async (severity: 'serious' | 'general', o: { research?: boolean } = {}): Promise<{ x: Planned; esc: EscalationBody }> => {
    const x = await planned(1, o);
    await x.step();
    await x.hand('researcher-author', submit('v1', [], o.research === true ? { attempts: ATTEMPTS } : {}));
    await x.step();
    await x.hand('crititor', attack([finding(severity, 'gets stuck', 'waits forever')]));
    await x.step();
    await x.hand('researcher-author', submit('v2', reviseAll(x.one('researcher-author').card as unknown as AuthorCard), o.research === true ? { attempts: ATTEMPTS } : {}));
    await x.step();
    const esc = (await x.escs()).find((e) => e.source === 'exploration-budget');
    assert.ok(esc, 'the budget stop is escalated');
    return { x, esc };
  };
  const answer = async (x: Planned, esc: EscalationBody, option: DecisionOption, o: { grantExtra?: number } = {}) => {
    await answerEscalation(x.w, { mission: x.X, escalation: esc.id, option, instructions: INSTR, ...(o.grantExtra !== undefined ? { grantExtra: o.grantExtra } : {}), words: 'the user said so (W-1)' });
    await x.step();
  };

  test('exploration-budget (stop) / grant: the PM must name the rounds; the user\'s answer without them grants 2', async () => {
    const { x, esc } = await budgetStop('serious');
    says(esc, 'grant', /the exploration gets the rounds granted; the instructions and the findings named go to the next round/);
    assert.match(pmOptions(esc).find((o) => o.id === 'grant')!.outcome, /the PM names the number with --extra \(required\), a user's answer without --extra grants 2/);
    await assert.rejects(answerByPm(x.ports, { mission: x.X, escalation: esc.id, option: 'grant', words: [], noWords: true, reason: 'continue' }), /grant requires a positive --extra/);
    await answer(x, esc, 'grant');
    const s = await x.state();
    assert.ok(s.rulings.some((r) => r.decision === 'extend' && r.extraRounds === 2 && r.instructions === INSTR), 'two more rounds, with the instructions');
  });
  test('exploration-budget (stop) / accept-risk', async () => {
    const { x, esc } = await budgetStop('serious');
    says(esc, 'accept-risk', /the unresolved fatal and serious findings become residual risks and the exploration settles on the version the stop names/);
    await answer(x, esc, 'accept-risk');
    const s = (await x.settled())[0];
    assert.equal(s?.outcome, 'conclusion');
    assert.ok(s?.unresolved.some((u) => u.includes('residual risk')));
  });
  /** The same class of fatal finding not fixed twice, with rounds left: a stop that offers send-back (exploration-repeated-fatal). */
  const fatalStop = async (): Promise<{ x: Planned; esc: EscalationBody }> => {
    const x = await planned(10);
    await x.step();
    await x.hand('researcher-author', submit('v1'));
    await x.step();
    await x.hand('crititor', attack([finding('fatal', 'cannot be implemented', 'needs global time')]));
    for (let i = 2; i <= 3; i++) {
      await x.step();
      await x.hand('researcher-author', submit(`v${i}`, reviseAll(x.one('researcher-author').card as unknown as AuthorCard)));
      await x.step();
      await x.hand('crititor', attack([], (x.one('crititor').card as unknown as CrititorCard).priorFindings.filter((f) => f.status === 'awaiting-recheck').map((f) => ({ finding: f.id, resolved: 'no' as const, reason: 'still there', evidence: [] }))));
    }
    await x.step();
    await x.hand('researcher-author', submit('v4', reviseAll(x.one('researcher-author').card as unknown as AuthorCard)));
    await x.step();
    const esc = (await x.escs()).find((e) => e.source === 'exploration-repeated-fatal');
    assert.ok(esc, 'the fatal-repeat stop is escalated');
    return { x, esc };
  };
  test('exploration-repeated-fatal (stop, rounds left) / send-back', async () => {
    const { x, esc } = await fatalStop();
    says(esc, 'send-back', /the exploration goes on in the direction the instructions give, within the rounds left \(none is added\)/);
    const before = await x.state();
    await answer(x, esc, 'send-back');
    const s = await x.state();
    assert.ok(s.rulings.some((r) => r.decision === 'redirect' && r.text === INSTR && r.extraRounds === 0));
    assert.equal(s.def?.budget.rounds, before.def?.budget.rounds, 'no round is added');
    assert.equal(s.stopped, null, 'it goes on');
    assert.equal((await x.settled()).length, 0);
  });
  for (const option of ['replan', 'abandon'] as const) {
    test(`exploration-budget (stop) / ${option}`, async () => {
      const { x, esc } = await budgetStop('serious');
      says(esc, option, /^the exploration ends without a conclusion$/);
      await answer(x, esc, option);
      assert.equal((await x.settled())[0]?.outcome, 'no-conclusion');
    });
  }
  /**
   * A stop that offers plain accept: nothing fatal or serious is left (p413-exploration-end, E-1). The
   * definition changes while the attacker works, so its round is judged under the older one and a general
   * finding is all that is open when the budget ends.
   */
  const clearStop = async (research: boolean): Promise<{ x: Planned; esc: EscalationBody }> => {
    const x = await planned(1, { research });
    await x.step();
    assert.deepEqual(await x.w.scheduler.run(x.one('researcher-author').task, { handBack: submit('v1', [], research ? { attempts: ATTEMPTS } : {}) }), []);
    await x.step();
    const t = x.one('crititor');
    x.w.scheduler.dispatchOf(t.task);
    const def = (await x.state()).def!;
    await redefineExploration(x.ports, { ...def, goal: `${def.goal}, and every rule has its source` });
    assert.deepEqual(await x.w.scheduler.run(t.task, { handBack: attack([finding('general', 'gets stuck', 'a qualification without its source')]) }), []);
    await x.step();
    assert.deepEqual(await x.w.scheduler.run(x.one('stabilizer').task, { handBack: stabilizeAll(x.one('stabilizer').card as unknown as StabilizerCard) }), []);
    await x.step();
    const esc = (await x.escs()).find((e) => e.source === 'exploration-budget');
    assert.ok(esc !== undefined && esc.options.includes('accept'), `plain accept offered: ${JSON.stringify(esc?.options)}`);
    return { x, esc };
  };
  test('exploration-budget (stop, nothing serious left) / accept: a final version settles the exploration as converged', async () => {
    const { x, esc } = await clearStop(false);
    says(esc, 'accept', /the latest version is accepted as it is, with no risk list: a final version settles the exploration as converged, an accepted research method goes on to its registered attempts/);
    await answer(x, esc, 'accept');
    const s = (await x.settled())[0];
    assert.deepEqual([s?.outcome, s?.stop], ['conclusion', 'converged']);
    assert.equal(s?.unresolved.filter((u) => u.includes('residual risk')).length, 0, 'no risk list');
  });
  test('exploration-budget (stop, nothing serious left) / accept: an accepted research method goes on to its registered attempts', async () => {
    const { x, esc } = await clearStop(true);
    says(esc, 'accept', /an accepted research method goes on to its registered attempts/);
    await answer(x, esc, 'accept');
    assert.equal((await x.settled()).length, 0, 'not settled');
    assert.equal((await x.state()).phase, 'attempts');
    assert.equal((x.one('constructor-experiment').card['evidence'] as { attempt?: string }).attempt, 'A1', 'the registered attempt runs');
  });

  /** A serious finding the author escalates as a direction question. */
  const escalatedFinding = async () => {
    const x = await planned(6, { type: 'direction' });
    await x.step();
    await x.hand('researcher-author', submit('v1'));
    await x.step();
    await x.hand('crititor', attack([finding('serious', 'internal contradiction', 'server or not')]));
    await x.step();
    const a = x.one('researcher-author').card as unknown as AuthorCard;
    await x.hand('researcher-author', submit('', [{ finding: a.openFindings[0]!.id, action: 'escalate', note: 'local only?', question: 'May it run a local server?' }]));
    await x.step();
    const esc = (await x.escs()).find((e) => e.source === 'exploration-direction')!;
    return { x, esc, finding: a.openFindings[0]!.id };
  };
  for (const option of ['answer', 'send-back'] as const) {
    test(`exploration-direction (an escalated finding) / ${option}`, async () => {
      const { x, esc, finding: f } = await escalatedFinding();
      says(esc, option, option === 'answer' ? /the answer redirects the next round on this finding/ : /the next round is redirected on this finding as the instructions say/);
      await answer(x, esc, option);
      assert.ok((await x.state()).rulings.some((r) => r.decision === 'redirect' && r.findings.includes(f) && r.text === INSTR));
      assert.equal((x.one('researcher-author').card as unknown as AuthorCard).openFindings[0]?.ruling, INSTR);
    });
  }
  test('exploration-direction (an escalated finding) / accept-risk', async () => {
    const { x, esc, finding: f } = await escalatedFinding();
    says(esc, 'accept-risk', /the finding is accepted as a residual risk; the exploration goes on/);
    await answer(x, esc, 'accept-risk');
    assert.ok((await x.state()).rulings.some((r) => r.decision === 'accept-risk' && r.findings.includes(f)));
    assert.equal((await x.settled()).length, 0, 'the exploration goes on');
  });

  test('exploration-direction (the author\'s own question) / answer', async () => {
    const x = await planned(6);
    await x.step();
    await x.hand('researcher-author', submit('v1', [], { directionQuestions: ['May it use a server?'] }));
    await x.step();
    const esc = (await x.escs()).find((e) => e.source === 'exploration-direction')!;
    says(esc, 'answer', /the answer goes to the author and the attacker; the exploration goes on/);
    await answer(x, esc, 'answer');
    assert.ok((await x.state()).rulings.some((r) => r.decision === 'answer' && r.text === INSTR));
  });

  /** The Stabilizer judges a finding to shift the direction. */
  const shifted = async () => {
    const x = await planned(6);
    await x.step();
    await x.hand('researcher-author', submit('v1'));
    await x.step();
    await x.hand('crititor', attack([finding('serious', 'internal contradiction', 'server or not')]));
    await x.step();
    await x.hand('researcher-author', submit('v2', reviseAll(x.one('researcher-author').card as unknown as AuthorCard)), (c) => stabilizeAll(c, 'shifts-direction'));
    await x.step();
    const esc = (await x.escs()).find((e) => e.source === 'exploration-direction')!;
    assert.ok(esc, 'the direction question is escalated');
    return { x, esc };
  };
  test('exploration-direction (the Stabilizer\'s direction question) / answer', async () => {
    const { x, esc } = await shifted();
    says(esc, 'answer', /the direction stays as defined; the answer goes to the next round/);
    await answer(x, esc, 'answer');
    assert.ok((await x.state()).rulings.some((r) => r.decision === 'keep-direction' && r.text === INSTR));
  });
  test('exploration-direction (the Stabilizer\'s direction question) / send-back', async () => {
    const { x, esc } = await shifted();
    says(esc, 'send-back', /the direction changes as the instructions say; the next round follows them/);
    await answer(x, esc, 'send-back');
    assert.ok((await x.state()).rulings.some((r) => r.decision === 'redirect' && r.text === INSTR));
  });
  test('exploration-direction (the Stabilizer\'s direction question) / abandon', async () => {
    const { x, esc } = await shifted();
    says(esc, 'abandon', /^the exploration ends without a conclusion$/);
    await answer(x, esc, 'abandon');
    assert.equal((await x.settled())[0]?.outcome, 'no-conclusion');
  });

  /** An attacker's turn whose seat task was given up (WI-28). */
  const givenUpTurn = async () => {
    const x = await planned(6);
    await x.step();
    await x.hand('researcher-author', submit('v1'));
    await x.step();
    const t = x.one('crititor');
    await x.w.scheduler.run(t.task, { release: 'ended' });
    await x.step();
    await x.w.scheduler.cancel(t.task);
    await x.step();
    const esc = (await x.escs()).find((e) => e.source === 'needs-disposition')!;
    assert.ok(esc, 'the given-up turn is escalated');
    return { x, esc, task: t.task };
  };
  test('needs-disposition (an exploration turn given up) / restart', async () => {
    const { x, esc, task } = await givenUpTurn();
    says(esc, 'restart', /the given-up turn runs again/);
    await answer(x, esc, 'restart');
    assert.notEqual(x.one('crititor').task, task, 'the turn runs again');
  });
  test('needs-disposition (an exploration turn given up) / abandon', async () => {
    const { x, esc } = await givenUpTurn();
    says(esc, 'abandon', /^the exploration ends without a conclusion$/);
    await answer(x, esc, 'abandon');
    assert.equal((await x.settled())[0]?.outcome, 'no-conclusion');
  });

  /** An exploration seat task whose re-dispatches are used up (failures.ts). */
  const usedUpSeat = async (evidence: boolean) => {
    const x = await planned(6);
    await x.step();
    await x.hand('researcher-author', submit('v1'));
    await x.step();
    let task = x.one('crititor').task;
    if (evidence) {
      await x.w.scheduler.run(task, { evidence: { steps: ['run it'], data: '', measure: ['x'], assertions: [] }, notes: 'notes' });
      await x.step();
      task = x.one('constructor-experiment').task;
    }
    for (let i = 0; i < 3; i++) { await x.w.scheduler.run(task, { release: 'abandoned' }); await x.step(); }
    const esc = (await x.escs()).find((e) => e.source === 'loop-exhausted')!;
    return { x, esc, task };
  };
  test('loop-exhausted (re-dispatches of an exploration seat) / grant', async () => {
    const { x, esc, task } = await usedUpSeat(false);
    says(esc, 'grant', /the step may be dispatched again: its re-dispatches get the attempts granted/);
    await answer(x, esc, 'grant', { grantExtra: 1 });
    assert.equal(x.one('crititor').task, task, 'dispatched again');
  });
  test('loop-exhausted (re-dispatches of an exploration seat) / abandon: a turn ends the exploration without a conclusion', async () => {
    const { x, esc } = await usedUpSeat(false);
    says(esc, 'abandon', /a turn given up ends the exploration without a conclusion/);
    await answer(x, esc, 'abandon');
    assert.equal((await x.settled())[0]?.outcome, 'no-conclusion');
  });
  test('loop-exhausted (re-dispatches of an exploration seat) / abandon: an evidence run is recorded as failed and the seat that asked goes on', async () => {
    const { x, esc } = await usedUpSeat(true);
    says(esc, 'abandon', /an evidence run is recorded as failed and the seat that asked goes on/);
    await answer(x, esc, 'abandon');
    const ev = (await x.w.ledger.records(['evidence'])).filter((c) => c.record.evidence.startsWith('xpe.')).map((c) => c.record.fields['status']);
    assert.deepEqual(ev, ['failed']);
    assert.ok(x.one('crititor'), 'the attacker goes on');
  });
});

describe('option effects: the planner\'s routing of a settled exploration', () => {
  /** A PM plan whose deliverable waits for an exploration (planning.ts roundsStep routes its settle). */
  const routed = async (o: { type: 'direction' | 'structure'; conclude: boolean; option: DecisionOption }) => {
    const w = memoryPorts();
    say(w, SEED_TEXT);
    await seedMission(w, M);
    const base = pmPlan(M);
    const plan: PmPlanDoc = { ...base, elements: [
      { id: 'x1', kind: 'exploration', text: 'which quoting rules to support', provenance: { by: 'user', words: 'W-1', quote: 'Build me a CSV parser' }, after: [], items: [],
        exploration: { id: 'X1', deliverable: 'a design of the quoting rules', fuzzyGoal: { quote: 'Build me a CSV parser', words: 'W-1' }, attackScope: ['internal contradiction'], decision: { id: 'D1', type: o.type }, budget: { rounds: 1, micros: null }, stop: '', research: false } },
      ...base.elements.map((e) => ({ ...e, after: ['x1'] })),
    ] };
    await submitPmBatch(w, { mission: M, plan, userWords: ['W-1'] });
    const engine = new FlowEngine(w);
    await drive(engine, w.scheduler, withKinds({
      'researcher-author': (t) => ((t.card as unknown as AuthorCard).openFindings.length > 0 ? { handBack: submit('v2', reviseAll(t.card as unknown as AuthorCard)) } : { handBack: submit('v1') }),
      crititor: () => ({ handBack: attack(o.conclude ? [] : [finding('serious', 'internal contradiction', 'two rules')]) }),
      stabilizer: (t) => ({ handBack: stabilizeAll(t.card as unknown as StabilizerCard) }),
      secretary: (t) => {
        const c = t.card as unknown as SecretaryCard;
        if (c.request.source === 'exploration-budget' && c.request.subject.startsWith('exploration:') && c.options.some((x) => x.id === 'abandon')) return { handBack: secretary(c, 'abandon') };
        return { handBack: secretary(c, o.option, { instructions: INSTR }) };
      },
    }));
    const esc = (await escalations(w)).find((e) => e.subject === 'exploration:X1' && (e.facts as { outcome?: string } | undefined)?.outcome !== undefined);
    assert.ok(esc, 'the planner routes the settle through an escalation');
    return { w, esc };
  };
  test('routing (a direction conclusion) / accept', async () => {
    const { w, esc } = await routed({ type: 'direction', conclude: true, option: 'accept' });
    says(esc, 'accept', /the conclusion stands: the Architect plans the part that waited for it/);
    const arch = [...w.scheduler.tasks.keys()].filter((t) => t.startsWith('arch.')).map((t) => w.scheduler.card<ArchitectDecomposeCard>(t));
    assert.ok(arch.some((c) => (c.explorationConclusions ?? []).some((x) => x.exploration === 'X1')), 'the Architect plans with the conclusion');
  });
  test('routing (no conclusion) / replan', async () => {
    const { w, esc } = await routed({ type: 'structure', conclude: false, option: 'replan' });
    says(esc, 'replan', /nothing is re-planned here: the PM is told to re-plan the part that waited for it with the user/);
    assert.ok(w.ledger.notices.some((n) => n.category === 'exploration-no-conclusion'), 'the PM is told');
    assert.equal((await appliedOf(w, esc.id))?.what?.['option'], 'replan');
  });
});

describe('option effects: a legalization\'s Auditor whose dispatches are used up', () => {
  const X = 'M1' as MissionId;
  const usedUpAuditor = async () => {
    const p = memoryPorts();
    const c = p.ledger.content;
    const ports = { ledger: p.ledger, scheduler: p.scheduler, evaluator: p.evaluator };
    const reviews: ReviewContract[] = [{ review: 'reviewer', basisLines: ['S1' as never], reliesOn: ['A' as never] }];
    const obj = (id: string, prereqs: string[], r: ReviewContract[]): BaseRecord => ({ kind: 'object.version', object: id as never, objectKind: 'product', mission: X, module: null, content: c.put(`content of ${id}`), prerequisites: c.putList(prereqs), scope: { paths: [`src/${id.toLowerCase()}.ts`], taskType: 'code' }, reviews: r });
    const judgment: BaseRecord = { kind: 'judgment', judgment: 'jA' as never, review: 'reviewer', executor: 'reviewer', target: 'A' as never, verdict: 'pass', evidence: c.putList(['ev.A']), bases: c.putList(['S1.v1']), constraints: c.putList([]), reliesOn: c.putList([]), issues: [], revokes: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [], extends: null };
    await p.ledger.append('item-S1', { events: [{ mission: X, line: 'requirements', event: 'item', key: 'S1.v1', body: { line: 'S1', version: 'S1.v1', type: 'acceptance', text: 'parses every header field', source: { kind: 'words', words: 'W-1', quote: 'it must parse all the fields' }, restatement: null, confirmedBy: null, notifyCondition: null } }] });
    await p.ledger.append('setup', { records: [
      { kind: 'basis.version', basisKind: 'standard', line: 'S1' as never, version: 'S1.v1' as never, mission: X, scope: null },
      { kind: 'env.snapshot', line: 'env.t' as never, snapshot: 'snap.1' as never },
      { kind: 'evidence', evidence: 'ev.A' as never, envLine: 'env.t' as never, envSnapshot: 'snap.1' as never, runClass: 'declared', fields: { exit: '0' } },
      obj('A', [], [{ review: 'reviewer', basisLines: ['S1' as never], reliesOn: [] }]), judgment, obj('B', ['A'], reviews),
    ] });
    await requestLegalization(ports, { legalization: 'L10', mission: X, endpoint: 'B', words: 'legalize B', chainEvidence: [], capabilities: [] });
    await startLegalization(ports, X, 'L10', 'go');
    await advanceLegalization(ports, X, 'L10');
    const t = p.scheduler.queued('auditor-node')[0]!;
    for (let i = 0; i < 3; i++) { await p.scheduler.run(t.task, { release: 'abandoned' }); await advanceLegalization(ports, X, 'L10'); }
    const esc = (await escalations(p, X)).find((e) => e.subject === 'audit:L10')!;
    return { p, ports, esc, task: t.task };
  };
  test('loop-exhausted (re-dispatches of an Auditor) / grant', async () => {
    const { p, ports, esc, task } = await usedUpAuditor();
    says(esc, 'grant', /the step may be dispatched again: its re-dispatches get the attempts granted/);
    await answerEscalation(ports, { mission: X, escalation: esc.id, option: 'grant', grantExtra: 1, words: 'one more (W-1)' });
    await advanceLegalization(ports, X, 'L10');
    assert.equal(p.scheduler.queued('auditor-node')[0]?.task, task, 'dispatched again');
  });
  test('loop-exhausted (re-dispatches of an Auditor) / abandon', async () => {
    const { ports, esc } = await usedUpAuditor();
    says(esc, 'abandon', /the failed Auditor is given up and the legalization ends as not legalized/);
    await answerEscalation(ports, { mission: X, escalation: esc.id, option: 'abandon', words: 'stop (W-1)' });
    const r = await advanceLegalization(ports, X, 'L10');
    assert.equal(r.result?.outcome, 'not-legalized');
  });
});
