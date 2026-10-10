// Installation config of the execution layer and the startup self-check (design 9.3 "启动自检
// （放行测试）", 9.6, 9.7; code review r1 finding 7).
//
// The self-check is a release gate, not a probe:
//  - it is pinned to the versions under test: the Claude Code binary, the Agent SDK and Node
//    (toolchainVersions); its evidence is stored per version key (<dir>/<key>.json): for every
//    item a deterministic pass/fail, the raw events and exit statuses, when and how it ran;
//  - "offline" items run here without a model: 4 (file tools and "run command" cannot read
//    outside the snapshot, the ledger, .git or credentials, nor write read-only paths, also
//    while a symlink is being replaced concurrently), 5 (no network, no model service), 6
//    (compound commands and subprocesses do not get around 4 and 5), 10 (the file-tool
//    runtime loads in the tool sandbox); the seat side adds 7 and the offline parts of 1-3
//    (seat/selfcheck.ts). "live" items need the real model or the PM's session (1, 2, 3, 8, 9)
//    and run in the opt-in suite (test/seat-selfcheck-live.test.ts);
//  - selfCheckGate decides from the stored evidence: on a platform with full isolation every
//    one of items 1-8 and 10 must have passed for the current versions, items 1, 2, 3 and 8 in
//    a live run; otherwise seats are not started (WI-18). Item 9 decides only whether the money
//    form of spend_limit may be used (6.5). On Windows with accepted degraded isolation, items
//    5 and 6 do not apply.
// Capability probing exercises the real path: the checks below run the actual tool sandbox
// (nsenter into a holder, the nested bubblewrap with every namespace, the agent), so a machine
// where bubblewrap starts but cannot set up the sandbox's network namespace fails here.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { createRequire } from 'node:module';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { canonicalJson } from '../common/hash.ts';
import { DEFAULT_LIBRARY_PATHS, defaultAgentRuntime, type AgentRuntime } from './agent.ts';
import { REAL_DURABLE_OPS, ensureDirChainDurable, writeDurable, type DurableOps } from './durable.ts';
import { HELPER_ENV, killGroup } from './holder.ts';
import { ToolSandbox, hostSystemEnvironment } from './sandbox.ts';
import { ProgramTools } from './tools.ts';

export const EXEC_INSTALL_FORMAT = 'mp4.exec-install.v1';

/** Written by the installer (9.6); every field optional, defaults detected at run time. */
export interface ExecInstallConfig {
  readonly format: typeof EXEC_INSTALL_FORMAT;
  readonly agentRuntime?: AgentRuntime;
  readonly bwrap?: string;
  readonly nsenter?: string;
  readonly fuse2fs?: string;
}

export function parseExecInstallConfig(x: unknown): ExecInstallConfig {
  if (typeof x !== 'object' || x === null) throw new TypeError('install config is not an object');
  const o = x as Record<string, unknown>;
  if (o['format'] !== EXEC_INSTALL_FORMAT) throw new TypeError(`unknown install config format ${JSON.stringify(o['format'])}`);
  const abs = (v: unknown, what: string): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !isAbsolute(v)) throw new TypeError(`${what} must be an absolute path`);
    return v;
  };
  let agentRuntime: AgentRuntime | undefined;
  if (o['agentRuntime'] !== undefined) {
    const rt = o['agentRuntime'] as Record<string, unknown>;
    const node = abs(rt['node'], 'agentRuntime.node');
    if (node === undefined) throw new TypeError('agentRuntime.node is required');
    const libs = rt['libraryPaths'] ?? DEFAULT_LIBRARY_PATHS;
    if (!Array.isArray(libs) || libs.some((l) => typeof l !== 'string' || !isAbsolute(l))) {
      throw new TypeError('agentRuntime.libraryPaths must be absolute paths');
    }
    agentRuntime = { node, libraryPaths: libs as string[] };
  }
  const bwrap = abs(o['bwrap'], 'bwrap');
  const nsenter = abs(o['nsenter'], 'nsenter');
  const fuse2fs = abs(o['fuse2fs'], 'fuse2fs');
  return {
    format: EXEC_INSTALL_FORMAT,
    ...(agentRuntime !== undefined ? { agentRuntime } : {}),
    ...(bwrap !== undefined ? { bwrap } : {}),
    ...(nsenter !== undefined ? { nsenter } : {}),
    ...(fuse2fs !== undefined ? { fuse2fs } : {}),
  };
}

export function loadExecInstallConfig(path: string): ExecInstallConfig {
  return parseExecInstallConfig(JSON.parse(readFileSync(path, 'utf8')));
}

// ---------------------------------------------------------------- versions and evidence

/** What the self-check is pinned to (9.3 "固定被测的 Claude Code、SDK、Node 版本"). */
export interface ToolchainVersions {
  readonly claudeCode: string;
  /** The binary under test: the SDK manifest's checksum for this platform, or path/size/mtime of a configured executable. */
  readonly claudeCodeBinary: string;
  readonly sdk: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
}

/** The versions in use now: the Agent SDK's package and manifest, this Node, or a configured Claude Code executable. */
export function toolchainVersions(opts: { readonly claudeExecutable?: string } = {}): ToolchainVersions {
  const req = createRequire(import.meta.url);
  const sdkDir = dirname(req.resolve('@anthropic-ai/claude-agent-sdk'));
  const pkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')) as { version: string; claudeCodeVersion?: string };
  let manifest: { version?: string; platforms?: Record<string, { checksum?: string }> } = {};
  try {
    manifest = JSON.parse(readFileSync(join(sdkDir, 'manifest.json'), 'utf8')) as typeof manifest;
  } catch {
    /* an SDK without a manifest: the version alone */
  }
  const plat = `${platform()}-${arch()}`;
  let claudeCode = manifest.version ?? pkg.claudeCodeVersion ?? 'unknown';
  let claudeCodeBinary = manifest.platforms?.[plat]?.checksum ?? 'unknown';
  if (opts.claudeExecutable !== undefined) {
    const st = statSync(opts.claudeExecutable);
    claudeCode = `custom:${opts.claudeExecutable}`;
    claudeCodeBinary = `${opts.claudeExecutable}:${st.size}:${Math.floor(st.mtimeMs)}`;
  }
  return { claudeCode, claudeCodeBinary, sdk: pkg.version, node: process.version, platform: platform(), arch: arch() };
}

export function versionKey(v: ToolchainVersions): string {
  return createHash('sha256').update(canonicalJson(v)).digest('hex').slice(0, 32);
}

/** offline: run here without a model; live: with the real model or the PM's session; fixture: a stand-in (tests only). */
export type SelfCheckMode = 'offline' | 'live' | 'fixture';

export interface SelfCheckResult {
  readonly item: number;
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly ms: number;
  readonly mode: SelfCheckMode;
  /** The raw events: each probe with its outcome, exit status and output (capped). */
  readonly events: readonly unknown[];
  readonly at: string;
}

export const SELFCHECK_FORMAT = 'mp4.selfcheck.v1';

export interface SelfCheckRecord {
  readonly format: typeof SELFCHECK_FORMAT;
  readonly key: string;
  readonly versions: ToolchainVersions;
  /** The latest result of every item in every mode that ran, by "<item>/<mode>" (an offline run never replaces a live one). */
  readonly items: Readonly<Record<string, SelfCheckResult>>;
  readonly updatedAt: string;
}

function slot(item: number, mode: SelfCheckMode): string {
  return `${item}/${mode}`;
}

export function selfCheckPath(dir: string, v: ToolchainVersions): string {
  return join(dir, `${versionKey(v)}.json`);
}

export function readSelfCheck(dir: string, v: ToolchainVersions): SelfCheckRecord | null {
  try {
    const r = JSON.parse(readFileSync(selfCheckPath(dir, v), 'utf8')) as SelfCheckRecord;
    if (r.format !== SELFCHECK_FORMAT || r.key !== versionKey(v) || canonicalJson(r.versions) !== canonicalJson(v)) return null;
    return r;
  } catch {
    return null;
  }
}

/** Adds results to the evidence of these versions (durably); a later run of an item replaces the earlier one. */
export function recordSelfCheck(dir: string, v: ToolchainVersions, results: readonly SelfCheckResult[], ops: DurableOps = REAL_DURABLE_OPS): SelfCheckRecord {
  ensureDirChainDurable(dir, dir);
  const prev = readSelfCheck(dir, v);
  const items: Record<string, SelfCheckResult> = { ...(prev?.items ?? {}) };
  for (const r of results) items[slot(r.item, r.mode)] = r;
  const rec: SelfCheckRecord = { format: SELFCHECK_FORMAT, key: versionKey(v), versions: v, items, updatedAt: new Date().toISOString() };
  writeDurable(selfCheckPath(dir, v), `${JSON.stringify(rec, null, 2)}\n`, ops);
  return rec;
}

// ---------------------------------------------------------------- the runs (attempts) per version key

/**
 * Every self-check run writes its attempt for the version key before it starts ("running") and
 * when it ends ("passed" / "failed"); the engine start path writes "started" when it launches one.
 * The gate reads the latest one (release review r7): a failed run, or one still "running" past the
 * deadline (it crashed), denies seats even if an older passing record exists, until a later run
 * passes. So a run whose evidence could not be written still blocks, through its attempt.
 */
export type SelfCheckAttemptOutcome = 'started' | 'running' | 'passed' | 'failed';
export interface SelfCheckAttempt {
  readonly at: number;
  readonly outcome: SelfCheckAttemptOutcome;
}
export const SELFCHECK_ATTEMPTS_FORMAT = 'mp4.selfcheck-attempts.v1';
/** A run still "running" (or "started") after this long has ended without saying so. */
export const SELFCHECK_RUN_DEADLINE_MS = 15 * 60_000;

export function selfCheckAttemptsPath(dir: string): string {
  return join(dir, 'attempts.json');
}

export function readSelfCheckAttempts(dir: string): Readonly<Record<string, SelfCheckAttempt>> {
  try {
    const a = JSON.parse(readFileSync(selfCheckAttemptsPath(dir), 'utf8')) as { format?: string; byKey?: Record<string, SelfCheckAttempt> };
    if (a.format === SELFCHECK_ATTEMPTS_FORMAT && typeof a.byKey === 'object' && a.byKey !== null) return a.byKey;
  } catch {
    /* none yet */
  }
  return {};
}

export function writeSelfCheckAttempt(dir: string, key: string, outcome: SelfCheckAttemptOutcome, now = Date.now()): void {
  const byKey = { ...readSelfCheckAttempts(dir), [key]: { at: now, outcome } };
  ensureDirChainDurable(dir, dir);
  writeDurable(selfCheckAttemptsPath(dir), `${JSON.stringify({ format: SELFCHECK_ATTEMPTS_FORMAT, byKey })}\n`);
}

/** Items that must pass before seats start (9.3), and those that must have passed in a live run. */
export const GATE_ITEMS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 10];
export const LIVE_ITEMS: readonly number[] = [1, 2, 3, 8];
/** Item 9 decides only the money form of spend_limit (6.5). */
export const MONEY_ITEM = 9;

export interface GatePolicy {
  /** Windows native with "隔离降级" accepted: items 5 and 6 do not apply (9.3). */
  readonly isolationDegraded?: boolean;
  /** Tests only: accept items recorded as fixtures in place of live runs. Production never sets it. */
  readonly acceptFixtures?: boolean;
  /** The time the latest attempt is judged at (default now). */
  readonly now?: number;
}

/**
 * THE gate policy for a seat installation: what the scheduler, the seat hosts, `mp selfcheck`
 * and the engine start's background trigger all use, from the same configuration (the seat
 * installation's acceptFixtures), so none of them can judge the evidence differently.
 */
export function seatGatePolicy(install: { readonly acceptFixtures?: boolean }): GatePolicy {
  return { isolationDegraded: process.platform === 'win32', acceptFixtures: install.acceptFixtures === true };
}

export interface GateVerdict {
  readonly seatsAllowed: boolean;
  readonly moneyModeAllowed: boolean;
  readonly key: string;
  /** Items with no result for these versions. */
  readonly missing: readonly number[];
  /** Items that failed, or ran in a mode that does not count. */
  readonly failed: readonly { readonly item: number; readonly why: string }[];
  /** The latest run for these versions, when it denies seats (failed, or running past the deadline). */
  readonly lastRun?: string | null;
  readonly reason: string | null;
}

export function selfCheckGate(dir: string, v: ToolchainVersions, policy: GatePolicy = {}): GateVerdict {
  const key = versionKey(v);
  const rec = readSelfCheck(dir, v);
  const required = GATE_ITEMS.filter((i) => !(policy.isolationDegraded === true && (i === 5 || i === 6)));
  const missing: number[] = [];
  const failed: { item: number; why: string }[] = [];
  /** The result that counts for an item: a live run (or, for tests that allow it, a fixture); offline only where offline suffices. */
  const verdict = (item: number, live: boolean): { r: SelfCheckResult | undefined; why: string | null } => {
    const liveRun = rec?.items[slot(item, 'live')];
    const fixture = policy.acceptFixtures === true ? rec?.items[slot(item, 'fixture')] : undefined;
    const offline = rec?.items[slot(item, 'offline')];
    const r = liveRun ?? fixture ?? (live ? undefined : offline);
    if (r === undefined) {
      if (live && offline !== undefined) return { r: offline, why: offline.ok ? 'passed offline only; this item needs a live run' : `failed offline: ${offline.detail.slice(0, 300)}` };
      if (rec?.items[slot(item, 'fixture')] !== undefined) return { r: rec.items[slot(item, 'fixture')], why: 'recorded by a test fixture, not run' };
      return { r: undefined, why: null };
    }
    // an offline failure of an item that needs a live run still blocks: the session options are wrong
    if (live && offline !== undefined && !offline.ok) return { r: offline, why: `failed offline: ${offline.detail.slice(0, 300)}` };
    return { r, why: r.ok ? null : `failed: ${r.detail.slice(0, 300)}` };
  };
  for (const i of required) {
    const v = verdict(i, LIVE_ITEMS.includes(i));
    if (v.r === undefined) missing.push(i);
    else if (v.why !== null) failed.push({ item: i, why: v.why });
  }
  const m = verdict(MONEY_ITEM, true);
  const moneyModeAllowed = m.r !== undefined && m.why === null;
  // r7: the latest run for these versions decides too (its evidence may not have been written)
  const attempt = readSelfCheckAttempts(dir)[key];
  const now = policy.now ?? Date.now();
  const lastRun =
    attempt === undefined
      ? null
      : attempt.outcome === 'failed'
        ? `the latest self-check run for these versions failed (${new Date(attempt.at).toISOString()})`
        : (attempt.outcome === 'running' || attempt.outcome === 'started') && now - attempt.at > SELFCHECK_RUN_DEADLINE_MS
          ? `the latest self-check run for these versions did not finish (started ${new Date(attempt.at).toISOString()})`
          : null;
  const seatsAllowed = missing.length === 0 && failed.length === 0 && lastRun === null;
  const reason = seatsAllowed
    ? null
    : `no passing startup self-check for these versions (Claude Code ${v.claudeCode}, SDK ${v.sdk}, Node ${v.node}; key ${key})` +
      (rec === null ? ': no evidence recorded' : '') +
      (missing.length > 0 ? `; missing items ${missing.join(', ')}` : '') +
      (failed.length > 0 ? `; ${failed.map((f) => `item ${f.item} ${f.why}`).join('; ')}` : '') +
      (lastRun !== null ? `; ${lastRun}` : '');
  return { seatsAllowed, moneyModeAllowed, key, missing, failed, lastRun, reason };
}

// ---------------------------------------------------------------- offline items (exec)

export interface SandboxCheckConfig extends Pick<ExecInstallConfig, 'agentRuntime' | 'bwrap' | 'nsenter'> {}

interface Secrets {
  readonly ledger: string;
  readonly git: string;
  readonly credentials: string;
  readonly outside: string;
}

interface Fixture {
  readonly root: string;
  readonly snap: string;
  readonly secrets: Secrets;
  readonly paths: Secrets;
  readonly sandbox: ToolSandbox;
  readonly tools: ProgramTools;
}

/** A throwaway snapshot with secrets around it: a "ledger", a repository's .git, a credentials file. */
async function fixture(config: SandboxCheckConfig): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'mp-selfcheck-'));
  const tag = `${process.pid}-${Date.now()}`;
  const secrets: Secrets = { ledger: `SECRET-LEDGER-${tag}`, git: `SECRET-GIT-${tag}`, credentials: `SECRET-CRED-${tag}`, outside: `SECRET-OUTSIDE-${tag}` };
  const paths: Secrets = {
    ledger: join(root, 'ledger', 'ledger.db'),
    git: join(root, 'repo', '.git', 'config'),
    credentials: join(root, 'home', '.claude', '.credentials.json'),
    outside: join(root, 'outside.txt'),
  };
  for (const [k, p] of Object.entries(paths)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${secrets[k as keyof Secrets]}\n`);
  }
  const snap = join(root, 'snap');
  mkdirSync(join(snap, 'w'), { recursive: true });
  writeFileSync(join(snap, 'in.txt'), 'inside\n');
  symlinkSync(paths.ledger, join(snap, 'escape-ledger'));
  symlinkSync(join(root, 'home'), join(snap, 'escape-home'));
  symlinkSync(paths.outside, join(snap, 'w', 'link-out'));
  mkdirSync(join(root, 'session'));
  const sandbox = await ToolSandbox.create(
    {
      snapshotDir: snap,
      writablePaths: ['w'],
      area: { kind: 'tmpfs', bytes: 4 << 20 },
      environment: hostSystemEnvironment(),
      sessionDir: join(root, 'session'),
      runtime: config.agentRuntime ?? defaultAgentRuntime(),
      ...(config.bwrap !== undefined ? { bwrapPath: config.bwrap } : {}),
      ...(config.nsenter !== undefined ? { nsenterPath: config.nsenter } : {}),
    },
    { runLayers: null },
  );
  return { root, snap, secrets, paths, sandbox, tools: new ProgramTools(sandbox, undefined, { runPrefix: 'selfcheck' }) };
}

async function withFixture(item: number, name: string, config: SandboxCheckConfig, body: (f: Fixture, events: unknown[]) => Promise<string | null>): Promise<SelfCheckResult> {
  const t0 = Date.now();
  const events: unknown[] = [];
  let f: Fixture | null = null;
  try {
    f = await fixture(config);
    const failure = await body(f, events);
    return { item, name, ok: failure === null, detail: failure ?? 'all probes refused', ms: Date.now() - t0, mode: 'offline', events, at: new Date().toISOString() };
  } catch (e) {
    return { item, name, ok: false, detail: `the check could not run: ${(e as Error).message}`, ms: Date.now() - t0, mode: 'offline', events, at: new Date().toISOString() };
  } finally {
    if (f !== null) {
      await f.sandbox.close().catch(() => undefined);
      rmSync(f.root, { recursive: true, force: true });
    }
  }
}

const cap = (s: string): string => (s.length > 2000 ? `${s.slice(0, 2000)}…` : s);

function leaks(text: string, secrets: Secrets): string[] {
  return Object.entries(secrets)
    .filter(([, v]) => text.includes(v))
    .map(([k]) => k);
}

/**
 * 9.3 item 4: the file tools and "run command" cannot read outside the snapshot, the ledger,
 * .git or credentials, cannot write read-only paths, and a symlink replaced concurrently with
 * reads never exposes a host file.
 */
export function checkConfinement(config: SandboxCheckConfig = {}): Promise<SelfCheckResult> {
  return withFixture(4, 'file tools and run command stay inside the snapshot (also under concurrent symlink replacement)', config, async (f, events) => {
    const problems: string[] = [];
    const reads: [string, string][] = [
      ['relative escape', '../ledger/ledger.db'],
      ['absolute ledger', f.paths.ledger],
      ['absolute .git', f.paths.git],
      ['absolute credentials', f.paths.credentials],
      ['planted symlink to the ledger', 'escape-ledger'],
      ['planted symlink to the home', 'escape-home/.claude/.credentials.json'],
    ];
    for (const [what, path] of reads) {
      const r = await f.tools.readFile({ path });
      const text = r.ok ? r.value.content.text : `${r.error.code}: ${r.error.message}`;
      events.push({ probe: `read_file ${what}`, path, ok: r.ok, out: cap(text) });
      if (r.ok || leaks(text, f.secrets).length > 0) problems.push(`read_file ${what} was not refused`);
    }
    const cmd = await f.tools.runCommand({
      command: `cat ${f.paths.ledger} ${f.paths.git} ${f.paths.credentials} ${f.paths.outside}; cat escape-ledger; cat escape-home/.claude/.credentials.json; ls -la ${f.root}; cat $HOME/.claude/.credentials.json`,
    });
    const cmdOut = cmd.ok ? `${cmd.value.stdout.text}\n${cmd.value.stderr.text}` : cmd.error.message;
    events.push({ probe: 'run_command reads', ok: cmd.ok, exit: cmd.ok ? cmd.value.exit : null, out: cap(cmdOut) });
    if (!cmd.ok) problems.push(`run_command could not run: ${cmd.error.message}`);
    const leaked = leaks(cmdOut, f.secrets);
    if (leaked.length > 0) problems.push(`run_command read ${leaked.join(', ')}`);
    for (const [what, args] of [
      ['write a read-only snapshot file', { path: 'in.txt', content: 'changed' }],
      ['write through a symlink out of the snapshot', { path: 'escape-ledger', content: 'changed' }],
      ['write through a symlink planted in a writable path', { path: 'w/link-out', content: 'changed' }],
    ] as const) {
      const w = await f.tools.writeFile(args);
      events.push({ probe: `write_file ${what}`, ok: w.ok, out: w.ok ? 'written' : `${w.error.code}: ${w.error.message}` });
      if (w.ok) problems.push(`write_file could ${what}`);
    }
    const ro = await f.tools.runCommand({ command: `echo changed > in.txt; echo changed > ${f.paths.outside}; echo changed > w/link-out; echo changed > /usr/mp-selfcheck 2>&1; touch /mp-selfcheck` });
    events.push({ probe: 'run_command writes read-only paths', ok: ro.ok, out: ro.ok ? cap(`${ro.value.stdout.text}${ro.value.stderr.text}`) : ro.error.message });
    if (readFileSync(join(f.snap, 'in.txt'), 'utf8') !== 'inside\n') problems.push('the snapshot file changed on the host');
    if (readFileSync(f.paths.outside, 'utf8') !== `${f.secrets.outside}\n`) problems.push('a host file outside the snapshot changed');
    if (existsSync('/usr/mp-selfcheck') || existsSync('/mp-selfcheck')) problems.push('a read-only system path was written');
    // concurrent replacement: a flipper repoints w/flip between a snapshot file and the ledger
    // while the file tool reads it (the flipper runs outside the tool queue, in the same sandbox)
    const flipCmd = `i=0; while [ $i -lt 4000 ]; do ln -sfn /work/in.txt /work/w/flip; ln -sfn ${f.paths.ledger} /work/w/flip; ln -sfn ../escape-ledger /work/w/flip; i=$((i+1)); done`;
    const argv = f.sandbox.runArgv('/work', flipCmd);
    const flipper: ChildProcess = spawn(argv[0] as string, argv.slice(1), { env: { ...HELPER_ENV }, stdio: 'ignore', detached: true });
    flipper.on('error', (e) => problems.push(`the concurrent flipper could not run: ${e.message}`));
    let seen = 0;
    const raceLeaks = new Set<string>();
    try {
      for (let i = 0; i < 40; i++) {
        const r = await f.tools.readFile({ path: 'w/flip' });
        if (r.ok) {
          seen++;
          for (const l of leaks(r.value.content.text, f.secrets)) raceLeaks.add(l);
        }
        const c = await f.tools.searchContent({ pattern: 'SECRET', path: 'w' });
        if (c.ok) for (const l of leaks(c.value.text.text, f.secrets)) raceLeaks.add(l);
      }
    } finally {
      killGroup(flipper);
    }
    events.push({ probe: 'read_file while the symlink flips', readsThatReturned: seen, leaked: [...raceLeaks] });
    if (raceLeaks.size > 0) problems.push(`a concurrent symlink replacement exposed ${[...raceLeaks].join(', ')}`);
    return problems.length === 0 ? null : problems.join('; ');
  });
}

async function hostListener(): Promise<{ server: Server; port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((s) => {
    hits++;
    s.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
  });
  // r7: a listen error rejects (never an unhandled 'error' event); later errors are ignored
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      server.on('error', () => undefined);
      resolve();
    });
  });
  const a = server.address();
  if (a === null || typeof a === 'string') throw new Error('no listener address');
  return { server, port: a.port, hits: () => hits };
}

/** Network probes with whatever clients the environment has; each must fail. */
function netProbes(port: number): string {
  return [
    'echo "== interfaces"; cat /proc/net/dev; echo "== routes"; cat /proc/net/route; echo "== ipv6 routes"; cat /proc/net/ipv6_route 2>/dev/null',
    `if command -v bash >/dev/null; then bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port} && echo NET-OK-bash-loopback' 2>&1; bash -c 'exec 3<>/dev/tcp/1.1.1.1/443 && echo NET-OK-bash-internet' 2>&1; fi`,
    `if command -v python3 >/dev/null; then python3 -c "import socket
for h,p in (('127.0.0.1',${port}),('1.1.1.1',443),('api.anthropic.com',443)):
  try:
    socket.create_connection((h,p),timeout=3); print('NET-OK-python',h)
  except Exception as e: print('refused',h,type(e).__name__)" 2>&1; fi`,
    `if command -v curl >/dev/null; then curl -sS -m 3 http://127.0.0.1:${port}/ && echo NET-OK-curl; curl -sS -m 3 https://api.anthropic.com/ && echo NET-OK-curl-model; fi 2>&1`,
    `if command -v wget >/dev/null; then wget -q -T 3 -O- http://127.0.0.1:${port}/ && echo NET-OK-wget; fi 2>&1`,
    'echo "== env"; env | grep -iE "anthropic|api_key|proxy|claude" || echo none',
  ].join('\n');
}

function interfacesOnlyLoopback(out: string): boolean {
  const sect = out.split('== interfaces')[1]?.split('== routes')[0] ?? '';
  const names = sect
    .split('\n')
    .map((l) => /^\s*([^:\s]+):/.exec(l)?.[1])
    .filter((n): n is string => n !== undefined);
  const routes = (out.split('== routes')[1]?.split('== ipv6 routes')[0] ?? '').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('Iface'));
  return names.length > 0 && names.every((n) => n === 'lo') && routes.length === 0;
}

/** 9.3 item 5: "run command" cannot reach the network, nor a model service on the host's loopback. */
export function checkNoNetwork(config: SandboxCheckConfig = {}): Promise<SelfCheckResult> {
  return withFixture(5, 'run command has no network and cannot call the model service', config, async (f, events) => {
    const l = await hostListener();
    try {
      const r = await f.tools.runCommand({ command: netProbes(l.port), timeoutMs: 60_000 });
      const out = r.ok ? `${r.value.stdout.text}\n${r.value.stderr.text}` : r.error.message;
      events.push({ probe: 'network from run_command', ok: r.ok, exit: r.ok ? r.value.exit : null, out: cap(out), hostListenerHits: l.hits() });
      const problems: string[] = [];
      if (!r.ok) problems.push(`run_command could not run: ${r.error.message}`);
      if (!interfacesOnlyLoopback(out)) problems.push('the sandbox has a network interface other than lo, or a route');
      if (/NET-OK/.test(out)) problems.push(`a connection succeeded (${(out.match(/NET-OK-[\w-]+/g) ?? []).join(', ')})`);
      if (l.hits() > 0) problems.push('the model-service stand-in on the host loopback was reached');
      if (/ANTHROPIC|API_KEY/i.test(out.split('== env')[1] ?? '')) problems.push('model credentials or endpoints are in the sandbox environment');
      return problems.length === 0 ? null : problems.join('; ');
    } finally {
      l.server.close();
    }
  });
}

/** 9.3 item 6: compound commands and subprocesses do not get around items 4 and 5; nothing outlives the call. */
export function checkCompoundCommands(config: SandboxCheckConfig = {}): Promise<SelfCheckResult> {
  return withFixture(6, 'compound commands and subprocesses cannot get around items 4 and 5', config, async (f, events) => {
    const l = await hostListener();
    const marker = `mp-selfcheck-orphan-${process.pid}-${Date.now()}`;
    try {
      const commands = [
        `true && cat ${f.paths.ledger}; (cat ${f.paths.git}); sh -c 'cat ${f.paths.credentials}'; echo $(cat ${f.paths.outside})`,
        `sh -c "sh -c 'cat ${f.paths.ledger}; cat escape-ledger'"; env -i /bin/sh -c 'cat ${f.paths.credentials}'`,
        `sh -c '${netProbes(l.port).replace(/'/g, `'"'"'`)}'`,
        `(exec -a ${marker} sleep 60) >/dev/null 2>&1 & echo started`,
      ];
      const problems: string[] = [];
      for (const command of commands) {
        const r = await f.tools.runCommand({ command, timeoutMs: 60_000 });
        const out = r.ok ? `${r.value.stdout.text}\n${r.value.stderr.text}` : r.error.message;
        events.push({ probe: command.slice(0, 200), ok: r.ok, exit: r.ok ? r.value.exit : null, out: cap(out) });
        const leaked = leaks(out, f.secrets);
        if (leaked.length > 0) problems.push(`a compound command read ${leaked.join(', ')}`);
        if (/NET-OK/.test(out)) problems.push('a subprocess reached the network');
      }
      if (l.hits() > 0) problems.push('a subprocess reached the host loopback');
      const survivors = readProcessesMatching(marker);
      events.push({ probe: 'background process after its call', survivors });
      if (survivors.length > 0) problems.push(`a background process outlived its call (${survivors.join(', ')})`);
      return problems.length === 0 ? null : problems.join('; ');
    } finally {
      l.server.close();
    }
  });
}

function readProcessesMatching(marker: string): number[] {
  const out: number[] = [];
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  for (const pid of pids) {
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(marker)) out.push(Number(pid));
    } catch {
      /* gone */
    }
  }
  return out;
}

/**
 * 9.3 item 10: start a throwaway tool sandbox with the configured runtime and have the agent
 * read a file through it. Deterministic pass/fail; never throws.
 */
export async function checkAgentRuntime(config: Pick<ExecInstallConfig, 'agentRuntime' | 'bwrap' | 'nsenter'> = {}): Promise<SelfCheckResult> {
  const t0 = Date.now();
  const name = 'file-tool runtime loads inside the tool sandbox';
  const root = mkdtempSync(join(tmpdir(), 'mp-selfcheck-'));
  const marker = `selfcheck-${process.pid}-${t0}`;
  let sandbox: ToolSandbox | null = null;
  const done = (ok: boolean, detail: string, events: unknown[]): SelfCheckResult => ({ item: 10, name, ok, detail, ms: Date.now() - t0, mode: 'offline', events, at: new Date().toISOString() });
  try {
    mkdirSync(join(root, 'snap'));
    writeFileSync(join(root, 'snap', 'probe.txt'), marker);
    mkdirSync(join(root, 'session'));
    const runtime = config.agentRuntime ?? defaultAgentRuntime();
    sandbox = await ToolSandbox.create(
      {
        snapshotDir: join(root, 'snap'),
        writablePaths: [],
        area: { kind: 'tmpfs', bytes: 1 << 20 },
        environment: hostSystemEnvironment(),
        sessionDir: join(root, 'session'),
        runtime,
        ...(config.bwrap !== undefined ? { bwrapPath: config.bwrap } : {}),
        ...(config.nsenter !== undefined ? { nsenterPath: config.nsenter } : {}),
      },
      { runLayers: null },
    );
    const reply = await sandbox.callAgent(
      { op: 'read', path: `${sandbox.mountPoint}/probe.txt`, offset: 0, maxBytes: 4096 },
      { timeoutMs: 30_000, maxResponseBytes: 1 << 16 },
    );
    const ok = reply.ok && (reply.result as { content?: unknown }).content === marker;
    return done(ok, ok ? `runtime ${runtime.node} loaded` : `agent answered ${JSON.stringify(reply).slice(0, 500)}`, [{ probe: 'agent read', reply: JSON.stringify(reply).slice(0, 500) }]);
  } catch (e) {
    return done(false, (e as Error).message, [{ probe: 'agent read', error: (e as Error).message }]);
  } finally {
    if (sandbox !== null) await sandbox.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

/** The exec items of the offline self-check (4, 5, 6, 10), in order. */
export async function runExecSelfCheck(config: SandboxCheckConfig = {}): Promise<SelfCheckResult[]> {
  return [await checkConfinement(config), await checkNoNetwork(config), await checkCompoundCommands(config), await checkAgentRuntime(config)];
}
