// Takeover, the proof reconciliation entry, and acceptance (design 6.3, 7.1).
//
// For every launch without a final disposition, on every pass and after every restart, the
// rules apply in order, first match wins (6.3: the ledger's facts first, then liveness):
//   1. a final disposition exists: nothing to dispose (cleanup still progresses, cleanup.ts);
//   2. a termination proof exists: adopt by proof, then acceptance: the stop and supersession
//      re-check, the three 7.1 checks with the host's records, and the one final disposition;
//   3. no proof, the host has exited, the supervisor lives: "proof pending" for a limited
//      time (10 minutes); past it, a system alert, the supervisor is killed, and the
//      reconciliation entry decides;
//   4. host and supervisor live, identities verified (pid, start time, boot id; the host in
//      the unit's control layer) and the heartbeat is fresh: the launch is adopted alive;
//   5. anything else: the remnants are killed, then the reconciliation entry decides.
//
// The reconciliation entry is the only path that disposes "failed, no proof":
//   1. confirm the supervisor no longer exists (only it writes proof files, so no proof can
//      appear afterwards); while it lives, kill it and wait;
//   2. query again, reusing nothing: a proof in the ledger, or a proof file in the state
//      directory (submitted on the supervisor's behalf); either goes to rule 2;
//   3. only then dispose "failed, no-proof"; the ledger re-checks atomically and refuses if a
//      proof was registered meanwhile (PROOF_EXISTS), which again goes to rule 2.
//
// Acceptance (7.1): eligible only if the host exited 0 (and its Claude Code process ended
// normally, for a seat unit), the control layer lost no process to an OOM, and every OOM kill
// in the unit is accounted for by the host's run-layer records. A unit whose own limit fired
// (oom > 0) is "resource exceeded" even when the three checks hold (v34). A result under a
// stop, of an unrecognized launch, or failing the checks is quarantined: recorded in the
// ledger as a pending result, never published.
//
// Before the acceptance, a continuation judgment among the pending results needs the
// evaluator's check at the latest published revision (5.2 part 5, continuation.ts). The
// ledger's normal branches on the way: BELOW_FLOOR (asked again), STALE_REQUEST (the pending
// results changed while verified: re-read next pass), CONTINUATION_REFUSED / RENEWAL_REFUSED
// (the attempt ends "failed" with that reason and the task goes to a full review / a new
// judgment; not an exception).

import type { Generation, LaunchId, StopId } from '../common/ids.ts';
import type { BaseRecord, TerminationProofRecord } from '../common/records.ts';
import { checkTerminationProof, type AcceptanceFailure } from '../exec/acceptance.ts';
import { resubmitProofFile, scanProofFiles, type ProofSink } from '../exec/proof.ts';
import { readEndedByStop } from '../exec/stopcause.ts';
import type { Disposition } from '../ledger/service.ts';
import { stopCovers, type ScopeTag } from '../ledger/stops.ts';
import type { Alerts } from './alerts.ts';
import type { AcceptGate } from './continuation.ts';
import type { ControlPlane } from './controlPlane.ts';
import { errorCode, type OpenLaunch, type SchedulerLedger } from './ledger.ts';
import { readLaunchMeta, type LaunchMeta } from './launches.ts';
import {
  derivedUnitCgroupPath,
  hostHeartbeat,
  inUnit,
  killUnitSubtree,
  supervisorIdentity,
  unitCgroupOfSupervisor,
  unitNameOf,
  unitPopulated,
  type Identity,
  type ProcessControl,
  type UnitControl,
} from './units.ts';

export type FailureKind =
  | 'environment-failure'
  | 'resource-exceeded'
  | 'no-proof'
  | 'result-invalid'
  | 'timed-out'
  | 'heartbeat-lost'
  /** 5.2 part 5: the evaluator refused a continuation judgment: a full review instead (a normal branch). */
  | 'continuation-refused'
  /** 5.3: a renewal among the results does not meet the renewal rule: a new judgment instead (a normal branch). */
  | 'renewal-refused';

export const FAILURE_KINDS: readonly FailureKind[] = [
  'environment-failure',
  'resource-exceeded',
  'no-proof',
  'result-invalid',
  'timed-out',
  'heartbeat-lost',
  'continuation-refused',
  'renewal-refused',
];

/**
 * The attempt outcome a final disposition stands for, from the disposition and the reason
 * this module gave it (`<failure>: <detail>`, `stopped:<stops>`, `no-proof`): a restarted
 * scheduler rebuilds its "needs disposition" and "exhausted" tasks from it.
 */
export function outcomeOfDisposition(launch: LaunchId, disposition: Disposition, reason: string | null): AttemptOutcome {
  const why = reason ?? '';
  if (disposition === 'accepted') return { kind: 'accepted', launch };
  if (disposition === 'cancelled') {
    if (why.startsWith('mission-closed:')) return { kind: 'cancelled', launch, stops: [], closedMission: why.slice('mission-closed:'.length) };
    const stops = why.startsWith('stopped:') ? (why.slice('stopped:'.length).split(',').filter((x) => x !== '') as StopId[]) : [];
    return { kind: 'cancelled', launch, stops };
  }
  if (why === 'no-proof') return { kind: 'failed', launch, failure: 'no-proof', detail: 'no termination proof', signature: 'no-proof' };
  const i = why.indexOf(': ');
  const head = i < 0 ? why : why.slice(0, i);
  const detail = i < 0 ? why : why.slice(i + 2);
  const failure: FailureKind = (FAILURE_KINDS as readonly string[]).includes(head) ? (head as FailureKind) : 'environment-failure';
  const checks = detail
    .split('; ')
    .map((p) => p.split(':')[0]!.trim())
    .filter((p) => p !== '');
  const signature =
    failure === 'result-invalid' || failure === 'continuation-refused' || failure === 'renewal-refused'
      ? `${failure}:${detail.split(':')[0]!.trim()}`
      : `${failure}:${checks.join('+')}`;
  return { kind: 'failed', launch, failure, detail, signature };
}

export type AttemptOutcome =
  | { readonly kind: 'accepted'; readonly launch: LaunchId }
  /** Quarantined: the result arrived under a stop (or, `closedMission`, after its mission closed, 6.6). */
  | {
      readonly kind: 'cancelled';
      readonly launch: LaunchId;
      readonly stops: readonly StopId[];
      readonly closedMission?: string;
      /** The unit was ended BY the stop (exec/stopcause.ts): stopped, nothing to quarantine, no notice. */
      readonly endedByStop?: boolean;
    }
  /** Quarantined (or no result at all, for no-proof). */
  | { readonly kind: 'failed'; readonly launch: LaunchId; readonly failure: FailureKind; readonly detail: string; readonly signature: string }
  /** Rule 1: a final disposition was already there. */
  | { readonly kind: 'already'; readonly launch: LaunchId; readonly disposition: Disposition };

export type ReconcileState =
  | { readonly kind: 'decided'; readonly outcome: AttemptOutcome }
  | { readonly kind: 'running'; readonly adopted: boolean }
  | { readonly kind: 'starting' }
  | { readonly kind: 'proof-pending'; readonly sinceMs: number }
  /** Something must happen first (supervisor to die, ledger to come back, user to confirm). */
  | { readonly kind: 'waiting'; readonly why: string }
  | { readonly kind: 'busy' };

export interface TakeoverOptions {
  readonly ledger: SchedulerLedger;
  readonly cp: ControlPlane;
  readonly stateDir: string;
  readonly processes: ProcessControl;
  readonly units: UnitControl;
  readonly alerts: Alerts;
  /** Submits proof files left in the state directory (src/exec/ledgerSink.ts). */
  readonly sink: ProofSink;
  readonly gen: () => Generation;
  /** Recovery pause (6.1): adoption and failures go on; acceptance waits for the user. */
  readonly paused: () => boolean;
  readonly now?: () => number;
  /** 6.3 rule 3: 10 minutes. */
  readonly proofPendingLimitMs?: number;
  /** A host heartbeat older than this is lost (6.2). */
  readonly heartbeatTimeoutMs?: number;
  /** A unit may take this long to write its identity and first heartbeat. */
  readonly startGraceMs?: number;
  /** After the unit's processes are killed, the supervisor gets this long to write its proof. */
  readonly proofGraceMs?: number;
  /** How long to wait for a killed supervisor to disappear before the next pass. */
  readonly killWaitMs?: number;
  /**
   * Right before an acceptance: the continuation checks of 5.2 part 5 (continuation.ts).
   * Absent: every acceptance goes ahead (the ledger refuses an unchecked continuation).
   */
  readonly beforeAccept?: (launch: LaunchId, records: readonly BaseRecord[]) => Promise<AcceptGate>;
  /** 6.6: the mission of a production launch is closed (and the close does not wait for running units): its result is cancelled. */
  readonly closedFor?: (launch: LaunchId, tag: ScopeTag) => string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function describeFailures(fs: readonly AcceptanceFailure[]): string {
  return fs
    .map((f) => {
      switch (f.check) {
        case 'normal-exit':
          return `normal-exit: ${f.detail}`;
        case 'control-oom-kill':
          return `control-oom-kill: ${f.controlOomKill}`;
        case 'oom-kills-accounted':
          return `oom-kills-accounted: unit ${f.unitOomKill} vs recorded ${f.recordedOomKill}`;
        case 'unit-oom':
          return `unit-oom: ${f.unitOom}`;
        case 'run-records':
          return `run-records: ${f.detail}`;
      }
    })
    .join('; ');
}

interface Liveness {
  readonly unitName: string;
  readonly sup: Identity | null;
  readonly supAlive: boolean;
  /** No identity file yet, the service is active: the supervisor is starting. */
  readonly supStarting: boolean;
  readonly host: Identity | null;
  readonly hostAlive: boolean;
  readonly hostVerified: boolean;
  readonly heartbeatAt: number | null;
  readonly unitCgroup: string;
}

export class Takeover {
  private readonly o: TakeoverOptions;
  private readonly now: () => number;
  private readonly inProgress = new Set<LaunchId>();
  private readonly firstSeen = new Map<LaunchId, number>();
  private readonly proofPendingSince = new Map<LaunchId, number>();
  private readonly lingeringSince = new Map<LaunchId, number>();
  /** Launches ended by the scheduler, and why (timeout, heartbeat loss): their failure is classified so. */
  private readonly endedBy = new Map<LaunchId, FailureKind>();

  constructor(o: TakeoverOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  private get proofPendingLimitMs(): number {
    return this.o.proofPendingLimitMs ?? 600_000;
  }

  meta(launch: LaunchId): LaunchMeta | null {
    return readLaunchMeta(this.o.stateDir, launch);
  }

  /** Confirmed by (pid, start time, boot id); without an identity file, by the service being inactive. */
  async supervisorGone(launch: LaunchId): Promise<boolean> {
    const sup = supervisorIdentity(this.o.stateDir, launch);
    if (sup !== null) return !this.o.processes.alive(sup);
    const st = await this.o.units.activeState(this.meta(launch)?.unitName ?? unitNameOf(launch));
    return st === 'inactive' || st === 'failed';
  }

  private async liveness(launch: LaunchId, meta: LaunchMeta | null): Promise<Liveness> {
    const unitName = meta?.unitName ?? unitNameOf(launch);
    const supId = supervisorIdentity(this.o.stateDir, launch);
    const sup = supId === null ? null : { pid: supId.pid, startTime: supId.startTime, bootId: supId.bootId };
    const supAlive = sup !== null && this.o.processes.alive(sup);
    let supStarting = false;
    if (sup === null) {
      const st = await this.o.units.activeState(unitName);
      supStarting = st === 'active' || st === 'activating' || st === 'reloading';
    }
    const unitCgroup = (sup !== null && supAlive ? unitCgroupOfSupervisor(sup) : null) ?? derivedUnitCgroupPath(unitName);
    const hb = hostHeartbeat(this.o.cp, launch);
    const populated = unitPopulated(unitCgroup);
    if (hb !== null) {
      const alive = this.o.processes.alive(hb.identity);
      return { unitName, sup, supAlive, supStarting, host: hb.identity, hostAlive: alive, hostVerified: alive && inUnit(hb.identity.pid, unitName), heartbeatAt: hb.at, unitCgroup };
    }
    return { unitName, sup, supAlive, supStarting, host: null, hostAlive: populated, hostVerified: populated, heartbeatAt: null, unitCgroup };
  }

  private async coveringStops(tag: ScopeTag): Promise<StopId[]> {
    return (await this.o.ledger.activeStops()).filter((s) => stopCovers(s.scope, tag)).map((s) => s.stop);
  }

  private recognizedHere(l: OpenLaunch): boolean {
    const gen = this.o.gen();
    return l.gen === gen || l.adoptedBy.includes(gen);
  }

  /** Apply rules 1-5 to one launch. Safe to call repeatedly; one call per launch at a time. */
  async reconcile(l: OpenLaunch): Promise<ReconcileState> {
    if (this.inProgress.has(l.launch)) return { kind: 'busy' };
    this.inProgress.add(l.launch);
    try {
      return await this.reconcileLocked(l);
    } finally {
      this.inProgress.delete(l.launch);
    }
  }

  private async reconcileLocked(l: OpenLaunch): Promise<ReconcileState> {
    // Rule 1
    const disp = await this.o.ledger.dispositionFor(l.launch);
    if (disp !== null) return this.decided({ kind: 'already', launch: l.launch, disposition: disp });
    // Rule 2
    const proof = await this.o.ledger.proofFor(l.launch);
    if (proof !== null) return this.byProof(l, proof);

    const meta = this.meta(l.launch);
    const live = await this.liveness(l.launch, meta);
    const now = this.now();
    const first = this.firstSeen.get(l.launch) ?? meta?.dispatchedAt ?? now;
    if (!this.firstSeen.has(l.launch)) this.firstSeen.set(l.launch, Math.min(first, now));
    const inStartGrace = now - (this.firstSeen.get(l.launch) ?? now) < (this.o.startGraceMs ?? 15_000);

    if (live.supStarting) {
      if (inStartGrace) return { kind: 'starting' };
      await this.killRemnants(l.launch, live, 'the supervisor never wrote its identity');
      return this.entry(l);
    }

    // Rule 3
    if (live.supAlive && !live.hostAlive) {
      const since = this.proofPendingSince.get(l.launch) ?? now;
      this.proofPendingSince.set(l.launch, since);
      if (now - since < this.proofPendingLimitMs) return { kind: 'proof-pending', sinceMs: now - since };
      await this.o.alerts.raise({
        category: 'proof-pending-timeout',
        wi: 'WI-14',
        key: l.launch,
        trigger: `the host of ${l.launch} exited ${Math.round((now - since) / 1000)} s ago; its supervisor did not deliver a termination proof (6.3 rule 3)`,
        defaultAction: 'the supervisor is killed; the reconciliation entry decides by the proof file if one exists, else "failed, no proof", retried within the env-retry cap',
        detail: { launch: l.launch, waitedMs: now - since, supervisor: live.sup, note: 'the host exited, the supervisor did not deliver a proof in time; killing it (6.3 rule 3)' },
      });
      return this.entry(l);
    }
    this.proofPendingSince.delete(l.launch);

    // Rule 4
    if (live.supAlive && live.hostAlive) {
      const needsBeat = meta?.heartbeat ?? true;
      const beatFresh = !needsBeat || (live.heartbeatAt !== null && now - live.heartbeatAt <= (this.o.heartbeatTimeoutMs ?? 30_000));
      if (live.hostVerified && beatFresh) {
        let adopted = false;
        if (!this.recognizedHere(l)) adopted = (await this.o.ledger.adopt(this.o.gen(), l.launch, 'alive')).adopted;
        const timeoutMs = meta?.timeoutMs ?? null;
        if (timeoutMs !== null && meta !== null && now - meta.dispatchedAt > timeoutMs && !this.endedBy.has(l.launch)) {
          // 6.2 "超时": end the unit's processes; the supervisor still writes the proof.
          this.endedBy.set(l.launch, 'timed-out');
          killUnitSubtree(live.unitCgroup);
        }
        return { kind: 'running', adopted };
      }
      if (inStartGrace && (live.heartbeatAt === null || !live.hostVerified)) return { kind: 'starting' };
      if (!beatFresh) this.endedBy.set(l.launch, 'heartbeat-lost');
    }

    // Rule 5
    await this.killRemnants(l.launch, live, live.supAlive ? 'unverifiable or heartbeat lost' : 'the supervisor is gone');
    return this.entry(l);
  }

  /**
   * End what is left of a unit: its processes first (cgroup.kill on the unit subtree, never
   * the supervisor's leaf), so a live supervisor can still write its proof; after a grace,
   * the supervisor and the service itself.
   */
  private async killRemnants(launch: LaunchId, live: Liveness, why: string): Promise<void> {
    killUnitSubtree(live.unitCgroup);
    if (live.host !== null) this.o.processes.kill(live.host, 'SIGKILL');
    if (live.sup !== null && live.supAlive) {
      const deadline = this.now() + (this.o.proofGraceMs ?? 5_000);
      while (this.now() < deadline && this.o.processes.alive(live.sup)) await sleep(50);
    }
    if (live.sup !== null && this.o.processes.alive(live.sup)) this.o.processes.kill(live.sup, 'SIGKILL');
    await this.o.units.kill(live.unitName).catch(() => undefined);
    void why;
  }

  /** The proof reconciliation entry (6.3). */
  async entry(l: OpenLaunch): Promise<ReconcileState> {
    // 1. the supervisor must no longer exist
    if (!(await this.supervisorGone(l.launch))) {
      const sup = supervisorIdentity(this.o.stateDir, l.launch);
      const unitName = this.meta(l.launch)?.unitName ?? unitNameOf(l.launch);
      if (sup !== null) this.o.processes.kill(sup, 'SIGKILL');
      await this.o.units.kill(unitName).catch(() => undefined);
      const deadline = this.now() + (this.o.killWaitMs ?? 10_000);
      while (this.now() < deadline && !(await this.supervisorGone(l.launch))) await sleep(50);
      if (!(await this.supervisorGone(l.launch))) {
        await this.o.alerts.raise({
          category: 'supervisor-unkillable',
          wi: 'WI-14',
          key: l.launch,
          trigger: `the supervisor of ${l.launch} is still present after SIGKILL`,
          defaultAction: 'the attempt stays undecided (no failure is committed while a proof could still appear); killing is retried; other work continues',
          detail: { launch: l.launch, supervisor: sup, note: 'killed, still present; the reconciliation entry waits (6.3 step 1)' },
        });
        return { kind: 'waiting', why: 'supervisor still exists' };
      }
    }
    // 2. query again, reusing nothing
    let proof = await this.o.ledger.proofFor(l.launch);
    if (proof === null) {
      const file = scanProofFiles(this.o.stateDir).pending.find((e) => e.file.proof.launch === l.launch);
      if (file !== undefined) {
        const out = await resubmitProofFile(file, this.o.sink);
        if (out.kind === 'rejected') {
          await this.o.alerts.raise({
            category: 'proof-rejected',
            wi: 'WI-20',
            key: `${l.launch}:${out.reason}`,
            trigger: `the ledger rejected the proof file of ${l.launch} deterministically (${out.reason})`,
            defaultAction: 'the file is marked rejected and kept for inspection; it is never resubmitted; the registered proof (if any) decides',
            detail: { launch: l.launch, reason: out.reason, detail: out.detail, path: file.path },
          });
        } else if (out.kind !== 'registered') {
          return { kind: 'waiting', why: `the proof file could not be submitted yet (${out.kind})` };
        }
        proof = await this.o.ledger.proofFor(l.launch);
      }
    }
    if (proof !== null) return this.byProof(l, proof);
    // 6.4: a unit the stop ended (and killed before its proof) is stopped, not a missing proof
    const byStop = readEndedByStop(this.o.stateDir, l.launch);
    if (byStop !== null) {
      const ids = byStop.stops as StopId[];
      return this.dispose(l, 'cancelled', `stopped:${ids.join(',')}`, { kind: 'cancelled', launch: l.launch, stops: ids, endedByStop: true });
    }
    // 3. only now: failed, no proof (re-checked atomically by the ledger)
    try {
      const r = await this.o.ledger.dispose(this.o.gen(), l.launch, 'failed', 'no-proof');
      if (!r.changed) return this.decided({ kind: 'already', launch: l.launch, disposition: r.disposition });
    } catch (e) {
      if (errorCode(e) === 'PROOF_EXISTS') {
        const p = await this.o.ledger.proofFor(l.launch);
        if (p !== null) return this.byProof(l, p);
      }
      throw e;
    }
    const ended = this.endedBy.get(l.launch);
    return this.decided({
      kind: 'failed',
      launch: l.launch,
      failure: 'no-proof',
      detail: ended ? `no termination proof (${ended})` : 'no termination proof',
      signature: 'no-proof',
    });
  }

  /** Rule 2: adopt by proof, then the stop and supersession re-check and the 7.1 acceptance. */
  private async byProof(l: OpenLaunch, proof: TerminationProofRecord): Promise<ReconcileState> {
    const existing = await this.o.ledger.dispositionFor(l.launch);
    if (existing !== null) return this.decided({ kind: 'already', launch: l.launch, disposition: existing });
    if (!this.recognizedHere(l)) await this.o.ledger.adopt(this.o.gen(), l.launch, 'proof');
    const stops = await this.coveringStops(l.tag);
    // 6.4: did a stop end this unit (its supervisor or host recorded it before the proof)?
    const byStop = readEndedByStop(this.o.stateDir, l.launch);
    if (stops.length > 0) return this.dispose(l, 'cancelled', `stopped:${stops.join(',')}`, { kind: 'cancelled', launch: l.launch, stops, ...(byStop !== null ? { endedByStop: true } : {}) });
    const closed = this.o.closedFor?.(l.launch, l.tag) ?? null;
    if (closed !== null) return this.dispose(l, 'cancelled', `mission-closed:${closed}`, { kind: 'cancelled', launch: l.launch, stops: [], closedMission: closed });
    if (this.o.paused()) return { kind: 'waiting', why: 'recovery pause: acceptance waits for the user to confirm resuming' };

    const meta = this.meta(l.launch);
    const records = await this.o.ledger.pendingResults(l.launch);
    // Unknown unit kind (its metadata is gone): treat it as a seat unit, the stricter check.
    const verdict = checkTerminationProof(proof, { seatUnit: meta?.seatUnit ?? true, records });
    const ended = this.endedBy.get(l.launch);
    if (byStop !== null && !verdict.eligible && proof.unitOom === 0) {
      // ended by a stop that no longer covers it (released, or never committed): stopped, not an
      // environment failure; nothing counts toward env-retry (an attempt the stop did not spoil is accepted below)
      const ids = byStop.stops as StopId[];
      return this.dispose(l, 'cancelled', `stopped:${ids.join(',')}`, { kind: 'cancelled', launch: l.launch, stops: ids, endedByStop: true });
    }
    if (!verdict.eligible || proof.unitOom > 0) {
      const outcome = proof.unitOom > 0 ? 'resource-exceeded' : verdict.eligible ? 'environment-failure' : verdict.outcome;
      const detail = verdict.eligible ? `unit-oom: ${proof.unitOom}` : describeFailures(verdict.failures);
      const failure: FailureKind = ended ?? outcome;
      const signature = `${failure}:${verdict.eligible ? 'unit-oom' : verdict.failures.map((f) => f.check).join('+')}`;
      return this.dispose(l, 'failed', `${failure}: ${detail}`, { kind: 'failed', launch: l.launch, failure, detail, signature });
    }
    // 5.2 part 5: a continuation is checked at the latest published revision first; a newer
    // publication between the check and the acceptance (BELOW_FLOOR) means checking again
    for (let round = 0; round < 3; round++) {
      const gate: AcceptGate = this.o.beforeAccept ? await this.o.beforeAccept(l.launch, records) : { kind: 'go' };
      if (gate.kind === 'wait' || gate.kind === 'ended') return { kind: 'waiting', why: gate.why };
      if (gate.kind === 'full-review') return this.refusedReview(l, 'continuation-refused', `${gate.judgment}: ${gate.reason}`);
      try {
        const r = await this.o.ledger.dispose(this.o.gen(), l.launch, 'accepted', 'accepted');
        if (!r.changed && r.disposition !== 'accepted') return this.decided({ kind: 'already', launch: l.launch, disposition: r.disposition });
        return this.decided({ kind: 'accepted', launch: l.launch });
      } catch (e) {
        const code = errorCode(e);
        if (code === 'BELOW_FLOOR') continue;
        if (code === 'STOPPED') {
          const s = await this.coveringStops(l.tag);
          return this.dispose(l, 'cancelled', `stopped:${s.join(',')}`, { kind: 'cancelled', launch: l.launch, stops: s });
        }
        if (code === 'RECOVERY_PAUSED') return { kind: 'waiting', why: 'recovery pause' };
        // a normal branch: the pending results changed while they were verified; re-read next pass
        if (code === 'STALE_REQUEST') return { kind: 'waiting', why: 'the pending results changed while they were verified; read again on the next pass' };
        if (code === 'CONTINUATION_REFUSED') return this.refusedReview(l, 'continuation-refused', (e as Error).message);
        if (code === 'RENEWAL_REFUSED') return this.refusedReview(l, 'renewal-refused', (e as Error).message);
        if (code === 'RECORD_INVALID' || code === 'CONTENT_MISSING' || code === 'FACT_CONFLICT' || code === 'KIND_NOT_ALLOWED' || code === 'TOO_LARGE' || code === 'SCOPE_MISMATCH') {
          // 6.1 review item 3: the result itself is wrong; refused like a stop, and quarantined.
          const detail = (e as Error).message;
          return this.dispose(l, 'failed', `result-invalid: ${detail}`, { kind: 'failed', launch: l.launch, failure: 'result-invalid', detail, signature: `result-invalid:${code}` });
        }
        throw e;
      }
    }
    return { kind: 'waiting', why: 'the published revision kept moving between the continuation check and the acceptance; checked again next pass' };
  }

  /**
   * 5.2 part 5 / 5.3, a normal branch: the review cannot stand as it is (a refused continuation,
   * a renewal that does not meet the rule): the attempt ends "failed" with that reason and its
   * task goes to a full review (or a new judgment). Not counted as an environment retry.
   */
  private refusedReview(l: OpenLaunch, failure: 'continuation-refused' | 'renewal-refused', detail: string): Promise<ReconcileState> {
    const code = failure === 'continuation-refused' ? 'CONTINUATION_REFUSED' : 'RENEWAL_REFUSED';
    const d = detail.startsWith(`${code}: `) ? detail : `${code}: ${detail}`;
    return this.dispose(l, 'failed', `${failure}: ${d}`, { kind: 'failed', launch: l.launch, failure, detail: d, signature: `${failure}:${code}` });
  }

  private async dispose(l: OpenLaunch, disposition: Disposition, reason: string, outcome: AttemptOutcome): Promise<ReconcileState> {
    const r = await this.o.ledger.dispose(this.o.gen(), l.launch, disposition, reason.slice(0, 1000));
    if (!r.changed && r.disposition !== disposition) return this.decided({ kind: 'already', launch: l.launch, disposition: r.disposition });
    return this.decided(outcome);
  }

  private decided(outcome: AttemptOutcome): ReconcileState {
    this.firstSeen.delete(outcome.launch);
    this.proofPendingSince.delete(outcome.launch);
    this.endedBy.delete(outcome.launch);
    return { kind: 'decided', outcome };
  }

  /**
   * A supervisor still present after its attempt has a final disposition and a registered
   * proof has nothing left to deliver; it should only be tearing down. Past the proof-pending
   * limit it is stuck: a system alert, then it is killed, so its cleanup can be finished
   * (v35: cleanup progresses whatever the disposition).
   */
  async lingering(launch: LaunchId): Promise<void> {
    if (this.inProgress.has(launch)) return;
    const sup = supervisorIdentity(this.o.stateDir, launch);
    if (sup === null || !this.o.processes.alive(sup)) return;
    if ((await this.o.ledger.dispositionFor(launch)) === null || (await this.o.ledger.proofFor(launch)) === null) {
      this.lingeringSince.delete(launch);
      return;
    }
    const now = this.now();
    const since = this.lingeringSince.get(launch) ?? now;
    this.lingeringSince.set(launch, since);
    if (now - since < this.proofPendingLimitMs) return;
    this.lingeringSince.delete(launch);
    await this.o.alerts.raise({
      category: 'supervisor-lingering',
      wi: 'WI-14',
      key: launch,
      trigger: `${launch} is disposed and its proof registered, but its supervisor is still running after ${Math.round((now - since) / 1000)} s`,
      defaultAction: 'the supervisor is killed so the cleanup can be finished by the scheduler',
      detail: { launch, supervisor: sup },
    });
    this.o.processes.kill(sup, 'SIGKILL');
    await this.o.units.kill(this.meta(launch)?.unitName ?? unitNameOf(launch)).catch(() => undefined);
  }

  /** The scheduler ended this launch for a reason (timeout, a stop...): classify its failure so. */
  markEnded(launch: LaunchId, why: FailureKind): void {
    this.endedBy.set(launch, why);
  }

  /**
   * Submit every proof file left in the state directory (7.1 step 3: at every reconciliation
   * and every start). Registration is idempotent; a deterministic rejection marks the file
   * and raises an alert.
   */
  async submitLeftProofs(): Promise<{ registered: LaunchId[]; rejected: LaunchId[] }> {
    const registered: LaunchId[] = [];
    const rejected: LaunchId[] = [];
    for (const e of scanProofFiles(this.o.stateDir).pending) {
      const out = await resubmitProofFile(e, this.o.sink);
      if (out.kind === 'registered') registered.push(e.file.proof.launch);
      else if (out.kind === 'rejected') {
        rejected.push(e.file.proof.launch);
        await this.o.alerts.raise({
          category: 'proof-rejected',
          wi: 'WI-20',
          key: `${e.file.proof.launch}:${out.reason}`,
          trigger: `the ledger rejected a proof file of ${e.file.proof.launch} deterministically (${out.reason})`,
          defaultAction: 'the file is marked rejected and kept for inspection; it is never resubmitted; the registered proof (if any) decides',
          detail: { launch: e.file.proof.launch, reason: out.reason, detail: out.detail, path: e.path, note: 'deterministic rejection (7.1 step 4): not retried' },
        });
      }
    }
    return { registered, rejected };
  }
}
