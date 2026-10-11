// Exploration with the Stabilizer through the 4.1 process (design 4.1 §6.3, U-6; scenarios 5 and
// 10): every attack round is judged by a new Stabilizer (after the author's disposition, or at once
// when the round left nothing to answer). An out-of-scope serious finding does not refute the
// version; a finding that shifts the direction keeps the exploration from passing ("awaiting
// ruling") until the Secretary rules (WI-33); three rounds that do not converge go to the
// Secretary with the Stabilizer's judgments (WI-08).

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { sweepThenClean } from './exploration-exits.ts';
import type { MissionId } from '../src/common/ids.ts';
import { decisionLabels } from '../src/evaluator/index.ts';
import { explorationState } from '../src/flow/exploration/flow.ts';
import { cal1Pass } from '../src/flow/scripted.ts';
import { pmMission, pmNext, pmPlan, pmRequirement, pmSay } from '../src/process/index.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { processProject, step, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
const X = 'X1';
let p: ProcessProject | null = null;
afterEach(() => {
  const q = p;
  p = null;
  if (q !== null) sweepThenClean([q]);
});

async function startExploration(pp: ProcessProject, rounds = 3): Promise<void> {
  const ctx = pp.ctx;
  pmMission(ctx, M);
  const w = pmSay(ctx, 'Find a cache design with no obvious logical hole. Then build it. The details are yours to decide.').words;
  await pmRequirement(ctx, { mission: M, item: 'g1', type: 'goal', text: 'A cache', quote: 'Then build it', words: w });
  await pmRequirement(ctx, { mission: M, item: 'a1', type: 'authorization', text: 'Details are the PM\'s', quote: 'The details are yours to decide', words: w });
  await pmPlan(ctx, {
    mission: M,
    words: [w],
    plan: {
      format: 'mp4.pm-plan.v1',
      mission: M,
      round: 1,
      order: 'free',
      elements: [
        {
          id: 'x',
          kind: 'exploration',
          text: 'Design the cache',
          provenance: { by: 'user', words: w, quote: 'Find a cache design' },
          exploration: {
            id: X,
            deliverable: 'a cache design',
            fuzzyGoal: { quote: 'no obvious logical hole', words: w },
            attackScope: ['internal contradiction', 'gets stuck'],
            decision: { id: 'D1', type: 'structure' },
            budget: { rounds, micros: null },
            stop: '',
            research: false,
          },
          after: [],
          items: [],
        },
        { id: 'e1', kind: 'deliverable', text: 'The cache, built', provenance: { by: 'user', words: w, quote: 'Then build it' }, after: [X], items: ['g1'] },
      ],
      goalsBeyond: [],
      authorizations: ['a1'],
    },
  });
  await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
}

const submit = (artifact: string, dispositions: unknown[] = []) => ({ step: 'submit', message: 'a version', artifact, dispositions, directionQuestions: [], attempts: [] });
const finding = (severity: string, cls: string, title: string) => ({ severity, class: cls, title, basis: `the passage on ${title}`, consequence: 'it goes wrong', direction: 'fix it', evidence: [] });
const attack = (findings: unknown[], card: CrititorCard, resolved: 'yes' | 'no' = 'yes') => ({
  findings,
  rechecks: card.priorFindings.filter((f) => f.status === 'awaiting-recheck').map((f) => ({ finding: f.id, resolved, reason: resolved === 'yes' ? 'fixed' : 'still there', evidence: [] })),
  settled: [],
  reply: 'assessment',
});
const reviseAll = (card: AuthorCard) => card.openFindings.map((f) => ({ finding: f.id, action: 'revise', note: 'changed' }));
const judge = (card: StabilizerCard, verdict: 'in-scope' | 'shifts-direction' | 'out-of-scope', severity: string, drift: 'on-track' | 'drifting' = 'on-track') => ({
  findings: card.findings.map((f) => ({ finding: f.id, verdict, severity, reason: `judged ${verdict}`, question: verdict === 'shifts-direction' ? 'Should the cache also be distributed?' : '' })),
  round: { verdict: drift, reason: drift === 'drifting' ? 'moved away from the question' : 'answers the question', question: drift === 'drifting' ? 'Is the question still a single-node cache?' : '' },
});

describe('process: exploration with the Stabilizer (4.1 §6.3)', () => {
  it('an out-of-scope serious finding does not refute the version; the exploration converges', async () => {
    p = processProject();
    const ctx = p.ctx;
    await startExploration(p);
    await step(ctx, 'researcher-author', () => submit('v1: an LRU cache with a lock'));
    await step(ctx, 'crititor', (c: CrititorCard) => attack([finding('serious', 'cost out of control', 'the cache costs memory')], c));
    let s = await explorationState(ctx.ports(), M, X);
    assert.equal(s.turn, 'author');
    const v1 = s.version!.id;
    assert.notEqual(ctx.memory.read((db) => decisionLabels(db, [v1]))[v1], 'negated', 'a new serious finding leaves the position pending, never refuted before the Stabilizer');
    await step(ctx, 'researcher-author', (c: AuthorCard) => submit('v2: an LRU cache with a lock, sized', reviseAll(c)));
    s = await explorationState(ctx.ports(), M, X);
    assert.equal(s.turn, 'stabilizer', 'dispositioned: the Stabilizer judges the round');
    const st = await step(ctx, 'stabilizer', (c: StabilizerCard) => {
      assert.equal(c.round, 1);
      assert.equal(c.target, v1);
      assert.equal(c.goal, 'no obvious logical hole', 'the goal verbatim');
      assert.equal(c.firstVersion.version, v1);
      assert.equal(c.findings.length, 1);
      assert.equal(c.findings[0]?.disposition?.action, 'revise');
      return judge(c, 'out-of-scope', 'general');
    });
    assert.ok(st.answer.kind === 'recorded' && st.answer.outcome === 'accepted');
    await pmNext(ctx);
    assert.notEqual(ctx.memory.read((db) => decisionLabels(db, [v1]))[v1], 'negated', 'an out-of-scope serious finding never refutes the version');
    s = await explorationState(ctx.ports(), M, X);
    assert.equal([...s.findings.values()][0]?.scope, 'out-of-scope');
    // round 2 passes, the closing attacker passes, each round stabilized: converged
    await step(ctx, 'crititor', (c: CrititorCard) => attack([], c));
    await step(ctx, 'stabilizer', (c: StabilizerCard) => {
      assert.deepEqual(c.findings, [], 'a round without findings is stabilized too (code review r1 #1)');
      return judge(c, 'in-scope', 'general');
    });
    await step(ctx, 'crititor', (c: CrititorCard) => {
      assert.equal(c.fresh, true, 'the closing attacker');
      return attack([], c);
    });
    s = await explorationState(ctx.ports(), M, X);
    assert.equal(s.stopped, null, 'not converged before the closing round is stabilized');
    await step(ctx, 'stabilizer', (c: StabilizerCard) => judge(c, 'in-scope', 'general'));
    s = await explorationState(ctx.ports(), M, X);
    assert.equal(s.stopped?.reason, 'converged');
    const v2 = s.version!.id;
    assert.equal(ctx.memory.read((db) => decisionLabels(db, [v2]))[v2], 'proven');
  });

  it('an in-scope serious finding refutes the version after the Stabilizer judges it', async () => {
    p = processProject();
    const ctx = p.ctx;
    await startExploration(p);
    await step(ctx, 'researcher-author', () => submit('v1: an LRU cache with a lock'));
    await step(ctx, 'crititor', (c: CrititorCard) => attack([finding('serious', 'internal contradiction', 'the lock and the eviction contradict')], c));
    const v1 = (await explorationState(ctx.ports(), M, X)).version!.id;
    await step(ctx, 'researcher-author', (c: AuthorCard) => submit('v2: lock-free eviction', reviseAll(c)));
    await step(ctx, 'stabilizer', (c: StabilizerCard) => judge(c, 'in-scope', 'serious'));
    await pmNext(ctx);
    assert.equal(ctx.memory.read((db) => decisionLabels(db, [v1]))[v1], 'negated');
    const s = await explorationState(ctx.ports(), M, X);
    assert.equal(s.turn, 'attacker', 'stabilized, on track: the next round');
  });

  it('a finding that shifts the direction keeps the exploration from passing (awaiting ruling) until the Secretary rules (WI-33)', async () => {
    p = processProject();
    const ctx = p.ctx;
    await startExploration(p);
    await step(ctx, 'researcher-author', () => submit('v1: an LRU cache'));
    await step(ctx, 'crititor', (c: CrititorCard) => attack([finding('serious', 'internal contradiction', 'a single node cannot scale')], c));
    await step(ctx, 'researcher-author', (c: AuthorCard) => submit('v2: an LRU cache, sharded', reviseAll(c)));
    await step(ctx, 'stabilizer', (c: StabilizerCard) => judge(c, 'shifts-direction', 'serious'));
    const v1 = (await explorationState(ctx.ports(), M, X)).versions[0]!.id;
    assert.notEqual(ctx.memory.read((db) => decisionLabels(db, [v1]))[v1], 'negated', 'a direction finding never refutes');
    let next = await pmNext(ctx);
    assert.ok(next.notices.some((n) => n.wi === 'WI-33'), next.notices.map((n) => `${n.category}/${n.wi}`).join(', '));
    // the question gates only the passing (code review r1 #2): the next round runs meanwhile
    let s = await explorationState(ctx.ports(), M, X);
    assert.equal(s.turn, 'attacker');
    await step(ctx, 'crititor', (c: CrititorCard) => attack([], c));
    await step(ctx, 'stabilizer', (c: StabilizerCard) => {
      assert.ok((c.pendingDirection ?? []).length === 1, 'the pending question is on the card');
      return judge(c, 'in-scope', 'general');
    });
    s = await explorationState(ctx.ports(), M, X);
    assert.equal(s.turn, 'await-ruling', 'the round would pass: it waits for the ruling');
    assert.equal(s.stopped, null);
    const v2 = s.version!.id;
    assert.notEqual(ctx.memory.read((db) => decisionLabels(db, [v2]))[v2], 'proven', 'pending while the question waits');
    next = await pmNext(ctx);
    assert.equal(next.ready.filter((r) => r.kind === 'crititor').length, 0, 'no attack while it waits for the ruling');
    // the Secretary keeps the definition: the finding is set aside, the rounds go on
    await step(ctx, 'secretary', (c: SecretaryCard) => {
      assert.equal(c.request.source, 'exploration-direction');
      assert.deepEqual(c.options.map((o) => o.id), ['answer', 'send-back', 'abandon', 'ask-user']);
      return { option: 'answer', classification: 'important-within-authority', authorization: c.authorizations[0]?.id ?? null, reason: 'the question is a single-node cache', instructions: 'Keep the single-node design.', grantExtra: 0, notice: 'kept the definition', mayMatter: false };
    });
    await pmNext(ctx);
    s = await explorationState(ctx.ports(), M, X);
    assert.equal(s.turn, 'attacker', 'ruled: the position\'s next judgment');
    assert.equal([...s.findings.values()][0]?.status, 'resolved');
  });

  it('an author\'s direction question stays pending until its ruling: no convergence, no acceptance (code review r1 #2)', async () => {
    p = processProject();
    const ctx = p.ctx;
    await startExploration(p, 6);
    await step(ctx, 'researcher-author', () => ({ ...submit('v1: an LRU cache'), directionQuestions: ['Should we change the mission goal to a distributed cache?'] }));
    await step(ctx, 'crititor', (c: CrititorCard) => attack([], c));
    await step(ctx, 'stabilizer', (c: StabilizerCard) => {
      assert.equal((c.pendingDirection ?? []).length, 1, 'the pending question is on the card');
      return judge(c, 'in-scope', 'general');
    });
    let s = await explorationState(ctx.ports(), M, X);
    assert.equal(s.stopped, null);
    assert.equal(s.turn, 'await-ruling', 'the round passed: only the ruling stands before the closing attacker');
    const v1 = s.version!.id;
    assert.notEqual(ctx.memory.read((db) => decisionLabels(db, [v1]))[v1], 'proven', 'pending while the question waits');
    const next = await pmNext(ctx);
    assert.deepEqual(next.ready.map((r) => r.kind), ['secretary'], 'no attack while it waits; the Secretary decides the question');
    await step(ctx, 'secretary', (c: SecretaryCard) => {
      assert.equal(c.request.source, 'exploration-direction');
      return { option: 'answer', classification: 'important-within-authority', authorization: c.authorizations[0]?.id ?? null, reason: 'stays single-node', instructions: 'No: a single-node cache.', grantExtra: 0, notice: 'answered the author: single-node', mayMatter: false };
    });
    await pmNext(ctx);
    s = await explorationState(ctx.ports(), M, X);
    assert.deepEqual(s.pendingQuestions, [], 'only the ruling cleared it');
    // the closing attacker, then its Stabilizer: converged
    await step(ctx, 'crititor', (c: CrititorCard) => {
      assert.equal(c.fresh, true);
      return attack([], c);
    });
    await step(ctx, 'stabilizer', (c: StabilizerCard) => {
      assert.deepEqual(c.pendingDirection ?? [], []);
      return judge(c, 'in-scope', 'general');
    });
    s = await explorationState(ctx.ports(), M, X);
    assert.equal(s.stopped?.reason, 'converged');
    assert.equal(ctx.memory.read((db) => decisionLabels(db, [v1]))[v1], 'proven');
  });

  it('three rounds that do not converge go to the Secretary with the Stabilizer\'s judgments (WI-08)', async () => {
    p = processProject();
    const ctx = p.ctx;
    await startExploration(p, 3);
    await step(ctx, 'researcher-author', () => submit('v1'));
    for (let round = 1; round <= 3; round++) {
      await step(ctx, 'crititor', (c: CrititorCard) => attack([finding('serious', 'internal contradiction', `hole ${round}`)], c));
      await step(ctx, 'researcher-author', (c: AuthorCard) => submit(`v${round + 1}`, reviseAll(c)));
      await step(ctx, 'stabilizer', (c: StabilizerCard) => judge(c, 'in-scope', 'serious'));
    }
    const s = await explorationState(ctx.ports(), M, X);
    assert.equal(s.stopped?.reason, 'budget-exhausted');
    assert.equal(s.stabilizations.length, 3, 'every round was stabilized');
    const next = await pmNext(ctx);
    assert.ok(next.notices.some((n) => n.wi === 'WI-08' && n.category === 'exploration-budget-exhausted'));
    await step(ctx, 'secretary', (c: SecretaryCard) => {
      assert.equal(c.request.source, 'exploration-budget');
      assert.ok(c.request.reasons.some((r) => r.startsWith('Stabilizer, round 3')), c.request.reasons.join(' | '));
      assert.ok(c.options.some((o) => o.id === 'grant'), 'WI-08: one extension within the Secretary\'s authority');
      return { option: 'grant', classification: 'detail', authorization: null, reason: 'converging', instructions: '', grantExtra: 1, notice: '', mayMatter: false };
    });
    await pmNext(ctx);
    assert.equal((await explorationState(ctx.ports(), M, X)).stopped, null, 'extended: one more round');
  });
});
