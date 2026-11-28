// 4.4 (F9, issue 62): a decision takes effect when it is made. The hand-back of a Secretary decision
// step the seat way (`mp seat <D> handback`) under the live generation's identity runs the same flow
// step as `mp sec decide`; the PM inbox lists a decision sent to the PM from the moment its hand-back is
// recorded; the outputs say what happened.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { answerEscalation, decisionFor, markApplied, raiseEscalation } from '../src/flow/secretary.ts';
import { openProcess } from '../src/process/context.ts';
import { answerOutcome } from '../src/process/decisions.ts';
import { pmDispatch, pmRelease } from '../src/process/pm.ts';
import { ENV_A, handBack, readAll, startAddMission, readyOf, type ProcessProject } from './process-fixtures.ts';
import { secNext, stopSecretary } from '../src/process/secretary.ts';
import { project43, command43, done43, escalation43, live43, secretary43 } from './p43-fixtures.ts';

/** The mission with its Calibrator ① re-dispatches used up: a loop-exhausted escalation (grant / ask-pm), its round claimed by the live Secretary and every page read. */
async function exhausted(p: ProcessProject): Promise<{ id: string; escalation: string; dispatch: string; step: string }> {
  await startAddMission(p.ctx, 'm1');
  const first = await readyOf(p.ctx, 'calibrator-1');
  for (let i = 0; i < 3; i++) { const d = pmDispatch(p.ctx, first.step); await pmRelease(p.ctx, d.dispatch, 'ended'); }
  const id = await live43(p);
  const ctx = secretary43(p, id);
  try {
    const next = await secNext(ctx);
    const escalation = next.ready.find((r) => r.kind === 'secretary')!.step.slice('sec.'.length);
    const d = await done43(p, ['sec', 'card', escalation], id);
    readAll(ctx, d.dispatch);
    return { id, escalation, dispatch: d.dispatch, step: first.step };
  } finally { ctx.memory.close(); }
}

/** `mp seat <D> handback --report --result` under an identity (null: no MP_SECRETARY). */
async function seatWay(p: ProcessProject, dispatch: string, fields: unknown, identity: string | null) {
  const dir = join(p.ctx.memory.paths.tmp, dispatch);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), '# Decision\n');
  writeFileSync(join(dir, 'result.json'), JSON.stringify(fields));
  return command43(p, ['seat', dispatch, 'handback', '--report', `.mission-pipeline/tmp/${dispatch}/report.md`, '--result', `.mission-pipeline/tmp/${dispatch}/result.json`], identity);
}

const decisionEvent = (p: ProcessProject, key: string) => p.ctx.memory.stmt("SELECT 1 FROM flow_events WHERE line = 'secretary' AND event = 'decision' AND key = ?").get(key);
const applied = (p: ProcessProject, key: string) => p.ctx.memory.stmt("SELECT 1 FROM flow_events WHERE line = 'secretary' AND event = 'applied' AND key = ?").get(key);
const askPm = { option: 'ask-pm', classification: 'needs-pm', authorization: null, reason: 'more attempts belong to the PM', instructions: '', grantExtra: 0, notice: 'Question: try the first review again? Options: grant runs it again; nothing else moves. Words: W-1. I would grant once.', mayMatter: false };
const grant = { option: 'grant', classification: 'detail', authorization: null, reason: 'one more try within the plan', instructions: '', grantExtra: 1, notice: '', mayMatter: false };

test('issue 62: a needs-pm decision handed back the seat way is recorded in the same command and listed in the PM inbox at once', async () => {
  const p = project43();
  try {
    const s = await exhausted(p);
    const r = await seatWay(p, s.dispatch, askPm, s.id);
    assert.equal(r.code, 0, JSON.stringify(r));
    assert.ok(decisionEvent(p, s.escalation), 'the decision is recorded by the hand-back itself, as mp sec decide records it');
    assert.equal(r.result.decision.state, 'to-pm');
    assert.match(r.result.decision.text, /sent to the PM/);
    const item = (await done43(p, ['pm', 'inbox'])).items.find((i: any) => i.id === `m1/${s.escalation}`);
    assert.ok(item, 'the PM inbox lists the escalation');
  } finally { p.cleanup(); }
});

test('a decision the flow carries out takes effect in the hand-back of the seat way, as with mp sec decide, and both say so', async () => {
  const p = project43();
  try {
    const s = await exhausted(p);
    const r = await seatWay(p, s.dispatch, grant, s.id);
    assert.equal(r.code, 0, JSON.stringify(r));
    assert.ok(applied(p, s.escalation), 'the Secretary grant is applied in the same command');
    assert.equal(r.result.decision.state, 'applied');
    assert.match(r.result.decision.text, /recorded and applied \(grant\)/);
    const ctx = secretary43(p, s.id);
    try { assert.ok((await secNext(ctx)).ready.some((x) => x.step === s.step), 'the granted step is ready again'); } finally { ctx.memory.close(); }
  } finally { p.cleanup(); }
  const q = project43();
  try {
    const s = await exhausted(q);
    const r = await command43(q, ['sec', 'decide', s.escalation, '--option', 'grant', '--extra', '1', '--reason', 'one more try within the plan'], s.id);
    assert.equal(r.code, 0, JSON.stringify(r));
    assert.equal(r.result.decision.state, 'applied');
    assert.ok(applied(q, s.escalation));
  } finally { q.cleanup(); }
});

test('a decision handed back outside the live identity waits for the next pass, says why, and the PM inbox reads it from the hand-back', async () => {
  const p = project43();
  try {
    const s = await exhausted(p);
    const r = await seatWay(p, s.dispatch, askPm, null);
    assert.equal(r.code, 0, JSON.stringify(r));
    assert.equal(decisionEvent(p, s.escalation), undefined, 'no pass ran: the PM side does not reconcile while a Secretary is live');
    assert.equal(r.result.decision.state, 'to-pm');
    assert.match(r.result.decision.text, /without the live Secretary's identity/);
    const item = (await done43(p, ['pm', 'inbox'])).items.find((i: any) => i.id === `m1/${s.escalation}`);
    assert.ok(item, 'listed from the hand-back before the decision event exists');
    assert.equal(item.brief.notice, askPm.notice);
    const g = await seatWay(p, s.dispatch, askPm, null);
    assert.equal(g.result.repeated, true);
    const ctx = secretary43(p, s.id);
    try { await secNext(ctx); } finally { ctx.memory.close(); }
    assert.ok(decisionEvent(p, s.escalation), 'the Secretary\'s next pass records it');
    assert.equal((await done43(p, ['pm', 'inbox'])).items.filter((i: any) => i.id === `m1/${s.escalation}`).length, 1, 'still one item');
  } finally { p.cleanup(); }
});

/** A command's text output (no --json). */
async function text43(p: ProcessProject, args: string[], identity: string | null = null): Promise<string> {
  const r = await runCli(args, { cwd: p.dir, env: { MP_SECRETARY: identity ?? '' }, process: { observe: () => ENV_A, ident: { name: 'test', email: 'test@test' } } });
  assert.equal(r.exitCode, 0, r.stderr || r.stdout);
  return r.stdout;
}

test('mp pm answer under a live Secretary records without reconciling and says the next pass applies it; in 4.2 mode it says applied', async () => {
  const p = project43();
  try {
    await escalation43(p);
    const id = await live43(p);
    const d = await done43(p, ['sec', 'card', 'choice'], id);
    const sec = secretary43(p, id);
    try { readAll(sec, d.dispatch); } finally { sec.memory.close(); }
    await done43(p, ['sec', 'decide', 'choice', '--option', 'ask-pm', '--reason', 'the PM decides', '--notice', 'Which detail? answer it, or accept'], id);
    const w = await done43(p, ['pm', 'say', 'Use the simple detail', '--tag', 'decision@m1']);
    const out = await text43(p, ['pm', 'answer', 'm1', 'choice', '--by', 'pm', '--words', w.words, '--reason', 'the words say so', '--option', 'answer', '--instructions', 'simple']);
    assert.match(out, /recorded \(answer, W-\d+\); the Secretary’s next pass applies it\./);
    assert.equal(p.ctx.memory.stmt("SELECT 1 FROM flow_events WHERE line = 'secretary' AND event = 'applied' AND key = 'choice'").get(), undefined, 'the PM command did not reconcile');
    // the Secretary's view of an escalation waiting on the user names no Secretary command that does not exist
    await escalation43(p, 'other');
    const d2 = await done43(p, ['sec', 'card', 'other'], id);
    const sec2 = secretary43(p, id);
    try { readAll(sec2, d2.dispatch); } finally { sec2.memory.close(); }
    await done43(p, ['sec', 'decide', 'other', '--option', 'ask-pm', '--reason', 'the user decides'], id);
    await done43(p, ['pm', 'inbox', '--asked-user', 'm1/other']);
    const next = await text43(p, ['sec', 'next'], id);
    assert.match(next, /m1 other: .*waits for the PM to record the answer/);
    assert.doesNotMatch(next, /mp sec answer/);
  } finally { p.cleanup(); }
  const q = project43();
  try {
    await startAddMission(q.ctx, 'm1');
    const first = await readyOf(q.ctx, 'calibrator-1');
    for (let i = 0; i < 3; i++) { const d = pmDispatch(q.ctx, first.step); await pmRelease(q.ctx, d.dispatch, 'ended'); }
    const esc = (await readyOf(q.ctx, 'secretary')).step.slice('sec.'.length);
    const w = await done43(q, ['pm', 'say', 'Try that review once more', '--tag', 'instruction']);
    const out = await text43(q, ['pm', 'answer', 'm1', esc, '--by', 'user', '--words', w.words, '--option', 'grant', '--extra', '1']);
    assert.match(out, /recorded \(grant, W-\d+\); applied\./);
  } finally { q.cleanup(); }
});

test('a grant handed back outside the live identity says the next pass applies it', async () => {
  const p = project43();
  try {
    const s = await exhausted(p);
    const r = await seatWay(p, s.dispatch, grant, null);
    assert.equal(r.result.decision.state, 'pending');
    assert.match(r.result.decision.text, /the next pass applies it: this command ran without the live Secretary's identity/);
    assert.equal(applied(p, s.escalation), undefined);
    const ctx = secretary43(p, s.id);
    try { await secNext(ctx); } finally { ctx.memory.close(); }
    assert.ok(applied(p, s.escalation));
  } finally { p.cleanup(); }
});

test('review p1-1: a Secretary retired during a seat-way hand-back applies nothing more: each write of its pass is fenced to the live generation', async () => {
  const p = project43();
  try {
    const s = await exhausted(p);
    // a seat command's process, as `mp seat <D> handback` opens it, under the live identity
    const sec = openProcess(p.dir, { secretary: s.id, seatResult: true, observe: () => ENV_A });
    try {
      const write = sec.memory.write.bind(sec.memory);
      let retired = false;
      // the PM retires the generation once the pass has started: just before its first flow write
      (sec.memory as { write: typeof write }).write = ((req: Parameters<typeof write>[0], fn: Parameters<typeof write>[1]) => {
        if (!retired && String((req as { op?: unknown }).op ?? '').startsWith('flow:')) { retired = true; stopSecretary(p.ctx, { op: 'retire', gone: true }); }
        return write(req, fn);
      }) as typeof write;
      const a = await handBack(sec, s.dispatch, grant);
      assert.equal(a.kind, 'recorded');
      assert.ok(retired);
      assert.equal(applied(p, s.escalation), undefined, 'the retired generation applied nothing');
      assert.equal(a.kind === 'recorded' ? a.decision?.state : null, 'pending');
      assert.match(a.kind === 'recorded' ? a.decision?.text ?? '' : '', new RegExp(`generation ${s.id} was retired during this command`));
    } finally { sec.memory.close(); }
  } finally { p.cleanup(); }
});

test('review p1-4: a decision the flow hands to the PM says so, with the recorded reason', async () => {
  const p = project43();
  try {
    const s = await exhausted(p);
    // the Secretary's one grant on the lineage is spent after this card was claimed (another escalation of the lineage)
    const sec = secretary43(p, s.id);
    try { await sec.ports().scheduler.grant({ op: 'other-escalation', lineage: 'plan.m1.1', loop: 'env-retry', extra: 1, by: 'secretary', reason: 'another escalation of the lineage' }); } finally { sec.memory.close(); }
    const r = await seatWay(p, s.dispatch, grant, s.id);
    assert.equal(r.code, 0, JSON.stringify(r));
    assert.equal(r.result.decision.state, 'to-pm');
    assert.match(r.result.decision.text, /the flow handed it to the PM \(mp pm inbox lists it\): .*refused/);
    assert.ok((await done43(p, ['pm', 'inbox'])).items.some((i: any) => i.id === `m1/${s.escalation}` && /refused/.test(i.brief.handedOver)));
  } finally { p.cleanup(); }
});

test('review p1-3: mp pm answer names the answer that was carried out: a user answer recorded first wins, and the PM answer is not called applied', async () => {
  const p = project43();
  try {
    await startAddMission(p.ctx, 'm1');
    const first = await readyOf(p.ctx, 'calibrator-1');
    for (let i = 0; i < 3; i++) { const d = pmDispatch(p.ctx, first.step); await pmRelease(p.ctx, d.dispatch, 'ended'); }
    const esc = (await readyOf(p.ctx, 'secretary')).step.slice('sec.'.length);
    const user = await done43(p, ['pm', 'say', 'Run it once more', '--tag', 'instruction']);
    // the user's answer is recorded by another process and not carried out yet
    await answerEscalation(p.ctx.ports(), { mission: 'm1' as MissionId, escalation: esc, option: 'grant', grantExtra: 1, words: `Run it once more (${user.words})` });
    const w = await done43(p, ['pm', 'say', 'Two more tries are fine', '--tag', 'decision@m1']);
    const out = await text43(p, ['pm', 'answer', 'm1', esc, '--by', 'pm', '--words', w.words, '--reason', 'the words allow it', '--option', 'grant', '--extra', '2']);
    assert.doesNotMatch(out, /; applied\./);
    assert.match(out, new RegExp(`not carried out: the user's answer \\(grant\\) was carried out instead; mp read show decision m1/${esc}`));
    assert.equal((p.ctx.memory.stmt("SELECT COUNT(*) AS n FROM flow_events WHERE line = 'secretary' AND event = 'applied' AND key = ?").get(esc) as { n: number }).n, 1);
  } finally { p.cleanup(); }
});

test('review round 2, p1-3: the outcome is of this very answer: a rejected round does not take the credit of the round that replaced it, and a moot application is not "applied"', async () => {
  const p = project43();
  try {
    await escalation43(p);
    const id = await live43(p);
    const old = await done43(p, ['pm', 'say', 'Favor the simple choice', '--tag', 'decision@m1']);
    const first = await done43(p, ['pm', 'answer', 'm1', 'choice', '--by', 'pm', '--words', old.words, '--reason', 'supported', '--option', 'accept']);
    assert.equal(first.round, 1);
    await done43(p, ['pm', 'say', 'Favor another choice', '--tag', 'decision@m1', '--supersedes', `${old.words}#1`]);
    const sec = secretary43(p, id);
    try {
      assert.equal(await decisionFor(flowCtx(sec.ports(), 'm1' as MissionId), 'choice'), null, 'round 1 is rejected: its words changed');
      // another process records round 2, and the Secretary applies it, before the first command printed
      await done43(p, ['pm', 'answer', 'm1', 'choice', '--by', 'pm', '--no-words', '--reason', 'minor', '--option', 'answer', '--instructions', 'simply']);
      await markApplied(flowCtx(sec.ports(), 'm1' as MissionId), 'choice', { option: 'answer' });
    } finally { sec.memory.close(); }
    const r = p.ctx.memory.read((db) => answerOutcome(db, p.ctx.memory.data, { mission: 'm1', escalation: 'choice', by: 'pm', round: 1, option: 'accept', resident: true }));
    assert.equal(r.applied, false);
    assert.match(r.text, /round 1 was rejected, the words it rested on changed; the PM's answer of round 2 \(answer\) was carried out instead; mp read show decision m1\/choice/);
  } finally { p.cleanup(); }
  const q = project43();
  try {
    await done43(q, ['pm', 'mission', 'open', 'm1']);
    await raiseEscalation(flowCtx(q.ctx.ports(), 'm1' as MissionId), { id: 'risk', source: 'reviewer-needs-decision', lineage: 'L', subject: 'task:t', summary: 'accept the attempt with its findings?', reasons: ['a finding'], options: ['accept-risk', 'ask-user'] });
    const id = await live43(q);
    const a = await done43(q, ['pm', 'answer', 'm1', 'risk', '--by', 'pm', '--no-words', '--reason', 'minor', '--option', 'accept-risk']);
    const sec = secretary43(q, id);
    // a grant on a dependency made the acceptance moot: the flow records it applied as moot (execution.ts)
    try { await markApplied(flowCtx(sec.ports(), 'm1' as MissionId), 'risk', { option: 'accept-risk', moot: true }); } finally { sec.memory.close(); }
    const r = q.ctx.memory.read((db) => answerOutcome(db, q.ctx.memory.data, { mission: 'm1', escalation: 'risk', by: 'pm', round: a.round, option: 'accept-risk', resident: true }));
    assert.equal(r.applied, false);
    assert.match(r.text, /carried out as moot: accept-risk had nothing left to act on/);
  } finally { q.cleanup(); }
});

test('review p1-5: a decision queued under a live Secretary and claimed by the PM after it retired gets the seat commands', async () => {
  const p = project43();
  try {
    await done43(p, ['pm', 'mission', 'open', 'm1']);
    const id = await live43(p);
    await escalation43(p);
    const queued = p.ctx.memory.stmt("SELECT card FROM tasks WHERE task = 'sec.choice'").get() as { card: string } | undefined;
    assert.ok(queued, 'queued while the Secretary is live');
    await done43(p, ['pm', 'secretary', 'stop', '--gone']);
    const d = pmDispatch(p.ctx, 'sec.choice', { filledBy: 'h/m' });
    const commands = d.card.slice(d.card.indexOf('## Your commands'));
    assert.match(commands, new RegExp(`mp seat ${d.dispatch} read <material>`));
    assert.match(commands, new RegExp(`mp seat ${d.dispatch} handback --stdin`));
    assert.doesNotMatch(commands, /mp sec (decide|read|card)/, 'no command that needs a live generation');
    assert.ok(id);
  } finally { p.cleanup(); }
});

test('a retried mp sec decide, mp pm answer and mp pm dispatch with the same --op replay their receipt', async () => {
  const p = project43();
  try {
    await escalation43(p);
    const id = await live43(p);
    const card = await done43(p, ['sec', 'card', 'choice', '--op', 'card-1'], id);
    const sec = secretary43(p, id);
    try { readAll(sec, card.dispatch); } finally { sec.memory.close(); }
    const decide = ['sec', 'decide', 'choice', '--option', 'ask-pm', '--reason', 'the PM decides', '--op', 'decide-1'];
    const first = await command43(p, decide, id);
    const again = await command43(p, decide, id);
    assert.equal(again.replayed, true, JSON.stringify(again));
    assert.deepEqual(again.result, first.result);
    const w = await done43(p, ['pm', 'say', 'Answer simply', '--tag', 'decision@m1']);
    const answer = ['pm', 'answer', 'm1', 'choice', '--by', 'pm', '--words', w.words, '--reason', 'the words say so', '--option', 'answer', '--instructions', 'simply', '--op', 'answer-1'];
    await done43(p, answer);
    assert.equal((await command43(p, answer)).replayed, true);
  } finally { p.cleanup(); }
  const q = project43();
  try {
    await startAddMission(q.ctx, 'm1');
    const step = (await readyOf(q.ctx, 'calibrator-1')).step;
    const dispatch = ['pm', 'dispatch', step, '--filled-by', 'h/m', '--op', 'dispatch-1'];
    const first = await command43(q, dispatch);
    const again = await command43(q, dispatch);
    assert.equal(again.replayed, true);
    assert.equal(again.result.dispatch, first.result.dispatch);
  } finally { q.cleanup(); }
});
