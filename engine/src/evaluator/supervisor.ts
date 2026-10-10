// Supervision of the evaluator process (design 6.1 "求值器的失败、卡住与资源").
//
// Resource pool (core review r2 F13, r3 F9). The evaluator runs as a child
// process inside its own memory-limited cgroup: a transient systemd user scope
// (`systemd-run --user --scope -p MemoryMax=<pool> -p MemorySwapMax=0`), which
// exec()s node in place, so the child is the worker itself and the fork IPC
// channel passes through unchanged. The cap covers the whole process (heap,
// buffers, native memory), not only the V8 heap; the V8 heap limit stays as a
// cleaner first line. The hard cap is required (6.1): where no such scope works
// (no systemd user manager, no delegated memory controller, not Linux) the
// evaluator does not start — the supervisor enters 'blocked' and raises WI-18 —
// unless the user accepted the "resource-limit degradation" at install
// (`acceptedDegradations` includes 'resource-limits'); only then does it run
// with the heap limit alone, flagged degraded (`degraded`, the 'degraded' event).
//
// Deadlines (F13). Every phase of the worker reports (start-up, checkpoint
// restore, every update, every checkpoint write, idle polling with a heartbeat),
// and the supervisor kills the worker when no message arrives within the
// deadline. A missed deadline is a failure like any other.
//
// Failures. Every failure — a missed deadline, an abnormal exit, a memory kill —
// is recorded once in the ledger's failure budget, which counts failures since
// the last successful publication whatever their cause; each carries its own
// operation id, so a retried record (a lost reply) never counts twice (r3 F6).
// What happens next is decided from that persisted count alone (r3 F5), so a
// restarted supervisor decides the same way: below the budget (3) the evaluator
// is restarted (from its checkpoint); at the budget it is restarted once with
// `rebuild` (in-memory state and checkpoint dropped); above it the one rebuild
// has failed, and the evaluator enters the fault state "derived state cannot be
// computed" (WI-11): no more restarts, a system alert, and readers fall back to
// the last checkpoint's summary. The alert's operation id is derived from the
// fault reason the ledger holds, and it is raised again (the same operation) on
// every start in the fault state, so a crash between the two commits never
// loses it and a restart never doubles it. Only a user retry
// (`clearEvaluatorFault`) leaves the fault state.
//
// Disk pool (r3 F20): when the worker pauses checkpoint writes for want of
// room, the supervisor raises WI-11 ("resource pool insufficient") once per
// shortage, identified by the last checkpoint written before it.
//
// Robustness (core review r2 F14). Nothing in the supervisor's own chain can
// reject unhandled: a ledger call that fails is retried with backoff, and a
// failure that could not be recorded is kept and recorded once the ledger is
// back (also after stop()). Every step re-checks, after each await, that the
// supervisor is not stopping and that it is still handling the same worker
// instance, so stop() during exit handling never leads to a restart.

import { execFile, fork, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { accessSync, constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../common/hash.ts';
import type { AlertId, ContentHash } from '../common/ids.ts';
import type { WorkerConfig } from './worker-main.ts';

export interface SupervisorLedgerPort {
  /**
   * Count one failure; `op` identifies it, so a retried call does not count it
   * twice (r3 F6); `gen` is the scheduler generation the supervisor belongs to,
   * so a superseded supervisor cannot change the budget (r3 #7).
   */
  recordEvaluatorFailure(req: { readonly op: string; readonly gen: number }): Promise<number>;
  evaluatorHealth(): Promise<{ failures: number; fault: string | null }>;
  /** Enter the fault state, for the current generation only. */
  setEvaluatorFault(reason: string, req: { readonly gen: number }): Promise<void>;
  raiseAlert(req: { op: string; alert: AlertId; category: string; wi?: string; body: ContentHash }): Promise<unknown>;
  putContent(text: string): ContentHash;
}

/** How the evaluator's memory pool is enforced. */
export interface MemoryPool {
  /**
   * 'cgroup': the whole process is capped. 'heap-only': only the V8 heap is
   * (degraded; only with an accepted resource-limit degradation).
   * 'unavailable': no hard cap here and no accepted degradation: the evaluator
   * must not start (WI-18).
   */
  readonly mode: 'cgroup' | 'heap-only' | 'unavailable';
  /** The V8 heap limit (--max-old-space-size), MiB. */
  readonly heapMb: number;
  /** The process memory cap (cgroup memory.max), MiB; not enforced in 'heap-only'. */
  readonly memoryMb: number;
  /** Why the pool is degraded or unavailable, or null. */
  readonly reason: string | null;
  readonly systemdRun: string | null;
  /** To read a finished scope's result (oom-kill) and clear it. */
  readonly systemctl: string | null;
}

export interface EvaluatorSupervisorOptions {
  readonly worker: Omit<WorkerConfig, 'rebuild' | 'heartbeatMs'>;
  readonly ledger: SupervisorLedgerPort;
  /**
   * Deadline of every phase: when the worker sends no message for this long it
   * is killed (start-up, restore, an update, a checkpoint write, idle polling).
   * 5.5: the from-scratch build limit is the absolute ceiling.
   */
  readonly deadlineMs: number;
  /** V8 heap limit of the evaluator process in MiB. */
  readonly heapMb: number;
  /** Total memory of the evaluator process in MiB (its pool, a cgroup cap). Default: heapMb + max(256, heapMb / 2). */
  readonly memoryMb?: number;
  /**
   * 'auto' (default) and 'cgroup': a memory-limited systemd user scope; without
   * one, heap-only if the resource-limit degradation was accepted ('auto' only),
   * else the evaluator is blocked (WI-18). 'heap-only': never use a scope —
   * allowed only with the accepted degradation.
   */
  readonly memoryPool?: 'auto' | 'cgroup' | 'heap-only';
  /** Degradations the user accepted at install (7.1, 9.6, WI-18); 'resource-limits' allows a heap-only pool. */
  readonly acceptedDegradations?: readonly string[];
  readonly systemdRunPath?: string;
  /** Failures since the last success that trigger the one rebuild (6.1: 3). */
  readonly budget?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Backoff when the ledger cannot be reached (default 200 ms doubling to 5 s). */
  readonly retryMs?: { readonly min: number; readonly max: number };
  /** Tests: start the worker some other way. */
  readonly launch?: (cfg: WorkerConfig, pool: MemoryPool) => ChildProcess;
}

/** 'blocked': the memory pool cannot be enforced and no degradation was accepted (WI-18). */
export type SupervisorState = 'running' | 'fault' | 'blocked' | 'stopped';

/** One worker failure, as recorded and reported. */
export interface WorkerFailure {
  /** Its ledger operation id: one per failure, stable across retries. */
  readonly op: string;
  readonly cause: string;
  /** The phase the worker last reported. */
  readonly phase: string;
  readonly rebuild: boolean;
  readonly stderr: string;
}

const WORKER = fileURLToPath(new URL('./worker-main.ts', import.meta.url));

/** Attempts to record leftover failures after stop() before giving up (and emitting 'unrecorded'). */
const MAX_RETRIES_AFTER_STOP = 12;

// ---------------------------------------------------------------- the memory pool

function findExecutable(name: string, pathEnv: string): string | null {
  for (const dir of [...pathEnv.split(delimiter), '/usr/bin', '/bin']) {
    if (dir === '') continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

function scopeArgs(memoryMb: number): string[] {
  return ['--user', '--scope', '--quiet', '-p', `MemoryMax=${memoryMb}M`, '-p', 'MemorySwapMax=0'];
}

let scopeSeq = 0;

/** A unit name for one worker's scope; not collected automatically, so its result (oom-kill) can be read. */
function scopeUnit(): string {
  return `mp-evaluator-${process.pid}-${++scopeSeq}-${Math.random().toString(36).slice(2, 8)}.scope`;
}

/**
 * The result systemd recorded for a finished scope ('oom-kill', 'signal',
 * 'exit-code', 'success'), or null; then clears the failed unit so none
 * linger. Never rejects.
 */
function scopeResult(systemctl: string | null, unit: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (systemctl === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(systemctl, ['--user', 'show', '-p', 'Result', '--value', unit], { timeout: 5000, env, encoding: 'utf8' }, (err, stdout) => {
      const result = err ? null : String(stdout).trim() || null;
      execFile(systemctl, ['--user', 'reset-failed', unit], { timeout: 5000, env }, () => resolve(result));
    });
  });
}

const PROBE_MB = 64;
const PROBE_SCRIPT = 'p=$(cut -d: -f3 /proc/self/cgroup); cat "/sys/fs/cgroup$p/memory.max" "/sys/fs/cgroup$p/memory.swap.max"';
const probes = new Map<string, Promise<string | null>>();

/**
 * Can this machine run a memory-limited user scope? Runs one tiny scope and
 * reads its memory.max and memory.swap.max from inside (a scope can start
 * without the memory controller and silently not enforce the cap). Returns null
 * when it works, else the reason. Cached per systemd-run path.
 */
export function probeMemoryScope(systemdRun: string | null, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (process.platform !== 'linux') return Promise.resolve(`no cgroup v2 memory pool on ${process.platform}`);
  if (systemdRun === null) return Promise.resolve('systemd-run was not found');
  let p = probes.get(systemdRun);
  if (!p) {
    p = new Promise<string | null>((resolve) => {
      execFile(systemdRun, [...scopeArgs(PROBE_MB), '--collect', '--', '/bin/sh', '-c', PROBE_SCRIPT], { timeout: 15_000, env, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) {
          resolve(`systemd-run --user --scope failed: ${(String(stderr).trim() || err.message).slice(0, 300)}`);
          return;
        }
        const [max, swap] = String(stdout).trim().split(/\s+/);
        if (max !== String(PROBE_MB * 2 ** 20)) resolve(`a user scope's memory.max reads ${max ?? 'nothing'}, not the cap asked for (memory controller not delegated?)`);
        else if (swap !== '0') resolve(`a user scope's memory.swap.max reads ${swap ?? 'nothing'}, not 0`);
        else resolve(null);
      });
    });
    probes.set(systemdRun, p);
  }
  return p;
}

export async function resolveMemoryPool(o: {
  readonly heapMb: number;
  readonly memoryMb?: number;
  readonly memoryPool?: 'auto' | 'cgroup' | 'heap-only';
  readonly acceptedDegradations?: readonly string[];
  readonly systemdRunPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<MemoryPool> {
  const heapMb = o.heapMb;
  const memoryMb = o.memoryMb ?? heapMb + Math.max(256, Math.ceil(heapMb / 2));
  const want = o.memoryPool ?? 'auto';
  const accepted = (o.acceptedDegradations ?? []).includes('resource-limits');
  const none = { systemdRun: null, systemctl: null };
  if (want === 'heap-only') {
    return accepted
      ? { mode: 'heap-only', heapMb, memoryMb, reason: 'configured heap-only (the resource-limit degradation was accepted)', ...none }
      : { mode: 'unavailable', heapMb, memoryMb, reason: 'a heap-only pool was configured, but the resource-limit degradation was not accepted at install', ...none };
  }
  const env = o.env ?? process.env;
  const systemdRun = o.systemdRunPath ?? findExecutable('systemd-run', env['PATH'] ?? '');
  const reason = await probeMemoryScope(systemdRun, env);
  if (reason === null) {
    const systemctl = findExecutable('systemctl', [dirname(systemdRun!), env['PATH'] ?? ''].join(delimiter));
    return { mode: 'cgroup', heapMb, memoryMb, reason: null, systemdRun, systemctl };
  }
  if (want === 'auto' && accepted) return { mode: 'heap-only', heapMb, memoryMb, reason, ...none };
  return { mode: 'unavailable', heapMb, memoryMb, reason, ...none };
}

/** Start the worker under its pool: inside a memory-limited scope named `unit`, or a plain fork when degraded. */
export function launchWorker(cfg: WorkerConfig, pool: MemoryPool, env: NodeJS.ProcessEnv, unit: string): ChildProcess {
  const nodeArgs = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', `--max-old-space-size=${pool.heapMb}`];
  const stdio: ['ignore', 'ignore', 'pipe', 'ipc'] = ['ignore', 'ignore', 'pipe', 'ipc'];
  if (pool.mode === 'cgroup' && pool.systemdRun !== null) {
    // systemd-run --scope moves itself into the new scope and exec()s node: the
    // child keeps its pid and the IPC channel (the descriptor is inherited).
    return spawn(
      pool.systemdRun,
      [...scopeArgs(pool.memoryMb), `--unit=${unit}`, '--description=mission-pipeline derived-state evaluator', '--', process.execPath, ...nodeArgs, WORKER, JSON.stringify(cfg)],
      { stdio, env },
    );
  }
  return fork(WORKER, [JSON.stringify(cfg)], { execArgv: nodeArgs, env, stdio });
}

/** The ledger refused a write because this supervisor's scheduler generation is no longer current. */
function isSuperseded(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 'STALE_GENERATION';
}

// ---------------------------------------------------------------- the supervisor

export class EvaluatorSupervisor extends EventEmitter {
  private readonly opts: EvaluatorSupervisorOptions;
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private killedForDeadline = false;
  private stopping = false;
  /** Bumped by every spawn and by stop(): a step that started for another instance does nothing. */
  private instance = 0;
  private rebuilding = false;
  /** The phase the current worker last reported. */
  private phase = 'start';
  /** The current worker's scope unit (cgroup mode), to read its result after it exits. */
  private workerUnit: string | null = null;
  /** The last 4 KiB the current worker wrote to stderr, reported with its failure. */
  private stderrTail = '';
  private pool: MemoryPool | null = null;
  /** Failures not yet accepted by the ledger, oldest first. */
  private readonly unrecorded: WorkerFailure[] = [];
  private flushing: Promise<void> | null = null;
  /** The most recent failure, until its consequence (restart, rebuild or fault) is decided. */
  private lastFailure: WorkerFailure | null = null;
  /** Identifies this supervisor in failure operation ids. */
  private readonly runId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  /** Alerts the ledger could not take yet (retried in the background). */
  private pendingAlerts: Array<Parameters<SupervisorLedgerPort['raiseAlert']>[0]> = [];
  private alertTimer: NodeJS.Timeout | null = null;
  /** Disk-pool shortages already noticed by this supervisor. */
  private readonly diskAlerts = new Set<string>();
  private recovering = false;
  private recoverAgain = false;
  private recoverFor = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay: number;
  private retriesAfterStop = 0;
  state: SupervisorState = 'stopped';
  /** Number of worker processes started (tests). */
  spawns = 0;

  constructor(opts: EvaluatorSupervisorOptions) {
    super();
    this.opts = opts;
    this.retryDelay = opts.retryMs?.min ?? 200;
  }

  /** How the memory pool is enforced (known after start()). */
  get memoryPool(): MemoryPool | null {
    return this.pool;
  }

  /** The pool caps only the V8 heap: no memory-limited scope was available (F13). */
  get degraded(): boolean {
    return this.pool?.mode === 'heap-only';
  }

  /** The current worker's pid (it is the node process itself, also inside a scope). */
  get workerPid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Failures the ledger has not accepted yet (it was unreachable). */
  get unrecordedFailures(): number {
    return this.unrecorded.length;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.retriesAfterStop = 0;
    this.pool ??= await resolveMemoryPool({
      heapMb: this.opts.heapMb,
      ...(this.opts.memoryMb !== undefined ? { memoryMb: this.opts.memoryMb } : {}),
      ...(this.opts.memoryPool !== undefined ? { memoryPool: this.opts.memoryPool } : {}),
      ...(this.opts.acceptedDegradations !== undefined ? { acceptedDegradations: this.opts.acceptedDegradations } : {}),
      ...(this.opts.systemdRunPath !== undefined ? { systemdRunPath: this.opts.systemdRunPath } : {}),
      ...(this.opts.env !== undefined ? { env: this.opts.env } : {}),
    });
    if (this.pool.mode === 'heap-only') this.notify('degraded', this.pool);
    this.state = 'running';
    await this.recover(this.instance);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.instance++;
    this.clearDeadline();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const c = this.child;
    const unit = this.workerUnit;
    this.child = null; // its exit is not a failure
    this.workerUnit = null;
    if (c && c.exitCode === null && c.signalCode === null) {
      const exited = new Promise<void>((r) => c.once('exit', () => r()));
      c.kill('SIGKILL');
      let t: NodeJS.Timeout | undefined;
      await Promise.race([exited, new Promise<void>((r) => (t = setTimeout(r, 10_000)))]);
      clearTimeout(t);
    }
    if (unit !== null) await scopeResult(this.pool?.systemctl ?? null, unit, this.opts.env ?? process.env);
    // Failures the ledger has not taken yet are still recorded once it is back.
    if (this.unrecorded.length > 0 && !this.flushing) void this.flushQuietly();
    if (this.state === 'running') this.state = 'stopped';
  }

  /** Resolves when every failure so far is recorded (rejects if the ledger refuses now). */
  flushed(): Promise<void> {
    return this.unrecorded.length === 0 && !this.flushing ? Promise.resolve() : this.flush();
  }

  // ------------------------------------------------------------ recovery: record, decide, restart

  private halted(inst: number): boolean {
    return this.stopping || inst !== this.instance;
  }

  /** Never rejects: a ledger error schedules a retry. The latest request wins. */
  private async recover(inst: number): Promise<void> {
    this.recoverFor = inst;
    if (this.recovering) {
      this.recoverAgain = true;
      return;
    }
    this.recovering = true;
    try {
      do {
        this.recoverAgain = false;
        await this.recoverStep(this.recoverFor);
      } while (this.recoverAgain);
      this.retryDelay = this.opts.retryMs?.min ?? 200;
    } catch (e) {
      this.notify('ledger-error', e);
      if (isSuperseded(e)) void this.supersede(e);
      else this.scheduleRetry();
    } finally {
      this.recovering = false;
    }
  }

  /**
   * The scheduler generation this supervisor belongs to is no longer current
   * (6.3): the ledger refuses its budget and fault writes, so retrying is
   * pointless. Stop the worker and keep nothing: the new generation's
   * supervisor owns the evaluator now.
   */
  private async supersede(e: unknown): Promise<void> {
    this.unrecorded.splice(0, this.unrecorded.length);
    await this.stop();
    this.notify('superseded', e);
  }

  private async recoverStep(inst: number): Promise<void> {
    const pool = this.pool!;
    if (pool.mode === 'unavailable') {
      // r3 F9, WI-18: no hard memory cap and no accepted degradation: do not start.
      await this.raise(this.blockedAlert(pool));
      if (!this.halted(inst)) {
        this.state = 'blocked';
        this.notify('blocked', pool);
      }
      return;
    }
    await this.flush();
    if (this.halted(inst)) return;
    const health = await this.opts.ledger.evaluatorHealth();
    if (this.halted(inst)) return;
    const budget = this.opts.budget ?? 3;
    let fault = health.fault;
    if (fault === null && health.failures > budget) {
      // The one rebuild is the attempt made at `budget` failures; a failure after
      // it means the rebuild failed. Decided from the persisted count, so a
      // restarted supervisor never grants a second rebuild (r3 F5).
      const cause = this.lastFailure?.cause ?? 'recorded before the supervisor restarted';
      fault = `the from-scratch rebuild failed (${cause}) after ${budget} failures since the last publication; ${health.failures} failures in all; decided at ${new Date().toISOString()}`;
      // The fault and its alert are committed even if a stop arrives meanwhile:
      // the ledger already counts the failures that caused them.
      await this.opts.ledger.setEvaluatorFault(fault, { gen: this.opts.worker.gen });
    }
    if (fault !== null) {
      // Raised on every start in the fault state: the same operation, so a crash
      // between the fault and its alert never loses the alert.
      await this.raise(this.faultAlert(fault));
      this.lastFailure = null;
      if (!this.halted(inst)) this.enterFault(fault);
      return;
    }
    this.lastFailure = null;
    this.spawn(health.failures >= budget);
  }

  /** WI-11: the derived state cannot be computed. Deterministic in the reason. */
  private faultAlert(reason: string): Parameters<SupervisorLedgerPort['raiseAlert']>[0] {
    const key = sha256(reason).slice(0, 16);
    const body = this.opts.ledger.putContent(
      JSON.stringify({
        category: 'evaluator-fault',
        wi: 'WI-11',
        key: `evaluator-fault:${key}`,
        source: 'evaluator-supervisor',
        trigger: `the derived state cannot be computed (6.1): ${reason}`,
        defaultAction:
          'no more evaluator restarts; operations that need "proven" end with "derived state cannot be computed"; reads fall back to the last checkpoint summary; everything else continues',
        detail: { reason, checkpoint: this.opts.worker.checkpointPath },
      }),
    );
    return { op: `alert:evaluator-fault:${key}`, alert: `evaluator-fault-${key}` as AlertId, category: 'evaluator-fault', wi: 'WI-11', body };
  }

  /** WI-18: the evaluator's memory pool cannot be enforced here. Deterministic in the reason. */
  private blockedAlert(pool: MemoryPool): Parameters<SupervisorLedgerPort['raiseAlert']>[0] {
    const reason = pool.reason ?? 'unknown';
    const key = sha256(`memory-pool\u0000${reason}`).slice(0, 16);
    const body = this.opts.ledger.putContent(
      JSON.stringify({
        category: 'platform-capability',
        wi: 'WI-18',
        key: `evaluator-memory-pool:${key}`,
        source: 'evaluator-supervisor',
        trigger: `the evaluator's memory pool needs a hard cap (a memory-limited cgroup v2 user scope, 6.1) and none works here: ${reason}`,
        defaultAction:
          'the evaluator does not start; operations that need "proven" end with "derived state cannot be computed"; reads fall back to the last checkpoint summary; everything else continues',
        detail: { reason, heapMb: pool.heapMb, memoryMb: pool.memoryMb },
      }),
    );
    return { op: `alert:evaluator-memory-pool:${key}`, alert: `evaluator-memory-pool-${key}` as AlertId, category: 'platform-capability', wi: 'WI-18', body };
  }

  /** WI-11: the checkpoint disk pool is too small; one alert per shortage (the last checkpoint written before it). */
  private diskPoolAlert(m: Record<string, unknown>): Parameters<SupervisorLedgerPort['raiseAlert']>[0] {
    const key = sha256(`disk-pool\u0000${String(m.checkpointPath)}\u0000${String(m.lastCheckpointRevision)}`).slice(0, 16);
    const body = this.opts.ledger.putContent(
      JSON.stringify({
        category: 'evaluator-resource-pool',
        wi: 'WI-11',
        key: `evaluator-disk-pool:${key}`,
        source: 'evaluator-supervisor',
        trigger: `the evaluator's checkpoint disk pool is insufficient (6.1): ${String(m.reason)}`,
        defaultAction: 'checkpoint writes pause; publication and queries go on; readers that need the summary get the last one written',
        detail: {
          checkpoint: m.checkpointPath,
          lastCheckpointRevision: m.lastCheckpointRevision,
          newBytes: m.newBytes ?? null,
          oldBytes: m.oldBytes ?? null,
          poolBytes: m.poolBytes ?? null,
          freeBytes: m.freeBytes ?? null,
        },
      }),
    );
    return { op: `alert:evaluator-disk-pool:${key}`, alert: `evaluator-disk-pool-${key}` as AlertId, category: 'evaluator-resource-pool', wi: 'WI-11', body };
  }

  /** Raise an alert; OP_CONFLICT means it was raised already (by an earlier run). Other errors propagate. */
  private async raise(req: Parameters<SupervisorLedgerPort['raiseAlert']>[0]): Promise<void> {
    try {
      await this.opts.ledger.raiseAlert(req);
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'OP_CONFLICT') throw e;
    }
  }

  /** Raise an alert in the background; one the ledger cannot take now is retried later. */
  private raiseLater(req: Parameters<SupervisorLedgerPort['raiseAlert']>[0]): void {
    this.pendingAlerts.push(req);
    this.drainAlerts();
  }

  private drainAlerts(): void {
    if (this.alertTimer !== null) return;
    const run = async (): Promise<void> => {
      while (this.pendingAlerts.length > 0) {
        await this.raise(this.pendingAlerts[0]!);
        this.pendingAlerts.shift();
      }
    };
    run().catch((e: unknown) => {
      this.notify('ledger-error', e);
      this.alertTimer = setTimeout(() => {
        this.alertTimer = null;
        this.drainAlerts();
      }, this.opts.retryMs?.max ?? 5000);
      this.alertTimer.unref();
    });
  }

  private enterFault(reason: string): void {
    this.state = 'fault';
    this.notify('fault', reason);
  }

  /** Record every unrecorded failure, oldest first; one flush at a time. */
  private flush(): Promise<void> {
    if (!this.flushing) {
      const run = async (): Promise<void> => {
        while (this.unrecorded.length > 0) {
          await this.opts.ledger.recordEvaluatorFailure({ op: this.unrecorded[0]!.op, gen: this.opts.worker.gen });
          const f = this.unrecorded.shift()!;
          this.notify('failure', f);
        }
      };
      this.flushing = run().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private async flushQuietly(): Promise<void> {
    try {
      await this.flush();
    } catch (e) {
      this.notify('ledger-error', e);
      if (isSuperseded(e)) this.unrecorded.splice(0, this.unrecorded.length);
      else this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    if (this.stopping) {
      if (this.unrecorded.length === 0) return;
      if (++this.retriesAfterStop > MAX_RETRIES_AFTER_STOP) {
        this.notify('unrecorded', this.unrecorded.length);
        return;
      }
    }
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, this.opts.retryMs?.max ?? 5000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopping) void this.flushQuietly();
      else void this.recover(this.instance);
    }, delay);
    // After stop() only bookkeeping is left: it must not keep the process alive.
    if (this.stopping) this.retryTimer.unref();
  }

  // ------------------------------------------------------------ the worker process

  private heartbeatMs(): number {
    return Math.max(5, Math.min(1000, Math.floor(this.opts.deadlineMs / 4)));
  }

  private spawn(rebuild: boolean): void {
    const inst = ++this.instance;
    const pool = this.pool!;
    this.rebuilding = rebuild;
    this.killedForDeadline = false;
    this.phase = 'start';
    this.stderrTail = '';
    const cfg: WorkerConfig = { ...this.opts.worker, rebuild, heartbeatMs: this.heartbeatMs() };
    const unit = !this.opts.launch && pool.mode === 'cgroup' ? scopeUnit() : null;
    this.workerUnit = unit;
    let child: ChildProcess;
    try {
      child = this.opts.launch ? this.opts.launch(cfg, pool) : launchWorker(cfg, pool, this.opts.env ?? process.env, unit ?? '');
    } catch (e) {
      this.workerUnit = null;
      this.recordFailure({ op: this.failureOp(inst), cause: `spawn failed: ${e instanceof Error ? e.message : String(e)}`, phase: 'start', rebuild, stderr: '' }, inst);
      return;
    }
    this.child = child;
    this.spawns++;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4096);
    });
    child.stderr?.on('error', () => undefined);
    child.on('message', (m: unknown) => this.onMessage(child, m));
    child.on('error', (e: Error) => {
      this.stderrTail = (this.stderrTail + `\n[supervisor] ${e.message}`).slice(-4096);
      if (child.pid === undefined) this.onExit(child, inst, null, null);
      else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    child.on('exit', (code, signal) => this.onExit(child, inst, code, signal));
    this.armDeadline(child);
    this.notify('spawn', { rebuild, pool: pool.mode });
  }

  private onMessage(child: ChildProcess, raw: unknown): void {
    if (child !== this.child) return;
    this.armDeadline(child); // any message: the worker is alive and progressing
    const m = (raw ?? {}) as { type?: unknown; phase?: unknown; published?: unknown; used?: unknown; message?: unknown };
    switch (m.type) {
      case 'phase':
        this.phase = String(m.phase);
        break;
      case 'restore':
        this.phase = 'restore';
        this.notify('restore', m.used === true);
        break;
      case 'ready':
      case 'heartbeat':
        this.phase = 'idle';
        if (m.type === 'ready') this.notify('ready');
        break;
      case 'update-start':
      case 'update-failed':
        this.phase = 'update';
        break;
      case 'update-done':
        this.phase = 'idle';
        this.rebuilding = false;
        this.notify('published', m.published);
        break;
      case 'checkpoint-start':
        this.phase = 'checkpoint';
        break;
      case 'checkpoint-done':
        this.phase = 'idle';
        this.notify('checkpoint', raw);
        break;
      case 'checkpoint-failed':
        this.phase = 'idle';
        this.notify('checkpoint-failed', String(m.message));
        break;
      case 'checkpoint-paused': {
        // 6.1, WI-11: the disk pool cannot hold the checkpoints; writes pause, publication goes on.
        this.phase = 'idle';
        const alert = this.diskPoolAlert(raw as Record<string, unknown>);
        if (!this.diskAlerts.has(alert.op)) {
          this.diskAlerts.add(alert.op);
          this.raiseLater(alert);
        }
        this.notify('checkpoint-paused', raw);
        break;
      }
      case 'checkpoint-resumed':
        this.notify('checkpoint-resumed', raw);
        break;
    }
  }

  private armDeadline(child: ChildProcess): void {
    this.clearDeadline();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (child !== this.child || child.exitCode !== null || child.signalCode !== null) return;
      this.killedForDeadline = true;
      child.kill('SIGKILL');
    }, this.opts.deadlineMs);
  }

  private clearDeadline(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private describeExit(code: number | null, signal: NodeJS.Signals | null, phase: string, deadline: boolean, result: string | null): string {
    if (deadline) return `deadline: no progress within ${this.opts.deadlineMs} ms (${phase})`;
    if (result === 'oom-kill') return `the memory pool of ${this.pool?.memoryMb} MiB was exceeded (oom-kill during ${phase})`;
    return `exit ${code ?? signal} (${phase})`;
  }

  private onExit(child: ChildProcess, inst: number, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.child) return;
    this.clearDeadline();
    this.child = null;
    const unit = this.workerUnit;
    this.workerUnit = null;
    const env = this.opts.env ?? process.env;
    if (this.halted(inst)) {
      if (unit !== null) void scopeResult(this.pool?.systemctl ?? null, unit, env);
      return;
    }
    const phase = this.phase;
    const deadline = this.killedForDeadline;
    const base = { op: this.failureOp(inst), phase, rebuild: this.rebuilding, stderr: this.stderrTail };
    if (unit === null) {
      this.recordFailure({ ...base, cause: this.describeExit(code, signal, phase, deadline, null) }, inst);
      return;
    }
    // Ask systemd how the scope ended (an oom-kill names the pool as the cause), then record.
    void scopeResult(this.pool?.systemctl ?? null, unit, env).then((result) =>
      this.recordFailure({ ...base, cause: this.describeExit(code, signal, phase, deadline, result) }, inst),
    );
  }

  /** One operation id per failure: the worker instance of this supervisor run (r3 F6). */
  private failureOp(inst: number): string {
    return `evaluator-failure:${this.runId}:${inst}`;
  }

  private recordFailure(f: WorkerFailure, inst: number): void {
    this.lastFailure = f;
    this.unrecorded.push(f);
    void this.recover(inst);
  }

  /** Emit without letting a throwing listener break the supervisor. */
  private notify(event: string, ...args: unknown[]): void {
    try {
      this.emit(event, ...args);
    } catch (e) {
      try {
        this.emit('listener-error', e, event);
      } catch {
        /* ignore */
      }
    }
  }
}
