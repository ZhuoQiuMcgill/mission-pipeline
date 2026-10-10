// The exploration flow (design 4.3, 6.2, 8.2): definition, rounds, evidence, stops, and its
// place in the flow engine. See machine.ts for the rules, flow.ts for the driver, step.ts for
// the contract with the decision layer and the Secretary.

export { explorationDefinition, ExplorationDefinitionSchema, xid, type ExplorationDefinition } from './definition.ts';
export { decide, fold, type Action, type RulingBody, type StopReason, type XState } from './machine.ts';
export {
  advanceAllExplorations,
  advanceExploration,
  defineExploration,
  explorationHandoffs,
  explorationState,
  recordExplorationRuling,
  redefineExploration,
  type AdvanceReport,
  type ExplorationHandoff,
  type ExplorationPorts,
} from './flow.ts';
export { definitionFromPlan, explorationStep, settledArtifactProven } from './step.ts';
