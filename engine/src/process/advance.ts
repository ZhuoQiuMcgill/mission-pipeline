// Advancing the process (design 4.1 §5.1 step 4): one reconciliation of the flows on the memory,
// run inside the `mp` command that changed something (a hand-back, a PM command) and by
// `mp pm next`. Nothing runs between commands: the process advances only while some PM session
// runs `mp` (§5.1 step 5, accepted cost).

import type { MissionId } from '../common/ids.ts';
import { createFlowEngine } from '../flow/compose.ts';
import type { ReconcileReport } from '../flow/engine.ts';
import type { ProcessContext } from './context.ts';

/**
 * Reconcile one mission, or every mission with flow events. `by`: what is handing work over in
 * this advance (a hand-back, a PM command), recorded on each task it queues (§3.2, U-13).
 * `seatSide`: the pass runs in a seat's process (a hand-back): a permission error of the seat's
 * environment is left to the PM's next step, without a notice (4.1.2).
 */
export async function advance(ctx: ProcessContext, mission?: MissionId, by?: { readonly dispatch: string | null; readonly task: string | null; readonly step: string }, o: { readonly seatSide?: boolean } = {}): Promise<ReconcileReport[]> {
  const prev = ctx.handover;
  ctx.handover = by ?? prev ?? { dispatch: null, task: null, step: 'the process advanced (mp pm next)' };
  try {
    return await createFlowEngine(ctx.ports(), o.seatSide === true ? { seatSide: true } : {}).reconcile(mission);
  } finally {
    ctx.handover = prev;
  }
}
