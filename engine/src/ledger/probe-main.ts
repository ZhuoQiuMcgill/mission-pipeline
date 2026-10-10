// One inbox probe as its own process (design v45 6.1 "收件箱探针"), started and
// watched by the watchdog, independent of the ledger service.
//
//   node --experimental-strip-types src/ledger/probe-main.ts <config JSON file>
//
// Config: { inbox, file, other, controlPlane, boot?, intervalMs?, staleMs?, shutdownMs? }.
// SIGTERM: the clean-exit step of the shutdown sequence (shutdown.ts), then exit:
// 0 when the clean-exit record was written, 2 when it was not.

import { readFileSync } from 'node:fs';
import { InboxProbe, type ProbeConfig } from './probe.ts';
import { readBootId } from './stops.ts';

async function main(): Promise<void> {
  const raw = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as Omit<ProbeConfig, 'boot'> & { boot?: string };
  const probe = new InboxProbe({ ...raw, boot: raw.boot ?? readBootId() });
  await probe.start();
  let running = true;
  let busy: Promise<void> = Promise.resolve();
  const loop = async (): Promise<void> => {
    while (running) {
      busy = probe.tick().catch(() => undefined);
      await busy;
      await new Promise((r) => setTimeout(r, probe.intervalMs));
    }
  };
  process.on('SIGTERM', () => {
    running = false;
    void (async () => {
      await busy;
      const wrote = await probe.shutdown();
      probe.close();
      process.exit(wrote ? 0 : 2);
    })();
  });
  process.send?.({ type: 'ready', inbox: raw.inbox });
  await loop();
}

main().catch((e: unknown) => {
  process.stderr.write(`[probe] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
