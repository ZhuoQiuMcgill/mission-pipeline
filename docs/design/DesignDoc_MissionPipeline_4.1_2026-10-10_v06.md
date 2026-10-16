# Mission Pipeline 4.1 design: a neutral project memory, roles and process (v06)

Status: v06, the implementation contract (v05 plus Appendix E, the batch-bound amendment from the code review; plus Appendix F, the run lock, Appendix G, the run checkout's repository, Appendix H, the change a reworked product brings, Appendix L, products stacked on each other, and Appendix M, a later attempt on its dependencies' current work, after 4.1.0): after the 3 attack rounds and their Stabilizers (Appendices A–C), the maintainer’s ruling on what the memory holds (U-13, U-14), and a Stabilizer check of v04 (Appendix D).
Replaces the runtime of the 4.0.x design (`DesignDoc_SeatsLedgerRuntime_4.0_2026-10-08_v51.md`, "v51"). The process and the memory model of v51 carry over where this document says so.

## 0. Calibration: where each element comes from

Every element below is tagged:

- **[U-n]**: the maintainer said it; the quote is in the table.
- **[v51-U]**: a maintainer ruling recorded in v51 (marked 维护者 there), carried over.
- **[v51]**: a v51 detail that was not a maintainer ruling (mine, or adopted from an attack round), carried over. The Stabilizer should scrutinize these.
- **[mine]**: new in this document, my addition. Additions that change what the maintainer gets, cost or risk are listed in §13 as questions.

| Id | Date | The maintainer's words |
|---|---|---|
| U-1 | 2026-10-10 | "我从一开始想要的是一套工作流程，每个席位就像是员工一样，随时可以替换。所有的实现不强依赖于某个模型或者harness。" |
| U-2 | 2026-10-10 | "所有的记忆都应该是中立的，不是说我一定要拿Claude code打开才有之前的记忆。任何时候，我换个电脑，把文件夹复制过去，里面只要带了mission pipeline的记录，我就能用任何模型任何harness 来恢复之前的进度和记忆" |
| U-3 | 2026-10-10 | "那cli不就是为了给所有能调用tool的harness 一个查看历史，记录历史的方式吗？sqlite就是为了记忆，追踪和断点恢复用的，那windows和mac就用不了sqlite 吗？没有任何登陆不登陆的关系，本身这就是一套客观的项目记忆+不同席位的职责描述+一套流程，安全问题就不是你应该管的，是各个harness自己的事情。" |
| U-4 | 2026-10-10 | Asked who starts the seats, chose: "PM 用自己的 harness 派人" (the PM dispatches through its own harness's sub-agent feature). |
| U-5 | 2026-10-10 | "确保4.0版本的引擎支持全Claude家族的模型，并不是每一个人都同时有codex和claude" |
| U-6 | 2026-10-10 | "把stabilizer 加回exploration 的攻防loop里，并且拥有上报secretary 的权限" |
| U-7 | 2026-10-10 | On attacking designs: "每一轮attack都得有一个stabilizer 看着attack的内容是否shift了。找茬是永远都找不完的。现在attack3轮，3轮之后如果stabilizer 认为存在的理由没有偏差且不收敛，你就停下来报给我。" |
| U-8 | 2026-10-09 | "太过edge的东西给出触发情形和行动选项即可，可以做成work instruction的形式，PM只读一个目录，出事才去找详细的应对措施" |
| U-9 | 2026-10-08 | The program is a CLI that offers each seat its own command set; the description of a seat's commands is part of the seat's birth package (v51 §2: "维护者要求程序以 CLI 形态为每个席位提供各自的接口"). |
| U-10 | 2026-10-08 | "细枝末节不要汇报，只有最重要的design decision才需要汇报" |
| U-11 | 2026-10-09 | "mission pipeline里的所有文档使用英语撰写" |
| U-12 | 2026-10-10 | "版本号就用4.x，因为现在的4.0就不是我想要的东西，不要为他单独留一个版本号" (this design ships as 4.1.0) |
| U-13 | 2026-10-10 | "不用装下全部记忆。而是装下大部分的design decision，每个席位做了什么？有没有按程序检查？简单来说，太过细节的东西，装下来的应该是一个指针，指向"这块地方曾经干过啥"而不是把全部的细节装进去。" Then: "我说的指针只是一个形容词，不是内存意义上的指针。其次，数据库要记录的是一条完整的运行链，你可以先思考一下，在这个pipeline下，什么东西是.md不方便记录的？那这部分就是应该让数据库记录的，例如每个seat在运行的时候是哪个seat交给他任务？" |
| U-14 | 2026-10-10 | "对，数据库是骨架，.md是叶子，数据库设计出来就是让整棵树能连起来看" |

## 1. What Mission Pipeline is

Three parts, and nothing else **[U-3]**:

1. **An objective project memory**, in the project folder, made of a skeleton and leaves **[U-14]**:
   - **the leaves** are Markdown files: what people and agents read (the maintainer's words, decisions and their reasons, plans, each seat's report, reviews, exploration products, run summaries);
   - **the skeleton** is a SQLite database: what Markdown records badly (the complete run chain, who handed whom which task, states, links between versions, program check results, counts, order), each entry naming the leaf it belongs to.
   It holds the design decisions, what each seat did, and whether each step passed the program's checks; for details it holds a note of what was done there and where the detail lives, not the detail itself **[U-13]** (§3.2).
2. **Role descriptions.** For each seat: what it does, what it receives, what it hands back, which `mp` commands it uses, its direct upstream and downstream. One page each **[v51-U]**.
3. **A process.** Who comes after whom, what counts as accepted, what is escalated and to whom, how explorations are attacked and stabilized. `mp` advances and checks it.

## 2. Principles

1. **A seat is a role; whoever fills it is replaceable at any time** **[U-1]**. Any model, any harness. Replacing the filler changes neither the process nor past conclusions; the filler is recorded as information, never as a condition of a conclusion **[v51-U]** (v51 §9.4: "a model change never invalidates past conclusions").
2. **Nothing depends on one model or harness** **[U-1]**. The only interfaces are the `mp` command line and text files (role descriptions, cards, handbook). Any harness that can run a shell command can be the PM or fill a seat **[U-3]**.
3. **Memory travels with the project folder** **[U-2]**. Copy the folder to another machine (Linux, Windows or macOS **[U-3]**), open it with any harness, and continue.
4. **Security and logins are each harness's business** **[U-3]**. Mission Pipeline does no sandboxing, no credential handling, no isolation checks, no metering.
5. **The PM dispatches** **[U-4]**. Seats are started by the PM through its own harness. `mp` starts no seats and runs no background service; the only processes it runs are git and the commands the project declares (verification, closing, and the version commands of the environment identity), inside the `mp` command that needs them.
6. Carried from v51 unchanged: only one PM, the session on the maintainer's screen **[v51-U]**; only the most important design decisions reach the maintainer **[U-10]**; the memory records everything, reads are on demand **[v51-U]**; each seat knows only its direct upstream and downstream **[v51-U]**; predictions never steer an exploration **[v51-U]**; a task whose acceptance cannot be written in advance is accepted by surviving attack **[v51-U]**; edge cases are work instructions **[U-8]**.

## 3. The project folder

### 3.1 Layout [mine]

`<project>/.mission-pipeline/`:

| Path | What | Notes |
|---|---|---|
| `memory.db` | **The skeleton** (§3.2): SQLite | One file. Journal mode `DELETE`, not WAL: a committed database is one complete file, and the rollback journal works on every local filesystem including WSL's `/mnt` and macOS/Windows |
| `words/<date>.md` | **Leaves, journal**: the maintainer's words, one anchored entry per message (`W-<n>`) | Appended, never rewritten |
| `constraints.md` | **Leaves, journal**: the project's long-term constraints, one anchored entry per version | Appended, never rewritten |
| `missions/<mission>/requirements.md`, `decisions.md`, `notices.md` | **Leaves, journals**: requirement item versions with their quotes; decisions with their reasons (the maintainer's, the Secretary's, the PM's within its authority); notices to the PM | Appended, never rewritten |
| `missions/<mission>/plans/…`, `dispatches/<dispatch>/card.md`, `dispatches/<dispatch>/report.md`, `runs/<run>.md`, `explorations/<x>/v<k>.md`, `deliveries/<d>.md`, `closings/<c>.md` | **Leaves, documents**: each plan version; each card as the seat received it; each seat's report (Constructor, Reviewer, Calibrator, Architect, Secretary, Researcher, Crititor, Stabilizer, Auditor all hand back a report); each run summary; each exploration product version; each delivery and closing | Written once by `mp`; a change is a new version, a new file |
| `roles/<seat>.md`, `pm/PM.md`, `pm/wi/…` | Role descriptions, PM handbook, work instructions **[U-8]** | Copied in by `mp init` from the installed `mp` version; the version is recorded; `mp docs update` refreshes them |
| `config.json` | Target branch, verification and closing commands, the version commands of the environment identity (§6.5), exclusive resources, filler hints per seat | Hand-editable; `mp config` validates |
| `worktrees/<dispatch>/` | One git worktree per Constructor dispatch (a released dispatch's late writes never reach the next filler's worktree) **[r1 F5]** | Working area, not memory |
| `tmp/` | Clean checkouts for verification runs (§5.3), removed after each run **[r1 F2]** | Working area, not memory |
| `locks/` | Process locks (§4.1) | Working area |

- **Leaves are plain Markdown** that any harness or person can read without `mp`. Every leaf entry the skeleton refers to is named by file, anchor and the hash of its text, so the skeleton notices when a leaf is missing or was edited by hand (§3.3).
- **Git**: products are commits in the project's own repository, on refs under `refs/mission-pipeline/` **[v51]**. The memory names them by commit; the code itself stays in git.
- **Not committed by default**: `mp init` adds `.mission-pipeline/` to `.git/info/exclude` **[maintainer's answer to Q2, §13]**.

### 3.2 What the skeleton records, and what the leaves hold [U-13, U-14; mine for the list]

The rule: whatever Markdown records badly goes to the skeleton; whatever a person or an agent reads goes to a leaf. The skeleton exists so the whole tree can be seen connected **[U-14]**.

The skeleton records:

1. **The run chain**: for every task and dispatch, which step and which seat handed it over, on the basis of which version. For example: the maintainer's words W-12 → requirement R-3 v2 → PM plan v2 (Calibrator ① passed it, dispatch D-9) → detail plan v3 (Architect, dispatch D-12) → task T5 → Constructor dispatch D-20 → candidate C-7 → Reviewer dispatch D-23 → accepted → delivery V-1. Each arrow is a recorded link, so any node can be walked back to the maintainer's words and forward to everything that rests on it.
2. **States and their history**: each requirement item, plan, task, dispatch, candidate, exploration and delivery has one current state (queued, dispatched, handed back, accepted, refuted, awaiting the maintainer, stopped, …) and an ordered history of its changes; parallel seats never leave it ambiguous.
3. **Links between versions**: which interface and product versions a product depends on (required or reference, **[v51-U]** 2026-10-08), which version a judgment judged, which version replaced which, which judgment answered which issue; so that withdrawing a requirement or refuting a version finds everything affected.
4. **Program check results**: for every step, which checks `mp` ran (hand-back format, write paths, every standard answered, the verification run's exit codes and per-test results, the mechanical plan checks of v51 §3.5) and whether each passed, with the reason when not.
5. **Counts**: rework and retry counts per lineage, exploration rounds, extensions granted.
6. **No double work**: a step is claimed once, a hand-back recorded once, every write has an operation id (§4.1).
7. **Order and cursors**: the order of all events (an append-only, hash-chained event log), "since the maintainer last asked" for the layered reads (§8), notices delivered and acknowledged.
8. **Stops in force** and their scopes, checked by every dispatch, hand-back and landing.
9. **Fillers**: which harness and model filled each dispatch, as information.
10. **Proof labels**, derived from 1–4 and stored (§4.1).
11. **Every value the program reads to decide** **[mine; v04 check B1]**: the lists of the proof model (a judgment's evidence, bases, constraints and relied-on objects; proof-unit members; regression coverage tests and inputs; pending operations), flow-event bodies, structured hand-back results (verdicts, per-standard answers, per-finding severities and dispositions), task specs, operation receipts (what makes a retry return the same answer), notice bodies, exclusive-resource leases and landing intents. These are data `mp` computes on, so they live in the skeleton; none of them is ever read back from a Markdown file. In 4.0 they were content-store entries (§14).
12. **References to leaves**: every entry above names its leaf, if it has one (file, anchor, hash).
13. **Who issued each PM command** **[v04 check]**: the PM's filler (harness and model) per `mp pm` command, since the PM's harness can change between sessions.

**Writing a leaf** **[mine; v04 check]**: a leaf is written inside the write transaction that records it, before the commit. A document is written to a temporary name and renamed into place; a journal entry's anchor is derived from the operation id and is not appended again if it is already there. A leaf with no committed entry in the skeleton is ignored (and removed by the next `mp` call). So a retry after a crash neither loses nor doubles a leaf, and parallel `mp` calls append to a journal one at a time, under the write lock.

The leaves hold the content people and agents read, and only that: the maintainer's words; requirement texts with their quotes; decisions and their reasons; plans; cards; each seat's report (what it did, what it did not meet, issues noticed, questions); review findings; exploration products; run summaries; delivery and closing reports.

**Details are noted, not kept** **[U-13]**: a leaf says what was done and where the detail is, not the detail itself:
- code: the commit, in git;
- a verification run: the run summary (commands, environment identity, exit codes, per-test results, the output's hash, the last lines of a failing command); the full output is not kept;
- a seat's conversation: not kept; it belongs to the harness;
- a card: kept as the seat received it, because what a seat was told is a design-relevant fact.

### 3.3 Copying and moving [mine; r1 F1, r2 F3, r3 F3]

- **Copying**: copy the folder while no `mp` command runs and no seat is working (the PM handbook and a WI say so). A plain copy is the whole procedure; there is no export step **[U-2]**. A copy taken while `mp` writes is not supported; the checks below catch what they can, and do not promise to catch everything.
- **After a move**: on every open `mp` compares the recorded project path (and a machine identity) with the current ones, and looks for an unfinished move. When either changed, or a move is unfinished, it first takes the folder's **maintenance lock** (§4.1) and then, before any other command:
  1. records "move pending" (old and new path and machine) unless already recorded;
  2. runs `git worktree repair` for its worktrees, **only when the git common directory lies inside the folder**. When it lies outside (a linked worktree, a shared repository), the copy shares that repository with the original: `mp` skips this step, rewrites nothing in the repository, and holds every command that writes to git (dispatching a Constructor, a hand-back that commits, a delivery, a landing) until the PM confirms, under the WI, that this copy is the one in use **[v04 check B2]**;
  3. verifies the event log's hash chain (an integrity check only: no keys, no signatures);
  4. rebuilds the current-state and label tables from the event log (the 4.0 `rebuild`), so state pages copied at a different moment than the log never survive the move;
  5. checks every leaf reference (file present, hash equal) and every commit the memory names, with all the objects it needs (`git rev-list --objects --missing=print`, so a partial clone does not pass and fail later);
  6. records "move done", with what step 5 found, in the same transaction that installs the rebuilt tables.
  A crash at any step leaves "move pending", so the next call starts again from step 2; a second process that opens meanwhile waits on the maintenance lock, or returns "busy: moving" after the busy limit.
- **What stops and what only warns**:
  - a broken event chain stops all writes: the skeleton itself is in doubt. `mp read status` names the last valid event; the PM follows the WI (copy again from the source, or continue from the last valid event);
  - a missing or hand-edited leaf, or a commit not present in the repository, does not stop the memory **[U-13]**: the node is shown with "leaf missing", "leaf edited after it was recorded" or "commit not reachable here", and only the steps that need that content (delivering that commit, continuing a task on it, a card that must quote that leaf) are held, under a WI.
- **Repositories whose objects live outside the folder** **[r3 F3]**: at `mp init`, and after a move, `mp` checks whether the git directory or its common directory lies outside the folder, or the repository uses alternates or is a partial clone. If so it warns, under a WI, that a copy of the folder carries the memory but not necessarily the code, and that two copies on one machine share one repository (use only one of them, or make a standalone clone). It does not refuse and never rewrites the repository.
- **No machine state**: nothing outside the folder is needed except the `mp` tool itself (installed per machine like git, §9) and the harness.

## 4. Interfaces

### 4.1 `mp`, the only way to read and write the memory [U-3, U-9]

- Every command prints text for people and `--json` for programs **[mine]**.
- Command groups by role **[U-9]**: `mp pm …` (PM), `mp seat <dispatch> …` (a dispatched seat), `mp read …` (anyone; layered reads, §8.4). The role description of a seat lists exactly its commands; that list is part of its card.
- Writes are short SQLite transactions; concurrent `mp` processes (several seats in parallel) serialize on SQLite's lock with a busy timeout **[mine]**. No service, no socket, no daemon.
- **Labels are stored** **[mine; r1 F10]**: there is no long-lived process, so the derived state (proof labels, the affected-set marks of v51 §5.4) lives in derived tables, stamped with the log revision they reflect. This replaces v51 §10.1 rule 4 (labels only in an evaluator's memory). The base records stay the source of truth; `mp recompute` rebuilds the derived tables from them.
- **Propagation** **[v51, adapted; r2 F5; amended in v06, Appendix E]**: work is counted in edges scanned plus variables recomputed. Propagation is split into steps, and a step is one record's work (one object against the active constraint patterns, one proof unit's projection, one judgment's rule, one page of edges), never a page of records. A write whose propagation fits in about 20,000 units finishes it in its own transaction (v51 §5.4 algorithm). A larger one stores its frontier (the variables still to visit) and returns; later calls do one batch each from the stored frontier. **Targets, not hard limits:** a batch aims at about 20,000 units and 2 seconds and stops before a step that would go over; but **every batch commits at least one step**, and a single step larger than the target runs alone and commits (it is never rolled back for its size), so propagation always makes progress. Such oversized lone steps run only in the PM's batches (`mp pm next`, `mp pm drain`); the batches that ride on seat writes stop before any step that does not fit. A new event that arrives meanwhile adds its own changed variables to the same frontier. **While any frontier is non-empty, every decision that needs "proven"** (a stable-mode dispatch, an acceptance, a closing, a delivery, a legalization) **treats the whole project as "recomputing"** and waits, reporting how much is left; reads for display show the last labels marked "recomputing". So no variable downstream of an unfinished propagation can be used as proven, without first finding the whole affected set. Nothing waits for a background process. No admission limit exists only to keep batches small; limits guard against malformed input only (record sizes, path depth).
- **Draining** **[r3 F4]**: the frontier drains once large changes stop arriving; it is not guaranteed to drain while they keep coming faster than the batches. When a frontier has stayed non-empty for 10 minutes, `mp pm next` raises a notice (WI): the PM stops dispatching new work and runs `mp pm drain`, which works through batches until the frontier is empty. Stops are never held back by a frontier.
- **Busy and time limits** **[mine; r1 F10; amended in v06]**: a write transaction aims to hold the lock for at most 2 seconds of work (a base write that exceeds it is rolled back; an oversized lone propagation step in the PM's batch is the one exception, above); a caller that cannot get the lock within 30 seconds gets exit code "busy, retry" with nothing written; every write is idempotent by its operation id, so a retry never doubles it. Stops are written before any queued propagation batch.
- **Process locks** **[mine; r2 F1, F3; amended after 4.1.0, Appendix F]**: three operations need a lock that outlives a transaction: a landing (§6.7), the recovery after a move (§3.3), and the execution of a declared run (§5.3, §6.5), which is recorded only once its commands have run. Each is an operating-system file lock on its own file under `.mission-pipeline/locks/` (an SQLite database used only to hold an exclusive lock, which works the same on Linux, Windows and macOS). The kernel releases it when the holding process exits, however it exits, so `mp` never watches a process to know whether the holder is alive **[U-4]**. A declared run has one lock per reuse key (candidate, command, working directory, environment identity), under `locks/runs/`, taken without waiting: the holder checks reuse again inside the lock, executes, records and releases; another process that needs the same run meanwhile runs and records nothing, and its flow step waits for a later pass, which reuses the recorded run.

### 4.2 Entry for any harness [mine]

- The PM's entry is `.mission-pipeline/pm/PM.md`. To make a harness pick it up, `mp init` can add one pointer line to the harness's instruction file (`CLAUDE.md`, `AGENTS.md`, …): "If you are acting as the Mission Pipeline PM, read `.mission-pipeline/pm/PM.md`." The line carries no pipeline rules, because seats may load the same file **[v51-U]** (2026-10-08: the project's instruction file must carry no pipeline rules).
- A seat's entry is its card (§5.2): self-contained, so a seat needs nothing else from the folder.

## 5. Dispatch: the PM starts the seats [U-4]

### 5.1 The loop [mine]

1. `mp pm next` lists the ready steps: seat, task, mission, a one-line purpose, and whether the step can run in parallel with the others. It also lists what waits on the maintainer and dispatches still in flight.
2. `mp pm dispatch <step>` claims the step and returns a **dispatch id** and the card. A step is claimed once; a second claim is refused.
3. The PM starts a sub-agent in its own harness with a fixed prompt: "You are the <seat> of Mission Pipeline. Your card: `mp seat <id> card`. Use only the `mp seat <id>` commands listed there. Finish with `mp seat <id> handback`."
4. The seat works and hands back. `mp` checks the hand-back against the role's format (§5.3), records it, recomputes labels, and advances the process. The next `mp pm next` shows what became ready.
5. The PM repeats while the maintainer's session is open. The process advances only while some PM session is open **[U-4, accepted cost]**.

### 5.2 The card [v51, adapted]

The card is the seat's birth package **[U-9]**: the one-page role description, the task's fixed fields (v51 §4.2 for Constructor, §3 for the decision seats, §8 for acceptance seats), the material list (read page by page with `mp seat <id> read <material>`; materials are leaves, §3.2, and every read checks the leaf's hash, reporting a missing or edited leaf instead of serving it silently), the seat's commands, and the hand-back format. Required inputs are marked as in v51. `mp pm dispatch` writes the card as the leaf `dispatches/<dispatch>/card.md` and records in the skeleton which step handed the task over, on which versions (§3.2 item 1).

### 5.3 Hand-back checks [v51 rules, mine for the mechanics]

- **The form of a hand-back** **[mine; U-14]**: the seat writes its report as a Markdown file in `tmp/<dispatch>/` (named on its card; never inside its worktree, so the report is neither refused as outside the write paths nor committed into the product) and runs `mp seat <id> handback --report <file>` with the structured fields its role requires (verdict, per-standard answers, per-finding severities, …). `mp` checks them, files the report as the leaf `dispatches/<dispatch>/report.md`, and records the skeleton entries: state change, links, check results.
- One hand-back per dispatch; a repeat with the same content is a no-op, a different one is refused **[mine]**.
- The hand-back must be of the kinds the role allows; every required field present; every standard and self-reported gap answered (v51 §8.1 **[v51]**).
- **Constructor** (v51 §4.2): it works in `worktrees/<dispatch>/` with its harness's own file and shell tools. At hand-back `mp` collects **every change git does not ignore**: modified, deleted and new (untracked) files, without the seat running `git add` **[mine; r2 F6]**. Inside the card's write paths they form the candidate commit (v51 §7.1 canonical candidate **[v51]**). Any non-ignored change outside the write paths refuses the hand-back, listing the paths. Ignored files are never collected; ignored files inside the write paths are listed in the hand-back's answer so the seat sees what was left out. The card says this, so the seat knows new files are taken as they are.
- **Verification on the candidate, not on the worktree** **[v51, kept; r1 F2; amended after 4.1.0, Appendix G]**: `mp` checks the candidate commit out into a fresh `tmp/<run>/` directory and runs the card's declared verification commands there. Untracked and ignored files of the Constructor's worktree are not in it; files the commands generate stay in the run directory, which is removed afterwards. The checkout is a git repository of its own positioned at the candidate, so a command that asks git a question gets the candidate's answer: its `.git` borrows the project's objects (alternates, and the project's shallow list), holds HEAD detached at the candidate and an index read from its tree and refreshed against the files, and carries the transform description the files were materialized under; nothing is registered or written in the project's repository, no object is fetched, and the `.git` goes with the checkout. The commands get no variable that would point git at another repository. Reruns, renewals and a delivery's closing checks run in such a checkout too; a Reviewer's reading checkout (`mp seat <id> checkout`) stays plain files. The run is recorded in the skeleton (candidate commit, commands, environment identity §6.5, exit codes, per-test results, the output's hash) with a run summary leaf `runs/<run>.md` that adds the last lines of any failing command; the full output is not kept **[U-13]**. That run is the evidence; the seat's own runs are scratch **[v51-U]** (2026-10-08).
- **Reviewer**: judges the same candidate commit (`mp seat <id> checkout` materializes it for reading) and cites the program's runs on it (v51 §8.1).
- The dispatch id ties a hand-back to its task. It is bookkeeping, not an anti-forgery measure **[U-3]**.
- The filler (harness and model) is recorded from the PM's dispatch command (`--filled-by`) or the seat's hand-back, as information only **[mine]**.

### 5.4 Interrupted dispatches [mine]

- A dispatch stays "in flight" until it hands back or the PM releases it. `mp` cannot see harness processes, so it never decides on its own that a seat died, and it watches no process **[U-4]**.
- Releasing has two forms **[mine; r1 F5]**:
  - `mp pm release <id> --ended`: the PM's harness confirmed the seat ended. Its worktree is removed and its exclusive-resource leases are freed.
  - `mp pm release <id> --abandoned`: not confirmed. The step can be dispatched again at once, in a new worktree; the old worktree and the old dispatch's exclusive leases stay held until a later `--ended`, or until the PM decides per the WI.
- A hand-back from a released dispatch is recorded with its content and marked "after release, not accepted" **[mine; r1 F5]**.
- A new PM session (any harness, any machine) sees the dispatches in flight with their age, and decides per WI: wait, or release and dispatch again.
- Continuation is never a harness session: a seat that must continue (v51 §6.2 asynchronous evidence) gets a new card with the previous hand-back, the saved notes it handed back, and the new evidence. Nothing depends on a harness's session id; the card's `resume.sessionId` field is removed (§14).

## 6. The process

### 6.1 Decision layer: v51 §3 unchanged except as listed [v51-U, v51]

PM alignment and requirement items, Calibrator ①, Architect decomposition with the "searched existing interfaces" line, mechanical checks, the feasibility review, Calibrator ②, the Secretary, the plan growing in rounds (v51 §3.1–3.10).

Changes:
- **The maintainer's words** are recorded by the PM with `mp pm say` (verbatim, for every message; appended as an anchored entry to `words/<date>.md`, with the skeleton recording the entry) before anything else, as the handbook's first rule **[mine]**. A requirement item's quote must appear verbatim in the words entry it names; `mp` refuses it otherwise **[v04 check]**. A harness hook that calls `mp pm say` automatically (Claude Code `UserPromptSubmit`, Codex hooks) is an optional convenience in `mp init`, never required **[mine]**. Replaces v51 §3.1's hook-only capture **[v51]**.
- **Notices to the PM** (v51 §3.9): no background watcher. `mp pm next` and `mp read status` show undelivered notices first; the handbook tells the PM to run `mp pm next` after each hand-back and at session start **[mine]**.

### 6.2 Execution layer: v51 §4.2–4.3 unchanged except as listed

- Queueing, priorities, fast/stable mode **[v51-U]**, exclusive resources as leases in the memory **[v51]**.
- Verification runs by `mp` on a clean checkout of the candidate commit (§5.3), on the machine where the PM runs; no sandbox **[U-3]**.
- **A product version's change** **[amended after 4.1.0, Appendix H]**: a rework's Constructor continues in a worktree at the previous attempt's candidate. The product version records its origin, the snapshot its task's first attempt started from, and its change is everything since then, every attempt's: that is what a dependent task's snapshot and a delivery lay over their base, and what the Reviewer's card lists as the changed paths.
- **Products of kept tasks under a new plan** **[U-15; amended after 4.1.0, Appendix J]**: a product accepted under a detailed plan that no longer holds, of a task whose card the plan in effect keeps, is re-bound to the plan in effect once that plan is proven: a new version of the same candidate. In stable mode a Reviewer judges the new version under the plan in effect, using declared runs reused when recorded; fast mode notifies the PM and keeps the product not fully proven (per maintainer ruling 1, 2026-10-13).

### 6.3 Exploration: author, attacker and Stabilizer [U-6, v51-U]

The exploration definition, the author (Researcher), the attacker (Crititor), evidence executions and the research special case stay as in v51 §4.3 and §8.2. Added:

- **Stabilizer, after every attack round** **[U-6]**: a new instance each round. Card: the exploration definition with the maintainer's fuzzy acceptance goal verbatim, the question, the attack scope, the decision it serves; the round's findings and the author's dispositions; the first and the current version of the product.
- It judges every finding **[mine, from U-7]**:
  - **in scope**: a real problem against the definition; the author must answer it;
  - **shifts direction**: the finding, or the fix the author accepted, would change the question, the acceptance goal or the direction, or contradicts the maintainer's words;
  - **out of scope**: a nitpick outside the attack scope.
- Only in-scope findings bind the author. A direction-shifting finding is not fixed; it goes to the Secretary **[U-6]**, which applies v51 §3.2 (usually: ask the maintainer).
- It also judges the round: on track, or drifting (the product moved away from the definition across rounds). Drifting goes to the Secretary **[U-6]**.
- **Round budget** default 3 attack rounds per exploration, settable in its definition **[mine, after U-6]**. After the last round: converged → acceptance as in v51 §8.2; not converged and the Stabilizer judges the remaining in-scope findings undeviated → to the Secretary with the findings, the dispositions and the Stabilizer's judgments **[U-6]**. The Secretary's options are those of WI-08 unchanged: one extension within its authority, after which it must ask the maintainer **[v51]**.
- Convergence as v51 §8.2 (no unresolved fatal or serious **in-scope** finding on the same frozen version, including a fresh final attacker **[v51]**), and no direction question pending at the Secretary.

**The Stabilizer's place in the memory** **[mine; r1 F6]**. Each round of an exploration goes through these recorded states, in this order:

| State | Recorded by | Leaves to |
|---|---|---|
| attacked | the Crititor's hand-back: findings with severities | dispositioned |
| dispositioned | the author's hand-back: a disposition per finding | stabilized |
| stabilized | the Stabilizer's hand-back: a verdict per finding (in scope / shifts direction / out of scope), its severity, the round verdict | next round; or awaiting ruling |
| awaiting ruling | a direction question sent to the Secretary | the Secretary's decision (and, through it, the maintainer's) |

The exploration product version's required review becomes the pair "crititor + stabilizer" (one review position, v51 §5.2). Its state:
- **refuted** while any finding the Stabilizer judged in scope and fatal or serious is unresolved on that version;
- **pending** until the Stabilizer has judged the round, and while a direction question is awaiting ruling;
- **passed** when neither holds.
A finding the Stabilizer judged out of scope or shifting direction never refutes the version; a direction finding blocks acceptance only through "awaiting ruling". A revocation still follows v51 §5.2: only a new judgment of the same position (a later round on the same version) or a Secretary ruling changes it. The 4.0 exploration state machine gains these states (§14).

### 6.4 Acceptance: v51 §8.1 unchanged [v51]

The Reviewer accepts execution tasks. The Stabilizer is for exploration loops only **[U-6]**.

### 6.5 The memory model: v51 §5 and §10.1, with stored labels and an environment identity [v51-U, v51]

Node roles, the computation of proof labels, the display labels (refuted, basis withdrawn, not accepted, not fully proven, proven) **[v51-U]**, proof units, issue records, the narrow bindings of v51 §10.1. In the terms of §3.2, v51's nodes and edges are the skeleton's entries and links, and their content is in leaves. Changes from v51 §10.1:
- rule 2 ("small records; large content in a content-addressed store and git, the ledger stores hashes") becomes: data the program computes on in the skeleton (§3.2 item 11), documents for reading in leaves, code in git; the 4.0 content store is gone **[U-13, U-14]**;
- rule 4 (labels only in an evaluator's memory) becomes: labels stored in the skeleton (§4.1).

**Environment identity, instead of environment copies** **[v51, adapted; r1 F8]**. v51 §5.2 makes a run's evidence applicable only while "the environment it is bound to is still current"; v51 bound it to a frozen copy, which is gone (§7). Now:
- Every run records an **environment identity**: operating system and version, architecture, and the output of the version commands the project declares in `config.json` (for example `node --version`, `python3 --version`, the test runner's version). The identity is the hash of these, the parts are kept for reading.
- `mp` observes the **current identity** once per process, before any decision that reads labels (a stable-mode dispatch, an acceptance, a closing, a delivery) and on every open after a move (§3.3). A change is recorded as an event.
- A run whose identity differs from the current one is "needs rerun": labels that rest on it drop to not fully proven; nothing in the history changes (v51 §7.2 wording).
- What the declared commands do not capture (a library the project does not declare) is not detected; declaring it is the project's choice. No environment is copied or frozen **[U-3]**, and a change of model or harness never invalidates anything (§2.1).

**Run classes in 4.1** **[mine; r2 F2, r3 F2, F5]**. v51 §7.3 had three classes: closed (sandboxed, frozen environment, no network), open, and sampling. 4.1 has no sandbox and no frozen environment **[U-3]**, so it defines three classes of its own, which replace v51's everywhere the engine uses run classes (reuse, renewal, the mechanical regression check of v51 §5.6, record validation; §14):
- **Declared run**: run by `mp` on a clean checkout of the candidate commit (§5.3), with the commands declared on the card, its environment identity recorded, no network access declared by the card, and not marked sampled on the card.
- **Sampling run**: a run whose result is one observation among possible others: a run the card marks as sampled (a benchmark, a flaky-test probe, a statistical measurement, any command whose judgment will use a timing, statistical or external field), an experiment of an exploration (v51 §4.3), and every run started by `mp seat <id> rerun`.
- **Other run**: anything else (a command that declares network access, a seat's scratch run, a run on a worktree).

The class is fixed when the run is recorded, from the card; it never changes later. Record validation refuses a judgment that cites a timing, statistical or external field of a run that is not a sampling run, so such a judgment can only rest on sampling runs **[v04 check]**.

Rules:
- **Reuse**: only a declared run is reused, for the same candidate content, the same commands and the same environment identity. A sampling run is never reused: each one executes and gets a new run id, so repeated samples stay separate observations (v51 §7.3 "永不复用；每次是独立的观察", kept). A declared run executes under its run lock (§4.1), so a run that is executing is not started again by another process before it is recorded; sampling runs take no lock.
- **Mechanical renewal** (v51 §5.3's conditions with "closed" read as "declared"): after an environment change, the PM runs `mp pm renew` (it also appears as a ready step in `mp pm next`), which reruns the declared commands on the affected candidates. If both runs are declared runs and every field the judgment uses is equal, `mp` records an evidence renewal under the new identity and the label is restored without a seat.
- **Mechanical regression check** (v51 §5.6, with "closed" read as "declared"): a registered regression check is confirmed mechanically when its run is a declared run, every registered test executed and passed, and the test files, runner configuration and shared fixtures are unchanged.
- **Otherwise** the judgment needs a new judgment of the same review position (a Reviewer dispatch). This is the case for performance and statistical judgments, as in v51.

So a move between machines, or between a WSL and a Windows harness on the same folder, costs one rerun of the declared commands per affected candidate, and proof comes back by itself when the outputs match. No environment is copied or frozen to get there.

### 6.6 Stops [v51, adapted, mine]

- `mp pm stop "<the words>"` records a stop with a conservative scope (v51 §6.4 scope rules **[v51]**), linked to the maintainer's words entry (W-n) it came from.
- From that commit on, `mp` refuses, within the scope: new dispatches, hand-backs (recorded as "arrived after the stop, not accepted"), new delivery and landing authorizations **[mine]**. A landing whose git step had already started is checked (§6.7) and reported as "started before the stop" with what actually happened **[v51; r1 F4]**. A retry of an open landing intent is checked against stops exactly like a new landing **[v04 check]**.
- Seats already running are the harness's processes: the PM stops them through its harness and reports to the maintainer what its harness confirmed **[U-3, U-4]**. `mp` reports "stop recorded; N dispatches were in flight".
- Narrowing and releasing: v51 §6.4 **[v51]**.

### 6.7 Closing and delivery [v51-U, simplified]

- Closing and delivery stay separate **[v51-U]**; the three closing tiers stay **[v51]**.
- Delivery: the manifest, the one-version-per-path check (versions stacked on each other are one line of work, Appendix L), the candidate on the target branch's current commit (each version brings its change since its origin, §6.2, Appendix H, laid after the versions it rests on, Appendix L), the proof check on the final candidate tree, the closing checks, the delivery ref `refs/mission-pipeline/delivered/<mission>/<op>` **[v51]**.
- Landing: the maintainer's "deliver" is consent to land **[v51-U]**; the PM runs `mp pm land`, which links the landing to the words entry (W-n) that gave the consent.
- **Fast-forward only, from the recorded base** **[v51, kept; r1 F3]**: the delivery commit was built and proven on base B. `mp pm land` moves the target branch from B to the delivery commit and nothing else. If the branch is no longer at B, it does not merge: it rebuilds the candidate on the new base (the full proof check and closing checks again, counted, WI-05), or leaves the delivery ref for the maintainer. A merge tree is never landed unless it was itself built, checked and proven as a candidate.
- **The landing steps** **[v51, kept in short form; r1 F4, r2 F1, F4]**:
  1. `mp pm land` takes the **landing lock** (§4.1) and holds it until it ends; a second landing waits or is refused.
  2. It records an intent (target branch, expected old commit B, new commit D, and the worktree it will use, if the branch is checked out) and commits it. The git commands run with no database lock held.
  3. **Branch not checked out**: `git update-ref refs/heads/<branch> D B` (compare-and-swap).
  4. **Branch checked out in one clean worktree**: immediately before, it checks in that worktree that `git symbolic-ref HEAD` is `refs/heads/<branch>` and `HEAD` is B; then `git merge --ff-only D` there.
  5. It judges the result only by the target ref (`refs/heads/<branch>` is D), never by git's exit message, and records it. A target ref that is not D, or a HEAD that changed between the check and the merge, goes to WI-06 class C with what it found.
- **Recovery** **[r2 F1, r3 F1]**: a call that finds an intent without a result first tries to take the landing lock without waiting. Held → the landing is still running: it reports "landing in progress" and touches nothing. Taken → the `mp` that held it has ended; a git command it started may still be running (a killed parent does not kill its child, and on Windows it never does), so the lock proves nothing about git. It checks:
  - target ref at D → recorded **done** (the worktree, if any, is compared to D and a mismatch reported under WI-04);
  - target ref at B → the intent **stays open**; "at B" never closes it. The PM may retry: the retry reissues the same B→D (compare-and-swap, or the checked fast-forward of step 4) under the landing lock, so a late finish of the old git command and the retry cannot both apply, and only D can ever land. Before a retry in a worktree, the worktree must be clean with `HEAD` at B and no git lock file (`index.lock`, the ref's `.lock`) present;
  - anything else → WI-06 class C.
  Only the PM closes an intent as "not landed", under WI-06, after a fresh check. A landing is never redone blindly. The remaining races (someone running git by hand in the maintainer's worktree during a landing) end in WI-06, not in more machinery **[U-8]**.
- When the worktree holding the branch is not clean, or the branch is checked out in several worktrees, `mp` leaves the delivery ref and the PM follows WI-01/WI-02 **[v51]**.
- Removed: the controlled git configuration view and the disabled hooks and filters of v51 §6.6. They protected against code executed by repository configuration, a security concern that is the harness's and the maintainer's business **[U-3]**. The correctness parts (fast-forward from a recorded base, intents and the check on recovery) stay.

### 6.8 Legalization: v51 §11.1 unchanged [v51-U]

### 6.9 Work instructions [U-8]

The WI mechanism stays: every exception names a WI; the PM reads only the index and opens a page when a notice names it. The pages are rewritten: WIs about sandboxes, cgroups, the metering proxy, budgets and quota waits (WI-09), the self-check, the watchdog, services and storage faults of the ledger service are removed; WIs for interrupted dispatches (release `--ended` or `--abandoned`, held leases), copying and moving the folder (copy while idle; what to do with a broken chain or missing objects, §3), and a landing intent left without a result are added; WI-06 keeps its recovery classes **[mine]**.

## 7. Removed from 4.0

| 4.0 part | Why removed |
|---|---|
| Seat host on the Claude Agent SDK; seat tools as in-process MCP tools | Binds seats to one harness **[U-1]**; seats use `mp` commands **[U-9]** |
| Bubblewrap tool sandbox, cgroups, fuse2fs areas, toolchain freeze, environment copies | Security is the harness's business **[U-3]** |
| Metering proxy, spend reservations, the money spend limit, quota waits | No traffic passes through `mp` any more **[U-3]**; the maintainer's answer to Q1 (§13) |
| Credentials handling, subscription checks | **[U-3]** |
| Startup self-check (isolation items 1–10) | Checked properties of the harness **[U-3]** |
| Ledger service, evaluator service, scheduler, watchdog, systemd units, control plane, stop inboxes | The PM dispatches **[U-4]**; SQLite transactions replace the single-writer service **[U-3]** |
| Memory outside the project (`~/.local/share/…`) | **[U-2]** |

## 8. Reading

### 8.1–8.3 Layers [v51-U]

Layers 0–3 and the read-depth rule of v51 §10.2 are unchanged. Layer 0 loses the fields that no longer exist (scheduler running, isolation degraded, spend) and gains dispatches in flight and their age **[mine]**.

### 8.4 Commands

`mp read status` (layer 0, plus the changed items per the rule), `mp read show <kind> <id>` (layers 1–2, with the leaf's path), and the leaves themselves (layer 3: read directly, or `mp read leaf <id>`, which also checks the hash).

**Seeing the tree connected** **[U-14; mine for the commands]**:
- `mp read why <id>`: walks back along the run chain and the "based on" links from any node (a commit, a run, a judgment, a task, a decision) to the maintainer's words, showing for each step: who handed it over, its state, whether it passed the program's checks, and its leaf.
- `mp read from <id>`: walks forward: everything that rests on a node (what a withdrawn requirement or a refuted version affects).
- `mp read chain <dispatch>`: one dispatch with its card, the step that handed it over, its report, its checks and what it led to.
- `mp read tree <mission>`: the whole mission as one indented tree (words → requirements → plans → tasks → dispatches → candidates → judgments → deliveries), one line per node with state and check result.

## 9. Installation and platforms [mine, v51-U]

- `mp` is a Node package (TypeScript **[v51-U]**, Node ≥ 22.12 with the built-in `node:sqlite`), installed per machine. When it is missing, the PM installs it for the maintainer (v51 §9.6 **[v51-U]**).
- Linux, Windows and macOS. Paths are stored relative to the project folder. Verification commands are declared per project and run with the platform's shell.
- `mp init` in the project: creates `.mission-pipeline/`, copies the role descriptions and handbook, adds the git exclude, optionally adds the pointer line and hook adapters (§4.2, §6.1).

## 10. Migration

None. 4.1 does not read 4.0.x ledgers; as with 3.x, a field PM migrates missions by the new rules **[mine, following the 4.0 ruling for 3.x]**.

## 11. Scenario acceptance

1. **Portability**: harness A (Claude Code) opens a mission, aligns, dispatches the decision seats and two Constructor tasks; one hand-back is in flight. Copy the folder to another path (and to a Windows machine). Harness B (Codex) opens it: `mp read status` and `mp pm next` show the same state; the in-flight dispatch is released and dispatched again; the mission finishes and is delivered.
2. **Mixed fillers**: the Constructor filled by one harness and model, the Reviewer by another; the record shows both fillers; changing the Reviewer's filler midway invalidates nothing.
3. **Parallel seats**: eight seats call `mp` concurrently for ten minutes; no lost write, no lock error surfaced to a seat.
4. **Stop**: a stop while three dispatches are in flight; their hand-backs are recorded as after the stop and not accepted; nothing in scope is dispatched or landed.
5. **Exploration with Stabilizer**: a seeded attack finding that changes the question is judged "shifts direction" and goes to the Secretary; an exploration that does not converge in 3 rounds goes to the Secretary with the Stabilizer's judgments.
6. **Crash**: `mp` killed mid-transaction; the database is consistent on the next open. `mp pm land` killed after the git update and before its result is recorded; the next call finds the intent, takes the landing lock, sees the branch at D and records it done, without a second update. An ordinary `mp read status` during a running landing reports "landing in progress" and records nothing. A crash at each step of the move recovery (§3.3) and two processes opening a moved folder at once both end with one completed move.
7. **Move with a changed environment**: a proven product moved from Linux to Windows; after the open, its runs' environment identity differs, its label is not fully proven; rerunning the declared commands with equal outputs renews the evidence mechanically and restores it; a judgment that used a timing field needs a Reviewer dispatch instead.
8. **Damaged copy**: a copy whose event chain is broken stops writes and is reported. A copy whose memory names a commit missing from `.git`, and one with a leaf edited by hand, keep working: the nodes are shown "commit not reachable here" / "leaf edited after it was recorded", and only the steps that need that content are held.
9. **Landing on a moved branch**: the target branch moved after the candidate was proven; `mp pm land` does not merge; it rebuilds the candidate on the new base or leaves the delivery ref.
10. **Stabilizer**: a Crititor's serious finding judged out of scope does not refute the version; a direction finding holds the exploration in "awaiting ruling" until the Secretary decides.
11. **Large fan-out**: a basis withdrawn under 100,000 dependent variables while eight seats hand back and a stop arrives; the stop is written first, every call either completes or returns "busy, retry", and reads show "recomputing" until propagation is done. With large withdrawals arriving continuously, the 10-minute notice appears; after the PM stops new work, `mp pm drain` empties the frontier.
12. **The tree**: for a delivered change, `mp read why` reaches the maintainer's words through every handover, each step showing its state, its checks and its leaf; `mp read from` on a withdrawn requirement lists everything that dropped.
13. **Sampling**: a benchmark run twice on the same candidate, commands and environment gives two runs with two ids; `mp seat <id> rerun` always executes.
14. **Landing, parent killed**: `mp pm land` killed while its git child keeps running; the next call takes the lock, finds the ref still at B, leaves the intent open; a retry reissues the same B→D; whichever finishes first lands D once; the intent is recorded done when the ref is seen at D.
15. **Folder outside layouts**: `mp init` in a linked worktree and in a repository with alternates warns under the WI and still initializes.
16. The v51 §12 process scenarios that do not involve removed parts.

## 12. Residual risks

1. The maintainer's words are recorded by the PM's discipline unless a hook adapter is installed; a PM that forgets loses the provenance of a requirement.
2. A seat that ignores its role (for example writes outside its paths and hands back nothing) is caught only at hand-back; what it did meanwhile is its harness's business.
3. The process advances only while a PM session is open **[U-4]**.
4. Which models a mission can use depends on the PM's harness **[U-4]**.
5. A folder copied while `mp` writes is not supported. The checks after a move (§3.3) catch a broken event chain, missing or edited leaves and missing commits, but a copy that is internally consistent and simply older than the source is indistinguishable from a deliberate older copy.
6. The environment identity covers only what the project declares (§6.5).
7. Leaves are plain files: anyone can edit them. An edit is detected by its hash and shown, not prevented.
8. Details that are noted rather than kept (full run output, seat conversations) cannot be recovered from the memory (U-13).
9. With pathological inputs (for example tens of thousands of paths against a thousand constraint patterns) one propagation step can take a few seconds; a stop and seat writes then wait for that one step (v06, Appendix E).
10. A verification whose commands are not all declared runs (one is marked sampled, or declares network access) takes no run lock (§4.1): while it executes, another process that advances the flow can run it again, as every sampling run executes (Appendix F).
11. A run checkout's repository borrows the project's objects while the run executes (§5.3, Appendix G): an object pruned from the project meanwhile (a `git gc --prune=now` during the run) is missing for the commands' git, and a partial clone's checkout has only the objects the clone has locally, so a command that needs an older object fails there instead of fetching it.
12. A later attempt starts from its dependencies' products as they are accepted when the attempt is submitted (Appendix M); a dependency accepted again while the attempt is queued or under way is not in its worktree. A target branch that moved since the task's work began also gives a new start (the snapshot a first attempt would get now), so a change of the branch that conflicts with the task's carried change holds the attempt until a re-plan.

## 13. The maintainer's answers to my direction-level additions (2026-10-10)

- **Q1 Spend and quota** → "拿掉，交给 harness": the per-mission `spend_limit` and the quota waits are removed; spending and quota are the harness's business. `mp` records usage only when a seat or the PM reports it, for reading, never to refuse anything.
- **Q2 Memory in git** → "默认不进 git": `.mission-pipeline/` is excluded from git by default (copying the folder carries it; cloning the repository does not).

## 14. Implementation outline [mine]

From an inventory of the 4.0.1 engine (63k lines): about 23k lines kept as they are, 14k adapted, 26k dropped.

| Area | Kept | Adapted | Dropped |
|---|---|---|---|
| Memory store (`ledger/`) | `queries`, error codes, stop types | `store` becomes the skeleton (§3.2): schema pruned to the run chain, states, links, checks, counts, operation ids, stops, fillers, cursors, labels and leaf references; journal mode DELETE; the event log gains the hash chain of §3.3; `projection` (runtime projections go), `rebuild` (also run after every move, §3.3), `verify` (synchronous; checks leaf references). The content store goes: the 156 places that put and get content split into skeleton data (lists, flow-event bodies, seat results, task specs, operation receipts, notice bodies; §3.2 item 11, stored as typed columns or JSON in skeleton tables) and documents for reading (reports, plans, cards, run summaries), which `mp` writes as leaves in the same transaction (§3.2) and records by file, anchor and hash and the domain checks now inside `LedgerService` (`appendFact`, loop and continuation checks, `assertCurrent`, stop scopes), which become functions called inside `mp`'s own write transaction | the service queue, IPC, writer lock held by a process, control-plane database, stop inboxes, probes, startup recovery pause |
| Labels (`evaluator/`) | `semantics` (the label definition, a least fixed point), `snapshot` | `incremental` keeps its algorithm but reads and writes the stored derived tables (§4.1) instead of process memory, with a stored frontier and batches across `mp` calls; every use of run classes switches to the 4.1 classes (declared / sampling / other, §6.5): `renewal`, run reuse, `regressionHolds` in `semantics` (mechanical regression check), record validation (`common/validate`, `common/records`), and the two places that assign the class: `flow/actions/verify.ts` (today `frozen ? closed : open`) and the blind runs of `seat/cards/experiment.ts` (today `open`, now sampling); layer-0 summary; notice expansion | the evaluator process, its supervisor, epochs and the publication-floor handshake (`commitProofOp` no longer needs `asOf`) |
| Process (`flow/`) | the flow engine (`reconcile` passes until no step progresses), planning, execution, secretary, legalization, requirements, mechanical checks | the scheduler port becomes the dispatch table: a submitted task is a ready step for `mp pm next`; a hand-back is what `status()` returns; products are commits from per-dispatch worktrees instead of seat exports; verification runs on a clean checkout of the candidate (§5.3) and records the environment identity (§6.5) | the sandboxed verify host |
| Exploration (`flow/exploration`) | the definition, rounds, evidence executions, research special case | the state machine gains the states of §6.3 (dispositioned, stabilized, awaiting ruling) and the "crititor + stabilizer" review position; the Stabilizer card and its routing to the Secretary are new | — |
| Cards (`seat/cards`, `card.ts`, `results.ts`) | every card kind's hand-back problems and records | role texts and their shared fragments (`cards/common.ts` and each card's definition) are rewritten for 4.1: no "no shell", no `read_material` / `submit_result`, no sandbox; the `mp seat <id>` commands, project-relative paths, continuation by card, and the candidate collection rule (§5.3). A test renders every card kind and fails on any removed interface name **[r2 F7]**. Schemas and rendering: `workspace.snapshot` becomes a project-relative path or a content identity, `resume.sessionId` is removed, the sandbox resource limits (`limits.run`, `areaBytes`, export caps, recovery-state size) are removed or become plain size caps on what `mp` stores. The tools become `mp seat <id>` commands: `card`, `read <material>` (page by page, must-read tracking kept), `handback`, `request-evidence`, `rerun <declared command>`, `checkout` (materializes the candidate commit a reader must see). File reading, writing, editing, searching, running and web fetching use the harness's own tools | the seat host, the Agent SDK session, the MCP server, credentials, the metering proxy, model configuration, the self-check |
| Scheduling (`scheduler/`) | routing | loops and retry counts per lineage, grants, quarantine restarts, continuation after evidence, waiting reasons, WI identities | the scheduler process, generations and takeover, units, admission, cleanup, control plane, watchdog |
| Execution (`exec/`) | — | — | all of it (sandbox, cgroups, enclosure, supervisor, proofs of termination, toolchain freeze) |
| Git (`git/`) | objects, canonical representation and commit planning, change sets, refs, repository format checks, worktree records, external worktrees, PM actions | `land()` and its recovery: fast-forward from the recorded base, intent before git, check on the next call (§6.7), with plain git (the bubblewrap view and the config allow-list go) | the landing view, the separate ref-writer process |
| Delivery (`delivery/`) | manifest, candidate, proof view, write scopes, `deliver` | its authority and label view read the store directly | — |
| CLI (`cli/`) | parsing, errors, WI index, stop detection, layer 2, flow and delivery commands | the PM commands move under `mp pm` (names otherwise unchanged) and gain `next`, `dispatch`, `release`, `say`, `renew`, `drain`; the tree reads of §8.4 (`why`, `from`, `chain`, `tree`); reads under `mp read`; configuration from the project folder; the hook logic becomes the optional adapters of §6.1 | install, self-check, engine state, recovery, the notice watcher, the PM monitor probe, model configuration, spend limits |
| Docs (`plugin/pm`) | the WI mechanism | PM handbook and WI pages rewritten harness-neutral; role descriptions extracted from the rewritten card definitions into `roles/*.md` | the Claude Code plugin manifest and hooks as a requirement (kept only as an optional adapter) |

Also: the two code comments that name a field site (`common/ids.ts:3`, `git/objects.ts:14`) are rewritten without it.

Tests: the 4.0 unit tests of kept modules carry over; the e2e test is replaced by the §11 scenarios, run with two different harnesses on the same folder.

## Appendix A: attack round 1 and its Stabilizer

Attack: `Critique_MissionPipeline_4.1_v01_gpt-6-astra.md` (gpt-6-astra, xhigh, 10 findings). Stabilizer (a Claude instance independent of the attacker and the author): round on track; 9 findings in scope (after its severity check: 0 fatal, 5 serious, 4 general), 1 shifts direction; nothing for the maintainer. Its note to the author: four findings (2, 3, 4, 8) came from v01 removing a v51 correctness mechanism under a "security is the harness's business" label; U-3 covers security, logins, spending and quota, not tying evidence to the commit, landing what was proven, or crash recovery. v02 keeps the correctness half of each and drops only the security half.

| # | Attacker | Stabilizer | Disposition in v02 |
|---|---|---|---|
| 1 | fatal | in scope, serious | Copy while idle (WI); no export step (U-2); after a move: worktree repair, hash-chained event log verified, state and labels rebuilt from the log, git objects checked; the detection promise is dropped (§3, §12.5) |
| 2 | serious | in scope, serious | Verification on a clean checkout of the candidate commit; the run records the commit and environment (§5.3) |
| 3 | serious | in scope, serious | Fast-forward only from the recorded base; otherwise rebuild or leave the delivery ref (§6.7) |
| 4 | serious | in scope, general | Intent before git, compare-and-swap, check on the next call, WI-06; stops refuse new authorizations and report started landings (§6.6, §6.7) |
| 5 | serious | in scope, general | One worktree per dispatch; release `--ended` / `--abandoned`; leases held until confirmed; late hand-backs recorded, not accepted (§3, §5.4) |
| 6 | serious | in scope, serious | Stabilizer states and the "crititor + stabilizer" review position; awaiting ruling blocks acceptance (§6.3) |
| 7 | serious | shifts direction | Rejected: U-7 concerns attacking this design; the product rule is U-6 (Stabilizer → Secretary) and U-10. Retagged §6.3 "[mine, after U-6]"; WI-08's extension rule stays |
| 8 | serious | in scope, serious | Environment identity per run; a change means needs rerun; no copies or freezing (§6.5) |
| 9 | serious | in scope, general | Card schemas moved to "adapted", fields listed (§14) |
| 10 | general | in scope, general | Labels stored with a revision; bounded propagation batches across calls; lock and busy limits; large fan-out scenario (§4.1, §11.11) |

## Appendix B: attack round 2 and its Stabilizer

Attack: `Critique_MissionPipeline_4.1_v02_gpt-6-astra.md` (same attacker session, re-checked round 1 and attacked v02; 7 findings, none fatal). Stabilizer (a new instance): round on track and converging; in scope after its severity check 0 fatal, 3 serious, 4 general (round 1: 0 fatal, 5 serious); nothing shifts direction; no author change from v01 to v02 drifts; nothing for the maintainer. Its warning: findings 1 and 4 sit in the landing protocol that took most of 4.0's attack rounds; fix them with a lock and a simple retry rule, send the remaining git races to WIs, and do not port 4.0's landing machinery.

| # | Attacker | Stabilizer | Disposition in v03 |
|---|---|---|---|
| 1 | serious | in scope, serious | A landing lock (an OS file lock the kernel frees on exit); recovery only when the lock can be taken, else "landing in progress"; retry only when the ref is at B, the worktree clean at B and no git lock exists; else WI-06 class C. No controlled view or filter items, no process watching (§4.1, §6.7) |
| 2 | serious | in scope, serious | 4.1 run classes (declared / other) for reuse and renewal; mechanical renewal of declared runs with equal used fields and no timing/statistical/external fields; otherwise a new Reviewer judgment (§6.5, §11.7). Option (a) of the Stabilizer; no freezing or sandbox |
| 3 | serious | in scope, general | "Move pending" recorded first, "move done" committed with the rebuilt tables; recovery under the maintenance lock; restart from the first unfinished step (§3) |
| 4 | serious | in scope, general | Check `symbolic-ref HEAD` and HEAD = B just before the fast-forward; judge by the target ref; mismatch → WI-06 class C (§6.7) |
| 5 | general | in scope, general | Work counted in edges plus variables; stored frontier; bounded batches on later calls; while any frontier is non-empty every decision needing "proven" waits (§4.1) |
| 6 | general | in scope, serious (raised) | Every non-ignored change collected, new files included, without `git add`; changes outside the write paths refuse the hand-back; ignored files listed (§5.3) |
| 7 | general | in scope, general | Role texts and shared fragments rewritten; a test fails on removed interface names (§14) |

## Appendix C: attack round 3, its Stabilizer, and the maintainer's ruling on the memory

Attack: `Critique_MissionPipeline_4.1_v03_gpt-6-astra.md` (a fresh attacker; 5 findings, none fatal). Stabilizer (a new instance): round on track; all 5 in scope, none shifts direction; after its severity check 0 fatal, 2 serious, 3 general (rounds 1 and 2: 5 and 3 serious); no author change from v02 to v03 drifts. Not converged: under U-7 the 3 rounds were spent, so the author stopped and reported to the maintainer.

The maintainer then ruled what the memory holds (U-13, U-14): design decisions, what each seat did and whether it passed the program's checks; for details, a note of what was done and where; the database is the skeleton that connects the tree, Markdown files are the leaves. v04 restructures §1, §3 and §6.5 accordingly, and adds the tree reads of §8.4. This also changes round 3's finding 3: missing code or leaves no longer block the memory.

| # | Attacker | Stabilizer | Disposition in v04 |
|---|---|---|---|
| 1 | serious | in scope, general | The lock proves only that `mp` ended, not git; "at B" never closes an intent; a retry reissues the same B→D under the lock; done only when the ref is seen at D; only the PM closes an intent as not landed, under WI-06 (§6.7, §11.14) |
| 2 | serious | in scope, serious | A third 4.1 class, sampling runs, never reused; experiments, timing/statistical judgments and `rerun` always execute with a new run id (§6.5, §11.13) |
| 3 | serious | in scope, serious | Under U-13 the folder carries the memory, not necessarily the code: layouts with objects outside the folder are warned about under a WI at init and after a move, not refused; missing commits and leaves are shown and hold only the steps that need them; a broken event chain still stops writes (§3.3, §11.8, §11.15) |
| 4 | general | in scope, general | The drain claim is corrected: drains once large changes stop; a notice after 10 minutes; `mp pm drain` (§4.1, §11.11) |
| 5 | general | in scope, general | Every use of run classes is listed and switched, including the mechanical regression check (§6.5, §14) |

Also from the Stabilizer: "`mp` starts no processes" now reads "starts no seats and runs no background service" (§2.5); the renewal rerun is an explicit PM step, `mp pm renew` (§6.5).

## Appendix D: Stabilizer check of v04

After the maintainer's ruling on the memory (U-13, U-14) the author restructured v03 into v04; a Stabilizer (a new instance, not an attacker) checked the changed parts against the maintainer's words and against round 3's findings. Verdict: no drift, nothing for the maintainer; v04 can be the implementation contract after two narrow edits; no further attack round needed.

| Item | Severity | Disposition in v05 |
|---|---|---|
| B1: data the program computes on (proof-model lists, flow-event bodies, structured results, task specs, operation receipts, notice bodies, leases, intents) had no place once the content store went; read literally they would sit in hand-editable leaves | serious | §3.2 item 11: all of it lives in the skeleton; leaves hold only documents for reading; §6.5, §14 |
| B2: `git worktree repair` on a same-machine copy whose git common directory is outside the folder rewrites the shared repository | serious | §3.3 step 2: skipped in that case; git-writing commands held until the PM confirms under the WI which copy is in use |
| Leaf write order (lost or doubled leaf on retry; parallel journal appends) | general | §3.2 "Writing a leaf": inside the transaction, temp-and-rename, anchors from the operation id |
| Run class decided after the run | general | §6.5: class fixed at record time from the card; validation refuses timing/statistical/external fields of non-sampling runs |
| §14 missed the places that assign run classes | general | §14: `flow/actions/verify.ts`, `seat/cards/experiment.ts` |
| Report file inside the worktree | general | §5.3: written in `tmp/<dispatch>/` |
| §5.3 still said `runs/<run>/` | minor | `tmp/<run>/` |
| Material reads did not check the leaf hash | minor | §5.2 |
| §11.11 contradicted §4.1 | minor | "after the PM stops new work" |
| A landing retry and stops | minor | §6.6: checked like a new landing |
| The PM's filler per command; W-n links for stops and landing consent; requirement quotes verified against their words | minor | §3.2 item 13, §6.6, §6.7, §6.1 |
| §2.5 wording; object closure | minor | §2.5; §3.3 step 5 uses `git rev-list --objects --missing=print` |

v05 was not checked again after these edits; they are the Stabilizer's own fixes, applied as written.

## Appendix E: the batch-bound amendment (v06), from the code review of the labels layer

Three code-review rounds of the labels layer (gpt-6.1-sol) kept finding places where a batch was not strictly ≤ 20,000 units / 2 seconds; admission limits added to meet the bound (proof-unit members, review positions, regression registrations, constraint lines, rule lists) then rejected normal legal records. A Stabilizer judged the loop: the reviewer had not drifted; the cause was the author's own strict numbers ([mine] in v05, not the maintainer's). The purposes behind them stay: no write holds up a stop; propagation always finishes once large changes stop; nothing unproven is used as proven while propagation is unfinished.

Change (§4.1, §12.9): the numbers become targets; every batch commits at least one step; a step is one record's work and an oversized lone step runs alone and commits, only in the PM's batches; the "recomputing" gate is unchanged; admission limits that existed only for the batch size are removed (record-size limits and path depth stay, against malformed input). `mp pm stop` writes the stop directly, with no batch, landing recovery or `next` before it. Accepted cost: with pathological inputs a stop can wait a few seconds for the one running step.

## Appendix F: the run lock (after 4.1.0)

Defect: a declared run is recorded only after all its commands have run (§5.3), and nothing marked it as executing. While a declared verification run of a candidate was executing and not yet recorded, any other `mp` process that advanced the flow (a seat's hand-back, a PM write command, `mp pm next`) found no reusable run and started another execution of the same run on the same candidate, in its own checkout, and waited for it; a long verification made those commands hang for its whole duration and multiplied its cost.

Change (§4.1, §6.5, §12.10): a declared run executes only under a process lock per reuse key (the key `findReusableRun` matches: candidate, command, working directory, environment identity), taken without waiting. The holder checks reuse again inside the lock, executes, records and then releases, so the next holder finds the run recorded. A process that finds a lock held runs and records nothing: the flow's verification answers "pending" and the step waits for a later pass, which reuses the recorded run; a hand-back is recorded as before and says that the runs are executing in another process; `mp pm renew` lists the run as skipped. Sampling runs take no lock: every rerun and experiment executes. A killed holder blocks nothing, since the kernel releases its lock; the next call executes in a checkout of its own (a killed run's checkout directory is left under `tmp/`, like other scratch of a killed process).

## Appendix G: the run checkout's repository (after 4.1.0)

Defect: a run checkout (`tmp/<run>/`, and a delivery candidate's run directory) was the candidate's files with no `.git` of its own, inside the project's work tree under `.mission-pipeline/`, which `mp init` excludes. A command that asked git a question there was answered by the enclosing repository, where the whole checkout is an excluded path: `git ls-files` listed nothing, tracked files read as untracked or ignored, `git log` and `git diff <base>` saw the enclosing branch instead of the candidate, and tools that honour git's ignore rules found no files. A project whose verification reads git (file censuses over tracked files, purity diffs against a base commit, checks that lockfiles are committed, linters) failed every candidate whatever it contained, and so did a Reviewer's rerun; each plan author had to know to prefix such commands with a repository of their own.

Change (§5.3, §12.11): after the checkout is materialized, `mp` makes it a repository positioned at the candidate, without changing the project's repository:
- `git init` with no template (no hooks, no exclude file, no remote, no branch), in the project's object format; `objects/info/alternates` names the project's common git directory's `objects`; the project's `shallow` list is copied, so the history ends where it ends in the project; no promisor remote, so an object that is not local is missing there too and never fetched (WI-13). This is not `git worktree add`, which would register the checkout in the project's repository; nothing is registered, no ref is created, no configuration and no object is written there.
- Its configuration carries only the bound transform description (core.autocrlf, core.eol, core.symlinks, core.filemode, core.ignorecase; the description's info attributes as `info/attributes`, its global attributes as `core.attributesFile`), so git reads the files by the rules they were written under; no file system monitor and no automatic gc. No other key of the project's configuration is copied (no key that names a program, no remote, no identity), as v51 copied only keys that run nothing.
- HEAD is detached at the candidate; the index is read from its tree (`git read-tree`) and refreshed against the files (`git update-index --refresh`) with every configured content filter switched off for that refresh, so `mp` runs no program of the configuration and the index has stat data (plumbing such as `git diff-index --quiet HEAD` finds a pristine checkout clean).
- Line endings and other transforms: the files on disk are the materialization, not the blobs. `git status` is empty when every file's bytes convert back to its blob under the description, which holds for files materialized from normalized blobs. A blob stored in a form `git add` would not produce (a CRLF blob under a `text` attribute) shows as modified, which is git's own judgement of those bytes and the one it gives in the project's work tree. A file written raw because its filter is not one the program implements is its blob and reads clean; a Git LFS file holds the object's content and is judged by the user's LFS filter when a command first asks.
- The commands of a run get no variable that would point git elsewhere (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_NAMESPACE, GIT_PREFIX).
- The `.git` is removed with the checkout, as before. A Reviewer's reading checkout (`mp seat <id> checkout`) is unchanged: it is kept until the next checkout replaces it, longer than the objects it would borrow are guaranteed to stay, and the reader can ask the project's repository about the commit on its card.

## Appendix H: the change a reworked product brings (after 4.1.0)

Defect: a rework's Constructor continues in a worktree at the previous attempt's candidate (§6.2), so the candidate commit of attempt k has attempt k−1's candidate as its parent. Every place that takes a product version's change (a dependent task's snapshot, a delivery candidate, an Auditor's snapshot of several products) took it as the difference between the version's commit and that commit's parent: for a version accepted at a later attempt, only the last attempt's change, measured against the previous attempt's files. A path the last attempt changed after an earlier attempt had changed it then differed on all three sides (the base still held the content the work started from), so every dependent task's snapshot reported a conflict on it; the dependent never got a card (the flow noted the refusal and tried again on every pass), and all work after it waited. A path that only an earlier attempt changed was not in the change at all, so a snapshot without a conflict silently left it out, and a delivery built without one found the write scope changed and delivered the version as not fully proven.

Change (§6.2, §6.7):
- A product version records its **origin** (`source.origin` on the version record): the snapshot the first attempt of its task started from. A first attempt's origin is its commit's parent; an attempt that continued from the previous attempt's candidate inherits that version's origin. The commits are unchanged: a candidate's only parent is still the commit its worktree started from, so what seats and run checkouts see of the history stays as it was.
- A version's change is the difference between its commit and its origin, inside its write scope. A dependent's snapshot, a delivery candidate and an Auditor's snapshot overlay it three-way as before; only the side the version started from changes. A conflict is therefore reported where the base changed a path differently since the work began, a path only an earlier attempt changed included, and nowhere else.
- Versions recorded before the origin was recorded are not run again: their origin is derived from the records and the commits, down the predecessors for as long as each commit's recorded parent is its predecessor's commit, then the parent of the last commit reached. A version whose commit was not built on its predecessor's starts at its own parent. A rework recorded on top of such a version records the derived origin.
- A version's changed paths (on the Reviewer's card) are its whole change since its origin, not only the last attempt's.
- A dependent task that was refused its snapshot needs no action: the flow tries the snapshot again on every pass, and the next pass gives it its card.

Not chosen: building each attempt's candidate commit with the first attempt's snapshot as its parent, so that a commit against its parent is the whole change by construction. Versions already recorded would still need the derivation above, the parent would no longer be the commit the seat's worktree started from, and the collection at hand-back would need the origin passed to it.

## Appendix I: checking the plan in effect again (after 4.1.0)

Defect: the calibrator-1 contract of a PM plan version binds the mission's requirement set (v51 §3.3, v31: written for the whole plan, not per batch), so any requirement item added, revised or withdrawn after the plan took effect makes its pass not current. Every detailed plan of that version relies on it (its Calibrator ② and feasibility contracts), and every product accepted under them relies on its detailed plan (the Reviewer contract), so all of them become "not fully proven"; in stable mode the gate then releases no Constructor and takes in no result of work in flight. v51 §5.2 part 5 specifies the recovery: a continuation Calibrator ① judgment that reviews only the changes, on the same plan version ("M2 and the detailed plan recover; products relying on them only through the detailed plan recover with them"), and the evaluator implements it (a continuation may target J0's own object). The flow never produced it: a plan's Calibrator ① ran only before the plan took effect, and every batch minted a new version. A new version restores neither the old version nor the products accepted under it: their Reviewer contracts rely on the detailed plan current when they were recorded, which relies on the old version; tasks whose card the new detailed plan keeps stay accepted and are never judged again, so their dependents wait in stable mode for good.

Change (§6.1, v51 §3.3):
- A batch whose plan document is the latest version's, unchanged, once that version took effect, is a **re-check** of that version (event `cal1-recheck`, reported as batch `b<n>.c<m>`): no new version, no Architect attempt, no feasibility review, no Calibrator ②. The same request again is the same re-check. A batch that changes the mode is still a new version (the mode belongs to a version).
- The re-check is a Calibrator ① task on the same position (`cal1.<mission>.<n>.c<m>`), a continuation of the position's deciding pass: its card names the batch's words and the items that changed since that pass (added or revised; withdrawn ones listed), and its focus is the elements resting on them, or every element when none does (does the plan leave a new item out, or go against it?). The continuation check and "needs full review" work as for any batch.
- A pass is a new deciding judgment on the plan's position, bound to the current requirement set: the plan, its detailed plans and the products relying on them are current again, and work held by the stable gate goes on. A fail or an undecided outcome goes back to the PM as a returned batch; the plan stays in effect without its proof.
- A later version's continuation extends the position's deciding pass: the latest decided Calibrator ① on it, a re-check's or a rerun's included (before, always the batch's first, which a rerun or re-check had replaced, so the continuation was refused and reviewed in full).

Not changed: a re-check is never started by itself when an item is recorded (the PM records items and plan changes, then submits one batch, v51 §3.3); a changed plan document is a new version as before, and products accepted under the previous version keep relying on it (Appendix J re-binds those of the tasks the new version keeps).

## Appendix J: products of kept tasks under a new plan version (after 4.1.0)

**Per maintainer ruling 1, 2026-10-13 [U-15]:** no judgment is written by the program in a seat's place. A re-bound product version is judged by a Reviewer in stable mode. Fast mode notifies the PM, as for a revised basis. Keep the new-version structure and bind the Reviewer to the product's contract.

Defect: a product version's Reviewer contract relies on the detailed plan in effect when the version was recorded (v51 §5.2), and that contract is fixed with the object. If that plan loses its proof, a later plan that keeps the task's card leaves its accepted product not fully proven. Repeating a judgment on the old version cannot replace the reliance named by its contract. Comparing selected inputs cannot stand in for a seat: a decision quoted on the current Reviewer card may change while the task, candidate, bases, constraints, interfaces and runs remain the same.

The following mechanics implement the ruling without changing the evaluator's contract semantics. Rules explicitly attributed to maintainer ruling 1 or v51 §5.6 are requirements; the remaining mechanics are **Proposal, pending ruling**.

- **When:** reconciliation finds an accepted product that is not fully proven because its old plan is not proven, or its prerequisites were re-bound. It waits until the effective detailed plan is proven and its dependencies have completed their re-binds. A product built on dependency work that was rebuilt rather than re-bound cannot simply replace the prerequisite id: it stays not fully proven with a PM notice; changing its task card rebuilds it.
- **New version:** `<product>.b<n>` has the same content, scope and source (commit, write scope, transform and origin), the version it re-binds as predecessor, a Reviewer contract relying on the effective plan, and the accepted re-bound prerequisites. Replay of the same id must match every immutable field, including prerequisites and review contracts; mismatches are refused. The Constructor attempt number does not change.
- **Stable review, per maintainer ruling 1, 2026-10-13:** use the ordinary Reviewer hand-back path and the card under the effective plan. Declared verification runs on the same candidate are reused when recorded. No automatic pass or `executor=program` judgment is written. The version remains unaccepted until its Reviewer passes; stable dependents wait. `changedSinceJudged` is not a reason to skip the seat.
- **Review exits:** pass accepts the re-bound version; rework starts the next Constructor attempt and records the version sent back as its predecessor; needs-decision waits for the Secretary, whose answer starts another review of that same version. Seat failures follow the ordinary retry and escalation paths. Recorded re-bind events, queued reviews and hand-backs can be reconciled again. The version and its re-bind event are separate writes: replay after only the version was written requires the same immutable inputs. A plan change in that gap can cause a persistent replay conflict; recovery across that gap is not guaranteed.
- **Issue lineage, v51 §5.6:** every Reviewer path requires an explicit answer on the target version for every issue already observed anywhere in the task's lineage: all attempts through the current attempt, every re-bound version (including superseded siblings), and earlier rounds on the target itself. Each issue carries the latest recorded response as context, including a superseded seat's hand-back even though its verdict is not acted on.
- **Per-version deferral, v51 §5.6:** a deferred response supplies an owner and a non-empty reason. The reason is stored as content and its hash is recorded with the owner in the seat judgment. The next Reviewer must answer the issue again, shown as "deferred to <owner> by <judgment> on <version>: <reason>"; answering deferred again does not force rework. Constructor cards keep deferred issues outside the fix list, with the ownership and reason in their instructions. Deferral remains unfixed. The closing snapshot lists each selected product version's stored issue states other than fixed, including deferral owner and reason; this listing adds no refusal to close.
- **Supersession:** cancellation repeats on every reconciliation pass, in an open or a closed mission (cancelling is not production), across every task line ever in an effective plan and every exit: a new task card, a dropped task, abandonment or a superseded re-bind. Queued and waiting-evidence Constructors and Reviewers of earlier attempts are cancelled, as are all steps of the current attempt when dropped after its last spec or abandoned under it. Reviewers of unaccepted re-binds are cancelled except the pending re-bind matching the plan in effect and the current acceptance; answer rounds and environment re-reviews are included when their attempt is obsolete. Running seats finish and retain their results; a superseded verdict is not continued and does not accept or send back a replacement card. If a release queues obsolete work again, the next reconciliation cancels it, on every exit. A kept card waits while a superseded re-bind Reviewer runs; only after it settles is the next re-bound version recorded and its card built with the recorded findings.
- **Fast mode, per maintainer ruling 1, 2026-10-13:** notify the PM (`kept-product-not-rebound`); write no re-bind pass and keep the accepted product not fully proven. A stable review or a re-plan changing the card is the recovery path.
- **Readers:** accepted-version readers use the latest accepted re-bound version: dependency gates and snapshots, withdrawn-basis checks, re-reviews, closing snapshots and Auditor run lookups. Every Reviewer binding uses the relied-on objects in its target version's contract.
- **Notices (Proposal, pending ruling):** `kept-products-rebind-review` names old and new versions awaiting seat review; `kept-product-not-rebound` explains a fast-mode or prerequisite hold. When a review records a deferral, `reviewer-issue-deferred` names the task, version, issue, owner and reason, states that it remains unfixed and is listed at close, and leaves routing to a re-plan or the user. It is sent before the review-event commit, idempotently by review and issue. These normal branches have no WI and create no owner task.

A continuation judgment on the same version cannot replace its fixed contract reliance. A new evaluator record kind for replacing that reliance is not introduced.

## Appendix K: the previous detailed plan on an Architect revision card (after 4.1.0)

Defect: an Architect revision (v51 §3.4: a new PM plan version revising the latest effective detailed plan, a mechanical or feasibility return, a Secretary's send-back, a re-plan request from execution, a settled exploration) is told to revise the previous detailed plan and to fix exactly what came back. The card carried that plan in its data, but its body showed only the task ids, and the seat had no command that read it (§5.2: a seat reads its card and its materials). A seat could not carry a task over unchanged: it reconstructed the plan from another seat's hand-back file, or rebuilt it from the PM plan and the project, rewriting every card. A task whose card changes is re-specced and restarts at a new attempt (§6.2: the card is the task's spec), so once such a plan took effect every accepted task was restarted, and the re-bind of kept products (Appendix J) found no kept card. For a new PM plan version, the card did not say which elements had changed either.

Change (v51 §3.4; §5.2, §6.2):
- **The previous plan, in full**: a revision card has the previous detailed plan as a must-read material `plan-old` (role plan): every reused and new interface, module, task and risk with every field, written as the decomposition hand-back's own fields, one element per line, so a kept task is copied as one line, not retyped. It is paged like every material, and the hand-back is refused until every page was read. The card's body names it with the previous plan's task count and ids. A revision card queued before this change (no material) shows the plan inline at the end of its body.
- **The carry rule**, on the card (duties and revision section), in the material and on the Architect's role page: every task the revision does not need to change is carried over exactly (the same id, the same value in every field), because a task's fields are its card and any change to a card restarts the task while its accepted work is no longer used; only what the instructions, the changed PM plan elements, the feasibility findings or the mechanical failures require is changed, with what that forces; a new task gets an id no task of the previous plan has; the modules and interfaces of the unchanged tasks are kept.
- **The changed elements**: a new PM plan version's instruction names the elements added, changed and removed against the PM plan version of the plan in effect.
- **Notice** `plan-revision-restarts-work` (normal branch, no WI), once, when a revised detailed plan has passed its mechanical checks while a plan is in effect and it changes or drops tasks of that plan with accepted work or work under way: how many of the plan's tasks it keeps, changes and drops, and which changed or dropped ones have accepted work or work under way (read from the task lines). Nothing is held: the plan goes on to its feasibility review and Calibrator ②, and once in effect restarts those tasks as before.

Not chosen:
- Refusing a revision that changes the card of a task with accepted work: a revision may need it (an instruction, a changed element), and judging that is the reviews' work, not a program rule.
- Copying unmentioned tasks by program: the hand-back is the whole detailed plan (v51 §3.4), and a silent copy would hide the Architect's choices from Calibrator ② and the feasibility review.
- The previous plan inline in every card's body: a long plan would not fit one read of the card, while a material is paged and its reading is checked.

## Appendix L: products stacked on each other (after 4.1.0)

Defect: a dependent task's work starts from a snapshot that holds its dependencies' products, so its version's change is taken against that snapshot (its origin, Appendix H). The plan allows a task to write what a task it depends on writes (the mechanical check asks disjoint write scopes only of tasks that can run in parallel). Every place that lays several versions over a base (a later task's snapshot, an Auditor's snapshot of several products, a delivery candidate) laid them in id order and compared each version's "started from" side with the base itself, never with the base as the versions laid before it had changed it. Where a dependent and the version it rests on changed one file, the dependent's "started from" side was the other's entry, so all three sides differed and the program reported a conflict on every such path: a task depending on both never got its card (the flow noted the refusal and tried again on every pass), and an integration task or a delivery of the chain could not be built. The delivery manifest refused such a chain before that (two versions of one path or of one module), and the proof check would have read the version below as changed by the one above it. The same comparison let two unrelated versions that changed one file differently pass a snapshot, the later silently replacing the earlier.

Change (§6.2, §6.6 steps 2–4):
- **Order**: the versions are laid each after the versions it rests on (its recorded prerequisites, a prerequisite unit by its members, transitively among the versions laid); unrelated versions in id order; a cycle of prerequisites (members of one proof unit) is broken by the version with the fewest of them still to lay, then by id. A snapshot reads each product's recorded prerequisites for this; a delivery and an Auditor's snapshot use the same overlay.
- **Running overlay**: each version is compared path by path with the base as the versions laid before it left it. A path the version did not change stays as it is; where the overlay still has what the version started from, the version's entry; where it already has the version's entry, nothing; otherwise a typed conflict, which names what the overlay has there and the earlier version that put it there (none: the base's own entry). A path the base or an unrelated version changed differently from what a version started from is a conflict as before, now also between two unrelated versions.
- **Manifest**: versions sharing a path or a module are compatible when every two of them are stacked (one rests on the other); the one on top delivers the path. Versions that do not rest on each other are incompatible as before.
- **Proof check**: a version that versions resting on it were laid over is read as it stands under them: the candidate with each path they changed put back to what the first of them found there. Its own write-scope identity and the prerequisite check of a version resting on it are computed on that tree, so a dependent's change does not count against it (it is checked as the dependent's), while a change by the base or by an unrelated version still does. The evidence-input check reads the candidate as before.

Not chosen:
- Taking a dependent's change against the base, as if it brought its prerequisites' change too: its prerequisites are delivered as their own versions, and a delivery of the dependent alone would then carry unproven content under the dependent's name.
- Chaining per path by content (laying whichever version starts from what is there), without the prerequisites: an order the records already give is not guessed from file contents, and two versions starting from the same content would be ambiguous.

## Appendix M: a later attempt on its dependencies' current work (after 4.1.0)

Defect: a later attempt of a task (a rework, or a respec after a re-plan) started its Constructor worktree from the previous attempt's candidate. When the task's dependencies changed since its work began (a re-plan added a dependency, or a dependency was accepted again at a newer version), the worktree and the declared runs never held the new dependency products: a run that passes only with a dependency's change failed on every attempt, and a call of a dependency's new interface could only be built against a stand-in, so the task could never pass its review on its own runs.

Change (§5.3, §6.2):
- When a later attempt is submitted, the program takes the snapshot a first attempt would get now (the mission base with the current accepted products of the task's current dependencies, laid as in Appendix L). When its tree is the tree of the previous version's origin (Appendix H), nothing changed: the attempt continues from the previous candidate exactly as before.
- Otherwise the worktree starts from that snapshot with the previous version's whole change since its origin laid over it, three-way, as a delivery lays a version (§6.7): a commit whose only parent is the new snapshot. The attempt's dispatch record names the new snapshot, and its product version records it as its origin, so the version's change is the task's own work since that snapshot, the earlier attempts' included, and none of the new dependency's. Later attempts on top of it continue from it as before (their origin is inherited, Appendix H).
- A carried change that conflicts with the new snapshot (a path the new dependency work changed differently from what the task's work started from) builds nothing: the attempt waits, a notice (`rework-start-conflict`) names the paths, and the step is tried again on every pass. A re-plan that changes the task's card starts its next attempt from the dependencies' current work without the earlier attempts' change (the previous candidate stays readable by its commit).

Not chosen:
- Starting from the new snapshot with only the conflict-free part of the carried change: the Constructor of a rework is told to fix the review's issues, not to redo earlier work that silently went missing from its worktree, and its Reviewer's changed paths would no longer show it.
- Comparing the dependency lists instead of the snapshot trees: a list does not show a dependency accepted again, and a kept product re-bound under a new plan (Appendix J) has a new id with the same content.
