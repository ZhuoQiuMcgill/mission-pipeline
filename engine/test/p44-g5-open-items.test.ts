// 4.4 (PM design G5; the plan's F11 where G5 is silent, and the reads of F15): what is left at the cap is
// recorded by the program and read by anyone. An acceptance with risk writes one open item per risk accepted
// in its own write; a task takes one when its card names it (a repair's or a re-plan's); its cards list it and
// its Reviewer answers it; it is closed when that task is accepted with it answered fixed (after a pass or a
// ruling), and carried when accepted again without; the user's words close one (the way through). A deferral
// is an open item, told once. An acceptance with risk made under 4.3 is listed as not recorded, and nothing is
// written for it. Status and tree tell "accepted with risk (n open)" from "accepted"; the close lists every item.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson } from '../src/common/hash.ts';
import type { ContentHash, MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import type { DetailedTask } from '../src/flow/plandoc.ts';
import { OPEN_ITEM, OPEN_ITEMS_LINE } from '../src/flow/openItems.ts';
import { riskItemBodies, riskItemsOf, type RiskItemBody } from '../src/flow/riskItems.ts';
import { constructorDone, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import type { EscalationBody } from '../src/flow/secretary.ts';
import { appendRecords, factById } from '../src/memory/index.ts';
import { pmClose } from '../src/process/close.ts';
import { readItems } from '../src/cli/itemsRead.ts';
import { closeOpenItem, listAllItems, recordVerified } from '../src/process/openItems.ts';
import { pmRepair } from '../src/process/pm.ts';
import { resolveSubtasks } from '../src/cli/layers.ts';
import { buildGraph, tree } from '../src/cli/tree.ts';
import type { ConstructorCard, ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { ArchitectRepairCard } from '../src/seat/cards/architect.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { cli } from './cli-fixtures.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
const events = <B = any>(w: World, line: string, event: string) => w.ledger.events<B>({ mission: M, line, event });
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
/** The Secretary accepts a used-up loop with its risk, and decides nothing else. */
const acceptsRisk: Script = (t) => {
  const c = t.card as unknown as SecretaryCard;
  return c.request.source === 'loop-exhausted' && c.options.some((o) => o.id === 'accept-risk') ? { handBack: secretary(c, 'accept-risk') } : null;
};

/**
 * Task impl's Reviewer sends every attempt back (S1 then S2 not met; a finding on the first, then answered not
 * fixed), its loop is used up and the Secretary accepts it with its risk: the items it left, and its escalation.
 */
async function acceptedWithRisk(): Promise<{ w: World; engine: FlowEngine; esc: EscalationBody; items: RiskItemBody[] }> {
  const { w, engine } = await world();
  let n = 0;
  await drive(engine, w.scheduler, script({
    reviewer: (t) => {
      const c = t.card as unknown as ReviewerCard;
      if (!c.target.includes('.impl.')) return { handBack: reviewer(c, 'pass') };
      n++;
      return { handBack: reviewer(c, 'rework', { failing: n % 2 === 1 ? 'S1' : 'S2', ...(n === 1 ? { findings: ['the parser drops a trailing empty field'] } : {}) }) };
    },
    secretary: acceptsRisk,
  }));
  const esc = (await events<EscalationBody>(w, 'secretary', 'escalation')).map((e) => e.body).find((e) => e.source === 'loop-exhausted')!;
  assert.ok(esc !== undefined, 'the loop was used up');
  const items = (await events<RiskItemBody>(w, OPEN_ITEMS_LINE, OPEN_ITEM)).map((e) => e.body);
  return { w, engine, esc, items };
}

describe('4.4 G5: what is left at the cap is recorded by the program', () => {
  it('an acceptance with risk writes one open item per distinct reason, in its own write, with its kind and reference; nothing else of the acceptance changes', async () => {
    const { w, esc, items } = await acceptedWithRisk();
    const acc = (await events<any>(w, 'task:impl', 'accepted')).at(-1)!;
    assert.equal(acc.body.decision.option, 'accept-risk');
    assert.deepEqual(Object.keys(acc.body).sort(), ['decision', 'judgment', 'k', 'product', 'risks'], 'the acceptance stores what 4.3 stored');
    assert.deepEqual(items.map((i) => i.id), esc.reasons.map((_, i) => `${esc.id}.r${i + 1}`));
    assert.deepEqual(items.map((i) => i.text), esc.reasons, 'each reason, as the escalation gave it');
    assert.ok(items.every((i) => i.task === 'impl' && i.attempt === acc.body.k && i.escalation === esc.id && i.why === 'risk'));
    const standard = items.find((i) => i.text.startsWith('['))!;
    assert.equal(standard.kind, 'fix');
    assert.match(JSON.stringify(standard.ref), /"standard":"S[12]"/);
    const issue = items.find((i) => i.text.startsWith('issue '))!;
    assert.equal(issue.kind, 'fix');
    assert.ok('issue' in (issue.ref ?? {}) && (issue.ref as { issue: string }).issue.startsWith('finding:'));
    // one write: the items are recorded under the operation of the acceptance
    const opOf = (rev: number): string => (w.memory.stmt('SELECT op FROM log WHERE rev = ?').get(rev) as { op: string }).op;
    const ops = new Set((await events(w, OPEN_ITEMS_LINE, OPEN_ITEM)).map((e) => opOf(e.revision)));
    assert.deepEqual([...ops], [opOf(acc.revision)]);
    // the ruling keeps the Reviewer's answers on the accepted product (4.3 carried none), so the fix tracker reads them
    const ruling = factById(w.memory, 'judgment', acc.body.judgment)!.record as unknown as { issues: Array<{ issue: string; response: string }> };
    assert.deepEqual(ruling.issues.map((i) => [i.issue, i.response]), [[(issue.ref as { issue: string }).issue, 'not-fixed']]);
  });

  it('the reads: mp read open-items lists each item open, with its age and that no task takes it; status says "accepted with risk (n open)"; the tree counts what is still open', async () => {
    const { w, esc, items } = await acceptedWithRisk();
    const all = listAllItems(w.ctx, M);
    assert.deepEqual(all.items.map((i) => [i.id, i.recorded, i.closed, i.carried, i.takenBy.length]), items.map((i) => [i.id, true, null, 0, 0]));
    assert.ok(all.items.every((i) => typeof i.at === 'number'));
    const r = await cli(w.dir, ['read', 'open-items', 'm1']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`Open items of mission m1: ${items.length} open, 0 answered or closed`));
    assert.ok(r.out.includes(`[${items[0]!.id}] fix, task impl (attempt ${items[0]!.attempt}, accepted with risk on ${esc.id}): open, `), r.out);
    assert.match(r.out, /old; taken by no task\n  \[S[12]\] not met: checked/);
    const s = await resolveSubtasks(w.ctx);
    const impl = s.entries.find((e) => e.kind === 'task' && e.id === 'impl')!;
    assert.match(impl.label, new RegExp(`^accepted with risk \\(${items.length} open\\)`));
    const iface = s.entries.find((e) => e.kind === 'task' && e.id === 'iface')!;
    assert.match(iface.label, /^accepted(,|$)/, 'an acceptance after a pass reads as before');
    const t = tree(w.ctx, buildGraph(w.ctx, { mission: M }), M).text;
    assert.match(t, new RegExp(`accepted with its risk by the Secretary on ${esc.id.replace(/\./g, '\\.')} .*: ${items.length} open \\(mp read open-items m1\\)`));
  });

  it('a repair names an item and its Architect gives it to a task: the task\'s cards list it, its Reviewer must answer it, and its acceptance with the item answered fixed closes it; the other stays open', async () => {
    const { w, engine, items } = await acceptedWithRisk();
    const [taken, other] = items as [RiskItemBody, RiskItemBody];
    const words = say(w, 'Trying it: the empty fields are still wrong.');
    const filed = await pmRepair(w.ctx, { mission: M, words, kind: 'defect', text: 'the empty fields are still wrong', openItems: [taken.id] });
    assert.deepEqual((await events<any>(w, 'repairs', 'repair')).find((e) => e.key === filed.repair)!.body.openItems, [taken.id]);
    const repairScript = (held: boolean): Script => script({
      'architect-repair': (t) => ((t.card as unknown as ArchitectRepairCard).repair.id === filed.repair ? { handBack: { reopen: [], add: [task({ id: 'fix', dependsOn: ['impl'], openItems: [taken.id] })], note: 'fix takes the item' } } : null),
      reviewer: (t) => (held && (t.card as unknown as ReviewerCard).target.includes('.fix.') ? null : { handBack: reviewer(t.card as unknown as ReviewerCard, 'pass') }),
      secretary: acceptsRisk,
    });
    await drive(engine, w.scheduler, repairScript(true));
    // the hand-back that leaves the listed item unanswered is refused, with the reason
    const q = w.scheduler.queued('reviewer').find((t) => t.task === 'rev.m1.fix.1')!;
    const without = reviewer(w.scheduler.card<ReviewerCard>(q.task), 'pass');
    delete (without as { item_responses?: unknown }).item_responses;
    const refused = await w.scheduler.run(q.task, { handBack: without });
    assert.match(refused.join('\n'), new RegExp(`item_responses: open item "${taken.id.replace(/\./g, '\\.')}" has no answer`));
    await drive(engine, w.scheduler, repairScript(false));
    const con = w.scheduler.card<ConstructorCard>('con.m1.fix.1');
    assert.deepEqual(con.openItems?.map((i) => i.id), [taken.id]);
    assert.equal(con.openItems?.[0]?.from, `task impl, attempt ${taken.attempt}`);
    const rev = w.scheduler.card<ReviewerCard>('rev.m1.fix.1');
    assert.deepEqual(rev.openItems?.map((i) => i.id), [taken.id]);
    const review = (await events<any>(w, 'task:fix', 'review')).at(-1)!.body;
    assert.deepEqual(review.items, [{ item: taken.id, response: 'fixed', reason: 'checked' }]);
    const all = listAllItems(w.ctx, M).items;
    const a = all.find((i) => i.id === taken.id)!;
    assert.deepEqual(a.closed && { how: a.closed.how, task: (a.closed as { task: string }).task }, { how: 'fixed', task: 'fix' });
    assert.deepEqual(a.takenBy, [{ task: 'fix', by: `repair ${filed.repair}` }]);
    assert.deepEqual(a.namedBy, [filed.repair]);
    assert.equal(all.find((i) => i.id === other.id)!.closed, null, 'the item no task took stays open');
  });

  it('carried: the task that took an item is accepted with risk with it not fixed: the item stays open and its carry count rises; the line that carries it is no new item', async () => {
    const { w, engine, items } = await acceptedWithRisk();
    const taken = items[0]!;
    const words = say(w, 'Trying it: the empty fields are still wrong.');
    const filed = await pmRepair(w.ctx, { mission: M, words, kind: 'defect', text: 'the empty fields are still wrong', openItems: [taken.id] });
    let n = 0;
    await drive(engine, w.scheduler, script({
      'architect-repair': (t) => ((t.card as unknown as ArchitectRepairCard).repair.id === filed.repair ? { handBack: { reopen: [], add: [task({ id: 'fix', dependsOn: ['impl'], openItems: [taken.id] })], note: 'fix takes the item' } } : null),
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (!c.target.includes('.fix.')) return { handBack: reviewer(c, 'pass') };
        n++;
        return { handBack: reviewer(c, 'rework', { failing: 'S1' }) };
      },
      secretary: acceptsRisk,
    }));
    const acc = (await events<any>(w, 'task:fix', 'accepted')).at(-1)!.body;
    assert.equal(acc.decision?.option, 'accept-risk');
    assert.ok(acc.risks.some((r: string) => r.includes(`open item ${taken.id} not fixed: checked`)), 'the decider saw the item not fixed among the reasons');
    const all = listAllItems(w.ctx, M).items;
    const a = all.find((i) => i.id === taken.id)!;
    assert.equal(a.closed, null);
    assert.equal(a.carried, 1);
    assert.equal(a.answer?.response, 'not-fixed');
    const own = all.filter((i) => i.task === 'fix');
    assert.ok(own.length > 0 && own.every((i) => !i.text.startsWith('open item ')), 'the carried item is not written again as a new one');
  });

  it('the way through: mp pm open-item close closes one on the user\'s words; mp pm verified records the user\'s statement (never proof) and closes the items it names; both run again write nothing more', async () => {
    const { w, items } = await acceptedWithRisk();
    const [first, second] = items as [RiskItemBody, RiskItemBody];
    const words = say(w, 'Leave the first one, it does not matter. The parser works in the field.');
    const closed = closeOpenItem(w.ctx, { op: 'close-1', ref: first.id, words, reason: 'the user does not want it' });
    assert.equal(closed.repeated, false);
    const again = closeOpenItem(w.ctx, { op: 'close-2', ref: `m1/${first.id}`, words, reason: 'the user does not want it' });
    assert.equal(again.repeated, true, 'the same close run again (a new op) writes nothing');
    assert.throws(() => closeOpenItem(w.ctx, { op: 'close-3', ref: first.id, words, reason: 'another reason' }), /is closed already: on the user's words/);
    const labelsBefore = w.memory.stmt('SELECT target, label FROM lbl_labels ORDER BY target').all();
    const v = recordVerified(w.ctx, { op: 'v-1', mission: M, subject: 'g1', words, items: [second.id, first.id] });
    assert.deepEqual([v.closed, v.already], [[second.id], [first.id]]);
    assert.equal(recordVerified(w.ctx, { op: 'v-2', mission: M, subject: 'g1', words, items: [first.id, second.id] }).repeated, true);
    assert.deepEqual(w.memory.stmt('SELECT target, label FROM lbl_labels ORDER BY target').all(), labelsBefore, 'no proof label changes');
    const all = listAllItems(w.ctx, M).items;
    assert.deepEqual(all.filter((i) => i.closed !== null).map((i) => [i.id, i.closed!.how]), [[first.id, 'words'], [second.id, 'words']]);
    const g1 = readItems(w.ctx, M).find((x) => x.id === 'g1')!;
    assert.deepEqual(g1.verified, [words]);
    const r = await cli(w.dir, ['read', 'items', 'm1']);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(`the user's statement on ${words}: checked in the field and holds (the user's words, not proof)`), r.out);
    assert.throws(() => recordVerified(w.ctx, { op: 'v-3', mission: M, subject: 'nope', words, items: [] }), /has no requirement item and no repair nope/);
  });

  it('mp read items: one line per requirement item and per repair, with its state; an acceptance with risk is told apart, with its open items', async () => {
    const { w, items } = await acceptedWithRisk();
    const xs = readItems(w.ctx, M);
    const g1 = xs.find((x) => x.id === 'g1')!;
    assert.equal(g1.state, 'accepted with risk');
    assert.equal(g1.open, items.length);
    assert.deepEqual(g1.tasks.map((t) => [t.task, t.state]), [['iface', 'accepted'], ['impl', 'accepted with risk']]);
    assert.equal(xs.find((x) => x.id === 'a1')!.state, 'not work');
    const r = await cli(w.dir, ['read', 'items', 'm1']);
    assert.match(r.out, new RegExp(`\\[g1\\] goal, W-1: accepted with risk \\(${items.length} open\\)`));
    assert.match(r.out, /\[s1\] acceptance, W-1: accepted with risk/);
  });

  it('the close lists every open item and is not refused', async () => {
    const { w, items } = await acceptedWithRisk();
    const c = await pmClose(w.ctx, M, { mode: 'with-risk' });
    assert.deepEqual(c.doc.openItems?.map((i) => i.id), items.map((i) => i.id));
  });
});

describe('4.4 G5: deferrals, and the record of 4.3', () => {
  it('a Reviewer\'s deferral is an open item, written with its review; its notice is raised once, not at each re-review; a later attempt accepted with the issue fixed closes it', async () => {
    const { w, engine } = await world();
    let n = 0;
    await drive(engine, w.scheduler, script({
      reviewer: (t) => {
        const c = t.card as unknown as ReviewerCard;
        if (!c.target.includes('.impl.')) return { handBack: reviewer(c, 'pass') };
        n++;
        if (n === 1) return { handBack: reviewer(c, 'rework', { findings: ['quoted newlines are lost'] }) };
        const r = reviewer(c, n === 4 ? 'pass' : 'rework', { failing: n === 2 ? 'S1' : 'S2' });
        // attempts 2 and 3 defer the finding; attempt 4 answers it fixed
        return { handBack: { ...r, issue_responses: r.issue_responses.map((i) => (n < 4 ? { ...i, response: 'deferred' as const, owner: 'the docs task', reason: 'documented later' } : i)) } };
      },
    }));
    const deferred = (await events<RiskItemBody>(w, OPEN_ITEMS_LINE, OPEN_ITEM)).map((e) => e.body).filter((b) => b.kind === 'deferred');
    assert.equal(deferred.length, 1, 'one item per task and issue');
    assert.equal(deferred[0]!.task, 'impl');
    assert.equal(deferred[0]!.attempt, 2);
    assert.equal(w.ledger.notices.filter((x) => x.category === 'reviewer-issue-deferred').length, 1, 'told once');
    const item = listAllItems(w.ctx, M).items.find((i) => i.id === deferred[0]!.id)!;
    assert.deepEqual(item.closed && [item.closed.how, (item.closed as { attempt: number }).attempt], ['fixed', 4]);
  });

  it('compatibility: an acceptance with risk made under 4.3 (no item) is listed with the same ids as not recorded; a pass writes nothing for it; it can be closed on the user\'s words', async () => {
    const { w, engine } = await world();
    await drive(engine, w.scheduler, script());
    // a 4.3 acceptance with risk of a task line: its sentences, no item (written as 4.3 wrote it)
    const risks = ['accepted with its risk by the Secretary on exh.old.1: [S1] not met: slow', 'accepted with its risk by the Secretary on exh.old.1: finding: no docs'];
    w.memory.write({}, (tx) => appendRecords(tx, [{ kind: 'flow.event', mission: M, line: 'task:old', event: 'accepted', key: '1', body: tx.data.put(canonicalJson({ k: 1, product: 'prod.old', judgment: 'j.sec.exh.old.1', decision: { escalation: 'exh.old.1', option: 'accept-risk', by: 'secretary' }, risks })) as ContentHash }]));
    const listed = listAllItems(w.ctx, M).items;
    assert.deepEqual(listed.map((i) => [i.id, i.kind, i.recorded, i.text]), [['exh.old.1.r1', 'fix', false, '[S1] not met: slow'], ['exh.old.1.r2', 'finding', false, 'finding: no docs']]);
    await engine.reconcile();
    assert.deepEqual((await events(w, OPEN_ITEMS_LINE, OPEN_ITEM)).length, 0, 'nothing is written for a 4.3 acceptance');
    const r = await cli(w.dir, ['read', 'open-items', 'm1']);
    assert.match(r.out, /\[exh\.old\.1\.r1\] fix, task old \(attempt 1, accepted with risk on exh\.old\.1\): not recorded as an item \(an acceptance with risk made before 4\.4\): what became of it is not recorded/);
    const words = say(w, 'The speed does not matter.');
    closeOpenItem(w.ctx, { op: 'c-old', ref: 'exh.old.1.r1', words, reason: 'speed does not matter' });
    assert.ok(listAllItems(w.ctx, M).items.find((i) => i.id === 'exh.old.1.r1')!.closed !== null);
  });

  it('riskItemBodies: one item per distinct reason, every form kept (an unknown form is a fix); a carried item is not a new one', () => {
    const b = riskItemBodies('t', 2, 'e', ['[S1] unclear: why', 'finding: x', 'finding: x', 'a program run did not pass on the product: test (1 failed; evidence ev1)', 'open item e0.r1 not fixed: still', 'the standard S3 cannot be verified from what is visible']);
    assert.deepEqual(b.map((x) => [x.id, x.kind]), [['e.r1', 'fix'], ['e.r2', 'finding'], ['e.r3', 'run'], ['e.r4', 'fix']]);
    assert.deepEqual(riskItemsOf([]), []);
  });
});
