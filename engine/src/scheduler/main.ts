// The scheduler process (design 6.3): one generation per process start.
//
//   node --experimental-strip-types src/scheduler/main.ts <config.json>
//
// Begins a generation, takes over, runs its loops and writes its heartbeat to the control
// plane for the watchdog. An optional Unix socket (config.rpcSocket) accepts tasks and
// answers status queries (the CLI and tests). SIGTERM closes it cleanly; units keep running
// (they are independent services) and the next generation adopts them.

import { readFileSync } from 'node:fs';
import { serveRpc, RpcError } from '../common/rpc.ts';
import type { LoopKind } from '../common/records.ts';
import type { StopId } from '../common/ids.ts';
import type { FlowConfig } from './flow.ts';
import type { FlowPorts } from '../flow/ports.ts';
import { flowRpc } from './flowRpc.ts';
import { Scheduler, type SchedulerOptions } from './scheduler.ts';
import type { TaskSpec } from './tasks.ts';

export interface SchedulerMainConfig extends SchedulerOptions {
  readonly rpcSocket?: string;
  /** The project the flows work on (src/scheduler/flow.ts); without it no flow runs (the queue still does). */
  readonly flow?: FlowConfig;
}

function view(s: Scheduler): unknown {
  return s.tasks.all().map((t) => ({ task: t.spec.task, lineage: t.spec.lineage, mission: t.spec.mission, state: t.state, note: t.note, launches: t.launches, current: t.current }));
}

async function main(): Promise<void> {
  const cfg = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as SchedulerMainConfig;
  const s = new Scheduler({ ...cfg, log: (l) => process.stderr.write(`${l}\n`) });
  // the flows' ports once they are composed (null: no flows, or not yet): the PM's flow requests run on them
  let flowPorts: FlowPorts | null = null;
  const flowMethods = flowRpc(() => flowPorts);
  const server =
    cfg.rpcSocket === undefined
      ? null
      : serveRpc(cfg.rpcSocket, async (method, params) => {
          const p = params as Record<string, unknown>;
          const flowAnswer = flowMethods(method, params);
          if (flowAnswer !== undefined) return flowAnswer;
          switch (method) {
            case 'ping':
              return { gen: s.generation, started: s.started, stale: s.stale };
            case 'submit':
              // answered once the ledger's queue has the task (4.1)
              return { task: (await s.submitDurable(p['spec'] as TaskSpec)).spec.task };
            case 'cancelTask':
              return { cancelled: await s.cancelTask(String(p['task'])) };
            case 'retryEvaluator':
              await s.retryEvaluator();
              return { ok: true };
            case 'tasks':
              return view(s);
            case 'status':
              return { gen: s.generation, paused: s.paused, storageFault: s.storageFault, stale: s.stale, waiting: s.waitingReasons(), tasks: view(s), outcomes: s.outcomes };
            case 'stopReport':
              return s.stops.report(p['stop'] as StopId);
            case 'grant':
              return s.grant(p as { lineage: string; loop: LoopKind; by: 'secretary' | 'user'; extra: number; reason: string; op: string });
            case 'restartQuarantined':
              return s.restartQuarantined(String(p['task']), String(p['signature'] ?? 'restart'));
            case 'resumeAfterEvidence':
              return s.resumeAfterEvidence(String(p['task']), typeof p['evidence'] === 'string' ? p['evidence'] : '');
            case 'recoveryCheck':
              return s.recoveryCheck();
            case 'confirmResume':
              await s.confirmResume({ ...(typeof p['op'] === 'string' ? { op: p['op'] } : {}), ...(typeof p['answer'] === 'string' ? { answer: p['answer'] } : {}) });
              return { ok: true };
            case 'tick':
              await s.tick();
              return { ok: true };
            default:
              throw new RpcError('BAD_REQUEST', `unknown method ${method}`);
          }
        });
  const shutdown = (): void => {
    void s.close().then(() => {
      server?.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  const gen = await s.start();
  if (cfg.flow !== undefined) {
    // the flows: reconciled on every tick and after every accepted outcome
    try {
      // loaded only when configured (the flows pull in the git and seat-card modules)
      const { composeFlowParts } = await import('./flow.ts');
      const parts = await composeFlowParts(s, cfg.flow);
      flowPorts = parts.ports;
      s.attachFlow(parts.engine);
    } catch (e) {
      // the queue, stops, cleanup and acceptance go on without the flows; the PM is told (WI-20)
      process.stderr.write(`[scheduler] the flows could not be started: ${(e as Error).stack ?? String(e)}\n`);
      await s.alerts
        .raise({
          category: 'flows-unavailable',
          wi: 'WI-20',
          key: `${gen}`,
          trigger: `the flows could not be started on ${cfg.flow.repo}: ${(e as Error).message}`,
          defaultAction: 'the scheduler runs without them (queued tasks, stops, cleanup and acceptance continue); no flow step advances until the scheduler is restarted with a working project configuration',
          detail: { repo: cfg.flow.repo, error: (e as Error).message },
        })
        .catch(() => undefined);
    }
  }
  process.send?.({ type: 'ready', gen });
  // a superseded scheduler ends itself: a newer generation is in charge (6.3)
  const watch = setInterval(() => {
    if (s.stale) {
      clearInterval(watch);
      void s.close().then(() => process.exit(3));
    }
  }, 500);
}

main().catch((e: unknown) => {
  process.stderr.write(`[scheduler] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
