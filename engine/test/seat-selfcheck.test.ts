// Code review r1 finding 7 (design 9.3 "启动自检（放行测试）"): the startup self-check is a release
// gate. Evidence is stored per Claude Code + SDK + Node version; the offline items (4, 5, 6, 7, 10
// and the offline parts of 1-3) really run here; items 1, 2, 3 and 8 count only from a live run
// (test/seat-selfcheck-live.test.ts); item 9 decides only the money form of spend_limit. The
// capability probe exercises the real sandbox path (the reviewer saw bwrapUsable=true while the
// file tool failed on the network namespace).

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { detectExecCapabilities, findTool, probeBwrap } from '../src/exec/platform.ts';
import {
  GATE_ITEMS,
  checkAgentRuntime,
  readSelfCheck,
  recordSelfCheck,
  selfCheckGate,
  toolchainVersions,
  versionKey,
  type SelfCheckMode,
  type SelfCheckResult,
  type ToolchainVersions,
} from '../src/exec/selfcheck.ts';
import { DEFAULT_MODEL_CONFIG } from '../src/seat/modelConfig.ts';
import { judgeProbeSession, runOfflineSelfCheck, type ProbeSession } from '../src/seat/selfcheck.ts';
import { UNIT_OK } from './seat-harness.ts';

const dirs: string[] = [];
function tmp(prefix = 'mp-selfcheck-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const V: ToolchainVersions = { claudeCode: '2.1.295', claudeCodeBinary: 'abc', sdk: '0.3.295', node: 'v22.17.1', platform: 'linux', arch: 'x64' };
const r = (item: number, mode: SelfCheckMode, ok = true): SelfCheckResult => ({ item, name: `item ${item}`, ok, detail: ok ? 'passed' : 'broken', ms: 1, mode, events: [], at: 'now' });

describe('the gate (9.3, WI-18)', () => {
  test('no evidence for these versions: no seat', () => {
    const v = selfCheckGate(tmp(), V);
    assert.equal(v.seatsAllowed, false);
    assert.deepEqual(v.missing, GATE_ITEMS);
    assert.match(v.reason ?? '', /Claude Code 2\.1\.295, SDK 0\.3\.295, Node v22\.17\.1/);
  });

  test('offline evidence alone is not enough: items 1, 2, 3 and 8 need a live run; then seats start; item 9 only gates money', () => {
    const dir = tmp();
    recordSelfCheck(dir, V, [1, 2, 3, 4, 5, 6, 7, 10].map((i) => r(i, 'offline')));
    let v = selfCheckGate(dir, V);
    assert.equal(v.seatsAllowed, false);
    assert.deepEqual(v.missing, [8]);
    assert.deepEqual(v.failed.map((f) => f.item), [1, 2, 3]);
    assert.ok(v.failed.every((f) => /needs a live run/.test(f.why)));
    recordSelfCheck(dir, V, [1, 2, 3, 8].map((i) => r(i, 'live')));
    v = selfCheckGate(dir, V);
    assert.equal(v.seatsAllowed, true);
    assert.equal(v.moneyModeAllowed, false, 'no item 9 yet');
    recordSelfCheck(dir, V, [r(9, 'live', false)]);
    v = selfCheckGate(dir, V);
    assert.deepEqual([v.seatsAllowed, v.moneyModeAllowed], [true, false], 'item 9 failing only disables money mode');
    recordSelfCheck(dir, V, [r(9, 'live')]);
    assert.equal(selfCheckGate(dir, V).moneyModeAllowed, true);
    // a later offline run never replaces the live evidence
    recordSelfCheck(dir, V, [1, 2, 3].map((i) => r(i, 'offline')));
    assert.equal(selfCheckGate(dir, V).seatsAllowed, true);
    assert.equal(readSelfCheck(dir, V)?.key, versionKey(V));
  });

  test('any failure blocks, an offline failure of a live item too; another version has no evidence', () => {
    const dir = tmp();
    recordSelfCheck(dir, V, [...[4, 5, 6, 7, 10].map((i) => r(i, 'offline')), ...[1, 2, 3, 8].map((i) => r(i, 'live'))]);
    assert.equal(selfCheckGate(dir, V).seatsAllowed, true);
    recordSelfCheck(dir, V, [r(5, 'offline', false)]);
    assert.deepEqual(selfCheckGate(dir, V).failed.map((f) => f.item), [5]);
    recordSelfCheck(dir, V, [r(5, 'offline'), r(2, 'offline', false)]);
    assert.deepEqual(selfCheckGate(dir, V).failed.map((f) => f.item), [2], 'the session options are wrong even if a live run passed');
    recordSelfCheck(dir, V, [r(2, 'offline')]);
    assert.equal(selfCheckGate(dir, V).seatsAllowed, true);
    for (const k of ['node', 'sdk', 'claudeCode', 'claudeCodeBinary'] as const) {
      assert.equal(selfCheckGate(dir, { ...V, [k]: `${V[k]}-other` }).seatsAllowed, false, `a different ${k}`);
    }
    // degraded isolation (Windows native): items 5 and 6 do not apply
    const win = tmp();
    recordSelfCheck(win, V, [...[4, 7, 10].map((i) => r(i, 'offline')), ...[1, 2, 3, 8].map((i) => r(i, 'live'))]);
    assert.equal(selfCheckGate(win, V).seatsAllowed, false);
    assert.equal(selfCheckGate(win, V, { isolationDegraded: true }).seatsAllowed, true);
  });

  test('fixtures (tests only) count only where explicitly accepted', () => {
    const dir = tmp();
    recordSelfCheck(dir, V, [...GATE_ITEMS, 9].map((i) => r(i, 'fixture')));
    const strict = selfCheckGate(dir, V);
    assert.equal(strict.seatsAllowed, false);
    assert.ok(strict.failed.every((f) => /test fixture/.test(f.why)));
    assert.equal(selfCheckGate(dir, V, { acceptFixtures: true }).seatsAllowed, true);
  });

  test('the versions in use name the SDK, its Claude Code binary and this Node', () => {
    const v = toolchainVersions();
    assert.equal(v.node, process.version);
    assert.equal(v.sdk, '0.3.295');
    assert.match(v.claudeCode, /^\d+\.\d+\.\d+/);
    assert.match(v.claudeCodeBinary, /^[0-9a-f]{64}$/, 'the manifest checksum of this platform\'s binary');
  });
});

describe('items 1-3 are judged from what the process sent', () => {
  const base: ProbeSession = {
    requests: [],
    secrets: ['SECRET-A', 'SECRET-B'],
    probeReturnedAt: 1_000,
    proxyLog: [],
    proxyTotals: { requests: 0, metered: 0, refused: 0, reservedMicros: 0, settledMicros: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
    sdkResult: null,
    fatal: null,
    error: null,
  };
  const req = (seq: number, at: number, tools: string[], body = '{}') => ({ seq, method: 'POST', path: '/v1/messages?beta=true', at, toolNames: tools, body, reservation: null, reservedMicros: 0 });
  const P = 'mcp__program__probe_wait';
  const ok = (s: ProbeSession) => judgeProbeSession(s, 'offline', 1).map((x) => [x.item, x.ok, x.detail]);

  test('a clean session passes all three', () => {
    assert.deepEqual(
      ok({ ...base, requests: [req(1, 500, [P]), req(2, 1_500, [P])] }).map((x) => x[1]),
      [true, true, true],
    );
  });

  test('a secret in any request, a foreign tool, a tool list that grows after the wait, or no second look: each fails its item', () => {
    assert.match(String(ok({ ...base, requests: [req(1, 500, [P], '{"system":"... SECRET-B ..."}'), req(2, 1_500, [P])] })[0]?.[2]), /SECRET-B in request 1/);
    assert.equal(ok({ ...base, requests: [req(1, 500, [P, 'Bash']), req(2, 1_500, [P, 'Bash'])] })[2]?.[1], false);
    assert.equal(ok({ ...base, requests: [req(1, 500, [P, 'mcp__claude_ai_Google_Drive__search']), req(2, 1_500, [P])] })[2]?.[1], false);
    assert.match(String(ok({ ...base, requests: [req(1, 500, [P]), req(2, 1_500, [P, 'mcp__claude_ai_Docs__create'])] })[1]?.[2]), /changed after the wait/);
    assert.match(String(ok({ ...base, probeReturnedAt: null, requests: [req(1, 500, [P])] })[1]?.[2]), /never ran/);
    assert.ok(ok({ ...base, error: 'spawn failed' }).every((x) => x[1] === false), 'a session that did not run proves nothing');
  });
});

describe('the offline self-check, for real', { skip: UNIT_OK ? false : 'needs a usable bubblewrap, nsenter and systemd' }, () => {
  test('items 1-3 (offline parts), 4, 5, 6, 7 and 10 pass on this machine and are recorded for these versions', async () => {
    const dir = tmp();
    const run = await runOfflineSelfCheck({ dir, models: DEFAULT_MODEL_CONFIG });
    for (const res of run.results) assert.ok(res.ok, `item ${res.item} ${res.name}: ${res.detail}\n${JSON.stringify(res.events).slice(0, 3000)}`);
    assert.deepEqual(run.results.map((x) => x.item).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 10]);
    const v = selfCheckGate(dir, toolchainVersions());
    assert.deepEqual(v.missing, [8], 'only the live items are left');
    assert.deepEqual(v.failed.map((f) => f.item), [1, 2, 3]);
    assert.ok(run.results.every((x) => x.events.length > 0), 'raw events are kept');
  });

  test('the capability probe runs the real sandbox path: a bubblewrap that cannot build a network namespace is not usable', async () => {
    const real = findTool('bwrap');
    assert.ok(real !== null);
    const d = tmp();
    const wrapper = join(d, 'bwrap');
    // starts, but refuses what the sandbox needs (as when NETLINK_ROUTE is denied)
    writeFileSync(wrapper, `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--unshare-net" ] && { echo "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" >&2; exit 1; }; done\nexec ${real} "$@"\n`);
    chmodSync(wrapper, 0o755);
    assert.equal(probeBwrap(real), true);
    assert.equal(probeBwrap(wrapper), false, 'the probe uses the sandbox flags, --unshare-net included');
    const item10 = await checkAgentRuntime({ bwrap: wrapper });
    assert.equal(item10.ok, false, 'and the self-check fails deterministically through the real path');
    assert.equal(detectExecCapabilities().bwrapUsable, true);
  });
});
