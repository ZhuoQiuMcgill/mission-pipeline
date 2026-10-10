// Design 7.1 "单元监管者": the supervisor as the main process of an independent transient
// systemd user service (Delegate=yes), with real cgroups. Each test launches a unit, waits
// for the service to finish, and reads only what the supervisor left: the proof (in the
// ledger stand-in or the state directory), the identity file and the alerts.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { id, type LaunchId } from '../src/common/ids.ts';
import type { TerminationProofRecord } from '../src/common/records.ts';
import type { LayerLimits } from '../src/exec/cgroup.ts';
import { scanCleanupFiles } from '../src/exec/cleanup.ts';
import { detectExecCapabilities } from '../src/exec/platform.ts';
import {
  MemoryProofLedger,
  readAlerts,
  readProofFile,
  proofFilePath,
  resubmitProofFile,
  scanProofFiles,
  type RetryPolicy,
} from '../src/exec/proof.ts';
import {
  isProcessAlive,
  killUnit,
  launchUnitSupervisor,
  readSupervisorIdentity,
  stopUnit,
  waitUnitInactive,
} from '../src/exec/supervisor.ts';

const caps = detectExecCapabilities();
const canRun = caps.systemdRun !== null && caps.delegatedControllers.includes('memory') && caps.delegatedControllers.includes('pids');
const skip = canRun ? false : 'needs systemd-run --user with delegated memory and pids controllers';

const dirs: string[] = [];
const units: string[] = [];
let sinkModule = '';
let seq = 0;

before(() => {
  const d = mkdtempSync(join(tmpdir(), 'mp-exec-sup-sink-'));
  dirs.push(d);
  sinkModule = join(d, 'sink.mjs');
  // A ProofSink module loaded inside the supervisor process. It records every attempt and
  // answers according to `mode`.
  writeFileSync(
    sinkModule,
    `import { appendFileSync, writeFileSync } from 'node:fs';
export function createProofSink(o) {
  return {
    async submit(proof) {
      appendFileSync(o.attemptsPath, JSON.stringify({ at: Date.now() }) + '\\n');
      if (o.mode === 'fail') throw new Error('ledger unavailable (test)');
      if (o.mode === 'reject') return { kind: 'rejected', reason: 'conflicting-proof', detail: 'a different proof is registered (test)' };
      writeFileSync(o.ledgerPath, JSON.stringify(proof));
      return { kind: 'registered', ack: 'ack:' + proof.launch, duplicate: false };
    },
  };
}
`,
  );
});

after(async () => {
  for (const u of units) await killUnit(u);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface UnitRun {
  readonly state: string;
  readonly launch: LaunchId;
  readonly unitName: string;
  attempts(): number[];
  ledgerProof(): TerminationProofRecord | null;
}

interface UnitOptions {
  readonly host: readonly string[];
  readonly unit?: LayerLimits;
  readonly sinkMode: 'accept' | 'fail' | 'reject';
  readonly retry?: Partial<RetryPolicy>;
  readonly orphanGraceMs?: number;
  readonly stopFiles?: readonly string[];
  readonly state?: string;
}

async function startUnit(o: UnitOptions): Promise<UnitRun> {
  const state = o.state ?? mkdtempSync(join(tmpdir(), 'mp-exec-sup-'));
  if (o.state === undefined) dirs.push(state);
  seq++;
  const launch = id<LaunchId>(`launch-sup-${process.pid}-${seq}`);
  const unitName = `mp-exec-test-${process.pid}-${seq}-${Date.now() % 100000}.service`;
  units.push(unitName);
  const attemptsPath = join(state, 'attempts.jsonl');
  const ledgerPath = join(state, 'ledger.json');
  await launchUnitSupervisor({
    config: {
      launch,
      stateDir: state,
      host: { argv: o.host, env: { PATH: '/usr/bin:/bin' }, cwd: state, stdoutPath: join(state, 'host.out'), stderrPath: join(state, 'host.err') },
      unit: o.unit ?? { memoryMax: 256 * 1024 * 1024, pidsMax: 64 },
      sink: { module: sinkModule, options: { mode: o.sinkMode, attemptsPath, ledgerPath } },
      ...(o.retry !== undefined ? { retry: o.retry } : {}),
      ...(o.orphanGraceMs !== undefined ? { orphanGraceMs: o.orphanGraceMs } : {}),
      ...(o.stopFiles !== undefined ? { stopFiles: o.stopFiles } : {}),
      stopGraceMs: 2_000,
    },
    unitName,
    logPath: join(state, 'supervisor.log'),
  });
  return {
    state,
    launch,
    unitName,
    attempts: () =>
      existsSync(attemptsPath)
        ? readFileSync(attemptsPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => (JSON.parse(l) as { at: number }).at)
        : [],
    ledgerProof: () => (existsSync(ledgerPath) ? (JSON.parse(readFileSync(ledgerPath, 'utf8')) as TerminationProofRecord) : null),
  };
}

async function finish(u: UnitRun, ms = 30_000): Promise<void> {
  const done = await waitUnitInactive(u.unitName, ms);
  const log = existsSync(join(u.state, 'supervisor.log')) ? readFileSync(join(u.state, 'supervisor.log'), 'utf8') : '';
  assert.ok(done, `unit ${u.unitName} still active; supervisor log:\n${log}`);
}

async function waitFor(path: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('unit supervisor in a transient systemd user service', { skip }, () => {
  test('a normal host: the proof carries its real exit code (7) and zero OOM counts', async () => {
    const u = await startUnit({ host: ['/bin/sh', '-c', 'sleep 0.2; exit 7'], sinkMode: 'accept' });
    await finish(u);
    assert.deepEqual(u.ledgerProof(), {
      kind: 'termination.proof',
      launch: u.launch,
      exit: { code: 7, signal: null },
      controlOomKill: 0,
      unitOomKill: 0,
      unitOom: 0,
    });
    assert.equal(u.attempts().length, 1);
    assert.equal(existsSync(proofFilePath(u.state, u.launch)), false, 'a registered proof leaves no file behind');
    const identity = readSupervisorIdentity(u.state, u.launch);
    assert.ok(identity);
    assert.equal(identity.unitName, u.unitName);
    assert.equal(isProcessAlive(identity), false, 'the supervisor has exited');
    assert.deepEqual(readAlerts(u.state), []);
  });

  test('unit OOM: the supervisor survives; its proof records SIGKILL (shell status 137), unit oom >= 1, oom_kill >= 1', async () => {
    const u = await startUnit({
      host: ['/bin/sh', '-c', 'sleep 30 & python3 -c "b=bytearray(200*1024*1024)"; echo AFTER'],
      unit: { memoryMax: 64 * 1024 * 1024, pidsMax: 64 },
      sinkMode: 'accept',
    });
    await finish(u);
    const p = u.ledgerProof();
    assert.ok(p, 'the supervisor survived the unit OOM and registered a proof');
    assert.deepEqual(p.exit, { code: null, signal: 'SIGKILL' });
    assert.ok(p.unitOom >= 1, `unit oom ${p.unitOom}`);
    assert.ok(p.unitOomKill >= 1, `unit oom_kill ${p.unitOomKill}`);
    assert.ok(p.controlOomKill >= 1, 'memory.oom.group killed the control layer too');
    assert.equal(readFileSync(join(u.state, 'host.out'), 'utf8').includes('AFTER'), false, 'the host never ran on after the OOM');
  });

  test('the proof is written only after the unit subtree is empty (an orphan that ends by itself)', async () => {
    const state = mkdtempSync(join(tmpdir(), 'mp-exec-sup-'));
    dirs.push(state);
    const mark = join(state, 'orphan-done');
    const u = await startUnit({
      state,
      host: ['/bin/sh', '-c', `(sleep 1; echo done > ${mark}) >/dev/null 2>&1 & exit 7`],
      sinkMode: 'fail',
      retry: { initialDelayMs: 10, maxDelayMs: 10, totalMs: 0 },
      orphanGraceMs: 10_000,
    });
    await finish(u);
    const f = readProofFile(proofFilePath(u.state, u.launch));
    assert.deepEqual(f.proof.exit, { code: 7, signal: null });
    assert.equal(f.diagnostics.populatedAtProof, false);
    assert.equal(f.diagnostics.leftoversKilled, false);
    assert.ok(existsSync(mark), 'the orphan finished');
    assert.ok(statSync(mark).mtimeMs <= Date.parse(f.writtenAt), 'proof written after the orphan ended');
    assert.ok(Date.parse(f.diagnostics.unitEmptyAt) - Date.parse(f.diagnostics.hostExitedAt) >= 700, 'the supervisor waited for the orphan');
  });

  test('left-over processes are killed before the proof (an orphan that would outlive the grace)', async () => {
    const marker = `mp-orphan-${process.pid}-${Date.now()}`;
    const u = await startUnit({
      host: ['/bin/sh', '-c', `/bin/sh -c 'sleep 30; true ${marker}' >/dev/null 2>&1 & exit 0`],
      sinkMode: 'fail',
      retry: { initialDelayMs: 10, maxDelayMs: 10, totalMs: 0 },
      orphanGraceMs: 300,
    });
    await finish(u);
    const f = readProofFile(proofFilePath(u.state, u.launch));
    assert.equal(f.diagnostics.leftoversKilled, true);
    assert.equal(f.diagnostics.populatedAtProof, false);
    let survivors = '';
    try {
      survivors = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' });
    } catch {
      /* pgrep exits 1 when nothing matches */
    }
    assert.equal(survivors.trim(), '', 'no orphan survives its unit');
  });

  test('a failing sink: bounded back-off, then the file is left, an alert raised, and the scheduler can submit it', async () => {
    const u = await startUnit({
      host: ['/bin/sh', '-c', 'exit 0'],
      sinkMode: 'fail',
      retry: { initialDelayMs: 50, maxDelayMs: 200, totalMs: 1_200, attemptTimeoutMs: 5_000 },
    });
    await finish(u);
    const at = u.attempts();
    assert.ok(at.length >= 4 && at.length <= 12, `${at.length} attempts`);
    const gaps = at.slice(1).map((t, i) => t - (at[i] as number));
    assert.ok((gaps[0] as number) >= 40 && (gaps[1] as number) >= 90, `back-off doubles: ${gaps.join(',')}`);
    assert.ok(gaps.every((g) => g <= 200 + 500), `capped at maxDelay: ${gaps.join(',')}`);
    assert.ok((at.at(-1) as number) - (at[0] as number) <= 1_200 + 500, 'no attempt after the total window');
    const alerts = readAlerts(u.state);
    assert.deepEqual(
      alerts.map((a) => a.kind),
      ['proof-submission-exhausted'],
    );

    // 6.3: the scheduler scans the state directory and submits what was left behind.
    const scan = scanProofFiles(u.state);
    assert.equal(scan.pending.length, 1);
    const entry = scan.pending[0];
    assert.ok(entry);
    assert.equal(entry.file.proof.launch, u.launch);
    const ledger = new MemoryProofLedger({ knownLaunches: [u.launch] });
    const out = await resubmitProofFile(entry, ledger);
    assert.equal(out.kind, 'registered');
    assert.deepEqual(ledger.get(u.launch)?.exit, { code: 0, signal: null });
    assert.equal(scanProofFiles(u.state).pending.length, 0);
  });

  test('a deterministic rejection: one attempt, the file is marked rejected, an alert raised', async () => {
    const u = await startUnit({ host: ['/bin/sh', '-c', 'exit 0'], sinkMode: 'reject' });
    await finish(u);
    assert.equal(u.attempts().length, 1);
    const f = readProofFile(proofFilePath(u.state, u.launch));
    assert.equal(f.status, 'rejected');
    assert.equal(f.rejection?.reason, 'conflicting-proof');
    assert.deepEqual(
      readAlerts(u.state).map((a) => a.kind),
      ['proof-rejected'],
    );
    assert.equal(scanProofFiles(u.state).pending.length, 0, 'a rejected proof is never resubmitted');
  });

  test('v34: every unit process carries oom_score_adj=1000; the supervisor keeps the default', async () => {
    const state = mkdtempSync(join(tmpdir(), 'mp-exec-sup-'));
    dirs.push(state);
    const out = join(state, 'adj');
    const u = await startUnit({
      state,
      host: ['/bin/sh', '-c', `cat /proc/self/oom_score_adj > ${out}; cat /proc/$PPID/oom_score_adj >> ${out}; sh -c 'cat /proc/self/oom_score_adj' >> ${out}`],
      sinkMode: 'accept',
    });
    await finish(u);
    const [host, supervisor, child] = readFileSync(out, 'utf8').trim().split('\n');
    assert.equal(host, '1000');
    assert.equal(child, '1000', 'inherited by what the host starts');
    assert.notEqual(supervisor, '1000');
  });

  test('v34: a proof file that cannot be written is submitted directly, with an alert', async () => {
    const state = mkdtempSync(join(tmpdir(), 'mp-exec-sup-'));
    dirs.push(state);
    writeFileSync(join(state, 'proofs'), 'not a directory'); // the proof file cannot be created
    const u = await startUnit({ state, host: ['/bin/sh', '-c', 'exit 5'], sinkMode: 'accept' });
    await finish(u);
    assert.deepEqual(u.ledgerProof()?.exit, { code: 5, signal: null }, 'the in-memory proof reached the ledger');
    assert.ok(readAlerts(u.state).some((a) => a.kind === 'proof-write-failed'));
    const cleanup = scanCleanupFiles(u.state).find((f) => f.launch === u.launch);
    assert.equal(cleanup?.state, 'done', 'once the proof is registered, the unit cgroup is released');
  });

  test('v35: without a proof file and without a registered proof, the unit cgroup stays a pending cleanup resource', async () => {
    const state = mkdtempSync(join(tmpdir(), 'mp-exec-sup-'));
    dirs.push(state);
    writeFileSync(join(state, 'proofs'), 'not a directory');
    const u = await startUnit({ state, host: ['/bin/sh', '-c', 'exit 0'], sinkMode: 'fail', retry: { initialDelayMs: 10, maxDelayMs: 10, totalMs: 0 } });
    await finish(u);
    const cleanup = scanCleanupFiles(u.state).find((f) => f.launch === u.launch);
    assert.equal(cleanup?.state, 'pending');
    assert.ok(cleanup?.resources.some((r) => r.startsWith('cgroup:') && r.endsWith('/unit')), JSON.stringify(cleanup?.resources));
  });

  test('a stop (systemctl stop, SIGTERM to the supervisor only): the host is ended, the proof written, one submission', async () => {
    const state = mkdtempSync(join(tmpdir(), 'mp-exec-sup-'));
    dirs.push(state);
    const up = join(state, 'host-up');
    const u = await startUnit({ state, host: ['/bin/sh', '-c', `echo up > ${up}; exec sleep 30`], sinkMode: 'fail' });
    await waitFor(up, 15_000);
    const t0 = Date.now();
    await stopUnit(u.unitName, 60_000);
    await finish(u);
    assert.ok(Date.now() - t0 < 15_000, 'the stop did not wait for the 10-minute retry window');
    assert.equal(u.attempts().length, 1, 'exactly one submission under a stop');
    const f = readProofFile(proofFilePath(u.state, u.launch));
    assert.equal(f.status, 'pending', 'the proof stays for the scheduler');
    assert.equal(f.diagnostics.stopped, true);
    assert.deepEqual(f.proof.exit, { code: null, signal: 'SIGTERM' });
    assert.equal(f.proof.unitOomKill, 0);
  });

  test('a stop through the control plane\'s fast signal (stop file)', async () => {
    const state = mkdtempSync(join(tmpdir(), 'mp-exec-sup-'));
    dirs.push(state);
    const up = join(state, 'host-up');
    const stopFile = join(state, 'stop-requested');
    const u = await startUnit({ state, host: ['/bin/sh', '-c', `echo up > ${up}; exec sleep 30`], sinkMode: 'fail', stopFiles: [stopFile] });
    await waitFor(up, 15_000);
    writeFileSync(stopFile, '');
    await finish(u, 20_000);
    assert.equal(u.attempts().length, 1);
    const f = readProofFile(proofFilePath(u.state, u.launch));
    assert.equal(f.diagnostics.stopped, true);
    assert.deepEqual(f.proof.exit, { code: null, signal: 'SIGTERM' });
  });
});
