// The process package's public API (design 4.1 §5, §6): what the CLI (`mp pm …`, `mp seat …`)
// calls. Importing it registers the labels extension (A2) before any memory is opened.
//
//   const ctx = openProcess(projectDir, { filler });     // one per mp command
//   const next = await pmNext(ctx);                        // notices, ready steps, in flight
//   const d = pmDispatch(ctx, next.ready[0].step, { filledBy: 'claude-code/opus' });
//   ... the PM's harness starts the seat with d.prompt ...
//   await seatHandback(ctx, d.dispatch, { report, result });
//   ctx.memory.close();

import '../evaluator/index.ts';

export { openProcess, processContext, type GitActions, type ProcessContext, type ProcessOptions, type WorkspaceOps } from './context.ts';
export { advance } from './advance.ts';
export { ActionError, gitActions, productObjectId } from './actions.ts';
export { ProcessError, type ProcessErrorCode } from './errors.ts';
export { labelView } from './labelView.ts';
export { listNotices, markNotices, type PmNotice } from './notices.ts';
export {
  dispatchCandidate,
  parseFiller,
  pmAck,
  pmAnswer,
  pmConstraint,
  pmWithdrawConstraint,
  pmDeliver,
  pmDispatch,
  pmDrain,
  pmGrant,
  pmLand,
  pmRebuild,
  pmLegalizationState,
  pmLegalize,
  pmNext,
  pmPlan,
  pmRelease,
  pmRenew,
  pmRepair,
  pmRequirement,
  pmSay,
  pmStartLegalization,
  pmStop,
  pmWithdrawRequirement,
  purposeOf,
  readSteps,
  wordsText,
  type Dispatched,
  type HeldStep,
  type InFlight,
  type NextReport,
  type ReadyStep,
  type Released,
  type Renewed,
  type UserWait,
} from './pm.ts';
export {
  commitFiles,
  dispatchView,
  materialLeaf,
  recordEvidenceRequest,
  recordSeatHandBack,
  seatCard,
  seatCheckout,
  seatHandback,
  seatRead,
  seatRequestEvidence,
  seatRerun,
  seatFullRun,
  seatOwners,
  type CandidateInfo,
  type DispatchView,
  type HandBackAnswer,
  type HandBackInput,
} from './seat.ts';
export { DISPATCH_LINE, MemoryFlowEvaluator, MemoryFlowLedger, MemoryFlowScheduler, REDISPATCH_LOOP, handbackDoc, memoryFlowPorts, noticeAlertId, raiseNotice, taskStatus, type HandbackDoc, type TaskSpecDoc } from './ports.ts';
export { CLOSE_MODES, allowedAfterClose, fullRunLine, heldByClose, missionState, pmClose, pmMission, snapshotLines, type CloseMode, type Closed, type CloseSnapshot } from './close.ts';
export { acceptedOutputs, deliveryIdFor, pmFinish, targetKey, type Finished } from './finish.ts';
export { cardForSeat, noticeOlderEnvironment, OLDER_ENVIRONMENT_NOTICE, pmReopenExploration } from './environmentLabels.ts';
export { buildDeliveryCandidate, FULL_RUN_EVENT, FULL_RUNS_LINE, fullRunMarkers, fullRunStatus, missionOutputs, passingFullRunEvidence, pmFullRun, runFullSuite, suiteHash, treeOf, type FullRunBody, type FullRunCites, type FullRunCommand, type FullRunMarker, type FullRunResult, type FullRunStatus, type PmFullRunRequest } from './fullRuns.ts';
export { CWD_FIELD, normalizeCwd, runCwd, closingRunner, commandLine, FULL_RUN_TAIL, LOCAL_TAIL, newRunId, runLeaf, runOnCommit, RunInProgress, shellRunner, tail, tapResults, type CommandOutcome, type CommandRunner, type DeclaredCommand, type RecordedRun, type TailLimit } from './runs.ts';
export { pmClean, sweepTmp, type CleanReport, type SweepReport, type SweptEntry } from './housekeeping.ts';
