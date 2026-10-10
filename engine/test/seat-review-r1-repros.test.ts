// The gpt-6.1-sol r1 review's reproduction scripts (scratch/review-repros.ts and
// scratch/review-cleanup-busy.ts), kept as regression tests: the same inputs, the corrected
// outcomes. Offline: no systemd unit, no model; HTTP only on the loopback. The end-to-end and
// real-mount versions live with their areas (exec-cleanup-safety, exec-export-store,
// seat-proxy, seat-tools-gate, seat-host-review).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { id, type LaunchId, type ReservationId } from '../src/common/ids.ts';
import { sha256 } from '../src/common/hash.ts';
import { cleanupPass } from '../src/exec/cleanup.ts';
import { ExportBudget, exportTempPath, exportToStore } from '../src/exec/export.ts';
import { chooseAreaKind, exportPhysicalBound, planUnitArea, unitMemoryReservation, type UnitDemand } from '../src/exec/resources.ts';
import type { ProgramTools } from '../src/exec/tools.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { parseSeatCard } from '../src/seat/card.ts';
import { buildSeatServer, type CallToolResult } from '../src/seat/mcpTools.ts';
import { parseModelConfig, upperBoundMicros, usageMicros, usageProblems } from '../src/seat/modelConfig.ts';
import { MeteringProxy, type MeteredRequest } from '../src/seat/proxy.ts';
import { resultProblems } from '../src/seat/results.ts';

const CLEANUP_TS = fileURLToPath(new URL('../src/exec/cleanup.ts', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'mp-review-r1-'));
after(() => rmSync(root, { recursive: true, force: true }));

const card = (seat: 'constructor' | 'reviewer') =>
  parseSeatCard({
    format: 'mp4.seat-card.v1',
    launch: 'L1',
    mission: 'M1',
    module: null,
    capabilities: [],
    duties: '',
    decisionQuotes: [],
    constraints: [],
    limits: { run: { memoryMax: 1 << 28 }, areaBytes: 1 << 24, export: { maxLogicalBytes: 1 << 20, maxFiles: 10 }, recoveryStateBytes: 1 << 20 },
    ...(seat === 'constructor'
      ? { seat, workspace: { snapshot: '/tmp/snap', writablePaths: ['src'] }, goal: 'g', standards: [{ id: 'S1', text: 's' }], requirementItems: [], readableFiles: [], interpreter: '', verificationCommands: [], interfaces: { implements: [], calls: [] } }
      : {
          seat,
          workspace: { snapshot: '/tmp/snap', writablePaths: [] },
          target: 'obj',
          review: 'rev',
          standards: [{ id: 'S1', text: 's' }],
          interfaces: [],
          candidate: { changedPaths: [] },
          verificationRuns: [],
          declaredCommands: [],
          selfReportedGaps: [],
          openIssues: [],
          binding: {
            judgment: 'J1',
            bases: { hash: 'a'.repeat(64), count: 0 },
            constraints: { hash: 'b'.repeat(64), count: 0 },
            reliesOn: { hash: 'c'.repeat(64), count: 0 },
            revokes: null,
            extends: null,
            evidenceUse: { fields: [], statisticalOrExternal: false },
            superseded: [],
          },
        }),
  });

const result = (done: string) => ({ done, unmet_standards: [], unfixed_problems: [], decisions_needed: [] });

describe('review-repros.ts, corrected', () => {
  test('concurrentSubmit: a slow persistence; only the first entered, the second refused', async () => {
    const submissions: string[] = [];
    const release: (() => void)[] = [];
    const s = buildSeatServer(card('constructor'), {} as ProgramTools, {
      log() {},
      context: { snapshot: { lines: () => null } },
      async onSubmit(r) {
        submissions.push((r.result as { done: string }).done);
        await new Promise<void>((resolve) => release.push(resolve));
        return 'ack';
      },
    });
    const handler = s.handlers.get('submit_result') as (a: unknown) => Promise<CallToolResult>;
    const first = handler(result('first'));
    const second = handler(result('second'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(submissions.length, 1, 'was 2');
    release.forEach((r) => r());
    const acks = await Promise.all([first, second]);
    assert.deepEqual(acks.map((a) => a.isError === true), [false, true]);
  });

  test('concurrentImmediateSubmit: the final result is the first, not the second', async () => {
    let finalSubmitted = '';
    const s = buildSeatServer(card('constructor'), {} as ProgramTools, {
      log() {},
      context: { snapshot: { lines: () => null } },
      async onSubmit(r) {
        finalSubmitted = (r.result as { done: string }).done;
        return 'ack';
      },
    });
    const handler = s.handlers.get('submit_result') as (a: unknown) => Promise<CallToolResult>;
    const acks = await Promise.all([handler(result('first')), handler(result('second'))]);
    assert.equal(acks.filter((a) => a.isError !== true).length, 1, 'was 2');
    assert.equal(finalSubmitted, 'first', 'was "second"');
  });

  const cfg = parseModelConfig({
    format: 'mp4.model-config.v1',
    seats: { constructor: { provider: 'anthropic', model: 'test' } },
    metering: { toolOverheadTokens: 0, prices: { test: { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 100, cacheWrite5mMultiplier: 1.25, cacheWrite1hMultiplier: 2 } } },
  });

  test('cachePriceBound: bound >= actual (was bound 2001 < actual 10000)', () => {
    const bound = upperBoundMicros(cfg, 'test', 1000, 1);
    const actual = usageMicros(cfg, 'test', { cache_read_input_tokens: 100 });
    assert.equal(actual, 10_000);
    assert.ok(bound >= actual, `${bound} >= ${actual}`);
  });

  test('partialCacheUsage: a TTL breakdown that does not add up is not a final usage (was settled at 2 instead of 2000)', () => {
    assert.deepEqual(usageProblems({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 }), []);
    assert.match(usageProblems({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 1 } }).join(), /add up to 1, not to cache_creation_input_tokens 1000/);
    assert.ok(usageProblems({ cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 1 } }).length > 0);
  });

  async function simulatedRequest(path: string, response: { status: number; json: unknown }) {
    const events: unknown[] = [];
    const records: MeteredRequest[] = [];
    const up = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        events.push(['forward', path]);
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response.json));
      });
    });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
    const proxy = await MeteringProxy.start({
      launch: id<LaunchId>('L1'),
      config: cfg,
      upstream: `http://127.0.0.1:${(up.address() as AddressInfo).port}`,
      ledger: {
        async reserve(_id: ReservationId, n: number) {
          events.push(['reserve', n]);
        },
        async settle(_id: ReservationId, n: number) {
          events.push(['settle', n]);
        },
      },
      onRequest: (r) => records.push(r),
    });
    try {
      const body = path.endsWith('/batches') ? { requests: [{ custom_id: 'one', params: { model: 'test', max_tokens: 1, messages: [] } }] } : { model: 'test', max_tokens: 1, messages: [] };
      await (await fetch(`${proxy.url}${path}`, { method: 'POST', body: JSON.stringify(body) })).text();
      await proxy.drain();
      return { events, settlement: records[0]?.settlement, settledMicros: records[0]?.settledMicros, reserved: records[0]?.reservedMicros };
    } finally {
      await proxy.close(1_000);
      up.closeAllConnections();
      await new Promise<void>((r) => up.close(() => r()));
    }
  }

  test('batchBypass: refused, never forwarded (was forwarded unreserved, "unmetered")', async () => {
    const r = await simulatedRequest('/v1/messages/batches', { status: 200, json: {} });
    assert.equal(r.settlement, 'refused');
    assert.deepEqual(r.events, []);
  });

  test('gatewayError: a 502 settles at the reservation (was zero)', async () => {
    const r = await simulatedRequest('/v1/messages', { status: 502, json: { type: 'error' } });
    assert.equal(r.settlement, 'reservation');
    assert.ok((r.settledMicros ?? 0) > 0 && r.settledMicros === r.reserved);
  });

  test('emptyUsage: usage {} settles at the reservation (was "usage" at 0)', async () => {
    const r = await simulatedRequest('/v1/messages', { status: 200, json: { usage: {} } });
    assert.equal(r.settlement, 'reservation');
    assert.ok((r.settledMicros ?? 0) > 0);
  });

  test('cleanupSymlink: allowed/link -> protected; protected/valuable survives (was deleted, nothing left)', async () => {
    const allowed = join(root, 'allowed');
    const other = join(root, 'protected');
    mkdirSync(allowed);
    mkdirSync(other);
    writeFileSync(join(other, 'valuable'), 'protected');
    symlinkSync(other, join(allowed, 'link'));
    const left = await cleanupPass([`path:${join(allowed, 'link', 'valuable')}`], { roots: [allowed] });
    assert.equal(existsSync(join(other, 'valuable')), true);
    assert.deepEqual(left.left, [`path:${join(allowed, 'link', 'valuable')}`]);
  });

  test('exportDiskPeak: one copy, within the bound (was 2 copies, 2,097,152 > bound 1,052,736)', async () => {
    const payload = Buffer.alloc(1 << 20, 0x5a);
    const content = new ContentStore(join(root, 'content'));
    mkdirSync(content.root);
    const caps = { maxLogicalBytes: payload.length, maxFiles: 1 };
    const fakeHost = {
      async callAgent() {
        return { ok: true as const, result: { logicalBytes: payload.length, entries: 1, files: 1, dirs: 0, symlinks: 0, excluded: 0, indexBytes: 200, skipped: [], flagged: [] } };
      },
      async exportStream(_req: unknown, sink: { frame(f: unknown): void; data(b: Buffer): void; fileEnd(): void }) {
        sink.frame({ k: 'file', p: 'payload', mode: 0o600, size: payload.length });
        sink.data(payload);
        sink.fileEnd();
        sink.frame({ k: 'end', bytes: payload.length, entries: 1 });
      },
    };
    const out = await exportToStore(fakeHost as never, content, new ExportBudget(caps), { mode: 'whole', tempPath: exportTempPath(content.root, 'L1') });
    assert.ok(out.ok);
    const stored = (await import('node:fs')).statSync(content.path(sha256(payload))).blocks * 512;
    const bound = exportPhysicalBound(caps, { blockBytes: statfsSync(content.root).bsize });
    assert.ok(stored <= bound, `${stored} <= ${bound}`);
    assert.ok(stored < 2 * payload.length, 'a single copy: no host directory copy beside the stored object');
  });

  test('largeDiskAdmission: an image need is an image the host runs on, or a resource block; its memory excludes the area', () => {
    const demand: UnitDemand = { hostBytes: 64 << 20, runPeakBytes: 64 << 20, runParallelism: 1, areaBytes: 128 << 20, enclosureBytes: 32 << 20, exportCaps: { maxLogicalBytes: 1 << 20, maxFiles: 1 }, recoveryState: null };
    assert.equal(chooseAreaKind(demand), 'image');
    assert.equal(unitMemoryReservation(demand), 167772160);
    const noFuse = planUnitArea(demand, { fuse2fs: null, mkfsExt4: '/sbin/mkfs.ext4', fallocate: '/usr/bin/fallocate', fusermount: '/usr/bin/fusermount3', fuseDevice: true });
    assert.equal(noFuse.kind, 'resource-blocked', 'never a silent tmpfs');
  });

  test('reviewWithoutEvidence: refused (was accepted with [])', () => {
    const reviewResult = { judgments: [{ standard: 'S1', met: 'yes', reason: '', evidence: [] }], gap_responses: [], issue_responses: [], findings: [], verdict: 'pass' };
    const problems = resultProblems(card('reviewer'), reviewResult, { snapshot: { lines: () => null } });
    assert.ok(problems.some((p) => /cite at least one evidence pointer/.test(p)));
    assert.ok(problems.some((p) => /give the reason/.test(p)));
  });
});

describe('review-cleanup-busy.ts, corrected (simulated busy mount, as the reviewer ran it)', () => {
  test('two failed unmounts: the image is kept and listed with the mount (was deleted and dropped while still allocated)', () => {
    const dir = join(root, 'busy');
    mkdirSync(join(dir, 'mount'), { recursive: true });
    writeFileSync(join(dir, 'image'), Buffer.alloc(1 << 20, 0x7b));
    // in a child process: /proc/self/mountinfo reports the mount, every unmount fails (busy)
    const script = `
      import fs from 'node:fs';
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const [dir] = JSON.parse(process.argv[1]);
      const mount = dir + '/mount', image = dir + '/image';
      const held = fs.openSync(image, 'r');
      const realRead = fs.readFileSync;
      fs.readFileSync = (p, ...a) => p === '/proc/self/mountinfo' ? realRead(p, ...a) + '100 1 0:50 / ' + mount + ' rw - fuse.ext4 ' + image + ' rw\\n' : realRead(p, ...a);
      let attempts = 0;
      cp.spawn = (...args) => { attempts++; return cp.spawnSync('false') && { once: (ev, f) => ev === 'exit' ? setTimeout(() => f(1), 1) : undefined, kill() {} }; };
      syncBuiltinESMExports();
      const { cleanupPass } = await import(${JSON.stringify(`file://${CLEANUP_TS}`)} + '?busy');
      const pass = await cleanupPass(['mount:' + mount, 'image:' + image], { roots: [dir] });
      console.log(JSON.stringify({ attempts, left: pass.left, reasons: pass.refusals.map((r) => r.reason), imageExists: fs.existsSync(image), allocated: fs.fstatSync(held).blocks * 512 }));`;
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script, JSON.stringify([dir])], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1) as string) as { attempts: number; left: string[]; reasons: string[]; imageExists: boolean; allocated: number };
    assert.ok(out.attempts >= 1, 'the unmount was tried');
    assert.deepEqual(out.left, [`mount:${join(dir, 'mount')}`, `image:${join(dir, 'image')}`], 'both stay pending');
    assert.deepEqual(out.reasons, ['busy', 'busy']);
    assert.equal(out.imageExists, true, 'the image was not deleted');
    assert.ok(out.allocated >= 1 << 20, 'and its space stays counted');
    assert.equal(readFileSync(join(dir, 'image')).length, 1 << 20);
  });
});
