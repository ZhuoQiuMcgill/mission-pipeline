// §14 item 9: seats are not interrupted when the scheduler (or the ledger service) restarts; a
// new generation adopts a healthy host and its later publication succeeds; and every window
// between a host's end, its supervisor's proof and the scheduler's reconciliation (6.3, 7.1),
// with a REAL unit supervisor killed or paused at exact points of writing its proof file
// (fault injection: scheduler-fixture-inject.mjs).

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { Generation, LaunchId } from '../src/common/ids.ts';
import type { TerminationProofRecord } from '../src/common/records.ts';
import { proofFilePath, readProofFile, writeProofFile, PROOF_FILE_FORMAT } from '../src/exec/proof.ts';
import { isProcessAlive, readSupervisorIdentity } from '../src/exec/supervisor.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { readRecords } from '../src/ledger/store.ts';
import type { Scheduler } from '../src/scheduler/scheduler.ts';
import { cleanupEnvs, hostTask, inject, inProcessLedger, LedgerProc, makeEnv, newScheduler, nodeWithHook, touch, unitSkip, waitFor, type Env } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

function dispositionEvents(e: Env, launch: LaunchId): string[] {
  return readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, 0 as never)
    .filter((c) => c.record.kind === 'disposition' && (c.record as { launch: string }).launch === launch)
    .map((c) => (c.record as { disposition: string }).disposition);
}

async function firstLaunch(s: Scheduler, task: string): Promise<LaunchId> {
  return waitFor(() => s.tasks.get(task)?.launches[0], 20_000, `${task} launched`);
}

describe('§14 item 9: takeover across scheduler generations', { skip: unitSkip, timeout: 180_000 }, () => {
  test('a new generation adopts a healthy host (rule 4); its later publication succeeds; the old generation is fenced', async () => {
    const e = makeEnv('adopt');
    const l = inProcessLedger(e);
    const go = join(e.root, 'go');
    const s1 = newScheduler(e);
    const s2 = newScheduler(e);
    try {
      const g1 = await s1.start();
      s1.submit(hostTask(e, { task: 'seat', job: { goFile: go, seat: true, seatStatus: 'handed-back' } }));
      const launch = await firstLaunch(s1, 'seat');
      await waitFor(() => s1.cp.readHostHeartbeat(launch), 15_000, 'host heartbeat');
      s1.abandon(); // the scheduler crashes; the unit is an independent service and keeps running
      const g2 = await s2.start();
      assert.equal(g2, (g1 + 1) as Generation);
      const open = l.svc.openLaunches().find((x) => x.launch === launch);
      assert.deepEqual(open?.adoptedBy, [g2], 'adopted alive by the new generation');
      // the old generation is refused
      await assert.rejects(l.svc.dispose({ gen: g1, launch, disposition: 'failed', reason: 'old scheduler' }), /STALE_GENERATION/);
      touch(go);
      await waitFor(() => l.svc.dispositionFor(launch), 30_000, 'disposition');
      assert.equal(l.svc.dispositionFor(launch), 'accepted');
      assert.deepEqual(dispositionEvents(e, launch), ['accepted']);
    } finally {
      await s2.close();
      await l.close();
    }
  });

  test('the scheduler crashes first, the host ends later: the proof is registered by the supervisor and the new generation accepts by it, without redoing (rule 2)', async () => {
    const e = makeEnv('proofthen');
    const l = inProcessLedger(e);
    const go = join(e.root, 'go');
    const s1 = newScheduler(e);
    const s2 = newScheduler(e);
    try {
      await s1.start();
      s1.submit(hostTask(e, { task: 'seat', job: { goFile: go, seat: true, seatStatus: 'handed-back' } }));
      const launch = await firstLaunch(s1, 'seat');
      await waitFor(() => s1.cp.readHostHeartbeat(launch), 15_000, 'host heartbeat');
      s1.abandon();
      touch(go);
      // host and supervisor both end before the new scheduler starts; the proof is in the ledger
      await waitFor(() => l.svc.proofFor(launch), 20_000, 'proof registered by the supervisor');
      const sup = readSupervisorIdentity(e.stateDir, launch);
      await waitFor(() => sup !== null && !isProcessAlive(sup), 20_000, 'supervisor gone');
      const g2 = await s2.start();
      assert.equal(l.svc.dispositionFor(launch), 'accepted', 'accepted during the takeover itself');
      assert.deepEqual(l.svc.openLaunches(), []);
      const adoptions = readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, 0 as never).filter((c) => c.record.kind === 'launch.adopted');
      assert.deepEqual(
        adoptions.map((c) => (c.record as { via: string; gen: number }).via + ':' + (c.record as { gen: number }).gen),
        [`proof:${g2}`],
      );
      assert.equal(l.svc.launches().length, 1, 'nothing was redone');
      assert.deepEqual(s2.tasks.all().map((t) => [t.spec.task, t.state, t.launches.length]), [['seat', 'done', 1]], 'the task, picked up from its ledger card, is done');
    } finally {
      await s2.close();
      await l.close();
    }
  });

  test('the ledger service restarts while a seat runs: the seat is not interrupted and its publication succeeds', async () => {
    const e = makeEnv('ledgerrestart');
    const lp = new LedgerProc(e);
    await lp.start();
    const go = join(e.root, 'go');
    const s = newScheduler(e);
    try {
      await s.start();
      const t = s.submit(hostTask(e, { task: 'seat', job: { goFile: go, seat: true, seatStatus: 'handed-back' } }));
      const launch = await firstLaunch(s, 'seat');
      await waitFor(() => s.cp.readHostHeartbeat(launch), 15_000, 'host heartbeat');
      await lp.kill('SIGKILL');
      await lp.start();
      touch(go);
      await waitFor(() => t.state === 'done', 40_000, 'accepted after the ledger restart');
      assert.equal(t.launches.length, 1, 'not redone');
    } finally {
      await s.close();
      await lp.kill('SIGTERM');
    }
  });
});

describe('§14 item 9: the supervisor killed at each point of writing its proof (kill, then the reconciliation entry)', { skip: unitSkip, timeout: 180_000 }, () => {
  // before-tmp and after-tmp: no complete proof file exists -> "failed, no proof"
  // after-rename and after-dirsync: the complete file is found and submitted -> accepted, never failed first
  const cases = [
    { point: 'before-tmp', expect: 'failed' },
    { point: 'after-tmp', expect: 'failed' },
    { point: 'after-rename', expect: 'accepted' },
    { point: 'after-dirsync', expect: 'accepted' },
  ] as const;

  test('kill at before-tmp, after-tmp, after-rename, after-dirsync', async () => {
    const e = makeEnv('killpoints');
    const l = inProcessLedger(e);
    const go = join(e.root, 'go');
    const s = newScheduler(e, { nodePath: nodeWithHook(e) });
    try {
      await s.start();
      const tasks = cases.map((c) => s.submit(hostTask(e, { task: `k-${c.point}`, job: { goFile: go, seat: true, seatStatus: 'handed-back' } })));
      const launches: LaunchId[] = [];
      for (const [i, c] of cases.entries()) {
        const launch = await firstLaunch(s, tasks[i]!.spec.task);
        inject(e, launch, c.point, 'kill');
        launches.push(launch);
      }
      touch(go);
      for (const [i, c] of cases.entries()) {
        const launch = launches[i]!;
        await waitFor(() => l.svc.dispositionFor(launch), 40_000, `disposition of ${c.point}`);
        assert.ok(existsSync(join(e.stateDir, 'inject', `${launch}.${c.point}`)), `the supervisor reached ${c.point}`);
        assert.deepEqual(dispositionEvents(e, launch), [c.expect], `${c.point}: one final disposition, ${c.expect}`);
        if (c.expect === 'failed') {
          assert.equal(l.svc.proofFor(launch), null);
          const ev = readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, 0 as never).find((x) => x.record.kind === 'disposition' && (x.record as { launch: string }).launch === launch);
          assert.equal((ev?.record as { reason: string }).reason, 'no-proof');
        } else {
          assert.deepEqual(l.svc.proofFor(launch)?.exit, { code: 0, signal: null });
          assert.equal(existsSync(proofFilePath(e.stateDir, launch)), false, 'the submitted file is removed');
        }
      }
      // the retried attempts of the failed ones run normally
      for (const t of tasks) await waitFor(() => t.state === 'done', 40_000, `${t.spec.task} done`);
      // every launch is cleaned up, though two supervisors died before recording anything (v35)
      for (const launch of launches) await waitFor(() => l.svc.cleanupState(launch) === 'done', 30_000, `cleanup of ${launch}`);
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('a death notice arriving before any directory scan: the entry confirms the supervisor is gone, finds the file, submits it; no failure is committed first', async () => {
    const e = makeEnv('deathnotice');
    const l = inProcessLedger(e);
    const go = join(e.root, 'go');
    const s = newScheduler(e, { nodePath: nodeWithHook(e) });
    try {
      await s.start({ startLoops: false });
      s.submit(hostTask(e, { task: 'dn', job: { goFile: go, seat: true, seatStatus: 'handed-back' } }));
      await s.tick();
      const launch = await firstLaunch(s, 'dn');
      inject(e, launch, 'after-dirsync', 'kill');
      touch(go);
      await waitFor(() => existsSync(join(e.stateDir, 'inject', `${launch}.after-dirsync`)), 20_000, 'supervisor killed after its proof file');
      const sup = readSupervisorIdentity(e.stateDir, launch)!;
      await waitFor(() => !isProcessAlive(sup), 10_000, 'supervisor gone');
      assert.equal(l.svc.proofFor(launch), null, 'nothing in the ledger yet');
      assert.ok(existsSync(proofFilePath(e.stateDir, launch)), 'the proof file is complete on disk');
      // the death notice: reconcile this launch now, before any periodic scan
      const open = l.svc.openLaunches().find((x) => x.launch === launch)!;
      const st = await s.takeover.reconcile(open);
      assert.equal(st.kind, 'decided');
      assert.equal(st.kind === 'decided' && st.outcome.kind, 'accepted');
      assert.deepEqual(dispositionEvents(e, launch), ['accepted']);
    } finally {
      await s.close();
      await l.close();
    }
  });
});

describe('§14 item 9: the directory queried before the proof is published (round 24): the supervisor paused, the deadline kills it, then the scheduler queries again', { skip: unitSkip, timeout: 180_000 }, () => {
  const fast = { proofPendingLimitMs: 2_000, heartbeatTimeoutMs: 5_000, startGraceMs: 10_000, proofGraceMs: 1_000, killWaitMs: 5_000 };

  test('paused before the tmp write / after the tmp write: the deadline kills it, the re-query finds no proof: failed, no proof, only after the kill', async () => {
    const e = makeEnv('pausenoproof');
    const l = inProcessLedger(e);
    const go = join(e.root, 'go');
    const s = newScheduler(e, { nodePath: nodeWithHook(e), takeover: fast });
    const points = ['before-tmp', 'after-tmp'] as const;
    try {
      await s.start();
      const tasks = points.map((p) => s.submit(hostTask(e, { task: `p-${p}`, job: { goFile: go, seat: true, seatStatus: 'handed-back' } })));
      const launches: LaunchId[] = [];
      for (const [i, p] of points.entries()) {
        const launch = await firstLaunch(s, tasks[i]!.spec.task);
        inject(e, launch, p, 'pause');
        launches.push(launch);
      }
      touch(go);
      for (const [i, p] of points.entries()) {
        const launch = launches[i]!;
        await waitFor(() => existsSync(join(e.stateDir, 'inject', `${launch}.${p}`)), 20_000, `paused at ${p}`);
        await waitFor(() => l.svc.dispositionFor(launch), 40_000, `disposition after the deadline (${p})`);
        assert.deepEqual(dispositionEvents(e, launch), ['failed'], p);
        assert.equal(isProcessAlive(readSupervisorIdentity(e.stateDir, launch)!), false, 'the scheduler killed the paused supervisor before deciding');
        assert.ok(s.cp.alerts().some((a) => a.category === 'proof-pending-timeout' && a.key === launch), 'a system alert for the expired deadline');
      }
      const tmp = readdirSync(join(e.stateDir, 'proofs')).filter((n) => n.endsWith('.tmp'));
      assert.equal(tmp.length, 1, 'the after-tmp case left its tmp file, never read as a proof');
      for (const launch of launches) await waitFor(() => l.svc.cleanupState(launch) === 'done', 30_000, 'cleanup');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('paused after the rename / after the directory fsync: driven by the deadline alone (no periodic scan), the kill comes first, then the re-query finds the file: accepted', async () => {
    const e = makeEnv('pauseproof');
    const l = inProcessLedger(e);
    const go = join(e.root, 'go');
    const s = newScheduler(e, { nodePath: nodeWithHook(e), takeover: fast });
    const points = ['after-rename', 'after-dirsync'] as const;
    try {
      await s.start({ startLoops: false });
      const tasks = points.map((p) => s.submit(hostTask(e, { task: `p-${p}`, job: { goFile: go, seat: true, seatStatus: 'handed-back' } })));
      await s.tick();
      const launches: LaunchId[] = [];
      for (const [i, p] of points.entries()) {
        const launch = await firstLaunch(s, tasks[i]!.spec.task);
        inject(e, launch, p, 'pause');
        launches.push(launch);
      }
      touch(go);
      for (const [i, p] of points.entries()) {
        const launch = launches[i]!;
        await waitFor(() => existsSync(join(e.stateDir, 'inject', `${launch}.${p}`)), 20_000, `paused at ${p}`);
        const open = () => l.svc.openLaunches().find((x) => x.launch === launch)!;
        // rule 3: host gone, supervisor alive and paused: proof pending
        const first = await s.takeover.reconcile(open());
        assert.equal(first.kind, 'proof-pending', p);
        assert.equal(l.svc.proofFor(launch), null);
        await new Promise((r) => setTimeout(r, 2_100));
        const sup = readSupervisorIdentity(e.stateDir, launch)!;
        assert.equal(isProcessAlive(sup), true, 'still paused when the deadline passes');
        const st = await s.takeover.reconcile(open());
        assert.equal(isProcessAlive(sup), false, 'killed by the scheduler');
        assert.equal(st.kind === 'decided' && st.outcome.kind, 'accepted', p);
        assert.deepEqual(dispositionEvents(e, launch), ['accepted']);
      }
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('a supervisor still running after its attempt is disposed and proven is ended after the limit, so cleanup completes', async () => {
    const e = makeEnv('lingering');
    const l = inProcessLedger(e);
    const go = join(e.root, 'go');
    const s = newScheduler(e, { nodePath: nodeWithHook(e), takeover: fast });
    try {
      await s.start();
      const t = s.submit(hostTask(e, { task: 'linger', job: { goFile: go, seat: true, seatStatus: 'handed-back' } }));
      const launch = await firstLaunch(s, 'linger');
      inject(e, launch, 'after-dirsync', 'pause');
      touch(go);
      // the periodic scan submits the complete file: accepted while the supervisor hangs
      await waitFor(() => t.state === 'done', 30_000, 'accepted by the scanned proof file');
      const sup = readSupervisorIdentity(e.stateDir, launch)!;
      await waitFor(() => !isProcessAlive(sup), 20_000, 'the lingering supervisor is ended');
      assert.ok(s.cp.alerts().some((a) => a.category === 'supervisor-lingering'));
      await waitFor(() => l.svc.cleanupState(launch) === 'done', 30_000, 'cleanup done');
    } finally {
      await s.close();
      await l.close();
    }
  });
});

describe('§14 item 9: proofs after a final disposition, and conflicting proofs (7.1 step 4)', { skip: unitSkip, timeout: 180_000 }, () => {
  test('a valid proof arriving after the attempt was cancelled is registered as a fact; the disposition is unchanged', async () => {
    const e = makeEnv('lateproof');
    const l = inProcessLedger(e);
    const go = join(e.root, 'go');
    const s = newScheduler(e);
    try {
      await s.start();
      s.submit(hostTask(e, { task: 'late', job: { goFile: go, seat: true, seatStatus: 'handed-back' } }));
      const launch = await firstLaunch(s, 'late');
      await waitFor(() => s.cp.readHostHeartbeat(launch), 15_000, 'host heartbeat');
      await l.svc.dispose({ gen: s.gen, launch, disposition: 'cancelled', reason: 'cancelled by the PM (test)' });
      touch(go);
      await waitFor(() => l.svc.proofFor(launch), 20_000, 'proof registered');
      assert.equal(l.svc.dispositionFor(launch), 'cancelled');
      await waitFor(() => l.svc.cleanupState(launch) === 'done', 20_000, 'cleanup still progresses (rule 1)');
      await s.tick();
      assert.deepEqual(dispositionEvents(e, launch), ['cancelled']);
      const recs = readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, 0 as never);
      const dispRev = recs.find((c) => c.record.kind === 'disposition')!.revision;
      const proofRev = recs.find((c) => c.record.kind === 'termination.proof')!.revision;
      assert.ok(proofRev > dispRev, 'the proof was recorded after the final disposition');
      assert.equal(recs.filter((c) => c.record.kind === 'claude-code.exit').length, 0, 'its results were never published');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('a second proof with different content for the same launch: rejected deterministically, the file marked, an alert raised, never retried', async () => {
    const e = makeEnv('conflict');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start();
      const t = s.submit(hostTask(e, { task: 'c', job: { seat: true, seatStatus: 'handed-back' } }));
      await waitFor(() => t.state === 'done', 30_000, 'accepted');
      const launch = t.launches[0]!;
      const other: TerminationProofRecord = { kind: 'termination.proof', launch, exit: { code: 1, signal: null }, controlOomKill: 0, unitOomKill: 0, unitOom: 0 };
      writeProofFile(e.stateDir, {
        format: PROOF_FILE_FORMAT,
        status: 'pending',
        proof: other,
        writtenAt: new Date().toISOString(),
        supervisor: { pid: 1, bootId: 'x' },
        diagnostics: { hostStarted: true, spawnError: null, hostExitedAt: '', unitEmptyAt: '', leftoversKilled: false, populatedAtProof: false, stopped: false, serviceOom: 0 },
        rejection: null,
      });
      await s.tick();
      const f = readProofFile(proofFilePath(e.stateDir, launch));
      assert.equal(f.status, 'rejected');
      assert.equal(f.rejection?.reason, 'conflicting-proof');
      assert.deepEqual(l.svc.proofFor(launch)?.exit, { code: 0, signal: null }, 'the registered proof is unchanged');
      assert.equal(l.svc.dispositionFor(launch), 'accepted');
      const alerts = s.cp.alerts().filter((a) => a.category === 'proof-rejected');
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0]?.committed, true, 'the alert is in the ledger too');
      await s.tick();
      assert.equal(s.cp.alerts().filter((a) => a.category === 'proof-rejected').length, 1, 'not resubmitted');
    } finally {
      await s.close();
      await l.close();
    }
  });
});
