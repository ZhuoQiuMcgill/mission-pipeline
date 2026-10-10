// Regression tests for the code review r1 of the flows (docs/design/code-reviews/
// CodeReview_Flows_r1_gpt-6.1-sol.md), exploration findings: #2 the proof dependency chain, #7 one
// grant per lineage, #8 the user's exit after a refused grant, #17 ids across missions, #19 the
// blind executor's isolation, #20 evidence without an execution behind it. Each test follows the
// reviewer's repro (scratch/review-repros.ts, review-more.ts).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { fakePorts } from '../src/flow/fakes.ts';
import { explorationDefinition } from '../src/flow/exploration/definition.ts';
import { defineExploration, explorationState } from '../src/flow/exploration/flow.ts';
import { explorationStep } from '../src/flow/exploration/step.ts';
import { answerEscalation, secretaryStep } from '../src/flow/secretary.ts';
import { SECRETARY_LINE } from '../src/flow/plandoc.ts';
import { secretary } from '../src/flow/scripted.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { ExperimentCard } from '../src/seat/cards/experiment.ts';
import type { AuthorCard, InterpreterCard } from '../src/seat/cards/researcher.ts';
import { M, attack, blind, cardOf, finding, hand, only, recheckAll, reviseAll, submit, withRuns, world } from './flow-exploration-fixtures.ts';

const REQUEST = { steps: ['run probe'], data: 'fixture', measure: ['status'], assertions: ['record exists'] };

describe('review r1 #2: the exploration proof dependency chain', () => {
  test('the closing attack keeps the rebuttal evidence: revoking it takes the version\'s proof away', async () => {
    const w = await world();
    await w.advance();
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    hand(w, 'crititor', attack([finding('serious', 'silently leaves an error behind', 'missing record')]));
    await w.advance();
    w.scheduler.run(only(w, 'researcher-author').task, { evidence: REQUEST, sessionId: 's1' });
    await w.advance();
    hand(w, 'constructor-experiment', blind(cardOf(w, 'constructor-experiment')));
    await w.advance();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    hand(w, 'researcher-author', submit('', [{ finding: a.openFindings[0]?.id as string, action: 'rebut', note: 'run confirms it', evidence: 'xpe.M1.E1.1' }]));
    await w.advance();
    const c = cardOf<CrititorCard>(w, 'crititor');
    hand(w, 'crititor', attack([], recheckAll(c, 'yes', ['xpe.M1.E1.1'])));
    await w.advance();
    // the closing attacker cites nothing, yet its judgment still requires the rebuttal's run
    const closing = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(closing.fresh, true);
    assert.deepEqual(closing.requiredEvidence, ['xpe.M1.E1.1']);
    hand(w, 'crititor', attack());
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    const last = (await w.ledger.records(['judgment'])).at(-1)?.record;
    assert.deepEqual(w.ledger.content.getList(last?.evidence as never), ['xpe.M1.E1.1']);
    assert.equal((await w.evaluator.labels([c.target as string])).labels[c.target as string], 'proven');
    await w.ledger.append('revoke', { records: [{ kind: 'evidence.revoked', evidence: 'xpe.M1.E1.1' as never }] });
    assert.notEqual((await w.evaluator.labels([c.target as string])).labels[c.target as string], 'proven');
  });

  test('a research answer rests on its method and on the records it cites', async () => {
    const w = await world({ product: 'answer', research: true, question: 'Does it hold?' });
    await w.advance();
    hand(w, 'researcher-author', submit('method', [], { attempts: [{ id: 'A1', kind: 'experiment', purpose: 'measure', steps: ['run'], data: '', measure: ['x'], assertions: ['holds'] }] }));
    await w.advance();
    const method = cardOf<CrititorCard>(w, 'crititor').target as string;
    hand(w, 'crititor', attack());
    await w.advance();
    hand(w, 'constructor-experiment', blind(cardOf(w, 'constructor-experiment')));
    await w.advance();
    const ic = cardOf<InterpreterCard>(w, 'researcher-interpreter');
    assert.deepEqual(ic.newVersion.prerequisites, [method]);
    assert.deepEqual(ic.newVersion.reviews[0]?.reliesOn, [method]);
    hand(w, 'researcher-interpreter', { answer: 'yes', conclusions: [{ id: 'C1', text: 'yes', cites: ['A1'], standing: 'standing', key: true }], message: 'answer', dispositions: [] });
    await w.advance();
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.deepEqual(c.requiredEvidence, ['xpe.M1.E1.1']);
    assert.deepEqual(w.ledger.content.getList(c.binding?.reliesOn as never), [method]);
    hand(w, 'crititor', attack());
    await w.advance();
    hand(w, 'crititor', attack());
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    const target = c.target as string;
    assert.equal((await w.evaluator.labels([target])).labels[target], 'proven');
    const obj = (await w.ledger.records(['object.version'])).find((x) => x.record.object === target)?.record;
    assert.deepEqual(obj?.reviews[0]?.reliesOn, [method]);
    await w.ledger.append('revoke-research-run', { records: [{ kind: 'evidence.revoked', evidence: 'xpe.M1.E1.1' as never }] });
    assert.notEqual((await w.evaluator.labels([target])).labels[target], 'proven', 'revoking the cited run takes the answer\'s proof away');
  });
});

async function engineWorld(rounds: number) {
  const w = await world({ rounds });
  const p = { ledger: w.ledger, scheduler: w.scheduler, evaluator: w.evaluator };
  const pump = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      const ctx = flowCtx(p, M);
      await explorationStep(ctx);
      await secretaryStep(ctx);
      if (!ctx.progressed) break;
    }
  };
  return { w, p, pump };
}

describe('review r1 #7, #8: one Secretary grant per lineage; the user\'s exit stays open', () => {
  test('send-back adds no rounds; a Secretary grant goes through the ledger; a second one goes to the user, whose grant applies', async () => {
    const { w, p, pump } = await engineWorld(1);
    await pump();
    hand(w, 'researcher-author', submit('v1'));
    await pump();
    hand(w, 'crititor', attack([finding('serious', 'class1', 'hole1')]));
    await pump();
    // budget used: send-back is not offered (it would add nothing)
    let t = only(w, 'secretary');
    const options1 = (t.card as unknown as { options: Array<{ id: string }> }).options.map((o) => o.id);
    assert.ok(!options1.includes('send-back'), options1.join(','));
    assert.ok(options1.includes('grant'));
    // the Secretary grants once: recorded by the ledger for the lineage
    assert.deepEqual(w.scheduler.run(t.task, { handBack: secretary(t.card as never, 'grant', { grantExtra: 1 }) }), []);
    await pump();
    assert.equal((await w.ledger.loop('xp.M1.E1', 'env-retry')).secretaryGrantUsed, true);
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(a.budgetRounds, 2);
    hand(w, 'researcher-author', submit('v2', reviseAll(a)));
    await pump();
    hand(w, 'crititor', attack([finding('serious', 'class2', 'hole2')], recheckAll(cardOf<CrititorCard>(w, 'crititor'), 'yes')));
    await pump();
    // a second Secretary grant (a decision made while its card still offered the grant, a race):
    // the ledger refuses it; the escalation stays open and the user's own grant applies (#8)
    t = only(w, 'secretary');
    const esc = (t.card as unknown as { request: { id: string } }).request.id;
    await w.ledger.append('race-decision', {
      events: [
        {
          mission: M,
          line: SECRETARY_LINE,
          event: 'decision',
          key: esc,
          body: { escalation: esc, by: 'secretary', option: 'grant', classification: 'detail', authorization: null, reason: 'one more', instructions: '', grantExtra: 1, notice: '', mayMatter: false },
        },
      ],
    });
    await pump();
    let s = await explorationState(p, M, w.x);
    assert.equal(s.stopped?.reason, 'budget-exhausted');
    assert.equal(s.rulings.filter((r) => r.decision === 'extend').length, 1, 'the refused grant added nothing');
    assert.ok(w.ledger.notices.some((n) => n.category === 'loop-exhausted-needs-user' && n.wi === 'WI-08'));
    await answerEscalation(p, { mission: M, escalation: esc, option: 'grant', grantExtra: 2, words: 'two more rounds' });
    await pump();
    s = await explorationState(p, M, w.x);
    assert.equal(s.stopped, null, 'the user\'s grant was applied (review r1 #8)');
    assert.equal(s.rulings.filter((r) => r.decision === 'extend').length, 2);
    assert.equal(cardOf<AuthorCard>(w, 'researcher-author').budgetRounds, 4);
  });

  test('a send-back with rounds left changes the direction without adding rounds', async () => {
    const { w, p, pump } = await engineWorld(6);
    await pump();
    hand(w, 'researcher-author', submit('v1'));
    await pump();
    hand(w, 'crititor', attack([finding('fatal', 'gets stuck', 'A waits for B')]));
    for (let i = 2; i <= 3; i++) {
      await pump();
      hand(w, 'researcher-author', submit(`v${i}`, reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
      await pump();
      hand(w, 'crititor', attack([], recheckAll(cardOf<CrititorCard>(w, 'crititor'), 'no')));
    }
    await pump();
    assert.equal((await explorationState(p, M, w.x)).stopped?.reason, 'fatal-repeat');
    const t = only(w, 'secretary');
    assert.deepEqual(w.scheduler.run(t.task, { handBack: secretary(t.card as never, 'send-back', { instructions: 'use a lock order' }) }), []);
    await pump();
    const s = await explorationState(p, M, w.x);
    assert.equal(s.stopped, null);
    assert.equal(s.extraRounds, 0, 'sending back adds no rounds');
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(a.budgetRounds, 6);
    assert.equal(a.openFindings[0]?.ruling, 'use a lock order');
    assert.equal((await w.ledger.loop('xp.M1.E1', 'env-retry')).secretaryGrantUsed, false);
  });
});

describe('review r1 #17: exploration ids are per mission', () => {
  test('two missions each define E1 and run it without colliding', async () => {
    const p = fakePorts();
    const def = (mission: string) => explorationDefinition({ exploration: 'E1', mission, product: 'design', goal: 'g', decision: { type: 'structure', text: 'd' }, budget: { rounds: 2 } });
    await defineExploration(p, def('M1'));
    await defineExploration(p, def('M2'));
    const { advanceExploration } = await import('../src/flow/exploration/flow.ts');
    await advanceExploration(p, 'M1' as MissionId, 'E1');
    await advanceExploration(p, 'M2' as MissionId, 'E1');
    const tasks = p.scheduler.queued('researcher-author').map((t) => [t.task, t.lineage]);
    assert.deepEqual(tasks, [
      ['xp.M1.E1.1.author', 'xp.M1.E1'],
      ['xp.M2.E1.1.author', 'xp.M2.E1'],
    ]);
    const lines = (await p.ledger.records(['basis.version'])).map((c) => c.record.line);
    assert.deepEqual(lines, ['xpdef.M1.E1', 'xpdef.M2.E1']);
  });
});

describe('review r1 #19: the blind executor sees no intent', () => {
  test('neither the card nor any document it points to carries the plan, the goal or the findings', async () => {
    const p = fakePorts();
    const planDoc = p.ledger.content.put('PM PLAN: we expect the lock to survive crashes');
    await defineExploration(
      p,
      explorationDefinition({
        exploration: 'E2',
        mission: M,
        product: 'design',
        goal: 'no hole: the lock must survive',
        decision: { type: 'structure', text: 'which lock' },
        budget: { rounds: 4 },
        materials: [{ id: 'pm-plan', title: 'The PM plan', doc: planDoc }],
        decisionQuotes: ['the user expects the lock to survive'],
        constraints: [
          { id: 'K1', text: 'the lock survives', kind: 'object' },
          { id: 'K2', text: 'never use the network', kind: 'instruction' },
        ],
      }),
    );
    const { advanceExploration } = await import('../src/flow/exploration/flow.ts');
    const adv = () => advanceExploration(p, M, 'E2');
    const one = (kind: string) => p.scheduler.queued(kind)[0] as NonNullable<ReturnType<typeof p.scheduler.queued>[0]>;
    await adv();
    assert.deepEqual(p.scheduler.run(one('researcher-author').task, { handBack: submit('the lock survives crashes') }), []);
    await adv();
    assert.deepEqual(p.scheduler.run(one('crititor').task, { handBack: attack([finding('serious', 'gets stuck', 'the lock may not survive')]) }), []);
    await adv();
    p.scheduler.run(one('researcher-author').task, { evidence: REQUEST, sessionId: 's' });
    await adv();
    const ex = one('constructor-experiment').card as unknown as ExperimentCard;
    // dereference everything the card points to: no document of the exploration is reachable
    const reachable = [JSON.stringify(ex), ...ex.materials.map((m) => p.ledger.content.get(m.ref))].join('\n');
    assert.equal(ex.materials.length, 0);
    assert.deepEqual(ex.decisionQuotes, []);
    assert.deepEqual(ex.constraints.map((k) => k.id), ['K2']);
    for (const leak of ['PM PLAN', 'expect', 'survive', 'lock']) assert.ok(!reachable.includes(leak), `the blind card reaches "${leak}"`);
  });
});

describe('review r1 #20: no evidence without an execution behind it', () => {
  test('an experiment hand-back that cites no run, or a run that never happened, is refused or recorded as unverified and cannot rebut', async () => {
    const w = await world();
    await w.advance();
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    hand(w, 'crititor', attack([finding('serious', 'silently leaves an error behind', 'x')]));
    await w.advance();
    w.scheduler.run(only(w, 'researcher-author').task, { evidence: REQUEST, sessionId: 's' });
    await w.advance();
    const t = only(w, 'constructor-experiment');
    const ex = t.card as unknown as ExperimentCard;
    // the reviewer's repro: "stdout" / "yes" with nothing behind it is refused at hand-back
    const fabricated = { steps: [{ step: 1, done: 'yes' as const, note: '' }], measurements: [{ measure: 'status', value: 'ok', source: 'stdout' }], assertions: [{ assertion: 1, holds: 'yes' as const, basis: 'yes' }], observations: '' };
    const refused = w.scheduler.run(t.task, { handBack: fabricated });
    assert.ok(refused.some((x) => x.includes('cite the record it rests on')), refused.join('; '));
    // citing a run that never happened (no run records): accepted, but recorded as unverified
    assert.deepEqual(w.scheduler.run(t.task, { handBack: blind(ex) }), []);
    await w.advance();
    const ev = (await w.ledger.records(['evidence'])).map((c) => c.record);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]?.fields['status'], 'unverified');
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(a.evidence[0]?.status, 'unverified');
    const rebut = w.scheduler.run(only(w, 'researcher-author').task, { handBack: submit('', [{ finding: a.openFindings[0]?.id as string, action: 'rebut', note: 'see the run', evidence: 'xpe.M1.E1.1' }]) });
    assert.ok(rebut.some((x) => x.includes('names a completed evidence execution')), rebut.join('; '));
  });

  test('with the launch\'s completed run records the same hand-back is completed evidence; a run over its peak does not count', async () => {
    const w = await world();
    await w.advance();
    w.scheduler.run(only(w, 'researcher-author').task, { evidence: REQUEST, sessionId: 's' });
    await w.advance();
    const t = only(w, 'constructor-experiment');
    assert.deepEqual(w.scheduler.run(t.task, { handBack: blind(t.card as unknown as ExperimentCard) }), []);
    withRuns(w, t.task, ['resource-exceeded']);
    await w.advance();
    const ev = (await w.ledger.records(['evidence'])).map((c) => c.record);
    assert.equal(ev[0]?.fields['status'], 'unverified', 'run:1 went over its declared peak: its output is not evidence (6.2)');
    assert.match(ev[0]?.fields['run:1'] ?? '', /resource-exceeded/);
  });
});

describe('review r1 #2: a settled conclusion that loses its proof', () => {
  test('settledArtifactProven follows the evaluator, and the PM is told when the product is no longer proven', async () => {
    const { settledArtifactProven } = await import('../src/flow/exploration/step.ts');
    const { w, p, pump } = await engineWorld(6);
    await pump();
    w.scheduler.run(only(w, 'researcher-author').task, { evidence: REQUEST, sessionId: 's' });
    await pump();
    hand(w, 'constructor-experiment', blind(cardOf(w, 'constructor-experiment')));
    await pump();
    hand(w, 'researcher-author', submit('v1'));
    await pump();
    hand(w, 'crititor', attack([finding('serious', 'gets stuck', 'x')]));
    await pump();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    hand(w, 'researcher-author', submit('', [{ finding: a.openFindings[0]?.id as string, action: 'rebut', note: 'the run', evidence: 'xpe.M1.E1.1' }]));
    await pump();
    hand(w, 'crititor', attack([], recheckAll(cardOf<CrititorCard>(w, 'crititor'), 'yes', ['xpe.M1.E1.1'])));
    await pump();
    hand(w, 'crititor', attack());
    await pump();
    // converged: the step settled it for the decision layer
    const settled = await w.ledger.events({ mission: M, line: 'exploration:E1', event: 'settled' });
    assert.equal(settled.length, 1);
    assert.equal((await settledArtifactProven(p, M, 'E1')).proven, true);
    await w.ledger.append('revoke', { records: [{ kind: 'evidence.revoked', evidence: 'xpe.M1.E1.1' as never }] });
    assert.equal((await settledArtifactProven(p, M, 'E1')).proven, false);
    await pump();
    assert.ok(w.ledger.notices.some((n) => n.category === 'exploration-conclusion-unproven'));
  });
});
