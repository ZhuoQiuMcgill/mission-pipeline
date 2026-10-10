// Async evidence in an exploration (design 4.3 取证, 6.2 异步取证, 8.2, WI-17): a seat hands back
// "needs evidence", its turn ends, the evidence runs blind as its own unit, and the seat's session
// is resumed with the results; a rebuttal then names the evidence execution and the attacker
// confirms it covers the counterexample. Failed runs get their record from the program.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { ExperimentCard } from '../src/seat/cards/experiment.ts';
import type { AuthorCard, ReaderCard } from '../src/seat/cards/researcher.ts';
import { explorationState } from '../src/flow/exploration/flow.ts';
import { M, attack, blind, cardOf, finding, hand, only, recheckAll, submit, world } from './flow-exploration-fixtures.ts';

const REQUEST = { steps: ['run `node probe.js` with the lost-run fixture', 'read the result record'], data: 'fixture: lost-run.json', measure: ['result status'], assertions: ['the result status is "failed", not missing'] };

describe('exploration evidence', () => {
  test('author asks for evidence → blind run → resumed session → rebuttal confirmed by the attacker', async () => {
    const w = await world();
    await w.advance();
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    hand(w, 'crititor', attack([finding('serious', 'silently leaves an error behind', 'a lost run leaves no record')]));
    await w.advance();

    // the author asks for evidence: its turn ends, nothing of its own is running
    const authorTask = only(w, 'researcher-author');
    w.scheduler.run(authorTask.task, { evidence: REQUEST, sessionId: 'sess-author-1' });
    await w.advance();
    assert.equal(w.scheduler.queued('researcher-author').length, 0, 'the author holds nothing while the evidence runs');
    const ex = cardOf<ExperimentCard>(w, 'constructor-experiment');
    assert.deepEqual(ex.steps, REQUEST.steps);
    assert.deepEqual(ex.assertions, REQUEST.assertions);
    assert.equal(ex.evidence.id, 'xpe.M1.E1.1');
    assert.equal(ex.evidence.attempt, null);
    const exTask = only(w, 'constructor-experiment');
    assert.equal(exTask.lineage, 'xp.M1.E1.ev1', 'an evidence run is its own unit and lineage');
    // blind: nothing of the author's reasoning, the findings or the goal is on the executor's card
    const text = JSON.stringify(ex);
    assert.ok(!text.includes('lost run leaves no record'));
    assert.ok(!text.includes('nothing that gets stuck'));
    hand(w, 'constructor-experiment', blind(ex, 'yes'));
    await w.advance();

    // the author's session is resumed with the results; the waiting task was superseded
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(a.resume?.sessionId, 'sess-author-1');
    assert.match(a.resume?.evidence ?? '', /xpe\.M1\.E1\.1 \(completed\).*#1 holds/);
    assert.equal(w.scheduler.tasks.get(authorTask.task)?.state, 'abandoned');
    assert.equal(a.evidence[0]?.id, 'xpe.M1.E1.1');
    const ev = (await w.ledger.records(['evidence'])).map((c) => c.record);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]?.fields['assertion:1'], 'yes');
    assert.equal(ev[0]?.runClass, 'open');

    hand(w, 'researcher-author', submit('', [{ finding: a.openFindings[0]?.id as string, action: 'rebut', note: 'the run shows the record', evidence: 'xpe.M1.E1.1' }]));
    await w.advance();
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c.priorFindings[0]?.disposition?.evidence, 'xpe.M1.E1.1');
    hand(w, 'crititor', attack([], recheckAll(c, 'yes', ['xpe.M1.E1.1'])));
    await w.advance();
    // the judgment relies on the evidence execution it cited
    const j = (await w.ledger.records(['judgment'])).map((x) => x.record).at(-1);
    assert.equal(j?.verdict, 'pass');
    assert.deepEqual(w.ledger.content.getList(j?.evidence as never), ['xpe.M1.E1.1']);
    assert.equal(j?.revokes, 'xpj.M1.E1.2', 'the same version was negated in round 1');
    hand(w, 'crititor', attack());
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    assert.equal((await w.evaluator.labels([c.target as string])).labels[c.target as string], 'proven');
  });

  test('the attacker asks for a reading; a given-up run is recorded by the program and the attacker resumes', async () => {
    const w = await world({ evidenceExecutor: 'reading', readingNetwork: ['https://docs.example.org'] });
    await w.advance();
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    const atk = only(w, 'crititor');
    w.scheduler.run(atk.task, { evidence: { ...REQUEST, steps: ['read the vendor documentation on retries'] }, sessionId: 'sess-atk' });
    await w.advance();
    const rd = cardOf<ReaderCard>(w, 'researcher-reader');
    assert.deepEqual(rd.network.allowed, ['https://docs.example.org']);
    assert.ok(rd.capabilities.includes('net'));
    // the reading fails and is given up (the scheduler's WI-15 path, then the Secretary or PM)
    const rt = only(w, 'researcher-reader');
    w.scheduler.run(rt.task, { fail: 'seat-failure' });
    await w.advance();
    assert.equal(w.scheduler.queued('crititor').length, 0, 'waits while the failed run needs a disposition');
    await w.scheduler.cancel(rt.task);
    await w.advance();
    const ev = (await w.ledger.records(['evidence'])).map((c) => c.record);
    assert.equal(ev[0]?.fields['status'], 'failed', 'the program generates the record of a failed run (8.2)');
    assert.equal(ev[0]?.fields['measure:result status'], undefined, 'no measurement is asked of a failed run');
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c.resume?.sessionId, 'sess-atk');
    assert.match(c.resume?.evidence ?? '', /failed/);
    assert.equal(c.evidence[0]?.status, 'failed');
    assert.equal(c.binding?.judgment, `xpj.M1.E1.${(await explorationState(w, M, w.x)).seq}`);
  });

  test('no session to resume (WI-17): a new session from the ledger material, and the PM is told', async () => {
    const w = await world();
    await w.advance();
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    hand(w, 'crititor', attack([finding('serious', 'internal contradiction', 'x')]));
    await w.advance();
    const t = only(w, 'researcher-author');
    w.scheduler.run(t.task, { evidence: REQUEST, sessionId: '' });
    // the fake keeps '' as "no session id"
    const tk = w.scheduler.tasks.get(t.task);
    if (tk?.handBack) tk.handBack = { ...tk.handBack, sessionId: null };
    await w.advance();
    hand(w, 'constructor-experiment', blind(cardOf<ExperimentCard>(w, 'constructor-experiment')));
    await w.advance();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(a.resume, undefined);
    assert.equal(a.openFindings.length, 1, 'the facts are on the card');
    assert.equal(a.evidence.length, 1);
    const n = w.ledger.notices.find((x) => x.category === 'exploration-recovery-state-missing');
    assert.equal(n?.wi, 'WI-17');
  });
});

describe('exploration evidence: edge cases', () => {
  test('an unreadable evidence request is recorded as not run by the program, and the requester resumes', async () => {
    const w = await world();
    await w.advance();
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    const t = only(w, 'crititor');
    w.scheduler.run(t.task, { evidence: REQUEST, sessionId: 'sess-x' });
    const tk = w.scheduler.tasks.get(t.task);
    if (tk?.handBack) tk.handBack = { ...tk.handBack, evidenceRequest: w.ledger.content.put('not json') as never };
    await w.advance();
    assert.equal(w.scheduler.queued('constructor-experiment').length, 0, 'no executor for an unreadable request');
    const ev = (await w.ledger.records(['evidence'])).map((c) => c.record);
    assert.equal(ev[0]?.fields['status'], 'not-run');
    const c = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c.resume?.sessionId, 'sess-x');
    assert.match(c.resume?.evidence ?? '', /not-run/);
  });

  test('a task the scheduler lost is submitted again from the card the ledger kept', async () => {
    const w = await world();
    await w.advance();
    const t = only(w, 'researcher-author');
    w.scheduler.tasks.delete(t.task);
    await w.advance();
    const again = only(w, 'researcher-author');
    assert.equal(again.task, t.task);
    assert.deepEqual(again.card, t.card);
  });
});

describe('exploration evidence: the per-turn cap (6.5)', () => {
  test('past the cap a request is recorded as not run (WI-08) and the seat resumes', async () => {
    const w = await world({ evidencePerTurn: 1 });
    await w.advance();
    const t1 = only(w, 'researcher-author');
    w.scheduler.run(t1.task, { evidence: REQUEST, sessionId: 's1' });
    await w.advance();
    hand(w, 'constructor-experiment', blind(cardOf<ExperimentCard>(w, 'constructor-experiment')));
    await w.advance();
    const t2 = only(w, 'researcher-author');
    w.scheduler.run(t2.task, { evidence: REQUEST, sessionId: 's1' });
    await w.advance();
    assert.equal(w.scheduler.queued('constructor-experiment').length, 0, 'no second run in the same turn');
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    assert.match(a.resume?.evidence ?? '', /not run: this turn already asked/);
    assert.equal(w.ledger.notices.find((n) => n.category === 'exploration-evidence-cap')?.wi, 'WI-08');
    // a hand-back ends the turn: the next turn may ask again
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    w.scheduler.run(only(w, 'crititor').task, { evidence: REQUEST, sessionId: 's2' });
    await w.advance();
    assert.equal(w.scheduler.queued('constructor-experiment').length, 1);
  });
});

describe('exploration evidence: the attacker reads the rebuttal\'s evidence', () => {
  test('the report of an evidence execution that rebuts a finding is a must-read material, with the steps that were run', async () => {
    const w = await world();
    await w.advance();
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    hand(w, 'crititor', attack([finding('serious', 'silently leaves an error behind', 'x')]));
    await w.advance();
    w.scheduler.run(only(w, 'researcher-author').task, { evidence: REQUEST, sessionId: 's' });
    await w.advance();
    hand(w, 'constructor-experiment', blind(cardOf<ExperimentCard>(w, 'constructor-experiment')));
    await w.advance();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    hand(w, 'researcher-author', submit('', [{ finding: a.openFindings[0]?.id as string, action: 'rebut', note: 'see the run', evidence: 'xpe.M1.E1.1' }]));
    await w.advance();
    const c = cardOf<CrititorCard>(w, 'crititor');
    const m = c.materials.find((x) => x.id === 'evidence-xpe.M1.E1.1');
    assert.equal(m?.mustRead, true);
    const report = JSON.parse(w.ledger.content.get(m?.ref as string)) as { asked: { steps: string[]; assertions: string[] } };
    assert.deepEqual(report.asked.steps, REQUEST.steps);
    assert.deepEqual(report.asked.assertions, REQUEST.assertions);
  });
});
