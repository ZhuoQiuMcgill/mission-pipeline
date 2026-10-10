// Entry point of the seat host (src/seat/host.ts): the command the unit supervisor starts in
// the unit's control layer.
//   node --experimental-strip-types src/seat/host-main.ts <seat-host-config.json>
// Exit 0: the outcome is written and the pending results are in the ledger. Exit 1: the host
// failed (an environment failure); it still writes an outcome when it can name the launch.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cardLaunch } from './card.ts';
import { loadCard, loadCardModules, parseSeatHostConfig, readSeatHostOutcome, runSeatHost, writeFailedOutcome, type SeatHostConfig } from './host.ts';

export const SEAT_HOST_MAIN = fileURLToPath(import.meta.url);

async function main(): Promise<number> {
  const path = process.argv[2];
  if (path === undefined) {
    process.stderr.write('usage: host-main.ts <seat-host-config.json>\n');
    return 1;
  }
  let config: SeatHostConfig;
  try {
    config = parseSeatHostConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    process.stderr.write(`seat host: bad config ${path}: ${(e as Error).message}\n`);
    return 1;
  }
  try {
    return await runSeatHost(config);
  } catch (e) {
    const msg = (e as Error).stack ?? String(e);
    process.stderr.write(`seat host failed: ${msg}\n`);
    try {
      await loadCardModules(config).catch(() => undefined);
      const card = loadCard(config);
      const launch = cardLaunch(card as unknown as { readonly launch: string });
      if (readSeatHostOutcome(config.stateDir, launch) === null) writeFailedOutcome(config.stateDir, launch, card.seat, `the host failed: ${(e as Error).message}`);
    } catch {
      /* the card itself is unreadable: the supervisor's proof and the missing outcome say enough */
    }
    return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`seat host: ${String(e)}\n`);
      process.exit(1);
    },
  );
}
