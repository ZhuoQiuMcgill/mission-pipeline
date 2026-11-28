// 4.4 (G9) at the command line: `mp pm extend` records a new requirement and starts its work; a retry with the same
// --op replays its receipt and one without returns the filing recorded; `mp pm repair --kind missing` still files and
// points to `mp pm extend`; `mp pm repair --item` names the item a repair falls short of; `mp read repairs` tells a new
// requirement from a repair and marks a repair that added tasks and names no item; the tree says how a product came in.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { pmDispatch, pmNext, pmSay } from '../src/process/pm.ts';
import { dispatchView } from '../src/process/seat.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import { cli } from './cli-fixtures.ts';
import { addMissionToReview, handBack, processProject, readAll, readyOf, reviewerPass, type ProcessProject } from './process-fixtures.ts';

const M = 'm1';
let p: ProcessProject | null = null;
afterEach(() => { p?.cleanup(); p = null; });

async function accepted(): Promise<ProcessProject> {
  const q = processProject();
  await addMissionToReview(q, M);
  const rev = pmDispatch(q.ctx, (await readyOf(q.ctx, 'reviewer')).step).dispatch;
  readAll(q.ctx, rev);
  assert.equal((await handBack(q.ctx, rev, reviewerPass(dispatchView(q.ctx, rev).card as never))).kind, 'recorded');
  await pmNext(q.ctx);
  return q;
}

describe('4.4 G9: mp pm extend', () => {
  it('records the items and the filing in one write, says what they are outside of; the same --op replays; again without one returns the filing; an existing id and uneven flags are refused', async () => {
    p = await accepted();
    const words = pmSay(p.ctx, 'Could it also subtract? And keep it fast.').words;
    const args = ['pm', 'extend', M, '--words', words, '--item', 'sub', '--text', 'It subtracts two numbers', '--quote', 'Could it also subtract', '--item', 'fast', '--type', 'goal', '--type', 'limit', '--text', 'Each call takes under a millisecond', '--quote', 'keep it fast'];
    const first = await cli(p.dir, [...args, '--op', 'extend-1']);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /New requirement recorded: R-1 of m1, items sub, fast \(from W-\d+\)\./);
    assert.match(first.out, /The items are outside the set PM plan pmplan\.m1\.1 was checked against: its proof, and that of every product not bound to them, stay as they are/);
    assert.match(first.out, /An Architect step amends the plan in effect for them \(the mechanical checks only; no Calibrator, no feasibility review\)/);
    const again = await cli(p.dir, [...args, '--op', 'extend-1']);
    assert.match(again.out, /already done; its recorded result is shown, nothing ran again/);
    const retry = await cli(p.dir, [...args, '--json']);
    assert.deepEqual([retry.json.result.repair, retry.json.result.repeated], ['R-1', true]);
    const count = (event: string) => p!.ctx.memory.read((db) => Number((db.stmt("SELECT COUNT(*) AS n FROM flow_events WHERE line = ? AND event = ?").get(event === 'repair' ? 'repairs' : 'requirements', event) as { n: number }).n));
    assert.equal(count('repair'), 1, 'filed once');
    const items = p.ctx.memory.read((db) => (db.stmt("SELECT key FROM flow_events WHERE line = 'requirements' AND event = 'item'").all() as Array<{ key: string }>).map((r) => r.key));
    assert.ok(items.includes('item.m1.sub.v1') && items.includes('item.m1.fast.v1'), items.join(', '));
    const clash = await cli(p.dir, ['pm', 'extend', M, '--words', words, '--item', 'sub', '--text', 'It subtracts', '--quote', 'Could it also subtract']);
    assert.notEqual(clash.code, 0);
    assert.match(clash.err, /already has requirement item sub: a new requirement gets a new id/);
    const uneven = await cli(p.dir, ['pm', 'extend', M, '--words', words, '--item', 'x', '--text', 'a', '--item', 'y', '--quote', 'keep it fast']);
    assert.match(uneven.err, /one --text and one --quote per --item, in order/);
    const notVerbatim = await cli(p.dir, ['pm', 'extend', M, '--words', words, '--item', 'z', '--text', 'z', '--quote', 'not in the words']);
    assert.notEqual(notVerbatim.code, 0);
    const help = await cli(p.dir, ['pm', 'extend', '--help']);
    assert.match(help.out, /mp pm extend <mission> --words W-<n> --item <id> --text/);
    // the filing's Architect step is queued on the light path, and its card shows the items and the limit by reference
    const step = (await readyOf(p.ctx, 'architect-repair')).step;
    const card = dispatchView(p.ctx, pmDispatch(p.ctx, step).dispatch).card as unknown as ArchitectRepairCard;
    assert.equal(card.entry, 'extend');
    assert.deepEqual(card.items?.map((i) => i.id), ['item.m1.sub', 'item.m1.fast']);
    const read = await cli(p.dir, ['read', 'repairs', M]);
    assert.match(read.out, /\[R-1\] new requirement \(W-\d+\): "Could it also subtract"/);
    assert.ok(read.out.includes('its items: item.m1.sub, item.m1.fast; outside the set PM plan pmplan.m1.1 was checked against: item.m1.sub, item.m1.fast'), read.out);
  });

  it('mp pm repair --kind missing still files a repair and points to mp pm extend; --item binds it to an item; a repair that added tasks and names no item is marked in the read', async () => {
    p = await accepted();
    const words = pmSay(p.ctx, 'There is no way to multiply.').words;
    const r = await cli(p.dir, ['pm', 'repair', M, '--words', words, '--kind', 'missing', '--text', 'no way to multiply']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Repair recorded: R-1 \(missing\)/);
    assert.match(r.out, /A missing feature the user now wants is a new requirement: mp pm extend records it/);
    const step = (await readyOf(p.ctx, 'architect-repair')).step;
    const d = pmDispatch(p.ctx, step).dispatch;
    readAll(p.ctx, d);
    const card = dispatchView(p.ctx, d).card as unknown as ArchitectRepairCard;
    const base = card.plan.tasks[0]!;
    assert.equal((await handBack(p.ctx, d, { reopen: [], add: [{ ...base, id: 'mul', goal: 'Multiply', writeScope: ['src/mul.js'], dependsOn: ['impl'], implements: [], requirementItems: [], provenance: 'architect' }], note: 'a new task multiplies' })).kind, 'recorded');
    await pmNext(p.ctx);
    const read = await cli(p.dir, ['read', 'repairs', M]);
    assert.match(read.out, /\[R-1\] missing/);
    assert.match(read.out, /it added tasks and names no requirement item \(a lead for a spot-check/);
    assert.match(read.out, /its work passed its Architect and the mechanical checks, no plan review/);
    const bad = await cli(p.dir, ['pm', 'repair', M, '--words', words, '--kind', 'defect', '--text', 'no way to multiply', '--item', 'a.b']);
    assert.match(bad.err, /--item names a requirement item by its id/);
    const items = p.ctx.memory.read((db) => (db.stmt("SELECT key FROM flow_events WHERE line = 'requirements' AND event = 'item'").all() as Array<{ key: string }>).map((x) => x.key.replace(/\.v\d+$/, '')));
    const item = items[0]!.slice(`item.${M}.`.length);
    const named = await cli(p.dir, ['pm', 'repair', M, '--words', words, '--kind', 'defect', '--text', 'no way to multiply', '--item', item]);
    assert.equal(named.code, 0, named.err);
    assert.ok(named.out.includes(`The work its Architect plans is bound to item ${item}.`) && named.out.startsWith('Repair recorded: R-2 (defect)'), named.out);
    assert.doesNotMatch(named.out, /mp pm extend records it/, 'only a missing feature gets the line');
  });
});
