// Large-disk images belong to their unit alone (design 7.1, 6.4, 6.5; follow-up to code review
// r1 finding 2). Observed: a sandbox holder binds the host's "/" into its own mount namespace,
// so a holder started while another unit's image was FUSE-mounted ON THE HOST kept a copy of
// that mount; after the host unmounted it, fuse2fs (and the image's disk space) stayed held
// until that holder ended. Fixed: a unit's image is mounted only inside that unit's holder
// namespaces (src/exec/holder.ts), so no host, holder or sandbox of another unit ever sees or
// pins it; the image is free as soon as its own unit ends.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { id, type LaunchId } from '../src/common/ids.ts';
import { completeCleanup, identityAt, processesHolding, recordIdentities, scanCleanupFiles } from '../src/exec/cleanup.ts';
import { AreaHolder } from '../src/exec/holder.ts';
import { detectExecCapabilities, findFuse2fs, findTool } from '../src/exec/platform.ts';
import { RUN_HOST_JOB_FORMAT, RUN_HOST_MAIN, type RunHostJob } from '../src/exec/run-host.ts';
import { ToolSandbox, createDiskImage, hostSystemEnvironment, isMountPoint, mountDiskImage, probePrivateImageMount, unmountDiskImage } from '../src/exec/sandbox.ts';
import { planUnitArea } from '../src/exec/resources.ts';
import { killUnit, launchUnitSupervisor, unitActiveState, waitUnitInactive } from '../src/exec/supervisor.ts';
import { ProgramTools } from '../src/exec/tools.ts';

const EXTRACTED_FUSE2FS = process.env['MP_TEST_FUSE2FS']; // an unpacked fuse2fs for machines without one on PATH
const fuse2fs = findFuse2fs() ?? findFuse2fs(EXTRACTED_FUSE2FS);
const caps = detectExecCapabilities();
const missing = [
  fuse2fs === null ? 'fuse2fs' : null,
  existsSync('/dev/fuse') ? null : '/dev/fuse',
  !caps.bwrapUsable || caps.nsenter === null ? 'bubblewrap and nsenter' : null,
].filter((m): m is string => m !== null);
const skip = missing.length === 0 ? false : `needs ${missing.join(', ')}`;
const unitsOk = caps.systemdRun !== null && caps.delegatedControllers.includes('memory') && caps.delegatedControllers.includes('pids');

const MiB = 1024 * 1024;
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
const units: string[] = [];
const hostMounts: string[] = [];
function tmp(prefix = 'mp-image-iso-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
let sinkModule = '';
before(() => {
  sinkModule = join(tmp('mp-image-iso-sink-'), 'sink.mjs');
  writeFileSync(sinkModule, "export function createProofSink() { return { async submit(p) { return { kind: 'registered', ack: 'ack:' + p.launch, duplicate: false }; } }; }\n");
});
after(async () => {
  for (const c of closers.reverse()) await c().catch(() => undefined);
  for (const u of units) await killUnit(u);
  for (const m of hostMounts) if (isMountPoint(m)) await unmountDiskImage(m).catch(() => undefined);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function image(d: string): Promise<{ image: string; mountDir: string }> {
  const img = join(d, 'unit.img');
  const mountDir = join(d, 'mnt');
  mkdirSync(mountDir);
  await createDiskImage({ path: img, bytes: 16 * MiB, inodes: 64 });
  return { image: img, mountDir };
}

const mountedIn = (pid: number, dir: string): boolean => readFileSync(`/proc/${pid}/mountinfo`, 'utf8').includes(` ${dir} `);

/** A plain holder like every sandbox's (binds the host's "/"), standing for another unit. */
async function otherUnitsHolder(): Promise<AreaHolder> {
  const d = tmp();
  const h = await AreaHolder.start({
    base: join(d, 'area'),
    tmpfs: [{ at: '.', bytes: 1 * MiB }],
    steps: [],
    bwrap: findTool('bwrap') as string,
    nsenter: findTool('nsenter') as string,
  });
  closers.push(() => h.close());
  return h;
}

describe('a unit\'s disk image is mounted in its own namespaces only', { skip }, () => {
  test('the observation: an image FUSE-mounted on the host is pinned by another holder after the host unmounts it', async () => {
    const d = tmp();
    const { image: img, mountDir } = await image(d);
    hostMounts.push(mountDir);
    await mountDiskImage(img, mountDir, fuse2fs as string);
    const other = await otherUnitsHolder(); // started while the image is mounted on the host
    assert.ok(mountedIn(other.pid, mountDir), 'the other holder copied the host mount');
    await unmountDiskImage(mountDir);
    assert.equal(isMountPoint(mountDir), false);
    const id = identityAt(img, [d]);
    assert.ok(id !== null);
    const bound = recordIdentities([`image:${img}`], { roots: [d] });
    await new Promise((r) => setTimeout(r, 1_500));
    assert.ok(processesHolding(id).length > 0, 'fuse2fs still holds the image');
    assert.deepEqual(await completeCleanup(bound, { roots: [d], holderWaitMs: 200 }), bound, 'cleanup can only keep it pending');
    await other.close();
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(await completeCleanup(bound, { roots: [d] }), [], 'released only when the other holder ended');
  });

  test('the fix: another unit\'s holder started while the image is in use never sees it; the image is free as soon as its unit ends', async () => {
    const d = tmp();
    const { image: img, mountDir } = await image(d);
    const bound = recordIdentities([`mount:${mountDir}`, `image:${img}`], { roots: [d] }); // as the unit's supervisor does at its start
    const snap = join(d, 'snap');
    mkdirSync(join(snap, 'out'), { recursive: true });
    mkdirSync(join(d, 'session'));
    const unitA = await ToolSandbox.create(
      { snapshotDir: snap, writablePaths: ['out'], area: { kind: 'image', image: img, mountDir, fuse2fs: fuse2fs as string }, environment: hostSystemEnvironment(), sessionDir: join(d, 'session') },
      { runLayers: null },
    );
    closers.push(() => unitA.close());
    const w = await new ProgramTools(unitA).runCommand({ command: 'echo data > out/f; stat -f -c "FS=%T" out' });
    assert.ok(w.ok && /FS=fuse/.test(w.value.stdout.text), JSON.stringify(w));
    assert.equal(isMountPoint(mountDir), false, 'not on the host');
    assert.ok(mountedIn(unitA.holderPid, mountDir), 'only in the unit\'s own holder');
    const other = await otherUnitsHolder(); // another unit starts while the image is mounted
    assert.equal(mountedIn(other.pid, mountDir), false, 'the other unit cannot see it, so cannot pin it');
    const id = identityAt(img, [d]);
    assert.ok(id !== null);
    const t0 = Date.now();
    await unitA.close();
    assert.deepEqual(processesHolding(id), [], 'nothing holds the image once its unit has ended');
    assert.deepEqual(await completeCleanup(bound, { roots: [d], holderWaitMs: 0 }), [], 'cleanup completes at once');
    assert.ok(Date.now() - t0 < 10_000, `promptly (${Date.now() - t0} ms)`);
    assert.equal(existsSync(img), false);
    assert.ok(other.alive, 'while the other unit is still running');
  });

  test('two real units: the second starts while the first runs on its image; the first\'s cleanup completes while the second still runs', { skip: unitsOk ? false : 'needs systemd-run --user with delegated controllers' }, async () => {
    const launchUnit = async (n: number, area: RunHostJob['sandbox']['area'], command: string, cleanup?: { fuseMounts: string[]; images: string[] }) => {
      const t = tmp(`mp-image-iso-unit${n}-`);
      const snap = join(t, 'snap');
      mkdirSync(join(snap, 'out'), { recursive: true });
      mkdirSync(join(t, 'session'));
      const launch = id<LaunchId>(`launch-image-iso-${process.pid}-${n}`);
      const job: RunHostJob = {
        format: RUN_HOST_JOB_FORMAT,
        launch,
        sandbox: { snapshotDir: snap, writablePaths: ['out'], area, environment: hostSystemEnvironment(), sessionDir: join(t, 'session') },
        runs: [{ run: 'run-1', command, limits: { memoryMax: 128 * MiB, pidsMax: 64 }, timeoutMs: 60_000 }],
        recordsPath: join(t, 'records.jsonl'),
        resultsPath: join(t, 'results.json'),
      };
      writeFileSync(join(t, 'job.json'), JSON.stringify(job));
      const unitName = `mp-exec-test-image-iso-${process.pid}-${n}.service`;
      units.push(unitName);
      await launchUnitSupervisor({
        config: {
          launch,
          stateDir: t,
          host: { argv: [process.execPath, '--experimental-strip-types', '--disable-warning=ExperimentalWarning', RUN_HOST_MAIN, join(t, 'job.json')], env: { PATH: '/usr/bin:/bin' }, cwd: t, stderrPath: join(t, 'host.err') },
          unit: { memoryMax: 512 * MiB, pidsMax: 256 },
          sink: { module: sinkModule },
          retry: { initialDelayMs: 10, maxDelayMs: 10, totalMs: 0 },
          ...(cleanup !== undefined ? { cleanup } : {}),
        },
        unitName,
        logPath: join(t, 'supervisor.log'),
      });
      return { t, launch, unitName, job };
    };
    const d = tmp();
    const { image: img, mountDir } = await image(d);
    const first = await launchUnit(1, { kind: 'image', image: img, mountDir, fuse2fs: fuse2fs as string }, 'echo data > out/f; sleep 3', { fuseMounts: [mountDir], images: [img] });
    // the second unit starts while the first one's image is mounted (its sandbox holder binds "/")
    for (let i = 0; i < 100 && !existsSync(join(first.t, 'session')); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 1_500));
    const second = await launchUnit(2, { kind: 'tmpfs', bytes: 4 * MiB }, 'sleep 12');
    assert.ok(await waitUnitInactive(first.unitName, 60_000), readFileSync(join(first.t, 'supervisor.log'), 'utf8'));
    const results = JSON.parse(readFileSync(first.job.resultsPath, 'utf8')) as { status: string }[];
    assert.equal(results[0]?.status, 'completed', readFileSync(join(first.t, 'host.err'), 'utf8'));
    const state = scanCleanupFiles(first.t).find((f) => f.launch === first.launch);
    assert.equal(state?.state, 'done', `the first unit's cleanup: ${JSON.stringify(state)}`);
    assert.deepEqual(state?.resources, []);
    assert.equal(existsSync(img), false, 'the image is deleted');
    assert.equal(await unitActiveState(second.unitName), 'active', 'while the second unit is still running');
    assert.ok(await waitUnitInactive(second.unitName, 60_000));
  });

  test('the capability probe mounts an image the way units do; admission blocks large-disk units where it fails', async () => {
    const probe = await probePrivateImageMount(fuse2fs as string);
    assert.deepEqual(probe, { ok: true, detail: 'fuse2fs mounts inside a private user namespace' });
    const broken = await probePrivateImageMount('/bin/false');
    assert.equal(broken.ok, false);
    const big = { hostBytes: 64 * MiB, runPeakBytes: 64 * MiB, runParallelism: 1, areaBytes: 1024 * MiB, enclosureBytes: 0, exportCaps: { maxLogicalBytes: MiB, maxFiles: 10 }, recoveryState: null };
    const tools = { fuse2fs: fuse2fs as string, mkfsExt4: '/sbin/mkfs.ext4', fallocate: '/usr/bin/fallocate', fusermount: '/usr/bin/fusermount3', fuseDevice: true };
    assert.equal(planUnitArea(big, { ...tools, privateFuseMount: true }).kind, 'image');
    const blocked = planUnitArea(big, { ...tools, privateFuseMount: false });
    assert.ok(blocked.kind === 'resource-blocked' && blocked.missing.includes('FUSE mounts inside a private user namespace'));
  });
});
