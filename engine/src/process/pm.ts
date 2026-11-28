import { requireDriver, liveSecretary, requirePm } from '../memory/resident.ts';
import { wordsAuthority, tagWordsInTx, type TagsReport, type WordsDependency } from '../memory/words.ts';
import type { WordsTag } from '../memory/events.ts';
import { constraintApplies, constraintPatternProblem, CONSTRAINT_PATTERN_FORMS, withdrawConstraint } from '../memory/domain/constraints.ts';
import { refreshDispatchCard, STARTS_CHANGED } from '../seat/cards/refresh.ts';
import { acceptedProduct, lineAcceptance } from '../flow/execution.ts';
import { taskLine } from '../flow/plandoc.ts';
// The PM's dispatch loop and commands (design 4.1 §5.1, §5.4, §6.5, §6.6; decisions 8, 15, 18).
//
//   pmNext      one bounded label batch (A2), the landing recovery (A4), worktrees of finished
//               dispatches removed, the process advanced; then, notices first (marked delivered):
//               the ready steps (seat, task, mission, purpose, parallel), the steps held (a stop,
//               a lease, the git-writes hold, an exploration planned after others not settled
//               yet; 4.4: a hold or a disk limit, holds.ts), what waits on the user, the dispatches in flight with their age. 4.1.2:
//               after an environment change, no renew step; one notice per change names how
//               many runs current proof rests on are from older environments
//   pmDispatch  claims a ready step once (A1 claimDispatch): the dispatch id, the card leaf
//               `missions/<m>/dispatches/<d>/card.md`, its material leaves, its leases; a
//               Constructor's worktree is created at the card's commit (A4); an exploration's step
//               names the exploration's snapshot in force, taken again before its first step runs
//               when the target branch moved (explorationSnapshot.ts)
//   pmRelease   `--ended` / `--abandoned` (§5.4): the worktree removed or kept; the step queued
//               again at once, counted on the lineage's re-dispatch loop (decision 15: two
//               re-dispatches, then WI-08 and the Secretary)
//   pmRenew     the PM's explicit tool after an environment change (never a ready step, 4.1.2):
//               the declared commands of the affected runs rerun on clean checkouts; equal outputs
//               renew the evidence (A2 recordRenewedRun)
//   pmDrain     A2's drain (WI-32)
//   pmStop      a stop, written before anything queued; "stop recorded; N dispatches in flight"
// and the PM's flow commands (requirements with their verbatim quote, constraints, PM plan
// batches, answers, grants, legalization), each followed by advancing the process, plus the
// delivery (A4 deliver with this package's LabelView and the full-run status of the candidate's
// tree; no command runs, 4.1.2 D-7), the WI-05 rebuild and the landing.
// Every write of an `mp pm` command carries the command and the PM's filler (§3.2 item 13).

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceDir } from '../git/workspace.ts';
import { canonicalJson, sha256 } from '../common/hash.ts';
import type { ContentHash, EvidenceId, MissionId, StopId } from '../common/ids.ts';
import type { EvidenceRecord, LoopKind } from '../common/records.ts';
import { drain, labelBatch, labelStatus, recordRenewedRun, renewalCandidates, type DrainReport, type RenewalJudgment } from '../evaluator/index.ts';
import { replacementFollowsOriginal } from '../evaluator/renew.ts';
import { reusableMethodRun } from '../evaluator/runs.ts';
import { effectiveEvidence } from '../evaluator/semantics.ts';
import { StoredIndex } from '../evaluator/store.ts';
import { deliver, rebuildDelivery, type DeliveryFullRun, type DeliveryResult } from '../delivery/delivery.ts';
import type { DeliveryTarget } from '../delivery/proofView.ts';
import { land, recoverLandings, type LandingResult, type RecoveryReport } from '../git/land.ts';
import {
  acquireLease,
  appendRecords,
  checkFiller,
  checkQuote,
  claimDispatch,
  commitStop,
  dispatchInfo,
  dispatchLeaf,
  LedgerError,
  leases,
  listDispatches,
  loopState,
  releaseDispatch,
  stoppedFor,
  taskInfo,
  taskQueue,
  wordsEntry,
  wordsOfMessage,
  latestUserWords,
  recordWords,
  flowEvents,
  flowMissions,
  flowEventExists,
  type Db,
  type DispatchInfo,
  type Filler,
  type StopRequest,
  type WriteTx,
} from '../memory/index.ts';
import { constraintLine, currentConstraints, recordItem, recordConstraint, withdrawItem, type ItemSource, type ItemType } from '../flow/requirements.ts';
import { planInEffect, submitPmBatch } from '../flow/planning.ts';
import { constraintsForTask } from '../seat/cards/dynamic.ts';
import { recordRepair } from '../flow/repair.ts';
import type { RepairKind } from '../flow/plandoc.ts';
import { answerEscalation, answerByPm, escalation, type DecisionBody, type EscalationBody } from '../flow/secretary.ts';
import { eventsOf, flowCtx, missionClosed } from '../flow/context.ts';
import { explorationState } from '../flow/exploration/flow.ts';
import { pendingTasks } from '../flow/exploration/machine.ts';
import { pmAmendAttempts, pmRerunAttempt, type AttemptsAmended, type AttemptsRerun } from './explorationAttempts.ts';
import { pmResnapshotExploration, type Resnapshotted } from './explorationSnapshot.ts';
import { RENEW_LINE, REVIEW_NEEDED, SECRETARY_LINE, type ReviewNeededBody } from '../flow/plandoc.ts';
import { scopesOverlap } from '../flow/mechanical.ts';
import { legalizationState, requestLegalization, startLegalization, type LegalizationRequest } from '../flow/audit/index.ts';
import type { ReconcileReport } from '../flow/engine.ts';
import type { ConstraintScope, ObjectScope } from '../common/records.ts';
import { renderSeatCard, handBackFiles } from '../seat/card.ts';
import type { MaterialRef } from '../seat/cards/common.ts';
import type { DecisionOption } from '../seat/cards/secretary.ts';
import { seatCardEntry } from '../seat/cards/index.ts';
import { advance } from './advance.ts';
import type { ProcessContext } from './context.ts';
import { ProcessError } from './errors.ts';
import { labelView } from './labelView.ts';
import { listNotices, markNotices, type PmNotice } from './notices.ts';
import { DISPATCH_LINE, REDISPATCH_LOOP, handbackDoc, raiseNotice, taskStatus, type TaskSpecDoc } from './ports.ts';
import { runCwd, runOnCommit, type DeclaredCommand, type RecordedRun } from './runs.ts';
import { fullRunLine, heldByClose } from './close.ts';
import { authorizationInForce, fullRunStatus } from './fullRuns.ts';
import { CONFIG_KEY, REVIEWS_WAIVER, WAIVABLE_CHECKS, waiversInForce, type ReviewsWaiverBody } from '../flow/waivers.ts';
import { PLAN_LINE } from '../flow/plandoc.ts';
import { dispatchOver, sweepTmp, SWEEP_BUDGET_MS } from './housekeeping.ts';
import { assertScopeNotStopped, deriveScope, type WorkScope } from '../delivery/scope.ts';
import { cardForSeat, noticeOlderEnvironment } from './environmentLabels.ts';
import { claimExplorationStep, explorationSeat } from './explorationSnapshot.ts';
import { heldByPredecessors } from './explorationAfter.ts';
import { materialLeaf } from './seat.ts';
import { carriedRunLines, detachedRunNotes, stopDetachedRuns, type DetachedRunNote } from './detached.ts';
import { checkAfters, diskLimitPassed, heldByHolds, heldWhy, holdRef, holdsInForce, holdsOn, isConstructorStep, type AfterChecks, type HoldRef } from './holds.ts';

// ---------------------------------------------------------------- shared

/** §4.1: one bounded label batch before a decision that reads labels (the frontier stays stored when it does not finish). */
function settleLabels(ctx: ProcessContext): void {
  if (ctx.secretary === null && liveSecretary(ctx.memory) !== null) return;
  try {
    labelBatch(ctx.memory);
  } catch {
    /* the frontier stays stored: the decision reports "recomputing" and the PM retries or drains (WI-32) */
  }
}

/** A filler from the command line ("<harness>/<model>", decision 8), or as an object. */
export function parseFiller(x: string | Filler | null | undefined): Filler | null {
  if (x === null || x === undefined) return null;
  if (typeof x !== 'string') return checkFiller(x);
  const i = x.indexOf('/');
  return checkFiller(i < 0 ? { harness: x, model: null } : { harness: x.slice(0, i), model: x.slice(i + 1) || null });
}

/** A write of an `mp pm` command: its op, the command and the PM's filler (§3.2 item 13). */
function pmWrite<T>(ctx: ProcessContext, command: string, op: string, payload: unknown, fn: (tx: WriteTx) => T, filler?: Filler | null): T {
  return ctx.memory.write({ op, payload, command, filler: filler ?? ctx.filler }, fn);
}

function specOf(ctx: ProcessContext, card: string): TaskSpecDoc {
  return JSON.parse(ctx.memory.data.text(card)) as TaskSpecDoc;
}

/** A one-line purpose of a step, from its card (§5.1). */
export function purposeOf(card: { readonly seat: string } & Readonly<Record<string, unknown>>): string {
  const c = card as Record<string, any>;
  const clip = (s: string): string => (s.length <= 160 ? s : `${s.slice(0, 157)}...`);
  switch (card.seat) {
    case 'constructor':
      return clip(`build: ${c['goal']}`);
    case 'reviewer':
      return `review ${c['target']} (${c['review']})`;
    case 'calibrator-1':
      return `audit PM plan ${c['target']} against the user's words`;
    case 'calibrator-2':
      return `audit detailed plan ${c['target']} against PM plan ${c['pmPlan']}`;
    case 'architect-decompose':
      return `decompose PM plan ${c['pmPlan']?.object} (round ${c['pmPlan']?.round})`;
    case 'architect-feasibility':
      return `feasibility review of ${c['target']}`;
    case 'architect-repair':
      return clip(`repair ${c['repair']?.id} (${c['repair']?.kind}) of plan ${c['dplan']}: ${c['repair']?.text}`);
    case 'secretary':
      return clip(`decide ${c['request']?.id} (${c['request']?.source}): ${c['request']?.summary}`);
    case 'crititor':
      return `${c['mode'] === 'discuss' ? 'discuss the framing of' : 'attack'} exploration ${c['exploration']?.id}${c['target'] !== null ? ` version ${c['target']}` : ''} (round ${c['round']})${c['fresh'] === true ? ', closing attacker' : ''}`;
    case 'stabilizer':
      return `judge round ${c['round']} of exploration ${c['exploration']?.id} for drift`;
    case 'researcher-author':
      return `author exploration ${c['exploration']?.id} (round ${Number(c['round']) + 1})`;
    case 'researcher-interpreter':
      return `interpret the attempts of exploration ${c['exploration']?.id}`;
    case 'researcher-reader':
    case 'constructor-experiment':
      return `blind evidence run ${c['evidence']?.id}`;
    case 'auditor-node':
      return `backfill the reviews of ${c['target']?.id} (legalization ${c['legalization']})`;
    case 'auditor-chain':
      return `judge the chain of legalization ${c['legalization']}`;
    default:
      return clip(String(c['duties'] ?? card.seat).split('\n')[0] ?? card.seat);
  }
}

// ---------------------------------------------------------------- mp pm next

export interface ReadyStep {
  /** What `mp pm dispatch` takes: the task id. */
  readonly step: string;
  readonly seat: string;
  /** The card kind. */
  readonly kind: string;
  readonly mission: MissionId;
  readonly purpose: string;
  /** Whether it can run while the other ready steps and the dispatches in flight run (no shared write path or exclusive resource). */
  readonly parallel: boolean;
  readonly priority: number;
  /** Earlier dispatches of this step (released ones count against the lineage's loop, decision 15). */
  readonly dispatches: number;
}

export interface HeldStep {
  readonly step: string;
  readonly seat: string;
  readonly kind: string;
  readonly mission: MissionId;
  readonly purpose: string;
  readonly why: string;
  readonly wi: string | null;
  /** 4.4 (F8): a production step of a closed mission (`mp sec next` counts these). */
  readonly closedMission?: true;
  /** 4.4 (G6): the holds in force that hold it, each with its id and reason (holds.ts). */
  readonly holds?: readonly HoldRef[];
  /** 4.4 (F6, H-3): a new Constructor step held because a disk limit of config.json is passed. */
  readonly diskLimit?: true;
}

export interface InFlight {
  readonly dispatch: string;
  readonly step: string;
  readonly seat: string;
  readonly mission: MissionId;
  readonly ageMs: number;
  readonly filler: Filler | null;
  readonly worktree: string | null;
}

export interface UserWait {
  readonly mission: MissionId;
  readonly escalation: string;
  readonly subject: string;
  readonly summary: string;
  readonly options: readonly string[];
  readonly why: string;
}

export interface NextReport {
  /** Not acknowledged, undelivered first (shown now: marked delivered). */
  readonly notices: readonly PmNotice[];
  readonly ready: readonly ReadyStep[];
  readonly held: readonly HeldStep[];
  readonly waitingOnUser: readonly UserWait[];
  readonly inFlight: readonly InFlight[];
  /** 4.1.2: the runs current proof rests on that were recorded under an older environment identity (they still count; `mp pm renew` is never a ready step; a notice tells the PM once per change). */
  readonly olderEnvironmentRuns: number;
  readonly labels: { readonly recomputing: boolean; readonly toVisit: number; readonly toRecompute: number; readonly since: number | null };
  readonly landings: RecoveryReport | null;
  /** Flow steps that failed this time (each also a WI-20 notice). */
  readonly errors: readonly string[];
  /** 4.1.3 (#30): detached runs that ended (finished, or lost: their worker is gone) for a dispatch still in flight. */
  readonly detachedRuns: readonly DetachedRunNote[];
}

/** Steps conflict when they write overlapping paths or need the same exclusive resource. */
function conflicts(a: TaskSpecDoc, b: TaskSpecDoc): boolean {
  if ((a.exclusive ?? []).some((r) => (b.exclusive ?? []).includes(r))) return true;
  return a.writeScope !== undefined && b.writeScope !== undefined && scopesOverlap(a.writeScope, b.writeScope).length > 0;
}

/**
 * 4.4 (F14, #54): stable production that waits because the plan's deciding passes do not cover a current
 * object constraint (flow/plan-constraints.ts, its open gap) is a held line with WI-34; no step is queued
 * for it, so nothing else shows it. Fast mode goes on and holds nothing.
 */
function constraintGapHolds(db: Db, data: { text(h: string): string }): HeldStep[] {
  const out: HeldStep[] = [];
  // the missions the flows run, read by the (mission, line, event) index; a closed mission's production is held by its close
  const closed = new Set((db.stmt("SELECT mission FROM missions WHERE state = 'closed'").all() as Array<{ mission: string }>).map((r) => r.mission));
  for (const m of flowMissions(db)) {
    if (closed.has(m)) continue;
    if (flowEvents(db, { mission: m, line: PLAN_LINE, event: 'plan-constraint-gap', limit: 1 }).length === 0) continue;
    const eff = flowEvents(db, { mission: m, line: PLAN_LINE, event: 'effective', limit: 10_000 }).filter((e) => !e.key.includes('#')).at(-1);
    if (eff === undefined || (JSON.parse(data.text(eff.body)) as { mode?: string }).mode !== 'stable') continue;
    const closedGaps = new Set(flowEvents(db, { mission: m, line: PLAN_LINE, event: 'plan-constraint-gap-closed', limit: 10_000 }).map((e) => e.key));
    for (const g of flowEvents(db, { mission: m, line: PLAN_LINE, event: 'plan-constraint-gap', limit: 10_000 }).filter((e) => !closedGaps.has(e.key))) {
      const gap = JSON.parse(data.text(g.body)) as { plan: string; uncovered: Array<{ line: string; version: string }> };
      out.push({ step: gap.plan, seat: 'production', kind: 'plan-constraint-gap', mission: m, purpose: `stable production of ${m}`, why: `stable production waits: plan ${gap.plan} has current deciding passes that do not cover the object constraint(s) ${gap.uncovered.map((c) => `${c.line} (${c.version})`).join(', ')}; the PM takes an exit of WI-34 with the user's words`, wi: 'WI-34' });
    }
  }
  return out;
}

/**
 * The ready and held steps, the dispatches in flight and what waits on the user, in one read. `afters`:
 * production's verdict on the unpinned acceptances a hold's `after` names (holds.ts checkAfters).
 */
export function readSteps(ctx: ProcessContext, o: { readonly afters?: AfterChecks } = {}): Pick<NextReport, 'ready' | 'held' | 'inFlight' | 'waitingOnUser'> {
  const now = ctx.now();
  const gitHeld = ctx.memory.gitHold();
  const disk = diskLimitPassed(ctx);
  const group = ctx.secretary !== null ? 'sec' : 'pm';
  return ctx.memory.read((db) => {
    const holds = holdsInForce(db, ctx.memory.data, now, o.afters);
    const inFlightRows = listDispatches(db, { state: 'in-flight', limit: 10_000 });
    const flightSpecs: TaskSpecDoc[] = [];
    const inFlight: InFlight[] = inFlightRows.map((d) => {
      const t = db.stmt('SELECT card FROM tasks WHERE task = ?').get(d.task) as { card: string } | undefined;
      if (t !== undefined) flightSpecs.push(specOf(ctx, t.card));
      return { dispatch: d.dispatch, step: d.task, seat: d.seat, mission: d.mission, ageMs: Math.max(0, now - d.createdAt), filler: d.filler, worktree: d.worktree };
    });
    const held: HeldStep[] = [];
    const candidates: Array<{ spec: TaskSpecDoc; step: ReadyStep }> = [];
    const leased = new Map(leases(db).map((l) => [l.resource, l.dispatch]));
    for (const q of taskQueue(db)) {
      const spec = specOf(ctx, q.card);
      const kind = spec.card.seat;
      const entry = seatCardEntry(kind);
      const base = { step: q.task, seat: entry.seat, kind, mission: q.mission, purpose: purposeOf(spec.card) };
      // 4.4 (G6, review p5-8): the holds on the step are named beside any earlier reason, so a stop's release shows none for the first time
      const onIt = holdsOn(holds, q, spec);
      const hold = (x: Omit<HeldStep, keyof typeof base>): void => { held.push(onIt.length === 0 ? { ...base, ...x } : { ...base, ...x, why: `${x.why}; also ${heldWhy(onIt, group)}`, holds: onIt.map((h) => holdRef(h.placed)) }); };
      if (heldByClose(db, spec)) {
        hold({ why: `mission ${q.mission} is closed (§6.7): its production steps wait until it is opened again (mp pm mission ${q.mission})`, wi: null, closedMission: true });
        continue;
      }
      if (stoppedFor(db, { mission: q.mission, capabilities: spec.capabilities })) {
        hold({ why: 'a stop covers it (the stop report covers it; it waits until the stop is narrowed or released)', wi: null });
        continue;
      }
      if (entry.exportsProduct === true && gitHeld !== null) {
        hold({ why: `git writes are held since this folder was moved or copied: ${gitHeld.reason}`, wi: 'WI-31' });
        continue;
      }
      // an exploration planned after others starts once they settled (explorationAfter.ts)
      const after = heldByPredecessors(db, ctx.memory.data, spec);
      if (after !== null) {
        hold({ why: after, wi: null });
        continue;
      }
      // 4.4 (G6, F6): a hold in force, or a disk limit passed for a new Constructor step (holds.ts)
      const busy = (spec.exclusive ?? []).filter((r) => leased.has(r));
      const lease = `waits for ${busy.map((r) => `${r} (leased to ${leased.get(r)})`).join(', ')}`;
      const byHold = heldByHolds(holds, disk, q, spec, group);
      if (byHold !== null) {
        // review p5-8: a lease the step also waits for is named beside the hold
        held.push({ ...base, ...byHold, ...(busy.length > 0 ? { why: `${byHold.why}; also ${lease}`, wi: 'WI-28' } : {}) });
        continue;
      }
      if (busy.length > 0) {
        hold({ why: lease, wi: 'WI-28' });
        continue;
      }
      const dispatches = dispatchCount(db, q.task);
      candidates.push({ spec, step: { ...base, parallel: true, priority: spec.priority, dispatches } });
    }
    held.push(...constraintGapHolds(db, ctx.memory.data));
    candidates.sort((a, b) => b.step.priority - a.step.priority);
    const ready = candidates.map((c, i) => {
      const others = [...flightSpecs, ...candidates.filter((_, j) => j !== i).map((x) => x.spec)];
      return { ...c.step, parallel: !others.some((o) => conflicts(c.spec, o)) };
    });
    // escalations waiting on the user: handed to the user, or classified needs-user, with no answer yet
    const waitingOnUser: UserWait[] = [];
    const missions = db.stmt("SELECT DISTINCT mission FROM flow_events WHERE line = ? AND event = 'escalation'").all(SECRETARY_LINE) as Array<{ mission: string }>;
    for (const { mission } of missions) {
      const m = mission as MissionId;
      const ev = (event: string) => new Map(flowEvents(db, { mission: m, line: SECRETARY_LINE, event, limit: 10_000 }).map((e) => [e.key, e]));
      const answered = ev('user-answer');
      const applied = ev('applied');
      const toUser = ev('to-user');
      const decisions = ev('decision');
      for (const e of flowEvents(db, { mission: m, line: SECRETARY_LINE, event: 'escalation', limit: 10_000 })) {
        if (answered.has(e.key) || applied.has(e.key)) continue;
        const d = decisions.get(e.key);
        const dBody = d === undefined ? null : (JSON.parse(ctx.memory.data.text(d.body)) as DecisionBody);
        const t = toUser.get(e.key);
        const why = t !== undefined ? (JSON.parse(ctx.memory.data.text(t.body)) as { why: string }).why : dBody !== null && (dBody.classification === 'needs-user' || dBody.classification === 'needs-pm') ? dBody.notice || dBody.reason : null;
        if (why === null) continue;
        const esc = JSON.parse(ctx.memory.data.text(e.body)) as EscalationBody;
        waitingOnUser.push({ mission: m, escalation: esc.id, subject: esc.subject, summary: esc.summary, options: esc.options.filter((o) => o !== 'ask-user' && o !== 'ask-pm'), why });
      }
    }
    return { ready, held, inFlight, waitingOnUser };
  });
}

/** Worktrees of dispatches that are over (handed back, released ended): removed, best effort (a crash after the hand-back left them). */
function tidyWorktrees(ctx: ProcessContext): void {
  if (ctx.memory.gitHold() !== null) return;
  const done = ctx.memory.read((db) => [...listDispatches(db, { state: 'handed-back', limit: 10_000 }), ...listDispatches(db, { state: 'released', limit: 10_000 }).filter((d) => d.released === 'ended')].filter((d) => d.worktree !== null));
  for (const d of done) {
    try {
      // as mp pm clean: no folder, nothing to remove (a removal asks git for its worktree list every time)
      if (!existsSync(workspaceDir(ctx.memory.paths, d.dispatch))) continue;
      ctx.workspaces().remove(d.dispatch);
    } catch {
      /* kept: tried again next time */
    }
  }
}

/** What a pass's reconciliation found, before its report is read. */
export interface Reconciled {
  readonly olderEnvironmentRuns: number;
  readonly landings: RecoveryReport | null;
  readonly errors: readonly string[];
  readonly detachedRuns: readonly DetachedRunNote[];
  /** 4.4 (G6, review p5-3): production's verdict on the unpinned acceptances a hold's `after` names (holds.ts checkAfters). */
  readonly afters?: AfterChecks;
}

/** `mp pm next` (§5.1 step 1). */
async function driver_pmNext(ctx: ProcessContext, o: { readonly markDelivered?: boolean } = {}): Promise<NextReport> {
  const { report } = readNextReport(ctx, await reconcileNext(ctx));
  if (o.markDelivered !== false) markNotices(ctx.memory, report.notices.filter((n) => n.state === 'undelivered').map((n) => n.id), 'delivered');
  return report;
}

/**
 * 4.4 (F8): the report of a pass in one read, after its reconciliation: the steps, the notices and the
 * labels as of one revision, which it returns too (a change that lands later is after it).
 */
export function readNextReport(ctx: ProcessContext, recon: Reconciled): { readonly report: NextReport; readonly revision: number } {
  return ctx.memory.read((db) => {
    const revision = Number(ctx.memory.head());
    const steps = readSteps(ctx, recon.afters !== undefined ? { afters: recon.afters } : {});
    const notices = listNotices(db, ctx.memory.data, ctx.secretary !== null ? {audience: 'secretary'} : {}).sort((a, b) => (a.state === b.state ? a.revision - b.revision : a.state === 'undelivered' ? -1 : 1));
    const st = labelStatus(db);
    return { revision, report: { notices, ...steps, olderEnvironmentRuns: recon.olderEnvironmentRuns, labels: { recomputing: st.recomputing, toVisit: st.toVisit, toRecompute: st.toRecompute, since: st.since }, landings: recon.landings, errors: recon.errors, detachedRuns: recon.detachedRuns } };
  });
}

/** A pass's reconciliation: labels, landings, housekeeping, the flows, the environment notice and the detached runs. */
async function reconcileNext(ctx: ProcessContext): Promise<Reconciled> {
  ctx.environment();
  settleLabels(ctx);
  let landings: RecoveryReport | null = null;
  try {
    landings = await recoverLandings(ctx.gitCtx);
  } catch {
    landings = null;
  }
  tidyWorktrees(ctx);
  // 4.1.2: scratch nobody alive owns, the tmp/ of dispatches that are over, unheld checkouts (bounded)
  try {
    sweepTmp(ctx, { budgetMs: SWEEP_BUDGET_MS });
  } catch {
    /* housekeeping: tried again on the next call */
  }
  const errors: string[] = [];
  for (const r of await advance(ctx)) for (const e of r.errors) errors.push(`${r.mission} ${e.step}: ${e.message}`);
  // 4.1.2: an environment change is told once (runs from older environments still count), never a ready step
  const olderEnvironmentRuns = noticeOlderEnvironment(ctx);
  // 4.1.3 (#30): a detached run that ended while its dispatch is in flight (its seat may be gone); a lost one is recorded so
  let detachedRuns: DetachedRunNote[] = [];
  try {
    detachedRuns = detachedRunNotes(ctx);
  } catch (e) {
    errors.push(`detached runs: ${(e as Error).message}`);
  }
  // 4.4 (G6, review p5-3): a hold's `after` counts an acceptance as production does; checked here, where writes are allowed
  let afters: AfterChecks = new Map();
  try {
    afters = await checkAfters(ctx);
  } catch {
    /* unchecked: the holds stay, the safe side */
  }
  return { olderEnvironmentRuns, landings, errors, detachedRuns, afters };
}

/** `mp pm alerts --ack <id...>`: notices acknowledged (never back). */
function driver_pmAck(ctx: ProcessContext, ids: readonly string[]): { readonly acknowledged: number } {
  if (ctx.secretary !== null) {const allowed = new Set(listNotices(ctx.memory, ctx.memory.data, {audience: 'secretary', includeAcknowledged: true}).map((n) => n.id)); if (ids.some((id) => !allowed.has(id))) throw new ProcessError('NOT_ALLOWED', 'Secretary acknowledgments name notices addressed to the Secretary; PM notices resolve through the PM inbox');}
  return { acknowledged: markNotices(ctx.memory, ids, 'acknowledged') };
}

// ---------------------------------------------------------------- mp pm dispatch

export interface Dispatched {
  readonly dispatch: string;
  readonly step: string;
  readonly seat: string;
  readonly kind: string;
  readonly mission: MissionId;
  /** The card as the seat receives it (`mp seat <id> card` prints the same). */
  readonly card: string;
  readonly cardLeaf: string;
  /** 4.4 (F17): the sha256 of the card's text; what is stored of a claim is its leaf and this hash. */
  readonly cardSha256: string;
  /** A Constructor's worktree, relative to the project folder. */
  readonly worktree: string | null;
  /** Where the seat writes its hand-back (decision 7). */
  readonly files: ReturnType<typeof handBackFiles>;
  /** The fixed prompt for the PM's harness (§5.1 step 3). */
  readonly prompt: string;
  /** 4.4 (F16): what the dispatch reports of its card's size to whoever dispatches it. */
  readonly size: CardSizeReport;
}

/**
 * 4.4 (F16; PM design G3 "Size"): a dispatch's report of its card, to whoever dispatches it (the Secretary
 * while one is live). It holds nothing and is never a notice to the PM. Today: the must-read pages, with a
 * warning above `mustReadWarnPages`.
 */
export interface CardSizeReport {
  readonly mustReadPages: number;
  readonly mustReadWarnPages: number;
  readonly warnings: readonly string[];
}

export function cardSizeReport(ctx: Pick<ProcessContext, 'mustReadWarnPages'>, card: Readonly<Record<string, unknown>>): CardSizeReport {
  const must = ((card['materials'] as MaterialRef[] | undefined) ?? []).filter((m) => m.mustRead);
  const pages = must.reduce((n, m) => n + m.pages, 0);
  const limit = ctx.mustReadWarnPages;
  return { mustReadPages: pages, mustReadWarnPages: limit, warnings: pages > limit ? [`its must-read material is ${pages} pages, above mustReadWarnPages (${limit}): ${must.map((m) => `${m.id} ${m.pages}`).join(', ')}`] : [] };
}

/** How long `mp pm dispatch` waits before it tries its write again after OVER_BUDGET: a short random delay, so a burst spreads out. */
export const DISPATCH_RETRY_MS = { min: 100, max: 600 } as const;

/**
 * 4.1.3 (#33): a burst of dispatches can push one write over its work budget by waiting, not by work.
 * The write rolled back cleanly, so it is tried once more by itself after a short random delay; a
 * second OVER_BUDGET says that a plain retry is safe and nothing was written. The budget is unchanged.
 */
function claimOnceMore<T>(claim: () => T): T {
  try {
    return claim();
  } catch (e) {
    if (!(e instanceof LedgerError) || e.code !== 'OVER_BUDGET') throw e;
  }
  const ms = DISPATCH_RETRY_MS.min + Math.floor(Math.random() * (DISPATCH_RETRY_MS.max - DISPATCH_RETRY_MS.min));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  try {
    return claim();
  } catch (e) {
    if (e instanceof LedgerError && e.code === 'OVER_BUDGET') throw new LedgerError('OVER_BUDGET', `${e.message}. mp pm dispatch tried twice (the machine is busy): nothing was written, and running the same command again is safe`);
    throw e;
  }
}

/** What a claim's write returns and the memory stores (a concurrent claim with the same op reads it back); 4.3 stored the card's text. */
export interface ClaimResponse {
  readonly dispatch: string;
  readonly cardLeaf: string;
  readonly cardSha256?: string;
  readonly card?: string;
  readonly worktree: string | null;
}

/** 4.4 (F17): the card a claim's response names, read from its leaf and checked against its hash; a 4.3 response carries the text. */
export function storedCard(ctx: ProcessContext, out: ClaimResponse): string {
  if (typeof out.card === 'string') return out.card;
  const r = ctx.memory.readLeaf(out.cardLeaf);
  if (r === null || r.status === 'missing' || r.text === null) throw new ProcessError('LEAF_MISSING', `the card of dispatch ${out.dispatch} (${out.cardLeaf}) is missing; the PM follows WI-30`, { wi: 'WI-30' });
  if (r.status === 'edited' || (out.cardSha256 !== undefined && r.sha256 !== out.cardSha256)) throw new ProcessError('LEAF_EDITED', `the card of dispatch ${out.dispatch} (${out.cardLeaf}) was edited after it was recorded; the PM follows WI-30`, { wi: 'WI-30' });
  return r.text;
}

/** `mp pm dispatch <step> --filled-by "<harness>/<model>"` (§5.1 step 2): the step is claimed once. */
function driver_pmDispatch(ctx: ProcessContext, step: string, o: { readonly filledBy?: string | Filler | null; readonly starts?: ReadonlyMap<string, boolean>; readonly afters?: AfterChecks } = {}): Dispatched {
  settleLabels(ctx);
  const filler = parseFiller(o.filledBy);
  const task = ctx.memory.read((db) => db.stmt('SELECT task, card, state, mission FROM tasks WHERE task = ?').get(step) as { task: string; card: string; state: string; mission: string } | undefined);
  if (task === undefined) throw new ProcessError('NOT_READY', `no step ${step} (mp pm next lists the ready steps)`);
  let spec = specOf(ctx, task.card);
  const entry = seatCardEntry(spec.card.seat);
  // 4.4 (F5): every claim of the step, uncapped (an unstarted release costs nothing, so a step can be claimed past any page)
  const prior = ctx.memory.read((db) => dispatchCount(db, step));
  // an exploration's first step reads the target branch as it is now (explorationSnapshot.ts): its head, read before the write
  const head = prior === 0 && explorationSeat(spec.card.seat) ? (ctx.actions().targetHead?.() ?? null) : null;
  // 4.4 (F6, H-3): the disk is read before the write (a new Constructor step only: the role, review p5-5)
  const disk = isConstructorStep(spec) ? diskLimitPassed(ctx) : null;
  const queued = spec;
  const claim = (): ClaimResponse => pmWrite(
    ctx,
    'dispatch',
    `dispatch:${step}:${prior + 1}`,
    { step, attempt: prior + 1, filler },
    (tx) => {
      // a retry starts again from the queued spec (4.1.3, #33)
      spec = queued;
      // a closed mission's production steps are held (§6.7): checked in the claim's own write
      if (heldByClose(tx, spec)) throw new ProcessError('NOT_READY', `mission ${task.mission} is closed: step ${step} is production work and waits until the mission is opened again`);
      // an exploration planned after others waits until they settled (explorationAfter.ts), checked in the same write
      const after = heldByPredecessors(tx, tx.data, spec);
      if (after !== null) throw new ProcessError('NOT_READY', `step ${step} is held: ${after}`);
      // 4.4 (G6, F6): a hold in force, or a disk limit passed, holds a new dispatch: checked in the same write
      // review p5-3: an unpinned acceptance counts only while the product production validated is still the current one
      const hold = heldByHolds(holdsInForce(tx, tx.data, ctx.now(), o.afters), disk, { task: step, mission: task.mission, lineage: spec.lineage }, spec, ctx.secretary !== null ? 'sec' : 'pm');
      if (hold !== null) throw new ProcessError('NOT_READY', `step ${step} is held: ${hold.why}`, { detail: { holds: hold.holds ?? [], diskLimit: hold.diskLimit === true } });
      // 4.4 (F3, F5): the recorded hand-backs fill in what a card queued by 4.3 lacks; a repair card's unpinned starts as checked before this write
      spec = refreshDispatchCard(tx, tx.data, spec, {
        handBack: (t) => taskStatus(tx, tx.data, t)?.handBack ?? null,
        leaf: (path) => {
          const r = ctx.memory.readLeaf(path);
          return r !== null && r.status === 'ok' ? r.text : null;
        },
        ...(o.starts !== undefined ? { starts: o.starts } : {}),
      });
      if (spec.card.seat === 'secretary' && liveSecretary(tx) !== null) spec = {...spec, card: {...spec.card, classifications: ['detail', 'needs-pm']}};
      // an exploration's step names the snapshot in force, taken again first when nothing of it ran yet and the branch moved
      spec = claimExplorationStep(tx, spec, head);
      const refreshed = tx.data.put(canonicalJson(spec));
      const n = Number((tx.stmt('SELECT COUNT(*) AS n FROM dispatches').get() as { n: number }).n) + 1;
      const dispatch = `D-${n}`;
      // 4.1.3 (#30): a step dispatched again lists the runs its earlier dispatches made
      const carriedRuns = carriedRunLines(tx, tx.data, { mission: task.mission as MissionId, task: step, dispatch });
      // 4.4 (F9): the card's commands follow who claims it (the live Secretary's own, or the seat commands)
      const card = renderSeatCard(cardForSeat(tx, spec.card), { dispatch, projectDir: ctx.projectDir, fullSuite: ctx.fullSuite, carriedRuns, secretaryClaim: ctx.secretary !== null && liveSecretary(tx)?.generation === ctx.secretary });
      const claimed = claimDispatch(tx, { dispatch, task: step, seat: spec.card.seat, capabilities: spec.capabilities, filler, worktree: entry.exportsProduct === true, card });
      // the materials as leaves (§5.2): `mp seat <id> read` reads them, hash-checked
      for (const m of ((spec.card['materials'] as MaterialRef[] | undefined) ?? [])) tx.leaves.writeDocument(materialLeaf(task.mission, m.ref), tx.data.text(m.ref));
      for (const r of spec.exclusive ?? []) acquireLease(tx, { resource: r, dispatch });
      // which step and which spec this dispatch took over (§3.2 item 1: the run chain)
      // 4.4 (F5): `servedReceipts`: this claim's card records a served receipt, so its release may be judged unstarted (absent: a 4.3 claim, released as 4.3 counted it)
      appendRecords(tx, [{ kind: 'flow.event', mission: task.mission as MissionId, line: DISPATCH_LINE(dispatch), event: 'claimed', key: 'spec', body: tx.data.put(canonicalJson({ spec: refreshed, task: step, lineage: spec.lineage, dispatches: prior, generation: ctx.secretary, servedReceipts: true })) as ContentHash }]);
      // 4.4 (F17): the stored response names the card's leaf and hash; its text is in the leaf only
      return { dispatch, cardLeaf: claimed.card?.leaf ?? dispatchLeaf(task.mission, dispatch, 'card'), cardSha256: claimed.card?.sha256 ?? sha256(card), worktree: claimed.worktree };
    },
    filler,
  );
  const out = claimOnceMore(claim);
  const card = storedCard(ctx, out);
  mkdirSync(join(ctx.memory.paths.tmp, out.dispatch), { recursive: true });
  let worktree: string | null = null;
  if (entry.exportsProduct === true) {
    const ws = spec.card['workspace'] as { snapshot: string };
    // A4: after the claim; idempotent (a crash in between leaves nothing half done: the next dispatch call or a release cleans up)
    ctx.workspaces().ensure(out.dispatch, ws.snapshot);
    worktree = `.mission-pipeline/worktrees/${out.dispatch}`;
  }
  const title = entry.seat.charAt(0).toUpperCase() + entry.seat.slice(1);
  return {
    dispatch: out.dispatch,
    step,
    seat: entry.seat,
    kind: spec.card.seat,
    mission: task.mission as MissionId,
    card,
    cardLeaf: out.cardLeaf,
    cardSha256: out.cardSha256 ?? sha256(card),
    worktree,
    files: handBackFiles(out.dispatch),
    prompt: `You are the ${title} of Mission Pipeline. Your card: \`mp seat ${out.dispatch} card\`. Use only the \`mp seat ${out.dispatch}\` commands listed there. Finish with \`mp seat ${out.dispatch} handback\`.`,
    size: cardSizeReport(ctx, spec.card),
  };
}

/**
 * 4.4 (F5, p3-3): the starts of a queued repair step's unpinned accepted products, checked by the flow's
 * own resolver (acceptedProduct: git) before the claim's write. Undefined for any other step.
 */
async function repairStarts(ctx: ProcessContext, step: string): Promise<ReadonlyMap<string, boolean> | undefined> {
  const t = ctx.memory.read((db) => taskInfo(db, step));
  if (t === null || t.state !== 'queued' || specOf(ctx, t.card).card.seat !== 'architect-repair') return undefined;
  const fctx = flowCtx(ctx.ports(), t.mission);
  const pie = await planInEffect(fctx);
  const out = new Map<string, boolean>();
  for (const task of pie?.plan.tasks ?? []) {
    const sel = lineAcceptance(await eventsOf(fctx, taskLine(task.id)));
    if (sel.product === null || sel.pinned) continue;
    try {
      out.set(sel.product, (await acceptedProduct(fctx, task.id)) === sel.product);
    } catch {
      // a start that cannot be checked now is not taken (as the queue-time builder leaves it out)
      out.set(sel.product, false);
    }
  }
  return out;
}

/** 4.4 (F5): how many times one `mp pm dispatch` checks a repair step's starts again when its claim finds the accepted work changed. */
export const STARTS_CHECKS = 3;

/**
 * Every command-line claim of a step (4.4, F5): `mp pm dispatch`, `mp sec dispatch` and `mp sec card`.
 * For a repair step, the unpinned starts are checked by the flow's resolver before the claim, and checked
 * again when the claim finds the accepted work changed meanwhile, a bounded number of times; past it,
 * nothing was claimed and the dispatch is run again. Only in-process callers (tests) use pmDispatch
 * (without the checks of a hold's `after`, an unpinned acceptance does not release it: the safe side).
 */
export async function pmDispatchChecked(ctx: ProcessContext, step: string, o: { readonly filledBy?: string | Filler | null } = {}): Promise<Dispatched> {
  for (let tries = 1; ; tries++) {
    const starts = await repairStarts(ctx, step);
    // 4.4 (G6, review p5-3): production's verdict on the unpinned acceptances a hold's `after` names, re-checked in the claim's write
    const afters = await checkAfters(ctx);
    try {
      return pmDispatch(ctx, step, { ...o, ...(starts !== undefined ? { starts } : {}), afters });
    } catch (e) {
      if (!(e instanceof ProcessError) || (e.detail as Record<string, unknown> | null)?.[STARTS_CHANGED] !== true) throw e;
      if (tries >= STARTS_CHECKS) throw new ProcessError('NOT_READY', `nothing was claimed: the accepted work of repair step ${step} changed during each of ${STARTS_CHECKS} checks of its starts; run the dispatch again`, { detail: { [STARTS_CHANGED]: true } });
    }
  }
}

// ---------------------------------------------------------------- mp pm release

export interface Released {
  readonly dispatch: string;
  readonly how: 'ended' | 'abandoned';
  /** False when nothing changed (handed back already, or released as ended before). */
  readonly released: boolean;
  /** The step is ready again. */
  readonly requeued: boolean;
  /** Decision 15: the lineage's re-dispatches are used up: WI-08, the Secretary decides. */
  readonly exhausted: boolean;
  readonly attempts: number;
  readonly allowed: number;
  readonly worktree: 'removed' | 'kept' | 'none';
  /** What could not be removed now (the dispatch's tmp/ directory, a checkout it held); mp pm next tries again. */
  readonly notes?: readonly string[];
  /** 4.4 (F5): the dispatch had not started, so its release cost no re-dispatch; how many such releases of the step in a row. Absent: it had started. */
  readonly unstarted?: number;
}

/** 4.4 (F5): the flow event (line "dispatch:<id>") of a release that found the dispatch unstarted, and so cost nothing. */
export const UNSTARTED_RELEASE = 'released-unstarted';
/** 4.4 (F5): this many unstarted releases of one step in a row raise a notice. */
export const UNSTARTED_ROW_NOTICE = 3;

/**
 * 4.4 (F5): a dispatch that had not started. Its dispatch line holds its claim and nothing else: no
 * served card, no material read, no run (a foreground run records its start when it is admitted), no
 * checkout, no refused hand-back (any trace counts as a start). A claim written before 4.4 records no
 * served receipt for its card, so its release counts as 4.3 counted it. One read of the line. A
 * Constructor's worktree is checked apart (worktreeClean).
 */
function untouched(db: Db, data: { text(h: string): string }, d: Pick<DispatchInfo, 'mission' | 'dispatch'>): boolean {
  const events = flowEvents(db, { mission: d.mission, line: DISPATCH_LINE(d.dispatch), limit: 10_000 });
  const claim = events.find((e) => e.event === 'claimed' && e.key === 'spec');
  if (claim === undefined || (JSON.parse(data.text(claim.body)) as { servedReceipts?: unknown }).servedReceipts !== true) return false;
  return events.every((e) => e.event === 'claimed');
}

/** How many dispatches claimed a step, uncapped (the claim's ordinal: its operation id). */
function dispatchCount(db: Db, task: string): number {
  return Number((db.stmt('SELECT COUNT(*) AS n FROM dispatches WHERE task = ?').get(task) as { n: number }).n);
}

/** A Constructor's worktree with nothing in it but its checkout (no change, no untracked or ignored file); one not there is clean, one git cannot read is not. */
function worktreeClean(ctx: ProcessContext, dispatch: string): boolean {
  const dir = workspaceDir(ctx.memory.paths, dispatch);
  if (!existsSync(dir)) return true;
  try {
    const r = ctx.git.runSync(['status', '--porcelain', '-z', '--untracked-files=all', '--ignored'], { cwd: dir });
    return r.code === 0 && r.stdout.length === 0;
  } catch {
    return false;
  }
}

/** A step's dispatches released unstarted in a row, newest first: read newest first and uncapped, until one that is not. */
function unstartedRow(db: Db, d: Pick<DispatchInfo, 'task'>): string[] {
  const row: string[] = [];
  for (let before = Number.MAX_SAFE_INTEGER; ; ) {
    const page = db.stmt('SELECT dispatch, mission, claimed_rev FROM dispatches WHERE task = ? AND claimed_rev < ? ORDER BY claimed_rev DESC LIMIT 100').all(d.task, before) as Array<{ dispatch: string; mission: MissionId; claimed_rev: number }>;
    for (const x of page) {
      if (!flowEventExists(db, { mission: x.mission, line: DISPATCH_LINE(x.dispatch), event: UNSTARTED_RELEASE, key: 'release' })) return row;
      row.push(x.dispatch);
    }
    if (page.length < 100) return row;
    before = Number(page.at(-1)!.claimed_rev);
  }
}

/** `mp pm release <id> --ended | --abandoned` (§5.4, WI-28). */
async function driver_pmRelease(ctx: ProcessContext, dispatch: string, how: 'ended' | 'abandoned', o: { readonly filler?: Filler | null } = {}): Promise<Released> {
  const d = ctx.memory.read((db) => dispatchInfo(db, dispatch));
  if (d === null) throw new LedgerError('UNKNOWN_DISPATCH', `no dispatch ${dispatch}`);
  // read before the write (git runs outside it); the dispatch line's traces are read again inside it
  const clean = d.state !== 'in-flight' || d.worktree === null || worktreeClean(ctx, dispatch);
  const r = pmWrite(
    ctx,
    'release',
    `release:${dispatch}:${how}`,
    { dispatch, how },
    (tx) => {
      const cur = dispatchInfo(tx, dispatch) as DispatchInfo;
      if (cur.state !== 'in-flight') {
        const rel = releaseDispatch(tx, { dispatch, how, requeue: false });
        const l = loopState(tx, cur.lineage, REDISPATCH_LOOP);
        return { released: rel.released, requeued: false, exhausted: false, attempts: l.attempts, allowed: l.allowed };
      }
      // the PM stops a closed mission's production seat (§6.7): the step is queued again, held while
      // the mission is closed, and the release is not counted (it is the close's, not a failure)
      const t = taskInfo(tx, cur.task);
      if (t !== null && heldByClose(tx, specOf(ctx, t.card))) {
        const rel = releaseDispatch(tx, { dispatch, how, requeue: true });
        const l = loopState(tx, cur.lineage, REDISPATCH_LOOP);
        return { released: rel.released, requeued: rel.requeued, exhausted: false, attempts: l.attempts, allowed: l.allowed };
      }
      // 4.4 (F5): a dispatch that had not started costs nothing: its release is counted apart, on its
      // dispatch line, and the step is ready again whatever the loop says; a row of them raises a notice
      if (clean && untouched(tx, tx.data, cur)) {
        appendRecords(tx, [{ kind: 'flow.event', mission: cur.mission, line: DISPATCH_LINE(dispatch), event: UNSTARTED_RELEASE, key: 'release', body: tx.data.put(canonicalJson({ dispatch, how })) as ContentHash }]);
        const rel = releaseDispatch(tx, { dispatch, how, requeue: true });
        const row = unstartedRow(tx, cur);
        if (row.length >= UNSTARTED_ROW_NOTICE) {
          raiseNotice(tx, {
            mission: cur.mission,
            category: 'unstarted-releases',
            wi: 'WI-28',
            key: `${cur.task}:${row.at(-1)!}`,
            trigger: `step ${cur.task} was released ${row.length} times in a row before its seat started (${[...row].reverse().join(', ')}): none of these releases counted against its re-dispatches`,
            defaultAction: 'nothing changes: the step is ready again; when no seat takes it up, read its card (mp read chain <dispatch>) and try another filler, or follow WI-28',
            detail: { task: cur.task, dispatches: [...row].reverse() },
          });
        }
        const l = loopState(tx, cur.lineage, REDISPATCH_LOOP);
        return { released: rel.released, requeued: rel.requeued, exhausted: false, attempts: l.attempts, allowed: l.allowed, unstarted: row.length };
      }
      // decision 15: a re-dispatch counts against the lineage's loop (checked before it is counted)
      const pre = loopState(tx, cur.lineage, REDISPATCH_LOOP);
      if (!pre.exhausted) appendRecords(tx, [{ kind: 'loop.attempt', lineage: cur.lineage, loop: REDISPATCH_LOOP, failureClass: null, signature: `release:${dispatch}` }]);
      const rel = releaseDispatch(tx, { dispatch, how, requeue: !pre.exhausted });
      const l = loopState(tx, cur.lineage, REDISPATCH_LOOP);
      return { released: rel.released, requeued: rel.requeued, exhausted: pre.exhausted, attempts: l.attempts, allowed: l.allowed };
    },
    o.filler,
  );
  let worktree: Released['worktree'] = 'none';
  if (d.worktree !== null) {
    try {
      const w = ctx.workspaces().release(dispatch, how);
      worktree = w.removed ? 'removed' : w.kept ? 'kept' : 'none';
    } catch {
      worktree = 'kept';
    }
  }
  // 4.1.2: a released dispatch's tmp/<dispatch>/ goes, and the checkouts only it held
  const notes = dispatchOver(ctx, dispatch);
  await advance(ctx, d.mission, { dispatch: null, task: null, step: `mp pm release ${dispatch} --${how}` });
  return { dispatch, how, ...r, worktree, ...(notes.length > 0 ? { notes } : {}) };
}

// ---------------------------------------------------------------- mp pm renew, drain, stop

export interface Renewed {
  readonly environment: string | null;
  /** Each rerun: the run in force it replaces, the new run, the judgments renewed and those refused (they need a Reviewer). */
  readonly reruns: ReadonlyArray<{ readonly original: string; readonly run: string; readonly passed: boolean; readonly renewed: readonly string[]; readonly refused: ReadonlyArray<{ readonly judgment: string; readonly reason: string }> }>;
  /** Judgments that need a new judgment of the same review position (a Reviewer dispatch, §6.5). */
  readonly reviews: readonly RenewalJudgment[];
  /** Runs that could not be rerun (no recorded candidate or command, a commit not reachable here: WI-30). */
  readonly skipped: ReadonlyArray<{ readonly evidence: string; readonly why: string }>;
  /** Judgments handed to their flow for a new judgment of the same position (a Reviewer step in `mp pm next`). */
  readonly reviewSteps: number;
  /** 4.4 (F14): the missions covered: the one named, or the open ones. */
  readonly missions: readonly string[];
  /** 4.4 (F14): judgments resting on runs from older environments left as they are, because their missions are not covered. */
  readonly leftOut: number;
}

/**
 * 4.4 (F14): what a renewal covers: the named mission, or every mission that is not closed. A run counts for
 * the missions of the versions its judgments decide and of its candidate; one whose mission cannot be told
 * is covered unless a mission is named.
 */
function renewCovers(ctx: ProcessContext, mission: string | null): { readonly missions: readonly string[]; readonly covers: (missions: readonly (string | null)[]) => boolean } {
  // one read of the missions' states
  const states = ctx.memory.stmt('SELECT mission, state FROM missions ORDER BY mission').all() as Array<{ mission: string; state: string }>;
  const closed = new Set(states.filter((r) => r.state === 'closed').map((r) => r.mission));
  const missions = mission !== null ? [mission] : states.filter((r) => r.state === 'open').map((r) => r.mission);
  const inScope = (m: string): boolean => (mission !== null ? m === mission : !closed.has(m));
  return { missions, covers: (ms) => { const known = ms.filter((m): m is string => m !== null && m !== 'project'); return known.length === 0 ? mission === null : known.some(inScope); } };
}

/** `mp pm renew [--mission <m>]` (§6.5): rerun the declared commands of the affected runs on clean checkouts; equal outputs renew the evidence. */
async function driver_pmRenew(ctx: ProcessContext, o: { readonly mission?: string | null } = {}): Promise<Renewed> {
  const env = ctx.environment();
  const all = ctx.memory.read((db) => renewalCandidates(db));
  const scope = renewCovers(ctx, o.mission ?? null);
  // 4.4 (F14): each judgment by its own mission (the version it decides, else its run's): a run that judgments of
  // several missions cite is rerun once, and only the covered judgments are renewed, scoped or sent to a Reviewer
  const inScope = (j: { readonly target: string }, evidence?: string): boolean => scope.covers([missionOfObject(ctx, j.target) ?? (evidence === undefined ? null : missionOfEvidence(ctx, evidence))]);
  const covered = all.candidates.flatMap((cand) => {
    const judgments = cand.judgments.filter((j) => inScope(j, cand.evidence));
    return judgments.some((j) => j.renewable) ? [{ ...cand, judgments }] : [];
  });
  const c = { ...all, candidates: covered, reviews: all.reviews.filter((j) => inScope(j)) };
  const judgmentsOf = (xs: ReadonlyArray<{ readonly judgments: ReadonlyArray<{ readonly judgment: string }> }>, ys: ReadonlyArray<{ readonly judgment: string }>): number => new Set([...xs.flatMap((x) => x.judgments.map((j) => j.judgment)), ...ys.map((j) => j.judgment)]).size;
  const leftOut = judgmentsOf(all.candidates, all.reviews) - judgmentsOf(c.candidates, c.reviews);
  const reruns: Array<Renewed['reruns'][number]> = [];
  const skipped: Array<{ evidence: string; why: string }> = [];
  // The log, rather than evidence-id order, preserves legacy command groups and
  // includes setup commands that no judgment cites. New runs carry the full group,
  // including setup commands reused from a different recording write.
  const recorded = ctx.memory.read((db) => (db.stmt("SELECT record FROM log WHERE kind = 'evidence' ORDER BY rev").all() as Array<{ record: string }>).map((r) => JSON.parse(r.record) as EvidenceRecord));
  const byEvidence = new Map(recorded.map((r) => [r.evidence as string, r]));
  const candidates = new Map(c.candidates.map((cand) => [cand.evidence as string, cand]));
  const groups = new Map<string, Array<(typeof c.candidates)[number]>>();
  for (const rec of recorded) {
    const cand = candidates.get(rec.evidence);
    if (cand === undefined) continue;
    if (cand.candidate === null || cand.command === null) {
      skipped.push({ evidence: cand.evidence, why: 'the run recorded no candidate or command: a Reviewer judges again' });
      continue;
    }
    const key = canonicalJson([cand.candidate, rec.fields['group'] === undefined ? ['run', rec.fields['run'] ?? rec.evidence] : ['group', rec.fields['group']]]);
    const group = groups.get(key) ?? [];
    group.push(cand);
    groups.set(key, group);
  }
  // a stop stops (§6.6): a renew executes suites, so every group's scope (the delivery's resolver) is checked
  // before any group runs, and each group again right before it runs (a renew can run many; a stop recorded
  // meanwhile refuses the rest). The refusal is thrown, never counted as a skipped run.
  const scopeOf = (originals: ReadonlyArray<(typeof c.candidates)[number]>): WorkScope => renewScope(ctx, originals);
  const scopes = new Map([...groups.values()].map((g) => [g, scopeOf(g)]));
  ctx.memory.read((db) => {
    for (const s of scopes.values()) assertScopeNotStopped(db, s, 'this renewal');
  });
  for (const originals of groups.values()) {
    ctx.memory.read((db) => assertScopeNotStopped(db, scopes.get(originals)!, 'this renewal'));
    try {
      const first = originals[0]!;
      const fields = byEvidence.get(first.evidence)!.fields;
      const source: Array<Omit<DeclaredCommand, 'id'>> = fields['group'] === undefined
        ? recorded.filter((rec) => rec.fields['candidate'] === first.candidate && (fields['run'] === undefined ? rec.evidence === first.evidence : rec.fields['run'] === fields['run']))
          .map((rec) => ({ command: rec.fields['command']!, cwd: runCwd(rec.fields), sampled: rec.runClass === 'sampling', network: rec.runClass === 'other' }))
        : JSON.parse(fields['group']) as Array<Omit<DeclaredCommand, 'id'>>;
      if (!Array.isArray(source) || source.length === 0 || source.some((cmd) => typeof cmd?.command !== 'string' || (cmd.cwd !== undefined && typeof cmd.cwd !== 'string') || (cmd.sampled !== undefined && typeof cmd.sampled !== 'boolean') || (cmd.network !== undefined && typeof cmd.network !== 'boolean'))) {
        throw new Error('the recorded verification group is invalid: a Reviewer judges again');
      }
      const commands = source.map((cmd, i) => ({ ...cmd, id: `renew-${i + 1}` }));
      if (originals.some((cand) => !commands.some((cmd) => cmd.command === cand.command && (cmd.cwd ?? '.') === cand.cwd && !cmd.sampled && !cmd.network))) {
        throw new Error('the recorded verification group omits a declared run to renew: a Reviewer judges again');
      }
      const replacementFor = (runs: readonly RecordedRun[], cand: (typeof originals)[number]): RecordedRun => runs.find((r) => r.command.command === cand.command && runCwd(r.fields) === cand.cwd && !r.command.sampled && !r.command.network)!;
      const renewGroup = (tx: WriteTx, runs: readonly RecordedRun[], records: readonly EvidenceRecord[] = []): Array<Renewed['reruns'][number]> => originals.map((cand) => {
        const x = replacementFor(runs, cand);
        const rec: EvidenceRecord = records.find((r) => r.evidence === x.evidence) ?? { kind: 'evidence', evidence: x.evidence as never, envLine: 'env' as never, envSnapshot: env.identity, runClass: 'declared', fields: x.fields };
        const out = recordRenewedRun(tx, { original: cand.evidence, run: rec, judgments: new Set(cand.judgments.map((j) => j.judgment as string)) });
        const ix = new StoredIndex(tx);
        const renewed: string[] = [];
        const refused = out.refused.map((f) => ({ judgment: f.judgment as string, reason: f.reason }));
        for (const judgment of out.renewed) {
          const j = ix.judgments.get(judgment)?.rec;
          if (j !== undefined && j.evidence.some((e) => effectiveEvidence(ix, j, e as EvidenceId) === x.evidence)) renewed.push(judgment);
          else refused.push({ judgment, reason: 'the renewal did not make the replacement effective for this judgment' });
        }
        return { original: cand.evidence, run: x.evidence, passed: x.passed, renewed, refused };
      });
      const doNotReuse = ctx.memory.read((db) => originals.flatMap((cand) => {
        const reusable = reusableMethodRun(db, { candidate: cand.candidate!, command: cand.command!, cwd: cand.cwd, environment: env.identity });
        return reusable !== null && !replacementFollowsOriginal(db, cand.evidence, reusable.evidence as EvidenceId) ? [reusable.evidence] : [];
      }));
      const r = await runOnCommit(ctx, {
        mission: missionOfEvidence(ctx, first.evidence),
        commit: first.candidate!,
        commands,
        purpose: `renewal of ${originals.map((cand) => cand.evidence).join(', ')} under environment ${env.identity}`,
        declaration: { by: 'mp', checkout: 'clean', declared: true },
        fields: { renews: canonicalJson(originals.map((cand) => cand.evidence)) },
        doNotReuse,
        also: (tx, runs, _run, records) => renewGroup(tx, runs, records),
      });
      let results = (r.result ?? []) as Array<Renewed['reruns'][number]>;
      if (r.reused) {
        // All pairs, including reused replacements, are renewed in one write.
        const pairs = originals.flatMap((cand) => cand.judgments.map((j) => [j.judgment, cand.evidence, replacementFor(r.runs, cand).evidence])).sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0);
        const payload = { environment: env.identity, pairs };
        results = ctx.memory.write({ admittedResult: true, op: `renew-pairs:${env.identity}:${sha256(canonicalJson(pairs))}`, payload }, (tx) => renewGroup(tx, r.runs));
      }
      reruns.push(...results);
    } catch (e) {
      skipped.push(...originals.map((cand) => ({ evidence: cand.evidence, why: (e as Error).message })));
    }
  }
  // decision 18: what renew could not restore needs a new judgment of the same review position; the
  // flow that owns the judged object dispatches it (execution: a Reviewer on the same candidate).
  // One request per (judgment, environment): the flow event's key is its identity. The causes found in
  // this call (several refused reruns, run classes never renewed) are merged into one body, sorted, so a
  // retry builds the same body. All requests go in one write; a request already recorded under its key
  // stands, so a retry, or a later renew whose causes changed, appends nothing and cannot conflict.
  const env2 = env.identity;
  const byJudgment = new Map(c.candidates.flatMap((x) => x.judgments).map((j) => [j.judgment as string, j]));
  const causes: ReviewNeededBody[] = [
    ...c.reviews.map((j) => ({ judgment: j.judgment as string, target: j.target, review: j.review, environment: env2, reason: j.reason ?? 'not renewable', rerun: null, passed: null })),
    ...reruns.flatMap((r) =>
      r.refused.flatMap((f) => {
        const j = byJudgment.get(f.judgment);
        return j === undefined ? [] : [{ judgment: f.judgment, target: j.target, review: j.review, environment: env2, reason: `the rerun ${r.run} ${r.passed ? 'passed' : 'failed'} but could not renew it: ${f.reason}`, rerun: r.run, passed: r.passed }];
      }),
    ),
  ];
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const byCause = new Map<string, ReviewNeededBody[]>();
  for (const b of causes) byCause.set(b.judgment, [...(byCause.get(b.judgment) ?? []), b]);
  const needed: Array<{ readonly mission: string; readonly body: ReviewNeededBody }> = [];
  for (const [judgment, bodies] of [...byCause].sort(([a], [b]) => order(a, b))) {
    const sorted = [...bodies].sort((a, b) => order(canonicalJson(a), canonicalJson(b)));
    const first = sorted.find((b) => b.rerun !== null) ?? sorted[0]!;
    const body: ReviewNeededBody = { judgment, target: first.target, review: first.review, environment: env2, reason: [...new Set(sorted.map((b) => b.reason))].join('; '), rerun: first.rerun, passed: first.passed };
    const mission = missionOfObject(ctx, body.target);
    if (mission !== null) needed.push({ mission, body });
  }
  if (needed.length > 0) {
    ctx.memory.write({ op: `renew-review:${env2}:${sha256(canonicalJson(needed))}`, payload: needed, command: 'renew', filler: ctx.filler }, (tx) => {
      for (const { mission, body } of needed) {
        const key = `${body.judgment}@${body.environment}`;
        if (flowEventExists(tx, { mission, line: RENEW_LINE, event: REVIEW_NEEDED, key })) continue;
        appendRecords(tx, [{ kind: 'flow.event', mission: mission as MissionId, line: RENEW_LINE, event: REVIEW_NEEDED, key, body: tx.data.put(canonicalJson(body)) as ContentHash }]);
      }
    });
  }
  await advance(ctx, undefined, { dispatch: null, task: null, step: `mp pm renew (environment ${env.identity.slice(0, 16)})` });
  return { environment: c.environment, reruns, reviews: c.reviews, skipped, reviewSteps: needed.length, missions: scope.missions, leftOut };
}

/**
 * The stop scope of one renewal group (§6.6): the missions of the object versions its judgments decide
 * and the mission its runs belong to, with their dispatches' capabilities (delivery/scope.ts deriveScope).
 */
function renewScope(ctx: ProcessContext, originals: ReadonlyArray<{ readonly evidence: string; readonly judgments: ReadonlyArray<{ readonly target: string }> }>): WorkScope {
  const missions = new Set<string>();
  for (const cand of originals) {
    for (const j of cand.judgments) {
      const m = missionOfObject(ctx, j.target);
      if (m !== null) missions.add(m);
    }
  }
  const own = missionOfEvidence(ctx, originals[0]!.evidence);
  const [lead, ...rest] = [...(own !== 'project' ? [own] : []), ...missions];
  return ctx.memory.read((db) => deriveScope(db, (lead ?? own) as MissionId, rest));
}

/** The mission of an object version, or null. */
function missionOfObject(ctx: ProcessContext, object: string): string | null {
  return ctx.memory.read((db) => (db.stmt("SELECT json_extract(record, '$.mission') AS m FROM log WHERE kind = 'object.version' AND json_extract(record, '$.object') = ? LIMIT 1").get(object) as { m: string | null } | undefined)?.m ?? null);
}

/** The mission a run belongs to (its summary leaf goes under it): the mission of the product version its candidate is, else "project". */
function missionOfEvidence(ctx: ProcessContext, evidence: string): string {
  return ctx.memory.read((db) => {
    const ev = db.stmt("SELECT json_extract(record, '$.fields.candidate') AS c FROM log WHERE kind = 'evidence' AND json_extract(record, '$.evidence') = ? LIMIT 1").get(evidence) as { c: string | null } | undefined;
    if (ev === undefined || ev.c === null) return 'project';
    const row = db.stmt("SELECT json_extract(record, '$.mission') AS m FROM log WHERE kind = 'object.version' AND json_extract(record, '$.source.commit') = ? LIMIT 1").get(ev.c) as { m: string } | undefined;
    return row?.m ?? 'project';
  });
}

/** `mp pm drain` (§4.1, WI-32): label batches until the frontier is empty. */
function driver_pmDrain(ctx: ProcessContext, o: { readonly maxBatches?: number } = {}): DrainReport {
  return drain(ctx.memory, o);
}

/** `mp pm stop "<the words>"` (§6.6): written before anything queued; "stop recorded; N dispatches in flight". */
export function pmStop(ctx: ProcessContext, req: { readonly stop: string; readonly scope: StopRequest['scope']; readonly words: string; readonly wordsEntry?: string | null; readonly at?: number }): { readonly committed: boolean; readonly inFlight: number; readonly message: string; readonly detached: ReadonlyArray<{ readonly run: string; readonly dispatch: string; readonly outcome: 'stopped' | 'lost' }> } {
  const r: StopRequest & { wordsEntry: string | null } = { stop: req.stop as StopId, scope: req.scope, words: req.words, at: req.at ?? ctx.now(), wordsEntry: req.wordsEntry ?? null };
  const out = ctx.memory.write({ op: `stop:${req.stop}`, payload: r, stop: true, command: 'stop', filler: ctx.filler }, (tx) => commitStop(tx, r));
  // 4.1.3 (#30): a stop stops the detached runs in its scope too (their process groups), recorded as stopped
  let detached: ReturnType<typeof stopDetachedRuns> = [];
  try {
    detached = stopDetachedRuns(ctx, req.scope, req.stop);
  } catch {
    /* the stop is recorded: a worker refuses its result when it sees it */
  }
  const stopped = detached.filter((x) => x.outcome === 'stopped').map((x) => `${x.run} (${x.dispatch})`);
  return { ...out, detached, message: `stop recorded; ${out.inFlight} dispatch${out.inFlight === 1 ? ' was' : 'es were'} in flight in its scope: stop them in your harness and report what it confirmed${stopped.length > 0 ? `; mp stopped ${stopped.length} detached run${stopped.length === 1 ? '' : 's'} in its scope: ${stopped.join(', ')}` : ''}` };
}

// ---------------------------------------------------------------- the PM's flow commands

// `mp pm mission` / `mp pm close`: close.ts (pmMission, pmClose)

/**
 * `mp pm say "<the message, verbatim>"` (§6.1, decision 9): the maintainer's message recorded as a
 * words entry W-<n> before anything else. The same text as the latest entry returns that entry
 * (a hook adapter and the PM's own `say` record once).
 */
export function pmSay(ctx: ProcessContext, text: string, o: { readonly session?: string; readonly at?: number; readonly op?: string; readonly tags?: readonly string[]; readonly supersedes?: readonly string[]; readonly withdraw?: readonly string[]; readonly keep?: readonly string[] } = {}): { readonly words: string; readonly repeated: boolean; readonly kept: readonly WordsDependency[]; readonly withdrawn: readonly WordsDependency[]; readonly retagged: string | null } {
  requirePm(ctx.secretary);
  // 4.4 (G7): what a supersession kept or withdrew is printed; a response recorded by 4.3 carries neither
  const report = (t: Partial<TagsReport> | WordsTag[] | undefined): Pick<TagsReport, 'kept' | 'withdrawn' | 'retagged'> => (t === undefined || Array.isArray(t) ? { kept: [], withdrawn: [], retagged: null } : { kept: t.kept ?? [], withdrawn: t.withdrawn ?? [], retagged: t.retagged ?? null });
  const latest = ctx.memory.read((db) => latestUserWords(db, 1)[0] ?? null);
  if (latest !== null && latest.text === sha256(text)) {
    const w = ctx.memory.read((db) => wordsOfMessage(db, latest.message));
    if (w !== null) {
      const t = o.tags?.length ? (ctx.memory.write({op: `say-tags:${o.op ?? sha256(canonicalJson({words: w.words, tags: o.tags}))}`, payload: o}, (tx) => tagWordsInTx(tx, {op: o.op ?? w.words, words: w.words, tags: o.tags!, supersedes: o.supersedes, withdraw: o.withdraw, keep: o.keep})) as TagsReport | WordsTag[]) : undefined;
      return { words: w.words, repeated: true, ...report(t) };
    }
  }
  const at = o.at ?? ctx.now();
  const message = `say-${sha256(`${at}\n${text}`).slice(0, 24)}`;
  // the session the words were said in: the PM session `mp pm session` recorded last (decision 8), unless named
  const session = o.session ?? ctx.memory.read((db) => latestPmSession(db)) ?? 'pm';
  const r = pmWrite(ctx, 'say', `say:${message}`, { message, text: sha256(text) }, (tx) => {const w = recordWords(tx, { message, session, at, text }); const t = o.tags?.length ? tagWordsInTx(tx, {op: o.op ?? message, words: w.words, tags: o.tags, supersedes: o.supersedes, withdraw: o.withdraw, keep: o.keep}) : undefined; return {...w, ...report(t)};});
  return { words: r.words, repeated: r.repeated, ...report(r as Partial<TagsReport>) };
}

/** The PM session `mp pm session` recorded last (its operation id, decision 8), or null. */
export function latestPmSession(db: Db): string | null {
  const r = db.stmt("SELECT action FROM pm_actions WHERE command = 'session' ORDER BY rev DESC LIMIT 1").get() as { action: string } | undefined;
  return r?.action ?? null;
}

/** The text of a words entry (W-<n>). */
export function wordsText(ctx: ProcessContext, words: string): string {
  const w = ctx.memory.read((db) => wordsEntry(db, words));
  if (w === null) throw new LedgerError('RECORD_INVALID', `no words entry ${words}`);
  return ctx.memory.data.text(w.text);
}

/**
 * `mp pm requirement add <mission> <item> --type ... --text ... (--quote "<verbatim>" --words W-<n> | --authorization <item>)`
 * (§6.1): the quote must appear verbatim in the words entry; mp refuses it otherwise.
 */
export async function pmRequirement(
  ctx: ProcessContext,
  req: { readonly mission: string; readonly item: string; readonly type: ItemType; readonly text: string; readonly quote?: string; readonly words?: string; readonly authorization?: string; readonly restatement?: string; readonly confirmedBy?: string; readonly notifyCondition?: string },
): Promise<{ readonly version: string }> {
  let source: ItemSource;
  if (req.authorization !== undefined) source = { kind: 'authorization', line: req.authorization.includes('.') ? req.authorization : `item.${req.mission}.${req.authorization}` };
  else {
    if (req.quote === undefined || req.words === undefined) throw new LedgerError('BAD_REQUEST', 'a requirement item quotes the user verbatim (--quote "..." --words W-<n>), or rests on an authorization (--authorization <item>)');
    ctx.memory.read((db) => checkQuote(db, ctx.memory.data, req.words!, req.quote!));
    source = { kind: 'words', words: req.words, quote: req.quote };
  }
  const version = await recordItem(ctx.ports(), {
    mission: req.mission as MissionId,
    item: req.item,
    type: req.type,
    text: req.text,
    source,
    ...(req.restatement !== undefined ? { restatement: req.restatement } : {}),
    ...(req.confirmedBy !== undefined ? { confirmedBy: req.confirmedBy } : {}),
    ...(req.notifyCondition !== undefined ? { notifyCondition: req.notifyCondition } : {}),
  });
  await advance(ctx, req.mission as MissionId, { dispatch: null, task: null, step: 'mp pm requirement add' });
  return { version };
}

/** A change form of `mp pm repair` (4.1.3, E-5): the user's decision about an exploration's method, applied directly. */
export type RepairChange =
  /** `answers`: an earlier repair about the exploration this change settles, named by the PM (4.1.3: never linked by the program). */
  | { readonly form: 'attempts'; readonly attempts: unknown; readonly answers?: string | null }
  | { readonly form: 'rerun'; readonly attempts: readonly string[] }
  | { readonly form: 'resnapshot' };

/** What a change form did: the result of the change it applied. */
export type RepairChanged =
  | { readonly form: 'attempts'; readonly result: AttemptsAmended }
  | { readonly form: 'rerun'; readonly result: AttemptsRerun }
  | { readonly form: 'resnapshot'; readonly result: Resnapshotted };

/**
 * `mp pm repair <mission> --words W-<n> --kind defect|usability|missing|new-question --text "<reason>" [--about <task|exploration>]
 * [--attempts <file.json> [--answers R-<n>] | --rerun <attempt-id>[,...] | --resnapshot]` (4.1.2, D-9, D-10; 4.1.3, E-5): the user
 * tried the product and found a problem. The reason must occur verbatim in the words entry (the
 * requirement items' check); the PM chooses the kind. About an exploration it reopens it for one more
 * round, the author's turn at once (in the attempts phase the method goes back to its author); with a
 * change form the user's decision about its method is applied directly instead, with the mechanical
 * checks only, and answers the repair in the same write. Otherwise an Architect repair step amends the
 * plan in effect.
 */
export async function pmRepair(
  ctx: ProcessContext,
  req: { readonly mission: string; readonly words: string; readonly kind: RepairKind; readonly text: string; readonly about?: string; readonly change?: RepairChange; readonly reason?: string | null },
): Promise<{ readonly repair: string; readonly repeated: boolean; readonly about: { readonly kind: 'task' | 'exploration'; readonly id: string } | null; readonly changed?: RepairChanged }> {
  ctx.memory.read((db) => checkQuote(db, ctx.memory.data, req.words, req.text));
  const mission = req.mission as MissionId;
  let about: { kind: 'task' | 'exploration'; id: string } | null = null;
  if (req.about !== undefined) {
    const isExploration = ctx.memory.read((db) => flowEvents(db, { mission, line: `exploration:${req.about}`, event: 'defined', limit: 1 }).length > 0);
    about = { kind: isExploration ? 'exploration' : 'task', id: req.about };
  }
  if (req.change !== undefined) {
    // a change form: the user's decision about an exploration's method, applied directly (no round)
    if (about?.kind !== 'exploration') throw new LedgerError('BAD_REQUEST', `a change form (--attempts, --rerun, --resnapshot) is about an exploration: --about names one${about !== null ? ` (${about.id} is not an exploration of ${req.mission})` : ''}`);
    if (await missionClosed(flowCtx(ctx.ports(), mission))) throw new LedgerError('BAD_REQUEST', `mission ${req.mission} is closed: a repair is recorded before the mission is closed`);
    const repair = { kind: req.kind, text: req.text };
    const base = { mission: req.mission, exploration: about.id, words: req.words, repair, command: 'repair' as const };
    const changed: RepairChanged =
      req.change.form === 'attempts'
        ? { form: 'attempts', result: await pmAmendAttempts(ctx, { ...base, attempts: req.change.attempts, reason: req.reason ?? req.text, answers: req.change.answers ?? null }) }
        : req.change.form === 'rerun'
          ? { form: 'rerun', result: await pmRerunAttempt(ctx, { ...base, attempts: req.change.attempts, reason: req.reason ?? req.text }) }
          : { form: 'resnapshot', result: await pmResnapshotExploration(ctx, base) };
    return { repair: changed.result.repair ?? '', repeated: false, about, changed };
  }
  // about an exploration in its attempts phase (4.1.3, #31): the method goes back to its author at once.
  // An interpreter step only queued is withdrawn in the repair's write; one a seat holds protects the record.
  const withdraw: Array<{ task: string; role: 'interpreter' }> = [];
  if (about?.kind === 'exploration') {
    const s = await explorationState(ctx.ports(), mission, about.id);
    if ((s.phase === 'attempts' || s.phase === 'interpret') && s.method !== null && s.stopped === null) {
      for (const q of pendingTasks(s)) {
        if (q.role !== 'interpreter') continue;
        const st = ctx.memory.read((db) => taskStatus(db, ctx.memory.data, q.task));
        if (st?.state === 'queued') withdraw.push({ task: q.task, role: 'interpreter' });
        else if (st?.state === 'done' || st?.state === 'waiting-evidence') throw new ProcessError('INTERPRETATION_SUBMITTED', `the interpreter of exploration ${about.id} handed back (step ${q.task}): run mp pm next, then this again (the repair then goes to the interpretation's rounds)`);
        else throw new ProcessError('DISPATCH_IN_FLIGHT', `the interpreter of exploration ${about.id} is at work (step ${q.task}, ${st?.note ?? st?.state ?? 'dispatched'}): wait for its hand-back (the repair then goes to the interpretation's rounds), or release it and run this again (the method then goes back to its author)`);
      }
    }
  }
  let r: { readonly id: string; readonly repeated: boolean };
  try {
    r = await recordRepair(ctx.ports(), { mission, words: req.words, kind: req.kind, text: req.text, about, ...(withdraw.length > 0 ? { withdraw } : {}) });
  } catch (e) {
    if (e instanceof LedgerError || e instanceof ProcessError) throw e;
    throw new LedgerError('BAD_REQUEST', (e as Error).message);
  }
  await advance(ctx, mission, { dispatch: null, task: null, step: `mp pm repair ${r.id}` });
  return { repair: r.id, repeated: r.repeated, about };
}

export interface WaiveRequest {
  readonly mission: string;
  /** The check waived: only "plan-reviews" (the feasibility review and Calibrator ②) in 4.1.3. */
  readonly check: string;
  /** One detailed plan version (dplan.<mission>.<n>.<k>); absent: every plan of the mission not in effect yet. */
  readonly plan?: string | null;
  /** The user's words entry (W-<n>) the waiver rests on, or */
  readonly words?: string | null;
  /** an authorization item in force that leaves this to the PM (D-8). */
  readonly authority?: string | null;
  readonly reason?: string | null;
  /** Withdraw the waivers in force: later plans get their reviews again (a plan in effect stays in effect). */
  readonly withdraw?: boolean;
  /** The caller's request id (the CLI's --op): a retry of the same request records once. */
  readonly request?: string | null;
}

export interface Waived {
  readonly mission: string;
  readonly check: string;
  readonly action: 'waive' | 'withdraw';
  /** False when nothing changed (a withdrawal with no waiver in force). */
  readonly recorded: boolean;
  /** The waiver's number on the record (key "plan-reviews#<n>"). */
  readonly n: number | null;
  readonly plan: string | null;
  readonly by: 'words' | 'authority';
  readonly ref: string;
  /** What the PM should know (stable mode, the deprecated config key). */
  readonly notes: readonly string[];
}

/**
 * `mp pm waive <mission> plan-reviews [--plan <dplan>] (--words W-<n> | --authority <item>) [--reason "<text>"]`
 * and `--withdraw` (4.1.3, E-2): a process check waived on the user's words, on the record. The waiver
 * cites the words entry or an authorization item in force (the full run's check, reused); its scope is
 * the mission or one detailed plan version not in effect yet. Planning reads it (flow/waivers.ts
 * planReviewsWaiver): the plan takes effect after the mechanical checks and the order ruling, labelled
 * "this plan took effect without its reviews, on W-n". A withdrawal gives later plans their reviews again
 * (and stops the deprecated config key from waiving them); a plan in effect stays in effect.
 */
export async function pmWaive(ctx: ProcessContext, req: WaiveRequest): Promise<Waived> {
  if (!(WAIVABLE_CHECKS as readonly string[]).includes(req.check)) throw new ProcessError('NOT_ALLOWED', `"${req.check}" is not a check a waiver can name: in this version only plan-reviews (the feasibility review and Calibrator ②) is waivable; nothing was recorded`);
  const mission = req.mission as MissionId;
  const words = req.words ?? null;
  const authority = req.authority ?? null;
  if ((words === null) === (authority === null)) throw new ProcessError('NOT_ALLOWED', 'a waiver rests on the user\'s words (--words W-<n>) or on an authorization item in force (--authority <item>), one of them: the record shows who decided; nothing was recorded');
  if (words !== null) wordsText(ctx, words);
  const ref = words ?? (await authorizationInForce(ctx, req.mission, authority!, 'nothing was recorded'));
  const by: Waived['by'] = words !== null ? 'words' : 'authority';
  const events = await ctx.ports().ledger.events({ mission, line: PLAN_LINE });
  const plan = req.plan ?? null;
  const notes: string[] = [];
  const config = ctx.planReviewsWaived.includes(req.mission) || ctx.planReviewsWaived.some((x) => x.startsWith(`dplan.${req.mission}.`));
  if (req.withdraw === true) {
    if (plan !== null) throw new ProcessError('NOT_ALLOWED', 'a withdrawal withdraws every plan-reviews waiver of the mission in force: give no --plan');
    if (waiversInForce(events).length === 0 && !config) return { mission: req.mission, check: req.check, action: 'withdraw', recorded: false, n: null, plan: null, by, ref, notes: [`No waiver of the plan reviews is in force for mission ${req.mission}: nothing changed.`] };
    if (config) notes.push(`The config key ${CONFIG_KEY} also names mission ${req.mission} (or one of its plans): the withdrawal on the record overrides it from now on. Remove the key from config.json.`);
  } else {
    if (plan !== null) {
      const prefix = `dplan.${req.mission}.`;
      if (!plan.startsWith(prefix) || !/^[0-9]+\.[0-9]+$/.test(plan.slice(prefix.length))) throw new ProcessError('NOT_ALLOWED', `--plan names a detailed plan version of mission ${req.mission} (dplan.${req.mission}.<n>.<k>), not ${plan}; nothing was recorded`);
      if (events.some((e) => e.event === 'effective' && e.key === plan)) throw new ProcessError('NOT_ALLOWED', `detailed plan ${plan} is in effect already: a waiver covers plans not in effect yet (that one stays in effect as it is); nothing was recorded`);
    }
    const mode = (events.filter((e) => e.event === 'pm-batch').at(-1)?.body as { mode?: string } | undefined)?.mode;
    if (mode === 'stable') notes.push(`Mission ${req.mission} is in stable mode: its tasks start on the waived plan as the waiver settles it, and their products read "not fully proven" (the plan has no review to prove it).`);
  }
  const body: Omit<ReviewsWaiverBody, 'n'> = { check: 'plan-reviews', action: req.withdraw === true ? 'withdraw' : 'waive', dplan: plan, by, ref, reason: req.reason !== undefined && req.reason !== null && req.reason.trim() !== '' ? req.reason.trim().slice(0, 2000) : null };
  const prior = events.filter((e) => e.event === REVIEWS_WAIVER).length;
  const op = req.request !== undefined && req.request !== null && req.request !== '' ? `waive:${req.mission}:req:${req.request}` : `waive:${req.mission}:${prior + 1}:${sha256(canonicalJson(body)).slice(0, 16)}`;
  const n = pmWrite(ctx, 'waive', op, { mission: req.mission, ...body }, (tx) => {
    const k = flowEvents(tx, { mission, line: PLAN_LINE, event: REVIEWS_WAIVER, limit: 10_000 }).length + 1;
    const full: ReviewsWaiverBody = { ...body, n: k };
    appendRecords(tx, [{ kind: 'flow.event', mission, line: PLAN_LINE, event: REVIEWS_WAIVER, key: `plan-reviews#${k}`, body: tx.data.put(canonicalJson(full)) as ContentHash }]);
    return k;
  });
  await advance(ctx, mission, { dispatch: null, task: null, step: `mp pm waive ${req.mission} ${req.check}${req.withdraw === true ? ' --withdraw' : ''}` });
  return { mission: req.mission, check: req.check, action: body.action, recorded: true, n, plan, by, ref, notes };
}

/** `mp pm requirement withdraw <mission> <item> --reason ...`. */
export async function pmWithdrawRequirement(ctx: ProcessContext, req: { readonly mission: string; readonly item: string; readonly reason: string }): Promise<void> {
  await withdrawItem(ctx.ports(), { mission: req.mission as MissionId, item: req.item, reason: req.reason });
  await advance(ctx, req.mission as MissionId, { dispatch: null, task: null, step: 'mp pm requirement withdraw' });
}

/** What a constraint's scope reaches now (4.1.3, #36): current object versions, and the tasks of each mission's plan in effect. */
export interface ConstraintReach {
  /** Object versions no later version revises, that the scope applies to (memory/domain/constraints.ts constraintApplies). */
  readonly objects: number;
  /** Tasks of the plans in effect whose cards take the constraint (seat/cards/dynamic.ts constraintsForTask), as "<mission>/<task>". */
  readonly tasks: readonly string[];
}

/**
 * The reach of a constraint scope now, read with the resolvers the labels and the cards use: an object
 * constraint by constraintApplies over the current object versions, either kind by constraintsForTask
 * over the tasks of each mission's plan in effect.
 */
export async function constraintReach(ctx: ProcessContext, c: { readonly kind: 'object' | 'instruction'; readonly scope: ConstraintScope }): Promise<ConstraintReach> {
  const body = { line: 'constraint.reach', version: 'reach', kind: c.kind, text: '', scope: c.scope };
  const objects = c.kind !== 'object' ? 0 : ctx.memory.read((db) => {
    const rows = db.stmt("SELECT record FROM log WHERE kind = 'object.version'").all() as Array<{ record: string }>;
    const recs = rows.map((r) => JSON.parse(r.record) as { object: string; mission: string; scope?: ObjectScope; predecessor?: string });
    const revised = new Set(recs.flatMap((r) => (r.predecessor !== undefined ? [r.predecessor] : [])));
    return recs.filter((r) => !revised.has(r.object) && r.scope !== undefined && constraintApplies(body, { scope: r.scope, mission: r.mission })).length;
  });
  const missions = c.scope.mission !== undefined ? [c.scope.mission as MissionId] : await ctx.ports().ledger.missions();
  const tasks: string[] = [];
  for (const m of missions) {
    const p = await planInEffect(flowCtx(ctx.ports(), m));
    for (const t of p?.plan.tasks ?? []) if (constraintsForTask([body], t, m).length > 0) tasks.push(`${m}/${t.id}`);
  }
  return { objects, tasks };
}

/** `mp pm constraint add <mission> <constraint> --kind object|instruction --text ... [--paths] [--task-types] [--words W-<n>]`. */
export async function pmConstraint(ctx: ProcessContext, req: { readonly mission: string; readonly constraint: string; readonly kind: 'object' | 'instruction'; readonly text: string; readonly scope: ConstraintScope; readonly missionScope?: string; readonly words?: string }): Promise<{ readonly version: string; readonly reach: ConstraintReach; readonly scopeChanged: boolean }> {
  const scope: ConstraintScope = { ...req.scope, ...(req.missionScope !== undefined ? { mission: req.missionScope } : {}) };
  // 4.1.3 (#36): a pattern the matcher cannot read is refused at once, with the forms it reads and the nearest one
  const bad = scope.paths.flatMap((p) => { const x = constraintPatternProblem(p); return x === null ? [] : [`"${p}": ${x.problem}; the nearest form is "${x.suggestion}"`]; });
  if (bad.length > 0) throw new ProcessError('NOT_ALLOWED', `the scope's path patterns: ${bad.join('; ')}. A scope path is ${CONSTRAINT_PATTERN_FORMS}. Nothing was recorded`);
  if (req.words !== undefined) wordsText(ctx, req.words);
  const line = constraintLine(req.constraint);
  const before = (await currentConstraints(flowCtx(ctx.ports(), req.mission as MissionId))).find((c) => c.line === line);
  const version = await recordConstraint(ctx.ports(), { mission: req.mission as MissionId, constraint: req.constraint, kind: req.kind, text: req.text, scope, ...(req.words !== undefined ? { words: req.words } : {}) });
  await advance(ctx, undefined, { dispatch: null, task: null, step: 'mp pm constraint' });
  // the same id and text keep the version: say so when only the scope changed (#36: it looked unchanged)
  const scopeChanged = before !== undefined && before.version === version && canonicalJson(before.scope) !== canonicalJson(scope);
  return { version, reach: await constraintReach(ctx, { kind: req.kind, scope }), scopeChanged };
}

/** Withdraw a constraint under the user's recorded words; never delete its record. */
export async function pmWithdrawConstraint(ctx: ProcessContext, req: { readonly constraint: string; readonly words: string }): Promise<void> {
  wordsText(ctx, req.words);
  await withdrawConstraint(ctx.ports(), req);
  await advance(ctx, undefined, { dispatch: null, task: null, step: 'mp pm constraint withdraw' });
}

/** `mp pm plan submit <mission> --file <plan.json> --words W-<n>...`: a PM plan batch; Calibrator ① checks it next. */
export async function pmPlan(
  ctx: ProcessContext,
  req: { readonly mission: string; readonly plan: unknown; readonly words: readonly string[]; readonly changedItems?: readonly string[]; readonly dependentItems?: readonly string[]; readonly mode?: 'stable' | 'fast' },
): Promise<{ readonly batch: string; readonly plan: string; readonly recheck?: boolean }> {
  const out = await submitPmBatch(ctx.ports(), {
    mission: req.mission as MissionId,
    plan: req.plan,
    userWords: req.words,
    ...(req.changedItems !== undefined ? { changedItems: req.changedItems } : {}),
    ...(req.dependentItems !== undefined ? { dependentItems: req.dependentItems } : {}),
    ...(req.mode !== undefined ? { mode: req.mode } : {}),
  });
  await advance(ctx, req.mission as MissionId, { dispatch: null, task: null, step: 'mp pm plan submit' });
  return out;
}

/**
 * `mp pm answer <mission> <escalation> --option ... --words W-<n> [--instructions ...] [--extra n] [--findings F,...]`:
 * the user's decision. 4.1.3 (#39): a grant on an exploration may name the findings it is for.
 */
export async function pmAnswer(ctx: ProcessContext, req: { readonly mission: string; readonly escalation: string; readonly option: DecisionOption; readonly words: string; readonly by?: 'pm' | 'user'; readonly noWords?: boolean; readonly reason?: string; readonly instructions?: string; readonly grantExtra?: number; readonly findings?: readonly string[] }): Promise<{ readonly round: number | null }> {
  const text = req.by === 'pm' ? '' : wordsText(ctx, req.words);
  const findings = [...new Set((req.findings ?? []).map((f) => f.trim()).filter((f) => f !== ''))];
  if (findings.length > 0) {
    if (req.option !== 'grant') throw new LedgerError('BAD_REQUEST', '--findings goes with --option grant (the findings the granted round is for)');
    const line = (await escalation(flowCtx(ctx.ports(), req.mission as MissionId), req.escalation))?.subject ?? null;
    if (line === null || !line.startsWith('exploration:')) throw new LedgerError('BAD_REQUEST', `--findings names findings of an exploration; escalation ${req.escalation} is not about one`);
    const s = await explorationState(ctx.ports(), req.mission as MissionId, line.slice('exploration:'.length));
    const unknown = findings.filter((f) => !s.findings.has(f));
    if (unknown.length > 0) throw new LedgerError('BAD_REQUEST', `${line.slice('exploration:'.length)} has no finding ${unknown.join(', ')} (mp read show exploration lists its findings)`);
  }
  // 4.4 (F9): the answer round this command recorded (a PM answer's), so its output reports on this very answer
  let round: number | null = null;
  if (req.by === 'pm') round = (await answerByPm(ctx.ports(), {...req, mission: req.mission as MissionId, words: req.words.split(',').map((w) => w.trim()).filter(Boolean), reason: req.reason ?? ''})).round;
  else await answerEscalation(ctx.ports(), {
    mission: req.mission as MissionId,
    escalation: req.escalation,
    option: req.option,
    words: `${text} (${req.words})`,
    ...(req.instructions !== undefined ? { instructions: req.instructions } : {}),
    ...(req.grantExtra !== undefined ? { grantExtra: req.grantExtra } : {}),
    ...(findings.length > 0 ? { findings } : {}),
  });
  await advance(ctx, req.mission as MissionId, { dispatch: null, task: null, step: 'mp pm answer' });
  return { round };
}

/** `mp pm grant <lineage> <loop> --extra <n> --words W-<n>` (WI-08: after the Secretary's one grant, only the user). */
export async function pmGrant(ctx: ProcessContext, req: { readonly mission?: string; readonly lineage: string; readonly loop: LoopKind; readonly extra: number; readonly words: string; readonly by?: 'pm' | 'user' }): Promise<{ readonly granted: boolean; readonly why?: string }> {
  const ids = req.by === 'pm' ? req.words.split(',').map((w) => w.trim()).filter(Boolean) : [req.words];
  if (ids.length === 0) throw new ProcessError('NOT_ALLOWED', 'a PM grant requires --words W-n');
  const text = ids.map((id) => wordsText(ctx, id)).join('\n');
  const words = req.by === 'pm' ? ids.map((id) => {const fingerprint = wordsAuthority(ctx.memory, ctx.memory.data, id, req.mission); if (fingerprint === null) throw new ProcessError('NOT_ALLOWED', `${id} is no longer in force`); return {id, fingerprint, ...(req.mission === undefined ? {} : {mission: req.mission})};}) : undefined;
  const g = await ctx.ports().scheduler.grant({ op: `grant:${req.by ?? 'user'}:${req.lineage}:${req.loop}:${sha256(`${req.words}:${req.extra}`).slice(0, 12)}`, lineage: req.lineage, loop: req.loop, by: req.by ?? 'user', words, extra: req.extra, reason: `${text} (${req.words})` });
  await advance(ctx, req.mission as MissionId | undefined, { dispatch: null, task: null, step: 'mp pm grant' });
  return g;
}

/** `mp pm legalize <mission> --endpoint <object> --words W-<n>`: the backfill plan (nothing starts), then `--start`. */
export async function pmLegalize(ctx: ProcessContext, req: LegalizationRequest): Promise<unknown> {
  const plan = await requestLegalization(ctx.ports(), req);
  await advance(ctx, req.mission as MissionId, { dispatch: null, task: null, step: 'mp pm legalize' });
  return plan;
}

export async function pmStartLegalization(ctx: ProcessContext, req: { readonly mission: string; readonly legalization: string; readonly words: string }): Promise<void> {
  await startLegalization(ctx.ports(), req.mission as MissionId, req.legalization, `${wordsText(ctx, req.words)} (${req.words})`);
  await advance(ctx, req.mission as MissionId, { dispatch: null, task: null, step: 'mp pm legalize --start' });
}

export async function pmLegalizationState(ctx: ProcessContext, req: { readonly mission: string; readonly legalization: string }) {
  return legalizationState(ctx.ports(), req.mission as MissionId, req.legalization);
}

// ---------------------------------------------------------------- delivery and landing (A4, with this package's labels and runs)

/** The full-run status of a delivery candidate's tree (P1's resolver), with its line for people (D-7). */
function deliveryFullRun(ctx: ProcessContext, mission: string): (c: { readonly tree: string }) => DeliveryFullRun {
  return (c) => {
    const status = fullRunStatus(ctx, mission, c.tree);
    return { line: fullRunLine(status), status };
  };
}

/**
 * `mp pm deliver <mission> --outputs ... --words W-<n> [--message <subject>]` (§6.7; 4.1.2, D-7): A4's
 * deliver with the stored labels. No command runs: the delivery records the full-run status of its
 * tree, and a full run at the end is the PM's call.
 */
export async function pmDeliver(
  ctx: ProcessContext,
  req: { readonly mission: string; readonly delivery: string; readonly selected: readonly DeliveryTarget[]; readonly words?: string | null; readonly targetBranch?: string; readonly rebuildOf?: string | null; readonly message?: string | null; readonly candidateOnly?: boolean },
): Promise<DeliveryResult> {
  ctx.environment();
  // §4.1: a call first does one bounded label batch (the labels must reflect the log before a decision that needs "proven")
  settleLabels(ctx);
  return deliver(
    ctx.gitCtx,
    {
      mission: req.mission as MissionId,
      delivery: req.delivery,
      targetBranch: req.targetBranch ?? ctx.targetBranch,
      selected: req.selected,
      author: ctx.ident(),
      committer: ctx.committer(),
      ...(req.words !== undefined ? { words: req.words } : {}),
      ...(req.rebuildOf !== undefined ? { rebuildOf: req.rebuildOf } : {}),
      ...(req.message !== undefined && req.message !== null ? { message: req.message } : {}),
      ...(req.candidateOnly === true ? { candidateOnly: true } : {}),
      filler: ctx.filler,
    },
    { labels: () => labelView(ctx), fullRun: deliveryFullRun(ctx, req.mission) },
  );
}

/** WI-05 default after a landing found the target branch moved: the delivery rebuilt on the new base (counted, decision 16). */
export async function pmRebuild(ctx: ProcessContext, req: { readonly mission: string; readonly delivery: string }): Promise<DeliveryResult> {
  ctx.environment();
  settleLabels(ctx);
  return rebuildDelivery(ctx.gitCtx, { mission: req.mission as MissionId, delivery: req.delivery, author: ctx.ident(), committer: ctx.committer(), filler: ctx.filler }, { labels: () => labelView(ctx), fullRun: deliveryFullRun(ctx, req.mission) });
}

/** `mp pm land <delivery> --words W-<n>` (§6.7): A4's fast-forward landing from the recorded base. */
export async function pmLand(ctx: ProcessContext, req: { readonly mission: string; readonly delivery: string; readonly words: string; readonly allowExternal?: string | null }): Promise<LandingResult> {
  return land(ctx.gitCtx, { mission: req.mission as MissionId, delivery: req.delivery, words: req.words, ...(req.allowExternal !== undefined ? { allowExternal: req.allowExternal } : {}), filler: ctx.filler });
}

/** Whether a dispatch's hand-back carried a candidate (for reading the chain). */
export function dispatchCandidate(ctx: ProcessContext, dispatch: string): string | null {
  const d = ctx.memory.read((db) => dispatchInfo(db, dispatch));
  if (d === null) return null;
  return handbackDoc(ctx.memory.data, d)?.candidate?.commit ?? null;
}

export type { ReconcileReport };

export async function pmNext(...args: Parameters<typeof driver_pmNext>): Promise<Awaited<ReturnType<typeof driver_pmNext>>> {
  const ctx = args[0];
  requireDriver(ctx.memory, ctx.secretary);
  const was = ctx.operational;
  ctx.operational = true;
  try { return await driver_pmNext(...args); } finally { ctx.operational = was; }
}

/** 4.4 (F8): a pass's reconciliation alone; `readNextReport` reads its report afterwards in one snapshot (`mp sec next`, `mp sec wait`). */
export async function pmReconcile(ctx: ProcessContext): Promise<Reconciled> {
  requireDriver(ctx.memory, ctx.secretary);
  const was = ctx.operational;
  ctx.operational = true;
  try { return await reconcileNext(ctx); } finally { ctx.operational = was; }
}

export function pmDispatch(...args: Parameters<typeof driver_pmDispatch>): ReturnType<typeof driver_pmDispatch> {
  const ctx = args[0];
  requireDriver(ctx.memory, ctx.secretary);
  const was = ctx.operational;
  ctx.operational = true;
  try { return driver_pmDispatch(...args); } finally { ctx.operational = was; }
}

export async function pmRelease(...args: Parameters<typeof driver_pmRelease>): Promise<Awaited<ReturnType<typeof driver_pmRelease>>> {
  const ctx = args[0];
  requireDriver(ctx.memory, ctx.secretary);
  const was = ctx.operational;
  ctx.operational = true;
  try { return await driver_pmRelease(...args); } finally { ctx.operational = was; }
}

export async function pmRenew(...args: Parameters<typeof driver_pmRenew>): Promise<Awaited<ReturnType<typeof driver_pmRenew>>> {
  const ctx = args[0];
  requireDriver(ctx.memory, ctx.secretary);
  const was = ctx.operational;
  ctx.operational = true;
  try { return await driver_pmRenew(...args); } finally { ctx.operational = was; }
}

export function pmDrain(...args: Parameters<typeof driver_pmDrain>): ReturnType<typeof driver_pmDrain> {
  const ctx = args[0];
  requireDriver(ctx.memory, ctx.secretary);
  const was = ctx.operational;
  ctx.operational = true;
  try { return driver_pmDrain(...args); } finally { ctx.operational = was; }
}

export function pmAck(...args: Parameters<typeof driver_pmAck>): ReturnType<typeof driver_pmAck> {
  const ctx = args[0];
  requireDriver(ctx.memory, ctx.secretary);
  const was = ctx.operational;
  ctx.operational = true;
  try { return driver_pmAck(...args); } finally { ctx.operational = was; }
}
