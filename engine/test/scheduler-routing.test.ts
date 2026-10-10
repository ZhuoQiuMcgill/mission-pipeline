// §14 item 8 where it touches the scheduler: an ordinary revision of a basis during execution
// does not reject the result; it is accepted bound to the version it used, the evaluator
// degrades its label, and the scheduler routes it (6.2): stable mode re-accepts, fast mode
// continues "not fully proven". With the evaluator running under the scheduler (notices,
// alert copies), against a real ledger and real units.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { BaseRecord } from '../src/common/records.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { routeAccepted } from '../src/scheduler/routing.ts';
import type { Scheduler } from '../src/scheduler/scheduler.ts';
import { cleanupEnvs, hostTask, inProcessLedger, makeEnv, newScheduler, touch, unitSkip, waitFor, type Env, type InProcessLedger } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

function withEvaluator(e: Env): Partial<Parameters<typeof newScheduler>[1]> {
  const p = ledgerPaths(e.ledgerRoot, e.cp);
  const querySocket = join(e.root, 'evaluator.sock');
  return {
    evaluator: {
      worker: { dbPath: p.db, contentRoot: p.content, ledgerSocket: e.socket, querySocket, checkpointPath: join(e.root, 'evaluator.checkpoint'), pollMs: 20, checkpointEvery: 1, faultInjection: false },
      deadlineMs: 20_000,
      heapMb: 256,
      querySocket,
    },
  };
}

/** Product P needing one reviewer judgment bound to requirement req (version v1) and standard std. */
async function seed(l: InProcessLedger, object: string): Promise<BaseRecord> {
  const c = l.svc.content;
  await l.svc.appendRecords({
    op: `seed-${object}`,
    gen: null,
    records: [
      { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@1' as never },
      { kind: 'evidence', evidence: `E-${object}` as never, envLine: 'py' as never, envSnapshot: 'py@1' as never, runClass: 'closed', fields: { exit: '0' } },
      { kind: 'basis.version', basisKind: 'requirement', line: `req-${object}` as never, version: `req-${object}.v1` as never, mission: 'mission-s' as never, scope: null },
      {
        kind: 'object.version',
        object: object as never,
        objectKind: 'product',
        mission: 'mission-s' as never,
        module: null,
        content: c.put(`content of ${object}`),
        prerequisites: c.putList([]),
        scope: { paths: [`src/${object}.ts`], taskType: 'construct' },
        reviews: [{ review: 'reviewer', basisLines: [`req-${object}` as never], reliesOn: [] }],
      },
    ],
  });
  // the judgment the seat will hand back, bound to the requirement version it was given
  return {
    kind: 'judgment',
    judgment: `J-${object}` as never,
    review: 'reviewer',
    executor: 'reviewer',
    target: object as never,
    verdict: 'pass',
    evidence: c.putList([`E-${object}`]),
    bases: c.putList([`req-${object}.v1`]),
    constraints: c.putList([]),
    reliesOn: c.putList([]),
    issues: [],
    revokes: null,
    extends: null,
    evidenceUse: { fields: ['exit'], statisticalOrExternal: false },
    superseded: [],
  };
}

async function runReview(s: Scheduler, l: InProcessLedger, e: Env, object: string, mode: 'stable' | 'fast', revise: boolean) {
  const judgment = await seed(l, object);
  const go = join(e.root, `go-${object}`);
  const t = s.submit(hostTask(e, { task: `review-${object}`, mode, binds: [object], job: { goFile: go, seat: true, seatStatus: 'handed-back', records: [judgment] } }));
  await waitFor(() => t.state === 'running', 20_000, 'running');
  if (revise) {
    // an ordinary revision of the requirement while the seat works
    await l.svc.appendRecords({ op: `revise-${object}`, gen: null, records: [{ kind: 'basis.version', basisKind: 'requirement', line: `req-${object}` as never, version: `req-${object}.v2` as never, mission: 'mission-s' as never, scope: null }] });
  }
  touch(go);
  await waitFor(() => t.state === 'done', 30_000, 'accepted');
  const step = await waitFor(() => s.nextSteps.get(t.spec.task), 30_000, 'routed');
  return { t, step };
}

describe('§14 item 8: an ordinary revision during execution', { skip: unitSkip, timeout: 180_000 }, () => {
  test('accepted, not rejected; the label degrades; stable mode re-accepts, fast mode continues unproven; without a revision it continues proven', async () => {
    const e = makeEnv('revision');
    const l = inProcessLedger(e);
    const s = newScheduler(e, withEvaluator(e));
    try {
      await s.start();
      const stable = await runReview(s, l, e, 'P1', 'stable', true);
      assert.equal(l.svc.dispositionFor(stable.t.launches[0]!), 'accepted', 'the result was accepted');
      assert.deepEqual(stable.step, { kind: 'reaccept', label: 'not-fully-proven', reason: stable.step.kind === 'reaccept' ? stable.step.reason : '' });
      const fast = await runReview(s, l, e, 'P2', 'fast', true);
      assert.deepEqual(fast.step, { kind: 'continue-unproven', label: 'not-fully-proven' });
      const plain = await runReview(s, l, e, 'P3', 'stable', false);
      assert.deepEqual(plain.step, { kind: 'continue', label: 'proven' });
      assert.ok(s.publishedRevision !== null, 'the evaluator published under the scheduler');
    } finally {
      await s.close();
      await l.close();
    }
  });
});

describe('6.2 routing table (pure)', () => {
  test('labels and modes', () => {
    assert.equal(routeAccepted({ mode: 'stable', labels: ['proven'], judgmentsCurrent: [true] }).kind, 'continue');
    assert.equal(routeAccepted({ mode: 'stable', labels: ['not-fully-proven'], judgmentsCurrent: [] }).kind, 'reaccept');
    assert.equal(routeAccepted({ mode: 'fast', labels: ['proven'], judgmentsCurrent: [false] }).kind, 'continue-unproven');
    assert.equal(routeAccepted({ mode: 'fast', labels: ['basis-withdrawn'], judgmentsCurrent: [] }).kind, 'secretary');
  });
});
