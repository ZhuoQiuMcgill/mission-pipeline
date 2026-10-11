// The labels package's public API (design 4.1 §4.1, §6.5): proof labels stored
// in the project memory, run classes, the environment identity, renewal. What
// the process (A3), git and delivery (A4) and CLI (A5) packages use.
//
// Importing this module (or labels.ts) registers the labels extension for every
// memory opened afterwards.
//
//   const m = openMemory(dir);
//   currentEnvironment(m);                          // once per process, before decisions
//   m.write({ op, payload }, (tx) => appendRecords(tx, records));   // labels follow in the write
//   m.read((db) => decisionLabels(db, ['P1']));     // 'proven' | ... | 'recomputing'
//   m.write({ op, payload }, (tx) => commitProofOp(tx, { opId }));  // the gate refuses unless proven
//   labelBatch(m);                                  // `mp pm next`: one PM batch (at least one step, however large)
//   drain(m);                                       // `mp pm drain`
//   m.read((db) => renewalCandidates(db));          // `mp pm renew`: what to rerun

export {
  continuationCheck,
  decidingViews,
  decisionLabels,
  dependencyCycles,
  derivedState,
  drain,
  fixStates,
  FRONTIER_NOTICE_MS,
  judgmentStates,
  labelBatch,
  LABEL_RULES,
  LABELS_EXTENSION,
  labelStatus,
  opStates,
  readLabels,
  recompute,
  PATH_DEPTH_MAX,
  setLabelBatchLimit,
  UNIT_LIMIT,
  type BatchReport,
  type DrainReport,
  type LabelStatus,
} from './labels.ts';
export {
  currentEnvironment,
  ENV_LINE,
  ENVIRONMENT_CONFIG_KEY,
  environmentConfig,
  environmentIdentity,
  forgetObservedEnvironment,
  observedEnvironment,
  observeEnvironment,
  readEnvironmentConfig,
  recordedEnvironment,
  recordEnvironment,
  runVersionCommand,
  VERSION_OUTPUT_MAX,
  type CurrentEnvironment,
  type EnvironmentConfig,
  type EnvironmentIdentity,
  type EnvironmentParts,
} from './environment.ts';
export { findReusableRun, recordRenewal, recordRenewedRun, renewalCandidates, type RenewalCandidate, type RenewalCandidates, type RenewalJudgment, type RenewalOutcome } from './renew.ts';
export { rerunMismatch, RUN_FIELD, runClassOf, runCwdOf, sampleRunId, type RunDeclaration } from './runs.ts';
export { isStatisticalOrExternalField, isTimingField, renewalDecision, usesSampledFields, type EvidenceUse, type RenewalDecision } from './renewal.ts';
export { labelSummary, type StoredSummary } from './summary.ts';
export type { Conclusion, ContinuationRequest, ContinuationResult, DecidingEvidence, DecidingView, DerivedState, FixState, Label, OpState, TargetState } from './semantics.ts';
