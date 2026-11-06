# Mission Pipeline 4.3: the PM as the user's anchor, the Secretary as the resident operator

Status: v01, 2026-11-06. Aligned with the maintainer in conversation on 2026-11-06; rulings F-1 to F-9 are the maintainer's, items marked *(detail)* are the author's. E-1..E-5 and D-1..D-12 still hold. Builds on 4.2.0 (`engine-4.2.0`). Records written by 4.2.0 and earlier must fold with no migration; new record kinds are allowed only as additions.

## 1. Why

Mission Pipeline exists so that agents produce results that are responsible to the user. In 4.1–4.2 the PM is the user's conversation **and** the dispatcher: it runs `mp pm next`/`dispatch`, starts every seat, reads every notice and WI page, releases dispatches and handles exceptions. Field PMs came to see themselves as the scheduler and used the Secretary rarely. The tool calls and seat reports fill the PM's context and dilute the one thing only the PM can hold: an understanding of the user's logic and needs, from which it keeps the project from drifting during long automated work. At the same time the Secretary, a fresh one-shot instance per escalation, has neither the field's detail context nor the authority to act on it.

4.3 inverts this: the PM is the anchor; the Secretary is a resident operator that absorbs the dispatch detail and decides most field matters; decisions rest on the recorded user's words, not on one session's context.

## 2. Rulings (the maintainer's)

- **F-1 The PM is the anchor, not the dispatcher.** The PM aligns with the user, records their words, writes the results-level plan, decides the big questions on the recorded user's words, handles stops and consent to deliver, and answers the user's progress questions. It does not dispatch seats, read notices or WI pages, release dispatches or handle exceptions.
- **F-2 The Secretary is a resident conversation, started by the PM, named `<project>-Secretary`** (for example `DIVRA-Secretary`). It runs the dispatch loop, starts the seats, handles every notice, WI page and exception, and decides everything within the plan. It rarely reports progress. It answers questions but takes no instructions: instructions go through the PM. The user finds it with their harness (for example `claude --resume` or the desktop app).
- **F-3 Who decides.**
  - The Secretary decides everything within the plan: technical choices, reworks, reruns, grants within its budget. When unsure: reversible → decide; irreversible → escalate.
  - To the PM: plan-structure changes (adding or dropping tasks or deliverables, interfaces between modules, data formats or storage) and the three classes that went to the user before (a change to what the user gets; an irreversible step outside the project; a conflict with what the user said).
  - The PM decides when the recorded user's words support a choice; when they do not and the impact on the project is major, it asks the user.
- **F-4 Contact.** The PM contacts the Secretary only when the user asks for progress details or gives a new instruction. The Secretary contacts the PM only with a decision that is the PM's. The memory is the channel of record; a harness message that wakes the other session is optional.
- **F-5 When no PM session is open, questions for the PM wait** (the PM is usually the user's main conversation; closing it means the user left or paused). Work that does not wait on such a question continues.
- **F-6 The reply format.** At the top of every reply the PM shows its reading of the user's message type, for example "Type: principle" (in the user's language); a composite message lists its parts ("Type: decision (the recording rule) + agreement (the expiry rule)").
- **F-7 Deferred recording.** A message is recorded only when the user's next message raises no objection to its type; the last message of a discussion is therefore not recorded (accepted cost). One-off instructions (stop, an answer, consent to deliver, start) are recorded on the spot, because the action cites them. A misjudged type may be changed with the user's authorization. A message confirmed as unrelated (for example "write me an email") is never recorded.
- **F-8 Words lose force by supersession, scope end, or being one-off** — never by calendar time.
- **F-9 Layered loading.** Layer 1, read at every PM session start, bounded: the principles in force, the open missions' requirements and decisions in force, what waits on the PM or the user, status layer 0. Layer 2, by subject. Layer 3, the verbatim text by `W-<n>`. Old untyped words are not tagged at upgrade; the PM tags one when it becomes relevant.

## 3. Roles after 4.3

| | PM (the user's session) | Secretary (`<project>-Secretary`, resident) |
|---|---|---|
| Talks to | the user; the Secretary only per F-4 | the PM per F-4; seats through cards |
| Records | the user's words (F-6/F-7), requirement items, constraints, PM plan batches, its own and the user's decisions, stops, deliveries and landings | its decisions on escalations, dispatch claims and releases |
| Reads | layer 1 at session start; status layer 0/1, `blocked`, `show` on the user's request | notices, WI pages, ready steps, cards, everything operational |
| Decides | F-3's PM class, on the recorded words; otherwise asks the user | everything within the plan (F-3) |
| Never | dispatches, reads notices/WIs, handles exceptions | takes an instruction; decides an F-3 PM-class question; writes the user's words |

## 4. Mechanics

### 4.1 Commands *(detail)*
- New group **`mp sec`** (alias `mp secretary`) for the Secretary's loop: `session`, `next`, `dispatch`, `release`, `drain`, `renew`, `alerts`, `wait`, `decide`, `ask-pm`, `note`. `next`, `dispatch`, `release`, `drain`, `renew`, `alerts` are today's `mp pm` loop commands moved as they are.
- `mp pm next`, `dispatch`, `release`, `drain`, `renew`, `alerts` stay as **older names for one release**: they work, and print the `mp sec` form and the 4.3 role split. A project that has not started a Secretary still works the 4.2 way (a field run mid-mission keeps going).
- **`mp sec wait [--timeout <s>]`** blocks until something the Secretary acts on changes (a hand-back, a new ready step, a notice, a PM note, a decision of the PM, a stop) or the timeout passes, and prints what changed. It lets a resident loop sleep without polling, in any harness.

### 4.2 The Secretary session *(detail)*
- `mp sec session --name <project>-Secretary --filled-by "<harness>/<model>"` records a **`secretary.session`** record (new kind). One live Secretary per project: a second `session` is refused while one is live, unless `--replace` (records the old one as retired). Nothing authenticates the caller (as today for the PM); the record is the claim, and attribution of `mp sec` commands uses the latest Secretary session (attribution of `mp pm` commands uses the latest PM session; today both use the project's latest session).
- The project name is config `projectName`, default the project folder's name.
- **Starting it.** `mp pm secretary start` prints the exact launch for the PM's harness and the Secretary's fixed prompt ("You are `<project>-Secretary`, the resident Secretary of Mission Pipeline. Your handbook: `mp sec handbook`. Run `mp sec session …`, then loop on `mp sec next` / `mp sec wait`."). For Claude Code (verified 2.1.319): `claude --bg -n "<project>-Secretary" "<prompt>"` (a background session the user can `claude attach` or `--resume`). Other harnesses: the README's harness notes. The PM runs it once per project, and again only to replace a Secretary that is gone (`mp read secretary` shows the live session and its last action time).
- The Secretary's handbook (`.mission-pipeline/secretary/SECRETARY.md`, new) holds the loop, the interrupted-dispatch rules, the exception sections and the WI index that are in PM.md today. The WI pages keep their ids and path (`pm/wi/`) and address the Secretary.

### 4.3 Escalations and decisions *(detail)*
- Escalations are raised as today (`raiseEscalation`, line `secretary`). The resident Secretary decides one with **`mp sec decide <escalation> …`**, which claims the escalation's `sec.<id>` step for the resident session and hands it back with the given fields: the same card (`mp sec card <escalation>`, `mp sec read <escalation> <material>`), the same validation (offered option, authorization, classification, grant limit, must-read), the same `carryOut` and ruling judgment `j.sec.<id>`. Records do not change shape; the dispatch's filler names the resident session.
- Classification: `detail` (recorded, mark `may matter` when the user might care), `important-within-authority` (kept: a recorded authorization covers a PM-class question), and **`needs-pm`** with the new option **`ask-pm`**: related work waits for the PM. `needs-user`/`ask-user` in records already written read as before and are routed to the PM.
- If no resident Secretary is live, an escalation's `sec.<id>` step is listed like any ready step and may still be dispatched to a one-shot Secretary seat (4.2 behaviour).
- **The PM decides on words:** `mp pm answer <mission> <escalation> --option … --by pm --words W-a[,W-b…] --reason "<why these words settle it>"` records a decision **by `pm`** (ruling judgment `j.pm.<id>`, through `deciderJudgment`). `--by user --words W-n` (the default, today's form) records the user's own decision. Reads say which: "decided by the PM on W-12, W-30: …" vs "decided by the user (W-45)". The program never decides: `--by pm` needs at least one words entry and a reason.
- The Secretary's grant budget per lineage stays one grant of 1–2; after it, further grants are the PM's (`mp pm grant --by pm --words …`) or the user's.
- Every path that routes "to the user" today (`routeDecision`, exploration direction questions, `needs-user-decision`, `loop-exhausted-needs-user`) routes to the PM, who asks the user when F-3 says so.

### 4.4 The channel between them *(detail)*
- **Secretary → PM:** an `ask-pm` escalation is listed in **`mp pm inbox`** (new) and at the head of the PM's layer 1; `mp read status` layer 0 counts it. The Secretary may also wake the PM through its harness (Claude Code: a message to the PM's session) with one line naming the inbox; it never sends progress.
- **PM → Secretary:** `mp pm note "<text>" [--words W-n]` records a **`pm.note`** (new kind) that `mp sec next`/`wait` show first ("From the PM"). The PM writes one after a new instruction changes the work (a requirement, a constraint, a re-plan, a repair, a stop), and may wake the Secretary through its harness. Progress details: the PM asks the Secretary in the harness conversation; the answer is not a record.
- **Stops:** `mp pm stop` takes effect in the memory at once (as today: claims, acceptances, deliveries, runs refused; detached runs signalled). It records a note to the Secretary, and prints that the Secretary must stop its running seats; `mp sec next`/`wait` return at once with the stop and the in-flight dispatches in its scope. The PM wakes the Secretary through its harness when it can. *Residual:* a seat in a long command that never calls `mp` keeps running until the Secretary acts; its results are fenced as today (`after-stop`).
- **Cursors and notice delivery:** notices are delivered to the Secretary (`mp sec next`); the PM never acknowledges them. The read cursor becomes per role (`asked` for the PM, `asked.sec` for the Secretary), so a Secretary's status read never advances the user's "since you last asked".

### 4.5 The user's words *(detail)*
- **Tags.** A words entry carries tags: `principle` (project-wide), `decision` (mission or project scope), `requirement` (a mission; the requirement items carry the effect, as today), `instruction` (one-off; never in layer 1). Each tag may quote the part of the message it covers (the quote must occur verbatim). `mp pm say --file <f> --tag <type>[@<mission>][:"<quote>"] … [--supersedes W-k,…]`. Unrelated messages are not recorded (F-7).
- **Deferred recording is the PM's discipline, not the program's** (the program sees a message only when the PM records it): the handbook core says: show the type line (F-6); record a one-off instruction at once; record any other message when the user's next message raises no objection (`mp pm say --file`, verbatim, the previous message); a message the user corrects is recorded with the corrected type.
- **Re-tag:** `mp pm retag W-n --tag … --words W-m` appends a **`user.words-tags`** record (new kind) authorized by the user's words W-m; the original tags stay as history. Any earlier entry may be re-tagged this way (e.g. a mission requirement found to be a principle before its mission closes).
- **Force (F-8):** an entry's tag is in force until a later entry supersedes it (`--supersedes`, or a re-tag that withdraws it), its scope ends (the mission closes), or it is one-off. A withdrawn principle needs the user's words.
- **The hook.** The optional Claude Code `UserPromptSubmit` hook no longer records the message. It prints, for the PM session only, a two-line reminder: show the type line; record the previous message if the user raised no objection. It prints nothing in the Secretary's session (the session the Secretary records with `mp sec session`, or an environment variable set by the launch).

### 4.6 Layered loading (F-9) *(detail)*
- **Layer 1:** `mp pm session` prints, after the handbook core: the principles in force; for each open mission its requirement items in force and decisions in force (the words tagged `decision` and the decisions by the PM or the user); what waits on the PM (inbox) and on the user; status layer 0. One line each with its `W-<n>` or item id. Bounded at 8 KiB: past it, the oldest lines collapse into counts with the read that lists them, and the PM is told to consolidate (merge duplicate principles under a new entry that supersedes them, citing all their `W-<n>`; meaning unchanged).
- **Layer 2:** `mp read words [--tag <type>] [--mission <m>] [--in-force|--all] [--grep <text>] [--untyped]`.
- **Layer 3:** `mp read show words W-<n>` (exists).

## 5. What does not change
- The memory, the single writer and its guards; seats and their cards; the Calibrator, Architect, Reviewer, Researcher, Crititor, Stabilizer, Auditor; proof labels; delivery and landing; E-1..E-5, D-1..D-12.
- The program never writes a judgment in its own name (rulings by `secretary`, `pm` or `user` only, through `deciderJudgment`).
- Every stop keeps an exit the user's words can take (E-1).

## 6. Compatibility
- New record kinds only: `secretary.session`, `pm.note`, `user.words-tags`; new decider `pm` (judgment ids `j.pm.<id>`); new option `ask-pm` and classification `needs-pm`. Records of 4.2.0 fold unchanged; their `ask-user`/`needs-user` escalations route to the PM.
- A project with no Secretary session keeps the 4.2 loop (older command names). The PM handbook tells the PM to start the Secretary at its next session start.
- `mp docs update` installs the new handbooks; the PM reads the new core.

## 7. Tests to add
- The loop under `mp sec`, the older `mp pm` names printing the new form; one live Secretary (`--replace`); attribution per role; `mp sec wait` waking on each event kind and on the timeout.
- `mp sec decide` = a Secretary hand-back (same validation, same records, filler = resident session); `ask-pm` routes to `mp pm inbox`; `mp pm answer --by pm` (ruling `j.pm.<id>`, reads show "by the PM on …"), `--by user` unchanged; 4.2 `ask-user` records route to the PM.
- `pm.note` shown first by `mp sec next`/`wait`; a stop returns `wait` at once with in-scope in-flight dispatches.
- Tags, quotes, supersession, re-tag with words, layer-1 content and the 8 KiB bound, `mp read words` filters; old untyped entries absent from layer 1.
- The hook: no recording; reminder in the PM session only.
- Per-role cursors.

## 8. Verify first
- Claude Code: `claude --bg -n <name> <prompt>` from the PM's shell starts a resident session that can start sub-agents (Agent tool) and run `mp`; the two sessions can message each other by name; `claude attach`/`--resume` reach it.
- Codex and other harnesses: what "resident" and "wake" mean there (README harness notes).
