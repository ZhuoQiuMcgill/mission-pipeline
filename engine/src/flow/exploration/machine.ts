// The exploration as a state machine over its flow events (design 4.3, 6.2, 6.5, 8.2). The flow
// keeps no state of its own: `fold` rebuilds the state from the committed events of the line
// "exploration:<id>", and `decide` names the next action. Both are pure, so a flow restarted
// from ledger state takes exactly the step it would have taken (tests: restart mid-exploration).
//
// Events (line "exploration:<id>", key in parentheses):
//   defined (definition)   the definition, its basis version, the evidence environment, the snapshot
//   queued (<n>)           a seat task was submitted: role, purpose, round, card
//   consumed (<task>)      the flow took a task's accepted hand-back (or its end) into account
//   ruling (<id>)          the decision layer ruled: accept a residual risk, redirect, extend, stop, answer
//   stopped (<n>)          the exploration stopped and was handed to the decision layer (8.2)
//
// Rules (8.2): a round passes when no fatal or serious finding is unresolved after it (resolved:
// revised and confirmed by the attacker's re-check, rebutted by an evidence execution the attacker
// confirmed covers the counterexample, or accepted by the user as a residual risk). A pass by the
// continuing attacker calls in a closing attacker (a new session, 4.3 连续性) on the same frozen
// version; a pass by the closing attacker converges. The closing attacker continues as the
// attacker if it finds something. Stops: converged; budget exhausted (rounds); the same class of
// fatal finding not fixed in two consecutive rounds; no progress (6.5: two consecutive rounds
// with the same unresolved findings and nothing new). Research explorations (4.3): the method
// (with its attempt register) is attacked until a round passes; the registered attempts run
// blind; an interpreter who took part in none of it writes the interpretation, which is then
// attacked on its reasoning until it converges.

import type { ExplorationDefinition } from './definition.ts';
import { isBlocking, type Severity } from '../../seat/cards/crititor.ts';
import type { RegisteredAttemptT } from '../../seat/cards/researcher.ts';

// ---------------------------------------------------------------- event bodies

export type Role = 'author' | 'attacker' | 'executor' | 'interpreter';
export type Purpose = 'author' | 'attack' | 'discuss' | 'evidence' | 'attempt' | 'interpret';
export type Phase = 'product' | 'method' | 'attempts' | 'interpret' | 'reasoning';

export interface DefinedBody {
  readonly definition: ExplorationDefinition;
  readonly definitionDoc: string;
  readonly basisLine: string;
  readonly basisVersion: string;
  readonly envLine: string;
  readonly envSnapshot: string;
  readonly snapshot: { readonly path: string; readonly commit: string };
}

export interface EvidenceTaskInfo {
  readonly id: string;
  readonly k: number;
  readonly attempt: string | null;
  readonly executor: 'experiment' | 'reading';
  /** The task whose request it answers (null: a registered attempt). */
  readonly requester: string | null;
}

export interface QueuedBody {
  readonly n: number;
  readonly task: string;
  readonly lineage: string;
  readonly role: Role;
  readonly purpose: Purpose;
  /** The card in the content store (resubmitted from here if the scheduler lost the task). */
  readonly card: string;
  readonly round: number;
  readonly phase: Phase;
  /** Attacker: the closing attacker's first session (fresh). */
  readonly fresh: boolean;
  readonly target: string | null;
  readonly judgment: string | null;
  readonly evidence: EvidenceTaskInfo | null;
  /** A continuation after async evidence (6.2) of this task. */
  readonly resumeOf: string | null;
  /** Author / interpreter: the prefix of the version a submission makes. */
  readonly versionPrefix: string | null;
}

export interface Disposition {
  readonly finding: string;
  readonly action: 'revise' | 'rebut' | 'escalate';
  readonly note: string;
  readonly evidence: string | null;
  readonly question: string | null;
}

export interface NewFinding {
  readonly id: string;
  readonly severity: Severity;
  readonly class: string;
  readonly title: string;
  /** The finding's document (content store). */
  readonly doc: string;
}

export type ConsumedBody =
  | {
      readonly kind: 'author';
      readonly task: string;
      readonly step: 'discuss' | 'submit';
      readonly message: string;
      readonly version: string | null;
      readonly content: string | null;
      readonly changed: boolean;
      readonly dispositions: readonly Disposition[];
      readonly directionQuestions: readonly string[];
      readonly attempts: readonly RegisteredAttemptT[];
      readonly result: string | null;
    }
  | {
      readonly kind: 'interpretation';
      readonly task: string;
      readonly version: string;
      readonly content: string;
      readonly changed: boolean;
      readonly noConclusion: boolean;
      readonly message: string;
      readonly dispositions: readonly Disposition[];
      readonly result: string | null;
    }
  | {
      readonly kind: 'attack';
      readonly task: string;
      readonly target: string;
      readonly judgment: string;
      readonly verdict: 'pass' | 'fail' | 'undecided';
      readonly fresh: boolean;
      readonly findings: readonly NewFinding[];
      readonly rechecks: ReadonlyArray<{ readonly finding: string; readonly resolved: 'yes' | 'no'; readonly reason: string }>;
      readonly settled: readonly string[];
      readonly reply: string;
      readonly result: string | null;
    }
  | { readonly kind: 'discuss-reply'; readonly task: string; readonly reply: string; readonly result: string | null }
  | {
      readonly kind: 'needs-evidence';
      readonly task: string;
      readonly role: Role;
      readonly request: string | null;
      readonly recoveryState: string | null;
      readonly sessionId: string | null;
    }
  | {
      readonly kind: 'evidence';
      readonly task: string;
      readonly evidence: string;
      readonly status: 'completed' | 'unverified' | 'failed' | 'not-run';
      readonly summary: string;
      readonly report: string | null;
      readonly attempt: string | null;
      /** The program generated the record (8.2: a failed or unrun attempt). */
      readonly auto: boolean;
    }
  | { readonly kind: 'abandoned'; readonly task: string; readonly role: Role; readonly reason: string };

export interface RulingBody {
  readonly id: string;
  /**
   * accept-risk: the listed findings are accepted by the user as residual risks (8.2 "已解决");
   * redirect: the listed findings go back to the author with the ruling (a direction changed);
   * extend: more rounds (WI-08 grant); stop: the decision layer ends the exploration;
   * answer: an answer to a direction question, shown to the author and the attacker;
   * retry: queue again the turn whose seat task was given up (WI-15), and go on;
   * resume: go on after a stop with the budget left (a changed direction), adding nothing.
   */
  readonly decision: 'accept-risk' | 'redirect' | 'extend' | 'stop' | 'answer' | 'retry' | 'resume';
  readonly findings: readonly string[];
  readonly text: string;
  readonly extraRounds: number;
  /** extend: more spend for the exploration (micro-dollars), when its spend budget was the limit. */
  readonly extraMicros?: number;
  readonly by: 'user' | 'secretary' | 'pm';
}

export type StopReason = 'converged' | 'budget-exhausted' | 'fatal-repeat' | 'no-progress' | 'seat-abandoned' | 'stopped-by-decision';

export interface StoppedBody {
  readonly n: number;
  readonly reason: StopReason;
  readonly wi: string | null;
  /** The hand-off to the decision layer (8.2): a document in the content store. */
  readonly handoff: string;
  readonly version: string | null;
}

// ---------------------------------------------------------------- state

export interface FindingState {
  readonly id: string;
  readonly severity: Severity;
  readonly class: string;
  readonly title: string;
  readonly doc: string;
  readonly round: number;
  readonly version: string;
  /** The phase it was found in (research: method findings are not the interpreter's to dispose of). */
  readonly phase: Phase;
  status: 'open' | 'awaiting-recheck' | 'awaiting-ruling' | 'resolved';
  disposition: Disposition | null;
  ruling: string | null;
  residualRisk: boolean;
  /** Re-check outcomes, oldest first. */
  readonly rechecks: Array<{ readonly round: number; readonly resolved: 'yes' | 'no'; readonly reason: string }>;
}

export interface EvidenceState {
  readonly id: string;
  readonly k: number;
  readonly status: 'completed' | 'unverified' | 'failed' | 'not-run';
  readonly summary: string;
  readonly report: string | null;
  readonly attempt: string | null;
}

export interface VersionState {
  readonly id: string;
  readonly content: string;
  readonly round: number;
  readonly phase: Phase;
}

export interface AwaitingEvidence {
  readonly requester: string;
  readonly role: Role;
  readonly request: string | null;
  readonly recoveryState: string | null;
  readonly sessionId: string | null;
  /** The executor task, once queued. */
  executor: string | null;
  /** The evidence id, once recorded. */
  evidence: string | null;
}

export interface AttackEval {
  readonly round: number;
  readonly verdict: 'pass' | 'fail' | 'undecided';
  readonly converged: boolean;
  readonly fatalRepeat: readonly string[];
  readonly noProgress: boolean;
}

export interface XState {
  readonly defined: DefinedBody | null;
  readonly def: ExplorationDefinition | null;
  /** Seat tasks queued so far (the next task number is seq + 1). */
  seq: number;
  readonly tasks: Map<string, QueuedBody>;
  readonly consumed: Map<string, ConsumedBody>;
  /** Attacker turns handed back (attack and discussion). */
  rounds: number;
  extraRounds: number;
  /** Spend granted beyond the definition's budget (extend rulings with extraMicros). */
  extraMicros: number;
  phase: Phase;
  turn: 'author' | 'attacker' | 'await-ruling' | 'none';
  /** The next attacker turn is a discussion reply. */
  discussPending: boolean;
  version: VersionState | null;
  readonly versions: VersionState[];
  /** Research: the method version that passed and its register. */
  method: { readonly version: string; readonly attempts: readonly RegisteredAttemptT[] } | null;
  /** Research: the register submitted with the current method version. */
  register: readonly RegisteredAttemptT[];
  noConclusion: boolean;
  readonly findings: Map<string, FindingState>;
  readonly evidence: Map<string, EvidenceState>;
  evidenceSeq: number;
  readonly discussion: Array<{ readonly from: 'author' | 'attacker'; readonly round: number; readonly text: string }>;
  readonly rulings: RulingBody[];
  /** Resumable sessions per role (6.2: only after an evidence request is the state kept). */
  /** The current attacker session is the closing attacker's (it continues after a fresh start). */
  attackerClosing: boolean;
  /** The next attacker turn must start the closing attacker (fresh). */
  needClosing: boolean;
  awaitingEvidence: AwaitingEvidence | null;
  /** The last attack round, evaluated, while no task has been queued since. */
  afterAttack: AttackEval | null;
  /** Per attack round: the no-progress signature (null when the round raised new blocking findings). */
  readonly signatures: Array<string | null>;
  /** Per attack round: fatal classes whose fix failed in that round. */
  readonly fatalFailed: Array<readonly string[]>;
  /** The latest negation on each version by this exploration's attackers (for `revokes`, 8.1). */
  readonly negations: Map<string, string>;
  lastAttack: Extract<ConsumedBody, { kind: 'attack' }> | null;
  stopped: StoppedBody | null;
  stops: number;
  /** An author, attacker or interpreter task given up by the Secretary or the PM (WI-15), until a retry ruling. */
  abandoned: { readonly task: string; readonly role: Role; readonly reason: string } | null;
  /** Escalated questions not yet answered (for the hand-off). */
  readonly questions: string[];
}

export function emptyState(): XState {
  return {
    defined: null,
    def: null,
    seq: 0,
    tasks: new Map(),
    consumed: new Map(),
    rounds: 0,
    extraRounds: 0,
    extraMicros: 0,
    phase: 'product',
    turn: 'none',
    discussPending: false,
    version: null,
    versions: [],
    method: null,
    register: [],
    noConclusion: false,
    findings: new Map(),
    evidence: new Map(),
    evidenceSeq: 0,
    discussion: [],
    rulings: [],
    attackerClosing: false,
    needClosing: false,
    awaitingEvidence: null,
    afterAttack: null,
    signatures: [],
    fatalFailed: [],
    negations: new Map(),
    lastAttack: null,
    stopped: null,
    stops: 0,
    abandoned: null,
    questions: [],
  };
}

export interface XEvent {
  readonly event: string;
  readonly key: string;
  readonly body: unknown;
}

/** The state after the committed events, in commit order. */
export function fold(events: readonly XEvent[]): XState {
  const s = emptyState() as { -readonly [K in keyof XState]: XState[K] };
  for (const e of events) {
    switch (e.event) {
      case 'defined': {
        const b = e.body as DefinedBody;
        s.defined = b;
        s.def = b.definition;
        s.phase = b.definition.research ? 'method' : 'product';
        s.turn = 'author';
        break;
      }
      case 'redefined': {
        // a new definition version (the PM plan changed it): every judgment bound to the old one
        // is no longer current (5.2), so the current version is attacked again under the new one
        const b = e.body as { readonly definition: ExplorationDefinition; readonly definitionDoc: string; readonly basisVersion: string };
        if (s.defined === null) break;
        s.defined = { ...s.defined, definition: b.definition, definitionDoc: b.definitionDoc, basisVersion: b.basisVersion };
        s.def = b.definition;
        s.afterAttack = null;
        s.signatures.length = 0;
        s.fatalFailed.length = 0;
        if (s.stopped !== null && s.stopped.reason !== 'converged' && s.stopped.reason !== 'stopped-by-decision') s.stopped = null;
        if (s.version !== null && (s.turn === 'none' || s.turn === 'await-ruling') && (s.phase === 'product' || s.phase === 'reasoning')) {
          s.turn = 'attacker';
          s.needClosing = false;
          s.attackerClosing = false;
        }
        break;
      }
      case 'queued': {
        const q = e.body as QueuedBody;
        s.tasks.set(q.task, q);
        s.seq = Math.max(s.seq, q.n);
        s.afterAttack = null;
        if (q.role === 'executor' && q.evidence !== null) {
          if (q.evidence.requester !== null && s.awaitingEvidence !== null) s.awaitingEvidence.executor = q.task;
          s.evidenceSeq = Math.max(s.evidenceSeq, q.evidence.k);
        }
        if (q.resumeOf !== null && s.awaitingEvidence?.requester === q.resumeOf) s.awaitingEvidence = null;
        if (q.role === 'attacker' && q.fresh) {
          s.attackerClosing = true;
          s.needClosing = false;
        }
        break;
      }
      case 'consumed':
        consume(s, e.body as ConsumedBody);
        break;
      case 'ruling':
        rule(s, e.body as RulingBody);
        break;
      case 'stopped': {
        const b = e.body as StoppedBody;
        s.stopped = b;
        s.stops = Math.max(s.stops, b.n);
        break;
      }
      default:
        break; // unknown events of a newer flow are ignored
    }
  }
  return s;
}

type Mutable = { -readonly [K in keyof XState]: XState[K] };

function consume(s: Mutable, c: ConsumedBody): void {
  s.consumed.set(c.task, c);
  const q = s.tasks.get(c.task);
  switch (c.kind) {
    case 'needs-evidence':
      s.awaitingEvidence = { requester: c.task, role: c.role, request: c.request, recoveryState: c.recoveryState, sessionId: c.sessionId, executor: null, evidence: null };
      return;
    case 'evidence': {
      const k = q?.evidence?.k ?? s.evidenceSeq;
      s.evidence.set(c.evidence, { id: c.evidence, k, status: c.status, summary: c.summary, report: c.report, attempt: c.attempt });
      if (s.awaitingEvidence !== null && s.awaitingEvidence.executor === c.task) s.awaitingEvidence.evidence = c.evidence;
      if (s.phase === 'attempts' && s.method !== null && s.method.attempts.every((a) => [...s.evidence.values()].some((x) => x.attempt === a.id))) s.phase = 'interpret';
      return;
    }
    case 'abandoned':
      // the turn stays with the role (a retry ruling queues it again); decide() stops meanwhile
      s.abandoned = { task: c.task, role: c.role, reason: c.reason };
      return;
    case 'author': {
      if (c.step === 'discuss') {
        s.discussion.push({ from: 'author', round: s.rounds, text: c.message });
        s.discussPending = true;
        s.turn = 'attacker';
      } else {
        if (c.version !== null && c.content !== null && (s.version === null || s.version.id !== c.version)) {
          s.version = { id: c.version, content: c.content, round: s.rounds, phase: s.phase };
          s.versions.push(s.version);
        }
        if (s.phase === 'method') s.register = c.attempts;
        applyDispositions(s, c.dispositions);
        s.discussPending = false;
        s.turn = 'attacker';
      }
      for (const q2 of c.directionQuestions) s.questions.push(q2);
      return;
    }
    case 'interpretation': {
      if (s.phase === 'interpret') {
        s.phase = 'reasoning';
        s.attackerClosing = false;
        s.needClosing = false;
      }
      if (s.version === null || s.version.id !== c.version) {
        s.version = { id: c.version, content: c.content, round: s.rounds, phase: s.phase };
        s.versions.push(s.version);
      }
      s.noConclusion = c.noConclusion;
      applyDispositions(s, c.dispositions);
      s.turn = 'attacker';
      return;
    }
    case 'discuss-reply':
      s.rounds++;
      s.discussion.push({ from: 'attacker', round: s.rounds, text: c.reply });
      s.discussPending = false;
      s.turn = 'author';
      return;
    case 'attack':
      attack(s, c);
      return;
  }
}

function applyDispositions(s: Mutable, ds: readonly Disposition[]): void {
  for (const d of ds) {
    const f = s.findings.get(d.finding);
    if (f === undefined || f.status !== 'open') continue;
    f.disposition = d;
    f.status = d.action === 'escalate' ? 'awaiting-ruling' : 'awaiting-recheck';
  }
}

function attack(s: Mutable, c: Extract<ConsumedBody, { kind: 'attack' }>): void {
  s.rounds++;
  s.lastAttack = c;
  // fatal classes unresolved before this round (for "the same class not fixed twice", 8.2 #3)
  const fatalBefore = new Set([...s.findings.values()].filter((f) => f.severity === 'fatal' && f.status !== 'resolved').map((f) => f.class));
  const failed = new Set<string>();
  for (const r of c.rechecks) {
    const f = s.findings.get(r.finding);
    if (f === undefined) continue;
    f.rechecks.push({ round: s.rounds, resolved: r.resolved, reason: r.reason });
    if (r.resolved === 'yes') f.status = 'resolved';
    else {
      f.status = 'open';
      f.disposition = null;
      if (f.severity === 'fatal') failed.add(f.class);
    }
  }
  for (const n of c.findings) {
    if (!s.findings.has(n.id)) s.findings.set(n.id, { ...n, round: s.rounds, version: c.target, phase: s.phase, status: 'open', disposition: null, ruling: null, residualRisk: false, rechecks: [] });
    if (n.severity === 'fatal' && fatalBefore.has(n.class)) failed.add(n.class);
  }
  if (c.verdict === 'fail') s.negations.set(c.target, c.judgment);
  if (c.verdict === 'pass') s.negations.delete(c.target);
  // no progress (6.5): the same unresolved blocking findings twice in a row, nothing new
  const newBlocking = c.findings.some((f) => isBlocking(f.severity));
  const unresolved = [...s.findings.values()].filter((f) => isBlocking(f.severity) && f.status !== 'resolved').map((f) => f.id).sort();
  s.signatures.push(newBlocking || unresolved.length === 0 ? null : unresolved.join(','));
  s.fatalFailed.push([...failed].sort());
  const sig = s.signatures;
  const noProgress = sig.length >= 2 && sig[sig.length - 1] !== null && sig[sig.length - 1] === sig[sig.length - 2];
  const prevFailed = new Set(s.fatalFailed.length >= 2 ? s.fatalFailed[s.fatalFailed.length - 2] : []);
  const fatalRepeat = [...failed].filter((k) => prevFailed.has(k));
  const closing = s.attackerClosing;
  let converged = false;
  if (c.verdict === 'pass') {
    if (s.phase === 'method') {
      s.method = { version: c.target, attempts: s.register };
      s.phase = 'attempts';
      s.turn = 'none';
    } else if (closing) {
      converged = true;
      s.turn = 'none';
    } else {
      s.needClosing = true;
      s.turn = 'attacker';
    }
  } else {
    // the next turn follows the findings as they stand now, not the card's view: a ruling that
    // arrived while the attacker ran may have resolved or reopened what the card showed
    const mine = phaseFindings(s);
    if (mine.some((f) => f.status === 'open')) s.turn = 'author';
    else if (mine.some((f) => isBlocking(f.severity) && f.status === 'awaiting-ruling')) s.turn = 'await-ruling';
    else s.turn = 'attacker'; // everything blocking was settled by a ruling meanwhile: a re-check round gives the passing judgment
  }
  s.afterAttack = { round: s.rounds, verdict: c.verdict, converged, fatalRepeat, noProgress };
}

function rule(s: Mutable, r: RulingBody): void {
  s.rulings.push(r);
  switch (r.decision) {
    case 'accept-risk':
      for (const id of r.findings) {
        const f = s.findings.get(id);
        if (f === undefined) continue;
        f.status = 'resolved';
        f.residualRisk = true;
        f.ruling = r.text;
      }
      // a new judgment on the version is needed before it can converge (the position still holds
      // the last verdict): the attacker re-checks it with the ruling
      if (s.turn === 'await-ruling') s.turn = 'attacker';
      break;
    case 'redirect':
      for (const id of r.findings) {
        const f = s.findings.get(id);
        if (f === undefined) continue;
        f.status = 'open';
        f.disposition = null;
        f.ruling = r.text;
      }
      if (s.turn === 'await-ruling') s.turn = 'author';
      break;
    case 'extend':
      s.extraRounds += r.extraRounds;
      s.extraMicros += r.extraMicros ?? 0;
      if (s.stopped !== null && s.stopped.reason !== 'converged' && s.stopped.reason !== 'stopped-by-decision') s.stopped = null;
      // a grant restarts no-progress detection (6.5 as for loop grants)
      s.signatures.length = 0;
      s.fatalFailed.length = 0;
      s.afterAttack = null;
      break;
    case 'resume':
      if (s.stopped !== null && s.stopped.reason !== 'converged' && s.stopped.reason !== 'stopped-by-decision') s.stopped = null;
      // a changed direction restarts no-progress detection (6.5 as for loop grants)
      s.signatures.length = 0;
      s.fatalFailed.length = 0;
      s.afterAttack = null;
      break;
    case 'retry':
      s.abandoned = null;
      if (s.stopped !== null && s.stopped.reason === 'seat-abandoned') s.stopped = null;
      s.afterAttack = null;
      break;
    case 'stop':
      break; // decide() records the stop
    case 'answer':
      break;
  }
}

/** The findings of the current phase (research: the method's findings stay with the method). */
export function phaseFindings(s: XState): FindingState[] {
  const ph = s.phase === 'interpret' ? 'reasoning' : s.phase === 'attempts' ? 'method' : s.phase;
  return [...s.findings.values()].filter((f) => f.phase === ph);
}

// ---------------------------------------------------------------- decide

export type Action =
  | { readonly kind: 'none'; readonly why: string }
  | { readonly kind: 'stop'; readonly reason: StopReason; readonly wi: string | null }
  | { readonly kind: 'author' }
  | { readonly kind: 'interpreter' }
  | { readonly kind: 'attacker'; readonly mode: 'attack' | 'discuss'; readonly fresh: boolean }
  | { readonly kind: 'evidence'; readonly requester: string; readonly overCap: boolean }
  | { readonly kind: 'resume'; readonly requester: string }
  | { readonly kind: 'attempts'; readonly attempts: readonly RegisteredAttemptT[] };

export function allowedRounds(s: XState): number {
  return (s.def?.budget.rounds ?? 0) + s.extraRounds;
}

/** Tasks queued and not consumed yet. */
export function pendingTasks(s: XState): QueuedBody[] {
  return [...s.tasks.values()].filter((q) => !s.consumed.has(q.task));
}

/** Facts decide() needs from outside the events: the exploration's spend so far (null: not metered here). */
export interface DecideFacts {
  readonly spentMicros: number | null;
}

/** How many evidence requests the turn ending in this task has made (its resume chain, 6.2). */
export function evidenceChain(s: XState, task: string): number {
  let n = 0;
  let t: string | null = task;
  const seen = new Set<string>();
  while (t !== null && !seen.has(t)) {
    seen.add(t);
    if (s.consumed.get(t)?.kind === 'needs-evidence') n++;
    t = s.tasks.get(t)?.resumeOf ?? null;
  }
  return n;
}

export function decide(s: XState, facts: DecideFacts = { spentMicros: null }): Action {
  if (s.def === null) return { kind: 'none', why: 'not defined' };
  if (s.stopped !== null) return { kind: 'none', why: `stopped (${s.stopped.reason})` };
  if (s.rulings.some((r) => r.decision === 'stop')) return { kind: 'stop', reason: 'stopped-by-decision', wi: null };
  // an author, attacker or interpreter task given up (WI-15 by the scheduler) stops the
  // exploration until the decision layer rules "retry" (an evidence run given up gets its failed
  // record from the program instead, and the requester goes on)
  if (s.abandoned !== null) return { kind: 'stop', reason: 'seat-abandoned', wi: 'WI-15' };
  // research attempts run side by side (blind, separate units)
  if (s.phase === 'attempts' && s.method !== null) {
    const queued = new Set([...s.tasks.values()].flatMap((q) => (q.evidence?.attempt != null && q.evidence.requester === null ? [q.evidence.attempt] : [])));
    const missing = s.method.attempts.filter((a) => !queued.has(a.id));
    if (missing.length > 0) return { kind: 'attempts', attempts: missing };
    return { kind: 'none', why: 'registered attempts running' };
  }
  if (pendingTasks(s).length > 0) return { kind: 'none', why: 'a seat task is running' };
  if (s.awaitingEvidence !== null) {
    const a = s.awaitingEvidence;
    if (a.executor === null) return { kind: 'evidence', requester: a.requester, overCap: evidenceChain(s, a.requester) > s.def.evidencePerTurn };
    if (a.evidence !== null) return { kind: 'resume', requester: a.requester };
    return { kind: 'none', why: 'evidence running' };
  }
  const ev = s.afterAttack;
  if (ev !== null) {
    if (ev.converged) return { kind: 'stop', reason: 'converged', wi: null };
    if (ev.fatalRepeat.length > 0) return { kind: 'stop', reason: 'fatal-repeat', wi: 'WI-08' };
    if (ev.noProgress) return { kind: 'stop', reason: 'no-progress', wi: 'WI-08' };
  }
  if (s.phase === 'interpret') return { kind: 'interpreter' };
  // the exploration's own spend budget (4.3 预算, 6.5): no new author or attacker turn past it
  const cap = s.def.budget.spendMicros;
  if (cap !== null && facts.spentMicros !== null && facts.spentMicros >= cap + s.extraMicros && (s.turn === 'author' || s.turn === 'attacker')) {
    return { kind: 'stop', reason: 'budget-exhausted', wi: 'WI-08' };
  }
  switch (s.turn) {
    case 'author':
      if (s.rounds >= allowedRounds(s)) return { kind: 'stop', reason: 'budget-exhausted', wi: 'WI-08' };
      return s.phase === 'reasoning' ? { kind: 'interpreter' } : { kind: 'author' };
    case 'attacker':
      if (s.rounds >= allowedRounds(s)) return { kind: 'stop', reason: 'budget-exhausted', wi: 'WI-08' };
      return { kind: 'attacker', mode: s.discussPending ? 'discuss' : 'attack', fresh: s.needClosing };
    case 'await-ruling':
      return { kind: 'none', why: 'waiting for the decision layer to rule on escalated findings' };
    case 'none':
      return { kind: 'none', why: 'nothing to do' };
  }
}
