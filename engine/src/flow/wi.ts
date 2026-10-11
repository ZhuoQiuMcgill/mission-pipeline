// The work instructions the decision-layer and execution flows name in their notices (design
// 4.1 §6.9; the 4.1 set: WI-01..08, 13, 16, 19..21, 23..26, 28..33). Every exception these flows
// can emit takes its WI from here; a notice with `wi: null` is a normal branch of the flow (3.9:
// Secretary notices, a Calibrator ① return, the user's decision needed by 3.2).

export const WI = {
  /** 6.5: a loop (mechanical return, feasibility return, rework, re-dispatches after releases) is exhausted, or shows no progress. */
  loopExhausted: 'WI-08',
  /** 4.1 §5.4: an interrupted dispatch (released ended or abandoned; a seat that ended without a hand-back). */
  attemptFailed: 'WI-28',
  /** Git or LFS objects a step needs are not in the repository (never fetched). */
  missingObjects: 'WI-13',
  /** A program defect inside the flow (an unexpected result shape, a record missing after acceptance). */
  internalError: 'WI-20',
  /** A re-plan dropped or changed a task that already has work in flight. */
  planTaskDropped: 'WI-23',
  /** The Secretary could not decide (its seat's hand-back was not accepted); the PM and the user decide. */
  secretaryUndecided: 'WI-24',
  /** A decision-layer step cannot continue as it is (its seat's hand-back came after a stop). */
  stepStopped: 'WI-26',
  /** 4.1 §3.3: a leaf the step needs is missing or edited, or a commit it needs is not reachable here. */
  leafMissing: 'WI-30',
  /** 4.1 §3.3 step 2: git writes are held after a move until the PM confirms which copy is in use. */
  gitHeld: 'WI-31',
  /** 4.1 §4.1: the labels kept recomputing (a propagation frontier left for 10 minutes). */
  recomputing: 'WI-32',
  /** 4.1 §6.3: an exploration awaits a ruling: the Stabilizer found a shift of direction or a drift. */
  explorationRuling: 'WI-33',
} as const;
