// 4.4 (F10, problem P12): the health of the review seat. `mp read reviews <mission>` gives the share of
// pass, rework and needs-decision of the mission's Reviewer hand-backs per filler of the Reviewer seat and
// per week, and each change of filler. When the pass share of the last 20 reviews since the latest change
// is under half of the share of the 20 before it, the Secretary's loop is told once, by a notice that only
// informs. Nothing is held.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson } from '../src/common/hash.ts';
import type { ContentHash, MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { drive, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import { claimDispatch, queueTask, recordHandback, setMission, type Memory } from '../src/memory/index.ts';
import { listNotices, onlyInforms } from '../src/process/notices.ts';
import { isoWeek, REVIEW_HEALTH, reviewHealth, reviewRows, tellReviewHealth, type ReviewRow } from '../src/process/reviews.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';
import { done43, project43 } from './p43-fixtures.ts';

const M = 'm1' as MissionId;
const DAY = 86_400_000;

/** Reviewer hand-backs recorded as a seat's would be: `[filler, verdict]` each, one dispatch per review. */
function reviews(memory: Memory, mission: string, xs: ReadonlyArray<readonly [string, 'pass' | 'rework' | 'needs-decision']>, from = 0): void {
  memory.write({}, (tx) => {
    setMission(tx, mission as MissionId, 'open');
    xs.forEach(([filler, verdict], j) => {
      const i = from + j;
      const [harness, model] = filler.split('/');
      queueTask(tx, { task: `rev.${mission}.t${i}.1`, lineage: `task.${mission}.t${i}`, mission: mission as MissionId, card: tx.data.put(canonicalJson({ seat: 'reviewer' })) as ContentHash });
      claimDispatch(tx, { dispatch: `D-r${i}`, task: `rev.${mission}.t${i}.1`, seat: 'reviewer', filler: { harness: harness!, model: model ?? null } });
      recordHandback(tx, { dispatch: `D-r${i}`, report: 'r', result: { format: 'mp41.handback.v1', kind: 'handed-back', seat: 's', fields: { verdict }, records: [], candidate: null, request: null, notes: null, runs: [] } });
    });
  });
}

const row = (i: number, filler: string, verdict: ReviewRow['verdict'], at = Date.UTC(2026, 10, 23)): ReviewRow => ({ dispatch: `D-${i}`, task: `t${i}`, filler, verdict, at });

describe('4.4 F10: the health of the review seat', () => {
  it('shares per filler and per week; a change of filler is compared on the 20 reviews either side', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => row(i, 'h/a', i < 16 ? 'pass' : 'rework', Date.UTC(2026, 10, 16 + (i % 5)))),
      ...Array.from({ length: 20 }, (_, i) => row(20 + i, 'h/b', i < 5 ? 'pass' : i < 18 ? 'rework' : 'needs-decision', Date.UTC(2026, 10, 23 + (i % 5)))),
    ];
    const h = reviewHealth('m1', rows);
    assert.deepEqual(h.all, { reviews: 40, pass: 21, rework: 17, needsDecision: 2 });
    assert.deepEqual(h.byFiller.map((f) => [f.filler, f.reviews, f.pass]), [['h/a', 20, 16], ['h/b', 20, 5]]);
    assert.deepEqual(h.byWeek.map((w) => [w.week, w.reviews]), [['2026-W47', 20], ['2026-W48', 20]]);
    assert.equal(h.changes.length, 1);
    assert.deepEqual([h.changes[0]!.at, h.changes[0]!.from, h.changes[0]!.to, h.changes[0]!.before.pass, h.changes[0]!.since.pass, h.changes[0]!.fell], [21, 'h/a', 'h/b', 16, 5, true]);
    // 19 reviews since the change are not yet the 20 compared; a share of half or more is no fall
    assert.equal(reviewHealth('m1', rows.slice(0, 39)).changes[0]!.fell, false);
    assert.equal(reviewHealth('m1', [...rows.slice(0, 20), ...Array.from({ length: 20 }, (_, i) => row(40 + i, 'h/b', i < 8 ? 'pass' : 'rework'))]).changes[0]!.fell, false);
    assert.equal(isoWeek(Date.UTC(2027, 0, 1)), '2026-W53');
    assert.equal(isoWeek(Date.UTC(2026, 10, 28)), '2026-W48');
  });

  it('a real Reviewer hand-back that makes the 20th review since a change of filler tells the Secretary once, by a notice that only informs', async () => {
    const w = memoryPorts({ now: () => Date.UTC(2026, 10, 28) });
    say(w, SEED_TEXT);
    await seedMission(w, M);
    // 20 reviews by an earlier filler, all passes, then 19 by the filler the scripted seats name, all sent back
    reviews(w.memory, M, [...Array.from({ length: 20 }, () => ['h/a', 'pass'] as const), ...Array.from({ length: 19 }, () => ['test-harness/scripted', 'rework'] as const)]);
    tellReviewHealth(w.ctx, M);
    const health = (): ReturnType<typeof listNotices> => w.memory.read((db) => listNotices(db, w.memory.data, { includeAcknowledged: true })).filter((n) => n.category === REVIEW_HEALTH);
    assert.deepEqual(health(), [], 'not before the 20th review since the change');
    await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
    await drive(new FlowEngine(w), w.scheduler, (t, s) => (t.card.seat === 'reviewer' ? { handBack: reviewer(t.card as unknown as ReviewerCard, 'pass') } : happyScript(M)(t, s)));
    const told = health();
    assert.equal(told.length, 1, 'told once, though later reviews came');
    assert.equal(told[0]!.audience, 'secretary');
    assert.ok(onlyInforms(told[0]!), 'a notice that only informs');
    assert.match(told[0]!.trigger, /after the Reviewer's filler changed from h\/a to test-harness\/scripted \(review 21\), the pass share of its last 20 reviews is 5%, under half of the 100% of the 20 before/);
    assert.equal(reviewHealth(M, w.memory.read((db) => reviewRows(db, w.memory.data, M))).changes[0]!.fell, true);
  });

  it('mp read reviews prints the shares, per filler, per week and the changes, from one snapshot', async () => {
    const p = project43();
    try {
      assert.equal((await done43(p, ['read', 'reviews', 'm1'])).all.reviews, 0);
      reviews(p.ctx.memory, 'm1', [['h/a', 'pass'], ['h/a', 'rework'], ['h/b', 'needs-decision']]);
      const r = await done43(p, ['read', 'reviews', 'm1']);
      assert.deepEqual(r.byFiller.map((f: { filler: string; reviews: number }) => [f.filler, f.reviews]), [['h/a', 2], ['h/b', 1]]);
      const { runCli } = await import('../src/cli/main.ts');
      const t = await runCli(['read', 'reviews', 'm1'], { cwd: p.dir, env: {} });
      assert.equal(t.exitCode, 0, t.stderr);
      assert.match(t.stdout, /^Reviews of mission m1: 3 reviews: pass 33% \(1\), rework 33% \(1\), needs-decision 33% \(1\)\nBy filler of the Reviewer seat:\n {2}h\/a: 2 reviews: pass 50% \(1\), rework 50% \(1\), needs-decision 0% \(0\)\n {2}h\/b: 1 review: pass 0% \(0\), rework 0% \(0\), needs-decision 100% \(1\)\nBy week \(UTC\):\n {2}\d{4}-W\d{2}: 3 reviews/);
      assert.match(t.stdout, /Changes of filler:\n {2}review 3 \(D-r2\): h\/a to h\/b; the 2 before: pass 50%; the 1 since \(latest\): pass 0%\n/);
    } finally { p.cleanup(); }
  });
});
