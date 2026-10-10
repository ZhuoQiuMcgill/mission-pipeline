// Git LFS pointers, implemented by the program itself (7.1 表示约定: the program
// generates and parses pointers per the LFS v1 pointer spec and keeps objects in
// the repository's LFS object directory; git-lfs is never run to build a snapshot
// or a commit).
//
// Behaviour mirrors git-lfs where it matters for byte fidelity:
// - an empty file's pointer is empty (git-lfs Pointer.Encoded() returns "" for size 0);
// - blobs of 1024 bytes or more are never pointers (git-lfs blobSizeCutoff);
// - parsing tolerates surrounding whitespace and CRLF line ends (bufio.ScanLines);
// - clean leaves content that already parses as a pointer (< 512 bytes) as it is.
// Pointer extensions (ext-N-name) need extension programs and are unsupported.

import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const LFS_SPEC_URL = 'https://git-lfs.github.com/spec/v1';
const VERSION_ALIASES: ReadonlySet<string> = new Set([
  'https://git-lfs.github.com/spec/v1',
  'https://hawser.github.com/spec/v1',
  'http://git-media.io/v/2',
]);
/** git-lfs never reads a blob of this size or larger as a pointer. */
export const LFS_POINTER_MAX_BYTES = 1024;
/** git-lfs clean passes through pointer-looking input below this size. */
export const LFS_CLEAN_PASSTHROUGH_BYTES = 512;

export const EMPTY_SHA256 = createHash('sha256').update(new Uint8Array(0)).digest('hex');

export interface LfsPointer {
  /** Lowercase hex sha256 of the object content. */
  readonly oid: string;
  readonly size: number;
}

export type LfsParse =
  | { readonly kind: 'pointer'; readonly pointer: LfsPointer }
  | { readonly kind: 'not-pointer' }
  | { readonly kind: 'unsupported'; readonly reason: string };

export function encodeLfsPointer(p: LfsPointer): Buffer {
  if (!/^[0-9a-f]{64}$/.test(p.oid)) throw new TypeError(`bad LFS oid ${p.oid}`);
  if (!Number.isSafeInteger(p.size) || p.size < 0) throw new TypeError(`bad LFS size ${p.size}`);
  if (p.size === 0) return Buffer.alloc(0);
  return Buffer.from(`version ${LFS_SPEC_URL}\noid sha256:${p.oid}\nsize ${p.size}\n`, 'utf8');
}

export function parseLfsPointer(data: Uint8Array): LfsParse {
  if (data.length === 0) return { kind: 'pointer', pointer: { oid: EMPTY_SHA256, size: 0 } };
  if (data.length >= LFS_POINTER_MAX_BYTES) return { kind: 'not-pointer' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return { kind: 'not-pointer' };
  }
  const trimmed = text.trim();
  if (!/git-media|hawser|git-lfs/.test(trimmed)) return { kind: 'not-pointer' };
  const lines = trimmed
    .split('\n')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
    .filter((l) => l.length > 0);
  const kv = lines.map((l) => {
    const sp = l.indexOf(' ');
    return sp < 0 ? null : ([l.slice(0, sp), l.slice(sp + 1)] as const);
  });
  if (kv.some((x) => x === null)) return { kind: 'not-pointer' };
  const pairs = kv as (readonly [string, string])[];
  let i = 0;
  const version = pairs[i++];
  if (version === undefined || version[0] !== 'version' || !VERSION_ALIASES.has(version[1])) return { kind: 'not-pointer' };
  const next = pairs[i];
  if (next !== undefined && /^ext-\d-\w+$/.test(next[0])) {
    return { kind: 'unsupported', reason: 'LFS pointer extensions need extension programs' };
  }
  const oid = pairs[i++];
  const size = pairs[i++];
  if (oid === undefined || size === undefined || oid[0] !== 'oid' || size[0] !== 'size' || i !== pairs.length) {
    return { kind: 'not-pointer' };
  }
  const m = /^sha256:(.*)$/.exec(oid[1]);
  if (m === null) return { kind: 'not-pointer' };
  const hex = m[1] as string;
  if (!/^[0-9a-f]{64}$/.test(hex)) return { kind: 'unsupported', reason: `LFS oid is not 64 lowercase hex digits: ${hex}` };
  if (!/^\d+$/.test(size[1])) return { kind: 'unsupported', reason: `LFS size is not a plain decimal: ${size[1]}` };
  const n = Number(size[1]);
  if (!Number.isSafeInteger(n)) return { kind: 'unsupported', reason: `LFS size out of range: ${size[1]}` };
  return { kind: 'pointer', pointer: { oid: hex, size: n } };
}

export function lfsPointerFor(content: Uint8Array): LfsPointer {
  return { oid: createHash('sha256').update(content).digest('hex'), size: content.length };
}

/**
 * LFS clean as git-lfs does it: content that already is a pointer stays as it is;
 * anything else becomes a pointer, and the object must be stored.
 */
export function lfsClean(content: Uint8Array): { readonly blob: Buffer; readonly object: LfsPointer | null } {
  if (content.length < LFS_CLEAN_PASSTHROUGH_BYTES) {
    const p = parseLfsPointer(content);
    if (p.kind === 'pointer') return { blob: Buffer.from(content), object: null };
  }
  const pointer = lfsPointerFor(content);
  return { blob: encodeLfsPointer(pointer), object: pointer.size === 0 ? null : pointer };
}

/** Where git-lfs keeps an object (default storage under the common git dir). */
export function lfsObjectPath(commonDir: string, oid: string): string {
  if (!/^[0-9a-f]{64}$/.test(oid)) throw new TypeError(`bad LFS oid ${oid}`);
  return join(commonDir, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
}

export function lfsTempDir(commonDir: string): string {
  return join(commonDir, 'lfs', 'tmp');
}
