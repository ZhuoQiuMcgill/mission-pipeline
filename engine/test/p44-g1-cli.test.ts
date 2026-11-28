// 4.4 (G1): the commands of an ask of the Architect. `mp sec decide … --option ask-architect` and `mp pm answer …
// --option ask-architect --by pm` say that the Architect is asked, read from the task table; the Architect's step is
// a ready step like any other (`mp sec next`, `mp sec dispatch`); `mp seat <D> handback` of its reply says what
// became of it, read from its record; `mp read show escalation` lists the replies.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { flowEvents } from '../src/memory/index.ts';
import { ENV_A, readAll, type ProcessProject } from './process-fixtures.ts';
import { command43, done43, project43, secretary43 } from './p43-fixtures.ts';
import { constructorAsks, liveWithEscalation } from './p44-decision-fixtures.ts';

async function text43(p: ProcessProject, args: string[], identity: string | null = null): Promise<{ code: number; out: string }> {
  const r = await runCli(args, { cwd: p.dir, env: { MP_SECRETARY: identity ?? '' }, process: { observe: () => ENV_A, ident: { name: 'test', email: 'test@test' } } });
  return { code: r.exitCode, out: r.stdout + r.stderr };
}

/** A seat's hand-back through the two files form of `mp seat <D> handback`. */
async function handBackFiles(p: ProcessProject, dispatch: string, fields: unknown, identity: string | null = null): Promise<{ code: number; out: string }> {
  const dir = join(p.dir, '.mission-pipeline', 'tmp', dispatch);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), '# Report\n\nRead the plan and the task.\n');
  writeFileSync(join(dir, 'result.json'), JSON.stringify(fields));
  return text43(p, ['seat', dispatch, 'handback', '--report', `.mission-pipeline/tmp/${dispatch}/report.md`, '--result', `.mission-pipeline/tmp/${dispatch}/result.json`], identity);
}

test('the live Secretary asks the Architect: the decision says so, the step is dispatched like any other, and its answer is carried out as the escalation\'s answer', async () => {
  const p = project43();
  try {
    await constructorAsks(p, ['Should add accept strings of digits?']);
    const s = await liveWithEscalation(p);
    const d0 = await done43(p, ['sec', 'card', s.escalation], s.id);
    const sec = secretary43(p, s.id);
    try { readAll(sec, d0.dispatch); } finally { sec.memory.close(); }
    const refused = await command43(p, ['sec', 'decide', s.escalation, '--option', 'ask-architect', '--reason', 'a question of design'], s.id);
    assert.notEqual(refused.code, 0, 'an ask needs the instructions');
    const r = await done43(p, ['sec', 'decide', s.escalation, '--option', 'ask-architect', '--reason', 'a question of design', '--instructions', 'Does the plan let add accept digit strings?'], s.id);
    assert.equal(r.decision.state, 'asked', JSON.stringify(r.decision));
    assert.match(r.decision.text, /^recorded; the Architect is asked: step arch-ask\.m1\.[^ ]+\.s0 is queued; only the work it is about waits for its reply$/);
    const step = /step (arch-ask\.m1\.[^ ]+\.s0)/.exec(r.decision.text)![1]!;
    const next = await text43(p, ['sec', 'next', '--all'], s.id);
    assert.ok(next.out.includes(step), next.out);
    const d = await done43(p, ['sec', 'dispatch', step, '--filled-by', 'h/architect'], s.id);
    const card = (await text43(p, ['seat', d.dispatch, 'card'])).out;
    assert.ok(card.includes('card kind architect-answer'), card);
    assert.ok(card.includes('The Secretary asks you: Does the plan let add accept digit strings?'), card);
    const bad = await handBackFiles(p, d.dispatch, { reply: 'answer', text: 'No.', add: [] });
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /add: not a field of this hand-back/);
    const h = await handBackFiles(p, d.dispatch, { reply: 'answer', text: 'No: add takes numbers only; a digit string is refused.' });
    assert.equal(h.code, 0, h.out);
    // while a Secretary is live, only its commands reconcile: the seat's hand-back says the next pass records the reply
    assert.ok(h.out.includes(`Your reply on m1/${s.escalation}: recorded; the next pass records it on escalation ${s.escalation}: this command ran without the live Secretary's identity`), h.out);
    await text43(p, ['sec', 'next'], s.id);
    const recorded = (await done43(p, ['read', 'show', 'escalation', `m1/${s.escalation}`])).architect as Array<{ reply: string; moot?: string }>;
    assert.deepEqual(recorded.map((x) => [x.reply, x.moot ?? null]), [['answer', null]]);
    const applied = p.ctx.memory.read((db) => flowEvents(db, { mission: 'm1' as never, line: 'secretary', event: 'applied', limit: 100 })).find((e) => e.key === s.escalation);
    assert.equal((JSON.parse(p.ctx.memory.data.text(applied!.body)) as { architect?: string }).architect, `${s.escalation}:s0`, 'carried out as the escalation\'s answer, naming the reply');
    const shown = await text43(p, ['read', 'show', 'escalation', `m1/${s.escalation}`]);
    assert.match(shown.out, new RegExp(`the Architect asked[\\s\\S]*${step.replace(/\./g, '\\.')} \\(asked by the Secretary\\): answer: No: add takes numbers only`), shown.out);
  } finally { p.cleanup(); }
});

test('the PM asks the Architect with mp pm answer; a question back reopens the inbox item; the user does not ask; a reply on a closed round is kept as moot', async () => {
  const p = project43();
  try {
    await constructorAsks(p, ['Should add round its result?']);
    const esc = 'cdec.con.m1.impl.1';
    const noIns = await command43(p, ['pm', 'answer', 'm1', esc, '--option', 'ask-architect', '--by', 'pm', '--no-words', '--reason', 'design']);
    assert.notEqual(noIns.code, 0);
    assert.match(noIns.error.message, /ask-architect requires --instructions/);
    const w = await done43(p, ['pm', 'say', 'Let the architect settle rounding.', '--tag', 'decision@m1']);
    const user = await command43(p, ['pm', 'answer', 'm1', esc, '--option', 'ask-architect', '--by', 'user', '--words', w.words, '--instructions', 'Rounding?']);
    assert.notEqual(user.code, 0);
    assert.match(user.error.message, /ask-architect is the Secretary's or the PM's choice, not the user's own answer: the PM asks the Architect on the user's words with mp pm answer m1 cdec\.con\.m1\.impl\.1 --option ask-architect --by pm --words W-\d+/);
    const a = await text43(p, ['pm', 'answer', 'm1', esc, '--option', 'ask-architect', '--by', 'pm', '--words', w.words, '--reason', 'the user leaves rounding to the design', '--instructions', 'Should add round its result?']);
    assert.equal(a.code, 0, a.out);
    assert.match(a.out, /answer to cdec\.con\.m1\.impl\.1 recorded \(ask-architect, W-\d+\); the Architect is asked: step arch-ask\.m1\.[^ ]+\.p1 is queued\./);
    const step = /step (arch-ask\.m1\.[^ ]+\.p1)/.exec(a.out)![1]!;
    const d = await done43(p, ['pm', 'dispatch', step, '--filled-by', 'h/architect']);
    const h = await handBackFiles(p, d.dispatch, { reply: 'need-to-know', text: 'Is the result shown to a person or stored?' });
    assert.equal(h.code, 0, h.out);
    assert.match(h.out, /Your reply on m1\/cdec\.con\.m1\.impl\.1: recorded on escalation cdec\.con\.m1\.impl\.1; it went back to the PM's inbox with your reply/);
    const inbox = await done43(p, ['pm', 'inbox']);
    const item = inbox.items.find((i: { id: string }) => i.id === `m1/${esc}`);
    assert.equal(item?.round, 2);
    assert.match(item?.text ?? '', /your ask came back: The Architect \(step arch-ask[^)]*\) needs to know this first: Is the result shown to a person or stored\?/);
    // the PM asks again, then answers itself before the second step runs: the late reply is kept and changes nothing
    const again = await text43(p, ['pm', 'answer', 'm1', esc, '--option', 'ask-architect', '--by', 'pm', '--words', w.words, '--reason', 'it is stored', '--instructions', 'The result is stored. Round it?']);
    assert.equal(again.code, 0, again.out);
    const step2 = /step (arch-ask\.m1\.[^ ]+\.p2)/.exec(again.out)![1]!;
    const d2 = await done43(p, ['pm', 'dispatch', step2, '--filled-by', 'h/architect']);
    const pm = await text43(p, ['pm', 'answer', 'm1', esc, '--option', 'answer', '--by', 'user', '--words', w.words, '--instructions', 'Never round.']);
    assert.equal(pm.code, 0, pm.out);
    await done43(p, ['pm', 'next']);
    const late = await handBackFiles(p, d2.dispatch, { reply: 'answer', text: 'Round half to even.' });
    assert.equal(late.code, 0, late.out);
    assert.match(late.out, /Your reply on m1\/cdec\.con\.m1\.impl\.1: recorded on escalation cdec\.con\.m1\.impl\.1 as moot \(.*\): it changes nothing/);
    const shown = await done43(p, ['read', 'show', 'escalation', `m1/${esc}`]);
    assert.deepEqual(shown.architect.map((x: { reply: string; moot?: string }) => [x.reply, x.moot !== undefined]), [['need-to-know', false], ['answer', true]]);
  } finally { p.cleanup(); }
});
