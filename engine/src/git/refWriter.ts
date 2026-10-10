// The program's writer of loose refs (files backend): design 6.1 "git：程序只创建
// 自己命名空间里的引用", 6.6 step 6; code review r1 #2.
//
// `git update-ref` finds a ref's file by path. A symref stored under the
// program's name is followed unless --no-deref is given, and a symlinked
// directory anywhere under refs/mission-pipeline/ (for example
// refs/mission-pipeline -> heads) makes even `update-ref --no-deref` create a
// branch. This writer never resolves the name through a link:
// - every directory from the common dir's refs/ down to the ref's parent is
//   opened, or created, RELATIVE TO ITS PARENT'S DESCRIPTOR with O_NOFOLLOW and
//   O_DIRECTORY (through /proc/self/fd/<parent>/<name>): a symlink or a file
//   anywhere in the chain refuses the write (unsafe namespace, WI-20);
// - <name>.lock is created with O_CREAT|O_EXCL|O_NOFOLLOW in the pinned parent:
//   the same lock git takes, so git and this writer exclude each other. Under
//   it, the name must not exist (as a file, a symlink, a symref or a directory)
//   and packed-refs must hold neither the name nor a directory/file conflict
//   with it, as for git's `create`;
// - the object id is written and fsynced, then linked to the name (link(2)
//   never replaces an existing name). A filesystem without hard links is not
//   supported for program refs (review r2 #4): nothing is written, WI-13; a
//   plain rename could replace a name that appeared after the last check;
// - right after taking the lock, and before writing anything into it, the
//   writer records durably (a side file in the program's state, keyed by the
//   intent) the identity of the lock it created and of the directory it holds
//   (review r2 #2, #3). Recovery removes a leftover lock only when it is that
//   very file (the program never deletes a lock it cannot prove is its own),
//   and, when the ref is absent, finds a ref this writer linked into a
//   directory that was moved out of the namespace (reported, never redone or
//   deleted: WI-20);
// - before linking and again afterwards, the chain is resolved from the pinned
//   common dir and compared, directory by directory, with the descriptors the
//   writer holds. If a directory was renamed or replaced meanwhile, nothing is
//   linked, or the file this writer created is removed again (identified by its
//   inode), and the result is an unsafe namespace (WI-20): the program never
//   leaves a ref it created outside refs/mission-pipeline/.
// It writes no reflog (git writes none for this namespace unless
// core.logAllRefUpdates=always). It runs as its own process (refWriter-main.ts)
// so the writer's identity, the intent token on its command line, deadlines and
// kills work as for every external action (6.1). The reftable backend has no
// directories per ref; refs.ts uses `git update-ref --no-deref` there.

import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RefWriteJob {
  /** The repository's common git dir (absolute). The path itself may contain symlinks; nothing below it may. */
  readonly commonDir: string;
  /** The full ref name, e.g. refs/mission-pipeline/delivered/m1/op1 (validated by refs.ts). */
  readonly name: string;
  /** The object id the ref is created with. */
  readonly target: string;
  /** fsync the ref file and the directories (core.fsync=committed semantics). */
  readonly fsync: boolean;
  /**
   * The durable write record (review r2 #2, #3): a file in the program's state,
   * written after the lock is taken and before anything is written into it.
   * Without it recovery can never prove a leftover lock is the program's.
   */
  readonly record?: string;
  /**
   * Tests only: stop at each of these points until `<file>.go-<point>` exists
   * (`<file>.paused-<point>` is created when stopped), so a test can kill the
   * writer or change the filesystem at an exact point.
   */
  readonly pause?: { readonly at: readonly RefWritePoint[]; readonly file: string };
  /** Tests only: link(2) fails with this error code (a filesystem without hard links). */
  readonly testFailLink?: string;
}

export type RefWritePoint = 'after-lock' | 'before-link' | 'after-link';

/** What the writer records before it writes (review r2 #2, #3). */
export interface RefWriteRecord {
  readonly v: 1;
  readonly name: string;
  readonly leaf: string;
  readonly target: string;
  /** The directory the writer holds and links into. */
  readonly dir: { readonly dev: number; readonly ino: number };
  /** The lock file it created (O_EXCL): the only lock recovery may remove. */
  readonly lock: { readonly dev: number; readonly ino: number; readonly birthtimeMs: number };
  readonly pid: number;
}

export type RefWriteResult =
  | { readonly kind: 'created'; readonly dev: number; readonly ino: number }
  /** The name exists (loose or packed), or conflicts with an existing ref as a directory or a file. */
  | { readonly kind: 'exists'; readonly detail: string }
  /** `<name>.lock` exists: another writer, or one that was killed (6.1 v34). */
  | { readonly kind: 'locked'; readonly lock: string }
  /** A symlink or a file in the namespace's directory chain, or a directory replaced during the write (WI-20). */
  | { readonly kind: 'unsafe-namespace'; readonly detail: string; readonly removedOwnRef: boolean }
  /** review r2 #4: the filesystem has no hard links: no ref is created there (WI-13). */
  | { readonly kind: 'unsupported-filesystem'; readonly detail: string };

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const LOCK_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

function at(fd: number, name: string): string {
  return `/proc/self/fd/${fd}/${name}`;
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

/** The directory components below the common dir (refs, mission-pipeline, ...) and the ref's own name. */
export function refPathParts(name: string): { readonly dirs: readonly string[]; readonly leaf: string } {
  const parts = name.split('/');
  if (parts.length < 2 || parts[0] !== 'refs' || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new TypeError(`not a ref name the writer accepts: ${name}`);
  }
  return { dirs: parts.slice(0, -1), leaf: parts[parts.length - 1] as string };
}

type Chain = { readonly ok: true; readonly fds: number[] } | { readonly ok: false; readonly fds: number[]; readonly problem: string | null; readonly missing: string | null };

/**
 * Opens refs/... down to the ref's parent, each relative to its parent's
 * descriptor, never following a link. `create`: missing directories are made.
 */
function openChain(commonFd: number, dirs: readonly string[], create: boolean, fsync: boolean): Chain {
  const fds: number[] = [];
  let cur = commonFd;
  let path = '';
  for (const d of dirs) {
    path = path === '' ? d : `${path}/${d}`;
    let fd: number | null = null;
    for (let tries = 0; fd === null; tries++) {
      try {
        fd = openSync(at(cur, d), DIR_FLAGS);
      } catch (e) {
        const code = errCode(e);
        if (code === 'ENOENT' && create && tries < 3) {
          try {
            mkdirSync(at(cur, d), 0o777);
            if (fsync) fsyncSync(cur);
          } catch (m) {
            if (errCode(m) !== 'EEXIST') throw m;
          }
          continue;
        }
        if (code === 'ENOENT') return { ok: false, fds, problem: null, missing: path };
        if (code === 'ENOTDIR' || code === 'ELOOP') return { ok: false, fds, problem: `${path} is not a directory (a symlink or a file where the program's namespace needs a directory)`, missing: null };
        throw e;
      }
    }
    fds.push(fd);
    cur = fd;
  }
  return { ok: true, fds };
}

function closeAll(fds: readonly number[]): void {
  for (const fd of fds) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/** Null when every directory of the chain, resolved again from the common dir now, is the one the writer holds. */
function chainChanged(commonFd: number, dirs: readonly string[], fds: readonly number[]): string | null {
  let p = `/proc/self/fd/${commonFd}`;
  let rel = '';
  for (let i = 0; i < dirs.length; i++) {
    p = `${p}/${dirs[i]}`;
    rel = rel === '' ? (dirs[i] as string) : `${rel}/${dirs[i]}`;
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return `${rel} was removed or renamed during the write`;
    }
    if (!st.isDirectory()) return `${rel} was replaced by a symlink or a file during the write`;
    const pinned = fstatSync(fds[i] as number);
    if (st.dev !== pinned.dev || st.ino !== pinned.ino) return `${rel} was replaced by another directory during the write`;
  }
  return null;
}

/** git's `create` refuses a name that exists packed, or that conflicts with a packed ref as a directory or a file. */
function packedConflict(commonFd: number, name: string): string | null {
  let buf: Buffer;
  try {
    buf = readFileSync(at(commonFd, 'packed-refs'));
  } catch (e) {
    if (errCode(e) === 'ENOENT') return null;
    throw e;
  }
  for (const line of buf.toString('utf8').split('\n')) {
    if (line === '' || line.startsWith('#') || line.startsWith('^')) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const ref = line.slice(sp + 1).trimEnd();
    if (ref === name) return `${name} exists in packed-refs`;
    if (ref.startsWith(`${name}/`)) return `${ref} exists in packed-refs below ${name}`;
    if (name.startsWith(`${ref}/`)) return `${ref} exists in packed-refs where ${name} needs a directory`;
  }
  return null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pauseIfAsked(job: RefWriteJob, where: RefWritePoint): void {
  if (job.pause === undefined || !job.pause.at.includes(where)) return;
  writeFileSync(`${job.pause.file}.paused-${where}`, '');
  while (!existsSync(`${job.pause.file}.go-${where}`)) sleepSync(10);
}

/** Writes `path` so that it either exists complete or not at all: temporary file, fsync, rename, directory fsync. */
function writeDurably(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    const data = Buffer.from(text, 'utf8');
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dfd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

function removeRecord(job: RefWriteJob): void {
  if (job.record === undefined) return;
  try {
    unlinkSync(job.record);
  } catch {
    /* gone */
  }
}

/** Reads a write record; null when there is none or it is not one. */
export function readRefWriteRecord(path: string): RefWriteRecord | null {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8')) as RefWriteRecord;
    return r.v === 1 && typeof r.name === 'string' && typeof r.dir?.ino === 'number' && typeof r.lock?.ino === 'number' ? r : null;
  } catch {
    return null;
  }
}

/** Creates `job.name` -> `job.target` as a loose ref, only if it does not exist (see the header). */
export function writeLooseRef(job: RefWriteJob): RefWriteResult {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(job.target)) throw new TypeError(`bad object id ${job.target}`);
  const { dirs, leaf } = refPathParts(job.name);
  if (existsSync(`${job.commonDir}/reftable`)) throw new Error('the repository uses the reftable backend: this writer only writes loose refs');
  const commonFd = openSync(job.commonDir, constants.O_RDONLY | constants.O_DIRECTORY);
  const held: number[] = [commonFd];
  try {
    const chain = openChain(commonFd, dirs, true, job.fsync);
    held.push(...chain.fds);
    if (!chain.ok) return { kind: 'unsafe-namespace', detail: chain.problem ?? `${chain.missing} could not be created`, removedOwnRef: false };
    const dirFd = chain.fds[chain.fds.length - 1] as number;
    const lockName = `${leaf}.lock`;
    let lockFd = -1;
    try {
      lockFd = openSync(at(dirFd, lockName), LOCK_FLAGS, 0o666);
    } catch (e) {
      if (errCode(e) === 'EEXIST') return { kind: 'locked', lock: `${job.commonDir}/${job.name}.lock` };
      throw e;
    }
    let lockHeld = true;
    let created: { dev: number; ino: number } | null = null;
    let finished = false;
    try {
      // Before anything is written into the lock: what it is and where it is (review r2 #2, #3).
      if (job.record !== undefined) {
        const ls = fstatSync(lockFd);
        const ds = fstatSync(dirFd);
        const rec: RefWriteRecord = {
          v: 1,
          name: job.name,
          leaf,
          target: job.target,
          dir: { dev: ds.dev, ino: ds.ino },
          lock: { dev: ls.dev, ino: ls.ino, birthtimeMs: ls.birthtimeMs },
          pid: process.pid,
        };
        writeDurably(job.record, JSON.stringify(rec));
      }
      pauseIfAsked(job, 'after-lock');
      // Under the lock: the name must not exist in any form.
      try {
        lstatSync(at(dirFd, leaf));
        return { kind: 'exists', detail: `${job.name} exists` };
      } catch (e) {
        if (errCode(e) !== 'ENOENT') throw e;
      }
      const packed = packedConflict(commonFd, job.name);
      if (packed !== null) return { kind: 'exists', detail: packed };
      const data = Buffer.from(`${job.target}\n`, 'utf8');
      let off = 0;
      while (off < data.length) off += writeSync(lockFd, data, off, data.length - off);
      if (job.fsync) fsyncSync(lockFd);
      const st = fstatSync(lockFd);
      closeSync(lockFd);
      lockFd = -1;
      const before = chainChanged(commonFd, dirs, chain.fds);
      if (before !== null) return { kind: 'unsafe-namespace', detail: before, removedOwnRef: false };
      pauseIfAsked(job, 'before-link');
      try {
        if (job.testFailLink !== undefined) throw Object.assign(new Error(`injected ${job.testFailLink}`), { code: job.testFailLink });
        linkSync(at(dirFd, lockName), at(dirFd, leaf));
      } catch (e) {
        const code = errCode(e);
        if (code === 'EEXIST') return { kind: 'exists', detail: `${job.name} appeared while it was being created` };
        if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EMLINK' || code === 'ENOSYS') {
          // review r2 #4: without link(2) there is no atomic "create, never replace": no program ref here.
          return { kind: 'unsupported-filesystem', detail: `the filesystem of ${job.commonDir} does not support hard links (${code}): the program creates no ref there` };
        }
        throw e;
      }
      created = { dev: st.dev, ino: st.ino };
      pauseIfAsked(job, 'after-link');
      if (lockHeld) {
        unlinkSync(at(dirFd, lockName));
        lockHeld = false;
      }
      if (job.fsync) fsyncSync(dirFd);
      const after = chainChanged(commonFd, dirs, chain.fds);
      if (after !== null) {
        // The file this writer created may now sit outside the namespace: remove it again, by inode.
        let removed = false;
        try {
          const now = lstatSync(at(dirFd, leaf));
          if (now.dev === created.dev && now.ino === created.ino) {
            unlinkSync(at(dirFd, leaf));
            if (job.fsync) fsyncSync(dirFd);
            removed = true;
          }
        } catch {
          /* already gone */
        }
        finished = true;
        return { kind: 'unsafe-namespace', detail: after, removedOwnRef: removed };
      }
      finished = true;
      return { kind: 'created', dev: created.dev, ino: created.ino };
    } finally {
      if (lockFd >= 0) {
        try {
          closeSync(lockFd);
        } catch {
          /* closed */
        }
      }
      if (lockHeld) {
        try {
          unlinkSync(at(dirFd, lockName));
          lockHeld = false;
        } catch {
          /* gone */
        }
      }
      // The writer ended normally: its lock is gone (or never linked), so its record proves nothing any more.
      if (!lockHeld && (finished || created === null)) removeRecord(job);
    }
  } finally {
    closeAll(held);
  }
}

/**
 * Read-only: whether the namespace directories that exist on the way to `name`
 * are real directories (none a symlink or a file). Null when they are; missing
 * directories are fine (nothing is there yet).
 */
export function refNamespaceProblem(commonDir: string, name: string): string | null {
  const { dirs } = refPathParts(name);
  let commonFd: number;
  try {
    commonFd = openSync(commonDir, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (e) {
    return `the common dir ${commonDir} cannot be opened: ${errCode(e) ?? String(e)}`;
  }
  const chain = openChain(commonFd, dirs, false, false);
  closeAll([commonFd, ...chain.fds]);
  return chain.ok ? null : chain.problem;
}

/**
 * Removes `<name>.lock` without following a link anywhere on the way, and only
 * when it is the recorded lock (`expect`: device, inode, birth time; review r2
 * #3). Returns whether a lock was removed; refuses (throws) when the namespace
 * is unsafe or the lock is not the recorded one.
 */
export function unlinkLooseRefLock(commonDir: string, name: string, expect: RefWriteRecord['lock']): boolean {
  const { dirs, leaf } = refPathParts(name);
  const commonFd = openSync(commonDir, constants.O_RDONLY | constants.O_DIRECTORY);
  const chain = openChain(commonFd, dirs, false, false);
  try {
    if (!chain.ok) {
      if (chain.problem !== null) throw new Error(`refusing to remove a lock through an unsafe namespace: ${chain.problem}`);
      return false;
    }
    const dirFd = chain.fds[chain.fds.length - 1] as number;
    try {
      const st = lstatSync(at(dirFd, `${leaf}.lock`));
      if (!st.isFile()) throw new Error(`${name}.lock is not a regular file`);
      if (st.dev !== expect.dev || st.ino !== expect.ino || st.birthtimeMs !== expect.birthtimeMs) {
        throw new Error(`${name}.lock is not the lock the program's writer created: it is never removed`);
      }
      unlinkSync(at(dirFd, `${leaf}.lock`));
      return true;
    } catch (e) {
      if (errCode(e) === 'ENOENT') return false;
      throw e;
    }
  } finally {
    closeAll([commonFd, ...chain.fds]);
  }
}

/**
 * review r2 #2: after a writer crashed with the ref absent from the namespace,
 * where the ref it linked ended up: a file named like the ref, in the directory
 * the writer held (same device and inode), anywhere under refs/ (links are not
 * followed); or a packed ref with that last component and the writer's target.
 * Returns refs/-relative names outside refs/mission-pipeline/; empty when none.
 */
export function findEscapedRef(commonDir: string, rec: RefWriteRecord): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > 64) return;
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const n of names) {
      const childAbs = `${abs}/${n}`;
      let st;
      try {
        st = lstatSync(childAbs);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const childRel = `${rel}/${n}`;
      if (st.dev === rec.dir.dev && st.ino === rec.dir.ino) {
        try {
          if (lstatSync(`${childAbs}/${rec.leaf}`).isFile()) out.push(`${childRel}/${rec.leaf}`);
        } catch {
          /* not there */
        }
      }
      walk(childAbs, childRel, depth + 1);
    }
  };
  walk(`${commonDir}/refs`, 'refs', 0);
  try {
    for (const line of readFileSync(`${commonDir}/packed-refs`, 'utf8').split('\n')) {
      if (line === '' || line.startsWith('#') || line.startsWith('^')) continue;
      const sp = line.indexOf(' ');
      const oid = line.slice(0, sp);
      const ref = line.slice(sp + 1).trimEnd();
      if (oid === rec.target && ref !== rec.name && ref.split('/').pop() === rec.leaf) out.push(ref);
    }
  } catch {
    /* no packed-refs */
  }
  return [...new Set(out)].filter((r) => !r.startsWith('refs/mission-pipeline/')).sort();
}

/**
 * review r2 #3: the leftover lock of `name` is the very file the recorded writer
 * created (device, inode and birth time). Only then may recovery remove it.
 */
export function lockIsRecorded(commonDir: string, name: string, rec: RefWriteRecord | null): boolean {
  if (rec === null || rec.name !== name) return false;
  try {
    const st = lstatSync(`${commonDir}/${name}.lock`);
    return st.isFile() && st.dev === rec.lock.dev && st.ino === rec.lock.ino && st.birthtimeMs === rec.lock.birthtimeMs;
  } catch {
    return false;
  }
}
