// Stabilizer round 3 (P3): the two P3 regressions with bounded fixes.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { recordConstraint, recordItem, withdrawItem } from '../src/flow/requirements.ts';
import { advanceLegalization, requestLegalization, startLegalization } from '../src/flow/audit/flow.ts';
import { drive, happyScript, pmPlan, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import { pmDispatch } from '../src/process/pm.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { AuditNodeCard, AuditNodeResult } from '../src/seat/cards/auditor.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;

async function legalizationWithQueuedAuditor(): Promise<{ w: World; task: string; card: AuditNodeCard }> {
  const w = memoryPorts(); say(w, 'Build a thing');
  await recordItem(w, { mission: M, item: 'g1', type: 'goal', text: 'Build a thing', source: { kind: 'words', words: 'W-1', quote: 'Build a thing' } });
  const c = w.ledger.content;
  await w.ledger.append('obj', { records: [{ kind: 'object.version', object: 'A' as never, objectKind: 'product', mission: M, module: null, content: c.put('content'), prerequisites: c.putList([]), scope: { paths: ['src/a.ts'], taskType: 'code' }, reviews: [{ review: 'reviewer', basisLines: ['item.m1.g1'] as never, reliesOn: [] }] }] });
  await requestLegalization(w, { legalization: 'L', mission: M, endpoint: 'A', words: 'Legalize it', chainEvidence: [], capabilities: [] });
  await startLegalization(w, M, 'L', 'start');
  await advanceLegalization(w, M, 'L');
  const t = w.scheduler.queued('auditor-node')[0]!;
  return { w, task: t.task, card: t.card as unknown as AuditNodeCard };
}

function nodePass(card: AuditNodeCard): AuditNodeResult {
  return {
    positions: card.positions.map((p) => ({ review: p.review, verdict: 'pass' as const, items: p.bases.map((b) => ({ basis: b.id, met: 'yes' as const, reason: 'read the code', evidence: ['file:src/a.ts:1'] })), constraints: p.constraints.map((k) => ({ constraint: k.id, paths: k.paths })) })),
    findings: [],
    summary: 'done',
  };
}

it('r3 #3: a queued node Auditor whose contract basis is withdrawn ends the legalization (WI-25), never waits for good', async () => {
  const { w, task } = await legalizationWithQueuedAuditor();
  await withdrawItem(w, { mission: M, item: 'g1', reason: 'No longer applies' });
  assert.throws(() => pmDispatch(w.ctx, task), (e: unknown) => (e as { code?: string }).code === 'NOT_READY');
  const r = await advanceLegalization(w, M, 'L');
  assert.equal(r.state, 'ended');
  assert.equal(r.result?.outcome, 'not-legalized');
  assert.equal(r.result?.wi, 'WI-25');
  assert.match(r.result?.why ?? '', /item\.m1\.g1/);
  assert.deepEqual(w.scheduler.queued().map((t) => t.task), [], 'the refused Auditor left the queue');
  assert.ok(w.ledger.notices.some((n) => n.category === 'legalization-incomplete' && n.wi === 'WI-25'), 'the PM is told');
  // idempotent: further passes change nothing
  assert.equal((await advanceLegalization(w, M, 'L')).state, 'ended');
});

it('r3 #3: the other exits of a basis change around a node Auditor still end or proceed', async () => {
  // revised while queued: the claim regenerates the card and the Auditor runs
  {
    const { w, task } = await legalizationWithQueuedAuditor();
    await recordItem(w, { mission: M, item: 'g1', type: 'goal', text: 'Build a better thing', source: { kind: 'words', words: 'W-1', quote: 'Build a thing' } });
    const d = pmDispatch(w.ctx, task);
    const card = dispatchView(w.ctx, d.dispatch).card as unknown as AuditNodeCard;
    assert.match(card.positions[0]!.bases.map((b) => b.text).join('\n'), /better/);
    assert.deepEqual(await w.scheduler.run(task, { handBack: nodePass(card) }), []);
    const r = await advanceLegalization(w, M, 'L');
    assert.equal((await w.evaluator.labels(['A'])).labels['A'], 'proven', 'the backfill on the revised basis proves the node');
    assert.ok(r.state !== 'waiting' || w.scheduler.queued('auditor-chain').length > 0, `revised basis: ${r.why}`);
  }
  // withdrawn while in flight: the hand-back is recorded and the legalization ends (WI-25)
  {
    const { w, task, card } = await legalizationWithQueuedAuditor();
    pmDispatch(w.ctx, task);
    await withdrawItem(w, { mission: M, item: 'g1', reason: 'No longer applies' });
    assert.deepEqual(await w.scheduler.run(task, { handBack: nodePass(card) }), []);
    const r = await advanceLegalization(w, M, 'L');
    assert.equal(r.state, 'ended');
    assert.equal(r.result?.wi, 'WI-25');
  }
  // invariant: never "waiting" with nothing queued and nothing in flight
  {
    const { w } = await legalizationWithQueuedAuditor();
    await withdrawItem(w, { mission: M, item: 'g1', reason: 'No longer applies' });
    const r = await advanceLegalization(w, M, 'L');
    assert.ok(r.state !== 'waiting' || w.scheduler.queued().length > 0, 'stopped with nothing pending');
  }
});

it('r3 #4: a concrete-file object constraint inside a wildcard write scope reaches the Constructor card', async () => {
  const w = memoryPorts(); say(w, SEED_TEXT); await seedMission(w, M);
  await submitPmBatch(w, { mission: M, plan: pmPlan(M), userWords: ['W-1'] });
  const engine = new FlowEngine(w);
  await drive(engine, w.scheduler, (t, s) => (t.card.seat === 'constructor' && t.task.includes('impl') ? null : happyScript(M)(t, s)));
  const task = w.scheduler.queued('constructor')[0]!;
  await recordConstraint(w, { mission: M, constraint: 'file', kind: 'object', text: 'EXACT FILE RULE', scope: { paths: ['src/parser/impl/index.ts'], taskTypes: [] } });
  await recordConstraint(w, { mission: M, constraint: 'other', kind: 'object', text: 'OTHER PATH RULE', scope: { paths: ['docs/**'], taskTypes: [] } });
  await recordConstraint(w, { mission: M, constraint: 'typed', kind: 'object', text: 'OTHER TYPE RULE', scope: { paths: ['src/parser/impl/index.ts'], taskTypes: ['docs'] } });
  await recordConstraint(w, { mission: M, constraint: 'm2only', kind: 'object', text: 'OTHER MISSION RULE', scope: { paths: ['**'], taskTypes: [], mission: 'm2' } });
  const d = pmDispatch(w.ctx, task.task);
  const card = dispatchView(w.ctx, d.dispatch).card as unknown as { constraints: Array<{ id: string }>; workspace: { writablePaths: string[] } };
  assert.deepEqual(card.workspace.writablePaths, ['src/parser/impl/**']);
  const ids = card.constraints.map((c) => c.id);
  assert.ok(ids.includes('constraint.file'), 'the file rule inside the write scope is on the card');
  assert.ok(!ids.includes('constraint.other') && !ids.includes('constraint.typed') && !ids.includes('constraint.m2only'), `nothing outside the task's paths, type or mission: ${ids.join(', ')}`);
  assert.match(d.card, /EXACT FILE RULE/);
});
