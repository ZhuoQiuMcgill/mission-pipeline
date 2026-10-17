import { withdrawConstraint } from '../memory/domain/constraints.ts';
import { refreshDispatchCard } from '../seat/cards/refresh.ts';
// The PM's dispatch loop and commands (design 4.1 §5.1, §5.4, §6.5, §6.6; decisions 8, 15, 18).
//
//   pmNext      one bounded label batch (A2), the landing recovery (A4), worktrees of finished
//               dispatches removed, the process advanced; then, notices first (marked delivered):
//               the ready steps (seat, task, mission, purpose, parallel), the steps held (a stop,
//               a lease, the git-writes hold), what waits on the user, the dispatches in flight
//               with their age. 4.1.2: after an environment change, no renew step; one notice per
//               change names how many runs current proof rests on are from older environments
//   pmDispatch  claims a ready step once (A1 claimDispatch): the dispatch id, the card leaf
//               `missions/<m>/dispatches/<d>/card.md`, its material leaves, its leases; a
//               Constructor's worktree is created at the card's commit (A4)
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

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
  flowEventExists,
  type Db,
  type DispatchInfo,
  type Filler,
  type StopRequest,
  type WriteTx,
} from '../memory/index.ts';
import { recordItem, recordConstraint, withdrawItem, type ItemSource, type ItemType } from '../flow/requirements.ts';
import { submitPmBatch } from '../flow/planning.ts';
import { answerEscalation, type DecisionBody, type EscalationBody } from '../flow/secretary.ts';
import { RENEW_LINE, REVIEW_NEEDED, SECRETARY_LINE, type ReviewNeededBody } from '../flow/plandoc.ts';
import { scopesOverlap } from '../flow/mechanical.ts';
import { legalizationState, requestLegalization, startLegalization, type LegalizationRequest } from '../flow/audit/index.ts';
import type { ReconcileReport } from '../flow/engine.ts';
import type { ConstraintScope } from '../common/records.ts';
import { renderSeatCard, handBackFiles } from '../seat/card.ts';
import type { MaterialRef } from '../seat/cards/common.ts';
import type { DecisionOption } from '../seat/cards/secretary.ts';
import { seatCardEntry } from '../seat/cards/index.ts';
import { advance } from './advance.ts';
import type { ProcessContext } from './context.ts';
import { ProcessError } from './errors.ts';
import { labelView } from './labelView.ts';
import { listNotices, markNotices, type PmNotice } from './notices.ts';
import { DISPATCH_LINE, REDISPATCH_LOOP, handbackDoc, type TaskSpecDoc } from './ports.ts';
import { closingRunner, runCwd, runOnCommit, type DeclaredCommand, type RecordedRun } from './runs.ts';
import { fullRunLine, heldByClose } from './close.ts';
import { fullRunStatus } from './fullRuns.ts';
import { dispatchOver, sweepTmp, SWEEP_BUDGET_MS } from './housekeeping.ts';
import { assertScopeNotStopped, deriveScope, type WorkScope } from '../delivery/scope.ts';
import { cardForSeat, noticeOlderEnvironment } from './environmentLabels.ts';
import { materialLeaf } from './seat.ts';

// ---------------------------------------------------------------- shared

/** §4.1: one bounded label batch before a decision that reads labels (the frontier stays stored when it does not finish). */
function settleLabels(ctx: ProcessContext): void {
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
}

/** Steps conflict when they write overlapping paths or need the same exclusive resource. */
function conflicts(a: TaskSpecDoc, b: TaskSpecDoc): boolean {
  if ((a.exclusive ?? []).some((r) => (b.exclusive ?? []).includes(r))) return true;
  return a.writeScope !== undefined && b.writeScope !== undefined && scopesOverlap(a.writeScope, b.writeScope).length > 0;
}

/** The ready and held steps, the dispatches in flight and what waits on the user, in one read. */
export function readSteps(ctx: ProcessContext): Pick<NextReport, 'ready' | 'held' | 'inFlight' | 'waitingOnUser'> {
  const now = ctx.now();
  const gitHeld = ctx.memory.gitHold();
  return ctx.memory.read((db) => {
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
      if (heldByClose(db, spec)) {
        held.push({ ...base, why: `mission ${q.mission} is closed (§6.7): its production steps wait until it is opened again (mp pm mission ${q.mission})`, wi: null });
        continue;
      }
      if (stoppedFor(db, { mission: q.mission, capabilities: spec.capabilities })) {
        held.push({ ...base, why: 'a stop covers it (the stop report covers it; it waits until the stop is narrowed or released)', wi: null });
        continue;
      }
      if (entry.exportsProduct === true && gitHeld !== null) {
        held.push({ ...base, why: `git writes are held since this folder was moved or copied: ${gitHeld.reason}`, wi: 'WI-31' });
        continue;
      }
      const busy = (spec.exclusive ?? []).filter((r) => leased.has(r));
      if (busy.length > 0) {
        held.push({ ...base, why: `waits for ${busy.map((r) => `${r} (leased to ${leased.get(r)})`).join(', ')}`, wi: 'WI-28' });
        continue;
      }
      const dispatches = listDispatches(db, { task: q.task, limit: 1000 }).length;
      candidates.push({ spec, step: { ...base, parallel: true, priority: spec.priority, dispatches } });
    }
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
        const why = t !== undefined ? (JSON.parse(ctx.memory.data.text(t.body)) as { why: string }).why : dBody !== null && dBody.classification === 'needs-user' ? dBody.notice || dBody.reason : null;
        if (why === null) continue;
        const esc = JSON.parse(ctx.memory.data.text(e.body)) as EscalationBody;
        waitingOnUser.push({ mission: m, escalation: esc.id, subject: esc.subject, summary: esc.summary, options: esc.options.filter((o) => o !== 'ask-user'), why });
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
      ctx.workspaces().remove(d.dispatch);
    } catch {
      /* kept: tried again next time */
    }
  }
}

/** `mp pm next` (§5.1 step 1). */
export async function pmNext(ctx: ProcessContext, o: { readonly markDelivered?: boolean } = {}): Promise<NextReport> {
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
  const steps = readSteps(ctx);
  const data = ctx.memory.data;
  const notices = ctx.memory.read((db) => listNotices(db, data)).sort((a, b) => (a.state === b.state ? a.revision - b.revision : a.state === 'undelivered' ? -1 : 1));
  if (o.markDelivered !== false) markNotices(ctx.memory, notices.filter((n) => n.state === 'undelivered').map((n) => n.id), 'delivered');
  const st = ctx.memory.read((db) => labelStatus(db));
  return {
    notices,
    ...steps,
    olderEnvironmentRuns,
    labels: { recomputing: st.recomputing, toVisit: st.toVisit, toRecompute: st.toRecompute, since: st.since },
    landings,
    errors,
  };
}

/** `mp pm alerts --ack <id...>`: notices acknowledged (never back). */
export function pmAck(ctx: ProcessContext, ids: readonly string[]): { readonly acknowledged: number } {
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
  /** A Constructor's worktree, relative to the project folder. */
  readonly worktree: string | null;
  /** Where the seat writes its hand-back (decision 7). */
  readonly files: ReturnType<typeof handBackFiles>;
  /** The fixed prompt for the PM's harness (§5.1 step 3). */
  readonly prompt: string;
}

/** `mp pm dispatch <step> --filled-by "<harness>/<model>"` (§5.1 step 2): the step is claimed once. */
export function pmDispatch(ctx: ProcessContext, step: string, o: { readonly filledBy?: string | Filler | null } = {}): Dispatched {
  settleLabels(ctx);
  const filler = parseFiller(o.filledBy);
  const task = ctx.memory.read((db) => db.stmt('SELECT task, card, state, mission FROM tasks WHERE task = ?').get(step) as { task: string; card: string; state: string; mission: string } | undefined);
  if (task === undefined) throw new ProcessError('NOT_READY', `no step ${step} (mp pm next lists the ready steps)`);
  let spec = specOf(ctx, task.card);
  const entry = seatCardEntry(spec.card.seat);
  const prior = ctx.memory.read((db) => listDispatches(db, { task: step, limit: 1000 }).length);
  const out = pmWrite(
    ctx,
    'dispatch',
    `dispatch:${step}:${prior + 1}`,
    { step, attempt: prior + 1, filler },
    (tx) => {
      // a closed mission's production steps are held (§6.7): checked in the claim's own write
      if (heldByClose(tx, spec)) throw new ProcessError('NOT_READY', `mission ${task.mission} is closed: step ${step} is production work and waits until the mission is opened again`);
      spec = refreshDispatchCard(tx, tx.data, spec);
      const refreshed = tx.data.put(canonicalJson(spec));
      const n = Number((tx.stmt('SELECT COUNT(*) AS n FROM dispatches').get() as { n: number }).n) + 1;
      const dispatch = `D-${n}`;
      const card = renderSeatCard(cardForSeat(tx, spec.card), { dispatch, projectDir: ctx.projectDir, fullSuite: ctx.fullSuite });
      const claimed = claimDispatch(tx, { dispatch, task: step, seat: spec.card.seat, capabilities: spec.capabilities, filler, worktree: entry.exportsProduct === true, card });
      // the materials as leaves (§5.2): `mp seat <id> read` reads them, hash-checked
      for (const m of ((spec.card['materials'] as MaterialRef[] | undefined) ?? [])) tx.leaves.writeDocument(materialLeaf(task.mission, m.ref), tx.data.text(m.ref));
      for (const r of spec.exclusive ?? []) acquireLease(tx, { resource: r, dispatch });
      // which step and which spec this dispatch took over (§3.2 item 1: the run chain)
      appendRecords(tx, [{ kind: 'flow.event', mission: task.mission as MissionId, line: DISPATCH_LINE(dispatch), event: 'claimed', key: 'spec', body: tx.data.put(canonicalJson({ spec: refreshed, task: step, lineage: spec.lineage, dispatches: prior })) as ContentHash }]);
      return { dispatch, card, cardLeaf: claimed.card?.leaf ?? dispatchLeaf(task.mission, dispatch, 'card'), worktree: claimed.worktree };
    },
    filler,
  );
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
    card: out.card,
    cardLeaf: out.cardLeaf,
    worktree,
    files: handBackFiles(out.dispatch),
    prompt: `You are the ${title} of Mission Pipeline. Your card: \`mp seat ${out.dispatch} card\`. Use only the \`mp seat ${out.dispatch}\` commands listed there. Finish with \`mp seat ${out.dispatch} handback\`.`,
  };
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
}

/** `mp pm release <id> --ended | --abandoned` (§5.4, WI-28). */
export async function pmRelease(ctx: ProcessContext, dispatch: string, how: 'ended' | 'abandoned', o: { readonly filler?: Filler | null } = {}): Promise<Released> {
  const d = ctx.memory.read((db) => dispatchInfo(db, dispatch));
  if (d === null) throw new LedgerError('UNKNOWN_DISPATCH', `no dispatch ${dispatch}`);
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
}

/** `mp pm renew` (§6.5): rerun the declared commands of the affected runs on clean checkouts; equal outputs renew the evidence. */
export async function pmRenew(ctx: ProcessContext): Promise<Renewed> {
  const env = ctx.environment();
  const c = ctx.memory.read((db) => renewalCandidates(db));
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
        const out = recordRenewedRun(tx, { original: cand.evidence, run: rec });
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
        results = ctx.memory.write({ op: `renew-pairs:${env.identity}:${sha256(canonicalJson(pairs))}`, payload }, (tx) => renewGroup(tx, r.runs));
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
  return { environment: c.environment, reruns, reviews: c.reviews, skipped, reviewSteps: needed.length };
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
export function pmDrain(ctx: ProcessContext, o: { readonly maxBatches?: number } = {}): DrainReport {
  return drain(ctx.memory, o);
}

/** `mp pm stop "<the words>"` (§6.6): written before anything queued; "stop recorded; N dispatches in flight". */
export function pmStop(ctx: ProcessContext, req: { readonly stop: string; readonly scope: StopRequest['scope']; readonly words: string; readonly wordsEntry?: string | null; readonly at?: number }): { readonly committed: boolean; readonly inFlight: number; readonly message: string } {
  const r: StopRequest & { wordsEntry: string | null } = { stop: req.stop as StopId, scope: req.scope, words: req.words, at: req.at ?? ctx.now(), wordsEntry: req.wordsEntry ?? null };
  const out = ctx.memory.write({ op: `stop:${req.stop}`, payload: r, stop: true, command: 'stop', filler: ctx.filler }, (tx) => commitStop(tx, r));
  return { ...out, message: `stop recorded; ${out.inFlight} dispatch${out.inFlight === 1 ? ' was' : 'es were'} in flight in its scope: stop them in your harness and report what it confirmed` };
}

// ---------------------------------------------------------------- the PM's flow commands

// `mp pm mission` / `mp pm close`: close.ts (pmMission, pmClose)

/**
 * `mp pm say "<the message, verbatim>"` (§6.1, decision 9): the maintainer's message recorded as a
 * words entry W-<n> before anything else. The same text as the latest entry returns that entry
 * (a hook adapter and the PM's own `say` record once).
 */
export function pmSay(ctx: ProcessContext, text: string, o: { readonly session?: string; readonly at?: number } = {}): { readonly words: string; readonly repeated: boolean } {
  const latest = ctx.memory.read((db) => latestUserWords(db, 1)[0] ?? null);
  if (latest !== null && latest.text === sha256(text)) {
    const w = ctx.memory.read((db) => wordsOfMessage(db, latest.message));
    if (w !== null) return { words: w.words, repeated: true };
  }
  const at = o.at ?? ctx.now();
  const message = `say-${sha256(`${at}\n${text}`).slice(0, 24)}`;
  // the session the words were said in: the PM session `mp pm session` recorded last (decision 8), unless named
  const session = o.session ?? ctx.memory.read((db) => latestPmSession(db)) ?? 'pm';
  const r = pmWrite(ctx, 'say', `say:${message}`, { message, text: sha256(text) }, (tx) => recordWords(tx, { message, session, at, text }));
  return { words: r.words, repeated: r.repeated };
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

/** `mp pm requirement withdraw <mission> <item> --reason ...`. */
export async function pmWithdrawRequirement(ctx: ProcessContext, req: { readonly mission: string; readonly item: string; readonly reason: string }): Promise<void> {
  await withdrawItem(ctx.ports(), { mission: req.mission as MissionId, item: req.item, reason: req.reason });
  await advance(ctx, req.mission as MissionId, { dispatch: null, task: null, step: 'mp pm requirement withdraw' });
}

/** `mp pm constraint add <mission> <constraint> --kind object|instruction --text ... [--paths] [--task-types] [--words W-<n>]`. */
export async function pmConstraint(ctx: ProcessContext, req: { readonly mission: string; readonly constraint: string; readonly kind: 'object' | 'instruction'; readonly text: string; readonly scope: ConstraintScope; readonly missionScope?: string; readonly words?: string }): Promise<{ readonly version: string }> {
  const scope: ConstraintScope = { ...req.scope, ...(req.missionScope !== undefined ? { mission: req.missionScope } : {}) };
  if (req.words !== undefined) wordsText(ctx, req.words);
  const version = await recordConstraint(ctx.ports(), { mission: req.mission as MissionId, constraint: req.constraint, kind: req.kind, text: req.text, scope, ...(req.words !== undefined ? { words: req.words } : {}) });
  await advance(ctx, undefined, { dispatch: null, task: null, step: 'mp pm constraint' });
  return { version };
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

/** `mp pm answer <mission> <escalation> --option ... --words W-<n> [--instructions ...] [--extra n]`: the user's decision. */
export async function pmAnswer(ctx: ProcessContext, req: { readonly mission: string; readonly escalation: string; readonly option: DecisionOption; readonly words: string; readonly instructions?: string; readonly grantExtra?: number }): Promise<void> {
  const text = wordsText(ctx, req.words);
  await answerEscalation(ctx.ports(), {
    mission: req.mission as MissionId,
    escalation: req.escalation,
    option: req.option,
    words: `${text} (${req.words})`,
    ...(req.instructions !== undefined ? { instructions: req.instructions } : {}),
    ...(req.grantExtra !== undefined ? { grantExtra: req.grantExtra } : {}),
  });
  await advance(ctx, req.mission as MissionId, { dispatch: null, task: null, step: 'mp pm answer' });
}

/** `mp pm grant <lineage> <loop> --extra <n> --words W-<n>` (WI-08: after the Secretary's one grant, only the user). */
export async function pmGrant(ctx: ProcessContext, req: { readonly mission?: string; readonly lineage: string; readonly loop: LoopKind; readonly extra: number; readonly words: string }): Promise<{ readonly granted: boolean; readonly why?: string }> {
  const text = wordsText(ctx, req.words);
  const g = await ctx.ports().scheduler.grant({ op: `grant:user:${req.lineage}:${req.loop}:${sha256(`${req.words}:${req.extra}`).slice(0, 12)}`, lineage: req.lineage, loop: req.loop, by: 'user', extra: req.extra, reason: `${text} (${req.words})` });
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
  req: { readonly mission: string; readonly delivery: string; readonly selected: readonly DeliveryTarget[]; readonly words?: string | null; readonly targetBranch?: string; readonly rebuildOf?: string | null; readonly message?: string | null },
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
