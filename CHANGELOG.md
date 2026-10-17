# Changelog

All notable changes to mission-pipeline are documented here. The plugin version,
this file, and the git tag move together — nothing reaches installed users
without a release.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/).

## [4.1.2] - unreleased

4.1.2 cuts the engine's execution redundancy. Two field runs showed the engine paying for a perfect
process in time and disk:
- one mission of 31 tasks took 329 seat dispatches;
- a 9-line change took 3 hours, 17 seat dispatches, 7 runs of a 16-minute suite and 10 GB of
  leftover checkouts.

The process keeps its checks: the Calibrators, the Architect with its mechanical checks and
feasibility, the Constructor, the Reviewer and the Auditor. What changes is how much work the engine
does to carry them out: the same work done twice, more work than a step needs, leftovers, invalidation
spreading too wide, rework caused by missing information, and units split too finely. The
maintainer's rulings are D-1 to D-12 in `docs/design/DesignDoc_ExecutionRedundancy_2026-10-17_v01.md`
(design contract U-25 to U-36 and Appendix O). One proof rule changes: a run recorded in an older
environment still counts, and every read labels it. The record never says something was checked when
it was not. Read the upgrade notes before you upgrade a project with work in flight.

### Upgrade notes
- **Let running seats hand back first.**
- **Run `mp docs update`.** The project keeps its own copies of the PM handbook, the role pages and
  the WI pages, and an engine upgrade does not replace them. Then have the PM read the handbook's
  core again.
- **The full suite.**
  - Rename `closingChecks` in `config.json` to `fullSuite`. The old key is still read when
    `fullSuite` is absent; `mp config` says which key it read and warns when both are present.
  - `mp pm deliver` no longer runs it. The integration task's Reviewer runs it, and the PM decides
    whether to run it again before closing.
  - Put only local tests in tasks (`verificationCommands`).
- **Environment changes.** A tool update or a move no longer takes proof off anything. Reads mark
  runs from an older environment, and `mp pm renew` is a tool the PM uses when it judges the change
  matters; `mp pm next` no longer offers it. Runs recorded by 4.1.0 (run method v1) still do not
  count: renew them once if you never did.
- **Plans in effect keep their tasks, not their full-suite runs.** `mp` never runs a full-suite
  command at a hand-back, on a plan already in effect too: the hand-back notes the command it
  skipped, and only the integration task's Reviewer runs the suite, with `full-run`. A plan with no
  integration task has then run no suite when the work is done, and the PM decides about a full run
  before closing. A task that writes nothing still gets a Constructor. An integration task with nothing to write that was not dispatched yet runs without a
  Constructor. A revision of such a plan is checked against the new mechanical rules 6 and 7 (every
  task writes something; no task, the integration task included, lists the full suite among its
  commands): the Architect fixes those
  tasks, and their changed cards restart them (notice `plan-revision-restarts-work`).
- **Leftovers.** Run `mp pm clean` once to free the checkouts 4.1.1 left under
  `.mission-pipeline/tmp/`. It reports the space it freed.
- **Closing.** Closing no longer refuses on the state of the work. `--mode` is kept and only
  recorded; every mode records the same honest snapshot.
- **Hook.** The Claude Code adapter no longer runs `mp pm next` at session start.

### Changed
- One hand-back runs each command once. The hand-back ran the task's verification commands, and the
  flow's next pass ran them again, because the hand-back's runs were not the flow's verification and
  a command marked `network` or sampled was never reusable. In a field run, two of the seven suite
  runs were this. Now the hand-back's runs are the attempt's `verified` result, written right after
  they run; the flow reads them and runs nothing. A failing setup command keeps its last lines in
  the run summary.
- The full suite runs where it matters (D-4 to D-7). Constructors run their task's local tests only.
  In a project with a full suite, the integration task's Reviewer checks the cheapest things first,
  and runs the full suite last, with `mp seat <id> full-run`, only when nothing visible is wrong;
  its `pass` is refused without a passing full run of the candidate. Every full run leaves a marker.
  `mp pm deliver` runs no command: before, the closing checks ran on every delivery and every
  rebuild; now a delivery shows whether the full suite ran on its tree, or what changed since it
  last did. Whether to run it again at the end is the PM's call with the user (`mp pm full-run`). A
  passing full run on the same tree, environment and suite is reused, never run again.
- An environment change labels runs and invalidates nothing (D-1, the honest record). Before, a tool
  version change dropped every proof resting on declared runs, stable mode stalled, the PM was
  offered `mp pm renew`, which reran every affected group, and settled explorations reran their
  experiments. Now: no runs, no dispatches, one notice per environment (`environment-older-runs`);
  the reads and the verification runs on a card mark such runs "older environment". Only a cause
  that makes a run meaningless takes it out: runs of the older run method (4.1.0) still do not
  count. A settled exploration is reopened only on the PM's word (`mp pm reopen-exploration`; notice
  `exploration-older-environment`).
- A task may cover several plan elements, and the plan has no read-only tasks. A task traces to `{
  planElements: [...] }` (the 4.1.1 shape `{ planElement }` is still read, and a one-element task
  keeps its identity, so nothing restarts on upgrade). Two new mechanical rules: every task writes
  something, except an integration task or an experiment (rule 6), and no task, the integration task
  included, lists the full suite among its verification commands (rule 7): the integration task's
  Reviewer runs it with `mp seat <id> full-run`. A one-paragraph change planned as one implementation task and four
  read-only check tasks took 5 Constructors, 5 Reviewers and 5 run sets; now it is one task, one
  Constructor and one Reviewer.
- An integration task with nothing to write runs without a Constructor. Its start snapshot (its
  dependencies' accepted work laid together) is recorded as its product, the local runs run once,
  and its Reviewer judges it. This saves one Constructor dispatch and one worktree per such task.
- A failure traced to a task reopens that task (D-6). The integration Reviewer hands back `rework`
  with `reopen`, naming a dependency with accepted work; `mp seat <id> owners <path>...` traces a
  path to the products that changed it. The named task gets a new attempt with the issue on its
  card, counted on its own rework loop; the integration waits for it and builds again on its new
  work. Its other dependents keep their work and proof; reads show them as built on the older
  version. Before, the way back was a full re-plan: a PM batch, Calibrator ①, the Architect,
  feasibility, Calibrator ② and re-bind Reviewers. Now it is that task's Constructor and Reviewer,
  and the integration Reviewer.
- A delivery lays a reopened task's newer version in place of the older version that a dependent
  recorded as a prerequisite. The dependent is stacked over it, and its proof reads
  `built-on-superseded` unless a delivered, proven version (the integration) records both. Recorded
  prerequisites are never rewritten.
- Repairs amend the plan in effect (D-10). `mp pm repair` records the user's reason verbatim and the
  kind the PM chose. An Architect repair step reopens tasks or adds tasks, and only the mechanical
  checks apply: no Calibrator, no feasibility review, no new detailed plan, no re-bind, and existing
  tasks keep their cards and proof. Before, the same problem took Calibrator ①, a new detailed-plan
  cycle and re-binds. A repair about an exploration gives it one more round with the question added.
  The reason is shown on every card the repair causes, in `mp read why` and in the closing snapshot.
- Closing never refuses on the state of the work (D-11). `NOT_READY` and `RECOMPUTING` are gone: a
  refused full close used to mean a retry loop; now it is one write. The snapshot also records the
  words it cites, the delivered entries with their labels at delivery and now, the open and deferred
  issues, the start risks, the outputs proven on runs from an older environment, the repairs, the
  full-run status of the delivered tree, and whether labels were still recomputing. `--mode` is only
  recorded. Refused still: a bad mode, an unknown mission, a words entry that does not exist.
- The end of a mission is one sentence (D-9). `mp pm finish <mission> --words W-<n>` delivers the
  accepted outputs of the plan in effect, lands and closes on one words entry. It used to take three
  words entries and three commands, so the PM came back to the user three times; now it is one and
  one. When landing cannot complete, it stops after the delivery with the mission open, and the same
  words serve again.
- Reading seats share one read-only checkout per commit (`tmp/checkouts/<commit>/`), built in a
  sibling directory and renamed into place, and removed when no dispatch in flight holds it. Before,
  every reading dispatch got its own full copy, kept for good, and killed reruns left partial
  checkouts: a field run left 10 GB under `.mission-pipeline/tmp/`. Now there is at most one copy
  per commit while it is held. Each build also makes its files read-only, and each hold is one small
  flow event.
- Start snapshots and deliveries write no tree. A start snapshot used to write the whole tree into a
  scratch directory, run `git init` and two `git config` calls, hash it and delete it unread. A
  delivery's proof check wrote every file of the candidate. Now both hash from git objects and write
  nothing; a full run's candidate writes no tree either.
- Scratch under `.mission-pipeline/tmp/` has owners. Each scratch directory has an owner lock under
  `locks/owners/`, released by the operating system when its process exits. A dispatch's `tmp/<id>/`
  is removed at its hand-back or release. `mp pm next` sweeps what no live process owns, for at most
  1.5 seconds per call; removals go through `tmp/.trash-*`.
- The SessionStart hook prints a three-line pointer and runs nothing. It used to print the PM
  handbook core and run `mp pm next` in every session, a dispatched seat's included: up to 100
  seconds and a PM write per session start, and a seat could read the PM's steps and act as the PM.
  The hook's timeout went from 120 to 10 seconds.
- A seat whose sandbox cannot write (for example a read-only `.git`) no longer raises WI-20 at its
  hand-back. The hand-back is recorded; what the seat's process could not write is a note ("left to
  the PM: …"), and the PM's next `mp pm next` does it. Any other error still raises WI-20.
- The design contract (v06) records D-1 to D-12 as U-25 to U-36 and adds Appendix O, execution
  redundancy as built. Mechanics the rulings do not fix are marked "Author's decision under D-12"
  (D-12: details are not the maintainer's) instead of "Proposal, pending ruling".

### Added
- `mp pm finish <mission> --words W-<n> [--outputs ...] [--message ...] [--allow-external ...]`:
  deliver, land and close on the user's one sentence.
- `mp pm repair <mission> --words W-<n> --kind defect|usability|missing|new-question --text "..."
  [--about <task|exploration>]`: a problem the user found, as a plan amendment.
- `mp pm full-run <mission> --words W-<n> | --authority <item> --reason "..." [--outputs ...]`: the
  full suite on the candidate `mp pm finish` would deliver; refused without the user's words or an
  authorization item in force. `mp read full-runs <mission>` lists the markers.
- `mp seat <id> full-run` (an integration task's Reviewer) and `mp seat <id> owners <path>...` (an
  integration Reviewer or a repair's Architect).
- `mp pm clean [--mission <m>]`: removes now what no running `mp` process owns under
  `.mission-pipeline/tmp/`, and the worktrees of dispatches that are over; reports the bytes freed
  and what it kept.
- `mp pm reopen-exploration <mission> <exploration> [--words W-<n>]`: the PM's word to reopen a
  settled exploration after an environment change.
- Config `fullSuite` (`[{ id, command, cwd? }]`; `closingChecks` is its deprecated alias) and
  `commit` (`{ author?, committer? }` as `"Name <email>"`, the identity of the commits `mp` writes;
  default `Mission Pipeline <mp@localhost>`). `mp init` writes `fullSuite: []`.
- `mp pm deliver --message "<subject>"` sets the delivery commit's subject; `mp pm close --words
  W-<n>` cites the user's words.
- Notices `environment-older-runs`, `exploration-older-environment`, `repair-decided`,
  `reopen-skipped`, `reopened-task-abandoned` (WI-08) and `integration-start-conflict`.

### Fixed
- A full-suite command is never run at a hand-back or in the flow's verification, also on plans made
  before 4.1.2 and on cards already in flight. It was run before the Reviewer looked, left no full-run
  marker, and the close then said the suite had never run. The integration task's Reviewer runs it
  with `mp seat <id> full-run`; the hand-back notes the command it skipped.
- A stop now holds what it should: reruns, full runs, `mp pm renew` and the flow's verification. The
  verification waits and runs after the stop is released.
- The close lists the tasks of the plan in effect (repair amendments included), not tasks an earlier
  plan version dropped.
- The Architect's card shows the project constraints in force, the mechanical checks its plan must
  pass, the project's local commands and full suite, and what a Reviewer can see. It used to plan
  blind to them, and plans came back.
- A Reviewer's card shows the previous review of the task: its verdict, the standards it found not
  met or unclear with their reasons, and its findings.
- A Secretary's card shows the earlier decisions on the same subject.
- `mp read show plan` prints the mechanical check failures and the order changes.
- `mp init` detects version commands from the project's first-level folders, not only its root
  (skipping dot folders, `node_modules`, `vendor`, `target`, `dist`, `build` and `venv`).
- `mp pm constraint add --words W-<n>` checks the words entry and records it with the constraint.
- Missing LFS objects on paths no evidence reads no longer stop a delivery or a start snapshot.
  Missing objects of an evidence input are reported as `objects-unavailable` (WI-13), like any other
  missing object.
- A Constructor's hand-back says that its worktree has been removed, so a shell left inside it knows
  why its next command fails.

### Known issues
- WI-34 (since 4.1.1) is unchanged: a plan's proof can fall short of an object constraint recorded
  later, and stable production waits for one of WI-34's two exits. Whether the program may start a
  plan re-review by itself was on the 4.1.2 agenda (U-23); D-1 to D-12 do not rule on it.
- A repair decided while a re-plan is in flight can be dropped by that re-plan. The notice
  `plan-revision-restarts-work` names the tasks a repair added that it drops; record the repair
  again.
- An output proven only through a proof unit's judgment gets no "older environment" mark in the
  closing snapshot, and Auditor and exploration cards do not mark older-environment runs. This is
  information only: such runs count either way.
- Seats can create new files inside a shared checkout, because its directories stay writable. The
  card says never to write there.
- A hand-back's or release's removal that does not finish within its 2-second budget waits in the
  trash without a note; the next `mp pm next` or `mp pm clean` finishes it.
- `mp pm finish` derives the delivery id from the mission, the outputs, the words and `--message`. A
  delivery ref that exists and points elsewhere makes every retry hit the same id: deliver again
  with `mp pm deliver --op <new id>`, then `mp pm land` and `mp pm close` (WI-20).
- A constraint added again with the same text, a changed scope and new words records no words on the
  event. Withdraw it and add it under a new id.
- `mp pm next` runs `git worktree list` once per ended Constructor dispatch whose worktree it
  tidies.
- The other known issues of 4.1.1 still apply.

## [4.1.1] - 2026-10-16

4.1.1 takes in the field's stacked PRs #8–#15, revised per the maintainer's seven rulings of
2026-10-13 (design contract U-15 to U-21). It also fixes five serious problems that the review of
those PRs found in 4.1.0, and the field findings B1, B2, B3, B6, B8, B10 and B11. No proof rule is
relaxed. Read the upgrade notes before you upgrade a project with work in flight.

### Upgrade notes
- **Let running Constructors hand back first** (see the fourth point).
- **A new environment identity.** The environment identity now includes the run method (v2: a
  run's checkout is a git repository of its own at the candidate). The first `mp` command after the
  upgrade that makes a decision (for example `mp pm next`) therefore records a new identity, even on
  the same machine with the same tools. Products whose proof rests on declared runs become "not
  fully proven": in stable mode the work that depends on them waits.
- **Run `mp pm renew` once** (`mp pm next` offers it). Each affected candidate's verification group
  runs once more, in its recorded order, in one checkout: expect about one suite run per affected
  candidate. A group whose run is executing in another process is skipped and offered again. Equal
  results restore the proof mechanically, without a seat. Different results go to a Reviewer, which
  `mp pm next` then lists; this includes a check that passed vacuously in 4.1.0's checkout (a scan
  of tracked files that found none) and now fails. A judgment that cites a sampling run or a timing
  field needs a Reviewer, as before. Nothing is removed or revoked: old runs, judgments and events
  stay in the memory.
- **Dependent attempts recorded before pins existed restart.** An attempt of a task with
  dependencies that 4.1.0 dispatched, and that is not yet accepted, has no record of the dependency
  versions its start was built from. On the first pass it restarts at a new attempt on a pinned
  start, carrying the task's latest recorded product, and is verified and reviewed again (notice
  `legacy-prerequisites-restarted`). If its Constructor is still running, the seat may finish, but
  its hand-back is kept as history and not used (a notice under WI-23): its unsaved work is lost.
- **An accepted product whose start lacks a recorded prerequisite is rebuilt once.** An accepted
  product without a dispatch pin is checked once: its start must hold the content of the
  prerequisites it records (in 4.1.0 a product built on one version of a dependency could record a
  later one). A product whose start lacks that content, or that rests on such a product, leaves
  current acceptance and gets one carried rebuild: a Constructor attempt that carries its work onto
  a pinned start, the declared runs and a Reviewer (notice `legacy-prerequisites-restarted`, naming
  the missing paths). Products whose start holds the content are not touched. If git cannot read a
  start, its acceptance waits with the notice `legacy-prerequisites-unavailable` until it can.
- **Closing uses the same accepted-start check.** `--mode full` is refused while an accepted
  start lacks a prerequisite or cannot be read; `with-risk` and `post-audit` list the risk. Follow
  `mp pm next` for the carried rebuild, or restore unreadable local objects and retry. Missions
  closed before the upgrade rebuild only after `mp pm mission open`.
- **A Secretary decision on a 4.1.0 card gets a fresh round.** Those cards kept no versions of
  their inputs, so an unapplied decision requires one more Secretary step, even if nothing changed.
- **Labels read as recomputing until the next writes check the stored judgments once.**
  The check runs in bounded batches; `mp pm drain` finishes them at once. Proof decisions wait
  until it finishes. Opening does no label upgrade, and stops never run it.
- **If you ran the field's PR stack:** carried re-binds stay as history; their program judgments
  no longer count. The next `mp` writes remove them in bounded batches (`mp pm drain` at once);
  until then labels read as recomputing and proof decisions wait. Stable mode re-binds for a Reviewer, fast
  mode notifies, and dependents follow the seat's accepted successor. Stack deliveries land as
  recorded: re-prepare any that rested on a layered or projected proof. No other stack record is
  re-checked.
- **Use git 2.53 or later.** Older git can leave a copied folder's worktrees pointing at the
  original repository. 4.1.1 detects this and holds git writes (WI-31), but do not copy or move a
  project folder to continue the work with older git.
- **No proof rule is relaxed.**

### Fixed
- A declared verification run executes once per candidate. While a declared run was executing and
  not yet recorded, any other `mp` process that advanced the flow (a seat's hand-back, a PM write
  command, `mp pm next`) found no run to reuse, started another execution of the same run on the
  same candidate in its own checkout, and waited for it, so those commands hung for the run's whole
  duration. Now every declared command takes a process lock per reuse key (candidate, command,
  working directory, environment identity, run method) under `.mission-pipeline/locks/runs/`,
  without waiting, also in a group that has sampled or network commands; the operating system
  releases the lock if its holder dies. A process that finds a key busy runs and records nothing:
  its flow step waits and reuses the run once it is recorded, a hand-back says that its runs are
  executing in another process, and `mp pm renew` lists the run as skipped. Sampling runs
  (`mp seat <id> rerun`, experiments) still execute every time. From field PR #8, revised per
  maintainer ruling 5.
- A partly reusable verification group records each run once. When some commands of a group had a
  reusable run and others did not, the whole group ran and the reusable commands got a second
  evidence record. Now the commands still run in order in one checkout, since a later command may
  need an earlier one's setup (an install step), but a reusable command runs only as setup: its
  recorded run stays the one in force, and only the commands without one are recorded. A setup
  command that fails is reported in the hand-back's notes and the run summary, not recorded as
  evidence, and the later commands still run. A group whose commands are all reusable executes
  nothing. From the review of field PR #8.
- A run's clean checkout is a git repository at the candidate. The checkout under
  `.mission-pipeline/tmp/` had no `.git` of its own, so a declared command that asked git a question
  was answered by the enclosing project, where the whole checkout is an excluded path: `git
  ls-files` listed nothing, `git log` and `git diff <base>` showed the enclosing branch, and linters
  that honour git's ignore rules found no files. Such checks failed for every candidate, or passed
  vacuously after scanning nothing. Verification runs, `mp seat <id> rerun`, `mp pm renew` and the
  closing checks of `mp pm deliver` now run in a checkout with its own `.git`: HEAD detached at the
  candidate, an index of its tree refreshed against the files, the project's objects borrowed
  through `objects/info/alternates` (and its shallow list), and the transform settings the files
  were written under. Nothing is registered or written in the project's repository, no object is
  fetched, and the `.git` is removed with the checkout. `mp` runs no hook while it builds this
  repository, or the scratch repository a delivery uses, including hooks set by a global
  `core.hooksPath`; the declared commands then run with the project's own hook configuration. LFS
  files stay clean through the engine's built-in pointer conversion, with no project LFS program.
  `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_SHALLOW_FILE` and the other variables that would point git at
  another repository or history no longer reach the commands. `git status` of an untouched checkout
  is empty, except for text blobs stored without the normalization their attributes ask for and
  files under filters 4.1 does not support (engine README). Closing checks run outside reuse and the
  run lock. `mp seat <id> checkout` is unchanged. From field PR #9, revised per maintainer ruling 4.
- Runs recorded by 4.1.0 are no longer reused as they are. A run executed in 4.1.0's plain
  checkout, where a check that reads git could pass vacuously, was reused for the same candidate and
  command and kept passing. Declared runs now record run method v2, and reuse requires it. The
  method is also part of the environment identity, so proof resting on older runs needs one
  `mp pm renew` (see the upgrade notes). Old runs and judgments stay recorded and are not revoked.
- `mp pm renew` reruns a verification group as it ran. It reran each cited command alone, so a group
  such as an install followed by a test failed at the test; the false failure went to a Reviewer,
  and a later verification reused it. Now each affected candidate's original group runs in recorded
  order in one checkout, including setup commands no judgment cites, and every renewal of the group
  is recorded in one write. `mp pm renew` can also be run again safely: a judgment recorded after a
  first renewal is renewed by the next one instead of failing with an operation conflict; returning
  to an earlier environment (A, then B, then A again) runs the affected commands afresh instead of
  reporting a renewal that left the label unproven; a judgment is reported renewed only when its
  proof now uses the new run; and several refusals on one judgment raise one Reviewer request
  instead of an operation conflict on every later renew.
- A copied folder no longer writes into the original repository on older git. After a copy or a
  move, `mp` ran `git worktree repair` and took exit code 0 as success. On git older than 2.53 (seen
  with 2.43) a worktree could still point at the original folder's git directory while git writes
  were allowed again, so a new candidate could be written into the original project. Now `mp` checks
  each copied worktree's links in both directions (its `.git` file, the admin directory's `gitdir`,
  `commondir`, and `git worktree list`) without touching HEAD, the index or uncommitted files. It
  rewrites the two link files directly when they are wrong, and checks again. If they are still
  wrong, git writes stay held and the move stays pending, with a notice under WI-31, and
  `mp pm confirm-copy` is refused until the links are fixed. A registered worktree whose directory
  is missing from the copy (git's "prunable") is skipped and reported.
- An attempt's prerequisites are the versions it was built on. They were read when the attempt
  handed back: when a dependency was accepted again while the attempt was queued or running, the
  product was recorded as resting on the newer version although its candidate and runs came from
  the older one, and it could be proven and delivered with it. Now the dispatch records the exact
  product versions that compose the attempt's start, with their prerequisite closure, and these are
  the product's prerequisites. A newer dependency needs a new attempt and a new verification. A
  delivery reports a version whose start lacks a recorded prerequisite as `start-lacks-prerequisite`.
  For attempts recorded before 4.1.1, see the upgrade notes.
- A product accepted after a rework brings every attempt's change. A rework continues in a worktree
  at the previous attempt's candidate, but a dependent task's snapshot and a delivery took a product
  version's change against its commit's parent, which after a rework is the previous attempt. A
  dependent task's snapshot then reported a conflict on every path the last attempt changed after an
  earlier attempt had, so the dependent never got its card, and a path only an earlier attempt
  changed was left out. A product version now records its origin, the snapshot its own change is
  taken against: inherited while an attempt continues, replaced when the work is carried onto a new
  start. Versions recorded by 4.1.0 derive their origin from their predecessors, so nothing runs
  again, and a waiting dependent gets its card on the next pass. A path the target branch changed
  differently since the work began is still a conflict. Reviewer cards built from now on list the
  changed paths recomputed from the origin; old events keep their recorded lists. From field PR #10.
- A later attempt of a task starts from its dependencies' current work. A rework started its
  Constructor worktree from the previous attempt's candidate, so when a dependency had been
  accepted again at a newer version, or a re-plan had added one, the worktree and the declared runs
  never held the new dependency products, and the task could not pass review on its own runs. Now,
  when the snapshot a first attempt would get now differs from the one the previous version's work
  started from, the attempt starts from that snapshot with the previous version's whole change laid
  over it (three-way), and its product records that snapshot as its origin. When nothing changed,
  the attempt continues from the previous candidate as before. A carried change that conflicts with
  the new snapshot builds nothing: the attempt waits with the notice `rework-start-conflict`, which
  names the paths, and is tried again on every pass. A re-plan that changes the task's card starts
  its next attempt from the dependencies' current work without the earlier change; the previous
  candidate stays readable at its commit. The carried work is the latest product recorded under the
  current card, at the version its last Reviewer judged, even when attempts in between were
  cancelled before they produced anything (such an attempt used to start empty; field finding B6).
  From field PR #15, revised per maintainer ruling 6.
- Product versions stacked on each other compose. A dependent task's work starts from a snapshot
  that holds its dependencies' products, and the plan lets it write what a task it depends on
  writes; but a snapshot of several products (a later task's, an Auditor's) and a delivery
  candidate laid the versions in id order and compared each one's "started from" side with the base
  itself, so every path that a dependent and the version under it both changed was reported as a
  conflict: a task depending on both never got its card, and an integration task or a delivery of
  the chain could not be built. Now each version is laid after the versions it rests on, and is
  compared with the base as the versions before it left it; a conflict names the version that put
  the other entry there (`by`). A path the base or an unrelated version changed differently from
  what a version started from is still a conflict, now also between two unrelated versions in a
  snapshot, where the later used to replace the earlier silently. Snapshots lay the whole
  prerequisite closure, proof units included: a task that depends on B, which rests on A, also gets
  A (A's files used to be missing, or to conflict; field finding B9). From field PR #14, revised per
  maintainer ruling 2.
- Delivery proof stays on the final delivered tree when versions are stacked. The delivery manifest
  refused two versions that share a path or a module even when one rests on the other. Now, when one
  is stacked on the other (the top version's candidate was built on a start that held the lower
  version), the top version delivers the shared path: its identity covers that path on the final
  tree, and its Reviewer judged the integrated content. The lower version's identity covers its
  other paths, on the final tree. If the top version is not proven, the shared path is not proven;
  there is no fallback. The delivery report names each such handover. Versions that share a path or
  a module and are not stacked are refused, as in 4.1.0. The field PR's layered or projected proof
  tree is not used: it listed a change and its reversal as both proven (maintainer ruling 2).
- A mission can run a second round after its delivery has landed. Once a delivery was on the target
  branch, laying an earlier delivered version again over a base that held a later change of the same
  file was a conflict: every new task depending on a delivered task was refused its card on every
  pass, and the next delivery conflicted the same way. Now a version counts as already laid when a
  completed landing whose delivery contained it (or a later version of the same task, or its
  unchanged re-bound successor) is an ancestor of the base, checked with the local git without
  fetching; such a version is not laid again. Its proof is still its own, and the new delivery is
  checked on its final tree as usual (field finding B10).
- A PM plan in effect can be checked again in place. The calibrator-1 contract of a PM plan version
  binds the mission's whole requirement set (v51 §3.3), so a requirement item added, revised or
  withdrawn after the plan took effect makes its pass not current, and with it every detailed plan of
  that version and every product accepted under them; stable mode then releases nothing and takes in
  no result of work in flight. The flow only ever judged a plan before it took effect, and every
  batch minted a new version, which cannot restore the products accepted under the old one. Now
  `mp pm plan submit` of the plan document in effect, unchanged, with the batch's words and changed
  items, records a re-check of that version (`b<n>.c<m>`, no new version, no Architect): Calibrator ①
  judges the same version again as a continuation of its deciding pass. Its card shows the old and
  new text of revised items and the content of withdrawn ones, and its focus is the elements resting
  on the changed items, or the whole plan when a change cannot be mapped. A pass counts only when it
  is the current deciding judgment in force: a basis changed during the review reruns it, and a
  negation stays until a valid ruling revokes it. A late hand-back of an older re-check is recorded
  and not accepted. A pass makes the plan current again, and with it what relies on the plan only
  through it; a product bound directly to a revised item, evidence or constraint stays unproven
  until its own review is current. A batch is identified with its mode, its dependent items and the
  requirement-set version, so a change of mode only, or a second revision with the same words, is a
  new batch. In fast mode, production that rests on contested or negated elements waits until they
  are revised or validly ruled; other production goes on. From field PR #11, revised per maintainer
  ruling 3.
- An Architect revision sees the detailed plan it revises. A revision card carried the previous
  detailed plan in its data but showed only the task ids, and the seat had no command that read the
  plan, while it was told to revise it. It rebuilt the plan and rewrote cards, so once such a plan
  took effect every accepted task was restarted. Now the card gives the previous plan in full as a
  must-read material (`plan-old`), one task per line in the hand-back's own fields, so a kept task is
  copied, not retyped. The card and the Architect's role page advise carrying every task the
  revision does not need to change over exactly, since a changed card restarts the task. A new PM
  plan version's instruction names the elements added, changed and removed. The PM is told before
  the plan's reviews when a revision changes or drops tasks with accepted work or work under way
  (`plan-revision-restarts-work`); the notice is sent on a later pass if sending failed, also for a
  plan checked before the upgrade. Earlier records stay in the memory. From field PR #13; its rules
  for the seat are guidance until ruled (maintainer ruling 7).
- A task waiting for its own re-plan resumes only under the plan that answers it. Any newer plan in
  effect released the wait, so the task restarted under its old card before its own re-plan was
  routed. Now the wait is bound to the Architect attempt that answers the request, or a revision
  descended from it; an unrelated plan does not release it. If that attempt is superseded before it
  answers, the request is routed into the current batch again.
- A seat's card is completed when it is dispatched. A card was built when its step was queued, so a
  seat dispatched later missed the decisions, Secretary answers, authorizations and constraints
  recorded in between, and judged against superseded inputs; a Secretary decision could be carried
  out under an authorization withdrawn meanwhile. Now `mp pm dispatch` re-selects the card's
  decision quotes, authorizations, constraints and (for the Secretary) the escalation's current
  facts with the same rules its builder uses, and the hand-back is checked against the card that was
  dispatched. When a planning step's bound inputs changed, the dispatch is refused with `NOT_READY`
  and `mp pm next` rebuilds the step; an Auditor card is regenerated with its current bases and
  constraints. A Constructor whose card the plan in effect no longer holds is refused as
  superseded, and in fast mode one whose production rests on a contested element waits until it is
  ruled. Before a Secretary decision is carried out, the authorization and the
  decisions it relied on are checked again; if one changed, the decision is not carried out and a
  fresh Secretary round is queued. Exploration cards keep their definition's inputs, and blind
  seats never receive project decisions (field finding B1).
- Instruction constraints reach the Reviewer and the Secretary. A PM ruling recorded as an
  instruction constraint was shown only to Constructors, never to the seat judging the work.
  Reviewer and Secretary cards now show the instruction constraints that apply to the task (by task
  type or path), marked as instructions and not as proof inputs. Object constraints keep their proof
  role (field finding B2).
- Decisions recorded after the plan reach seat cards. Cards quoted only the decision items that the
  task in the detailed plan listed. Now they also quote the mission's decisions in force that the
  task's requirement items or constraints relate to, and every decision recorded after the plan the
  card works under, marked "recorded after the plan". Withdrawn or replaced items are never quoted
  as current (field finding B8).
- An object constraint no longer stops a plan, a legalization or an exploration for good.
  Calibrator ①, the feasibility review and Calibrator ② bound no constraints, so any object
  constraint that applied to a plan (with the default scope `**`, every one) left the PM plan and
  the detailed plan not fully proven, with an empty queue and no notice, and stable production
  stopped. For the same reason a legalization ended "not legalized" (WI-25), and an attacked
  exploration version was never proven. Now these reviews, the chain Auditor, and the attack-mode
  Crititor and Stabilizer show and bind the object constraints that apply to their object, chosen
  by the object's own mission and scope; a constraint recorded while such a review is still queued
  is taken into its card before it is dispatched. A constraint that arrives while a plan review runs, or after the plans are
  proven, is a known issue (WI-34, below).
- A PM plan that relies on a withdrawn requirement line goes back to the PM. Calibrator ① reruns of
  such a plan went stale one after another, and the PM was never told why. Now its queued
  Calibrator ① steps are cancelled, no rerun is queued, and the PM is told that the plan relies on
  the withdrawn line and needs a new plan version.
- Products accepted under a PM plan version that no longer holds are re-bound to the plan in effect,
  and a Reviewer judges them. A product's Reviewer contract relies on the detailed plan in effect
  when the product was recorded, fixed with the version (v51 §5.2), so once that plan lost its proof
  no judgment of the product could make it proven again. A new PM plan version did not help: a task
  whose card its detailed plan keeps got no new spec and was never judged again, so its product
  stayed "not fully proven" for good, and stable mode held everything depending on it without a
  word. Now, once the new detailed plan is in effect and proven, such a product gets a new version
  of the same candidate (`<product>.b<n>`: same content, commit and origin) whose contract relies on
  the plan in effect and whose prerequisites are its dependencies' current closure. In stable mode a
  Reviewer judges it with the current card, reusing the recorded declared runs (notice
  `kept-products-rebind-review`). It is accepted only when the Reviewer passes it; a rework sends
  the task to its Constructor with that version as predecessor; the work that depends on it waits.
  The program never passes a re-bound version by itself: the field PR's mechanical carry-over is
  removed. In fast mode nothing is re-bound: the PM is told once per product and plan
  (`kept-product-not-rebound`), the product stays "not fully proven" and dependent work goes on. A
  product whose prerequisites differ from its dependencies' accepted closure (a dependency was
  rebuilt rather than re-bound) is not re-bound; the notice names the stale and missing versions,
  and a re-plan that changes its card rebuilds it. A Reviewer's judgment now relies on the plan its
  product's contract names. From field PR #12, revised per maintainer ruling 1.
- A Reviewer must answer every issue already observed in the task's lineage. A finding recorded by a
  review that went to the Secretary was missing from the next round's card, and a pass that left it
  unanswered was accepted. Now every Reviewer card lists each issue observed on any version of the
  lineage (earlier attempts, earlier rounds on the same version, re-bound versions), with the latest
  response as context, and a hand-back that leaves one unanswered is refused.
- A Reviewer can answer an open issue "deferred". The hand-back schema had no owner for a deferral,
  so a deferred answer failed as a program internal error (WI-20), and Reviewers fell back to
  "not-fixed", which the next Constructor read as its own to fix. Now a `deferred` answer names an
  `owner` and gives a non-empty reason. Later Constructor cards show the issue as "deferred to
  <owner>", outside the task's fix list; every later Reviewer answers it again, and repeating the
  deferral does not force a rework; the PM is told (`reviewer-issue-deferred`). The issue stays
  unfixed, and a close lists it (field finding B3).
- Steps the flow will not continue leave the queue for good. When a seat of a superseded attempt (an
  old card, a dropped or abandoned task, a superseded re-bind) was released with `--ended` or
  `--abandoned`, its step went back to the queue and stayed there: `mp pm next` listed it, a
  dispatch wasted a seat run, and a full close was refused for an unfinished item. Now such steps
  are cancelled on every pass, also in a closed mission. Running seats still finish; their results
  are recorded and not continued (WI-23).

### Changed
- `mp pm close` lists as risks the issues of each selected product version whose state is not
  fixed: "not fixed", or "deferred to <owner>" with the reason. It adds no refusal to close.
- `mp pm constraint add` needs no mission argument: a constraint is project-wide unless
  `--mission <m>` scopes it. The 4.1.0 form, with the mission as the first argument, still works and
  still records a project-wide constraint.
- The design contract (v06) records the maintainer's rulings on the field PRs and the 4.1.1 design
  calls as U-15 to U-23. Mechanics the rulings do not cover are marked "Proposal, pending ruling".

### Added
- `mp pm constraint withdraw <id> --words W-<n>`: the constraint's record is kept, and its line is
  no longer in force. Proof requirements follow through the labels; nothing that did not rely on it
  is reopened. A withdrawn id stays withdrawn: record a replacement under a new id.
  `mp pm constraint add --mission <m>` scopes a constraint to one mission; whether a constraint
  applies is decided by each object's own mission (field finding B11).
- WI-34 and its notice `plan-constraint-gap` (see Known issues).

### Known issues
- A plan's proof can fall short of an object constraint recorded later (WI-34). When an object
  constraint that applies to a plan is recorded while one of the plan's reviews runs, or after the
  plans are proven, the plan's current pass judgments do not cover it: the plan is not fully proven,
  and stable production waits. `mp` sends the PM a WI-34 notice naming the plan, the uncovered
  constraint lines and the review positions. There are two exits, both started by the PM with the
  user's words: resubmit the same PM plan (a Calibrator ① re-check) for a gap on the PM plan, or
  submit an agreed changed PM plan for a gap on the detailed plan's feasibility or Calibrator ②
  position. Nothing is started automatically and nothing is relaxed; fast mode goes on, with the
  plan shown "not fully proven". A ruling on whether the program may start a plan re-review by
  itself is on the 4.1.2 agenda.
- Records written before 4.1.1 list only the paths present in a candidate. A stacked version that
  deleted a file inside the write scope of the version below it is therefore not seen as delivering
  that deletion: each version resting on it can be restarted once for a "missing" path, and a
  delivery holding both shows the lower version not fully proven until a card change re-records the
  deleting task.
- `mp pm next` still lists a step that `mp pm dispatch` refuses with `NOT_READY` (a superseded or
  contested Constructor, a planning step whose inputs changed). Run `mp pm next` again and dispatch
  what it then lists; a Constructor waiting for a ruling stays listed until the dispute is ruled.
- Stable mode checks a task's dependencies when its Constructor step is queued, not when it is
  dispatched (as in 4.1.0): a step queued before a dependency lost its proof can still be dispatched.
  Its result is never shown as proven while the dependency is not.
- A constraint that arrives while an exploration's Crititor or Stabilizer runs, or after the
  exploration settled, is not bound to that judgment. A settled conclusion that loses its proof is
  reported with `exploration-conclusion-unproven`; the way out is a new exploration or a re-plan,
  not WI-34's exits.
- A declared command that hangs and ignores SIGTERM keeps its `mp` process, and with it the run lock,
  past the timeout; other processes record that run as pending. End that `mp` process: the lock is
  released with it.
- `kept-product-not-rebound` notices do not close. While a dependency's re-bind is sent back to
  rework, a dependent can get one notice for the interim set of versions and another for the final
  one.

## [4.1.0] — 2026-10-11

Mission Pipeline becomes three parts and nothing else: an objective project memory, role
descriptions, and a process, read and written only through the `mp` command line. Any harness
that can run a shell command can be the PM or fill a seat, with any model. The design contract is
`docs/design/DesignDoc_MissionPipeline_4.1_2026-10-10_v06.md`. 4.1 does not read 4.0.x ledgers.

### Added
- A neutral memory in the project folder, `.mission-pipeline/`: `memory.db` (SQLite, journal
  mode DELETE) is the skeleton (the run chain, states, links between versions, program check
  results, counts, an append-only hash-chained event log); Markdown files are the leaves (your
  words as `W-<n>` entries, requirements with their quotes, decisions, plans, each seat's card and
  report, run summaries, deliveries). Copy the folder to another machine, OS or harness and
  continue; the first `mp` command in a copy repairs the worktrees, verifies the event chain,
  rebuilds the state and checks every leaf and commit it names (WI-29, WI-30, WI-31).
- `mp init`: creates the folder and its memory, copies the role descriptions and the PM handbook
  with its work instructions, writes `config.json`, adds `.mission-pipeline/` to
  `.git/info/exclude`, optionally adds one pointer line to `CLAUDE.md` / `AGENTS.md`.
  `mp docs update`, `mp config`, `mp recompute`.
- The command groups: `mp pm …` (the PM: `session`, `say`, `next`, `dispatch`, `release`, `renew`,
  `drain`, `stop`, the alignment, delivery and landing commands), `mp seat <dispatch> …` (a seat:
  `card`, `read`, `checkout`, `rerun`, `handback`, `request-evidence`), `mp read …` (`status`,
  `show`, `leaf`, and the tree reads `why`, `from`, `chain`, `tree`). Text by default, `--json`
  for programs; every `mp pm` command carries an operation id and is attributed to the PM
  session's filler.
- A seat hands back with one document on stdin: `mp seat <id> handback --stdin` (the report, ending with
  the structured fields as a fenced json block; `mp` files both), so a harness whose sub-agents may not
  write files can fill any seat; `request-evidence --stdin` likewise. The two-file form stays.
- The read-depth rule: `mp read status` gives layer 0 (with the count of blocked subtasks) plus the layer-1
  entries of only the subtasks whose state changed since the user last asked; `mp read blocked` lists
  every blocked subtask with its reason and next step; `mp read show` is layer 2, `mp read leaf` layer 3.
- `mp pm plan template <mission>`: an annotated, valid PM plan skeleton prefilled with the mission's
  requirement items; `mp help <group> <command>` prints one command's arguments.
- The PM dispatches: `mp pm next` lists the ready steps, `mp pm dispatch` claims one and prints a
  fixed prompt for a sub-agent of the PM's own harness; `mp pm release --ended|--abandoned` for a
  seat that ended without handing back (WI-28).
- Any harness and model per seat; the filler is recorded as information and never invalidates a
  conclusion.
- The Stabilizer in the exploration loop: after every attack round it judges each finding (in
  scope, shifts direction, out of scope) and the round (on track, drifting); direction questions
  and drift go to the Secretary (WI-33).
- A Constructor works in its own git worktree; at hand-back `mp` collects every change git does
  not ignore as the candidate commit and runs the declared verification on a clean checkout of it.
- Stored proof labels with bounded propagation (`mp pm drain`, WI-32); an environment identity per
  run, and `mp pm renew` to restore proof after an environment change without a seat.
- Landing fast-forwards the target branch from the recorded base only, with an intent recorded
  before git runs and checked by any later command (WI-06); `mp pm land --close-not-landed`.
- `mp` runs on Linux, Windows and macOS with Node 22.12+ (`npm install -g .` in `engine/`). Only Linux
  (WSL2) has been run so far; Windows and macOS use the same code but have not been through the
  scenario suites yet.
- New work instructions WI-28 to WI-33.

### Changed
- The Claude Code plugin is an optional adapter: it records each prompt with `mp pm say` and
  prints the handbook core and `mp pm next` at session start. Nothing requires it.
- The PM handbook, the work instructions and the role descriptions are harness-neutral and are
  copied into each project.
- Commands that cite your words name a words entry: `--words W-<n>`.
- A decision takes effect in one write: the ruling that revokes a negation is written only together with
  the record that the decision was carried out. A Secretary decision you override before it is carried
  out leaves no ruling (WI-24).
- When work leaves the plan (a re-plan drops a task or changes its card, a newer PM plan is submitted, an
  exploration settles or is redefined, a legalization ends), its open escalations are closed in the same
  write and their Secretary steps are cancelled. A late hand-back on a closed escalation is kept as
  history and not accepted. An answer to an escalation already carried out or closed is refused.
- An exploration can settle more than once. A move to another machine, or a changed tool version, re-runs
  the experiments its conclusion rests on, and any stop after that reopening goes to the Secretary like a
  first stop. While proof labels recompute, the decision layer and legalization wait instead of
  recording "no conclusion" or "not legalized".
- A requirement line that was withdrawn cannot be added again under the same id (add it under a new id).
  A task given up under one card runs again when a newer plan changes its card.

### Removed
- The ledger service, the evaluator process, the scheduler, the watchdog, systemd units and the
  control plane: each `mp` command opens the memory itself.
- The seat host on the Claude Agent SDK, its in-process tools, the metering proxy, spend limits and
  quota waits, credential handling, model configuration and the startup self-check.
- The bubblewrap sandbox, cgroups, fuse2fs areas, toolchain freezing and environment copies.
- `mp install`, `mp watch-notices`, `mp resume`; the work instructions about sandboxes, budgets,
  services and storage faults (WI-09 to WI-12, WI-14, WI-15, WI-17, WI-18, WI-22, WI-27).

## [4.0.1] — 2026-10-10

### Added
- Seats run on any Claude model the login can use; Codex or an OpenAI account is not needed.
  A seat model is a Claude model id, a dated snapshot (`claude-sonnet-4-5-20250929`), a
  suffixed variant (`-v1`, `[1m]`, `@20250805`), or an alias Claude Code accepts (`opus`,
  `sonnet`, `haiku`, `fable`). The default stays `claude-opus-5-5` at effort `high`.
- `mp install --model <id|alias> [--effort <level>]` puts every seat on one model. On a
  reinstall it rewrites every seat's model in the existing `model_config.json`. An id that is
  not a Claude model is refused before anything is written.
- `mp model-config set all ...` changes every seat at once.
- WI-09 also covers a seat's model that is not available to the login (retired, or not in its
  plan). The attempt still ends as an environment failure, and the PM gets a
  `model-unavailable` notice that names the seat, its model and Claude Code's message, with the
  fix: `mp model-config set <seat>|all --model ...`.
- A seat's outcome lists the models that served it (Claude Code may redirect a retired model
  to the current model of its family); `mp show task` prints "configured X, served Y" when
  they differ.

### Changed
- Prices for the older Claude models Claude Code still knows (Claude 3 to Claude 4.5, Mythos 5)
  are in the default price table. A model the table does not list is priced at the highest
  price of its family (or of the whole table), so the metering over-counts rather than refusing
  the request. Before, a request for an unlisted model ended the seat. Requests for a model that
  is not a Claude model are still refused.
- `mp model-config set` refuses a seat name that is not a seat (before, a typo was written to
  the file and never read).

## [4.0.0] — 2026-10-10

A new engine in `engine/` (TypeScript, Node 22.12+). It replaces the 3.x plugin under the
same name, `mission-pipeline`. The design contract is
`docs/design/DesignDoc_SeatsLedgerRuntime_4.0_2026-10-08_v51.md`.

### Added
- One on-screen PM. Every user message is booked in the ledger by the PM session's prompt
  hook; requirement items point to their source in the user's words. Only important design
  decisions (what the user gets, hard-to-undo choices, conflicts with the user's words) go
  to the user.
- Seats as separate Claude Code processes with only the program's typed tools, in a
  bubblewrap sandbox without network by default, under delegated cgroups. Seats start only
  after the startup self-check passes for the installed versions.
- A single ledger service as the only writer, a separate evaluator for the derived state
  (proven, not fully proven, negated), a scheduler and a watchdog. The engine starts when
  the PM session opens, not at boot.
- Stops from the prompt hook or `mp stop`: written to two pre-allocated inboxes and
  signalled to running units within 2 seconds, even while the ledger is down. Each stop
  shows its state (persisted, committed, stopped) and can be narrowed or released.
- Stop scope: one related mission (named in the user's words, or the only one open or with
  work) means that mission. If it is unclear, or the ledger doesn't answer in time, the stop
  covers everything.
- After a reboot, stops are committed first; the engine then goes on or pauses for the
  user's answer, from the inboxes' evidence (WI-12).
- Delivery and landing: a delivery ref under `refs/mission-pipeline/`, landed onto the
  target branch in a controlled git view (repository hooks off, fixed configuration, no
  reset or forced checkout, nothing deleted).
- Work instructions WI-01 to WI-27 for the PM: each exception stops only the affected
  action and arrives as a notice naming its WI, the trigger and the default action taken.
  The PM keeps only the WI index in context and opens a page when a notice names it.
- `mp`, the PM's command group: `install`, `status`, `show`, `alerts`, `watch-notices`,
  `stop`, `stop-narrow`, `stop-release`, `resume`, `recovery-check`, `deliver`, `land`,
  `withdraw-delivery`, `detach-duplicate`, `close`, `requirement`, `constraint`, `plan`,
  `answer`, `mission`, `legalize`, `retry-evaluator`, `retry-service`, `grant`,
  `model-config`, `ops` (`spend-limit` is reserved; money limits are not available yet). Text output by default, `--json` for machines;
  state-changing commands carry an operation id and are recorded in the ledger.
- `mp install` checks the platform (Node, git 2.44+, the systemd user instance, cgroup v2
  delegation, bubblewrap, the Claude Code login, filesystems, socket path lengths), picks a
  second volume for the backup stop inbox, writes the configuration, starts the engine and
  runs the startup self-check (offline items, then live items under the seat login on the
  cheapest model). `--credentials api-key:<VAR>` is refused in 4.0.
- `mp selfcheck`: the self-check reruns by itself in the background when Claude Code, the SDK
  or Node changes version (at most once an hour per version); seats wait for it, and a failure
  arrives as one WI-18 notice. `mp selfcheck` is the manual retry.
- Toolchain freeze: `mp install` copies the user's Node and Python toolchains (outside the
  system directories) read-only under the engine root, and the sandboxes mount that copy,
  never the live directories. Run `mp install` again after upgrading Node.
- Mission ids: letters, digits and `-`, starting with a letter or digit, at most 64
  characters. No `.`, `_` or spaces. Requirement item and constraint ids follow the same rule.
- Project constraints are project-wide: a constraint, a new text or a scope change recorded
  from any mission applies to every mission's cards by the constraint's own scope (paths,
  task types).

### Compatibility
- 4.0 replaces the 3.x plugin under the same name, `mission-pipeline`. 3.x is no longer in
  the marketplace; it stays available at tag v3.0.0.
- 4.0 does not read 3.x ledgers.
- 4.0 runs seats on Linux and WSL2 only, with the Claude Code subscription login.
- Not landed automatically in 4.0: reftable repositories (no delivery), shallow and partial
  clones, submodule changes, attribute-only changes. Money spend limits are not available
  yet; `unlimited` is.

## [3.0.0] — 2026-09-30

### Added
- Execution/exploration routing per subtask, mixed parent task graphs, priorities,
  accepted-output dependencies, explicit decision edges and future milestones.
- Immutable versioned work receipts, scoped executable review/admission, Architect
  prerequisite readiness, worker claims, parallel scope enforcement and compact
  completion records. Execution uses one independent integrated acceptance, with
  specialist Crititor review conditional on the contract. Exploration keeps its
  full evidence/review/calibration chain.
- PM-issued Secretary delegation with scope, current authority, scheduling range,
  finite action budget and expiry. Secretary can issue reviewed work directly,
  coordinate approved producers and repairs, or escalate decisions to PM.
- Read-only qualified queue and receipt/candidate snapshots. Recorded acceptance
  and current qualification are separate; scheduling metadata is outside contracts.
- Scoped task bundles, compact default packets and report queries, explicit full
  ledger reads, managed product reads and honest local-execution provenance.
- Explicit task dispositions and shared three-cycle lineage budgets across route
  changes/replacements. Final closure still requires the complete mission bundle,
  Auditor/Supervisor reviews, a current closing run and valid closure authority.

### Fixed
- Replacing active work releases its predecessor's write ownership while keeping
  immutable receipt history and the shared lineage cycle budget.
- Exploration acceptance rechecks explicit prerequisites; changed inputs preserve
  recorded acceptance but block current qualification and dependent work.
- Independent execution checks can refresh evidence without changing an identical
  fast-mode product or spending another construction cycle. Acceptance binds the
  latest qualified runs, and a failed independent check blocks it.
- Release archives use the packaged tree's version and refuse mismatched runtime
  metadata or missing receipt workflow files before writing an asset.
- Executable checks must be fully defined before review/admission; full definitions
  and environments are bound, preventing a prelisted id from introducing an
  unreviewed check under an old admission.
- Released legacy close payloads use their actual id shape. Rejected replay
  transactions are disclosed and excluded from semantic overlays, governing
  contracts, calibration history and acceptance credits; original history is kept.
- Git-normalised CRLF conversions remain visible in source identity even when
  Git calls the checkout clean. Native bridge role checks precede path mapping;
  migration regression fixtures support Windows long paths during cleanup.

### Compatibility
- Runtime and installation metadata are 3.0.0; storage remains schema 4. Historical
  tasks retain their policy. Local roles remain self-asserted; the managed model
  transport is still supplied separately.

### Included field repairs

Runtime defects a downstream mission relayed after 2.1.0;
`tests/m24_field_repairs.py` holds one regression test class per fix.

### Fixed
- **A plan re-record keeps every disposition.** `plan.record` kept only an existing
  obligation's `status`, so a deferred or cancelled obligation lost `grant`, `domain`,
  `deferred_owner` and `reason_blob` (and a met one its `evidence`), and `mission.close` then
  failed with an uncaught `KeyError: 'grant'`. The re-record now restates only the PM's text.
  A row already stripped by 2.1.0 refuses `DEFERRAL_INCOMPLETE` at close, naming the
  obligation; submitting the same `obligation.defer` or `obligation.cancel` again repairs it.
- **A task that has not started no longer blocks every bundle.** `bundle.record` refused
  `INPUT_INCOMPLETE` while any task of the mission declared an output without a delivery,
  including a later wave's task not yet admitted, so the bundle an earlier wave's aggregate
  cell needed could not be built. A declared output now needs its snapshot once its task has
  an admission of its current digest or any recorded run, and the refusal names the `task`.
  Because an admission is not in the bundle's delivery digest, `calibration.record` (except
  an INPUT_INCOMPLETE verdict) and `mission.close` recheck the same rule, so a task admitted
  after the bundle is still held to its outputs.
- **A decision naming another domain's task is refused.** `decision.record` accepted `tasks`
  whose domain differed from the decision's, and `decision_applies` then never applied it, so
  the PM held a record that authorized nothing. It now refuses `DECISION_DOMAIN_MISMATCH` with
  the `task`, its `task_domain` and the `decision_domain`, including for the tasks a revision
  inherits. Nothing in the runtime applies a decision across domains.
- **The `work.write` size limit is stated.** A file over 8 MiB was refused `INVALID_INPUT`
  ("exceeds the tool size limit") with the limit written nowhere. The limit is unchanged; it is
  now documented in `runtime-v4.md`, SKILL.md and the Constructor role, and the refusal names
  it and the file's size, with `limit`, `size` and `path` fields.
- **`query task` says whether a task is admitted and accepted.** The stored `status` of a task
  is its record status (`NOT_ADMITTED` until `task.replace` sets `REPLACED`), so the query
  printed `NOT_ADMITTED` for admitted and accepted tasks. The stored rows and the ledger are
  unchanged, and their digests still serve `revises`. A task query now adds a `derived` map
  keyed by task id, with `admission` (ADMITTED, STALE or NOT_ADMITTED) and `admission_id`,
  `acceptance` (ACCEPTED, STALE or NOT_ACCEPTED) and `acceptance_report`, plus a `note` saying
  what the stored status means. Nothing derived is stored.
- **A requirement id is listed once.** `requirement.record` appended its id to
  `task.required_runs` even when the task spec already listed it, leaving rows such as
  `["r-fig", "r-rep", "r-fig", "r-rep"]` and changing the task digest. A listed id is no longer
  appended, so that task row and its digest are unchanged; an unlisted id is appended once, as
  before. `task.record` still stores the list the PM sends, so a row already doubled is repaired
  by the next task revision that lists each id once.

## [2.1.0] — 2026-09-13

The usability release. 2.0.0 shipped an engine that was correct and, in the field, unusable.
Three ordinary `task.record` revisions while a case was open exhausted the rebase budget, and
every one of the nine recovery actions was then refused, so the mission could never close. The
twelve-call correction budget was per mission rather than per case, which made the thirteenth
case terminal. Screening and contest jobs expired after 300 seconds while local subagents
routinely take longer, `job.resume` needed a prior `jobs.expire` and misreported
`BUDGET_EXHAUSTED`, and after two resumes only dismissal remained. A hand-written
`run.begin`/`run.finish` submitted with `--actor controller` was recorded as controlled
execution and closed a mission with no process running. And the manual told nobody how to
operate any of it: 48 lines of SKILL.md, role files of seven to nine lines, no worked example
anywhere, and the only two manual calibration triggers undocumented. No schema change, no new
record shape, and existing 2.0 ledgers keep working. Rationale record:
`docs/design/DesignDoc_UsableRuntime_2.1_2026-09-13_v01.md`.

### Fixed
- **Rebase exhaustion no longer deadlocks a mission.** A third changed-head rebase closes the
  current case with `status: "TARGET_REPLACED"`, releases its barrier, deactivates its permits,
  supersedes any pending contest, and opens a successor case carrying the same mission, lineage,
  scope, target, counterexample, audit stance and repair count, with a fresh screening job.
  `review.rebase` returns `{"case": <new>, "superseded": "<old id>"}`.
- **The correction budget is per case.** `issue.screen` and `contest.decide` charge
  `<case id>:correction` with a cap of twelve. A mission-level `<lineage>:correction_total`
  counter is kept for reporting only and has no cap.
- **Review deadlines match the mode.** `project.configure` stores `review_deadline_seconds`,
  default 86400 local and 300 managed, minimum 60. Every screening, contest, supplement, resume
  and repair-compliance deadline uses it, and the UPHOLD repair window is `max(86400, value)`.
  `job.resume` accepts a PENDING or AWAIT_REPAIR job whose deadline has passed with no prior
  `jobs.expire`, keeps the two-resume cap, and reports `REVIEW_EXPIRED` with a `recovery` text
  when the cap is spent. `issue.screen` and `contest.decide` auto-resume an expired job inside
  the same transaction while a resume remains.
- **Dismissal is contestable and cannot pre-empt a contest.** `case.resolve` refuses
  `CONTEST_PENDING` while a contest is PENDING or INPUT_INCOMPLETE, and refuses
  `SCREENING_REQUIRED` for a DISMISSED outcome on a case with no `screening_author`.
  `case.contest` is open to pm and to every reporting role, on any case that is not replaced
  by a successor (`CASE_NOT_CONTESTABLE`) and not already final (`CONTEST_FINAL`), so a
  screening nobody reached in time can still go to an independent Stabilizer. `case.supplement`
  is also open to the Challenger, whose defence of a calibration accusation is exactly the one
  bounded supplement.
- **`controller` is the executor's internal identity.** The CLI, the field adapter and
  `bridge.serve_one` refuse actor role `controller` with `ROLE_FORBIDDEN`, including through
  `MP_ACTOR`. `runner.execute` and the managed broker still construct it in process, and
  `run.execute` itself is accepted only from a constructor, crititor or stabilizer seat, matching
  the managed role table.
- **A blanket PM decision no longer invalidates accepted work.** A decision that lists no
  `tasks` applies to a task only when that task has no ACCEPTED acceptance, current or
  superseded, created before the decision, so the rule stays stable across later rounds. All
  call sites use the same rule.
- **Files in `write_paths` are inside the product digest.** The calibration basis is task
  outputs plus task write paths plus required-run inputs, deduplicated and order-stable, so a
  helper rewritten after acceptance invalidates the cell that judged it. A write path that
  resolves inside private runtime state is skipped there; `work.write` refuses it anyway.
- **A dead run can be aborted from another session.** `run.abort` by pm or controller is allowed
  when the run is RUNNING and its lease has expired: `EXPIRED`, `satisfied: false`,
  `failure_code: "RUN_LEASE_EXPIRED"`. The owner-session path is unchanged.
- **Reports without a criteria table no longer bypass the check.** `report.record` refuses
  `CRITERIA_TABLE_REQUIRED` for a task with obligations when the document carries no criteria
  rows and the outcome is PASS or ACCEPTED, or COMPLETE with declared `criteria`. A development
  report that claims nothing is still recordable.
- **Closed outcome sets.** `audit.record.outcome` is PASS, FINDINGS or INPUT_INCOMPLETE, with
  PASS requiring zero findings; `close.review.outcome` and `plan.review.outcome` are PASS, FAIL
  or INPUT_INCOMPLETE and only PASS admits; `flag.raise` is limited to pm and the reporting
  roles and requires a root or intake; `mission.close` refuses `AUDIT_OUTCOME_REQUIRED` unless
  the audit outcome is PASS or FINDINGS. `project.configure` refuses `INVALID_REVIEW_DEADLINE`
  for a deadline that is not an integer of at least 60.
- **Plan review coverage reads obligation status.** `MISSING_PRODUCER` applies only to
  obligations still REQUIRED; one already MET (including through `legacy.accept`), deferred or
  cancelled needs no producing task, so a migrated mission plans its delivered and remaining work
  in one plan. The refusal now lists the `missing` obligations.
- **`delivery.record` cannot overwrite exported output.** It refuses `EXPORTED_OUTPUT` when the
  current delivery for that path was produced by a run.
- **Writer identity survives a machine rename.** `environment_id()` hashes the platform family
  and a token from `<config dir>/mission-pipeline/writer-id`, created with random hex on first
  use. The old hostname formula is retained as `legacy_environment_id()` and still accepted, and
  `maintenance recover` rewrites the owner record to the new identity.
- **Per-write cost.** `recover()` verifies only the journal tail past a `verified_seq` watermark
  held in `runtime_meta`; the full replay comparison stays in `doctor` and `rebuild`.
  `source_manifest` identity_version 3 takes git blob ids for clean tracked files and hashes
  only what `git status` reports as changed.

### Added
- **`obligation.cancel`**, pm with a `defer` grant or principal: `{obligation, grant, domain,
  owner, reason_blob}` sets `AUTHORIZED_CANCELLED` with the deferral fields plus `cancelled_by`.
  The status was read in five places and written nowhere.
- **Mid-mission migration continuity.** `adoption_plan` reports `acceptances`: every ACCEPTED
  verdict from a sealed GroupReport with its legacy mission, task key, artifact, sha256 and
  sequence. `legacy.adopt` adopts all VERIFIED overlays of the legacy mission when `artifacts`
  is omitted. New `legacy.accept` (pm) takes `{mission, obligation, legacy_artifact}` and sets
  the obligation MET with `evidence: "legacy:<artifact>"` and `assurance: "legacy-recorded"`;
  `mission.close` accepts such obligations and `bundle.record` includes the adopted overlays.
- **`maintenance takeover --confirm <project id>`**, principal only, claims a ledger whose owner
  environment is unreachable: new environment, epoch plus one, `takeover_from` recorded.
- **`references/walkthrough.md`**: one complete single-task mission through the public CLI,
  every request with its command line and the response fields that matter, then the 1.2 to 2.1
  mid-mission upgrade and the recovery commands.
- **Nine templates**: plan review, close review, issue screening, case resolution, contest
  decision, recovery permit, obligation deferral, obligation cancellation and legacy acceptance,
  with matching `template_catalog.EXAMPLES` entries.

### Changed
- **Honest execution labels.** A local run records `assurance="local-execution"` instead of
  `local-controlled-execution`. Every check that accepted the old label accepts both. The
  documentation states plainly that local execution freezes inputs, captures logs and outputs,
  and does not contain the process.
- **Seal conveniences in local mode.** `mp seal` sets `source_blob` only when the block does not
  name one and always records `document_blob`; validates list sections only for `report.record`;
  fills `contract_scope_digest`, `review_basis`, `admission`, `critique` and `revises` when they
  are absent; marks `reading_assurance="self-asserted"` when it filled a review field; and
  returns the request it submitted as `submitted_request` beside the result. Managed seal
  behaviour is unchanged.
- **Managed mode is documented as experimental.** The sandbox, broker and JSONL protocol are
  implemented and tested, but no model driver ships in this repository. README, SKILL.md,
  setup, substrate and the plugin descriptions say so.
- **The operating manual is back.** SKILL.md carries the cast with each seat's exact actions,
  the lifecycle in order with the request and the seal alternative per step, a refusal table
  with the fix for each code, closure, calibration, the counterexample path, fourteen numbered
  invariants and a plain statement of local versus managed assurance. Every role file states its
  inputs, its exact actions, the refusals it will meet and what it never does.
- **Hygiene.** `scripts/mp` becomes a launcher: `--bridge-stdio`, `MP_COMPAT_V3=1` to
  `legacy_v3.main`, otherwise the v4 CLI. The v3 guard and exit codes move into `legacy_v3.py`.

### Validation
- All 24 entry points (`m1_smoke` through `m23_continuity`, including the new
  `m22_usable_workflow` with 25 cases and `m23_continuity`) pass on Ubuntu WSL with Python
  3.14.4. Part 1 of the walkthrough was executed verbatim through the public CLI: 22 requests
  from `authority.record` to `mission.close`, root CLOSED, doctor clean, every run recorded as
  `local-execution`. The real 421-event 1.2 ledger migrates, adopts its open mission, accepts
  its six delivered obligations through `legacy.accept` and closes under v4 on a copy
  (`m23_continuity`). Measured: per-write cost flat at about 1.3 ms across 600 writes instead of
  growing from 2 ms to 12 ms; `source_manifest` on this repository 1.10 s to 0.51 s. Native
  Windows was not re-run in this release and must be re-run by the maintainer before field
  deployment.
- `tests/m9_migration.py` skips its real-data test with a message when the ignored corpus is
  absent and gains a synthetic fixture test that builds a v3 ledger under `MP_COMPAT_V3=1`,
  migrates it, adopts it, accepts a legacy obligation and closes under v4.
  `tests/m1_acceptance.py` exits 0 with `SKIP` when its corpus is absent, so the public suite
  runs on a clean checkout anywhere.

## [2.0.0] — 2026-09-09

The supervised-engine release. An independent Supervisor checks original intent, PM delegation, task admission and closure. Counterexamples, repair, independent review and current execution evidence now share one bounded workflow.

### Breaking changes
- The normal CLI uses structured requests and journal schema 4. Python 3.12+ and the complete skill directory, including `scripts/mp_runtime/`, are required; copying the old standalone script is insufficient.
- Managed execution requires a trusted JSONL controller and functioning Linux/WSL bubblewrap isolation. Native/local role labels remain self-asserted provenance.
- Legacy ledgers use explicit migration and adoption. Historical approvals remain history until requalified; migration preserves raw evidence and closed missions. Review `migrate --plan` before migration; publishing or installing this release does not migrate a live ledger.

### Added
- Independent Supervisor root/plan/closure review, scoped PM delegation, atomic mandatory-counterexample barriers and automatic independent Auditor contests.
- Current read receipts and bounded review rebasing; persistent independent reviewer lineage supports repair verification after a controller restart.
- Immutable input, output and log evidence; explicit execution predicates, mandatory closure bundles/audits and a supported read-only field adapter.
- Native PowerShell entry, UTF-8 JSON Windows/WSL bridge, persistent root mappings and explicit writer-environment handoff.

### Fixed
- Principal project contracts apply across missions, retain necessary original sources and cannot be weakened by candidate scope, omission or duplicate order. Explicit authorized retirement and delegated PM correction remain usable.
- Calibration and positive reports bind current code, products, runs and authority. Acceptance and consumption bookkeeping do not invalidate their own prerequisites.
- Current required attempts govern reuse and acceptance. New pending or failed attempts cannot borrow old PASS results. Actual timeouts and supported execution errors have durable terminal states, idempotent retrieval and bounded recovery.
- Multi-line acceptance parsing preserves partial outcomes; lifecycle, flags, scoped holds, crash recovery and legacy overlays preserve their distinct semantics.
- Windows/WSL special strings, encoding, CRLF identity, long paths, working directories, SQLite handles, concurrent ownership, interpreter/import origins, dependency repair and environment contamination are covered by actual execution tests.

### Validation
- All 22 test entry points passed on native Windows and Ubuntu WSL, alongside five independent ownership, CLI and 330-character-path probes.
- Independent Constructor/Crititor/Stabilizer review accepted implementation round 4 with no unresolved established blockers. Original runtime archives and historical task state were preserved.

## [1.2.0] — 2026-09-05

The closure-modes release. Two more days of field use (PR #4) found the pipeline
stalled for hours at a mission boundary with nothing blocking on substance: lint
re-checked 1.0.0-sealed documents against the 1.1 contract (163 false findings; the
close refuses on any); the harness's permission classifier blocked `mp mission claim`
and `mp mission close` — the two verbs that read like governance acts — while every
other verb had run for days unprompted; the engine's own text told the harness a human
belongs at the boundary; and the deployment's ratified delegation (its PM closes without
per-mission sign-off, the principal repudiates afterwards) was something the engine could
not read. The deployment's 29-item relay queue added the defect classes below. The
principal's ruling: closure modes, like a harness's permission modes, and a lifecycle
derived from documents like everything else. Rationale record:
`docs/design/DesignDoc_ClosureModes_2026-09-05_v01.md`.

### Added
- **Two closure modes**, declared once by the principal and recorded by the PM on their
  word (`mp config set closure sign-off|auto --quote …`, `mp init --closure …`; every
  declaration is an act in `mp acts`): **sign-off** — the principal accepts each mission
  in person (default, today's behaviour); **auto** — the PM closes when the gate
  conditions hold, the principal is never interrupted for procedure and repudiates item
  by item afterwards; a repudiation (`mp supersede mission:<name> --by principal`)
  reopens the mission. In both modes the substantive stops stay: a DRIFT halt, the
  SUSPICION ratchet, a Charter amendment. `mp config set audit on|off` decides whether a
  sealed Closure Audit is required to close.
- **The lifecycle is derived from documents.** Sealing a Charter v1 claims the mission
  (optional `branch:` / `cap:` header fields); sealing a **MissionClose** note
  (`templates/mission-close.md`) closes it — refused, naming every failing condition at
  once, while a flag is undisposed, the mission's lint has findings, the Charter is
  unsealed, the closing run is missing, drifted, or declared rather than measured, a
  required Closure Audit is absent, or the mode's own section (the principal's verbatim
  acceptance / the live delegating contract) is missing. No lifecycle verb remains for a
  classifier to single out: `mp gate close` is retired, `mp mission claim|close` are
  deprecated aliases.
- **Re-issue reconciliation.** Sealing a new version of a document supersedes every
  record the old version derived (evidence, verdicts, edges, relay) — except flags,
  which are reconciled by text: a matching bullet keeps its id and its disposition, a
  dropped one is retired, new text is a new flag. `- carried: flag:<id>` / `- carried:
  <text>` carries explicitly and never creates a flag. (Field: one 17-item residue list
  re-derived across three versions produced 52 flags and 77 undisposed items; the
  sentence "round 1's flags still stand" became a flag. `tests/m6_reissue.py`: 17 items,
  three versions, 17 flags.)
- **Runs say what they were:** `--result pass|fail|mixed`, `--expect fail` for a
  deliberate fail-before batch (never a passing anchor — a `met` row citing one is
  refused at seal), `--commit <sha>` to bind a run to the commit actually executed
  against when the tree has moved (a declared binding; never accepted as a closing
  run), script-path commands with the script's hash recorded, scope as part of a run's
  identity (a closing record of an identical output is no longer refused), and git's own
  tree id beside the content fingerprint. `mp run list|show`.
- **A full cell's Calibrator seals its accusation list** as a CalibrationVerdict whose
  verdict line begins `pending — Challenger and Arbiter convened`; its evidence and
  relay derive; the Arbiter's version supersedes it. A calibrator-only run is always
  ALIGNED.
- **Schema v3, `mp migrate` (v1 or v2 → v3) and `mp migrate --repair`**: re-stamps
  1.0.0 in-place-amended Charters so doctor stops reporting them, marks adopted
  prose-era artifacts as prose-only for lint, backfills one wave per mission that has
  specs but no wave; a pre-1.1 spec with no `touches-contract` header counts as `yes`
  for triggers. `--repair` is journaled, so doctor and rebuild still agree.
- **Permission note:** `/mission-pipeline:init` may, with the principal's one-sentence
  consent, allow the substrate command in the project's harness settings — the agent
  makes the edit; the principal only says yes or no.
- **Tests:** `tests/m5_closure.py` (both modes end to end, every refusal, a
  repudiation, and no lifecycle command in the journal), `tests/m6_reissue.py`,
  `tests/m7_runs.py`; m3/m4 extended. Eight gates.

### Changed
- **Invariant 9** now reads: *The principal closes the mission — in person (sign-off
  mode), or by standing delegation with item-by-item repudiation (auto mode). The mode
  is the principal's declaration in PROJECT.md; the PM never chooses it. Integration and
  reporting do not close a mission.* Invariant 10's "reaches sign-off" became "closes"
  (wording only). All other invariants are unchanged.
- The MissionClose seal lints its own mission only, and seal-parse only over 1.1+
  seals. Every "live records only" reading is literal: doctor's seal check, lint's
  disk and parse checks, `relay list|export`, worklist's edge scan skip superseded rows;
  superseded flags never count as undisposed.
- Roles and templates carry the modes: the Charter's signature line and the PM's close
  step render per mode; the Auditor's report is what stands in for the principal's
  presence in auto mode; Constructors never probe in a copied tree (an inherited
  virtualenv imports the unpatched source — field relay 13).

### Fixed
- **`mp lint` no longer asks a v1.0.0-sealed document for sections it never had.** The
  `seal-parse` rule re-checks a sealed document against the v1.1 section contract; on a
  migrated ledger every document sealed by the retired `artifact.seal` (a hash, never
  sections) came back as "no longer parses" — 110 findings on one mission, 163 across a
  deployment — and `mp gate close` refuses on any finding, so no mission that began
  before the migration could close mechanically. The rule now binds only documents
  sealed by the v1.1 derivation seal (`artifact.sealed`), read once from the journal;
  a v1.1 document that loses a required section is still caught (`tests/m4_migrate.py`).
- **`mp calib triggers` orders the post-compaction window by artifact id, not by the
  clock.** Seal timestamps have one-second resolution, so a spec sealed in the same
  second as the Integration Note it precedes landed "inside" the note's window and fired
  `post-compaction` — `tests/m3_dryrun.py` failed on main about one run in two. The
  window is now bounded by the closing note's `closed_in` artifact id (the artifact is
  the event), with the timestamp as the fallback for pre-`closed_in` rows.

## [1.1.0] — 2026-09-04

The derivation release. Three days of real use of 1.0.0 (5 missions, 77 tasks, 3296
field journal events, 5.25 MB of ledger prose) measured where the tokens went: **68 % of
all journal events were agents hand-copying facts from documents into the database** —
`evidence add` alone was 1088 calls and 73 % of everything typed into `mp`, and 0 of 8
sampled critiques still agreed with their own evidence rows. Meanwhile the real
invariants fired 0 times, because they were attached to optional ceremony (`round open`
was used on 36 of 76 tasks), the aggregate calibration's trend shape was dead (a metrics
bug dropped 12 of 77 tasks, so the Arbiter rightly refused every trend accusation), and
61 % of flags were about the ledger rather than the product. The defect was
double-entry: truth in two places, with the model as the courier. This release removes
the second entry. Rationale record:
`docs/design/DesignDoc_DerivationAndSupersession_2026-09-04_v01.md`.

### Added
- **`mp seal <path>` — the artifact is the event.** Agents write a document once and
  submit it with one call; the engine parses the `mp:header` block and the document's
  structured sections and derives every record: the artifact, evidence rows (the
  criteria table with its Type column), flags (Out-of-frame risk, Noticed but not
  fixed), verdicts, rounds, edges (`derives-from`), dispositions (an Integration Note's
  flag ledger), relay items, standing contracts (a Charter's prohibitions), wave
  closure. One journal event per artifact carries the full derived payload, so replay
  never re-reads a file. The M3 dry run measures the point: **2.00 journal events per
  artifact** against the field's 10.40, with no declaration verb in the journal.
- **Rules run at seal — the one step nobody can skip.** Refused, by name: a round past
  the cap (invariant 4); a "met" resting only on D/X evidence (invariant 13); an R anchor
  to a run that does not exist; a D anchor to a GroupReport or Integration Note
  (summaries are never roots); a `charter:vN` with no such version; a TaskSpec whose
  wave is not open or whose out-of-scope is empty (invariant 5); a Charter version
  without its amendment row; an Integration Note disposing an unknown flag or leaving a
  disposition empty (invariant 11); an unresolvable `derives-from` or an anchor to an
  unknown id; a missing required section. A refusal names what to change in the
  document; agents fix the document and seal again — never route around it.
- **Runs are shared facts:** `mp run record --cmd … --log … [--tree <worktree>]
  [--scope closing]` records an execution once, identified by (tree hash, command,
  output hash); everyone else cites `run:<id>`. Fingerprints bind the **judged tree**,
  not the mission tip. (Field: 26 % of R evidence duplicated another seat's identical
  run — the same suite executed by up to five seats.)
- **Supersession:** `mp supersede <kind>:<id> --by principal|reality|<kind>:<id>
  --reason …` retires any record — artifact, verdict, flag (reopens its disposition),
  evidence, charter version, contract, run. Sealing a new version supersedes the old
  one automatically. **Rules read live records only.** Whatever depended on a
  superseded record appears in **`mp worklist`** — a to-do for the PM to judge, never
  an error and never an automatic re-issue. (Field: 23 of 23 lint findings were lawful
  citations of superseded documents; the only "repair" was re-issuing unchanged content,
  and one close was blocked for 10 h 44 m.)
- **Waves with teeth:** `mp wave open W<n> --mission … --tasks …` is one call per
  fan-out (single-wave missions included) and is **refused while a DRIFT stands or two
  consecutive SUSPICIONs stand** — the ratchet. Only the principal clears them
  (`mp supersede verdict:<id> --by principal`), recorded verbatim; no project rule or
  standing contract outranks this. (Field: a fired ratchet was absorbed under a project
  contract and fan-out continued — nothing mechanical stood in the way.) TaskSpecs seal
  only into an open wave; the wave's Integration Note closes it.
- **`mp calib triggers`** computes the task-cell triggers from the ledger (recovery
  task, post-amendment spec, cap PASS, post-compaction window × `touches-contract`) —
  the PM no longer checks them by hand.
- **Engine relay:** `## Engine relay` sections and `mp relay add|list|export` — the
  upstream channel for observations whose subject is the pipeline itself, exported as a
  PR-ready body. Adopted from the deployment's own `engine-relay/` practice. Flags stay
  about the product.
- **`mp acts --mission`** derives the "acts in your name" list from the journal for the
  Integration Note and sign-off.
- **Schema v2 and `mp migrate`:** 1.0.0 ledgers upgrade in place; their journals replay
  whole; v1 and v1.1 events coexist (`tests/m4_migrate.py`).
- **Tests:** `tests/m2_lint.py` is now the seal gate (every evidence rule refused at
  the door, by name; stale is a worklist item); `tests/m3_dryrun.py` drives a whole
  mission by documents alone; `tests/m4_migrate.py`; fixture documents under
  `tests/fixtures/` are the reference implementation of the document contract. 168
  checks, five gates.

### Changed
- **Calibration is cheap first:** the Calibrator runs alone; with no anchored accusation
  it writes the wave's ALIGNED verdict itself (`## Convened: calibrator-only`) and the
  cell ends there — Challenger and Arbiter are convened only on cause. (Field: 30 cells,
  ~90 seat runs; the expensive seats had work in a minority of them.) The post-compaction
  trigger is bounded: specs written after a compaction and before the next completed
  re-grounding, and only when the spec's `touches-contract` is yes — the engine-neutral
  form of PR #3.
- **Charter is re-issued, never edited in place:** each amendment is a new Charter file
  at the next version whose amendment-ledger row carries the principal's verbatim words;
  sealing v1 ratifies `## Prohibitions` into standing contracts automatically.
  `mp charter amend` is retired (refused with the re-issue instruction).
- **Flags are derived, not carried:** the Stabilizer no longer copies flags into the
  group report (section removed); the Integration Note's flag ledger carries flag ids.
  The Stabilizer's spot-check narrows to "does the cited evidence say what is claimed" —
  existence is the engine's.
- **Seams and the integration round** (PR #2, verbatim): seams are payload contracts
  frozen before the fork; a seam-sharing wave ends with its own bounded integration
  round whose acceptance is a real-objects end-to-end proof. The Architect's Pass 2 now
  detects seams.
- **`mp gate close` records the principal's sign-off**: the closing run is recorded
  beforehand (`mp run record --scope closing`), the mission is presented, and the call
  is made on acceptance.
- **Metrics:** buckets always sum to the task count (`r_other`); rounds derived from the
  reports' rounds; lint no longer reports staleness (worklist does).
- **Deprecated, still working for replay:** `artifact new|seal`, `edge add`,
  `round open|close`, `verdict record`, `flag add|dispose`, `evidence add`,
  `fingerprint take`, `charter seal`, `gate record`, `contract add`. Not the documented
  path; marked DEPRECATED in `--help`.

### Fixed
- The journal could record an OK event that never applied (a seat passed a journal
  sequence number where an artifact id was required; the row rolled back after the
  line was fsynced, and the next id was allocated three times). The write path now
  applies inside a savepoint **before** journaling — an apply failure is journaled as
  REFUSED — and every action validates its referenced ids. Replay is tolerant of the
  historical lines such journals already carry (from PR #1).
- `mp metrics` silently dropped tasks with 0 or > 3 rounds, which disabled the trend
  half of calibration (2 of 70 field accusations were trend-shaped). From PR #1.
- `mp doctor` reported absolute-path registrations as tampering (30 of 31 field
  FAILs); paths are stored relative to the project root and normalized.
- Heading matching is by leading phrase and HTML comments are stripped before
  parsing, so template guidance never becomes a phantom flag.

### Notes
- The three field PRs are absorbed: #2 verbatim, #1's replay tolerance and metrics
  fix, #3's intent in engine-neutral form; #1's Charter special cases are unnecessary
  under supersession.
- Upgrading a live 1.0.0 project: replace the skill folder, then the PM runs
  `mp migrate` once. The one grammar rule seats will meet: the Evidence cell of a
  criteria row is the anchor (`run:7`); trailing annotation is tolerated, prose belongs
  in the sections.
- Round-2 field data is the next input: events per artifact, refusals that bite,
  cells convened vs calibrator-only, worklist size, relay volume.

## [1.0.0] — 2026-08-31

The anti-drift, anti-circular-corroboration release — and the largest change in the
project's history: the engine's species changes from pure prose to prose + a
deterministic substrate. Evidence-mined from the same seven-mission production ledger
as 0.3.0 (433 artifacts, Week 21–27), whose drift had two structural causes: nothing
checks the checker — the PM, the longest-lived context and the primary drift source,
was unaudited mid-mission — and circular corroboration: N documents with one common
ancestor are 1 root + N−1 echoes, but every reader counts documents, not roots. This
release freezes the goal before the mission's document web exists, arms five defense
layers against drift, types every citation by its evidential root, and gives the
invariants an enforcement layer. Rationale record:
`docs/design/DesignDoc_CalibrationAndSubstrate_2026-08-31_v03.md`.

### Added
- **The Charter** (`templates/charter.md`): a frozen per-mission calibration basis,
  sealed before decomposition — the principal's verbatim words plus confirmed
  read-backs (on conflict, the verbatim words govern). Prohibitions are ratified into
  `CONTRACTS.md` in the signing act, zero extra principal interaction, and bind every
  task from wave 1. Only the principal amends it, via the conversational chain,
  recorded verbatim; every amendment marks specs citing the prior version stale. No
  sealed Charter, no fan-out — a one-line fix mission has a one-paragraph Charter.
- **Five defense layers against drift**, each sitting where its question is
  well-posed and cheap: standing-contract prohibitions checked on every task (L1 —
  free, the Crititor already reads the registry); Architect Pass 2 Charter-lint
  before fan-out (L2); a risk-triggered task-level calibration cell (L3 — recovery
  tasks, post-amendment specs, round-3 passes, post-compaction specs); the PM
  re-grounding ritual at every wave boundary (L4 — the only preventive layer, aimed
  at compaction); the aggregate calibration cell at every wave boundary (L5, the
  main force — the actual production escapes were aggregate trends no per-step
  check could see: verification narrowed 100% → 0% across six missions in
  individually legal steps).
- **Calibration cells and two new roles** (`roles/calibrator.md`,
  `roles/challenger.md`; arbiter as a Stabilizer variant;
  `templates/calibration-verdict.md`, one per wave). The Calibrator is deliberately
  starved — sealed Charter, the wave's delivery set, mechanical cross-wave metrics,
  and none of the document web's frame; the Challenger is deliberately fed and must
  discharge each accusation with written authorization or concede — a Charter line,
  a ratified amendment, a recorded principal disposition; derived documents are not
  tender. Two legal accusation shapes: trend (must cite metrics) and contradiction
  (must quote the Charter). Verdicts: ALIGNED launches the next wave; SUSPICION
  forces a PM disposition, and recurrence in consecutive waves auto-escalates — the
  ratchet the PM cannot absorb; DRIFT halts the affected fan-out only, and reaches
  the principal in goal language, never as machinery. Cell inputs are computed by
  rule from the ledger — the PM spawns the cell but cannot curate what it reads.
- **Evidence law:** every evidence citation in a verdict-bearing artifact carries a
  type — R (reality: executed output, fingerprint-bound), F (fixed point: frozen
  before the mission web), D (derived: any mission-era document), X (external:
  fetched and verified) — under six rules: D+D agreement = zero weight; every
  criterion marked "met" needs ≥1 R or F anchor; D never upgrades by being cited
  more; R binds to source state and fails closed on mismatch; summaries are never
  citable roots (flag decay was summaries being used as sources); stale citations
  are flagged, with Charter amendments propagating staleness automatically.
- **Invariant 13 — Echoes are not evidence.** "Agreement among derived artifacts
  adds no evidential weight. No acceptance stands without at least one
  reality-anchored or fixed-point anchor, and reality anchors bind to the source
  state that produced them." (Ledger evidence: coherence laundered error — reading
  more of a wrong-but-consistent document web made the error less visible, not
  more.)
- **The deterministic substrate** (`scripts/mp` — one file, Python ≥ 3.8, stdlib
  only, zero dependencies; agent-facing documentation in
  `references/substrate.md`). Three-layer authority: `ledger/events.jsonl` is an
  append-only journal, authoritative for every state transition **including
  refused operations** — the enforcement layer of "silence is not disposal" must
  not itself work silently; `ledger/mp.db` is a derived SQLite view, rebuildable by
  replay (`mp rebuild`), where invariants become constraints — round cap = CHECK,
  registry collision = UNIQUE, undisposed flags refuse close; markdown stays
  authoritative for judgment prose. Single write path, journal first, under a
  lock; `mp doctor` replays the journal against the DB and reports divergence.
  DrvFS/WSL detection built in.
- **Hardened closing gate and source fingerprints:** `mp gate close` refuses while
  any flag is undisposed, lint fails, or the Charter is stale; gate runs bind their
  log and its hash to a source fingerprint (commit SHA + dirty state + tree hash),
  and verification fails closed on fingerprint mismatch. (Ledger evidence: CRLF
  checkout drift changed byte-addressed hash inputs while `git status` read clean —
  semantically coherent documents on mechanically drifted bytes, invisible to every
  seat.)
- **Invariant 12 — The principal converses; agents operate.** "Every principal
  decision must be expressible and deliverable in one plain sentence. Any pipeline
  step that requires the principal to execute an instruction, operate a tool, or
  absorb machinery detail is an engine defect, not a configuration option." The
  principal's command count is zero — `mp` is agent-internal and self-identifies as
  such. Authority without commands: the principal says it in one sentence, the PM
  reads back and executes on their behalf, recording the verbatim words — and at
  sign-off presents the **"acts in your name" repudiation list** (amendments,
  ratifications, dispositions), repudiable item by item, closing the loop that
  would otherwise let a D-type claim ("PM says the principal approved") pose as an
  F-type anchor. Compaction disclosure becomes a mandatory Integration Note line.
- **Machine-readable headers** on the task-spec, dev-report, and critique
  templates, plus the evidence-type column — verdict-bearing artifacts are now
  mechanically lintable (`mp lint`: typing present, D-only chains, staleness).
- **Tests** (`tests/`): the M1 gate — `mp adopt` on a field site's exported ledger
  followed by `mp metrics` mechanically reproduces
  the retrospective once done by hand; the analysis is now a SELECT and stays the
  regression test (`tests/m1_acceptance.py`, plus `tests/m1_smoke.py`). The M2
  gate (`tests/m2_lint.py`): `mp lint` catches seeded violations of each of the six
  evidence rules, and `mp gate close` fails closed on source drift. The M3 gate
  (`tests/m3_dryrun.py`): a dry-run mission exercises the defense layers —
  prohibition catch, Charter-lint catch, triggered task cell, SUSPICION ratchet,
  DRIFT halt — and closes through the hardened gate. 117 checks, zero failures.

### Changed
- **Default executors flipped** (invariant 12): Researcher, Auditor, and the
  calibration seats default to PM-spawned fresh contexts with engine-fixed inputs —
  parallax is bought with fresh contexts, never with principal labor. "Principal
  runs it in a separate session" remains an optional PROJECT.md binding.
- **Setup shrinks and bootstraps the substrate:** the interview becomes one
  consolidated scouted proposal plus a single veto pass — individual questions only
  for what the scout cannot answer, typically the principal's identity and the week
  scheme. `/mission-pipeline:init` now also runs `mp doctor` (environment check)
  and `mp init` (state creation) — executed by the agent, never by the principal.
- **Python ≥ 3.8 (stdlib only) is required for new missions.** `mp doctor` fails
  the install loudly, never a mission midway. v0.3-era prose ledgers remain
  readable and are imported via `mp adopt`.
- **Semver commitment:** from 1.0.0 on, breaking changes to the binding contract
  (PROJECT.md slots), the `mp` command surface, or the schema (beyond `mp migrate`)
  imply a major bump. The DB carries `schema_meta` and migrates forward.

### Notes
- Released ahead of the first dogfooded mission by the principal's decision: the
  mechanical gates are green; the first field deployments are the dogfood, and their
  ledgers return for analysis through the same `mp adopt` + `mp metrics` path.
- `tests/m1_acceptance.py` needs a field site's exported ledger under `data/`, which is not
  distributed; the other three test files are self-contained.

## [0.3.0] — 2026-08-19

Frame-parallax release. Mined from a seven-mission production ledger (433 artifacts,
Week 21–27): every seat executed its prompt faithfully — zero invariant violations —
yet a fully-accepted mission shipped 13 latent test failures. The escapes lived in the
contracts, not the execution. This release re-arms the contracts.

### Added
- **Invariant 10 — Reality closes the evidence:** no mission reaches sign-off without
  one full-scope verification run (the closing gate) over the integrated result.
  Task-level verification may be narrowed for speed; the closing gate may not.
  (Ledger evidence: full-suite verification narrowed monotonically 100% → 0% across
  six missions, each step contractually legal, before the escape.)
- **Invariant 11 — Flags route; silence is not disposal:** out-of-frame flags and
  noticed-but-not-fixed items reach the PM verbatim and each gets an explicit,
  recorded disposition. (Evidence: a declared evidence-identity drift decayed
  Constructor → "Notes, non-blocking" → "declared and non-blocking" → absent from the
  closure note — every seat compliant, the risk shipped.)
- **Out-of-frame flag channel:** mandated `Out-of-frame risk` section in the critique
  (exactly one item or a justified "None"; never feeds the verdict), mandated
  `Noticed but not fixed` in the dev report, both carried verbatim by the group
  report and dispositioned in the Integration Note. (Evidence: schema-mandated
  sections landed at 86–97%; prose-only instructions landed at 0.8–35%.)
- **Standing-contracts registry** (`ledger/CONTRACTS.md`, `templates/standing-contracts.md`):
  ratified project invariants that bind every task like acceptance criteria, whether
  or not a spec restates them; violations are automatic CHANGES-REQUESTED; PM drafts,
  principal ratifies at sign-off.
- **Auditor** (optional role, `roles/auditor.md` + `templates/closure-audit.md`): one
  arms-length read before sign-off — does the integrated result deliver the design
  decision's stated goal? Runs by default in a separate principal session; a different
  model family is preferred when available, never required (single-model deployments
  get parallax from fresh session + artifacts-only inputs + a different question).
  Report reaches the principal unfiltered; the PM gets a copy, not a veto.
- **Integration Note** as a mandated artifact (`templates/integration-note.md`):
  merges, escalation decisions, the flag ledger with dispositions, footprint
  reconciliation (ArchPlan predictions vs files actually touched), and the closing-gate
  record at mission close.
- **Architect Pass 2 spec lint** (cold read, feeds the delta veto): pointer
  requirements left unexpanded, unanchorable acceptance criteria, verification-scope
  regression vs earlier waves and the closing gate, missing out-of-scope — plus an
  `Unstated assumptions` section. (Evidence: a requirement reading "implement all
  contracts required by DesignDoc §4–5" produced a criteria table with no
  corresponding row; the contract shipped incomplete and cost 5 of the next
  mission's 12 tasks in recovery.)
- **PM protocol:** read-back of frame-level directives (compiled policy, scope and
  boundary, ≤2 lines, confirmed before it enters any document); commitment-delta veto
  surfaced one item at a time, most critical first; explicit disposition duty for
  every flag; standing-contract curation; the closing gate before sign-off.
- **Stabilizer evidence spot-check** before any accept: sample the critique's
  citations — `file:line` exists and says what is claimed, cited tests re-run green.
  Judging paperwork, not re-reviewing; a failed spot-check returns the critique for
  correction in the same round.
- **Crititor inputs widened:** the standing-contracts registry, and every document the
  spec's mandatory reading names — "inputs, not references," the mission's design
  decision included. Purpose-anchored required changes: meeting the letter of the
  criteria while defeating a written purpose is a Required change, not a Note.
  (Evidence: 87% of specs pointed at the design doc; 0 of 98 critiques read it; the
  one critique in the corpus that did produced the deepest finding of two missions.)
- **PROJECT.md slots:** Document map (mission-rationale location — mid-pipeline
  adoptions point it at their existing tree, never restructure; standing-contracts
  location), the closing gate, and Closure-audit bindings. Setup interview §12–13;
  `/mission-pipeline:init` seeds `ledger/CONTRACTS.md`.

### Fixed
- `/mission-pipeline:init` referenced `${CLAUDE_SKILL_DIR}`, which does not exist in
  plugin command context — both references now use `${CLAUDE_PLUGIN_ROOT}`, so the
  command can actually locate `setup.md` and the templates.

## [0.2.0] — 2026-07-07

### Added
- `/mission-pipeline:init` plugin command — idempotent project initialization:
  creates the state folders, briefly scouts an existing project (stack,
  conventions, verification commands, week evidence; read-only, coexists with
  any established workflow), then runs the setup interview pre-filled with the
  scouted answers so the principal vetoes proposals instead of answering open
  questions.
- Setup reference (`references/setup.md`): explicit read-only scout phase as
  install step 3; the interview now asks only what the scout could not answer.

## [0.1.0] — 2026-07-06

Initial public release.

### Added
- The engine: mission lifecycle, bounded build–critique–stabilize group loop
  (default 3 rounds), wave-based parallel execution, escalation ladder, and the
  nine named invariants (`skills/mission-pipeline/SKILL.md`).
- Six role definitions: PM, Architect, Constructor, Crititor, Stabilizer,
  Researcher (`roles/`).
- Engine/binding separation: read-only engine files + a single per-project
  `PROJECT.md` binding layer; upgrades are drop-in, drift is `diff`-detectable.
- Per-mission ledger outside the source tree
  (`.claude/mission-pipeline/ledger/`, relocatable), with the main-root
  path-anchoring rule for worktree safety.
- Setup interview (`references/setup.md`), including the scout-don't-invent
  week-scheme rule: adopt the project's counter, else `Week01` for new
  projects, else ask — never the calendar week.
- Seven artifact templates: PROJECT.md, task-spec, dev-report, critique,
  group-report, arch-plan, missions-registry (`templates/`).

### Notes
- Extracted from a production deployment that ran multi-wave missions with
  10+ parallel task groups; the packaging (plugin + marketplace) is new in
  this release.
