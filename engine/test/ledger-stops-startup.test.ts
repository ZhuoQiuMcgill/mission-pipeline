// The decision after a reboot (design v45 6.1 "开机后的处理", "异常重启后暂停"; WI-12;
// risk 28 option A), the reclaim of processed boots, and core review r3 #12 and #13.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeSlot, readHeader, readInboxSync, stopRecord, writeSlotSync, type InboxRecord } from '../src/ledger/inbox.ts';
import { LedgerError, LedgerService, ledgerPaths, type LedgerPaths } from '../src/ledger/service.ts';
import { readRecords } from '../src/ledger/store.ts';
import { RISK28_REMINDER } from '../src/ledger/startup.ts';
import { revision, id, type Generation, type LaunchId, type MissionId, type StopId } from '../src/common/ids.ts';
import { putRecord, script, tempPair, until } from './ledger-stops-fixtures.ts';

const M = id<MissionId>('m1');

interface World {
  readonly paths: LedgerPaths;
  readonly backup: string | null;
  readonly cleanup: () => void;
  readonly dir: string;
}

function world(withBackup: boolean): World {
  const t = tempPair();
  const backup = withBackup ? join(t.backupDir, 'backup.inbox') : null;
  return { paths: ledgerPaths(join(t.primaryDir, 'ledger'), join(t.primaryDir, 'cp'), { backupInbox: backup }), backup, cleanup: t.cleanup, dir: t.primaryDir };
}

const svcOf = (w: World, boot: string): LedgerService => new LedgerService({ paths: w.paths, bootId: () => boot, watchStops: false, inboxSlots: 34 });

/** Boot A ran (with open work, unless `work` is false), then the machine stopped: no close, the memory filesystem gone. */
async function bootA(w: World, work = true): Promise<void> {
  const svc = svcOf(w, 'boot-A');
  svc.open();
  if (work) await svc.setMission(M, 'open');
  svc.unwatchStops();
  const x = svc as unknown as { lock: { release(): void }; store: { close(): void } | null; control: { close(): void } | null };
  x.control?.close();
  x.store?.close();
  x.store = null;
  x.lock.release();
  rmSync(w.paths.controlPlane, { recursive: true, force: true });
}

const probe = (boot: string, inbox: 'primary' | 'backup', seq: number, at: number): InboxRecord => ({ kind: 'probe', boot, seq, at, inbox, carried: [] });
const cleanExit = (boot: string, inbox: 'primary' | 'backup'): InboxRecord => ({ kind: 'clean-exit', boot, seq: 9, at: 5_000, inbox, sealedAt: 4_000 });
const fault = (boot: string, inbox: 'primary' | 'backup', f: string): InboxRecord => ({ kind: 'fault', boot, seq: 7, at: 3_000, inbox, fault: f, subject: 'other', other: inbox === 'primary' ? 'backup' : 'primary', from: 2_000, to: null });
const faultEnd = (boot: string, inbox: 'primary' | 'backup', f: string): InboxRecord => ({ kind: 'fault-end', boot, seq: 8, at: 3_500, inbox, fault: f });

/** Both probes ran to the end (close together) and both wrote a clean exit. */
function cleanEvidence(w: World): void {
  putRecord(w.paths.inbox, 0, probe('boot-A', 'primary', 40, 100_000));
  putRecord(w.backup!, 0, probe('boot-A', 'backup', 41, 104_000));
  putRecord(w.paths.inbox, 5, cleanExit('boot-A', 'primary'));
  putRecord(w.backup!, 5, cleanExit('boot-A', 'backup'));
}

function openB(w: World): { svc: LedgerService; paused: boolean } {
  const svc = svcOf(w, 'boot-B');
  return { svc, paused: svc.open().recoveryPause };
}

async function decide(w: World, prepare: () => void, expect: { paused: boolean; row: string; reminder?: boolean }): Promise<LedgerService> {
  await bootA(w);
  prepare();
  const { svc, paused } = openB(w);
  const d = svc.startupDecision()!;
  assert.equal(paused, expect.paused, JSON.stringify(d.basis.boots));
  assert.equal(d.basis.evidence, expect.row);
  assert.equal(d.basis.reminder !== null, expect.reminder ?? false);
  return svc;
}

test('clean exit on every inbox, no fault evidence: go on; boot A is marked processed and only then its slots are reclaimed', async () => {
  const w = world(true);
  try {
    const svc = await decide(w, () => cleanEvidence(w), { paused: false, row: 'clean-shutdown' });
    const b = svc.startupDecision()!.basis.boots[0]!;
    assert.deepEqual([b.boot, [...b.cleanExit].sort(), b.probeGapMs], ['boot-A', ['backup', 'primary'], 4_000]);
    for (const f of [w.paths.inbox, w.backup!]) {
      const slots = readInboxSync(f).slots;
      assert.equal(slots[5]?.state, 'empty', 'boot A’s clean-exit slot reclaimed');
      assert.equal(slots[0]?.state, 'record', 'the probe’s own slot is not reclaimed (its probe is carried)');
    }
    // The decision is made once: a leftover record of the processed boot is ignored and reclaimed later.
    svc.close();
    putRecord(w.paths.inbox, 6, fault('boot-A', 'primary', 'late'));
    const again = svcOf(w, 'boot-B');
    again.open();
    assert.equal(readRecords(w.paths.db, revision(0)).filter((c) => c.record.kind === 'recovery.pause').length, 1);
    assert.equal(readInboxSync(w.paths.inbox).slots[6]?.state, 'empty');
    again.close();
  } finally {
    w.cleanup();
  }
});

test('fault evidence: an unended fault record → recovery pause (WI-12); a fault ended in the same boot is not evidence', async () => {
  for (const ended of [false, true]) {
    const w = world(true);
    try {
      const svc = await decide(
        w,
        () => {
          cleanEvidence(w);
          putRecord(w.paths.inbox, 6, fault('boot-A', 'primary', 'f1'));
          if (ended) putRecord(w.paths.inbox, 7, faultEnd('boot-A', 'primary', 'f1'));
        },
        ended ? { paused: false, row: 'clean-shutdown' } : { paused: true, row: 'fault-evidence' },
      );
      if (!ended) assert.deepEqual(svc.startupDecision()!.basis.boots[0]!.openFaults, ['primary:f1']);
      svc.close();
    } finally {
      w.cleanup();
    }
  }
});

test('fault evidence: "fault ended" cannot be written across boots: an end recorded in a later boot leaves the earlier fault open', async () => {
  const w = world(true);
  try {
    const svc = await decide(
      w,
      () => {
        cleanEvidence(w);
        putRecord(w.paths.inbox, 6, fault('boot-A', 'primary', 'f1'));
        putRecord(w.paths.inbox, 7, faultEnd('boot-B', 'primary', 'f1'));
      },
      { paused: true, row: 'fault-evidence' },
    );
    svc.close();
  } finally {
    w.cleanup();
  }
});

test('fault evidence: a torn write, with its boot readable or not → recovery pause', async () => {
  for (const attributable of [true, false]) {
    const w = world(true);
    try {
      const svc = await decide(
        w,
        () => {
          cleanEvidence(w);
          const h = readHeader(w.paths.inbox);
          const torn = Buffer.alloc(h.slotSize);
          if (attributable) {
            encodeSlot(h.slotSize, stopRecord(h.slotSize, { boot: 'boot-A', seq: 3, at: 1, inbox: 'primary', entry: 'e' }, { stop: id<StopId>('S-TORN'), scope: { kind: 'all' }, words: '停'.repeat(250), at: 1 })).copy(torn, 0, 0, 512);
          } else torn.fill(0x5a);
          writeSlotSync(w.paths.inbox, h, 9, torn);
        },
        { paused: true, row: 'fault-evidence' },
      );
      const b = svc.startupDecision()!.basis.boots[0]!;
      assert.deepEqual([b.tornWrites, b.unattributedTorn], attributable ? [1, 0] : [0, 1]);
      assert.equal(readInboxSync(w.paths.inbox).slots[9]?.state, 'empty', 'counted, then reclaimed');
      svc.close();
    } finally {
      w.cleanup();
    }
  }
});

test('fault evidence: the two inboxes’ last probes more than 20 s apart, or probes in one inbox only → recovery pause', async () => {
  for (const shape of ['gap', 'one-sided'] as const) {
    const w = world(true);
    try {
      const svc = await decide(
        w,
        () => {
          putRecord(w.paths.inbox, 0, probe('boot-A', 'primary', 40, 100_000));
          if (shape === 'gap') putRecord(w.backup!, 0, probe('boot-A', 'backup', 41, 125_000));
        },
        { paused: true, row: 'fault-evidence' },
      );
      const b = svc.startupDecision()!.basis.boots[0]!;
      if (shape === 'gap') assert.equal(b.probeGapMs, 25_000);
      else assert.equal(b.probesOneSided, true);
      svc.close();
    } finally {
      w.cleanup();
    }
  }
});

test('fault evidence: an inbox that cannot be read → recovery pause; it is installed again for the new boot', async () => {
  const w = world(true);
  try {
    const svc = await decide(
      w,
      () => {
        cleanEvidence(w);
        writeFileSync(w.backup!, 'damaged');
      },
      { paused: true, row: 'fault-evidence' },
    );
    assert.deepEqual(svc.startupDecision()!.basis.boots[0]!.unreadable, ['backup']);
    assert.deepEqual(
      svc.status().inboxes.map((i) => [i.name, i.readable]),
      [
        ['primary', true],
        ['backup', true],
      ],
    );
    svc.close();
  } finally {
    w.cleanup();
  }
});

test('abnormal stop, no fault evidence, a backup inbox: go on, and the PM reminds the user (risk 28, option A)', async () => {
  const w = world(true);
  try {
    const svc = await decide(
      w,
      () => {
        putRecord(w.paths.inbox, 0, probe('boot-A', 'primary', 40, 100_000));
        putRecord(w.backup!, 0, probe('boot-A', 'backup', 41, 108_000));
      },
      { paused: false, row: 'abnormal-stop-spare-inbox', reminder: true },
    );
    assert.equal(svc.startupDecision()!.basis.reminder, RISK28_REMINDER);
    svc.close();
  } finally {
    w.cleanup();
  }
});

test('abnormal stop without a backup inbox: recovery pause when work could advance; without work, go on', async () => {
  for (const work of [true, false]) {
    const w = world(false);
    try {
      await bootA(w, work);
      const { svc, paused } = openB(w);
      assert.equal(paused, work);
      assert.equal(svc.startupDecision()!.basis.evidence, 'abnormal-stop-no-spare-inbox');
      if (work) {
        const gen = await svc.beginGeneration();
        await assert.rejects(svc.registerLaunch({ op: 'l', gen, launch: id<LaunchId>('L'), tag: { mission: M, capabilities: [] } }), (e: unknown) => e instanceof LedgerError && e.code === 'RECOVERY_PAUSED' && e.wi === 'WI-12');
      }
      svc.close();
    } finally {
      w.cleanup();
    }
  }
});

test('core review r3 #13: the service’s clean exit is not a clean machine shutdown: open mission, clean close, abnormal reboot → recovery pause', async () => {
  const w = world(false);
  try {
    const a = svcOf(w, 'boot-A');
    a.open();
    await a.setMission(M, 'open');
    a.close(); // the service exits cleanly...
    rmSync(w.paths.controlPlane, { recursive: true, force: true }); // ...then the machine stops abnormally
    const { svc, paused } = openB(w);
    assert.equal(paused, true);
    const d = svc.startupDecision()!;
    assert.deepEqual([d.basis.ledgerClosedCleanly, d.basis.cleanShutdown, d.basis.evidence], [true, false, 'abnormal-stop-no-spare-inbox']);
    svc.close();
  } finally {
    w.cleanup();
  }
});

test('stops first: every stop both inboxes hold (any boot) is committed before the decision is recorded', async () => {
  const w = world(true);
  try {
    await bootA(w);
    const s = (stop: string, inbox: 'primary' | 'backup', words = '停'): InboxRecord => stopRecord(1024, { boot: 'boot-A', seq: 3, at: 1, inbox, entry: 'e' }, { stop: id<StopId>(stop), scope: { kind: 'mission', mission: M }, words, at: 1 });
    putRecord(w.backup!, 3, s('S-BACKUP-ONLY', 'backup'));
    putRecord(w.paths.inbox, 3, s('S-BOTH', 'primary'));
    putRecord(w.backup!, 4, s('S-BOTH', 'backup'));
    putRecord(w.paths.inbox, 4, s('S-LONG', 'primary', '停'.repeat(900)));
    const { svc } = openB(w);
    const log = readRecords(w.paths.db, revision(0));
    const committed = log.filter((c) => c.record.kind === 'stop.committed');
    const decision = log.find((c) => c.record.kind === 'recovery.pause')!;
    assert.deepEqual(committed.map((c) => (c.record as { stop: string }).stop).sort(), ['S-BACKUP-ONLY', 'S-BOTH', 'S-LONG']);
    assert.ok(committed.every((c) => c.revision < decision.revision));
    assert.match((committed.find((c) => (c.record as { stop: string }).stop === 'S-LONG')!.record as { words: string }).words, /…$/, 'cut words are marked');
    assert.equal(svc.startupDecision()!.basis.stopsCommitted, 3);
    svc.close();
  } finally {
    w.cleanup();
  }
});

test('a service restart in the same boot makes no decision and reclaims nothing of the current boot', async () => {
  const w = world(true);
  try {
    const a = svcOf(w, 'boot-A');
    a.open();
    a.close();
    putRecord(w.paths.inbox, 5, fault('boot-A', 'primary', 'f-now'));
    const again = svcOf(w, 'boot-A');
    again.open();
    assert.equal(again.startupDecision(), null);
    assert.equal(readInboxSync(w.paths.inbox).slots[5]?.state, 'record');
    again.close();
  } finally {
    w.cleanup();
  }
});

test('core review r3 #12: a backlog in the queue does not starve a stop: committed within 2 s, every later dispatch in scope refused', async () => {
  const w = world(false);
  let slow = false;
  const svc = new LedgerService({ paths: w.paths, bootId: () => 'boot-A', watchStops: true, inboxSlots: 34, injectWriteDelayMs: () => (slow ? 20 : 0) });
  try {
    svc.open();
    await svc.setMission(M, 'open');
    const gen: Generation = await svc.beginGeneration();
    const ready = join(w.dir, 'ready');
    const done = join(w.dir, 'done');
    const sender = script(
      w.dir,
      'sender.ts',
      `import { writeFileSync } from 'node:fs';
import { stopEntry } from '@src/ledger/stops.ts';
const job = JSON.parse(process.argv[2]);
writeFileSync(job.ready, 'ready');
setTimeout(() => {
  const at = Date.now();
  const r = stopEntry(job.paths, { stop: 'QSTOP', scope: { kind: 'all' }, words: '停', at }, { bootId: 'boot-A' });
  writeFileSync(job.done, JSON.stringify({ at, returned: Date.now(), result: r.result }));
}, 300);`,
    );
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', sender, JSON.stringify({ paths: w.paths, ready, done })], { stdio: ['ignore', 'ignore', 'inherit'] });
    await until(() => existsSync(ready), 10_000, 'the sender');
    slow = true;
    const ps = Array.from({ length: 500 }, (_, i) => svc.registerLaunch({ op: `queued-${i}`, gen, launch: id<LaunchId>(`Q${i}`), tag: { mission: M, capabilities: [] } }));
    await until(() => svc.activeStopIds().includes(id<StopId>('QSTOP')), 15_000, 'the stop');
    const committedAt = Date.now();
    const results = await Promise.allSettled(ps);
    slow = false;
    await new Promise<void>((r) => (child.exitCode !== null ? r() : child.once('exit', () => r())));
    const sent = JSON.parse(readFileSync(done, 'utf8')) as { at: number; result: string };
    assert.equal(sent.result, 'persisted');
    const lag = committedAt - sent.at;
    assert.ok(lag < 2_000, `the stop waited ${lag} ms behind the backlog (r3 measured 10,213 ms)`);
    const accepted = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter((r) => r.status === 'rejected' && (r.reason as LedgerError).code === 'STOPPED').length;
    assert.equal(accepted + refused, 500);
    assert.ok(refused > 300, `${refused} dispatches refused after the stop`);
  } finally {
    svc.close();
    w.cleanup();
  }
});

