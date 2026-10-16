# Mission Pipeline 4.1.1: post-release backlog

Design contract: `DesignDoc_MissionPipeline_4.1_2026-10-10_v06.md` (with the 4.1.1 amendments).

4.1.1 revises the field's stacked PRs #8–#15 under the maintainer's rulings (U-15 to U-23). Each
part (runs and git; products, composition and delivery; plans, cards and constraints; re-binding and
the Reviewer's deferred answer) and the integration pass went through at most three rounds of code
review, each judged by an independent Stabilizer. Under the release-first ruling only fatal and
serious findings were fixed before the release. The general and minor findings below do not produce
a wrong result in normal use; the known issues a PM must know are in the CHANGELOG.

Closed from the 4.1 backlog by 4.1.1: PM batch de-duplication ignored mode and dependent items; a
Reviewer's `deferred` answer had no owner or reason field.

## Runs and git (`src/process/runs.ts`, `src/git`, `src/memory`)

- A declared command that ignores SIGTERM hangs `spawnSync` past its timeout and keeps the run lock
  (since 4.1.0). Run each command in its own process group: SIGTERM, then SIGKILL after a grace
  period, and close the pipes (`taskkill /T /F` on Windows).
- The reuse key ignores the group: a command recorded in another group keeps that result when it is
  later executed only as setup. A fully reusable group can also answer "pending" while one of its
  keys is busy as another process's setup (a delay only).
- The CLI hints in `cli/project.ts`: `GIT_WRITES_HELD` always suggests `mp pm confirm-copy`, which is
  refused while a copy's links are pending, and `MOVING` then says "another mp is recovering".
- `mp read status` should show the run method when the environment identity changed but its parts
  did not; the 4.1.1 upgrade looks like an unexplained identity change.
- LFS smudge is off in a run checkout: a declared command that checks an LFS file out again writes
  the pointer. Document it in the engine README.

## Renewal (`mp pm renew`)

- `mp pm next` keeps offering `mp pm renew` while a refused judgment waits for its Reviewer, and each
  renew executes a mixed group's setup again.
- Skips that say "a Reviewer judges again" (a run with no candidate or command, an invalid recorded
  group) write no Reviewer request. They need abnormal records.
- Concurrent renews can record a renewal fact twice (harmless). Causes found after a Reviewer request
  exists are not added to it; the Reviewer judges every current run anyway.
- The `OP_CONFLICT` hint ("use a new operation id") misleads for internal operations.
- Tests: `checkedRenew` checks only one mission; extend it to every mission.

## Products, composition and delivery (`src/delivery`, `src/process/actions.ts`)

- Records written before 4.1.1 list only the paths present in a candidate, so a stacked version's
  deletion inside the lower version's write scope is attributed to the lower version (a known issue).
  Cure: take a version's owned paths as its in-scope paths at its origin plus those at its commit,
  in `treeIdentities`, for both the delivery and `startHolds`.
- Before anything writes proof-unit records (nothing does today), `startHolds` must leave out the
  version's own unit and check the unit's external closure, as the final-tree check does.
- At the upgrade, a running Constructor of a dependent attempt without a pin is superseded and its
  work is lost (an upgrade note). Defer the restart until it hands back.
- `unpinnedVersions` reads the mission's events once per legacy product, and `landedVersions` scans
  every product and re-bind event and runs a `merge-base` per landing on each snapshot. Index both
  if missions grow large.
- `submitReviewer` recomputes changed paths through the write-capable `scheduler.product`; a
  read-only resolver would do.
- Not verified: the exit of a pinned dependent accepted on a dependency version that a later
  acceptance superseded.

## Plans, cards and constraints (`src/flow/planning.ts`, `src/seat/cards`, constraints)

- WI-34 (a known issue): a plan re-review started by the program, re-comparing a planning review's
  constraints in flight (v51 §9.5), and re-reviewing feasibility and Calibrator ② in place all need
  a ruling first (4.1.2 agenda).
- WI-34 can hide a second gap: while the PM plan has a gap, the detailed plan's own gap shows only
  after exit 1, so the PM may pay for a Calibrator ① re-check and still need exit 2. The notice could
  name the dependent plan.
- `mp pm next` lists steps that `mp pm dispatch` refuses (every refreshed kind). A dry-run refresh
  could show them as held, with the reason.
- Every `NOT_READY` should name a command that exists (an Auditor refusal says "rebuild the audit"),
  and rebuilds should be bounded: after a number of refusals, tell the PM.
- Over-binding: every quoted decision becomes a binding basis of every refreshed judgment, so one late
  revision makes the whole mission stale. Bind only the decisions related to contract lines or
  constraints.
- A withdrawn line a card builder drops shows "not fully proven" instead of "basis withdrawn".
- The requirement items of an Architect decomposition card stay as they were at queue time (they bind
  nothing; the later reviews bind the result).
- The Secretary card shows the current object constraints, while the ruling it writes binds the
  negation's inputs. Show the instruction constraints plus the position's bound object constraints
  at their bound versions.
- `mp pm constraint add` with a withdrawn id, and `mp pm constraint withdraw` with an unknown id, fail
  as program internal errors (WI-20) instead of coded refusals; their messages are right.
- The Architect card, `roles/architect.md`, the `plan-revision-restarts-work` notice and Appendix K
  say a re-specced task "continues from its previous candidate". The code starts it from its
  dependencies' current work without the earlier change (U-20). Align the texts, and the comment in
  `submitConstructor`.
- From field PR #11's related findings, still open: a re-plan request cannot be withdrawn and is
  routed into whatever batch is latest, even for a task re-specced or dropped since; a superseded
  batch's queued Architect, feasibility and Calibrator ② steps stay queued (only its Calibrator ①
  steps are cancelled); a Calibrator ② continuation is offered only within one PM plan version.

## Re-binding, reviews and the flow's passes (`src/flow/execution.ts`, `src/flow/secretary.ts`)

- The re-bound version and its `rebind` event are two writes. A crash between them, then a new plan,
  leaves a replay conflict (WI-20 on every pass) until a card change. Write them in one write, or
  record the request first and replay from it.
- Findings of a passing review on the accepted version are never answered on that version, so they
  reach neither the issue states nor the close (since 4.1.0).
- `rebindReviewers` counts every re-answer of the attempt after the re-bind, an environment
  re-review's included, so a `.b<n>.r1` could appear beside a queued `.b<n>` (inferred).
- After a respec while the old Reviewer runs, the new card can miss that Reviewer's late findings.
- `kept-product-not-rebound` notices never close, and their keys include the version lists: a
  dependency's re-bind sent to rework gives the dependent one notice for the interim set and another
  for the final one.
- In fast mode with the plan in effect unproven (a WI-34 gap, stale or negated), kept products wait at
  the plan check without a notice of their own; the plan's notice is the exit.
- A dependency whose legacy start check hits a git read error counts as not accepted, so its dependent
  can get a stale-prerequisite notice that the recovered state contradicts.
- Stable mode's gate is checked when a step is queued, not when it is dispatched (also in the 4.1
  backlog): a stable-queued Constructor can be dispatched after a dependency lost its proof. Nothing
  is shown as proven.
- A queued Constructor of a kept card keeps the interface definitions of the plan it was queued
  under; its Reviewer, built under the new plan, sends it back.
- Secretary steps are cancelled once, when their escalation closes: a running Secretary step released
  afterwards may be queued again (not verified).
- A task step that throws skips `supersededStep` for that pass; call it in a `finally`.
- The same shape as the closed-mission fix of 4.1.1: `planningStep` returns in a closed mission before
  cancelling older batches' queued Calibrator ① steps, and the exploration step returns too.

## Field findings not taken into 4.1.1

- B4, B5, B7 and the C findings are parked for after the release. No public description of them
  exists yet; write a generic one before they are ruled on.
