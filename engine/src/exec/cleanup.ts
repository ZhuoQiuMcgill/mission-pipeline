// Cleanup of an execution unit, as progressing state separate from its termination proof
// (design v35 7.1, 6.3, 6.4). The proof holds immutable facts only; what the unit leaves
// behind (its cgroup, mounts, image files, network grants, temporary paths, a sandbox holder
// that might have escaped) is recorded per launch as cleanup state:
//     pending (resources left) -> pending (fewer) -> done   (done is terminal)
// The supervisor tries the teardown itself; whatever is left is finished later by the
// scheduler with completeCleanup, once the supervisor is confirmed gone. "Stopped" (6.4)
// is reported only when the cleanup of every unit in scope is done.
//
// A resource is one string, "<kind>[@<dev>.<ino>]:<value>":
//   holder:<pid>:<startTime>:<bootId>   a sandbox holder process (identity per 6.3)
//   cgroup:<absolute cgroupfs path>     the unit's cgroup subtree
//   mount:<absolute path>               a FUSE mount point (large-disk image)
//   image[@dev.ino]:<absolute path>     a disk image file
//   grant[@dev.ino]:<absolute path>     a network grant file a fetch proxy honors
//   path[@dev.ino]:<absolute path>      a temporary file or directory
// Values after the first colon are taken verbatim (paths may contain colons). The optional
// "@dev.ino" is the identity the entry had when it was registered (recordIdentities): cleanup
// deletes that very file or directory, or nothing.
//
// Deleting safely (code review r1 finding 1; design 3.11 "不删除用户的数据"):
//  - a filesystem resource must lie under one of the policy's roots. The roots' ancestors are
//    the program's own configured directories and are trusted; from each root's last
//    component down, every component is opened without following symbolic links, each one
//    relative to the directory opened before it (/proc/self/fd/<fd>/<name>, the openat
//    semantics). A symbolic link or a non-directory on the way refuses the resource; it
//    stays pending and an anomaly is reported;
//  - a filesystem resource is deleted only with a registered identity (dev, ino), recorded
//    when the resource was created or when its unit started; an existing entry without one is
//    refused as "identity-unknown" and kept (WI-20): it may not be the unit's (code review r2
//    finding 1);
//  - the final check happens where nothing can replace the entry any more: the entry is renamed
//    atomically into a private quarantine directory beside it, checked there, and deleted
//    there; an entry that turns out not to be the registered one is put back without replacing
//    anything (or kept in the quarantine), and the resource stays pending;
//  - a directory is emptied through its own descriptor, entry by entry, never leaving the
//    file system it is on (a different st_dev, or any mount point under it, refuses);
//  - no realpath pre-check is relied on: every operation acts inside a directory that was
//    reached without following links, so a concurrent replacement can at worst make an
//    operation hit another entry INSIDE the verified tree, never outside it.
//
// Releasing in dependency order (finding 2; 6.4, 7.1 v35): mount -> image -> paths. An
// image is deleted only when no mount of the launch remains, no mount uses it, no process
// still holds it open or mapped and it has no other name (its space is only free then); an
// image whose name is already gone counts as released only when no process holds its inode. A path is deleted only when no
// other remaining resource lies at or under it. Until then the resource stays listed, so the
// capacity it holds stays counted.

import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  type BigIntStats,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, posix } from 'node:path';
import type { LaunchId } from '../common/ids.ts';
import { CGROUP_FS, Cgroup } from './cgroup.ts';
import { REAL_DURABLE_OPS, ensureDirChainDurable, unlinkDurable, writeDurable, type DurableOps } from './durable.ts';
import { findTool } from './platform.ts';

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = constants;

/** dev and ino of a file system entry, as decimal strings (exact; 64-bit). */
export interface FsIdentity {
  readonly dev: string;
  readonly ino: string;
}

type FsKind = 'mount' | 'image' | 'grant' | 'path';

export type CleanupResource =
  | { readonly kind: 'holder'; readonly pid: number; readonly startTime: number; readonly bootId: string }
  | { readonly kind: 'cgroup'; readonly path: string }
  | { readonly kind: FsKind; readonly path: string; readonly identity?: FsIdentity };

export type CleanupState = 'pending' | 'done';

export class CleanupResourceError extends Error {
  override readonly name = 'CleanupResourceError';
}

function absPath(v: string, what: string): string {
  if (v === '' || !posix.isAbsolute(v) || posix.normalize(v) !== v || v === '/' || v.includes('\0') || v.endsWith('/')) {
    throw new CleanupResourceError(`bad ${what} path ${JSON.stringify(v)}`);
  }
  return v;
}

export function formatCleanupResource(r: CleanupResource): string {
  switch (r.kind) {
    case 'holder':
      return `holder:${r.pid}:${r.startTime}:${r.bootId}`;
    case 'cgroup':
      return `cgroup:${r.path}`;
    default:
      return r.identity !== undefined ? `${r.kind}@${r.identity.dev}.${r.identity.ino}:${r.path}` : `${r.kind}:${r.path}`;
  }
}

export function parseCleanupResource(s: string): CleanupResource {
  const i = s.indexOf(':');
  if (i <= 0) throw new CleanupResourceError(`bad cleanup resource ${JSON.stringify(s)}`);
  const head = /^(holder|cgroup|mount|image|grant|path)(?:@(\d{1,20})\.(\d{1,20}))?$/.exec(s.slice(0, i));
  if (head === null) throw new CleanupResourceError(`unknown cleanup resource kind ${JSON.stringify(s.slice(0, i))}`);
  const kind = head[1] as CleanupResource['kind'];
  const identity = head[2] !== undefined && head[3] !== undefined ? { dev: head[2], ino: head[3] } : undefined;
  const v = s.slice(i + 1);
  if (identity !== undefined && (kind === 'holder' || kind === 'cgroup' || kind === 'mount')) {
    throw new CleanupResourceError(`a ${kind} resource carries no file identity: ${JSON.stringify(s)}`);
  }
  switch (kind) {
    case 'holder': {
      const m = /^(\d+):(\d+):([0-9a-f-]+)$/.exec(v);
      if (!m) throw new CleanupResourceError(`bad holder identity ${JSON.stringify(v)}`);
      return { kind, pid: Number(m[1]), startTime: Number(m[2]), bootId: m[3] as string };
    }
    case 'cgroup': {
      const p = absPath(v, 'cgroup');
      if (!p.startsWith(`${CGROUP_FS}/`)) throw new CleanupResourceError(`cgroup ${p} is not under ${CGROUP_FS}`);
      return { kind, path: p };
    }
    default:
      return { kind, path: absPath(v, kind), ...(identity !== undefined ? { identity } : {}) };
  }
}

// ---------------------------------------------------------------- policy

/**
 * Where completeCleanup may act: filesystem resources must lie under one of `roots` (the
 * program's state and scratch directories, or the configured resource paths themselves);
 * cgroups under the user's own manager tree. Anything else is left and reported, never touched.
 */
export interface CleanupPolicy {
  readonly roots: readonly string[];
  /** Unmount only when not busy (default); "-z" lazy detach would hide a still-open image. */
  readonly lazyUnmount?: boolean;
  /** How long a held image is re-checked before it is reported busy (default 3 s: a FUSE daemon's exit). */
  readonly holderWaitMs?: number;
}

/** Why a resource was not released this time. */
export type RefusalReason =
  /** outside every root, or a cgroup that is not a program unit */
  | 'outside-policy'
  /** a symbolic link or a non-directory on the way below the root */
  | 'path-changed'
  /** the recorded identity does not match the entry found */
  | 'identity-mismatch'
  /** an existing entry was never registered with its identity: it may not be the unit's */
  | 'identity-unknown'
  /** a mount point (or another file system) inside a directory to delete */
  | 'mount-inside'
  /** still mounted, busy, held open, or another remaining resource depends on it */
  | 'busy'
  /** the operation failed (permissions, I/O); retried later */
  | 'failed';

export interface CleanupRefusal {
  readonly resource: string;
  readonly reason: RefusalReason;
  readonly detail: string;
}

class Refused extends Error {
  readonly reason: RefusalReason;
  constructor(reason: RefusalReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

function normRoot(r: string): string | null {
  const root = r.length > 1 && r.endsWith('/') ? r.slice(0, -1) : r;
  if (root === '' || root === '/' || !posix.isAbsolute(root) || posix.normalize(root) !== root || root.includes('\0')) return null;
  return root;
}

/** The longest root that `path` is (component-wise) at or under, and the components below it. */
function rootFor(path: string, roots: readonly string[]): { root: string; below: string[] } | null {
  let best: string | null = null;
  for (const r of roots) {
    const root = normRoot(r);
    if (root === null) continue;
    if ((path === root || path.startsWith(`${root}/`)) && (best === null || root.length > best.length)) best = root;
  }
  if (best === null) return null;
  return { root: best, below: path === best ? [] : path.slice(best.length + 1).split('/') };
}

const fdPath = (fd: number, name?: string): string => (name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`);

function openDirNoFollow(parentFd: number, name: string): number {
  return openSync(fdPath(parentFd, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}

function sameIdentity(st: BigIntStats, id: FsIdentity): boolean {
  return st.dev.toString() === id.dev && st.ino.toString() === id.ino;
}

function identityOf(st: BigIntStats): FsIdentity {
  return { dev: st.dev.toString(), ino: st.ino.toString() };
}

/**
 * Opens the directory holding the last component of `path` without following any link from
 * the root's last component down. null: some component does not exist (nothing to release).
 */
function openParent(path: string, roots: readonly string[]): { fd: number; name: string } | null {
  const at = rootFor(path, roots);
  if (at === null) throw new Refused('outside-policy', `${path} is not under the cleanup roots`);
  const comps = [basename(at.root), ...at.below];
  if (comps.some((c) => c === '' || c === '.' || c === '..')) throw new Refused('outside-policy', `bad path ${path}`);
  let fd: number;
  try {
    // the root's ancestors are the program's own configured directories (trusted)
    fd = openSync(dirname(at.root), O_RDONLY | O_DIRECTORY);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  for (const c of comps.slice(0, -1)) {
    let next: number;
    try {
      next = openDirNoFollow(fd, c);
    } catch (e) {
      closeQuietly(fd);
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      if (code === 'ELOOP' || code === 'ENOTDIR') throw new Refused('path-changed', `${path}: "${c}" is a symbolic link or not a directory`);
      throw e;
    }
    closeQuietly(fd);
    fd = next;
  }
  return { fd, name: comps.at(-1) as string };
}

function lstatAt(fd: number, name: string): BigIntStats | null {
  try {
    return lstatSync(fdPath(fd, name), { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
}

interface MountEntry {
  readonly mountPoint: string;
  readonly fstype: string;
  readonly source: string;
}

function mounts(): MountEntry[] {
  let text: string;
  try {
    text = readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return [];
  }
  const out: MountEntry[] = [];
  for (const l of text.split('\n')) {
    if (l === '') continue;
    const f = l.split(' ');
    const sep = f.indexOf('-');
    out.push({ mountPoint: unescapeMount(f[4] ?? ''), fstype: sep >= 0 ? (f[sep + 1] ?? '') : '', source: sep >= 0 ? unescapeMount(f[sep + 2] ?? '') : '' });
  }
  return out;
}

/** Empties the directory open at `dirFd` through descriptors only; never leaves its file system. */
function emptyDirectory(dirFd: number, dev: bigint): void {
  for (const name of readdirSync(fdPath(dirFd))) {
    const st = lstatAt(dirFd, name);
    if (st === null) continue;
    if (st.isDirectory()) {
      if (st.dev !== dev) throw new Refused('mount-inside', `a mount point or another file system inside the directory (${name})`);
      let child: number;
      try {
        child = openDirNoFollow(dirFd, name);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        if (code === 'ELOOP' || code === 'ENOTDIR') throw new Refused('path-changed', `${name} was replaced while being deleted`);
        throw e;
      }
      try {
        const fst = fstatSync(child, { bigint: true });
        if (fst.dev !== st.dev || fst.ino !== st.ino) throw new Refused('path-changed', `${name} was replaced while being deleted`);
        emptyDirectory(child, dev);
      } finally {
        closeQuietly(child);
      }
      rmdirSync(fdPath(dirFd, name));
    } else {
      unlinkSync(fdPath(dirFd, name));
    }
  }
}

/** A private directory beside the entry to remove: what is renamed into it can only be ours to check. */
function makeQuarantine(parentFd: number): { readonly fd: number; readonly name: string } {
  const name = `.mp-cleanup-q-${randomBytes(8).toString('hex')}`;
  mkdirSync(fdPath(parentFd, name), { mode: 0o700 });
  const fd = openDirNoFollow(parentFd, name);
  const st = fstatSync(fd, { bigint: true });
  if (!st.isDirectory() || Number(st.uid) !== (process.getuid?.() ?? -1) || (Number(st.mode) & 0o077) !== 0) {
    closeQuietly(fd);
    throw new Refused('path-changed', 'the quarantine directory is not private');
  }
  return { fd, name };
}

/**
 * Removes `name` from the directory open at `pfd`, bound to `identity` (code review r2 finding
 * 1). The entry is first renamed, atomically, into a private quarantine directory beside it;
 * only there, where nothing else can replace it, is its identity checked and the entry deleted.
 * An entry that is not the registered one (replaced after the last check) is put back without
 * replacing anything (link for a file; a directory only where the name is still free), or, if
 * that is not possible, kept in the quarantine directory; nothing that is not ours is deleted.
 * A directory is emptied through a descriptor first, and is only renamed once it is empty.
 */
function removeVerified(pfd: number, name: string, identity: FsIdentity, path: string, want: 'any' | 'file'): void {
  const st = lstatAt(pfd, name);
  if (st === null) return;
  if (!sameIdentity(st, identity)) throw new Refused('identity-mismatch', `${path} is now ${st.dev}.${st.ino}, registered as ${identity.dev}.${identity.ino}`);
  if (st.isDirectory()) {
    if (want === 'file') throw new Refused('path-changed', `${path} is a directory, registered as a file`);
    const parentDev = fstatSync(pfd, { bigint: true }).dev;
    if (st.dev !== parentDev) throw new Refused('mount-inside', `${path} is a mount point`);
    const dfd = openDirNoFollow(pfd, name);
    try {
      const fst = fstatSync(dfd, { bigint: true });
      if (!sameIdentity(fst, identity)) throw new Refused('identity-mismatch', `${path} was replaced while being opened`);
      const real = realpathSync(fdPath(dfd));
      const inside = mounts().filter((m) => m.mountPoint === real || m.mountPoint.startsWith(`${real}/`));
      if (inside.length > 0) throw new Refused('mount-inside', `${path} contains mount points (${inside.map((m) => m.mountPoint).join(', ')})`);
      emptyDirectory(dfd, st.dev);
    } finally {
      closeQuietly(dfd);
    }
  } else if (want === 'file' && !st.isFile()) {
    throw new Refused('path-changed', `${path} is not a regular file`);
  }
  const q = makeQuarantine(pfd);
  let keep = false;
  try {
    try {
      renameSync(fdPath(pfd, name), fdPath(q.fd, 'entry'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // gone meanwhile
      throw e;
    }
    const moved = lstatSync(fdPath(q.fd, 'entry'), { bigint: true });
    if (!sameIdentity(moved, identity)) {
      // not ours: back where it was, never over anything that took the name meanwhile
      let restored = false;
      if (!moved.isDirectory()) {
        try {
          linkSync(fdPath(q.fd, 'entry'), fdPath(pfd, name));
          unlinkSync(fdPath(q.fd, 'entry'));
          restored = true;
        } catch {
          /* the name is taken again, or the link is impossible */
        }
      } else if (lstatAt(pfd, name) === null) {
        try {
          renameSync(fdPath(q.fd, 'entry'), fdPath(pfd, name));
          restored = true;
        } catch {
          /* taken meanwhile */
        }
      }
      keep = !restored;
      throw new Refused(
        'identity-mismatch',
        `${path} was replaced right before its deletion (${moved.dev}.${moved.ino}, registered as ${identity.dev}.${identity.ino}); nothing was deleted${restored ? '' : `; the entry found is kept at ${join(dirname(path), q.name, 'entry')}`}`,
      );
    }
    if (moved.isDirectory()) rmdirSync(fdPath(q.fd, 'entry'));
    else unlinkSync(fdPath(q.fd, 'entry'));
  } finally {
    closeQuietly(q.fd);
    if (!keep) {
      try {
        rmdirSync(fdPath(pfd, q.name));
      } catch {
        /* not empty (kept), or already gone */
      }
    }
  }
}

/**
 * Deletes a file or a directory tree at `path`, identity-bound and without following links.
 * Without a registered identity an existing entry is never deleted (it may not be ours):
 * refused as "identity-unknown" and kept (WI-20).
 */
function removeEntry(path: string, identity: FsIdentity | undefined, policy: CleanupPolicy, want: 'any' | 'file'): boolean {
  const p = openParent(path, policy.roots);
  if (p === null) return true;
  try {
    const st = lstatAt(p.fd, p.name);
    if (st === null) return true;
    if (identity === undefined) throw new Refused('identity-unknown', `${path} exists but was never registered with its identity: it may not be this unit's`);
    removeVerified(p.fd, p.name, identity, path, want);
    return lstatAt(p.fd, p.name) === null || !sameIdentity(lstatAt(p.fd, p.name) as BigIntStats, identity);
  } finally {
    closeQuietly(p.fd);
  }
}

/** The identity of what is at `path` now, reached without following links below the root. */
export function identityAt(path: string, roots: readonly string[]): FsIdentity | null {
  let p: { fd: number; name: string } | null;
  try {
    p = openParent(path, roots);
  } catch {
    return null;
  }
  if (p === null) return null;
  try {
    const st = lstatAt(p.fd, p.name);
    return st === null || st.isSymbolicLink() ? null : identityOf(st);
  } finally {
    closeQuietly(p.fd);
  }
}

/**
 * Binds every filesystem resource (except mounts) to the identity of what is at its path now
 * (the supervisor does this before the unit runs). Resources not present yet, or not
 * reachable without following a link, are left as they are.
 */
export function recordIdentities(resources: readonly string[], policy: CleanupPolicy): string[] {
  return resources.map((s) => {
    let r: CleanupResource;
    try {
      r = parseCleanupResource(s);
    } catch {
      return s;
    }
    if (r.kind !== 'image' && r.kind !== 'grant' && r.kind !== 'path') return s;
    if (r.identity !== undefined) return s;
    const id = identityAt(r.path, policy.roots);
    return id === null ? s : formatCleanupResource({ ...r, identity: id });
  });
}

// ---------------------------------------------------------------- holders and cgroups

function bootId(): string {
  return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

function holderAlive(r: Extract<CleanupResource, { kind: 'holder' }>): boolean {
  if (r.bootId !== bootId()) return false;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${r.pid}/stat`, 'utf8');
  } catch {
    return false;
  }
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (f[0] === 'Z' || f[0] === 'X') return false;
  return Number(f[19]) === r.startTime;
}

/**
 * The only cgroups cleanup may destroy: the "unit" subtree of one of this program's transient
 * services (named mp-*.service) inside the calling user's own systemd manager tree. A bad
 * entry can never reach the user's other services or slices.
 */
export function isUnitCgroupPath(path: string): boolean {
  const uid = process.getuid?.() ?? -1;
  const root = `${CGROUP_FS}/user.slice/user-${uid}.slice/user@${uid}.service/`;
  if (!path.startsWith(root)) return false;
  const parts = path.slice(root.length).split('/');
  return parts.length >= 2 && parts.at(-1) === 'unit' && /^mp-[A-Za-z0-9_.:-]+\.service$/.test(parts.at(-2) ?? '');
}

// ---------------------------------------------------------------- mounts and images

/** The mount point a FUSE mount resource names, reached without following links; null if not mounted. */
function mountedAt(path: string, policy: CleanupPolicy): { fd: number; name: string; real: string } | null {
  const p = openParent(path, policy.roots);
  if (p === null) return null;
  const real = `${realpathSync(fdPath(p.fd))}/${p.name}`;
  if (!mounts().some((m) => m.mountPoint === real)) {
    closeQuietly(p.fd);
    return null;
  }
  return { fd: p.fd, name: p.name, real };
}

/** Unmounts through the verified parent directory: fusermount gets it as fd 3 and the name below it. */
async function unmountAt(fd: number, name: string, lazy: boolean): Promise<void> {
  const tools = [findTool('fusermount3'), findTool('fusermount')].filter((t): t is string => t !== null);
  for (const t of tools) {
    const ok = await new Promise<boolean>((resolve) => {
      const c = spawn(t, [lazy ? '-uz' : '-u', `/proc/self/fd/3/${name}`], { stdio: ['ignore', 'ignore', 'pipe', fd] });
      const timer = setTimeout(() => c.kill('SIGKILL'), 30_000);
      c.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      c.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
    if (ok) return;
  }
}

function devMajorMinor(dev: bigint): { major: bigint; minor: bigint } {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  return { major, minor };
}

/** Processes (of this user, the ones /proc lets us see) that hold the file open or mapped. */
export function processesHolding(id: FsIdentity): number[] {
  const dev = BigInt(id.dev);
  const { major, minor } = devMajorMinor(dev);
  const mapDev = `${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}`;
  const holders: number[] = [];
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return holders;
  }
  for (const pid of pids) {
    let held = false;
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        let st: BigIntStats | undefined;
        try {
          st = statSync(`/proc/${pid}/fd/${fd}`, { bigint: true, throwIfNoEntry: false });
        } catch {
          continue;
        }
        if (st !== undefined && st.dev === dev && st.ino.toString() === id.ino) {
          held = true;
          break;
        }
      }
    } catch {
      /* not ours, or gone */
    }
    if (!held) {
      try {
        held = readFileSync(`/proc/${pid}/maps`, 'utf8')
          .split('\n')
          .some((l) => {
            const f = l.split(/\s+/);
            return f[3] === mapDev && f[4] === id.ino;
          });
      } catch {
        /* not ours, or gone */
      }
    }
    if (held) holders.push(Number(pid));
  }
  return holders;
}

function describeProcess(pid: number): string {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    return `process ${pid} (${cmd.slice(0, 200)})`;
  } catch {
    return `process ${pid}`;
  }
}

/**
 * An image file is released only when nothing uses it any more (its space is free only then).
 * A FUSE daemon lets go of its image a moment after the unmount: holders are re-checked for up
 * to `holderWaitMs` before the image is reported busy.
 */
async function releaseImage(r: Extract<CleanupResource, { kind: FsKind }>, policy: CleanupPolicy): Promise<boolean> {
  const waitHolders = async (id: FsIdentity): Promise<number[]> => {
    let holders = processesHolding(id);
    for (const deadline = Date.now() + (policy.holderWaitMs ?? 3_000); holders.length > 0 && Date.now() < deadline; holders = processesHolding(id)) {
      await new Promise((res) => setTimeout(res, 100));
    }
    return holders;
  };
  const p = openParent(r.path, policy.roots);
  let st: BigIntStats | null = null;
  try {
    if (p !== null) st = lstatAt(p.fd, p.name);
    if (st === null) {
      // the name is gone, but the image's space is free only when its inode is (code review r2
      // finding 2): with a registered identity, no process may still hold it open or mapped
      if (r.identity === undefined) return true;
      const holders = await waitHolders(r.identity);
      if (holders.length > 0) throw new Refused('busy', `${r.path} is gone, but its inode ${r.identity.dev}.${r.identity.ino} is still held by ${holders.map(describeProcess).join(', ')}`);
      return true;
    }
    const at = p as { fd: number; name: string };
    if (r.identity === undefined) throw new Refused('identity-unknown', `${r.path} exists but was never registered with its identity: it may not be this unit's`);
    if (!sameIdentity(st, r.identity)) {
      throw new Refused('identity-mismatch', `${r.path} is now ${st.dev}.${st.ino}, registered as ${r.identity.dev}.${r.identity.ino}`);
    }
    if (!st.isFile()) throw new Refused('path-changed', `${r.path} is not a regular file`);
    if (st.nlink > 1n) throw new Refused('busy', `${r.path} has ${st.nlink} names: deleting this one would not free its space`);
    const real = `${realpathSync(fdPath(at.fd))}/${at.name}`;
    const using = mounts().filter((m) => m.source === real);
    if (using.length > 0) throw new Refused('busy', `${r.path} is still mounted at ${using.map((m) => m.mountPoint).join(', ')}`);
    const holders = await waitHolders(identityOf(st));
    if (holders.length > 0) throw new Refused('busy', `${r.path} is still open in ${holders.map(describeProcess).join(', ')}`);
    removeVerified(at.fd, at.name, r.identity, r.path, 'file');
    return lstatAt(at.fd, at.name) === null || !sameIdentity(lstatAt(at.fd, at.name) as BigIntStats, r.identity);
  } finally {
    if (p !== null) closeQuietly(p.fd);
  }
}

/** Releases one resource; true when it is gone afterwards (or was never there). Idempotent. */
export async function releaseResource(r: CleanupResource, policy: CleanupPolicy): Promise<boolean> {
  return (await release(r, policy)).gone;
}

async function release(r: CleanupResource, policy: CleanupPolicy): Promise<{ gone: boolean; refusal: Omit<CleanupRefusal, 'resource'> | null }> {
  try {
    switch (r.kind) {
      case 'holder': {
        if (!holderAlive(r)) return { gone: true, refusal: null };
        try {
          process.kill(r.pid, 'SIGKILL');
        } catch {
          /* gone or not ours */
        }
        for (let i = 0; i < 50 && holderAlive(r); i++) await new Promise((res) => setTimeout(res, 20));
        return holderAlive(r) ? { gone: false, refusal: { reason: 'busy', detail: `holder ${r.pid} did not end` } } : { gone: true, refusal: null };
      }
      case 'cgroup': {
        if (!isUnitCgroupPath(r.path)) return { gone: false, refusal: { reason: 'outside-policy', detail: `${r.path} is not a program unit cgroup` } };
        if (!existsSync(r.path)) return { gone: true, refusal: null };
        try {
          await Cgroup.at(r.path).destroy(10_000);
        } catch {
          /* reported as left */
        }
        return existsSync(r.path) ? { gone: false, refusal: { reason: 'failed', detail: `${r.path} could not be removed` } } : { gone: true, refusal: null };
      }
      case 'mount': {
        let at = mountedAt(r.path, policy);
        if (at === null) return { gone: true, refusal: null };
        try {
          await unmountAt(at.fd, at.name, policy.lazyUnmount === true);
        } finally {
          closeQuietly(at.fd);
        }
        at = mountedAt(r.path, policy);
        if (at === null) return { gone: true, refusal: null };
        closeQuietly(at.fd);
        return { gone: false, refusal: { reason: 'busy', detail: `${r.path} is still mounted (busy)` } };
      }
      case 'image':
        return { gone: await releaseImage(r, policy), refusal: null };
      case 'grant':
      case 'path':
        return { gone: removeEntry(r.path, r.identity, policy, 'any'), refusal: null };
    }
  } catch (e) {
    if (e instanceof Refused) return { gone: false, refusal: { reason: e.reason, detail: e.message } };
    return { gone: false, refusal: { reason: 'failed', detail: (e as Error).message } };
  }
}

function fsPathOf(r: CleanupResource): string | null {
  return r.kind === 'holder' || r.kind === 'cgroup' ? null : r.path;
}

function atOrUnder(p: string, dir: string): boolean {
  return p === dir || p.startsWith(`${dir}/`);
}

export interface CleanupPass {
  /** The encoded resources still left (a subset, in their original order). */
  readonly left: string[];
  /** Why each left resource was not released (unparsable entries included). */
  readonly refusals: readonly CleanupRefusal[];
}

/**
 * Finishes a launch's cleanup: releases every resource it can, in dependency order, and
 * returns the encoded resources still left (in their original order). Safe to run any number
 * of times, from any process of the same user; an unparsable entry is kept and reported,
 * never acted on.
 */
export async function completeCleanup(resources: readonly string[], policy: CleanupPolicy): Promise<string[]> {
  return (await cleanupPass(resources, policy)).left;
}

/** completeCleanup with the reason for every resource left. */
export async function cleanupPass(resources: readonly string[], policy: CleanupPolicy): Promise<CleanupPass> {
  const refusals: CleanupRefusal[] = [];
  const parsed: { s: string; r: CleanupResource }[] = [];
  for (const s of resources) {
    try {
      parsed.push({ s, r: parseCleanupResource(s) });
    } catch (e) {
      refusals.push({ resource: s, reason: 'outside-policy', detail: (e as Error).message });
    }
  }
  // The same path listed with and without an identity is one resource: the identity binds it.
  const byKey = new Map<string, { r: CleanupResource; entries: string[] }>();
  for (const { s, r } of parsed) {
    const key = r.kind === 'holder' ? s : `${r.kind}:${r.path}`;
    const g = byKey.get(key);
    if (g === undefined) byKey.set(key, { r, entries: [s] });
    else {
      g.entries.push(s);
      if ('identity' in r && r.identity !== undefined && !('identity' in g.r && g.r.identity !== undefined)) g.r = r;
      else if ('identity' in r && r.identity !== undefined && 'identity' in g.r && g.r.identity !== undefined && (g.r.identity.dev !== r.identity.dev || g.r.identity.ino !== r.identity.ino)) {
        // two different identities for one path: neither can be trusted
        g.r = { ...r, identity: { dev: 'conflict', ino: 'conflict' } };
      }
    }
  }
  const groups = [...byKey.values()];
  const gone = new Set<string>();
  const remaining = (): CleanupResource[] => groups.filter((g) => !g.entries.every((e) => gone.has(e))).map((g) => g.r);
  const refuse = (g: { entries: string[] }, reason: RefusalReason, detail: string): void => {
    for (const e of g.entries) refusals.push({ resource: e, reason, detail });
  };
  const run = async (g: { r: CleanupResource; entries: string[] }): Promise<void> => {
    if ('identity' in g.r && g.r.identity?.dev === 'conflict') {
      refuse(g, 'identity-mismatch', `${g.r.path} is listed with two different identities`);
      return;
    }
    const out = await release(g.r, policy);
    if (out.gone) for (const e of g.entries) gone.add(e);
    else refuse(g, out.refusal?.reason ?? 'failed', out.refusal?.detail ?? 'not released');
  };
  const of = (k: CleanupResource['kind']) => groups.filter((g) => g.r.kind === k);

  for (const g of of('holder')) await run(g);
  for (const g of of('cgroup')) await run(g);
  for (const g of of('mount')) await run(g);
  for (const g of of('image')) {
    const mountsLeft = remaining().filter((x) => x.kind === 'mount');
    if (mountsLeft.length > 0) {
      refuse(g, 'busy', `waits for the unmount of ${mountsLeft.map((m) => (m as { path: string }).path).join(', ')}`);
      continue;
    }
    await run(g);
  }
  for (const g of of('grant')) await run(g);
  // deeper paths first, so nested path resources go before the directories that hold them
  const paths = of('path').sort((a, b) => (b.r as { path: string }).path.length - (a.r as { path: string }).path.length);
  for (const g of paths) {
    const dir = (g.r as { path: string }).path;
    const inside = remaining().filter((x) => x !== g.r && fsPathOf(x) !== null && atOrUnder(fsPathOf(x) as string, dir));
    if (inside.length > 0) {
      refuse(g, 'busy', `waits for ${inside.map((x) => formatCleanupResource(x)).join(', ')}`);
      continue;
    }
    await run(g);
  }
  const left = resources.filter((s) => !gone.has(s));
  return { left, refusals: refusals.filter((x) => left.includes(x.resource)) };
}

// ---------------------------------------------------------------- local cleanup state (scanned like proof files)

export interface CleanupFile {
  readonly format: 'mp4.unit-cleanup.v1';
  readonly launch: LaunchId;
  readonly state: CleanupState;
  readonly resources: readonly string[];
  /** Whether the ledger has this state (recordCleanup confirmed). */
  readonly recorded: boolean;
  readonly at: string;
}

export function cleanupDir(stateDir: string): string {
  return join(stateDir, 'cleanup');
}

/** Written atomically into a directory chain made durable first (finding 12). */
export function writeCleanupFile(stateDir: string, file: CleanupFile, ops: DurableOps = REAL_DURABLE_OPS): string {
  ensureDirChainDurable(cleanupDir(stateDir), stateDir, ops);
  const path = join(cleanupDir(stateDir), `${file.launch}.json`);
  writeDurable(path, `${JSON.stringify(file, null, 2)}\n`, ops);
  return path;
}

export function removeCleanupFile(stateDir: string, launch: LaunchId): void {
  unlinkDurable(join(cleanupDir(stateDir), `${launch}.json`));
}

/** Cleanup states left in a state directory (unrecorded or still pending), for the scheduler. */
export function scanCleanupFiles(stateDir: string): CleanupFile[] {
  let names: string[];
  try {
    names = readdirSync(cleanupDir(stateDir));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: CleanupFile[] = [];
  for (const n of names.sort()) {
    if (n.startsWith('.') || !n.endsWith('.json')) continue;
    try {
      const f = JSON.parse(readFileSync(join(cleanupDir(stateDir), n), 'utf8')) as CleanupFile;
      if (f.format === 'mp4.unit-cleanup.v1' && Array.isArray(f.resources)) out.push(f);
    } catch {
      /* an interrupted write leaves no file: writeDurable */
    }
  }
  return out;
}
