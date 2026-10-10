// The flow ports' adapters over the real ledger service (in process, on a Linux temp dir) and
// the evaluator's query shape (design 6.1, 6.5, 3.9).

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { evaluatorAdapter, ledgerAdapter, seatDemand, taskSpecOf } from '../src/flow/adapters.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { Alerts } from '../src/scheduler/alerts.ts';
import { ControlPlane } from '../src/scheduler/controlPlane.ts';
import { SchedulerLedger } from '../src/scheduler/ledger.ts';
import { processIdentity } from '../src/exec/supervisor.ts';
import { cleanupEnvs, inProcessLedger, makeEnv } from './scheduler-fixtures.ts';
import { fakePorts } from '../src/flow/fakes.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { pmPlan, seedMission } from '../src/flow/scripted.ts';

const M = 'm1' as MissionId;

after(cleanupEnvs);

describe('flow adapters', () => {
  it('ledger: flow events, paged indexed reads, lookups, loops, notices and a stamp with its events go through the real ledger service', async () => {
    const e = makeEnv('flow-adapter');
    const l = inProcessLedger(e);
    const lp = ledgerPaths(e.ledgerRoot, e.cp);
    const ledger = SchedulerLedger.connect(e.socket, 5_000);
    const content = new ContentStore(lp.content);
    try {
      const gen = await l.svc.beginGeneration();
      const alerts = new Alerts({ ledger, content, controlPlane: new ControlPlane(e.cp), source: 'flow' });
      const port = ledgerAdapter({ ledger, content, alerts, gen: () => gen, pageSize: 2 });
      // flow events: appended atomically with base records, read back in order across pages
      for (let i = 1; i <= 5; i++) await port.append(`flow:e${i}`, { events: [{ mission: M, line: 'plan', event: 'pm-batch', key: `b${i}`, body: { n: i } }] });
      assert.deepEqual((await port.events<{ n: number }>({ mission: M, line: 'plan' })).map((x) => x.body.n), [1, 2, 3, 4, 5], 'all pages');
      await port.append('flow:again', { events: [{ mission: M, line: 'plan', event: 'pm-batch', key: 'b1', body: { n: 1 } }] });
      assert.equal((await port.events({ mission: M })).length, 5, 'the same identity and body is a no-op');
      await assert.rejects(port.append('flow:other', { events: [{ mission: M, line: 'plan', event: 'pm-batch', key: 'b1', body: { n: 9 } }] }), /FACT_CONFLICT|another|exists/i);
      assert.deepEqual(await port.missions(), [M]);
      // indexed reads and lookups
      const obj = { kind: 'object.version' as const, object: 'pmplan.m1.1' as never, objectKind: 'plan' as const, mission: M, module: null, content: content.put('{"plan":1}'), prerequisites: content.putList([]), scope: { paths: ['plans/pm-plan.json'], taskType: 'pm-plan' }, reviews: [{ review: 'calibrator-1', basisLines: [], reliesOn: [] }] };
      await port.append('flow:obj', { records: [obj], events: [{ mission: M, line: 'plan', event: 'pm-batch', key: 'b6', body: { n: 6 } }] });
      assert.equal((await port.objectVersion('pmplan.m1.1'))?.objectKind, 'plan');
      assert.equal(await port.objectVersion('nope'), null);
      assert.equal(await port.judgment('nope'), null);
      assert.equal((await port.records(['object.version'], { mission: M })).length, 1);
      // loops
      const a = await port.loopAttempt({ op: 'flow:return:1', lineage: 'plan.m1.1', loop: 'mechanical-return', signature: 'A' });
      const again = await port.loopAttempt({ op: 'flow:return:1', lineage: 'plan.m1.1', loop: 'mechanical-return', signature: 'A' });
      assert.equal(a.attempts, 1);
      assert.equal(again.attempts, 1, 'the op names the attempt: no double count');
      const b = await port.loopAttempt({ op: 'flow:return:2', lineage: 'plan.m1.1', loop: 'mechanical-return', signature: 'A' });
      assert.equal(b.reason, 'no-progress', 'two equal signatures in a row (6.5)');
      // notices
      await port.notify({ category: 'loop-exhausted', wi: 'WI-08', key: 'k1', mission: M, trigger: 't', defaultAction: 'd', detail: { x: 1 } });
      await port.notify({ category: 'secretary-decision', wi: null, key: 'k2', mission: M, trigger: 't', defaultAction: 'd', detail: {} });
      assert.deepEqual((await port.records(['alert'])).map((c) => [c.record.category, c.record.wi ?? null, c.record.informational ?? false]), [
        ['loop-exhausted', 'WI-08', false],
        ['secretary-decision', null, true],
      ]);
      // a proof-conditioned operation: refused below the publication floor (retryable), then executed with its event in one transaction
      await port.append('flow:stamp-pending', { records: [{ kind: 'op.pending', op: 'stamp.m1.1' as never, opKind: 'legalization', objects: content.putList(['pmplan.m1.1']), scope: { mission: M, capabilities: [] } }] });
      const stamp = (asOf: number) => port.append('flow:stamp', { events: [{ mission: M, line: 'audit:l1', event: 'result', key: 'result', body: { outcome: 'stamped' } }], records: [{ kind: 'op.executed', op: 'stamp.m1.1' as never, asOf: asOf as never }] });
      await assert.rejects(stamp(1), (err: Error & { code?: string }) => err.code === 'NOT_READY');
      const identity = processIdentity(process.pid);
      assert.ok(identity !== null);
      const { epoch } = await l.svc.beginEvaluator({ gen, identity: { pid: identity.pid, startTime: String(identity.startTime), bootId: identity.bootId } });
      const { floor } = await l.svc.publish({ epoch, revision: l.svc.head(), batch: null });
      await stamp(floor);
      assert.equal((await port.records(['op.executed'])).length, 1);
      assert.deepEqual((await port.events({ mission: M, line: 'audit:l1' })).map((x) => x.body), [{ outcome: 'stamped' }], 'the result event is committed with the execution');
      await stamp(floor); // a retry of the same op is the stored receipt
      assert.equal((await port.records(['op.executed'])).length, 1);
    } finally {
      ledger.close();
      await l.close();
    }
  });

  it('scheduler: a flow task becomes a seat TaskSpec whose demand follows the card and its tool profile', async () => {
    const ports = fakePorts();
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['msg1'] });
    await new FlowEngine(ports).reconcile(M);
    const t = ports.scheduler.queued('calibrator-1')[0];
    assert.ok(t !== undefined);
    const d = seatDemand(t.card);
    assert.equal(d.runPeakBytes, 0, 'a materials seat runs no commands');
    assert.equal(d.recoveryState, null);
    const e = makeEnv('flow-spec');
    const store = new ContentStore(ledgerPaths(e.ledgerRoot, e.cp).content);
    store.init();
    const spec = taskSpecOf(t, store);
    assert.equal(spec.seat?.demand.areaBytes, (t.card as unknown as { limits: { areaBytes: number } }).limits.areaBytes);
    assert.equal(spec.lineage, 'plan.m1.1');
    assert.deepEqual(JSON.parse(store.get(spec.seat!.card as never).toString('utf8')).seat, 'calibrator-1');
    assert.equal(spec.afterClose, undefined, 'production work by default: cancelled when the mission closes');
    const later = taskSpecOf({ ...t, afterClose: 'repair', changedLines: ['reqset.m1'] }, store);
    assert.equal(later.afterClose, 'repair', 'work that outlives the close says so (6.6)');
    assert.deepEqual(later.changedLines, ['reqset.m1'], 'a continuation review keeps its changed basis lines (5.2 part 5)');
  });

  it('evaluator: labels, deciding views, judgments and operations from the query socket', async () => {
    const calls: string[] = [];
    const port = evaluatorAdapter({
      async call(method, params) {
        calls.push(method);
        const ids = ((params as { ids?: string[]; targets?: string[] }).ids ?? (params as { targets: string[] }).targets) as string[];
        if (method === 'targets') return { revision: 7, states: { [ids[0]!]: { conclusion: 'passed', inEffect: true, fresh: true, label: 'proven' } } };
        if (method === 'deciding') return { revision: 7, targets: {} };
        if (method === 'judgments') return { revision: 7, current: { [ids[0]!]: true } };
        return { revision: 7, states: { [ids[0]!]: { kind: 'legalization', allProven: true, executedAsOf: null } } };
      },
    });
    assert.deepEqual((await port.labels(['a', 'b'])).labels, { a: 'proven', b: null });
    assert.deepEqual((await port.deciding(['a'])).views, { a: null });
    assert.deepEqual((await port.judgments(['j'])).current, { j: true });
    assert.deepEqual((await port.ops(['o'])).states, { o: { allProven: true, executedAsOf: null } });
    assert.deepEqual(calls, ['targets', 'deciding', 'judgments', 'ops']);
  });
});

describe('flow composition and proof operations', () => {
  it('createFlowEngine runs every flow step (decision, execution, exploration, legalization) without an import cycle', async () => {
    const { createFlowEngine } = await import('../src/flow/compose.ts');
    const ports = fakePorts();
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['msg1'] });
    const ran: string[] = [];
    const engine = createFlowEngine(ports, { steps: [{ name: 'probe', step: async () => void ran.push('probe') }] });
    const r = await engine.reconcile(M);
    assert.deepEqual(r[0]?.errors, []);
    assert.ok(ran.length >= 1, 'extra steps run after the built-in ones');
    assert.equal(ports.scheduler.queued('calibrator-1').length, 1, 'the decision layer ran');
    const steps = (engine as unknown as { steps(): ReadonlyArray<{ name: string }> }).steps().map((s) => s.name);
    for (const s of ['secretary', 'planning', 'execution', 'exploration', 'legalization', 'probe']) assert.ok(steps.includes(s), `step ${s} is registered`);
  });

  it('commitProofOp: an operation executes only once it was registered as pending; op.executed in an append goes through it', async () => {
    const ports = fakePorts();
    await assert.rejects(ports.ledger.commitProofOp({ op: 'x1', opId: 'stamp.1', asOf: 0 }), /never registered/);
    await ports.ledger.append('reg', { records: [{ kind: 'op.pending', op: 'stamp.1' as never, opKind: 'legalization', objects: ports.ledger.content.putList([]), scope: { mission: M, capabilities: [] } }] });
    await ports.ledger.append('exec', { records: [{ kind: 'op.executed', op: 'stamp.1' as never, asOf: ports.ledger.head as never }] });
    assert.equal((await ports.ledger.records(['op.executed'])).length, 1);
    await ports.ledger.append('exec', { records: [{ kind: 'op.executed', op: 'stamp.1' as never, asOf: (ports.ledger.head - 1) as never }] }).catch(() => undefined);
    assert.equal((await ports.ledger.records(['op.executed'])).length, 1, 'never executed twice');
  });
});
