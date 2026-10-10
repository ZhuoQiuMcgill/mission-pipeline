// Writable areas that outlive the processes using them (design 7.1: capped tmpfs areas for
// the tool sandbox and for the Claude Code process; 6.2: a session state that can be read
// after its process ended).
//
// An AreaHolder is a long-lived bubblewrap process. Its mount namespace is the host's view
// plus capped tmpfs mounts (bubblewrap --size) under a base directory; it fills them (copies
// of original content), then waits on its stdin. The host's own view of those mount points
// stays empty, so nothing written there reaches the host's disk, and the pages count toward
// the memory of the cgroup that wrote them. Each user enters the holder's user and mount
// namespaces with nsenter and starts a fresh nested bubblewrap that binds what it needs.
// Ending the holder (closing its stdin, or the host dying) discards the areas.
//
// A large-disk unit's image (7.1) is mounted ONLY inside the unit's own namespaces, never on
// the host (follow-up to code review r1): a holder of another unit, which binds the host's "/",
// would otherwise copy the host's FUSE mount into its own mount namespace and keep fuse2fs, and
// so the image's disk space, pinned after the host unmounted it. So an image holder has two
// layers: an outer bubblewrap with a private user and mount namespace (root there, with the
// capabilities of that namespace only, and /dev/fuse) that runs fuse2fs on the image and then
// starts the usual holder, as the user's own uid, inside the namespace that holds the mount.
// Mount events never propagate from a child namespace back to the host, and no namespace
// created from the host can copy a mount the host never had. Ending the holder ends fuse2fs.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { HeadCollector } from './caps.ts';

export class SandboxError extends Error {
  override readonly name = 'SandboxError';
}

/** Environment of the host-side helper processes (nsenter, bwrap). A payload's own environment is set with --clearenv/--setenv. */
export const HELPER_ENV: Readonly<Record<string, string>> = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' };

/** Namespaces and hardening of every nested sandbox (the payload gets no capabilities either). */
export const ISOLATION: readonly string[] = [
  '--unshare-user',
  '--unshare-pid',
  '--unshare-net',
  '--unshare-ipc',
  '--unshare-uts',
  '--die-with-parent',
  '--new-session',
  '--disable-userns',
];

// ---------------------------------------------------------------- process helpers

/** Waits for `p`, at most `ms`; never leaves a timer behind to hold the event loop open. */
export async function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([p, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

/** SIGKILL to the child's process group (children are spawned detached), or to the child alone. */
export function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
}

/** Runs operations one at a time, in order. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}

// ---------------------------------------------------------------- the holder

export interface AreaTmpfs {
  /** Relative to the base directory; "." mounts the tmpfs on the base itself. */
  readonly at: string;
  /** Size cap of this tmpfs in bytes. */
  readonly bytes: number;
}

/** Preparation done inside the holder before it reports ready. `at` is relative to the base. */
export type AreaStep =
  | { readonly op: 'mkdir'; readonly at: string }
  | { readonly op: 'copy-dir'; readonly from: string; readonly at: string }
  | { readonly op: 'copy-file'; readonly from: string; readonly at: string };

const HOLDER_SCRIPT = [
  'set -e',
  'base=$1; shift',
  'mkdir -p "$base"',
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    mkdir) mkdir -p "$base/$3" ;;',
  '    copy-dir) mkdir -p "$base/$3"; cp -a "$2/." "$base/$3/" ;;',
  '    copy-file) cp -a "$2" "$base/$3" ;;',
  '    *) echo "bad step $1" >&2; exit 2 ;;',
  '  esac',
  '  shift 3',
  'done',
  'echo "READY $$"',
  'exec cat >/dev/null',
].join('\n');

/**
 * The outer layer of an image holder: mounts the image with fuse2fs (foreground, in the
 * background of this shell) in this private namespace, waits for the mount, reports fuse2fs's
 * pid, then becomes the inner holder ("$@").
 */
const FUSE_SCRIPT = [
  'set -e',
  'fuse2fs=$1; image=$2; mnt=$3; shift 3',
  '"$fuse2fs" -f -o fakeroot "$image" "$mnt" </dev/null >/dev/null &',
  'fpid=$!',
  'i=0',
  'while ! grep -qF " $mnt " /proc/self/mountinfo; do',
  '  i=$((i+1))',
  '  if [ "$i" -gt 600 ] || ! kill -0 "$fpid" 2>/dev/null; then echo "fuse2fs did not mount $image on $mnt" >&2; kill "$fpid" 2>/dev/null || true; exit 3; fi',
  '  sleep 0.05',
  'done',
  'echo "FUSE $fpid"',
  'exec "$@"',
].join('\n');

/** A fixed-size image mounted with fuse2fs inside the holder's own namespaces only. */
export interface HolderImage {
  readonly fuse2fs: string;
  readonly image: string;
  /** Host path of the (empty) mount directory; the image appears there inside the holder only. */
  readonly mountDir: string;
}

function relOk(at: string): string {
  const n = posix.normalize(at);
  if (at === '' || posix.isAbsolute(at) || n === '..' || n.startsWith('../') || n !== at.replace(/\/+$/, '')) {
    throw new SandboxError(`bad area path ${JSON.stringify(at)}`);
  }
  return n;
}

export class AreaHolder {
  /** Host path under which the areas are mounted (inside the holder's namespaces only). */
  readonly base: string;
  /** Pid of the holder's namespace-owning process, the nsenter target. */
  readonly pid: number;
  /** The fuse2fs serving an image area (pid and start time), or null. */
  readonly fuse: { readonly pid: number; readonly startTime: number } | null;
  private readonly child: ChildProcess;
  private readonly nsenter: string;
  private readonly bwrap: string;
  private closed = false;

  private constructor(base: string, pid: number, child: ChildProcess, nsenter: string, bwrap: string, fuse: { pid: number; startTime: number } | null) {
    this.base = base;
    this.pid = pid;
    this.child = child;
    this.nsenter = nsenter;
    this.bwrap = bwrap;
    this.fuse = fuse;
  }

  static async start(opts: {
    readonly base: string;
    readonly tmpfs: readonly AreaTmpfs[];
    readonly steps: readonly AreaStep[];
    readonly bwrap: string;
    readonly nsenter: string;
    /** Mount this image (inside the holder's namespaces only) before the steps run. */
    readonly image?: HolderImage;
  }): Promise<AreaHolder> {
    const mounts: string[] = [];
    for (const t of opts.tmpfs) {
      const at = relOk(t.at);
      if (!Number.isSafeInteger(t.bytes) || t.bytes < 4096) throw new SandboxError(`bad tmpfs size ${t.bytes}`);
      const dir = at === '.' ? opts.base : join(opts.base, at);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      mounts.push('--size', String(t.bytes), '--tmpfs', dir);
    }
    const steps = opts.steps.flatMap((s) => [s.op, s.op === 'mkdir' ? '-' : s.from, relOk(s.at)]);
    const holder = ['/bin/sh', '-c', HOLDER_SCRIPT, 'mp-holder', opts.base, ...steps];
    let argv: string[];
    if (opts.image === undefined) {
      argv = [opts.bwrap, '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', ...mounts, '--', ...holder];
    } else {
      const img = opts.image;
      for (const p of [img.image, img.mountDir, img.fuse2fs]) {
        if (!isAbsolute(p) || /[\s\\]/.test(p)) throw new SandboxError(`image area path ${JSON.stringify(p)} must be absolute, without whitespace or backslashes`);
      }
      const uid = String(process.getuid?.() ?? 0);
      const gid = String(process.getgid?.() ?? 0);
      // the inner holder: the user's own uid again (what nested sandboxes join), the outer namespace's view (the mount)
      const inner = [opts.bwrap, '--die-with-parent', '--unshare-user', '--uid', uid, '--gid', gid, '--bind', '/', '/', '--dev', '/dev', ...mounts, '--', ...holder];
      // the outer layer: a private user and mount namespace, root there, with /dev/fuse
      argv = [
        opts.bwrap,
        '--die-with-parent',
        '--unshare-user',
        '--uid',
        '0',
        '--gid',
        '0',
        '--cap-add',
        'ALL',
        '--bind',
        '/',
        '/',
        '--dev',
        '/dev',
        '--dev-bind',
        '/dev/fuse',
        '/dev/fuse',
        '--',
        '/bin/sh',
        '-c',
        FUSE_SCRIPT,
        'mp-fuse',
        img.fuse2fs,
        img.image,
        img.mountDir,
        ...inner,
      ];
    }
    const child = spawn(argv[0] as string, argv.slice(1), { env: { ...HELPER_ENV }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.stdin?.on('error', () => undefined);
    const errs = new HeadCollector(16 * 1024);
    child.stderr?.on('data', (c: Buffer) => errs.push(c));
    let fusePid: number | null = null;
    const pid = await new Promise<number>((resolve, reject) => {
      let out: string | null = '';
      const fail = (why: string): void => {
        clearTimeout(timer);
        killGroup(child);
        if (fusePid !== null) {
          try {
            process.kill(fusePid, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
        reject(new SandboxError(`area holder ${why}: ${errs.result().text.trim()}`));
      };
      const timer = setTimeout(() => fail('did not become ready within 60 s'), 60_000);
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => fail(`exited before it was ready (${code ?? signal})`);
      const onError = (e: Error): void => fail(`could not start (${e.message})`);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        if (out === null) return;
        out += d;
        const f = /FUSE (\d+)\n/.exec(out);
        if (f !== null) fusePid = Number(f[1]);
        const m = /READY (\d+)\n/.exec(out);
        if (m) {
          out = null;
          clearTimeout(timer);
          child.off('exit', onExit);
          child.off('error', onError);
          resolve(Number(m[1]));
        }
      });
      child.once('exit', onExit);
      child.once('error', onError);
    });
    let fuse: { pid: number; startTime: number } | null = null;
    if (opts.image !== undefined) {
      const fp = fusePid as number | null;
      const st = fp === null ? null : startTimeOf(fp);
      if (fp === null || st === null) {
        killGroup(child);
        throw new SandboxError(`area holder: fuse2fs is not running for ${opts.image.image}: ${errs.result().text.trim()}`);
      }
      fuse = { pid: fp, startTime: st };
    }
    return new AreaHolder(opts.base, pid, child, opts.nsenter, opts.bwrap, fuse);
  }

  /** Host path of an area (meaningful inside the holder's namespaces). */
  path(at: string): string {
    const r = relOk(at);
    return r === '.' ? this.base : join(this.base, r);
  }

  get alive(): boolean {
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** argv prefix that runs a nested bubblewrap inside the holder's user and mount namespaces. */
  enterBwrap(): string[] {
    if (!this.alive) throw new SandboxError('the area holder has ended; its areas are gone');
    return [this.nsenter, '-t', String(this.pid), '-U', '-m', '--preserve-credentials', '--', this.bwrap];
  }

  /**
   * Ends the holder; its areas are discarded. An image's fuse2fs is ended too (it unmounts in
   * its private namespace and closes the image); the image's space is free once this returns.
   * Throws when fuse2fs cannot be ended (the image stays held: cleanup keeps it pending).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin?.end();
    if (!(await waitExit(this.child, 5_000))) {
      killGroup(this.child);
      await waitExit(this.child, 5_000);
    }
    const f = this.fuse;
    if (f === null) return;
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      if (startTimeOf(f.pid) !== f.startTime) return;
      try {
        process.kill(f.pid, sig);
      } catch {
        return;
      }
      for (let i = 0; i < 100 && startTimeOf(f.pid) === f.startTime; i++) await new Promise((r) => setTimeout(r, 50));
    }
    if (startTimeOf(f.pid) === f.startTime) throw new SandboxError(`fuse2fs (pid ${f.pid}) did not end; its image stays held`);
  }
}

/** /proc/<pid>/stat start time (clock ticks since boot) of a live, non-zombie process, or null. */
function startTimeOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (f[0] === 'Z' || f[0] === 'X') return null;
    return Number(f[19]);
  } catch {
    return null;
  }
}
