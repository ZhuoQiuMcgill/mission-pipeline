// The user's amendment of a research exploration's method in force (`mp pm amend-attempts`,
// process/explorationAttempts.ts): a decision the user made about the method (a scale, a cap, a
// search extended to more of the domain) adds or replaces registered attempts on their words,
// without a round and without review.
//   a  its refusals, named, nothing written: no such exploration, no words entry, attempts that do
//      not validate as the author's register would (ids unique among them), nothing changed, no
//      method in force, not a research exploration, a replaced attempt's run in flight or handed
//      back, an interpreter dispatched or at work, an interpretation submitted, a stopped or
//      settled exploration
//   b  added in the attempts phase: a new method version in force, passed by the user's judgment;
//      the added attempt runs at once beside the others; no round spent; the phase moves on only
//      once every attempt of the amended method has its record; later cards name the amended
//      version, and the answer that rests on it is proven
//   c  an unrecorded attempt replaced: the waiting run of its earlier card is withdrawn, its new
//      card runs
//   d  a recorded attempt replaced: its new card runs, and the new record supersedes the earlier one
//      (kept as history)
//   e  from interpret: the queued interpreter is withdrawn, back to the attempts, then on
//   f  --answers: the repair no longer adds its round, and no card shows it; refused once its
//      round started
//   g  the command line: its help, its arguments, a refusal's code
//   h  through mp: the command, the reads (show exploration, status, the object), the proof

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { buildHandoff, explorationState, recordExplorationRuling } from '../src/flow/exploration/flow.ts';
import { ATTEMPTS_AMENDED, allowedRounds, attemptEvidence, supersededAttemptRecord, type AttemptsAmendedBody, type XState } from '../src/flow/exploration/machine.ts';
import { explorationLine } from '../src/flow/plandoc.ts';
import { recordRepair, repairsOf } from '../src/flow/repair.ts';
import { flowCtx } from '../src/flow/context.ts';
import { cal1Pass } from '../src/flow/scripted.ts';
import { flowEvents } from '../src/memory/index.ts';
import { advance, pmAmendAttempts, pmMission, pmPlan, pmRequirement, pmSay, readSteps } from '../src/process/index.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { ExperimentCard } from '../src/seat/cards/experiment.ts';
import type { AuthorCard, InterpreterCard, InterpreterResult, ReaderCard, RegisteredAttemptT, ResearchMethodDoc } from '../src/seat/cards/researcher.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import { cli, gitProject } from './cli-fixtures.ts';
import { say } from './flow-memory-fixtures.ts';
import { M, RUN_PLACEHOLDER, attack, blind, cardOf, finding, hand, only, recheckAll, reviseAll, stabilizeAll, submit, world, type World } from './flow-exploration-fixtures.ts';
import { handBack, processProject, readAll, step } from './process-fixtures.ts';
import { pmDispatch, pmNext } from '../src/process/index.ts';
import { dispatchView } from '../src/process/seat.ts';

const URL = 'https://docs.example.org/';
const ATTEMPTS: RegisteredAttemptT[] = [
  { id: 'A1', kind: 'experiment', purpose: 'does the lock survive a crash', steps: ['run the crash script 20 times'], data: 'the repository', measure: ['survivals'], assertions: ['all 20 survive'], commands: [{ id: 'step', command: 'sh crash.sh 20' }] },
  { id: 'A2', kind: 'reading', purpose: 'what the kernel documents', steps: ['read the locking documentation'], data: URL, measure: ['guarantee stated'], assertions: [] },
];
/** The user's decisions: a reading added (the rest of the domain), the experiment's cap lifted, the reading widened. */
const A3: RegisteredAttemptT = { id: 'A3', kind: 'reading', purpose: 'what the filesystem documents', steps: ['read the filesystem documentation'], data: URL, measure: ['guarantee stated'], assertions: [] };
const A1_UNCAPPED: RegisteredAttemptT = { ...ATTEMPTS[0]!, steps: ['run the crash script 200 times'], assertions: ['all 200 survive'], commands: [{ id: 'step', command: 'sh crash.sh 200' }] };
const A2_WIDER: RegisteredAttemptT = { ...ATTEMPTS[1]!, steps: ['read the locking documentation', 'read the errata'] };

/** A research exploration whose method (registering A1 and A2) passed in its first round: both attempts queued. The words entry the user's decision rests on. */
async function attemptsPhase(rounds = 3): Promise<{ w: World; words: string }> {
  const w = await world({ product: 'answer', research: true, question: 'Does the file lock survive a crash?', decision: { type: 'structure', text: 'which lock to use' }, readingNetwork: [URL], rounds });
  await w.advance();
  await hand(w, 'researcher-author', submit('method v1', [], { attempts: ATTEMPTS }));
  await w.advance();
  await hand(w, 'crititor', attack());
  await w.advance();
  const words = say(w, 'Search the whole domain: no cap on the crash runs, and read the filesystem documentation too.');
  return { w, words };
}

const state = (w: World): Promise<XState> => explorationState({ ledger: w.ledger }, M, w.x);

function amendments(w: World): AttemptsAmendedBody[] {
  return w.memory.read((db) => flowEvents(db, { mission: M, line: explorationLine(w.x), event: ATTEMPTS_AMENDED })).map((e) => JSON.parse(w.memory.data.text(e.body)) as AttemptsAmendedBody);
}

/** The method versions amendments recorded. */
async function objectVersions(w: World): Promise<string[]> {
  return (await w.ledger.records(['object.version'])).map((c) => String(c.record.object)).filter((o) => o.includes('.amend'));
}

/** A1's run handed back (its command failed), the reading A2 handed back (the first reading queued, when an added one waits too). */
async function bothRecorded(w: World): Promise<void> {
  await hand(w, 'constructor-experiment', blind(cardOf<ExperimentCard>(w, 'constructor-experiment'), 'no'), { runs: ['failed'] });
  await w.advance();
  await handReading(w, w.scheduler.queued('researcher-reader')[0]!.task);
}

/** A reading's run handed back, then taken into account. */
async function handReading(w: World, task: string): Promise<void> {
  assert.deepEqual(await w.scheduler.run(task, { handBack: blind(w.scheduler.card<ReaderCard>(task)) }), []);
  await w.advance();
}

/** An experiment's dispatch in flight hands back, its claims citing a run of that dispatch. */
async function handInFlight(w: World, task: string, card: ExperimentCard, holds: 'yes' | 'no' = 'yes'): Promise<void> {
  const run = w.scheduler.rerun(w.scheduler.dispatchOf(task), 'step', holds === 'yes');
  const fields = JSON.parse(JSON.stringify(blind(card, holds)).split(RUN_PLACEHOLDER).join(`run:${run}`));
  assert.deepEqual(await w.scheduler.run(task, { handBack: fields }), []);
}

/** Every registered attempt cited (8.2), the first conclusion the key one. */
function interpretation(card: InterpreterCard): InterpreterResult {
  return {
    answer: 'the lock survives crashes',
    conclusions: card.attempts.map((a, i) => ({ id: `C${i + 1}`, text: `${a.id} supports it`, cites: [a.id], standing: 'standing' as const, key: i === 0 })),
    message: 'first interpretation',
    dispositions: [],
  };
}

const methodDoc = (w: World, s: XState): ResearchMethodDoc => JSON.parse(w.ledger.content.get(s.versions.find((v) => v.id === s.method?.version)!.content)) as ResearchMethodDoc;

describe('mp pm amend-attempts', () => {
  test('a: refusals, each named, nothing written', async () => {
    const { w, words } = await attemptsPhase();
    const ctx = w.ports.ctx;
    const objects = 0;
    const refused = async (attempts: unknown, code: string, o: { x?: string; match?: RegExp; words?: string } = {}): Promise<void> => {
      await assert.rejects(pmAmendAttempts(ctx, { mission: M, exploration: o.x ?? w.x, attempts, words: o.words ?? words }), (e: { code?: string; message?: string }) => e.code === code && (o.match === undefined || o.match.test(e.message ?? '')), code);
      assert.equal(amendments(w).length, 0, 'no amendment recorded');
      assert.equal((await objectVersions(w)).length, objects, 'no method version recorded');
    };
    await refused([A3], 'NOT_ALLOWED', { x: 'nope', match: /no exploration nope/ });
    await refused([A3], 'NOT_ALLOWED', { words: 'W-99', match: /no words entry W-99/ });
    // the attempts, checked as the author's register would be
    await refused({ attempts: [A3] }, 'ATTEMPTS_INVALID', { match: /JSON array/ });
    await refused([], 'ATTEMPTS_INVALID', { match: /names no attempt/ });
    await refused([{ ...A3, steps: [] }], 'ATTEMPTS_INVALID', { match: /attempts\[0\]\.steps/ });
    await refused([{ ...A3, kind: 'survey' }], 'ATTEMPTS_INVALID', { match: /attempts\[0\]\.kind/ });
    await refused([{ ...A3, assertion: ['typo'] }], 'ATTEMPTS_INVALID', { match: /unknown field\(s\) assertion/ });
    await refused([A3, { ...A3, purpose: 'again' }], 'ATTEMPTS_INVALID', { match: /id "A3" is registered twice/ });
    await refused([{ ...A3, measure: [] }], 'ATTEMPTS_INVALID', { match: /record at least one quantity or check one assertion/ });
    await refused([ATTEMPTS[0], ATTEMPTS[1]], 'NOTHING_AMENDED', { match: /equals its registered one/ });
    // a replaced attempt's run that a seat has: in flight, then handed back and not taken into account yet
    const run = only(w, 'constructor-experiment');
    w.scheduler.dispatchOf(run.task);
    await refused([A1_UNCAPPED], 'ATTEMPT_QUEUED', { match: /in flight/ });
    await handInFlight(w, run.task, run.card as unknown as ExperimentCard, 'no');
    await refused([A1_UNCAPPED], 'ATTEMPT_QUEUED', { match: /handed back, not taken into account yet/ });
    await w.advance();
    await hand(w, 'researcher-reader', blind(cardOf<ReaderCard>(w, 'researcher-reader')));
    await w.advance();
    assert.equal((await state(w)).phase, 'interpret');
    // the interpreter at work, then handed back (not taken into account yet), then its interpretation in
    const it = only(w, 'researcher-interpreter');
    w.scheduler.dispatchOf(it.task);
    await refused([A3], 'DISPATCH_IN_FLIGHT', { match: /interpreter .* at work/ });
    assert.deepEqual(await w.scheduler.run(it.task, { handBack: interpretation(it.card as unknown as InterpreterCard) }), []);
    await refused([A3], 'INTERPRETATION_SUBMITTED');
    await w.advance();
    assert.equal((await state(w)).phase, 'reasoning');
    await refused([A3], 'INTERPRETATION_SUBMITTED');
    // settled: the decision layer stopped it
    await recordExplorationRuling({ ledger: w.ledger, scheduler: w.scheduler }, M, w.x, { id: 'stop-it', decision: 'stop', findings: [], text: 'the PM stops it', extraRounds: 0, by: 'pm' });
    await advance(ctx, M);
    assert.notEqual((await state(w)).settled, null);
    await refused([A3], 'EXPLORATION_SETTLED', { match: /new id in the PM plan/ });
  });

  test('a: no method in force, not a research exploration, an interpreter dispatched before, a stopped exploration', async () => {
    const r = await world({ product: 'answer', research: true, question: 'Does the file lock survive a crash?', decision: { type: 'structure', text: 'which lock to use' } });
    await r.advance();
    await assert.rejects(pmAmendAttempts(r.ports.ctx, { mission: M, exploration: r.x, attempts: [A3], words: say(r, 'add a reading') }), /NO_METHOD: .*no method in force yet/);
    const d = await world({ exploration: 'E2' });
    await d.advance();
    await assert.rejects(pmAmendAttempts(d.ports.ctx, { mission: M, exploration: d.x, attempts: [A3], words: say(d, 'add a reading') }), /NO_METHOD: .*not a research exploration/);
    // an interpreter dispatched, its dispatch released (the step queued again): it read the records
    const { w, words } = await attemptsPhase();
    await bothRecorded(w);
    const it = only(w, 'researcher-interpreter');
    await w.scheduler.run(it.task, { release: 'abandoned' });
    assert.equal(w.scheduler.tasks.get(it.task)?.state, 'queued');
    await assert.rejects(pmAmendAttempts(w.ports.ctx, { mission: M, exploration: w.x, attempts: [A3], words }), /INTERPRETER_DISPATCHED: .*dispatched before/);
    // given up: stopped, the decision layer decides first
    await w.scheduler.run(it.task, { release: 'ended' });
    assert.equal(await w.scheduler.cancel(it.task), true);
    await w.advance();
    assert.equal((await state(w)).stopped?.reason, 'seat-abandoned');
    await assert.rejects(pmAmendAttempts(w.ports.ctx, { mission: M, exploration: w.x, attempts: [A3], words }), /EXPLORATION_STOPPED/);
    assert.equal(amendments(w).length, 0);
  });

  test('b: added in the attempts phase: a new method version in force at once, no round, no review; later cards name it; the answer resting on it is proven', async () => {
    const { w, words } = await attemptsPhase();
    const ctx = w.ports.ctx;
    const s0 = await state(w);
    const previous = s0.method!.version;
    const reading = only(w, 'researcher-reader');
    const experiment = only(w, 'constructor-experiment');
    const tasks0 = w.scheduler.tasks.size;

    const r = await pmAmendAttempts(ctx, { mission: M, exploration: w.x, attempts: [A3], words, reason: 'the cap left part of the domain unsearched' });
    const a3 = w.scheduler.queued('researcher-reader').find((t) => t.task !== reading.task)!;
    assert.deepEqual(r, {
      n: 1,
      previous,
      version: r.version,
      judgment: 'xpj.M1.E1.amend1',
      added: [{ attempt: 'A3', step: a3.task, evidence: (a3.card as unknown as ReaderCard).evidence.id }],
      replaced: [],
      unchanged: [],
      withdrawn: null,
      answers: null,
      phase: 'attempts',
      rounds: s0.rounds,
      allowedRounds: allowedRounds(s0),
    });
    assert.match(r.version, /^xpv\.M1\.E1\.amend1\.[0-9a-f]{16}$/);
    // the earlier runs are as they were; only the added attempt's run was queued, ready beside them
    assert.equal(w.scheduler.tasks.size, tasks0 + 1);
    assert.deepEqual(w.scheduler.queued('constructor-experiment').map((t) => t.task), [experiment.task]);
    assert.deepEqual((a3.card as unknown as ReaderCard).steps, A3.steps);
    assert.match(a3.handover?.step ?? '', new RegExp(`\\(attempt A3 added by the user's words ${words}\\)$`));
    assert.ok(!JSON.stringify(a3.card).includes('what the filesystem documents'), 'blind: no purpose on the card');
    const ready = readSteps(ctx).ready.filter((x) => x.mission === M);
    assert.deepEqual(ready.map((x) => x.step).sort(), [experiment.task, reading.task, a3.task].sort());
    assert.ok(ready.every((x) => x.parallel));
    // the method version in force: the previous document, the register amended, the user's section
    const s1 = await state(w);
    assert.equal(s1.method?.version, r.version);
    assert.equal(s1.version?.id, r.version);
    assert.deepEqual(s1.method?.attempts.map((a) => a.id), ['A1', 'A2', 'A3']);
    const doc = methodDoc(w, s1);
    assert.deepEqual(doc.attempts, [...ATTEMPTS, A3]);
    assert.ok(doc.method.startsWith('method v1\n\n## Amended by the user\'s words '), doc.method);
    assert.ok(doc.method.includes(`## Amended by the user's words ${words}\n\nReason: "the cap left part of the domain unsearched"\nAdded: A3\nReplaced: none`), doc.method);
    assert.deepEqual(amendments(w).map((b) => [b.n, b.previous, b.version, b.added, b.replaced, b.words, b.withdrawn, b.answers, b.by]), [[1, previous, r.version, ['A3'], [], words, [], null, 'pm']]);
    // no review: no author, attacker or Stabilizer was queued; passed by the user's judgment, proven at once
    assert.equal(w.scheduler.queued('researcher-author').length + w.scheduler.queued('crititor').length + w.scheduler.queued('stabilizer').length, 0);
    const j = (await w.ledger.records(['judgment'])).map((c) => c.record).find((x) => x.judgment === r.judgment)!;
    assert.deepEqual([j.executor, j.target, j.verdict, j.review], ['user', r.version, 'pass', 'crititor']);
    const obj = (await w.ledger.records(['object.version'])).map((c) => c.record).find((x) => x.object === r.version)!;
    assert.equal(obj.predecessor, previous);
    assert.equal((await w.evaluator.labels([r.version])).labels[r.version], 'proven');
    assert.deepEqual([s1.rounds, allowedRounds(s1), s1.rerunRounds], [s0.rounds, allowedRounds(s0), 0], 'no round spent, none added');

    // the phase moves on only once every attempt of the amended method has its record
    await bothRecorded(w);
    assert.equal((await state(w)).phase, 'attempts');
    assert.equal(w.scheduler.queued('researcher-interpreter').length, 0);
    await handReading(w, a3.task);
    const s2 = await state(w);
    assert.equal(s2.phase, 'interpret');
    // the interpreter's card names the amended version, with every attempt of its register
    const ic = cardOf<InterpreterCard>(w, 'researcher-interpreter');
    assert.equal(ic.method.version, r.version);
    assert.deepEqual(ic.attempts.map((a) => [a.id, a.evidence]), ['A1', 'A2', 'A3'].map((a) => [a, attemptEvidence(s2, a)]));
    assert.deepEqual(ic.newVersion.prerequisites, [r.version]);
    assert.deepEqual(ic.newVersion.reviews[0]?.reliesOn, [r.version]);
    await hand(w, 'researcher-interpreter', interpretation(ic));
    await w.advance();
    const cc = cardOf<CrititorCard>(w, 'crititor');
    assert.deepEqual(w.ledger.content.getList(cc.binding?.reliesOn as never), [r.version]);
    assert.equal(cc.round, s0.rounds + 1);
    await hand(w, 'crititor', attack());
    await w.advance();
    await hand(w, 'crititor', attack());
    const end = await w.advance();
    assert.equal(end.stopped?.reason, 'converged');
    const answer = cc.target as string;
    assert.equal((await w.evaluator.labels([answer])).labels[answer], 'proven', 'the answer rests on the amended method, proven');
    assert.deepEqual(buildHandoff(await state(w), 'converged', null).research?.amendments, [{ n: 1, version: r.version, words, reason: 'the cap left part of the domain unsearched', added: ['A3'], replaced: [] }]);
  });

  test('c: an unrecorded attempt replaced: the waiting run of its earlier card is withdrawn, its new card runs', async () => {
    const { w, words } = await attemptsPhase();
    const ctx = w.ports.ctx;
    const old = only(w, 'researcher-reader');
    const r = await pmAmendAttempts(ctx, { mission: M, exploration: w.x, attempts: [A2_WIDER], words });
    const fresh = only(w, 'researcher-reader');
    assert.notEqual(fresh.task, old.task);
    assert.deepEqual(r.replaced, [{ attempt: 'A2', replaces: null, withdrawn: old.task, step: fresh.task, evidence: (fresh.card as unknown as ReaderCard).evidence.id }]);
    assert.deepEqual(r.added, []);
    assert.equal(w.scheduler.tasks.get(old.task)?.state, 'abandoned', 'out of the queue');
    const s1 = await state(w);
    assert.equal(s1.consumed.get(old.task)?.kind, 'withdrawn');
    assert.deepEqual(amendments(w)[0]?.withdrawn, [old.task]);
    assert.deepEqual((fresh.card as unknown as ReaderCard).steps, A2_WIDER.steps);
    assert.deepEqual(s1.method?.attempts, [ATTEMPTS[0], A2_WIDER]);
    // the record of its new run is the one that counts
    await bothRecorded(w);
    const s2 = await state(w);
    assert.equal(s2.phase, 'interpret');
    assert.equal(attemptEvidence(s2, 'A2'), (fresh.card as unknown as ReaderCard).evidence.id);
    assert.equal(cardOf<InterpreterCard>(w, 'researcher-interpreter').attempts.find((a) => a.id === 'A2')?.evidence, (fresh.card as unknown as ReaderCard).evidence.id);
  });

  test('d: a recorded attempt replaced: its new card runs; the new record supersedes the earlier one, kept as history', async () => {
    const { w, words } = await attemptsPhase();
    const ctx = w.ports.ctx;
    const first = only(w, 'constructor-experiment');
    await hand(w, 'constructor-experiment', blind(first.card as unknown as ExperimentCard, 'no'), { runs: ['failed'] });
    await w.advance();
    const s0 = await state(w);
    const old = attemptEvidence(s0, 'A1')!;
    const reading = only(w, 'researcher-reader');
    const r = await pmAmendAttempts(ctx, { mission: M, exploration: w.x, attempts: [A1_UNCAPPED, ATTEMPTS[1]], words, reason: 'lift the cap' });
    const again = only(w, 'constructor-experiment');
    const c2 = again.card as unknown as ExperimentCard;
    assert.deepEqual(r.replaced, [{ attempt: 'A1', replaces: old, withdrawn: null, step: again.task, evidence: c2.evidence.id }]);
    assert.deepEqual(r.unchanged, ['A2']);
    assert.equal(only(w, 'researcher-reader').task, reading.task, 'the unchanged attempt keeps its run');
    // the new card: the amended steps and commands, blind as before
    assert.deepEqual([c2.steps, c2.commands, c2.assertions], [A1_UNCAPPED.steps, A1_UNCAPPED.commands, A1_UNCAPPED.assertions]);
    assert.equal(c2.evidence.attempt, 'A1');
    assert.match(again.handover?.step ?? '', new RegExp(`\\(attempt A1 replaced by the user's words ${words}, superseding ${old.replace(/\./g, '\\.')}\\)$`));
    assert.ok(!JSON.stringify(c2).includes('does the lock survive'), 'still blind');
    assert.match(methodDoc(w, await state(w)).method, new RegExp(`Replaced: A1 \\(its record ${old.replace(/\./g, '\\.')} superseded\\)`));
    // the reading's record does not move the phase on: A1's new record is not in yet
    await hand(w, 'researcher-reader', blind(reading.card as unknown as ReaderCard));
    await w.advance();
    assert.equal((await state(w)).phase, 'attempts');
    await hand(w, 'constructor-experiment', blind(c2));
    await w.advance();
    const s1 = await state(w);
    assert.equal(s1.phase, 'interpret');
    const fresh = attemptEvidence(s1, 'A1')!;
    assert.equal(fresh, c2.evidence.id);
    const ic = cardOf<InterpreterCard>(w, 'researcher-interpreter');
    assert.equal(ic.attempts.find((a) => a.id === 'A1')?.evidence, fresh);
    assert.ok(!ic.materials.some((m) => m.id === `evidence-${old}`), 'the earlier record is no material');
    // kept as history: in the state, in the ledger, and in the hand-off with what superseded it
    assert.equal(supersededAttemptRecord(s1, old), true);
    assert.ok((await w.ledger.records(['evidence'])).some((c) => c.record.evidence === old));
    assert.equal(buildHandoff(s1, 'converged', null).evidence.find((e) => e.id === old)?.supersededBy, fresh);
    assert.deepEqual([s1.rounds, allowedRounds(s1)], [s0.rounds, allowedRounds(s0)]);
  });

  test('e: from interpret: the queued interpreter is withdrawn, the exploration goes back to its attempts, then on', async () => {
    const { w, words } = await attemptsPhase();
    const ctx = w.ports.ctx;
    await bothRecorded(w);
    assert.equal((await state(w)).phase, 'interpret');
    const i1 = only(w, 'researcher-interpreter');
    const r = await pmAmendAttempts(ctx, { mission: M, exploration: w.x, attempts: [A3], words });
    assert.equal(r.withdrawn, i1.task);
    assert.equal(r.phase, 'attempts');
    assert.equal(w.scheduler.queued('researcher-interpreter').length, 0);
    assert.equal(w.scheduler.tasks.get(i1.task)?.state, 'abandoned');
    const s1 = await state(w);
    assert.equal(s1.consumed.get(i1.task)?.kind, 'withdrawn');
    assert.equal(s1.stopped, null);
    assert.deepEqual(amendments(w)[0]?.withdrawn, [i1.task]);
    assert.deepEqual(readSteps(ctx).ready.filter((x) => x.mission === M).map((x) => x.kind), ['researcher-reader']);
    await hand(w, 'researcher-reader', blind(cardOf<ReaderCard>(w, 'researcher-reader')));
    await w.advance();
    assert.equal((await state(w)).phase, 'interpret');
    const i2 = only(w, 'researcher-interpreter');
    assert.notEqual(i2.task, i1.task);
    const ic = i2.card as unknown as InterpreterCard;
    assert.equal(ic.method.version, r.version);
    assert.deepEqual(ic.attempts.map((a) => a.id), ['A1', 'A2', 'A3']);
  });

  test('f: --answers: the repair it answers adds no round and leaves the cards; refused when no such repair is open', async () => {
    const { w, words } = await attemptsPhase();
    const ctx = w.ports.ctx;
    const s0 = await state(w);
    const rep = await recordRepair(w.ports, { mission: M, words, kind: 'new-question', text: 'Search the whole domain', about: { kind: 'exploration', id: w.x } });
    await w.advance();
    const s1 = await state(w);
    assert.equal(s1.rerunRounds, 2, 'the repair added its round (and its closing attacker)');
    assert.equal(s1.phase, 'attempts', 'the author waits for the old attempts: what the amendment answers instead');
    await assert.rejects(pmAmendAttempts(ctx, { mission: M, exploration: w.x, attempts: [A3], words, answers: 'R-9' }), /REPAIR_NOT_OPEN: no repair R-9 is about exploration E1 \(open: R-1\)/);
    const r = await pmAmendAttempts(ctx, { mission: M, exploration: w.x, attempts: [A3], words, answers: rep.id });
    assert.equal(r.answers, rep.id);
    const s2 = await state(w);
    assert.deepEqual([s2.rerunRounds, allowedRounds(s2)], [0, allowedRounds(s0)], 'its round is taken back');
    assert.equal(s2.answeredRepairs.get(rep.id), 1);
    assert.equal(amendments(w)[0]?.answers, rep.id);
    const resolved = (await repairsOf(flowCtx(w.ports, M))).find((x) => x.id === rep.id);
    assert.deepEqual([resolved?.state, resolved?.answeredBy], ['answered', { exploration: w.x, amendment: 1, words }]);
    await assert.rejects(pmAmendAttempts(ctx, { mission: M, exploration: w.x, attempts: [A2_WIDER], words, answers: rep.id }), /REPAIR_NOT_OPEN: repair R-1 is answered already, by the user's amendment 1/);
    // the cards from now on: no open added question
    await bothRecorded(w);
    await handReading(w, only(w, 'researcher-reader').task);
    const ic = cardOf<InterpreterCard & { repairs?: unknown[] }>(w, 'researcher-interpreter');
    assert.equal(ic.repairs, undefined);
    await hand(w, 'researcher-interpreter', interpretation(ic));
    await w.advance();
    assert.equal(cardOf<CrititorCard & { repairs?: unknown[] }>(w, 'crititor').repairs, undefined);
  });

  test('f: --answers is refused once the repair\'s round started: an author step was dispatched for it', async () => {
    const w = await world({ product: 'answer', research: true, question: 'Does the file lock survive a crash?', decision: { type: 'structure', text: 'which lock to use' }, readingNetwork: [URL] });
    await w.advance();
    await hand(w, 'researcher-author', submit('method v1', [], { attempts: ATTEMPTS }));
    await w.advance();
    const words = say(w, 'Search the whole domain.');
    const rep = await recordRepair(w.ports, { mission: M, words, kind: 'new-question', text: 'Search the whole domain', about: { kind: 'exploration', id: w.x } });
    await hand(w, 'crititor', attack([finding('serious', 'internal contradiction', 'the cap leaves cases out')]));
    await w.advance();
    const author = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(author.repairs?.[0]?.id, rep.id, 'the round the repair added: its author answers it');
    await hand(w, 'researcher-author', submit('method v2', reviseAll(author), { attempts: ATTEMPTS }));
    await w.advance();
    await hand(w, 'crititor', attack([], recheckAll(cardOf<CrititorCard>(w, 'crititor'), 'yes')));
    await w.advance();
    assert.equal((await state(w)).phase, 'attempts');
    await assert.rejects(pmAmendAttempts(w.ports.ctx, { mission: M, exploration: w.x, attempts: [A3], words, answers: rep.id }), /REPAIR_STARTED: the round repair R-1 added has started: the author step \S+ was dispatched for it/);
    assert.equal(amendments(w).length, 0);
    // without --answers the user's decision is applied
    assert.equal((await pmAmendAttempts(w.ports.ctx, { mission: M, exploration: w.x, attempts: [A3], words })).answers, null);
  });

  describe('g: the command line', () => {
    const p = gitProject();
    after(() => p.cleanup());
    test('listed with its usage; --file and --words required; a refusal names its code', async () => {
      await cli(p.dir, ['init']);
      await cli(p.dir, ['pm', 'say', 'Read the filesystem documentation too.']);
      const dir = mkdtempSync(join(tmpdir(), 'mp-amend-'));
      const file = join(dir, 'attempts.json');
      writeFileSync(file, JSON.stringify([A3]));
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '[{');
      assert.match((await cli(p.dir, ['pm', '--help'])).out, /mp pm amend-attempts/);
      const usage = await cli(p.dir, ['help', 'pm', 'amend-attempts']);
      assert.equal(usage.code, 0);
      assert.ok(usage.out.includes('mp pm amend-attempts <mission> <exploration> --words W-<n> --file <attempts.json> [--answers R-<n>] [--reason "<text>"]'), usage.out);
      assert.equal((await cli(p.dir, ['pm', 'amend-attempts', 'm1', 'X1', '--words', 'W-1'])).code, 64, '--file required');
      assert.equal((await cli(p.dir, ['pm', 'amend-attempts', 'm1', 'X1', '--file', file])).code, 64, '--words required');
      assert.equal((await cli(p.dir, ['pm', 'amend-attempts', 'm1', 'X1', '--words', 'W-1', '--file', bad])).code, 64, 'a file that is not JSON');
      assert.equal((await cli(p.dir, ['pm', 'amend-attempts', 'm1', 'X1', '--words', 'W-1', '--file', file, '--answers', 'repair-1'])).code, 64, '--answers names R-<n>');
      const r = await cli(p.dir, ['pm', 'amend-attempts', 'm1', 'X1', '--words', 'W-1', '--file', file, '--reason', 'the rest of the domain', '--json']);
      assert.equal(r.code, 3, r.out);
      assert.equal(r.json.error.code, 'NOT_ALLOWED');
      assert.match(r.json.error.message, /no exploration X1/);
    });
  });

  describe('h: through mp: the command, the reads, the proof', () => {
    const p = processProject();
    after(() => p.cleanup());
    test('the user\'s decision applied with mp pm amend-attempts; show exploration and status say so; the answer is proven on the amended method', async () => {
      const ctx = p.ctx;
      const m = 'm1' as MissionId;
      pmMission(ctx, m);
      const w1 = pmSay(ctx, 'Find out whether the lock survives a crash, with nothing left unread. The details are yours to decide.').words;
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
              exploration: { id: 'X1', deliverable: 'the answer', fuzzyGoal: { quote: 'nothing left unread', words: w1 }, attackScope: ['unsupported conclusion'], decision: { id: 'D1', type: 'structure' }, budget: { rounds: 3, micros: null }, stop: '', research: true, readingNetwork: [URL] },
              after: [],
              items: [],
            },
          ],
          goalsBeyond: [],
          authorizations: ['a1'],
        },
      });
      await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
      const readings: RegisteredAttemptT[] = [{ ...ATTEMPTS[1]!, id: 'R1' }];
      await step(ctx, 'researcher-author', () => submit('method: read what the kernel documents', [], { attempts: readings }));
      await step(ctx, 'crititor', () => attack());
      await step(ctx, 'stabilizer', (c: StabilizerCard) => stabilizeAll(c));
      // the method is in force, its reading queued; the user decides to read the filesystem documentation too
      const w2 = pmSay(ctx, 'Read the filesystem documentation too, so nothing is left unread.').words;
      const dir = mkdtempSync(join(tmpdir(), 'mp-amend-'));
      const file = join(dir, 'attempts.json');
      writeFileSync(file, JSON.stringify([{ ...A3, id: 'R2' }], null, 2));
      const out = await cli(p.dir, ['pm', 'amend-attempts', m, 'X1', '--words', w2, '--file', file, '--reason', 'nothing left unread', '--json']);
      assert.equal(out.code, 0, out.err);
      const r = out.json.result as { version: string; judgment: string; added: Array<{ attempt: string; step: string }>; phase: string };
      assert.deepEqual([r.added.map((a) => a.attempt), r.phase], [['R2'], 'attempts']);
      const text = await cli(p.dir, ['pm', 'amend-attempts', m, 'X1', '--words', w2, '--file', file]);
      assert.equal(text.code, 3, 'the same file again changes nothing');
      assert.match(text.err + text.out, /NOTHING_AMENDED/);
      // the reads
      const shown = await cli(p.dir, ['read', 'show', 'exploration', `${m}/X1`]);
      assert.equal(shown.code, 0, shown.err);
      assert.ok(shown.out.includes(`attempts amended by ${w2} (amendment 1): added R2 [its record not in yet], replaced none; method ${r.version} in force (the user's judgment ${r.judgment}, no review); reason: nothing left unread`), shown.out);
      const status = await cli(p.dir, ['read', 'status']);
      assert.ok(status.out.includes(`attempts amended by ${w2}: added R2, replaced none`), status.out);
      const obj = await cli(p.dir, ['read', 'show', 'object', r.version, '--json']);
      assert.equal(obj.json.result.items[0].node.state, 'proven');
      const why = await cli(p.dir, ['read', 'why', r.version]);
      assert.equal(why.code, 0, why.err);
      assert.ok(why.out.includes(`state: proven · by: the user (${w2}), applied by the PM via \`mp pm amend-attempts\``), why.out);
      assert.ok(why.out.includes(`the user decided in: words ${w2}`), why.out);
      // the readings run (side by side), the answer is interpreted and attacked: proven on the amended method
      const ready = (await pmNext(ctx)).ready.filter((x) => x.kind === 'researcher-reader');
      assert.deepEqual(ready.map((x) => x.step).includes(r.added[0]!.step), true);
      assert.equal(ready.length, 2);
      for (const x of ready) {
        const d = pmDispatch(ctx, x.step, { filledBy: 'test-harness/scripted' });
        readAll(ctx, d.dispatch);
        assert.equal((await handBack(ctx, d.dispatch, blind(dispatchView(ctx, d.dispatch).card as unknown as ReaderCard))).kind, 'recorded');
      }
      await step(ctx, 'researcher-interpreter', (c: InterpreterCard) => {
        assert.equal(c.method.version, r.version);
        return interpretation(c);
      });
      await step(ctx, 'crititor', () => attack());
      await step(ctx, 'stabilizer', (c: StabilizerCard) => stabilizeAll(c));
      await step(ctx, 'crititor', () => attack());
      await step(ctx, 'stabilizer', (c: StabilizerCard) => stabilizeAll(c));
      assert.equal((await cli(p.dir, ['pm', 'next'])).code, 0);
      const json = await cli(p.dir, ['read', 'show', 'exploration', `${m}/X1`, '--json']);
      const x = json.json.result[0];
      assert.equal(x.settled.body.outcome, 'conclusion');
      assert.equal(x.method, r.version);
      const answer = await cli(p.dir, ['read', 'show', 'object', x.settled.body.artifact, '--json']);
      assert.equal(answer.json.result.items[0].node.state, 'proven');
    });
  });
});
