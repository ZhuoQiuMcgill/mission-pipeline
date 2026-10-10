// The PM session-start hook's entry (design v45 6.3 "启动时机"):
//
//   node --experimental-strip-types src/scheduler/ensure-running-main.ts <engine-config.json>
//
// Starts the engine (watchdog -> ledger service and scheduler) if it is not running; does
// nothing otherwise. Prints one JSON line { started, running, watchdogPid, ledgerBeating,
// schedulerBeating } and exits 0 when the engine runs, 1 when it could not be started.

import { readFileSync } from 'node:fs';
import { ensureRunning, type EngineConfig } from './engine.ts';

async function main(): Promise<void> {
  const cfg = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as EngineConfig;
  const r = await ensureRunning(cfg);
  process.stdout.write(`${JSON.stringify(r)}\n`);
}

main().catch((e: unknown) => {
  process.stdout.write(`${JSON.stringify({ started: false, running: false, error: (e as Error).message })}\n`);
  process.exit(1);
});
