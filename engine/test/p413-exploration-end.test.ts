// 4.1.3 (E-3, E-1; issues #46, #25, #38, #39): an exploration's end is judged by its state, not by
// its round counter. One rule ends every round (machine.ts roundEnd): the Stabilizer judged it on
// track, no direction question waits (read from the record at the hand-back), every in-scope fatal
// or serious finding is resolved on the version judged. The budget only limits whether another
// round may start.
//   a  #46: a granted last round whose attacker re-check resolves the last finding converges (it
//      used to wait for a closing attacker and stop as budget-exhausted)
//   b  a normal round converges at once (no closing attacker)
//   c  #25: a ruling recorded while the Stabilizer runs counts: its answered findings converge the
//      round; a ruling recorded after its hand-back gets one new Stabilizer for the same round
//   d  a round that waited for a ruling ends once ruled: one new Stabilizer judges it, no attack round
//   e  "answered" inside the rule: re-checked yes, re-checked no (reopened, answered again), never
//      re-checked, settled then reopened by a repair
//   f  a grant carries the decision's instructions to the next cards (#38); a grant naming findings
//      gives the author a turn on them, general ones included (#39); the Secretary's schema
//   g  "accept" at the budget step when nothing is unresolved (E-1): converged by the decision

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { answerEscalation } from '../src/flow/secretary.ts';
import { recordRepair } from '../src/flow/repair.ts';
import { EXPLORATION_SETTLED, PLAN_LINE, PM_PLAN_EFFECTIVE, SECRETARY_LINE, type ExplorationSettledBody, type PmPlanDoc, type PmPlanEffectiveBody } from '../src/flow/plandoc.ts';
import { explorationStep, settledArtifactProven } from '../src/flow/exploration/step.ts';
import { explorationHandoffs, explorationState, recordExplorationRuling, redefineExploration } from '../src/flow/exploration/flow.ts';
import { roundEnd, type XState } from '../src/flow/exploration/machine.ts';
import { secretaryProblems, type SecretaryCard, type SecretaryResult } from '../src/seat/cards/secretary.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import { answerable, type StabilizerCard, type StabilizerResult } from '../src/seat/cards/stabilizer.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';
import { M, attack, cardOf, finding, hand, only, recheckAll, reviseAll, stabilizeAll, submit, world, type World } from './flow-exploration-fixtures.ts';

/** Every finding in scope at the attacker's severity; the listed ones (default: every answerable one) answered. */
function answer(card: StabilizerCard, ids?: readonly string[]): StabilizerResult {
  const r = stabilizeAll(card);
  const which = ids ?? card.findings.filter((f) => answerable(f)).map((f) => f.id);
  return { ...r, findings: r.findings.map((x) => (which.includes(x.finding) ? { ...x, answered: true } : x)) };
}

/** Queue the round's Stabilizer and hand back a judgment of it. */
async function stabilize(w: World, judge: (card: StabilizerCard) => StabilizerResult): Promise<void> {
  await w.advance();
  const t = only(w, 'stabilizer');
  assert.deepEqual(await w.scheduler.run(t.task, { handBack: judge(t.card as unknown as StabilizerCard) }), []);
}

const state = (w: { ledger: World['ledger'] }, x = 'E1'): Promise<XState> => explorationState({ ledger: w.ledger }, M, x);

/** An exploration started by an effective PM plan, driven by the flow engine's exploration step (decisions are carried out). */
async function planned(rounds: number) {
  const p = memoryPorts();
  const ports = { ledger: p.ledger, scheduler: p.scheduler, evaluator: p.evaluator };
  const doc: PmPlanDoc = {
    format: 'mp4.pm-plan.v1',
    mission: M,
    round: 1,
    order: 'free',
    elements: [
      {
        id: 'el1',
        kind: 'exploration',
        text: 'how the scheduler hands evidence back',
        provenance: { by: 'user', words: 'W-1', quote: 'figure out the evidence hand-back' },
        exploration: {
          id: 'X1',
          deliverable: 'a design of the evidence hand-back',
          fuzzyGoal: { quote: 'no obvious hole', words: 'W-1' },
          attackScope: ['gets stuck', 'internal contradiction'],
          decision: { id: 'D1', type: 'structure' },
          budget: { rounds, micros: null },
          stop: '',
          research: false,
        },
        after: [],
        items: [],
      },
    ],
    goalsBeyond: [],
    authorizations: [],
  };
  const body: PmPlanEffectiveBody = { plan: 'pmplan.1', batch: 'b1', round: 1, doc: p.ledger.content.put(JSON.stringify(doc)), explorations: ['X1'] };
  await p.ledger.append('pm-effective', { events: [{ mission: M, line: PLAN_LINE, event: PM_PLAN_EFFECTIVE, key: 'pmplan.1', body }] });
  const step = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      const ctx = flowCtx(ports, M);
      await explorationStep(ctx);
      if (!ctx.progressed) break;
    }
  };
  const one = (kind: string) => {
    const q = p.scheduler.queued(kind);
    assert.equal(q.length, 1, `one queued ${kind}: ${q.map((t) => t.task).join(', ')}`);
    return q[0]!;
  };
  /** Hand back the one queued task of a kind; then the flow's step. */
  const hand1 = async (kind: string, r: unknown): Promise<void> => {
    assert.deepEqual(await p.scheduler.run(one(kind).task, { handBack: r }), []);
    await step();
  };
  const escalations = async () => (await p.ledger.events<{ id: string; source: string; options: string[]; reasons: string[] }>({ mission: M, line: SECRETARY_LINE, event: 'escalation' })).map((e) => e.body);
  const settled = async () => (await p.ledger.events<ExplorationSettledBody>({ mission: M, line: 'exploration:X1', event: EXPLORATION_SETTLED })).map((e) => e.body);
  return { ...p, ports, step, one, hand1, escalations, settled };
}

/**
 * Two rounds with a budget of two: round 1's serious finding is revised (round 2's attacker resolves
 * it), round 2 raises another serious one, which the author revises; the Stabilizer keeps it for the
 * re-check. No round is left: a budget stop.
 */
async function budgetStop(w: Awaited<ReturnType<typeof planned>>, extra: readonly ReturnType<typeof finding>[] = []): Promise<void> {
  await w.step();
  await w.hand1('researcher-author', submit('v1'));
  await w.hand1('crititor', attack([finding('serious', 'gets stuck', 'waits forever')]));
  await w.hand1('researcher-author', submit('v2', reviseAll(w.one('researcher-author').card as unknown as AuthorCard)));
  await w.hand1('stabilizer', stabilizeAll(w.one('stabilizer').card as unknown as StabilizerCard));
  const c2 = w.one('crititor').card as unknown as CrititorCard;
  await w.hand1('crititor', attack([finding('serious', 'internal contradiction', 'two rules'), ...extra], recheckAll(c2, 'yes')));
  await w.hand1('researcher-author', submit('v3', reviseAll(w.one('researcher-author').card as unknown as AuthorCard)));
  await w.hand1('stabilizer', stabilizeAll(w.one('stabilizer').card as unknown as StabilizerCard));
}

describe('a: #46, a granted last round converges by the one rule', () => {
  test('the granted round\'s attacker re-check resolves the last finding, 0 new, on track: converged, not budget-exhausted', async () => {
    const w = await planned(2);
    await budgetStop(w);
    const s0 = await state(w, 'X1');
    assert.equal(s0.stopped?.reason, 'budget-exhausted');
    const esc = (await w.escalations())[0]!;
    assert.equal(esc.source, 'exploration-budget');
    assert.ok(!esc.options.includes('accept'), 'a serious finding awaits its re-check: no plain accept');
    await answerEscalation(w.ports, { mission: M, escalation: esc.id, option: 'grant', grantExtra: 1, words: 'one more round' });
    await w.step();
    const c3 = w.one('crititor').card as unknown as CrititorCard;
    assert.equal(c3.fresh, false);
    await w.hand1('crititor', attack([], recheckAll(c3, 'yes')));
    await w.hand1('stabilizer', stabilizeAll(w.one('stabilizer').card as unknown as StabilizerCard));
    const s = await state(w, 'X1');
    assert.equal(s.stopped?.reason, 'converged');
    assert.equal(s.rounds, 3);
    assert.equal(w.scheduler.queued('crititor').length, 0, 'no closing attacker');
    assert.deepEqual((await w.settled()).map((b) => [b.outcome, b.stop]), [['conclusion', 'converged']]);
    assert.equal((await w.evaluator.labels([c3.target as string])).labels[c3.target as string], 'proven');
  });
});

describe('b: a normal round converges at once', () => {
  test('a round with nothing in scope unresolved on its version converges in that round (no closing attacker)', async () => {
    const w = await world({ rounds: 3 });
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('general', 'wording', 'a sentence is unclear')]));
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    assert.equal(r.rounds, 1);
    assert.equal(w.scheduler.queued('crititor').length, 0);
  });

  test('roundEnd reads the state: open blocking → author; awaiting re-check → attack; pending direction → await-ruling; pending verdict → rejudge; else converged', async () => {
    const w = await world();
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    const s = await state(w);
    const v = s.version!.id;
    assert.equal(roundEnd(s, { judged: v, verdict: 'pass', again: false }), 'converged');
    assert.equal(roundEnd(s, { judged: v, verdict: 'undecided', again: false }), 'rejudge');
    assert.equal(roundEnd(s, { judged: v, verdict: 'undecided', again: true }), 'attack');
    assert.equal(roundEnd(s, { judged: 'another-version', verdict: 'pass', again: false }), 'attack');
    assert.equal(roundEnd({ ...s, pendingQuestions: [{ task: 't', questions: ['q?'] }] }, { judged: v, verdict: 'pass', again: false }), 'await-ruling');
    assert.equal(roundEnd(s, { judged: v, verdict: 'pass', basis: 'an-older-definition', again: false }), 'attack');
  });
});

/** Round 1: a serious finding; the author revises it and asks a direction question; the round's Stabilizer is queued. */
async function questionRound(w: World): Promise<{ readonly author: string }> {
  w.autoStabilize = false;
  await w.advance();
  await hand(w, 'researcher-author', submit('v1'));
  await w.advance();
  await hand(w, 'crititor', attack([finding('serious', 'gets stuck', 'waits forever')]));
  await w.advance();
  const a = only(w, 'researcher-author');
  await hand(w, 'researcher-author', submit('v2: a timeout', reviseAll(a.card as unknown as AuthorCard), { directionQuestions: ['May the timeout be one hour?'] }));
  await w.advance();
  return { author: a.task };
}

describe('c: #25, the direction questions as the record holds them at the Stabilizer\'s hand-back', () => {
  test('the ruling recorded while the Stabilizer runs counts: its answered finding converges the round, on the revision, proven', async () => {
    const w = await world({ rounds: 1 });
    const { author } = await questionRound(w);
    const t = only(w, 'stabilizer');
    const card = t.card as unknown as StabilizerCard;
    assert.equal(card.pendingDirection?.length, 1, 'the card lists the question as waiting');
    w.scheduler.dispatchOf(t.task);
    // the Secretary rules while the Stabilizer runs
    await recordExplorationRuling(w, M, w.x, { id: 'dq1', decision: 'answer', findings: [], answers: author, text: 'Yes, one hour.', extraRounds: 0, by: 'secretary' });
    assert.deepEqual(await w.scheduler.run(t.task, { handBack: answer(card) }), []);
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged', 'the last round converges: nothing waited by the time it handed back');
    assert.equal(r.rounds, 1);
    const judgments = (await w.ledger.records(['judgment'])).map((x) => x.record).filter((j) => j.executor === 'stabilizer');
    assert.deepEqual(judgments.map((j) => [j.verdict, j.judgment.endsWith('.revision')]), [
      ['fail', false],
      ['pass', true],
    ]);
    const s = await state(w);
    assert.equal((await w.evaluator.labels([s.version!.id])).labels[s.version!.id], 'proven');
    assert.equal(w.scheduler.queued('stabilizer').length, 0, 'no second Stabilizer');
  });

  test('a redirect recorded while the Stabilizer runs reopens the finding it answers: judged with the ruling, the answer does not count; the author has the turn', async () => {
    const w = await world({ rounds: 2 });
    await questionRound(w);
    const t = only(w, 'stabilizer');
    const card = t.card as unknown as StabilizerCard;
    w.scheduler.dispatchOf(t.task);
    const f = card.findings[0]!.id;
    await recordExplorationRuling(w, M, w.x, { id: 'redir', decision: 'redirect', findings: [f], text: 'Use a lease instead of a timeout.', extraRounds: 0, by: 'user' });
    assert.deepEqual(await w.scheduler.run(t.task, { handBack: answer(card) }), [], 'the seat answered what its card showed');
    await w.advance();
    const s = await state(w);
    assert.deepEqual([s.findings.get(f)?.status, s.findings.get(f)?.answered, s.turn], ['open', null, 'author']);
    assert.ok((await w.ledger.records(['judgment'])).every((j) => !j.record.judgment.endsWith('.revision')), 'no pass on the revision');
    assert.equal(cardOf<AuthorCard>(w, 'researcher-author').openFindings[0]?.ruling, 'Use a lease instead of a timeout.');
  });

  test('a ruling recorded after the hand-back, before it is taken into account: one new Stabilizer judges the same round (no round spent)', async () => {
    const w = await world({ rounds: 1 });
    const { author } = await questionRound(w);
    const t = only(w, 'stabilizer');
    assert.deepEqual(await w.scheduler.run(t.task, { handBack: answer(t.card as unknown as StabilizerCard) }), []);
    await recordExplorationRuling(w, M, w.x, { id: 'dq1', decision: 'answer', findings: [], answers: author, text: 'Yes.', extraRounds: 0, by: 'secretary' });
    await w.advance();
    const again = only(w, 'stabilizer');
    assert.notEqual(again.task, t.task);
    assert.deepEqual((again.card as unknown as StabilizerCard).pendingDirection, []);
    assert.equal((again.card as unknown as StabilizerCard).round, 1, 'the same round');
    assert.deepEqual(await w.scheduler.run(again.task, { handBack: answer(again.card as unknown as StabilizerCard) }), []);
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    assert.equal(r.rounds, 1);
  });
});

describe('d: a round that waited for a ruling ends once ruled', () => {
  test('nothing open but the author\'s question: after the answer one new Stabilizer judges the round, no attack round, and it converges', async () => {
    const w = await world({ rounds: 2 });
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1', [], { directionQuestions: ['Is a file lock acceptable?'] }));
    const author = [...(await state(w)).tasks.values()].find((q) => q.role === 'author')!.task;
    await w.advance();
    await hand(w, 'crititor', attack());
    await stabilize(w, (c) => stabilizeAll(c));
    const r1 = await w.advance();
    assert.equal(r1.state, 'waiting');
    assert.equal((await state(w)).turn, 'await-ruling');
    await recordExplorationRuling(w, M, w.x, { id: 'dq1', decision: 'answer', findings: [], answers: author, text: 'Yes.', extraRounds: 0, by: 'user' });
    await w.advance();
    assert.equal(w.scheduler.queued('crititor').length, 0, 'no attack round for a round that only waited for the ruling');
    await stabilize(w, (c) => stabilizeAll(c));
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    assert.equal(r.rounds, 1);
  });
});

/** Round 1: two serious findings revised; the Stabilizer answers the first only (the second waits for its re-check). */
async function oneAnswered(w: World): Promise<{ readonly answered: string; readonly other: string }> {
  w.autoStabilize = false;
  await w.advance();
  await hand(w, 'researcher-author', submit('v1'));
  await w.advance();
  await hand(w, 'crititor', attack([finding('serious', 'internal contradiction', 'two rules'), finding('serious', 'gets stuck', 'waits forever')]));
  await w.advance();
  await hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
  await w.advance();
  const card = cardOf<StabilizerCard>(w, 'stabilizer');
  const [first, second] = [card.findings[0]!.id, card.findings[1]!.id];
  assert.deepEqual(await w.scheduler.run(only(w, 'stabilizer').task, { handBack: answer(card, [first]) }), []);
  await w.advance();
  return { answered: first, other: second };
}

describe('e: "answered" stays, inside the rule', () => {
  test('answered, then re-checked yes by a later attacker: it stays resolved and the round converges', async () => {
    const w = await world();
    const { answered, other } = await oneAnswered(w);
    const c2 = cardOf<CrititorCard>(w, 'crititor');
    await hand(w, 'crititor', attack([], [...recheckAll(c2, 'yes'), { finding: answered, resolved: 'yes', reason: 'confirmed', evidence: [] }]));
    await stabilize(w, (c) => stabilizeAll(c));
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    const s = await state(w);
    assert.deepEqual([s.findings.get(answered)?.status, s.findings.get(answered)?.answered], ['resolved', 1]);
    assert.equal(s.findings.get(other)?.status, 'resolved');
  });

  test('answered, then re-checked no: reopened, the author answers it again, the Stabilizer answers it, the round converges', async () => {
    const w = await world();
    const { answered } = await oneAnswered(w);
    const c2 = cardOf<CrititorCard>(w, 'crititor');
    await hand(w, 'crititor', attack([], [...recheckAll(c2, 'yes'), { finding: answered, resolved: 'no', reason: 'still contradicts', evidence: [] }]));
    await w.advance();
    let s = await state(w);
    assert.deepEqual([s.findings.get(answered)?.status, s.findings.get(answered)?.answered, s.turn], ['open', null, 'author']);
    const a3 = cardOf<AuthorCard>(w, 'researcher-author');
    assert.deepEqual(a3.openFindings.map((f) => f.id), [answered]);
    await hand(w, 'researcher-author', submit('v3', reviseAll(a3)));
    await stabilize(w, (c) => answer(c));
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    s = await state(w);
    assert.deepEqual([s.findings.get(answered)?.status, s.findings.get(answered)?.answered], ['resolved', 2]);
  });

  test('answered and never re-checked: the round converges on the revision', async () => {
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'gets stuck', 'waits forever')]));
    await w.advance();
    await hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    await stabilize(w, (c) => answer(c));
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    assert.equal(r.rounds, 1);
  });

  test('converged on an answered finding, then reopened by a repair: the author has the turn; the answered finding stays resolved; the next round ends by the rule', async () => {
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'gets stuck', 'waits forever')]));
    await w.advance();
    await hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    await stabilize(w, (c) => answer(c));
    assert.equal((await w.advance()).stopped?.reason, 'converged');
    const id = [...(await state(w)).findings.keys()][0]!;
    const words = say(w, 'The timeout must be configurable.');
    await recordRepair(w.ports, { mission: M, words, kind: 'missing', text: 'The timeout must be configurable.', about: { kind: 'exploration', id: w.x } });
    await w.advance();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(a.repairs?.[0]?.text, 'The timeout must be configurable.');
    assert.equal((await state(w)).findings.get(id)?.status, 'resolved');
    await hand(w, 'researcher-author', submit('v3: configurable'));
    await w.advance();
    await hand(w, 'crititor', attack());
    await stabilize(w, (c) => stabilizeAll(c));
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    assert.equal(r.stopped?.n, 2);
  });
});

describe('f: a grant buys what it is for', () => {
  test('#38: a grant\'s instructions are on the next round\'s attacker and Stabilizer cards; a grant with none adds nothing to the cards', async () => {
    const w = await planned(2);
    await budgetStop(w);
    const esc = (await w.escalations())[0]!;
    await answerEscalation(w.ports, { mission: M, escalation: esc.id, option: 'grant', grantExtra: 1, instructions: 'Re-check the contradiction against section 2 of the record.', words: 'one more round' });
    await w.step();
    const c3 = w.one('crititor').card as unknown as CrititorCard;
    assert.ok(c3.rulings.some((r) => r.startsWith('(grant of 1 round(s), by user) Re-check the contradiction against section 2')), c3.rulings.join(' | '));
    await w.hand1('crititor', attack([], recheckAll(c3, 'yes')));
    const st = w.one('stabilizer').card as unknown as StabilizerCard;
    assert.ok(st.rulings.some((r) => r.includes('Re-check the contradiction')));
  });

  test('#39: a grant naming a general finding gives the author a turn on it; it is answered, re-checked, and the round ends by the rule', async () => {
    const w = await planned(2);
    await budgetStop(w, [finding('general', 'reporting', 'a qualification without its source')]);
    const esc = (await w.escalations())[0]!;
    const s0 = await state(w, 'X1');
    const general = [...s0.findings.values()].find((f) => f.severity === 'general')!;
    assert.equal(general.status, 'awaiting-recheck', 'the author revised it with the serious one');
    // a general finding the author did not dispose of: leave it open, then name it
    assert.ok(esc.reasons.some((r) => r.includes(general.id)), 'the reasons list the ids a grant may name');
    await answerEscalation(w.ports, { mission: M, escalation: esc.id, option: 'grant', grantExtra: 1, findings: [general.id], instructions: 'Add the source.', words: 'one more round for the source' });
    await w.step();
    // it awaits a re-check (the author revised it): named, it is open again for the author, with the grant's instructions
    assert.equal(w.scheduler.queued('crititor').length, 0, 'not spent on a re-check of the unchanged version');
    const a4 = w.one('researcher-author').card as unknown as AuthorCard;
    assert.deepEqual(a4.openFindings.map((f) => [f.id, f.ruling]), [[general.id, 'Add the source.']]);
    assert.ok(a4.rulings.some((r) => r.includes(`for ${general.id}`) && r.endsWith('Add the source.')));
    await w.hand1('researcher-author', submit('v4: with the source', reviseAll(a4)));
    // the granted round: its attacker re-checks the revision, then its Stabilizer
    const c4 = w.one('crititor').card as unknown as CrititorCard;
    await w.hand1('crititor', attack([], recheckAll(c4, 'yes')));
    await w.hand1('stabilizer', stabilizeAll(w.one('stabilizer').card as unknown as StabilizerCard));
    const s = await state(w, 'X1');
    assert.equal(s.stopped?.reason, 'converged');
    assert.equal(s.versions.at(-1)?.id, s.version?.id);
    assert.equal(s.findings.get(general.id)?.status, 'resolved');
  });

  test('#39: a grant naming an open general finding gives the author the turn on it though none blocks (here: a round judged under an older definition left it open)', async () => {
    const w = await world({ rounds: 1 });
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    // the definition changes while the round's attacker is at work: its round is judged under the older one
    const t = only(w, 'crititor');
    w.scheduler.dispatchOf(t.task);
    const def = (await state(w)).def!;
    await redefineExploration(w, { ...def, goal: `${def.goal}, and every rule has its source` });
    assert.deepEqual(await w.scheduler.run(t.task, { handBack: attack([finding('general', 'reporting', 'a qualification without its source')]) }), []);
    await stabilize(w, (c) => stabilizeAll(c));
    assert.equal((await w.advance()).stopped?.reason, 'budget-exhausted', 'a fresh attacker under the new definition has no round left');
    const s0 = await state(w);
    const general = [...s0.findings.values()][0]!;
    assert.deepEqual([general.status, s0.turn], ['open', 'attacker']);
    await recordExplorationRuling(w, M, w.x, { id: 'g1', decision: 'extend', findings: [general.id], text: 'one more round', instructions: 'Add the source of the qualification.', extraRounds: 1, by: 'user' });
    await w.advance();
    const a2 = cardOf<AuthorCard>(w, 'researcher-author');
    assert.deepEqual(a2.openFindings.map((f) => f.id), [general.id], 'the author has the turn on the named general finding');
    assert.ok(a2.rulings.some((r) => r.includes(`for ${general.id}`) && r.endsWith('Add the source of the qualification.')), a2.rulings.join(' | '));
    await hand(w, 'researcher-author', submit('v2: with the source', reviseAll(a2)));
    await w.advance();
    const c2 = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c2.fresh, true, 'under the current definition');
    await hand(w, 'crititor', attack([], recheckAll(c2, 'yes')));
    await stabilize(w, (c) => stabilizeAll(c));
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    const s = await state(w);
    assert.deepEqual([s.findings.get(general.id)?.status, s.findings.get(general.id)?.disposition?.action], ['resolved', 'revise']);
  });

  test('without named findings a grant changes no turn (as before)', async () => {
    const w = await world({ rounds: 1 });
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'gets stuck', 'waits forever')]));
    await w.advance();
    await hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    assert.equal((await w.advance()).stopped?.reason, 'budget-exhausted');
    await recordExplorationRuling(w, M, w.x, { id: 'g1', decision: 'extend', findings: [], text: 'one more round', extraRounds: 1, by: 'secretary' });
    await w.advance();
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.deepEqual(c.rulings, [], 'a grant without instructions shows on no card');
  });

  test('the Secretary\'s decision schema: findings only with a grant', () => {
    const card = { options: [{ id: 'grant' }, { id: 'abandon' }], grantAvailable: true, authorizations: [], materials: [] } as unknown as SecretaryCard;
    const base: SecretaryResult = { option: 'grant', classification: 'detail', authorization: null, reason: 'one more', instructions: 'add the source', grantExtra: 1, notice: '', mayMatter: false, findings: ['F1'] };
    assert.deepEqual(secretaryProblems(card, base, new Set()), []);
    assert.ok(secretaryProblems(card, { ...base, option: 'abandon', grantExtra: 0 }, new Set()).some((p) => p.startsWith('findings: only for option "grant"')));
    const { findings: _f, ...old } = base;
    void _f;
    assert.deepEqual(secretaryProblems(card, old as SecretaryResult, new Set()), [], 'a hand-back without the field reads as before');
  });
});

describe('g: plain "accept" when nothing is unresolved (E-1)', () => {
  test('the Stabilizer judged the last round\'s findings general: nothing fatal or serious unresolved, the revision not attacked; the budget step offers accept; accepted, it converges by the decision with no risk list', async () => {
    const w = await planned(1);
    await w.step();
    await w.hand1('researcher-author', submit('v1'));
    await w.hand1('crititor', attack([finding('serious', 'gets stuck', 'waits forever')]));
    await w.hand1('researcher-author', submit('v2', reviseAll(w.one('researcher-author').card as unknown as AuthorCard)));
    await w.hand1('stabilizer', stabilizeAll(w.one('stabilizer').card as unknown as StabilizerCard, 'in-scope', { severity: 'general' }));
    assert.equal((await state(w, 'X1')).stopped?.reason, 'budget-exhausted');
    const esc = (await w.escalations())[0]!;
    assert.deepEqual(esc.options, ['accept', 'grant', 'replan', 'abandon', 'ask-user'], 'accept replaces accept-risk; nothing to send back with no round left');
    await answerEscalation(w.ports, { mission: M, escalation: esc.id, option: 'accept', words: 'that is fine as it is' });
    await w.step();
    const s = await state(w, 'X1');
    assert.equal(s.stopped?.reason, 'converged');
    assert.equal(s.rulings.at(-1)?.decision, 'accept');
    const settled = await w.settled();
    assert.deepEqual(settled.map((b) => [b.outcome, b.stop, b.artifact]), [['conclusion', 'converged', s.version!.id]]);
    assert.match(settled[0]!.summary, /accepted by the decision \(user\)/);
    const h = (await explorationHandoffs(w.ledger, M)).at(-1)!.handoff;
    assert.deepEqual(h.residualRisks, []);
    assert.equal(h.accepted?.by, 'user');
    assert.match(w.ledger.notices.find((n) => n.category === 'exploration-converged')?.trigger ?? '', /accepted the latest version/);
    // the revision no round attacked is passed by the user's own judgment, written with the decision: it stands, and planning plans from it
    const v2 = s.version!.id;
    const j = (await w.ledger.records(['judgment'])).map((c) => c.record).find((r) => r.target === v2);
    assert.deepEqual([j?.judgment, j?.executor, j?.verdict, j?.review], [`j.user.${esc.id}`, 'user', 'pass', 'crititor']);
    assert.equal(h.accepted?.judgment, `j.user.${esc.id}`);
    assert.equal((await w.evaluator.labels([v2])).labels[v2], 'proven');
    assert.equal((await settledArtifactProven(w.ports, M, 'X1')).proven, true, 'the decision layer plans from it (planning.ts explorationState)');
    const applied = (await w.ledger.events<{ what: { judgment?: string } }>({ mission: M, line: SECRETARY_LINE, event: 'applied' })).find((e) => e.key === esc.id);
    assert.equal(applied?.body.what.judgment, `j.user.${esc.id}`, 'the record says the decision passed it');
  });

  test('a research method stopped with nothing unresolved: accept passes the method to its attempts', async () => {
    const w = await world({ product: 'answer', research: true, question: 'Does the lock hold?', decision: { type: 'structure', text: 'which lock' }, rounds: 1 });
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('method v1', [], { attempts: [{ id: 'A1', kind: 'reading', purpose: 'p', steps: ['read'], data: '', measure: ['m'], assertions: [] }] }));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'method', 'no control')]));
    await w.advance();
    await hand(w, 'researcher-author', submit('method v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author')), { attempts: [{ id: 'A1', kind: 'reading', purpose: 'p', steps: ['read', 'compare'], data: '', measure: ['m'], assertions: [] }] }));
    await stabilize(w, (c) => stabilizeAll(c, 'in-scope', { severity: 'general' }));
    assert.equal((await w.advance()).stopped?.reason, 'budget-exhausted');
    await recordExplorationRuling(w, M, w.x, { id: 'acc', decision: 'accept', findings: [], text: 'the method is fine', extraRounds: 0, by: 'user' });
    await w.advance();
    const s = await state(w);
    assert.equal(s.stopped, null);
    assert.equal(s.phase, 'attempts');
    assert.equal(s.method?.version, s.version?.id);
    assert.equal(only(w, 'researcher-reader').card['seat'], 'researcher-reader');
  });
});

void (null as unknown as MissionId);
