# Mission Pipeline 4.4: the PM stays the anchor (v10, approved)

Status: v10, 2026-11-27. **Approved by the maintainer on 2026-11-27 (H-11) and in force as the design of 4.4.0**, together with the parts of the repair plan that stand (section 7). v10 differs from v09, the version that was reported and approved, only in this status, in ruling H-11 and in the plan's file name. G1 to G8 went through two bounded review rounds (Appendix A and Appendix B) and the maintainer took their defaults (H-8). G9 answers the ruling that a new requirement and a repair are separate (H-9). Its first form, an "addition" with a plan's reviews, went through two rounds (Appendix C and Appendix D) and was then withdrawn by the author: checked against the maintainer's principles at their source (section 0.1), it put back the reviews that D-10 took off this kind of work (Appendix E). G9 was rewritten in v07 and reviewed twice with the principles as the first question (Appendix F and Appendix G). Both rounds agreed that it needs no new ruling. v09 carried what the second round changed; those last changes were not reviewed again. This document amends the 4.4 repair plan (`DesignDoc_MissionPipeline_4.4_2026-11-27_v04.md`, "the plan" below): it replaces the parts of the plan that concern the PM, and section 7 lists what it withdraws. Builds on 4.3.0 with the nine field fixes of pull request 70. A 4.3 memory opens with no migration; new events and fields are additions only.

## 0. Calibration

- **A ruling** is cited by its id with its meaning. F-1 to F-9 are the rulings of 4.3 (`DesignDoc_PMSecretary_2026-11-06_v03.md`). D-1 to D-12 are the rulings of 2026-10-17 (`DesignDoc_ExecutionRedundancy_2026-10-17_v01.md`). E-1 to E-5 are the rulings of 2026-11-05 (`DesignDoc_UserAuthority_2026-11-05_v01.md`). H-n are the rulings for this work, stated in the author's words.
- **[fact]**: verified in 4.3.0 source (file and line) or taken from a field record.
- **[proposal]**: the author's. Each was not in force until ruled; H-11 rules them all.

| Id | The maintainer's ruling for this work, in the author's words |
|---|---|
| H-1 to H-5 | As in the plan: 4.4 solves what does not depend on a harness; shortcomings are found on real tasks; the plan is continued from the problems found and reviewed in bounded rounds. |
| H-6 | The plan gave the PM work that the rulings of 4.3 give to other roles. A design is checked against the philosophy of 4.3 at its source, and a report says, for each change, what happens today and what the change is for. |
| H-7 | Leave slack, and a way through for the PM. No process is perfect. The tighter it is locked, the more budget a real problem costs to solve or to get around. Earlier versions paid for this. |
| H-8 | The defaults of v03's five questions are taken: a question of design is the Architect's to answer in one step (G1); the Secretary may record an instruction for tasks (G3); superseding keeps and marks what is not named, with authorizations and waivers still accounted for (G7); evidence outside the commit follows E-4 in execution reviews (section 7). F-7 stands as it is. |
| H-9 | In 4.4 a new requirement and a repair are separate. D-10 named a missing feature among the reasons for a repair; that example no longer holds. |
| H-10 | The maintainer gives principles, not details. A choice between designs is the author's to make from those principles, with the principle it follows named. A question goes to the maintainer only when a design cannot be done without changing a principle, and then it says which principle, why the design runs against it, and what the principle would become. |
| H-11 | The design as it was reported on 2026-11-27 is approved: G1 to G9 of this document and the parts of the plan that stand. Every part tagged [proposal] in either document is thereby in force. A conflict that comes up while it is built or reviewed is settled by this design, unless the author sees a better way that breaks no principle; such a deviation is recorded. It is built and released when complete, as one version. |

## 0.1 The principles this design is held to

The maintainer's, read at their source and stated in the author's words. Each fix below is checked against them, and the review's first question is whether one is broken.

| | Principle | Source |
|---|---|---|
| P-1 | Mission Pipeline exists so that agents produce results that are responsible to the user. | README; 4.3 section 1 |
| P-2 | It is a process, not a part of one tool. A seat is a role that anyone can fill. Nothing depends strongly on one model or harness. The memory is neutral: copy the folder and any harness goes on from it. Security and logins are the harness's. | U-1, U-2, U-3 (4.1) |
| P-3 | The user guides direction and accepts no details. Only the most important design decisions reach the user. Where the user decided, the user's words settle it; every stop has an exit the user's words can take; a check is waived only by the user's words. | U-10, D-9, D-12, E-1, E-2 |
| P-4 | Mostly correct is enough, and the process keeps slack. It does not buy perfection with time and space. A rare case gets detection, a safe default and a work instruction, not a new mechanism. The process has enough redundancy; execution has too much. Fault-finding never ends. | U-7, U-8, D-1, D-2, D-3, E-1, H-7 |
| P-5 | An agent is set to watch only where an error would not show by itself. What shows by itself is left to the program's fixed rules, to real results and to the record. No layer watches the watchers. A fixed rule a program can run gets no agent. | 4.0 principles 2 and 11 |
| P-6 | Each role answers for its own part: the decision layer says what, the execution layer makes it, the acceptance layer judges it. A seat knows its direct upstream and downstream. The PM is the anchor, the Secretary decides within the plan, and the program writes no judgment in a seat's place. | 4.0 principles 1 and 6; D-4 to D-7; F-1 to F-4; U-15 |
| P-7 | The record is honest and no larger than it needs to be: the database is the skeleton and Markdown the leaves; details are pointed to. Nothing unproven is called proven. A close is never blocked and says what is proven, not proven, unfinished and at risk. Data outside the commit counts as evidence with its hash. | U-13, U-14, D-11, E-4; 4.0 |
| P-8 | An exception stops only the action it affects. A refusal or a pause acts on that scope alone and has a work instruction. | 4.0, the rules for exceptions |
| P-9 | A repair takes the light path: the Architect and the mechanical checks only, with no Calibrator and no feasibility review. The PM labels its kind; the user's words are its reason. A missing feature was named among its reasons. | D-10 |
| P-10 | Shortcomings are found on real tasks. | H-4 |
| P-11 | Work whose acceptance can be written in advance is an execution task. Work whose acceptance cannot be written in advance is an exploration, and it is accepted by being attacked. | 4.0 principle 10 |


## 1. What the PM is

From F-1 to F-4 and the PM handbook's core and "Never" list.

**The PM's work:**
1. Be of one mind with the user: understand their logic and needs.
2. Record the user's words verbatim, tag them, and keep them current (F-6 to F-9).
3. Turn the words into requirement items and long-term constraints; write the plan at the level of results.
4. Decide the big questions on the recorded words (F-3): a change of plan structure (tasks or deliverables added or dropped, interfaces between modules, data formats or storage), a change to what the user gets, an irreversible step outside the project, a conflict with what the user said. Words support a choice: decide. They do not, and the impact is major: ask the user.
5. Stops, and consent to deliver and land.
6. Report at the end and let the user judge; a problem the user finds becomes a repair (D-9, D-10).
7. Answer the user's questions about progress.
8. Start the Secretary; contact it only for the user's progress details or a new instruction (F-4).

**Not the PM's:** dispatching, the loop, notices, work-instruction pages, exceptions, releases (the Secretary's, F-2); everything within the plan (the Secretary's, F-3); splitting work into tasks, standards and write paths (the Architect's); judging a product (the Reviewer's); proof (the program's). The PM never writes or judges the product and gives seats no instructions. It keeps its context clear of dispatch detail.

**What the rulings do not say** (the author's reading; it matters for §2):
- [fact] No handbook, role page or card says whose a design question inside a task is. The Secretary may not write or judge the product (plugin secretary SECRETARY.md:302), and neither may the PM (plugin pm PM.md:232).
- [fact] A constraint needs no words and its text has no limit of kind (cli/commands/pm.ts:637-675), so the PM's tool for the user's long-term rules also takes technical rulings.
- [fact] A repair carries a quoted part of the user's words and a kind; nothing says who states its scope (flow/plandoc.ts:387-396).

## 2. What the field showed on the PM

Field A is one project on 4.3.0 for 22 days (1 mission, 1,200 dispatches). Field B is a second project with small missions in fast mode; its Secretary reports that no PM decision was needed during a run. So what follows appears when a mission is large, reworks are many and the user is closely involved.

### A. The PM did work that is not its own

| What happened | Evidence (field A) | Why |
|---|---|---|
| It read reports to rule at the review cap | By its own estimate 45% to 55% of its context went to review reports, hand-backs, cards and images; 10% to 15% to understanding the user. 25 compactions in 22 days | 123 escalations (41% of the Secretary's rulings) were sent up. [fact] What the PM's inbox prints for one is a summary line and the option names; the Secretary's reason, its notice "what the PM is told", the meaning of each option, the escalation's reasons and any pointer to the review are not shown (process/secretary.ts:138; flow/secretary.ts:299-306). [fact] One decision takes one option for the whole escalation, so one finding of the PM's class sends every finding up (flow/secretary.ts:69, 401) |
| It wrote technical rulings | 169 constraints in 354 versions. Of its 120 answers 64 were answers with its own instructions, and 1 chose a re-plan | A design question has no owner (§1). Of 70 sampled Constructor questions 20 were decisions nobody had made, and all 20 went to the PM. [fact] The way back to an Architect is `replan`: the whole plan is decomposed again, then the mechanical checks, the feasibility review, Calibrator 2 and the PM's structural approval (flow/execution.ts:2119-2131; flow/planning.ts:1066-1091, 1423-1447). The light way, one Architect step under the mechanical checks, is a repair, and only the PM can file one, on the user's words (cli/main.ts:139) |
| It stated the scope of each repair | On one late card 26 constraints, 64% of the constraint bytes, are the scope and rulings of one repair each | The repair has no place for it. [fact] The Architect's own note on its repair decision is not recorded and reaches no card (flow/repair.ts:327, 331) |
| It kept the list of what was left at the cap | An "owed" list in its private notes; 7 repairs filed for leftovers | [fact] An acceptance with risk stores a sentence per reason. The tree and the close read those sentences; status does not; nothing links one to the work that later handles it (flow/execution.ts:1279; cli/tree.ts:450; process/close.ts:232) |
| It put rulings and answers into notes to the Secretary | Of 140 notes, 34 are rulings for one task and 24 are answers to escalations | [fact] Outside an escalation only `mp pm constraint` writes text that reaches a card; the Secretary has no such record (cli/commands/secretary.ts:102) |

A loop follows from the second row: constraints fill the cards (74% of all card bytes), seats miss what concerns them, and they ask. Of the sampled Constructor questions 23% had an answer already in the memory.

Not on this list: the holds and the order of work that the PM passed on in notes. The record shows the user's words came first for the holds on everything and for the order of work; passing on a new instruction is the PM's (F-4). The problem there is that the memory has no place for such an instruction.

### B. The PM's own work was not done as designed

| What happened | Evidence (field A) | Why |
|---|---|---|
| Earlier words were never superseded | 186 entries, 0 superseded, while rules changed often; the PM made new constraint versions and edited a rule file (77 edits) | [fact] Superseding or re-tagging refuses unless every dependent of the entry (each requirement item, each constraint recorded with it, each waiver) is listed as withdrawn or kept; there is no shorthand, a kept one is not marked anywhere, and `--supersedes` works only at the first tagging (memory/words.ts:105-116). [fact] No read connects a words entry to its constraints (cli/tree.ts:260-266) |
| Layer 1 overflowed and stayed so | "448 more entries", "15 more principles"; no summary was ever written | [fact] Every constraint takes a line, placed before the inbox and before every mission line; every decision applied in an open mission takes a line; when the principles alone overflow, every other line is dropped, the inbox included; a summary cannot cover principles, constraints or decisions (cli/pmMemory.ts:15, 43, 50-55, 69-71) |
| Before a decision it did not read the words again | Its own account | [fact] After each PM answer the command prints every tag in force that the answer did not cite, with the whole entry text, with no filter by subject and no limit (cli/commands/pm.ts:792-793) |
| A new PM session did not "lose little" | 55 private files, about 345 KB, kept in the harness's own folder | Everything in table A had to be tracked by the PM itself; no read lists the notes it sent (process/secretary.ts:42-47) |
| Messages were recorded at once that F-7 makes wait | 126 of 302 tags are one-off instructions: the PM tagged a message it had to act on as an instruction to get its id | F-7 records a one-off instruction on the spot, with all the message's tags, and makes every other message wait for the user's next one; a requirement, a constraint or a plan that cites it waits too. [fact] Nothing in the code defers a recording or keeps a pending state (process/pm.ts:779-795) |

**New requirements came in as repairs.** In field A 19 of 56 repairs carried a new or a changed requirement of the user: 75 tasks added, 445 of 1,200 dispatches. The PM labelled 13 of them `missing` and the others `defect`. The seats that check a plan (both Calibrators, the Architect's decomposition, the feasibility review) last ran on day 9 of 22; from then on every change entered through a repair. D-10 allowed it; H-9 now rules that the two are separate. G9 says why the PM recorded no requirement for them and what changes.

### C. The PM lacked the means for its own work

| What happened | Evidence (field A) | Why |
|---|---|---|
| Its inbox did not show what was sent to it | 71 of 120 answers were given before the inbox could show the escalation; 7 failed answers were guesses at an id | [fact] The decision's record is written at the Secretary's next pass (issue 62; the plan's F9 fixes this) |
| It could not answer by the user's own requirements | The user's most frequent question; the PM built the table by hand each time | No read exists; reads cannot tell an acceptance after a pass from one with risk |

### The three roots

1. **A design question inside a task has no owner, so it lands on the PM.**
2. **What goes up to the PM is not condensed, and what comes down has no path of its own.**
3. **The machinery of the user's words costs too much at each use, so the PM went around it.**

## 3. Rules for this design [proposal]

- **R1. Who acts.** A fix names the role that acts, and that role may act so under F-1 to F-3. What a field PM was seen doing is evidence of what pulled it in, not a duty to serve.
- **R2. A default, not a lock (D-1, H-7).** A fix changes what happens by default. It adds no refusal to a command the PM has today. A new check warns.
- **R3. A way through (E-1, H-7).** The PM, on the user's words, can still settle anything directly. Each fix says what that way is.
- **R4. Less before more (D-1).** A change of a page, a default or a printed line comes before a new record.

## 4. The fixes

Each fix says what happens today, what the change is for, the change, the way through that stays, and the residual.

### G1. A design question is answered by an Architect, in one step [proposal] (root 1)

- **Today.** A Constructor's question, a Reviewer's "needs a decision" and a used-up loop each offer `answer`, `replan` and `ask-pm`. [fact] `replan` decomposes the whole plan again and runs every review of a plan. `answer` needs someone to write the instructions, and neither the Secretary nor the PM may design the product. So the field's deciders answered anyway: the PM 64 times, with instructions of its own.
- **For.** A question about design that the plan left open is answered by the role whose work the plan is, at the cost of one step, and no plan changes on the way.
- **The change.** A new option on those three kinds of escalation: **ask the Architect**. One Architect step gets the task, the question and the decider's instructions, with the task's hand-back, its last review and its accepted product readable (the plan's F3). The task waits, as it waits for any decision. The step changes no card, no standard and no structure. It hands back one of three things:
  - **An answer.** It is recorded on the escalation that asked, as its answer, and so reaches the asking task's next cards as any answer does. Where the answer names other tasks, it is printed on their cards too (G3).
  - **"The plan has to change", with what and why.** The escalation returns to the Secretary with that reply on its card. The Secretary then chooses among what it has today: `replan`, or `ask-pm` where the change is of the PM's class.
  - **"I need to know this first."** The escalation returns to the Secretary with the Architect's question.
- **`replan` is unchanged.** A decider that already knows the plan must change chooses it directly, as today.
- **Why the step changes nothing.** A change of a standard may change what the user gets, which is the PM's to decide (F-3). A plan's reviews are waived only by the user's words (E-2), and the lighter path of D-10 is for a repair, whose reason is the user's words. So a changed standard keeps its two ways: the reviewed re-plan, or a repair the PM files on what the user said.
- **The pages.** The Secretary's handbook and card gain what they lack. The Secretary settles what is reversible and within the plan itself, as F-3 rules, including a reading of the plan or of the user's words. It asks the Architect when the question is one of design: the plan would have to say something it does not say. It does not send a question to the PM because it is about design.
- **The way through.** `answer`, `replan` and `ask-pm` stay on every card. The PM or the user may answer any escalation on the user's words (E-1).
- **Residual.** An Architect step takes longer than a PM answer (median 18 minutes for a repair's Architect in field A, against 3 to 20 for a PM answer). A standard that has to change still costs the full re-plan or a repair on the user's words. A project whose user rules that design gaps go to the PM keeps that rule; it is a constraint of that project. Where the line between a reading and a question of design falls is the Secretary's judgment.

### G2. What reaches the PM is the Secretary's brief, shown in the inbox [proposal] (root 2, going up)

- **Today.** [fact] The Secretary's decision already has a field "what the PM is told", required whenever it sends a question up (seat/cards/secretary.ts:91, 132). The inbox does not print it. In field A the Secretary wrote 23 files outside the memory to tell the PM what it was sending, and the PM opened the Secretary's card and the reports to find the question.
- **For.** The PM decides from the inbox item and the user's words. It opens no card and no report.
- **The change.** An inbox item prints the Secretary's notice in full, its reason, each option with what it does, and the requirement items and words entries the task rests on, by id. The escalation's own reasons follow, shortened, with the read that gives the rest. The Secretary's card asks for the notice in four parts: the question; the options and what each leads to; which words of the user bear on it; what the Secretary would choose and why. No format is checked.
- **Also.** After a PM answer the command prints the principles in force and a count of the other tags with the read that lists them, in place of every entry's whole text.
- **The way through.** Every read the PM has today stays.
- **Residual.** A poor notice gives a poor brief, and nothing checks its quality. The item carries the escalation's reasons and the ids of the records behind it, which the PM may read. It is not a reason for the PM to contact the Secretary: F-4 keeps that for the user's progress questions and new instructions.

### G3. Text that reaches a task comes from the role that owns it [proposal] (root 2, going down)

- **Today.** [fact] Outside an escalation the only text that reaches a card is a constraint, only the PM can write one, its author is not recorded, and its scope is a mission, paths and task types (flow/requirements.ts:49-57; cli/main.ts:138-139). A decision's `answer` reaches the task's cards until the task's next spec and is then dropped without a trace (seat/cards/dynamic.ts:84-94). The Architect's note on a repair is not recorded. A repair is not shown on the cards of tasks whose card it changed (flow/execution.ts:576-586).
- **For.** The PM has no need to write for a task. The Secretary and the Architect can, and what they write arrives.
- **The change.**
  - **The Architect.** The note of a repair's decision is recorded and printed on the cards of the tasks it added, changed or reopened. An Architect's answer (G1) is recorded on the escalation that asked, and is printed as well on the cards of other tasks it names. The repair itself is shown on the cards of tasks it changed, and on every later attempt of a task it reopened.
  - **The Secretary.** `mp sec instruct` records an instruction constraint as the Secretary's: a ruling within the plan, never a proof input. It is the Secretary's way to say once what it otherwise answers many times. In field A one such ruling was given 22 times on 15 tasks.
  - **An address.** An instruction constraint may name tasks or a repair of one mission. It is then printed on those tasks' cards, on that repair's Architect card and on the cards of the tasks the repair added, changed or reopened, and nowhere else. Architect cards print addressed instructions of other subjects as an index.
  - **The author** of a constraint is recorded (PM or Secretary) and shown in reads.
  - **Earlier answers.** After a new spec the answers given before it are listed on the task's cards under "earlier decisions on this task", one line each.
  - **The PM.** A `decision` requirement item may name the tasks it concerns and is then printed on those only. [fact] Today a decision recorded after the plan took effect is printed on every card (seat/cards/dynamic.ts:69-96).
  - **Size.** A dispatch reports its card's size to the Secretary; the report names the largest sections. No notice goes to the PM.
- **The way through.** The PM's constraint command is unchanged, and it accepts an address too. Nothing refuses a PM instruction for one task. The handbook says when: the user said it. That another path failed gives the PM no authority it did not have (F-3). `mp read constraints --reach` shows each constraint with its author, its addressees and its size, so a PM that writes for tasks again can be seen.
- **Residual.** The field's existing constraints stay as they are until their scope is changed, one command each, with no new version [fact: flow/requirements.ts:212-236]. The line between an operating instruction (the Secretary's) and a design ruling (the Architect's) is drawn in the handbook, not in code.

### G4. The scope of a repair is the Architect's [proposal] (table A, third row)

- **Today.** The PM files the user's sentence and a kind. The Architect decides what to add, change and reopen. In field A the PM also wrote each repair's scope as a constraint for every task.
- **For.** The PM files what the user said and stops there.
- **The change.** Nothing new for the PM. The Architect's note reaches the repair's tasks (G3). The repair's Architect can read the accepted products it may reopen (the plan's F3). `mp pm repair … --items <ids>` names the items left open that this repair is for (G5), and the Architect's card lists them.
- **The way through.** Where the quoted sentence is not enough, the PM records more of what the user said, or addresses an instruction to the repair (G3).
- **Also.** A repair's Architect that cannot decide may hand back its question with no edit. [fact] Today a hand-back with a note alone is refused (seat/cards/architect.ts:482). The question goes to the PM's inbox as its brief, because the repair is the PM's filing on the user's words.
- **Residual.** None named.

### G5. What is left at the cap is recorded by the program and read by anyone [proposal] (table A, fourth row; table C, second row)

- **Today.** An acceptance with risk stores a sentence per reason. The tree and the close show them; status says "accepted" and the proof label reads proven; nothing links a sentence to the work that later handles it. The PM kept the list.
- **For.** What was left, and what became of it, is in the record. The PM answers the user by requirement without a list of its own.
- **The change.**
  - At an acceptance with risk the program writes one **open item** for each risk accepted: each standard not met or unclear, each issue not fixed, each finding and each failed run among the reasons. It has an id, a kind, its text, and the task and attempt it came from.
  - An open item is **taken** when a repair or a re-plan names it and gives it to a task. It is then printed on that task's cards, and its Reviewer answers it: fixed, not fixed or unclear. It is **closed** when that task is accepted and the review of the accepted attempt answered it fixed, whether the acceptance followed a pass or a ruling. The Reviewer's answers are kept on the accepted product when a ruling accepts other risks. [fact] Today a ruling that accepts with risk carries an empty list of issue responses (flow/secretary.ts:649).
  - `mp read open-items <mission>` lists them with their age, how often they were carried, and what took them. `mp read items <mission>` gives one line per requirement item and one per repair under its own words, with its state; "accepted with risk (n open)" is told apart from "accepted". The close lists every open item (D-11).
  - The Secretary's card for a used-up loop shows the open items of that task. When what is left is a question of design, the Secretary asks the Architect (G1), or chooses `replan`, in place of an acceptance.
  - `mp pm verified <mission> <item|repair> --words W-n` records the user's statement that something was checked in the field and holds. It closes the open items it names, as the user's statement and never as proof.
  - **A question put off stays open.** The plan's F4 lets an answer defer a question, and lets a Constructor mark one as due later. [fact] An applied escalation takes no further answer (flow/secretary.ts:411); in field A an approval deferred on attempt 1 came on attempt 3 through another escalation. Such a question is an open item of kind `question` from the moment it is put off, whether or not the task is later accepted with risk. The decider it belongs to under F-3 answers it at any time, and the answer goes onto the task's next card. Nobody assigns it.
  - **Earlier records.** The risk sentences of acceptances made under 4.3 are listed with the new items, marked "what became of it is not recorded". No migration.
- **Not taken from the plan:** an owner for every item; assignment by the PM; a count in the PM's inbox; a forced choice after two carries; an item that blocks delivery. Nobody is prompted. D-11 rules that a close is never blocked, and D-9 that the user accepts no details.
- **The way through.** `mp pm open-item close <id> --words W-n --reason …` closes one on the user's words (E-1).
- **Residual.** Nothing forces an open item to be taken. An item nobody takes stays on the list until the close, which is what happens today, now on the record.

### G6. The user's instruction about when work runs has a place [proposal]

- **Today.** [fact] The only record is the stop, which also refuses hand-backs, runs, delivery and landing (process/pm.ts:269-299). In field A the PM passed about 60 holds and ordering instructions in notes, and the Secretary kept them in its own log; one held step was dispatched because its reminder lived only there.
- **For.** "Not this yet" is a record that harms no other work and that any session can read.
- **The change.** The hold of the plan's F6, with its roles stated. The order of work within the plan is the Secretary's: it places and releases holds for its own reasons. The PM places a hold when the user said so, with the words. Nothing in the engine refuses either. A hold names a task, a queued step, a resource or everything, and is released by another task's acceptance, at a time, or by hand.
- **The way through.** A note still works. A stop still stops.
- **Residual.** A window that repeats daily is still placed by hand each day.

### G7. The user's words cost less at each use [proposal] (root 3)

- **Today.** See table B.
- **For.** Superseding is cheap enough to be done; layer 1 shows what the PM must act on; a decision does not print the whole record at the PM.
- **The change.**
  - **Superseding and re-tagging keep what is not named.** A dependent the command does not name is kept, the command lists what it kept, and reads mark each as "rests on words that were superseded". `--withdraw-items` withdraws. Nothing is withdrawn implicitly, as 4.3 requires (Appendix A.9), and the command is not refused. `--supersedes` is accepted by `tag` and `retag` too.
  - **What gives power is still accounted for.** Keeping by default covers requirement items and constraints. An authorization item and a waiver give power: for each of those the command still asks whether it is withdrawn or kept, as today, and what 4.3 rules for them stands (Appendix B.3). [fact] A waiver for a whole mission applies to the next plan with no further command while any tag of its words entry is in force, and an authorization-backed one applies directly (flow/waivers.ts:133; memory/words.ts:48). They are few; the accounting that stopped the field PM was of 169 constraints.
  - **`mp read from W-n`** also reaches the constraints, waivers and notes that cite the entry.
  - **Layer 1.** Principles stay first within the bound, as 4.3 rules (Appendix B.5). One line always says how many inbox items wait and names the read; inbox entries follow as they fit. Of constraints it lists those of the PM that carry no address; the Secretary's instructions, addressed instructions and constraints whose missions are all closed take no line. When principles overflow, the lines after them are counted, as today.
  - **Recording.** Nothing changes. F-7's line stands: a one-off instruction is recorded on the spot with the message's other tags; anything else waits for the user's next message. The handbook does not make the PM's need for an id a reason to record. §9 puts what the field showed to the maintainer.
- **The way through.** Unchanged commands; `--keep-items` still works for a PM that wants to account for each.
- **Residual.** No command withdraws a wrongly recorded entry; re-tagging it as a one-off instruction takes its force away. Finding which earlier words a new sentence touches stays the PM's reading; the Historian of the DSH edition is the place for more.

### G8. Notes [proposal]

As the plan's F7: `mp pm note … [--replaces N-x] [--file <file>]`; `mp read notes [--all]` lists every note with its state. With G3, G5 and G6 a note carries what F-4 means it to carry: a new instruction of the user.

### G9. A new requirement is recorded as one, and takes the light path a repair takes [proposal] (H-9)

- **Today.**
  - [fact] A new requirement and a repair both enter through `mp pm repair`. Its kind (`defect`, `usability`, `missing`, `new-question`) changes no behaviour, and the record has no field for a requirement item (flow/plandoc.ts:385-396). In field A 19 of 56 repairs carried a new or a changed requirement, and no requirement item was recorded for what they brought.
  - [fact] The PM has a reason not to record one. Recording a requirement item writes a new version of the mission's requirement set (flow/requirements.ts:180-183); the plan's Calibrator 1 judgment is bound to that set (flow/planning.ts:284), so every product then reads "not fully proven", and in stable mode no new work starts until the plan is checked again, unless the plan's reviews were waived, by the user's words, by an authorization or by the configuration key (evaluator/semantics.ts:509-514, 1199-1210; flow/execution.ts:1125-1139; flow/waivers.ts:88-98). One new wish that touches nothing built stops everything.
  - [fact] The architect-repair card lists no requirement items at all, so the Architect of a repair does not see the limits and acceptance items the user set for the mission (seat/cards/architect.ts:425-446). An Architect that decomposes a plan gets every one of them (flow/planning.ts:1484-1491).
  - [fact] A Reviewer's judgment is bound to the versions of the requirement items its task carries (seat/cards/inputs.ts:14-17; flow/execution.ts:2540). Its card does not show their text: it shows the standards and the decisions (flow/execution.ts:2517-2537). The Constructor's card shows them (seat/card.ts:118). When an item changes, the review that follows names the old and the new version id and no text (flow/execution.ts:401, 477).
  - The user's most frequent question in field A was progress by their own requirements. Nothing could answer it for what came in by repair.
- **For.** The record tells a new requirement from a repair: a new requirement has a requirement item and is seen by requirement; a repair says what it falls short of. The way the work is done does not change.
- **How H-9 is read.** Read as a second path with a plan's reviews, H-9 would run against three principles: P-9, which took those reviews off this kind of work; P-5, because what goes wrong in such work shows by itself, to the Reviewer against its standards, at integration, and when the user tries the result (D-9); and P-4. Read as a separation in the record, it runs against none and removes what the field showed: a requirement the record did not hold. The author takes the second reading (H-10).
- **The change.**
  - **An entry of its own.** `mp pm extend <mission> --words W-n --item <id> --text … --quote …` records a requirement item for what the user now wants, quoting the user's words, and starts the work in the same write. When the user asks for several things, one filing carries several items, each with its own quote and, where it differs from the filing's, its own words entry, and they go to one Architect step. [fact] In field A one repair carried about ten requests from several messages of the user, and its Architect split them over twelve tasks. It is the PM's own work (section 1, item 3).
  - **It is for work whose acceptance can be written in advance (P-11).** A new question whose result cannot be given standards in advance is an exploration, and a new exploration is an element of the PM plan, as today. A further question inside an exploration that exists keeps the repair entry (E-5).
  - **The same light path.** The work goes to one Architect step under the mechanical checks, as a repair does (P-9). No Calibrator, no feasibility review, no approval step: none is added. What the Architect adds, changes or reopens applies as a repair's does today.
  - **The item stops nothing it does not touch (P-8).** The plan's check holds for the items it was made against. An item recorded this way is not one of them. So recording it, revising it or withdrawing it leaves that check as it was, and with it the proof of every product that is not bound to the item, and holds no other work. A product that is bound to the item follows the rules that exist. [fact] After a revision it reads "not fully proven", and it is reviewed again in stable mode or flagged in fast mode (flow/execution.ts:390-414). After a withdrawal it reads "basis withdrawn", and an escalation asks a decider what to do with it (flow/execution.ts:537-561). The item is a requirement item of the mission like any other, in force and read with the others. An audit of the whole mission covers every item in force, so an audit goes out of date when any item changes, as today.
  - **The work is bound to the item.** Every task the Architect adds, changes or reopens for the filing carries its item, with no action of the Architect's; so the Reviewer's contract binds it on each attempt. That holds for a filing with one item. When a filing has several, the Architect names on each task the items it serves. A task on which it names none is bound to none, and the reads show it under its filing with its item not named: the program does not guess a link the Architect did not state (P-6). [fact] A task's own requirement items join its product's contract today (seat/cards/inputs.ts:14-17). [fact] In field A one new requirement was met by changing three cards and adding no task.
  - **The user can take it back (P-3).** If every item of a filing is withdrawn before the Architect's amendment is applied, the filing ends there. A hand-back that arrives afterwards is kept on the record and not applied. [fact] In 4.3 a repair that is filed cannot be ended (flow/repair.ts:194-203), and its Architect must add, change or reopen at least one task (seat/cards/architect.ts:482). Once the amendment is applied, the rules above for a withdrawn item apply, and work in flight is stopped as any work is: by the PM's stop on the user's words.
  - **The Reviewer reads what its judgment is bound to.** The Reviewer's card shows the text of the requirement items its task carries, as the Constructor's card does. On a review that follows a changed item it shows the old and the new text. Its duty does not change: it judges each standard. If the standards no longer answer the item, it says so with the answer that sends a review to a decider (the plan's F10). This is what a seat needs to do its part (E-4), and it keeps a pass from being recorded against a text the Reviewer did not see (P-7).
  - **The Architect sees what the user already set.** Its card shows the new items and, by reference, the limit and acceptance items in force in the mission. This is what a seat needs to do its part (E-4), not a new check.
  - **A repair may name what it falls short of.** `mp pm repair … [--item <id>]`. The Architect's card shows the item, and it is bound in the same way. The flag is optional.
  - **The record says how work came in (P-7).** Reads show, for a task and its product, whether it came with the plan, with a new requirement, or with a repair, and that the last two passed the Architect and the mechanical checks and no plan review. `mp read items` gives one line per requirement item with its state. `mp read repairs` marks a repair that added tasks and names no item.
  - **Nothing is refused.** `mp pm repair --kind missing` still files a repair and prints one line that points to `mp pm extend`.
  - **When a changed plan is next submitted,** the items recorded this way join the set it is checked against, and the plan names them as it names every item. A re-check of the unchanged plan leaves them aside. Until then the reads show them apart.
  - **The pages.** The PM's handbook sorts D-10's three examples: a usability problem is a repair; a missing feature is a new requirement; a new question of an exploration keeps the repair entry (E-5). It says that a new exploration goes into the plan.
- **What does not change.** A change to an item the plan was checked against is recorded as today, and 4.1's rule applies as it stands. [fact] The plan and what rests on it read "not fully proven" until Calibrator 1 re-checks the unchanged plan in one step, and a product bound to the item needs its own review (PM handbook, the lines on a changed requirement). In stable mode new work waits for that re-check. This is the plan's check doing what it is for; this design does not narrow it.
- **The way through.** A change too large for one Architect step, and a new exploration, go through a changed plan, as today.
- **Residual.**
  - The program cannot tell a new requirement from a defect, or work whose acceptance can be written from an exploration. A PM that files one as the other is seen in the reads, not stopped.
  - No Calibrator reads the PM's wording of the new item. If the PM misread the user, it shows when the user sees the reply and tries the result (D-9).
  - A PM can file a changed requirement as a repair and leave the item's text as it was. The item then reads as the user first put it, and nothing detects that.
  - Work added after the integration task was accepted can reach the close with no full run on the combined tree. Whether to run one is the PM's call (D-7), and the close says what ran.
  - Between two submissions of a changed plan, the plan's proof covers the items it was checked against and not those added since. The reads say so.
  - [fact] A re-plan of the whole plan can drop the tasks a repair added, and the PM then records the repair again (Secretary handbook, the lines on a revised detailed plan). The same holds for a new requirement: its item then shows no work under it, and the PM files it again.
  - A repair that names no item still cannot be ended once it is filed, as in 4.3.
  - In a filing with several items, a task on which the Architect named no item is not reviewed again when one of them changes. The reads show it as not named.
- **Cost.** One command more than today's repair, one list more on the Reviewer's card, and no seat more.

## 5. Every problem and its fix

| Problem (§2) | Fix | What is left |
|---|---|---|
| Reads reports to rule at the cap | G1, G2, G5; the plan's F9 | A grant after the Secretary's own is still the PM's, now with a brief |
| Writes technical rulings | G1, G3 | The PM can still write one; it is visible. A standard that must change still needs the reviewed re-plan or the user's words |
| States each repair's scope | G3, G4 | — |
| Keeps the list of leftovers | G5 | Nothing forces an item to be taken |
| Rulings and answers in notes | G2, G3, G8; the plan's F9 | — |
| Words never superseded | G7 | Finding what a new sentence touches |
| Messages recorded at once that F-7 makes wait | None | Left as an observation (§9) |
| Layer 1 overflow | G7, G3 | Principles cannot be summarised |
| No re-reading before a decision | G2 | The PM's own discipline |
| A new session loses much | G3, G5, G6, G8 | — |
| Inbox does not show what was sent up | The plan's F9, G2 | — |
| Cannot answer by requirement | G5, G9 | — |
| New requirements came in as repairs, with no requirement recorded | G9 | The PM's reading decides which is which; nothing is refused |

## 6. Compatibility and acceptance

- **Additions only.** New flow events: the open item and its taking, answering and closing, the recorded note of an Architect's decision, an Architect's answer on an escalation, the entry of a new requirement and its item. New optional fields: the author of a constraint, the `tasks` and `repairs` of an instruction's scope, the tasks of a decision item, a note's `replaces`. New record kinds: `hold.placed`, `hold.released`. A 4.3 memory opens with no migration.
- **Going back.** [fact] A 4.3 engine ignores a record kind it does not know. On a 4.4 memory it would print an addressed instruction by its paths alone and dispatch a held step. Do not go back to 4.3 on a memory that has either in force.
- **Acceptance on a real task (H-4).** The survey of the PM is asked again on a project running 4.4:

| Measure | Field A on 4.3 | Target |
|---|---|---|
| Share of the PM's context spent reading reports, cards and images | 45% to 55% (its estimate) | under 15% |
| Share of the Secretary's rulings sent to the PM | 41% | under 15% |
| PM answers that carry instructions of the PM's own | 64 of 120 | a few, each on words of the user |
| Constraints the PM addressed to one task or one repair | 34 of 100 on one card | counted and shown; no target is enforced |
| Share of card bytes that are constraints | 74% | under 40% |
| Private files the PM needs to resume | 55 | none for holds, leftovers or notes |
| Words entries superseded when a rule changed | 0 of 186 | most |
| New requirements of the user that have a requirement item | none of those that came by repair | all |
| The user's question "how far is each thing I asked for" answered from one read | built by hand each time | yes |
| Repairs that added tasks and name no requirement item | not recorded | listed; a lead for a spot-check, not a count of errors |

## 7. What this withdraws from the plan, or loosens

| In the plan (v03) | Now | Why |
|---|---|---|
| F1: the PM addresses instructions to tasks as the ordinary path; the PM is told of large cards | G3: the Secretary and the Architect write for tasks; the PM's command stays as the way through | R1 |
| F1: an addressed instruction that was not followed blocks a pass | The Reviewer reports it; it blocks nothing. What must hold for a pass is a standard, and a standard changes through the Architect (G1) | R2 |
| F2: a repair brief written by the PM | G4 | R1 |
| F4: a third blocked hand-back in one attempt is refused | It is accepted and the Secretary is told | R2 |
| F10: only files a program run wrote are evidence; a file a seat hands in cannot make a standard met | E-4 as it stands, applied to execution reviews: a file outside the commit is cited with its sha256 and size, checked, labelled "outside the commit", and not refused. The card says which attempt handed it in. Whether it shows this candidate is the Reviewer's judgment, on the record. The file and the run are both on the record. When a renewal would rest on an observation the rerun did not repeat, the default is a new review, not a mechanical renewal. Where the proof contract cannot admit one judgment on both a declared run and an outside observation, as for an integration pass that must cite its full run, the review goes to a decider through the fourth answer and no rule is bent | E-4: "strictness made the record weaker" |
| F11: the decider owns each obligation; the PM assigns; an inbox count; a forced choice after two carries; a block on delivery | G5 | R1, R2, D-9, D-11 |
| F12 (d): a standing ruling under which the Secretary settles a used-up loop | Withdrawn. It brought back "within an authority" for the Secretary, which 4.3 removed under F-3 | F-3 |
| F13, last line: new requirements keep coming in as repairs | G9: a new requirement has an entry and an item of its own | H-9 |
| F18: `--supersedes` on re-tag; `read from` reaching constraints | Kept, in G7 | — |

What the plan says about seats and the loop stands: materials (F3), the Constructor's blocked hand-back and the review that waits (F4), the repair card rebuilt at its claim (F5), the loop's output and wake-ups (F8), a decision that takes effect at once and the inbox (F9), a standard that says how it is checked and the fourth answer (F10, apart from the evidence rule above), the cap as a setting and a repair's reopening (F12 a to c), reads of repairs (F13), re-binding with less noise (F14), one copy of a card (F17).

## 8. Order of work [proposal]

These steps join the plan's order at the places named.

1. With the plan's step 1 (F9, F8, F7): G2 and G8.
2. In place of the plan's step 2 (F1, F2): G3 and G7.
3. With the plan's step 4 (F4, F5): G1.
4. In place of the plan's F6: G6.
5. In place of the plan's F11: G5, then G4.
6. After the plan's F13 (reads of repairs) and G5: G9.

G1 needs the plan's F3 first, so that the Architect can read the hand-back, the review and the accepted product it is asked about.

The plan split its steps into two versions, 4.4.0 and 4.4.1. Under H-11 they are built and released together as 4.4.0.

## 9. Decisions the author made, and what needs a ruling

Under H-10 these were the author's to decide. Each names the principle it follows.

| Decision | Follows |
|---|---|
| H-9 is read as a separation in the record; a new requirement keeps a repair's light path and gets no review a repair does not get (G9) | P-9, P-5, P-4 |
| A new requirement's item is recorded, revised or withdrawn without taking proof off, or holding, what it does not touch (G9) | P-8 |
| `mp pm extend` is for work whose acceptance can be written in advance; a new exploration stays an element of the plan (G9) | P-11 |
| One filing may carry several items, and the item is carried by every task the Architect adds, changes or reopens for it. Where a filing has several items and the Architect names none on a task, the program binds none and shows it (G9) | P-4: less cost at each use; P-7; P-6: the program writes no judgment in a seat's place |
| A filing ends when the user withdraws every item of it before its amendment is applied (G9) | P-3: where the user decided, the user's words settle it |
| The Reviewer's card shows the text of the requirement items its judgment is bound to (G9) | E-4; P-7: no pass on a text the Reviewer did not see |
| `--kind missing` goes on filing a repair, and a repair that names no item is shown and not refused (G9) | P-4, P-8 |
| A change to an item the plan was checked against keeps 4.1's rule: one re-check of the unchanged plan (G9) | P-4: proof kept item by item would be a new mechanism, and the case the field showed, the new item, is removed without it |
| The Reviewer may read the Constructor's hand-back report, as claims to check (the plan's F3) | E-4: what a seat is asked to record must reach the seats that read it |
| A Constructor may hand back "blocked" with its questions and no product, and this is not counted as an attempt (the plan's F4) | E-3: a round is not lost to a counter; P-4 |
| A repair's reopening of a task starts a fresh rework loop (the plan's F12 a) | E-3; D-6: the task that caused a failure is reopened and fixed |
| A hold that repeats daily, and re-binding a kept product with no review, are not in 4.4 | P-4: no new mechanism without the evidence for it |

**Changes to a principle that need a ruling: none.** No fix in this document or in what stands of the plan changes one of P-1 to P-11. Both reviews of the rewritten G9 put this claim first and agreed with it for G9: a new execution requirement on D-10's light path needs no new ruling. One observation is left with the maintainer and no change is proposed: F-7 makes a message that is not a one-off instruction wait for the user's next message before it is recorded, and the field PM recorded at once whatever it had to act on.

## 10. Not in this amendment

- Anything that depends on a harness: the Historian, a program that runs the loop, a stop as one action.
- A decision that treats the findings of one escalation differently. G1 and G5 let the Secretary choose among an acceptance, a question to the Architect and a re-plan; splitting one escalation is a mechanism the evidence does not yet pay for.
- A lighter way to change a standard. It stays the reviewed re-plan or a repair on the user's words.
- A path of its own for a new requirement, with a plan's reviews on it (the "addition" of v04 to v06). Withdrawn: it put back what D-10 took off.
- A mission that builds on the unlanded products of another.
- The Secretary's allowance of extra attempts. It stays one per lineage; the plan makes the cap itself a setting.

## Appendix A: the first review round and what it changed

v01 was reviewed once by a second model within fixed limits: six questions (fit, facts, harm, gaps, roles, rigidity), at most 10 findings, evidence required, and the smallest change preferred in this order: remove, name a residual, a warning or a default, a rule. All 10 findings were taken. Five were resolved by removing something and five by a default; none added a rule that refuses.

| Finding | What it said | What changed in v02 |
|---|---|---|
| P1-1 blocker, roles, G1 and G3 | Sending every design question to the Architect takes from the Secretary the reversible decisions F-3 gives it; "the ordinary path failed" gives the PM no authority | G1: the Secretary settles what is reversible itself and chooses `replan` when design work is needed. G3: the PM writes for a task when the user said it |
| P1-2 blocker, harm, G1 | A task re-plan that adds a task under the mechanical checks alone waives a plan's reviews without the user's words (E-2); holding a change of another task's card text contradicts 4.3 B.2 | G1: the step changes card text only; any change of structure goes on to today's full re-plan with its reviews and approval |
| P1-3 blocker, fit, G1 | A repair's hand-back needs an edit, and a waiting task is released only if its own card changed, so an answer could miss the task that asked | G1: an answer with no edit is recorded on the escalation and the task goes on; a question back keeps the escalation open |
| P1-4 blocker, harm, evidence | A rerun of the suite could renew a pass that rested on an observation outside the commit | §7: a new review by default where a renewal would rest on an observation not repeated |
| P1-5 blocker, harm, G5 | A question put off had lost its answer path, which the plan had given it | G5: it is an open item from the moment it is put off, answered by its decider, with no assignment |
| P1-6 blocker, harm, G7 | A kept authorization that rests on superseded words could still authorize a new waiver | G7: such an item is not applied again; the ordinary reviews stand until the user's current words are cited |
| P1-7 blocker, facts, G7 | F-7 records at once a one-off instruction, not whatever the PM must act on | §2 and G7: the misreading is removed; the field's practice is listed as a deviation and put to the maintainer (N2) |
| P1-8 blocker, harm, G7 | An inbox placed first and never dropped would push principles out of a bound 4.3 fixes | G7: principles stay first; one line always counts the inbox |
| P1-9 blocker, roles, G2 | Telling the PM to ask the Secretary when a brief is poor is contact F-4 does not allow | G2: removed |
| P1-10 major, facts, G5 | The tree and the close already read accepted risks; an upgraded mission's list would have left out its 4.3 risks | §2 and G5: the fact is corrected; earlier risk sentences are listed with the new items |

## Appendix B: the second review round and what it changed

v02 was reviewed once more within tighter limits: a status for each first-round finding, and at most five new findings. Its verdict was "not ready". Nine first-round findings were confirmed resolved. One was half resolved, and five new findings were made. All six were taken, each by removing or narrowing something. **These changes have not been reviewed again.**

| Finding | What it said | What changed in v03 |
|---|---|---|
| P1-3 not resolved, G1 and G4 | When one task asks and only another task's card changes, the Architect's note reaches only the other task; a repair's Architect has no escalation to return a question to | G1: the answer is always recorded on the escalation that asked. G4: a repair's Architect may hand back a question with no edit, and it goes to the PM's inbox |
| P2-1 blocker, G1 | A task re-plan under the mechanical checks alone could remove a standard, which may change what the user gets, before the PM knew | G1: the one-step path only answers. It changes no card, no standard and no structure |
| P2-2 blocker, G7 | A waiver for a whole mission, or one resting on a kept authorization, could go on suppressing reviews after the user's permission was superseded | G7: keeping by default covers requirement items and constraints only; authorizations and waivers are still accounted for one by one |
| P2-3 blocker, evidence | The proof contract cannot always admit one judgment on both a declared run and an outside observation | Section 7: no promise of admission; such a review goes to a decider through the fourth answer |
| P2-4 major, G1 | Starting every re-plan with a local step adds a step where the decider already knows the plan must change | G1: asking the Architect is a new option; `replan` is unchanged |
| P2-5 major, G3 | "A failed path gives the PM a reason to ask the user" would send details to the user | G3: the sentence is removed; F-3 already says when the PM asks |

Across both rounds the design became smaller: G1 began as a re-plan of one task that could add tasks, and ends as an Architect that answers a question.

## Appendix C: G9's first review round and what it changed

G9 was reviewed alone, in v04, within the same limits as before: six questions, at most 8 findings, evidence required, the smallest change first. Its verdict was "not ready", while it found that a separate entry does answer the cost that sent the field PM to repairs. All 8 findings were taken; none by a rule that refuses.

| Finding | What it said | What changed in v05 |
|---|---|---|
| A1-1 blocker, roles | The PM submits results and no tasks, so its submission cannot stand for approval of the structure an Architect makes afterwards (F-3, B.2) | The PM approves or sends back the task set, as for a revised plan (M4) |
| A1-2 blocker, harm | A new requirement that puts a limit on existing work would be checked alone and leave the plan's proof, and an audit stamp, current over work nobody held against it | Three cases: an addition is only for something new that leaves earlier requirements as they were; the rest is a changed requirement. Calibrator 1 reports an item that bears on the plan. An audit binds every set in force |
| A1-3 blocker, gaps | A re-check of the unchanged plan cannot renew an addition's judgment when one of its items is revised | Such a change goes through a changed plan, which takes the addition in; the re-check leaves additions' items aside |
| A1-4 blocker, gaps | A re-plan of the detailed plan under the same PM plan could drop an addition's tasks or reject their provenance | Every later version of the detailed plan carries the additions; a dropped one shows its item as not planned |
| A1-5 blocker, harm | A waived addition could stall dependent work in stable mode, and a plan's waiver could excuse an addition's missing proof | A waived addition is treated as a waived plan is, and the close lists it; a waiver for a named plan does not cover an addition |
| A1-6 major, facts | The PM's full run before closing is its own call (D-7), so it does not "cover" work added after integration | Residual restated: such work can reach the close with no full run on the combined tree |
| A1-7 major, harm | The item a repair names reached only the tasks it adds, not those it changes or reopens | It joins the contract of every task the repair adds, changes or reopens |
| A1-8 major, facts | "19 of 19" counted repairs for new or changed requirements as if all were new, and the second measure counted rightful corrective tasks as failures | Both measures replaced |

## Appendix D: G9's second review round and what it changed

G9 was reviewed once more, in v05, within tighter limits: a status for each first-round finding and at most four new findings. Its verdict was "not ready", while it found that v05 gives independent new work a practical entry. Seven first-round findings were confirmed resolved. One was not, and four new findings were made. All five were taken, each by reusing what exists today or by narrowing what an addition may do. **These changes have not been reviewed again.**

| Finding | What it said | What changed in v06 |
|---|---|---|
| A1-5 not resolved | In stable mode one waived object among those a product relies on is enough to admit it, so a waived plan could let through a product whose addition lacks proof for another reason | A waiver lets dependent work start only where the waived reviews are the only proof missing, as the 4.1 contract asks |
| A2-1 blocker | A change to an item of the plan can reach an addition; a re-check of the unchanged plan would then restore proof it never examined | Such a change goes through a changed plan, which takes the addition in; the re-check's Calibrator is given the additions in force |
| A2-2 blocker | "The tasks added and the interfaces they bring" is not the structural difference: an existing task can change the interface it calls, and an amendment cannot declare a new interface, data format or storage | The PM decides on the structural difference as a revised plan's is computed, and on nothing where there is none; what an amendment cannot carry goes through a changed plan |
| A2-3 major | The item a repair names was bound to the next product only, and would be lost on a later attempt | It is bound on each attempt until one is accepted |
| A2-4 blocker | A new outcome is subject to limits the user set earlier; checking an addition against its own items alone could pass work that ignores them | The addition's Architect and both Calibrators get every limit and acceptance item in force, by reference |

Across both rounds an addition became narrower: it is for something new that leaves earlier requirements as they were, that needs no new declaration between modules, and that is held to the limits already in force. Everything else goes the way it goes today.

## Appendix E: why the "addition" of v04 to v06 was withdrawn

G9 first gave a new requirement a path of its own: an "addition" with Calibrator 1, the PM's decision on structure, the feasibility review and Calibrator 2, each on the addition alone. Two review rounds (Appendix C and Appendix D) narrowed it and added conditions to it. The maintainer then asked what principles he had set for Mission Pipeline. Read against them at their source, the addition failed three:

- **P-9.** D-10 sends this kind of work through the Architect and the mechanical checks alone, and names a missing feature among its reasons. The addition put the Calibrators and the feasibility review back.
- **P-5.** What goes wrong in such work shows by itself: to the Reviewer, at integration, and to the user who tries the result. No agent is owed there.
- **P-4.** It was a new object with its own requirement set, its own reviews and three cases for the PM to tell apart, and each review round added to it.

It had also taken one consequence of a ruling for a defect: that no Calibrator sees a task a repair adds is what D-10 decided. What the field showed was different: the requirement was not in the record, and recording it cost the proof of everything. v07 changes those two things and nothing else.

Two parts of the earlier form are kept, because they are not reviews: the new item stays outside the set the plan was checked against (now under P-8), and the Architect is shown the limits already in force (E-4).

## Appendix F: the rewritten G9's first review round and what it changed

G9 as rewritten in v07 was reviewed once by a second model. The limits were five questions (principle, fit, facts, harm, rigidity) with the principles first, at most 6 findings, evidence required, the smallest change first, and no remedy that adds a review, an approval step, a seat, a gate or a refusal. Its verdict was "not ready". It agreed that recording a new execution requirement on D-10's light path answers H-9 with no new ruling, and that Appendix E is right to withdraw the extra reviews. All 6 findings were checked against the source and the field record, and all were taken: two by widening a default that was already there, two by narrowing what G9 does, one by what a card shows, one by removing a restriction. None adds a step or a refusal.

| Finding | What it said | What changed in v08 |
|---|---|---|
| B1-1 blocker, principle | A revision or a withdrawal of a new item before the next plan submission would go the ordinary way and take the plan's proof off, though the plan never covered the item. The stop for a changed item of the plan is on the whole plan, not on "what it bears on". The fact about stable mode left out the waiver | Revising or withdrawing the new item leaves the plan's check alone, as recording it does; an audit covers every item in force. "What does not change" states 4.1's rule as it is. The fact names the waiver |
| B1-2 blocker, harm | A new requirement met only by changing or reopening tasks had no product bound to its item | The item is carried by every task the Architect adds, changes or reopens |
| B1-3 blocker, harm | A Reviewer could pass the standards after an item changed without having seen its text, and the pass was recorded against the new version | The Reviewer's card shows the text of the items its task carries, and the old and the new text after a change |
| B1-4 major, rigidity | Taking the new items into a re-check of the unchanged plan would fail that re-check on work the plan document never named | They join at a changed plan only; a re-check leaves them aside |
| B1-5 major, principle | Section 0.1 left out the rule that work whose acceptance cannot be written in advance is an exploration, and a new exploration is defined in the PM plan | P-11 added. `mp pm extend` is for execution work; a new exploration goes through the plan, as today |
| B1-6 major, fit | One item per filing made a message with several requests cost several Architect steps, or one merged item | One filing may carry several items through one Architect step |

## Appendix G: the rewritten G9's second review round and what it changed

G9 was reviewed once more, in v08, within tighter limits: a status for each first-round finding, and new findings only where a change of v08 caused them or where a blocker had not been seen, at most four. Its verdict was "not ready". It said again that recording a new execution requirement on D-10's light path answers H-9 and needs no ruling of the maintainer. Five first-round findings were confirmed resolved, one was partly resolved, and four new findings were made, each caused by a change of v08. All five were checked against the source and the field record, and all were taken: two by removing something, two by a default, one by correcting a fact. None adds a review, a step or a refusal. **These changes have not been reviewed again.**

| Finding | What it said | What changed in v09 |
|---|---|---|
| B1-1 partly | The fact about stable mode named the waiver by the user's words and left out a plan waived by the configuration key alone | The fact names all three: the user's words, an authorization, the configuration key |
| B2-1 blocker, harm | "Every product's proof stays as it was" would keep a pass current after the user revised or withdrew the item the Reviewer judged against | The promise is removed. The plan's check and the products not bound to the item are left alone; a product bound to the item follows the rules that exist for a revised and for a withdrawn item |
| B2-2 blocker, harm | If the user withdrew a filing's only item before its Architect finished, the amendment would still be applied: 4.3 cannot end a filed repair, and an Architect cannot hand back an empty one | A filing ends when every item of it is withdrawn before its amendment is applied; a later hand-back is kept and not applied |
| B2-3 major, fit | Binding a task with no named item to every item of its filing would send accepted, unrelated work back to review when one item changed | The fallback is removed. Such a task is bound to none and shown as not named; a filing with one item still binds by itself |
| B2-4 major, facts | The twelve-task repair of field A drew on several messages of the user, not on one | The field example is corrected, and each item may cite its own words entry |
