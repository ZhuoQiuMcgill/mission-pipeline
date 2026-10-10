// The scheduler's integration with the seat hosts and the flows (2026-10-09 critical path):
// the seat host config carries the scheduler generation (a read-web seat's fetches are
// authorized with it); a 'materials' seat gets no writable area and no image; the flow engine
// is reconciled on every tick and after every accepted outcome, and composes over a real
// repository; a restarted scheduler knows every task it ran (never "unknown").

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { id, type LaunchId } from '../src/common/ids.ts';
import type { GateVerdict } from '../src/exec/selfcheck.ts';
import type { LaunchSupervisorOptions } from '../src/exec/supervisor.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { composeFlow } from '../src/scheduler/flow.ts';
import { writeLaunchMeta } from '../src/scheduler/launches.ts';
import type { SeatInstall } from '../src/scheduler/seats.ts';
import { systemUnits, type UnitControl } from '../src/scheduler/units.ts';
import { cleanupEnvs, hostTask, inProcessLedger, M, makeEnv, newScheduler, waitFor, type Env } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

const MiB = 1024 * 1024;
const PASS: GateVerdict = { seatsAllowed: true, moneyModeAllowed: true, key: 'test-key', missing: [], failed: [], reason: null };

function capturing(): { units: UnitControl; launched: LaunchSupervisorOptions[] } {
  const launched: LaunchSupervisorOptions[] = [];
  return { launched, units: { ...systemUnits, launch: async (o) => (launched.push(o), { pid: 0 } as never), activeState: async () => 'active' } };
}

function install(e: Env): SeatInstall {
  return { selfCheckDir: join(e.root, 'selfcheck'), credentials: { kind: 'fake-api-key', key: 'sk-test' }, geometry: { blockBytes: 4096 }, fuse2fs: '/nonexistent/fuse2fs', privateFuseMount: false };
}

function seatTask(e: Env, task: string, kind: string, areaBytes: number) {
  const base = hostTask(e, { task, job: { seat: true } });
  const card = new ContentStore(join(e.ledgerRoot, 'content')).put(JSON.stringify({ format: 'mp4.seat-card.v1', launch: 'template', seat: kind, mission: M }));
  const demand = { hostBytes: 200 * MiB, runPeakBytes: 0, runParallelism: 1, areaBytes, enclosureBytes: 64 * MiB, exportCaps: { maxLogicalBytes: MiB, maxFiles: 10 }, recoveryState: null };
  return { ...base, seat: { card, demand }, unit: { ...base.unit, seatUnit: true, heartbeat: true } };
}

describe('scheduler integration (seat hosts, flows, restarts)', { timeout: 120_000 }, () => {
  test('the seat host config names the scheduler generation; a materials seat (Secretary) gets no area and no image, even when large-disk tools are missing', async () => {
    const e = makeEnv('int-seat');
    const l = inProcessLedger(e);
    const cap = capturing();
    const s = newScheduler(e, { seats: install(e) }, { selfCheck: () => PASS, units: cap.units });
    try {
      const gen = await s.start({ startLoops: false });
      const t = s.submit(seatTask(e, 'sec', 'secretary', 512 * MiB));
      await waitFor(async () => {
        await s.tick();
        return cap.launched.length > 0;
      }, 20_000, 'unit start asked for');
      assert.notEqual(t.state, 'blocked', 'no area: no resource block for a materials seat');
      const host = JSON.parse(readFileSync(cap.launched[0]!.config.host.argv.at(-1)!, 'utf8')) as { generation: number; area: { kind: string } };
      assert.equal(host.generation, gen);
      assert.equal(host.area.kind, 'tmpfs');
      assert.equal(cap.launched[0]!.config.cleanup?.images, undefined, 'no image');
      // a file-tool seat with the same demand is resource-blocked here (no fuse2fs)
      const w = s.submit(seatTask(e, 'con', 'constructor', 512 * MiB));
      await s.tick();
      assert.equal(w.state, 'blocked');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('the flows are reconciled on every tick and after an accepted outcome', async () => {
    const e = makeEnv('int-flow');
    const l = inProcessLedger(e);
    const s = newScheduler(e, {}, { units: capturing().units });
    let calls = 0;
    try {
      await s.start({ startLoops: false });
      s.attachFlow({ reconcile: async () => void calls++ });
      await waitFor(() => calls >= 1, 5_000, 'reconciled when attached');
      const before = calls;
      await s.tick();
      assert.ok(calls > before, 'reconciled on the tick');
      // an accepted outcome (a program unit with its proof)
      const L = id<LaunchId>('LF');
      writeLaunchMeta(e.stateDir, { format: 'mp4.launch-meta.v1', launch: L, task: 'f', lineage: 'L-f', tag: { mission: M, capabilities: [] }, unitName: 'mp-unit-LF.service', seatUnit: false, heartbeat: false, gen: s.gen, dispatchedAt: Date.now(), timeoutMs: null, mode: 'stable' });
      await s.submitDurable(hostTask(e, { task: 'f', lineage: 'L-f' }));
      await l.svc.registerLaunch({ op: 'reg-LF', gen: s.gen, launch: L, tag: { mission: M, capabilities: [] } });
      await l.svc.dequeueTask({ op: 'dq-LF', gen: s.gen, task: 'f', reason: 'dispatched', launch: L });
      await l.svc.registerProof({ kind: 'termination.proof', launch: L, exit: { code: 0, signal: null }, controlOomKill: 0, unitOomKill: 0, unitOom: 0 } as never);
      const mid = calls;
      await (s as unknown as { reconcileRunner: { kick(): Promise<void> } }).reconcileRunner.kick();
      assert.equal(l.svc.dispositionFor(L), 'accepted');
      await waitFor(() => calls > mid, 5_000, 'reconciled after the accepted outcome');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('the flow engine composes over a real repository (createFlowEngine over schedulerFlowPorts) and reconciles', async () => {
    const e = makeEnv('int-compose');
    const l = inProcessLedger(e);
    const s = newScheduler(e, {}, { units: capturing().units });
    const repo = join(e.root, 'project');
    mkdirSync(repo);
    const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', HOME: e.root } }).toString();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'project\n');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'M0');
    try {
      await s.start({ startLoops: false });
      const flow = await composeFlow(s, { repo, workDir: join(e.root, 'flow-work'), userHome: e.root });
      assert.deepEqual(await flow.reconcile(), [], 'no mission has flow events yet');
      s.attachFlow(flow);
      await s.tick();
    } finally {
      await s.close();
      await l.close();
    }
  });
});

describe('closing a mission (6.6)', { timeout: 120_000 }, () => {
  test('production stops: queued tasks leave the queue, running ones are cancelled (unless the close waits for them); post-close audits still start; the resume answer is forwarded', async () => {
    const e = makeEnv('int-close');
    const l = inProcessLedger(e);
    const cap = capturing();
    const s = newScheduler(e, {}, { units: cap.units });
    try {
      await s.start({ startLoops: false });
      const running = await s.submitDurable(hostTask(e, { task: 'running' }));
      await s.tick();
      assert.equal(running.state, 'running');
      const launch = running.current!;
      // a second production task waits behind a stop
      await l.svc.stop({ stop: 'hold' as never, scope: { kind: 'capability', capability: 'held' }, words: 'hold', at: Date.now() });
      const queued = await s.submitDurable({ ...hostTask(e, { task: 'queued', capabilities: ['held'] }) });
      await s.tick();
      assert.equal(queued.state, 'queued');
      await l.svc.closeMission({ op: 'close-1', mission: M, mode: 'with-risk' });
      await s.tick();
      assert.equal(queued.state, 'abandoned', 'a queued production task is cancelled');
      assert.ok(!l.svc.taskQueue().some((q) => q.task === 'queued'), 'and leaves the ledger queue');
      // the running unit ends; its result is refused as cancelled
      await l.svc.registerProof({ kind: 'termination.proof', launch, exit: { code: 0, signal: null }, controlOomKill: 0, unitOomKill: 0, unitOom: 0 } as never);
      await s.tick();
      assert.equal(l.svc.dispositionFor(launch), 'cancelled');
      assert.equal(running.state, 'abandoned');
      // a post-close audit still starts
      const audit = await s.submitDurable({ ...hostTask(e, { task: 'audit' }), afterClose: 'audit' });
      await s.tick();
      assert.equal(audit.state, 'running');
      // a production task submitted after the close does not
      const late = await s.submitDurable(hostTask(e, { task: 'late' }));
      await s.tick();
      assert.equal(late.state, 'abandoned');
    } finally {
      await s.close();
      await l.close();
    }
  });

  test('a close that waits for running units: their results are accepted; WI-12 answer goes with the resume', async () => {
    const e = makeEnv('int-close-wait');
    const l = inProcessLedger(e);
    const cap = capturing();
    const s = newScheduler(e, {}, { units: cap.units });
    try {
      await s.start({ startLoops: false });
      const t = await s.submitDurable(hostTask(e, { task: 'finishing' }));
      await s.tick();
      const launch = t.current!;
      await l.svc.closeMission({ op: 'close-w', mission: M, mode: 'with-risk', waitRunning: true });
      await s.tick();
      await l.svc.registerProof({ kind: 'termination.proof', launch, exit: { code: 0, signal: null }, controlOomKill: 0, unitOomKill: 0, unitOom: 0 } as never);
      await s.tick();
      assert.equal(l.svc.dispositionFor(launch), 'accepted');
      // confirmResume forwards the PM's op and the user's answer (nothing to clear here)
      const calls: unknown[] = [];
      const client = s.ledger.client as unknown as { call(m: string, p: unknown): Promise<unknown> };
      const real = client.call.bind(client);
      client.call = async (m, p) => {
        if (m === 'confirmResume') calls.push(p);
        return real(m, p);
      };
      await s.confirmResume({ op: 'resume-1', answer: '没有要求停止' });
      assert.deepEqual(calls, [{ op: 'resume-1', answer: '没有要求停止' }]);
    } finally {
      await s.close();
      await l.close();
    }
  });
});
