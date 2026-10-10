// The continuation check before an acceptance (design 5.2 part 5, core review r3 F1).
//
// A Reviewer seat may hand back a continuation judgment (`extends` = J0): it reviewed only
// the changes since J0. The ledger commits it only after the evaluator's check passed for it
// at the latest published revision. So before the scheduler accepts a launch whose pending
// results carry one, it asks the evaluator (`continuation`, answered at one published
// revision, with the merged inputs) and records the answer (`recordContinuationCheck`):
//
//   - BELOW_FLOOR: a newer revision was published meanwhile: ask again (bounded);
//   - a failed check is recorded too; the acceptance is then refused (CONTINUATION_REFUSED),
//     a normal branch: the work goes to a full review instead (not an exception, no WI);
//   - while the evaluator cannot answer: not configured: the ledger refuses the continuation,
//     same branch; in its fault state (or blocked): the acceptance ends with "the derived state
//     cannot be computed" (WI-11) and is registered again after the next publication, as a new
//     attempt linked to the ended one; a passing moment (not ready, unreachable): asked again.

import type { Generation, JudgmentId, LaunchId, Revision } from '../common/ids.ts';
import type { BaseRecord, JudgmentInputs, JudgmentRecord, ListRef } from '../common/records.ts';
import type { ContinuationRequest } from '../evaluator/semantics.ts';
import type { ContentStore } from '../ledger/content.ts';
import { errorCode, type SchedulerLedger } from './ledger.ts';

/** What the acceptance does next. */
export type AcceptGate =
  | { readonly kind: 'go' }
  /** The evaluator cannot answer this moment (not ready, unreachable): asked again next pass. */
  | { readonly kind: 'wait'; readonly why: string }
  /**
   * WI-11: the evaluator is in its fault state (or blocked): the acceptance ends with "the
   * derived state cannot be computed", no waiting; it is registered again, as a new attempt
   * naming the one it retries, after the next successful publication (r1 #9).
   */
  | { readonly kind: 'ended'; readonly why: string }
  /** The evaluator refused a continuation: a full review instead (5.2 part 5). */
  | { readonly kind: 'full-review'; readonly judgment: JudgmentId; readonly reason: string };

export interface ContinuationQuery {
  call(method: string, params?: unknown): Promise<unknown>;
}

export interface ContinuationDeps {
  readonly ledger: SchedulerLedger;
  readonly content: ContentStore;
  readonly gen: () => Generation;
  /** The evaluator's query socket, or null when no evaluator runs here. */
  readonly query: () => ContinuationQuery | null;
  /** Why the evaluator cannot answer (its fault or blocked state), or null. */
  readonly evaluatorDown: () => string | null;
  /** The basis lines changed in this batch, as the task's author planned the continuation. */
  readonly changedLines: (launch: LaunchId, judgment: JudgmentRecord) => readonly string[] | Promise<readonly string[]>;
  /** How many times to ask again after BELOW_FLOOR (default 5). */
  readonly maxAsks?: number;
}

type ContinuationAnswer = {
  readonly revision: Revision;
  readonly result: { readonly ok: true; readonly merged: JudgmentInputs } | { readonly ok: false; readonly reason: string };
};

export function continuationJudgments(records: readonly BaseRecord[]): JudgmentRecord[] {
  return records.filter((r): r is JudgmentRecord => r.kind === 'judgment' && r.extends !== null);
}

function list(content: ContentStore, ref: ListRef): string[] {
  return content.getList(ref);
}

/** The evaluator's request for one continuation judgment, from the judgment as handed back. */
export function continuationRequest(content: ContentStore, j: JudgmentRecord, changedLines: readonly string[]): ContinuationRequest {
  return {
    extends: j.extends as JudgmentId,
    target: j.target,
    review: j.review,
    changedLines: changedLines as ContinuationRequest['changedLines'],
    draft: { evidence: list(content, j.evidence), bases: list(content, j.bases), constraints: list(content, j.constraints), reliesOn: list(content, j.reliesOn) },
    superseded: j.superseded,
  };
}

/**
 * Record the evaluator's check of every continuation judgment among a launch's pending
 * results, at the latest published revision. 'go' when there is none, or every check is
 * recorded (passing ones and failing ones: a failing one makes it 'full-review').
 */
export async function checkContinuations(d: ContinuationDeps, launch: LaunchId, records: readonly BaseRecord[]): Promise<AcceptGate> {
  const judgments = continuationJudgments(records);
  if (judgments.length === 0) return { kind: 'go' };
  // no evaluator here: the ledger refuses the continuation (CONTINUATION_REFUSED): a full review
  const q = d.query();
  if (q === null) return { kind: 'go' };
  const down = d.evaluatorDown();
  if (down !== null) return { kind: 'ended', why: `the derived state cannot be computed: ${down}` };
  for (const j of judgments) {
    const req = continuationRequest(d.content, j, await d.changedLines(launch, j));
    let recorded = false;
    for (let ask = 0; ask < (d.maxAsks ?? 5) && !recorded; ask++) {
      let a: ContinuationAnswer;
      try {
        a = (await q.call('continuation', req)) as ContinuationAnswer;
      } catch (e) {
        return { kind: 'wait', why: `the evaluator could not answer the continuation check of ${j.judgment} (${(e as Error).message})` };
      }
      try {
        await d.ledger.recordContinuationCheck({
          op: `continuation-check:${launch}:${j.judgment}:${a.revision}`,
          gen: d.gen(),
          judgment: j.judgment,
          extends: j.extends as JudgmentId,
          target: j.target,
          revision: a.revision,
          result: a.result.ok ? { ok: true, merged: a.result.merged } : { ok: false, reason: a.result.reason },
        });
        recorded = true;
      } catch (e) {
        const code = errorCode(e);
        if (code === 'BELOW_FLOOR') continue; // a newer revision was published: ask again
        if (code === 'FACT_CONFLICT' && /already committed/.test((e as Error).message)) {
          recorded = true; // the judgment is a base record already (an earlier acceptance)
          break;
        }
        throw e;
      }
      if (!a.result.ok) return { kind: 'full-review', judgment: j.judgment, reason: a.result.reason };
    }
    if (!recorded) return { kind: 'wait', why: `the published revision kept moving while checking ${j.judgment}; asked again next pass` };
  }
  return { kind: 'go' };
}
