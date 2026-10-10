// Design 6.5 machine resources and admission (execution side), 6.2 reservations, 7.1 choice
// between a tmpfs area and a disk image; platform detection (9.6).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { defaultLimits } from '../src/flow/context.ts';
import { seatDemand } from '../src/flow/adapters.ts';
import { detectExecCapabilities, parseBwrapVersion, versionAtLeast } from '../src/exec/platform.ts';
import { checkAgentRuntime, parseExecInstallConfig } from '../src/exec/selfcheck.ts';
import { EXPORT_DOC_OBJECTS, EXPORT_INDEX_RECORD_BYTES } from '../src/exec/export.ts';
import {
  admit,
  afterRefusal,
  chooseAreaKind,
  exportPhysicalBound,
  parseMeminfo,
  planUnitArea,
  readMachine,
  RUN_AREA_FLOOR_BYTES,
  runAreaBytesFor,
  treeAreaBytes,
  unitDiskReservation,
  unitInodeReservation,
  unitMemoryReservation,
  type AreaTools,
  type UnitDemand,
} from '../src/exec/resources.ts';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const seat: UnitDemand = {
  hostBytes: 600 * MiB,
  runPeakBytes: 512 * MiB,
  runParallelism: 1,
  areaBytes: 64 * MiB,
  enclosureBytes: 96 * MiB,
  exportCaps: { maxLogicalBytes: 64 * MiB, maxFiles: 10_000 },
  recoveryState: null,
};
const geometry = { blockBytes: 4096 };
const bound = (caps: { maxLogicalBytes: number; maxFiles: number }): number =>
  caps.maxLogicalBytes + (caps.maxFiles + EXPORT_DOC_OBJECTS) * (EXPORT_INDEX_RECORD_BYTES + 3 * 4096) + Math.ceil(caps.maxLogicalBytes / 256);
const allTools: AreaTools = { fuse2fs: '/usr/bin/fuse2fs', mkfsExt4: '/sbin/mkfs.ext4', fallocate: '/usr/bin/fallocate', fusermount: '/usr/bin/fusermount3', fuseDevice: true };

describe('what a unit reserves (6.2, 6.5, 7.1)', () => {
  test('sync runs are reserved at dispatch: host + run peak (x parallelism) + every capped tmpfs it is charged for', () => {
    assert.equal(chooseAreaKind(seat), 'tmpfs');
    assert.equal(unitMemoryReservation(seat), 600 * MiB + 512 * MiB + 64 * MiB + 96 * MiB);
    assert.equal(unitMemoryReservation({ ...seat, runParallelism: 3 }), 600 * MiB + 3 * 512 * MiB + 64 * MiB + 96 * MiB);
  });

  test('a disk need above a quarter of the memory reservation gets a fixed-size image, which then costs disk, not memory', () => {
    const big = { ...seat, areaBytes: 2 * GiB };
    assert.equal(chooseAreaKind(big), 'image');
    assert.equal(unitMemoryReservation(big), 600 * MiB + 512 * MiB + 96 * MiB);
    assert.equal(unitDiskReservation(big, geometry), 2 * GiB + exportPhysicalBound(big.exportCaps, geometry));
    assert.equal(unitInodeReservation(big), big.exportCaps.maxFiles + EXPORT_DOC_OBJECTS + 1 + 1, 'the export directory and the image file');
    assert.equal(unitDiskReservation(seat, geometry), exportPhysicalBound(seat.exportCaps, geometry));
  });

  test('export footprint (finding 3): logical cap + file cap x (index allowance + 3 blocks) + extent leaves', () => {
    assert.equal(exportPhysicalBound({ maxLogicalBytes: 1000, maxFiles: 10 }, geometry), bound({ maxLogicalBytes: 1000, maxFiles: 10 }));
    assert.equal(
      exportPhysicalBound({ maxLogicalBytes: 1000, maxFiles: 10 }, { blockBytes: 4096, indexRecordBytes: 64 }),
      bound({ maxLogicalBytes: 1000, maxFiles: 10 }),
      'a geometry below the enforced index allowance does not lower the bound',
    );
  });

  test('6.2: the recovery state is its own reserved demand: two copies (saved at acceptance, final), a third when resuming', () => {
    const rs = { maxLogicalBytes: 8 * MiB, maxFiles: 1_000 };
    const withState = { ...seat, recoveryState: rs };
    assert.equal(unitDiskReservation(withState, geometry), exportPhysicalBound(seat.exportCaps, geometry) + 2 * exportPhysicalBound(rs, geometry));
    assert.equal(unitDiskReservation({ ...withState, resumesFromState: true }, geometry), exportPhysicalBound(seat.exportCaps, geometry) + 3 * exportPhysicalBound(rs, geometry));
    // + 1: the launch's export directory in the content store's file system
    assert.equal(unitInodeReservation(withState), 10_000 + EXPORT_DOC_OBJECTS + 2 * (1_000 + EXPORT_DOC_OBJECTS) + 1);
    assert.equal(unitInodeReservation(seat), 10_000 + EXPORT_DOC_OBJECTS + 1);
  });

  test('7.1 (finding 5): admission decides the area; a large-disk unit without fuse2fs is a resource block (WI-10), never tmpfs', () => {
    assert.deepEqual(planUnitArea(seat, allTools), { kind: 'tmpfs', bytes: 64 * MiB });
    const big = { ...seat, areaBytes: 2 * GiB };
    assert.deepEqual(planUnitArea(big, allTools), { kind: 'image', bytes: 2 * GiB, inodes: 10_000 + 64 });
    const blocked = planUnitArea(big, { ...allTools, fuse2fs: null });
    assert.equal(blocked.kind, 'resource-blocked');
    assert.ok(blocked.kind === 'resource-blocked' && blocked.wi === 'WI-10' && blocked.missing.includes('fuse2fs'));
    const noFuse = planUnitArea(big, { ...allTools, fuseDevice: false });
    assert.ok(noFuse.kind === 'resource-blocked' && noFuse.missing.includes('/dev/fuse'));
    // the reviewer's case: 128 MiB of area on a 64 + 32 MiB host is an image, and its memory leaves the area out
    const review: UnitDemand = { hostBytes: 64 << 20, runPeakBytes: 64 << 20, runParallelism: 1, areaBytes: 128 << 20, enclosureBytes: 32 << 20, exportCaps: { maxLogicalBytes: 1 << 20, maxFiles: 1 }, recoveryState: null };
    assert.equal(planUnitArea(review, allTools).kind, 'image');
    assert.equal(unitMemoryReservation(review), (64 + 64 + 32) << 20);
  });
});

describe('admission (6.5)', () => {
  const ledger = { persistent: 10 * GiB, inFlight: 4 * GiB, reserve: 2 * GiB };

  test('persistent + in flight + this peak + reserve <= capacity, per resource', () => {
    assert.deepEqual(admit([{ resource: 'disk', capacity: 20 * GiB, need: 4 * GiB, ledger }]), { admitted: true });
    const r = admit([
      { resource: 'disk', capacity: 20 * GiB, need: 5 * GiB, ledger },
      { resource: 'inodes', capacity: 1000, need: 10, ledger: { persistent: 900, inFlight: 50, reserve: 0 } },
    ]);
    assert.deepEqual(r, { admitted: false, shortfalls: [{ resource: 'disk', missing: 1 * GiB }] });
  });

  test('after a refusal: reclaim if that makes room now, wait if in-flight units will, else resource-blocked', () => {
    const c = { resource: 'disk' as const, capacity: 20 * GiB, need: 5 * GiB, ledger };
    assert.equal(afterRefusal(c, 2 * GiB), 'reclaim');
    assert.equal(afterRefusal(c, 0), 'wait');
    assert.equal(afterRefusal({ ...c, need: 9 * GiB }, 0), 'resource-blocked');
    assert.equal(afterRefusal({ ...c, need: 9 * GiB }, 2 * GiB), 'wait');
  });
});

describe('live readings and platform detection', () => {
  test('meminfo parsing', () => {
    assert.deepEqual(parseMeminfo('MemTotal:       32418044 kB\nMemFree: 1 kB\nMemAvailable:   26318888 kB\n'), {
      total: 32418044 * 1024,
      available: 26318888 * 1024,
    });
    assert.throws(() => parseMeminfo('MemTotal: 1 kB\n'));
  });

  test('a live reading of this machine', () => {
    const m = readMachine([tmpdir()]);
    assert.ok(m.memTotalBytes > 0 && m.memAvailableBytes > 0 && m.memAvailableBytes <= m.memTotalBytes);
    assert.ok(m.cpus >= 1);
    const d = m.disks[0];
    assert.ok(d && d.totalBytes > 0 && d.freeInodes > 0 && d.blockBytes > 0);
  });

  test('bubblewrap version parsing and comparison', () => {
    assert.deepEqual(parseBwrapVersion('bubblewrap 0.11.1\n'), [0, 11, 1]);
    assert.deepEqual(parseBwrapVersion('bubblewrap 0.8'), [0, 8, 0]);
    assert.equal(parseBwrapVersion('nope'), null);
    assert.equal(versionAtLeast([0, 11, 1], [0, 8, 0]), true);
    assert.equal(versionAtLeast([0, 7, 9], [0, 8, 0]), false);
    assert.equal(versionAtLeast([0, 8, 0], [0, 8, 0]), true);
  });

  test('detection reports what this machine offers', () => {
    const caps = detectExecCapabilities();
    if (caps.bwrap !== null) {
      assert.ok(caps.bwrapVersion !== null);
      assert.equal(typeof caps.bwrapUsable, 'boolean');
    } else {
      assert.equal(caps.bwrapUsable, false);
    }
    assert.ok(Array.isArray(caps.delegatedControllers));
  });
});

describe('startup self-check item 10 (v34): the file-tool runtime loads inside the tool sandbox', () => {
  // (the full gate and the other offline items: test/exec-selfcheck.test.ts)
  test('the default runtime passes; a runtime missing its libraries fails deterministically', async () => {
    const caps2 = detectExecCapabilities();
    if (!caps2.bwrapUsable || caps2.nsenter === null) return;
    const ok = await checkAgentRuntime();
    assert.equal(ok.ok, true, ok.detail);
    assert.equal(ok.item, 10);
    const bad = await checkAgentRuntime({ agentRuntime: { node: process.execPath, libraryPaths: [] } });
    assert.equal(bad.ok, false);
  });

  test('the installation config names the runtime', () => {
    const c = parseExecInstallConfig({ format: 'mp4.exec-install.v1', agentRuntime: { node: '/opt/node/bin/node', libraryPaths: ['/opt/node/lib', '/usr'] } });
    assert.deepEqual(c.agentRuntime, { node: '/opt/node/bin/node', libraryPaths: ['/opt/node/lib', '/usr'] });
    assert.throws(() => parseExecInstallConfig({ format: 'mp4.exec-install.v1', agentRuntime: { node: 'node' } }));
    assert.throws(() => parseExecInstallConfig({ format: 'v0' }));
  });
});

// ---------------------------------------------------------------- B2: the area of an ordinary run seat

describe('the writable area of a run seat is sized from its tree (B2: no fuse2fs needed for ordinary tasks)', () => {
  const made: string[] = [];
  after(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const NO_FUSE: AreaTools = { fuse2fs: null, mkfsExt4: null, fallocate: null, fusermount: null, fuseDevice: false };
  const snapshotWith = (files: Readonly<Record<string, string | number>>): string => {
    const d = mkdtempSync(join(tmpdir(), 'mp-exec-area-'));
    made.push(d);
    for (const [p, v] of Object.entries(files)) {
      mkdirSync(join(d, p, '..'), { recursive: true });
      if (typeof v === 'string') writeFileSync(join(d, p), v);
      else {
        writeFileSync(join(d, p), '');
        truncateSync(join(d, p), v); // sparse: its size counts, as a tmpfs copy would take it
      }
    }
    return d;
  };
  const constructorCard = (limits: ReturnType<typeof defaultLimits>) => ({ seat: 'constructor', limits }) as never;

  test('the tree footprint: pages per file, a page per directory; nothing followed; missing paths count nothing', () => {
    const d = snapshotWith({ 'src/a.txt': 'x', 'src/b.txt': 'y'.repeat(5000), 'docs/c.md': 'z' });
    assert.deepEqual(treeAreaBytes(d, ['src']), { bytes: 4096 + 4096 + 8192, entries: 3, complete: true });
    assert.equal(treeAreaBytes(d, ['.']).entries, 6);
    assert.equal(treeAreaBytes(d, ['nope', '../etc']).bytes, 0);
    assert.equal(treeAreaBytes(d, ['src'], 5000).complete, false, 'the walk stops past the cap');
    assert.equal(runAreaBytesFor(0), RUN_AREA_FLOOR_BYTES);
    assert.equal(runAreaBytesFor(1024 * MiB), 1792 * MiB);
  });

  test("a small repo's Constructor card is admitted on tmpfs on a machine without fuse2fs", () => {
    const d = snapshotWith({ 'src/index.ts': 'export const a = 1;\n', 'src/lib/util.ts': 'export {};\n', 'package.json': '{}' });
    for (const limits of [defaultLimits('run', { snapshot: d, writablePaths: ['src'] }), defaultLimits('run'), defaultLimits('run', { snapshot: d, writablePaths: [] })]) {
      assert.equal(limits.areaBytes, RUN_AREA_FLOOR_BYTES);
      const demand = seatDemand(constructorCard(limits));
      const plan = planUnitArea(demand, NO_FUSE);
      assert.deepEqual(plan, { kind: 'tmpfs', bytes: RUN_AREA_FLOOR_BYTES }, 'the ordinary task needs no image');
      assert.ok(unitMemoryReservation(demand) >= demand.hostBytes + demand.runPeakBytes + demand.enclosureBytes + RUN_AREA_FLOOR_BYTES, 'the tmpfs area stays counted in memory');
    }
  });

  test('a large writable tree still gets an image, and without fuse2fs a WI-10 block that names the cause', () => {
    const d = snapshotWith({ 'data/big.bin': 900 * MiB, 'data/small.txt': 'x' });
    const limits = defaultLimits('run', { snapshot: d, writablePaths: ['data'] });
    assert.ok(limits.areaBytes >= 900 * MiB + 900 * MiB / 2 + 256 * MiB, `${limits.areaBytes}`);
    const plan = planUnitArea(seatDemand(constructorCard(limits)), NO_FUSE);
    assert.equal(plan.kind, 'resource-blocked');
    assert.ok(plan.kind === 'resource-blocked' && plan.wi === 'WI-10');
    assert.match(plan.kind === 'resource-blocked' ? plan.reason : '', /writable area is \d+ MiB, over a quarter of its other memory reservation \(772 MiB\), so it needs a disk image, and this machine lacks fuse2fs/);
    const withFuse = planUnitArea(seatDemand(constructorCard(limits)), { fuse2fs: '/usr/sbin/fuse2fs', mkfsExt4: '/sbin/mkfs.ext4', fallocate: '/usr/bin/fallocate', fusermount: '/bin/fusermount3', fuseDevice: true });
    assert.equal(withFuse.kind, 'image');
  });
});
