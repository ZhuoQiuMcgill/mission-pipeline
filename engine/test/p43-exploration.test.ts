import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { explorationState } from '../src/flow/exploration/flow.ts';
import { cal1Pass } from '../src/flow/scripted.ts';
import { pmMission, pmPlan, pmSay } from '../src/process/index.ts';
import { secNext } from '../src/process/secretary.ts';
import { dispatchView } from '../src/process/seat.ts';
import { step, readAll } from './process-fixtures.ts';
import { project43, done43, live43, secretary43 } from './p43-fixtures.ts';

test('PM grants apply to exploration as PM rulings, preserve instructions and bypass the Secretary grant limit', async () => {
  const p = project43();
  try {
    pmMission(p.ctx, 'm1');
    const w = pmSay(p.ctx, 'Explore a cache design with no logical hole.').words;
    await pmPlan(p.ctx, {mission: 'm1', words: [w], plan: {format: 'mp4.pm-plan.v1', mission: 'm1', round: 1, order: 'free', elements: [{id: 'x', kind: 'exploration', text: 'Explore a cache design', provenance: {by: 'user', words: w, quote: 'Explore a cache design'}, after: [], items: [], exploration: {id: 'X1', deliverable: 'a cache design', fuzzyGoal: {quote: 'no logical hole', words: w}, attackScope: ['internal contradiction'], decision: {id: 'D1', type: 'direction'}, budget: {rounds: 1, micros: null}, stop: '', research: false}}], goalsBeyond: [], authorizations: []}});
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    const id = await live43(p), ctx = secretary43(p, id);
    try {
      await step(ctx, 'researcher-author', () => ({step: 'submit', message: 'first design', artifact: 'cache v1', dispositions: [], directionQuestions: [], attempts: []}));
      await step(ctx, 'crititor', () => ({findings: [{severity: 'serious', class: 'internal contradiction', title: 'ordering', basis: 'the cache operations', consequence: 'stale reads', direction: 'fix ordering', evidence: []}], rechecks: [], settled: [], reply: 'one hole'}));
      await step(ctx, 'researcher-author', (c) => ({step: 'submit', message: 'revised', artifact: 'cache v2', dispositions: c.openFindings.map((f: any) => ({finding: f.id, action: 'revise', note: 'ordering fixed'})), directionQuestions: [], attempts: []}));
      await step(ctx, 'stabilizer', (c) => ({findings: c.findings.map((f: any) => ({finding: f.id, verdict: 'in-scope', severity: 'serious', reason: 'the recheck is still needed', question: ''})), round: {verdict: 'on-track', reason: 'same design', question: ''}}));
      await secNext(ctx);
      const state = await explorationState(ctx.ports(), 'm1' as MissionId, 'X1');
      assert.equal(state.stopped?.reason, 'budget-exhausted');
      const escalation = `xp.m1.X1.stop${state.stopped!.n}`;
      const d = await done43(p, ['sec','card',escalation], id); readAll(ctx, d.dispatch);
      await done43(p, ['sec','decide',escalation,'--option','ask-pm','--reason','another round requires the PM'], id);
      const lineage = (dispatchView(ctx, d.dispatch).card.request as {lineage: string}).lineage;
      await ctx.ports().scheduler.grant({op: 'prior-secretary-grant', lineage, loop: 'env-retry', by: 'secretary', extra: 1, reason: 'the Secretary’s one grant was used earlier'});
      assert.ok((await done43(p, ['pm','inbox'])).items.some((i: any) => i.id === `m1/${escalation}`));
      const words = await done43(p, ['pm','say','Run another round on the ordering finding','--tag','decision@m1']);
      await done43(p, ['pm','answer','m1',escalation,'--by','pm','--words',words.words,'--reason','the recorded instruction supports another round','--option','grant','--extra','1','--instructions','Focus on cache ordering.']);
      await secNext(ctx);
      const now = await explorationState(ctx.ports(), 'm1' as MissionId, 'X1');
      assert.ok(now.rulings.some((r) => r.by === 'pm' && r.decision === 'extend'));
      await step(ctx, 'crititor', (c) => {
        assert.match(JSON.stringify(c), /Focus on cache ordering/);
        return {findings: [], rechecks: c.priorFindings.filter((f: any) => f.status === 'awaiting-recheck').map((f: any) => ({finding: f.id, resolved: 'yes', reason: 'ordering fixed', evidence: []})), settled: [], reply: 'verified'};
      });
      const journal = ctx.memory.stmt("SELECT body FROM flow_events WHERE mission = 'm1' AND line = 'secretary' AND event = 'applied' AND key = ?").get(escalation) as {body: string};
      assert.equal(JSON.parse(ctx.memory.data.text(journal.body)).by, 'pm');
      const writes = ctx.memory.stmt("SELECT op FROM log WHERE (kind = 'loop.grant' AND json_extract(record,'$.by') = 'pm') OR (kind = 'flow.event' AND json_extract(record,'$.event') = 'applied' AND json_extract(record,'$.key') = ?)").all(escalation) as {op: string}[];
      assert.equal(writes.length, 2); assert.equal(writes[0]!.op, writes[1]!.op, 'the grant and exploration application are one write');
    } finally {ctx.memory.close();}
  } finally {p.cleanup();}
});
