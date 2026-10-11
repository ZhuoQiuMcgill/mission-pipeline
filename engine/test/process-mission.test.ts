// A mission through the 4.1 process (design 4.1 §5, §6, §11 scenario 1 in one harness): the
// maintainer's words → a requirement → a PM plan → Calibrator ① → Architect → Calibrator ② →
// Constructor (new files collected, a change outside the write paths refused, verification on a
// clean checkout) → Reviewer → acceptance → delivery → landing. Every seat is scripted (no model):
// it reads its card and materials with `mp seat`, writes its hand-back files into
// tmp/<dispatch>/ and hands back.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { MissionId, ObjectVersionId } from '../src/common/ids.ts';
import { cal1Pass, cal2Pass } from '../src/flow/scripted.ts';
import { decisionLabels } from '../src/evaluator/index.ts';
import { dispatchInfo, listDispatches } from '../src/memory/index.ts';
import { pmDeliver, pmDispatch, pmLand, pmMission, pmNext, pmPlan, pmRequirement, pmSay, seatCard, seatCheckout } from '../src/process/index.ts';
import type { ConstructorCard, ReviewerCard } from '../src/seat/card.ts';
import type { Calibrator1Card, Calibrator2Card } from '../src/seat/cards/calibrator.ts';
import { dispatchView } from '../src/process/seat.ts';
import { handBack, processProject, readAll, readyOf, write } from './process-fixtures.ts';

const M = 'm1' as MissionId;

const CHECK_JS = `const fs = require('node:fs');
const { add } = require('./add.js');
console.log('TAP version 13');
console.log(add(2, 3) === 5 ? 'ok 1 - adds two numbers' : 'not ok 1 - adds two numbers');
// only a clean checkout of the candidate lacks the ignored file the Constructor left in its worktree
console.log(fs.existsSync(__dirname + '/data.local') ? 'not ok 2 - clean checkout' : 'ok 2 - clean checkout');
process.exit(add(2, 3) === 5 && !fs.existsSync(__dirname + '/data.local') ? 0 : 1);
`;

function pmPlanDoc(words: string) {
  return {
    format: 'mp4.pm-plan.v1',
    mission: M,
    round: 1,
    order: 'free',
    elements: [{ id: 'e1', kind: 'deliverable', text: 'An add function with a check', provenance: { by: 'user', words, quote: 'an add function' }, after: [], items: ['g1'] }],
    goalsBeyond: [],
    authorizations: ['a1'],
  };
}

const DETAILED = {
  reusedInterfaces: [],
  newInterfaces: [{ name: 'add', definition: 'add(a: number, b: number): number', searched: 'searched src/: no arithmetic helpers exist', provenance: { planElement: 'e1' } }],
  modules: [{ id: 'core', writeScope: ['src/**'], provenance: { planElement: 'e1' } }],
  tasks: [
    {
      id: 'impl',
      kind: 'implementation',
      module: 'core',
      goal: 'Implement add and its check',
      standards: [{ id: 'S1', text: 'add(2, 3) is 5' }],
      requirementItems: [`item.${M}.g1`],
      writeScope: ['src/**'],
      readableFiles: ['README.md'],
      interpreter: 'node',
      verificationCommands: [{ id: 'check', command: 'node src/check.js' }],
      implements: ['add'],
      calls: [],
      dependsOn: [],
      exclusive: [],
      estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'a small function' },
      provenance: { planElement: 'e1' },
    },
  ],
  risks: [],
};

describe('process: a mission from words to landing (4.1 §5, §6)', () => {
  const p = processProject();
  after(() => p.cleanup());

  it('runs every step through mp pm next / dispatch and mp seat handback, and lands the delivery', async () => {
    let ctx = p.ctx;
    pmMission(ctx, M);
    const w1 = pmSay(ctx, 'Please write an add function, with a check that it works. The details are yours to decide.');
    assert.equal(w1.words, 'W-1');
    assert.equal(pmSay(ctx, 'Please write an add function, with a check that it works. The details are yours to decide.').repeated, true, 'decision 9: the same text again is the same entry');
    await assert.rejects(() => pmRequirement(ctx, { mission: M, item: 'g1', type: 'goal', text: 'An add function', quote: 'a subtract function', words: 'W-1' }), /verbatim/);
    await pmRequirement(ctx, { mission: M, item: 'g1', type: 'goal', text: 'An add function', quote: 'an add function', words: 'W-1' });
    await pmRequirement(ctx, { mission: M, item: 'a1', type: 'authorization', text: 'Details are the PM\'s', quote: 'The details are yours to decide', words: 'W-1' });
    const plan = await pmPlan(ctx, { mission: M, plan: pmPlanDoc('W-1'), words: ['W-1'] });
    assert.ok(plan.plan.length > 0);

    // Calibrator ①
    const s1 = await readyOf(ctx, 'calibrator-1');
    assert.equal(s1.seat, 'calibrator');
    const d1 = pmDispatch(ctx, s1.step, { filledBy: 'claude-code/claude-opus' });
    assert.equal(d1.dispatch, 'D-1');
    assert.match(d1.prompt, /You are the Calibrator of Mission Pipeline\. Your card: `mp seat D-1 card`/);
    const card1 = seatCard(ctx, 'D-1').text;
    assert.equal(card1, d1.card);
    assert.match(card1, /mp seat D-1 handback --report \.mission-pipeline\/tmp\/D-1\/report\.md --result \.mission-pipeline\/tmp\/D-1\/result\.json/);
    assert.match(card1, /"verdict"/, 'the JSON schema of the fields is on the card');
    assert.ok(existsSync(join(p.dir, '.mission-pipeline', 'missions', M, 'dispatches', 'D-1', 'card.md')), 'the card is a leaf');
    // a hand-back before the must-read pages are read is refused, and does not count (decision 14)
    const c1 = dispatchView(ctx, 'D-1').card as unknown as Calibrator1Card;
    const early = await handBack(ctx, 'D-1', cal1Pass(c1));
    assert.equal(early.kind, 'refused');
    assert.ok(early.kind === 'refused' && early.problems.some((x) => x.includes('must-read')));
    readAll(ctx, 'D-1');
    const r1 = await handBack(ctx, 'D-1', cal1Pass(c1));
    assert.equal(r1.kind, 'recorded');
    assert.ok(r1.kind === 'recorded' && r1.outcome === 'accepted');
    assert.ok(existsSync(join(p.dir, '.mission-pipeline', 'missions', M, 'dispatches', 'D-1', 'report.md')), 'the report is a leaf');
    // the same hand-back again records nothing new
    const again = await handBack(ctx, 'D-1', cal1Pass(c1));
    assert.ok(again.kind === 'recorded' && again.repeated);

    // Architect (decomposition)
    const s2 = await readyOf(ctx, 'architect-decompose');
    const d2 = pmDispatch(ctx, s2.step, { filledBy: 'codex/gpt' });
    const co = await seatCheckout(ctx, d2.dispatch);
    assert.ok(existsSync(join(co.path, 'README.md')), 'the Architect reads the project at the commit its card names');
    readAll(ctx, d2.dispatch);
    const r2 = await handBack(ctx, d2.dispatch, DETAILED);
    assert.ok(r2.kind === 'recorded', JSON.stringify(r2));

    // Calibrator ②
    const s3 = await readyOf(ctx, 'calibrator-2');
    const d3 = pmDispatch(ctx, s3.step);
    readAll(ctx, d3.dispatch);
    const r3 = await handBack(ctx, d3.dispatch, cal2Pass(dispatchView(ctx, d3.dispatch).card as unknown as Calibrator2Card));
    assert.ok(r3.kind === 'recorded' && r3.outcome === 'accepted');

    // Constructor: its own worktree; new files collected without git add; a change outside the write paths refused
    const s4 = await readyOf(ctx, 'constructor');
    const d4 = pmDispatch(ctx, s4.step, { filledBy: 'claude-code/claude-sonnet' });
    assert.equal(d4.worktree, `.mission-pipeline/worktrees/${d4.dispatch}`);
    const wt = join(p.dir, d4.worktree!);
    assert.ok(existsSync(join(wt, 'README.md')), 'the worktree is at the card\'s commit');
    const ccard = dispatchView(ctx, d4.dispatch).card as unknown as ConstructorCard;
    assert.deepEqual(ccard.workspace.writablePaths, ['src/**']);
    write(wt, 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    write(wt, 'src/check.js', CHECK_JS);
    write(wt, 'src/data.local', 'ignored scratch\n');
    write(wt, 'notes.txt', 'outside the write paths\n');
    const refused = await handBack(ctx, d4.dispatch, { done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.equal(refused.kind, 'refused');
    assert.ok(refused.kind === 'refused' && refused.problems.some((x) => x.includes('notes.txt')), JSON.stringify(refused));
    assert.ok(existsSync(wt), 'a refused hand-back keeps the worktree');
    rmSync(join(wt, 'notes.txt'));
    const r4 = await handBack(ctx, d4.dispatch, { done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.ok(r4.kind === 'recorded' && r4.outcome === 'accepted', JSON.stringify(r4));
    if (r4.kind !== 'recorded') return;
    assert.deepEqual(r4.candidate?.changedPaths, ['src/add.js', 'src/check.js'], 'new files are collected as they are; ignored ones never');
    assert.deepEqual(r4.candidate?.ignored, ['src/data.local'], 'ignored files inside the write paths are listed');
    assert.equal(r4.verification?.length, 1);
    assert.equal(r4.verification?.[0]?.passed, true, 'the verification ran on a clean checkout of the candidate (no ignored file there)');
    assert.ok(!existsSync(wt), 'the worktree is removed after an accepted hand-back');
    const runLeaves = readFileSync(join(p.dir, '.mission-pipeline', 'missions', M, 'runs', `${r4.verification![0]!.evidence.split('.')[0]}.md`), 'utf8');
    assert.match(runLeaves, /clean checkout/);
    assert.match(runLeaves, /adds two numbers: passed/, 'per-test results from the TAP lines');

    // Reviewer: judges the same candidate commit, cites the program's run
    const s5 = await readyOf(ctx, 'reviewer');
    const d5 = pmDispatch(ctx, s5.step, { filledBy: 'codex/gpt' });
    const rcard = dispatchView(ctx, d5.dispatch).card as unknown as ReviewerCard;
    assert.equal(rcard.workspace.snapshot, r4.candidate?.commit);
    const rco = await seatCheckout(ctx, d5.dispatch);
    assert.ok(existsSync(join(rco.path, 'src', 'add.js')) && !existsSync(join(rco.path, 'src', 'data.local')));
    const ev = rcard.verificationRuns[0]!.evidence;
    const r5 = await handBack(ctx, d5.dispatch, {
      judgments: [{ standard: 'S1', met: 'yes', reason: 'the check passes', evidence: [`evidence:${ev}`, 'file:src/add.js:1'] }],
      gap_responses: [],
      issue_responses: [],
      findings: [],
      verdict: 'pass',
    });
    assert.ok(r5.kind === 'recorded' && r5.outcome === 'accepted', JSON.stringify(r5));

    // accepted: the product is proven
    const next = await pmNext(ctx);
    assert.equal(next.ready.length, 0, `nothing left to dispatch: ${next.ready.map((r) => r.kind).join(', ')}`);
    assert.equal(next.inFlight.length, 0);
    const product = `prod.con.${M}.impl.1` as ObjectVersionId;
    assert.equal(ctx.memory.read((db) => decisionLabels(db, [product]))[product], 'proven');
    // the fillers are recorded as information (§5.3)
    const ds = ctx.memory.read((db) => listDispatches(db, { limit: 100 }));
    assert.equal(ds.length, 5);
    assert.deepEqual(ctx.memory.read((db) => dispatchInfo(db, d4.dispatch))?.filler, { harness: 'claude-code', model: 'claude-sonnet' });

    // delivery and landing (A4) with this package's labels and closing runs
    const w2 = pmSay(ctx, 'Deliver it.');
    ctx = p.ctx;
    const del = await pmDeliver(ctx, { mission: M, delivery: 'v1', selected: [{ kind: 'object', id: product }], closingChecks: [{ id: 'smoke', command: 'node src/check.js' }], words: w2.words });
    assert.equal(del.kind, 'delivered', JSON.stringify(del));
    if (del.kind !== 'delivered') return;
    assert.equal(del.record.checks[0]?.passed, true);
    assert.ok(del.record.checks[0]?.run !== null, 'the closing check is recorded as a run');
    const landed = await pmLand(ctx, { mission: M, delivery: 'v1', words: w2.words });
    assert.equal(landed.kind, 'landed', JSON.stringify(landed));
    assert.equal(p.git('rev-parse', 'refs/heads/main'), del.record.commit);
    assert.ok(existsSync(join(p.dir, 'src', 'add.js')), 'the maintainer\'s worktree holds the delivery');
  });
});
