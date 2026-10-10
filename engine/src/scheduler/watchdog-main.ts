// The watchdog as a plain process (design 6.3 "监督"):
//
//   node --experimental-strip-types src/scheduler/watchdog-main.ts <config.json>
//
// The config is a WatchdogOptions object (argv of the ledger service and of the scheduler,
// their heartbeat files, the control plane). SIGTERM stops both managed processes.

import { readFileSync } from 'node:fs';
import { Watchdog, type WatchdogOptions } from './watchdog.ts';

async function main(): Promise<void> {
  const cfg = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as WatchdogOptions;
  const w = new Watchdog(cfg);
  const shutdown = (): void => {
    void w.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await w.start();
  process.send?.({ type: 'ready' });
}

main().catch((e: unknown) => {
  process.stderr.write(`[watchdog] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
