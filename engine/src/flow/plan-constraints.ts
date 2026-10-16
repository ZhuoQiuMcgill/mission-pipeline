// Detection only: Appendix I forbids an automatic planning re-check. WI-34 names the exits.
import { decodeConstraintCheck, type ConstraintCheck } from '../common/records.ts';
import { uncoveredConstraintRanges } from '../evaluator/semantics.ts';
import { objectConstraints, type PlanningInputs } from '../seat/cards/inputs.ts';
import { commit, ev, eventsOf, noticeAlertId, objectRecord, shortHash, tellOnce, type FlowCtx } from './context.ts';
import { PLAN_LINE, PM_PLAN_EFFECTIVE, type PmPlanEffectiveBody } from './plandoc.ts';
import { latestEffective } from './planning.ts';
import { currentConstraints } from './requirements.ts';
import { WI } from './wi.ts';

const CATEGORY = 'plan-constraint-gap';
type Gap = { plan: string; uncovered: Array<{ line: string; version: string; paths: readonly string[]; positions: string[] }> };

/** Every pass uses the labels' deciding view, the recorded bindings and the builders' selector. */
export async function planConstraintStep(ctx: FlowCtx): Promise<void> {
  const constraints = await currentConstraints(ctx);
  const gaps = await eventsOf<Gap>(ctx, PLAN_LINE, CATEGORY);
  if (!constraints.some((c) => c.kind === 'object') && gaps.length === 0) return;
  const closed = new Set((await eventsOf(ctx, PLAN_LINE, `${CATEGORY}-closed`)).map((e) => e.key));
  const pm = (await eventsOf<PmPlanEffectiveBody>(ctx, PLAN_LINE, PM_PLAN_EFFECTIVE)).at(-1)?.body.plan;
  const eff = await latestEffective(ctx);
  const plans = [...new Set([pm, eff?.dplan].filter((p): p is string => p !== undefined))];
  const views = (await ctx.ports.evaluator.deciding(plans)).views;
  const labels = (await ctx.ports.evaluator.labels(plans)).labels;
  const inputs = await eventsOf<PlanningInputs>(ctx, PLAN_LINE, 'review-inputs');
  const active = new Set<string>();
  const waiting = new Set<string>();
  for (const plan of plans) {
    const obj = await objectRecord(ctx, plan);
    const view = views[plan];
    const required = obj === null ? [] : objectConstraints(constraints, obj).applicable;
    if (obj !== null && required.length === 0) continue;
    // These are the actual builder task ids, including re-checks and refresh replacements.
    let live = false;
    for (const task of new Set(inputs.filter((e) => e.body.target === plan).map((e) => e.body.task))) {
      const state = (await ctx.ports.scheduler.status(task))?.state;
      if (state === 'queued' || state === 'running') { live = true; break; }
    }
    if (live || labels[plan] === 'recomputing' || obj === null || view?.conclusion !== 'passed' || view.deciding.length === 0 || view.deciding.some((j) => !j.current)) {
      waiting.add(plan);
      continue;
    }
    const positions: Array<{ review: string; checks: ConstraintCheck[] }> = [];
    for (const d of view.deciding) {
      const record = await ctx.ports.ledger.judgment(d.judgment);
      if (record === null) throw new Error(`Missing deciding judgment ${d.judgment} of ${plan}`);
      positions.push({ review: d.review, checks: ctx.ports.ledger.content.getList(record.constraints).map(decodeConstraintCheck) });
    }
    const uncovered = uncoveredConstraintRanges(required, positions.flatMap((p) => p.checks)).map((c) => ({
      ...c, positions: positions.filter((p) => uncoveredConstraintRanges([c], p.checks).length > 0).map((p) => p.review).sort(),
    }));
    if (uncovered.length === 0) continue;
    const gap: Gap = { plan, uncovered };
    // One notice per occurrence of a plan's uncovered set: idempotent while open, and a new one
    // when the same set recurs after its notice was closed (a closed notice stays acknowledged).
    const same = gaps.filter((e) => e.body.plan === plan && shortHash(e.body.uncovered) === shortHash(uncovered));
    const base = `${plan}:${shortHash(uncovered)}`;
    const key = same.find((e) => !closed.has(e.key))?.key ?? (same.length === 0 ? base : `${base}:${same.length + 1}`);
    active.add(key);
    // Remember before notifying, so an interrupted notification is retried on a later pass.
    if (!gaps.some((e) => e.key === key)) {
      await commit(ctx, `flow:${CATEGORY}:${ctx.mission}:${key}`, { events: [ev(ctx, PLAN_LINE, CATEGORY, key, gap)] });
    }
    await tellOnce(ctx, PLAN_LINE, {
      category: CATEGORY, wi: WI.planConstraintGap, key,
      trigger: `plan ${plan} has current deciding pass judgments but uncovered object constraints: ${uncovered.map((c) => `${c.line} (${c.version}; ${c.paths.join(', ')}; positions ${c.positions.join(', ')})`).join('; ')}. See WI-34.`,
      defaultAction: 'stable production waits; fast mode goes on with the plan not fully proven. No review is started automatically. WI-34: with new user words, resubmit the same PM plan for a PM-plan gap, or submit a changed PM plan to obtain a new detailed plan for a detailed-plan gap',
      detail: gap, askUser: true,
    });
  }
  for (const gap of gaps) {
    if (active.has(gap.key) || waiting.has(gap.body.plan) || closed.has(gap.key)) continue;
    // Closing the notice and its lifecycle record is one write; historical evidence stays readable.
    await commit(ctx, `flow:${CATEGORY}-closed:${ctx.mission}:${gap.key}`, {
      events: [ev(ctx, PLAN_LINE, `${CATEGORY}-closed`, gap.key, { plan: gap.body.plan })],
      records: [{ kind: 'notice.delivery', notice: noticeAlertId({ mission: ctx.mission, category: CATEGORY, key: gap.key }), state: 'acknowledged' }],
    });
  }
}
