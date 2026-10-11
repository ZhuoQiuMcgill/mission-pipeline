// Regression tests for the code review r1 of package A3 (the process; gpt-6.1-sol), one per fixed
// finding, following the reviewer's repros (engine/scratch/review41-repro.ts):
//   #4 a run's working directory is part of its identity, its record, the reuse key and renew's rerun
//   #7 renew that leaves a judgment needing a new Reviewer: a Reviewer step for the same candidate
//      and review position with the current runs; a rework sends the task back to the Constructor
//   #8 closing: the three tiers, the frozen snapshot, production held (next, dispatch, the flows),
//      post-close work allowed, dispatches in flight reported, late hand-backs not accepted unless
//      the close waits for running work
//   #9 every state change of a mission is its own operation; only a retry of the same request
//      replays its receipt

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { sweepThenClean } from './exploration-exits.ts';
import type { MissionId, ObjectVersionId } from '../src/common/ids.ts';
import { decisionLabels } from '../src/evaluator/index.ts';
import { cal1Pass, cal2Pass } from '../src/flow/scripted.ts';
import { missionCloses } from '../src/memory/index.ts';
import { allowedAfterClose, missionState, pmClose, pmDispatch, pmMission, pmNext, pmRenew, runOnCommit } from '../src/process/index.ts';
import { ProcessError } from '../src/process/errors.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import { join } from 'node:path';
import { addDetailedPlan, addMissionToReview, CHECK_JS, ENV_B, handBack, processProject, readAll, readyOf, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
let p: ProcessProject | null = null;
afterEach(() => {
  const q = p;
  p = null;
  if (q !== null) sweepThenClean([q]);
});

const EXIT = (code: number): string => `process.exit(${code});\n`;

describe('review r1 #4: the working directory is part of a run', () => {
  it('a run in another directory is not reused: it executes; the same directory (however written) is reused', async () => {
    p = processProject({ files: { 'good/check.js': EXIT(0), 'bad/check.js': EXIT(1) } });
    const ctx = p.ctx;
    const commit = p.git('rev-parse', 'HEAD');
    const run = (cwd: string) => runOnCommit(ctx, { mission: M, commit, commands: [{ id: 'check', command: 'node check.js', cwd }], purpose: 'cwd test', declaration: { by: 'mp', checkout: 'clean', declared: true } });
    const good = await run('good');
    assert.equal(good.reused, false);
    assert.equal(good.runs[0]?.passed, true);
    assert.equal(good.runs[0]?.fields['cwd'], 'good', 'the record names the directory');
    const again = await run('./good/');
    assert.equal(again.reused, true, 'the same directory, normalized, is reused');
    assert.equal(again.runs[0]?.evidence, good.runs[0]?.evidence);
    // the reviewer's repro: the same command in bad/ must not reuse the good/ run
    const bad = await run('bad');
    assert.equal(bad.reused, false, 'another directory is another run');
    assert.equal(bad.runs[0]?.passed, false);
    assert.equal(bad.runs[0]?.fields['cwd'], 'bad');
    assert.equal((await run('bad')).reused, true);
    await assert.rejects(run('../outside'), (e: Error) => e instanceof ProcessError && /leaves the checkout/.test(e.message));
  });

  it('mp pm renew reruns a run in its own directory', async () => {
    p = processProject();
    const detailed = addDetailedPlan(M) as { tasks: Array<{ verificationCommands: unknown[] }> };
    detailed.tasks[0]!.verificationCommands = [{ id: 'check', command: 'node check.js', cwd: 'src' }];
    await addMissionToReview(p, M, { detailed });
    let ctx = p.ctx;
    await step(ctx, 'reviewer', (c) => reviewerPass(c));
    const product = `prod.con.${M}.impl.1` as ObjectVersionId;
    await pmNext(ctx);
    assert.equal(ctx.memory.read((db) => decisionLabels(db, [product]))[product], 'proven');
    ctx = p.reopen(ENV_B);
    const ren = await pmRenew(ctx);
    assert.equal(ren.reruns.length, 1, JSON.stringify(ren));
    assert.equal(ren.reruns[0]?.passed, true, 'run in src/, where check.js is (at the root it would not be found)');
    assert.equal(ren.reruns[0]?.renewed.length, 1);
    const rec = ctx.memory.read((db) => db.stmt("SELECT json_extract(record, '$.fields.cwd') AS cwd FROM log WHERE kind = 'evidence' AND json_extract(record, '$.evidence') = ?").get(ren.reruns[0]!.run) as { cwd: string });
    assert.equal(rec.cwd, 'src');
    await pmNext(ctx);
    assert.equal(ctx.memory.read((db) => decisionLabels(db, [product]))[product], 'proven');
  });
});

describe('review r1 #7: a judgment renew cannot restore gets a Reviewer step', () => {
  it('a sampled verification: after an environment change, mp pm next offers a Reviewer for the same candidate and position with new runs; its pass restores proven', async () => {
    p = processProject();
    await addMissionToReview(p, M, { detailed: addDetailedPlan(M, { verification: [{ id: 'sample', command: 'node src/check.js', sampled: true }] }) });
    let ctx = p.ctx;
    const first = await step(ctx, 'reviewer', (c) => reviewerPass(c));
    const oldCard = dispatchView(ctx, first.dispatch).card as unknown as ReviewerCard;
    const product = `prod.con.${M}.impl.1` as ObjectVersionId;
    await pmNext(ctx);
    assert.equal(ctx.memory.read((db) => decisionLabels(db, [product]))[product], 'proven');

    ctx = p.reopen(ENV_B);
    const ren = await pmRenew(ctx);
    assert.equal(ren.reviews.length, 1, 'a sampling run is never renewed');
    assert.equal(ren.reviewSteps, 1);
    const next = await pmNext(ctx);
    assert.deepEqual(next.ready.map((r) => r.kind), ['reviewer'], 'the reviewer\'s repro had ready=[]');
    assert.equal(next.ready[0]?.purpose, `review ${product} (reviewer)`);
    const s = next.ready[0]!;
    const d = pmDispatch(ctx, s.step);
    readAll(ctx, d.dispatch);
    const card = dispatchView(ctx, d.dispatch).card as unknown as ReviewerCard;
    assert.equal(card.target, product, 'the same candidate');
    assert.equal(card.review, 'reviewer', 'the same review position');
    assert.equal(card.workspace.snapshot, oldCard.workspace.snapshot);
    assert.equal(card.verificationRuns.length, 1);
    assert.notEqual(card.verificationRuns[0]?.evidence, oldCard.verificationRuns[0]?.evidence, 'the runs were recorded again under the current identity');
    assert.ok(!next.notices.some((n) => n.category.includes('renew')), 'no WI for it (decision 18)');
    const a = await handBack(ctx, d.dispatch, reviewerPass(card));
    assert.ok(a.kind === 'recorded' && a.outcome === 'accepted');
    const after = await pmNext(ctx);
    assert.equal(ctx.memory.read((db) => decisionLabels(db, [product]))[product], 'proven');
    assert.deepEqual(after.ready, [], 'no Constructor redo');
  });

  it('a rework from the re-review sends the task back to the Constructor', async () => {
    p = processProject();
    await addMissionToReview(p, M, { detailed: addDetailedPlan(M, { verification: [{ id: 'sample', command: 'node src/check.js', sampled: true }] }) });
    let ctx = p.ctx;
    await step(ctx, 'reviewer', (c) => reviewerPass(c));
    ctx = p.reopen(ENV_B);
    await pmRenew(ctx);
    await step(ctx, 'reviewer', (c: ReviewerCard) => ({ ...(reviewerPass(c) as object), judgments: c.standards.map((x) => ({ standard: x.id, met: 'no', reason: 'fails here', evidence: c.verificationRuns.map((r) => `evidence:${r.evidence}`) })), verdict: 'rework' }));
    const next = await pmNext(ctx);
    assert.deepEqual(next.ready.map((r) => r.kind), ['constructor']);
    assert.match(next.ready[0]!.step, /\.2$/, 'the next attempt');
  });
});

describe('review r1 #8: closing a mission', () => {
  async function toConstructor(): Promise<ProcessProject> {
    const pp = processProject();
    await startAddMission(pp.ctx, M);
    await step(pp.ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(pp.ctx, 'architect-decompose', () => addDetailedPlan(M));
    await step(pp.ctx, 'calibrator-2', (c) => cal2Pass(c));
    return pp;
  }

  it('the reviewer\'s repro: the close freezes a snapshot and holds the queued Constructor (next, dispatch); opening again lets it run', async () => {
    p = await toConstructor();
    const ctx = p.ctx;
    const con = await readyOf(ctx, 'constructor');
    const c = pmClose(ctx, M, { mode: 'with-risk' });
    assert.equal(c.version, 1);
    assert.equal(ctx.memory.read((db) => missionState(db, M)), 'closed');
    const closes = ctx.memory.read((db) => missionCloses(db, M));
    assert.equal(closes.length, 1);
    assert.equal(closes[0]?.mode, 'with-risk');
    const snap = JSON.parse(ctx.memory.data.text(closes[0]!.snapshot!)) as { proof: Array<{ object: string; label: string }>; unfinished: { planTasks: string[]; queued: string[] }; risks: string[] };
    assert.deepEqual(snap.unfinished.planTasks, ['impl']);
    assert.deepEqual(snap.unfinished.queued, [con.step]);
    assert.ok(snap.proof.some((x) => x.object.startsWith('dplan.')), 'the proof state of the outputs');
    assert.ok(snap.risks.some((r) => r === 'plan task impl not accepted'), snap.risks.join(' | '));
    const next = await pmNext(ctx);
    assert.deepEqual(next.ready, []);
    assert.equal(next.held.find((h) => h.step === con.step)?.why.includes('is closed'), true);
    assert.throws(() => pmDispatch(ctx, con.step), (e: Error) => e instanceof ProcessError && e.code === 'NOT_READY');
    // the flows queue no production work while it is closed; opening it again lets the held step run
    assert.equal(pmMission(ctx, M, 'open').changed, true);
    assert.equal((await readyOf(ctx, 'constructor')).step, con.step);
  });

  it('a production dispatch in flight is reported; its late hand-back is recorded, not accepted; with wait-running it is accepted', async () => {
    p = await toConstructor();
    const ctx = p.ctx;
    const con = await readyOf(ctx, 'constructor');
    const d = pmDispatch(ctx, con.step);
    const c = pmClose(ctx, M, { mode: 'post-audit' });
    assert.deepEqual(c.inFlight.map((x) => x.dispatch), [d.dispatch]);
    assert.match(c.message, /Stop them in your harness/);
    write(join(p.dir, d.worktree!), 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    write(join(p.dir, d.worktree!), 'src/check.js', CHECK_JS);
    const late = await handBack(ctx, d.dispatch, { done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.ok(late.kind === 'recorded' && late.outcome === 'after-release' && late.candidate === null, JSON.stringify(late));
    assert.ok(late.notes.some((n) => /closed before this hand-back/.test(n)));
    const next = await pmNext(ctx);
    assert.equal(next.held.some((h) => h.step === con.step), true, 'queued again, held while closed');
    // opened again: a new dispatch; closed with wait-running: its hand-back is accepted
    pmMission(ctx, M, 'open');
    const d2 = pmDispatch(ctx, (await readyOf(ctx, 'constructor')).step);
    pmClose(ctx, M, { mode: 'with-risk', waitRunning: true });
    write(join(p.dir, d2.worktree!), 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    write(join(p.dir, d2.worktree!), 'src/check.js', CHECK_JS);
    const ok = await handBack(ctx, d2.dispatch, { done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.ok(ok.kind === 'recorded' && ok.outcome === 'accepted' && ok.candidate !== null, JSON.stringify(ok));
    assert.equal(ctx.memory.read((db) => missionCloses(db, M)).length, 2, 'a new snapshot version on every close');
  });

  it('a full close is refused while an output is not proven or work is unfinished; audits are post-close work', async () => {
    p = await toConstructor();
    const ctx = p.ctx;
    assert.throws(() => pmClose(ctx, M, { mode: 'full' }), (e: Error) => e instanceof ProcessError && e.code === 'NOT_READY' && /full close/.test(e.message));
    assert.equal(ctx.memory.read((db) => missionState(db, M)), 'open', 'nothing written');
    assert.equal(allowedAfterClose({ card: { seat: 'auditor-node' } }), true);
    assert.equal(allowedAfterClose({ card: { seat: 'reviewer' }, afterClose: 'audit' }), true, 'a re-review after an environment change');
    assert.equal(allowedAfterClose({ card: { seat: 'constructor' } }), false);
  });
});

describe('review r1 #9: every state change is its own operation', () => {
  it('open → closed → open leaves the mission open; a retry of the same request replays its receipt', async () => {
    p = processProject();
    const ctx = p.ctx;
    assert.equal(pmMission(ctx, 'm-reopen', 'open').changed, true);
    assert.equal(pmMission(ctx, 'm-reopen', 'closed').state, 'closed');
    const reopened = pmMission(ctx, 'm-reopen', 'open');
    assert.equal(reopened.changed, true);
    assert.equal(ctx.memory.read((db) => missionState(db, 'm-reopen')), 'open', 'the reviewer\'s repro left it closed');
    assert.equal(pmMission(ctx, 'm-reopen', 'open').changed, false, 'already open: nothing written');
    // a request id names the request: its retry replays the receipt; a new request closes again
    const a = pmClose(ctx, 'm-reopen', { mode: 'with-risk', request: 'op-1' });
    const b = pmClose(ctx, 'm-reopen', { mode: 'with-risk', request: 'op-1' });
    assert.equal(b.repeated, true);
    assert.equal(b.version, a.version);
    const c = pmClose(ctx, 'm-reopen', { mode: 'with-risk', request: 'op-2' });
    assert.equal(c.version, a.version + 1, 'a new snapshot version');
  });
});

describe('coordinator round-1 additions: the handover, refused checks, the words session', () => {
  const queued = (ctx: ProcessProject['ctx'], task: string) =>
    ctx.memory.read((db) => JSON.parse((db.stmt("SELECT record FROM log WHERE kind = 'task.queued' AND json_extract(record, '$.task') = ? ORDER BY rev LIMIT 1").get(task) as { record: string }).record) as { queuedBy?: { dispatch: string | null; task: string | null; objects: string[]; step: string } });

  it('every queued task records who handed it over (U-13): the PM command, the Architect dispatch and plan, the Constructor\'s candidate', async () => {
    p = processProject();
    const ctx = p.ctx;
    await startAddMission(ctx, M);
    const cal1 = await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    assert.deepEqual(queued(ctx, dispatchView(ctx, cal1.dispatch).info.task).queuedBy, { dispatch: null, task: null, objects: ['pmplan.m1.1'], step: 'mp pm plan submit' });
    const arch = await step(ctx, 'architect-decompose', () => addDetailedPlan(M));
    await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
    const con = await readyOf(ctx, 'constructor');
    const qb = queued(ctx, con.step).queuedBy!;
    assert.equal(qb.task, dispatchView(ctx, arch.dispatch).info.task, 'the Architect task that decomposed the plan');
    assert.equal(qb.dispatch, arch.dispatch);
    assert.ok(qb.objects[0]?.startsWith('dplan.'));
    const d = pmDispatch(ctx, con.step);
    write(join(p.dir, d.worktree!), 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    write(join(p.dir, d.worktree!), 'src/check.js', CHECK_JS);
    await handBack(ctx, d.dispatch, { done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    const rev = await readyOf(ctx, 'reviewer');
    const rb = queued(ctx, rev.step).queuedBy!;
    assert.deepEqual([rb.dispatch, rb.task, rb.objects], [d.dispatch, con.step, [`prod.con.${M}.impl.1`]]);
  });

  it('a Secretary task raised by a Reviewer\'s needs-decision names that Reviewer dispatch and the candidate (code review r2 #7)', async () => {
    const { reviewer } = await import('../src/flow/scripted.ts');
    p = processProject();
    await addMissionToReview(p, M);
    const ctx = p.ctx;
    const rev = await step(ctx, 'reviewer', (c) => reviewer(c, 'needs-decision'));
    const sec = await readyOf(ctx, 'secretary');
    const qb = queued(ctx, sec.step).queuedBy!;
    assert.equal(qb.dispatch, rev.dispatch, 'the Reviewer dispatch, not the plan task id');
    assert.equal(qb.task, dispatchView(ctx, rev.dispatch).info.task);
    assert.deepEqual(qb.objects, [`prod.con.${M}.impl.1`], 'the candidate');
    assert.match(qb.step, /reviewer-needs-decision/);
  });

  it('a refused hand-back does not count, but its check results are recorded against the dispatch with the reasons', async () => {
    p = processProject();
    const ctx = p.ctx;
    await startAddMission(ctx, M);
    const s = await readyOf(ctx, 'calibrator-1');
    const d = pmDispatch(ctx, s.step);
    const a = await handBack(ctx, d.dispatch, { nonsense: true });
    assert.equal(a.kind, 'refused');
    const rows = ctx.memory.read((db) => db.stmt("SELECT body FROM flow_events WHERE line = ? AND event = 'refused'").all(`dispatch:${d.dispatch}`) as Array<{ body: string }>);
    assert.equal(rows.length, 1);
    const body = JSON.parse(ctx.memory.data.text(rows[0]!.body)) as { command: string; passed: boolean; problems: string[] };
    assert.equal(body.passed, false);
    assert.deepEqual(body.problems, a.kind === 'refused' ? [...a.problems] : []);
    assert.equal(dispatchView(ctx, d.dispatch).info.state, 'in-flight', 'decision 14: it does not count');
  });

  it('the words are recorded in the PM session mp pm session recorded', async () => {
    const { recordPmAction, wordsEntry } = await import('../src/memory/index.ts');
    const { pmSay } = await import('../src/process/index.ts');
    p = processProject();
    const ctx = p.ctx;
    ctx.memory.write({ op: 'pm:sess-7', payload: {} }, (tx) => recordPmAction(tx, { action: 'sess-7', command: 'session', args: { filler: null }, state: 'started' }));
    const w = pmSay(ctx, 'Hello there.').words;
    assert.equal(ctx.memory.read((db) => wordsEntry(db, w))?.session, 'sess-7');
  });
});
