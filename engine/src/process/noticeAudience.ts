// One routing table for the resident operator and the PM. Unknown categories belong to
// the Secretary. The inbox prints both the action and its resolution condition.
export const PM_NOTICE_ACTIONS: Readonly<Record<string, {action: string; resolution: string; resolvingCommand?: boolean}>> = {
  'calibrator-1-returned': {action: 'revise the PM plan with the user or resubmit it', resolution: 'a revised PM plan or resubmission is recorded', resolvingCommand: true},
  'calibrator-1-unavailable': {action: 'resolve the unavailable plan review', resolution: 'the review is restarted or the plan changes', resolvingCommand: true},
  'plan-revision-restarts-work': {action: 'tell the user which work will be redone', resolution: 'the PM acknowledges the notice'},
  'plan-structure-change': {action: 'approve the structural diff or send it back with instructions', resolution: 'a PM or user decision is applied'},
  'plan-restarts-work': {action: 'approve restarting accepted work or send the revision back', resolution: 'a PM or user decision is applied'},
  'needs-user-decision': {action: 'decide from the recorded words; ask the user when F-3 requires it', resolution: 'a PM or user answer is recorded'},
  'loop-exhausted-needs-user': {action: 'decide whether to grant, change, accept or drop the work', resolution: 'a PM or user answer is recorded'},
  'secretary-undecided': {action: 'decide the escalation from the recorded words', resolution: 'a PM or user answer is recorded'},
  'exploration-direction-question': {action: 'answer the direction question from the recorded words', resolution: 'a PM or user answer is recorded'},
  'exploration-converged': {action: 'align with the user on the direction conclusion', resolution: 'the PM acknowledges the conclusion'},
  'exploration-no-conclusion': {action: 'align with the user on the direction conclusion', resolution: 'the PM acknowledges the conclusion'},
  'mission-complete': {action: 'report completion and ask consent to deliver', resolution: 'delivery is recorded or the mission is closed', resolvingCommand: true},
  'legalization-refused': {action: 'report the requested legalization result', resolution: 'the PM acknowledges the result'},
  'legalization-chain-refused': {action: 'report the requested legalization result', resolution: 'the PM acknowledges the result'},
  'legalization-incomplete': {action: 'report the requested legalization result', resolution: 'the PM acknowledges the result'},
  'legalization-plan': {action: 'review the requested legalization plan', resolution: 'the plan is started or the PM acknowledges it'},
  'legalization-stamped': {action: 'report the requested legalization result', resolution: 'the PM acknowledges the result'},
  'plan-constraint-gap': {action: 'resolve the uncovered constraint on the user’s words (WI-34)', resolution: 'the gap is repaired, the constraint is changed, or the decision is recorded', resolvingCommand: true},
};

export function noticeAudience(category: string, detail?: unknown, askUser = false): 'pm' | 'secretary' {
  if (category === 'exploration-converged' || category === 'exploration-no-conclusion') {
    const d = detail as {kind?: string; conclusion?: {kind?: string}; decision?: {type?: string}; direction?: boolean} | null;
    if (!askUser && d?.kind !== 'direction' && d?.conclusion?.kind !== 'direction' && d?.decision?.type !== 'direction' && d?.direction !== true) return 'secretary';
  }
  return askUser || category in PM_NOTICE_ACTIONS ? 'pm' : 'secretary';
}
