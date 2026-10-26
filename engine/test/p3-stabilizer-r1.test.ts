import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { decodeConstraintCheck, type ListRef, type ObjectVersionRecord } from '../src/common/records.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { basisIndex, flowCtx } from '../src/flow/context.ts';
import { planAnswersReplan, submitPmBatch } from '../src/flow/planning.ts';
import { currentConstraints, currentItems, recordConstraint, recordItem, withdrawItem } from '../src/flow/requirements.ts';
import { answerEscalation, raiseEscalation } from '../src/flow/secretary.ts';
import { advanceLegalization, requestLegalization, startLegalization } from '../src/flow/audit/flow.ts';
import { cal1Pass, drive, happyScript, pmPlan, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import { constraintApplies } from '../src/memory/domain/constraints.ts';
import { pmDispatch } from '../src/process/pm.ts';
import { refreshDispatchCard } from '../src/seat/cards/refresh.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { AuditNodeCard, AuditNodeResult, AuditChainCard } from '../src/seat/cards/auditor.ts';
import type { Calibrator1Card } from '../src/seat/cards/calibrator.ts';
import type { MaterialRef } from '../src/seat/cards/common.ts';
import { defineExploration, advanceExploration } from '../src/flow/exploration/flow.ts';
import { explorationDefinition } from '../src/flow/exploration/definition.ts';
import { seatCardEntry } from '../src/seat/cards/index.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import type { ReaderCard } from '../src/seat/cards/researcher.ts';
import { submit, attack, blind, stabilizeAll } from './flow-exploration-fixtures.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
async function setup(mode: 'stable' | 'fast' = 'stable') {
  const w = memoryPorts(); say(w, SEED_TEXT); await seedMission(w, M);
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode });
  return { w, engine: new FlowEngine(w) };
}
async function item(w: World, id: string, text: string, type: 'goal' | 'acceptance' | 'decision' | 'authorization' = 'goal') {
  return recordItem(w, { mission: M, item: id, type, text, source: { kind: 'words', words: 'W-1', quote: 'Build me a CSV parser' } });
}
const events = (w: World, event: string) => w.ledger.events({ mission: M, line: 'plan', event });
const notReady = (fn: () => unknown, reason: RegExp = /changed|withdrawn/) => assert.throws(fn, (e: unknown) => (e as { code?: string }).code === 'NOT_READY' && reason.test((e as Error).message));
function materialText(w: World, card: { materials: MaterialRef[] }) { return card.materials.map((m) => w.memory.data.text(m.ref)).join('\n'); }

for (const version of ['recheck', 'new-version'] as const) for (const change of ['withdraw', 'revise'] as const) it(`A: ${version}, s1 ${change} after queue refuses then rebuilds the complete continuation`, async () => {
  const { w, engine } = await setup();
  await item(w, 's1', 'S1 BEFORE UNIQUE', 'acceptance');
  // The initial queued review must also be built from current inputs.
  await drive(engine, w.scheduler, happyScript(M));
  await item(w, 'g1', 'Changed goal');
  const doc = pmPlan(M); if (version === 'new-version') doc.elements[0]!.text += ' clarified';
  await submitPmBatch(w, { mission: M, plan: doc, userWords: ['W-1'], changedItems: ['g1'] });
  await engine.reconcile(M);
  const queued = w.scheduler.queued('calibrator-1')[0]!;
  const original = structuredClone(queued.card);
  if (change === 'withdraw') await withdrawItem(w, { mission: M, item: 's1', reason: 'withdraw s1 while queued' });
  else await item(w, 's1', 'S1 AFTER UNIQUE', 'acceptance');
  notReady(() => pmDispatch(w.ctx, queued.task));
  assert.deepEqual(w.scheduler.card(queued.task), original, 'a refused claim never mutates queued inputs');
  await engine.reconcile(M);
  const rebuilt = w.scheduler.queued('calibrator-1')[0]!;
  assert.notEqual(rebuilt.task, queued.task);
  const d = pmDispatch(w.ctx, rebuilt.task);
  const card = dispatchView(w.ctx, d.dispatch).card as unknown as Calibrator1Card;
  const text = materialText(w, card);
  assert.match(text, /S1 BEFORE UNIQUE/);
  assert.match(text, change === 'withdraw' ? /\(withdrawn\)/ : /S1 AFTER UNIQUE/);
  assert.deepEqual(await w.scheduler.run(card.task, { handBack: cal1Pass(card) }), []);
  await engine.reconcile(M);
  assert.equal((await w.evaluator.labels([card.target])).labels[card.target], 'proven');
  await item(w, 'g1', 'Next goal');
  await submitPmBatch(w, { mission: M, plan: doc, userWords: ['W-1'], changedItems: ['g1'] });
  await engine.reconcile(M);
  const next = w.scheduler.queued('calibrator-1')[0]!.card as unknown as Calibrator1Card;
  assert.deepEqual(next.mode, { kind: 'continuation', extends: card.binding.judgment }, 'the next continuation starts at the actual dispatched judgment');
  const previousBases = w.memory.data.getList(card.binding.bases as ListRef);
  const ix = await basisIndex(flowCtx(w, M));
  const reqset = previousBases.find((v) => ix.lineOf.get(v) === 'reqset.m1')!;
  const snapshot = ix.records.get(reqset)!;
  assert.equal(snapshot.basisKind, 'requirement-set');
  if (snapshot.basisKind === 'requirement-set') {
    const seen = w.memory.data.getList(snapshot.snapshot);
    assert.equal(seen.some((v) => v.startsWith('item.m1.s1.')), change === 'revise');
  }
});

for (const when of ['queued', 'running', 'effective'] as const) it(`C: withdrawn fixed authorization while ${when} returns to the PM without a rerun or judgment by the program`, async () => {
  const { w, engine } = await setup();
  if (when === 'effective') await drive(engine, w.scheduler, happyScript(M));
  else await engine.reconcile(M);
  const queued = w.scheduler.queued('calibrator-1')[0];
  if (when === 'running') w.scheduler.dispatchOf(queued!.task);
  await withdrawItem(w, { mission: M, item: 'a1', reason: 'authorization withdrawn' });
  if (when === 'effective') await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['a1'] });
  if (when === 'queued') notReady(() => pmDispatch(w.ctx, queued!.task), /plan pmplan.m1.1 relies on withdrawn item.m1.a1; record a new plan version/);
  if (when === 'running') await engine.reconcile(M);
  if (when === 'running') assert.deepEqual(await w.scheduler.run(queued!.task, { handBack: cal1Pass(queued!.card as unknown as Calibrator1Card) }), []);
  for (let n = 0; n < 4; n++) await engine.reconcile(M);
  assert.equal(w.scheduler.queued('calibrator-1').length, 0);
  assert.equal((await events(w, 'cal1-rerun')).length + (await events(w, 'cal1-recheck-rerun')).length, 0, 'no rerun can cure a withdrawn contract');
  assert.ok(w.ledger.notices.some((n) => /plan pmplan.m1.1 relies on withdrawn item.m1.a1; record a new plan version/.test(n.trigger)));
  assert.ok((await currentItems(flowCtx(w, M))).every((i) => i.state !== 'contested'));
  const judgments = (await w.ledger.records(['judgment'])).map((r) => r.record);
  assert.ok(judgments.every((j) => j.executor !== 'program'));
  if (when === 'running') assert.ok(judgments.some((j) => j.judgment === `j.${queued!.task}`), 'an in-flight pass remains recorded');
  if (when === 'queued') assert.equal(judgments.length, 0);
});

for (const state of ['queued', 'running'] as const) it(`B: a ${state} answering attempt superseded by a batch routes the request again, and the latest answer releases its wait`, async () => {
  const { w, engine } = await setup(); await drive(engine, w.scheduler, happyScript(M));
  await raiseEscalation(flowCtx(w, M), { id: 'mine', source: 'replan', lineage: 'task.m1.impl', subject: 'task:impl', summary: 'Replan impl', reasons: ['Reconsider'], options: ['replan', 'ask-user'] });
  await answerEscalation(w, { mission: M, escalation: 'mine', option: 'replan', instructions: 'UNIQUE REQUEST INSTRUCTION', words: 'W-1' });
  await engine.reconcile(M);
  const old = w.scheduler.queued('architect-decompose')[0]!;
  if (state === 'running') w.scheduler.dispatchOf(old.task);
  const doc = pmPlan(M); doc.elements[1]!.text += ' clarified';
  await submitPmBatch(w, { mission: M, plan: doc, userWords: ['W-1'] });
  await drive(engine, w.scheduler, (t, s) => t.task === old.task || (t.card.seat === 'architect-decompose' && t.task.startsWith('arch.m1.2.')) ? null : happyScript(M)(t, s));
  const current = w.scheduler.queued('architect-decompose').find((t) => t.task.startsWith('arch.m1.2.'))!;
  assert.match(JSON.stringify(current.card['revision']), /UNIQUE REQUEST INSTRUCTION/);
  const routes = await events(w, 'replan-routed');
  assert.equal(routes.length, 2); assert.notEqual(routes[0]!.key, routes[1]!.key);
  assert.equal(await planAnswersReplan(flowCtx(w, M), 'dplan.m1.1.2', 'mine'), false, 'the wait uses the latest route');
  assert.equal(await planAnswersReplan(flowCtx(w, M), 'dplan.m1.1.1', 'mine'), false, 'an unrelated plan cannot release the wait');
  assert.ok(w.scheduler.queued().some((t) => t.task === current.task), 'a waiting request has a live current route');
  await drive(engine, w.scheduler, (t, s) => t.task === old.task ? null : happyScript(M)(t, s));
  assert.ok((await w.ledger.events({ mission: M, line: 'task:impl', event: 'rework' })).some((e) => (e.body as { reason: string }).reason === 'replan'));
  const before = (await events(w, 'replan-routed')).length;
  await engine.reconcile(M); assert.equal((await events(w, 'replan-routed')).length, before, 'routing is idempotent');
});

function nodePass(card: AuditNodeCard): AuditNodeResult {
  return { positions: card.positions.map((p) => ({ review: p.review, verdict: 'pass', items: p.bases.map((b) => ({ basis: b.id, met: 'yes', reason: 'read', evidence: [`file:${card.target.paths[0] ?? 'src/a.ts'}:1`] })), constraints: p.constraints.map((c) => ({ constraint: c.id, paths: c.paths })) })), findings: [], summary: 'checked' };
}
async function auditWorld(mission: MissionId = M, unit = false, beforeQueue?: (w: World) => Promise<unknown>) {
  const w = memoryPorts(); say(w, SEED_TEXT); await item(w, 'g1', 'Goal before');
  const c = w.ledger.content;
  const obj = (id: string, m: MissionId): ObjectVersionRecord => ({ kind: 'object.version', object: id as never, objectKind: 'product', mission: m, module: null, content: c.put(`content ${id}`), prerequisites: c.putList([]), scope: { paths: [`src/${id}.ts`], taskType: 'code' }, reviews: [{ review: 'reviewer', basisLines: ['item.m1.g1'] as never, reliesOn: [] }] });
  await w.ledger.append('audit-objects', { records: [obj('A', mission), ...(unit ? [obj('B', M), { kind: 'proof.unit' as const, unit: 'U' as never, members: c.putList(['A', 'B']), reviews: [{ review: 'integration', basisLines: ['item.m1.g1'] as never, reliesOn: [] }] }] : [])] });
  await beforeQueue?.(w);
  const endpoint = unit ? 'U' : 'A';
  await requestLegalization(w, { legalization: 'L', mission: M, endpoint, words: 'Legalize', chainEvidence: [], capabilities: [] });
  await startLegalization(w, M, 'L', 'go'); await advanceLegalization(w, M, 'L');
  return w;
}
const constraint = (w: World, text: string, mission?: string) => recordConstraint(w, { mission: M, constraint: 'local', kind: 'object', text, scope: { paths: ['src/**'], taskTypes: [], ...(mission === undefined ? {} : { mission }) } });

it('A/D: Auditor refresh rebuilds each position text and binding together, with one current constraint version everywhere', async () => {
  const w = await auditWorld(M, false, (world) => constraint(world, 'Old constraint'));
  assert.equal((w.scheduler.queued('auditor-node')[0]!.card as unknown as AuditNodeCard).positions[0]!.constraints[0]!.text, 'Old constraint');
  // Queue the Auditor before the final changes, then refresh at dispatch.
  await item(w, 'g1', 'Goal now'); const version = await constraint(w, 'New constraint');
  const t = w.scheduler.queued('auditor-node')[0]!;
  const d = pmDispatch(w.ctx, t.task); const card = dispatchView(w.ctx, d.dispatch).card as unknown as AuditNodeCard;
  assert.doesNotMatch(d.card, /Old constraint|Goal before/); assert.match(d.card, /Goal now/);
  const ix = await basisIndex(flowCtx(w, M));
  for (const p of card.positions) {
    const bases = w.memory.data.getList(p.binding.bases as ListRef);
    assert.ok(p.bases.every((b) => bases.some((v) => ix.lineOf.get(v) === b.id && b.text.includes(`version ${v}`))));
    for (const version of bases) {
      const line = ix.lineOf.get(version)!;
      assert.equal(ix.current.get(line), version);
      assert.ok(p.bases.find((b) => b.id === line)!.text.includes(`version ${version}`), 'every bound version has matching rendered text');
    }
    const checks = w.memory.data.getList(p.binding.constraints as ListRef).map(decodeConstraintCheck);
    assert.deepEqual(checks, p.constraints.map((c) => ({ version: c.version, paths: c.paths })));
    assert.ok(p.constraints.every((c) => c.version === version));
    assert.deepEqual(card.constraints.filter((c) => c.kind === 'object').map((c) => [c.id, c.text]), p.constraints.map((c) => [c.id, c.text]));
  }
  assert.deepEqual(await w.scheduler.run(t.task, { handBack: nodePass(card) }), []);
  assert.equal((await w.evaluator.labels(['A'])).labels['A'], 'proven');
});

it('D: cross-mission legalization sends the target mission constraint and completes backfill', async () => {
  const w = await auditWorld('m2' as MissionId, false, (world) => constraint(world, 'm2 constraint', 'm2'));
  const t = w.scheduler.queued('auditor-node')[0]!;
  assert.equal((t.card as unknown as AuditNodeCard).positions[0]!.constraints[0]!.text, 'm2 constraint', 'queue-time builder uses the target mission too');
  const card = dispatchView(w.ctx, pmDispatch(w.ctx, t.task).dispatch).card as unknown as AuditNodeCard;
  assert.equal(card.positions[0]!.constraints[0]!.text, 'm2 constraint');
  assert.deepEqual(await w.scheduler.run(t.task, { handBack: nodePass(card) }), []);
  await advanceLegalization(w, M, 'L');
  assert.equal((await w.evaluator.labels(['A'])).labels['A'], 'proven');
  assert.equal(w.scheduler.queued('auditor-chain').length, 1);
});

it('D: a unit applies scoped constraints only to the member in that mission', async () => {
  const w = await auditWorld('m2' as MissionId, true, (world) => constraint(world, 'm2 member constraint', 'm2'));
  const t = w.scheduler.queued('auditor-node')[0]!;
  const card = dispatchView(w.ctx, pmDispatch(w.ctx, t.task).dispatch).card as unknown as AuditNodeCard;
  assert.equal(card.target.id, 'U');
  assert.deepEqual((t.card as unknown as AuditNodeCard).positions[0]!.constraints[0]!.paths, ['src/A.ts']);
  assert.deepEqual(card.positions[0]!.constraints[0]!.paths, ['src/A.ts']);
  assert.deepEqual(w.memory.data.getList(card.positions[0]!.binding.constraints as ListRef).map(decodeConstraintCheck)[0]!.paths, ['src/A.ts']);
});

it('D: an identical scoped retry leaves the ledger head unchanged; resolution is project-wide', async () => {
  const w = memoryPorts(); const version = await constraint(w, 'm2 rule', 'm2'); const head = w.memory.head();
  assert.equal(await constraint(w, 'm2 rule', 'm2'), version); assert.equal(w.memory.head(), head);
  const cs = await currentConstraints(flowCtx(w, M)); assert.equal(cs.length, 1);
  assert.equal(constraintApplies(cs[0]!, { mission: 'm1', scope: { paths: ['src/A.ts'], taskType: 'code' } }), false);
  assert.equal(constraintApplies(cs[0]!, { mission: 'm2', scope: { paths: ['src/A.ts'], taskType: 'code' } }), true);
});

const KINDS = ['calibrator-1', 'calibrator-2', 'architect-feasibility', 'architect-decompose', 'constructor', 'reviewer', 'secretary', 'auditor-node', 'auditor-chain', 'researcher-author', 'researcher-reader', 'researcher-interpreter', 'constructor-experiment', 'crititor', 'stabilizer'] as const;
const PLANNING = new Set<string>(['calibrator-1', 'calibrator-2', 'architect-feasibility', 'architect-decompose']);
const EXPLORATION = new Set<string>(['researcher-author', 'researcher-reader', 'researcher-interpreter', 'constructor-experiment', 'crititor', 'stabilizer']);

async function initialContext(w: World) {
  await item(w, 'a2', 'AUTHORIZATION BEFORE UNIQUE', 'authorization');
  await recordConstraint(w, { mission: M, constraint: 'context', kind: 'instruction', text: 'INSTRUCTION BEFORE UNIQUE', scope: { paths: ['**'], taskTypes: [] } });
}
async function sameChanges(w: World, kind: string) {
  await item(w, 'late', 'EXPECTED RESULT UNIQUE', 'decision');
  await withdrawItem(w, { mission: M, item: 'a2', reason: 'authority withdrawn' });
  await recordConstraint(w, { mission: M, constraint: 'object', kind: 'object', text: 'OBJECT CONSTRAINT UNIQUE', scope: { paths: kind === 'auditor-chain' ? ['legalization/**'] : kind === 'constructor' || kind === 'reviewer' ? ['src/**'] : ['**'], taskTypes: [] } });
  await recordConstraint(w, { mission: M, constraint: 'context', kind: 'instruction', text: 'INSTRUCTION AFTER UNIQUE', scope: { paths: ['**'], taskTypes: [] } });
}

async function explorationQueue(kind: string, before: boolean) {
  const w = memoryPorts(); say(w, SEED_TEXT); await seedMission(w, M); await initialContext(w);
  if (before) await sameChanges(w, kind);
  const research = kind === 'researcher-interpreter';
  await defineExploration(w, explorationDefinition({ mission: M, exploration: 'E1', product: research ? 'answer' : 'design', research, question: research ? 'What is observed?' : null, goal: 'No holes', decision: { type: 'structure', text: 'Which design' }, readingNetwork: ['https://example.org/'], decisionQuotes: ['DEFINITION DECISION UNIQUE'], constraints: [{ id: 'definition-instruction', kind: 'instruction', text: 'DEFINITION INSTRUCTION UNIQUE' }] }));
  const advance = () => advanceExploration(w, M, 'E1');
  for (let n = 0; n < 20; n++) {
    await advance();
    if (w.scheduler.queued(kind).length > 0) return w;
    const t = w.scheduler.queued()[0]; assert.ok(t, `route to ${kind}`);
    if ((kind === 'researcher-reader' || kind === 'constructor-experiment') && t.card.seat === 'researcher-author') {
      assert.deepEqual(await w.scheduler.run(t.task, { evidence: { steps: ['Read the record'], data: 'input', measure: ['value'], assertions: [], executor: kind === 'researcher-reader' ? 'reading' : 'experiment' } }), []);
    } else {
      const handBack = t.card.seat === 'researcher-author' ? submit('design or method', [], research ? { attempts: [{ id: 'A1', kind: 'reading', purpose: 'collect a value', steps: ['Read the record'], data: 'input', measure: ['value'], assertions: [] }] } : {})
        : t.card.seat === 'crititor' ? attack() : t.card.seat === 'stabilizer' ? stabilizeAll(t.card as unknown as StabilizerCard) : blind(t.card as unknown as ReaderCard);
      assert.deepEqual(await w.scheduler.run(t.task, { handBack }), []);
    }
  }
  throw new Error(`did not queue ${kind}`);
}

async function invariantWorld(kind: string, before: boolean): Promise<World> {
  if (EXPLORATION.has(kind)) return explorationQueue(kind, before);
  if (kind.startsWith('auditor-')) {
    const w = await auditWorld(M, false, async (world) => {
      await initialContext(world);
      if (before && kind === 'auditor-node') await sameChanges(world, kind);
    });
    if (kind === 'auditor-chain') {
      const node = w.scheduler.queued('auditor-node')[0]!;
      assert.deepEqual(await w.scheduler.run(node.task, { handBack: nodePass(node.card as unknown as AuditNodeCard) }), []);
      if (before) await sameChanges(w, kind);
      await advanceLegalization(w, M, 'L');
    }
    return w;
  }
  const { w, engine } = await setup(kind === 'constructor' || kind === 'reviewer' ? 'fast' : 'stable'); await initialContext(w);
  if (kind === 'secretary') {
    await drive(engine, w.scheduler, (t, s) => t.card.seat === 'constructor' ? null : happyScript(M)(t, s));
    if (before) await sameChanges(w, kind);
    await raiseEscalation(flowCtx(w, M), { id: 'context', source: 'constructor-decision', lineage: 'task.m1.iface', subject: 'task:iface', summary: 'Choose', reasons: ['Choose'], items: ['item.m1.g1'], options: ['answer', 'ask-user'] });
    return w;
  }
  if (before) {
    // Let the flow reach its builder, but leave the scheduler empty for that kind. Changes
    // then precede the first queued card, which is built on the following reconcile.
    const submitTask = w.scheduler.submit.bind(w.scheduler);
    w.scheduler.submit = async (t) => { if (t.card.seat !== kind) await submitTask(t); };
    await drive(engine, w.scheduler, happyScript(M));
    assert.equal(w.scheduler.queued(kind).length, 0);
    await sameChanges(w, kind);
    w.scheduler.submit = submitTask;
  }
  await drive(engine, w.scheduler, (t, s) => t.card.seat === kind ? null : happyScript(M)(t, s));
  return w;
}

function contentOf(w: World, card: Record<string, unknown>) {
  const binding = (b: Calibrator1Card['binding']) => ({ bases: w.memory.data.getList(b.bases as ListRef), constraints: w.memory.data.getList(b.constraints as ListRef), reliesOn: w.memory.data.getList(b.reliesOn as ListRef), extends: b.extends });
  return {
    ...Object.fromEntries(['decisionQuotes', 'constraints', 'authorizations', 'items', 'requirementItems', 'quotes'].map((key) => [key, card[key]])),
    materials: (card['materials'] as MaterialRef[] | undefined)?.map((m) => ({ ...m, ref: w.memory.data.text(m.ref) })),
    positions: (card['positions'] as AuditNodeCard['positions'] | undefined)?.map((p) => ({ ...p, binding: binding(p.binding) })),
    binding: card['binding'] === undefined ? undefined : binding(card['binding'] as Calibrator1Card['binding']),
  };
}

for (const kind of KINDS) it(`E: ${kind} dispatched content is independent of changes before queue versus before claim`, async () => {
  const before = await invariantWorld(kind, true);
  const between = await invariantWorld(kind, false);
  const old = between.scheduler.queued(kind)[0]!; assert.ok(old, kind);
  await sameChanges(between, kind);
  let task = old.task;
  if (PLANNING.has(kind)) {
    notReady(() => pmDispatch(between.ctx, task));
    await new FlowEngine(between).reconcile(M);
    task = between.scheduler.queued(kind)[0]!.task;
    assert.notEqual(task, old.task, 'changed planning inputs rebuild through their own builder');
  }
  const first = before.scheduler.queued(kind)[0]!;
  const da = pmDispatch(before.ctx, first.task); const db = pmDispatch(between.ctx, task);
  const ca = dispatchView(before.ctx, da.dispatch).card; const cb = dispatchView(between.ctx, db.dispatch).card;
  const normalize = (value: unknown, id: string) => JSON.stringify(value).replaceAll(id, '<task>');
  assert.equal(normalize(contentOf(between, cb), task), normalize(contentOf(before, ca), first.task));
  // Render the actual dispatched card with identical dispatch metadata, comparing its body.
  assert.equal(normalize(seatCardEntry(kind).render(cb), task), normalize(seatCardEntry(kind).render(ca), first.task));
  assert.ok(da.card.includes(seatCardEntry(kind).render(ca)));
  assert.ok(db.card.includes(seatCardEntry(kind).render(cb)));
  if (EXPLORATION.has(kind) && kind !== 'crititor' && kind !== 'stabilizer') {
    // the project constraints in force are selected again at the claim (as on every card); the definition's own stay
    assert.deepEqual({ ...cb, constraints: [] }, { ...old.card, constraints: [] }, 'versioned definition content is immutable at claim');
    assert.ok((cb['constraints'] as Array<{ id: string }>).some((c) => c.id === 'definition-instruction'));
  }
  if (kind === 'researcher-reader' || kind === 'constructor-experiment') {
    assert.deepEqual(cb['decisionQuotes'], []);
    assert.equal((cb['constraints'] as Array<{ kind: string }>).some((c) => c.kind === 'object'), false);
    assert.equal((cb['materials'] as MaterialRef[]).some((m) => m.role === 'authorizations' || m.id === 'authorizations'), false);
    assert.equal(cb['authorizations'], undefined);
    assert.match(db.card, /DEFINITION INSTRUCTION UNIQUE/);
    assert.doesNotMatch(db.card + materialText(between, cb as unknown as { materials: MaterialRef[] }), /EXPECTED RESULT UNIQUE|OBJECT CONSTRAINT UNIQUE|DEFINITION DECISION UNIQUE|AUTHORIZATION BEFORE UNIQUE/);
  }
  assertShownBound(between, cb);
});

function assertShownBound(w: World, card: Record<string, unknown>) {
  const ix = w.memory.read((db) => db.stmt("SELECT record FROM log WHERE kind = 'basis.version' ORDER BY rev").all()) as Array<{ record: string }>;
  const current = new Map(ix.map((r) => { const b = JSON.parse(r.record) as { version: string; line: string }; return [b.line, b.version]; }));
  const versions = new Map(ix.map((r) => { const b = JSON.parse(r.record) as { version: string; line: string }; return [b.version, b.line]; }));
  const review = (constraints: Array<{ id: string; text: string; kind?: string; version?: string; paths?: string[] }>, binding: Calibrator1Card['binding']) => {
    const checks = w.memory.data.getList(binding.constraints as ListRef).map(decodeConstraintCheck);
    for (const c of constraints.filter((c) => c.kind === undefined || c.kind === 'object')) {
      const check = checks.find((x) => versions.get(x.version) === c.id); assert.ok(check, `${c.id} shown but not bound`);
      assert.equal(check.version, current.get(c.id), 'shown object constraint binds its current version');
      if (c.version !== undefined) assert.equal(c.version, check.version);
      if (c.paths !== undefined) assert.deepEqual(c.paths, check.paths);
      else assert.ok(c.text.endsWith(`(applies to: ${check.paths.join(', ')})`), 'rendered range equals bound range');
    }
  };
  if (card['binding'] != null) review(card['constraints'] as never, card['binding'] as Calibrator1Card['binding']);
  for (const p of (card['positions'] as AuditNodeCard['positions'] | undefined) ?? []) review(p.constraints, p.binding);
}

for (const kind of ['calibrator-2', 'architect-feasibility'] as const) for (const input of ['basis', 'constraint'] as const) it(`A: ${kind} refuses a changed bound ${input} rather than deriving a replacement binding at claim`, async () => {
  const { w, engine } = await setup();
  await drive(engine, w.scheduler, (t, s) => t.card.seat === kind ? null : happyScript(M)(t, s));
  const queued = w.scheduler.queued(kind)[0]!;
  const card = structuredClone(queued.card);
  const binding = card['binding'] as Calibrator1Card['binding'];
  if (input === 'basis') {
    const old = (await currentItems(flowCtx(w, M))).find((i) => i.line === 'item.m1.g1')!.version;
    binding.bases = w.memory.data.putList([old]);
    await item(w, 'g1', 'Changed after queue');
  } else {
    const old = await constraint(w, 'Old constraint');
    binding.constraints = w.memory.data.putList([JSON.stringify({ paths: ['src/A.ts'], version: old })]);
    await constraint(w, 'New constraint');
  }
  const task = `${queued.task}.bound-input-probe`;
  await w.scheduler.submit({ ...queued, task, card: { ...card, task } });
  notReady(() => pmDispatch(w.ctx, task));
});

it('A: an interrupted queued-input cancellation retries and leaves exactly one current rebuilt step', async () => {
  const { w, engine } = await setup(); await drive(engine, w.scheduler, happyScript(M));
  await item(w, 'g1', 'Second goal');
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'], changedItems: ['g1'] });
  await engine.reconcile(M);
  const old = w.scheduler.queued('calibrator-1')[0]!;
  await item(w, 's1', 'Changed after queue', 'acceptance');
  const cancel = w.scheduler.cancel.bind(w.scheduler);
  let once = true;
  w.scheduler.cancel = async (task) => {
    if (task === old.task && once) { once = false; throw new Error('interrupted before cancellation'); }
    return cancel(task);
  };
  assert.ok((await engine.reconcile(M))[0]!.errors.length > 0);
  await engine.reconcile(M);
  assert.equal(w.scheduler.queued('calibrator-1').length, 1);
  assert.notEqual(w.scheduler.queued('calibrator-1')[0]!.task, old.task);
  await drive(engine, w.scheduler, happyScript(M));
  assert.equal((await w.evaluator.labels(['pmplan.m1.1'])).labels['pmplan.m1.1'], 'proven');
});

it('A: a queued review from before input snapshots existed rebuilds once instead of remaining NOT_READY forever', async () => {
  const { w, engine } = await setup(); await engine.reconcile(M);
  const old = w.scheduler.queued('calibrator-1')[0]!;
  const read = w.ledger.events.bind(w.ledger);
  w.ledger.events = async <B = unknown>(query: Parameters<typeof w.ledger.events>[0]) => (await read<B>(query)).filter((e) => !(e.event === 'review-inputs' && (e.body as { task?: string }).task === old.task));
  await item(w, 's1', 'Changed since legacy queue', 'acceptance');
  notReady(() => pmDispatch(w.ctx, old.task));
  await engine.reconcile(M);
  assert.equal(w.scheduler.queued('calibrator-1').length, 1);
  assert.notEqual(w.scheduler.queued('calibrator-1')[0]!.task, old.task);
  await drive(engine, w.scheduler, happyScript(M));
  assert.equal((await w.evaluator.labels(['pmplan.m1.1'])).labels['pmplan.m1.1'], 'proven');
  assert.equal((await events(w, 'review-rebuild')).length, 1);
});

it('D: Reviewer refresh selects constraints by the target object mission, rather than the claiming mission', async () => {
  const { w, engine } = await setup();
  await drive(engine, w.scheduler, (t, s) => t.card.seat === 'reviewer' ? null : happyScript(M)(t, s));
  const queued = w.scheduler.queued('reviewer')[0]!;
  const original = await w.ledger.objectVersion(queued.card['target'] as string); assert.ok(original);
  const target = 'cross-mission-review-target';
  await w.ledger.append('cross-mission-review-object', { records: [{ ...original, object: target as never, mission: 'm2' as MissionId }] });
  await constraint(w, 'm2 target constraint', 'm2');
  await recordConstraint(w, { mission: M, constraint: 'other', kind: 'object', text: 'm1-only constraint', scope: { mission: M, paths: ['src/**'], taskTypes: [] } });
  const task = `${queued.task}.cross-mission`;
  await w.scheduler.submit({ ...queued, task, card: { ...queued.card, task, target } });
  const card = dispatchView(w.ctx, pmDispatch(w.ctx, task).dispatch).card;
  assert.match(JSON.stringify(card['constraints']), /m2 target constraint/);
  assert.doesNotMatch(JSON.stringify(card['constraints']), /m1-only constraint/);
  const checks = w.memory.data.getList((card['binding'] as Calibrator1Card['binding']).constraints as ListRef);
  assert.ok(checks.some((c) => c.includes('constraint.local')));
  assert.ok(checks.every((c) => !c.includes('constraint.other')));
});

it('C: the PM can leave the withdrawn-contract return by recording a new plan version', async () => {
  const { w, engine } = await setup(); await engine.reconcile(M);
  await withdrawItem(w, { mission: M, item: 'a1', reason: 'withdrawn' });
  await engine.reconcile(M);
  assert.equal(w.scheduler.queued('calibrator-1').length, 0);
  const doc = pmPlan(M); doc.authorizations = [];
  const next = await submitPmBatch(w, { mission: M, plan: doc, userWords: ['W-1'] });
  assert.notEqual(next.plan, 'pmplan.m1.1');
  await drive(engine, w.scheduler, happyScript(M));
  assert.equal((await w.evaluator.labels([next.plan])).labels[next.plan], 'proven');
  assert.equal((await events(w, 'cal1-rerun')).length, 0);
});


it('F: a default ** object constraint before the plan proves both plans and stamps a legalization', async () => {
  const w = memoryPorts(); say(w, SEED_TEXT); await seedMission(w, M);
  await recordConstraint(w, { mission: M, constraint: 'house', kind: 'object', text: 'House style', scope: { paths: ['**'], taskTypes: [] } });
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'] });
  const engine = new FlowEngine(w);
  const reviews: string[] = [];
  await drive(engine, w.scheduler, (t, s) => {
    const dispatch = w.scheduler.dispatchOf(t.task);
    const card = dispatchView(w.ctx, dispatch).card;
    assertShownBound(w, card);
    if (PLANNING.has(t.card.seat) && t.card.seat !== 'architect-decompose') {
      reviews.push(t.card.seat);
      assert.equal(w.memory.data.getList((card['binding'] as Calibrator1Card['binding']).constraints as ListRef).length, 1);
      assert.match(JSON.stringify(card['constraints']), /House style/);
    }
    return happyScript(M)(t, s);
  });
  assert.deepEqual(reviews, ['calibrator-1', 'architect-feasibility', 'calibrator-2']);
  assert.deepEqual((await w.evaluator.labels(['pmplan.m1.1', 'dplan.m1.1.1'])).labels, { 'pmplan.m1.1': 'proven', 'dplan.m1.1.1': 'proven' });
  const endpoint = ((await w.ledger.events({ mission: M, line: 'task:impl', event: 'accepted' })).at(-1)!.body as { product: string }).product;
  await requestLegalization(w, { legalization: 'L', mission: M, endpoint, words: 'Legalize', chainEvidence: [], capabilities: [] });
  await startLegalization(w, M, 'L', 'go');
  let stamped = false;
  for (let n = 0; n < 12; n++) {
    const r = await advanceLegalization(w, M, 'L');
    if (r.result?.outcome === 'stamped') { stamped = true; break; }
    for (const t of w.scheduler.queued()) {
      const d = pmDispatch(w.ctx, t.task); const card = dispatchView(w.ctx, d.dispatch).card;
      assertShownBound(w, card);
      const c = card as unknown as AuditChainCard;
      const handBack = card.seat === 'auditor-node' ? nodePass(card as unknown as AuditNodeCard) : {
        quotes: c.quotes.map((q) => ({ quote: q.id, honored: 'yes', reason: 'checked', evidence: ['file:src/parser/api.ts:1'] })),
        seams: c.seams.map((s) => ({ seam: s.id, holds: 'yes', reason: 'checked', evidence: ['file:src/parser/api.ts:1'] })), findings: [], verdict: 'pass',
      };
      assert.deepEqual(await w.scheduler.run(t.task, { handBack }), []);
    }
  }
  assert.equal(stamped, true);
  assert.equal((await w.evaluator.ops(['legal.m1.L'])).states['legal.m1.L']?.allProven, true);
  assert.equal(w.scheduler.queued().length, 0);
});

for (const change of ['add', 'rescope', 'remove-range'] as const) it(`F: ${change} compares the applicable set while Calibrator ① is queued`, async () => {
  const { w, engine } = await setup();
  const scope = (paths: string[]) => ({ paths, taskTypes: [] });
  const version = change === 'add' ? undefined : await recordConstraint(w, { mission: M, constraint: 'range', kind: 'object', text: 'Scoped rule', scope: scope(change === 'rescope' ? ['src/**'] : ['**']) });
  await engine.reconcile(M);
  const old = w.scheduler.queued('calibrator-1')[0]!;
  const nextVersion = await recordConstraint(w, { mission: M, constraint: 'range', kind: 'object', text: 'Scoped rule', scope: scope(change === 'remove-range' ? ['src/**'] : ['**']) });
  if (version !== undefined) assert.equal(nextVersion, version, 'scope changes preserve the content version');
  notReady(() => pmDispatch(w.ctx, old.task));
  await engine.reconcile(M);
  const t = w.scheduler.queued('calibrator-1')[0]!; assert.notEqual(t.task, old.task);
  const d = pmDispatch(w.ctx, t.task); const card = dispatchView(w.ctx, d.dispatch).card;
  assertShownBound(w, card);
  const checks = w.memory.data.getList((card['binding'] as Calibrator1Card['binding']).constraints as ListRef).map(decodeConstraintCheck);
  assert.equal(checks.length, change === 'remove-range' ? 0 : 1);
  if (checks[0] !== undefined) assert.deepEqual(checks[0].paths, ['plans/pm-plan.json']);
});


for (const kind of ['calibrator-1', 'architect-decompose', 'architect-feasibility', 'calibrator-2']) it(`E: unchanged ${kind} content is kept when an unrelated constraint changes`, async () => {
  const { w, engine } = await setup();
  await drive(engine, w.scheduler, (t, s) => t.card.seat === kind ? null : happyScript(M)(t, s));
  const t = w.scheduler.queued(kind)[0]!;
  await recordConstraint(w, { mission: M, constraint: 'elsewhere', kind: 'object', text: 'Other mission', scope: { mission: 'm2', paths: ['**'], taskTypes: [] } });
  const card = dispatchView(w.ctx, pmDispatch(w.ctx, t.task).dispatch).card;
  assert.deepEqual(card, t.card);
});

it('E: refresh refuses unknown seat kinds', async () => {
  const { w, engine } = await setup(); await engine.reconcile(M);
  const t = w.scheduler.queued()[0]!;
  notReady(() => w.memory.read((db) => refreshDispatchCard(db, w.memory.data, { format: 'mp41.task.v1', ...t, card: { ...t.card, seat: 'future-seat' } })), /Unknown seat kind/);
});
