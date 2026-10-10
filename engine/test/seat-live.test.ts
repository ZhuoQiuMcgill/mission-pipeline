// Design §14 items 1 and 2 against the REAL model service. Opt-in: MP_LIVE_MODEL=1.
// It uses the maintainer's subscription login (~/.claude/.credentials.json: only its
// claudeAiOauth entry, without the refresh token, so the seat can never rotate the login) and
// model claude-haiku-5-5; one small task, a few cents at most.
//
// Item 1: a Constructor with only the program's tools fixes a real bug in a temporary project,
//   inside a full execution unit; the fix passes the project's test on the host; every path
//   the Claude Code process wrote is listed (only its config, tmp and shm areas).
// Item 2: under the subscription login Claude Code calls the model through the metering proxy
//   (ANTHROPIC_BASE_URL); the proxy's token totals equal the usage the SDK itself reports, so
//   no model request bypassed the proxy; every request was reserved before it was forwarded
//   and settled, and the ledger's spend equals the proxy's.
//
// The usage check (decision 2026-10-09): (a) on every run, the proxy's counts must equal the
// usage the SDK reports, as this test asserts; plus (c) occasionally, a quiet-period check of the
// account's own 5-hour usage window (tokenhud `limits`), since tokenhud's per-token `usage` reads
// local transcripts and a seat's transcript never reaches the host disk (it lives in the
// enclosure and, captured, in the content store).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ContentHash, LaunchId, MissionId } from '../src/common/ids.ts';
import type { ClaudeCodeExitRecord, RunLayerRecord, SeatResultRecord } from '../src/common/records.ts';
import { checkTerminationProof } from '../src/exec/acceptance.ts';
import { readTree } from '../src/seat/tree.ts';
import { SeatHarness, UNIT_SKIP, recordsOf } from './seat-harness.ts';

const LIVE = process.env['MP_LIVE_MODEL'] === '1';
const SKIP = !LIVE ? 'set MP_LIVE_MODEL=1 to call the real model service (uses the subscription login)' : UNIT_SKIP;
const MODEL = 'claude-haiku-5-5';
const LOGIN = join(homedir(), '.claude', '.credentials.json');

const h = new SeatHarness();
before(async () => {
  if (SKIP === false) await h.start();
});
after(async () => {
  if (SKIP === false) await h.close();
});

const FILES = {
  'src/calc.py': 'def mean(xs):\n    """Arithmetic mean of a non-empty list of numbers."""\n    return sum(xs) / (len(xs) - 1)\n',
  'tests/test_calc.py': 'from calc import mean\n\nassert mean([2, 4, 6]) == 4, mean([2, 4, 6])\nassert mean([5]) == 5, mean([5])\nassert mean([1.5, 2.5]) == 2, mean([1.5, 2.5])\nprint("OK")\n',
  'README.md': '# calc\n\nA tiny statistics helper. Run the tests with `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 tests/test_calc.py`.\n',
};
const VERIFY = 'PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python3 tests/test_calc.py';

function card(launch: LaunchId, mission: MissionId, snapshot: string): Record<string, unknown> {
  return {
    format: 'mp4.seat-card.v1',
    seat: 'constructor',
    launch,
    mission,
    module: 'calc',
    capabilities: [],
    duties: 'You maintain the calc module of a small Python project.',
    decisionQuotes: [],
    constraints: [{ id: 'K1', text: 'Change only src/calc.py; keep the function signature.', kind: 'object' }],
    workspace: { snapshot, writablePaths: ['src'] },
    limits: {
      run: { memoryMax: 256 << 20, pidsMax: 128, timeoutMs: 60_000 },
      areaBytes: 64 << 20,
      export: { maxLogicalBytes: 1 << 20, maxFiles: 100 },
      recoveryStateBytes: 32 << 20,
      maxTurns: 25,
      wallClockMs: 300_000,
    },
    goal: 'The test in tests/test_calc.py fails because mean() in src/calc.py is wrong. Fix mean() so the test passes.',
    standards: [
      { id: 'S1', text: 'mean() returns the arithmetic mean of a non-empty list' },
      { id: 'S2', text: `the command \`${VERIFY}\` prints OK` },
    ],
    requirementItems: [],
    readableFiles: ['src/calc.py', 'tests/test_calc.py'],
    interpreter: 'python3 (standard library only)',
    verificationCommands: [{ id: 'test', command: VERIFY }],
    interfaces: { implements: [{ name: 'mean', definition: 'mean(xs: list[float]) -> float' }], calls: [] },
  };
}

describe('§14 items 1 and 2 with the real model (claude-haiku-5-5)', { skip: SKIP }, () => {
  test('a Constructor with only program tools fixes a real bug through the metering proxy', async (t) => {
    const r = await h.run({
      files: FILES,
      card,
      credentials: { kind: 'subscription', source: LOGIN, minLifetimeMs: 15 * 60_000 },
      modelConfig: h.modelConfigFile(MODEL, 4000),
      timeoutMs: 360_000,
    });
    const o = r.outcome;
    const report = {
      status: o.status,
      reason: o.reason,
      claudeExit: o.claudeExit,
      sdk: o.sdkResult === null ? null : { subtype: o.sdkResult.subtype, turns: o.sdkResult.numTurns, costUsd: o.sdkResult.totalCostUsd, modelUsage: o.sdkResult.modelUsage },
      proxy: o.metering,
      ledgerSpend: h.svc.spendSummary(r.mission),
      runs: (recordsOf(r, 'run.layer') as RunLayerRecord[]).map((x) => `${x.run}:${x.status}`),
      loginChanged: o.loginChanged,
      claudeWrites: o.claudeWrites,
    };
    t.diagnostic(`live report: ${JSON.stringify(report, null, 1)}`);
    if (o.result !== null) t.diagnostic(`notes: ${h.content.get(o.result as ContentHash).toString('utf8')}`);
    assert.equal(o.status, 'handed-back', `${o.reason}\n${h.diag(r.state, r.launch)}`);

    // item 1: the exported fix passes the project's own test, run on the host
    const tree = readTree(h.content, o.export as ContentHash);
    const calc = tree.entries.find((e) => e.path === 'src/calc.py');
    assert.ok(calc?.hash != null, `export: ${tree.entries.map((e) => e.path).join(', ')}`);
    const check = mkdtempSync(join(tmpdir(), 'mp-seat-live-check-'));
    try {
      cpSync(r.snapshot, check, { recursive: true });
      writeFileSync(join(check, 'src', 'calc.py'), h.content.get(calc.hash));
      const out = execFileSync('python3', ['tests/test_calc.py'], { cwd: check, env: { ...process.env, PYTHONPATH: 'src', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
      assert.equal(out.trim(), 'OK');
    } finally {
      rmSync(check, { recursive: true, force: true });
    }
    assert.equal(readFileSync(join(r.snapshot, 'src', 'calc.py'), 'utf8'), FILES['src/calc.py'], 'the snapshot itself is never written');
    for (const p of o.claudeWrites) assert.match(p, /^(config|tmp|shm)\//);
    assert.ok(o.claudeWritesComplete);

    // item 2: every model request went through the proxy, reserved first, then settled
    const usage = Object.values((o.sdkResult?.modelUsage ?? {}) as Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>);
    const sum = (k: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'): number => usage.reduce((a, u) => a + (u[k] ?? 0), 0);
    assert.deepEqual(
      { input: o.metering.inputTokens, output: o.metering.outputTokens, cacheRead: o.metering.cacheReadTokens, cacheWrite: o.metering.cacheWriteTokens },
      { input: sum('inputTokens'), output: sum('outputTokens'), cacheRead: sum('cacheReadInputTokens'), cacheWrite: sum('cacheCreationInputTokens') },
      'the proxy counted exactly the usage the SDK saw',
    );
    const spend = h.svc.spendSummary(r.mission);
    assert.equal(spend.inflight, 0);
    assert.equal(spend.spent, o.metering.settledMicros);
    assert.ok(o.metering.metered >= 1 && o.metering.refused === 0);
    assert.ok(o.metering.reservedMicros >= o.metering.settledMicros);

    // the launch's seat.result: the notes, the product and the transcript in the ledger
    const [sr] = recordsOf(r, 'seat.result') as SeatResultRecord[];
    assert.ok(sr !== undefined);
    assert.deepEqual([sr.status, sr.result, sr.export, sr.transcript], ['handed-back', o.result, o.export, o.transcript]);

    // the unit: proof registered, eligible, cleaned
    assert.deepEqual((recordsOf(r, 'claude-code.exit') as ClaudeCodeExitRecord[]).map((x) => x.exit), [{ code: 0, signal: null }]);
    assert.ok(r.proof !== null);
    assert.deepEqual(checkTerminationProof(r.proof, { seatUnit: true, records: r.pending }), { eligible: true });
    assert.equal(r.cleanup, 'done');
    assert.equal(o.loginChanged, false);
  });
});
