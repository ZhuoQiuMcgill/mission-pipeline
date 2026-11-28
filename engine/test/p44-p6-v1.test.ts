// 4.4 package p6, from the verification on memories written by 4.3 (v1): a repair 4.3 decided reads as its record
// establishes.
//   1  its decision has no note, and the accepted hand-back of its Architect step has one: `mp read repairs` shows
//      it, and the cards of the tasks the repair added, changed or reopened print it as a 4.4 note is printed (a note
//      that cannot be read is left out; it never refuses a claim)
//   2  "done" only when every part reads done; otherwise "decided under 4.3" with its parts open or not recorded; a
//      4.3 reopen is reopened under 4.3 and accepted (its loop's record and a later acceptance), or "what became of
//      this reopen is not recorded", never "not carried out yet" (4.4 schedules nothing for it). The 4.4 path (the
//      records of p7) is unchanged: p44-p6-merge.
//   3  (4.3 and 4.4 alike) a changed card another card of the task replaced before any acceptance under it is
//      "superseded before it was accepted, by R-n" or "by a later plan": neither open nor done; the repair's line
//      is "decided; done or superseded: see …" when nothing else is left; `mp read items` gives it no acceptance
//      and no proof, and its row says superseded.
// The memories of 1 and 2 are synthetic, in the 4.3 shape: a decision event with no `note` and no `tracked`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { planInEffect, submitPmBatch } from '../src/flow/planning.ts';
import type { DetailedPlanDoc, DetailedTask } from '../src/flow/plandoc.ts';
import type { ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import { readItems } from '../src/cli/itemsRead.ts';
import { constructorDone, detailedPlan, drive, happyScript, pmPlan, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { listDispatches } from '../src/memory/index.ts';
import { pmRepair } from '../src/process/pm.ts';
import { dispatchView } from '../src/process/seat.ts';
import { renderSeatCard, type ConstructorCard, type ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import { repairNoteOf } from '../src/seat/cards/dynamic.ts';
import { repairsRead, repairsText } from '../src/cli/workReads.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;

async function setup(plan: () => DetailedPlanDoc = () => detailedPlan(M)): Promise<{ ports: World; engine: FlowEngine; script: (over?: Record<string, Script>) => Script }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  // overrides by task id first, then by seat
  const script = (over: Record<string, Script> = {}): Script => (t, s) => (Object.hasOwn(over, t.task) ? over[t.task]! : Object.hasOwn(over, t.card.seat) ? over[t.card.seat]! : happyScript(M, plan))(t, s);
  return { ports, engine: new FlowEngine(ports), script };
}

function claimed<C>(ports: World, task: string): C {
  const d = ports.memory.read((db) => listDispatches(db, { task, limit: 100 })).at(-1);
  if (d === undefined) throw new Error(`no dispatch of ${task}`);
  return dispatchView(ports.ctx, d.dispatch).card as unknown as C;
}

const read = (ports: World) => ports.memory.read((db) => repairsRead(db, ports.memory.data, 'm1'));
const repair = (ports: World, id: string) => read(ports).repairs.find((r) => r.id === id)!;

/** The decision of `repairId` written as 4.3 wrote it: no `note` and no `tracked` (its Architect's hand-back keeps the note). */
function decidedAs43(ports: World, repairId: string): () => void {
  type Entries = { events?: Array<{ event: string; body: unknown }> };
  const l = ports.ledger as unknown as { append: (op: string, entries: Entries) => Promise<void> };
  const orig = l.append.bind(l);
  l.append = async (op, entries) => {
    if (op !== `flow:repair-decided:${M}:${repairId}`) return orig(op, entries);
    const events = (entries.events ?? []).map((e) => { if (e.event !== 'decided') return e; const { note: _n, tracked: _t, ...body } = e.body as Record<string, unknown>; return { ...e, body }; });
    return orig(op, { ...entries, events });
  };
  return () => { l.append = orig; };
}

const HDR: DetailedTask = {
  id: 'hdr', kind: 'implementation', module: 'parser', goal: 'Keep the header row', standards: [{ id: 'S1', text: 'The header row is kept' }], requirementItems: [],
  writeScope: ['src/parser/header.ts'], readableFiles: [], interpreter: 'node', verificationCommands: [{ id: 'test', command: 'npm test' }], implements: [], calls: [],
  dependsOn: ['impl'], exclusive: [], estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'small' }, provenance: 'architect',
};
const NOTE = 'hdr owns the header row; impl calls it for every file.';
const FROM = "repair R-1, the Architect's note on its decision";

describe('v1-1: the Architect\'s note of a repair 4.3 decided, from its Architect\'s accepted hand-back', () => {
  it('read repairs shows it, and the cards of the task the repair added print it as a 4.4 note is printed', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    const w2 = say(ports, 'The output loses the header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'loses the header row', about: 'impl' });
    const restore = decidedAs43(ports, 'R-1');
    await drive(engine, ports.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [], add: [HDR], note: NOTE } }), 'con.m1.hdr.1': () => null }));
    restore();
    const decided = (await ports.ledger.events<Record<string, unknown>>({ mission: M, line: 'repairs', event: 'decided' }))[0]!.body;
    assert.ok(!('note' in decided) && !('tracked' in decided), 'the decision as 4.3 wrote it');
    assert.equal(repair(ports, 'R-1').note, NOTE);
    const text = repairsText(read(ports));
    assert.ok(text.includes(`    the Architect's note: ${NOTE}`), text);
    // the card queued for hdr, and the card its claim gives, print it
    const expected = [{ from: FROM, text: NOTE }];
    assert.deepEqual(ports.scheduler.card<ConstructorCard>('con.m1.hdr.1').architectNotes, expected);
    ports.scheduler.dispatchOf('con.m1.hdr.1');
    const con = claimed<ConstructorCard>(ports, 'con.m1.hdr.1');
    assert.deepEqual(con.architectNotes, expected);
    assert.ok(renderSeatCard(con as never, { dispatch: 'D-x' }).includes(`## The Architect's notes on this work\n- [${FROM}] ${NOTE}`));
    assert.deepEqual(await ports.scheduler.run('con.m1.hdr.1', { handBack: constructorDone() }), []);
    await drive(engine, ports.scheduler, script());
    assert.deepEqual(claimed<ReviewerCard>(ports, 'rev.m1.hdr.1').architectNotes, expected);
  });

  it('a note that cannot be read is left out, never an error; a 4.4 decision keeps its own note, an empty one too', () => {
    assert.equal(repairNoteOf({ arch: 'arch-repair.m1.R-2d1.1' }, () => { throw new Error('the hand-back cannot be read'); }), null);
    assert.equal(repairNoteOf({ arch: 'arch-repair.m1.R-2d1.1' }, () => '   '), null);
    assert.equal(repairNoteOf({ arch: 'arch-repair.m1.R-2d1.1' }), null);
    assert.equal(repairNoteOf({ note: '', arch: 'arch-repair.m1.R-2d1.1' }, () => NOTE), '');
  });
});

describe('v1-2: a repair 4.3 decided reads only what its record establishes', () => {
  it('a part still open: "decided under 4.3; open: …", never "not done"; once every part is done, "decided; done"', async () => {
    const { ports, engine, script } = await setup();
    await drive(engine, ports.scheduler, script());
    const w2 = say(ports, 'The output loses the header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'loses the header row', about: 'impl' });
    const restore = decidedAs43(ports, 'R-1');
    await drive(engine, ports.scheduler, script({ 'architect-repair': () => ({ handBack: { reopen: [], add: [HDR], note: NOTE } }), 'con.m1.hdr.1': () => null }));
    restore();
    let r = repair(ports, 'R-1');
    assert.deepEqual([r.done, r.under43, r.parts], [false, true, { open: ['added hdr'], superseded: [], notRecorded: [], notCarried: [] }]);
    let text = repairsText(read(ports));
    assert.ok(text.includes('[R-1] usability') && text.includes('\n    decided under 4.3; open: added hdr\n'), text);
    assert.ok(!text.includes('not done'), text);
    await drive(engine, ports.scheduler, script());
    r = repair(ports, 'R-1');
    assert.deepEqual([r.done, r.under43, r.parts], [true, true, { open: [], superseded: [], notRecorded: [], notCarried: [] }]);
    text = repairsText(read(ports));
    assert.ok(text.includes('\n    decided; done\n'), text);
  });

  it('a reopen the record does not show the outcome of: "what became of this reopen is not recorded", never "not carried out yet"', async () => {
    const { ports, script, engine } = await setup();
    await drive(engine, ports.scheduler, script());
    const w2 = say(ports, 'The output loses the header row.');
    await pmRepair(ports.ctx, { mission: M, words: w2, kind: 'usability', text: 'loses the header row', about: 'impl' });
    const pie = await planInEffect(flowCtx(ports, M));
    // the decision as 4.3 recorded it, read before any 4.4 pass (nothing counted, nothing carried on the task's line)
    await ports.ledger.append('test:decided-4.3', { events: [{ mission: M, line: 'repairs', event: 'decided', key: 'R-1', body: { repair: 'R-1', dplan: pie!.eff.dplan, arch: 'arch-repair.m1.R-2d1.1', add: [], reopen: [{ task: 'impl', issue: 'keep the header row', attempt: 1, product: 'prod.con.m1.impl.1' }] } }] });
    const r = repair(ports, 'R-1');
    assert.deepEqual(r.reopened, [{ task: 'impl', state: 'decided under 4.3: what became of this reopen is not recorded; accepted at attempt 1 (prod.con.m1.impl.1)', done: false, notRecorded: true }]);
    assert.deepEqual([r.done, r.under43, r.parts], [false, true, { open: [], superseded: [], notRecorded: ['reopened impl'], notCarried: [] }]);
    const text = repairsText(read(ports));
    assert.ok(text.includes('\n    decided under 4.3; not recorded: reopened impl\n'), text);
    assert.ok(!/not carried out yet|not done/.test(text), text);
  });
});

describe('v1-3: a changed card replaced before it was accepted is superseded: neither open nor done', () => {
  // docs is held before its review, so it has no accepted product and a repair may change its card (4.1.3, #35)
  let goal = 'Integrate and document the parser';
  const plan = (): DetailedPlanDoc => { const p = detailedPlan(M, { extraTask: true }); return { ...p, tasks: p.tasks.map((t) => (t.id === 'docs' ? { ...t, goal, verificationCommands: [{ id: 'lint', command: 'npm run lint' }] } : t)) }; };
  const docsChange = (edit: (docs: DetailedTask) => DetailedTask): Script => (t) => {
    const docs = (t.card as unknown as ArchitectRepairCard).plan.tasks.find((x) => x.id === 'docs')!;
    return { handBack: { reopen: [], add: [], change: [edit(docs)], note: 'docs takes the change' } };
  };
  const toReadme = docsChange((d) => ({ ...d, writeScope: ['README.md'] }));
  async function changedThenHeld(): Promise<Awaited<ReturnType<typeof setup>>> {
    goal = 'Integrate and document the parser';
    const x = await setup(plan);
    await drive(x.engine, x.ports.scheduler, x.script({ 'rev.m1.docs.1': () => null }));
    const w = say(x.ports, 'The docs should live in the README, not in a folder of their own.');
    await pmRepair(x.ports.ctx, { mission: M, words: w, kind: 'usability', text: 'The docs should live in the README', about: 'docs' });
    await drive(x.engine, x.ports.scheduler, x.script({ 'architect-repair': toReadme, 'con.m1.docs.2': () => null }));
    return x;
  }
  const items = (ports: World, id: string) => readItems(ports.ctx, 'm1').find((v) => v.kind === 'repair' && v.id === id)!;

  it('replaced by another repair\'s change: "superseded before it was accepted, by R-2"; the line points at R-2, and read items says superseded', async () => {
    const { ports, engine, script } = await changedThenHeld();
    const w = say(ports, 'The docs should show an example of each call.');
    await pmRepair(ports.ctx, { mission: M, words: w, kind: 'missing', text: 'show an example of each call', about: 'docs' });
    await drive(engine, ports.scheduler, script({ 'architect-repair': docsChange((d) => ({ ...d, goal: `${d.goal}, with an example of each call` })), 'con.m1.docs.3': () => null }));
    const r1 = repair(ports, 'R-1');
    assert.deepEqual(r1.changed, [{ task: 'docs', state: 'superseded before it was accepted, by R-2; attempt 3 in work', done: false, superseded: 'R-2' }]);
    assert.deepEqual([r1.done, r1.parts], [false, { open: [], superseded: [{ part: 'changed docs', by: 'R-2' }], notRecorded: [], notCarried: [] }]);
    const text = repairsText(read(ports));
    assert.ok(text.includes('\n    decided; done or superseded: see R-2\n'), text);
    assert.ok(text.includes('\n    decided; open: changed docs\n'), 'R-2 is the one in work');
    const row = items(ports, 'R-1');
    assert.deepEqual([row.state, row.tasks.map((t) => [t.task, t.state, t.product]), row.proof], ['superseded', [['docs', 'superseded', null]], null]);
    assert.equal(items(ports, 'R-2').state, 'in work');
  });

  it('replaced by a plan: "superseded before it was accepted, by a later plan"', async () => {
    const { ports, engine, script } = await changedThenHeld();
    goal = 'Document the parser in docs/ and in the README';
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: [pmPlan(M).elements[0]!, { ...pmPlan(M).elements[1]!, text: 'Covered by unit tests, documented' }] }), userWords: ['W-1'] });
    // R-1's attempt 2 is still held when the plan takes effect: no acceptance under its card
    await drive(engine, ports.scheduler, script({ 'con.m1.docs.2': () => null, 'con.m1.docs.3': () => null }));
    const r1 = repair(ports, 'R-1');
    assert.deepEqual(r1.changed, [{ task: 'docs', state: 'superseded before it was accepted, by a later plan; attempt 3 in work', done: false, superseded: 'a later plan' }]);
    assert.ok(repairsText(read(ports)).includes('\n    decided; done or superseded: see a later plan\n'));
    assert.equal(items(ports, 'R-1').state, 'superseded');
  });

  it('the replacing repair\'s card accepted: R-2 is done, R-1 stays superseded (no acceptance and no proof for R-1)', async () => {
    const { ports, engine, script } = await changedThenHeld();
    const w = say(ports, 'The docs should show an example of each call.');
    await pmRepair(ports.ctx, { mission: M, words: w, kind: 'missing', text: 'show an example of each call', about: 'docs' });
    await drive(engine, ports.scheduler, script({ 'architect-repair': docsChange((d) => ({ ...d, goal: `${d.goal}, with an example of each call` })) }));
    const [r1, r2] = [repair(ports, 'R-1'), repair(ports, 'R-2')];
    assert.match(r1.changed[0]!.state, /^superseded before it was accepted, by R-2; accepted at attempt 3 \(/);
    assert.deepEqual([r1.done, r2.done], [false, true]);
    const text = repairsText(read(ports));
    assert.ok(text.includes('\n    decided; done or superseded: see R-2\n') && text.includes('\n    decided; done\n'), text);
    const row = items(ports, 'R-1');
    assert.deepEqual([row.state, row.tasks[0]?.state, row.tasks[0]?.product, row.proof], ['superseded', 'superseded', null, null]);
    assert.notEqual(items(ports, 'R-2').proof, null, 'R-2 has the acceptance and its proof');
  });
});
