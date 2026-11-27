# Mission Pipeline 4.4: information flow (v01, draft for the maintainer's ruling)

Status: v01, 2026-11-27, updated the same day after a second survey (§9). **Draft. Not committed, not in force.** It covers the problems of 4.3 that do not depend on a harness. Rulings H-1 to H-4 are the maintainer's, stated in the author's words. Everything tagged [proposal] is the author's and waits for a ruling; §12 lists the ten questions that are the maintainer's to decide, each with the default this draft assumes. Builds on 4.3.0 with the nine field fixes of pull request 70. Records written by 4.3.0 and earlier fold with no migration; new record kinds and events are additions only.

## 0. Calibration

- **[H-n]**: the maintainer ruled it. The table gives the ruling in the author's words.
- **[proposal]**: the author's. Not in force until ruled.
- **[fact]**: verified in 4.3.0 source, or taken from the field record of §1; the text says which.

| Id | Date | The maintainer's ruling, in the author's words |
|---|---|---|
| H-1 | 2026-11-27 | First raise Mission Pipeline from 4.3 to 4.4. Solve the problems that do not depend on a harness first. |
| H-2 | 2026-11-27 | The first three subjects, whatever the harness: a card carries only what concerns its task and is built when its seat starts; three things get a formal place in the memory; the loop is run by a program. |
| H-3 | 2026-11-27 | A concern: worktrees piled up and took a great deal of disk space in an earlier project. |
| H-4 | 2026-11-27 | The pipeline's shortcomings have to be found through real tasks. |

Of H-2, 4.4 does the first two subjects and the engine's share of the third (what a program needs from `mp`). The program itself depends on a harness and is not in 4.4.

## 1. Why

**[fact]** One project ran 4.3.0 for 21.6 days: 1 mission, 1,200 dispatches, 303 escalations. Its PM and resident Secretary answered a read-only survey on 2026-11-27. The answers are not in this repository.

- A card was 300,000 to 340,000 characters, about 80% of it constraints that did not concern the task. The PM had made 169 constraints in 354 versions, because a project constraint was the only way to make a ruling for one task reach that task's card.
- 11 dispatches were released unstarted: the card had been built before a ruling took effect. Each cost one of the lineage's two re-dispatches.
- Holds and work order lived in notes to the Secretary and in the Secretary's own log. They were the first limit on parallel work.
- 66 of 164 acceptances (40%) were acceptances with risk at the review cap. What was left unmet, and who would take care of it, lived in the PM's private notes.
- The PM and the Secretary each kept private notes outside the memory (83 KB and 834 KB). A project cannot be rebuilt from the memory alone while that is so.
- The user's most frequent question, progress by their own requirements, had no command behind it.

64% of 392 reviews asked for rework. A second survey on the same day looked for the cause; §9 gives what it found and what follows from it.

## 2. Rulings for one task [proposal]

**[fact]** In 4.3 a constraint's scope is a mission, paths and task types (engine/src/flow/requirements.ts). Every ruling needs an open escalation (engine/src/flow/secretary.ts). A task's lineage is derived from its task id alone and is stable across attempts, re-plans and repairs while the Architect keeps the id (engine/src/flow/execution.ts).

- **The record.** A new flow event `ruling` on the line `task:<id>`: an id, a version, the text, who ruled (`pm` or `user`), and the words it rests on. `ruling-withdrawn` ends it. Recording the same id with a new text makes a new version; the card shows the latest.
- **The commands.** `mp pm ruling add <mission> <task> --text … --words W-n [--id <id>]` and `mp pm ruling withdraw <id> --words W-n`. `mp read rulings <mission> [--task <id>]` lists them; `mp read show task` includes them.
- **Who rules.** The PM on recorded words, and the user. The Secretary keeps answering escalations; an applied `answer` on the task is printed in the same card section, so a seat reads one list.
- **A ruling instructs; it does not change a standard** (§12 Q1). The Reviewer must still judge every standard on its card, so a ruling that contradicted a standard would make a pass record that standard as met when it was not. A change to a standard, a write path or an interface stays a repair.
- **The Reviewer checks that each ruling was followed.** Its hand-back answers every ruling on its card: followed, not followed or unclear, with a reason. A ruling not followed blocks a pass, as a standard not met does. The proof contract is unchanged: the answer is part of the review, not a standard. **[fact]** In the field the PM's additions reached the Reviewer as constraints and came back as findings without a standard's id, so nothing required them to hold.
- **Lifetime** (§12 Q2). A ruling belongs to the task's lineage. It holds across attempts and across a re-plan or repair that keeps the task id, until it is withdrawn or replaced. An Architect card for a repair or a revision lists the rulings in force for the tasks it concerns.
- **Words.** `--words` is required for the PM and is checked as a PM answer's words are; a ruling whose words lost force is not printed and returns to the PM inbox. A ruling may rest on a one-off instruction entry (§12 Q7): the ruling is that instruction carried out. **[fact]** In the field the PM cited older, loosely related words 16 times because `mp pm answer` refuses a one-off instruction as "not in force".
- **Where it shows.** In its own section, "Rulings for this task (follow them; not a proof input)", on that task's Constructor cards, on its Reviewer's card, and on a Secretary decision card about that task. On no other task's card. When two rulings conflict the later one holds; the card says so. The entry is also written to the mission's `decisions.md`.
- **Moving existing constraints over.** Nothing is rewritten. The PM records a ruling on the same words, then withdraws the constraint with the existing command. A new read, `mp read constraints <mission> --reach`, lists each constraint with the number of cards it reaches and its size, so the heavy ones are found first.

## 3. Only relevant content on a card [proposal]

**[fact]** Constraints are printed inline with no size limit and no filter beyond their scope. A decision item recorded after the plan took effect is printed on every task's card, because the plan could not have linked it (4.1.1, field finding B8). The Secretary decision card prints every decision item three times, and its must-read material `current-facts` repeats the constraints and holds every event of the task line in full (engine/src/seat/cards/dynamic.ts).

- §2 removes the reason to write a task's ruling as a project constraint.
- **A decision item may name its tasks.** `mp pm requirement add … --type decision [--tasks t1,t2]`. A late decision with tasks is printed on those tasks only. A late decision without them is printed everywhere, as today.
- **The Secretary card.** Each decision is printed once. `current-facts` becomes a digest: the escalation, the selected items by id and one line, the authorizations, the task's goal and standards, and one line per event of the task line. The full task line becomes a separate material that is not must-read. The constraints are not repeated in it.
- **Card size is visible.** A dispatch reports its card's size. Past a limit in `config.json` (`cardWarnBytes`, default 64 KiB) the PM gets a notice naming the largest sections and the five largest constraints.
- Target on the field project after the PM has moved its task rulings: a typical Constructor card under 64 KiB, and a Secretary ruling's must-read material under four pages.

## 4. Holds [proposal]

**[fact]** The ready list holds a step for five reasons only: a closed mission, a stop, a git hold, an exploration's predecessors, a leased resource (engine/src/process/pm.ts). Each is checked twice, when the list is built and inside the claim. A stop also refuses hand-backs, runs, delivery and landing, so it cannot serve as a hold. Nothing in the engine is released by time.

- **The record.** `hold.placed`: an id `H-n`, a subject, a release condition, a reason, who placed it and the words if any. `hold.released` ends it.
- **Subjects.** One task: its Constructor steps are held, so no new attempt starts; its reviews and decisions go on. A named resource: every step that needs the resource. Everything: every step except a Secretary decision.
- **Release.** While a named task is not accepted; from a time or until a time; or until released by hand. A condition is evaluated when the list is built and writes nothing. `mp sec wait` also wakes at the next such time.
- **Commands.** `mp pm hold add --task <id> | --resource <name> | --all [--after <task>] [--from <time>] [--until <time>] --reason … [--words W-n]`, `mp pm hold release <H>`, `mp read holds`. The Secretary may place and release a hold for an operational reason, without words (§12 Q6): `mp sec hold add|release`.
- **What a hold does not do.** It blocks new dispatches only. A dispatch in flight, a hand-back, a run, a delivery and a landing are untouched.
- **Where it shows.** `mp sec next` lists a held step with the hold's id and reason, as structured data. `mp read blocked` includes it. The PM's layer 1 counts the holds in force.
- **Disk [H-3].** `config.json` gains `limits: { worktrees, freeBytes }`. When a limit is passed, new Constructor steps are held with the reason shown, and nothing is recorded. `mp read scratch` lists worktrees and checkouts with their size, owner and age.

## 5. A card that is current when its seat starts [proposal]

**[fact]** The claim refreshes the card and stores it as a leaf that is written once; no command renders it again. The engine does not record that a seat read its card. The ready list ignores open escalations. A Constructor's questions (`constructor-decision`) do not hold its review: the Reviewer's card shows neither the questions nor their answers, and a pass is accepted while a question is open. A release costs one of two re-dispatches per lineage whether or not the seat read its card.

- **A pending answer holds the steps it would reach.** A step is held, with the escalation named, while an escalation on the same task is open or decided but not applied, and its answer would be printed on that step's card. That is: a review while its Constructor's question is open (§12 Q3); the next Constructor attempt while such a question is open; a Secretary decision while an older escalation on the same subject is open.
- **The Reviewer sees the Constructor's questions and their answers.**
- **A served receipt.** The first `mp seat <id> card` records that the card was served. A failure to record it never refuses the card.
- **A card out of date at its first read ends the dispatch at no cost.** If the memory moved since the claim and the refresh would now give a different card, `mp seat <id> card` says so, the dispatch is released without counting, and the step is ready again with a fresh card. The stored card and the hand-back checks are not touched.
- **Releasing an unread dispatch costs nothing.** Unread means: no served receipt, no material read, no run, no checkout, no refused hand-back and, for a Constructor, a clean worktree. Such releases are counted apart; the third in a row on one step raises a notice.
- The repair card is rebuilt at the claim when its inputs changed (issue 68), as the plan-review card already is.

## 6. Obligations [proposal]

**[fact]** A review stores one judgment per standard (`met: yes|no|unclear`), a response per earlier issue (`fixed|not-fixed|deferred`, a deferral with a free-text owner), and findings as plain strings with no severity. An acceptance with risk stores one sentence per escalation reason. Nothing gates on it. Reads label it "accepted", and its proof label reads as proven because the decider's ruling revokes the negation. The close is the only list. `mp pm deliver` refuses mechanical problems only; the close never refuses.

- **The record.** At an acceptance with risk the engine writes one `obligation` event per standard not met and per issue not fixed, from the Reviewer's structured hand-back: its id, its source and reference, its text, the task and attempt it came from. Plain findings do not become obligations: they have no severity, and they would flood the list.
- **Owner.** `mp pm obligation assign <id> --task <id> | --repair <id>`; `mp pm repair … --obligation <id>` links a new repair. An obligation is discharged when its owner's work is accepted after a passing review. That is derived, not recorded.
- **What it blocks** (§12 Q4). Nothing by default, which is today's behaviour. The PM may mark one as blocking delivery; `mp pm deliver` then names it and refuses that step until it is discharged or waived on the user's words, as a plan review is waived today. The close still never refuses and lists every open obligation.
- **Reads.** `mp read obligations <mission> [--open]`. Status and tree reads say "accepted with risk" where they say "accepted" today.
- **Earlier records.** The sentences stored by 4.3 read as obligations with no reference, no owner, blocking nothing.

## 7. State per requirement item [proposal]

`mp read items <mission>` gives one line per requirement item: not planned, planned, in work, accepted after a passing review, accepted with risk (with the count of open obligations), abandoned, delivered, landed; and its proof label. It is derived from links that exist and costs what `mp read status` costs.

**[fact]** Nothing records that an execution task's result was checked outside the repository, in a simulator or by hand. Proposal (§12 Q5): `mp pm verified <mission> <item> --words W-n [--evidence data:…]` records the user's statement that an item was checked in the field. Reads show it as the user's statement on those words, never as proof.

## 8. Smaller items [proposal]

- **The PM inbox misses escalations sent to the PM** (issue 62). The cause is not pinned down from reading. First a test that reproduces it with a Constructor's question and a used-up loop after a retry round; then the fix.
- **Notes stay readable.** `mp read notes [--all]` lists every note, acknowledged or not. **[fact]** Today only unacknowledged notes can be read.
- **Notices that only inform need no acknowledgement.** They are shown once and stay readable. **[fact]** No code gates on an acknowledgement; in the field three such categories made 623 notices.
- **For a program that drives the loop [H-2].** A ready step's JSON gains the filler hint, the exclusive resources and the estimate; a held step gains a structured reason; a dispatch gains its card size.

## 9. The review loop [proposal]

**[fact]** From the second survey: 250 of 392 reviews asked for rework. In 82% of them a standard was judged not met; in 16% the program's verification had failed; in 3% there were only findings outside the standards. Of the problems raised from the second round on, 74% fell on a standard that had already failed the round before. A sample of 20 of those: 5 were the same defect, not yet fixed; 5 could not be removed by any rework, because the Reviewer could not see what the standard asked for; 4 came with the rework; 6 had been there since the first round. Rework grew with the number of standards on a task: 30% with 1 to 3, 61% with 4 to 7, 70% with 8 or more. After the Reviewer's model was changed, passes fell from about half of the reviews to 2 of 132, and no read showed it. Of the five lines with the most rounds, none was a defect that would not stay fixed: two were reopened again and again by repairs, two were stuck on a standard their Reviewer could not verify, and one had an open-ended standard.

- **A standard the Reviewer cannot verify does not cause rework** (§12 Q8). A judgment gains a fourth answer: it cannot be verified from the candidate, with what would be needed (evidence outside the repository, a person's check, a fact about an earlier moment). A review whose only open standards are of that kind is not sent back to the Constructor. It goes once to a decider, who accepts with those standards recorded as obligations to verify (§6), or sends it back with instructions.
- **Evidence outside the commit counts in a review** (§12 Q9). A Reviewer and a Constructor may cite a `data:` pointer with its sha256 and size, as the seats of an exploration do today. **[fact]** 74 Reviewer hand-backs were refused for citing a file outside the candidate snapshot. Tasks run in a simulator were accepted with risk 15 times out of 20, their Reviewer answering in every round that no run report was tied to the candidate.
- **A standard says how it is checked** (§12 Q10). In the detailed plan each standard names one of: a declared command, reading the candidate, evidence outside the repository, a person. A standard of the last two kinds is not put to the Reviewer as met or not met: it stays open until evidence is cited or the record of §7 closes it. A standard of a 4.3 plan reads as "reading the candidate". The Architect's page asks for standards with a finite check.
- **The plan check warns about many standards** (§12 Q10). Above `standardsWarn` per task (default 7) the feasibility review and the PM are told. It is a warning, not a refusal.
- **Review health can be read.** `mp read reviews <mission>` gives the share of pass, rework and needs-decision per filler of the Reviewer seat and per week. The PM gets a notice when the pass share of the last 20 reviews is under half of what it was before the filler changed.
- **From the second round on, a problem says where it comes from**: raised before, new with the rework, or missed earlier. Nothing in the flow depends on it yet; it is there to be measured [H-4].

## 10. Compatibility

- New flow events: `ruling`, `ruling-withdrawn`, `obligation` and its owner and waiver events, the served receipt. New record kinds: `hold.placed`, `hold.released`. New card fields and the new fields of a standard and of a Reviewer's hand-back are optional.
- A 4.3 memory opens in 4.4 with no migration. A step queued by 4.3 gets its 4.4 card at the claim.
- **[fact]** A 4.3 engine opens a 4.4 memory and ignores the new kinds without an error. It would then dispatch a held step and print no rulings. Limitation: do not go back to 4.3 on a memory that has holds or rulings in force.

## 11. Order of work [proposal]

Each step ships on its own, with its tests, the type check and the full suite. Steps 1 to 5 could be 4.4.0 and steps 6 to 8 a 4.4.1.

1. §8; "accepted with risk" in the reads; `mp read reviews` (§9).
2. §2 and §3, with the Reviewer's answers on rulings.
3. §5: the pending-answer hold and the Reviewer's view of questions.
4. §4.
5. §5: the served receipt, the out-of-date card, the free unread release.
6. §9: evidence outside the commit; the fourth answer on a standard; how a standard is checked; the warning on many standards.
7. §6.
8. §7.

Acceptance on a real task [H-4]: both surveys of 2026-11-27 are asked again on a project running 4.4, and the numbers of §1 and §9 are compared.

## 12. Questions for the maintainer

| | Question | Default in this draft |
|---|---|---|
| Q1 | May a ruling change a standard? | No. It instructs only, and a standard changes through a repair. The Reviewer checks that a ruling was followed; one not followed blocks a pass. |
| Q2 | Does a ruling survive a change of the task's card? | Yes. It belongs to the lineage and is shown to the Architect; nothing forces a keep-or-withdraw choice. |
| Q3 | Does a Constructor's open question hold its review? | Yes, and the Reviewer sees the question and its answer. |
| Q4 | Does an obligation block anything by default? | No. The PM may mark one as blocking delivery; only the user's words waive it. |
| Q5 | Is "checked in the field" recorded per requirement item, as the user's statement? | Yes, in 4.4. |
| Q6 | May the Secretary place a hold without words? | Yes, for an operational reason, with the reason recorded. |
| Q7 | May a ruling rest on a one-off instruction? | Yes. |
| Q8 | When a Reviewer cannot verify a standard from what it can see, does the task still go back to the Constructor? | No. It goes once to a decider; the standard is recorded as open, to verify. |
| Q9 | May a review cite evidence outside the commit? | Yes, with its sha256 and size, as an exploration does. |
| Q10 | Must a standard say how it is checked, and is a task with many standards flagged? | Yes. Above 7 standards there is a warning, not a refusal. |

## 13. Not in 4.4

- Anything that depends on a harness: the Historian and its interface, the program that runs the loop, the stop as one action. These belong to the DSH edition.
- An obligation that blocks the acceptance of another task.
- Recurring time windows for holds.
- A severity on a Reviewer's findings.
- Field notes written by the Secretary for its own later use: decided after §2 to §6 are in use, when it is known what the private notes still hold.
