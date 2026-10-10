// Disk admission per write destination, and space reminders.
//   6.6 "落地前的磁盘准入，按写入目的地分别计算" and "空间提醒"
//   6.5 "生成提交也是一处写入，单独准入"
//   13 risk 25 (unrecognized filesystems: 8 blocks per new entry, accepted)
//
// Everything here is a pure function of sizes and filesystem statistics, except
// probeFs(), which reads the statistics of a real path. Tests inject FsStats.

import { statfsSync, statSync } from 'node:fs';

export const KIB = 1024;
export const MIB = 1024 * KIB;
export const GIB = 1024 * MIB;

export type FsKind = 'ext4' | 'xfs' | 'btrfs' | 'unrecognized';

const MAGIC_EXT = 0xef53; // ext2, ext3 and ext4 share it
const MAGIC_XFS = 0x58465342;
const MAGIC_BTRFS = 0x9123683e;

export function classifyFsMagic(type: number): FsKind {
  switch (type >>> 0) {
    case MAGIC_EXT:
      return 'ext4';
    case MAGIC_XFS:
      return 'xfs';
    case MAGIC_BTRFS:
      return 'btrfs';
    default:
      return 'unrecognized';
  }
}

export interface FsStats {
  /** Identity of the filesystem (st_dev). Equal ids are the same filesystem and are admitted together. */
  readonly id: string;
  readonly kind: FsKind;
  readonly blockSize: number;
  readonly totalBytes: number;
  /** Space available to an unprivileged writer. */
  readonly availableBytes: number;
  /** Null when the filesystem reports no usable inode counts (btrfs, 9p/drvfs under WSL). */
  readonly totalInodes: number | null;
  readonly availableInodes: number | null;
}

export type FsProbe = (path: string) => FsStats;

export const probeFs: FsProbe = (path) => {
  const s = statfsSync(path);
  const dev = statSync(path).dev;
  // btrfs reports 0 inodes; WSL's 9p mounts report more free inodes than total.
  const inodesUsable = s.files > 0 && s.ffree <= s.files;
  return {
    id: String(dev),
    kind: classifyFsMagic(s.type),
    blockSize: s.bsize,
    totalBytes: s.blocks * s.bsize,
    availableBytes: s.bavail * s.bsize,
    totalInodes: inodesUsable ? s.files : null,
    availableInodes: inodesUsable ? s.ffree : null,
  };
};

export function roundUp(n: number, block: number): number {
  if (n <= 0) return 0;
  return Math.ceil(n / block) * block;
}

/** Metadata blocks allowed per new file or directory (6.6). */
export function perEntryMetadataBlocks(kind: FsKind): number {
  switch (kind) {
    case 'ext4':
    case 'xfs':
      return 2;
    case 'btrfs':
      return 4;
    case 'unrecognized':
      return 8;
  }
}

/** Once per filesystem when it gets new entries: ext4/xfs inode allocation (xfs allocates 64 inodes, 32 KiB, at a time). */
export function perFilesystemMetadataBytes(kind: FsKind): number {
  return kind === 'ext4' || kind === 'xfs' ? 64 * KIB : 0;
}

/** max(5% of capacity, 1 GiB): what must stay free on each destination after the write (6.6 "余量"). */
export function baseMargin(fs: FsStats): number {
  return Math.max(Math.ceil(fs.totalBytes * 0.05), GIB);
}

/** Space the ledger's volume keeps for itself (6.6 承载账本的卷, 6.1 恢复保留空间, evaluator pool). */
export interface LedgerReserve {
  readonly recoveryReserveBytes: number;
  readonly evaluatorPoolBytes: number;
}

export function ledgerExtra(reserve: LedgerReserve): number {
  return reserve.recoveryReserveBytes + reserve.evaluatorPoolBytes;
}

export interface WriteDemand {
  /** Human label: 'target worktree', 'repository', 'git objects', 'LFS objects', 'temporary files'. */
  readonly destination: string;
  readonly fs: FsStats;
  /** File data, each file already rounded up to whole blocks. */
  readonly dataBytes: number;
  /** New files and directories that get the per-entry metadata allowance. */
  readonly metadataEntries: number;
  /** New inodes, for the inode check. */
  readonly inodes: number;
  /** Other fixed bytes: index allowance, git management blocks, per-object blocks. */
  readonly fixedBytes: number;
  /** On the volume that holds the ledger: the margin also keeps the ledger's reserve free. */
  readonly sharesLedgerVolume: boolean;
}

export interface FilesystemDecision {
  readonly fsId: string;
  readonly kind: FsKind;
  readonly destinations: readonly string[];
  readonly requiredBytes: number;
  readonly availableBytes: number;
  readonly freeAfterBytes: number;
  /** What must stay free: base margin, plus the ledger reserve on the ledger's volume. */
  readonly marginBytes: number;
  readonly inodesRequired: number;
  readonly availableInodes: number | null;
  readonly ok: boolean;
  /** Admitted, but free space after the write is below twice the base margin (plus the ledger reserve). */
  readonly remind: boolean;
  readonly reasons: readonly string[];
}

export interface AdmissionDecision {
  readonly ok: boolean;
  readonly filesystems: readonly FilesystemDecision[];
  readonly reasons: readonly string[];
  readonly reminders: readonly string[];
}

/** Groups demands by filesystem (same filesystem: computed together, 6.6) and decides each group. */
export function admit(demands: readonly WriteDemand[], reserve: LedgerReserve): AdmissionDecision {
  const groups = new Map<string, WriteDemand[]>();
  for (const d of demands) {
    const g = groups.get(d.fs.id);
    if (g === undefined) groups.set(d.fs.id, [d]);
    else g.push(d);
  }
  const filesystems: FilesystemDecision[] = [];
  for (const [fsId, group] of groups) {
    const fs = (group[0] as WriteDemand).fs;
    let data = 0;
    let entries = 0;
    let inodes = 0;
    let fixed = 0;
    let shares = false;
    for (const d of group) {
      data += d.dataBytes;
      entries += d.metadataEntries;
      inodes += d.inodes;
      fixed += d.fixedBytes;
      shares ||= d.sharesLedgerVolume;
    }
    const metadata = entries * perEntryMetadataBlocks(fs.kind) * fs.blockSize + (entries > 0 ? perFilesystemMetadataBytes(fs.kind) : 0);
    const required = data + metadata + fixed;
    const extra = shares ? ledgerExtra(reserve) : 0;
    const margin = baseMargin(fs) + extra;
    const freeAfter = fs.availableBytes - required;
    const reasons: string[] = [];
    const labels = group.map((d) => d.destination);
    if (freeAfter < margin) {
      reasons.push(
        `${labels.join(' + ')}: needs ${fmtBytes(required)} and must leave ${fmtBytes(margin)} free` +
          `${shares ? ' (includes the ledger reserve: this volume holds the ledger)' : ''}, but only ${fmtBytes(fs.availableBytes)} is available`,
      );
    }
    if (fs.availableInodes !== null && fs.availableInodes < inodes) {
      reasons.push(`${labels.join(' + ')}: needs ${inodes} inodes, ${fs.availableInodes} available`);
    }
    const ok = reasons.length === 0;
    filesystems.push({
      fsId,
      kind: fs.kind,
      destinations: labels,
      requiredBytes: required,
      availableBytes: fs.availableBytes,
      freeAfterBytes: freeAfter,
      marginBytes: margin,
      inodesRequired: inodes,
      availableInodes: fs.availableInodes,
      ok,
      remind: ok && freeAfter < 2 * baseMargin(fs) + extra,
      reasons,
    });
  }
  const reminders = filesystems
    .filter((f) => f.remind)
    .map(
      (f) =>
        `After this write ${f.destinations.join(' + ')} will have ${fmtBytes(f.freeAfterBytes)} free, ` +
        `close to the ${fmtBytes(f.marginBytes)} the program keeps free there. The write goes ahead.`,
    );
  return {
    ok: filesystems.every((f) => f.ok),
    filesystems,
    reasons: filesystems.flatMap((f) => f.reasons),
    reminders,
  };
}

export function fmtBytes(n: number): string {
  const abs = Math.abs(n);
  if (abs >= GIB) return `${(n / GIB).toFixed(2)} GiB`;
  if (abs >= MIB) return `${(n / MIB).toFixed(1)} MiB`;
  if (abs >= KIB) return `${(n / KIB).toFixed(1)} KiB`;
  return `${n} B`;
}

// ---------------------------------------------------------------- landing (6.6)

/** New index allowance: measured temp-index size x 1.5 + 64 KiB (6.6, round 19 #2). */
export function indexAllowance(measuredIndexBytes: number): number {
  return Math.ceil(measuredIndexBytes * 1.5) + 64 * KIB;
}

export interface LandingWrite {
  /** Exact materialized size (eol and ident applied, LFS: size in the pointer). */
  readonly size: number;
  /** The path does not exist in the worktree yet: a new inode and directory entry. */
  readonly isNew: boolean;
}

export interface LandingDemandInput {
  /** The worktree that has the target branch checked out; null when none has. */
  readonly worktree: {
    readonly fs: FsStats;
    readonly sharesLedgerVolume: boolean;
    readonly files: readonly LandingWrite[];
    readonly newDirectories: number;
  } | null;
  readonly repository: {
    readonly fs: FsStats;
    readonly sharesLedgerVolume: boolean;
    /** Size of the temp index built with read-tree inside the view; null when no worktree is updated. */
    readonly measuredIndexBytes: number | null;
    /** Refs the push updates (the target branch). */
    readonly updatedRefs: number;
    /** Worktrees whose HEAD log gets an entry. */
    readonly updatedWorktreeHeads: number;
    // 6.6 v49: no LFS object is ever downloaded by a landing (the needed objects are checked to be local at
    // admission and again by the hook, and the namespace has no network), so there is nothing to count for it.
    /**
     * Files and directories the view's read-only mounts will create because they
     * do not exist yet (bwrap creates missing mount points: .git/info/attributes,
     * config.worktree, .git/hooks). Each is a new inode; counted at one block.
     */
    readonly newMountPoints?: number;
  };
}

export function landingDemands(input: LandingDemandInput): WriteDemand[] {
  const out: WriteDemand[] = [];
  const w = input.worktree;
  if (w !== null) {
    let data = 0;
    for (const f of w.files) data += roundUp(f.size, w.fs.blockSize);
    // Review r2 #6: git writes every file it updates as a NEW file (unlink, then create), and the old inode and
    // blocks are freed only if nothing else holds them (another hard link, an open descriptor): count every
    // written file as a new inode and entry, not only the paths that did not exist.
    const entries = w.files.length + w.newDirectories;
    out.push({
      destination: 'target worktree',
      fs: w.fs,
      dataBytes: data,
      metadataEntries: entries,
      inodes: entries,
      fixedBytes: 0,
      sharesLedgerVolume: w.sharesLedgerVolume,
    });
  }
  const r = input.repository;
  const bs = r.fs.blockSize;
  // Each updated ref: ref file, lock file, reflog (one block each); each updated worktree: its HEAD log.
  const management = (r.updatedRefs * 3 + r.updatedWorktreeHeads) * bs;
  const index = r.measuredIndexBytes === null ? 0 : roundUp(indexAllowance(r.measuredIndexBytes), bs);
  const mountPoints = r.newMountPoints ?? 0;
  // Review r2 #6: inodes at their worst case: the new index (its lock becomes the index), per ref its lock (it
  // becomes the ref) and a reflog that may be new, per updated worktree a HEAD log that may be new, plus the log
  // directories that may not exist yet (logs/, logs/refs/, logs/refs/heads/).
  const logDirs = r.updatedRefs > 0 ? 3 : 0;
  out.push({
    destination: 'repository',
    fs: r.fs,
    dataBytes: 0,
    metadataEntries: r.updatedRefs * 2 + r.updatedWorktreeHeads + logDirs,
    inodes: (r.measuredIndexBytes === null ? 0 : 1) + r.updatedRefs * 2 + r.updatedWorktreeHeads + logDirs + mountPoints,
    fixedBytes: management + index + mountPoints * bs,
    sharesLedgerVolume: r.sharesLedgerVolume,
  });
  return out;
}

// ---------------------------------------------------------------- commit generation (6.5)

export type GitObjectType = 'blob' | 'tree' | 'commit';

/** zlib's compressBound(): the most deflate can output for n input bytes (incompressible data grows). */
export function compressBound(n: number): number {
  return n + Math.floor(n / 4096) + Math.floor(n / 16384) + Math.floor(n / 2 ** 25) + 13;
}

/**
 * Worst-case bytes of one loose object on disk (6.5 v34): git deflates the
 * object header plus content, so n = len("<type> <size>\0") + size; the bound is
 * compressBound(n) rounded up to whole blocks. git writes a temporary file and
 * renames it, so the temporary file IS the final file: no second copy.
 */
export function looseObjectBytes(type: GitObjectType, size: number, blockSize: number): number {
  const n = `${type} ${size}\0`.length + size;
  return roundUp(compressBound(n), blockSize);
}

export interface CommitGenerationInput {
  /** The repository's object directory: each new loose object at its compressed worst case, block-rounded. */
  readonly objects: {
    readonly fs: FsStats;
    readonly sharesLedgerVolume: boolean;
    readonly newObjects: readonly { readonly type: GitObjectType; readonly size: number }[];
  };
  /** The repository's LFS object directory: raw size plus the temporary copy, unless hard-linked from the content store. */
  readonly lfs: {
    readonly fs: FsStats;
    readonly sharesLedgerVolume: boolean;
    readonly newObjects: readonly { readonly size: number; readonly hardlinked: boolean }[];
  } | null;
  /** The program's own temporary files (converted blob contents staged for hash-object). */
  readonly temp: { readonly fs: FsStats; readonly sharesLedgerVolume: boolean; readonly fileSizes: readonly number[] } | null;
}

export function commitGenerationDemands(input: CommitGenerationInput): WriteDemand[] {
  const out: WriteDemand[] = [];
  const o = input.objects;
  let objBytes = 0;
  for (const x of o.newObjects) objBytes += looseObjectBytes(x.type, x.size, o.fs.blockSize);
  // Review r2 #6: each loose object may also need its fan-out directory objects/<xx> (at most 256 of them).
  const fanout = Math.min(o.newObjects.length, 256);
  out.push({
    destination: 'git objects',
    fs: o.fs,
    dataBytes: objBytes,
    metadataEntries: o.newObjects.length + fanout,
    inodes: o.newObjects.length + fanout,
    fixedBytes: fanout * o.fs.blockSize,
    sharesLedgerVolume: o.sharesLedgerVolume,
  });
  if (input.lfs !== null) {
    const l = input.lfs;
    let bytes = 0;
    let inodes = 0;
    for (const x of l.newObjects) {
      if (x.hardlinked) continue; // same filesystem and hard-linked from the content store: no second copy
      bytes += 2 * roundUp(x.size, l.fs.blockSize); // the object and its temporary copy
      inodes += 2;
    }
    out.push({
      destination: 'LFS objects',
      fs: l.fs,
      dataBytes: bytes,
      metadataEntries: 0,
      inodes,
      fixedBytes: 0,
      sharesLedgerVolume: l.sharesLedgerVolume,
    });
  }
  if (input.temp !== null) {
    const t = input.temp;
    let bytes = 0;
    for (const s of t.fileSizes) bytes += roundUp(s, t.fs.blockSize);
    out.push({
      destination: 'temporary files',
      fs: t.fs,
      dataBytes: bytes,
      metadataEntries: 0,
      inodes: t.fileSizes.length,
      fixedBytes: 0,
      sharesLedgerVolume: t.sharesLedgerVolume,
    });
  }
  return out;
}

// ---------------------------------------------------------------- space reminders (6.6 空间提醒)

export interface LedgerVolumeWatch {
  /** True when the next drop below the threshold should produce a reminder. */
  readonly armed: boolean;
}

export const INITIAL_LEDGER_VOLUME_WATCH: LedgerVolumeWatch = { armed: true };

/** The periodic check of the volume holding the ledger: below reserve + pool + 2 x landing margin, remind once. */
export function ledgerVolumeThreshold(fs: FsStats, reserve: LedgerReserve): number {
  return ledgerExtra(reserve) + 2 * baseMargin(fs);
}

export function checkLedgerVolume(
  fs: FsStats,
  reserve: LedgerReserve,
  watch: LedgerVolumeWatch,
): { readonly watch: LedgerVolumeWatch; readonly reminder: string | null } {
  const threshold = ledgerVolumeThreshold(fs, reserve);
  if (fs.availableBytes >= threshold) return { watch: { armed: true }, reminder: null };
  if (!watch.armed) return { watch, reminder: null };
  return {
    watch: { armed: false },
    reminder:
      `The disk that holds the ledger has ${fmtBytes(fs.availableBytes)} free, below ${fmtBytes(threshold)}. ` +
      'This may affect the ledger and automatic landing.',
  };
}
