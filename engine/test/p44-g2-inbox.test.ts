// 4.4 (G2): what reaches the PM is the Secretary's brief, shown in the inbox. The item prints the
// Secretary's notice in full, its reason, each option with what it does, the requirement items and words
// entries the work rests on by id, then the escalation's reasons shortened with the read that gives the
// rest. No format is checked; nothing tells the PM to contact the Secretary (F-4). After a PM answer the
// command prints the principles in force and a count of the other tags.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { canonicalJson } from '../src/common/hash.ts';
import type { ContentHash, MissionId } from '../src/common/ids.ts';
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
    assert.match(out, /Options:\n {4}answer: your answer goes to the seat as a decision; the work goes on\n {4}replan: the Architect decomposes again/);
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

test('after a PM answer the command prints the principles in force and a count of the other tags, not every entry', async () => {
  const p = project43();
  try {
    const s = await sentToPm(p);
    await done43(p, ['pm', 'say', 'Keep the public API stable', '--tag', 'principle']);
    await done43(p, ['pm', 'say', 'Prefer clear errors over silent coercion', '--tag', 'decision@m1']);
    const w = await done43(p, ['pm', 'say', 'Numbers only', '--tag', 'decision@m1']);
    const out = await text43(p, ['pm', 'answer', 'm1', s.escalation, '--by', 'pm', '--words', w.words, '--reason', 'the words say so', '--option', 'answer', '--instructions', 'numbers only']);
    assert.match(out, /Principles in force:\n- \[W-\d+#1\] Keep the public API stable/);
    assert.match(out, /1 other tag in force for m1 not cited: mp read words --in-force/);
    assert.doesNotMatch(out, /Prefer clear errors/, 'the other tags are counted, not printed');
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
