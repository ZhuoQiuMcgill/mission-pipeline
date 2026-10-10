// The legalization flow inside the flow engine (src/flow/engine.ts): every legalization the user
// asked for in the mission (line "audit:<id>", event "requested") takes the steps it can on each
// reconciliation pass. Requesting and starting stay explicit calls (the PM's, for the user, 11.1).

import type { FlowCtx } from '../context.ts';
import { registerFlowStep } from '../engine.ts';
import { advanceLegalization } from './flow.ts';

export async function legalizationStep(ctx: FlowCtx): Promise<void> {
  for (const e of await ctx.ports.ledger.events({ mission: ctx.mission, event: 'requested' })) {
    if (!e.line.startsWith('audit:')) continue;
    const r = await advanceLegalization(ctx.ports, ctx.mission, e.line.slice('audit:'.length));
    if (r.steps > 0) ctx.progressed = true;
  }
}

export function registerLegalizationStep(): void {
  registerFlowStep('legalization', legalizationStep);
}
