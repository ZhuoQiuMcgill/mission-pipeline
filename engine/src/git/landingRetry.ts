// What happens after a landing attempt that did not land (design 6.6 "落地的结果",
// 3.11 WI-01, WI-02, WI-05, WI-06, WI-08, WI-19; 6.5 "落地尝试"), v42-v47:
// - class A (ended before the push stage, nothing written): a NEW attempt when
//   the condition changes (worktrees, target branch, occupancy, disk; checked on
//   every change and at least every 10 minutes), at most once every 10 minutes
//   per delivery, with no count cap: waiting is not a loop;
// - class B (safe to retry): a NEW attempt (re-authorized, new view, new
//   admission; never a replay) after the worktree or the target branch changes;
// - base moved: a rebuild on the new base (WI-05), never the same commit again;
// - class C caused only by a leftover lock: a new attempt once the lock is gone
//   (the program never deletes it; WI-06 option 5);
// - landed, any other C, and refusals waiting cannot fix (a stop, a platform
//   without a controlled view, an attribute-only or submodule change, a
//   program-namespace mismatch, ...): no automatic attempt.
// The count of attempts that ENTER THE PUSH STAGE (the first + 3 per delivery,
// whoever starts them, 6.5) is kept by the ledger, which refuses the next one
// once it is used up (LOOP_EXHAUSTED -> the landing's 'attempts-exhausted'
// refusal, WI-08): this loop stops there. Only this one delivery waits; nothing
// else is blocked. The caller's `attempt` builds every attempt from scratch (its
// own journal identity in the ledger).

import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { LandingReport, NotAutoLandedReason } from './landing.ts';

export const LANDING_RECHECK_INTERVAL_MS = 10 * 60_000;
export const LANDING_MIN_ATTEMPT_INTERVAL_MS = 10 * 60_000;

/** Class A refusals whose cause can go away by itself: wait for a change, then a new attempt. */
const WAIT: ReadonlySet<NotAutoLandedReason> = new Set<NotAutoLandedReason>([
  'target-in-several-worktrees',
  'target-busy',
  'target-in-external-worktree',
  'occupancy-changed',
  'worktrees-changed',
  'worktree-identity-changed',
  'worktree-root-missing',
  'worktree-unreadable',
  'sparse-checkout',
  'insufficient-space',
  'lfs-object-missing',
  'transform-description-changed',
  'interrupted-before-push',
]);

export type LandingNextStep =
  | { readonly step: 'landed' }
  /** Class A: wait for the condition to change, then a new attempt (no cap). */
  | { readonly step: 'wait'; readonly reason: NotAutoLandedReason }
  /** Class B: a new attempt after a change (the ledger counts it when it enters the push stage). */
  | { readonly step: 'reattempt' }
  /** C caused only by leftover locks: a new attempt once every one of them is gone. */
  | { readonly step: 'wait-lock'; readonly locks: readonly string[] }
  /** WI-05: rebuild the delivery on the new base (every rebuild counts); the landing loop ends here. */
  | { readonly step: 'rebuild' }
  /** WI-08: the landing attempts of this delivery are used up. */
  | { readonly step: 'exhausted' }
  /** No automatic attempt: class C, or a refusal waiting cannot fix; the PM chooses. */
  | { readonly step: 'stop'; readonly why: string };

/** What a landing's outcome leads to (v42-v47). */
export function nextLandingStep(r: LandingReport): LandingNextStep {
  if (r.kind === 'push-unconfirmed') return { step: 'stop', why: 'the push may still be running: recovery verifies it (class C)' };
  if (r.kind === 'not-auto-landed') {
    if (r.reason === 'base-moved') return { step: 'rebuild' };
    if (r.reason === 'attempts-exhausted') return { step: 'exhausted' };
    if (WAIT.has(r.reason)) return { step: 'wait', reason: r.reason };
    return { step: 'stop', why: `${r.reason} (${r.wi}): waiting does not change it` };
  }
  if (r.outcome === 'landed') return { step: 'landed' };
  if (r.outcome === 'B') return { step: 'reattempt' };
  if (r.outcome === 'base-moved') return { step: 'rebuild' };
  if (r.next === 'after-lock') return { step: 'wait-lock', locks: r.locks };
  return { step: 'stop', why: `class C: never redone automatically (${r.why})` };
}

export type ChangeCause = 'changed' | 'interval' | 'aborted';

/**
 * Resolves on the first change under the repository's refs, HEAD files,
 * in-progress operation files, index files or worktree registrations, after
 * `intervalMs` at the latest, or when `signal` aborts.
 */
export function waitForLandingChange(commonDir: string, opts: { readonly intervalMs?: number; readonly signal?: AbortSignal } = {}): Promise<ChangeCause> {
  return new Promise((resolve) => {
    const watchers: FSWatcher[] = [];
    let timer: NodeJS.Timeout | null = null;
    let done = false;
    const finish = (cause: ChangeCause): void => {
      if (done) return;
      done = true;
      for (const w of watchers) w.close();
      if (timer !== null) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(cause);
    };
    const onAbort = (): void => finish('aborted');
    if (opts.signal?.aborted) {
      finish('aborted');
      return;
    }
    opts.signal?.addEventListener('abort', onAbort);
    const add = (dir: string, recursive: boolean): void => {
      if (!existsSync(dir)) return;
      try {
        const w = watch(dir, { recursive, persistent: false }, () => finish('changed'));
        w.on('error', () => {
          /* a vanished directory: the interval still fires */
        });
        watchers.push(w);
      } catch {
        /* not watchable here: the interval still fires */
      }
    };
    add(commonDir, false); // HEAD, index, packed-refs, BISECT_*, rebase-merge/, rebase-apply/, worktrees/ appearing
    add(join(commonDir, 'refs', 'heads'), true);
    add(join(commonDir, 'worktrees'), true); // registrations, their HEAD, index and in-progress files
    timer = setTimeout(() => finish('interval'), opts.intervalMs ?? LANDING_RECHECK_INTERVAL_MS);
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      resolve(false);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
}

export interface LandWhenReadyOptions {
  /** Re-check at least this often, even without a change (default 10 minutes). */
  readonly recheckMs?: number;
  /** At most one attempt per this interval for the delivery (default 10 minutes). */
  readonly minAttemptIntervalMs?: number;
  readonly signal?: AbortSignal;
  /**
   * A cheap re-check after a change (for instance the occupancy, read outside any
   * namespace): a new attempt starts only once it says the condition may hold.
   * Default: every change is worth an attempt (rate-limited).
   */
  readonly conditionHolds?: (last: LandingReport) => boolean | Promise<boolean>;
  /** Called while waiting after a non-final outcome. */
  readonly onWaiting?: (report: LandingReport, attempt: number) => void | Promise<void>;
}

export interface LandWhenReadyResult {
  readonly report: LandingReport;
  readonly attempts: number;
  /** landed; rebuild (WI-05); exhausted (WI-08: the ledger refused another push-stage attempt); stop (class C or a refusal waiting cannot fix); aborted. */
  readonly ended: 'landed' | 'rebuild' | 'exhausted' | 'stop' | 'aborted';
}

function lexists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** Lands as soon as the condition holds, under the rules in the header (v42-v47). */
export async function landWhenReady(commonDir: string, attempt: (n: number) => Promise<LandingReport>, opts: LandWhenReadyOptions = {}): Promise<LandWhenReadyResult> {
  const minGap = opts.minAttemptIntervalMs ?? LANDING_MIN_ATTEMPT_INTERVAL_MS;
  const wait = (): Promise<ChangeCause> => waitForLandingChange(commonDir, { intervalMs: opts.recheckMs ?? LANDING_RECHECK_INTERVAL_MS, ...(opts.signal ? { signal: opts.signal } : {}) });
  for (let n = 1; ; n++) {
    const started = Date.now();
    const report = await attempt(n);
    const step = nextLandingStep(report);
    if (step.step === 'landed') return { report, attempts: n, ended: 'landed' };
    if (step.step === 'rebuild') return { report, attempts: n, ended: 'rebuild' };
    if (step.step === 'exhausted') return { report, attempts: n, ended: 'exhausted' };
    if (step.step === 'stop') return { report, attempts: n, ended: 'stop' };
    await opts.onWaiting?.(report, n);
    if (step.step === 'wait-lock') {
      // WI-06 option 5: the program never deletes a git lock; it waits for its owner to finish or clean it.
      while (step.locks.some((l) => lexists(l))) {
        if ((await wait()) === 'aborted') return { report, attempts: n, ended: 'aborted' };
      }
    } else {
      // A change (or the re-check interval), and the condition may hold again.
      for (;;) {
        if ((await wait()) === 'aborted') return { report, attempts: n, ended: 'aborted' };
        if (opts.conditionHolds === undefined || (await opts.conditionHolds(report))) break;
      }
    }
    // At most one attempt per interval for this delivery (timers may fire a little early: check again).
    for (let gap = started + minGap - Date.now(); gap > 0; gap = started + minGap - Date.now()) {
      if (!(await sleep(gap, opts.signal))) return { report, attempts: n, ended: 'aborted' };
    }
  }
}
