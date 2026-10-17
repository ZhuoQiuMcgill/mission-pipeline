// The exploration as a state machine over its flow events (design 4.1 §6.3; 4.0 4.3, 6.2, 6.5,
// 8.2). The flow keeps no state of its own: `fold` rebuilds the state from the committed events
// of the line "exploration:<id>", and `decide` names the next action. Both are pure, so a flow
// restarted from the memory takes exactly the step it would have taken (tests: restart
// mid-exploration).
//
// Rounds with the Stabilizer (4.1 §6.3, U-6): each round goes through
//   attacked        the Crititor's hand-back: findings with severities
//   dispositioned   the author's hand-back: a disposition per finding
//   stabilized      the Stabilizer's hand-back (a new instance each round): a verdict per finding
//                   (in scope / shifts direction / out of scope) with its severity, and the round
//                   verdict (on track / drifting)
//   awaiting ruling a finding that shifts direction, or a drifting round: the question goes to the
//                   Secretary, and the exploration waits for the ruling (WI-33)
// then the next round. Every attack round is stabilized (code review r1 #1): a round that left the
// author nothing to answer (the attacker passed it, or found nothing) is dispositioned with no
// dispositions and goes to the Stabilizer at once, which judges its findings (general ones too)
// and the drift; the closing round too. Only in-scope findings bind the author; a finding judged
// out of scope or shifting direction never refutes the version. The round is evaluated after its
// stabilization: whether it passed (no in-scope fatal or serious finding unresolved on the same
// version: a closing attacker next, or convergence after the closing round), the same class of
// fatal finding not fixed twice, no progress. The round budget (default 3) ends after the last
// round is stabilized; an exploration that has not converged then goes to the Secretary with the
// findings, the dispositions and the Stabilizer's judgments (WI-08, whose extension rule stays).
//
// A direction question is pending (code review r1 #2) while any of these waits for its ruling at
// the Secretary: an author's direction question, a finding the author escalated (any severity), a
// finding the Stabilizer judged shifting direction, a drifting round. Only the recorded ruling
// clears it. It gates convergence, the acceptance and the research method's pass: a round that
// would pass waits in "awaiting ruling". It gates nothing else: open findings are answered and
// re-checked meanwhile.
//
// Events (line "exploration:<id>", key in parentheses):
//   defined (definition)   the definition, its basis version, the evidence environment, the snapshot
//   queued (<n>)           a seat task was submitted: role, purpose, round, card
//   consumed (<task>)      the flow took a task's accepted hand-back (or its end) into account
//   ruling (<id>)          the decision layer ruled: accept a residual risk, redirect, extend, stop, answer
//   stopped (<n>)          the exploration stopped and was handed to the decision layer (8.2)
//   rerun (<key>)          the environment changed under evidence executions the converged version
//                          rests on (code review r1 #3): they run again (the same request, blind),
//                          then the same position judges the version again with the new records
//   settled (<x>, <x>#<n>) the step handed a stop to the decision layer (plandoc.ts): one per opening
//
// Settling (code review r1 #3 carried through): an exploration settles at most once per opening, and
// a rerun that reopens a converged exploration (or a redefinition that clears a stop) opens it again.
// The current settle is the one recorded since the last reopening (`settled`); earlier ones are
// history (`settles`). While reopened nothing is current: every exit of the reopened machine is
// routed like a first stop again (a settle, an escalation to the Secretary, or a step to take).
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
import type { ExplorationSettledBody, RepairRef } from '../plandoc.ts';
import { isBlocking, type Severity } from '../../seat/cards/crititor.ts';
import type { RegisteredAttemptT } from '../../seat/cards/researcher.ts';

// ---------------------------------------------------------------- event bodies

export type Role = 'author' | 'attacker' | 'executor' | 'interpreter' | 'stabilizer';
export type Purpose = 'author' | 'attack' | 'discuss' | 'evidence' | 'attempt' | 'interpret' | 'stabilize';
export type FindingScope = 'in-scope' | 'shifts-direction' | 'out-of-scope';
export type Phase = 'product' | 'method' | 'attempts' | 'interpret' | 'reasoning';

export interface DefinedBody {
  readonly definition: ExplorationDefinition;
  readonly definitionDoc: string;
  readonly basisLine: string;
  readonly basisVersion: string;
  readonly envLine: string;
  readonly envSnapshot: string;
  /** The commit the seats read (`path` is what the cards name: the commit, or a project-relative path). */
  readonly snapshot: { readonly path: string; readonly commit: string };
}

export interface EvidenceTaskInfo {
  readonly id: string;
  readonly k: number;
  readonly attempt: string | null;
  readonly executor: 'experiment' | 'reading';
  /** The task whose request it answers (null: a registered attempt). */
  readonly requester: string | null;
  /** An evidence execution run again after an environment change: the one it replaces (code review r1 #3). */
  readonly rerunOf?: string;
}

/** The evidence executions to run again (code review r1 #3), under the environment identity named. */
export interface RerunBody {
  readonly evidence: readonly string[];
  readonly environment: string;
  /**
   * 4.1.2 (D-10): a repair about this exploration: it is reopened for one more round with the repair
   * as an added question (on every card of the round); its settled conclusion stays as history.
   */
  readonly repair?: RepairRef;
}

export interface QueuedBody {
  readonly n: number;
  readonly task: string;
  readonly lineage: string;
  readonly role: Role;
  readonly purpose: Purpose;
  /** The card in the data table (submitted again from here if the memory lost the task). */
  readonly card: string;
  readonly round: number;
  readonly phase: Phase;
  /** Attacker: the closing attacker's first session (fresh). */
  readonly fresh: boolean;
  readonly target: string | null;
  readonly judgment: string | null;
  readonly evidence: EvidenceTaskInfo | null;
  /** A continuation after async evidence (4.1 §5.4: a new card) of this task. */
  readonly resumeOf: string | null;
  /** Author / interpreter: the prefix of the version a submission makes. */
  readonly versionPrefix: string | null;
  /** The definition version (basis version) current when its card was built: an attack round is pinned to it (final review F1). */
  readonly basis?: string;
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
  /** The finding's document (a data value). */
  readonly doc: string;
}

/** The Stabilizer's verdict on one finding (4.1 §6.3). */
export interface FindingVerdict {
  readonly finding: string;
  readonly verdict: FindingScope;
  readonly severity: Severity;
  readonly reason: string;
  readonly question: string | null;
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
      /** The evidence the round's judgment requires (the Stabilizer's judgment binds the same). */
      readonly evidence?: readonly string[];
    }
  | { readonly kind: 'discuss-reply'; readonly task: string; readonly reply: string; readonly result: string | null }
  | {
      readonly kind: 'stabilized';
      readonly task: string;
      /** The attack round judged, and the version it attacked. */
      readonly round: number;
      readonly target: string;
      /** The position judgment it recorded, and its verdict (4.1 §6.3). */
      readonly judgment: string;
      readonly verdict: 'pass' | 'fail' | 'undecided';
      readonly findings: readonly FindingVerdict[];
      readonly drift: { readonly verdict: 'on-track' | 'drifting'; readonly reason: string; readonly question: string | null };
      readonly result: string | null;
    }
  | {
      readonly kind: 'needs-evidence';
      readonly task: string;
      readonly role: Role;
      readonly request: string | null;
      /** The notes the seat saved to continue from (a data value), or null. */
      readonly notes: string | null;
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
   * retry: queue again the turn whose seat task was given up (WI-28), and go on;
   * resume: go on after a stop with the budget left (a changed direction), adding nothing;
   * keep-direction (4.1 §6.3, WI-33): the definition stands: the listed findings the Stabilizer
   * judged shifting direction are set aside, a drift is cleared, and the rounds go on.
   * A redirect also clears a drift.
   */
  readonly decision: 'accept-risk' | 'redirect' | 'extend' | 'stop' | 'answer' | 'retry' | 'resume' | 'keep-direction';
  readonly findings: readonly string[];
  /** answer: the author task whose direction questions it answers (they stop being pending). */
  readonly answers?: string;
  /** keep-direction / redirect: the ruling of the drift's own escalation (only it clears the drift, code review r2 #1). */
  readonly drift?: true;
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
  /** The hand-off to the decision layer (8.2): a data value. */
  readonly handoff: string;
  readonly version: string | null;
}

/** A "settled" event of the exploration (plandoc.ts): its key, its number (1 for the first), its body. */
export interface SettleRecord {
  readonly key: string;
  readonly n: number;
  readonly body: ExplorationSettledBody;
}

/** The key and the op part of the n-th settle: the first keeps the exploration id (and op "settled"). */
export function settleKey(x: string, n: number): { readonly key: string; readonly op: string } {
  return n <= 1 ? { key: x, op: 'settled' } : { key: `${x}#${n}`, op: `settled:${n}` };
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
  /** The Stabilizer's verdict (null before its round is stabilized), its severity, and a direction question. */
  scope: FindingScope | null;
  judgedSeverity: Severity | null;
  question: string | null;
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
  /** The notes the requester saved (a data value). */
  readonly notes: string | null;
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

/** An attack round between its attack and its stabilization: what the round's evaluation needs. */
export interface Stabilizing {
  readonly round: number;
  readonly target: string;
  readonly attack: string;
  /** The findings the Stabilizer judges: the round's new ones and those its re-check reopened (none: it judges the round). */
  readonly findings: readonly string[];
  readonly evidence: readonly string[];
  /** The attacker session was the closing attacker's. */
  readonly closing: boolean;
  /** Fatal classes unresolved before the round (8.2 #3). */
  readonly fatalBefore: readonly string[];
  readonly reopened: readonly string[];
  readonly fresh: readonly string[];
  /** The round is judged a second time, from a current card (code review r2 #4). */
  readonly again?: boolean;
  /** The definition version the round's attacker card was built under; its Stabilizer binds the same (final review F1). */
  readonly basis?: string;
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
  turn: 'author' | 'attacker' | 'stabilizer' | 'await-ruling' | 'none';
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
  /** An author, attacker or interpreter task given up by the Secretary or the PM (WI-28), until a retry ruling. */
  abandoned: { readonly task: string; readonly role: Role; readonly reason: string } | null;
  /** Escalated questions not yet answered (for the hand-off). */
  readonly questions: string[];
  /** The attack round to stabilize (4.1 §6.3: every round, after its disposition), or null. */
  stabilizing: Stabilizing | null;
  /** The author's direction questions waiting for their ruling (code review r1 #2), by the author task that asked. */
  readonly pendingQuestions: Array<{ readonly task: string; readonly questions: readonly string[] }>;
  /** A drifting round's question, waiting for a ruling (WI-33), or null. */
  drift: { readonly round: number; readonly reason: string; readonly question: string | null } | null;
  /** The Stabilizer's judgments, round by round. */
  readonly stabilizations: Array<Extract<ConsumedBody, { kind: 'stabilized' }>>;
  /** Evidence executions run again after an environment change: old id → its replacement (null until recorded). */
  readonly reruns: Map<string, string | null>;
  /** Rounds added for the re-judgment after reruns (an environment change uses no round of the budget). */
  rerunRounds: number;
  /** Every definition version so far, by basis version (a round is judged under the version it was pinned to). */
  readonly definitions: Map<string, { readonly definition: ExplorationDefinition; readonly definitionDoc: string }>;
  /** Every settle so far, oldest first (the decision layer's record; all but the current one are history). */
  readonly settles: SettleRecord[];
  /** The current settle: the one recorded since the exploration last reopened, or null (not settled, or reopened since). */
  settled: SettleRecord | null;
  /** 4.1.2: the repairs that reopened it, each an added question its later rounds answer. */
  readonly repairs: RepairRef[];
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
    stabilizing: null,
    pendingQuestions: [],
    drift: null,
    stabilizations: [],
    reruns: new Map(),
    rerunRounds: 0,
    definitions: new Map(),
    settles: [],
    settled: null,
    repairs: [],
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
        s.definitions.set(b.basisVersion, { definition: b.definition, definitionDoc: b.definitionDoc });
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
        s.definitions.set(b.basisVersion, { definition: b.definition, definitionDoc: b.definitionDoc });
        s.afterAttack = null;
        s.signatures.length = 0;
        s.fatalFailed.length = 0;
        if (s.stopped !== null && s.stopped.reason !== 'converged' && s.stopped.reason !== 'stopped-by-decision') {
          // the machine reopens: a settle of the stop it leaves is history (the step never redefines a settled exploration)
          s.stopped = null;
          s.settled = null;
        }
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
      case 'rerun': {
        const b = e.body as RerunBody;
        if (b.repair !== undefined) {
          // a repair (D-10): one more round with the repair as an added question; a stop of any kind
          // reopens (its settle becomes history), and the author answers it first
          if (s.repairs.some((r) => r.id === b.repair!.id)) break;
          s.repairs.push(b.repair);
          // one more round, and its closing attacker (a round that passes converges only after one)
          s.rerunRounds += 2;
          if (s.stopped !== null) {
            s.stopped = null;
            s.settled = null;
            s.afterAttack = null;
            s.signatures.length = 0;
            s.fatalFailed.length = 0;
            s.needClosing = false;
            s.attackerClosing = false;
            if (s.turn === 'none' || s.turn === 'await-ruling' || s.turn === 'attacker') s.turn = 'author';
          }
          break;
        }
        // only a converged exploration is reopened for it (an active one judges the new records in its rounds)
        let added = false;
        for (const id of b.evidence) {
          if (s.reruns.has(id)) continue;
          s.reruns.set(id, null);
          added = true;
        }
        if (added) {
          s.rerunRounds++;
          if (s.stopped !== null && s.stopped.reason === 'converged') {
            // reopened: the conclusion settled for that stop becomes history; the next stop settles or escalates again
            s.stopped = null;
            s.settled = null;
          }
          s.afterAttack = null;
        }
        break;
      }
      case 'settled': {
        // one settle per opening (the step's rule): the first since the last reopening is the current one
        const rec: SettleRecord = { key: e.key, n: s.settles.length + 1, body: e.body as ExplorationSettledBody };
        s.settles.push(rec);
        if (s.settled === null) s.settled = rec;
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
      s.awaitingEvidence = { requester: c.task, role: c.role, request: c.request, notes: c.notes, executor: null, evidence: null };
      return;
    case 'evidence': {
      const k = q?.evidence?.k ?? s.evidenceSeq;
      s.evidence.set(c.evidence, { id: c.evidence, k, status: c.status, summary: c.summary, report: c.report, attempt: c.attempt });
      if (s.awaitingEvidence !== null && s.awaitingEvidence.executor === c.task) s.awaitingEvidence.evidence = c.evidence;
      const old = q?.evidence?.rerunOf;
      if (old !== undefined && s.reruns.has(old)) {
        s.reruns.set(old, c.evidence);
        if ([...s.reruns.values()].every((v) => v !== null)) applyReruns(s);
      }
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
        // 4.1 §6.3: the round the author answered is stabilized before the next attack
        s.turn = s.stabilizing !== null ? 'stabilizer' : 'attacker';
      }
      for (const q2 of c.directionQuestions) s.questions.push(q2);
      if (c.directionQuestions.length > 0) s.pendingQuestions.push({ task: c.task, questions: c.directionQuestions });
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
      s.turn = s.stabilizing !== null ? 'stabilizer' : 'attacker';
      return;
    }
    case 'stabilized':
      stabilize(s, c);
      return;
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

/**
 * Every evidence execution run again is recorded (code review r1 #3): a rebuttal that rested on an
 * old record now rests on its replacement and goes back to the attacker's re-check; the same
 * position judges the version again (the attacker's round, then its Stabilizer).
 */
function applyReruns(s: Mutable): void {
  for (const f of s.findings.values()) {
    const d = f.disposition;
    if (d === null || d.evidence === null) continue;
    const rep = s.reruns.get(d.evidence);
    if (rep === undefined || rep === null) continue;
    f.disposition = { ...d, evidence: rep };
    if (f.status === 'resolved' && d.action === 'rebut') f.status = 'awaiting-recheck';
  }
  s.discussPending = false;
  s.needClosing = false;
  s.turn = 'attacker';
  s.afterAttack = null;
}

function applyDispositions(s: Mutable, ds: readonly Disposition[]): void {
  for (const d of ds) {
    const f = s.findings.get(d.finding);
    if (f === undefined || f.status !== 'open') continue;
    f.disposition = d;
    f.status = d.action === 'escalate' ? 'awaiting-ruling' : 'awaiting-recheck';
  }
}

/** The severity that counts: the Stabilizer's when it judged the finding (4.1 §6.3), else the attacker's. */
export function effectiveSeverity(f: FindingState): Severity {
  return f.judgedSeverity ?? f.severity;
}

/** A finding that can block convergence or refute a version: fatal or serious, and not judged out of scope or shifting direction. */
export function blocks(f: FindingState): boolean {
  return f.scope !== 'out-of-scope' && f.scope !== 'shifts-direction' && isBlocking(effectiveSeverity(f));
}

/**
 * A direction question waits for its ruling at the Secretary (4.1 §6.3, code review r1 #2): an
 * author's question, a finding the author escalated (any severity) or the Stabilizer judged
 * shifting direction, a drifting round. Only the recorded ruling clears it.
 */
export function directionPending(s: XState): boolean {
  return s.drift !== null || s.pendingQuestions.length > 0 || [...s.findings.values()].some((f) => f.status === 'awaiting-ruling');
}

/** The turn after a ruling cleared the last direction question: the author for open findings, else a re-check round (the position's next judgment). */
function afterRuling(s: Mutable): void {
  if (s.turn !== 'await-ruling' || directionPending(s)) return;
  s.turn = phaseFindings(s).some((f) => f.status === 'open') ? 'author' : 'attacker';
}

function attack(s: Mutable, c: Extract<ConsumedBody, { kind: 'attack' }>): void {
  s.rounds++;
  s.lastAttack = c;
  // fatal classes unresolved before this round (for "the same class not fixed twice", 8.2 #3)
  const fatalBefore = [...new Set([...s.findings.values()].filter((f) => blocks(f) && effectiveSeverity(f) === 'fatal' && f.status !== 'resolved').map((f) => f.class))];
  const reopened: string[] = [];
  for (const r of c.rechecks) {
    const f = s.findings.get(r.finding);
    if (f === undefined) continue;
    f.rechecks.push({ round: s.rounds, resolved: r.resolved, reason: r.reason });
    if (r.resolved === 'yes') f.status = 'resolved';
    else {
      f.status = 'open';
      f.disposition = null;
      reopened.push(f.id);
    }
  }
  for (const n of c.findings) {
    if (!s.findings.has(n.id)) {
      s.findings.set(n.id, { ...n, round: s.rounds, version: c.target, phase: s.phase, status: 'open', disposition: null, ruling: null, residualRisk: false, rechecks: [], scope: null, judgedSeverity: null, question: null });
    }
  }
  // the Crititor's own judgment fails only on an in-scope finding left unresolved; anything else is
  // pending until the round is stabilized (4.1 §6.3)
  if (c.verdict === 'fail') s.negations.set(c.target, c.judgment);
  const mine = phaseFindings(s);
  const toJudge = mine.filter((f) => f.status !== 'resolved' && (f.scope === null || reopened.includes(f.id))).map((f) => f.id);
  s.stabilizing = {
    round: s.rounds,
    target: c.target,
    attack: c.task,
    findings: toJudge,
    evidence: c.evidence ?? [],
    closing: s.attackerClosing,
    fatalBefore,
    reopened,
    fresh: c.findings.map((n) => n.id),
    // pinned to the definition version its attacker card was built under (final review F1)
    ...(s.tasks.get(c.task)?.basis !== undefined ? { basis: s.tasks.get(c.task)!.basis } : s.defined !== null ? { basis: s.defined.basisVersion } : {}),
  };
  // the next turn follows the findings as they stand now, not the card's view (a ruling that arrived
  // while the attacker ran may have resolved or reopened what the card showed): the author answers
  // the round when it left findings to answer; otherwise it is dispositioned as it is and goes to the
  // Stabilizer at once (code review r1 #1: every round is stabilized, the closing round included)
  const open = mine.filter((f) => f.status === 'open');
  s.turn = c.verdict !== 'pass' && open.length > 0 ? 'author' : 'stabilizer';
  s.afterAttack = null;
}

/**
 * The Stabilizer's hand-back (4.1 §6.3): verdicts applied to the round's findings; then the round
 * is evaluated (code review r1 #1: after stabilization): passed or not, the 8.2 stops, the next turn.
 */
function stabilize(s: Mutable, c: Extract<ConsumedBody, { kind: 'stabilized' }>): void {
  for (const v of c.findings) {
    const f = s.findings.get(v.finding);
    if (f === undefined) continue;
    f.scope = v.verdict;
    f.judgedSeverity = v.severity;
    f.question = v.question;
    // out of scope: never binds the author, never refutes (an escalated one still waits for its
    // ruling: only the ruling clears it); shifting direction: not fixed, a question for the Secretary
    if (v.verdict === 'out-of-scope' && f.status !== 'awaiting-ruling') f.status = 'resolved';
    else if (v.verdict === 'shifts-direction') f.status = 'awaiting-ruling';
  }
  if (c.drift.verdict === 'drifting') s.drift = { round: c.round, reason: c.drift.reason, question: c.drift.question };
  if (c.verdict === 'fail') s.negations.set(c.target, c.judgment);
  if (c.verdict === 'pass') s.negations.delete(c.target);
  s.stabilizations.push(c);
  const st = s.stabilizing;
  s.stabilizing = null;
  if (st === null) {
    s.afterAttack = null;
    s.turn = 'attacker';
    return;
  }
  // 8.2 #3 and 6.5, on the findings as judged: the same fatal class not fixed in two consecutive
  // rounds; two rounds with the same unresolved blocking findings and nothing new
  const fatalBefore = new Set(st.fatalBefore);
  const failed = new Set<string>();
  for (const id of st.reopened) {
    const f = s.findings.get(id);
    if (f !== undefined && blocks(f) && effectiveSeverity(f) === 'fatal' && f.status !== 'resolved') failed.add(f.class);
  }
  for (const id of st.fresh) {
    const f = s.findings.get(id);
    if (f !== undefined && blocks(f) && effectiveSeverity(f) === 'fatal' && fatalBefore.has(f.class)) failed.add(f.class);
  }
  const newBlocking = st.fresh.some((id) => {
    const f = s.findings.get(id);
    return f !== undefined && blocks(f);
  });
  const unresolved = [...s.findings.values()].filter((f) => blocks(f) && f.status !== 'resolved').map((f) => f.id).sort();
  s.signatures.push(newBlocking || unresolved.length === 0 ? null : unresolved.join(','));
  s.fatalFailed.push([...failed].sort());
  const sig = s.signatures;
  const noProgress = sig.length >= 2 && sig[sig.length - 1] !== null && sig[sig.length - 1] === sig[sig.length - 2];
  const prevFailed = new Set(s.fatalFailed.length >= 2 ? s.fatalFailed[s.fatalFailed.length - 2] : []);
  const fatalRepeat = [...failed].filter((k) => prevFailed.has(k));
  // the next turn
  const mine = phaseFindings(s);
  let converged = false;
  if (mine.some((f) => f.status === 'open' && blocks(f))) {
    // a finding the Stabilizer made binding (a severity it raised): the author answers it
    s.turn = 'author';
  } else {
    // the round passed: nothing in scope, fatal or serious, unresolved on the version it attacked
    const passed = !mine.some((f) => blocks(f) && f.status !== 'resolved' && f.status !== 'awaiting-ruling') && s.version?.id === st.target;
    // a round pinned to a definition version that is no longer current never converges (final
    // review F1): after a redefinition the closing round is a fresh attacker under the current
    // version, then its Stabilizer (no round left: the budget stop, WI-08)
    const stale = st.basis !== undefined && s.defined !== null && st.basis !== s.defined.basisVersion;
    if (!passed) s.turn = 'attacker';
    else if (stale && !directionPending(s)) {
      s.turn = 'attacker';
      if (s.phase !== 'method') s.needClosing = true;
    } else if (directionPending(s)) {
      // only the ruling stands between it and passing (4.1 §6.3): it waits; once ruled, the closing
      // attacker comes in (or, after the closing round, continues) for the position's next judgment
      s.turn = 'await-ruling';
      // a round with no fatal or serious finding at all passed: the closing attacker is next; one
      // whose blocking finding waits for the ruling is re-checked first
      const clean = !mine.some((f) => blocks(f) && f.status !== 'resolved');
      if (s.phase !== 'method' && ((clean && !st.closing) || stale)) s.needClosing = true;
    } else if (c.verdict !== 'pass') {
      // a round passes only on a recorded pass (code review r2 #4). "undecided": the Stabilizer judged
      // from a card whose direction question has been ruled since; one new Stabilizer judges the same
      // round from a current card (not a new round), and its evaluation replaces this one. A "fail"
      // (a blocking finding a ruling has settled since): the attacker's re-check round judges again
      if (c.verdict === 'undecided' && st.again !== true) {
        s.signatures.pop();
        s.fatalFailed.pop();
        s.stabilizing = { ...st, again: true };
        s.turn = 'stabilizer';
        s.afterAttack = null;
        return;
      }
      s.turn = 'attacker';
    } else if (s.phase === 'method') {
      s.method = { version: st.target, attempts: s.register };
      s.phase = 'attempts';
      s.turn = 'none';
    } else if (st.closing) {
      converged = true;
      s.turn = 'none';
    } else {
      s.needClosing = true;
      s.turn = 'attacker';
    }
  }
  s.afterAttack = { round: st.round, verdict: c.verdict, converged, fatalRepeat, noProgress };
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
      afterRuling(s);
      break;
    case 'redirect': {
      let reopened = false;
      for (const id of r.findings) {
        const f = s.findings.get(id);
        if (f === undefined) continue;
        f.status = 'open';
        f.disposition = null;
        f.ruling = r.text;
        reopened = true;
        // a direction the ruling took is the author's to answer now (4.1 §6.3, WI-33)
        if (f.scope === 'shifts-direction') f.scope = 'in-scope';
      }
      // only the ruling of the drift's own escalation clears it (code review r2 #1)
      if (r.drift === true) s.drift = null;
      // the author answers the redirected findings next (unless a seat task is running: then after it)
      if (s.turn === 'await-ruling' || (reopened && s.turn === 'attacker' && pendingTasks(s).length === 0)) s.turn = 'author';
      break;
    }
    case 'keep-direction':
      for (const id of r.findings) {
        const f = s.findings.get(id);
        if (f === undefined || f.status !== 'awaiting-ruling') continue;
        f.status = 'resolved';
        f.ruling = r.text;
      }
      // only the ruling of the drift's own escalation clears it (code review r2 #1)
      if (r.drift === true) s.drift = null;
      afterRuling(s);
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
    case 'answer': {
      // an answer to an author's direction questions clears them (only the ruling does, r1 #2)
      const i = r.answers === undefined ? -1 : s.pendingQuestions.findIndex((q) => q.task === r.answers);
      if (i >= 0) s.pendingQuestions.splice(i, 1);
      afterRuling(s);
      break;
    }
  }
}

/**
 * The record an evidence id stands for now (code review r2 #5): through the reruns after an
 * environment change to its latest replacement (an id still being run again stays itself).
 */
export function currentEvidence(s: XState, id: string): string {
  let cur = id;
  const seen = new Set<string>();
  for (;;) {
    seen.add(cur);
    const rep = s.reruns.get(cur);
    if (rep === undefined || rep === null || seen.has(rep)) return cur;
    cur = rep;
  }
}

/** A registered attempt's latest record (code review r2 #5), through the reruns; null before it ran. */
export function attemptEvidence(s: XState, attempt: string): string | null {
  const last = [...s.evidence.values()].filter((e) => e.attempt === attempt).sort((a, b) => a.k - b.k).at(-1);
  return last === undefined ? null : currentEvidence(s, last.id);
}

/**
 * The settle where the current conclusion was first recorded: walking back from the current settle
 * while the one before it has the same outcome and product (a re-check that confirmed it after a
 * reopening). The decision layer routes a conclusion once (keyed by this settle), so a confirming
 * re-settle is not routed again and a changed one is. Null while nothing is current.
 */
export function settleSince(s: XState): SettleRecord | null {
  const cur = s.settled;
  if (cur === null) return null;
  let since = cur;
  for (let i = cur.n - 2; i >= 0; i--) {
    const prev = s.settles[i];
    if (prev === undefined || prev.body.outcome !== cur.body.outcome || prev.body.artifact !== cur.body.artifact) break;
    since = prev;
  }
  return since;
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
  | { readonly kind: 'stabilizer' }
  | { readonly kind: 'evidence'; readonly requester: string; readonly overCap: boolean }
  | { readonly kind: 'resume'; readonly requester: string }
  | { readonly kind: 'attempts'; readonly attempts: readonly RegisteredAttemptT[] }
  | { readonly kind: 'rerun-evidence'; readonly evidence: string };

export function allowedRounds(s: XState): number {
  return (s.def?.budget.rounds ?? 0) + s.extraRounds + s.rerunRounds;
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
  // an author, attacker or interpreter task given up (WI-28) stops the
  // exploration until the decision layer rules "retry" (an evidence run given up gets its failed
  // record from the program instead, and the requester goes on)
  if (s.abandoned !== null) return { kind: 'stop', reason: 'seat-abandoned', wi: 'WI-28' };
  // research attempts run side by side (blind, separate units)
  if (s.phase === 'attempts' && s.method !== null) {
    const queued = new Set([...s.tasks.values()].flatMap((q) => (q.evidence?.attempt != null && q.evidence.requester === null ? [q.evidence.attempt] : [])));
    const missing = s.method.attempts.filter((a) => !queued.has(a.id));
    if (missing.length > 0) return { kind: 'attempts', attempts: missing };
    return { kind: 'none', why: 'registered attempts running' };
  }
  if (pendingTasks(s).length > 0) return { kind: 'none', why: 'a seat task is running' };
  // evidence executions to run again after an environment change (code review r1 #3), one at a time
  for (const [old, rep] of s.reruns) {
    if (rep !== null) continue;
    if (![...s.tasks.values()].some((q) => q.evidence?.rerunOf === old)) return { kind: 'rerun-evidence', evidence: old };
  }
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
    case 'stabilizer':
      // the round the author answered is judged even when it was the budget's last (4.1 §6.3)
      return { kind: 'stabilizer' };
    case 'author':
      // after the last round the author still answers it, so the Stabilizer can judge it; then the budget stops it
      if (s.rounds >= allowedRounds(s) && s.stabilizing === null) return { kind: 'stop', reason: 'budget-exhausted', wi: 'WI-08' };
      return s.phase === 'reasoning' ? { kind: 'interpreter' } : { kind: 'author' };
    case 'attacker':
      if (s.rounds >= allowedRounds(s)) return { kind: 'stop', reason: 'budget-exhausted', wi: 'WI-08' };
      return { kind: 'attacker', mode: s.discussPending ? 'discuss' : 'attack', fresh: s.needClosing };
    case 'await-ruling':
      return { kind: 'none', why: directionPending(s) ? 'awaiting ruling: a direction question waits for the Secretary (WI-33)' : 'waiting for the decision layer to rule on escalated findings' };
    case 'none':
      return { kind: 'none', why: 'nothing to do' };
  }
}
