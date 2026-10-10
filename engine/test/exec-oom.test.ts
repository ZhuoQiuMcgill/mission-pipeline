// Design 7.1 OOM attribution through the whole chain: unit supervisor (transient service,
// Delegate=yes) -> verification-run host in the unit's control layer -> sandboxed command in
// its own run layer. Three triggers: the run layer's own limit, the unit's limit, an
// ancestor's limit (the service's MemoryMax). The proof and the host's run records then go
// through the acceptance check (acceptance.ts).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { id, type LaunchId } from '../src/common/ids.ts';
import type { TerminationProofRecord } from '../src/common/records.ts';
import { checkTerminationProof } from '../src/exec/acceptance.ts';
import type { LayerLimits } from '../src/exec/cgroup.ts';
import { detectExecCapabilities, which } from '../src/exec/platform.ts';
import { RUN_HOST_JOB_FORMAT, RUN_HOST_MAIN, readRunRecords, type RunHostJob, type RunHostRun } from '../src/exec/run-host.ts';
import { hostSystemEnvironment, type SandboxRunResult } from '../src/exec/sandbox.ts';
import { proofFilePath, readProofFile, type ProofDiagnostics } from '../src/exec/proof.ts';
import { killUnit, launchUnitSupervisor, stopUnit, waitUnitInactive } from '../src/exec/supervisor.ts';

const MiB = 1024 * 1024;
const caps = detectExecCapabilities();
const canRun =
  caps.systemdRun !== null &&
  caps.bwrapUsable &&
  caps.nsenter !== null &&
  caps.delegatedControllers.includes('memory') &&
  caps.delegatedControllers.includes('pids') &&
  which('python3') !== null;
const skip = canRun ? false : 'needs systemd-run --user with delegated memory/pids, bubblewrap, nsenter and python3';

const dirs: string[] = [];
const units: string[] = [];
let sinkModule = '';
let seq = 0;

before(() => {
  const d = mkdtempSync(join(tmpdir(), 'mp-exec-oom-sink-'));
  dirs.push(d);
  sinkModule = join(d, 'sink.mjs');
  writeFileSync(
    sinkModule,
    `import { writeFileSync } from 'node:fs';
export function createProofSink(o) {
  return {
    async submit(proof) {
      writeFileSync(o.ledgerPath, JSON.stringify(proof));
      // keepFile: answer "unavailable" so the proof file (with its diagnostics) stays in the state directory
      return o.keepFile ? { kind: 'unavailable', detail: 'kept for inspection' } : { kind: 'registered', ack: 'ack', duplicate: false };
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

interface Outcome {
  readonly launch: LaunchId;
  readonly proof: TerminationProofRecord;
  readonly diagnostics: ProofDiagnostics | null;
  readonly records: ReturnType<typeof readRunRecords>;
  readonly results: SandboxRunResult[] | null;
}

interface Launched {
  readonly t: string;
  readonly launch: LaunchId;
  readonly unitName: string;
  readonly job: RunHostJob;
  readonly keepFile: boolean;
}

/** Runs a verification unit to its end and returns what the supervisor and the host left. */
async function runUnit(runs: RunHostRun[], unit: LayerLimits, serviceProperties: string[] = [], keepFile = false): Promise<Outcome> {
  return collect(await launchUnit(runs, unit, serviceProperties, keepFile));
}

async function launchUnit(runs: RunHostRun[], unit: LayerLimits, serviceProperties: string[] = [], keepFile = false): Promise<Launched> {
  const t = mkdtempSync(join(tmpdir(), 'mp-exec-oom-'));
  dirs.push(t);
  const snap = join(t, 'snap');
  mkdirSync(join(snap, 'out'), { recursive: true });
  const session = join(t, 'session');
  mkdirSync(session);
  seq++;
  const launch = id<LaunchId>(`launch-oom-${process.pid}-${seq}`);
  const job: RunHostJob = {
    format: RUN_HOST_JOB_FORMAT,
    launch,
    sandbox: {
      snapshotDir: snap,
      writablePaths: ['out'],
      area: { kind: 'tmpfs', bytes: 4 * MiB },
      environment: hostSystemEnvironment(),
      sessionDir: session,
    },
    runs,
    recordsPath: join(t, 'records.jsonl'),
    resultsPath: join(t, 'results.json'),
  };
  writeFileSync(join(t, 'job.json'), JSON.stringify(job));
  const unitName = `mp-exec-test-oom-${process.pid}-${seq}.service`;
  units.push(unitName);
  await launchUnitSupervisor({
    config: {
      launch,
      stateDir: t,
      host: {
        argv: [process.execPath, '--experimental-strip-types', '--disable-warning=ExperimentalWarning', RUN_HOST_MAIN, join(t, 'job.json')],
        env: { PATH: '/usr/bin:/bin' },
        cwd: t,
        stdoutPath: join(t, 'host.out'),
        stderrPath: join(t, 'host.err'),
      },
      unit,
      sink: { module: sinkModule, options: { ledgerPath: join(t, 'ledger.json'), keepFile } },
      retry: { initialDelayMs: 10, maxDelayMs: 10, totalMs: 0 },
    },
    unitName,
    serviceProperties,
    logPath: join(t, 'supervisor.log'),
  });
  return { t, launch, unitName, job, keepFile };
}

async function collect(l: Launched): Promise<Outcome> {
  const { t, launch, unitName, job, keepFile } = l;
  const done = await waitUnitInactive(unitName, 60_000);
  const diag = (): string =>
    ['supervisor.log', 'host.err', 'alerts.jsonl']
      .filter((f) => existsSync(join(t, f)))
      .map((f) => `--- ${f}\n${readFileSync(join(t, f), 'utf8')}`)
      .join('\n');
  assert.ok(done, `unit still active\n${diag()}`);
  assert.ok(existsSync(join(t, 'ledger.json')), `no proof was registered\n${diag()}`);
  return {
    launch,
    proof: JSON.parse(readFileSync(join(t, 'ledger.json'), 'utf8')) as TerminationProofRecord,
    diagnostics: keepFile ? readProofFile(proofFilePath(t, launch)).diagnostics : null,
    records: readRunRecords(job.recordsPath),
    results: existsSync(job.resultsPath) ? (JSON.parse(readFileSync(job.resultsPath, 'utf8')) as SandboxRunResult[]) : null,
  };
}

const alloc = (mib: number): string => `python3 -c "b=bytearray(${mib}*1024*1024)"`;

function pgrep(pattern: string): string {
  return spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).stdout.trim();
}

describe('OOM attribution through supervisor, run host and run layers', { skip }, () => {
  test('run layer over its own declared peak: the run gets "resource exceeded", the attempt stays acceptable', async () => {
    const o = await runUnit(
      [
        { run: 'r1', command: `echo before; ${alloc(200)}; echo AFTER`, limits: { memoryMax: 64 * MiB, pidsMax: 64 } },
        { run: 'r2', command: 'echo next; cat /proc/self/oom_score_adj; exit 3', limits: { memoryMax: 64 * MiB, pidsMax: 64 } },
      ],
      { memoryMax: 1024 * MiB, pidsMax: 256 },
    );
    assert.ok(o.results, 'the host survived');
    const [r1, r2] = o.results;
    assert.equal(r1?.status, 'resource-exceeded');
    assert.equal(r1?.stdout.text, 'before\n', 'the whole layer was killed: the shell never reached AFTER');
    assert.equal(r2?.status, 'completed');
    assert.deepEqual(r2?.exit, { code: 3, signal: null });
    assert.equal(r2?.stdout.text, 'next\n1000\n', 'a run inside the sandbox carries the unit oom_score_adj (v34)');

    const rec1 = o.records.find((r) => r.run === 'r1');
    assert.ok(rec1);
    assert.ok(rec1.oomDelta >= 1 && rec1.oomKillDelta >= 1, JSON.stringify(rec1));
    assert.deepEqual(o.proof.exit, { code: 0, signal: null });
    assert.equal(o.proof.controlOomKill, 0);
    assert.equal(o.proof.unitOom, 0, "the unit's own limit never fired");
    assert.equal(o.proof.unitOomKill, rec1.oomKillDelta, 'every kill in the unit is the recorded run layer kill');
    assert.deepEqual(checkTerminationProof(o.proof, { seatUnit: false, records: o.records }), { eligible: true });
  });

  test('several processes of one run together over its peak: the whole run layer ends, "resource exceeded"', async () => {
    const each = `python3 -c "import time; b=bytearray(30*1024*1024); time.sleep(3)"`;
    const o = await runUnit(
      [{ run: 'r1', command: `${each} & ${each} & ${each} & wait; echo AFTER`, limits: { memoryMax: 64 * MiB, pidsMax: 64 } }],
      { memoryMax: 1024 * MiB, pidsMax: 256 },
    );
    const r1 = o.results?.[0];
    assert.equal(r1?.status, 'resource-exceeded');
    assert.equal(r1?.stdout.text.includes('AFTER'), false);
    const rec = o.records[0];
    assert.ok(rec && rec.oomKillDelta >= 3, `all processes of the layer were killed: ${JSON.stringify(rec)}`);
    assert.deepEqual(checkTerminationProof(o.proof, { seatUnit: false, records: o.records }), { eligible: true });
  });

  test("a run layer's pids.max caps the processes one run may start; the unit is unaffected", async () => {
    const o = await runUnit(
      [
        { run: 'r1', command: 'for i in $(seq 1 60); do sleep 1 & done; wait; echo done', limits: { memoryMax: 256 * MiB, pidsMax: 16 } },
        { run: 'r2', command: 'echo next', limits: { memoryMax: 64 * MiB, pidsMax: 16 } },
      ],
      { memoryMax: 1024 * MiB, pidsMax: 512 },
    );
    const [r1, r2] = o.results ?? [];
    assert.equal(r1?.status, 'completed');
    assert.match(r1?.stderr.text ?? '', /fork/i, 'forks beyond pids.max failed');
    assert.notEqual(r1?.exit.code, 0, 'the shell gives up when it cannot fork');
    assert.equal(r2?.stdout.text, 'next\n');
    assert.deepEqual(checkTerminationProof(o.proof, { seatUnit: false, records: o.records }), { eligible: true });
  });

  test("unit over its own limit: the whole unit (host included) ends; the proof says so and the attempt is \"resource exceeded\"", async () => {
    const o = await runUnit([{ run: 'r1', command: `${alloc(600)}; echo AFTER`, limits: { memoryMax: 2048 * MiB, pidsMax: 64 } }], {
      memoryMax: 256 * MiB,
      pidsMax: 256,
    });
    assert.equal(o.results, null, 'the host was killed with the unit');
    assert.deepEqual(o.proof.exit, { code: null, signal: 'SIGKILL' });
    assert.ok(o.proof.unitOom >= 1, `unit oom ${o.proof.unitOom}`);
    assert.ok(o.proof.unitOomKill >= 1);
    assert.ok(o.proof.controlOomKill >= 1, 'the control layer died with the unit');
    const v = checkTerminationProof(o.proof, { seatUnit: false, records: o.records });
    assert.equal(v.eligible, false);
    if (!v.eligible) assert.equal(v.outcome, 'resource-exceeded');
  });

  test("an ancestor's limit: unit oom stays 0 but oom_kill > 0, so the attempt is an environment failure", async () => {
    const o = await runUnit(
      [{ run: 'r1', command: `${alloc(1024)}; echo AFTER`, limits: { memoryMax: 4096 * MiB, pidsMax: 64 } }],
      { memoryMax: 4096 * MiB, pidsMax: 256 },
      ['MemoryMax=384M', 'MemorySwapMax=0'],
      true,
    );
    assert.ok((o.diagnostics?.serviceOom ?? 0) >= 1, "the ancestor's (the service's) own limit fired");
    assert.equal(o.proof.unitOom, 0, "the unit's own limit was not hit");
    assert.ok(o.proof.unitOomKill >= 1, `but the unit was killed (oom_kill ${o.proof.unitOomKill})`);
    assert.ok(o.proof.controlOomKill >= 1, 'memory.oom.group took the control layer too');
    const v = checkTerminationProof(o.proof, { seatUnit: false, records: o.records });
    assert.equal(v.eligible, false);
    if (!v.eligible) assert.equal(v.outcome, 'environment-failure');
  });

  test('a stop ends the host, its sandbox and the running command before the proof is written (14.3: "已停止"只在进程终止、沙箱拆除后)', async () => {
    const marker = `mp-stop-${process.pid}-${Date.now()}`;
    const l = await launchUnit(
      [{ run: 'r1', command: `sh -c 'sleep 30; true ${marker}'`, limits: { memoryMax: 64 * MiB, pidsMax: 64 } }],
      { memoryMax: 512 * MiB, pidsMax: 256 },
      [],
      true,
    );
    // the sandboxed command is visible from the host's pid namespace once it runs
    const deadline = Date.now() + 20_000;
    while (pgrep(marker) === '') {
      assert.ok(Date.now() < deadline, 'the sandboxed command never started');
      await new Promise((r) => setTimeout(r, 50));
    }
    const holder = `mp-holder ${join(l.t, 'session', 'area')}`;
    assert.notEqual(pgrep(holder), '', 'the sandbox holder runs');
    await stopUnit(l.unitName, 60_000);
    const o = await collect(l);
    assert.equal(pgrep(marker), '', 'the running command is gone');
    assert.equal(pgrep(holder), '', 'the sandbox holder is gone');
    assert.equal(pgrep(l.t), '', 'no process of the unit or its supervisor is left');
    assert.equal(o.diagnostics?.stopped, true);
    assert.equal(o.diagnostics?.populatedAtProof, false);
    assert.deepEqual(o.proof.exit, { code: null, signal: 'SIGTERM' });
    assert.equal(o.results, null, 'the host never reported results');
  });
});
