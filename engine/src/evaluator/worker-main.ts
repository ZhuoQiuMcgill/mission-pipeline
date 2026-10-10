// The evaluator process (design 6.1): a separate process with its own deadline
// and memory pool, supervised by EvaluatorSupervisor (supervisor.ts).
//
// It reads base records straight from the ledger database (read-only), writes
// through the ledger service (episode batches, the publication floor, WI-16
// notices), keeps the published state in memory, and answers queries on its own
// socket with the revision attached (queries.ts). It never writes derived state
// into the ledger. Checkpoints only speed up restarts; `rebuild` ignores them.
//
// Liveness (core review r2 F13): every phase reports to the supervisor, which
// kills the process when no message arrives within its deadline. Messages:
//   phase{start|restore} | restore | ready | heartbeat (idle, every heartbeatMs)
//   | update-start | update-done | update-failed
//   | checkpoint-start | checkpoint-done | checkpoint-failed
// So start-up, checkpoint restore, every update, every checkpoint write and the
// idle polling of the head are each bounded by the deadline.
//
// The worker never records its own failures: the supervisor records exactly one
// failure for every abnormal exit or missed deadline, so a failure is counted
// once even when the ledger is unreachable from the worker (6.1). It exits when
// its supervisor goes away (the IPC channel closes).

import { existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileAtomic } from '../common/fsx.ts';
import { serveRpc } from '../common/rpc.ts';
import type { Revision } from '../common/ids.ts';
import { ContentStore } from '../ledger/content.ts';
import { LedgerClient, type LedgerMethods } from '../ledger/ipc.ts';
import { readHead, readRecords } from '../ledger/store.ts';
import { dirname } from 'node:path';
import {
  CheckpointSchedule,
  DEFAULT_CHECKPOINT_RESERVE_BYTES,
  checkpointRoom,
  fileBytes,
  freeBytes,
  readCheckpointSummary,
  summaryPath,
  summaryText,
  writeCheckpoint,
} from './checkpoint.ts';
import { Evaluator, type EvaluatorLedgerPort } from './evaluator.ts';
import { evaluatorQueryHandler } from './queries.ts';
import { memoryStatus, ownCgroup, selfIdentity } from './process-info.ts';

export interface WorkerConfig {
  readonly dbPath: string;
  readonly contentRoot: string;
  readonly ledgerSocket: string;
  readonly querySocket: string;
  readonly checkpointPath: string;
  /**
   * The scheduler generation this evaluator belongs to (6.1, 6.3). The worker
   * registers with `beginEvaluator({ gen, identity })`; the ledger binds
   * publication to the current generation (core review r2 F10).
   */
  readonly gen: number;
  /** Ignore the checkpoint and build from scratch (after the failure budget is used up). */
  readonly rebuild: boolean;
  readonly pollMs: number;
  /** Write a checkpoint after this many publications. */
  readonly checkpointEvery: number;
  /** ... or once this long has passed with a publication not yet saved (default 10 minutes, 6.1). */
  readonly checkpointIntervalMs?: number;
  /** Idle heartbeat period; the supervisor sets it well below its deadline (default 250 ms). */
  readonly heartbeatMs?: number;
  /** How long a continuation or deciding query waits for a publication in flight (default 1 s). */
  readonly queryWaitMs?: number;
  /**
   * The checkpoint disk pool (6.1): it must hold the previous checkpoint and the
   * new one at once. Null or absent: no pool of its own, only the disk reserve.
   */
  readonly checkpointPoolBytes?: number | null;
  /** Free space a checkpoint write must leave on its disk (default 256 MiB). */
  readonly checkpointReserveBytes?: number;
  /** Tests only: honour MP_EVAL_FAULT. */
  readonly faultInjection: boolean;
}

function send(msg: Record<string, unknown>): void {
  if (!process.connected) return;
  try {
    process.send?.(msg);
  } catch {
    /* the channel closed; 'disconnect' ends the process */
  }
}

/** Block the thread the way a write stuck in the kernel does (fault injection). */
function blockForever(): never {
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

async function main(): Promise<void> {
  send({ type: 'phase', phase: 'start' });
  process.on('disconnect', () => process.exit(0));
  const cfg = JSON.parse(process.argv[2] ?? '{}') as WorkerConfig;
  const fault = cfg.faultInjection ? (process.env.MP_EVAL_FAULT ?? '') : '';
  const content = new ContentStore(cfg.contentRoot);
  const ledger = new LedgerClient(cfg.ledgerSocket, 30_000);
  const identity = selfIdentity();
  const port: EvaluatorLedgerPort = {
    readRecordsAfter: (after: Revision) => readRecords(cfg.dbPath, after),
    // F10: the scheduler generation and this process's identity bind the registration.
    beginEvaluator: () => ledger.call('beginEvaluator', { gen: cfg.gen as LedgerMethods['beginEvaluator']['gen'], identity }) as Promise<{ epoch: number }>,
    publish: (req) => ledger.call('publish', req) as Promise<{ floor: Revision }>,
    // Counted by the supervisor, once per failure.
    recordEvaluatorFailure: async () => 0,
    raiseAlert: (req) => ledger.call('raiseAlert', req),
  };
  const ev = new Evaluator(port, content);
  if (!cfg.rebuild && existsSync(cfg.checkpointPath)) {
    send({ type: 'phase', phase: 'restore' });
    if (fault === 'restore-hang') blockForever();
    const restored = ev.restore(readFileSync(cfg.checkpointPath, 'utf8'), readRecords(cfg.dbPath, 0 as Revision));
    send({ type: 'restore', used: restored });
  }

  const schedule = new CheckpointSchedule({ every: cfg.checkpointEvery, ...(cfg.checkpointIntervalMs !== undefined ? { intervalMs: cfg.checkpointIntervalMs } : {}) });
  serveRpc(
    cfg.querySocket,
    evaluatorQueryHandler(ev, {
      head: () => readHead(cfg.dbPath),
      ...(cfg.queryWaitMs !== undefined ? { waitMs: cfg.queryWaitMs } : {}),
      extra: () => ({ process: { pid: process.pid, cgroup: ownCgroup(), ...memoryStatus() }, checkpoint: { unsaved: schedule.pending() }, pendingAlerts: ev.pendingAlertCount() }),
    }),
  );
  send({ type: 'ready' });

  const beatMs = Math.max(1, cfg.heartbeatMs ?? 250);
  const nap = Math.max(1, Math.min(cfg.pollMs, beatMs));
  let lastBeat = Date.now();
  let crashedOnce = false;

  /** The revision of the last checkpoint on disk (it identifies a disk-pool shortage episode). */
  let lastCheckpointRevision: number | null = readCheckpointSummary(cfg.checkpointPath)?.revision ?? null;
  let paused = false;

  const checkpoint = (trigger: string): void => {
    send({ type: 'checkpoint-start', trigger });
    if (fault === 'checkpoint-hang') blockForever();
    const t0 = performance.now();
    const pause = (reason: string, sizes: Record<string, number | null>): void => {
      // 6.1, WI-11: pause checkpoint writes rather than fill the disk; publication goes on.
      schedule.failed();
      paused = true;
      send({ type: 'checkpoint-paused', trigger, reason, lastCheckpointRevision, checkpointPath: cfg.checkpointPath, ...sizes });
    };
    try {
      const cp = ev.checkpointWithHash();
      const summary = ev.summary(readHead(cfg.dbPath), { checkpoint: cp.hash });
      if (!summary) return;
      const newBytes = Buffer.byteLength(cp.text) + Buffer.byteLength(summaryText(summary));
      const oldBytes = fileBytes(cfg.checkpointPath) + fileBytes(summaryPath(cfg.checkpointPath));
      const free = freeBytes(dirname(cfg.checkpointPath));
      const poolBytes = cfg.checkpointPoolBytes ?? null;
      const room = checkpointRoom({ newBytes, oldBytes, poolBytes, freeBytes: free, reserveBytes: cfg.checkpointReserveBytes ?? DEFAULT_CHECKPOINT_RESERVE_BYTES });
      if (fault === 'checkpoint-enospc' || room !== null) {
        pause(room ?? 'injected: the disk is full', { newBytes, oldBytes, poolBytes, freeBytes: free });
        return;
      }
      writeCheckpoint(cfg.checkpointPath, cp.text, summary);
      schedule.written();
      lastCheckpointRevision = summary.revision;
      if (paused) {
        paused = false;
        send({ type: 'checkpoint-resumed', revision: summary.revision });
      }
      send({ type: 'checkpoint-done', trigger, revision: summary.revision, ms: performance.now() - t0 });
    } catch (e) {
      // A checkpoint is only a cache: a failed write must not stop publication.
      const code = (e as { code?: unknown }).code;
      if (code === 'ENOSPC' || code === 'EDQUOT') pause(`the disk is full (${String(code)})`, {});
      else {
        schedule.failed();
        send({ type: 'checkpoint-failed', message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      lastBeat = Date.now();
    }
  };

  for (;;) {
    const head = readHead(cfg.dbPath);
    // Also with nothing new to read while no revision is published yet: after a
    // restore that caught up with the ledger, or on an empty ledger, the state
    // must still be derived and published (core review r3 F4).
    if (head > ev.lastReadRevision() || ev.state() === null) {
      send({ type: 'update-start', head });
      if (fault === 'hang') await new Promise(() => {});
      if (fault === 'crash' || (fault === 'crash-once' && !crashedOnce && !existsSync(`${cfg.checkpointPath}.crashed`))) {
        writeFileAtomic(`${cfg.checkpointPath}.crashed`, '1');
        crashedOnce = true;
        process.exit(9);
      }
      if (fault === 'alloc') {
        // Memory outside the V8 heap: only the process memory pool (cgroup) can stop it.
        const mb = Number(process.env.MP_EVAL_ALLOC_MB ?? '512');
        const keep: Buffer[] = [];
        for (let i = 0; i < mb; i += 16) keep.push(Buffer.alloc(16 * 2 ** 20, 1));
        (globalThis as { __mpKeep?: unknown }).__mpKeep = keep;
      }
      if (fault === 'throw') ev.injectComputeFault = () => true;
      try {
        const r = await ev.update();
        send({ type: 'update-done', published: r.published, batch: r.batch });
      } catch (e) {
        send({ type: 'update-failed', message: e instanceof Error ? e.message : String(e) });
        ledger.close();
        process.exit(3);
      }
      schedule.published();
      lastBeat = Date.now();
      const why = schedule.due();
      if (why) checkpoint(why);
      continue;
    }
    const why = schedule.due();
    if (why) checkpoint(why);
    if (Date.now() - lastBeat >= beatMs) {
      send({ type: 'heartbeat' });
      lastBeat = Date.now();
    }
    await sleep(nap);
  }
}

main().catch((e: unknown) => {
  send({ type: 'update-failed', message: e instanceof Error ? e.message : String(e) });
  process.exit(4);
});
