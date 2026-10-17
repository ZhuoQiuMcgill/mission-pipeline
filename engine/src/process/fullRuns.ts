// STUB (4.1.2 P4): P1 owns this module (COMMON "src/process/fullRuns.ts"). P4 needs only the
// resolver's signature to show the full-run status at delivery, at finish and in the closing
// snapshot; until P1's module replaces this file, no full run is ever recorded, so every status is
// "never run". The marker fields P4 reads: `commit`, `tree`, `endedAt` (ms) and `passed`.

import type { ProcessContext } from './context.ts';

/** A full run of the project's `fullSuite` on a clean checkout of one commit (COMMON "Full run"). */
export interface FullRunMarker {
  readonly mission: string;
  readonly commit: string;
  readonly tree: string;
  readonly environment: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly commands: ReadonlyArray<{ readonly id: string; readonly exitCode: number | null }>;
  readonly passed: boolean;
  readonly failing: ReadonlyArray<{ readonly id: string; readonly tail: string }>;
  readonly cites: { readonly words?: string; readonly authorization?: string; readonly reason?: string } | null;
}

export interface FullRunStatus {
  readonly last: FullRunMarker | null;
  readonly sameTree: boolean;
  readonly changedSince: { readonly products: string[]; readonly paths: string[] } | null;
}

/** The last full-run marker of `mission` and how `tree` relates to it (P1's resolver; stubbed). */
export function fullRunStatus(_ctx: ProcessContext, _mission: string, _tree: string): FullRunStatus {
  return { last: null, sameTree: false, changedSince: null };
}
