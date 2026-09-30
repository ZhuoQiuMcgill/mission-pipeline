# Runtime v4 request contract

The shared and full-workflow request surface of schema 4. Version 3.0.0 adds
[fast-mode](fast-mode.md) for routed receipts, Secretary coordination, Architect
readiness and execution acceptance. This document and `walkthrough.md` retain the
full exploration and historical v4 lifecycle, including shared recovery and closure.

## 1. Entry and identity

`scripts/mp` is the normal entry. It imports the adjacent `mp_runtime` package; a standalone copy of the script is unsupported. Use an explicit interpreter and an explicit `--root`.

```text
python <skill>/scripts/mp --root <project> --actor pm api --request-file request.json
python <skill>/scripts/mp --root <project> --actor pm api --stdio
python <skill>/scripts/mp --root <project> --actor supervisor seal document.md
```

Local actor labels are provenance, not authentication. Managed role identity is assigned by the trusted broker, and a role cannot submit an actor, a session or an authenticated flag.

`controller` is the executor's internal identity, not an operator role. The CLI, the field adapter and `bridge.serve_one` refuse actor role `controller` with `ROLE_FORBIDDEN` ("controller is the executor's internal identity"), including through `MP_ACTOR`. `runner.execute` and the managed broker still construct it in process, which is how a run is recorded.

## 2. Request envelope and receipts

Every mutation carries a stable `request_id`, an `action` and a `data` object. Reusing an id with different content is a conflict. Keep the same id after an uncertain response.

```json
{"request_id":"choice-001","action":"decision.record","data":{"mission":"m","grant":"g","domain":"method","choice":"Use a readable bar chart","effects":{"format":"bar-chart"},"rationale_blob":"<CAS SHA256>"}}
```

`receipt` retrieves a committed result. Do not infer success from attempted prose or from a REFUSED body. Arbitrary text belongs in JSON data, never in reconstructed shell source.

## 3. Authorities, grants and standing contracts

The trusted principal ingress accepts `authority.record` with `source_blob`, stable goal ids and reserved `constraints`. `constraint_scopes` keys a declared constraint to `mission` or `project`; omitted entries mean mission scope. `constraint_policies` may add per-clause `applicability` (`missions`, `exclude_missions`), a finite Unix `expiry` and `precedence:"principal"`.

`grant.record` links an authority to a scope (a mission id or `project`), `domains`, `permissions` from `choose`, `revise`, `defer` and `close`, an optional `expires` and optional reserved conditions. A grant cannot override a principal constraint or a standing contract.

`authority.amend` explicitly replaces the current principal source. `grant.revoke` immediately invalidates uses of that grant. `contract.retire` needs the contract's owning current authority and a new original `source_blob`; another mission's authority cannot retire it.

Standing contracts use one applicability interpretation everywhere: grant checks, root review and activation, plan review and admission, positive gates, scoped review bases, role packets and relay. A contract's `mission` is provenance; `project` and migrated `legacy_project` apply across missions. Native constraints combine conjunctively, and conflicting active conditions need a principal correction rather than the newest mission silently winning.

Before a local `root.review` or `plan.review`, call `contracts.snapshot` with `mission`, read the named contract and owning-authority sources, and submit the returned `contract_scope_digest`. A missing or stale digest refuses `STALE_CONTRACT_REVIEW`.

## 4. Intakes, candidates and activation

PM uses `intake.create`, then `root.propose` with goals and proposed contracts. A revision names the current candidate through `revises`; a new intake for an existing mission names `revises_intake`.

`root.review` (supervisor) submits MATCH, MISMATCH or INPUT_INCOMPLETE after reading the actual source bytes. MATCH refuses `GOAL_COVERAGE_GAP` when the goal inventories differ, and compiles the candidate against the principal's own scopes.

`root.activate` names that current candidate and review, plus `revises_root` for an active revision. Candidate review and activation are separate: no candidate creates an effective contract before activation. Activation is atomic, installs the principal's project constraints even if the candidate omitted them, and opens wave 1.

Every candidate occurrence is checked before deduplication: project cannot become mission-only, mission-only cannot become project, and reordered or repeated clauses cannot suppress the principal scope. A wrong draft receives MISMATCH and is corrected by PM under the existing authority, without a full root cycle.

## 5. Decisions

`decision.record` carries the grant, domain, actual `effects`, a `rationale_blob`, the `choice` and an optional predecessor through `revises`. A2 choices are revisable under the same valid grant; only a principal amendment changes A0.

`decision.record` may limit `tasks` to mission task ids of the decision's own `domain`. A decision never applies to a task of another domain, so naming one refuses `DECISION_DOMAIN_MISMATCH` with the `task`, its `task_domain` and the `decision_domain`; this also holds for the tasks a revision inherits. Record the choice in the task's domain, under a grant that covers it, or leave that task out. Omission means the decision applies to that domain going forward. It applies to a task only when the task has no ACCEPTED acceptance, current or superseded, created before the decision, so a blanket decision does not retro-invalidate finished work and the rule stays stable across later rounds. Revisions inherit the previous scope unless it is explicitly changed.

## 6. Plans, tasks and admission

`plan.record` carries every original goal and obligations as `{id, goal, description}`. Each obligation must trace to a goal and each goal needs a producing obligation. Recording a plan again restates that text only: an obligation already MET, AUTHORIZED_DEFERRED or AUTHORIZED_CANCELLED keeps its status and every field its disposition wrote (`evidence`, `assurance`, `grant`, `domain`, `deferred_owner`, `reason_blob`, `cancelled_by` and the `legacy.accept` fields).

`task.record` carries mission, obligations, grant, domain, required `effects`, `allowed_effects`, input CAS ids, exact `write_paths`, delivery `outputs`, `dependencies`, `wave` and an optional `required_runs`. Updating an existing id requires `revises` with the task's current digest. `recovers` and `touches_contract` are the two manual calibration triggers.

`task.replace` records a new task linked to its predecessor, retaining obligations and lineage budget.

A task row's stored `status` is its record status: `NOT_ADMITTED` from `task.record` until `task.replace` sets `REPLACED`. It is not the admission state. `query task [<id>]` returns the stored rows unchanged, so their digests still serve `revises`, plus a `derived` map keyed by task id: `admission` is ADMITTED when an admission names the task's current digest and the current authority, STALE when admissions exist but none does, otherwise NOT_ADMITTED, with `admission_id`; `acceptance` is ACCEPTED when the current acceptance report is ACCEPTED over the current digest, STALE when it is ACCEPTED over an older digest, otherwise NOT_ACCEPTED, with `acceptance_report`. These fields are computed at query time and never stored; every positive use still rechecks dependencies, holds, runs and product bytes.

`plan.review` (supervisor) checks the actual plan and tasks. `task.admit` produces the current admission, freezing the task digest, the authority digest, the dependency digest and the mission fence. Requirements must be registered before the review, because they change the task: `requirement.record` appends its id to the task's `required_runs`. When the task spec already lists that id, the id is not added a second time and the task row, with its digest, is unchanged; the requirement's own definition is immutable and enters the product digest of every report and the calibration basis. A changed plan, task, authority or accepted dependency needs re-admission.

The first wave exists at activation. `wave.open` for a successor requires the previous wave CLOSED and a completed aggregate calibration. `wave.integrate` rechecks every task's acceptance and required runs before closing a wave.

## 7. Environments and requirements

`environment.register` names the actual interpreter, an optional `expected_version`, modules and project modules, relevant non-secret values, and an optional Linux `runtime_root`.

`requirement.record` names task, argv array, cwd, explicit input path references, environment id, predicate, scope and output mappings. Predicates are `overall_pass`, `expected_negative` with a specific nonzero exit code and diagnostic, or `check_set` with exact required checks. A closing requirement has `scope: "closing"`.

`env create` can take `dependency_lock` and `wheelhouse` inside its declared cwd. It creates a fresh venv, bootstraps that venv's pip, installs only local wheels with `--require-hashes --no-index`, records the lock hash and verifies actual import origins. It never installs globally and never guesses a missing package.

## 8. Product writes

Constructor claims a current dispatch ticket, submits source as a blob, and uses `work.write` with task, admission, path, `source_blob` and `expected_sha256`. It writes only the reviewed exact paths and never pipeline state. A changed working-file head refuses `STALE_PRODUCT_HEAD` rather than overwriting another edit.

One `work.write` installs at most 8 MiB (8,388,608 bytes). A larger `source_blob` refuses `INVALID_INPUT`, and the refusal carries `limit`, the file's `size` and its `path`. Split such a file, or have a controlled run produce it as a declared output.

Product file changes and exported output installations are journaled effects. No file changes before its event is durable. A completion receipt is persisted after installation and before projection commit. Recovery accepts the intended bytes or applies them against the recorded previous hash, and refuses to overwrite an intervening edit (`RECOVERY_PRODUCT_CONFLICT`).

## 9. Execution

`run.execute` freezes the declared inputs, checks the actual interpreter and import origins, and executes argv with no shell interpolation. The working input tree is read-only and `MP_OUTPUT_DIR` identifies writable output. Output mappings `{path, destination}` preserve declared artifacts to reviewed delivery paths and CAS. Missing or changed outputs do not qualify.

Completion is not satisfaction. `status: "COMPLETE"` plus `satisfied: true` is what positive gates read, and `satisfied` comes from the requirement's predicate. A normal completed nonzero exit is COMPLETE with its predicate evaluated, so an expected negative can still qualify.

### Execution assurance labels

| Label | Means |
|---|---|
| `controller-execution` | The managed controller executed it inside the allowlisted sandbox |
| `local-execution` | The local executor froze the declared inputs, checked the interpreter and captured logs and outputs. The process was **not** contained: it had the home directory and the network |
| `posthoc-declared` | A finish recorded without the executor. Historical evidence only; refuses `EXECUTION_ASSURANCE_REQUIRED` at a required gate |

Ledgers written by 2.0 carry `local-controlled-execution` for the middle row. Every check that accepts the new label accepts the old one.

### Leases, takeover and abort

Local and managed runs use the same leases, finite takeover, heartbeat, total deadline, logs and success predicates. Same-key ordinary takeover is bounded to generation two; `purpose: "independent_check"` with a concrete `reason` has its own two-call lineage budget, and recovery after a non-qualified verification has another.

`run.abort` by the owning session is unchanged. A dead run left RUNNING by a crashed session can be aborted from any session by pm or controller once `lease_until` has passed: the run becomes `EXPIRED` with `satisfied:false` and `failure_code:"RUN_LEASE_EXPIRED"`.

After a real process timeout the controller stores TIMED_OUT; startup and supported execution errors store EXECUTION_FAILED with the exact available stdout and stderr in CAS, a failure code and a detail. These are non-qualified terminal records: repeating the same request returns the original failure without launching another process. Late owner or generation results stay historical and cannot satisfy a gate.

### Deliveries

`run.export` installs a run's declared outputs to the reviewed delivery paths. `delivery.record` is the constructor's path for a file that is not run output; it refuses `EXPORTED_OUTPUT` when the current delivery for that path was produced by a run. A hand-recorded file never replaces controlled output.

## 10. Reports

`report.record` takes `kind` of development, critique or acceptance, plus task, `source_blob`, outcome, round, criteria and an explicit `revises` for a predecessor.

A report for a task that has obligations, with outcome COMPLETE, PASS or ACCEPTED, refuses `CRITERIA_TABLE_REQUIRED` when the document contains no criteria rows. The Markdown table must agree with the structured criteria (`CRITERIA_SOURCE_CONFLICT`), and every written row must map to an obligation (`CRITERIA_MAPPING_GAP`). Use stable obligation ids, or explicit sub-ids with a complete `criteria_map`.

Positive critique and acceptance require the admission, current controlled verification, all required outcomes met and the current development report. Acceptance also cites the current independent PASS critique, written by a different session. Failure and partial reports remain recordable.

Three product rounds per lineage. A same-round correction with unchanged source, criteria, outcome and product is a `report_annotation` (`annotation_blob`) that preserves the qualified head; a substantive change needs the next bounded round (`SUBSTANTIVE_REVISION_REQUIRES_ROUND`). Task replacement carries the product lineage and cannot reset its budget.

Noticed-but-not-fixed items become live flags at record time; relay items become relay records. `flag.raise` is limited to pm and the reporting roles and requires the mission to have a root or an intake. `flag.change` performs retire, replace, reopen and dispose as separate recorded operations, and a FIXED disposition must cite current accepted product evidence.

## 11. Obligations and their disposition

An obligation is REQUIRED, then MET by an ACCEPTED report, or disposed explicitly.

`obligation.defer` (pm, `defer` permission or principal) names the grant, domain, owner and `reason_blob`, and sets AUTHORIZED_DEFERRED. `obligation.cancel` takes the same fields and sets AUTHORIZED_CANCELLED with `cancelled_by`. Both are disclosed gaps with a responsible owner, never verified-fixed, and both are returned in the close outcomes.

`mission.close` rechecks each disposition's grant with the `defer` permission. A 2.1.0 plan re-record stripped `grant` and `domain` from disposed obligations; such a row refuses `DEFERRAL_INCOMPLETE` at close, naming the obligation, and is repaired by submitting the same `obligation.defer` or `obligation.cancel` again.

`consume` and `wave.integrate` recheck current acceptance, source, verification, authority and holds.

## 12. Counterexamples, cases and barriers

`issue.report` distinguishes ADVISORY from MANDATORY_COUNTEREXAMPLE. A mandatory report needs mission, `source_blob`, `counterexample_blob`, a `target` that resolves to exactly one object (name `target_kind` if ambiguous), and either affected `tasks` and `obligations` or a resolvable `authority_span` quote.

One receipt creates the case, the scoped PENDING_SCREEN barrier, the fence and the screening job, in the same transaction. Duplicate facts reuse their case. Ordinary suggestions and unrelated tasks are never globally frozen.

Barrier phases that block a positive use are PENDING_SCREEN, ESTABLISHED_HOLD, CONTEST_PENDING, SCREENING_UNAVAILABLE and UNRESOLVED_LIMIT. A blocked positive use refuses `SCOPED_BARRIER` with the case id and the phase.

## 13. Screening, permits and resolution

`issue.screen` (supervisor) submits ESTABLISHED or DISMISSED. Dismissing a case an Auditor raised opens a Contest instead of resolving it.

`recovery.permit` (pm) authorizes at most two repairs per case inside the existing grant, for a bounded time. Normal consumption and closing stay blocked. A repair task can run and receive independent product acceptance under that hold. A permit cannot waive a different hold and cannot authorize closing.

`case.resolve` (supervisor) ends the case with DISMISSED, VERIFIED_FIXED or AUTHORIZED_EXCEPTION.

- It refuses `CONTEST_PENDING` while a contest is PENDING or INPUT_INCOMPLETE. A Supervisor cannot pre-empt an independent decision.
- It refuses `SCREENING_REQUIRED` for DISMISSED on a case with no `screening_author`. An unscreened case cannot be dismissed.
- VERIFIED_FIXED names actual repair tasks or a corrected pre-active candidate, and must address the original counterexample.
- AUTHORIZED_EXCEPTION needs a real scoped defer grant.

## 14. Contest

`case.contest` is open to pm and to every reporting role: constructor, crititor, stabilizer, auditor, calibrator, challenger, architect, researcher and supervisor. Any case that is not `TARGET_REPLACED` and not already `independent_final` can be contested, including one still waiting to be screened or one that hit `UNRESOLVED_LIMIT`; a replaced case refuses `CASE_NOT_CONTESTABLE`, a final one `CONTEST_FINAL`. One contest per case; a second request returns the existing contest as `reused`.

A mandatory Auditor's substantive disagreement with a dismissal, a claimed repair or an exception creates that contest automatically; PM need not volunteer it and cannot suppress it.

`contest.decide` belongs to a fresh independent Stabilizer endpoint, and the result applies directly with no second Supervisor signature.

| Outcome | Effect |
|---|---|
| `DISMISS_ORIGINAL` | The accusation was false. Releases a latch this case created |
| `REPAIR_VERIFIED` | The original issue was true and the current repair eliminated it. Preserves the established history |
| `AUTHORIZED_EXCEPTION_VERIFIED` | A real scoped defer authority covers the gap |
| `UPHOLD` | The issue stands. The job becomes AWAIT_REPAIR with a repair window of at least one day |
| `MODIFY_SCOPE` | Narrows a false overbroad hold. It can never expand the reported scope |
| `INPUT_INCOMPLETE` | Buys one requested `case.supplement`, not a fresh merits contest |

A Supervisor cannot overwrite an independent final result (`CONTEST_FINAL`). `audit.agree` binds the agreement to the same evidence dependencies, so an old agreement cannot authorize a later changed repair.

## 15. Jobs, deadlines and resume

`project.configure` stores `review_deadline_seconds`: 86400 in local mode, 300 in managed mode, or an explicit integer of at least 60. Every screening, contest, supplement, resume and repair-compliance deadline uses it. The UPHOLD repair window is `max(86400, value)`.

`job.resume` (controller or pm) also accepts a PENDING or AWAIT_REPAIR job whose deadline has passed, with no prior `jobs.expire`. It keeps the two-resume cap, replaces the endpoint generation and retains the independent reviewer lineage. When the cap is spent it reports `REVIEW_EXPIRED` with a `recovery` text.

`issue.screen` and `contest.decide` on an expired job auto-resume inside the same transaction when a resume remains: generation plus one, `auto_resumed: true`. With no resume left they refuse `REVIEW_EXPIRED`. `jobs.expire` remains for controllers.

Transport failures have one bounded retry; successful phase transitions do not consume it. Two reconstructed controllers cannot occupy the same job, and stale-generation retirement or failure messages are refused.

## 16. Review readings, rebase and successor cases

`issue.screen`, `case.resolve`, `contest.decide`, `audit.agree`, `latch.release` and `review.rebase` each require a `review_basis`.

In local mode, call `review.snapshot` with `{"case":"<id>"}` or `{"latch":"<id>"}`, read the referenced source blobs, and retain the returned basis in the later submission. Local identity and read claims remain self-asserted. Managed packets contain `review_bases`, and the broker retains only a basis actually delivered and actually read.

The basis covers the original case, the current target, the current applicable authority and grants including expiry, task evidence, scoped barriers and latches, and the job generation. An unrelated journal event does not invalidate the reading. A stale refusal commits no release and no budget charge.

When the target or the authority changes, reread the new packet and submit `review.rebase` for the same case, then refresh and read its updated packet before judging. The case's original `fact` and `target_digest` stay intact; `review_rebases` records the reader and the old and new bases.

At most two changed-head rebases are durable per case. On the third, the engine does not deadlock. It closes the current case with `status:"TARGET_REPLACED"`, releases its barrier, deactivates its permits, marks any pending contest SUPERSEDED and completes that job. It then creates a successor case with the same mission, lineage, scope, target, target_kind, source blob, counterexample blob, audit flag and audit stance, a new `target_digest` and `fact`, `supersedes` pointing at the old case, the repair count carried over, `status:"REPORTED_PENDING_SCREEN"`, a PENDING_SCREEN barrier, a fresh screening job and `review_head` at the current basis head. The response is `{"case": <new case>, "superseded": "<old id>"}`.

## 17. Budgets

| Budget | Cap | Key |
|---|---|---|
| Product rounds | 3 | task lineage |
| Case repairs | 2 | case |
| Merits contests | 1 | case |
| Requested supplements | 1 | case |
| Corrective review calls | 12 | `<case id>:correction`, charged by `issue.screen` and `contest.decide` |
| Durable review rebases | 2 | case, then a successor case |
| Job resumes | 2 | job |
| Run takeover generations | 2 | requirement key |
| Independent reruns | 2 | task lineage |

The correction budget is per case, so an unrelated later case starts fresh. A mission-level `<lineage>:correction_total` counter is kept for reporting only and has no cap.

`rule.record` requires an established case, an applicability statement and counterexamples; rules are explicitly retired when invalid.

## 18. Required verification and reuse

Required verification selects the latest attempt for that requirement, including incomplete and unsuccessful states, before evaluating its predicate. Ordinary reuse considers only this current attempt: it cannot skip a timeout or a pending attempt to borrow an earlier PASS. A live attempt returns pending.

Unrelated and non-required diagnostics are excluded from required qualification and from calibration dependencies. New reports cannot promote an unfinished or failed required attempt into PASS or ACCEPTED. Once the actual current attempt succeeds, normal current reports and any required calibration restore consumption and closure.

## 19. Calibration

`bundle.record` collects the original authority, grants, actual delivery documents, data and images, task and decision sources, controlled run inputs and logs, and exported outputs. Required declared delivery paths cannot be omitted. Missing CAS yields `INPUT_INCOMPLETE`. Bundles include the actual frozen input files, not only a manifest hash.

A declared output is required once its task could have produced it: the task has an admission of its current digest, or any recorded run. Without a current delivery for that path the bundle refuses `INPUT_INCOMPLETE` with the `path` and the `task`. A task with neither, such as a later wave's task not yet admitted, has produced nothing, so its outputs do not block a bundle for earlier work; it is still unfinished work that `wave.integrate` and `mission.close` refuse. An admission is not part of a bundle's delivery digest, so `calibration.record` (every outcome except INPUT_INCOMPLETE) and `mission.close` recheck the same rule against a task admitted after the bundle was recorded.

`calibration.record` uses the current bundle at an explicit wave or task scope. Outcomes are ALIGNED, SUSPICION, DRIFT and INPUT_INCOMPLETE. Task cells never interrupt the aggregate wave sequence. DRIFT, and a second consecutive aggregate SUSPICION, create a mandatory case and a latch together.

The calibration basis for a task is the current TaskSpec, the applicable PM decisions, authority and contracts, the declared source inputs, the actual output bytes, the required run and environment records, the current deliveries and the current development and critique reports.

The product file set in that basis is the task's `outputs`, plus the task's `write_paths`, plus the required runs' declared inputs, deduplicated and order-stable. A helper listed only in `write_paths` is therefore covered: rewriting it invalidates the cell and the acceptance that rests on it.

Acceptance and obligation accounting, consumption records, annotations and unrelated task decisions are deliberately excluded from the basis, so successful acceptance does not invalidate itself. A new run, or a different product with an unchanged TaskSpec, cannot borrow the old ALIGNED cell.

`latch.release` belongs to the principal, or to the Stabilizer whose contest ended DISMISS_ORIGINAL on that latch's case. A later ordinary ALIGNED never erases a true latch.

## 20. Closure

Build a current bundle, obtain `audit.record` and `close.review`, then submit `mission.close` with a qualified `closing_run` and a delegated close grant, or as the principal.

`audit.record.outcome` is PASS, FINDINGS or INPUT_INCOMPLETE. PASS requires zero findings and FINDINGS at least one; the outcome is derived when absent. `close.review.outcome` is PASS, FAIL or INPUT_INCOMPLETE.

`mission.close` requires the audit outcome to be PASS or FINDINGS, the close review to be PASS over the same current bundle, every obligation met or explicitly disposed, every task accepted or wholly excepted, no live OPEN flag, no applicable barrier or latch, and a COMPLETE satisfied run whose requirement has `scope: "closing"` with its inputs still current.

No unresolved mandatory case can disappear between auditing and closing: every positive transaction rechecks the scoped barriers. Authorized gaps remain disclosed in the returned `outcomes`. `mission.reopen` is an explicit principal action.

`relay <mission>` produces an immutable complete relay artifact without sending it. `render` creates the derived current view; rendering happens outside the lock and publication rechecks epoch and sequence inside it. A successful business commit with a stale or unwritable view returns `committed: true, view_stale: true`, never a fake rollback.

## 21. Seal

`mp seal <document>` reads a Markdown document, finds its ```mp-json``` block, stores the whole document in CAS and submits the request. The default `request_id` is `seal-<sha256 of the document>`.

In local mode seal is also a convenience layer. It:

- sets `source_blob` only when the block does not already name one, and always records `document_blob`;
- validates list sections only for `report.record`, so an unrelated section no longer refuses the whole document;
- fills `contract_scope_digest` for a root or plan review when the field is absent;
- fills `review_basis` for the six review actions when the field is absent;
- fills `admission` with the task's latest admission, `critique` with the task's current PASS critique for an acceptance, and `revises` with the current report of the same kind;
- marks `reading_assurance: "self-asserted"` when it filled a review field;
- returns the request it actually submitted as `submitted_request` beside the engine result.

Managed seal behaviour is unchanged: the broker's packet supplies those fields and the read receipt, and nothing is refreshed silently at commit.

## 22. Writer identity and ownership

`environment_id()` is `sha256(platform family, token)[:24]`, where the token is read from `<config dir>/mission-pipeline/writer-id` and created with random hex on first use. The config directory is `$XDG_CONFIG_HOME` or `~/.config` on POSIX and `%APPDATA%` on Windows. A hostname change, a WSL distribution rename, or a cron or systemd launch no longer changes the identity.

`legacy_environment_id()` keeps the old hostname-based formula, and `owner()` accepts either, so existing ledgers keep working. `maintenance recover` rewrites the owner record to the new id.

`maintenance takeover --confirm <project id>` requires `--actor principal` and claims a ledger whose owner environment is unreachable: a new environment, epoch plus one, and `takeover_from` recorded. The project id must match the ledger's own.

A ledger has one writer environment. `maintenance handoff --target-environment <id>` followed by `maintenance accept` on the destination is the planned move; every handoff increments the epoch and fences old sessions.

## 23. Per-write cost

`recover()` verifies only the journal tail past a watermark: `verified_seq` plus a byte offset held in `runtime_meta`. The full replay comparison stays in `doctor` and `rebuild`, which is where you want it.

`source_manifest` uses identity_version 3. Tracked files with unchanged checkout bytes take their Git blob id from `git ls-files -s -z`. Files reported changed by `git status`, and files whose index and working-tree line endings differ according to `git ls-files --eol -z`, are hashed with sha256. A CRLF-converted checkout therefore remains visible even when Git reports it clean; unchanged files avoid a full hash on every run.

## 24. Migration and legacy continuity

`migrate --plan` inspects a legacy ledger without changing it and reports `source_seq`, `journal_sha256`, the calibration `bridge`, the `missions` inventory, the compiled `contracts`, the per-artifact `overlays` with status VERIFIED, LEGACY_UNHASHED, HASH_MISMATCH or UNAVAILABLE, and `acceptances`: every ACCEPTED verdict recovered from a sealed GroupReport, with its legacy mission, task key, artifact, sha256 and sequence.

`migrate` preserves the original journal and documents, freezes the legacy writer, imports the released dispatcher's replay semantics, and installs the semantic overlays and the calibration-release history before publishing READY. Migration retains the frozen adoption event in CAS before publishing its bootstrap owner, so an interruption cannot publish READY without the legacy overlays and the release bridge.

`legacy.adopt` (pm or principal) names the v4 `mission`, the `legacy_mission` and a `source_blob`. Omitting `artifacts` adopts every VERIFIED overlay of that legacy mission. A closed legacy mission stays closed without an explicit principal reopening. `root.activate` refuses `LEGACY_SCOPE_ADOPTION_REQUIRED` while an open legacy scope of the same name is unadopted.

`legacy.accept` (pm) takes `{mission, obligation, legacy_artifact}`. It requires the adopted scope, a VERIFIED overlay and a matching acceptance from the adoption plan, and sets the obligation MET with `evidence: "legacy:<artifact>"` and `assurance: "legacy-recorded"`. `mission.close` accepts obligations settled this way, and `bundle.record` includes the adopted overlay blobs so the Auditor reads the real bytes.

Active legacy text keeps its exact original event bytes and its `legacy-recorded` assurance. Migration never invents structured clause values and never upgrades an old attestation into managed principal authentication. `rollback` is available only before the first v4 business transition, and preserves the retired v4 evidence.

## 25. Managed transport (experimental)

Managed mode is implemented and tested, but **no model driver ships in this repository**. Treat it as experimental until a trusted transport exists for your deployment.

The trusted controller launches an argv-configured process with private pipes and sends `{"packet": ...}`. The driver replies with `{"tool_calls":[...]}` or `{"final_document":"..."}`. Tools are `read_blob`, `read_blobs`, `submit_blob`, `submit` and `refresh_packet`; each read returns original bytes as base64 and counts toward the same 128-tool budget. `read_blobs` accepts up to 64 references inside the eight MiB frame bound.

The broker enforces packet scope, role actions, path scope, epoch, actual required reads and finite tool, step and deadline budgets. It supplies input-read receipts and identity; model-authored identity fields authenticate nothing. One `managed run` is one packet, at most 32 steps and 300 seconds.

`mp_runtime.reference_driver` is an executable framing example, not a production driver. A production driver may call an external model API, but must not give that model parallel unrestricted host tools. `parallel_host_tools: false` in the driver configuration documents the host contract; the operator has to actually remove the other tools.

After UPHOLD or MODIFY_SCOPE the job is AWAIT_REPAIR. A normal driver final response clears its durable occupancy without spending a failure retry. After a PM recovery permit, actual repair execution and current independent acceptance, a fresh controller invokes `managed run --job <case>:contest --repair-file <json> --driver-config <config>` with `{"repair_tasks":["<task>"]}` or a current independently matched pre-active `candidate`. No Supervisor signature is needed, and the compliance decision rechecks the assigned repair and the current evidence before releasing the hold.

## 26. Registered canonical execution

The principal console accepts `canonical.register` with `id`, `kind` (`command` or `compose`), absolute `executor_argv`, `executor_files` and `expected_version`; `version_args` defaults to `["--version"]`. Executor scripts are installed outside the writable product tree and pinned by bytes. A command profile fixes `command` argv elements where whole elements `{work}` and `{out}` name frozen inputs and output staging; a compose profile fixes `compose_file`, `service` and `required_inputs`. Roles cannot register executors or change profile arguments.

A requirement selects that environment with `argv:["{canonical}"]` and includes its fixed inputs. The run records `execution_kind: "canonical_profile_execution"`. The external executor is a trusted host component and is not a bubblewrap process.

Compose configuration parsing itself runs inside the Linux/WSL allowlist sandbox before resolved effects are checked. No host home, credential file or Docker socket is visible to that parser. Resolved builds and mounts must use frozen inputs; host namespaces, privileges, devices, external secret or config mounts and sockets are rejected. Missing Docker, image or runtime capability is an explicit failure that never falls back to the local Python executor.

## 27. Paths, Windows and the WSL bridge

`PathRef` supports `root_id`, `relative_segments`, `origin_platform` and optional display metadata. The root id binds the resolved execution directory, the device and inode, and the Git common-directory identity. A PathRef for another root is refused before input or output access. String paths remain an explicit-root compatibility form.

Git identity reads disable fsmonitor, hooks and clean or process filters from every configuration layer, discard ambient `GIT_*` routing and retain binary path parsing. Normal checkout settings such as `core.autocrlf` remain effective.

On Windows, `mp bridge wsl` resolves its target with the distribution's `wslpath`, probes the Linux root and ledger project, and persistently registers both filesystem identities plus the distribution, interpreter and entry. The default registration is `.claude/mission-pipeline/bridge-mappings`; `--mapping-file` selects a separate controller-owned registration. Wrong or stale bindings return `ROOT_MAPPING_MISMATCH`. This registration is configuration, not a bearer credential.

**After upgrading the skill, re-register the bridge mappings before the first cross-platform request.** A mapping file written by an older release is not assumed compatible, and a silent retarget of an old file is exactly the failure the identity recheck exists to prevent.

All Engine-based entries resolve the same `mp.json` ledger binding. Use a root-relative ledger path for a shared Windows/WSL project; an absolute path from the other platform is refused rather than reinterpreted.

Win32 extended paths are retained for file I/O and percent-encoded as complete pathnames in read-only SQLite URIs. A long local cwd receives a private short NTFS junction created with Win32 APIs, and cleanup removes only the generated junction. Network cwd aliases are not guessed: use a declared local execution root or the WSL bridge.

## 28. Field adapter

The supported adapter is `python -m mp_runtime.field_adapter --root ... --request-file ...` with the script package on PYTHONPATH, or imported by a trusted host. Its read-only SQL helper allows reads only, never DDL, migration or writes.

The adapter submits `review.snapshot` and `contracts.snapshot` through the same `--request-file`, retains the returned basis or digest, reads the blobs through the original-byte CAS interface, then supplies them in the later request. `invoke` passes the request to the same Engine and writer, and never manufactures a current reading. A local adapter actor cannot become an authenticated reviewer; a managed ledger needs the trusted console or role protocol.

## 29. Failure and recovery taxonomy

Deterministic source, authority, scope and predicate refusals are corrected, not retried with new ids. `BUSY_RETRYABLE` has at most two retries. `COMMIT_DURABLE_RECOVERY_REQUIRED` means the journal already committed: recover the same receipt. Old generations and stale packets cannot finish current work.

Storage corruption, a missing projection and manifest recovery are distinct from semantic partial rows and from legitimate workflow holds. `doctor`, `rebuild`, `maintenance recover`, `maintenance takeover`, explicit owner `handoff` and `accept`, scoped legacy adoption and before-business `rollback` are the supported recovery paths.

Bootstrap publishes a complete nonempty owner directory atomically and READY last. A recovery manifest is preserved so a missing manifest does not cause an existing journal to be overwritten as a fresh ledger. The frozen schema-3 dispatcher preserves historical semantics, and new overlays never rewrite the old journal or silently upgrade old PASS decisions.

Malformed, duplicate-key, nonfinite, truncated and oversized JSON frames are refused. Pipe writes as well as reads have a deadline, so a transport that stops reading cannot hang the controller.
