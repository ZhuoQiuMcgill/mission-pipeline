// The PM session's background monitor (design 3.9: a monitor in the background of the PM session watches the
// mailbox; a new notice wakes the PM for a turn to show it to the user; 9.3 self-check item 8).
//
// `mp watch-notices` runs as a Claude Code background command. It blocks until there is
// something the PM must see: an undelivered notice (an alert copy in the control plane, or an
// episode notice the ledger committed), a change in a stop's state, or a change in the
// recovery pause or a storage fault. Then it prints it in the hooks' format (WI number, title,
// page path), marks the notices delivered, and exits 0: the exit wakes the PM, which handles
// it and starts the watcher again. With --timeout it also exits (0, event "timeout").
//
// No busy polling: inotify watches on the control plane (alerts, the stop spool, stop reports,
// the scheduler's status, the ledger heartbeat, whose head tells when the ledger committed
// something), each change checked after a short coalescing delay; a slow safety recheck covers
// watches that miss events (a directory recreated after a reboot).

import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { stopDeliveryStates } from '../ledger/stops.ts';
import { ControlPlane } from '../scheduler/controlPlane.ts';
import { ledgerPathsOf, type CliConfig } from './config.ts';
import type { ContentStore } from '../ledger/content.ts';
import { listNotices, markDelivered, noticeLines, syncNotices, type PmNotice } from './notices.ts';
import { LedgerClient } from '../ledger/ipc.ts';

/** Probe notices of the self-check (item 8) start with this; a real watcher ignores them. */
export const PROBE_PREFIX = 'selfcheck.pm-monitor.';

export interface WatchState {
  readonly notices: readonly PmNotice[];
  /** stop → state, from the actual confirmations and the stop reports. */
  readonly stops: Readonly<Record<string, string>>;
  readonly recoveryPause: boolean | null;
  readonly storageFault: boolean | null;
}

export type WatchEvent =
  | { readonly kind: 'notices'; readonly notices: readonly PmNotice[] }
  | { readonly kind: 'stops'; readonly changes: ReadonlyArray<{ readonly stop: string; readonly from: string | null; readonly to: string | null }> }
  | { readonly kind: 'recovery'; readonly from: WatchState; readonly to: WatchState }
  | { readonly kind: 'timeout'; readonly waitedMs: number };

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function watchState(c: CliConfig, content: ContentStore | null, o: { readonly probe?: string | null } = {}): WatchState {
  const notices = listNotices({ controlPlane: c.controlPlane, stateDir: c.stateDir, dbPath: ledgerPathsOf(c).db, content }).filter(
    (n) => n.state === 'undelivered' && (o.probe ? n.id === o.probe : !n.id.startsWith(PROBE_PREFIX)),
  );
  const cp = new ControlPlane(c.controlPlane);
  const stops: Record<string, string> = {};
  try {
    for (const s of stopDeliveryStates(c.controlPlane)) {
      const r = cp.stopReport(s.stop as never);
      stops[s.stop] = r === null ? s.state : `${s.state}/${r.state}`;
    }
  } catch {
    /* the control plane is gone: no stop states to compare */
  }
  const st = cp.status();
  const hb = readJson<{ storageFault?: boolean }>(join(c.controlPlane, 'ledger.heartbeat'));
  return { notices, stops, recoveryPause: st?.recoveryPause ?? null, storageFault: hb?.storageFault ?? st?.storageFault ?? null };
}

/** What changed between two states (notices first: they carry the WI). Null: nothing for the PM. */
export function watchEventOf(from: WatchState, to: WatchState, o: { readonly probe?: string | null } = {}): WatchEvent | null {
  if (to.notices.length > 0) return { kind: 'notices', notices: to.notices };
  if (o.probe) return null;
  const changes: Array<{ stop: string; from: string | null; to: string | null }> = [];
  for (const stop of new Set([...Object.keys(from.stops), ...Object.keys(to.stops)])) {
    const a = from.stops[stop] ?? null;
    const b = to.stops[stop] ?? null;
    if (a !== b && b !== null) changes.push({ stop, from: a, to: b });
  }
  if (changes.length > 0) return { kind: 'stops', changes };
  if ((to.recoveryPause !== null && to.recoveryPause !== from.recoveryPause) || (to.storageFault !== null && to.storageFault !== from.storageFault)) return { kind: 'recovery', from, to };
  return null;
}

export interface WatchOptions {
  readonly timeoutMs?: number | null;
  /** Coalescing delay after a change (default 150 ms). */
  readonly settleMs?: number;
  /** Safety recheck period (default 30 s). */
  readonly recheckMs?: number;
  /** Self-check: wait for this probe notice only. */
  readonly probe?: string | null;
  /** Called once the watches are in place (the probe raises its notice after this). */
  readonly onWatching?: () => void;
  readonly signal?: AbortSignal;
}

/** Block until there is something for the PM (or the time limit); returns the event. */
export function watchOnce(c: CliConfig, content: ContentStore | null, o: WatchOptions = {}): Promise<WatchEvent> {
  const t0 = Date.now();
  const probe = o.probe ?? null;
  const start = watchState(c, content, { probe });
  const immediate = start.notices.length > 0 ? ({ kind: 'notices', notices: start.notices } as const) : null;
  if (immediate !== null) {
    o.onWatching?.();
    return Promise.resolve(immediate);
  }
  return new Promise<WatchEvent>((resolve) => {
    const watchers: FSWatcher[] = [];
    const timers: NodeJS.Timeout[] = [];
    let pending: NodeJS.Timeout | null = null;
    let done = false;
    const finish = (e: WatchEvent): void => {
      if (done) return;
      done = true;
      for (const w of watchers) w.close();
      for (const t of timers) clearTimeout(t);
      if (pending !== null) clearTimeout(pending);
      resolve(e);
    };
    const check = (): void => {
      pending = null;
      if (done) return;
      const ev = watchEventOf(start, watchState(c, content, { probe }), { probe });
      if (ev !== null) finish(ev);
    };
    const changed = (): void => {
      if (done || pending !== null) return;
      pending = setTimeout(check, o.settleMs ?? 150);
    };
    const add = (dir: string, relevant: (file: string) => boolean = () => true): void => {
      try {
        mkdirSync(dir, { recursive: true });
        const w = watch(dir, { persistent: true }, (_ev, file) => {
          const f = typeof file === 'string' ? file : '';
          if (f === '' || (!f.startsWith('.') && relevant(f))) changed();
        });
        w.on('error', () => undefined);
        watchers.push(w);
      } catch {
        /* the safety recheck covers it */
      }
    };
    // The control plane itself: the heartbeat and the scheduler's status are rewritten all the time;
    // only a new ledger head (the ledger committed something: maybe a notice), a fault, or a pause
    // change counts. Stop marks and the stop signal always do.
    let seen = { head: readJson<{ head?: number }>(join(c.controlPlane, 'ledger.heartbeat'))?.head ?? null, fault: start.storageFault, pause: start.recoveryPause };
    add(c.controlPlane, (f) => {
      if (f === 'ledger.heartbeat') {
        const hb = readJson<{ head?: number; storageFault?: boolean }>(join(c.controlPlane, f));
        if (hb === null || (hb.head ?? null) === seen.head && (hb.storageFault ?? null) === seen.fault) return false;
        seen = { ...seen, head: hb.head ?? null, fault: hb.storageFault ?? null };
        return true;
      }
      if (f === 'scheduler.status.json') {
        const st = readJson<{ recoveryPause?: boolean; storageFault?: boolean }>(join(c.controlPlane, f));
        if (st === null || ((st.recoveryPause ?? null) === seen.pause && (st.storageFault ?? null) === seen.fault)) return false;
        seen = { ...seen, pause: st.recoveryPause ?? null };
        return true;
      }
      return f === 'stop-signal' || f.startsWith('stop-entry.sqlite') || f === 'stop-inboxes.json';
    });
    add(join(c.controlPlane, 'alerts'));
    add(join(c.controlPlane, 'stops'));
    add(join(c.controlPlane, 'reports', 'stops'));
    const recheck = setInterval(changed, o.recheckMs ?? 30_000);
    timers.push(recheck as unknown as NodeJS.Timeout);
    if (o.timeoutMs !== undefined && o.timeoutMs !== null) timers.push(setTimeout(() => finish({ kind: 'timeout', waitedMs: Date.now() - t0 }), o.timeoutMs));
    o.signal?.addEventListener('abort', () => finish({ kind: 'timeout', waitedMs: Date.now() - t0 }));
    o.onWatching?.();
    // anything that happened between the first read and the watches
    changed();
  });
}

/** The event in the PM's words (the hooks' format), and the notice ids it delivers. */
export function renderWatchEvent(e: WatchEvent, env: NodeJS.ProcessEnv = process.env): { text: string; delivered: string[] } {
  const head = '[Mission Pipeline 4] ';
  switch (e.kind) {
    case 'notices':
      return { text: [`${head}New notices (${e.notices.length}; open the page of the WI each one names; all of them: mp alerts):`, ...noticeLines(e.notices, 10, env), 'After handling it, start the background watcher again: mp watch-notices'].join('\n'), delivered: e.notices.map((n) => n.id) };
    case 'stops':
      return { text: [`${head}Stop state changes:`, ...e.changes.map((c) => `- ${c.stop}: ${c.from ?? '(new)'} -> ${c.to}`), 'Details: mp show stop <stop id>; after handling it, start the background watcher again: mp watch-notices'].join('\n'), delivered: [] };
    case 'recovery': {
      const lines = [`${head}Engine state changes:`];
      if (e.to.recoveryPause !== e.from.recoveryPause) lines.push(e.to.recoveryPause ? '- recovery pause entered (WI-12): ask the user, then mp resume --answer "<answer>"' : '- the recovery pause was lifted');
      if (e.to.storageFault !== e.from.storageFault) lines.push(e.to.storageFault ? '- ledger storage fault (WI-12): stops still take effect through the inboxes and the fast notice' : '- the ledger storage fault ended');
      lines.push('Layer 0: mp status; after handling it, start the background watcher again: mp watch-notices');
      return { text: lines.join('\n'), delivered: [] };
    }
    case 'timeout':
      return { text: `${head}No new notice in ${Math.round(e.waitedMs / 1000)} s; start the background watcher again: mp watch-notices`, delivered: [] };
  }
}

/** Run once and mark what it showed as delivered (the command and the probe). */
export async function watchAndDeliver(c: CliConfig, content: ContentStore | null, o: WatchOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<{ event: WatchEvent; text: string }> {
  const event = await watchOnce(c, content, o);
  const r = renderWatchEvent(event, env);
  try {
    markDelivered(c.stateDir, r.delivered);
  } catch {
    /* shown again next time: a duplicate, never a loss */
  }
  if (r.delivered.length > 0) {
    const client = new LedgerClient(c.ledgerSocket, 1_500);
    try {
      await syncNotices(client, c.stateDir);
    } finally {
      client.close();
    }
  }
  return { event, text: r.text };
}

export function controlPlaneReady(c: CliConfig): boolean {
  return existsSync(c.controlPlane);
}
