// Design 7.1 large-disk units: the writable area is a preallocated, fixed-size ext4 image
// mounted as the user with fuse2fs, inside the unit's own holder namespaces only. Space is reserved at admission and never grows; writes,
// from inside the sandbox too, stop at the image size; the inode count is fixed; a sparse
// file still counts by logical length at export. fuse2fs is not installed system-wide on
// every machine: the path comes from MP_FUSE2FS, then PATH; without it these tests skip.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { detectExecCapabilities, findFuse2fs } from '../src/exec/platform.ts';
import { ToolSandbox, createDiskImage, hostSystemEnvironment, isMountPoint, unmountDiskImage } from '../src/exec/sandbox.ts';
import { ProgramTools, exportWritable } from '../src/exec/tools.ts';

// The copy extracted (not installed) for the 2026-10-09 probe on the maintainer's machine.
const EXTRACTED = process.env['MP_TEST_FUSE2FS']; // an unpacked fuse2fs for machines without one on PATH
const fuse2fs = findFuse2fs() ?? findFuse2fs(EXTRACTED);
const caps = detectExecCapabilities();
const missing = [
  fuse2fs === null ? 'fuse2fs (set MP_FUSE2FS)' : null,
  caps.mkfsExt4 === null ? 'mkfs.ext4' : null,
  caps.fusermount === null ? 'fusermount' : null,
  !caps.bwrapUsable || caps.nsenter === null ? 'a usable bubblewrap and nsenter' : null,
  existsSync('/dev/fuse') ? null : '/dev/fuse',
].filter((m): m is string => m !== null);
const skip = missing.length === 0 ? false : `needs ${missing.join(', ')}`;

const MiB = 1024 * 1024;
const dirs: string[] = [];
const mounts: string[] = [];
const open: ToolSandbox[] = [];

after(async () => {
  for (const s of open) await s.close().catch(() => undefined);
  for (const m of mounts) if (isMountPoint(m)) await unmountDiskImage(m).catch(() => undefined);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('large-disk units: fixed-size ext4 image through fuse2fs', { skip }, () => {
  test('reserved up front, capped inside the sandbox, inode-capped, sparse files metered by logical length, unmounted at the end', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mp-exec-disk-'));
    dirs.push(root);
    const snap = join(root, 'snap');
    mkdirSync(join(snap, 'build'), { recursive: true });
    writeFileSync(join(snap, 'build', 'seed.txt'), 'seed\n');
    const session = join(root, 'session');
    mkdirSync(session);
    const image = join(root, 'unit.img');
    const mountDir = join(root, 'mnt');
    mkdirSync(mountDir);
    mounts.push(mountDir);

    const { allocatedBytes } = await createDiskImage({ path: image, bytes: 16 * MiB, inodes: 64 });
    assert.ok(allocatedBytes >= 16 * MiB, 'space reserved at admission');

    const sandbox = await ToolSandbox.create(
      {
        snapshotDir: snap,
        writablePaths: ['build'],
        area: { kind: 'image', image, mountDir, fuse2fs: fuse2fs as string },
        environment: hostSystemEnvironment(),
        sessionDir: session,
      },
      { runLayers: null },
    );
    open.push(sandbox);
    assert.equal(isMountPoint(mountDir), false, 'never mounted on the host');
    assert.ok(readFileSync(`/proc/${sandbox.holderPid}/mountinfo`, 'utf8').includes(` ${mountDir} `), 'mounted inside the unit\'s holder namespace');
    assert.ok(sandbox.fusePid !== null);
    const tools = new ProgramTools(sandbox);

    const r = await tools.runCommand({
      command: [
        'cat build/seed.txt',
        'dd if=/dev/zero of=build/big bs=1M count=64 2>&1 | tail -1',
        'rm -f build/big',
        // touch, not ": > file": a failed redirection on a special builtin ends a POSIX shell
        'n=0; while [ $n -lt 200 ] && touch build/f$n 2>/dev/null; do n=$((n+1)); done; echo "files=$n"',
        'rm -f build/f*',
        'truncate -s 1G build/sparse.bin && stat -c %s build/sparse.bin',
      ].join('; '),
    });
    assert.ok(r.ok, JSON.stringify(r));
    const out = r.value.stdout.text;
    assert.ok(out.startsWith('seed\n'), 'pre-filled with the original content');
    assert.match(out, /No space left on device/, 'writes stop at the image size');
    const files = Number(/files=(\d+)/.exec(out)?.[1]);
    assert.ok(files < 200, `inode count capped (created ${files} of 200)`);
    assert.match(out, /1073741824\n$/, 'a 1 GiB sparse file fits in the 16 MiB image');
    assert.ok(statSync(image).blocks * 512 <= 16 * MiB + 64 * 1024, 'the host footprint never grows');

    const dest = join(root, 'export');
    const exp = await exportWritable(sandbox, dest, { maxLogicalBytes: 16 * MiB, maxFiles: 64 });
    assert.equal(exp.ok, false, 'the sparse file counts by its logical length');
    assert.equal(existsSync(dest), false);

    const fusePid = sandbox.fusePid as number;
    await sandbox.close();
    assert.equal(isMountPoint(mountDir), false);
    assert.equal(existsSync(`/proc/${fusePid}/stat`) && !readFileSync(`/proc/${fusePid}/stat`, 'utf8').includes(') Z '), false, 'fuse2fs ended with the sandbox');
  });
});
