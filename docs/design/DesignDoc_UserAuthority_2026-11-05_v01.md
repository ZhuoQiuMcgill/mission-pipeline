# Design: the user's say, and a less rigid process (maintainer alignment)

- **Date:** 2026-11-05
- **Version:** v01
- **Applies from:** Mission Pipeline 4.1.3

Status: binding direction for 4.1.3 and later, together with D-1 to D-12 in `DesignDoc_ExecutionRedundancy_2026-10-17_v01.md`. Agreed between the maintainer and the engine author on 2026-11-05, after the field's pull requests #17–#40 and issues #22–#46. Rulings E-1 to E-5 below are the maintainer's: the author proposed E-2 to E-5, and the maintainer accepted all four and added E-1. The analysis in "What the field showed" is the author's. Project names are withheld.

## Why

4.1.2 cut execution redundancy on the delivery side: who runs which tests, the end of a mission, repairs and disk. Between 2026-10-25 and 2026-11-02, a research-heavy field project ran on 4.1.2. It hit the same flaw on the exploration side, and in the places where the user's decision should settle a question:

- rounds were lost to the round counter and to timing, not to real problems;
- evidence the method needed was refused, because the data lived outside the commit;
- a decision the user had made still went through a review round, or waited behind work it made obsolete;
- some states had no exit, and some rules silently applied to nothing.

The field kept going by patching each exit in turn: nine pull requests and five more commits on its own branch. A problem reported after one patch showed the same flaw at the next exit (#46 after #20).

## The maintainer's rulings

**E-1. Raise the user's say and decision power; make the process less rigid.** Wherever the user has decided, the user's words settle it. The process carries the decision out and records it honestly. It does not send the decision back through review, and it does not refuse it for form. A state where the program stops must have an exit the user's words can take, such as accept, change, run again or drop, and the record says what was taken and why. This applies D-9 to D-12 to explorations and to the process checks themselves.

**E-2. A process check is waived only by the user's words, and the waiver is on the record.** The user may waive a mission's plan reviews (the feasibility review and Calibrator ②), for the whole mission or for one detailed plan version. The waiver cites the user's words, or an authorization item in force (D-8). It is shown wherever the plan's proof is read, and at close: "this plan took effect without its reviews, on W-n". The program never waives a check on its own, and a project setting is not a waiver.

Starting a task on its dependencies' verified hand-backs while they are in review stays a project setting. It saves waiting time but removes no check: the dependent's acceptance still waits for theirs.

**E-3. An exploration's end is judged by its state, not by its round counter.** An exploration converges when three things hold, in any round, including the budget's last round or a granted one:
- the Stabilizer judged the round on track;
- no direction question waits for a ruling, read from the record when the Stabilizer hands back, not from the card it was given;
- every in-scope fatal or serious finding is resolved, by an attacker's re-check or by the Stabilizer recording that the author answered it.

The budget only limits whether another round may start. It never turns a resolved exploration into a failed one.

The Stabilizer may close a finding the author answered, without another attack round. A later attacker may still re-check it and reopen it.

A grant of more rounds carries the decision's instructions to the next round's cards. It may name the findings it is for, general ones included, and the author then gets a turn on them. When nothing is unresolved, the budget step offers plain "accept".

**E-4. Data outside the commit counts as evidence, recorded with its hash.** A seat may cite a file outside the repository by absolute path with its sha256 and size. The program checks the hash when the hand-back is recorded, records it with the evidence, and labels it "outside the commit". A later read can then tell whether the data has changed. The program does not refuse such data.

What the method asks a seat to record must reach the seats that read it:
- a passing run's output tail is kept and returned to the seat that ran it;
- the executor's report is served to the interpreter and the attacker.

A request the program will refuse later is refused at once, with the reason: for example, an evidence command whose working directory is not relative to the repository.

**E-5. The user's decision about a method takes effect directly, through the one repair entry.** When the user decides something about a registered method, the PM applies it with `mp pm repair` on the user's words, with only the mechanical checks: no author, attacker or Stabilizer round. Examples are a scale, a cap, a wider search, a new or changed attempt, running an attempt again, or taking the snapshot again. This is D-10 applied to explorations. Every record already taken that the change does not touch keeps counting. A repair that leaves the method to the author gives the author the turn at once, even in the attempts phase; it never waits for obsolete attempts to finish.

One entry for the PM replaces a command per case. The field's commands stay as older names for one release.

## What the field showed

This is the author's analysis; it was accepted as the basis for 4.1.3. Issue numbers are on the project's tracker.

1. **Rounds lost to the counter and to timing.**
   - A granted last round closed every finding and still stopped as budget-exhausted (#46).
   - A grant could not get a general finding answered (#39), and it dropped the decision's instructions (#38).
   - A Stabilizer judging from a card fixed before a ruling failed a round that had nothing open (#25).
   - A repair in the attempts phase reached the author only after every obsolete attempt had run (#31).
2. **Evidence pushed out of the record.**
   - Data outside the commit could not be cited (#26, #44).
   - A passing run's printed output was not kept (#37).
   - The interpreter never saw the executor's report (#45).
   - A request was accepted, then refused at run time (#43).

   The seats then cited the data in prose, so nothing could be checked. Strictness made the record weaker.
3. **Rules that silently apply to nothing.**
   - A mission-wide instruction never reached a pathless task, such as an integration review (#34, #42).
   - A constraint pattern the matcher cannot read matched nothing (#36).
   - `after` from a deliverable to an exploration may never wait (#22).
   - A cycle in `after` holds explorations forever (#23).
4. **Dead ends on the repair path, from 4.1.2.** These break D-11 and are fixed first:
   - an integration task reviews a tree without the work of tasks a repair added (#41);
   - a repair's mechanical check looks up an interface accepted work has renamed (#40);
   - a task whose loop was decided "replan" can be left with no Architect step and no other exit (#35).
5. **Long experiments.**
   - A day-long run outlives the seat waiting on it, and nothing notices when it ends (#30).
   - Experiments need their own time limit (#28) and a shell of the project's choice (#27).
   - Throwaway checkouts leave container resources behind (#17).
   - A burst of dispatches can exceed the write budget under load (#33).

## How 4.1.3 is built

- **The base is the field's own branch:** 4.1.2, then the nine field pull requests and the five commits the field runs, in their order. The rulings are built on top of it ("落实在上面"). The field's ledgers carry the events and config keys of that branch, so 4.1.3 reads them as they are, with no migration.
- **The field's code is reviewed like any part,** and serious findings are fixed before release.
- **A field pull request whose change a ruling reshapes is closed as superseded,** with a comment saying where its change went. One taken in as is gets merged history in the release notes.

## What stays

- The hard floors of 2026-10-17 stay:
  - nothing lands without the user's words;
  - the record is honest;
  - each Constructor has its own worktree;
  - the program verifies on a clean checkout;
  - what lands traces to the user's words;
  - a stop stops;
  - no stuck state without an exit.
- The rulings of 2026-10-13 stay. The program writes no judgment in a seat's place: the user's own judgment, cited by words, is the user's, not the program's.
- D-12 stays: details are not the user's. E-1 raises the user's power over decisions, not the number of questions the PM asks.
