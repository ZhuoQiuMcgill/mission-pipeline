// A research exploration's registered attempt run again on the same method version (`mp pm
// rerun-attempt`, process/explorationAttempts.ts): its blind run failed for a cause outside the
// method (a time limit since raised), and the PM has it run again, without a round.
//   a  its refusals, named, nothing written: no such exploration, not a research exploration, no
//      method in effect, an attempt the method does not register, an attempt with no record yet, a
//      run of it queued or in flight, an interpreter at work, an interpretation submitted, a
//      stopped exploration, a settled one
//   b  in the attempts phase: a fresh blind run of the registered card; the phase moves on only
//      once its new record is in, and the interpreter reads that record
//   c  from interpret: the interpreter queued on the earlier records is withdrawn, the exploration
//      goes back to its attempts, then on to interpret with the new record; the reasoning attack
//      that follows has the same budget
//   d  two attempts named together are queued in the register's order
//   e  the earlier record is superseded for every reader and kept as history
//   f  the command line: its help, its arguments, a refusal's code

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { buildHandoff, explorationState, recordExplorationRuling } from '../src/flow/exploration/flow.ts';
import { ATTEMPT_RERUN, allowedRounds, attemptEvidence, supersededAttemptRecord, type AttemptRerunBody, type XState } from '../src/flow/exploration/machine.ts';
import { explorationLine } from '../src/flow/plandoc.ts';
import { flowEvents } from '../src/memory/index.ts';
import { advance, pmRerunAttempt, readSteps } from '../src/process/index.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { ExperimentCard } from '../src/seat/cards/experiment.ts';
import type { InterpreterCard, InterpreterResult, ReaderCard, RegisteredAttemptT } from '../src/seat/cards/researcher.ts';
import { cli, gitProject } from './cli-fixtures.ts';
import { say } from './flow-memory-fixtures.ts';
import { M, RUN_PLACEHOLDER, attack, blind, cardOf, hand, only, submit, world, type World } from './flow-exploration-fixtures.ts';

const URL = 'https://docs.example.org/';
const ATTEMPTS: RegisteredAttemptT[] = [
  { id: 'A1', kind: 'experiment', purpose: 'does the lock survive a crash', steps: ['run the crash script 20 times'], data: 'the repository', measure: ['survivals'], assertions: ['all 20 survive'], commands: [{ id: 'step', command: 'sh crash.sh 20' }] },
  { id: 'A2', kind: 'reading', purpose: 'what the kernel documents', steps: ['read the locking documentation'], data: URL, measure: ['guarantee stated'], assertions: [] },
];

/** A research exploration whose method (registering A1 and A2) passed in its first round: both attempts queued. The words entry the PM's command rests on. */
async function attemptsPhase(rounds = 3): Promise<{ w: World; words: string }> {
  const w = await world({ product: 'answer', research: true, question: 'Does the file lock survive a crash?', decision: { type: 'structure', text: 'which lock to use' }, readingNetwork: [URL], rounds });
  await w.advance();
  await hand(w, 'researcher-author', submit('method v1', [], { attempts: ATTEMPTS }));
  await w.advance();
  await hand(w, 'crititor', attack());
  await w.advance();
  const words = say(w, 'The A1 run was killed by the time limit, which is raised now: run it again.');
  return { w, words };
}

const state = (w: World): Promise<XState> => explorationState({ ledger: w.ledger }, M, w.x);

function reruns(w: World): AttemptRerunBody[] {
  return w.memory.read((db) => flowEvents(db, { mission: M, line: explorationLine(w.x), event: ATTEMPT_RERUN })).map((e) => JSON.parse(w.memory.data.text(e.body)) as AttemptRerunBody);
}

/** A1's run killed (its command failed), A2's reading handed back. */
async function bothRecorded(w: World): Promise<void> {
  await hand(w, 'constructor-experiment', blind(cardOf<ExperimentCard>(w, 'constructor-experiment'), 'no'), { runs: ['failed'] });
  await w.advance();
  await hand(w, 'researcher-reader', blind(cardOf<ReaderCard>(w, 'researcher-reader')));
  await w.advance();
}

/** An experiment's dispatch in flight hands back, its claims citing a run of that dispatch. */
async function handInFlight(w: World, task: string, card: ExperimentCard): Promise<void> {
  const run = w.scheduler.rerun(w.scheduler.dispatchOf(task), 'step', true);
  const fields = JSON.parse(JSON.stringify(blind(card)).split(RUN_PLACEHOLDER).join(`run:${run}`));
  assert.deepEqual(await w.scheduler.run(task, { handBack: fields }), []);
}

function interpretation(card: InterpreterCard): InterpreterResult {
  return {
    answer: 'the lock survives crashes',
    conclusions: [
      { id: 'C1', text: 'survives in practice', cites: ['A1'], standing: 'standing', key: true },
      { id: 'C2', text: 'documented', cites: [card.attempts.find((a) => a.id === 'A2')?.evidence ?? 'A2'], standing: 'standing', key: false },
    ],
    message: 'first interpretation',
    dispositions: [],
  };
}

describe('mp pm rerun-attempt', () => {
  test('a: refusals, each named, nothing written', async () => {
    const { w, words } = await attemptsPhase();
    const ctx = w.ports.ctx;
    const refused = async (attempts: string[], code: string, o: { x?: string; match?: RegExp } = {}): Promise<void> => {
      const before = reruns(w).length;
      await assert.rejects(pmRerunAttempt(ctx, { mission: M, exploration: o.x ?? w.x, attempts, words }), (e: { code?: string; message?: string }) => e.code === code && (o.match === undefined || o.match.test(e.message ?? '')), `${attempts.join(',')}: ${code}`);
      assert.equal(reruns(w).length, before, 'nothing written');
    };
    await refused(['A1'], 'NOT_ALLOWED', { x: 'nope' });
    // no record yet: both runs are queued
    await refused(['A1'], 'ATTEMPT_NO_EVIDENCE', { match: /no record yet .*queued/ });
    await hand(w, 'constructor-experiment', blind(cardOf<ExperimentCard>(w, 'constructor-experiment'), 'no'), { runs: ['failed'] });
    await w.advance();
    // A2 still queued (held: nobody dispatched it), A1 has its record
    await refused(['A1', 'A2'], 'ATTEMPT_NO_EVIDENCE', { match: /attempt A2/ });
    await refused(['A9'], 'ATTEMPT_NOT_REGISTERED', { match: /registers A1, A2; not A9/ });
    // a run of A1 queued since, then in flight: its record is the one that counts
    await pmRerunAttempt(ctx, { mission: M, exploration: w.x, attempts: ['A1'], words });
    await refused(['A1'], 'ATTEMPT_QUEUED', { match: /queued/ });
    const run = only(w, 'constructor-experiment');
    w.scheduler.dispatchOf(run.task);
    await refused(['A1'], 'ATTEMPT_QUEUED', { match: /in flight/ });
    await handInFlight(w, run.task, run.card as unknown as ExperimentCard);
    await w.advance();
    await hand(w, 'researcher-reader', blind(cardOf<ReaderCard>(w, 'researcher-reader')));
    await w.advance();
    // the interpreter at work, then handed back (not taken into account yet), then its interpretation in: submitted
    const it = only(w, 'researcher-interpreter');
    w.scheduler.dispatchOf(it.task);
    await refused(['A2'], 'DISPATCH_IN_FLIGHT', { match: /release/ });
    assert.deepEqual(await w.scheduler.run(it.task, { handBack: interpretation(it.card as unknown as InterpreterCard) }), []);
    await refused(['A2'], 'INTERPRETATION_SUBMITTED');
    await w.advance();
    assert.equal((await state(w)).phase, 'reasoning');
    await refused(['A2'], 'INTERPRETATION_SUBMITTED');
    // settled: the decision layer stopped it
    await recordExplorationRuling({ ledger: w.ledger, scheduler: w.scheduler }, M, w.x, { id: 'stop-it', decision: 'stop', findings: [], text: 'the PM stops it', extraRounds: 0, by: 'pm' });
    await advance(ctx, M);
    assert.notEqual((await state(w)).settled, null);
    await refused(['A2'], 'EXPLORATION_SETTLED', { match: /reopen-exploration/ });
    assert.equal(reruns(w).length, 1);
  });

  test('a: no method in effect, not a research exploration, a stopped exploration', async () => {
    const r = await world({ product: 'answer', research: true, question: 'Does the file lock survive a crash?', decision: { type: 'structure', text: 'which lock to use' } });
    await r.advance();
    const words = say(r, 'run it again');
    await assert.rejects(pmRerunAttempt(r.ports.ctx, { mission: M, exploration: r.x, attempts: ['A1'], words }), /ATTEMPT_NOT_REGISTERED: .*no method in effect/);
    const d = await world({ exploration: 'E2' });
    await d.advance();
    await assert.rejects(pmRerunAttempt(d.ports.ctx, { mission: M, exploration: d.x, attempts: ['A1'], words: say(d, 'run it again') }), /ATTEMPT_NOT_REGISTERED: .*not a research exploration/);
    // the interpreter's step given up: stopped, the decision layer decides first
    const { w, words: w2 } = await attemptsPhase();
    await bothRecorded(w);
    const it = only(w, 'researcher-interpreter');
    await w.scheduler.run(it.task, { release: 'ended' });
    assert.equal(await w.scheduler.cancel(it.task), true);
    await w.advance();
    assert.equal((await state(w)).stopped?.reason, 'seat-abandoned');
    await assert.rejects(pmRerunAttempt(w.ports.ctx, { mission: M, exploration: w.x, attempts: ['A1'], words: w2 }), /EXPLORATION_STOPPED/);
    assert.equal(reruns(w).length, 0);
  });

  test('b: in the attempts phase, a fresh blind run of the registered card; the interpreter reads its new record; no round spent', async () => {
    const { w, words } = await attemptsPhase();
    const ctx = w.ports.ctx;
    const first = only(w, 'constructor-experiment');
    const reading = only(w, 'researcher-reader');
    await hand(w, 'constructor-experiment', blind(first.card as unknown as ExperimentCard, 'no'), { runs: ['failed'] });
    await w.advance();
    const s0 = await state(w);
    const old = attemptEvidence(s0, 'A1')!;
    assert.equal(s0.phase, 'attempts');
    const budget = [s0.rounds, allowedRounds(s0)];

    const r = await pmRerunAttempt(ctx, { mission: M, exploration: w.x, attempts: ['A1'], words, reason: 'killed by the time limit, raised since' });
    const again = only(w, 'constructor-experiment');
    assert.deepEqual(r, { n: 1, attempts: [{ attempt: 'A1', replaces: old, step: again.task, evidence: (again.card as unknown as ExperimentCard).evidence.id }], withdrawn: null, phase: 'attempts', rounds: budget[0], allowedRounds: budget[1] });
    // the same card as the attempt's first run: the same method version's steps and commands, blind
    const c1 = first.card as unknown as ExperimentCard;
    const c2 = again.card as unknown as ExperimentCard;
    assert.notEqual(again.task, first.task);
    for (const f of ['steps', 'data', 'measure', 'assertions', 'commands', 'workspace', 'constraints', 'decisionQuotes', 'materials', 'duties', 'interpreter'] as const) assert.deepEqual(c2[f], c1[f], f);
    assert.equal(c2.evidence.attempt, 'A1');
    assert.notEqual(c2.evidence.id, c1.evidence.id);
    assert.ok(!JSON.stringify(c2).includes('does the lock survive'), 'still blind');
    // the reading still queued as it was; the PM's word recorded
    assert.equal(only(w, 'researcher-reader').task, reading.task);
    assert.deepEqual(reruns(w), [{ n: 1, attempts: ['A1'], replaces: { A1: old }, words, reason: 'killed by the time limit, raised since', withdrawn: null, by: 'pm' }]);
    const queuedBy = w.scheduler.tasks.get(again.task)!;
    assert.equal(queuedBy.state, 'queued');

    // the reading's record does not move the phase on: A1's new record is not in yet
    await hand(w, 'researcher-reader', blind(reading.card as unknown as ReaderCard));
    await w.advance();
    assert.equal((await state(w)).phase, 'attempts');
    assert.equal(w.scheduler.queued('researcher-interpreter').length, 0);
    await hand(w, 'constructor-experiment', blind(c2));
    await w.advance();
    const s1 = await state(w);
    assert.equal(s1.phase, 'interpret');
    const ic = cardOf<InterpreterCard>(w, 'researcher-interpreter');
    assert.deepEqual(ic.attempts.map((a) => [a.id, a.evidence]), [
      ['A1', c2.evidence.id],
      ['A2', attemptEvidence(s1, 'A2')],
    ]);
    assert.ok(!ic.materials.some((m) => m.id === `evidence-${old}`), 'the earlier record is no material');
    assert.deepEqual([s1.rounds, allowedRounds(s1), s1.rerunRounds, s1.extraRounds], [...budget, 0, 0], 'no round spent, none added');
  });

  test('c, e: from interpret back to the attempts and on: the queued interpreter withdrawn, the earlier record superseded and kept, the same budget', async () => {
    const { w, words } = await attemptsPhase(2);
    const ctx = w.ports.ctx;
    await bothRecorded(w);
    const s0 = await state(w);
    assert.equal(s0.phase, 'interpret');
    const old = attemptEvidence(s0, 'A1')!;
    const i1 = only(w, 'researcher-interpreter');
    assert.equal(s0.rounds, 1, 'the method took one round of two');

    const r = await pmRerunAttempt(ctx, { mission: M, exploration: w.x, attempts: ['A1'], words });
    assert.equal(r.withdrawn, i1.task);
    assert.equal(r.phase, 'attempts');
    // the interpreter step is out of the queue, taken into account as withdrawn: it never runs
    assert.equal(w.scheduler.queued('researcher-interpreter').length, 0);
    assert.equal(w.scheduler.tasks.get(i1.task)?.state, 'abandoned');
    const s1 = await state(w);
    assert.equal(s1.consumed.get(i1.task)?.kind, 'withdrawn');
    assert.equal(s1.stopped, null);
    assert.deepEqual(readSteps(ctx).ready.filter((x) => x.mission === M).map((x) => x.kind), ['constructor-experiment']);

    await hand(w, 'constructor-experiment', blind(cardOf<ExperimentCard>(w, 'constructor-experiment')));
    await w.advance();
    const s2 = await state(w);
    assert.equal(s2.phase, 'interpret');
    const fresh = attemptEvidence(s2, 'A1')!;
    assert.notEqual(fresh, old);
    const i2 = only(w, 'researcher-interpreter');
    assert.notEqual(i2.task, i1.task);
    const ic = i2.card as unknown as InterpreterCard;
    assert.equal(ic.attempts.find((a) => a.id === 'A1')?.evidence, fresh);
    assert.equal(ic.attempts.find((a) => a.id === 'A1')?.status, 'completed');

    // the interpretation, then the reasoning attack: within the same budget (the method's round and this one)
    await hand(w, 'researcher-interpreter', interpretation(ic));
    await w.advance();
    const s3 = await state(w);
    assert.equal(s3.phase, 'reasoning');
    assert.deepEqual([s3.rounds, allowedRounds(s3), s3.rerunRounds], [1, 2, 0]);
    const cc = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(cc.round, 2);
    // e: the earlier record is on no reader's card; the record the version rests on is the new one
    assert.ok(!cc.evidence.some((e) => e.id === old), 'not listed to the attacker');
    assert.ok(cc.evidence.some((e) => e.id === fresh));
    assert.ok(cc.requiredEvidence.includes(fresh) && !cc.requiredEvidence.includes(old));
    assert.ok(!cc.materials.some((m) => m.id === `evidence-${old}`));
    // ...and kept as history: in the state, in the ledger, and in the hand-off with what superseded it
    assert.equal(supersededAttemptRecord(s3, old), true);
    assert.equal(supersededAttemptRecord(s3, fresh), false);
    assert.ok(s3.evidence.has(old));
    assert.ok((await w.ledger.records(['evidence'])).some((c) => c.record.evidence === old));
    const h = buildHandoff(s3, 'converged', null);
    assert.equal(h.evidence.find((e) => e.id === old)?.supersededBy, fresh);
    assert.equal(h.evidence.find((e) => e.id === fresh)?.supersededBy, undefined);
  });

  test('d: two attempts named together are queued in the register\'s order, side by side (the register sets no order between attempts)', async () => {
    const { w, words } = await attemptsPhase();
    const ctx = w.ports.ctx;
    await bothRecorded(w);
    const r = await pmRerunAttempt(ctx, { mission: M, exploration: w.x, attempts: ['A2', 'A1', 'A2'], words });
    assert.deepEqual(r.attempts.map((a) => a.attempt), ['A1', 'A2']);
    assert.deepEqual(reruns(w)[0]?.attempts, ['A1', 'A2']);
    const s = await state(w);
    const [n1, n2] = r.attempts.map((a) => s.tasks.get(a.step!)!.n);
    assert.ok(n1! < n2!, 'A1 queued before A2');
    const ready = readSteps(ctx).ready.filter((x) => x.kind === 'constructor-experiment' || x.kind === 'researcher-reader');
    assert.deepEqual(ready.map((x) => x.step), r.attempts.map((a) => a.step));
    assert.ok(ready.every((x) => x.parallel), 'neither waits for the other');
    // each counts once its own new record is in, in any order
    await hand(w, 'researcher-reader', blind(cardOf<ReaderCard>(w, 'researcher-reader')));
    await w.advance();
    assert.equal((await state(w)).phase, 'attempts');
    await hand(w, 'constructor-experiment', blind(cardOf<ExperimentCard>(w, 'constructor-experiment')));
    await w.advance();
    const s2 = await state(w);
    assert.equal(s2.phase, 'interpret');
    assert.deepEqual(['A1', 'A2'].map((a) => attemptEvidence(s2, a)), r.attempts.map((a) => a.evidence));
  });

  describe('f: the command line', () => {
    const p = gitProject();
    after(() => p.cleanup());
    test('listed with its usage; --words required; a refusal names its code', async () => {
      await cli(p.dir, ['init']);
      await cli(p.dir, ['pm', 'say', 'Run the attempt again.']);
      assert.match((await cli(p.dir, ['pm', '--help'])).out, /mp pm rerun-attempt/);
      const usage = await cli(p.dir, ['help', 'pm', 'rerun-attempt']);
      assert.equal(usage.code, 0);
      assert.match(usage.out, /mp pm rerun-attempt <mission> <exploration> <attempt-id>\[,<attempt-id>\.\.\.\] --words W-<n> \[--reason "<text>"\]/);
      assert.equal((await cli(p.dir, ['pm', 'rerun-attempt', 'm1', 'X1', 'A1'])).code, 64);
      assert.equal((await cli(p.dir, ['pm', 'rerun-attempt', 'm1', 'X1', '--words', 'W-1'])).code, 64);
      const r = await cli(p.dir, ['pm', 'rerun-attempt', 'm1', 'X1', 'A1,A2', '--words', 'W-1', '--reason', 'killed by the time limit', '--json']);
      assert.equal(r.code, 3, r.out);
      assert.equal(r.json.error.code, 'NOT_ALLOWED');
      assert.match(r.json.error.message, /no exploration X1/);
    });
  });
});
