// Registers the exploration and legalization steps with the flow engine. Import this module once
// from the composition root (where the FlowEngine is built), not from src/flow/engine.ts itself:
// engine.ts ← register.ts → engine.ts would be an import cycle evaluated before engine.ts has
// defined its registry. Alternatively pass EXPLORATION_FLOW_STEPS to `new FlowEngine(ports, { steps })`.

import { legalizationStep, registerLegalizationStep } from '../audit/step.ts';
import { explorationStep, registerExplorationStep } from './step.ts';

export const EXPLORATION_FLOW_STEPS = [
  { name: 'exploration', step: explorationStep },
  { name: 'legalization', step: legalizationStep },
] as const;

registerExplorationStep();
registerLegalizationStep();
