// Stops on the scheduler side (design 6.4, 6.1).
//
// A stop takes effect when the ledger service commits it; from then on no result in its scope
// is published and no external action in its scope is authorized (the ledger enforces both).
// The scheduler's part:
//   - react to the control-plane fast signal by asking the service to drain the inbox and the
//     spool (stops jump the service's queue), and reload every active stop after any restart;
//   - end every unit in scope: `systemctl stop` (SIGTERM to the supervisor, which ends its host
//     and still writes the proof), then SIGKILL for whatever is left;
//   - while the ledger cannot commit (storage fault), end the units in scope anyway, from the
//     host manifest in the control plane: that needs no ledger write (6.1);
//   - report "stopped" only when every unit in scope has no process left and its cleanup is
//     done (sandbox, mounts, images, network grants, cgroup: v35); processes still present a
//     while after being killed make the report "stop effective, N processes cannot be ended"
//     with each process and why; external actions authorized before the stop whose outcome is
//     not settled are listed apart ("started before the stop, outcome undetermined").

import type { LaunchId, StopId } from '../common/ids.ts';
import { readPendingStops, stopCovers, type ScopeTag, type StopPaths, type StopScope } from '../ledger/stops.ts';
import type { Alerts } from './alerts.ts';
import type { ControlPlane, StopReport, StopReportIntent, StopReportProcess, StopReportState, StopReportUnit } from './controlPlane.ts';
import { isTransient, type LaunchInfo, type OpenIntent, type SchedulerLedger } from './ledger.ts';
import { recordEndedByStop } from '../exec/stopcause.ts';
import type { Takeover } from './takeover.ts';
import {
  derivedUnitCgroupPath,
  hostHeartbeat,
  killUnitSubtree,
  supervisorIdentity,
  unitNameOf,
  unitPopulated,
  unitProcesses,
  type ProcessControl,
  type UnitControl,
} from './units.ts';

export interface StopManagerOptions {
  /** A client of its own: stop requests must not queue behind slow requests on a shared connection. */
  readonly ledger: SchedulerLedger;
  readonly cp: ControlPlane;
  readonly stopPaths: StopPaths;
  readonly stateDir: string;
  readonly processes: ProcessControl;
  readonly units: UnitControl;
  readonly alerts: Alerts;
  readonly takeover: Takeover;
  readonly now?: () => number;
  /** `systemctl stop` gets this long before everything left is SIGKILLed. */
  readonly stopTimeoutMs?: number;
  /** A process still present this long after SIGKILL "cannot be ended" (6.1: 60 s). */
  readonly unkillableAfterMs?: number;
}

interface UnitTrack {
  stopRequestedAt: number | null;
  killedAt: number | null;
  /** What the last readable source said about the unit (kept while the ledger cannot be read, r1 #3). */
  unitName?: string;
  disposition?: string | null;
  cleanupDone?: boolean;
}

interface StopRun {
  readonly stop: StopId;
  readonly scope: StopScope;
  committed: boolean;
  readonly units: Map<LaunchId, UnitTrack>;
  readonly intents: Map<string, { killedAt: number | null }>;
  lastState: StopReportState | null;
}

interface InScopeUnit {
  readonly launch: LaunchId;
  readonly unitName: string;
  readonly cleanup: 'pending' | 'done' | 'unknown';
  readonly disposition: string | null;
}

export class StopManager {
  private readonly o: StopManagerOptions;
  private readonly now: () => number;
  private readonly runs = new Map<StopId, StopRun>();
  private running: Promise<void> | null = null;
  private again = false;
  /** Set when the last drain failed: the ledger cannot commit stops now. */
  ledgerDown = false;

  constructor(o: StopManagerOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  /** One pass (coalesced: a call during a pass schedules exactly one more). */
  check(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  report(stop: StopId): StopReport | null {
    return this.o.cp.stopReport(stop);
  }

  /** Stops known to be in force, committed or (during a storage fault) only requested. */
  inForce(): Array<{ stop: StopId; scope: StopScope; committed: boolean }> {
    return [...this.runs.values()].map((r) => ({ stop: r.stop, scope: r.scope, committed: r.committed }));
  }

  /**
   * Whether a stop in force (committed, or requested while the ledger cannot commit) covers a tag.
   * The inbox and spool keep a request until the boot is processed, after the ledger committed
   * (and maybe released) it: a request the ledger already resolved is no longer in force by
   * itself (e2e B5); only the ledger's active stops are.
   */
  async covers(tag: ScopeTag): Promise<boolean> {
    for (const r of this.runs.values()) if (stopCovers(r.scope, tag)) return true;
    let readable = true;
    try {
      if ((await this.o.ledger.activeStops()).some((s) => stopCovers(s.scope, tag))) return true;
    } catch {
      readable = false; // the ledger cannot answer: every request below still counts
    }
    for (const r of readPendingStops(this.o.stopPaths)) {
      if (!stopCovers(r.scope, tag)) continue;
      if (!readable) return true;
      try {
        if ((await this.o.ledger.stopState(r.stop)) === null) return true; // not committed yet
      } catch {
        return true;
      }
    }
    return false;
  }

  private async pass(): Promise<void> {
    // 1. let the service commit what arrived (inbox + spool); stops go first in its queue
    try {
      await this.o.ledger.drainStops();
      this.ledgerDown = false;
    } catch (e) {
      if (!isTransient(e)) throw e;
      this.ledgerDown = true;
    }
    // 2. the stops in force
    let committed: Array<{ stop: StopId; scope: StopScope }> = [];
    let readable = true;
    try {
      committed = await this.o.ledger.activeStops();
    } catch {
      readable = false;
    }
    const committedIds = new Set(committed.map((s) => s.stop));
    const requested = readPendingStops(this.o.stopPaths).filter((r) => !committedIds.has(r.stop));
    for (const s of committed) this.ensure(s.stop, s.scope, true);
    for (const r of requested) {
      let isCommitted = false;
      try {
        isCommitted = readable && (await this.o.ledger.stopState(r.stop)) !== null;
      } catch {
        /* unreadable: not known to be committed */
      }
      // committed and no longer active: released; nothing to do
      if (isCommitted) {
        this.runs.delete(r.stop);
        continue;
      }
      this.ensure(r.stop, r.scope, false);
    }
    if (readable) {
      for (const [id, run] of this.runs) if (run.committed && !committedIds.has(id)) this.runs.delete(id);
    }
    // 3. act on each
    for (const run of this.runs.values()) await this.advance(run);
  }

  private ensure(stop: StopId, scope: StopScope, committed: boolean): void {
    const r = this.runs.get(stop);
    if (r) {
      r.committed = r.committed || committed;
      return;
    }
    this.runs.set(stop, { stop, scope, committed, units: new Map(), intents: new Map(), lastState: null });
  }

  /**
   * Units in scope that were still running or uncleaned when the stop came, and those already
   * tracked by it. `complete` is false when the ledger could not be read: the units already
   * tracked are kept (as last known) and the stop is never reported "stopped" on that basis
   * (r1 #3).
   */
  private async inScopeUnits(scope: StopScope, tracked: ReadonlyMap<LaunchId, UnitTrack>): Promise<{ units: InScopeUnit[]; complete: boolean }> {
    const out = new Map<LaunchId, InScopeUnit>();
    const add = (l: LaunchInfo): void => {
      out.set(l.launch, { launch: l.launch, unitName: this.o.takeover.meta(l.launch)?.unitName ?? unitNameOf(l.launch), cleanup: l.cleanup ?? 'unknown', disposition: l.disposition });
    };
    let complete = true;
    try {
      // not disposed, or not cleaned up: a unit finished before the stop is irrelevant to it
      for (const l of await this.o.ledger.launches({ scope, unfinished: true })) add(l);
      for (const launch of tracked.keys()) {
        if (out.has(launch)) continue;
        const l = (await this.o.ledger.launches({ launch }))[0];
        if (l !== undefined) add(l);
      }
    } catch {
      // the ledger cannot answer: the units already tracked stay, as last known; the host manifest below adds the rest
      complete = false;
      for (const [launch, t] of tracked) {
        if (out.has(launch)) continue;
        out.set(launch, { launch, unitName: t.unitName ?? this.o.takeover.meta(launch)?.unitName ?? unitNameOf(launch), cleanup: t.cleanupDone === true ? 'done' : 'unknown', disposition: t.disposition ?? null });
      }
    }
    for (const h of this.o.cp.hosts()) {
      if (!stopCovers(scope, h.tag) || out.has(h.launch)) continue;
      out.set(h.launch, { launch: h.launch, unitName: h.unitName, cleanup: 'unknown', disposition: null });
    }
    return { units: [...out.values()], complete };
  }

  private async processesEnded(u: InScopeUnit): Promise<{ ended: boolean; left: StopReportProcess[] }> {
    const left: StopReportProcess[] = [];
    const sup = supervisorIdentity(this.o.stateDir, u.launch);
    if (sup !== null && this.o.processes.alive(sup)) left.push({ launch: u.launch, intent: null, pid: sup.pid, what: 'unit supervisor', reason: 'still running' });
    const hb = hostHeartbeat(this.o.cp, u.launch);
    if (hb !== null && this.o.processes.alive(hb.identity)) left.push({ launch: u.launch, intent: null, pid: hb.identity.pid, what: 'host', reason: 'still running' });
    const cg = derivedUnitCgroupPath(u.unitName);
    if (unitPopulated(cg)) {
      for (const pid of unitProcesses(cg)) if (!left.some((p) => p.pid === pid)) left.push({ launch: u.launch, intent: null, pid, what: 'unit process', reason: 'still in the unit cgroup' });
    }
    const st = await this.o.units.activeState(u.unitName);
    const serviceGone = st === 'inactive' || st === 'failed';
    if (!serviceGone && left.length === 0 && sup === null) left.push({ launch: u.launch, intent: null, pid: 0, what: 'transient service', reason: `service ${u.unitName} is ${st}` });
    return { ended: left.length === 0 && (serviceGone || sup !== null), left };
  }

  private requestStop(run: StopRun, u: InScopeUnit, track: UnitTrack): void {
    track.stopRequestedAt = this.now();
    // 6.4: the stop ends this unit: stopped, not an environment failure (exec/stopcause.ts)
    recordEndedByStop(this.o.stateDir, u.launch, { by: 'scheduler', via: 'signal', stops: [run.stop], detail: `stop ${run.stop} covers the unit` });
    this.o.takeover.markEnded(u.launch, 'timed-out');
    // systemctl stop blocks until the unit has stopped: never awaited by the pass
    void this.o.units.stop(u.unitName, this.o.stopTimeoutMs ?? 30_000).catch(() => undefined);
    void run;
  }

  private async killNow(u: InScopeUnit, track: UnitTrack): Promise<void> {
    track.killedAt = this.now();
    killUnitSubtree(derivedUnitCgroupPath(u.unitName));
    const hb = hostHeartbeat(this.o.cp, u.launch);
    if (hb !== null) this.o.processes.kill(hb.identity, 'SIGKILL');
    const sup = supervisorIdentity(this.o.stateDir, u.launch);
    if (sup !== null) this.o.processes.kill(sup, 'SIGKILL');
    await this.o.units.kill(u.unitName).catch(() => undefined);
  }

  private async advance(run: StopRun): Promise<void> {
    const now = this.now();
    const stopTimeout = this.o.stopTimeoutMs ?? 30_000;
    const unkillableAfter = this.o.unkillableAfterMs ?? 60_000;
    const unitsReport: StopReportUnit[] = [];
    const unkillable: StopReportProcess[] = [];
    let allEnded = true;
    let allClean = true;

    const scoped = await this.inScopeUnits(run.scope, run.units);
    let complete = scoped.complete;
    for (const u of scoped.units) {
      const track = run.units.get(u.launch) ?? { stopRequestedAt: null, killedAt: null };
      run.units.set(u.launch, track);
      track.unitName = u.unitName;
      track.disposition = u.disposition;
      let { ended, left } = await this.processesEnded(u);
      if (!ended) {
        if (track.stopRequestedAt === null) this.requestStop(run, u, track);
        else if (track.killedAt === null && now - track.stopRequestedAt >= stopTimeout) await this.killNow(u, track);
        if (track.killedAt !== null && now - track.killedAt >= 1_000) {
          // kill again: cgroup.kill also reaches processes forked since
          killUnitSubtree(derivedUnitCgroupPath(u.unitName));
        }
        ({ ended, left } = await this.processesEnded(u));
      }
      if (!ended && track.killedAt !== null && now - track.killedAt >= unkillableAfter) {
        for (const p of left) unkillable.push({ ...p, reason: `${p.reason} ${Math.round((now - track.killedAt) / 1000)} s after SIGKILL` });
      }
      let cleanup = u.cleanup;
      if (cleanup !== 'done') {
        try {
          cleanup = (await this.o.ledger.cleanupState(u.launch)) ?? 'unknown';
        } catch {
          /* keep what the reader said */
        }
      }
      if (cleanup === 'done') track.cleanupDone = true;
      allEnded &&= ended;
      allClean &&= cleanup === 'done';
      unitsReport.push({ launch: u.launch, unitName: u.unitName, processesEnded: ended, cleanup, disposition: u.disposition });
    }

    // external actions authorized before the stop whose outcome is not settled
    const actions: StopReportIntent[] = [];
    let intents: OpenIntent[] = [];
    try {
      intents = (await this.o.ledger.openIntents()).filter((i) => stopCovers(run.scope, i.tag));
    } catch {
      // unreadable now: unknown, not "none" (r1 #3)
      complete = false;
    }
    for (const i of intents) {
      actions.push({
        intent: i.intent,
        kind: i.kind,
        domain: i.domain,
        state: i.state,
        note: 'started before the stop, outcome undetermined; the user is told the actual outcome once it is verified',
      });
      if (i.executor === null) continue;
      const exe = { pid: i.executor.pid, startTime: i.executor.startTime, bootId: i.executor.bootId };
      const it = run.intents.get(i.intent) ?? { killedAt: null };
      run.intents.set(i.intent, it);
      if (!this.o.processes.alive(exe)) continue;
      allEnded = false;
      if (it.killedAt === null) {
        it.killedAt = now;
        const k = this.o.processes.kill(exe, 'SIGKILL');
        if (k.error !== null) unkillable.push({ launch: i.launch, intent: i.intent, pid: exe.pid, what: `executor of ${i.kind} (${i.domain})`, reason: `SIGKILL refused: ${k.error}` });
      } else if (now - it.killedAt >= unkillableAfter) {
        unkillable.push({
          launch: i.launch,
          intent: i.intent,
          pid: exe.pid,
          what: `executor of ${i.kind} (${i.domain})`,
          reason: `still present ${Math.round((now - it.killedAt) / 1000)} s after SIGKILL (for example in uninterruptible disk I/O)`,
        });
      }
    }

    const dedup = new Map(unkillable.map((p) => [`${p.pid}:${p.intent ?? ''}:${p.launch ?? ''}`, p]));
    const unk = [...dedup.values()];
    let state: StopReportState;
    if (!run.committed) state = 'not-committed';
    else if (unk.length > 0) state = 'stop-effective-unkillable';
    // "stopped" only on a complete reading: every unit in scope ended and cleaned up, the intents known
    else if (allEnded && allClean && complete) state = 'stopped';
    else state = 'stopping';

    const summary =
      state === 'stopped'
        ? 'stopped'
        : state === 'stop-effective-unkillable'
          ? `stop effective, ${unk.length} process${unk.length === 1 ? '' : 'es'} cannot be ended`
          : state === 'not-committed'
            ? 'stop sent; the ledger has not committed it yet (storage fault); processes in scope are being ended'
            : complete
              ? 'stop effective; ending and cleaning up the units in scope'
              : 'stop effective; the ledger cannot be read now, so whether every unit in scope has ended and been cleaned up is not known yet';
    const report: StopReport = {
      format: 'mp4.stop-report.v1',
      stop: run.stop,
      state,
      summary: actions.length > 0 && state === 'stopped' ? `${summary}; ${actions.length} action(s) started before the stop, outcome undetermined` : summary,
      committed: run.committed,
      units: unitsReport,
      unkillable: unk,
      undeterminedActions: actions,
      at: now,
    };
    this.o.cp.putStopReport(report);
    if (state !== run.lastState && (state === 'stopped' || state === 'stop-effective-unkillable')) {
      await this.o.alerts.raise(
        state === 'stopped'
          ? { category: 'stop-report', wi: null, key: `${run.stop}:${state}:${unk.length}`, trigger: `stop ${run.stop}: every unit in scope ended and cleaned up`, detail: report }
          : {
              category: 'stop-unkillable',
              wi: 'WI-14',
              key: `${run.stop}:${state}:${unk.length}`,
              trigger: `stop ${run.stop}: ${unk.length} process(es) still present after SIGKILL`,
              defaultAction: 'the stop is in effect (nothing in scope is published or authorized); killing is retried; their resources stay counted; other work continues',
              detail: report,
            },
      );
    }
    run.lastState = state;
  }
}
