// The Stabilizer's "answered" judgment (4.1 §6.3): on an in-scope finding the author revised, or
// rebutted with an evidence execution, the Stabilizer may judge that the answer resolves it. The
// finding is then resolved at once, without the attacker's re-check, and a round left with nothing
// in scope, fatal or serious, unresolved (on track, no direction question waiting) passes: the
// exploration converges in that round, the budget's last included, or its method passes. A later
// attacker may still re-check an answered finding, and "no" reopens it. Hand-backs without the
// field read as before.

import assert from 'node:assert/strict';
import { after, describe, it, test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { cal1Pass } from '../src/flow/scripted.ts';
import { listNotices, pmMission, pmPlan, pmRequirement, pmSay } from '../src/process/index.ts';
import { handBackSchema } from '../src/seat/card.ts';
import { handBackProblems, seatCardEntry } from '../src/seat/cards/index.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { ExperimentCard } from '../src/seat/cards/experiment.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import { answerable, type StabilizerCard, type StabilizerResult } from '../src/seat/cards/stabilizer.ts';
import { explorationHandoffs, explorationState } from '../src/flow/exploration/flow.ts';
import { M, attack, blind, cardOf, finding, hand, only, recheckAll, reviseAll, stabilizeAll, submit, world, type World } from './flow-exploration-fixtures.ts';
import { cli } from './cli-fixtures.ts';
import { processProject, step } from './process-fixtures.ts';

/** Every finding in scope at the attacker's severity; the listed ones (default: every one the Stabilizer may answer) answered. */
function answer(card: StabilizerCard, ids?: readonly string[]): StabilizerResult {
  const r = stabilizeAll(card);
  const which = ids ?? card.findings.filter((f) => answerable(f)).map((f) => f.id);
  return { ...r, findings: r.findings.map((x) => (which.includes(x.finding) ? { ...x, answered: true } : x)) };
}

/** Queue the round's Stabilizer and hand back its judgment; the hand-back's problems (empty: accepted). */
async function stabilize(w: World, judge: (card: StabilizerCard) => StabilizerResult): Promise<string[]> {
  await w.advance();
  const t = only(w, 'stabilizer');
  return w.scheduler.run(t.task, { handBack: judge(t.card as unknown as StabilizerCard) });
}

/** Round 1 (a serious finding, revised, kept for the re-check), then round 2 with a new serious finding the author revises; the round-2 Stabilizer is next. */
async function twoRounds(w: World): Promise<{ readonly c2: CrititorCard }> {
  w.autoStabilize = false;
  await w.advance();
  await hand(w, 'researcher-author', submit('v1: the scheduler waits for the evidence'));
  await w.advance();
  await hand(w, 'crititor', attack([finding('serious', 'internal contradiction', 'two rules disagree')]));
  await w.advance();
  await hand(w, 'researcher-author', submit('v2: one rule', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
  assert.deepEqual(await stabilize(w, (c) => stabilizeAll(c)), []);
  await w.advance();
  const c2 = cardOf<CrititorCard>(w, 'crititor');
  await hand(w, 'crititor', attack([finding('serious', 'gets stuck (deadlock, a wait that never ends)', 'a lost run waits forever')], recheckAll(c2, 'yes')));
  await w.advance();
  await hand(w, 'researcher-author', submit('v3: a lost run times out and is recorded as failed', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
  return { c2 };
}

describe('the Stabilizer answers a revised finding', () => {
  test('the last round of the budget: a serious finding revised and judged answered converges instead of exhausting', async () => {
    const w = await world({ rounds: 2 });
    const { c2 } = await twoRounds(w);
    assert.deepEqual(await stabilize(w, (c) => answer(c)), []);
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    assert.equal(r.stopped?.wi, null);
    assert.equal(r.rounds, 2, 'no round past the budget');
    assert.equal(w.scheduler.queued('crititor').length, 0, 'no re-check round and no closing attacker');

    const s = await explorationState(w, M, w.x);
    const f2 = [...s.findings.values()].find((f) => f.round === 2);
    assert.equal(f2?.status, 'resolved');
    assert.equal(f2?.answered, 2, 'resolved by the round-2 Stabilizer');
    assert.deepEqual(f2?.rechecks, [], 'not by a re-check');
    assert.equal([...s.findings.values()].find((f) => f.round === 1)?.answered, null, 'the round-1 finding was resolved by the re-check');

    // proof model: the attacked version stays negated; the revision is passed by the same position
    const v3 = s.version?.id as string;
    assert.notEqual(v3, c2.target);
    const labels = (await w.evaluator.labels([v3, c2.target as string])).labels;
    assert.equal(labels[v3], 'proven');
    assert.equal(labels[c2.target as string], 'negated');
    const judgments = (await w.ledger.records(['judgment'])).map((x) => x.record).filter((j) => j.executor === 'stabilizer');
    assert.deepEqual(
      judgments.slice(-2).map((j) => [j.target === v3 ? 'v3' : j.target === c2.target ? 'v2' : '?', j.review, j.verdict]),
      [
        ['v2', 'crititor', 'fail'],
        ['v3', 'crititor', 'pass'],
      ],
    );
    assert.match(judgments.at(-1)?.judgment ?? '', /^xpj\.M1\.E1\.\d+\.revision$/);
    assert.deepEqual(judgments.at(-1)?.issues, [{ issue: f2?.id, response: 'fixed' }]);
    assert.equal(judgments.at(-1)?.revokes, null);

    // the hand-off settles on the revision, and says how the finding was resolved
    const h = (await explorationHandoffs(w.ledger, M))[0]?.handoff;
    assert.equal(h?.version?.id, v3);
    assert.deepEqual(h?.unresolvedBlocking, []);
    assert.equal(h?.findings.find((f) => f.id === f2?.id)?.answered, 2);
    assert.equal(h?.stabilizer.at(-1)?.findings[0]?.answered, true);
    const n = w.ledger.notices.find((x) => x.category === 'exploration-converged');
    assert.match(n?.trigger ?? '', /answered/);
    assert.match(n?.trigger ?? '', /2 of 2 rounds used/);
  });

  test('without "answered" the same exploration exhausts its budget, as before', async () => {
    const w = await world({ rounds: 2 });
    await twoRounds(w);
    assert.deepEqual(await stabilize(w, (c) => stabilizeAll(c)), []);
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'budget-exhausted');
    assert.equal(r.stopped?.wi, 'WI-08');
    const s = await explorationState(w, M, w.x);
    const f2 = [...s.findings.values()].find((f) => f.round === 2);
    assert.equal(f2?.status, 'awaiting-recheck');
    assert.equal(f2?.answered, null);
    assert.ok((await w.ledger.records(['judgment'])).every((j) => !j.record.judgment.endsWith('.revision')), 'no pass on the revision');
    assert.equal(w.ledger.notices.find((x) => x.category === 'exploration-converged'), undefined);
  });

  test('a mid-budget round whose serious findings are all answered passes without another attack round', async () => {
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('fatal', 'cannot be implemented', 'needs an oracle'), finding('serious', 'internal contradiction', 'two rules disagree'), finding('minor', 'wording', 'a typo')]));
    await w.advance();
    await hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    // the fatal and the serious one are answered; the minor one is left for a re-check that never binds
    assert.deepEqual(await stabilize(w, (c) => answer(c, c.findings.filter((f) => f.severity !== 'minor').map((f) => f.id))), []);
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    assert.equal(r.rounds, 1, 'one attack round of the 8 allowed');
    assert.equal(w.scheduler.queued('crititor').length, 0);
    const s = await explorationState(w, M, w.x);
    assert.deepEqual(
      [...s.findings.values()].map((f) => [f.severity, f.status, f.answered]),
      [
        ['fatal', 'resolved', 1],
        ['serious', 'resolved', 1],
        ['minor', 'awaiting-recheck', null],
      ],
    );
    assert.equal((await w.evaluator.labels([s.version?.id as string])).labels[s.version?.id as string], 'proven');
  });

  test('a serious finding left unanswered keeps the round open: the attacker re-checks it next round', async () => {
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'internal contradiction', 'two rules disagree'), finding('serious', 'gets stuck', 'waits forever')]));
    await w.advance();
    await hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    const st = await (async () => {
      await w.advance();
      return cardOf<StabilizerCard>(w, 'stabilizer');
    })();
    assert.deepEqual(await w.scheduler.run(only(w, 'stabilizer').task, { handBack: answer(st, [st.findings[0]?.id as string]) }), []);
    const r = await w.advance();
    assert.equal(r.state, 'waiting');
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c.fresh, false);
    assert.deepEqual(
      c.priorFindings.map((f) => [f.status, f.answered ?? null]),
      [
        ['resolved', 1],
        ['awaiting-recheck', null],
      ],
    );
    assert.ok((await w.ledger.records(['judgment'])).every((j) => !j.record.judgment.endsWith('.revision')), 'the revision is not passed while a serious finding waits');
  });
});

describe('refused "answered" judgments', () => {
  test('on a finding the author escalated, out of scope, or not disposed of: the hand-back is refused', async () => {
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', "conflicts with the user's words", 'uses a server'), finding('serious', 'internal contradiction', 'two rules disagree')]));
    await w.advance();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    const [esc, rev] = [a.openFindings[0]?.id as string, a.openFindings[1]?.id as string];
    await hand(w, 'researcher-author', submit('v2', [{ finding: esc, action: 'escalate', note: 'the user said no server', question: 'May we run a local server?' }, { finding: rev, action: 'revise', note: 'one rule' }]));
    await w.advance();
    const t = only(w, 'stabilizer');
    const card = t.card as unknown as StabilizerCard;
    const escalated = await w.scheduler.run(t.task, { handBack: answer(card, [esc]) });
    assert.ok(escalated.some((p) => p.includes(`findings[${esc}]`) && p.includes('escalated')), escalated.join('; '));
    const base = answer(card, []);
    const outOfScope = { ...base, findings: base.findings.map((x) => (x.finding === rev ? { ...x, verdict: 'out-of-scope' as const, answered: true } : x)) };
    const refused = await w.scheduler.run(t.task, { handBack: outOfScope });
    assert.ok(refused.some((p) => p.includes(`findings[${rev}]`) && p.includes('only an in-scope finding')), refused.join('; '));
    // the revised one is answerable; the escalated one still waits for its ruling, so the round does not
    // pass on the revision (no direction question may be pending): the attacker's next round comes, as before
    assert.deepEqual(await w.scheduler.run(t.task, { handBack: answer(card, [rev]) }), []);
    await w.advance();
    const s = await explorationState(w, M, w.x);
    assert.deepEqual([s.findings.get(esc)?.status, s.findings.get(rev)?.status, s.findings.get(rev)?.answered], ['awaiting-ruling', 'resolved', 1]);
    assert.equal(s.stopped, null);
    assert.deepEqual(
      cardOf<CrititorCard>(w, 'crititor').priorFindings.map((f) => [f.id, f.status, f.answered ?? null]),
      [
        [esc, 'awaiting-ruling', null],
        [rev, 'resolved', 1],
      ],
    );
    assert.ok((await w.ledger.records(['judgment'])).every((j) => !j.record.judgment.endsWith('.revision')), 'no pass while a direction question waits');
  });

  test('on a finding the author never disposed of (the attacker passed with a minor one): refused', async () => {
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('minor', 'wording', 'a typo')]));
    await w.advance();
    const t = only(w, 'stabilizer');
    const card = t.card as unknown as StabilizerCard;
    const id = card.findings[0]?.id as string;
    const refused = await w.scheduler.run(t.task, { handBack: answer(card, [id]) });
    assert.ok(refused.some((p) => p.includes(`findings[${id}]`) && p.includes('revised, or rebutted')), refused.join('; '));
  });
});

describe('an answered finding reopened by a later attack', () => {
  test('the attacker may re-check it (not required); "no" reopens it like a failed re-check', async () => {
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'internal contradiction', 'two rules disagree'), finding('serious', 'gets stuck', 'waits forever')]));
    await w.advance();
    await hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    await w.advance();
    const st = cardOf<StabilizerCard>(w, 'stabilizer');
    const [answeredId, waiting] = [st.findings[0]?.id as string, st.findings[1]?.id as string];
    assert.deepEqual(await w.scheduler.run(only(w, 'stabilizer').task, { handBack: answer(st, [answeredId]) }), []);
    await w.advance();

    const t = only(w, 'crititor');
    const c = t.card as unknown as CrititorCard;
    // its re-check is optional: one for the finding awaiting it is enough
    const only1 = attack([], [{ finding: waiting, resolved: 'yes', reason: 'fixed', evidence: [] }]);
    assert.deepEqual(handBackProblems(c, only1, {}), []);
    // twice is refused, as for any finding
    const twice = attack([], [...only1.rechecks, { finding: answeredId, resolved: 'no', reason: 'a', evidence: [] }, { finding: answeredId, resolved: 'no', reason: 'b', evidence: [] }]);
    assert.ok(handBackProblems(c, twice, {}).some((p) => p.includes('re-checked 2 times')));
    await hand(w, 'crititor', attack([], [...only1.rechecks, { finding: answeredId, resolved: 'no', reason: 'the two rules still disagree in the timeout case', evidence: [] }]));
    const r = await w.advance();
    assert.equal(r.state, 'waiting');

    // reopened as a failed re-check is: open, its disposition and its answer cleared, the re-check kept
    const s = await explorationState(w, M, w.x);
    const f = s.findings.get(answeredId);
    assert.equal(f?.status, 'open');
    assert.equal(f?.disposition, null);
    assert.equal(f?.answered, null);
    assert.deepEqual(f?.rechecks.map((x) => [x.round, x.resolved]), [[2, 'no']]);
    assert.equal(s.findings.get(waiting)?.status, 'resolved');
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.deepEqual(a.openFindings.map((x) => x.id), [answeredId]);
    // the attack's own judgment on v2 is a refutation (the reopened finding stands on it)
    const atk = (await w.ledger.records(['judgment'])).map((x) => x.record).filter((j) => j.executor === 'crititor').at(-1);
    assert.equal(atk?.verdict, 'fail');
    assert.deepEqual(atk?.issues.map((i) => [i.issue, i.response]).sort(), [[answeredId, 'not-fixed'], [waiting, 'fixed']].sort());
  });
});

describe('an answered rebuttal and a research method', () => {
  const REQUEST = { steps: ['run `node probe.js` with the lost-run fixture'], data: 'fixture: lost-run.json', measure: ['result status'], assertions: ['the result status is "failed", not missing'] };

  test('a rebuttal answered on the attacked version: the Stabilizer\'s own judgment passes it, citing the evidence', async () => {
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'silently leaves an error behind', 'a lost run leaves no record')]));
    await w.advance();
    await w.scheduler.run(only(w, 'researcher-author').task, { evidence: REQUEST, notes: 'notes' });
    await w.advance();
    await hand(w, 'constructor-experiment', blind(cardOf<ExperimentCard>(w, 'constructor-experiment'), 'yes'));
    await w.advance();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    await hand(w, 'researcher-author', submit('', [{ finding: a.openFindings[0]?.id as string, action: 'rebut', note: 'the run shows the record', evidence: 'xpe.M1.E1.1' }]));
    assert.deepEqual(await stabilize(w, (c) => answer(c)), []);
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    assert.equal(r.rounds, 1);
    const s = await explorationState(w, M, w.x);
    assert.equal(s.versions.length, 1, 'no new version');
    const j = (await w.ledger.records(['judgment'])).map((x) => x.record).at(-1);
    assert.equal(j?.executor, 'stabilizer');
    assert.equal(j?.target, s.version?.id);
    assert.equal(j?.verdict, 'pass');
    assert.deepEqual(w.ledger.content.getList(j?.evidence as never), ['xpe.M1.E1.1'], 'the version rests on the rebuttal\'s evidence');
    assert.ok((await w.ledger.records(['judgment'])).every((x) => !x.record.judgment.endsWith('.revision')));
    assert.equal((await w.evaluator.labels([s.version?.id as string])).labels[s.version?.id as string], 'proven');
  });

  test('a research method whose finding is answered passes: its registered attempts start, with no further attack', async () => {
    const w = await world({ product: 'answer', research: true, question: 'Does the file lock survive a crash?' });
    w.autoStabilize = false;
    const attempt = { id: 'A1', kind: 'experiment' as const, purpose: 'does the lock survive a crash', steps: ['run crash.sh 20 times'], data: '', measure: ['survivals'], assertions: ['all 20 survive'] };
    await w.advance();
    await hand(w, 'researcher-author', submit('method v1', [], { attempts: [attempt] }));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'method', 'twenty runs say nothing about rare crashes')]));
    await w.advance();
    await hand(w, 'researcher-author', submit('method v2: 200 runs', reviseAll(cardOf<AuthorCard>(w, 'researcher-author')), { attempts: [{ ...attempt, steps: ['run crash.sh 200 times'] }] }));
    assert.deepEqual(await stabilize(w, (c) => answer(c)), []);
    await w.advance();
    const s = await explorationState(w, M, w.x);
    assert.equal(s.phase, 'attempts');
    assert.equal(s.method?.version, s.version?.id, 'the revised method passed');
    assert.deepEqual(s.method?.attempts.map((x) => x.steps), [['run crash.sh 200 times']], 'with the register submitted with it');
    assert.equal(w.scheduler.queued('crititor').length, 0);
    assert.equal(cardOf<ExperimentCard>(w, 'constructor-experiment').evidence.attempt, 'A1');
  });
});

describe('hand-backs without the field', () => {
  test('parse and read as "not answered"; the stored judgment carries no new field', async () => {
    const old = { findings: [{ finding: 'finding:x', verdict: 'in-scope', severity: 'serious', reason: 'a real hole', question: '' }], round: { verdict: 'on-track', reason: 'answers it', question: '' } };
    const parsed = seatCardEntry('stabilizer').resultSchema.safeParse(old);
    assert.equal(parsed.success, true);
    const schema = handBackSchema('stabilizer') as { properties: { findings: { items: { required: string[]; properties: Record<string, unknown> } } } };
    assert.ok('answered' in schema.properties.findings.items.properties, 'the card shows the field');
    assert.ok(!schema.properties.findings.items.required.includes('answered'), 'and does not require it');

    const w = await world();
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'internal contradiction', 'two rules disagree')]));
    await w.advance();
    await hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    await w.advance();
    const stabilized = (await w.ledger.events({ mission: M, line: `exploration:${w.x}`, event: 'consumed' })).map((e) => e.body as { kind: string }).filter((b) => b.kind === 'stabilized');
    assert.equal(stabilized.length, 1);
    assert.ok(!('revision' in stabilized[0]!));
    assert.ok(!JSON.stringify(stabilized[0]).includes('answered'));
    const s = await explorationState(w, M, w.x);
    assert.deepEqual([...s.findings.values()].map((f) => [f.status, f.answered]), [['awaiting-recheck', null]]);
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.ok(c.priorFindings.every((f) => !('answered' in f)), 'cards without an answered finding are as before');
  });
});

describe('through mp: the hand-back, the settle and the reads', () => {
  const p = processProject();
  after(() => p.cleanup());

  it('a one-round exploration whose revision the Stabilizer answers settles on the revision, proven; show exploration says how it was resolved', async () => {
    const ctx = p.ctx;
    const m = 'm1' as MissionId;
    pmMission(ctx, m);
    const words = pmSay(ctx, 'Find a cache design with no obvious logical hole. The details are yours to decide.').words;
    await pmRequirement(ctx, { mission: m, item: 'a1', type: 'authorization', text: "Details are the PM's", quote: 'The details are yours to decide', words });
    await pmPlan(ctx, {
      mission: m,
      words: [words],
      plan: {
        format: 'mp4.pm-plan.v1',
        mission: m,
        round: 1,
        order: 'free',
        elements: [
          {
            id: 'x',
            kind: 'exploration',
            text: 'Design the cache',
            provenance: { by: 'user', words, quote: 'Find a cache design' },
            exploration: { id: 'X1', deliverable: 'a cache design', fuzzyGoal: { quote: 'no obvious logical hole', words }, attackScope: ['internal contradiction'], decision: { id: 'D1', type: 'structure' }, budget: { rounds: 1, micros: null }, stop: '', research: false },
            after: [],
            items: [],
          },
        ],
        goalsBeyond: [],
        authorizations: ['a1'],
      },
    });
    await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(ctx, 'researcher-author', () => ({ step: 'submit', message: 'a version', artifact: 'v1: an LRU cache with a lock', dispositions: [], directionQuestions: [], attempts: [] }));
    await step(ctx, 'crititor', () => ({ findings: [{ severity: 'serious', class: 'internal contradiction', title: 'the lock and the eviction contradict', basis: 'the passage', consequence: 'it deadlocks', direction: 'fix it', evidence: [] }], rechecks: [], settled: [], reply: 'assessment' }));
    await step(ctx, 'researcher-author', (c: AuthorCard) => ({ step: 'submit', message: 'v2', artifact: 'v2: lock-free eviction', dispositions: c.openFindings.map((f) => ({ finding: f.id, action: 'revise', note: 'changed' })), directionQuestions: [], attempts: [] }));
    await step(ctx, 'stabilizer', (c: StabilizerCard) => ({
      findings: c.findings.map((f) => ({ finding: f.id, verdict: 'in-scope', severity: 'serious', reason: 'a real hole, and v2 removes the lock from eviction', question: '', answered: true })),
      round: { verdict: 'on-track', reason: 'answers the question', question: '' },
    }));
    assert.equal((await cli(p.dir, ['pm', 'next'])).code, 0);

    const json = await cli(p.dir, ['read', 'show', 'exploration', `${m}/X1`, '--json']);
    assert.equal(json.code, 0, json.err);
    const x = json.json.result[0];
    assert.equal(x.stopped.reason, 'converged');
    assert.equal(x.settled.body.outcome, 'conclusion');
    assert.equal(x.settled.body.artifact, x.version.id, 'settled on the revision');
    assert.equal(x.findings[0].answered, 1);
    const show = await cli(p.dir, ['read', 'show', 'exploration', 'X1']);
    assert.match(show.out, /resolved \(answered: the Stabilizer of round 1 judged the author's revision resolves it, no re-check\)/);
    assert.match(show.out, /the author's revision \S+ passed on its answers/);
    const obj = await cli(p.dir, ['read', 'show', 'object', x.version.id, '--json']);
    assert.match(obj.json.result.items[0].node.state, /^proven$/);
    assert.equal(ctx.memory.read((db) => listNotices(db, ctx.memory.data, { includeAcknowledged: true }).filter((n) => n.category === 'exploration-conclusion-unproven').length), 0);
  });
});
