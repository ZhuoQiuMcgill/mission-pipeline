// 4.4 (PM design G5; the release's verification v1, defect 4): right after an upgrade, the risk sentences of
// acceptances made under 4.3 are not open items: the record does not say what became of them. Every read counts
// three things apart: items recorded by 4.4 that are open, those answered or closed, and the sentences before 4.4
// nobody acted on; only the first is called open. `mp read open-items` lists the 4.4 items in full and the
// sentences before 4.4 as a count per task (`--all` lists them, `--open` only what 4.4 records as open). A sentence
// someone acts on (a repair names it, a plan or a repair's decision gives it to a task, the user's words close it, a
// statement names it) is recorded in the write that acts on it and is listed with the 4.4 items from then on. The
// close, `mp read items`, status, the tree and the Secretary's digest use the same classification. Synthetic
// memories only.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson } from '../src/common/hash.ts';
import type { ContentHash, MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { OPEN_ITEM, OPEN_ITEMS_LINE } from '../src/flow/openItems.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import type { DetailedPlanDoc, DetailedTask } from '../src/flow/plandoc.ts';
import { ITEM_BATCH, acceptanceOf, riskItemBodies, riskRecord, withRiskText, type RiskItemBody } from '../src/flow/riskItems.ts';
import { architect, detailedPlan, drive, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import type { EscalationBody } from '../src/flow/secretary.ts';
import { itemStateLines, readItems } from '../src/cli/itemsRead.ts';
import { appendRecords } from '../src/memory/index.ts';
import { pmClose, snapshotLines } from '../src/process/close.ts';
import { closeOpenItem, listAllItems, recordVerified } from '../src/process/openItems.ts';
import { pmRepair } from '../src/process/pm.ts';
import type { ConstructorCard, ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectDecomposeCard, ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import { secretaryInputs } from '../src/seat/cards/dynamic.ts';
import { cli } from './cli-fixtures.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
const events = <B = any>(w: World, line: string, event: string) => w.ledger.events<B>({ mission: M, line, event });
const opOf = (w: World, rev: number): string => (w.memory.stmt('SELECT op FROM log WHERE rev = ?').get(rev) as { op: string }).op;
const ESTIMATE = { durationMs: 60_000, costMicros: 100_000, basis: 'small' };
const task = (o: Partial<DetailedTask> & { id: string }): DetailedTask => ({
  kind: 'implementation', module: 'parser', goal: `Task ${o.id}`, standards: [{ id: 'S1', text: `${o.id} works` }], requirementItems: [], writeScope: [`src/parser/${o.id}.ts`], readableFiles: [], interpreter: 'node',
  verificationCommands: [{ id: 'test', command: 'npm test' }], implements: [], calls: [], dependsOn: ['iface'], exclusive: [], estimate: ESTIMATE, provenance: 'architect', ...o,
});

async function world(): Promise<{ w: World; engine: FlowEngine }> {
  const w = memoryPorts();
  say(w, SEED_TEXT);
  await seedMission(w, M);
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  return { w, engine: new FlowEngine(w) };
}
function script(over: Record<string, Script> = {}): Script {
  const base = happyScript(M);
  return (t, s) => (Object.hasOwn(over, t.card.seat) ? over[t.card.seat]! : base)(t, s);
}
/** An acceptance with risk as 4.3 wrote it: its sentences, no item. */
function accepted43(w: World, taskId: string, escalation: string, reasons: readonly string[]): void {
  const risks = reasons.map((r) => `accepted with its risk by the Secretary on ${escalation}: ${r}`);
  w.memory.write({}, (tx) => appendRecords(tx, [{ kind: 'flow.event', mission: M, line: `task:${taskId}`, event: 'accepted', key: '1', body: tx.data.put(canonicalJson({ k: 1, product: `prod.${taskId}`, judgment: `j.sec.${escalation}`, decision: { escalation, option: 'accept-risk', by: 'secretary' }, risks })) as ContentHash }]));
}
/** An acceptance with risk as 4.4 writes it: its sentences and one item per reason in the same write (`written`: the first so many, as an interruption after the first batch leaves it). */
function accepted44(w: World, taskId: string, escalation: string, reasons: readonly string[], written = Infinity): RiskItemBody[] {
  const risks = reasons.map((r) => `accepted with its risk by the Secretary on ${escalation}: ${r}`);
  const bodies = riskItemBodies(taskId, 1, escalation, reasons);
  w.memory.write({}, (tx) => appendRecords(tx, [
    { kind: 'flow.event', mission: M, line: `task:${taskId}`, event: 'accepted', key: '1', body: tx.data.put(canonicalJson({ k: 1, product: `prod.${taskId}`, judgment: `j.sec.${escalation}`, decision: { escalation, option: 'accept-risk', by: 'secretary' }, risks })) as ContentHash },
    ...bodies.slice(0, written).map((b) => ({ kind: 'flow.event' as const, mission: M, line: OPEN_ITEMS_LINE, event: OPEN_ITEM, key: b.id, body: tx.data.put(canonicalJson(b)) as ContentHash })),
  ]));
  return bodies;
}
const read = async (w: World, ...flags: string[]) => {
  const r = await cli(w.dir, ['read', 'open-items', 'm1', ...flags]);
  assert.equal(r.code, 0, r.err);
  return r.out;
};

describe('v1-4: the risk sentences of acceptances made before 4.4 are counted apart, never called open', () => {
  it('the header counts three things apart; the 4.4 items are listed in full, the sentences before 4.4 as a count per task; --all lists them, --open only what 4.4 records as open', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    accepted43(w, 'old', 'exh.old.1', ['[S1] not met: slow', 'finding: no docs']);
    accepted43(w, 'old2', 'exh.old2.1', ['[S2] unclear: which encoding']);
    const mine = accepted44(w, 'new', 'exh.new.1', ['[S1] not met: still slow', 'finding: a typo']);
    closeOpenItem(w.ctx, { op: 'c1', ref: mine[1]!.id, words: say(w, 'The typo does not matter.'), reason: 'the typo does not matter' });
    const head = 'Open items of mission m1: 1 open, 1 answered or closed; 3 risk sentences accepted before 4.4: what became of them is not recorded';
    const def = await read(w);
    assert.equal(def.split('\n')[0], head);
    assert.ok(def.includes(`[${mine[0]!.id}] fix, task new (attempt 1, accepted with risk on exh.new.1): open`) && def.includes(`[${mine[1]!.id}] finding, task new (attempt 1, accepted with risk on exh.new.1): closed`), def);
    assert.ok(!def.includes('[exh.old.1.r1]') && !def.includes('[exh.old2.1.r1]'), 'no sentence before 4.4 in full by default');
    assert.ok(def.includes('Risk sentences of acceptances made before 4.4, per task (what became of them is not recorded; mp read open-items m1 --all lists them):\n  task old: 2 risk sentences accepted before 4.4\n  task old2: 1 risk sentence accepted before 4.4'), def);
    const open = await read(w, '--open');
    assert.equal(open.split('\n')[0], head, 'the header is the same with every flag');
    assert.ok(open.includes(`[${mine[0]!.id}]`) && !open.includes(`[${mine[1]!.id}]`) && !open.includes('exh.old') && !open.includes('task old:'), open);
    const all = await read(w, '--all');
    assert.ok(all.includes('[exh.old.1.r1] fix, task old (attempt 1, accepted with risk on exh.old.1): not recorded as an item (an acceptance with risk made before 4.4): what became of it is not recorded') && all.includes('[exh.old2.1.r1]') && !all.includes('task old:'), all);
    const both = await cli(w.dir, ['read', 'open-items', 'm1', '--open', '--all']);
    assert.notEqual(both.code, 0);
    assert.match(both.out + both.err, /choose --open \(only what 4\.4 records as open\) or --all/);
    // the status and the tree text of each acceptance, from the one classification
    const r = riskRecord([...(await w.ledger.events({ mission: M }))]);
    assert.deepEqual([withRiskText(r, acceptanceOf(r, 'old', 'exh.old.1')), withRiskText(r, acceptanceOf(r, 'new', 'exh.new.1'))], ['0 open; 2 risk sentences accepted before 4.4: what became of them is not recorded', '1 open']);
  });

  it('many sentences before 4.4: the default read stays one line per task, --all lists each', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    for (const t of ['a', 'b', 'c']) accepted43(w, t, `exh.${t}.1`, Array.from({ length: 100 }, (_, i) => `[S1] not met: case ${t}${i}`));
    const def = await read(w);
    const all = await read(w, '--all');
    assert.equal(def.trimEnd().split('\n').length, 5, def);
    assert.ok(all.trimEnd().split('\n').length > 600 && all.length > 20 * def.length, `${all.length} against ${def.length}`);
  });

  it('a sentence someone acts on is recorded in the write that acts on it and is listed with the 4.4 items: a repair names it, the user\'s words close it, a statement names it, a repair\'s decision gives it to a task', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    accepted43(w, 'old', 'exh.old.1', ['[S1] not met: slow', 'finding: no docs', '[S2] unclear: rows', 'finding: a log line', 'finding: an old name']);
    const recordedAt = async (id: string) => (await events<RiskItemBody>(w, OPEN_ITEMS_LINE, OPEN_ITEM)).find((e) => e.key === id);
    // a repair names r1
    const filed = await pmRepair(w.ctx, { mission: M, words: say(w, 'Please make it faster.'), kind: 'defect', text: 'make it faster', openItems: ['exh.old.1.r1'] });
    const r1 = (await recordedAt('exh.old.1.r1'))!;
    assert.deepEqual([r1.body.before44, r1.body.kind, r1.body.text], [true, 'fix', '[S1] not met: slow']);
    const repairEvent = (await events(w, 'repairs', 'repair')).find((e) => e.key === filed.repair)!;
    assert.equal(opOf(w, r1.revision), opOf(w, repairEvent.revision), 'in the repair\'s write');
    // the user's words close r2; a statement names r3
    closeOpenItem(w.ctx, { op: 'c2', ref: 'exh.old.1.r2', words: say(w, 'Docs are not needed.'), reason: 'docs are not needed' });
    const r2 = (await recordedAt('exh.old.1.r2'))!;
    const closed2 = (await events(w, OPEN_ITEMS_LINE, 'open-item-closed')).find((e) => e.key === 'exh.old.1.r2')!;
    assert.equal(opOf(w, r2.revision), opOf(w, closed2.revision), 'in the write that closes it');
    recordVerified(w.ctx, { op: 'v3', mission: M, subject: 'g1', words: say(w, 'I checked the rows myself.'), items: ['exh.old.1.r3'] });
    assert.equal((await recordedAt('exh.old.1.r3'))?.body.before44, true);
    // the repair's decision gives r4 (which the repair did not name) to the task it adds
    await drive(engine, w.scheduler, script({
      'architect-repair': (t) => ((t.card as unknown as ArchitectRepairCard).repair.id === filed.repair ? { handBack: { reopen: [], add: [task({ id: 'fast', dependsOn: ['impl'], openItems: ['exh.old.1.r1', 'exh.old.1.r4'] })], note: 'fast takes them' } } : null),
      reviewer: () => null,
    }));
    const r4 = (await recordedAt('exh.old.1.r4'))!;
    const decided = (await events(w, 'repairs', 'decided')).find((e) => e.key === filed.repair)!;
    assert.equal(opOf(w, r4.revision), opOf(w, decided.revision), 'in the decision\'s write');
    assert.equal(await recordedAt('exh.old.1.r5'), undefined, 'nothing is written for the one nobody acted on');
    const out = await read(w);
    assert.equal(out.split('\n')[0], 'Open items of mission m1: 2 open, 2 answered or closed; 1 risk sentence accepted before 4.4: what became of it is not recorded');
    assert.ok(out.includes('[exh.old.1.r1] fix, task old (attempt 1, accepted with risk on exh.old.1 before 4.4, recorded when it was acted on): open') && out.includes('[exh.old.1.r4]') && out.includes('[exh.old.1.r2]') && !out.includes('[exh.old.1.r5]'), out);
    assert.ok(out.includes('  task old: 1 risk sentence accepted before 4.4'), out);
    assert.deepEqual(w.scheduler.card<ConstructorCard>('con.m1.fast.1').openItems?.map((i) => i.id), ['exh.old.1.r1', 'exh.old.1.r4']);
    const r = riskRecord([...(await w.ledger.events({ mission: M }))]);
    assert.equal(withRiskText(r, acceptanceOf(r, 'old', 'exh.old.1')), '2 open; 1 risk sentence accepted before 4.4: what became of it is not recorded');
  });

  it('a re-plan: the decomposition card lists only recorded items; a task of the plan that takes a sentence before 4.4 records it in the write that makes the plan take effect', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    accepted43(w, 'old', 'exh.old.1', ['[S1] not met: slow', 'finding: no docs']);
    const plan2 = () => pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'A CSV parser library that keeps empty fields' }, pmPlan(M).elements[1]!] });
    const withTaker = (): DetailedPlanDoc => ({ ...detailedPlan(M), tasks: [...detailedPlan(M).tasks, { ...detailedPlan(M).tasks.find((t) => t.id === 'impl')!, id: 'fields', goal: 'Keep empty fields', kind: 'integration', module: null, writeScope: ['docs/fields.md'], implements: [], dependsOn: ['impl'], provenance: { planElements: ['e1'] }, openItems: ['exh.old.1.r1'] }] });
    await submitPmBatch(w, { mission: M, plan: plan2(), userWords: ['W-1'] });
    await drive(engine, w.scheduler, script({
      'architect-decompose': (t) => ((t.card as unknown as ArchitectDecomposeCard).revision === null ? { handBack: architect(detailedPlan(M)) } : { handBack: architect(withTaker()) }),
      reviewer: () => null,
    }));
    assert.equal(w.scheduler.card<ArchitectDecomposeCard>('arch.m1.2.1').openItems, undefined, 'a sentence nobody acted on is not on the card');
    const r1 = (await events<RiskItemBody>(w, OPEN_ITEMS_LINE, OPEN_ITEM)).find((e) => e.key === 'exh.old.1.r1')!;
    const effective = (await events(w, 'plan', 'effective')).at(-1)!;
    assert.equal(opOf(w, r1.revision), opOf(w, effective.revision), 'in the write that makes the plan take effect');
    assert.deepEqual(listAllItems(w.ctx, M).items.map((i) => [i.id, i.state]), [['exh.old.1.r2', 'not recorded'], ['exh.old.1.r1', 'open']]);
  });

  it('mp read items, the close and the Secretary\'s digest use the same three notions', async () => {
    const { w, engine } = await world();
    const holdImpl: Script = (t, s) => (t.task.startsWith('con.m1.impl.') ? null : script()(t, s));
    await drive(engine, w.scheduler, holdImpl);
    accepted43(w, 'impl', 'exh.task.m1.impl.1', ['[S1] not met: slow', 'finding: no docs', '[S2] unclear: rows']);
    await pmRepair(w.ctx, { mission: M, words: say(w, 'Please make it faster.'), kind: 'defect', text: 'make it faster', openItems: ['exh.task.m1.impl.1.r1'] });
    closeOpenItem(w.ctx, { op: 'c2', ref: 'exh.task.m1.impl.1.r2', words: say(w, 'Docs are not needed.'), reason: 'docs are not needed' });
    const g1 = readItems(w.ctx, M).find((x) => x.id === 'g1')!;
    assert.deepEqual([g1.state, g1.open, g1.notRecorded], ['accepted with risk', 1, 1]);
    assert.match(itemStateLines(g1)[0]!, /: accepted with risk \(1 open; 1 risk sentence accepted before 4\.4: what became of it is not recorded\)/);
    const r = riskRecord([...(await w.ledger.events({ mission: M }))]);
    assert.equal(withRiskText(r, acceptanceOf(r, 'impl', 'exh.task.m1.impl.1')), '1 open; 1 risk sentence accepted before 4.4: what became of it is not recorded');
    // the Secretary's digest: the recorded item listed, the sentence before 4.4 counted
    const texts = new Map<string, string>();
    const put = (text: string): string => { const id = `t${texts.size}`; texts.set(id, text); return id; };
    const e = { id: 'esc.x', source: 'reviewer-needs-decision', subject: 'task:impl', summary: 'a question', reasons: [], options: ['answer'], lineage: 'l' } as unknown as EscalationBody;
    const inputs = secretaryInputs(M, e, [], [], [...(await w.ledger.events({ mission: M }))], detailedPlan(M).tasks.find((t) => t.id === 'impl'), false, put);
    const digest = texts.get(inputs.materials.find((m) => m.id === 'current-facts')!.ref)!;
    assert.ok(digest.includes('[exh.task.m1.impl.1.r1] fix') && !digest.includes('exh.task.m1.impl.1.r3'), digest);
    assert.ok(digest.includes("Of this task's acceptances with risk made before 4.4: 1 risk sentence accepted before 4.4: what became of it is not recorded (not listed; mp read open-items <mission> --all lists them)."), digest);
    // the close: the recorded open item in full, the sentence before 4.4 as a count per task with the read that lists them
    const c = await pmClose(w.ctx, M, { mode: 'with-risk' });
    assert.deepEqual(c.doc.openItems?.map((i) => i.id), ['exh.task.m1.impl.1.r1']);
    assert.deepEqual(c.doc.notRecorded, [{ task: 'impl', count: 1 }]);
    assert.ok(snapshotLines(c.doc).includes('Risk sentences of acceptances made before 4.4, what became of them is not recorded (mp read open-items m1 --all lists them): task impl: 1'), snapshotLines(c.doc).join('\n'));
  });

  it('F3-4: the tail of an interrupted batch is written only for an acceptance that wrote its first batch itself; one made before 4.4 whose first sentence someone acted on gets nothing more', async () => {
    const reasons = Array.from({ length: ITEM_BATCH + 50 }, (_, i) => `[S1] not met: case ${i}`);
    const holdImpl = (s: Script): Script => (t, st) => (t.task.startsWith('con.m1.impl.') ? null : s(t, st));
    const mine = async (w: World, esc: string) => (await events<RiskItemBody>(w, OPEN_ITEMS_LINE, OPEN_ITEM)).filter((e) => e.body.escalation === esc).map((e) => e.key);
    // 4.4: the first batch written with the acceptance, the rest left out: the next pass writes the rest
    const a = await world();
    await drive(a.engine, a.w.scheduler, holdImpl(script()));
    accepted44(a.w, 'impl', 'exh.task.m1.impl.1', reasons, ITEM_BATCH);
    assert.equal((await mine(a.w, 'exh.task.m1.impl.1')).length, ITEM_BATCH);
    await drive(a.engine, a.w.scheduler, holdImpl(script()));
    assert.equal((await mine(a.w, 'exh.task.m1.impl.1')).length, reasons.length, 'the tail is written');
    // 4.3: no item; the user's words close the first sentence, which records it: a pass writes nothing more
    const b = await world();
    await drive(b.engine, b.w.scheduler, holdImpl(script()));
    accepted43(b.w, 'impl', 'exh.task.m1.impl.1', reasons);
    closeOpenItem(b.w.ctx, { op: 'c1', ref: 'exh.task.m1.impl.1.r1', words: say(b.w, 'The first case does not matter.'), reason: 'the first case does not matter' });
    await drive(b.engine, b.w.scheduler, holdImpl(script()));
    assert.deepEqual(await mine(b.w, 'exh.task.m1.impl.1'), ['exh.task.m1.impl.1.r1'], 'no tail for an acceptance made before 4.4');
    assert.equal((await read(b.w)).split('\n')[0], `Open items of mission m1: 0 open, 1 answered or closed; ${reasons.length - 1} risk sentences accepted before 4.4: what became of them is not recorded`);
  });

  it('a 4.4 acceptance whose later batch an interruption left out is not one made before 4.4: what its sentences give is open', () => {
    const body = (id: string): RiskItemBody => ({ id, kind: 'fix', text: `[S1] not met: ${id}`, task: 'b', attempt: 1, escalation: 'e1', why: 'risk', ref: { standard: 'S1' } });
    const r = riskRecord([
      { revision: 2, line: 'task:b', event: 'accepted', key: '1', body: { k: 1, product: 'pb', judgment: 'j.sec.e1', decision: { escalation: 'e1', option: 'accept-risk', by: 'secretary' }, risks: ['[S1] not met: e1.r1', 'finding: the second'].map((x) => `accepted with its risk by the Secretary on e1: ${x}`) } },
      { revision: 2, line: OPEN_ITEMS_LINE, event: OPEN_ITEM, key: 'e1.r1', body: body('e1.r1') },
    ]);
    assert.deepEqual(r.items.map((i) => [i.id, i.recorded, i.state]), [['e1.r1', true, 'open'], ['e1.r2', false, 'open']]);
    assert.equal(withRiskText(r, acceptanceOf(r, 'b', 'e1')), '2 open');
  });
});
