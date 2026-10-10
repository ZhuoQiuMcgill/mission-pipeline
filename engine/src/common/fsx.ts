// Durable file helpers. A file written with writeFileAtomic either exists
// complete or does not exist (design 6.3, 7.1: tmp file, fsync, rename, dir fsync).

import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
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
  fsyncDir(dir);
}

/**
 * Append a line and fsync the file before returning. If a crash left a torn last
 * line (no trailing newline), it is terminated first, so the new line always
 * starts on its own; readers skip lines that do not parse. A newly created file
 * also gets its directory entry fsynced.
 */
export function appendLineDurable(path: string, line: string): void {
  if (line.includes('\n')) throw new TypeError('line must not contain a newline');
  const created = !existsSync(path);
  const fd = openSync(path, 'a+', 0o600);
  try {
    const size = fstatSync(fd).size;
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    const buf = Buffer.from(prefix + line + '\n', 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) fsyncDir(dirname(path));
}
