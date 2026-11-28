// 4.4 (G2): what reaches the PM is the Secretary's brief, shown in the inbox. The item prints the
// Secretary's notice in full, its reason, each option with what it does, the requirement items and words
// entries the work rests on by id, then the escalation's reasons shortened with the read that gives the
// rest. No format is checked; nothing tells the PM to contact the Secretary (F-4). After a PM answer the
// command prints the principles in force and a count of the other tags.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { canonicalJson } from '../src/common/hash.ts';
import type { ContentHash, MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { escalation, pmOptions, raiseEscalation, secretaryOptions, type EscalationBody } from '../src/flow/secretary.ts';
import { appendRecords } from '../src/memory/index.ts';
import { ENV_A, readAll, type ProcessProject } from './process-fixtures.ts';
import { project43, done43, escalation43, live43, secretary43 } from './p43-fixtures.ts';
import { constructorAsks, liveWithEscalation } from './p44-decision-fixtures.ts';

async function text43(p: ProcessProject, args: string[], identity: string | null = null): Promise<string> {
  const r = await runCli(args, { cwd: p.dir, env: { MP_SECRETARY: identity ?? '' }, process: { observe: () => ENV_A, ident: { name: 'test', email: 'test@test' } } });
  assert.equal(r.exitCode, 0, r.stderr || r.stdout);
  return r.stdout;
}

const LONG = `Which error does add throw when an argument is not a number? ${'and so on '.repeat(30)}END-OF-LONG`;
const NOTICE = 'The question: may add accept strings?\nThe options: answer numbers only (the Constructor rejects strings); replan (the Architect splits the task).\nThe words: the decision item says never a string.\nI would answer numbers only, as that item says.';

async function sentToPm(p: ProcessProject): Promise<{ id: string; escalation: string }> {
  await constructorAsks(p, ['Q1?', 'Q2?', 'Q3?', 'Q4?', LONG, 'Q6?', 'Q7?']);
  const s = await liveWithEscalation(p);
  const d = await done43(p, ['sec', 'card', s.escalation], s.id);
  const sec = secretary43(p, s.id);
  try { readAll(sec, d.dispatch); } finally { sec.memory.close(); }
  await done43(p, ['sec', 'decide', s.escalation, '--option', 'ask-pm', '--reason', 'this changes what the user gets', '--notice', NOTICE], s.id);
  return s;
}

test('the inbox item carries the brief: the notice in full, its reason, the options with what each does, items and words by id, the reasons shortened with the read for the rest', async () => {
  const p = project43();
  try {
    const s = await sentToPm(p);
    const out = await text43(p, ['pm', 'inbox']);
    assert.ok(out.includes(`The Secretary's notice:\n    ${NOTICE.split('\n').join('\n    ')}`), out);
    assert.match(out, /Its reason: this changes what the user gets/);
    assert.match(out, /Options:\n {4}answer: the answer is recorded as the decision and goes to the next cards of the work; the work goes on\n {4}replan: the task waits while the Architect re-plans it with the instructions/);
    assert.match(out, /Rests on: items item\.m1\.g1; words W-1/);
    assert.ok(out.includes(`The escalation's reasons, shortened (in full: mp read show escalation m1/${s.escalation}):`), out);
    assert.match(out, /- Q1\?\n {4}- Q2\?/);
    assert.match(out, /- \(2 more\)/);
    assert.doesNotMatch(out, /END-OF-LONG/, 'a long reason is shortened');
    assert.match(out, /Action: mp pm answer m1 /);
    assert.doesNotMatch(out, /ask-secretary|mp pm note|contact the Secretary/, 'a poor brief is no reason to contact the Secretary (F-4)');
    const item = (await done43(p, ['pm', 'inbox'])).items.find((i: any) => i.id === `m1/${s.escalation}`);
    assert.equal(item.brief.notice, NOTICE);
    assert.equal(item.brief.by, 'secretary');
    assert.deepEqual(item.brief.items, ['item.m1.g1']);
    assert.deepEqual(item.brief.words, ['W-1']);
    assert.deepEqual(item.brief.options.map((o: any) => o.id), ['answer', 'replan']);
    assert.ok(item.facts, 'every read the PM has today stays');
    const shown = await text43(p, ['read', 'show', 'escalation', `m1/${s.escalation}`]);
    assert.ok(shown.includes(LONG), 'the read the item names gives every reason in full');
    assert.match(shown, /- Q7\?/);
  } finally { p.cleanup(); }
});

test('after a PM answer the command prints each principle in force in full and a count of every other tag in force, with the read that lists them', async () => {
  const p = project43();
  try {
    const s = await sentToPm(p);
    const principle = `Keep the public API stable ${'for every caller we know of, '.repeat(6)}except where the user names a break.`;
    assert.ok(principle.indexOf('except') > 160);
    await done43(p, ['pm', 'say', principle, '--tag', 'principle']);
    await done43(p, ['pm', 'say', 'Prefer clear errors over silent coercion', '--tag', 'decision@m1']);
    const w = await done43(p, ['pm', 'say', 'Numbers only', '--tag', 'decision@m1']);
    const out = await text43(p, ['pm', 'answer', 'm1', s.escalation, '--by', 'pm', '--words', w.words, '--reason', 'the words say so', '--option', 'answer', '--instructions', 'numbers only']);
    assert.ok(out.includes(`Principles in force:\n- [`) && out.includes(principle), 'a principle is printed in full, never cut');
    // two decision tags in force for m1, the cited one counted too
    assert.match(out, /Other tags in force for m1: 2 \(mp read words --in-force lists them\)/);
    assert.doesNotMatch(out, /Prefer clear errors/, 'the other tags are counted, not printed');
    const none = project43();
    try {
      const t = await sentToPm(none);
      const quiet = await text43(none, ['pm', 'answer', 'm1', t.escalation, '--by', 'pm', '--no-words', '--reason', 'minor', '--option', 'answer', '--instructions', 'numbers only']);
      assert.match(quiet, /Other tags in force for m1: 0 \(mp read words --in-force lists them\)/, 'the read is named also when the count is zero');
    } finally { none.cleanup(); }
  } finally { p.cleanup(); }
});

test('review p1-6: the brief names the authorization the Secretary cited and its words entry, from the hand-back and from the decision event alike', async () => {
  for (const way of ['decide', 'hand-back'] as const) {
    const p = project43();
    try {
      await constructorAsks(p, ['May add accept strings?']);
      const w = await done43(p, ['pm', 'say', 'Error types are yours to choose', '--tag', 'decision@m1']);
      await done43(p, ['pm', 'requirement', 'add', 'm1', 'a2', '--type', 'authorization', '--text', 'error types are the PM\'s', '--quote', 'Error types are yours to choose', '--words', w.words]);
      const s = await liveWithEscalation(p);
      const d = await done43(p, ['sec', 'card', s.escalation], s.id);
      const sec = secretary43(p, s.id);
      try { readAll(sec, d.dispatch); } finally { sec.memory.close(); }
      if (way === 'decide') await done43(p, ['sec', 'decide', s.escalation, '--option', 'ask-pm', '--reason', 'it changes what the user gets', '--authorization', 'item.m1.a2'], s.id);
      else {
        // the seat way outside the live identity: no pass runs, the inbox reads the hand-back
        const dir = join(p.ctx.memory.paths.tmp, d.dispatch);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'report.md'), '# Decision\n');
        writeFileSync(join(dir, 'result.json'), JSON.stringify({ option: 'ask-pm', classification: 'needs-pm', authorization: 'item.m1.a2', reason: 'it changes what the user gets', instructions: '', grantExtra: 0, notice: 'Strings?', mayMatter: false }));
        await done43(p, ['seat', d.dispatch, 'handback', '--report', `.mission-pipeline/tmp/${d.dispatch}/report.md`, '--result', `.mission-pipeline/tmp/${d.dispatch}/result.json`]);
        assert.equal(p.ctx.memory.stmt("SELECT 1 FROM flow_events WHERE event = 'decision' AND key = ?").get(s.escalation), undefined);
      }
      const item = (await done43(p, ['pm', 'inbox'])).items.find((i: any) => i.id === `m1/${s.escalation}`);
      assert.ok(item.brief.items.includes('item.m1.a2'), `${way}: ${JSON.stringify(item.brief.items)}`);
      assert.ok(item.brief.words.includes(w.words), `${way}: ${JSON.stringify(item.brief.words)}`);
      // round 2: the item is revised after the decision, on other words: the words the decision relied on stay named, and both versions are said
      const w2 = await done43(p, ['pm', 'say', 'Error types and messages are yours', '--tag', 'decision@m1']);
      await done43(p, ['pm', 'requirement', 'add', 'm1', 'a2', '--type', 'authorization', '--text', 'error types and messages are the PM\'s', '--quote', 'Error types and messages are yours', '--words', w2.words]);
      const after = (await done43(p, ['pm', 'inbox'])).items.find((i: any) => i.id === `m1/${s.escalation}`);
      assert.ok(after.brief.words.includes(w.words), `${way}: the decided version's words stay: ${JSON.stringify(after.brief.words)}`);
      assert.ok(after.brief.words.includes(w2.words), `${way}: the current version's words: ${JSON.stringify(after.brief.words)}`);
      assert.deepEqual(after.brief.revised, [{ line: 'item.m1.a2', decided: 'item.m1.a2.v1', current: 'item.m1.a2.v2' }]);
      assert.match(await text43(p, ['pm', 'inbox']), /The decision cites item\.m1\.a2 as item\.m1\.a2\.v1; it is item\.m1\.a2\.v2 now/);
    } finally { p.cleanup(); }
  }
});

test('review round 2, p1-7: the count of other tags and its read come before the principles, and a replay cut at the receipt limit says so and names the read', async () => {
  const p = project43();
  try {
    const s = await sentToPm(p);
    const long = `Keep every public name stable. ${'Each caller depends on it in some way that we cannot see from here. '.repeat(250)}END-OF-PRINCIPLE`;
    assert.ok(long.length > 17_000);
    await done43(p, ['pm', 'say', long, '--tag', 'principle']);
    await done43(p, ['pm', 'say', 'Prefer clear errors over silent coercion', '--tag', 'decision@m1']);
    const args = ['pm', 'answer', 'm1', s.escalation, '--by', 'pm', '--no-words', '--reason', 'minor', '--option', 'answer', '--instructions', 'numbers only', '--op', 'long-answer'];
    const fresh = await text43(p, args);
    assert.ok(fresh.includes('END-OF-PRINCIPLE'), 'the fresh output keeps the principle whole');
    assert.ok(fresh.indexOf('Other tags in force for m1: 1') < fresh.indexOf('Principles in force:'));
    const replay = await text43(p, args);
    assert.match(replay, /Other tags in force for m1: 1 \(mp read words --in-force lists them\)/, 'the count survives the cut');
    assert.doesNotMatch(replay, /END-OF-PRINCIPLE/);
    assert.match(replay, /cut here: the receipt keeps the first 16000 characters of the output; mp read words --tag principle --in-force lists every principle in force/);
  } finally { p.cleanup(); }
});

test('review p1-2: each option says what the flow does for that kind of escalation, on the inbox and on the Secretary card', async () => {
  const p = project43();
  try {
    await done43(p, ['pm', 'mission', 'open', 'm1']);
    const ctx = flowCtx(p.ctx.ports(), 'm1' as MissionId);
    await raiseEscalation(ctx, { id: 'stop', source: 'exploration-budget', lineage: 'x.m1.e1', subject: 'exploration:e1', summary: 'Exploration e1 stopped without converging', reasons: ['a finding'], options: ['grant', 'accept-risk', 'send-back', 'replan', 'abandon', 'ask-user'], facts: { handoff: 'h', reason: 'budget-exhausted', wi: 'WI-08', version: null, unresolved: [], decision: null, stabilizer: [] } });
    const d = { escalation: 'stop', by: 'secretary', option: 'ask-pm', classification: 'needs-pm', authorization: null, reason: 'the PM decides', instructions: '', grantExtra: 0, notice: 'Stop or go on?', mayMatter: false };
    p.ctx.memory.write({}, (tx) => appendRecords(tx, [{ kind: 'flow.event', mission: 'm1' as MissionId, line: 'secretary', event: 'decision', key: 'stop', body: tx.data.put(canonicalJson(d)) as ContentHash }]));
    const out = await text43(p, ['pm', 'inbox']);
    assert.match(out, /replan: the exploration ends without a conclusion/);
    assert.match(out, /send-back: the exploration goes on in the direction the instructions give, within the rounds left/);
    // round 2: the PM's grant needs --extra (answerByPm refuses it without); the user's default and the Secretary's limit are told apart
    assert.match(out, /grant: the exploration gets the rounds granted; .*\(the PM names the number with --extra \(required\), a user's answer without --extra grants 2; a PM grant does not use the Secretary's\)/);
    assert.doesNotMatch(out, /Architect decomposes again|Architect revises the plan|re-plans it/, 'no plan option text for an exploration stop');
    const card = secretaryOptions((await escalation(ctx, 'stop'))!, true);
    assert.match(card.find((o) => o.id === 'replan')!.outcome, /ends without a conclusion/);
    assert.match(card.find((o) => o.id === 'grant')!.outcome, /your one grant on this lineage, 1 or 2/);
    // every kind of escalation and every option it offers is carried out to its effect in test/p44-option-effects.test.ts
  } finally { p.cleanup(); }
});

test('compatibility: a decision recorded in the 4.3 shape (needs-user, ask-user) reads with its brief, and an escalation with no task names no items', async () => {
  const p = project43();
  try {
    await escalation43(p);
    await live43(p);
    const d = { escalation: 'choice', by: 'secretary', option: 'ask-user', classification: 'needs-user', authorization: null, reason: 'older decision', instructions: '', grantExtra: 0, notice: 'Older notice', mayMatter: false };
    p.ctx.memory.write({}, (tx) => appendRecords(tx, [{ kind: 'flow.event', mission: 'm1' as MissionId, line: 'secretary', event: 'decision', key: 'choice', body: tx.data.put(canonicalJson(d)) as ContentHash }]));
    const item = (await done43(p, ['pm', 'inbox'])).items.find((i: any) => i.id === 'm1/choice');
    assert.equal(item.brief.notice, 'Older notice');
    assert.deepEqual(item.brief.items, []);
    assert.deepEqual(item.brief.options.map((o: any) => o.id), ['answer', 'accept', 'grant']);
    assert.match(await text43(p, ['pm', 'inbox']), /Rests on: items none named; words none named/);
  } finally { p.cleanup(); }
});
