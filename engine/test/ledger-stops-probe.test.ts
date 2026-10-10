// Inbox probes and the clean shutdown (design v45 6.1 "收件箱探针", "干净退出记录").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { installInbox, readInboxSync, type InboxRecord } from '../src/ledger/inbox.ts';
import { ControlState } from '../src/ledger/controlState.ts';
import { InboxProbe, readProbeHeartbeat, type ProbeConfig } from '../src/ledger/probe.ts';
import { recordLedgerExit, runCleanShutdown, sealStopEntries } from '../src/ledger/shutdown.ts';
import { readBootId, stopEntry } from '../src/ledger/stops.ts';
import { LedgerService, ledgerPaths } from '../src/ledger/service.ts';
import { LedgerClient } from '../src/ledger/ipc.ts';
import { id, type MissionId, type StopId } from '../src/common/ids.ts';
import { ENGINE_SRC, tempPair, until } from './ledger-stops-fixtures.ts';

function records(file: string): InboxRecord[] {
  return readInboxSync(file).slots.flatMap((s) => (s.state === 'record' ? [s.record] : []));
}

function setup(withBackup = true) {
  const t = tempPair();
  const primary = join(t.primaryDir, 'primary.inbox');
  const backup = join(t.backupDir, 'backup.inbox');
  installInbox(primary, 'primary', { slots: 34 });
  if (withBackup) installInbox(backup, 'backup', { slots: 34 });
  const cp = join(t.primaryDir, 'cp');
  mkdirSync(cp, { recursive: true });
  const probe = (inbox: 'primary' | 'backup', boot: string, extra: Partial<ProbeConfig> = {}): InboxProbe =>
    new InboxProbe({ inbox, file: inbox === 'primary' ? primary : backup, other: withBackup ? (inbox === 'primary' ? 'backup' : 'primary') : null, controlPlane: cp, boot, intervalMs: 20, staleMs: 150, shutdownMs: 600, ...extra });
  return { t, primary, backup, cp, probe };
}

test('probe: alternates its two slots, updates its heartbeat after each fsynced write, and carries the earlier boot’s last probe', async () => {
  const s = setup(false);
  try {
    const a = s.probe('primary', 'boot-A');
    await a.start();
    for (let i = 0; i < 3; i++) await a.tick();
    const slots = readInboxSync(s.primary).slots;
    const probes = [slots[0], slots[1]].map((c) => (c?.state === 'record' && c.record.kind === 'probe' ? c.record.seq : null));
    assert.deepEqual(probes, [2, 1], 'the last two probes, alternating');
    const hb = readProbeHeartbeat(s.cp, 'primary')!;
    assert.equal(hb.boot, 'boot-A');
    const lastA = (slots[0] as { record: { at: number } }).record.at;
    a.close();
    // A new boot: its probe overwrites the slots but carries boot A's last probe.
    const b = s.probe('primary', 'boot-B');
    await b.start();
    await b.tick();
    await b.tick();
    const now = readInboxSync(s.primary).slots;
    for (const c of [now[0], now[1]]) {
      assert.ok(c?.state === 'record' && c.record.kind === 'probe' && c.record.boot === 'boot-B');
      assert.deepEqual(c.record.kind === 'probe' ? c.record.carried.map((x) => [x.boot, x.at]) : null, [['boot-A', lastA]]);
    }
    b.close();
  } finally {
    s.t.cleanup();
  }
});

test('probe: the other probe stale beyond 20 s (here 150 ms) → "other faulty since T"; "fault ended" only once it is back and no staged stop is uncommitted', async () => {
  const s = setup();
  try {
    const p = s.probe('primary', 'boot-A');
    const b = s.probe('backup', 'boot-A');
    await p.start();
    await b.start();
    await p.tick();
    await b.tick();
    const bLast = readProbeHeartbeat(s.cp, 'backup')!.at;
    // The backup's probe stops writing.
    const end = Date.now() + 300;
    while (Date.now() < end) {
      await p.tick();
      await new Promise((r) => setTimeout(r, 30));
    }
    const fault = records(s.primary).find((r) => r.kind === 'fault');
    assert.ok(fault && fault.kind === 'fault');
    assert.deepEqual([fault.subject, fault.other, fault.from, fault.to], ['other', 'backup', bLast, null]);
    // It comes back, but a staged stop is not committed yet: no "fault ended".
    mkdirSync(join(s.cp, 'stops'), { recursive: true });
    writeFileSync(join(s.cp, 'stops', 'S1.json'), JSON.stringify({ stop: 'S1', scope: { kind: 'all' }, words: '停', at: 1 }));
    await b.tick();
    await p.tick();
    await p.tick();
    assert.equal(records(s.primary).filter((r) => r.kind === 'fault-end').length, 0);
    const c = new ControlState(s.cp);
    c.markCommitted(['S1'], Date.now());
    c.close();
    await b.tick();
    await p.tick();
    const ended = records(s.primary).filter((r) => r.kind === 'fault-end');
    assert.deepEqual(ended.map((r) => (r.kind === 'fault-end' ? r.fault : null)), [fault.fault]);
    assert.deepEqual(p.openFaults(), []);
    p.close();
    b.close();
  } finally {
    s.t.cleanup();
  }
});

test('probe: its own writes failing → after recovery "I could not write from T1 to T2", then "fault ended"', async () => {
  const s = setup(false);
  try {
    const p = s.probe('primary', 'boot-A');
    await p.start();
    await p.tick();
    chmodSync(s.primary, 0o444);
    const t1 = Date.now();
    await p.tick();
    await p.tick();
    chmodSync(s.primary, 0o644);
    await p.tick();
    const t2 = Date.now();
    const rs = records(s.primary);
    const fault = rs.find((r) => r.kind === 'fault');
    assert.ok(fault && fault.kind === 'fault' && fault.subject === 'self');
    assert.ok(fault.from >= t1 - 5 && fault.to !== null && fault.to <= t2 && fault.to >= fault.from);
    assert.ok(rs.some((r) => r.kind === 'fault-end' && r.fault === fault.fault), 'ended in the same boot');
    p.close();
  } finally {
    s.t.cleanup();
  }
});

test('probe clean exit: only after the seal, with every earlier entry ended, a clean staging copy and the ledger’s clean exit after the seal; never after the deadline', async () => {
  const s = setup(false);
  try {
    // No ledger exit: no record, and the probe gives up at the deadline.
    const p1 = s.probe('primary', 'boot-A');
    await p1.start();
    sealStopEntries(s.cp, { boot: 'boot-A' });
    const t0 = Date.now();
    assert.equal(await p1.shutdown(), false);
    assert.ok(Date.now() - t0 < 1_500);
    assert.equal(records(s.primary).filter((r) => r.kind === 'clean-exit').length, 0);
    p1.close();
    // An entry registered before the seal and still running: no record either.
    const c = new ControlState(s.cp);
    c.registerEntry('e-open', 'boot-B', 'S9', process.pid, Date.now());
    c.close();
    sealStopEntries(s.cp, { boot: 'boot-B' });
    recordLedgerExit(s.cp, { boot: 'boot-B', pid: 1, clean: true, stagingEmpty: true });
    const p2 = s.probe('primary', 'boot-B');
    await p2.start();
    assert.equal(await p2.shutdown(), false);
    p2.close();
    // All conditions: the record, with the seal time.
    const seal = sealStopEntries(s.cp, { boot: 'boot-C' });
    await new Promise((r) => setTimeout(r, 5));
    recordLedgerExit(s.cp, { boot: 'boot-C', pid: 1, clean: true, stagingEmpty: true });
    const p3 = s.probe('primary', 'boot-C');
    await p3.start();
    assert.equal(await p3.shutdown(), true);
    const ce = records(s.primary).filter((r) => r.kind === 'clean-exit');
    assert.deepEqual(ce.map((r) => [r.boot, r.kind === 'clean-exit' ? r.sealedAt : null]), [['boot-C', seal.sealedAt]]);
    p3.close();
  } finally {
    s.t.cleanup();
  }
});

// ---------------------------------------------------------------- the whole sequence with real processes

function startProbe(dir: string, cfg: object): ChildProcess {
  const file = join(dir, `probe-${(cfg as { inbox: string }).inbox}.json`);
  writeFileSync(file, JSON.stringify(cfg));
  return spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(ENGINE_SRC, 'ledger', 'probe-main.ts'), file], { stdio: ['ignore', 'ignore', 'inherit'] });
}

function exited(child: ChildProcess): Promise<number | null> {
  return child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise((r) => child.once('exit', (c) => r(c)));
}

async function engine(t: ReturnType<typeof tempPair>) {
  const root = join(t.primaryDir, 'ledger');
  const cp = join(t.primaryDir, 'cp');
  const backup = join(t.backupDir, 'backup.inbox');
  const socket = join(t.primaryDir, 'ledger.sock');
  const cfg = join(t.primaryDir, 'ledger.json');
  writeFileSync(cfg, JSON.stringify({ root, controlPlane: cp, socket, heartbeatMs: 200, backupInbox: backup }));
  const ledger = fork(join(ENGINE_SRC, 'ledger', 'main.ts'), [cfg], { execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await new Promise<void>((resolve, reject) => {
    ledger.once('message', () => resolve());
    ledger.once('exit', (c) => reject(new Error(`ledger exited ${c}`)));
  });
  const paths = ledgerPaths(root, cp, { backupInbox: backup });
  const probes = (['primary', 'backup'] as const).map((inbox) =>
    startProbe(t.primaryDir, { inbox, file: inbox === 'primary' ? paths.inbox : backup, other: inbox === 'primary' ? 'backup' : 'primary', controlPlane: cp, intervalMs: 100, staleMs: 5_000, shutdownMs: 4_000 }),
  );
  await until(() => readProbeHeartbeat(cp, 'primary') !== null && readProbeHeartbeat(cp, 'backup') !== null, 10_000, 'both probes');
  return { root, cp, backup, socket, paths, ledger, probes };
}

test('clean shutdown with real processes: seal, the ledger drains and exits, the probes write "clean exit"; the next boot goes on even with open work', async () => {
  const t = tempPair();
  const e = await engine(t);
  try {
    const client = new LedgerClient(e.socket, 5_000);
    await client.call('setMission', { mission: 'm1', state: 'open' });
    client.close();
    // A stop sent just before the shutdown: persisted, and committed before the ledger exits.
    const sent = stopEntry(e.paths, { stop: id<StopId>('S-LAST'), scope: { kind: 'mission', mission: id<MissionId>('m1') }, words: '停', at: Date.now() });
    assert.equal(sent.result, 'persisted');
    const report = await runCleanShutdown({
      controlPlane: e.cp,
      stopLedger: async () => {
        e.ledger.kill('SIGTERM');
        return (await exited(e.ledger)) === 0;
      },
      stopProbes: async () => {
        for (const p of e.probes) p.kill('SIGTERM');
        const codes = await Promise.all(e.probes.map(exited));
        return codes.every((c) => c === 0);
      },
      totalMs: 15_000,
    });
    assert.deepEqual([report.entriesDone, report.ledgerExited, report.probesDone], [true, true, true]);
    const boot = readBootId();
    for (const f of [e.paths.inbox, e.backup]) assert.ok(records(f).some((r) => r.kind === 'clean-exit' && r.boot === boot), `clean exit in ${f}`);
    const db = new DatabaseSync(join(e.root, 'ledger.sqlite'), { readOnly: true });
    assert.ok(db.prepare("SELECT 1 FROM stops WHERE stop = 'S-LAST'").get(), 'committed before the ledger exited');
    db.close();
    // The machine reboots: the memory filesystem is gone, the boot id changes.
    rmSync(e.cp, { recursive: true, force: true });
    const svc = new LedgerService({ paths: e.paths, bootId: () => 'next-boot', watchStops: false });
    try {
      assert.equal(svc.open().recoveryPause, false, 'a clean shutdown goes on, open mission or not');
      const d = svc.startupDecision()!;
      assert.deepEqual([d.state, d.basis.evidence, d.basis.boots.map((b) => b.row)], ['continued', 'clean-shutdown', ['clean-shutdown']]);
      assert.equal(d.basis.reminder, null);
    } finally {
      svc.close();
    }
  } finally {
    for (const c of [e.ledger, ...e.probes]) if (c.exitCode === null) c.kill('SIGKILL');
    t.cleanup();
  }
});

test('shutdown cap: the ledger does not exit cleanly → no clean-exit record; the next boot is an abnormal stop: with a backup inbox it goes on and the PM reminds the user (risk 28, option A)', async () => {
  const t = tempPair();
  const e = await engine(t);
  try {
    const client = new LedgerClient(e.socket, 5_000);
    await client.call('setMission', { mission: 'm1', state: 'open' });
    client.close();
    const report = await runCleanShutdown({
      controlPlane: e.cp,
      stopLedger: async () => {
        e.ledger.kill('SIGKILL'); // no drain, no exit record
        await exited(e.ledger);
        return false;
      },
      stopProbes: async () => {
        for (const p of e.probes) p.kill('SIGTERM');
        const codes = await Promise.all(e.probes.map(exited));
        return codes.every((c) => c === 0);
      },
      totalMs: 15_000,
    });
    assert.deepEqual([report.ledgerExited, report.probesDone], [false, false]);
    for (const f of [e.paths.inbox, e.backup]) assert.equal(records(f).filter((r) => r.kind === 'clean-exit').length, 0);
    rmSync(e.cp, { recursive: true, force: true });
    const svc = new LedgerService({ paths: e.paths, bootId: () => 'next-boot', watchStops: false });
    try {
      assert.equal(svc.open().recoveryPause, false);
      const d = svc.startupDecision()!;
      assert.deepEqual([d.state, d.basis.evidence], ['continued', 'abnormal-stop-spare-inbox']);
      assert.match(d.basis.reminder ?? '', /did not see confirmed as 'persisted'/);
    } finally {
      svc.close();
    }
    assert.ok(existsSync(e.backup));
  } finally {
    for (const c of [e.ledger, ...e.probes]) if (c.exitCode === null) c.kill('SIGKILL');
    t.cleanup();
  }
});
