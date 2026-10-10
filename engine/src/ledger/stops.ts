// Stop requests (design v45 6.1 "停止请求的送达", "停止的持久保证"; 6.4).
//
// The PM's prompt hook and the CLI `stop` command call one function, stopEntry,
// which never talks to the ledger service:
//   1. register "entry in progress" under the control-plane lock, then write both
//      inboxes at once: one detached writer process per inbox allocates its own
//      slot (once per boot, never reused), writes it and fdatasyncs (stopWriter.ts);
//   2. as soon as one inbox confirms, or after 2 seconds, write the staging copy
//      (the control-plane spool) and raise the fast signal: the stop is in force;
//   3. tell the sender: persisted, or in force but not persisted (the writers keep
//      writing their own slots until they succeed or the machine stops);
//   4. deregister the entry.
// Inbox first (v43): a stop is in force only once it is persisted, or once the
// sender is about to be told it is not.
//
// The ledger service takes stops from the staging copy and both inboxes and
// commits each as an independent, persistent restriction (service.ts).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fsyncDir, writeFileAtomic } from '../common/fsx.ts';
import { tryControlState, type ControlState } from './controlState.ts';
import { readHeader, readInboxSync, readSlotsSync, type FsCheck, type InboxName } from './inbox.ts';
import { parseStopRequest, type StopRequest, type StopScope } from './stopTypes.ts';

export { checkStopRequest, parseStopRequest, sameTag, scopeWithin, stopCovers, type ScopeTag, type StopRequest, type StopScope } from './stopTypes.ts';

export interface StopPaths {
  /** The primary stop inbox file (next to the ledger, on the Linux filesystem). */
  readonly inbox: string;
  /** Control-plane directory on a memory filesystem. */
  readonly controlPlane: string;
  /** The backup inbox file on another volume, or null for none; undefined: as installed (inboxes.json). */
  readonly backupInbox?: string | null;
}

// ---------------------------------------------------------------- inbox configuration

export interface InboxConfig {
  readonly format: 'mp4.stop-inboxes.v1';
  readonly primary: string;
  readonly backup: string | null;
  readonly installedAt: number;
  readonly fs: { readonly primary: FsCheck; readonly backup: FsCheck | null };
}

/** The install record, next to the primary inbox. */
export function inboxConfigFile(primary: string): string {
  return join(dirname(primary), 'inboxes.json');
}

function controlInboxConfig(controlPlane: string): string {
  return join(controlPlane, 'stop-inboxes.json');
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Record the inbox configuration on disk (install) and in the control plane (so an entry need not read the disk to find the backup). */
export function writeInboxConfig(paths: StopPaths, cfg: InboxConfig): void {
  writeFileAtomic(inboxConfigFile(paths.inbox), JSON.stringify(cfg, null, 2));
  try {
    mkdirSync(paths.controlPlane, { recursive: true });
    writeFileAtomic(controlInboxConfig(paths.controlPlane), JSON.stringify(cfg));
  } catch {
    /* the control plane only speeds this up */
  }
}

/** The configured inbox files: the backup from the paths, else the control-plane copy, else the install record. */
export function resolveInboxes(paths: StopPaths): { primary: string; backup: string | null } {
  if (paths.backupInbox !== undefined) return { primary: paths.inbox, backup: paths.backupInbox };
  const cfg = readJson<InboxConfig>(controlInboxConfig(paths.controlPlane)) ?? readJson<InboxConfig>(inboxConfigFile(paths.inbox));
  return { primary: paths.inbox, backup: cfg && cfg.primary === paths.inbox ? cfg.backup : null };
}

export function configuredInboxes(paths: StopPaths): Array<{ name: InboxName; file: string }> {
  const r = resolveInboxes(paths);
  return r.backup === null ? [{ name: 'primary', file: r.primary }] : [{ name: 'primary', file: r.primary }, { name: 'backup', file: r.backup }];
}

export function readBootId(): string {
  return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

// ---------------------------------------------------------------- staging (control plane)

export function spoolDir(paths: { readonly controlPlane: string }): string {
  return join(paths.controlPlane, 'stops');
}

export function signalPath(paths: { readonly controlPlane: string }): string {
  return join(paths.controlPlane, 'stop-signal');
}

/** Stops in the staging copy (the spool). */
export function stagedStops(controlPlane: string): StopRequest[] {
  const dir = spoolDir({ controlPlane });
  if (!existsSync(dir)) return [];
  const out: StopRequest[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    let r: StopRequest | null = null;
    try {
      r = parseStopRequest(readFileSync(join(dir, name), 'utf8'));
    } catch {
      r = null;
    }
    if (r) out.push(r);
  }
  return out;
}

export async function stagedStopsAsync(controlPlane: string, skip: (name: string) => boolean = () => false): Promise<Array<{ name: string; request: StopRequest | null }>> {
  const dir = spoolDir({ controlPlane });
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return [];
  }
  const out: Array<{ name: string; request: StopRequest | null }> = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.') || skip(name)) continue;
    let request: StopRequest | null = null;
    try {
      request = parseStopRequest(await readFile(join(dir, name), 'utf8'));
    } catch {
      request = null;
    }
    out.push({ name, request });
  }
  return out;
}

/** "No uncommitted stop in staging" (v45 6.1 probes and shutdown): every staged stop is marked committed by the ledger. */
export function stagingClean(controlPlane: string, control: ControlState): boolean {
  return stagedStops(controlPlane).every((r) => control.isCommitted(r.stop));
}

/** A WI-12 alert copy in the control plane (3.9), for the PM's monitor, without the ledger. */
export function putControlAlert(controlPlane: string, a: { alert: string; category: string; trigger: string; defaultAction: string; detail: unknown; source: string }): void {
  try {
    const dir = join(controlPlane, 'alerts');
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(
      join(dir, `${a.alert}.json`),
      JSON.stringify({ format: 'mp4.alert-copy.v1', alert: a.alert, category: a.category, wi: 'WI-12', key: a.alert, trigger: a.trigger, defaultAction: a.defaultAction, detail: a.detail, source: a.source, at: Date.now(), committed: false }),
    );
  } catch {
    /* the control plane is gone: nothing else can carry it now */
  }
}

// ---------------------------------------------------------------- the entry

/** v45 6.1: each inbox write has a 2-second limit. */
export const STOP_INBOX_TIMEOUT_MS = 2_000;
export const STOP_EXIT_PERSISTED = 0;
/** The CLI's exit code for "notified, not persisted" (EX_TEMPFAIL). */
export const STOP_NOT_PERSISTED_EXIT_CODE = 75;
/** The CLI's exit code when neither an inbox nor the staging copy could be written. */
export const STOP_FAILED_EXIT_CODE = 76;
/**
 * The entry's results, worded by the actual state (v48 6.1 "停止请求的送达"; the
 * product text is English). "In force" / "committed" is kept for the stop being
 * committed by the ledger (入账); the entry only reports notice and persistence.
 */
export const STOP_PERSISTED_MESSAGE = 'Fast notice sent; persisted (awaiting commit).';
export const STOP_NOT_PERSISTED_NOTICE = 'Fast notice sent, but it could not be persisted (awaiting commit).';
const STOP_NOT_NOTIFIED_NOTICE = 'Persisted (awaiting commit), but the fast notice could not be sent.';
const STOP_FAILED_NOTICE = 'The fast notice could not be sent and the stop could not be persisted; the inbox writes are still being retried in the background.';
const SLOTS_EXHAUSTED_NOTICE = "This boot's inbox slots are used up (WI-12).";

/** pending: still writing when another inbox confirmed; timeout: no confirmation within the limit. */
export type InboxWriteOutcome = 'written' | 'failed' | 'exhausted' | 'pending' | 'timeout' | 'not-installed' | 'not-started';

export interface StopEntryReport {
  /**
   * persisted: an inbox confirmed and the fast notice went out (the stop is
   * committed at the next start at the latest); notified-not-persisted: the fast
   * notice went out, no inbox confirmed within 2 s; persisted-not-notified: the
   * staging copy could not be written; failed: neither.
   */
  readonly result: 'persisted' | 'notified-not-persisted' | 'persisted-not-notified' | 'failed';
  /** What the hook writes into the PM session and the CLI prints (v48 wording). */
  readonly message: string;
  readonly exitCode: number;
  readonly durable: boolean;
  /** The staging copy is written and the fast signal raised (快速通知); the stop takes effect when committed (入账). */
  readonly spooled: boolean;
  readonly inboxes: Readonly<Partial<Record<InboxName, InboxWriteOutcome>>>;
  /** The message when the result is not `persisted` (delivered to the PM under WI-12); null otherwise. */
  readonly notice: string | null;
  /** Writers still trying (detached): they write their own slot until they succeed or the machine stops. */
  readonly writerPids: readonly number[];
  readonly entry: string;
  /** Registered after the shutdown seal: it counts as arriving after the clean exit (v45 6.1). */
  readonly afterSeal: boolean;
}

const WRITER = fileURLToPath(new URL('./stopWriter.ts', import.meta.url));
const WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));

export interface StopEntryOptions {
  readonly bootId?: string;
  readonly timeoutMs?: number;
  /** Tests: make the writers wait this long before writing (a hanging disk). */
  readonly writerDelayMs?: number;
  /** Tests: writers give up after this long (they otherwise retry until the machine stops). */
  readonly writerLifetimeMs?: number;
}

/** The one stop entry of the PM hook and the CLI (v45 6.1). Synchronous; at most `timeoutMs` (2 s) of waiting. */
export function stopEntry(paths: StopPaths, req: StopRequest, opts: StopEntryOptions = {}): StopEntryReport {
  const boot = opts.bootId ?? readBootId();
  const timeoutMs = opts.timeoutMs ?? STOP_INBOX_TIMEOUT_MS;
  const entry = `${req.stop}.${randomBytes(6).toString('hex')}`;
  const control = tryControlState(paths.controlPlane);
  let afterSeal = false;
  try {
    if (control) afterSeal = !control.registerEntry(entry, boot, req.stop, process.pid, Date.now()).beforeSeal;
  } catch {
    /* without the control plane the entry still writes what it can */
  }
  const outcomes: Partial<Record<InboxName, InboxWriteOutcome>> = {};
  const pids = new Map<InboxName, number>();
  for (const { name, file } of configuredInboxes(paths)) {
    if (!existsSync(file)) {
      outcomes[name] = 'not-installed';
      continue;
    }
    try {
      const child = spawn(
        process.execPath,
        [
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          WRITER,
          JSON.stringify({ controlPlane: paths.controlPlane, boot, entry, inbox: name, file, request: req, delayMs: opts.writerDelayMs ?? 0, lifetimeMs: opts.writerLifetimeMs ?? null }),
        ],
        { detached: true, stdio: 'ignore' },
      );
      child.on('error', () => undefined);
      child.unref();
      if (child.pid !== undefined) pids.set(name, child.pid);
      outcomes[name] = 'timeout';
    } catch {
      outcomes[name] = 'not-started';
    }
  }
  // 2. Wait for one confirmation, every writer failing, or the limit.
  const end = Date.now() + timeoutMs;
  let durable = false;
  while (pids.size > 0 && control) {
    let writes: Map<InboxName, string>;
    try {
      writes = control.writesOf(entry);
    } catch {
      writes = new Map();
    }
    for (const [name] of pids) {
      const st = writes.get(name);
      if (st === 'written' || st === 'failed' || st === 'exhausted') outcomes[name] = st;
    }
    durable = [...pids.keys()].some((n) => outcomes[n] === 'written');
    // A failure may pass on retry within the limit; only exhausted slots are final.
    const allFinal = [...pids.keys()].every((n) => outcomes[n] === 'exhausted');
    if (durable || allFinal || Date.now() >= end) break;
    Atomics.wait(WAIT_CELL, 0, 0, 5);
  }
  for (const [name] of pids) if (outcomes[name] === 'timeout' && durable) outcomes[name] = 'pending';
  // 3. Staging copy and the fast signal.
  let spooled = false;
  try {
    mkdirSync(spoolDir(paths), { recursive: true });
    writeFileAtomic(join(spoolDir(paths), `${req.stop}.json`), JSON.stringify(req));
    writeFileAtomic(signalPath(paths), String(req.at));
    spooled = true;
  } catch {
    spooled = false;
  }
  // 4. Deregister.
  try {
    control?.endEntry(entry, Date.now());
  } catch {
    /* an unended entry only delays a clean exit, which then is not written */
  }
  control?.close();
  const writerPids = [...pids.entries()].filter(([n]) => outcomes[n] !== 'written' && outcomes[n] !== 'exhausted').map(([, p]) => p);
  const exhausted = Object.values(outcomes).includes('exhausted');
  const result: StopEntryReport['result'] = durable ? (spooled ? 'persisted' : 'persisted-not-notified') : spooled ? 'notified-not-persisted' : 'failed';
  const base = result === 'persisted' ? STOP_PERSISTED_MESSAGE : result === 'persisted-not-notified' ? STOP_NOT_NOTIFIED_NOTICE : result === 'notified-not-persisted' ? STOP_NOT_PERSISTED_NOTICE : STOP_FAILED_NOTICE;
  const message = exhausted ? `${base} ${SLOTS_EXHAUSTED_NOTICE}` : base;
  const notice = result === 'persisted' && !exhausted ? null : message;
  const exitCode = durable ? STOP_EXIT_PERSISTED : spooled ? STOP_NOT_PERSISTED_EXIT_CODE : STOP_FAILED_EXIT_CODE;
  return { result, message, exitCode, durable, spooled, inboxes: outcomes, notice, writerPids, entry, afterSeal };
}

export interface SendStopOutcome {
  readonly durable: boolean;
  readonly spooled: boolean;
  readonly notice?: string;
  readonly writerPid?: number;
}

/** The compact form of stopEntry (kept for existing callers): `{ durable, spooled }` when all went well. */
export function sendStop(paths: StopPaths, req: StopRequest, opts: StopEntryOptions = {}): SendStopOutcome {
  const r = stopEntry(paths, req, opts);
  if (r.notice === null) return { durable: r.durable, spooled: r.spooled };
  const pid = r.writerPids[0];
  return pid === undefined ? { durable: r.durable, spooled: r.spooled, notice: r.notice } : { durable: r.durable, spooled: r.spooled, notice: r.notice, writerPid: pid };
}

// ---------------------------------------------------------------- layer 0 (v48 6.1 "停止的四种状态")

/** committed (入账); persisted, awaiting commit (至少一处收件箱已确认); not persisted, awaiting commit. */
export type StopDeliveryState = 'committed' | 'persisted' | 'not-persisted';

/**
 * The state of each stop sent in this boot, from the actual confirmations: an
 * inbox write confirmed (the control plane's write marks) → 已持久; the ledger's
 * commit mark → 已入账. Never inferred from a service fault (v48).
 */
export function stopDeliveryStates(controlPlane: string): Array<{ stop: string; state: StopDeliveryState }> {
  const control = existsSync(join(controlPlane, 'stop-entry.sqlite')) ? tryControlState(controlPlane) : null;
  try {
    const stops = new Set<string>(stagedStops(controlPlane).map((r) => r.stop));
    const persisted = new Set<string>();
    if (control) {
      for (const r of control.db.prepare("SELECT stop, state FROM slots WHERE kind = 'stop'").all() as Array<{ stop: string; state: string }>) {
        stops.add(r.stop);
        if (r.state === 'written') persisted.add(r.stop);
      }
    }
    return [...stops].sort().map((stop) => ({
      stop,
      state: control?.isCommitted(stop) ? 'committed' : persisted.has(stop) ? 'persisted' : 'not-persisted',
    }));
  } finally {
    control?.close();
  }
}

// ---------------------------------------------------------------- readers

function dedupe(reqs: readonly StopRequest[]): StopRequest[] {
  const byId = new Map<string, StopRequest>();
  for (const r of reqs) if (!byId.has(r.stop)) byId.set(r.stop, r);
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

/**
 * Stops sent in this boot that may not be committed yet: the staging copy and
 * the inbox slots allocated in this boot (from the control plane). Previous
 * boots' stops are committed before anything else at the ledger's start.
 */
export function readPendingStops(paths: StopPaths): StopRequest[] {
  const out: StopRequest[] = [...stagedStops(paths.controlPlane)];
  if (existsSync(paths.inbox) && existsSync(join(paths.controlPlane, 'stop-entry.sqlite'))) {
    const control = tryControlState(paths.controlPlane);
    try {
      if (control) {
        const allocs = control.db.prepare("SELECT inbox, slot FROM slots WHERE kind = 'stop'").all() as Array<{ inbox: InboxName; slot: number }>;
        for (const { name, file } of configuredInboxes(paths)) {
          const idx = allocs.filter((a) => a.inbox === name).map((a) => Number(a.slot));
          if (idx.length === 0) continue;
          try {
            for (const c of readSlotsSync(file, readHeader(file), idx).values()) if (c.state === 'record' && c.record.kind === 'stop') out.push(c.record.request);
          } catch {
            /* an unreadable inbox: the staging copy and the other inbox still count */
          }
        }
      }
    } finally {
      control?.close();
    }
  }
  return dedupe(out);
}

// ---------------------------------------------------------------- resolutions (6.4: released, narrowed)

/**
 * The staging copy and the inbox slots keep a request after the ledger
 * committed it, and slots are never reused within a boot. So when the ledger
 * commits a release or a narrowing it also writes a resolution marker for that
 * stop in the control plane (fsynced file and directory), and at its start it
 * writes any marker a crash left missing. Readers that run while the ledger may
 * be down (the unit supervisor, the seat host, the watchdog) read the spool
 * through stagedStopsInForce, which drops released stops and applies a
 * narrowing's new scope. A missing marker only over-stops until the ledger's
 * next start; it never under-stops.
 */
export interface StopResolution {
  readonly format: 'mp4.stop-resolution.v1';
  readonly stop: string;
  readonly state: 'released' | 'narrowed';
  /** narrowed: the stop that replaced it and that stop's scope. */
  readonly to?: string;
  readonly scope?: StopScope;
  readonly at: number;
}

export function resolutionsDir(controlPlane: string): string {
  return join(controlPlane, 'stop-resolutions');
}

function resolutionFile(controlPlane: string, stop: string): string {
  // Stop ids are ids (no path separators); encoded anyway, so a file name never escapes the directory.
  return join(resolutionsDir(controlPlane), `${encodeURIComponent(stop)}.json`);
}

/** Write a stop's resolution marker durably (the ledger, after the commit). Throws when the control plane cannot be written. */
export function writeStopResolution(controlPlane: string, r: Omit<StopResolution, 'format'>): void {
  const dir = resolutionsDir(controlPlane);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    fsyncDir(dirname(dir));
  }
  writeFileAtomic(resolutionFile(controlPlane, r.stop), JSON.stringify({ format: 'mp4.stop-resolution.v1', ...r }));
}

export function readStopResolution(controlPlane: string, stop: string): StopResolution | null {
  try {
    const r = JSON.parse(readFileSync(resolutionFile(controlPlane, stop), 'utf8')) as StopResolution;
    if (r.format !== 'mp4.stop-resolution.v1' || r.stop !== stop || (r.state !== 'released' && r.state !== 'narrowed')) return null;
    return r;
  } catch {
    return null;
  }
}

/** A stop's scope in force from the markers: null when released (directly, or at the end of its narrowing chain). */
function scopeInForce(controlPlane: string, stop: string, scope: StopScope): StopScope | null {
  let cur = stop;
  let s: StopScope = scope;
  for (let depth = 0; depth < 64; depth++) {
    const r = readStopResolution(controlPlane, cur);
    if (r === null) return s;
    if (r.state === 'released') return null;
    // narrowed: in force by the new scope; without one in the marker, the old (wider) scope stays (conservative).
    if (r.scope === undefined || r.to === undefined) return s;
    s = r.scope;
    cur = r.to;
  }
  return s;
}

/**
 * The staged stops still in force (spool and this boot's inbox slots, as
 * readPendingStops reads them), minus those the ledger released, with a
 * narrowed stop covering by its new scope. A committed stop still active keeps
 * covering. For readers that must decide without the ledger.
 */
export function stagedStopsInForce(paths: StopPaths): StopRequest[] {
  const out: StopRequest[] = [];
  for (const r of readPendingStops(paths)) {
    const scope = scopeInForce(paths.controlPlane, r.stop, r.scope);
    if (scope !== null) out.push(scope === r.scope ? r : { ...r, scope });
  }
  return out;
}

/** Every stop request the inboxes still hold (all boots not yet reclaimed) and the staging copy: for reports such as the WI-12 check. */
export function readStopHistory(paths: StopPaths): StopRequest[] {
  const out: StopRequest[] = [...stagedStops(paths.controlPlane)];
  for (const { file } of configuredInboxes(paths)) {
    if (!existsSync(file)) continue;
    try {
      for (const c of readInboxSync(file).slots) if (c.state === 'record' && c.record.kind === 'stop') out.push(c.record.request);
    } catch {
      /* unreadable: reported by the startup decision */
    }
  }
  return dedupe(out);
}
