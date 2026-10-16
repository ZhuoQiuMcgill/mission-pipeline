// Products accepted under a PM plan version that no longer holds (design 4.1 Appendix J; v51 5.2):
// a product's Reviewer contract relies on the detailed plan in effect when it was recorded, fixed
// with the object. When a requirement item makes that plan's PM plan stale, or a re-check negates
// it, a new PM plan version whose detailed plan keeps the task's card must not leave the accepted
// product unproven for good (stable mode would hold every dependent forever). Once the new plan is
// proven, the product is re-bound: a new version of the same content whose contract relies on the
// new plan, the Reviewer judgment carried over by the program when nothing it judged changed, else
// judged again by a Reviewer. A changed card is re-specced and rebuilt as before.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import type { JudgmentRecord, ObjectVersionRecord } from '../src/common/records.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import type { DetailedPlanDoc } from '../src/flow/plandoc.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import type { FlowEvaluatorPort } from '../src/flow/ports.ts';
import { recordConstraint, recordItem } from '../src/flow/requirements.ts';
import { cal1Fail, detailedPlan, drive, happyScript, pmPlan, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import type { Calibrator1Card } from '../src/seat/cards/calibrator.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
const LATER = 'Once it has parsed a file, keep the parser read-only.';
type World = ReturnType<typeof memoryPorts>;

async function setup(): Promise<{ ports: World; engine: FlowEngine }> {
  const ports = memoryPorts();
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

/** After the new version took effect and the flow settled: the kept products re-bound with their judgment carried over, the dependent built. */
async function assertCarriedOver(ports: World, old: { iface: string; impl: string }, ran: readonly string[]): Promise<void> {
  assert.ok(ran.includes('con.m1.docs.1'), `the dependent of the kept products is released: ${ran.join(', ')}`);
  for (const t of ['iface', 'impl']) {
    assert.ok(!ran.some((x) => x.startsWith(`con.m1.${t}.`) || x.startsWith(`rev.m1.${t}.`)), `${t} is neither rebuilt nor judged again: ${ran.join(', ')}`);
  }
  const iface = (await current(ports, 'iface'))!;
  const impl = (await current(ports, 'impl'))!;
  assert.equal(iface, 'prod.con.m1.iface.1.b1');
  assert.equal(impl, 'prod.con.m1.impl.1.b1');
  for (const [t, p, from] of [['iface', iface, old.iface], ['impl', impl, old.impl]] as const) {
    const rb = await lineEvents<{ how: string; from: string; dplan: string; carries: string }>(ports, t, 'rebind');
    assert.deepEqual(rb.map((e) => [e.key, e.body.how, e.body.from, e.body.dplan]), [['1:b1', 'carried', from, 'dplan.m1.2.1']]);
    const v = (await ports.ledger.objectVersion(p)) as ObjectVersionRecord;
    const was = (await ports.ledger.objectVersion(from)) as ObjectVersionRecord;
    assert.equal(v.predecessor, from);
    assert.equal(v.content, was.content, 'the same content');
    assert.deepEqual(v.reviews[0]?.reliesOn, ['dplan.m1.2.1'], 'its contract relies on the plan in effect');
    const rebound = (await lineEvents<{ judgment: string }>(ports, t, 'rebound'))[0]!.body;
    const j = (await ports.ledger.judgment(rebound.judgment)) as JudgmentRecord;
    const j0 = (await ports.ledger.judgment(rb[0]!.body.carries)) as JudgmentRecord;
    assert.equal(j.executor, 'program');
    assert.equal(j.target, p);
    assert.deepEqual(ports.ledger.content.getList(j.evidence), ports.ledger.content.getList(j0.evidence), 'the same runs');
    assert.deepEqual(ports.ledger.content.getList(j.bases), ports.ledger.content.getList(j0.bases), 'the same bases');
    assert.deepEqual(ports.ledger.content.getList(j.reliesOn), ['dplan.m1.2.1']);
  }
  const implV = (await ports.ledger.objectVersion(impl)) as ObjectVersionRecord;
  assert.deepEqual(ports.ledger.content.getList(implV.prerequisites), [iface], "its prerequisite is the dependency's re-bound version");
  const docs = (await current(ports, 'docs'))!;
  assert.deepEqual(await labelsOf(ports, [iface, impl, docs]), { [iface]: 'proven', [impl]: 'proven', [docs]: 'proven' });
  // the old versions keep their history: still not fully proven
  assert.deepEqual(await labelsOf(ports, [old.iface, old.impl]), { [old.iface]: 'not-fully-proven', [old.impl]: 'not-fully-proven' });
  const n = ports.ledger.notices.filter((x) => x.category === 'kept-products-rebound');
  assert.ok(n.length >= 1 && n.every((x) => x.wi === null), `a normal-branch notice tells the PM: ${ports.ledger.notices.map((x) => x.category).join(', ')}`);
  assert.ok(n.some((x) => String(x.defaultAction).includes(`${old.iface} → ${iface}`)));
}

describe('flow: products of kept tasks re-bound to a new plan version (Appendix J)', () => {
  it('a requirement item makes the old plan stale; once the next version maps it and takes effect, the kept products are proven again without a seat and the gate releases their dependent', async () => {
    const { ports, engine } = await setup();
    const old = await acceptedThenStale(ports, engine);
    assert.deepEqual(await submitPmBatch(ports, { mission: M, plan: plan2(), userWords: [old.w], changedItems: ['d1'] }), { batch: 'b2', plan: 'pmplan.m1.2' });
    const ran = await drive(engine, ports.scheduler, happyScript(M, keeps));
    assert.equal((await labelsOf(ports, ['dplan.m1.2.1']))['dplan.m1.2.1'], 'proven');
    await assertCarriedOver(ports, old, ran);
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
    await assertCarriedOver(ports, { iface, impl: 'prod.con.m1.impl.1' }, ran);
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
    assert.deepEqual((await lineEvents<{ how: string }>(ports, 'iface', 'rebind')).map((e) => e.body.how), ['carried']);
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
    assert.match(rb[0]!.body.why.join('; '), /new version/);
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
      assert.match(rb.why.join('; '), /constraints/);
      assert.match(rb.why.join('; '), /definitions of Parser/);
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
    assert.match(n[0]!.trigger, /constraints/);
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
    // P2: the notice's documented exit must not carry the incompatible old implementation again.
    const conflict = new Error('old implementation conflicts with the rebuilt dependency') as Error & { code: string; detail: unknown };
    conflict.code = 'conflict';
    conflict.detail = { carried: true, conflicts: [{ path: 'src/parser/impl/index.ts' }] };
    ports.scheduler.actions = { async snapshot(req) {
      if (req.carry?.version === old.impl) throw conflict;
      return { path: req.commit ?? 'b'.repeat(40), commit: req.commit ?? 'b'.repeat(40), products: req.products ?? [] };
    } };
    const revised = plan2();
    await submitPmBatch(ports, { mission: M, plan: { ...revised, elements: revised.elements.map((e, i) => i === 0 ? { ...e, text: `${e.text}; implementation revised` } : e) }, userWords: [old.w] });
    const fixed = ifaceChanged();
    const completed = await drive(engine, ports.scheduler, happyScript(M, () => ({ ...fixed, tasks: fixed.tasks.map((t) => t.id === 'impl' ? { ...t, goal: `${t.goal}, rebuilt against the current interface` } : t) })));
    assert.ok(completed.includes('con.m1.impl.2'), completed.join(', '));
    assert.equal((await ports.ledger.objectVersion('prod.con.m1.impl.2'))!.predecessor, undefined);
    assert.ok(!ports.ledger.notices.some((n) => n.category === 'rework-start-conflict'), 'a changed card has a usable exit');
    assert.equal(await current(ports, 'impl'), 'prod.con.m1.impl.2');
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
    assert.equal(await current(ports, 'iface'), 'prod.con.m1.iface.1.b1');
    assert.equal(await current(ports, 'impl'), 'prod.con.m1.impl.1.b1');
    assert.ok(ports.scheduler.queued('constructor').some((t) => t.task === 'con.m1.docs.1'), 'the dependent is released');
    await assertCarriedOver(ports, old, await drive(engine, ports.scheduler, happyScript(M, keeps)));
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
    await assertCarriedOver(ports, old, ran);
  });
});
