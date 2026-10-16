// Dispatch pins and carry re-entry paths on real SQLite, without git.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { flowCtx } from '../src/flow/context.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { constructorDone, detailedPlan, drive, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import { ActionError } from '../src/process/actions.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
async function setup() {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  const engine = new FlowEngine(ports);
  const script = happyScript(M);
  await drive(engine, ports.scheduler, (t, s) => t.task === 'con.m1.impl.1' ? null : script(t, s));
  return { ports, engine, script };
}
const event = (line: string, name: string, key: string, body: unknown) => ({ mission: M, line, event: name, key, body });

test('B dispatched on A1 keeps A1 when A2 is accepted before B hands back', async () => {
  const { ports, engine, script } = await setup();
  const old = 'prod.con.m1.iface.1';
  const newer = `${old}.new`;
  const rec = (await ports.ledger.objectVersion(old))!;
  await ports.scheduler.rebind({ mission: M, of: old, object: newer, prerequisites: [], reviews: rec.reviews });
  await ports.ledger.append('test:newer-acceptance', { events: [event('task:iface', 'rebound', '1:b1', { k: 1, n: 1, product: newer, judgment: 'j.rev.m1.iface.1', how: 'review' })] });
  await drive(engine, ports.scheduler, script);
  const product = (await ports.ledger.objectVersion('prod.con.m1.impl.1'))!;
  assert.deepEqual(ports.ledger.content.getList(product.prerequisites), [old]);
  const dispatched = (await ports.ledger.events<{ prerequisites: string[] }>({ mission: M, line: 'task:impl', event: 'dispatched' }))[0]!;
  assert.deepEqual(dispatched.body.prerequisites, [old]);
});

test('an intervening cancelled attempt does not erase the latest recorded work under the same spec', async () => {
  const { ports, engine } = await setup();
  await ports.scheduler.run('con.m1.impl.1', { handBack: constructorDone() });
  await engine.reconcile(M);
  const c = ports.scheduler.card<ReviewerCard>('rev.m1.impl.1');
  await ports.scheduler.run('rev.m1.impl.1', { handBack: reviewer(c, 'rework', { failing: 'S1' }) });
  await engine.reconcile(M);
  await ports.scheduler.cancel('con.m1.impl.2');
  await ports.ledger.append('test:cancelled-attempt', { events: [event('task:impl', 'rework', '3', { k: 3, reason: 'replan', issues: [], instructions: [] })] });
  let carried: string | null = null;
  ports.scheduler.actions = { async snapshot(req) {
    carried = req.carry?.version ?? null;
    return { path: req.commit ?? 'b'.repeat(40), commit: req.commit ?? 'b'.repeat(40) };
  } };
  await engine.reconcile(M);
  assert.equal(carried, 'prod.con.m1.impl.1');
  assert.ok(ports.scheduler.queued().some((t) => t.task === 'con.m1.impl.3'), 'waiting always has an actionable attempt');
});

test('a conflicting carry retries, then a changed card starts without it and can finish', async () => {
  const { ports, engine } = await setup();
  await ports.scheduler.run('con.m1.impl.1', { handBack: constructorDone() });
  await engine.reconcile(M);
  const c = ports.scheduler.card<ReviewerCard>('rev.m1.impl.1');
  await ports.scheduler.run('rev.m1.impl.1', { handBack: reviewer(c, 'rework', { failing: 'S1' }) });
  let conflicts = 0;
  ports.scheduler.actions = { async snapshot(req) {
    if (req.carry !== undefined) { conflicts++; throw new ActionError('conflict', 'f conflicts', { carried: true, conflicts: [{ path: 'f' }] }); }
    return { path: 'b'.repeat(40), commit: 'b'.repeat(40), products: req.products ?? [] };
  } };
  await engine.reconcile(M);
  await engine.reconcile(M);
  assert.ok(conflicts >= 2, 'a carry conflict is retried without a permanent dispatch record');
  assert.ok(ports.ledger.notices.some((n) => n.category === 'rework-start-conflict'));
  assert.ok(!ports.scheduler.tasks.has('con.m1.impl.2'));
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M, { elements: pmPlan(M).elements.map((e, i) => i === 0 ? { ...e, text: `${e.text}, revised` } : e) }), userWords: ['W-1'], mode: 'fast' });
  const revised = detailedPlan(M);
  const script = happyScript(M, () => ({ ...revised, tasks: revised.tasks.map((t) => t.id === 'impl' ? { ...t, goal: `${t.goal}, revised` } : t) }));
  await drive(engine, ports.scheduler, script);
  const after = conflicts;
  await engine.reconcile(M);
  assert.equal(conflicts, after, 'the changed card cannot repeat the carry conflict after it takes effect');
  assert.ok(ports.scheduler.tasks.has('con.m1.impl.3'));
  const product = (await ports.ledger.objectVersion('prod.con.m1.impl.3'))!;
  assert.equal(product.predecessor, undefined, 'new spec, no old carried work');
  assert.ok((await ports.ledger.events({ mission: M, line: 'task:impl', event: 'accepted' })).some((e) => e.key === '3'), 'the documented exit reaches acceptance');
});

test('new re-review cards recompute changed paths and leave cached old events intact', async () => {
  const { ports, engine, script } = await setup();
  await drive(engine, ports.scheduler, script);
  const id = 'prod.con.m1.impl.1';
  const before = (await ports.ledger.events<{ changedPaths: string[] }>({ mission: M, line: 'task:impl', event: 'product' }))[0]!.body.changedPaths;
  const read = ports.ledger.objectVersion.bind(ports.ledger);
  ports.ledger.objectVersion = async (object) => {
    const rec = await read(object);
    return rec === null || object !== id ? rec : { ...rec, source: { commit: 'c'.repeat(40) as never, origin: 'b'.repeat(40) as never, writeScope: ['src/parser/impl/**'], transform: rec.content } };
  };
  ports.scheduler.actions = { async product(req) {
    return { object: id, commit: req.candidate, snapshot: req.candidate, changedPaths: ['src/parser/impl/first.ts', 'src/parser/impl/last.ts'] };
  } };
  await ports.ledger.append('test:review-again', { events: [event('task:impl', 'basis-revised', 'upgrade', { k: 1, reason: 'review again after upgrade' })] });
  await engine.reconcile(M);
  const card = ports.scheduler.card<ReviewerCard>('rev.m1.impl.1.e1');
  assert.deepEqual(card.candidate.changedPaths, ['src/parser/impl/first.ts', 'src/parser/impl/last.ts']);
  assert.deepEqual((await ports.ledger.events<{ changedPaths: string[] }>({ mission: M, line: 'task:impl', event: 'product' }))[0]!.body.changedPaths, before);
});

test('a retry between recording dispatch and queueing reuses that start and its pins', async () => {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  const submit = ports.scheduler.submit.bind(ports.scheduler);
  ports.scheduler.submit = async (task) => {
    if (task.task === 'con.m1.impl.1') throw new Error('simulated interruption before queueing');
    return submit(task);
  };
  const engine = new FlowEngine(ports);
  await assert.rejects(drive(engine, ports.scheduler, happyScript(M)), /simulated interruption before queueing/);
  const dispatch = (await ports.ledger.events<{ commit: string; prerequisites: string[] }>({ mission: M, line: 'task:impl', event: 'dispatched' }))[0]!;
  assert.ok(!ports.scheduler.tasks.has('con.m1.impl.1'));
  ports.scheduler.submit = submit;
  let snapshots = 0;
  ports.scheduler.actions = { async snapshot() { snapshots++; throw new Error('must reuse the recorded start'); } };
  await drive(engine, ports.scheduler, happyScript(M));
  assert.equal(snapshots, 0);
  assert.equal(ports.scheduler.card<{ workspace: { snapshot: string } }>('con.m1.impl.1').workspace.snapshot, dispatch.body.commit);
  const product = (await ports.ledger.objectVersion('prod.con.m1.impl.1'))!;
  assert.deepEqual(ports.ledger.content.getList(product.prerequisites), dispatch.body.prerequisites);
});

test('an unpinned pre-upgrade dependent attempt exits through a new pinned and verified attempt', async () => {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  const append = ports.ledger.append.bind(ports.ledger);
  ports.ledger.append = async (op, entries) => append(op, { ...entries, events: entries.events?.map((e) => {
    if (e.event !== 'dispatched' || e.key !== 'con.m1.impl.1') return e;
    const { prerequisites: _pin, ...body } = e.body as { prerequisites?: string[] };
    return { ...e, body };
  }) });
  const submit = ports.scheduler.submit.bind(ports.scheduler);
  ports.scheduler.submit = async (task) => {
    if (task.task === 'con.m1.impl.1') throw new Error('legacy interruption before queueing');
    return submit(task);
  };
  const engine = new FlowEngine(ports);
  await assert.rejects(drive(engine, ports.scheduler, happyScript(M)), /legacy interruption before queueing/);
  ports.scheduler.submit = submit;
  ports.ledger.append = append;
  await drive(engine, ports.scheduler, happyScript(M));
  assert.equal(await ports.ledger.objectVersion('prod.con.m1.impl.1'), null, 'unrecorded prerequisites never become a proven product');
  const product = (await ports.ledger.objectVersion('prod.con.m1.impl.2'))!;
  assert.deepEqual(ports.ledger.content.getList(product.prerequisites), ['prod.con.m1.iface.1']);
  assert.ok((await ports.ledger.events({ mission: M, line: 'task:impl', event: 'accepted' })).some((e) => e.key === '2'));
});

function legacyDispatch(ports: ReturnType<typeof memoryPorts>, task = 'impl', attempts = [1]) {
  const events = ports.ledger.events.bind(ports.ledger);
  ports.ledger.events = (async (q) => (await events(q)).map((e) => {
    if (e.event !== 'dispatched' || !attempts.some((k) => e.key === `con.m1.${task}.${k}`)) return e;
    const { prerequisites: _pin, ...body } = e.body as { prerequisites?: string[] };
    return { ...e, body } as typeof e;
  })) as typeof ports.ledger.events;
}

for (const waiting of ['verification', 'Reviewer']) test(`a legacy product waiting for ${waiting} is carried onto a pinned start and verified again`, async () => {
  const { ports, engine, script } = await setup();
  if (waiting === 'verification') ports.scheduler.verifyDelay = 100;
  await ports.scheduler.run('con.m1.impl.1', { handBack: constructorDone() });
  await engine.reconcile(M);
  const old = (await ports.ledger.events({ mission: M, line: 'task:impl', event: 'product' }))[0]!;
  assert.ok(old);
  legacyDispatch(ports);
  ports.scheduler.verifyDelay = 0;
  await drive(engine, ports.scheduler, script);
  const product = (await ports.ledger.objectVersion('prod.con.m1.impl.2'))!;
  assert.equal(product.predecessor, 'prod.con.m1.impl.1');
  assert.deepEqual(ports.ledger.content.getList(product.prerequisites), ['prod.con.m1.iface.1']);
  assert.deepEqual((await ports.ledger.events({ mission: M, line: 'task:impl', event: 'accepted' })).map((e) => e.key), ['2'], 'the legacy attempt never becomes accepted');
  assert.ok((await ports.ledger.events({ mission: M, line: 'task:impl', event: 'verified' })).some((e) => e.key === '2'));
  assert.deepEqual((await ports.ledger.events({ mission: M, line: 'task:impl', event: 'product' }))[0], old, 'historical product events stay intact');
  assert.equal((await ports.ledger.events<{ reason: string }>({ mission: M, line: 'task:impl', event: 'rework' }))[0]!.body.reason, 'program');
});

test('an accepted legacy record matching its dispatched start is untouched', async () => {
  const { ports, engine, script } = await setup();
  await drive(engine, ports.scheduler, script);
  const dep = (await ports.ledger.objectVersion('prod.con.m1.iface.1'))!;
  await ports.scheduler.rebind({ mission: M, of: dep.object, object: `${dep.object}.later`, prerequisites: [], reviews: dep.reviews });
  await ports.ledger.append('test:later-matching-dependency', { events: [event('task:iface', 'rebound', '1:b1', { k: 1, n: 1, product: `${dep.object}.later`, judgment: 'j.rev.m1.iface.1', how: 'review' })] });
  const before = await ports.ledger.events({ mission: M, line: 'task:impl' });
  legacyDispatch(ports);
  const afterRead = await ports.ledger.events({ mission: M, line: 'task:impl' });
  await engine.reconcile(M);
  assert.equal(await acceptedProduct(flowCtx(ports, M), 'impl'), 'prod.con.m1.impl.1');
  assert.equal(ports.scheduler.tasks.has('con.m1.impl.2'), false);
  assert.deepEqual(await ports.ledger.events({ mission: M, line: 'task:impl' }), afterRead);
  assert.equal(before.length, afterRead.length);
  assert.equal(ports.ledger.notices.some((n) => n.category === 'legacy-prerequisites-restarted'), false);
});

test('an accepted legacy same-content re-bind is untouched', async () => {
  const { ports, engine, script } = await setup();
  const old = 'prod.con.m1.iface.1';
  const newer = `${old}.new`;
  const rec = (await ports.ledger.objectVersion(old))!;
  await ports.scheduler.rebind({ mission: M, of: old, object: newer, prerequisites: [], reviews: rec.reviews });
  await ports.ledger.append('test:legacy-newer-acceptance', { events: [event('task:iface', 'rebound', '1:b1', { k: 1, n: 1, product: newer, judgment: 'j.rev.m1.iface.1', how: 'review' })] });
  // Reproduce the old hand-back policy: record the dependency current at hand-back.
  const product = ports.scheduler.product.bind(ports.scheduler);
  ports.scheduler.product = (req) => product(req.task === 'con.m1.impl.1' ? { ...req, prerequisites: [newer] } : req);
  await drive(engine, ports.scheduler, script);
  ports.scheduler.product = product;
  legacyDispatch(ports);
  assert.equal(await acceptedProduct(flowCtx(ports, M), 'impl'), 'prod.con.m1.impl.1');
  await engine.reconcile(M);
  assert.equal(ports.scheduler.tasks.has('con.m1.impl.2'), false);
  assert.equal(ports.ledger.notices.some((n) => n.category === 'legacy-prerequisites-restarted'), false);
});

test('a legacy task without dependencies is untouched', async () => {
  const { ports, engine, script } = await setup();
  await drive(engine, ports.scheduler, script);
  legacyDispatch(ports, 'iface');
  const before = await ports.ledger.events({ mission: M, line: 'task:iface' });
  await engine.reconcile(M);
  assert.deepEqual(await ports.ledger.events({ mission: M, line: 'task:iface' }), before);
  assert.equal(await acceptedProduct(flowCtx(ports, M), 'iface'), 'prod.con.m1.iface.1');
});

for (const newOrigin of [false, true]) test(`accepted legacy rework with identical dependency content holds with ${newOrigin ? 'a carried origin' : 'a continued start'}`, async () => {
  const { ports, engine, script } = await setup();
  await ports.scheduler.run('con.m1.impl.1', { handBack: constructorDone() });
  await engine.reconcile(M);
  const card = ports.scheduler.card<ReviewerCard>('rev.m1.impl.1');
  await ports.scheduler.run('rev.m1.impl.1', { handBack: reviewer(card, 'rework', { failing: 'S1' }) });
  const old = 'prod.con.m1.iface.1';
  const newer = `${old}.new`;
  const rec = (await ports.ledger.objectVersion(old))!;
  await ports.scheduler.rebind({ mission: M, of: old, object: newer, prerequisites: [], reviews: rec.reviews });
  await ports.ledger.append('test:legacy-rework-newer', { events: [event('task:iface', 'rebound', '1:b1', { k: 1, n: 1, product: newer, judgment: 'j.rev.m1.iface.1', how: 'review' })] });
  ports.scheduler.actions = { async snapshot(req) {
    const commit = newOrigin ? 'c'.repeat(40) : req.commit!;
    return { path: commit, commit, products: req.carry?.products ?? req.products ?? [], ...(newOrigin ? { origin: 'd'.repeat(40) } : {}) };
  } };
  await drive(engine, ports.scheduler, script);
  assert.equal(await acceptedProduct(flowCtx(ports, M), 'impl'), 'prod.con.m1.impl.2');
  legacyDispatch(ports, 'impl', [1, 2]);
  await engine.reconcile(M);
  assert.equal(await acceptedProduct(flowCtx(ports, M), 'impl'), 'prod.con.m1.impl.2');
  assert.equal(ports.scheduler.tasks.has('con.m1.impl.3'), false);
});

test('the scheduler composition and dispatch use the same whole prerequisite closure', async () => {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  const p = detailedPlan(M, { extraTask: true });
  const engine = new FlowEngine(ports);
  const script = happyScript(M, () => p);
  await drive(engine, ports.scheduler, (t, s) => t.task === 'rev.m1.docs.1' ? null : script(t, s));
  const closure = await ports.scheduler.composition(['prod.con.m1.impl.1']);
  assert.deepEqual(closure, ['prod.con.m1.iface.1', 'prod.con.m1.impl.1']);
  const docs = (await ports.ledger.events<{ prerequisites: string[] }>({ mission: M, line: 'task:docs', event: 'dispatched' }))[0]!;
  assert.deepEqual(docs.body.prerequisites, closure);
  const dep = (await ports.ledger.objectVersion('prod.con.m1.iface.1'))!;
  await ports.scheduler.rebind({ mission: M, of: dep.object, object: 'unit-peer', prerequisites: [], reviews: dep.reviews });
  await ports.ledger.append('test:composition-unit', { records: [{ kind: 'proof.unit', unit: 'start-unit' as never, members: ports.ledger.content.putList([dep.object, 'unit-peer']), reviews: dep.reviews }] });
  const whole = await ports.scheduler.composition(['prod.con.m1.impl.1']);
  assert.deepEqual([...whole].sort(), [dep.object, 'prod.con.m1.impl.1', 'unit-peer'].sort());
  const snap = await ports.scheduler.snapshot({ mission: M, purpose: 'test-proof-unit', products: ['prod.con.m1.impl.1'] });
  assert.deepEqual(snap.products, whole);
});
