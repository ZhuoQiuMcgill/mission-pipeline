// A seat task of a flow that ended without a usable hand-back (design 6.2 "交回之后的去向", 6.5,
// WI-15, WI-08): the scheduler already raised its WI notice and counted the loop; the flow asks
// the Secretary what to do with this one line of work, and carries out the generic choices
// (restart, grant) itself. Abandon and re-plan go back to the caller, who owns the line.
//
//   needs disposition (seat failure, quarantine)   restart (quarantine-restart loop, cap 2) / abandon / re-plan / ask the user
//   resource overflow                              re-plan (a smaller task) / abandon / ask the user (never restarted as it is)
//   cancelled by a stop                            abandon / ask the user (never restarted while the stop holds)
//   exhausted (environment retries)                grant (the Secretary's one grant) / abandon / re-plan / ask the user
// A restart the scheduler refuses, or a grant the ledger refuses, goes to the user (WI-15 /
// WI-08). Only this line waits; the rest of the mission goes on.

import type { DecisionOption } from '../seat/cards/secretary.ts';
import { safeId, type FlowCtx, type TaskView } from './context.ts';
import { decisionFor, escalateToUser, escalation, isApplied, markApplied, raiseEscalation, type DecisionBody } from './secretary.ts';
import { WI } from './wi.ts';

export type FailureOutcome =
  /** The decision is not there yet (or the user is asked). */
  | { readonly kind: 'waiting' }
  /** The task was dispatched again (restart or grant): continue watching it. */
  | { readonly kind: 'retrying' }
  /** The caller carries out abandon or re-plan, then marks the escalation applied. */
  | { readonly kind: 'decided'; readonly escalation: string; readonly decision: DecisionBody }
  /** The task was given up outside the flow (cancelled): the caller decides what that means. */
  | { readonly kind: 'abandoned' };

export async function handleFailure(
  ctx: FlowCtx,
  f: { readonly task: string; readonly lineage: string; readonly subject: string; readonly view: Extract<TaskView, { kind: 'failed' }>; readonly canAbandon: boolean; readonly canReplan: boolean },
): Promise<FailureOutcome> {
  const s = f.view.status;
  if (f.view.why === 'abandoned') return { kind: 'abandoned' };
  const id = safeId(`fail.${f.task}.${s.launches.length}`);
  if ((await escalation(ctx, id)) === null) {
    const exhausted = f.view.why === 'exhausted';
    const options: DecisionOption[] = [];
    if (exhausted) options.push('grant');
    else if (s.disposition !== 'stop' && s.disposition !== 'resource-exceeded') options.push('restart');
    if (f.canReplan && s.disposition !== 'stop') options.push('replan');
    if (f.canAbandon) options.push('abandon');
    if (options.length === 0) {
      // nothing the program can carry out (a decision-layer seat cancelled by a stop): wait and tell the PM (proposed WI-26)
      await ctx.ports.ledger.notify({
        mission: ctx.mission,
        category: 'flow-step-stopped',
        wi: WI.stepStopped,
        key: id,
        trigger: `task ${f.task} (${f.subject}) ended ${s.disposition ?? f.view.why} (${s.note ?? ''}) and cannot be restarted as it is`,
        defaultAction: `only ${f.subject} waits; the rest of the mission continues`,
        detail: { task: f.task, lineage: f.lineage, status: s },
      });
      return { kind: 'waiting' };
    }
    options.push('ask-user');
    await raiseEscalation(ctx, {
      id,
      source: exhausted ? 'loop-exhausted' : 'needs-disposition',
      lineage: f.lineage,
      subject: f.subject,
      summary: exhausted
        ? `Task ${f.task} used up its environment retries (${s.note ?? ''}).`
        : `Task ${f.task} ended without a usable result: ${s.disposition ?? f.view.why} (${s.note ?? ''}).`,
      reasons: [s.note ?? f.view.why],
      options,
      facts: { task: f.task, state: s.state, disposition: s.disposition, launches: s.launches, loop: exhausted ? 'env-retry' : 'quarantine-restart' },
    });
    if (exhausted) {
      await ctx.ports.ledger.notify({
        mission: ctx.mission,
        category: 'loop-exhausted',
        wi: WI.loopExhausted,
        key: id,
        trigger: `task ${f.task} (lineage ${f.lineage}) exhausted its environment retries: ${s.note ?? ''}`,
        defaultAction: `only ${f.subject} stops at "exhausted"; the Secretary decides (grant once, re-plan, abandon, or ask the user); the rest of the mission continues`,
        detail: { task: f.task, lineage: f.lineage, status: s },
      });
    }
    return { kind: 'waiting' };
  }
  if (await isApplied(ctx, id)) return { kind: 'waiting' };
  const d = await decisionFor(ctx, id);
  if (d === null) return { kind: 'waiting' };
  if (d.option === 'restart') {
    const v = await ctx.ports.scheduler.restart(f.task, `${s.disposition ?? f.view.why}:${s.note ?? ''}`);
    if (v === null) {
      await escalateToUser(ctx, id, `task ${f.task} cannot be restarted as it is (${s.disposition ?? f.view.why}); choose another option with the user`, WI.attemptFailed);
      return { kind: 'waiting' };
    }
    if (v.exhausted && (await ctx.ports.scheduler.status(f.task))?.state === 'exhausted') {
      await escalateToUser(ctx, id, `task ${f.task}: the restarts after quarantine or seat failure are used up (${v.attempts}/${v.allowed}); only the user can allow more`, WI.loopExhausted);
      return { kind: 'waiting' };
    }
    await markApplied(ctx, id, { restarted: f.task });
    return { kind: 'retrying' };
  }
  if (d.option === 'grant') {
    const g = await ctx.ports.scheduler.grant({ op: `grant:${ctx.mission}:${id}`, lineage: f.lineage, loop: 'env-retry', by: d.by === 'user' ? 'user' : 'secretary', extra: Math.max(1, d.grantExtra), reason: d.reason });
    if (!g.granted) {
      await escalateToUser(ctx, id, `the Secretary's grant on lineage ${f.lineage} was refused (${g.why ?? 'refused'}): only the user can grant more`, WI.loopExhausted);
      return { kind: 'waiting' };
    }
    await markApplied(ctx, id, { granted: d.grantExtra });
    return { kind: 'retrying' };
  }
  return { kind: 'decided', escalation: id, decision: d };
}
