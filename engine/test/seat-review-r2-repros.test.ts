// The gpt-6.1-sol r2 review's reproductions (scratch/review-r2-repros.ts, review-r2-unkillable.ts,
// review-r2-proxy-paths.ts), kept as regression tests: the same inputs, the corrected outcomes.
// Offline and in-process; the end-to-end versions of findings 3 and 6 are in seat-host.test.ts.
//   1 cleanup: an entry replaced after the last identity check is not deleted; an existing
//     entry never registered with its identity is not deleted (WI-20);
//   2 an image whose name is gone counts as released only when no process holds its inode;
//   3 every save of the session state for evidence requests of one round shares one reserved copy;
//   4 a stream whose final delta has no output count settles at the reservation;
//   5 after a run layer cannot be emptied, nothing more runs and nothing can be handed back;
//   6 a recovery state is checked against the NEW card's caps before anything is restored.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanupPass, recordIdentities } from '../src/exec/cleanup.ts';
import { RunLayer } from '../src/exec/cgroup.ts';
import { ClaudeCodeEnclosure } from '../src/exec/enclosure.ts';
import { ExportBudget, exportTempPath, treeEntryIndexBytes } from '../src/exec/export.ts';
import type { AgentHost, AgentRequest, ExportRequest, ExportSink } from '../src/exec/agent.ts';
import { SerialQueue } from '../src/exec/holder.ts';
import { exportPhysicalBound } from '../src/exec/resources.ts';
import { ToolSandbox, type WedgedRun } from '../src/exec/sandbox.ts';
import { DEFAULT_TOOL_POLICY, ProgramTools } from '../src/exec/tools.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { parseSeatCard } from '../src/seat/card.ts';
import { buildSeatServer, type CallToolResult } from '../src/seat/mcpTools.ts';
import { DEFAULT_MODEL_CONFIG } from '../src/seat/modelConfig.ts';
import { MeteringProxy, UsageReader } from '../src/seat/proxy.ts';
import { checkTreeWithin, restoreTree } from '../src/seat/tree.ts';

const CLEANUP_TS = fileURLToPath(new URL('../src/exec/cleanup.ts', import.meta.url));
const root = fs.mkdtempSync(join(tmpdir(), 'mp-review-r2-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('finding 1: cleanup never deletes an object that is not the registered one', () => {
  test("the reviewer's race: the name is replaced right after the last check; the replacement survives, nothing counts as released", () => {
    // in a child: patching node:fs exports is process-wide
    const dir = join(root, 'race');
    fs.mkdirSync(dir);
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      const [dir] = JSON.parse(process.argv[1]);
      const { cleanupPass, recordIdentities } = await import(${JSON.stringify(`file://${CLEANUP_TS}`)});
      const victim = join(dir, 'victim');
      fs.writeFileSync(victim, 'unit-owned');
      const policy = { roots: [dir] };
      const [bound] = recordIdentities(['path:' + victim], policy);
      const real = fs.lstatSync;
      let replaced = false;
      fs.lstatSync = (p, ...a) => {
        const st = real(p, ...a);
        if (!replaced && String(p).endsWith('/victim')) {
          replaced = true;
          fs.renameSync(victim, join(dir, 'original-moved'));
          fs.writeFileSync(victim, 'unrelated-protected');
        }
        return st;
      };
      syncBuiltinESMExports();
      const pass = await cleanupPass([bound], policy);
      fs.lstatSync = real;
      syncBuiltinESMExports();
      console.log(JSON.stringify({ replaced, pass, victim: fs.existsSync(victim) ? fs.readFileSync(victim, 'utf8') : null, moved: fs.readFileSync(join(dir, 'original-moved'), 'utf8'), entries: fs.readdirSync(dir).sort() }));`;
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script, JSON.stringify([dir])], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1) as string) as { replaced: boolean; pass: { left: string[]; refusals: { reason: string }[] }; victim: string | null; moved: string; entries: string[] };
    assert.equal(out.replaced, true);
    assert.equal(out.victim, 'unrelated-protected', 'the replacement was not deleted (was: deleted, "all done")');
    assert.equal(out.moved, 'unit-owned');
    assert.equal(out.pass.left.length, 1, 'the resource stays pending');
    assert.equal(out.pass.refusals[0]?.reason, 'identity-mismatch');
    assert.deepEqual(out.entries, ['original-moved', 'victim'], 'no quarantine directory is left behind');
  });

  test('a race at the rename itself: the entry moved into the quarantine is checked there and put back', async () => {
    const dir = join(root, 'race2');
    fs.mkdirSync(dir);
    const victim = join(dir, 'victim');
    fs.writeFileSync(victim, 'unit-owned');
    const [bound] = recordIdentities([`path:${victim}`], { roots: [dir] });
    fs.renameSync(victim, join(dir, 'moved'));
    fs.writeFileSync(victim, 'someone-else');
    const pass = await cleanupPass([bound as string], { roots: [dir] });
    assert.equal(pass.refusals[0]?.reason, 'identity-mismatch');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'someone-else');
  });

  test("the reviewer's late resource: absent when registered, created by someone else later: kept, WI-20 (identity-unknown)", async () => {
    const dir = join(root, 'late');
    fs.mkdirSync(dir);
    const late = join(dir, 'late-temp');
    const resources = recordIdentities([`path:${late}`], { roots: [dir] });
    assert.deepEqual(resources, [`path:${late}`], 'no identity could be bound');
    fs.writeFileSync(late, 'created-by-somebody-else-after-registration');
    const pass = await cleanupPass(resources, { roots: [dir] });
    assert.deepEqual(pass.left, resources);
    assert.equal(pass.refusals[0]?.reason, 'identity-unknown');
    assert.equal(fs.readFileSync(late, 'utf8'), 'created-by-somebody-else-after-registration');
    fs.rmSync(late);
    assert.deepEqual((await cleanupPass(resources, { roots: [dir] })).left, [], 'still absent: nothing to release');
  });
});

describe('finding 2: a vanished image name is not released capacity', () => {
  test("the reviewer's case: unlinked while open: pending until the inode is let go", async () => {
    const dir = join(root, 'unlinked');
    fs.mkdirSync(dir);
    const img = join(dir, 'unlinked-image');
    fs.writeFileSync(img, Buffer.alloc(1 << 20, 0x72));
    const bound = recordIdentities([`image:${img}`], { roots: [dir] });
    const held = fs.openSync(img, 'r');
    fs.unlinkSync(img);
    const pass = await cleanupPass(bound, { roots: [dir], holderWaitMs: 100 });
    assert.ok(fs.fstatSync(held).blocks * 512 >= 1 << 20, 'the space is still allocated');
    assert.deepEqual(pass.left, bound, 'so the image stays pending (was: released)');
    assert.equal(pass.refusals[0]?.reason, 'busy');
    assert.match(pass.refusals[0]?.detail ?? '', /gone, but its inode .* is still held/);
    fs.closeSync(held);
    assert.deepEqual((await cleanupPass(bound, { roots: [dir] })).left, []);
  });

  test('an image with another name: deleting this name would not free its space: pending', async () => {
    const dir = join(root, 'linked');
    fs.mkdirSync(dir);
    const img = join(dir, 'unit.img');
    fs.writeFileSync(img, Buffer.alloc(64 * 1024, 1));
    const bound = recordIdentities([`image:${img}`], { roots: [dir] });
    fs.linkSync(img, join(dir, 'other-name'));
    const pass = await cleanupPass(bound, { roots: [dir], holderWaitMs: 0 });
    assert.equal(pass.refusals[0]?.reason, 'busy');
    assert.equal(fs.existsSync(img), true);
    fs.rmSync(join(dir, 'other-name'));
    assert.deepEqual((await cleanupPass(bound, { roots: [dir], holderWaitMs: 0 })).left, []);
  });
});

/** The reviewer's scripted file agent behind the real ClaudeCodeEnclosure.storeState. */
function fakeEnclosure(payload: () => Buffer, failMidway = false): ClaudeCodeEnclosure {
  const fake: AgentHost = {
    async callAgent(req: AgentRequest) {
      assert.equal(req.op, 'meter');
      const p = payload();
      return { ok: true, result: { logicalBytes: p.length, entries: 1, files: 1, dirs: 0, symlinks: 0, excluded: 0, indexBytes: treeEntryIndexBytes({ path: 'session.jsonl', kind: 'file', mode: 0o600, size: p.length, hash: '0'.repeat(64) as never, target: null }), skipped: [], flagged: [] } };
    },
    async exportStream(_req: ExportRequest, sink: ExportSink) {
      const p = payload();
      sink.frame({ k: 'file', p: 'session.jsonl', mode: 0o600, size: p.length });
      sink.data(p);
      sink.fileEnd();
      if (failMidway) throw new Error('the agent died mid-export');
      sink.frame({ k: 'end', bytes: p.length, entries: 1 });
    },
  };
  const enclosure = Object.create(ClaudeCodeEnclosure.prototype) as ClaudeCodeEnclosure;
  enclosure.callAgent = fake.callAgent.bind(fake);
  enclosure.exportStream = fake.exportStream.bind(fake);
  return enclosure;
}

function allocatedFiles(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) n += fs.statSync(join(e.parentPath, e.name)).blocks * 512;
  return n;
}

describe('finding 3: the saves of one round share one reserved copy', () => {
  test("the reviewer's 8 refused requests: at most one copy is written, within the reservation", async () => {
    const content = new ContentStore(join(root, 'content3'));
    fs.mkdirSync(content.root);
    const caps = { maxLogicalBytes: 2 << 20, maxFiles: 20 };
    let i = 0;
    const enclosure = fakeEnclosure(() => Buffer.alloc((1 << 20) + i, 0x61));
    const shared = new ExportBudget(caps); // what the host now passes for every attempt of a round
    const outcomes: boolean[] = [];
    for (i = 0; i < 8; i++) outcomes.push((await enclosure.storeState(content, shared, exportTempPath(content.root, 'r2-3'))).ok);
    assert.deepEqual(outcomes, [true, false, false, false, false, false, false, false], 'only one copy fits the round\'s reservation');
    assert.ok(allocatedFiles(content.root) <= exportPhysicalBound(caps, { blockBytes: fs.statfsSync(content.root).bsize }), 'was 8,450,048 bytes > the reservation');
  });

  test('a save that fails midway still counts: a retry cannot add another copy past the reservation', async () => {
    const content = new ContentStore(join(root, 'content3b'));
    fs.mkdirSync(content.root);
    const caps = { maxLogicalBytes: 1 << 20, maxFiles: 20 };
    const shared = new ExportBudget(caps);
    await assert.rejects(fakeEnclosure(() => Buffer.alloc(900 * 1024, 1), true).storeState(content, shared, exportTempPath(content.root, 'r2-3b')));
    const retry = await fakeEnclosure(() => Buffer.alloc(900 * 1024, 2)).storeState(content, shared, exportTempPath(content.root, 'r2-3b'));
    assert.equal(retry.ok, false);
    assert.ok(allocatedFiles(content.root) <= exportPhysicalBound(caps, { blockBytes: fs.statfsSync(content.root).bsize }));
  });
});

const sse = (events: unknown[]): Buffer => Buffer.from(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
const START = { type: 'message_start', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 11, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } };

describe('finding 4: no final output count, no settlement below the reservation', () => {
  test("the reviewer's stream: a final delta without output_tokens is not a final usage", () => {
    for (const delta of [{ input_tokens: 11 }, {}]) {
      const r = new UsageReader('text/event-stream');
      r.push(sse([START, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'an answer' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: delta }, { type: 'message_stop' }]));
      r.complete = true;
      r.end();
      const f = r.finalUsage();
      assert.equal(f.usage, null, JSON.stringify(delta));
      assert.match(f.problem ?? '', /final message_delta has no output count/);
    }
  });

  test('events out of order (a delta before the start, a second start, a stop before the delta) are not final either', () => {
    const delta = { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } };
    for (const events of [
      [delta, START, { type: 'message_stop' }],
      [START, START, delta, { type: 'message_stop' }],
      [START, { type: 'message_stop' }, delta],
    ]) {
      const r = new UsageReader('text/event-stream');
      r.push(sse(events));
      r.complete = true;
      r.end();
      assert.equal(r.finalUsage().usage, null, JSON.stringify(events.map((e) => (e as { type: string }).type)));
    }
    const ok = new UsageReader('text/event-stream');
    ok.push(sse([START, delta, { type: 'message_stop' }]));
    ok.complete = true;
    ok.end();
    assert.equal(ok.finalUsage().usage?.output_tokens, 5, 'the output count is the final delta\'s, not the start\'s placeholder');
  });

  test("through the proxy (the reviewer's scripted transport): settled at the reservation, not 110 of 134,980", async () => {
    const reader = new UsageReader('text/event-stream');
    reader.push(sse([START, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'some output' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]));
    reader.complete = true;
    reader.end();
    let reserved = 0;
    const settled: number[] = [];
    const proxy = new (MeteringProxy as unknown as new (o: unknown) => MeteringProxy)({
      launch: 'review-r2',
      config: DEFAULT_MODEL_CONFIG,
      ledger: { reserve: async (_r: string, n: number) => void (reserved = n), settle: async (_r: string, n: number) => void settled.push(n) },
    }) as unknown as { forward: unknown; serve(req: unknown, res: unknown): Promise<void>; log: { settlement: string }[] };
    proxy.forward = async () => ({ status: 200, reader, sent: true, responded: true });
    const req = Readable.from([Buffer.from(JSON.stringify({ model: Object.keys(DEFAULT_MODEL_CONFIG.metering.prices)[0], max_tokens: 1024, messages: [] }))]) as unknown as Record<string, unknown>;
    Object.assign(req, { method: 'POST', url: '/v1/messages', headers: {} });
    const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead() {}, end() {}, destroy() {} });
    await proxy.serve(req, res);
    assert.ok(reserved > 0);
    assert.deepEqual(settled, [reserved]);
    assert.equal(proxy.log[0]?.settlement, 'reservation');
  });
});

describe('finding 5: a run layer that cannot be emptied blocks the unit', () => {
  test("the reviewer's fault: the second call is refused, the hand-back too, and the owner is told once", async () => {
    let created = 0;
    const originalCreate = RunLayer.create;
    RunLayer.create = ((_unit: unknown, _run: string, _limits: unknown) => {
      const n = ++created;
      const layer = Object.create(RunLayer.prototype) as Record<string, unknown>;
      Object.assign(layer, {
        initialOom: 0,
        initialOomKill: 0,
        cgroup: { path: `fault-layer-${n}`, async waitEmpty() { return n > 1; }, kill() {}, allProcs: () => (n === 1 ? [777] : []), memoryEvents: () => ({ oom: 0, oomKill: 0 }), async rmdir() {} },
        spawn: () => {
          const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
          setTimeout(() => child.emit('close'), 5);
          return { child, exited: Promise.resolve({ status: { code: 0, signal: null }, error: null }), joined: Promise.resolve(true) };
        },
      });
      return layer as unknown as RunLayer;
    }) as typeof RunLayer.create;
    const wedged: WedgedRun[] = [];
    let sandbox: ToolSandbox | null = null;
    try {
      sandbox = Object.create(ToolSandbox.prototype) as ToolSandbox;
      Object.assign(sandbox, {
        closed: false,
        wedgedRun: null,
        reaper: null,
        onWedged: (w: WedgedRun) => wedged.push(w),
        holder: { alive: true },
        queue: new SerialQueue(),
        mountPoint: '/work',
        writable: [],
        runLayers: { unit: {}, launch: 'L', record: async () => undefined },
      });
      (sandbox as unknown as { runArgv: () => string[] }).runArgv = () => ['fault-command'];
      const tools = new ProgramTools(sandbox, { ...DEFAULT_TOOL_POLICY, runLimits: { memoryMax: 1 << 20 } });
      const first = await tools.runCommand({ command: 'first command' });
      assert.equal(first.ok, false);
      const second = await tools.runCommand({ command: 'second command' });
      assert.equal(second.ok, false, 'was: the second run started and returned evidence');
      assert.match(second.ok ? '' : second.error.message, /blocked/);
      assert.equal(created, 1, 'no second run layer was started');
      assert.equal(wedged.length, 1);
      assert.deepEqual(wedged[0]?.pids, [777]);
      const read = await tools.readFile({ path: 'x' });
      assert.ok(!read.ok && /blocked/.test(read.error.message), 'file tools are blocked too');
      // the seat's entry: everything, the hand-back included, is refused
      const card = parseSeatCard({
        format: 'mp4.seat-card.v1', launch: 'L', mission: 'M', module: null, capabilities: [], duties: '', decisionQuotes: [], constraints: [],
        workspace: { snapshot: '/tmp/snap', writablePaths: ['src'] },
        limits: { run: { memoryMax: 1 << 28 }, areaBytes: 1 << 24, export: { maxLogicalBytes: 1 << 20, maxFiles: 10 }, recoveryStateBytes: 1 << 20 },
        seat: 'constructor', goal: 'g', standards: [{ id: 'S1', text: 's' }], requirementItems: [], readableFiles: [], interpreter: '', verificationCommands: [], interfaces: { implements: [], calls: [] },
      });
      let persisted = 0;
      const s = buildSeatServer(card, tools, {
        log() {},
        context: { snapshot: { lines: () => null } },
        blocked: () => sandbox?.wedged?.reason ?? null,
        async onSubmit() {
          persisted++;
          return 'ack';
        },
      });
      const submit = await (s.handlers.get('submit_result') as (a: unknown) => Promise<CallToolResult>)({ done: 'd', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
      assert.equal(submit.isError, true);
      assert.match(submit.content[0]?.text ?? '', /The unit is blocked/);
      assert.equal(persisted, 0, 'no hand-back was recorded');
    } finally {
      RunLayer.create = originalCreate;
      await sandbox?.close().catch(() => undefined);
    }
  });
});

describe('finding 6: a recovery state is checked against the new card before it touches the host disk', () => {
  test("the reviewer's 8 MiB state under a 1 KiB cap: refused before anything is written", async () => {
    const content = new ContentStore(join(root, 'content6'));
    fs.mkdirSync(content.root);
    const prior = await fakeEnclosure(() => Buffer.alloc(8 << 20, 0x62)).storeState(content, { maxLogicalBytes: 16 << 20, maxFiles: 20 }, exportTempPath(content.root, 'prior'));
    assert.ok(prior.ok);
    const seed = join(root, 'seed6');
    fs.mkdirSync(seed);
    const small = { maxLogicalBytes: 1024, maxFiles: 1 };
    assert.throws(() => restoreTree(content, prior.tree, seed, small), /cap of 1024 bytes/);
    assert.deepEqual(fs.readdirSync(seed), [], 'nothing reached the seed (was: 8 MiB restored)');
    assert.throws(() => checkTreeWithin(content, prior.tree, { maxLogicalBytes: 16 << 20, maxFiles: 0 }), /entries, over the cap/);
    assert.deepEqual(checkTreeWithin(content, prior.tree, { maxLogicalBytes: 16 << 20, maxFiles: 20 }), { logicalBytes: 8 << 20, entries: 1 });
    assert.equal(restoreTree(content, prior.tree, seed, { maxLogicalBytes: 16 << 20, maxFiles: 20 }), 1, 'within the caps it restores');
  });

  test('a tree whose objects are not what it claims is refused before writing, and a failed restore leaves nothing', async () => {
    const content = new ContentStore(join(root, 'content6b'));
    fs.mkdirSync(content.root);
    const a = content.put('aaaa');
    const lying = content.put(JSON.stringify({ format: 'mp4.tree.v1', entries: [{ path: 'x', kind: 'file', mode: 0o600, size: 1, hash: a, target: null }] }));
    assert.throws(() => checkTreeWithin(content, lying, { maxLogicalBytes: 100, maxFiles: 10 }), /4 bytes in the store, 1 in the tree/);
    const missing = content.put(JSON.stringify({ format: 'mp4.tree.v1', entries: [{ path: 'd', kind: 'dir', mode: 0o700, size: 0, hash: null, target: null }, { path: 'd/ok', kind: 'file', mode: 0o600, size: 4, hash: a, target: null }, { path: 'd/gone', kind: 'file', mode: 0o600, size: 4, hash: 'f'.repeat(64), target: null }] }));
    const seed = join(root, 'seed6b');
    fs.mkdirSync(seed);
    assert.throws(() => restoreTree(content, missing, seed));
    assert.deepEqual(fs.readdirSync(seed), [], 'what was written is removed again');
  });
});
