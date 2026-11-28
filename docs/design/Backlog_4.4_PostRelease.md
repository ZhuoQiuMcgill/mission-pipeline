# Mission Pipeline 4.4: post-release backlog

Design contract: `DesignDoc_MissionPipeline_4.4_PM_2026-11-27_v10.md` (the PM design: fixes G1 to G9,
the principles P-1 to P-11, the rules R1 to R4), which amends `DesignDoc_MissionPipeline_4.4_2026-11-27_v04.md`
(the repair plan: problems P1 to P17, fixes F1 to F19) and rules where the two differ. Both build on
the 4.3 rulings (`DesignDoc_PMSecretary_2026-11-06_v03.md`, F-1 to F-9), with D-1 to D-12 and E-1 to E-5.

4.4.0 was built in twelve work packages on one integration branch. Each package was built by one
model and reviewed against the design by a second model in bounded rounds; each finding was fixed with
a test that fails without the fix, or overruled with its reason. A verification then ran 4.4 on
memories written by 4.3 (a copy of a three-week mission, and memories built with 4.3's own fixtures and
continued under 4.4); four small follow-ups came of it. The release was then reviewed once as a whole,
its fixes were confirmed in one closing round, and the verification ran once more on the final engine.
The items below were not fixed: they do not produce a wrong result in normal use, or they are
4.3 behaviour that 4.4 leaves as it was. Under P-4 (D-1), a rare case gets detection, a safe default and
a work-instruction line, not a new mechanism. What a user must know is in the CHANGELOG and in the
engine README's known limitations.

## Built differently from the design's wording

- **Two reopens of one accepted attempt (the plan's F13).** F13 says a second repair's reopen joins an
  open attempt that is not yet claimed, and is otherwise pinned to the attempt that follows. Built: it
  is always pinned to the attempt that follows, never merged. The purpose holds: a reopen is never
  dropped. Two review rounds found races only in the merge path, and a rare case does not get a
  mechanism (P-4, D-1). Cost: one more attempt in a rare case.
- **The architect-repair card at its claim (the plan's F5).** F5 says the card is rebuilt at the claim
  as the plan-review card is. Built: it is rebuilt inside the claim with no new refusal; only when the
  plan in effect was replaced is the claim refused, as the plan-review card's is, and the flow rebuilds
  the step.
- **Notices about operating detail (the plan's F10 and F16).** They name notices to the PM about the
  health of the review seat and the size of a card and of its must-read material. Built: these go to
  the Secretary's loop (`review-health` only informs the Secretary; the sizes are a warning printed to
  whoever dispatches), as the PM design keeps operating detail away from the PM. The warning about many
  standards on a task goes to the PM and the feasibility reviewer, as the plan says (`many-standards`).
- **A decision item that names its tasks (G3).** A task whose own card links the item still shows it
  under its requirement items, because a seat reads what its work is bound to (E-4); `--tasks` limits
  only where a decision recorded after the plan is printed as a decision.
- **A disk limit (G6).** Claims at the same moment can pass `limits.worktrees` or `limits.freeBytes`
  by a few; the next claim is held. It guards against worktrees piling up and is not a quota.
- **The evidence rule at a renewal (F10, with E-4 as the PM design applies it).** A judgment that rests
  only on data outside the commit, citing no run, is not sent to a new review when the environment
  changes, as in 4.1.3 for explorations: a renewal finds judgments through the runs they cite. A
  judgment that rests on files a run kept is renewed mechanically only when the rerun wrote each of them
  again with the same sha256; otherwise it gets a new review.
- **An Architect's answer on a used-up rework loop (G1).** G1 records an answer on the escalation that
  asked, as its answer. A used-up loop has no answer that continues the work, so there the answer is
  recorded and returned to the Secretary like the other replies, and a grant prints the latest answer
  on the next attempt's Constructor and Reviewer cards. The program grants no attempt in the decider's
  place (P-6).
- **The binding of a new requirement's work (G9).** G9 binds every task to the item of "a filing with
  one item", and asks the Architect to name the items on each task of a filing with several. Built: the
  count is of the filing's items in force when its amendment is applied, so a filing of two items of
  which the user withdrew one binds every task to the other; the Architect's card, rebuilt at its claim,
  states the rule with those items. The binding follows what the user still wants (P-3) and what the
  Architect was told.
- **A withdrawn item of a new requirement (G9).** G9 says a product bound to the item "follows the
  rules that exist". Under those rules a product made after an item's withdrawal no longer carries the
  item. Built: an item a task took through a filing stays in its product's contract once withdrawn,
  also for a product made after the withdrawal, so the existing "basis withdrawn" escalation puts the
  work before a decider; an item of the plan keeps 4.3's rule. A filing exists for its items: work made
  for an item the user took back is not accepted silently (P-3, P-7).
- **One release.** The plan's two releases, 4.4.0 and 4.4.1, are one release, 4.4.0 (H-11).

## The PM's inbox and the user's words (`src/process/secretary.ts`, `src/memory/words.ts`, `src/flow/waivers.ts`)

- The inbox brief marks an authorization the decision cited when that item was revised since, not when
  it was withdrawn since (a supersession's `--withdraw-items`): the brief then shows it as it was
  decided. The PM decides on the words it cites itself, and an answer whose words lost force is
  rejected at application. What to do: read the item (`mp read show requirement`, `mp read from W-n`)
  before relying on an authorization a brief names.
- A withdrawal of a mission's plan-review waiver on the user's words (`mp pm waive … --withdraw --words
  W-n`) is not linked to those words by `mp read from W-n` when the configuration key alone had waived
  the reviews: there is no waiver node to link it to. The withdrawal is recorded and applies; only the
  read misses it.
- The planner treats a withdrawal of a mission-wide plan-review waiver as covering every plan (4.3),
  also a withdrawal of scope alone. So when a supersession withdraws a mission-wide waiver and keeps a
  waiver for one plan, that plan runs its ordinary reviews: the safe side. The reads say "kept, but the
  planner does not apply it". Whether a withdrawal of scope alone should leave a waiver for one plan
  applied is a later decision.
- A plan-review waiver granted after the planner chose the waiver for a plan, and before that plan took
  effect, is shown by the reads as the waiver the plan took effect under. The plan's own record of what
  it took effect on is right; only the reads name the later grant. Rare: two waivers of one scope
  within one pass.
- `mp pm say` with a supersession, interrupted after its write and retried after other words were
  recorded, records its tag again as a new message. What to do: read `mp read words` before retrying
  a recording, and re-tag on the user's words if a duplicate came of it.
- A requirement item that is revised into an authorization keeps, by its id, the "kept" mark an earlier
  supersession gave the item, and the next supersession does not ask about it by name. What to do:
  withdraw the authorization by `--withdraw-items` when its words change.
- A supersession that names two words entries at once, each carrying a mission-wide waiver of the plan
  reviews, where the earlier entry keeps another tag in force, asks about the later grant only. If the
  PM withdraws it, the withdrawal covers every grant of that scope, so no waiver applies. If the PM
  keeps it, the plan reviews stay waived as chosen, but the grant the planner applies (and the tree
  shows) is the earlier one. What to do: read the waiver line of `mp read tree`; withdraw by scope
  (`mp pm waive <mission> plan-reviews --withdraw --words W-n`) to end them all.

## The loop and housekeeping (`src/process/secretary.ts`, `src/process/actions.ts`, `src/evaluator/renew.ts`)

- A crash between an acceptance and the next reconciliation leaves that product's commit without a
  kept ref until the next pass, which anchors it. Nothing to do.
- `mp sec wait --since R` can miss a release or a detached worker's end that lands after its pass read
  the detached runs, until its time-out or its next periodic check (every 30 s). The periodic check is
  the safe default.
- `mp sec renew` without `--mission` can still renew a judgment wholly of a closed mission when it
  cites a run whose candidate belongs to an open mission, and a mission literally named `project`
  reads as one whose mission cannot be told. Both need a proof unit's own mission, which the reads do
  not carry.
- After a power loss a detached worker has neither a result nor an end record, so `mp pm secretary
  stop --idle` keeps refusing. The refusal names the run; the plain `mp pm secretary stop` is the way
  through.
- An unacknowledged PM note is printed again by every `mp sec next` pass until the Secretary
  acknowledges it (`mp sec ack-note`): on a copy of a long mission, such notes were most of what each
  pass repeated. What to do: acknowledge a note once its instruction is taken into account.
- Sizes of the reads on a long mission (a copy of a three-week mission written by 4.3): `mp read tree`
  printed 1.6 MB in 6,117 lines, `mp read notes` (with or without `--all`) 132 KB. Both are read on
  the user's request only; what to do: read one subject (`mp read show`, `mp read why`) instead.
- A pass lists the kept refs of the repository once for each open mission that holds products, not
  once in all: with several such missions a pass makes several listings. Correct, only slower.
- The flow's memo of accepted starts (4.3 code) lives as long as its process and is not dropped when
  `mp pm continue-from` recovers the event chain; the closures 4.4 keeps are keyed by the chain too. A
  process alive across a recovery (a `mp sec wait` already waiting) could check a start against the
  history cut away. What to do: end a waiting `mp sec wait` after a recovery and run `mp sec next`.
- A `mp sec next --op <id>` that 4.3 recorded and did not print, whose stored text was cut at the
  receipt's limit, replayed in text mode under 4.4 in the same Secretary generation moves the cursor
  past a PM reply that only the stored JSON holds: the reply then shows as a count. `mp sec next --all`
  prints it.

## Repairs, new requirements and the cap (`src/flow/execution.ts`, `src/flow/repair.ts`, `src/cli/workReads.ts`)

- A repair decision of 4.3 interrupted between its `decided` write and its counted loop return, then
  upgraded, is carried out the 4.4 way: its reopen gets a fresh loop, and a task the repair added waits
  for the reopened attempt, where 4.3 would have let the added task start while the Secretary considered
  a grant. The wait ends when the reopened attempt is accepted. A crash window of 4.3 gets no mechanism.
- The items a task carries through a new requirement are read from the amendment whose card the task
  still has. A task whose filing card a plain repair changed, and that a later plan then carried over, is
  read by the plain repair's card, so it carries no filing item. Rare; the reads show the task under the
  plain repair.
- In a filing with several items, a task on which the Architect named no item is bound to none: it is
  not reviewed again when one of the items changes. The reads show it as not named (G9).
- A repair that names no item still cannot be ended once it is filed, as in 4.3 (G9); a filing with
  items ends when the user withdraws every item before its amendment is applied.
- A task dropped by a plan and added again later with an identical card can be attributed by the next
  plan to the earliest repair that added it. The gate of a newer repair's reopen of its dependency is
  then passed over, and the task can start on the product that reopen replaces. The proof labels show
  it afterwards: the task's prerequisite reads as no longer the accepted one.
- A task added by one new requirement, reopened by a second and changed by a third, then carried into a
  new detailed plan: when the first filing's item is withdrawn while the task is under construction, its
  product can pass with no "basis withdrawn" escalation, because the item it took on the reopen is not
  carried through the changed card and the new plan. What a user sees: `mp read items` shows the item
  withdrawn, and the task's product was accepted with no decider asked. What to do: stop the task when
  the user withdraws a requirement, as for any work.
- When a later change restores the card a task had before a new requirement's filing changed it, the
  task's id is still in the plan, so repeating the same `mp pm extend` returns the old filing although
  none of its work is left. What to do: file with new words of the user.
- Right after `mp pm extend` on a large memory, every label reads "(recomputing)" until the next pass
  (about 11 s on a mission of three weeks), then returns unchanged. Ready and held steps do not change.
- At an acceptance with risk, a reason whose text names an open item the task already carries can be
  taken for that item carried, and no new item is written, although its text differs. The decision's
  receipt keeps every reason; `mp read show decision` shows them.
- `mp read items` shows a delivered output's current label: when the label changes after a successful
  delivery, the row no longer shows the label at delivery. The close shows both.
- A reopen granted under 4.3 whose step was queued at the upgrade, then claimed and accepted under 4.4:
  when a later plan changes that task's card, `mp read repairs` goes from done to "what became of this
  reopen is not recorded" for it. The acceptance and the product are unchanged; the read says less than
  the record, never more.
- A task added by one repair, its card changed by a second, under a later plan that keeps that card:
  its cards carry the second repair's note, not the first's. `mp read repairs` shows both notes.
- The claim of a taken-back filing's Architect step is refused with "is held: new requirement R-n was
  taken back", while `mp pm next` lists that step neither as ready nor as held. Nothing is dispatched
  either way; the wording differs only.

## Evidence and reviews (`src/evaluator/runs.ts`, `src/process/runs.ts`)

- A declared run is reused by its candidate, command, directory and environment; the files the command
  names are not part of that key. So when a command names a file for the first time, on a commit and an
  environment where it already ran, the earlier run is reused, and it kept no file. The Reviewer's card
  then lists no kept file for it (it says nothing false). What to do: the Reviewer reruns the command
  (`mp seat <id> rerun`) when it needs the file.
- At a renewal, two declared commands with the same text and directory, one that names a report file
  and one that does not, can make one of them take the other's declaration of files. The renewal
  then asks for a fresh review where the earlier judgment could have been renewed: the safe side.
- A Reviewer's citation through a directory link inside its scratch folder, whose target lies outside
  it: the file is not copied (it lies outside and stays where it is), and the cleanup removes the link,
  so the cited path no longer opens. The content is at the link's target; what to do: cite the target's
  own path.

## Questions, Architect answers and their bounds (`src/flow/execution.ts`, `src/flow/architectAsk.ts`, `src/process/pm.ts`)

- When a repair or a re-plan replaces a task's card while another process's pass raises that task's
  used-up loop escalation in the same window, the escalation is raised on the old card. The next pass
  closes it; an Architect's reply recorded before then belongs to the old card.
- A detailed plan in effect that amendments made larger than one stored data value cannot be attached
  again as the plan material of an Architect's answer card at its claim; the claim keeps the queued
  card's plan material.
- Bounds of one read, far beyond any field record: a mission with more than 10,000 PM answers (an early
  Reviewer referral whose PM ask lies beyond them reads as waiting on the user); an attempt paused more
  than 10,000 times (a pause id is reused); a 4.3 product first adopted after a task's 10,000th
  acceptance (its renewal review stays held). Nothing to do.

## Holds (`src/process/holds.ts`)

- A hold window that repeats daily is not in 4.4: such a hold is placed by hand each day (G6).
- With a live Secretary, the PM's `mp pm hold add --after <task>` does not validate a start recorded
  without prerequisite pins, so placing the same hold again can return the id and end time of a hold
  that is already over. What to do: read `mp read holds`; place the hold with new arguments if it is
  over.

## Going back to 4.3

- Going back is restoring the copy of `.mission-pipeline/` taken before the first 4.4 command (the
  CHANGELOG, the Secretary's handbook and both READMEs say so); a 4.3 engine run on a memory 4.4 has
  written to misreads it.
  Beyond the limits the design names (a held step dispatched, an addressed instruction printed by its
  paths), it would apply a late Architect hand-back of a new requirement's filing the user withdrew
  (the filing has ended for 4.4 and is undecided for 4.3), record a Constructor's parked edits as a
  product and queue their review (they are stored where 4.3 looks for a candidate), and mark a PM's
  question to the Architect applied (4.3 does not know the option). A 4.3 engine refuses only a
  `config.json` that carries 4.4's keys. Candidate: a mark in the memory by which a 4.3 engine refuses
  a memory 4.4 has written to.

## Not in 4.4

- #52: a kept product with stale prerequisites under an unchanged card has no mechanical exit; stable
  mode holds its dependents until a re-plan.
- #56: in a continuation review, a `user-said` finding can cite only the batch's own words material.

## Seen on memories written by 4.3, the same under 4.3

- A task added by a repair that 4.3 decided can hand back, be verified and then be followed by no
  product, no review and no word in any read; 4.3 does the same on the same memory. Trigger not
  narrowed further. What to do: a repair or a re-plan that changes the task's card routes it.
- A retry with the same `--op` of some operations 4.3 recorded (`mp pm plan submit`, `mp pm repair`,
  `mp pm stop`) ends in `OP_CONFLICT`, under 4.3 as under 4.4; `mp pm stop-release` runs again under
  both. The other 4.3 operations the verification retried under 4.4 replayed their receipts. What to
  do: the first run is on the record; read what it wrote before running the command again.
- An acceptance's write is not guarded against a concurrent change of attempt, as in 4.3: a pass that
  read a passing review of attempt k can record its acceptance after another process started attempt
  k+1. The reads credit a repair only with the attempt that carried it, so they do not misreport.

## Windows and PowerShell (4.4.1)

What 4.4.1 documents and does not change (`engine/README.md`, "Windows and PowerShell"):

- **Windows PowerShell 5.1 pipes text to a program as ASCII** by default: non-ASCII characters arrive
  as `?`, and the engine cannot restore them; it warns when the standard input bears that pipe's
  byte-order mark and a `?` (a genuine `?` piped that way warns too). What to do: `--file`, PowerShell 7, or
  `$OutputEncoding = [Text.Encoding]::UTF8` first (5.1 then writes the byte-order mark twice; the
  reader drops both).
- **Double quotes inside an argument are dropped** by `mp.cmd` called from PowerShell, and by Windows
  PowerShell 5.1 on its way to any program, `mp.ps1` included (the npm shim is npm's). What to do:
  `--file` or `--stdin`, or `mp.ps1` in PowerShell 7. Candidate: a shim that escapes the quotes for
  5.1's legacy argument passing.
- **A console on another code page** shows the engine's UTF-8 output garbled when it is captured.
  What to do: `[Console]::OutputEncoding = [Text.Encoding]::UTF8`.
- **A file in the system code page** is read with U+FFFD where it is not UTF-8, with a warning; the
  engine does not guess the code page. UTF-16 without a byte-order mark stays refused where a NUL was
  (the refusal says what to do); UTF-32 is not decoded.
- **Only CRLF and LF** count as the same line break in "occurs verbatim"; a lone CR does not.
- **An operation's identity** still fingerprints a file as 4.4.0 read it (a mark included), so a
  4.4.0 command retried with the same `--op` replays; the same file saved again in another encoding
  is another operation, as any change of its content is. That reading collapses different
  characters of a UTF-16 file, so a command repeated with the same `--op` and a changed UTF-16 file
  can replay the first receipt. And a note from a file with a UTF-8 mark, interrupted under 4.4.0
  after its write and retried under 4.4.1, ends in `OP_CONFLICT`. What to do: the first run is on
  the record; read it before running the command again.
- **The duplicate-checkout lookup** (`mp pm detach-duplicate`) compares paths as strings: a worktree
  at the root of a network share, or named with another letter case than git registered, is not
  found. What to do: WI-01's other ways still apply.
- The static pages quote the seat's prompt in its Linux form; on Windows the prompt `mp sec dispatch`
  prints ends with the PowerShell sentence, and the Secretary's handbook says to give it as printed.
- The PowerShell launch of the Secretary takes the flags of the existing Claude Code hint
  (`--bg -n`); it was checked with a stand-in for `claude` (the variable is set for the launch and
  given back the value it had after, also where `Remove-Item` defaults to `-WhatIf`), not with Claude
  Code on Windows.
- A hand-back on stdin that holds a NUL with no mark gives two warning lines (the standard input, and
  the hand-back file written from it).

Seen while the test suite was first run on Windows, and not changed:

- **A journal entry costs about ten times more on Windows** (about 2.8 ms against 0.3 ms on Linux:
  per entry the pending note is rewritten whole and the append is synced). No product write holds
  more than a handful of entries, and none came near its 2 s budget on Windows; a write with
  hundreds of entries would. Candidate: write the pending note once per write.
- **A declared artifact path is refused for a `.git` component by its exact name.** On Windows
  `.Git/…` names the same folder, so a plan that declared such a path could have a run checkout's
  git files copied into the kept files. Rare (a plan would have to name it). Candidate: fold case
  on Windows when a file is kept.
- **With `core.symlinks=false` a link in the commit is a plain file in a run checkout**: a declared
  artifact that is such a link is kept as its link text on Windows, and recorded "it is a link" on
  Linux. Harmless.
- **`snapshotFiles` (`src/seat/results.ts`) reads through `/proc/self/fd`**, which only Linux has. It
  is on no product path today (hand-back pointers are checked against the commit's blobs).
- **An owner's lock file stays open** for a checkout until the checkout is removed, also after the
  memory is closed in the same process (by design). On Windows an open file cannot be deleted; in a
  command-line process this ends with the process.
- Landing attempt data keep an occupant's folder as git printed it (forward slashes on Windows),
  for the stability of receipts; everything else uses the program's path form.
- Four tests that run a POSIX shell script in place of git are skipped on Windows.

## Defects of 4.3 found and not fixed

- **`restart` never restarts a step.** `src/flow/failures.ts` offers `restart` for a failed seat only
  when its hand-back did not come after a stop, while the scheduler's restart (`src/process/ports.ts`,
  `HarnessScheduler.restart`) restarts only a hand-back that came after one. So whenever `restart` is
  offered, the restart is refused and the question goes back to the PM: "cannot be restarted as it is".
  4.4 makes the option's description say so (`test/p44-option-effects.test.ts` pins it). A fix has to
  settle which hand-backs a restart may take, and whether `restart` is offered for a hand-back after a
  stop once the stop is released.
- **A waiver granted under an authorization outlives it.** The planner goes on applying a plan-review
  waiver granted under an authorization item after that item was withdrawn (`src/flow/waivers.ts`: the
  item is not checked). 4.4's accounting of the user's words asks the PM about such a waiver by name
  when the authorization's words are superseded or re-tagged; a plain `mp pm requirement withdraw` of
  the authorization does not ask. What to do: withdraw the waiver as well
  (`mp pm waive <mission> plan-reviews --withdraw --words W-n`).
