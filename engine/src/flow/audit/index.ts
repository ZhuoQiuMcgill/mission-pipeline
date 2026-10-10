// Legalization (design 11.1): the Auditor along the lineage, the chain-acceptance object, the stamp.

export { advanceLegalization, aid, legalizationState, requestLegalization, startLegalization, WI_LEGALIZATION, type LegalizationOutcome, type LegalizationReport, type LegalizationRequest } from './flow.ts';
export { lineageSource, nextGeneration, requiredParents, walkLineage, type Lineage, type LineageNode } from './lineage.ts';
export { legalizationStep } from './step.ts';
