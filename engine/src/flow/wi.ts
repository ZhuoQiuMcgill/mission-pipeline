// The work instructions the decision-layer and execution flows name in their notices (design
// 3.11; proposed new ones in src/flow/WI-NEEDED.md). Every exception these flows can emit takes
// its WI from here; a notice with `wi: null` is a normal branch of the flow (3.9: Secretary
// notices, a Calibrator ① return, the user's decision needed by 3.2).

export const WI = {
  /** 6.5: a loop (mechanical return, feasibility return, rework, environment retries) is exhausted, or shows no progress. */
  loopExhausted: 'WI-08',
  /** 6.2, 7.1: a seat failed, was quarantined, or its resources overflowed (the scheduler raises it; the flow escalates). */
  attemptFailed: 'WI-15',
  /** A program defect inside the flow (an unexpected result shape, a record missing after acceptance). */
  internalError: 'WI-20',
  /** Proposed (WI-NEEDED.md): a re-plan dropped or changed a task that already has work in flight. */
  planTaskDropped: 'WI-23',
  /** Proposed (WI-NEEDED.md): the Secretary could not decide (its seat failed); the PM and the user decide. */
  secretaryUndecided: 'WI-24',
  /** Proposed (WI-NEEDED.md): a decision-layer step cannot continue as it is (its seat was cancelled by a stop). */
  stepStopped: 'WI-26',
} as const;
