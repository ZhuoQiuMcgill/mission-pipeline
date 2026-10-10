// Design 9.3 startup self-check, the LIVE items (code review r1 finding 7). Opt-in: MP_LIVE_MODEL=1.
// It uses the maintainer's subscription login (~/.claude/.credentials.json: only its
// claudeAiOauth entry, without the refresh token) and model claude-haiku-5-5; a few requests.
//
//   items 1, 2, 3: the probe session (seat/selfcheck.ts) runs exactly as a seat runs, against the
//     real model service under the real login (account connectors, if any, would attach here),
//     and every request the Claude Code process sends is read through the metering proxy;
//   item 8: the PM session's monitor is woken by a new notice: needs a probe module
//     (MP_PM_MONITOR_PROBE=<module exporting default async () => { ok, detail, events }>);
//   item 9: metering against the account's own usage: needs an account-usage module
//     (MP_ACCOUNT_USAGE_PROBE=<module exporting default async (from, to) => usage>); without it
//     item 9 fails and only the money form of spend_limit stays unavailable (6.5).
// Results are recorded as live evidence for the versions in use, in MP_SELFCHECK_DIR (the
// directory the seat hosts' gate reads) when it is set, else in a temporary directory.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, test } from 'node:test';
import { recordSelfCheck, selfCheckGate, toolchainVersions, type SelfCheckResult } from '../src/exec/selfcheck.ts';
import { DEFAULT_MODEL_CONFIG } from '../src/seat/modelConfig.ts';
import { checkMetering, checkPmMonitor, judgeProbeSession, runProbeSession, type AccountUsage, type PmMonitorProbe } from '../src/seat/selfcheck.ts';
import { UNIT_SKIP } from './seat-harness.ts';

const LIVE = process.env['MP_LIVE_MODEL'] === '1';
const SKIP = !LIVE ? 'set MP_LIVE_MODEL=1 to run the live self-check items (uses the subscription login)' : UNIT_SKIP;
const MODEL = 'claude-haiku-5-5';
const LOGIN = join(homedir(), '.claude', '.credentials.json');
const temp = mkdtempSync(join(tmpdir(), 'mp-selfcheck-live-'));
const DIR = process.env['MP_SELFCHECK_DIR'] ?? temp;
after(() => rmSync(temp, { recursive: true, force: true }));

async function loadDefault<T>(variable: string): Promise<T | undefined> {
  const path = process.env[variable];
  if (path === undefined || path === '') return undefined;
  return ((await import(pathToFileURL(path).href)) as { default: T }).default;
}

describe('startup self-check, live items 1, 2, 3, 8, 9', { skip: SKIP }, () => {
  const results: SelfCheckResult[] = [];
  const base = {
    upstream: 'https://api.anthropic.com',
    credentials: { kind: 'subscription' as const, source: LOGIN, minLifetimeMs: 15 * 60_000 },
    model: { provider: 'anthropic' as const, model: MODEL, maxOutputTokens: 256 },
    models: DEFAULT_MODEL_CONFIG,
    timeoutMs: 240_000,
  };

  test('items 1-3: no CLAUDE.md, no built-in tool, no connector attaching later, under the real login', async () => {
    const t0 = Date.now();
    const s = await runProbeSession({ ...base, waitMs: 20_000 });
    const judged = judgeProbeSession(s, 'live', Date.now() - t0);
    results.push(...judged);
    for (const r of judged) assert.ok(r.ok, `item ${r.item}: ${r.detail}\n${JSON.stringify(r.events).slice(0, 3000)}`);
  });

  test('item 8: the PM monitor wakes on a new notice (needs MP_PM_MONITOR_PROBE)', async () => {
    const r = await checkPmMonitor(await loadDefault<PmMonitorProbe>('MP_PM_MONITOR_PROBE'));
    results.push(r);
    assert.ok(r.ok, r.detail);
  });

  test('item 9: metering equals the account usage, reserved first, refused at the limit (needs MP_ACCOUNT_USAGE_PROBE)', async () => {
    const accountUsage = await loadDefault<(from: number, to: number) => Promise<AccountUsage | null>>('MP_ACCOUNT_USAGE_PROBE');
    const r = await checkMetering({ ...base, waitMs: 0, ...(accountUsage !== undefined ? { accountUsage } : {}) });
    results.push(r);
    assert.ok(r.ok, `${r.detail} (only the money form of spend_limit depends on this item)`);
  });

  test('the live evidence is recorded for the versions in use', () => {
    const versions = toolchainVersions();
    recordSelfCheck(DIR, versions, results);
    const v = selfCheckGate(DIR, versions);
    process.stdout.write(`# self-check evidence in ${DIR} (key ${v.key}): seats ${v.seatsAllowed ? 'allowed' : `refused: ${v.reason}`}; money mode ${v.moneyModeAllowed ? 'allowed' : 'unavailable'}\n`);
    assert.ok(results.length >= 3);
  });
});
