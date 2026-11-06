# Mission Pipeline 4.3: the PM as the user's anchor, the Secretary as the resident operator

Status: v02, 2026-11-06 (v01 + attack round 1, `engine/scratch/pmsec/attack-r1.md`: all fatal and serious findings taken in). Rulings F-1 to F-9 are the maintainer's (aligned in conversation on 2026-11-06); items marked *(detail)* are the author's. E-1..E-5 and D-1..D-12 still hold. Builds on 4.2.0. Records written by 4.2.0 and earlier fold with no migration; new record kinds are additions only.

## 1. Why

Mission Pipeline exists so that agents produce results that are responsible to the user. In 4.1–4.2 the PM is the user's conversation **and** the dispatcher: it runs the loop, starts every seat, reads every notice and WI page, releases dispatches and handles exceptions. Field PMs came to see themselves as the scheduler and used the Secretary rarely. Tool calls and seat reports fill the PM's context and dilute what only the PM can hold: an understanding of the user's logic and needs, from which it keeps the project from drifting during long automated work. The Secretary, a fresh one-shot instance per escalation, has neither the field's detail context nor the authority to act on it.

4.3 inverts this: the PM is the anchor; the Secretary is a resident operator that absorbs the dispatch detail and decides most field matters; decisions rest on the recorded user's words, not on one session's context.

## 2. Rulings (the maintainer's)

- **F-1 The PM is the anchor, not the dispatcher.** It aligns with the user, records their words, writes the results-level plan, decides the big questions on the recorded user's words, handles stops and consent to deliver, and answers the user's progress questions. It does not dispatch seats, read notices or WI pages, release dispatches or handle exceptions.
- **F-2 The Secretary is a resident conversation, started by the PM, named `<project>-Secretary`** (e.g. `DIVRA-Secretary`). It runs the dispatch loop, starts the seats, handles every notice, WI page and exception, and decides everything within the plan. It rarely reports progress. It answers questions but takes no instructions: instructions go through the PM. The user finds it with their harness (e.g. `claude --resume`, the desktop app).
- **F-3 Who decides.** The Secretary: everything within the plan (when unsure: reversible → decide; irreversible → escalate). The PM: plan-structure changes (adding or dropping tasks or deliverables; interfaces between modules; data formats or storage) and the three classes that went to the user before (a change to what the user gets; an irreversible step outside the project; a conflict with what the user said). The PM decides when the recorded user's words support a choice; when they do not and the impact on the project is major, it asks the user.
  - *Gap found by the attack, pending the maintainer:* a PM-class question with minor impact and no supporting words. **Default until the maintainer rules (detail):** the PM decides it, recorded as "by the PM, no words on record", with its reason; layer 1 and status show it so the user can overrule.
- **F-4 Contact.** The PM contacts the Secretary only when the user asks for progress details or gives a new instruction; the Secretary contacts the PM only with a decision that is the PM's. The memory is the channel of record; a harness message that wakes the other session is optional.
- **F-5 When no PM session is open, questions for the PM wait.** Other work continues.
- **F-6 The reply format.** The top of every PM reply shows its reading of the user's message type (in the user's language); a composite message lists its parts.
- **F-7 Deferred recording.** A message is recorded when the user's next message raises no objection to its type (the last message of a discussion is not recorded: accepted). One-off instructions (stop, an answer, consent to deliver, start) are recorded on the spot, with all the message's tags. A misjudged type may be changed with the user's authorization. A message confirmed as unrelated is never recorded.
- **F-8 Words lose force by supersession, scope end, or being one-off** — never by calendar time.
- **F-9 Layered loading.** Layer 1 at every PM session start (bounded); layer 2 by subject; layer 3 verbatim. Old untyped words are not tagged at upgrade; the PM tags one when it becomes relevant.

## 3. Roles after 4.3

| | PM (the user's session) | Secretary (`<project>-Secretary`, resident) |
|---|---|---|
| Talks to | the user; the Secretary only per F-4 | the PM per F-4; seats through cards |
| Records | the user's words, requirement items, constraints, PM plan batches, PM and user decisions, stops, deliveries and landings, notes and questions to the Secretary | its decisions, dispatch claims and releases, replies to the PM, stop confirmations |
| Reads | layer 1 at session start; its inbox; status layer 0/1, `blocked`, `show` on the user's request; layer 2 before deciding | notices, WI pages, ready steps, cards, everything operational |
| Decides | F-3's PM class, on the recorded words; otherwise asks the user | everything within the plan |
| Never | dispatches, reads notices/WIs, handles exceptions, runs the loop's reconciliation | takes an instruction; decides a PM-class question; records the user's words |

## 4. Mechanics *(detail, unless a ruling is cited)*

### 4.1 The Secretary session and its generation
- `mp pm secretary start` creates a **Secretary generation** `S-<n>` (record `secretary.generation`, new) and prints the launch for the PM's harness with the environment `MP_ROLE=secretary MP_SECRETARY=S-<n>` and the fixed prompt ("You are `<project>-Secretary`, the resident Secretary of Mission Pipeline. Your handbook: `mp sec handbook`. Run `mp sec session`, then loop on `mp sec next` / `mp sec wait`."). Claude Code (2.1.319, to verify, §8): `MP_ROLE=secretary MP_SECRETARY=S-<n> claude --bg -n "<project>-Secretary" "<prompt>"`; the environment of the launch reaches every command of that session. The PM records the harness handle it gets back (`--handle <id>`, e.g. the `--bg` id) so it can stop or replace that session later.
- `mp sec session` (run by the Secretary) claims the generation named in `MP_SECRETARY`. **Every `mp sec` command requires the live generation** (from `MP_SECRETARY` or `--as S-<n>`); a retired or unknown generation is refused with `NOT_ALLOWED`. `mp pm secretary start` while a generation is live is refused unless `--replace`, which retires the old generation in the same write: from then on the old session's commands are refused, so it cannot drive the loop again.
- The project name is config `projectName`, default the folder name. `mp read secretary` shows the live generation, its name, harness handle, claim time and last command time.
- **One driver.** While a generation is live, the 4.2 loop names under `mp pm` (`next`, `dispatch`, `release`, `drain`, `renew`, `alerts`) refuse, naming the Secretary. With no live generation they work as in 4.2 (a project that has not started a Secretary, or a field run mid-mission). A Secretary started while the PM's own 4.2 dispatches are in flight adopts them: they are listed by `mp sec next` like its own, and their seats keep running in the PM's harness until they hand back.
- **The PM's commands no longer reconcile in resident mode.** While a generation is live, a PM command (plan submit, requirement, constraint, answer, repair, waive, grant, …) commits its change and a wake record (§4.4) and does not call `advance`; the Secretary's next `next`/`wait` reconciles. In 4.2 mode they reconcile inline as today.

### 4.2 The loop: `mp sec`
- `mp sec next`, `dispatch`, `release`, `drain`, `renew`, `alerts` are today's loop commands, unchanged in what they do. `mp sec next` prints, in this order: stops and their owed cancellations (§4.4), notes and questions from the PM, decisions of the PM taking effect, notices, ready steps, in-flight dispatches, ended detached runs, and the revision it read (`rev R`).
- **`mp sec wait --since R [--timeout <s>]`** returns at once if anything the Secretary acts on changed after `R` (a hand-back, a ready step, a notice, a note or question, a PM decision, a stop), otherwise blocks until such a change or the timeout (default 300 s), and prints the new revision. While blocked it runs the periodic checks that today happen only when someone calls `next` (detached-run liveness, label batches, landing recovery) every 30 s, so a lost worker or a pending label batch still wakes it. A stop wakes it at once.
- **Notices:** delivered to the Secretary. Every notice category has an **audience**: `secretary` (default) or `pm` (table in §4.5). `listNotices` pages pending notices independently of acknowledged history (no 500-record window hides an unresolved one).
- **Cursors:** per role. `mp read status` advances `asked` only for the PM; the Secretary reads with its own cursor `asked.sec`.

### 4.3 Decisions
- **The Secretary's decision lifecycle:** `mp sec card <escalation>` claims the escalation's `sec.<id>` step for the live generation (idempotent: the same claim on retry), creating dispatch D, and prints the card; `mp sec read <escalation> <material> [--page n]` records reads against D; `mp sec decide <escalation> …` hands D back with the decision's fields. Same card, same validation (offered option, authorization, classification, grant limit, must-read), same `carryOut`, ruling `j.sec.<id>`. A generation replaced mid-decision leaves D in flight; the new generation releases it (`--ended`) and claims afresh.
- **Classifications** for new decisions: `detail` (with `may matter`) and **`needs-pm`** with option **`ask-pm`**. `important-within-authority` is no longer offered: a PM-class question always goes to the PM, and an authorization is words the PM decides on (F-3). Old records with `important-within-authority`, `needs-user` or `ask-user` read as before.
- **Options alias.** `ask-pm` and `ask-user` are one option: a stored option list holding either accepts both in a hand-back, a refreshed card shows `ask-pm`, and both route to the PM. Queued and claimed 4.2 Secretary steps keep working across the upgrade.
- **The PM's decision:** `mp pm answer <mission> <escalation> --option … --by pm --words W-a[,…] --reason "…"` (or `--no-words --reason "…"` for the F-3 gap default) records a **`pm-answer`** (new flow event on the secretary line) and its ruling `j.pm.<id>`. `--by user --words W-n` records the user's own decision as today (`user-answer`). **Precedence:** a user answer supersedes a PM answer that has not been applied yet (the apply step reads the user answer first, inside the write); once a PM answer is applied, a contrary user decision is a new decision through the exits E-1 gives (a repair, a re-answer of a new escalation), never an edit.
- **Decider everywhere.** `pm` is a decider in every writer that today knows `secretary` and `user`: `carryOut`, `deciderJudgment`, task and exploration application, grants, risk descriptions, decision journals, reads (`why`, tree, close). A PM grant does not consume the Secretary's one grant per lineage, and is not refused by it.
- **Grants:** the Secretary keeps one grant (1–2) per lineage; after it, grants are the PM's (`mp pm grant --by pm --words …`) or the user's.
- **Routing:** every path that routes "to the user" today (`routeDecision`, exploration direction questions, `needs-user-decision`, `loop-exhausted-needs-user`, a failed Secretary seat's program-authored `ask-user`) routes to the PM's inbox. The PM asks the user when F-3 says so and marks the item **`mp pm inbox --asked-user <item> --words W-n`** (the words of its question are not needed; the record names the reply it waits for), so it reads "waits on the user" until the user's answer is recorded.

### 4.4 The channel between them
- **Memory first, wake-up optional.** Every exchange is a record with a state; harness messages only wake the other side.
- **PM → Secretary:**
  - `mp pm note "<text>" [--words W-n]` (`pm.note`, new): after a new instruction changes the work. `mp sec next` shows it until the Secretary acknowledges it (`mp sec ack-note <id>`).
  - `mp pm ask-secretary "<question>"` (`pm.question`, new) for the user's progress details; `mp sec reply <id> "<text>"` (`sec.reply`, new); `mp pm inbox` shows the reply. States: open, answered.
- **Secretary → PM:** the **PM inbox** (`mp pm inbox`): `ask-pm` escalations; notices whose audience is `pm` (§4.5) with the PM action each needs and its resolution condition; replies to the PM's questions. Each item stays until resolved (a PM or user answer, the named PM command, or `--asked-user` then the answer).
- **Wake records:** a PM command in resident mode, a note, a question or a stop writes the change; `mp sec wait` returns on it. The PM may also message the Secretary's session through its harness; the Secretary may message the PM's session with one line naming the inbox, never with progress.
- **Stops.** `mp pm stop` takes effect in the memory at once (claims, acceptances, deliveries, runs refused; local detached workers signalled, as today) and records, for every in-flight dispatch in its scope, a **cancellation owed** (`stop.owed`, new) naming the dispatch and the generation that claimed it (or the PM, for 4.2-mode dispatches). The owner confirms each by stopping the seat in its harness and running `release <D> --ended` (`stop.confirmed` follows from the release). Layer 0 and the PM's layer 1 show owed cancellations until confirmed. `mp sec wait` returns at once on a stop.
  - **Fallback when the Secretary is gone** (its generation shows no command for longer than the stop's grace, default 60 s, or the user says it is gone): `mp pm secretary stop` prints the harness command that stops the Secretary's session by its recorded handle (Claude Code: `claude stop <handle>`; seats started as its sub-agents end with it), records the generation retired, and the PM releases the owed dispatches `--ended` once the harness confirms. A harness whose seats outlive their parent session is named in the harness notes with its own stop command.

### 4.5 Notice audiences
- `pm`: `calibrator-1-returned` (the PM's plan came back: revise it with the user or resubmit), `calibrator-1-unavailable`, `plan-revision-restarts-work` (tell the user what will be redone), `exploration-converged` and `exploration-no-conclusion` when the conclusion is direction-type (as routed today), `needs-user-decision` and every routed-to-user item (§4.3), the end of a mission (report to the user; ask consent to deliver), `legalization-*` results the user asked for, `plan-constraint-gap` (WI-34: its exits take the user's words).
- `secretary`: everything else. A category not in the table is the Secretary's. The table lives in one module; each `pm` entry names the PM action and its resolution condition.

### 4.6 The user's words
- **Tags** (stable ids `W-<n>#<k>`): `principle` (project), `decision` (`@<mission>` or project), `requirement` (`@<mission>`; requirement items carry its effect, as today), `instruction` (one-off). A tag may quote the part of the message it covers (verbatim). `mp pm say --file <f> --tag <type>[@<mission>][:"<quote>"] … [--supersedes W-<n>#<k>,…]`.
- **Recording boundary (F-7):** a message with an `instruction` tag is recorded at once with all its tags (the user's ruling for composites; a wrong tag is fixed by re-tag). Any other message is recorded when the user's next message raises no objection; commands that cite words (`requirement add`, `constraint add`, `plan submit`, …) for that message wait until then, which the handbook states. The program sees only what the PM records.
- **Supersession and authority:** `--supersedes` lists the requirement items, constraints and authorizations resting on the superseded tag and requires the PM to say, in the same command, which it withdraws (`--withdraw-items …`) and which stand (`--keep-items …`); nothing is withdrawn implicitly. Pending decisions that relied on a withdrawn item are re-checked as today (`decisionAuthorityCurrent`). Scope end: a mission's tags leave layer 1 when the mission closes; its items and history are unchanged. Historical provenance and completed proof never change.
- **Tagging an untyped entry:** `mp pm tag W-<n> --tag …` gives a 4.2 entry its first tags (the PM's reading; the reply's type line shows it). **Re-tag:** `mp pm retag W-<n>#<k> --tag … --words W-<m>` changes an assigned tag with the user's authorization. Both append `user.words-tags` (new); the earlier tags stay as history.
- **The hook:** the optional Claude Code `UserPromptSubmit` hook no longer records. With `MP_ROLE` unset (the PM's session) it prints a two-line reminder (type line; record the previous message if the user raised no objection). With `MP_ROLE=secretary` it prints nothing.

### 4.7 Layered loading (F-9)
- **Layer 1** (`mp pm session`, after the handbook core): the principles in force; project decisions in force; project constraints in force; for each open mission its plan in effect (id), requirement items in force, decisions in force (decision tags and decisions by the PM or the user); the PM inbox; owed cancellations; what waits on the user; status layer 0. One line each with its id. **Principles are never collapsed.** Past 8 KiB, the oldest mission-scoped lines collapse into counts with the read that lists them, and the PM is told to consolidate: a **summary** (`words.summary`, new: the PM's text, citing every `W-<n>#<k>` it covers) shows in layer 1 in place of the lines it covers. The covered tags stay in force; a summary is never a user's words and is never cited as one.
- **Before deciding**, the PM reads layer 2 for the subject (handbook rule; `mp pm answer --by pm` prints the layer-2 entries for the escalation's mission and subject it did not cite, as a check).
- **Layer 2:** `mp read words [--tag <type>] [--mission <m>] [--in-force|--all] [--grep <text>] [--untyped]`. **Layer 3:** `mp read show words W-<n>`.

## 5. What does not change
- The memory, the single writer and its guards; seats and their cards; Calibrator, Architect, Reviewer, Researcher, Crititor, Stabilizer, Auditor; proof labels; delivery and landing; E-1..E-5, D-1..D-12.
- The program never writes a judgment in its own name (rulings by `secretary`, `pm` or `user` only, through `deciderJudgment`).
- Every stop keeps an exit the user's words can take (E-1).

## 6. Compatibility
- New record kinds: `secretary.generation`, `pm.note`, `pm.question`, `sec.reply`, `stop.owed`, `user.words-tags`, `words.summary`; new flow event `pm-answer`; new decider `pm` (`j.pm.<id>`); option `ask-pm` (alias of `ask-user`); classification `needs-pm`. 4.2 records fold unchanged.
- A project with no live generation keeps the 4.2 loop; the PM handbook says to start the Secretary at the next session start with no PM dispatch in flight (or let them be adopted).
- `mp docs update` installs the new handbooks; the PM reads the new core.

## 7. Tests to add
- Generations: start, claim, `--replace` retiring the old (its commands refused), 4.2 loop names refused while live and working when not, adoption of 4.2 in-flight dispatches, attribution per role.
- Resident mode: PM commands commit without reconciling, and wake `wait`; `wait --since` returns at once on a change after R, blocks otherwise, wakes on each event kind, a lost detached worker and the timeout.
- Decisions: card → read → decide lifecycle with interruption and replacement; must-read enforced; `ask-pm`/`ask-user` alias across queued, claimed and refreshed 4.2 steps; `needs-pm` to the inbox; `pm-answer` (with words, with `--no-words`), ruling `j.pm.<id>`, user precedence before application; PM grants not consuming the Secretary's; `pm` in exploration application, risks, journals and reads; `--asked-user`.
- Channel: notes acknowledged; questions and replies; inbox items per `pm` audience category and their resolution.
- Stops: owed cancellations, confirmation by release, the gone-Secretary fallback.
- Notices: audiences; paging beyond 500 acknowledged records.
- Words: tags with ids and quotes, instruction-on-the-spot, supersession requiring withdraw/keep, scope end, `tag` for untyped, `retag` with words, summaries, layer-1 content and bound (principles never collapsed), `mp read words` filters.
- Hook: no recording; reminder only with `MP_ROLE` unset. Per-role cursors.

## 8. Verify first
- Claude Code 2.1.319: `claude --bg -n <name> <prompt>` from the PM's shell starts a resident session that inherits the launch environment, can start sub-agents and run `mp`; its sub-agents end with it (`claude stop`); the two sessions can message each other; `claude attach` / `--resume` reach it.
- Other harnesses: what resident, wake and stop mean (README harness notes); nothing in the engine requires Claude Code.
