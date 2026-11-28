// 4.4 (PM design G5; review round 1 of package p10, findings p10-1 to p10-8): a read says only what the record
// establishes (P-7), and two reads never disagree. Each test fails with its fix turned off.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import { OPEN_ITEM, OPEN_ITEMS_LINE } from '../src/flow/openItems.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import type { DetailedTask } from '../src/flow/plandoc.ts';
import { recordItem, withdrawItem } from '../src/flow/requirements.ts';
import { acceptanceOf, riskRecord, withRiskText, type RiskItemBody } from '../src/flow/riskItems.ts';
import { answerEscalation, type EscalationBody } from '../src/flow/secretary.ts';
import { detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { readItems } from '../src/cli/itemsRead.ts';
import { factById } from '../src/memory/index.ts';
import { recordVerified } from '../src/process/openItems.ts';
import { pmRepair } from '../src/process/pm.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
const events = <B = any>(w: World, line: string, event: string) => w.ledger.events<B>({ mission: M, line, event });
const ESTIMATE = { durationMs: 60_000, costMicros: 100_000, basis: 'small' };
const task = (o: Partial<DetailedTask> & { id: string }): DetailedTask => ({
  kind: 'implementation', module: 'parser', goal: `Task ${o.id}`, standards: [{ id: 'S1', text: `${o.id} works` }], requirementItems: [], writeScope: [`src/parser/${o.id}.ts`], readableFiles: [], interpreter: 'node',
  verificationCommands: [{ id: 'test', command: 'npm test' }], implements: [], calls: [], dependsOn: ['iface'], exclusive: [], estimate: ESTIMATE, provenance: 'architect', ...o,
});
type Ev = { revision: number; line: string; event: string; key: string; body: unknown };
const ev = (revision: number, line: string, event: string, key: string, body: unknown): Ev => ({ revision, line, event, key, body });
const item = (revision: number, id: string, taskId: string, attempt = 1): Ev => ev(revision, OPEN_ITEMS_LINE, OPEN_ITEM, id, { id, kind: 'fix', text: `[S1] not met: ${id}`, task: taskId, attempt, escalation: id.replace(/\.r\d+$/, ''), why: 'risk' } satisfies RiskItemBody);

async function world(plan?: () => ReturnType<typeof detailedPlan>): Promise<{ w: World; engine: FlowEngine; script: (over?: Record<string, Script>) => Script }> {
  const w = memoryPorts();
  say(w, SEED_TEXT);
  await seedMission(w, M);
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  const script = (over: Record<string, Script> = {}): Script => {
    const base = happyScript(M, plan);
    return (t, s) => (Object.hasOwn(over, t.card.seat) ? over[t.card.seat]! : base)(t, s);
  };
  return { w, engine: new FlowEngine(w), script };
}
const acceptsRisk: Script = (t) => {
  const c = t.card as unknown as SecretaryCard;
  return c.request.source === 'loop-exhausted' && c.options.some((o) => o.id === 'accept-risk') ? { handBack: secretary(c, 'accept-risk') } : null;
};

describe('4.4 G5, review round 1', () => {
  it('p10-1: an integration ruling that adopts the reviewed attempt quotes every reason of its escalation, has an item for the dependency\'s reopen, names the review it adopted, and closes by that review\'s answers', async () => {
    // the integration's plan, as package 4.1.3's tests build it
    const plan = () => { const p = detailedPlan(M); return { ...p, tasks: [...p.tasks, { ...p.tasks[1]!, id: 'integ', kind: 'integration' as const, module: null, writeScope: [], implements: [], calls: [], dependsOn: ['impl'], provenance: { planElements: ['e1', 'e2'] } }] }; };
    const { w, engine, script } = await world(plan);
    let n = 0;
    let granted = false;
    await drive(engine, w.scheduler, script({
      reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return c.target.includes('integ') ? null : { handBack: reviewer(c, c.target.includes('impl') ? 'rework' : 'pass', { findings: [`dependency finding ${++n}`] }) }; },
      secretary: (t) => { const c = t.card as unknown as SecretaryCard; if (!granted) { granted = true; return { handBack: secretary(c, 'grant', { grantExtra: 1 }) }; } return { handBack: secretary(c, 'accept-risk', { classification: 'important-within-authority', notice: 'accept the dependency risk' }) }; },
    }));
    await drive(engine, w.scheduler, script({ reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return c.target.includes('integ') ? { handBack: { ...reviewer(c, 'rework', { findings: ['quoted integration finding'] }), reopen: [{ task: 'impl', issue: 'dependency is slow' }] } } : { handBack: reviewer(c, 'pass') }; }, secretary: () => null }));
    const esc = (await events<EscalationBody>(w, 'secretary', 'escalation')).map((e) => e.body).filter((e) => e.source === 'loop-exhausted').at(-1)!;
    const words = say(w, 'Accept the integration with the remaining finding as a risk.');
    await answerEscalation(w, { mission: M, escalation: esc.id, option: 'accept-risk', words: `Accept it as it is. (${words})` });
    await drive(engine, w.scheduler, script({ secretary: () => null }));
    assert.ok(await acceptedProduct(flowCtx(w, M), 'integ'));
    const accepted = (await events<any>(w, 'task:integ', 'accepted'))[0]!.body;
    const review = (await events<any>(w, 'task:integ', 'review'))[0]!;
    assert.equal(accepted.review, review.key, 'the acceptance names the review it adopted');
    assert.ok(esc.reasons.includes('dependency is slow'));
    assert.ok(accepted.risks.some((r: string) => r.endsWith(': dependency is slow')), 'the dependency\'s reopen is among the risks accepted');
    const items = (await events<RiskItemBody>(w, OPEN_ITEMS_LINE, OPEN_ITEM)).map((e) => e.body).filter((b) => b.escalation === esc.id);
    assert.deepEqual(items.map((b) => b.text), esc.reasons, 'one item per reason of the escalation');
    assert.ok(items.every((b) => b.task === 'integ' && b.attempt === accepted.k));
  });

  it('p10-1: the outcome of an adopted review: its answer "fixed" closes the item, credited to that review\'s attempt', () => {
    const r = riskRecord([
      item(1, 'e0.r1', 'impl'),
      ev(5, 'task:integ', 'review', 'rev.m1.integ.1', { task: 'rev.m1.integ.1', k: 1, verdict: 'rework', judgment: 'j.rev.m1.integ.1', issues: [], items: [{ item: 'e0.r1', response: 'fixed', reason: 'checked' }] }),
      ev(9, 'task:integ', 'accepted', '2', { k: 2, product: 'p', judgment: 'j.sec.e9', decision: { escalation: 'e9', option: 'accept-risk', by: 'secretary' }, risks: [], review: 'rev.m1.integ.1' }),
    ]);
    const i = r.items.find((x) => x.id === 'e0.r1')!;
    assert.deepEqual(i.closed && [i.closed.how, (i.closed as { task: string; attempt: number }).task, (i.closed as { attempt: number }).attempt], ['fixed', 'integ', 1]);
  });

  it('p10-7: acceptances are applied in the order of their revisions, each with its own review, whatever the order of the task lines', () => {
    const lines = (bAnswer: 'fixed' | 'not-fixed') => [
      item(1, 'e0.r1', 'x'),
      ev(2, 'task:a', 'spec', 'd#1', {}), ev(3, 'task:b', 'spec', 'd#1', {}),
      ev(9, 'task:b', 'review', 'rev.b', { k: 1, items: [{ item: 'e0.r1', response: bAnswer, reason: 'b' }] }),
      ev(10, 'task:b', 'accepted', '1', { k: 1, product: 'pb', judgment: 'j.rev.b' }),
      ev(19, 'task:a', 'review', 'rev.a', { k: 1, items: [{ item: 'e0.r1', response: 'fixed', reason: 'a' }] }),
      ev(20, 'task:a', 'accepted', '1', { k: 1, product: 'pa', judgment: 'j.rev.a' }),
    ];
    const fixedFirst = riskRecord(lines('fixed')).items[0]!;
    assert.equal((fixedFirst.closed as { task: string }).task, 'b', 'the earlier acceptance closes it');
    const carriedFirst = riskRecord(lines('not-fixed')).items[0]!;
    assert.deepEqual([carriedFirst.carried, (carriedFirst.closed as { task: string }).task], [1, 'a'], 'the earlier carry counts, the later fix closes it');
  });

  it('p10-4: an acceptance with risk counts the items it carried, not only those it created, and a 4.4 ruling that carries only is no acceptance made before 4.4', () => {
    const r = riskRecord([
      item(1, 'e0.r1', 'a'),
      ev(9, 'task:b', 'review', 'rev.b', { k: 1, items: [{ item: 'e0.r1', response: 'not-fixed', reason: 'still' }] }),
      ev(10, 'task:b', 'accepted', '1', { k: 1, product: 'pb', judgment: 'j.sec.e1', decision: { escalation: 'e1', option: 'accept-risk', by: 'secretary' }, risks: ['accepted with its risk by the Secretary on e1: open item e0.r1 not fixed: still'] }),
    ]);
    assert.equal(withRiskText(r, acceptanceOf(r, 'b', 'e1')), '1 open');
    // one that carried an item and whose own item is not recorded yet (a batch an interruption left out) is a 4.4 one
    const mixed = riskRecord([
      item(1, 'e0.r1', 'a'),
      ev(9, 'task:b', 'review', 'rev.b', { k: 1, items: [{ item: 'e0.r1', response: 'not-fixed', reason: 'still' }] }),
      ev(10, 'task:b', 'accepted', '1', { k: 1, product: 'pb', judgment: 'j.sec.e1', decision: { escalation: 'e1', option: 'accept-risk', by: 'secretary' }, risks: ['accepted with its risk by the Secretary on e1: open item e0.r1 not fixed: still', 'accepted with its risk by the Secretary on e1: [S1] not met: slow'] }),
    ]);
    assert.equal(withRiskText(mixed, acceptanceOf(mixed, 'b', 'e1')), '2 open');
  });

  it('p10-4, p10-3: mp read items counts a carried item on the repair that took it, and credits a task to a repair only as mp read repairs does', async () => {
    const { w, engine, script } = await world();
    let n = 0;
    await drive(engine, w.scheduler, script({ reviewer: (t) => { const c = t.card as unknown as ReviewerCard; if (!c.target.includes('.impl.')) return { handBack: reviewer(c, 'pass') }; n++; return { handBack: reviewer(c, 'rework', { failing: n % 2 === 1 ? 'S1' : 'S2' }) }; }, secretary: acceptsRisk }));
    const taken = (await events<RiskItemBody>(w, OPEN_ITEMS_LINE, OPEN_ITEM)).map((e) => e.body)[0]!;
    const words = say(w, 'Trying it: empty fields still vanish.');
    const filed = await pmRepair(w.ctx, { mission: M, words, kind: 'defect', text: 'empty fields still vanish', openItems: [taken.id] });
    await drive(engine, w.scheduler, script({
      'architect-repair': (t) => ((t.card as unknown as ArchitectRepairCard).repair.id === filed.repair ? { handBack: { reopen: [], add: [task({ id: 'fix', dependsOn: ['impl'], openItems: [taken.id] })], note: 'fix takes it' } } : null),
      reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return { handBack: reviewer(c, c.target.includes('.fix.') ? 'rework' : 'pass', { failing: 'S1' }) }; },
      secretary: acceptsRisk,
    }));
    const own = (await events<RiskItemBody>(w, OPEN_ITEMS_LINE, OPEN_ITEM)).map((e) => e.body).filter((b) => b.task === 'fix');
    const row = readItems(w.ctx, M).find((x) => x.kind === 'repair' && x.id === filed.repair)!;
    assert.equal(row.state, 'accepted with risk');
    assert.equal(row.open, own.length + 1, 'its own items and the one it carried');
  });

  it('p10-2: mp read items gives the proof the close reads: "recomputing" while a withdrawn basis has not reached the label, never the cached "proven"', async () => {
    const { w, engine, script } = await world();
    await drive(engine, w.scheduler, script());
    const proven = readItems(w.ctx, M).find((x) => x.id === 'g1')!;
    assert.equal(proven.state, 'accepted after a passing review');
    assert.equal(proven.proof, 'proven');
    // the evaluator has work left (a recomputation not yet reached the product): its cached label still says proven
    w.memory.maintenance((tx) => { tx.stmt('INSERT OR IGNORE INTO lbl_work (node, queued, dirty, phase, cursor) VALUES (?, 1, 0, 1, NULL)').run('t:prod.con.m1.impl.1'); });
    const cached = w.memory.stmt('SELECT label FROM lbl_labels WHERE target = ?').get('prod.con.m1.impl.1') as { label: string };
    assert.equal(cached.label, 'proven');
    const g1 = readItems(w.ctx, M).find((x) => x.id === 'g1')!;
    assert.equal(g1.proof, 'recomputing', 'what the close would read, not the cached label');
    // a basis withdrawn: the label the evaluator reached
    w.memory.maintenance((tx) => { tx.stmt('DELETE FROM lbl_work').run(); });
    await withdrawItem(w, { mission: M, item: 's1', reason: 'the user dropped the tests' });
    assert.notEqual(readItems(w.ctx, M).find((x) => x.id === 'g1')!.proof, 'proven');
  });

  it('p10-5: a taken item that names an issue, answered fixed, is the Reviewer\'s answer to that issue in its judgment, so the fix tracker reads it; an explicit response stands', async () => {
    const { w, engine, script } = await world();
    let n = 0;
    await drive(engine, w.scheduler, script({ reviewer: (t) => { const c = t.card as unknown as ReviewerCard; if (!c.target.includes('.impl.')) return { handBack: reviewer(c, 'pass') }; n++; return { handBack: reviewer(c, 'rework', { failing: n % 2 === 1 ? 'S1' : 'S2', findings: n === 3 ? ['quoted newlines are lost'] : [] }) }; }, secretary: acceptsRisk }));
    const items = (await events<RiskItemBody>(w, OPEN_ITEMS_LINE, OPEN_ITEM)).map((e) => e.body);
    // the finding of the accepted review: its item names the issue record the finding became
    const onIssue = items.find((b) => b.kind === 'finding' && b.ref !== undefined && 'issue' in b.ref)!;
    assert.ok(onIssue !== undefined, `an item names the issue its finding became: ${JSON.stringify(items)}`);
    const issue = (onIssue.ref as { issue: string }).issue;
    const words = say(w, 'Trying it: quoted newlines still vanish.');
    const filed = await pmRepair(w.ctx, { mission: M, words, kind: 'defect', text: 'quoted newlines still vanish', openItems: [onIssue.id] });
    await drive(engine, w.scheduler, script({
      'architect-repair': (t) => ((t.card as unknown as ArchitectRepairCard).repair.id === filed.repair ? { handBack: { reopen: [], add: [task({ id: 'fix', dependsOn: ['impl'], openItems: [onIssue.id] })], note: 'fix takes it' } } : null),
      reviewer: (t) => ({ handBack: reviewer(t.card as unknown as ReviewerCard, 'pass') }),
    }));
    const card = w.scheduler.card<ReviewerCard>('rev.m1.fix.1');
    assert.equal(card.openItems?.[0]?.issue, issue, 'the card carries the issue the item is about');
    const judgment = factById(w.memory, 'judgment', 'j.rev.m1.fix.1')!.record as unknown as { issues: Array<{ issue: string; response: string }> };
    assert.deepEqual(judgment.issues.filter((i) => i.issue === issue).map((i) => i.response), ['fixed'], 'answered once, fixed');
  });

  it('p10-6: mp pm verified resolves a bare id against the record: a requirement item named R-1 is that item; where a repair R-1 exists too, it says so and takes item:R-1 or repair:R-1', async () => {
    const { w, engine, script } = await world();
    await drive(engine, w.scheduler, script());
    const words = say(w, 'R-1 is one of my requirements: the parser keeps quotes. It works in the field.');
    await recordItem(w, { mission: M, item: 'R-1', type: 'acceptance', text: 'The parser keeps quotes', source: { kind: 'words', words, quote: 'the parser keeps quotes' } });
    assert.equal(recordVerified(w.ctx, { op: 'v1', mission: M, subject: 'R-1', words, items: [] }).subject, 'item:R-1', 'no repair R-1: the item');
    const repairWords = say(w, 'Trying it: the parser drops a field.');
    const r = await pmRepair(w.ctx, { mission: M, words: repairWords, kind: 'defect', text: 'the parser drops a field' });
    assert.equal(r.repair, 'R-1');
    assert.throws(() => recordVerified(w.ctx, { op: 'v2', mission: M, subject: 'R-1', words: repairWords, items: [] }), /names both a requirement item and a repair of mission m1: name the one the user checked, item:R-1 or repair:R-1/);
    assert.equal(recordVerified(w.ctx, { op: 'v3', mission: M, subject: 'repair:R-1', words: repairWords, items: [] }).subject, 'repair:R-1');
    assert.equal(readItems(w.ctx, M).find((x) => x.kind === 'requirement' && x.id === 'R-1')!.verified.length, 1, 'the item keeps only its own statement');
  });

  it('p10-8: the Secretary\'s card lists an item a repair\'s reopen gave to the task, for the escalated attempt', async () => {
    const { w, engine, script } = await world();
    let n = 0;
    await drive(engine, w.scheduler, script({ reviewer: (t) => { const c = t.card as unknown as ReviewerCard; if (!c.target.includes('.impl.')) return { handBack: reviewer(c, 'pass') }; n++; return { handBack: reviewer(c, 'rework', { failing: n % 2 === 1 ? 'S1' : 'S2' }) }; }, secretary: acceptsRisk }));
    const first = (await events<RiskItemBody>(w, OPEN_ITEMS_LINE, OPEN_ITEM)).map((e) => e.body)[0]!;
    // iface takes it through a repair's reopen, and its fresh loop is used up
    const words = say(w, 'Trying it: the interface drops empty fields.');
    const filed = await pmRepair(w.ctx, { mission: M, words, kind: 'defect', text: 'the interface drops empty fields', openItems: [first.id] });
    await drive(engine, w.scheduler, script({
      'architect-repair': (t) => ((t.card as unknown as ArchitectRepairCard).repair.id === filed.repair ? { handBack: { reopen: [{ task: 'iface', issue: 'empty fields', open_items: [first.id] }], add: [], note: 'iface owns it' } } : null),
      reviewer: (t) => { const c = t.card as unknown as ReviewerCard; return { handBack: reviewer(c, c.target.includes('.iface.') ? 'rework' : 'pass') }; },
      secretary: () => null,
    }));
    const sec = w.scheduler.queued('secretary').map((t) => t.card as unknown as SecretaryCard).find((c) => c.request.subject === 'task:iface' && c.request.source === 'loop-exhausted');
    assert.ok(sec !== undefined, 'the fresh loop of iface is used up');
    const facts = w.ledger.content.get(sec.materials.find((m) => m.id === 'current-facts')!.ref as never);
    assert.ok(facts.includes(`[${first.id}] fix, attempt ${first.attempt} of task impl, taken by this task`), facts);
  });
});

describe('4.4 G5, review round 1: compatibility', () => {
  it('an acceptance without `review` (4.3, and every path but an integration\'s adoption) reads its attempt\'s last review, as before', () => {
    const r = riskRecord([
      item(1, 'e0.r1', 'x'),
      ev(5, 'task:t', 'review', 'rev.t.1', { k: 1, items: [{ item: 'e0.r1', response: 'fixed', reason: 'ok' }] }),
      ev(6, 'task:t', 'accepted', '1', { k: 1, product: 'p', judgment: 'j.rev.t.1' }),
    ]);
    assert.equal(r.items[0]!.closed?.how, 'fixed');
  });

  it('an acceptance with risk 4.3 recorded (no item, nothing carried) reads as made before 4.4 in the one text status, the tree and mp read items share', () => {
    const r = riskRecord([ev(6, 'task:t', 'accepted', '1', { k: 1, product: 'p', judgment: 'j.sec.e1', decision: { escalation: 'e1', option: 'accept-risk', by: 'secretary' }, risks: ['accepted with its risk by the Secretary on e1: [S1] not met: slow'] })]);
    assert.equal(withRiskText(r, acceptanceOf(r, 't', 'e1')), '1 risk(s); what became of them is not recorded');
  });
});

describe('4.4 G5, review round 1: p10-3', () => {
  it('a repair whose card for a task another repair replaced before the task was accepted is not credited with that acceptance; mp read items and mp read repairs agree', async () => {
    const { w, engine, script } = await world();
    const hold: Script = (t, s) => (t.task.startsWith('con.m1.impl.') ? null : script()(t, s));
    await drive(engine, w.scheduler, hold);
    const impl = detailedPlan(M).tasks.find((t) => t.id === 'impl')!;
    const change = (goal: string) => ({ reopen: [], add: [], change: [{ ...impl, goal }], note: goal });
    const file = async (text: string): Promise<string> => (await pmRepair(w.ctx, { mission: M, words: say(w, `Trying it: ${text}.`), kind: 'defect', text })).repair;
    const r1 = await file('the parser should trim fields');
    await drive(engine, w.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: change('Implement the parser, trimming fields') } : hold(t, s)));
    const r2 = await file('the parser should keep fields as they are');
    await drive(engine, w.scheduler, (t, s) => (t.card.seat === 'architect-repair' ? { handBack: change('Implement the parser, keeping fields as they are') } : hold(t, s)));
    await drive(engine, w.scheduler, script());
    assert.ok(await acceptedProduct(flowCtx(w, M), 'impl'));
    const rows = readItems(w.ctx, M);
    const row1 = rows.find((x) => x.kind === 'repair' && x.id === r1)!;
    const row2 = rows.find((x) => x.kind === 'repair' && x.id === r2)!;
    assert.notEqual(row1.state, 'accepted after a passing review', `${r1}'s card did not run: ${JSON.stringify(row1)}`);
    assert.equal(row1.proof, null, 'no proof is credited to it');
    assert.equal(row2.state, 'accepted after a passing review');
    const repairs = (await import('../src/cli/workReads.ts')).repairsRead(w.memory, w.memory.data, M).repairs;
    assert.deepEqual(repairs.map((r) => [r.id, r.done]), [[r1, false], [r2, true]], 'the repair read says the same');
  });
});
