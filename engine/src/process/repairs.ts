// STUB (4.1.2 P4): P3 owns the repairs (`mp pm repair`) and exports the resolver `repairsOf(ctx,
// mission)` that the closing snapshot lists. Until P3's module replaces this one, no repair exists
// and the snapshot lists none. The fields P4 reads: `repair`, `kind`, `text`, `words`, `about`.

import type { ProcessContext } from './context.ts';

/** One repair item of a mission (D-10): its kind (the PM's label) and the user's words as the reason. */
export interface RepairEntry {
  readonly repair: string;
  readonly kind: string;
  readonly text: string;
  readonly words: string | null;
  readonly about: string | null;
}

/** The repairs made in `mission`, oldest first (P3's resolver; stubbed). */
export function repairsOf(_ctx: ProcessContext, _mission: string): readonly RepairEntry[] {
  return [];
}
