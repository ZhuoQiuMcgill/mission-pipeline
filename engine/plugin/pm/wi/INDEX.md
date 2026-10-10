# PM work instructions (WI): index

Notices name a WI number. Open a WI's page (`WI-NN.md` in this directory; `mp alerts` prints the full path) only when a notice names it. Each page gives: trigger and evidence, the default action already taken, the options (with their `mp` commands) and outcomes, how to choose, and when to ask the user.

Principles: an exception stops only the one affected action; the default action never blocks other work; only important design decisions go to the user (3.2); the safety floor is never an option.

- WI-01: Target branch checked out in several worktrees, or held by a rebase/bisect: landing waits
- WI-02: Target branch checked out by one external (agent) worktree: not landed into by default
- WI-03: An external worktree or branch changed paths in a mission's write scope
- WI-04: A worktree is inconsistent with the delivery after landing
- WI-05: The target branch keeps moving: the delivery candidate is rebuilt on a new base
- WI-06: A landing did not complete (A before the push / B safe to retry / base moved / C other)
- WI-07: A selected object's content changed on the delivery candidate
- WI-08: A lineage's automatic loop is exhausted, or repeats the same failure
- WI-09: Budget block, or waiting for the account quota to reset
- WI-10: Resource block, disk or inode watermark, no fuse2fs, space reminder
- WI-11: Evaluator fault (derived state cannot be computed), or its pool is too small
- WI-12: Storage fault, a stop not persisted, the recovery pause or going on after a reboot
- WI-13: Unsupported transform, missing objects, unsupported repository format (incl. reftable)
- WI-14: Cleanup keeps failing, or processes cannot be ended
- WI-15: A failed attempt: environment failure, resource overrun, seat failure, quarantine
- WI-16: A dependency cycle
- WI-17: An asynchronous evidence run refused, or the resume state missing
- WI-18: Startup self-check failed, or a platform capability missing (cgroup, bubblewrap)
- WI-19: The transform description changed after acceptance
- WI-20: Inconsistent program records or namespace, or a program internal error
- WI-21: The delivery candidate's closing checks failed
- WI-22: The watchdog restarted the ledger service or scheduler, or restarts are exhausted
- WI-23: A re-plan dropped or changed a task that has work in flight
- WI-24: The Secretary could not decide: the PM and the user decide (mp answer)
- WI-25: A legalization cannot complete: a broken link, a failed backfill, or the chain not accepted
- WI-26: A decision-layer step cannot continue as it is (its seat was stopped)
- WI-27: A web fetch was refused (outside the allow list, non-public, or not authorized)
