# Mission Pipeline 4.4: repair plan (v04, approved as amended)

Status: v04, 2026-11-27. **Approved by the maintainer on 2026-11-27 as amended by `DesignDoc_MissionPipeline_4.4_PM_2026-11-27_v10.md` ("the PM design"), and in force as the design of 4.4.0.** Where the two differ, the PM design rules. Its section 7 lists what it withdraws or replaces here: F1 and F2 (its G3 and G4), F6 (its G6), F7 (its G8), F11 (its G5; an "obligation" of this plan is an "open item" there, with no owner, no assignment, no inbox count, no forced choice and no block on delivery), F12 (d) (withdrawn), F15 (its G5 and G9), F18 (its G7), the evidence rule of F10 (ruling E-4 as it stands), the limit of two blocked hand-backs in F4, and the last line of F13 (its G9). The questions of §7 are settled by that approval with the defaults given there, except where the PM design says otherwise. The two versions of §5, 4.4.0 and 4.4.1, are built and released together as 4.4.0. v04 differs from v03 only in this status. v01 and v02 were each reviewed once by a second model within fixed limits. Appendix B and Appendix C say what each finding changed. **The second round's verdict on v02 was "not ready": the eight changes it led to (Appendix C) are in this version and have not been reviewed again**, because the review was limited to two rounds. It replaces the draft "4.4: information flow" (v01 of the same day), which covered about half of what the record shows. It covers the problems of 4.3 that do not depend on a harness. Rulings H-1 to H-5 are the maintainer's, stated in the author's words. Everything tagged [proposal] is the author's and waits for a ruling; §7 lists the questions that are the maintainer's to decide. Builds on 4.3.0 with the nine field fixes of pull request 70 (`main` at 8a87f8f). A 4.3 memory opens in 4.4 with no migration; new record kinds, events and fields are additions only.

## 0. Calibration

- **[H-n]**: the maintainer ruled it.
- **[fact]**: verified in 4.3.0 source (file and line given) or taken from a field record (§1 says which).
- **[proposal]**: the author's. Not in force until ruled.

| Id | The maintainer's ruling, in the author's words |
|---|---|
| H-1 | First raise Mission Pipeline from 4.3 to 4.4. Solve the problems that do not depend on a harness first. |
| H-2 | The first three subjects, whatever the harness: a card carries only what concerns its task and is built when its seat starts; three things get a formal place in the memory; the loop is run by a program. |
| H-3 | A concern: worktrees piled up and took a great deal of disk space in an earlier project. |
| H-4 | The pipeline's shortcomings have to be found through real tasks. |
| H-5 | The first draft is a beginning, not the end. From the problems found and analysed, the repair plan is continued and completed, and reviewed in two bounded rounds before it is presented. |

Of H-2, 4.4 does the first two subjects and the engine's share of the third (what a program needs from `mp`). The program itself depends on a harness and is not in 4.4.

## 1. The evidence

Three sources. None is in this repository.

- **Field A.** One project on 4.3.0 for 21.6 days: 1 mission, 1,200 dispatches, 303 escalations, 56 repairs. Two surveys answered by its PM and its resident Secretary (2026-11-27), then five read-only investigations of its memory, cards, reports, private notes and session transcripts (2026-11-27). Figures tagged **A**.
- **Field B.** Another project on 4.3.0: five short field reports from five resident Secretary generations, small missions in fast mode, one upgrade from 4.1.0 (2026-11-10 to 2026-11-16). Figures tagged **B**.
- **The 18 open issues** of the repository (51 to 54, 56 to 69). Pull request 70 fixed 51, 57, 58, 63, 67 and 69; they are still open.

A claim seen in one field only says so.

## 2. The problems

Seventeen problems in five groups. Each has an id used in the rest of the document.

### Group 1: what reaches a seat

**P1. A card's content follows scope, not relevance, so cards only grow.**
- **A** [record]: project constraints are 74% of all card bytes; their share rose from 52% in week 1 to 85% in week 4. The median Constructor card grew from 68 KB to 339 KB; an architect-repair card reached 990 KB.
- **A** [record, one late Constructor card]: 100 constraints, 272 KB. 26 of them (64% of the bytes) are the scope and rulings of one repair each, written with scope `**`. 8 concern exactly one task. 2 concern the task of the card.
- **B**: layer 1 (8 KiB) was filled by about 30 instruction constraints.
- [fact] A constraint's scope is `{mission?, paths, taskTypes}` and defaults to `**` (common/records.ts:89-94; cli/commands/pm.ts:664). No scope names a task, a lineage or a repair. Decompose and repair cards get every constraint of the mission (seat/cards/dynamic.ts:63-66). Constraints are printed inline with no size limit (seat/cards/common.ts:176).
- [fact] A repair stores `{id, words, kind, text, about}` only, and `text` must be a substring of the words entry (flow/plandoc.ts:387-396; process/pm.ts:866). The PM's own scope and rulings for a repair have no field.

**P2. What a seat needs is not on its card.**
- **A** [record, lower bound]: 75 dispatches say in their reports that something was missing. The Reviewer lacked the Constructor's hand-back or evidence 20 times; the feasibility reviewer lacked the tasks' standards 6 times (9 of 13 feasibility hand-backs lacked something); the repair Architect could not see an accepted product it was to reopen 4 times; a Constructor lacked its earlier attempt's hand-back or the previous review 7 times.
- **B**: the same classes, and one rework because a plan's data formats were on the Architect's card only.
- [fact] The Reviewer card has no materials. Of the Constructor's hand-back it carries only `unmet_standards` and `unfixed_problems`; the report, `done` and `decisions_needed` do not reach it (seat/card.ts:35-89; flow/execution.ts:2481-2486). The role page says the Reviewer does not get the Constructor's reasoning (plugin roles reviewer.md:17). A Reviewer cannot cite the report: evidence must be `evidence:<run>` or a `file:` inside the candidate (seat/results.ts:176-195).
- [fact] The Constructor card has no materials. A rework attempt gets the previous review's issues as text lines and nothing else of the review or of its own earlier hand-back (flow/execution.ts:1954-1962, 2310-2327).
- [fact] The feasibility card's data holds the whole plan, but its rendering leaves out each task's standards, requirement items, readable files and interface links (seat/cards/architect.ts:281-302). On a revision it and the revising Architect get the blocking findings as one line each, not the report (flow/planning.ts:1123, 1495, 1531).
- [fact] The architect-repair card lists accepted products by object version id. Its checkout serves the target branch head with no product laid on it, and no command gives a product's commit (flow/repair.ts:365-375; process/actions.ts:97-103).
- [fact] `dataFormats` and `storage` are plan-level lists with no link to tasks; no Constructor or Reviewer card carries them (flow/plandoc.ts:222-223).
- [fact] Instruction constraints never reach Calibrator 1, Calibrator 2 or the feasibility reviewer (seat/cards/inputs.ts:20).

**P3. A card is settled before its seat starts; later rulings do not reach it.**
- **A** [record]: 176 of 876 non-Secretary dispatches (20%) ran to their hand-back on a card that had gone stale: 45 reviews claimed before the answer to their Constructor's questions, 37 with a new version of a constraint naming their task, 94 with other constraint changes. 9 dispatches were released unstarted for a card reason.
- **A** [sample n=10 of the 176]: no rework cites a ruling the seat never saw; two show an indirect effect. The harm that can be measured is small.
- [fact] The architect-repair card is built when the step is queued and never refreshed (seat/cards/refresh.ts:49-50); 12 of 58 repair dispatches in A were claimed after constraint versions committed since their queueing (issues 53, 68).
- [fact] A release costs one of two re-dispatches per lineage whether or not the seat read its card (process/pm.ts:546-554; common/records.ts:634). `mp seat <D> card` writes nothing (process/seat.ts:117-124).

**P4. A Constructor can ask only when it hands back, and its questions hold nothing.**
- **A** [record]: all 177 Constructor escalations came with a hand-back; each carries 1 to 7 questions (63 carry one, 50 two, 43 three, 21 four or more). Of 178 same-attempt reviews, 100 (56%) had a card built before the escalation's answer was applied.
- **A** [record, one case read]: an escalation is marked applied as a whole. In one, the decider answered the design questions and put off one approval until after the review; the record shows the escalation as applied.
- **A** [sample n=70]: 29% were product or design decisions nobody had made; 23% had an answer already in the memory; 16% were about the boundary of scope, write paths or an interface; 14% about permission, environment or tooling; 10% an ambiguous or contradictory card; 9% a report of a fact.
- **B**: an answer has no live seat to receive it.
- [fact] A Constructor's commands are card, read and hand-back; no command raises a question while it works (seat/cards/registry.ts:47-54). The result has no "could not proceed" form (seat/results.ts:31-38). A hand-back with `decisions_needed` still records the product, runs the verification and queues the Reviewer; the escalation does not block (flow/execution.ts:736-783, 2032).
- [fact] An applied `answer` is printed on Constructor and Reviewer cards claimed after it, until the task's next spec (seat/cards/dynamic.ts:84-94). The questions themselves are not on the Reviewer's card (flow/execution.ts:2480-2486).

**P5. A must-read receipt shows that a page was fetched, not that it was read.**
- **A** [record]: in 232 Secretary decision rounds with a transcript, the must-read material entered the conversation in full in 0 rounds, in part in 33, and not at all in 199 (86%). 57 of 4,348 must-read pages had text in the conversation. In 33 rounds the decision text was written in the same shell command as the reads.
- **A** [record]: the must-read of a decision is 18 pages at the median and 21 to 29 late in the run.
- [fact] The check needs one `read` event per page per dispatch (seat/cards/common.ts:92-99; process/seat.ts:149-154, 677-684). The Secretary's `current-facts` material holds every event of the task line in full and repeats the constraints; each decision item is printed three times (seat/cards/dynamic.ts:118-139).

### Group 2: process state with no place in the memory

**P6. Holds and the order of work live in notes and in the Secretary's own log.**
- **A** [judgment over 140 notes]: about 60 hold or ordering instructions: about 36 on one task or chain, 9 on the machine or a simulator window, 9 tied to a usage threshold, 6 on everything. Release was by another task's acceptance, by a time, or by the PM's word. Median length 8.6 h, longest 197 h, about 14 in force at the peak.
- **A** [record]: the only formal hold is the stop (6 uses). The two longest holds (about 74 h and about 15 days) were not stops. A held step was dispatched once because the reminder lived only in the Secretary's log.
- [fact] The ready list holds a step for five reasons only: a closed mission, a stop, a git hold, an exploration's predecessors, a leased resource (process/pm.ts:269-299). A stop also refuses hand-backs, runs, delivery and landing. Nothing is released by time.

**P7. Notes are an unversioned side channel that carries rulings.**
- **A** [judgment, every note classified]: of 140 notes, 34 are rulings for one task, 27 holds or order, 24 answers to escalations (4 with no answer record), 19 relays of recorded work, 17 information, 14 operating instructions, 5 corrections. 8 notes were later replaced by another note; 5 pairs conflict.
- [fact] A note is `{id, text, words, acknowledged}`. The only read is `mp sec next`, which lists unacknowledged notes. No note can be withdrawn or replaced, and no card carries one (memory/events.ts:44; process/secretary.ts:42-56).

**P8. What is left at the review cap has no owner and does not converge.**
- **A** [record]: 66 of 164 acceptances are acceptances with risk at the cap; they leave 322 items.
- **A** [sample n=40 of the 322]: 2 were later fixed and confirmed by a passing review; 11 were picked up by a repair, constraint or task and not shown fixed (the picking-up task was itself accepted with risk in 10 of 10); 2 were explicitly waived; 25 were never mentioned again, of which 13 could not be fixed by any later work (an "unclear" or an evidence-form item).
- **A** [record]: every one of the 7 accepted tasks that were added to close cap leftovers was itself accepted with risk.
- **A** [sample n=20]: the engine's fix tracker reads "not fixed" for every deferred finding because no later judgment responds to the finding's id (20 of 20); 5 were truly not fixed and 2 were fixed without the record knowing.
- [fact] An acceptance with risk stores one sentence per escalation reason; nothing gates on it; reads label it "accepted" and its proof label reads proven (flow/execution.ts:1241-1286; cli/layers.ts:132). No link joins a leftover item to the repair or task that later handles it (flow/plandoc.ts:398-406).

**P9. One fact is kept by hand in several places, and earlier words are never superseded.**
- **A** [record]: one schedule fact lived in two constraints (28 versions), in the project rule file (19 edits) and in words entries. Of 186 words entries none was superseded although rules changed often. Layer 1 overflowed ("448 more entries").
- [fact] `--supersedes` works only when an entry is first tagged (memory/words.ts:105-110). `mp read from W-n` does not reach constraints, waivers or notes (cli/tree.ts:252-266).

### Group 3: the review loop

**P10. A share of the standards cannot be checked from the candidate.**
- **A** [record, classifier checked on 30]: standards a Reviewer can check by reading the candidate are judged not met 28% of the time. Standards that need evidence outside the commit: 47% not met and 14% unclear. Standards about the state before the change or about the process followed: 55% and 14%. Open-ended standards: 57%. The last three classes are about 30% of 974 standards.
- **A** [record]: 74 Reviewer hand-backs were refused for citing evidence outside the candidate snapshot. Rework rises with the number of standards on a task: 30% with 1 to 3, 61% with 4 to 7, 70% with 8 or more.
- [fact] A standard is `{id, text}`; a judgment is met yes, no or unclear; an execution Reviewer's evidence is a run or a file in the snapshot; a `data:` pointer outside the repository is accepted only for experiments and explorations (flow/plandoc.ts:179; seat/results.ts:176-211; flow/execution.ts:2547).
- [fact] A seat's scratch folder is removed at its hand-back, so evidence left there does not reach the Reviewer (issue 65; **B** twice, **A** once).

**P11. Reaching the cap is normal, and the ruling made there follows a rule yet passes through two hands every time.**
- **A** [record]: 64% of 392 reviews ask for rework. The largest family of repeated rulings is 69 rulings on 46 tasks: "the review cap is reached: accept what is left as risk, or grant one last attempt", all resting on one rule of the user. The PM made 36 of those acceptances and 11 of those grants. All 38 acceptances with risk made by the PM had been sent up by the Secretary; the engine required the PM in 6.
- **A** [record]: escalations that block were open 25 h in total while seats worked 304 h on the same lines. The cost of the hand-over is context, not time.
- [fact] The rework cap is the constant 2 per lineage for the task's whole life (common/records.ts:629-637); no configuration sets it. Every used-up loop raises an escalation and a Secretary step; no record lets a standing rule settle a class of escalations (flow/secretary.ts:128-156). The resident Secretary's handbook sends PM-class choices to the PM even where an authorization appears to cover them (plugin secretary SECRETARY.md:63).

**P12. Nothing reads the health of the review seat.**
- **A** [record]: after the Reviewer's filler changed, the share of standards judged not met rose 2 to 6 times within each class of standard (reading the candidate: 10.5% to 64.7%). No task was reviewed by both fillers, so a stricter model and harder tasks cannot be told apart. No read showed the change.

### Group 4: repairs

**P13. A repair does three jobs, and its scope has nowhere to live.**
- **A** [record]: 773 of 1,200 dispatches (64%) come from repairs: 19 repairs carried new or changed requirements of the user (75 tasks added, 445 dispatches); 22 carried findings of real or simulator runs (23 accepted tasks reopened, 227 dispatches); 7 carried items left at the cap (63 dispatches).
- **A** [record]: after the 39th repair no repair reopened a task; the Architects' notes say a reopen would restart on an old base or that the lineage had ended at its cap. Fix work moved to new lineages, which is why leftovers cannot be traced (P8).
- [fact] A repair's reopen counts on the same rework loop as the task's reviews, and when that loop is used up the escalation offers no acceptance with risk (flow/execution.ts:1484-1504, 1954-1963, 1996). A reopened attempt starts on the target head plus the task's own dependencies; work of other tasks of the mission is not in it (process/actions.ts:97-103, 138-155). A dependent is offered while a dependency reopened by the same repair is still pending, because the gate reads accepted products only (flow/execution.ts:1104-1124; issue 59).
- [fact] The `repairs` field reaches the tasks a repair added, on every attempt, and a reopened task on its next attempt only; it never reaches a task whose card the repair changed (flow/execution.ts:1507-1516, 576-586). A repair has no "done" state (flow/repair.ts:68, 117). An identical repair returns the earlier one (flow/repair.ts:160-168; issue 60).
- [fact] A new requirement recorded as a requirement item writes a new requirement-set version, to which Calibrator 1 is bound; a repair carries no item, so it is the cheaper way in (flow/requirements.ts:183; flow/planning.ts:284).

**P14. Re-binding kept products costs dispatches and notices and found nothing new.**
- **A** [record]: 27 re-bind reviews, all from three plan revisions in stable mode: 19 passed, 8 asked for rework, of which 6 reported items already open at the first acceptance and 2 a rule recorded since. 334 `kept-product-not-rebound` notices for 134 products; no action follows any of them in the record; 133 were never acknowledged. The PM moved the mission to fast mode on day 8.
- **B**: after an upgrade a stable-mode mission could go on only after 793 older runs were replayed, most of them of closed missions.
- [fact] The notice's key hashes the set of stale and missing prerequisites, so it repeats as that set moves; nothing closes it (flow/execution.ts:1768-1782). `mp pm renew` takes no argument and covers the whole memory, closed missions included (evaluator/renew.ts:106-166). Issues 52, 54, 66.

### Group 5: the loop

**P15. Most passes do nothing, and the output is mostly repetition.**
- **A** [record]: 66% of `mp sec next` passes and 92% of `mp sec wait` returns were followed by no dispatch and no decision. 47% of the wake-ups that were not time-outs were caused by a seat's own claim, read, checkout or refused hand-back. The `sec next` output grew from 20 KB to 110 KB; 99% of its lines repeat the pass before; 82% of it is notices. 651 of 753 notices only need an acknowledgement; 269 were never acknowledged.
- **B**: the same.
- [fact] `sec next` prints every PM reply ever made, every decision applied by the PM or the user in every mission, every unacknowledged notice again, and every queued step of a closed mission; no cursor exists per Secretary generation (process/secretary.ts:42-47, 204; process/pm.ts:274-276, 375-376). `sec wait` wakes on any record kind outside a list of six, so every flow event wakes it (process/secretary.ts:208-211). The informational flag of a notice changes nothing (process/ports.ts:260).

**P16. A decision takes effect some time after it is made, and the PM's inbox misses what was sent to the PM.**
- **A** [record]: from the Secretary's decision hand-back to its application: median 112 s, p90 about 20 minutes; 20 steps of the same task were dispatched inside that gap. 71 of 120 PM answers were given before the `decision` event existed, so those escalations could never appear in the inbox (issue 62).
- [fact] `mp sec decide` records the hand-back and runs the flow in the same command. The hand-back of the same decision step through `mp seat <D> handback` does not: with a live Secretary the seat-side advance returns nothing (process/secretary.ts:259-268; process/seat.ts:770, 957-964; process/advance.ts:19-20). The decision card lists the seat commands. In A most decisions were handed back the seat way (27 `sec decide` in 299 decisions).
- [fact] `pmInbox` lists an escalation only once the `decision` event exists with class needs-pm or needs-user, and `mp pm answer` requires neither (process/secretary.ts:116-171; flow/secretary.ts:406-421).

**P17. Each card is stored three times.**
- **A** [record]: card text and card specs take about 940 MB of 1,670 MB (database and leaves). Worktrees were not a problem in this field: at most 9 at once, all removed.
- [fact] At a claim the full card text is written to the card leaf, to the operation receipt in the log and to the `ops` table (process/pm.ts:450-454, 472-479; memory/projection.ts:116-117). The stored response is read back only by a concurrent claim with the same operation id (memory/memory.ts:752-755).

### Seen in one field only, or not yet examined

- A hand-back's verification executed again by `sec next` and `sec wait` (**B**, three executions at once). **A**: 0 in 1,260 declared runs.
- Upgrade matters (**B**): `renew` without a scope; historical notices returning as open inbox items; no plain way to retire an idle Secretary.
- Issue 64: candidate and accepted commits are unreachable until delivery creates its ref, so `git gc` could delete accepted work. Not examined.

## 3. The fixes

One fix may serve several problems. §4 maps every problem to its fixes.

### F1. An instruction is addressed to what it concerns [proposal] (P1, P7, P13)

The draft proposed a new record, a "ruling for one task". This plan extends the instruction constraint instead: it already has versions, withdrawal, words and a place on the card, and the field's rulings are already written as constraints.

- **Two new scope dimensions, for instruction constraints only:** `tasks` (task ids) and `repairs` (repair ids). An object constraint keeps today's scope, because its scope is a proof input.
- **An address is bound to one mission.** [fact] Constraints are collected across missions, and repair ids are numbered per mission, so `R-1` exists in each (flow/requirements.ts:247; flow/repair.ts:156). An instruction with `tasks` or `repairs` must carry the mission of those tasks or repairs in its scope; addressing a project-wide instruction sets that mission, and the command refuses an address without one. F2 takes the mission from the repair.
- **Reach.** An instruction with `tasks` is printed on the cards of those tasks only: their Constructor, their Reviewer, and a Secretary decision card about them. An instruction with `repairs` is printed on that repair's Architect card and on the cards of every task the repair added, changed or reopened (Constructor and Reviewer, every attempt while the amendment or the reopen stands). An addressed instruction reaches nobody else.
- **Architect cards.** Decompose and repair cards keep every unaddressed constraint in full. Of the addressed ones they print in full only those addressed to the repair in hand or to its `about` task; the rest appear as an index (id, version, addressee, first line, size).
- **Calibrators and feasibility.** An instruction whose task types name `pm-plan` reaches Calibrator 1; one that names `detailed-plan` reaches Calibrator 2 and the feasibility reviewer. Not otherwise: an instruction with scope `**` does not start flooding these cards.
- **Commands.** `mp pm constraint add … --kind instruction [--tasks t1,t2] [--repair R-n]`. `mp pm constraint scope <id> [--tasks …] [--repair …]` addresses an existing constraint. [fact] A change of scope with the same text writes a `constraint-scope` event and no new version (flow/requirements.ts:212-236), so the field's repair-scope constraints move over with one command each and no rewriting.
- **On the card.** A section "Instructions for this task" (addressed ones, with id and version) comes before "Project constraints".
- **The Reviewer answers each addressed instruction:** followed, not followed or unclear, with a reason. Not followed blocks a pass as a standard not met does (§7 M4). The proof contract is unchanged: an instruction is still not a proof input.
- **An instruction instructs; it does not change a standard.** A change to a standard, a write path or an interface stays a repair.
- **Late decision items.** `mp pm requirement add … --type decision [--tasks t1,t2]`. [fact] Today a decision recorded after the plan took effect is printed on every card (seat/cards/dynamic.ts:69-96). With `--tasks` it is printed on those tasks only; without, as today.
- **Sight.** `mp read constraints <mission> --reach` lists each constraint with its addressees, the number of cards it reaches and its size. A dispatch reports its card's size; past `cardWarnBytes` (default 64 KiB) the PM gets one notice naming the largest sections and the five largest constraints.
- **Layer 1.** Addressed instructions and the constraints of closed missions take no room in layer 1.

### F2. A repair carries a brief, and its text reaches every card it caused [proposal] (P13, P1)

- **The brief.** `mp pm repair … [--brief-file <file>]` files the repair and, in the same write, records an instruction constraint addressed to it (F1). The brief is the PM's own text: scope, what not to touch, rulings. It has versions like any constraint. It is in place before the Architect's step is queued.
- **Reach of the repair itself.** The `repairs` field is also printed on the cards of tasks whose card the repair changed, and on every later attempt of a task it reopened. [fact] The comment at flow/repair.ts:27 already says so; the code does not do it.
- **The Architect's note** on a repair decision is recorded with the decision and shown by `mp read repairs` (F13). [fact] Today it is neither recorded nor shown (flow/repair.ts:327-331).

### F3. Materials by need [proposal] (P2)

- **The Reviewer gets the Constructor's hand-back.** The report of the attempt under review, with its `done` and `decisions_needed` fields, becomes an optional material of the Reviewer's card, headed "the Constructor's claims: to check, not proof". The role page changes with it (§7 M2). It may be cited only for a standard whose check is `report` (F10).
- **A rework attempt gets its past.** The previous review's report and the attempt's own earlier hand-back become optional materials of the Constructor's card.
- **The feasibility card shows what it reviews.** Each task's standards, requirement items, readable files and interface links are rendered. The data is already on the card.
- **A revision gets the report.** The previous feasibility report becomes a material of the revising Architect's card and of the next feasibility card.
- **The repair Architect can read what it reopens.** `accepted[]` on its card gains each product's commit, and `mp seat <D> checkout --product <task>` serves a shared read-only checkout of it. The Architect's page says that accepted products are the plan's state and may be read.
- **Data formats.** The plan's `dataFormats` and `storage` lists are printed on the Constructor and Reviewer cards of that plan. They are short lists.

### F4. A Constructor can stop and ask; a review waits for the answer [proposal] (P4, P3)

- **A blocked hand-back.** A Constructor may hand back `blocked` with its questions. Nothing is recorded as a product, nothing is verified, no review is queued. The escalation blocks the task. When the answer is applied, a Constructor step is queued again for the same attempt, with the answer on its card. It does not count on the rework loop or on the re-dispatch allowance. At most two blocked hand-backs per attempt; a third is refused and the seat must deliver what it can (§7 M3).
- **Each pause has its own continuation.** [fact] A Constructor's escalation is identified by its attempt, raising one that exists returns at once, a handed-back worktree is removed, and a new dispatch opens its worktree at the card's snapshot (flow/execution.ts:751; flow/secretary.ts:130; process/pm.ts:333, 489). So a blocked hand-back does two things. Its escalation is keyed by the attempt and the number of the pause. And the engine collects the in-scope edits as it collects a candidate at any hand-back, and records them as a parked commit: not a product, not verified, not reviewable. The resumed dispatch starts its worktree on the parked commit, as a rework starts on the previous product today.
- **Each question says when it must be settled.** In a hand-back's `decisions_needed` every question is marked `before-review` or `later`. An answer responds to each question: answered, or deferred with an owner. An escalation is applied only when every `before-review` question is answered. A `later` or deferred question becomes an obligation of kind `decision` at once, when the answer defers it or the hand-back raises it as `later`, owned by the decider (F11). [fact] An applied escalation takes no further answer (flow/secretary.ts:411), and in A an approval deferred on attempt 1 came on attempt 3 through a different escalation. So the obligation is the question's own answer path: its owner answers it at any time (`mp pm obligation answer <id>`), the answer reaches the task's next card, and the open question is listed on every card of the task until then, through rework and acceptance.
- **A hand-back with a product and questions** stays as it is, with two changes. The review of that attempt is not ready while a `before-review` question of that attempt is unanswered or its answer is not applied; it shows as held, with the escalation named. And the Reviewer's card shows the questions and the answers.
- **Where the hold is checked.** In the ready list and again inside the claim, as a closed mission is checked today (process/pm.ts:274, 459).
- **Cost.** **A**: a Constructor's question was applied 4 minutes after it was raised at the median when the Secretary answered (p90 15) and 10 minutes when the PM did (p90 29). A review takes 6 minutes at the median.

### F5. A card that is current when it is claimed [proposal] (P3)

- **The architect-repair card is rebuilt at the claim** when its planning inputs changed, as the plan-review card already is (flow/planning.ts:514-537). Issues 53 and 68.
- **A served receipt.** The first `mp seat <D> card` records that the card was served. A failure to record it never refuses the card.
- **Releasing an unstarted dispatch costs nothing.** Unstarted means: no served receipt, no material read, no run, no checkout, no refused hand-back and, for a Constructor, a clean worktree. Such releases are counted apart; the third in a row on one step raises a notice.
- **Not taken from the draft:** ending a dispatch whose card is out of date at its first read. The measured harm of a stale card is small (P3), and F4 and F9 remove its two largest sources (a review before the answer, 45 cases; a step dispatched before a decision applied, 20 cases).

### F6. Holds [proposal] (P6)

- **The record.** `hold.placed`: an id `H-n`, a subject, a release condition, a reason, who placed it and the words if any. `hold.released` ends it.
- **Subjects.** One task: its Constructor steps are held, so no new attempt starts; its reviews and decisions go on. One queued step, named by its id: a single review, or the Architect's step of one repair. A named resource: every step that needs it. Everything: every step except a Secretary decision. **A** [record]: the Secretary held one review while a ruling was pending, and the PM held one repair's Architect step while other work went on; neither fits a task hold or a hold on everything.
- **Release.** While a named task is not accepted; from a time or until a time; or by hand. A condition is evaluated when the list is built and writes nothing. `mp sec wait` also wakes at the next such time.
- **Commands.** `mp pm hold add --task <id> | --step <id> | --resource <name> | --all [--after <task>] [--from <time>] [--until <time>] --reason … [--words W-n]`, `mp pm hold release <H>`, `mp read holds`. The Secretary may place and release a hold for an operational reason, without words: `mp sec hold add|release`.
- **What a hold does not do.** It blocks new dispatches only. A dispatch in flight, a hand-back, a run, a delivery and a landing are untouched. A stop is not reused for this.
- **Where it shows.** `mp sec next` lists a held step with the hold's id and reason, as structured data. `mp read blocked` includes it.
- **Usage thresholds** are a harness's accounting. The memory holds them as a hold released by hand or at the reset time.
- **Disk [H-3].** `mp read scratch` lists worktrees, checkouts and scratch folders with size, owner and age. `config.json` may set `limits: { worktrees, freeBytes }`; when one is passed, new Constructor steps are held with the reason shown. The default sets none: in A worktrees were not what filled the disk (P17).
- **Not in 4.4:** a window that repeats daily (§7 M6).

### F7. Notes that can be replaced and read [proposal] (P7)

- `mp pm note … [--replaces N-x] [--file <file>]`. A replaced note is shown as replaced.
- `mp read notes [--all]` lists every note with its state: current, replaced, acknowledged.
- `mp pm note` warns when its text names an open escalation: an answer in a note reaches no card and is not an answer record.
- The handbooks say it: a ruling for a task is an addressed instruction (F1), a hold is a hold (F6), an answer is `mp pm answer`.

### F8. A loop that says only what is new [proposal] (P15)

- **`mp sec next` shows what changed since the caller's last pass.** A cursor per Secretary generation records the revision of its last completed pass. Notices delivered before it, PM replies and applied decisions older than it, and the queued steps of closed missions are each reduced to one count line. `--all` prints everything as today. The JSON carries the same and takes `--since <rev>`.
- **Only a pass the caller sees moves the cursor.** [fact] `mp sec wait` runs a full `sec next` pass when it starts and every 30 seconds, discards its report, and that pass marks notices delivered (process/secretary.ts:216-221; process/pm.ts:375-376). The cursor advances, and a notice is marked delivered, only for what a `mp sec next` result returned to its caller contained. The passes inside `mp sec wait` reconcile and leave both untouched.
- **`mp sec wait` wakes on what calls for the Secretary:** a hand-back, a release, a decision, an answer or its application, a note, a question or a reply, a change of constraint, hold or stop, a notice that calls for an action, a hold's time, an unconfirmed seat. It no longer wakes on a seat's own claim, read, checkout or refused hand-back, or on the writes of its own pass.
- **A notice that only informs** is delivered once and needs no acknowledgement; `mp sec alerts --all` still lists it. [fact] No flow logic depends on an acknowledgement.
- **`kept-product-not-rebound`** is one notice per product and plan; a later change of the stale set updates it; it closes when the product is re-bound or superseded (F14).

### F9. A decision takes effect when it is made [proposal] (P16)

- **One behaviour for both commands.** The hand-back of a Secretary decision step under the live generation's identity runs the same flow step as `mp sec decide`. The decision card names `mp sec read` and `mp sec decide`.
- **The PM inbox** lists an escalation from the moment the Secretary's decision hand-back with class needs-pm or needs-user is recorded, read from the hand-back when the `decision` event is not yet written. Issue 62.
- **The output says what happened:** "recorded and applied", or "recorded; the next pass applies it", with the reason.
- **`mp pm answer` under a live Secretary** keeps recording without reconciling, as the handbook rules; its output says that the Secretary's next pass applies it. The hint that names `mp sec answer`, which does not exist, is corrected.

### F10. Standards that can be checked [proposal] (P10, P12)

- **A standard says how it is checked.** In the detailed plan each standard names one of: `command` (a declared command), `reading` (reading the candidate), `report` (a statement the Constructor's hand-back must make), `artifact` (a file a declared run writes outside the commit), `person` (someone must look, or run it where the program cannot). A standard of a 4.3 plan reads as `reading`. A `person` standard is never put to the Reviewer as met or not met: it starts as an obligation to verify.
- **A fourth answer.** A judgment may say that the standard cannot be verified from what the Reviewer can see, and what would be needed. A review whose only open standards are of that kind is not sent back to the Constructor. It goes once to a decider, who accepts with those standards recorded as obligations to verify (F11) or sends it back with instructions.
- **What the program ran is evidence; what a seat hands in is an attachment.** A hash and a size say which file it is, not which build produced it. **A** [record]: one hand-back cited the reports of an earlier attempt for checks it had not run again. The program can vouch for a file only when it produced it. So there are two classes.
  - **Run artifacts.** A declared command may name the files it writes. When `mp` runs that command on the candidate's checkout (a hand-back's verification, a rerun, a detached run), it keeps those files with the run's record, bound to the run and so to the candidate. A Reviewer cites them as it cites the run today. Nothing changes in how such a judgment is admitted or renewed: it rests on a declared run. [fact] A run's output is not kept today when the run passes (process/runs.ts:20).
  - **Attachments.** Any other file a hand-back names is copied under the dispatch's record with its sha256 and size, and is labelled "handed in with attempt k; origin not established by the program". The Reviewer may read it. It cannot make a standard met. A standard that only attachments could support gets the fourth answer and goes to a decider, as above.
- **Not taken:** marking a judgment as resting on an external observation. [fact] The evaluator refuses a declared run in a judgment marked that way, and an integration pass must cite its full run (evaluator/labels.ts:441-447; process/seat.ts:438). With the two classes no judgment needs the mark.
- **Files survive the hand-back.** Run artifacts and attachments are copied before the scratch folder is removed, and the scratch folder is removed only after the hand-back command has printed its result. Issue 65.
- **The plan check warns.** Above `standardsWarn` standards on a task (default 7) the feasibility reviewer and the PM are told. It is a warning, not a refusal. The Architect's page asks for standards with a finite check; the feasibility card now shows them (F3).
- **Review health.** `mp read reviews <mission>` gives the share of pass, rework and needs-decision per filler of the Reviewer seat and per week. The PM gets a notice when the pass share of the last 20 reviews is under half of what it was before the filler changed.

### F11. Obligations [proposal] (P8)

- **The record.** At an acceptance with risk the engine writes one `obligation` for every distinct risk that is accepted: each standard not met, unclear or not verifiable, each issue not fixed, each finding and each failed run among the escalation's reasons. [fact] The acceptance already stores every one of these as a risk sentence (flow/execution.ts:1279); in A they were 322 for 66 acceptances, 44 of them findings and 20 failed runs or other reasons. An obligation has an id, a kind (`fix`, `verify`, `finding`, `run` or `decision`), its reference in the Reviewer's structured hand-back where there is one, its text, and the task and attempt it came from. The decider may waive one at the acceptance, with a reason; a waived one is recorded as waived, not dropped.
- **Every obligation has an owner from the start.** At the acceptance its owner is the decider who accepted the risk. `mp pm obligation assign <id> --task <id> | --repair <id>` hands it to work. `mp pm repair … --obligation <ids>` links a repair when it is filed. A repair's decision says which of the obligations linked to it each task it adds, changes or reopens takes over; **A** [record]: one repair reopened two tasks and added none. An obligation linked to a repair that its decision gives to no task stays with its decider and is named in the repair's notice. The PM inbox carries one line for the obligations still owned by a decider and not by work, with their number and the age of the oldest.
- **An assigned obligation is on its owner's cards.** [fact] A Reviewer's card lists as open issues only those observed on products of its own lineage (flow/execution.ts:2495), and in A the fix work went to other lineages. So the Constructor and Reviewer cards of the owning task list each obligation assigned to it, with its original reference and text, and the Reviewer answers each: fixed, not fixed or unclear.
- **Discharge is derived from a recorded outcome.** A `fix`, `finding` or `run` obligation is discharged when its owner is accepted and the review of the accepted attempt answered it fixed, whether that acceptance followed a pass or a ruling. [fact] A ruling that accepts with risk revokes the review and carries an empty list of issue responses, and the fix tracker reads the deciding judgment (flow/secretary.ts:649; evaluator/semantics.ts:1329); in A every sampled owner task was accepted with risk. So the Reviewer's answer on each issue and obligation is kept on the accepted product when a ruling accepts other risks, and both `mp read obligations` and the fix tracker read it. A `verify` obligation is discharged only by an outcome that it holds: a later review that judges the standard met on a run's artifacts, or the user's statement that it was checked and holds (F15). A report that shows a failure, or shows nothing, leaves it open. A `decision` obligation is discharged by its answer.
- **Not converging is visible.** When the owner is itself accepted with risk and the obligation is not fixed, it stays open and its carry count rises. An obligation carried twice appears in the PM inbox with three choices: waive it on the user's words, change the standard through a repair, or keep it. Nothing happens by itself.
- **What it blocks.** Nothing by default, which is today's behaviour. The PM may mark one as blocking delivery; `mp pm deliver` then names it and refuses that step until it is discharged or waived on the user's words. The close still never refuses and lists every open obligation.
- **Reads.** `mp read obligations <mission> [--open]`. Status and tree reads say "accepted with risk (n open)" where they say "accepted" today.
- **Deferred findings** become entries of the same list with kind `deferred` and their owner text; the notice is no longer raised again at each re-review.
- **Earlier records.** The sentences stored by 4.3 read as obligations with no reference, blocking nothing. [fact] Each acceptance records who decided it (flow/execution.ts:1283). That decider is their owner, and they count in the inbox line like any other.

### F12. The cap [proposal] (P11, P13)

- **(a) A repair's reopen starts a new loop.** A reopen decided by a repair is new work on the user's words, not another round of the old review. It gets a fresh rework loop, and acceptance with risk is offered at its end as for any attempt (§7 M5).
- **(b) A reopen may wait for other work of the same repair.** A reopen entry may name tasks it comes after; the gate waits for them and their products are laid into the attempt's start. The gate also holds a dependent while a dependency reopened by the same repair is pending. Issue 59.
- **(c) The cap is a setting.** `config.json` `loops.rework` (default 2).
- **(d) A standing ruling at the cap, applied by the Secretary.** `mp pm standing add <mission> cap --text … --words W-n [--task-types …]`, and `withdraw`. It rests on words of the user that are in force, and its text is the user's rule for a used-up loop. The program does not apply it. **A** [record]: the field's rule says that each open finding is classed as a design gap, which goes to the PM, or as minor, which is accepted as risk; one cap decision in the log holds both kinds. That needs a reader. So the standing ruling is printed on the Secretary's decision card for a used-up task loop, and it permits what the handbook forbids today: the Secretary takes the options the ruling covers (acceptance with risk, or one more attempt) itself, citing the ruling, and sends to the PM only what the ruling reserves or does not cover. The decision is recorded as the Secretary's under that standing ruling and its words; an acceptance writes the obligations (F11); the PM gets a notice that only informs. An option the engine reserves for the PM stays the PM's. Reads show the standing ruling with its label, as a waiver is shown (§7 M1).
- [fact] The waiver record already has this shape: a check, an action, a scope, words or authority, a label shown wherever it applies (flow/waivers.ts:1-40). The handbook line that sends such choices up is plugin secretary SECRETARY.md:63, and the resident card refuses the class that would let the Secretary act within an authority (seat/cards/secretary.ts:118).

### F13. Repairs that can be read and filed again [proposal] (P13)

- **`mp read repairs <mission>`**: per repair its kind, words, subject and brief; the tasks it added, changed and reopened with their state; the obligations linked to it; its dispatches; and a derived state "done". Done means: every added task is accepted; every changed task is accepted after the spec that carries the repair; and every reopened task is accepted at an attempt whose card carried this repair's own issue.
- **Filing again.** `mp pm repair … --again` files a new repair although an identical one was decided. Issue 60.
- **Two repairs on one task.** The second's card is rebuilt at its claim on the plan then in effect (F5). Issue 61.
- **A repair does not overwrite a card it has not seen.** [fact] A repair's changed task replaces the whole card by its id, and a later change replaces an earlier one (flow/plandoc.ts:277-281). **A** [record]: two repair Architects worked at the same time, and one repair's card replaced the other's, leaving a standard different from what the first had set. When a repair's decision is applied, each card it changes is compared with the card its Architect was given. If the card has changed since, the decision is returned to the Architect once on the plan then in effect, as a mechanical return is today.
- **Two reopens of one accepted attempt are merged, not dropped.** [fact] A repair pins its reopen to the accepted attempt; once that attempt has moved on, execution skips the request without a word, and each reopen carries its own issue (flow/repair.ts:314-319; flow/execution.ts:1464). When a repair's reopen finds its task already reopened by another repair, its issue joins the instructions of that open attempt if the attempt has not been claimed; otherwise the reopen is pinned again to the attempt that follows. A reopen that can be neither merged nor pinned again is reported to the PM as not carried out, and its repair does not read as done.
- **New requirements keep coming in as repairs.** 4.4 does not change that. F15 makes them visible beside the requirement items.

### F14. Re-binding with less noise [proposal] (P14)

- The `kept-product-not-rebound` notice as in F8; a prerequisite re-bound to a successor of the same content is not stale (issue 66).
- `mp pm renew [--mission <m>]`; without the flag it covers open missions only.
- A new object constraint that the plan's passes do not cover shows as a held reason in `mp sec next`, with its work instruction (issue 54).
- **Not in 4.4:** re-binding a kept product without a review when nothing its Reviewer judges has changed. The record supports it (no re-bind review found a defect that was not already known or caused by a new rule), but it touches the proof contract and rests on 27 cases in one field.

### F15. State per requirement [proposal] (P8, P13)

- **`mp read items <mission>`**: one line per requirement item, and one line per repair under its own words, with its state. A repair is folded under a requirement item only when the PM links it to that item (`mp pm repair link <R> --item <id>`); that its tasks also cite older items does not fold it. **A** [record]: the tasks of a repair that brought a new capability cite earlier requirement items as well, so a filter on "linked to no item" would hide the new request. The states: not planned, planned, in work, accepted after a passing review, accepted with risk (with the count of open obligations), abandoned, delivered, landed; and its proof label. It is derived from links that exist.
- **`mp pm verified <mission> <item|repair> --words W-n [--attach <file>]`** records the user's statement that it was checked in the field and holds. Reads show it as the user's statement on those words, never as proof. It discharges the `verify` obligations it names.

### F16. Must-read material that can be read [proposal] (P5)

- **The Secretary's `current-facts` becomes a digest:** the escalation, the selected items by id and one line, the authorizations, the task's goal and standards, and one line per event of the task line. The full task line becomes a material that is not must-read. The constraints are not repeated in it. Each decision is printed once on the card.
- **Size is visible.** A dispatch reports the pages of its must-read material; past `mustReadWarnPages` (default 6) the PM is told, in the same notice as the card's size.
- **A receipt is called what it is.** Outputs and pages say "fetched". The engine adds no gate here: it cannot observe reading, and a gate that a shell loop satisfies gives assurance it does not have.

### F17. One copy of a card [proposal] (P17)

- The stored response of a dispatch carries the card's leaf path and hash, not its text; the same for the recorded result of `mp sec card`. Earlier records are not rewritten.
- With F1 a card is several times smaller, so each copy is too.

### F18. Words in force [proposal] (P9)

- `mp read from W-n` also reaches the constraints, waivers, standing rulings and notes that cite the entry.
- `--supersedes` is accepted by `tag` and `retag`, not only at the first tagging.
- **Not taken from the draft:** letting a PM answer rest on a one-off instruction entry. [fact] An instruction tag is never in force, and the cited authority is checked again when the answer is applied (memory/words.ts:37, 45-49; flow/secretary.ts:377). Doing it safely means binding the instruction to that one answer through its application and its retries; the record of A has 3 such refusals in 22 days, which does not pay for that.
- The rest of this problem (classifying the user's words, proposing what new words replace) belongs to the Historian of the DSH edition.

### F19. Smaller items [proposal]

- **Issue 64.** First a test that shows whether `git gc --prune=now` removes an accepted product's commit before delivery. If it does, the engine anchors candidate and accepted commits under `refs/mission-pipeline/` when they are recorded.
- **Duplicate verification.** First a test with a hand-back's verification in flight and a concurrent `sec next` and `sec wait` on the same candidate. Fixed only if it reproduces.
- **After an upgrade.** A notice whose plan is superseded, whose mission is closed or whose escalation is decided is born resolved. `mp pm secretary stop --idle` retires a generation when no mission is open and nothing is in flight. `mp sec handbook` before `mp sec session` says to run the session first.
- **Issues 51, 57, 58, 63, 67, 69** are closed once their tests of pull request 70 pass on the release branch.
- **Not in 4.4:** issue 52 (a kept product with stale prerequisites under an unchanged card has no mechanical exit) and issue 56.

## 4. Every problem and its fixes

| Problem | Fixes | What is not solved in 4.4 |
|---|---|---|
| P1 cards grow | F1, F2, F16, F17 | — |
| P2 missing material | F3, F1 (Calibrators, feasibility) | — |
| P3 stale cards | F4, F5, F9 | a constraint recorded while a seat works reaches it only through a release |
| P4 questions after the work | F4 | a seat still cannot wait for an answer inside its own session (a harness matter) |
| P5 receipts | F16, F1 | no proof of reading |
| P6 holds | F6 | repeating windows |
| P7 notes | F1, F6, F7, F9 | — |
| P8 leftovers | F11, F15 | nothing forces convergence; it is made visible |
| P9 words in force | F18, F1 (layer 1) | classification and supersession prompts (Historian) |
| P10 uncheckable standards | F10, F3 | — |
| P11 the cap | F12 (c, d), F10, F11 | — |
| P12 review health | F10 | telling a stricter model from harder tasks |
| P13 repairs | F2, F12 (a, b), F13, F15 | new requirements still enter as repairs |
| P14 re-binding | F14, F8 | the re-bind review itself; issue 52 |
| P15 loop noise | F8 | — |
| P16 decision gap, inbox | F9 | — |
| P17 storage | F17, F1 | earlier records keep their copies |

## 5. Order of work [proposal]

Each step ships on its own, with its tests, the type check and the full suite.

**4.4.0: the right content at the right time**

1. F9; "accepted with risk" in the reads (from F11); `mp read reviews` (from F10); F8; F7; the two tests of F19 (issue 64, duplicate verification).
2. F1, F2, F16, F17.
3. F3.
4. F4, F5, and the base of F11 that F4 needs: the obligation record, its owner, its answer, and `mp read obligations`.
5. F6.

**4.4.1: the loop closes**

6. F10.
7. The rest of F11 (obligations written at an acceptance with risk, on their owner's cards, their carry count, the delivery block), then F12 (c) and (d).
8. F12 (a) and (b), F13, F14.
9. F15, F18, the rest of F19.

F12 (d) comes after F11 because an acceptance under a standing ruling must leave obligations. F4's blocked hand-back and F10's fourth answer both add a way for a seat to say "not from here"; they do not depend on each other.

## 6. Compatibility and acceptance

- **Additions only.** New flow events: `obligation` and its owner and waiver events, the served receipt, the parked commit of a blocked hand-back, a run's kept artifacts, a hand-back's attachments, `standing` and its withdrawal. New record kinds: `hold.placed`, `hold.released`. New optional fields: the `tasks` and `repairs` dimensions of an instruction's scope, a standard's `check`, a judgment's fourth answer, a declared command's artifact paths, a question's `before-review` or `later`, a note's `replaces`, the materials of Constructor and Reviewer cards.
- **A 4.3 memory opens in 4.4 with no migration.** A step queued by 4.3 gets its 4.4 card at the claim.
- **Going back.** [fact] A 4.3 engine folds a record kind it does not know without an error and ignores it (memory/projection.ts). On a 4.4 memory it would dispatch a held step, print an addressed instruction by its paths alone, and ignore a standing ruling. Limitation: do not go back to 4.3 on a memory that has holds, addressed instructions or standing rulings in force.
- **Acceptance on a real task [H-4].** Both surveys of 2026-11-27 are asked again on a project running 4.4, and these are measured against field A:

| Measure | Field A on 4.3 | Target |
|---|---|---|
| Median Constructor card after three weeks | 256 KB | under 64 KiB |
| Share of card bytes that are constraints | 74% | under 40% |
| Must-read pages of a Secretary decision, median | 18 | 6 or fewer |
| Dispatches whose report says something was missing | 75 of 1,177 | under 2% |
| Reviews claimed before the answer to their Constructor's questions | 100 of 178 | 0 |
| PM answers given before the inbox showed the escalation | 71 of 120 | 0 |
| Holds and ordering instructions carried in notes | about 60 | 0 |
| `sec next` output that repeats the pass before | 99% | under 20% |
| Items left at the cap that have an owner | not recorded | all |
| Cap decisions that needed a PM read | 47 | only what the standing ruling reserves for the PM or does not cover |

## 7. Questions for the maintainer

| | Question | Default in this plan |
|---|---|---|
| M1 | May the Secretary settle a used-up loop under a standing ruling of the user, without sending it to the PM (F12 d)? It reverses a line of the Secretary's handbook. | Yes, for what the ruling covers, on words in force, shown with a label. The program applies nothing by itself. |
| M2 | May the Reviewer read the Constructor's hand-back report (F3)? It reverses a line of the Reviewer's page. | Yes, as claims to check; it may be cited only for a `report` standard. |
| M3 | May a Constructor hand back "blocked" with no product, not counted as an attempt (F4)? | Yes, at most twice per attempt. |
| M4 | Does an addressed instruction that was not followed block a pass (F1)? | Yes. |
| M5 | Does a repair's reopen start a fresh rework loop (F12 a)? | Yes. |
| M6 | Are a daily repeating window for a resource and re-binding without a review in 4.4? | No. Both are named in §8. |

Nine of the ten questions of the first draft keep their defaults: an instruction does not change a standard (F1); it holds for the task's lineage until withdrawn (F1); a Constructor's open question holds its review (F4); an obligation blocks nothing by default (F11); "checked in the field" is recorded as the user's statement (F15); the Secretary may place a hold without words (F6); a standard that cannot be verified does not send the task back (F10); a review may cite what a declared run wrote outside the commit, and reads but does not cite what a seat hands in (F10); a standard says how it is checked and many standards raise a warning (F10). One default of the first draft is dropped: a PM answer resting on a one-off instruction (F18 says why).

## 8. Not in 4.4

- Anything that depends on a harness: the Historian and its interface, the program that runs the loop, the stop as one action.
- Re-binding a kept product without a review; the exit of issue 52.
- A hold that repeats daily.
- Ending a dispatch whose card is out of date at its first read.
- The program applying a standing ruling by itself, with no seat reading the case.
- A PM answer that rests on a one-off instruction.
- A severity on a Reviewer's findings; a tag for where a problem came from.
- An obligation that blocks the acceptance of another task.
- Field notes written by the Secretary for its own later use: decided when F1, F6, F7 and F11 are in use and it is known what the private notes still hold.

## Appendix A: facts of the first draft corrected by the record

| The first draft said | The record says |
|---|---|
| A card is 300,000 to 340,000 characters | Only in the last two weeks; the run-wide median is 141 KB for a Constructor |
| Most constraints open with a clause telling other tasks that nothing applies | 98 of 354 versions |
| The claim refreshes the card | Not for architect-repair |
| The Reviewer's card shows neither the Constructor's questions nor the answers | It shows an answer applied before its claim; it never shows the questions |
| The PM cited older words 16 times because an answer on a one-off instruction is refused | 3 refusals for words not in force; 16 is every failed answer command |
| The Reviewer of a simulator task answered in every round that no run report was tied to the candidate | 19 of 57 non-pass reviews; every round for 2 of 19 such tasks |
| Repairs add tasks rather than reopen | 19 of the first 39 repairs reopened 31 accepted tasks; none after that |

## Appendix B: the first review round and what it changed

v01 was reviewed once by a second model within fixed limits: four questions (fit, facts, harm, gaps), at most 12 findings, two severities, evidence required for each. All 12 findings were taken.

| Finding | What it said | What changed in v02 |
|---|---|---|
| R1-1 blocker, F12 | The field's rule at the cap needs a finding to be classed as a design gap or as minor; a program applying one outcome would accept what the user reserved for the PM | F12 (d): the Secretary applies the standing ruling on its decision card; the program applies nothing; M1 reworded |
| R1-2 blocker, F10 | A hash identifies a file, not the candidate that produced it; a judgment resting on it must not be renewed as if a rerun restored it | F10: evidence is registered at the hand-back with its candidate; only evidence of the candidate under review can be cited; the judgment is marked as resting on an external observation |
| R1-3 blocker, F11 | A Reviewer's card lists only issues of its own lineage, so an obligation assigned elsewhere never reaches its owner's review | F11: an assigned obligation is printed on its owner's Constructor and Reviewer cards and is answered there |
| R1-4 blocker, F11 | Findings and failed runs accepted as risk got no obligation, and an unassigned one never reached any warning | F11: every accepted risk becomes an obligation or is waived with a reason; the decider owns it until it is assigned; the inbox counts those not yet assigned |
| R1-5 blocker, F13 | A second repair's reopen of the same accepted attempt is skipped in silence and would still read as done | F13: reopens are merged or pinned again, never dropped; "done" needs the repair's own issue on an accepted attempt's card |
| R1-6 blocker, F8 | The pass inside `sec wait` would move the cursor and mark notices delivered before the Secretary saw them | F8: only a `sec next` result returned to its caller moves the cursor or marks delivery |
| R1-7 blocker, F4 | A second pause on one attempt has no escalation of its own, and edits made before a pause are lost with the worktree | F4: an escalation per pause; a parked commit that the resumed dispatch starts on |
| R1-8 blocker, F1 | Repair ids repeat across missions; an address without a mission could reach another mission's cards | F1: an address is bound to one mission |
| R1-9 major, P4 and F4 | 177 counts escalations of 1 to 7 questions, and an escalation is applied as a whole even when one question was put off | P4 restated; F4: each question is `before-review` or `later`, each is answered or deferred with an owner, and a deferred one becomes an obligation |
| R1-10 major, F6 | Field holds on one review and on one repair's Architect step fit neither a task hold nor a hold on everything | F6: a hold on one queued step |
| R1-11 major, F15 | A repair for a new request also cites older items, so "linked to no item" would hide it | F15: a repair is listed under its own words unless the PM links it to an item |
| R1-12 major, F18 | A one-off instruction used for an answer must hold for exactly that answer through its application | F18: not taken; §8 |

## Appendix C: the second review round and what it changed

v02 was reviewed once more within tighter limits: a status for each first-round finding, and at most five new findings. Its verdict was "not ready". Nine first-round findings were confirmed resolved (R1-1, R1-5 to R1-12). Three were not, and five new findings were made. All eight were taken. **These changes have not been reviewed again.**

| Finding | What it said | What changed in v03 |
|---|---|---|
| R1-2 not resolved, F10 | Registering a file with the hand-back that names it still does not say which build produced it; a hand-back in the field cited an earlier attempt's reports | F10: only files written by a command the program ran on the candidate are evidence; anything else is an attachment that can be read and cannot make a standard met |
| R2-1 blocker, F10 | Marking a judgment as resting on an external observation collides with an integration pass that must cite its declared full run | F10: the mark is not taken; no judgment needs it |
| R2-2 blocker, F11 | A report that shows a failure would still discharge an obligation to verify, and release a delivery block | F11: a `verify` obligation is discharged only by an outcome that it holds |
| R1-3 not resolved, F11 | A repair that reopens tasks and adds none had no way to hand its obligations to them | F11: a repair's decision gives its obligations to tasks it adds, changes or reopens; those it gives to none stay with their decider and are named |
| R1-4 not resolved, F11 | Obligations read from 4.3 records had no owner and were outside the inbox count | F11: their owner is the decider recorded on the acceptance |
| R2-3 blocker, F4 | A deferred question had no answer path between its deferral and the acceptance | F4: it becomes a `decision` obligation at once, answerable at any time; the obligation record ships with F4 (step 4) |
| R2-4 blocker, F13 | Two repairs changing one task's card: the later replaces the whole card and removes the earlier change in silence | F13: a decision is returned once when a card it changes is no longer the card its Architect saw |
| R2-5 major, F11 | When an owner is accepted with risk, the ruling drops the Reviewer's confirmation that an assigned fix was made | F11: the Reviewer's answers are kept on the accepted product and read by the obligation list and the fix tracker |

Both rounds found their gravest problems in the same two fixes: evidence from outside the commit (F10) and obligations (F11). They are the parts of this plan most likely to change again when they are built.
