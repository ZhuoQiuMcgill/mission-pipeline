// The program actions the flows inject into the scheduler adapter (src/flow/adapters.ts
// ProgramActions): project snapshots (7.1), product versions from Constructor exports (4.2,
// 7.1, 6.5), verification runs as execution units (4.1, 7.2), and the history exported into the
// Architect's card (3.4).

import type { MissionId } from '../../common/ids.ts';
import { repoArgs } from '../../git/objects.ts';
import type { Scheduler } from '../../scheduler/scheduler.ts';
import { evaluatorAdapter, ledgerAdapter, schedulerAdapter, type EvaluatorCaller, type ProgramActions } from '../adapters.ts';
import type { FlowPorts } from '../ports.ts';
import type { ActionContext } from './context.ts';
import { makeProduct } from './product.ts';
import { makeSnapshot } from './snapshot.ts';
import { runVerification, type VerifyOptions, type VerifyUnits } from './verify.ts';

export { ActionError, DEFAULT_EXCLUDE, type ActionContext, type ExportStore } from './context.ts';
export { applyExport, productObjectId } from './product.ts';
export { prepareWritable } from './snapshot.ts';
export { VERIFY_HOST_MAIN, environmentSnapshot, verificationTask, type VerifyOptions, type VerifyUnits } from './verify.ts';

export function programActions(ctx: ActionContext, verify: VerifyOptions): ProgramActions {
  return {
    snapshot: (req) => makeSnapshot(ctx, req),
    product: (req) => makeProduct(ctx, req),
    verify: (req) => runVerification(ctx, verify, req),
    history: (mission) => gitHistory(ctx, mission),
  };
}

/** 3.4: the git history the Architect gets on its card (the last 50 commits of the mission's base); run durations are not exported yet. */
async function gitHistory(ctx: ActionContext, mission: MissionId): Promise<{ gitLog: string; runs: [] }> {
  const base = await ctx.base(mission);
  const r = await ctx.git.run([...repoArgs(ctx.repo), 'log', '--no-decorate', '--format=%h %ad %s', '--date=short', '-n', '50', base, '--'], { cwd: ctx.repo.commonDir });
  return { gitLog: r.code === 0 ? r.stdout.toString('utf8').trim() : '', runs: [] };
}

/** Verification units through the in-process scheduler (its queue is in the ledger, 4.1). */
export function schedulerVerifyUnits(s: Scheduler): VerifyUnits {
  return {
    async submit(spec) {
      if (s.tasks.get(spec.task) === undefined) await s.submitDurable(spec);
    },
    async status(task) {
      const t = s.tasks.get(task);
      return t === undefined ? null : { state: t.state, launches: [...t.launches] };
    },
  };
}

/**
 * The flows' three ports over an in-process scheduler with the real program actions: the ledger
 * adapter (whose content store also holds the seat exports), the scheduler adapter with these
 * actions, verification units queued on the same scheduler, and the evaluator's query socket.
 */
export function schedulerFlowPorts(
  s: Scheduler,
  ctx: Omit<ActionContext, 'ledger' | 'exports'>,
  verify: Omit<VerifyOptions, 'units'>,
  evaluator: EvaluatorCaller,
): FlowPorts {
  const ledger = ledgerAdapter({ ledger: s.ledger, content: s.content, alerts: s.alerts, gen: () => s.generation });
  const actions = programActions({ ...ctx, ledger, exports: s.content }, { ...verify, units: schedulerVerifyUnits(s), ledgerSocket: verify.ledgerSocket ?? s.opts.ledgerSocket });
  return { ledger, scheduler: schedulerAdapter(s, actions), evaluator: evaluatorAdapter(evaluator) };
}
