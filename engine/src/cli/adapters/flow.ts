// The CLI's adapter to the decision-layer flows (design 3.1-3.8, 4.3, 11.1): requirement items
// and constraints (src/flow/requirements.ts), PM plan batches (planning.ts; explorations are
// elements of the PM plan), the user's answers to escalations (secretary.ts) and legalization
// (src/flow/audit). The flows themselves run in the scheduler; what the PM records here are
// ledger facts the scheduler's flow engine picks up on its next reconcile.
//
// The CLI builds the flows' ports itself: the ledger port over the ledger service, the
// evaluator port over the evaluator's query socket, and a scheduler port whose every method
// refuses (none of the functions run here needs the scheduler). The legalization request,
// which needs the scheduler's snapshot, runs in the scheduler (its RPC legalizationRequest).

import { id, type MissionId } from '../../common/ids.ts';
import { ledgerAdapter, evaluatorAdapter } from '../../flow/adapters.ts';
import { legalizationState, startLegalization } from '../../flow/audit/index.ts';
import { wiPagePath, wiTitle } from '../wi.ts';
import type { FlowEvaluatorPort, FlowPorts, FlowSchedulerPort } from '../../flow/ports.ts';
import { recordConstraint, recordItem, withdrawItem, type ItemSource, type ItemType } from '../../flow/requirements.ts';
import { submitPmBatch } from '../../flow/planning.ts';
import { answerEscalation } from '../../flow/secretary.ts';
import type { DecisionOption } from '../../seat/cards/secretary.ts';
import { Alerts } from '../../scheduler/alerts.ts';
import { ControlPlane } from '../../scheduler/controlPlane.ts';
import { SchedulerLedger } from '../../scheduler/ledger.ts';
import type { Ctx } from '../context.ts';
import { CliError, EXIT, NotImplemented, errorMessage } from '../errors.ts';

export type { ItemType };

export interface FlowResult {
  /** Text for the PM. */
  readonly text: string;
  readonly json: unknown;
  /** Non-zero for a refusal the flow answered with (e.g. a legalization refused at its plan, WI-25). */
  readonly exitCode?: number;
}

export interface FlowAdapter {
  /** 3.1: a requirement item version, with its source in the user's words (a booked message) or an authorization. */
  addRequirement(ctx: Ctx, r: { mission: string; item: string; type: ItemType; text: string; source: ItemSource; restatement: string | null; confirmedBy: string | null }): Promise<FlowResult>;
  /** 3.1: withdraw a requirement item. */
  withdrawRequirement(ctx: Ctx, r: { mission: string; item: string; reason: string }): Promise<FlowResult>;
  /** 9.5: a project constraint (object constraint or execution instruction) with its scope. */
  addConstraint(ctx: Ctx, r: { mission: string; constraint: string; kind: 'object' | 'instruction'; text: string; paths: readonly string[]; taskTypes: readonly string[] }): Promise<FlowResult>;
  /** 3.3: a PM plan version (one alignment batch); the scheduler then starts Calibrator 1. Explorations are elements of the plan (4.3). */
  submitPlan(ctx: Ctx, r: { mission: string; plan: unknown; userWords: readonly string[]; changedItems: readonly string[]; dependentItems: readonly string[]; mode: 'stable' | 'fast' | null }): Promise<FlowResult>;
  /** 3.8, WI-24: the user's answer to an escalation (the Secretary could not decide, or asked the user). */
  answer(ctx: Ctx, r: { mission: string; escalation: string; option: DecisionOption; words: string; instructions: string | null; grantExtra: number | null }): Promise<FlowResult>;
  openMission(ctx: Ctx, r: { mission: string }): Promise<FlowResult>;
  listMissions(ctx: Ctx, r: { state: 'open' | 'closed' | 'all' }): Promise<FlowResult>;
  /** 11.1: the user asks for legalization: the backfill plan is computed and shown; nothing starts. */
  requestLegalization(ctx: Ctx, r: { mission: string; legalization: string | null; endpoint: string; words: string }): Promise<FlowResult>;
  /** 11.1: the user saw the plan and starts it. */
  startLegalization(ctx: Ctx, r: { mission: string; legalization: string; words: string }): Promise<FlowResult>;
  legalizationState(ctx: Ctx, r: { mission: string; legalization: string }): Promise<FlowResult>;
}

/** Every scheduler method of the flows from the CLI: the scheduler RPC has no flow methods yet. */
function schedulerPortFromCli(): FlowSchedulerPort {
  return new Proxy({} as FlowSchedulerPort, {
    get(_t, prop) {
      return () => {
        throw new NotImplemented(`the flows' scheduler call "${String(prop)}" from the CLI`, 'a scheduler RPC flow method for it (src/scheduler/flowRpc.ts), as legalizationRequest is');
      };
    },
  });
}

function evaluatorPortFromCli(ctx: Ctx): FlowEvaluatorPort {
  const ev = ctx.evaluator();
  if (ev !== null) return evaluatorAdapter(ev);
  const down = (): never => {
    throw new CliError('UNAVAILABLE', 'the evaluator is not reachable (no query socket): the derived state is needed here (WI-11)', { exitCode: EXIT.UNAVAILABLE, wi: 'WI-11' });
  };
  return { labels: down, deciding: down, judgments: down, ops: down };
}

/** The flows' ports for one CLI command. */
export function cliFlowPorts(ctx: Ctx): FlowPorts {
  const ledger = new SchedulerLedger(ctx.ledger());
  const content = ctx.content();
  const alerts = new Alerts({ ledger, content, controlPlane: new ControlPlane(ctx.config.controlPlane), source: 'pm' });
  return { ledger: ledgerAdapter({ ledger, content, alerts, gen: () => null }), scheduler: schedulerPortFromCli(), evaluator: evaluatorPortFromCli(ctx), now: () => ctx.now };
}

/** A flow function's own errors (bad ids, unknown escalations, an invalid plan) are refusals of this action only. */
async function guarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CliError) throw e;
    const name = (e as Error)?.name ?? '';
    if (name === 'RemoteLedgerError' || name === 'LedgerUnavailable') throw new CliError((e as { code?: string }).code ?? 'UNAVAILABLE', `${what}: ${errorMessage(e)}`, { exitCode: name === 'LedgerUnavailable' ? EXIT.UNAVAILABLE : EXIT.REFUSED, wi: (e as { wi?: string | null }).wi ?? null });
    throw new CliError('FLOW_REFUSED', `${what}: ${errorMessage(e)}`, { exitCode: EXIT.REFUSED });
  }
}

export const realFlowAdapter: FlowAdapter = {
  async addRequirement(ctx, r) {
    const version = await guarded('recording the requirement item', () =>
      recordItem(cliFlowPorts(ctx), {
        mission: id<MissionId>(r.mission),
        item: r.item,
        type: r.type,
        text: r.text,
        source: r.source,
        ...(r.restatement !== null ? { restatement: r.restatement } : {}),
        ...(r.confirmedBy !== null ? { confirmedBy: r.confirmedBy } : {}),
      }),
    );
    return { text: `Requirement item ${r.item} (${r.type}) recorded as version ${version}.`, json: { mission: r.mission, item: r.item, version } };
  },
  async withdrawRequirement(ctx, r) {
    await guarded('withdrawing the requirement item', () => withdrawItem(cliFlowPorts(ctx), { mission: id<MissionId>(r.mission), item: r.item, reason: r.reason }));
    return { text: `Requirement item ${r.item} withdrawn; the requirement set has a new version.`, json: { mission: r.mission, item: r.item, withdrawn: true } };
  },
  async addConstraint(ctx, r) {
    const version = await guarded('recording the constraint', () =>
      recordConstraint(cliFlowPorts(ctx), { mission: id<MissionId>(r.mission), constraint: r.constraint, kind: r.kind, text: r.text, scope: { paths: [...r.paths], taskTypes: [...r.taskTypes] } }),
    );
    return { text: `Constraint ${r.constraint} (${r.kind === 'object' ? 'object constraint' : 'execution instruction'}) recorded as version ${version}.`, json: { mission: r.mission, constraint: r.constraint, version } };
  },
  async submitPlan(ctx, r) {
    const out = await guarded('submitting the PM plan', () =>
      submitPmBatch(cliFlowPorts(ctx), {
        mission: id<MissionId>(r.mission),
        plan: r.plan,
        userWords: r.userWords,
        changedItems: r.changedItems,
        dependentItems: r.dependentItems,
        ...(r.mode !== null ? { mode: r.mode } : {}),
      }),
    );
    return { text: `PM plan batch ${out.batch} recorded (plan version ${out.plan}); Calibrator 1 checks it next. The Architect starts only after it passes.`, json: { mission: r.mission, ...out } };
  },
  async answer(ctx, r) {
    await guarded('recording the answer', () =>
      answerEscalation(cliFlowPorts(ctx), {
        mission: id<MissionId>(r.mission),
        escalation: r.escalation,
        option: r.option,
        words: r.words,
        ...(r.instructions !== null ? { instructions: r.instructions } : {}),
        ...(r.grantExtra !== null ? { grantExtra: r.grantExtra } : {}),
      }),
    );
    return { text: `Answer to escalation ${r.escalation} recorded (${r.option}); the program carries it out on its next round.`, json: { mission: r.mission, escalation: r.escalation, option: r.option } };
  },
  async openMission(ctx, r) {
    await ctx.call('setMission', { mission: r.mission, state: 'open' });
    return { text: `Mission ${r.mission} is open (spend limit: unlimited unless set).`, json: { mission: r.mission, state: 'open' } };
  },
  async listMissions(ctx, r) {
    const list = (await ctx.call('missions', { state: r.state })) as Array<{ mission: string; state: string; closes: number }>;
    const text = list.length === 0 ? `No ${r.state === 'all' ? '' : `${r.state} `}missions.` : list.map((m) => `${m.mission}: ${m.state}${m.closes > 0 ? ` (closing snapshots: ${m.closes})` : ''}`).join('\n');
    return { text, json: { missions: list } };
  },
  async requestLegalization(ctx, r) {
    // In the scheduler, which owns the flows and the snapshot the plan needs (src/scheduler/flowRpc.ts).
    const a = (await ctx.sched('legalizationRequest', { mission: r.mission, endpoint: r.endpoint, words: r.words, ...(r.legalization !== null ? { legalization: r.legalization } : {}) })) as {
      legalization: string;
      plan: { endpoint: string; chain: string[]; pending: string[]; seats: number; blocked: Array<{ id: string; label: string; path: string[] }> } | null;
      started: boolean;
      result: { outcome: string; wi: string | null; why: string } | null;
    };
    const plan = a.plan;
    if (a.result !== null) {
      const head = `Legalization ${a.legalization} of ${plan?.endpoint ?? r.endpoint} cannot proceed (${a.result.outcome}): ${a.result.why}`;
      const wi = a.result.wi;
      const text = wi === null ? head : `${head}\nHandle per ${wi}${wiTitle(wi) !== null ? ` ${wiTitle(wi)}` : ''}: open the WI page ${wiPagePath(wi)}`;
      return { text, json: { ...a, wi }, exitCode: EXIT.REFUSED };
    }
    const text =
      plan === null
        ? `Legalization ${a.legalization} was requested; its plan is not recorded yet.`
        : `Legalization ${a.legalization} of ${plan.endpoint}: ${plan.pending.length} of ${plan.chain.length} nodes need a backfill; at most ${plan.seats} Auditor seats.${a.started ? ' It is already started.' : ` Show the user; when they agree: mp legalize start ${r.mission} ${a.legalization} --words "<their words>".`}`;
    return { text, json: { ...a, wi: null } };
  },
  async startLegalization(ctx, r) {
    await guarded('starting the legalization', () => startLegalization(cliFlowPorts(ctx), id<MissionId>(r.mission), r.legalization, r.words));
    return { text: `Legalization ${r.legalization} started; the program runs the Auditors and tells you the result.`, json: { legalization: r.legalization, started: true } };
  },
  async legalizationState(ctx, r) {
    const s = await guarded('reading the legalization', () => legalizationState(cliFlowPorts(ctx), id<MissionId>(r.mission), r.legalization));
    const json = { legalization: r.legalization, requested: s.request !== null, started: s.started, tasks: s.tasks.size, consumed: s.consumed.size, chain: s.chain, result: s.result };
    const state = s.request === null ? 'not requested' : s.result !== null ? `ended: ${s.result.outcome}${s.result.wi ? ` (${s.result.wi})` : ''}` : s.started ? `running (${s.consumed.size} of ${s.tasks.size} Auditor tasks done)` : 'planned, waiting for the user to start it';
    return { text: `Legalization ${r.legalization}: ${state}`, json };
  },
};

let current: FlowAdapter = realFlowAdapter;

export function flowAdapter(): FlowAdapter {
  return current;
}

/** Tests (or a wiring change): replace methods; returns a function restoring the previous adapter. */
export function useFlowAdapter(a: Partial<FlowAdapter>): () => void {
  const prev = current;
  current = { ...current, ...a };
  return () => {
    current = prev;
  };
}
