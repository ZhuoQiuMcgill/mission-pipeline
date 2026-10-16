// A behaviour whose 4.0 test went with the 4.0 code (package A6's review): a continuation review
// the labels refuse (5.2 part 5) becomes a full review: the hand-back is recorded, its judgment
// is not, and the full Calibrator ① task follows. Flow harness (no repository needed).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { recordItem } from '../src/flow/requirements.ts';
import { cal1Pass, drive, happyScript, pmPlan, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import type { Calibrator1Card } from '../src/seat/cards/calibrator.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;

describe('a continuation refused by the labels → a full review (5.2 part 5)', () => {
  it('a basis outside the changed elements moved: the continuation judgment is dropped, the full Calibrator ① runs', async () => {
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'] });
    const engine = new FlowEngine(ports);
    await drive(engine, ports.scheduler, happyScript(M));
    // a second batch changes element e2 only: a continuation review extending the first pass
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: [pmPlan(M).elements[0]!, { ...pmPlan(M).elements[1]!, text: 'Covered by unit and property tests' }] }), userWords: ['W-1'] });
    await engine.reconcile(M);
    const card = ports.scheduler.card<Calibrator1Card>('cal1.m1.2');
    assert.deepEqual(card.mode, { kind: 'continuation', extends: 'j.cal1.m1.1' });
    // Dispatch pins the inputs; a change during the review must still refuse the continuation.
    ports.scheduler.dispatchOf('cal1.m1.2');
    // meanwhile the goal item, outside the focus, gets a new version: the extended pass is no longer current outside the changes
    const w = say(ports, 'Build me a CSV parser that also writes CSV.');
    await recordItem(ports, { mission: M, item: 'g1', type: 'goal', text: 'A CSV parser and writer', source: { kind: 'words', words: w, quote: 'also writes CSV' } });
    assert.deepEqual(await ports.scheduler.run('cal1.m1.2', { handBack: cal1Pass(card) }), [], 'the hand-back is recorded (a normal branch, not a refusal)');
    const judgments = (await ports.ledger.records(['judgment'])).map((c) => c.record.judgment);
    assert.equal(judgments.includes('j.cal1.m1.2' as never), false, 'the refused continuation judgment is not recorded');
    const check = ports.memory.read((db) => db.stmt('SELECT ok, reason FROM continuation_checks WHERE judgment = ?').get('j.cal1.m1.2') as { ok: number; reason: string } | undefined);
    assert.equal(check?.ok, 0);
    assert.equal(check?.reason, 'not-current-outside-changes');
    assert.equal(ports.scheduler.tasks.get('cal1.m1.2')?.state, 'needs-disposition');
    await engine.reconcile(M);
    const full = ports.scheduler.card<Calibrator1Card>('cal1.m1.2.full');
    assert.equal(full.mode.kind, 'full', 'a full review of the batch');
  });
});
