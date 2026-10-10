import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  admit,
  baseMargin,
  checkLedgerVolume,
  classifyFsMagic,
  commitGenerationDemands,
  compressBound,
  looseObjectBytes,
  GIB,
  indexAllowance,
  INITIAL_LEDGER_VOLUME_WATCH,
  KIB,
  landingDemands,
  ledgerVolumeThreshold,
  probeFs,
  type FsStats,
  type LedgerReserve,
} from '../src/git/admission.ts';

const BS = 4096;
function fs(id: string, kind: FsStats['kind'], totalGiB: number, availableBytes: number, inodes: number | null = 1_000_000): FsStats {
  return {
    id,
    kind,
    blockSize: BS,
    totalBytes: totalGiB * GIB,
    availableBytes,
    totalInodes: inodes === null ? null : inodes * 2,
    availableInodes: inodes,
  };
}
const NO_RESERVE: LedgerReserve = { recoveryReserveBytes: 0, evaluatorPoolBytes: 0 };

test('filesystem kinds come from statfs magic numbers; anything else is unrecognized', () => {
  assert.equal(classifyFsMagic(0xef53), 'ext4');
  assert.equal(classifyFsMagic(0x58465342), 'xfs');
  assert.equal(classifyFsMagic(0x9123683e), 'btrfs');
  assert.equal(classifyFsMagic(0x01021994), 'unrecognized'); // tmpfs
  assert.equal(classifyFsMagic(0x01021997), 'unrecognized'); // 9p: WSL /mnt drives
  const t = probeFs(tmpdir());
  assert.ok(t.blockSize > 0 && t.totalBytes > 0 && t.availableBytes >= 0);
  if (existsSync('/mnt/d')) {
    const d = probeFs('/mnt/d');
    assert.equal(d.kind, 'unrecognized');
    assert.equal(d.availableInodes, null, 'WSL 9p reports unusable inode counts');
  }
});

test('landing on ext4: exact data rounded to blocks, 2 metadata blocks per new entry plus 64 KiB, measured index x1.5 + 64 KiB, git management blocks', () => {
  const wt = fs('wt', 'ext4', 100, 20 * GIB);
  const repo = fs('repo', 'ext4', 100, 20 * GIB);
  const demands = landingDemands({
    worktree: {
      fs: wt,
      sharesLedgerVolume: false,
      files: [
        ...Array.from({ length: 5 }, () => ({ size: 1000, isNew: true })),
        ...Array.from({ length: 5 }, () => ({ size: 5000, isNew: false })),
      ],
      newDirectories: 2,
    },
    repository: { fs: repo, sharesLedgerVolume: false, measuredIndexBytes: 10_000, updatedRefs: 1, updatedWorktreeHeads: 1 },
  });
  const d = admit(demands, NO_RESERVE);
  const w = d.filesystems.find((f) => f.fsId === 'wt');
  const r = d.filesystems.find((f) => f.fsId === 'repo');
  assert.ok(w && r);
  // 5 x 4096 + 5 x 8192 data; review r2 #6: every written file is a new inode and entry (git unlinks and
  // recreates; the old inode may stay held by another link): 10 files + 2 directories x 2 x 4096; 64 KiB once.
  assert.equal(w.requiredBytes, 5 * 4096 + 5 * 8192 + 12 * 2 * 4096 + 64 * KIB);
  assert.equal(w.inodesRequired, 12);
  assert.equal(indexAllowance(10_000), 15_000 + 64 * KIB);
  // index allowance rounded to blocks + (1 ref x 3 blocks + 1 HEAD log block) + entries for the ref lock, a new
  // reflog, a new HEAD log and 3 log directories (6 x 2 blocks) + 64 KiB.
  assert.equal(r.requiredBytes, Math.ceil((15_000 + 64 * KIB) / BS) * BS + 4 * BS + 6 * 2 * BS + 64 * KIB);
  assert.equal(r.inodesRequired, 1 + 2 + 1 + 3);
  assert.equal(d.ok, true);
  assert.equal(w.marginBytes, 5 * GIB, '5% of 100 GiB beats 1 GiB');
});

test('btrfs uses 4 blocks per new entry, unrecognized filesystems 8, neither adds the 64 KiB', () => {
  for (const [kind, blocks] of [
    ['btrfs', 4],
    ['unrecognized', 8],
    ['xfs', 2],
  ] as const) {
    const wt = fs(`wt-${kind}`, kind, 100, 50 * GIB);
    const d = admit(
      landingDemands({
        worktree: { fs: wt, sharesLedgerVolume: false, files: [{ size: 1, isNew: true }], newDirectories: 3 },
        repository: { fs: fs('repo', 'ext4', 100, 50 * GIB), sharesLedgerVolume: false, measuredIndexBytes: null, updatedRefs: 1, updatedWorktreeHeads: 0 },
      }),
      NO_RESERVE,
    );
    const w = d.filesystems.find((f) => f.fsId === wt.id);
    const extra = kind === 'xfs' ? 64 * KIB : 0;
    assert.equal(w?.requiredBytes, BS + 4 * blocks * BS + extra, kind);
  }
});

test('the same filesystem is admitted once for worktree and repository (v49: nothing is ever downloaded)', () => {
  const one = fs('same', 'ext4', 10, 2 * GIB);
  const d = admit(
    landingDemands({
      worktree: { fs: one, sharesLedgerVolume: false, files: [{ size: 700 * 1024 * 1024, isNew: true }], newDirectories: 0 },
      repository: { fs: one, sharesLedgerVolume: false, measuredIndexBytes: 1000, updatedRefs: 1, updatedWorktreeHeads: 1 },
    }),
    NO_RESERVE,
  );
  assert.equal(d.filesystems.length, 1);
  assert.deepEqual(d.filesystems[0]?.destinations, ['target worktree', 'repository']);
  // 2 GiB available, 1 GiB margin (5% of 10 GiB is smaller), ~700 MiB demand: fits, but leaves less than 2 x margin.
  assert.equal(baseMargin(one), GIB);
  assert.equal(d.ok, true);
  assert.equal(d.filesystems[0]?.remind, true);
  assert.equal(d.reminders.length, 1);
  const tooBig = admit(
    landingDemands({
      worktree: { fs: one, sharesLedgerVolume: false, files: [{ size: 1100 * 1024 * 1024, isNew: true }], newDirectories: 0 },
      repository: { fs: one, sharesLedgerVolume: false, measuredIndexBytes: 1000, updatedRefs: 1, updatedWorktreeHeads: 1 },
    }),
    NO_RESERVE,
  );
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.reasons[0] ?? '', /must leave 1\.00 GiB free/);
});

test('a destination on the ledger volume also keeps the ledger reserve free (6.6 承载账本的卷)', () => {
  const reserve: LedgerReserve = { recoveryReserveBytes: 2 * GIB, evaluatorPoolBytes: 1 * GIB };
  const wt = fs('wsl-d', 'unrecognized', 40, 5 * GIB);
  const input = (shares: boolean) =>
    landingDemands({
      worktree: { fs: wt, sharesLedgerVolume: shares, files: [{ size: 500 * 1024 * 1024, isNew: true }], newDirectories: 0 },
      repository: { fs: wt, sharesLedgerVolume: shares, measuredIndexBytes: 1000, updatedRefs: 1, updatedWorktreeHeads: 1 },
    });
  const apart = admit(input(false), reserve);
  assert.equal(apart.ok, true, '5 GiB - 0.5 GiB >= 2 GiB margin');
  const shared = admit(input(true), reserve);
  assert.equal(shared.ok, false, 'needs margin 2 GiB + reserve 3 GiB');
  assert.equal(shared.filesystems[0]?.marginBytes, 2 * GIB + 3 * GIB);
});

test('inodes: refused when short; skipped when the filesystem does not report them', () => {
  const tight = fs('tight', 'ext4', 100, 50 * GIB, 5);
  const d = admit(
    landingDemands({
      worktree: { fs: tight, sharesLedgerVolume: false, files: Array.from({ length: 6 }, () => ({ size: 1, isNew: true })), newDirectories: 0 },
      repository: { fs: fs('r', 'ext4', 100, 50 * GIB), sharesLedgerVolume: false, measuredIndexBytes: null, updatedRefs: 1, updatedWorktreeHeads: 0 },
    }),
    NO_RESERVE,
  );
  assert.equal(d.ok, false);
  assert.match(d.reasons.join(' '), /needs 6 inodes, 5 available/);
  const unknown = fs('9p', 'unrecognized', 100, 50 * GIB, null);
  const u = admit(
    landingDemands({
      worktree: { fs: unknown, sharesLedgerVolume: false, files: Array.from({ length: 6 }, () => ({ size: 1, isNew: true })), newDirectories: 0 },
      repository: { fs: fs('r', 'ext4', 100, 50 * GIB), sharesLedgerVolume: false, measuredIndexBytes: null, updatedRefs: 1, updatedWorktreeHeads: 0 },
    }),
    NO_RESERVE,
  );
  assert.equal(u.ok, true);
});

test('commit generation (6.5 v34): loose objects at zlib compressBound of header + content, block-rounded; LFS twice unless hard-linked; temp files', () => {
  assert.equal(compressBound(0), 13);
  assert.equal(compressBound(1_000_000), 1_000_000 + 244 + 61 + 0 + 13);
  // "blob 10\0" is 8 bytes: n = 18, bound 31, one block.
  assert.equal(looseObjectBytes('blob', 10, BS), BS);
  // An incompressible 4096-byte blob grows past one block: n = 4096 + 10, bound 4120 -> two blocks.
  assert.equal(looseObjectBytes('blob', 4096, BS), 2 * BS);
  const objs = fs('objs', 'ext4', 100, 50 * GIB);
  const lfs = fs('lfs', 'ext4', 100, 50 * GIB);
  const tmp = fs('tmp', 'unrecognized', 8, 6 * GIB);
  const d = admit(
    commitGenerationDemands({
      objects: {
        fs: objs,
        sharesLedgerVolume: false,
        newObjects: [
          { type: 'blob', size: 10 },
          { type: 'blob', size: 5000 },
          { type: 'tree', size: 300 },
        ],
      },
      lfs: { fs: lfs, sharesLedgerVolume: false, newObjects: [{ size: 10_000, hardlinked: false }, { size: 99_999, hardlinked: true }] },
      temp: { fs: tmp, sharesLedgerVolume: false, fileSizes: [100, 5000] },
    }),
    NO_RESERVE,
  );
  const by = (id: string) => d.filesystems.find((f) => f.fsId === id);
  // data 4 blocks; review r2 #6: 3 objects + up to 3 new fan-out directories (one block each), 6 entries x 2 blocks + 64 KiB.
  assert.equal(by('objs')?.requiredBytes, BS + 2 * BS + BS + 3 * BS + 6 * 2 * BS + 64 * KIB);
  assert.equal(by('objs')?.inodesRequired, 6);
  assert.equal(by('lfs')?.requiredBytes, 2 * 12_288);
  assert.equal(by('tmp')?.requiredBytes, BS + 2 * BS);
  assert.equal(d.ok, true);
});

test('space reminders (6.6 空间提醒): once when the ledger volume drops below the threshold, again only after it recovered', () => {
  const reserve: LedgerReserve = { recoveryReserveBytes: GIB, evaluatorPoolBytes: GIB };
  const at = (avail: number) => fs('ledger', 'ext4', 100, avail);
  const threshold = ledgerVolumeThreshold(at(0), reserve);
  assert.equal(threshold, 2 * GIB + 2 * 5 * GIB);
  let w = INITIAL_LEDGER_VOLUME_WATCH;
  let r = checkLedgerVolume(at(threshold + 1), reserve, w);
  assert.equal(r.reminder, null);
  r = checkLedgerVolume(at(threshold - 1), reserve, r.watch);
  assert.match(r.reminder ?? '', /may affect the ledger and automatic landing/);
  r = checkLedgerVolume(at(threshold - 100), reserve, r.watch);
  assert.equal(r.reminder, null, 'no repeat while still low');
  r = checkLedgerVolume(at(threshold + 100), reserve, r.watch);
  w = r.watch;
  assert.equal(w.armed, true);
  r = checkLedgerVolume(at(threshold - 1), reserve, w);
  assert.notEqual(r.reminder, null, 'reminds again after recovering and dropping');
});

test('review r2 #6: replaced files count as new inodes (their old inodes may stay held by other links); new objects count their fan-out directories', () => {
  const stats = fs('tight', 'ext4', 20, 10 * GIB);
  const tight = { ...stats, availableInodes: 2 };
  // Ten existing files replaced: git creates ten new inodes; ten hard links elsewhere keep the old ones alive.
  const d = admit(
    landingDemands({
      worktree: { fs: tight, sharesLedgerVolume: false, files: Array.from({ length: 10 }, () => ({ size: 6, isNew: false })), newDirectories: 0 },
      repository: { fs: tight, sharesLedgerVolume: false, measuredIndexBytes: 1000, updatedRefs: 1, updatedWorktreeHeads: 1 },
    }),
    NO_RESERVE,
  );
  assert.equal(d.ok, false, 'two free inodes cannot hold ten new files');
  assert.ok((d.filesystems[0]?.inodesRequired ?? 0) >= 10 + 1 + 2 + 1);
  // One new loose object: the object file and possibly its objects/<xx> directory.
  const o = commitGenerationDemands({ objects: { fs: tight, sharesLedgerVolume: false, newObjects: [{ type: 'blob', size: 20 }] }, lfs: null, temp: null });
  assert.equal(o[0]?.inodes, 2);
});
