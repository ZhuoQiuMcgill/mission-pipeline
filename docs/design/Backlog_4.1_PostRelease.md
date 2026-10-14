# Mission Pipeline 4.1: post-release backlog

Design contract: `DesignDoc_MissionPipeline_4.1_2026-10-10_v06.md`.

Under the maintainer's release-first ruling, only fatal and serious findings were fixed before 4.1.0.
Every package went through code review (at most three rounds per part, each judged by an independent
Stabilizer), and then through a final parallel review of the whole engine and a real two-harness run:
Claude Code as PM up to Calibrator ②, then the folder copied and Codex as PM through delivery and
landing. The general and minor findings below do not produce a wrong result in normal use. They are
parked here and fixed after the release.

## Memory (`src/memory`)

- Orphan and fragment cleanup is incomplete: partial BEGIN markers, truncated leaf events and
  atomic-write temp files are not all noted, and reads do not clean them.
- A user message containing the literal text `<!-- mp:entry X -->` is refused. Body text and control
  markers should be separated reversibly.
- The page byte limit counts string length, not UTF-8 bytes, and a full page is read per kind before
  it is trimmed.
- `missionIdProblem` does not reuse the Windows device-name check used for leaf paths. A mission named
  `aux` opens, and then its leaf writes are refused. Workaround: use another id.
- The move check's `namedCommits` does not include task and card snapshot commits. A later use still
  checks the commit.

## Labels (`src/evaluator`)

- Continuation chains are walked recursively. A chain about 6,000 deep overflows the stack. Use an
  explicit stack plus a cache.

## Git and delivery (`src/git`, `src/delivery`)

- A 64-character delivery id truncates the rebuild suffix (`-r<n>`), so a rebuild returns the old
  delivery. Reserve room for the suffix.
- The delivery tests are skipped on Windows because of POSIX-only steps. Make the core ones
  platform-neutral.
- The WI-03 external-worktree scan misses untracked files (`ls-files --others --exclude-standard`) and
  the scopes of planned, queued and in-flight tasks. It is informational only.
- A file-versus-directory prefix conflict in an overlay throws instead of being reported as a
  structured conflict. No ref is written.

## Process (`src/process`, `src/flow`)

- The stable-mode gate is checked when a task is queued, not when it is claimed. Nothing is falsely
  proven, but work is wasted. A single check in `pmDispatch` fixes it.
- Two simultaneous claims of the same step can both return the same dispatch. The fix must keep "a
  retry returns the same dispatch".
- PM batch de-duplication ignores mode and dependent items.
- The Auditor cannot cite its own rerun.
- A Reviewer's `deferred` item has no owner or reason field in the schema.
- The allowed-URL check compares string prefixes. It should parse the URL and compare origin plus a
  path boundary; `mp` still fetches nothing.
- File evidence counts a symlink as a file. Check the tree entry mode.
- The interface mechanical check is a substring search. "Could not confirm" stays an acceptable
  outcome, with no per-language tooling.
- `lateForClose` should treat any close without `--wait-running` after the claim as late, whatever the
  current state.
- A `full` close should count open escalations and unapplied PM batches as unfinished. Today only the
  tier label is wrong.
- A re-review after close cannot reach the Secretary or rework. Add a work instruction (reopen, or
  close with the risk named) or an `afterClose` path for re-review escalations.
- The evidence request cannot name reading addresses. They would only be a citation scope, since
  `mp` fetches nothing.
- `requirement add` should refuse a withdrawn line.
- Root cause of several read-side fixes made before release: reads and the plan template derive states
  on their own. They should call the flow's resolvers (`currentItems`, `decisionFor`).

## Explorations and escalations (`src/flow/exploration`, `src/flow/secretary.ts`)

- **First in line.** Carrying out a decision is bound to the decision only inside `carryOut`'s write.
  - The window between a caller reading the decision and calling `carryOut` is still open. Ledger
    writes happen there in the failure, planning-grant and exploration-grant paths.
  - If a user answer lands in that window, a second `mp` process can carry out the overridden Secretary
    decision.
  - The trigger is a millisecond race between two processes. The consequence is a negated plan read as
    proven.
  - Fix: pass the decision the caller acted on into `carryOut`/`markApplied`, guard on it, and extend
    the test sweep so `applied` matches the decision in force.
- A grant or restart and its `applied` record are separate writes. A crash between them leaves the
  escalation open and a false "carried out on the next `mp pm next`" line.
- `mp read why` from a delivered product does not reach the user's words of the ruling that let its
  plan pass (Calibrator ②). The ruling, the decision and the words are recorded and reachable from
  `mp read tree`.
- `mp read tree` shows a superseded decision as carried out. It should show "closed without being
  carried out", with the reason.
- The `applied` records of grants and restarts carry no option, so the PM's "in effect" notice for an
  important grant or restart is never sent.
- The recompute tests use 256-unit batches. Add default-batch cases where a frontier finishes in the
  middle of a pass.

- `mp read tree` ignores a `redefined` event. After a budget raise reopens a stopped exploration, the
  tree still shows the old stop, while layer 1 is correct.
- An Architect revision that changes the card of a task the user gave up on revives it without a
  notice. A PM plan that keeps the same card keeps it given up and says so.
- Ruling judgments (the Secretary's or the user's) are written when the decision is recorded, before it
  is carried out. If something else closes the escalation in between, the ruling stays. Write the ruling
  in the same write that carries out the decision.
- Calibrator ①'s currency check reads stored label values while they recompute.
- An exploration seat task already in flight when the exploration settles still has its hand-back
  accepted. It changes nothing; queued ones are cancelled.
- A conclusion settled by accepting residual risks is not re-checked after a move. It stays unproven, and
  the PM is told.
- A second basis withdrawal on the same product raises no new escalation (one id per product).
- The "conclusion unproven" notice is keyed by product and label, so a second loss with the same label
  is not told again.
- A settle after a decision records its stop as `budget`, so reads show "no-conclusion (budget)".
- Some refusals still surface as internal errors (WI-20) instead of coded refusals: an unknown
  escalation, an option the escalation does not offer, withdrawing an unknown item.
- An older PM batch's escalations stay open until the newest batch passes Calibrator ①. Reads already
  treat them as history.

## Promised by the docs, not done by the code (found while drawing the 4.1 workflow page)

- **WI-07:** the page promises that a changed delivery version is registered and that verification and
  re-acceptance steps are offered. The code only records the mismatch and sends a notice
  (`src/delivery/delivery.ts`, `src/delivery/candidate.ts`). The continuation is missing.
- **Integration tasks:** the carried contract (v51) promises them for a delivery whose versions
  conflict. `mp pm deliver` reports the conflicts and asks for a new PM plan batch
  (`src/cli/commands/pm.ts`). Ordinary detailed plans do check integration (`src/flow/mechanical.ts`).
- **Exploration round budget:** v06 promises 3 attack rounds, but a discussion reply also counts as a
  round (`src/flow/exploration/machine.ts`). Count discussions separately.
- **WI-08:** the page promises a ready Secretary step when a loop is used up. When delivery rebuilds or
  landing attempts are used up, only a notice is sent (`src/delivery/delivery.ts`, `src/git/land.ts`).
  Raise the escalation.
- **Closing with work in flight:** the contract (v51) promises a close that waits for running work. The
  CLI has no option for it, and the API closes at once and only keeps accepting in-flight hand-backs
  (`src/process/close.ts`).

## Command line (`src/cli`)

- Operation-id replay:
  - An exact `mp pm stop` retry returns 65 because the payload carries a fresh time.
  - Reusing one `--op` for two different stop releases releases the second.
  - "Started" actions run again on retry.
  - The identity of `say --stdin/--file` lacks the content hash.

  Guard for every fix: `mp pm stop` is never refused or delayed by operation bookkeeping. On a
  conflict it records under a new id and reports.
- The optional Claude Code adapter runs `mp pm next` at session start. It should only print the
  handbook core and a hint.
- The latest-session query does not filter for successful sessions. The filler is information only.

## Read-depth rule (`src/cli/layers.ts`)

- An old dispatch's late hand-back that is refused (for example after release) still marks its task as
  changed.
- A hand-over that needs the user shows only in layer 0's "Waiting on the user" and changes no
  subtask entry.
- `mp read status` and `mp read blocked` scan the whole history on every query, and layer 0 lists every
  mission, delivery and dispatch in flight. Keep current-state and change indexes in-process, read once
  per query, and keep layer 0 to counts and short summaries.

## Platforms

- Only Linux (WSL2) has been run. Run the scenario suites natively on Windows and macOS. The code is
  the same and uses no POSIX-only service, but it has not been exercised there.
