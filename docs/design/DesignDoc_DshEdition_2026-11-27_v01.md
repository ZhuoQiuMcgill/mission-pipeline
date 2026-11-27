# Mission Pipeline on DSH: project charter and design decisions (v01)

Status: v01, 2026-11-27. This document starts the DSH edition of Mission Pipeline. It records what the maintainer decided in the alignment of 2026-11-25 to 2026-11-27, the proposals that are not yet ruled, and the facts both rest on. Nothing here is implemented. It builds on 4.3.0 with the nine field fixes of pull request 70. It is a charter, not an implementation contract: under G-14 the details are settled during development, on real tasks.

## 0. Calibration: where each element comes from

Every element below is tagged:

- **[G-n]**: the maintainer ruled it. The table states each ruling in the author's words; the maintainer's own wording is not reproduced in this document.
- **[proposal]**: the author's. It is not in force until the maintainer rules on it.
- **[fact]**: verified in source or taken from a field record; the text says which.

| Id | Date | The maintainer's ruling, in the author's words |
|---|---|---|
| G-1 | 2026-11-25 | Mission Pipeline enters DSH deeply. That does not mean tight coupling: it means making heavy use of the modular functions DSH offers to adapt Mission Pipeline to DSH. |
| G-2 | 2026-11-25 | Mission Pipeline depends heavily on closed, enterprise harnesses. They are powerful, but they cannot be customised deeply, cannot be used at all in some regions, and make verification across model families inconvenient. An open-source harness therefore becomes the base, and the model provider is decoupled from the pipeline. The 4.0 attempt failed: building a harness is harder than expected. |
| G-3 | 2026-11-25 | A main reason for choosing DSH is that it is built from plugins: much room to operate on it and modify it, while the overall maintenance cost stays low. |
| G-4 | 2026-11-25 | On DSH the edition depends on no other harness at all. |
| G-5 | 2026-11-25, 2026-11-26 | Embedding Mission Pipeline fully in DSH needs some change of architecture. The pipeline's philosophy was fixed in 4.3.0; however the architecture and the implementation underneath change, they must not violate it. |
| G-6 | 2026-11-26 | The requirement is that any harness can rebuild the project from the files Mission Pipeline records. Binding deeply to DSH does not tie Mission Pipeline to DSH for good: its architecture and philosophy keep developing, and the edition inside DSH is a branch. |
| G-7 | 2026-11-25, 2026-11-26 | A small model classifies the user's input automatically. An interface shows the user how it was classified, and the user can object there and have the small model change it. None of this passes through the PM. That the PM does not record does not mean it stops understanding the user's intent: its most important duty is unchanged, and the point of the split is to take the cost of recording off the PM. The intent is a new seat, like a court historian. The user decides which model fills it; the program can cut a recent slice of context for it to classify; and the user has a place to object. |
| G-8 | 2026-11-26 | An objection is one of two kinds: the user knows which class the record belongs to; or the user thinks it is wrong but does not know where it belongs. In the second case the user prefers to talk to the PM, and that context is not wasted, because it helps the user understand and locate the matter. The Historian's duty is simple: it only records and takes no instructions. In the second case the PM is allowed to call the Historian to change a record that is not yet in effect. |
| G-9 | 2026-11-26 | When a record takes effect: (1) if the user neither confirmed nor objected, the previous message takes effect when the user sends the next one; (2) if the user neither confirmed nor objected, it takes effect after five minutes, and those five minutes are a buffer; (3) if the user confirms, it takes effect at once. |
| G-10 | 2026-11-26 | The stop becomes a mechanism inside DSH. After the user presses stop, the PM does not have to tell the Secretary and the Secretary does not freeze seats one by one: one command freezes every runtime. It is not a truncation at the program level: every seat is given what it should do on receiving the freeze. The PM receives only one message, saying when the work was stopped. |
| G-11 | 2026-11-26 | DSH's core may be changed when necessary, on a fork of the DSH repository. The fork is for our own use unless someone asks for it. Nothing is pushed back to the upstream repository; we maintain our own version on our own account. |
| G-12 | 2026-11-27 | The first three subjects, to be solved on 4.3 whatever the harness: (1) a card carries only what concerns its task and is built when its seat starts; (2) three things get a formal place in the memory; (3) the loop is run by a program. |
| G-13 | 2026-11-27 | Two concerns. When the user talks only to the PM, who controls the killing of processes, and does this approach lower what the user can see of the project? And if every version copies a worktree: in an earlier project a pile of worktrees took a great deal of disk space. |
| G-14 | 2026-11-27 | Open a new branch and start a DSH edition, writing the design decisions already made into it first. When development begins, the pipeline's shortcomings still have to be found through real tasks. |

## 1. Why this project exists

- Mission Pipeline today runs on closed harnesses. They cannot be customised deeply, are unavailable in some regions, and make verification by several model families awkward **[G-2]**.
- The DSH edition uses an open-source harness as its base and separates the model provider from the pipeline **[G-2]**. On DSH it depends on no other harness **[G-4]**.
- DSH was chosen because it is built from plugins: much room to change it, at a low maintenance cost **[G-3]**.
- The edition calls many DSH modules but is not coupled to DSH **[G-1]**. It does not build a harness: 4.0 tried and failed **[G-2]**.

## 2. What may not change

### 2.1 The philosophy of 4.3.0 [G-5]

The architecture and the implementation may change; the philosophy may not. Appendix A lists 17 candidate invariants the author extracted from the 4.0 to 4.3 design documents. **The maintainer has not reviewed that list.** Until then it is a reading aid, not a rule.

### 2.2 Memory neutrality [G-6]

Any harness can rebuild the project from the files Mission Pipeline records. Proposals that follow from it **[proposal]**:

- `mp` stays the only reader and writer of the memory. DSH plugins call `mp` as a subprocess. **[fact]** The engine assumes one short process per command: its locks are released by process exit, and the verification at a hand-back runs synchronously for up to 30 minutes by default (engine/src/memory/locks.ts, engine/src/process/runs.ts).
- No process truth is kept in DSH. DSH holds only what can be rebuilt (which session fills which dispatch) and what is not yet a record (a words entry inside its buffer period, §4.1).
- **[fact]** 4.3.0 folds a record kind it does not know without an error and ignores it (engine/src/memory/projection.ts). So a record that carries force (a stop, a waiver, an authorization, a ruling) uses a kind mainline knows. A kind only this branch writes is descriptive and carries a prefix. Changes to the memory format land in mainline first.
- What the edition enforces at run time, `mp` still checks at hand-back. The edition adds checks; it replaces none.

### 2.3 Mainline and this branch [G-6]

This branch is the DSH edition. Mainline keeps developing. Engine changes that help every harness (§5.5) go to mainline and are merged here.

## 3. The base: DSH and its fork

**[fact]** DSH is `deepseek-ai/deepseek-harness`, MIT, read at 0.2.3-alpha.2 (commit 4b399c3, 2026-11-22). It has no stable release: 44 tags between 2026-08-17 and 2026-11-22, about one every 2.2 days, and about 201 breaking-change guides over 18 versions. Its public plugin interfaces are declared pre-stable. Upstream accepts no external pull requests at present.

- **[G-11]** We keep our own fork on our own account, for our own use, and push nothing upstream. DSH's core may be changed when necessary.
- **[proposal]** The fork stays thin.
  - It starts with no core patch and pins one upstream release. The first core patch comes when a concrete need cannot be met by a plugin.
  - A core patch opens a seam (an option, a hook). Mission Pipeline's logic stays out of DSH's core. Each patch is listed with its file, its reason and the upstream version it was made on.
  - The edition's code lives in this repository, as plugins linked into DSH. **[fact]** Upstream's own gates (about 70 verify scripts, 100% coverage per file, paired English and Chinese READMEs) apply to packages inside its repository, not to linked ones.
  - Our own bundle sets the defaults: the default model, and the DeepSeek session-log upload, the desktop analytics and the telemetry turned off.
  - We follow upstream releases at our own pace, with its upgrade guides.
- **[fact]** What the edition relies on in DSH, each verified in source at that commit: a model per agent with no entitlement check, about 40 providers plus any OpenAI-compatible endpoint by configuration, and no DeepSeek account required; a sandbox mode per session whose write boundary follows the session's directory; tools registered for one agent only; one listener that can deny any agent's tool call with a text of our choosing; plugin code and its subprocesses outside the agent's sandbox; sessions created and woken by a plugin, with no idle eviction found; model calls outside an agent's turn; user-interface slots above the composer, in the session header and in the right sidebar; calls from the interface to the Host that an agent's tool call cannot make.
- **[fact]** Limits: the session controller, the preset registry and every interface slot exist only in the web-app bundle (Web and Desktop). Upstream's tests and benchmarks use DeepSeek models almost exclusively; no support level is stated for other families.

## 4. Mechanisms the maintainer has decided

### 4.1 The Historian (史官) [G-7, G-8, G-9]

- A new seat records and classifies the user's words. The PM no longer does; the PM's main duty, understanding the user's intent, is unchanged **[G-7]**.
- A small model classifies each message from a slice of recent context the program cuts. The user chooses the model **[G-7]**.
- The interface shows the classification for every message, and the user can object there **[G-7]**.
- Two kinds of objection **[G-8]**: the user knows the right class and sets it; or the user knows it is wrong but not where it belongs, and talks to the PM. That talk is not wasted context.
- The Historian only records and takes no instructions. In the second case the PM may call the Historian to change a record that is not yet in effect **[G-8]**.
- A record takes effect at the first of: the user's confirmation; the user's next message; five minutes after the message **[G-9]**.

Details **[proposal]**:

- A record the user objected to, or the PM changed, takes effect only on the user's confirmation. Without this, talking to the PM about a disputed record (a next message) would put it into effect under G-9 rule 1.
- A message classified as a one-off instruction takes effect at once, as in 4.3.
- The Historian shows and never asks. Objecting is always optional.
- When new words may replace earlier ones, the Historian proposes it and the user confirms. What then happens to the items resting on the earlier words goes to the PM.
- A record inside its buffer lives in the plugin's storage. Once in effect it is written through `mp`.
- The classification sits in a strip above the composer; a ledger tab in the right sidebar lists every entry. **[fact]** The slot on a user message carries no message id and is not drawn for a message sent while the agent runs.
- The engine needs two fields on a words entry: who classified it, and where the text came from. **[fact]** 4.3.0 stores neither, has no state for an entry not yet in effect, and has no read that shows earlier tags.

**[fact]** From the field record (§6): by the PM's own estimate recording and tagging take 3% to 5% of its context; of 186 entries none was ever superseded or re-tagged; the PM recorded messages it had to act on at once, not after the next message. The gain is therefore mostly a correct words base that the user can see, more than PM context.

### 4.2 Stop as a DSH mechanism [G-10]

- One action by the user freezes every runtime. The PM does not relay it and the Secretary does not stop seats one by one.
- It is not a truncation: every seat has its own instruction for what to do when frozen.
- The PM receives one message: stopped, and when.

Details **[proposal]**:

- Two layers. First, at once and without any model: the stop is written to the memory and a gate refuses every seat's next tool call. Second, the refusal's text is that seat's freeze clause, kept on its role page.
- **[fact]** A hand-back made while a stop holds is recorded, not accepted, and is never accepted later (engine/src/memory/domain/work.ts). The gate therefore refuses the hand-back too.
- **[fact]** A dispatch in flight that is not released survives a stop: after the stop is released its hand-back is accepted. The rule that every seat must be confirmed ended is in the handbook only.
- **[fact]** DSH has no suspended state. A seat whose turn ends is disposed and its session is kept; a message resumes it with its whole conversation.
- A long detached run is terminated, as in 4.3, after the stop button warns the user. Letting it finish with its result held needs an engine change.

**[fact]** From the field record: 6 stops in 21.6 days found 6 seats in flight in total, each losing 6 to 14 minutes of work; the pain was that the Secretary had to be woken and that processes outlived the stop. **[proposal]** The first version is therefore the gate, cancelling the seats, releasing their dispatches and cleaning up their processes. Freeze clauses per role and resuming a frozen seat in place come later. **This narrows G-10 and is the maintainer's to decide.**

## 5. Proposals not yet ruled

### 5.1 The loop run by a program, on DSH only

A driver outside `mp` asks for the ready steps, starts the seats, waits for hand-backs and releases a seat that died. It holds no process rule: what comes next always comes from `mp`. A Secretary instance is started only for what needs judgment.

On another harness the Secretary conversation keeps running the loop, made lighter by §5.5. Reason **[G-13]**: seats started there as headless processes would leave the interface, and the edition would have to manage process trees itself, which is building a harness. On DSH every seat is a session the user can open, and the driver knows what runs.

Who ends a process: the user tells the PM or presses stop; the stop is written to the memory; the driver ends the seats and records it. Neither the user nor the PM kills a process.

This changes the 4.3 ruling that the Secretary runs the dispatch loop (§9).

### 5.2 The Secretary: one short session per incident, with recorded field notes

Instead of one resident conversation. An incident may take several commands; the session ends with it and leaves its notes in the memory. Not settled by data: the field project never ran a one-shot Secretary. What the record shows **[fact]**: both the PM and the Secretary kept private notes outside the memory (83 KB and 834 KB); the Secretary's session was compacted 10 times and the PM's 24 times; 41% of the Secretary's rulings were "ask the PM". This changes the same 4.3 ruling (§9).

### 5.3 Seats on DSH

Each seat is its own DSH session, not a DSH subagent: **[fact]** a DSH subagent is disposed when idle and wakes its parent when it ends, and its manager offers no seam for either. The seat's model comes from config `fillers`, which becomes routing instead of a hint. The sandbox follows the role: reading seats read-only, a Constructor writing only its worktree. A seat's `mp` commands become tools bound to its dispatch.

### 5.4 Decisions routed by rule

A table in the engine sends an escalation to its decider when the source and recorded facts settle it; the Secretary sorts what needs reading, from a small card; what goes up to the PM carries a brief. A PM answer of the form "this kind is a detail" becomes a rule in the table.

### 5.5 Engine work for mainline first [G-12]

These help every harness. Facts are from 4.3.0 source.

1. **Rulings for one task.** **[fact]** A constraint's scope is a mission, paths and task types only, and every ruling needs an open escalation. Proposal: a ruling without an escalation, attached to a task or a lineage, versioned, citing words, shown in its own section of that lineage's cards.
2. **Only relevant content on a card.** **[fact]** Constraints are inline with no size limit; every decision item recorded after the plan took effect is printed on every task's card; the Secretary's `current-facts` repeats the constraints and holds every event of the task line in full. Proposal: decisions go only to the tasks they concern; `current-facts` becomes a digest, with the full line as optional reading.
3. **Holds.** **[fact]** Nothing blocks only the new dispatches of one task or lineage, and nothing is time-based. Proposal: a hold names its subject, its release condition (a task accepted, a time, or a release by hand), its reason and its words. It blocks dispatch only. A stop is not reused: it also refuses hand-backs, runs, delivery and landing.
4. **Obligations.** **[fact]** An acceptance with risk stores one sentence per escalation reason; nothing gates on it and only the close lists it. Proposal: one item per unmet standard or finding, with its owner and what it blocks; a read that lists the open ones at any time.
5. **A card settled when its seat starts.** **[fact]** A card is refreshed once at the claim and stored; no command renders it again; the ready list ignores open escalations; a release costs one of two re-dispatches whether or not the seat read its card. Proposal: a step whose card would carry a pending answer is not ready; the card is settled at the seat's first read; releasing a dispatch whose card was never read costs nothing.
6. **Smaller items.** Notes stay readable after their acknowledgement. A read gives the state per requirement item. Notices that only inform need no acknowledgement (**[fact]** no code gates on one). `--json` gains the filler hint, the exclusive resources and an estimate on a ready step.

## 6. Field evidence

**[fact]** From a survey of 2026-11-27 answered by the PM and the resident Secretary of one project on 4.3.0, read-only, on a copy of its memory. The answers are not in this repository.

- 21.6 days, 1 mission, 1,200 dispatches; one seat in flight 59% of the time seats ran.
- 303 escalations and 299 Secretary rulings; 41% ended as "ask the PM". The PM estimates that about half of its context goes to reading reports in order to rule.
- A card is 300,000 to 340,000 characters, about 80% of it constraints that do not concern the task; 169 constraints in 354 versions. 11 dispatches were released unstarted because the card was older than a ruling.
- 392 reviews: 64% asked for rework. Of 164 acceptances, 66 (40%) were with risk at the cap.
- `mp sec next` ran 2,237 times and took 2.5 to 7 minutes before the fixes of pull request 70.
- Holds and work order lived in notes and in the Secretary's own log; they were the first limit on parallel work.

The author's inference, not verified: the must-read material of a ruling is too large to have entered the Secretary's context each time, so a read receipt may show that a command ran, not that its output was read.

## 7. Concerns and risks

- **Sight and control [G-13].** The user must see at least as much as today, and it must be clear who ends a process. §5.1 answers this for DSH; it is the reason the driver is not proposed elsewhere.
- **Disk [G-13].** **[fact]** In 4.3 a Constructor's worktree is removed at its hand-back or at a release as ended, and kept at a release as abandoned; reading seats share one checkout per commit. Nothing in this document adds worktrees. What filled the disk in the earlier project is not yet known. Proposals: a hold when free space or the number of worktrees passes a limit; dependencies kept outside worktrees; a read that lists scratch by size, owner and age.
- **Other model families on DSH.** The Reviewer was the seat most sensitive to its model in the field, and DSH is barely tested beyond DeepSeek models.
- **Upstream churn.** Each upgrade costs in proportion to the DSH interfaces the edition uses. One plugin per concern keeps a break local.
- **Privacy defaults.** The upload of session logs on DeepSeek's official route and the desktop analytics are on by default upstream.
- **Not verified.** How long DeepSeek keeps a prompt cache, and whether it is shared across sessions.

## 8. Method [G-14]

The decisions above are written down first. Development then proceeds on real tasks, and the pipeline's shortcomings are read from them. A mechanism changes when a real task shows why.

Order of work **[proposal]**: the field fixes of pull request 70 on main; §5.5 items 1 to 3 in mainline; then the smallest DSH edition that can run a real task (a PM, seats, the stop); then the rest, in the order real tasks ask for.

## 9. What this would change in earlier rulings

| Earlier ruling | Change | Status |
|---|---|---|
| 4.3 F-6: every PM reply starts with its reading of the message type | The interface shows the Historian's classification | Decided, G-7 |
| 4.3 F-7: a message is recorded when the next message raises no objection | Three ways to take effect, with a five-minute buffer | Decided, G-9 |
| 4.3: only the PM records and tags the user's words | The Historian does; the PM may call it for a record not yet in effect | Decided, G-7, G-8 |
| 4.3: after a stop the Secretary stops and confirms each seat | One action on DSH freezes everything | Decided, G-10; scope of the first version pending (§4.2) |
| 4.3 F-2: the Secretary is a resident conversation that runs the dispatch loop and starts the seats | A program runs the loop on DSH (§5.1); the Secretary works per incident (§5.2) | Proposal |
| 4.1 U-1: no implementation depends strongly on one model or harness | Kept for the memory and for the model. This branch depends on DSH | Decided, G-6 |
| 4.1: `mp` starts no seats and runs no service | Unchanged. The driver is outside `mp` and uses only its commands | Proposal |

## Appendix A: candidate philosophy of 4.3.0

The author's extraction; not reviewed by the maintainer (§2.1). The rulings each rests on are in parentheses.

Responsible to the user
1. Results are responsible to the user. The PM is the user's anchor and keeps long automated work from drifting. (F-1)
2. The user's recorded words are the root of authority. Requirements quote them. Words lose force by supersession, the end of their scope or being one-off, never by time. (F-7, F-8, F-9)
3. Where the user decided, their words settle it. Every stop has an exit the user's words can take. (E-1, E-2, E-5)
4. The user guides direction and never accepts details. Only the most important decisions reach the user. (U-10, D-9, D-12)
5. Closing is never blocked. The record says what is proven, not proven, unfinished and at risk. (D-11)

Proof
6. Proof is the program's: evidence is reproducible and hashed. The program never judges in a seat's place, and the user's say is never called proof. (U-15, U-16, E-4)
7. Each role answers for its own scope. Full proof sits at integration, and a failure returns to the task that caused it. (D-4 to D-7) *May be mechanism.*
8. A task whose acceptance cannot be written in advance is accepted by surviving attack. A Stabilizer guards against drift, and the end is judged by state, not by rounds. (U-6, U-7, E-3)

Seats
9. A seat is a role. Whoever fills it can be replaced at any time and is recorded as information only. (U-1, U-5)
10. A seat knows only its direct upstream and downstream. (4.0 principles 5 and 6)
11. The anchor and the operator are separate. Field matters are decided within the plan. Decisions outlive a session. (F-1 to F-5)

Memory
12. The memory is neutral: any harness can rebuild the project from the folder alone. (U-2, G-6)
13. The database is the skeleton and Markdown the leaves. Details are pointed to, not stored. (U-13, U-14)
14. One guarded way to read and write the memory, with a command set per role. (U-3, U-9)

Limits and measure
15. Security, logins and spending are the harness's business. (U-3)
16. Mostly correct is enough. An edge case gets detection, a safe default and a work instruction, not a new mechanism. Execution redundancy is cut first. (D-1 to D-3, U-8)
17. A stop takes effect at once, before anything else. *No standalone quote of the maintainer was found for this one.*
