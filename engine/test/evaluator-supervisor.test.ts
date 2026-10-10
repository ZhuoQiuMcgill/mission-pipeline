// The evaluator as a supervised process (6.1; 14.4): published state served over
// its socket, deadlines, the failure budget, one rebuild, then the fault state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { LedgerService, ledgerPaths } from '../src/ledger/service.ts';
import { serveLedger } from '../src/ledger/ipc.ts';
import { readRecords } from '../src/ledger/store.ts';
import { RpcClient } from '../src/common/rpc.ts';
import { EvaluatorSupervisor, probeMemoryScope, type EvaluatorSupervisorOptions, type SupervisorLedgerPort, type WorkerFailure } from '../src/evaluator/supervisor.ts';
import { readCheckpointSummary, summaryPath } from '../src/evaluator/checkpoint.ts';
import type { WorkerConfig } from '../src/evaluator/worker-main.ts';
import { resolveRecord } from '../src/evaluator/evaluator.ts';
import { fullCompute } from '../src/evaluator/semantics.ts';
import { revision } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';

interface HarnessOptions {
  readonly deadlineMs?: number;
  readonly worker?: Partial<EvaluatorSupervisorOptions['worker']>;
  readonly sup?: Partial<Omit<EvaluatorSupervisorOptions, 'worker' | 'ledger'>>;
  readonly env?: Record<string, string>;
}

async function harness(fault: string, opt: number | HarnessOptions = 20_000) {
  const o: HarnessOptions = typeof opt === 'number' ? { deadlineMs: opt } : opt;
  const dir = mkdtempSync(join(tmpdir(), 'mp-evsup-'));
  const paths = ledgerPaths(join(dir, 'ledger'), join(dir, 'control'));
  const svc = new LedgerService({ paths });
  svc.open();
  const ledgerSock = join(dir, 'ledger.sock');
  const server = serveLedger(svc, ledgerSock);
  const gen = Number(await svc.beginGeneration());
  const checkpointPath = join(dir, 'evaluator.checkpoint');
  const sup = new EvaluatorSupervisor({
    worker: {
      dbPath: paths.db,
      contentRoot: paths.content,
      ledgerSocket: ledgerSock,
      querySocket: join(dir, 'evaluator.sock'),
      checkpointPath,
      gen,
      pollMs: 20,
      checkpointEvery: 1,
      faultInjection: true,
      ...o.worker,
    },
    ledger: {
      recordEvaluatorFailure: (r) => svc.recordEvaluatorFailure({ op: r.op, gen: r.gen as never }),
      evaluatorHealth: async () => svc.evaluatorHealth(),
      setEvaluatorFault: (r, o) => svc.setEvaluatorFault(r, { gen: o.gen as never }),
      raiseAlert: (r) => svc.raiseAlert(r),
      putContent: (t) => svc.content.put(t),
    },
    deadlineMs: o.deadlineMs ?? 20_000,
    heapMb: 256,
    env: { ...process.env, MP_EVAL_FAULT: fault, ...o.env },
    ...o.sup,
  });
  const query = new RpcClient(join(dir, 'evaluator.sock'), 5000);
  return {
    svc,
    sup,
    query,
    checkpointPath,
    async cleanup() {
      query.close();
      await sup.stop();
      await new Promise<void>((r) => server.close(() => r()));
      svc.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every test is bounded: a wait for an event that never comes fails instead of hanging (F18). */
const T = { timeout: 120_000 };

let seq = 0;
async function seed(svc: LedgerService): Promise<void> {
  const L = (xs: string[]) => svc.content.putList(xs);
  const records: BaseRecord[] = [
    { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@1' as never },
    { kind: 'evidence', evidence: 'E1' as never, envLine: 'py' as never, envSnapshot: 'py@1' as never, runClass: 'closed', fields: { exit: '0' } },
    {
      kind: 'object.version', object: 'P' as never, objectKind: 'product', mission: 'm1' as never, module: null, content: svc.content.put('object content') as never,
      prerequisites: L([]), scope: { paths: ['src/p.ts'], taskType: 'construct' }, reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
    },
    {
      kind: 'judgment', judgment: 'J1' as never, review: 'reviewer', executor: 'reviewer', target: 'P' as never, verdict: 'pass',
      evidence: L(['E1']), bases: L([]), constraints: L([]), reliesOn: L([]), issues: [], revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [],
    },
  ];
  await svc.appendRecords({ op: `s-${++seq}`, gen: null, records });
}

async function until(cond: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('the evaluator process publishes and answers queries with the revision; it equals the full recomputation', T, async () => {
  const h = await harness('');
  try {
    await seed(h.svc);
    await h.sup.start();
    await until(() => h.svc.publicationFloor() === h.svc.head());
    const r = (await h.query.call('targets', { ids: ['P', 'nope'] })) as { revision: number; states: Record<string, { label: string } | null> };
    assert.equal(r.revision, h.svc.head());
    assert.equal(r.states.P?.label, 'proven');
    assert.equal(r.states.nope, null);
    const want = fullCompute(readRecords(h.svc.paths.db, revision(0)).map((c) => ({ revision: c.revision, record: resolveRecord(c.record, h.svc.content) })), revision(r.revision));
    assert.equal(want.targets.get('P')?.label, r.states.P?.label);
    // A new commit is picked up and published.
    await h.svc.appendRecords({ op: 'env2', gen: null, records: [{ kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@2' as never }] });
    await until(async () => ((await h.query.call('targets', { ids: ['P'] })) as { states: Record<string, { label: string }> }).states.P?.label === 'not-fully-proven');
    const sum = (await h.query.call('summary')) as { lag: number };
    assert.equal(sum.lag, 0);
  } finally {
    await h.cleanup();
  }
});

test('an update that always hangs: killed at its deadline, three failures, one rebuild, then the fault state with an alert and no more restarts (6.1, 14.4)', T, async () => {
  const h = await harness('hang', 600);
  try {
    await seed(h.svc);
    const faulted = once(h.sup, 'fault');
    const rebuilds: boolean[] = [];
    h.sup.on('spawn', (s: { rebuild: boolean }) => rebuilds.push(s.rebuild));
    await h.sup.start();
    await faulted;
    assert.deepEqual(rebuilds, [false, false, false, true], 'three ordinary starts, then exactly one rebuild');
    assert.equal(h.sup.state, 'fault');
    assert.equal(h.svc.evaluatorHealth().failures, 4, 'each failure counted once');
    assert.match(h.svc.evaluatorHealth().fault ?? '', /rebuild failed/);
    const alerts = readRecords(h.svc.paths.db, revision(0)).filter((c) => c.record.kind === 'alert');
    assert.equal(alerts.length, 1);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(h.sup.spawns, 4, 'no restart loop');
    // A new supervisor (e.g. after a scheduler restart) stays in the fault state until the user retries.
    const again = new EvaluatorSupervisor({ ...(h.sup as unknown as { opts: ConstructorParameters<typeof EvaluatorSupervisor>[0] }).opts });
    await again.start();
    assert.equal(again.state, 'fault');
    assert.equal(again.spawns, 0);
  } finally {
    await h.cleanup();
  }
});

test('an update that throws every time is counted once per failure, not twice (6.1)', T, async () => {
  const h = await harness('throw');
  try {
    await seed(h.svc);
    const faulted = once(h.sup, 'fault');
    await h.sup.start();
    await faulted;
    assert.equal(h.svc.evaluatorHealth().failures, 4);
  } finally {
    await h.cleanup();
  }
});

test('a crash in the middle of an update: the restarted process publishes the same state; success resets the budget (6.1, 14.4)', T, async () => {
  const h = await harness('crash-once');
  try {
    await seed(h.svc);
    const failures: string[] = [];
    h.sup.on('failure', (f: { cause: string }) => failures.push(f.cause));
    await h.sup.start();
    await until(() => h.svc.publicationFloor() === h.svc.head());
    assert.equal(failures.length, 1);
    assert.equal(h.svc.evaluatorHealth().failures, 0, 'reset by the successful publication');
    const r = (await h.query.call('targets', { ids: ['P'] })) as { states: Record<string, { label: string }> };
    assert.equal(r.states.P?.label, 'proven');
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------- core review r2: F13 (memory pool, deadlines)

/** Is a memory-limited user scope available here? Tests of the cap skip without one. */
const scopeReason = await probeMemoryScope('/usr/bin/systemd-run');

test('F13: the worker runs inside its own memory-limited scope and the IPC channel works through it', { ...T, skip: scopeReason ?? false }, async () => {
  const h = await harness('');
  try {
    await seed(h.svc);
    await h.sup.start();
    assert.equal(h.sup.memoryPool?.mode, 'cgroup');
    assert.equal(h.sup.degraded, false);
    await until(() => h.svc.publicationFloor() === h.svc.head());
    const sum = (await h.query.call('summary')) as { revision: number; process: { pid: number } };
    assert.equal(sum.revision, h.svc.head());
    assert.equal(sum.process.pid, h.sup.workerPid, 'the child is the worker itself (systemd-run exec()s it)');
    const cg = readFileSync(`/proc/${sum.process.pid}/cgroup`, 'utf8').trim().replace(/^0::/, '');
    assert.match(cg, /\.scope$/);
    const max = Number(readFileSync(`/sys/fs/cgroup${cg}/memory.max`, 'utf8'));
    assert.equal(max, h.sup.memoryPool!.memoryMb * 2 ** 20);
    assert.equal(readFileSync(`/sys/fs/cgroup${cg}/memory.swap.max`, 'utf8').trim(), '0');
  } finally {
    await h.cleanup();
  }
});

test('F13: memory outside the V8 heap beyond the pool kills the worker, and that is counted as a failure', { ...T, skip: scopeReason ?? false }, async () => {
  const h = await harness('alloc', { sup: { heapMb: 64, memoryMb: 192 }, env: { MP_EVAL_ALLOC_MB: '1024' } });
  try {
    await seed(h.svc);
    const failed = once(h.sup, 'failure') as Promise<[WorkerFailure]>;
    await h.sup.start();
    const [f] = await failed;
    assert.match(f.cause, /memory pool of 192 MiB was exceeded \(oom-kill during update\)/);
    assert.equal(f.phase, 'update');
    assert.ok(h.svc.evaluatorHealth().failures >= 1, 'recorded in the failure budget');
  } finally {
    await h.cleanup();
  }
  assert.deepEqual(leftoverScopes(), [], 'every worker scope is cleared after it ends');
});

/** Worker scopes of this test process still known to systemd (failed ones would linger). */
function leftoverScopes(): string[] {
  try {
    const out = execFileSync('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', `mp-evaluator-${process.pid}-*`], { encoding: 'utf8' });
    return out.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  } catch {
    return [];
  }
}

test('F13: a checkpoint write that hangs is killed at the deadline and counted', T, async () => {
  const h = await harness('checkpoint-hang', 800);
  try {
    await seed(h.svc);
    const failed = once(h.sup, 'failure') as Promise<[WorkerFailure]>;
    const t0 = Date.now();
    await h.sup.start();
    const [f] = await failed;
    assert.equal(f.phase, 'checkpoint');
    assert.match(f.cause, /deadline/);
    assert.ok(Date.now() - t0 < 10_000);
    assert.equal(h.svc.publicationFloor(), h.svc.head(), 'the publication itself happened before the checkpoint');
  } finally {
    await h.cleanup();
  }
});

test('F13: start-up and checkpoint restore are bounded by the deadline too', T, async () => {
  const h = await harness('');
  try {
    await seed(h.svc);
    const wrote = once(h.sup, 'checkpoint');
    await h.sup.start();
    await wrote;
    await h.sup.stop();
    assert.ok(existsSync(h.checkpointPath));
    // A new evaluator whose checkpoint restore hangs.
    const opts = (h.sup as unknown as { opts: EvaluatorSupervisorOptions }).opts;
    const again = new EvaluatorSupervisor({ ...opts, deadlineMs: 800, env: { ...process.env, MP_EVAL_FAULT: 'restore-hang' } });
    const failed = once(again, 'failure') as Promise<[WorkerFailure]>;
    await again.start();
    const [f] = await failed;
    await again.stop();
    assert.equal(f.phase, 'restore');
    assert.match(f.cause, /deadline/);
  } finally {
    await h.cleanup();
  }
});

test('F13/r3 F9: without a usable systemd scope the evaluator does not start: blocked, one WI-18 alert; only an accepted resource-limit degradation runs it heap-only', T, async () => {
  const h = await harness('', { sup: { systemdRunPath: '/nonexistent/systemd-run' } });
  try {
    await seed(h.svc);
    const blocked = once(h.sup, 'blocked');
    await h.sup.start();
    const [pool] = (await blocked) as [{ mode: string; reason: string }];
    assert.equal(pool.mode, 'unavailable');
    assert.match(pool.reason, /systemd-run/);
    assert.equal(h.sup.state, 'blocked');
    assert.equal(h.sup.spawns, 0, 'no evaluator without its hard memory cap');
    const alerts = () => readRecords(h.svc.paths.db, revision(0)).filter((c) => c.record.kind === 'alert').map((c) => c.record as { wi?: string; category: string });
    assert.deepEqual(alerts().map((a) => [a.category, a.wi]), [['platform-capability', 'WI-18']]);
    // A restarted supervisor in the same situation: the same alert operation, still one alert.
    const opts = (h.sup as unknown as { opts: EvaluatorSupervisorOptions }).opts;
    const again = new EvaluatorSupervisor(opts);
    await again.start();
    assert.equal(again.state, 'blocked');
    assert.equal(alerts().length, 1);
    // 'heap-only' configured without the accepted degradation is blocked too.
    const configured = new EvaluatorSupervisor({ ...opts, memoryPool: 'heap-only' });
    await configured.start();
    assert.equal(configured.state, 'blocked');
    assert.equal(configured.spawns, 0);
    // With the degradation accepted at install: heap-only, flagged degraded, and it publishes.
    const accepted = new EvaluatorSupervisor({ ...opts, acceptedDegradations: ['resource-limits'] });
    const degraded = once(accepted, 'degraded');
    await accepted.start();
    const [dpool] = (await degraded) as [{ mode: string }];
    assert.equal(dpool.mode, 'heap-only');
    assert.equal(accepted.degraded, true);
    await until(() => h.svc.publicationFloor() === h.svc.head());
    await accepted.stop();
    // 'cgroup' never runs heap-only, even with the degradation accepted.
    const strict = new EvaluatorSupervisor({ ...opts, memoryPool: 'cgroup', acceptedDegradations: ['resource-limits'] });
    await strict.start();
    assert.equal(strict.state, 'blocked');
    assert.equal(strict.spawns, 0);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------- core review r2: F14 (robustness)

/** A worker the test drives: exits when told, or when killed. */
class FakeWorker extends EventEmitter {
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = null;
  kill(sig: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signalCode = sig;
    setImmediate(() => this.emit('exit', null, sig));
    return true;
  }
  crash(code = 1): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

function fakeSupervisor(ledger: SupervisorLedgerPort, extra: Partial<EvaluatorSupervisorOptions> = {}): { sup: EvaluatorSupervisor; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const sup = new EvaluatorSupervisor({
    worker: { dbPath: 'x', contentRoot: 'x', ledgerSocket: 'x', querySocket: 'x', checkpointPath: 'x', gen: 1, pollMs: 20, checkpointEvery: 1, faultInjection: false },
    ledger,
    deadlineMs: 60_000,
    heapMb: 64,
    memoryPool: 'heap-only',
    acceptedDegradations: ['resource-limits'],
    retryMs: { min: 5, max: 20 },
    launch: (_cfg: WorkerConfig) => {
      const w = new FakeWorker();
      workers.push(w);
      return w as unknown as ChildProcess;
    },
    ...extra,
  });
  return { sup, workers };
}

/** A ledger port with a failure budget, whose calls can be made to fail or wait. */
/** A ledger port with a failure budget (deduplicated by operation id, as the ledger does), whose calls can be made to fail or wait. */
function fakeLedger() {
  const state = { failures: 0, fault: null as string | null, alerts: 0, ops: new Map<string, number>(), alertOps: new Set<string>() };
  const ctl = { failRecord: 0, failHealth: 0, loseReply: 0, gate: null as Promise<void> | null, entered: null as (() => void) | null };
  const port: SupervisorLedgerPort = {
    recordEvaluatorFailure: async ({ op }) => {
      ctl.entered?.();
      if (ctl.gate) await ctl.gate;
      if (ctl.failRecord > 0) {
        ctl.failRecord--;
        throw new Error('ledger unavailable');
      }
      let n = state.ops.get(op);
      if (n === undefined) state.ops.set(op, (n = ++state.failures));
      if (ctl.loseReply > 0) {
        ctl.loseReply--;
        throw new Error('the reply was lost after the commit');
      }
      return n;
    },
    evaluatorHealth: async () => {
      if (ctl.failHealth > 0) {
        ctl.failHealth--;
        throw new Error('ledger unavailable');
      }
      return { failures: state.failures, fault: state.fault };
    },
    setEvaluatorFault: async (r) => void (state.fault = r),
    raiseAlert: async (r) => {
      if (state.alertOps.has(r.op)) return;
      state.alertOps.add(r.op);
      state.alerts++;
    },
    putContent: () => '0'.repeat(64) as never,
  };
  return { state, ctl, port };
}

function noUnhandledRejections(): { readonly seen: unknown[]; done(): void } {
  const seen: unknown[] = [];
  const on = (e: unknown): void => void seen.push(e);
  process.on('unhandledRejection', on);
  return { seen, done: () => void process.off('unhandledRejection', on) };
}

test('F14: stop() while an exit is being recorded never leads to a restart (the reviewer\'s interleaving)', T, async () => {
  const { state, ctl, port } = fakeLedger();
  const { sup, workers } = fakeSupervisor(port);
  const guard = noUnhandledRejections();
  try {
    await sup.start();
    assert.equal(workers.length, 1);
    let release!: () => void;
    ctl.gate = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (ctl.entered = r));
    workers[0]!.crash(1);
    await entered; // the supervisor is waiting for the ledger to record the failure
    await sup.stop();
    release();
    await sup.flushed();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(state.failures, 1, 'the failure is still recorded');
    assert.equal(workers.length, 1, 'no restart after stop()');
    assert.equal(sup.state, 'stopped');
    assert.deepEqual(guard.seen, []);
  } finally {
    guard.done();
    await sup.stop();
  }
});

test('F14: a ledger that fails while an exit is handled: no unhandled rejection; the failure is kept, recorded once the ledger is back, then the worker restarts', T, async () => {
  const { state, ctl, port } = fakeLedger();
  const { sup, workers } = fakeSupervisor(port);
  const guard = noUnhandledRejections();
  const ledgerErrors: unknown[] = [];
  sup.on('ledger-error', (e: unknown) => ledgerErrors.push(e));
  try {
    await sup.start();
    ctl.failRecord = 3;
    ctl.failHealth = 1;
    const respawned = new Promise<void>((r) => sup.on('spawn', () => workers.length === 2 && r()));
    workers[0]!.crash(1);
    await respawned;
    assert.equal(state.failures, 1, 'recorded exactly once');
    assert.equal(sup.unrecordedFailures, 0);
    assert.ok(ledgerErrors.length >= 4, `ledger errors seen: ${ledgerErrors.length}`);
    assert.equal(workers.length, 2);
    assert.deepEqual(guard.seen, []);
  } finally {
    guard.done();
    await sup.stop();
  }
});

test('F14: a failure that could not be recorded before stop() is recorded once the ledger is back, without a restart', T, async () => {
  const { state, ctl, port } = fakeLedger();
  const { sup, workers } = fakeSupervisor(port);
  const guard = noUnhandledRejections();
  try {
    await sup.start();
    ctl.failRecord = 1_000_000; // down
    workers[0]!.crash(1);
    await until(() => sup.unrecordedFailures === 1 && !(sup as unknown as { flushing: unknown }).flushing);
    await sup.stop();
    assert.equal(sup.unrecordedFailures, 1);
    ctl.failRecord = 0; // back
    await until(() => state.failures === 1, 5000);
    assert.equal(sup.unrecordedFailures, 0);
    assert.equal(workers.length, 1);
    assert.deepEqual(guard.seen, []);
  } finally {
    guard.done();
    await sup.stop();
  }
});

test('F14: start() with the ledger unreachable retries instead of rejecting; a throwing listener does not break supervision', T, async () => {
  const { ctl, port } = fakeLedger();
  const { sup, workers } = fakeSupervisor(port);
  const guard = noUnhandledRejections();
  sup.on('spawn', () => {
    throw new Error('a listener bug');
  });
  try {
    ctl.failHealth = 2;
    await sup.start();
    assert.equal(workers.length, 0, 'nothing started while the fault state is unknown');
    await until(() => workers.length === 1, 5000);
    assert.equal(sup.state, 'running');
    assert.deepEqual(guard.seen, []);
  } finally {
    guard.done();
    await sup.stop();
  }
});

test('F14: the rebuild failing enters the fault state once, with a WI-11 alert, even when the ledger fails in between', T, async () => {
  const { state, ctl, port } = fakeLedger();
  const alerts: Array<{ wi?: string; category: string }> = [];
  const { sup, workers } = fakeSupervisor({ ...port, raiseAlert: async (r) => void alerts.push(r) });
  const guard = noUnhandledRejections();
  try {
    state.failures = 3; // the next start is the one rebuild
    const faulted = once(sup, 'fault');
    await sup.start();
    ctl.failHealth = 1;
    workers[0]!.crash(1);
    await faulted;
    assert.equal(sup.state, 'fault');
    assert.match(state.fault ?? '', /rebuild failed/);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.wi, 'WI-11');
    assert.equal(workers.length, 1, 'no restart after the rebuild failed');
    assert.deepEqual(guard.seen, []);
  } finally {
    guard.done();
    await sup.stop();
  }
});

// ---------------------------------------------------------------- core review r2: F22 (checkpoints in the process)

test('F22: the worker writes a checkpoint and its summary after the interval even when the count is not reached', T, async () => {
  const h = await harness('', { worker: { checkpointEvery: 1_000_000, checkpointIntervalMs: 300 } });
  try {
    await seed(h.svc);
    const wrote = once(h.sup, 'checkpoint') as Promise<[{ trigger: string; revision: number }]>;
    await h.sup.start();
    const [cp] = await wrote;
    assert.equal(cp.trigger, 'interval');
    assert.equal(cp.revision, h.svc.head());
    const sum = readCheckpointSummary(h.checkpointPath);
    assert.ok(sum);
    assert.equal(sum.revision, h.svc.head());
    assert.equal(sum.targets.labels.proven, 1);
    assert.deepEqual(sum.judgments, { total: 1, current: 1, notCurrent: 0 });
    assert.ok(Date.parse(sum.writtenAt) > Date.now() - 60_000);
    assert.ok(existsSync(summaryPath(h.checkpointPath)));
  } finally {
    await h.cleanup();
  }
});

test('F22: with checkpointEvery 1 the worker writes after the first publication (count trigger)', T, async () => {
  const h = await harness('', { worker: { checkpointEvery: 1 } });
  try {
    await seed(h.svc);
    const wrote = once(h.sup, 'checkpoint') as Promise<[{ trigger: string; revision: number }]>;
    await h.sup.start();
    const [cp] = await wrote;
    assert.equal(cp.trigger, 'count');
    assert.equal(readCheckpointSummary(h.checkpointPath)?.revision, cp.revision);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------- core review r3: F4 (restore on a quiet ledger), F20 (disk pool)

test('r3 F4: a worker restarted from a checkpoint that caught up with a quiet ledger publishes (no NOT_READY forever)', T, async () => {
  const h = await harness('');
  try {
    await seed(h.svc);
    const wrote = once(h.sup, 'checkpoint');
    await h.sup.start();
    await wrote;
    await h.sup.stop();
    const head = h.svc.head();
    // Restart: the checkpoint holds everything; nothing new is committed.
    const opts = (h.sup as unknown as { opts: EvaluatorSupervisorOptions }).opts;
    const again = new EvaluatorSupervisor(opts);
    const restored = once(again, 'restore') as Promise<[boolean]>;
    const published = once(again, 'published') as Promise<[number]>;
    await again.start();
    assert.equal((await restored)[0], true, 'the checkpoint was used');
    assert.equal((await published)[0], head, 'published without any new record');
    const sum = (await h.query.call('summary')) as { revision: number | null; lag: number };
    assert.equal(sum.revision, head);
    assert.equal(sum.lag, 0);
    await again.stop();
  } finally {
    await h.cleanup();
  }
});

test('r3 F20: a disk pool too small for the checkpoints pauses writes with one WI-11 alert; publication goes on', T, async () => {
  const h = await harness('', { worker: { checkpointEvery: 1, checkpointPoolBytes: 64 } });
  try {
    await seed(h.svc);
    const paused = once(h.sup, 'checkpoint-paused') as Promise<[{ reason: string; poolBytes: number; newBytes: number }]>;
    await h.sup.start();
    const [p] = await paused;
    assert.match(p.reason, /disk pool \(64 bytes\) cannot hold/);
    assert.ok(p.newBytes > 64);
    await until(() => h.svc.publicationFloor() === h.svc.head());
    assert.equal(existsSync(h.checkpointPath), false, 'nothing written');
    const poolAlerts = () => readRecords(h.svc.paths.db, revision(0)).filter((c) => c.record.kind === 'alert' && (c.record as { category: string }).category === 'evaluator-resource-pool');
    await until(() => poolAlerts().length === 1);
    assert.equal((poolAlerts()[0]!.record as { wi?: string }).wi, 'WI-11');
    // More publications while the shortage lasts: no second alert.
    await h.svc.appendRecords({ op: 'pool-more', gen: null, records: [{ kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@2' as never }] });
    await until(() => h.svc.publicationFloor() === h.svc.head());
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(poolAlerts().length, 1);
  } finally {
    await h.cleanup();
  }
});

test('r3 F20: a full disk (ENOSPC) pauses checkpoint writes the same way', T, async () => {
  const h = await harness('checkpoint-enospc', { worker: { checkpointEvery: 1 } });
  try {
    await seed(h.svc);
    const paused = once(h.sup, 'checkpoint-paused') as Promise<[{ reason: string }]>;
    await h.sup.start();
    const [p] = await paused;
    assert.match(p.reason, /disk is full/);
    await until(() => h.svc.publicationFloor() === h.svc.head());
    assert.equal(h.sup.state, 'running', 'not a failure: the evaluator keeps publishing');
    assert.equal(h.svc.evaluatorHealth().failures, 0);
  } finally {
    await h.cleanup();
  }
});

test('a supervisor whose scheduler generation was superseded stops instead of retrying forever (6.3, r3 #7)', T, async () => {
  const { state, port } = fakeLedger();
  let calls = 0;
  const stale: SupervisorLedgerPort = {
    ...port,
    recordEvaluatorFailure: async () => {
      calls++;
      throw Object.assign(new Error('generation 1 is not the current scheduler generation'), { code: 'STALE_GENERATION' });
    },
  };
  const { sup, workers } = fakeSupervisor(stale);
  const guard = noUnhandledRejections();
  try {
    await sup.start();
    const superseded = once(sup, 'superseded');
    workers[0]!.crash(1);
    await superseded;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(calls, 1, 'no retries');
    assert.equal(workers.length, 1, 'no restart');
    assert.equal(sup.state, 'stopped');
    assert.equal(sup.unrecordedFailures, 0);
    assert.equal(state.failures, 0);
    assert.deepEqual(guard.seen, []);
  } finally {
    guard.done();
    await sup.stop();
  }
});
