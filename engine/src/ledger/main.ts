// The ledger service process (design 6.1: the only writer of the main ledger).
//
//   node --experimental-strip-types src/ledger/main.ts <config.json>
//
// Opens the ledger (taking the exclusive writer lock, committing stops left in
// the inbox and the control-plane spool first), serves requests on its Unix
// socket, picks up stops sent as files while it runs (a watcher on the
// control-plane signal, the spool and the inbox, plus a poll every 250 ms; each
// trigger runs a stop-priority drain: 6.1, core review r2 F2), and writes a
// heartbeat file to the control plane every second for the watchdog (6.3
// "监督"). SIGTERM closes it cleanly; anything else leaves the "running" marker,
// so the next start knows the shutdown was unclean.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../common/fsx.ts';
import { serveLedger } from './ipc.ts';
import { LedgerService, ledgerPaths } from './service.ts';
import { recordLedgerExit } from './shutdown.ts';

export interface LedgerMainConfig {
  readonly root: string;
  readonly controlPlane: string;
  readonly socket: string;
  readonly heartbeatMs?: number;
  /** Poll interval for stop files (at most 500 ms). */
  readonly stopPollMs?: number;
  /** Storage deadline for one transaction (default 5,000 ms). */
  readonly storageDeadlineMs?: number;
  /** The backup stop inbox file (another volume), as chosen at install; omitted: as the install recorded it. */
  readonly backupInbox?: string | null;
}

export function heartbeatPath(controlPlane: string): string {
  return join(controlPlane, 'ledger.heartbeat');
}

function main(): void {
  const cfg = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as LedgerMainConfig;
  const svc = new LedgerService({
    paths: ledgerPaths(cfg.root, cfg.controlPlane, cfg.backupInbox !== undefined ? { backupInbox: cfg.backupInbox } : {}),
    watchStops: cfg.stopPollMs !== undefined ? { pollMs: cfg.stopPollMs } : true,
    ...(cfg.storageDeadlineMs !== undefined ? { storageDeadlineMs: cfg.storageDeadlineMs } : {}),
  });
  const report = svc.open(); // also starts the stop watcher
  const server = serveLedger(svc, cfg.socket);
  const beat = (): void => {
    try {
      writeFileAtomic(heartbeatPath(cfg.controlPlane), JSON.stringify({ pid: process.pid, at: Date.now(), head: svc.head(), storageFault: svc.inStorageFault }));
    } catch {
      // The control plane is on tmpfs; a failed heartbeat is the watchdog's signal.
    }
  };
  beat();
  const timer = setInterval(beat, cfg.heartbeatMs ?? 1000);
  process.send?.({ type: 'ready', recoveryPause: report.recoveryPause, stopsCommitted: report.stopsCommitted });
  // Clean shutdown (v45 6.1 step 3): commit the staging copy and both inboxes, record the
  // exit in the control plane for the probes, then close.
  let exiting = false;
  const shutdown = (): void => {
    if (exiting) return;
    exiting = true;
    clearInterval(timer);
    server.close();
    void (async () => {
      let stagingEmpty = false;
      try {
        stagingEmpty = (await svc.shutdownDrain()).stagingEmpty;
      } catch {
        stagingEmpty = false;
      }
      const boot = svc.bootIdValue;
      if (boot !== null) {
        try {
          recordLedgerExit(cfg.controlPlane, { boot, pid: process.pid, clean: stagingEmpty && !svc.inStorageFault, stagingEmpty });
        } catch {
          /* no record: the probes do not write a clean exit */
        }
      }
      svc.close();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
