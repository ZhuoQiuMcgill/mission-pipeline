// Durable file writes that work on Linux, macOS and Windows (design 4.1 §2.3,
// §9). A file written with writeAtomic either exists complete or does not
// exist: temporary name, fsync, rename, then the directory's entry made
// durable. Windows cannot open a directory to fsync it; there NTFS journals the
// rename itself, so the directory step is skipped.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const WINDOWS = process.platform === 'win32';

/** Make a directory's entries durable (a no-op on Windows). */
export function syncDir(dir: string): void {
  if (WINDOWS) return;
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Create `dir` and its missing ancestors, each new level's parent synced before the next is made. */
export function mkdirDurable(dir: string): void {
  const missing: string[] = [];
  for (let cur = resolve(dir); !existsSync(cur); ) {
    missing.push(cur);
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const d of missing.reverse()) {
    try {
      mkdirSync(d);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    syncDir(dirname(d));
  }
}

function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

/** Write a whole file: temporary name, fsync, rename into place, directory synced. */
export function writeAtomic(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  mkdirDurable(dir);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o644);
  try {
    writeAll(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data));
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
  renameSync(tmp, path);
  syncDir(dir);
}

/** Append bytes and fsync the file; a new file's directory entry is synced too. */
export function appendDurable(path: string, data: string): void {
  const dir = dirname(path);
  mkdirDurable(dir);
  const created = !existsSync(path);
  const fd = openSync(path, 'a', 0o644);
  try {
    writeAll(fd, Buffer.from(data, 'utf8'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) syncDir(dir);
}

/** Remove a file if it exists. */
export function removeFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
