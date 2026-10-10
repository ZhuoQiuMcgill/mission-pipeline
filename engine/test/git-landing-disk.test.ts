// §14 item 7, disk admission: "actual usage never exceeds the admitted amount",
// measured on a real ext4 filesystem (an image mounted unprivileged with
// fuse2fs). Usage is read from the superblock with dumpe2fs after unmounting,
// before and after one landing, and compared with the admission the landing
// computed (6.6: exact materialized sizes, 2 metadata blocks per new entry plus
// 64 KiB on ext4, the measured index x1.5 + 64 KiB, git management blocks).
// Scenarios that fit one machine: CRLF expansion, many new directories, many
// long names in one directory. (Large LFS objects need git-lfs; two physical
// disks need a second disk.)

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { id, type GitOid, type OpId } from '../src/common/ids.ts';
import { GIB, type FsStats } from '../src/git/admission.ts';
import { land, MemoryLandingJournal } from '../src/git/landing.ts';
import { discoverRepo } from '../src/git/objects.ts';
import { createProgramRef, deliveryRef } from '../src/git/refs.ts';
import { readTransformDescription } from '../src/git/representation.ts';
import { makeFixture, rawCommit, type FileSpec, type Fixture } from './git-fixtures.test.ts';
import { MISSION } from './delivery-fixtures.test.ts';

const FUSE2FS = process.env.MP_FUSE2FS ?? ['/usr/bin/fuse2fs', '/usr/sbin/fuse2fs', '/sbin/fuse2fs'].find((p) => existsSync(p)) ?? null;
const DUMPE2FS = ['/usr/sbin/dumpe2fs', '/sbin/dumpe2fs'].find((p) => existsSync(p)) ?? null;
const MKFS = ['/usr/sbin/mkfs.ext4', '/sbin/mkfs.ext4'].find((p) => existsSync(p)) ?? null;
const SKIP =
  FUSE2FS === null || DUMPE2FS === null || MKFS === null || !existsSync('/dev/fuse')
    ? 'needs fuse2fs (set MP_FUSE2FS to its path), dumpe2fs, mkfs.ext4 and /dev/fuse'
    : false;

let fx: Fixture;
before(() => {
  fx = makeFixture('landing-disk');
});
after(() => fx.cleanup());

function superblock(image: string): { freeBlocks: number; freeInodes: number; blockSize: number } {
  const out = execFileSync(DUMPE2FS as string, ['-h', image], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const num = (k: string): number => Number((new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(out) as RegExpExecArray)[1]);
  return { freeBlocks: num('Free blocks'), freeInodes: num('Free inodes'), blockSize: num('Block size') };
}

function mount(image: string, dir: string): void {
  const r = spawnSync(FUSE2FS as string, [image, dir, '-o', 'fakeroot'], { stdio: 'pipe' });
  assert.equal(r.status, 0, r.stderr.toString());
}

function unmount(dir: string): void {
  const r = spawnSync('fusermount', ['-u', dir], { stdio: 'pipe' });
  assert.equal(r.status, 0, r.stderr.toString());
}

const BASE: Record<string, FileSpec> = { '.gitattributes': '*.txt eol=crlf\n', 'f.txt': 'one\n' };

const SCENARIOS: readonly { readonly name: string; readonly files: () => Record<string, FileSpec> }[] = [
  {
    name: 'CRLF expansion: a large LF text on an eol=crlf path',
    files: () => ({ ...BASE, 'big.txt': Array.from({ length: 150_000 }, (_, i) => `line ${i}`).join('\n') + '\n' }),
  },
  {
    name: 'many new directories: 1500 files, each in a new directory',
    files: () => {
      const f: Record<string, FileSpec> = { ...BASE };
      for (let i = 0; i < 1500; i++) f[`tree/${String(i).padStart(4, '0')}/leaf.md`] = `${i}\n`;
      return f;
    },
  },
  {
    name: 'many long names in one directory: 1500 files with 200-character names',
    files: () => {
      const f: Record<string, FileSpec> = { ...BASE };
      for (let i = 0; i < 1500; i++) f[`long/${String(i).padStart(6, '0')}${'n'.repeat(194)}`] = `${i}\n`;
      return f;
    },
  },
];

test('ext4 disk admission: measured usage of a landing never exceeds what admission counted (14 item 7)', { skip: SKIP }, async (t) => {
  let k = 0;
  for (const sc of SCENARIOS) {
    const dir = join(fx.root, `fs${k}`);
    const image = join(fx.root, `fs${k}.img`);
    k++;
    execFileSync('truncate', ['-s', '512M', image]);
    execFileSync(MKFS as string, ['-q', '-F', '-b', '4096', '-N', '65536', image]);
    mkdirSync(dir);
    mount(image, dir);
    let mounted = true;
    try {
      const repo = join(dir, 'r');
      fx.raw(['init', '-q', '-b', 'main', repo], fx.root);
      const A = rawCommit(fx, repo, BASE, null, 'A');
      fx.raw(['update-ref', 'refs/heads/main', A], repo);
      fx.raw(['-c', 'core.hooksPath=/dev/null', 'reset', '-q', '--hard', A], repo);
      const B = rawCommit(fx, repo, sc.files(), A, 'B');
      const layout = await discoverRepo(fx.git, repo);
      const op = id<OpId>(`disk-${k}`);
      assert.equal((await createProgramRef(fx.git, layout, deliveryRef(MISSION, op), B)).kind, 'created');
      const d = await readTransformDescription(fx.git, layout, fx.user);

      unmount(dir);
      mounted = false;
      const before = superblock(image);
      mount(image, dir);
      mounted = true;

      // Admission sees the real ext4 block size and kind, and enough space to proceed.
      const stats: FsStats = { id: 'ext4-image', kind: 'ext4', blockSize: before.blockSize, totalBytes: 1000 * GIB, availableBytes: 500 * GIB, totalInodes: 10_000_000, availableInodes: 5_000_000 };
      const rep = await land(
        {
          key: { mission: MISSION, op },
          repoPath: repo,
          targetBranch: 'main',
          base: A as GitOid,
          delivery: B as GitOid,
          description: d,
          user: fx.user,
          ledger: { reserve: { recoveryReserveBytes: 0, evaluatorPoolBytes: 0 }, sharesVolume: () => false },
        },
        { git: fx.git, journal: new MemoryLandingJournal(), scratchDir: fx.root, fsProbe: () => stats },
      );
      assert.equal(rep.kind, 'checked', JSON.stringify(rep));
      if (rep.kind !== 'checked' || rep.admission === null) return;
      assert.equal(rep.verification.overall, 'expected');
      assert.equal(rep.verification.landed, true);

      unmount(dir);
      mounted = false;
      const afterSb = superblock(image);
      const usedBytes = (before.freeBlocks - afterSb.freeBlocks) * before.blockSize;
      const usedInodes = before.freeInodes - afterSb.freeInodes;
      const admitted = rep.admission.filesystems.find((f) => f.fsId === 'ext4-image');
      assert.ok(admitted !== undefined);
      t.diagnostic(`${sc.name}: used ${usedBytes} B / admitted ${admitted.requiredBytes} B; inodes used ${usedInodes} / admitted ${admitted.inodesRequired}`);
      assert.ok(usedBytes <= admitted.requiredBytes, `${sc.name}: used ${usedBytes} > admitted ${admitted.requiredBytes}`);
      assert.ok(usedInodes <= admitted.inodesRequired, `${sc.name}: inodes ${usedInodes} > admitted ${admitted.inodesRequired}`);
      assert.ok(usedBytes > 0, 'the landing wrote something');
    } finally {
      if (mounted) spawnSync('fusermount', ['-u', dir]);
    }
  }
});
