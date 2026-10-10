// Layer 0 (design 10.2): a fixed-size summary the PM reads first. It must answer
// while parts of the engine are down: every source is read with its own time limit,
// and a source that does not answer is shown as such, never guessed (6.1: whether a stop persisted is never
// inferred from the kind of service fault).
//
// Sources: the engine state (watchdog status, heartbeats); the ledger service
// (status, stops, launches, queue, blocks, spend, landings, install states); the
// stop entry's control-plane marks (the four stop states, v47 6.1); the stop
// reports (6.4 "stopped"); the scheduler's status file (waiting, blocks, the evaluator
// fault, blocked pool, degradation); the evaluator's query socket (revision and
// lag), or the last checkpoint's summary while it is down (6.1, WI-11); the notices
// (3.9, with their WI numbers).

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../common/fsx.ts';
import type { StartupBasis } from '../common/records.ts';
import { faultTimeView, readCheckpointSummary } from '../evaluator/checkpoint.ts';
import type { LedgerClient } from '../ledger/ipc.ts';
import type { ActiveStop, LaunchInfo, QueuedTask, StartupDecision } from '../ledger/queries.ts';
import { stopDeliveryStates } from '../ledger/stops.ts';
import { RISK28_REMINDER } from '../ledger/startup.ts';
import { ControlPlane, type SchedulerStatus } from '../scheduler/controlPlane.ts';
import { engineState, type EngineConfig } from '../scheduler/engine.ts';
import { watchdogStatusPath } from '../scheduler/watchdog.ts';
import { ledgerPathsOf } from './config.ts';
import type { Ctx } from './context.ts';
import { errorMessage } from './errors.ts';
import { listNotices, syncNotices } from './notices.ts';
import { describeScope } from './stopDetect.ts';

export type StopLayerState = 'not persisted, awaiting commit' | 'persisted, awaiting commit' | 'committed' | 'stopped' | 'committed, processes cannot be ended';

/** The stop entry's delivery states in English (src/ledger/stops.ts stopDeliveryStates; v47 6.1 the four states). */
export function deliveryStateEn(s: string): StopLayerState {
  if (s === 'committed') return 'committed';
  if (s === 'persisted') return 'persisted, awaiting commit';
  return 'not persisted, awaiting commit';
}

/** Risk 28 option A: what the PM tells the user when the engine went on after an abnormal stop (the ledger's RISK28_REMINDER). */
export const RISK28_REMINDER_EN: string = RISK28_REMINDER;

export interface Layer0Stop {
  readonly stop: string;
  readonly scope: string | null;
  readonly words: string | null;
  readonly state: StopLayerState;
  readonly report: { readonly state: string; readonly summary: string; readonly unkillable: number; readonly undetermined: number } | null;
}

export interface Layer0 {
  readonly format: 'mp4.layer0.v1';
  readonly at: number;
  readonly engine: {
    readonly configured: boolean;
    readonly running: boolean | null;
    readonly watchdogPid: number | null;
    readonly ledgerBeating: boolean | null;
    readonly schedulerBeating: boolean | null;
    readonly services: ReadonlyArray<{ readonly name: string; readonly state: string; readonly restartsThisHour: number; readonly exhaustedSince: number | null }>;
    readonly error: string | null;
  };
  readonly ledger: { readonly reachable: boolean; readonly head: number | null; readonly storageFault: boolean | null; readonly storageFaultReason: string | null; readonly error: string | null };
  readonly recovery: {
    readonly paused: boolean | null;
    readonly pausedSince: number | null;
    readonly startup: { readonly state: StartupDecision['state']; readonly evidence: StartupBasis['evidence']; readonly at: number; readonly clearedAt: number | null; readonly reminder: string | null } | null;
  };
  readonly stops: readonly Layer0Stop[];
  readonly evaluator: {
    readonly source: 'evaluator' | 'checkpoint' | 'none';
    readonly revision: number | null;
    readonly head: number | null;
    readonly lag: number | null;
    readonly fault: string | null;
    readonly failures: number | null;
    readonly blocked: unknown;
    readonly degraded: unknown;
    readonly checkpointPaused: unknown;
    readonly proofDebt: number | null;
    readonly cycles: number | null;
    readonly checkpointWrittenAt: string | null;
  };
  readonly scheduler: { readonly statusAgeMs: number | null; readonly gen: number | null; readonly dispatchPaused: string | null; readonly stale: boolean | null; readonly waiting: number; readonly waitingReasons: readonly string[] };
  readonly work: { readonly queued: number | null; readonly running: number | null; readonly oldestRunningMs: number | null; readonly missions: readonly string[]; readonly changedSinceLastAsk: boolean | null };
  readonly spend: ReadonlyArray<{ readonly mission: string; readonly limit: number | null; readonly spent: number; readonly inflight: number }>;
  readonly blocks: ReadonlyArray<{ readonly mission: string | null; readonly reason: string; readonly source: 'ledger' | 'scheduler' }>;
  readonly landings: ReadonlyArray<{ readonly landing: string; readonly phase: string }>;
  readonly isolation: { readonly accepted: readonly string[] };
  readonly notices: { readonly undelivered: number; readonly unconfirmed: number; readonly byWi: Readonly<Record<string, number>> };
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: string }> {
  try {
    return { ok: true, v: await fn() };
  } catch (e) {
    return { ok: false, e: errorMessage(e) };
  }
}

/** The change marker (10.2: whether any task changed state since the user last asked): a digest of task states, kept when the user asks. */
function changeMarker(stateDir: string, states: Record<string, string> | null, update: boolean): boolean | null {
  if (states === null) return null;
  const p = join(stateDir, 'cli', 'last-status.json');
  const prev = readJson<{ states: Record<string, string> }>(p);
  const changed = prev === null ? true : JSON.stringify(Object.entries(prev.states).sort()) !== JSON.stringify(Object.entries(states).sort());
  if (update) {
    try {
      mkdirSync(join(stateDir, 'cli'), { recursive: true });
      writeFileAtomic(p, JSON.stringify({ states, at: Date.now() }));
    } catch {
      /* only the marker is lost */
    }
  }
  return changed;
}

export async function collectLayer0(ctx: Ctx, o: { readonly ledgerTimeoutMs?: number; readonly markAsked?: boolean } = {}): Promise<Layer0> {
  const c = ctx.config;
  const now = ctx.now;
  const client: LedgerClient = ctx.ledger(o.ledgerTimeoutMs ?? Math.min(3_000, c.timeouts?.ledgerMs ?? 3_000));
  const cp = new ControlPlane(c.controlPlane);

  // ---- engine
  let engine: Layer0['engine'] = { configured: c.engineConfig !== null, running: null, watchdogPid: null, ledgerBeating: null, schedulerBeating: null, services: [], error: null };
  if (c.engineConfig !== null) {
    try {
      const ec = readJson<EngineConfig>(c.engineConfig);
      if (ec === null) throw new Error(`cannot read the engine configuration ${c.engineConfig}`);
      const st = engineState(ec);
      engine = { ...engine, running: st.running, watchdogPid: st.watchdogPid, ledgerBeating: st.ledgerBeating, schedulerBeating: st.schedulerBeating };
    } catch (e) {
      engine = { ...engine, error: errorMessage(e) };
    }
  }
  const wd = readJson<{ processes?: Array<{ name: string; state: string; restartsThisHour: number; exhaustedSince: number | null }> }>(watchdogStatusPath(c.controlPlane));
  if (wd?.processes) engine = { ...engine, services: wd.processes.map((p) => ({ name: p.name, state: p.state, restartsThisHour: p.restartsThisHour ?? 0, exhaustedSince: p.exhaustedSince ?? null })) };

  // ---- ledger (all reads at once, each bounded by the client's time limit)
  type LedgerStatus = { head: number; storageFault: boolean; storageFaultReason: string | null; evaluator: { failures: number; fault: string | null }; recoveryPause: boolean; recoveryPausedSince: number | null; startup: StartupDecision | null };
  const [st, act, unfinished, queue, blocks, landings, installs] = await Promise.all([
    attempt(async () => (await client.call('status', {})) as LedgerStatus),
    attempt(async () => (await client.call('activeStops', {})) as ActiveStop[]),
    attempt(async () => (await client.call('launches', { unfinished: true })) as LaunchInfo[]),
    attempt(async () => (await client.call('taskQueue', {})) as QueuedTask[]),
    attempt(async () => (await client.call('missionBlocks', {})) as Array<{ mission: string; record: { reason: string; state: string } }>),
    attempt(async () => (await client.call('unfinishedLandings', {})) as Array<{ landing: string; phase: string }>),
    attempt(async () => (await client.call('installStates', {})) as Array<{ item: string; value: string; accepted: boolean; by: string }>),
  ]);
  const hb = cp.readLedgerHeartbeat();
  const ledger: Layer0['ledger'] = st.ok
    ? { reachable: true, head: Number(st.v.head), storageFault: st.v.storageFault, storageFaultReason: st.v.storageFaultReason, error: null }
    : { reachable: false, head: hb?.head ?? null, storageFault: hb?.storageFault ?? null, storageFaultReason: null, error: st.e };
  const startup = st.ok ? st.v.startup : null;
  const recovery: Layer0['recovery'] = {
    paused: st.ok ? st.v.recoveryPause : (cp.status()?.recoveryPause ?? null),
    pausedSince: st.ok ? st.v.recoveryPausedSince : null,
    startup: startup === null ? null : { state: startup.state, evidence: startup.basis.evidence, at: startup.at, clearedAt: startup.clearedAt, reminder: startup.basis.reminder },
  };

  // ---- stops: committed (ledger), and this boot's sent stops by their actual confirmations
  const stopsOut = new Map<string, Layer0Stop>();
  const reportOf = (stop: string): Layer0Stop['report'] => {
    const r = cp.stopReport(stop as never);
    return r === null ? null : { state: r.state, summary: r.summary, unkillable: r.unkillable.length, undetermined: r.undeterminedActions.length };
  };
  const committedState = (stop: string): StopLayerState => {
    const r = cp.stopReport(stop as never);
    if (r?.state === 'stopped') return 'stopped';
    if (r?.state === 'stop-effective-unkillable') return 'committed, processes cannot be ended';
    return 'committed';
  };
  if (act.ok) for (const s of act.v) stopsOut.set(s.stop, { stop: s.stop, scope: describeScope(s.scope), words: s.words, state: committedState(s.stop), report: reportOf(s.stop) });
  let sent: Array<{ stop: string; state: string }> = [];
  try {
    sent = stopDeliveryStates(c.controlPlane);
  } catch {
    sent = [];
  }
  const staged = new Map<string, { scope: string; words: string }>();
  for (const s of sent) {
    if (stopsOut.has(s.stop)) continue;
    if (deliveryStateEn(s.state) === 'committed' && act.ok) continue; // committed, and not active any more: released
    if (staged.size === 0) {
      try {
        const dir = join(c.controlPlane, 'stops');
        for (const f of existsSync(dir) ? readdirSync(dir) : []) {
          const r = readJson<{ stop: string; scope: { kind: 'all' } | { kind: 'mission'; mission: string } | { kind: 'capability'; capability: string }; words: string }>(join(dir, f));
          if (r?.stop) staged.set(r.stop, { scope: describeScope(r.scope as never), words: r.words });
        }
      } catch {
        /* the spool is the control plane's: best effort */
      }
    }
    const info = staged.get(s.stop) ?? null;
    stopsOut.set(s.stop, { stop: s.stop, scope: info?.scope ?? null, words: info?.words ?? null, state: deliveryStateEn(s.state) === 'committed' ? committedState(s.stop) : deliveryStateEn(s.state), report: reportOf(s.stop) });
  }

  // ---- scheduler status file and the evaluator
  const ss: SchedulerStatus | null = cp.status();
  const scheduler: Layer0['scheduler'] = {
    statusAgeMs: ss === null ? null : Math.max(0, now - ss.at),
    gen: ss?.gen ?? null,
    dispatchPaused: ss?.dispatchPaused ?? null,
    stale: ss?.stale ?? null,
    waiting: ss?.waiting.length ?? 0,
    waitingReasons: [...new Set((ss?.waiting ?? []).map((w) => w.reason))].slice(0, 5),
  };
  let evaluator: Layer0['evaluator'] = {
    source: 'none',
    revision: null,
    head: ledger.head,
    lag: null,
    fault: ss?.evaluator.fault ?? (st.ok ? st.v.evaluator.fault : null),
    failures: st.ok ? st.v.evaluator.failures : null,
    blocked: ss?.evaluator.blocked ?? null,
    degraded: ss?.evaluator.degraded ?? null,
    checkpointPaused: ss?.evaluator.checkpointPaused ?? null,
    proofDebt: null,
    cycles: null,
    checkpointWrittenAt: null,
  };
  const ev = ctx.evaluator();
  const live = ev === null ? null : await attempt(async () => (await ev.call('summary', {})) as { revision: number | null; head: number; lag: number | null });
  if (live?.ok && live.v.revision !== null) {
    evaluator = { ...evaluator, source: 'evaluator', revision: live.v.revision, head: live.v.head, lag: live.v.lag };
  }
  if (c.evaluatorCheckpoint !== null) {
    const sum = readCheckpointSummary(c.evaluatorCheckpoint);
    if (sum !== null) {
      evaluator = { ...evaluator, proofDebt: sum.proofDebt, cycles: sum.cycles, checkpointWrittenAt: sum.writtenAt };
      if (evaluator.source !== 'evaluator') {
        const v = faultTimeView(sum, ledger.head ?? sum.head ?? sum.revision);
        evaluator = { ...evaluator, source: 'checkpoint', revision: v.revision, head: v.head, lag: v.lag };
      }
    }
  }

  // ---- work, spend, blocks, landings, isolation
  const running = unfinished.ok ? unfinished.v.filter((l) => l.disposition === null) : null;
  const missions = new Set<string>();
  for (const l of unfinished.ok ? unfinished.v : []) missions.add(l.tag.mission);
  for (const q of queue.ok ? queue.v : []) missions.add(q.mission);
  for (const b of blocks.ok ? blocks.v : []) missions.add(b.mission);
  const spend: Array<Layer0['spend'][number]> = [];
  for (const m of [...missions].sort().slice(0, 20)) {
    const s = await attempt(async () => (await client.call('spendSummary', { mission: m })) as { limit: number | null; spent: number; inflight: number });
    if (s.ok) spend.push({ mission: m, limit: s.v.limit, spent: s.v.spent, inflight: s.v.inflight });
  }
  const blocksOut: Array<Layer0['blocks'][number]> = [];
  for (const b of blocks.ok ? blocks.v : []) if (b.record.state === 'blocked') blocksOut.push({ mission: b.mission, reason: b.record.reason === 'budget' ? 'budget block (WI-09)' : 'resource block (WI-10)', source: 'ledger' });
  for (const b of ss?.blocked ?? []) blocksOut.push({ mission: b.mission, reason: b.reason, source: 'scheduler' });
  const states: Record<string, string> | null =
    unfinished.ok && queue.ok ? Object.fromEntries([...queue.v.map((q) => [q.task, 'queued'] as const), ...unfinished.v.map((l) => [l.launch, `${l.disposition ?? 'running'}/${l.cleanup ?? '-'}`] as const)]) : null;
  const src = { controlPlane: c.controlPlane, stateDir: c.stateDir, dbPath: ledgerPathsOf(c).db, content: null };
  if (st.ok) await syncNotices(client, c.stateDir, listNotices(src, { episodeLimit: 200 }).map((n) => n.id));
  const notices = listNotices(src, { episodeLimit: 200 });
  const byWi: Record<string, number> = {};
  for (const n of notices) if (n.state !== 'acknowledged' && n.wi !== null) byWi[n.wi] = (byWi[n.wi] ?? 0) + 1;

  return {
    format: 'mp4.layer0.v1',
    at: now,
    engine,
    ledger,
    recovery,
    stops: [...stopsOut.values()],
    evaluator,
    scheduler,
    work: {
      queued: queue.ok ? queue.v.length : null,
      running: running === null ? null : running.length,
      oldestRunningMs: running === null || running.length === 0 ? null : Math.max(0, now - Math.min(...running.map((l) => l.createdAt))),
      missions: [...missions].sort(),
      changedSinceLastAsk: changeMarker(c.stateDir, states, o.markAsked === true),
    },
    spend,
    blocks: blocksOut,
    landings: landings.ok ? landings.v : [],
    isolation: { accepted: installs.ok ? installs.v.filter((i) => i.accepted).map((i) => `${i.item}=${i.value}`) : [] },
    notices: { undelivered: notices.filter((n) => n.state === 'undelivered').length, unconfirmed: notices.filter((n) => n.state === 'delivered').length, byWi },
  };
}

const yn = (b: boolean | null, y: string, n: string, u = 'unknown'): string => (b === null ? u : b ? y : n);

function dollars(micros: number | null): string {
  return micros === null ? 'unlimited' : `$${(micros / 1_000_000).toFixed(2)}`;
}

function minutes(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** Layer 0 as text; `short` for the session-start context. */
export function renderLayer0(l: Layer0, o: { readonly short?: boolean } = {}): string {
  const lines: string[] = [];
  const e = l.engine;
  const svc = e.services.filter((s) => s.state !== 'running').map((s) => `${s.name}: ${s.state === 'restart-exhausted' ? 'restart-exhausted (WI-22)' : s.state}`);
  lines.push(
    `Engine: ${e.configured ? yn(e.running, 'running', 'not running') : 'not configured'}; ledger service ${yn(l.ledger.reachable, 'available', 'unavailable')}${l.ledger.storageFault ? ' (storage fault, WI-12)' : ''}; scheduler ${yn(e.schedulerBeating, 'beating', 'not beating')}${svc.length > 0 ? `; ${svc.join(', ')}` : ''}`,
  );
  if (l.recovery.paused) lines.push('Recovery pause (WI-12): no dispatch, no authorization; after the user answers: mp resume --answer "<answer>"');
  else if (l.recovery.startup?.state === 'continued' && l.recovery.startup.reminder !== null) lines.push(`Went on by itself after the restart (risk 28, option A): remind the user: "${RISK28_REMINDER_EN}"`);
  if (l.stops.length > 0) {
    lines.push(`Stops (${l.stops.length}):`);
    for (const s of l.stops.slice(0, o.short ? 5 : 50)) lines.push(`  ${s.stop} [${s.state}] scope: ${s.scope ?? 'unknown'}${s.words ? `; words: ${s.words.slice(0, 60)}` : ''}${s.report && s.report.unkillable > 0 ? `; ${s.report.unkillable} processes cannot be ended (WI-14)` : ''}${s.report && s.report.undetermined > 0 ? `; ${s.report.undetermined} actions started before the stop, outcome undetermined` : ''}`);
  } else lines.push('Stops: none');
  const ev = l.evaluator;
  const evState = ev.fault !== null ? `fault (WI-11): ${ev.fault}` : ev.blocked ? 'blocked: its memory pool cannot be enforced (WI-18)' : ev.source === 'evaluator' ? 'normal' : ev.source === 'checkpoint' ? 'unavailable, reading the last checkpoint' : 'unknown';
  lines.push(
    `Evaluator: ${evState}${ev.revision !== null ? `; revision ${ev.revision}, ${ev.lag ?? '?'} commits behind the ledger` : ''}${ev.degraded ? '; degraded pool' : ''}${ev.checkpointPaused ? '; checkpoints paused (WI-11)' : ''}${ev.proofDebt !== null ? `; proof debt ${ev.proofDebt}` : ''}${ev.cycles ? `; dependency cycles ${ev.cycles} (WI-16)` : ''}`,
  );
  const w = l.work;
  lines.push(
    `Tasks: queued ${w.queued ?? '?'}, running ${w.running ?? '?'}${w.oldestRunningMs !== null ? ` (oldest running for ${minutes(w.oldestRunningMs)})` : ''}; waiting ${l.scheduler.waiting}${l.scheduler.dispatchPaused ? `; dispatch paused: ${l.scheduler.dispatchPaused}` : ''}${w.changedSinceLastAsk === null ? '' : w.changedSinceLastAsk ? '; changed since the last query' : '; no change since the last query'}`,
  );
  if (l.blocks.length > 0) lines.push(`Persistently blocked (${l.blocks.length}): ${l.blocks.slice(0, 5).map((b) => `${b.mission ?? '-'}: ${b.reason}`).join('; ')}`);
  if (l.spend.length > 0) lines.push(`Spend: ${l.spend.map((s) => `${s.mission} spent ${dollars(s.spent)}, in flight ${dollars(s.inflight)}, limit ${dollars(s.limit)}`).join('; ')}`);
  if (l.landings.length > 0) lines.push(`Unfinished landings (${l.landings.length}): ${l.landings.slice(0, 5).map((x) => `${x.landing}@${x.phase}`).join(', ')}`);
  if (l.isolation.accepted.length > 0) lines.push(`Degradations the user accepted: ${l.isolation.accepted.join(', ')}`);
  const wis = Object.entries(l.notices.byWi).sort();
  lines.push(`Notices: undelivered ${l.notices.undelivered}, delivered and not confirmed ${l.notices.unconfirmed}${wis.length > 0 ? ` (${wis.map(([k, n]) => `${k} x${n}`).join(', ')})` : ''}`);
  if (!l.ledger.reachable && l.ledger.error) lines.push(`(Ledger service: ${l.ledger.error}; stops still take effect through the inboxes and the fast notice)`);
  return lines.join('\n');
}
