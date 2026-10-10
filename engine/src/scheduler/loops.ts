// Automatic loops and their caps (design 6.5; WI-08). Every retry and every return is a
// `loop.attempt` record with a failure signature, counted per work lineage in the ledger, so
// re-dispatch, a new task id or a replacement task never resets a count, and a restart never
// loses one. The caps, the per-class env-retry cap and the loops exempt from no-progress
// detection are one table in src/common/records.ts; the ledger computes the verdict
// (`loopState`: exhausted, why, cap, allowed, the attempt count at the last grant, whether
// the Secretary has used its one grant on the lineage) and enforces the Secretary's single
// grant per lineage across all its loops (GRANT_LIMIT) in the same transaction as the grant.
//
// Exhaustion stops only that lineage (WI-08); the rest of the mission goes on. After the
// Secretary's grant only the user can grant more, and the scheduler asks through a WI-08 notice.

import { canonicalJson } from '../common/hash.ts';
import type { Generation } from '../common/ids.ts';
import { ENV_RETRY_PER_CLASS, LOOP_CAPS, LOOP_KINDS, NO_PROGRESS_EXEMPT, type LoopAttemptRecord, type LoopGrantRecord, type LoopKind } from '../common/records.ts';
import type { ContentStore } from '../ledger/content.ts';
import type { Alerts } from './alerts.ts';
import { errorCode, type LoopState, type SchedulerLedger } from './ledger.ts';

export { ENV_RETRY_PER_CLASS, LOOP_CAPS, LOOP_KINDS, NO_PROGRESS_EXEMPT };

export type ExhaustionReason = 'cap' | 'class-cap' | 'no-progress';

export interface LoopVerdict {
  readonly lineage: string;
  readonly loop: LoopKind;
  readonly exhausted: boolean;
  readonly reason: ExhaustionReason | null;
  readonly attempts: number;
  /** Attempts allowed in total, grants included. */
  readonly allowed: number;
  readonly state: LoopState;
}

export interface GrantReason {
  readonly format: 'mp4.loop-grant-reason.v2';
  readonly reason: string;
  readonly by: 'secretary' | 'user';
}

export type GrantOutcome =
  | { readonly granted: true; readonly extra: number }
  | { readonly granted: false; readonly why: 'secretary-already-granted' | 'too-many' };

function verdictOf(lineage: string, loop: LoopKind, s: LoopState): LoopVerdict {
  return { lineage, loop, exhausted: s.exhausted, reason: s.reason, attempts: s.attempts, allowed: s.allowed, state: s };
}

export class LoopGuard {
  private readonly ledger: SchedulerLedger;
  private readonly content: ContentStore;
  private readonly alerts: Alerts;

  constructor(o: { ledger: SchedulerLedger; content: ContentStore; alerts: Alerts }) {
    this.ledger = o.ledger;
    this.content = o.content;
    this.alerts = o.alerts;
  }

  /** Whether the loop may run again for this lineage (the ledger's verdict). `failureClass`: env-retry's class of the next attempt. */
  async verdict(lineage: string, loop: LoopKind, failureClass: string | null = null): Promise<LoopVerdict> {
    return verdictOf(lineage, loop, await this.ledger.loopState(lineage, loop, failureClass));
  }

  /**
   * Record one attempt (a retry or a return) and say whether the loop may go on.
   * `op` must identify the attempt (e.g. the failed launch), so a retried request after a
   * lost response does not count twice.
   */
  async attempt(req: { op: string; gen: Generation | null; lineage: string; loop: LoopKind; failureClass: string | null; signature: string }): Promise<LoopVerdict> {
    const rec: LoopAttemptRecord = { kind: 'loop.attempt', lineage: req.lineage, loop: req.loop, failureClass: req.failureClass, signature: req.signature };
    try {
      await this.ledger.appendRecords(req.op, req.gen, [rec]);
    } catch (e) {
      // the op names the attempt (a launch): an earlier generation already recorded it, with the
      // signature it saw then (a restarted scheduler rebuilds the signature from the disposition)
      if (errorCode(e) !== 'OP_CONFLICT') throw e;
    }
    return this.verdict(req.lineage, req.loop, req.failureClass);
  }

  /** Whether the Secretary already used its one grant on this lineage (any loop). */
  async secretaryGranted(lineage: string): Promise<boolean> {
    return (await this.ledger.loopState(lineage, 'env-retry')).secretaryGrantUsed;
  }

  /**
   * Extra attempts for an exhausted loop. The Secretary: once per lineage across all its
   * loops (the ledger refuses a second one: GRANT_LIMIT), at most 2, with a reason; the
   * refusal sends a WI-08 notice so the user can decide. The user: any number.
   */
  async grant(req: { op: string; gen: Generation | null; lineage: string; loop: LoopKind; by: 'secretary' | 'user'; extra: number; reason: string }): Promise<GrantOutcome> {
    if (req.by === 'secretary' && (req.extra > 2 || req.extra < 1)) return { granted: false, why: 'too-many' };
    const doc: GrantReason = { format: 'mp4.loop-grant-reason.v2', reason: req.reason, by: req.by };
    const reason = this.content.put(canonicalJson(doc));
    const rec: LoopGrantRecord = { kind: 'loop.grant', lineage: req.lineage, loop: req.loop, by: req.by, extra: req.extra, reason };
    try {
      await this.ledger.appendRecords(req.op, req.gen, [rec]);
    } catch (e) {
      if (errorCode(e) !== 'GRANT_LIMIT') throw e;
      await this.alerts.raise({
        category: 'loop-exhausted-needs-user',
        wi: 'WI-08',
        key: `${req.lineage}:${req.loop}`,
        trigger: `the Secretary asked for more attempts on ${req.lineage} (${req.loop}) after using its one grant for this lineage`,
        defaultAction: 'refused; the lineage stays exhausted; the rest of the mission continues; only the user can grant more (6.5)',
        detail: { lineage: req.lineage, loop: req.loop, request: req.reason, ledger: (e as Error).message },
      });
      return { granted: false, why: 'secretary-already-granted' };
    }
    return { granted: true, extra: req.extra };
  }

  /**
   * WI-08: an exhausted loop stops only its lineage; the PM is told. Once the Secretary has
   * used its grant on the lineage, the notice asks for the user's decision.
   */
  async escalate(v: LoopVerdict, context: unknown): Promise<void> {
    const granted = v.state.secretaryGrantUsed;
    await this.alerts.raise({
      category: granted ? 'loop-exhausted-needs-user' : 'loop-exhausted',
      wi: 'WI-08',
      key: `${v.lineage}:${v.loop}:${v.attempts}`,
      trigger: `${v.loop} on lineage ${v.lineage}: ${v.reason === 'no-progress' ? 'the same failure signature twice in a row (no progress)' : `${v.attempts} of ${v.allowed} attempts used`}`,
      defaultAction: `only lineage ${v.lineage} stops at "exhausted"; the rest of the mission continues`,
      detail: { lineage: v.lineage, loop: v.loop, reason: v.reason, attempts: v.attempts, allowed: v.allowed, secretaryGranted: granted, askUser: granted, context },
    });
  }
}
