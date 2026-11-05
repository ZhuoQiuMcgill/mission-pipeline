// Detached reruns (4.1.3, #30): a long experiment rerun does not depend on the seat's lifetime.
//
// `mp seat <id> rerun <command> --detach` starts the run in a worker process of its own: an `mp`
// process (`mp seat <id> rerun <command> --worker`, spawned detached, in its own process group and
// session) that executes the command and records the result exactly as a foreground rerun does: the
// same checkout under tmp/<run>/ with its owner lock, the same time limit, shell, cleanup commands
// and evidence. It records the run as running against the dispatch (the flow event "detached" on
// the dispatch line, keyed by the run id) before it reports back, so the seat gets the run id at once.
//
// A run's state is read from the dispatch line only (detachedState, the one resolver):
//   - finished: the dispatch line has the run's "run" event (what a foreground rerun records);
//   - stopped:  a "detached-end" event with outcome "stopped" (`mp pm stop`, or the worker was told to
//               stop); a stopped run records no result, and its result write is refused in its write;
//   - lost:     a "detached-end" event with outcome "lost": its worker is gone and recorded no result
//               (a machine restart, a killed process, a worker error). A result that still arrives
//               after it is recorded and counts (lost is a reader's inference, a result is a fact);
//   - running:  none of these.
// Whether the worker is alive is read from its pid and its start time as the operating system
// reports it (workerAlive), never from the pid alone, and only on the host it runs on: after a
// restart the boot id differs, and a reused pid has another start time. `mp pm next` and
// `mp seat <id> wait` record "lost" when they look and the worker is gone.
//
// A stop stops: `mp pm stop` sends SIGTERM to the process group of each detached run in its scope
// and records it as stopped; the worker then ends its command's process group (SIGTERM, then SIGKILL
// after a grace period), runs the cleanup commands and removes its checkout.
//
// A step dispatched again (its seat gone, the dispatch released) gets a card listing the runs its
// earlier dispatches made (stepRuns): the seat records from them and does not run them again; it waits
// on one still running with `mp seat <id> wait <run>`. mp never decides whether a seat is alive
// (seats are harness-neutral): `mp pm next` lists a run that ended for a dispatch still in flight, and
// the PM, who can see the harness, decides.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../common/hash.ts';
import type { ContentHash, EvidenceId, MissionId } from '../common/ids.ts';
import type { EvidenceRecord } from '../common/records.ts';
import { appendRecords, dispatchInfo, factById, flowEventExists, flowEvents, LedgerError, listDispatches, stopCovers, type Db, type DispatchInfo, type StopScope } from '../memory/index.ts';
import type { ProcessContext } from './context.ts';
import { ProcessError, type ProcessErrorCode } from './errors.ts';
import { DISPATCH_LINE, earlierDispatches } from './ports.ts';
import { runLeaf, signalGroup, summaryOf } from './runs.ts';

/** The flow event (dispatch line, key: the run id) of a detached run started: its worker, recorded by the worker. */
export const DETACHED_EVENT = 'detached';
/** The flow event (dispatch line, key: the run id) of a detached run that ended without a result: stopped or lost. */
export const DETACHED_END_EVENT = 'detached-end';

/** `mp seat <id> wait` waits this long by default: below common harness limits on one command (about 2 hours). */
export const WAIT_DEFAULT_SECONDS = 50 * 60;
/** The longest one `mp seat <id> wait` may wait. */
export const WAIT_MAX_SECONDS = 24 * 3600;
/** How often a wait looks at the run. */
export const WAIT_POLL_MS = 5_000;
/** How long `--detach` waits for its worker to record the run as running. */
export const WORKER_READY_MS = 120_000;

/** The "detached" event's body. */
export interface DetachedBody {
  readonly run: string;
  /** The evidence id the result is recorded under: what the seat cites (`evidence:<id>`, `run:<id>`). */
  readonly evidence: string;
  /** The command id on the card. */
  readonly command: string;
  readonly dispatch: string;
  readonly task: string;
  /** The worker's process id; it leads its own process group. */
  readonly pid: number;
  /** The worker's start time as the operating system reports it (processStart); null where it cannot be read. */
  readonly start: string | null;
  /** The machine the worker runs on: its liveness is read only there. */
  readonly host: string;
  readonly startedAt: number;
}

/** The "detached-end" event's body. */
export interface DetachedEndBody {
  readonly run: string;
  readonly outcome: 'stopped' | 'lost';
  readonly why: string;
  readonly at: number;
}

/** The "run" event's body on a dispatch line (seat.ts, fullRuns.ts); 4.1.3 adds the optional `tail`, `at` and `detached`. */
export interface RunEventBody {
  readonly run: string;
  readonly command: string;
  readonly completed: boolean;
  readonly exit: string;
  readonly envLine?: string;
  readonly envSnapshot?: string;
  /** The data hash of the last lines of its output (a rerun, 4.1.3 #37). */
  readonly tail?: string;
  /** When it was recorded (ms). */
  readonly at?: number;
  /** The detached run's id, when a worker recorded it. */
  readonly detached?: string;
}

/** A run made for a step, as a seat and the PM read it. */
export interface StepRun {
  /** The run id (`tmp/<run>/`, the leaf `runs/<run>.md`). */
  readonly run: string;
  /** The evidence id to cite. */
  readonly evidence: string;
  readonly command: string;
  /** The dispatch that started it. */
  readonly dispatch: string;
  readonly state: 'running' | 'finished' | 'stopped' | 'lost';
  readonly detached: DetachedBody | null;
  /** Finished: its result as a foreground rerun returns it. */
  readonly passed: boolean | null;
  readonly summary: string | null;
  readonly exit: string | null;
  readonly tail: string;
  readonly leaf: string | null;
  /** When it ended (ms), when known. */
  readonly at: number | null;
  /** Stopped or lost: why. */
  readonly why: string | null;
  /** Finished: its "run" event as recorded (what a hand-back may cite: ports.ts dispatchRuns), and that event's revision. */
  readonly ran: RunEventBody | null;
  readonly revision: number | null;
}

function body<B>(data: { text(h: string): string }, h: string): B {
  return JSON.parse(data.text(h)) as B;
}

/** Every event of one kind on a dispatch line, page by page (no cap: a run `wait` shows is always one a hand-back may cite). */
function lineEvents(db: Db, q: { readonly mission: MissionId; readonly line: string; readonly event: string }): Array<{ readonly revision: number; readonly key: string; readonly body: string }> {
  const out: Array<{ revision: number; key: string; body: string }> = [];
  for (let after = 0; ; ) {
    const page = flowEvents(db, { ...q, after, limit: 10_000 });
    out.push(...page.map((e) => ({ revision: Number(e.revision), key: e.key, body: e.body })));
    if (page.length < 10_000) return out;
    after = Number(page.at(-1)!.revision);
  }
}

/** The runs one dispatch had `mp` run or start (its line's "run" and "detached" events), in order. */
export function dispatchStepRuns(db: Db, data: { text(h: string): string }, d: Pick<DispatchInfo, 'mission' | 'dispatch'>, o: { readonly detachedOnly?: boolean } = {}): StepRun[] {
  const line = DISPATCH_LINE(d.dispatch);
  const mission = d.mission as MissionId;
  const ran = lineEvents(db, { mission, line, event: 'run' }).map((e) => ({ revision: e.revision, b: body<RunEventBody>(data, e.body) }));
  const ends = new Map(lineEvents(db, { mission, line, event: DETACHED_END_EVENT }).map((e) => [e.key, body<DetachedEndBody>(data, e.body)]));
  const started = lineEvents(db, { mission, line, event: DETACHED_EVENT }).map((e) => body<DetachedBody>(data, e.body));
  const byEvidence = new Map(ran.map((r) => [r.b.run, r]));
  const finished = ({ b: r, revision }: { readonly b: RunEventBody; readonly revision: number }, detached: DetachedBody | null): StepRun => {
    const rec = factById(db, 'evidence', r.run as EvidenceId)?.record as EvidenceRecord | undefined;
    const fields = rec?.fields ?? {};
    const runId = detached?.run ?? fields['run'] ?? r.run;
    return {
      run: runId,
      evidence: r.run,
      command: r.command,
      dispatch: d.dispatch,
      state: 'finished',
      detached,
      passed: fields['status'] !== undefined ? fields['status'] === 'completed' && fields['exit'] === '0' : r.completed && r.exit === '0',
      summary: rec !== undefined ? summaryOf(fields) : `${r.completed ? 'completed' : 'not completed'}; exit ${r.exit}`,
      exit: r.exit,
      tail: r.tail !== undefined ? data.text(r.tail) : '',
      leaf: fields['run'] !== undefined ? runLeaf(d.mission, fields['run']) : null,
      at: r.at ?? null,
      why: null,
      ran: r,
      revision,
    };
  };
  const out: StepRun[] = [];
  const seen = new Set<string>();
  for (const b of started) {
    seen.add(b.evidence);
    const r = byEvidence.get(b.evidence);
    if (r !== undefined) {
      out.push(finished(r, b));
      continue;
    }
    const end = ends.get(b.run);
    out.push({ run: b.run, evidence: b.evidence, command: b.command, dispatch: d.dispatch, state: end?.outcome ?? 'running', detached: b, passed: null, summary: null, exit: null, tail: '', leaf: null, at: end?.at ?? null, why: end?.why ?? null, ran: null, revision: null });
  }
  if (o.detachedOnly !== true) for (const r of ran) if (!seen.has(r.b.run)) out.push(finished(r, null));
  return out;
}

/**
 * The runs a dispatch's step has: those of the step's earlier dispatches that were released (a step
 * dispatched again carries them, 4.1.3 #30), then the dispatch's own. One resolver for the card of a
 * dispatch again, `mp seat <id> wait` and the runs a hand-back may cite (ports.ts dispatchRuns).
 */
export function stepRuns(db: Db, data: { text(h: string): string }, d: Pick<DispatchInfo, 'mission' | 'dispatch' | 'task'>): StepRun[] {
  return [...earlierDispatches(db, d).flatMap((x) => dispatchStepRuns(db, data, x)), ...dispatchStepRuns(db, data, d)];
}

/**
 * The detached runs a step's dispatches started that are still running (4.1.3): any dispatch of the
 * step, a released one too (its run goes on for the step). Read with dispatchStepRuns, the one resolver.
 * The repair entry counts each as a run a seat holds (explorationAttempts.ts).
 */
export function runningStepRuns(db: Db, data: { text(h: string): string }, d: Pick<DispatchInfo, 'mission' | 'task'>): StepRun[] {
  return listDispatches(db, { task: d.task, limit: 1000 })
    .filter((x) => x.mission === d.mission)
    .flatMap((x) => dispatchStepRuns(db, data, x, { detachedOnly: true }))
    .filter((r) => r.state === 'running');
}

/** Before a check that reads them: each running detached run of these steps whose worker is gone is recorded as lost (noticeLost). */
export function noticeLostRuns(ctx: ProcessContext, mission: MissionId, tasks: readonly string[]): void {
  if (tasks.length === 0) return;
  const data = ctx.memory.data;
  const runs = ctx.memory.read((db) => tasks.flatMap((task) => runningStepRuns(db, data, { mission, task })));
  for (const r of runs) noticeLost(ctx, r);
}

/** At most this many carried runs are listed on a card (the rest are named by count). */
const CARRIED_MAX = 50;

/**
 * The lines of a card dispatched again (pm.ts pmDispatch, at the claim; seat/card.ts renders them):
 * the runs the step's earlier dispatches made, each with its result, or "still running" with the
 * wait to use, or stopped or lost. Empty for a first dispatch.
 */
export function carriedRunLines(db: Db, data: { text(h: string): string }, d: Pick<DispatchInfo, 'mission' | 'dispatch' | 'task'>): string[] {
  const runs = earlierDispatches(db, d).flatMap((x) => dispatchStepRuns(db, data, x));
  const lines = runs.slice(-CARRIED_MAX).map((r) => {
    const head = `${r.run} (command ${r.command}, by ${r.dispatch})`;
    switch (r.state) {
      case 'finished':
        return `${head}: ${r.passed ? 'passed' : 'failed'} — ${r.summary ?? ''}. Cite it as evidence:${r.evidence} or run:${r.evidence}.`;
      case 'running':
        return `${head}: still running${r.detached !== null ? ` (since ${new Date(r.detached.startedAt).toISOString()})` : ''}; its result will be evidence ${r.evidence}. Wait for it: \`mp seat ${d.dispatch} wait ${r.run}\`.`;
      case 'stopped':
        return `${head}: stopped (${r.why ?? 'a stop'}); it has no result.`;
      case 'lost':
        return `${head}: lost (${r.why ?? LOST_WHY}); run the command again if you need its result.`;
    }
  });
  return runs.length > CARRIED_MAX ? [`(${runs.length - CARRIED_MAX} earlier runs are not listed)`, ...lines] : lines;
}

// ---------------------------------------------------------------- is the worker alive?

/**
 * The start of process `pid` as the operating system reports it, the guard against a reused pid
 * (with the boot id on Linux, so a restart changes it): null when no such process runs now;
 * "unknown" when it runs and its start cannot be read here (Windows: the pid alone).
 */
export function processStart(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux' && existsSync('/proc/self/stat')) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return null;
    }
    // the fields after the command name: state is field 3, starttime field 22
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    let boot = '';
    try {
      boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      /* the start time alone */
    }
    return `linux:${boot}:${fields[19] ?? ''}`;
  }
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return null;
  }
  return 'unknown';
}

/**
 * Whether a detached run's worker is alive: its pid runs with the start time recorded when it began
 * (a pid alone could be reused). Null: it runs on another machine, which this one cannot see.
 */
export function workerAlive(b: Pick<DetachedBody, 'pid' | 'start' | 'host'>): boolean | null {
  if (b.host !== hostname()) return null;
  const now = processStart(b.pid);
  if (now === null) return false;
  if (b.start === null || now === 'unknown' || b.start === 'unknown') return true;
  return now === b.start;
}

// ---------------------------------------------------------------- ends without a result

/**
 * Record a detached run as stopped or lost, unless it already ended: one write, checked in it (a
 * result recorded meanwhile wins over "lost"; a stop recorded first wins over a later result).
 * True when this call recorded it.
 */
export function recordDetachedEnd(ctx: ProcessContext, b: Pick<DetachedBody, 'run' | 'evidence' | 'dispatch'>, outcome: DetachedEndBody['outcome'], why: string): boolean {
  const info = ctx.memory.read((db) => dispatchInfo(db, b.dispatch));
  if (info === null) return false;
  const line = DISPATCH_LINE(b.dispatch);
  return ctx.memory.write({ op: `detached-end:${b.run}:${outcome}`, payload: { run: b.run, outcome } }, (tx) => {
    if (flowEventExists(tx, { mission: info.mission, line, event: DETACHED_END_EVENT, key: b.run })) return false;
    if (flowEventExists(tx, { mission: info.mission, line, event: 'run', key: b.evidence })) return false;
    const end: DetachedEndBody = { run: b.run, outcome, why: why.slice(0, 500), at: tx.at };
    appendRecords(tx, [{ kind: 'flow.event', mission: info.mission, line, event: DETACHED_END_EVENT, key: b.run, body: tx.data.put(canonicalJson(end)) as ContentHash }]);
    return true;
  });
}

/** Why a run is recorded as lost when its worker is gone. */
export const LOST_WHY = 'its worker is gone (the machine restarted, or the process was killed) and it recorded no result';

/**
 * A running detached run whose worker is gone is recorded as lost (`mp pm next`, `mp seat <id> wait`):
 * true when it was. Best effort: a write that fails now is tried on the next look.
 */
export function noticeLost(ctx: ProcessContext, r: StepRun): boolean {
  if (r.state !== 'running' || r.detached === null) return false;
  if (workerAlive(r.detached) !== false) return false;
  try {
    return recordDetachedEnd(ctx, r.detached, 'lost', LOST_WHY);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the PM's view and a stop

/** A detached run that ended for a dispatch still in flight (`mp pm next`). */
export interface DetachedRunNote {
  readonly run: string;
  readonly evidence: string;
  /** The dispatch in flight the PM would release. */
  readonly dispatch: string;
  /** The dispatch that started it (another, earlier one when the step was dispatched again). */
  readonly startedBy: string;
  readonly mission: MissionId;
  readonly task: string;
  readonly state: 'finished' | 'lost';
  readonly at: number | null;
  readonly exit: string | null;
  readonly text: string;
}

/**
 * `mp pm next` (4.1.3, #30): each detached run that ended for a dispatch still in flight (no
 * hand-back yet): its own runs, and the runs it carries that ended after it was claimed. A running
 * one whose worker is gone is recorded as lost first. mp cannot know whether the seat is alive, so
 * the note says what to do if it is gone.
 */
export function detachedRunNotes(ctx: ProcessContext): DetachedRunNote[] {
  const data = ctx.memory.data;
  const look = (): Array<{ d: DispatchInfo; runs: StepRun[] }> =>
    ctx.memory.read((db) =>
      listDispatches(db, { state: 'in-flight', limit: 10_000 }).flatMap((d) => {
        const lines = [...earlierDispatches(db, d), d];
        // the common path: no detached run on the step's dispatch lines, one indexed read each
        if (!lines.some((x) => flowEvents(db, { mission: x.mission, line: DISPATCH_LINE(x.dispatch), event: DETACHED_EVENT, limit: 1 }).length > 0)) return [];
        return [{ d, runs: lines.flatMap((x) => dispatchStepRuns(db, data, x, { detachedOnly: true })) }];
      }),
    );
  let flights = look();
  let lost = false;
  for (const f of flights) for (const r of f.runs) if (noticeLost(ctx, r)) lost = true;
  if (lost) flights = look();
  const out: DetachedRunNote[] = [];
  for (const { d, runs } of flights) {
    for (const r of runs) {
      if (r.state !== 'finished' && r.state !== 'lost') continue;
      // a carried run that ended before this dispatch was claimed is on its card already
      if (r.dispatch !== d.dispatch && (r.at === null || r.at <= d.createdAt)) continue;
      const when = r.at !== null ? ` at ${new Date(r.at).toISOString()}` : '';
      const of = r.dispatch === d.dispatch ? `of dispatch ${d.dispatch}` : `(started by ${r.dispatch}) for dispatch ${d.dispatch}`;
      const text =
        r.state === 'finished'
          ? `run ${r.run} ${of} finished${when} (exit ${r.exit ?? 'none'}). If its seat is gone, release ${d.dispatch} and dispatch it again; the new card carries ${r.run}.`
          : `run ${r.run} ${of} was lost${when}: ${r.why ?? LOST_WHY}. If its seat is gone, release ${d.dispatch} and dispatch it again; the step can run it again.`;
      out.push({ run: r.run, evidence: r.evidence, dispatch: d.dispatch, startedBy: r.dispatch, mission: d.mission, task: d.task, state: r.state, at: r.at, exit: r.exit, text });
    }
  }
  return out;
}

/**
 * `mp pm stop` (4.1.3, #30: a stop stops): every detached run still running in the stop's scope is
 * signalled (SIGTERM to its worker's process group; the worker ends its command's group, cleans up and
 * exits) and recorded as stopped. A worker that is gone is recorded as lost instead. Returns the runs.
 */
export function stopDetachedRuns(ctx: ProcessContext, scope: StopScope, stop: string): Array<{ readonly run: string; readonly dispatch: string; readonly outcome: 'stopped' | 'lost' }> {
  const data = ctx.memory.data;
  const running = ctx.memory.read((db) => {
    const out: Array<{ r: StepRun; d: DispatchInfo }> = [];
    // the dispatches that started a detached run (whatever their state: a released one's run goes on for the step)
    const lines = db.stmt('SELECT DISTINCT line FROM flow_events WHERE event = ?').all(DETACHED_EVENT) as Array<{ line: string }>;
    for (const { line } of lines) {
      const d = line.startsWith('dispatch:') ? dispatchInfo(db, line.slice('dispatch:'.length)) : null;
      if (d === null || !stopCovers(scope, d.tag)) continue;
      for (const r of dispatchStepRuns(db, data, d, { detachedOnly: true })) if (r.state === 'running' && r.detached !== null) out.push({ r, d });
    }
    return out;
  });
  const done: Array<{ run: string; dispatch: string; outcome: 'stopped' | 'lost' }> = [];
  for (const { r, d } of running) {
    const b = r.detached!;
    const alive = workerAlive(b);
    // signalled only while it is the worker (its pid with its start time): a reused pid is never signalled
    if (alive === true) signalGroup(b.pid, 'SIGTERM');
    const outcome = alive === false ? 'lost' : 'stopped';
    try {
      if (recordDetachedEnd(ctx, b, outcome, outcome === 'lost' ? LOST_WHY : `stop ${stop}${alive === null ? ` (its worker runs on ${b.host}: it sees the stop when it records)` : ''}`)) done.push({ run: b.run, dispatch: d.dispatch, outcome });
    } catch {
      /* the stop is recorded; the worker sees it when it records, and refuses its result */
    }
  }
  return done;
}

// ---------------------------------------------------------------- the worker

/**
 * The Node flags an `mp` process runs with: this process's own (it runs the same TypeScript, with type
 * stripping by a flag or by default; bin/mp.mjs decides), so the worker starts as this process did.
 */
function nodeFlags(): string[] {
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  const flags = process.execArgv.filter((a) => /^--(experimental-strip-types|experimental-transform-types|experimental-sqlite|disable-warning(=|$)|no-warnings)/.test(a));
  if (major === 22 && minor < 13 && !flags.includes('--experimental-sqlite')) flags.push('--experimental-sqlite');
  if (!flags.some((a) => a.startsWith('--disable-warning'))) flags.push('--disable-warning=ExperimentalWarning');
  return flags;
}

/** What a worker reports once it recorded the run as running. */
export interface WorkerStarted {
  readonly run: string;
  readonly evidence: string;
  readonly pid: number;
}

/** Starts the worker of a detached rerun and waits until it recorded the run as running (tests replace it). */
export type DetachSpawner = (ctx: ProcessContext, req: { readonly dispatch: string; readonly command: string }) => Promise<WorkerStarted>;

/** The worker's messages to the `mp` process that started it (over the IPC channel). */
export type WorkerMessage = ({ readonly kind: 'ready' } & WorkerStarted) | { readonly kind: 'error'; readonly ledger: boolean; readonly code: string; readonly message: string };

/** A worker's refusal before it started the run, as the error the seat's command reports (the same code). */
export function workerError(m: Extract<WorkerMessage, { kind: 'error' }>): Error {
  return m.ledger ? new LedgerError(m.code as never, m.message) : new ProcessError(m.code as ProcessErrorCode, m.message);
}

/**
 * The default spawner: `mp seat <dispatch> rerun <command> --worker` as a detached Node process (its
 * own session and process group, no terminal, output discarded), which outlives this `mp` process.
 * It answers over IPC once the run is recorded as running; then this process lets it go.
 */
export const spawnRerunWorker: DetachSpawner = (ctx, req) => {
  const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
  const child = spawn(process.execPath, [...nodeFlags(), main, 'seat', req.dispatch, 'rerun', req.command, '--worker', '--project', ctx.projectDir], {
    cwd: ctx.projectDir,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: process.env,
    windowsHide: true,
  });
  return new Promise<WorkerStarted>((resolve, reject) => {
    let settled = false;
    const done = (f: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.connected) child.disconnect();
      } catch {
        /* the channel is gone already */
      }
      child.unref();
      f();
    };
    const timer = setTimeout(() => {
      if (child.pid !== undefined) signalGroup(child.pid, 'SIGKILL');
      done(() => reject(new ProcessError('NOT_ALLOWED', `the run's worker did not start within ${WORKER_READY_MS / 1000} s: nothing ran; run the command again (or without --detach)`)));
    }, WORKER_READY_MS);
    child.on('message', (m: WorkerMessage) => {
      if (m?.kind === 'ready') done(() => resolve({ run: m.run, evidence: m.evidence, pid: m.pid }));
      else if (m?.kind === 'error') done(() => reject(workerError(m)));
    });
    child.on('error', (e) => done(() => reject(new ProcessError('NOT_ALLOWED', `the run's worker could not start (${e.message}): nothing ran`))));
    child.on('exit', (code, signal) => done(() => reject(new ProcessError('NOT_ALLOWED', `the run's worker ended before it started the run (${signal ?? `exit ${code}`}): nothing ran`))));
  });
};
