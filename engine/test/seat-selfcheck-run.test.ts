// Design 9.3 (release blocker of the live run): the startup self-check as the product runs it
// (src/seat/selfcheckLive.ts): live items recorded in live mode so the gate passes without
// fixtures; one background run per version key (a Claude Code update changes the key), paced
// to once an hour; a failure raises one WI-18 notice naming the failing items. No real model:
// the probe session runs exactly as a seat runs, against a scripted model service.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { readAlerts } from '../src/exec/alerts.ts';
import { GATE_ITEMS, SELFCHECK_RUN_DEADLINE_MS, readSelfCheck, readSelfCheckAttempts, recordSelfCheck, selfCheckGate, toolchainVersions, versionKey, writeSelfCheckAttempt, type SelfCheckResult, type ToolchainVersions } from '../src/exec/selfcheck.ts';
import { REAL_DURABLE_OPS } from '../src/exec/durable.ts';
import http from 'node:http';
import { raiseSelfCheckFailure } from '../src/cli/commands/selfcheck.ts';
import { DEFAULT_MODEL_CONFIG } from '../src/seat/modelConfig.ts';
import { checkSessionOffline, runProbeSession, startProbeUpstream } from '../src/seat/selfcheck.ts';
import { AUTO_SELFCHECK_INTERVAL_MS, cheapestModel, failureOf, maybeStartBackgroundSelfCheck, runStartupSelfCheck, selfCheckTestHooks, type SelfCheckSetup } from '../src/seat/selfcheckLive.ts';
import type { ProbeSession } from '../src/seat/selfcheck.ts';
import { runCli } from '../src/cli/main.ts';
import { readFileSync } from 'node:fs';
import { UNIT_OK, recordFixtureSelfCheck } from './seat-harness.ts';
import { seatGate } from '../src/scheduler/seats.ts';

const dirs: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const at = new Date().toISOString();
/** Passing offline results for every item the offline part covers (the real ones run in seat-selfcheck.test.ts). */
const offlinePass = async (): Promise<SelfCheckResult[]> =>
  [1, 2, 3, 4, 5, 6, 7, 10].map((item) => ({ item, name: `item ${item}`, ok: true, detail: 'passed', ms: 1, mode: 'offline' as const, events: [], at }));
const pmPass = async () => ({ ok: true, detail: 'the watcher woke (stub)', events: [] });
const setupIn = (dir: string): SelfCheckSetup => ({ dir, models: DEFAULT_MODEL_CONFIG, credentials: { kind: 'fake-api-key', key: 'sk-ant-api03-fake' } });

describe('the startup self-check as the product runs it (9.3)', () => {
  test('the cheapest configured model runs the probe', () => {
    const m = cheapestModel({ ...DEFAULT_MODEL_CONFIG, seats: { ...DEFAULT_MODEL_CONFIG.seats, secretary: { provider: 'anthropic', model: 'claude-haiku-5-5' } } });
    assert.deepEqual(m, { provider: 'anthropic', model: 'claude-haiku-5-5', maxOutputTokens: 256 });
    // priced as the proxy prices them: aliases and dated ids too
    const seats = Object.fromEntries(Object.keys(DEFAULT_MODEL_CONFIG.seats).map((k) => [k, { provider: 'anthropic' as const, model: 'opus' }]));
    assert.equal(cheapestModel({ ...DEFAULT_MODEL_CONFIG, seats: { ...seats, auditor: { provider: 'anthropic', model: 'haiku' } } }).model, 'haiku');
    assert.equal(cheapestModel({ ...DEFAULT_MODEL_CONFIG, seats: { ...seats, auditor: { provider: 'anthropic', model: 'claude-3-haiku-20240307' } } }).model, 'claude-3-haiku-20240307');
    assert.equal(cheapestModel({ ...DEFAULT_MODEL_CONFIG, seats }).model, 'opus', 'every seat on one model: that model');
  });

  test('live items 1-3 and 8 are recorded in live mode; the gate then allows seats without fixtures', { skip: UNIT_OK ? false : 'needs a usable bubblewrap and nsenter' }, async () => {
    const dir = tmp('mp-selfcheck-run-');
    const upstream = await startProbeUpstream();
    try {
      // the probe session runs exactly as a seat runs (enclosure, proxy, Claude Code), against a scripted model
      const run = await runStartupSelfCheck(setupIn(dir), {
        offline: offlinePass,
        pmProbe: pmPass,
        waitMs: 300,
        probeSession: (o) => runProbeSession({ ...o, upstream: upstream.url }),
      });
      for (const r of run.results.filter((x) => x.mode === 'live')) assert.ok(r.ok, `item ${r.item}: ${r.detail}`);
      const rec = readSelfCheck(dir, run.versions);
      assert.ok(rec !== null);
      for (const i of [1, 2, 3, 8]) assert.equal(rec.items[`${i}/live`]?.ok, true, `item ${i} live`);
      const gate = selfCheckGate(dir, run.versions, { acceptFixtures: false });
      assert.equal(gate.seatsAllowed, true, gate.reason ?? '');
      assert.deepEqual(run.gate.missing, []);
      assert.equal(run.key, versionKey(toolchainVersions()));
    } finally {
      await upstream.close();
    }
  });

  test('without item 8 or with the probe session failing, the gate names the items and refuses seats', async () => {
    const dir = tmp('mp-selfcheck-run-fail-');
    const run = await runStartupSelfCheck(setupIn(dir), {
      offline: offlinePass,
      probeSession: async () => {
        throw new Error('the model service did not answer');
      },
    });
    assert.equal(run.gate.seatsAllowed, false);
    assert.deepEqual(run.gate.failed.map((f) => f.item).sort((a, b) => a - b), [1, 2, 3, 8]);
    assert.match(run.results.find((r) => r.item === 1 && r.mode === 'live')?.detail ?? '', /could not run: the model service did not answer/);
  });

  test('a failure raises one WI-18 notice naming the failing items', async () => {
    const dir = tmp('mp-selfcheck-run-notice-');
    const state = tmp('mp-selfcheck-run-state-');
    const run = await runStartupSelfCheck(setupIn(dir), { offline: offlinePass, probeSession: async () => Promise.reject(new Error('down')) });
    await raiseSelfCheckFailure(state, null, failureOf(run), true);
    const alerts = readAlerts(state).filter((a) => a.kind === 'selfcheck-failed');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.wi, 'WI-18');
    assert.match(alerts[0]!.detail, /item 1: .*item 2: .*item 3: .*item 8: /);
    assert.equal(alerts[0]!.key, `selfcheck-run:${run.key}`);
  });
});

describe('automatic re-runs when the versions change (9.3)', () => {
  const install = (): { engineConfig: string; dir: string; state: string } => {
    const root = tmp('mp-selfcheck-auto-');
    const cfg = join(root, 'config');
    mkdirSync(cfg);
    const dir = join(root, 'selfcheck');
    writeFileSync(join(cfg, 'engine.json'), '{}');
    writeFileSync(join(cfg, 'scheduler.json'), JSON.stringify({ seats: { selfCheckDir: dir, credentials: { kind: 'fake-api-key', key: 'k' } } }));
    return { engineConfig: join(cfg, 'engine.json'), dir, state: join(root, 'state') };
  };
  const v = (claudeCode: string): ToolchainVersions => ({ ...toolchainVersions(), claudeCode });

  test('a new version key starts one background self-check; not again within the hour; a passing record stops it', () => {
    const i = install();
    mkdirSync(i.state);
    const spawned: string[] = [];
    const run = (versions: ToolchainVersions, now: number) =>
      maybeStartBackgroundSelfCheck({ configPath: '/cfg.json', engineConfig: i.engineConfig, stateDir: i.state }, { versions, now, spawnRun: (o) => spawned.push(o.configPath) });
    const t0 = 1_800_000_000_000;
    assert.equal(run(v('9.0.0'), t0).started, true, 'no evidence for these versions: one run');
    assert.equal(run(v('9.0.0'), t0 + 60_000).started, false, 'not again within the hour');
    assert.match(run(v('9.0.0'), t0 + 60_000).why, /within the hour/);
    assert.equal(run(v('9.0.1'), t0 + 120_000).started, true, 'an update changed the key: one run');
    assert.equal(run(v('9.0.1'), t0 + 180_000).started, false);
    assert.equal(spawned.length, 2);
    assert.equal(run(v('9.0.0'), t0 + AUTO_SELFCHECK_INTERVAL_MS + 1).started, true, 'an hour later it may run again');
    // once the evidence passes for these versions, nothing starts
    const passing: SelfCheckResult[] = GATE_ITEMS.map((item) => ({ item, name: `item ${item}`, ok: true, detail: 'passed', ms: 1, mode: 'live' as const, events: [], at }));
    recordSelfCheck(i.dir, v('9.0.2'), passing);
    const r = run(v('9.0.2'), t0 + 10 * AUTO_SELFCHECK_INTERVAL_MS);
    assert.deepEqual([r.started, r.why], [false, 'the self-check passed for these versions']);
    assert.equal(spawned.length, 3);
  });

  test('a test installation (acceptFixtures): the fixture evidence passes the same gate everywhere, nothing triggers, no live failure masks it', async () => {
    const root = tmp('mp-selfcheck-auto-fixtures-');
    const dir = join(root, 'selfcheck');
    writeFileSync(join(root, 'engine.json'), '{}');
    writeFileSync(join(root, 'scheduler.json'), JSON.stringify({ seats: { selfCheckDir: dir, credentials: { kind: 'fake-api-key', key: 'k' }, acceptFixtures: true } }));
    recordFixtureSelfCheck(dir);
    const r = maybeStartBackgroundSelfCheck({ configPath: '/cfg.json', engineConfig: join(root, 'engine.json'), stateDir: root }, { spawnRun: () => assert.fail('must not start under fixtures') });
    assert.equal(r.started, false);
    assert.match(r.why, /fixture evidence is accepted/);
    assert.equal(seatGate({ selfCheckDir: dir, acceptFixtures: true } as never).seatsAllowed, true, "the scheduler's gate");
    // a run under fixtures checks the offline items only: the fixture evidence for the live items stays in force
    const run = await runStartupSelfCheck({ ...setupIn(dir), acceptFixtures: true }, { offline: offlinePass, probeSession: async () => assert.fail('no live probe under fixtures') });
    assert.ok(!run.results.some((x) => x.mode === 'live'));
    assert.equal(run.gate.seatsAllowed, true);
  });

  test('no seat installation: nothing starts, and it says why', () => {
    const root = tmp('mp-selfcheck-auto-none-');
    writeFileSync(join(root, 'scheduler.json'), JSON.stringify({}));
    const r = maybeStartBackgroundSelfCheck({ configPath: '/cfg.json', engineConfig: join(root, 'engine.json'), stateDir: root }, { spawnRun: () => assert.fail('must not start') });
    assert.equal(r.started, false);
    assert.match(r.why, /no seat installation/);
  });
});

// ---------------------------------------------------------------- release review r6: the exception path

describe('a self-check that throws is a recorded failure and a WI-18 notice (release review r6)', () => {
  const PROBE = 'mcp__program__probe_wait';
  /** A probe session that passes items 1-3 (no real model). */
  const okSession = async (): Promise<ProbeSession> => {
    const req = (seq: number, t: number) => ({ seq, method: 'POST', path: '/v1/messages', at: t, toolNames: [PROBE], body: '{}', reservation: null, reservedMicros: 0 });
    return { requests: [req(1, 1), req(2, 3)], secrets: ['S-1', 'S-2', 'S-3'], probeReturnedAt: 2, proxyLog: [], proxyTotals: {} as never, sdkResult: null, fatal: null, error: null };
  };
  const clearHooks = (): void => {
    for (const k of Object.keys(selfCheckTestHooks)) delete (selfCheckTestHooks as Record<string, unknown>)[k];
  };
  after(clearHooks);
  /** A passing record for the versions in use (what an earlier run left). */
  const seedPass = (dir: string): void => {
    const live = [1, 2, 3, 8].map((item) => ({ item, name: `item ${item}`, ok: true, detail: 'passed', ms: 1, mode: 'live' as const, events: [], at }));
    const offline = [1, 2, 3, 4, 5, 6, 7, 10].map((item) => ({ item, name: `item ${item}`, ok: true, detail: 'passed', ms: 1, mode: 'offline' as const, events: [], at }));
    recordSelfCheck(dir, toolchainVersions(), [...offline, ...live]);
    assert.equal(selfCheckGate(dir, toolchainVersions(), { acceptFixtures: false }).seatsAllowed, true, 'seeded: seats allowed');
  };
  const io = (cwd: string) => ({ cwd, env: { ...process.env, MP_CONFIG: '' }, now: Date.now });
  const installArgs = (t: string) => ['install', '--root', join(t, 'root'), '--config', join(t, 'c.json'), '--credentials', 'subscription', '--control-plane', join(t, 'cp'), '--no-backup-inbox', '--bin-dir', join(t, 'bin'), '--no-start'];
  const injected = async (): Promise<readonly SelfCheckResult[]> => {
    throw new Error('injected: the offline initialization failed');
  };

  test('mp selfcheck: a seeded pass plus an exception in the offline initialization gives a failed record, no seats, one WI-18, and a retry under the hourly limit', async () => {
    const t = tmp('mp-selfcheck-r6-cli-');
    const inst = await runCli([...installArgs(t), '--skip-selfcheck', '--json'], io(t));
    assert.equal([0, 3].includes(inst.exitCode), true, inst.stdout + inst.stderr);
    const cfg = JSON.parse(readFileSync(join(t, 'c.json'), 'utf8')) as { selfCheckDir: string; stateDir: string; engineConfig: string };
    seedPass(cfg.selfCheckDir);
    Object.assign(selfCheckTestHooks, { offline: injected, probeSession: okSession, pmProbe: pmPass });
    try {
      const r = await runCli(['selfcheck', '--config', join(t, 'c.json'), '--json'], io(t));
      assert.equal(r.exitCode, 3, r.stdout + r.stderr);
      const out = JSON.parse(r.stdout) as { result: { passed: boolean } };
      assert.equal(out.result.passed, false);
    } finally {
      clearHooks();
    }
    const v = toolchainVersions();
    const rec = readSelfCheck(cfg.selfCheckDir, v);
    for (const i of [1, 2, 3, 4, 5, 6, 7, 10]) {
      assert.equal(rec?.items[`${i}/offline`]?.ok, false, `item ${i} is recorded failing`);
      assert.match(rec?.items[`${i}/offline`]?.detail ?? '', /could not run: injected/);
    }
    const gate = selfCheckGate(cfg.selfCheckDir, v, { acceptFixtures: false });
    assert.equal(gate.seatsAllowed, false, 'the earlier pass no longer stands in');
    const alerts = readAlerts(cfg.stateDir).filter((a) => a.kind === 'selfcheck-failed');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.wi, 'WI-18');
    // the engine start path sees the failure: not again within the hour, then once more
    const bg = (now: number) => maybeStartBackgroundSelfCheck({ configPath: join(t, 'c.json'), engineConfig: cfg.engineConfig, stateDir: cfg.stateDir }, { now, spawnRun: () => undefined });
    assert.equal(bg(Date.now()).started, false);
    assert.equal(bg(Date.now() + AUTO_SELFCHECK_INTERVAL_MS + 1_000).started, true);
  });

  test('mp install: the same exception gives a failed record, no seats, and one WI-18 (not only a line in the summary)', async () => {
    const t = tmp('mp-selfcheck-r6-install-');
    const dir = join(t, 'root', 'selfcheck');
    mkdirSync(dir, { recursive: true });
    seedPass(dir);
    Object.assign(selfCheckTestHooks, { offline: injected });
    let r;
    try {
      r = await runCli([...installArgs(t), '--json'], io(t));
    } finally {
      clearHooks();
    }
    assert.equal(r.exitCode, 3, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as { result: { selfCheck: { ok: boolean; failed: string[] } } };
    assert.equal(out.result.selfCheck.ok, false);
    assert.match(out.result.selfCheck.failed.join(' '), /could not run: injected/);
    assert.equal(selfCheckGate(dir, toolchainVersions(), { acceptFixtures: false }).seatsAllowed, false);
    const alerts = readAlerts(join(t, 'root', 'state')).filter((a) => a.kind === 'selfcheck-failed');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.wi, 'WI-18');
  });

  // ---------------------------------------------------------------- release review r7

  test('r7: the evidence cannot be written (EIO before its replace): the old pass stays on disk, but the failed run denies seats; one WI-18', async () => {
    const t = tmp('mp-selfcheck-r7-eio-');
    const inst = await runCli([...installArgs(t), '--skip-selfcheck', '--json'], io(t));
    assert.equal([0, 3].includes(inst.exitCode), true, inst.stdout + inst.stderr);
    const cfg = JSON.parse(readFileSync(join(t, 'c.json'), 'utf8')) as { selfCheckDir: string; stateDir: string };
    seedPass(cfg.selfCheckDir);
    const eio = { ...REAL_DURABLE_OPS, before: (step: string) => {
      if (step === 'rename') throw Object.assign(new Error('EIO: i/o error (injected before the replace)'), { code: 'EIO' });
    } };
    Object.assign(selfCheckTestHooks, { offline: offlinePass, probeSession: okSession, pmProbe: pmPass, recordOps: eio });
    let r;
    try {
      r = await runCli(['selfcheck', '--config', join(t, 'c.json'), '--json'], io(t));
    } finally {
      clearHooks();
    }
    assert.equal(r.exitCode, 3, r.stdout + r.stderr);
    const v = toolchainVersions();
    assert.equal(readSelfCheck(cfg.selfCheckDir, v)?.items['1/live']?.detail, 'passed', 'the old record could not be replaced');
    assert.equal(readSelfCheckAttempts(cfg.selfCheckDir)[versionKey(v)]?.outcome, 'failed');
    const gate = selfCheckGate(cfg.selfCheckDir, v, { acceptFixtures: false });
    assert.equal(gate.seatsAllowed, false);
    assert.match(gate.reason ?? '', /latest self-check run for these versions failed/);
    const alerts = readAlerts(cfg.stateDir).filter((a) => a.kind === 'selfcheck-failed');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.wi, 'WI-18');
    assert.match(alerts[0]!.detail, /could not complete: EIO/);
    // a later passing run lets seats start again
    Object.assign(selfCheckTestHooks, { offline: offlinePass, probeSession: okSession, pmProbe: pmPass });
    try {
      assert.equal((await runCli(['selfcheck', '--config', join(t, 'c.json'), '--json'], io(t))).exitCode, 0);
    } finally {
      clearHooks();
    }
    assert.equal(selfCheckGate(cfg.selfCheckDir, v, { acceptFixtures: false }).seatsAllowed, true);
  });

  test('r7: a run that never finished denies seats once past its deadline', () => {
    const dir = tmp('mp-selfcheck-r7-crash-');
    seedPass(dir);
    const v = toolchainVersions();
    const now = Date.now();
    writeSelfCheckAttempt(dir, versionKey(v), 'running', now);
    assert.equal(selfCheckGate(dir, v, { now: now + 60_000 }).seatsAllowed, true, 'still running: the earlier pass stands');
    const g = selfCheckGate(dir, v, { now: now + SELFCHECK_RUN_DEADLINE_MS + 1 });
    assert.equal(g.seatsAllowed, false);
    assert.match(g.reason ?? '', /did not finish/);
  });

  test('r7: an asynchronous listen error (EACCES) of the scripted model service is a recorded failure and one WI-18, not a crash', async () => {
    const t = tmp('mp-selfcheck-r7-listen-');
    const inst = await runCli([...installArgs(t), '--skip-selfcheck', '--json'], io(t));
    assert.equal([0, 3].includes(inst.exitCode), true, inst.stdout + inst.stderr);
    const cfg = JSON.parse(readFileSync(join(t, 'c.json'), 'utf8')) as { selfCheckDir: string; stateDir: string };
    seedPass(cfg.selfCheckDir);
    // the real offline session check (startProbeUpstream), whose listen fails asynchronously
    const proto = http.Server.prototype as unknown as { listen: (...a: unknown[]) => unknown };
    const own = Object.prototype.hasOwnProperty.call(proto, 'listen');
    const orig = proto.listen;
    proto.listen = function (this: http.Server) {
      setImmediate(() => this.emit('error', Object.assign(new Error('listen EACCES: permission denied 127.0.0.1 (injected)'), { code: 'EACCES' })));
      return this;
    };
    Object.assign(selfCheckTestHooks, {
      offline: async () => [...(await checkSessionOffline({ models: DEFAULT_MODEL_CONFIG })), ...(await offlinePass()).filter((x) => x.item > 3)],
      probeSession: okSession,
      pmProbe: pmPass,
    });
    let r;
    try {
      r = await runCli(['selfcheck', '--config', join(t, 'c.json'), '--json'], io(t));
    } finally {
      clearHooks();
      if (own) proto.listen = orig;
      else delete (proto as { listen?: unknown }).listen;
    }
    assert.equal(r.exitCode, 3, r.stdout + r.stderr);
    const v = toolchainVersions();
    const rec = readSelfCheck(cfg.selfCheckDir, v);
    for (const i of [1, 2, 3, 4, 5, 6, 7, 10]) assert.equal(rec?.items[`${i}/offline`]?.ok, false, `item ${i}`);
    assert.match(rec?.items['1/offline']?.detail ?? '', /listen EACCES/);
    assert.equal(selfCheckGate(cfg.selfCheckDir, v, { acceptFixtures: false }).seatsAllowed, false);
    const alerts = readAlerts(cfg.stateDir).filter((a) => a.kind === 'selfcheck-failed');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.wi, 'WI-18');
  });
});
