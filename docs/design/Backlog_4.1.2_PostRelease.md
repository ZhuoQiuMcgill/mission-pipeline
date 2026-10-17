# Mission Pipeline 4.1.2: post-release backlog

Design contract: `DesignDoc_MissionPipeline_4.1_2026-10-10_v06.md` (with the 4.1.2 amendments,
Appendix O). Direction: `DesignDoc_ExecutionRedundancy_2026-10-17_v01.md` (D-1 to D-12).

4.1.2 removes execution redundancy. Four parts (runs and the full suite; disk and checkouts; plans,
reopening and repairs; the PM's surface) and the integration pass went through code review. The
general and minor findings below were not fixed before the release; they do not produce a wrong
result in normal use. The edge cases the parts left to the PM are listed too. Under D-1, a rare edge case gets detection, a safe default and a WI line, not a new
mechanism; the known issues a PM must know are in the CHANGELOG. The open items of the 4.1.1
backlog stay open unless 4.1.2 says otherwise.

## Disk and checkouts (`src/process/housekeeping.ts`, `src/memory/scratch.ts`, `src/git/workspace.ts`)

- A hand-back's or release's removal that does not finish within its budget (`partly`) gives no
  note: the trash waits for the next sweep silently. Add the note "removal pending; `mp pm next` or
  `mp pm clean` finishes it".
- `tidyWorktrees` runs `git worktree list` once per ended Constructor dispatch on every
  `mp pm next`. Run it once per call.
- Seats can create new files in a shared checkout, because its directories stay writable. The card
  says never write there.
- A checkout another process has been building for more than 10 minutes answers `LOCKED`; the seat
  retries. An abandoned seat that is still working loses its checkout (its late hand-back is not
  accepted anyway).
- Path collisions, unsafe paths and missing LFS objects no longer fail a start snapshot, which writes
  nothing. They surface when a seat's checkout or a Constructor's worktree is built.
- `mp pm clean` lists unknown entries and young ownerless scratch and leaves them. WI line: never
  delete them by hand.

## Runs, the full suite and environment labels (`src/process/runs.ts`, `src/process/fullRuns.ts`, `src/process/environmentLabels.ts`)

- `environmentLabels.ts` marks "older environment" only on a card's `verificationRuns`. Auditor and
  exploration cards that list `evidence` miss the mark (information only: such runs count either
  way). Reuse `olderEnvironmentRun` there.
- An output proven only through a proof unit's judgment gets no "older environment" mark in the
  closing snapshot (information only).
- `fullSuite` edited while a dispatch is in flight: the hand-back uses the configuration of that
  moment.
- A full-run marker whose tree is missing locally gives a placeholder in `changedSince.paths`.
  comment is wrong: `mp pm deliver` runs no command.

## Plans, reopening and repairs (`src/flow/execution.ts`, `src/flow/repair.ts`, `src/delivery`)

- A repair decided while a re-plan is in flight can be dropped by that re-plan. The notice
  `plan-revision-restarts-work` names the tasks a repair added that it drops; the PM records the
  repair again (it is not de-duplicated then).
- An integration start that conflicts with a reopened task's new work waits (ruling 6). A repair
  that reopens the dependent, or a re-plan, routes it. The WI index carries a line for it.
- In a delivery, a dependent laid over a reopened task's newer version can show evidence-input
  mismatches; it is labelled honestly (`built-on-superseded`).
- A crash between a no-Constructor integration's product and a dependency change raises a WI-20
  notice (rare).

## The PM's surface (`src/process/finish.ts`, `src/process/close.ts`, `src/cli/commands/pm.ts`)

- `mp pm finish` derives the delivery id from the mission, the outputs, the words and `--message`.
  A delivery ref that exists and points elsewhere makes each retry hit the same id: use
  `mp pm deliver --op <new id>`, then `mp pm land` and `mp pm close`. A `--message` that differs from
  an earlier `mp pm deliver` gives a new id.
- `mp pm constraint add` with the same text, a changed scope and new words records no words on the
  event (an attribution gap). WI: check the operation record; withdraw and add it under a new id.

## Marks that still say "pending ruling"

D-12 makes the mechanics no ruling fixes the author's decisions, and the design contract now marks
them so. Three places outside the contract still say "pending ruling"; change them together with the
code that prints them:
- the Architect's revision rule on its card (`REVISION_CARRY_RULE` in `src/seat/cards/architect.ts`)
  and the two guidance lines on the Architect's role page, which repeat it;
- the comments in `src/evaluator/labels.ts` (U-24) and `src/evaluator/renew.ts`;
- WI-34, which calls automatic plan re-review "pending ruling for 4.1.2".

## Open direction question

- U-23 put on the 4.1.2 agenda whether the program may start a plan re-review by itself when an
  object constraint recorded later leaves a plan's proof short (WI-34). D-1 to D-12 do not rule on
  it, so WI-34 and its two PM exits stay as in 4.1.1.

## Field items not taken in 4.1.2

- The landing's cleanliness check and line endings.
- A words citation cannot be amended once recorded.
- The Calibrator's hand-back has no field for the constraints it binds.
- A Reviewer's card has no read command for run summaries.
