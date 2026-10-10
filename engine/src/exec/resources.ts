// Machine resources and admission of execution units (design 6.5 "机器资源", 6.2 reservations).
// The scheduler makes the admission decision; this module gives it the execution side:
// live readings of the machine, what a unit reserves over its whole life, and the rule.
//
//  - 6.2: a seat's synchronous runs are reserved at dispatch: the reservation is the seat
//    host's own usage plus the run's declared peak; parallel runs (when the card allows) add up.
//  - 6.2: the recovery state of an async-evidence seat has its own cap, reserved at dispatch
//    (UnitDemand.recoveryState): up to two copies exist (the one saved before the request is
//    accepted, and the one captured when the seat has ended), plus, for a resumed seat, the
//    copy restored into its scratch seed.
//  - 7.1: tmpfs pages of the writable area (and of the Claude Code enclosure) count toward the
//    unit's memory; a disk need above a quarter of the memory reservation gets a fixed-size
//    disk image instead (planUnitArea), and without fuse2fs such a unit cannot run: resource
//    block (WI-10), never a silent fallback to tmpfs.
//  - 6.5: what a launch stores is streamed straight into the content store (no host copy), and
//    everything it stores counts against the card's export caps together: products, the
//    transcript, the tool log and the result documents (exec/export.ts ExportBudget). So the
//    physical footprint of one launch's exports is at most
//        L + (F + D) x (I + 3 blocks) + ceil(L / 256)
//    with L the logical cap, F the file cap (exported entries), D the program documents a launch
//    may add (EXPORT_DOC_OBJECTS: results, logs, tree documents, lists), I the index allowance of
//    one tree entry (EXPORT_INDEX_RECORD_BYTES), and per object one block of rounding, one of
//    directory growth and one of extent-tree growth; L/256 bounds the extent leaves of
//    fragmented large files. The disk peak of a unit is the image (large-disk
//    units only) plus that bound plus the recovery-state copies; inodes are admitted too.
//  - 6.5: admission holds when persistent use + in-flight peak reservations + this peak +
//    the recovery reserve <= the live capacity, for memory, disk bytes and inodes alike.

import { existsSync, lstatSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, posix } from 'node:path';
import { EXPORT_DOC_OBJECTS, EXPORT_INDEX_RECORD_BYTES, type ExportCaps } from './export.ts';
import { findFuse2fs, findTool } from './platform.ts';

export interface DiskReading {
  readonly path: string;
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly totalInodes: number;
  readonly freeInodes: number;
  /** Allocation block size of this filesystem (statfs bsize). */
  readonly blockBytes: number;
}

export interface MachineReading {
  readonly memTotalBytes: number;
  /** MemAvailable: what can be allocated without swapping. */
  readonly memAvailableBytes: number;
  readonly cpus: number;
  readonly disks: readonly DiskReading[];
}

export function parseMeminfo(text: string): { total: number; available: number } {
  const get = (k: string): number => {
    const m = new RegExp(`^${k}:\\s+(\\d+) kB$`, 'm').exec(text);
    if (!m) throw new Error(`/proc/meminfo has no ${k}`);
    return Number(m[1]) * 1024;
  };
  return { total: get('MemTotal'), available: get('MemAvailable') };
}

export function readDisk(path: string): DiskReading {
  const s = statfsSync(path);
  return {
    path,
    totalBytes: s.blocks * s.bsize,
    freeBytes: s.bavail * s.bsize,
    totalInodes: s.files,
    freeInodes: s.ffree,
    blockBytes: s.bsize,
  };
}

/** Live readings, taken before every dispatch (6.5: never only the install-time measurement). */
export function readMachine(diskPaths: readonly string[]): MachineReading {
  const mem = parseMeminfo(readFileSync('/proc/meminfo', 'utf8'));
  return { memTotalBytes: mem.total, memAvailableBytes: mem.available, cpus: availableParallelism(), disks: diskPaths.map(readDisk) };
}

// ---------------------------------------------------------------- what a unit reserves

export interface UnitDemand {
  /** The seat host and its Claude Code process (or a verification host) at their peak. */
  readonly hostBytes: number;
  /** Declared peak of one synchronous run (0 when the seat runs no commands). */
  readonly runPeakBytes: number;
  /** Runs the card allows at the same time (1: sequential). */
  readonly runParallelism: number;
  /** The tool sandbox's writable area (tmpfs bytes, or the image size for large-disk units). */
  readonly areaBytes: number;
  /** tmpfs caps of the Claude Code enclosure (config + tmp + shm), 0 for units without a seat. */
  readonly enclosureBytes: number;
  /** The card's export caps: products, transcript, tool log and result documents together. */
  readonly exportCaps: ExportCaps;
  /** 6.2: the recovery state's caps when the card allows async evidence, else null. Reserved at dispatch. */
  readonly recoveryState: ExportCaps | null;
  /** A resumed seat first restores its recovery state into a scratch seed on the host. */
  readonly resumesFromState?: boolean;
  /** Inodes of a large-disk image (fixed at format time). Default: the export file cap + 64. */
  readonly areaInodes?: number;
}

// ---------------------------------------------------------------- sizing the writable area

const MiB = 1024 * 1024;
const PAGE = 4096;

/**
 * The smallest writable area a unit that runs commands gets (7.1): room for /tmp, /dev/shm and
 * build output on top of the copies of its writable paths. Below the image threshold of any
 * ordinary run seat (a quarter of its memory reservation), so ordinary tasks run on tmpfs.
 */
export const RUN_AREA_FLOOR_BYTES = 512 * MiB;
/** Room on top of the copies: /tmp, /dev/shm, caches and build output. */
export const RUN_AREA_HEADROOM_BYTES = 256 * MiB;

/**
 * What copying `paths` (relative to `root`; "." the whole tree) into a tmpfs takes: file
 * contents rounded up to whole pages, plus a page per directory, link or other entry. Nothing
 * is followed (links count as themselves). The walk stops once `cap` is passed
 * (complete: false; bytes is then over the cap). A path that does not exist counts nothing.
 */
export function treeAreaBytes(root: string, paths: readonly string[], cap = Number.MAX_SAFE_INTEGER): { readonly bytes: number; readonly entries: number; readonly complete: boolean } {
  let bytes = 0;
  let entries = 0;
  const stack: string[] = [];
  for (const p of paths) {
    const n = posix.normalize(p);
    if (n.startsWith('/') || n === '..' || n.startsWith('../')) continue;
    stack.push(n === '.' || n === './' ? root : join(root, n));
  }
  while (stack.length > 0) {
    if (bytes > cap) return { bytes, entries, complete: false };
    const at = stack.pop() as string;
    let st;
    try {
      st = lstatSync(at);
    } catch {
      continue;
    }
    entries++;
    if (st.isFile()) bytes += Math.max(PAGE, Math.ceil(st.size / PAGE) * PAGE);
    else bytes += PAGE;
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(at);
      } catch {
        continue;
      }
      for (const name of names) stack.push(join(at, name));
    }
  }
  return { bytes, entries, complete: true };
}

/** The writable area for a tree footprint: the copies, half again for rewrites and output, the headroom; at least the floor; whole MiB. */
export function runAreaBytesFor(treeBytes: number): number {
  const want = treeBytes + Math.ceil(treeBytes / 2) + RUN_AREA_HEADROOM_BYTES;
  return Math.max(RUN_AREA_FLOOR_BYTES, Math.ceil(want / MiB) * MiB);
}

/** The writable area a run seat needs for its writable paths in `snapshot` (measured now). */
export function runAreaBytes(snapshot: string, writablePaths: readonly string[]): number {
  return runAreaBytesFor(treeAreaBytes(snapshot, writablePaths, 64 * 1024 * MiB).bytes);
}

export type AreaKind = 'tmpfs' | 'image';

/** 7.1: a disk need above a quarter of the memory reservation goes to a fixed-size image. */
export function chooseAreaKind(d: UnitDemand): AreaKind {
  const memoryWithoutArea = d.hostBytes + d.runPeakBytes * d.runParallelism + d.enclosureBytes;
  return d.areaBytes > memoryWithoutArea / 4 ? 'image' : 'tmpfs';
}

/** What the machine offers for large-disk areas (9.6 install checks). */
export interface AreaTools {
  readonly fuse2fs: string | null;
  readonly mkfsExt4: string | null;
  readonly fallocate: string | null;
  readonly fusermount: string | null;
  readonly fuseDevice: boolean;
  /**
   * Result of probePrivateImageMount (exec/sandbox.ts): fuse2fs can mount inside a private user
   * namespace, as units do. Unknown (not probed) when absent; false blocks large-disk units.
   */
  readonly privateFuseMount?: boolean;
}

export function detectAreaTools(fuse2fsConfigured?: string): AreaTools {
  return {
    fuse2fs: findFuse2fs(fuse2fsConfigured),
    mkfsExt4: findTool('mkfs.ext4'),
    fallocate: findTool('fallocate'),
    fusermount: findTool('fusermount3') ?? findTool('fusermount'),
    fuseDevice: existsSync('/dev/fuse'),
  };
}

/**
 * The writable area admission decides on, which the host then honours (code review r1
 * finding 5): a capped tmpfs, a fixed-size image, or (7.1 "没有 fuse2fs 的机器") a resource
 * block: a large-disk unit never silently runs on tmpfs.
 */
export type AreaPlan =
  | { readonly kind: 'tmpfs'; readonly bytes: number }
  | { readonly kind: 'image'; readonly bytes: number; readonly inodes: number }
  | { readonly kind: 'resource-blocked'; readonly wi: 'WI-10'; readonly reason: string; readonly missing: readonly string[] };

export function planUnitArea(d: UnitDemand, tools: AreaTools): AreaPlan {
  if (chooseAreaKind(d) === 'tmpfs') return { kind: 'tmpfs', bytes: d.areaBytes };
  const missing = [
    tools.fuse2fs === null ? 'fuse2fs' : null,
    tools.mkfsExt4 === null ? 'mkfs.ext4' : null,
    tools.fallocate === null ? 'fallocate' : null,
    tools.fusermount === null ? 'fusermount' : null,
    tools.fuseDevice ? null : '/dev/fuse',
    tools.privateFuseMount === false ? 'FUSE mounts inside a private user namespace' : null,
  ].filter((m): m is string => m !== null);
  if (missing.length > 0) {
    return {
      kind: 'resource-blocked',
      wi: 'WI-10',
      reason: `the unit's writable area is ${Math.ceil(d.areaBytes / MiB)} MiB, over a quarter of its other memory reservation (${Math.floor((d.hostBytes + d.runPeakBytes * d.runParallelism + d.enclosureBytes) / 4 / MiB)} MiB), so it needs a disk image, and this machine lacks ${missing.join(', ')} (7.1: never an uncapped area). Install fuse2fs (Ubuntu: the fuse2fs package), or give the task a smaller writable scope`,
      missing,
    };
  }
  return { kind: 'image', bytes: d.areaBytes, inodes: d.areaInodes ?? d.exportCaps.maxFiles + 64 };
}

/** The unit's memory.max: host + parallel run peaks + every tmpfs whose pages it is charged for. */
export function unitMemoryReservation(d: UnitDemand): number {
  const area = chooseAreaKind(d) === 'tmpfs' ? d.areaBytes : 0;
  return d.hostBytes + d.runPeakBytes * d.runParallelism + area + d.enclosureBytes;
}

export interface StoreGeometry {
  /** Allocation block of the content store's filesystem, measured at install. */
  readonly blockBytes: number;
  /**
   * Index allowance of one tree entry. Ignored below EXPORT_INDEX_RECORD_BYTES: the host
   * enforces that allowance, so the bound must use at least it.
   */
  readonly indexRecordBytes?: number;
}

/**
 * 6.5: physical footprint of everything one budget (exec/export.ts ExportBudget with these
 * caps) can store in the content store, at most. Streaming leaves no host copy, and a
 * temporary object file becomes the stored object itself, so this is the whole peak.
 */
export function exportPhysicalBound(caps: ExportCaps, g: StoreGeometry): number {
  const index = Math.max(g.indexRecordBytes ?? 0, EXPORT_INDEX_RECORD_BYTES);
  return caps.maxLogicalBytes + (caps.maxFiles + EXPORT_DOC_OBJECTS) * (index + 3 * g.blockBytes) + Math.ceil(caps.maxLogicalBytes / 256);
}

/** 6.5, 6.2: disk peak over the unit's life: the image, the exports and the recovery-state copies exist together. */
export function unitDiskReservation(d: UnitDemand, g: StoreGeometry): number {
  const image = chooseAreaKind(d) === 'image' ? d.areaBytes : 0;
  const recovery = d.recoveryState === null ? 0 : exportPhysicalBound(d.recoveryState, g) * (2 + (d.resumesFromState === true ? 1 : 0));
  return image + exportPhysicalBound(d.exportCaps, g) + recovery;
}

/** 6.5 "inode 也是准入资源": every stored object (entries and documents), every recovery-state copy, the image file. */
export function unitInodeReservation(d: UnitDemand): number {
  const recovery = d.recoveryState === null ? 0 : (d.recoveryState.maxFiles + EXPORT_DOC_OBJECTS) * (2 + (d.resumesFromState === true ? 1 : 0));
  // + 1: the launch's export directory in the content store's file system
  return d.exportCaps.maxFiles + EXPORT_DOC_OBJECTS + recovery + 1 + (chooseAreaKind(d) === 'image' ? 1 : 0);
}

// ---------------------------------------------------------------- admission

export interface ResourceLedger {
  /** Kept content, ledger, frozen environments... (never released by a unit ending). */
  readonly persistent: number;
  /** Peak reservations of every unit in flight. */
  readonly inFlight: number;
  /** Space the ledger needs to recover (disk) or the evaluator's pool (memory). */
  readonly reserve: number;
}

export type Resource = 'memory' | 'disk' | 'inodes';

export interface AdmissionCheck {
  readonly resource: Resource;
  readonly capacity: number;
  readonly need: number;
  readonly ledger: ResourceLedger;
}

export type AdmissionResult =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly shortfalls: readonly { readonly resource: Resource; readonly missing: number }[] };

/** persistent + in flight + this peak + reserve <= capacity, for every resource checked. */
export function admit(checks: readonly AdmissionCheck[]): AdmissionResult {
  const shortfalls = checks
    .map((c) => ({ resource: c.resource, missing: c.ledger.persistent + c.ledger.inFlight + c.need + c.ledger.reserve - c.capacity }))
    .filter((s) => s.missing > 0);
  return shortfalls.length === 0 ? { admitted: true } : { admitted: false, shortfalls };
}

/**
 * 6.5 "准入被拒之后的去向": wait if the in-flight units' release would make room; reclaim if
 * reclaimable content would; otherwise the request exceeds the machine ("资源阻塞").
 */
export function afterRefusal(c: AdmissionCheck, reclaimable: number): 'wait' | 'reclaim' | 'resource-blocked' {
  const base = c.ledger.persistent - reclaimable + c.need + c.ledger.reserve;
  if (base + c.ledger.inFlight <= c.capacity) return 'reclaim'; // reclaiming alone makes room now
  if (base <= c.capacity) return 'wait'; // room appears once in-flight units end (they never wait on admission, 6.2)
  return 'resource-blocked'; // beyond the whole machine: no wait can satisfy it
}
