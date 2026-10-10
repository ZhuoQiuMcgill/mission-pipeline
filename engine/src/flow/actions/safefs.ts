// Writes under a program directory that never leave it (code review r1 #1; design 7.1 "沙箱里根本
// 不存在这些路径", 3.11 principle 4). Snapshot trees and seat directories hold whatever a
// commit or an export put there, symbolic links included; a string-only path check would follow
// such a link out of the directory. Here every existing component of a path is checked with
// lstat and must be a real directory, missing directories are created one at a time (never
// through a link), and files are created fresh with O_NOFOLLOW | O_EXCL. The directories are the
// program's own (no other writer while it works on them), so checking component by component is
// enough; nothing is ever written through a link.

import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, rmSync, symlinkSync, writeSync } from 'node:fs';
import { join, posix } from 'node:path';
import { ActionError } from './context.ts';

function normalizedRel(rel: string): string {
  const n = posix.normalize(rel);
  if (rel === '' || posix.isAbsolute(rel) || n !== rel || n === '..' || n.startsWith('../') || n.split('/').includes('.git')) {
    throw new ActionError('unsafe-path', `${JSON.stringify(rel)} is not a normalized relative path inside the directory`, { path: rel });
  }
  return n;
}

function kindOf(p: string): 'dir' | 'link' | 'other' | 'missing' {
  try {
    const st = lstatSync(p);
    return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'other';
  } catch {
    return 'missing';
  }
}

/**
 * The directory `rel` under `root` ("." is the root itself), checked component by component: a
 * link or a non-directory on the way is refused; missing components are created when `create`.
 * Returns null when it is missing and `create` is false.
 */
export function safeDir(root: string, rel: string, create: boolean): string | null {
  if (rel === '.') return root;
  let cur = root;
  for (const c of normalizedRel(rel).split('/')) {
    cur = join(cur, c);
    const k = kindOf(cur);
    if (k === 'link') throw new ActionError('unsafe-path', `${rel} goes through a symbolic link (${c})`, { path: rel });
    if (k === 'other') throw new ActionError('unsafe-path', `${rel} goes through a file that is not a directory (${c})`, { path: rel });
    if (k === 'missing') {
      if (!create) return null;
      mkdirSync(cur, { mode: 0o755 });
    }
  }
  return cur;
}

/** What is at `rel` under `root`, without following links anywhere on the way (ancestors must be real directories). */
export function safeKind(root: string, rel: string): 'dir' | 'link' | 'other' | 'missing' {
  const parent = posix.dirname(normalizedRel(rel));
  const dir = safeDir(root, parent, false);
  return dir === null ? 'missing' : kindOf(join(dir, posix.basename(rel)));
}

/** Replace whatever is at `rel` (a link is removed, never followed) by a new regular file. */
export function safeWriteFile(root: string, rel: string, data: Uint8Array, executable: boolean): void {
  const dir = safeDir(root, posix.dirname(normalizedRel(rel)), true) as string;
  const target = join(dir, posix.basename(rel));
  if (kindOf(target) !== 'missing') rmSync(target, { recursive: true, force: true });
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    fchmodSync(fd, executable ? 0o755 : 0o644);
  } finally {
    closeSync(fd);
  }
}

/** Replace whatever is at `rel` by a symbolic link (its target is data: nothing is written through it). */
export function safeSymlink(root: string, rel: string, linkTarget: string): void {
  const dir = safeDir(root, posix.dirname(normalizedRel(rel)), true) as string;
  const target = join(dir, posix.basename(rel));
  if (kindOf(target) !== 'missing') rmSync(target, { recursive: true, force: true });
  symlinkSync(linkTarget, target);
}
