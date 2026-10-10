// The startup self-check as the product runs it (design 9.3; release blocker of the live run:
// nothing in production ran the live items, so after a real `mp install` no seat ever started,
// and every Claude Code update blocked them again). One run:
//   - the offline items (4, 5, 6, 7, 10 and the offline parts of 1-3);
//   - the live items 1-3: the probe session run exactly as a seat runs, under the configured
//     login (a subscription login's claudeAiOauth entry only, never its refresh token), through
//     the metering proxy, on the cheapest configured model;
//   - the live item 8: the PM monitor probe (src/cli/pmMonitorProbe.ts; needs the engine);
//   - the results recorded in the seat installation's selfCheckDir for the versions in use, so
//     the gate (exec/selfcheck.ts selfCheckGate) the scheduler and the seat hosts read passes.
// Item 9 (money mode only) is not run here.
//
// Who runs it: `mp install` (after starting the engine, when a login is configured), `mp selfcheck`
// (the manual retry, WI-18), and, by itself, the engine start path (the PM's SessionStart hook and
// `mp ensure-running`): when the gate finds items missing or failed for the versions in use (a
// Claude Code, SDK or Node update changes them), a detached `mp selfcheck --auto` runs in the
// background, at most once per version key per hour (the attempts are recorded); a failure raises
// one WI-18 notice naming the failing items; a pass lets the scheduler dispatch seats again.

import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DurableOps } from '../exec/durable.ts';
import {
  readSelfCheckAttempts,
  recordSelfCheck,
  runExecSelfCheck,
  selfCheckAttemptsPath,
  seatGatePolicy,
  selfCheckGate,
  toolchainVersions,
  versionKey,
  writeSelfCheckAttempt,
  type ExecInstallConfig,
  type GateVerdict,
  type SelfCheckAttemptOutcome,
  type SelfCheckResult,
  type ToolchainVersions,
} from '../exec/selfcheck.ts';
import type { SeatCredentialsSpec } from './credentials.ts';
import { DEFAULT_MODEL_CONFIG, loadModelConfig, type ModelConfig, type SeatModel } from './modelConfig.ts';
import { checkLedgerRecognition, checkPmMonitor, checkSessionOffline, judgeProbeSession, runProbeSession, type PmMonitorProbe, type ProbeSession, type ProbeSessionOptions } from './selfcheck.ts';

export const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
/** One automatic attempt per version key per this long (no loop on a failing check). */
export const AUTO_SELFCHECK_INTERVAL_MS = 60 * 60_000;

/** What a run needs: the seat installation (scheduler.json `seats`). */
export interface SelfCheckSetup {
  readonly dir: string;
  readonly models: ModelConfig;
  readonly credentials: SeatCredentialsSpec;
  readonly install?: Pick<ExecInstallConfig, 'agentRuntime' | 'bwrap' | 'nsenter'>;
  readonly upstream?: string;
  readonly claudeExecutable?: string;
  /**
   * Tests only (the seat installation's acceptFixtures): fixture evidence counts, as it does for
   * the scheduler and the seat hosts. A run then checks the offline items only (a live run against
   * a test's model service would record failures that mask the fixtures), and the background
   * trigger never runs.
   */
  readonly acceptFixtures?: boolean;
}

export interface SelfCheckDeps {
  /** Runs the probe session (default: runProbeSession against the configured upstream). Tests stub it. */
  readonly probeSession?: (o: ProbeSessionOptions) => Promise<ProbeSession>;
  /** Item 8's probe; undefined: item 8 is recorded as not run (it needs the PM monitor probe). */
  readonly pmProbe?: PmMonitorProbe;
  /** The offline items (default: all of them). Tests stub it. */
  readonly offline?: () => Promise<readonly SelfCheckResult[]>;
  readonly versions?: ToolchainVersions;
  /** Item 2's wait (default 20 s, as the live test). */
  readonly waitMs?: number;
  /** false: the offline items only (no login, or no engine for item 8); the live slots are left as they are. */
  readonly live?: boolean;
  /** Tests only: the durable-write steps of the evidence record (a fault injected before its replace). */
  readonly recordOps?: DurableOps;
}

/**
 * Tests only: hooks merged OVER the deps every caller passes (the CLI and install paths run in
 * the test's process), to inject a fault or stand in for the model. Production never sets them.
 */
export const selfCheckTestHooks: { -readonly [K in keyof SelfCheckDeps]?: SelfCheckDeps[K] } = {};

export interface SelfCheckRun {
  readonly versions: ToolchainVersions;
  readonly key: string;
  readonly results: readonly SelfCheckResult[];
  readonly gate: GateVerdict;
}

/** The cheapest model the configuration prices among the seats' models (a few short requests). */
export function cheapestModel(models: ModelConfig): SeatModel {
  const seats = Object.values(models.seats);
  const cost = (m: SeatModel): number => {
    const p = models.metering.prices[m.model];
    return p === undefined ? Number.POSITIVE_INFINITY : p.inputPerMTok + p.outputPerMTok;
  };
  const best = [...seats].sort((a, b) => cost(a) - cost(b))[0];
  if (best === undefined) throw new Error('model_config.json names no seat model');
  return { provider: best.provider, model: best.model, maxOutputTokens: 256 };
}

/** The gate items each part of a run covers (a part that throws is recorded as failing all of them). */
export const OFFLINE_PARTS = { session: [1, 2, 3], sandbox: [4, 5, 6, 10], ledger: [7] } as const;

/**
 * Runs every gate item that can run here and records the evidence; returns the gate after it.
 * Every part runs inside its own exception handling (release review r6): a part that throws
 * (an initialization or a process spawn failing) is recorded as a FAILED result for each item it
 * covers, for the current version key, so an earlier passing record can never stand in for it:
 * the gate denies seats until a later run passes. Throws only when the versions cannot be read
 * or the record cannot be written (the callers then raise WI-18 themselves).
 */
export async function runStartupSelfCheck(setup: SelfCheckSetup, callerDeps: SelfCheckDeps = {}): Promise<SelfCheckRun> {
  const deps: SelfCheckDeps = { ...callerDeps, ...selfCheckTestHooks, ...(setup.acceptFixtures === true ? { live: false } : {}) };
  const versions = deps.versions ?? toolchainVersions(setup.claudeExecutable !== undefined ? { claudeExecutable: setup.claudeExecutable } : {});
  const results: SelfCheckResult[] = [];
  const part = async (items: readonly number[], mode: 'offline' | 'live', what: string, run: () => Promise<readonly SelfCheckResult[]>): Promise<void> => {
    const t0 = Date.now();
    try {
      results.push(...(await run()));
    } catch (e) {
      const err = e as Error;
      const at = new Date().toISOString();
      for (const item of items) {
        results.push({ item, name: `${what} (item ${item})`, ok: false, detail: `${what} could not run: ${err.message}`, ms: Date.now() - t0, mode, events: [{ error: err.message, stack: (err.stack ?? '').split('\n').slice(0, 8).join('\n') }], at });
      }
    }
  };
  if (deps.offline !== undefined) await part([...OFFLINE_PARTS.session, ...OFFLINE_PARTS.sandbox, ...OFFLINE_PARTS.ledger], 'offline', 'the offline self-check', deps.offline);
  else {
    await part(OFFLINE_PARTS.session, 'offline', 'the offline seat session check', () =>
      checkSessionOffline({ models: setup.models, ...(setup.install !== undefined ? { install: setup.install } : {}), ...(setup.claudeExecutable !== undefined ? { claudeExecutable: setup.claudeExecutable } : {}) }),
    );
    await part(OFFLINE_PARTS.sandbox, 'offline', 'the tool sandbox checks', () => runExecSelfCheck(setup.install ?? {}));
    await part(OFFLINE_PARTS.ledger, 'offline', 'the ledger recognition check', async () => [await checkLedgerRecognition()]);
  }
  // live items 1-3: the probe session, exactly as a seat runs, under the configured login
  if (deps.live !== false) await part([1, 2, 3], 'live', 'the live probe session', async () => {
    const t0 = Date.now();
    const s = await (deps.probeSession ?? runProbeSession)({
      upstream: setup.upstream ?? DEFAULT_UPSTREAM,
      credentials: setup.credentials,
      model: cheapestModel(setup.models),
      models: setup.models,
      waitMs: deps.waitMs ?? 20_000,
      timeoutMs: 240_000,
      ...(setup.install !== undefined ? { install: setup.install } : {}),
      ...(setup.claudeExecutable !== undefined ? { claudeExecutable: setup.claudeExecutable } : {}),
    });
    return judgeProbeSession(s, 'live', Date.now() - t0);
  });
  if (deps.live !== false) await part([8], 'live', 'the PM monitor check', async () => [await checkPmMonitor(deps.pmProbe)]);
  recordSelfCheck(setup.dir, versions, results, ...(deps.recordOps !== undefined ? [deps.recordOps] : []));
  const gate = selfCheckGate(setup.dir, versions, seatGatePolicy(setup));
  return { versions, key: versionKey(versions), results, gate };
}

/** What a WI-18 notice names: the version key and the failing items. */
export interface SelfCheckFailure {
  readonly key: string;
  readonly versions: ToolchainVersions | null;
  readonly failing: readonly string[];
}

export function failureOf(run: SelfCheckRun): SelfCheckFailure {
  return { key: run.key, versions: run.versions, failing: [...run.gate.failed.map((f) => `item ${f.item}: ${f.why}`), ...run.gate.missing.map((i) => `item ${i}: no result`)] };
}

/** The failure of a run that could not complete at all (no versions, or the record not written). */
export function runLevelFailure(error: unknown, claudeExecutable?: string): SelfCheckFailure {
  let versions: ToolchainVersions | null = null;
  try {
    versions = toolchainVersions(claudeExecutable !== undefined ? { claudeExecutable } : {});
  } catch {
    versions = null;
  }
  return { key: versions !== null ? versionKey(versions) : 'unknown-versions', versions, failing: [`the self-check run could not complete: ${(error as Error).message ?? String(error)}`] };
}

// ---------------------------------------------------------------- the seat installation from the CLI config

interface SeatsConfig {
  readonly selfCheckDir?: string;
  readonly credentials?: SeatCredentialsSpec;
  readonly modelConfig?: string;
  readonly install?: Pick<ExecInstallConfig, 'agentRuntime' | 'bwrap' | 'nsenter'>;
  readonly upstream?: string;
  readonly claudeExecutable?: string;
  readonly acceptFixtures?: boolean;
}

/** The seat installation `mp install` wrote (scheduler.json next to the engine start configuration), or why there is none. */
export function selfCheckSetupFromEngineConfig(engineConfig: string | null): SelfCheckSetup | { readonly unavailable: string } {
  if (engineConfig === null) return { unavailable: 'no engine start configuration (mp install)' };
  let seats: SeatsConfig | undefined;
  try {
    seats = (JSON.parse(readFileSync(join(dirname(engineConfig), 'scheduler.json'), 'utf8')) as { seats?: SeatsConfig }).seats;
  } catch (e) {
    return { unavailable: `cannot read the scheduler configuration next to ${engineConfig}: ${(e as Error).message}` };
  }
  if (seats === undefined || seats.credentials === undefined || seats.selfCheckDir === undefined) return { unavailable: 'no seat installation is configured (no login was found at install)' };
  let models: ModelConfig;
  try {
    models = seats.modelConfig !== undefined ? loadModelConfig(seats.modelConfig) : DEFAULT_MODEL_CONFIG;
  } catch (e) {
    return { unavailable: `model_config.json: ${(e as Error).message}` };
  }
  return {
    dir: seats.selfCheckDir,
    models,
    credentials: seats.credentials,
    ...(seats.install !== undefined ? { install: { ...(seats.install.agentRuntime !== undefined ? { agentRuntime: seats.install.agentRuntime } : {}), ...(seats.install.bwrap !== undefined ? { bwrap: seats.install.bwrap } : {}), ...(seats.install.nsenter !== undefined ? { nsenter: seats.install.nsenter } : {}) } } : {}),
    ...(seats.upstream !== undefined ? { upstream: seats.upstream } : {}),
    ...(seats.claudeExecutable !== undefined ? { claudeExecutable: seats.claudeExecutable } : {}),
    ...(seats.acceptFixtures === true ? { acceptFixtures: true } : {}),
  };
}

// ---------------------------------------------------------------- automatic re-runs (version changes)

/** The attempts record (exec/selfcheck.ts): the gate reads it too. */
export function attemptsPath(dir: string): string {
  return selfCheckAttemptsPath(dir);
}

export function recordAttempt(dir: string, key: string, outcome: SelfCheckAttemptOutcome, now = Date.now()): void {
  writeSelfCheckAttempt(dir, key, outcome, now);
}

/** Whether an automatic run may start for this version key now (none in the last interval). */
export function autoRunDue(dir: string, key: string, now = Date.now(), intervalMs = AUTO_SELFCHECK_INTERVAL_MS): boolean {
  const last = readSelfCheckAttempts(dir)[key];
  return last === undefined || now - last.at >= intervalMs;
}

const CLI_MAIN = fileURLToPath(new URL('../cli/main.ts', import.meta.url));

export interface BackgroundDeps {
  readonly versions?: ToolchainVersions;
  readonly now?: number;
  /** Starts the detached run (default: `mp selfcheck --auto` in its own process, output to a log). */
  readonly spawnRun?: (o: { readonly configPath: string; readonly logPath: string }) => void;
}

/**
 * The engine start path: when the gate finds items missing or failed for the versions in use,
 * start one detached self-check (at most once per version key per hour). Never blocks, never
 * throws: returns what it did.
 */
export function maybeStartBackgroundSelfCheck(o: { readonly configPath: string; readonly engineConfig: string | null; readonly stateDir: string }, deps: BackgroundDeps = {}): { readonly started: boolean; readonly why: string; readonly key: string | null } {
  try {
    const setup = selfCheckSetupFromEngineConfig(o.engineConfig);
    if ('unavailable' in setup) return { started: false, why: setup.unavailable, key: null };
    if (setup.acceptFixtures === true) return { started: false, why: 'fixture evidence is accepted (a test installation): no automatic self-check', key: null };
    const versions = deps.versions ?? toolchainVersions(setup.claudeExecutable !== undefined ? { claudeExecutable: setup.claudeExecutable } : {});
    const key = versionKey(versions);
    // exactly the scheduler's and the seat hosts' policy, from the same configuration
    const gate = selfCheckGate(setup.dir, versions, seatGatePolicy(setup));
    if (gate.seatsAllowed) return { started: false, why: 'the self-check passed for these versions', key };
    const now = deps.now ?? Date.now();
    if (!autoRunDue(setup.dir, key, now)) return { started: false, why: 'a self-check for these versions ran within the hour', key };
    recordAttempt(setup.dir, key, 'started', now);
    const logPath = join(o.stateDir, 'selfcheck-auto.log');
    (deps.spawnRun ?? spawnDetached)({ configPath: o.configPath, logPath });
    return { started: true, why: gate.reason ?? 'the gate needs a run', key };
  } catch (e) {
    return { started: false, why: `the background self-check could not start: ${(e as Error).message}`, key: null };
  }
}

function spawnDetached(o: { readonly configPath: string; readonly logPath: string }): void {
  const fd = openSync(o.logPath, 'a', 0o600);
  try {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI_MAIN, 'selfcheck', '--auto', '--json', '--config', o.configPath], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, MP_CONFIG: o.configPath },
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
}
