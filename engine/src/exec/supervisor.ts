// The unit supervisor (design 7.1 "单元监管者", 6.3 "证明对账入口" supervisor side, v35 cleanup).
//
// Each execution unit runs as an independent transient systemd user service
// (`systemd-run --user --collect -p Delegate=yes`) whose main process is this
// supervisor. It is not the scheduler's child, so a scheduler crash or a new
// generation does not affect it. Inside the service's cgroup it:
//   0. makes the state directory chains it writes into durable (proofs/, cleanup/, ...: each
//      directory and its parent synced) before anything runs;
//   1. moves itself into its own leaf, beside the unit subtree (a unit overrun cannot
//      reach it), and builds the unit subtree: unit (memory.max = the card's peak,
//      memory.oom.group=1) with its control layer; binds the cleanup resources to the
//      identity (dev, ino) they have now and keeps that list locally;
//   2. starts the host into the control layer (oom_score_adj=1000, v34) and waits for it
//      as its parent, getting the real exit code or signal;
//   3. waits until the unit subtree holds no process, then reads the final counters;
//   4. writes the termination proof (immutable facts only) atomically to the state directory;
//   5. tears down what the unit leaves: its cgroup subtree (kept while the proof exists
//      nowhere else), mounts, images, network grants, temporary paths;
//   6. submits the proof through a ProofSink with bounded back-off (proof.ts);
//   7. records the cleanup state: done, or pending with what is left (cleanup.ts), which
//      the scheduler finishes with completeCleanup once the supervisor is gone;
//   8. settles the dead host's open spend reservations at the reserved amount (6.5).
// A stop, or the 10-minute limit of step 6, changes nothing in this order. The supervisor
// never submits a failure; "no proof" is decided only by the scheduler's reconciliation
// entry (6.3), which uses the identity file written here. Every exception it reports names
// its PM work instruction (3.11, alerts.ts) and goes to the local alert file and the ledger.

import { execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../common/fsx.ts';
import type { LaunchId } from '../common/ids.ts';
import type { TerminationProofRecord } from '../common/records.ts';
import { stagedStopsInForce, stopCovers, type ScopeTag } from '../ledger/stops.ts';
import {
  Cgroup,
  UNIT_OOM_SCORE_ADJ,
  buildUnitTree,
  spawnInCgroup,
  validateLimits,
  type LayerLimits,
  type StdioTarget,
  type UnitTree,
} from './cgroup.ts';
import { FileAlertSink, execAlert, markAlertDelivered, type AlertSink, type ExecAlert, type ExecAlertKind } from './alerts.ts';
import { cleanupDir, cleanupPass, formatCleanupResource, recordIdentities, removeCleanupFile, writeCleanupFile, type CleanupPolicy, type CleanupRefusal } from './cleanup.ts';
import { REAL_DURABLE_OPS, ensureDirChainDurable, opsWithFault, type DurableOps, type DurableStep, type FaultPlan } from './durable.ts';
import { coveringSpoolStops, recordEndedByStop } from './stopcause.ts';
import {
  DEFAULT_RETRY_POLICY,
  PROOF_FILE_FORMAT,
  markProofRejected,
  parseLaunchId,
  proofsDir,
  removeProofFile,
  submitProofWithRetry,
  systemClock,
  writeProofFile,
  type ProofDiagnostics,
  type ProofSink,
  type RetryPolicy,
  type SubmissionOutcome,
} from './proof.ts';

const execFileAsync = promisify(execFile);

export const SUPERVISOR_MAIN = fileURLToPath(new URL('./supervisor-main.ts', import.meta.url));
/** After a stop, the time a host gets to end itself before the unit is killed (program runs; seat units use 30 s). */
export const DEFAULT_STOP_GRACE_MS = 10_000;
export const SUPERVISOR_CONFIG_FORMAT = 'mp4.unit-supervisor-config.v1';

// ---------------------------------------------------------------- configuration

export class SupervisorConfigError extends Error {
  override readonly name = 'SupervisorConfigError';
}

/** The host process the supervisor starts into the unit's control layer. */
export interface HostCommand {
  readonly argv: readonly string[];
  /** The complete environment (a transient service does not inherit the caller's). */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Appended to; default: inherited from the supervisor (the journal). */
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
}

/** A module exporting `createProofSink(options)`, loaded inside the supervisor process. */
export interface SinkModuleRef {
  readonly module: string;
  readonly exportName?: string;
  readonly options?: unknown;
}

export interface SupervisorConfig {
  readonly format: typeof SUPERVISOR_CONFIG_FORMAT;
  readonly launch: LaunchId;
  /** Program state directory on a Linux filesystem (6.1). Proof files go to `<stateDir>/proofs`. */
  readonly stateDir: string;
  /** The transient service's unit name, recorded in the identity file. */
  readonly unitName: string | null;
  readonly host: HostCommand;
  /** The unit's limits: memory.max is the card's declared peak (6.5). */
  readonly unit: LayerLimits;
  readonly sink: SinkModuleRef;
  readonly retry?: Partial<RetryPolicy>;
  /** Paths whose existence means a stop covers this unit. */
  readonly stopFiles?: readonly string[];
  /**
   * The control plane's stop spool (6.4 fast signal): any spooled stop whose scope covers
   * this unit's tag (its mission and capabilities) stops the unit.
   */
  readonly stopScope?: { readonly controlPlane: string; readonly tag: ScopeTag };
  /** After a stop: time the host gets to end itself before the unit is killed. */
  readonly stopGraceMs?: number;
  /** After the host exits: time left-over processes get to end before cgroup.kill. */
  readonly orphanGraceMs?: number;
  /** Alert interval while killed processes still do not leave the unit (6.1: 60 s). */
  readonly unkillableAlertMs?: number;
  /**
   * What the unit leaves behind (v35 7.1, 6.3, 6.4), released after the proof file is written:
   * FUSE mounts of large-disk images, the image files, network grant files a fetch proxy
   * honors (deleted to revoke them), temporary paths. Whatever cannot be released is
   * recorded as pending cleanup state (cleanup.ts), finished later by the scheduler.
   */
  readonly cleanup?: {
    readonly fuseMounts?: readonly string[];
    readonly images?: readonly string[];
    readonly networkGrants?: readonly string[];
    readonly paths?: readonly string[];
    /**
     * Scratch directories the unit will use (e.g. the export directory in the content store):
     * the supervisor creates the missing ones before the unit runs, so each is bound to its
     * identity from the start, and deletes them at the end (code review r2 finding 1).
     */
    readonly scratchDirs?: readonly string[];
  };
  /**
   * Tests only (design §14 item 9 fault injection): the supervisor ends itself with SIGKILL
   * right before this step of writing its proof file. Production configurations never set it.
   */
  readonly testFaults?: { readonly proofWrite?: DurableStep };
}

const DURABLE_STEPS: readonly DurableStep[] = ['temp-write', 'temp-fsync', 'rename', 'dir-sync'];

function obj(x: unknown, what: string): Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new SupervisorConfigError(`${what} is not an object`);
  return x as Record<string, unknown>;
}

function strings(x: unknown, what: string): string[] {
  if (!Array.isArray(x) || x.some((s) => typeof s !== 'string')) throw new SupervisorConfigError(`${what} is not a string list`);
  return x as string[];
}

function absolutes(xs: string[], what: string): string[] {
  for (const x of xs) if (!isAbsolute(x)) throw new SupervisorConfigError(`${what}: ${x} is not absolute`);
  return xs;
}

function optNumber(x: unknown, what: string): number | undefined {
  if (x === undefined) return undefined;
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) throw new SupervisorConfigError(`${what} is not a count`);
  return x;
}

export function parseSupervisorConfig(x: unknown): SupervisorConfig {
  const c = obj(x, 'config');
  if (c['format'] !== SUPERVISOR_CONFIG_FORMAT) throw new SupervisorConfigError(`unknown config format ${JSON.stringify(c['format'])}`);
  let launch: LaunchId;
  try {
    launch = parseLaunchId(c['launch']);
  } catch (e) {
    throw new SupervisorConfigError((e as Error).message);
  }
  const stateDir = c['stateDir'];
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new SupervisorConfigError('stateDir must be an absolute path');
  const h = obj(c['host'], 'host');
  const argv = strings(h['argv'], 'host.argv');
  if (argv.length === 0) throw new SupervisorConfigError('host.argv is empty');
  const envObj = obj(h['env'], 'host.env');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envObj)) {
    if (typeof v !== 'string') throw new SupervisorConfigError(`host.env.${k} is not a string`);
    env[k] = v;
  }
  const cwd = h['cwd'];
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new SupervisorConfigError('host.cwd must be an absolute path');
  const optPath = (v: unknown, what: string): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !isAbsolute(v)) throw new SupervisorConfigError(`${what} must be an absolute path`);
    return v;
  };
  const stdoutPath = optPath(h['stdoutPath'], 'host.stdoutPath');
  const stderrPath = optPath(h['stderrPath'], 'host.stderrPath');
  const u = obj(c['unit'], 'unit');
  const unit: LayerLimits = {
    memoryMax: u['memoryMax'] as number,
    ...(u['pidsMax'] !== undefined ? { pidsMax: u['pidsMax'] as number } : {}),
    ...(u['cpu'] !== undefined ? { cpu: u['cpu'] as LayerLimits['cpu'] & object } : {}),
  };
  try {
    validateLimits(unit);
  } catch (e) {
    throw new SupervisorConfigError(`unit limits: ${(e as Error).message}`);
  }
  const s = obj(c['sink'], 'sink');
  if (typeof s['module'] !== 'string' || !isAbsolute(s['module'])) throw new SupervisorConfigError('sink.module must be an absolute path');
  if (s['exportName'] !== undefined && typeof s['exportName'] !== 'string') throw new SupervisorConfigError('sink.exportName');
  const retryRaw = c['retry'] === undefined ? {} : obj(c['retry'], 'retry');
  const retry: { -readonly [K in keyof RetryPolicy]?: RetryPolicy[K] } = {};
  for (const k of ['initialDelayMs', 'maxDelayMs', 'totalMs', 'attemptTimeoutMs'] as const) {
    const v = optNumber(retryRaw[k], `retry.${k}`);
    if (v !== undefined) retry[k] = v;
  }
  const unitName = c['unitName'];
  if (unitName !== null && typeof unitName !== 'string') throw new SupervisorConfigError('unitName');
  const cleanupRaw = c['cleanup'] === undefined ? {} : obj(c['cleanup'], 'cleanup');
  let testFaults: SupervisorConfig['testFaults'];
  if (c['testFaults'] !== undefined) {
    const f = obj(c['testFaults'], 'testFaults');
    const step = f['proofWrite'];
    if (step !== undefined && !DURABLE_STEPS.includes(step as DurableStep)) throw new SupervisorConfigError('testFaults.proofWrite');
    testFaults = step === undefined ? {} : { proofWrite: step as DurableStep };
  }
  const stopGraceMs = optNumber(c['stopGraceMs'], 'stopGraceMs');
  const orphanGraceMs = optNumber(c['orphanGraceMs'], 'orphanGraceMs');
  const unkillableAlertMs = optNumber(c['unkillableAlertMs'], 'unkillableAlertMs');
  return {
    format: SUPERVISOR_CONFIG_FORMAT,
    launch,
    stateDir,
    unitName,
    host: {
      argv,
      env,
      cwd,
      ...(stdoutPath !== undefined ? { stdoutPath } : {}),
      ...(stderrPath !== undefined ? { stderrPath } : {}),
    },
    unit,
    sink: {
      module: s['module'],
      ...(s['exportName'] !== undefined ? { exportName: s['exportName'] as string } : {}),
      ...(s['options'] !== undefined ? { options: s['options'] } : {}),
    },
    retry,
    stopFiles: c['stopFiles'] === undefined ? [] : strings(c['stopFiles'], 'stopFiles'),
    ...(stopGraceMs !== undefined ? { stopGraceMs } : {}),
    ...(orphanGraceMs !== undefined ? { orphanGraceMs } : {}),
    ...(unkillableAlertMs !== undefined ? { unkillableAlertMs } : {}),
    cleanup: {
      fuseMounts: cleanupRaw['fuseMounts'] === undefined ? [] : strings(cleanupRaw['fuseMounts'], 'cleanup.fuseMounts'),
      images: cleanupRaw['images'] === undefined ? [] : strings(cleanupRaw['images'], 'cleanup.images'),
      networkGrants: cleanupRaw['networkGrants'] === undefined ? [] : strings(cleanupRaw['networkGrants'], 'cleanup.networkGrants'),
      paths: cleanupRaw['paths'] === undefined ? [] : strings(cleanupRaw['paths'], 'cleanup.paths'),
      scratchDirs: cleanupRaw['scratchDirs'] === undefined ? [] : absolutes(strings(cleanupRaw['scratchDirs'], 'cleanup.scratchDirs'), 'cleanup.scratchDirs'),
    },
    ...(c['stopScope'] !== undefined ? { stopScope: parseStopScope(c['stopScope']) } : {}),
    ...(testFaults !== undefined ? { testFaults } : {}),
  };
}

function parseStopScope(x: unknown): { controlPlane: string; tag: ScopeTag } {
  const o = obj(x, 'stopScope');
  const cp = o['controlPlane'];
  if (typeof cp !== 'string' || !isAbsolute(cp)) throw new SupervisorConfigError('stopScope.controlPlane must be an absolute path');
  const t = obj(o['tag'], 'stopScope.tag');
  if (typeof t['mission'] !== 'string') throw new SupervisorConfigError('stopScope.tag.mission');
  return { controlPlane: cp, tag: { mission: t['mission'] as ScopeTag['mission'], capabilities: strings(t['capabilities'], 'stopScope.tag.capabilities') } };
}

export async function loadProofSink(ref: SinkModuleRef): Promise<ProofSink> {
  if (!isAbsolute(ref.module)) throw new TypeError(`sink module must be an absolute path: ${ref.module}`);
  const mod = (await import(pathToFileURL(ref.module).href)) as Record<string, unknown>;
  const factory = mod[ref.exportName ?? 'createProofSink'];
  if (typeof factory !== 'function') throw new TypeError(`${ref.module} does not export ${ref.exportName ?? 'createProofSink'}`);
  const sink = (await (factory as (options: unknown) => unknown)(ref.options)) as Partial<ProofSink> | null;
  if (sink === null || typeof sink !== 'object' || typeof sink.submit !== 'function') {
    throw new TypeError(`${ref.module} did not return a ProofSink`);
  }
  return sink as ProofSink;
}

// ---------------------------------------------------------------- process identity (6.3)

export interface ProcessIdentity {
  readonly pid: number;
  /** /proc/<pid>/stat field 22: start time in clock ticks since boot. */
  readonly startTime: number;
  readonly bootId: string;
}

export function bootId(): string {
  return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

function statFields(pid: number): string[] | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  // fields[0] is field 3 (state); field 22 (starttime) is fields[19]
  return stat.slice(close + 2).trim().split(' ');
}

export function processIdentity(pid: number): ProcessIdentity | null {
  const f = statFields(pid);
  const st = f?.[19];
  if (st === undefined) return null;
  return { pid, startTime: Number(st), bootId: bootId() };
}

/**
 * True while the very process of `id` still exists and can act: same boot, same pid, same
 * start time, not a zombie. 6.3 entry step 1 proceeds only once this is false.
 */
export function isProcessAlive(id: ProcessIdentity): boolean {
  if (id.bootId !== bootId()) return false;
  const f = statFields(id.pid);
  if (f === null) return false;
  if (f[0] === 'Z' || f[0] === 'X') return false;
  return Number(f[19]) === id.startTime;
}

export interface SupervisorIdentity extends ProcessIdentity {
  readonly format: 'mp4.unit-supervisor-identity.v1';
  readonly launch: LaunchId;
  readonly unitName: string | null;
  readonly invocationId: string | null;
  readonly startedAt: string;
}

export function supervisorIdentityPath(stateDir: string, launch: LaunchId): string {
  return join(stateDir, 'supervisors', `${launch}.json`);
}

export function readSupervisorIdentity(stateDir: string, launch: LaunchId): SupervisorIdentity | null {
  try {
    return JSON.parse(readFileSync(supervisorIdentityPath(stateDir, launch), 'utf8')) as SupervisorIdentity;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

// ---------------------------------------------------------------- stop

/** What made the stop watcher stop the unit (a signal is a stop only when a covering stop is spooled: see endedByStop). */
export type StopTrigger = { readonly via: 'signal'; readonly signal: string } | { readonly via: 'file'; readonly file: string } | { readonly via: 'spool' };

/** SIGTERM / SIGINT / SIGHUP, or any of the stop files appearing, means a stop covers the unit. */
class StopWatcher {
  private readonly ac = new AbortController();
  private readonly handlers: (() => void)[] = [];
  private readonly timer: NodeJS.Timeout | null;
  private firstCause: StopTrigger | null = null;
  private readonly onSignal = (sig?: NodeJS.Signals): void => this.trigger({ via: 'signal', signal: typeof sig === 'string' ? sig : 'SIGTERM' });

  constructor(files: readonly string[], scope: SupervisorConfig['stopScope'], pollMs = 200) {
    process.on('SIGTERM', this.onSignal);
    process.on('SIGINT', this.onSignal);
    process.on('SIGHUP', this.onSignal);
    const covered = (): boolean => {
      if (scope === undefined) return false;
      try {
        // the spool only (the durable inbox belongs to the ledger service), minus the stops the ledger released
        return stagedStopsInForce({ inbox: join(scope.controlPlane, '.no-inbox'), controlPlane: scope.controlPlane }).some((r) =>
          stopCovers(r.scope, scope.tag),
        );
      } catch {
        return false;
      }
    };
    const check = (): void => {
      const file = files.find((f) => existsSync(f));
      if (file !== undefined) this.trigger({ via: 'file', file });
      else if (covered()) this.trigger({ via: 'spool' });
    };
    if (files.length > 0 || scope !== undefined) {
      check();
      this.timer = setInterval(check, pollMs);
      this.timer.unref();
    } else {
      this.timer = null;
    }
  }

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  get stopped(): boolean {
    return this.ac.signal.aborted;
  }

  /** What triggered the stop, once it has. */
  get cause(): StopTrigger | null {
    return this.firstCause;
  }

  onStop(fn: () => void): void {
    if (this.stopped) fn();
    else this.handlers.push(fn);
  }

  private trigger(cause: StopTrigger): void {
    if (this.stopped) return;
    this.firstCause = cause;
    this.ac.abort();
    for (const h of this.handlers) {
      try {
        h();
      } catch {
        /* handlers are best effort */
      }
    }
  }

  dispose(): void {
    process.off('SIGTERM', this.onSignal);
    process.off('SIGINT', this.onSignal);
    process.off('SIGHUP', this.onSignal);
    if (this.timer !== null) clearInterval(this.timer);
  }
}

// ---------------------------------------------------------------- the supervisor

export interface SupervisorDeps {
  /** The local alert copy (default: <stateDir>/alerts.jsonl). Alerts also go to the ledger through the sink. */
  readonly alerts?: AlertSink;
}

function openAppend(path: string | undefined): StdioTarget {
  return path === undefined ? 'inherit' : openSync(path, 'a', 0o600);
}

/** The encoded resources (cleanup.ts) a unit leaves: its cgroup subtree and the configured extras. */
function unitResources(config: SupervisorConfig, unit: Cgroup): string[] {
  const c = config.cleanup ?? {};
  return [
    formatCleanupResource({ kind: 'cgroup', path: unit.path }),
    ...(c.fuseMounts ?? []).map((path) => formatCleanupResource({ kind: 'mount', path })),
    ...(c.images ?? []).map((path) => formatCleanupResource({ kind: 'image', path })),
    ...(c.networkGrants ?? []).map((path) => formatCleanupResource({ kind: 'grant', path })),
    ...(c.paths ?? []).map((path) => formatCleanupResource({ kind: 'path', path })),
    ...(c.scratchDirs ?? []).map((path) => formatCleanupResource({ kind: 'path', path })),
  ];
}

/** Sandbox holders the host registered (it writes `<stateDir>/units/<launch>/holders.json`). */
function holderResources(config: SupervisorConfig): string[] {
  try {
    const list = JSON.parse(readFileSync(unitHoldersPath(config.stateDir, config.launch), 'utf8')) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((x): x is string => typeof x === 'string' && x.startsWith('holder:'));
  } catch {
    return [];
  }
}

export function unitHoldersPath(stateDir: string, launch: LaunchId): string {
  return join(stateDir, 'units', launch, 'holders.json');
}

/** completeCleanup may act on exactly what the configuration names, nothing else. */
function cleanupPolicy(config: SupervisorConfig): CleanupPolicy {
  const c = config.cleanup ?? {};
  return { roots: [...(c.fuseMounts ?? []), ...(c.images ?? []), ...(c.networkGrants ?? []), ...(c.paths ?? []), ...(c.scratchDirs ?? [])] };
}

/** Creates the unit's missing scratch directories (private to the user) before it runs. */
function createScratchDirs(config: SupervisorConfig): void {
  for (const d of config.cleanup?.scratchDirs ?? []) {
    try {
      mkdirSync(d, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/**
 * The state directory's chains a unit writes into, made durable before the unit runs (finding
 * 12: a proof is "safe on disk" only when the directory entries leading to it are durable).
 */
export function prepareStateDirs(stateDir: string, launch: LaunchId, ops: DurableOps = REAL_DURABLE_OPS): { readonly dir: string; readonly error: string }[] {
  // supervisors/ is needed now (the identity file); a broken proofs/ or cleanup/ must not stop
  // the unit: the proof is then submitted directly (v34 7.1 step 7) and the state goes to the ledger
  ensureDirChainDurable(join(stateDir, 'supervisors'), stateDir, ops);
  const failed: { dir: string; error: string }[] = [];
  for (const d of [proofsDir(stateDir), cleanupDir(stateDir), join(stateDir, 'units', launch)]) {
    try {
      ensureDirChainDurable(d, stateDir, ops);
    } catch (e) {
      failed.push({ dir: d, error: (e as Error).message });
    }
  }
  return failed;
}

/** Runs one unit to its end and returns the process exit code. See the file header for the steps. */
export async function runSupervisor(config: SupervisorConfig, deps: SupervisorDeps = {}): Promise<number> {
  const local = deps.alerts ?? new FileAlertSink(config.stateDir, 'exec');
  const launch = config.launch;
  // 3.11: every alert carries its WI, the trigger facts and the default action already taken;
  // the local copy first, then the ledger once the sink is loaded
  let alertSink: ProofSink | null = null;
  const queued: ExecAlert[] = [];
  const deliveries: Promise<unknown>[] = [];
  const deliver = (a: ExecAlert): void => {
    const s = alertSink;
    if (s?.raiseAlert === undefined) return;
    deliveries.push(
      s.raiseAlert(a).then(
        (r) => {
          if (r === 'delivered') markAlertDelivered(config.stateDir, 'exec', a);
        },
        () => undefined,
      ),
    );
  };
  const raise = (kind: ExecAlertKind, detail: string, trigger: Readonly<Record<string, unknown>>, defaultAction: string, key?: string): void => {
    const a = execAlert(kind, launch, detail, trigger, defaultAction, key);
    try {
      void local.alert(a);
    } catch {
      /* the local copy is best effort beyond appendLineDurable */
    }
    if (alertSink === null) queued.push(a);
    else deliver(a);
  };
  const stop = new StopWatcher(config.stopFiles ?? [], config.stopScope);
  // 6.4: a unit ended because a stop covers it is stopped, not failed: say so, durably, before the
  // proof exists (stopcause.ts). A signal is such a stop only while a covering stop is spooled
  // (a stop writes the control plane first); any other SIGTERM stays an environment failure.
  stop.onStop(() => {
    const cause = stop.cause;
    const spooled = coveringSpoolStops(config.stopScope);
    if (cause?.via === 'file') recordEndedByStop(config.stateDir, launch, { by: 'supervisor', via: 'file', stops: spooled, detail: `stop file ${cause.file}` });
    else if (cause?.via === 'spool' || spooled.length > 0) {
      const via = cause?.via ?? 'spool';
      recordEndedByStop(config.stateDir, launch, { by: 'supervisor', via, stops: spooled, detail: via === 'signal' && cause?.via === 'signal' ? `${cause.signal} while ${spooled.join(', ')} covers the unit` : `stop ${spooled.join(', ') || '(released since)'} covers the unit` });
    }
  });
  const proofOps = opsWithFault(config.testFaults?.proofWrite !== undefined ? ({ dieBefore: config.testFaults.proofWrite, file: `${launch}.json` } satisfies FaultPlan) : undefined);
  let tree: UnitTree | null = null;
  try {
    // 0. the state directory chains, durable before anything runs (finding 12)
    const unprepared = prepareStateDirs(config.stateDir, launch);
    const self = processIdentity(process.pid);
    if (self === null) throw new Error('cannot read own /proc entry');
    const identity: SupervisorIdentity = {
      format: 'mp4.unit-supervisor-identity.v1',
      ...self,
      launch,
      unitName: config.unitName,
      invocationId: process.env['INVOCATION_ID'] ?? null,
      startedAt: new Date().toISOString(),
    };
    writeFileAtomic(supervisorIdentityPath(config.stateDir, launch), `${JSON.stringify(identity, null, 2)}\n`);

    // 1. own leaf + unit subtree
    tree = buildUnitTree(Cgroup.ofProcess('self'), config.unit);
    const unitTree = tree;

    // 1b. what the unit may leave, bound to the identity it has now, before the unit runs
    //     (finding 1: cleanup deletes that very entry or nothing); kept locally from the start,
    //     so a supervisor that dies leaves the identity-bound list for the scheduler
    const policy = cleanupPolicy(config);
    createScratchDirs(config);
    const bound = recordIdentities(unitResources(config, unitTree.unit), policy);
    try {
      writeCleanupFile(config.stateDir, { format: 'mp4.unit-cleanup.v1', launch, state: 'pending', resources: bound, recorded: false, at: new Date().toISOString() });
    } catch (e) {
      unprepared.push({ dir: cleanupDir(config.stateDir), error: (e as Error).message });
    }
    if (unprepared.length > 0) {
      raise(
        'proof-write-failed',
        `state directories not durable: ${unprepared.map((u) => `${u.dir} (${u.error})`).join('; ')}`,
        { unprepared },
        'the unit runs; a proof that cannot be written locally is submitted to the ledger directly and the unit cgroup is kept until the ledger confirms it (v34, v35)',
        `${launch}:state-dirs`,
      );
    }

    // 2. host into the control layer, as our child
    const out = openAppend(config.host.stdoutPath);
    const err = openAppend(config.host.stderrPath);
    const host = spawnInCgroup(unitTree.control, config.host.argv, {
      env: { ...config.host.env, MP_UNIT_CGROUP: unitTree.unit.path, MP_LAUNCH_ID: launch },
      cwd: config.host.cwd,
      stdio: ['ignore', out, err],
      oomScoreAdj: UNIT_OOM_SCORE_ADJ,
    });
    if (typeof out === 'number') closeSync(out);
    if (typeof err === 'number') closeSync(err);

    let stopKillTimer: NodeJS.Timeout | null = null;
    stop.onStop(() => {
      try {
        host.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      stopKillTimer = setTimeout(() => {
        try {
          unitTree.unit.kill();
        } catch {
          /* subtree already gone */
        }
      }, config.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    });

    const [ended, joined] = await Promise.all([host.exited, host.joined]);
    const hostExitedAt = new Date().toISOString();

    // 3. the unit must hold no process before the counters are final
    let leftoversKilled = false;
    if (!(await unitTree.unit.waitEmpty(config.orphanGraceMs ?? 2_000))) {
      unitTree.unit.kill();
      leftoversKilled = true;
    }
    for (let round = 1; !(await unitTree.unit.waitEmpty(config.unkillableAlertMs ?? 60_000)); round++) {
      const pids = unitTree.unit.allProcs();
      raise(
        'unkillable-processes',
        `processes ${pids.join(' ')} remain in ${unitTree.unit.path} after cgroup.kill`,
        { cgroup: unitTree.unit.path, pids, round, waitedMs: round * (config.unkillableAlertMs ?? 60_000) },
        'cgroup.kill is repeated every interval; the proof (and so the result) waits until the unit is empty; the unit stays counted; other work continues',
        `${launch}:unkillable:${round}`,
      );
      unitTree.unit.kill();
    }
    if (stopKillTimer !== null) clearTimeout(stopKillTimer);
    const unitEmptyAt = new Date().toISOString();
    const populatedAtProof = unitTree.unit.populated();
    const counters = {
      controlOomKill: unitTree.control.memoryEvents('hierarchical').oomKill,
      unitOomKill: unitTree.unit.memoryEvents('hierarchical').oomKill,
      unitOom: unitTree.unit.memoryEvents('local').oom,
      serviceOom: unitTree.service.memoryEvents('local').oom,
    };

    // 4. the proof holds immutable facts only (v35); written to its file atomically and durably
    const proof: TerminationProofRecord = {
      kind: 'termination.proof',
      launch,
      exit: ended.status,
      controlOomKill: counters.controlOomKill,
      unitOomKill: counters.unitOomKill,
      unitOom: counters.unitOom,
    };
    const diagnostics: ProofDiagnostics = {
      hostStarted: joined,
      spawnError: ended.error?.message ?? null,
      hostExitedAt,
      unitEmptyAt,
      leftoversKilled,
      populatedAtProof,
      stopped: stop.stopped,
      serviceOom: counters.serviceOom,
    };
    let proofPath: string | null = null;
    try {
      proofPath = writeProofFile(
        config.stateDir,
        {
          format: PROOF_FILE_FORMAT,
          status: 'pending',
          proof,
          writtenAt: new Date().toISOString(),
          supervisor: { pid: self.pid, bootId: self.bootId },
          diagnostics,
          rejection: null,
        },
        proofOps,
      );
    } catch (e) {
      // v34 7.1 step 7: submit the in-memory proof directly, with the same back-off, and alert.
      // Safe: the reconciliation entry always checks the ledger first.
      raise(
        'proof-write-failed',
        `${(e as Error).message}; submitting the proof directly`,
        { error: (e as Error).message, proofsDir: proofsDir(config.stateDir), proof },
        "the proof is submitted to the ledger directly; the unit's cgroup is kept (pending cleanup) until the ledger confirms it",
      );
    }

    // 5. teardown. The unit's cgroup is evidence until the proof is safe: with no proof file,
    //    it stays (listed as pending) until the ledger confirms the proof (v35).
    const cgroupResource = formatCleanupResource({ kind: 'cgroup', path: unitTree.unit.path });
    const all = [...bound, ...holderResources(config)];
    const first = await cleanupPass(proofPath !== null ? all : all.filter((r) => r !== cgroupResource), policy);
    let left = first.left;
    let refusals: readonly CleanupRefusal[] = first.refusals;
    if (proofPath === null) left = [cgroupResource, ...left];
    if (!left.includes(cgroupResource)) tree = null;

    // 6. submit the proof
    let sink: ProofSink | null = null;
    try {
      sink = await loadProofSink(config.sink);
    } catch (e) {
      raise(
        'proof-sink-unloadable',
        `${(e as Error).message}; ${proofPath !== null ? `proof left at ${proofPath}` : 'the proof is lost'}`,
        { sink: config.sink.module, error: (e as Error).message, proofFile: proofPath },
        proofPath !== null ? 'the proof file is left in the state directory; the scheduler submits it at its next reconciliation' : 'nothing more: the reconciliation entry (6.3) decides the attempt',
      );
    }
    alertSink = sink;
    for (const a of queued.splice(0)) deliver(a);
    const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...config.retry };
    let outcome: SubmissionOutcome | null = null;
    if (sink !== null) {
      const o = await submitProofWithRetry(proof, sink, { policy: retry, stop: stop.signal });
      outcome = o;
      // The scheduler may submit the same file concurrently (registration is idempotent); if it
      // already removed or marked the file, there is nothing left to do here.
      const settleFile = (fn: (path: string) => void): void => {
        if (proofPath === null) return;
        const path = proofPath;
        try {
          fn(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !/ENOENT|cannot read/.test((e as Error).message)) throw e;
        }
      };
      const where = proofPath !== null ? `proof left at ${proofPath}` : 'no local proof file';
      switch (o.kind) {
        case 'registered':
          settleFile((p) => removeProofFile(p));
          break;
        case 'rejected':
          settleFile((p) => markProofRejected(p, o.reason, o.detail));
          raise(
            'proof-rejected',
            `${o.reason}: ${o.detail}`,
            { reason: o.reason, detail: o.detail, proof, proofFile: proofPath },
            'the proof file is marked rejected and never resubmitted; the attempt is decided by the reconciliation entry (6.3) without it',
          );
          break;
        case 'gave-up':
          raise(
            'proof-submission-exhausted',
            `${o.attempts} attempts over ${retry.totalMs} ms failed (${o.lastError}); ${where}`,
            { attempts: o.attempts, totalMs: retry.totalMs, lastError: o.lastError, proofFile: proofPath },
            'the supervisor exits; the proof file stays in the state directory and the scheduler submits it at every reconciliation and start',
          );
          break;
        case 'stopped':
          process.stderr.write(`[unit-supervisor] stopped; ${where} (${o.lastError})\n`);
          break;
      }
    }
    if (left.includes(cgroupResource) && outcome?.kind === 'registered') {
      const again = await cleanupPass(left, policy);
      left = again.left;
      refusals = again.refusals;
      if (!left.includes(cgroupResource)) tree = null;
    }

    // 7. cleanup state: pending with what is left, or done (v35). A local copy first, then the ledger.
    const cleanupState = left.length === 0 ? 'done' : 'pending';
    for (const r of refusals.filter((x) => x.reason === 'identity-mismatch' || x.reason === 'identity-unknown' || x.reason === 'path-changed')) {
      raise(
        'cleanup-identity-mismatch',
        `${r.resource}: ${r.detail}`,
        { resource: r.resource, reason: r.reason, detail: r.detail },
        'nothing at that path was deleted; the resource stays pending cleanup (and counted) until the PM decides',
        `${launch}:${r.resource}`,
      );
    }
    if (left.length > 0) {
      raise(
        'cleanup-pending',
        `left for the scheduler: ${left.join(' ')}`,
        { left, refusals },
        'the resources stay listed as pending cleanup and counted as used; the scheduler retries with back-off once this supervisor is gone; other work and admission continue',
      );
    }
    const localState = (recorded: boolean): void => {
      try {
        if (recorded && cleanupState === 'done') removeCleanupFile(config.stateDir, launch);
        else writeCleanupFile(config.stateDir, { format: 'mp4.unit-cleanup.v1', launch, state: cleanupState, resources: left, recorded, at: new Date().toISOString() });
      } catch (e) {
        raise(
          'cleanup-unrecorded',
          `local cleanup state not written: ${(e as Error).message}`,
          { state: cleanupState, left, error: (e as Error).message },
          'the cleanup state goes to the ledger only; if that fails too, the scheduler derives the resources from the launch id (v35)',
        );
      }
    };
    localState(false);
    let recorded = false;
    if (sink?.recordCleanup !== undefined) {
      const once = stop.stopped || outcome?.kind === 'gave-up' || outcome?.kind === 'stopped';
      for (let i = 0, delay = retry.initialDelayMs; i < (once ? 1 : 5); i++, delay = Math.min(delay * 2, retry.maxDelayMs)) {
        if (i > 0) await systemClock.sleep(delay, stop.signal);
        let r: 'recorded' | 'unavailable';
        try {
          r = await sink.recordCleanup(launch, cleanupState, left);
        } catch {
          r = 'unavailable';
        }
        if (r === 'recorded') {
          recorded = true;
          break;
        }
        if (stop.stopped) break;
      }
      if (recorded) localState(true);
      else {
        raise(
          'cleanup-unrecorded',
          `cleanup state ${cleanupState} not recorded in the ledger; local copy kept`,
          { state: cleanupState, left },
          'the local cleanup file is kept; the scheduler carries it into the ledger at its next pass',
          `${launch}:unrecorded`,
        );
      }
    }

    // 8. the host is gone: its model requests still reserved are settled at the reservation (6.5)
    if (sink?.settleOpenSpend !== undefined && outcome?.kind !== 'stopped') {
      let settled: 'settled' | 'unavailable';
      try {
        settled = await sink.settleOpenSpend(launch);
      } catch {
        settled = 'unavailable';
      }
      if (settled === 'unavailable') {
        raise(
          'spend-settlement-unavailable',
          'open reservations of this launch are left to reconciliation',
          { launch },
          "the launch's open reservations stay counted as in flight until the scheduler's reconciliation settles them at the reserved amount",
        );
      }
    }
    await settleAll(deliveries, 10_000);
    sink?.close?.();
    return 0;
  } catch (e) {
    raise('supervisor-error', (e as Error).message, { error: (e as Error).stack ?? String(e) }, 'the supervisor exits; the attempt is decided by the reconciliation entry (6.3), which finds no proof from it unless one was written');
    if (tree !== null) await destroyQuietly(tree, raise);
    await settleAll(deliveries, 5_000);
    alertSink?.close?.();
    return 1;
  } finally {
    stop.dispose();
  }
}

async function settleAll(ps: readonly Promise<unknown>[], ms: number): Promise<void> {
  let t: NodeJS.Timeout | undefined;
  await Promise.race([Promise.allSettled(ps), new Promise((r) => (t = setTimeout(r, ms)))]);
  if (t !== undefined) clearTimeout(t);
}

async function destroyQuietly(
  tree: UnitTree,
  raise: (k: ExecAlertKind, d: string, trigger: Readonly<Record<string, unknown>>, defaultAction: string) => void,
): Promise<void> {
  try {
    await tree.unit.destroy(10_000);
  } catch (e) {
    raise('unit-cleanup-failed', (e as Error).message, { cgroup: tree.unit.path, error: (e as Error).message }, 'the unit cgroup is left; the scheduler derives it from the launch id and retries its cleanup (v35)');
  }
}

// ---------------------------------------------------------------- launching (scheduler side)

export interface LaunchSupervisorOptions {
  readonly config: Omit<SupervisorConfig, 'format' | 'unitName'>;
  readonly unitName?: string;
  /** Extra `-p` properties for the transient service (e.g. MemoryMax= of the service itself). */
  readonly serviceProperties?: readonly string[];
  readonly nodePath?: string;
  /** The supervisor's own stdout and stderr (appended); default: the journal. */
  readonly logPath?: string;
  readonly systemdRunPath?: string;
}

export interface LaunchedSupervisor {
  readonly unitName: string;
  readonly configPath: string;
}

export function defaultUnitName(launch: LaunchId): string {
  return `mp-unit-${launch.replace(/[^A-Za-z0-9_.-]/g, '_')}.service`;
}

/**
 * Starts the supervisor as the main process of an independent transient user service.
 * Delegate=yes hands it the cgroup subtree; OOMPolicy=continue keeps systemd from stopping
 * the service when the kernel kills inside the unit (the supervisor must survive to write
 * the proof); KillMode=mixed sends a stop's SIGTERM to the supervisor alone, so it can
 * still write and submit the proof, with SIGKILL for everything after TimeoutStopSec.
 */
export async function launchUnitSupervisor(opts: LaunchSupervisorOptions): Promise<LaunchedSupervisor> {
  const unitName = opts.unitName ?? defaultUnitName(opts.config.launch);
  const config: SupervisorConfig = { ...opts.config, format: SUPERVISOR_CONFIG_FORMAT, unitName };
  parseSupervisorConfig(JSON.parse(JSON.stringify(config)));
  const configDir = join(config.stateDir, 'configs');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configPath = join(configDir, `${config.launch}.json`);
  writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const args = [
    '--user',
    '--collect',
    '--quiet',
    `--unit=${unitName}`,
    '--service-type=exec',
    `--description=mission-pipeline unit supervisor ${config.launch}`,
    '-p',
    'Delegate=yes',
    '-p',
    'OOMPolicy=continue',
    '-p',
    'KillMode=mixed',
    '-p',
    'TimeoutStopSec=120',
    ...(opts.logPath !== undefined ? ['-p', `StandardOutput=append:${opts.logPath}`, '-p', `StandardError=append:${opts.logPath}`] : []),
    ...(opts.serviceProperties ?? []).flatMap((p) => ['-p', p]),
    '--',
    opts.nodePath ?? process.execPath,
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    SUPERVISOR_MAIN,
    configPath,
  ];
  await execFileAsync(opts.systemdRunPath ?? 'systemd-run', args, { timeout: 30_000 });
  return { unitName, configPath };
}

/** ActiveState of a user unit ("inactive" once a --collect unit has finished and been unloaded). */
export async function unitActiveState(unitName: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['--user', 'show', '-p', 'ActiveState', '--value', unitName], {
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

export async function waitUnitInactive(unitName: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await unitActiveState(unitName);
    if (s === 'inactive' || s === 'failed') return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A stop: SIGTERM to the supervisor only (KillMode=mixed); returns when the unit has stopped. */
export async function stopUnit(unitName: string, timeoutMs = 130_000): Promise<void> {
  await execFileAsync('systemctl', ['--user', 'stop', unitName], { timeout: timeoutMs });
}

/** Last-resort cleanup: SIGKILL everything in the unit and forget a failed state. */
export async function killUnit(unitName: string): Promise<void> {
  for (const args of [
    ['--user', 'kill', '--signal=SIGKILL', unitName],
    ['--user', 'reset-failed', unitName],
  ]) {
    try {
      await execFileAsync('systemctl', args, { timeout: 10_000 });
    } catch {
      /* not loaded any more */
    }
  }
}
