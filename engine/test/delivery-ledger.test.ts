// Delivery with its authority on the real ledger service over IPC (6.6 steps 6 and 8, 6.1, 6.5).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { findProcessesByToken, killProcess } from '../src/git/safeGit.ts';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { canonicalJson } from '../src/common/hash.ts';
import { id, revision, type GitOid, type OpId, type StopId } from '../src/common/ids.ts';
import { deliver, deliveryIntentToken, resumeDeliveryRef, type DeliveryIntent, type DeliveryKey, type DeliveryRequest } from '../src/delivery/deliver.ts';
import { RemoteLedgerError } from '../src/ledger/ipc.ts';
import { deliveryRecordJson, deliveryRefDomain, LedgerDeliveryAuthority, settleDeliveryIntent } from '../src/delivery/ledgerAuthority.ts';
import { discoverRepo, type RepoLayout } from '../src/git/objects.ts';
import { deliveryRef } from '../src/git/refs.ts';
import { readTransformDescription, transformDescriptionHash, type TransformDescription } from '../src/git/representation.ts';
import { readRecords } from '../src/ledger/store.ts';
import { checkoutMain, initRepo, makeFixture, rawCommit, startLedger, type FileSpec, type Fixture, type LedgerHarness } from './git-fixtures.test.ts';
import { FakeProofView, MISSION, StubChecks, obj, productVersion } from './delivery-fixtures.test.ts';
import { NO_QUIET, TEST_DISK } from './delivery-fixtures.test.ts';

let fx: Fixture;
before(() => {
  fx = makeFixture('delivery-ledger');
});
after(() => fx.cleanup());

const ident = { name: 'Mission Pipeline', email: 'engine@example.invalid', date: '1700000400 +0000' };
const BASE: Record<string, FileSpec> = { 'a/x.ts': 'x 1\n', 'docs/readme.md': 'readme 1\n' };
let n = 0;

interface World {
  repo: string;
  layout: RepoLayout;
  M0: GitOid;
  d: TransformDescription;
  view: FakeProofView;
  h: LedgerHarness;
}

async function world(): Promise<World> {
  const repo = initRepo(fx, `d${n++}`);
  const M0 = rawCommit(fx, repo, BASE, null, 'M0');
  checkoutMain(fx, repo, M0);
  const layout = await discoverRepo(fx.git, repo);
  const d = await readTransformDescription(fx.git, layout, fx.user);
  const CA1 = rawCommit(fx, repo, { ...BASE, 'a/x.ts': 'x 2\n' }, M0, 'A1');
  const view = new FakeProofView().add(
    await productVersion(fx.git, layout, { id: 'a1', module: 'a', writeScope: ['a/**'], commit: CA1, transform: transformDescriptionHash(d) }),
  );
  const h = await startLedger(join(fx.root, `ledger${n++}`));
  return { repo, layout, M0, d, view, h };
}

function request(w: World, op: string): DeliveryRequest {
  return {
    key: { mission: MISSION, op: id<OpId>(op) },
    repoPath: w.repo,
    targetBranch: 'main',
    selected: [obj('a1')],
    description: w.d,
    closingChecks: [{ id: 'tests', command: ['npm', 'test'] }],
    author: ident,
    committer: ident,
  };
}

function authorityFor(w: World, req: DeliveryRequest, lineage = 'lineage-1'): LedgerDeliveryAuthority {
  return new LedgerDeliveryAuthority({
    client: w.h.client,
    content: w.h.content,
    gen: w.h.gen,
    tag: { mission: MISSION, capabilities: [] },
    lineage,
    domain: deliveryRefDomain(w.layout, deliveryRef(req.key.mission, req.key.op)),
  });
}

function events(w: World): Record<string, unknown>[] {
  return readRecords(w.h.paths.db, revision(0)).map((c) => c.record as unknown as Record<string, unknown>);
}

function advanceMain(w: World, tag: string): GitOid {
  const parent = fx.raw(['rev-parse', 'main'], w.repo);
  const c = rawCommit(fx, w.repo, { ...BASE, 'docs/readme.md': `readme ${tag}\n` }, parent, tag);
  fx.raw(['update-ref', 'refs/heads/main', c, parent], w.repo);
  return c;
}

test('the delivery ref is an authorized external action: writer recorded on the intent, finished verified, record stored', async () => {
  const w = await world();
  try {
    const req = request(w, 'op-1');
    const authority = authorityFor(w, req);
    const r = await deliver(req, { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
    assert.equal(r.kind, 'delivered', JSON.stringify(r));
    if (r.kind !== 'delivered') return;
    const log = events(w);
    const authorized = log.filter((e) => e.kind === 'intent.authorized');
    assert.equal(authorized.length, 1);
    assert.equal(authorized[0]?.intentKind, 'delivery-ref');
    const intent = String(authorized[0]?.intent);
    assert.deepEqual(log.filter((e) => e.kind === 'intent.state' && e.intent === intent).map((e) => e.state), ['pending_verify', 'done']);
    assert.equal(await w.h.client.call('intentState', { intent }), 'done');
    // 6.6 step 8 through recordDelivery: the record before the intent is done, the manifest by hash.
    const recorded = log.filter((e) => e.kind === 'delivery.recorded');
    assert.equal(recorded.length, 1);
    assert.deepEqual(
      [recorded[0]?.mission, recorded[0]?.delivery, recorded[0]?.commit, recorded[0]?.base, recorded[0]?.ref],
      [MISSION, 'op-1', r.record.commit, r.record.base, r.record.ref],
    );
    const stored = JSON.parse(w.h.content.get(recorded[0]?.manifest as never).toString()) as { commit: string; ref: string; manifest: { paths: [string, string][] } };
    assert.equal(stored.commit, r.record.commit);
    assert.deepEqual(stored.manifest.paths, [['a/x.ts', 'a1']]);
    const order = log.map((e) => (e.kind === 'delivery.recorded' ? 'recorded' : e.kind === 'intent.state' && e.state === 'done' ? 'done' : null)).filter((x) => x !== null);
    assert.deepEqual(order, ['recorded', 'done']);
    // Recovery reads the writer identity back from the ledger (intentInfo): the writer is gone, the ref is there.
    const { recoverDeliveryRefFromLedger } = await import('../src/delivery/ledgerAuthority.ts');
    assert.deepEqual(await recoverDeliveryRefFromLedger(fx.git, w.layout, w.h.client, req.key, intent, r.record.commit), { kind: 'done' });
    const info = (await w.h.client.call('intentInfo', { intent })) as { executor: { pid: number } | null };
    assert.ok((info.executor?.pid ?? 0) > 0);
  } finally {
    await w.h.close();
  }
});

test('rebuilds are loop.attempt records counted from the log; the limit of 3 grows only by granted extras (6.5)', async () => {
  const w = await world();
  try {
    // This lineage already used its 3 rebuilds.
    for (let i = 0; i < 3; i++) {
      await w.h.client.call('appendRecords', {
        op: `old-rebuild-${i}`,
        gen: w.h.gen,
        records: [{ kind: 'loop.attempt', lineage: 'lineage-x', loop: 'delivery-rebuild', failureClass: null, signature: `base-moved:${i}` }],
      });
    }
    const checks = new StubChecks();
    checks.onRun = (call) => {
      advanceMain(w, `moved-${n}-${call}`);
    };
    const req1 = request(w, 'op-exhausted');
    const r1 = await deliver(req1, { git: fx.git, view: w.view, authority: authorityFor(w, req1, 'lineage-x'), checks, scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
    assert.deepEqual(r1, { kind: 'rebuild-limit-exhausted', rebuilds: 3 });
    // 3.11 (v42): the exhaustion is a system alert carrying WI-08, its body the trigger facts and the default action.
    const alerts = events(w).filter((e) => e.kind === 'alert' && e.wi === 'WI-08');
    assert.equal(alerts.length, 1);
    const body = JSON.parse(w.h.content.get(alerts[0]?.body as never).toString()) as { trigger: string; defaultAction: string; facts: { rebuilds: number } };
    assert.equal(body.facts.rebuilds, 3);
    assert.match(body.defaultAction, /Secretary/);

    // Secretary grants 2 more (once per lineage); the next delivery may rebuild once and then succeed.
    const reason = w.h.content.put(canonicalJson({ why: 'main is busy today' }));
    await w.h.client.call('appendRecords', {
      op: 'grant-1',
      gen: w.h.gen,
      records: [{ kind: 'loop.grant', lineage: 'lineage-x', loop: 'delivery-rebuild', by: 'secretary', extra: 2, reason }],
    });
    const moveOnce = new StubChecks();
    moveOnce.onRun = (call) => {
      if (call === 1) advanceMain(w, `moved-once-${n}`);
    };
    const req2 = request(w, 'op-granted');
    const authority2 = authorityFor(w, req2, 'lineage-x');
    const r2 = await deliver(req2, { git: fx.git, view: w.view, authority: authority2, checks: moveOnce, scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
    assert.equal(r2.kind, 'delivered', JSON.stringify(r2));
    if (r2.kind === 'delivered') assert.equal(r2.record.rebuilds, 4);
    assert.deepEqual(await authority2.rebuildBudget(req2.key), { used: 4, limit: 5 });
    const attempts = events(w).filter((e) => e.kind === 'loop.attempt' && e.lineage === 'lineage-x');
    assert.equal(attempts.length, 4);
    assert.match(String(attempts[3]?.signature), /^base-moved:[0-9a-f]{40}$/);
    // The ledger keeps the counters (loopState); per-base signatures are never "no progress" (6.5).
    const st = (await w.h.client.call('loopState', { lineage: 'lineage-x', loop: 'delivery-rebuild' })) as { attempts: number; repeats: number; secretaryGrants: number; extra: number };
    assert.deepEqual([st.attempts, st.repeats, st.secretaryGrants, st.extra], [4, 0, 1, 2]);
    await assert.rejects(
      w.h.client.call('appendRecords', {
        op: 'grant-2',
        gen: w.h.gen,
        records: [{ kind: 'loop.grant', lineage: 'lineage-x', loop: 'delivery-rebuild', by: 'secretary', extra: 1, reason }],
      }),
      /once per lineage/,
    );
  } finally {
    await w.h.close();
  }
});

test('moved after authorization: the superseded intent is released before the next authorization, so the domain is never busy', async () => {
  const w = await world();
  try {
    const req = request(w, 'op-moving');
    class MovingAuthority extends LedgerDeliveryAuthority {
      calls = 0;
      override async authorize(key: DeliveryKey, intent: DeliveryIntent) {
        const res = await super.authorize(key, intent);
        if (++this.calls === 1) advanceMain(w, `after-auth-${n}`);
        return res;
      }
    }
    const authority = new MovingAuthority({
      client: w.h.client,
      content: w.h.content,
      gen: w.h.gen,
      tag: { mission: MISSION, capabilities: [] },
      lineage: 'lineage-m',
      domain: deliveryRefDomain(w.layout, deliveryRef(req.key.mission, req.key.op)),
    });
    const r = await deliver(req, { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
    assert.equal(r.kind, 'delivered', JSON.stringify(r));
    const log = events(w);
    const intents = log.filter((e) => e.kind === 'intent.authorized').map((e) => String(e.intent));
    assert.equal(intents.length, 2);
    assert.equal(await w.h.client.call('intentState', { intent: intents[0] as string }), 'failed');
    assert.equal(await w.h.client.call('intentState', { intent: intents[1] as string }), 'done');
    assert.equal(log.filter((e) => e.kind === 'loop.attempt' && e.lineage === 'lineage-m').length, 1);
  } finally {
    await w.h.close();
  }
});

test('a committed stop refuses the delivery ref: no ref, no intent', async () => {
  const w = await world();
  try {
    await w.h.client.call('stop', { stop: id<StopId>('s1'), scope: { kind: 'mission', mission: MISSION }, words: '停', at: 1 });
    const req = request(w, 'op-stopped');
    const r = await deliver(req, { git: fx.git, view: w.view, authority: authorityFor(w, req), checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
    assert.equal(r.kind, 'authorization-refused');
    assert.match(r.kind === 'authorization-refused' ? r.reason : '', /STOPPED/);
    assert.equal(fx.rawStatus(['show-ref', '--verify', '--quiet', deliveryRef(req.key.mission, req.key.op)], w.repo).code, 1);
    assert.equal(events(w).filter((e) => e.kind === 'intent.authorized').length, 0);
  } finally {
    await w.h.close();
  }
});

// ---------------------------------------------------------------- review r1 #8, #9 on the real ledger

async function waitFor(path: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Kills the ref writer of `key` (found by the token on its command line) once it stopped at `point`. */
async function killWriterAt(key: DeliveryKey, pause: string, point: string): Promise<void> {
  await waitFor(`${pause}.paused-${point}`);
  for (const p of findProcessesByToken(`mission-pipeline.intent=${deliveryIntentToken(key)}`)) killProcess(p);
}

function plantStaleLock(w: World, req: DeliveryRequest): string {
  const ref = deliveryRef(req.key.mission, req.key.op);
  mkdirSync(join(w.layout.commonDir, 'refs/mission-pipeline/delivered', MISSION), { recursive: true });
  const lock = join(w.layout.commonDir, `${ref}.lock`);
  writeFileSync(lock, '');
  return lock;
}

test('review r1 #8: every authorization is a new intent; a stop committed after a failed write refuses the retry (no replay of the old authorization)', async () => {
  const w = await world();
  try {
    const req = request(w, 'op-retry-stopped');
    const pause = join(fx.root, `pause-retry-${n++}`);
    // The first write fails: its writer dies holding its (recorded) lock.
    const killing = killWriterAt(req.key, pause, 'after-lock');
    class StopAfterFailure extends LedgerDeliveryAuthority {
      override async finish(key: DeliveryKey, outcome: 'failed'): Promise<void> {
        await super.finish(key, outcome);
        await w.h.client.call('stop', { stop: id<StopId>('s-between'), scope: { kind: 'mission', mission: MISSION }, words: '停', at: 2 });
      }
    }
    const authority = new StopAfterFailure({
      client: w.h.client,
      content: w.h.content,
      gen: w.h.gen,
      tag: { mission: MISSION, capabilities: [] },
      lineage: 'lineage-s',
      domain: deliveryRefDomain(w.layout, deliveryRef(req.key.mission, req.key.op)),
    });
    const r = await deliver(req, { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET, testRefOptions: { testPause: { at: ['after-lock'], file: pause } } });
    await killing;
    assert.equal(r.kind, 'authorization-refused', JSON.stringify(r));
    assert.match(r.kind === 'authorization-refused' ? r.reason : '', /STOPPED/);
    const log = events(w);
    const authorized = log.filter((e) => e.kind === 'intent.authorized').map((e) => String(e.intent));
    assert.equal(authorized.length, 1, 'the retry was not authorized: the stop was re-checked');
    assert.equal(await w.h.client.call('intentState', { intent: authorized[0] as string }), 'failed', 'the failed attempt was finished first');
    assert.equal(fx.rawStatus(['show-ref', '--verify', '--quiet', deliveryRef(req.key.mission, req.key.op)], w.repo).code, 1, 'no ref');
  } finally {
    await w.h.close();
  }
});

test('review r1 #8: two authorizations of the same candidate are two intents, each checked (never an idempotent replay)', async () => {
  const w = await world();
  try {
    const req = request(w, 'op-two');
    const authority = authorityFor(w, req, 'lineage-two');
    const record = { key: req.key, targetBranch: 'main', manifest: { revision: 1, selected: [], entries: [], units: [], paths: new Map() }, base: w.M0, commit: w.M0, ref: deliveryRef(req.key.mission, req.key.op), proof: { proven: [], notFullyProven: [], needsReverification: [] }, checks: [], rebuilds: 0, landed: false } as unknown as DeliveryIntent['record'];
    const intent: DeliveryIntent = { ref: deliveryRef(req.key.mission, req.key.op), commit: w.M0, base: w.M0, token: deliveryIntentToken(req.key), record };
    assert.deepEqual(await authority.authorize(req.key, intent), { ok: true });
    const first = authority.intent;
    await authority.finish(req.key, 'failed');
    assert.deepEqual(await authority.authorize(req.key, intent), { ok: true });
    const second = authority.intent;
    assert.notEqual(first, second);
    await authority.finish(req.key, 'failed');
    await w.h.client.call('stop', { stop: id<StopId>('s-two'), scope: { kind: 'mission', mission: MISSION }, words: '停', at: 3 });
    const third = await authority.authorize(req.key, intent);
    assert.equal(third.ok, false, 'the same candidate after a stop: refused, not replayed');
    assert.equal(events(w).filter((e) => e.kind === 'intent.authorized').length, 2);
  } finally {
    await w.h.close();
  }
});

test('review r1 #9: while a writer of the ref still runs, its intent stays pending verification and the domain busy; it ends only once the writer is gone', async () => {
  const w = await world();
  const req = request(w, 'op-writer-alive');
  const lock = plantStaleLock(w, req);
  const token = deliveryIntentToken(req.key);
  const child = spawn('/bin/sh', ['-c', 'sleep 30', 'sh', `mission-pipeline.intent=${token}`], { stdio: 'ignore' });
  await new Promise((res) => child.once('spawn', res));
  try {
    const authority = authorityFor(w, req, 'lineage-w');
    const r = await deliver(req, { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET, writerWaitMs: 100 });
    assert.equal(r.kind, 'ref-writer-running', JSON.stringify(r));
    const intent = authority.intent as string;
    assert.equal(await w.h.client.call('intentState', { intent }), 'pending_verify', 'not released: its writer may still write the ref');
    const alerts = events(w).filter((e) => e.kind === 'alert' && e.wi === 'WI-14');
    assert.equal(alerts.length, 1, 'the PM is told (WI-14)');
    // The conflict domain is held: another delivery of the same ref is refused (DOMAIN_BUSY).
    const other = await deliver(req, { git: fx.git, view: w.view, authority: authorityFor(w, req, 'lineage-w2'), checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
    assert.equal(other.kind, 'authorization-refused');
    assert.match(other.kind === 'authorization-refused' ? other.reason : '', /DOMAIN_BUSY/);
    if (r.kind !== 'ref-writer-running') return;
    // Ended and confirmed gone; the lock it held is not provably the program's (review r2 #3): kept, still pending.
    const resumed = await resumeDeliveryRef(fx.git, req.key, r.pending, authority, { kill: true });
    assert.equal(resumed.kind, 'ref-lock-held');
    assert.equal(await w.h.client.call('intentState', { intent }), 'pending_verify');
    assert.equal(existsSync(lock), true);
    // Its owner removes it; the ref read back (absent): only now is the intent finished.
    rmSync(lock);
    assert.equal((await resumeDeliveryRef(fx.git, req.key, r.pending, authority)).kind, 'ref-not-created');
    assert.equal(await w.h.client.call('intentState', { intent }), 'failed');
  } finally {
    child.kill('SIGKILL');
    await w.h.close();
  }
});

test('ledger follow-up: the ledger refusing a rebuild record on an exhausted loop (LOOP_EXHAUSTED, WI-08) reads as exhausted', async () => {
  const calls: string[] = [];
  const client = {
    async call(method: string, args: Record<string, unknown>): Promise<unknown> {
      calls.push(method);
      if (method === 'appendRecords') throw new RemoteLedgerError('LOOP_EXHAUSTED', `delivery-rebuild on ${String((args.records as { lineage: string }[])[0]?.lineage)} is exhausted`);
      if (method === 'loopState') return { attempts: 3, extra: 0 };
      throw new Error(method);
    },
  };
  const authority = new LedgerDeliveryAuthority({ client: client as never, content: null as never, gen: null, tag: { mission: MISSION, capabilities: [] }, lineage: 'lineage-z', domain: 'd' });
  const r = await authority.recordRebuild({ mission: MISSION, op: id<OpId>('op') }, 'base-moved:x');
  assert.equal(r.kind, 'exhausted');
  assert.match(r.kind === 'exhausted' ? r.detail : '', /exhausted/);
  assert.deepEqual(calls, ['appendRecords']);
});

// ---------------------------------------------------------------- the ledger's delivery identity (6.6 授权, git review r1 #11)

test('the delivery-ref authorization names its delivery: the record content stored first, the target branch, kept on the intent', async () => {
  const w = await world();
  try {
    const req = request(w, 'op-identity');
    const authority = authorityFor(w, req, 'lineage-id');
    const r = await deliver(req, { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
    assert.equal(r.kind, 'delivered', JSON.stringify(r));
    if (r.kind !== 'delivered') return;
    const intent = String(events(w).find((e) => e.kind === 'intent.authorized')?.intent);
    const info = (await w.h.client.call('intentInfo', { intent })) as { delivery: { mission: string; op: string; commit: string; base: string; ref: string; targetBranch: string; manifest: string } };
    assert.deepEqual(
      { ...info.delivery, manifest: undefined },
      { mission: MISSION, op: 'op-identity', commit: r.record.commit, base: r.record.base, ref: r.record.ref, targetBranch: 'main', manifest: undefined, description: null },
    );
    assert.equal(info.delivery.manifest, w.h.content.put(canonicalJson(deliveryRecordJson(r.record))), 'the record step 8 writes');
    const recorded = events(w).find((e) => e.kind === 'delivery.recorded');
    assert.equal(recorded?.target, 'main');
    assert.equal(recorded?.manifest, info.delivery.manifest);
  } finally {
    await w.h.close();
  }
});

test('a crash after the ref, before the step-8 record: recovery records the delivery from the intent and finishes it (no false WI-20)', async () => {
  const w = await world();
  try {
    const req = request(w, 'op-crash-record');
    class CrashBeforeRecord extends LedgerDeliveryAuthority {
      override async complete(): Promise<void> {
        throw new Error('simulated crash before the step-8 record');
      }
    }
    const authority = new CrashBeforeRecord({
      client: w.h.client,
      content: w.h.content,
      gen: w.h.gen,
      tag: { mission: MISSION, capabilities: [] },
      lineage: 'lineage-crash',
      domain: deliveryRefDomain(w.layout, deliveryRef(req.key.mission, req.key.op)),
    });
    await assert.rejects(
      deliver(req, { git: fx.git, view: w.view, authority, checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET }),
      /simulated crash/,
    );
    const ref = deliveryRef(req.key.mission, req.key.op);
    const commit = fx.raw(['rev-parse', ref], w.repo);
    const intent = String(events(w).find((e) => e.kind === 'intent.authorized')?.intent);
    assert.equal(await w.h.client.call('intentState', { intent }), 'pending_verify');
    assert.equal(events(w).filter((e) => e.kind === 'delivery.recorded').length, 0);
    // Recovery from the ledger alone.
    const settled = await settleDeliveryIntent(fx.git, w.layout, w.h.client, intent, { recordDir: join(fx.root, 'ref-writes') });
    assert.deepEqual(settled, { action: { kind: 'done' }, recorded: true });
    assert.equal(await w.h.client.call('intentState', { intent }), 'done');
    const recorded = events(w).filter((e) => e.kind === 'delivery.recorded');
    assert.equal(recorded.length, 1);
    assert.deepEqual([recorded[0]?.delivery, recorded[0]?.commit, recorded[0]?.ref, recorded[0]?.target], ['op-crash-record', commit, ref, 'main']);
    const info = (await w.h.client.call('currentDelivery', { mission: MISSION })) as { delivery: string; state: string };
    assert.deepEqual([info.delivery, info.state], ['op-crash-record', 'recorded']);
  } finally {
    await w.h.close();
  }
});

test('a withdrawn delivery is refused at authorization (DELIVERY_NOT_CURRENT, WI-06 class A): no ref, no write', async () => {
  const w = await world();
  try {
    const req = request(w, 'op-withdrawn');
    const first = await deliver(req, { git: fx.git, view: w.view, authority: authorityFor(w, req, 'lineage-wd'), checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
    assert.equal(first.kind, 'delivered');
    await w.h.client.call('withdrawDelivery', { op: 'withdraw-1', mission: MISSION, delivery: 'op-withdrawn', reason: 'the user took it back' });
    // The same delivery again (its ref is gone, as after a re-try): refused in the authorization's transaction.
    fx.raw(['update-ref', '-d', deliveryRef(req.key.mission, req.key.op)], w.repo);
    const again = await deliver(req, { git: fx.git, view: w.view, authority: authorityFor(w, req, 'lineage-wd'), checks: new StubChecks(), scratchDir: fx.root, disk: TEST_DISK, quiet: NO_QUIET });
    assert.equal(again.kind, 'authorization-refused', JSON.stringify(again));
    assert.match(again.kind === 'authorization-refused' ? again.reason : '', /DELIVERY_NOT_CURRENT|withdrawn/);
    assert.equal(fx.rawStatus(['show-ref', '--verify', '--quiet', deliveryRef(req.key.mission, req.key.op)], w.repo).code, 1, 'no ref');
  } finally {
    await w.h.close();
  }
});
