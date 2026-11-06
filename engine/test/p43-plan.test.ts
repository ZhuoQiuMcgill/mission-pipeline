import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { cal1Pass, cal2Pass } from '../src/flow/scripted.ts';
import { flowCtx } from '../src/flow/context.ts';
import { structuralDiff, planInEffect } from '../src/flow/planning.ts';
import { DetailedPlanDoc } from '../src/flow/plandoc.ts';
import { secNext } from '../src/process/secretary.ts';
import { addDetailedPlan, startAddMission, step } from './process-fixtures.ts';
import { project43, done43, live43, secretary43 } from './p43-fixtures.ts';

async function firstPlan(p: ReturnType<typeof project43>) {
  await startAddMission(p.ctx, 'm1');
  await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
  await step(p.ctx, 'architect-decompose', () => addDetailedPlan('m1'));
  await step(p.ctx, 'calibrator-2', (c) => cal2Pass(c));
}
async function revision(ctx: ReturnType<typeof secretary43>, k: number) {
  await ctx.ports().ledger.append(`test-revision-${k}`, {events: [{mission: 'm1' as MissionId, line: 'plan', event: 'attempt', key: `pmplan.m1.1#${k}`, body: {k, reason: 'replan', previous: 'dplan.m1.1.1', mechanicalFailures: [], feasibilityFindings: [], instructions: ['revise the plan'], conclusions: []}}]});
}

test('B.2 real revised Architect plan waits in PM inbox until approve; approval and effectiveness share a write', async () => {
  const p = project43();
  try {
    await firstPlan(p);
    const id = await live43(p), ctx = secretary43(p, id);
    try {
      await revision(ctx, 2);
      const plan = DetailedPlanDoc.parse(addDetailedPlan('m1'));
      plan.newInterfaces[0]!.definition = 'add(a: bigint, b: bigint): bigint';
      await step(ctx, 'architect-decompose', () => plan);
      await secNext(ctx);
      assert.equal((await planInEffect(flowCtx(ctx.ports(), 'm1' as MissionId)))?.eff.dplan, 'dplan.m1.1.1', '4.2 treated this as an informational notice');
      const inbox = (await done43(p, ['pm','inbox'])).items.find((i: any) => i.facts?.dplan === 'dplan.m1.1.2');
      assert.ok(inbox); assert.match(inbox.action, /answer/);
      const escalation = inbox.id.slice('m1/'.length);
      assert.equal(ctx.memory.stmt('SELECT 1 FROM tasks WHERE task = ?').get(`sec.${escalation}`), undefined, 'structural changes go straight to the PM');
      await done43(p, ['pm','answer','m1',escalation,'--option','approve','--by','pm','--no-words','--reason','minor format adjustment within the intended result']);
      assert.equal((await planInEffect(flowCtx(ctx.ports(), 'm1' as MissionId)))?.eff.dplan, 'dplan.m1.1.1');
      await secNext(ctx);
      await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
      await secNext(ctx);
      assert.equal((await planInEffect(flowCtx(ctx.ports(), 'm1' as MissionId)))?.eff.dplan, 'dplan.m1.1.2');
      const events = ctx.memory.stmt("SELECT op FROM log WHERE kind = 'flow.event' AND ((json_extract(record,'$.event') = 'effective' AND json_extract(record,'$.key') = 'dplan.m1.1.2') OR (json_extract(record,'$.event') = 'applied' AND json_extract(record,'$.key') = ?))").all(escalation) as {op: string}[];
      assert.equal(events.length, 2); assert.equal(events[0]!.op, events[1]!.op);
    } finally {ctx.memory.close();}
  } finally {p.cleanup();}
});

test('B.2 send-back hands instructions to the next Architect; card-prose-only revision needs no PM approval', async () => {
  const p = project43();
  try {
    await firstPlan(p); const id = await live43(p), ctx = secretary43(p, id);
    try {
      await revision(ctx, 2);
      const changed = DetailedPlanDoc.parse(addDetailedPlan('m1')); changed.storage = ['SQLite'];
      await step(ctx, 'architect-decompose', () => changed); await secNext(ctx);
      const inbox = (await done43(p, ['pm','inbox'])).items.find((i: any) => i.facts?.dplan === 'dplan.m1.1.2');
      await done43(p, ['pm','answer','m1',inbox.id.slice('m1/'.length),'--option','send-back','--by','pm','--no-words','--reason','minor choice; keep storage','--instructions','Keep storage unchanged.']);
      await secNext(ctx);
      const prose = DetailedPlanDoc.parse(addDetailedPlan('m1')); prose.tasks[0]!.goal += ' with clearer prose';
      await step(ctx, 'architect-decompose', (card) => {assert.ok(card.revision.instructions.includes('Keep storage unchanged.')); return prose;});
      await secNext(ctx);
      assert.equal((await done43(p, ['pm','inbox'])).items.some((i: any) => i.facts?.dplan === 'dplan.m1.1.3'), false);
      await step(ctx, 'calibrator-2', (c) => cal2Pass(c)); await secNext(ctx);
      assert.equal((await planInEffect(flowCtx(ctx.ports(), 'm1' as MissionId)))?.eff.dplan, 'dplan.m1.1.3');
    } finally {ctx.memory.close();}
  } finally {p.cleanup();}
});

test('B.2 structural diff covers task addition/drop, interfaces, data formats and storage; prose alone is ignored', () => {
  const a = DetailedPlanDoc.parse(addDetailedPlan('m1'));
  const changed = (edit: (p: DetailedPlanDoc) => void) => {const b = structuredClone(a); edit(b); return structuralDiff(a, b);};
  assert.ok(changed((b) => b.tasks.push({...b.tasks[0]!, id: 'new-task'})).some((s) => s.includes('tasks added')));
  assert.ok(changed((b) => b.tasks.pop()).some((s) => s.includes('tasks dropped')));
  assert.ok(changed((b) => b.newInterfaces[0]!.definition += ' changed').some((s) => s.includes('interfaces')));
  assert.ok(changed((b) => b.dataFormats = ['CSV']).some((s) => s.includes('data formats')));
  assert.ok(changed((b) => b.storage = ['SQLite']).some((s) => s.includes('storage')));
  assert.deepEqual(changed((b) => b.tasks[0]!.goal += ' clarified'), []);
});
