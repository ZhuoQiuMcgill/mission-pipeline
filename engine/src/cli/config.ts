// The CLI's configuration (design 9.2, 9.6): where the ledger, the control plane,
// the sockets and the engine's start configuration are. `mp install` writes it.
//
// Found in this order: --config <file>; $MP_CONFIG; $XDG_CONFIG_HOME (or
// ~/.config)/mission-pipeline/engine4.json. The ledger, its inbox and the CLI's
// state directory are on a Linux filesystem; the control plane on a memory
// filesystem (6.1). The hooks act only in a session whose working directory is
// inside a registered project (3.9: the hooks act only in the PM session, by a session marker).

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { ledgerPaths, type LedgerPaths } from '../ledger/service.ts';
import type { StopPaths } from '../ledger/stops.ts';
import { CliError, EXIT } from './errors.ts';

export const CLI_CONFIG_FORMAT = 'mp4.cli-config.v1';

export interface ProjectConfig {
  /** The repository's main checkout (the root the user opens the PM in). */
  readonly root: string;
  /** The branch deliveries land on (default main). */
  readonly targetBranch: string;
  /** The main checkout registered at install (6.6 v41); null: none (a bare repository). */
  readonly mainCheckout: string | null;
}

export interface CliConfig {
  readonly format: typeof CLI_CONFIG_FORMAT;
  /** The engine's source root (engine/), for the plugin's hook wrapper. */
  readonly engineRoot: string | null;
  readonly ledgerRoot: string;
  readonly controlPlane: string;
  readonly ledgerSocket: string;
  readonly schedulerSocket: string | null;
  readonly evaluatorSocket: string | null;
  /** The evaluator's checkpoint file; its summary is read when the evaluator is down (6.1). */
  readonly evaluatorCheckpoint: string | null;
  /** The CLI's own state (operation journal, notice delivery marks, user words waiting for the ledger). Linux filesystem. */
  readonly stateDir: string;
  /** The engine start configuration (src/scheduler/engine.ts EngineConfig) for ensure-running. */
  readonly engineConfig: string | null;
  /** The backup stop inbox; undefined: as the install recorded it (inboxes.json). */
  readonly backupInbox?: string | null;
  readonly modelConfig: string | null;
  /** Where the startup self-check evidence is kept (9.3). */
  readonly selfCheckDir: string | null;
  readonly projects: readonly ProjectConfig[];
  /**
   * Capabilities units are reliably tagged with (6.4): a capability stop is used only for
   * these; any other capability word widens to the generic scope. Default ['network'].
   */
  readonly taggedCapabilities?: readonly string[];
  /** Milliseconds. */
  readonly timeouts?: { readonly ledgerMs?: number; readonly schedulerMs?: number; readonly hookLedgerMs?: number; readonly evaluatorMs?: number };
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['XDG_CONFIG_HOME'] && isAbsolute(env['XDG_CONFIG_HOME']) ? env['XDG_CONFIG_HOME'] : join(env['HOME'] ?? homedir(), '.config');
  return join(base, 'mission-pipeline', 'engine4.json');
}

/** The configuration file to use: the flag, then $MP_CONFIG, then the default; null when none exists. */
export function findConfigPath(flag: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (flag !== null) return resolve(flag);
  const fromEnv = env['MP_CONFIG'];
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv);
  const d = defaultConfigPath(env);
  return existsSync(d) ? d : null;
}

function str(o: Record<string, unknown>, k: string, required: true): string;
function str(o: Record<string, unknown>, k: string, required: false): string | null;
function str(o: Record<string, unknown>, k: string, required: boolean): string | null {
  const v = o[k];
  if (v === undefined || v === null) {
    if (required) throw new CliError('BAD_CONFIG', `the configuration lacks ${k}`, { exitCode: EXIT.NO_CONFIG });
    return null;
  }
  if (typeof v !== 'string' || v === '') throw new CliError('BAD_CONFIG', `configuration item ${k} must be a non-empty string`, { exitCode: EXIT.NO_CONFIG });
  return v;
}

export function parseCliConfig(x: unknown): CliConfig {
  if (!x || typeof x !== 'object') throw new CliError('BAD_CONFIG', 'the configuration is not a JSON object', { exitCode: EXIT.NO_CONFIG });
  const o = x as Record<string, unknown>;
  if (o['format'] !== CLI_CONFIG_FORMAT) throw new CliError('BAD_CONFIG', `the configuration format is not ${CLI_CONFIG_FORMAT}`, { exitCode: EXIT.NO_CONFIG });
  const projects: ProjectConfig[] = [];
  for (const p of Array.isArray(o['projects']) ? (o['projects'] as unknown[]) : []) {
    const q = (p ?? {}) as Record<string, unknown>;
    projects.push({ root: str(q, 'root', true), targetBranch: str(q, 'targetBranch', false) ?? 'main', mainCheckout: str(q, 'mainCheckout', false) });
  }
  const t = (o['timeouts'] ?? {}) as Record<string, unknown>;
  const num = (k: string): number | undefined => (typeof t[k] === 'number' && Number.isFinite(t[k]) && (t[k] as number) > 0 ? (t[k] as number) : undefined);
  const timeouts: NonNullable<CliConfig['timeouts']> = {
    ...(num('ledgerMs') !== undefined ? { ledgerMs: num('ledgerMs')! } : {}),
    ...(num('schedulerMs') !== undefined ? { schedulerMs: num('schedulerMs')! } : {}),
    ...(num('hookLedgerMs') !== undefined ? { hookLedgerMs: num('hookLedgerMs')! } : {}),
    ...(num('evaluatorMs') !== undefined ? { evaluatorMs: num('evaluatorMs')! } : {}),
  };
  const backup = o['backupInbox'];
  const tagged = o['taggedCapabilities'];
  if (tagged !== undefined && (!Array.isArray(tagged) || !tagged.every((x) => typeof x === 'string'))) throw new CliError('BAD_CONFIG', 'taggedCapabilities must be a list of strings', { exitCode: EXIT.NO_CONFIG });
  return {
    format: CLI_CONFIG_FORMAT,
    engineRoot: str(o, 'engineRoot', false),
    ledgerRoot: str(o, 'ledgerRoot', true),
    controlPlane: str(o, 'controlPlane', true),
    ledgerSocket: str(o, 'ledgerSocket', true),
    schedulerSocket: str(o, 'schedulerSocket', false),
    evaluatorSocket: str(o, 'evaluatorSocket', false),
    evaluatorCheckpoint: str(o, 'evaluatorCheckpoint', false),
    stateDir: str(o, 'stateDir', true),
    engineConfig: str(o, 'engineConfig', false),
    ...(backup === undefined ? {} : { backupInbox: backup === null ? null : str(o, 'backupInbox', true) }),
    modelConfig: str(o, 'modelConfig', false),
    selfCheckDir: str(o, 'selfCheckDir', false),
    projects,
    ...(tagged !== undefined ? { taggedCapabilities: tagged as string[] } : {}),
    timeouts,
  };
}

export function loadCliConfig(path: string): CliConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new CliError('NO_CONFIG', `cannot read the configuration ${path}: ${(e as Error).message}. Run mp install first.`, { exitCode: EXIT.NO_CONFIG });
  }
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    throw new CliError('BAD_CONFIG', `the configuration ${path} is not valid JSON`, { exitCode: EXIT.NO_CONFIG });
  }
  return parseCliConfig(x);
}

export function ledgerPathsOf(c: CliConfig): LedgerPaths {
  return ledgerPaths(c.ledgerRoot, c.controlPlane, c.backupInbox !== undefined ? { backupInbox: c.backupInbox } : {});
}

export function stopPathsOf(c: CliConfig): StopPaths {
  const lp = ledgerPathsOf(c);
  return { inbox: lp.inbox, controlPlane: c.controlPlane, ...(c.backupInbox !== undefined ? { backupInbox: c.backupInbox } : {}) };
}

/** The registered project containing `dir`, the innermost one; null when none (not a PM session). */
export function projectOf(c: CliConfig, dir: string): ProjectConfig | null {
  const d = resolve(dir);
  let best: ProjectConfig | null = null;
  for (const p of c.projects) {
    const r = resolve(p.root);
    if (d === r || d.startsWith(r.endsWith(sep) ? r : r + sep)) {
      if (best === null || r.length > resolve(best.root).length) best = p;
    }
  }
  return best;
}

export const DEFAULT_TIMEOUTS = { ledgerMs: 5_000, schedulerMs: 10_000, hookLedgerMs: 1_500, evaluatorMs: 2_000 } as const;

export function timeoutOf(c: CliConfig, k: keyof typeof DEFAULT_TIMEOUTS): number {
  return c.timeouts?.[k] ?? DEFAULT_TIMEOUTS[k];
}
