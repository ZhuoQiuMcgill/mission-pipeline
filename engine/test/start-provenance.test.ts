import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MissionId, ObjectVersionId } from '../src/common/ids.ts';
import { checkCandidateProofs, startHolds, type Candidate } from '../src/delivery/candidate.ts';
import { buildManifest } from '../src/delivery/manifest.ts';
import { writeScopeDocument, writeScopeIdentity } from '../src/delivery/writeScope.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { flowCtx, shortHash } from '../src/flow/context.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import { DetailedTask } from '../src/flow/plandoc.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { constructorDone, detailedPlan, drive, happyScript, pmPlan, reviewer, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import { FakeProofView, fakeObject, obj, ov, pu } from './delivery-fixtures.test.ts';
import { say } from './flow-memory-fixtures.ts';
import { ObjectGit, oid, provenancePorts, repo, tree } from './start-provenance-fixtures.ts';

const M = 'm1' as MissionId;
const event = (task: string, name: string, key: string, body: unknown) => ({ mission: M, line: `task:${task}`, event: name, key, body });
function legacy(w: ReturnType<typeof provenancePorts>, tasks = ['impl'], attempts = [1]) {
  const read = w.ports.ledger.events.bind(w.ports.ledger);
  w.ports.ledger.events = (async (q) => (await read(q)).map((e) => {
    if (e.event !== 'dispatched' || !tasks.some((t) => attempts.some((k) => e.key === `con.m1.${t}.${k}`))) return e;
    const { prerequisites: _pin, ...body } = e.body as { prerequisites?: string[] };
    return { ...e, body } as typeof e;
  })) as typeof w.ports.ledger.events;
}
async function setup(extraTask = false, cascade = false) {
  const w = provenancePorts();
  say(w.ports, SEED_TEXT);
  await seedMission(w.ports, M);
  await submitPmBatch(w.ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  const engine = new FlowEngine(w.ports);
  const plan = detailedPlan(M, { extraTask });
  if (cascade) plan.tasks.push({ ...plan.tasks.find((t) => t.id === 'docs')!, id: 'docs2', kind: 'experiment', writeScope: ['more.md'], dependsOn: ['docs'] });
  const script = happyScript(M, () => plan);
  await drive(engine, w.ports.scheduler, (t, s) => t.task === 'con.m1.impl.1' ? null : script(t, s));
  return { ...w, engine, script, plan };
}
async function newer(w: Awaited<ReturnType<typeof setup>>, changed: boolean) {
  const { ports, objects } = w;
  const from = (await ports.ledger.objectVersion('prod.con.m1.iface.1'))!;
  const id = `${from.object}.new` as ObjectVersionId;
  if (!changed) await ports.scheduler.rebind({ mission: M, of: from.object, object: id, prerequisites: [], reviews: from.reviews });
  else {
    const entries = w.entries(from.source!.commit).map((e) => from.scope.paths.includes(e.path) ? { ...e, oid: oid(800) } : e);
    await ports.ledger.append('test:newer-content', { records: [{ ...from, object: id,
      content: ports.memory.data.put(writeScopeDocument(entries, from.source!.writeScope)),
      source: { ...from.source!, commit: objects.put(entries) },
    }] });
  }
  const judgment = (await ports.ledger.judgment('j.rev.m1.iface.1'))!;
  const evidenceIds = ports.memory.data.getList(judgment.evidence);
  const evidence = (await ports.ledger.records(['evidence'])).map((c) => c.record).filter((e) => evidenceIds.includes(e.evidence));
  const commit = (await ports.ledger.objectVersion(id))!.source!.commit;
  await ports.ledger.append('test:newer-reviewed', { records: [
    ...evidence.map((e) => ({ ...e, evidence: `${e.evidence}.new` as never, fields: { ...e.fields, candidate: commit } })),
    { ...JSON.parse(evidenceIds.reduce((s, id) => s.replaceAll(JSON.stringify(id), JSON.stringify(`${id}.new`)), JSON.stringify(judgment))), judgment: 'j.newer', target: id, evidence: ports.memory.data.putList(evidenceIds.map((id) => `${id}.new`)) },
  ], events: [event('iface', 'rebound', '1:b1', { k: 1, n: 1, product: id, judgment: 'j.newer', how: 'review' })] });
  return id;
}

for (const throughC of [false, true]) test(`reviewer #1: a wrong accepted prerequisite fails delivery ${throughC ? 'through C with propagation' : 'when B is selected directly'}`, async () => {
  const w = await setup(throughC);
  const a2 = await newer(w, true);
  w.recorded.set('con.m1.impl.1', [a2]);
  await drive(w.engine, w.ports.scheduler, w.script);
  legacy(w);
  assert.equal(await acceptedProduct(flowCtx(w.ports, M), 'impl'), null);
  const selected = throughC ? 'prod.con.m1.docs.1' : 'prod.con.m1.impl.1';
  const built = buildManifest(w.view(), [obj(selected)]);
  assert.equal(built.kind, 'manifest');
  if (built.kind !== 'manifest') return;
  assert.ok(built.manifest.entries.every((e) => e.label === 'proven'), 'the historical labels alone would have proven the wrong record');
  const snap = await w.ports.scheduler.snapshot({ mission: M, purpose: 'delivery', products: [selected] });
  const proof = await checkCandidateProofs({ git: w.objects.git, repo, view: w.view(), manifest: built.manifest, candidate: { commit: snap.commit, snapshotDir: '/unused' } as Candidate });
  assert.deepEqual(proof.proven, [a2]);
  const bad = proof.notFullyProven.find((e) => e.id === 'prod.con.m1.impl.1')!;
  assert.deepEqual(bad.reasons.find((r) => r.kind === 'start-lacks-prerequisite'), { kind: 'start-lacks-prerequisite', missing: [{ prerequisite: a2, path: 'src/parser/api.ts' }] });
  if (throughC) assert.ok(proof.notFullyProven.find((e) => e.id === selected)!.reasons.some((r) => r.kind === 'prerequisite-not-proven' && r.prerequisite === 'prod.con.m1.impl.1'));
  await w.engine.reconcile(M);
  assert.ok(w.ports.scheduler.queued().some((t) => t.task === 'con.m1.impl.2'));
  assert.equal(await acceptedProduct(flowCtx(w.ports, M), 'impl'), null);
  const notice = w.ports.ledger.notices.find((n) => n.category === 'legacy-prerequisites-restarted')!;
  assert.match(notice.trigger, /src\/parser\/api.ts/);
  assert.deepEqual((notice.detail as { missing: unknown }).missing, [{ prerequisite: a2, path: 'src/parser/api.ts' }]);
  assert.equal(w.checks.get('prod.con.m1.impl.1'), 1, 'gates and restart use the same memoized object check');
  await drive(w.engine, w.ports.scheduler, w.script);
  assert.equal(await acceptedProduct(flowCtx(w.ports, M), 'impl'), 'prod.con.m1.impl.2', 'the carried restart reaches acceptance');
});

for (const cancelledOrigin of [false, true]) test(`reviewer #2: a cancelled ${cancelledOrigin ? 'intermediate attempt with an origin' : 'first attempt'} cannot replace the accepted product's start`, async () => {
  const w = await setup();
  await w.ports.scheduler.cancel('con.m1.impl.1');
  if (cancelledOrigin) await w.ports.ledger.append('test:cancelled-origin', { events: [event('impl', 'dispatched', 'con.m1.impl.2', { k: 2, commit: oid(100), origin: oid(101), dplan: 'unrelated' }), event('impl', 'rework', '2', { k: 2, reason: 'replan', issues: [], instructions: [] })] });
  const k = cancelledOrigin ? 3 : 2;
  await w.ports.ledger.append('test:fresh-attempt', { events: [event('impl', 'rework', String(k), { k, reason: 'replan', issues: [], instructions: [] })] });
  await newer(w, true);
  await drive(w.engine, w.ports.scheduler, w.script);
  const product = `prod.con.m1.impl.${k}`;
  assert.equal((await w.ports.ledger.objectVersion(product))!.predecessor, undefined);
  legacy(w, ['impl'], [1, 2, 3]);
  const before = await w.ports.ledger.events({ mission: M, line: 'task:impl' });
  await w.engine.reconcile(M);
  assert.equal(await acceptedProduct(flowCtx(w.ports, M), 'impl'), product);
  assert.deepEqual(await w.ports.ledger.events({ mission: M, line: 'task:impl' }), before);
  assert.equal(w.ports.ledger.notices.some((n) => n.category === 'legacy-prerequisites-restarted'), false);
});

test('Stabilizer re-bind: same content under a new id while B runs leaves accepted legacy work untouched', async () => {
  const w = await setup();
  const a2 = await newer(w, false);
  w.recorded.set('con.m1.impl.1', [a2]);
  await drive(w.engine, w.ports.scheduler, w.script);
  legacy(w);
  const before = await w.ports.ledger.events({ mission: M, line: 'task:impl' });
  for (let i = 0; i < 3; i++) {
    assert.equal(await acceptedProduct(flowCtx(w.ports, M), 'impl'), 'prod.con.m1.impl.1');
    await w.engine.reconcile(M);
  }
  assert.deepEqual(await w.ports.ledger.events({ mission: M, line: 'task:impl' }), before);
  assert.equal(w.checks.get('prod.con.m1.impl.1'), 1);
  assert.equal(w.ports.ledger.notices.some((n) => n.category === 'legacy-prerequisites-restarted'), false);
});

test('acceptance checks the latest re-bound product rather than the attempt original', async () => {
  const w = await setup();
  await drive(w.engine, w.ports.scheduler, w.script);
  const a2 = await newer(w, true);
  const original = 'prod.con.m1.impl.1';
  const rebound = `${original}.b1`;
  const rec = (await w.ports.ledger.objectVersion(original))!;
  await w.ports.scheduler.rebind({ mission: M, of: original, object: rebound, prerequisites: [a2], reviews: rec.reviews });
  await w.ports.ledger.append('test:rebound-acceptance', { events: [event('impl', 'rebound', '1:b1', { k: 1, n: 1, product: rebound, judgment: 'j.rev.m1.impl.1', how: 'review' })] });
  legacy(w);
  assert.equal(await acceptedProduct(flowCtx(w.ports, M), 'impl'), null);
  await w.engine.reconcile(M);
  assert.equal(w.checks.get(rebound), 1);
  assert.equal(w.checks.has(original), false);
  assert.equal((w.ports.ledger.notices.find((n) => n.category === 'legacy-prerequisites-restarted')!.detail as { product: string }).product, rebound);
});

test('a dependency-free accepted legacy product remains untouched on real tree responses', async () => {
  const w = await setup();
  await drive(w.engine, w.ports.scheduler, w.script);
  legacy(w, ['iface']);
  const before = await w.ports.ledger.events({ mission: M, line: 'task:iface' });
  await w.engine.reconcile(M);
  assert.equal(await acceptedProduct(flowCtx(w.ports, M), 'iface'), 'prod.con.m1.iface.1');
  assert.deepEqual(await w.ports.ledger.events({ mission: M, line: 'task:iface' }), before);
  assert.equal(w.ports.ledger.notices.some((n) => n.category === 'legacy-prerequisites-restarted'), false);
});

test('v4.1.0 cross-spec continuation inherits the earlier origin and restarts', async () => {
  const w = await setup();
  await w.ports.scheduler.run('con.m1.impl.1', { handBack: constructorDone() });
  await w.engine.reconcile(M);
  const previous = (await w.ports.ledger.objectVersion('prod.con.m1.impl.1'))!;
  await newer(w, true);
  await w.ports.scheduler.cancel('rev.m1.impl.1');
  const spec = (await w.ports.ledger.events<{ dplan: string }>({ mission: M, line: 'task:impl', event: 'spec' }))[0]!;
  await w.ports.ledger.append('test:old-respec', { events: [event('impl', 'spec', 'old-spec-2', { dplan: spec.body.dplan, hash: shortHash(DetailedTask.parse(w.plan.tasks.find((t) => t.id === 'impl')!)) }), event('impl', 'rework', '2', { k: 2, reason: 'respec', issues: [], instructions: [] })] });
  const snapshot = w.ports.scheduler.actions.snapshot!;
  w.ports.scheduler.actions.snapshot = async (req) => req.purpose === 'constructor-impl' ? { path: previous.source!.commit, commit: previous.source!.commit, products: await w.ports.scheduler.composition(['prod.con.m1.iface.1.new']) } : snapshot(req);
  // v4.1.0 continued across the new spec and kept the predecessor despite the card change.
  const product = w.ports.scheduler.actions.product!;
  w.ports.scheduler.actions.product = (req) => product(req.task === 'con.m1.impl.2' ? { ...req, predecessor: previous.object } : req);
  await drive(w.engine, w.ports.scheduler, w.script);
  legacy(w, ['impl'], [1, 2]);
  assert.equal(await acceptedProduct(flowCtx(w.ports, M), 'impl'), null);
  await w.engine.reconcile(M);
  assert.ok(w.ports.scheduler.queued().some((t) => t.task === 'con.m1.impl.3'));
});

test('B9: a start missing a transitive prerequisite restarts and accepted dependents cascade', async () => {
  const w = await setup(true, true);
  await drive(w.engine, w.ports.scheduler, (t, s) => t.task === 'con.m1.docs.1' ? null : w.script(t, s));
  // An old snapshot laid only impl, omitting iface. Its recorded closure still names iface.
  const dispatch = (await w.ports.ledger.events<{ commit: string }>({ mission: M, line: 'task:docs', event: 'dispatched' }))[0]!;
  w.objects.trees.set(dispatch.body.commit, w.entries(dispatch.body.commit).filter((e) => e.path !== 'src/parser/api.ts'));
  await drive(w.engine, w.ports.scheduler, (t, s) => t.task === 'con.m1.docs2.1' ? null : w.script(t, s));
  const later = (await w.ports.ledger.events<{ commit: string }>({ mission: M, line: 'task:docs2', event: 'dispatched' }))[0]!;
  w.objects.trees.set(later.body.commit, w.entries(later.body.commit).filter((e) => e.path !== 'src/parser/api.ts'));
  await drive(w.engine, w.ports.scheduler, w.script);
  const docs = 'prod.con.m1.docs.1';
  legacy(w, ['docs', 'docs2']);
  assert.equal(await acceptedProduct(flowCtx(w.ports, M), 'docs'), null);
  await w.engine.reconcile(M);
  assert.ok(w.ports.scheduler.queued().some((t) => t.task === 'con.m1.docs.2'));
  assert.equal(await acceptedProduct(flowCtx(w.ports, M), 'docs2'), null);
  assert.ok((await w.ports.ledger.events({ mission: M, line: 'task:docs2', event: 'rework' })).some((e) => e.key === '2'));
  assert.equal(w.ports.ledger.notices.filter((n) => n.category === 'legacy-prerequisites-restarted').length, 2);
  await drive(w.engine, w.ports.scheduler, w.script);
  assert.equal(await acceptedProduct(flowCtx(w.ports, M), 'docs'), 'prod.con.m1.docs.2');
  assert.equal(await acceptedProduct(flowCtx(w.ports, M), 'docs2'), 'prod.con.m1.docs2.2');
});

test('unreadable git holds acceptance with a notice and retries without inventing a mismatch', async () => {
  const w = await setup();
  await drive(w.engine, w.ports.scheduler, w.script);
  legacy(w);
  const check = w.ports.scheduler.actions.startHolds!;
  w.ports.scheduler.actions.startHolds = async () => { throw new Error('missing local commit'); };
  assert.equal(await acceptedProduct(flowCtx(w.ports, M), 'impl'), null);
  await w.engine.reconcile(M);
  assert.ok(w.ports.ledger.notices.some((n) => n.category === 'legacy-prerequisites-unavailable'));
  assert.equal(w.ports.scheduler.tasks.has('con.m1.impl.2'), false);
  w.ports.scheduler.actions.startHolds = check;
  assert.equal(await acceptedProduct(flowCtx(w.ports, M), 'impl'), 'prod.con.m1.impl.1');
});

test('the content invariant holds for a pinned re-bind, carried start, same-tree continuation, landed skip and whole proof unit', async () => {
  const objects = new ObjectGit();
  const aCommit = objects.put(tree({ f: 1, other: 1 }));
  const bCommit = objects.put(tree({ f: 2, other: 1, b: 1 }), aCommit);
  const a = { ...fakeObject('a', { paths: ['f', 'other'] }), content: writeScopeIdentity(tree({ f: 1, other: 1 }), ['f', 'other']), tree: { ...fakeObject('a').tree!, commit: aCommit, writeScope: ['f', 'other'] } };
  const b = { ...fakeObject('b', { paths: ['f', 'b'], prerequisites: [obj('a')] }), content: writeScopeIdentity(tree({ f: 2, b: 1 }), ['f', 'b']), tree: { ...fakeObject('b').tree!, commit: bCommit, writeScope: ['f', 'b'] } };
  const view = new FakeProofView().add(a, b, { ...a, id: ov('a.b1'), predecessor: a.id }, { ...b, id: ov('b.b1'), predecessor: b.id, prerequisites: [obj('a.b1')] });
  view.add({ ...a, id: ov('a.same-tree'), tree: { ...a.tree, commit: objects.put(tree({ f: 1, other: 1 })) } });
  assert.deepEqual(await startHolds(objects.git, repo, view, { ...b, prerequisites: [obj('a.same-tree')] }), { holds: true, missing: [] }, 'identical content in a different commit also holds');
  const first = objects.put(tree({ f: 2, other: 1, b: 1, own: 1 }), bCommit);
  const version = { ...fakeObject('task', { paths: ['own'], prerequisites: [obj('b.b1')] }), tree: { ...fakeObject('task').tree!, commit: first, writeScope: ['own'] } };
  view.add(version);
  const carriedStart = objects.put(tree({ f: 2, other: 1, b: 1, ambient: 2 }));
  for (const next of [version, { ...version, id: ov('continued'), predecessor: version.id, tree: { ...version.tree, commit: objects.put(tree({ f: 2, other: 1, b: 1, own: 2 }), first) } }, { ...version, id: ov('carried'), predecessor: version.id, tree: { ...version.tree, commit: objects.put(tree({ f: 2, other: 1, b: 1, ambient: 2, own: 2 }), carriedStart), origin: carriedStart } }]) {
    assert.deepEqual(await startHolds(objects.git, repo, view, next), { holds: true, missing: [] });
  }
  // A landed stack may leave f=2 while the lower a remains laid as f=1; shared ownership applies.
  view.unit(pu('peers'), [ov('a.b1'), ov('peer')]).add({ ...fakeObject('peer', { paths: ['peer'] }), content: writeScopeIdentity([], ['peer']), tree: { ...a.tree, writeScope: ['peer'] } });
  assert.deepEqual(await startHolds(objects.git, repo, view, version), { holds: true, missing: [] });
});

test('reviewer r3 #1: a successor resting on a rejected legacy version is excluded and restarted; its dependents never pin that version', async () => {
  const w = provenancePorts();
  const { ports } = w;
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'stable' });
  const plan = detailedPlan(M, { extraTask: true });
  const docs = plan.tasks.find((t) => t.id === 'docs')!;
  docs.dependsOn = ['iface', 'impl'];
  plan.tasks.push({ ...docs, id: 'independent', kind: 'experiment', writeScope: ['independent.md'], dependsOn: [] });
  plan.tasks.push({ ...docs, id: 'later', writeScope: ['later.md'], dependsOn: ['docs', 'independent'] });
  const engine = new FlowEngine(ports);
  const script = happyScript(M, () => plan);
  const waiting = new Set(['con.m1.impl.1', 'con.m1.independent.1']);
  await drive(engine, ports.scheduler, (t, s) => waiting.has(t.task) ? null : script(t, s));
  const a2 = await newer({ ...w, engine, script, plan }, true);
  // B was built on A1 but its hand-back recorded A2; C (docs) was built on A2 + B, so C's own start holds.
  w.recorded.set('con.m1.impl.1', [a2]);
  waiting.delete('con.m1.impl.1');
  await drive(engine, ports.scheduler, (t, s) => waiting.has(t.task) ? null : script(t, s));
  legacy(w, ['impl', 'docs']);
  assert.equal(await acceptedProduct(flowCtx(ports, M), 'impl'), null);
  assert.equal((await ports.scheduler.startHolds('prod.con.m1.docs.1')).holds, true);
  assert.equal(await acceptedProduct(flowCtx(ports, M), 'docs'), null, 'C rests on the rejected B');
  await engine.reconcile(M);
  assert.ok((await ports.ledger.events<{ reason: string }>({ mission: M, line: 'task:docs', event: 'rework' })).some((e) => e.key === '2' && e.body.reason === 'program'));
  const notice = ports.ledger.notices.find((n) => n.category === 'legacy-prerequisites-restarted' && n.key === 'docs:1')!;
  assert.deepEqual((notice.detail as { rejected: unknown }).rejected, ['prod.con.m1.impl.1']);
  assert.equal(w.checks.get('prod.con.m1.impl.1'), 1, 'one memoized check per object');
  // independent finishes; later must still wait for docs.2, which waits for impl.2
  const ind = ports.scheduler.queued().find((t) => t.task === 'con.m1.independent.1')!;
  await ports.scheduler.run(ind.task, script(ind, ports.scheduler)!);
  await drive(engine, ports.scheduler, (t, s) => t.task === 'con.m1.impl.2' ? null : script(t, s));
  assert.equal(ports.scheduler.tasks.has('con.m1.later.1'), false);
  await drive(engine, ports.scheduler, script);
  assert.equal(await acceptedProduct(flowCtx(ports, M), 'impl'), 'prod.con.m1.impl.2');
  assert.equal(await acceptedProduct(flowCtx(ports, M), 'docs'), 'prod.con.m1.docs.2');
  assert.equal(await acceptedProduct(flowCtx(ports, M), 'later'), 'prod.con.m1.later.1');
  const pins = (task: string) => ports.ledger.events<{ prerequisites?: string[] }>({ mission: M, line: `task:${task}`, event: 'dispatched' });
  const docs2 = (await pins('docs')).find((e) => e.key === 'con.m1.docs.2')!.body.prerequisites!;
  assert.ok(docs2.includes('prod.con.m1.impl.2') && !docs2.includes('prod.con.m1.impl.1'));
  for (const e of await pins('later')) assert.ok(!e.body.prerequisites!.includes('prod.con.m1.impl.1'), 'later never rests on the rejected B');
  assert.deepEqual(ports.scheduler.queued(), [], 'never stopped with work pending');
});
