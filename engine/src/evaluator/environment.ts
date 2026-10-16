// The environment identity (design 4.1 §6.5), instead of v51's environment
// copies: every run records the identity of the machine it ran on, and a run
// whose identity differs from the current one is "needs rerun" (its evidence is
// not applicable, labels resting on it drop to not fully proven; nothing in the
// history changes).
//
// - The identity binds the run method (RUN_METHOD) as well as the machine's parts:
//   operating system and version, architecture, and the
//   output of each version command the project declares in
//   `.mission-pipeline/config.json` under ENVIRONMENT_CONFIG_KEY (for example
//   `node --version`, `python3 --version`, the test runner's version). The
//   identity is the sha256 of the run method and parts' canonical JSON; the parts are kept for
//   reading (env.snapshot `parts`): each output shortened, with the sha256 of
//   the whole output (`digests`), so the identity covers all of it.
// - `mp` observes the current identity at most once per process
//   (`currentEnvironment`), before any decision that reads labels; the labels'
//   gate refuses a decision in a process that has not observed it, or whose
//   observation is no longer the recorded one. A change is recorded as an
//   `env.snapshot` event on line ENV_LINE, so the labels of every run under
//   another identity drop through the ordinary propagation (labels.ts).
// - What the declared commands do not capture is not detected; declaring it is
//   the project's choice. Nothing is copied or frozen, and a change of model or
//   harness never changes the identity (§2.1).
//
// The version commands are the only processes this module runs, with the
// platform's shell, in the project folder, inside the `mp` command that needs
// them (§2.5).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, sha256 } from '../common/hash.ts';
import type { EnvLineId, EnvSnapshotId } from '../common/ids.ts';
import type { BaseRecord, EnvironmentParts } from '../common/records.ts';
import { appendFact, checkShape, intactRecord, LedgerError, LOG_COLUMNS, MEMORY_DIRNAME, type Db, type LogRow, type Memory, type WriteTx } from '../memory/index.ts';

export type { EnvironmentParts } from '../common/records.ts';

/** The environment line every 4.1 run is bound to (evidence `envLine`). */
export const ENV_LINE = 'env' as EnvLineId;

/** Run method v2: the checkout is its own repository at the candidate. Part of
 * the identity so old proof needs renewal; records and seat judgments stay intact. */
export const RUN_METHOD = 'v2';

/** The key of `.mission-pipeline/config.json` this module reads: `{ "versionCommands": ["node --version", ...] }`. */
export const ENVIRONMENT_CONFIG_KEY = 'environment';

export interface EnvironmentConfig {
  /** The version commands whose output is part of the identity, in the order declared (at most 64). */
  readonly versionCommands: readonly string[];
}

export interface EnvironmentIdentity {
  /** sha256 of the run method and parts' canonical JSON: the env.snapshot id evidence binds to. */
  readonly identity: EnvSnapshotId;
  readonly parts: EnvironmentParts;
}

/** Each version command may run this long; a command that does not finish counts with its error as output. */
const VERSION_COMMAND_TIMEOUT_MS = 15_000;
const OUTPUT_MAX = 500;
const COMMANDS_MAX = 64;

/** The ENVIRONMENT_CONFIG_KEY entry of a parsed config.json (another package owns the rest of the file). Malformed: BAD_REQUEST. */
export function environmentConfig(config: unknown): EnvironmentConfig {
  if (config === null || config === undefined) return { versionCommands: [] };
  if (typeof config !== 'object' || Array.isArray(config)) throw new LedgerError('BAD_REQUEST', 'config.json is not a JSON object');
  const entry = (config as Record<string, unknown>)[ENVIRONMENT_CONFIG_KEY];
  if (entry === undefined || entry === null) return { versionCommands: [] };
  const cmds = typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>).versionCommands : undefined;
  if (cmds === undefined) return { versionCommands: [] };
  if (!Array.isArray(cmds) || cmds.length > COMMANDS_MAX || !cmds.every((c) => typeof c === 'string' && c.trim() !== '' && c.length <= 1000)) {
    throw new LedgerError('BAD_REQUEST', `config.json "${ENVIRONMENT_CONFIG_KEY}.versionCommands" is a list of at most ${COMMANDS_MAX} commands (each 1 to 1000 characters)`);
  }
  return { versionCommands: [...new Set(cmds as string[])] };
}

/** The project's declaration, from `<project>/.mission-pipeline/config.json` (no file: no version commands). */
export function readEnvironmentConfig(projectDir: string): EnvironmentConfig {
  const file = join(projectDir, MEMORY_DIRNAME, 'config.json');
  if (!existsSync(file)) return { versionCommands: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new LedgerError('BAD_REQUEST', `${file} is not valid JSON: ${(e as Error).message}`);
  }
  return environmentConfig(parsed);
}

/** The most a version command may print: its whole output is part of the identity, so a longer one fails explicitly. */
export const VERSION_OUTPUT_MAX = 1024 * 1024;

function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n').trim();
}

/** What the parts keep of an output for reading (the identity covers all of it, through its digest). */
function clip(s: string): string {
  return s.length <= OUTPUT_MAX ? s : s.slice(0, OUTPUT_MAX);
}

/**
 * Run one version command with the platform's shell in the project folder:
 * its whole output (or what went wrong). An output longer than
 * VERSION_OUTPUT_MAX is refused (TOO_LARGE), never cut.
 */
export function runVersionCommand(projectDir: string, command: string): string {
  const r = spawnSync(command, {
    shell: true,
    cwd: projectDir,
    encoding: 'utf8',
    timeout: VERSION_COMMAND_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: VERSION_OUTPUT_MAX,
  });
  if (r.error !== undefined) {
    if ((r.error as NodeJS.ErrnoException).code === 'ENOBUFS') {
      throw new LedgerError('TOO_LARGE', `version command ${JSON.stringify(command)} printed more than ${VERSION_OUTPUT_MAX} bytes: the environment identity covers a version command's whole output; declare a command with a shorter one`);
    }
    return `error: ${r.error.message}`;
  }
  const out = `${r.stdout ?? ''}${r.stderr ? `${r.stdout ? '\n' : ''}${r.stderr}` : ''}`;
  return r.status !== 0 ? `exit ${r.status ?? r.signal}: ${out}` : out;
}

/**
 * Observe this machine's parts (§6.5): runs the declared version commands
 * (`run` replaces running them, for tests). Each output is kept shortened for
 * reading, and its sha256 over the whole output goes into the identity, so a
 * change anywhere in an output changes the identity.
 */
export function observeEnvironment(projectDir: string, config: EnvironmentConfig, run: (command: string) => string = (c) => runVersionCommand(projectDir, c)): EnvironmentParts {
  const versions: Record<string, string> = {};
  const digests: Record<string, string> = {};
  for (const c of config.versionCommands) {
    const out = run(c);
    if (Buffer.byteLength(out, 'utf8') > VERSION_OUTPUT_MAX) {
      throw new LedgerError('TOO_LARGE', `version command ${JSON.stringify(c)} printed more than ${VERSION_OUTPUT_MAX} bytes: the environment identity covers a version command's whole output; declare a command with a shorter one`);
    }
    const full = normalize(out);
    versions[c] = clip(full);
    digests[c] = sha256(full);
  }
  return { os: platform(), osVersion: release(), arch: arch(), versions, digests };
}

export function environmentIdentity(parts: EnvironmentParts): EnvSnapshotId {
  return sha256(canonicalJson({ runMethod: RUN_METHOD, parts })) as string as EnvSnapshotId;
}

/**
 * The identity recorded as current (the latest env.snapshot on ENV_LINE), read
 * from the log through the memory's integrity check: every environment event
 * from the newest one down to it is checked, so a damaged one is refused
 * (CHAIN_BROKEN, and the break is recorded), never read as another identity.
 * Null before the first.
 */
export function recordedEnvironment(db: Db): (EnvironmentIdentity & { readonly revision: number }) | null {
  const page = db.stmt(`SELECT ${LOG_COLUMNS} FROM log WHERE kind = 'env.snapshot' AND rev < ? ORDER BY rev DESC LIMIT 64`);
  for (let before = Number.MAX_SAFE_INTEGER; ; ) {
    const rows = page.all(before) as unknown as LogRow[];
    if (rows.length === 0) return null;
    for (const r of rows) {
      const rec = intactRecord<Extract<BaseRecord, { kind: 'env.snapshot' }>>(db, r);
      if (rec.line === ENV_LINE) return { identity: rec.snapshot, parts: rec.parts ?? { os: '', osVersion: '', arch: '', versions: {} }, revision: Number(r.rev) };
      before = Number(r.rev);
    }
  }
}

/** What this process observed, per project folder ("at most once per mp process"). */
const observed = new Map<string, EnvironmentIdentity>();

/** This process's observation for a project, or null when it made none (the labels' gate reads it). */
export function observedEnvironment(projectDir: string): EnvironmentIdentity | null {
  return observed.get(projectDir) ?? null;
}

/** Forget this process's observations (tests; a long-lived host that wants to observe again). */
export function forgetObservedEnvironment(projectDir?: string): void {
  if (projectDir === undefined) observed.clear();
  else observed.delete(projectDir);
}

export interface CurrentEnvironment extends EnvironmentIdentity {
  /** The identity recorded before this call (null: none yet). */
  readonly previous: EnvSnapshotId | null;
  /** This call recorded a change (an env.snapshot event). */
  readonly changed: boolean;
}

/**
 * The current environment identity (§6.5): observed at most once per process
 * (the first call runs the version commands; `observe` replaces that, for
 * tests), compared with the recorded one, and recorded as an `env.snapshot`
 * event when it differs. Call it before any decision that reads labels (a
 * stable-mode dispatch, an acceptance, a closing, a delivery) and after a move;
 * the labels' gate refuses a decision otherwise. A change drops the labels of
 * every run under another identity (they need a rerun: renew.ts).
 */
export function currentEnvironment(memory: Memory, opts: { readonly observe?: () => EnvironmentParts; readonly config?: EnvironmentConfig } = {}): CurrentEnvironment {
  const key = memory.projectDir;
  let mine = observed.get(key);
  if (mine === undefined) {
    const parts = opts.observe !== undefined ? opts.observe() : observeEnvironment(key, opts.config ?? readEnvironmentConfig(key));
    mine = { identity: environmentIdentity(parts), parts };
    observed.set(key, mine);
  }
  const recorded = memory.read((db) => recordedEnvironment(db));
  if (recorded !== null && recorded.identity === mine.identity) return { ...mine, previous: recorded.identity, changed: false };
  const id = mine;
  const out = memory.write({ op: `env:${id.identity}:${recorded?.revision ?? 0}`, payload: { identity: id.identity, previous: recorded?.identity ?? null } }, (tx) => recordEnvironment(tx, id));
  return { ...mine, previous: recorded?.identity ?? null, changed: out.recorded };
}

/** Inside a write: record `id` as the current identity unless it already is. */
export function recordEnvironment(tx: WriteTx, id: EnvironmentIdentity): { recorded: boolean } {
  if (recordedEnvironment(tx)?.identity === id.identity) return { recorded: false };
  const rec: BaseRecord = { kind: 'env.snapshot', line: ENV_LINE, snapshot: id.identity, parts: id.parts };
  checkShape(rec, new Set(['env.snapshot']), 'currentEnvironment');
  appendFact(tx, rec);
  return { recorded: true };
}
