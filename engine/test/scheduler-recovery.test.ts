// The startup decision after a reboot (design v43 6.1 "开机后的处理", WI-12): the ledger decides
// and records it (`recovery.pause` records; `status().startup`). The scheduler follows it:
// "continued" resumes dispatch by itself and tells the PM, with the basis; after an abnormal
// stop without fault evidence (risk 28, maintainer's option A) the notice also carries the
// reminder the PM gives the user. "set" keeps everything paused until the PM records the
// user's answer (tested with a real reboot in v14-03).

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { RISK28_REMINDER } from '../src/scheduler/scheduler.ts';
import type { StartupDecision } from '../src/scheduler/ledger.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LedgerClient } from '../src/ledger/ipc.ts';
import { ControlPlane } from '../src/scheduler/controlPlane.ts';
import { cleanupEnvs, inProcessLedger, makeEnv, newScheduler, probeSpec, readJson, startWatched, waitFor } from './scheduler-fixtures.ts';

afterEach(cleanupEnvs);

describe('the startup decision after a reboot (v43 6.1, WI-12)', { timeout: 180_000 }, () => {
  test('a clean shutdown (the v45 sequence through the watchdog and its probe), then a reboot: the ledger decides "continued"; dispatch goes on by itself; one WI-12 notice with the basis', async () => {
    const e = makeEnv('cleanboot');
    const bootFile = join(e.root, 'boot-id');
    writeFileSync(bootFile, 'boot-A');
    const sysA = await startWatched(e, { bootIdFile: bootFile }, { probes: [probeSpec(e, 'boot-A')], boot: 'boot-A', shutdownMs: 20_000 });
    let sysB: Awaited<ReturnType<typeof startWatched>> | null = null;
    try {
      const c = new LedgerClient(e.socket, 5_000);
      await c.call('setMission', { mission: 'm-open', state: 'open' });
      c.close();
      await waitFor(() => readJson(join(e.cp, 'probes', 'primary.json')), 10_000, 'the probe beats');
      await sysA.close(); // the clean shutdown sequence
      assert.equal(sysA.w.lastShutdown?.ledgerExited, true);
      assert.equal(sysA.w.lastShutdown?.probesDone, true, 'the probe wrote its clean exit');
      // the machine reboots
      writeFileSync(bootFile, 'boot-B');
      sysB = await startWatched(e, { bootIdFile: bootFile }, { probes: [probeSpec(e, 'boot-B')], boot: 'boot-B' });
      const cp = new ControlPlane(e.cp);
      const n = await waitFor(() => cp.alerts().find((a) => a.category === 'startup-continued'), 20_000, 'the WI-12 notice');
      assert.equal(n.wi, 'WI-12');
      const d = (n.detail as { startup: StartupDecision }).startup;
      assert.deepEqual([d.state, d.basis.evidence, d.basis.previousBoot, d.basis.boot], ['continued', 'clean-shutdown', 'boot-A', 'boot-B']);
      assert.ok(!('reminder' in (n.detail as object)), 'no risk-28 reminder after a clean shutdown');
      const st = await waitFor(() => (cp.status()?.gen !== null && cp.status()?.recoveryPause === false ? cp.status() : null), 20_000, 'scheduler status');
      assert.equal(st.dispatchPaused, null);
    } finally {
      await sysB?.close();
    }
  });

  test('risk 28 (option A): an abnormal stop without fault evidence, with the spare inbox: continue, and the PM reminds the user', async () => {
    const e = makeEnv('risk28');
    const l = inProcessLedger(e);
    const decision: StartupDecision = {
      state: 'continued',
      basis: {
        boot: 'boot-2',
        previousBoot: 'boot-1',
        cleanShutdown: false,
        ledgerClosedCleanly: false,
        evidence: 'abnormal-stop-spare-inbox',
        backupConfigured: true,
        boots: [],
        work: { openMission: true, undecidedLaunch: false, unsettledIntent: false, queuedTask: true },
        stopsCommitted: 0,
        reminder: RISK28_REMINDER,
      },
      at: 1_700_000_000_000,
      clearedAt: null,
    };
    // the ledger cannot produce this row until the two probed inboxes exist (v43 6.1)
    const s = newScheduler(e, {}, { startup: async () => decision });
    try {
      await s.start({ startLoops: false });
      await s.tick();
      assert.equal(s.paused, false);
      const n = s.cp.alerts().find((a) => a.category === 'startup-continued-after-abnormal-stop');
      assert.equal(n?.wi, 'WI-12');
      assert.match(n?.defaultAction ?? '', /resumed automatically \(risk 28, option A\)/);
      assert.equal((n?.detail as { reminder: string }).reminder, RISK28_REMINDER);
      assert.ok(n?.defaultAction?.includes(RISK28_REMINDER));
    } finally {
      await s.close();
      await l.close();
    }
  });
});
