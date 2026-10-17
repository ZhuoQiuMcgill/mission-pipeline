// The flow engine: reconciles every mission's flows from the project memory (design 4.1 §5.1,
// §14 "Process"; 4.0 3, 4, 8, 11.1).
//
// One pass runs every flow step of a mission once: the Secretary escalations, the decision layer,
// execution, and the steps other flows register (exploration, legalization). A step reads the
// memory, takes the next deterministic actions (idempotent: op ids, task ids, event keys), and
// marks progress. The engine repeats passes until one makes no progress, so a call settles
// everything that can move now; what waits on a seat or a run moves on a later call (`mp`
// reconciles after each hand-back, after the PM's flow commands, and in `mp pm next`).
//
// Errors stay inside their mission and step: a transient port error (the memory busy, labels
// recomputing) is retried on the next call; anything else is a program defect, told to the PM
// with WI-20, and the other steps go on. 4.1.2: in a seat-side pass (a hand-back advancing the
// flow in the seat's own process), an error the environment's permissions caused (EROFS, EACCES,
// EPERM on a git or filesystem write: a sandbox) is not a defect: no notice; the pass stops and
// is left to the PM's next step, which runs it in the PM's own process.

import { missionIdProblem, type MissionId } from '../common/ids.ts';
import { flowCtx, type FlowCtx } from './context.ts';
import { executionStep } from './execution.ts';
import { planningStep } from './planning.ts';
import { planConstraintStep } from './plan-constraints.ts';
import { repairStep } from './repair.ts';
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
  /** `sandbox`: a seat-side pass met a permission error of its environment; what it could not write (no notice, left to the PM). */
  readonly errors: ReadonlyArray<{ readonly step: string; readonly message: string; readonly sandbox?: string }>;
}

const TRANSIENT = new Set(['UNAVAILABLE', 'NOT_READY', 'BUSY', 'RECOMPUTING', 'BELOW_FLOOR', 'STALE_REQUEST']);

const DENIED_CODES = new Set(['EROFS', 'EACCES', 'EPERM']);
/** What git or the OS prints for the same three errors (git reports them in its stderr, not as a code). */
const DENIED_TEXT = /read-only file system|permission denied|operation not permitted|insufficient permission/i;

/**
 * Whether an error was caused by the environment's permissions on a write (EROFS, EACCES, EPERM):
 * what could not be written, or null. Read from the error's code, its git result's stderr, and its
 * causes; the message text is only a fallback for an error that carries neither. The caller asks
 * only in a seat-side pass (the flag), never to classify a PM-side error.
 */
export function permissionDenied(e: unknown): string | null {
  for (let x: unknown = e, depth = 0; x !== null && x !== undefined && depth < 6; x = (x as { cause?: unknown }).cause, depth++) {
    if (typeof x !== 'object') break;
    const o = x as { code?: unknown; path?: unknown; syscall?: unknown; argv?: readonly string[]; result?: { stderr?: Buffer | string }; message?: unknown };
    if (typeof o.code === 'string' && DENIED_CODES.has(o.code)) return typeof o.path === 'string' ? o.path : `${typeof o.syscall === 'string' ? o.syscall : 'a write'} (${o.code})`;
    const stderr = o.result?.stderr === undefined ? '' : o.result.stderr.toString();
    if (Array.isArray(o.argv) && DENIED_TEXT.test(stderr)) {
      const at = /'([^']+)'/.exec(stderr)?.[1];
      return `${at ?? 'the repository'} (git ${o.argv.slice(1, 3).join(' ')}: ${DENIED_TEXT.exec(stderr)![0]})`;
    }
    if (typeof o.message === 'string' && /\b(EROFS|EACCES|EPERM)\b/.test(o.message)) {
      const at = /'([^']+)'/.exec(o.message)?.[1];
      return `${at ?? 'a file'} (${/\b(EROFS|EACCES|EPERM)\b/.exec(o.message)![1]})`;
    }
  }
  return null;
}

export class FlowEngine {
  private readonly ports: FlowPorts;
  private readonly maxPasses: number;
  private readonly extra: ReadonlyArray<{ readonly name: string; readonly step: FlowStep }>;

  /** A seat-side pass (a hand-back's own process): permission errors of the environment are left to the PM. */
  private readonly seatSide: boolean;

  constructor(ports: FlowPorts, opts: { readonly maxPasses?: number; readonly steps?: ReadonlyArray<{ readonly name: string; readonly step: FlowStep }>; readonly seatSide?: boolean } = {}) {
    this.ports = ports;
    this.maxPasses = opts.maxPasses ?? 50;
    this.extra = opts.steps ?? [];
    this.seatSide = opts.seatSide === true;
  }

  private steps(): ReadonlyArray<{ readonly name: string; readonly step: FlowStep }> {
    const out = [
      { name: 'secretary', step: secretaryStep },
      { name: 'planning', step: planningStep },
      // 4.1.2 (D-10): repairs amend the plan in effect before execution moves
      { name: 'repair', step: repairStep },
      { name: 'plan-constraints', step: planConstraintStep },
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
    const errors: Array<{ step: string; message: string; sandbox?: string }> = [];
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
          // a seat's sandbox (read-only .git, no write permission) is not a program defect: no WI-20
          const sandbox = this.seatSide ? permissionDenied(e) : null;
          errors.push({ step: s.name, message, ...(sandbox !== null ? { sandbox } : {}) });
          if (sandbox === null && !TRANSIENT.has(code)) {
            await this.ports.ledger
              .notify({
                mission,
                category: 'flow-internal-error',
                wi: WI.internalError,
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
