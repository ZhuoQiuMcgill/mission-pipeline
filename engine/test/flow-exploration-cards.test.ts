// The exploration and legalization seat cards (design 2, 7.1, 5.5): registered kinds, seats and
// tool profiles; the one-page definition plus the card's description within 8 KB; the blind
// executor's card carries no expectation; the program's rules on hand-backs.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { seatCardEntry, seatCardKinds, TOOL_PROFILES } from '../src/seat/cards/index.ts';
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
];

describe('exploration and legalization cards', () => {
  test('every kind is registered with its seat and tool profile; definitions name their tools and upstream/downstream', () => {
    const kinds = seatCardKinds();
    for (const [kind, seat, profile] of KINDS) {
      assert.ok(kinds.includes(kind), kind);
      const e = seatCardEntry(kind);
      assert.equal(e.seat, seat);
      assert.equal(e.toolProfile, profile);
      assert.match(e.definition, /Upstream:/);
      assert.match(e.definition, /Downstream:/);
      assert.match(e.definition, /Your tools:/);
      assert.match(e.definition, /Prohibitions:/);
      assert.match(e.definition, /Hand-back \(submit_result, once\)/);
      for (const t of TOOL_PROFILES[e.toolProfile]) if (t !== 'submit_result') assert.ok(e.definition.includes(t), `${kind} definition names ${t}`);
    }
  });

  test('definition plus card description stay within 8 KB (5.5); materials carry the rest', async () => {
    const w = await world();
    await w.advance();
    const big = 'x'.repeat(200_000);
    hand(w, 'researcher-author', submit(big));
    await w.advance();
    const c = cardOf<CrititorCard>(w, 'crititor');
    const e = seatCardEntry('crititor');
    assert.ok(Buffer.byteLength(e.definition + e.render(c)) < 8 * 1024, 'the 200 KB version is a material, not in the first message');
    assert.ok((c.materials.find((m) => m.id === 'version')?.pages ?? 0) > 1);
    hand(w, 'crititor', attack([finding('serious', 'gets stuck', 'a'), finding('general', 'wording', 'b')]));
    await w.advance();
    const a = cardOf<AuthorCard>(w, 'researcher-author');
    const ea = seatCardEntry('researcher-author');
    assert.ok(Buffer.byteLength(ea.definition + ea.render(a)) < 8 * 1024);
  });

  test('attackOutcome: pass, fail, and undecided when only rulings are missing', () => {
    const f = (id: string, severity: PriorFindingT['severity'], status: PriorFindingT['status']): PriorFindingT => ({ id, severity, class: 'c', title: id, round: 1, material: null, status, disposition: null, ruling: null });
    assert.equal(attackOutcome([f('a', 'serious', 'awaiting-recheck')], { findings: [], rechecks: [{ finding: 'a', resolved: 'yes', reason: 'r', evidence: [] }] }).verdict, 'pass');
    assert.equal(attackOutcome([f('a', 'serious', 'awaiting-recheck')], { findings: [], rechecks: [{ finding: 'a', resolved: 'no', reason: 'r', evidence: [] }] }).verdict, 'fail');
    assert.equal(attackOutcome([f('a', 'fatal', 'awaiting-ruling')], { findings: [], rechecks: [] }).verdict, 'undecided');
    assert.equal(attackOutcome([f('a', 'minor', 'open')], { findings: [finding('general', 'c', 'x')], rechecks: [] }).verdict, 'pass', 'general and minor findings never block');
    assert.equal(attackOutcome([f('a', 'fatal', 'awaiting-ruling')], { findings: [finding('serious', 'c', 'x')], rechecks: [] }).verdict, 'fail');
  });
});

describe('exploration cards as the seat host sees them', () => {
  test('every card the flow builds passes the host card view and gets its profile\'s tools', async () => {
    const { hostCardView, seatToolNames } = await import('../src/seat/profiles.ts');
    const { blind } = await import('./flow-exploration-fixtures.ts');
    const w = await world({ evidenceExecutor: 'reading', readingNetwork: ['https://docs.example.org/'] });
    await w.advance();
    const tools = (kind: string): string[] => {
      const t = w.scheduler.queued(kind)[0];
      assert.ok(t, kind);
      const card = t.card as never;
      hostCardView(card);
      return seatToolNames(seatCardEntry(kind).toolProfile, hostCardView(card));
    };
    assert.deepEqual(tools('researcher-author'), ['read_file', 'list_directory', 'search_content', 'read_material', 'submit_result', 'request_evidence']);
    hand(w, 'researcher-author', submit('v1'));
    await w.advance();
    assert.deepEqual(tools('crititor'), ['read_file', 'list_directory', 'search_content', 'read_material', 'submit_result', 'request_evidence']);
    const t = w.scheduler.queued('crititor')[0];
    w.scheduler.run(t?.task as string, { evidence: { steps: ['read the page'], data: '', measure: ['limit'], assertions: [] } });
    await w.advance();
    assert.deepEqual(tools('researcher-reader'), ['read_file', 'list_directory', 'search_content', 'fetch_url', 'submit_result']);
    hand(w, 'researcher-reader', blind(cardOf(w, 'researcher-reader')));
    await w.advance();
    assert.ok(w.scheduler.queued('crititor').length === 1);
  });
});
