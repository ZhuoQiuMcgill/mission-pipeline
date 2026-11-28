// 4.4 (PM design G5 with F10, the seam of packages p9 and p10): something to verify is an open item of kind
// `verify`. A standard the Reviewer could not verify, accepted with risk, is one, with its standard and what is
// needed taken from the structured copy (the escalation's facts, the accepted review's `unverifiable`), never
// parsed from the sentence. A standard a person checks is one, written in the write that accepts its task (by a
// pass or by a ruling), one per task and standard; nothing waits for it and it blocks nothing. The user's
// statement closes one, or a later review of a task that took it and answered it fixed. `mp read open-items`
// shows the kind; `mp read items` counts it with the others. A plan and an acceptance of 4.3 have neither.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import { OPEN_ITEM, OPEN_ITEMS_LINE } from '../src/flow/openItems.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import type { DetailedPlanDoc } from '../src/flow/plandoc.ts';
import { recordItem } from '../src/flow/requirements.ts';
import { acceptanceOf, personItemId, riskItemBodies, riskRecord, withRiskText, type RiskItemBody } from '../src/flow/riskItems.ts';
import { detailedPlan, drive, happyScript, pmPlan, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import type { EscalationBody } from '../src/flow/secretary.ts';
import type { FlowTask } from '../src/flow/ports.ts';
import { readItems } from '../src/cli/itemsRead.ts';
import { answerOpenItem, closeOpenItem, listAllItems, recordVerified } from '../src/process/openItems.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import type { ReviewerResult } from '../src/seat/results.ts';
import { cli } from './cli-fixtures.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
type Standards = DetailedPlanDoc['tasks'][number]['standards'];
const events = <B = any>(w: World, line: string, event?: string) => w.ledger.events<B>({ mission: M, line, ...(event !== undefined ? { event } : {}) });
/** The operation a revision was written under: records of one write share it. */
const opOf = (w: World, rev: number): string => (w.memory.stmt('SELECT op FROM log WHERE rev = ?').get(rev) as { op: string }).op;

function planWith(standards: Standards): () => DetailedPlanDoc {
  return () => {
    const p = detailedPlan(M);
    return { ...p, tasks: p.tasks.map((t) => (t.id === 'impl' ? { ...t, standards } : t)) };
  };
}

async function world(plan: () => DetailedPlanDoc): Promise<{ w: World; engine: FlowEngine; script: (over?: Record<string, Script>) => Script }> {
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

type Met = { met: ReviewerResult['judgments'][number]['met']; reason?: string; needed?: string };
/** A Reviewer's hand-back judging every standard it may judge (a person's is left out), `yes` unless `met` says otherwise. */
function judge(c: ReviewerCard, verdict: ReviewerResult['verdict'], met: Record<string, Met> = {}): ReviewerResult {
  const ev = c.verificationRuns[0]?.evidence;
  return {
    judgments: c.standards.filter((s) => s.check !== 'person').map((s) => {
      const m = met[s.id];
      return { standard: s.id, met: m?.met ?? 'yes', reason: m?.reason ?? `judged ${s.id}`, ...(m?.needed !== undefined ? { needed: m.needed } : {}), evidence: m?.met === 'cannot-verify' ? [] : [ev !== undefined ? `evidence:${ev}` : 'file:index.ts:1'] };
    }),
    gap_responses: c.selfReportedGaps.map((g) => ({ gap: g.id, response: 'noted' })),
    issue_responses: c.openIssues.map((i) => ({ issue: i.issue, response: 'fixed', reason: 'checked' })),
    findings: [],
    verdict,
    ...((c.openItems ?? []).length > 0 ? { item_responses: c.openItems!.map((i) => ({ item: i.id, response: 'fixed' as const, reason: 'checked' })) } : {}),
  };
}
const reviewerOf = (forImpl: (c: ReviewerCard) => ReviewerResult): Script => (t: FlowTask) => {
  const c = t.card as unknown as ReviewerCard;
  return { handBack: c.target.includes('.impl.') ? forImpl(c) : judge(c, 'pass') };
};
const accepts = (source: string): Script => (t) => {
  const c = t.card as unknown as SecretaryCard;
  return c.request.source === source && c.options.some((o) => o.id === 'accept-risk') ? { handBack: secretary(c, 'accept-risk') } : null;
};

const S2_UNV: Met = { met: 'cannot-verify', reason: 'no device here; needed: not shown', needed: 'a run on the real device' };
const LINE = '[S2] cannot be verified: no device here; needed: not shown; needed: a run on the real device';
const PERSON: Standards = [
  { id: 'S1', text: 'Parses quoted fields', check: 'reading' },
  { id: 'S2', text: 'Unit tests pass', check: 'command' },
  { id: 'S3', text: 'A user opens a real export with it', check: 'person' },
];

/** impl's only open standard cannot be verified; the Secretary accepts the fourth answer's escalation with its risk. */
async function unverifiableAccepted(plan: () => DetailedPlanDoc) {
  const { w, engine, script } = await world(plan);
  await drive(engine, w.scheduler, script({ reviewer: reviewerOf((c) => judge(c, 'needs-decision', { S2: S2_UNV })), secretary: accepts('reviewer-needs-decision') }));
  const esc = 'unv.rev.m1.impl.1';
  const acc = (await events(w, 'task:impl', 'accepted')).find((e) => e.key === '1')!;
  assert.equal(acc.body.decision.escalation, esc, 'accepted on the fourth answer\'s escalation');
  const items = await events<RiskItemBody>(w, OPEN_ITEMS_LINE, OPEN_ITEM);
  return { w, esc, acc, items };
}

describe('4.4 G5 with F10: something to verify is an open item of kind verify', () => {
  it('a standard that could not be verified, accepted with risk: kind verify, its standard and what is needed from the structured copy, not from the sentence; the read agrees and shows the kind', async () => {
    const { w, esc, acc, items } = await unverifiableAccepted(() => detailedPlan(M));
    assert.deepEqual(acc.body.risks, [`accepted with its risk by the Secretary on ${esc}: ${LINE}`]);
    const mine = items.filter((e) => e.body.escalation === esc);
    assert.deepEqual(mine.map((e) => e.body), [{ id: `${esc}.r1`, kind: 'verify', ref: { standard: 'S2' }, needed: 'a run on the real device', text: LINE, task: 'impl', attempt: 1, escalation: esc, why: 'risk' }]);
    assert.equal(opOf(w, mine[0]!.revision), opOf(w, acc.revision), 'in the write that accepts');
    // the read derives the same item from the acceptance and the escalation's copy when the item is not recorded
    const all = [...(await w.ledger.events({ mission: M }))].filter((e) => !(e.line === OPEN_ITEMS_LINE && e.event === OPEN_ITEM));
    const derived = riskRecord(all).items.find((i) => i.id === `${esc}.r1`)!;
    assert.deepEqual([derived.kind, derived.ref, derived.needed, derived.recorded], ['verify', { standard: 'S2' }, 'a run on the real device', false]);
    const r = await cli(w.dir, ['read', 'open-items', 'm1']);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(`[${esc}.r1] verify, task impl (attempt 1, accepted with risk on ${esc}): open, `), r.out);
    const g1 = readItems(w.ctx, M).find((x) => x.id === 'g1')!;
    assert.deepEqual([g1.open, g1.toVerify], [1, 1], 'mp read items counts it with the others');
  });

  it('on a used-up loop the escalation has no copy: the accepted review\'s copy gives the kind, in the write and in the read', async () => {
    const { w, engine, script } = await world(() => detailedPlan(M));
    await drive(engine, w.scheduler, script({ reviewer: reviewerOf((c) => judge(c, 'rework', { S1: { met: 'no', reason: 'slow' }, S2: S2_UNV })), secretary: accepts('loop-exhausted') }));
    const e = (await events<EscalationBody>(w, 'secretary', 'escalation')).map((x) => x.body).find((x) => x.source === 'loop-exhausted')!;
    assert.ok(e !== undefined, 'the loop was used up');
    assert.equal((e.facts as { unverifiable?: unknown } | undefined)?.unverifiable, undefined, 'its facts carry no copy');
    const mine = (await events<RiskItemBody>(w, OPEN_ITEMS_LINE, OPEN_ITEM)).map((x) => x.body).filter((b) => b.escalation === e.id);
    assert.deepEqual(mine.map((b) => [b.kind, b.ref, b.needed]), [['fix', { standard: 'S1' }, undefined], ['verify', { standard: 'S2' }, 'a run on the real device']]);
    const all = [...(await w.ledger.events({ mission: M }))].filter((x) => !(x.line === OPEN_ITEMS_LINE && x.event === OPEN_ITEM));
    assert.deepEqual(riskRecord(all).items.filter((i) => i.escalation === e.id).map((i) => [i.kind, i.needed]), [['fix', undefined], ['verify', 'a run on the real device']]);
  });

  it('a sentence of that form with no structured copy (an acceptance of 4.3) keeps the kind it had: nothing is written for it', () => {
    assert.deepEqual(riskItemBodies('t', 1, 'e', [LINE]).map((b) => [b.kind, b.needed]), [['fix', undefined]]);
    const legacy = riskRecord([
      { revision: 5, line: 'task:t', event: 'review', key: 'rev.t', body: { k: 1, verdict: 'rework', judgment: 'j.rev.t', issues: [LINE] } },
      { revision: 9, line: 'task:t', event: 'accepted', key: '1', body: { k: 1, product: 'p', judgment: 'j.sec.e', decision: { escalation: 'e', option: 'accept-risk', by: 'secretary' }, risks: [`accepted with its risk by the Secretary on e: ${LINE}`] } },
    ]);
    assert.deepEqual(legacy.items.map((i) => [i.kind, i.recorded]), [['fix', false]]);
    assert.ok(legacy.acceptances[0]!.legacy);
  });

  it('a standard a person checks: one verify item in the write that accepts its task by a pass; nothing waits for it; the reads show and count it; the user\'s statement closes it', async () => {
    const { w, engine, script } = await world(planWith(PERSON));
    await drive(engine, w.scheduler, script({ reviewer: reviewerOf((c) => judge(c, 'pass')) }));
    const acc = (await events(w, 'task:impl', 'accepted')).find((e) => e.key === '1')!;
    assert.equal(acc.body.decision, undefined, 'accepted by a pass');
    const id = personItemId('impl', 1, 'S3');
    const items = await events<RiskItemBody>(w, OPEN_ITEMS_LINE, OPEN_ITEM);
    assert.deepEqual(items.map((e) => e.body), [{ id, kind: 'verify', text: '[S3] is checked by a person: A user opens a real export with it', task: 'impl', attempt: 1, why: 'person', ref: { standard: 'S3' } }]);
    assert.equal(opOf(w, items[0]!.revision), opOf(w, acc.revision), 'in the write that accepts');
    // nothing waits for it: every task of the plan is accepted, and another pass writes no second item
    for (const t of planWith(PERSON)().tasks) assert.ok(await acceptedProduct(flowCtx(w, M), t.id), `${t.id} is accepted`);
    await drive(engine, w.scheduler, script({ reviewer: reviewerOf((c) => judge(c, 'pass')) }));
    assert.equal((await events(w, OPEN_ITEMS_LINE, OPEN_ITEM)).length, 1);
    const r = await cli(w.dir, ['read', 'open-items', 'm1']);
    assert.ok(r.out.includes(`[${id}] verify, task impl (attempt 1, a standard a person checks, written when the task was accepted): open, `), r.out);
    const row = async () => (await cli(w.dir, ['read', 'items', 'm1'])).out.split('\n').find((l) => l.startsWith('[g1]'))!;
    assert.match(await row(), /^\[g1\] [^:]+: accepted after a passing review \(1 open, 1 of them to verify\)/);
    // it is not answered; the user's statement closes it
    assert.throws(() => answerOpenItem(w.ctx, { op: 'a1', ref: id, by: 'pm', answer: 'done' }), /is a standard a person checks: it is not answered but closed.*mp pm verified m1 <item\|repair> --words W-<n> --open-items/);
    const words = say(w, 'I opened a real export with it and it works.');
    assert.deepEqual(recordVerified(w.ctx, { op: 'v1', mission: M, subject: 'g1', words, items: [id] }).closed, [id]);
    assert.equal(listAllItems(w.ctx, M).items.find((i) => i.id === id)!.closed?.how, 'words');
    assert.match(await row(), /^\[g1\] [^:]+: accepted after a passing review;/, 'nothing open is counted any more');
  });

  it('by a ruling: the fourth answer accepted with risk writes the person\'s standard too, in the same write', async () => {
    const { w, esc, acc, items } = await unverifiableAccepted(planWith(PERSON));
    const op = opOf(w, acc.revision);
    assert.deepEqual(items.map((e) => [e.key, e.body.kind, e.body.why, opOf(w, e.revision)]), [[`${esc}.r1`, 'verify', 'risk', op], [personItemId('impl', 1, 'S3'), 'verify', 'person', op]]);
    // status, the tree and mp read items count the same items of that acceptance
    const record = riskRecord([...(await w.ledger.events({ mission: M }))]);
    assert.equal(withRiskText(record, acceptanceOf(record, 'impl', esc)), '2 open');
    const g1 = readItems(w.ctx, M).find((x) => x.id === 'g1')!;
    assert.deepEqual([g1.state, g1.open, g1.toVerify], ['accepted with risk', 2, 2]);
  });

  it('an acceptance with risk counts the person\'s items of its own attempt, not those an earlier accepted attempt wrote', () => {
    const person = (k: number): RiskItemBody => ({ id: personItemId('t', k, 'S3'), kind: 'verify', text: '[S3] is checked by a person: x', task: 't', attempt: k, why: 'person', ref: { standard: 'S3' } });
    const r = riskRecord([
      { revision: 2, line: 'task:t', event: 'accepted', key: '1', body: { k: 1, product: 'p1', judgment: 'j.rev.t1' } },
      { revision: 2, line: OPEN_ITEMS_LINE, event: OPEN_ITEM, key: person(1).id, body: person(1) },
      { revision: 9, line: 'task:t', event: 'accepted', key: '2', body: { k: 2, product: 'p2', judgment: 'j.sec.e', decision: { escalation: 'e', option: 'accept-risk', by: 'secretary' }, risks: ['accepted with its risk by the Secretary on e: [S1] not met: slow'] } },
      { revision: 9, line: OPEN_ITEMS_LINE, event: OPEN_ITEM, key: 'e.r1', body: { id: 'e.r1', kind: 'fix', text: '[S1] not met: slow', task: 't', attempt: 2, escalation: 'e', why: 'risk', ref: { standard: 'S1' } } },
      { revision: 9, line: OPEN_ITEMS_LINE, event: OPEN_ITEM, key: person(2).id, body: person(2) },
    ]);
    assert.deepEqual([...acceptanceOf(r, 't', 'e')!.created].sort(), ['e.r1', person(2).id].sort());
    assert.equal(withRiskText(r, acceptanceOf(r, 't', 'e')), '2 open');
  });

  it('closed by a later review of a task that took it and answered it fixed, or on the user\'s words', async () => {
    const id = personItemId('a', 1, 'S3');
    const body = { id, kind: 'verify', text: '[S3] is checked by a person: x', task: 'a', attempt: 1, why: 'person', ref: { standard: 'S3' } } satisfies RiskItemBody;
    const r = riskRecord([
      { revision: 3, line: OPEN_ITEMS_LINE, event: OPEN_ITEM, key: id, body },
      { revision: 8, line: 'task:b', event: 'review', key: 'rev.b', body: { k: 1, judgment: 'j.rev.b', items: [{ item: id, response: 'fixed', reason: 'an automated check now covers it' }] } },
      { revision: 9, line: 'task:b', event: 'accepted', key: '1', body: { k: 1, product: 'pb', judgment: 'j.rev.b' } },
    ]);
    assert.deepEqual(r.items.map((i) => [i.id, i.kind, i.closed?.how, (i.closed as { task?: string } | null)?.task]), [[id, 'verify', 'fixed', 'b']]);
    const { w, engine, script } = await world(planWith(PERSON));
    await drive(engine, w.scheduler, script({ reviewer: reviewerOf((c) => judge(c, 'pass')) }));
    const mine = personItemId('impl', 1, 'S3');
    closeOpenItem(w.ctx, { op: 'c1', ref: mine, words: say(w, 'Nobody needs to check the export by hand.'), reason: 'not needed' });
    assert.equal(listAllItems(w.ctx, M).items.find((i) => i.id === mine)!.closed?.how, 'words');
  });

  it('each accepted attempt writes its own; a re-bind of the same attempt writes none again; mp read items counts those of the current acceptances', async () => {
    const w = memoryPorts();
    say(w, SEED_TEXT);
    await seedMission(w, M);
    await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'] });
    const engine = new FlowEngine(w);
    // iface has a standard a person checks in both versions (its card is kept: re-bound); impl's card changes in the second (re-specced)
    const withPerson = (p: DetailedPlanDoc, changed: boolean): DetailedPlanDoc => ({ ...p, tasks: p.tasks.map((t) => (
      t.id === 'impl' ? { ...t, standards: [...PERSON, ...(changed ? [{ id: 'S4', text: 'The parser is read-only after parsing' }] : [])] }
        : t.id === 'iface' ? { ...t, standards: [...t.standards, { id: 'P1', text: 'A reader finds the interface clear', check: 'person' as const }] }
        : t.id === 'docs' ? { ...t, interpreter: 'node', verificationCommands: [{ id: 'lint', command: 'npx markdownlint docs/parser.md' }] } : t)) });
    const passing = (plan: () => DetailedPlanDoc): Script => { const base = happyScript(M, plan); const rev = reviewerOf((c) => judge(c, 'pass')); return (t, s) => (t.card.seat === 'reviewer' ? rev(t, s) : base(t, s)); };
    await drive(engine, w.scheduler, passing(() => withPerson(detailedPlan(M), false)));
    const keys = async () => (await events(w, OPEN_ITEMS_LINE, OPEN_ITEM)).map((e) => e.key).sort();
    assert.deepEqual(await keys(), [personItemId('iface', 1, 'P1'), personItemId('impl', 1, 'S3')].sort());
    const later = say(w, 'Once it has parsed a file, keep the parser read-only.');
    await recordItem(w, { mission: M, item: 'd1', type: 'decision', text: 'The parser is read-only once it has parsed a file', source: { kind: 'words', words: later, quote: 'keep the parser read-only' } });
    await submitPmBatch(w, { mission: M, plan: pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'A CSV parser library, read-only once it has parsed a file', items: ['g1', 'd1'] }, pmPlan(M).elements[1]!] }), userWords: [later], changedItems: ['d1'] });
    await drive(engine, w.scheduler, passing(() => withPerson(detailedPlan(M, { extraTask: true }), true)));
    assert.equal(await acceptedProduct(flowCtx(w, M), 'impl'), 'prod.con.m1.impl.2', 'impl is rebuilt and accepted at attempt 2');
    assert.ok((await events(w, 'task:iface', 'rebound')).length === 1, 'iface is re-bound and accepted again at attempt 1');
    assert.deepEqual(await keys(), [personItemId('iface', 1, 'P1'), personItemId('impl', 1, 'S3'), personItemId('impl', 2, 'S3')].sort());
    const g1 = readItems(w.ctx, M).find((x) => x.id === 'g1')!;
    assert.deepEqual([g1.open, g1.toVerify], [2, 2], 'iface at attempt 1 and impl at attempt 2: the superseded attempt\'s item is not counted');
    assert.equal(listAllItems(w.ctx, M).items.filter((i) => i.closed === null).length, 3, 'mp read open-items still lists all three');
  });

  it('a plan of 4.3 has no standard a person checks: a task accepted by a pass writes no item', async () => {
    const { w, engine, script } = await world(() => detailedPlan(M));
    await drive(engine, w.scheduler, script({ reviewer: reviewerOf((c) => judge(c, 'pass')) }));
    assert.ok(await acceptedProduct(flowCtx(w, M), 'impl'));
    assert.deepEqual(await events(w, OPEN_ITEMS_LINE), []);
  });
});
