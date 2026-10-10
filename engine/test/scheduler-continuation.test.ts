// The continuation check before an acceptance (design 5.2 part 5, core review r3 F1): a
// continuation judgment among a launch's pending results is accepted only after the
// evaluator's check at the latest published revision is recorded with the merged inputs the
// judgment carries. BELOW_FLOOR asks again; a refused continuation (by the evaluator, or by the
// ledger because the judgment does not carry the merged inputs) is a normal branch: the attempt
// ends "failed" and the task goes to a full review, with an informational notice (no WI). A
// restarted scheduler rebuilds that task from the ledger (dispatchedTasks).

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { revision, type JudgmentId, type ObjectVersionId } from '../src/common/ids.ts';
import type { JudgmentInputs, JudgmentRecord } from '../src/common/records.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { readRecords } from '../src/ledger/store.ts';
import type { EvaluatorQuery } from '../src/scheduler/scheduler.ts';
import { cleanupEnvs, hostTask, inProcessLedger, makeEnv, newScheduler, unitSkip, waitFor, type Env } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

const LISTS: JudgmentInputs = { evidence: ['ev-1'], bases: ['basis-1'], constraints: [], reliesOn: ['obj-0'] };

function judgment(l: ReturnType<typeof inProcessLedger>, id: string, lists: JudgmentInputs = LISTS): JudgmentRecord {
  const c = l.svc.content;
  return {
    kind: 'judgment',
    judgment: id as JudgmentId,
    review: 'reviewer',
    executor: 'reviewer',
    target: 'obj-1' as ObjectVersionId,
    verdict: 'pass',
    evidence: c.putList(lists.evidence),
    bases: c.putList(lists.bases),
    constraints: c.putList(lists.constraints),
    reliesOn: c.putList(lists.reliesOn),
    issues: [],
    revokes: null,
    evidenceUse: { fields: [], statisticalOrExternal: false },
    superseded: [],
    extends: 'J0' as JudgmentId,
  };
}

/** A stand-in for the evaluator's query socket: answers `continuation` with `answer(n)`. */
function fakeEvaluator(answer: (n: number, params: unknown) => unknown): EvaluatorQuery & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    call: async (method, params) => {
      if (method !== 'continuation') throw new Error(`unexpected ${method}`);
      calls.push(params);
      return answer(calls.length, params);
    },
    close: () => undefined,
  };
}

function alertsInLedger(e: Env): Array<{ category: string; wi?: string; informational?: true }> {
  return readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, revision(0))
    .map((c) => c.record)
    .filter((r) => r.kind === 'alert') as never;
}

describe('the continuation check before an acceptance (5.2 part 5)', { skip: unitSkip, timeout: 180_000 }, () => {
  test('checked at the latest published revision (BELOW_FLOOR: asked again), recorded with the merged inputs, then accepted', async () => {
    const e = makeEnv('cont-ok');
    const l = inProcessLedger(e);
    const ev = fakeEvaluator((n) => ({
      // the first answer is at another revision than the latest published: the ledger says BELOW_FLOOR
      revision: n === 1 ? Number(l.svc.publicationFloor()) + 7 : Number(l.svc.publicationFloor()),
      result: { ok: true, merged: LISTS },
    }));
    const s = newScheduler(e, {}, { evaluatorQuery: ev });
    try {
      await s.start();
      const spec = { ...hostTask(e, { task: 'cont', job: { records: [judgment(l, 'J1')] } }), changedLines: ['line-a'] };
      const t = await s.submitDurable(spec);
      await waitFor(() => t.state === 'done', 30_000, 'accepted');
      assert.equal(l.svc.dispositionFor(t.launches[0]!), 'accepted');
      assert.equal(ev.calls.length, 2, 'asked again after BELOW_FLOOR');
      const req = ev.calls[1] as { extends: string; target: string; review: string; changedLines: string[]; draft: JudgmentInputs };
      assert.deepEqual([req.extends, req.target, req.review, req.changedLines], ['J0', 'obj-1', 'reviewer', ['line-a']]);
      assert.deepEqual(req.draft, LISTS, 'the draft is the judgment as handed back');
      const checks = readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, revision(0)).filter((c) => c.record.kind === 'continuation.check');
      assert.equal(checks.length, 1);
      assert.equal((checks[0]!.record as { ok: boolean }).ok, true);
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('refused by the evaluator: the check is recorded; the attempt ends failed; the task goes to a full review (informational, no WI, not a retry); a restarted scheduler rebuilds it', async () => {
    const e = makeEnv('cont-refused');
    const l = inProcessLedger(e);
    const ev = fakeEvaluator(() => ({ revision: Number(l.svc.publicationFloor()), result: { ok: false, reason: 'not-deciding-pass' } }));
    const s1 = newScheduler(e, {}, { evaluatorQuery: ev });
    const s2 = newScheduler(e);
    try {
      await s1.start();
      const t = await s1.submitDurable(hostTask(e, { task: 'cont-no', job: { records: [judgment(l, 'J2')] } }));
      await waitFor(() => t.state === 'needs-disposition', 30_000, 'full review');
      const launch = t.launches[0]!;
      assert.equal(l.svc.dispositionFor(launch), 'failed');
      assert.equal(t.disposition, 'full-review');
      assert.equal(s1.nextSteps.get('cont-no')?.kind, 'full-review');
      assert.equal(l.svc.loopState('lineage-cont-no', 'env-retry').attempts, 0, 'not counted as an environment retry');
      const n = s1.cp.alerts().find((a) => a.category === 'full-review-needed');
      assert.equal(n?.wi, null);
      await waitFor(() => alertsInLedger(e).find((a) => a.category === 'full-review-needed'), 10_000, 'the notice in the ledger');
      const rec = alertsInLedger(e).find((a) => a.category === 'full-review-needed')!;
      assert.deepEqual([rec.informational, rec.wi], [true, undefined], 'a notice that is not an exception: informational, without a WI');
      // the scheduler restarts: the task comes back from the ledger, nobody queues it again
      s1.abandon();
      await s2.start();
      const r = s2.tasks.get('cont-no');
      assert.deepEqual([r?.state, r?.disposition], ['needs-disposition', 'full-review']);
      assert.equal(s2.nextSteps.get('cont-no')?.kind, 'full-review');
    } finally {
      await s2.close();
      await l.close();
    }
  });

  test('the judgment does not carry the merged inputs: the ledger refuses (CONTINUATION_REFUSED): a full review; without an evaluator the same', async () => {
    const e = makeEnv('cont-mismatch');
    const l = inProcessLedger(e);
    // the evaluator merges J0's evidence in; the seat's judgment lacks it
    const merged: JudgmentInputs = { ...LISTS, evidence: ['ev-1', 'ev-j0'] };
    const ev = fakeEvaluator(() => ({ revision: Number(l.svc.publicationFloor()), result: { ok: true, merged } }));
    const s = newScheduler(e, {}, { evaluatorQuery: ev });
    let closed = false;
    try {
      await s.start();
      const t = await s.submitDurable(hostTask(e, { task: 'cont-diff', job: { records: [judgment(l, 'J3')] } }));
      await waitFor(() => t.state === 'needs-disposition', 30_000, 'full review');
      assert.equal(t.disposition, 'full-review');
      assert.match(t.note ?? '', /CONTINUATION_REFUSED/);
      await s.close();
      closed = true;
      // no evaluator here: nothing to check with; the ledger refuses the unchecked continuation
      const s3 = newScheduler(e);
      try {
        await s3.start();
        const u = await s3.submitDurable(hostTask(e, { task: 'cont-unchecked', job: { records: [judgment(l, 'J4')] } }));
        await waitFor(() => u.state === 'needs-disposition', 30_000, 'full review');
        assert.equal(u.disposition, 'full-review');
        assert.match(u.note ?? '', /no evaluator check/);
      } finally {
        await s3.close();
      }
    } finally {
      if (!closed) await s.close();
      await l.close();
    }
  });
});
