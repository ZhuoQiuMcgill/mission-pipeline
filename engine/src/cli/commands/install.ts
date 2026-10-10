// `mp install` (design 9.6, 6.1, 7.1, 9.3; WI-18): the PM's first-use handbook as one
// command. It checks Node, cgroup v2 delegation, bubblewrap, fuse2fs and the private
// image mount; chooses the backup stop inbox's volume (WSL: a Windows volume other
// than the one holding the virtual disk; Linux: another disk); writes the engine's
// configuration (ledger, scheduler with the evaluator, inbox probes, watchdog, engine
// start, CLI) and both stop inboxes; starts the engine and records the install states
// (degradations only with the user's explicit consent: --accept-degradation); runs the
// offline self-check; and prints one paragraph for the PM to relay.
//
// `--dry-run` writes nothing at all: it reports what it found and what it would do.

import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, statfsSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from '../../common/hash.ts';
import { writeFileAtomic } from '../../common/fsx.ts';
import { detectExecCapabilities, isolationPolicy, type Degradation, type ExecCapabilities } from '../../exec/platform.ts';
import { probeFs } from '../../git/admission.ts';
import { SYSTEM_PATH, resolveSystemBinary } from '../../git/safeGit.ts';
import { socketPathProblem } from '../../common/socketPath.ts';
import { ContentStore } from '../../ledger/content.ts';
import { installInbox } from '../../ledger/inbox.ts';
import { LedgerClient } from '../../ledger/ipc.ts';
import { ledgerPaths } from '../../ledger/service.ts';
import { writeInboxConfig } from '../../ledger/stops.ts';
import { DEFAULT_MODEL_CONFIG } from '../../seat/modelConfig.ts';
import type { SeatCredentialsSpec } from '../../seat/credentials.ts';
import { EXEC_INSTALL_FORMAT } from '../../exec/selfcheck.ts';
import { TOOLCHAIN_FIX, detectToolchain, hostSystemEnvironment, type EnvironmentRoot, type Toolchain } from '../../exec/sandbox.ts';
import { freezeToolchain } from '../../exec/toolfreeze.ts';

/** The scheduler configuration with the sandboxes' environment (seats and verification) replaced. */
function withSandboxEnvironment(files: Readonly<Record<string, unknown>>, schedulerPath: string, env: EnvironmentRoot): Record<string, unknown> {
  const out: Record<string, unknown> = { ...files };
  const sched = out[schedulerPath] as Record<string, unknown> | undefined;
  if (sched === undefined) return out;
  const seats = sched['seats'] as Record<string, unknown> | undefined;
  const flow = sched['flow'] as Record<string, unknown> | undefined;
  out[schedulerPath] = {
    ...sched,
    ...(seats !== undefined ? { seats: { ...seats, environment: env } } : {}),
    ...(flow !== undefined ? { flow: { ...flow, verify: { ...((flow['verify'] as Record<string, unknown> | undefined) ?? {}), environment: env } } } : {}),
  };
  return out;
}
import { flagBool, flagList, flagStr, type ParsedArgs } from '../args.ts';
import type { Command, CommandResult } from '../command.ts';
import { ok } from '../command.ts';
import { CLI_CONFIG_FORMAT, defaultConfigPath, type CliConfig } from '../config.ts';
import type { Ctx } from '../context.ts';
import { CliError, EXIT, errorMessage, usage } from '../errors.ts';

export const ENGINE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const NODE_ARGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
const TMPFS_MAGIC = 0x01021994;
const DEGRADATIONS: readonly Degradation[] = ['isolation', 'host-write-cap', 'resource-limits'];

export interface InstallCheck {
  readonly item: string;
  readonly ok: boolean;
  readonly detail: string;
  /** The WI when the check failed (WI-18 for platform capabilities). */
  readonly wi: string | null;
}

export interface BackupChoice {
  readonly file: string | null;
  readonly why: string;
  readonly vhdxDrive: string | null;
}

function run(cmd: string, args: readonly string[], timeoutMs = 5_000): string | null {
  try {
    return execFileSync(cmd, args as string[], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

export function isWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['WSL_DISTRO_NAME']) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** WSL: the drive letter of the Windows volume holding this distribution's virtual disk (from the Lxss registry key). */
export function wslVhdxDrive(env: NodeJS.ProcessEnv = process.env): string | null {
  const reg = existsSync('/mnt/c/Windows/System32/reg.exe') ? '/mnt/c/Windows/System32/reg.exe' : null;
  if (reg === null) return null;
  const out = run(reg, ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s'], 8_000);
  if (out === null) return null;
  const distro = env['WSL_DISTRO_NAME'] ?? null;
  let name: string | null = null;
  const bases: Array<{ name: string | null; base: string }> = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+(\w+)\s+REG_\w+\s+(.*)$/.exec(line);
    if (m === null) {
      if (/^HKEY_/.test(line.trim())) name = null;
      continue;
    }
    if (m[1] === 'DistributionName') name = m[2]!.trim();
    if (m[1] === 'BasePath') bases.push({ name, base: m[2]!.trim() });
  }
  const mine = bases.find((b) => b.name === distro) ?? (bases.length === 1 ? bases[0] : undefined);
  const base = mine?.base.replace(/^\\\\\?\\/, '') ?? null;
  const d = base !== null ? /^([A-Za-z]):/.exec(base) : null;
  return d ? d[1]!.toLowerCase() : null;
}

function writableDir(p: string): boolean {
  try {
    accessSync(p, constants.W_OK);
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The Windows %LOCALAPPDATA% as a WSL path, when it can be found. */
function wslLocalAppData(): string | null {
  const cmd = existsSync('/mnt/c/Windows/System32/cmd.exe') ? '/mnt/c/Windows/System32/cmd.exe' : null;
  if (cmd === null) return null;
  const win = run(cmd, ['/C', 'echo %LOCALAPPDATA%'], 8_000)?.trim() ?? '';
  const m = /^([A-Za-z]):\\(.*)$/.exec(win);
  return m ? `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}` : null;
}

/**
 * The backup inbox (6.1): on WSL, a Windows volume other than the virtual disk's
 * (the maintainer's machine: disk on D:, backup on C:); on Linux, a filesystem on
 * another device than the ledger's. Null when there is none: the PM tells the user
 * that every abnormal stop with work pending then needs one answer from them.
 */
export function chooseBackupInbox(ledgerRoot: string, o: { readonly wsl: boolean; readonly env?: NodeJS.ProcessEnv }): BackupChoice {
  if (o.wsl) {
    const vhdx = wslVhdxDrive(o.env);
    let drives: string[] = [];
    try {
      drives = readdirSync('/mnt').filter((d) => /^[a-z]$/.test(d) && writableDir(join('/mnt', d)));
    } catch {
      drives = [];
    }
    const others = drives.filter((d) => d !== vhdx).sort((a, b) => (a === 'c' ? -1 : b === 'c' ? 1 : a.localeCompare(b)));
    if (vhdx === null) return { file: null, why: 'cannot find the Windows volume holding the WSL virtual disk (the Lxss registry key cannot be read)', vhdxDrive: null };
    const pick = others[0];
    if (pick === undefined) return { file: null, why: `the virtual disk is on ${vhdx.toUpperCase()}: and there is no other writable Windows volume`, vhdxDrive: vhdx };
    const lad = pick === 'c' ? wslLocalAppData() : null;
    const dir = lad !== null && lad.startsWith('/mnt/c/') ? join(lad, 'mission-pipeline', 'stop-inbox') : join('/mnt', pick, 'mission-pipeline', 'stop-inbox');
    return { file: join(dir, 'backup.inbox'), why: `the virtual disk is on ${vhdx.toUpperCase()}:, the backup inbox goes on ${pick.toUpperCase()}:`, vhdxDrive: vhdx };
  }
  let ledgerDev: number;
  try {
    ledgerDev = statSync(existsSync(ledgerRoot) ? ledgerRoot : dirname(ledgerRoot)).dev;
  } catch {
    return { file: null, why: 'cannot read the device holding the ledger directory', vhdxDrive: null };
  }
  let mounts: string[] = [];
  try {
    mounts = readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .map((l) => l.split(' '))
      .filter((f) => f.length > 2 && /^\/dev\//.test(f[0]!) && ['ext4', 'xfs'].includes(f[2]!))
      .map((f) => f[1]!.replace(/\\040/g, ' '));
  } catch {
    mounts = [];
  }
  for (const m of mounts) {
    try {
      if (statSync(m).dev === ledgerDev) continue;
    } catch {
      continue;
    }
    const home = join(m, '.mission-pipeline');
    if (writableDir(m) || writableDir(home)) return { file: join(home, 'stop-inbox', 'backup.inbox'), why: `a filesystem on another disk: ${m}`, vhdxDrive: null };
  }
  return { file: null, why: 'no other writable disk was found', vhdxDrive: null };
}

function defaultControlPlane(env: NodeJS.ProcessEnv): string {
  const uid = process.getuid?.() ?? 0;
  const xdg = env['XDG_RUNTIME_DIR'];
  if (xdg && isAbsolute(xdg)) {
    try {
      if (Number(statfsSync(xdg).type) === TMPFS_MAGIC) return join(xdg, 'mission-pipeline-engine4');
    } catch {
      /* not usable */
    }
  }
  return join('/dev/shm', `mission-pipeline-engine4-${uid}`);
}

function onMemoryFs(p: string): boolean {
  let q = p;
  while (!existsSync(q) && dirname(q) !== q) q = dirname(q);
  try {
    return Number(statfsSync(q).type) === TMPFS_MAGIC;
  } catch {
    return false;
  }
}

function gitTop(dir: string): string | null {
  const out = run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  return out === null ? null : out.trim();
}

/** The git features landing uses: --attr-source (2.40), GIT_NO_LAZY_FETCH (2.44). */
export const MIN_GIT: readonly number[] = [2, 44, 0];

function versionAtLeast(v: string, min: readonly number[]): boolean {
  const parts = v.split('.').map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < min.length; i++) {
    const a = Number.isFinite(parts[i]) ? parts[i]! : 0;
    if (a !== min[i]) return a > min[i]!;
  }
  return true;
}

/** The system git (the one SafeGit runs) and its version, or null. */
export function detectGit(): { path: string; version: string } | null {
  let path: string;
  try {
    path = resolveSystemBinary('git');
  } catch {
    return null;
  }
  const out = run(path, ['--version']);
  const m = out === null ? null : /git version (\d+\.\d+(?:\.\d+)?)/.exec(out);
  return m === null ? null : { path, version: m[1]! };
}

/** Whether `systemctl --user` reaches the user's systemd instance (and systemd-run exists). */
export function detectSystemdUser(caps: Pick<ExecCapabilities, 'systemdRun'>): boolean {
  if (caps.systemdRun === null) return false;
  const sc = existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : existsSync('/bin/systemctl') ? '/bin/systemctl' : 'systemctl';
  return run(sc, ['--user', 'show-environment']) !== null;
}

/** The first check that makes install refuse before writing anything, if any. */
export function installBlocker(plan: InstallPlan): InstallCheck | undefined {
  return plan.checks.find((c) => !c.ok && ['node', 'git', 'systemd-user', 'ledger-fs', 'socket-paths'].includes(c.item));
}

/** The seats' login (credentials.ts): --credentials subscription|none, else the Claude Code login file when it exists. API-key seats are not offered in 4.0. */
export function seatCredentials(flag: string | null, env: NodeJS.ProcessEnv): SeatCredentialsSpec | null {
  const home = env['HOME'] ?? homedir();
  const login = join(env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude'), '.credentials.json');
  if (flag === 'none') return null;
  if (flag !== null && flag.startsWith('api-key')) {
    // the seat host's environment carries no key variable, so such a configuration would install cleanly and fail at the first seat
    throw new CliError('UNSUPPORTED_CREDENTIALS', '4.0 seats use the Claude Code subscription login (--credentials subscription, the default when you are logged in to Claude Code); API-key seats come in a later version', { exitCode: EXIT.USAGE });
  }
  if (flag !== null && flag !== 'subscription') throw usage('--credentials is subscription or none');
  if (flag === 'subscription' || existsSync(login)) return { kind: 'subscription', source: login, minLifetimeMs: 60 * 60_000 };
  return null;
}

export interface InstallPlan {
  readonly root: string;
  readonly configPath: string;
  readonly cliConfig: CliConfig & { readonly ledgerVolume: { readonly fsIds: readonly string[]; readonly reserve: { readonly recoveryReserveBytes: number; readonly evaluatorPoolBytes: number } } };
  readonly files: Readonly<Record<string, unknown>>;
  readonly backup: BackupChoice;
  readonly checks: readonly InstallCheck[];
  readonly caps: ExecCapabilities;
  readonly requiresAcceptance: readonly Degradation[];
  readonly accepted: readonly Degradation[];
  readonly blocked: string | null;
  /** W3: the toolchain trees to freeze at apply (7.2: the sandboxes mount program-owned copies, never these). */
  readonly toolchain: Toolchain;
}

export function planInstall(o: {
  readonly root: string;
  readonly configPath: string;
  readonly controlPlane: string;
  readonly project: string | null;
  readonly targetBranch: string;
  readonly backup: BackupChoice;
  readonly accepted: readonly Degradation[];
  readonly caps: ExecCapabilities;
  readonly wsl: boolean;
  /** The user's home: the flows read the user's git configuration from it (7.1). */
  readonly home?: string;
  /** The login the seats use (credentials.ts); null: none found, no seat can start. */
  readonly credentials?: SeatCredentialsSpec | null;
  /** The user's toolchain outside the system directories (W3); default: detected now. */
  readonly toolchain?: Toolchain;
  /** The git the landing runs (the system git) and its version; default: detected now. Null: none. */
  readonly git?: { readonly path: string; readonly version: string } | null;
  /** Whether the systemd user instance answers (units run as transient user services); default: detected now. */
  readonly systemdUser?: boolean;
}): InstallPlan {
  const root = o.root;
  const cfgDir = join(root, 'config');
  const run_ = join(root, 'run');
  const ledgerRoot = join(root, 'ledger');
  const stateDir = join(root, 'state');
  const logs = join(root, 'logs');
  const lp = ledgerPaths(ledgerRoot, o.controlPlane, { backupInbox: o.backup.file });
  const sockets = { ledger: join(run_, 'ledger.sock'), scheduler: join(run_, 'scheduler.sock'), evaluator: join(run_, 'evaluator.sock') };
  const checkpoint = join(root, 'evaluator', 'checkpoint.json');
  const src = (p: string): string => join(ENGINE_ROOT, 'src', p);
  const node = process.execPath;
  const checks: InstallCheck[] = [];
  const nodeOk = ((): boolean => {
    const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
    return maj > 22 || (maj === 22 && min >= 12);
  })();
  const git = o.git !== undefined ? o.git : detectGit();
  const gitOk = git !== null && versionAtLeast(git.version, MIN_GIT);
  checks.push({
    item: 'git',
    ok: gitOk,
    detail:
      git === null
        ? `no git on ${SYSTEM_PATH} (the landing runs the system git; ${MIN_GIT.join('.')} or later is needed): install it, e.g. sudo apt install git`
        : gitOk
          ? `git ${git.version} (${git.path})`
          : `git ${git.version} at ${git.path} is too old: ${MIN_GIT.join('.')} or later is needed (--attr-source needs 2.40, GIT_NO_LAZY_FETCH 2.44)`,
    wi: gitOk ? null : 'WI-18',
  });
  const systemdUser = o.systemdUser !== undefined ? o.systemdUser : detectSystemdUser(o.caps);
  checks.push({
    item: 'systemd-user',
    ok: systemdUser,
    detail: systemdUser
      ? 'the systemd user instance answers (units run as transient user services)'
      : `the systemd user instance does not answer (systemctl --user show-environment failed${o.caps.systemdRun === null ? '; no systemd-run' : ''}): units run as transient user services. ${o.wsl ? 'On WSL: set systemd=true under [boot] in /etc/wsl.conf, then run wsl --shutdown from Windows and reopen the terminal' : 'Log in through a session that starts systemd --user (or enable lingering: loginctl enable-linger $USER)'}`,
    wi: systemdUser ? null : 'WI-18',
  });
  // W3: the user's toolchain outside the system directories, bound read-only into every sandbox
  // only as a recognized distribution tree (node tarball / nvm; pyenv / venv); skips are reported
  const toolchain = o.toolchain ?? detectToolchain({ ...(o.home !== undefined ? { home: o.home } : {}) });
  // the plan holds the system-only environment; apply freezes the trees and records their copies
  const sandboxEnv = hostSystemEnvironment();
  const toolchainNote =
    (toolchain.dirs.length > 0 ? `; frozen read-only copies of ${toolchain.dirs.join(', ')} are made for the sandboxes (7.2)` : '') +
    (toolchain.skipped.length > 0 ? `; not bound into the sandboxes: ${toolchain.skipped.map((x) => `${x.tool} at ${x.path} (${x.reason})`).join('; ')}: ${TOOLCHAIN_FIX}` : '');
  checks.push({ item: 'node', ok: nodeOk, detail: `Node ${process.versions.node}${nodeOk ? '' : ' (22.12 or later is needed)'}${toolchainNote}`, wi: nodeOk ? null : 'WI-18' });
  checks.push({ item: 'seat-credentials', ok: o.credentials !== null && o.credentials !== undefined, detail: o.credentials ? `seats use the ${o.credentials.kind === 'subscription' ? `subscription login (${o.credentials.source})` : o.credentials.kind === 'api-key' ? `API key in $${o.credentials.variable}` : 'test key'}` : 'no Claude Code login found (~/.claude/.credentials.json): no seat can start; log in to Claude Code (claude, then /login), then mp install again', wi: o.credentials ? null : 'WI-18' });
  checks.push({ item: 'flow-project', ok: o.project !== null, detail: o.project !== null ? `the flows work on ${o.project}` : 'no project repository: the flows do not run until mp install --project <repository>', wi: null });
  const deps = ['zod', '@anthropic-ai/claude-agent-sdk'].filter((d) => !existsSync(join(ENGINE_ROOT, 'node_modules', d, 'package.json')));
  checks.push({ item: 'dependencies', ok: deps.length === 0, detail: deps.length === 0 ? "the engine's dependencies are installed" : `missing dependencies: ${deps.join(', ')} (installed for the user with npm ci: user level, no administrator rights)`, wi: null });
  const longSockets = Object.values(sockets).map(socketPathProblem).filter((x): x is string => x !== null);
  checks.push({ item: 'socket-paths', ok: longSockets.length === 0, detail: longSockets.length === 0 ? 'socket paths fit (at most 107 bytes)' : `${longSockets.join('; ')}: choose a shorter --root`, wi: longSockets.length === 0 ? null : 'WI-18' });
  const pol = isolationPolicy(process.platform, o.caps);
  const cg = o.caps.cgroupV2 && ['memory', 'pids'].every((c) => o.caps.delegatedControllers.includes(c));
  checks.push({ item: 'cgroup', ok: cg, detail: cg ? `cgroup v2 delegates: ${o.caps.delegatedControllers.join(', ')}` : `cgroup v2 does not delegate memory and pids to the user (delegated: ${o.caps.delegatedControllers.join(', ') || 'none'})`, wi: cg ? null : 'WI-18' });
  checks.push({ item: 'bubblewrap', ok: o.caps.bwrapUsable, detail: o.caps.bwrap === null ? 'no bubblewrap' : o.caps.bwrapUsable ? `bubblewrap ${o.caps.bwrapVersion?.join('.') ?? ''} works` : 'bubblewrap does not work (it needs unprivileged user namespaces)', wi: o.caps.bwrapUsable ? null : 'WI-18' });
  checks.push({ item: 'fuse2fs', ok: o.caps.fuse2fs !== null, detail: o.caps.fuse2fs ?? 'no fuse2fs: only tasks that declare a large disk need it (Ubuntu: the fuse2fs package, needs administrator rights)', wi: o.caps.fuse2fs !== null ? null : 'WI-10' });
  const ledgerOnMnt = /^\/mnt\/[a-z]\//.test(ledgerRoot + '/');
  checks.push({ item: 'ledger-fs', ok: !ledgerOnMnt, detail: ledgerOnMnt ? `the ledger directory ${ledgerRoot} is on a Windows drive under /mnt (SQLite locks and fsync are not reliable there, 6.1)` : `ledger directory ${ledgerRoot}`, wi: ledgerOnMnt ? 'WI-18' : null });
  const cpMem = onMemoryFs(o.controlPlane);
  checks.push({ item: 'control-plane', ok: cpMem, detail: cpMem ? `the control plane is on a memory filesystem: ${o.controlPlane}` : `the control plane ${o.controlPlane} is not on a memory filesystem (6.1: a different medium from the main ledger)`, wi: cpMem ? null : 'WI-18' });
  checks.push({ item: 'backup-inbox', ok: o.backup.file !== null, detail: o.backup.file !== null ? `${o.backup.why}: ${o.backup.file}` : `no backup inbox: ${o.backup.why}`, wi: null });
  const missing = pol.requiresAcceptance.filter((d) => !o.accepted.includes(d));
  const accepted = o.accepted.filter((d) => pol.requiresAcceptance.includes(d) || d === 'resource-limits');
  let fsIds: string[] = [];
  try {
    const parent = existsSync(ledgerRoot) ? ledgerRoot : root;
    fsIds = [probeFs(existsSync(parent) ? parent : dirname(parent)).id];
    if (o.wsl && o.backup.vhdxDrive !== null && existsSync(`/mnt/${o.backup.vhdxDrive}`)) fsIds.push(probeFs(`/mnt/${o.backup.vhdxDrive}`).id);
  } catch {
    /* unknown: the landing then treats nothing as sharing the ledger's volume */
  }
  const evaluatorAccepted = accepted.includes('resource-limits') ? ['resource-limits'] : [];
  const ledgerCfg = { root: ledgerRoot, controlPlane: o.controlPlane, socket: sockets.ledger, backupInbox: o.backup.file };
  const probe = (inbox: 'primary' | 'backup', file: string, other: 'primary' | 'backup' | null) => ({ inbox, file, other });
  const probes = o.backup.file === null ? [probe('primary', lp.inbox, null)] : [probe('primary', lp.inbox, 'backup'), probe('backup', o.backup.file, 'primary')];
  const schedulerCfg = {
    ledgerSocket: sockets.ledger,
    ledgerRoot,
    controlPlane: o.controlPlane,
    stateDir,
    scratchRoots: [join(root, 'scratch')],
    rpcSocket: sockets.scheduler,
    evaluator: {
      worker: { dbPath: lp.db, contentRoot: lp.content, ledgerSocket: sockets.ledger, querySocket: sockets.evaluator, checkpointPath: checkpoint, pollMs: 200, checkpointEvery: 50, faultInjection: false },
      deadlineMs: 600_000,
      heapMb: 2048,
      querySocket: sockets.evaluator,
      acceptedDegradations: evaluatorAccepted,
    },
    // the flows on the registered project (src/scheduler/main.ts: without it no flow runs)
    ...(o.project !== null ? { flow: { repo: o.project, workDir: join(root, 'flow-work'), ...(o.home !== undefined ? { userHome: o.home } : {}), verify: { environment: sandboxEnv } } } : {}),
    // the seat installation (SchedulerOptions.seats: without it no seat is dispatched); seats start only once the self-check passes (9.3)
    ...(o.credentials !== null && o.credentials !== undefined
      ? {
          seats: {
            selfCheckDir: join(root, 'selfcheck'),
            credentials: o.credentials,
            modelConfig: join(cfgDir, 'model_config.json'),
            environment: sandboxEnv,
            ...(o.caps.fuse2fs !== null ? { fuse2fs: o.caps.fuse2fs } : {}),
            install: { format: EXEC_INSTALL_FORMAT, ...(o.caps.bwrap !== null ? { bwrap: o.caps.bwrap } : {}), ...(o.caps.nsenter !== null ? { nsenter: o.caps.nsenter } : {}), ...(o.caps.fuse2fs !== null ? { fuse2fs: o.caps.fuse2fs } : {}) },
          },
        }
      : {}),
  };
  const watchdogCfg = {
    controlPlane: o.controlPlane,
    stateDir,
    ledger: { argv: [node, ...NODE_ARGS, src('ledger/main.ts'), join(cfgDir, 'ledger.json')], heartbeatPath: join(o.controlPlane, 'ledger.heartbeat'), logPath: join(logs, 'ledger.log') },
    scheduler: { argv: [node, ...NODE_ARGS, src('scheduler/main.ts'), join(cfgDir, 'scheduler.json')], heartbeatPath: join(o.controlPlane, 'scheduler.heartbeat'), logPath: join(logs, 'scheduler.log') },
    // the watchdog's ProbeSpec: it writes probe-main's configuration and starts the probe itself
    probes: probes.map((p) => ({ inbox: p.inbox, file: p.file, other: p.other, logPath: join(logs, `probe-${p.inbox}.log`) })),
    ledgerSocket: sockets.ledger,
    ledgerContentRoot: lp.content,
    stopInbox: lp.inbox,
  };
  const engineCfg = { watchdogConfig: join(cfgDir, 'watchdog.json'), logPath: join(logs, 'watchdog.log') };
  const projects = o.project === null ? [] : [{ root: o.project, targetBranch: o.targetBranch, mainCheckout: o.project }];
  const cliConfig = {
    format: CLI_CONFIG_FORMAT,
    engineRoot: ENGINE_ROOT,
    ledgerRoot,
    controlPlane: o.controlPlane,
    ledgerSocket: sockets.ledger,
    schedulerSocket: sockets.scheduler,
    evaluatorSocket: sockets.evaluator,
    evaluatorCheckpoint: checkpoint,
    stateDir,
    engineConfig: join(cfgDir, 'engine.json'),
    backupInbox: o.backup.file,
    modelConfig: join(cfgDir, 'model_config.json'),
    selfCheckDir: join(root, 'selfcheck'),
    projects,
    ledgerVolume: { fsIds, reserve: { recoveryReserveBytes: 2 * 2 ** 30, evaluatorPoolBytes: 2 * 2 ** 30 } },
  } as const;
  const files: Record<string, unknown> = {
    [join(cfgDir, 'ledger.json')]: ledgerCfg,
    [join(cfgDir, 'scheduler.json')]: schedulerCfg,
    [join(cfgDir, 'watchdog.json')]: watchdogCfg,
    [join(cfgDir, 'engine.json')]: engineCfg,
    [o.configPath]: cliConfig,
  };
  return { root, configPath: o.configPath, cliConfig: cliConfig as unknown as InstallPlan['cliConfig'], files, backup: o.backup, checks, caps: o.caps, requiresAcceptance: missing, accepted, blocked: pol.blocked, toolchain };
}

/** Install states to record (pending until the ledger takes them). */
export interface PendingInstallState {
  readonly item: string;
  readonly value: string;
  readonly accepted: boolean;
  readonly by: 'user' | 'installer';
  readonly detail: unknown;
}

function pendingStatesPath(stateDir: string): string {
  return join(stateDir, 'cli', 'install-states-pending.json');
}

/** Record pending install states with the ledger; the ones it took are removed. Idempotent: ops from the content. */
export async function flushInstallStates(client: LedgerClient, content: ContentStore, stateDir: string): Promise<number> {
  const p = pendingStatesPath(stateDir);
  let list: PendingInstallState[];
  try {
    list = JSON.parse(readFileSync(p, 'utf8')) as PendingInstallState[];
  } catch {
    return 0;
  }
  const left: PendingInstallState[] = [];
  let n = 0;
  for (const s of list) {
    try {
      const detail = content.put(canonicalJson(s.detail ?? null));
      await client.call('recordInstallState', { op: `install-state:${sha256(canonicalJson(s)).slice(0, 32)}`, item: s.item, value: s.value, accepted: s.accepted, by: s.by, detail });
      n++;
    } catch {
      left.push(s);
    }
  }
  writeFileAtomic(p, JSON.stringify(left));
  return n;
}

function summaryParagraph(plan: InstallPlan, o: { started: boolean | null; selfCheck: { ok: boolean; failed: string[]; live?: boolean } | null; dryRun: boolean }): string {
  const failed = plan.checks.filter((c) => !c.ok && c.item !== 'backup-inbox');
  const parts: string[] = [];
  parts.push(o.dryRun ? 'Install dry run (nothing was written): ' : 'Installed: ');
  parts.push(failed.length === 0 ? 'all checks of the environment passed' : `${failed.length} item(s) need attention (${failed.map((c) => c.detail).join('; ')})`);
  if (plan.backup.file === null) parts.push(`there is no second volume for the backup stop inbox (${plan.backup.why}), so after every abnormal stop of the machine with work pending you will be asked one question: whether you sent a stop`);
  else parts.push(`the backup stop inbox is on another volume (${plan.backup.why})`);
  if (plan.requiresAcceptance.length > 0) parts.push(`this machine needs your decision on these degradations: ${plan.requiresAcceptance.join(', ')} (resource-limits: no per-task memory and process limits); the features concerned stay off until you accept`);
  if (plan.accepted.length > 0) parts.push(`degradations you accepted: ${plan.accepted.join(', ')}`);
  if (plan.blocked !== null) parts.push(`seats cannot start for now: ${plan.blocked} (WI-18)`);
  if (o.started === true) parts.push('the engine is started, and it is checked and started whenever the PM opens');
  if (o.started === false) parts.push('the engine could not start; it is tried again when the PM opens (WI-22)');
  if (o.selfCheck !== null) {
    if (!o.selfCheck.ok) parts.push(`some startup self-check items did not pass (${o.selfCheck.failed.join('; ')}); no seat starts until they do (WI-18; it runs again by itself, or now: mp selfcheck)`);
    else if (o.selfCheck.live === true) parts.push('the startup self-check passed, offline and live (under the seat login): seats can start');
    else parts.push('the offline part of the startup self-check passed; the live items run by themselves when the engine starts (or now: mp selfcheck)');
  }
  return `${parts[0]}${parts.slice(1).join('; ')}.`;
}

export const installCmd: Command = {
  name: 'install',
  summary: 'first install and self-check: checks the environment, picks the backup inbox volume, writes the configuration and inboxes, starts the engine, records install states, runs the offline self-check',
  usage:
    'mp install [--root <dir>] [--project <repository>] [--target-branch main] [--credentials subscription|none] [--control-plane <memory dir>] [--backup-inbox <file>|--no-backup-inbox] [--accept-degradation <name>,...] [--bin-dir <dir>] [--skip-selfcheck] [--no-start] [--dry-run]',
  flags: {
    root: 'string',
    project: 'string',
    'target-branch': 'string',
    'control-plane': 'string',
    'backup-inbox': 'string',
    'no-backup-inbox': 'boolean',
    'accept-degradation': 'list',
    'skip-selfcheck': 'boolean',
    'no-start': 'boolean',
    'dry-run': 'boolean',
    'bin-dir': 'string',
    credentials: 'string',
  },
  changesState: true,
  wi: 'WI-18',
  noConfig: true,
  async run(ctx: Ctx, args: ParsedArgs): Promise<CommandResult> {
    const env = ctx.io.env;
    const dryRun = flagBool(args, 'dry-run');
    const root = resolve(flagStr(args, 'root') ?? join(env['HOME'] ?? homedir(), '.local', 'share', 'mission-pipeline', 'engine4'));
    const configPath = ctx.configPath !== '' ? ctx.configPath : defaultConfigPath(env);
    const accepted = flagList(args, 'accept-degradation');
    for (const d of accepted) if (!DEGRADATIONS.includes(d as Degradation)) throw usage(`unknown degradation ${d} (${DEGRADATIONS.join(', ')})`);
    const wsl = isWsl(env);
    const backupFlag = flagStr(args, 'backup-inbox');
    if (backupFlag !== null && flagBool(args, 'no-backup-inbox')) throw usage('--backup-inbox and --no-backup-inbox cannot both be given');
    const backup: BackupChoice = flagBool(args, 'no-backup-inbox')
      ? { file: null, why: 'no backup inbox, as --no-backup-inbox says', vhdxDrive: null }
      : backupFlag !== null
        ? { file: resolve(backupFlag), why: 'as --backup-inbox says', vhdxDrive: null }
        : chooseBackupInbox(join(root, 'ledger'), { wsl, env });
    const projectFlag = flagStr(args, 'project');
    const project = projectFlag !== null ? resolve(projectFlag) : gitTop(ctx.io.cwd);
    const caps = detectExecCapabilities();
    const plan = planInstall({
      root,
      configPath,
      controlPlane: resolve(flagStr(args, 'control-plane') ?? defaultControlPlane(env)),
      project,
      targetBranch: flagStr(args, 'target-branch') ?? 'main',
      backup,
      accepted: accepted as Degradation[],
      caps,
      wsl,
      home: env['HOME'] ?? homedir(),
      credentials: seatCredentials(flagStr(args, 'credentials'), env),
    });
    const hardFail = installBlocker(plan);
    if (dryRun) {
      const lines = [summaryParagraph(plan, { started: null, selfCheck: null, dryRun: true }), '', 'Checks:', ...plan.checks.map((c) => `  ${c.ok ? 'ok' : 'needs attention'} ${c.item}: ${c.detail}${c.wi ? ` (${c.wi})` : ''}`), '', 'Files it would write:', ...Object.keys(plan.files).map((f) => `  ${f}`)];
      return ok(lines.join('\n'), { dryRun: true, plan: { root: plan.root, configPath: plan.configPath, checks: plan.checks, backup: plan.backup, requiresAcceptance: plan.requiresAcceptance, accepted: plan.accepted, blocked: plan.blocked, files: plan.files } });
    }
    if (hardFail !== undefined) throw new CliError('INSTALL_BLOCKED', `cannot install: ${hardFail.detail}`, { exitCode: EXIT.REFUSED, wi: 'WI-18' });

    // ---- the engine's own dependencies (9.6: installed for the user, user level)
    let depsNote: string | null = null;
    if (plan.checks.some((ch) => ch.item === 'dependencies' && !ch.ok)) {
      try {
        execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ENGINE_ROOT, stdio: 'ignore', timeout: 600_000 });
        depsNote = "installed the engine's dependencies (npm ci)";
      } catch (e) {
        depsNote = `could not install the engine's dependencies: ${errorMessage(e)} (run npm ci in ${ENGINE_ROOT})`;
      }
    }

    // ---- writes
    const c = plan.cliConfig;
    for (const d of [c.ledgerRoot, c.stateDir, c.controlPlane, join(root, 'run'), join(root, 'logs'), join(root, 'scratch'), join(root, 'evaluator'), join(root, 'selfcheck')]) mkdirSync(d, { recursive: true });
    // W3, 7.2: frozen, program-owned copies of the user's toolchain trees; the sandboxes mount
    // them at the tools' paths (never the live trees); re-running install refreshes them
    const frozen = freezeToolchain(plan.toolchain, join(root, 'environments'));
    const frozenEnv = hostSystemEnvironment({ trees: frozen.trees });
    const toolchainLine =
      frozen.trees.length + frozen.skipped.length === 0
        ? null
        : `Sandbox toolchain: ${[...frozen.trees.map((t) => `${t.tool} ${t.version ?? '(version unknown)'} from ${t.source}, frozen at ${t.copy}`), ...frozen.skipped.map((x) => `${x.source} not frozen: ${x.reason}`)].join('; ')}`;
    const files = withSandboxEnvironment(plan.files, join(root, 'config', 'scheduler.json'), frozenEnv);
    for (const [file, value] of Object.entries(files)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
    }
    if (c.modelConfig !== null && !existsSync(c.modelConfig)) writeFileAtomic(c.modelConfig, `${JSON.stringify({ format: DEFAULT_MODEL_CONFIG.format, seats: DEFAULT_MODEL_CONFIG.seats }, null, 2)}\n`);
    const lp = ledgerPaths(c.ledgerRoot, c.controlPlane, { backupInbox: plan.backup.file });
    const primary = installInbox(lp.inbox, 'primary');
    let backupHeader = null;
    let backupError: string | null = null;
    if (plan.backup.file !== null) {
      try {
        backupHeader = installInbox(plan.backup.file, 'backup').header;
      } catch (e) {
        backupError = errorMessage(e);
      }
    }
    writeInboxConfig(
      { inbox: lp.inbox, controlPlane: c.controlPlane, backupInbox: backupHeader === null ? null : plan.backup.file },
      { format: 'mp4.stop-inboxes.v1', primary: lp.inbox, backup: backupHeader === null ? null : plan.backup.file, installedAt: ctx.now, fs: { primary: primary.header.fs, backup: backupHeader?.fs ?? null } },
    );
    // Install states: the platform facts by the installer, degradations only as the user accepted them.
    const states: PendingInstallState[] = [
      ...plan.checks.map((ch) => ({ item: `check:${ch.item}`, value: ch.ok ? 'ok' : 'failed', accepted: false, by: 'installer' as const, detail: ch })),
      ...plan.accepted.map((d) => ({ item: `degradation:${d}`, value: 'accepted', accepted: true, by: 'user' as const, detail: { degradation: d, at: ctx.now } })),
      { item: 'backup-inbox', value: backupHeader === null ? 'none' : 'configured', accepted: false, by: 'installer', detail: { ...plan.backup, error: backupError, fs: backupHeader?.fs ?? null } },
    ];
    mkdirSync(join(c.stateDir, 'cli'), { recursive: true });
    writeFileAtomic(pendingStatesPath(c.stateDir), JSON.stringify(states));

    // ---- `mp` on the PM's PATH (user level, no administrator rights): a link to the plugin's launcher
    const binDir = resolve(flagStr(args, 'bin-dir') ?? join(env['HOME'] ?? homedir(), '.local', 'bin'));
    const launcher = join(ENGINE_ROOT, 'plugin', 'bin', 'mp');
    let binNote: string;
    try {
      mkdirSync(binDir, { recursive: true });
      const link = join(binDir, 'mp');
      let existing: string | null = null;
      try {
        existing = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : 'not-a-link';
      } catch {
        existing = null;
      }
      if (existing === null) {
        symlinkSync(launcher, link);
        binNote = `the mp command is linked at ${link}`;
      } else if (existing === launcher) binNote = `the mp command is at ${link}`;
      else binNote = `${link} exists and is not this engine's mp; left unchanged; use ${launcher} directly`;
    } catch (e) {
      binNote = `could not link mp (${errorMessage(e)}); use ${launcher} directly`;
    }

    // ---- start the engine and record the states
    let started: boolean | null = null;
    let startError: string | null = null;
    if (!flagBool(args, 'no-start')) {
      try {
        const { ensureRunning } = await import('../../scheduler/engine.ts');
        await ensureRunning(JSON.parse(readFileSync(c.engineConfig!, 'utf8')));
        started = true;
        const client = new LedgerClient(c.ledgerSocket, 10_000);
        try {
          await flushInstallStates(client, new ContentStore(lp.content), c.stateDir);
        } finally {
          client.close();
        }
      } catch (e) {
        started = false;
        startError = errorMessage(e);
      }
    }
    // ---- the startup self-check (9.3): offline and live (items 1-3 under the seat login, item 8
    // with the engine running) when a login is configured and the engine runs; else the offline part
    let selfCheck: { ok: boolean; failed: string[]; live?: boolean } | null = null;
    if (!flagBool(args, 'skip-selfcheck')) {
      // any failure, including a run that could not complete, is recorded as failing for these
      // versions and raised as a WI-18 notice (release review r6), not only told in the summary
      const live = started === true && (plan.files[join(root, 'config', 'scheduler.json')] as { seats?: unknown } | undefined)?.seats !== undefined;
      const sl = await import('../../seat/selfcheckLive.ts');
      let failure: import('../../seat/selfcheckLive.ts').SelfCheckFailure | null = null;
      try {
        if (live) {
          const setup = sl.selfCheckSetupFromEngineConfig(c.engineConfig);
          if ('unavailable' in setup) throw new Error(setup.unavailable);
          const { pmMonitorProbe } = await import('../pmMonitorProbe.ts');
          let key: string;
          try {
            // r7: "running" first, so a run that cannot record its evidence still denies seats
            const startKey = sl.runLevelFailure(new Error('-'), setup.claudeExecutable).key;
            if (startKey !== 'unknown-versions') {
              try {
                sl.recordAttempt(setup.dir, startKey, 'running');
              } catch {
                /* nothing can be written: a failure is still raised below */
              }
            }
            const run = await sl.runStartupSelfCheck(setup, { pmProbe: pmMonitorProbe({ configPath: plan.configPath }) });
            key = run.key;
            if (!run.gate.seatsAllowed) failure = sl.failureOf(run);
            selfCheck = { ok: run.gate.seatsAllowed, live: true, failed: (failure?.failing ?? []).map((x) => x.slice(0, 160)) };
          } catch (e) {
            failure = sl.runLevelFailure(e, setup.claudeExecutable);
            key = failure.key;
          }
          // the attempt paces the automatic re-runs (the engine start retries a failure within its hourly limit)
          if (key !== 'unknown-versions') sl.recordAttempt(setup.dir, key, failure === null ? 'passed' : 'failed');
        } else {
          // the offline part only (no login, or the engine is not running for item 8); the live
          // items run by themselves once the engine starts. Failures are recorded the same way.
          const { loadModelConfig } = await import('../../seat/modelConfig.ts');
          const offlineKey = sl.runLevelFailure(new Error('-')).key;
          try {
            if (offlineKey !== 'unknown-versions') sl.recordAttempt(c.selfCheckDir!, offlineKey, 'running');
          } catch {
            /* a failure is still raised below */
          }
          const run = await sl.runStartupSelfCheck(
            { dir: c.selfCheckDir!, models: loadModelConfig(c.modelConfig!), credentials: { kind: 'fake-api-key', key: 'unused-offline-only' }, install: { ...(caps.bwrap ? { bwrap: caps.bwrap } : {}), ...(caps.nsenter ? { nsenter: caps.nsenter } : {}) } },
            { live: false },
          );
          const failing = run.results.filter((x) => !x.ok).map((x) => `item ${x.item}: ${x.detail.slice(0, 120)}`);
          if (failing.length > 0) failure = { key: run.key, versions: run.versions, failing };
          selfCheck = { ok: failing.length === 0, live: false, failed: failing };
          sl.recordAttempt(c.selfCheckDir!, run.key, failure === null ? 'passed' : 'failed');
        }
      } catch (e) {
        failure ??= sl.runLevelFailure(e);
      }
      if (failure !== null) {
        selfCheck = { ok: false, ...(selfCheck?.live !== undefined ? { live: selfCheck.live } : {}), failed: failure.failing.map((x) => x.slice(0, 160)) };
        // the failed attempt denies seats for these versions even when the evidence could not be written (r7)
        try {
          if (failure.key !== 'unknown-versions') sl.recordAttempt(c.selfCheckDir!, failure.key, 'failed');
        } catch {
          /* nothing can be written: the notice below tells the PM */
        }
        const { raiseSelfCheckFailure } = await import('./selfcheck.ts');
        const client = started === true ? new LedgerClient(c.ledgerSocket, 5_000) : null;
        try {
          await raiseSelfCheckFailure(c.stateDir, client !== null ? { client, content: new ContentStore(lp.content) } : null, failure, false);
        } catch {
          /* the local copy is written first; the scheduler carries it over */
        } finally {
          client?.close();
        }
      }
    }
    const text = [summaryParagraph(plan, { started, selfCheck, dryRun: false }), ...(depsNote !== null ? [depsNote] : []), ...(toolchainLine !== null ? [toolchainLine] : []), binNote, ...(startError ? [`(engine start: ${startError})`] : []), ...(backupError ? [`(the backup inbox could not be set up: ${backupError})`] : []), `Configuration: ${plan.configPath}`].join('\n');
    const failedChecks = plan.checks.filter((x) => !x.ok && x.wi === 'WI-18');
    return ok(text, { installed: true, configPath: plan.configPath, root, checks: plan.checks, backup: plan.backup, started, startError, selfCheck, accepted: plan.accepted, requiresAcceptance: plan.requiresAcceptance }, failedChecks.length > 0 || selfCheck?.ok === false ? EXIT.REFUSED : 0);
  },
};
