// Products accepted under a PM plan version that no longer holds (design 4.1 Appendix J; v51 5.2):
// a product's Reviewer contract relies on the detailed plan in effect when it was recorded, fixed
// with the object. When a requirement item makes that plan's PM plan stale, or a re-check negates
// it, a new PM plan version whose detailed plan keeps the task's card must not leave the accepted
// product unproven for good (stable mode would hold every dependent forever). Once the new plan is
// proven, the product is re-bound: a new version of the same content whose contract relies on the
// new plan, judged by a Reviewer in stable mode (maintainer ruling 1, 2026-10-13). A changed card is re-specced and rebuilt as before.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { idPart, type MissionId } from '../src/common/ids.ts';
import type { JudgmentRecord, ObjectVersionRecord } from '../src/common/records.ts';
import { commit, ev, flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { acceptedProduct, taskLineage } from '../src/flow/execution.ts';
import { RENEW_LINE, REVIEW_NEEDED, type DetailedPlanDoc, type ReviewNeededBody } from '../src/flow/plandoc.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import type { FlowEvaluatorPort } from '../src/flow/ports.ts';
import { recordConstraint, recordItem } from '../src/flow/requirements.ts';
import { answerEscalation, raiseEscalation } from '../src/flow/secretary.ts';
import { cal1Fail, detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { gitActions } from '../src/process/actions.ts';
import { pmClose } from '../src/process/close.ts';
import { renderCard, renderSeatCard, type ConstructorCard, type ReviewerCard } from '../src/seat/card.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import type { Calibrator1Card } from '../src/seat/cards/calibrator.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
const LATER = 'Once it has parsed a file, keep the parser read-only.';
type World = ReturnType<typeof memoryPorts>;
let world: World | null = null;

/** No product version is proven without a seat judgment on that version (renewals keep it). */
async function assertSeatProofs(ports: World): Promise<void> {
  const products = (await ports.ledger.records(['object.version'])).map((r) => r.record).filter((r) => r.objectKind === 'product');
  const judgments = await ports.ledger.records(['judgment']);
  const issues = await ports.ledger.records(['issue']);
  const events = await ports.ledger.events<{ k: number; n?: number; object?: string; product?: string; dplan?: string; from?: string; rev?: string }>({ mission: M });
  const versions = events.filter((e) => e.event === 'product' || e.event === 'rebind');
  const labels = await labelsOf(ports, products.map((p) => p.object));
  for (const p of products) {
    if (labels[p.object] !== 'proven') continue;
    const view = (await ports.evaluator.deciding([p.object])).views[p.object];
    const by = view?.positions.find((p) => p.review === 'reviewer')?.by;
    assert.ok(by, `${p.object}: proven without a deciding Reviewer`);
    const j = (await ports.ledger.judgment(by)) as JudgmentRecord;
    assert.equal(j.target, p.object);
    assert.equal(j.executor, 'reviewer', `${p.object}: no program-written pass`);
    const decided = judgments.find((r) => r.record.judgment === by)!;
    const version = versions.find((e) => (e.body.object ?? e.body.product) === p.object)!;
    const lineage = new Set(versions.filter((e) => e.line === version.line && e.body.k <= version.body.k).map((e) => e.body.object ?? e.body.product));
    for (const issue of issues) {
      if (issue.revision >= decided.revision || !ports.ledger.content.getList(issue.record.observedOn).some((v) => lineage.has(v))) continue;
      assert.ok(j.issues.some((a) => a.issue === issue.record.issue), `${p.object}: deciding judgment does not answer earlier issue ${issue.record.issue}`);
    }
  }
  const effective = events.filter((e) => e.line === 'plan' && e.event === 'effective').at(-1)?.body.dplan;
  // Independently check queued step ids against the recorded line, never the production resolver
  // or card.target: an accepted .b version can legitimately have a new .e re-review queued.
  for (const task of ports.scheduler.tasks.values()) {
    if (!['queued', 'waiting-evidence'].includes(task.state) || !['constructor', 'reviewer'].includes(task.spec.card.seat)) continue;
    const id = task.spec.task;
    const parts = /^(con|rev)\.m1\.(.+)\.(\d+)(?:\.(b|e|r)(\d+)(?:\.r(\d+))?)?$/.exec(id);
    assert.ok(parts, `${id}: unrecognized Constructor/Reviewer step id`);
    const line = events.filter((e) => e.line.startsWith('task:') && idPart(e.line.slice(5)) === parts[2]);
    const k = 1 + line.filter((e) => e.event === 'rework').length;
    assert.equal(Number(parts[3]), k, `${id}: obsolete attempt remains queued`);
    const spec = line.filter((e) => e.event === 'spec').at(-1);
    assert.ok(spec, `${id}: queued without a task spec`);
    assert.ok(!line.some((e) => ['dropped', 'abandoned'].includes(e.event) && e.revision > spec.revision), `${id}: dropped or abandoned line remains queued`);
    const original = line.find((e) => e.event === 'accepted' && e.key === String(k))?.body.product;
    const accepted = line.filter((e) => e.event === 'rebound' && e.body.k === k).at(-1)?.body.product ?? original;
    if (parts[4] === 'b') {
      const pending = line.filter((e) => e.event === 'rebind' && e.body.k === k).at(-1);
      assert.ok(pending && !line.some((e) => e.event === 'rebound' && e.key === pending.key), `${id}: accepted re-bind Reviewer remains queued`);
      assert.equal(Number(parts[5]), pending.body.n, `${id}: superseded re-bind Reviewer remains queued`);
      assert.equal(pending.body.dplan, effective, `${id}: re-bind is for an obsolete plan`);
      assert.ok(accepted && pending.body.from === accepted, `${id}: re-bind is from an obsolete acceptance`);
    } else if (parts[4] === 'e') {
      const round = line.find((e) => e.event === 'rereview' && e.body.rev === id);
      assert.ok(round && accepted && (round.body.product ?? original) === accepted, `${id}: re-review is not of the current accepted version`);
    }
  }
}
afterEach(async () => { if (world !== null) await assertSeatProofs(world); });

async function setup(): Promise<{ ports: World; engine: FlowEngine }> {
  const ports = memoryPorts();
  world = ports;
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1', 's1', 'a1'] });
  return { ports, engine: new FlowEngine(ports) };
}

/** The user's later decision, which no element of the first plan rests on. */
async function laterDecision(ports: World): Promise<string> {
  const w = say(ports, LATER);
  await recordItem(ports, { mission: M, item: 'd1', type: 'decision', text: 'The parser is read-only once it has parsed a file', source: { kind: 'words', words: w, quote: 'keep the parser read-only' } });
  return w;
}

/** The next PM plan version: its first element maps the later decision too. */
const plan2 = () => pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'A CSV parser library, read-only once it has parsed a file', items: ['g1', 'd1'] }, pmPlan(M).elements[1]!] });

/** The detailed plan of the next version: the two tasks unchanged, and a new one that depends on the implementation. */
const keeps = (): DetailedPlanDoc => {
  const p = detailedPlan(M, { extraTask: true });
  return { ...p, tasks: p.tasks.map((t) => (t.id === 'docs' ? { ...t, interpreter: 'node', verificationCommands: [{ id: 'lint', command: 'npx markdownlint docs/parser.md' }] } : t)) };
};

const labelsOf = async (ports: World, ids: readonly string[]): Promise<Record<string, unknown>> => (await ports.evaluator.labels(ids)).labels;
const current = async (ports: World, task: string): Promise<string | null> => acceptedProduct(flowCtx(ports, M), task);
const lineEvents = async <B>(ports: World, task: string, event: string): Promise<Array<{ key: string; body: B }>> => (await ports.ledger.events<B>({ mission: M, line: `task:${task}`, event })).map((e) => ({ key: e.key, body: e.body }));

/** The first plan's products, accepted and proven; then the later decision takes their proof away. */
async function acceptedThenStale(ports: World, engine: FlowEngine): Promise<{ w: string; iface: string; impl: string }> {
  await drive(engine, ports.scheduler, happyScript(M));
  const iface = (await current(ports, 'iface'))!;
  const impl = (await current(ports, 'impl'))!;
  assert.deepEqual(await labelsOf(ports, [iface, impl]), { [iface]: 'proven', [impl]: 'proven' });
  const w = await laterDecision(ports);
  assert.deepEqual(await labelsOf(ports, [iface, impl, 'dplan.m1.1.1']), { [iface]: 'not-fully-proven', [impl]: 'not-fully-proven', 'dplan.m1.1.1': 'not-fully-proven' });
  return { w, iface, impl };
}

/** After the new version took effect and the flow settled: the kept products re-bound and judged by their Reviewers, the dependent built. */
async function assertReviewed(ports: World, old: { iface: string; impl: string }, ran: readonly string[]): Promise<void> {
  assert.ok(ran.includes('con.m1.docs.1'), `the dependent of the kept products is released: ${ran.join(', ')}`);
  for (const t of ['iface', 'impl']) {
    assert.ok(!ran.some((x) => x.startsWith(`con.m1.${t}.`)), `${t} is not rebuilt: ${ran.join(', ')}`);
    assert.ok(ran.includes(`rev.m1.${t}.1.b1`), `${t} is judged on its new version`);
  }
  const iface = (await current(ports, 'iface'))!;
  const impl = (await current(ports, 'impl'))!;
  assert.equal(iface, 'prod.con.m1.iface.1.b1');
  assert.equal(impl, 'prod.con.m1.impl.1.b1');
  for (const [t, p, from] of [['iface', iface, old.iface], ['impl', impl, old.impl]] as const) {
    const rb = await lineEvents<{ how: string; from: string; dplan: string; carries: string }>(ports, t, 'rebind');
    assert.deepEqual(rb.map((e) => [e.key, e.body.how, e.body.from, e.body.dplan]), [['1:b1', 'review', from, 'dplan.m1.2.1']]);
    const v = (await ports.ledger.objectVersion(p)) as ObjectVersionRecord;
    const was = (await ports.ledger.objectVersion(from)) as ObjectVersionRecord;
    assert.equal(v.predecessor, from);
    assert.equal(v.content, was.content, 'the same content');
    assert.deepEqual(v.reviews[0]?.reliesOn, ['dplan.m1.2.1'], 'its contract relies on the plan in effect');
    const rebound = (await lineEvents<{ judgment: string }>(ports, t, 'rebound'))[0]!.body;
    const j = (await ports.ledger.judgment(rebound.judgment)) as JudgmentRecord;
    assert.equal(rb[0]!.body.carries, null);
    assert.equal(j.executor, 'reviewer');
    assert.equal(j.target, p);
    assert.ok(ports.ledger.content.getList(j.evidence).length > 0, 'the seat cites the declared runs');
    assert.deepEqual(ports.ledger.content.getList(j.reliesOn), ['dplan.m1.2.1']);
  }
  const implV = (await ports.ledger.objectVersion(impl)) as ObjectVersionRecord;
  assert.deepEqual(ports.ledger.content.getList(implV.prerequisites), [iface], "its prerequisite is the dependency's re-bound version");
  const docs = (await current(ports, 'docs'))!;
  assert.deepEqual(await labelsOf(ports, [iface, impl, docs]), { [iface]: 'proven', [impl]: 'proven', [docs]: 'proven' });
  // the old versions keep their history: still not fully proven
  assert.deepEqual(await labelsOf(ports, [old.iface, old.impl]), { [old.iface]: 'not-fully-proven', [old.impl]: 'not-fully-proven' });
  const n = ports.ledger.notices.filter((x) => x.category === 'kept-products-rebind-review');
  assert.ok(n.length >= 1 && n.every((x) => x.wi === null), `a normal-branch notice tells the PM: ${ports.ledger.notices.map((x) => x.category).join(', ')}`);
  assert.ok(n.some((x) => String(x.defaultAction).includes(`${old.iface} → ${iface}`)));
}

describe('flow: products of kept tasks re-bound to a new plan version (Appendix J)', () => {
  it('a requirement item makes the old plan stale; once the next version maps it and takes effect, the kept products are proven again after Reviewer passes and the gate releases their dependent', async () => {
    const { ports, engine } = await setup();
    const old = await acceptedThenStale(ports, engine);
    assert.deepEqual(await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [old.w], changedItems: ['d1'] }), { batch: 'b2', plan: 'pmplan.m1.2' });
    const ran = await drive(engine, ports.scheduler, happyScript(M, keeps));
    assert.equal((await labelsOf(ports, ['dplan.m1.2.1']))['dplan.m1.2.1'], 'proven');
    await assertReviewed(ports, old, ran);
    // the next reconciliation changes nothing: the re-bind happens once
    const head = ports.ledger.head;
    await engine.reconcile(M);
    assert.equal(ports.ledger.head, head);
  });

  it('the old plan negated by a failed re-check: the next version recovers the kept products, one whose passing review the gate had held among them', async () => {
    const { ports, engine } = await setup();
    const base = happyScript(M);
    // the implementation's Reviewer is held until after the later decision
    await drive(engine, ports.scheduler, (t, s) => (t.task === 'rev.m1.impl.1' ? null : base(t, s)));
    const iface = (await current(ports, 'iface'))!;
    assert.equal(await current(ports, 'impl'), null);
    const w = await laterDecision(ports);
    assert.deepEqual(await drive(engine, ports.scheduler, (t, s) => (t.task === 'rev.m1.impl.1' ? base(t, s) : null)), ['rev.m1.impl.1']);
    assert.equal(await current(ports, 'impl'), null, 'stable mode: its passing review is not taken in while the plan is not proven');
    // the plan in effect, re-checked unchanged, fails: the old plan is negated
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: [w], changedItems: ['d1'] });
    await drive(engine, ports.scheduler, (t) => (t.card.seat === 'calibrator-1' ? { handBack: cal1Fail(t.card as unknown as Calibrator1Card, 'e1', 'contradicts-user') } : null));
    assert.equal((await labelsOf(ports, ['pmplan.m1.1']))['pmplan.m1.1'], 'negated');
    assert.equal(await current(ports, 'impl'), null);
    // the next version, reviewed in full, takes effect
    assert.deepEqual(await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [w], changedItems: ['d1'] }), { batch: 'b2', plan: 'pmplan.m1.2' });
    const ran = await drive(engine, ports.scheduler, happyScript(M, keeps));
    assert.ok(ran.includes('cal1.m1.2'));
    // the held review is taken in under the old plan, then re-bound like the other
    const acc = await lineEvents<{ product: string }>(ports, 'impl', 'accepted');
    assert.deepEqual(acc.map((e) => e.body.product), ['prod.con.m1.impl.1']);
    await assertReviewed(ports, { iface, impl: 'prod.con.m1.impl.1' }, ran);
  });

  it('a task whose card the new plan changes is re-specced and rebuilt as before, not re-bound', async () => {
    const { ports, engine } = await setup();
    const old = await acceptedThenStale(ports, engine);
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [old.w], changedItems: ['d1'] });
    const changed = (): DetailedPlanDoc => {
      const p = keeps();
      return { ...p, tasks: p.tasks.map((t) => (t.id === 'impl' ? { ...t, standards: [...t.standards, { id: 'S3', text: 'The parser is read-only after parsing' }] } : t)) };
    };
    const ran = await drive(engine, ports.scheduler, happyScript(M, changed));
    assert.ok(ran.includes('con.m1.impl.2') && ran.includes('rev.m1.impl.2'), `the changed card is rebuilt at the next attempt: ${ran.join(', ')}`);
    assert.deepEqual(await lineEvents(ports, 'impl', 'rebind'), [], 'the changed card is not re-bound');
    assert.deepEqual((await lineEvents<{ reason: string }>(ports, 'impl', 'rework')).map((e) => e.body.reason), ['respec']);
    assert.equal((await lineEvents(ports, 'impl', 'spec')).length, 2);
    // the kept one is re-bound, and the rebuilt one rests on it
    assert.deepEqual((await lineEvents<{ how: string }>(ports, 'iface', 'rebind')).map((e) => e.body.how), ['review']);
    const iface = (await current(ports, 'iface'))!;
    const impl = (await current(ports, 'impl'))!;
    assert.equal(impl, 'prod.con.m1.impl.2');
    assert.deepEqual(ports.ledger.content.getList(((await ports.ledger.objectVersion(impl)) as ObjectVersionRecord).prerequisites), [iface]);
    const docs = (await current(ports, 'docs'))!;
    assert.deepEqual(await labelsOf(ports, [iface, impl, docs]), { [iface]: 'proven', [impl]: 'proven', [docs]: 'proven' });
  });

  it('a kept product whose own inputs changed is not carried over: a Reviewer judges the re-bound version, and its dependents wait for it', async () => {
    const { ports, engine } = await setup();
    const old = await acceptedThenStale(ports, engine);
    // the user restates the goal: the bases both products were judged on have a new version
    await recordItem(ports, { mission: M, item: 'g1', type: 'goal', text: 'A CSV parser that is read-only once it has parsed a file', source: { kind: 'words', words: old.w, quote: 'keep the parser read-only' } });
    const base = happyScript(M, keeps);
    // stable mode re-reviews the old versions on the new basis meanwhile; those Reviewers are not run here
    const rereview = (task: string): boolean => /^rev\.m1\.[a-z]+\.1\.e\d+$/.test(task);
    assert.deepEqual(await drive(engine, ports.scheduler, (t, s) => (rereview(t.task) ? null : base(t, s))), []);
    assert.deepEqual(
      ports.scheduler.queued('reviewer').map((t) => t.task),
      ['rev.m1.iface.1.e1', 'rev.m1.impl.1.e1'],
    );
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [old.w], changedItems: ['d1', 'g1'] });
    const rebindReview = (task: string): boolean => /^rev\.m1\.[a-z]+\.1\.b\d/.test(task);
    await drive(engine, ports.scheduler, (t, s) => (rebindReview(t.task) || rereview(t.task) ? null : base(t, s)));
    assert.equal((await labelsOf(ports, ['dplan.m1.2.1']))['dplan.m1.2.1'], 'proven');
    const rb = await lineEvents<{ how: string; why: string[]; product: string }>(ports, 'iface', 'rebind');
    assert.deepEqual(rb.map((e) => e.body.how), ['review']);
    assert.match(rb[0]!.body.why.join('; '), /Reviewer contract/);
    assert.deepEqual(await lineEvents(ports, 'iface', 'rebound'), [], 'nothing is carried over');
    assert.equal(await current(ports, 'iface'), old.iface);
    assert.deepEqual(await labelsOf(ports, [old.iface, rb[0]!.body.product]), { [old.iface]: 'not-fully-proven', [rb[0]!.body.product]: 'unaccepted' });
    assert.ok(ports.scheduler.queued('reviewer').some((t) => t.task === 'rev.m1.iface.1.b1'), 'a Reviewer judges the re-bound version');
    assert.deepEqual(await lineEvents(ports, 'impl', 'rebind'), [], 'the implementation waits for its dependency to be re-bound first');
    assert.ok(!ports.scheduler.tasks.has('con.m1.docs.1'), 'stable mode: the dependent waits');
    assert.ok(ports.ledger.notices.some((n) => n.category === 'kept-products-rebind-review' && n.wi === null));
    const card = ports.scheduler.card<{ target: string; binding: { reliesOn: unknown } }>('rev.m1.iface.1.b1');
    assert.equal(card.target, rb[0]!.body.product);
    assert.deepEqual(ports.ledger.content.getList(card.binding.reliesOn as never), ['dplan.m1.2.1']);
    assert.equal(ports.scheduler.tasks.get('rev.m1.iface.1.e1')?.state, 'abandoned', 'the queued re-review of the old version left the queue');
    const ran = await drive(engine, ports.scheduler, (t, s) => (rereview(t.task) ? null : base(t, s)));
    assert.ok(ran.includes('rev.m1.iface.1.b1') && ran.includes('rev.m1.impl.1.b1') && ran.includes('con.m1.docs.1'), ran.join(', '));
    assert.deepEqual(ports.scheduler.queued('reviewer'), []);
    for (const t of ['iface', 'impl']) {
      const rebound = (await lineEvents<{ how: string; judgment: string }>(ports, t, 'rebound'))[0]!.body;
      assert.equal(rebound.how, 'review');
      assert.equal(((await ports.ledger.judgment(rebound.judgment)) as JudgmentRecord).executor, 'reviewer');
    }
    const [iface, impl, docs] = [(await current(ports, 'iface'))!, (await current(ports, 'impl'))!, (await current(ports, 'docs'))!];
    assert.deepEqual(await labelsOf(ports, [iface, impl, docs]), { [iface]: 'proven', [impl]: 'proven', [docs]: 'proven' });
  });

  it('an object constraint added since the review, or an interface definition the new plan changes, is judged by a Reviewer too', async () => {
    const { ports, engine } = await setup();
    const old = await acceptedThenStale(ports, engine);
    // a constraint over the parser's files (both products), and a new definition of the interface both tasks implement
    await recordConstraint(ports, { mission: M, constraint: 'c1', kind: 'object', text: 'No console output', scope: { paths: ['src/parser/**'], taskTypes: [] } });
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [old.w], changedItems: ['d1'] });
    const redefined = (): DetailedPlanDoc => {
      const p = keeps();
      return { ...p, newInterfaces: p.newInterfaces.map((i) => ({ ...i, definition: 'parse(text: string, options?: { strict: boolean }): string[][]' })) };
    };
    const ran = await drive(engine, ports.scheduler, happyScript(M, redefined));
    for (const t of ['iface', 'impl']) {
      const rb = (await lineEvents<{ how: string; why: string[] }>(ports, t, 'rebind'))[0]!.body;
      assert.equal(rb.how, 'review', t);
      assert.match(rb.why.join('; '), /maintainer ruling 1/);
      assert.ok(ran.includes(`rev.m1.${t}.1.b1`), `${t}: ${ran.join(', ')}`);
    }
    const card = ports.scheduler.card<{ interfaces: Array<{ definition: string }>; constraints: Array<{ id: string }> }>('rev.m1.iface.1.b1');
    assert.match(card.interfaces[0]!.definition, /strict/);
    assert.ok(card.constraints.some((c) => c.id.includes('c1')), 'the constraint is on the card');
    const [iface, impl, docs] = [(await current(ports, 'iface'))!, (await current(ports, 'impl'))!, (await current(ports, 'docs'))!];
    assert.deepEqual(await labelsOf(ports, [iface, impl, docs]), { [iface]: 'proven', [impl]: 'proven', [docs]: 'proven' });
  });

  it('fast mode: what a Reviewer would have to judge again is told to the PM, no seat runs, and the work goes on', async () => {
    const { ports, engine } = await setup();
    const old = await acceptedThenStale(ports, engine);
    // a constraint over the interface's file only
    await recordConstraint(ports, { mission: M, constraint: 'c1', kind: 'object', text: 'No console output', scope: { paths: ['src/parser/api.ts'], taskTypes: [] } });
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [old.w], changedItems: ['d1'], mode: 'fast' });
    const ran = await drive(engine, ports.scheduler, happyScript(M, keeps));
    assert.ok(ran.includes('con.m1.docs.1'), `fast mode: the dependent goes on: ${ran.join(', ')}`);
    assert.ok(!ran.some((x) => /^rev\.m1\.(iface|impl)\./.test(x)), ran.join(', '));
    assert.deepEqual(await lineEvents(ports, 'iface', 'rebind'), []);
    assert.deepEqual(await lineEvents(ports, 'impl', 'rebind'), [], 'its prerequisite is not re-bound: nothing to carry it over onto');
    const n = ports.ledger.notices.filter((x) => x.category === 'kept-product-not-rebound');
    assert.equal(n.length, 1);
    assert.equal(n[0]!.wi, null);
    assert.match(n[0]!.trigger, /task iface/);
    assert.match(n[0]!.trigger, /lost its proof/);
    assert.deepEqual(await labelsOf(ports, [old.iface, old.impl]), { [old.iface]: 'not-fully-proven', [old.impl]: 'not-fully-proven' });
  });

  it('a kept product built on a dependency the new plan rebuilt cannot be re-bound: the PM is told', async () => {
    const { ports, engine } = await setup();
    const old = await acceptedThenStale(ports, engine);
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [old.w], changedItems: ['d1'] });
    const ifaceChanged = (): DetailedPlanDoc => {
      const p = keeps();
      return { ...p, tasks: p.tasks.map((t) => (t.id === 'iface' ? { ...t, goal: 'Define the Parser interface, read-only after parsing' } : t)) };
    };
    const ran = await drive(engine, ports.scheduler, happyScript(M, ifaceChanged));
    assert.ok(ran.includes('con.m1.iface.2'), ran.join(', '));
    assert.equal(await current(ports, 'iface'), 'prod.con.m1.iface.2');
    assert.deepEqual(await lineEvents(ports, 'impl', 'rebind'), []);
    const n = ports.ledger.notices.find((x) => x.category === 'kept-product-not-rebound');
    assert.ok(n !== undefined && n.wi === null);
    assert.match(n.trigger, new RegExp(`built on ${old.iface.replace(/\./g, '\\.')}`));
    assert.ok(!ports.scheduler.tasks.has('con.m1.docs.1'), 'stable mode: its dependent waits');
  });

  it('installed after the new plan took effect: a later reconciliation finds the kept products and re-binds them', async () => {
    const { ports } = await setup();
    // the older engine: its passes never re-bind (a plan reported unproven to this flow re-binds nothing either)
    const hidden: FlowEvaluatorPort = {
      ...ports.evaluator,
      labels: async (ids) => {
        const r = await ports.evaluator.labels(ids);
        return { ...r, labels: Object.fromEntries(Object.entries(r.labels).map(([k, v]) => [k, k === 'dplan.m1.2.1' && v === 'proven' ? 'not-fully-proven' : v])) };
      },
      deciding: (ids) => ports.evaluator.deciding(ids),
      judgments: (ids) => ports.evaluator.judgments(ids),
      ops: (ids) => ports.evaluator.ops(ids),
    };
    const older = new FlowEngine({ ...ports, evaluator: hidden });
    const old = await acceptedThenStale(ports, older);
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [old.w], changedItems: ['d1'] });
    await drive(older, ports.scheduler, happyScript(M, keeps));
    assert.ok((await ports.ledger.events({ mission: M, line: 'plan', event: 'effective' })).some((e) => e.key === 'dplan.m1.2.1'), 'the new plan took effect');
    assert.equal((await labelsOf(ports, ['dplan.m1.2.1']))['dplan.m1.2.1'], 'proven');
    assert.deepEqual(await lineEvents(ports, 'iface', 'rebind'), []);
    assert.ok(!ports.scheduler.tasks.has('con.m1.docs.1'), 'the dependent is held');
    // the fixed engine: one reconciliation
    const engine = new FlowEngine(ports);
    await engine.reconcile(M);
    assert.equal(await current(ports, 'iface'), old.iface);
    assert.equal(await current(ports, 'impl'), old.impl);
    assert.ok(ports.scheduler.queued('reviewer').some((t) => t.task === 'rev.m1.iface.1.b1'));
    assert.ok(!ports.scheduler.tasks.has('con.m1.docs.1'), 'the dependent waits for Reviewer passes');
    await assertReviewed(ports, old, await drive(engine, ports.scheduler, happyScript(M, keeps)));
  });

  it('nothing is re-bound while the new plan is not proven; after it is checked again, a later pass re-binds', async () => {
    const { ports, engine } = await setup();
    const old = await acceptedThenStale(ports, engine);
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [old.w], changedItems: ['d1'] });
    // another decision arrives while the new version is decomposed: it takes effect without its proof
    const base = happyScript(M, keeps);
    let w2 = '';
    const script: Script = (t, s) => {
      if (t.card.seat === 'architect-feasibility' && w2 === '') return null;
      return base(t, s);
    };
    await drive(engine, ports.scheduler, script);
    w2 = say(ports, 'Also: no network access.');
    await recordItem(ports, { mission: M, item: 'd2', type: 'decision', text: 'No network access', source: { kind: 'words', words: w2, quote: 'no network access' } });
    await drive(engine, ports.scheduler, script);
    assert.ok((await ports.ledger.events({ mission: M, line: 'plan', event: 'effective' })).some((e) => e.key === 'dplan.m1.2.1'));
    assert.equal((await labelsOf(ports, ['dplan.m1.2.1']))['dplan.m1.2.1'], 'not-fully-proven');
    assert.deepEqual(await lineEvents(ports, 'iface', 'rebind'), [], 'nothing is re-bound onto a plan that is not proven');
    assert.deepEqual(await lineEvents(ports, 'impl', 'rebind'), []);
    // the PM checks the version in effect again; its pass proves it, and the products are re-bound
    assert.deepEqual(await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [w2], changedItems: ['d2'] }), { batch: 'b2.c1', plan: 'pmplan.m1.2', recheck: true });
    const ran = await drive(engine, ports.scheduler, base);
    assert.equal(ran[0], 'cal1.m1.2.c1');
    await assertReviewed(ports, old, ran);
  });
});

/** Leave the first new version queued for its Reviewer. */
async function waitingRebind() {
  const { ports, engine } = await setup();
  const old = await acceptedThenStale(ports, engine);
  await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [old.w], changedItems: ['d1'] });
  const base = happyScript(M, keeps);
  await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'reviewer' ? null : base(t, s));
  assert.equal(ports.scheduler.tasks.get('rev.m1.iface.1.b1')?.state, 'queued');
  return { ports, engine, old, base };
}

async function thirdPlan(ports: World, engine: FlowEngine, plan: () => DetailedPlanDoc) {
  const w = say(ports, 'Keep the public documentation readable.');
  await recordItem(ports, { mission: M, item: 'd2', type: 'decision', text: 'Keep documentation readable', source: { kind: 'words', words: w, quote: 'documentation readable' } });
  await submitPmBatch(ports, { mission: M, plan: { ...plan2(), round: 3 }, userWords: [w], changedItems: ['d2'] });
  const base = happyScript(M, plan);
  await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'reviewer' ? null : base(t, s));
}

describe('rebind regressions: seat authority, lineage, cancellation and deferred ownership', () => {
  it('a changed decision quote alone requires a seat on the new version and holds its dependents', async () => {
    const { ports, engine } = await setup();
    const decision = (text: string) => recordItem(ports, { mission: M, item: 'csv', type: 'decision', text, source: { kind: 'authorization', line: 'item.m1.a1' } });
    await decision('A trailing comma is an empty field');
    // Check the first plan against the requirement set including that decision.
    await drive(engine, ports.scheduler, happyScript(M));
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['csv'] });
    await drive(engine, ports.scheduler, happyScript(M));
    const first = ports.scheduler.card<ReviewerCard>('rev.m1.iface.1');
    const actions = ports.ctx.actions();
    const verify = actions.verify.bind(actions);
    actions.verify = async (req) => {
      if (req.object.endsWith('.b1') && req.object.includes('.iface.')) {
        const runs = (await lineEvents<{ runs: import('../src/flow/ports.ts').VerificationRun[] }>(ports, 'iface', 'verified'))[0]!.body.runs;
        return runs;
      }
      return verify(req);
    };
    assert.ok(first.decisionQuotes.includes('A trailing comma is an empty field'));
    await decision('A trailing comma is an error');
    const w = await laterDecision(ports);
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [w], changedItems: ['csv', 'd1'] });
    const base = happyScript(M, keeps);
    await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'reviewer' ? null : base(t, s));
    const card = ports.scheduler.card<ReviewerCard>('rev.m1.iface.1.b1');
    assert.ok(card.decisionQuotes.includes('A trailing comma is an error'));
    assert.deepEqual(card.standards, first.standards);
    assert.deepEqual(card.interfaces, first.interfaces);
    assert.deepEqual(card.constraints, first.constraints);
    assert.deepEqual(card.workspace, first.workspace);
    assert.deepEqual(card.candidate, first.candidate);
    assert.deepEqual(card.verificationRuns, first.verificationRuns, 'the very same recorded runs');
    assert.deepEqual(ports.ledger.content.getList(card.binding.bases as never), ports.ledger.content.getList(first.binding.bases as never));
    assert.equal((await labelsOf(ports, [card.target]))[card.target], 'unaccepted');
    assert.ok(!ports.scheduler.tasks.has('con.m1.docs.1'));
    assert.deepEqual(await ports.scheduler.run(card.task, { handBack: reviewer(card, 'rework', { findings: ['Trailing comma must be rejected'] }) }), []);
    await drive(engine, ports.scheduler, (t, s) => t.task === 'rev.m1.iface.2' ? null : base(t, s));
    assert.equal((await labelsOf(ports, [card.target]))[card.target], 'negated');
    assert.ok(!ports.scheduler.tasks.has('con.m1.docs.1'));
    await drive(engine, ports.scheduler, base);
    assert.equal((await labelsOf(ports, [(await current(ports, 'iface'))!]))[(await current(ports, 'iface'))!], 'proven');
  });

  it('rework after .b1 uses that predecessor and requires its finding to be answered', async () => {
    const { ports, engine, base } = await waitingRebind();
    const card = ports.scheduler.card<ReviewerCard>('rev.m1.iface.1.b1');
    assert.deepEqual(await ports.scheduler.run(card.task, { handBack: reviewer(card, 'rework', { findings: ['Handle the trailing empty field'] }) }), []);
    await drive(engine, ports.scheduler, (t, s) => t.task === 'rev.m1.iface.2' ? null : base(t, s));
    const next = ports.scheduler.card<ReviewerCard>('rev.m1.iface.2');
    const product = (await ports.ledger.objectVersion(next.target)) as ObjectVersionRecord;
    assert.equal(product.predecessor, card.target);
    assert.equal(next.openIssues.length, 1);
    assert.equal(next.openIssues[0]!.text, 'Handle the trailing empty field');
    const unanswered = { ...reviewer(next, 'pass'), issue_responses: [] };
    assert.match((await ports.scheduler.run(next.task, { handBack: unanswered })).join(), /has no response/);
    assert.notEqual((await labelsOf(ports, [next.target]))[next.target], 'proven');
    await drive(engine, ports.scheduler, base);
    assert.equal((await labelsOf(ports, [next.target]))[next.target], 'proven');
  });

  for (const change of ['respec', 'drop'] as const) {
    it(`an accepted task's queued .b Reviewer is cancelled when the next plan ${change}s it`, async () => {
      const { ports, engine, base } = await waitingRebind();
      await thirdPlan(ports, engine, () => {
        const p = keeps();
        return { ...p, tasks: change === 'respec' ? p.tasks.map((t) => t.id === 'iface' ? { ...t, goal: `${t.goal}; clarify errors` } : t) : p.tasks.map((t) => t.id === 'iface' ? { ...t, id: 'iface-new' } : { ...t, dependsOn: t.dependsOn.map((d) => d === 'iface' ? 'iface-new' : d) }) };
      });
      assert.equal(ports.scheduler.tasks.get('rev.m1.iface.1.b1')?.state, 'abandoned');
      assert.ok(!ports.scheduler.queued('reviewer').some((t) => t.task === 'rev.m1.iface.1.b1'));
      if (change === 'respec') {
        assert.ok(ports.scheduler.tasks.has('con.m1.iface.2'));
        await drive(engine, ports.scheduler, base);
      }
    });
  }

  it('needs-decision waits for the Secretary and its answer starts a second review of the same .b version', async () => {
    const { ports, engine, base } = await waitingRebind();
    const card = ports.scheduler.card<ReviewerCard>('rev.m1.iface.1.b1');
    await ports.scheduler.run(card.task, { handBack: reviewer(card, 'needs-decision') });
    await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'secretary' || t.card.seat === 'reviewer' ? null : base(t, s));
    const sec = ports.scheduler.queued('secretary')[0]!;
    assert.ok(sec, 'a stopped review has a pending decision');
    assert.notEqual((await labelsOf(ports, [card.target]))[card.target], 'proven');
    await ports.scheduler.run(sec.task, { handBack: secretary(sec.card as SecretaryCard, 'answer', { instructions: 'Reject trailing commas' }) });
    await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'reviewer' ? null : base(t, s));
    const again = ports.scheduler.card<ReviewerCard>('rev.m1.iface.1.b1.r1');
    assert.equal(again.target, card.target);
    assert.ok(again.decisionQuotes.includes('Reject trailing commas'));
    await drive(engine, ports.scheduler, base);
    assert.equal(await current(ports, 'iface'), card.target);
  });

  it('a deferred hand-back is accepted, keeps its owner and reason, and is context on the next cards', async () => {
    const { ports, engine, base } = await waitingRebind();
    const first = ports.scheduler.card<ReviewerCard>('rev.m1.iface.1.b1');
    await ports.scheduler.run(first.task, { handBack: reviewer(first, 'rework', { findings: ['Documentation needs an example'] }) });
    await drive(engine, ports.scheduler, (t, s) => t.task === 'rev.m1.iface.2' ? null : base(t, s));
    const card = ports.scheduler.card<ReviewerCard>('rev.m1.iface.2');
    const issue = card.openIssues[0]!.issue;
    const deferred = { ...reviewer(card, 'rework'), issue_responses: [{ issue, response: 'deferred', owner: 'documentation task', reason: 'The example belongs in the docs change' }] };
    assert.match(renderSeatCard(card, { dispatch: 'D-deferred' }), /Required for deferred.*owner|who owns the issue next/);
    assert.deepEqual(await ports.scheduler.run(card.task, { handBack: deferred }), []);
    const judgment = (await ports.ledger.judgment(`j.${card.task}`)) as JudgmentRecord;
    assert.equal(judgment.issues[0]!.owner, 'documentation task');
    const reason = JSON.parse(ports.ledger.content.get(judgment.issues[0]!.reason!)) as { reason: string };
    assert.equal(reason.reason, deferred.issue_responses[0]!.reason);
    await drive(engine, ports.scheduler, (t) => t.card.seat === 'constructor' || t.card.seat === 'reviewer' ? null : base(t, ports.scheduler));
    const con = ports.scheduler.card<ConstructorCard>('con.m1.iface.3');
    const text = renderCard(con);
    assert.match(text, /deferred to documentation task/);
    assert.ok(!text.split('Instructions:')[0]!.includes(issue), 'the deferred issue is outside the fix list');
    await drive(engine, ports.scheduler, (t, s) => t.task === 'rev.m1.iface.3' ? null : base(t, s));
    const next = ports.scheduler.card<ReviewerCard>('rev.m1.iface.3');
    assert.deepEqual(next.openIssues.map((i) => i.issue), [issue]);
    assert.match(renderCard(next), /deferred to documentation task/);
    await drive(engine, ports.scheduler, base);
  });

  it('fast mode also notifies when only the plan changes; no inferred pass or rebind is written', async () => {
    const { ports, engine } = await setup();
    const old = await acceptedThenStale(ports, engine);
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [old.w], changedItems: ['d1'], mode: 'fast' });
    await drive(engine, ports.scheduler, happyScript(M, keeps));
    assert.deepEqual(await lineEvents(ports, 'iface', 'rebind'), []);
    assert.equal(await current(ports, 'iface'), old.iface);
    assert.ok(ports.ledger.notices.some((n) => n.category === 'kept-product-not-rebound'));
    assert.equal((await labelsOf(ports, [old.iface]))[old.iface], 'not-fully-proven');
  });

  it('successive plans produce .b1 then .b2 and both require seat judgments', async () => {
    const { ports, engine, base } = await waitingRebind();
    await drive(engine, ports.scheduler, base);
    await thirdPlan(ports, engine, keeps);
    const card = ports.scheduler.card<ReviewerCard>('rev.m1.iface.1.b2');
    assert.equal(card.target, 'prod.con.m1.iface.1.b2');
    assert.equal((await labelsOf(ports, [card.target]))[card.target], 'unaccepted');
    await drive(engine, ports.scheduler, base);
    const v = (await ports.ledger.objectVersion(card.target)) as ObjectVersionRecord;
    assert.equal(v.predecessor, 'prod.con.m1.iface.1.b1');
    assert.equal(await current(ports, 'iface'), card.target);
  });
});

it('rebind replay compares all immutable request fields without needing git', async () => {
  const ports = memoryPorts();
  world = ports;
  const c = ports.ledger.content;
  const from: ObjectVersionRecord = {
    kind: 'object.version', object: 'original' as never, objectKind: 'product', mission: M, module: 'parser' as never,
    content: c.put('same bytes'), prerequisites: c.putList([]), scope: { paths: [], taskType: 'implementation' }, reviews: [],
    source: { commit: 'a'.repeat(40) as never, writeScope: [], transform: c.put('{}'), origin: 'b'.repeat(40) as never },
  };
  ports.ledger.commit([from, { ...from, object: 'other' as never }]);
  const actions = gitActions(ports.ctx);
  const req = { mission: M, of: 'original', object: 'rebound', prerequisites: ['p1'], reviews: [{ review: 'reviewer', basisLines: ['std1' as never], reliesOn: ['plan1' as never] }] };
  const result = await actions.rebind(req);
  const head = ports.ledger.head;
  assert.deepEqual(await actions.rebind(req), result);
  assert.equal(ports.ledger.head, head);
  for (const different of [
    { ...req, of: 'other' }, { ...req, mission: 'm2' as MissionId }, { ...req, prerequisites: ['p2'] },
    { ...req, reviews: [{ ...req.reviews[0]!, basisLines: ['std2' as never] }] },
    { ...req, reviews: [{ ...req.reviews[0]!, reliesOn: ['plan2' as never] }] },
    { ...req, reviews: [{ ...req.reviews[0]!, review: 'another-review' }] },
  ]) {
    await assert.rejects(actions.rebind(different), (e: { code?: string }) => e.code === 'conflict');
    assert.equal(ports.ledger.head, head, 'a mismatching replay writes no record');
  }
});

describe('rebind re-entry exits', () => {
  for (const option of ['rework', 'replan'] as const) {
    it(`needs-decision can leave through the Secretary's ${option}`, async () => {
      const { ports, engine, base } = await waitingRebind();
      const card = ports.scheduler.card<ReviewerCard>('rev.m1.iface.1.b1');
      await ports.scheduler.run(card.task, { handBack: reviewer(card, 'needs-decision') });
      await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'secretary' || t.card.seat === 'reviewer' ? null : base(t, s));
      const sec = ports.scheduler.queued('secretary')[0]!;
      assert.ok(sec);
      await ports.scheduler.run(sec.task, { handBack: secretary(sec.card as SecretaryCard, option) });
      await engine.reconcile(M);
      if (option === 'rework') {
        assert.ok(ports.scheduler.tasks.has('con.m1.iface.2'));
        await drive(engine, ports.scheduler, base);
        const next = (await ports.ledger.objectVersion('prod.con.m1.iface.2')) as ObjectVersionRecord;
        assert.equal(next.predecessor, card.target);
      } else if (option === 'replan') {
        assert.equal((await lineEvents(ports, 'iface', 'waiting-replan')).length, 1);
        assert.ok(ports.scheduler.queued().some((t) => t.card.seat === 'architect-decompose'), 'the wait has a routed re-plan');
      }
    });
  }

  it('a pending verification and a lost rebind write resume without a pass or a duplicate version', async () => {
    const { ports, engine } = await setup();
    const old = await acceptedThenStale(ports, engine);
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [old.w], changedItems: ['d1'] });
    ports.ledger.failNext = (op) => op.startsWith('flow:rebind:');
    const base = happyScript(M, keeps);
    await assert.rejects(drive(engine, ports.scheduler, base), /injected failure/);
    const target = 'prod.con.m1.iface.1.b1';
    assert.equal((await labelsOf(ports, [target]))[target], 'unaccepted');
    const actions = ports.ctx.actions();
    const verify = actions.verify.bind(actions);
    let pending = true;
    actions.verify = async (req) => req.object === target && pending ? 'pending' : verify(req);
    await drive(new FlowEngine(ports), ports.scheduler, base);
    assert.ok(!ports.scheduler.tasks.has('rev.m1.iface.1.b1'), 'nothing is queued with pending runs');
    assert.equal((await labelsOf(ports, [target]))[target], 'unaccepted');
    pending = false;
    await drive(new FlowEngine(ports), ports.scheduler, base);
    assert.equal(await current(ports, 'iface'), target);
    assert.equal((await lineEvents(ports, 'iface', 'rebind')).length, 1);
  });

  it('a cancelled rebind Reviewer leaves the task abandoned, with no accepted product in use', async () => {
    const { ports, engine } = await waitingRebind();
    await ports.scheduler.cancel('rev.m1.iface.1.b1');
    await engine.reconcile(M);
    assert.equal(await current(ports, 'iface'), null);
    assert.equal((await lineEvents(ports, 'iface', 'abandoned')).length, 1);
    assert.ok(!ports.scheduler.tasks.has('con.m1.docs.1'));
  });

  it('a released rebind Reviewer can be dispatched again and pass the same version', async () => {
    const { ports, engine, base } = await waitingRebind();
    const task = 'rev.m1.iface.1.b1';
    const target = ports.scheduler.card<ReviewerCard>(task).target;
    await ports.scheduler.run(task, { release: 'ended' });
    assert.notEqual((await labelsOf(ports, [target]))[target], 'proven');
    const ran = await drive(engine, ports.scheduler, base);
    assert.ok(ran.includes(task));
    assert.equal(await current(ports, 'iface'), target);
    assert.equal(ports.scheduler.tasks.get(task)?.dispatches.length, 2);
  });

  it('a queued rebind to an older plan is superseded and the current plan has its own Reviewer', async () => {
    const { ports, engine, base } = await waitingRebind();
    await thirdPlan(ports, engine, keeps);
    assert.equal(ports.scheduler.tasks.get('rev.m1.iface.1.b1')?.state, 'abandoned');
    const card = ports.scheduler.card<ReviewerCard>('rev.m1.iface.1.b2');
    assert.deepEqual(ports.ledger.content.getList(card.binding.reliesOn as never), ['dplan.m1.3.1']);
    assert.equal((await labelsOf(ports, [card.target]))[card.target], 'unaccepted');
    await drive(engine, ports.scheduler, base);
    assert.equal(await current(ports, 'iface'), card.target);
  });
});

it('rework exhaustion after a rebind has a grant exit and keeps earlier findings and deferrals', async () => {
  const { ports, engine, base } = await waitingRebind();
  await drive(engine, ports.scheduler, (t, s) => {
    if (t.card.seat === 'secretary') return null;
    if (t.card.seat !== 'reviewer' || !t.task.includes('.iface.')) return base(t, s);
    const card = t.card as ReviewerCard;
    const result = reviewer(card, 'rework', { findings: t.task.endsWith('.b1') ? ['Add a documentation example'] : [] });
    result.judgments[0]!.reason = `A distinct missing case in ${t.task}`;
    if (t.task === 'rev.m1.iface.3') result.issue_responses = card.openIssues.map((i) => ({ issue: i.issue, response: 'deferred', owner: 'docs', reason: 'The example belongs to docs' }));
    return { handBack: result };
  });
  assert.ok(ports.ledger.notices.some((n) => n.category === 'loop-exhausted'));
  const sec = ports.scheduler.queued('secretary')[0]!;
  assert.ok(sec, 'exhaustion always has a pending decision');
  await ports.scheduler.run(sec.task, { handBack: secretary(sec.card as SecretaryCard, 'grant', { grantExtra: 1 }) });
  await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'constructor' || t.card.seat === 'reviewer' ? null : base(t, s));
  const con = ports.scheduler.card<ConstructorCard>('con.m1.iface.4');
  assert.match(renderCard(con), /deferred to docs/);
  await drive(engine, ports.scheduler, base);
  const product = (await ports.ledger.objectVersion('prod.con.m1.iface.4')) as ObjectVersionRecord;
  assert.equal(product.predecessor, 'prod.con.m1.iface.3');
  assert.ok(ports.scheduler.card<ReviewerCard>('rev.m1.iface.4').openIssues.some((i) => i.text.includes('deferred to docs')));
  assert.equal(await current(ports, 'iface'), product.object);
});

it('switching to a new fast plan cancels an older queued rebind review and notifies', async () => {
  const { ports, engine, old } = await waitingRebind();
  const w = say(ports, 'Keep the public documentation readable.');
  await recordItem(ports, { mission: M, item: 'd2', type: 'decision', text: 'Keep documentation readable', source: { kind: 'words', words: w, quote: 'documentation readable' } });
  await submitPmBatch(ports, { mission: M, plan: { ...plan2(), round: 3 }, userWords: [w], changedItems: ['d2'], mode: 'fast' });
  await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'reviewer' && t.task.includes('.b') ? null : happyScript(M, keeps)(t, s));
  assert.equal(ports.scheduler.tasks.get('rev.m1.iface.1.b1')?.state, 'abandoned');
  assert.equal(await current(ports, 'iface'), old.iface);
  assert.ok(ports.ledger.notices.some((n) => n.category === 'kept-product-not-rebound' && n.key.includes('dplan.m1.3.1')));
});

it('a running rebind Reviewer finishes under its old card without accepting work for a replacement card', async () => {
  const { ports, engine, base } = await waitingRebind();
  const task = 'rev.m1.iface.1.b1';
  const oldCard = ports.scheduler.card<ReviewerCard>(task);
  ports.scheduler.dispatchOf(task);
  await thirdPlan(ports, engine, () => {
    const p = keeps();
    return { ...p, tasks: p.tasks.map((t) => t.id === 'iface' ? { ...t, goal: `${t.goal}; clarify errors` } : t) };
  });
  assert.equal(ports.scheduler.tasks.get(task)?.state, 'running');
  assert.ok(ports.ledger.notices.some((n) => n.category === 'plan-task-in-flight' && n.trigger.includes(task)));
  assert.deepEqual(await ports.scheduler.run(task, { handBack: reviewer(oldCard, 'pass') }), []);
  await engine.reconcile(M);
  assert.equal(await current(ports, 'iface'), null, 'the replacement card still awaits its own Reviewer');
  assert.deepEqual(await lineEvents(ports, 'iface', 'rebound'), []);
  assert.ok(await ports.ledger.judgment(`j.${task}`), 'the old seat result is preserved');
  await drive(engine, ports.scheduler, base);
  assert.equal(await current(ports, 'iface'), 'prod.con.m1.iface.2');
});

describe('Stabilizer r1: superseded seats and required lineage answers', () => {
  it('holds for a running superseded .b1, then requires its late finding on .b2', async () => {
    const { ports, engine, base } = await waitingRebind();
    const first = ports.scheduler.card<ReviewerCard>('rev.m1.iface.1.b1');
    ports.scheduler.dispatchOf(first.task);
    await thirdPlan(ports, engine, keeps);
    assert.equal(ports.scheduler.tasks.get(first.task)?.state, 'running');
    assert.equal(await ports.ledger.objectVersion('prod.con.m1.iface.1.b2'), null);
    assert.ok(!ports.scheduler.tasks.has('rev.m1.iface.1.b2'));
    assert.deepEqual(await ports.scheduler.run(first.task, { handBack: reviewer(first, 'rework', { findings: ['Reject a trailing comma'] }) }), []);
    await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'reviewer' ? null : base(t, s));
    const next = ports.scheduler.card<ReviewerCard>('rev.m1.iface.1.b2');
    assert.equal(next.openIssues.length, 1);
    assert.equal(next.openIssues[0]!.text, 'Reject a trailing comma');
    assert.ok(!(await lineEvents(ports, 'iface', 'review')).some((e) => e.key === first.task), 'the superseded verdict is not acted on');
    assert.ok(!ports.scheduler.tasks.has('con.m1.iface.2'), 'the superseded rework did not start construction');
    assert.match((await ports.scheduler.run(next.task, { handBack: { ...reviewer(next, 'pass'), issue_responses: [] } })).join(), /has no response/);
    assert.notEqual((await labelsOf(ports, [next.target]))[next.target], 'proven');
    await drive(engine, ports.scheduler, base);
    assert.equal(await current(ports, 'iface'), next.target);
    assert.equal((await labelsOf(ports, [next.target]))[next.target], 'proven');
  });

  it('cancels a superseded running seat released --ended before queueing .b2; full close succeeds', async () => {
    const { ports, engine, base } = await waitingRebind();
    const task = 'rev.m1.iface.1.b1';
    ports.scheduler.dispatchOf(task);
    await thirdPlan(ports, engine, keeps);
    assert.ok(!ports.scheduler.tasks.has('rev.m1.iface.1.b2'));
    await ports.scheduler.run(task, { release: 'ended' });
    await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'reviewer' ? null : base(t, s));
    assert.equal(ports.scheduler.tasks.get(task)?.state, 'abandoned');
    assert.equal(ports.scheduler.tasks.get('rev.m1.iface.1.b2')?.state, 'queued');
    await drive(engine, ports.scheduler, base);
    assert.deepEqual(ports.scheduler.queued(), []);
    assert.equal(pmClose(ports.ctx, M, { mode: 'full' }).mode, 'full');
  });

  it('the next card carries the latest response even when its superseded judgment has no review event', async () => {
    const { ports, engine, base, card, issue } = await reviewWithIssue();
    await drive(engine, ports.scheduler, base);
    const w = await laterDecision(ports);
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [w], changedItems: ['d1'] });
    await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'reviewer' ? null : base(t, s));
    const first = ports.scheduler.card<ReviewerCard>('rev.m1.iface.2.b1');
    assert.ok(first.openIssues[0]!.text.includes(`fixed by j.${card.task} on ${card.target}`));
    ports.scheduler.dispatchOf(first.task);
    await thirdPlan(ports, engine, keeps);
    const reason = 'Wait for the API documentation';
    await ports.scheduler.run(first.task, { handBack: { ...reviewer(first, 'rework'), issue_responses: [{ issue, response: 'deferred', owner: 'docs', reason }] } });
    await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'reviewer' ? null : base(t, s));
    const next = ports.scheduler.card<ReviewerCard>('rev.m1.iface.2.b2');
    assert.deepEqual(next.openIssues.map((i) => i.issue), [issue]);
    assert.ok(next.openIssues[0]!.text.includes(`deferred to docs by j.${first.task} on ${first.target}: ${reason}`));
    assert.ok(!(await lineEvents(ports, 'iface', 'review')).some((e) => e.key === first.task));
    await drive(engine, ports.scheduler, base);
    assert.equal(await current(ports, 'iface'), next.target);
  });

  for (const path of ['ordinary', 'rebind'] as const) {
    it(`${path}: a Secretary answer keeps the earlier round's finding required on the same version`, async () => {
      const { ports, engine } = path === 'rebind' ? await waitingRebind() : await setup();
      const base = happyScript(M, path === 'rebind' ? keeps : () => detailedPlan(M));
      const task = `rev.m1.iface.1${path === 'rebind' ? '.b1' : ''}`;
      await drive(engine, ports.scheduler, (t, s) => t.task === task ? null : base(t, s));
      const first = ports.scheduler.card<ReviewerCard>(task);
      assert.deepEqual(await ports.scheduler.run(task, { handBack: reviewer(first, 'needs-decision', { findings: ['Clarify the trailing-comma example'] }) }), []);
      await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'secretary' || t.card.seat === 'reviewer' ? null : base(t, s));
      const sec = ports.scheduler.queued('secretary')[0]!;
      await ports.scheduler.run(sec.task, { handBack: secretary(sec.card as SecretaryCard, 'answer', { instructions: 'Reject trailing commas' }) });
      await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'reviewer' ? null : base(t, s));
      const next = ports.scheduler.card<ReviewerCard>(`${task}.r1`);
      assert.equal(next.target, first.target);
      assert.equal(next.openIssues.length, 1);
      assert.equal(next.openIssues[0]!.text, 'Clarify the trailing-comma example');
      assert.match((await ports.scheduler.run(next.task, { handBack: { ...reviewer(next, 'pass'), issue_responses: [] } })).join(), /has no response/);
      await drive(engine, ports.scheduler, base);
      assert.equal(await current(ports, 'iface'), next.target);
      assert.equal((await labelsOf(ports, [next.target]))[next.target], 'proven');
    });
  }
});

/** Renew can request a seat judgment of the currently accepted version without changing its id. */
async function requestEnvironmentReview(ports: World, taskId: string): Promise<void> {
  const target = (await current(ports, taskId))!;
  const judgment = (await ports.evaluator.deciding([target])).views[target]!.positions.find((p) => p.review === 'reviewer')!.by!;
  const ctx = flowCtx(ports, M);
  const environment = ports.ctx.environment().identity;
  const body: ReviewNeededBody = { target, judgment, review: 'reviewer', environment, reason: 'environment renewal requires a seat judgment', rerun: null, passed: null };
  await commit(ctx, `test:r2:renew:${target}`, { events: [ev(ctx, RENEW_LINE, REVIEW_NEEDED, `${judgment}@${environment}`, body)] });
}

describe('Stabilizer r2 Fix D: cancellation repeats across every supersession exit', () => {
  const changedCards = (): DetailedPlanDoc => {
    const p = keeps();
    return { ...p, tasks: p.tasks.map((t) => ({ ...t, goal: `${t.goal}; clarify errors` })) };
  };
  const renamedCards = (): DetailedPlanDoc => {
    const p = changedCards();
    return { ...p, tasks: p.tasks.map((t) => ({ ...t, id: t.id === 'iface' ? 'iface-new' : t.id, dependsOn: t.dependsOn.map((d) => d === 'iface' ? 'iface-new' : d) })) };
  };
  async function assertProven(ports: World, tasks: readonly string[]): Promise<void> {
    const products: string[] = [];
    for (const id of tasks) {
      const product = await current(ports, id);
      assert.ok(product, `${id}: current output is accepted`);
      products.push(product);
    }
    assert.deepEqual(await labelsOf(ports, products), Object.fromEntries(products.map((p) => [p, 'proven'])));
  }

  for (const release of ['ended', 'abandoned'] as const) {
    it(`T${release === 'ended' ? '1' : '3'}: respec all cards while .b1 runs, then release --${release}; full close succeeds`, async () => {
      const { ports, engine } = await waitingRebind();
      const task = 'rev.m1.iface.1.b1';
      ports.scheduler.dispatchOf(task);
      await thirdPlan(ports, engine, changedCards);
      assert.equal(ports.scheduler.tasks.get(task)?.state, 'running');
      assert.ok(ports.ledger.notices.some((n) => n.category === 'plan-task-in-flight' && n.wi === 'WI-23' && n.trigger.includes(task)));
      assert.deepEqual(await ports.scheduler.run(task, { release }), []);
      assert.equal(ports.scheduler.tasks.get(task)?.state, 'abandoned', 'release reconciliation cancels the requeued obsolete step');
      const base = happyScript(M, changedCards);
      const ran = await drive(engine, ports.scheduler, (t, s) => t.task === task ? null : base(t, s));
      assert.equal(ports.scheduler.tasks.get(task)?.state, 'abandoned');
      assert.ok(!ran.includes(task), 'obsolete work is never dispatched again');
      assert.deepEqual(await lineEvents(ports, 'iface', 'abandoned'), []);
      assert.ok(!(await lineEvents(ports, 'iface', 'review')).some((e) => e.key === task));
      await assertProven(ports, ['iface', 'impl', 'docs']);
      assert.equal(pmClose(ports.ctx, M, { mode: 'full' }).mode, 'full');
    });
  }

  it('T2: drop/rename while .b1 runs, then release --ended; full close has no unfinished obsolete item', async () => {
    const { ports, engine } = await waitingRebind();
    const task = 'rev.m1.iface.1.b1';
    ports.scheduler.dispatchOf(task);
    await thirdPlan(ports, engine, renamedCards);
    assert.equal(ports.scheduler.tasks.get(task)?.state, 'running');
    assert.equal((await lineEvents(ports, 'iface', 'dropped')).length, 1);
    assert.deepEqual(await ports.scheduler.run(task, { release: 'ended' }), []);
    const base = happyScript(M, renamedCards);
    await drive(engine, ports.scheduler, (t, s) => t.task === task ? null : base(t, s));
    assert.equal(ports.scheduler.tasks.get(task)?.state, 'abandoned');
    assert.deepEqual(await lineEvents(ports, 'iface', 'abandoned'), []);
    assert.equal((await lineEvents(ports, 'iface', 'dropped')).length, 1, 'cleanup works after the drop event is already recorded');
    await assertProven(ports, ['iface-new', 'impl', 'docs']);
    try {
      assert.equal(pmClose(ports.ctx, M, { mode: 'full' }).mode, 'full');
    } catch (error) {
      // Close also checks historical accepted outputs, including the dropped task's stale product.
      assert.ok(error instanceof Error);
      assert.match(error.message, /not proven prod\.con\.m1\.iface\.1/);
      assert.doesNotMatch(error.message, /\d+ unfinished item/);
    }
  });

  for (const seat of ['con', 'rev'] as const) {
    it(`T4: respec while old-attempt ${seat} runs, then release --ended; it ends cancelled`, async () => {
      const { ports, engine } = await setup();
      const task = `${seat}.m1.iface.1`;
      const initial = happyScript(M);
      await drive(engine, ports.scheduler, (t, s) => t.task === task ? null : initial(t, s));
      assert.equal(ports.scheduler.tasks.get(task)?.state, 'queued');
      ports.scheduler.dispatchOf(task);
      const w = await laterDecision(ports);
      await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [w], changedItems: ['d1'] });
      const base = happyScript(M, changedCards);
      const skipOld: Script = (t, s) => t.task === task ? null : base(t, s);
      await drive(engine, ports.scheduler, skipOld);
      assert.equal(ports.scheduler.tasks.get(task)?.state, 'running');
      assert.equal(await current(ports, 'iface'), 'prod.con.m1.iface.2');
      assert.deepEqual(await ports.scheduler.run(task, { release: 'ended' }), []);
      await drive(engine, ports.scheduler, skipOld);
      assert.equal(ports.scheduler.tasks.get(task)?.state, 'abandoned');
      assert.deepEqual(await lineEvents(ports, 'iface', 'abandoned'), []);
      await assertProven(ports, ['iface', 'impl', 'docs']);
      assert.equal(pmClose(ports.ctx, M, { mode: 'full' }).mode, 'full');
    });
  }

  for (const round of ['b1', 'e1'] as const) {
    it(`T5: abandon an accepted task while .${round} runs, then release --ended; it ends cancelled`, async () => {
      const { ports, engine, base } = await waitingRebind();
      if (round === 'e1') {
        await drive(engine, ports.scheduler, base);
        await requestEnvironmentReview(ports, 'iface');
        await engine.reconcile(M);
      }
      const task = `rev.m1.iface.1.${round}`;
      assert.equal(ports.scheduler.tasks.get(task)?.state, 'queued');
      ports.scheduler.dispatchOf(task);
      const ctx = flowCtx(ports, M);
      const escalation = 'r2-abandon-iface';
      await raiseEscalation(ctx, { id: escalation, source: 'replan', lineage: taskLineage(M, 'iface'), subject: 'task:iface', summary: 'The user may give up the accepted task', reasons: ['user requested disposition'], options: ['abandon'], facts: { attempt: 1 } });
      await answerEscalation(ports, { mission: M, escalation, option: 'abandon', words: 'Give up this task.' });
      const reports = await engine.reconcile(M);
      assert.deepEqual(reports.flatMap((r) => r.errors), []);
      assert.equal(await current(ports, 'iface'), null);
      assert.equal((await lineEvents(ports, 'iface', 'abandoned')).length, 1);
      assert.equal(ports.scheduler.tasks.get(task)?.state, 'running');
      assert.deepEqual(await ports.scheduler.run(task, { release: 'ended' }), []);
      await engine.reconcile(M);
      assert.equal(ports.scheduler.tasks.get(task)?.state, 'abandoned');
      assert.equal((await lineEvents(ports, 'iface', 'abandoned')).length, 1);
      assert.ok(!(await lineEvents(ports, 'iface', 'review')).some((e) => e.key === task));
    });
  }

  it('T6: an accepted .b1 with a legitimate .e1 still queued passes the independent invariant', async () => {
    const { ports, engine, base } = await waitingRebind();
    await drive(engine, ports.scheduler, base);
    const accepted = (await current(ports, 'iface'))!;
    assert.equal(accepted, 'prod.con.m1.iface.1.b1');
    await requestEnvironmentReview(ports, 'iface');
    await engine.reconcile(M);
    const task = 'rev.m1.iface.1.e1';
    assert.equal(ports.scheduler.tasks.get(task)?.state, 'queued');
    assert.equal(ports.scheduler.card<ReviewerCard>(task).target, accepted);
    await assertSeatProofs(ports);
    await engine.reconcile(M);
    assert.equal(ports.scheduler.tasks.get(task)?.state, 'queued', 'active re-review survives repeated cleanup');
  });
});

/** A finding required on attempt 2, before dependent tasks start. */
async function reviewWithIssue() {
  const w = { ...await setup(), base: happyScript(M, keeps) };
  await drive(w.engine, w.ports.scheduler, (t, s) => t.task === 'rev.m1.iface.1' ? null : w.base(t, s));
  const first = w.ports.scheduler.card<ReviewerCard>('rev.m1.iface.1');
  await w.ports.scheduler.run(first.task, { handBack: reviewer(first, 'rework', { findings: ['Document the trailing-comma example'] }) });
  await drive(w.engine, w.ports.scheduler, (t, s) => t.task === 'rev.m1.iface.2' ? null : w.base(t, s));
  const card = w.ports.scheduler.card<ReviewerCard>('rev.m1.iface.2');
  return { ...w, card, issue: card.openIssues[0]!.issue };
}

describe('Stabilizer r1: per-version deferrals and closing risks', () => {
  it('a pass with a deferral sends a normal PM notice and full close lists owner and reason', async () => {
    const { ports, engine, base, card, issue } = await reviewWithIssue();
    const reason = 'Only until the public API is final';
    assert.deepEqual(await ports.scheduler.run(card.task, { handBack: { ...reviewer(card, 'pass'), issue_responses: [{ issue, response: 'deferred', owner: 'docs', reason }] } }), []);
    // A lost review-event write must retry the same notice, without duplicating it.
    ports.ledger.failNext = (op) => op === `flow:review:${M}:${card.task}`;
    const reports = await engine.reconcile(M);
    assert.match(reports.flatMap((r) => r.errors.map((e) => e.message)).join(), /injected failure/);
    assert.ok(!(await lineEvents(ports, 'iface', 'review')).some((e) => e.key === card.task));
    await drive(engine, ports.scheduler, base);
    const notices = ports.ledger.notices.filter((n) => n.category === 'reviewer-issue-deferred');
    assert.equal(notices.length, 1);
    const notice = notices[0]!;
    assert.equal(notice.wi, null);
    assert.deepEqual(notice.detail, { task: 'iface', version: card.target, judgment: `j.${card.task}`, issue, owner: 'docs', reason });
    assert.match(notice.defaultAction, /stays unfixed.*listed at close.*re-plan or the user/);
    const stored = ports.memory.read((db) => db.stmt('SELECT state FROM lbl_fixes WHERE target = ? AND issue = ?').get(card.target, issue)) as { state: string };
    assert.equal(stored.state, 'unfixed');
    assert.equal((await labelsOf(ports, [card.target]))[card.target], 'proven');
    const close = pmClose(ports.ctx, M, { mode: 'full' });
    assert.ok(close.risks.includes(`issue ${issue} on ${card.target}: deferred to docs: ${reason}`));
  });

  it('rework keeps deferral outside the Constructor fix list and required on the final Reviewer', async () => {
    const { ports, engine, base, card, issue } = await reviewWithIssue();
    const reason = 'Only until the public API is final';
    const answer = { issue, response: 'deferred' as const, owner: 'docs', reason };
    assert.deepEqual(await ports.scheduler.run(card.task, { handBack: { ...reviewer(card, 'rework'), issue_responses: [answer] } }), []);
    await drive(engine, ports.scheduler, (t, s) => t.card.seat === 'constructor' || t.card.seat === 'reviewer' ? null : base(t, s));
    const con = renderCard(ports.scheduler.card<ConstructorCard>('con.m1.iface.3'));
    assert.ok(!con.split('Instructions:')[0]!.includes(issue));
    assert.ok(con.includes(`deferred to docs by j.${card.task} on ${card.target}: ${reason}`));
    await drive(engine, ports.scheduler, (t, s) => t.task === 'rev.m1.iface.3' ? null : base(t, s));
    const next = ports.scheduler.card<ReviewerCard>('rev.m1.iface.3');
    assert.deepEqual(next.openIssues.map((i) => i.issue), [issue]);
    assert.ok(next.openIssues[0]!.text.includes(`deferred to docs by j.${card.task} on ${card.target}: ${reason}`));
    assert.match((await ports.scheduler.run(next.task, { handBack: { ...reviewer(next, 'pass'), issue_responses: [] } })).join(), /has no response/);
    assert.deepEqual(await ports.scheduler.run(next.task, { handBack: { ...reviewer(next, 'pass'), issue_responses: [answer] } }), []);
    await drive(engine, ports.scheduler, base);
    assert.ok(!ports.scheduler.tasks.has('con.m1.iface.4'), 'repeating deferred with pass does not force rework');
    const close = pmClose(ports.ctx, M, { mode: 'full' });
    assert.ok(close.risks.includes(`issue ${issue} on ${next.target}: deferred to docs: ${reason}`));
    assert.ok(!close.risks.some((r) => r.includes(`on ${card.target}:`)), 'only the selected version is listed');
  });

  it('a not-fixed answer with pass is listed at full close', async () => {
    const { ports, engine, base, card, issue } = await reviewWithIssue();
    assert.deepEqual(await ports.scheduler.run(card.task, { handBack: { ...reviewer(card, 'pass'), issue_responses: [{ issue, response: 'not-fixed', reason: 'The example is still missing' }] } }), []);
    await drive(engine, ports.scheduler, base);
    const close = pmClose(ports.ctx, M, { mode: 'full' });
    assert.ok(close.risks.includes(`issue ${issue} on ${card.target}: unfixed`));
    assert.ok(!ports.ledger.notices.some((n) => n.category === 'reviewer-issue-deferred'));
  });
});

describe('Stabilizer r3: close, then release an obsolete seat', () => {
  const changedCards = (): DetailedPlanDoc => {
    const p = keeps();
    return { ...p, tasks: p.tasks.map((t) => ({ ...t, goal: `${t.goal}; clarify errors` })) };
  };
  const renamedCards = (): DetailedPlanDoc => {
    const p = changedCards();
    return { ...p, tasks: p.tasks.map((t) => ({ ...t, id: t.id === 'iface' ? 'iface-new' : t.id, dependsOn: t.dependsOn.map((d) => d === 'iface' ? 'iface-new' : d) })) };
  };
  async function ready(ports: World): Promise<string[]> {
    const { readSteps } = await import('../src/process/pm.ts');
    return readSteps(ports.ctx).ready.map((r) => r.step);
  }
  async function closedThenReleased(ports: World, engine: FlowEngine, task: string, release: 'ended' | 'abandoned'): Promise<void> {
    assert.equal(ports.scheduler.tasks.get(task)?.state, 'running');
    pmClose(ports.ctx, M, { mode: 'with-risk', request: `r3-${task}-${release}` });
    assert.deepEqual(await ports.scheduler.run(task, { release }), []);
    await engine.reconcile(M);
    await engine.reconcile(M);
    assert.equal(ports.scheduler.tasks.get(task)?.state, 'abandoned', `${task}: cancelled after the close`);
    assert.ok(!(await ready(ports)).includes(task));
    assert.ok(!(await lineEvents(ports, task.split('.')[2]!, 'review')).some((e) => e.key === task));
  }

  for (const release of ['ended', 'abandoned'] as const) {
    it(`C1: card changed while .b1 runs, closed with risk, released --${release}: cancelled; full close succeeds`, async () => {
      const { ports, engine } = await waitingRebind();
      const task = 'rev.m1.iface.1.b1';
      ports.scheduler.dispatchOf(task);
      await thirdPlan(ports, engine, changedCards);
      await drive(engine, ports.scheduler, happyScript(M, changedCards));
      await closedThenReleased(ports, engine, task, release);
      assert.deepEqual(await lineEvents(ports, 'iface', 'abandoned'), []);
      assert.equal(pmClose(ports.ctx, M, { mode: 'full', request: `r3-full-${release}` }).mode, 'full');
    });
  }

  it('C2: task dropped while .b1 runs, closed with risk, released --ended: cancelled; no unfinished item', async () => {
    const { ports, engine } = await waitingRebind();
    const task = 'rev.m1.iface.1.b1';
    ports.scheduler.dispatchOf(task);
    await thirdPlan(ports, engine, renamedCards);
    await drive(engine, ports.scheduler, happyScript(M, renamedCards));
    await closedThenReleased(ports, engine, task, 'ended');
    try {
      pmClose(ports.ctx, M, { mode: 'full', request: 'r3-full-drop' });
    } catch (error) {
      assert.doesNotMatch((error as Error).message, /\d+ unfinished item/);
    }
  });

  for (const seat of ['con', 'rev'] as const) {
    it(`C4: old-attempt ${seat} running across a respec, closed with risk, released --ended: cancelled`, async () => {
      const { ports, engine } = await setup();
      const task = `${seat}.m1.iface.1`;
      const initial = happyScript(M);
      await drive(engine, ports.scheduler, (t, s) => t.task === task ? null : initial(t, s));
      ports.scheduler.dispatchOf(task);
      const w = await laterDecision(ports);
      await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [w], changedItems: ['d1'] });
      const base = happyScript(M, changedCards);
      await drive(engine, ports.scheduler, (t, s) => t.task === task ? null : base(t, s));
      await closedThenReleased(ports, engine, task, 'ended');
      assert.equal(pmClose(ports.ctx, M, { mode: 'full', request: `r3-full-${seat}` }).mode, 'full');
    });
  }

  for (const round of ['b1', 'e1'] as const) {
    it(`C5: task abandoned while .${round} runs, closed with risk, released --ended: cancelled`, async () => {
      const { ports, engine, base } = await waitingRebind();
      if (round === 'e1') {
        await drive(engine, ports.scheduler, base);
        await requestEnvironmentReview(ports, 'iface');
        await engine.reconcile(M);
      }
      const task = `rev.m1.iface.1.${round}`;
      ports.scheduler.dispatchOf(task);
      const ctx = flowCtx(ports, M);
      const escalation = `r3-abandon-${round}`;
      await raiseEscalation(ctx, { id: escalation, source: 'replan', lineage: taskLineage(M, 'iface'), subject: 'task:iface', summary: 'The user may give up the accepted task', reasons: ['user requested disposition'], options: ['abandon'], facts: { attempt: 1 } });
      await answerEscalation(ports, { mission: M, escalation, option: 'abandon', words: 'Give up this task.' });
      await engine.reconcile(M);
      await closedThenReleased(ports, engine, task, 'ended');
    });
  }

  it('C6: an old-attempt .e1 running across a respec, closed with risk, released --ended: cancelled, never ready', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, happyScript(M));
    await requestEnvironmentReview(ports, 'iface');
    await engine.reconcile(M);
    const task = 'rev.m1.iface.1.e1';
    ports.scheduler.dispatchOf(task);
    const w = await laterDecision(ports);
    await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [w], changedItems: ['d1'] });
    await drive(engine, ports.scheduler, happyScript(M, changedCards));
    assert.equal(await current(ports, 'iface'), 'prod.con.m1.iface.2');
    await closedThenReleased(ports, engine, task, 'ended');
    assert.equal(pmClose(ports.ctx, M, { mode: 'full', request: 'r3-full-e1' }).mode, 'full');
  });

  for (const when of ['before', 'after'] as const) {
    it(`C7: a current .e1 requested ${when} the close survives every closed pass, is ready, and its pass keeps the product proven`, async () => {
      const { ports, engine, base } = await waitingRebind();
      await drive(engine, ports.scheduler, base);
      const accepted = (await current(ports, 'iface'))!;
      assert.equal(accepted, 'prod.con.m1.iface.1.b1');
      if (when === 'before') { await requestEnvironmentReview(ports, 'iface'); await engine.reconcile(M); }
      pmClose(ports.ctx, M, { mode: 'with-risk', request: `r3-e1-${when}` });
      if (when === 'after') await requestEnvironmentReview(ports, 'iface');
      await engine.reconcile(M);
      await engine.reconcile(M);
      const task = 'rev.m1.iface.1.e1';
      assert.equal(ports.scheduler.tasks.get(task)?.state, 'queued');
      assert.ok((await ready(ports)).includes(task));
      await assertSeatProofs(ports);
      await drive(engine, ports.scheduler, base);
      assert.equal(ports.scheduler.tasks.get(task)?.state, 'done');
      assert.equal(await current(ports, 'iface'), accepted);
      assert.deepEqual(await labelsOf(ports, [accepted]), { [accepted]: 'proven' });
    });
  }
});
