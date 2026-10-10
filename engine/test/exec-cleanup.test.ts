// Design v35 7.1, 6.3, 6.4: cleanup is progressing state per launch, separate from the
// immutable termination proof. The supervisor writes the proof file, tries the teardown,
// submits the proof, then records cleanup "done" or "pending" with what is left; the
// scheduler finishes a pending cleanup with completeCleanup once the supervisor is gone.
// Also: the ledger-backed ProofSink against a real ledger service.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { id, type Generation, type LaunchId, type MissionId, type ReservationId, type Revision } from '../src/common/ids.ts';
import type { TerminationProofRecord } from '../src/common/records.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { LedgerClient, serveLedger } from '../src/ledger/ipc.ts';
import {
  DeliveringAlertSink,
  EXEC_ALERT_WI,
  alertBody,
  alertIdentity,
  deliverPendingAlerts,
  execAlert,
  readAlerts,
  undeliveredAlerts,
  type AlertLedger,
} from '../src/exec/alerts.ts';
import { LedgerService, ledgerPaths } from '../src/ledger/service.ts';
import { readRecords } from '../src/ledger/store.ts';
import {
  completeCleanup,
  formatCleanupResource,
  isUnitCgroupPath,
  parseCleanupResource,
  recordIdentities,
  scanCleanupFiles,
  type CleanupResource,
} from '../src/exec/cleanup.ts';
import { createProofSink, proofRejectionReason } from '../src/exec/ledgerSink.ts';
import { detectExecCapabilities, findFuse2fs } from '../src/exec/platform.ts';
import { proofFilePath, type ProofSink } from '../src/exec/proof.ts';
import { createDiskImage, isMountPoint, mountDiskImage, unmountDiskImage } from '../src/exec/sandbox.ts';
import { killUnit, launchUnitSupervisor, processIdentity, waitUnitInactive } from '../src/exec/supervisor.ts';

const CLEANUP_TS = fileURLToPath(new URL('../src/exec/cleanup.ts', import.meta.url));
const SINK_TS = fileURLToPath(new URL('../src/exec/ledgerSink.ts', import.meta.url));
const caps = detectExecCapabilities();
const systemdOk = caps.systemdRun !== null && caps.delegatedControllers.includes('memory') && caps.delegatedControllers.includes('pids');
const EXTRACTED_FUSE2FS = process.env['MP_TEST_FUSE2FS']; // an unpacked fuse2fs for machines without one on PATH
const fuse2fs = findFuse2fs() ?? findFuse2fs(EXTRACTED_FUSE2FS);

const dirs: string[] = [];
const sinks: ProofSink[] = [];
const units: string[] = [];
const mounts: string[] = [];
function tmp(prefix = 'mp-exec-cleanup-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// ---------------------------------------------------------------- a real ledger service for the file

let svc: LedgerService;
let server: Server;
let socketPath = '';
let client: LedgerClient;
let gen: Generation;
const M = id<MissionId>('mission-cleanup');
let launchSeq = 0;

before(async () => {
  const d = tmp('mp-exec-ledger-');
  svc = new LedgerService({ paths: ledgerPaths(join(d, 'ledger'), join(d, 'control')) });
  svc.open();
  socketPath = join(d, 'ledger.sock');
  server = serveLedger(svc, socketPath);
  client = new LedgerClient(socketPath, 10_000);
  gen = (await client.call('beginGeneration', {})) as Generation;
});

after(async () => {
  for (const u of units) await killUnit(u);
  for (const m of mounts) if (isMountPoint(m)) await unmountDiskImage(m).catch(() => undefined);
  client?.close();
  for (const s of sinks) s.close?.();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  svc?.close();
  for (const d of dirs) {
    try {
      chmodSync(d, 0o755);
    } catch {
      /* gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

async function newLaunch(): Promise<LaunchId> {
  launchSeq++;
  const launch = id<LaunchId>(`launch-cleanup-${process.pid}-${launchSeq}`);
  await client.call('registerLaunch', { op: `reg:${launch}`, gen, launch, tag: { mission: M, capabilities: [] } });
  return launch;
}

function ledgerCleanups(): unknown {
  return svc.pendingCleanups();
}

// ---------------------------------------------------------------- pure

describe('cleanup resources: encoding', () => {
  test('every kind round-trips through its string', () => {
    const rs: CleanupResource[] = [
      { kind: 'holder', pid: 1234, startTime: 98765, bootId: 'fe06261f-c570-40a1-9b36-bd2b2d29a378' },
      { kind: 'cgroup', path: '/sys/fs/cgroup/user.slice/x.service/unit' },
      { kind: 'mount', path: '/tmp/a:b/mnt' },
      { kind: 'image', path: '/tmp/u.img' },
      { kind: 'grant', path: '/run/cp/net-grants/L1.json' },
      { kind: 'path', path: '/tmp/scratch' },
    ];
    for (const r of rs) assert.deepEqual(parseCleanupResource(formatCleanupResource(r)), r);
    assert.equal(formatCleanupResource({ kind: 'mount', path: '/tmp/m' }), 'mount:/tmp/m');
  });

  test('malformed entries are refused', () => {
    for (const bad of ['', 'mount', 'nope:/x', 'path:relative', 'path:/', 'path:/a/../b', 'cgroup:/tmp/x', 'holder:1:2', 'holder:x:2:ab']) {
      assert.throws(() => parseCleanupResource(bad), bad);
    }
  });

  test('only a program unit subtree of the calling user is a cleanable cgroup', () => {
    const uid = process.getuid?.() ?? 0;
    const root = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service`;
    assert.equal(isUnitCgroupPath(`${root}/app.slice/mp-unit-L1.service/unit`), true);
    assert.equal(isUnitCgroupPath(`${root}/app.slice`), false);
    assert.equal(isUnitCgroupPath(`${root}/app.slice/other.service/unit`), false);
    assert.equal(isUnitCgroupPath(`${root}/app.slice/mp-unit-L1.service`), false);
    assert.equal(isUnitCgroupPath(`/sys/fs/cgroup/user.slice/user-${uid + 1}.slice/user@${uid + 1}.service/app.slice/mp-x.service/unit`), false);
  });
});

describe('completeCleanup (scheduler side)', () => {
  test('releases what lies under its roots, and is idempotent', async () => {
    const root = tmp();
    mkdirSync(join(root, 'scratch', 'deep'), { recursive: true });
    writeFileSync(join(root, 'scratch', 'deep', 'f'), 'x');
    writeFileSync(join(root, 'grant.json'), '{}');
    writeFileSync(join(root, 'u.img'), 'img');
    const rs = recordIdentities([`path:${join(root, 'scratch')}`, `grant:${join(root, 'grant.json')}`, `image:${join(root, 'u.img')}`, `path:${join(root, 'never-there')}`], { roots: [root] });
    assert.deepEqual(await completeCleanup(rs, { roots: [root] }), []);
    assert.equal(existsSync(join(root, 'scratch')), false);
    assert.deepEqual(await completeCleanup(rs, { roots: [root] }), [], 'a second run finds nothing left and fails nothing');
  });

  test('never acts outside its roots or on a cgroup that is not a program unit; keeps unparsable entries', async () => {
    const inside = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    const rs = [`path:${join(outside, 'keep.txt')}`, 'cgroup:/sys/fs/cgroup/user.slice', 'garbage'];
    assert.deepEqual(await completeCleanup(rs, { roots: [inside] }), rs);
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep');
  });

  test('a holder is ended only when its identity (pid, start time, boot) still matches', async () => {
    const p = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const me = processIdentity(p.pid as number);
      assert.ok(me);
      const stale = formatCleanupResource({ kind: 'holder', pid: me.pid, startTime: me.startTime + 1, bootId: me.bootId });
      assert.deepEqual(await completeCleanup([stale], { roots: [] }), [], 'a different process is already "gone"');
      assert.equal(p.exitCode, null, 'and is not touched');
      const live = formatCleanupResource({ kind: 'holder', pid: me.pid, startTime: me.startTime, bootId: me.bootId });
      assert.deepEqual(await completeCleanup([live], { roots: [] }), []);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(p.signalCode, 'SIGKILL');
    } finally {
      p.kill('SIGKILL');
    }
  });
});

// ---------------------------------------------------------------- the ledger-backed sink

describe('ProofSink backed by the ledger service (ledgerSink.ts)', () => {
  test('registration is idempotent; deterministic rejections carry their reason', async () => {
    const sink = createProofSink({ socketPath });
    sinks.push(sink);
    const launch = await newLaunch();
    const proof: TerminationProofRecord = { kind: 'termination.proof', launch, exit: { code: 0, signal: null }, controlOomKill: 0, unitOomKill: 0, unitOom: 0 };
    assert.deepEqual(await sink.submit(proof), { kind: 'registered', ack: `termination-proof:${launch}`, duplicate: false });
    assert.deepEqual(await sink.submit(proof), { kind: 'registered', ack: `termination-proof:${launch}`, duplicate: true });
    const conflict = await sink.submit({ ...proof, unitOom: 1 });
    assert.equal(conflict.kind === 'rejected' && conflict.reason, 'conflicting-proof');
    const unknown = await sink.submit({ ...proof, launch: id<LaunchId>('launch-never-registered') });
    assert.equal(unknown.kind === 'rejected' && unknown.reason, 'launch-mismatch');
    const malformed = await sink.submit({ ...proof, exit: { code: 0, signal: 'SIGKILL' } });
    assert.equal(malformed.kind === 'rejected' && malformed.reason, 'malformed');
    const down = createProofSink({ socketPath: join(tmp(), 'no.sock'), timeoutMs: 500 });
    sinks.push(down);
    assert.equal((await down.submit(proof)).kind, 'unavailable');
  });

  test('rejection reasons come from the ledger codes; anything else is retried', () => {
    assert.equal(proofRejectionReason('PROOF_CONFLICT'), 'conflicting-proof');
    assert.equal(proofRejectionReason('PROOF_UNKNOWN_LAUNCH'), 'launch-mismatch');
    assert.equal(proofRejectionReason('PROOF_MALFORMED'), 'malformed');
    for (const code of ['PROOF_REJECTED', 'STORAGE_FAULT', 'PROOF_EXISTS', 'PROOF_REQUIRED', 'UNKNOWN_LAUNCH', '']) assert.equal(proofRejectionReason(code), null, code);
  });

  test('a dead host\'s open reservations are settled at the reserved amount', async () => {
    const sink = createProofSink({ socketPath });
    sinks.push(sink);
    const launch = await newLaunch();
    await client.call('reserveSpend', { op: `res:${launch}`, reservation: id<ReservationId>(`${launch}.q1`), launch, micros: 777 });
    assert.equal(await sink.settleOpenSpend?.(launch), 'settled');
    const s = svc.spendSummary(M);
    assert.equal(s.inflight, 0);
    assert.ok(s.spent >= 777);
    assert.equal(await sink.settleOpenSpend?.(launch), 'settled', 'idempotent');
  });
});

// ---------------------------------------------------------------- supervisor cleanup state

async function runUnit(o: {
  launch: LaunchId;
  host: string[];
  state: string;
  cleanup?: { fuseMounts?: string[]; images?: string[]; networkGrants?: string[]; paths?: string[] };
}): Promise<void> {
  const unitName = `mp-exec-test-cleanup-${process.pid}-${launchSeq}-${Date.now() % 100000}.service`;
  units.push(unitName);
  await launchUnitSupervisor({
    config: {
      launch: o.launch,
      stateDir: o.state,
      host: { argv: o.host, env: { PATH: '/usr/bin:/bin' }, cwd: o.state },
      unit: { memoryMax: 128 * 1024 * 1024, pidsMax: 64 },
      sink: { module: SINK_TS, options: { socketPath, contentRoot: svc.paths.content } },
      retry: { initialDelayMs: 50, maxDelayMs: 100, totalMs: 1_000 },
      ...(o.cleanup !== undefined ? { cleanup: o.cleanup } : {}),
    },
    unitName,
    logPath: join(o.state, 'supervisor.log'),
  });
  const done = await waitUnitInactive(unitName, 30_000);
  assert.ok(done, existsSync(join(o.state, 'supervisor.log')) ? readFileSync(join(o.state, 'supervisor.log'), 'utf8') : 'unit still active');
}

/** The fuse2fs daemons serving an image (by their command line). */
function fuse2fsOf(image: string): number[] {
  return readdirSync('/proc')
    .filter((n) => /^\d+$/.test(n))
    .filter((pid) => {
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        return cmd.includes('fuse2fs') && cmd.includes(image);
      } catch {
        return false;
      }
    })
    .map(Number);
}

/** completeCleanup run by "another process" (as the scheduler would). */
function completeCleanupElsewhere(resources: readonly string[], roots: readonly string[]): string[] {
  const out = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(`file://${CLEANUP_TS}`)}); const [r, roots] = JSON.parse(process.argv[1]); const p = await m.cleanupPass(r, { roots }); if (p.refusals.length > 0) process.stderr.write(JSON.stringify(p.refusals) + '\\n'); console.log(JSON.stringify(p.left));`,
      JSON.stringify([resources, roots]),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(out.trim()) as string[];
}

describe('supervisor cleanup state (v35)', { skip: systemdOk ? false : 'needs systemd-run --user with delegated controllers' }, () => {
  test('a teardown that fails leaves the proof registered and the cleanup pending; another process finishes it', async () => {
    const state = tmp();
    const launch = await newLaunch();
    const grants = join(state, 'grants');
    mkdirSync(grants);
    const grant = join(grants, `${launch}.json`);
    writeFileSync(grant, '{"allow":["example.org"]}');
    chmodSync(grants, 0o555); // the grant cannot be deleted: teardown fails for it
    try {
      await runUnit({ launch, host: ['/bin/sh', '-c', 'exit 0'], state, cleanup: { networkGrants: [grant] } });
    } finally {
      chmodSync(grants, 0o755);
    }
    assert.deepEqual(svc.proofFor(launch), { kind: 'termination.proof', launch, exit: { code: 0, signal: null }, controlOomKill: 0, unitOomKill: 0, unitOom: 0 });
    assert.equal(existsSync(proofFilePath(state, launch)), false, 'the registered proof file is removed');
    const local = scanCleanupFiles(state).find((f) => f.launch === launch);
    assert.ok(local, 'a local cleanup state is kept');
    assert.equal(local.state, 'pending');
    assert.equal(local.resources.length, 1, 'only the grant is left; the unit cgroup was released');
    const left = parseCleanupResource(local.resources[0] as string);
    assert.ok(left.kind === 'grant' && left.path === grant);
    assert.ok(left.kind === 'grant' && left.identity !== undefined, 'bound to the identity the grant had when the unit started (finding 1)');
    assert.equal(local.recorded, true);
    assert.deepEqual(
      svc.pendingCleanups().find((c) => c.launch === launch),
      { launch, resources: local.resources },
      'the ledger lists the pending cleanup for the scheduler',
    );
    // 3.11: the supervisor told the PM, in the ledger, with the WI, the facts and the default action
    const alert = readRecords(svc.paths.db, 0 as Revision)
      .map((c) => c.record)
      .filter((r): r is Extract<typeof r, { kind: 'alert' }> => r.kind === 'alert' && r.category === 'cleanup-pending')
      .map((r) => ({ wi: r.wi, body: JSON.parse(svc.content.get(r.body).toString('utf8')) as { launch: string; trigger: { left: string[] }; defaultAction: string } }))
      .find((a) => a.body.launch === launch);
    assert.ok(alert !== undefined, 'the cleanup-pending alert reached the ledger');
    assert.equal(alert.wi, 'WI-14');
    assert.deepEqual(alert.body.trigger.left, local.resources);
    assert.match(alert.body.defaultAction, /pending cleanup/);
    // the scheduler, once the supervisor is gone:
    assert.deepEqual(completeCleanupElsewhere(local.resources, [grants]), []);
    assert.equal(existsSync(grant), false);
    await client.call('recordCleanup', { op: `cleanup:${launch}:done`, launch, state: 'done', resources: svc.content.putList([]) });
    assert.equal(svc.cleanupState(launch), 'done');
    assert.doesNotMatch(JSON.stringify(ledgerCleanups()), new RegExp(launch));
  });

  test('a busy FUSE mount is not lazily detached: pending until it is free, then finished', { skip: fuse2fs === null ? 'needs fuse2fs' : false }, async () => {
    const state = tmp();
    const launch = await newLaunch();
    const image = join(state, 'unit.img');
    const mnt = join(state, 'mnt');
    mkdirSync(mnt);
    mounts.push(mnt);
    await createDiskImage({ path: image, bytes: 16 * 1024 * 1024, inodes: 64 });
    await mountDiskImage(image, mnt, fuse2fs as string);
    const busy = spawn('sleep', ['60'], { cwd: mnt, stdio: 'ignore' });
    try {
      await runUnit({ launch, host: ['/bin/sh', '-c', 'exit 0'], state, cleanup: { fuseMounts: [mnt], images: [image] } });
      const local = scanCleanupFiles(state).find((f) => f.launch === launch);
      assert.ok(local);
      assert.equal(local.state, 'pending');
      assert.ok(local.resources.includes(`mount:${mnt}`), JSON.stringify(local.resources));
      assert.equal(isMountPoint(mnt), true, 'still mounted while busy');
      // finding 2: the image depends on the mount; it is kept, and listed, while the mount is
      assert.equal(existsSync(image), true, 'the image is not deleted under a busy mount');
      assert.ok(local.resources.some((r) => r.startsWith('image') && r.endsWith(`:${image}`)), 'and stays a pending (counted) resource');
      assert.equal(svc.cleanupState(launch), 'pending');
    } finally {
      busy.kill('SIGKILL');
    }
    await new Promise((r) => setTimeout(r, 200));
    const local = scanCleanupFiles(state).find((f) => f.launch === launch);
    let left = completeCleanupElsewhere(local?.resources ?? [], [mnt, image]);
    assert.equal(isMountPoint(mnt), false, 'unmounted once free');
    if (left.length > 0) {
      // A mount namespace created meanwhile (another test's sandbox holder binds the host's "/")
      // keeps its copy of the FUSE mount, so fuse2fs, and the image, stay held after the unmount.
      // Cleanup keeps the image pending and counted. In a unit, fuse2fs runs in the unit's
      // cgroup and ends with it; this image was mounted outside any unit, so end it here.
      assert.ok(left.every((r) => r.startsWith('image')), JSON.stringify(left));
      assert.equal(existsSync(image), true, 'kept while held');
      for (const pid of fuse2fsOf(image)) process.kill(pid, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 300));
      left = completeCleanupElsewhere(left, [mnt, image]);
    }
    assert.deepEqual(left, []);
    assert.equal(existsSync(image), false);
  });

  test('a launch cancelled first still gets its proof registered and its cleanup done', async () => {
    const state = tmp();
    const launch = await newLaunch();
    const scratch = join(state, 'scratch');
    mkdirSync(scratch);
    writeFileSync(join(scratch, 'f'), 'x');
    const disposal = new Promise<void>((resolve) => setTimeout(() => {
      void client.call('dispose', { gen, launch, disposition: 'cancelled', reason: 'test: cancelled while running' }).then(() => resolve());
    }, 100));
    await Promise.all([runUnit({ launch, host: ['/bin/sh', '-c', 'sleep 1; exit 0'], state, cleanup: { paths: [scratch] } }), disposal]);
    assert.equal(svc.dispositionFor(launch), 'cancelled');
    assert.ok(svc.proofFor(launch), 'the proof is registered as a fact after the final disposition');
    assert.equal(existsSync(scratch), false);
    assert.equal(scanCleanupFiles(state).find((f) => f.launch === launch), undefined, 'done and recorded: no local copy left');
    assert.equal(svc.cleanupState(launch), 'done');
  });
});

// ---------------------------------------------------------------- code review r1 finding 15: alerts
// Code review r1 finding 15 (design 3.11 "程序发出例外告知：WI 编号、触发事实、已执行的默认处置"):
// every exception the execution layer and the seat host can emit has its WI; an alert carries
// the trigger facts and the default action already taken; it is delivered to the ledger's
// raiseAlert (the alert record's `wi` field), with a durable local copy that is carried over
// later when the ledger was unavailable; raising the same alert again is the same operation.

const alertContent = (): ContentStore => new ContentStore(svc.paths.content);

function allLedgerAlerts(): { alert: string; category: string; wi: string | undefined; body: Record<string, unknown> }[] {
  return readRecords(svc.paths.db, 0 as Revision)
    .map((c) => c.record)
    .filter((r): r is Extract<typeof r, { kind: 'alert' }> => r.kind === 'alert')
    .map((r) => ({ alert: r.alert, category: r.category, wi: r.wi, body: JSON.parse(alertContent().get(r.body).toString('utf8')) as Record<string, unknown> }));
}

const AL = id<LaunchId>('launch-alerts-1');

describe('every exception has a WI (3.11 principle 5)', () => {
  test('the catalogue maps every kind to a v42 work instruction', () => {
    const kinds = Object.keys(EXEC_ALERT_WI);
    assert.ok(kinds.length >= 18);
    for (const [k, wi] of Object.entries(EXEC_ALERT_WI)) assert.match(wi, /^WI-(09|10|12|14|15|17|18|20)$/, k);
    assert.equal(EXEC_ALERT_WI['spend-refused'], 'WI-09');
    assert.equal(EXEC_ALERT_WI['area-unavailable'], 'WI-10');
    assert.equal(EXEC_ALERT_WI['cleanup-pending'], 'WI-14');
    assert.equal(EXEC_ALERT_WI['unkillable-processes'], 'WI-14');
    assert.equal(EXEC_ALERT_WI['attempt-failed'], 'WI-15');
    assert.equal(EXEC_ALERT_WI['async-evidence-refused'], 'WI-17');
    assert.equal(EXEC_ALERT_WI['recovery-state-degraded'], 'WI-17');
    assert.equal(EXEC_ALERT_WI['selfcheck-failed'], 'WI-18');
    assert.equal(EXEC_ALERT_WI['proof-rejected'], 'WI-20');
    assert.equal(EXEC_ALERT_WI['cleanup-identity-mismatch'], 'WI-20');
  });

  test('an alert is {wi, trigger facts, default action}; its body is deterministic for the occurrence', () => {
    const a = execAlert('cleanup-pending', AL, 'left: x', { left: ['path:/x'] }, 'retried with back-off');
    assert.deepEqual([a.wi, a.trigger, a.defaultAction], ['WI-14', { left: ['path:/x'] }, 'retried with back-off']);
    const again = { ...a, at: 'later' };
    assert.equal(alertBody('exec', a), alertBody('exec', again), 'no timestamp in the body: a re-raise is the same operation');
    assert.equal(alertIdentity('exec', a), alertIdentity('exec', again));
    assert.notEqual(alertIdentity('exec', a), alertIdentity('exec', { ...a, key: 'other' }));
  });
});

describe('delivery: the ledger, with a durable local fallback', () => {
  test('delivered to raiseAlert with its WI; the local copy is kept; the same alert twice is one record', async () => {
    const state = tmp();
    const sink = new DeliveringAlertSink(state, 'exec', { client, content: alertContent() });
    const a = execAlert('unkillable-processes', AL, 'pids 1 2 remain', { pids: [1, 2] }, 'cgroup.kill repeated');
    await sink.alert(a);
    await sink.alert({ ...a, at: 'later' });
    await sink.flush();
    const mine = allLedgerAlerts().filter((x) => x.category === 'unkillable-processes');
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.wi, 'WI-14');
    assert.deepEqual(mine[0]?.body['trigger'], { pids: [1, 2] });
    assert.equal(mine[0]?.body['defaultAction'], 'cgroup.kill repeated');
    assert.equal(readAlerts(state).length, 2, 'both raises are in the local file');
    assert.deepEqual(undeliveredAlerts(state), []);
  });

  test('the ledger unavailable: kept locally as undelivered, then carried over; a later conflicting body counts as delivered', async () => {
    const state = tmp();
    const down: AlertLedger = { call: async () => Promise.reject(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })) };
    const sink = new DeliveringAlertSink(state, 'exec', { client: down, content: alertContent() });
    await sink.alert(execAlert('proof-submission-exhausted', AL, 'gave up', { attempts: 9 }, 'the proof file is left'));
    await sink.alert(execAlert('cleanup-identity-mismatch', AL, 'replaced', { resource: 'path@1.2:/x' }, 'nothing deleted', 'k1'));
    assert.deepEqual(undeliveredAlerts(state).map((x) => [x.kind, x.wi]), [
      ['proof-submission-exhausted', 'WI-12'],
      ['cleanup-identity-mismatch', 'WI-20'],
    ]);
    assert.equal(await deliverPendingAlerts(state, client, alertContent()), 2);
    assert.deepEqual(undeliveredAlerts(state), []);
    assert.ok(allLedgerAlerts().some((x) => x.category === 'proof-submission-exhausted' && x.wi === 'WI-12'));
    // the same identity with other facts (another launch refused by the same failure): delivered once
    const s2 = tmp();
    const one = new DeliveringAlertSink(s2, 'exec', { client, content: alertContent() });
    await one.alert(execAlert('selfcheck-failed', null, 'v1', { missing: [8] }, 'not started', 'selfcheck:key'));
    await one.alert(execAlert('selfcheck-failed', null, 'v1', { missing: [8, 9] }, 'not started', 'selfcheck:key'));
    await one.flush();
    assert.deepEqual(undeliveredAlerts(s2), [], 'the conflict is not retried forever');
    assert.equal(allLedgerAlerts().filter((x) => x.category === 'selfcheck-failed').length, 1);
  });

  test("the supervisor's sink delivers alerts too (ledgerSink.raiseAlert)", async () => {
    const sink = createProofSink({ socketPath, contentRoot: svc.paths.content });
    try {
      assert.equal(await sink.raiseAlert?.(execAlert('proof-rejected', AL, 'conflicting-proof', { reason: 'conflicting-proof' }, 'marked rejected')), 'delivered');
      assert.ok(allLedgerAlerts().some((x) => x.category === 'proof-rejected' && x.wi === 'WI-20'));
      const noContent = createProofSink({ socketPath });
      assert.equal(await noContent.raiseAlert?.(execAlert('proof-rejected', AL, 'x', {}, 'y', 'k2')), 'unavailable');
      noContent.close?.();
    } finally {
      sink.close?.();
    }
  });
});
