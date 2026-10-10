// The tool sandbox of one seat (design 7.1 "工具在哪里执行"), on Linux and WSL with bubblewrap.
//
// Layout. A seat's sandbox has persistent writable areas and is entered once per call:
//  - An AreaHolder (holder.ts) owns the writable area: a tmpfs capped with --size (or, for
//    large-disk units, a directory on a fixed-size ext4 image that fuse2fs mounts inside the
//    holder's own namespaces only, never on the host, so no other unit can pin it). It
//    pre-fills the area with the original content of every card writable path. The host's
//    own view of the area stays empty: nothing written in the sandbox lands on the host.
//  - Every call enters the holder's user and mount namespaces with nsenter and starts a
//    fresh nested bubblewrap that builds the sandbox root: the environment root filesystem
//    (read-only), the snapshot at the mount point (read-only), the writable paths bound from
//    the area, /tmp and /dev/shm from the area, fresh /dev and /proc; new user, pid, net, ipc
//    and uts namespaces (no network), cleared environment with an allow-list, no further
//    user namespaces, root and /dev remounted read-only. The ledger, the repository, .git,
//    the user's home and credentials are simply not there.
//  - "run command" first joins its own run-layer cgroup on the host side (a shell trampoline
//    writes itself to cgroup.procs, then execs nsenter), so everything the command starts is
//    in the layer; cgroupfs itself is never visible in the sandbox.
//  - File tools run fs-agent.ts in the same kind of sandbox with this program's node runtime
//    in place of the environment (agent.ts). A command never sees that runtime.
// Each call gets a new pid namespace, so nothing a command starts survives its call.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, posix } from 'node:path';
import { promisify } from 'node:util';
import type { LaunchId } from '../common/ids.ts';
import { classifyRunLayer, type RunId, type RunLayerRecord, type RunStatus } from './acceptance.ts';
import {
  AgentRunner,
  defaultAgentRuntime,
  installAgent,
  type AgentHost,
  type AgentRuntime,
  type AgentReply,
  type AgentRequest,
  type ExportRequest,
  type ExportSink,
} from './agent.ts';
import { HeadCollector, type CappedText } from './caps.ts';
import { RunLayer, processEnd, type Cgroup, type ExitStatus, type LayerCounters, type LayerLimits, type ProcessEnd } from './cgroup.ts';
import { AreaHolder, HELPER_ENV, ISOLATION, SandboxError, SerialQueue, killGroup, settleWithin, type AreaStep, type HolderImage } from './holder.ts';
import { findTool } from './platform.ts';
import { readFrozenManifest, type FrozenTree } from './toolfreeze.ts';

export { SandboxError } from './holder.ts';
export type { AgentReply, AgentRequest, ExportFrame, ExportRequest, ExportSink } from './agent.ts';

const execFileAsync = promisify(execFile);

export const DEFAULT_MOUNT_POINT = '/work';
/** Paths the sandbox builds itself; an environment root may not supply them. */
const RESERVED = ['/', '/dev', '/proc', '/tmp', '/.mp'];

// ---------------------------------------------------------------- environment root

/** One top-level entry of the sandbox's root filesystem: a read-only bind, or a symlink. */
export type EnvEntry =
  /**
   * frozen: a frozen toolchain copy (exec/toolfreeze.ts) mounted at the tool's original path;
   * its manifest marker is checked before every mount.
   */
  | { readonly kind: 'bind'; readonly src: string; readonly dest: string; readonly frozen?: { readonly manifest: string } }
  | { readonly kind: 'symlink'; readonly target: string; readonly dest: string };

/**
 * The environment a command runs on (7.2). The real thing is a frozen read-only copy in the
 * content store; until environment registration exists, a directory or a host stand-in.
 * `frozen: false` means runs on it are open runs, never reused (7.3).
 */
export interface EnvironmentRoot {
  readonly entries: readonly EnvEntry[];
  readonly frozen: boolean;
  /**
   * Directories put in front of PATH inside the sandbox: the bin directories of the user's
   * toolchain (detectToolchain), bound read-only by `entries` at their own paths.
   */
  readonly path?: readonly string[];
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** A root filesystem copy as a directory: each top-level entry bound read-only, symlinks recreated. */
export function environmentFromDirectory(dir: string): EnvironmentRoot {
  const entries: EnvEntry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const dest = `/${d.name}`;
    if (RESERVED.includes(dest)) continue; // the sandbox supplies its own /dev, /proc, /tmp
    const src = join(dir, d.name);
    if (d.isSymbolicLink()) entries.push({ kind: 'symlink', target: readlinkSync(src), dest });
    else if (d.isDirectory() || d.isFile()) entries.push({ kind: 'bind', src, dest });
  }
  return { entries, frozen: true };
}

/**
 * The user's toolchain outside the system directories (W3: node from a tarball under ~/.local,
 * nvm, fnm, volta; a python from pyenv or a venv), to be bound read-only at its own path. Only a
 * RECOGNIZED, self-contained distribution tree is ever bound (release review: guessing the root
 * from where an executable sits selected all of ~/.local, keyrings included, or all of ~/.claude,
 * the login included; read-only does not protect secrets, 7.1):
 *   node    R/bin/node, and R/lib/node_modules/npm or R/include/node (the official tarball, nvm...)
 *   python  R/bin/python3*, and R/lib/python3.* (pyenv versions, venvs; a venv and the
 *           interpreter it links to are each checked as their own tree)
 *   git     the system git only: never bound
 * and never a tree that is the home, holds it, is a direct child of it (~/.local, ~/.claude,
 * ~/.config...), or directly holds a credential-like entry (.ssh, .gnupg, .claude, .config,
 * .local, keyrings, .aws, .kube, .netrc, .git-credentials, *credentials*). The check is shallow.
 * Tools in the system directories need no bind. Anything else is not bound, and is reported
 * (skipped) with why. Recorded at install (9.6); re-checked before every mount (checkToolchainEntries).
 */
export interface ToolchainSkip {
  readonly tool: string;
  readonly path: string;
  readonly reason: string;
}

export interface Toolchain {
  /** Distribution trees to bind (absolute, real paths, none inside another). */
  readonly dirs: readonly string[];
  /** Their bin directories, for PATH inside the sandbox (in detection order). */
  readonly path: readonly string[];
  /** Each tool found outside the system directories, and its real executable. */
  readonly found: Readonly<Record<string, string>>;
  /** Tools found outside the system directories that are not bound, and why. */
  readonly skipped: readonly ToolchainSkip[];
}

export const TOOLCHAIN_TOOLS: readonly string[] = ['node', 'npm', 'npx', 'python3', 'python', 'git'];
/** The fix to tell the user for a toolchain that cannot be bound. */
export const TOOLCHAIN_FIX = 'install the toolchain as a standalone distribution (the Node tarball, nvm; a pyenv version or a venv) or use the system package';
const SYSTEM_DIRS = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc'];
const SECRET_NAMES = new Set(['.ssh', '.gnupg', '.claude', '.config', '.local', 'keyrings', '.aws', '.kube', '.netrc', '.git-credentials']);
const NODE_TOOLS = new Set(['node', 'npm', 'npx']);
const PYTHON_TOOLS = new Set(['python3', 'python']);
const under = (p: string, dir: string): boolean => p === dir || p.startsWith(`${dir}/`);

function executableFile(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function list(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

/** The tree's recognized layout, or null. */
export function toolchainLayout(root: string): 'node' | 'python' | null {
  if (executableFile(join(root, 'bin', 'node')) && (isDir(join(root, 'lib', 'node_modules', 'npm')) || isDir(join(root, 'include', 'node')))) return 'node';
  const bins = list(join(root, 'bin')) ?? [];
  const libs = list(join(root, 'lib')) ?? [];
  if (bins.some((n) => /^python3(\.\d+)?$/.test(n) && executableFile(join(root, 'bin', n))) && libs.some((n) => /^python3\.\d+$/.test(n) && isDir(join(root, 'lib', n)))) return 'python';
  return null;
}

/** Why a tree may not be bound into a sandbox (null: it may). `homes`: the user's home, as given and as resolved. */
export function toolchainRootProblem(root: string, homes: readonly string[]): string | null {
  if (!isAbsolute(root) || posix.normalize(root) !== root || root === '/') return 'not a normalized absolute directory';
  for (const h of homes) {
    if (h === '' || h === '/') continue;
    if (under(h, root)) return 'it is the home directory or holds it';
    if (dirname(root) === h) return `it is a direct child of the home directory (${root}): it holds more than the toolchain`;
  }
  if (SYSTEM_DIRS.some((d) => under(root, d))) return 'it is a system directory (bound already)';
  if (/^\/mnt\/[a-z]\//i.test(`${root}/`)) return 'it is on a Windows drive';
  let st;
  try {
    st = lstatSync(root);
  } catch {
    return 'it is gone';
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'it is not a real directory';
  try {
    if (realpathSync(root) !== root) return 'it is reached through a symbolic link';
  } catch {
    return 'it cannot be resolved';
  }
  const names = list(root);
  if (names === null) return 'it cannot be listed';
  const secret = names.find((n) => SECRET_NAMES.has(n) || /credential/i.test(n));
  if (secret !== undefined) return `it directly holds ${secret} (credentials or user data)`;
  return null;
}

function homesOf(home: string): string[] {
  const out = [home];
  try {
    out.push(realpathSync(home));
  } catch {
    /* as given */
  }
  return [...new Set(out)];
}

export function detectToolchain(o: { readonly env?: Readonly<Record<string, string | undefined>>; readonly execPath?: string; readonly home?: string; readonly tools?: readonly string[] } = {}): Toolchain {
  const env = o.env ?? process.env;
  const homes = homesOf(o.home ?? env['HOME'] ?? homedir());
  const found: Record<string, string> = {};
  const roots: string[] = [];
  const skipped: ToolchainSkip[] = [];
  const inSystem = (p: string): boolean => SYSTEM_DIRS.some((d) => under(p, d));
  /** The tree holding an executable at `file`, if it sits in <tree>/bin (or, npm and npx, in <tree>/lib/node_modules). */
  const treeOf = (file: string): string | null => {
    const nm = file.indexOf('/lib/node_modules/');
    if (nm > 0) return file.slice(0, nm);
    const bin = dirname(file);
    return posix.basename(bin) === 'bin' ? dirname(bin) : null;
  };
  const consider = (tool: string, file: string): void => {
    let real: string;
    try {
      real = realpathSync(file);
    } catch {
      return;
    }
    if (inSystem(real)) return; // the system's own tools are bound already
    if (!NODE_TOOLS.has(tool) && !PYTHON_TOOLS.has(tool)) {
      skipped.push({ tool, path: real, reason: `${tool} must be the system one (in /usr/bin or /bin); a ${tool} elsewhere is never bound` });
      return;
    }
    const want = NODE_TOOLS.has(tool) ? 'node' : 'python';
    // a venv's python is a link out of the venv: the venv (where PATH found it) and the
    // interpreter it links to are each their own tree
    const candidates = [...new Set([treeOf(real), want === 'python' ? treeOf(file) : null].filter((c): c is string => c !== null))];
    const reasons: string[] = [];
    let accepted = false;
    for (const c of candidates) {
      if (inSystem(c)) {
        accepted = true;
        continue;
      }
      const layout = toolchainLayout(c);
      const problem = layout !== want ? `${c} is not a ${want} distribution tree (${want === 'node' ? 'bin/node with lib/node_modules/npm or include/node' : 'bin/python3* with lib/python3.*'})` : toolchainRootProblem(c, homes);
      if (problem !== null) reasons.push(layout !== want ? problem : `${c}: ${problem}`);
      else {
        roots.push(c);
        accepted = true;
      }
    }
    if (candidates.length === 0) reasons.push(`${real} is not inside a bin directory of a distribution tree`);
    if (accepted) found[tool] = real;
    else skipped.push({ tool, path: real, reason: reasons.join('; ') });
  };
  if (o.execPath !== undefined || o.env === undefined) consider('node', o.execPath ?? process.execPath);
  const pathDirs = (env['PATH'] ?? '').split(delimiter).filter((d) => d !== '' && isAbsolute(d));
  for (const tool of o.tools ?? TOOLCHAIN_TOOLS) {
    if (found[tool] !== undefined || skipped.some((x) => x.tool === tool)) continue;
    for (const d of pathDirs) {
      const f = join(d, tool);
      if (!executableFile(f)) continue;
      consider(tool, f); // the first one on PATH is the one the user runs
      break;
    }
  }
  const unique = [...new Set(roots)];
  const dirs = unique.filter((r) => !unique.some((q) => q !== r && under(r, q)));
  return { dirs, path: dirs.map((d) => join(d, 'bin')), found, skipped };
}

/**
 * Before a mount: each frozen toolchain copy must still be the program's copy: a real directory
 * (not a link) at its own resolved path, carrying the manifest marker it was recorded with, for
 * the path it is mounted at. Anything else is left out (with its PATH entries) and reported.
 * The live toolchain is never mounted (exec/toolfreeze.ts), so nothing about it is checked here.
 */
export function checkToolchainEntries(env: EnvironmentRoot): { readonly environment: EnvironmentRoot; readonly skipped: readonly { readonly src: string; readonly reason: string }[] } {
  const skipped: { src: string; dest: string; reason: string }[] = [];
  const entries = env.entries.filter((e) => {
    if (e.kind !== 'bind' || e.frozen === undefined) return true;
    const problem = frozenCopyProblem(e.src, e.dest, e.frozen.manifest);
    if (problem === null) return true;
    skipped.push({ src: e.src, dest: e.dest, reason: problem });
    return false;
  });
  if (skipped.length === 0) return { environment: env, skipped: [] };
  // a PATH entry goes with its tree, unless another kept entry still binds it
  const path = (env.path ?? []).filter((p) => !skipped.some((x) => under(p, x.dest)) || entries.some((e) => e.kind === 'bind' && under(p, e.dest)));
  return { environment: { entries, frozen: env.frozen, ...(path.length > 0 ? { path } : {}) }, skipped: skipped.map((x) => ({ src: x.src, reason: x.reason })) };
}

function frozenCopyProblem(src: string, dest: string, manifest: string): string | null {
  let st;
  try {
    st = lstatSync(src);
  } catch {
    return 'the frozen copy is gone (run mp install again)';
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'the frozen copy is not a real directory';
  try {
    if (realpathSync(src) !== src) return 'the frozen copy is reached through a symbolic link';
  } catch {
    return 'the frozen copy cannot be resolved';
  }
  const m = readFrozenManifest(src);
  if (m === null) return 'the frozen copy has no manifest marker';
  if (m.manifest !== manifest) return `the frozen copy carries manifest ${m.manifest.slice(0, 12)}, not the recorded ${manifest.slice(0, 12)} (run mp install again)`;
  if (m.source !== dest) return `the frozen copy is of ${m.source}, not ${dest}`;
  return null;
}

/**
 * The host's own system directories, read-only: a stand-in for a frozen environment (7.2).
 * Not frozen (the host can change these bytes), so runs on it are open runs. Nothing from
 * /home, /root, /run, /var, /mnt or /etc beyond the dynamic loader's files is included,
 * except the toolchain directories given (detectToolchain, recorded at install): each bound
 * read-only at its own path, its bin directory put in front of PATH. A toolchain directory the
 * sandbox provides itself (/tmp, /dev, /proc) or that is gone is left out.
 */
export function hostSystemEnvironment(toolchain?: { readonly trees: readonly Pick<FrozenTree, 'source' | 'copy' | 'manifest'>[] }): EnvironmentRoot {
  const entries: EnvEntry[] = [];
  for (const name of ['usr', 'bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32']) {
    const p = `/${name}`;
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) entries.push({ kind: 'symlink', target: readlinkSync(p), dest: p });
    else if (st.isDirectory()) entries.push({ kind: 'bind', src: p, dest: p });
  }
  for (const p of ['/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/alternatives']) {
    if (existsSync(p)) entries.push({ kind: 'bind', src: p, dest: p });
  }
  // the frozen copies (7.2), each mounted at its tool's original path; never the live tree
  const path: string[] = [];
  for (const t of toolchain?.trees ?? []) {
    const d = t.source;
    if (!isAbsolute(d) || posix.normalize(d) !== d || RESERVED.some((r) => r !== '/' && under(d, r)) || SYSTEM_DIRS.some((x) => under(d, x)) || d === DEFAULT_MOUNT_POINT || under(d, DEFAULT_MOUNT_POINT)) continue;
    if (frozenCopyProblem(t.copy, d, t.manifest) !== null) continue;
    entries.push({ kind: 'bind', src: t.copy, dest: d, frozen: { manifest: t.manifest } });
    path.push(join(d, 'bin'));
  }
  return { entries, frozen: false, ...(path.length > 0 ? { path } : {}) };
}

function validateEnvironment(env: EnvironmentRoot, mountPoint: string): void {
  for (const e of env.entries) {
    if (!posix.isAbsolute(e.dest) || posix.normalize(e.dest) !== e.dest) throw new SandboxError(`bad environment entry ${e.dest}`);
    if (RESERVED.some((r) => r === e.dest || (r !== '/' && e.dest.startsWith(`${r}/`)))) {
      throw new SandboxError(`environment entry ${e.dest} collides with a path the sandbox provides`);
    }
    if (e.dest === mountPoint || e.dest.startsWith(`${mountPoint}/`) || mountPoint.startsWith(`${e.dest}/`)) {
      throw new SandboxError(`environment entry ${e.dest} collides with the snapshot mount point ${mountPoint}`);
    }
    if (e.kind === 'bind' && !isAbsolute(e.src)) throw new SandboxError(`environment source ${e.src} is not absolute`);
  }
  for (const p of env.path ?? []) {
    if (!posix.isAbsolute(p) || posix.normalize(p) !== p || p.includes(':')) throw new SandboxError(`bad environment PATH entry ${JSON.stringify(p)}`);
  }
}

function envRootArgs(env: EnvironmentRoot): string[] {
  const out: string[] = [];
  for (const e of env.entries) {
    if (e.kind === 'bind') out.push('--ro-bind', e.src, e.dest);
    else out.push('--symlink', e.target, e.dest);
  }
  return out;
}

// ---------------------------------------------------------------- environment variables

export const DEFAULT_SANDBOX_ENV: Readonly<Record<string, string>> = {
  PATH: '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin',
  HOME: '/tmp',
  TMPDIR: '/tmp',
  LANG: 'C.UTF-8',
  TERM: 'dumb',
};

export interface SandboxEnvVars {
  /** Values set explicitly (on top of DEFAULT_SANDBOX_ENV). */
  readonly set?: Readonly<Record<string, string>>;
  /** Names copied from the host's environment: the allow-list. Credential-like names are refused. */
  readonly pass?: readonly string[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CREDENTIAL_LIKE = /TOKEN|SECRET|PASSW|CREDENTIAL|API_?KEY|PRIVATE|AUTH|COOKIE|SESSION|ANTHROPIC|OPENAI|CLAUDE|AWS_|GITHUB_|GH_|SSH_|GPG_|DBUS|XDG_RUNTIME/i;

/** The complete environment of a sandboxed command (bubblewrap --clearenv, then these). */
export function sandboxEnvironment(
  vars: SandboxEnvVars | undefined,
  hostEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_SANDBOX_ENV };
  for (const name of vars?.pass ?? []) {
    if (!ENV_NAME.test(name)) throw new SandboxError(`bad environment variable name ${JSON.stringify(name)}`);
    if (CREDENTIAL_LIKE.test(name)) throw new SandboxError(`refusing to pass ${name} into the tool sandbox: it looks like a credential`);
    const v = hostEnv[name];
    if (v !== undefined) out[name] = v;
  }
  for (const [k, v] of Object.entries(vars?.set ?? {})) {
    if (!ENV_NAME.test(k)) throw new SandboxError(`bad environment variable name ${JSON.stringify(k)}`);
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- writable paths

/** A card writable path, relative to the snapshot root ("." = the whole snapshot). */
export function normalizeWritablePath(p: string): string {
  if (typeof p !== 'string' || p === '' || p.includes('\0') || p.startsWith('/')) {
    throw new SandboxError(`bad writable path ${JSON.stringify(p)}: must be relative to the snapshot root`);
  }
  let n = posix.normalize(p);
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  if (n === '..' || n.startsWith('../')) throw new SandboxError(`writable path ${p} leaves the snapshot`);
  if (n.split('/').includes('.git')) throw new SandboxError(`writable path ${p} names .git`);
  return n;
}

function overlaps(a: string, b: string): boolean {
  return a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

interface ResolvedWritable {
  readonly rel: string;
  readonly kind: 'dir' | 'file';
  readonly hostSrc: string;
  readonly areaName: string;
  readonly sandboxPath: string;
}

/** Relative paths of entries named .git under `root` (not following symlinks), at most `limit`. */
export function findGitEntries(root: string, limit = 5): string[] {
  const found: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0 && found.length < limit) {
    const relDir = stack.pop() as string;
    for (const d of readdirSync(join(root, relDir), { withFileTypes: true })) {
      const r = relDir === '' ? d.name : `${relDir}/${d.name}`;
      if (d.name === '.git') {
        found.push(r);
        if (found.length >= limit) break;
      } else if (d.isDirectory()) stack.push(r);
    }
  }
  return found;
}

// ---------------------------------------------------------------- disk images (large-disk units)

export interface DiskImageSpec {
  readonly path: string;
  readonly bytes: number;
  /** The inode count, fixed at format time: caps the number of files. */
  readonly inodes: number;
}

/**
 * Admission-time creation of a fixed-size ext4 image (7.1 step 1): format, then allocate the
 * whole file so its host-disk footprint is reserved now and never grows.
 */
export async function createDiskImage(spec: DiskImageSpec, tools: { readonly mkfs?: string } = {}): Promise<{ allocatedBytes: number }> {
  if (!Number.isSafeInteger(spec.bytes) || spec.bytes < 1 << 20) throw new SandboxError(`image size ${spec.bytes} too small`);
  if (!Number.isSafeInteger(spec.inodes) || spec.inodes < 16) throw new SandboxError(`inode count ${spec.inodes} too small`);
  const mkfs = findTool('mkfs.ext4', [tools.mkfs]);
  const fallocate = findTool('fallocate');
  if (mkfs === null || fallocate === null) throw new SandboxError('mkfs.ext4 and fallocate are required for disk images');
  const fd = openSync(spec.path, 'wx', 0o600);
  try {
    ftruncateSync(fd, spec.bytes);
  } finally {
    closeSync(fd);
  }
  await execFileAsync(mkfs, ['-q', '-F', '-N', String(spec.inodes), '-m', '0', '-E', 'nodiscard', spec.path], { timeout: 60_000 });
  // mkfs leaves holes; allocating after it reserves the whole size up front
  await execFileAsync(fallocate, ['-l', String(spec.bytes), spec.path], { timeout: 60_000 });
  const allocatedBytes = statSync(spec.path).blocks * 512;
  if (allocatedBytes < spec.bytes) throw new SandboxError(`image ${spec.path} only has ${allocatedBytes} of ${spec.bytes} bytes allocated`);
  return { allocatedBytes };
}

function unescapeMountPath(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
}

export function isMountPoint(dir: string): boolean {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return false;
  }
  return readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n')
    .some((l) => {
      const f = l.split(' ')[4];
      return f !== undefined && unescapeMountPath(f) === real;
    });
}

/**
 * Mounts an image on the HOST as the calling user with fuse2fs. Units do not use this: their
 * images are mounted inside their holder's namespaces (AreaHolder image), so other holders can
 * never copy and pin the mount. Kept for diagnostics and tests of host mounts.
 */
export async function mountDiskImage(image: string, mountDir: string, fuse2fs: string): Promise<void> {
  if (isMountPoint(mountDir)) throw new SandboxError(`${mountDir} is already a mount point`);
  await execFileAsync(fuse2fs, ['-o', 'fakeroot', image, mountDir], { timeout: 30_000 });
  for (let i = 0; i < 100 && !isMountPoint(mountDir); i++) await new Promise((r) => setTimeout(r, 20));
  if (!isMountPoint(mountDir)) throw new SandboxError(`fuse2fs did not mount ${image} on ${mountDir}`);
}

/**
 * Whether this machine can mount a unit's image the way units do: fuse2fs inside a private user
 * and mount namespace (AreaHolder image). A tiny image is mounted and checked to be visible in
 * that namespace and absent from the host, then released. Never throws.
 */
export async function probePrivateImageMount(fuse2fs: string, tools: { readonly bwrap?: string; readonly nsenter?: string } = {}): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const bwrap = findTool('bwrap', [tools.bwrap]);
  const nsenter = findTool('nsenter', [tools.nsenter]);
  if (bwrap === null || nsenter === null) return { ok: false, detail: 'bubblewrap and nsenter are required' };
  const root = mkdtempSync(join(tmpdir(), 'mp-image-probe-'));
  let holder: AreaHolder | null = null;
  try {
    const image = join(root, 'probe.img');
    const mountDir = join(root, 'mnt');
    mkdirSync(mountDir);
    await createDiskImage({ path: image, bytes: 1 << 20, inodes: 16 });
    holder = await AreaHolder.start({ base: join(mountDir, 'area'), tmpfs: [], steps: [], bwrap, nsenter, image: { fuse2fs, image, mountDir } });
    const inside = readFileSync(`/proc/${holder.pid}/mountinfo`, 'utf8').includes(` ${mountDir} `);
    const onHost = isMountPoint(mountDir);
    await holder.close();
    holder = null;
    if (!inside || onHost) return { ok: false, detail: `the image was ${inside ? '' : 'not '}mounted in the unit's namespace and ${onHost ? '' : 'not '}on the host` };
    return { ok: true, detail: 'fuse2fs mounts inside a private user namespace' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  } finally {
    if (holder !== null) await holder.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

export async function unmountDiskImage(mountDir: string): Promise<void> {
  const tools = [findTool('fusermount3'), findTool('fusermount')].filter((t): t is string => t !== null);
  for (const flags of ['-u', '-uz']) {
    for (const t of tools) {
      if (!isMountPoint(mountDir)) return;
      try {
        await execFileAsync(t, [flags, mountDir], { timeout: 30_000 });
      } catch {
        /* busy or wrong tool; try the next form */
      }
    }
  }
  if (isMountPoint(mountDir)) throw new SandboxError(`could not unmount ${mountDir}`);
}

// ---------------------------------------------------------------- the sandbox

/** A tmpfs capped at `bytes`, or a directory on a fixed-size image mounted with fuse2fs (large-disk units). */
export type WritableArea =
  | { readonly kind: 'tmpfs'; readonly bytes: number }
  | { readonly kind: 'image'; readonly image: string; readonly mountDir: string; readonly fuse2fs: string };

export interface SandboxSpec {
  /** The seat's project snapshot (host path, Linux filesystem). Mounted read-only; must not contain .git. */
  readonly snapshotDir: string;
  /** Where the snapshot appears in the sandbox. Default /work. */
  readonly mountPoint?: string;
  /** Card writable paths, relative to the snapshot root; each must exist in the snapshot. */
  readonly writablePaths: readonly string[];
  readonly area: WritableArea;
  readonly environment: EnvironmentRoot;
  readonly env?: SandboxEnvVars;
  /** An existing directory private to this sandbox (Linux filesystem). */
  readonly sessionDir: string;
  /** The file-tool agent's runtime (installation config, 9.3 item 10). Default: defaultAgentRuntime(). */
  readonly runtime?: AgentRuntime;
  readonly bwrapPath?: string;
  readonly nsenterPath?: string;
}

/** Where run layers go and how they are recorded: the seat host's unit (7.1). */
export interface RunLayerHost {
  readonly unit: Cgroup;
  readonly launch: LaunchId;
  /** Called once per run layer, before the result goes back to the seat (stand-in for the ledger write). */
  record(r: RunLayerRecord): void | Promise<void>;
}

export interface SandboxOptions {
  /** null: no run layers ("资源上限降级", accepted by the user at install, 7.1). */
  readonly runLayers: RunLayerHost | null;
  /**
   * A run layer still holds processes after cgroup.kill (code review r2 finding 5): the sandbox
   * is blocked for good (no more tool calls, runs or export); this is called once.
   */
  readonly onWedged?: (w: WedgedRun) => void;
  /**
   * A recorded toolchain tree failed its check before the mount (checkToolchainEntries): it is
   * left out; the caller raises the notice (WI-18).
   */
  readonly onToolchainSkipped?: (skipped: readonly { readonly src: string; readonly reason: string }[]) => void;
}

/** A run whose processes outlived it: they keep the writable area and the unit's memory in use. */
export interface WedgedRun {
  readonly run: RunId;
  readonly layer: string;
  readonly pids: readonly number[];
  readonly reason: string;
}

export interface SandboxRunRequest {
  readonly run: RunId;
  readonly command: string;
  /** Absolute sandbox path (inside the snapshot) to run in. */
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly outputCapBytes: number;
  /** The run's declared peak (6.2). Required when run layers are in use. */
  readonly limits?: LayerLimits;
}

export interface SandboxRunResult {
  readonly run: RunId;
  readonly status: RunStatus;
  readonly exit: ExitStatus;
  readonly stdout: CappedText;
  readonly stderr: CappedText;
  readonly durationMs: number;
  /** The run layer's record, or null without run layers. */
  readonly layer: RunLayerRecord | null;
  /** The command never started (the trampoline or nsenter failed). */
  readonly notStarted: string | null;
}


export class ToolSandbox implements AgentHost {
  readonly mountPoint: string;
  readonly snapshot: string;
  readonly environment: EnvironmentRoot;
  private readonly writable: readonly ResolvedWritable[];
  private readonly envVars: Readonly<Record<string, string>>;
  private readonly area: WritableArea;
  private readonly holder: AreaHolder;
  private readonly agent: AgentRunner;
  private readonly agentCopy: string;
  private readonly runLayers: RunLayerHost | null;
  private readonly queue = new SerialQueue();
  private closed = false;
  private wedgedRun: WedgedRun | null = null;
  private reaper: NodeJS.Timeout | null = null;
  private readonly onWedged: ((w: WedgedRun) => void) | undefined;

  private constructor(init: {
    mountPoint: string;
    snapshot: string;
    environment: EnvironmentRoot;
    writable: readonly ResolvedWritable[];
    envVars: Readonly<Record<string, string>>;
    area: WritableArea;
    holder: AreaHolder;
    agent: AgentRunner;
    agentCopy: string;
    runLayers: RunLayerHost | null;
    onWedged?: (w: WedgedRun) => void;
  }) {
    this.mountPoint = init.mountPoint;
    this.snapshot = init.snapshot;
    this.environment = init.environment;
    this.writable = init.writable;
    this.envVars = init.envVars;
    this.area = init.area;
    this.holder = init.holder;
    this.agent = init.agent;
    this.agentCopy = init.agentCopy;
    this.runLayers = init.runLayers;
    this.onWedged = init.onWedged;
  }

  /** Sandbox paths of the card writable paths (the roots the export covers). */
  get writableRoots(): readonly { readonly rel: string; readonly path: string; readonly kind: 'dir' | 'file' }[] {
    return this.writable.map((w) => ({ rel: w.rel, path: w.sandboxPath, kind: w.kind }));
  }

  get writableRels(): readonly string[] {
    return this.writable.map((w) => w.rel);
  }

  /** The holder process (its pid identity is a cleanup resource, v35). */
  get holderPid(): number {
    return this.holder.pid;
  }

  static async create(spec: SandboxSpec, options: SandboxOptions): Promise<ToolSandbox> {
    const mountPoint = spec.mountPoint ?? DEFAULT_MOUNT_POINT;
    if (!posix.isAbsolute(mountPoint) || posix.normalize(mountPoint) !== mountPoint || mountPoint === '/') {
      throw new SandboxError(`bad mount point ${mountPoint}`);
    }
    if (RESERVED.some((r) => r !== '/' && (mountPoint === r || mountPoint.startsWith(`${r}/`)))) {
      throw new SandboxError(`mount point ${mountPoint} collides with a path the sandbox provides`);
    }
    validateEnvironment(spec.environment, mountPoint);
    // the recorded toolchain trees, checked again right before the mount (release review: a source
    // replaced by a link, or grown a credential, after install is never bound)
    const checked = checkToolchainEntries(spec.environment);
    if (checked.skipped.length > 0) options.onToolchainSkipped?.(checked.skipped);
    const environment = checked.environment;
    const snapshot = realpathSync(spec.snapshotDir);
    if (!statSync(snapshot).isDirectory()) throw new SandboxError(`snapshot ${snapshot} is not a directory`);
    const gits = findGitEntries(snapshot);
    if (gits.length > 0) {
      throw new SandboxError(`snapshot contains repository metadata (${gits.join(', ')}); snapshots must not expose .git (7.1)`);
    }

    const rels = [...new Set(spec.writablePaths.map(normalizeWritablePath))].sort();
    for (let i = 0; i < rels.length; i++) {
      for (let j = i + 1; j < rels.length; j++) {
        if (overlaps(rels[i] as string, rels[j] as string)) throw new SandboxError(`writable paths ${rels[i]} and ${rels[j]} overlap`);
      }
    }
    const writable: ResolvedWritable[] = rels.map((rel, i) => {
      const hostSrc = rel === '.' ? snapshot : join(snapshot, rel);
      let st;
      try {
        st = lstatSync(hostSrc);
      } catch {
        throw new SandboxError(`writable path ${rel} does not exist in the snapshot (the snapshot must contain every writable path)`);
      }
      if (st.isSymbolicLink() || realpathSync(hostSrc) !== hostSrc) throw new SandboxError(`writable path ${rel} goes through a symbolic link`);
      if (!st.isDirectory() && !st.isFile()) throw new SandboxError(`writable path ${rel} is neither a directory nor a regular file`);
      return {
        rel,
        kind: st.isDirectory() ? 'dir' : 'file',
        hostSrc,
        areaName: `w${i}`,
        sandboxPath: rel === '.' ? mountPoint : posix.join(mountPoint, rel),
      };
    });

    const sessionDir = realpathSync(spec.sessionDir);
    if (!statSync(sessionDir).isDirectory()) throw new SandboxError(`session directory ${sessionDir} is not a directory`);
    const envVars = sandboxEnvironment(spec.env);
    // the toolchain's bin directories first (W3), unless the caller set PATH itself
    if ((environment.path?.length ?? 0) > 0 && spec.env?.set?.['PATH'] === undefined) {
      envVars['PATH'] = [...(environment.path as readonly string[]), envVars['PATH']].join(':');
    }
    const bwrap = findTool('bwrap', [spec.bwrapPath]);
    const nsenter = findTool('nsenter', [spec.nsenterPath]);
    if (bwrap === null || nsenter === null) throw new SandboxError('bubblewrap (bwrap) and nsenter are required');
    const runtime = spec.runtime ?? defaultAgentRuntime();
    if (spec.area.kind === 'tmpfs' && (!Number.isSafeInteger(spec.area.bytes) || spec.area.bytes < 4096)) {
      throw new SandboxError(`bad area size ${spec.area.bytes}`);
    }

    const agentCopy = installAgent(sessionDir);
    let base: string;
    let image: HolderImage | undefined;
    if (spec.area.kind === 'tmpfs') {
      base = join(sessionDir, 'area');
      mkdirSync(base);
    } else {
      // the image is mounted inside this sandbox's holder namespaces only, never on the host
      // (holder.ts): no other unit's holder can copy the mount and pin the image
      const mountDir = realpathSync(spec.area.mountDir);
      if (!statSync(mountDir).isDirectory()) throw new SandboxError(`mount directory ${mountDir} is not a directory`);
      if (isMountPoint(mountDir)) throw new SandboxError(`${mountDir} is already a mount point on the host`);
      image = { fuse2fs: spec.area.fuse2fs, image: realpathSync(spec.area.image), mountDir };
      base = join(mountDir, 'area');
    }
    const steps: AreaStep[] = [
      { op: 'mkdir', at: 'tmp' },
      { op: 'mkdir', at: 'shm' },
      ...writable.map((w): AreaStep => ({ op: w.kind === 'dir' ? 'copy-dir' : 'copy-file', from: w.hostSrc, at: w.areaName })),
    ];
    const holder = await AreaHolder.start({
      base,
      tmpfs: spec.area.kind === 'tmpfs' ? [{ at: '.', bytes: spec.area.bytes }] : [],
      steps,
      bwrap,
      nsenter,
      ...(image !== undefined ? { image } : {}),
    });
    const workMounts = workArgs(snapshot, mountPoint, writable, base);
    const agent = new AgentRunner(holder, runtime, agentCopy, {
      mounts: [...workMounts],
      root: mountPoint,
      writable: writable.map((w) => ({ path: w.sandboxPath, kind: w.kind })),
    });
    return new ToolSandbox({
      mountPoint,
      snapshot,
      environment,
      writable,
      envVars,
      area: spec.area,
      holder,
      agent,
      agentCopy,
      runLayers: options.runLayers,
      ...(options.onWedged !== undefined ? { onWedged: options.onWedged } : {}),
    });
  }

  private assertUsable(): void {
    if (this.closed) throw new SandboxError('sandbox is closed');
    if (this.wedgedRun !== null && this.wedgedRun !== undefined) throw new SandboxError(`the sandbox is blocked: ${this.wedgedRun.reason}`);
    if (!this.holder.alive) throw new SandboxError('the sandbox holder has exited; the writable area is gone');
  }

  /** Set once a run's processes could not be ended: nothing more runs here (6.2, 7.1, WI-14). */
  get wedged(): WedgedRun | null {
    return this.wedgedRun ?? null;
  }

  /**
   * A run layer that cgroup.kill could not empty: block the sandbox for good, keep the layer
   * (its processes keep their memory counted in the unit), keep killing it in the background,
   * and tell the owner. Nothing it did counts as evidence and no hand-back may follow (6.2).
   */
  private wedge(run: RunId, layer: RunLayer, why: string): void {
    const w: WedgedRun = { run, layer: layer.cgroup.path, pids: layer.cgroup.allProcs(), reason: `run ${run}: processes ${layer.cgroup.allProcs().join(' ') || '(unknown)'} remain in ${layer.cgroup.path} after cgroup.kill (${why})` };
    this.wedgedRun = w;
    this.reaper = setInterval(() => {
      try {
        layer.cgroup.kill();
      } catch {
        /* gone */
      }
    }, 5_000);
    this.reaper.unref();
    try {
      this.onWedged?.(w);
    } catch {
      /* the owner's handler is best effort */
    }
  }

  /** bubblewrap arguments of a command run, nsenter prefix included (exposed for inspection). */
  runArgv(cwd: string, command: string): string[] {
    const envArgs = Object.entries(this.envVars).flatMap(([k, v]) => ['--setenv', k, v]);
    return [
      ...this.holder.enterBwrap(),
      ...ISOLATION,
      '--hostname',
      'sandbox',
      '--clearenv',
      ...envArgs,
      ...envRootArgs(this.environment),
      '--dev',
      '/dev',
      '--bind',
      this.holder.path('shm'),
      '/dev/shm',
      '--proc',
      '/proc',
      ...workArgs(this.snapshot, this.mountPoint, this.writable, this.holder.base),
      '--bind',
      this.holder.path('tmp'),
      '/tmp',
      '--remount-ro',
      '/dev',
      '--remount-ro',
      '/',
      '--chdir',
      cwd,
      '--',
      '/bin/sh',
      '-c',
      command,
    ];
  }

  // ---------------------------------------------------------------- run command

  runCommand(req: SandboxRunRequest): Promise<SandboxRunResult> {
    return this.queue.run(() => this.runNow(req));
  }

  private async runNow(req: SandboxRunRequest): Promise<SandboxRunResult> {
    this.assertUsable();
    if (!posix.isAbsolute(req.cwd) || posix.normalize(req.cwd) !== req.cwd) throw new SandboxError(`bad cwd ${req.cwd}`);
    const argv = this.runArgv(req.cwd, req.command);
    const out = new HeadCollector(req.outputCapBytes);
    const err = new HeadCollector(req.outputCapBytes);
    const started = Date.now();

    let layer: RunLayer | null = null;
    let child: ChildProcess;
    let ended: Promise<ProcessEnd>;
    let joined: Promise<boolean>;
    if (this.runLayers !== null) {
      if (req.limits === undefined) throw new SandboxError("a run layer needs the run's declared limits");
      layer = RunLayer.create(this.runLayers.unit, req.run, req.limits);
      const c = layer.spawn(argv, { env: HELPER_ENV, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      child = c.child;
      ended = c.exited;
      joined = c.joined;
    } else {
      child = spawn(argv[0] as string, argv.slice(1), { env: { ...HELPER_ENV }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      ended = processEnd(child);
      joined = Promise.resolve(true);
    }
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));

    let timedOut = false;
    const runLayer = layer;
    const timer = setTimeout(() => {
      timedOut = true;
      if (runLayer !== null) {
        try {
          runLayer.cgroup.kill();
        } catch {
          /* already gone */
        }
      }
      killGroup(child);
    }, req.timeoutMs);
    const end = await ended;
    clearTimeout(timer);

    let counters: LayerCounters | null = null;
    if (layer !== null) {
      // nothing a command started may outlive it; results count only once the layer is empty
      try {
        counters = await layer.settle(200, 60_000);
      } catch (e) {
        this.wedge(req.run, layer, (e as Error).message);
        throw new SandboxError(`the run's processes could not be ended; the sandbox is blocked: ${(e as Error).message}`);
      }
    } else {
      killGroup(child);
    }
    await settleWithin(closed, 5_000);
    const didJoin = await joined;

    let status: RunStatus;
    const layerOutcome = counters === null ? 'completed' : classifyRunLayer({ oom: counters.oom, oomKill: counters.oomKill });
    if (!didJoin) status = 'environment-failure';
    else if (layerOutcome !== 'completed') status = layerOutcome;
    else if (timedOut) status = 'timed-out';
    else status = 'completed';

    let record: RunLayerRecord | null = null;
    if (layer !== null && counters !== null && this.runLayers !== null) {
      record = {
        kind: 'run.layer',
        launch: this.runLayers.launch,
        run: req.run,
        finalOom: counters.finalOom,
        finalOomKill: counters.finalOomKill,
        oomDelta: counters.oom,
        oomKillDelta: counters.oomKill,
        status,
      };
      await this.runLayers.record(record);
      await layer.remove();
    }
    return {
      run: req.run,
      status,
      exit: end.status,
      stdout: out.result(),
      stderr: err.result(),
      durationMs: Date.now() - started,
      layer: record,
      notStarted: end.error !== null ? end.error.message : didJoin ? null : 'could not join the run layer',
    };
  }

  // ---------------------------------------------------------------- file-tool agent

  callAgent(req: AgentRequest, opts: { readonly timeoutMs: number; readonly maxResponseBytes: number }): Promise<AgentReply> {
    return this.queue.run(async () => {
      this.assertUsable();
      return await this.agent.call(req, opts);
    });
  }

  exportStream(req: ExportRequest, sink: ExportSink, timeoutMs: number): Promise<void> {
    return this.queue.run(async () => {
      this.assertUsable();
      await this.agent.stream(req, sink, timeoutMs);
    });
  }

  // ---------------------------------------------------------------- teardown

  /** The fuse2fs serving a disk image area inside the holder's namespaces (a cleanup resource), or null. */
  get fusePid(): number | null {
    return this.holder.fuse?.pid ?? null;
  }

  /** Ends the holder (the writable area disappears with it); an image's fuse2fs ends with it and the image is free. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue.drain();
    if (this.reaper !== null) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    // a wedged run layer stays: its processes are the unit's to end (supervisor, cgroup.kill)
    await this.holder.close();
    if (this.area.kind === 'tmpfs') {
      try {
        rmdirSync(this.holder.base);
      } catch {
        /* left for the session directory's owner */
      }
    }
    try {
      unlinkSync(this.agentCopy);
    } catch {
      /* already gone */
    }
  }
}

function workArgs(snapshot: string, mountPoint: string, writable: readonly ResolvedWritable[], base: string): string[] {
  const out = ['--ro-bind', snapshot, mountPoint];
  for (const w of writable) out.push('--bind', join(base, w.areaName), w.sandboxPath);
  return out;
}

/** The /proc/self/mountinfo mount points under `prefix` (diagnostics for tests and the stop report). */
export function mountsUnder(prefix: string): string[] {
  return readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n')
    .map((l) => unescapeMountPath(l.split(' ')[4] ?? ''))
    .filter((p) => p === prefix || p.startsWith(`${prefix}/`));
}
