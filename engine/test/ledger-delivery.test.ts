// Deliveries in the ledger (6.6 steps 6-8): git review r1 #11 (a landing or a
// delivery ref is authorized only for the mission's current, not withdrawn
// delivery, checked in the authorization's transaction: DELIVERY_NOT_CURRENT,
// WI-06), the delivery stored with its intent for crash recovery (6.1 recovery
// table: "ref exists and points to the expected commit → record completion"),
// and delivery rebuilds refused once exhausted (6.5, WI-08).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LedgerError, LedgerService, ledgerPaths, type LedgerErrorCode, type LedgerPaths } from '../src/ledger/service.ts';
import { LedgerClient, RemoteLedgerError, serveLedger } from '../src/ledger/ipc.ts';
import { rebuildStateFromLog } from '../src/ledger/rebuild.ts';
import { Store, readRecords } from '../src/ledger/store.ts';
import { LOOPS_REFUSED_WHEN_EXHAUSTED, type LoopKind } from '../src/common/records.ts';
import { id, revision, type Generation, type MissionId, type StopId } from '../src/common/ids.ts';

const M = id<MissionId>('m1');
const M2 = id<MissionId>('m2');
const TAG = { mission: M, capabilities: [] as string[] };
const BASE = 'b'.repeat(40);
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const C3 = '3'.repeat(40);
const ref = (op: string): string => `refs/mission-pipeline/delivered/${M}/${op}`;

function service(): { svc: LedgerService; paths: LedgerPaths; dir: string; reopen: () => LedgerService; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mp-ledger-delivery-'));
  const paths = ledgerPaths(join(dir, 'ledger'), join(dir, 'control'));
  let svc = new LedgerService({ paths, bootId: () => 'boot-A' });
  svc.open();
  return {
    get svc() {
      return svc;
    },
    paths,
    dir,
    reopen: () => {
      svc.close();
      svc = new LedgerService({ paths, bootId: () => 'boot-A' });
      svc.open();
      return svc;
    },
    cleanup: () => {
      try {
        svc.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

async function rejects(p: Promise<unknown>, code: LedgerErrorCode, re?: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof LedgerError, `not a LedgerError: ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}

let n = 0;

/** The delivery side's ref creation (6.6 step 6), naming its delivery as the delivery side will. */
function authorizeRef(svc: LedgerService, gen: Generation, op: string, commit: string, extra: { manifest?: string; targetBranch?: string; mission?: MissionId } = {}) {
  const intent = `dref-${op}-${++n}`;
  const delivery = { mission: extra.mission ?? M, op, commit, base: BASE, ref: ref(op), targetBranch: extra.targetBranch ?? 'main', ...(extra.manifest ? { manifest: extra.manifest } : {}) };
  return svc
    .authorize({ op: `${intent}:authorize`, gen, launch: null, intent, kind: 'delivery-ref', domain: `ref:${ref(op)}`, tag: TAG, details: { ref: ref(op), commit, base: BASE, token: `tok-${n}`, delivery } })
    .then(() => intent);
}

/** The git side's landing authorization (6.6 step 7), as landingLedger.ts sends it. */
function authorizeLanding(svc: LedgerService, gen: Generation, op: string, commit: string, opts: { base?: string; targetBranch?: string; tag?: typeof TAG; delivery?: unknown } = {}) {
  const intent = `land-${op}-${++n}`;
  const delivery = opts.delivery !== undefined ? opts.delivery : { mission: M, op, commit, base: opts.base ?? BASE, targetBranch: opts.targetBranch ?? 'main' };
  return svc
    .authorize({
      op: `${intent}:authorize`,
      gen,
      launch: null,
      intent,
      kind: 'landing',
      domain: `landing:repo-${n}`,
      tag: opts.tag ?? TAG,
      details: { landing: `L-${n}`, mission: M, op, ...(delivery !== null ? { delivery } : {}) },
    })
    .then(() => intent);
}

function record(svc: LedgerService, op: string, commit: string, target: string | null = 'main') {
  return svc.recordDelivery({ op: `delivery-record:${op}:${commit}`, mission: M, delivery: op, commit, base: BASE, ref: ref(op), manifest: svc.content.put(`manifest ${op} ${commit}`), target });
}

// ---------------------------------------------------------------- (1) landing: only the current delivery

test('r1 #11: a landing is authorized only for the mission’s latest recorded delivery; a newer delivery on the same base refuses the old one (WI-06)', async () => {
  const w = service();
  try {
    const svc = w.svc;
    const gen = await svc.beginGeneration();
    // Nothing recorded yet.
    await rejects(authorizeLanding(svc, gen, 'op-1', C1), 'DELIVERY_NOT_CURRENT', /no delivery of mission m1 is recorded/);
    await record(svc, 'op-1', C1);
    const i1 = await authorizeLanding(svc, gen, 'op-1', C1);
    const info = svc.intentInfo(i1);
    assert.deepEqual(info?.delivery, { mission: M, op: 'op-1', commit: C1, base: BASE, ref: ref('op-1'), targetBranch: 'main', manifest: svc.deliveryInfo(M, 'op-1')?.manifest, description: null });
    // The reviewer's repro: a new delivery on the same base; the old one's ref stays, the old request still names it.
    await record(svc, 'op-2', C2);
    await rejects(authorizeLanding(svc, gen, 'op-1', C1), 'DELIVERY_NOT_CURRENT', /latest recorded delivery is op-2/);
    await authorizeLanding(svc, gen, 'op-2', C2);
    assert.equal(svc.currentDelivery(M)?.delivery, 'op-2');
    // Every field of the delivery identity counts.
    await rejects(authorizeLanding(svc, gen, 'op-2', C3), 'DELIVERY_NOT_CURRENT', /not commit/);
    await rejects(authorizeLanding(svc, gen, 'op-2', C2, { base: 'c'.repeat(40) }), 'DELIVERY_NOT_CURRENT', /base/);
    await rejects(authorizeLanding(svc, gen, 'op-2', C2, { targetBranch: 'release' }), 'DELIVERY_NOT_CURRENT', /target branch main/);
    // A landing that names no delivery cannot be confirmed current; a malformed one is a caller defect.
    await rejects(authorizeLanding(svc, gen, 'op-2', C2, { delivery: null }), 'DELIVERY_NOT_CURRENT', /names no delivery/);
    await rejects(authorizeLanding(svc, gen, 'op-2', C2, { delivery: { mission: M, op: 'op-2', commit: 'nope', base: BASE } }), 'BAD_REQUEST');
    // The delivery's mission is the action's scope.
    await rejects(authorizeLanding(svc, gen, 'op-2', C2, { delivery: { mission: M2, op: 'op-2', commit: C2, base: BASE, targetBranch: 'main' } }), 'SCOPE_MISMATCH');
    const e = await authorizeLanding(svc, gen, 'op-1', C1).catch((x: unknown) => x);
    assert.ok(e instanceof LedgerError && e.wi === 'WI-06', 'DELIVERY_NOT_CURRENT maps to WI-06');
    // Refusals write nothing.
    assert.equal(readRecords(w.paths.db, revision(0)).filter((c) => c.record.kind === 'intent.authorized').length, 2);
  } finally {
    w.cleanup();
  }
});

test('r1 #11: a withdrawn delivery is never landed, and the earlier one stays superseded; a stop is reported before currency', async () => {
  const w = service();
  try {
    const svc = w.svc;
    const gen = await svc.beginGeneration();
    await record(svc, 'op-1', C1);
    await record(svc, 'op-2', C2);
    await rejects(svc.withdrawDelivery({ op: 'wd-x', mission: M, delivery: 'op-9', reason: 'x' }), 'BAD_REQUEST');
    const r = await svc.withdrawDelivery({ op: 'wd-2', mission: M, delivery: 'op-2', reason: 'the user withdrew the delivery' });
    assert.ok(r.revision !== null);
    assert.deepEqual(await svc.withdrawDelivery({ op: 'wd-2b', mission: M, delivery: 'op-2', reason: 'again' }), { revision: null }, 'already withdrawn: no new record');
    assert.equal(svc.deliveryInfo(M, 'op-2')?.state, 'withdrawn');
    await rejects(authorizeLanding(svc, gen, 'op-2', C2), 'DELIVERY_NOT_CURRENT', /withdrawn \(the user withdrew the delivery\)/);
    await rejects(authorizeLanding(svc, gen, 'op-1', C1), 'DELIVERY_NOT_CURRENT', /latest recorded delivery is op-2 \(withdrawn\)/);
    // A new delivery makes the mission landable again.
    await record(svc, 'op-3', C3);
    await authorizeLanding(svc, gen, 'op-3', C3);
    // A committed stop is the safety floor: it is reported first, even for a landing that is not current.
    await svc.stop({ stop: id<StopId>('s1'), scope: { kind: 'mission', mission: M }, words: '停', at: 1 });
    await rejects(authorizeLanding(svc, gen, 'op-1', C1), 'STOPPED');
    await rejects(authorizeLanding(svc, gen, 'op-3', C3), 'STOPPED');
  } finally {
    w.cleanup();
  }
});

test('r1 #11: the check is made in the authorization’s transaction: a withdrawal committed while the request waited refuses it', async () => {
  const w = service();
  try {
    const svc = w.svc;
    const gen = await svc.beginGeneration();
    await record(svc, 'op-1', C1);
    // The landing's request is sent first; its details go to the content store before it is queued, so the
    // withdrawal (queued at once) commits before the authorization's transaction runs.
    const landing = authorizeLanding(svc, gen, 'op-1', C1);
    const withdrawn = svc.withdrawDelivery({ op: 'wd-1', mission: M, delivery: 'op-1', reason: 'withdrawn while the landing waited' });
    await rejects(landing, 'DELIVERY_NOT_CURRENT', /withdrawn/);
    assert.ok((await withdrawn).revision !== null);
  } finally {
    w.cleanup();
  }
});

// ---------------------------------------------------------------- (1) delivery-ref: not withdrawn, not superseded

test('r1 #11: a delivery ref is authorized only while its delivery is not withdrawn, not superseded by a later one, and not recorded otherwise', async () => {
  const w = service();
  try {
    const svc = w.svc;
    const gen = await svc.beginGeneration();
    // Without the delivery's identity the ledger cannot check it.
    await rejects(
      svc.authorize({ op: 'x:authorize', gen, launch: null, intent: 'x', kind: 'delivery-ref', domain: 'ref:x', tag: TAG, details: { ref: ref('op-1'), commit: C1, base: BASE, token: 't' } }),
      'DELIVERY_NOT_CURRENT',
      /names no delivery/,
    );
    // The delivery side's top-level ref, commit and base must be the ones checked.
    await rejects(
      svc.authorize({
        op: 'y:authorize', gen, launch: null, intent: 'y', kind: 'delivery-ref', domain: 'ref:y', tag: TAG,
        details: { ref: ref('op-1'), commit: C2, base: BASE, token: 't', delivery: { mission: M, op: 'op-1', commit: C1, base: BASE, ref: ref('op-1') } },
      }),
      'BAD_REQUEST',
      /details.commit differs/,
    );
    const a1 = await authorizeRef(svc, gen, 'op-1', C1);
    assert.equal(svc.deliveryInfo(M, 'op-1')?.state, 'creating');
    assert.equal(svc.currentDelivery(M), null, 'a delivery being created is not current for landing');
    await svc.finishIntent(a1, 'failed');
    // A rebuild of the same delivery on a new candidate: a new attempt, a new commit, still op-1.
    const a2 = await authorizeRef(svc, gen, 'op-1', C2);
    await svc.finishIntent(a2, 'failed');
    assert.equal(svc.deliveryInfo(M, 'op-1')?.commit, C2);
    // A later delivery of the mission supersedes op-1: its ref is never created afterwards.
    const b1 = await authorizeRef(svc, gen, 'op-2', C3);
    await rejects(authorizeRef(svc, gen, 'op-1', C2), 'DELIVERY_NOT_CURRENT', /superseded by the mission's later delivery op-2 \(creating\)/);
    // Recorded: re-creating the same ref (recovery) is allowed; re-pointing it is not.
    await record(svc, 'op-2', C3);
    await svc.finishIntent(b1, 'done', { executorGone: true, outcomeVerified: true });
    const b2 = await authorizeRef(svc, gen, 'op-2', C3);
    await svc.finishIntent(b2, 'done', { executorGone: true, outcomeVerified: true });
    await rejects(authorizeRef(svc, gen, 'op-2', C1), 'DELIVERY_NOT_CURRENT', /never re-pointed/);
    // Withdrawn while being created.
    await authorizeRef(svc, gen, 'op-3', C1).then((i) => svc.finishIntent(i, 'failed'));
    await svc.withdrawDelivery({ op: 'wd-3', mission: M, delivery: 'op-3', reason: 'withdrawn' });
    await rejects(authorizeRef(svc, gen, 'op-3', C1), 'DELIVERY_NOT_CURRENT', /withdrawn/);
    // Its manifest, when named, must be in the content store.
    await rejects(authorizeRef(svc, gen, 'op-4', C1, { manifest: 'f'.repeat(64) }), 'CONTENT_MISSING');
  } finally {
    w.cleanup();
  }
});

test('a delivery recorded late (its writer outlived a newer delivery, WI-14) is stored but never becomes current', async () => {
  const w = service();
  try {
    const svc = w.svc;
    const gen = await svc.beginGeneration();
    const a = await authorizeRef(svc, gen, 'op-1', C1);
    await svc.markIntentPendingVerify(a, { pid: 7, startTime: '1', bootId: 'boot-A' });
    const b = await authorizeRef(svc, gen, 'op-2', C2);
    await record(svc, 'op-2', C2);
    await svc.finishIntent(b, 'done', { executorGone: true, outcomeVerified: true });
    // op-1's writer finally exits; its ref exists: the fact is recorded.
    await record(svc, 'op-1', C1);
    await svc.finishIntent(a, 'done', { executorGone: true, outcomeVerified: true });
    assert.equal(svc.deliveryInfo(M, 'op-1')?.state, 'recorded');
    assert.equal(svc.currentDelivery(M)?.delivery, 'op-2', 'the later delivery stays current');
    await rejects(authorizeLanding(svc, gen, 'op-1', C1), 'DELIVERY_NOT_CURRENT');
    await authorizeLanding(svc, gen, 'op-2', C2);
  } finally {
    w.cleanup();
  }
});

test('recordDelivery: one record per delivery; the same delivery again returns its revision, a different commit is a conflict', async () => {
  const w = service();
  try {
    const svc = w.svc;
    const first = await record(svc, 'op-1', C1);
    const manifest = svc.content.put('another manifest');
    const again = await svc.recordDelivery({ op: 'another-op-id', mission: M, delivery: 'op-1', commit: C1, base: BASE, ref: ref('op-1'), manifest });
    assert.equal(again.revision, first.revision);
    await rejects(svc.recordDelivery({ op: 'repoint', mission: M, delivery: 'op-1', commit: C2, base: BASE, ref: ref('op-1'), manifest }), 'FACT_CONFLICT', /never re-pointed/);
    assert.equal(readRecords(w.paths.db, revision(0)).filter((c) => c.record.kind === 'delivery.recorded').length, 1);
    // The target is optional (the delivery side may not send it); without it the landing's branch is not compared.
    await svc.recordDelivery({ op: 'r2', mission: M, delivery: 'op-2', commit: C2, base: BASE, ref: ref('op-2'), manifest });
    assert.equal(svc.deliveryInfo(M, 'op-2')?.target, null);
    const gen = await svc.beginGeneration();
    await authorizeLanding(svc, gen, 'op-2', C2, { targetBranch: 'anything' });
  } finally {
    w.cleanup();
  }
});

// ---------------------------------------------------------------- (2) the delivery with its intent, for crash recovery

test('crash recovery of a delivery ref: the intent keeps the expected commit, ref, mission, op and manifest, so completion is recorded from it', async () => {
  const w = service();
  try {
    let svc = w.svc;
    const gen = await svc.beginGeneration();
    const manifest = svc.content.put('{"key":{"mission":"m1","op":"op-1"}}');
    const intent = await authorizeRef(svc, gen, 'op-1', C1, { manifest });
    await svc.markIntentPendingVerify(intent, { pid: 4242, startTime: '99', bootId: 'boot-A' });
    // The process dies before the ref creation reported back; the ledger restarts.
    svc = w.reopen();
    const info = svc.intentInfo(intent);
    assert.equal(info?.state, 'pending_verify');
    assert.deepEqual(info?.delivery, { mission: M, op: 'op-1', commit: C1, base: BASE, ref: ref('op-1'), targetBranch: 'main', manifest, description: null });
    assert.deepEqual(info?.executor, { pid: 4242, startTime: '99', bootId: 'boot-A' });
    // Recovery read the ref: it exists and points to info.delivery.commit → record completion from the intent alone.
    const d = info!.delivery!;
    await svc.recordDelivery({ op: `delivery-record:${d.op}`, mission: d.mission, delivery: d.op, commit: d.commit, base: d.base, ref: d.ref, manifest: d.manifest!, target: d.targetBranch });
    await svc.finishIntent(intent, 'done', { executorGone: true, outcomeVerified: true });
    assert.equal(svc.currentDelivery(M)?.delivery, 'op-1');
    // Other intents carry no delivery.
    await svc.authorize({ op: 'net:authorize', gen: await svc.beginGeneration(), launch: null, intent: 'net-1', kind: 'network', domain: 'net:1', tag: TAG, details: {} });
    assert.equal(svc.intentInfo('net-1')?.delivery, null);
    // The deliveries and the intent's delivery are rebuilt from the log.
    svc.close();
    const target = join(w.dir, 'rebuilt.sqlite');
    rebuildStateFromLog(w.paths.db, w.paths.content, { into: target });
    const rows = (p: string, sql: string): unknown[] => {
      const db = new DatabaseSync(p, { readOnly: true });
      try {
        return db.prepare(sql).all().map((r) => ({ ...r }));
      } finally {
        db.close();
      }
    };
    for (const sql of ['SELECT * FROM deliveries ORDER BY mission, delivery', 'SELECT intent, delivery FROM intents ORDER BY intent']) {
      assert.deepEqual(rows(target, sql), rows(w.paths.db, sql), sql);
    }
    w.reopen();
  } finally {
    w.cleanup();
  }
});

test('an older ledger gets intents.delivery added in place; its old intents read back with no delivery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-ledger-delivery-old-'));
  try {
    const path = join(dir, 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE intents (intent TEXT PRIMARY KEY, op TEXT NOT NULL, kind TEXT NOT NULL, domain TEXT NOT NULL, launch TEXT, mission TEXT NOT NULL, capabilities TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('authorized', 'pending_verify', 'done', 'failed')), details TEXT NOT NULL, executor TEXT, updated_at INTEGER NOT NULL)",
    );
    old.exec("INSERT INTO intents VALUES ('i-old', 'op', 'delivery-ref', 'ref:x', NULL, 'm1', '[]', 'authorized', 'h', NULL, 1)");
    old.close();
    const store = new Store(path);
    try {
      const cols = (store.db.prepare('PRAGMA table_info(intents)').all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes('delivery'));
      assert.deepEqual({ ...(store.db.prepare('SELECT intent, delivery FROM intents').get() as object) }, { intent: 'i-old', delivery: null });
      assert.ok((store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").get() as object | undefined) !== undefined);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- (3) delivery rebuilds refused once exhausted

test('delivery rebuilds are recorded before they run, so the ledger refuses one on an exhausted loop (LOOP_EXHAUSTED, WI-08)', async () => {
  const w = service();
  try {
    const svc = w.svc;
    assert.ok(LOOPS_REFUSED_WHEN_EXHAUSTED.has('delivery-rebuild'));
    let k = 0;
    const rebuild = (signature: string) =>
      svc.appendRecords({ op: `rebuild-${++k}`, gen: null, records: [{ kind: 'loop.attempt', lineage: 'delivery:m1/op-1', loop: 'delivery-rebuild' as LoopKind, failureClass: null, signature }] });
    const grant = (by: 'secretary' | 'user', extra: number) =>
      svc.appendRecords({ op: `grant-${++k}`, gen: null, records: [{ kind: 'loop.grant', lineage: 'delivery:m1/op-1', loop: 'delivery-rebuild', by, extra, reason: svc.content.put(`why ${k}`) }] });
    // The base keeps moving to the same commit twice: never "no progress" for rebuilds, only the cap.
    for (const base of ['base-a', 'base-a', 'base-b']) await rebuild(base);
    const st = svc.loopState('delivery:m1/op-1', 'delivery-rebuild');
    assert.deepEqual([st.attempts, st.allowed, st.exhausted, st.reason], [3, 3, true, 'cap']);
    await assert.rejects(rebuild('base-c'), (e: unknown) => e instanceof LedgerError && e.code === 'LOOP_EXHAUSTED' && e.wi === 'WI-08');
    // WI-08: the Secretary may grant once, then only the user.
    await grant('secretary', 1);
    await rebuild('base-c');
    await rejects(rebuild('base-d'), 'LOOP_EXHAUSTED');
    await rejects(grant('secretary', 1), 'GRANT_LIMIT');
    await grant('user', 1);
    await rebuild('base-d');
    assert.equal(readRecords(w.paths.db, revision(0)).filter((c) => c.record.kind === 'loop.attempt').length, 5, 'the refused rebuilds left no record');
  } finally {
    w.cleanup();
  }
});

// ---------------------------------------------------------------- over IPC

test('over IPC: DELIVERY_NOT_CURRENT carries WI-06; the delivery queries and the withdrawal are methods', async () => {
  const w = service();
  const sock = join(w.dir, 'ledger.sock');
  const server = serveLedger(w.svc, sock);
  const client = new LedgerClient(sock, 5000);
  try {
    const gen = (await client.call('beginGeneration', {})) as Generation;
    await client.call('recordDelivery', { op: 'r1', mission: M, delivery: 'op-1', commit: C1, base: BASE, ref: ref('op-1'), manifest: w.svc.content.put('m'), target: 'main' });
    await client.call('recordDelivery', { op: 'r2', mission: M, delivery: 'op-2', commit: C2, base: BASE, ref: ref('op-2'), manifest: w.svc.content.put('m2'), target: 'main' });
    const landing = (op: string, commit: string) =>
      client.call('authorize', {
        op: `l-${op}`, gen, launch: null, intent: `l-${op}`, kind: 'landing', domain: 'landing:r', tag: TAG,
        details: { landing: `L-${op}`, delivery: { mission: M, op, commit, base: BASE, targetBranch: 'main' } },
      });
    await assert.rejects(landing('op-1', C1), (e: unknown) => e instanceof RemoteLedgerError && e.code === 'DELIVERY_NOT_CURRENT' && e.wi === 'WI-06');
    assert.equal(((await client.call('currentDelivery', { mission: M })) as { delivery: string }).delivery, 'op-2');
    assert.equal(((await client.call('deliveryInfo', { mission: M, delivery: 'op-1' })) as { state: string }).state, 'recorded');
    await client.call('withdrawDelivery', { op: 'w2', mission: M, delivery: 'op-2', reason: 'withdrawn' });
    await assert.rejects(landing('op-2', C2), (e: unknown) => e instanceof RemoteLedgerError && e.code === 'DELIVERY_NOT_CURRENT');
    await client.call('recordDelivery', { op: 'r3', mission: M, delivery: 'op-3', commit: C3, base: BASE, ref: ref('op-3'), manifest: w.svc.content.put('m3'), target: 'main' });
    await landing('op-3', C3);
    const info = (await client.call('intentInfo', { intent: 'l-op-3' })) as { delivery: { ref: string; commit: string } };
    assert.deepEqual([info.delivery.ref, info.delivery.commit], [ref('op-3'), C3]);
  } finally {
    client.close();
    await new Promise<void>((r) => server.close(() => r()));
    w.cleanup();
  }
});
