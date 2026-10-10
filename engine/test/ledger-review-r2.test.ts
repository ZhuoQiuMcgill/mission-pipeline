// Ledger service: regressions for the core review round 2 (gpt-6.1-sol) findings
// F1, F2, F7, F10, F11, F15, F17, F21. Several tests replay the reviewer's repro
// scripts (scratch/review-r2.ts, review-bounds-r2.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { LedgerError, LedgerService, MAX_LIST_ITEMS, ledgerPaths, type LedgerPaths, type ServiceOptions } from '../src/ledger/service.ts';
import { STOP_NOT_PERSISTED_EXIT_CODE, STOP_NOT_PERSISTED_NOTICE, readPendingStops, readStopHistory, sendStop, stopEntry, type StopRequest } from '../src/ledger/stops.ts';
import { encodeSlot, installInbox, readHeader, stopRecord, writeSlotSync } from '../src/ledger/inbox.ts';
import { ControlState } from '../src/ledger/controlState.ts';
import { allocateSlot } from '../src/ledger/slotAlloc.ts';
import { STATE_KEYS, STATE_TABLES, readJournal, readRecords } from '../src/ledger/store.ts';
import { rebuildStateFromLog } from '../src/ledger/rebuild.ts';
import { mkdirDurable } from '../src/ledger/durable.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { scanStringList } from '../src/ledger/verify.ts';
import { fsyncDir, writeFileAtomic } from '../src/common/fsx.ts';
import { sha256 } from '../src/common/hash.ts';
import {
  id,
  revision,
  type AlertId,
  type BasisLineId,
  type BasisVersionId,
  type ContentHash,
  type EpisodeBatchId,
  type Generation,
  type LaunchId,
  type MissionId,
  type OpId,
  type ReservationId,
  type StopId,
  type JudgmentId,
} from '../src/common/ids.ts';
import type { BaseRecord, ListRef, TerminationProofRecord } from '../src/common/records.ts';

const M = id<MissionId>('m1');
const IDENT = { pid: process.pid, startTime: 'test-start', bootId: 'test-boot' };

function fresh(): { dir: string; paths: LedgerPaths; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mp-ledger-r2-'));
  return { dir, paths: ledgerPaths(join(dir, 'ledger'), join(dir, 'control')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function service(opts: Partial<ServiceOptions> = {}): { svc: LedgerService; dir: string; paths: LedgerPaths; cleanup: () => void } {
  const f = fresh();
  const svc = new LedgerService({ paths: f.paths, ...opts });
  svc.open();
  return {
    svc,
    dir: f.dir,
    paths: f.paths,
    cleanup: () => {
      try {
        svc.close();
      } finally {
        f.cleanup();
      }
    },
  };
}

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof LedgerError, `not a LedgerError: ${String(e)}`);
    assert.equal(e.code, code, e.message);
    return true;
  });
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A crash: the process dies without close(); the kernel drops the lock. */
function crash(svc: LedgerService): void {
  svc.unwatchStops();
  const x = svc as unknown as { lock: { release(): void }; store: { close(): void } };
  x.store.close();
  x.lock.release();
}

function basis(n: number): BaseRecord {
  return { kind: 'basis.version', basisKind: 'requirement', line: id<BasisLineId>('req-a'), version: id<BasisVersionId>(`req-a.v${n}`), mission: M, scope: null };
}

function objectVersion(svc: LedgerService, object: string, extra: Record<string, unknown> = {}): BaseRecord {
  return {
    kind: 'object.version',
    object: object as never,
    objectKind: 'product',
    mission: M,
    module: null,
    content: svc.content.put(`body of ${object}`),
    prerequisites: svc.content.putList([]),
    scope: { paths: ['src/x.ts'], taskType: 'construct' },
    reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
    ...extra,
  } as BaseRecord;
}

function proof(launch: string): TerminationProofRecord {
  return { kind: 'termination.proof', launch: id<LaunchId>(launch), exit: { code: 0, signal: null }, controlOomKill: 0, unitOomKill: 0, unitOom: 0 };
}

function pendingOp(op: string, objects: ListRef, scope = { mission: M, capabilities: [] as string[] }): BaseRecord {
  return { kind: 'op.pending', op: id<OpId>(op), opKind: 'delivery', objects, scope };
}

// ---------------------------------------------------------------- F1

test('F1: an action for a launch is checked against the launch’s persisted scope; a different request tag is refused', async () => {
  const { svc, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    const L = id<LaunchId>('L');
    await svc.registerLaunch({ op: 'l', gen, launch: L, tag: { mission: M, capabilities: ['net', 'shell'] } });
    await svc.stop({ stop: id<StopId>('CAP'), scope: { kind: 'capability', capability: 'net' }, words: 'no net', at: 1 });
    const auth = (op: string, intent: string, tag: { mission: MissionId; capabilities: string[] }) =>
      svc.authorize({ op, gen, launch: L, intent, kind: 'network', domain: `net:${intent}`, tag, details: {} });
    // The reviewer's repro: the launch has `net`, the stop covers `net`, the request claimed no capabilities.
    await rejects(auth('a1', 'I1', { mission: M, capabilities: [] }), 'SCOPE_MISMATCH');
    await rejects(auth('a2', 'I2', { mission: id<MissionId>('other'), capabilities: ['net', 'shell'] }), 'SCOPE_MISMATCH');
    // The launch's own scope (any order, duplicates ignored) is the one checked against stops.
    await rejects(auth('a3', 'I3', { mission: M, capabilities: ['shell', 'net'] }), 'STOPPED');
    await svc.releaseStop(id<StopId>('CAP'));
    await auth('a4', 'I4', { mission: M, capabilities: ['shell', 'net', 'net'] });
    assert.deepEqual(svc.intentInfo('I4')?.capabilities, ['net', 'shell'], 'the intent keeps the persisted scope');
  } finally {
    cleanup();
  }
});

test('F1: a proof-conditioned operation is checked against the scope fixed at its registration; a mismatching tag is refused', async () => {
  const { svc, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    const { epoch } = await svc.beginEvaluator({ gen, identity: IDENT });
    await svc.appendRecords({ op: 'reg', gen: null, records: [pendingOp('SCOPED_D', svc.content.putList(['P']))] });
    await svc.publish({ epoch, revision: svc.head(), batch: null });
    await svc.stop({ stop: id<StopId>('MISSION_STOP'), scope: { kind: 'mission', mission: M }, words: 'stop m1', at: 3 });
    const floor = svc.publicationFloor();
    // The reviewer's repro: the delivery is mission m1's; a tag naming another mission used to bypass the stop.
    await rejects(svc.commitProofOp({ op: 'x1', gen, opId: id<OpId>('SCOPED_D'), asOf: floor, tag: { mission: id<MissionId>('other'), capabilities: [] } }), 'SCOPE_MISMATCH');
    // Without a tag the registered scope is used.
    await rejects(svc.commitProofOp({ op: 'x2', gen, opId: id<OpId>('SCOPED_D'), asOf: floor }), 'STOPPED');
    await svc.releaseStop(id<StopId>('MISSION_STOP'));
    await svc.commitProofOp({ op: 'x3', gen, opId: id<OpId>('SCOPED_D'), asOf: floor, tag: { mission: M, capabilities: [] } });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- F2

test('F2: the running service commits a stop sent as files within seconds; the next dispatch in scope is refused, no explicit drain', async () => {
  const { svc, paths, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    const t0 = Date.now();
    assert.deepEqual(sendStop(paths, { stop: id<StopId>('FILE_STOP'), scope: { kind: 'all' }, words: '停', at: Date.now() }), { durable: true, spooled: true });
    await until(() => svc.activeStopIds().includes(id<StopId>('FILE_STOP')), 2000, 'the stop to be committed');
    await rejects(svc.registerLaunch({ op: 'after-file-stop', gen, launch: id<LaunchId>('L'), tag: { mission: M, capabilities: ['net'] } }), 'STOPPED');
    assert.ok(Date.now() - t0 < 2000, `refused ${Date.now() - t0} ms after the stop was sent`);
    // The inbox holds the persisted copy; reports that list what was sent (the WI-12 check) see it.
    assert.deepEqual(readStopHistory(paths).map((r) => r.stop), ['FILE_STOP']);
  } finally {
    cleanup();
  }
});

test('F2: a stop that reaches only an inbox slot (no staging copy, no signal) is still committed by the poll', async () => {
  const { svc, paths, cleanup } = service({ watchStops: { pollMs: 100 }, inboxSlots: 34 });
  try {
    const req: StopRequest = { stop: id<StopId>('INBOX_ONLY'), scope: { kind: 'mission', mission: M }, words: 'stop', at: Date.now() };
    // What a writer does when the entry dies before the staging copy: allocate, write, mark.
    const control = new ControlState(paths.controlPlane);
    try {
      const h = readHeader(paths.inbox);
      const boot = svc.bootIdValue!;
      const a = allocateSlot(control, { file: paths.inbox, header: h, inbox: 'primary', boot, kind: 'stop', stop: req.stop, owner: 'test' });
      assert.notEqual(a, 'exhausted');
      if (a === 'exhausted') return;
      writeSlotSync(paths.inbox, h, a.slot, encodeSlot(h.slotSize, stopRecord(h.slotSize, { boot, seq: a.seq, at: Date.now(), inbox: 'primary', entry: 'e1' }, req)));
      control.markSlot(a.id, 'written');
    } finally {
      control.close();
    }
    await until(() => svc.activeStopIds().includes(req.stop), 2000, 'the inbox-only stop');
  } finally {
    cleanup();
  }
});

test('F20 (v45 inbox first): an inbox write not confirmed within 2 s is reported, the stop is then in force, and the writer keeps writing its own slot until it persists', async () => {
  const { chmodSync } = await import('node:fs');
  const base = mkdtempSync(join(tmpdir(), 'mp-stop-send-'));
  let pid: number | null = null;
  try {
    const paths = { inbox: join(base, 'ledger', 'stop-inbox', 'primary.inbox'), controlPlane: join(base, 'cp'), backupInbox: null };
    installInbox(paths.inbox, 'primary', { slots: 18 });
    chmodSync(paths.inbox, 0o444); // the disk refuses writes
    const req: StopRequest = { stop: id<StopId>('S-UNPERSISTED'), scope: { kind: 'all' }, words: '全部停下', at: Date.now() };
    const t0 = Date.now();
    const out = stopEntry(paths, req);
    pid = out.writerPids[0] ?? null;
    assert.equal(out.result, 'notified-not-persisted');
    assert.equal(out.exitCode, STOP_NOT_PERSISTED_EXIT_CODE);
    assert.equal(out.notice, STOP_NOT_PERSISTED_NOTICE);
    assert.equal(typeof pid, 'number');
    const took = Date.now() - t0;
    assert.ok(took >= 1_900 && took < 3_000, `waited the 2-second limit (${took} ms)`);
    // In force: the staging copy carries it (units and the scheduler read it).
    assert.deepEqual(readPendingStops({ inbox: join(base, 'no-inbox'), controlPlane: paths.controlPlane }).map((r) => r.stop), ['S-UNPERSISTED']);
    // The disk recovers: the writer persists the request in its slot, then exits.
    chmodSync(paths.inbox, 0o644);
    await until(() => readStopHistory(paths).some((r) => r.stop === 'S-UNPERSISTED' && r.words === '全部停下') && readHeader(paths.inbox) !== null, 15_000, 'the writer to persist the stop');
    await until(
      () => {
        try {
          process.kill(pid!, 0);
          return false;
        } catch {
          return true;
        }
      },
      8_000,
      'the writer to exit',
    );
    pid = null;
  } finally {
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- F7

test('F7: object content is verified against its hash when accepted; a corrupt or missing body is refused, at submission and at acceptance', async () => {
  const { svc, paths, cleanup } = service();
  try {
    // The reviewer's repro: store a body, then overwrite the file.
    const body = svc.content.put('corrupt-body-original');
    writeFileSync(svc.content.path(body), 'different bytes');
    await rejects(svc.appendRecords({ op: 'o1', gen: null, records: [objectVersion(svc, 'CORRUPT', { content: body })] }), 'CONTENT_MISSING');
    await rejects(svc.appendRecords({ op: 'o2', gen: null, records: [objectVersion(svc, 'ABSENT', { content: 'e'.repeat(64) })] }), 'CONTENT_MISSING');
    const gen = await svc.beginGeneration();
    const L = id<LaunchId>('L1');
    await svc.registerLaunch({ op: 'l1', gen, launch: L, tag: { mission: M, capabilities: [] } });
    await rejects(svc.submitPendingResult({ op: 'r0', launch: L, records: [objectVersion(svc, 'CORRUPT2', { content: body })] }), 'CONTENT_MISSING');
    // Repaired content is accepted: a failed verification is never cached.
    writeFileSync(svc.content.path(body), 'corrupt-body-original');
    await svc.appendRecords({ op: 'o3', gen: null, records: [objectVersion(svc, 'REPAIRED', { content: body })] });

    // At acceptance: a valid pending result whose body is damaged afterwards is refused by a fresh service.
    const body2 = svc.content.put('pending body');
    await svc.submitPendingResult({ op: 'r1', launch: L, records: [objectVersion(svc, 'P2', { content: body2 })] });
    await svc.registerProof(proof('L1'));
    svc.close();
    writeFileSync(svc.content.path(body2), 'damaged');
    const svc2 = new LedgerService({ paths });
    svc2.open();
    try {
      const head = svc2.head();
      await rejects(svc2.dispose({ gen, launch: L, disposition: 'accepted', reason: 'ok' }), 'CONTENT_MISSING');
      assert.equal(svc2.head(), head, 'nothing was accepted');
      assert.equal(svc2.dispositionFor(L), null);
    } finally {
      svc2.close();
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- F10

test('F10: the evaluator is bound to the scheduler generation; a stale scheduler can neither begin one nor keep publishing', async () => {
  const { svc, paths, cleanup } = service();
  try {
    const g1 = await svc.beginGeneration();
    await rejects(svc.beginEvaluator({} as never), 'BAD_REQUEST');
    await rejects(svc.beginEvaluator({ gen: g1, identity: { pid: 0, startTime: '', bootId: '' } }), 'BAD_REQUEST');
    const e1 = await svc.beginEvaluator({ gen: g1, identity: IDENT });
    await svc.appendRecords({ op: 'b1', gen: null, records: [basis(1)] });
    await svc.publish({ epoch: e1.epoch, revision: svc.head(), batch: null });
    // The reviewer's repro: after beginGeneration the old evaluator could still publish.
    const g2 = await svc.beginGeneration();
    await svc.appendRecords({ op: 'b2', gen: null, records: [basis(2)] });
    await rejects(svc.publish({ epoch: e1.epoch, revision: svc.head(), batch: null }), 'STALE_EVALUATOR');
    // ...and any old caller could take a new epoch and displace the current instance.
    await rejects(svc.beginEvaluator({ gen: g1, identity: IDENT }), 'STALE_GENERATION');
    const ident2 = { ...IDENT, startTime: 'later' };
    const e2 = await svc.beginEvaluator({ gen: g2, identity: ident2 });
    await svc.publish({ epoch: e2.epoch, revision: svc.head(), batch: null });
    await rejects(svc.publish({ epoch: e1.epoch, revision: svc.head(), batch: null }), 'STALE_EVALUATOR');
    assert.deepEqual(svc.evaluatorInstance(), { epoch: e2.epoch, gen: g2, identity: ident2 });
    const begun = readJournal(paths.db).filter((j) => j.record.kind === 'evaluator.begun');
    assert.deepEqual(
      begun.map((j) => (j.record as { gen: number }).gen),
      [g1, g2],
    );
    // Raising the floor creates no revision (6.1), so the evaluator never re-triggers itself.
    const head = svc.head();
    await svc.publish({ epoch: e2.epoch, revision: head, batch: null });
    assert.equal(svc.head(), head);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- F11

test('F11: lists over 250,000 items are refused before they are read; one at the cap is accepted', async () => {
  const { svc, cleanup } = service();
  try {
    // The reviewer's 2,000,000-item list: refused from its declared count, without reading it.
    const t0 = performance.now();
    await rejects(svc.appendRecords({ op: 'c1', gen: null, records: [pendingOp('H1', { hash: 'f'.repeat(64) as ContentHash, count: 2_000_000 })] }), 'TOO_LARGE');
    assert.ok(performance.now() - t0 < 200);
    const over = svc.content.putList(Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => `o${i}`));
    await rejects(svc.appendRecords({ op: 'c2', gen: null, records: [pendingOp('H2', over)] }), 'TOO_LARGE');
    // A small declared count does not let a large list through: the scan stops at the cap.
    await rejects(svc.appendRecords({ op: 'c3', gen: null, records: [pendingOp('H3', { hash: over.hash, count: 5 })] }), 'TOO_LARGE');
    const at = svc.content.putList(Array.from({ length: MAX_LIST_ITEMS }, (_, i) => `o${i}`));
    await svc.appendRecords({ op: 'c4', gen: null, records: [pendingOp('H4', at)] });
    // A count that does not match the stored list is refused.
    await rejects(svc.appendRecords({ op: 'c5', gen: null, records: [pendingOp('H5', { hash: at.hash, count: 3 })] }), 'RECORD_INVALID');
  } finally {
    cleanup();
  }
});

test('F11: a large list is verified outside the serial queue; a stop sent meanwhile commits first, and the queued action stays small', async () => {
  const actions: Array<{ name: string; ms: number }> = [];
  const { svc, cleanup } = service({ onAction: (name, ms) => actions.push({ name, ms }) });
  try {
    const big = svc.content.putList(Array.from({ length: MAX_LIST_ITEMS }, (_, i) => `long-identifier-${i}-${'x'.repeat(48)}`));
    let appendDone = 0;
    let stopDone = 0;
    let maxGap = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const t = performance.now();
      maxGap = Math.max(maxGap, t - last);
      last = t;
    }, 2);
    const t0 = performance.now();
    const ap = svc.appendRecords({ op: 'big', gen: null, records: [pendingOp('BIG', big)] }).then(() => (appendDone = performance.now()));
    await sleep(5);
    const sp = svc.stop({ stop: id<StopId>('S-DURING'), scope: { kind: 'all' }, words: '停', at: 1 }).then(() => (stopDone = performance.now()));
    await Promise.all([ap, sp]);
    clearInterval(ticker);
    assert.ok(stopDone < appendDone, `the stop (${(stopDone - t0).toFixed(1)} ms) committed while the list was still being verified (${(appendDone - t0).toFixed(1)} ms)`);
    assert.ok(stopDone - t0 < 500, `stop latency ${(stopDone - t0).toFixed(1)} ms`);
    const queued = actions.find((a) => a.name === 'appendRecords');
    assert.ok(queued && queued.ms < 100, `the queued part of the append took ${queued?.ms.toFixed(1)} ms`);
    assert.ok(maxGap < 150, `the event loop was blocked for ${maxGap.toFixed(1)} ms during verification`);
    assert.deepEqual(svc.slowActions, []);
  } finally {
    cleanup();
  }
});

test('F11: a transaction over the storage deadline puts the service in storage fault after it returns; a probe recovers it, stops first', async () => {
  let delay = 0;
  const { svc, paths, cleanup } = service({ storageDeadlineMs: 50, actionBudgetMs: 40, injectWriteDelayMs: () => delay });
  try {
    delay = 120;
    const slow = await svc.appendRecords({ op: 'slow', gen: null, records: [basis(1)] });
    assert.equal(svc.inStorageFault, true, 'the slow transaction committed, then the service entered the fault');
    assert.match(svc.storageFaultReason ?? '', /deadline/);
    assert.ok(svc.slowActions.some((a) => a.name === 'appendRecords'), 'slowActions still records it');
    await rejects(svc.appendRecords({ op: 'next', gen: null, records: [basis(2)] }), 'STORAGE_FAULT');
    sendStop(paths, { stop: id<StopId>('S-SLOW'), scope: { kind: 'all' }, words: '停', at: Date.now() });
    await sleep(400);
    assert.equal(svc.inStorageFault, true, 'probes on a slow disk fail too');
    assert.deepEqual(svc.activeStopIds(), []);
    delay = 0;
    await until(() => !svc.inStorageFault, 4000, 'an automatic probe to recover');
    assert.deepEqual(svc.activeStopIds(), ['S-SLOW'], 'the stop waiting in the inbox was committed first');
    await svc.appendRecords({ op: 'next', gen: null, records: [basis(2)] });
    assert.deepEqual(await svc.appendRecords({ op: 'slow', gen: null, records: [basis(1)] }), slow, 'the slow commit stands');
  } finally {
    cleanup();
  }
});

test('F11: spend totals are maintained per mission, not summed over history', async () => {
  const { svc, paths, cleanup } = service();
  try {
    const gen = await svc.beginGeneration();
    await svc.registerLaunch({ op: 'l', gen, launch: id<LaunchId>('L'), tag: { mission: M, capabilities: [] } });
    for (let i = 0; i < 20; i++) {
      await svc.reserveSpend({ op: `r${i}`, reservation: id<ReservationId>(`R${i}`), launch: id<LaunchId>('L'), micros: 10 });
      if (i % 2 === 0) await svc.settleSpend({ op: `s${i}`, reservation: id<ReservationId>(`R${i}`), micros: 3 });
    }
    assert.deepEqual(svc.spendSummary(M), { limit: null, spent: 30, inflight: 100 });
    const db = new DatabaseSync(paths.db, { readOnly: true });
    try {
      assert.deepEqual({ ...(db.prepare('SELECT spent, inflight FROM spend_totals WHERE mission = ?').get(M) as object) }, { spent: 30, inflight: 100 });
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
});

test('F11: the list scanner accepts exactly what JSON.parse accepts as a list of strings, with the same items', async () => {
  const oracle = (buf: Buffer): string[] | null => {
    try {
      const v = JSON.parse(buf.toString('utf8')) as unknown;
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
    } catch {
      return null;
    }
  };
  const fixed = [
    '[]', ' [ ] ', '["a"]', '["a","b"]', '[ "a" , "b" ]\n', '["\\u00e9\\n\\"x\\\\"]', '["é","日本"]', '["\\ud83d\\ude00"]', '["\\ud800"]',
    '["a",]', '[,"a"]', '["a" "b"]', '["a"]x', '["a"', '[1]', '[["a"]]', '[null]', '{"a":1}', '', ' ', '﻿["a"]', '["\\x"]',
    '["\\u12"]', '["a\nb"]', '["a\tb"]', '["\u007f\u0080"]', '[\n"a"\n]', '["a"]\n\n', 'null', '"a"', '["\\/"]', '["a\\', '["\\"]', '[" "]',
  ];
  const inputs: Buffer[] = fixed.map((s) => Buffer.from(s, 'utf8'));
  let seed = 7;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const alphabet = ['a', 'Z', '0', ' ', '"', '\\', '\n', '\t', '\u0001', 'é', '日', '😀', '/', ',', '[', ']'];
  for (let k = 0; k < 400; k++) {
    const items = Array.from({ length: rnd(6) }, () => Array.from({ length: rnd(8) }, () => alphabet[rnd(alphabet.length)]).join(''));
    const buf = Buffer.from(JSON.stringify(items, null, rnd(3) === 0 ? 1 : undefined), 'utf8');
    if (rnd(2) === 0 && buf.length > 0) buf[rnd(buf.length)] = rnd(256); // byte-level damage, including invalid UTF-8
    inputs.push(buf);
  }
  for (const buf of inputs) {
    const want = oracle(buf);
    let got: string[] | null;
    try {
      got = (await scanStringList(buf, 'h', 1_000_000, true)).items;
    } catch (e) {
      assert.ok(e instanceof LedgerError, String(e));
      got = null;
    }
    assert.deepEqual(got, want, `input ${JSON.stringify(buf.toString('latin1'))}`);
  }
});

// ---------------------------------------------------------------- F15

test('F15: a new directory chain is made durable level by level', () => {
  const base = mkdtempSync(join(tmpdir(), 'mp-durable-'));
  try {
    const calls: string[] = [];
    const rec = (d: string): void => {
      calls.push(d);
      fsyncDir(d);
    };
    const created = mkdirDurable(join(base, 'a', 'b', 'c'), rec);
    assert.deepEqual(created, [join(base, 'a'), join(base, 'a', 'b'), join(base, 'a', 'b', 'c')]);
    assert.deepEqual(calls, [base, join(base, 'a'), join(base, 'a', 'b')], 'each new level’s parent, top first');
    calls.length = 0;
    assert.deepEqual(mkdirDurable(join(base, 'a', 'b', 'c'), rec), []);
    assert.deepEqual(calls, [], 'nothing to do for an existing chain');
    // The stop inbox is created the same way (its whole new chain made durable).
    const paths = { inbox: join(base, 'x', 'y', 'stop-inbox', 'primary.inbox'), controlPlane: join(base, 'cp'), backupInbox: null };
    assert.equal(installInbox(paths.inbox, 'primary', { slots: 10 }).created, true);
    assert.equal(sendStop(paths, { stop: id<StopId>('S'), scope: { kind: 'all' }, words: '停', at: 1 }).durable, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('F15: content store init fsyncs each level-1 directory after its children, the root after its children, then the root’s parent; a crash mid-init is finished later', () => {
  const base = mkdtempSync(join(tmpdir(), 'mp-content-init-'));
  try {
    const root = join(base, 'x', 'content');
    const calls: string[] = [];
    const level1 = Array.from({ length: 256 }, (_, a) => join(root, a.toString(16).padStart(2, '0')));
    const rec = (d: string): void => {
      if (level1.includes(d)) {
        for (let b = 0; b < 256; b++) assert.ok(existsSync(join(d, b.toString(16).padStart(2, '0'))), `${d} synced before all its children exist`);
      }
      if (d === root) for (const l of level1) assert.ok(existsSync(l), 'root synced before all level-1 directories exist');
      calls.push(d);
      fsyncDir(d);
    };
    new ContentStore(root).init(rec);
    assert.deepEqual(calls, [base, join(base, 'x'), ...level1, root, join(base, 'x')]);
    calls.length = 0;
    new ContentStore(root).init(rec);
    assert.deepEqual(calls, [], 'a completed layout is not walked again');

    // Power loss in the middle of the first init.
    const root2 = join(base, 'y', 'content');
    let n = 0;
    assert.throws(() =>
      new ContentStore(root2).init((d) => {
        if (++n === 20) throw new Error('power loss');
        fsyncDir(d);
      }),
    );
    assert.equal(existsSync(join(root2, '.layout-v1')), false, 'no completion marker after a crash');
    const store = new ContentStore(root2);
    let synced = 0;
    store.init((d) => {
      synced++;
      fsyncDir(d);
    });
    assert.ok(synced >= 258, 'the second init redoes the syncs');
    assert.equal(existsSync(join(root2, '.layout-v1')), true);
    const h = store.put('after the crash');
    assert.equal(store.get(h).toString(), 'after the crash');
    // A fan-out directory lost anyway is recreated on put.
    rmSync(dirname(store.path(sha256('lost dir'))), { recursive: true, force: true });
    assert.equal(store.get(store.put('lost dir')).toString(), 'lost dir');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- F21

test('F21: a regression registration declares its command, a test file and a runner configuration, every input as name=sha256', async () => {
  const { svc, cleanup } = service();
  try {
    const h = (s: string): string => sha256(s);
    const tests = svc.content.putList(['test/a.test.ts::fixes N']);
    const cov = (op: string, inputs: string[], extra: Record<string, unknown> = {}): BaseRecord =>
      ({ kind: 'issue.coverage', issue: 'N', version: 'P', evidence: 'E', command: 'npm test', tests, inputs: svc.content.putList(inputs), ...extra }) as BaseRecord;
    const add = (op: string, r: BaseRecord) => svc.appendRecords({ op, gen: null, records: [r] });
    // The reviewer's repro: no inputs at all.
    await rejects(add('c0', cov('c0', [])), 'RECORD_INVALID');
    await rejects(add('c1', cov('c1', [`testfile:test/a.test.ts=${h('a')}`])), 'RECORD_INVALID');
    await rejects(add('c2', cov('c2', [`runner:node-test=${h('r')}`])), 'RECORD_INVALID');
    await rejects(add('c3', cov('c3', [`testfile:test/a.test.ts=${h('a')}`, 'runner:node-test=not-a-hash'])), 'RECORD_INVALID');
    await rejects(add('c4', cov('c4', [`testfile:test/a.test.ts=${h('a')}`, `runner:node-test=${h('r')}`, `config:x=${h('x')}`])), 'RECORD_INVALID');
    await rejects(add('c5', cov('c5', [`testfile:test/a.test.ts=${h('a')}`, `runner:node-test=${h('r')}`], { command: undefined })), 'RECORD_INVALID');
    const ok = [`testfile:test/a.test.ts=${h('a')}`, `runner:node-test=${h('r')}`, `fixture:test/fx=1.json=${h('f')}`];
    await add('c6', cov('c6', ok));
    // The same rule for a unit's pending result.
    const gen = await svc.beginGeneration();
    await svc.registerLaunch({ op: 'l', gen, launch: id<LaunchId>('L'), tag: { mission: M, capabilities: [] } });
    await rejects(svc.submitPendingResult({ op: 'p0', launch: id<LaunchId>('L'), records: [cov('p0', [`testfile:t=${h('t')}`])] }), 'RECORD_INVALID');
    await svc.submitPendingResult({ op: 'p1', launch: id<LaunchId>('L'), records: [cov('p1', ok, { issue: 'N2' })] });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- F17

test('F17: every state table and the ledger state keys are rebuilt from the log, row for row, after a varied workload', async () => {
  const { dir, paths, cleanup } = fresh();
  let boot = 'boot-A';
  const make = (): LedgerService => new LedgerService({ paths, bootId: () => boot });
  let svc = make();
  try {
    svc.open();
    await svc.setMission(M, 'open');
    crash(svc);
    boot = 'boot-B';
    svc = make();
    assert.equal(svc.open().recoveryPause, true);
    // WI-12: the user's answer is kept with the cleared pause.
    assert.deepEqual(await svc.confirmResume({ op: 'wi12-1', answer: 'no, I did not ask to stop anything' }), { cleared: true });
    assert.deepEqual([svc.startupDecision()?.answer, svc.startupDecision()?.answerOp], ['no, I did not ask to stop anything', 'wi12-1']);
    assert.deepEqual(await svc.confirmResume({ op: 'wi12-1', answer: 'no, I did not ask to stop anything' }), { cleared: true }, 'a retry returns the first answer');
    assert.deepEqual(await svc.confirmResume(), { cleared: false }, 'no pause in force');
    const L = (xs: string[]) => svc.content.putList(xs);
    const g1 = await svc.beginGeneration();
    const M2 = id<MissionId>('m2');
    await svc.setMission(M2, 'open');
    await svc.setMission(M2, 'closed');
    const h = (s: string): string => sha256(s);
    const facts: BaseRecord[] = [
      basis(1),
      { kind: 'env.snapshot', line: 'py' as never, snapshot: 'py@1' as never },
      { kind: 'evidence', evidence: 'E1' as never, envLine: 'py' as never, envSnapshot: 'py@1' as never, runClass: 'closed', fields: { exit: '0' } },
      objectVersion(svc, 'P'),
      {
        kind: 'judgment', judgment: 'J1' as never, review: 'reviewer', executor: 'reviewer', target: 'P' as never, verdict: 'pass', evidence: L(['E1']), bases: L([]),
        constraints: L([]), reliesOn: L([]), issues: [], revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [],
      },
      { kind: 'issue', issue: 'N' as never, module: null, observedOn: L(['P']), text: svc.content.put('finding') },
      { kind: 'issue.coverage', issue: 'N' as never, version: 'P' as never, evidence: 'E1' as never, command: 'npm test', tests: L(['t1']), inputs: L([`testfile:t.ts=${h('t')}`, `runner:node=${h('n')}`]) },
      pendingOp('D', L(['P'])),
      { kind: 'notice', notice: 'eb-0:D', audience: 'pm', body: svc.content.put('notice') },
      { kind: 'loop.attempt', lineage: 'T1', loop: 'env-retry', failureClass: 'env', signature: 'sig-x' },
      { kind: 'loop.attempt', lineage: 'T1', loop: 'env-retry', failureClass: 'env', signature: 'sig-x' },
      { kind: 'loop.grant', lineage: 'T1', loop: 'env-retry', by: 'secretary', extra: 2, reason: svc.content.put('why') },
      { kind: 'mission.block', mission: M, reason: 'budget', state: 'blocked', report: svc.content.put('report') },
    ];
    const first = await svc.appendRecords({ op: 'facts', gen: g1, records: facts });
    assert.deepEqual(await svc.appendRecords({ op: 'facts', gen: g1, records: facts }), first, 'a retry returns the original result');
    await svc.appendRecords({ op: 'same-fact', gen: null, records: [basis(1)] });

    for (const [l, caps] of [['L1', ['shell', 'net']], ['L2', []], ['L3', ['gpu']]] as const) {
      await svc.registerLaunch({ op: `reg-${l}`, gen: g1, launch: id<LaunchId>(l), tag: { mission: M, capabilities: [...caps] } });
    }
    await svc.submitPendingResult({
      op: 'res-L1',
      launch: id<LaunchId>('L1'),
      records: [
        { kind: 'evidence', evidence: 'E2' as never, envLine: 'py' as never, envSnapshot: 'py@1' as never, runClass: 'closed', fields: { exit: '0' } },
        objectVersion(svc, 'P2'),
        { kind: 'seat.result', launch: id<LaunchId>('L1'), seat: 'constructor', status: 'handed-back', result: svc.content.put('result'), export: null, transcript: svc.content.put('transcript'), recoveryState: null, evidenceRequest: null },
      ],
    });
    await svc.registerProof(proof('L1'));
    const g2 = await svc.beginGeneration();
    await svc.adopt({ gen: g2, launch: id<LaunchId>('L1'), via: 'proof' });
    await svc.dispose({ gen: g2, launch: id<LaunchId>('L1'), disposition: 'accepted', reason: 'ok' });
    await svc.registerProof(proof('L2'));
    await svc.adopt({ gen: g2, launch: id<LaunchId>('L2'), via: 'proof' });
    await svc.dispose({ gen: g2, launch: id<LaunchId>('L2'), disposition: 'failed', reason: 'tests failed' });
    await svc.adopt({ gen: g2, launch: id<LaunchId>('L3'), via: 'alive' });
    await svc.dispose({ gen: g2, launch: id<LaunchId>('L3'), disposition: 'cancelled', reason: 'user stop' });
    await svc.recordCleanup({ op: 'c1', launch: id<LaunchId>('L1'), state: 'pending', resources: L(['mount:/a', 'cgroup:/b']) });
    await svc.recordCleanup({ op: 'c2', launch: id<LaunchId>('L1'), state: 'pending', resources: L(['cgroup:/b']) });
    await svc.recordCleanup({ op: 'c3', launch: id<LaunchId>('L1'), state: 'done', resources: L([]) });
    await svc.recordCleanup({ op: 'c4', launch: id<LaunchId>('L2'), state: 'pending', resources: L(['image:/c']) });

    const tag = { mission: M, capabilities: [] as string[] };
    await svc.authorize({ op: 'a1', gen: g2, launch: null, intent: 'I1', kind: 'ref', domain: 'refs/x', tag, details: { ref: 'x' } });
    await svc.markIntentPendingVerify('I1', { pid: 4242, startTime: '99', bootId: 'boot-B' });
    await svc.finishIntent('I1', 'done', { executorGone: true, outcomeVerified: true });
    await svc.authorize({ op: 'a2', gen: g2, launch: null, intent: 'I2', kind: 'ref', domain: 'refs/y', tag, details: null });
    await svc.finishIntent('I2', 'failed');
    // A delivery (its ref creation authorized, then recorded) and a landing of it (git review r1 #11: the landing names it).
    const d0 = { mission: M, op: 'd0', commit: 'c'.repeat(40), base: 'b'.repeat(40), ref: 'refs/mission-pipeline/delivered/m1/d0', targetBranch: 'main' };
    await svc.authorize({ op: 'a0', gen: g2, launch: null, intent: 'I0', kind: 'delivery-ref', domain: `ref:${d0.ref}`, tag, details: { ref: d0.ref, commit: d0.commit, base: d0.base, token: 't0', delivery: d0 } });
    await svc.recordDelivery({ op: 'dl0', mission: M, delivery: 'd0', commit: d0.commit, base: d0.base, ref: d0.ref, manifest: svc.content.put('manifest d0'), target: 'main' });
    await svc.finishIntent('I0', 'done', { executorGone: true, outcomeVerified: true });
    await svc.authorize({
      op: 'a3', gen: g2, launch: null, intent: 'I3', kind: 'landing', domain: 'worktree:main', tag,
      details: { landing: 'LD1', delivery: { mission: M, op: 'd0', commit: d0.commit, base: d0.base, targetBranch: 'main' } },
    });
    await svc.recordLandingPhase({ op: 'lp1', landing: 'LD1', intent: 'I3', phase: 'authorized', data: { a: 1 } });
    await svc.recordLandingPhase({ op: 'lp2', landing: 'LD1', intent: null, phase: 'admitted', data: { b: 2 } });

    await svc.stop({ stop: id<StopId>('S1'), scope: { kind: 'mission', mission: M2 }, words: '停 m2', at: 5 });
    await svc.releaseStop(id<StopId>('S1'));
    sendStop(paths, { stop: id<StopId>('S2'), scope: { kind: 'capability', capability: 'gpu' }, words: 'no gpu', at: 6 });
    await svc.drainStops();
    await until(() => svc.activeStopIds().includes(id<StopId>('S2')), 2000, 'S2');

    await svc.setSpendLimit({ op: 'sl1', mission: M, micros: 1_000_000 });
    await svc.setSpendLimit({ op: 'sl2', mission: M, micros: 2_000_000 });
    await svc.registerLaunch({ op: 'reg-L4', gen: g2, launch: id<LaunchId>('L4'), tag });
    for (const [r, micros] of [['R1', 500], ['R2', 300], ['R3', 200]] as const) {
      await svc.reserveSpend({ op: `rs-${r}`, reservation: id<ReservationId>(r), launch: id<LaunchId>('L4'), micros });
    }
    await svc.settleSpend({ op: 'ss1', reservation: id<ReservationId>('R1'), micros: 120 });
    await svc.settleLaunchAtReservation({ op: 'sla', launch: id<LaunchId>('L4') });
    await svc.reserveSpend({ op: 'rs-R4', reservation: id<ReservationId>('R4'), launch: id<LaunchId>('L4'), micros: 50 });

    const { epoch } = await svc.beginEvaluator({ gen: g2, identity: IDENT });
    await svc.publish({ epoch, revision: svc.head(), batch: { batch: id<EpisodeBatchId>('eb-1'), changes: L([JSON.stringify({ op: 'D', change: 'start' })]) } });
    await svc.commitProofOp({ op: 'x1', gen: g2, opId: id<OpId>('D'), asOf: svc.publicationFloor() });
    // An accepted degradation, and a continuation judgment after its evaluator check.
    await svc.recordInstallState({ op: 'is1', item: 'resource-limits', value: 'heap-only', accepted: true, by: 'user', detail: svc.content.put('the user accepted the heap-only pool') });
    await svc.recordContinuationCheck({
      op: 'cc1', gen: g2, judgment: id<JudgmentId>('J2'), extends: id<JudgmentId>('J1'), target: 'P', revision: svc.publicationFloor(),
      result: { ok: true, merged: { evidence: ['E1'], bases: [], constraints: [], reliesOn: [] } },
    });
    await svc.appendRecords({
      op: 'j2',
      gen: g2,
      records: [
        {
          kind: 'judgment', judgment: 'J2' as never, review: 'reviewer', executor: 'reviewer', target: 'P' as never, verdict: 'pass', evidence: L(['E1']), bases: L([]),
          constraints: L([]), reliesOn: L([]), issues: [], revokes: null, extends: 'J1' as never, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [],
        },
      ],
    });
    // A proof operation while the derived state cannot be computed ends (op_ends, core review r3 #3).
    await svc.appendRecords({ op: 'd2', gen: g2, records: [pendingOp('D2', L(['P']))] });
    await svc.setEvaluatorFault('evaluator down');
    await rejects(svc.commitProofOp({ op: 'x2', gen: g2, opId: id<OpId>('D2'), asOf: svc.publicationFloor() }), 'EVALUATOR_FAULT');
    await svc.clearEvaluatorFault();
    const headBefore = svc.head();
    await svc.recordEvaluatorFailure();
    await svc.recordEvaluatorFailure();
    await svc.setEvaluatorFault('rebuild failed');
    assert.equal(svc.head(), headBefore, 'evaluator health creates no revision (it is in the journal)');
    await svc.clearEvaluatorFault();
    await svc.recordEvaluatorFailure();
    await svc.recordEvaluatorSuccess();
    await svc.recordEvaluatorFailure();
    await svc.publish({ epoch, revision: svc.head(), batch: null });
    await svc.recordDelivery({ op: 'dl1', mission: M, delivery: 'd1', commit: 'a'.repeat(40), base: 'b'.repeat(40), ref: 'refs/mission-pipeline/delivered/m1/d1', manifest: svc.content.put('manifest') });
    await svc.withdrawDelivery({ op: 'wd1', mission: M, delivery: 'd1', reason: 'the user withdrew it' });
    // The flows' facts, notice deliveries, a PM action, a narrowed stop and a closed mission (each rebuilds too).
    await svc.appendRecords({ op: 'fe1', gen: g2, records: [{ kind: 'flow.event', mission: M, line: 'plan', event: 'pm-batch', key: '1', body: svc.content.put('{"batch":1}') }] });
    await svc.markNotice({ notice: 'A1', state: 'delivered' });
    await svc.markNotice({ notice: 'A1', state: 'acknowledged' });
    await svc.recordPmAction({ action: 'pm-op-1', command: 'stop-narrow', args: { stop: 'S2' }, wi: 'WI-12', state: 'started' });
    await svc.recordPmAction({ action: 'pm-op-1', command: 'stop-narrow', args: { stop: 'S2' }, wi: 'WI-12', state: 'done', result: { ok: true } });
    await svc.stop({ stop: id<StopId>('S3'), scope: { kind: 'all' }, words: '全停', at: 7 });
    await svc.narrowStop({ old: id<StopId>('S3'), stop: { stop: id<StopId>('S4'), scope: { kind: 'mission', mission: M2 }, words: '只停 m2', at: 8 } });
    await svc.closeMission({ op: 'close-m2', mission: M2, mode: 'with-risk', waitRunning: false, snapshot: svc.content.put('{"risks":[]}') });
    await svc.raiseAlert({ op: 'al1', alert: id<AlertId>('A1'), category: 'cleanup', wi: 'WI-14', body: svc.content.put('alert body') });
    // The task queue, user words and a landing attempt (core review r3 follow-up: every new state rebuilds too).
    const card = svc.content.put('card of T-A');
    await svc.queueTask({ op: 'q-a', gen: g2, task: 'T-A', lineage: 'LIN-A', mission: M, card });
    await svc.queueTask({ op: 'q-b', gen: g2, task: 'T-B', lineage: 'LIN-B', mission: M, card: svc.content.put('card of T-B') });
    await svc.queueTask({ op: 'q-c', gen: g2, task: 'T-C', lineage: 'LIN-A', mission: M, card: svc.content.put('card of T-C') });
    await svc.dequeueTask({ op: 'dq-a', gen: g2, task: 'T-A', reason: 'dispatched', launch: id<LaunchId>('L4') });
    await svc.dequeueTask({ op: 'dq-c', gen: g2, task: 'T-C', reason: 'superseded', by: 'T-D' });
    await svc.recordUserWords({ message: 'msg-1', session: 'pm-1', at: 1000, text: '先把交付停一下' });
    await svc.appendRecords({ op: 'la-1', gen: g2, records: [{ kind: 'loop.attempt', lineage: 'delivery-d1', loop: 'landing-attempt', failureClass: null, signature: 'attempt-1' }] });
    await svc.appendRecords({ op: 'mb-2', gen: g2, records: [{ kind: 'mission.block', mission: M, reason: 'budget', state: 'released', report: svc.content.put('released') }] });

    // Another unclean reboot leaves the recovery pause set.
    crash(svc);
    boot = 'boot-C';
    svc = make();
    assert.equal(svc.open().recoveryPause, true);
    svc.close();

    const compare = (live: string, rebuilt: string): void => {
      const a = new DatabaseSync(live, { readOnly: true });
      const b = new DatabaseSync(rebuilt, { readOnly: true });
      try {
        for (const t of STATE_TABLES) {
          const rows = (db: DatabaseSync): unknown[] => db.prepare(`SELECT rowid AS _rowid, * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }));
          const want = rows(a);
          assert.ok(want.length > 0, `the workload exercises ${t}`);
          assert.deepEqual(rows(b), want, `table ${t}`);
        }
        const keys = (db: DatabaseSync): unknown[] =>
          db
            .prepare(`SELECT key, value FROM service_state WHERE key IN (${STATE_KEYS.map(() => '?').join(', ')}) ORDER BY key`)
            .all(...STATE_KEYS)
            .map((r) => ({ ...r }));
        assert.equal(keys(a).length, STATE_KEYS.length, 'the workload exercises every ledger state key');
        assert.deepEqual(keys(b), keys(a), 'service_state');
      } finally {
        a.close();
        b.close();
      }
    };

    // Into a fresh database.
    const target = join(dir, 'rebuilt', 'ledger.sqlite');
    mkdirSync(dirname(target));
    const report = rebuildStateFromLog(paths.db, paths.content, { into: target });
    assert.equal(report.records, readRecords(paths.db, revision(0)).length);
    assert.equal(report.journal, readJournal(paths.db).length);
    compare(paths.db, target);

    // In place, after the state tables were lost.
    const target2 = join(dir, 'in-place', 'ledger.sqlite');
    mkdirSync(dirname(target2));
    rebuildStateFromLog(paths.db, paths.content, { into: target2 });
    const wipe = new DatabaseSync(target2);
    for (const t of STATE_TABLES) wipe.exec(`DELETE FROM ${t}`);
    wipe.exec('DELETE FROM service_state');
    wipe.close();
    rebuildStateFromLog(target2, paths.content);
    compare(paths.db, target2);
    assert.throws(() => rebuildStateFromLog(target2, paths.content), /not empty/);
  } finally {
    try {
      svc.close();
    } catch {
      /* closed already */
    }
    cleanup();
  }
});

test('F17: the reviewer’s repro: evaluator failure budget and fault are logged, so the log reconstructs them', async () => {
  const { svc, paths, cleanup } = service();
  try {
    const head = svc.head();
    const before = readJournal(paths.db).length;
    await svc.recordEvaluatorFailure();
    await svc.setEvaluatorFault('unrecoverable');
    assert.equal(svc.head(), head, 'no revision (the evaluator would otherwise re-trigger itself)');
    const health = readJournal(paths.db).slice(before).map((j) => j.record);
    assert.deepEqual(health, [
      { kind: 'evaluator.health', failures: 1, fault: null },
      { kind: 'evaluator.health', failures: 1, fault: 'unrecoverable' },
    ]);
  } finally {
    cleanup();
  }
});

test('every idempotent operation leaves a receipt with its response; a retry leaves none (F17, 6.1)', async () => {
  const { svc, paths, cleanup } = service();
  try {
    const gen: Generation = await svc.beginGeneration();
    const r = await svc.registerLaunch({ op: 'reg', gen, launch: id<LaunchId>('L'), tag: { mission: M, capabilities: [] } });
    await svc.registerLaunch({ op: 'reg', gen, launch: id<LaunchId>('L'), tag: { mission: M, capabilities: [] } });
    const receipts = readJournal(paths.db).filter((j) => j.record.kind === 'op.receipt');
    assert.equal(receipts.length, 1);
    const rec = receipts[0]!.record as { op: string; launch: string; response: ContentHash };
    assert.equal(rec.op, 'reg');
    assert.equal(rec.launch, 'L');
    assert.deepEqual(JSON.parse(svc.content.get(rec.response).toString()), r);
  } finally {
    cleanup();
  }
});
