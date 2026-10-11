// Regression tests for the code review r1 of package A3, exploration findings (gpt-6.1-sol; repros
// in engine/scratch/review41-repro.ts):
//   #1 every attack round is stabilized (pass rounds, rounds without findings, the closing round);
//      convergence, no progress and the repeated fatal class are decided after stabilization
//   #2 a direction question (an author's question, an escalated finding of any severity, a
//      Stabilizer direction finding, a drift) is pending until its recorded ruling, and gates
//      convergence, acceptance and the research method's pass

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import { explorationState, recordExplorationRuling } from '../src/flow/exploration/flow.ts';
import { M, attack, cardOf, finding, hand, only, stabilizeAll, submit, world, type World } from './flow-exploration-fixtures.ts';

async function stabilize(w: World, judged: (c: StabilizerCard) => ReturnType<typeof stabilizeAll> = (c) => stabilizeAll(c)): Promise<StabilizerCard> {
  await w.advance();
  const t = only(w, 'stabilizer');
  const c = t.card as unknown as StabilizerCard;
  assert.deepEqual(await w.scheduler.run(t.task, { handBack: judged(c) }), []);
  await w.advance();
  return c;
}

describe('review r1 #1: every attack round is stabilized', () => {
  test('the reviewer\'s repro: a pass round and the closing round each wait for their Stabilizer before converging', async () => {
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('general', 'direction', 'Does this answer the original question?')]));
    await w.advance();
    assert.equal(w.scheduler.queued('crititor').length, 0, 'no closing attacker before the round is stabilized');
    let s = await explorationState(w, M, w.x);
    assert.equal(s.turn, 'stabilizer');
    assert.equal((await w.evaluator.labels([s.version!.id])).labels[s.version!.id] === 'proven', false, 'the attacker\'s pass is pending, never proven by itself');
    const c1 = await stabilize(w);
    assert.equal(c1.findings.length, 1, 'the general finding is judged too');
    assert.equal(cardOf<CrititorCard>(w, 'crititor').fresh, true, 'now the closing attacker');
    await hand(w, 'crititor', attack());
    s = await explorationState(w, M, w.x);
    await w.advance();
    s = await explorationState(w, M, w.x);
    assert.equal(s.stopped, null, 'the reviewer\'s repro converged here with no stabilization');
    const c2 = await stabilize(w);
    assert.deepEqual(c2.findings, [], 'a round without findings is stabilized: its drift is judged');
    s = await explorationState(w, M, w.x);
    assert.equal(s.stopped?.reason, 'converged');
    assert.equal(s.stabilizations.length, 2);
    assert.equal((await w.evaluator.labels([s.version!.id])).labels[s.version!.id], 'proven');
  });

  test('a drifting closing round does not converge: it waits for the ruling', async () => {
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack());
    await stabilize(w);
    await hand(w, 'crititor', attack());
    await stabilize(w, (c) => stabilizeAll(c, 'in-scope', { drifting: true }));
    const s = await explorationState(w, M, w.x);
    assert.equal(s.stopped, null);
    assert.equal(s.turn, 'await-ruling');
    assert.notEqual(s.drift, null);
  });

  test('a Stabilizer that raises a general finding of a pass round to serious in scope: the author answers it; the round did not pass', async () => {
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('general', 'gets stuck', 'a wait without timeout')]));
    await stabilize(w, (c) => stabilizeAll(c, 'in-scope', { severity: 'serious' }));
    const s = await explorationState(w, M, w.x);
    assert.equal(s.turn, 'author');
    assert.equal(s.needClosing, false);
    assert.equal(cardOf<AuthorCard>(w, 'researcher-author').openFindings.length, 1);
    assert.equal((await w.evaluator.labels([s.version!.id])).labels[s.version!.id], 'negated', 'the Stabilizer\'s judgment refutes it');
  });
});

describe('review r1 #2: a pending direction question gates convergence and acceptance', () => {
  test('the reviewer\'s repro: an author\'s question keeps the exploration from converging until its ruling', async () => {
    const w = await world();
    await w.advance();
    const author = only(w, 'researcher-author');
    await hand(w, 'researcher-author', submit('v1', [], { directionQuestions: ['Should we change the mission goal?'] }));
    await w.advance();
    await hand(w, 'crititor', attack());
    await w.advance();
    let s = await explorationState(w, M, w.x);
    assert.equal(s.stopped, null);
    assert.equal(s.turn, 'await-ruling');
    assert.equal(w.scheduler.queued('crititor').length, 0);
    assert.equal((await w.evaluator.labels([s.version!.id])).labels[s.version!.id] === 'proven', false);
    // only the recorded ruling clears it
    await recordExplorationRuling(w, M, w.x, { id: 'A1', decision: 'answer', findings: [], answers: author.task, text: 'No.', extraRounds: 0, by: 'secretary' });
    await w.advance();
    s = await explorationState(w, M, w.x);
    assert.deepEqual(s.pendingQuestions, []);
    assert.equal(cardOf<CrititorCard>(w, 'crititor').fresh, true);
    await hand(w, 'crititor', attack());
    s = await explorationState(w, M, w.x);
    await w.advance();
    s = await explorationState(w, M, w.x);
    assert.equal(s.stopped?.reason, 'converged');
  });

  test('an escalated general finding is pending too, even when the Stabilizer judges it out of scope', async () => {
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'internal contradiction', 'two rules'), finding('general', 'wording', 'naming')]));
    await w.advance();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    const general = a.openFindings.find((f) => f.severity === 'general')!.id;
    const serious = a.openFindings.find((f) => f.severity === 'serious')!.id;
    await hand(w, 'researcher-author', submit('v2', [
      { finding: serious, action: 'revise', note: 'one rule' },
      { finding: general, action: 'escalate', note: 'the user named it', question: 'May we rename it?' },
    ]));
    await stabilize(w, (c) => ({ ...stabilizeAll(c), findings: c.findings.map((f) => ({ finding: f.id, verdict: f.id === general ? ('out-of-scope' as const) : ('in-scope' as const), severity: f.severity, reason: 'judged', question: '' })) }));
    let s = await explorationState(w, M, w.x);
    assert.equal(s.findings.get(general)?.status, 'awaiting-ruling', 'only the ruling clears an escalation');
    // the rounds go on meanwhile (it gates nothing else): the re-check passes, but the round waits
    await hand(w, 'crititor', attack([], [{ finding: serious, resolved: 'yes', reason: 'fixed', evidence: [] }]));
    await stabilize(w);
    s = await explorationState(w, M, w.x);
    assert.equal(s.turn, 'await-ruling');
    assert.equal(s.stopped, null);
    await recordExplorationRuling(w, M, w.x, { id: 'K1', decision: 'keep-direction', findings: [general], text: 'keep the name', extraRounds: 0, by: 'secretary' });
    await w.advance();
    s = await explorationState(w, M, w.x);
    assert.equal(s.findings.get(general)?.status, 'resolved');
    assert.equal(s.turn, 'attacker');
  });

  test('a research method does not pass while a direction question waits', async () => {
    const w = await world({ product: 'answer', research: true, question: 'Does it hold?' });
    await w.advance();
    const author = only(w, 'researcher-author');
    await hand(w, 'researcher-author', submit('method', [], { attempts: [{ id: 'A1', kind: 'experiment', purpose: 'measure', steps: ['run'], data: '', measure: ['x'], assertions: ['holds'] }], directionQuestions: ['Is the question still the same?'] }));
    await w.advance();
    await hand(w, 'crititor', attack());
    await w.advance();
    let s = await explorationState(w, M, w.x);
    assert.equal(s.phase, 'method', 'the method waits for the ruling');
    assert.equal(s.turn, 'await-ruling');
    assert.equal(w.scheduler.queued('constructor-experiment').length, 0);
    await recordExplorationRuling(w, M, w.x, { id: 'A1', decision: 'answer', findings: [], answers: author.task, text: 'Yes.', extraRounds: 0, by: 'secretary' });
    await w.advance();
    await hand(w, 'crititor', attack());
    await w.advance();
    s = await explorationState(w, M, w.x);
    assert.equal(s.phase, 'attempts');
    assert.equal(w.scheduler.queued('constructor-experiment').length, 1);
  });
});

describe('review r1 #3: an experiment\'s evidence is bound to the environment of its runs', () => {
  test('the reviewer\'s repro: an environment change takes the proof away; the evidence runs again and the same position judges again', async () => {
    const { currentEnvironment, forgetObservedEnvironment, ENV_LINE } = await import('../src/evaluator/index.ts');
    const { flowCtx } = await import('../src/flow/context.ts');
    const { explorationStep } = await import('../src/flow/exploration/step.ts');
    const { blind, recheckAll } = await import('./flow-exploration-fixtures.ts');
    const w = await world();
    const ports = { ledger: w.ledger, scheduler: w.scheduler, evaluator: w.evaluator };
    const pump = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) {
        const ctx = flowCtx(ports, M);
        await explorationStep(ctx);
        if (!ctx.progressed) break;
      }
    };
    const REQUEST = { steps: ['run probe'], data: '', measure: ['value'], assertions: ['has a record'] };
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'missing record', 'Lost run')]));
    await w.advance();
    await w.scheduler.run(only(w, 'researcher-author').task, { evidence: REQUEST, notes: 'notes' });
    await w.advance();
    await hand(w, 'constructor-experiment', blind(cardOf(w, 'constructor-experiment')));
    await w.advance();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    await hand(w, 'researcher-author', submit('', [{ finding: a.openFindings[0]!.id, action: 'rebut', note: 'the experiment', evidence: 'xpe.M1.E1.1' }]));
    await w.advance();
    await hand(w, 'crititor', attack([], recheckAll(cardOf<CrititorCard>(w, 'crititor'), 'yes', ['xpe.M1.E1.1'])));
    await w.advance();
    await hand(w, 'crititor', attack());
    await pump();
    let s = await explorationState(w, M, w.x);
    assert.equal(s.stopped?.reason, 'converged');
    const v = s.version!.id;
    assert.equal((await w.evaluator.labels([v])).labels[v], 'proven');
    const before = w.ports.ctx.environment().identity;
    const ev1 = (await w.ledger.records(['evidence'])).map((c) => c.record).find((r) => r.evidence === 'xpe.M1.E1.1')!;
    assert.equal(ev1.envLine, ENV_LINE, 'bound to the environment identity of the runs it cites, not to a frozen exploration line');
    assert.equal(ev1.envSnapshot, before);

    // the machine changes (the reviewer's repro: another OS and architecture)
    forgetObservedEnvironment(w.memory.projectDir);
    currentEnvironment(w.memory, { observe: () => ({ os: 'changed', osVersion: '2', arch: 'arm64', versions: {} }) });
    assert.notEqual((await w.evaluator.labels([v])).labels[v], 'proven', 'the observation needs a rerun: not proven any more');

    // the way back: the same evidence execution runs again, blind, under the current identity
    await pump();
    s = await explorationState(w, M, w.x);
    assert.equal(s.stopped, null, 'reopened for the re-judgment');
    const ex = only(w, 'constructor-experiment');
    const card = ex.card as unknown as { steps: string[]; evidence: { id: string } };
    assert.deepEqual(card.steps, REQUEST.steps, 'the same request');
    assert.equal(card.evidence.id, 'xpe.M1.E1.2');
    await hand(w, 'constructor-experiment', blind(cardOf(w, 'constructor-experiment')));
    await pump();
    const ev2 = (await w.ledger.records(['evidence'])).map((c) => c.record).find((r) => r.evidence === 'xpe.M1.E1.2')!;
    assert.equal(ev2.envSnapshot, w.ports.ctx.environment().identity);
    assert.notEqual(ev2.envSnapshot, before);
    // then the same position judges again: the attacker re-checks the rebuttal on its new record
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c.target, v, 'the same version');
    const due = c.priorFindings.filter((f) => f.status === 'awaiting-recheck');
    assert.equal(due.length, 1);
    assert.equal(due[0]?.disposition?.evidence, 'xpe.M1.E1.2');
    await hand(w, 'crititor', attack([], recheckAll(c, 'yes', ['xpe.M1.E1.2'])));
    await pump();
    s = await explorationState(w, M, w.x);
    assert.equal(s.stopped?.reason, 'converged');
    assert.equal((await w.evaluator.labels([v])).labels[v], 'proven', 'proof restored, not a stuck path');
  });

  test('a reading stays environment-free', async () => {
    const { blind } = await import('./flow-exploration-fixtures.ts');
    const w = await world({ evidenceExecutor: 'reading', readingNetwork: ['https://docs.example.org/'] });
    await w.advance();
    await w.scheduler.run(only(w, 'researcher-author').task, { evidence: { steps: ['read the page'], data: '', measure: ['limit'], assertions: [] }, notes: 'n' });
    await w.advance();
    await hand(w, 'researcher-reader', blind(cardOf(w, 'researcher-reader')));
    await w.advance();
    const s = await explorationState(w, M, w.x);
    const ev = (await w.ledger.records(['evidence'])).map((c) => c.record).find((r) => r.evidence === 'xpe.M1.E1.1')!;
    assert.equal(ev.envLine, s.defined!.envLine);
  });
});

// ---------------------------------------------------------------- code review r2 (round 2 of package A3)

/** Every flow step of the mission (the Secretary's decisions included), as `mp pm next` advances them. */
async function pumpStep(w: World): Promise<void> {
  const { advance } = await import('../src/process/advance.ts');
  await advance(w.ports.ctx, M);
}

/** The Secretary task of the escalation whose summary matches. */
function secretaryFor(w: World, match: RegExp) {
  const t = w.scheduler.queued('secretary').find((x) => match.test((x.card as unknown as { request: { summary: string } }).request.summary));
  assert.ok(t, `a Secretary task for ${match}: ${w.scheduler.queued('secretary').map((x) => (x.card as unknown as { request: { summary: string } }).request.summary).join(' | ')}`);
  return t;
}

describe('review r2 #1: only the drift\'s own ruling clears the drift', () => {
  test('the reviewer\'s repro: a ruling on a direction finding of the same round leaves the drift pending; its escalation stays the same', async () => {
    const { secretary } = await import('../src/flow/scripted.ts');
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('general', 'direction', 'change the question')]));
    await stabilize(w, (c) => stabilizeAll(c, 'shifts-direction', { drifting: true }));
    await pumpStep(w);
    let s = await explorationState(w, M, w.x);
    assert.notEqual(s.drift, null);
    const driftTask = secretaryFor(w, /drifting/);
    const findingTask = secretaryFor(w, /change the question/);
    assert.deepEqual(await w.scheduler.run(findingTask.task, { handBack: secretary(findingTask.card as never, 'answer', { instructions: 'Not a change of direction.' }) }), []);
    await pumpStep(w);
    s = await explorationState(w, M, w.x);
    assert.notEqual(s.drift, null, 'the finding\'s ruling did not rule on the drift');
    assert.ok(s.rulings.some((r) => r.decision === 'keep-direction' && r.drift !== true));
    assert.equal(secretaryFor(w, /drifting/).task, driftTask.task, 'the drift escalation keeps its id: its pending decision still matches');
    // the round would pass: it waits for the drift's ruling (the reviewer's repro converged to proven here)
    s = await explorationState(w, M, w.x);
    assert.equal(s.turn, 'await-ruling');
    assert.equal(s.stopped, null);
    assert.notEqual((await w.evaluator.labels([s.version!.id])).labels[s.version!.id], 'proven');
    // the drift's own ruling clears it
    assert.deepEqual(await w.scheduler.run(driftTask.task, { handBack: secretary(driftTask.card as never, 'answer', { instructions: 'Keep the definition.' }) }), []);
    await pumpStep(w);
    s = await explorationState(w, M, w.x);
    assert.equal(s.drift, null);
    assert.ok(s.rulings.some((r) => r.drift === true));
  });
});

describe('review r2 #4: a round passes only on a recorded pass', () => {
  test('method phase: the question is ruled before the queued Stabilizer is dispatched; its "undecided" queues one new Stabilizer for the same round, whose pass lets the method pass', async () => {
    const { secretary } = await import('../src/flow/scripted.ts');
    const w = await world({ product: 'answer', research: true, question: 'Does it hold?' });
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('method', [], { attempts: [{ id: 'A1', kind: 'experiment', purpose: 'measure', steps: ['run'], data: '', measure: ['x'], assertions: ['holds'] }], directionQuestions: ['Is this the required question?'] }));
    await w.advance();
    await hand(w, 'crititor', attack());
    await pumpStep(w);
    const st = only(w, 'stabilizer');
    assert.equal(((st.card as unknown as StabilizerCard).pendingDirection ?? []).length, 1, 'queued while the question was pending');
    const sec = only(w, 'secretary');
    assert.deepEqual(await w.scheduler.run(sec.task, { handBack: secretary(sec.card as never, 'answer', { instructions: 'Yes.' }) }), []);
    await pumpStep(w);
    let s = await explorationState(w, M, w.x);
    assert.deepEqual(s.pendingQuestions, []);
    const rounds = s.rounds;
    // the Stabilizer judges from its card: undecided
    assert.deepEqual(await w.scheduler.run(st.task, { handBack: stabilizeAll(st.card as unknown as StabilizerCard) }), []);
    await w.advance();
    s = await explorationState(w, M, w.x);
    assert.equal(s.phase, 'method', 'not passed on an undecided judgment (the reviewer\'s repro went to attempts)');
    assert.equal(s.method, null);
    assert.equal(s.rounds, rounds, 'not a new round');
    const again = only(w, 'stabilizer');
    assert.notEqual(again.task, st.task);
    const c2 = again.card as unknown as StabilizerCard;
    assert.equal(c2.round, (st.card as unknown as StabilizerCard).round, 'the same round');
    assert.deepEqual(c2.pendingDirection ?? [], [], 'a current card');
    assert.deepEqual(await w.scheduler.run(again.task, { handBack: stabilizeAll(c2) }), []);
    await w.advance();
    s = await explorationState(w, M, w.x);
    assert.equal(s.phase, 'attempts');
    assert.equal((await w.evaluator.labels([s.method!.version])).labels[s.method!.version], 'proven', 'the method passed on a recorded pass');
  });

  test('closing round: an escalation ruled before the queued Stabilizer is dispatched; the new Stabilizer\'s pass converges', async () => {
    const { secretary } = await import('../src/flow/scripted.ts');
    const { recheckAll } = await import('./flow-exploration-fixtures.ts');
    const w = await world();
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack());
    await stabilize(w);
    // the closing attacker finds something; it continues as the attacker (8.2)
    assert.equal(cardOf<CrititorCard>(w, 'crititor').fresh, true);
    await hand(w, 'crititor', attack([finding('serious', 'gets stuck', 'a wait without timeout'), finding('general', 'naming', 'the user named it')]));
    await w.advance();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    const serious = a.openFindings.find((f) => f.severity === 'serious')!.id;
    const general = a.openFindings.find((f) => f.severity === 'general')!.id;
    await hand(w, 'researcher-author', submit('v2', [
      { finding: serious, action: 'revise', note: 'a timeout' },
      { finding: general, action: 'escalate', note: 'the user named it', question: 'May we rename it?' },
    ]));
    await stabilize(w);
    // the closing session re-checks: the round would pass, but the escalation is pending when its Stabilizer is queued
    await hand(w, 'crititor', attack([], recheckAll(cardOf<CrititorCard>(w, 'crititor'), 'yes')));
    await pumpStep(w);
    const st = only(w, 'stabilizer');
    assert.ok(((st.card as unknown as StabilizerCard).pendingDirection ?? []).length === 1);
    const sec = secretaryFor(w, /escalated/);
    assert.deepEqual(await w.scheduler.run(sec.task, { handBack: secretary(sec.card as never, 'accept-risk') }), []);
    await pumpStep(w);
    assert.deepEqual(await w.scheduler.run(st.task, { handBack: stabilizeAll(st.card as unknown as StabilizerCard) }), []);
    await w.advance();
    let s = await explorationState(w, M, w.x);
    assert.equal(s.stopped, null, 'not converged on an undecided judgment');
    const again = only(w, 'stabilizer');
    assert.deepEqual((again.card as unknown as StabilizerCard).pendingDirection ?? [], []);
    assert.deepEqual(await w.scheduler.run(again.task, { handBack: stabilizeAll(again.card as unknown as StabilizerCard) }), []);
    await w.advance();
    s = await explorationState(w, M, w.x);
    assert.equal(s.stopped?.reason, 'converged');
    assert.equal((await w.evaluator.labels([s.version!.id])).labels[s.version!.id], 'proven');
  });
});

describe('review r2 #5: one evidence resolver', () => {
  test('a research exploration proven → the environment identity changes → its attempt runs again → the attacker re-checks → proven again', async () => {
    const { currentEnvironment, forgetObservedEnvironment } = await import('../src/evaluator/index.ts');
    const { blind } = await import('./flow-exploration-fixtures.ts');
    const w = await world({ product: 'answer', research: true, question: 'Does it hold?' });
    await w.advance();
    await hand(w, 'researcher-author', submit('method', [], { attempts: [{ id: 'A1', kind: 'experiment', purpose: 'measure', steps: ['run'], data: '', measure: ['x'], assertions: ['holds'] }] }));
    await w.advance();
    await hand(w, 'crititor', attack());
    await w.advance();
    await hand(w, 'constructor-experiment', blind(cardOf(w, 'constructor-experiment')));
    await w.advance();
    await hand(w, 'researcher-interpreter', { answer: 'holds', conclusions: [{ id: 'C1', text: 'holds', cites: ['A1', 'xpe.M1.E1.1'], standing: 'standing', key: true }], message: 'measured', dispositions: [] });
    await w.advance();
    await hand(w, 'crititor', attack());
    await w.advance();
    await hand(w, 'crititor', attack());
    await pumpStep(w);
    let s = await explorationState(w, M, w.x);
    assert.equal(s.stopped?.reason, 'converged');
    const v = s.version!.id;
    assert.equal((await w.evaluator.labels([v])).labels[v], 'proven');

    forgetObservedEnvironment(w.memory.projectDir);
    currentEnvironment(w.memory, { observe: () => ({ os: 'changed', osVersion: '2', arch: 'arm64', versions: {} }) });
    assert.notEqual((await w.evaluator.labels([v])).labels[v], 'proven');
    await pumpStep(w);
    const rerun = cardOf<{ evidence: { id: string; attempt: string | null } }>(w, 'constructor-experiment');
    assert.deepEqual([rerun.evidence.id, rerun.evidence.attempt], ['xpe.M1.E1.2', 'A1'], 'the registered attempt runs again');
    await hand(w, 'constructor-experiment', blind(cardOf(w, 'constructor-experiment')));
    await pumpStep(w);
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.deepEqual(c.requiredEvidence, ['xpe.M1.E1.2'], 'the attempt and the cited id both resolve to the latest record (the reviewer saw E1 and E2)');
    await hand(w, 'crititor', attack());
    await pumpStep(w);
    s = await explorationState(w, M, w.x);
    assert.equal(s.stopped?.reason, 'converged');
    assert.equal(s.version!.id, v);
    assert.equal((await w.evaluator.labels([v])).labels[v], 'proven', 'proven again');
  });
});

// ---------------------------------------------------------------- final review F1: a goal redefinition and the closing round

describe('final review F1: a round is pinned to the definition version its attacker card was built under', () => {
  async function toClosing(w: World) {
    await w.advance();
    await hand(w, 'researcher-author', submit('a design that only addresses the original goal'));
    await w.advance();
    await hand(w, 'crititor', attack());
    await w.advance();
    const closing = only(w, 'crititor');
    assert.equal((closing.card as unknown as CrititorCard).fresh, true);
    return closing;
  }
  async function redefine(w: World): Promise<void> {
    const { redefineExploration } = await import('../src/flow/exploration/flow.ts');
    const original = (await explorationState(w, M, w.x)).def!;
    assert.equal(await redefineExploration(w, { ...original, goal: 'also satisfy the NEW goal' }), true);
  }
  /** After the stale closing round: a fresh attacker under the new goal, then its Stabilizer: only then converged and proven. */
  async function finishUnderNewGoal(w: World, target: string): Promise<void> {
    let s = await explorationState(w, M, w.x);
    assert.equal(s.stopped, null, 'a round of the old definition never converges');
    assert.notEqual((await w.evaluator.labels([target])).labels[target], 'proven');
    const fresh = only(w, 'crititor');
    const c = fresh.card as unknown as CrititorCard;
    assert.equal(c.fresh, true, 'the closing round again: a fresh attacker');
    assert.equal(c.goal, 'also satisfy the NEW goal', 'under the current definition');
    await hand(w, 'crititor', attack());
    await w.advance();
    s = await explorationState(w, M, w.x);
    if (s.stopped === null) {
      const st = only(w, 'stabilizer');
      assert.deepEqual(w.ledger.content.getList((st.card as unknown as StabilizerCard).binding.bases as never), ['xpdef.M1.E1.v2']);
      assert.deepEqual(await w.scheduler.run(st.task, { handBack: stabilizeAll(st.card as unknown as StabilizerCard) }), []);
      await w.advance();
      s = await explorationState(w, M, w.x);
    }
    assert.equal(s.stopped?.reason, 'converged');
    assert.equal((await w.evaluator.labels([target])).labels[target], 'proven');
  }

  test('the reviewer\'s repro: redefined while the closing attacker is queued; its Stabilizer binds the old version; no convergence until the new attacker and Stabilizer pass', async () => {
    const w = await world({ rounds: 6 });
    const closing = await toClosing(w);
    const target = (closing.card as unknown as CrititorCard).target!;
    await redefine(w);
    w.autoStabilize = false;
    await hand(w, 'crititor', attack());
    await w.advance();
    const st = only(w, 'stabilizer');
    const sc = st.card as unknown as StabilizerCard;
    assert.equal(sc.goal, closing.card['goal'] as string, 'the round is judged under the definition its attacker had');
    assert.deepEqual(w.ledger.content.getList(sc.binding.bases as never), ['xpdef.M1.E1.v1']);
    assert.deepEqual(await w.scheduler.run(st.task, { handBack: stabilizeAll(sc) }), []);
    await w.advance();
    await finishUnderNewGoal(w, target);
  });

  test('redefined while the closing attacker is in flight', async () => {
    const w = await world({ rounds: 6 });
    const closing = await toClosing(w);
    const target = (closing.card as unknown as CrititorCard).target!;
    w.scheduler.dispatchOf(closing.task);
    await redefine(w);
    w.autoStabilize = false;
    assert.deepEqual(await w.scheduler.run(closing.task, { handBack: attack() }), [], 'the dispatch in flight hands back its old card\'s result');
    await w.advance();
    const st = only(w, 'stabilizer');
    assert.deepEqual(await w.scheduler.run(st.task, { handBack: stabilizeAll(st.card as unknown as StabilizerCard) }), []);
    await w.advance();
    await finishUnderNewGoal(w, target);
  });

  test('redefined while the closing round\'s Stabilizer is queued', async () => {
    const w = await world({ rounds: 6 });
    const closing = await toClosing(w);
    const target = (closing.card as unknown as CrititorCard).target!;
    w.autoStabilize = false;
    await hand(w, 'crititor', attack());
    await w.advance();
    const st = only(w, 'stabilizer');
    await redefine(w);
    assert.deepEqual(await w.scheduler.run(st.task, { handBack: stabilizeAll(st.card as unknown as StabilizerCard) }), []);
    await w.advance();
    await finishUnderNewGoal(w, target);
  });

  test('no round left after the stale closing round: the budget stop goes to the Secretary (WI-08)', async () => {
    const w = await world({ rounds: 2 });
    await toClosing(w);
    await redefine(w);
    w.autoStabilize = false;
    await hand(w, 'crititor', attack());
    await w.advance();
    const st = only(w, 'stabilizer');
    assert.deepEqual(await w.scheduler.run(st.task, { handBack: stabilizeAll(st.card as unknown as StabilizerCard) }), []);
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'budget-exhausted');
    assert.equal(r.stopped?.wi, 'WI-08');
  });
});

describe('final review 2h: the PM plan names the addresses a reading may cite', () => {
  test('readingNetwork goes from the plan\'s exploration to the Reader card; a page inside it is accepted (a citation scope: mp fetches nothing)', async () => {
    const { definitionFromPlan } = await import('../src/flow/exploration/step.ts');
    const { ExplorationDefinition } = await import('../src/flow/plandoc.ts');
    const url = 'https://docs.example.org/reference';
    const base = { id: 'E1', deliverable: 'Read the vendor reference', fuzzyGoal: { quote: 'an answer supported by the reference', words: 'W-1' }, attackScope: ['unsupported conclusion'], decision: { id: 'D1', type: 'structure' as const }, stop: '', research: false };
    assert.deepEqual(definitionFromPlan(M, 'pmplan.M1.1', ExplorationDefinition.parse(base), 'x').readingNetwork, [], 'absent: none');
    const e = ExplorationDefinition.parse({ ...base, readingNetwork: [url] });
    assert.deepEqual(e.readingNetwork, [url], 'the plan schema keeps it');
    const def = definitionFromPlan(M, 'pmplan.M1.1', e, 'Read the vendor reference');
    assert.deepEqual(def.readingNetwork, [url]);
    const w = await world(def);
    await w.advance();
    assert.deepEqual(await w.scheduler.run(only(w, 'researcher-author').task, { evidence: { executor: 'reading', steps: [`Read ${url}`], data: '', measure: ['documented return type'], assertions: [] }, notes: 'read the reference' }), []);
    await w.advance();
    const rd = only(w, 'researcher-reader');
    assert.deepEqual((rd.card as unknown as { network: { allowed: string[] } }).network.allowed, [url]);
    const handBack = (source: string) => ({ steps: [{ step: 1, done: 'yes' as const, note: 'read the page' }], measurements: [{ measure: 'documented return type', value: 'integer', source }], assertions: [], observations: '' });
    assert.ok((await w.scheduler.run(rd.task, { handBack: handBack('url:https://other.example.org/x the passage') })).some((p) => /not an address the card allows/.test(p)), 'the check stays as it is');
    assert.deepEqual(await w.scheduler.run(rd.task, { handBack: handBack(`url:${url} the passage states integer`) }), []);
  });
});
