import { taskDecisionQuotes } from '../src/seat/cards/dynamic.ts';
import { COMMANDS } from '../src/cli/main.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import type { JudgmentRecord } from '../src/common/records.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { commit, ev, flowCtx } from '../src/flow/context.ts';
import { contestedProduction, planAnswersReplan, submitPmBatch, type EffectiveBody } from '../src/flow/planning.ts';
import { currentConstraints, currentItems, recordConstraint, recordItem, withdrawItem } from '../src/flow/requirements.ts';
import { answerEscalation, carryOut, commitCarrying, decisionFor, isApplied, raiseEscalation, secretaryStep } from '../src/flow/secretary.ts';
import { architect, cal1Fail, cal1Pass, detailedPlan, drive, happyScript, pmPlan, secretary, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import { pmDispatch, pmWithdrawConstraint, pmConstraint } from '../src/process/pm.ts';
import { dispatchView, recordSeatHandBack } from '../src/process/seat.ts';
import type { Calibrator1Card } from '../src/seat/cards/calibrator.ts';
import { REVISION_CARRY_RULE } from '../src/seat/cards/architect.ts';
import { roleText } from '../src/seat/cards/roles.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
async function setup(mode: 'stable' | 'fast' = 'stable') {
  const w = memoryPorts(); say(w, SEED_TEXT); await seedMission(w, M);
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'], mode });
  return { w, engine: new FlowEngine(w) };
}
async function revise(w: World, text: string, item = 'g1', type: 'goal' | 'decision' = 'goal') {
  return recordItem(w, { mission: M, item, type, text, source: { kind: 'words', words: 'W-1', quote: SEED_TEXT.slice(0, 15) } });
}
async function recheck(w: World, words = ['W-1'], changedItems = ['g1']) {
  return submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: words, changedItems });
}
async function fullRecheck(w: World, engine: FlowEngine) {
  await recheck(w); await engine.reconcile(M);
  const c = w.scheduler.card<Calibrator1Card>('cal1.m1.1.c1');
  assert.deepEqual(await w.scheduler.run(c.task, { handBack: { ...cal1Pass(c), verdict: 'needs-full-review' } }), []);
  await engine.reconcile(M);
  return w.scheduler.card<Calibrator1Card>('cal1.m1.1.c1.full');
}
const event = async (w: World, type: string) => w.ledger.events({ mission: M, line: 'plan', event: type });

describe('P3: re-check identity, input, deciding judgment and exits', () => {
  it('mode alone, dependent items alone and a second item revision each change batch identity', async () => {
    const { w, engine } = await setup('fast');
    const changedItems = ['g1', 's1', 'a1'];
    const stable = await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems, mode: 'stable' });
    assert.equal(stable.batch, 'b2');
    await drive(engine, w.scheduler, happyScript(M));
    const first = await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems, dependentItems: ['g1'] });
    assert.equal(first.batch, 'b2.c1');
    await drive(engine, w.scheduler, happyScript(M));
    await revise(w, 'revision two');
    const c2 = await recheck(w); assert.equal(c2.batch, 'b2.c2');
    await drive(engine, w.scheduler, happyScript(M));
    await revise(w, 'revision three');
    const c3 = await recheck(w); assert.equal(c3.batch, 'b2.c3');
    assert.deepEqual(await recheck(w), c3, 'an exact retry remains idempotent');
  });

  it('the continuation has old/new text and withdrawn content, and mixed mapped/unmapped changes widen focus', async () => {
    const { w, engine } = await setup(); await drive(engine, w.scheduler, happyScript(M));
    const old = (await currentItems(flowCtx(w, M))).find((i) => i.line.endsWith('.g1'))!.text;
    await revise(w, 'New goal wording'); await revise(w, 'Unmapped global decision', 'd1', 'decision');
    await withdrawItem(w, { mission: M, item: 's1', reason: 'withdrawn in this batch' });
    await recheck(w); await engine.reconcile(M);
    const c = w.scheduler.card<Calibrator1Card>('cal1.m1.1.c1');
    assert.deepEqual(c.focus, ['e1', 'e2']);
    const diff = w.ledger.content.get(c.materials.find((m) => m.id === 'item-diff')!.ref);
    assert.ok(diff.includes(old)); assert.match(diff, /New goal wording/); assert.match(diff, /\(withdrawn\)/); assert.match(diff, /item.m1.s1/);
    assert.ok(c.materials.find((m) => m.id === 'item-diff')!.mustRead);
  });

  it('a basis changed during a full re-check queues a fresh full rerun, then finishes', async () => {
    const { w, engine } = await setup(); await drive(engine, w.scheduler, happyScript(M));
    await revise(w, 'revision two'); const c = await fullRecheck(w, engine);
    w.scheduler.dispatchOf(c.task);
    await revise(w, 'arrived during review', 'd1', 'decision');
    assert.deepEqual(await w.scheduler.run(c.task, { handBack: cal1Pass(c) }), []);
    await engine.reconcile(M);
    assert.ok(w.scheduler.queued().some((t) => t.task === 'cal1.m1.1.c1.re1'), 'a stale pass always has a rerun exit');
    await drive(engine, w.scheduler, happyScript(M));
    assert.equal((await w.evaluator.labels(['pmplan.m1.1'])).labels['pmplan.m1.1'], 'proven');
    assert.equal((await event(w, 'cal1-recheck-rerun')).length, 1);
  });

  it('a pass that does not revoke a negation keeps contested marks and tells the PM', async () => {
    const { w, engine } = await setup(); await drive(engine, w.scheduler, happyScript(M));
    await revise(w, 'revision two'); await recheck(w); await engine.reconcile(M);
    const c = w.scheduler.card<Calibrator1Card>('cal1.m1.1.c1');
    await w.scheduler.run(c.task, { handBack: cal1Fail(c, 'e1', 'contradicts-user') }); await engine.reconcile(M);
    await recheck(w, ['W-1'], ['g1', 's1']); await engine.reconcile(M);
    const c2 = w.scheduler.card<Calibrator1Card>('cal1.m1.1.c2'); assert.equal(c2.mode.kind, 'full');
    await w.scheduler.run(c2.task, { handBack: cal1Pass(c2) }); await engine.reconcile(M);
    assert.equal((await w.evaluator.labels(['pmplan.m1.1'])).labels['pmplan.m1.1'], 'negated');
    assert.ok((await currentItems(flowCtx(w, M))).some((i) => i.line.endsWith('.g1') && i.state === 'contested'));
    assert.ok(w.ledger.notices.some((n) => n.key === c2.task && n.category === 'calibrator-1-returned'));
    assert.equal((await event(w, 'cal1-recheck-rerun')).length, 0, 'a negation needs a ruling or revision, not an endless rerun');
  });

  it('an older full re-check hands back as history after a newer re-check passed; J0 stays the actual deciding pass', async () => {
    const { w, engine } = await setup(); await drive(engine, w.scheduler, happyScript(M));
    await revise(w, 'revision two'); const old = await fullRecheck(w, engine); const d = w.scheduler.dispatchOf(old.task);
    await revise(w, 'revision three'); await recheck(w); await engine.reconcile(M);
    const newer = w.scheduler.card<Calibrator1Card>('cal1.m1.1.c2'); await w.scheduler.run(newer.task, { handBack: cal1Pass(newer) }); await engine.reconcile(M);
    const before = (await w.evaluator.deciding(['pmplan.m1.1'])).views['pmplan.m1.1']!.positions[0]!.by;
    const handback = await recordSeatHandBack(w.ctx, d, { report: 'late older result', fields: cal1Fail(old, 'e1', 'contradicts-user'), advance: false });
    assert.equal(handback.kind, 'recorded'); if (handback.kind === 'recorded') assert.notEqual(handback.outcome, 'accepted');
    assert.equal((await w.ledger.records(['judgment'])).some((r) => (r.record as JudgmentRecord).judgment === `j.${old.task}`), false);
    assert.equal((await w.evaluator.deciding(['pmplan.m1.1'])).views['pmplan.m1.1']!.positions[0]!.by, before);
    await revise(w, 'revision four'); await recheck(w); await engine.reconcile(M);
    assert.deepEqual(w.scheduler.card<Calibrator1Card>('cal1.m1.1.c3').mode, { kind: 'continuation', extends: before });
  });

  it('fast mode holds contested production and its dependents while independent elements continue', async () => {
    const { w, engine } = await setup('fast'); await drive(engine, w.scheduler, happyScript(M));
    await revise(w, 'revision two'); await recheck(w); await engine.reconcile(M);
    const c = w.scheduler.card<Calibrator1Card>('cal1.m1.1.c1'); await w.scheduler.run(c.task, { handBack: cal1Fail(c, 'e1', 'contradicts-user') }); await engine.reconcile(M);
    const eff = (await w.ledger.events<EffectiveBody>({ mission: M, line: 'plan', event: 'effective' })).at(-1)!.body;
    const plan = detailedPlan(M); const independent = { ...plan.tasks[0]!, id: 'independent', dependsOn: [], requirementItems: [], provenance: { planElements: ['e2'] } };
    assert.equal(await contestedProduction(flowCtx(w, M), eff, plan, plan.tasks.find((t) => t.id === 'impl')!), true);
    assert.equal(await contestedProduction(flowCtx(w, M), eff, plan, independent), false);
  });

  it('only the answering re-plan revision and its descendants release a wait', async () => {
    const { w } = await setup(); const ctx = flowCtx(w, M);
    await commit(ctx, 'test:routes', { events: [
      ev(ctx, 'plan', 'attempt', 'pmplan.m1.1#2', { k: 2, previous: 'dplan.m1.1.1' }),
      ev(ctx, 'plan', 'replan-routed', 'mine', { attempt: 2, dplan: 'dplan.m1.1.2' }),
      ev(ctx, 'plan', 'attempt', 'pmplan.m1.1#3', { k: 3, previous: 'dplan.m1.1.2' }),
      ev(ctx, 'plan', 'attempt', 'pmplan.m1.2#1', { k: 1, previous: 'dplan.m1.1.1' }),
    ] });
    assert.equal(await planAnswersReplan(ctx, 'dplan.m1.2.1', 'mine'), false);
    assert.equal(await planAnswersReplan(ctx, 'dplan.m1.1.2', 'mine'), true);
    assert.equal(await planAnswersReplan(ctx, 'dplan.m1.1.3', 'mine'), true);
    assert.equal(await planAnswersReplan(ctx, 'dplan.m1.1.3', 'other'), false);
  });
});

async function queueSeat(kind: 'constructor' | 'reviewer' | 'secretary') {
  const { w, engine } = await setup('fast');
  if (kind === 'secretary') {
    await raiseEscalation(flowCtx(w, M), { id: 'test-context', source: 'constructor-decision', lineage: 'task.m1.impl', subject: 'task:impl', summary: 'Question', reasons: ['Choose'], options: ['answer', 'abandon', 'ask-user'], items: ['item.m1.g1'] });
    return { w, engine, task: 'sec.test-context' };
  }
  await drive(engine, w.scheduler, (t, s) => t.card.seat === kind ? null : happyScript(M)(t, s));
  return { w, engine, task: w.scheduler.queued(kind)[0]!.task };
}

describe('P3: dispatch context, Secretary apply and constraints', () => {
  for (const kind of ['constructor', 'reviewer', 'secretary'] as const) it(`${kind}: dispatch refreshes late decisions, withdrawals and both constraint kinds; the dispatch spec is fixed`, async () => {
    const { w, task } = await queueSeat(kind);
    await revise(w, 'Late user decision', 'd1', 'decision');
    await withdrawItem(w, { mission: M, item: 'a1', reason: 'no longer authorized' });
    await recordConstraint(w, { mission: M, constraint: 'instructions', kind: 'instruction', text: 'Keep operation reversible', scope: { paths: ['**'], taskTypes: [] } });
    await recordConstraint(w, { mission: M, constraint: 'object', kind: 'object', text: 'Do not expose private fields', scope: { paths: ['**'], taskTypes: [] } });
    const d = pmDispatch(w.ctx, task);
    const v = dispatchView(w.ctx, d.dispatch);
    assert.match(d.card, /Late user decision/); assert.match(d.card, /Instruction \(context only; not a proof input\)/);
    assert.match(d.card, /Do not expose private fields/);
    const auth = (v.card['materials'] as Array<{ id: string; ref: string }> | undefined)?.find((m) => m.id === 'authorizations');
    if (kind === 'secretary') assert.equal(w.memory.data.text(auth!.ref), '(none)');
    else assert.equal(auth, undefined, 'the builder does not render authorization material for this seat');
    if (kind === 'reviewer') {
      const binding = v.card['binding'] as { bases: Parameters<typeof w.memory.data.getList>[0]; constraints: Parameters<typeof w.memory.data.getList>[0] };
      assert.ok(!w.memory.data.getList(binding.bases).includes('item.m1.d1.v1'), 'late context is not added to the fixed contract');
      const checks = w.memory.data.getList(binding.constraints);
      assert.ok(checks.some((c) => c.includes('constraint.object'))); assert.ok(checks.every((c) => !c.includes('constraint.instructions')));
    }
    if (kind === 'secretary') {
      assert.deepEqual(v.card['authorizations'], []);
      const facts = (v.card['materials'] as Array<{ id: string; ref: string }>).find((m) => m.id === 'current-facts')!;
      assert.match(w.memory.data.text(facts.ref), /Late user decision/);
    }
    await revise(w, 'A newer decision', 'd1', 'decision');
    assert.deepEqual(dispatchView(w.ctx, d.dispatch).card, v.card, 'hand-back checks retain the actually dispatched inputs');
    assert.match(d.card, /recorded after the plan|Late user decision/);
  });

  it('a withdrawn authorization rejects apply and reopens a Secretary round that can ask the user or decide again', async () => {
    const { w, task } = await queueSeat('secretary');
    const c = w.scheduler.card<SecretaryCard>(task);
    const result = { ...secretary(c, 'abandon'), classification: 'important-within-authority', authorization: 'item.m1.a1', notice: 'Within authority' };
    assert.deepEqual(await w.scheduler.run(task, { handBack: result }), []);
    const ctx = flowCtx(w, M); await secretaryStep(ctx);
    await withdrawItem(w, { mission: M, item: 'a1', reason: 'withdrawn after the choice' });
    await assert.rejects(carryOut(ctx, 'test-context', { option: 'abandon' }), /not carried out/);
    assert.equal(await isApplied(ctx, 'test-context'), false);
    assert.equal(await decisionFor(ctx, 'test-context'), null);
    assert.ok(w.scheduler.queued('secretary').some((t) => t.task === `${task}.retry1`), 'waiting state has a pending Secretary exit');
    const retry = w.scheduler.card<SecretaryCard>(`${task}.retry1`);
    const claimed = dispatchView(w.ctx, pmDispatch(w.ctx, retry.task).dispatch).card;
    assert.deepEqual(claimed, retry, 'the retry builder and refresh select the same reasons, involved items and facts');
    await w.scheduler.run(retry.task, { handBack: secretary(retry, 'ask-user') }); await secretaryStep(ctx);
    assert.equal(await decisionFor(ctx, 'test-context'), null, 'the user can answer while related work waits');
    assert.equal(await isApplied(ctx, 'test-context'), false);
  });

  it('withdraw retains the record, is idempotent, and removes only the relied-on proof duty', async () => {
    const { w, engine } = await setup(); await drive(engine, w.scheduler, happyScript(M));
    const products = (await w.ledger.events<{ product: string }>({ mission: M, event: 'accepted' })).map((e) => e.body.product);
    const scope = { paths: ['unrelated/**'], taskTypes: [] };
    await recordConstraint(w, { mission: M, constraint: 'irrelevant', kind: 'object', text: 'No match', scope });
    const before = await w.evaluator.labels(products);
    await pmWithdrawConstraint(w.ctx, { constraint: 'irrelevant', words: 'W-1' });
    await pmWithdrawConstraint(w.ctx, { constraint: 'irrelevant', words: 'W-1' });
    assert.deepEqual((await w.evaluator.labels(products)).labels, before.labels);
    assert.ok((await w.ledger.records(['basis.version'])).some((r) => r.record.kind === 'basis.version' && r.record.line === 'constraint.irrelevant'));
    assert.ok(!(await currentConstraints(flowCtx(w, M))).some((c) => c.line === 'constraint.irrelevant'));
    await assert.rejects(recordConstraint(w, { mission: M, constraint: 'irrelevant', kind: 'object', text: 'Restored', scope }), /withdrawn/);
    await assert.rejects(pmWithdrawConstraint(w.ctx, { constraint: 'missing', words: 'W-1' }), /No constraint/);
  });

  it('constraint mission scope is optional and current cards select it by mission', async () => {
    const { w } = await setup();
    await pmConstraint(w.ctx, { mission: M, constraint: 'local', missionScope: M, kind: 'instruction', text: 'Only m1', scope: { paths: ['**'], taskTypes: [] } });
    await recordConstraint(w, { mission: M, constraint: 'global', kind: 'instruction', text: 'Every mission', scope: { paths: ['**'], taskTypes: [] } });
    assert.deepEqual((await currentConstraints(flowCtx(w, M))).map((c) => c.line).sort(), ['constraint.global', 'constraint.local']);
    assert.deepEqual((await currentConstraints(flowCtx(w, 'm2' as MissionId))).map((c) => c.line).sort(), ['constraint.global', 'constraint.local'], 'resolve project constraints before selecting by object mission');
  });
});


describe('P3: recovery and guidance regressions', () => {
  it('a product bound directly to a revised basis does not recover just because the PM plan re-check passes', async () => {
    const { w, engine } = await setup(); await drive(engine, w.scheduler, happyScript(M));
    await revise(w, 'Directly revised requirement'); await recheck(w); await engine.reconcile(M);
    await drive(engine, w.scheduler, (t) => t.card.seat === 'calibrator-1' ? { handBack: cal1Pass(t.card as unknown as Calibrator1Card) } : null);
    const product = (await w.ledger.events<{ product: string }>({ mission: M, event: 'accepted' }))[0]!.body.product;
    assert.equal((await w.evaluator.labels(['pmplan.m1.1'])).labels['pmplan.m1.1'], 'proven');
    assert.notEqual((await w.evaluator.labels([product])).labels[product], 'proven');
  });

  for (const failure of ['send', 'told', 'pre-upgrade'] as const) it(`the restart notice recovers after ${failure} and is sent once`, async () => {
    const { w, engine } = await setup(); await drive(engine, w.scheduler, happyScript(M));
    const next = pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'Revised direction' }, pmPlan(M).elements[1]!] });
    await submitPmBatch(w, { mission: M, plan: next, userWords: ['W-1'] });
    const revised = detailedPlan(M); const tasks = revised.tasks.map((t) => t.id === 'impl' ? { ...t, goal: 'A different implementation' } : t);
    if (failure === 'send') w.ledger.failNotifyNext = (n) => n.category === 'plan-revision-restarts-work';
    if (failure === 'told') w.ledger.failNext = (op) => op.includes('flow:told:') && op.includes('plan-revision-restarts-work');
    if (failure === 'pre-upgrade') {
      // A mechanically checked plan already in the ledger must still send its missing notice.
      w.ledger.failNotifyNext = (n) => n.category === 'plan-revision-restarts-work';
    }
    const script: import('../src/flow/scripted.ts').Script = (t, status) => t.card.seat === 'architect-feasibility' ? null : t.card.seat === 'architect-decompose' ? { handBack: architect({ ...revised, tasks }) } : t.card.seat === 'constructor' || t.card.seat === 'reviewer' ? null : happyScript(M)(t, status);
    await assert.rejects(drive(engine, w.scheduler, script), /injected failure/);
    assert.ok((await event(w, 'mechanical-check')).some((e) => e.key === 'dplan.m1.2.1'));
    await drive(engine, w.scheduler, script);
    await engine.reconcile(M); await engine.reconcile(M);
    const notices = w.ledger.notices.filter((n) => n.category === 'plan-revision-restarts-work');
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.defaultAction, /starts from the mission base plus its dependencies' current accepted work, without the earlier attempts' work \(ruling 6\); its earlier records remain/);
    assert.doesNotMatch(notices[0]!.defaultAction, /no longer used/);
    assert.ok((await event(w, 'told')).some((e) => e.key === 'plan-revision-restarts-work:dplan.m1.2.1'));
    assert.ok(w.scheduler.queued('architect-feasibility').length > 0, 'the notice retry leaves a review exit');
  });

  it('a cited decision changed after hand-back sends the choice back; a fresh Secretary decision can finish', async () => {
    const { w, task } = await queueSeat('secretary'); await revise(w, 'First decision', 'd1', 'decision');
    const c = w.scheduler.card<SecretaryCard>(task);
    await w.scheduler.run(task, { handBack: secretary(c, 'answer', { instructions: 'Continue' }) });
    const ctx = flowCtx(w, M); await secretaryStep(ctx);
    await revise(w, 'Replacement decision', 'd1', 'decision');
    await assert.rejects(carryOut(ctx, 'test-context', { option: 'answer' }), /not carried out/);
    const retry = w.scheduler.card<SecretaryCard>(`${task}.retry1`);
    await w.scheduler.run(retry.task, { handBack: secretary(retry, 'answer', { instructions: 'Use the replacement' }) }); await secretaryStep(ctx);
    const carry = await carryOut(ctx, 'test-context', { option: 'answer' });
    await commitCarrying(ctx, 'test:carry-retry', [], [carry]);
    assert.equal(await isApplied(ctx, 'test-context'), true);
    assert.equal((await decisionFor(ctx, 'test-context'))?.instructions, 'Use the replacement');
    const quotes = taskDecisionQuotes(await currentItems(ctx), await w.ledger.events({ mission: M }), { id: 'impl', requirementItems: [] }, [], undefined);
    assert.ok(quotes.includes('Use the replacement'));
    assert.ok(!quotes.includes('Continue'), 'a rejected earlier Secretary round is not quoted as the carried answer');
  });

  it('a user answer cancels an unclaimed retry and provides the apply exit', async () => {
    const { w, task } = await queueSeat('secretary'); const c = w.scheduler.card<SecretaryCard>(task);
    await w.scheduler.run(task, { handBack: { ...secretary(c, 'abandon'), classification: 'important-within-authority', authorization: 'item.m1.a1', notice: 'Within authority' } });
    const ctx = flowCtx(w, M); await secretaryStep(ctx); await withdrawItem(w, { mission: M, item: 'a1', reason: 'withdrawn' });
    await assert.rejects(carryOut(ctx, 'test-context', { option: 'abandon' }));
    await answerEscalation(w, { mission: M, escalation: 'test-context', option: 'answer', instructions: 'The user decides', words: 'W-1' }); await secretaryStep(ctx);
    assert.equal((await w.scheduler.status(`${task}.retry1`))?.state, 'abandoned');
    await commitCarrying(ctx, 'test:carry-user', [], [await carryOut(ctx, 'test-context', { option: 'answer' })]);
    assert.equal(await isApplied(ctx, 'test-context'), true);
  });

  it('dispatch quotes current late decisions, excludes superseded/withdrawn items, and marks their timing', async () => {
    const { w, task } = await queueSeat('reviewer');
    await revise(w, 'Old decision', 'd1', 'decision'); await revise(w, 'Current decision', 'd1', 'decision');
    await revise(w, 'Withdrawn decision', 'd2', 'decision'); await withdrawItem(w, { mission: M, item: 'd2', reason: 'withdrawn' });
    const d = pmDispatch(w.ctx, task); const quotes = dispatchView(w.ctx, d.dispatch).card['decisionQuotes'];
    assert.ok((quotes as string[]).includes('Current decision (recorded after the plan)'));
    assert.ok(!(quotes as string[]).some((q) => /Old decision|Withdrawn decision/.test(q)));
  });
});


describe('P3: ruling and dispatch exits', () => {
  it('the new revision restrictions are labelled guidance, and a respec preserves records without carrying earlier work', () => {
    assert.match(REVISION_CARRY_RULE, /guidance \(Proposal, pending ruling\)/);
    assert.match(roleText('architect'), /Guidance \(Proposal, pending ruling\)/);
    assert.doesNotMatch(roleText('architect'), /Never rebuild|no longer used/);
    assert.match(REVISION_CARRY_RULE, /starts from the mission base plus its dependencies' current accepted work, without the earlier attempts' work \(ruling 6\); its earlier records remain/);
  });

  it('a queued fast Constructor is held if its element becomes negated before claim, and a valid ruling releases it', async () => {
    const { w, task, engine } = await queueSeat('constructor');
    await revise(w, 'revision two'); await recheck(w); await engine.reconcile(M);
    const c = w.scheduler.card<Calibrator1Card>('cal1.m1.1.c1');
    await w.scheduler.run(c.task, { handBack: cal1Fail(c, 'e1', 'contradicts-user') }); await engine.reconcile(M);
    assert.throws(() => pmDispatch(w.ctx, task), /contested or negated/);
    const fail = (await w.ledger.records(['judgment'])).find((r) => r.record.kind === 'judgment' && r.record.judgment === 'j.cal1.m1.1.c1')!.record as JudgmentRecord;
    w.ledger.commit([{ ...fail, judgment: 'j.user.ruling' as never, verdict: 'pass', revokes: fail.judgment, extends: null }]);
    await engine.reconcile(M);
    assert.ok((await currentItems(flowCtx(w, M))).every((i) => i.state === 'valid'));
    assert.ok(pmDispatch(w.ctx, task).dispatch);
  });
});


it('constraint help exposes withdrawal and optional mission scope', () => {
  const command = COMMANDS.find((c) => c.group === 'pm' && c.name[0] === 'constraint')!;
  assert.match(command.usage, /constraint withdraw <constraint> --words W-/);
  assert.match(command.usage, /--mission <m>/);
  assert.equal(command.flags?.['mission'], 'string');
});


it('Constructor refresh keeps the builder selection when unrelated authority is added', async () => {
  const { w, task } = await queueSeat('constructor');
  await recordItem(w, { mission: M, item: 'a2', type: 'authorization', text: 'Additional authority', source: { kind: 'words', words: 'W-1', quote: SEED_TEXT.slice(0, 20) } });
  const d = pmDispatch(w.ctx, task);
  const card = dispatchView(w.ctx, d.dispatch).card;
  assert.equal(card['authorizations'], undefined);
  assert.equal((card['materials'] as Array<{ id: string }> | undefined)?.some((m) => m.id === 'authorizations') ?? false, false);
  assert.doesNotMatch(d.card, /Additional authority/);
});
