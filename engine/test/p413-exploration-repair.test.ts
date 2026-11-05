// 4.1.3 (E-5; issue #31): the user's decisions about a research exploration's method go through the
// one repair entry, `mp pm repair --about <x>`.
//   a  change forms (--attempts, --rerun, --resnapshot): the user's decision takes effect directly,
//      in the same write as the repair it answers; the repair reads as answered; no round, no seat
//   b  the refusals that protect the record keep their codes (DISPATCH_IN_FLIGHT,
//      INTERPRETATION_SUBMITTED); every other is NOT_ALLOWED with its reason
//   c  #31: a repair with no change form gives the author the turn at once in the attempts phase.
//      Runs in flight finish; records of attempts the new version leaves unchanged (the registered
//      card equal) keep counting; queued runs of attempts it drops or changes are withdrawn; a queued
//      interpreter is withdrawn; one at work refuses the repair
//   d  the older commands (amend-attempts, rerun-attempt, resnapshot-exploration) call the same code,
//      record a repair too, and print one line naming the mp pm repair form

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { explorationState } from '../src/flow/exploration/flow.ts';
import { allowedRounds, attemptRecorded, type XState } from '../src/flow/exploration/machine.ts';
import { cal1Pass } from '../src/flow/scripted.ts';
import { recordRepair, repairsOf } from '../src/flow/repair.ts';
import { pmAmendAttempts, pmMission, pmPlan, pmRepair, pmRequirement, pmSay } from '../src/process/index.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { ExperimentCard } from '../src/seat/cards/experiment.ts';
import type { AuthorCard, InterpreterCard, ReaderCard, RegisteredAttemptT } from '../src/seat/cards/researcher.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import { cli } from './cli-fixtures.ts';
import { say } from './flow-memory-fixtures.ts';
import { M, RUN_PLACEHOLDER, attack, blind, cardOf, finding, hand, only, recheckAll, reviseAll, stabilizeAll, submit, world, type World } from './flow-exploration-fixtures.ts';
import { handBack, processProject, readAll, step } from './process-fixtures.ts';
import { pmDispatch } from '../src/process/index.ts';
import { dispatchView } from '../src/process/seat.ts';

const URL = 'https://docs.example.org/';
const A1: RegisteredAttemptT = { id: 'A1', kind: 'experiment', purpose: 'does the lock survive a crash', steps: ['run the crash script 20 times'], data: 'the repository', measure: ['survivals'], assertions: ['all 20 survive'], commands: [{ id: 'step', command: 'sh crash.sh 20' }] };
const A2: RegisteredAttemptT = { id: 'A2', kind: 'reading', purpose: 'what the kernel documents', steps: ['read the locking documentation'], data: URL, measure: ['guarantee stated'], assertions: [] };
const A2_WIDER: RegisteredAttemptT = { ...A2, steps: ['read the locking documentation', 'read the errata'] };
const A3: RegisteredAttemptT = { id: 'A3', kind: 'reading', purpose: 'what the filesystem documents', steps: ['read the filesystem documentation'], data: URL, measure: ['guarantee stated'], assertions: [] };
const REASON = 'Search the whole domain: read the errata and the filesystem documentation too.';

/** A research exploration whose method (A1, A2) passed in its first round: both attempts queued; the user's words. */
async function attemptsPhase(): Promise<{ w: World; words: string }> {
  const w = await world({ product: 'answer', research: true, question: 'Does the file lock survive a crash?', decision: { type: 'structure', text: 'which lock to use' }, readingNetwork: [URL], rounds: 3 });
  await w.advance();
  await hand(w, 'researcher-author', submit('method v1', [], { attempts: [A1, A2] }));
  await w.advance();
  await hand(w, 'crititor', attack());
  await w.advance();
  return { w, words: say(w, REASON) };
}

const state = (w: World): Promise<XState> => explorationState({ ledger: w.ledger }, M, w.x);

async function handExperiment(w: World, task: string, holds: 'yes' | 'no' = 'yes'): Promise<void> {
  const run = w.scheduler.rerun(w.scheduler.dispatchOf(task), 'step', holds === 'yes');
  const fields = JSON.parse(JSON.stringify(blind(w.scheduler.card<ExperimentCard>(task), holds)).split(RUN_PLACEHOLDER).join(`run:${run}`));
  assert.deepEqual(await w.scheduler.run(task, { handBack: fields }), []);
  await w.advance();
}

async function handReading(w: World, task: string): Promise<void> {
  assert.deepEqual(await w.scheduler.run(task, { handBack: blind(w.scheduler.card<ReaderCard>(task)) }), []);
  await w.advance();
}

const readingOf = (w: World, attempt: string) => w.scheduler.queued('researcher-reader').find((t) => (t.card as unknown as ReaderCard).evidence.attempt === attempt);

describe('a: change forms of mp pm repair', () => {
  test('--attempts: the repair and the amendment are one write; the repair is answered; no round, no author', async () => {
    const { w, words } = await attemptsPhase();
    const before = await state(w);
    const r = await pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: 'the filesystem documentation too', about: w.x, change: { form: 'attempts', attempts: [A3] } });
    assert.equal(r.repair, 'R-1');
    assert.equal(r.changed?.form, 'attempts');
    const s = await state(w);
    assert.equal(s.amendments.at(-1)?.answers, 'R-1');
    assert.deepEqual([s.rounds, allowedRounds(s)], [before.rounds, allowedRounds(before)], 'no round spent or added');
    assert.equal(s.repairs.length, 0, 'the repair adds no round to the exploration');
    assert.equal(w.scheduler.queued('researcher-author').length, 0, 'no author, attacker or Stabilizer');
    assert.ok(readingOf(w, 'A3'), 'the added attempt runs at once');
    const rs = await repairsOf(flowCtx(w.ports, M));
    assert.deepEqual(rs.map((x) => [x.id, x.state, x.answeredBy?.change, x.answeredBy?.n]), [['R-1', 'answered', 'attempts-amended', 1]]);
  });

  test('--rerun: the attempt runs again on the same method version, answering the repair', async () => {
    const { w, words } = await attemptsPhase();
    await handExperiment(w, only(w, 'constructor-experiment').task, 'no');
    const r = await pmRepair(w.ports.ctx, { mission: M, words, kind: 'defect', text: 'Search the whole domain', about: w.x, change: { form: 'rerun', attempts: ['A1'] } });
    assert.equal(r.changed?.form, 'rerun');
    const rs = await repairsOf(flowCtx(w.ports, M));
    assert.deepEqual(rs.map((x) => [x.id, x.kind, x.state, x.answeredBy?.change]), [['R-1', 'defect', 'answered', 'attempt-rerun']]);
    assert.equal(only(w, 'constructor-experiment').card['seat'], 'constructor-experiment', 'a fresh run of A1 is queued');
  });

  test('--resnapshot: the snapshot taken again answers the repair; the branch at its snapshot is NOT_ALLOWED and writes nothing', async () => {
    const { w, words } = await attemptsPhase();
    // every queued run waits in the queue: no seat holds one
    await assert.rejects(pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: 'Search the whole domain', about: w.x, change: { form: 'resnapshot' } }), (e: { code?: string }) => e.code === 'NOT_ALLOWED');
    assert.equal((await repairsOf(flowCtx(w.ports, M))).length, 0, 'nothing written');
    w.scheduler.knobs.actions = { snapshot: async () => ({ path: 'c0ffee00', commit: 'c0ffee00', products: [] }) };
    const r = await pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: 'Search the whole domain', about: w.x, change: { form: 'resnapshot' } });
    assert.equal(r.changed?.form, 'resnapshot');
    const s = await state(w);
    assert.deepEqual([s.defined?.snapshot.commit, s.resnapshots.at(-1)?.answers], ['c0ffee00', 'R-1']);
    assert.equal((await repairsOf(flowCtx(w.ports, M)))[0]?.answeredBy?.change, 'resnapshotted');
  });

  test('a change form needs an exploration in --about, and the reason verbatim from the words', async () => {
    const { w, words } = await attemptsPhase();
    await assert.rejects(pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: 'Search the whole domain', change: { form: 'resnapshot' } }), /about an exploration/);
    await assert.rejects(pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: 'not in the words', about: w.x, change: { form: 'attempts', attempts: [A3] } }));
    assert.equal((await repairsOf(flowCtx(w.ports, M))).length, 0);
  });
});

describe('b: the refusals', () => {
  test('a run a seat holds is DISPATCH_IN_FLIGHT; an interpretation submitted is INTERPRETATION_SUBMITTED; the rest NOT_ALLOWED; nothing written', async () => {
    const { w, words } = await attemptsPhase();
    const ctx = w.ports.ctx;
    const code = async (attempts: unknown, expected: string, form: 'attempts' | 'rerun' = 'attempts') => {
      await assert.rejects(
        pmRepair(ctx, { mission: M, words, kind: 'new-question', text: 'Search the whole domain', about: w.x, change: form === 'attempts' ? { form, attempts } : { form, attempts: attempts as string[] } }),
        (e: { code?: string }) => e.code === expected,
        expected,
      );
      assert.equal((await repairsOf(flowCtx(w.ports, M))).length, 0, 'no repair written');
    };
    await code([], 'NOT_ALLOWED');
    await code([A1, A2], 'NOT_ALLOWED');
    await code(['A9'], 'NOT_ALLOWED', 'rerun');
    await code(['A1'], 'NOT_ALLOWED', 'rerun');
    const run = only(w, 'constructor-experiment');
    w.scheduler.dispatchOf(run.task);
    await code([{ ...A1, steps: ['run it 200 times'] }], 'DISPATCH_IN_FLIGHT');
    await handExperiment(w, run.task);
    await handReading(w, readingOf(w, 'A2')!.task);
    const ic = only(w, 'researcher-interpreter');
    await w.scheduler.run(ic.task, { handBack: { answer: 'it survives', conclusions: (ic.card as unknown as InterpreterCard).attempts.map((a, i) => ({ id: `C${i}`, text: a.id, cites: [a.id], standing: 'standing', key: i === 0 })), message: 'm', dispositions: [] } });
    await code([A3], 'INTERPRETATION_SUBMITTED');
  });
});

describe('c: #31, a repair with no change form gives the author the turn at once', () => {
  test('in the attempts phase: the author now; A1 in flight finishes and counts (unchanged); A2 changed: its queued run withdrawn at the new version, its new card runs; A3 added runs', async () => {
    const { w, words } = await attemptsPhase();
    const a1 = only(w, 'constructor-experiment');
    w.scheduler.dispatchOf(a1.task);
    const a2 = readingOf(w, 'A2')!;
    const r = await pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: REASON, about: w.x });
    assert.equal(r.repair, 'R-1');
    let s = await state(w);
    assert.deepEqual([s.phase, s.turn, s.reentry?.repair], ['method', 'author', 'R-1']);
    // the author's turn at once, beside the runs: no wait for A1 or A2
    const author = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(author.registerAttempts, true);
    assert.equal(author.repairs?.[0]?.id, 'R-1');
    assert.equal(author.current?.version, s.method?.version);
    // A1's run in flight hands back meanwhile: recorded, the phase stays with the author
    await handExperiment(w, a1.task);
    s = await state(w);
    assert.equal(s.phase, 'method');
    assert.equal(attemptRecorded(s, 'A1'), true);
    // the author's new version keeps A1, widens A2, adds A3: A2's run, only queued, is withdrawn
    await hand(w, 'researcher-author', submit('method v2: the whole domain', [], { attempts: [A1, A2_WIDER, A3] }));
    s = await state(w);
    assert.equal(s.consumed.get(a2.task)?.kind, 'withdrawn');
    assert.equal(w.scheduler.queued('researcher-reader').some((t) => t.task === a2.task), false);
    await w.advance();
    await hand(w, 'crititor', attack());
    await w.advance();
    s = await state(w);
    assert.equal(s.phase, 'attempts');
    assert.equal(s.method?.attempts.length, 3);
    assert.equal(attemptRecorded(s, 'A1'), true, 'the unchanged attempt keeps its record');
    assert.equal(w.scheduler.queued('constructor-experiment').length, 0, 'A1 does not run again');
    const wider = readingOf(w, 'A2')!;
    assert.deepEqual((wider.card as unknown as ReaderCard).steps, A2_WIDER.steps, 'A2 runs under its new card');
    await handReading(w, wider.task);
    await handReading(w, readingOf(w, 'A3')!.task);
    s = await state(w);
    assert.equal(s.phase, 'interpret');
    const ic = cardOf<InterpreterCard>(w, 'researcher-interpreter');
    assert.equal(ic.method.version, s.method?.version);
    assert.deepEqual(ic.attempts.map((a) => [a.id, a.status]), [['A1', 'completed'], ['A2', 'completed'], ['A3', 'completed']]);
  });

  test('"unchanged" is the registered card equal: one changed field reruns the attempt, an equal one keeps its record', async () => {
    const { w, words } = await attemptsPhase();
    await handExperiment(w, only(w, 'constructor-experiment').task);
    await handReading(w, readingOf(w, 'A2')!.task);
    // the interpreter is queued: the repair withdraws it in its own write
    const ic = only(w, 'researcher-interpreter');
    await pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: REASON, about: w.x });
    let s = await state(w);
    assert.equal(s.consumed.get(ic.task)?.kind, 'withdrawn');
    assert.equal(s.phase, 'method');
    await hand(w, 'researcher-author', submit('method v2', [], { attempts: [{ ...A1, purpose: 'does the lock survive a crash, really' }, A2] }));
    await w.advance();
    await hand(w, 'crititor', attack());
    await w.advance();
    s = await state(w);
    assert.equal(attemptRecorded(s, 'A2'), true, 'A2 equal: its record keeps counting');
    assert.equal(attemptRecorded(s, 'A1'), false, 'A1 changed (its purpose): it runs again');
    assert.ok(w.scheduler.queued('constructor-experiment').length === 1);
    assert.equal(w.scheduler.queued('researcher-reader').length, 0);
  });

  test('exit: a run withdrawn for a changed attempt, the attempt then restored as it was registered: it runs (never waits for the withdrawn run)', async () => {
    const { w, words } = await attemptsPhase();
    const a2 = readingOf(w, 'A2')!;
    await pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: REASON, about: w.x });
    await hand(w, 'researcher-author', submit('method v2', [], { attempts: [A1, A2_WIDER] }));
    assert.equal((await state(w)).consumed.get(a2.task)?.kind, 'withdrawn');
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'method', 'the errata are out of scope')]));
    await w.advance();
    // the author restores A2 as it was registered
    await hand(w, 'researcher-author', submit('method v3', reviseAll(cardOf<AuthorCard>(w, 'researcher-author')), { attempts: [A1, A2] }));
    await w.advance();
    await hand(w, 'crititor', attack([], recheckAll(cardOf<CrititorCard>(w, 'crititor'), 'yes')));
    await w.advance();
    const s = await state(w);
    assert.equal(s.phase, 'attempts');
    const again = readingOf(w, 'A2');
    assert.ok(again !== undefined && again.task !== a2.task, 'A2 runs again (its withdrawn run brings no record)');
  });

  test('an interpreter at work refuses the repair (DISPATCH_IN_FLIGHT), nothing written', async () => {
    const { w, words } = await attemptsPhase();
    await handExperiment(w, only(w, 'constructor-experiment').task);
    await handReading(w, readingOf(w, 'A2')!.task);
    w.scheduler.dispatchOf(only(w, 'researcher-interpreter').task);
    await assert.rejects(pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: REASON, about: w.x }), (e: { code?: string }) => e.code === 'DISPATCH_IN_FLIGHT');
    assert.equal((await repairsOf(flowCtx(w.ports, M))).length, 0);
    assert.equal((await state(w)).phase, 'interpret');
  });

  test('an amendment answering the repair before its author starts: the method stays in force, amended; the queued author step is withdrawn', async () => {
    const { w, words } = await attemptsPhase();
    await pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: REASON, about: w.x });
    const author = only(w, 'researcher-author');
    const r = await pmAmendAttempts(w.ports.ctx, { mission: M, exploration: w.x, attempts: [A3], words, answers: 'R-1' });
    assert.equal(r.answers, 'R-1');
    const s = await state(w);
    assert.equal(s.consumed.get(author.task)?.kind, 'withdrawn');
    assert.deepEqual([s.phase, s.reentry], ['attempts', null]);
    assert.equal(w.scheduler.queued('researcher-author').length, 0);
    assert.ok(readingOf(w, 'A3'));
    assert.equal((await repairsOf(flowCtx(w.ports, M)))[0]?.state, 'answered');
  });

  test('a change form while the method is back with its author answers that repair only when the PM names it: refused without --answers (both exits named, R-1 stays open); with --answers R-1 one write answers both', async () => {
    const { w, words } = await attemptsPhase();
    // R-1 asks the author for a new algorithm; R-2 only adds an attempt: two decisions the program never links
    const algo = say(w, 'Use a lock-free algorithm instead of the file lock.');
    await pmRepair(w.ports.ctx, { mission: M, words: algo, kind: 'new-question', text: 'Use a lock-free algorithm instead of the file lock.', about: w.x });
    const author = only(w, 'researcher-author');
    await assert.rejects(
      pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: 'the filesystem documentation too', about: w.x, change: { form: 'attempts', attempts: [A3] } }),
      (e: { code?: string; message?: string }) => e.code === 'NOT_ALLOWED' && /back with its author for repair R-1.*if this change settles R-1, pass --answers R-1; otherwise apply the change once the author's version passes/.test(e.message ?? ''),
    );
    let s = await state(w);
    assert.deepEqual([s.phase, s.reentry?.repair, s.consumed.has(author.task)], ['method', 'R-1', false], 'the author keeps the turn');
    assert.deepEqual((await repairsOf(flowCtx(w.ports, M))).map((x) => [x.id, x.state]), [['R-1', 'exploration']], 'R-1 stays open; nothing more was written');
    assert.equal(only(w, 'researcher-author').task, author.task);
    // the PM names it: the change settles R-1 too
    const r = await pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: 'the filesystem documentation too', about: w.x, change: { form: 'attempts', attempts: [A3], answers: 'R-1' } });
    assert.equal(r.repair, 'R-2');
    const result = r.changed?.form === 'attempts' ? r.changed.result : null;
    assert.deepEqual([result?.answers, result?.repair], ['R-1', 'R-2']);
    s = await state(w);
    assert.deepEqual([s.phase, s.reentry, s.consumed.get(author.task)?.kind, s.rerunRounds], ['attempts', null, 'withdrawn', 0]);
    assert.equal(s.amendments.at(-1)?.repair, 'R-2');
    assert.ok(readingOf(w, 'A3'), 'the added attempt runs at once');
    assert.deepEqual((await repairsOf(flowCtx(w.ports, M))).map((x) => [x.id, x.state, x.answeredBy?.change]), [
      ['R-1', 'answered', 'attempts-amended'],
      ['R-2', 'answered', 'attempts-amended'],
    ]);
  });

  test('once the author started, a change form is NOT_ALLOWED (its new version decides); a rerun is NOT_ALLOWED meanwhile', async () => {
    const { w, words } = await attemptsPhase();
    await pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: REASON, about: w.x });
    await assert.rejects(pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: REASON, about: w.x, change: { form: 'rerun', attempts: ['A1'] } }), (e: { code?: string; message?: string }) => e.code === 'NOT_ALLOWED' && /back with its author/.test(e.message ?? ''));
    w.scheduler.dispatchOf(only(w, 'researcher-author').task);
    await assert.rejects(pmRepair(w.ports.ctx, { mission: M, words, kind: 'new-question', text: REASON, about: w.x, change: { form: 'attempts', attempts: [A3] } }), (e: { code?: string; message?: string }) => e.code === 'NOT_ALLOWED' && /back with its author for repair R-1, and the author step \S+ was dispatched/.test(e.message ?? ''));
    assert.equal((await repairsOf(flowCtx(w.ports, M))).length, 1, 'nothing more written');
  });

  test('a running product exploration: the author answers the repair before the exploration can end', async () => {
    const w = await world();
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    // the attacker is at work when the repair is recorded: its round ends, then the author has the turn
    const t = only(w, 'crititor');
    w.scheduler.dispatchOf(t.task);
    const words = say(w, 'It must also work offline.');
    await recordRepair(w.ports, { mission: M, words, kind: 'missing', text: 'It must also work offline.', about: { kind: 'exploration', id: w.x } });
    assert.deepEqual(await w.scheduler.run(t.task, { handBack: attack() }), []);
    await w.advance();
    await w.scheduler.run(only(w, 'stabilizer').task, { handBack: stabilizeAll(cardOf<StabilizerCard>(w, 'stabilizer')) });
    const r = await w.advance();
    assert.equal(r.state, 'waiting', 'not converged: the repair waits for the author');
    assert.equal(cardOf<AuthorCard>(w, 'researcher-author').repairs?.[0]?.text, 'It must also work offline.');
  });
});

describe('d: the older commands', () => {
  const p = processProject();
  after(() => p.cleanup());
  test('amend-attempts and rerun-attempt print the mp pm repair form, record a repair, and answer it; the new form through mp', async () => {
    const ctx = p.ctx;
    const m = 'm1' as MissionId;
    pmMission(ctx, m);
    const w1 = pmSay(ctx, 'Find out whether the lock survives a crash. The details are yours to decide.').words;
    await pmRequirement(ctx, { mission: m, item: 'a1', type: 'authorization', text: "Details are the PM's", quote: 'The details are yours to decide', words: w1 });
    await pmPlan(ctx, {
      mission: m,
      words: [w1],
      plan: {
        format: 'mp4.pm-plan.v1',
        mission: m,
        round: 1,
        order: 'free',
        elements: [
          {
            id: 'x',
            kind: 'exploration',
            text: 'Does the lock survive a crash?',
            provenance: { by: 'user', words: w1, quote: 'whether the lock survives a crash' },
            exploration: { id: 'X1', deliverable: 'the answer', fuzzyGoal: { quote: 'Find out', words: w1 }, attackScope: ['unsupported conclusion'], decision: { id: 'D1', type: 'structure' }, budget: { rounds: 3, micros: null }, stop: '', research: true, readingNetwork: [URL] },
            after: [],
            items: [],
          },
        ],
        goalsBeyond: [],
        authorizations: ['a1'],
      },
    });
    await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(ctx, 'researcher-author', () => submit('method: read the documentation', [], { attempts: [{ ...A2, id: 'R1' }] }));
    await step(ctx, 'crititor', () => attack());
    await step(ctx, 'stabilizer', (c: StabilizerCard) => stabilizeAll(c));
    const w2 = pmSay(ctx, 'Read the filesystem documentation too.').words;
    const dir = mkdtempSync(join(tmpdir(), 'mp-repair-'));
    const file = join(dir, 'attempts.json');
    writeFileSync(file, JSON.stringify([{ ...A3, id: 'R2' }]));
    const out = await cli(p.dir, ['pm', 'amend-attempts', m, 'X1', '--words', w2, '--file', file]);
    assert.equal(out.code, 0, out.err);
    const first = out.out.split('\n')[0] ?? '';
    assert.match(first, /^mp pm amend-attempts is an older name, kept for one release: use mp pm repair m1 --about X1 --words W-\d+ --kind <kind> --text "<the user's reason>" --attempts /);
    assert.match(out.out, /Repair recorded: R-1, answered by this amendment\./);
    const again = await cli(p.dir, ['pm', 'amend-attempts', m, 'X1', '--words', w2, '--file', file, '--json']);
    assert.equal(again.code, 3);
    assert.equal(again.json.error?.code ?? again.json.code, 'NOT_ALLOWED', JSON.stringify(again.json));
    // the new form through mp, a resnapshot with the branch where it is: refused, nothing recorded
    const snap = await cli(p.dir, ['pm', 'repair', m, '--about', 'X1', '--words', w2, '--kind', 'new-question', '--text', 'Read the filesystem documentation too', '--resnapshot']);
    assert.equal(snap.code, 3, snap.out);
    assert.match(snap.err + snap.out, /NOT_ALLOWED/);
    const two = await cli(p.dir, ['pm', 'repair', m, '--about', 'X1', '--words', w2, '--kind', 'new-question', '--text', 'Read the filesystem documentation too', '--resnapshot', '--rerun', 'R1']);
    assert.notEqual(two.code, 0);
    assert.match(two.err + two.out, /one change form at a time/);
    const rs = await repairsOf(flowCtx(ctx.ports(), m));
    assert.deepEqual(rs.map((r) => [r.id, r.kind, r.state, r.text]), [['R-1', 'new-question', 'answered', 'Read the filesystem documentation too.']]);
    void rs;
    // rerun-attempt: R1's record in, run again on the same method version
    const xs = await explorationState(ctx.ports(), m, 'X1');
    const d = pmDispatch(ctx, [...xs.tasks.values()].find((q) => q.evidence?.attempt === 'R1' && !xs.consumed.has(q.task))!.task, { filledBy: 'test-harness/scripted' });
    readAll(ctx, d.dispatch);
    assert.equal((await handBack(ctx, d.dispatch, blind(dispatchView(ctx, d.dispatch).card as unknown as ReaderCard))).kind, 'recorded');
    const rerun = await cli(p.dir, ['pm', 'rerun-attempt', m, 'X1', 'R1', '--words', w2, '--kind', 'defect']);
    assert.equal(rerun.code, 0, rerun.err);
    assert.match(rerun.out.split('\n')[0] ?? '', /^mp pm rerun-attempt is an older name, kept for one release: use mp pm repair m1 --about X1 .* --rerun R1\.$/);
    assert.match(rerun.out, /Repair recorded: R-2, answered by this rerun\./);
    const help = await cli(p.dir, ['help', 'pm', 'repair']);
    assert.match(help.out, /--attempts <attempts\.json> \[--answers R-<n>\] \| --rerun <attempt-id>/);
    assert.match((await cli(p.dir, ['help', 'pm', 'rerun-attempt'])).out, /older name of mp pm repair --rerun/);
    assert.deepEqual((await repairsOf(flowCtx(ctx.ports(), m))).map((r) => [r.id, r.kind, r.state, r.answeredBy?.change]), [
      ['R-1', 'new-question', 'answered', 'attempts-amended'],
      ['R-2', 'defect', 'answered', 'attempt-rerun'],
    ]);
  });
});
