// Starting the engine when the user opens the PM (design v45 6.3 "启动时机", maintainer
// 2026-10-09: "这应该是打开 PM 再启动"). The ledger service, the scheduler and the inbox probes do
// not start with the machine or WSL. The PM session-start hook calls ensureRunning (through
// ensure-running-main.ts): if the watchdog is not running it is started, detached, and it
// starts and supervises the ledger service and the scheduler; if it is running nothing
// happens. Closing the PM session does not stop the engine.
//
// Idempotent and safe against two PM sessions opening at once: one start at a time under a
// lock directory in the control plane (taken over when its holder is gone); a running
// watchdog is recognized by its identity (pid, start time, boot id) and a fresh status.

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessAlive, processIdentity } from '../exec/supervisor.ts';
import { watchdogStatusPath, type WatchdogOptions } from './watchdog.ts';

export const WATCHDOG_MAIN = fileURLToPath(new URL('./watchdog-main.ts', import.meta.url));

export interface EngineConfig {
  /** The watchdog's configuration (WatchdogOptions as JSON). */
  readonly watchdogConfig: string;
  /** How long a start may take until the ledger and the scheduler beat (default 60 s). */
  readonly startTimeoutMs?: number;
  /** A status older than this means the watchdog is not running (default 10 s). */
  readonly staleMs?: number;
  readonly nodePath?: string;
  /** The watchdog's own output (appended). */
  readonly logPath?: string;
}

export interface EngineState {
  readonly running: boolean;
  readonly watchdogPid: number | null;
  readonly ledgerBeating: boolean;
  readonly schedulerBeating: boolean;
}

export interface EnsureResult extends EngineState {
  /** This call started the watchdog. */
  readonly started: boolean;
}

interface WatchdogStatus {
  readonly pid: number;
  readonly startTime: number;
  readonly bootId: string;
  readonly at: number;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function options(cfg: EngineConfig): WatchdogOptions {
  const o = readJson<WatchdogOptions>(cfg.watchdogConfig);
  if (o === null) throw new Error(`cannot read the watchdog configuration ${cfg.watchdogConfig}`);
  return o;
}

/** Whether the watchdog, the ledger service and the scheduler are running now. */
export function engineState(cfg: EngineConfig): EngineState {
  const o = options(cfg);
  const now = Date.now();
  const stale = cfg.staleMs ?? 10_000;
  const st = readJson<WatchdogStatus>(watchdogStatusPath(o.controlPlane));
  const running = st !== null && typeof st.pid === 'number' && now - st.at <= stale && isProcessAlive({ pid: st.pid, startTime: st.startTime, bootId: st.bootId });
  const beat = (path: string): boolean => {
    const hb = readJson<{ pid: number; at: number }>(path);
    return hb !== null && now - hb.at <= stale;
  };
  return { running, watchdogPid: running ? st.pid : null, ledgerBeating: beat(o.ledger.heartbeatPath), schedulerBeating: beat(o.scheduler.heartbeatPath) };
}

/** One start at a time: a lock directory holding the starter's identity, taken over when the starter is gone. */
async function lock(dir: string, timeoutMs: number): Promise<() => void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(dir);
      const me = processIdentity(process.pid);
      writeFileSync(join(dir, 'holder.json'), JSON.stringify(me));
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const holder = readJson<{ pid: number; startTime: number; bootId: string }>(join(dir, 'holder.json'));
    if (holder === null || !isProcessAlive(holder)) {
      // a starter that died (or is between mkdir and writing its identity: wait a moment first)
      await sleep(100);
      const again = readJson<{ pid: number; startTime: number; bootId: string }>(join(dir, 'holder.json'));
      if (again === null || !isProcessAlive(again)) rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`another start of the engine holds ${dir}`);
    await sleep(100);
  }
}

/**
 * Start the engine if it is not running (the PM session-start hook). Returns at once when the
 * watchdog is running; otherwise starts it detached and waits until the ledger service and the
 * scheduler beat.
 */
export async function ensureRunning(cfg: EngineConfig): Promise<EnsureResult> {
  const o = options(cfg);
  mkdirSync(o.controlPlane, { recursive: true });
  const timeout = cfg.startTimeoutMs ?? 60_000;
  const unlock = await lock(join(o.controlPlane, 'engine-start.lock'), timeout);
  try {
    const before = engineState(cfg);
    if (before.running) return { ...before, started: false };
    let out: number | 'ignore' = 'ignore';
    if (cfg.logPath !== undefined) {
      mkdirSync(dirname(cfg.logPath), { recursive: true });
      out = openSync(cfg.logPath, 'a');
    }
    const child = spawn(cfg.nodePath ?? process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', WATCHDOG_MAIN, cfg.watchdogConfig], {
      detached: true,
      stdio: ['ignore', out, out],
    });
    if (typeof out === 'number') closeSync(out);
    child.unref();
    const deadline = Date.now() + timeout;
    for (;;) {
      const st = engineState(cfg);
      if (st.running && st.watchdogPid === child.pid && st.ledgerBeating && st.schedulerBeating) return { ...st, started: true };
      if (child.exitCode !== null) throw new Error(`the watchdog exited with ${child.exitCode} while starting`);
      if (Date.now() > deadline) throw new Error(`the engine did not come up within ${timeout} ms`);
      await sleep(100);
    }
  } finally {
    unlock();
  }
}
