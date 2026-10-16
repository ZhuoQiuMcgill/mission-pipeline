# PM work instructions (WI): index

Notices name a WI number. Open a WI's page (`WI-NN.md` in this directory) only when a notice names it. Each page gives: trigger and evidence, the default action already taken, the options (with their `mp` commands) and outcomes, how to choose, and when to ask the user.

Principles: an exception stops only the one affected action; the default action never blocks other work; only important design decisions go to the user; the safety floor is never an option. Numbers of retired WIs are not reused, so the list has gaps.

- WI-01: Target branch checked out in several worktrees, or held by a rebase or bisect: not landed
- WI-02: Target branch checked out in one worktree that is not clean, or that is external: not landed
- WI-03: An external worktree or branch changed paths in a mission's write scope
- WI-04: A worktree does not match the delivery after landing
- WI-05: The target branch moved: the delivery candidate is rebuilt on a new base
- WI-06: A landing did not complete, or a landing intent is left open (A / in progress / B / C)
- WI-07: A selected output's content changed on the delivery candidate
- WI-08: A lineage's automatic loop is exhausted, or repeats the same failure (incl. an exploration's round budget)
- WI-13: Unsupported repository format or content transform, or git objects a step needs are missing
- WI-16: A dependency cycle
- WI-19: The transform description changed after acceptance
- WI-20: Inconsistent program records or namespace, or an internal error
- WI-21: The delivery candidate's closing checks failed
- WI-23: A re-plan dropped or changed a task that has work in flight
- WI-24: The Secretary could not decide: you and the user decide (mp pm answer)
- WI-25: A legalization cannot complete: a broken link, a failed backfill, or the chain not accepted
- WI-26: A decision-layer step cannot continue as it is (a stop covered it)
- WI-28: A dispatch is interrupted: its seat ended without a hand-back, or nobody knows (release --ended / --abandoned)
- WI-29: The memory's event chain is broken: all writes are stopped
- WI-30: A leaf is missing or edited by hand, or a commit the memory names is not reachable here
- WI-31: The repository lives outside the folder, a copy shares one repository with another copy, or a copy's worktree links cannot be verified
- WI-32: Recomputing the labels does not finish (mp pm drain)
- WI-33: An exploration awaits a ruling: the Stabilizer found a shift of direction or a drift
- WI-34: A plan’s current pass judgments leave applicable object constraints uncovered; re-check the PM plan or submit an agreed changed plan

Constraint maintenance: `mp pm constraint add <id> --kind object|instruction --text "..." [--mission <m>]` (project-wide by default); `mp pm constraint withdraw <id> --words W-n` keeps the record and removes its force.
