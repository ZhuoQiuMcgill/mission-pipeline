// A minimal task and lineage model, enough for the §14 verify-first scenarios: a queue of
// units with a work lineage, a priority and scheduling dependencies (design 4.1, 6.2, 6.5).
// The full task graph (Architect decomposition, Secretary decisions) is built elsewhere;
// this model only orders and tracks what the scheduler dispatches.
//
// States:
//   queued           waiting for its dependencies, admission, budget or a free slot
//   running          a launch is registered and its unit started (or starting)
//   waiting-evidence the seat handed back "needs evidence" (6.2 async): no reservation held
//   done             the last attempt was accepted
//   needs-disposition quarantined or failed beyond automatic handling: the Secretary decides
//                    (restart once more within the quarantine-restart cap, abandon, escalate)
//   exhausted        an automatic loop is exhausted (6.5): only a grant moves it again
//   budget-blocked   the mission is in budget block (6.5)
//   blocked          cannot be dispatched as it is (LFS objects missing, beyond the machine)
//   abandoned        the Secretary or the PM gave it up

import type { LoopKind } from '../common/records.ts';
import type { LaunchId, MissionId } from '../common/ids.ts';
import type { LayerLimits } from '../exec/cgroup.ts';
import type { HostCommand, SupervisorConfig } from '../exec/supervisor.ts';
import type { RetryPolicy } from '../exec/proof.ts';
import type { SeatTaskSpec } from './seats.ts';

export type TaskState =
  | 'queued'
  | 'running'
  | 'waiting-evidence'
  | 'done'
  | 'needs-disposition'
  | 'exhausted'
  | 'budget-blocked'
  | 'blocked'
  | 'abandoned';

/** How the unit runs (src/exec/supervisor.ts). */
export interface UnitSpec {
  readonly host: HostCommand;
  /** The unit's limits: memory.max is the card's declared peak. */
  readonly limits: LayerLimits;
  readonly cleanup?: SupervisorConfig['cleanup'];
  /** A seat unit's host records its Claude Code process's end (7.1 check 1). */
  readonly seatUnit: boolean;
  /** The host writes control-plane heartbeats (seat hosts do); takeover rule 4 then requires them. */
  readonly heartbeat: boolean;
  /** Overall deadline of the unit; past it the unit is ended ("超时"). */
  readonly timeoutMs?: number;
  readonly proofRetry?: Partial<RetryPolicy>;
  readonly stopGraceMs?: number;
  readonly orphanGraceMs?: number;
}

/** What a unit reserves for admission (6.5), over its whole life. */
export interface Demand {
  readonly memoryBytes: number;
  readonly diskBytes: number;
  readonly inodes: number;
}

export interface TaskSpec {
  readonly task: string;
  /** The work lineage: loop counts accumulate per lineage, across task ids and replacements (6.5). */
  readonly lineage: string;
  readonly mission: MissionId;
  /** Capabilities of the unit, matched against capability stops (6.4). */
  readonly capabilities: readonly string[];
  /** Higher first. */
  readonly priority: number;
  /** Tasks that must be done before this one is dispatched. */
  readonly dependsOn: readonly string[];
  /** A paid seat (6.5): its estimate is checked against the spend limit at dispatch. */
  readonly paid: boolean;
  readonly estimateMicros: number;
  readonly demand: Demand;
  readonly unit: UnitSpec;
  /** 6.2 routing after an accepted hand-back whose bases moved on: stable re-accepts, fast continues unproven. */
  readonly mode: 'stable' | 'fast';
  /** A commit whose snapshot the unit will see: its Git LFS objects must be local before dispatch (7.1 v34). */
  readonly snapshot?: { readonly repo: string; readonly commit: string };
  /**
   * A Secretary task (6.5 "Secretary 自己被调用的次数也计入它所处理的谱系"): it runs in the lineage it
   * handles, so its attempts, failures and retries count toward that lineage's loops, and every
   * invocation is a task.queued record of that lineage in the ledger.
   */
  readonly secretaryFor?: { readonly lineage: string };
  /**
   * A seat unit (6.2, 7.1): its card and its whole-life demand. Dispatched through the startup
   * self-check gate (WI-18), the area plan (WI-10) and the seat host (seats.ts); `demand` and
   * `unit.host` are then derived, not used.
   */
  readonly seat?: SeatTaskSpec;
  /** Objects the result will bind (for the 6.2 routing after acceptance). */
  readonly binds?: readonly string[];
  /** Path patterns the task may write (an exact path, "dir/**", or "**"): WI-03 overlap with external work. */
  readonly writeScope?: readonly string[];
  /**
   * A continuation review (5.2 part 5): the basis lines changed in this batch (including the
   * requirement-set line when items were added or removed), as the task's author planned the
   * continuation; the evaluator's check before the acceptance reads them. Default: none.
   */
  readonly changedLines?: readonly string[];
  /**
   * 6.6: work that may start after its mission is closed (a post-hoc audit, a delivery and its
   * conflict integration, a repair after an audit). Without it a task is production: closing the
   * mission cancels it (queued, and running unless the close waits for running units).
   */
  readonly afterClose?: 'audit' | 'delivery' | 'repair';
}

export interface TaskRecord {
  readonly spec: TaskSpec;
  state: TaskState;
  /** Why the task is in its state (waiting reason, exhaustion, quarantine...). */
  note: string | null;
  /** Launches of this task, oldest first. */
  readonly launches: LaunchId[];
  /** The launch currently running, if any. */
  current: LaunchId | null;
  /**
   * Why the task "needs disposition" (v42 WI-15): a stop (never restarted), a quarantine or a
   * seat failure (restart through the Secretary, counted together), resource overflow (more
   * resources or a smaller task, counted in the env-retry resource class). 'full-review': a
   * normal branch, not an exception: the evaluator refused a continuation (or a renewal did not
   * meet the rule) and the work needs a full review (a new judgment) instead (5.2 part 5, 5.3).
   */
  disposition: 'stop' | 'quarantine' | 'seat-failure' | 'resource-exceeded' | 'full-review' | null;
  /** The ledger's queue has this task as queued (4.1: the queue survives a scheduler restart); dispatch waits for it. */
  persisted: boolean;
  /** Insertion order, for FIFO among equal priorities. */
  readonly seq: number;
  attempts: number;
  /** The loop whose exhaustion stopped the task (6.5): a grant on that loop requeues it (r1 #8). */
  exhaustedBy?: LoopKind | null;
}

export class TaskQueue {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly byLaunch = new Map<LaunchId, string>();
  private seq = 0;

  add(spec: TaskSpec): TaskRecord {
    const existing = this.tasks.get(spec.task);
    if (existing) return existing;
    const rec: TaskRecord = { spec, state: 'queued', note: null, launches: [], current: null, disposition: null, persisted: false, seq: this.seq++, attempts: 0 };
    this.tasks.set(spec.task, rec);
    return rec;
  }

  get(task: string): TaskRecord | undefined {
    return this.tasks.get(task);
  }

  all(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  ofLaunch(launch: LaunchId): TaskRecord | undefined {
    const t = this.byLaunch.get(launch);
    return t === undefined ? undefined : this.tasks.get(t);
  }

  bindLaunch(task: TaskRecord, launch: LaunchId): void {
    task.launches.push(launch);
    task.current = launch;
    task.attempts++;
    this.byLaunch.set(launch, task.spec.task);
  }

  depsDone(t: TaskRecord): boolean {
    return t.spec.dependsOn.every((d) => this.tasks.get(d)?.state === 'done');
  }

  /** Dispatchable candidates: queued, dependencies done; by priority, then FIFO. */
  ready(): TaskRecord[] {
    return this.all()
      .filter((t) => t.state === 'queued' && this.depsDone(t))
      .sort((a, b) => b.spec.priority - a.spec.priority || a.seq - b.seq);
  }

  running(): TaskRecord[] {
    return this.all().filter((t) => t.state === 'running');
  }

  missions(): MissionId[] {
    return [...new Set(this.all().map((t) => t.spec.mission))];
  }
}
