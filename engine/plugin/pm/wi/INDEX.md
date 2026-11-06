# Secretary work instructions (WI): index

The Secretary handles operational notices.
Open a WI page (`WI-NN.md` here) only when a notice names it.
Each page gives the trigger and evidence, default, commands and outcomes, choice rule, and PM routing (`needs-pm` / `ask-pm`).
The PM decides on recorded words or asks the user under F-3.

Principles: an exception stops only the one affected action; the default action never blocks other work; PM-class choices go to the PM inbox; the safety floor is never an option. Numbers of retired WIs are not reused, so the list has gaps.

- WI-01: Target branch checked out in several worktrees, or held by a rebase or bisect: not landed
- WI-02: Target branch checked out in one worktree that is not clean, or that is external: not landed
- WI-03: An external worktree or branch changed paths in a mission's write scope
- WI-04: A worktree does not match the delivery after landing
- WI-05: The target branch moved: the delivery candidate is rebuilt on a new base
- WI-06: A landing did not complete, or a landing intent is left open (A / in progress / B / C)
- WI-07: A selected output's content changed on the delivery candidate
- WI-08: A lineage's automatic loop is exhausted, or repeats the same failure (incl. an exploration's round budget, a reopened task or dependency given up, a re-plan that waits)
- WI-13: Unsupported repository format or content transform, or git objects a step needs are missing
- WI-16: A dependency cycle (incl. explorations whose `after` wait for each other)
- WI-19: The transform description changed after acceptance
- WI-20: Inconsistent program records or namespace, or an internal error
- WI-21: A full run at the end failed
- WI-23: A re-plan dropped or changed a task that has work in flight
- WI-24: A Secretary decision could not complete: recover its round, or leave it in the PM inbox
- WI-25: A legalization cannot complete: a broken link, a failed backfill, or the chain not accepted
- WI-26: A decision-layer step cannot continue as it is (a stop covered it)
- WI-28: A dispatch is interrupted: its seat ended without a hand-back, or nobody knows (release --ended / --abandoned); a detached run ended
- WI-29: The memory's event chain is broken: all writes are stopped
- WI-30: A leaf is missing or edited by hand, or a commit the memory names is not reachable here
- WI-31: The repository lives outside the folder, a copy shares one repository with another copy, or a copy's worktree links cannot be verified
- WI-32: Recomputing the labels does not finish (mp sec drain)
- WI-33: An exploration awaits a ruling: the Stabilizer found a shift of direction or a drift
- WI-34: A plan’s current pass judgments leave applicable object constraints uncovered; re-check the PM plan or submit an agreed changed plan

Integration start conflict (notice `integration-start-conflict`, no WI page): only that integration task waits, tried again on every pass; a repair that reopens the dependency whose work conflicts (`mp pm repair ... --about <task>`), or a re-plan, routes it.

PM actions (send choices to its inbox): constraint maintenance, `mp pm constraint add <id> --kind object|instruction --text "..." [--mission <m>]` (project-wide by default); `mp pm constraint withdraw <id> --words W-n` keeps the record and removes its force.

The PM records the user's decision about an exploration's method: `mp pm repair <mission> --about <exploration> ... --attempts <file> | --rerun <ids> | --resnapshot` applies it on their words, with no round and no review.

No-page notices (information; the default is taken): `integration-restarted` and `integration-start-stale` (an integration starts again on its dependencies' current work), `early-start-rebuilt` (work started on a dependency's version that was sent back is carried onto its next one), `accept-risk-moot` (the attempt moved on; nothing was accepted).
