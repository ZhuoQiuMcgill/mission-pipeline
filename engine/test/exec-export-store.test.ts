// Code review r1 findings 3 and 4 (design 6.5 "峰值预留按完整生命周期算", 7.1 导出规则 and "结束时"):
// exports stream straight into the content store (no host copy), within one budget per launch
// that products, transcripts, logs and documents share; the reservation formula is a true upper
// bound of what a budget can put on disk; a product is stored whole or refused; a transcript is
// cut at what is left and says so.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, statfsSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { sha256 } from '../src/common/hash.ts';
import type { AgentHost, AgentReply, AgentRequest, ExportFrame, ExportRequest, ExportSink } from '../src/exec/agent.ts';
import { ExportBudget, EXPORT_DOC_OBJECTS, EXPORT_INDEX_RECORD_BYTES, exportTempDir, exportTempPath, exportToStore, putWithin, treeEntryIndexBytes, type TreeDocument } from '../src/exec/export.ts';
import { detectExecCapabilities } from '../src/exec/platform.ts';
import { exportPhysicalBound } from '../src/exec/resources.ts';
import { ToolSandbox, hostSystemEnvironment } from '../src/exec/sandbox.ts';
import { meterWritable, storeWritable } from '../src/exec/tools.ts';
import { ContentStore } from '../src/ledger/content.ts';

const dirs: string[] = [];
const open: ToolSandbox[] = [];
function tmp(prefix = 'mp-export-store-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
after(async () => {
  for (const s of open) await s.close().catch(() => undefined);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * A content store whose fan-out directories are created on demand by put() (a laid-out store
 * has 65,536 of them from install, which a shared /tmp cannot spare per test). Footprints below
 * count files only, so they measure what the bound covers in a laid-out store: the objects.
 */
function store(_layout = false): ContentStore {
  const c = new ContentStore(join(tmp(), 'content'));
  mkdirSync(c.root);
  return c;
}

/** Physical bytes of everything under a directory (allocated blocks), and its file count. */
function footprint(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    bytes += statSync(join(e.parentPath, e.name)).blocks * 512;
    files++;
  }
  return { bytes, files };
}

interface FakeFile {
  readonly p: string;
  readonly data: Buffer;
}

/** An agent host serving files from memory, with the file agent's meter (tree-entry bytes included). */
function fakeHost(files: readonly FakeFile[], onData?: () => void): AgentHost {
  const entry = (f: FakeFile) => treeEntryIndexBytes({ path: f.p, kind: 'file', mode: 0o600, size: f.data.length, hash: '0'.repeat(64) as never, target: null });
  return {
    async callAgent(req: AgentRequest): Promise<AgentReply> {
      if (req.op !== 'meter') throw new Error(`unexpected ${req.op}`);
      const flagged = files.filter((f) => (req.flag ?? []).some((n) => f.p.split('/').includes(n))).map((f) => f.p);
      return {
        ok: true,
        result: {
          logicalBytes: files.reduce((n, f) => n + f.data.length, 0),
          entries: files.length,
          files: files.length,
          dirs: 0,
          symlinks: 0,
          excluded: 0,
          indexBytes: files.reduce((n, f) => n + entry(f), 0),
          skipped: [],
          flagged,
        },
      };
    },
    async exportStream(req: ExportRequest, sink: ExportSink): Promise<void> {
      let bytes = 0;
      let entries = 0;
      for (const f of files) {
        entries++;
        bytes += f.data.length;
        if (bytes > req.maxBytes || entries > req.maxEntries) {
          sink.frame({ k: 'abort', reason: 'over-cap', bytes, entries } as ExportFrame);
          return;
        }
        sink.frame({ k: 'file', p: f.p, mode: 0o600, size: f.data.length });
        for (let off = 0; off < f.data.length; off += 64 * 1024) {
          sink.data(f.data.subarray(off, off + 64 * 1024));
          onData?.();
        }
        if (f.data.length === 0) sink.fileEnd();
        else sink.fileEnd();
      }
      sink.frame({ k: 'end', bytes, entries });
    },
  };
}

const MiB = 1 << 20;

describe('finding 3: the export streams into the content store; the bound holds the whole peak', () => {
  test("the reviewer's repro: 1 MiB exported, at most one copy on disk at any time, within exportPhysicalBound", async () => {
    const content = store(true);
    const before = footprint(content.root);
    const payload = Buffer.alloc(MiB, 0x5a);
    const caps = { maxLogicalBytes: payload.length, maxFiles: 2 };
    let peak = 0;
    const host = fakeHost([{ p: 'payload', data: payload }], () => {
      peak = Math.max(peak, footprint(content.root).bytes - before.bytes);
    });
    const out = await exportToStore(host, content, new ExportBudget(caps), { mode: 'whole', tempPath: exportTempPath(content.root, 'L1') });
    assert.ok(out.ok);
    const after = footprint(content.root);
    const used = after.bytes - before.bytes;
    const bound = exportPhysicalBound(caps, { blockBytes: statfsSync(content.root).bsize });
    assert.ok(peak <= bound && used <= bound, `peak ${peak}, used ${used}, bound ${bound}`);
    assert.ok(used < 2 * payload.length, `no second copy (${used} bytes for a ${payload.length}-byte payload)`);
    assert.equal(after.files - before.files, 2, 'the object and the tree document, nothing else');
    assert.equal(content.get(sha256(payload)).length, payload.length);
    assert.deepEqual(readdirSync(exportTempDir(content.root, 'L1')), [], 'no temporary file left (the export directory itself is the unit\'s scratch, removed by its cleanup)');
    const doc = JSON.parse(content.get(out.tree).toString('utf8')) as TreeDocument;
    assert.deepEqual(doc.entries.map((e) => [e.path, e.size, e.hash]), [['payload', payload.length, sha256(payload)]]);
  });

  test('many small files: the physical footprint stays within the bound (blocks, inodes and the tree document)', async () => {
    const content = store(true);
    const before = footprint(content.root);
    const files = Array.from({ length: 300 }, (_, i) => ({ p: `dir/f${i}-${'x'.repeat(40)}`, data: Buffer.from(`content ${i}`) }));
    const caps = { maxLogicalBytes: 64 * 1024, maxFiles: 301 };
    const out = await exportToStore(fakeHost(files), content, new ExportBudget(caps), { mode: 'whole', tempPath: exportTempPath(content.root, 'L2') });
    assert.ok(out.ok);
    const after = footprint(content.root);
    const bound = exportPhysicalBound(caps, { blockBytes: statfsSync(content.root).bsize });
    assert.ok(after.bytes - before.bytes <= bound, `${after.bytes - before.bytes} <= ${bound}`);
    assert.ok(after.files - before.files <= caps.maxFiles, 'inodes within the file cap');
  });

  test('whole mode: over the budget (bytes, entries or index), refused before anything is stored', async () => {
    const files = [
      { p: 'a', data: Buffer.alloc(600) },
      { p: 'b', data: Buffer.alloc(600) },
    ];
    for (const [what, caps, budgetIndex] of [
      ['bytes', { maxLogicalBytes: 1000, maxFiles: 10 }, undefined],
      ['entries', { maxLogicalBytes: 10_000, maxFiles: 1 }, undefined],
      ['index', { maxLogicalBytes: 10_000, maxFiles: 3 }, 2],
    ] as const) {
      const content = store();
      const before = footprint(content.root);
      const budget = new ExportBudget(caps, budgetIndex);
      const out = await exportToStore(fakeHost(files), content, budget, { mode: 'whole', tempPath: exportTempPath(content.root, 'L3') });
      assert.equal(out.ok, false, what);
      assert.ok(!out.ok && out.status === 'resource-exceeded' && /over the export allowance/.test(out.reason), what);
      assert.deepEqual(footprint(content.root), before, `${what}: nothing stored`);
      assert.deepEqual(budget.used, { bytes: 0, entries: 0, objects: 0, index: 0 }, `${what}: nothing charged`);
    }
    const exact = await exportToStore(fakeHost(files), store(), new ExportBudget({ maxLogicalBytes: 1200, maxFiles: 2 }), { mode: 'whole', tempPath: exportTempPath(tmp(), 'L3') });
    assert.ok(exact.ok, 'exactly at the caps: the tree document does not take from the card file cap');
    const flagged = await exportToStore(fakeHost([{ p: 'x/.git', data: Buffer.from('ref') }]), store(), new ExportBudget({ maxLogicalBytes: 100, maxFiles: 10 }), {
      mode: 'whole',
      tempPath: exportTempPath(tmp(), 'L4'),
      refuseNames: ['.git'],
    });
    assert.ok(!flagged.ok && flagged.status === 'seat-failure');
  });
});

describe('finding 4: one budget for everything a launch stores; a transcript is cut and says so', () => {
  test('after the product and the result, the transcript gets only what is left: whole files, then a cut one, then nothing', async () => {
    const content = store();
    const caps = { maxLogicalBytes: 10_000, maxFiles: 20 };
    const budget = new ExportBudget(caps);
    const product = await exportToStore(fakeHost([{ p: 'src/out.txt', data: Buffer.alloc(3_000, 0x61) }]), content, budget, { mode: 'whole', tempPath: exportTempPath(content.root, 'L5') });
    assert.ok(product.ok);
    assert.ok(putWithin(content, budget, 'r'.repeat(1_000)) !== null, 'a result document');
    const transcript = [
      { p: 'projects/-/s.jsonl', data: Buffer.alloc(4_000, 0x62) },
      { p: 'projects/-/t.jsonl', data: Buffer.alloc(4_000, 0x63) },
      { p: 'statsig/x', data: Buffer.alloc(100, 0x64) },
    ];
    const out = await exportToStore(fakeHost(transcript), content, budget, { mode: 'truncate', tempPath: exportTempPath(content.root, 'L5') });
    assert.ok(out.ok);
    const doc = JSON.parse(content.get(out.tree).toString('utf8')) as TreeDocument;
    assert.deepEqual(
      doc.entries.map((e) => [e.path, e.size, e.truncatedFrom ?? null]),
      [
        ['projects/-/s.jsonl', 4_000, null],
        ['projects/-/t.jsonl', 2_000, 4_000],
      ],
    );
    assert.ok(doc.incomplete !== undefined && /export allowance is used up/.test(doc.incomplete.reason));
    assert.deepEqual([doc.incomplete?.omittedEntries, doc.incomplete?.omittedBytes], [1, 2_100]);
    assert.equal(content.get(doc.entries[1]!.hash as never).toString(), 'c'.repeat(2_000), 'the cut file keeps its head');
    assert.ok(budget.used.bytes <= caps.maxLogicalBytes && budget.used.entries <= caps.maxFiles);
    assert.equal(budget.bytes, 0);
    assert.equal(putWithin(content, budget, 'log'), null, 'nothing more fits (the caller records why)');
  });

  test('the budget charges all or nothing and refunds; documents never take from the card file cap', () => {
    const b = new ExportBudget({ maxLogicalBytes: 100, maxFiles: 2 });
    assert.equal(b.index, (2 + EXPORT_DOC_OBJECTS) * EXPORT_INDEX_RECORD_BYTES);
    assert.equal(b.charge({ bytes: 60, entries: 1, index: 10 }), true);
    assert.equal(b.charge({ bytes: 60, entries: 1, index: 10 }), false, 'bytes would overflow: nothing charged');
    assert.deepEqual(b.used, { bytes: 60, entries: 1, objects: 1, index: 10 });
    assert.equal(b.charge({ entries: 2 }), false, 'the card file cap holds');
    assert.equal(b.charge({ docs: 5 }), true, 'documents use their own allowance');
    assert.equal(b.files, 1);
    b.refund({ bytes: 60, entries: 1, index: 10 });
    b.refund({ docs: 5 });
    assert.deepEqual(b.used, { bytes: 0, entries: 0, objects: 0, index: 0 });
    assert.equal(b.charge({ docs: 2 + EXPORT_DOC_OBJECTS + 1 }), false, 'objects never exceed entries + documents');
    assert.throws(() => new ExportBudget({ maxLogicalBytes: -1, maxFiles: 1 }));
  });
});

const caps = detectExecCapabilities();
const sandboxSkip = caps.bwrapUsable && caps.nsenter !== null ? false : 'needs a usable bubblewrap and nsenter';

describe('the real file agent and the store agree', { skip: sandboxSkip }, () => {
  test('the meter counts exactly the tree-entry bytes the store writes; a sparse file is refused by logical length', async () => {
    const root = tmp();
    const snap = join(root, 'snap');
    mkdirSync(join(snap, 'src', 'deep'), { recursive: true });
    writeFileSync(join(snap, 'src', 'a.txt'), 'alpha\n');
    writeFileSync(join(snap, 'src', 'deep', `b ${'ü'.repeat(20)}.txt`), 'beta\n');
    mkdirSync(join(root, 'session'));
    const sandbox = await ToolSandbox.create(
      { snapshotDir: snap, writablePaths: ['src'], area: { kind: 'tmpfs', bytes: 64 * MiB }, environment: hostSystemEnvironment(), sessionDir: join(root, 'session') },
      { runLayers: null },
    );
    open.push(sandbox);
    const content = store();
    const meter = await meterWritable(sandbox);
    const budget = new ExportBudget({ maxLogicalBytes: MiB, maxFiles: 100 });
    const out = await storeWritable(sandbox, content, budget, exportTempPath(content.root, 'L6'));
    assert.ok(out.ok);
    const doc = JSON.parse(content.get(out.tree).toString('utf8')) as TreeDocument;
    assert.equal(doc.entries.reduce((n, e) => n + treeEntryIndexBytes(e), 0), meter.indexBytes, 'the agent meters the very entries the store writes');
    assert.deepEqual(doc.entries.map((e) => e.path).sort(), ['src/a.txt', 'src/deep', `src/deep/b ${'ü'.repeat(20)}.txt`].sort());
    // a sparse file: 1 GiB logical in a tmpfs area, refused as a whole
    const big = join(root, 'sparse-host');
    writeFileSync(big, '');
    truncateSync(big, 0);
    const r = await sandbox.runCommand({ run: 'run-1' as never, command: 'truncate -s 1G src/sparse.bin', cwd: '/work', timeoutMs: 30_000, outputCapBytes: 4096 });
    assert.equal(r.status, 'completed');
    const before = footprint(content.root);
    const refused = await storeWritable(sandbox, content, new ExportBudget({ maxLogicalBytes: 16 * MiB, maxFiles: 100 }), exportTempPath(content.root, 'L6'));
    assert.ok(!refused.ok && refused.status === 'resource-exceeded');
    assert.deepEqual(footprint(content.root), before);
  });
});
