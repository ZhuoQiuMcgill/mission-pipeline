// Design 5.5 / 6.1 gates through the real ledger service: commit-to-publish
// latency on a ledger of 100,000 records, updates that always end while commits
// keep arriving, and a rebuild after a crash in the middle of an update.
//
// Core review r2 F18, r3 F21: every wait is bounded and fails with a reason;
// every from-scratch build is held to the 30 s gate (5.5); every publication is
// compared with the full recomputation over all derived maps (the process
// scenario compares digests of every map, and fails if the process published a
// revision that was not compared); the evaluator process's peak resident set
// (VmHWM) after the 100,000-record build is measured and must fit its memory
// pool; layer-0 queries are timed through the real socket; and the ledger
// service never takes more than 500 ms for one action (`slowActions` stays
// empty) in any scenario.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { LedgerService, ledgerPaths } from '../../src/ledger/service.ts';
import { readRecords } from '../../src/ledger/store.ts';
import { Evaluator, resolveRecord, type EvaluatorLedgerPort } from '../../src/evaluator/evaluator.ts';
import { memoryStatus, selfIdentity } from '../../src/evaluator/process-info.ts';
import { stateDigest } from '../../src/evaluator/queries.ts';
import { fullCompute, type DerivedState, type ResolvedCommitted } from '../../src/evaluator/semantics.ts';
import { id, revision, type OpId, type Revision } from '../../src/common/ids.ts';
import type { BaseRecord } from '../../src/common/records.ts';

function setup(): { svc: LedgerService; port: EvaluatorLedgerPort; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mp-e2e-'));
  const paths = ledgerPaths(join(dir, 'ledger'), join(dir, 'control'));
  const svc = new LedgerService({ paths });
  svc.open();
  const port: EvaluatorLedgerPort = {
    readRecordsAfter: (after: Revision) => readRecords(paths.db, after),
    // The ledger binds the registration to the current scheduler generation and this process (F10).
    beginEvaluator: () => svc.beginEvaluator({ gen: svc.currentGenerationNumber(), identity: selfIdentity() }),
    publish: (r) => svc.publish(r),
    recordEvaluatorFailure: () => svc.recordEvaluatorFailure(),
    recordEvaluatorSuccess: () => svc.recordEvaluatorSuccess(),
    raiseAlert: (r) => svc.raiseAlert(r),
  };
  return { svc, port, cleanup: () => (svc.close(), rmSync(dir, { recursive: true, force: true })) };
}

/** 5.5: a from-scratch build of 100,000 records, and the absolute ceiling of one update. */
const FULL_BUILD_MS = 30_000;

let opSeq = 0;
function put(svc: LedgerService, records: BaseRecord[]): Promise<{ revisions: Revision[] }> {
  return svc.appendRecords({ op: `e2e-${++opSeq}`, gen: null, records }) as Promise<{ revisions: Revision[] }>;
}

/** Wait for `cond`, failing after `ms` with what was awaited, or as soon as `check` throws. */
async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, what: string, check: () => void = () => undefined): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    check();
    if (await cond()) return;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** 5.5: no ledger service action took more than 500 ms. */
function assertLedgerFast(svc: LedgerService, scenario: string): void {
  assert.deepEqual(svc.slowActions, [], `${scenario}: ledger actions over the 500 ms budget`);
}

/** `modules` independent chains of `length` objects, each module on its own environment line. */
async function seedModules(svc: LedgerService, modules: number, length: number): Promise<void> {
  const L = (xs: string[]) => svc.content.putList(xs);
  const empty = L([]);
  for (let m = 0; m < modules; m++) {
    const batch: BaseRecord[] = [
      { kind: 'env.snapshot', line: `env${m}` as never, snapshot: `env${m}@1` as never },
      { kind: 'evidence', evidence: `E${m}` as never, envLine: `env${m}` as never, envSnapshot: `env${m}@1` as never, runClass: 'closed', fields: { exit: '0' } },
    ];
    const ev = L([`E${m}`]);
    for (let i = 0; i < length; i++) {
      batch.push({
        kind: 'object.version', object: `M${m}_${i}` as never, objectKind: 'product', mission: 'm1' as never, module: null,
        content: svc.content.put('object content') as never, prerequisites: i ? L([`M${m}_${i - 1}`]) : empty,
        scope: { paths: [`src/m${m}.ts`], taskType: 'construct' }, reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }],
      });
      batch.push({
        kind: 'judgment', judgment: `J${m}_${i}` as never, review: 'reviewer', executor: 'reviewer', target: `M${m}_${i}` as never,
        verdict: 'pass', evidence: ev, bases: empty, constraints: empty, reliesOn: empty, issues: [], revokes: null, extends: null, evidenceUse: { fields: ['exit'], statisticalOrExternal: false }, superseded: [],
      });
    }
    await put(svc, batch);
  }
}

/** Every derived map equals the full recomputation (5.5: "全部派生值"). */
function assertAllEqual(got: DerivedState, want: DerivedState, msg = ''): void {
  for (const k of ['basis', 'evidenceApplicable', 'judgmentCurrent', 'positionInEffect', 'targets', 'fixes', 'ops'] as const) {
    assert.deepEqual(new Map(got[k] as ReadonlyMap<unknown, unknown>), new Map(want[k] as ReadonlyMap<unknown, unknown>), `${msg} ${k}`);
  }
}

/** The full recomputation over the ledger's records; the records are read and resolved once, then extended. */
class Oracle {
  private readonly svc: LedgerService;
  private readonly resolved: ResolvedCommitted[] = [];
  private last: Revision = revision(0);
  constructor(svc: LedgerService) {
    this.svc = svc;
  }
  at(rev: Revision): DerivedState {
    for (const c of readRecords(this.svc.paths.db, this.last)) {
      this.resolved.push({ revision: c.revision, record: resolveRecord(c.record, this.svc.content) });
      this.last = c.revision;
    }
    return fullCompute(this.resolved, rev);
  }
}

test('commit-to-publish latency for a small update on a ledger of 100,000 records; every publication equals the full recomputation (5.5: 200 ms)', async () => {
  const { svc, port, cleanup } = setup();
  try {
    const t0 = performance.now();
    await seedModules(svc, 1000, 50);
    console.log(`  seeded ${svc.head()} records in ${(performance.now() - t0).toFixed(0)} ms`);
    const ev = new Evaluator(port, svc.content);
    const oracle = new Oracle(svc);
    const t1 = performance.now();
    await ev.update();
    const buildMs = performance.now() - t1;
    console.log(`  first update (from scratch): ${buildMs.toFixed(0)} ms`);
    assert.ok(buildMs < FULL_BUILD_MS, `from-scratch build ${buildMs} ms`);
    assertAllEqual(ev.state()!, oracle.at(ev.state()!.revision), 'from scratch');
    const samples: number[] = [];
    for (let k = 0; k < 20; k++) {
      await put(svc, [{ kind: 'env.snapshot', line: `env${k}` as never, snapshot: `env${k}@2` as never }]);
      const t = performance.now();
      const r = await ev.update();
      samples.push(performance.now() - t);
      assert.equal(r.published, svc.head());
      assertAllEqual(ev.state()!, oracle.at(r.published), `revision ${r.published}`);
    }
    samples.sort((a, b) => a - b);
    console.log(`  small updates: median ${samples[10]!.toFixed(1)} ms, max ${samples[19]!.toFixed(1)} ms`);
    assert.ok(samples[19]! < 200, `max ${samples[19]} ms`);
    assert.equal(ev.state()?.targets.get('M5_49')?.label, 'not-fully-proven');
    assert.equal(ev.state()?.targets.get('M50_49')?.label, 'proven');
    assertLedgerFast(svc, '100,000 records in process');
  } finally {
    cleanup();
  }
});

test('commits keep arriving during updates: every update ends and publishes a complete revision (5.5)', async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seedModules(svc, 50, 20);
    const ev = new Evaluator(port, svc.content);
    const oracle = new Oracle(svc);
    let writing = true;
    let written = 0;
    const writer = (async () => {
      while (writing) {
        const m = written % 50;
        await put(svc, [{ kind: 'env.snapshot', line: `env${m}` as never, snapshot: `env${m}@${2 + written}` as never }]);
        written++;
      }
    })();
    const published: Revision[] = [];
    try {
      for (let k = 0; k < 30; k++) {
        const r = await ev.update();
        published.push(r.published);
        assertAllEqual(ev.state()!, oracle.at(r.published), `revision ${r.published}`);
      }
    } finally {
      writing = false;
      await writer;
    }
    assert.ok(written > 0);
    for (let i = 1; i < published.length; i++) assert.ok(published[i]! >= published[i - 1]!);
    assertLedgerFast(svc, 'concurrent commits');
  } finally {
    cleanup();
  }
});

test('a crash in the middle of an update: the next update rebuilds; a restarted evaluator neither loses nor repeats episode changes (6.1)', async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seedModules(svc, 20, 10);
    const gen = await svc.beginGeneration();
    const L = (xs: string[]) => svc.content.putList(xs);
    await put(svc, [{ kind: 'op.pending', op: 'D1' as never, opKind: 'delivery', objects: L(['M3_9']), scope: { mission: 'm1' as never, capabilities: [] } }]);
    const ev = new Evaluator(port, svc.content);
    const oracle = new Oracle(svc);
    const r0 = await ev.update();
    assertAllEqual(ev.state()!, oracle.at(r0.published));
    await svc.commitProofOp({ op: 'exec-d1', gen, opId: id<OpId>('D1'), asOf: r0.published, tag: { mission: 'm1' as never, capabilities: [] } });
    const rx = await ev.update();
    assertAllEqual(ev.state()!, oracle.at(rx.published));
    // The delivered object loses proof; the update crashes after reading the change.
    await put(svc, [{ kind: 'env.snapshot', line: 'env3' as never, snapshot: 'env3@2' as never }]);
    ev.injectComputeFault = () => true;
    await assert.rejects(ev.update());
    ev.injectComputeFault = null;
    const r1 = await ev.update();
    assert.deepEqual(r1.changes, [{ op: 'D1', change: 'start' }], 'the rebuild reconciles the operation once');
    assertAllEqual(ev.state()!, oracle.at(r1.published));
    // A brand-new evaluator (process restart) reads the committed batch and does not repeat it.
    const fresh = new Evaluator(port, svc.content);
    const r2 = await fresh.update();
    assert.deepEqual(r2.changes, []);
    assert.equal(r2.batch, null);
    assertAllEqual(fresh.state()!, oracle.at(r2.published));
    assertLedgerFast(svc, 'crash and rebuild');
  } finally {
    cleanup();
  }
});

test('a pending operation over 100,000 objects commits before the next publication while unrelated missions keep publishing (6.1, 14.4)', async () => {
  const { svc, port, cleanup } = setup();
  try {
    await seedModules(svc, 2000, 50); // 100,000 objects
    const gen = await svc.beginGeneration();
    const all: string[] = [];
    for (let m = 0; m < 2000; m++) for (let i = 0; i < 50; i++) all.push(`M${m}_${i}`);
    await put(svc, [{ kind: 'op.pending', op: 'BIG' as never, opKind: 'delivery', objects: svc.content.putList(all), scope: { mission: 'm1' as never, capabilities: [] } }]);
    const ev = new Evaluator(port, svc.content);
    const t0 = performance.now();
    await ev.update();
    const buildMs = performance.now() - t0;
    console.log(`  from scratch with the 100,000-object operation: ${buildMs.toFixed(0)} ms`);
    assert.ok(buildMs < FULL_BUILD_MS, `from-scratch build ${buildMs} ms`);
    assert.equal(ev.state()?.ops.get('BIG' as never)?.allProven, true);
    // Unrelated writes and publications keep happening while the scheduler commits.
    let busy = true;
    let noiseError: unknown = null;
    const noise = (async () => {
      try {
        for (let k = 0; busy; k++) {
          await put(svc, [{ kind: 'basis.version', basisKind: 'requirement', line: `other${k}` as never, version: `other${k}.v1` as never, mission: 'm2' as never, scope: null }]);
          await ev.update();
        }
      } catch (e) {
        noiseError = e;
      }
    })();
    let attempts = 0;
    try {
      for (;;) {
        attempts++;
        if (noiseError) throw noiseError;
        if (attempts > 10) throw new Error(`the operation could not commit in ${attempts - 1} attempts`);
        const s = ev.state()!; // read one value from the latest published revision
        assert.equal(s.ops.get('BIG' as never)?.allProven, true);
        try {
          await svc.commitProofOp({ op: `exec-big-${attempts}`, gen, opId: id<OpId>('BIG'), asOf: s.revision, tag: { mission: 'm1' as never, capabilities: [] } });
          break;
        } catch (e) {
          if ((e as { code?: string }).code !== 'BELOW_FLOOR') throw e;
        }
      }
    } finally {
      busy = false;
      await noise;
    }
    if (noiseError) throw noiseError;
    console.log(`  committed after ${attempts} attempt(s)`);
    assert.ok(attempts <= 3, `attempts ${attempts}`);
    assertLedgerFast(svc, '100,000-object operation');
  } finally {
    cleanup();
  }
});

/**
 * The pool for the 100,000-record process scenario (6.1: "内存峰值实测后定为求值器资源池的大小").
 * Measured on the maintainer's WSL machine (2026-10-09): VmHWM 390 MiB after the
 * from-scratch build, 532 MiB after 20 updates and 21 full digests.
 */
const PROCESS_HEAP_MB = 1024;
const PROCESS_POOL_MB = 1536;

test('commit to publication through the real evaluator process on a ledger of 100,000 records: latency, every publication equal to the full recomputation, peak memory within the pool, layer-0 reads (5.5, 6.1)', async () => {
  const { serveLedger } = await import('../../src/ledger/ipc.ts');
  const { EvaluatorSupervisor } = await import('../../src/evaluator/supervisor.ts');
  const { RpcClient } = await import('../../src/common/rpc.ts');
  const { svc, cleanup } = setup();
  const sockDir = mkdtempSync(join(tmpdir(), 'mp-e2e-sock-'));
  const ledgerSock = join(sockDir, 'ledger.sock');
  const server = serveLedger(svc, ledgerSock);
  const gen = Number(await svc.beginGeneration());
  const sup = new EvaluatorSupervisor({
    worker: {
      dbPath: svc.paths.db, contentRoot: svc.paths.content, ledgerSocket: ledgerSock, querySocket: join(sockDir, 'evaluator.sock'),
      checkpointPath: join(sockDir, 'evaluator.checkpoint'), gen, pollMs: 1, checkpointEvery: 1_000_000, faultInjection: false,
    },
    ledger: {
      recordEvaluatorFailure: (r) => svc.recordEvaluatorFailure({ op: r.op, gen: r.gen as never }),
      evaluatorHealth: async () => svc.evaluatorHealth(),
      setEvaluatorFault: (r, o) => svc.setEvaluatorFault(r, { gen: o.gen as never }),
      raiseAlert: (r) => svc.raiseAlert(r),
      putContent: (t) => svc.content.put(t),
    },
    deadlineMs: 30_000,
    heapMb: PROCESS_HEAP_MB,
    memoryMb: PROCESS_POOL_MB,
  });
  const problems: string[] = [];
  sup.on('failure', (f: { cause: string; stderr: string }) => problems.push(`failure: ${f.cause} ${f.stderr.slice(-500)}`));
  sup.on('fault', (reason: string) => problems.push(`fault: ${reason}`));
  sup.on('blocked', (pool: { reason: string }) => problems.push(`blocked (no hard memory pool here, WI-18): ${pool.reason}`));
  /** Every revision the process published (5.5: every one must equal the full recomputation). */
  const publishedRevs: number[] = [];
  sup.on('published', (rev: number) => publishedRevs.push(rev));
  const compared = new Set<number>();
  const alive = (): void => {
    if (problems.length > 0) throw new Error(`the evaluator process failed: ${problems.join('; ')}`);
  };
  const query = new RpcClient(join(sockDir, 'evaluator.sock'), 5000);
  const oracle = new Oracle(svc);
  type Digest = { revision: number; maps: Record<string, string> };
  const assertDigest = async (what: string): Promise<number> => {
    const got = (await query.call('digest')) as Digest;
    assert.deepEqual(got, stateDigest(oracle.at(revision(got.revision))), `${what}: every derived map at revision ${got.revision}`);
    compared.add(got.revision);
    return got.revision;
  };
  try {
    await seedModules(svc, 1000, 50);
    const t0 = performance.now();
    await sup.start();
    console.log(`  evaluator memory pool: ${sup.memoryPool?.mode} (heap ${PROCESS_HEAP_MB} MiB, process ${PROCESS_POOL_MB} MiB)${sup.degraded ? `, degraded: ${sup.memoryPool?.reason}` : ''}`);
    await waitFor(() => svc.publicationFloor() === svc.head(), 60_000, 'the from-scratch publication', alive);
    const buildMs = performance.now() - t0;
    console.log(`  evaluator process from scratch: ${buildMs.toFixed(0)} ms`);
    assert.ok(buildMs < FULL_BUILD_MS, `the evaluator process took ${buildMs} ms to publish from scratch`);
    const pid = sup.workerPid;
    assert.ok(pid !== null);
    const built = memoryStatus(pid);
    assert.ok(built.vmHwmKb !== null, 'VmHWM is readable');
    console.log(`  worker peak RSS (VmHWM) after the 100,000-record build: ${(built.vmHwmKb! / 1024).toFixed(0)} MiB of a ${PROCESS_POOL_MB} MiB pool`);
    assert.ok(built.vmHwmKb! <= PROCESS_POOL_MB * 1024, `VmHWM ${built.vmHwmKb} KiB exceeds the pool`);
    await waitFor(async () => ((await query.call('summary')) as { revision: number | null }).revision === svc.head(), 10_000, 'the published revision on the query socket', alive);
    assert.equal(await assertDigest('from scratch'), svc.head());

    // Layer-0 reads from the evaluator's memory through the socket (5.5: 50 ms at 100,000 records).
    // This process just ran a 100,000-record full recomputation: collect its garbage
    // first, so its own GC pause is not measured as the evaluator's read time.
    const ids = Array.from({ length: 1000 }, (_, m) => `M${m}_49`);
    globalThis.gc?.();
    await query.call('targets', { ids });
    const reads: number[] = [];
    for (let k = 0; k < 10; k++) {
      const t = performance.now();
      await query.call('summary');
      await query.call('targets', { ids });
      reads.push(performance.now() - t);
    }
    reads.sort((a, b) => a - b);
    console.log(`  layer-0 reads (summary + 1,000 targets): median ${reads[5]!.toFixed(1)} ms, max ${reads[9]!.toFixed(1)} ms`);
    assert.ok(reads[9]! < 50, `layer-0 read ${reads[9]} ms`);

    const samples: number[] = [];
    for (let k = 0; k < 20; k++) {
      const t = performance.now();
      const rev = (await put(svc, [{ kind: 'env.snapshot', line: `env${k}` as never, snapshot: `env${k}@2` as never }])).revisions[0]!;
      await waitFor(async () => {
        const sum = (await query.call('summary')) as { revision: number | null };
        return sum.revision !== null && sum.revision >= rev;
      }, 10_000, `publication of revision ${rev}`, alive);
      samples.push(performance.now() - t);
      // Outside the timed part: the published maps equal the full recomputation at that revision.
      assert.ok((await assertDigest(`sample ${k}`)) >= rev);
    }
    samples.sort((a, b) => a - b);
    console.log(`  commit to publication (process): median ${samples[10]!.toFixed(1)} ms, max ${samples[19]!.toFixed(1)} ms`);
    assert.ok(samples[19]! < 200, `max ${samples[19]} ms`);
    const after = memoryStatus(pid);
    console.log(`  worker peak RSS (VmHWM) at the end: ${((after.vmHwmKb ?? 0) / 1024).toFixed(0)} MiB`);
    assert.ok((after.vmHwmKb ?? 0) <= PROCESS_POOL_MB * 1024);
    alive();
    // Not one publication went unchecked: each published revision's maps were compared.
    await waitFor(() => publishedRevs.length > 0 && publishedRevs[publishedRevs.length - 1]! >= svc.head(), 5000, 'the last publication event', alive);
    const unchecked = publishedRevs.filter((r) => !compared.has(r));
    assert.deepEqual(unchecked, [], `published revisions never compared with the full recomputation: ${unchecked.join(', ')}`);
    console.log(`  publications compared with the full recomputation: ${compared.size} of ${new Set(publishedRevs).size}`);
    assertLedgerFast(svc, 'evaluator process');
  } finally {
    query.close();
    await sup.stop();
    await new Promise<void>((r) => server.close(() => r()));
    cleanup();
    rmSync(sockDir, { recursive: true, force: true });
  }
});
