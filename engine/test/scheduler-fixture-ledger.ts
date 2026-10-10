// The ledger service process with fault injection, for the scheduler and watchdog tests (not
// a test file). The same as src/ledger/main.ts (open: writer lock, recovery pause, stops
// first; serve; heartbeat to the control plane; SIGTERM closes cleanly) plus:
//   faultFile   while it exists, every ledger write fails as an I/O error (storage fault), and
//               the heartbeat reports the fault (the medium is failing)
//   hangFile    when it exists at a write, the write takes it (renames it to <hangFile>.taken) and
//               blocks inside the service's action forever (an action stuck in the service): the
//               event loop stops, so the heartbeat stops too; a restarted service does not hang
//   bootIdFile  the boot id the service sees (a "reboot" is a new id in this file)
// Usage: scheduler-fixture-ledger.ts <config.json>

import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../src/common/fsx.ts';
import { serveLedger } from '../src/ledger/ipc.ts';
import { LedgerService, ledgerPaths } from '../src/ledger/service.ts';
import { recordLedgerExit } from '../src/ledger/shutdown.ts';

interface Config {
  readonly root: string;
  readonly controlPlane: string;
  readonly socket: string;
  readonly heartbeatMs?: number;
  readonly faultFile?: string;
  readonly hangFile?: string;
  readonly bootIdFile?: string;
}

const cfg = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as Config;
const sab = new Int32Array(new SharedArrayBuffer(4));

const svc = new LedgerService({
  paths: ledgerPaths(cfg.root, cfg.controlPlane),
  ...(cfg.bootIdFile !== undefined ? { bootId: () => readFileSync(cfg.bootIdFile as string, 'utf8').trim() } : {}),
  injectWriteFault: () => {
    if (cfg.hangFile !== undefined && existsSync(cfg.hangFile)) {
      renameSync(cfg.hangFile, `${cfg.hangFile}.taken`);
      for (;;) Atomics.wait(sab, 0, 0, 1000);
    }
    return cfg.faultFile !== undefined && existsSync(cfg.faultFile);
  },
});

let report: { recoveryPause: boolean; stopsCommitted: readonly string[] };
try {
  report = svc.open();
} catch (e) {
  process.stderr.write(`[ledger-fixture] open failed: ${(e as Error).message}\n`);
  process.exit(1);
}
const server = serveLedger(svc, cfg.socket);
const beat = (): void => {
  try {
    const injected = cfg.faultFile !== undefined && existsSync(cfg.faultFile);
    writeFileAtomic(join(cfg.controlPlane, 'ledger.heartbeat'), JSON.stringify({ pid: process.pid, at: Date.now(), head: svc.head(), storageFault: svc.inStorageFault || injected }));
  } catch {
    /* the watchdog sees a missing heartbeat */
  }
};
beat();
const timer = setInterval(beat, cfg.heartbeatMs ?? 200);
process.send?.({ type: 'ready', recoveryPause: report.recoveryPause, stopsCommitted: report.stopsCommitted });
// Clean shutdown as src/ledger/main.ts (v45 6.1 step 3): commit the staging copy and the
// inboxes, record the exit in the control plane for the probes, then close.
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
