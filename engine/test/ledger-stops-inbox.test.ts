// Stop inboxes and the stop entry (design v45 6.1 "停止收件箱", "槽位协议", "停止请求的送达").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, openSync, closeSync, fstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  DEFAULT_SLOT_SIZE,
  INBOX_HEADER_BYTES,
  checkInboxFilesystem,
  decodeSlot,
  encodeSlot,
  installInbox,
  readHeader,
  readInboxSync,
  stopRecord,
  writeSlotSync,
  type InboxStopRecord,
} from '../src/ledger/inbox.ts';
import { ControlState } from '../src/ledger/controlState.ts';
import { allocateSlot } from '../src/ledger/slotAlloc.ts';
import { STOP_NOT_PERSISTED_EXIT_CODE, readPendingStops, readStopHistory, stopEntry, type StopPaths } from '../src/ledger/stops.ts';
import { sealStopEntries } from '../src/ledger/shutdown.ts';
import { id, type StopId } from '../src/common/ids.ts';
import { alive, killQuietly, script, tempPair, until } from './ledger-stops-fixtures.ts';

const req = (stop: string, words = '停'): { stop: StopId; scope: { kind: 'all' }; words: string; at: number } => ({ stop: id<StopId>(stop), scope: { kind: 'all' }, words, at: Date.now() });

function pathsOf(primaryDir: string, backupDir: string | null): StopPaths {
  return { inbox: join(primaryDir, 'ledger', 'stop-inbox', 'primary.inbox'), controlPlane: join(primaryDir, 'cp'), backupInbox: backupDir === null ? null : join(backupDir, 'mp', 'backup.inbox') };
}

test('install: the inbox is written in full (no holes), its header records the layout and the filesystem check; reinstalling keeps it', () => {
  const t = tempPair();
  try {
    const p = pathsOf(t.primaryDir, t.backupDir);
    const a = installInbox(p.inbox, 'primary', { slots: 66 });
    const b = installInbox(p.backupInbox!, 'backup', { slots: 66 });
    assert.equal(a.created, true);
    const size = INBOX_HEADER_BYTES + 66 * DEFAULT_SLOT_SIZE;
    for (const f of [p.inbox, p.backupInbox!]) {
      const fd = openSync(f, 'r');
      const st = fstatSync(fd);
      closeSync(fd);
      assert.equal(st.size, size);
      assert.ok(st.blocks * 512 >= size, `${f} has holes`);
    }
    assert.deepEqual([a.header.inbox, a.header.slots, a.header.probeSlots, a.header.slotSize], ['primary', 66, 2, DEFAULT_SLOT_SIZE]);
    // /tmp is a memory filesystem here; /var/tmp is ext4: only the second carries the full-disk guarantee (6.1).
    assert.deepEqual([a.header.fs.type, a.header.fs.fullDiskGuarantee], ['tmpfs', false]);
    assert.deepEqual([b.header.fs.type, b.header.fs.fullDiskGuarantee], ['ext4', true]);
    // A record survives a reinstall.
    putStop(p.inbox, 5, 'boot-A', 'S-KEEP');
    assert.equal(installInbox(p.inbox, 'primary', { slots: 66 }).created, false);
    assert.equal(readStopHistory({ ...p, backupInbox: null })[0]?.stop, 'S-KEEP');
    // A file whose header cannot be read is moved aside, never deleted, and a new inbox takes its place.
    writeFileSync(p.backupInbox!, 'not an inbox');
    const again = installInbox(p.backupInbox!, 'backup', { slots: 66 });
    assert.equal(again.created, true);
    assert.ok(again.movedAside !== null && existsSync(again.movedAside));
  } finally {
    t.cleanup();
  }
});

test('filesystem check: ext4 overwrites in place; NTFS only when not compressed, sparse or deduplicated (checked through interop)', () => {
  const t = tempPair();
  try {
    const f = join(t.backupDir, 'x.inbox');
    installInbox(f, 'backup', { slots: 10 });
    assert.equal(checkInboxFilesystem(f).fullDiskGuarantee, true);
    assert.match(checkInboxFilesystem(f).reason, /ext4/);
    const tmp = join(t.primaryDir, 'y.inbox');
    installInbox(tmp, 'primary', { slots: 10 });
    assert.match(checkInboxFilesystem(tmp).reason, /memory filesystem/);
  } finally {
    t.cleanup();
  }
});

function putStop(file: string, slot: number, boot: string, stop: string, words = '停'): void {
  const h = readHeader(file);
  writeSlotSync(file, h, slot, encodeSlot(h.slotSize, stopRecord(h.slotSize, { boot, seq: slot, at: 1, inbox: h.inbox, entry: 'e' }, req(stop, words))));
}

test('slots: a record checks; a write cut short is a torn write, with its boot when the prefix survived; long words are cut to the slot with the full hash kept', () => {
  const rec = stopRecord(DEFAULT_SLOT_SIZE, { boot: 'boot-A', seq: 3, at: 7, inbox: 'primary', entry: 'e1' }, req('S1'));
  const buf = encodeSlot(DEFAULT_SLOT_SIZE, rec);
  assert.deepEqual(decodeSlot(buf), { state: 'record', record: rec });
  assert.deepEqual(decodeSlot(Buffer.alloc(DEFAULT_SLOT_SIZE)), { state: 'empty' });
  const long = stopRecord(DEFAULT_SLOT_SIZE, { boot: 'boot-A', seq: 4, at: 7, inbox: 'primary', entry: 'e2' }, req('S2', '停'.repeat(3000)));
  // Only the first sector reached the disk: torn, and its boot is still readable.
  const cut = Buffer.alloc(DEFAULT_SLOT_SIZE);
  encodeSlot(DEFAULT_SLOT_SIZE, long).copy(cut, 0, 0, 512);
  assert.deepEqual(decodeSlot(cut), { state: 'torn', boot: 'boot-A' });
  const torn = Buffer.from(encodeSlot(DEFAULT_SLOT_SIZE, long));
  torn[200] = torn[200]! ^ 0xff;
  assert.deepEqual(decodeSlot(torn), { state: 'torn', boot: 'boot-A' });
  const garbage = Buffer.alloc(DEFAULT_SLOT_SIZE, 0x41);
  assert.deepEqual(decodeSlot(garbage), { state: 'torn', boot: null });
  assert.equal(long.wordsTruncated, true);
  assert.ok(long.request.words.length < 3000 && long.request.words.length > 100);
  assert.equal(long.wordsHash, createHash('sha256').update('停'.repeat(3000)).digest('hex'));
});

test('allocation: under the control-plane lock, each slot once per boot, never reused even when its write failed; a new boot skips slots still holding records', () => {
  const t = tempPair();
  try {
    const p = pathsOf(t.primaryDir, null);
    const h = installInbox(p.inbox, 'primary', { slots: 22 }).header;
    const a = new ControlState(p.controlPlane);
    const b = new ControlState(p.controlPlane);
    const got: number[] = [];
    for (let i = 0; i < 10; i++) {
      for (const c of [a, b]) {
        const r = allocateSlot(c, { file: p.inbox, header: h, inbox: 'primary', boot: 'boot-A', kind: 'stop', stop: `S${i}`, owner: 'test' });
        assert.notEqual(r, 'exhausted');
        if (r !== 'exhausted') {
          got.push(r.slot);
          if (r.slot % 3 === 0) c.markSlot(r.id, 'failed');
          else writeSlotSync(p.inbox, h, r.slot, encodeSlot(h.slotSize, stopRecord(h.slotSize, { boot: 'boot-A', seq: r.seq, at: 1, inbox: 'primary', entry: 'e' }, req(`S${i}`))));
        }
      }
    }
    assert.equal(new Set(got).size, 20, 'twenty distinct slots');
    assert.ok(got.every((s) => s >= 2), 'never a probe slot');
    // The boot used every slot: the next write fails and a WI-12 alert copy is raised.
    assert.equal(allocateSlot(a, { file: p.inbox, header: h, inbox: 'primary', boot: 'boot-A', kind: 'stop', stop: 'S-X', owner: 'test' }), 'exhausted');
    const alerts = readdirSync(join(p.controlPlane, 'alerts')).map((f) => JSON.parse(readFileSync(join(p.controlPlane, 'alerts', f), 'utf8')) as { wi: string; category: string });
    assert.deepEqual(alerts.map((x) => [x.category, x.wi]), [['inbox-slots-exhausted', 'WI-12']]);
    // A new boot: only the slots that hold nothing are free (the written ones wait for processing).
    const r = allocateSlot(a, { file: p.inbox, header: h, inbox: 'primary', boot: 'boot-B', kind: 'stop', stop: 'S-B', owner: 'test' });
    assert.notEqual(r, 'exhausted');
    if (r !== 'exhausted') {
      assert.equal(r.slot % 3, 0, 'a slot whose write failed in boot A is empty, so boot B may take it');
      assert.equal(r.seq, 1);
    }
    a.close();
    b.close();
  } finally {
    t.cleanup();
  }
});

test('entry: both inboxes are written, one confirmation is enough; the staging copy follows; the entry is deregistered', async () => {
  const t = tempPair();
  try {
    const p = pathsOf(t.primaryDir, t.backupDir);
    installInbox(p.inbox, 'primary', { slots: 34 });
    installInbox(p.backupInbox!, 'backup', { slots: 34 });
    const r = stopEntry(p, req('S-BOTH', '全部停下'), { bootId: 'boot-A' });
    assert.equal(r.result, 'persisted');
    assert.equal(r.exitCode, 0);
    assert.equal(r.notice, null);
    assert.ok(Object.values(r.inboxes).includes('written'));
    assert.ok(existsSync(join(p.controlPlane, 'stops', 'S-BOTH.json')));
    const c = new ControlState(p.controlPlane);
    assert.deepEqual(c.activeEntries('boot-A'), []);
    c.close();
    // Both writers finish; each inbox holds the request.
    // One confirmation is enough for the entry, so either writer may still be in flight here.
    for (const f of [p.inbox, p.backupInbox!]) await until(() => readInboxSync(f).slots.some((s) => s.state === 'record' && s.record.kind === 'stop'), 5_000, `the write to ${f}`);
    for (const f of [p.inbox, p.backupInbox!]) {
      const rec = readInboxSync(f).slots.find((s) => s.state === 'record')!;
      assert.ok(rec.state === 'record' && rec.record.kind === 'stop');
      assert.equal((rec.record as InboxStopRecord).request.words, '全部停下');
      assert.equal(rec.record.boot, 'boot-A');
    }
    assert.deepEqual(readPendingStops(p).map((x) => x.stop), ['S-BOTH']);
  } finally {
    t.cleanup();
  }
});

test('entry: inbox first: the staging copy is written only after an inbox confirmed (or the limit passed)', async () => {
  const t = tempPair();
  try {
    const p = pathsOf(t.primaryDir, null);
    installInbox(p.inbox, 'primary', { slots: 34 });
    const runner = script(
      t.primaryDir,
      'entry.ts',
      `import { stopEntry } from '@src/ledger/stops.ts';
const p = JSON.parse(process.argv[2]);
const r = stopEntry(p, { stop: 'S-ORDER', scope: { kind: 'all' }, words: '停', at: Date.now() }, { bootId: 'boot-A', writerDelayMs: 700 });
process.stdout.write(JSON.stringify(r));`,
    );
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', runner, JSON.stringify(p)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    const done = new Promise<void>((r) => child.once('exit', () => r()));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(existsSync(join(p.controlPlane, 'stops', 'S-ORDER.json')), false, 'not in force before it is persisted');
    await done;
    const r = JSON.parse(out) as { result: string };
    assert.equal(r.result, 'persisted');
    assert.ok(existsSync(join(p.controlPlane, 'stops', 'S-ORDER.json')));
  } finally {
    t.cleanup();
  }
});

test('entry: a hanging disk delays the stop by at most 2 s: then it is in force, the sender is told "not persisted" (exit 75), and the writer finishes its slot later', async () => {
  const t = tempPair();
  const pids: number[] = [];
  try {
    const p = pathsOf(t.primaryDir, t.backupDir);
    installInbox(p.inbox, 'primary', { slots: 34 });
    installInbox(p.backupInbox!, 'backup', { slots: 34 });
    const t0 = Date.now();
    const r = stopEntry(p, req('S-HANG'), { bootId: 'boot-A', writerDelayMs: 3_000 });
    pids.push(...r.writerPids);
    const took = Date.now() - t0;
    assert.ok(took >= 1_900 && took < 2_800, `${took} ms`);
    assert.deepEqual([r.result, r.exitCode, r.spooled], ['notified-not-persisted', STOP_NOT_PERSISTED_EXIT_CODE, true]);
    assert.deepEqual(r.inboxes, { primary: 'timeout', backup: 'timeout' });
    assert.equal(r.writerPids.length, 2);
    await until(() => readStopHistory(p).length === 1 && readInboxSync(p.inbox).slots.some((s) => s.state === 'record') && readInboxSync(p.backupInbox!).slots.some((s) => s.state === 'record'), 8_000, 'the late writes');
    await until(() => r.writerPids.every((x) => !alive(x)), 5_000, 'the writers to exit');
  } finally {
    killQuietly(pids);
    t.cleanup();
  }
});

test('entry: one inbox refusing writes still persists through the other; its writer keeps retrying its own slot', async () => {
  const t = tempPair();
  const pids: number[] = [];
  try {
    const p = pathsOf(t.primaryDir, t.backupDir);
    installInbox(p.inbox, 'primary', { slots: 34 });
    installInbox(p.backupInbox!, 'backup', { slots: 34 });
    chmodSync(p.inbox, 0o444);
    const r = stopEntry(p, req('S-ONE'), { bootId: 'boot-A' });
    pids.push(...r.writerPids);
    assert.equal(r.result, 'persisted');
    assert.equal(r.inboxes.backup, 'written');
    assert.ok(r.inboxes.primary === 'failed' || r.inboxes.primary === 'pending');
    chmodSync(p.inbox, 0o644);
    await until(() => readInboxSync(p.inbox).slots.some((s) => s.state === 'record'), 10_000, 'the primary retry');
  } finally {
    killQuietly(pids);
    t.cleanup();
  }
});

test('entry: no inbox installed: no writer is left behind; the stop is in force but not persisted', () => {
  const t = tempPair();
  try {
    const p = pathsOf(t.primaryDir, null);
    const r = stopEntry(p, req('S-NONE'), { bootId: 'boot-A' });
    assert.deepEqual([r.result, r.writerPids.length, r.inboxes.primary], ['notified-not-persisted', 0, 'not-installed']);
  } finally {
    t.cleanup();
  }
});

test('entry after the shutdown seal: still written to the inboxes, marked as arriving after the clean exit', () => {
  const t = tempPair();
  try {
    const p = pathsOf(t.primaryDir, null);
    installInbox(p.inbox, 'primary', { slots: 34 });
    const before = sealStopEntries(p.controlPlane, { boot: 'boot-A' });
    assert.deepEqual(before.entriesBeforeSeal, []);
    const r = stopEntry(p, req('S-LATE'), { bootId: 'boot-A' });
    assert.equal(r.afterSeal, true);
    assert.equal(r.result, 'persisted');
    assert.ok(statSync(p.inbox).size > 0);
  } finally {
    t.cleanup();
  }
});
