import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { revision, type MissionId, type ObjectVersionId } from '../src/common/ids.ts';
import type { JudgmentRecord } from '../src/common/records.ts';
import { resolveSubtasks } from '../src/cli/layers.ts';
import { decisionLabels, currentEnvironment, drain, forgetObservedEnvironment, labelBatch, labelStatus, recompute, renewalCandidates } from '../src/evaluator/index.ts';
import { resolveLists } from '../src/evaluator/store.ts';
import { fullCompute, type ResolvedRecord } from '../src/evaluator/semantics.ts';
import { flowCtx } from '../src/flow/context.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import * as execution from '../src/flow/execution.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { recordItem } from '../src/flow/requirements.ts';
import { answerEscalation, carryOut, commitCarrying, decisionFor, isApplied, raiseEscalation, secretaryStep, type DecisionBody } from '../src/flow/secretary.ts';
import { detailedPlan, drive, happyScript, pmPlan, reviewer, secretary, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import { appendRecords, claimDispatch, openMemory, recordsByKind } from '../src/memory/index.ts';
import { pmClose, pmMission, missionState } from '../src/process/close.ts';
import { materialLeaf } from '../src/process/seat.ts';
import { ProcessError } from '../src/process/errors.ts';
import { memoryPorts, say, type MemoryWorld } from './flow-memory-fixtures.ts';
import { provenancePorts } from './start-provenance-fixtures.ts';

const M = 'm1' as MissionId;
const event = (task: string, name: string, key: string, body: unknown) => ({ mission: M, line: `task:${task}`, event: name, key, body });
const current = (w: MemoryWorld, task: string) => execution.acceptedProduct(flowCtx(w, M), task);
const snapshot = (w: MemoryWorld, hash: string) => JSON.parse(w.memory.data.text(hash)) as { proof: { object: string }[]; unfinished: { planTasks: string[] }; risks: string[] };
const notReady = (e: unknown): e is ProcessError => e instanceof ProcessError && e.code === 'NOT_READY';

/** Remove pins before append, exactly the persisted 4.1.0 shape (no read-side mask). */
function oldDispatches(w: MemoryWorld) {
  const pins = new Map<string, readonly string[]>();
  const read = w.ledger.events.bind(w.ledger);
  // Build the old history without invoking 4.1.1 migration while the setup runs.
  w.ledger.events = (async (q) => (await read(q)).map((e) => e.event === 'dispatched' ? { ...e, body: { ...(e.body as object), prerequisites: pins.get(e.key) ?? [] } } : e)) as typeof w.ledger.events;
  const append = w.ledger.append.bind(w.ledger);
  w.ledger.append = (op, entries) => append(op, { ...entries, events: entries.events?.map((e) => {
    if (e.event !== 'dispatched') return e;
    const { prerequisites: pin, ...body } = e.body as { prerequisites?: readonly string[] };
    pins.set(e.key, pin ?? []);
    return { ...e, body };
  }) });
  return () => { w.ledger.events = read; w.ledger.append = append; };
}
async function seed(w: MemoryWorld, mode: 'stable' | 'fast' = 'stable') {
  say(w, SEED_TEXT);
  await seedMission(w, M);
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode });
  return new FlowEngine(w);
}
async function legacyB9() {
  const w = provenancePorts();
  const exposeLegacy = oldDispatches(w.ports);
  const engine = await seed(w.ports);
  const plan = detailedPlan(M, { extraTask: true });
  // File-pointer reviews avoid environment renewal masking the start defect.
  for (const t of plan.tasks) t.verificationCommands = [];
  const script = happyScript(M, () => plan);
  await drive(engine, w.ports.scheduler, (t, s) => t.task === 'con.m1.docs.1' ? null : script(t, s));
  const dispatched = (await w.ports.ledger.events<{ commit: string }>({ mission: M, line: 'task:docs', event: 'dispatched' }))[0]!;
  w.objects.trees.set(dispatched.body.commit, w.entries(dispatched.body.commit).filter((e) => e.path !== 'src/parser/api.ts'));
  await drive(engine, w.ports.scheduler, script);
  exposeLegacy();
  return { ...w, engine, script };
}

test('T1a: close checks the persisted B9 start before any pass; every mode records it (4.1.2: never refused); reopen rebuilds once', async () => {
  const w = await legacyB9();
  const p = 'prod.con.m1.docs.1';
  assert.equal(w.checks.size, 0, 'no flow pass after acceptance has checked the legacy start');
  const full = await pmClose(w.ports.ctx, M, { mode: 'full', request: 'full' });
  for (const text of [p, 'prod.con.m1.iface.1', 'src/parser/api.ts', 'mp pm next']) assert.ok(full.doc.startRisks.some((r) => r.includes(text)), JSON.stringify(full.doc.startRisks));
  assert.equal(w.ports.memory.read((db) => missionState(db, M)), 'closed');
  pmMission(w.ports.ctx, M, 'open');
  assert.equal(w.ports.memory.read((db) => missionState(db, M)), 'open');
  for (const mode of ['with-risk', 'post-audit'] as const) {
    const closed = await pmClose(w.ports.ctx, M, { mode, request: mode });
    assert.ok(closed.risks.some((r) => r.includes(p) && r.includes('src/parser/api.ts')));
    const doc = snapshot(w.ports, closed.snapshot);
    assert.ok(doc.unfinished.planTasks.includes('docs'));
    assert.ok(!doc.proof.some((o) => o.object === p));
    pmMission(w.ports.ctx, M, 'open');
  }
  const passes = await w.engine.reconcile(M);
  assert.deepEqual(passes.flatMap((p) => p.errors), []);
  assert.ok(w.ports.scheduler.queued().some((t) => t.task === 'con.m1.docs.2'), JSON.stringify({ queued: w.ports.scheduler.queued().map((t) => t.task), notices: w.ports.ledger.notices, events: await w.ports.ledger.events({ mission: M, line: 'task:docs' }) }));
  await drive(w.engine, w.ports.scheduler, w.script);
  assert.equal(await current(w.ports, 'docs'), 'prod.con.m1.docs.2');
  assert.equal((await w.ports.ledger.events({ mission: M, line: 'task:docs', event: 'rework' })).length, 1);
  assert.equal((await pmClose(w.ports.ctx, M, { mode: 'full', request: 'recovered' })).mode, 'full');
});

test('T1b: an unreadable accepted start is recorded by a full close after a pass (4.1.2: never refused); restored objects clear it', async () => {
  const w = provenancePorts();
  const exposeLegacy = oldDispatches(w.ports);
  const engine = await seed(w.ports);
  const plan = detailedPlan(M);
  for (const t of plan.tasks) t.verificationCommands = [];
  await drive(engine, w.ports.scheduler, happyScript(M, () => plan));
  exposeLegacy();
  const holds = w.ports.scheduler.actions.startHolds!;
  w.ports.scheduler.actions.startHolds = async () => { throw new Error('missing local commit'); };
  await engine.reconcile(M);
  assert.ok(w.ports.ledger.notices.some((n) => n.category === 'legacy-prerequisites-unavailable'));
  const full = await pmClose(w.ports.ctx, M, { mode: 'full', request: 'unreadable' });
  assert.ok(full.doc.startRisks.some((r) => /start cannot be read.*legacy-prerequisites-unavailable/.test(r)), JSON.stringify(full.doc.startRisks));
  pmMission(w.ports.ctx, M, 'open');
  const risk = await pmClose(w.ports.ctx, M, { mode: 'with-risk' });
  assert.ok(risk.risks.some((r) => /start cannot be read/.test(r)));
  pmMission(w.ports.ctx, M, 'open');
  w.ports.scheduler.actions.startHolds = holds;
  const restored = await pmClose(w.ports.ctx, M, { mode: 'full', request: 'restored' });
  assert.deepEqual([restored.mode, restored.doc.startRisks], ['full', []]);
  assert.ok(!w.ports.scheduler.tasks.has('con.m1.impl.2'), 'read failures never become a rebuild');
});

test('T1c: pinned starts use the public production resolvers and preserve the full snapshot', async () => {
  const w = memoryPorts();
  const engine = await seed(w);
  await drive(engine, w.scheduler, happyScript(M));
  w.scheduler.actions.startHolds = async () => { throw new Error('a pin needs no legacy check'); };
  for (const task of ['iface', 'impl']) {
    const events = await w.ledger.events({ mission: M, line: `task:${task}` });
    assert.deepEqual(execution.lineAcceptance(events), { abandoned: false, k: 1, product: `prod.con.m1.${task}.1`, pinned: true });
    assert.deepEqual(await execution.acceptedStartOf(flowCtx(w, M), task), { product: `prod.con.m1.${task}.1`, verdict: 'pinned', missing: [], rejected: [] });
  }
  const closed = await pmClose(w.ctx, M, { mode: 'full' });
  const doc = snapshot(w, closed.snapshot);
  assert.deepEqual(doc, {
    format: 'mp41.close-snapshot.v1', mission: M, mode: 'full', waitRunning: false,
    proof: [
      { object: 'prod.con.m1.iface.1', kind: 'product', of: 'task iface', label: 'proven' },
      { object: 'prod.con.m1.impl.1', kind: 'product', of: 'task impl', label: 'proven' },
      { object: 'dplan.m1.1.1', kind: 'plan', of: 'the effective detailed plan', label: 'proven' },
    ],
    words: null,
    delivered: null,
    unfinished: { planTasks: [], explorations: [], queued: [], running: [], escalations: [] },
    issues: [],
    startRisks: [],
    olderEnvironment: [],
    repairs: [],
    fullRun: null,
    labelsRecomputing: false,
    risks: [],
  });
});

test('close race: a product accepted during its pre-check is excluded until retry', async () => {
  const w = provenancePorts();
  const exposeLegacy = oldDispatches(w.ports);
  const engine = await seed(w.ports);
  await drive(engine, w.ports.scheduler, happyScript(M));
  exposeLegacy();
  const holds = w.ports.scheduler.actions.startHolds!;
  let changed = false;
  w.ports.scheduler.actions.startHolds = async (id) => {
    const result = await holds(id);
    if (!changed) {
      changed = true;
      const original = (await w.ports.ledger.objectVersion('prod.con.m1.iface.1'))!;
      const judgment = (await w.ports.ledger.judgment('j.rev.m1.iface.1'))!;
      await w.ports.scheduler.rebind({ mission: M, of: original.object, object: 'changed-product', prerequisites: [], reviews: original.reviews });
      await w.ports.ledger.append('test:close-race', { records: [{ ...judgment, judgment: 'j.changed' as never, target: 'changed-product' as ObjectVersionId }], events: [event('iface', 'rebound', '1:b1', { k: 1, n: 1, product: 'changed-product', judgment: 'j.changed', how: 'review' })] });
    }
    return result;
  };
  const raced = await pmClose(w.ports.ctx, M, { mode: 'full', request: 'race' });
  assert.ok(raced.doc.startRisks.some((r) => /changed-product.*changed while closing; retry/.test(r)), JSON.stringify(raced.doc.startRisks));
  pmMission(w.ports.ctx, M, 'open');
  w.ports.scheduler.actions.startHolds = holds;
  const retried = await pmClose(w.ports.ctx, M, { mode: 'full', request: 'race-retry' });
  assert.deepEqual([retried.mode, retried.doc.startRisks], ['full', []]);
});

async function legacySecretary(revised: boolean, claim = false) {
  const w = memoryPorts();
  say(w, SEED_TEXT);
  await seedMission(w, M);
  const ctx = flowCtx(w, M);
  const id = 'upgrade-auth';
  await raiseEscalation(ctx, { id, source: 'constructor-decision', lineage: 'task.m1.impl', subject: 'task:impl', summary: 'May this task be abandoned?', reasons: ['Decide'], options: ['abandon', 'ask-user'] });
  const task = `sec.${id}`;
  const card = w.scheduler.card<Parameters<typeof secretary>[0]>(task);
  if (claim) {
    // v4.1.0 pm.ts:376 pinned a spec containing the old card: no contextItems.
    const { contextItems: _inputs, ...oldCard } = card;
    const queued = w.scheduler.tasks.get(task)!.spec;
    w.memory.write({}, (tx) => {
      const spec = tx.data.put(JSON.stringify({ ...queued, card: oldCard }));
      // Exact old claim shape: 4.1.0 pmDispatch claimed the queued document without refresh.
      for (const m of oldCard.materials) tx.leaves.writeDocument(materialLeaf(M, m.ref), tx.data.text(m.ref));
      const d = claimDispatch(tx, { dispatch: 'D-legacy', task, seat: 'secretary', capabilities: queued.capabilities, worktree: false });
      appendRecords(tx, [{ kind: 'flow.event', mission: M, line: `dispatch:${d.dispatch}`, event: 'claimed', key: 'spec', body: tx.data.put(JSON.stringify({ spec, task, lineage: queued.lineage, dispatches: 0 })) }]);
    });
  }
  if (revised) {
    const words = say(w, 'Formatting only; abandoning tasks now requires my answer.');
    await recordItem(w, { mission: M, item: 'a1', type: 'authorization', text: 'Formatting only', source: { kind: 'words', words, quote: 'Formatting only' } });
  }
  if (claim) {
    assert.deepEqual(await w.scheduler.run(task, { handBack: secretary(card, 'abandon', { classification: 'important-within-authority', authorization: 'item.m1.a1' }) }), []);
    await secretaryStep(ctx);
    const d = await w.ledger.events<DecisionBody>({ mission: M, line: 'secretary', event: 'decision' });
    assert.equal(d[0]!.body.inputs, undefined);
  } else {
    const decision: DecisionBody = { escalation: id, by: 'secretary', option: 'abandon', classification: 'important-within-authority', authorization: 'item.m1.a1', reason: 'Old permission', instructions: '', grantExtra: 0, notice: 'Abandon', mayMatter: false };
    await w.ledger.append('test:old-decision', { events: [{ mission: M, line: 'secretary', event: 'decision', key: id, body: decision }] });
  }
  return { w, ctx, id };
}
async function retriedSecretary(s: Awaited<ReturnType<typeof legacySecretary>>, unversionedRetry = false) {
  const { w, ctx, id } = s;
  assert.equal(await decisionFor(ctx, id), null);
  assert.equal(await isApplied(ctx, id), false);
  const retry = w.scheduler.queued('secretary').find((t) => t.task === `sec.${id}.retry1`);
  assert.ok(retry);
  assert.ok((retry.card as Parameters<typeof secretary>[0]).contextItems?.length);
  const rejections = await w.ledger.events<{ why: string }>({ mission: M, line: 'secretary', event: 'decision-rejected' });
  assert.equal(rejections.length, 1);
  assert.match(rejections[0]!.body.why, /before 4.1.1, which kept no versions of what it relied on/);
  for (let n = 0; n < 3; n++) { await secretaryStep(ctx); assert.equal(await decisionFor(ctx, id), null); }
  assert.deepEqual(await w.scheduler.run(retry.task, { handBack: secretary(retry.card as Parameters<typeof secretary>[0], 'abandon') }), []);
  if (unversionedRetry) {
    const append = w.ledger.append.bind(w.ledger);
    w.ledger.append = (op, entries) => append(op, { ...entries, events: entries.events?.map((e) => {
      if (e.event !== 'decision' || e.key !== `${id}#1`) return e;
      const { inputs: _inputs, ...body } = e.body as DecisionBody;
      return { ...e, body };
    }) });
  }
  await secretaryStep(ctx);
  assert.equal((await decisionFor(ctx, id))?.option, 'abandon');
  const carried = await carryOut(ctx, id, { option: 'abandon' });
  await commitCarrying(ctx, 'test:apply-fresh', [], [carried]);
  assert.equal(await isApplied(ctx, id), true);
  assert.equal((await w.ledger.events({ mission: M, line: 'secretary', event: 'secretary-retry' })).length, 1, 'one legacy retry at most');
}
test('T2a: a legacy decision after an authority revision is retried and the new decision is carried out', async () => retriedSecretary(await legacySecretary(true)));
test('T2b: even unchanged legacy authority costs exactly one fresh round; a user answer still overrides', async () => {
  await retriedSecretary(await legacySecretary(false), true);
  const { w, ctx, id } = await legacySecretary(false);
  await answerEscalation(w, { mission: M, escalation: id, option: 'abandon', words: 'W-1' });
  assert.equal((await decisionFor(ctx, id))?.by, 'user');
  assert.equal((await w.ledger.events({ mission: M, event: 'secretary-retry' })).length, 0);
});
test('T2c: a 4.1.0-shaped claim handed back by 4.1.1 rejects the unversioned decision', async () => retriedSecretary(await legacySecretary(true, true)));

/** Mirror field a5af887 execution.ts:773–807: same content, new contract, program pass. */
async function fieldCarry(w: MemoryWorld, task: string, prerequisites: readonly string[]) {
  const from = `prod.con.m1.${task}.1`;
  const product = `${from}.b1`;
  const dplan = 'dplan.m1.2.1';
  const old = (await w.ledger.judgment(`j.rev.m1.${task}.1`))!;
  const obj = (await w.ledger.objectVersion(from))!;
  await w.scheduler.rebind({ mission: M, of: from, object: product, prerequisites, reviews: obj.reviews.map((r) => ({ ...r, reliesOn: [dplan] as ObjectVersionId[] })) });
  const judgment: JudgmentRecord = { ...old, judgment: `j.${product}` as never, target: product as ObjectVersionId, executor: 'program', reliesOn: w.memory.data.putList([dplan]), revokes: null, extends: null, superseded: [] };
  const body = { k: 1, n: 1, from, product, dplan, prerequisites, how: 'carried', carries: old.judgment, why: [] };
  await w.ledger.append(`test:field:${task}`, { records: [judgment], events: [event(task, 'rebind', '1:b1', body), event(task, 'rebound', '1:b1', { k: 1, n: 1, product, judgment: judgment.judgment, how: 'carried' })] });
  return { from, product, judgment };
}
async function fieldStack(mode: 'stable' | 'fast' = 'stable') {
  const w = memoryPorts();
  const engine = await seed(w, mode);
  await drive(engine, w.scheduler, happyScript(M));
  const words = say(w, 'A trailing comma is an error.');
  await recordItem(w, { mission: M, item: 'd1', type: 'decision', text: 'A trailing comma is an error', source: { kind: 'words', words, quote: 'A trailing comma is an error' } });
  await submitPmBatch(w, { mission: M, plan: pmPlan(M, { elements: [{ ...pmPlan(M).elements[0]!, text: 'A CSV parser; a trailing comma is an error', items: ['g1', 'd1'] }, pmPlan(M).elements[1]!] }), userWords: [words], mode });
  // Hold execution while 4.1.1 planning builds the next effective plan. The old stack
  // performed the following carry in its execution pass instead of queuing a seat.
  const labels = w.evaluator.labels.bind(w.evaluator);
  w.evaluator.labels = async (ids) => {
    const result = await labels(ids);
    return { ...result, labels: Object.fromEntries(Object.entries(result.labels).map(([id, label]) => [id, id.startsWith('prod.') ? 'recomputing' : label])) } as typeof result;
  };
  await drive(engine, w.scheduler, happyScript(M));
  w.evaluator.labels = labels;
  const a = await fieldCarry(w, 'iface', []);
  const b = await fieldCarry(w, 'impl', [a.product]);
  return { w, engine, a, b };
}
async function noStranded(w: MemoryWorld) {
  const products = ['iface', 'impl'];
  for (const task of products) {
    const p = await current(w, task);
    const label = p === null ? null : (await w.evaluator.labels([p])).labels[p];
    if (label === 'proven') continue;
    const steps = w.scheduler.queued().filter((t) => t.task.startsWith(`rev.m1.${task}.`));
    const pendingDependency = task === 'impl' && w.scheduler.queued().some((t) => t.task.startsWith('rev.m1.iface.'));
    assert.ok(steps.length > 0 || pendingDependency || w.ledger.notices.some((n) => n.category === 'kept-product-not-rebound'), `${task}: unproven with no step or notice`);
  }
}

test('T3a: stable ignores carried acceptance, counts b1, queues Reviewer b2 and never writes a program judgment', async () => {
  const { w, engine, a } = await fieldStack();
  const sinceUpgrade = w.memory.head();
  assert.equal(await current(w, 'iface'), a.from);
  await engine.reconcile(M);
  await noStranded(w);
  const rebinds = await w.ledger.events<{ how: string }>({ mission: M, line: 'task:iface', event: 'rebind' });
  assert.deepEqual(rebinds.map((e) => [e.key, e.body.how]), [['1:b1', 'carried'], ['1:b2', 'review']]);
  const review = w.scheduler.queued('reviewer').find((t) => t.task === 'rev.m1.iface.1.b2');
  assert.ok(review);
  assert.equal(await current(w, 'iface'), a.from);
  assert.deepEqual(await w.scheduler.run(review.task, { handBack: reviewer(review.card as Parameters<typeof reviewer>[0], 'pass') }), []);
  await engine.reconcile(M);
  assert.equal(await current(w, 'iface'), `${a.from}.b2`);
  await noStranded(w);
  await drive(engine, w.scheduler, happyScript(M));
  // Every 4.1.1 source path, and the records produced after the historical setup.
  const root = new URL('../src/', import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  for (const file of files) assert.doesNotMatch(readFileSync(new URL(file, root), 'utf8'), /executor\s*:\s*['"]program['"]/, file);
  const written = (await w.ledger.records(['judgment'])).filter((r) => r.revision > sinceUpgrade);
  assert.ok(written.length > 0);
  assert.ok(written.every((r) => r.record.executor !== 'program'));
});

test('T3b: fast mode notifies about carried re-binds and starts no seat', async () => {
  const { w, engine, a } = await fieldStack('fast');
  await engine.reconcile(M);
  assert.equal(await current(w, 'iface'), a.from);
  assert.ok(w.ledger.notices.some((n) => n.category === 'kept-product-not-rebound' && n.key.endsWith(':fast')));
  assert.deepEqual(w.scheduler.queued(), []);
});

test('T3c: program judgments decide nothing; open leaves the upgrade to batches; renew skips them and dependents follow b2', async () => {
  const { w, engine, a, b } = await fieldStack();
  const dependent = `${b.from}.b2`;
  const old = (await w.ledger.objectVersion(b.from))!;
  await w.scheduler.rebind({ mission: M, of: b.from, object: dependent, prerequisites: [a.product], reviews: old.reviews.map((r) => ({ ...r, reliesOn: ['dplan.m1.2.1'] as ObjectVersionId[] })) });
  await w.ledger.append('test:seat-dependent-on-carried', {
    records: [{ ...b.judgment, judgment: 'j.stack.dependent' as never, target: dependent as ObjectVersionId, executor: 'reviewer' }],
    events: [
      event('impl', 'rebind', '1:b2', { k: 1, n: 2, from: b.from, product: dependent, dplan: 'dplan.m1.2.1', prerequisites: [a.product], how: 'review', carries: null, why: [] }),
      event('impl', 'rebound', '1:b2', { k: 1, n: 2, product: dependent, judgment: 'j.stack.dependent', how: 'review' }),
    ],
  });
  const labels = w.memory.read((db) => decisionLabels(db, [a.product, b.product, dependent]));
  assert.notEqual(labels[a.product], 'proven');
  assert.notEqual(labels[b.product], 'proven');
  assert.equal(labels[dependent], 'not-fully-proven');
  // Reference evaluator agrees with the stored one, including an object built on b1.
  const resolved = w.memory.read((db) => recordsByKind(db, { kinds: ['basis.version', 'basis.withdrawn', 'object.version', 'judgment', 'evidence', 'env.snapshot'], limit: 10_000 }).map((c) => ({ revision: c.revision, record: resolveLists(db, c.record) as ResolvedRecord })));
  const reference = fullCompute(resolved, revision(Number(w.memory.head())));
  assert.notEqual(reference.targets.get(a.product)?.label, 'proven');
  assert.notEqual(reference.targets.get(b.product)?.label, 'proven');
  assert.equal(reference.targets.get(dependent)?.label, 'not-fully-proven');
  // Simulate the old on-disk projection, with the historical judgment still in the log.
  w.memory.maintenance((tx) => {
    tx.stmt("DELETE FROM lbl_meta WHERE key LIKE 'program-judgments%'").run();
    const row = tx.stmt("SELECT rev FROM facts WHERE kind = 'judgment' AND id = ?").get(a.judgment.judgment) as { rev: number };
    tx.stmt('INSERT OR REPLACE INTO lbl_judgments (judgment, target, review, rev, state, decided_by) VALUES (?, ?, ?, ?, ?, ?)').run(a.judgment.judgment, a.product, 'reviewer', row.rev, 'pass', a.judgment.judgment);
    tx.stmt("UPDATE lbl_labels SET label = 'proven' WHERE target = ?").run(a.product);
  });
  // A second connection opens without upgrading the stored index.
  const reopened = openMemory(w.dir, { git: null });
  assert.ok(reopened.stmt('SELECT 1 FROM lbl_judgments WHERE judgment = ?').get(a.judgment.judgment), 'open leaves the old row');
  assert.equal(reopened.read((db) => labelStatus(db)).recomputing, true);
  assert.equal(reopened.read((db) => decisionLabels(db, [a.product]))[a.product], 'recomputing');
  drain(reopened);
  assert.equal(reopened.stmt('SELECT 1 FROM lbl_judgments WHERE judgment = ?').get(a.judgment.judgment), undefined);
  assert.equal(labelBatch(reopened), null);
  assert.notEqual(reopened.read((db) => decisionLabels(db, [a.product]))[a.product], 'proven');
  reopened.maintenance((tx) => { tx.stmt("INSERT INTO lbl_meta (key, value) VALUES ('test-second-open', 'kept')").run(); });
  reopened.close();
  const again = openMemory(w.dir, { git: null });
  assert.equal((again.stmt("SELECT value FROM lbl_meta WHERE key = 'test-second-open'").get() as { value: string }).value, 'kept', 'second open does not recompute again');
  again.close();
  assert.ok(await w.ledger.judgment(a.judgment.judgment), 'history stays in the log');
  w.ctx.environment();
  forgetObservedEnvironment(w.dir);
  currentEnvironment(w.memory, { observe: () => ({ os: 'changed', osVersion: '2', arch: 'x64', versions: {} }) });
  const renew = w.memory.read((db) => renewalCandidates(db));
  assert.ok(renew.affected > 0, 'the new identity offers real seat judgments for renewal');
  assert.ok(![...renew.candidates.flatMap((c) => c.judgments), ...renew.reviews].some((j) => j.judgment === a.judgment.judgment || j.judgment === b.judgment.judgment));
  // Restore the observed identity for the next production pass.
  forgetObservedEnvironment(w.dir);
  currentEnvironment(w.memory, { observe: () => ({ os: 'flowtest', osVersion: '1', arch: 'x64', versions: {} }) });
  recompute(w.memory);
  await engine.reconcile(M);
  assert.ok(!w.scheduler.queued().some((t) => t.task === 'rev.m1.impl.1.b3'), 'dependent waits for iface b2');
  await drive(engine, w.scheduler, happyScript(M));
  assert.equal(await current(w, 'iface'), `${a.from}.b2`);
  assert.equal(await current(w, 'impl'), `${b.from}.b3`);
  const impl = (await w.ledger.objectVersion(`${b.from}.b3`))!;
  assert.deepEqual(w.memory.data.getList(impl.prerequisites), [`${a.from}.b2`]);
  await noStranded(w);
});

test('T3d: layers and close select the seat acceptance, never carried b1', async () => {
  const { w, a, b } = await fieldStack();
  const layers = await resolveSubtasks(w.ctx);
  const label = layers.entries.find((e) => e.kind === 'task' && e.id === 'iface')!.label;
  assert.match(label, /product not-fully-proven/);
  const closed = await pmClose(w.ctx, M, { mode: 'with-risk' });
  const doc = snapshot(w, closed.snapshot);
  assert.ok(doc.proof.some((p) => p.object === a.from));
  assert.ok(doc.proof.every((p) => p.object !== a.product && p.object !== b.product));
});
