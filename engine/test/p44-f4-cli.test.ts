// 4.4 (F4; PM design G5): the commands of a Constructor's questions. `mp sec decide --defer` and
// `mp pm answer --defer` put questions off; `mp read open-items <mission>` lists the open items; the
// decider an item belongs to under F-3 answers it (`mp sec open-item answer` within the plan, `mp pm
// open-item answer` for any), and the next card of the task carries the answer. A blocked hand-back says
// that what it handed in is a parked commit. Commands with their new options absent replay a 4.3 receipt.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { beginAction, endAction } from '../src/cli/project.ts';
import { runCli } from '../src/cli/main.ts';
import { cal1Pass, cal2Pass } from '../src/flow/scripted.ts';
import { pmDispatch } from '../src/process/pm.ts';
import { secNext } from '../src/process/secretary.ts';
import { addDetailedPlan, ENV_A, readAll, readyOf, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';
import { command43, done43, live43, project43, secretary43 } from './p43-fixtures.ts';
import { constructorAsks, liveWithEscalation } from './p44-decision-fixtures.ts';

async function text43(p: ProcessProject, args: string[], identity: string | null = null): Promise<{ code: number; out: string }> {
  const r = await runCli(args, { cwd: p.dir, env: { MP_SECRETARY: identity ?? '' }, process: { observe: () => ENV_A, ident: { name: 'test', email: 'test@test' } } });
  return { code: r.exitCode, out: r.stdout + r.stderr };
}

/** The live Secretary claims the decision round and fetches every page, as a diligent Secretary does. */
async function claimRound(p: ProcessProject, id: string, escalation: string): Promise<void> {
  const d = await done43(p, ['sec', 'card', escalation], id);
  const sec = secretary43(p, id);
  try { readAll(sec, d.dispatch); } finally { sec.memory.close(); }
}

test('mp sec decide --defer puts a question off; mp read open-items lists it; the Secretary answers it; the review goes on and its card carries both answers', async () => {
  const p = project43();
  try {
    await constructorAsks(p, ['Which quote character?', 'Which licence header?']);
    const s = await liveWithEscalation(p);
    assert.equal(s.escalation, 'cdec.con.m1.impl.1');
    // the review waits meanwhile, named with the escalation
    const before = await text43(p, ['sec', 'next', '--all'], s.id);
    assert.match(before.out, /rev\.m1\.impl\.1.*waits for the answer to the Constructor's questions.*cdec\.con\.m1\.impl\.1/s);
    await claimRound(p, s.id, s.escalation);
    const r = await done43(p, ['sec', 'decide', s.escalation, '--option', 'answer', '--reason', 'within the plan', '--instructions', 'Use double quotes.', '--defer', '2'], s.id);
    assert.equal(r.decision.state, 'applied', JSON.stringify(r.decision));
    const item = `${s.escalation}.q2`;
    const listed = await done43(p, ['read', 'open-items', 'm1']);
    assert.deepEqual(listed.items.map((i: any) => [i.id, i.why, i.decider, i.answer]), [[item, 'deferred', 'secretary', null]]);
    const shown = await text43(p, ['read', 'open-items', 'm1']);
    assert.match(shown.out, new RegExp(`\\[${item.replace(/\./g, '\\.')}\\] question, task impl \\(attempt 1, put off by its answer\\): open; the Secretary answers it\\n  Which licence header\\?`));
    const a = await text43(p, ['sec', 'open-item', 'answer', item, '--answer', 'No licence header.', '--op', 'oi-1'], s.id);
    assert.equal(a.code, 0, a.out);
    assert.match(a.out, new RegExp(`Open item m1/${item.replace(/\./g, '\\.')} \\(task impl, attempt 1\\) answered by the Secretary; the task's next cards carry the answer\\.`));
    const again = await command43(p, ['sec', 'open-item', 'answer', item, '--answer', 'No licence header.', '--op', 'oi-1'], s.id);
    assert.equal(again.replayed, true, 'the same --op replays');
    const rerun = await done43(p, ['sec', 'open-item', 'answer', item, '--answer', 'No licence header.'], s.id);
    assert.equal(rerun.repeated, true, 'run again without --op: the same answer is not written twice');
    const other = await command43(p, ['sec', 'open-item', 'answer', item, '--answer', 'An MIT header.'], s.id);
    assert.notEqual(other.code, 0);
    assert.match(other.error.message, /answered already by the Secretary: No licence header\./);
    // the review is ready now, and its card carries the questions with both answers
    const ctx = secretary43(p, s.id);
    try { assert.ok((await secNext(ctx)).ready.some((x) => x.step === 'rev.m1.impl.1')); } finally { ctx.memory.close(); }
    const d = await done43(p, ['sec', 'dispatch', 'rev.m1.impl.1', '--filled-by', 'h/reviewer'], s.id);
    const card = (await text43(p, ['seat', d.dispatch, 'card'])).out;
    assert.ok(card.includes(`[${s.escalation}#1] attempt 1, before-review: Which quote character?\n  Answered by the Secretary: Use double quotes.`), card);
    assert.ok(card.includes(`[${item}] attempt 1, before-review: Which licence header?\n  Answered by the Secretary: No licence header.`), card);
  } finally { p.cleanup(); }
});

test('an open item of the PM\'s class: the Secretary is refused with the way, the PM answers it with or without words', async () => {
  const p = project43();
  try {
    await constructorAsks(p, ['Which quote character?', 'Which licence header?']);
    const s = await liveWithEscalation(p);
    await claimRound(p, s.id, s.escalation);
    await done43(p, ['sec', 'decide', s.escalation, '--option', 'ask-pm', '--reason', 'a licence is the user\'s', '--notice', 'Which licence header? the user decides'], s.id);
    const w = await done43(p, ['pm', 'say', 'Double quotes; the licence I decide later.', '--tag', 'decision@m1']);
    const pm = await text43(p, ['pm', 'answer', 'm1', s.escalation, '--by', 'pm', '--words', w.words, '--reason', 'the user said so', '--option', 'answer', '--instructions', 'Use double quotes.', '--defer', 'Q2']);
    assert.equal(pm.code, 0, pm.out);
    // the Secretary's next pass carries the PM's answer out
    const ctx = secretary43(p, s.id);
    try { await secNext(ctx); } finally { ctx.memory.close(); }
    const item = `${s.escalation}.q2`;
    assert.deepEqual((await done43(p, ['read', 'open-items', 'm1'])).items.map((i: any) => [i.id, i.decider]), [[item, 'pm']]);
    const refused = await command43(p, ['sec', 'open-item', 'answer', item, '--answer', 'MIT'], s.id);
    assert.notEqual(refused.code, 0);
    assert.match(refused.error.message, new RegExp(`is the PM's.*mp pm open-item answer m1/${item.replace(/\./g, '\\.')}`));
    const ok = await done43(p, ['pm', 'open-item', 'answer', `m1/${item}`, '--answer', 'An MIT header.', '--words', w.words]);
    assert.equal(ok.item.answer.words, w.words);
    assert.equal(ok.item.answer.by, 'pm');
    const bad = await command43(p, ['pm', 'answer', 'm1', s.escalation, '--by', 'pm', '--no-words', '--reason', 'r', '--option', 'answer', '--instructions', 'x', '--defer', 'x']);
    assert.notEqual(bad.code, 0, '--defer takes question numbers');
  } finally { p.cleanup(); }
});

test('a blocked hand-back through mp seat says what it handed in is a parked commit, and that nothing is verified', async () => {
  const p = project43();
  try {
    const ctx = p.ctx;
    await startAddMission(ctx, 'm1');
    await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(ctx, 'architect-decompose', () => addDetailedPlan('m1'));
    await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
    const s = await readyOf(ctx, 'constructor');
    const d = pmDispatch(ctx, s.step);
    write(join(p.dir, d.worktree!), 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    const dir = join(ctx.memory.paths.tmp, d.dispatch);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.md'), '# Report\n\nStopped to ask.\n');
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ done: 'wrote add', unmet_standards: [], unfixed_problems: [], decisions_needed: [{ question: 'Is a check script wanted?', when: 'before-review' }], blocked: true }));
    const r = await text43(p, ['seat', d.dispatch, 'handback', '--report', `.mission-pipeline/tmp/${d.dispatch}/report.md`, '--result', `.mission-pipeline/tmp/${d.dispatch}/result.json`]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Parked commit \(your edits so far, not a product\) [0-9a-f]{40} on base [0-9a-f]{40}: src\/add\.js/);
    assert.match(r.out, /You stopped to ask: your edits are kept as commit [0-9a-f]{40}\. It is not a product: nothing is verified or reviewed\./);
    assert.doesNotMatch(r.out, /Verification /);
  } finally { p.cleanup(); }
});

test('compatibility: mp pm answer and mp sec decide replay a 4.3 receipt with the same --op (their new --defer absent)', async () => {
  const p = project43();
  try {
    await constructorAsks(p, ['Which quote character?']);
    const s = await liveWithEscalation(p);
    const retried = async (identity: string | null, command: string, args43: unknown, argv: string[]): Promise<void> => {
      const op = `old-${command.replace(/ /g, '-')}`;
      const action = { op, command, args: identity === null ? args43 : { generation: identity, args: args43 } };
      assert.equal(beginAction(p.ctx.memory, { ...action, filler: null }), null);
      endAction(p.ctx.memory, action, { exitCode: 0, text: `recorded by 4.3 for ${command}`, json: { recorded: command } }, false);
      const r = await command43(p, [...argv, '--op', op], identity);
      assert.equal(r.code, 0, `${command}: ${JSON.stringify(r)}`);
      assert.equal(r.replayed, true, command);
      assert.deepEqual(r.result, { recorded: command });
    };
    await retried(s.id, 'sec decide', { positionals: [s.escalation], flags: { option: 'answer', reason: 'r', instructions: 'Use double quotes.' } }, ['sec', 'decide', s.escalation, '--option', 'answer', '--reason', 'r', '--instructions', 'Use double quotes.']);
    await retried(null, 'answer', { positionals: ['m1', s.escalation], flags: { option: 'answer', by: 'pm', 'no-words': true, reason: 'r', instructions: 'Use double quotes.' } }, ['pm', 'answer', 'm1', s.escalation, '--option', 'answer', '--by', 'pm', '--no-words', '--reason', 'r', '--instructions', 'Use double quotes.']);
    // the claim of a review that waits now: a 4.3 receipt of it replays, nothing is checked again
    await retried(s.id, 'sec dispatch', { positionals: ['rev.m1.impl.1'], flags: {} }, ['sec', 'dispatch', 'rev.m1.impl.1']);
  } finally { p.cleanup(); }
});
