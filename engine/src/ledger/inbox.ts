// Stop inboxes (design v45 6.1 "停止收件箱", "槽位协议").
//
// Each inbox is one pre-written file of fixed size: a 4 KiB header, then fixed
// slots. Install writes every byte (no holes) and fsyncs the file and every new
// directory of its chain, so on ext4, xfs and uncompressed, non-deduplicated NTFS
// a later record only overwrites blocks that already exist: a full disk cannot
// refuse it. Two slots per inbox belong to its probe and alternate; the others
// are allocated one at a time (controlState.ts), never twice in one boot, and
// zeroed only after their boot was processed in the main ledger.
//
// A slot holds one record:
//   "MPS1" | boot id (64 bytes, zero padded) | payload length (u32 LE) | payload (JSON) | sha256 of all before
// A slot that is not all zeros and does not check is a torn write. Its boot is
// read from the prefix when the prefix is intact (a torn write keeps its first
// sector far more often than not); otherwise the boot is unknown.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fdatasyncSync, fstatSync, fsyncSync, openSync, readSync, renameSync, statfsSync, unlinkSync, writeSync } from 'node:fs';
import { open as openAsync } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fsyncDir } from '../common/fsx.ts';
import { mkdirDurable } from './durable.ts';
import type { StopRequest } from './stopTypes.ts';

export type InboxName = 'primary' | 'backup';

export const INBOX_HEADER_BYTES = 4096;
export const DEFAULT_SLOT_SIZE = 1024;
/** 2 probe slots + 4,096 for stops, faults and clean exits: thousands of records per boot (6.1). */
export const DEFAULT_SLOTS = 4098;
export const PROBE_SLOTS = 2;

const HEADER_MAGIC = Buffer.from('MPINBOX1', 'ascii');
const SLOT_MAGIC = Buffer.from('MPS1', 'ascii');
const BOOT_FIELD = 64;
const SLOT_PREFIX = SLOT_MAGIC.length + BOOT_FIELD + 4;
const CHECKSUM_BYTES = 32;

/** Whether a full disk can refuse an overwrite of this inbox (v43 6.1 "磁盘写满时仍能写入"). */
export interface FsCheck {
  readonly type: string;
  readonly magic: string;
  readonly fullDiskGuarantee: boolean;
  readonly reason: string;
}

export interface InboxHeader {
  readonly format: 'mp4.stop-inbox.v1';
  readonly inbox: InboxName;
  readonly slotSize: number;
  /** All slots, the probe's two included. */
  readonly slots: number;
  readonly probeSlots: number;
  readonly createdAt: number;
  readonly fs: FsCheck;
}

interface RecordBase {
  readonly boot: string;
  readonly seq: number;
  readonly at: number;
  readonly inbox: InboxName;
}

/** A stop request with the user's words cut to the slot; the hash is of the full words. */
export interface InboxStopRecord extends RecordBase {
  readonly kind: 'stop';
  readonly entry: string;
  readonly request: StopRequest;
  readonly wordsHash: string;
  readonly wordsTruncated: boolean;
}

/** A probe's liveness record; `carried` keeps the last probe of earlier boots its slots held. */
export interface InboxProbeRecord extends RecordBase {
  readonly kind: 'probe';
  readonly carried: ReadonlyArray<{ readonly boot: string; readonly at: number; readonly seq: number }>;
}

/** "The other inbox is faulty since `from`", or "I could not write from `from` to `to`". */
export interface InboxFaultRecord extends RecordBase {
  readonly kind: 'fault';
  readonly fault: string;
  readonly subject: 'self' | 'other';
  readonly other: InboxName | null;
  readonly from: number;
  readonly to: number | null;
}

export interface InboxFaultEndRecord extends RecordBase {
  readonly kind: 'fault-end';
  readonly fault: string;
}

export interface InboxCleanExitRecord extends RecordBase {
  readonly kind: 'clean-exit';
  readonly sealedAt: number;
}

export type InboxRecord = InboxStopRecord | InboxProbeRecord | InboxFaultRecord | InboxFaultEndRecord | InboxCleanExitRecord;

export type SlotContent =
  | { readonly state: 'empty' }
  | { readonly state: 'record'; readonly record: InboxRecord }
  | { readonly state: 'torn'; readonly boot: string | null };

export class InboxUnreadable extends Error {
  constructor(file: string, why: string) {
    super(`stop inbox ${file} cannot be read: ${why}`);
    this.name = 'InboxUnreadable';
  }
}

export class SlotTooSmall extends Error {}

// ---------------------------------------------------------------- slots

export function maxPayloadBytes(slotSize: number): number {
  return slotSize - SLOT_PREFIX - CHECKSUM_BYTES;
}

export function encodeSlot(slotSize: number, record: InboxRecord): Buffer {
  const boot = Buffer.from(record.boot, 'utf8');
  if (boot.length === 0 || boot.length > BOOT_FIELD) throw new TypeError(`boot id must be 1..${BOOT_FIELD} bytes`);
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  if (payload.length > maxPayloadBytes(slotSize)) throw new SlotTooSmall(`a ${record.kind} record of ${payload.length} bytes does not fit a ${slotSize}-byte slot`);
  const buf = Buffer.alloc(slotSize);
  SLOT_MAGIC.copy(buf, 0);
  boot.copy(buf, SLOT_MAGIC.length);
  buf.writeUInt32LE(payload.length, SLOT_MAGIC.length + BOOT_FIELD);
  payload.copy(buf, SLOT_PREFIX);
  createHash('sha256').update(buf.subarray(0, SLOT_PREFIX + payload.length)).digest().copy(buf, SLOT_PREFIX + payload.length);
  return buf;
}

const KINDS = new Set(['stop', 'probe', 'fault', 'fault-end', 'clean-exit']);

export function decodeSlot(buf: Buffer): SlotContent {
  let zero = true;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) {
      zero = false;
      break;
    }
  }
  if (zero) return { state: 'empty' };
  if (!buf.subarray(0, SLOT_MAGIC.length).equals(SLOT_MAGIC)) return { state: 'torn', boot: null };
  const field = buf.subarray(SLOT_MAGIC.length, SLOT_MAGIC.length + BOOT_FIELD);
  const end = field.indexOf(0);
  const bootBytes = field.subarray(0, end === -1 ? BOOT_FIELD : end);
  const boot = bootBytes.length > 0 && bootBytes.every((b) => b >= 0x20 && b < 0x7f) ? bootBytes.toString('utf8') : null;
  const len = buf.readUInt32LE(SLOT_MAGIC.length + BOOT_FIELD);
  if (len > maxPayloadBytes(buf.length)) return { state: 'torn', boot };
  const want = createHash('sha256').update(buf.subarray(0, SLOT_PREFIX + len)).digest();
  if (!want.equals(buf.subarray(SLOT_PREFIX + len, SLOT_PREFIX + len + CHECKSUM_BYTES))) return { state: 'torn', boot };
  let rec: unknown;
  try {
    rec = JSON.parse(buf.toString('utf8', SLOT_PREFIX, SLOT_PREFIX + len));
  } catch {
    return { state: 'torn', boot };
  }
  const r = rec as Partial<InboxRecord> | null;
  if (!r || typeof r !== 'object' || !KINDS.has(r.kind as string) || r.boot !== boot || typeof r.seq !== 'number' || typeof r.at !== 'number') {
    return { state: 'torn', boot };
  }
  return { state: 'record', record: r as InboxRecord };
}

/** Fit a stop's words into a slot: cut them (by whole characters) until the record fits; the hash is of the full words. */
export function stopRecord(slotSize: number, base: Omit<InboxStopRecord, 'kind' | 'request' | 'wordsHash' | 'wordsTruncated'>, request: StopRequest): InboxStopRecord {
  const wordsHash = createHash('sha256').update(request.words, 'utf8').digest('hex');
  const full: InboxStopRecord = { ...base, kind: 'stop', request, wordsHash, wordsTruncated: false };
  const room = maxPayloadBytes(slotSize);
  if (Buffer.byteLength(JSON.stringify(full), 'utf8') <= room) return full;
  const chars = [...request.words];
  let lo = 0;
  let hi = chars.length;
  // Largest prefix that fits (JSON escaping makes the size non-linear, so search).
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const cand: InboxStopRecord = { ...full, request: { ...request, words: chars.slice(0, mid).join('') }, wordsTruncated: true };
    if (Buffer.byteLength(JSON.stringify(cand), 'utf8') <= room) lo = mid;
    else hi = mid - 1;
  }
  const out: InboxStopRecord = { ...full, request: { ...request, words: chars.slice(0, lo).join('') }, wordsTruncated: true };
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > room) throw new SlotTooSmall('a stop record does not fit its slot even without words');
  return out;
}

// ---------------------------------------------------------------- header

function encodeHeader(h: InboxHeader): Buffer {
  const json = Buffer.from(JSON.stringify(h), 'utf8');
  const buf = Buffer.alloc(INBOX_HEADER_BYTES);
  HEADER_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(json.length, HEADER_MAGIC.length);
  json.copy(buf, HEADER_MAGIC.length + 4);
  if (HEADER_MAGIC.length + 4 + json.length + CHECKSUM_BYTES > INBOX_HEADER_BYTES) throw new Error('inbox header too large');
  createHash('sha256').update(buf.subarray(0, HEADER_MAGIC.length + 4 + json.length)).digest().copy(buf, HEADER_MAGIC.length + 4 + json.length);
  return buf;
}

function decodeHeader(buf: Buffer, file: string): InboxHeader {
  if (buf.length < INBOX_HEADER_BYTES || !buf.subarray(0, HEADER_MAGIC.length).equals(HEADER_MAGIC)) throw new InboxUnreadable(file, 'not a stop inbox (bad magic)');
  const len = buf.readUInt32LE(HEADER_MAGIC.length);
  if (len > INBOX_HEADER_BYTES - HEADER_MAGIC.length - 4 - CHECKSUM_BYTES) throw new InboxUnreadable(file, 'header length out of range');
  const end = HEADER_MAGIC.length + 4 + len;
  if (!createHash('sha256').update(buf.subarray(0, end)).digest().equals(buf.subarray(end, end + CHECKSUM_BYTES))) throw new InboxUnreadable(file, 'header checksum mismatch');
  const h = JSON.parse(buf.toString('utf8', HEADER_MAGIC.length + 4, end)) as InboxHeader;
  if (h.format !== 'mp4.stop-inbox.v1' || !Number.isSafeInteger(h.slotSize) || !Number.isSafeInteger(h.slots) || h.slots <= h.probeSlots) throw new InboxUnreadable(file, 'header fields invalid');
  return h;
}

export function slotOffset(h: InboxHeader, index: number): number {
  return INBOX_HEADER_BYTES + index * h.slotSize;
}

export function inboxBytes(slots: number, slotSize: number): number {
  return INBOX_HEADER_BYTES + slots * slotSize;
}

function readFully(fd: number, buf: Buffer, pos: number): void {
  let off = 0;
  while (off < buf.length) {
    const n = readSync(fd, buf, off, buf.length - off, pos + off);
    if (n === 0) throw new Error('short read');
    off += n;
  }
}

function writeFully(fd: number, buf: Buffer, pos: number): void {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off, pos + off);
}

export function readHeader(file: string): InboxHeader {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch (e) {
    throw new InboxUnreadable(file, (e as NodeJS.ErrnoException).code ?? (e as Error).message);
  }
  try {
    const buf = Buffer.alloc(INBOX_HEADER_BYTES);
    try {
      readFully(fd, buf, 0);
    } catch (e) {
      throw new InboxUnreadable(file, (e as Error).message);
    }
    const h = decodeHeader(buf, file);
    if (fstatSync(fd).size < inboxBytes(h.slots, h.slotSize)) throw new InboxUnreadable(file, 'file shorter than its header says');
    return h;
  } finally {
    closeSync(fd);
  }
}

/** Read and decode every slot (startup, history, allocation). */
export function readInboxSync(file: string): { header: InboxHeader; slots: SlotContent[] } {
  const header = readHeader(file);
  const fd = openSync(file, 'r');
  try {
    const all = Buffer.alloc(header.slots * header.slotSize);
    try {
      readFully(fd, all, INBOX_HEADER_BYTES);
    } catch (e) {
      throw new InboxUnreadable(file, (e as Error).message);
    }
    const slots: SlotContent[] = [];
    for (let i = 0; i < header.slots; i++) slots.push(decodeSlot(all.subarray(i * header.slotSize, (i + 1) * header.slotSize)));
    return { header, slots };
  } finally {
    closeSync(fd);
  }
}

export function readSlotsSync(file: string, header: InboxHeader, indices: readonly number[]): Map<number, SlotContent> {
  const out = new Map<number, SlotContent>();
  const fd = openSync(file, 'r');
  try {
    for (const i of indices) {
      const buf = Buffer.alloc(header.slotSize);
      readFully(fd, buf, slotOffset(header, i));
      out.set(i, decodeSlot(buf));
    }
  } finally {
    closeSync(fd);
  }
  return out;
}

export async function readSlotsAsync(file: string, header: InboxHeader, indices: readonly number[]): Promise<Map<number, SlotContent>> {
  const out = new Map<number, SlotContent>();
  const fh = await openAsync(file, 'r');
  try {
    for (const i of indices) {
      const buf = Buffer.alloc(header.slotSize);
      const { bytesRead } = await fh.read(buf, 0, buf.length, slotOffset(header, i));
      out.set(i, bytesRead === buf.length ? decodeSlot(buf) : { state: 'torn', boot: null });
    }
  } finally {
    await fh.close();
  }
  return out;
}

/** Overwrite one slot in place and fdatasync (the file never grows). */
export function writeSlotSync(file: string, header: InboxHeader, index: number, buf: Buffer): void {
  if (buf.length !== header.slotSize || index < 0 || index >= header.slots) throw new RangeError('bad slot write');
  const fd = openSync(file, 'r+');
  try {
    writeFully(fd, buf, slotOffset(header, index));
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export async function writeSlotAsync(file: string, header: InboxHeader, index: number, buf: Buffer): Promise<void> {
  if (buf.length !== header.slotSize || index < 0 || index >= header.slots) throw new RangeError('bad slot write');
  const fh = await openAsync(file, 'r+');
  try {
    let off = 0;
    while (off < buf.length) off += (await fh.write(buf, off, buf.length - off, slotOffset(header, index) + off)).bytesWritten;
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

/** Zero slots of processed boots (reclaim, 6.1: only the blocks already written). */
export function zeroSlotsSync(file: string, header: InboxHeader, indices: readonly number[]): void {
  if (indices.length === 0) return;
  const zero = Buffer.alloc(header.slotSize);
  const fd = openSync(file, 'r+');
  try {
    for (const i of indices) writeFully(fd, zero, slotOffset(header, i));
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Slots a writer may take: empty and not the probe's. */
export function freeSlots(header: InboxHeader, slots: readonly SlotContent[]): number[] {
  const out: number[] = [];
  for (let i = header.probeSlots; i < header.slots; i++) if (slots[i]?.state === 'empty') out.push(i);
  return out;
}

// ---------------------------------------------------------------- filesystem check

const FS_TYPES: Readonly<Record<number, string>> = {
  0xef53: 'ext4',
  0x58465342: 'xfs',
  0x01021994: 'tmpfs',
  0x9123683e: 'btrfs',
  0x2fc12fc1: 'zfs',
  0x794c7630: 'overlayfs',
  0x01021997: 'v9fs',
  0x7366746e: 'ntfs3',
  0x65735546: 'fuse',
  0x5346544e: 'ntfs',
  0x6969: 'nfs',
};

/**
 * Whether overwriting this inbox in place needs no new blocks (6.1): ext4; xfs
 * (the file was written by install, so it shares no extents); NTFS when the file
 * is neither compressed, sparse nor a reparse point (deduplicated files are
 * reparse points), checked through WSL interop for a drvfs mount. Anything else
 * (tmpfs, copy-on-write filesystems, unknown) carries no full-disk guarantee.
 * `ntfsCheck` is injectable for tests.
 */
export function checkInboxFilesystem(file: string, ntfsCheck: (file: string) => { ok: boolean; reason: string } = checkNtfsAttributes): FsCheck {
  let magic: number;
  try {
    magic = statfsSync(dirname(file)).type;
  } catch (e) {
    return { type: 'unknown', magic: '?', fullDiskGuarantee: false, reason: `statfs failed: ${(e as Error).message}` };
  }
  const type = FS_TYPES[magic] ?? 'unknown';
  const hex = `0x${magic.toString(16)}`;
  let sparse = false;
  try {
    const st = fstatOf(file);
    sparse = st !== null && st.blocks * 512 < st.size;
  } catch {
    sparse = false;
  }
  const no = (reason: string): FsCheck => ({ type, magic: hex, fullDiskGuarantee: false, reason });
  if (sparse) return no('the inbox file has holes: overwriting them needs new blocks');
  switch (type) {
    case 'ext4':
      return { type, magic: hex, fullDiskGuarantee: true, reason: 'ext4: overwriting written blocks needs no new blocks' };
    case 'xfs':
      return { type, magic: hex, fullDiskGuarantee: true, reason: 'xfs: the file was written by install and shares no extents (no reflink)' };
    case 'v9fs':
    case 'ntfs3':
    case 'ntfs': {
      const r = ntfsCheck(file);
      return r.ok ? { type: 'ntfs', magic: hex, fullDiskGuarantee: true, reason: r.reason } : no(r.reason);
    }
    case 'tmpfs':
      return no('a memory filesystem: the inbox does not survive a reboot');
    case 'btrfs':
    case 'zfs':
    case 'overlayfs':
      return no(`${type}: copy-on-write, an overwrite can need new space`);
    default:
      return no(`${type} (${hex}): no known in-place overwrite guarantee`);
  }
}

function fstatOf(file: string): { blocks: number; size: number } | null {
  if (!existsSync(file)) return null;
  const fd = openSync(file, 'r');
  try {
    const st = fstatSync(fd);
    return { blocks: st.blocks, size: st.size };
  } finally {
    closeSync(fd);
  }
}

/** NTFS file attributes through WSL interop: not compressed (2048), not sparse (512), not a reparse point (1024, as deduplicated files are). */
export function checkNtfsAttributes(file: string): { ok: boolean; reason: string } {
  try {
    const win = execFileSync('wslpath', ['-w', file], { encoding: 'utf8', timeout: 5_000 }).trim();
    const ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `[int]((Get-Item -LiteralPath '${win.replace(/'/g, "''")}').Attributes -band 3584)`], {
      encoding: 'utf8',
      timeout: 20_000,
    }).trim();
    if (out === '0') return { ok: true, reason: 'NTFS: the file is not compressed, sparse or a reparse point (deduplicated)' };
    return { ok: false, reason: `NTFS: the file is compressed, sparse or a reparse point (attributes ${out})` };
  } catch (e) {
    return { ok: false, reason: `NTFS attributes could not be checked: ${(e as Error).message.split('\n')[0]}` };
  }
}

// ---------------------------------------------------------------- install

export interface InstalledInbox {
  readonly file: string;
  readonly header: InboxHeader;
  readonly created: boolean;
  /** A file found with an unreadable header was moved aside (kept, never deleted). */
  readonly movedAside: string | null;
}

/**
 * Create the inbox if it does not exist: every byte written (no holes), file
 * fsynced, then renamed into place; the directory chain made durable level by
 * level and the directory fsynced (6.1). An existing valid inbox is kept as it is.
 */
export function installInbox(file: string, inbox: InboxName, opts: { slots?: number; slotSize?: number; ntfsCheck?: (f: string) => { ok: boolean; reason: string } } = {}): InstalledInbox {
  let movedAside: string | null = null;
  if (existsSync(file)) {
    try {
      return { file, header: readHeader(file), created: false, movedAside: null };
    } catch {
      movedAside = `${file}.unreadable-${Date.now()}`;
      renameSync(file, movedAside);
    }
  }
  const slots = opts.slots ?? DEFAULT_SLOTS;
  const slotSize = opts.slotSize ?? DEFAULT_SLOT_SIZE;
  if (slots <= PROBE_SLOTS || slotSize < 512 || slotSize % 512 !== 0) throw new RangeError('an inbox needs more than the probe slots and 512-byte multiples');
  const dir = dirname(file);
  mkdirDurable(dir);
  const tmp = join(dir, `.inbox-${randomBytes(6).toString('hex')}.tmp`);
  const provisional: InboxHeader = { format: 'mp4.stop-inbox.v1', inbox, slotSize, slots, probeSlots: PROBE_SLOTS, createdAt: Date.now(), fs: { type: 'unknown', magic: '?', fullDiskGuarantee: false, reason: 'not checked yet' } };
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFully(fd, encodeHeader(provisional), 0);
    const chunk = Buffer.alloc(1024 * 1024);
    const total = inboxBytes(slots, slotSize);
    for (let pos = INBOX_HEADER_BYTES; pos < total; pos += chunk.length) writeFully(fd, chunk.subarray(0, Math.min(chunk.length, total - pos)), pos);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
  closeSync(fd);
  // The filesystem check needs the written file; the header then records it.
  const header: InboxHeader = { ...provisional, fs: checkInboxFilesystem(tmp, opts.ntfsCheck) };
  const fd2 = openSync(tmp, 'r+');
  try {
    writeFully(fd2, encodeHeader(header), 0);
    fsyncSync(fd2);
  } finally {
    closeSync(fd2);
  }
  renameSync(tmp, file);
  fsyncDir(dir);
  return { file, header, created: true, movedAside };
}
