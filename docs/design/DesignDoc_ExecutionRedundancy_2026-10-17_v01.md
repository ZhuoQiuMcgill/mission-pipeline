# Design: execution redundancy (maintainer alignment)

- **Date:** 2026-10-17
- **Version:** v01
- **Applies from:** Mission Pipeline 4.1.2

Status: binding direction for 4.1.2 and later. Agreed between the maintainer and the engine author on 2026-10-17, after two field reports. Rulings D-1 to D-12 below are the maintainer's. The analysis in "Where execution redundancy arises" is the author's and was accepted as the basis for 4.1.2. Project names in the field reports are withheld.

## Why

Two field runs showed the same fatal flaw. **The engine over-enforces its rules: it is designed for a perfect state and ignores time and disk cost.**

- On 4.1.0, one mission of 31 tasks took 329 seat dispatches. Re-plans queued one after another, and each ran a full Architect, feasibility and Calibrator ② cycle, even for a cosmetic item.
- On 4.1.1, changing one 9-line paragraph took 2 h 59 min, 17 seat dispatches and 7 runs of the project's 16-minute test suite. It left 10 GB of checkouts in `.mission-pipeline/tmp/`. Strictly, only one of those 7 suite runs was needed:
  - two were the same suite run twice inside one hand-back;
  - two were Constructors running the full suite themselves;
  - two belonged to a "gate" task that existed only because each plan element had to map to its own task;
  - the closing check was the one that was needed.

## The maintainer's rulings

**D-1. Mostly correct is enough.** The pipeline should cover most of the process's correctness. It must not sacrifice time and space to make the process absolutely perfect. Real projects meet many edge cases, so keep slack: full correctness costs too much to be practical. A rare edge case gets detection, a safe default and a work instruction for the PM. It does not get a new mechanism.

**D-2. Reliability comes from redundancy, and redundancy has a cost.** The process exists to raise reliability, and it does so by adding redundancy. Too much redundancy raises the cost of the whole design and wastes resources.

**D-3. The process has enough redundancy; execution has too much.** The redundancy the process provides is enough: the Calibrators, the Architect with its mechanical checks and feasibility, the Constructor, the Reviewer, the closing decision and the Auditor. The redundancy in how the engine executes those steps is far too heavy. Work removes execution redundancy first.

**D-4. The Constructor answers for its own part only.** Its duty is the correctness of its own work, not of its work within the whole project. The Architect upstream split the task and wrote its completion standards. So the Constructor runs at most its own local tests. It must not run the full suite.

**D-5. The Reviewer answers for global problems, cheapest check first.** If a problem is obvious without the full suite, the Reviewer sends the work back without running it. The full suite runs only once nothing is visibly wrong, never as a first step. The program may run a task's local tests at hand-back.

**D-6. Only integration tasks run the full suite.** Other Reviewers judge the code and the local results. When an integration task's full suite fails, the ledger must let the Reviewer trace the failure to the responsible task. **That original task is reopened and fixed**; the integration task does not absorb the fix.

**D-7. A full run leaves a marker; whether to run another full suite at the end is the PM's call.** Every full run, in an integration task or elsewhere, is recorded with a marker in the ledger: when it ran, on which tree, and the result. Before closing, the PM sees whether the ledger has changed since the last marker and judges whether those changes are worth another full run.
- If they are, the PM reports to the user with the reason, and runs it once the user agrees.
- If the user has delegated this decision, the PM decides alone.

**D-8. Delegation is an authorization.** A user who leaves a kind of decision to the PM gives an authorization item, as in 4.1. It is not a separate project mode.

**D-9. The user guides direction and never accepts details.** A PM that keeps asking the user to accept work is wrong. The cause in 4.1.1 is that delivering, landing and closing each needed the user's words, so the PM came back for each one. Closing is the user's own decision, and it is made one of two ways:
- **Exploration-heavy work.** After the flow reports the tasks done, the user and the PM align on what happened, what was concluded and why, and whether another experiment is needed. When the user judges the stage complete, with the remaining work going to a new mission, they tell the PM to close and merge.
- **Execution-heavy work.** The PM reports that the task list is complete. The user tries the product themselves and looks for problems. Problems become repair tasks through the PM; no problems means close.

**D-10. Repairs go through the Architect and the mechanical checks only, and record their reason.** A repair adds a task to the plan in effect through the Architect. Only the mechanical checks apply: no Calibrator ① or ② and no feasibility pass. The repair's reason is recorded. Typical reasons:
- a user-interface or usability problem the user found;
- a missing feature;
- a conclusion that raised something new and needs another experiment.

The PM labels the kind; the user's words are the reason.

**D-11. Closing is never blocked; it records the state honestly.** The system records what is proven, what is not, what is unfinished and the risks. It does not refuse the close.

**D-12. Details are not the user's.** Only direction-level questions go to the user. The PM, or the engine author in development, decides details with a sensible default, and mentions the choice when it matters.

## Where execution redundancy arises

This analysis was accepted as the basis for 4.1.2. Code locations are in v4.1.1 (`8673de6`).

1. **The same work done twice: same input, same result.**
   - A hand-back runs the task's verification commands, and then the flow's pass runs them again. The hand-back's runs are not the flow's `verified` result, and a `network: true` command is never reusable (`process/seat.ts:419`, `flow/execution.ts:669`).
   - A group with one non-reusable command re-executes every command in it (`process/runs.ts:334`).
   - The closing check never reuses a full run of an identical tree.
2. **More than a step needs.**
   - A start snapshot writes the whole tree to disk and deletes it unread; only the commit is used (`delivery/candidate.ts:397`, `process/actions.ts:154`).
   - Every read-only seat gets a private full checkout of the repository.
3. **Leftovers.** Seat checkouts and `tmp/<dispatch>/` are never removed. Killed reruns leave partial checkouts. There is no clean-up command.
4. **Invalidation too wide.** One global environment identity: any tool version change invalidates every run, and renewing reruns the suites. A re-plan re-binds and re-reviews kept products, and their dependents follow.
5. **Rework caused by missing information.** Some cards lack what their seat needs:
   - the Architect cannot see the mechanical rules, the project constraints, the configured commands, or what evidence a Reviewer will have;
   - the Reviewer cannot see the previous Reviewer's reasons;
   - the Secretary cannot see earlier rulings on the same line.

   Seats then judge wrongly, and the work is redone.
6. **Loops with no exit.** The same verdict with no new evidence still dispatches another attempt. Re-plan requests queue serially.
7. **Units split too finely.** A task may trace only one plan element, so one change becomes several tasks, each with its own Constructor, runs and Reviewer.

## What stays

These hard floors are cheap and essential:
- nothing lands on the target branch without the user's words;
- the record is honest: nothing is recorded as checked that was not;
- each Constructor works in its own worktree;
- the program's verification runs on a clean checkout of the candidate;
- what lands traces back to the user's words;
- a stop stops;
- there is no stuck state without an exit.

The rulings of 2026-10-13 stay as ruled, notably:
- no judgment written by the program in a seat's place;
- every declared command takes the run lock;
- no repository hooks while building checkouts.

## Not taken into 4.1.2

**Accountable relaxation of proof rules** (2026-10-15). D-1, D-11 and the honest record cover its purpose, so the relaxation machinery is not built.
