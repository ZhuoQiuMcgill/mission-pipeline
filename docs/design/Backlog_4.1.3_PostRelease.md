# Mission Pipeline 4.1.3: post-release backlog

Design contract: `DesignDoc_MissionPipeline_4.1_2026-10-10_v06.md` (with the 4.1.3 amendments,
Appendix P). Direction: `DesignDoc_UserAuthority_2026-11-05_v01.md` (E-1 to E-5), with
`DesignDoc_ExecutionRedundancy_2026-10-17_v01.md` (D-1 to D-12).

4.1.3 raises the user's say, built on the field's 4.1.2 branch. The field's code and four parts (user
authority on the delivery side; explorations; evidence; runs, long experiments and constraints) and
the integration pass went through code review. Each serious finding was fixed before the release, and
so were most general ones. The items below were not fixed; they do not produce a wrong result in
normal use. The edge cases the parts left to the PM are listed too. Under D-1, a rare edge case gets
detection, a safe default and a WI line, not a new mechanism; the known issues a PM must know are in
the CHANGELOG. The open items of the 4.1.2 backlog stay open unless 4.1.3 says otherwise.

## Detached runs (`src/process/detached.ts`, `src/process/runs.ts`)

- Outside Linux, a worker's liveness is checked by its pid alone (`processStart` returns "unknown" for
  the start time). A reused pid can keep a lost run reading "running", and `mp pm stop` could signal
  the process that now has that pid. Linux checks the pid with its start time and the boot id. Add a
  start-time check for macOS (`ps -o lstart`) and Windows. WI line (WI-28): after a restart of such a
  machine, check the worker pid by hand before you trust "running" or stop it.
- On Windows a stop ends the worker's process tree with a forced `taskkill`, so the cleanup commands
  do not run. WI line (WI-28): run the cleanup by hand after a stop there.
- A worker on another host is never marked lost from this machine, and a stop reaches it only when it
  records its result. WI line (WI-28).
- A harness that kills a seat's whole process tree (a cgroup, a job object) takes the worker with it;
  the run reads as lost. WI line (WI-28): run the step again.
- A worker killed alone (for example by the out-of-memory killer) can leave its command's processes
  running. WI line (WI-28): check with `ps` before you run the step again.

## Explorations (`src/seat/cards/crititor.ts`, `src/flow/exploration/`)

- A repair while the interpreter is at work is refused (`DISPATCH_IN_FLIGHT`). WI line: wait for its
  hand-back, or release it, then record the repair.
- While the method is back with its author, `--rerun` is refused until the author's version passes,
  and `--attempts` needs `--answers R-<n>` (PM.md). WI line: pass `--answers`
  only if the change settles that repair.
- A Stabilizer that judges a round drifting again after each ruling costs a Secretary decision each
  time. WI line (WI-33): after a second ruling on the same drift, ask the user.

## Evidence (`src/common/dataFile.ts`, `src/seat/cards/experiment.ts`)

- A file over 2 GiB is checked by its size and the sha256 of its first and last 64 MiB; the label
  says so. Nothing to do.
- A path that itself ends in `:<digits>` is read as a line suffix. WI line: add a line suffix to such
  a path.
- A seat that quotes a pointer whose file has changed since is refused with the new values. WI line:
  cite the `evidence:<id>` that recorded it instead.
- Data cited by evidence that changed later keeps counting: the record says what was read. WI line:
  `mp read show evidence <id> --check-data` names it; tell the user when a conclusion rests on it.

## Delivery side (`src/flow/execution.ts`, `src/flow/repair.ts`)

- `accept-risk` is not offered on a re-review or a re-bind decision, where the product is accepted
  already. WI line (WI-08): answer, rework or re-plan.
- A repair whose mechanical returns are used up has a grant as its only exit. It holds no other work.
  WI line (WI-08): leaving it is safe.

## Code to tidy

- `rulingJudgment` in `src/seat/cards/secretary.ts` has no caller: the one writer of a decider's
  ruling is `deciderJudgment` in `src/flow/secretary.ts`. Remove it.

## Open direction question

- U-23 put on the 4.1.2 agenda whether the program may start a plan re-review by itself when an
  object constraint recorded later leaves a plan's proof short (WI-34). Neither D-1 to D-12 nor E-1
  to E-5 rule on it, so WI-34 and its two PM exits stay as in 4.1.1.

## Field items not taken in 4.1.3

- The Stabilizer does not check that the author followed the instructions scoped to its exploration.
- The write budget still counts the time a write waits under load; `mp pm dispatch` retries once
  instead.
- The constraint matcher does not read glob segments such as `*` inside a name; such a pattern is
  refused, naming the nearest form it reads.
- Passing output tails are kept for seats' reruns only, not for verification runs, and the limit is
  not configurable per run class.
- A local folder as a reader's address (`readingNetwork` with `file://`) is neither documented nor
  checked; `data:` pointers cover that case.
- The executor's report is served whole, up to 256 KiB, not only the parts the card's quantities name.
- The version commands run under the platform's shell, and `experimentShell` is not part of the
  environment identity.


## Field items left after 4.2.0 (#47–#50)

- #48: per-path partial carry, keeping the non-conflicting part of an earlier change, needs
  per-path resolution in the delivery overlay. 4.2.0 starts the whole attempt fresh on a conflict.
- #49: Windows-only test failures outside the small fixture fixes: EBUSY on lock files,
  `A.txt`/`a.txt` case folding, and the fixture's failing `update-ref`. Investigate on Windows;
  4.2.0 only pins the LF-literal fixtures and makes the delivery scratch path check portable.
