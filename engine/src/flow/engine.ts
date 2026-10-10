// The flow engine: reconciles every mission's flows from ledger state (design 3, 4, 8, 11.1).
//
// One pass runs every flow step of a mission once: the Secretary escalations, the decision layer,
// execution, and the steps other flows register (exploration, legalization). A step reads the
// ledger, takes the next deterministic actions (idempotent: op ids, task ids, event keys), and
// marks progress. The engine repeats passes until one makes no progress, so a call settles
// everything that can move now; what waits on a seat or a run moves on a later call (the
// scheduler calls reconcile after each accepted outcome and on its tick).
//
// Errors stay inside their mission and step: a transient port error is retried on the next call;
// anything else is a program defect, told to the PM with WI-20, and the other steps go on.

import { missionIdProblem, type MissionId } from '../common/ids.ts';
import { flowCtx, type FlowCtx } from './context.ts';
import { executionStep } from './execution.ts';
import { planningStep } from './planning.ts';
import type { FlowPorts } from './ports.ts';
import { secretaryStep } from './secretary.ts';
import { WI } from './wi.ts';

export type FlowStep = (ctx: FlowCtx) => Promise<void>;

const REGISTERED: Array<{ readonly name: string; readonly step: FlowStep }> = [];

/** Other flows (exploration, legalization) register their step once, at module load. */
export function registerFlowStep(name: string, step: FlowStep): void {
  if (!REGISTERED.some((s) => s.name === name)) REGISTERED.push({ name, step });
}

export interface ReconcileReport {
  readonly mission: MissionId;
  readonly passes: number;
  readonly errors: ReadonlyArray<{ readonly step: string; readonly message: string }>;
}

const TRANSIENT = new Set(['UNAVAILABLE', 'NOT_READY', 'STALE_GENERATION']);

export class FlowEngine {
  private readonly ports: FlowPorts;
  private readonly maxPasses: number;
  private readonly extra: ReadonlyArray<{ readonly name: string; readonly step: FlowStep }>;

  constructor(ports: FlowPorts, opts: { readonly maxPasses?: number; readonly steps?: ReadonlyArray<{ readonly name: string; readonly step: FlowStep }> } = {}) {
    this.ports = ports;
    this.maxPasses = opts.maxPasses ?? 50;
    this.extra = opts.steps ?? [];
  }

  private steps(): ReadonlyArray<{ readonly name: string; readonly step: FlowStep }> {
    const out = [
      { name: 'secretary', step: secretaryStep },
      { name: 'planning', step: planningStep },
      { name: 'execution', step: executionStep },
      ...REGISTERED,
      ...this.extra,
    ];
    return out.filter((s, i) => out.findIndex((x) => x.name === s.name) === i);
  }

  /** Reconcile one mission, or every mission with flow events. */
  async reconcile(mission?: MissionId): Promise<ReconcileReport[]> {
    const missions = mission !== undefined ? [mission] : await this.ports.ledger.missions();
    const out: ReconcileReport[] = [];
    for (const m of missions) out.push(await this.reconcileMission(m));
    return out;
  }

  private async reconcileMission(mission: MissionId): Promise<ReconcileReport> {
    const errors: Array<{ step: string; message: string }> = [];
    let passes = 0;
    // a mission id the ledger would not open now (review r1 #17) is skipped with a notice; the others go on
    const bad = missionIdProblem(mission);
    if (bad !== null) {
      await this.ports.ledger
        .notify({
          mission,
          category: 'flow-internal-error',
          wi: WI.internalError,
          key: 'mission-id',
          trigger: `mission ${mission} has records but its id is not allowed: ${bad}`,
          defaultAction: `the flows skip this mission; the other missions go on`,
          detail: { mission, error: bad },
        })
        .catch(() => undefined);
      return { mission, passes, errors: [{ step: 'mission-id', message: bad }] };
    }
    for (; passes < this.maxPasses; passes++) {
      const ctx = flowCtx(this.ports, mission);
      for (const s of this.steps()) {
        try {
          await s.step(ctx);
        } catch (e) {
          const code = (e as { code?: string }).code ?? '';
          const message = `${(e as Error).message}`;
          errors.push({ step: s.name, message });
          if (!TRANSIENT.has(code)) {
            const fault = code === 'EVALUATOR_FAULT'; // 6.1: the derived state cannot be computed
            await this.ports.ledger
              .notify({
                mission,
                category: fault ? 'derived-state-unavailable' : 'flow-internal-error',
                wi: fault ? 'WI-11' : WI.internalError,
                key: `${s.name}:${message.slice(0, 120)}`,
                trigger: `the ${s.name} flow step of mission ${mission} failed: ${message}`,
                defaultAction: `this step is retried on the next reconciliation; the other steps and missions go on`,
                detail: { mission, step: s.name, error: message, stack: (e as Error).stack?.split('\n').slice(0, 6) ?? [] },
              })
              .catch(() => undefined);
          }
        }
      }
      if (!ctx.progressed || errors.length > 0) {
        passes++;
        break;
      }
    }
    return { mission, passes, errors };
  }
}

export { answerEscalation, raiseEscalation, decisionFor, markApplied, isApplied, escalateToUser } from './secretary.ts';
export { submitPmBatch } from './planning.ts';
export { recordItem, withdrawItem, recordConstraint, currentItems, routeDecision } from './requirements.ts';
