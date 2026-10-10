// Platform policy of execution isolation (design 7.1 "平台策略") and detection of what the
// machine offers (9.6 install checks: delegated cgroup v2 controllers, bubblewrap, fuse2fs).

import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Absolute path of an executable on PATH, or null. */
export function which(cmd: string, pathEnv: string = process.env['PATH'] ?? ''): string | null {
  if (isAbsolute(cmd)) return isExecutable(cmd) ? cmd : null;
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue;
    const p = join(dir, cmd);
    if (isExecutable(p)) return p;
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First executable among explicit candidates, PATH, and the sbin directories (mkfs lives there). */
export function findTool(name: string, candidates: readonly (string | undefined)[] = []): string | null {
  for (const c of candidates) if (c !== undefined && c !== '' && isExecutable(c)) return c;
  return which(name) ?? which(name, '/usr/local/sbin:/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin');
}

/**
 * fuse2fs for large-disk units (7.1). Configurable: an explicit path, then MP_FUSE2FS, then PATH.
 * Not installed system-wide on every machine; without it, large-disk units cannot run (7.1).
 */
export function findFuse2fs(configured?: string): string | null {
  return findTool('fuse2fs', [configured, process.env['MP_FUSE2FS']]);
}

/** --disable-userns needs bubblewrap 0.8. Usability is decided by probeBwrap, which runs the features the sandbox uses. */
export const MIN_BWRAP_VERSION: readonly [number, number, number] = [0, 8, 0];

/**
 * Runs bwrap once the way every nested tool sandbox runs (holder.ts ISOLATION): new user, pid,
 * NETWORK (bubblewrap sets up its loopback over netlink), ipc and uts namespaces,
 * --disable-userns, fresh /dev and /proc, a capped tmpfs, read-only root. A machine where
 * bubblewrap starts but one of these is refused (code review r1 finding 7: NETLINK_ROUTE denied)
 * is not usable. The startup self-check then exercises the complete path (exec/selfcheck.ts).
 */
export function probeBwrap(bwrap: string): boolean {
  try {
    execFileSync(
      bwrap,
      [
        '--unshare-user',
        '--unshare-pid',
        '--unshare-net',
        '--unshare-ipc',
        '--unshare-uts',
        '--die-with-parent',
        '--new-session',
        '--disable-userns',
        '--ro-bind',
        '/',
        '/',
        '--dev',
        '/dev',
        '--proc',
        '/proc',
        '--size',
        '65536',
        '--tmpfs',
        '/tmp',
        '--remount-ro',
        '/',
        '--',
        '/bin/true',
      ],
      { stdio: 'ignore', timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

export function parseBwrapVersion(text: string): [number, number, number] | null {
  const m = /bubblewrap (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function versionAtLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const a = v[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export interface ExecCapabilities {
  readonly bwrap: string | null;
  /** [major, minor, patch] of bwrap, or null when absent or unreadable. */
  readonly bwrapVersion: readonly number[] | null;
  /** bwrap ran with user namespaces, --disable-userns and a capped tmpfs on this machine. */
  readonly bwrapUsable: boolean;
  readonly nsenter: string | null;
  readonly systemdRun: string | null;
  readonly cgroupV2: boolean;
  /** Controllers the user's systemd manager can hand to a Delegate=yes unit. */
  readonly delegatedControllers: readonly string[];
  readonly fuse2fs: string | null;
  readonly mkfsExt4: string | null;
  readonly fusermount: string | null;
}

export function delegatedControllers(uid: number = process.getuid?.() ?? -1): string[] {
  if (uid < 0) return [];
  const base = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service`;
  try {
    const avail = new Set(readFileSync(`${base}/cgroup.controllers`, 'utf8').split(/\s+/).filter(Boolean));
    const handed = readFileSync(`${base}/cgroup.subtree_control`, 'utf8').split(/\s+/).filter(Boolean);
    return handed.filter((c) => avail.has(c)).sort();
  } catch {
    return [];
  }
}

export function detectExecCapabilities(opts: { readonly fuse2fs?: string } = {}): ExecCapabilities {
  const bwrap = findTool('bwrap');
  let bwrapVersion: [number, number, number] | null = null;
  if (bwrap !== null) {
    try {
      bwrapVersion = parseBwrapVersion(execFileSync(bwrap, ['--version'], { encoding: 'utf8', timeout: 5_000 }));
    } catch {
      bwrapVersion = null;
    }
  }
  return {
    bwrap,
    bwrapVersion,
    bwrapUsable: bwrap !== null && probeBwrap(bwrap),
    nsenter: findTool('nsenter'),
    systemdRun: findTool('systemd-run'),
    cgroupV2: existsSync('/sys/fs/cgroup/cgroup.controllers'),
    delegatedControllers: delegatedControllers(),
    fuse2fs: findFuse2fs(opts.fuse2fs),
    mkfsExt4: findTool('mkfs.ext4'),
    fusermount: findTool('fusermount3') ?? findTool('fusermount'),
  };
}

/** Degradations a user must accept at install before seats start (7.1, 9.6). */
export type Degradation =
  /** Windows native: no system sandbox; no "run command", no program verification runs. */
  | 'isolation'
  /** macOS and Windows native: the Claude Code process's writes have no size cap. */
  | 'host-write-cap'
  /** No delegated cgroup v2: no per-unit memory/pids limits ("资源上限降级"). */
  | 'resource-limits';

export interface IsolationPolicy {
  readonly platform: NodeJS.Platform;
  readonly toolSandbox: 'bubblewrap' | 'macos-sandbox' | 'none';
  /** "run command" exists (possibly only after the user accepted a degradation). */
  readonly runCommand: boolean;
  readonly programVerificationRuns: boolean;
  readonly hostWriteCap: 'outer-bubblewrap' | 'none';
  readonly requiresAcceptance: readonly Degradation[];
  /** Why seats cannot start at all on this machine, or null. */
  readonly blocked: string | null;
}

/**
 * The 7.1 platform table. Linux and WSL: bubblewrap, full isolation (cgroups required for
 * "run command" unless the user accepted "资源上限降级"). macOS: system sandbox, host writes
 * without a size cap. Windows native: no sandbox; "run command" and program verification
 * runs do not exist; file tools are the program's own.
 */
export function isolationPolicy(
  platform: NodeJS.Platform,
  caps: Pick<ExecCapabilities, 'bwrap' | 'nsenter' | 'cgroupV2' | 'delegatedControllers'> & { readonly bwrapUsable?: boolean },
): IsolationPolicy {
  if (platform === 'linux') {
    const cgroups = caps.cgroupV2 && caps.delegatedControllers.includes('memory') && caps.delegatedControllers.includes('pids');
    const sandbox = caps.bwrap !== null && caps.nsenter !== null && caps.bwrapUsable !== false;
    return {
      platform,
      toolSandbox: sandbox ? 'bubblewrap' : 'none',
      runCommand: sandbox,
      programVerificationRuns: sandbox,
      hostWriteCap: sandbox ? 'outer-bubblewrap' : 'none',
      requiresAcceptance: cgroups ? [] : ['resource-limits'],
      blocked: sandbox
        ? null
        : `bubblewrap (${MIN_BWRAP_VERSION.join('.')} or later, with unprivileged user namespaces) and nsenter are required on Linux and WSL`,
    };
  }
  if (platform === 'darwin') {
    return {
      platform,
      toolSandbox: 'macos-sandbox',
      runCommand: true,
      programVerificationRuns: true,
      hostWriteCap: 'none',
      requiresAcceptance: ['host-write-cap'],
      blocked: 'the macOS system sandbox is not implemented yet',
    };
  }
  if (platform === 'win32') {
    return {
      platform,
      toolSandbox: 'none',
      runCommand: false,
      programVerificationRuns: false,
      hostWriteCap: 'none',
      requiresAcceptance: ['isolation', 'host-write-cap'],
      blocked: null,
    };
  }
  return {
    platform,
    toolSandbox: 'none',
    runCommand: false,
    programVerificationRuns: false,
    hostWriteCap: 'none',
    requiresAcceptance: ['isolation', 'host-write-cap'],
    blocked: `unsupported platform ${platform}`,
  };
}
