// The flows' composition root: the one place that builds a FlowEngine with every flow step:
// the Secretary escalations, the decision layer and execution (engine.ts), plus the exploration
// and legalization steps (src/flow/exploration/register.ts). The scheduler only calls
// `createFlowEngine(ports).reconcile()` on its tick and after each accepted outcome.
//
// Import order and cycles: engine.ts never imports the exploration or audit modules; they import
// engine.ts (registerFlowStep). This module imports both sides, so nothing here is evaluated
// before engine.ts has defined its registry. The steps are also passed explicitly, so the
// engine does not depend on the registration side effect.

import { FlowEngine, type FlowStep } from './engine.ts';
import { EXPLORATION_FLOW_STEPS } from './exploration/register.ts';
import type { FlowPorts } from './ports.ts';

export interface CreateFlowEngineOptions {
  /** Passes per mission and reconciliation (default 50). */
  readonly maxPasses?: number;
  /** Extra steps (tests, future flows), run after the built-in ones. */
  readonly steps?: ReadonlyArray<{ readonly name: string; readonly step: FlowStep }>;
}

export function createFlowEngine(ports: FlowPorts, o: CreateFlowEngineOptions = {}): FlowEngine {
  return new FlowEngine(ports, {
    ...(o.maxPasses !== undefined ? { maxPasses: o.maxPasses } : {}),
    steps: [...EXPLORATION_FLOW_STEPS, ...(o.steps ?? [])],
  });
}
