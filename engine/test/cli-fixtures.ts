// Shared helpers for the CLI and hook suites (test/cli-*.test.ts). Not a test file.
// Everything lives under os.tmpdir() (a Linux filesystem), never under /mnt; nothing
// touches the repository's data/ directory; no model is ever called.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, type CliOutput } from '../src/cli/main.ts';
import { CLI_CONFIG_FORMAT } from '../src/cli/config.ts';
import { LedgerClient } from '../src/ledger/ipc.ts';
import { makeEnv, type Env } from './scheduler-fixtures.ts';
import { checkSocketPath } from '../src/common/socketPath.ts';

export const CLI_MAIN = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
export const HOOK_MAIN = fileURLToPath(new URL('../src/cli/hooks/main.ts', import.meta.url));
export const PLUGIN_ROOT = fileURLToPath(new URL('../plugin/', import.meta.url));
export const NODE_ARGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

export interface CliEnv extends Env {
  readonly configPath: string;
  readonly cliState: string;
  readonly project: string;
  readonly schedulerSocket: string;
  readonly evaluatorCheckpoint: string;
  readonly modelConfig: string;
}

export function cliEnv(prefix: string, o: { readonly scheduler?: boolean; readonly engineConfig?: string | null; readonly backupInbox?: string | null; readonly extra?: Record<string, unknown> } = {}): CliEnv {
  const e = makeEnv(`cli-${prefix}`);
  const project = join(e.root, 'project');
  const cliState = join(e.root, 'cli-state');
  mkdirSync(project, { recursive: true });
  mkdirSync(cliState, { recursive: true });
  const env: CliEnv = {
    ...e,
    configPath: join(e.root, 'engine4.json'),
    cliState,
    project,
    schedulerSocket: checkSocketPath(join(e.root, 'scheduler.sock'), 'set a shorter TMPDIR (e.g. mktemp -d /tmp/mpc.XXXX)'),
    evaluatorCheckpoint: join(e.root, 'evaluator.checkpoint'),
    modelConfig: join(e.root, 'model_config.json'),
  };
  writeConfig(env, o);
  return env;
}

export function writeConfig(env: CliEnv, o: { readonly scheduler?: boolean; readonly engineConfig?: string | null; readonly backupInbox?: string | null; readonly extra?: Record<string, unknown> } = {}): void {
  writeFileSync(
    env.configPath,
    JSON.stringify({
      format: CLI_CONFIG_FORMAT,
      engineRoot: fileURLToPath(new URL('../', import.meta.url)),
      ledgerRoot: env.ledgerRoot,
      controlPlane: env.cp,
      ledgerSocket: env.socket,
      schedulerSocket: o.scheduler === true ? env.schedulerSocket : null,
      evaluatorSocket: null,
      evaluatorCheckpoint: env.evaluatorCheckpoint,
      stateDir: env.cliState,
      engineConfig: o.engineConfig ?? null,
      ...(o.backupInbox !== undefined ? { backupInbox: o.backupInbox } : {}),
      modelConfig: env.modelConfig,
      selfCheckDir: null,
      projects: [{ root: env.project, targetBranch: 'main', mainCheckout: env.project }],
      timeouts: { ledgerMs: 3_000, schedulerMs: 10_000, hookLedgerMs: 1_500 },
      ...(o.extra ?? {}),
    }),
  );
}

export function ioOf(env: CliEnv, cwd: string = env.project): { cwd: string; env: NodeJS.ProcessEnv; now: () => number } {
  return { cwd, env: { ...process.env, MP_CONFIG: env.configPath, MP_PM_SESSION: '' }, now: Date.now };
}

/** Run `mp` in this process. */
export function mp(env: CliEnv, ...argv: string[]): Promise<CliOutput> {
  return runCli(argv, ioOf(env));
}

/** Run `mp ... --json` and parse the output. */
export async function mpJson(env: CliEnv, ...argv: string[]): Promise<{ exitCode: number; out: Record<string, unknown> }> {
  const r = await runCli([...argv, '--json'], ioOf(env));
  return { exitCode: r.exitCode, out: JSON.parse(r.stdout) as Record<string, unknown> };
}

export interface ProcResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

/** Run a script as its own process with stdin, the way Claude Code runs a hook or the PM runs mp. */
export function runProcess(script: string, args: readonly string[], o: { readonly input?: string; readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs?: number }): Promise<ProcResult> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...NODE_ARGS, script, ...args], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out: ${script} ${args.join(' ')}`));
    }, o.timeoutMs ?? 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.end(o.input ?? '');
  });
}

export async function ledgerCall(env: CliEnv, method: string, params: unknown = {}): Promise<unknown> {
  const c = new LedgerClient(env.socket, 5_000);
  try {
    return await c.call(method as never, params as never);
  } finally {
    c.close();
  }
}
