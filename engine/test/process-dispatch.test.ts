// The PM's dispatch loop and the seat commands (design 4.1 §5.4, §6.5, §6.6; decisions 13, 15,
// 18): an interrupted dispatch released --abandoned and dispatched again (counted), a late
// hand-back recorded and not accepted, the re-dispatch loop used up (WI-08, the Secretary); a
// stop with dispatches in flight; a sampling rerun executing every time; an environment change
// (4.1.2: proof stays, labelled "older environment"; `mp pm renew` is the PM's explicit tool).

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { MissionId, ObjectVersionId, StopId } from '../src/common/ids.ts';
import { cal1Pass } from '../src/flow/scripted.ts';
import { decisionLabels } from '../src/evaluator/index.ts';
import { dispatchInfo, LedgerError, loopState } from '../src/memory/index.ts';
import { pmDispatch, pmNext, pmRelease, pmRenew, pmStop, seatRerun } from '../src/process/index.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import { addDetailedPlan, addMissionToReview, ENV_B, handBack, processProject, readAll, readyOf, reviewerPass, startAddMission, step, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
let p: ProcessProject | null = null;
afterEach(() => {
  p?.cleanup();
  p = null;
});

describe('process: interrupted dispatches (§5.4, WI-28, decision 15)', () => {
  it('release --abandoned queues the step again at once (counted); a late hand-back is recorded and not accepted', async () => {
    p = processProject();
    const ctx = p.ctx;
    await startAddMission(ctx, M);
    const s = await readyOf(ctx, 'calibrator-1');
    const d1 = pmDispatch(ctx, s.step, { filledBy: 'claude-code/opus' });
    let next = await pmNext(ctx);
    assert.equal(next.inFlight.length, 1);
    assert.equal(next.inFlight[0]?.dispatch, d1.dispatch);
    assert.ok(next.inFlight[0]!.ageMs >= 0);
    assert.equal(next.ready.length, 0, 'a step is claimed once');
    assert.throws(() => pmDispatch(ctx, s.step), (e: unknown) => e instanceof LedgerError && e.code === 'NOT_QUEUED');
    // the harness lost the seat; nobody knows whether it still runs
    const rel = await pmRelease(ctx, d1.dispatch, 'abandoned');
    assert.equal(rel.requeued, true);
    assert.equal(rel.attempts, 1, 'the re-dispatch counts against the lineage loop');
    next = await pmNext(ctx);
    assert.deepEqual(next.ready.map((r) => r.step), [s.step]);
    assert.equal(next.ready[0]?.dispatches, 1);
    const d2 = pmDispatch(ctx, s.step, { filledBy: 'codex/gpt' });
    assert.notEqual(d2.dispatch, d1.dispatch);
    // the old seat hands back after all: recorded, not accepted
    readAll(ctx, d1.dispatch);
    const late = await handBack(ctx, d1.dispatch, cal1Pass(dispatchView(ctx, d1.dispatch).card as never));
    assert.ok(late.kind === 'recorded' && late.outcome === 'after-release' && !late.repeated, JSON.stringify(late));
    assert.equal((await pmNext(ctx)).ready.filter((r) => r.kind === 'architect-decompose').length, 0, 'a late hand-back advances nothing');
    // the new dispatch's hand-back is the one that counts
    readAll(ctx, d2.dispatch);
    const ok = await handBack(ctx, d2.dispatch, cal1Pass(dispatchView(ctx, d2.dispatch).card as never));
    assert.ok(ok.kind === 'recorded' && ok.outcome === 'accepted');
    assert.equal((await readyOf(ctx, 'architect-decompose')).kind, 'architect-decompose');
  });

  it('two re-dispatches, then the loop is used up: WI-08 and a Secretary step (grant once)', async () => {
    p = processProject();
    const ctx = p.ctx;
    await startAddMission(ctx, M);
    const s = await readyOf(ctx, 'calibrator-1');
    for (let i = 1; i <= 2; i++) {
      const d = pmDispatch(ctx, s.step);
      const r = await pmRelease(ctx, d.dispatch, 'ended');
      assert.equal(r.requeued, true, `re-dispatch ${i} allowed`);
    }
    const d3 = pmDispatch(ctx, s.step);
    const r3 = await pmRelease(ctx, d3.dispatch, 'ended');
    assert.equal(r3.requeued, false);
    assert.equal(r3.exhausted, true);
    const next = await pmNext(ctx);
    assert.ok(next.notices.some((n) => n.wi === 'WI-08' && n.category === 'loop-exhausted'), next.notices.map((n) => `${n.category}/${n.wi}`).join(', '));
    const sec = next.ready.find((r) => r.kind === 'secretary');
    assert.ok(sec !== undefined, 'the Secretary decides');
    const card = await step(ctx, 'secretary', (c) => {
      // a Calibrator ① step is the plan's own: it is granted or the user decides (it is not given up alone)
      assert.deepEqual(
        c.options.map((o: { id: string }) => o.id),
        ['grant', 'ask-user'],
      );
      return { option: 'grant', classification: 'detail', authorization: null, reason: 'one more try', instructions: '', grantExtra: 1, notice: '', mayMatter: false };
    });
    assert.ok(card.answer.kind === 'recorded');
    // granted: the step is ready again
    const again = await readyOf(ctx, 'calibrator-1');
    assert.equal(again.step, s.step);
  });
});

describe('process: stops (§6.6)', () => {
  it('a stop with a dispatch in flight: "stop recorded; 1 dispatch in flight"; its hand-back is recorded after the stop; nothing in scope is dispatched', async () => {
    p = processProject();
    const ctx = p.ctx;
    await startAddMission(ctx, M);
    const s = await readyOf(ctx, 'calibrator-1');
    const d = pmDispatch(ctx, s.step);
    const st = pmStop(ctx, { stop: 'stop1' as StopId, scope: { kind: 'mission', mission: M }, words: 'stop everything on m1', wordsEntry: null });
    assert.equal(st.inFlight, 1);
    assert.match(st.message, /^stop recorded; 1 dispatch was in flight/);
    readAll(ctx, d.dispatch);
    const a = await handBack(ctx, d.dispatch, cal1Pass(dispatchView(ctx, d.dispatch).card as never));
    assert.ok(a.kind === 'recorded' && a.outcome === 'after-stop', JSON.stringify(a));
    const next = await pmNext(ctx);
    assert.equal(next.ready.filter((r) => r.mission === M && r.kind !== 'secretary').length, 0, 'nothing in scope is ready');
    // a step of the mission that is queued is held, and a dispatch is refused
    for (const h of next.held) assert.match(h.why, /a stop covers it/);
    for (const h of next.held) assert.throws(() => pmDispatch(ctx, h.step), (e: unknown) => e instanceof LedgerError && e.code === 'STOPPED');
  });
});

describe('process: sampling reruns and renewal (§6.5, scenario 7 and 13)', () => {
  it('mp seat rerun executes every time with a new run id; after an environment change proof stays (older environment) and mp pm renew still reruns on the PM\'s word', async () => {
    p = processProject();
    const mark = join(p.dir, '..', 'reruns.txt');
    writeFileSync(mark, '');
    process.env['MP_TEST_RERUN_MARK'] = mark;
    try {
      await addMissionToReview(p, M, {
        detailed: addDetailedPlan(M, { verification: [{ id: 'check', command: 'node src/check.js' }, { id: 'count', command: `node -e "require('fs').appendFileSync(process.env.MP_TEST_RERUN_MARK, 'x')"` }] }),
      });
      let ctx = p.ctx;
      const s = await readyOf(ctx, 'reviewer');
      const d = pmDispatch(ctx, s.step);
      const card = dispatchView(ctx, d.dispatch).card as unknown as ReviewerCard;
      assert.deepEqual(card.declaredCommands.map((c) => c.id), ['check', 'count']);
      const before = readFileSync(mark, 'utf8').length;
      const r1 = await seatRerun(ctx, d.dispatch, 'count');
      const r2 = await seatRerun(ctx, d.dispatch, 'count');
      assert.notEqual(r1.run, r2.run, 'two samples, two run ids');
      assert.equal(readFileSync(mark, 'utf8').length, before + 2, 'each rerun executed (never reused)');
      assert.ok(r1.passed && r2.passed);
      assert.ok(r1.leaf !== null && readFileSync(join(p.dir, '.mission-pipeline', r1.leaf), 'utf8').includes('Run class: sampling'));
      // a pointer to a rerun of this dispatch is valid evidence (the judgment below cites the declared runs only)
      const a = await handBack(ctx, d.dispatch, reviewerPass(card));
      assert.ok(a.kind === 'recorded' && a.outcome === 'accepted', JSON.stringify(a));
      const product = `prod.con.${M}.impl.1` as ObjectVersionId;
      await pmNext(ctx);
      assert.equal(ctx.memory.read((db) => decisionLabels(db, [product]))[product], 'proven');

      // another machine: a new mp process observes another environment identity
      ctx = p.reopen(ENV_B);
      const next = await pmNext(ctx);
      // 4.1.2: runs from an older environment still count; no renew step, one notice naming them
      assert.equal(ctx.memory.read((db) => decisionLabels(db, [product]))[product], 'proven', 'its runs, from an older environment, still count');
      assert.ok(next.olderEnvironmentRuns >= 1);
      assert.ok(next.notices.some((n) => n.category === 'environment-older-runs'), 'the PM is told once');
      // renew stays the PM's explicit tool
      const ren = await pmRenew(ctx);
      assert.ok(ren.reruns.length >= 1, JSON.stringify(ren));
      assert.ok(ren.reruns.every((x) => x.passed));
      assert.deepEqual(ren.reviews, [], 'every judgment rests on declared runs with equal fields');
      await pmNext(ctx);
      assert.equal(ctx.memory.read((db) => decisionLabels(db, [product]))[product], 'proven', 'restored by equal outputs, without a seat');
    } finally {
      delete process.env['MP_TEST_RERUN_MARK'];
    }
  });
});

void dispatchInfo;
void loopState;
