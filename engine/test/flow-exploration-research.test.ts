// Research explorations (design 4.3, 8.2): the method and its attempt register are attacked first;
// the registered attempts run blind as separate units (a failed one recorded by the program);
// an interpreter who took part in nothing writes the interpretation, which must cite every
// registered attempt; the attack then targets the reasoning, and a key conclusion that does not
// stand makes the exploration "no conclusion" (accepted by the user, 3.10).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { ExperimentCard } from '../src/seat/cards/experiment.ts';
import type { AuthorCard, InterpreterCard, InterpreterResult, ReaderCard, RegisteredAttemptT } from '../src/seat/cards/researcher.ts';
import { explorationHandoffs } from '../src/flow/exploration/flow.ts';
import { M, attack, blind, cardOf, finding, hand, only, recheckAll, reviseAll, submit, world } from './flow-exploration-fixtures.ts';

const ATTEMPTS: RegisteredAttemptT[] = [
  { id: 'A1', kind: 'experiment', purpose: 'does the lock survive a crash', steps: ['run crash.sh 20 times'], data: '', measure: ['survivals'], assertions: ['all 20 survive'] },
  { id: 'A2', kind: 'reading', purpose: 'what the kernel documents', steps: ['read Documentation/locking.txt'], data: '', measure: ['guarantee stated'], assertions: [] },
];

function interpretation(card: InterpreterCard, keyStanding: 'standing' | 'not-standing', dispositions: InterpreterResult['dispositions'] = []): InterpreterResult {
  return {
    answer: 'the lock survives crashes',
    conclusions: [
      { id: 'C1', text: 'survives in practice', cites: ['A1'], standing: keyStanding, key: true },
      { id: 'C2', text: 'documented', cites: [card.attempts.find((a) => a.id === 'A2')?.evidence ?? 'A2'], standing: 'standing', key: false },
    ],
    message: 'first interpretation',
    dispositions,
  };
}

describe('research exploration', () => {
  test('method attacked first; attempts blind; interpretation cites every record; reasoning attacked; no conclusion when the key answer does not stand', async () => {
    const w = await world({ product: 'answer', research: true, question: 'Does the file lock survive a crash?', decision: { type: 'structure', text: 'which lock to use' } });
    await w.advance();
    const a1 = cardOf<AuthorCard>(w, 'researcher-author');
    assert.equal(a1.registerAttempts, true);
    assert.equal(a1.exploration.focus, 'method');
    // a method without its register is refused
    assert.ok(w.scheduler.run(only(w, 'researcher-author').task, { handBack: submit('method v1') }).some((p) => p.includes('registers at least one attempt')));
    hand(w, 'researcher-author', submit('method v1', [], { attempts: ATTEMPTS.slice(0, 1) }));
    await w.advance();
    const c1 = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c1.exploration.focus, 'method');
    hand(w, 'crititor', attack([finding('serious', 'method', 'no reading of the documented guarantee')]));
    await w.advance();
    hand(w, 'researcher-author', submit('method v2', reviseAll(cardOf<AuthorCard>(w, 'researcher-author')), { attempts: ATTEMPTS }));
    await w.advance();
    hand(w, 'crititor', attack([], recheckAll(cardOf<CrititorCard>(w, 'crititor'), 'yes')));
    await w.advance();

    // the method passed: both registered attempts run blind, side by side, without a closing attacker
    assert.equal(w.scheduler.queued('crititor').length, 0);
    const ex = cardOf<ExperimentCard>(w, 'constructor-experiment');
    const rd = cardOf<ReaderCard>(w, 'researcher-reader');
    assert.equal(ex.evidence.attempt, 'A1');
    assert.equal(rd.evidence.attempt, 'A2');
    assert.ok(!JSON.stringify(ex).includes('does the lock survive'), 'the purpose is not on the blind card');
    hand(w, 'constructor-experiment', blind(ex, 'no'));
    // the reading is given up: the program records it as failed (8.2)
    const rt = only(w, 'researcher-reader');
    w.scheduler.run(rt.task, { fail: 'seat-failure' });
    await w.scheduler.cancel(rt.task);
    await w.advance();

    // a fresh interpreter, no evidence tool
    const ic = cardOf<InterpreterCard>(w, 'researcher-interpreter');
    assert.equal(ic.allowAsyncEvidence, undefined);
    assert.deepEqual(ic.attempts.map((a) => [a.id, a.status]), [
      ['A1', 'completed'],
      ['A2', 'failed'],
    ]);
    assert.equal(ic.current, null);
    // every registered attempt must be cited
    const missingCite = { ...interpretation(ic, 'standing'), conclusions: [{ id: 'C1', text: 'x', cites: ['A1'], standing: 'standing' as const, key: true }] };
    assert.ok(w.scheduler.run(only(w, 'researcher-interpreter').task, { handBack: missingCite }).some((p) => p.includes('"A2" is not cited')));
    hand(w, 'researcher-interpreter', interpretation(ic, 'standing'));
    await w.advance();
    const c3 = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(c3.exploration.focus, 'reasoning');
    assert.equal(c3.fresh, false);
    assert.deepEqual(c3.priorFindings, [], 'the method findings are not the reasoning attacker\'s');
    hand(w, 'crititor', attack([finding('fatal', 'reasoning', 'A1 shows 0 of 20 survive: C1 is the opposite of the record')]));
    await w.advance();
    const ic2 = cardOf<InterpreterCard>(w, 'researcher-interpreter');
    assert.equal(ic2.openFindings.length, 1);
    assert.ok(ic2.current !== null);
    hand(w, 'researcher-interpreter', interpretation(ic2, 'not-standing', [{ finding: ic2.openFindings[0]?.id as string, action: 'revise', note: 'C1 marked not standing' }]));
    await w.advance();
    hand(w, 'crititor', attack([], recheckAll(cardOf<CrititorCard>(w, 'crititor'), 'yes')));
    await w.advance();
    assert.equal(cardOf<CrititorCard>(w, 'crititor').fresh, true);
    hand(w, 'crititor', attack());
    const r = await w.advance();
    assert.equal(r.stopped?.reason, 'converged');
    const h = (await explorationHandoffs(w.ledger, M))[0]?.handoff;
    assert.equal(h?.research?.noConclusion, true);
    assert.equal(h?.acceptance, 'user', '"no conclusion" is handled as a direction decision (3.10)');
    const ev = (await w.ledger.records(['evidence'])).map((c) => [c.record.fields['attempt'], c.record.fields['status']]);
    assert.deepEqual(ev, [
      ['A1', 'completed'],
      ['A2', 'failed'],
    ]);
  });
});
