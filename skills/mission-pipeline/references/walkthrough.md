# Walkthrough — one mission, end to end

This is a complete single-task mission through the public CLI in local mode, in the order the requests actually happen, followed by the mid-mission upgrade path from a 1.2 deployment and the recovery commands. It is the document to read before operating a real ledger. `references/runtime-v4.md` is the full contract; this is the worked example.

Two conventions for every command below:

```text
SKILL=/absolute/path/to/skills/mission-pipeline
PROJECT=/absolute/path/to/your/project
python "$SKILL/scripts/mp" --root "$PROJECT" --actor <role> api --request-file <file>
```

Arbitrary text travels as JSON in a file or on stdin, never as shell words. `--stdio` reads the same object from standard input. Every mutation needs a stable `request_id`: if a response is uncertain, resend the same id, or ask for its committed result with `{"action":"receipt","data":{"request_id":"..."}}`. All output is one UTF-8 JSON object, and a refusal is `{"ok":false,"code":...,"detail":...}` with exit code 3.

Where an id comes from is stated at every step. Ids you supply yourself (`"id":"..."`) are yours to choose; ids the engine returns are the only valid way to name what it created.

## Part 1 — a single-task mission in local mode

The mission: the principal wants a usable report, and has delegated the method. One task writes a verification script, runs it under the frozen-input executor, and the run exports `report.txt`.

### 1. Bind the project

```text
python "$SKILL/scripts/mp" --root "$PROJECT" capabilities
python "$SKILL/scripts/mp" --root "$PROJECT" init
python "$SKILL/scripts/mp" --root "$PROJECT" status
python "$SKILL/scripts/mp" --root "$PROJECT" doctor
```

`capabilities` reports the interpreter, the Python version, the execution root identity, whether a `bwrap` binary exists, and the full list of supported actions. It writes nothing.

`init` creates the ledger, publishes the writer-environment owner atomically and configures local mode. Its response is the configuration receipt: `committed: true`, `schema: 4`, `mode: "local"`, `assurance: "self-asserted"`.

`status` then prints the owner record: `owner.project` is the project id `maintenance takeover` will ask for, `owner.epoch` is the writer fence, and `owner.state` should read READY. Write the project id down somewhere outside the ledger.

`doctor` compares the journal with the projection and lists unresolved barriers. It cannot inspect a database that does not exist yet, so it runs after `init`.

### 2. Store the principal's words, then record the authority

The principal's actual text is a file. Put it in CAS and keep the sha256.

```text
python "$SKILL/scripts/mp" --root "$PROJECT" --actor principal blob put ./intent.txt
```

Response: `{"ok":true,"blob":"<sha256>","bytes":123}`. Call that `$BLOB` below. Every `source_blob`, `rationale_blob` and `counterexample_blob` in this walkthrough is a sha256 of bytes already stored this way.

```json
{"request_id": "auth-1", "action": "authority.record",
 "data": {"id": "a", "source_blob": "$BLOB",
          "goals": ["usable-report"],
          "constraints": {"privacy": "private"},
          "constraint_scopes": {"privacy": "mission"}}}
```

Submitted with `--actor principal`. The response is `{"authority": {...}}` with `source_assurance: "self-asserted"` in local mode. `goals` is the goal inventory the candidate and the plan must match exactly. `constraints` are the reserved conditions no grant may override; `constraint_scopes` marks each one `mission` or `project`, and omitted entries are mission scope.

### 3. Delegate

```json
{"request_id": "grant-1", "action": "grant.record",
 "data": {"id": "g", "authority": "a", "source_blob": "$BLOB", "scope": "report",
          "domains": ["method"], "permissions": ["choose", "revise", "defer", "close"]}}
```

Also `--actor principal`. `scope` is a mission id or the literal `project`. The four permissions are `choose`, `revise`, `defer` and `close`; a PM missing `close` cannot close the mission, and a PM missing `defer` cannot defer or cancel an obligation. `expires` is optional and is checked at every use.

### 4. Open the intake and propose the root

```json
{"request_id": "intake-1", "action": "intake.create",
 "data": {"id": "i", "authority": "a", "mission": "report"}}
```

```json
{"request_id": "root-1", "action": "root.propose",
 "data": {"id": "c", "intake": "i", "source_blob": "$BLOB", "goals": ["usable-report"], "contracts": []}}
```

Both `--actor pm`. A candidate creates no contract and no mission. `templates/charter.md` holds the same request, so `mp seal charter.md` submits it with the whole Charter document as the `source_blob`.

### 5. Review the root

The Supervisor reads the principal's bytes, then reads the current contract scope:

```text
python "$SKILL/scripts/mp" --root "$PROJECT" --actor supervisor api --stdio <<'JSON'
{"action":"contracts.snapshot","data":{"mission":"report"}}
JSON
```

The response is `{"contract_scope_digest": "<digest>", "records": [...]}`. Read the source blobs the records name, then submit the judgement with that exact digest:

```json
{"request_id": "rootreview-1", "action": "root.review",
 "data": {"id": "rr", "candidate": "c", "outcome": "MATCH", "source_blob": "$REVIEW_DOC",
          "contract_scope_digest": "<digest from contracts.snapshot>"}}
```

Outcomes are MATCH, MISMATCH and INPUT_INCOMPLETE. MATCH refuses `GOAL_COVERAGE_GAP` when the candidate's goal set differs from the authority's. A missing or stale digest refuses `STALE_CONTRACT_REVIEW`. In local mode `mp seal supervisor-review.md` fills `contract_scope_digest` for you and marks the record `reading_assurance: "self-asserted"`, which is exactly what a local reading is.

### 6. Activate

```json
{"request_id": "activate-1", "action": "root.activate", "data": {"candidate": "c", "review": "rr"}}
```

`--actor pm`. One atomic transaction creates the root, compiles the principal's standing contracts from A0, and opens wave 1. It refuses `STALE_ROOT_REVIEW` if the candidate, the authority or the contract scope moved since the review. The response is `{"root": {"id":"report","status":"OPEN","version":1,...}}`.

### 7. Record the PM's own choice

```json
{"request_id": "decide-1", "action": "decision.record",
 "data": {"id": "d", "mission": "report", "grant": "g", "domain": "method",
          "choice": "plain text report", "effects": {"format": "plain text"},
          "rationale_blob": "$BLOB"}}
```

This is an A2 choice inside the delegation, not a principal requirement. Revising it later means a second `decision.record` with `"revises": "d"` and the `revise` permission. Adding `"tasks": ["t"]` limits the decision to those tasks; omitting `tasks` applies it to the whole domain from now on and leaves already accepted work alone.

### 8. Plan, task, environment, requirement

```json
{"request_id": "plan-1", "action": "plan.record",
 "data": {"id": "p", "mission": "report", "goals": ["usable-report"], "source_blob": "$BLOB",
          "obligations": [{"id": "o", "goal": "usable-report", "description": "actual usable report"}]}}
```

Every principal goal needs at least one obligation, and every obligation must trace to a goal, otherwise `GOAL_COVERAGE_GAP` or `INVENTED_OBLIGATION`.

```json
{"request_id": "task-1", "action": "task.record",
 "data": {"id": "t", "mission": "report", "obligations": ["o"], "grant": "g", "domain": "method",
          "effects": ["write-report"], "allowed_effects": ["write-report"],
          "inputs": ["$BLOB"], "source_blob": "$TASKSPEC",
          "write_paths": ["verify.py"], "outputs": ["report.txt"],
          "dependencies": [], "wave": 1}}
```

`write_paths` is what the Constructor may write; `outputs` is what a run may export as a delivery. Set `"recovers": true` when this task repairs a case, or `"touches_contract": true` when it changes something other tasks depend on; either makes task calibration mandatory. Updating an existing task id requires `"revises": "<current digest>"`.

```json
{"request_id": "env-1", "action": "environment.register",
 "data": {"id": "env", "executable": "/usr/bin/python3.12", "cwd": "$PROJECT"}}
```

`--actor principal`. Registering inspects the real interpreter and records its version and import origins. Add `expected_version` when the version matters; it refuses `ENVIRONMENT_MISMATCH` on a different one.

```json
{"request_id": "req-1", "action": "requirement.record",
 "data": {"id": "r", "task": "t", "argv": ["{python}", "verify.py"], "cwd": ".",
          "inputs": ["verify.py"], "environment": "env", "scope": "closing",
          "predicate": {"kind": "overall_pass"},
          "outputs": [{"path": "report.txt", "destination": "report.txt"}]}}
```

`--actor pm`. `scope: "closing"` marks this as the mission gate, which `mission.close` will require. Predicates are `overall_pass`, `expected_negative` with a specific nonzero `exit_code` and `diagnostic`, or `check_set` with exact `checks`. `outputs` maps a file the run writes into `MP_OUTPUT_DIR` onto a reviewed delivery path.

### 9. Review the plan and admit the task

The Supervisor calls `contracts.snapshot` again, then:

```json
{"request_id": "planreview-1", "action": "plan.review",
 "data": {"id": "pr1", "plan": "p", "tasks": ["t"], "outcome": "PASS",
          "source_blob": "$PLANREVIEW_DOC", "contract_scope_digest": "<digest>"}}
```

PASS checks the grant for every task, every applicable decision, that required effects are a subset of allowed effects (`INFEASIBLE_TASK`), that every declared input blob exists, and that every obligation in the plan has a producer (`MISSING_PRODUCER`). Template: `templates/plan-review.md`.

```json
{"request_id": "admit-1", "action": "task.admit", "data": {"id": "ad1", "task": "t", "review": "pr1"}}
```

`--actor pm`. The admission freezes the task digest, the authority digest, the dependency digest and the mission fence. Its id, `ad1`, is what every later build, run and report cites. Any change to the task, the authority or an accepted dependency refuses `STALE_ADMISSION` or `STALE_DEPENDENCY`, and the fix is a new `plan.review` plus a new `task.admit`.

Optional queueing: `task.dispatch` with `{"admission":"ad1"}` returns a fenced `ticket`, and `task.claim` with `{"ticket":"<id>"}` claims it. A single-task mission can go straight to `work.write`.

### 10. Build

Store the source, then write it into the reviewed path:

```text
python "$SKILL/scripts/mp" --root "$PROJECT" --actor constructor blob put ./verify.py.new
```

```json
{"request_id": "write-1", "action": "work.write",
 "data": {"task": "t", "admission": "ad1", "path": "verify.py", "source_blob": "$CODE"}}
```

For a file that already exists, add `"expected_sha256": "<current hash of verify.py>"`. A mismatch refuses `STALE_PRODUCT_HEAD` rather than overwriting somebody else's edit, and a path outside `write_paths` refuses `WRITE_SCOPE_CONFLICT`. The response is `{"write": {...,"install_effect":true}}`: the file on disk changes only after its event is durable.

### 11. Run the verification

```json
{"request_id": "run-1", "action": "run.execute", "data": {"requirement": "r", "admission": "ad1"}}
```

`--actor constructor`. The engine freezes the declared inputs into a staging tree, preflights the registered interpreter, executes argv with no shell interpolation, and exports the mapped outputs. The response carries the finished `run` object (`id`, `status`, `satisfied`, `exit_code`, `assurance`, `execution_kind`) and, when the requirement declares outputs, `export.deliveries`. Keep `run.id`: it is the `closing_run` at the end.

`status: "COMPLETE"` only says the process finished. `satisfied: true` says the requirement's predicate held, and that is what every positive gate reads. In local mode `assurance` is `local-execution`: inputs are frozen, logs and outputs are captured, and the process is **not** contained. It can read your home directory and reach the network. Managed runs record `controller-execution`; a hand-written finish records `posthoc-declared` and cannot satisfy a required run.

Add `"purpose": "independent_check"` and a concrete `"reason"` for a rerun that disputes an earlier result. That path has its own finite budget.

### 12. The three reports

Each is a Markdown document whose criteria table agrees with the structured `criteria`, sealed or submitted with the document as `source_blob`.

```text
| # | criterion | status | anchor | type |
|---|---|---|---|---|
| o | actual usable report | met | run:<run id> | R |
```

```json
{"request_id": "dev-1", "action": "report.record",
 "data": {"kind": "development", "task": "t", "outcome": "COMPLETE", "round": 1,
          "criteria": {"o": "met"}, "source_blob": "$DEVREPORT"}}
```

`--actor constructor`, template `templates/dev-report.md`. A COMPLETE, PASS or ACCEPTED report for a task with obligations refuses `CRITERIA_TABLE_REQUIRED` when the document has no criteria rows, and `CRITERIA_SOURCE_CONFLICT` when the structured map contradicts the table.

```json
{"request_id": "crit-1", "action": "report.record",
 "data": {"kind": "critique", "task": "t", "admission": "ad1", "outcome": "PASS", "round": 1,
          "criteria": {"o": "met"}, "source_blob": "$CRITIQUE"}}
```

`--actor crititor`, template `templates/critique.md`. The response's `report.id` is the critique id the acceptance must cite.

```json
{"request_id": "acc-1", "action": "report.record",
 "data": {"kind": "acceptance", "task": "t", "admission": "ad1", "critique": "<critique id>",
          "outcome": "ACCEPTED", "round": 1, "criteria": {"o": "met"}, "source_blob": "$ACCEPTANCE"}}
```

`--actor stabilizer`, template `templates/group-report.md`. It refuses `CURRENT_INDEPENDENT_PASS_REQUIRED` if the critique is stale, is not PASS, or was written by the same session. ACCEPTED sets every obligation of the task to MET with this report as its evidence.

### 13. Calibrate, when the task requires it

Required when the task carried `recovers` or `touches_contract` after a compaction, when the root has been revised, or at round 3. Build a task-scoped bundle first:

```json
{"request_id": "bundle-t", "action": "bundle.record", "data": {"mission": "report", "target": "t", "items": []}}
```

```json
{"request_id": "calib-1", "action": "calibration.record",
 "data": {"bundle": "<bundle id>", "task": "t", "wave": 1, "outcome": "ALIGNED", "source_blob": "$VERDICT"}}
```

`--actor calibrator` (or `stabilizer`), template `templates/calibration-verdict.md`. Outcomes are ALIGNED, SUSPICION, DRIFT and INPUT_INCOMPLETE. Omit `task` for the aggregate wave cell.

### 14. Close

```json
{"request_id": "bundle-close", "action": "bundle.record",
 "data": {"mission": "report", "target": "close", "items": []}}
```

`--actor pm`. The engine collects the authority, grants, candidate, task and decision sources, the run input manifests and logs, and every current delivery, and refuses `INPUT_INCOMPLETE` when a declared output has no snapshot. The response carries `bundle.id` and `bundle.status`, which must be `READY`. `items` lets you add extra blobs by `{"blob":...,"path":...}`.

```json
{"request_id": "audit-1", "action": "audit.record",
 "data": {"bundle": "<bundle id>", "outcome": "PASS", "findings": [], "source_blob": "$AUDIT"}}
```

`--actor auditor`, template `templates/closure-audit.md`. Outcomes are PASS, FINDINGS and INPUT_INCOMPLETE; PASS requires zero findings and FINDINGS at least one. Each finding is a complete mandatory report and becomes its own case with its own barrier.

```json
{"request_id": "closereview-1", "action": "close.review",
 "data": {"bundle": "<bundle id>", "outcome": "PASS", "source_blob": "$CLOSEREVIEW"}}
```

`--actor supervisor`, template `templates/close-review.md`. Outcomes are PASS, FAIL and INPUT_INCOMPLETE.

```json
{"request_id": "close-1", "action": "mission.close",
 "data": {"mission": "report", "bundle": "<bundle id>", "audit": "<audit id>",
          "review": "<close review id>", "closing_run": "<run id>",
          "grant": "g", "domain": "method", "source_blob": "$MISSIONCLOSE"}}
```

`--actor pm`, template `templates/mission-close.md`. The response is `{"mission":"report","status":"CLOSED","outcomes":[...]}`, and `outcomes` is the honest list: every obligation with its status, and for a deferred or cancelled one its owner and reason. The principal may submit this request directly instead, in which case `grant` and `domain` are not needed.

### 15. Confirm

```text
python "$SKILL/scripts/mp" --root "$PROJECT" --actor principal doctor
python "$SKILL/scripts/mp" --root "$PROJECT" --actor principal query root report
python "$SKILL/scripts/mp" --root "$PROJECT" --actor pm relay report
```

`query root report` shows `"status":"CLOSED"`. `relay <mission>` produces the complete immutable relay artifact without sending it anywhere; sending it to another person needs the principal's authorization. `render` publishes the derived view.

### What a refusal looks like in the middle of this

A mandatory counterexample filed against task `t` while it is queued makes the next `task.dispatch` refuse:

```json
{"ok": false, "code": "SCOPED_BARRIER",
 "detail": "An unresolved counterexample blocks this positive use",
 "case": "case-...", "phase": "PENDING_SCREEN"}
```

The fix is the case path, not a retry: `issue.screen` by the Supervisor with ESTABLISHED or DISMISSED, then either a `recovery.permit` and a repair, or `case.resolve`, or the independent `contest.decide` when an Auditor disagrees. Unrelated tasks keep running the whole time.

## Part 2 — upgrading a live 1.2 deployment mid-mission

A 1.2 ledger with an open mission does not have to redo its chain. The path below adopts the legacy scope, re-earns the authority in v4 terms, and accepts already delivered obligations from their verified legacy artifacts. Work on a copy first.

### 1. Inspect without changing anything

```text
python "$SKILL/scripts/mp" --root "$PROJECT" migrate --plan --source-root "$PROJECT"
```

Read-only. The plan reports `source_seq`, `journal_sha256`, the calibration `bridge`, the `missions` inventory with each mission's `status` (`open` or `closed`), the `contracts` compiled from the legacy journal, the `overlays` (one per sealed artifact, each `VERIFIED`, `LEGACY_UNHASHED`, `HASH_MISMATCH` or `UNAVAILABLE`), the `acceptances` recovered from sealed GroupReports, and `ready`. Only a `VERIFIED` overlay can become current evidence. Fix or accept the unavailable ones before you migrate.

### 2. Migrate

```text
python "$SKILL/scripts/mp" --root "$PROJECT" migrate --source-root "$PROJECT"
```

The original journal and documents are preserved, the legacy writer is frozen, the released dispatcher's replay semantics are imported, and the semantic overlays plus the calibration-release history are installed before the ledger publishes READY. Closed missions stay closed.

### 3. Adopt the open scope

```json
{"request_id": "adopt-1", "action": "legacy.adopt",
 "data": {"mission": "report", "legacy_mission": "Week07-Report", "source_blob": "$ADOPTION_NOTE"}}
```

`--actor pm`. `mission` is the v4 mission id you are about to activate and must equal the legacy mission's name. Omitting `artifacts` adopts every VERIFIED overlay of that legacy mission; naming `artifacts` adopts exactly those, and an unavailable one refuses `LEGACY_EVIDENCE_UNAVAILABLE`. Legacy latches come across as active latches. A closed legacy mission refuses `LEGACY_MISSION_CLOSED` unless the principal reopens it explicitly.

Adoption must precede activation: `root.activate` refuses `LEGACY_SCOPE_ADOPTION_REQUIRED` while an open legacy mission of the same name has no adopted scope.

### 4. Re-earn the authority, citing the Charter you already have

The migrated Charter is an overlay with its original bytes in CAS. Use that blob as the principal source, so the v4 authority quotes the same words the mission was actually run under:

```json
{"request_id": "auth-legacy", "action": "authority.record",
 "data": {"id": "a2", "source_blob": "<Charter overlay source_blob>",
          "goals": ["usable-report", "weekly-digest"],
          "constraints": {"privacy": "private"}}}
```

`--actor principal`. Find the blob in the plan's `overlays` entry for the Charter artifact, or with `query semantic_overlay <artifact id>`. Then the grant:

```json
{"request_id": "grant-legacy", "action": "grant.record",
 "data": {"id": "g2", "authority": "a2", "source_blob": "<Charter overlay source_blob>",
          "scope": "report", "domains": ["method"],
          "permissions": ["choose", "revise", "defer", "close"]}}
```

### 5. Intake, propose, review, activate

Exactly as in Part 1, steps 4 to 6: `intake.create` with `authority: "a2"`, `root.propose`, `contracts.snapshot` plus `root.review` with MATCH, then `root.activate`. The legacy standing contracts migrated as `legacy_project` scope contracts stay applicable and are visible in the contract snapshot; `root.review` refuses `AUTHORITY_CONFLICT` if the new authority contradicts one.

### 6. Plan the whole mission, including what is already delivered

```json
{"request_id": "plan-legacy", "action": "plan.record",
 "data": {"id": "p2", "mission": "report", "goals": ["usable-report", "weekly-digest"],
          "source_blob": "$PLAN_DOC",
          "obligations": [{"id": "o1", "goal": "usable-report", "description": "delivered in 1.2"},
                          {"id": "o2", "goal": "weekly-digest", "description": "remaining work"}]}}
```

Record obligations for the delivered work as well as the remaining work. The already delivered ones are settled in the next step, not by a new task.

### 7. Accept the delivered obligations from legacy evidence

```json
{"request_id": "legacyaccept-1", "action": "legacy.accept",
 "data": {"mission": "report", "obligation": "o1", "legacy_artifact": "<artifact id>"}}
```

`--actor pm`, template `templates/legacy-accept.md`. One request per delivered obligation. It requires the adopted scope, a VERIFIED overlay for that artifact, and a matching acceptance in the adoption plan. The obligation becomes MET with `evidence: "legacy:<artifact>"` and `assurance: "legacy-recorded"`, and `mission.close` accepts obligations settled this way. `bundle.record` includes the adopted overlay blobs, so the Auditor reads the real legacy bytes.

Legacy acceptance is history, honestly labelled. It does not claim a v4 controlled run happened, and it does not requalify an old PASS for new work.

### 8. Finish and close under v4

Record `task.record` rows for the remaining obligations, review the plan, admit, build, run, report and accept them exactly as in Part 1. Then one `bundle.record`, `audit.record`, `close.review` and `mission.close`. The closing run must be a v4 run with `scope: "closing"`; no legacy record substitutes for it.

## Part 3 — recovery commands

| Situation | Command | What it does |
|---|---|---|
| Bootstrap or handoff interrupted in the same owner environment | `mp --root "$PROJECT" maintenance recover` | Completes the interrupted publication and rewrites the owner record to the current writer identity, including the new writer-id token form |
| The owner environment is unreachable: a renamed machine, a cron or systemd launch, a lost token file | `mp --root "$PROJECT" --actor principal maintenance takeover --confirm <project id>` | Claims the ledger for this environment, increments the epoch and records `takeover_from`. Principal only, and the project id from `init` or `status` must match |
| Planned move between Windows and WSL | `maintenance handoff --target-environment <id>`, then `maintenance accept` on the destination | Explicit two-sided epoch transfer. Old sessions are fenced |
| Something looks wrong and you do not know what | `mp --root "$PROJECT" doctor` | Full replay comparison of journal, projection and effect receipts, plus semantic overlays and every barrier that is not RELEASED |
| The SQLite projection is missing or corrupt | `mp --root "$PROJECT" rebuild` | Derives the projection again from the journal without replacing an open handle. The journal is the authority, never the database |
| A fresh migration went wrong and no v4 business transition has happened yet | `mp --root "$PROJECT" rollback` | Restores the legacy ledger and preserves the retired v4 evidence. Refused after the first business event |

Two rules around all of these. The ledger has exactly one writer environment at a time, and Windows and WSL locks are not interoperable. And a real production ledger is diagnosed through isolated copies and read-only queries, never by editing SQLite, manifests or event files to make an old hash match.

The writer identity lives in `<config dir>/mission-pipeline/writer-id`: `$XDG_CONFIG_HOME` or `~/.config` on POSIX, `%APPDATA%` on Windows. Back it up with the ledger. Losing it is recoverable through `maintenance takeover`, but the takeover is a principal act and it is recorded.
