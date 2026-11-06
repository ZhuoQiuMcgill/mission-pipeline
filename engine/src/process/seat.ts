// The seat commands (design 4.1 §5.2, §5.3, §5.4; decisions 6, 7, 10, 11, 13, 14, 17):
// `mp seat <dispatch> card | read | checkout | rerun | request-evidence | handback`. A seat
// works with its harness's own tools and these commands only; the dispatch id ties every call to
// its task (bookkeeping, not an anti-forgery measure, §5.3).
//
//   card              the card leaf as the seat received it (hash-checked)
//   read              one page of a material: its leaf, hash-checked (a missing or edited leaf is
//                     reported, never served); the page read is recorded (must-read tracking)
//   checkout          the commit the card names, in the read-only checkout that the seats reading
//                     that commit share, tmp/checkouts/<commit>/ (4.1.2: held by this dispatch while
//                     it is in flight; removed when its last holder is over, housekeeping.ts)
//   rerun             a declared command of the card on a clean checkout: a sampling run with a
//                     new run id every time (§6.5, scenario 13)
//   request-evidence  a hand-back that asks for evidence (decision 13): it ends the dispatch with
//                     the seat's notes; the continuation is a new card with them and the results
//   handback          the report and the structured fields (decision 7), both files in
//                     tmp/<dispatch>/: checked against the role's rules (a refused hand-back does
//                     not count and keeps the worktree; the seat fixes it and runs it again,
//                     decision 14), the report filed as the leaf dispatches/<d>/report.md, the
//                     records appended in the same write, then the process advanced. Once it is
//                     recorded, tmp/<dispatch>/ is removed and the dispatch's checkout holds end.
//   full-run          (an integration task's Reviewer, when the project declares a full suite) the
//                     full suite on a clean checkout of the candidate, last, once nothing visible is
//                     wrong (4.1.2, D-5, D-6; fullRuns.ts); its runs become citable by the dispatch
// A Constructor's hand-back first collects its candidate from its worktree (A4, decision 17),
// then `mp` runs the card's verification commands on a clean checkout of the candidate (§5.3)
// and removes the worktree once the hand-back is accepted. Those runs are recorded as the flow's
// "verified" event of that attempt in the same process (4.1.2: the flow reads it and never runs
// them again); the first writer of that event wins, the other adopts it.

import { requireSecretary } from '../memory/resident.ts';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, sha256 } from '../common/hash.ts';
import type { ContentHash, MissionId } from '../common/ids.ts';
import { idPart } from '../common/ids.ts';
import type { BaseRecord, EvidenceRecord } from '../common/records.ts';
import type { Collection } from '../git/workspace.ts';
import { continuationCheck, sampleRunId, type ContinuationRequest } from '../evaluator/index.ts';
import {
  appendRecords,
  assertNotStopped,
  recordContinuationCheck,
  dispatchInfo,
  dispatchLeaf,
  flowEventExists,
  flowEvents,
  LedgerError,
  recordHandback,
  releaseDispatch,
  stoppedFor,
  type Db,
  type DispatchHandbackOutcome,
  type DispatchInfo,
  type Filler,
  type WriteTx,
} from '../memory/index.ts';
import { supersededRecheck, type PmBatchBody, type RecheckBody } from '../flow/planning.ts';
import { SECRETARY_LINE } from '../flow/plandoc.ts';
import { EvidenceRequestSchema, isIntegrationCard, rerunCommands, rerunnableCommands, seatCommandsOf } from '../seat/card.ts';
import { isFullSuiteCommand } from '../common/fullSuite.ts';
import type { ReviewerCard } from '../seat/card.ts';
import { materialPage, unreadMustRead, type MaterialRef } from '../seat/cards/common.ts';
import { handBackDataTexts, handBackProblems, handBackRecords, seatCardEntry } from '../seat/cards/index.ts';
import { dataPaths, recordedData, type DataChecks, type RecordedData } from '../seat/cards/experiment.ts';
import { checkDataFiles } from '../common/dataFile.ts';
import { explorationCardAtHandBack } from './explorationSnapshot.ts';
import { citedEvidence, findingRecords, judgmentRecord, type ReviewerResult, type SnapshotFiles } from '../seat/results.ts';
import type { AcceptedHandBack, VerificationRun } from '../flow/ports.ts';
import { productObjectId, verificationStopped } from './actions.ts';
import type { ProcessContext } from './context.ts';
import { ProcessError } from './errors.ts';
import { DISPATCH_LINE, TASKS_LINE, dispatchReads, dispatchRuns, handbackDoc, type HandbackDoc, type TaskSpecDoc } from './ports.ts';
import { groupShellRunner, newRunId, normalizeCwd, RERUN_TAIL, runOnCommit, shellRunner, type RecordedRun } from './runs.ts';
import { DETACHED_END_EVENT, DETACHED_EVENT, noticeLost, processStart, recordDetachedEnd, spawnRerunWorker, stepRuns, WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS, WAIT_POLL_MS, type DetachedBody, type DetachedEndBody, type DetachSpawner, type RunEventBody, type StepRun, type WorkerStarted } from './detached.ts';
import { foldExploration } from '../flow/exploration/predecessors.ts';
import { requestExecutor } from '../flow/exploration/cards.ts';
import { explorationLine } from '../flow/plandoc.ts';
import { passingFullRunEvidence, runFullSuite, suiteHash, treeOf, type FullRunMarker } from './fullRuns.ts';
import { tagScope } from '../delivery/scope.ts';
import { pathOwners } from '../flow/execution.ts';
import { flowCtx } from '../flow/context.ts';
import { advance } from './advance.ts';
import { lateForClose, takeBackForClose } from './close.ts';
import { dispatchOver, holdSharedCheckout } from './housekeeping.ts';

// ---------------------------------------------------------------- the dispatch's card and materials

/** A dispatch with the task spec it claimed (recorded at dispatch). */
export interface DispatchView {
  readonly info: DispatchInfo;
  readonly spec: TaskSpecDoc;
  /** The card's fields (the spec's card). */
  readonly card: { readonly seat: string } & Readonly<Record<string, unknown>>;
}

export function dispatchView(ctx: ProcessContext, dispatch: string): DispatchView {
  const data = ctx.memory.data;
  return ctx.memory.read((db) => {
    const info = dispatchInfo(db, dispatch);
    if (info === null) throw new LedgerError('UNKNOWN_DISPATCH', `no dispatch ${dispatch}`);
    const claimed = flowEvents(db, { mission: info.mission, line: DISPATCH_LINE(dispatch), event: 'claimed' })[0];
    if (claimed === undefined) throw new LedgerError('UNKNOWN_DISPATCH', `dispatch ${dispatch} has no recorded task spec (it was not claimed with mp pm dispatch)`);
    const body = JSON.parse(data.text(claimed.body)) as { spec: string };
    const spec = JSON.parse(data.text(body.spec)) as TaskSpecDoc;
    return { info, spec, card: spec.card };
  });
}

/** The leaf a material's text is written to when its card is dispatched (content-addressed: one leaf per text). */
export function materialLeaf(mission: string, ref: string): string {
  return `missions/${mission}/materials/${ref}.md`;
}

/** `mp seat <id> card`: the card as the seat received it, hash-checked (§5.2, §3.3). */
export function seatCard(ctx: ProcessContext, dispatch: string): { readonly dispatch: string; readonly text: string; readonly leaf: string } {
  const v = dispatchView(ctx, dispatch);
  const leaf = v.info.cardLeaf ?? dispatchLeaf(v.info.mission, dispatch, 'card');
  const r = ctx.memory.readLeaf(leaf);
  if (r === null || r.status === 'missing' || r.text === null) throw new ProcessError('LEAF_MISSING', `the card of dispatch ${dispatch} (${leaf}) is missing; the PM follows WI-30`, { wi: 'WI-30' });
  if (r.status === 'edited') throw new ProcessError('LEAF_EDITED', `the card of dispatch ${dispatch} (${leaf}) was edited after it was recorded; the PM follows WI-30`, { wi: 'WI-30' });
  return { dispatch, text: r.text, leaf };
}

function inFlight(v: DispatchView, what: string): void {
  if (v.info.state !== 'in-flight') throw new ProcessError('NOT_ALLOWED', `dispatch ${v.info.dispatch} is ${v.info.state === 'released' ? `released (${v.info.released})` : 'handed back'}: ${what} is for a dispatch in flight`);
}

function allows(ctx: ProcessContext, v: DispatchView, command: 'read' | 'checkout' | 'rerun' | 'owners' | 'request-evidence' | 'full-run'): void {
  const commands = seatCommandsOf(v.card, { fullSuite: ctx.fullSuite });
  if (!commands.includes(command)) throw new ProcessError('NOT_ALLOWED', `the ${v.card.seat} card of dispatch ${v.info.dispatch} has no \`${command}\` command (its commands: ${commands.join(', ')})`);
}

/**
 * `mp seat <id> read <material> [--page <n>]` (§5.2, decision 6): one page of a material, read from
 * its leaf with the hash checked; the page read is recorded for the must-read rule.
 */
export function seatRead(ctx: ProcessContext, dispatch: string, material: string, page = 1): { readonly material: string; readonly page: number; readonly pages: number; readonly mustRead: boolean; readonly text: string } {
  const v = dispatchView(ctx, dispatch);
  allows(ctx, v, 'read');
  const materials = ((v.card['materials'] as MaterialRef[] | undefined) ?? []);
  const m = materials.find((x) => x.id === material);
  if (m === undefined) throw new ProcessError('NOT_ALLOWED', `"${material}" is not a material on the card (materials: ${materials.map((x) => x.id).join(', ') || 'none'})`);
  if (!Number.isInteger(page) || page < 1 || page > m.pages) throw new ProcessError('NOT_ALLOWED', `material ${material} has page${m.pages === 1 ? ' 1' : `s 1 to ${m.pages}`}; there is no page ${page}`);
  const leaf = materialLeaf(v.info.mission, m.ref);
  const r = ctx.memory.readLeaf(leaf);
  if (r === null || r.status === 'missing' || r.text === null) throw new ProcessError('LEAF_MISSING', `material ${material} (${leaf}) is missing: hand back what you can and say so; the PM follows WI-30`, { wi: 'WI-30' });
  if (r.status === 'edited' || sha256(r.text) !== m.ref) throw new ProcessError('LEAF_EDITED', `material ${material} (${leaf}) was edited after it was recorded: hand back what you can and say so; the PM follows WI-30`, { wi: 'WI-30' });
  if (v.info.state === 'in-flight') {
    const key = `${material}#${page}`;
    ctx.memory.write({ op: `read:${dispatch}:${key}`, payload: { dispatch, key } }, (tx) => {
      appendRecords(tx, [{ kind: 'flow.event', mission: v.info.mission, line: DISPATCH_LINE(dispatch), event: 'read', key, body: tx.data.put(canonicalJson({ material, page })) as ContentHash }]);
    });
  }
  return { material, page, pages: m.pages, mustRead: m.mustRead, text: `[${m.id}] ${m.title}: page ${page} of ${m.pages}${m.mustRead ? ' (must read)' : ''}\n${materialPage(r.text, page)}` };
}

/**
 * `mp seat <id> owners <path>...` (4.1.2, D-6 tracing aid): which accepted products of the mission
 * changed each path, from their recorded changed paths (execution.ts pathOwners, the one resolver).
 */
export async function seatOwners(ctx: ProcessContext, dispatch: string, paths: readonly string[]): Promise<{ readonly dispatch: string; readonly owners: Awaited<ReturnType<typeof pathOwners>>; readonly text: string }> {
  const v = dispatchView(ctx, dispatch);
  allows(ctx, v, 'owners');
  if (paths.length === 0) throw new ProcessError('NOT_ALLOWED', 'name at least one path (a directory ends in "/")');
  const owners = await pathOwners(flowCtx(ctx.ports(), v.info.mission as MissionId), paths);
  const text = owners
    .map((o) => `${o.path}: ${o.owners.length === 0 ? 'no accepted product changed it' : o.owners.map((x) => `${x.task} attempt ${x.attempt} (${x.product}${x.current ? '' : ', an earlier accepted version'})${x.paths.length > 1 || x.paths[0] !== o.path ? `: ${x.paths.join(', ')}` : ''}`).join('; ')}`)
    .join('\n');
  return { dispatch, owners, text };
}

/** The commit (or project-relative path) a card names. */
function cardSnapshot(v: DispatchView): string | null {
  const w = v.card['workspace'] as { snapshot?: string } | undefined;
  return w?.snapshot ?? null;
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * `mp seat <id> checkout` (decision 10; 4.1.2): the commit the card names, in the read-only
 * checkout the seats reading that commit share, `tmp/checkouts/<commit>/` (built once, atomically);
 * the path is printed. This dispatch holds it while in flight.
 */
export async function seatCheckout(ctx: ProcessContext, dispatch: string): Promise<{ readonly path: string; readonly commit: string | null }> {
  const v = dispatchView(ctx, dispatch);
  allows(ctx, v, 'checkout');
  const snap = cardSnapshot(v);
  if (snap === null) throw new ProcessError('NOT_ALLOWED', `the card of dispatch ${dispatch} names no commit to read`);
  if (!COMMIT.test(snap)) return { path: join(ctx.projectDir, ...snap.split('/')), commit: null };
  // a dispatch that is over holds nothing: its checkout would have no holder
  inFlight(v, 'a checkout');
  const c = await holdSharedCheckout(ctx, v.info, snap);
  return { path: c.path, commit: c.commit };
}

/** What a rerun of a card's declared command runs on: the dispatch, the command, the card's commit (the checks of `mp seat <id> rerun`). */
export interface RerunTarget {
  readonly v: DispatchView;
  readonly c: { readonly id: string; readonly command: string; readonly cwd?: string };
  readonly snap: string;
}

/** The checks of `mp seat <id> rerun` (a stop first), for a foreground rerun, a detached one and its worker alike. */
export function rerunTarget(ctx: ProcessContext, dispatch: string, commandId: string): RerunTarget {
  const v = dispatchView(ctx, dispatch);
  // a stop stops (§6.6): nothing is run in its scope, refused before any other refusal
  ctx.memory.read((db) => assertNotStopped(db, v.info.tag, 'this rerun'));
  inFlight(v, 'a rerun');
  allows(ctx, v, 'rerun');
  const suiteCommand = rerunCommands(v.card).find((x) => x.id === commandId && isFullSuiteCommand(ctx.fullSuite, x.command, x.cwd));
  // 4.1.2 (D-5, D-7): the project's full suite is the integration Reviewer's full run, recorded with a marker
  if (suiteCommand !== undefined) throw new ProcessError('NOT_ALLOWED', `"${commandId}" is the project's full suite: it is not rerun from a card; ${isIntegrationCard(v.card) ? `run it with \`mp seat ${dispatch} full-run\`` : 'it is left to the integration review (its Reviewer runs `mp seat <id> full-run`)'}`);
  const c = rerunnableCommands(v.card, { fullSuite: ctx.fullSuite }).find((x) => x.id === commandId);
  if (c === undefined) throw new ProcessError('NOT_ALLOWED', `"${commandId}" is not a declared command on the card (ids: ${rerunnableCommands(v.card, { fullSuite: ctx.fullSuite }).map((x) => x.id).join(', ')})`);
  const snap = cardSnapshot(v);
  if (snap === null || !COMMIT.test(snap)) throw new ProcessError('NOT_ALLOWED', `the card of dispatch ${dispatch} names no commit to run on`);
  return { v, c, snap };
}

/** A rerun's result as the seat sees it, from `mp seat <id> rerun` or, for a detached one, `mp seat <id> wait`. */
export interface RerunResult {
  /** The evidence id to cite. */
  readonly run: string;
  readonly passed: boolean;
  readonly summary: string;
  readonly leaf: string | null;
  /** The last lines of its output, passing or failing (4.1.3, #37), within RERUN_TAIL. */
  readonly tail: string;
}

/**
 * The runOnCommit request of a rerun, foreground or detached: the same declaration, fields and
 * evidence, and the dispatch line's "run" event in the recording write (4.1.3: with the kept tail and
 * the time). `check`: more checks inside that write (a detached run's worker: not stopped).
 */
function rerunRequest(t: RerunTarget, extra: { readonly detached?: string; readonly check?: (tx: WriteTx) => void } = {}) {
  const { v, c, snap } = t;
  const dispatch = v.info.dispatch;
  return {
    mission: v.info.mission,
    commit: snap,
    commands: [c],
    purpose: `rerun of ${c.id} by dispatch ${dispatch}`,
    declaration: { by: 'mp', checkout: 'clean', declared: true, rerun: true, experiment: v.card.seat === 'constructor-experiment' } as const,
    fields: { dispatch },
    tail: RERUN_TAIL,
    keepPassingTail: true,
    also: (tx: WriteTx, runs: readonly RecordedRun[], _run: string, records: readonly EvidenceRecord[]) => {
      extra.check?.(tx);
      for (const x of runs) {
        // the run's environment identity (4.1 §6.5): an experiment's evidence that cites it is bound to it
        const rec = records.find((r) => r.evidence === x.evidence);
        const env = rec !== undefined ? { envLine: rec.envLine as string, envSnapshot: rec.envSnapshot as string } : {};
        const body: RunEventBody = { run: x.evidence, command: c.id, completed: x.fields['status'] === 'completed', exit: x.fields['exit'] ?? 'none', ...env, ...(x.tail !== '' ? { tail: tx.data.put(x.tail) } : {}), at: tx.at, ...(extra.detached !== undefined ? { detached: extra.detached } : {}) };
        appendRecords(tx, [{ kind: 'flow.event', mission: v.info.mission, line: DISPATCH_LINE(dispatch), event: 'run', key: x.evidence, body: tx.data.put(canonicalJson(body)) as ContentHash }]);
      }
    },
  };
}

/**
 * `mp seat <id> rerun <command-id>` (§6.5, decision 11): a declared command of the card, run by
 * `mp` on a clean checkout of the card's commit: a sampling run, new run id, executed every time.
 * 4.1.3: the result carries the last lines of the output, passing or failing (#37).
 */
export async function seatRerun(ctx: ProcessContext, dispatch: string, commandId: string): Promise<RerunResult> {
  const t = rerunTarget(ctx, dispatch, commandId);
  const r = await runOnCommit(ctx, rerunRequest(t));
  const x = r.runs[0]!;
  return { run: x.evidence, passed: x.passed, summary: x.summary, leaf: r.leaf, tail: x.tail };
}

/** A detached rerun as `mp seat <id> rerun --detach` answers: its run id and the evidence id its result is recorded under. */
export interface DetachedStart {
  readonly run: string;
  readonly evidence: string;
  readonly pid: number;
  readonly dispatch: string;
}

/**
 * `mp seat <id> rerun <command-id> --detach` (4.1.3, #30): the rerun runs in a worker process of its
 * own (detached.ts), which records it as running against the dispatch; this returns its run id at
 * once. The checks are the foreground rerun's, here first and again in the worker.
 */
export async function seatRerunDetached(ctx: ProcessContext, dispatch: string, commandId: string, spawner: DetachSpawner = spawnRerunWorker): Promise<DetachedStart> {
  if (ctx.secretary !== null) ctx.memory.write({}, (tx) => {requireSecretary(tx, ctx.secretary);});
  const t = rerunTarget(ctx, dispatch, commandId);
  const w = await spawner(ctx, { dispatch, command: t.c.id });
  return { ...w, dispatch };
}

/** Refused inside a detached run's recording write: it was stopped (nothing of it is recorded). */
class RunStopped extends Error {}

/**
 * The worker of a detached rerun (`mp seat <id> rerun <command-id> --worker`, detached.ts): the
 * foreground rerun's checks, then the run recorded as running (its pid, start time and host), `ready`
 * called, and the command run and recorded exactly as a foreground rerun, with the command in its own
 * process group (groupShellRunner). When `stopping` fires (SIGTERM from `mp pm stop`), or a stop or a
 * "stopped" record is there when it records, nothing of the run is recorded and it is recorded as
 * stopped. A worker error after `ready` is recorded as lost, with the reason.
 */
export async function seatRerunWorker(ctx: ProcessContext, dispatch: string, commandId: string, o: { readonly ready: (w: WorkerStarted) => void; readonly stopping?: AbortSignal }): Promise<{ readonly start: WorkerStarted; readonly state: 'finished' | 'stopped' | 'lost'; readonly result: RerunResult | null }> {
  const t = rerunTarget(ctx, dispatch, commandId);
  const run = newRunId('rerun');
  const evidence = sampleRunId(`${run}.${idPart(t.c.id)}`);
  const line = DISPATCH_LINE(dispatch);
  const started: DetachedBody = { run, evidence, command: t.c.id, dispatch, task: t.v.info.task, pid: process.pid, start: processStart(process.pid), host: hostname(), startedAt: ctx.now() };
  ctx.memory.write({ op: `detached:${run}`, payload: { run, dispatch } }, (tx) => {
    if (ctx.secretary !== null) requireSecretary(tx, ctx.secretary);
    assertNotStopped(tx, t.v.info.tag, 'this rerun');
    if (dispatchInfo(tx, dispatch)?.state !== 'in-flight') throw new ProcessError('NOT_ALLOWED', `dispatch ${dispatch} is no longer in flight: a rerun is for a dispatch in flight`);
    appendRecords(tx, [{ kind: 'flow.event', mission: t.v.info.mission, line, event: DETACHED_EVENT, key: run, body: tx.data.put(canonicalJson({ ...started, startedAt: tx.at })) as ContentHash }]);
  });
  const start: WorkerStarted = { run, evidence, pid: process.pid };
  o.ready(start);
  const check = (tx: WriteTx): void => {
    if (o.stopping?.aborted === true) throw new RunStopped('the worker was told to stop');
    if (flowEventExists(tx, { mission: t.v.info.mission, line, event: DETACHED_END_EVENT, key: run })) {
      const end = flowEvents(tx, { mission: t.v.info.mission, line, event: DETACHED_END_EVENT }).find((e) => e.key === run);
      // "lost" is a reader's inference: a result that arrives after it still counts; "stopped" does not
      if (end !== undefined && (JSON.parse(tx.data.text(end.body)) as DetachedEndBody).outcome === 'stopped') throw new RunStopped('it was recorded as stopped');
    }
    if (stoppedFor(tx, t.v.info.tag)) throw new RunStopped('a stop covers it');
  };
  // the platform's shell, the command in its own process group; a test's runner as it is
  const runner = ctx.runner === shellRunner ? groupShellRunner(o.stopping !== undefined ? { stopping: o.stopping } : {}) : ctx.runner;
  const cleanupRunner = ctx.runner === shellRunner ? groupShellRunner() : ctx.runner;
  try {
    const r = await runOnCommit(ctx, { ...rerunRequest(t, { detached: run, check }), alreadyAdmitted: true, run, evidenceId: () => evidence, runner, cleanupRunner, recordRetries: 3 });
    const x = r.runs[0]!;
    return { start, state: 'finished', result: { run: x.evidence, passed: x.passed, summary: x.summary, leaf: r.leaf, tail: x.tail } };
  } catch (e) {
    const stopped = e instanceof RunStopped || o.stopping?.aborted === true;
    const why = stopped ? `stopped: ${e instanceof RunStopped ? e.message : 'the worker was told to stop'}` : `its worker failed: ${(e as Error).message}`;
    try {
      recordDetachedEnd(ctx, started, stopped ? 'stopped' : 'lost', why);
    } catch {
      /* the next look (mp pm next, mp seat <id> wait) records it as lost once this worker is gone */
    }
    return { start, state: stopped ? 'stopped' : 'lost', result: null };
  }
}

/** What `mp seat <id> wait <run>` answers. */
export interface WaitAnswer {
  readonly run: string;
  readonly evidence: string;
  readonly state: StepRun['state'];
  /** Finished: the result as a foreground rerun returns it. */
  readonly result: RerunResult | null;
  /** Stopped or lost: why. */
  readonly why: string | null;
  /** Running: since when (ms). */
  readonly since: number | null;
  /** The dispatch that started it. */
  readonly startedBy: string;
  readonly waitedMs: number;
}

/**
 * `mp seat <id> wait <run> [--seconds <n>]` (4.1.3, #30): waits up to `seconds` (default 50 minutes,
 * below common harness limits on one command) for a run of this step, a detached one of this dispatch
 * or one an earlier dispatch of the step started (the card lists them), and answers its state:
 * running, or finished with its result as a foreground rerun returns it (a recorded run at once, with
 * its recorded tail), or stopped or lost. A running run whose worker is gone is recorded as lost.
 */
export async function seatWait(ctx: ProcessContext, dispatch: string, runId: string, o: { readonly seconds?: number; readonly pollMs?: number } = {}): Promise<WaitAnswer> {
  const v = dispatchView(ctx, dispatch);
  inFlight(v, 'a wait');
  allows(ctx, v, 'rerun');
  const seconds = o.seconds ?? WAIT_DEFAULT_SECONDS;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > WAIT_MAX_SECONDS) throw new ProcessError('NOT_ALLOWED', `--seconds is 0 to ${WAIT_MAX_SECONDS}`);
  const t0 = Date.now();
  const deadline = t0 + seconds * 1000;
  const data = ctx.memory.data;
  for (;;) {
    const runs = ctx.memory.read((db) => stepRuns(db, data, v.info));
    let r = runs.find((x) => x.run === runId || x.evidence === runId);
    if (r === undefined) throw new ProcessError('NOT_ALLOWED', `no run ${runId} for this step (its runs: ${runs.map((x) => x.run).join(', ') || 'none'})`);
    if (r.state === 'running' && noticeLost(ctx, r)) r = ctx.memory.read((db) => stepRuns(db, data, v.info)).find((x) => x.run === r!.run) ?? r;
    const waitedMs = Date.now() - t0;
    if (r.state !== 'running' || Date.now() >= deadline) {
      const result = r.state === 'finished' ? { run: r.evidence, passed: r.passed === true, summary: r.summary ?? '', leaf: r.leaf, tail: r.tail } : null;
      return { run: r.run, evidence: r.evidence, state: r.state, result, why: r.why, since: r.detached?.startedAt ?? null, startedBy: r.dispatch, waitedMs };
    }
    await new Promise((res) => setTimeout(res, Math.max(1, Math.min(o.pollMs ?? WAIT_POLL_MS, deadline - Date.now()))));
  }
}

/** An integration task's Reviewer card (the flow marks it; `full-run` is offered when the project declares a full suite). */
function integrationReview(ctx: ProcessContext, card: DispatchView['card']): boolean {
  return isIntegrationCard(card) && ctx.fullSuite.length > 0;
}

/**
 * `mp seat <id> full-run` (4.1.2, D-5, D-6): an integration task's Reviewer has `mp` run the full
 * suite on a clean checkout of its candidate (fullRuns.ts runFullSuite: a passing full run on the
 * same tree and environment is reused, nothing executed); the marker cites the dispatch and its
 * runs become citable as evidence:<id> by this dispatch. The card asks for it last, once nothing
 * visible is wrong.
 */
export async function seatFullRun(ctx: ProcessContext, dispatch: string): Promise<{ readonly marker: FullRunMarker; readonly reused: boolean }> {
  if (ctx.secretary !== null) ctx.memory.write({}, (tx) => {requireSecretary(tx, ctx.secretary);});
  const v = dispatchView(ctx, dispatch);
  // a stop stops (§6.6): no suite is run in its scope, refused before any other refusal
  ctx.memory.read((db) => assertNotStopped(db, v.info.tag, 'this full run'));
  inFlight(v, 'a full run');
  allows(ctx, v, 'full-run');
  const snap = cardSnapshot(v);
  if (snap === null || !COMMIT.test(snap)) throw new ProcessError('NOT_ALLOWED', `the card of dispatch ${dispatch} names no commit to run on`);
  return runFullSuite(ctx, { mission: v.info.mission, commit: snap, suite: ctx.fullSuite, by: 'reviewer', cites: { words: null, authority: null, reason: null, dispatch }, scope: tagScope(v.info.tag) });
}

/**
 * The integration Reviewer's pass (4.1.2, D-6): when the project declares a full suite, a "pass"
 * cites a passing full run of its candidate (its tree, the current suite); rework and
 * needs-decision need none. Empty: nothing to refuse.
 */
function integrationPassProblems(ctx: ProcessContext, v: DispatchView, fields: unknown): string[] {
  if (!integrationReview(ctx, v.card)) return [];
  const r = fields as { verdict?: unknown; judgments?: Array<{ evidence?: unknown }> } | null;
  if (r === null || typeof r !== 'object' || r.verdict !== 'pass') return [];
  const snap = cardSnapshot(v);
  if (snap === null || !COMMIT.test(snap)) return [];
  const cited = new Set((Array.isArray(r.judgments) ? r.judgments : []).flatMap((j) => (Array.isArray(j?.evidence) ? j.evidence : [])).filter((e): e is string => typeof e === 'string' && e.startsWith('evidence:')).map((e) => e.slice('evidence:'.length)));
  let tree: string;
  try {
    tree = treeOf(ctx, snap);
  } catch (e) {
    return [`verdict: an integration task's "pass" cites a passing full run of its candidate, and the candidate's tree cannot be read here (${(e as Error).message})`];
  }
  const data = ctx.memory.data;
  const passing = ctx.memory.read((db) => passingFullRunEvidence(db, data, tree, suiteHash(ctx.fullSuite)));
  if ([...cited].some((e) => passing.has(e))) return [];
  return [`verdict: an integration task's "pass" cites a passing full run of its candidate: when nothing visible is wrong, run \`mp seat ${v.info.dispatch} full-run\` and cite its runs as evidence:<id>; if the change or the local results already show a problem, hand back "rework" (or "needs-decision") without a full run`];
}

/** The plan task line and attempt of a Constructor dispatch's task: the flow's "dispatched" event keyed by it (execution.ts submitConstructor), or null. */
function constructorAttempt(ctx: ProcessContext, mission: string, task: string): { readonly line: string; readonly k: number } | null {
  const data = ctx.memory.data;
  return ctx.memory.read((db) => {
    const row = db.stmt("SELECT line, body FROM flow_events WHERE mission = ? AND event = 'dispatched' AND key = ? AND line LIKE 'task:%' ORDER BY revision LIMIT 1").get(mission, task) as { line: string; body: string } | undefined;
    if (row === undefined) return null;
    const k = (JSON.parse(data.text(row.body)) as { k?: unknown }).k;
    return typeof k === 'number' && Number.isSafeInteger(k) ? { line: row.line, k } : null;
  });
}

/**
 * The hand-back's runs as the flow's "verified" event of that attempt (4.1.2 item 1): the flow
 * pass reads it and never executes them again. One writer wins: an event already there (the flow
 * wrote it first) is kept and nothing is written; the flow adopts this one when it comes second.
 */
export function recordVerified(ctx: ProcessContext, v: DispatchView, runs: readonly VerificationRun[]): 'recorded' | 'kept' | 'no-attempt' {
  const at = constructorAttempt(ctx, v.info.mission, v.info.task);
  if (at === null) return 'no-attempt';
  const key = String(at.k);
  return ctx.memory.write({ op: `handback-verified:${v.info.dispatch}`, payload: { dispatch: v.info.dispatch, line: at.line, k: at.k } }, (tx) => {
    if (flowEventExists(tx, { mission: v.info.mission, line: at.line, event: 'verified', key })) return 'kept' as const;
    appendRecords(tx, [{ kind: 'flow.event', mission: v.info.mission, line: at.line, event: 'verified', key, body: tx.data.put(canonicalJson({ runs })) as ContentHash }]);
    return 'recorded' as const;
  });
}

// ---------------------------------------------------------------- hand-backs

/** The files of a hand-back, which must be in `.mission-pipeline/tmp/<dispatch>/` (decision 7). */
function readHandBackFile(ctx: ProcessContext, dispatch: string, file: string, what: string): string {
  const dir = join(ctx.memory.paths.tmp, dispatch);
  const abs = isAbsolute(file) ? file : resolve(ctx.projectDir, file);
  if (!existsSync(abs)) {
    // 4.1.2: tmp/<dispatch>/ is removed once a hand-back is recorded
    if (ctx.memory.read((db) => dispatchInfo(db, dispatch))?.handbackHash != null) throw new ProcessError('NOT_ALLOWED', `dispatch ${dispatch} was already handed back (its files in .mission-pipeline/tmp/${dispatch}/ were removed once it was recorded): you are done`);
    throw new ProcessError('BAD_FILE', `the ${what} file ${file} does not exist (write it to .mission-pipeline/tmp/${dispatch}/)`);
  }
  let real: string;
  let realDir: string;
  try {
    real = realpathSync.native(abs);
    realDir = realpathSync.native(dir);
  } catch (e) {
    throw new ProcessError('BAD_FILE', `the ${what} file ${file} cannot be resolved: ${(e as Error).message}`);
  }
  const rel = relative(realDir, real);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new ProcessError('BAD_FILE', `the ${what} file must be in .mission-pipeline/tmp/${dispatch}/ (the card names it), not ${file}`);
  return readFileSync(real, 'utf8');
}

/** A commit's files as a pointer checker (file:<path>[:<line>]): `git cat-file`, read-only. */
export function commitFiles(ctx: ProcessContext, commit: string): SnapshotFiles {
  const cache = new Map<string, number | null>();
  return {
    lines(rel: string): number | null {
      if (cache.has(rel)) return cache.get(rel)!;
      let n: number | null = null;
      if (rel !== '' && !rel.split('/').some((c) => c === '' || c === '.' || c === '..')) {
        const t = ctx.git.runSync(['cat-file', '-t', `${commit}:${rel}`], { cwd: ctx.projectDir });
        if (t.code === 0 && t.stdout.toString('utf8').trim() === 'blob') {
          const b = ctx.git.runSync(['cat-file', 'blob', `${commit}:${rel}`], { cwd: ctx.projectDir, maxOutputBytes: 512 * 1024 * 1024 });
          if (b.code === 0) {
            const buf = b.stdout;
            let lines = 0;
            for (const x of buf) if (x === 0x0a) lines++;
            n = buf.length > 0 && buf[buf.length - 1] !== 0x0a ? lines + 1 : lines;
          }
        }
      }
      cache.set(rel, n);
      return n;
    },
  };
}

/** A Constructor's candidate as its hand-back answer shows it (ignored files inside the write paths are listed, never collected). */
export type CandidateInfo = NonNullable<AcceptedHandBack['candidate']> & { readonly ignored: readonly string[]; readonly ignoredTotal: number };

export type HandBackAnswer =
  /** Not recorded: the seat fixes these and runs handback again (decision 14). */
  | { readonly kind: 'refused'; readonly dispatch: string; readonly problems: readonly string[] }
  | {
      readonly kind: 'recorded';
      readonly dispatch: string;
      /** accepted, or recorded and not accepted (after a release, after a stop, §5.4, §6.6). */
      readonly outcome: DispatchHandbackOutcome;
      /** The same hand-back again: nothing new was recorded. */
      readonly repeated: boolean;
      readonly report: string | null;
      /** Constructor: the candidate commit and what was collected. */
      readonly candidate: CandidateInfo | null;
      /** Constructor: the verification runs on the candidate's clean checkout (§5.3). */
      readonly verification: readonly VerificationRun[] | null;
      /** A note for the seat (e.g. the verification could not run now; the flow runs it later). */
      readonly notes: readonly string[];
    };

export interface HandBackInput {
  readonly report: string;
  /** The structured fields (the parsed result JSON). */
  readonly fields: unknown;
  readonly filler?: Filler | null;
  /** Advance the process after recording (default true; a test that drives the flows itself passes false). */
  readonly advance?: boolean;
}

/** The flow event (line "dispatch:<id>") holding the program's check results of a refused hand-back. */
export const HANDBACK_REFUSED = 'refused';

/**
 * A refused hand-back (decision 14: it does not count; the seat fixes it and hands back again):
 * the program's check results are still recorded against the dispatch with the reasons (§3.2
 * item 4). The same refusal again is recorded once.
 */
function refuse(ctx: ProcessContext, dispatch: string, command: 'handback' | 'request-evidence', problems: readonly string[]): HandBackAnswer {
  const info = ctx.memory.read((db) => dispatchInfo(db, dispatch));
  if (info !== null) {
    const body = { command, passed: false, problems: problems.map((p) => (p.length <= 1000 ? p : `${p.slice(0, 997)}...`)).slice(0, 200) };
    const key = `${command}.${sha256(canonicalJson(body)).slice(0, 24)}`;
    try {
      ctx.memory.write({ op: `refused:${dispatch}:${key}`, payload: body }, (tx) =>
        appendRecords(tx, [{ kind: 'flow.event', mission: info.mission, line: DISPATCH_LINE(dispatch), event: HANDBACK_REFUSED, key, body: tx.data.put(canonicalJson(body)) as ContentHash }]),
      );
    } catch {
      /* the refusal stands; its record is best effort (a memory that refuses writes now says so on the next command) */
    }
  }
  return { kind: 'refused', dispatch, problems };
}

/** `mp seat <id> handback --report <file.md> --result <file.json>` (decision 7). */
export async function seatHandback(ctx: ProcessContext, dispatch: string, files: { readonly report: string; readonly result: string; readonly filler?: Filler | null }): Promise<HandBackAnswer> {
  const report = readHandBackFile(ctx, dispatch, files.report, 'report');
  const raw = readHandBackFile(ctx, dispatch, files.result, 'result');
  let fields: unknown;
  try {
    fields = JSON.parse(raw);
  } catch (e) {
    return refuse(ctx, dispatch, 'handback', [`the result file is not JSON: ${(e as Error).message}`]);
  }
  return recordSeatHandBack(ctx, dispatch, { report, fields, ...(files.filler !== undefined ? { filler: files.filler } : {}) });
}

/** The seat's records of an accepted hand-back (the Reviewer's judgment and findings are built here). */
function recordsOf(ctx: ProcessContext, v: DispatchView, fields: unknown, runs: ReadonlyArray<{ run: string; completed: boolean }>, more: { readonly report: string; readonly data?: DataChecks }): BaseRecord[] {
  const data = ctx.memory.data;
  const content = { put: (d: string) => data.put(d), putList: (xs: readonly string[]) => data.putList(xs), getList: (r: { hash: string; count: number }) => data.getList(r as never) };
  if (v.card.seat === 'reviewer') {
    const card = v.card as unknown as ReviewerCard;
    const r = fields as ReviewerResult;
    return [judgmentRecord(card, r, data.putList(citedEvidence(card, r, runs))), ...findingRecords(card, r, content, v.info.dispatch)];
  }
  // 4.1.3: a blind executor's report is kept with its evidence record; the leaf is the one this hand-back files
  const report = { text: more.report, leaf: dispatchLeaf(v.info.mission, v.info.dispatch, 'report'), fields };
  // #25 (E-3): a Stabilizer's position is judged with the direction questions as they stand at its hand-back
  const card = v.card.seat === 'stabilizer' ? ctx.memory.read((db) => explorationCardAtHandBack(db, data, v.info.mission as MissionId, v.spec.lineage, v.card)) : v.card;
  return handBackRecords(card, fields, { launch: v.info.dispatch, runs, content, report, ...(more.data !== undefined ? { data: more.data } : {}) });
}

/**
 * 4.1.3 (E-4): the data files a hand-back's data pointers name, each checked once, here, before
 * the write transaction (hashing a large file never runs inside it). Undefined when it cites none:
 * such a hand-back is checked exactly as before.
 */
async function handBackDataChecks(v: DispatchView, fields: unknown): Promise<DataChecks | undefined> {
  const paths = dataPaths(handBackDataTexts(v.card, fields));
  return paths.length === 0 ? undefined : await checkDataFiles(paths);
}

/** The flow event that records why a Secretary dispatch was taken back at its hand-back (its escalation was already decided or closed). */
export const DECISION_RELEASED = 'decision-released';

/**
 * A Secretary dispatch whose escalation the flow will not carry out a decision of any more: it was
 * carried out or closed (applied), or the user answered it first. Its hand-back is recorded as
 * history, not accepted, and its records (a ruling judgment) are not appended. Null: still open.
 */
function mootSecretary(db: Db, v: DispatchView, data: ProcessContext['memory']['data']): string | null {
  if (v.card.seat === 'calibrator-1') {
    const events = [];
    let after = 0;
    for (;;) {
      const page = flowEvents(db, { mission: v.info.mission, line: 'plan', after });
      events.push(...page);
      if (page.length < 1000) break;
      after = page.at(-1)!.revision;
    }
    return supersededRecheck(v.info.task, events.filter((e) => e.event === 'pm-batch').map((e) => JSON.parse(data.text(e.body)) as PmBatchBody), events.filter((e) => e.event === 'cal1-recheck').map((e) => JSON.parse(data.text(e.body)) as RecheckBody));
  }
  if (v.card.seat !== 'secretary') return null;
  const id = (v.card as { request?: { id?: unknown } }).request?.id;
  if (typeof id !== 'string') return null;
  const at = (event: string): boolean => flowEventExists(db, { mission: v.info.mission, line: SECRETARY_LINE, event, key: id });
  if (at('applied')) return `escalation ${id} was already carried out or closed`;
  if (at('user-answer')) return `the user already answered escalation ${id}`;
  return null;
}

/**
 * Record a seat's hand-back (§5.3): the check of its fields, the Constructor's candidate, the
 * records, the report leaf; then verification, the worktree, and the process advanced. The core
 * of `seatHandback` (tests call it with the content directly).
 */
export async function recordSeatHandBack(ctx: ProcessContext, dispatch: string, input: HandBackInput): Promise<HandBackAnswer> {
  const v = dispatchView(ctx, dispatch);
  const data = ctx.memory.data;
  const seatHash = sha256(canonicalJson({ report: input.report, fields: input.fields ?? null }));
  // one hand-back per dispatch: the same one again is a no-op, another is refused (§5.3)
  if (v.info.handbackHash !== null) {
    const prior = handbackDoc(data, v.info);
    if (prior !== null && prior.seat === seatHash) {
      return { kind: 'recorded', dispatch, outcome: v.info.handback!, repeated: true, report: v.info.reportLeaf, candidate: prior.candidate === null ? null : { ...prior.candidate, ignored: [], ignoredTotal: 0 }, verification: null, notes: dispatchOver(ctx, dispatch) };
    }
    throw new LedgerError('FACT_CONFLICT', `dispatch ${dispatch} already handed back other content: one hand-back per dispatch`);
  }
  // a hand-back after a release or a stop, or from a production dispatch claimed before its mission
  // closed (unless the close waits for running work, §6.7): recorded, not accepted
  const closedBefore = ctx.memory.read((db) => (v.info.state === 'in-flight' ? lateForClose(db, v.info, v.spec) : null));
  // a Secretary whose escalation was decided or closed meanwhile: like a late hand-back (checked again in the write)
  const mootBefore = ctx.memory.read((db) => (v.info.state === 'in-flight' ? mootSecretary(db, v, data) : null));
  const late = v.info.state === 'released' || closedBefore !== null || mootBefore !== null || ctx.memory.read((db) => stoppedFor(db, v.info.tag));
  const entry = seatCardEntry(v.card.seat);
  const runs = ctx.memory.read((db) => dispatchRuns(db, data, v.info));
  let candidate: CandidateInfo | null = null;
  let records: BaseRecord[] = [];
  let dataChecks: DataChecks | undefined;
  let dataCited: RecordedData[] = [];
  if (!late) {
    // the role's rules (decision 14: refused hand-backs do not count; the seat fixes them and runs again)
    const reads = ctx.memory.read((db) => dispatchReads(db, v.info));
    const snap = cardSnapshot(v);
    const snapFiles = snap !== null && COMMIT.test(snap) ? (ctx.snapshotFiles !== null ? ctx.snapshotFiles(snap) : commitFiles(ctx, snap)) : null;
    dataChecks = await handBackDataChecks(v, input.fields);
    const problems = [
      ...unreadMustRead(((v.card['materials'] as MaterialRef[] | undefined) ?? []), reads).map((k) => `must-read page ${k} was not read (mp seat ${dispatch} read <material> --page <n>)`),
      ...handBackProblems(v.card, input.fields, { materialsRead: reads, runs, ...(snapFiles !== null ? { snapshot: snapFiles } : {}), ...(dataChecks !== undefined ? { data: dataChecks } : {}) }),
      ...integrationPassProblems(ctx, v, input.fields),
      ...attemptCommandProblems(ctx, v, input.fields),
    ];
    const unique = [...new Set(problems)];
    if (unique.length > 0) return refuse(ctx, dispatch, 'handback', unique);
    if (entry.exportsProduct === true) {
      const ws = v.card['workspace'] as { snapshot: string; writablePaths: readonly string[] };
      const ident = ctx.ident(v.info.createdAt);
      const c = await ctx.workspaces().collect({ dispatch, base: ws.snapshot, writePaths: ws.writablePaths, message: `mission-pipeline: ${v.info.task} (dispatch ${dispatch}, mission ${v.info.mission})`, author: ident, committer: ctx.committer(v.info.createdAt) });
      if (c.kind !== 'candidate') return refuse(ctx, dispatch, 'handback', collectionProblems(c));
      candidate = { commit: c.commit, base: c.base, changedPaths: [...new Set([...c.added, ...c.modified, ...c.deleted, ...c.modeChanged])].sort(), ignored: c.ignored.paths, ignoredTotal: c.ignored.total };
    }
    records = recordsOf(ctx, v, input.fields, runs, { report: input.report, ...(dataChecks !== undefined ? { data: dataChecks } : {}) });
    // every seat's data pointers, with the check made, kept with the hand-back's records (one parser and renderer for all)
    if (dataChecks !== undefined) dataCited = recordedData(handBackDataTexts(v.card, input.fields), dataChecks);
  }
  const out = ctx.memory.write({ op: `handback:${dispatch}`, payload: { seat: seatHash } }, (tx) => {
    if (v.card.seat === 'secretary') {
      const claim = flowEvents(tx, {mission: v.info.mission, line: DISPATCH_LINE(dispatch), event: 'claimed'}).find((e) => e.key === 'spec');
      const owner = claim === undefined ? null : (JSON.parse(tx.data.text(claim.body)) as {generation?: string | null}).generation;
      if (owner != null) requireSecretary(tx, owner);
      if (ctx.secretary !== null) requireSecretary(tx, ctx.secretary);
    }
    // 5.2 part 5: a continuation judgment is committed only after the labels' check passed for it, carrying
    // exactly the inputs the check merged; a refused one sends the work to a full review (a normal branch)
    const close = dispatchInfo(tx, dispatch)?.state === 'in-flight' ? lateForClose(tx, v.info, v.spec) : null;
    if (close !== null) takeBackForClose(tx, v.info, close);
    // a Secretary hand-back whose escalation is no longer open: the dispatch is taken back first, so the
    // hand-back is recorded after the release (not accepted) and its ruling is never appended
    const moot = close === null && dispatchInfo(tx, dispatch)?.state === 'in-flight' ? mootSecretary(tx, v, data) : null;
    if (moot !== null) {
      releaseDispatch(tx, { dispatch, how: 'ended', requeue: false });
      appendRecords(tx, [{ kind: 'flow.event', mission: v.info.mission, line: TASKS_LINE, event: DECISION_RELEASED, key: dispatch, body: tx.data.put(canonicalJson({ dispatch, task: v.info.task, why: moot })) as ContentHash }]);
    }
    const { accepted: kept, fullReview } = late || close !== null || moot !== null ? { accepted: records, fullReview: null } : continuationsChecked(tx, v, records);
    const doc: HandbackDoc = {
      format: 'mp41.handback.v1',
      kind: 'handed-back',
      seat: seatHash,
      fields: input.fields ?? null,
      records: kept,
      candidate: candidate === null ? null : { commit: candidate.commit, base: candidate.base, changedPaths: candidate.changedPaths },
      request: null,
      notes: null,
      runs,
      ...(fullReview !== null ? { fullReview } : {}),
      ...(dataCited.length > 0 ? { data: dataCited } : {}),
    };
    const r = recordHandback(tx, { dispatch, report: input.report, result: doc, filler: input.filler ?? null });
    if (r.accepted && kept.length > 0) appendRecords(tx, kept);
    return { outcome: r.outcome, accepted: r.accepted, report: r.report, closed: close !== null, moot: moot ?? mootBefore };
  });
  const notes: string[] = out.closed ? [`mission ${v.info.mission} closed before this hand-back: it is recorded, not accepted; the step waits until the mission is opened again`] : [];
  if (out.moot !== null) notes.push(`${out.moot} before this hand-back: it is recorded, not accepted, and nothing it decides is carried out`);
  // 4.1.2: recorded (its files were read): tmp/<dispatch>/ goes, and the checkouts only it held
  notes.push(...dispatchOver(ctx, dispatch));
  let verification: VerificationRun[] | null = null;
  if (out.accepted && entry.exportsProduct === true && candidate !== null) {
    // §5.3: the program's runs on a clean checkout of the candidate are the evidence
    const commands = ((v.card['verificationCommands'] as Array<{ id: string; command: string; cwd?: string }> | undefined) ?? []);
    // 4.1.2 (D-4, D-5, D-7): the project's full suite on the card is not run here (actions.ts verify)
    const suite = commands.filter((c) => isFullSuiteCommand(ctx.fullSuite, c.command, c.cwd));
    if (suite.length > 0) notes.push(`${suite.map((c) => c.id).join(', ')} ${suite.length === 1 ? 'is' : 'are'} the project's full suite: not run at hand-back; it is left to the integration review (its Reviewer's mp seat <id> full-run)`);
    // a stop stops (§6.6): the runs wait until it is released
    if (verificationStopped(ctx, v.info.mission as MissionId)) {
      notes.push('a stop covers this work: the verification runs of this candidate wait until it is released; mp pm next runs them then');
    } else try {
      const runs = await ctx.actions().verify({ mission: v.info.mission as MissionId, object: productObjectId(v.info.task), snapshot: candidate.commit, commands });
      // "pending": another mp process advancing the flow is running these very runs; the hand-back
      // stays recorded once, nothing runs twice, and the result reaches the flow when they are recorded
      if (runs === 'pending') notes.push('the verification runs of this candidate are executing in another mp process; their result reaches the process when they are recorded (mp pm next)');
      else {
        verification = [...runs];
        for (const r of runs) if ('setupFailure' in r && typeof r.setupFailure === 'string') notes.push(r.setupFailure);
        // 4.1.2: these runs are the flow's "verified" event of this attempt, so the flow never runs them again
        try {
          recordVerified(ctx, v, runs);
        } catch (e) {
          notes.push(`the verification result could not be handed to the process now (${(e as Error).message}); mp pm next reuses the recorded runs`);
        }
      }
    } catch (e) {
      notes.push(`the verification runs could not run now (${(e as Error).message}); mp runs them again on the next step`);
    }
    try {
      ctx.workspaces().remove(dispatch);
    } catch (e) {
      notes.push(`the worktree of ${dispatch} could not be removed now (${(e as Error).message}); mp pm next tries again`);
    }
  }
  if (input.advance !== false) await advanceQuietly(ctx, v, notes);
  return { kind: 'recorded', dispatch, outcome: out.outcome, repeated: false, report: out.report, candidate, verification, notes };
}

/**
 * The continuation judgments among a hand-back's records (5.2 part 5), checked inside its write:
 * the labels' check is recorded (recordContinuationCheck); a passing one makes the judgment carry
 * the merged inputs; a refused one drops it, and the task goes to a full review.
 */
function continuationsChecked(tx: WriteTx, v: DispatchView, records: readonly BaseRecord[]): { readonly accepted: BaseRecord[]; readonly fullReview: string | null } {
  const out: BaseRecord[] = [];
  let fullReview: string | null = null;
  for (const r of records) {
    if (r.kind !== 'judgment' || r.extends === null) {
      out.push(r);
      continue;
    }
    const req: ContinuationRequest = {
      extends: r.extends,
      target: r.target,
      review: r.review,
      changedLines: (v.spec.changedLines ?? []) as ContinuationRequest['changedLines'],
      draft: { evidence: tx.data.getList(r.evidence), bases: tx.data.getList(r.bases), constraints: tx.data.getList(r.constraints), reliesOn: tx.data.getList(r.reliesOn) },
      superseded: r.superseded,
    };
    const c = continuationCheck(tx, req);
    if (!c.result.ok && c.result.reason === 'recomputing') throw new LedgerError('BUSY', 'the labels are recomputing: the continuation check waits for them; nothing was written: hand back again');
    recordContinuationCheck(tx, {
      judgment: r.judgment,
      extends: r.extends,
      target: r.target,
      revision: c.revision,
      result: c.result.ok ? { ok: true, merged: c.result.merged } : { ok: false, reason: c.result.reason },
    });
    if (!c.result.ok) {
      fullReview = `the continuation ${r.judgment} of ${r.extends} was refused (${c.result.reason}): a full review instead`;
      continue;
    }
    const m = c.result.merged;
    out.push({ ...r, evidence: tx.data.putList(m.evidence), bases: tx.data.putList(m.bases), constraints: tx.data.putList(m.constraints), reliesOn: tx.data.putList(m.reliesOn) });
  }
  return { accepted: out, fullReview };
}

/** A refusal of the candidate collection, as lines for the seat (§5.3, decision 17). */
function collectionProblems(c: Exclude<Collection, { kind: 'candidate' }>): string[] {
  switch (c.kind) {
    case 'outside-write-paths':
      return [`changes outside your write paths (remove them, or move them inside the write paths): ${c.paths.join(', ')}`];
    case 'head-moved':
      return [`the worktree's HEAD moved: ${c.detail}`];
    case 'rejected':
      return [`the candidate cannot be represented (${c.rejection.code}): ${c.rejection.detail}${c.rejection.paths.length > 0 ? ` (${c.rejection.paths.join(', ')})` : ''}`];
    case 'objects-missing':
      return [`git objects the candidate needs are missing (WI-13 for the PM): ${c.objects.slice(0, 10).join(', ')}`];
    case 'no-workspace':
      return [`no worktree at ${c.path}: the PM dispatches the step again (WI-28)`];
  }
}

/** `mp seat <id> request-evidence --request <file.json> --notes <file.md>` (decision 13): a hand-back of kind "needs evidence". */
export async function seatRequestEvidence(ctx: ProcessContext, dispatch: string, files: { readonly request: string; readonly notes: string; readonly filler?: Filler | null }): Promise<HandBackAnswer> {
  const v = dispatchView(ctx, dispatch);
  allows(ctx, v, 'request-evidence');
  const notesText = readHandBackFile(ctx, dispatch, files.notes, 'notes');
  let req: unknown;
  try {
    req = JSON.parse(readHandBackFile(ctx, dispatch, files.request, 'request'));
  } catch (e) {
    if (e instanceof ProcessError) throw e;
    return refuse(ctx, dispatch, 'request-evidence', [`the request file is not JSON: ${(e as Error).message}`]);
  }
  return recordEvidenceRequest(ctx, dispatch, { request: req, notes: notesText, ...(files.filler !== undefined ? { filler: files.filler } : {}) });
}

/**
 * 4.1.3 (E-4, #43): what the executor's `mp seat <id> rerun` is certain to refuse, or never offers,
 * for the commands an evidence request or a registered attempt declares, refused when they are
 * asked for, with the reason, so the seat fixes it in the same dispatch:
 *   - a working directory the run refuses (normalizeCwd, the run's own normalizer over normalRelDir:
 *     absolute, leaving the checkout, or inside .git);
 *   - an id declared twice (the rerun runs the first one only);
 *   - the project's full suite (never rerun from a card, D-5);
 *   - commands on a reading (a reader has no rerun: they would never run).
 */
export function evidenceCommandProblems(ctx: Pick<ProcessContext, 'fullSuite'>, where: string, commands: ReadonlyArray<{ readonly id: string; readonly command: string; readonly cwd?: string }>, executor: 'experiment' | 'reading'): string[] {
  const out: string[] = [];
  if (executor === 'reading' && commands.length > 0) out.push(`${where}: a reading runs no commands (its executor reads sources and has no rerun): ask for an experiment (executor "experiment") to run them, or leave them out`);
  const seen = new Set<string>();
  commands.forEach((c, i) => {
    const at = `${where}[${i}] (${c.id})`;
    if (seen.has(c.id)) out.push(`${at}: the id "${c.id}" is declared twice: give each command its own id (the executor runs one with mp seat <id> rerun <command-id>)`);
    seen.add(c.id);
    try {
      normalizeCwd(c.cwd);
    } catch (e) {
      // the rerun's own reason, without its code
      const why = e instanceof ProcessError ? (e.message.startsWith(`${e.code}: `) ? e.message.slice(e.code.length + 2) : e.message) : (e as Error).message;
      out.push(`${at}: ${why}: use "." or a path relative to the repository root, or leave cwd out (an absolute path goes in the command text)`);
      return;
    }
    if (isFullSuiteCommand(ctx.fullSuite, c.command, c.cwd)) out.push(`${at}: "${c.command}" is the project's full suite: it is never rerun from a card (the integration review runs it)`);
  });
  return out;
}

/** The executor an exploration seat's request gets (its own, else the exploration's default), read from the memory. */
function requestedExecutor(ctx: ProcessContext, v: DispatchView, req: { readonly executor?: 'experiment' | 'reading' }): 'experiment' | 'reading' {
  if (req.executor !== undefined) return req.executor;
  const x = (v.card['exploration'] as { id?: unknown } | undefined)?.id;
  if (typeof x !== 'string') return 'experiment';
  const data = ctx.memory.data;
  const q = { mission: v.info.mission as MissionId, line: explorationLine(x) };
  // the definition in force: its definition events only (the machine's own fold)
  const rows = ctx.memory.read((db) => [...flowEvents(db, { ...q, event: 'defined' }), ...flowEvents(db, { ...q, event: 'redefined' })]).sort((a, b) => Number(a.revision) - Number(b.revision));
  const s = foldExploration(rows.map((e) => ({ event: e.event, key: e.key, body: JSON.parse(data.text(e.body)) as unknown })));
  return s.def === null ? 'experiment' : requestExecutor(req, s.def);
}

/**
 * The commands an attempt register declares, each attempt's checked as a request's are (4.1.3, E-4): the
 * author's register at its hand-back, and the user's attempts through the repair entry (`mp pm repair
 * --attempts`, the older `mp pm amend-attempts`), so a run the rerun would refuse is refused when it is
 * registered.
 */
export function registerCommandProblems(ctx: Pick<ProcessContext, 'fullSuite'>, attempts: ReadonlyArray<{ readonly id: string; readonly kind: 'experiment' | 'reading'; readonly commands?: ReadonlyArray<{ readonly id: string; readonly command: string; readonly cwd?: string }> }>): string[] {
  return attempts.flatMap((a) => evidenceCommandProblems(ctx, `attempts[${a.id}].commands`, a.commands ?? [], a.kind));
}

/** A research author's attempt register (4.1.3): the commands each attempt declares, checked as a request's are. */
function attemptCommandProblems(ctx: ProcessContext, v: DispatchView, fields: unknown): string[] {
  if (v.card.seat !== 'researcher-author' || v.card['registerAttempts'] !== true) return [];
  const r = seatCardEntry(v.card.seat).resultSchema.safeParse(fields);
  if (!r.success) return [];
  const attempts = (r.data as { step: string; attempts: ReadonlyArray<{ id: string; kind: 'experiment' | 'reading'; commands?: ReadonlyArray<{ id: string; command: string; cwd?: string }> }> });
  if (attempts.step !== 'submit') return [];
  return registerCommandProblems(ctx, attempts.attempts);
}

/** The core of seatRequestEvidence (tests call it with the content directly). */
export async function recordEvidenceRequest(ctx: ProcessContext, dispatch: string, input: { readonly request: unknown; readonly notes: string; readonly filler?: Filler | null; readonly advance?: boolean }): Promise<HandBackAnswer> {
  const v = dispatchView(ctx, dispatch);
  const parsed = EvidenceRequestSchema.safeParse(input.request);
  if (!parsed.success) return refuse(ctx, dispatch, 'request-evidence', parsed.error.issues.map((i) => `request.${i.path.join('.')}: ${i.message}`));
  if (parsed.data.measure.length === 0 && parsed.data.assertions.length === 0) return refuse(ctx, dispatch, 'request-evidence', ['request: record at least one quantity or check one assertion']);
  // 4.1.3 (E-4): what the executor's rerun would refuse later is refused now (a dispatch is not spent on it)
  const commands = parsed.data.commands ?? [];
  if (commands.length > 0) {
    const cp = evidenceCommandProblems(ctx, 'request.commands', commands, requestedExecutor(ctx, v, parsed.data));
    if (cp.length > 0) return refuse(ctx, dispatch, 'request-evidence', cp);
  }
  const seatHash = sha256(canonicalJson({ report: input.notes, request: parsed.data }));
  if (v.info.handbackHash !== null) {
    const prior = handbackDoc(ctx.memory.data, v.info);
    if (prior !== null && prior.seat === seatHash) return { kind: 'recorded', dispatch, outcome: v.info.handback!, repeated: true, report: v.info.reportLeaf, candidate: null, verification: null, notes: dispatchOver(ctx, dispatch) };
    throw new LedgerError('FACT_CONFLICT', `dispatch ${dispatch} already handed back other content: one hand-back per dispatch`);
  }
  const runs = ctx.memory.read((db) => dispatchRuns(db, ctx.memory.data, v.info));
  const out = ctx.memory.write({ op: `handback:${dispatch}`, payload: { seat: seatHash } }, (tx) => {
    // a production dispatch claimed before its mission closed (§6.7): recorded, not accepted
    const close = dispatchInfo(tx, dispatch)?.state === 'in-flight' ? lateForClose(tx, v.info, v.spec) : null;
    if (close !== null) takeBackForClose(tx, v.info, close);
    const doc: HandbackDoc = {
      format: 'mp41.handback.v1',
      kind: 'needs-evidence',
      seat: seatHash,
      fields: null,
      records: [],
      candidate: null,
      request: tx.data.put(canonicalJson(parsed.data)) as ContentHash,
      notes: tx.data.put(input.notes) as ContentHash,
      runs,
    };
    const r = recordHandback(tx, { dispatch, report: input.notes, result: doc, filler: input.filler ?? null });
    return { outcome: r.outcome, report: r.report };
  });
  // 4.1.2: recorded (its files were read): tmp/<dispatch>/ goes, and the checkouts only it held
  const notes: string[] = dispatchOver(ctx, dispatch);
  if (input.advance !== false) await advanceQuietly(ctx, v, notes);
  return { kind: 'recorded', dispatch, outcome: out.outcome, repeated: false, report: out.report, candidate: null, verification: null, notes };
}

/**
 * Advance the mission's process after a hand-back (§5.1 step 4); a flow error is the PM's (a notice), never
 * the seat's. A seat-side pass (4.1.2): what the seat's sandbox could not write is left to the PM's next
 * step with a note, and raises no WI-20 notice; any other error still does.
 */
async function advanceQuietly(ctx: ProcessContext, v: DispatchView, notes: string[]): Promise<void> {
  try {
    // the work this hand-back hands over is recorded as handed over by it (§3.2, U-13)
    const reports = await advance(ctx, v.info.mission as MissionId, { dispatch: v.info.dispatch, task: v.info.task, step: `the hand-back of ${v.info.dispatch} (${v.info.seat}, ${v.info.task})` }, { seatSide: true });
    for (const r of reports) for (const e of r.errors) if (e.sandbox !== undefined) notes.push(`left to the PM: this seat's sandbox could not write ${e.sandbox}`);
  } catch (e) {
    notes.push(`the process will advance on the PM's next step (${(e as Error).message})`);
  }
}
