// Full runs and their markers (4.1.2, D-5..D-7; COMMON "Full run"):
//
//   full run     `mp` executes every `fullSuite` command (config.json; `closingChecks` is its alias),
//                in order, on a clean checkout of one commit, under the run locks (runs.ts
//                runOnCommit: a declared run of the same command on the same commit and environment
//                stands; a failing one is executed again, so its failure can be traced). Each failing
//                command keeps its last 400 lines (at most 64 KiB) in the run summary leaf and in
//                the marker (FULL_RUN_TAIL).
//   marker       one flow event per full run (line FULL_RUNS_LINE of the mission, event
//                FULL_RUN_EVENT, key the run id), written in the same write as the run's evidence:
//                the mission, the commit, its tree, the environment identity, start and end, each
//                command's evidence and exit, the overall result, the failing commands' output tail,
//                and the words, authorization item, reason or dispatch it cites.
//   reuse        a passing full run already recorded on the same tree, under the same environment
//                identity, of the same suite, is reused and not executed again (by tree, never by
//                commit): a new marker cites it (`reusedFrom`), nothing runs.
//   who          an integration task's Reviewer (`mp seat <id> full-run`, last, once nothing visible
//                is wrong); the PM at the end of a mission (`mp pm full-run`, on the candidate
//                `mp pm deliver` would build), citing the user's words or an authorization item in
//                force (D-7, D-8): the record shows who decided.
//   the read     fullRunStatus(ctx, mission, tree): the newest marker, whether it ran on `tree`, and
//                what changed since (accepted products recorded after it, paths that differ). P4
//                shows it at delivery and close; every read calls this resolver.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256 } from '../common/hash.ts';
import type { ContentHash, MissionId } from '../common/ids.ts';
import { normalizeCommand, type SuiteCommand } from '../common/fullSuite.ts';
import type { BaseRecord, EvidenceRecord } from '../common/records.ts';
import { reusableMethodRun } from '../evaluator/runs.ts';
import { buildCandidate, landedVersions } from '../delivery/candidate.ts';
import { buildManifest } from '../delivery/manifest.ts';
import { memoryProofView } from '../delivery/memoryView.ts';
import { assertScopeNotStopped, deriveScope, type WorkScope } from '../delivery/scope.ts';
import type { DeliveryTarget } from '../delivery/proofView.ts';
import { discoverRepo, gitOid } from '../git/objects.ts';
import { AttributeEvaluator, readTransformDescription } from '../git/representation.ts';
import { lineAcceptance } from '../flow/execution.ts';
import { flowCtx } from '../flow/context.ts';
import { PLAN_LINE, taskLine } from '../flow/plandoc.ts';
import { currentItems, itemLine } from '../flow/requirements.ts';
import { appendRecords, factById, flowEvents, type Db, type WriteTx } from '../memory/index.ts';
import type { ProcessContext } from './context.ts';
import { ProcessError } from './errors.ts';
import { labelView } from './labelView.ts';
import { DISPATCH_LINE } from './ports.ts';
import { commandLine, FULL_RUN_TAIL, newRunId, normalizeCwd, runLeaf, runOnCommit, type DeclaredCommand, type RecordedRun } from './runs.ts';

/** The mission's line of full-run markers. */
export const FULL_RUNS_LINE = 'full-runs';
/** The event of one full-run marker (key: the run id). */
export const FULL_RUN_EVENT = 'full-run';

/** One command of a full run, as its marker records it. */
export interface FullRunCommand {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  /** The evidence the command stands on (a run of this full run, or a declared run of the same command on the same commit it reused). */
  readonly evidence: string;
  readonly status: string;
  readonly exit: string;
  readonly passed: boolean;
  /** Executed by this full run (false: a declared run it reused, or a full run it reused). */
  readonly executed: boolean;
  /** A reused passing run that failed when executed again as setup now: the command counts as failed here. */
  readonly setupFailure?: string;
}

/** Who decided this full run (D-7, D-8): the user's words, an authorization item in force, the reason; or the integration Reviewer's dispatch. */
export interface FullRunCites {
  readonly words: string | null;
  readonly authority: string | null;
  readonly reason: string | null;
  readonly dispatch: string | null;
}

/** A full-run marker (COMMON's fields) as stored: the body of the flow event. */
export interface FullRunBody {
  readonly format: 'mp412.full-run.v1';
  readonly id: string;
  readonly mission: string;
  readonly commit: string;
  readonly tree: string;
  /** The environment identity it ran under (a reused one: the identity of the run it reused). */
  readonly environment: string;
  /** The suite it ran: the hash of its commands (normalized text and working directory, in order). */
  readonly suite: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly commands: readonly FullRunCommand[];
  readonly passed: boolean;
  /** The failing commands' last 400 lines (at most 64 KiB each). */
  readonly failing: ReadonlyArray<{ readonly id: string; readonly tail: string }>;
  readonly by: 'reviewer' | 'pm';
  readonly cites: FullRunCites;
  /** The marker of the full run it reused (same tree, environment and suite; nothing executed), or null. */
  readonly reusedFrom: string | null;
  /** The run summary leaf (the executed run's, or the reused run's). */
  readonly leaf: string | null;
}

/** A full-run marker as read back: its body and the revision of its event (newer markers have higher revisions). */
export interface FullRunMarker extends FullRunBody {
  readonly revision: number;
}

/**
 * The hash naming a suite (the reuse key of a full run): each command as given, in order — a command
 * line by its whitespace-normalized text, an argv as its list of words (its word boundaries are part
 * of what runs: ['n', 'a b'] is not ['n', 'a', 'b']) — and its working directory.
 */
export function suiteHash(suite: readonly SuiteCommand[]): string {
  return sha256(canonicalJson(suite.map((c) => ({ command: typeof c.command === 'string' ? normalizeCommand(c.command) : [...c.command], cwd: normalizeCwd(c.cwd) })))).slice(0, 32);
}

function markersOf(db: Db, data: { text(h: string): string }, q: { readonly mission?: string }): FullRunMarker[] {
  const rows = (q.mission !== undefined
    ? db.stmt('SELECT body, revision FROM flow_events WHERE mission = ? AND line = ? AND event = ? ORDER BY revision DESC').all(q.mission, FULL_RUNS_LINE, FULL_RUN_EVENT)
    : db.stmt('SELECT body, revision FROM flow_events WHERE line = ? AND event = ? ORDER BY revision DESC').all(FULL_RUNS_LINE, FULL_RUN_EVENT)) as Array<{ body: string; revision: number }>;
  return rows.map((r) => ({ ...(JSON.parse(data.text(r.body)) as FullRunBody), revision: Number(r.revision) }));
}

/** A mission's full-run markers, newest first (`mp read full-runs <mission>`). */
export function fullRunMarkers(db: Db, data: { text(h: string): string }, mission: string): FullRunMarker[] {
  return markersOf(db, data, { mission });
}

/** A commit's tree id (reuse is by tree, never by commit). */
export function treeOf(ctx: ProcessContext, commit: string): string {
  const r = ctx.git.runSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^{tree}`], { cwd: ctx.projectDir });
  if (r.code !== 0) throw new ProcessError('NOT_ALLOWED', `${commit} is not a commit of the project repository (a missing object is never fetched)`);
  return r.stdout.toString('utf8').trim();
}

/** The paths in which two trees differ (empty when one of them cannot be read here: the read says so). */
function pathsBetween(ctx: ProcessContext, a: string, b: string): string[] | null {
  if (a === b) return [];
  const r = ctx.git.runSync(['diff-tree', '-r', '--no-renames', '--name-only', a, b], { cwd: ctx.projectDir });
  if (r.code !== 0) return null;
  return r.stdout.toString('utf8').split('\n').map((x) => x.trim()).filter((x) => x !== '').sort();
}

/** The product versions accepted on the mission's task lines after `revision` (accepted, or a re-bound version accepted). */
function acceptedSince(db: Db, data: { text(h: string): string }, mission: string, revision: number): string[] {
  const rows = db.stmt("SELECT event, body FROM flow_events WHERE mission = ? AND line LIKE 'task:%' AND event IN ('accepted', 'rebound') AND revision > ? ORDER BY revision").all(mission, revision) as Array<{ event: string; body: string }>;
  const out = new Set<string>();
  for (const r of rows) {
    const b = JSON.parse(data.text(r.body)) as { product?: unknown };
    if (typeof b.product === 'string') out.add(b.product);
  }
  return [...out];
}

/**
 * The full-run state of a mission for a tree (COMMON; P4 shows it at delivery and close): the
 * newest marker, whether it ran on `tree`, and what changed since it — the accepted products
 * recorded after it, and the paths in which `tree` differs from the marker's tree (null: no marker).
 * Every read of this state calls this resolver.
 */
export function fullRunStatus(ctx: ProcessContext, mission: string, tree: string): { readonly last: FullRunMarker | null; readonly sameTree: boolean; readonly changedSince: { readonly products: string[]; readonly paths: string[] } | null } {
  const data = ctx.memory.data;
  const { last, products } = ctx.memory.read((db) => {
    const m = fullRunMarkers(db, data, mission)[0] ?? null;
    return { last: m, products: m === null ? [] : acceptedSince(db, data, mission, m.revision) };
  });
  if (last === null) return { last: null, sameTree: false, changedSince: null };
  // a tree that cannot be read here is reported as unknown paths, never as "no change"
  const paths = pathsBetween(ctx, last.tree, tree) ?? ['(the trees cannot be compared here)'];
  return { last, sameTree: last.tree === tree, changedSince: { products, paths } };
}

/** The evidence of every passing full run of `suite` on `tree`, under any environment identity (an older one is labelled, not refused). */
export function passingFullRunEvidence(db: Db, data: { text(h: string): string }, tree: string, suite: string): Set<string> {
  const out = new Set<string>();
  for (const m of markersOf(db, data, {})) if (m.passed && m.tree === tree && m.suite === suite) for (const c of m.commands) out.add(c.evidence);
  return out;
}

/** The DISPATCH_LINE "run" events that let a dispatch cite a full run's evidence (as `mp seat <id> rerun` does), derived from the evidence records only. */
function dispatchRunEvents(tx: WriteTx, mission: string, dispatch: string, commands: readonly FullRunCommand[]): BaseRecord[] {
  return commands.map((c): BaseRecord => {
    const rec = factById(tx, 'evidence', c.evidence)?.record as EvidenceRecord | undefined;
    const completed = rec?.fields['status'] === 'completed';
    const exit = rec?.fields['exit'] ?? c.exit;
    const env = rec !== undefined ? { envLine: rec.envLine as string, envSnapshot: rec.envSnapshot as string } : {};
    return { kind: 'flow.event', mission: mission as MissionId, line: DISPATCH_LINE(dispatch), event: 'run', key: c.evidence, body: tx.data.put(canonicalJson({ run: c.evidence, command: c.id, completed, exit, ...env })) as ContentHash };
  });
}

function writeMarker(tx: WriteTx, body: FullRunBody, dispatch: string | null): void {
  appendRecords(tx, [
    { kind: 'flow.event', mission: body.mission as MissionId, line: FULL_RUNS_LINE, event: FULL_RUN_EVENT, key: body.id, body: tx.data.put(canonicalJson(body)) as ContentHash },
    ...(dispatch !== null ? dispatchRunEvents(tx, body.mission, dispatch, body.commands) : []),
  ]);
}

export interface FullRunRequest {
  readonly mission: string;
  readonly commit: string;
  readonly suite: readonly SuiteCommand[];
  readonly by: 'reviewer' | 'pm';
  readonly cites: FullRunCites;
  /** The stop scope of the work (§6.6): checked again right before anything executes (a stop recorded meanwhile refuses it). */
  readonly scope?: WorkScope;
}

export interface FullRunResult {
  readonly marker: FullRunMarker;
  /** A passing full run on the same tree, environment and suite was reused: nothing executed. */
  readonly reused: boolean;
}

/**
 * One full run (COMMON): every suite command in order on a clean checkout of `commit`, by `mp`,
 * under the run locks (RunInProgress, a LOCKED refusal, while another process executes the same
 * declared runs), recorded with its marker in the run's own write; or, when a passing full run of
 * the same suite is recorded on the same tree under the same environment identity, a marker that
 * reuses it and nothing executed. `cites.dispatch`: the Reviewer dispatch that may then cite its runs.
 */
export async function runFullSuite(ctx: ProcessContext, req: FullRunRequest): Promise<FullRunResult> {
  if (req.suite.length === 0) throw new ProcessError('NOT_ALLOWED', 'no full suite is configured (config.json fullSuite): there is nothing to run');
  const ids = req.suite.map((c) => c.id);
  const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
  if (dup.length > 0) throw new ProcessError('NOT_ALLOWED', `the full suite repeats command ids (${dup.join(', ')}) in config.json: nothing was run`);
  const env = ctx.environment();
  const tree = treeOf(ctx, req.commit);
  const suite = suiteHash(req.suite);
  const data = ctx.memory.data;
  const dispatch = req.cites.dispatch;
  const reusable = ctx.memory.read((db) => markersOf(db, data, {}).find((m) => m.passed && m.tree === tree && m.environment === env.identity && m.suite === suite) ?? null);
  if (reusable !== null) {
    const now = ctx.now();
    const body: FullRunBody = { ...stripRevision(reusable), id: newRunId('full'), mission: req.mission, commit: req.commit, startedAt: now, endedAt: now, commands: reusable.commands.map((c) => ({ ...c, executed: false })), by: req.by, cites: req.cites, reusedFrom: reusable.reusedFrom ?? reusable.id };
    ctx.memory.write({ op: `full-run:${body.id}`, payload: { id: body.id, reusedFrom: body.reusedFrom } }, (tx) => writeMarker(tx, body, dispatch));
    return { marker: readMarker(ctx, req.mission, body.id), reused: true };
  }
  // a stop stops: checked again right before the execution (the callers checked before building anything)
  if (req.scope !== undefined) ctx.memory.read((db) => assertScopeNotStopped(db, req.scope!, 'this full run'));
  const commands: DeclaredCommand[] = req.suite.map((c) => ({ id: c.id, command: commandLine(c.command), ...(c.cwd !== undefined ? { cwd: c.cwd } : {}) }));
  // a failing declared run of the same command on this commit is executed again, so the failure is traced now
  const doNotReuse = ctx.memory.read((db) =>
    commands.flatMap((c) => {
      const r = reusableMethodRun(db, { candidate: req.commit, command: c.command, cwd: normalizeCwd(c.cwd), environment: env.identity });
      return r !== null && !(r.fields['status'] === 'completed' && r.fields['exit'] === '0') ? [r.evidence] : [];
    }),
  );
  const startedAt = ctx.now();
  const bodyOf = (run: string, runs: readonly RecordedRun[], leaf: string | null, environment: string): FullRunBody => {
    const cmds: FullRunCommand[] = runs.map((r) => ({
      id: r.command.id,
      command: r.command.command,
      cwd: normalizeCwd(r.command.cwd),
      evidence: r.evidence,
      status: r.fields['status'] ?? '',
      exit: r.fields['exit'] ?? '',
      passed: r.passed && r.setupFailure === undefined,
      executed: !r.reused,
      ...(r.setupFailure !== undefined ? { setupFailure: r.setupFailure } : {}),
    }));
    return {
      format: 'mp412.full-run.v1',
      id: run,
      mission: req.mission,
      commit: req.commit,
      tree,
      environment,
      suite,
      startedAt,
      endedAt: ctx.now(),
      commands: cmds,
      passed: cmds.length === req.suite.length && cmds.every((c) => c.passed),
      failing: runs.filter((r) => !r.passed || r.setupFailure !== undefined).map((r) => ({ id: r.command.id, tail: r.tail })),
      by: req.by,
      cites: req.cites,
      reusedFrom: null,
      leaf,
    };
  };
  const r = await runOnCommit(ctx, {
    mission: req.mission,
    commit: req.commit,
    commands,
    purpose: req.by === 'reviewer' ? `full run for the integration Reviewer ${dispatch ?? ''}`.trim() : `full run decided by the PM (${req.cites.words ?? req.cites.authority ?? 'no citation'})`,
    declaration: { by: 'mp', checkout: 'clean', declared: true },
    fields: { fullRun: 'true' },
    tail: FULL_RUN_TAIL,
    runPrefix: 'full',
    doNotReuse,
    also: (tx, runs, run) => {
      writeMarker(tx, bodyOf(run, runs, runLeaf(req.mission, run), env.identity), dispatch);
      return run;
    },
  });
  if (!r.reused && typeof r.result === 'string') return { marker: readMarker(ctx, req.mission, r.result), reused: false };
  // every command stood on a passing declared run of this commit (the same environment): recorded as this full run, nothing executed
  const own = newRunId('full');
  const body = bodyOf(own, r.runs, null, env.identity);
  ctx.memory.write({ op: `full-run:${own}`, payload: { id: own, evidence: body.commands.map((c) => c.evidence) } }, (tx) => writeMarker(tx, body, dispatch));
  return { marker: readMarker(ctx, req.mission, own), reused: false };
}

function stripRevision(m: FullRunMarker): FullRunBody {
  const { revision: _revision, ...body } = m;
  void _revision;
  return body;
}

function readMarker(ctx: ProcessContext, mission: string, id: string): FullRunMarker {
  const data = ctx.memory.data;
  const m = ctx.memory.read((db) => fullRunMarkers(db, data, mission).find((x) => x.id === id));
  if (m === undefined) throw new Error(`the full-run marker ${id} was not recorded`);
  return m;
}

// ---------------------------------------------------------------- mp pm full-run (D-7)

/**
 * The outputs a delivery of the mission carries when none are named: the accepted product of each
 * task of its effective plans, as the closing snapshot reads them (execution.ts lineAcceptance).
 */
export function missionOutputs(db: Db, data: { text(h: string): string }, mission: string): string[] {
  const body = <T>(h: string): T => JSON.parse(data.text(h)) as T;
  const tasks = [...new Set(flowEvents(db, { mission: mission as MissionId, line: PLAN_LINE, event: 'effective', limit: 10_000 }).flatMap((e) => body<{ tasks: readonly string[] }>(e.body).tasks))];
  const out: string[] = [];
  for (const t of tasks) {
    const sel = lineAcceptance(flowEvents(db, { mission: mission as MissionId, line: taskLine(t), limit: 10_000 }).map((e) => ({ revision: Number(e.revision), event: e.event, key: e.key, body: body<unknown>(e.body) })));
    if (!sel.abandoned && sel.product !== null) out.push(sel.product);
  }
  return out;
}

/**
 * The candidate `mp pm deliver` would build for these outputs (the delivery's manifest and its
 * candidate builder, buildCandidate), built on the target branch's head; nothing is recorded (no
 * delivery, no intent, no ref). P4's delivery may replace this with its own no-record mode.
 */
export async function buildDeliveryCandidate(ctx: ProcessContext, req: { readonly mission: string; readonly selected: readonly DeliveryTarget[] }): Promise<{ readonly commit: string; readonly base: string }> {
  const m = ctx.memory;
  const labels = labelView(ctx);
  if (labels.recomputing) throw new ProcessError('NOT_ALLOWED', 'the labels are recomputing: nothing was built; run the same command again shortly (if it lasts, WI-32: mp pm drain)');
  const view = memoryProofView(m, labels);
  const built = buildManifest(view, req.selected);
  if (built.kind !== 'manifest') {
    const why = built.kind === 'unknown' ? `the outputs name objects the memory does not know: ${built.missing.map((t) => t.id).join(', ')}` : built.kind === 'unplaced' ? `these versions have no commit: ${built.versions.join(', ')}` : `the manifest is incompatible (${built.conflicts.length} path(s) in different versions): an integration task is needed first`;
    throw new ProcessError('NOT_ALLOWED', `no delivery candidate can be built: ${why}`);
  }
  const head = ctx.git.runSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${ctx.targetBranch}^{commit}`], { cwd: ctx.projectDir });
  if (head.code !== 0) throw new ProcessError('NOT_ALLOWED', `the target branch ${ctx.targetBranch} does not exist`);
  const base = gitOid(head.stdout.toString('utf8').trim());
  mkdirSync(m.paths.tmp, { recursive: true });
  const scratch = mkdtempSync(join(m.paths.tmp, `full-run-${req.mission}-`));
  let attributes: AttributeEvaluator | null = null;
  try {
    const repo = await discoverRepo(ctx.git, ctx.projectDir);
    const description = await readTransformDescription(ctx.git, repo, ctx.projectDir);
    attributes = await AttributeEvaluator.create(ctx.git, repo, description, scratch);
    const ident = ctx.ident();
    const c = await buildCandidate({
      git: ctx.git,
      repo,
      manifest: built.manifest,
      base,
      attributes,
      snapshotDir: join(scratch, 'candidate'),
      message: `mission-pipeline: full-run candidate of ${req.mission} (${req.selected.map((t) => t.id).join(', ')})`,
      author: ident,
      committer: ident,
      versionOf: (id) => view.object(id),
      alreadyLaid: await landedVersions(ctx.git, repo, m, base, (id) => view.object(id)),
    });
    if (c.kind === 'conflict') throw new ProcessError('NOT_ALLOWED', `the outputs conflict on the target branch's head (${c.conflicts.map((x) => x.path).join(', ')}): an integration task resolves them first`);
    if (c.kind === 'description-mismatch') throw new ProcessError('NOT_ALLOWED', `these versions rest on another transform description: ${c.versions.join(', ')} (WI-19)`);
    return { commit: c.candidate.commit, base };
  } finally {
    attributes?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The missions whose work the outputs carry (an unknown object adds none; the manifest refuses it later). */
function outputMissions(db: Db, outputs: readonly DeliveryTarget[]): string[] {
  const out = new Set<string>();
  for (const t of outputs) {
    const r = factById(db, t.kind === 'unit' ? 'proof.unit' : 'object.version', t.id)?.record as { mission?: unknown } | undefined;
    if (typeof r?.mission === 'string') out.add(r.mission);
  }
  return [...out];
}

export interface PmFullRunRequest {
  readonly mission: string;
  /** The user's words that agreed to this full run (W-<n>), or */
  readonly words?: string | null;
  /** an authorization item in force that leaves this decision to the PM (D-8). */
  readonly authority?: string | null;
  readonly reason: string;
  /** The outputs whose delivery candidate it runs on (default: the mission's accepted products). */
  readonly outputs?: readonly DeliveryTarget[];
}

/**
 * `mp pm full-run` (D-7, D-8): the full suite on the candidate `mp pm deliver` would build for the
 * outputs, recorded with a marker citing the words or the authorization item and the reason. With
 * neither words nor an authorization item in force it is refused: the record shows who decided.
 */
export async function pmFullRun(ctx: ProcessContext, req: PmFullRunRequest): Promise<FullRunResult & { readonly candidate: string; readonly outputs: readonly string[] }> {
  const words = req.words ?? null;
  const authority = req.authority ?? null;
  // a stop stops (§6.6): the safety floor, refused before any other refusal (the outputs' missions are checked once they are known)
  ctx.memory.read((db) => assertScopeNotStopped(db, deriveScope(db, req.mission as MissionId), 'this full run'));
  if (words === null && authority === null) throw new ProcessError('NOT_ALLOWED', 'a full run at the end of a mission is decided by the user (--words W-<n>: their agreement) or under an authorization they gave (--authority <item-id>): the record must show who decided; nothing was run');
  if (req.reason.trim() === '') throw new ProcessError('NOT_ALLOWED', '--reason: why the changes since the last full run are worth another one');
  if (ctx.fullSuite.length === 0) throw new ProcessError('NOT_ALLOWED', 'no full suite is configured (config.json fullSuite): there is nothing to run');
  let cited: string | null = null;
  if (authority !== null) {
    let line: string;
    try {
      line = authority.startsWith('item.') ? authority : itemLine(req.mission, authority);
    } catch (e) {
      throw new ProcessError('NOT_ALLOWED', `--authority ${authority}: ${(e as Error).message}`);
    }
    const items = await currentItems(flowCtx(ctx.ports(), req.mission as MissionId));
    const item = items.find((i) => i.line === line);
    if (item === undefined || item.type !== 'authorization' || item.state !== 'valid') {
      throw new ProcessError('NOT_ALLOWED', `${authority} is not an authorization item in force in mission ${req.mission}${item !== undefined ? (item.type !== 'authorization' ? ` (it is a ${item.type} item)` : ` (it is ${item.state})`) : ''}: nothing was run`);
    }
    cited = line;
  }
  const outputs = req.outputs !== undefined && req.outputs.length > 0 ? req.outputs : ctx.memory.read((db) => missionOutputs(db, ctx.memory.data, req.mission)).map((id): DeliveryTarget => ({ kind: 'object', id: id as never }));
  // the scope a delivery of these outputs would have (the delivery's resolver), before anything is built or run
  const scope = ctx.memory.read((db) => deriveScope(db, req.mission as MissionId, outputMissions(db, outputs)));
  ctx.memory.read((db) => assertScopeNotStopped(db, scope, 'this full run'));
  if (outputs.length === 0) throw new ProcessError('NOT_ALLOWED', `mission ${req.mission} has no accepted product yet: there is no delivery candidate to run the full suite on`);
  const cand = await buildDeliveryCandidate(ctx, { mission: req.mission, selected: outputs });
  const r = await runFullSuite(ctx, { mission: req.mission, commit: cand.commit, suite: ctx.fullSuite, by: 'pm', cites: { words, authority: cited, reason: req.reason.trim().slice(0, 2000), dispatch: null }, scope });
  return { ...r, candidate: cand.commit, outputs: outputs.map((t) => t.id) };
}
