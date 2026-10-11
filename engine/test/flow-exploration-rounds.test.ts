// Exploration rounds (design 4.3, 8.2): author and attacker rounds with scripted hand-backs,
// re-checks of earlier findings, the closing attacker, convergence, and the proof-model records
// (5.2, 10.1): versions are objects, rounds are judgments on (version, crititor), findings are
// issues answered by the next round's re-checks.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import { explorationHandoffs, explorationState } from '../src/flow/exploration/flow.ts';
import { M, attack, cardOf, discuss, finding, hand, only, recheckAll, reviseAll, stabilizeAll, submit, world } from './flow-exploration-fixtures.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';

describe('exploration rounds', () => {
  test('converges after a revision, a re-check and the closing attacker; records follow the proof model', async () => {
    const w = await world();
    let r = await w.advance();
    assert.equal(r.state, 'waiting');
    const a1 = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(a1.current, null);
    assert.equal(a1.registerAttempts, false);
    await hand(w, 'researcher-author', submit('design v1: the scheduler waits for the evidence forever'));
    await w.advance();

    // round 1: a serious finding
    const c1 = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c1.mode, 'attack');
    assert.equal(c1.fresh, false);
    assert.ok(c1.target?.startsWith('xpv.M1.E1.'));
    assert.equal(c1.binding?.revokes, null);
    await hand(w, 'crititor', attack([finding('serious', 'gets stuck (deadlock, a wait that never ends)', 'waits forever on a lost evidence run'), finding('minor', 'wording', 'typo')]));
    await w.advance();

    // the author must dispose of both open findings
    const a2 = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(a2.openFindings.length, 2);
    const refused = await w.scheduler.run(only(w, 'researcher-author').task, { handBack: submit('design v2', [a2.openFindings[0] ? { finding: a2.openFindings[0].id, action: 'revise', note: 'timeout added' } : (null as never)]) });
    assert.ok(refused.some((p) => p.includes('has no disposition')), refused.join('; '));
    await hand(w, 'researcher-author', submit('design v2: a lost run times out and is recorded as failed', reviseAll(a2)));
    await w.advance();

    // round 2: the continuing attacker re-checks both; nothing new: a pass, so the closing attacker comes in
    const c2 = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c2.priorFindings.filter((f) => f.status === 'awaiting-recheck').length, 2);
    assert.equal(c2.previousTarget, c1.target);
    const missing = await w.scheduler.run(only(w, 'crititor').task, { handBack: attack([], []) });
    assert.ok(missing.some((p) => p.includes('awaits your re-check')), missing.join('; '));
    await hand(w, 'crititor', attack([], recheckAll(c2, 'yes')));
    r = await w.advance();
    assert.equal(r.rounds, 2);

    const c3 = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c3.fresh, true, 'the closing attacker is a fresh one');
    assert.equal(c3.target, c2.target, 'on the same frozen version');
    assert.equal(c3.continuation, undefined);
    assert.deepEqual(c3.priorFindings, [], 'the fresh view shows no settled history');
    await hand(w, 'crititor', attack());
    r = await w.advance();
    assert.equal(r.state, 'stopped');
    assert.equal(r.stopped?.reason, 'converged');
    assert.equal(r.stopped?.wi, null);

    // proof model: v2 proven by the closing round's Stabilizer; v1 negated by round 1
    const labels = await w.evaluator.labels([c1.target as string, c2.target as string]);
    assert.equal(labels.labels[c1.target as string], 'negated');
    assert.equal(labels.labels[c2.target as string], 'proven');
    const issues = (await w.ledger.records(['issue'])).map((c) => c.record);
    assert.equal(issues.length, 2);
    const judgments = (await w.ledger.records(['judgment'])).map((c) => c.record);
    // 4.1 §6.3 (code review r1 #1): every round is stabilized; the attacker's own judgment is pending
    // until then. Round 1's Stabilizer judges the serious finding in scope: refuted; rounds 2 and 3 pass
    assert.deepEqual(
      judgments.map((j) => [j.target === c1.target ? 'v1' : 'v2', j.verdict, j.executor]),
      [
        ['v1', 'undecided', 'crititor'],
        ['v1', 'fail', 'stabilizer'],
        ['v2', 'undecided', 'crititor'],
        ['v2', 'pass', 'stabilizer'],
        ['v2', 'undecided', 'crititor'],
        ['v2', 'pass', 'stabilizer'],
      ],
    );
    assert.equal(judgments[3]?.revokes, null, 'v2 was never negated');
    assert.deepEqual(judgments[2]?.issues.map((i) => i.response), ['fixed', 'fixed']);

    // the hand-off to the decision layer (8.2 验收): structure → Secretary acceptance
    const h = await explorationHandoffs(w.ledger, M);
    assert.equal(h.length, 1);
    assert.equal(h[0]?.handoff.acceptance, 'secretary');
    assert.equal(h[0]?.handoff.version?.id, c2.target);
    assert.equal(h[0]?.handoff.findings.length, 2);
    assert.deepEqual(h[0]?.handoff.unresolvedBlocking, []);
    const n = w.ledger.notices.find((x) => x.category === 'exploration-converged');
    assert.ok(n);
    assert.equal(n.wi, null);
    assert.equal(n.askUser, undefined, "acceptance is routed by the decision layer (3.10), not asked here");
  });

  test('an attacker finding is re-checked next round; a failed fix stays open and goes back to the author', async () => {
    const w = await world();
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('fatal', 'cannot be implemented', 'needs an oracle')]));
    await w.advance();
    await hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    await w.advance();
    const c2 = cardOf<CrititorCard>(w, 'crititor');
    await hand(w, 'crititor', attack([], recheckAll(c2, 'no')));
    await w.advance();
    const a3 = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(a3.openFindings.length, 1, 'the not-resolved finding is open again');
    assert.equal(a3.openFindings[0]?.disposition, null);
    const s = await explorationState(w, M, w.x);
    const f = [...s.findings.values()][0];
    assert.deepEqual(f?.rechecks.map((x) => x.resolved), ['no']);
    // the version v2 is negated: the round failed
    const labels = await w.evaluator.labels([c2.target as string]);
    assert.equal(labels.labels[c2.target as string], 'negated');
  });

  test('a rebuttal names an evidence execution, and the attacker confirms coverage next round', async () => {
    const w = await world();
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'silently leaves an error behind', 'drops a result')]));
    await w.advance();
    const a2 = cardOf<AuthorCard>(w, 'researcher-author');
    const rebut = [{ finding: a2.openFindings[0]?.id as string, action: 'rebut' as const, note: 'the run shows it is kept', evidence: 'xpe.M1.E1.9' }];
    const refused = await w.scheduler.run(only(w, 'researcher-author').task, { handBack: submit('', rebut) });
    assert.ok(refused.some((p) => p.includes('names a completed evidence execution')), refused.join('; '));
  });

  test('a discussion turn goes to the attacker in discuss mode and counts as a round', async () => {
    const w = await world();
    await w.advance();
    await hand(w, 'researcher-author', discuss('Should "gets stuck" include waits bounded by a user timeout?'));
    await w.advance();
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c.mode, 'discuss');
    assert.equal(c.binding, null);
    assert.equal(c.discussion.length, 1);
    await hand(w, 'crititor', { findings: [], rechecks: [], settled: [], reply: 'Yes: a wait the user must break counts.' });
    const r = await w.advance();
    assert.equal(r.rounds, 1);
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(a.discussion.length, 2);
    assert.equal((await w.ledger.records(['judgment'])).length, 0, 'a discussion is not a judgment');
  });

  test('the closing attacker finds something: rounds go on with it as the attacker, and its next clean round converges', async () => {
    const w = await world();
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack());
    await w.advance();
    assert.equal(cardOf<CrititorCard>(w, 'crititor').fresh, true);
    await hand(w, 'crititor', attack([finding('serious', 'internal contradiction', 'two rules disagree')]));
    await w.advance();
    await hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    await w.advance();
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c.fresh, false, 'the closing attacker continues (not another fresh one)');
    await hand(w, 'crititor', attack([], recheckAll(c, 'yes')));
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    assert.equal(r.rounds, 3);
  });

  test('an escalated finding is a direction question: after the Stabilizer the exploration awaits the ruling; accept-risk sends the attacker back to re-check', async () => {
    const { recordExplorationRuling } = await import('../src/flow/exploration/flow.ts');
    const w = await world({ decision: { type: 'direction', text: 'which store to use' } });
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', "conflicts with the user's words", 'uses a server')]));
    await w.advance();
    const a2 = cardOf<AuthorCard>(w, 'researcher-author');
    const fid = a2.openFindings[0]?.id as string;
    await hand(w, 'researcher-author', submit('', [{ finding: fid, action: 'escalate', note: 'the user said no server', question: 'May we run a local server?' }]));
    let r = await w.advance();
    const q = w.ledger.notices.find((n) => n.category === 'exploration-direction-question');
    assert.ok(q);
    assert.equal(q.wi, null, 'a direction question is a normal branch (the Secretary decides, 3.2)');
    assert.equal(r.state, 'waiting');
    assert.match(r.why, /ruling/);
    assert.equal(w.scheduler.queued().filter((t) => t.card.seat !== 'secretary').length, 0, 'nothing of the exploration runs while only a ruling is missing');
    const judgments = (await w.ledger.records(['judgment'])).map((c) => [c.record.executor, c.record.verdict]);
    assert.deepEqual(judgments, [
      ['crititor', 'undecided'],
      ['stabilizer', 'fail'],
    ]);
    await recordExplorationRuling(w, M, w.x, { id: 'R1', decision: 'accept-risk', findings: [fid], text: 'a local server is fine', extraRounds: 0, by: 'user' });
    await w.advance();
    const c3 = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c3.fresh, false);
    assert.equal(c3.binding?.revokes, 'xpj.M1.E1.4', 'the Stabilizer negated this same version; the next pass names that negation (8.1)');
    await hand(w, 'crititor', attack());
    await w.advance();
    await hand(w, 'crititor', attack());
    r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    assert.equal((await w.evaluator.labels([c3.target as string])).labels[c3.target as string], 'proven', 'the revoking pass restored the version');
    const h = (await explorationHandoffs(w.ledger, M))[0];
    assert.deepEqual(h?.handoff.residualRisks, [fid]);
    assert.equal(h?.handoff.acceptance, 'user', 'a direction-type exploration is accepted by the user (8.2)');
  });
});

describe('exploration rounds: rulings racing a running seat', () => {
  test('a ruling that arrives while the Stabilizer runs is not lost (no wait for a ruling already made)', async () => {
    const { recordExplorationRuling } = await import('../src/flow/exploration/flow.ts');
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'internal contradiction', 'x')]));
    await w.advance();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    const id = a.openFindings[0]?.id as string;
    await hand(w, 'researcher-author', submit('', [{ finding: id, action: 'escalate', note: 'n', question: 'q?' }]));
    await w.advance();
    // the Stabilizer's card shows the finding awaiting a ruling; the ruling arrives before it hands back
    const st = cardOf<StabilizerCard>(w, 'stabilizer');
    assert.equal(st.findings[0]?.status, 'awaiting-ruling');
    await recordExplorationRuling(w, M, w.x, { id: 'R-race', decision: 'accept-risk', findings: [id], text: 'accepted', extraRounds: 0, by: 'user' });
    await hand(w, 'stabilizer', stabilizeAll(st));
    const r = await w.advance();
    assert.equal(r.state, 'waiting');
    assert.doesNotMatch(r.why, /ruling/);
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c.binding?.revokes, 'xpj.M1.E1.4', 'the re-check round names the Stabilizer\'s negation of round 1');
  });
});

describe('exploration ids', () => {
  test('an exploration id with characters ledger ids do not allow still makes valid tasks, launches and records', async () => {
    const w = await world({ exploration: 'my_x' });
    await w.advance();
    const t = only(w, 'researcher-author');
    assert.equal(t.task, 'xp.M1.my-5fx.1.author', 'the id escaped injectively: "_" is "-5f" (review r2)');
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'gets stuck', 'x')]));
    const r = await w.advance();
    assert.equal(r.state, 'waiting');
    assert.ok(r.version?.startsWith('xpv.M1.my-5fx.'));
    const lines = (await w.ledger.events({ mission: M })).map((e) => e.line).filter((l) => !l.startsWith('dispatch:'));
    assert.ok(lines.every((l) => l === 'exploration:my_x'), 'the flow line keeps the plan\'s id');
  });
});
