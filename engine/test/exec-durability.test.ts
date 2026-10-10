// Code review r1 finding 12 (design 7.1 "证明……安全落盘之后才删除", 6.3 证明对账入口, §14 item 9
// fault injection): a proof is safe on disk only when every directory entry leading to it is
// durable. The chain is created and synced (each new directory and its parent) before the unit
// runs; the proof file is written tmp -> fsync -> rename -> directory fsync; and a supervisor
// killed before any of those steps leaves either the complete proof or nothing that counts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { id, type LaunchId } from '../src/common/ids.ts';
import type { TerminationProofRecord } from '../src/common/records.ts';
import { ensureDirChainDurable, type DurableOps, type DurableStep } from '../src/exec/durable.ts';
import { detectExecCapabilities } from '../src/exec/platform.ts';
import { MemoryProofLedger, PROOF_FILE_FORMAT, proofFilePath, proofsDir, resubmitProofFile, scanProofFiles, writeProofFile, type ProofFile } from '../src/exec/proof.ts';
import { isProcessAlive, killUnit, launchUnitSupervisor, prepareStateDirs, readSupervisorIdentity, waitUnitInactive } from '../src/exec/supervisor.ts';

const PROOF_TS = fileURLToPath(new URL('../src/exec/proof.ts', import.meta.url));
const DURABLE_TS = fileURLToPath(new URL('../src/exec/durable.ts', import.meta.url));
const caps = detectExecCapabilities();
const systemdOk = caps.systemdRun !== null && caps.delegatedControllers.includes('memory') && caps.delegatedControllers.includes('pids');

const dirs: string[] = [];
const units: string[] = [];
function tmp(prefix = 'mp-durability-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
let sinkModule = '';
before(() => {
  const d = tmp('mp-durability-sink-');
  sinkModule = join(d, 'sink.mjs');
  writeFileSync(sinkModule, "export function createProofSink() { return { async submit() { return { kind: 'unavailable', detail: 'test' }; } }; }\n");
});
after(async () => {
  for (const u of units) await killUnit(u);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function recorder(): { ops: DurableOps; log: string[] } {
  const log: string[] = [];
  return {
    log,
    ops: {
      mkdir: (d) => {
        mkdirSync(d);
        log.push(`mkdir ${d}`);
      },
      fsyncDir: (d) => log.push(`fsync ${d}`),
      before: (step, p) => log.push(`${step} ${p}`),
    },
  };
}

function proofFileFor(launch: LaunchId): ProofFile {
  const proof: TerminationProofRecord = { kind: 'termination.proof', launch, exit: { code: 0, signal: null }, controlOomKill: 0, unitOomKill: 0, unitOom: 0 };
  return {
    format: PROOF_FILE_FORMAT,
    status: 'pending',
    proof,
    writtenAt: new Date().toISOString(),
    supervisor: { pid: process.pid, bootId: 'b' },
    diagnostics: { hostStarted: true, spawnError: null, hostExitedAt: 'x', unitEmptyAt: 'y', leftoversKilled: false, populatedAtProof: false, stopped: false, serviceOom: 0 },
    rejection: null,
  };
}

describe('the directory chain is durable before the proof is', () => {
  test('a first proof in a fresh state directory: proofs/ and its parent are synced before the rename', () => {
    const state = join(tmp(), 'state');
    const { ops, log } = recorder();
    const launch = id<LaunchId>('L-chain');
    writeProofFile(state, proofFileFor(launch), ops);
    const at = (line: string): number => {
      const i = log.indexOf(line);
      assert.ok(i >= 0, `${line} missing from\n${log.join('\n')}`);
      return i;
    };
    const rename = at(`rename ${proofFilePath(state, launch)}`);
    assert.ok(at(`mkdir ${state}`) < at(`mkdir ${proofsDir(state)}`));
    assert.ok(at(`fsync ${state}`) < rename, 'the state directory holds the new proofs/ entry durably');
    assert.ok(log.indexOf(`fsync ${proofsDir(state)}`) < rename);
    assert.ok(at(`fsync ${dirname(state)}`) < rename, 'the parent of a new state directory is synced too');
    assert.ok(log.lastIndexOf(`fsync ${proofsDir(state)}`) > rename, 'and the proof name after the rename');
  });

  test('every level is synced with its parent even when it already existed; a non-directory refuses', () => {
    const root = tmp();
    mkdirSync(join(root, 's', 'proofs'), { recursive: true });
    const { ops, log } = recorder();
    ensureDirChainDurable(join(root, 's', 'proofs'), join(root, 's'), ops);
    assert.deepEqual(log, [`fsync ${root}`, `fsync ${join(root, 's')}`, `fsync ${join(root, 's')}`, `fsync ${join(root, 's', 'proofs')}`]);
    writeFileSync(join(root, 's', 'cleanup'), 'x');
    assert.throws(() => ensureDirChainDurable(join(root, 's', 'cleanup'), join(root, 's'), ops), /not a directory/);
  });

  test('the supervisor prepares proofs/, cleanup/, supervisors/ and units/<launch> before the unit runs', () => {
    const state = join(tmp(), 'state');
    const { ops, log } = recorder();
    assert.deepEqual(prepareStateDirs(state, id<LaunchId>('L-prep'), ops), []);
    for (const d of ['proofs', 'cleanup', 'supervisors', join('units', 'L-prep')]) {
      assert.ok(existsSync(join(state, d)), d);
      assert.ok(log.includes(`fsync ${join(state, d)}`), `${d} synced`);
    }
  });
});

/** Runs writeProofFile in a child that SIGKILLs itself right before `step`. */
function dieWriting(state: string, launch: LaunchId, step: DurableStep): number | null {
  const script = `
    const proof = await import(${JSON.stringify(`file://${PROOF_TS}`)});
    const durable = await import(${JSON.stringify(`file://${DURABLE_TS}`)});
    const [state, file, step] = JSON.parse(process.argv[1]);
    proof.writeProofFile(state, file, durable.opsWithFault({ dieBefore: step, file: file.proof.launch + '.json' }));
    console.log('survived');`;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script, JSON.stringify([state, proofFileFor(launch), step])], {
    encoding: 'utf8',
  });
  assert.equal(r.stdout.includes('survived'), false, r.stderr);
  return r.status;
}

describe('§14 item 9: the supervisor dies at each step of writing its proof', () => {
  const cases: [DurableStep, 'nothing' | 'complete'][] = [
    ['temp-write', 'nothing'],
    ['temp-fsync', 'nothing'],
    ['rename', 'nothing'],
    ['dir-sync', 'complete'],
  ];
  for (const [step, want] of cases) {
    test(`killed before ${step}: ${want === 'complete' ? 'the complete proof is found and submitted' : 'no proof counts; a temporary file is ignored'}`, async () => {
      const state = tmp();
      const launch = id<LaunchId>(`L-die-${step}`);
      dieWriting(state, launch, step);
      const scan = scanProofFiles(state);
      assert.deepEqual(scan.malformed, [], 'never a torn proof');
      if (want === 'nothing') {
        assert.equal(scan.pending.length, 0);
        assert.equal(existsSync(proofFilePath(state, launch)), false);
      } else {
        assert.equal(scan.pending.length, 1);
        const ledger = new MemoryProofLedger({ knownLaunches: [launch] });
        assert.equal((await resubmitProofFile(scan.pending[0]!, ledger)).kind, 'registered', 'the reconciliation entry submits it (6.3)');
        assert.deepEqual(ledger.get(launch)?.exit, { code: 0, signal: null });
      }
    });
  }

  for (const step of ['temp-write', 'rename', 'dir-sync'] as const) {
    test(`a real unit supervisor killed before ${step} of its proof write`, { skip: systemdOk ? false : 'needs systemd-run --user with delegated controllers' }, async () => {
      const state = tmp();
      const launch = id<LaunchId>(`launch-durable-${process.pid}-${step}`);
      const unitName = `mp-exec-test-durable-${process.pid}-${step}.service`;
      units.push(unitName);
      await launchUnitSupervisor({
        config: {
          launch,
          stateDir: state,
          host: { argv: ['/bin/sh', '-c', 'exit 3'], env: { PATH: '/usr/bin:/bin' }, cwd: state },
          unit: { memoryMax: 64 * 1024 * 1024, pidsMax: 32 },
          sink: { module: sinkModule },
          retry: { initialDelayMs: 10, maxDelayMs: 10, totalMs: 0 },
          testFaults: { proofWrite: step },
        },
        unitName,
        logPath: join(state, 'supervisor.log'),
      });
      assert.ok(await waitUnitInactive(unitName, 30_000));
      const ident = readSupervisorIdentity(state, launch);
      assert.ok(ident !== null);
      assert.equal(isProcessAlive(ident), false, '6.3 entry step 1: the supervisor is gone');
      const scan = scanProofFiles(state);
      assert.deepEqual(scan.malformed, []);
      if (step === 'dir-sync') {
        assert.equal(scan.pending.length, 1, 'renamed before the death: the proof is there');
        assert.deepEqual(scan.pending[0]?.file.proof.exit, { code: 3, signal: null });
      } else {
        assert.equal(scan.pending.length, 0, 'died before the rename: no proof; the attempt is decided without one');
        if (step === 'rename') assert.ok(readdirSync(proofsDir(state)).some((n) => n.startsWith('.')), 'only a temporary file, which counts for nothing');
      }
      // the unit cgroup was not deleted before the proof was safe
      const cleanup = readdirSync(join(state, 'cleanup'));
      assert.ok(cleanup.includes(`${launch}.json`), 'the identity-bound resource list was kept from the start');
    });
  }
});
