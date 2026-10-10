// §14 item 3: liveness and order of stops (6.1, 6.4), with real processes: real units, a
// real ledger service process (with fault injection where the scenario needs it), the
// scheduler, and the watchdog restarting what hangs.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { id, type LaunchId, type MissionId, type StopId } from '../src/common/ids.ts';
import { processIdentity } from '../src/exec/supervisor.ts';
import { LedgerClient } from '../src/ledger/ipc.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { readRecords } from '../src/ledger/store.ts';
import { sendStop } from '../src/ledger/stops.ts';
import type { StopReport } from '../src/scheduler/controlPlane.ts';
import { ControlPlane } from '../src/scheduler/controlPlane.ts';
import { systemProcesses, type ProcessControl } from '../src/scheduler/units.ts';
import { isProcessAlive } from '../src/exec/supervisor.ts';
import {
  cleanupEnvs,
  hostTask,
  inProcessLedger,
  LedgerProc,
  M,
  makeEnv,
  newScheduler,
  readJson,
  rpcTask,
  startWatched,
  unitInactive,
  unitSkip,
  waitFor,
  type Env,
} from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

function stopPaths(e: Env): { inbox: string; controlPlane: string } {
  const p = ledgerPaths(e.ledgerRoot, e.cp);
  return { inbox: p.inbox, controlPlane: p.controlPlane };
}

function stopReq(stop: string, mission: MissionId = M): { stop: StopId; scope: { kind: 'mission'; mission: MissionId }; words: string; at: number } {
  return { stop: id<StopId>(stop), scope: { kind: 'mission', mission }, words: '停下', at: Date.now() };
}

function hostPid(e: Env, launch: LaunchId): { pid: number; startTime: number; bootId: string } {
  return readJson<{ pid: number; startTime: number; bootId: string }>(join(e.root, 'pids', `${launch}.pid`))!;
}

describe('§14 item 3: stops', { skip: unitSkip, timeout: 180_000 }, () => {
  test('a host suspended (SIGSTOP) before it submits its result; the stop takes effect; after resume its publication is refused', async () => {
    const e = makeEnv('sigstop');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    try {
      await s.start();
      // the host submits its result only when it is told to end (SIGTERM), then exits 0
      const t = s.submit(hostTask(e, { task: 'seat', job: { goFile: join(e.root, 'never'), submit: 'sigterm', seat: true, seatStatus: 'handed-back', pidDir: join(e.root, 'pids') }, unit: { stopGraceMs: 20_000 } }));
      const launch = await waitFor(() => t.launches[0], 20_000, 'launched');
      await waitFor(() => readJson(join(e.root, 'pids', `${launch}.pid`)), 15_000, 'host pid');
      const host = hostPid(e, launch);
      process.kill(host.pid, 'SIGSTOP');
      const sent = sendStop(stopPaths(e), stopReq('stop-sigstop'));
      assert.equal(sent.spooled, true);
      assert.equal(sent.notice, undefined, 'persisted');
      await waitFor(() => l.svc.activeStopIds().includes(id<StopId>('stop-sigstop')), 10_000, 'stop committed');
      // the stop is in force while the host is suspended; now it resumes and hands back
      process.kill(host.pid, 'SIGCONT');
      await waitFor(() => l.svc.dispositionFor(launch), 30_000, 'final disposition');
      assert.equal(l.svc.dispositionFor(launch), 'cancelled', 'not accepted: refused under the stop');
      assert.ok(l.svc.pendingResults(launch).some((r) => r.kind === 'seat.result'), 'the result arrived (after the stop) and is kept in quarantine');
      const kinds = readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, 0 as never).map((c) => c.record.kind);
      assert.ok(!kinds.includes('seat.result') && !kinds.includes('claude-code.exit'), 'nothing of it was published');
      await assert.doesNotReject(async () => {
        const r = await l.svc.dispose({ gen: s.gen, launch, disposition: 'accepted', reason: 'try again' });
        assert.equal(r.changed, false);
        assert.equal(r.disposition, 'cancelled');
      });
      assert.equal(t.state, 'needs-disposition');
      assert.equal(t.disposition, 'stop');
      assert.equal(await s.restartQuarantined(t.spec.task, 'restart'), null, 'a result quarantined by a stop is never restarted (v42)');
      // the report is rewritten on every pass; "stopped" needs ended processes and done cleanup,
      // not the disposition, so wait for the pass that also shows it
      const report = await waitFor(() => {
        const r = s.cp.stopReport(id<StopId>('stop-sigstop'));
        return r?.state === 'stopped' && r.units[0]?.disposition === 'cancelled' ? r : null;
      }, 30_000, 'stopped');
      assert.equal(report.units.length, 1);
      assert.deepEqual(report.units[0], { launch, unitName: report.units[0]!.unitName, processesEnded: true, cleanup: 'done', disposition: 'cancelled' });
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('the ledger service stuck in an action: the watchdog restarts it within seconds; the stop still takes effect and ends the units in scope', async () => {
    const e = makeEnv('stuck');
    const hang = join(e.root, 'hang');
    const sys = await startWatched(e, { hangFile: hang });
    try {
      await sys.rpc.call('submit', { spec: hostTask(e, { task: 'long', job: { goFile: join(e.root, 'never'), seat: true } }) });
      const launch = (await waitFor(async () => (await rpcTask(sys.rpc, 'long'))?.launches[0], 20_000, 'launched')) as LaunchId;
      await waitFor(async () => (await rpcTask(sys.rpc, 'long'))?.state === 'running', 10_000, 'running');
      const ledgerPid = sys.w.pidOf('ledger');
      // a request gets the service stuck inside its action
      writeFileSync(hang, '');
      const c = new LedgerClient(e.socket, 60_000);
      void c.call('appendRecords', { op: 'stuck-op', gen: null, records: [] }).catch(() => undefined);
      const t0 = Date.now();
      const sent = sendStop(stopPaths(e), stopReq('stop-stuck'));
      assert.equal(sent.durable, true);
      await waitFor(() => sys.w.pidOf('ledger') !== ledgerPid && sys.w.stateOf('ledger') === 'running', 20_000, 'ledger restarted by the watchdog');
      const q = new LedgerClient(e.socket, 2_000);
      await waitFor(async () => ((await q.call('activeStops', {})) as Array<{ stop: string }>).some((x) => x.stop === 'stop-stuck'), 15_000, 'stop committed by the new service');
      q.close();
      assert.ok(Date.now() - t0 < 15_000, `committed within seconds (${Date.now() - t0} ms)`);
      const cp = new ControlPlane(e.cp);
      assert.ok(cp.alerts().some((a) => a.category === 'service-restarted' && a.wi === 'WI-22' && /heartbeat lost/.test(String(a.trigger))), 'the restart raised a WI-22 notice');
      await waitFor(() => unitInactive(`mp-unit-${launch}.service`), 30_000, 'the unit in scope ended');
      const report = await waitFor(() => (cp.stopReport(id<StopId>('stop-stuck'))?.state === 'stopped' ? cp.stopReport(id<StopId>('stop-stuck')) : null), 40_000, 'stopped report');
      assert.equal(report.units[0]?.launch, launch);
      c.close();
    } finally {
      await sys.close();
    }
  });

  test('a storage fault: the stop goes through the inbox and the control plane, processes in scope are killed without the ledger, and the stop is the first thing committed after recovery', async () => {
    const e = makeEnv('storage');
    const fault = join(e.root, 'fault');
    const sys = await startWatched(e, { faultFile: fault }, { storageFault: { maxRestarts: 3, backoffMs: [2_500, 2_500, 2_500], healthyResetMs: 3_000 } });
    try {
      await sys.rpc.call('submit', { spec: hostTask(e, { task: 'long', job: { goFile: join(e.root, 'never'), seat: true } }) });
      const launch = (await waitFor(async () => (await rpcTask(sys.rpc, 'long'))?.launches[0], 20_000, 'launched')) as LaunchId;
      await waitFor(async () => (await rpcTask(sys.rpc, 'long'))?.state === 'running', 10_000, 'running');
      const q = new LedgerClient(e.socket, 2_000);
      const stopState = async (stop: string): Promise<string | null> => (await q.call('stopState', { stop })) as string | null;
      writeFileSync(fault, '');
      const cp = new ControlPlane(e.cp);
      await waitFor(() => cp.readLedgerHeartbeat()?.storageFault, 5_000, 'ledger reports the storage fault');
      const headBefore = readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, 0 as never).at(-1)!.revision;
      const sent = sendStop(stopPaths(e), stopReq('stop-storage'));
      assert.equal(sent.spooled, true);
      // ended through the control plane while the ledger cannot commit anything
      await waitFor(() => unitInactive(`mp-unit-${launch}.service`), 20_000, 'the unit in scope ended during the fault');
      assert.equal(await stopState('stop-storage'), null, 'not committed yet');
      const r1 = await waitFor(() => cp.stopReport(id<StopId>('stop-storage')), 10_000, 'a report');
      assert.equal(r1.state, 'not-committed');
      // the storage recovers; the watchdog's next restart commits the stop before anything else
      rmSync(fault);
      await waitFor(async () => {
        try {
          return (await stopState('stop-storage')) !== null;
        } catch {
          return false;
        }
      }, 20_000, 'committed after recovery');
      const after = readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, headBefore);
      assert.equal(after[0]?.record.kind, 'stop.committed', `first record after the fault: ${after.slice(0, 3).map((c) => c.record.kind).join(', ')}`);
      assert.equal((after[0]?.record as { stop: string }).stop, 'stop-storage');
      assert.ok(sys.w.faultRestarts() >= 1);
      await waitFor(() => cp.stopReport(id<StopId>('stop-storage'))?.state === 'stopped', 40_000, 'stopped');
      q.close();
    } finally {
      await sys.close();
    }
  });

  test('a storage fault, then a stop, then a reboot: recovery pause, no dispatch, old intents not resumed; resuming needs the user', async () => {
    const e = makeEnv('reboot');
    const fault = join(e.root, 'fault');
    const bootFile = join(e.root, 'boot-id');
    writeFileSync(bootFile, 'boot-A');
    let lp = new LedgerProc(e, { faultFile: fault, bootIdFile: bootFile });
    await lp.start();
    const s1 = newScheduler(e);
    let s2 = null as ReturnType<typeof newScheduler> | null;
    try {
      await s1.start();
      await s1.ledger.setMission(M, 'open');
      // the PM's prompt hook books the user's message (用户原话)
      const hook = new LedgerClient(e.socket, 5_000);
      await hook.call('recordUserWords', { message: 'msg-1', session: 'pm-1', at: Date.now(), text: '停下 (booked by the hook)' });
      hook.close();
      const intent = 'intent-ref-1';
      await s1.ledger.authorize({ op: 'auth-1', gen: s1.gen, launch: null, intent, kind: 'git-ref', domain: 'ref:refs/mission-pipeline/delivered/m/1', tag: { mission: M, capabilities: [] }, details: { ref: 'x' } });
      const t = s1.submit(hostTask(e, { task: 'long', job: { goFile: join(e.root, 'never'), seat: true } }));
      const oldLaunch = await waitFor(() => t.launches[0], 20_000, 'launched');
      writeFileSync(fault, '');
      await waitFor(() => new ControlPlane(e.cp).readLedgerHeartbeat()?.storageFault, 5_000, 'fault');
      assert.equal(sendStop(stopPaths(e), stopReq('stop-reboot')).durable, true);
      // the machine reboots: every process dies, the memory filesystem is gone, the boot id changes
      s1.abandon();
      await lp.kill('SIGKILL');
      const { killUnitAndCgroup } = await import('./scheduler-fixtures.ts');
      await killUnitAndCgroup(`mp-unit-${oldLaunch}.service`);
      rmSync(e.cp, { recursive: true, force: true });
      mkdirSync(e.cp, { recursive: true });
      writeFileSync(bootFile, 'boot-B');
      rmSync(fault);
      lp = new LedgerProc(e, { bootIdFile: bootFile });
      await lp.start();
      assert.equal(lp.ready?.recoveryPause, true, 'the service starts in recovery pause');
      assert.deepEqual(lp.ready?.stopsCommitted, ['stop-reboot'], 'the stop from the durable inbox is committed first');
      s2 = newScheduler(e);
      await s2.start();
      assert.equal(s2.paused, true);
      const headAt = readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, 0 as never).at(-1)!.revision;
      const t2 = s2.submit(hostTask(e, { task: 'new-work', mission: id<MissionId>('mission-other') }));
      for (let i = 0; i < 4; i++) await s2.tick();
      assert.equal(t2.launches.length, 0, 'no dispatch during the recovery pause');
      assert.match(s2.cp.status()?.dispatchPaused ?? '', /recovery pause/);
      const later = readRecords(ledgerPaths(e.ledgerRoot, e.cp).db, headAt).map((c) => c.record.kind);
      assert.ok(!later.includes('launch.registered'), 'no launch registered');
      assert.ok(!later.includes('intent.authorized') && !later.includes('intent.state'), 'no intent authorized or resumed');
      assert.equal((await s2.ledger.intentInfo(intent))?.state, 'authorized', 'the old intent stays unsettled');
      await assert.rejects(s2.ledger.authorize({ op: 'auth-2', gen: s2.gen, launch: null, intent: 'intent-2', kind: 'git-ref', domain: 'ref:other', tag: { mission: id<MissionId>('mission-other'), capabilities: [] }, details: {} }), /RECOVERY_PAUSED/);
      const report = await waitFor(() => s2!.cp.stopReport(id<StopId>('stop-reboot')), 10_000, 'stop report after the restart');
      assert.ok(report.undeterminedActions.some((a) => a.intent === intent), 'the pending action is listed as started before the stop, outcome undetermined');
      // WI-12 (v42): the stop record cannot be confirmed complete: the PM is told to ask the user
      const notice = await waitFor(() => s2!.cp.alerts().find((a) => a.category === 'recovery-pause'), 10_000, 'WI-12 notice');
      assert.equal(notice.wi, 'WI-12');
      assert.match(notice.defaultAction ?? '', /asks the user/);
      const check = await s2.recoveryCheck();
      assert.equal(check.paused, true);
      assert.equal(check.startup?.state, 'set');
      assert.equal(check.startup?.basis.evidence, 'abnormal-stop-no-spare-inbox');
      // committed first at the start (its inbox slot is reclaimed once the decision is recorded)
      assert.ok(check.committedStops.some((x) => x.stop === 'stop-reboot'), 'the stop from the inbox is committed');
      assert.deepEqual(check.uncommittedStops, [], 'nothing left uncommitted in the inboxes');
      assert.equal(check.lastUserWords?.excerpt, '停下 (booked by the hook)');
      assert.deepEqual(check.pendingIntents.map((i) => i.intent), [intent], 'the unsettled action is listed for verification');
      // the user answered that nothing else was said; the PM records it: work resumes
      await s2.confirmResume();
      await waitFor(async () => {
        await s2!.tick();
        return t2.state === 'done';
      }, 30_000, 'dispatched after the user confirmed');
    } finally {
      await s2?.close();
      s1.abandon();
      await lp.kill('SIGTERM');
    }
  });

  test('a git subprocess that cannot be ended: the service keeps handling stops and unrelated requests; the stop report lists the action and the process', async () => {
    const e = makeEnv('gitstuck');
    const l = inProcessLedger(e);
    // a real git process waiting on its input; the injected process control cannot end it (as in
    // uninterruptible disk I/O, which needs root or a hanging FUSE mount to produce for real)
    const git = spawn('/usr/bin/git', ['cat-file', '--batch'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const gitId = processIdentity(git.pid!)!;
    const stuck: ProcessControl = {
      alive: (x) => systemProcesses.alive(x),
      kill: (x, sig) => (x.pid === gitId.pid ? { sent: true, error: null } : systemProcesses.kill(x, sig)),
    };
    const s = newScheduler(e, { stops: { stopTimeoutMs: 1_000, unkillableAfterMs: 1_500 } }, { processes: stuck });
    try {
      await s.start();
      const tag = { mission: M, capabilities: [] };
      await s.ledger.authorize({ op: 'land-1', gen: s.gen, launch: null, intent: 'land-1', kind: 'git-push', domain: 'worktree:/repo', tag, details: { branch: 'main' } });
      await s.ledger.markIntentPendingVerify('land-1', { pid: gitId.pid, startTime: String(gitId.startTime), bootId: gitId.bootId });
      sendStop(stopPaths(e), stopReq('stop-git'));
      await waitFor(() => l.svc.activeStopIds().includes(id<StopId>('stop-git')), 10_000, 'the stop is committed while the action is unsettled');
      // unrelated requests go on; the same conflict domain stays closed until verified
      await s.ledger.authorize({ op: 'other-1', gen: s.gen, launch: null, intent: 'other-1', kind: 'git-ref', domain: 'ref:elsewhere', tag: { mission: id<MissionId>('mission-other'), capabilities: [] }, details: {} });
      await s.ledger.appendRecords('unrelated-1', null, []);
      await assert.rejects(s.ledger.authorize({ op: 'land-2', gen: s.gen, launch: null, intent: 'land-2', kind: 'git-push', domain: 'worktree:/repo', tag: { mission: id<MissionId>('mission-other'), capabilities: [] }, details: {} }), /DOMAIN_BUSY/);
      const report = await waitFor(() => {
        const r = s.cp.stopReport(id<StopId>('stop-git'));
        return r?.state === 'stop-effective-unkillable' ? r : null;
      }, 20_000, 'unkillable report');
      assert.match(report.summary, /stop effective, 1 process cannot be ended/);
      assert.equal(report.unkillable[0]?.pid, gitId.pid);
      assert.equal(report.unkillable[0]?.intent, 'land-1');
      assert.deepEqual(report.undeterminedActions.map((a) => a.intent), ['land-1']);
      assert.ok(isProcessAlive(gitId));
      assert.ok(s.cp.alerts().some((a) => a.category === 'stop-unkillable'));
      // once the process is really gone the stop can be reported stopped; the action stays listed
      git.kill('SIGKILL');
      const r2 = await waitFor(() => (s.cp.stopReport(id<StopId>('stop-git'))?.state === 'stopped' ? s.cp.stopReport(id<StopId>('stop-git')) : null), 20_000, 'stopped');
      assert.deepEqual(r2.undeterminedActions.map((a) => a.intent), ['land-1']);
    } finally {
      git.kill('SIGKILL');
      await s.close();
      await l.close();
    }
  });

  test('"stopped" is reported only after the processes ended AND the cleanup is done', async () => {
    const e = makeEnv('stoppedlast');
    const l = inProcessLedger(e);
    const s = newScheduler(e);
    const locked = join(e.scratch, 'locked');
    const resource = join(locked, 'area');
    mkdirSync(resource, { recursive: true });
    writeFileSync(join(resource, 'f'), 'x');
    chmodSync(locked, 0o555); // the area cannot be removed yet
    try {
      await s.start();
      const t = s.submit(hostTask(e, { task: 'u', job: { goFile: join(e.root, 'never'), seat: true }, unit: { cleanup: { paths: [resource] } } }));
      const launch = await waitFor(() => t.launches[0], 20_000, 'launched');
      await waitFor(() => s.cp.readHostHeartbeat(launch), 15_000, 'running');
      sendStop(stopPaths(e), stopReq('stop-last'));
      const seen: StopReport[] = [];
      await waitFor(() => {
        const r = s.cp.stopReport(id<StopId>('stop-last'));
        if (r) seen.push(r);
        return r?.units[0]?.processesEnded === true && l.svc.cleanupState(launch) === 'pending' ? r : null;
      }, 30_000, 'processes ended, cleanup still pending');
      for (let i = 0; i < 3; i++) await s.tick();
      const mid = s.cp.stopReport(id<StopId>('stop-last'))!;
      assert.equal(mid.state, 'stopping', 'not "stopped" while the cleanup is pending');
      assert.equal(mid.units[0]?.cleanup, 'pending');
      chmodSync(locked, 0o755);
      const done = await waitFor(() => (s.cp.stopReport(id<StopId>('stop-last'))?.state === 'stopped' ? s.cp.stopReport(id<StopId>('stop-last')) : null), 30_000, 'stopped');
      assert.equal(l.svc.cleanupState(launch), 'done');
      assert.ok(seen.every((r) => r.state !== 'stopped'), 'never reported stopped before');
      assert.equal(done.units[0]?.processesEnded, true);
    } finally {
      chmodSync(locked, 0o755);
      await s.close();
      await l.close();
    }
  });
});
