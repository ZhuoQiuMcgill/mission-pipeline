// 4.1.3 compatibility (item 6 of card P2): the field's memory holds the events of its branch
// (4.1.2 plus its pull requests #18, #20, #29, #32). 4.1.3 reads them as they are, with no
// migration:
//   a  attempts-amended, attempt-rerun and resnapshotted written by the field's code path (no
//      repair, no `answers` on the last two): the same shapes, folded as before, no repair answered
//   b  answered findings and the `.revision` pass (#20), as the field's hand-back recorded them
//   c  a grant's extend ruling without instructions or findings: on no card, the turn unchanged
//   d  a budget stop an older engine recorded on a round the one rule ends (it waited for a closing
//      attacker): a grant converges it at once, never a stuck state
//   e  a repair recorded before 4.1.3 (no authorTurn) in the attempts phase: rounds added, the
//      attempts phase kept, as before

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { flowCtx } from '../src/flow/context.ts';
import { explorationState, recordExplorationRerun, recordExplorationRuling } from '../src/flow/exploration/flow.ts';
import { ATTEMPT_RERUN, ATTEMPTS_AMENDED, RESNAPSHOTTED, allowedRounds, decide, fold, type XEvent } from '../src/flow/exploration/machine.ts';
import { explorationLine, repairRef } from '../src/flow/plandoc.ts';
import { repairsOf } from '../src/flow/repair.ts';
import { pmAmendAttempts, pmRerunAttempt, pmResnapshotExploration } from '../src/process/index.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { ExperimentCard } from '../src/seat/cards/experiment.ts';
import type { AuthorCard, RegisteredAttemptT } from '../src/seat/cards/researcher.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import { say } from './flow-memory-fixtures.ts';
import { M, RUN_PLACEHOLDER, attack, blind, cardOf, finding, hand, only, recheckAll, reviseAll, stabilizeAll, submit, world, type World } from './flow-exploration-fixtures.ts';

const URL = 'https://docs.example.org/';
const A1: RegisteredAttemptT = { id: 'A1', kind: 'experiment', purpose: 'p', steps: ['run it'], data: '', measure: ['n'], assertions: ['holds'], commands: [{ id: 'step', command: 'sh run.sh' }] };
const A2: RegisteredAttemptT = { id: 'A2', kind: 'reading', purpose: 'q', steps: ['read it'], data: URL, measure: ['stated'], assertions: [] };

async function attemptsPhase(): Promise<World> {
  const w = await world({ product: 'answer', research: true, question: 'Does it hold?', decision: { type: 'structure', text: 'which' }, readingNetwork: [URL], rounds: 3 });
  await w.advance();
  await hand(w, 'researcher-author', submit('method v1', [], { attempts: [A1, A2] }));
  await w.advance();
  await hand(w, 'crititor', attack());
  await w.advance();
  return w;
}

async function events(w: World): Promise<XEvent[]> {
  return (await w.ledger.events({ mission: M, line: explorationLine(w.x) })).map((e) => ({ event: e.event, key: e.key, body: e.body }));
}

const bodyOf = async (w: World, event: string): Promise<Record<string, unknown>> => (await events(w)).find((e) => e.event === event)!.body as Record<string, unknown>;

describe('a: the field\'s change events, as its code path wrote them', () => {
  test('attempts-amended (answers null, no repair), attempt-rerun and resnapshotted (no answers): the same shapes, folded as before', async () => {
    const w = await attemptsPhase();
    const words = say(w, 'Read the errata too.');
    await pmAmendAttempts(w.ports.ctx, { mission: M, exploration: w.x, attempts: [{ ...A2, steps: ['read it', 'read the errata'] }], words });
    const amended = await bodyOf(w, ATTEMPTS_AMENDED);
    assert.deepEqual(Object.keys(amended).sort(), ['added', 'answers', 'attempts', 'by', 'content', 'judgment', 'n', 'previous', 'reason', 'replaced', 'replaces', 'version', 'withdrawn', 'words']);
    assert.equal(amended['answers'], null);
    const run = only(w, 'constructor-experiment');
    const r = w.scheduler.rerun(w.scheduler.dispatchOf(run.task), 'step', false);
    assert.deepEqual(await w.scheduler.run(run.task, { handBack: JSON.parse(JSON.stringify(blind(run.card as unknown as ExperimentCard, 'no')).split(RUN_PLACEHOLDER).join(`run:${r}`)) }), []);
    await w.advance();
    await pmRerunAttempt(w.ports.ctx, { mission: M, exploration: w.x, attempts: ['A1'], words });
    assert.deepEqual(Object.keys(await bodyOf(w, ATTEMPT_RERUN)).sort(), ['attempts', 'by', 'n', 'reason', 'replaces', 'withdrawn', 'words']);
    w.scheduler.knobs.actions = { snapshot: async () => ({ path: 'abc123', commit: 'abc123', products: [] }) };
    // the queued runs wait in the queue (no seat holds one): the PM's word takes the snapshot again
    await pmResnapshotExploration(w.ports.ctx, { mission: M, exploration: w.x, words });
    assert.deepEqual(Object.keys(await bodyOf(w, RESNAPSHOTTED)).sort(), ['by', 'envSnapshot', 'n', 'previous', 'snapshot', 'step', 'words']);
    const s = await explorationState(w, M, w.x);
    assert.deepEqual([s.amendments.length, s.attemptReruns.has('A1'), s.resnapshots.length, s.defined?.snapshot.commit], [1, true, 1, 'abc123']);
    assert.deepEqual(await repairsOf(flowCtx(w.ports, M)), [], 'no repair recorded or answered by the field\'s path');
  });
});

describe('b: answered findings and the .revision pass (#20)', () => {
  test('a stabilized hand-back with answered:true and a revision folds resolved, answered, converged', async () => {
    const w = await world({ rounds: 1 });
    w.autoStabilize = false;
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'gets stuck', 'waits')]));
    await w.advance();
    await hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    await w.advance();
    const card = cardOf<StabilizerCard>(w, 'stabilizer');
    const r = stabilizeAll(card);
    assert.deepEqual(await w.scheduler.run(only(w, 'stabilizer').task, { handBack: { ...r, findings: r.findings.map((x) => ({ ...x, answered: true })) } }), []);
    assert.equal((await w.advance()).stopped?.reason, 'converged');
    const ev = (await events(w)).find((e) => e.event === 'consumed' && (e.body as { kind: string }).kind === 'stabilized')!.body as { findings: Array<{ answered?: true }>; revision?: { judgment: string } };
    assert.equal(ev.findings[0]?.answered, true);
    assert.match(ev.revision?.judgment ?? '', /\.revision$/);
    // fold the field's events again: the same state
    const s = fold(await events(w));
    assert.deepEqual([...s.findings.values()].map((f) => [f.status, f.answered]), [['resolved', 1]]);
  });
});

describe('c: a grant without instructions or findings', () => {
  test('extend with findings [] and no instructions: on no card, the next turn as it was', async () => {
    const w = await world({ rounds: 1 });
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack([finding('serious', 'gets stuck', 'waits')]));
    await w.advance();
    await hand(w, 'researcher-author', submit('v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author'))));
    assert.equal((await w.advance()).stopped?.reason, 'budget-exhausted');
    // the body the field's step wrote: { id, decision: 'extend', findings: [], text, extraRounds, extraMicros, by }
    await recordExplorationRuling(w, M, w.x, { id: 'xp.M1.E1.stop1', decision: 'extend', findings: [], text: 'one more round', extraRounds: 1, extraMicros: 0, by: 'secretary' });
    await w.advance();
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.deepEqual(c.rulings, []);
    await hand(w, 'crititor', attack([], recheckAll(c, 'yes')));
    assert.equal((await w.advance()).stopped?.reason, 'converged');
  });
});

describe('d: a budget stop an older engine recorded on a round the one rule ends', () => {
  test('a continuing attacker\'s pass the older engine stopped as budget-exhausted (waiting for a closing attacker): a grant converges it, no closing attacker', async () => {
    const w = await world({ rounds: 1 });
    await w.advance();
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    await hand(w, 'crititor', attack());
    assert.equal((await w.advance()).stopped?.reason, 'converged');
    // the same events as the older engine recorded them: the stop was budget-exhausted
    const evs = await events(w);
    const i = evs.findIndex((e) => e.event === 'stopped');
    const version = (evs[i]!.body as { version: string }).version;
    const older: XEvent[] = [...evs.slice(0, i), { event: 'stopped', key: '1', body: { n: 1, reason: 'budget-exhausted', wi: 'WI-08', handoff: 'h', version } }];
    assert.deepEqual(decide(fold(older)), { kind: 'none', why: 'stopped (budget-exhausted)' });
    const granted = [...older, { event: 'ruling', key: 'g', body: { id: 'g', decision: 'extend', findings: [], text: 'one more', extraRounds: 1, by: 'secretary' } }];
    assert.deepEqual(decide(fold(granted)), { kind: 'stop', reason: 'converged', wi: null });
    // and the older engine's closing attacker, if it was queued after the grant: its round runs as any round
    const queued = { event: 'queued', key: '9', body: { ...(evs.find((e) => e.event === 'queued' && (e.body as { role: string }).role === 'attacker')!.body as object), n: 9, task: 'xp.M1.E1.9.attacker', fresh: true } };
    const s = fold([...granted, queued]);
    assert.deepEqual([s.turn, s.stopped, decide(s).kind], ['none', null, 'none']);
  });
});

describe('e: a repair recorded before 4.1.3', () => {
  test('in the attempts phase, without authorTurn: two rounds added, the attempts phase kept, no author turn', async () => {
    const w = await attemptsPhase();
    const before = await explorationState(w, M, w.x);
    await recordExplorationRerun(w, M, w.x, { evidence: [], environment: 'repair:R-1', repair: repairRef({ id: 'R-1', words: 'W-1', kind: 'new-question', text: 'more', about: { kind: 'exploration', id: w.x } }) });
    const s = await explorationState(w, M, w.x);
    assert.deepEqual([s.phase, s.turn, s.reentry, allowedRounds(s) - allowedRounds(before), s.authorTurns.size], ['attempts', 'none', null, 2, 0]);
    await w.advance();
    assert.equal(w.scheduler.queued('researcher-author').length, 0);
  });
});
