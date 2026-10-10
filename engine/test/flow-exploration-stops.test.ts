// Stop rules of an exploration (design 8.2, 6.5, 3.11): budget exhausted, the same class of fatal
// finding not fixed twice, no progress, a seat given up; each hands the exploration to the
// decision layer with its WI; rulings extend or retry. And a restart mid-exploration from ledger
// state alone, including a crash between submitting a task and recording it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import { advanceExploration, explorationHandoffs, explorationState, recordExplorationRuling } from '../src/flow/exploration/flow.ts';
import { fold, decide } from '../src/flow/exploration/machine.ts';
import { M, attack, cardOf, finding, hand, only, recheckAll, reviseAll, submit, world } from './flow-exploration-fixtures.ts';

describe('exploration stops', () => {
  test('budget exhausted → decision layer with WI-08; an extend ruling resumes where it stopped', async () => {
    const w = await world({ rounds: 2 });
    await w.advance();
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    hand(w, 'crititor', attack([finding('serious', 'cost out of control', 'unbounded retries')]));
    await w.advance();
    hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    await w.advance();
    hand(w, 'crititor', attack([finding('serious', 'gets stuck (deadlock, a wait that never ends)', 'lock order')], recheckAll(cardOf<CrititorCard>(w, 'crititor'), 'yes')));
    let r = await w.advance();
    assert.equal(r.state, 'stopped');
    assert.equal(r.stopped?.reason, 'budget-exhausted');
    assert.equal(r.stopped?.wi, 'WI-08');
    assert.equal(w.scheduler.queued().length, 0, 'no author turn is wasted after the last round');
    const n = w.ledger.notices.find((x) => x.category === 'exploration-budget-exhausted');
    assert.equal(n?.wi, 'WI-08');
    assert.match(n?.defaultAction ?? '', /Secretary decides/);
    const h = (await explorationHandoffs(w.ledger, M))[0]?.handoff;
    assert.equal(h?.reason, 'budget-exhausted');
    assert.equal(h?.unresolvedBlocking.length, 1);
    assert.ok(h?.version?.id.startsWith('xpv.M1.E1.'));

    await recordExplorationRuling(w, M, w.x, { id: 'G1', decision: 'extend', findings: [], text: 'two more rounds', extraRounds: 2, by: 'secretary' });
    r = await w.advance();
    assert.equal(r.state, 'waiting');
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(a.budgetRounds, 4);
    assert.equal(a.openFindings.length, 1);
  });

  test('the same class of fatal finding not fixed in two consecutive rounds → decision layer', async () => {
    const w = await world({ rounds: 10 });
    await w.advance();
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    hand(w, 'crititor', attack([finding('fatal', 'cannot be implemented', 'needs global time')]));
    for (let i = 2; i <= 3; i++) {
      await w.advance();
      hand(w, 'researcher-author', submit(`v${i}`, reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
      await w.advance();
      hand(w, 'crititor', attack([], recheckAll(cardOf<CrititorCard>(w, 'crititor'), 'no')));
    }
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'fatal-repeat');
    assert.equal(r.stopped?.wi, 'WI-08');
    assert.equal(r.rounds, 3);
  });

  test('a new fatal finding of a class still open counts as a failed fix of that class', async () => {
    const w = await world({ rounds: 10 });
    await w.advance();
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    hand(w, 'crititor', attack([finding('fatal', 'gets stuck', 'A waits for B')]));
    await w.advance();
    hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    await w.advance();
    // fixed, but a new fatal of the same class appears: the class was not fixed
    hand(w, 'crititor', attack([finding('fatal', 'gets stuck', 'B waits for C')], recheckAll(cardOf<CrititorCard>(w, 'crititor'), 'yes')));
    await w.advance();
    hand(w, 'researcher-author', submit('v3', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    await w.advance();
    hand(w, 'crititor', attack([finding('fatal', 'gets stuck', 'C waits for A')], recheckAll(cardOf<CrititorCard>(w, 'crititor'), 'yes')));
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'fatal-repeat');
  });

  test('no progress: the same unresolved serious findings two rounds in a row, nothing new → WI-08', async () => {
    const w = await world({ rounds: 10 });
    await w.advance();
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    hand(w, 'crititor', attack([finding('serious', 'internal contradiction', 'two answers')]));
    for (let i = 2; i <= 3; i++) {
      await w.advance();
      hand(w, 'researcher-author', submit(`v${i}`, reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
      await w.advance();
      hand(w, 'crititor', attack([], recheckAll(cardOf<CrititorCard>(w, 'crititor'), 'no')));
    }
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'no-progress');
    assert.equal(r.stopped?.wi, 'WI-08');
    assert.equal(w.ledger.notices.find((x) => x.category === 'exploration-no-progress')?.wi, 'WI-08');
  });

  test('a given-up attacker task stops the exploration (WI-15); a retry ruling queues the turn again', async () => {
    const w = await world();
    await w.advance();
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    const t = only(w, 'crititor');
    w.scheduler.run(t.task, { fail: 'seat-failure' });
    let r = await w.advance();
    assert.equal(r.state, 'waiting', 'a failure waits for the Secretary first (the scheduler raised WI-15)');
    await w.scheduler.cancel(t.task);
    r = await w.advance();
    assert.equal(r.stopped?.reason, 'seat-abandoned');
    assert.equal(r.stopped?.wi, 'WI-15');
    await recordExplorationRuling(w, M, w.x, { id: 'retry-1', decision: 'retry', findings: [], text: '', extraRounds: 0, by: 'pm' });
    r = await w.advance();
    assert.equal(r.state, 'waiting');
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c.mode, 'attack');
    assert.notEqual(only(w, 'crititor').task, t.task);
  });

  test('restart mid-exploration from ledger state: the same next step, nothing repeated, a lost record re-made', async () => {
    const w = await world();
    await w.advance();
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    hand(w, 'crititor', attack([finding('serious', 'internal contradiction', 'x')]));
    // the driver "crashes" after submitting the author's task, before recording it
    w.ledger.failNext = (op) => op.startsWith(`xp:M1.${w.x}:queue:`);
    await assert.rejects(() => w.advance(), /injected failure/);
    const before = [...w.scheduler.tasks.keys()];
    // a new driver over the same ledger and scheduler (nothing in memory carried over)
    const s0 = await explorationState(w, M, w.x);
    assert.equal(decide(s0).kind, 'author', 'the ledger state names the same next step');
    const r = await advanceExploration({ ledger: w.ledger, scheduler: w.scheduler }, M, w.x);
    assert.equal(r.state, 'waiting');
    assert.deepEqual([...w.scheduler.tasks.keys()], before, 'the task was not submitted twice');
    const s1 = await explorationState(w, M, w.x);
    assert.equal([...s1.tasks.values()].filter((q) => q.role === 'author').length, 2);
    // folding the same events again gives the same state (pure)
    const evs = (await w.ledger.events({ mission: M, line: `exploration:${w.x}` })).map((e) => ({ event: e.event, key: e.key, body: e.body }));
    assert.deepEqual(JSON.stringify([...fold(evs).findings.values()]), JSON.stringify([...s1.findings.values()]));
    // advancing again with nothing finished takes no step
    assert.equal((await w.advance()).steps, 0);
  });
});

describe('exploration spend budget', () => {
  test('the exploration\'s own spend limit stops it before a new turn (WI-08); an extension with spend resumes it', async () => {
    const { fakePorts } = await import('../src/flow/fakes.ts');
    const { explorationDefinition } = await import('../src/flow/exploration/definition.ts');
    const { defineExploration } = await import('../src/flow/exploration/flow.ts');
    const p = fakePorts();
    await defineExploration(p, explorationDefinition({ exploration: 'S1', mission: M, product: 'design', goal: 'g', decision: { type: 'structure', text: 'd' }, budget: { rounds: 10, spendMicros: 1_000_000 } }));
    const adv = () => advanceExploration(p, M, 'S1');
    await adv();
    const t = p.scheduler.queued('researcher-author')[0];
    assert.ok(t);
    assert.deepEqual(p.scheduler.run(t.task, { handBack: submit('v1') }), []);
    // the author's launch spent 1.2 dollars (settled) — over the exploration's 1 dollar
    const launch = p.scheduler.tasks.get(t.task)?.launches[0] as string;
    await p.ledger.append('spend', {
      records: [
        { kind: 'spend.reserve', reservation: 'r1' as never, mission: M, launch: launch as never, micros: 2_000_000 },
        { kind: 'spend.settle', reservation: 'r1' as never, micros: 1_200_000, how: 'usage' },
      ],
    });
    const r = await adv();
    assert.equal(r.stopped?.reason, 'budget-exhausted');
    assert.equal(r.stopped?.wi, 'WI-08');
    assert.equal(p.scheduler.queued('crititor').length, 0);
    await recordExplorationRuling(p, M, 'S1', { id: 'more', decision: 'extend', findings: [], text: 'more', extraRounds: 2, extraMicros: 500_000, by: 'user' });
    const r2 = await adv();
    assert.equal(r2.state, 'waiting');
    assert.equal(p.scheduler.queued('crititor').length, 1);
  });
});
