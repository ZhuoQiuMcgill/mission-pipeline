// `mp pm finish <mission> --words W-<n>` (4.1.2, D-9): the user's one sentence "close and merge".
// One words entry carries the three steps the PM used to come back for one by one:
//
//   1. deliver: every accepted output of the plan in effect (or the outputs given), with their
//      honest labels; no command runs (D-7), the full-run status of the tree is shown;
//   2. land: the delivery fast-forwards the target branch (§6.7). A landing that cannot complete
//      stops here: the delivery stays, the mission stays open, the WI is named as `land` names it,
//      and the same words serve `mp pm land` and `mp pm close` once the WI is resolved. A moved
//      base gets the WI-05 default first (rebuilt on the new base, counted), as `land` does;
//   3. close: the honest snapshot (D-11), never refused on the state of the work.
//
// A mission with no accepted product (an exploration's conclusions, a plan with nothing accepted)
// has nothing to deliver or land: it is closed, and the snapshot says what it holds.
// The hard floor stays: nothing lands without the user's words (`--words` is required).

import { sha256 } from '../common/hash.ts';
import type { MissionId, ObjectVersionId } from '../common/ids.ts';
import { deliveryDocument, type DeliveryResult } from '../delivery/delivery.ts';
import type { DeliveryTarget } from '../delivery/proofView.ts';
import type { LandingResult } from '../git/land.ts';
import { acceptedStartOf } from '../flow/execution.ts';
import { flowCtx } from '../flow/context.ts';
import { planInEffect } from '../flow/planning.ts';
import { currentDelivery, deliveryInfo } from '../memory/index.ts';
import { pmClose, type Closed } from './close.ts';
import type { ProcessContext } from './context.ts';
import { pmDeliver, pmLand, pmRebuild } from './pm.ts';

/**
 * The accepted outputs of the mission's plan in effect, with the tasks its repairs added: each
 * task's accepted product, through the flow's own resolvers (planInEffect, acceptedStartOf). A
 * product with a start risk is included: the delivery labels it honestly. `mp pm finish` delivers
 * these by default, and `mp pm full-run` runs the suite on their candidate.
 */
export async function acceptedOutputs(ctx: ProcessContext, mission: string): Promise<DeliveryTarget[]> {
  const fc = flowCtx(ctx.ports(), mission as MissionId);
  const inEffect = await planInEffect(fc);
  if (inEffect === null) return [];
  const out: DeliveryTarget[] = [];
  for (const { id: task } of inEffect.plan.tasks) {
    const start = await acceptedStartOf(fc, task);
    if (start !== null) out.push({ kind: 'object', id: start.product as ObjectVersionId });
  }
  return out;
}

/** An output as a delivery id is derived from it: `unit:<id>`, or the object version's id (with or without `object:`). */
export function targetKey(t: DeliveryTarget): string {
  return t.kind === 'unit' ? `unit:${t.id}` : t.id;
}

/** A delivery's id derived from its request, so a retry finishes the same delivery (`mp pm deliver` and `finish` alike). */
export function deliveryIdFor(mission: string, outputs: readonly DeliveryTarget[], words: string, message: string | null = null): string {
  return `d-${sha256(`${mission}\n${outputs.map(targetKey).sort().join(',')}\n${words}${message !== null ? `\n${message}` : ''}`).slice(0, 12)}`;
}

export interface Finished {
  readonly mission: string;
  readonly words: string;
  readonly outputs: readonly DeliveryTarget[];
  /** null: nothing to deliver (no accepted output in the plan in effect). */
  readonly delivery: { readonly id: string; readonly result: DeliveryResult } | null;
  /** The delivery the landing was for: the delivery made, or its rebuild when an earlier finish rebuilt it (WI-05). */
  readonly landed: string | null;
  readonly landing: LandingResult | null;
  /** WI-05 default when the landing found the base moved: the rebuilt delivery (to land with the same words). */
  readonly rebuild: DeliveryResult | null;
  readonly close: Closed | null;
  /** Where it stopped (the mission stays open), or null when it closed. */
  readonly stoppedAt: 'deliver' | 'land' | null;
}

/** The mission's current delivery when it is a later rebuild of `delivery` (the same rebuild chain), else null. */
function rebuiltOf(ctx: ProcessContext, mission: string, delivery: string): string | null {
  return ctx.memory.read((db) => {
    const mine = deliveryInfo(db, mission as MissionId, delivery);
    const cur = currentDelivery(db, mission as MissionId);
    if (mine === null || cur === null || cur.delivery === delivery || cur.state !== 'recorded' || cur.seq < mine.seq) return null;
    const a = deliveryDocument(ctx.memory.data, mine);
    const b = deliveryDocument(ctx.memory.data, cur);
    return a !== null && b !== null && a.root === b.root ? cur.delivery : null;
  });
}

/** `mp pm finish`: deliver, land and close on one words entry; it stops after the delivery when landing cannot complete. */
export async function pmFinish(
  ctx: ProcessContext,
  req: { readonly mission: string; readonly words: string; readonly outputs?: readonly DeliveryTarget[] | null; readonly message?: string | null; readonly request?: string | null; readonly allowExternal?: string | null },
): Promise<Finished> {
  const outputs = req.outputs !== undefined && req.outputs !== null && req.outputs.length > 0 ? [...req.outputs] : await acceptedOutputs(ctx, req.mission);
  const base = { mission: req.mission, words: req.words, outputs };
  const close = async (): Promise<Closed> => pmClose(ctx, req.mission, { mode: 'with-risk', words: req.words, request: req.request !== undefined && req.request !== null ? `${req.request}:close` : null });
  if (outputs.length === 0) return { ...base, delivery: null, landed: null, landing: null, rebuild: null, close: await close(), stoppedAt: null };
  const id = deliveryIdFor(req.mission, outputs, req.words, req.message ?? null);
  const result = await pmDeliver(ctx, { mission: req.mission, delivery: id, selected: outputs, words: req.words, ...(req.message !== undefined ? { message: req.message } : {}) });
  const delivery = { id, result };
  if (result.kind !== 'delivered') return { ...base, delivery, landed: null, landing: null, rebuild: null, close: null, stoppedAt: 'deliver' };
  // a finish run again after a moved base (WI-05) lands the rebuilt delivery, never rebuilds once more
  const target = rebuiltOf(ctx, req.mission, result.record.delivery) ?? result.record.delivery;
  const landing = await pmLand(ctx, { mission: req.mission, delivery: target, words: req.words, ...(req.allowExternal !== undefined ? { allowExternal: req.allowExternal } : {}) });
  if (landing.kind !== 'landed') {
    const rebuild = landing.kind === 'base-moved' ? await pmRebuild(ctx, { mission: req.mission, delivery: target }) : null;
    return { ...base, delivery, landed: target, landing, rebuild, close: null, stoppedAt: 'land' };
  }
  return { ...base, delivery, landed: target, landing, rebuild: null, close: await close(), stoppedAt: null };
}
