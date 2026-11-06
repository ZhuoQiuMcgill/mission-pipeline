# Mission Pipeline 4.3 engine

Version 4.3.0. The role split and word rules are in [the 4.3 design](../docs/design/DesignDoc_PMSecretary_2026-11-06_v03.md); Appendix A supersedes the named text and Appendix B wins over A.
The [4.1 design](../docs/design/DesignDoc_MissionPipeline_4.1_2026-10-10_v06.md) still governs the unchanged process (section numbers below refer to it).
Where it says "v51 unchanged", the [4.0 design](../docs/design/DesignDoc_SeatsLedgerRuntime_4.0_2026-10-08_v51.md) applies.
When code and design disagree, the code is wrong or the design is revised first.

## What it is

Three parts, and nothing else (§1):

1. **An objective project memory**, kept in the project folder under `.mission-pipeline/`. The *skeleton* is `memory.db`, a SQLite database: the run chain (who handed which task to whom, on the basis of which version), the state of every requirement, plan, task, dispatch, candidate and delivery, the links between versions, the result of every program check, counts, order, stops, and who filled each seat. The *leaves* are Markdown files people and agents read: your words, requirement items with their quotes, decisions and their reasons, plans, each seat's card and report, run summaries, deliveries. For details the memory keeps a note of what was done and where the detail lives (a commit, a run summary), not the detail itself.
2. **Role descriptions**: one page per seat (`roles/<seat>.md`): what it does, what it receives and hands back, its `mp` commands, its upstream and downstream.
3. **A process**: who comes after whom, what counts as accepted, what is escalated and to whom, how explorations are attacked and stabilized. `mp` advances it and checks every step.

`mp`, the command line, is the only way to read and write the memory. Every command opens `memory.db` itself, does its work in short transactions and exits. There is no service, daemon, socket or watcher.

**A seat is a role; whoever fills it is replaceable.** Any harness that can run a shell command (Claude Code, Codex, any other agent harness) can act as the PM, the Secretary or a seat, with any model. The filler is recorded as information only; changing it invalidates nothing. Security, logins, spending and quota are your harness's business: `mp` does no sandboxing, holds no credentials and meters nothing.

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

`mp init` creates `.mission-pipeline/` with `memory.db`, copies role descriptions into `roles/`, the PM handbook and WI pages into `pm/`, and the resident handbook into `secretary/`, writes `config.json`, and adds `.mission-pipeline/` to `.git/info/exclude` (the memory is not committed by default). `--pointer` adds one line to `CLAUDE.md` and/or `AGENTS.md`: "If you are acting as the Mission Pipeline PM, read `.mission-pipeline/pm/PM.md`." It carries no pipeline rules, because seats may read the same file. When the repository's git directory lies outside the folder (a linked worktree, a shared repository), uses alternates or is a partial clone, init warns (WI-31) and still initializes.

`config.json` holds what the project declares; edit it by hand and check it with `mp config`:

| Key | Meaning |
|---|---|
| `projectName` | the resident session is named `<project>-Secretary`; default: the folder name |
| `targetBranch` | the branch deliveries land on (default: the branch checked out at init) |
| `verificationCommands` | the project's local tests, for the PM and the Architect to name in plans (each task's card carries the commands `mp` runs) |
| `fullSuite` | `[{ "id", "command", "cwd"? }]`, the project's full test suite. `mp` runs it on a clean checkout for an integration task's Reviewer (`mp seat <id> full-run`) and on the PM's decision (`mp pm full-run`); it is never a task's verification command. The 4.1.1 key `closingChecks` is read as its alias when `fullSuite` is absent; `mp config` says which key it read and warns when both are present |
| `cleanupCommands` | `[{ "id", "command" }]`, run in the root of each run's clean checkout after the run's commands (also when one fails or times out), before `mp` removes the checkout. They release what the project's commands made outside the checkout. Docker Compose, for example, names a project after the folder it runs in, so a Compose command run there leaves a network and the images it built for each run; `docker compose -f docker-compose.yml --project-directory . down --rmi local --remove-orphans` removes them (`--rmi local` removes only images without a custom tag, i.e. the ones Compose built for that throwaway project). Best effort: each command gets at most 5 minutes (less when `commandTimeoutMs` is shorter); a failure is a note in the run's summary leaf and changes no result, evidence or reuse. Default none |
| `environment.versionCommands` | what the environment identity covers, e.g. `node --version`; init declares the ones it recognises |
| `shell` | an absolute path, e.g. `/bin/bash`: the shell of every declared command (local tests, reruns, renewals, full runs, cleanup commands). Absent: the platform's shell (`/bin/sh`, `cmd.exe`). When set it is part of the environment identity, so changing it marks earlier runs "older environment" (they still count). The version commands themselves still run under the platform's shell |
| `experimentShell` | an absolute path: the shell of the reruns an exploration's experiment executor makes. Absent: `shell`, else the platform's shell. Not part of the environment identity |
| `commandTimeoutMs` | per declared command (default 30 minutes, at most 24 hours) |
| `experimentCommandTimeoutMs` | per declared command that an exploration's experiment executor runs with `mp seat <id> rerun` (a `constructor-experiment` card), at most 7 days; absent, it is `commandTimeoutMs`. An experiment that needs a day can run to its end while every other command (verification, other reruns, renewals, full runs) keeps `commandTimeoutMs`, so a hung test still ends early. Such a rerun takes no run lock and holds no write lock of the memory while it runs, so other `mp` commands go on |
| `startOnHandback` | mission ids whose tasks may start on a dependency's verified hand-back (its runs recorded and all passed) while that dependency is still in review. It removes no check: the dependent's acceptance waits for the dependency's, and work started on a version the review sent back is carried onto the next one. Never an integration task; no effect in stable mode. Default none |
| `planReviewsWaived` | deprecated in 4.1.3: a project setting is not a waiver. Mission ids or detailed plan versions whose plans take effect without the feasibility review and Calibrator ②, labelled "waived by config `planReviewsWaived`; no words on record". Still read until a withdrawal is on the record; `mp config` warns. Use `mp pm waive <mission> plan-reviews --words W-<n>` instead |
| `exclusiveResources` | resources tasks may lease |
| `fillers` | per seat, a hint `"<harness>/<model>"` that `mp sec next` shows; information only |
| `commit` | `{ "author"?, "committer"? }` as `"Name <email>"`: the identity of the commits `mp` writes (candidates, deliveries, rebuilds); default `Mission Pipeline <mp@localhost>`, and the committer defaults to the author |

`mp config` also shows the shell of each run class (declared commands, and an exploration's experiment reruns) and where it comes from, and warns when a configured shell does not exist on this machine.

`mp docs update` refreshes `roles/`, `pm/` and `secretary/` from the installed `mp` (the version is recorded in `pm/installed.json`). Run it after every upgrade of `mp`: the project keeps its own copies, and an upgrade does not replace them, so the PM and the seats would otherwise read the old handbook and role pages. The upgrade notes for each release are in `CHANGELOG.md`.

## How a harness acts as the PM

The PM is the user's anchor, the conversation on their screen.
Mission Pipeline exists so agents produce results that are responsible to the user.
The PM understands the user's logic and needs, writes a results-level plan, and keeps long automated work from drifting.
Important decisions rest on recorded words so a new PM session loses little; dispatch detail stays with the Secretary.

Read `.mission-pipeline/pm/PM.md`, then `mp pm session --filled-by "<harness>/<model>"` for bounded layer 1.
Every reply starts with the PM's reading of the message type in the user's language, listing composite parts.
The PM records words with `mp pm say --tag` after the next message raises no objection; one-off instructions record at once with all their tags, and confirmed unrelated messages are never recorded.
Words do not expire by time; first tags for old words wait until relevant, and re-tagging needs the user's recorded authorization.
Requirements quote the words; the PM plan starts with `mp pm plan template` and goes in with `mp pm plan submit`.

The PM decides plan structure, changes to what the user gets, irreversible external steps and conflicts with their words.
Before deciding, it reads subject layer 2 and all principles in force, including any omitted by layer 1's hard 8 KiB bound.
Supporting words: decide; no supporting words and major impact: ask the user.
Minor impact with no words: decide with a reason, visible as "by the PM, no words on record" (F-3 default pending a maintainer ruling).
A structural detailed-plan revision waits for its `plan-structure-change` answer, `approve` or `send-back`.
`mp pm inbox` holds these questions and PM notices until resolved; `mp pm inbox --asked-user <item>` marks a pending user question without words.
`mp pm answer --by pm --words` records a PM choice; `--no-words --reason` records the minor-impact default; `--by user --words` records the user's choice.

The PM starts the resident with `mp pm secretary start`, launches the printed command and binds the handle with `mp pm secretary handle <S-n> <handle>`.
A pending generation becomes live at the Secretary's `mp sec session`; `--replace` retires the previous live generation.
`mp read secretary` shows its state and handle.
For the user's progress details, the PM records `mp pm ask-secretary "<question>"`; after a new instruction, `mp pm note "<text>" [--words W-<n>]`.
Memory is the channel of record; an optional harness message wakes the other session.
The PM reads status or details only when the user asks; it does not run the loop, read operational notices or WI pages, or handle exceptions.

Stop: record the one-off words and `mp pm stop` at once; the Secretary stops and confirms its seats.
Unconfirmed seats include abandoned dispatches not yet ended and remain visible in layer 0 and layer 1.
The PM never releases while a generation is live.
If it makes no command within 60 s of the stop, or the user says it is gone, `mp pm secretary stop` retires it and prints how to stop its harness session by handle or name.
After harness confirmation, the PM may release unconfirmed seats `--ended` in 4.2 mode.

When work ends, the PM reports conclusions or where to try the result; the user judges completion and names repairs.
`mp pm repair` records the user's reason; a direct method decision uses `--attempts`, `--rerun` or `--resnapshot`, without a review round.
The user can waive plan reviews on recorded words (`mp pm waive`); the waiver is shown in proof reads, not called proof.
The PM judges whether changes since `mp read full-runs <mission>` merit another full run and asks, or uses a recorded authorization.
"Close and merge" is consent: `mp pm finish <mission> --words W-<n>` delivers, lands and closes; it never merges and closing records the honest state.
A delivery exception goes to the Secretary; the same consent serves once resolved.

## How a harness acts as the Secretary

The resident session is `<project>-Secretary`, with launch environment `MP_SECRETARY=S-<n>`; leave that variable unset in the PM session.
It reads `.mission-pipeline/secretary/SECRETARY.md` (`mp sec handbook`) and runs `mp sec session`.
It absorbs dispatch detail, answers questions, and takes no direct user instructions: "please tell the PM".
It does not report progress unasked.

`mp sec next` shows stops first, PM notes and questions, PM decisions, notices, ready steps, dispatches, ended detached runs and revision R.
`mp sec dispatch <step> --filled-by "<harness>/<model>"` claims and prints the card.
Start a sub-agent with exactly the fixed prompt: "You are the <seat> of Mission Pipeline. Your card: `mp seat <id> card`. Use only the `mp seat <id>` commands listed there. Finish with `mp seat <id> handback`."
After hand-back, next again; when idle, `mp sec wait --since R` wakes on changes and does periodic liveness, label and landing checks.
Secretary decision steps use the resident's card/read/decide commands; they do not start a one-shot Secretary.
The Secretary opens `pm/wi/INDEX.md` and a WI page only when a notice names it; ids and paths stay unchanged.
It handles interrupted dispatches (`mp sec release --ended` after confirmation, `--abandoned` otherwise), detached runs, environment renewal, reviews, reworks and exceptions.
Operational notice acknowledgement: `mp sec alerts --ack <id>`; a stop's abandoned seats still require ended confirmation.

Decisions use `mp sec card <escalation>`, `mp sec read <escalation> <material>` and `mp sec decide <escalation> ...`; must-reads belong to the current round.
Within the plan, it decides details; unsure and reversible: decide; irreversible: escalate.
PM-class choices use `needs-pm` / `ask-pm` even when an authorization exists; a structural revised plan waits for PM approval.
The Secretary has one grant of 1–2 extra attempts or rounds per lineage; later grants are the PM's or user's.
It acknowledges PM notes (`mp sec ack-note`) and answers questions (`mp sec reply`); the reply reaches the PM inbox.
The live generation fences new operational effects; already admitted runs record their results under existing stop, lease and claim guards.
PM commands and reads do no operational recovery while it is live; the Secretary reconciles changes at next or wait.

With no live Secretary, older loop names under `mp pm` still work in 4.2 mode.
A pending launch changes nothing until claimed; a resident may adopt in-flight 4.2 dispatches while their seats remain in the PM's harness.

**Optional Claude Code adapter.** `plugin/` puts `mp` on PATH and prints a neutral session pointer without running the loop.
Its prompt hook records nothing: in the PM session it reminds the PM about typing and deferred recording; with `MP_SECRETARY` set it is silent.
No harness requires this adapter.

## Seats and roles

The PM and resident Secretary are conversations, described above.
The following seats are dispatched with cards by the Secretary.

| Seat | Does | Commands (`mp seat <id> …`) |
|---|---|---|
| Calibrator ① / ② | checks the PM plan against your words; checks the detailed plan against the PM plan | card, read, handback |
| Architect | decomposes the approved plan into tasks; reviews feasibility; turns a repair into reopened or added tasks | card, read, checkout, handback (repair: owners) |
| Constructor | builds one task in its own git worktree (`.mission-pipeline/worktrees/<dispatch>/`); runs local tests only | card, read, handback (blind experiments: rerun, wait) |
| Reviewer | judges the candidate against its standards, citing the program's runs; on an integration task, runs the full suite last and reopens the task a failure traces to | card, read, checkout, rerun, wait, handback (integration: owners, full-run) |
| Researcher, Crititor | explorations: author and attacker | card, read, checkout, request-evidence, handback |
| Stabilizer | after each attack round: which findings bind the author, whether the work drifts, and which of the author's revisions or rebuttals answer their finding (`answered`: resolved without a re-check) | card, read, handback |
| Auditor | legalizes a lineage when you ask | card, read, checkout, rerun, wait, handback |

A seat's card is self-contained: its role page, its task, the project constraints that apply to it (`mp pm constraint add`; an instruction shows as "Instruction (follow it; not a proof input)"; an instruction with `**` and no task types reaches every task, a task with no write paths included; an exploration's blind executors get only the instructions that name their seat), its materials (read page by page, hash-checked), its commands and the hand-back format. A hand-back is one document on stdin, `mp seat <id> handback --stdin`: the report in Markdown, ending with the structured fields as a fenced json block (schema on the card); `mp` files both under `.mission-pipeline/tmp/<dispatch>/`. A harness whose seats may write files can also pass them: `--report <file> --result <file>`. `mp` checks them against the role's rules; a refused hand-back does not count and the seat fixes it. For a Constructor, `mp` collects every change git does not ignore from its worktree (no `git add` needed); inside the write paths it becomes the candidate commit, and the card's verification commands run on a clean checkout of that commit. Those runs are the evidence, and they are the task's verification: the flow does not run them again. A seat's own runs are scratch.

**Constraint patterns.** `mp pm constraint add --paths` takes `**` (every path), an exact path such as `src/app.ts`, or a folder and everything under it such as `docs/reports/**`. Only `*` and `?` count as wildcards, so `pages/[id].tsx` is an exact path. Any other pattern is refused with `NOT_ALLOWED`, naming the nearest form, and nothing is recorded. The command prints what the scope matches now (object versions and tasks of the plans in effect) and warns when that is nothing.

**Data outside the commit.** An exploration's seats may cite a file outside the repository as `data:<absolute path>[:<line>[-<line>]]#sha256=<64 hex>&size=<bytes>` (a space in the path is `%20`, a `%` is `%25`; a line suffix is read only when everything after the last colon is digits). Readers and experiment executors use it in sources and bases; authors in messages, artifacts, dispositions and attempts; interpreters in answers and conclusions; attackers in bases and re-checks. When the hand-back is recorded, `mp` checks that the path is absolute and a regular readable file, and its size and sha256, before the write; a mismatch refuses the hand-back with the expected and actual values. A file over 2 GiB is checked by its size and the sha256 of its first and last 64 MiB. The evidence records the path, line, sha256, size and check kind, labelled "outside the commit (sha256 checked at hand-back)" or the partial wording. `mp read show evidence <id> --check-data` hashes the files again later and says `unchanged`, `changed` or `missing`; it writes nothing.

**The executor's report.** An experiment executor's or reader's report (cut at 256 KiB, with the full size and sha256 noted) is kept with its evidence record and served as a material to the exploration's author, attacker and interpreter. An evidence request whose commands its executor could not run (a working directory that is absolute, leaves the checkout or lies in `.git`; a command id declared twice; the project's full suite; commands on a reading) is refused when it is made, with the reason.

A rework continues in a worktree at the previous attempt's candidate; the product version accepted at any attempt brings the task's whole change since its first attempt began, which is what a dependent task's snapshot and a delivery lay over their base.

A run's clean checkout (`.mission-pipeline/tmp/<run>/`: verification, `mp seat <id> rerun`, `mp pm renew`, and full runs) is a git repository of its own, so commands that ask git questions answer them for the candidate: HEAD is the candidate commit (detached), `git ls-files` lists its files, `git status` of an untouched checkout is empty when its bytes convert back to the candidate blobs (non-normalized text blobs and unsupported filters can report modifications), `git log` and `git diff <base>..HEAD` show its history and change, and the checkout's own `.gitignore` decides what is ignored. Its `.git` borrows your repository's objects (`objects/info/alternates`, plus your `shallow` list when the clone is shallow) and carries the transform settings the files were written under (`core.autocrlf`, `core.eol`, `core.symlinks`, `core.filemode`, `core.ignorecase`, the info and global attribute files); an internal engine conversion keeps LFS content clean, with no project LFS program. No remote or branch is copied. Setup runs with hooks disabled, including a global `core.hooksPath`; that override is not saved, so declared commands use their normal hooks. Nothing is added to your repository (no worktree, ref or setting), no object is ever fetched for it, and it is removed with the checkout. Commands there get no `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` or other variable that would point git elsewhere. Declared runs record method v2, also part of the environment identity; runs of the older method (recorded by 4.1.0) are kept but do not count until they are renewed, and reuse requires a v2 run. Runs from an older environment identity still count; reads mark them "older environment". Renewal still requires equal declared fields. Every declared command takes its run lock, including in a mixed group. If any command is not reusable, commands execute in order in one checkout; reusable commands run only as setup and add no evidence. Setup failures are notes and later commands still run. After the commands, also when one fails, `mp` runs the project's `cleanupCommands` in the checkout root, then removes the checkout. A rerun (`mp seat <id> rerun`) keeps the last 400 lines (at most 64 KiB) of its output, passing or failing, in its summary leaf, and prints them. `mp seat <id> rerun <command> --detach` runs it in a worker process of its own (its own session and process group), records it as running against the dispatch and returns the run id at once; the worker runs and records it exactly as a foreground rerun. `mp seat <id> wait <run> [--seconds <n>]` waits up to 50 minutes a call and prints the result and its tail, or says the run is still running. A detached run ends finished, stopped (`mp pm stop` sends SIGTERM to its worker's process group, which ends its command's group, cleans up and records no result) or lost (its worker is gone: on Linux the pid and its start time are checked, elsewhere the pid alone; a worker on another host is never judged). `mp sec next` lists runs that ended while their dispatch is in flight, and a step dispatched again gets a card section "Runs already made for this step". A full run (`mp seat <id> full-run`, `mp pm full-run`) executes every `fullSuite` command in order in one such checkout of one commit and records a full-run marker: the commit and tree, the environment, each command's exit, the result, the last 400 lines of each failing command, and who decided it. A passing full run on the same tree, environment and suite is reused, never executed again; a failed one executes again. `mp pm deliver` runs no command: it shows the full-run status of its tree. A seat's `mp seat <id> checkout` is a plain copy of the files for reading, shared by the seats reading that commit and made read-only.

## The memory folder: skeleton and leaves

```
.mission-pipeline/
  memory.db                  the skeleton (SQLite, journal mode DELETE)
  config.json                what the project declares
  words/<date>.md            your words, one anchored entry per message (W-<n>)
  missions/<m>/              requirements.md, decisions.md, notices.md, plans/, dispatches/<d>/card.md and report.md,
                             runs/, explorations/, deliveries/
  roles/  pm/  secretary/    role descriptions, both handbooks and the Secretary's WI pages
  worktrees/<dispatch>/      a Constructor's git worktree, removed after its hand-back or release
  tmp/<dispatch>/            a dispatch's hand-back files, removed once the hand-back is recorded or the dispatch released
  tmp/<run>/                 a run's clean checkout, removed after the run
  tmp/checkouts/<commit>/    the read-only checkout of a commit that reading seats share, removed when no dispatch in flight holds it
  tmp/.trash-*               removals in progress
  locks/                     process locks; locks/owners/ holds one owner lock per scratch directory under tmp/
```

Every scratch directory under `tmp/` has an owner: the `mp` process that made it holds its lock under `locks/owners/` for the directory's whole life, and the operating system releases the lock when that process exits. A removal renames the directory into `tmp/.trash-*` first, so nobody sees half a tree. `mp sec next` sweeps, for at most 1.5 seconds, what no live process owns: scratch of killed processes, the folders of dispatches no longer in flight, shared checkouts no dispatch in flight holds, scratch from before 4.1.2 once it is a day old, and the trash. It never touches an entry it does not know. `mp pm clean [--mission <m>]` does the same without a time limit, also removes the worktrees of dispatches that are over, and reports the bytes freed and what it kept. Never delete under `.mission-pipeline/` by hand.

Leaves are plain Markdown that anyone can read without `mp`. The skeleton names each leaf by file, anchor and the hash of its text, so a missing or hand-edited leaf is noticed and shown (WI-30), never silently served. Products are commits in your repository, on refs under `refs/mission-pipeline/`.

**Moving to another machine.** Quiesce the resident and detached workers too. Copy the project folder (with `.mission-pipeline/` in it) while no `mp` command runs and no seat is working, and open it with any harness on Linux, Windows or macOS. The first operational `mp` command in the copy notices the move and, under a lock, repairs the worktrees and verifies both link directions, the common directory and their registration at the copied paths (only when the common git directory is inside the folder; failed verification holds git writes and leaves the move pending under WI-31), verifies the event log's hash chain, rebuilds the state from the log, and checks every leaf and every commit the memory names; it reports what it found before its own answer. A broken event chain stops all writes (WI-29: copy again, or `mp pm continue-from <event>`). A copy that shares its repository with another copy holds git writes until `mp pm confirm-copy` (WI-31). Runs made under another environment identity still count, and reads mark them "older environment"; `mp sec next` tells the Secretary once. When the change matters, `mp sec renew` reruns them under the new identity and renews the evidence without a seat when the outputs are equal.

## Reading

The read-depth rule decides how much you get back:

- `mp read status` ("how is it going?"): layer 0 (stops, missions, dispatches in flight with their age, what waits on you, notices, labels, the environment, and the count of persistently blocked subtasks); plus, only when some subtask's state changed since you last asked, the layer-1 entries of exactly those subtasks (a requirement item, a plan task or an exploration: its state, the time of its last change, and why it is blocked and what comes next). A failure, a refutation, a cancellation or an exploration's conclusion is a change too. Nothing changed: layer 0 only.
- `mp read blocked` ("why is it not done?"): every blocked subtask once, with all its reasons and the next step. Blocked means held for a reason outside its own work: an open escalation about it that the flow still handles (a used-up loop, WI-08, until the Secretary's decision is carried out; an exploration awaiting a ruling; a decision waiting on you; an escalation about a task a re-plan dropped, or about a superseded PM plan, is history, not a block), a stop (also one over a seat still working, or over a hand-back that arrived after it), a closed mission, the git-writes hold, a lease, an exploration's first step waiting for the explorations planned before it, or a dispatch in flight for over an hour without a hand-back. A task that passes on its last allowed attempt is not blocked. The labels recomputing is one project line, not a blocked subtask. The count in `mp read status` comes from the same computation.
- `mp read show <kind> <id>`: one item (mission, task, dispatch, plan, object, judgment, run, evidence, delivery, exploration, …) with its state, checks, links and leaf paths. `mp read show plan` says when a plan took effect without its reviews, and on whose words. `mp read show evidence|dispatch <id> --check-data` hashes the data outside the commit it cites again (`unchanged`, `changed` or `missing`) and writes nothing. `mp read show exploration <id>`: the findings round by round with the author's dispositions and the Stabilizer's verdicts, which findings the Stabilizer resolved as answered rather than the attacker by a re-check, and, once its snapshot was taken again, the commit it reads and the evidence from an older one.
- `mp read leaf <id>`: a leaf's text, hash-checked.
- The tree reads, on the skeleton's links:
  - `mp read why <id>` walks back from any node (a commit or branch, a run, a judgment, a task, a dispatch, a decision, a delivery) to your words, showing for each step who handed it over, its state, the program's checks and its leaf. `mp read why main` after a landing goes from the delivered commit through the delivery, the product, the Constructor's dispatch, the task, the detailed plan, the Architect's dispatch, the PM plan and the requirement items to the words entries.
  - `mp read from <id>`: everything that rests on a node (what a withdrawn requirement or a refuted version affects).
  - `mp read chain <dispatch>`: one dispatch: its card, the step that handed it over, its report, its checks, and what it led to.
  - `mp read tree <mission>`: the whole mission as one indented tree, words → requirements → plans → tasks → dispatches → candidates → judgments → deliveries, one line per node with its state and check result.
- `mp read full-runs <mission>`: the mission's full-run markers, newest first: when each full suite ran, on which commit and tree, under which environment, its result, and who decided it.

Every command prints text; `--json` gives the same answer for programs.

## Harness notes

Any harness needs shell commands, a resident conversation, sub-agents and a way to stop them.
The engine starts no sessions; the harness owns launch, messaging, permissions and process lifetime.

**Claude Code 2.1.319 — to verify on your version.**
`MP_SECRETARY=S-<n> claude --bg -n "<project>-Secretary" "<prompt printed by mp>"` starts the resident and must pass its environment to every `mp` command.
Bind the returned id with `mp pm secretary handle <S-n> <id>`.
`claude attach` and `claude --resume` should reach the named session; verify their selection syntax on your version.
Verify that the two sessions can message each other to wake the recorded inbox or note.
`claude stop <id>` should end the resident and its sub-agents; verify that before relying on the stop fallback.
If sub-agents survive the parent in your harness, record and use that harness's individual seat stop command before confirming dispatches ended.
Seats may hand back with `mp seat <id> handback --stdin` when they cannot write report files.

**Codex and other harnesses — check your version and permissions.**
A Secretary or Constructor needs the git writes its commands perform; a workspace sandbox may hold `.git` read-only.
A seat can record a hand-back even when its sandbox blocks follow-up writes; the Secretary's next pass carries them out (older notes say "left to the PM").
Reruns use a checkout with its own repository; a Docker build may also need network access and writable Buildx state.
Use the harness's supported resident and sub-agent features and check that its stop command ends the seats too.

## Platforms

Linux, Windows and macOS with Node 22.12+ (the built-in `node:sqlite`) and git. Paths in the memory are relative to the project folder, so a copy reads the same on any of them. Declared commands run with the platform's shell, or the one config `shell` names. Process locks (a landing, the recovery after a move, a declared run while it executes) are SQLite file locks the operating system releases when the holder exits.

## Layout

| Directory | Owns | Design |
|---|---|---|
| `src/memory/` | the skeleton: `memory.db`, the hash-chained event log, projections, leaves, the recovery after a move, process locks | §3, §4.1 |
| `src/evaluator/` | the stored proof labels and their bounded propagation, run classes, the environment identity, renewal | §4.1, §6.5 |
| `src/process/` | the Secretary's dispatch loop and the seats' commands over the flows | §5, §6 |
| `src/flow/` | the decision layer, execution, exploration with the Stabilizer, legalization | §6.1–§6.4, §6.8 |
| `src/seat/cards/` | every card kind: its fields, rendering and hand-back checks | §5.2, §5.3 |
| `src/git/`, `src/delivery/` | worktrees and candidate collection, delivery and landing with plain git | §5.3, §6.7 |
| `src/cli/` | `mp`: the command groups, `mp init`, the layered and tree reads | §4.1, §8, §9 |
| `plugin/` | role descriptions, both handbooks and WI pages (copied by `mp init`); the optional Claude Code adapter | §1, §6.9 |
| `bin/mp.mjs` | the launcher | §9 |
| `test/` | `node:test` suites; `cli-*` drive `mp` itself, some from a shell | §11 |

## Development conventions

- Node 22.12 or later; code runs with `--experimental-strip-types`, so only erasable TypeScript syntax: no `enum`, no `namespace`, no parameter properties. Imports use the `.ts` extension.
- `npm run typecheck` (tsc, strict) and `npm test` (node:test) must both pass; `npm run test:cli` runs the command-line suites. `test/cli-mission.test.ts` runs a whole mission through the shell-invoked `mp` (set `MP_TEST_INPROCESS=1` to run it in-process).
- Run tests with a short `TMPDIR` on a local filesystem (for example `TMPDIR=$(mktemp -d /tmp/mpc.XXXX)`).
- No test may touch the repository's `data/` directory.
- Product documents (both handbooks, WI pages, role descriptions, README, CLI text) are in English.

## Known limitations of 4.3

- **A copy taken while `mp` writes is not supported.** The checks after a move catch a broken event chain, missing or edited leaves and missing commits, but a copy that is internally consistent and simply older than its source cannot be told from a deliberate older copy.
- Work moves while the Secretary session runs. Questions for the PM wait while no PM session is open; other work continues. Word recording still depends on the PM's discipline; the optional hook only reminds it.
- A seat that ignores its role is caught only at hand-back; what it did meanwhile is its harness's business. `mp` never decides that a seat died: the Secretary releases it after checking the harness.
- The environment identity covers only the operating system, the architecture, the version commands the project declares and, when set, config `shell`.
- Leaves are plain files: an edit is detected by its hash and shown, not prevented. Full run output and seat conversations are not kept.
- With pathological inputs one label propagation step can take a few seconds; a stop then waits for that one step.
- Tested on Linux (WSL2). Windows and macOS use the same code (Node, git, SQLite file locks) but have not been through the scenario suites yet.
- 4.3 does not read 4.0.x ledgers; a field PM migrates missions by the new rules.
