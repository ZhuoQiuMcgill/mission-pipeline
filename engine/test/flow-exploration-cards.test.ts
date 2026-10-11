// The exploration and legalization seat cards (design 4.1 §5.2; 4.0 2, 7.1, 5.5): registered kinds,
// seats and tool profiles; the one-page role page (roles/<seat>.md) plus the card's description
// within 8 KB; the blind executor's card carries no expectation; the program's rules on hand-backs.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { seatCardEntry, seatCardKinds } from '../src/seat/cards/index.ts';
import { renderSeatCard, seatCommandsOf } from '../src/seat/card.ts';
import { attackOutcome, type CrititorCard, type PriorFindingT } from '../src/seat/cards/crititor.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import { attack, cardOf, finding, hand, submit, world } from './flow-exploration-fixtures.ts';

const KINDS: ReadonlyArray<[string, string, string]> = [
  ['researcher-author', 'researcher', 'read-evidence'],
  ['researcher-reader', 'researcher', 'read-web'],
  ['researcher-interpreter', 'researcher', 'read'],
  ['crititor', 'crititor', 'read-evidence'],
  ['constructor-experiment', 'constructor', 'write'],
  ['auditor-node', 'auditor', 'read-rerun'],
  ['auditor-chain', 'auditor', 'read-rerun'],
  ['stabilizer', 'stabilizer', 'materials'],
];

describe('exploration and legalization cards', () => {
  test('every kind is registered with its seat and tool profile; its role page names its commands and upstream/downstream', () => {
    const kinds = seatCardKinds();
    for (const [kind, seat, profile] of KINDS) {
      assert.ok(kinds.includes(kind), kind);
      const e = seatCardEntry(kind);
      assert.equal(e.seat, seat);
      assert.equal(e.toolProfile, profile);
      assert.match(e.definition, /## Upstream and downstream/);
      assert.match(e.definition, /## Never/);
      assert.match(e.definition, /## What you hand back/);
      assert.match(e.definition, /## Your commands/);
      assert.match(e.definition, /mp seat <id> handback/);
    }
  });

  test('definition plus card description stay within 8 KB (5.5); materials carry the rest', async () => {
    const w = await world();
    await w.advance();
    const big = 'x'.repeat(200_000);
    await hand(w, 'researcher-author', submit(big));
    await w.advance();
    const c = cardOf<CrititorCard>(w, 'crititor');
    const e = seatCardEntry('crititor');
    assert.ok(Buffer.byteLength(e.definition + e.render(c)) < 8 * 1024, 'the 200 KB version is a material, not in the first message');
    assert.ok((c.materials.find((m) => m.id === 'version')?.pages ?? 0) > 1);
    await hand(w, 'crititor', attack([finding('serious', 'gets stuck', 'a'), finding('general', 'wording', 'b')]));
    await w.advance();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    const ea = seatCardEntry('researcher-author');
    assert.ok(Buffer.byteLength(ea.definition + ea.render(a)) < 8 * 1024);
  });

  test('attackOutcome (4.1 §6.3): pass; fail on an in-scope finding left unresolved; pending (undecided) on new blocking findings or rulings', () => {
    const f = (id: string, severity: PriorFindingT['severity'], status: PriorFindingT['status'], scope: PriorFindingT['scope'] = 'in-scope'): PriorFindingT => ({ id, severity, class: 'c', title: id, round: 1, material: null, status, disposition: null, ruling: null, scope });
    assert.equal(attackOutcome([f('a', 'serious', 'awaiting-recheck')], { findings: [], rechecks: [{ finding: 'a', resolved: 'yes', reason: 'r', evidence: [] }] }).verdict, 'pass');
    assert.equal(attackOutcome([f('a', 'serious', 'awaiting-recheck')], { findings: [], rechecks: [{ finding: 'a', resolved: 'no', reason: 'r', evidence: [] }] }).verdict, 'fail');
    assert.equal(attackOutcome([f('a', 'fatal', 'awaiting-ruling')], { findings: [], rechecks: [] }).verdict, 'undecided');
    assert.equal(attackOutcome([f('a', 'minor', 'open')], { findings: [finding('general', 'c', 'x')], rechecks: [] }).verdict, 'pass', 'general and minor findings never block');
    assert.equal(attackOutcome([f('a', 'fatal', 'awaiting-ruling')], { findings: [finding('serious', 'c', 'x')], rechecks: [] }).verdict, 'undecided', 'a new serious finding waits for the Stabilizer');
    assert.equal(attackOutcome([f('a', 'serious', 'awaiting-recheck', 'out-of-scope')], { findings: [], rechecks: [] }).verdict, 'pass', 'an out-of-scope finding never refutes');
    assert.equal(attackOutcome([f('a', 'serious', 'awaiting-ruling', 'shifts-direction')], { findings: [], rechecks: [] }).verdict, 'pass', 'a direction finding blocks only through awaiting ruling');
  });
});

describe('exploration cards as the seat receives them (4.1 §5.2)', () => {
  test('every card the flow builds renders with its role page and its mp seat commands', async () => {
    const { blind } = await import('./flow-exploration-fixtures.ts');
    const w = await world({ evidenceExecutor: 'reading', readingNetwork: ['https://docs.example.org/'] });
    await w.advance();
    const commands = (kind: string): string[] => {
      const t = w.scheduler.queued(kind)[0];
      assert.ok(t, kind);
      const text = renderSeatCard(t.card, { dispatch: 'D-1' });
      for (const word of ['read_material', 'submit_result', 'request_evidence', 'fetch_url', 'sandbox', 'sessionId']) assert.ok(!text.includes(word), `${kind} names ${word}`);
      return seatCommandsOf(t.card);
    };
    assert.deepEqual(commands('researcher-author'), ['card', 'read', 'checkout', 'request-evidence', 'handback']);
    await hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    assert.deepEqual(commands('crititor'), ['card', 'read', 'checkout', 'request-evidence', 'handback']);
    const t = w.scheduler.queued('crititor')[0];
    await w.scheduler.run(t?.task as string, { evidence: { steps: ['read the page'], data: '', measure: ['limit'], assertions: [] } });
    await w.advance();
    assert.deepEqual(commands('researcher-reader'), ['card', 'checkout', 'handback'], 'a reading fetches with the harness\'s own tools and cites url:<address>');
    await hand(w, 'researcher-reader', blind(cardOf(w, 'researcher-reader')));
    await w.advance();
    assert.ok(w.scheduler.queued('crititor').length === 1);
    const resumed = cardOf<CrititorCard>(w, 'crititor');
    assert.equal(resumed.continuation?.previous, t?.task, 'the continuation is a new card with the previous notes and the evidence (§5.4)');
  });
});
