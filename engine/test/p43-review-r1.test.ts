import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { canonicalJson } from '../src/common/hash.ts';
import { flowCtx, objectRecord } from '../src/flow/context.ts';
import { cal1Pass, cal2Pass } from '../src/flow/scripted.ts';
import { planInEffect } from '../src/flow/planning.ts';
import { DetailedPlanDoc } from '../src/flow/plandoc.ts';
import { carryOut, commitCarrying, decisionFor, grantForDecision, grantedAttempt, markApplied } from '../src/flow/secretary.ts';
import { pmMission, pmPlan, pmSay } from '../src/process/index.ts';
import { listNotices } from '../src/process/notices.ts';
import { channel, pmInbox, secNext } from '../src/process/secretary.ts';
import { appendRecords } from '../src/memory/index.ts';
import { pmDispatch, pmRelease } from '../src/process/pm.ts';
import { builders } from './labels-fixtures.ts';
import { addDetailedPlan, readAll, readyOf, startAddMission, step } from './process-fixtures.ts';
import { project43, command43, done43, live43, secretary43, escalation43 } from './p43-fixtures.ts';

const M = 'm1' as MissionId;

async function pendingSecretary(p: ReturnType<typeof project43>, option = 'accept-risk') {
  const b = builders(p.ctx.memory);
  p.ctx.memory.write({}, (tx) => appendRecords(tx, [b.product('P'), b.judge('negative', 'P', {verdict: 'fail'})]));
  await escalation43(p, 'choice', {options: ['accept-risk', 'grant', 'rework', 'ask-user'], position: {target: 'P', review: 'reviewer', revokes: 'negative'}});
  const generation = await live43(p);
  const d = await done43(p, ['sec', 'card', 'choice'], generation);
  readAll(p.ctx, d.dispatch);
  await done43(p, ['sec', 'decide', 'choice', '--option', option, '--extra', option === 'grant' ? '1' : '0', '--reason', 'a reversible choice within the plan'], generation);
  return generation;
}

async function startDirectionExploration(p: ReturnType<typeof project43>) {
  pmMission(p.ctx, M);
  const words = pmSay(p.ctx, 'Explore a cache design with no logical hole.').words;
  await pmPlan(p.ctx, {mission: M, words: [words], plan: {format: 'mp4.pm-plan.v1', mission: M, round: 1, order: 'free', elements: [{id: 'x', kind: 'exploration', text: 'Explore a cache design', provenance: {by: 'user', words, quote: 'Explore a cache design'}, after: [], items: [], exploration: {id: 'X1', deliverable: 'a cache design', fuzzyGoal: {quote: 'no logical hole', words}, attackScope: ['internal contradiction'], decision: {id: 'D1', type: 'direction'}, budget: {rounds: 3, micros: null}, stop: '', research: false}}], goalsBeyond: [], authorizations: []}});
  await step(p.ctx, 'calibrator-1', cal1Pass);
}

test('R1.1 structural approval expires when a repair changes the diff before activation', async () => {
  const p = project43();
  try {
    await startAddMission(p.ctx, M);
    await step(p.ctx, 'calibrator-1', cal1Pass);
    await step(p.ctx, 'architect-decompose', () => addDetailedPlan(M));
    await step(p.ctx, 'calibrator-2', cal2Pass);
    const generation = await live43(p), sec = secretary43(p, generation);
    try {
      const ctx = flowCtx(sec.ports(), M);
      await sec.ports().ledger.append('revision-2', {events: [{mission: M, line: 'plan', event: 'attempt', key: 'pmplan.m1.1#2', body: {k: 2, reason: 'replan', previous: 'dplan.m1.1.1', mechanicalFailures: [], feasibilityFindings: [], instructions: ['change the interface'], conclusions: []}}]});
      const revised = DetailedPlanDoc.parse(addDetailedPlan(M));
      revised.newInterfaces[0]!.definition = 'add(a: bigint, b: bigint): bigint';
      await step(sec, 'architect-decompose', () => revised);
      await secNext(sec);
      const initial = (await done43(p, ['pm', 'inbox'])).items.find((i: any) => i.facts?.dplan === 'dplan.m1.1.2');
      assert.ok(initial, JSON.stringify(await done43(p, ['sec', 'next'], generation)));
      assert.ok(initial.id.endsWith(`.${initial.facts.diffHash}`), 'the question identity includes the approved diff hash');
      const approve = async (id: string) => done43(p, ['pm', 'answer', M, id.slice(M.length + 1), '--option', 'approve', '--by', 'pm', '--no-words', '--reason', 'minor structural choice within the intended result']);
      await approve(initial.id);
      await secNext(sec); // Calibrator 2 is now pending; approval has not been applied.
      const before = (await planInEffect(ctx))!;
      const added = {...structuredClone(before.plan.tasks[0]!), id: 'C'};
      // The exact effective event a decided repair appends, including an accepted added task.
      await sec.ports().ledger.append('repair-add-C', {events: [
        {mission: M, line: 'plan', event: 'effective', key: `${before.eff.dplan}#a1`, body: {...before.eff, tasks: [...before.eff.tasks, 'C'], amendments: [{repair: 'R-1', arch: 'arch-repair.m1.R-1.1', tasks: [added], reopen: []}]}},
        {mission: M, line: 'task:C', event: 'accepted', key: '1', body: {task: 'C', k: 1, product: 'prod.C', risks: []}},
      ]});
      await step(sec, 'calibrator-2', cal2Pass);
      await secNext(sec);
      assert.equal((await planInEffect(ctx))?.eff.dplan, before.eff.dplan, 'approval of an interface change must not approve dropping C');
      const fresh = (await done43(p, ['pm', 'inbox'])).items.find((i: any) => i.facts?.dplan === 'dplan.m1.1.2');
      assert.ok(fresh); assert.notEqual(fresh.id, initial.id);
      assert.match(fresh.facts.diff.join('\n'), /tasks dropped: C/);
      assert.ok(!(await done43(p, ['pm', 'inbox'])).items.some((i: any) => i.id === initial.id), 'obsolete diff is closed');
      await approve(fresh.id); await secNext(sec);
      assert.equal((await planInEffect(ctx))?.eff.dplan, 'dplan.m1.1.2');
    } finally {sec.memory.close();}
  } finally {p.cleanup();}
});

test('R1.1 activation fences a concurrently moved effective plan; returning diffs get a fresh question', async () => {
  const p = project43();
  try {
    await startAddMission(p.ctx, M);
    await step(p.ctx, 'calibrator-1', cal1Pass);
    await step(p.ctx, 'architect-decompose', () => addDetailedPlan(M));
    await step(p.ctx, 'calibrator-2', cal2Pass);
    const generation = await live43(p), sec = secretary43(p, generation);
    try {
      const ctx = flowCtx(sec.ports(), M), before = (await planInEffect(ctx))!;
      await sec.ports().ledger.append('revision-2', {events: [{mission: M, line: 'plan', event: 'attempt', key: 'pmplan.m1.1#2', body: {k: 2, reason: 'replan', previous: before.eff.dplan, mechanicalFailures: [], feasibilityFindings: [], instructions: ['change storage'], conclusions: []}}]});
      const revised = DetailedPlanDoc.parse(addDetailedPlan(M)); revised.storage = ['SQLite'];
      await step(sec, 'architect-decompose', () => revised); await secNext(sec);
      const initial = pmInbox(sec).find((i: any) => i.facts?.dplan === 'dplan.m1.1.2')!;
      const approve = async (id: string) => done43(p, ['pm', 'answer', M, id.slice(M.length + 1), '--option', 'approve', '--by', 'pm', '--no-words', '--reason', 'minor storage choice']);
      await approve(initial.id); await secNext(sec);
      await step(sec, 'calibrator-2', cal2Pass);
      const previous = (await objectRecord(ctx, before.eff.dplan))!;
      const movedDoc = JSON.parse(sec.ports().ledger.content.get(previous.content));
      movedDoc.plan.tasks.push({...structuredClone(before.plan.tasks[0]!), id: 'C'});
      const content = sec.ports().ledger.content.put(canonicalJson(movedDoc));
      const write = sec.memory.write.bind(sec.memory);
      let injected = false;
      sec.memory.write = (req, fn) => {
        if (!injected && req.op === 'flow:effective:m1:dplan.m1.1.2') {
          injected = true;
          write({op: 'concurrent-effective-plan', payload: {content}}, (tx) => appendRecords(tx, [
            {...previous, object: 'dplan.m1.moved' as typeof previous.object, content},
            {kind: 'flow.event', mission: M, line: 'plan', event: 'effective', key: 'dplan.m1.moved', body: tx.data.put(canonicalJson({...before.eff, dplan: 'dplan.m1.moved', tasks: [...before.eff.tasks, 'C']}))},
          ]));
        }
        return write(req, fn);
      };
      const afterRace = await secNext(sec);
      assert.equal(injected, true);
      assert.equal((await planInEffect(ctx))?.eff.dplan, 'dplan.m1.moved', `the application write must recheck the plan snapshot: ${JSON.stringify(afterRace.errors)}`);
      assert.equal(sec.memory.stmt("SELECT 1 FROM flow_events WHERE event = 'applied' AND key = ?").get(initial.id.slice(3)), undefined);
      await secNext(sec);
      const changed = pmInbox(sec).find((i: any) => i.facts?.dplan === 'dplan.m1.1.2')!;
      assert.ok(changed); assert.notEqual(changed.id, initial.id);
      await sec.ports().ledger.append('return-to-previous-plan', {events: [{mission: M, line: 'plan', event: 'effective', key: `${before.eff.dplan}#return`, body: before.eff}]});
      await secNext(sec);
      const returned = pmInbox(sec).find((i: any) => i.facts?.dplan === 'dplan.m1.1.2')!;
      assert.ok(returned); assert.notEqual(returned.id, initial.id, 'a closed question cannot be revived by returning to its diff');
      await approve(returned.id); await secNext(sec);
      assert.equal((await planInEffect(ctx))?.eff.dplan, 'dplan.m1.1.2');
    } finally {sec.memory.close();}
  } finally {p.cleanup();}
});

test('R1.2 a PM answer fences a prepared Secretary effect at the application write', async () => {
  const p = project43();
  try {
    const generation = await pendingSecretary(p), sec = secretary43(p, generation);
    try {
      const ctx = flowCtx(sec.ports(), M);
      const carry = await carryOut(ctx, 'choice', {option: 'accept-risk'});
      await done43(p, ['pm', 'answer', M, 'choice', '--by', 'pm', '--option', 'rework', '--instructions', 'Fix it first.', '--no-words', '--reason', 'minor choice needs rework']);
      await assert.rejects(() => commitCarrying(ctx, 'secretary-race', [{mission: M, line: 'test', event: 'accepted', key: 'choice', body: {}}], [carry]), (e: any) => e.code === 'STALE_REQUEST');
      assert.equal(sec.memory.stmt("SELECT 1 FROM flow_events WHERE event IN ('applied', 'accepted') AND key = 'choice'").get(), undefined);
      assert.equal(sec.memory.stmt("SELECT 1 FROM log WHERE kind = 'judgment' AND json_extract(record, '$.judgment') = 'j.sec.choice'").get(), undefined, 'the superseded Secretary ruling must not leak');
      assert.equal((await decisionFor(flowCtx(sec.ports(), M), 'choice'))?.by, 'pm');
      await markApplied(flowCtx(sec.ports(), M), 'choice', {option: 'rework'});
    } finally {sec.memory.close();}
  } finally {p.cleanup();}
});

test('R1.3 stale PM words leave the Secretary overridden while PM round 2 waits', async () => {
  const p = project43();
  try {
    const generation = await pendingSecretary(p);
    const w = await done43(p, ['pm', 'say', 'Rework the implementation', '--tag', 'decision@m1']);
    await done43(p, ['pm', 'answer', M, 'choice', '--by', 'pm', '--option', 'rework', '--instructions', 'Fix it first.', '--words', w.words, '--reason', 'supported']);
    await done43(p, ['pm', 'say', 'Use another approach', '--tag', 'decision@m1', '--supersedes', `${w.words}#1`]);
    assert.equal(await decisionFor(flowCtx(p.ctx.ports(), M), 'choice'), null, 'pure PM reads must also leave the old Secretary decision overridden');
    const sec = secretary43(p, generation);
    try {
      for (let pass = 0; pass < 2; pass++) {
        const ctx = flowCtx(sec.ports(), M);
        assert.equal(await decisionFor(ctx, 'choice'), null);
        await assert.rejects(() => markApplied(ctx, 'choice', {option: 'accept-risk'}), (e: any) => e.code === 'NOT_READY');
      }
      const inbox = (await done43(p, ['pm', 'inbox'])).items.find((i: any) => i.id === 'm1/choice');
      assert.equal(inbox.round, 2);
      await done43(p, ['pm', 'answer', M, 'choice', '--by', 'pm', '--option', 'rework', '--instructions', 'New answer.', '--no-words', '--reason', 'minor choice after reconsideration']);
      await markApplied(flowCtx(sec.ports(), M), 'choice', {option: 'rework'});
    } finally {sec.memory.close();}
  } finally {p.cleanup();}
});

test('R1.2 a pending resident Secretary grant and its attempt cannot escape a PM override', async () => {
  const p = project43();
  try {
    const generation = await pendingSecretary(p, 'grant'), sec = secretary43(p, generation);
    try {
      const ctx = flowCtx(sec.ports(), M);
      const grant = await grantForDecision(ctx, {op: 'prepared-secretary-grant', lineage: 'L', loop: 'rework', by: 'secretary', extra: 1, reason: 'one more attempt'});
      await grantedAttempt(ctx, grant, {op: 'prepared-attempt', lineage: 'L', loop: 'rework', signature: 'granted'});
      assert.equal(sec.memory.stmt("SELECT 1 FROM log WHERE kind IN ('loop.grant', 'loop.attempt') AND json_extract(record, '$.lineage') = 'L' AND json_extract(record, '$.loop') = 'rework'").get(), undefined, 'preparing an unapplied Secretary decision must not write its effects');
      const carry = await carryOut(ctx, 'choice', {option: 'grant'}, grant.records);
      await done43(p, ['pm', 'answer', M, 'choice', '--by', 'pm', '--option', 'rework', '--instructions', 'Change approach.', '--no-words', '--reason', 'minor choice']);
      await assert.rejects(() => commitCarrying(ctx, 'grant-application-race', [], [carry]), (e: any) => e.code === 'STALE_REQUEST');
      assert.equal(sec.memory.stmt("SELECT 1 FROM log WHERE kind IN ('loop.grant', 'loop.attempt') AND json_extract(record, '$.lineage') = 'L' AND json_extract(record, '$.loop') = 'rework'").get(), undefined);
    } finally {sec.memory.close();}
  } finally {p.cleanup();}
});

test('R1.2 successful resident Secretary grants requeue atomically and retain the one-grant limit', async () => {
  const p = project43();
  try {
    await startAddMission(p.ctx, M);
    const task = await readyOf(p.ctx, 'calibrator-1');
    for (let n = 0; n < 3; n++) {const d = pmDispatch(p.ctx, task.step); await pmRelease(p.ctx, d.dispatch, 'ended');}
    const generation = await live43(p), sec = secretary43(p, generation);
    try {
      const before = await secNext(sec), choice = before.ready.find((r) => r.kind === 'secretary')!.step.slice(4);
      const card = await done43(p, ['sec', 'card', choice], generation); readAll(sec, card.dispatch);
      await done43(p, ['sec', 'decide', choice, '--option', 'grant', '--extra', '1', '--reason', 'one retry within the plan'], generation);
      const after = await secNext(sec);
      assert.ok(after.ready.some((r) => r.step === task.step));
      const grant = sec.memory.stmt("SELECT op, json_extract(record, '$.lineage') AS lineage FROM log WHERE kind = 'loop.grant' AND json_extract(record, '$.by') = 'secretary'").get() as {op: string; lineage: string};
      const applied = sec.memory.stmt("SELECT op FROM log WHERE kind = 'flow.event' AND json_extract(record, '$.event') = 'applied' AND json_extract(record, '$.key') = ?").get(choice) as {op: string};
      assert.equal(grant.op, applied.op);
      const second = await grantForDecision(flowCtx(sec.ports(), M), {op: 'second-secretary-grant', lineage: grant.lineage, loop: 'rework', by: 'secretary', extra: 1, reason: 'another loop'});
      assert.equal(second.granted, false); assert.equal(second.why, 'secretary-already-granted');
    } finally {sec.memory.close();}
  } finally {p.cleanup();}
});

test('R1.4 free Secretary questions and PM replies reach inbox, next and wait with op replay', async () => {
  const p = project43();
  try {
    const generation = await live43(p);
    const q = await done43(p, ['sec', 'ask-pm', 'Was the transform change intentional?', '--about', 'transform-change', '--op', 'question-once'], generation);
    const again = await command43(p, ['sec', 'ask-pm', 'Was the transform change intentional?', '--about', 'transform-change', '--op', 'question-once'], generation);
    assert.equal(again.result.id, q.id); assert.equal(again.replayed, true);
    const item = (await done43(p, ['pm', 'inbox'])).items.find((i: any) => i.id === q.id);
    assert.match(item.text, /transform/); assert.match(item.action, /mp pm reply/); assert.equal(item.about, 'transform-change');
    assert.equal((await command43(p, ['pm', 'inbox', '--ack', q.id])).error.code, 'NOT_ALLOWED');
    await done43(p, ['pm', 'inbox', '--asked-user', q.id]);
    assert.equal((await done43(p, ['pm', 'inbox'])).items.find((i: any) => i.id === q.id).state, 'waits on the user');
    const since = (await done43(p, ['sec', 'next'], generation)).revision;
    const words = await done43(p, ['pm', 'say', 'The transform change was intentional', '--tag', 'instruction']);
    await done43(p, ['pm', 'reply', q.id, 'Yes, it was intentional.', '--words', words.words, '--op', 'reply-once']);
    assert.equal((await command43(p, ['pm', 'reply', q.id, 'Yes, it was intentional.', '--words', words.words, '--op', 'reply-once'])).replayed, true);
    assert.ok(!(await done43(p, ['pm', 'inbox'])).items.some((i: any) => i.id === q.id));
    const next = await done43(p, ['sec', 'next'], generation);
    assert.equal(next.replies.find((r: any) => r.id === q.id).words, words.words);
    const wait = await done43(p, ['sec', 'wait', '--since', String(since), '--timeout', '0'], generation);
    assert.equal(wait.timedOut, false); assert.ok(wait.replies.some((r: any) => r.id === q.id));
    assert.equal((await command43(p, ['pm', 'reply', q.id, 'Changed answer'])).error.code, 'NOT_ALLOWED');
    const before = {channel: channel(p.ctx), inbox: pmInbox(p.ctx)};
    const tail = p.ctx.memory.stmt('SELECT hash FROM log ORDER BY rev DESC LIMIT 1').get();
    p.ctx.memory.rebuild();
    assert.deepEqual({channel: channel(p.ctx), inbox: pmInbox(p.ctx)}, before);
    assert.deepEqual(p.ctx.memory.stmt('SELECT hash FROM log ORDER BY rev DESC LIMIT 1').get(), tail, 'new channel records fold without rewriting history');
    await done43(p, ['pm', 'secretary', 'start', '--replace']);
    assert.equal((await command43(p, ['sec', 'ask-pm', 'Late question'], generation)).error.code, 'NOT_ALLOWED');
  } finally {p.cleanup();}
});

test('R1.5 applied exploration direction answers resolve their notices; unlinked PM notices can be acknowledged', async () => {
  const p = project43();
  try {
    await startDirectionExploration(p);
    const generation = await live43(p), sec = secretary43(p, generation);
    try {
      await step(sec, 'researcher-author', () => ({step: 'submit', message: 'design', artifact: 'cache v1', dispositions: [], directionQuestions: ['Should this be distributed?'], attempts: []}));
      await secNext(sec);
      const notice = listNotices(sec.memory, sec.memory.data, {audience: 'pm'}).find((n) => n.category === 'exploration-direction-question')!;
      assert.ok(notice);
      const event = (await sec.ports().ledger.events<any>({mission: M, line: 'secretary', event: 'escalation'})).find((e) => e.body.source === 'exploration-direction')!;
      assert.equal((await command43(p, ['pm', 'inbox', '--ack', notice.id])).error.code, 'NOT_ALLOWED', 'linked notices resolve through their decision');
      await done43(p, ['pm', 'answer', M, event.key, '--option', 'answer', '--by', 'pm', '--no-words', '--reason', 'minor topology choice', '--instructions', 'Keep it local.']);
      await secNext(sec);
      assert.ok(!(await done43(p, ['pm', 'inbox'])).items.some((i: any) => i.id === notice.id), 'the applied direction answer must remove its PM notice');
      await sec.ports().ledger.notify({mission: M, category: 'plan-structure-change', key: 'legacy-unlinked', wi: null, trigger: 'historical unlinked PM notice', defaultAction: 'discuss with PM', detail: {}});
      const unlinked = listNotices(sec.memory, sec.memory.data, {audience: 'pm'}).find((n) => n.trigger === 'historical unlinked PM notice')!;
      await done43(p, ['pm', 'inbox', '--ack', unlinked.id]);
      assert.ok(!(await done43(p, ['pm', 'inbox'])).items.some((i: any) => i.id === unlinked.id));
    } finally {sec.memory.close();}
  } finally {p.cleanup();}
});

test('R1.5 a direction notice with several escalations resolves only after every answer', async () => {
  const p = project43();
  try {
    await startDirectionExploration(p);
    const generation = await live43(p), sec = secretary43(p, generation);
    try {
      await step(sec, 'researcher-author', () => ({step: 'submit', message: 'design', artifact: 'cache v1', dispositions: [], directionQuestions: [], attempts: []}));
      await step(sec, 'crititor', () => ({findings: [{severity: 'serious', class: 'internal contradiction', title: 'ordering', basis: 'cache operations', consequence: 'stale reads', direction: 'choose ordering', evidence: []}], rechecks: [], settled: [], reply: 'one finding'}));
      await step(sec, 'researcher-author', (c) => ({step: 'submit', message: 'ask about scope', artifact: 'cache v2', dispositions: c.openFindings.map((f: any) => ({finding: f.id, action: 'escalate', question: 'Can ordering be relaxed?', note: 'needs a direction choice'})), directionQuestions: ['Should this be distributed?'], attempts: []}));
      await secNext(sec);
      const notice = listNotices(sec.memory, sec.memory.data, {audience: 'pm'}).find((n) => n.category === 'exploration-direction-question')!;
      const questions = (await sec.ports().ledger.events<any>({mission: M, line: 'secretary', event: 'escalation'})).filter((e) => e.body.source === 'exploration-direction');
      assert.equal(questions.length, 2);
      for (let n = 0; n < questions.length; n++) {
        await done43(p, ['pm', 'answer', M, questions[n]!.key, '--option', 'answer', '--by', 'pm', '--no-words', '--reason', 'minor choice', '--instructions', 'Keep the original direction.']);
        await secNext(sec);
        assert.equal(pmInbox(sec).some((i) => i.id === notice.id), n === 0, 'one answered question does not resolve its unanswered companion');
      }
    } finally {sec.memory.close();}
  } finally {p.cleanup();}
});
