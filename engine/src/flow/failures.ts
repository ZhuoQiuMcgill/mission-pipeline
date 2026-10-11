// A seat task of a flow that ended without a usable hand-back (design 4.1 §5.4, §6.6; 6.5,
// WI-28, WI-08): the flow asks the Secretary what to do with this one line of work, and carries
// out the generic choices (restart, grant) itself. Abandon and re-plan go back to the caller,
// who owns the line.
//
//   exhausted (the PM released its dispatches more   grant (the Secretary's one grant) / abandon / re-plan / ask the user
//   often than the re-dispatch loop allows, decision 15)
//   needs disposition: its hand-back came after a     abandon / re-plan / ask the user (never restarted while
//   stop (recorded, not accepted, §6.6)               the stop holds; a restart once it is released)
// A restart the memory refuses, or a grant it refuses, goes to the user (WI-28 / WI-08). Only this
// line waits; the rest of the mission goes on.

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
  const id = safeId(`fail.${f.task}.${s.dispatches.length}`);
  if ((await escalation(ctx, id)) === null) {
    const exhausted = f.view.why === 'exhausted';
    const options: DecisionOption[] = [];
    if (exhausted) options.push('grant');
    else if (s.disposition !== 'stop') options.push('restart');
    if (f.canReplan && s.disposition !== 'stop') options.push('replan');
    if (f.canAbandon) options.push('abandon');
    if (options.length === 0) {
      // nothing the program can carry out (a decision-layer seat's hand-back came after a stop): wait and tell the PM (WI-26)
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
        ? `Task ${f.task} used up its attempts (${s.note ?? ''}).`
        : `Task ${f.task} ended without a usable result: ${s.disposition ?? f.view.why} (${s.note ?? ''}).`,
      reasons: [s.note ?? f.view.why],
      options,
      facts: { task: f.task, state: s.state, disposition: s.disposition, dispatches: s.dispatches, loop: s.loop ?? 'quarantine-restart' },
      // the seat task that ended without a usable result (§3.2, U-13)
      handover: { from: f.task, objects: [] },
    });
    if (exhausted) {
      await ctx.ports.ledger.notify({
        mission: ctx.mission,
        category: 'loop-exhausted',
        wi: WI.loopExhausted,
        key: id,
        trigger: `task ${f.task} (lineage ${f.lineage}) exhausted its ${s.loop ?? 'quarantine-restart'} loop: ${s.note ?? ''}`,
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
      await escalateToUser(ctx, id, `task ${f.task}: its restarts are used up (${v.attempts}/${v.allowed}); only the user can allow more`, WI.loopExhausted);
      return { kind: 'waiting' };
    }
    await markApplied(ctx, id, { restarted: f.task });
    return { kind: 'retrying' };
  }
  if (d.option === 'grant') {
    const g = await ctx.ports.scheduler.grant({ op: `grant:${ctx.mission}:${id}`, lineage: f.lineage, loop: s.loop ?? 'quarantine-restart', by: d.by === 'user' ? 'user' : 'secretary', extra: Math.max(1, d.grantExtra), reason: d.reason });
    if (!g.granted) {
      await escalateToUser(ctx, id, `the Secretary's grant on lineage ${f.lineage} was refused (${g.why ?? 'refused'}): only the user can grant more`, WI.loopExhausted);
      return { kind: 'waiting' };
    }
    await markApplied(ctx, id, { granted: d.grantExtra });
    return { kind: 'retrying' };
  }
  return { kind: 'decided', escalation: id, decision: d };
}
