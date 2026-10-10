// The real engine stack for the end-to-end mission (test/e2e-mission.test.ts), built the way a
// user's machine gets it:
//
//   1. a temp git project (a tiny Python module with a unittest suite) whose main checkout is
//      on `main`, and a temp HOME with a git identity and a subscription-shaped Claude login
//      holding fake tokens (the fake model accepts anything);
//   2. `mp install --credentials subscription` (the real CLI, as a child process) writes every
//      configuration file and both stop inboxes into a temp root (--no-start, --skip-selfcheck:
//      the offline self-check is recorded as fixtures below, as the seat tests do);
//   3. the scheduler's seat installation gets the only two things install cannot give a test
//      (TEST-PATCH, nothing else is touched): `seats.upstream` (the scripted fake model's URL)
//      and `seats.acceptFixtures` (accept the fixture self-check evidence; production never sets it);
//   4. the PM session's SessionStart hook starts the watchdog, detached, which starts the ledger
//      service, the scheduler (with its flows and its evaluator worker) and the inbox probes.
//
// Everything lives under os.tmpdir() (a Linux tmpfs here), never under /mnt; close() stops the
// watchdog, ends every unit a launch of this stack started, and removes the directories, and it
// reports what was left behind (processes, units, mounts) BEFORE removing anything.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient } from '../../src/common/rpc.ts';
import { detectExecCapabilities } from '../../src/exec/platform.ts';
import { killUnit, unitActiveState } from '../../src/exec/supervisor.ts';
import { LedgerClient } from '../../src/ledger/ipc.ts';
import { allLaunchMeta } from '../../src/scheduler/launches.ts';
import { recordFixtureSelfCheck } from '../seat-harness.ts';
import { startFakeSeats, type FakeSeats, type SeatPlan } from './seats.ts';

export const ENGINE = fileURLToPath(new URL('../../', import.meta.url));
export const CLI_MAIN = join(ENGINE, 'src', 'cli', 'main.ts');
export const HOOK_MAIN = join(ENGINE, 'src', 'cli', 'hooks', 'main.ts');
const NODE_ARGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

const caps = detectExecCapabilities();
/**
 * Opt-in (MP_E2E=1): six missions through real units take about 10 minutes, so the default
 * `npm test` loop of the other suites does not pay for them.
 */
export const E2E_SKIP: false | string =
  process.env['MP_E2E'] !== '1'
    ? 'the end-to-end missions run only with MP_E2E=1 (about 10 minutes, real units and a fake model)'
    : caps.systemdRun !== null && caps.delegatedControllers.includes('memory') && caps.delegatedControllers.includes('pids') && caps.bwrapUsable && caps.nsenter !== null
      ? false
      : 'needs systemd-run --user with delegated memory and pids controllers, a usable bwrap, and nsenter';

/** Whether this machine has fuse2fs (the run must not need it: ordinary tasks use a tmpfs area). */
export const HAS_FUSE2FS = caps.fuse2fs !== null;

// ---------------------------------------------------------------- child processes

export interface Out {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runNode(argv: readonly string[], o: { env: NodeJS.ProcessEnv; cwd: string; input?: string; timeoutMs?: number }): Promise<Out> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [...NODE_ARGS, ...argv], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    c.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => c.kill('SIGKILL'), o.timeoutMs ?? 120_000);
    c.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    c.stdin.end(o.input ?? '');
  });
}

// ---------------------------------------------------------------- the project

export interface ProjectFiles {
  readonly [path: string]: string;
}

function git(cwd: string, home: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
}

// ---------------------------------------------------------------- the stack

export interface StackOptions {
  readonly name: string;
  readonly files: ProjectFiles;
  readonly seats: SeatPlan;
  /** Extra scheduler options (merged over what mp install wrote). */
  readonly scheduler?: Record<string, unknown>;
}

export interface Leftovers {
  readonly processes: string[];
  readonly units: string[];
  readonly mounts: string[];
}

export class Stack {
  readonly root: string;
  readonly backupRoot: string;
  readonly repo: string;
  readonly home: string;
  readonly configPath: string;
  cli!: {
    ledgerRoot: string;
    controlPlane: string;
    ledgerSocket: string;
    schedulerSocket: string;
    evaluatorSocket: string;
    stateDir: string;
    engineConfig: string;
    selfCheckDir: string;
    modelConfig: string;
  };
  schedulerConfigPath = '';
  /** The scheduler's own state directory (from the scheduler config). */
  schedulerState = '';
  seats!: FakeSeats;
  readonly notes: string[] = [];
  private clients: Array<{ close(): void }> = [];

  readonly o: StackOptions;

  constructor(o: StackOptions) {
    this.o = o;
    this.root = mkdtempSync(join(tmpdir(), `mp-e2e-${o.name}-`));
    this.backupRoot = mkdtempSync(join(tmpdir(), `mp-e2e-${o.name}-backup-`));
    this.repo = join(this.root, 'project');
    this.home = join(this.root, 'home');
    this.configPath = join(this.root, 'engine4.json');
  }

  get env(): NodeJS.ProcessEnv {
    return { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: this.home, LANG: 'C.UTF-8', MP_CONFIG: this.configPath, ...(process.env['XDG_RUNTIME_DIR'] ? { XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'] } : {}), ...(process.env['DBUS_SESSION_BUS_ADDRESS'] ? { DBUS_SESSION_BUS_ADDRESS: process.env['DBUS_SESSION_BUS_ADDRESS'] } : {}) };
  }

  /** The project repository with its main checkout on `main`. */
  makeProject(): string {
    mkdirSync(this.home, { recursive: true });
    writeFileSync(join(this.home, '.gitconfig'), '[user]\n\tname = E2E User\n\temail = e2e@example.invalid\n[init]\n\tdefaultBranch = main\n');
    mkdirSync(this.repo, { recursive: true });
    git(this.repo, this.home, 'init', '-q', '-b', 'main');
    for (const [p, data] of Object.entries(this.o.files)) {
      mkdirSync(dirname(join(this.repo, p)), { recursive: true });
      writeFileSync(join(this.repo, p), data);
    }
    git(this.repo, this.home, 'add', '-A');
    git(this.repo, this.home, 'commit', '-q', '-m', 'M0: the greeter module');
    return git(this.repo, this.home, 'rev-parse', 'HEAD').trim();
  }

  gitIn(...args: string[]): string {
    return git(this.repo, this.home, ...args);
  }

  /** `mp <argv> --json` as a child process; the parsed JSON (or the raw output when it is not JSON). */
  async mp(...argv: string[]): Promise<{ code: number; json: Record<string, unknown> | null; raw: Out }> {
    const out = await runNode([CLI_MAIN, ...argv, '--json', '--config', this.configPath], { env: this.env, cwd: this.repo });
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(out.stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { code: out.code, json, raw: out };
  }

  /** The PM session's UserPromptSubmit hook (plugin/hooks → src/cli/hooks/main.ts), as Claude Code runs it. */
  async userPrompt(prompt: string, promptId: string): Promise<{ output: Record<string, unknown> | null; facts: string; raw: Out }> {
    const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'e2e-pm-session', prompt_id: promptId, cwd: this.repo, prompt });
    const out = await runNode([HOOK_MAIN, 'user-prompt-submit'], { env: { ...this.env, MP_HOOK_DEBUG: '1' }, cwd: this.repo, input, timeoutMs: 30_000 });
    let output: Record<string, unknown> | null = null;
    try {
      output = out.stdout.trim() === '' ? null : (JSON.parse(out.stdout.trim()) as Record<string, unknown>);
    } catch {
      output = null;
    }
    return { output, facts: out.stderr, raw: out };
  }

  /** Install (mp install), add the test's two seat settings, record the fixture self-check, start the fake model and the engine. */
  async start(): Promise<void> {
    // a subscription-shaped login with fake tokens, where install looks for the Claude Code login
    mkdirSync(join(this.home, '.claude'), { recursive: true });
    writeFileSync(
      join(this.home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-e2e-fake-access', refreshToken: 'sk-ant-ort01-e2e-fake-refresh', expiresAt: Date.now() + 24 * 3_600_000, scopes: ['user:inference'] } }),
      { mode: 0o600 },
    );
    const install = await this.mp(
      'install',
      '--root',
      join(this.root, 'engine'),
      '--project',
      this.repo,
      '--credentials',
      'subscription',
      '--control-plane',
      join(this.root, 'cp'),
      '--backup-inbox',
      join(this.backupRoot, 'stop-inbox', 'backup.inbox'),
      '--bin-dir',
      join(this.root, 'bin'),
      '--skip-selfcheck',
      '--no-start',
    );
    this.installOutput = install.raw.stdout + install.raw.stderr;
    if (!existsSync(this.configPath)) throw new Error(`mp install wrote no configuration (exit ${install.code}):\n${install.raw.stdout}\n${install.raw.stderr}`);
    const cfg = JSON.parse(readFileSync(this.configPath, 'utf8')) as Stack['cli'];
    this.cli = cfg;
    this.schedulerConfigPath = join(dirname(cfg.engineConfig), 'scheduler.json');
    const sched = JSON.parse(readFileSync(this.schedulerConfigPath, 'utf8')) as Record<string, unknown>;
    this.installedScheduler = sched;
    this.schedulerState = String(sched['stateDir']);
    const seats = sched['seats'] as Record<string, unknown> | undefined;
    if (sched['flow'] === undefined || seats === undefined) {
      throw new Error(`mp install wrote no ${sched['flow'] === undefined ? '`flow`' : ''} ${seats === undefined ? '`seats`' : ''} into ${this.schedulerConfigPath}:\n${JSON.stringify(sched, null, 2)}\n${this.installOutput}`);
    }

    // the startup self-check evidence (9.3), recorded as fixtures exactly as the seat host tests do
    recordFixtureSelfCheck(cfg.selfCheckDir);

    this.seats = await startFakeSeats({ stateDir: this.schedulerState, contentRoot: join(cfg.ledgerRoot, 'content'), plan: this.o.seats });

    // TEST-PATCH (the only change to install's output): the fake model as the seats' upstream,
    // and the fixture self-check evidence accepted. Neither can come from install.
    writeFileSync(this.schedulerConfigPath, `${JSON.stringify({ ...sched, seats: { ...seats, upstream: this.seats.url, acceptFixtures: true }, ...(this.o.scheduler ?? {}) }, null, 2)}\n`);

    // the PM session opens: its SessionStart hook starts the engine (6.3 "打开 PM 再启动")
    const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'e2e-pm-session', source: 'startup', cwd: this.repo });
    const hook = await runNode([HOOK_MAIN, 'session-start'], { env: { ...this.env, MP_HOOK_DEBUG: '1' }, cwd: this.repo, input, timeoutMs: 90_000 });
    this.sessionStart = hook.stdout;
    const state = await this.mp('engine-state');
    const st = (state.json?.['result'] ?? {}) as { running?: boolean; ledgerBeating?: boolean; schedulerBeating?: boolean };
    if (st.running !== true || st.ledgerBeating !== true || st.schedulerBeating !== true) {
      throw new Error(`the SessionStart hook did not start the engine: ${JSON.stringify(state.json)}\nhook stdout: ${hook.stdout}\nhook stderr: ${hook.stderr}\n${this.logs()}`);
    }
  }

  /** The SessionStart hook's output (the PM's context at session start). */
  sessionStart = '';
  /** What mp install printed, and the scheduler configuration it wrote (before the test's patch). */
  installOutput = '';
  installedScheduler: Record<string, unknown> = {};

  private ledgerClient: LedgerClient | null = null;
  private schedulerClient: RpcClient | null = null;
  private evaluatorClient: RpcClient | null = null;

  /** One client per service for the whole test (the test only reads). */
  ledger(): LedgerClient {
    if (this.ledgerClient === null) {
      this.ledgerClient = new LedgerClient(this.cli.ledgerSocket, 10_000);
      this.clients.push(this.ledgerClient);
    }
    return this.ledgerClient;
  }

  scheduler(): RpcClient {
    if (this.schedulerClient === null) {
      this.schedulerClient = new RpcClient(this.cli.schedulerSocket, 10_000);
      this.clients.push(this.schedulerClient);
    }
    return this.schedulerClient;
  }

  evaluator(): RpcClient {
    if (this.evaluatorClient === null) {
      this.evaluatorClient = new RpcClient(this.cli.evaluatorSocket, 10_000);
      this.clients.push(this.evaluatorClient);
    }
    return this.evaluatorClient;
  }

  /** The tail of every engine log, for failure messages. */
  logs(bytes = 3000): string {
    const dir = join(this.root, 'engine', 'logs');
    if (!existsSync(dir)) return '(no logs)';
    return readdirSync(dir)
      .map((f) => {
        const t = readFileSync(join(dir, f), 'utf8');
        return `--- ${f} (last ${bytes} bytes)\n${t.slice(-bytes)}`;
      })
      .join('\n');
  }

  /** Processes whose command line names this stack's directories. */
  ownProcesses(): string[] {
    const out: string[] = [];
    for (const p of readdirSync('/proc')) {
      if (!/^\d+$/.test(p) || Number(p) === process.pid) continue;
      try {
        const cmd = readFileSync(`/proc/${p}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
        let cwd = '';
        try {
          cwd = readlinkSync(`/proc/${p}/cwd`);
        } catch {
          cwd = '';
        }
        if (cmd.includes(this.root) || cmd.includes(this.backupRoot) || cwd.startsWith(this.root)) out.push(`${p}: ${cmd.slice(0, 200)}`);
      } catch {
        /* gone */
      }
    }
    return out;
  }

  async leftovers(): Promise<Leftovers> {
    const units: string[] = [];
    for (const m of existsSync(this.schedulerState) ? allLaunchMeta(this.schedulerState) : []) {
      const s = await unitActiveState(m.unitName);
      if (s !== 'inactive' && s !== 'failed' && s !== 'unknown' && s !== '') units.push(`${m.unitName}: ${s}`);
    }
    const mounts = readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .filter((l) => l.includes(this.root) || l.includes(this.backupRoot));
    return { processes: this.ownProcesses(), units, mounts };
  }

  /** Stop the watchdog (SIGTERM: it ends the scheduler, the probes and the ledger) and wait for the processes to end. */
  async stopEngine(timeoutMs = 60_000): Promise<void> {
    for (const c of this.clients.splice(0)) c.close();
    this.ledgerClient = null;
    this.schedulerClient = null;
    this.evaluatorClient = null;
    const st = (() => {
      try {
        return JSON.parse(readFileSync(join(this.cli.controlPlane, 'watchdog.json'), 'utf8')) as { pid: number };
      } catch {
        return null;
      }
    })();
    if (st !== null) {
      try {
        process.kill(st.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const own = this.ownProcesses().filter((p) => /watchdog-main|ledger\/main|scheduler\/main|probe-main|worker-main/.test(p));
      if (own.length === 0) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Everything this stack started is ended and its directories removed. Returns what was left behind at the stop. */
  async close(): Promise<Leftovers> {
    if (this.cli !== undefined) await this.stopEngine();
    // what the engine left behind after its own stop (asserted by the tests)
    const left = this.cli !== undefined ? await this.leftovers() : { processes: [], units: [], mounts: [] };
    // then force everything down, whatever is left
    if (existsSync(this.schedulerState)) for (const m of allLaunchMeta(this.schedulerState)) await killUnit(m.unitName).catch(() => undefined);
    for (const p of this.ownProcesses()) {
      try {
        process.kill(Number(p.split(':')[0]), 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    for (const l of readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const mp = l.split(' ')[1];
      if (mp !== undefined && (mp.startsWith(this.root) || mp.startsWith(this.backupRoot))) {
        try {
          execFileSync('fusermount3', ['-uz', mp.replace(/\\040/g, ' ')], { stdio: 'ignore' });
        } catch {
          /* not ours, or gone */
        }
      }
    }
    await this.seats?.close().catch(() => undefined);
    if (process.env['MP_E2E_KEEP'] === '1') {
      process.stderr.write(`[e2e] MP_E2E_KEEP=1: kept ${this.root} and ${this.backupRoot}\n`);
      return left;
    }
    for (const d of [this.root, this.backupRoot]) {
      try {
        execFileSync('chmod', ['-R', 'u+rwX', d], { stdio: 'ignore' });
      } catch {
        /* best effort */
      }
      rmSync(d, { recursive: true, force: true });
    }
    return left;
  }
}

// ---------------------------------------------------------------- waiting

export async function waitFor<T>(what: string, ms: number, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, diag: () => Promise<string> | string = () => '', every = 500): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  for (;;) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined && v !== false) return v as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}\n${await diag()}`);
    await new Promise((r) => setTimeout(r, every));
  }
}
