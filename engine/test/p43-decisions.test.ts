import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { answerByPm, carryOut, commitCarrying, decisionFor, grantForDecision, markApplied, secretaryStep, raiseEscalation } from '../src/flow/secretary.ts';
import { appendRecords, loopState } from '../src/memory/index.ts';
import { builders } from './labels-fixtures.ts';
import { dispatchView, recordSeatHandBack } from '../src/process/seat.ts';
import { pmGrant, pmRequirement, pmSay, pmDispatch, pmRelease } from '../src/process/pm.ts';
import { readAll, startAddMission, readyOf } from './process-fixtures.ts';
import { secNext } from '../src/process/secretary.ts';
import { project43, command43, done43, live43, secretary43, escalation43 } from './p43-fixtures.ts';
import { assignTags } from '../src/memory/words.ts';
import { secretaryProblems } from '../src/seat/cards/secretary.ts';
import { secretary as scripted } from '../src/flow/scripted.ts';

test('resident decision card/read/decide enforces must-read and one round’s receipts; ask-pm/ask-user route to PM', async () => {
  const p = project43();
  try {
    await escalation43(p);
    const id = await live43(p);
    const card = await done43(p, ['sec','card','choice','--op','claim'], id);
    const same = await done43(p, ['sec','card','choice'], id);
    assert.equal(card.dispatch, same.dispatch);
    const bad = await command43(p, ['sec','decide','choice','--option','ask-user','--classification','needs-pm','--reason','direction belongs to PM'], id);
    assert.equal(bad.error.code, 'NOT_ALLOWED'); assert.ok(bad.error.detail.problems.some((s: string) => s.includes('must-read')));
    const v = dispatchView(p.ctx, card.dispatch);
    assert.ok((v.card.options as any[]).some((o) => o.id === 'ask-pm'));
    for (const material of v.card.materials as {id: string; pages: number}[]) for (let page = 1; page <= material.pages; page++) await done43(p, ['sec','read','choice',material.id,'--page',String(page)], id);
    const r = await done43(p, ['sec','decide','choice','--option','ask-pm','--classification','needs-pm','--reason','the PM decides direction'], id);
    assert.equal(r.kind, 'recorded');
    assert.ok((await done43(p, ['pm','inbox'])).items.some((i: any) => i.id === 'm1/choice'));
    await done43(p, ['pm','inbox','--asked-user','m1/choice']);
    assert.equal((await done43(p, ['pm','inbox'])).items.find((i: any) => i.id === 'm1/choice').state, 'waits on the user');
    const w = await done43(p, ['pm','say','Use the simple answer','--tag','instruction']);
    await done43(p, ['pm','answer','m1','choice','--by','user','--words',w.words,'--option','answer','--instructions','simple']);
    assert.equal((await done43(p, ['pm','inbox'])).items.length, 0);
  } finally {p.cleanup();}
});

test('replacement mid-decision requires ending the old claim; new current-round reads start empty', async () => {
  const p = project43();
  try {
    await escalation43(p); const first = await live43(p);
    const d = await done43(p, ['sec','card','choice'], first); readAll(p.ctx, d.dispatch);
    const replacement = await done43(p, ['pm','secretary','start','--replace']);
    await done43(p, ['sec','session'], replacement.generation);
    await assert.rejects(() => recordSeatHandBack(p.ctx, d.dispatch, {report: 'late decision', fields: {option: 'accept', classification: 'detail', authorization: null, reason: 'old generation', instructions: '', grantExtra: 0, notice: '', mayMatter: false}, advance: false}), /live Secretary/);
    assert.equal((await command43(p, ['sec','card','choice'], replacement.generation)).error.code, 'NOT_ALLOWED');
    await done43(p, ['sec','release',d.dispatch,'--ended'], replacement.generation);
    const fresh = await done43(p, ['sec','card','choice'], replacement.generation);
    assert.notEqual(fresh.dispatch, d.dispatch);
    const result = await command43(p, ['sec','decide','choice','--option','accept','--reason','fine'], replacement.generation);
    assert.equal(result.error.code, 'NOT_ALLOWED'); assert.ok(result.error.detail.problems.some((s: string) => s.includes('must-read')));
  } finally {p.cleanup();}
});

test('PM answer recorded without a ruling; carryOut writes j.pm and the effect in the same transaction', async () => {
  const p = project43();
  try {
    const b = builders(p.ctx.memory);
    p.ctx.memory.write({}, (tx) => appendRecords(tx, [b.product('P'), b.judge('negative','P',{verdict: 'fail'})]));
    await escalation43(p, 'ruling', {position: {target: 'P', review: 'reviewer', revokes: 'negative'}});
    const id = await live43(p);
    const w = await done43(p, ['pm','say','Accept the chosen approach','--tag','decision@m1']);
    await done43(p, ['pm','answer','m1','ruling','--by','pm','--words',w.words,'--reason','the words support acceptance','--option','accept']);
    const find = () => p.ctx.memory.stmt("SELECT op FROM log WHERE kind = 'judgment' AND json_extract(record,'$.judgment') = 'j.pm.ruling'").get();
    assert.equal(find(), undefined, '4.2 has no pm-answer; premature ruling would corrupt provenance');
    const sec = secretary43(p, id);
    try {await markApplied(flowCtx(sec.ports(), 'm1' as MissionId), 'ruling', {option: 'accept'});} finally {sec.memory.close();}
    const judgment = find() as {op: string}; assert.ok(judgment);
    const applied = p.ctx.memory.stmt("SELECT op FROM log WHERE kind = 'flow.event' AND json_extract(record,'$.event') = 'applied' AND json_extract(record,'$.key') = 'ruling'").get() as {op: string};
    assert.equal(judgment.op, applied.op);
    const why = await done43(p, ['read','why','j.pm.ruling']); assert.match(JSON.stringify(why), /PM|pm/);
  } finally {p.cleanup();}
});

test('user answer takes precedence before PM application and leaves no PM ruling', async () => {
  const p = project43();
  try {
    await escalation43(p); const id = await live43(p);
    const w = await done43(p, ['pm','say','The PM may choose','--tag','decision@m1']);
    await done43(p, ['pm','answer','m1','choice','--by','pm','--words',w.words,'--reason','supported','--option','accept']);
    const user = await done43(p, ['pm','say','Answer with the other approach','--tag','instruction']);
    await done43(p, ['pm','answer','m1','choice','--by','user','--words',user.words,'--option','answer','--instructions','other']);
    const sec = secretary43(p, id);
    try {
      const ctx = flowCtx(sec.ports(), 'm1' as MissionId);
      assert.equal((await decisionFor(ctx, 'choice'))?.by, 'user');
      await markApplied(ctx, 'choice', {option: 'answer'});
    } finally {sec.memory.close();}
    assert.equal(p.ctx.memory.stmt("SELECT 1 FROM log WHERE kind = 'judgment' AND json_extract(record,'$.executor') = 'pm'").get(), undefined);
    const later = await command43(p, ['pm','answer','m1','choice','--by','user','--words',user.words,'--option','accept']);
    assert.equal(later.error.code, 'already-applied');
  } finally {p.cleanup();}
});

test('B.4 stale PM words reject round 1, reopen round 2, and permit a fresh answer; PM reads do not reject', async () => {
  const p = project43();
  try {
    await escalation43(p); const id = await live43(p);
    const old = await done43(p, ['pm','say','Favor simple work','--tag','decision@m1']);
    await done43(p, ['pm','answer','m1','choice','--by','pm','--words',old.words,'--reason','supported','--option','accept']);
    await done43(p, ['pm','say','Favor a different approach','--tag','decision@m1','--supersedes',`${old.words}#1`]);
    const count = () => Number((p.ctx.memory.stmt("SELECT COUNT(*) AS n FROM flow_events WHERE event = 'pm-answer-rejected'").get() as {n: number}).n);
    await done43(p, ['read','blocked']); assert.equal(await decisionFor(flowCtx(p.ctx.ports(), 'm1' as MissionId), 'choice'), null); assert.equal(count(), 0);
    const sec = secretary43(p, id);
    try {assert.equal(await decisionFor(flowCtx(sec.ports(), 'm1' as MissionId), 'choice'), null);} finally {sec.memory.close();}
    assert.equal(count(), 1);
    const inbox = (await done43(p, ['pm','inbox'])).items.find((i: any) => i.id === 'm1/choice');
    assert.equal(inbox.round, 2); assert.match(inbox.text, /words it rested on changed/);
    assert.match(JSON.stringify(await done43(p, ['read','show','decision','m1/choice'])), /rejected: the words it rested on changed/);
    await done43(p, ['pm','answer','m1','choice','--by','pm','--no-words','--reason','minor impact; sensible default','--option','accept']);
    assert.ok(p.ctx.memory.stmt("SELECT 1 FROM flow_events WHERE event = 'pm-answer' AND key = 'choice#2'").get());
    const ctx = secretary43(p, id);
    try {await markApplied(flowCtx(ctx.ports(), 'm1' as MissionId), 'choice', {option: 'accept'});} finally {ctx.memory.close();}
    assert.match((await done43(p, ['pm','session','--filled-by','h/pm'])).layer1, /by the PM, no words on record/);
  } finally {p.cleanup();}
});

test('PM grant does not consume or obey the Secretary’s one grant; new resident cards refuse important-within-authority', async () => {
  const p = project43();
  try {
    await escalation43(p); const id = await live43(p);
    const w = await done43(p, ['pm','say','Allow another attempt','--tag','decision@m1']);
    await done43(p, ['pm','grant','L','env-retry','--extra','3','--by','pm','--words',w.words]);
    assert.equal(loopState(p.ctx.memory, 'L', 'env-retry').secretaryGrantUsed, false);
    await p.ctx.ports().scheduler.grant({op: 'sec-grant', lineage: 'L', loop: 'env-retry', extra: 1, by: 'secretary', reason: 'one grant'});
    await done43(p, ['pm','grant','L','env-retry','--extra','2','--by','pm','--words',w.words]);
    const d = await done43(p, ['sec','card','choice'], id);
    const card = dispatchView(p.ctx, d.dispatch).card as any;
    assert.ok(secretaryProblems(card, scripted(card, 'accept', {classification: 'important-within-authority'}), new Set()).some((s) => s.includes('new decisions')));
  } finally {p.cleanup();}
});

test('A.5 rejected Secretary authority queues retry1; sec card/read/decide bind to that round, not the original receipts', async () => {
  const p = project43();
  try {
    await done43(p, ['pm','mission','open','m1']);
    const w = await done43(p, ['pm','say','Details are yours','--tag','decision@m1']);
    await done43(p, ['pm','requirement','add','m1','authority','--type','authorization','--text','details','--quote','Details are yours','--words',w.words]);
    await escalation43(p); const id = await live43(p);
    const first = await done43(p, ['sec','card','choice'], id); readAll(p.ctx, first.dispatch);
    await done43(p, ['sec','decide','choice','--option','accept','--authorization','item.m1.authority','--reason','within the plan'], id);
    await done43(p, ['pm','requirement','withdraw','m1','authority','--reason','withdrawn on the user’s instruction','--words',w.words]);
    const sec = secretary43(p, id);
    try {assert.equal(await decisionFor(flowCtx(sec.ports(), 'm1' as MissionId), 'choice'), null);} finally {sec.memory.close();}
    const retry = await done43(p, ['sec','card','choice'], id);
    assert.match(retry.step, /retry1$/); assert.notEqual(retry.dispatch, first.dispatch);
    const missing = await command43(p, ['sec','decide','choice','--option','accept','--reason','current facts'], id);
    assert.equal(missing.error.code, 'NOT_ALLOWED'); assert.ok(missing.error.detail.problems.some((p: string) => p.includes('must-read')));
    const card = dispatchView(p.ctx, retry.dispatch).card as any;
    for (const m of card.materials) for (let n = 1; n <= m.pages; n++) await done43(p, ['sec','read','choice',m.id,'--page',String(n)], id);
    assert.equal((await done43(p, ['sec','decide','choice','--option','accept','--reason','current facts'], id)).kind, 'recorded');
    assert.ok(p.ctx.memory.stmt("SELECT 1 FROM flow_events WHERE event = 'decision' AND key = 'choice#1'").get());
  } finally {p.cleanup();}
});

test('PM grant and ruling effects are fenced together when a user answers after preparation', async () => {
  const p = project43();
  try {
    await escalation43(p); const id = await live43(p);
    const w = await done43(p, ['pm','say','Allow more work','--tag','decision@m1']);
    await done43(p, ['pm','answer','m1','choice','--by','pm','--words',w.words,'--reason','supported','--option','grant','--extra','2']);
    const sec = secretary43(p, id);
    try {
      const ctx = flowCtx(sec.ports(), 'm1' as MissionId);
      assert.equal((await decisionFor(ctx, 'choice'))?.by, 'pm');
      const grant = await grantForDecision(ctx, {op: 'race-grant', lineage: 'race-lineage', loop: 'env-retry', by: 'pm', extra: 2, reason: 'supported'});
      const carry = await carryOut(ctx, 'choice', {option: 'grant'}, grant.records);
      assert.equal(sec.memory.stmt("SELECT 1 FROM log WHERE kind = 'loop.grant' AND json_extract(record,'$.lineage') = 'race-lineage'").get(), undefined);
      const user = await done43(p, ['pm','say','Accept without another attempt','--tag','instruction']);
      await done43(p, ['pm','answer','m1','choice','--by','user','--words',user.words,'--option','accept']);
      await assert.rejects(() => commitCarrying(ctx, 'race-apply', [], [carry]), (e: any) => e.code === 'STALE_REQUEST');
      assert.equal(sec.memory.stmt("SELECT 1 FROM log WHERE kind = 'loop.grant' AND json_extract(record,'$.lineage') = 'race-lineage'").get(), undefined, 'no PM grant survives a pre-application user override');
      await markApplied(flowCtx(sec.ports(), 'm1' as MissionId), 'choice', {option: 'accept'});
    } finally {sec.memory.close();}
  } finally {p.cleanup();}
});

test('a PM grant on exhausted re-dispatch requeues the released seat in its application write', async () => {
  const p = project43();
  try {
    await startAddMission(p.ctx, 'm1');
    const first = await readyOf(p.ctx, 'calibrator-1');
    for (let i = 0; i < 3; i++) {const d = pmDispatch(p.ctx, first.step); await pmRelease(p.ctx, d.dispatch, 'ended');}
    const id = await live43(p), ctx = secretary43(p, id);
    try {
      const next = await secNext(ctx);
      const secTask = next.ready.find((r) => r.kind === 'secretary')!;
      const escalation = secTask.step.slice('sec.'.length);
      const d = await done43(p, ['sec','card',escalation], id); readAll(ctx, d.dispatch);
      await done43(p, ['sec','decide',escalation,'--option','ask-pm','--reason','more attempts belong to the PM'], id);
      const w = await done43(p, ['pm','say','Try that review again','--tag','decision@m1']);
      await done43(p, ['pm','answer','m1',escalation,'--by','pm','--words',w.words,'--reason','the words support another try','--option','grant','--extra','2']);
      const after = await secNext(ctx);
      assert.ok(after.ready.some((r) => r.step === first.step));
      const grant = ctx.memory.stmt("SELECT op FROM log WHERE kind = 'loop.grant' AND json_extract(record,'$.by') = 'pm'").get() as {op: string};
      const applied = ctx.memory.stmt("SELECT op FROM log WHERE kind = 'flow.event' AND json_extract(record,'$.event') = 'applied' AND json_extract(record,'$.key') = ?").get(escalation) as {op: string};
      assert.equal(grant.op, applied.op);
    } finally {ctx.memory.close();}
  } finally {p.cleanup();}
});
