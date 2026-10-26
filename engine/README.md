# Mission Pipeline 4.1 engine

Version 4.1.2. TypeScript implementation of the design contract [`docs/design/DesignDoc_MissionPipeline_4.1_2026-10-10_v06.md`](../docs/design/DesignDoc_MissionPipeline_4.1_2026-10-10_v06.md) (section numbers below refer to it). Where it says "v51 unchanged", the 4.0 design [`DesignDoc_SeatsLedgerRuntime_4.0_2026-10-08_v51.md`](../docs/design/DesignDoc_SeatsLedgerRuntime_4.0_2026-10-08_v51.md) (Chinese) applies. When code and design disagree, the code is wrong or the design is revised first.

## What it is

Three parts, and nothing else (§1):

1. **An objective project memory**, kept in the project folder under `.mission-pipeline/`. The *skeleton* is `memory.db`, a SQLite database: the run chain (who handed which task to whom, on the basis of which version), the state of every requirement, plan, task, dispatch, candidate and delivery, the links between versions, the result of every program check, counts, order, stops, and who filled each seat. The *leaves* are Markdown files people and agents read: your words, requirement items with their quotes, decisions and their reasons, plans, each seat's card and report, run summaries, deliveries. For details the memory keeps a note of what was done and where the detail lives (a commit, a run summary), not the detail itself.
2. **Role descriptions**: one page per seat (`roles/<seat>.md`): what it does, what it receives and hands back, its `mp` commands, its upstream and downstream.
3. **A process**: who comes after whom, what counts as accepted, what is escalated and to whom, how explorations are attacked and stabilized. `mp` advances it and checks every step.

`mp`, the command line, is the only way to read and write the memory. Every command opens `memory.db` itself, does its work in short transactions and exits. There is no service, daemon, socket or watcher.

**A seat is a role; whoever fills it is replaceable.** Any harness that can run a shell command (Claude Code, Codex, any other agent harness) can act as the PM or fill a seat, with any model. The filler is recorded as information only; changing it invalidates nothing. Security, logins, spending and quota are your harness's business: `mp` does no sandboxing, holds no credentials and meters nothing.

## Install

You need Node 22.12 or later and git. Linux, Windows and macOS.

```sh
git clone https://github.com/ZhuoQiuMcgill/mission-pipeline.git
cd mission-pipeline/engine
npm install
npm install -g .
```

`npm install -g .` links the global `mp` command to this folder (on Windows npm makes an `mp.cmd`), so keep the clone where it is. Node strips TypeScript types only outside `node_modules`, so `mp` must run from its own folder: install it linked as above, not from a packed copy. Without npm: `node <clone>/engine/bin/mp.mjs …`, or link `bin/mp.mjs` onto your `PATH` as `mp`.

## Start a project

In your project's folder (a git repository):

```sh
mp init --pointer claude      # or agents, both, none (the default)
```

`mp init` creates `.mission-pipeline/` with `memory.db`, copies the role descriptions into `roles/` and the PM handbook with its work instructions into `pm/`, writes `config.json`, and adds `.mission-pipeline/` to `.git/info/exclude` (the memory is not committed by default). `--pointer` adds one line to `CLAUDE.md` and/or `AGENTS.md`: "If you are acting as the Mission Pipeline PM, read `.mission-pipeline/pm/PM.md`." It carries no pipeline rules, because seats may read the same file. When the repository's git directory lies outside the folder (a linked worktree, a shared repository), uses alternates or is a partial clone, init warns (WI-31) and still initializes.

`config.json` holds what the project declares; edit it by hand and check it with `mp config`:

| Key | Meaning |
|---|---|
| `targetBranch` | the branch deliveries land on (default: the branch checked out at init) |
| `verificationCommands` | the project's local tests, for the PM and the Architect to name in plans (each task's card carries the commands `mp` runs) |
| `fullSuite` | `[{ "id", "command", "cwd"? }]`, the project's full test suite. `mp` runs it on a clean checkout for an integration task's Reviewer (`mp seat <id> full-run`) and on the PM's decision (`mp pm full-run`); it is never a task's verification command. The 4.1.1 key `closingChecks` is read as its alias when `fullSuite` is absent; `mp config` says which key it read and warns when both are present |
| `cleanupCommands` | `[{ "id", "command" }]`, run in the root of each run's clean checkout after the run's commands (also when one fails or times out), before `mp` removes the checkout. They release what the project's commands made outside the checkout. Docker Compose, for example, names a project after the folder it runs in, so a Compose command run there leaves a network and the images it built for each run; `docker compose -f docker-compose.yml --project-directory . down --rmi local --remove-orphans` removes them (`--rmi local` removes only images without a custom tag, i.e. the ones Compose built for that throwaway project). Best effort: each command gets at most 5 minutes (less when `commandTimeoutMs` is shorter); a failure is a note in the run's summary leaf and changes no result, evidence or reuse. Default none |
| `environment.versionCommands` | what the environment identity covers, e.g. `node --version`; init declares the ones it recognises |
| `commandTimeoutMs` | per declared command (default 30 minutes) |
| `exclusiveResources` | resources tasks may lease |
| `fillers` | per seat, a hint `"<harness>/<model>"` that `mp pm next` shows; information only |
| `commit` | `{ "author"?, "committer"? }` as `"Name <email>"`: the identity of the commits `mp` writes (candidates, deliveries, rebuilds); default `Mission Pipeline <mp@localhost>`, and the committer defaults to the author |

`mp docs update` refreshes `roles/` and `pm/` from the installed `mp` (the version is recorded in `pm/installed.json`). Run it after every upgrade of `mp`: the project keeps its own copies, and an upgrade does not replace them, so the PM and the seats would otherwise read the old handbook and role pages. The upgrade notes for each release are in `CHANGELOG.md`.

## How a harness acts as the PM

The PM is the one session on your screen. Your harness reads `.mission-pipeline/pm/PM.md` (the pointer line, or you tell it to). Then:

1. `mp pm session --filled-by "<harness>/<model>"`: every later `mp pm` command is attributed to it.
2. Every message of yours: `mp pm say "<the message, verbatim>"` → a words entry `W-<n>`. Requirement items quote it (`mp pm requirement add … --quote "…" --words W-<n>`, refused unless the quote is in that entry); the PM plan starts from `mp pm plan template <mission>` (a valid skeleton prefilled with the requirement items) and goes in with `mp pm plan submit <mission> --file plan.json --words W-<n>`. `mp help pm <command>` shows any command's arguments.
3. The dispatch loop: `mp pm next` lists the notices first, then the ready steps (seat, task, mission, purpose, whether it can run in parallel), what waits on you, and the dispatches in flight with their age. `mp pm dispatch <step> --filled-by "<harness>/<model>"` claims a step once and prints a fixed prompt; the PM starts a sub-agent in its own harness with exactly that prompt: "You are the <seat> of Mission Pipeline. Your card: `mp seat <id> card`. Use only the `mp seat <id>` commands listed there. Finish with `mp seat <id> handback`." After each hand-back, `mp pm next` again. The process moves only while a PM session runs `mp`.
4. A seat that ended without handing back: `mp pm release <id> --ended` (your harness confirmed it) or `--abandoned` (not confirmed; the step is ready again at once).
5. Stop, forbid, withdraw: `mp pm stop "<your words>"` at once (a conservative scope; it is written before anything else), then the PM stops the running seats in its harness.
6. You guide the direction and never accept details. When the work is done the PM reports it; you try the result. A problem you find becomes a repair: `mp pm repair <mission> --words W-<n> --kind defect|usability|missing|new-question --text "<your reason, verbatim>"`. The Architect reopens the task whose work causes it, or adds a task, under the mechanical checks only.
7. Before closing, the PM sees whether the delivered tree changed since the last full run of the project's full suite (`mp read full-runs <mission>`) and decides with you whether another run is worth it: `mp pm full-run <mission> --words W-<n> --reason "…"`, or `--authority <item>` when you left it to the PM.
8. "Close and merge" is consent to land: `mp pm finish <mission> --words W-<n>` delivers the accepted outputs, lands and closes, all on your one sentence. Landing only fast-forwards the target branch from the base the candidate was proven on; it never merges. When landing cannot complete, `finish` stops after the delivery with the mission open, and the same words serve once the WI is resolved. The separate steps stay for advanced use: `mp pm deliver` (no command runs), `mp pm land`, `mp pm close`.
9. Closing never refuses on the state of the work. The closing snapshot records what is delivered with its labels, what is not proven or unfinished, the open and deferred issues, the repairs and the full-run status of the delivered tree; `--mode` is only recorded. The mission's production steps are held, while audits, deliveries and fixes go on.
10. After an environment change (a move, a tool update), runs from the older environment still count and reads mark them "older environment"; `mp pm next` tells the PM once. When the change matters, `mp pm renew` reruns them and `mp pm reopen-exploration` reopens a settled exploration.
11. Leftovers: `mp` removes its checkouts when it is done with them, and `mp pm next` sweeps what killed processes left. `mp pm clean` frees the rest and reports the space.

Exceptions arrive as notices that name a work instruction (WI). The PM reads only `pm/wi/INDEX.md` and opens a WI page when a notice names it. Every `mp pm` command prints its operation id; `--op <id>` on a retry returns the recorded result instead of running twice. Exit code 75 means "busy, retry": nothing was written.

**Optional Claude Code adapter.** `engine/plugin/` is also a Claude Code plugin: it puts `mp` on the PATH, prints a neutral three-line pointer at session start (the PM reads its handbook and runs `mp pm next`; a seat follows its card) and runs nothing then, and records each of your messages with `mp pm say` (the PM's own `mp pm say` of the same text then records nothing new). A dispatched seat's session starts through the same hook, so the hook never acts as the PM. Nothing needs it.

## Seats and roles

| Seat | Does | Commands (`mp seat <id> …`) |
|---|---|---|
| Calibrator ① / ② | checks the PM plan against your words; checks the detailed plan against the PM plan | card, read, handback |
| Architect | decomposes the approved plan into tasks; reviews feasibility; turns a repair into reopened or added tasks | card, read, checkout, handback (repair: owners) |
| Secretary | decides one escalation within your recorded authority, or asks you | card, read, handback |
| Constructor | builds one task in its own git worktree (`.mission-pipeline/worktrees/<dispatch>/`); runs local tests only | card, read, handback (blind experiments: rerun) |
| Reviewer | judges the candidate against its standards, citing the program's runs; on an integration task, runs the full suite last and reopens the task a failure traces to | card, read, checkout, rerun, handback (integration: owners, full-run) |
| Researcher, Crititor | explorations: author and attacker | card, read, checkout, request-evidence, handback |
| Stabilizer | after each attack round: which findings bind the author, and whether the work drifts | card, read, handback |
| Auditor | legalizes a lineage when you ask | card, read, checkout, rerun, handback |

A seat's card is self-contained: its role page, its task, its materials (read page by page, hash-checked), its commands and the hand-back format. A hand-back is one document on stdin, `mp seat <id> handback --stdin`: the report in Markdown, ending with the structured fields as a fenced json block (schema on the card); `mp` files both under `.mission-pipeline/tmp/<dispatch>/`. A harness whose seats may write files can also pass them: `--report <file> --result <file>`. `mp` checks them against the role's rules; a refused hand-back does not count and the seat fixes it. For a Constructor, `mp` collects every change git does not ignore from its worktree (no `git add` needed); inside the write paths it becomes the candidate commit, and the card's verification commands run on a clean checkout of that commit. Those runs are the evidence, and they are the task's verification: the flow does not run them again. A seat's own runs are scratch. A rework continues in a worktree at the previous attempt's candidate; the product version accepted at any attempt brings the task's whole change since its first attempt began, which is what a dependent task's snapshot and a delivery lay over their base.

A run's clean checkout (`.mission-pipeline/tmp/<run>/`: verification, `mp seat <id> rerun`, `mp pm renew`, and full runs) is a git repository of its own, so commands that ask git questions answer them for the candidate: HEAD is the candidate commit (detached), `git ls-files` lists its files, `git status` of an untouched checkout is empty when its bytes convert back to the candidate blobs (non-normalized text blobs and unsupported filters can report modifications), `git log` and `git diff <base>..HEAD` show its history and change, and the checkout's own `.gitignore` decides what is ignored. Its `.git` borrows your repository's objects (`objects/info/alternates`, plus your `shallow` list when the clone is shallow) and carries the transform settings the files were written under (`core.autocrlf`, `core.eol`, `core.symlinks`, `core.filemode`, `core.ignorecase`, the info and global attribute files); an internal engine conversion keeps LFS content clean, with no project LFS program. No remote or branch is copied. Setup runs with hooks disabled, including a global `core.hooksPath`; that override is not saved, so declared commands use their normal hooks. Nothing is added to your repository (no worktree, ref or setting), no object is ever fetched for it, and it is removed with the checkout. Commands there get no `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` or other variable that would point git elsewhere. Declared runs record method v2, also part of the environment identity; runs of the older method (recorded by 4.1.0) are kept but do not count until they are renewed, and reuse requires a v2 run. Runs from an older environment identity still count; reads mark them "older environment". Renewal still requires equal declared fields. Every declared command takes its run lock, including in a mixed group. If any command is not reusable, commands execute in order in one checkout; reusable commands run only as setup and add no evidence. Setup failures are notes and later commands still run. After the commands, also when one fails, `mp` runs the project's `cleanupCommands` in the checkout root, then removes the checkout. A full run (`mp seat <id> full-run`, `mp pm full-run`) executes every `fullSuite` command in order in one such checkout of one commit and records a full-run marker: the commit and tree, the environment, each command's exit, the result, the last 400 lines of each failing command, and who decided it. A passing full run on the same tree, environment and suite is reused, never executed again; a failed one executes again. `mp pm deliver` runs no command: it shows the full-run status of its tree. A seat's `mp seat <id> checkout` is a plain copy of the files for reading, shared by the seats reading that commit and made read-only.

## The memory folder: skeleton and leaves

```
.mission-pipeline/
  memory.db                  the skeleton (SQLite, journal mode DELETE)
  config.json                what the project declares
  words/<date>.md            your words, one anchored entry per message (W-<n>)
  missions/<m>/              requirements.md, decisions.md, notices.md, plans/, dispatches/<d>/card.md and report.md,
                             runs/, explorations/, deliveries/
  roles/  pm/                role descriptions, the PM handbook and work instructions
  worktrees/<dispatch>/      a Constructor's git worktree, removed after its hand-back or release
  tmp/<dispatch>/            a dispatch's hand-back files, removed once the hand-back is recorded or the dispatch released
  tmp/<run>/                 a run's clean checkout, removed after the run
  tmp/checkouts/<commit>/    the read-only checkout of a commit that reading seats share, removed when no dispatch in flight holds it
  tmp/.trash-*               removals in progress
  locks/                     process locks; locks/owners/ holds one owner lock per scratch directory under tmp/
```

Every scratch directory under `tmp/` has an owner: the `mp` process that made it holds its lock under `locks/owners/` for the directory's whole life, and the operating system releases the lock when that process exits. A removal renames the directory into `tmp/.trash-*` first, so nobody sees half a tree. `mp pm next` sweeps, for at most 1.5 seconds, what no live process owns: scratch of killed processes, the folders of dispatches no longer in flight, shared checkouts no dispatch in flight holds, scratch from before 4.1.2 once it is a day old, and the trash. It never touches an entry it does not know. `mp pm clean [--mission <m>]` does the same without a time limit, also removes the worktrees of dispatches that are over, and reports the bytes freed and what it kept. Never delete under `.mission-pipeline/` by hand.

Leaves are plain Markdown that anyone can read without `mp`. The skeleton names each leaf by file, anchor and the hash of its text, so a missing or hand-edited leaf is noticed and shown (WI-30), never silently served. Products are commits in your repository, on refs under `refs/mission-pipeline/`.

**Moving to another machine.** Copy the project folder (with `.mission-pipeline/` in it) while no `mp` command runs and no seat is working, and open it with any harness on Linux, Windows or macOS. The first `mp` command in the copy notices the move and, under a lock, repairs the worktrees and verifies both link directions, the common directory and their registration at the copied paths (only when the common git directory is inside the folder; failed verification holds git writes and leaves the move pending under WI-31), verifies the event log's hash chain, rebuilds the state from the log, and checks every leaf and every commit the memory names; it reports what it found before its own answer. A broken event chain stops all writes (WI-29: copy again, or `mp pm continue-from <event>`). A copy that shares its repository with another copy holds git writes until `mp pm confirm-copy` (WI-31). Runs made under another environment identity still count, and reads mark them "older environment"; `mp pm next` tells the PM once. When the change matters, `mp pm renew` reruns them under the new identity and renews the evidence without a seat when the outputs are equal.

## Reading

The read-depth rule decides how much you get back:

- `mp read status` ("how is it going?"): layer 0 (stops, missions, dispatches in flight with their age, what waits on you, notices, labels, the environment, and the count of persistently blocked subtasks); plus, only when some subtask's state changed since you last asked, the layer-1 entries of exactly those subtasks (a requirement item, a plan task or an exploration: its state, the time of its last change, and why it is blocked and what comes next). A failure, a refutation, a cancellation or an exploration's conclusion is a change too. Nothing changed: layer 0 only.
- `mp read blocked` ("why is it not done?"): every blocked subtask once, with all its reasons and the next step. Blocked means held for a reason outside its own work: an open escalation about it that the flow still handles (a used-up loop, WI-08, until the Secretary's decision is carried out; an exploration awaiting a ruling; a decision waiting on you; an escalation about a task a re-plan dropped, or about a superseded PM plan, is history, not a block), a stop (also one over a seat still working, or over a hand-back that arrived after it), a closed mission, the git-writes hold, a lease, or a dispatch in flight for over an hour without a hand-back. A task that passes on its last allowed attempt is not blocked. The labels recomputing is one project line, not a blocked subtask. The count in `mp read status` comes from the same computation.
- `mp read show <kind> <id>`: one item (mission, task, dispatch, plan, object, judgment, run, delivery, exploration, …) with its state, checks, links and leaf paths. `mp read show exploration <id>`: the findings round by round with the author's dispositions and the Stabilizer's verdicts.
- `mp read leaf <id>`: a leaf's text, hash-checked.
- The tree reads, on the skeleton's links:
  - `mp read why <id>` walks back from any node (a commit or branch, a run, a judgment, a task, a dispatch, a decision, a delivery) to your words, showing for each step who handed it over, its state, the program's checks and its leaf. `mp read why main` after a landing goes from the delivered commit through the delivery, the product, the Constructor's dispatch, the task, the detailed plan, the Architect's dispatch, the PM plan and the requirement items to the words entries.
  - `mp read from <id>`: everything that rests on a node (what a withdrawn requirement or a refuted version affects).
  - `mp read chain <dispatch>`: one dispatch: its card, the step that handed it over, its report, its checks, and what it led to.
  - `mp read tree <mission>`: the whole mission as one indented tree, words → requirements → plans → tasks → dispatches → candidates → judgments → deliveries, one line per node with its state and check result.
- `mp read full-runs <mission>`: the mission's full-run markers, newest first: when each full suite ran, on which commit and tree, under which environment, its result, and who decided it.

Every command prints text; `--json` gives the same answer for programs.

## Harness notes

Any harness that can run a shell command can be the PM or fill a seat. Some meet the process at its edges; these examples come from real runs and are not requirements:

- **Claude Code.** Sub-agents may refuse to write report files: seats hand back with `mp seat <id> handback --stdin`, which is the card's first form. The optional adapter (`engine/plugin/`) records only your real prompts, never the harness's own messages.
- **Codex.** Its workspace-write sandbox makes `.git` read-only, so a PM or a Constructor running in Codex needs `.git` writable (for example `--add-dir <project>/.git`). A Codex Reviewer no longer needs it to hand back: what a seat's sandbox could not write is a note ("left to the PM"), and the PM's next `mp pm next` carries the pass. Its reruns run in a checkout with a repository of its own, so they need no write access to the project's `.git` either. A rerun that builds Docker images also needs network access and `~/.docker/buildx` writable (Buildx records its activity there). A sandboxed Codex cannot start nested `codex exec` seats: a Codex PM that starts Codex seats runs without the sandbox (your choice: security is the harness's business) or starts its seats another way. Use the Codex binary that supports your model; an older `codex` earlier on the `PATH` may refuse newer models.

## Platforms

Linux, Windows and macOS with Node 22.12+ (the built-in `node:sqlite`) and git. Paths in the memory are relative to the project folder, so a copy reads the same on any of them. Declared commands run with the platform's shell. Process locks (a landing, the recovery after a move, a declared run while it executes) are SQLite file locks the operating system releases when the holder exits.

## Layout

| Directory | Owns | Design |
|---|---|---|
| `src/memory/` | the skeleton: `memory.db`, the hash-chained event log, projections, leaves, the recovery after a move, process locks | §3, §4.1 |
| `src/evaluator/` | the stored proof labels and their bounded propagation, run classes, the environment identity, renewal | §4.1, §6.5 |
| `src/process/` | the PM's dispatch loop and the seats' commands over the flows | §5, §6 |
| `src/flow/` | the decision layer, execution, exploration with the Stabilizer, legalization | §6.1–§6.4, §6.8 |
| `src/seat/cards/` | every card kind: its fields, rendering and hand-back checks | §5.2, §5.3 |
| `src/git/`, `src/delivery/` | worktrees and candidate collection, delivery and landing with plain git | §5.3, §6.7 |
| `src/cli/` | `mp`: the command groups, `mp init`, the layered and tree reads | §4.1, §8, §9 |
| `plugin/` | role descriptions, the PM handbook and WI pages (copied by `mp init`); the optional Claude Code adapter | §1, §6.9 |
| `bin/mp.mjs` | the launcher | §9 |
| `test/` | `node:test` suites; `cli-*` drive `mp` itself, some from a shell | §11 |

## Development conventions

- Node 22.12 or later; code runs with `--experimental-strip-types`, so only erasable TypeScript syntax: no `enum`, no `namespace`, no parameter properties. Imports use the `.ts` extension.
- `npm run typecheck` (tsc, strict) and `npm test` (node:test) must both pass; `npm run test:cli` runs the command-line suites. `test/cli-mission.test.ts` runs a whole mission through the shell-invoked `mp` (set `MP_TEST_INPROCESS=1` to run it in-process).
- Run tests with a short `TMPDIR` on a local filesystem (for example `TMPDIR=$(mktemp -d /tmp/mpc.XXXX)`).
- No test may touch the repository's `data/` directory.
- Product documents (the PM handbook, WI pages, role descriptions, README, CLI text) are in English.

## Known limitations of 4.1

- **A copy taken while `mp` writes is not supported.** The checks after a move catch a broken event chain, missing or edited leaves and missing commits, but a copy that is internally consistent and simply older than its source cannot be told from a deliberate older copy.
- The process advances only while a PM session runs `mp`. Your words are recorded by the PM's discipline (or the optional hook); a PM that forgets loses the provenance of a requirement.
- A seat that ignores its role is caught only at hand-back; what it did meanwhile is its harness's business. `mp` never decides that a seat died: the PM releases it.
- The environment identity covers only the operating system, the architecture and the version commands the project declares.
- Leaves are plain files: an edit is detected by its hash and shown, not prevented. Full run output and seat conversations are not kept.
- With pathological inputs one label propagation step can take a few seconds; a stop then waits for that one step.
- Tested on Linux (WSL2). Windows and macOS use the same code (Node, git, SQLite file locks) but have not been through the scenario suites yet.
- 4.1 does not read 4.0.x ledgers; a field PM migrates missions by the new rules.
