// Acceptance of an execution unit's attempt from its termination proof (design 7.1), and
// classification of one run layer's end. Pure functions: the scheduler applies them to
// facts read from the ledger (the proof, and the host's pending results under the launch);
// nothing here touches the system.
//
// Two counters answer two different questions (7.1, rounds 19 and 20):
//  - did a layer's OWN limit fire?       its memory.events.local "oom";
//  - was any process of a layer killed?  its hierarchical memory.events "oom_kill",
//    whatever the trigger (its own limit, an ancestor's, or the whole machine).

import type { LaunchId } from '../common/ids.ts';
import type { BaseRecord, ClaudeCodeExitRecord, RunLayerRecord, SeatResultRecord, TerminationProofRecord } from '../common/records.ts';

export type { RunId } from '../common/ids.ts';
export type { ClaudeCodeExitRecord, RunLayerRecord, RunStatus } from '../common/records.ts';

export type ExitStatus = TerminationProofRecord['exit'];

export type RunLayerOutcome = 'completed' | 'resource-exceeded' | 'environment-failure';

export interface LayerOomDelta {
  /** Change of the layer's own memory.events.local "oom" over the run. */
  readonly oom: number;
  /** Change of the layer's hierarchical memory.events "oom_kill" over the run. */
  readonly oomKill: number;
}

/**
 * 7.1 "运行层被结束时，宿主怎样告诉席位":
 *  - own oom > 0: the run went over its declared peak: "resource exceeded";
 *  - own oom 0 but oom_kill > 0: it was hit by an ancestor's or the machine's shortage:
 *    "environment failure", not the seat's fault.
 */
export function classifyRunLayer(d: LayerOomDelta): RunLayerOutcome {
  if (d.oom > 0) return 'resource-exceeded';
  if (d.oomKill > 0) return 'environment-failure';
  return 'completed';
}

/** What the host recorded about the processes it ran, as the acceptance check needs it (7.1 checks 1 and 3). */
export interface HostRecords {
  /** A seat unit runs a Claude Code process whose end the host must record; a verification run or git unit does not. */
  readonly seatUnit: boolean;
  /** The host's pending results under the launch (anything else in them is ignored here). */
  readonly records: readonly BaseRecord[];
}

export type AttemptFailure = 'resource-exceeded' | 'environment-failure';

export type AcceptanceFailure =
  | { readonly check: 'normal-exit'; readonly detail: string }
  | { readonly check: 'control-oom-kill'; readonly controlOomKill: number }
  | { readonly check: 'oom-kills-accounted'; readonly unitOomKill: number; readonly recordedOomKill: number }
  | { readonly check: 'unit-oom'; readonly unitOom: number }
  | { readonly check: 'run-records'; readonly detail: string };

export type AcceptanceVerdict =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly outcome: AttemptFailure; readonly failures: readonly AcceptanceFailure[] };

export function isNormalExit(e: ExitStatus): boolean {
  return e.code === 0 && e.signal === null;
}

export function describeExit(e: ExitStatus): string {
  if (e.signal !== null) return `killed by ${e.signal}`;
  if (e.code !== null) return `exited with ${e.code}`;
  return 'never started';
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Sum of the final oom_kill deltas the host recorded for this launch's run layers. Each run
 * counts once; a run recorded twice with different contents, a record of another launch or
 * a malformed count is a problem (the attempt cannot be accounted for, so it is not accepted).
 */
export function recordedOomKills(
  launch: LaunchId,
  records: readonly BaseRecord[],
): { readonly sum: number; readonly problems: readonly string[] } {
  const byRun = new Map<string, RunLayerRecord>();
  const problems: string[] = [];
  for (const rec of records) {
    if (rec.kind !== 'run.layer') continue;
    const r = rec;
    if (r.launch !== launch) {
      problems.push(`run ${r.run} is recorded for launch ${r.launch}, not ${launch}`);
      continue;
    }
    if (!isCount(r.oomKillDelta) || !isCount(r.finalOomKill) || !isCount(r.oomDelta) || !isCount(r.finalOom)) {
      problems.push(`run ${r.run} has malformed counters`);
      continue;
    }
    const prev = byRun.get(r.run);
    if (prev === undefined) {
      byRun.set(r.run, r);
    } else if (
      prev.oomKillDelta !== r.oomKillDelta ||
      prev.finalOomKill !== r.finalOomKill ||
      prev.oomDelta !== r.oomDelta ||
      prev.finalOom !== r.finalOom ||
      prev.status !== r.status
    ) {
      problems.push(`run ${r.run} is recorded twice with different contents`);
    }
  }
  let sum = 0;
  for (const r of byRun.values()) sum += r.oomKillDelta;
  return { sum, problems };
}

/** The one recorded end of the seat's Claude Code process, or why there is none. */
export function claudeCodeExit(
  launch: LaunchId,
  records: readonly BaseRecord[],
): { readonly exit: ExitStatus } | { readonly problem: string } {
  const own = records.filter((r): r is ClaudeCodeExitRecord => r.kind === 'claude-code.exit' && r.launch === launch);
  if (own.length === 0) return { problem: 'the host recorded no exit of its Claude Code process' };
  const first = own[0] as ClaudeCodeExitRecord;
  if (own.some((r) => r.exit.code !== first.exit.code || r.exit.signal !== first.exit.signal)) {
    return { problem: 'the host recorded different exits of its Claude Code process' };
  }
  return { exit: first.exit };
}

/**
 * The host reported that it never started the seat for want of resources (its writable area
 * cannot be had or does not fit, 7.1, WI-10): a seat.result "resource-exceeded" with nothing
 * in it, and no Claude Code exit, since no Claude Code process ever ran. The Claude Code half of
 * check 1 then has nothing to check (code review M2: it was reported as "normal-exit: the host
 * recorded no exit" and retried as an environment failure); the host's own exit is still checked.
 */
export function seatNeverStarted(launch: LaunchId, records: readonly BaseRecord[]): boolean {
  if (records.some((r) => r.kind === 'claude-code.exit' && r.launch === launch)) return false;
  const results = records.filter((r): r is SeatResultRecord => r.kind === 'seat.result' && r.launch === launch);
  if (results.length !== 1) return false;
  const r = results[0] as SeatResultRecord;
  return r.status === 'resource-exceeded' && r.result === null && r.export === null && r.transcript === null && r.recoveryState === null && r.evidenceRequest === null;
}

/**
 * 7.1: the scheduler grants eligibility for acceptance only if all three hold:
 *  1. normal end: the host exited 0, and the Claude Code process it recorded ended normally;
 *  2. the control layer lost no process to an OOM: control oom_kill = 0;
 *  3. every OOM kill in the unit is accounted for: unit oom_kill equals the sum of the
 *     final oom_kill deltas the host recorded for its run layers.
 * Otherwise the attempt is an environment failure, or "resource exceeded" when the unit's
 * own limit fired (unit oom > 0). v34: even with all three met, a unit whose own limit fired
 * (oom > 0, nothing killed) is not accepted either: "resource exceeded" (it ran under memory
 * pressure; handled conservatively).
 */
export function checkTerminationProof(proof: TerminationProofRecord, host: HostRecords): AcceptanceVerdict {
  const failures: AcceptanceFailure[] = [];

  if (!isNormalExit(proof.exit)) failures.push({ check: 'normal-exit', detail: `host ${describeExit(proof.exit)}` });
  if (host.seatUnit && !seatNeverStarted(proof.launch, host.records)) {
    const cc = claudeCodeExit(proof.launch, host.records);
    if ('problem' in cc) failures.push({ check: 'normal-exit', detail: cc.problem });
    else if (!isNormalExit(cc.exit)) failures.push({ check: 'normal-exit', detail: `Claude Code ${describeExit(cc.exit)}` });
  }

  if (proof.controlOomKill !== 0) failures.push({ check: 'control-oom-kill', controlOomKill: proof.controlOomKill });

  const { sum, problems } = recordedOomKills(proof.launch, host.records);
  for (const detail of problems) failures.push({ check: 'run-records', detail });
  if (proof.unitOomKill !== sum) {
    failures.push({ check: 'oom-kills-accounted', unitOomKill: proof.unitOomKill, recordedOomKill: sum });
  }

  if (proof.unitOom > 0) failures.push({ check: 'unit-oom', unitOom: proof.unitOom });

  if (failures.length === 0) return { eligible: true };
  return { eligible: false, outcome: proof.unitOom > 0 ? 'resource-exceeded' : 'environment-failure', failures };
}
